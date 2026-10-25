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

/** The four exercise kinds (owner, 2026-10-25) — absent reads as write
 *  (exercises posed before the field):
 *    write    an editor, an optional skeleton, tests to pass;
 *    fix      starterCode carries the bug — repair it until the tests pass;
 *    predict  starterCode is read-only; the learner locks a prediction of
 *             its output on `stdin`, then MAY run it (only on his click);
 *    fill     starterCode marks holes with CODE_HOLE — only they edit. */
export const CODE_EXERCISE_KINDS = ["write", "fix", "predict", "fill"] as const;
export type CodeExerciseKind = (typeof CODE_EXERCISE_KINDS)[number];

export const CODE_KIND_LABEL: Record<CodeExerciseKind, string> = {
	write: "Write",
	fix: "Fix",
	predict: "Predict the output",
	fill: "Fill the gaps",
};

/** A hole in a fill exercise's starterCode — a C comment, so the starter
 *  still highlights as code before the editor swaps it for a gap. */
export const CODE_HOLE = "/*__*/";

/** A coding exercise as a tool poses it. */
export interface CodeExercise {
	language: CodeLanguage;
	kind?: CodeExerciseKind;
	/** What the editor opens with (required for fix, predict and fill). */
	starterCode?: string;
	/** write/fix/fill: the graded cases. predict: none. */
	tests?: CodeTest[];
	/** predict: the program's standard input (absent = none). */
	stdin?: string;
}

export function exerciseKind(exercise: Pick<CodeExercise, "kind">): CodeExerciseKind {
	return exercise.kind && (CODE_EXERCISE_KINDS as readonly string[]).includes(exercise.kind) ? exercise.kind : "write";
}

export function exerciseTests(exercise: Pick<CodeExercise, "tests">): CodeTest[] {
	return Array.isArray(exercise.tests) ? exercise.tests : [];
}

/** A fill starter → the editor's document (markers removed) and each
 *  hole's offset in it. */
export function splitHoles(starter: string): { doc: string; holes: number[] } {
	const parts = starter.split(CODE_HOLE);
	const holes: number[] = [];
	let doc = parts[0]!;
	for (const part of parts.slice(1)) {
		holes.push(doc.length);
		doc += part;
	}
	return { doc, holes };
}

/** What the learner hands in: the source, the run the tutor reads (null
 *  when a predict was sent without running) and, for predict, the
 *  prediction locked before any run. */
