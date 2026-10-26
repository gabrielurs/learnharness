/**
 * clangd behind the code editor (owner, 2026-10-25): IDE completions and
 * as-you-type diagnostics for the C/C++ exercises. One clangd process,
 * spawned on the first request and shut down after CLANGD_IDLE_MS without
 * one (battery: nothing runs while no editor asks). Documents live in
 * clangd's memory only — didOpen/didChange with the editor's full text —
 * under a scratch workspace whose compile_flags.txt mirror the runner's
 * flags, so the editor and Run agree on what compiles.
 *
 * clangd runs INSIDE Docker (owner, 2026-10-26): the code runner's image
 * plus clangd-19, under the runner's isolation flags (no network, no host
 * mount, read-only, nobody). The editor text reaches it over stdio only, so
 * an `#include "/host/path"` finds nothing of the host. Without Docker the
 * editor has no assistance (owner: no host clangd fallback); the image is
 * built locally on first use, and nothing is suggested while it builds.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
	offsetToPosition,
	positionToOffset,
	type CodeAssistRequest,
	type CodeCompletion,
	type CodeCompletionResult,
	type CodeDiagnostic,
	type CodeDiagnosticsResult,
	type CodeLanguage,
} from "../core/contracts/code.ts";
import { dockerAvailable, SANDBOX_IMAGE, SANDBOX_RUN_FLAGS } from "./docker-runner.ts";

/** Shut clangd down after this long without a request. */
export const CLANGD_IDLE_MS = 5 * 60_000;
/** How long a request waits for clangd (first parse of the headers included). */
const READY_TIMEOUT_MS = 6_000;
const REQUEST_TIMEOUT_MS = 4_000;
/** Empty completions on a just-opened document retry this often. */
const FRESH_RETRIES = 10;
const FRESH_RETRY_MS = 60;
const FRESH_WINDOW_MS = 5_000;
/** Open documents kept in clangd (oldest closed beyond this). */
const MAX_DOCS = 20;
/** This many requests in a row unanswered in time = clangd is stuck: it
 *  is restarted, and the editor pauses (owner, 2026-10-26). */
const STUCK_AFTER = 3;

const FLAGS: Record<CodeLanguage, string[]> = {
	c: ["-xc", "-std=c17", "-Wall", "-Wextra"],
	cpp: ["-xc++", "-std=c++20", "-Wall", "-Wextra"],
};
const EXT: Record<CodeLanguage, string> = { c: "c", cpp: "cpp" };

/** The workspace inside the container (the runner's tmpfs). */
const ROOT = "/work";
const CLANGD_ARGS = ["--log=error", "--background-index=false", "--header-insertion=never", "--completion-style=detailed", "--limit-results=100", "-j=2"];
/** The workspace's .clangd — the only config clangd can find in the
 *  container. Linux clangd 19 flags unused/missing #includes by default;
 *  a learner's `#include <stdio.h>` is not a mistake (and the host clangd
 *  before it never said so). */
const CLANGD_CONFIG = ["Diagnostics:", "  UnusedIncludes: None", "  MissingIncludes: None"];

/** The runner's pinned image plus clangd (Debian's clangd-19 matches its
 *  clang 19). Built locally from stdin — no build context, nothing of the
 *  host goes in. The tag follows the recipe, so a change rebuilds. */
export const CLANGD_DOCKERFILE = `FROM ${SANDBOX_IMAGE}
RUN apt-get update \\
	&& apt-get install -y --no-install-recommends clangd-19 \\
	&& rm -rf /var/lib/apt/lists/*
`;
export const CLANGD_IMAGE = `learnharness-clangd:${createHash("sha256").update(CLANGD_DOCKERFILE).digest("hex").slice(0, 12)}`;
/** Mark our containers with the owning server's pid and start time, so a
 *  restart can sweep the orphans of a dead one (and only those): a reused
 *  pid belongs to a process with a later start. */
const CONTAINER_LABEL = "learnharness.clangd.pid";
const STARTED_LABEL = "learnharness.clangd.started";
/** A failed image build is retried after this long, not per keystroke. */
const IMAGE_RETRY_MS = 10 * 60_000;
const IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;

