/**
 * Three fixes around the coding editor (audit, 2026-10-25), on the real
 * components under linkedom:
 *   - the editor keeps Tab / Shift-Tab / Esc: the window shortcut layer
 *     never also acts on them;
 *   - a practice submit finishes a live dictation first, so the dictated
 *     tail rides the submission;
 *   - a collapsed practice dock keeps its code panel mounted (results and
 *     undo survive scrolling).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const selection = { rangeCount: 0, anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0, addRange() {}, removeAllRanges() {}, getRangeAt: () => null, collapse() {}, extend() {}, setBaseAndExtent() {} };
const elementProto = dom.window.Element.prototype as unknown as Record<string, unknown>;
elementProto.getClientRects = () => [];
elementProto.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
Object.assign(dom.document, {
	getSelection: () => selection,
	hasFocus: () => false,
	createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }) }),
});
Object.assign(dom.window, { getSelection: () => selection, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
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
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
});

// A scripted Web Speech recognizer + mic, as in tests/dictation-honest-dot.
class FakeRecognition {
	static last: FakeRecognition | null = null;
	lang = "";
	continuous = false;
	interimResults = false;
	onaudiostart: (() => void) | null = null;
	onstart: (() => void) | null = null;
	onresult: ((ev: unknown) => void) | null = null;
	onerror: (() => void) | null = null;
	onend: (() => void) | null = null;
	constructor() {
		FakeRecognition.last = this;
	}
	start() {}
	stop() {
		// The browser delivers the last finals, then ends — asynchronously.
		setTimeout(() => this.onend?.(), 1);
	}
	abort() {}
}
class FakeAudioContext {
	state = "running";
	audioWorklet = { addModule: async () => {} };
	destination = {};
	async resume() {}
	async suspend() {}
	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}
}
Object.assign(dom.window, { webkitSpeechRecognition: FakeRecognition });
Object.assign(globalThis, { AudioContext: FakeAudioContext, AudioWorkletNode: class { port = {}; connect() {} disconnect() {} } });
Object.defineProperty(globalThis, "navigator", {
	value: { userAgent: "node", platform: "MacIntel", language: "es-ES", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
	configurable: true,
});

const { CodeEditor } = await import("../components/code-editor.tsx");
const { PracticeDock } = await import("../components/practice-dock.tsx");
const { useDictation } = await import("../components/dictation.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
async function mount(node: React.ReactNode) {
	host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
}
const props = (el: Element) => (el as unknown as Record<string, Record<string, (...a: unknown[]) => void>>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!]!;

describe("the editor keeps its keys", () => {
	it("Tab and Escape never reach the window's shortcut layer; other keys still do", async () => {
		await mount(<CodeEditor initial="int x;" onChange={() => {}} />);
		const seen: string[] = [];
		const onKey = (e: Event) => seen.push((e as KeyboardEvent).key);
		dom.window.addEventListener("keydown", onKey);
		try {
			const content = host!.querySelector(".cm-content")!;
			for (const key of ["Escape", "Tab", "a"]) {
				const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(ev, "key", { value: key });
				content.dispatchEvent(ev);
			}
		} finally {
			dom.window.removeEventListener("keydown", onKey);
		}
		assert.deepEqual(seen, ["a"]);
	});
});

describe("practice submit finishes a live dictation first", () => {
	it("the dictated tail rides the submission", async () => {
		const sent: string[] = [];
		let dictation: ReturnType<typeof useDictation> | null = null;
		function Page() {
			dictation = useDictation({ append: () => {} });
			return (
				<PracticeDock problemCallId="p1" input={{ statement: "Explain." }} expanded onExpand={() => {}} onSubmit={(t) => void sent.push(t)} />
			);
		}
		await mount(<Page />);
		const field = host!.querySelector("[data-testid='practice-thinking-field'] textarea")!;
		await act(async () => props(field).onChange!({ target: { value: "typed part" } }));
		await act(async () => dictation!.toggle());
		await act(async () => FakeRecognition.last!.onaudiostart?.());
		await act(async () => FakeRecognition.last!.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "and the spoken tail" } }] }));
		await act(async () => props(host!.querySelector("[data-testid='practice-send']")!).onClick!({}));
		await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
		assert.deepEqual(sent, ["typed part and the spoken tail"]);
	});
});

describe("a collapsed practice dock keeps its code panel", () => {
	it("bar shown, the form (with the panel) mounted but hidden", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="p2"
				input={{ statement: "Sum.", code: { language: "c", tests: [{ stdin: "", expected: "1" }] } }}
				expanded={false}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		assert.match(html, /data-testid="practice-dock-bar"/);
		assert.match(html, /data-testid="practice-dock"[^>]*class="invisible h-0 overflow-hidden"/);
		assert.match(html, /data-testid="code-exercise"/);
	});
});

describe("an expanded practice dock never outgrows the column", () => {
	it("the whole dock is capped; statement + code scroll together; the thinking field stays pinned", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="p3"
				input={{ statement: "Sum two numbers.", code: { language: "c", tests: [{ stdin: "1 2", expected: "3" }] } }}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		const { document } = parseHTML(html);
		const dock = document.querySelector('[data-testid="practice-dock"]')!;
		assert.match(dock.getAttribute("class")!, /flex max-h-\[var\(--dock-max-h,40vh\)\] flex-col/);
		const scroller = document.querySelector('[data-testid="practice-dock-scroll"]')!;
		assert.match(scroller.getAttribute("class")!, /min-h-0 flex-1 overflow-y-auto/);
		assert.ok(scroller.textContent!.includes("Sum two numbers."), "the statement scrolls…");
		assert.ok(scroller.querySelector('[data-testid="practice-code"]'), "…with the code panel");
		const field = document.querySelector('[data-testid="practice-thinking-field"]')!;
		assert.ok(!scroller.contains(field), "the thinking field sits outside the scroller");
		assert.match(field.getAttribute("class")!, /shrink-0/);
	});
});
