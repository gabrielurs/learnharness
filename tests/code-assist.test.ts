/**
 * clangd behind the code editor (owner, 2026-10-25): the assist contract,
 * the server module against the REAL clangd in Docker (owner, 2026-10-26;
 * skipped where Docker is not running — the first run builds the image),
 * the POST routes' 400 gate, and the editor's completion and lint sources
 * over a stubbed fetch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { CodeRunRequestError, offsetToPosition, parseCodeAssistRequest, positionToOffset } from "../src/core/contracts/code.ts";
import { execFileSync } from "node:child_process";
import { CLANGD_IMAGE, clangdComplete, clangdDiagnostics, clangdRunning, clangdUsable, setClangdLaunchForTests, stopClangd } from "../src/server/clangd.ts";
import { resetDockerAvailability } from "../src/server/docker-runner.ts";
import { ASSIST_RETRY_MS, assistSources, lspSnippetToCodeMirror, resetAssistAvailability } from "../components/code-assist.ts";

after(() => stopClangd());

describe("assist contract", () => {
	it("validates bodies: docId charset, language, source size, offset inside source", () => {
		assert.deepEqual(parseCodeAssistRequest({ docId: "call_1-a", language: "c", source: "int x;", offset: 3 }, true), {
			docId: "call_1-a",
			language: "c",
			source: "int x;",
			offset: 3,
		});
		assert.throws(() => parseCodeAssistRequest({ docId: "../etc", language: "c", source: "" }, false), CodeRunRequestError);
		assert.throws(() => parseCodeAssistRequest({ docId: "a", language: "rust", source: "" }, false), CodeRunRequestError);
		assert.throws(() => parseCodeAssistRequest({ docId: "a", language: "c", source: "ab", offset: 9 }, true), CodeRunRequestError);
		assert.throws(() => parseCodeAssistRequest({ docId: "a", language: "c", source: "ab" }, true), CodeRunRequestError, "completion needs an offset");
	});

	it("offset ↔ LSP position round-trips and clamps", () => {
		const src = "ab\ncde\n\nf";
		for (let offset = 0; offset <= src.length; offset++) assert.equal(positionToOffset(src, offsetToPosition(src, offset)), offset);
		assert.deepEqual(offsetToPosition(src, 5), { line: 1, character: 2 });
		assert.equal(positionToOffset(src, { line: 1, character: 99 }), 6, "clamped to the line end");
		assert.equal(positionToOffset(src, { line: 99, character: 0 }), src.length);
	});

	it("LSP snippets become CodeMirror templates", () => {
		assert.equal(lspSnippetToCodeMirror("printf(${1:const char *, ...})"), "printf(${1:const char *, ...})");
		assert.equal(lspSnippetToCodeMirror("foo($1, $2)$0"), "foo(${1}, ${2})${0}");
		assert.equal(lspSnippetToCodeMirror("cost \\$5"), "cost $5");
	});
});

const usable = await clangdUsable();
/** Our server's clangd containers (the label carries its pid). */
const ourContainers = () =>
	execFileSync("docker", ["ps", "-aq", "--filter", `label=learnharness.clangd.pid=${process.pid}`], { encoding: "utf8" }).trim();
