/**
 * clangd behind the code editor (owner, 2026-10-25): the assist contract,
 * the server module against the REAL clangd (skipped where none is
 * installed), the POST routes' 400 gate, and the editor's completion and
 * lint sources over a stubbed fetch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { CodeRunRequestError, offsetToPosition, parseCodeAssistRequest, positionToOffset } from "../src/core/contracts/code.ts";
import { clangdComplete, clangdDiagnostics, clangdRunning, findClangd, stopClangd } from "../src/server/clangd.ts";
import { assistSources, lspSnippetToCodeMirror, resetAssistAvailability } from "../components/code-assist.ts";

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

const clangd = findClangd();
describe("clangd (real binary)", { skip: clangd ? false : "no clangd on this machine" }, () => {
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

	it("stopping shuts clangd down; the next request starts it again", async () => {
		stopClangd();
		assert.equal(clangdRunning(), false);
		const result = await clangdDiagnostics({ docId: "t-restart", language: "c", source: "int main(void){return 0;}\n" });
		assert.equal(result.available, true);
		assert.equal(clangdRunning(), true);
	});
});

describe("a clangd that dies on start is not respawned per keystroke", () => {
	it("backs off after an immediate crash", async () => {
		stopClangd();
		const real = process.env.LH_CLANGD;
		const prevPath = process.env.PATH;
		process.env.LH_CLANGD = "/usr/bin/false"; // exits at once
		process.env.PATH = "";
		try {
			const first = await clangdDiagnostics({ docId: "t-crash", language: "c", source: "int x;" }).catch(() => null);
			assert.ok(first === null || first.available === true, "the first try ran (and failed)");
			await new Promise((r) => setTimeout(r, 50));
			const second = await clangdDiagnostics({ docId: "t-crash", language: "c", source: "int x;" });
			assert.equal(second.available, false, "held off: no respawn");
		} finally {
			process.env.PATH = prevPath;
			if (real === undefined) delete process.env.LH_CLANGD;
			else process.env.LH_CLANGD = real;
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
		const real = process.env.LH_CLANGD;
		process.env.LH_CLANGD = fake;
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
			const { execFileSync } = await import("node:child_process");
			const alive = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(dir));
			assert.deepEqual(alive, [], "…and its process is gone");
		} finally {
			process.off("uncaughtException", onUncaught);
			if (real === undefined) delete process.env.LH_CLANGD;
			else process.env.LH_CLANGD = real;
			(globalThis as { __lhClangd?: { backoffUntil?: number } }).__lhClangd!.backoffUntil = 0;
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

	it("no word, no trigger, not explicit → no request", async () => {
		resetAssistAvailability();
		const calls = reply({ available: true, items: [] });
		const { complete } = assistSources({ docId: "d", language: "c" });
		assert.equal(await complete(new CompletionContext(EditorState.create({ doc: "x = " }), 4, false)), null);
		assert.equal(calls.length, 0);
		await complete(new CompletionContext(EditorState.create({ doc: "s." }), 2, false));
		assert.equal(calls.length, 1, "a member access asks");
	});

	it("no clangd: the first answer says so and the editor stops asking", async () => {
		resetAssistAvailability();
		const calls = reply({ available: false, items: [] });
		const { complete, diagnose } = assistSources({ docId: "d", language: "c" });
		const state = EditorState.create({ doc: "int pri" });
		assert.equal(await complete(new CompletionContext(state, 7, false)), null);
		assert.deepEqual(await diagnose({ state }), []);
		assert.equal(calls.length, 1, "one probe, then silence");
	});

	it("lint: severities pass through, ranges clamp into the document", async () => {
		resetAssistAvailability();
		reply({ available: true, diagnostics: [{ from: 4, to: 99, severity: "warning", message: "unused" }] });
		const { diagnose } = assistSources({ docId: "d", language: "c" });
		const out = await diagnose({ state: EditorState.create({ doc: "int x;" }) });
		assert.deepEqual(out, [{ from: 4, to: 6, severity: "warning", message: "unused", source: "clangd" }]);
	});
});
