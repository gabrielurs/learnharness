import { execFile, spawn } from "node:child_process";
import { CODE_LIMITS, outputsMatch, type CodeLanguage, type CodeRunCase, type CodeRunRequest, type CodeRunResult } from "../core/contracts/code.ts";

/**
 * The Docker code-execution backend (fork, 2026-10-26 — audit R1–R5). The
 * learner's C/C++ compiles AND runs inside a throwaway container, so it
 * cannot read the host's files or the server's process environment (which
 * the macOS sandbox-exec path could not prevent: sysctl is filtered by
 * name, KERN_PROCARGS2 is read by MIB number, and the sanitizer runtime
 * needs sysctl). The container is network-less, memory- and pid-capped,
 * read-only except a tmpfs scratch, runs as an unprivileged uid, and drops
 * every capability. Sanitizers work natively on Linux, so none are lost.
 *
 * code-runner.ts falls back to the macOS sandbox when Docker is unavailable.
 */

/** Pinned by digest (silkeh/clang:19, Debian clang 19.1.7 — glibc, so the
 *  sanitizer runtimes behave). A tag alone could drift under us. */
/** The pinned sandbox base image (silkeh/clang:19, glibc). Shared so the
 *  clangd sandbox derives from the same digest. */
export const SANDBOX_IMAGE = "silkeh/clang@sha256:f5ce959d91f059acf5a4b3f1c19f46713c4b2881c7d7cd1d5143ca1d1412277f";
const IMAGE = SANDBOX_IMAGE;

const MEMORY_LIMIT = "512m";
const PIDS_LIMIT = "64";
const CPUS = "1";
/** The container is torn down past this whole-submission wall clock. */
const CONTAINER_WALL_MS = CODE_LIMITS.compileTimeoutMs + CODE_LIMITS.maxTests * (CODE_LIMITS.runTimeoutMs + 2_000) + 10_000;

const COMPILE: Record<CodeLanguage, { bin: string; file: string; std: string }> = {
	c: { bin: "clang", file: "main.c", std: "-std=c17" },
	cpp: { bin: "clang++", file: "main.cpp", std: "-std=c++20" },
};
const COMMON_FLAGS = ["-Wall", "-Wextra", "-g", "-O1", "-fno-omit-frame-pointer", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined"];
const SANITIZERS = ["address", "undefined"];

interface Exec {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	truncated: boolean;
	ms: number;
}

/** Run a host command (docker …) with stdin, a wall timeout and an output
 *  cap; never rejects — a spawn error is reported in the result. */
function run(cmd: string, args: string[], opts: { stdin?: string; timeoutMs: number }): Promise<Exec> {
	return new Promise((resolve) => {
		const t0 = performance.now();
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let truncated = false;
		let timedOut = false;
		let done = false;
		const cap = (cur: string, chunk: string) => {
			const room = CODE_LIMITS.maxOutputBytes - cur.length;
			if (chunk.length <= room) return cur + chunk;
			truncated = true;
			try {
				child.kill("SIGKILL");
			} catch {}
			return cur + chunk.slice(0, Math.max(0, room));
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout = cap(stdout, c)));
		child.stderr.on("data", (c: string) => (stderr = cap(stderr, c)));
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {}
		}, opts.timeoutMs);
		const settle = (exitCode: number | null, signal: string | null, err?: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ stdout, stderr: stderr + (err ?? ""), exitCode, signal, timedOut, truncated, ms: Math.round(performance.now() - t0) });
		};
		child.on("error", (e) => settle(null, null, String(e.message)));
		child.on("close", (code, signal) => settle(code, signal));
		child.stdin.on("error", () => {});
		child.stdin.end(opts.stdin ?? "");
	});
}

let availability: Promise<boolean> | undefined;
let probedAt = 0;
/** Re-probe the daemon at most this often: the learner may quit Docker
 *  Desktop mid-session (battery), or start it after boot (audit, 2026-10-26). */
const AVAILABILITY_TTL_MS = 20_000;

