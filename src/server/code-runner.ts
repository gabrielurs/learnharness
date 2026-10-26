import { execFile, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dockerAvailable, runCodeInDocker, DockerImageMissingError } from "./docker-runner.ts";
import path from "node:path";
import {
	CODE_LIMITS,
	outputsMatch,
	type CodeLanguage,
	type CodeRunCase,
	type CodeRunRequest,
	type CodeRunResult,
} from "../core/contracts/code.ts";

/**
 * The local code runner (fork, 2026-10-24): compiles the LEARNER's C/C++
 * with their own clang and runs it once per test case. Owner calls: local
 * execution, sanitizers on (AddressSanitizer + UBSan — a learner's memory
 * bug becomes a clear report instead of silent corruption).
 *
 * Only learner code runs; tests are data (contracts/code.ts). Each run is
 * boxed by: a fresh temp dir (also its cwd), a wall-clock timeout that
 * kills the whole process group, an output cap, and a minimal env — and on
 * macOS an OS sandbox plus a memory watchdog (runSandboxed, fork,
 * 2026-10-25).
 */

/**
 * The macOS sandbox for a learner binary (sandbox-exec; deprecated but
 * shipped and working on macOS 26). Denied: fork/exec of anything but the
 * binary itself (no fork bombs, no escaped children), writes outside the
 * run dir, every network operation, and reads under the learner's home.
 * Allowed: reading the system (dyld, the sanitizer runtime), the console
 * logger UBSan reports through, and signalling itself (abort()).
 */
const SANDBOX_PROFILE = [
	"(version 1)",
	"(deny default)",
	'(allow process-exec (literal (param "BIN")))',
	"(allow file-read*)",
	'(deny file-read* (subpath (param "HOME")))',
	'(allow file-write* (subpath (param "DIR")) (literal "/dev/null"))',
	"(allow sysctl-read)",
	'(allow mach-lookup (global-name "com.apple.system.logger"))',
	"(allow signal (target self))",
].join("");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Resident memory past this kills the run (macOS ignores RLIMIT_AS). */
const RUN_MEMORY_LIMIT_MB = 512;
const MEMORY_POLL_MS = 100;

function sandboxAvailable(): boolean {
	if (process.platform !== "darwin") return false;
	try {
		accessSync(SANDBOX_EXEC, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The command that runs a learner binary: sandboxed on macOS (the sandbox
 *  applies, then exec — same pid, so the group kill still holds); as-is
 *  elsewhere. */
function learnerCommand(bin: string, dir: string): { cmd: string; args: string[]; memoryLimitMb?: number } {
	if (!sandboxAvailable()) return { cmd: bin, args: [] };
	// The profile matches REAL paths: the temp dir lives under /var, a
	// symlink to /private/var.
	const real = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return p;
		}
	};
	const [realBin, realDir, home] = [real(bin), real(dir), real(process.env.HOME ?? "/Users")];
	return {
		cmd: SANDBOX_EXEC,
		args: ["-p", SANDBOX_PROFILE, "-D", `DIR=${realDir}`, "-D", `BIN=${realBin}`, "-D", `HOME=${home}`, realBin],
		memoryLimitMb: RUN_MEMORY_LIMIT_MB,
	};
}

const COMPILERS: Record<CodeLanguage, { bin: string; file: string; flags: string[] }> = {
	c: { bin: "clang", file: "main.c", flags: ["-std=c17"] },
	cpp: { bin: "clang++", file: "main.cpp", flags: ["-std=c++20"] },
};
const COMMON_FLAGS = ["-Wall", "-Wextra", "-g", "-O1", "-fno-omit-frame-pointer", "-fno-sanitize-recover=undefined"];

/**
 * Which sanitizers this machine can run. UBSan always (it includes array
 * bounds checks). AddressSanitizer only when a probe binary actually
 * starts: on macOS 26 with Apple clang 17 the ASan runtime HANGS in its
 * shadow-memory init (dyld shared-cache walk) before main — every run
 * would time out. Probed once per process; a toolchain update that fixes
 * it re-enables ASan on the next server start.
 */
let sanitizerProbe: Promise<string[]> | undefined;
function sanitizers(compiler: string, env: Record<string, string>): Promise<string[]> {
	sanitizerProbe ??= (async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "learnharness-asan-probe-"));
		try {
			writeFileSync(path.join(dir, "probe.c"), "int main(void){return 0;}\n");
			const built = await exec(compiler, ["-fsanitize=address", "-o", "probe", "probe.c"], { cwd: dir, stdin: "", timeoutMs: CODE_LIMITS.compileTimeoutMs, env });
			if (built.exitCode !== 0) return ["undefined"];
			const probe = learnerCommand(path.join(dir, "probe"), dir);
			const ran = await exec(probe.cmd, probe.args, { cwd: dir, stdin: "", timeoutMs: 3_000, env, memoryLimitMb: probe.memoryLimitMb });
			return ran.exitCode === 0 && !ran.timedOut ? ["address", "undefined"] : ["undefined"];
		} finally {
			killStragglers(dir);
			removeRunDir(dir);
		}
	})();
	return sanitizerProbe;
}