/** What a session spawns: the docker run (production) or a test fake. */
export interface ClangdLaunch {
	command: string;
	args: string[];
	/** The container to `docker rm -f` when the session dies. */
	container?: string;
	/** Tests: a shorter wait per request than REQUEST_TIMEOUT_MS. */
	requestTimeoutMs?: number;
}

/** A docker CLI call; never rejects. */
function docker(args: string[], opts: { stdin?: string; timeoutMs: number }): Promise<{ ok: boolean; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "ignore"] });
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout += c));
		const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
		const settle = (ok: boolean) => {
			clearTimeout(timer);
			resolve({ ok, stdout });
		};
		child.on("error", () => settle(false));
		child.on("close", (code) => settle(code === 0));
		child.stdin.on("error", () => {});
		child.stdin.end(opts.stdin ?? "");
	});
}

/** Is the clangd image present? Absent → start ONE background build and
 *  answer false until it lands (a failed build waits IMAGE_RETRY_MS). */
async function imageReady(): Promise<boolean> {
	const s = slot();
	const image = (s.image ??= { status: "unknown", at: 0 });
	if (image.status === "ready") return true;
	if (image.status === "building") return false;
	if (image.status === "failed" && Date.now() - image.at < IMAGE_RETRY_MS) return false;
	image.check ??= docker(["image", "inspect", CLANGD_IMAGE], { timeoutMs: 10_000 }).then((r) => r.ok);
	const present = await image.check;
	image.check = undefined;
	if (image.status !== "unknown" && image.status !== "failed") return image.status === "ready";
	if (present) {
		image.status = "ready";
		return true;
	}
	image.status = "building";
	image.at = Date.now();
	void docker(["build", "--quiet", "-t", CLANGD_IMAGE, "-"], { stdin: CLANGD_DOCKERFILE, timeoutMs: IMAGE_BUILD_TIMEOUT_MS }).then((r) => {
		image.status = r.ok ? "ready" : "failed";
		image.at = Date.now();
		if (!r.ok) console.warn("[clangd] could not build the clangd image; editor assistance is off for now");
	});
	return false;
}

/** Remove containers left by a server that died without stopping its
 *  clangd (a dev restart). Once per server process. */
async function sweepOrphans(): Promise<void> {
	const s = slot();
	if (s.swept) return;
	s.swept = true;
	const format = `{{.ID}}\t{{.Label "${CONTAINER_LABEL}"}}\t{{.Label "${STARTED_LABEL}"}}`;
	const listed = await docker(["ps", "-a", "--filter", `label=${CONTAINER_LABEL}`, "--format", format], { timeoutMs: 10_000 });
	const rows = listed.stdout
		.split("\n")
		.map((line) => line.split("\t"))
		.filter(([id]) => id?.trim())
		.map(([id, pid, started]) => ({ id: id!.trim(), pid: Number(pid), started: started?.trim() ?? "" }));
	const starts = await processStarts(rows.map((r) => r.pid).filter((pid) => Number.isInteger(pid) && pid > 0));
	// No process list (ps failed): every container would look dead,
	// another live server's too — sweep nothing this time.
	if (!starts) return;
	// Labeled with a start time: alive only if that pid still has it. An
	// older container (pid label only) falls back to the pid check.
	const orphans = rows.filter((r) => (r.started ? starts.get(r.pid) !== r.started : !pidAlive(r.pid))).map((r) => r.id);
	if (orphans.length > 0) await docker(["rm", "-f", ...orphans], { timeoutMs: 20_000 });
}

/** Start times of live processes, as ps prints them (C locale); a pid
 *  missing from the map is not running. Null when ps itself failed. */