/** Is a usable Docker daemon reachable? Cached with a short TTL. */
export function dockerAvailable(): Promise<boolean> {
	const now = Date.now();
	if (!availability || now - probedAt > AVAILABILITY_TTL_MS) {
		probedAt = now;
		availability = run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5_000 }).then(
			(r) => r.exitCode === 0 && !r.timedOut && r.stdout.trim().length > 0,
			() => false,
		);
	}
	return availability;
}

/** Forget the cached answer so the next call re-probes (after a daemon
 *  error surfaced mid-run). */
export function resetDockerAvailability(): void {
	availability = undefined;
	probedAt = 0;
}

/** The daemon became unreachable (quit mid-session), or the image is
 *  absent — both mean: fall back to the local sandbox. */
export class DockerImageMissingError extends Error {}

/** Docker's OWN stderr says the daemon is unreachable. Only used on output
 *  that comes from docker itself (run, image inspect/pull) — NEVER on a
 *  `docker exec` whose stderr is the compiler's or the program's, which the
 *  learner controls (a Linux-only `#error connection refused` must not force
 *  a downgrade to the host sandbox — audit, 2026-10-26). */
function daemonGone(stderr: string): boolean {
	return /cannot connect to the docker daemon|failed to connect to the docker|the daemon is running|is the docker daemon running|error during connect|connect: no such file|connection refused/i.test(stderr);
}

/** A FRESH daemon reachability probe (bypasses the TTL cache), to tell a
 *  real `docker exec` infrastructure failure from a compile/run result. */
async function daemonReachable(): Promise<boolean> {
	const r = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 5_000 });
	return r.exitCode === 0 && !r.timedOut && r.stdout.trim().length > 0;
}

/** A `docker exec` failed at the DOCKER level (not the inner command): exit
 *  125 (daemon/exec error) or no exit code, AND the daemon is now
 *  unreachable. The inner compiler/program uses its own exit codes (clang
 *  errors are 1), which this never treats as a docker failure. */
async function execHitDockerFailure(exitCode: number | null): Promise<boolean> {
	if (exitCode !== 125 && exitCode !== 126 && exitCode !== null) return false;
	return !(await daemonReachable());
}

/** Ensure the pinned image is present (pull once). Throws if it cannot be
 *  obtained, so the caller can fall back or report. */
async function ensureImage(): Promise<void> {
	const present = await run("docker", ["image", "inspect", IMAGE], { timeoutMs: 10_000 });
	if (present.exitCode === 0) return;
	if (daemonGone(present.stderr)) {
		resetDockerAvailability();
		throw new DockerImageMissingError("the Docker daemon is not reachable");
	}
	const pulled = await run("docker", ["pull", "--quiet", IMAGE], { timeoutMs: 300_000 });
	if (pulled.exitCode !== 0) {
		if (daemonGone(pulled.stderr)) resetDockerAvailability();
		throw new DockerImageMissingError(`could not pull the code-runner image: ${pulled.stderr.trim().slice(0, 300)}`);
	}
}

/** The container isolation flags, shared so every sandbox (runner, clangd)
 *  is confined identically. Readonly — one source of truth. */
export const SANDBOX_RUN_FLAGS: readonly string[] = [
	"--network", "none",
	"--memory", MEMORY_LIMIT,
	"--memory-swap", MEMORY_LIMIT,
	"--pids-limit", PIDS_LIMIT,
	"--cpus", CPUS,
	"--cap-drop", "ALL",
	"--security-opt", "no-new-privileges",
	"--read-only",
	"--tmpfs", "/work:exec,size=128m,mode=1777",
	"-e", "TMPDIR=/work",
	"-e", "ASAN_OPTIONS=detect_leaks=0:abort_on_error=0:color=never",
	"-e", "UBSAN_OPTIONS=print_stacktrace=0:color=never",
	"-w", "/work",
	"-u", "65534:65534",
];
const DOCKER_RUN_FLAGS = SANDBOX_RUN_FLAGS;