const SEARCH_DIRS = ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"];

/** The compiler binary, or undefined when the toolchain is missing. */
export function findCompiler(language: CodeLanguage): string | undefined {
	const { bin } = COMPILERS[language];
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...SEARCH_DIRS];
	for (const dir of dirs) {
		const candidate = path.join(dir, bin);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

/** A minimal env: enough for the toolchain and the sanitizers, nothing
 *  of the app's (no API keys reach learner code). */
function sandboxEnv(dir: string): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
		HOME: dir,
		TMPDIR: dir,
		LANG: "en_US.UTF-8",
		ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0:color=never",
		UBSAN_OPTIONS: "print_stacktrace=1:color=never",
		...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
	};
}

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	truncated: boolean;
	ms: number;
}

/** After the main process exits, how long its pipes may still drain. A
 *  descendant that escaped the group (setsid) and holds stdout open would
 *  otherwise keep `close` — and the run slot — waiting forever. */
const DRAIN_GRACE_MS = 200;

/** Run one process with stdin, a timeout and an output cap. The whole
 *  process group is killed when the main process exits too (fork, 2026-10-25
 *  audit): a fork()ed child used to outlive the run. */
function exec(
	bin: string,
	args: string[],
	opts: { cwd: string; stdin: string; timeoutMs: number; env: Record<string, string>; memoryLimitMb?: number },
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const t0 = performance.now();
		const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
		let stdout = "";
		let stderr = "";
		let truncated = false;
		let timedOut = false;
		let done = false;
		let exited: { code: number | null; signal: string | null } | null = null;
		let memoryKilled = false;
		const killGroup = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const take = (current: string, chunk: string): string => {
			const room = CODE_LIMITS.maxOutputBytes - current.length;
			if (chunk.length <= room) return current + chunk;
			truncated = true;
			killGroup();
			return current + chunk.slice(0, Math.max(0, room));
		};
		const finish = (result: Omit<ExecResult, "stdout" | "stderr" | "truncated" | "timedOut" | "ms"> & { error?: string }) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			clearInterval(memoryWatch);
			if (memoryKilled) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}Killed: memory limit exceeded (${opts.memoryLimitMb} MB)\n`;
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({ stdout, stderr: stderr + (result.error ?? ""), exitCode: result.exitCode, signal: result.signal, timedOut, truncated, ms: Math.round(performance.now() - t0) });
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout = take(stdout, c)));
		child.stderr.on("data", (c: string) => (stderr = take(stderr, c)));
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, opts.timeoutMs);
		// Memory watchdog: poll the process's resident size (KB from ps).
		// Async (execFile), one probe in flight: the server's event loop never
		// blocks on it.
		let polling = false;
		const memoryWatch = setInterval(() => {
			if (!opts.memoryLimitMb || !child.pid || exited || polling) return;
			polling = true;
			execFile("ps", ["-o", "rss=", "-p", String(child.pid)], (_err, out) => {
				polling = false;
				if (!done && !exited && Number(String(out).trim()) > opts.memoryLimitMb! * 1024) {
					memoryKilled = true;
					killGroup();
				}
			});
		}, MEMORY_POLL_MS);
		child.on("error", (err) => finish({ exitCode: null, signal: null, error: String(err.message) }));
		child.on("exit", (code, signal) => {
			exited = { code, signal };
			killGroup();
			setTimeout(() => finish({ exitCode: code, signal }), DRAIN_GRACE_MS);
		});
		child.on("close", (code, signal) => finish(exited ? { exitCode: exited.code, signal: exited.signal } : { exitCode: code, signal }));
		child.stdin.on("error", () => {});
		child.stdin.end(opts.stdin);
	});
}

/** Kill what escaped the process group (setsid): every process still running
 *  a binary from this run's dir — the path carries its random temp name.
 *  Known gap: a setsid() child that then exec()s ANOTHER binary no longer
 *  matches; closing that needs an OS sandbox (sandbox-exec / job limits). */
function killStragglers(dir: string): void {
	const escaped = (dir + path.sep).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	spawnSync("pkill", ["-KILL", "-f", `^${escaped}`], { stdio: "ignore" });
}

/** Remove a run's temp dir even when the program made parts of it
 *  unreadable (chmod 0); a failure is logged, never the run's result. */
function removeRunDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		try {
			spawnSync("chmod", ["-R", "u+rwx", dir], { stdio: "ignore" });
			rmSync(dir, { recursive: true, force: true });
		} catch (err) {
			console.warn(`[code-runner] could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// Compiles are CPU-heavy (sanitizers): at most two at a time.