function processStarts(pids: number[]): Promise<Map<number, string> | null> {
	return new Promise((resolve) => {
		const starts = new Map<number, string>();
		if (pids.length === 0) return resolve(starts);
		// Every process, filtered here: `ps -p` fails whole on one
		// out-of-range pid (a label is data, not a trusted pid).
		const wanted = new Set(pids);
		execFile("ps", ["-A", "-o", "pid=,lstart="], { env: { ...process.env, LC_ALL: "C" }, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
			if (err) return resolve(null);
			for (const line of String(stdout ?? "").split("\n")) {
				const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
				if (m && wanted.has(Number(m[1]))) starts.set(Number(m[1]), m[2]!);
			}
			resolve(starts);
		});
	});
}

/** This server's own start time (its containers' STARTED_LABEL). */
let ownStart: Promise<string> | null = null;
function serverStart(): Promise<string> {
	return (ownStart ??= processStarts([process.pid]).then((m) => m?.get(process.pid) ?? ""));
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The docker run behind a session, or null while Docker (or the image)
 *  is not there — the editor then simply has no assistance. */
async function dockerLaunch(): Promise<ClangdLaunch | null> {
	if (!(await dockerAvailable())) return null;
	if (!(await imageReady())) return null;
	await sweepOrphans();
	const started = await serverStart();
	const container = `learnharness-clangd-${process.pid}-${Date.now().toString(36)}`;
	// compile_flags.txt per language and the .clangd, written inside the
	// container's tmpfs (all constants — nothing from a request).
	const setup = [
		...(["c", "cpp"] as const).map((l) => `mkdir -p ${ROOT}/${l} && printf '%s\\n' ${FLAGS[l].join(" ")} > ${ROOT}/${l}/compile_flags.txt`),
		`printf '%s\\n' ${CLANGD_CONFIG.map((line) => `'${line}'`).join(" ")} > ${ROOT}/.clangd`,
	].join(" && ");
	return {
		command: "docker",
		args: [
			"run", "-i", "--rm", "--pull", "never",
			"--name", container,
			"--label", `${CONTAINER_LABEL}=${process.pid}`,
			"--label", `${STARTED_LABEL}=${started}`,
			...SANDBOX_RUN_FLAGS,
			"-e", `HOME=${ROOT}`,
			"--entrypoint", "sh",
			CLANGD_IMAGE,
			"-c", `${setup} && exec clangd-19 ${CLANGD_ARGS.join(" ")}`,
		],
		container,
	};
}

/** Tests: run sessions from this launch instead of Docker (a fake clangd). */
let launchOverride: (() => ClangdLaunch) | null = null;
export function setClangdLaunchForTests(launch: (() => ClangdLaunch) | null): void {
	launchOverride = launch;
}

/** Tests: is assistance usable here (Docker up, image built)? Waits for
 *  a build this call starts. */
export async function clangdUsable(): Promise<boolean> {
	if (!(await dockerAvailable())) return false;
	if (await imageReady()) return true;
	const deadline = Date.now() + IMAGE_BUILD_TIMEOUT_MS;
	while (slot().image?.status === "building" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
	return slot().image?.status === "ready";
}

interface OpenDoc {
	uri: string;
	version: number;
	/** The last synced text — an unchanged text is never re-sent (clangd
	 *  would not republish its diagnostics for it). */
	text: string;
	openedAt: number;
	/** Resolves on the document's first diagnostics — the headers are parsed. */
	ready: Promise<void>;
	markReady: () => void;
	diagnostics: { version: number; items: LspDiagnostic[] } | null;
	waiters: Array<{ version: number; resolve: () => void }>;
}

interface LspDiagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	severity?: number;
	message: string;
}

interface LspCompletionItem {
	label: string;
	detail?: string;
	kind?: number;
	insertText?: string;
	insertTextFormat?: number;
	filterText?: string;
	textEdit?: { range: LspDiagnostic["range"]; newText: string };
}

class ClangdTimeout extends Error {}

class ClangdSession {
	private proc: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private docs = new Map<string, OpenDoc>();
	private readonly container: string | undefined;
	readonly initialized: Promise<void>;
	readonly startedAt = Date.now();
	dead = false;
	/** A deliberate shutdown (idle, tests) — never counted as a crash. */
	private stopping = false;
	private readonly requestTimeoutMs: number;
	/** Requests in a row clangd did not answer in time, per kind: one
	 *  that still completes but stopped publishing diagnostics is stuck too. */
	private late = { complete: 0, diagnose: 0 };

	constructor(launch: ClangdLaunch) {
		this.container = launch.container;
		this.requestTimeoutMs = launch.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
		// The docker CLI itself needs the user's env (its context, socket);
		// the container gets none of it — only SANDBOX_RUN_FLAGS' own -e.
		this.proc = spawn(launch.command, launch.args, { stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.proc.stderr.on("data", () => {});
		// A write racing clangd's death fails with EPIPE on stdin — unhandled,
		// that error event would take the whole server down with it.
		this.proc.stdin.on("error", (err) => this.die(err));
		this.proc.on("exit", () => this.die(new Error("clangd exited")));
		this.proc.on("error", (err) => this.die(err));
		this.initialized = this.request("initialize", {
			processId: process.pid,
			rootUri: `file://${ROOT}`,
			capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } }, publishDiagnostics: { versionSupport: true } } },
		}, REQUEST_TIMEOUT_MS).then(() => this.notify("initialized", {}));
	}

	private die(err: Error) {
		if (this.dead) return;
		this.dead = true;
		// Died right after starting (a broken binary): hold off respawning,
		// or every keystroke would spawn a fresh failure.
		if (!this.stopping && Date.now() - this.startedAt < CRASH_WINDOW_MS) {
			slot().backoffUntil = Date.now() + CRASH_BACKOFF_MS;
			// Maybe the image went away (a prune): look again next time.
			if (slot().image?.status === "ready") slot().image = undefined;
		}
		for (const { reject } of this.pending.values()) reject(err);
		this.pending.clear();
		for (const doc of this.docs.values()) {
			doc.markReady();
			for (const w of doc.waiters) w.resolve();
		}
		// Declared dead while the process may still run (a broken pipe, a
		// spawn error): kill it — a dead session must never leave a live
		// clangd behind.
		if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL");
		// Killing the docker CLI does not stop its container: remove it.
		if (this.container) void docker(["rm", "-f", this.container], { timeoutMs: 20_000 });
	}

	private onData(chunk: Buffer) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
			if (!match) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			if (this.buffer.length < headerEnd + 4 + length) return;
			const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
			this.buffer = this.buffer.subarray(headerEnd + 4 + length);
			let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
			try {
				message = JSON.parse(body);
			} catch {
				continue;
			}
			if (message.id !== undefined && !message.method) {
				const waiter = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.error) waiter?.reject(new Error(message.error.message));
				else waiter?.resolve(message.result);
			} else if (message.method === "textDocument/publishDiagnostics") {
				this.onDiagnostics(message.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] });
			} else if (message.id !== undefined && message.method) {
				// A server→client request (e.g. workDoneProgress/create): ack it.
				this.send({ id: message.id, result: null });
			}
		}
	}

	private onDiagnostics(params: { uri: string; version?: number; diagnostics: LspDiagnostic[] }) {
		const doc = [...this.docs.values()].find((d) => d.uri === params.uri);
		if (!doc) return;
		const version = params.version ?? doc.version;
		doc.diagnostics = { version, items: params.diagnostics };
		doc.markReady();
		doc.waiters = doc.waiters.filter((w) => (w.version <= version ? (w.resolve(), false) : true));
	}

	private send(message: Record<string, unknown>) {
		if (this.dead) return;
		const text = JSON.stringify({ jsonrpc: "2.0", ...message });
		this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
	}

	private notify(method: string, params: unknown) {
		this.send({ method, params });
	}

	request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
		if (this.dead) return Promise.reject(new Error("clangd is not running"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new ClangdTimeout(`clangd ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.send({ id, method, params });
		});
	}

	/** Open or update a document with the editor's full text. */
	sync(docId: string, language: CodeLanguage, source: string): OpenDoc {
		const key = `${language}:${docId}`;
		let doc = this.docs.get(key);
		if (!doc) {
			let markReady!: () => void;
			const ready = new Promise<void>((r) => (markReady = r));
			doc = { uri: `file://${ROOT}/${language}/${docId}.${EXT[language]}`, version: 1, text: source, openedAt: Date.now(), ready, markReady, diagnostics: null, waiters: [] };
			this.docs.set(key, doc);
			this.notify("textDocument/didOpen", { textDocument: { uri: doc.uri, languageId: language === "c" ? "c" : "cpp", version: 1, text: source } });
			if (this.docs.size > MAX_DOCS) {
				const [oldestKey, oldest] = this.docs.entries().next().value!;
				this.docs.delete(oldestKey);
				this.notify("textDocument/didClose", { textDocument: { uri: oldest.uri } });
			}
		} else {
			// Most recently used last (the eviction order).
			this.docs.delete(key);
			this.docs.set(key, doc);
			if (doc.text === source) return doc;
			doc.text = source;
			doc.version++;
			this.notify("textDocument/didChange", { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text: source }] });
		}
		return doc;
	}

	/** Diagnostics for exactly the version just synced (or the latest, on
	 *  timeout — `onTime` false). */
	diagnosticsFor(doc: OpenDoc): Promise<{ items: LspDiagnostic[]; onTime: boolean }> {
		const version = doc.version;
		if (doc.diagnostics && doc.diagnostics.version >= version) return Promise.resolve({ items: doc.diagnostics.items, onTime: true });
		return new Promise((resolve) => {
			const done = (onTime: boolean) => resolve({ items: doc.diagnostics?.items ?? [], onTime });
			const timer = setTimeout(() => done(false), this.requestTimeoutMs);
			doc.waiters.push({ version, resolve: () => (clearTimeout(timer), done(!this.dead)) });
		});
	}

	/** Count an answer in or out of time; true once clangd looks stuck. */
	answered(kind: "complete" | "diagnose", onTime: boolean): boolean {
		this.late[kind] = onTime ? 0 : this.late[kind] + 1;
		return this.late[kind] >= STUCK_AFTER;
	}

	/** Put a stuck clangd down — deliberately, so no crash backoff: the
	 *  next request (after the editor's pause) starts a fresh one. */
	discard() {
		this.stopping = true;
		this.die(new Error("clangd stopped answering"));
	}

	shutdown() {
		if (this.dead) return;
		this.stopping = true;
		this.request("shutdown", null, 1_000)
			.catch(() => {})
			.finally(() => {
				this.notify("exit", null);
				setTimeout(() => {
					if (!this.dead) this.proc.kill("SIGKILL");
				}, 1_000).unref();
			});
	}
}

