/**
 * clangd behind the code editor (owner, 2026-10-25): IDE completions and
 * as-you-type diagnostics for the C/C++ exercises. One clangd process,
 * spawned on the first request and shut down after CLANGD_IDLE_MS without
 * one (battery: nothing runs while no editor asks). Documents live in
 * clangd's memory only — didOpen/didChange with the editor's full text —
 * under a scratch workspace whose compile_flags.txt mirror the runner's
 * flags, so the editor and Run agree on what compiles.
 *
 * clangd never executes the learner's code; it only parses it. No API
 * keys reach it (a minimal env), and user/project clangd config is off.
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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

const FLAGS: Record<CodeLanguage, string[]> = {
	c: ["-xc", "-std=c17", "-Wall", "-Wextra"],
	cpp: ["-xc++", "-std=c++20", "-Wall", "-Wextra"],
};
const EXT: Record<CodeLanguage, string> = { c: "c", cpp: "cpp" };

const SEARCH = [
	"/Library/Developer/CommandLineTools/usr/bin/clangd",
	"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd",
	"/opt/homebrew/opt/llvm/bin/clangd",
	"/usr/local/opt/llvm/bin/clangd",
];

/** The clangd binary: LH_CLANGD, then PATH, then the usual toolchain homes. */
export function findClangd(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const candidates = [
		...(env.LH_CLANGD ? [env.LH_CLANGD] : []),
		...(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "clangd")),
		...SEARCH,
	];
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

/** macOS: the SDK clangd must see to find <stdio.h> (absent elsewhere).
 *  Asked once per server process — xcrun is synchronous. */
let sdkCache: { path: string | undefined } | null = null;
function sdkPath(): string | undefined {
	if (sdkCache) return sdkCache.path;
	let found: string | undefined;
	if (process.platform === "darwin") {
		try {
			found = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 5_000 }).trim() || undefined;
		} catch {}
	}
	sdkCache = { path: found };
	return found;
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

class ClangdSession {
	private proc: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private docs = new Map<string, OpenDoc>();
	readonly root: string;
	readonly initialized: Promise<void>;
	readonly startedAt = Date.now();
	dead = false;
	/** A deliberate shutdown (idle, tests) — never counted as a crash. */
	private stopping = false;

	constructor(binary: string) {
		this.root = mkdtempSync(path.join(tmpdir(), "learnharness-clangd-"));
		const sdk = sdkPath();
		for (const language of ["c", "cpp"] as const) {
			mkdirSync(path.join(this.root, language), { recursive: true });
			writeFileSync(path.join(this.root, language, "compile_flags.txt"), [...FLAGS[language], ...(sdk ? ["-isysroot", sdk] : [])].join("\n"));
		}
		this.proc = spawn(
			binary,
			["--log=error", "--background-index=false", "--header-insertion=never", "--completion-style=detailed", "--limit-results=100", "--enable-config=false"],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: this.root, TMPDIR: this.root, ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) } as unknown as NodeJS.ProcessEnv,
			},
		);
		this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.proc.stderr.on("data", () => {});
		// A write racing clangd's death fails with EPIPE on stdin — unhandled,
		// that error event would take the whole server down with it.
		this.proc.stdin.on("error", (err) => this.die(err));
		this.proc.on("exit", () => this.die(new Error("clangd exited")));
		this.proc.on("error", (err) => this.die(err));
		this.initialized = this.request("initialize", {
			processId: process.pid,
			rootUri: pathToFileURL(this.root).href,
			capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } }, publishDiagnostics: { versionSupport: true } } },
		}).then(() => this.notify("initialized", {}));
	}

	private die(err: Error) {
		if (this.dead) return;
		this.dead = true;
		// Died right after starting (a broken binary): hold off respawning,
		// or every keystroke would spawn a fresh failure.
		if (!this.stopping && Date.now() - this.startedAt < CRASH_WINDOW_MS) slot().backoffUntil = Date.now() + CRASH_BACKOFF_MS;
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
		rmSync(this.root, { recursive: true, force: true });
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

	request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (this.dead) return Promise.reject(new Error("clangd is not running"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`clangd ${method} timed out`));
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
			doc = { uri: pathToFileURL(path.join(this.root, language, `${docId}.${EXT[language]}`)).href, version: 1, text: source, openedAt: Date.now(), ready, markReady, diagnostics: null, waiters: [] };
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

	/** Diagnostics for exactly the version just synced (or the latest, on timeout). */
	diagnosticsFor(doc: OpenDoc): Promise<LspDiagnostic[]> {
		const version = doc.version;
		if (doc.diagnostics && doc.diagnostics.version >= version) return Promise.resolve(doc.diagnostics.items);
		return new Promise((resolve) => {
			const done = () => resolve(doc.diagnostics?.items ?? []);
			const timer = setTimeout(done, REQUEST_TIMEOUT_MS);
			doc.waiters.push({ version, resolve: () => (clearTimeout(timer), done()) });
		});
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
	__lhClangd?: { session: ClangdSession | null; idle: ReturnType<typeof setTimeout> | null; backoffUntil?: number };
}
function slot() {
	const g = globalThis as ClangdGlobal;
	return (g.__lhClangd ??= { session: null, idle: null });
}
const CRASH_WINDOW_MS = 5_000;
const CRASH_BACKOFF_MS = 60_000;

function session(): ClangdSession | null {
	const s = slot();
	if (s.session && !s.session.dead) {
		armIdle();
		return s.session;
	}
	if ((s.backoffUntil ?? 0) > Date.now()) return null;
	const binary = findClangd();
	if (!binary) return null;
	s.session = new ClangdSession(binary);
	armIdle();
	return s.session;
}

function armIdle() {
	const s = slot();
	if (s.idle) clearTimeout(s.idle);
	s.idle = setTimeout(stopClangd, CLANGD_IDLE_MS);
	s.idle.unref?.();
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
	const s = session();
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
	let raw = await ask();
	for (let attempt = 0; raw.length === 0 && attempt < FRESH_RETRIES && Date.now() - opened.doc.openedAt < FRESH_WINDOW_MS; attempt++) {
		await new Promise((r) => setTimeout(r, FRESH_RETRY_MS));
		raw = await ask();
	}
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
	const items = await opened.s.diagnosticsFor(opened.doc);
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