/** Compile and run `request` inside a container. */
export async function runCodeInDocker(request: CodeRunRequest): Promise<CodeRunResult> {
	await ensureImage();
	const { file, std } = COMPILE[request.language];
	let containerId: string | undefined;
	try {
		const started = await run(
			"docker",
			["run", "-d", "--rm", ...DOCKER_RUN_FLAGS, "--entrypoint", "sleep", IMAGE, String(Math.ceil(CONTAINER_WALL_MS / 1000))],
			{ timeoutMs: 30_000 },
		);
		if (started.exitCode !== 0 || !started.stdout.trim()) {
			if (daemonGone(started.stderr)) resetDockerAvailability();
			throw new DockerImageMissingError(`could not start the code-runner container: ${started.stderr.trim().slice(0, 300)}`);
		}
		containerId = started.stdout.trim();

		// The source goes IN over stdin, never a bind mount (fork, 2026-10-26):
		// a host bind mount's uid can't be traversed by the container's nobody
		// on real Linux, and piping keeps nothing of the host in the container.
		const written = await run("docker", ["exec", "-i", containerId, "sh", "-c", `cat > /work/${file}`], { stdin: request.source, timeoutMs: 15_000 });
		if (written.exitCode !== 0 && (await execHitDockerFailure(written.exitCode))) {
			resetDockerAvailability();
			throw new DockerImageMissingError("the Docker daemon became unreachable while writing the source");
		}

		const compiled = await run(
			"docker",
			["exec", containerId, COMPILE[request.language].bin, std, ...COMMON_FLAGS, "-o", "/work/main", `/work/${file}`],
			{ timeoutMs: CODE_LIMITS.compileTimeoutMs + 5_000 },
		);
		// The daemon vanished between start and exec (quit mid-run): fall back.
		// Decided by docker's exit code + a fresh probe, NEVER the compiler's
		// stderr (the learner controls it via #error).
		if (compiled.exitCode !== 0 && (await execHitDockerFailure(compiled.exitCode))) {
			resetDockerAvailability();
			throw new DockerImageMissingError("the Docker daemon became unreachable during compile");
		}
		const compileOk = compiled.exitCode === 0 && !compiled.timedOut;
		const compile = {
			ok: compileOk,
			output: (compiled.stderr + compiled.stdout).trim() || (compiled.timedOut ? "compilation timed out" : ""),
			ms: compiled.ms,
			sanitizers: SANITIZERS,
		};
		if (!compileOk) return { compile, cases: [] };

		const inputs = request.tests ?? [{ stdin: request.stdin ?? "", expected: undefined as string | undefined }];
		const cases: CodeRunCase[] = [];
		for (const test of inputs) {
			const sec = Math.ceil(CODE_LIMITS.runTimeoutMs / 1000);
			const r = await run(
				"docker",
				["exec", "-i", containerId, "timeout", "-s", "KILL", String(sec), "/work/main"],
				{ stdin: test.stdin, timeoutMs: CODE_LIMITS.runTimeoutMs + 2_000 },
			);
			// The daemon died mid-loop: fall back (runCode re-runs the whole
			// submission locally). Decided by exit code + a fresh probe, so a
			// program that merely returns 125/126 is not mistaken for it.
			if (r.exitCode !== 0 && (await execHitDockerFailure(r.exitCode))) {
				resetDockerAvailability();
				throw new DockerImageMissingError("the Docker daemon became unreachable during a test");
			}
			// `timeout` exits 137 (128+SIGKILL) when it kills the program.
			const timedOut = r.timedOut || r.exitCode === 137;
			const graded = test.expected !== undefined;
			cases.push({
				stdin: test.stdin,
				stdout: r.stdout,
				stderr: r.stderr,
				exitCode: r.exitCode,
				...(r.signal && !timedOut ? { signal: r.signal } : {}),
				timedOut,
				truncated: r.truncated,
				ms: r.ms,
				...(graded
					? { expected: test.expected, passed: !timedOut && !r.truncated && r.exitCode === 0 && outputsMatch(r.stdout, test.expected!) }
					: {}),
				...("hidden" in test && test.hidden ? { hidden: true } : {}),
			});
		}
		return { compile, cases };
	} finally {
		if (containerId) void execFile("docker", ["rm", "-f", containerId], () => {});
	}
}