// One session per server process, kept on globalThis so a dev hot reload
// reuses it instead of leaking a second clangd.
interface ClangdGlobal {
	__lhClangd?: {
		session: ClangdSession | null;
		idle: ReturnType<typeof setTimeout> | null;
		backoffUntil?: number;
		image?: { status: "unknown" | "building" | "ready" | "failed"; at: number; check?: Promise<boolean> };
		swept?: boolean;
	};
}
function slot() {
	const g = globalThis as ClangdGlobal;
	return (g.__lhClangd ??= { session: null, idle: null });
}
const CRASH_WINDOW_MS = 5_000;
const CRASH_BACKOFF_MS = 60_000;

async function session(): Promise<ClangdSession | null> {
	const s = slot();
	if (s.session && !s.session.dead) {
		armIdle();
		return s.session;
	}
	if ((s.backoffUntil ?? 0) > Date.now()) return null;
	const launch = launchOverride ? launchOverride() : await dockerLaunch();
	if (!launch) return null;
	// A concurrent request may have started one while this one awaited.
	if (s.session && !s.session.dead) {
		armIdle();
		return s.session;
	}
	s.session = new ClangdSession(launch);
	armIdle();
	return s.session;
}

function armIdle() {
	const s = slot();
	if (s.idle) clearTimeout(s.idle);
	s.idle = setTimeout(stopClangd, CLANGD_IDLE_MS);
	s.idle.unref?.();
}