export interface CodeSubmission {
	source: string;
	result: CodeRunResult | null;
	prediction?: string;
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

/** POST /api/code/complete and /api/code/diagnostics bodies (clangd, owner
 *  2026-10-25): the editor's whole document under a stable id, and for
 *  completion the caret's offset (UTF-16, as JS strings and LSP count). */
export interface CodeAssistRequest {
	docId: string;
	language: CodeLanguage;
	source: string;
	offset?: number;
}

/** One completion as the editor applies it: replace [from, to) with
 *  `insert` — an LSP snippet (`${1:arg}`, `$0`) when `snippet`. */
export interface CodeCompletion {
	label: string;
	detail?: string;
	/** LSP CompletionItemKind. */
	kind?: number;
	insert: string;
	snippet: boolean;
	from: number;
	to: number;
}

export interface CodeDiagnostic {
	from: number;
	to: number;
	severity: "error" | "warning" | "info";
	message: string;
}

/** `available: false` — no clangd on this machine; the editor stops asking. */
export type CodeCompletionResult = { available: boolean; items: CodeCompletion[] };
export type CodeDiagnosticsResult = { available: boolean; diagnostics: CodeDiagnostic[] };

/** Validate an assist body (the routes' 400 gate). `withOffset`: completion. */
export function parseCodeAssistRequest(body: unknown, withOffset: boolean): CodeAssistRequest {
	const o = body as Record<string, unknown> | null;
	if (!o || typeof o !== "object") throw new CodeRunRequestError("body must be an object");
	if (typeof o.docId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(o.docId)) throw new CodeRunRequestError("docId must be 1-100 letters, digits, _ or -");
	if (!isLanguage(o.language)) throw new CodeRunRequestError(`language must be one of ${CODE_LANGUAGES.join(", ")}`);
	if (typeof o.source !== "string" || o.source.length > CODE_LIMITS.maxSourceBytes) throw new CodeRunRequestError("source must be a string within limits");
	const request: CodeAssistRequest = { docId: o.docId, language: o.language, source: o.source };
	if (withOffset) {
		if (typeof o.offset !== "number" || !Number.isInteger(o.offset) || o.offset < 0 || o.offset > o.source.length) {
			throw new CodeRunRequestError("offset must be an integer position inside source");
		}
		request.offset = o.offset;
	}
	return request;
}

/** Offset → LSP position (0-based line, UTF-16 character). */
export function offsetToPosition(source: string, offset: number): { line: number; character: number } {
	const before = source.slice(0, offset);
	const line = before.split("\n").length - 1;
	return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

/** LSP position → offset, clamped into the source. */
export function positionToOffset(source: string, position: { line: number; character: number }): number {
	let offset = 0;
	for (let line = 0; line < position.line; line++) {
		const next = source.indexOf("\n", offset);
		if (next === -1) return source.length;
		offset = next + 1;
	}
	const lineEnd = source.indexOf("\n", offset);
	return Math.min(offset + Math.max(0, position.character), lineEnd === -1 ? source.length : lineEnd);
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
	if (exercise.kind !== undefined && !(CODE_EXERCISE_KINDS as readonly string[]).includes(exercise.kind)) {
		problems.push(`code.kind must be one of ${CODE_EXERCISE_KINDS.join(", ")}`);
		return problems;
	}
	const kind = exerciseKind(exercise);
	const starter = typeof exercise.starterCode === "string" ? exercise.starterCode : "";
	if (kind === "predict") {
		if (!starter.trim()) problems.push("code.starterCode is REQUIRED for predict: the complete program the learner reads");
		if (exercise.tests !== undefined && exerciseTests(exercise).length > 0) {
			problems.push("code.tests must be omitted for predict: the learner predicts the output, and your modelSolution holds the exact expected output");
		}
		if (exercise.stdin !== undefined && (typeof exercise.stdin !== "string" || exercise.stdin.length > CODE_LIMITS.maxStdinBytes)) {
			problems.push("code.stdin must be a string within limits");
		}
		return problems;
	}
	if (exercise.stdin !== undefined) problems.push("code.stdin is only for predict — the other kinds feed input through tests");
	if (kind === "fix" && !starter.trim()) problems.push("code.starterCode is REQUIRED for fix: the program with the bug to repair");
	if (kind === "fill" && !starter.includes(CODE_HOLE)) problems.push(`code.starterCode for fill needs at least one ${CODE_HOLE} hole marker`);
	// Two gaps touching would sit at one position and grow together.
	if (kind === "fill" && starter.includes(CODE_HOLE + CODE_HOLE)) problems.push(`code.starterCode for fill: two ${CODE_HOLE} gaps must be separated by code`);
	if (!Array.isArray(exercise.tests) || exercise.tests.length === 0) problems.push("code.tests needs at least one test case");
	else if (exercise.tests.length > CODE_LIMITS.maxTests) problems.push(`code.tests allows at most ${CODE_LIMITS.maxTests} cases`);
	else if (exercise.tests.every((t) => t.hidden)) problems.push("code.tests needs at least one VISIBLE test (hidden: false) so the learner can see the expected format");
	return problems;
}

/**
 * Any submission as the TUTOR reads it. write/fix/fill: the code and its
 * test run (renderCodeSubmission). predict: the program, the prediction
 * the learner LOCKED before running anything, then the real output if he
 * chose to run it — compared for the tutor, who still grades against the
 * output committed in modelSolution.
 */
export function renderExerciseSubmission(exercise: CodeExercise, submission: CodeSubmission): string {
	if (exerciseKind(exercise) !== "predict") {
		const result = submission.result ?? { compile: { ok: false, output: "(the submission carried no run)", ms: 0 }, cases: [] };
		return renderCodeSubmission(exercise.language, submission.source, result);
	}
	const lines: string[] = [`Code (${CODE_LANGUAGE_LABEL[exercise.language]}):`, fence(exercise.language, submission.source)];
	if (exercise.stdin) lines.push("stdin:", fence("text", exercise.stdin));
	lines.push("Predicted output (locked before any run):", fence("text", submission.prediction ?? ""));
	const result = submission.result;
	if (!result) {
		lines.push("Not run — the learner sent the prediction without running the code.");
		return lines.join("\n");
	}
	if (!result.compile.ok) {
		lines.push("The learner ran it — compilation FAILED:", fence("text", result.compile.output || "(no compiler output)"));
		return lines.join("\n");
	}
	const run = result.cases[0];
	if (!run) {
		lines.push("The learner ran it — no output was captured.");
		return lines.join("\n");
	}
	const status = caseStatus(run);
	lines.push(`The learner ran it — actual output (${status}):`, fence("text", run.stdout + (run.truncated ? "\n(truncated)" : "")));
	if (run.stderr.trim()) lines.push("stderr:", fence("text", run.stderr.slice(0, 2000)));
	lines.push(`Prediction matches the actual output: ${outputsMatch(run.stdout, submission.prediction ?? "") ? "yes" : "no"}.`);
	return lines.join("\n");
}
