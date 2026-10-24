/**
 * Chat render-cost guards (perf round, 2026-10-24).
 *
 * The composer draft lives in Chat state, so every keystroke re-renders
 * Chat. That must not reach the transcript: the rows and the context
 * consumers inside them (job/demo/visual cards, mermaid blocks) are pure
 * functions of settled data. This suite mounts the REAL Chat against an
 * isolated linkedom DOM (fetch wholly stubbed, GET-only — nothing can
 * write) and pins:
 *
 *   1. the rendered transcript HTML, byte-for-byte against a fixture taken
 *      from the pre-optimization code (React useId values normalized), so a
 *      render refactor can never change what the learner sees;
 *   2. zero context-consumer re-renders per keystroke (stable context values);
 *   3. zero transcript-row re-renders per keystroke (memoized rows);
 *   4. a settled record change still reaches the rows (memo never sticks).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "perf-chat-transcript.html");

const dom = parseHTML("<html><body></body></html>");
class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
const location = new URL("http://localhost/chat/c1");
const computedStyle = () => ({ getPropertyValue: () => "", fontSize: "16px" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	MutationObserver: dom.window.MutationObserver,
	ResizeObserver: NoopResizeObserver,
	IS_REACT_ACT_ENVIRONMENT: true,
	location,
	getComputedStyle: computedStyle,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.window, "location", { value: location, configurable: true });
Object.assign(dom.window, {
	innerWidth: 1280,
	innerHeight: 800,
	ResizeObserver: NoopResizeObserver,
	getComputedStyle: computedStyle,
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
proto.getAnimations = () => [];
proto.animate = () => ({ cancel() {} });
proto.scrollIntoView = () => {};

const originalFetch = globalThis.fetch;
/** Set by the memo-freshness test: the server record that GET /api/chats/c1 returns. */
let serverRecord: { messages: unknown[] } | null = null;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
	assert.equal(init?.method ?? "GET", "GET", "render tests must not write data");
	const pathname = new URL(String(input), "http://localhost").pathname;
	if (pathname === "/api/chats/c1" && serverRecord) return Response.json(serverRecord);
	return Response.json({ providers: [], models: [], keys: [], jobs: [], slots: {} });
}) as typeof fetch;
after(() => {
	globalThis.fetch = originalFetch;
});

const { Chat, ChatActionsContext } = await import("../components/chat.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { artifactRenderers } = await import("../components/artifacts/index.ts");

// A probe tool card: counts row renders and ChatActionsContext consumer renders.
let rowRenders = 0;
let contextRenders = 0;
function ContextProbe() {
	React.useContext(ChatActionsContext);
	contextRenders++;
	return null;
}
(artifactRenderers as Record<string, unknown>)["render_probe"] = () => {
	rowRenders++;
	return (
		<i data-render-probe="1">
			<ContextProbe />
		</i>
	);
};

const assistant = (id: string, content: unknown[], timestamp: number, stopReason = "stop") => ({
	role: "assistant",
	id,
	content,
	timestamp,
	api: "fixture",
	provider: "fixture",
	model: "fixture",
	usage: {},
	stopReason,
});
const MESSAGES = [
	{ role: "user", id: "u1", content: "Why does ice float?", timestamp: 1 },
	assistant(
		"a1",
		[
			{ type: "text", text: "Ice is **less dense** than liquid water.\n\n- hydrogen bonds\n- open lattice\n\nInline math $\\rho = m/V$." },
			{ type: "toolCall", id: "t1", name: "render_probe", arguments: {} },
		],
		2,
		"toolUse",
	),
	{ role: "toolResult", toolCallId: "t1", toolName: "render_probe", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
	assistant("a2", [{ type: "text", text: "So the solid sits on top. `density` matters." }], 4),
	{ role: "user", id: "u2", content: "And at 4 °C?", timestamp: 5 },
	assistant("a3", [{ type: "text", text: "Water is densest near 4 °C." }], 6),
];

/** React useId values differ when a component layer is added — not visible. */
const normalizeIds = (html: string) => html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, "«id»");

let root: Root | null = null;
/** The fake channel's handlers — a test fires server events through these. */
const eventHandlers = new Map<string, (data: string) => void>();
async function mount(messages: unknown[]): Promise<HTMLTextAreaElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const connect = () => ({
		close() {},
		onOpen() {},
		onEvent(name: string, cb: (data: string) => void) {
			eventHandlers.set(name, cb);
		},
	});
	await act(async () => {
		root!.render(
			<ServerEventsProvider connect={connect as never}>
				<Chat chatId="c1" title="Fixture session" initialMessages={messages as never} initialConfigured />
			</ServerEventsProvider>,
		);
	});
	const textarea = document.querySelector('[data-testid="composer"] textarea') as HTMLTextAreaElement | null;
	assert.ok(textarea, "composer mounted");
	return textarea;
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
}
/** linkedom dispatches no React input events — call the bound handler. */
async function type(textarea: HTMLTextAreaElement, value: string) {
	const key = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"))!;
	const props = (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[key]!;
	await act(async () => {
		props.onChange({ target: { value }, currentTarget: { value } });
	});
}
const transcriptHtml = () => normalizeIds(document.querySelector("[data-session-find-root]")!.innerHTML);

describe("Chat transcript render cost", () => {
	it("renders the transcript exactly as the pre-optimization code did", async () => {
		await mount(MESSAGES);
		try {
			const html = transcriptHtml();
			if (process.env.LH_WRITE_FIXTURES === "1") fs.writeFileSync(FIXTURE, html, "utf-8");
			assert.equal(html, fs.readFileSync(FIXTURE, "utf-8"));
			await type(document.querySelector('[data-testid="composer"] textarea') as HTMLTextAreaElement, "draft");
			assert.equal(transcriptHtml(), fs.readFileSync(FIXTURE, "utf-8"), "typing never changes the transcript");
		} finally {
			await unmount();
		}
	});

	it("a keystroke re-renders no ChatActionsContext consumer", async () => {
		const textarea = await mount(MESSAGES);
		try {
			const before = contextRenders;
			for (const value of ["a", "ab", "abc"]) await type(textarea, value);
			assert.equal(contextRenders - before, 0);
		} finally {
			await unmount();
		}
	});

	it("a keystroke re-renders no transcript row", async () => {
		const textarea = await mount(MESSAGES);
		try {
			const before = rowRenders;
			for (const value of ["a", "ab", "abc"]) await type(textarea, value);
			assert.equal(rowRenders - before, 0);
		} finally {
			await unmount();
		}
	});

	it("a record change still reaches the memoized rows", async () => {
		await mount(MESSAGES);
		try {
			assert.ok(!transcriptHtml().includes("A brand new teaching row"));
			serverRecord = { messages: [...MESSAGES, assistant("a4", [{ type: "text", text: "A brand new teaching row." }], 7)] };
			await act(async () => {
				eventHandlers.get("record-changed")!(JSON.stringify({ chatId: "c1" }));
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
			assert.ok(transcriptHtml().includes("A brand new teaching row"), "the new row rendered");
		} finally {
			serverRecord = null;
			await unmount();
		}
	});
});