/** clangd stopped answering: drop it (its container goes with it). The
 *  caller answers "unavailable", so the editor pauses ASSIST_RETRY_MS. */
function restartStuck(stuck: ClangdSession) {
	console.warn("[clangd] not answering — restarting it");
	stuck.discard();
	const s = slot();
	if (s.session === stuck) s.session = null;
}

/** Stop clangd now (idle timeout, tests). */
export function stopClangd(): void {
	const s = slot();
	if (s.idle) clearTimeout(s.idle);
	s.idle = null;
	s.session?.shutdown();
	s.session = null;
}

/** Is a clangd session running right now (tests: idle shutdown). */
export function clangdRunning(): boolean {
	const s = slot().session;
	return s !== null && !s.dead;
}

async function ready(req: CodeAssistRequest): Promise<{ s: ClangdSession; doc: OpenDoc } | null> {
	const s = await session();
	if (!s) return null;
	await s.initialized;
	const doc = s.sync(req.docId, req.language, req.source);
	// The first request on a document waits for its headers' parse — before
	// it, completion knows nothing from the #includes.
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([doc.ready, new Promise((r) => (timer = setTimeout(r, READY_TIMEOUT_MS)))]);
	clearTimeout(timer);
	return { s, doc };
}

/** Completions at `req.offset`, as editor-ready replacements. */
export async function clangdComplete(req: CodeAssistRequest): Promise<CodeCompletionResult> {
	const opened = await ready(req);
	if (!opened) return { available: false, items: [] };
	const offset = req.offset ?? req.source.length;
	const ask = async () => {
		const result = (await opened.s.request("textDocument/completion", {
			textDocument: { uri: opened.doc.uri },
			position: offsetToPosition(req.source, offset),
		})) as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
		return Array.isArray(result) ? result : (result?.items ?? []);
	};
	// A freshly opened document answers empty for a beat after its first
	// diagnostics (the completion preamble lands ~50 ms later, measured):
	// retry briefly then — never on a settled document, where empty is real.
	let raw: LspCompletionItem[];
	try {
		raw = await ask();
		for (let attempt = 0; raw.length === 0 && attempt < FRESH_RETRIES && Date.now() - opened.doc.openedAt < FRESH_WINDOW_MS; attempt++) {
			await new Promise((r) => setTimeout(r, FRESH_RETRY_MS));
			raw = await ask();
		}
	} catch (err) {
		if (err instanceof ClangdTimeout && opened.s.answered("complete", false)) {
			restartStuck(opened.s);
			return { available: false, items: [] };
		}
		throw err;
	}
	opened.s.answered("complete", true);
	const items = raw.map((item): CodeCompletion => {
		const edit = item.textEdit;
		const name = (item.filterText ?? item.label).trim();
		// clangd's label carries the signature ("printf(const char *, ...)");
		// the detail shows it beside the return type when it says more.
		const signature = item.label.trim();
		const detail = [signature !== name ? signature : null, item.detail].filter(Boolean).join(" → ");
		return {
			label: name,
			...(detail ? { detail } : {}),
			...(item.kind !== undefined ? { kind: item.kind } : {}),
			insert: edit?.newText ?? item.insertText ?? item.label.trim(),
			snippet: item.insertTextFormat === 2,
			from: edit ? positionToOffset(req.source, edit.range.start) : offset,
			to: edit ? positionToOffset(req.source, edit.range.end) : offset,
		};
	});
	return { available: true, items };
}

const SEVERITY: Record<number, CodeDiagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "info" };

/** Diagnostics for the posted text, mapped to offsets. */
export async function clangdDiagnostics(req: CodeAssistRequest): Promise<CodeDiagnosticsResult> {
	const opened = await ready(req);
	if (!opened) return { available: false, diagnostics: [] };
	const { items, onTime } = await opened.s.diagnosticsFor(opened.doc);
	if (opened.s.answered("diagnose", onTime)) {
		restartStuck(opened.s);
		return { available: false, diagnostics: [] };
	}
	return {
		available: true,
		diagnostics: items.map((d) => ({
			from: positionToOffset(req.source, d.range.start),
			to: positionToOffset(req.source, d.range.end),
			severity: SEVERITY[d.severity ?? 1] ?? "error",
			message: d.message,
		})),
	};
}
