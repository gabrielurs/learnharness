/**
 * The four coding-exercise kinds (owner, 2026-10-25): write · fix ·
 * predict · fill. Pins the authoring gate (the tool's honest 400s), the
 * tutor's submission text, the fill editor's locked-outside-the-gaps
 * law, and the predict panel's lock → run → send order — the real panel
 * and the real CodeMirror under linkedom.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// ── the DOM CodeMirror needs (linkedom + the few APIs it lacks) ─────────────
const dom = parseHTML("<html><body></body></html>");
const selection = {
	rangeCount: 0,
	anchorNode: null,
	focusNode: null,
	anchorOffset: 0,
	focusOffset: 0,
	addRange() {},
	removeAllRanges() {},
	getRangeAt: () => null,
	collapse() {},
	extend() {},
	setBaseAndExtent() {},
};
const storage = new Map<string, string>();
// Layout reads CodeMirror's measure loop makes (no layout in linkedom).
const elementProto = dom.window.Element.prototype as unknown as Record<string, unknown>;
elementProto.getClientRects = () => [];
elementProto.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
Object.assign(dom.document, {
	getSelection: () => selection,
	hasFocus: () => false,
	createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }) }),
});
Object.assign(dom.window, {
	getSelection: () => selection,
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.assign(globalThis, {
	window: dom.window,
	// CodeMirror only asks `instanceof Window`; linkedom has no Window class.
	Window: class {},
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	MutationObserver: dom.window.MutationObserver,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	// Frames never fire: CodeMirror's measure loop needs real layout, and
	// these tests drive state, not geometry.
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node", platform: "MacIntel", language: "en" }, configurable: true });

const code = await import("../src/core/contracts/code.ts");
const { CODE_HOLE, codeExerciseProblems, exerciseKind, renderExerciseSubmission, splitHoles } = code;
type CodeExercise = import("../src/core/contracts/code.ts").CodeExercise;
type CodeRunResult = import("../src/core/contracts/code.ts").CodeRunResult;
type CodeSubmission = import("../src/core/contracts/code.ts").CodeSubmission;
const { codeHoles, holeRanges, moveToHole } = await import("../components/code-holes.ts");
const { problemInputObject } = await import("../src/agent/tools/practice.ts");
const { CodeExercisePanel } = await import("../components/code-exercise.tsx");

const TEST = { stdin: "", expected: "1" };
const ran = (stdout: string, over: Partial<CodeRunResult["cases"][number]> = {}): CodeRunResult => ({
	compile: { ok: true, output: "", ms: 5 },
	cases: [{ stdin: "3", stdout, stderr: "", exitCode: 0, timedOut: false, truncated: false, ms: 1, ...over }],
});

describe("exercise kinds: the authoring gate", () => {
	it("absent kind reads as write; an unknown kind is rejected", () => {
		assert.equal(exerciseKind({}), "write");
		assert.deepEqual(codeExerciseProblems({ language: "c", tests: [TEST] }), []);
		assert.match(codeExerciseProblems({ language: "c", kind: "golf" as never, tests: [TEST] })[0]!, /code\.kind must be one of/);
	});

	it("fix needs the buggy program; fill needs at least one gap; both need tests", () => {
		assert.match(codeExerciseProblems({ language: "c", kind: "fix", tests: [TEST] }).join(), /REQUIRED for fix/);
		assert.deepEqual(codeExerciseProblems({ language: "c", kind: "fix", starterCode: "int main(){return 2;}", tests: [TEST] }), []);
		assert.match(codeExerciseProblems({ language: "c", kind: "fill", starterCode: "int main(){}", tests: [TEST] }).join(), /hole marker/);
		assert.deepEqual(codeExerciseProblems({ language: "c", kind: "fill", starterCode: `int main(){return ${CODE_HOLE};}`, tests: [TEST] }), []);
		assert.match(codeExerciseProblems({ language: "c", kind: "fill", starterCode: `x${CODE_HOLE}` }).join(), /at least one test/);
		assert.match(codeExerciseProblems({ language: "c", kind: "fill", starterCode: `x = ${CODE_HOLE}${CODE_HOLE};`, tests: [TEST] }).join(), /separated by code/);
	});

	it("predict needs the program, takes no tests, and only predict takes stdin", () => {
		assert.deepEqual(codeExerciseProblems({ language: "c", kind: "predict", starterCode: "int main(){}", stdin: "3" }), []);
		assert.match(codeExerciseProblems({ language: "c", kind: "predict" }).join(), /REQUIRED for predict/);
		assert.match(codeExerciseProblems({ language: "c", kind: "predict", starterCode: "x", tests: [TEST] }).join(), /must be omitted for predict/);
		assert.match(codeExerciseProblems({ language: "c", stdin: "3", tests: [TEST] }).join(), /only for predict/);
	});

	it("the problem schema accepts a predict without tests and rejects an unknown kind", () => {
		const tool = { name: "problem", description: "", parameters: problemInputObject };
		const base = { statement: "s", mode: "recall", modelSolution: "6\n(3*2)" };
		validateToolArguments(tool, { type: "toolCall", id: "c1", name: "problem", arguments: { ...base, code: { language: "c", kind: "predict", starterCode: "int main(){}", stdin: "3" } } });
		assert.throws(() =>
			validateToolArguments(tool, { type: "toolCall", id: "c2", name: "problem", arguments: { ...base, code: { language: "c", kind: "golf", tests: [TEST] } } }),
		);
	});

	it("splitHoles drops each marker and records its offset", () => {
		assert.deepEqual(splitHoles(`a${CODE_HOLE}bc${CODE_HOLE}`), { doc: "abc", holes: [1, 3] });
		assert.deepEqual(splitHoles("none"), { doc: "none", holes: [] });
	});
});

describe("exercise kinds: what the tutor reads", () => {
	const predict: CodeExercise = { language: "c", kind: "predict", starterCode: "P", stdin: "3" };

	it("predict, not run: program, stdin, the locked prediction, and that it was not run", () => {
		const text = renderExerciseSubmission(predict, { source: "P", result: null, prediction: "6" });
		assert.match(text, /^Code \(C\):\n```c\nP\n```/, "the header the transcript card keys on");
		assert.match(text, /stdin:\n```text\n3\n```/);
		assert.match(text, /Predicted output \(locked before any run\):\n```text\n6\n```/);
		assert.match(text, /Not run/);
	});

	it("predict, run: the actual output and the comparison", () => {
		assert.match(renderExerciseSubmission(predict, { source: "P", result: ran("6\n"), prediction: "6" }), /actual output \(exit 0\):\n```text\n6\n```[\s\S]*matches the actual output: yes/);
		assert.match(renderExerciseSubmission(predict, { source: "P", result: ran("7\n"), prediction: "6" }), /matches the actual output: no/);
		assert.match(renderExerciseSubmission(predict, { source: "P", result: { compile: { ok: false, output: "err", ms: 1 }, cases: [] }, prediction: "6" }), /compilation FAILED/);
	});

	it("the other kinds read exactly as before", () => {
		const result = ran("1\n", { expected: "1", passed: true });
		const exercise: CodeExercise = { language: "c", kind: "fix", starterCode: "x", tests: [TEST] };
		assert.equal(renderExerciseSubmission(exercise, { source: "S", result }), code.renderCodeSubmission("c", "S", result));
	});
});

describe("fill editing: only the gaps change", () => {
	const make = () => {
		const { doc, holes } = splitHoles(`int x = ${CODE_HOLE};\nint y = ${CODE_HOLE};`);
		return EditorState.create({ doc, extensions: codeHoles(holes) });
	};

	it("typing into an empty gap grows it; edits outside every gap are dropped", () => {
		let state = make();
		const [first] = holeRanges(state);
		state = state.update({ changes: { from: first!.from, insert: "42" } }).state;
		assert.equal(state.doc.line(1).text, "int x = 42;");
		assert.deepEqual(holeRanges(state)[0], { from: first!.from, to: first!.from + 2 }, "the gap now spans what was typed");
		const before = state.doc.toString();
		state = state.update({ changes: { from: 0, to: 3, insert: "long" } }).state;
		assert.equal(state.doc.toString(), before, "the locked code did not change");
		assert.equal(state.update({ changes: { from: 0, insert: "//" } }).state.doc.toString(), before, "nor an insertion at the start");
		assert.equal(state.update({ changes: { from: before.length, insert: "x" } }).state.doc.toString(), before, "nor at the end");
		state = state.update({ changes: { from: first!.from, to: first!.from + 2, insert: "7" } }).state;
		assert.equal(state.doc.line(1).text, "int x = 7;", "replacing inside a gap is fine");
	});

	it("a transaction touching locked code keeps its in-gap part (the reindent-on-} case)", () => {
		let state = make();
		const [first] = holeRanges(state);
		state = state.update({ changes: [{ from: first!.from, insert: "9" }, { from: 0, to: 3, insert: "" }] }).state;
		assert.equal(state.doc.line(1).text, "int x = 9;", "the keystroke landed; the locked edit was dropped");
	});

	it("Tab selects the next gap whole, Shift-Tab the previous, wrapping", () => {
		let state = make();
		const view = {
			get state() {
				return state;
			},
			dispatch: (tr: { selection: EditorSelection }) => {
				state = state.update({ selection: tr.selection }).state;
			},
		};
		const [a, b] = holeRanges(state);
		assert.ok(moveToHole(view, 1));
		assert.equal(state.selection.main.from, a!.from);
		moveToHole(view, 1);
		assert.equal(state.selection.main.from, b!.from);
		moveToHole(view, 1);
		assert.equal(state.selection.main.from, a!.from, "wraps to the first");
		moveToHole(view, -1);
		assert.equal(state.selection.main.from, b!.from);
	});
});

// ── the real panel ──────────────────────────────────────────────────────────
const posts: unknown[] = [];
let reply: CodeRunResult = ran("6\n");
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
	posts.push(JSON.parse(String(init?.body)));
	return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let root: Root | null = null;
let host: HTMLElement | null = null;
const submissions: CodeSubmission[] = [];
async function mount(exercise: CodeExercise, draftKey = "k1") {
	host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<CodeExercisePanel exercise={exercise} draftKey={draftKey} onSubmit={(s) => void submissions.push(s)} />));
}
const $ = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const props = (el: Element) => (el as unknown as Record<string, Record<string, (...a: unknown[]) => void>>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!]!;
const click = (id: string) => act(async () => props($(id)!).onClick!({}));
const type = (id: string, value: string) => act(async () => props($(id)!).onChange!({ target: { value } }));
const editorView = () => EditorView.findFromDOM(host!.querySelector(".cm-editor") as HTMLElement)!;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

beforeEach(() => {
	posts.length = 0;
	submissions.length = 0;
	storage.clear();
	reply = ran("6\n");
});
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});

describe("predict panel: lock, then (optionally) run, then send", () => {
	const exercise: CodeExercise = { language: "c", kind: "predict", starterCode: 'int main(){printf("%d\\n", 3*2);}', stdin: "3" };

	it("Run is unavailable until the prediction is locked; the code is read-only", async () => {
		await mount(exercise);
		assert.equal($("code-run"), null, "no Run before locking");
		assert.equal($("code-submit"), null, "no Send before locking");
		assert.ok($("code-lock")!.hasAttribute("disabled"), "nothing to lock yet");
		assert.equal(editorView().state.readOnly, true);
	});

	it("lock → run on the exercise stdin → verdict → send carries prediction + run", async () => {
		await mount(exercise);
		await type("code-prediction", "6");
		await click("code-lock");
		assert.ok($("code-prediction")!.hasAttribute("disabled"), "the prediction is locked");
		await click("code-run");
		await settle();
		assert.deepEqual(posts.at(-1), { language: "c", source: exercise.starterCode, stdin: "3" }, "runs the shown program on its stdin, no tests");
		assert.match($("code-prediction-verdict")!.textContent!, /matches/);
		await click("code-submit");
		await settle();
		assert.equal(submissions.length, 1);
		assert.equal(submissions[0]!.prediction, "6");
		assert.equal(submissions[0]!.result?.cases[0]?.stdout, "6\n");
	});

	it("sending without running carries no run", async () => {
		await mount(exercise);
		await type("code-prediction", "5");
		await click("code-lock");
		await click("code-submit");
		await settle();
		assert.equal(posts.length, 0, "nothing executed");
		assert.equal(submissions[0]!.result, null);
	});

	it("a reload keeps the prediction locked (seeing the output never rewrites it)", async () => {
		await mount(exercise, "reload");
		await type("code-prediction", "6");
		await click("code-lock");
		await act(async () => root!.unmount());
		host!.remove();
		await mount(exercise, "reload");
		assert.equal((props($("code-prediction")!) as unknown as { value: string }).value, "6");
		assert.ok($("code-prediction")!.hasAttribute("disabled"));
		assert.ok($("code-run"), "Run stays available");
	});
});

describe("fill panel: gaps only, and the draft keeps them", () => {
	const exercise: CodeExercise = { language: "c", kind: "fill", starterCode: `int main(){ return ${CODE_HOLE}; }`, tests: [{ stdin: "", expected: "" }] };

	it("the editor opens without markers; typing outside the gap does nothing; submit runs every test", async () => {
		await mount(exercise);
		const view = editorView();
		assert.equal(view.state.doc.toString(), "int main(){ return ; }");
		const gap = holeRanges(view.state)[0]!;
		await act(async () => view.dispatch({ changes: { from: 0, insert: "//" } }));
		assert.equal(view.state.doc.toString(), "int main(){ return ; }", "locked outside the gap");
		await act(async () => view.dispatch({ changes: { from: gap.from, insert: "0" } }));
		assert.equal(view.state.doc.toString(), "int main(){ return 0; }");
		reply = { compile: { ok: true, output: "", ms: 1 }, cases: [{ stdin: "", stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, ms: 1, expected: "", passed: true }] };
		await click("code-submit");
		await settle();
		assert.deepEqual(posts.at(-1), { language: "c", source: "int main(){ return 0; }", tests: exercise.tests });
		assert.equal(submissions[0]!.source, "int main(){ return 0; }");
	});

	it("a remount restores the filled gap AND its range", async () => {
		await mount(exercise, "fill-draft");
		const view = editorView();
		const gap = holeRanges(view.state)[0]!;
		await act(async () => view.dispatch({ changes: { from: gap.from, insert: "1+1" } }));
		await act(async () => root!.unmount());
		host!.remove();
		await mount(exercise, "fill-draft");
		const again = editorView();
		assert.equal(again.state.doc.toString(), "int main(){ return 1+1; }");
		assert.deepEqual(holeRanges(again.state)[0], { from: gap.from, to: gap.from + 3 });
	});
});