let running = 0;
const queue: Array<() => void> = [];
async function withSlot<T>(run: () => Promise<T>): Promise<T> {
	if (running >= 2) await new Promise<void>((r) => queue.push(r));
	running++;
	try {
		return await run();
	} finally {
		running--;
		queue.shift()?.();
	}
}

export class CompilerMissingError extends Error {}

/** Compile `request.source` and run it on each test (or once on stdin).
 *  Docker when a daemon is reachable (full host isolation — audit R1–R5,
 *  2026-10-26); the macOS sandbox otherwise. */
export function runCode(request: CodeRunRequest): Promise<CodeRunResult> {
	return withSlot(async () => {
		if (await dockerAvailable()) {
			try {
				return await runCodeInDocker(request);
			} catch (err) {
				// A reachable daemon that still can't run (no image offline,
				// start failure) → fall back to the local sandbox rather than
				// failing the learner's submission.
				if (!(err instanceof DockerImageMissingError)) throw err;
				console.warn(`[code-runner] Docker unavailable, using the local sandbox: ${err.message}`);
			}
		}
		return runCodeLocal(request);
	});
}

/** The macOS sandbox-exec backend (fallback when Docker is not usable). */
/** Exported for the fallback-path tests; runCode routes here when Docker
 *  is unavailable. */
export function runCodeLocal(request: CodeRunRequest): Promise<CodeRunResult> {
	return (async () => {
		const compiler = findCompiler(request.language);
		if (!compiler) {
			throw new CompilerMissingError(
				`${COMPILERS[request.language].bin} not found — install the Xcode Command Line Tools (xcode-select --install)`,
			);
		}
		const dir = mkdtempSync(path.join(tmpdir(), "learnharness-code-"));
		try {
			const { file, flags } = COMPILERS[request.language];
			writeFileSync(path.join(dir, file), request.source);
			const env = sandboxEnv(dir);
			const active = await sanitizers(compiler, env);
			const compiled = await exec(compiler, [...flags, ...COMMON_FLAGS, `-fsanitize=${active.join(",")}`, "-o", "main", file], {
				cwd: dir,
				stdin: "",
				timeoutMs: CODE_LIMITS.compileTimeoutMs,
				env,
			});
			const compileOk = compiled.exitCode === 0 && !compiled.timedOut;
			const compile = {
				ok: compileOk,
				output: (compiled.stderr + compiled.stdout).trim() || (compiled.timedOut ? "compilation timed out" : ""),
				ms: compiled.ms,
				sanitizers: active,
			};
			if (!compileOk) return { compile, cases: [] };

			const inputs = request.tests ?? [{ stdin: request.stdin ?? "", expected: undefined as string | undefined }];
			const cases: CodeRunCase[] = [];
			for (const test of inputs) {
				const learner = learnerCommand(path.join(dir, "main"), dir);
				const run = await exec(learner.cmd, learner.args, { cwd: dir, stdin: test.stdin, timeoutMs: CODE_LIMITS.runTimeoutMs, env, memoryLimitMb: learner.memoryLimitMb });
				const graded = test.expected !== undefined;
				cases.push({
					stdin: test.stdin,
					stdout: run.stdout,
					stderr: run.stderr,
					exitCode: run.exitCode,
					...(run.signal && !run.timedOut ? { signal: run.signal } : {}),
					timedOut: run.timedOut,
					truncated: run.truncated,
					ms: run.ms,
					...(graded
						? {
								expected: test.expected,
								passed: !run.timedOut && !run.truncated && run.exitCode === 0 && outputsMatch(run.stdout, test.expected!),
							}
						: {}),
					...("hidden" in test && test.hidden ? { hidden: true } : {}),
				});
			}
			return { compile, cases };
		} finally {
			killStragglers(dir);
			removeRunDir(dir);
		}
	})();
}
