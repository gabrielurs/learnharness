/**
 * The study-timer pill's clock (battery round, 2026-10-25): mounts the real
 * StudyTimer under linkedom and records every timer it arms. Idle and
 * paused arm nothing; a running block wakes on the countdown's second
 * boundaries while visible and once, at the phase end, while hidden.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_TIMER_SETTINGS, IDLE_TIMER, pause, startFocus, type TimerState } from "../src/core/study-timer.ts";

const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
let hidden = false;
Object.defineProperty(dom.document, "hidden", { get: () => hidden, configurable: true });
Object.assign(dom.window, {
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	CustomEvent: dom.window.CustomEvent,
});

const { StudyTimer } = await import("../components/study-timer.tsx");
const { signalStudyActivity } = await import("../components/study-activity.ts");

// Every timer armed with a real delay (React's own scheduling uses 0 /
// MessageChannel, so delays > 0 are the component's).
const armed: number[] = [];
let intervals = 0;
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
	if (ms && ms > 0) armed.push(ms);
	return realSetTimeout(fn, ms, ...rest);
}) as typeof setTimeout;
globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
	intervals++;
	return realSetInterval(fn, ms, ...rest);
}) as typeof setInterval;

let root: Root | null = null;
let host: HTMLElement | null = null;
async function mount(state: TimerState) {
	storage.set("lh-study-timer", JSON.stringify({ state, settings: DEFAULT_TIMER_SETTINGS, daily: null }));
	armed.length = 0;
	intervals = 0;
	host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<StudyTimer />));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null;
	hidden = false;
	mock.restoreAll();
});

describe("study timer pill: wakes only when its label can change", () => {
	it("idle: no interval, no timer", async () => {
		await mount(IDLE_TIMER);
		assert.equal(intervals, 0);
		assert.deepEqual(armed, []);
	});

	it("paused: no interval, no timer", async () => {
		await mount(pause(startFocus(IDLE_TIMER, DEFAULT_TIMER_SETTINGS, Date.now() - 60_000), Date.now()));
		assert.equal(intervals, 0);
		assert.deepEqual(armed, []);
	});

	it("running + visible: one timer up to the next second boundary", async () => {
		await mount(startFocus(IDLE_TIMER, DEFAULT_TIMER_SETTINGS, Date.now()));
		assert.equal(intervals, 0);
		assert.equal(armed.length, 1);
		assert.ok(armed[0]! > 0 && armed[0]! <= 1000, `armed ${armed[0]}`);
	});

	it("running + hidden: a single wake at the phase end", async () => {
		hidden = true;
		const start = Date.now();
		await mount(startFocus(IDLE_TIMER, DEFAULT_TIMER_SETTINGS, start));
		assert.equal(armed.length, 1);
		const toEnd = start + DEFAULT_TIMER_SETTINGS.focusMin * 60_000 - Date.now();
		assert.ok(Math.abs(armed[0]! - toEnd) < 50, `armed ${armed[0]} vs ${toEnd}`);
	});

	it("a start after a long idle stretch never paints a stale countdown", async () => {
		const t0 = Date.now();
		const clock = { t: t0 };
		mock.method(Date, "now", () => clock.t);
		await mount(IDLE_TIMER);
		// Every aria-label React writes, intermediate frames included.
		const labels: string[] = [];
		const proto = dom.window.Element.prototype as unknown as { setAttribute(n: string, v: string): void };
		const original = proto.setAttribute;
		proto.setAttribute = function (this: Element, name: string, value: string) {
			if (name === "aria-label" && value.startsWith("Study timer")) labels.push(value);
			return original.call(this, name, value);
		};
		try {
			clock.t = t0 + 60 * 60_000; // an hour idle
			await act(async () => signalStudyActivity()); // auto mode starts a block
		} finally {
			proto.setAttribute = original;
		}
		assert.ok(labels.length > 0, "the start re-rendered the pill");
		for (const label of labels) assert.match(label, /^Study timer: (Ready|Focus) 25:00$/, `painted "${label}"`);
	});
});