describe("clangd (real, in Docker)", { skip: usable ? false : "Docker is not running here" }, () => {
	const C = '#include <stdio.h>\nint main(void) {\n    int count = 3;\n    pri\n    return x;\n}\n';

	it("completes from the #includes on a fresh document (printf, as a snippet over the typed word)", async () => {
		const offset = C.indexOf("pri") + 3;
		const result = await clangdComplete({ docId: "t-fresh", language: "c", source: C, offset });
		assert.equal(result.available, true);
		const printf = result.items.find((i) => i.label === "printf");
		assert.ok(printf, `printf among ${result.items.map((i) => i.label).slice(0, 10).join(", ")}`);
		assert.equal(printf.snippet, true);
		assert.match(printf.insert, /^printf\(\$\{1:/);
		assert.deepEqual([printf.from, printf.to], [C.indexOf("pri"), offset], "replaces exactly the typed word");
	});

	it("C++: member completion after std::", async () => {
		const cpp = "#include <iostream>\nint main() {\n    std::co\n}\n";
		const result = await clangdComplete({ docId: "t-cpp", language: "cpp", source: cpp, offset: cpp.indexOf("std::co") + 7 });
		assert.ok(result.items.some((i) => i.label === "cout"));
	});

	it("diagnostics map to offsets; an unchanged text answers at once", async () => {
		const first = await clangdDiagnostics({ docId: "t-diag", language: "c", source: C });
		const undeclared = first.diagnostics.find((d) => /undeclared identifier 'pri'/.test(d.message));
		assert.ok(undeclared, JSON.stringify(first.diagnostics));
		assert.equal(undeclared.severity, "error");
		assert.equal(C.slice(undeclared.from, undeclared.to), "pri");
		const t = Date.now();
		await clangdDiagnostics({ docId: "t-diag", language: "c", source: C });
		assert.ok(Date.now() - t < 1_000, "no wait for a republish that never comes");
		const fixed = C.replace("    pri\n", "").replace("return x;", "return count;");
		const second = await clangdDiagnostics({ docId: "t-diag", language: "c", source: fixed });
		assert.deepEqual(second.diagnostics, [], "the edit's own diagnostics, not the stale ones");
	});

	it("an #include of a host file finds nothing of the host", async () => {
		const host = path.resolve("package.json");
		const source = `#include "${host}"\nint main(void){return 0;}\n`;
		const { diagnostics } = await clangdDiagnostics({ docId: "t-host", language: "c", source });
		assert.ok(diagnostics.some((d) => /file not found/.test(d.message)), JSON.stringify(diagnostics));
		const leaked = diagnostics.filter((d) => /AGPL|amosblomqvist|"version"/.test(d.message));
		assert.deepEqual(leaked, [], "no token of the host file reaches the editor");
	});

	it("stopping shuts clangd down and removes its container; the next request starts it again", async () => {
		assert.notEqual(ourContainers(), "", "a container while it runs");
		stopClangd();
		assert.equal(clangdRunning(), false);
		for (let i = 0; i < 40 && ourContainers() !== ""; i++) await new Promise((r) => setTimeout(r, 250));
		assert.equal(ourContainers(), "", "the container is gone");
		const result = await clangdDiagnostics({ docId: "t-restart", language: "c", source: "int main(void){return 0;}\n" });
		assert.equal(result.available, true);
		assert.equal(clangdRunning(), true);
	});
});

describe("orphans of a dead server are swept", () => {
	it("a clangd container whose server pid is gone is removed on the next start; others stay", { skip: usable ? false : "Docker is not running here" }, async () => {
		stopClangd();
		const start = (pid: number, started?: string) =>
			execFileSync(
				"docker",
				["run", "-d", "--rm", "--network", "none", "--label", `learnharness.clangd.pid=${pid}`, ...(started ? ["--label", `learnharness.clangd.started=${started}`] : []), "--entrypoint", "sleep", CLANGD_IMAGE, "60"],
				{ encoding: "utf8" },
			).trim();
		const parentStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.ppid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
		const dead = start(2 ** 22 + 12345); // above macOS's pid range: never alive
		const reused = start(process.ppid, "Thu Jan  1 00:00:00 1970"); // that pid, but another process now
		const live = start(process.ppid, parentStart); // a live process: not ours to remove
		try {
			(globalThis as { __lhClangd?: { swept?: boolean } }).__lhClangd!.swept = false;
			const result = await clangdDiagnostics({ docId: "t-sweep", language: "c", source: "int main(void){return 0;}\n" });
			assert.equal(result.available, true);
			const running = execFileSync("docker", ["ps", "-aq", "--no-trunc"], { encoding: "utf8" });
			assert.ok(!running.includes(dead), "the dead server's container is gone");
			assert.ok(!running.includes(reused), "a reused pid does not keep a dead server's container");
			assert.ok(running.includes(live), "a live server's container stays");
		} finally {
			execFileSync("docker", ["rm", "-f", dead, reused, live], { stdio: "ignore" });
		}
	});
});

describe("a failed process list sweeps nothing", () => {
	it("ps unavailable: a started-labeled container is kept, never taken for dead", { skip: usable ? false : "Docker is not running here" }, async () => {
		stopClangd();
		const id = execFileSync(
			"docker",
			["run", "-d", "--rm", "--network", "none", "--label", "learnharness.clangd.pid=99998", "--label", "learnharness.clangd.started=Thu Jan  1 00:00:00 1970", "--entrypoint", "sleep", CLANGD_IMAGE, "60"],
			{ encoding: "utf8" },
		).trim();
		const realPath = process.env.PATH;
		// Only docker's own directory: docker works, `ps` is not found.
		process.env.PATH = path.dirname(execFileSync("/usr/bin/which", ["docker"], { encoding: "utf8" }).trim());
		try {
			(globalThis as { __lhClangd?: { swept?: boolean } }).__lhClangd!.swept = false;
			await clangdDiagnostics({ docId: "t-nops", language: "c", source: "int main(void){return 0;}\n" });
			assert.ok(execFileSync("docker", ["ps", "-aq", "--no-trunc"], { encoding: "utf8" }).includes(id), "kept");
		} finally {
			process.env.PATH = realPath;
			stopClangd();
			execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
		}
	});
});

describe("without Docker, no assistance (and no host clangd)", () => {
	it("a dead daemon answers unavailable; assistance returns with Docker", { skip: usable ? false : "Docker is not running here" }, async () => {
		stopClangd();
		const real = process.env.DOCKER_HOST;
		process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
		resetDockerAvailability();
		try {
			const off = await clangdComplete({ docId: "t-off", language: "c", source: "int x;", offset: 6 });
			assert.deepEqual(off, { available: false, items: [] });
			assert.equal(clangdRunning(), false, "nothing spawned on the host");
		} finally {
			if (real === undefined) delete process.env.DOCKER_HOST;
			else process.env.DOCKER_HOST = real;
			resetDockerAvailability();
		}
		const on = await clangdDiagnostics({ docId: "t-on", language: "c", source: "int main(void){return 0;}\n" });
		assert.equal(on.available, true);
	});
});

describe("a clangd that dies on start is not respawned per keystroke", () => {
	it("backs off after an immediate crash", async () => {
		stopClangd();
		setClangdLaunchForTests(() => ({ command: "/usr/bin/false", args: [] })); // exits at once
		try {
			const first = await clangdDiagnostics({ docId: "t-crash", language: "c", source: "int x;" }).catch(() => null);
			assert.ok(first === null || first.available === true, "the first try ran (and failed)");
			await new Promise((r) => setTimeout(r, 50));
			const second = await clangdDiagnostics({ docId: "t-crash", language: "c", source: "int x;" });
			assert.equal(second.available, false, "held off: no respawn");
		} finally {
			setClangdLaunchForTests(null);
			(globalThis as { __lhClangd?: { backoffUntil?: number } }).__lhClangd!.backoffUntil = 0;
		}
	});
});

describe("clangd dying mid-session never takes the server down", () => {
	it("a write after the crash (EPIPE) degrades to an error, not an uncaught exception", async () => {
		stopClangd();
		// A fake clangd: answers initialize, publishes (empty) diagnostics for
		// the first didOpen — then closes its stdin and stays alive, so the
		// next write hits a pipe with no reader (EPIPE) while the process lives.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fake-clangd-"));
		const fake = path.join(dir, "clangd");
		const send = (body: string) => `process.stdout.write("Content-Length: " + Buffer.byteLength(${body}) + "\\r\\n\\r\\n" + ${body});`;
		fs.writeFileSync(
			fake,
			`#!${process.execPath}\n` +
				`let buf = "", acked = false, opened = false;\n` +
				`process.stdin.on("data", (d) => {\n` +
				`  buf += d;\n` +
				`  if (!acked && buf.includes('"initialize"')) { acked = true; const b = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }); ${send("b")} }\n` +
				`  const m = /didOpen".*?"uri":"([^"]+)"/.exec(buf);\n` +
				`  if (!opened && m) { opened = true; const b = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: m[1], version: 1, diagnostics: [] } }); ${send("b")}\n` +
				`    setTimeout(() => { process.stdin.destroy(); require("fs").closeSync(0); }, 20); }\n` +
				`});\n` +
				`setInterval(() => {}, 1000);\n`,
		);
		fs.chmodSync(fake, 0o755);
		setClangdLaunchForTests(() => ({ command: fake, args: [] }));
		const uncaught: unknown[] = [];
		const onUncaught = (e: unknown) => void uncaught.push(e);
		process.on("uncaughtException", onUncaught);
		try {
			const first = await clangdDiagnostics({ docId: "t-epipe", language: "c", source: "int x;" });
			assert.equal(first.available, true, "the fake answered the open");
			await new Promise((r) => setTimeout(r, 100)); // its stdin is closed now
			// A changed text → didChange into the reader-less pipe.
			await clangdDiagnostics({ docId: "t-epipe", language: "c", source: "int y;" }).catch(() => null);
			await new Promise((r) => setTimeout(r, 200));
			assert.deepEqual(uncaught, []);
			assert.equal(clangdRunning(), false, "the broken session is dead…");
			const alive = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(dir));
			assert.deepEqual(alive, [], "…and its process is gone");
		} finally {
			process.off("uncaughtException", onUncaught);
			setClangdLaunchForTests(null);
			(globalThis as { __lhClangd?: { backoffUntil?: number } }).__lhClangd!.backoffUntil = 0;
			stopClangd();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("a clangd that stops answering is restarted", () => {
	it("three late answers in a row: unavailable (the editor pauses), and the next request starts a fresh clangd", async () => {
		stopClangd();
		// A fake clangd: answers initialize, publishes diagnostics for each
		// didOpen — and never answers a completion.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mute-clangd-"));
		const fake = path.join(dir, "clangd");
		const send = (body: string) => `process.stdout.write("Content-Length: " + Buffer.byteLength(${body}) + "\\r\\n\\r\\n" + ${body});`;
		fs.writeFileSync(
			fake,
			`#!${process.execPath}\n` +
				`let buf = "", acked = false; const opened = new Set();\n` +
				`process.stdin.on("data", (d) => {\n` +
				`  buf += d;\n` +
				`  if (!acked && buf.includes('"initialize"')) { acked = true; const b = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }); ${send("b")} }\n` +
				`  for (const m of buf.matchAll(/didOpen".*?"uri":"([^"]+)"/g)) if (!opened.has(m[1])) { opened.add(m[1]); const b = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: m[1], version: 1, diagnostics: [] } }); ${send("b")} }\n` +
				`});\n` +
				`setInterval(() => {}, 1000);\n`,
		);
		fs.chmodSync(fake, 0o755);
		setClangdLaunchForTests(() => ({ command: fake, args: [], requestTimeoutMs: 100 }));
		const req = { docId: "t-mute", language: "c" as const, source: "int x;", offset: 6 };
		try {
			await assert.rejects(clangdComplete(req), /timed out/, "one late answer: an error (the route says: no items)…");
			await assert.rejects(clangdComplete(req), /timed out/, "…two…");
			assert.deepEqual(await clangdComplete(req), { available: false, items: [] }, "three: unavailable");
			assert.equal(clangdRunning(), false, "the stuck clangd is gone");
			await new Promise((r) => setTimeout(r, 100));
			const alive = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(dir));
			assert.deepEqual(alive, [], "its process too");
			assert.equal((await clangdDiagnostics(req)).available, true, "the next request: a fresh one (no crash backoff)");
			assert.equal(clangdRunning(), true);
		} finally {
			setClangdLaunchForTests(null);
			stopClangd();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("diagnostics stuck while completions answer: restarted all the same", async () => {
		stopClangd();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-nodiag-clangd-"));
		const fake = path.join(dir, "clangd");
		const send = (body: string) => `process.stdout.write("Content-Length: " + Buffer.byteLength(${body}) + "\\r\\n\\r\\n" + ${body});`;
		// Publishes diagnostics for the open only; answers every completion.
		fs.writeFileSync(
			fake,
			`#!${process.execPath}\n` +
				`let buf = "", acked = false, opened = false, seen = 0;\n` +
				`process.stdin.on("data", (d) => {\n` +
				`  buf += d;\n` +
				`  if (!acked && buf.includes('"initialize"')) { acked = true; const b = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }); ${send("b")} }\n` +
				`  const m = /didOpen".*?"uri":"([^"]+)"/.exec(buf);\n` +
				`  if (!opened && m) { opened = true; const b = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: m[1], version: 1, diagnostics: [] } }); ${send("b")} }\n` +
				`  const asks = [...buf.matchAll(/"id":(\\d+),"method":"textDocument\\/completion"/g)];\n` +
				`  for (const a of asks.slice(seen)) { seen++; const b = JSON.stringify({ jsonrpc: "2.0", id: Number(a[1]), result: { items: [{ label: "x" }] } }); ${send("b")} }\n` +
				`});\n` +
				`setInterval(() => {}, 1000);\n`,
		);
		fs.chmodSync(fake, 0o755);
		setClangdLaunchForTests(() => ({ command: fake, args: [], requestTimeoutMs: 100 }));
		const req = (source: string) => ({ docId: "t-nodiag", language: "c" as const, source, offset: source.length });
		try {
			assert.equal((await clangdDiagnostics(req("int a;"))).available, true, "the open publishes");
			for (const source of ["int b;", "int c;"]) {
				assert.equal((await clangdDiagnostics(req(source))).available, true, "late, not yet stuck");
				assert.equal((await clangdComplete(req(source))).available, true, "completions answer in between");
			}
			assert.deepEqual(await clangdDiagnostics(req("int d;")), { available: false, diagnostics: [] }, "the third late diagnostics in a row");
			assert.equal(clangdRunning(), false);
		} finally {
			setClangdLaunchForTests(null);
			stopClangd();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("an answer in time resets the count", async () => {
		stopClangd();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-slow-clangd-"));
		const fake = path.join(dir, "clangd");
		const send = (body: string) => `process.stdout.write("Content-Length: " + Buffer.byteLength(${body}) + "\\r\\n\\r\\n" + ${body});`;
		// Answers every OTHER completion: late, on time, late, on time…
		fs.writeFileSync(
			fake,
			`#!${process.execPath}\n` +
				`let buf = "", acked = false, opened = false, seen = 0;\n` +
				`process.stdin.on("data", (d) => {\n` +
				`  buf += d;\n` +
				`  if (!acked && buf.includes('"initialize"')) { acked = true; const b = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }); ${send("b")} }\n` +
				`  const m = /didOpen".*?"uri":"([^"]+)"/.exec(buf);\n` +
				`  if (!opened && m) { opened = true; const b = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: m[1], version: 1, diagnostics: [] } }); ${send("b")} }\n` +
				`  const asks = [...buf.matchAll(/"id":(\\d+),"method":"textDocument\\/completion"/g)];\n` +
				`  for (const a of asks.slice(seen)) { seen++; if (seen % 2 === 0) { const b = JSON.stringify({ jsonrpc: "2.0", id: Number(a[1]), result: { items: [{ label: "x" }] } }); ${send("b")} } }\n` +
				`});\n` +
				`setInterval(() => {}, 1000);\n`,
		);
		fs.chmodSync(fake, 0o755);
		setClangdLaunchForTests(() => ({ command: fake, args: [], requestTimeoutMs: 100 }));
		const req = { docId: "t-slow", language: "c" as const, source: "int x;", offset: 6 };
		try {
			for (let i = 0; i < 3; i++) {
				await assert.rejects(clangdComplete(req), /timed out/);
				assert.equal((await clangdComplete(req)).available, true);
			}
			assert.equal(clangdRunning(), true, "never three in a row: never restarted");
		} finally {
			setClangdLaunchForTests(null);
			stopClangd();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the POST routes' gate", () => {
	it("400 on a malformed body, never a clangd spawn", async () => {
		const { POST } = await import("../app/api/code/complete/route.ts");
		const res = await POST(new Request("http://x/api/code/complete", { method: "POST", body: JSON.stringify({ docId: "bad id!", language: "c", source: "", offset: 0 }) }));
		assert.equal(res.status, 400);
		const diag = await import("../app/api/code/diagnostics/route.ts");
		const res2 = await diag.POST(new Request("http://x/api/code/diagnostics", { method: "POST", body: "not json" }));
		assert.equal(res2.status, 400);
	});
});

describe("editor sources (stubbed fetch)", () => {
	const realFetch = globalThis.fetch;
	after(() => {
		globalThis.fetch = realFetch;
	});
	const reply = (body: unknown) => {
		const calls: unknown[] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			calls.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify(body), { status: 200 });
		}) as typeof fetch;
		return calls;
	};

	it("completion: asks with the doc + caret, maps kinds, snippets apply as templates", async () => {
		resetAssistAvailability();
		const calls = reply({ available: true, items: [{ label: "printf", detail: "int", kind: 3, insert: "printf(${1:fmt})", snippet: true, from: 4, to: 7 }] });
		const state = EditorState.create({ doc: "int pri" });
		const { complete } = assistSources({ docId: "call|x", language: "c" });
		const result = await complete(new CompletionContext(state, 7, false));
		assert.deepEqual(calls[0], { docId: "call_x", language: "c", source: "int pri", offset: 7 }, "a docId clangd accepts");
		assert.equal(result!.from, 4);
		assert.equal(result!.options[0]!.type, "function");
		assert.equal(typeof result!.options[0]!.apply, "function", "a snippet applies as a template");
	});

	it("an item whose edit starts elsewhere replaces its own range", async () => {
		resetAssistAvailability();
		reply({ available: true, items: [
			{ label: "printf", insert: "printf", snippet: false, from: 4, to: 7 },
			{ label: "ptr->x", insert: "ptr->x", snippet: false, from: 0, to: 7 },
			{ label: "Z", insert: "Z", snippet: false, from: 6, to: 7 },
		] });
		let state = EditorState.create({ doc: "int pri" });
		const { complete } = assistSources({ docId: "d", language: "c" });
		const result = (await complete(new CompletionContext(state, 7, false)))!;
		assert.equal(result.from, 4);
		const option = result.options[1]!;
		assert.equal(typeof option.apply, "function");
		const view = { get state() { return state; }, dispatch: (tr: TransactionSpec) => void (state = state.update(tr).state) };
		(option.apply as (v: unknown, c: unknown, from: number, to: number) => void)(view, option, result.from, 7);
		assert.equal(state.doc.toString(), "ptr->x", "from 0, not from the list's 4");
		assert.equal(state.selection.main.head, 6);
		assert.equal(result.options[0]!.apply, "printf", "a shared-range item stays plain");
		// The document moved since the request: a shifted start never
		// passes the caret (it would be an inverted, invalid range).
		state = EditorState.create({ doc: "int pri" });
		const ahead = result.options[2]!;
		(ahead.apply as (v: unknown, c: unknown, from: number, to: number) => void)(view, ahead, 4, 5);
		assert.equal(state.doc.toString(), "int pZri", "inserted at the caret, not past it");
	});

	it("no word, no trigger, not explicit → no request", async () => {
		resetAssistAvailability();
		const calls = reply({ available: true, items: [] });
		const { complete } = assistSources({ docId: "d", language: "c" });
		assert.equal(await complete(new CompletionContext(EditorState.create({ doc: "x = " }), 4, false)), null);
		assert.equal(calls.length, 0);
		await complete(new CompletionContext(EditorState.create({ doc: "s." }), 2, false));
		assert.equal(calls.length, 1, "a member access asks");
	});

	it("unavailable: the editor goes quiet, then asks again after ASSIST_RETRY_MS", async () => {
		resetAssistAvailability();
		const calls = reply({ available: false, items: [] });
		const { complete, diagnose } = assistSources({ docId: "d", language: "c" });
		const state = EditorState.create({ doc: "int pri" });
		assert.equal(await complete(new CompletionContext(state, 7, false)), null);
		assert.deepEqual(await diagnose({ state }), []);
		assert.equal(calls.length, 1, "one probe, then silence");
		const realNow = Date.now;
		const later = realNow() + ASSIST_RETRY_MS + 1;
		Date.now = () => later;
		try {
			await diagnose({ state });
		} finally {
			Date.now = realNow;
		}
		assert.equal(calls.length, 2, "Docker may be back: one more probe");
	});

	it("lint: severities pass through, ranges clamp into the document", async () => {
		resetAssistAvailability();
		reply({ available: true, diagnostics: [{ from: 4, to: 99, severity: "warning", message: "unused" }] });
		const { diagnose } = assistSources({ docId: "d", language: "c" });
		const out = await diagnose({ state: EditorState.create({ doc: "int x;" }) });
		assert.deepEqual(out, [{ from: 4, to: 6, severity: "warning", message: "unused", source: "clangd" }]);
	});
});
