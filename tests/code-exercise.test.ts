import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
	CodeRunRequestError,
	codeExerciseProblems,
	normalizeOutput,
	outputsMatch,
	parseCodeRunRequest,
	renderCodeSubmission,
	runSummary,
	type CodeRunResult,
} from "../src/core/contracts/code.ts";
import { createPracticeGate, problemInputObject, problemTool } from "../src/agent/tools/practice.ts";
import { findCompiler, runCode } from "../src/server/code-runner.ts";

/** Coding exercises (fork, 2026-10-24): C/C++ compiled locally, tests as data. */

const SUM_C = '#include <stdio.h>\nint main(void){int a,b;if(scanf("%d %d",&a,&b)!=2)return 1;printf("%d\\n",a+b);return 0;}\n';

describe("code contract", () => {
	it("compares output modulo trailing whitespace and CRLF", () => {
		assert.equal(normalizeOutput("5  \r\n\n\n"), "5");
		assert.ok(outputsMatch("1 2\n3\n", "1 2\n3"));
		assert.ok(!outputsMatch("1  2", "1 2"), "inner spacing still matters");
	});

	it("validates run requests (the route's 400 gate)", () => {
		assert.deepEqual(parseCodeRunRequest({ language: "c", source: "x", tests: [{ stdin: "", expected: "1", hidden: true }] }), {
			language: "c",
			source: "x",
			tests: [{ stdin: "", expected: "1", hidden: true }],
		});
		assert.throws(() => parseCodeRunRequest({ language: "rust", source: "x" }), CodeRunRequestError);
		assert.throws(() => parseCodeRunRequest({ language: "c", source: "  " }), CodeRunRequestError);
		assert.throws(() => parseCodeRunRequest({ language: "c", source: "x", tests: [{ stdin: 1 }] }), CodeRunRequestError);
	});

	it("flags bad exercises: no tests, or only hidden ones", () => {
		assert.deepEqual(codeExerciseProblems({ language: "c", tests: [{ stdin: "", expected: "1" }] }), []);
		assert.equal(codeExerciseProblems({ language: "c", tests: [] }).length, 1);
		assert.match(codeExerciseProblems({ language: "cpp", tests: [{ stdin: "", expected: "1", hidden: true }] })[0]!, /VISIBLE/);
	});

	it("renders the submission the tutor reads — code, verdicts, failing data", () => {
		const result: CodeRunResult = {
			compile: { ok: true, output: "", ms: 10 },
			cases: [
				{ stdin: "2 3", stdout: "5\n", stderr: "", exitCode: 0, timedOut: false, truncated: false, ms: 1, expected: "5", passed: true },
				{ stdin: "1 1", stdout: "3\n", stderr: "", exitCode: 0, timedOut: false, truncated: false, ms: 1, expected: "2", passed: false, hidden: true },
			],
		};
		assert.deepEqual(runSummary(result), { passed: 1, total: 2, allPassed: false });
		const text = renderCodeSubmission("c", SUM_C, result);
		assert.match(text, /^Code \(C\):\n```c\n#include/);
		assert.match(text, /Tests: 1\/2 passed\./);
		assert.match(text, /- Test 2 \(hidden\): FAIL\n  stdin: "1 1"\n  expected: "2"\n  got: "3\\n"/);
		const failed = renderCodeSubmission("cpp", "x", { compile: { ok: false, output: "error: boom", ms: 1 }, cases: [] });
		assert.match(failed, /Compilation FAILED:\n```text\nerror: boom\n```/);
	});
});

describe("practice problem with code", () => {
	const ctx = { chatId: "c", chatStore: { getChat: () => ({ messages: [] }) } };
	const base = { statement: "Sum two ints", mode: "recall", modelSolution: SUM_C };

	it("the schema accepts a coding pose and rejects a malformed one", () => {
		const tool = { name: "problem", description: "", parameters: problemInputObject };
		const call = (args: object) => ({ type: "toolCall" as const, id: "1", name: "problem", arguments: args as never });
		assert.doesNotThrow(() => validateToolArguments(tool, call({ ...base, code: { language: "c", tests: [{ stdin: "1 2", expected: "3" }] } })));
		assert.throws(() => validateToolArguments(tool, call({ ...base, code: { language: "python", tests: [{ stdin: "", expected: "" }] } })));
	});

	it("execute refuses an exercise with only hidden tests", async () => {
		const result = await problemTool(createPracticeGate(ctx)).execute("p1", {
			...base,
			code: { language: "c", tests: [{ stdin: "", expected: "1", hidden: true }] },
		} as never);
		assert.match(JSON.stringify(result.content), /VISIBLE/);
	});
});

describe("local runner (real clang)", { skip: findCompiler("c") ? false : "no clang on this machine" }, () => {
	it("compiles, runs each test and grades it", async () => {
		const r = await runCode({ language: "c", source: SUM_C, tests: [{ stdin: "2 3", expected: "5" }, { stdin: "1 1", expected: "3" }] });
		assert.ok(r.compile.ok, r.compile.output);
		assert.ok(r.compile.sanitizers?.includes("undefined"));
		assert.deepEqual(r.cases.map((c) => c.passed), [true, false]);
	});

	it("reports compile errors without running", async () => {
		const r = await runCode({ language: "cpp", source: "int main(){ return x; }" });
		assert.equal(r.compile.ok, false);
		assert.match(r.compile.output, /undeclared identifier 'x'/);
		assert.deepEqual(r.cases, []);
	});

	it("kills a runaway program at the time limit", async () => {
		const r = await runCode({ language: "c", source: "int main(void){ for(;;){} }" });
		assert.equal(r.cases[0]!.timedOut, true);
	});

	it("the sanitizer turns an out-of-bounds write into a report", async () => {
		const r = await runCode({ language: "c", source: "#include <stdio.h>\nint main(void){int a[3]; for(int i=0;i<=3;i++) a[i]=i; printf(\"%d\\n\",a[0]); return 0;}\n" });
		assert.match(r.cases[0]!.stderr, /out of bounds|buffer-overflow/);
		assert.notEqual(r.cases[0]!.exitCode, 0);
	});
});

describe("web_fetch: public web only (fork, 2026-10-24)", () => {
	it("refuses loopback, private and local-name hosts", async () => {
		const { isPrivateHost, webFetchTool } = await import("../src/agent/tools/web.ts");
		for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.10", "172.20.0.1", "169.254.1.1", "[::1]", "printer.local", "fd00::1"]) {
			assert.equal(isPrivateHost(h), true, h);
		}
		for (const h of ["roadmap.sh", "8.8.8.8", "172.32.0.1", "github.com"]) assert.equal(isPrivateHost(h), false, h);
		const r = await webFetchTool.execute("t", { url: "http://localhost:3000/api/keys" } as never);
		assert.match(JSON.stringify(r.content), /refused/);
	});
});
