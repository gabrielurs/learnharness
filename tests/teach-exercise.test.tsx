/**
 * The teacher's coding exercise (owner, 2026-10-25): an always-armed teach
 * question whose answer is code. Pins the tool boundary (schema, kind
 * validation, the commitment, nodeId), the question pipeline treating it
 * like its siblings (pending gate, plan position, phase seam, learner
 * cause, the session-markdown export), and the dock → answer → card path with the
 * real CodeMirror under linkedom. Runs under its own LH_DATA_DIR (set
 * before any config-loading import — every app import is dynamic).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Value } from "typebox/value";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-teach-exercise-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

// ── the DOM CodeMirror needs (see tests/code-exercise-kinds.test.tsx) ───────
const dom = parseHTML("<html><body></body></html>");
const selection = { rangeCount: 0, anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0, addRange() {}, removeAllRanges() {}, getRangeAt: () => null, collapse() {}, extend() {}, setBaseAndExtent() {} };
const storage = new Map<string, string>();
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
	localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
});
Object.assign(globalThis, {
	window: dom.window,
	Window: class {},
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	MutationObserver: dom.window.MutationObserver,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node", platform: "MacIntel", language: "en" }, configurable: true });

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createTeacherTools, createProberTools, exerciseExampleBody, teachExerciseToolFor } = await import("../src/agent/tools.ts");
const { QUESTION_TOOLS, toolQuestionKind } = await import("../src/core/pending.ts");
const { exerciseInputObject, exerciseInputProblems, buildAnswer, compactAnswerForModel, questionNeedsReveal } = await import("../src/core/question-core.ts");
const { parseExerciseInput } = await import("../src/core/tool-parts.ts");
const { danglingQuestionOf, newAnswerResult, nativeInputCause } = await import("../src/core/native-messages.ts");
const { derivePlanStatusesLh } = await import("../src/core/contracts/plan.ts");
const { phaseAt3Lh } = await import("../src/core/phases.ts");
const { messageMarkdown } = await import("../src/core/session-markdown.ts");
const { ExerciseDockForm } = await import("../components/exercise-dock.tsx");
const { AnsweredCard } = await import("../components/answered-card.tsx");
type QuestionAnswerData = import("../src/core/question-core.ts").QuestionAnswerData;

const stamps = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
};
const call = (id: string, name: string, args: unknown) => ({ id: `msg_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 1, ...stamps });

const valid = { ...exerciseExampleBody, nodeId: "arith" };
async function boundary(chatId: string, input: unknown): Promise<{ ok: boolean; problems: string[] }> {
	const tool = teachExerciseToolFor({ chatId, chatStore });
	if (!Value.Check(tool.parameters, input)) return { ok: false, problems: ["schema"] };
	const result = (await tool.execute("tc", input as never)) as { isError?: boolean; details?: { problems?: string[] } };
	return { ok: !result.isError, problems: result.details?.problems ?? [] };
}
function chatWithTree(): string {
	const chat = chatStore.createChat("exercise");
	chatStore.saveTree(chat.id, { nodes: [{ id: "arith", title: "Arithmetic" }], edges: [], version: 1 });
	return chat.id;
}

describe("the exercise tool: always armed in teaching, never in probing", () => {
	it("teach registry carries it under both quizzing mechanics; the prober never does", () => {
		const ctx = { chatId: "c", chatStore, jobStore, spawn: () => {} };
		assert.ok(createTeacherTools(ctx).exercise);
		assert.ok(createTeacherTools(ctx, { explain: true }).exercise);
		assert.equal(createProberTools({ ...ctx, deliver: () => {} } as never).exercise, undefined);
	});

	it("the description's example is a valid call (schema + authoring contract)", () => {
		assert.ok(Value.Check(exerciseInputObject, exerciseExampleBody));
		assert.deepEqual(exerciseInputProblems(exerciseExampleBody), []);
	});

	it("accepts a well-formed exercise on a mapped node", async () => {
		assert.deepEqual(await boundary(chatWithTree(), valid), { ok: true, problems: [] });
	});

	it("rejects: an off-map node, an empty commitment, a kind's missing part", async () => {
		const id = chatWithTree();
		assert.match((await boundary(id, { ...valid, nodeId: "nope" })).problems.join(), /matches no node/);
		assert.match((await boundary(id, { ...valid, modelSolution: "  " })).problems.join(), /modelSolution is required/);
		assert.match((await boundary(id, { ...valid, code: { language: "c", kind: "fill", starterCode: "x", tests: [{ stdin: "", expected: "" }] } })).problems.join(), /hole marker/);
		assert.equal((await boundary(id, { ...valid, code: { language: "c", kind: "golf" } })).ok, false, "unknown kind fails the schema");
	});
});

describe("the exercise rides the question pipeline like its siblings", () => {
	const args = { ...valid, nodeId: "arith" };
	const messages = [call("tc1", "exercise", args)] as never[];

	it("is a question tool of its own kind; a posed one gates as pending", () => {
		assert.ok((QUESTION_TOOLS as readonly string[]).includes("exercise"));
		assert.equal(toolQuestionKind("exercise"), "exercise");
		assert.equal(danglingQuestionOf(messages)?.tool, "exercise");
	});

	it("moves the plan position and opens the teach phase, like quiz/explain", () => {
		const tree = { nodes: [{ id: "arith", title: "A" }, { id: "other", title: "B" }], edges: [], version: 1 };
		assert.equal(derivePlanStatusesLh(tree as never, messages).current, "arith");
		const planned = [{ id: "r0", role: "toolResult", toolCallId: "p0", toolName: "probe_done", content: [], isError: false, timestamp: 0 }, ...messages] as never[];
		assert.equal(phaseAt3Lh(planned), "teach");
	});

	it("a check-type exercise collapses behind the reveal; a predict-type one never does", () => {
		assert.equal(questionNeedsReveal("exercise", { type: "check" }, "teach"), true);
		assert.equal(questionNeedsReveal("exercise", { type: "predict" }, "teach"), false);
	});

	it("the answer: the submission is the text, the commitment snapshots, the model reads the text", () => {
		const parsed = parseExerciseInput(args)!;
		assert.ok(parsed, "the display parse accepts it");
		const qd = { id: "tc1", kind: "exercise" as const, question: parsed.question, mode: "text" as const, options: [], committedAnswer: parsed.modelSolution, createdAt: "t" };
		const answer = buildAnswer(qd, { text: "Code (C):\n```c\nx\n```", thinking: "I traced it" }, "exercise");
		assert.equal(answer.committed, parsed.modelSolution);
		assert.deepEqual(compactAnswerForModel(answer), { kind: "exercise", text: "Code (C):\n```c\nx\n```", thinking: "I traced it" });
		// …and the server reads it as the LEARNER's input (a foreground turn).
		const result = newAnswerResult("tc1", "exercise", answer);
		assert.equal(nativeInputCause(result as never, messages as never), "learner");
		// …and the session-markdown export shows the submission.
		const md = messageMarkdown(result as never, "m1", false)!;
		assert.match(md, /^### Exercise/);
		assert.match(md, /The learner's submission:/);
		assert.match(md, /his thinking: I traced it/);
	});
});

// ── the dock and the card ───────────────────────────────────────────────────
globalThis.fetch = (async () =>
	new Response(JSON.stringify({ compile: { ok: true, output: "", ms: 1 }, cases: [{ stdin: "", stdout: "3 1\n", stderr: "", exitCode: 0, timedOut: false, truncated: false, ms: 1 }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	})) as typeof fetch;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
const $ = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const props = (el: Element) => (el as unknown as Record<string, Record<string, (...a: unknown[]) => void>>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!]!;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

describe("the exercise dock: submit = the graded answer", () => {
	it("the thinking survives under the draft key — the exercise re-posed after an ask gets it back", async () => {
		const input = parseExerciseInput(valid)!;
		host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<ExerciseDockForm toolCallId="tc-a" input={input} onSubmit={() => {}} />));
		await act(async () => props(host!.querySelector("[data-testid='exercise-thinking-field'] textarea")!).onChange!({ target: { value: "a/b truncates" } }));
		assert.equal(storage.get("lh-code-thinking:tc-a"), "a/b truncates", "kept under the draft key");
		await act(async () => root!.unmount());
		// The teacher poses it again as tc-b; exerciseDraftKey hands it tc-a's key.
		root = createRoot(host);
		await act(async () => root!.render(<ExerciseDockForm toolCallId="tc-b" draftKey="tc-a" input={input} onSubmit={() => {}} />));
		assert.equal((props(host!.querySelector("[data-testid='exercise-thinking-field'] textarea")!) as unknown as { value: string }).value, "a/b truncates");
		storage.delete("lh-code-thinking:tc-a");
	});

	it("predict: lock → run → submit sends kind exercise with the submission, the thinking and the commitment", async () => {
		const sent: QuestionAnswerData[] = [];
		host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		root = createRoot(host);
		const input = parseExerciseInput(valid)!;
		await act(async () => root!.render(<ExerciseDockForm toolCallId="tc-dock" input={input} onSubmit={(a) => void sent.push(a)} />));
		assert.equal($("exercise-dock")!.getAttribute("data-kind"), "predict");
		await act(async () => props(host!.querySelector("[data-testid='exercise-thinking-field'] textarea")!).onChange!({ target: { value: "a/b truncates" } }));
		await act(async () => props($("code-prediction")!).onChange!({ target: { value: "3 1" } }));
		await act(async () => props($("code-lock")!).onClick!({}));
		await act(async () => props($("code-run")!).onClick!({}));
		await settle();
		await act(async () => props($("code-submit")!).onClick!({}));
		await settle();
		assert.equal(sent.length, 1);
		const answer = sent[0]!;
		assert.equal(answer.kind, "exercise");
		assert.equal(answer.tool, "exercise");
		assert.equal(answer.thinking, "a/b truncates");
		assert.equal(answer.committed, valid.modelSolution);
		assert.match(answer.text!, /Predicted output \(locked before any run\):\n```text\n3 1\n```/);
		assert.match(answer.text!, /matches the actual output: yes/);
	});

	it("the answered card: Exercise label, the submission as code, the model solution", () => {
		const html = renderToStaticMarkup(
			<AnsweredCard
				answer={{ kind: "exercise", tool: "exercise", questionText: "What does it print?", dontKnow: false, answers: [], text: "Code (C):\n```c\nint x;\n```", committed: "3 1", answeredAt: "t" }}
			/>,
		);
		assert.match(html, /Exercise/);
		assert.match(html, /data-testid="exercise-submission"/);
		assert.match(html, /data-testid="exercise-solution"/);
		assert.doesNotMatch(html, /“Code \(C\)/, "never the quoted plain-text answer");
	});
});
