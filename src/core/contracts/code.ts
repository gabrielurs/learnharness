/**
 * Coding exercises (fork, 2026-10-24) — the contract shared by the agent
 * tools that pose them, the dock that edits and runs them, and the server
 * runner that compiles them. PURE, browser-safe.
 *
 * Owner scope: C and C++, compiled locally with the learner's own clang
 * (AddressSanitizer + UBSan on). The SAFETY LAW: only the LEARNER's code
 * ever executes — a test is DATA (stdin in, expected stdout out), never
 * code, so nothing a model writes can run on the learner's machine.
 */

export const CODE_LANGUAGES = ["c", "cpp"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export const CODE_LANGUAGE_LABEL: Record<CodeLanguage, string> = { c: "C", cpp: "C++" };

/** One test case: the program reads `stdin` and must print `expected`. */
export interface CodeTest {
	stdin: string;
	expected: string;
	/** Hidden tests run on submit only and never show their data in the UI. */
	hidden?: boolean;
}

/** A coding exercise as a tool poses it. */
export interface CodeExercise {
	language: CodeLanguage;
	/** What the editor opens with. */
	starterCode?: string;
	tests: CodeTest[];
}

/** POST /api/code/run body. Without `tests`, the program runs once on `stdin`. */
export interface CodeRunRequest {
	language: CodeLanguage;
	source: string;
	tests?: CodeTest[];
	stdin?: string;
}

/** One execution of the compiled program. */
export interface CodeRunCase {
	stdin: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	/** Set when the program died on a signal (a crash, a sanitizer abort). */
	signal?: string;
	timedOut: boolean;
	/** Output cut at the cap. */
	truncated: boolean;
	ms: number;
	/** Present when the case had an expected output. */
	passed?: boolean;
	expected?: string;
	hidden?: boolean;
}

export interface CodeRunResult {
	/** `sanitizers`: what the binary was built with ("address", "undefined"). */
	compile: { ok: boolean; output: string; ms: number; sanitizers?: string[] };
	cases: CodeRunCase[];
}

/** Limits the runner enforces (exported so the UI can say them). */
export const CODE_LIMITS = {
	maxSourceBytes: 100_000,
	maxTests: 50,
	maxStdinBytes: 100_000,
	runTimeoutMs: 3_000,
	compileTimeoutMs: 30_000,
	maxOutputBytes: 64_000,
} as const;

export class CodeRunRequestError extends Error {}

function isLanguage(v: unknown): v is CodeLanguage {
	return typeof v === "string" && (CODE_LANGUAGES as readonly string[]).includes(v);
}

function parseTests(raw: unknown): CodeTest[] {
	if (!Array.isArray(raw)) throw new CodeRunRequestError("tests must be an array");
	if (raw.length > CODE_LIMITS.maxTests) throw new CodeRunRequestError(`at most ${CODE_LIMITS.maxTests} tests`);
	return raw.map((t, i) => {
		const o = t as Record<string, unknown> | null;
		if (!o || typeof o.stdin !== "string" || typeof o.expected !== "string") {
			throw new CodeRunRequestError(`test ${i + 1} needs string stdin and expected`);
		}
		if (o.stdin.length > CODE_LIMITS.maxStdinBytes) throw new CodeRunRequestError(`test ${i + 1}: stdin too large`);
		return { stdin: o.stdin, expected: o.expected, ...(o.hidden === true ? { hidden: true } : {}) };
	});
}

/** Validate a run request body (the route's 400 gate). */
export function parseCodeRunRequest(body: unknown): CodeRunRequest {
	const o = body as Record<string, unknown> | null;
	if (!o || typeof o !== "object") throw new CodeRunRequestError("body must be an object");
	if (!isLanguage(o.language)) throw new CodeRunRequestError(`language must be one of ${CODE_LANGUAGES.join(", ")}`);
	if (typeof o.source !== "string" || !o.source.trim()) throw new CodeRunRequestError("source must be non-empty");
	if (o.source.length > CODE_LIMITS.maxSourceBytes) throw new CodeRunRequestError("source too large");
	const request: CodeRunRequest = { language: o.language, source: o.source };
	if (o.tests !== undefined) request.tests = parseTests(o.tests);
	if (o.stdin !== undefined) {
		if (typeof o.stdin !== "string" || o.stdin.length > CODE_LIMITS.maxStdinBytes) throw new CodeRunRequestError("stdin must be a string within limits");
		request.stdin = o.stdin;
	}
	return request;
}

/** Normalize program output for comparison: CRLF → LF, trailing spaces
 *  on each line and trailing blank lines dropped. */
export function normalizeOutput(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

export function outputsMatch(actual: string, expected: string): boolean {
	return normalizeOutput(actual) === normalizeOutput(expected);
}

/** A run's verdict over its graded cases. */
export function runSummary(result: CodeRunResult): { passed: number; total: number; allPassed: boolean } {
	const graded = result.cases.filter((c) => c.passed !== undefined);
	const passed = graded.filter((c) => c.passed).length;
	return { passed, total: graded.length, allPassed: result.compile.ok && graded.length > 0 && passed === graded.length };
}

/** One case's verdict in words (submission text and the run panel). */
export function caseStatus(c: CodeRunCase): string {
	if (c.timedOut) return "TIMED OUT";
	if (c.signal) return `CRASHED (${c.signal})`;
	if (c.passed === undefined) return `exit ${c.exitCode}`;
	return c.passed ? "PASS" : "FAIL";
}

function fence(lang: string, body: string): string {
	const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
	const ticks = "`".repeat(longest + 1);
	return `${ticks}${lang}\n${body.replace(/\n+$/, "")}\n${ticks}`;
}

/**
 * The learner's submission as the TUTOR reads it (markdown): the code, the
 * compile outcome and every case. Hidden cases show their data too — the
 * tutor authored them; only the learner's view hides them.
 */
export function renderCodeSubmission(language: CodeLanguage, source: string, result: CodeRunResult): string {
	const lines: string[] = [`Code (${CODE_LANGUAGE_LABEL[language]}):`, fence(language, source)];
	if (!result.compile.ok) {
		lines.push("Compilation FAILED:", fence("text", result.compile.output || "(no compiler output)"));
		return lines.join("\n");
	}
	if (result.compile.output.trim()) lines.push("Compiler warnings:", fence("text", result.compile.output));
	const { passed, total } = runSummary(result);
	lines.push(`Tests: ${passed}/${total} passed.`);
	result.cases.forEach((c, i) => {
		const status = caseStatus(c);
		lines.push(`- Test ${i + 1}${c.hidden ? " (hidden)" : ""}: ${status}`);
		if (c.passed === false || c.timedOut || c.signal || (c.exitCode !== 0 && c.exitCode !== null)) {
			lines.push(`  stdin: ${JSON.stringify(c.stdin)}`);
			if (c.expected !== undefined) lines.push(`  expected: ${JSON.stringify(c.expected)}`);
			lines.push(`  got: ${JSON.stringify(c.stdout)}${c.truncated ? " (truncated)" : ""}`);
			if (c.stderr.trim()) lines.push(`  stderr: ${JSON.stringify(c.stderr.slice(0, 2000))}`);
		}
	});
	return lines.join("\n");
}

/** Authoring problems with a posed exercise (the tools' honest 400s —
 *  the model retries on them). Empty = valid. */
export function codeExerciseProblems(exercise: CodeExercise): string[] {
	const problems: string[] = [];
	if (!isLanguage(exercise.language)) problems.push(`code.language must be one of ${CODE_LANGUAGES.join(", ")}`);
	if (!Array.isArray(exercise.tests) || exercise.tests.length === 0) problems.push("code.tests needs at least one test case");
	else if (exercise.tests.length > CODE_LIMITS.maxTests) problems.push(`code.tests allows at most ${CODE_LIMITS.maxTests} cases`);
	else if (exercise.tests.every((t) => t.hidden)) problems.push("code.tests needs at least one VISIBLE test (hidden: false) so the learner can see the expected format");
	return problems;
}
