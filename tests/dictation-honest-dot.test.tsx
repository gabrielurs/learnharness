/**
 * The dictation dot is the truth (owner, 2026-10-25) and the audio stack
 * sleeps between runs (battery round). Mounts the real useDictation under
 * linkedom with a scripted Web Speech recognizer, a fake mic and a fake
 * AudioContext:
 *   - "recording" (the red dot) only at audiostart, never at the click or
 *     at start; engines without audiostart fall back to start;
 *   - a renewal waits for a pause after ROTATE_SOFT_MS, is forced at
 *     ROTATE_HARD_MS, and reads "connecting" until the next audiostart;
 *   - teardown suspends the AudioContext; the next run resumes it.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// ── fakes ───────────────────────────────────────────────────────────────────
class FakeRecognition {
	static instances: FakeRecognition[] = [];
	static withAudioStart = true;
	lang = "";
	continuous = false;
	interimResults = false;
	onstart: (() => void) | null = null;
	onresult: ((ev: unknown) => void) | null = null;
	onerror: ((ev: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	stopped = false;
	constructor() {
		if (FakeRecognition.withAudioStart) (this as Record<string, unknown>).onaudiostart = null;
		FakeRecognition.instances.push(this);
	}
	start() {}
	stop() {
		this.stopped = true;
	}
	abort() {}
	fire(event: "onstart" | "onaudiostart" | "onend") {
		(this as unknown as Record<string, (() => void) | null>)[event]?.();
	}
	say(text: string) {
		this.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: text } }] });
	}
}
const ctxCalls: string[] = [];
let resumeGate: Promise<void> = Promise.resolve();
class FakeAudioContext {
	static last: FakeAudioContext | null = null;
	state = "running";
	constructor() {
		FakeAudioContext.last = this;
	}
	audioWorklet = { addModule: async () => {} };
	destination = {};
	async resume() {
		ctxCalls.push("resume");
		await resumeGate;
		this.state = "running";
	}
	async suspend() {
		ctxCalls.push("suspend");
		this.state = "suspended";
	}
	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}
}
class FakeWorkletNode {
	port = { onmessage: null };
	connect() {}
	disconnect() {}
}
Object.assign(dom.window, { webkitSpeechRecognition: FakeRecognition });
Object.assign(globalThis, {
	AudioContext: FakeAudioContext,
	AudioWorkletNode: FakeWorkletNode,
});
Object.defineProperty(globalThis, "navigator", {
	value: { language: "es-ES", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
	configurable: true,
});

const mod = await import("../components/dictation.tsx");
const { useDictation, DictationBar, ROTATE_SOFT_MS, ROTATE_HARD_MS, ROTATE_QUIET_MS } = mod;
type Dictation = ReturnType<typeof useDictation>;

let current: Dictation | null = null;
function Probe() {
	current = useDictation({ append: () => {} });
	return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
async function startRun() {
	await act(async () => current!.toggle());
	await flush();
	return FakeRecognition.instances.at(-1)!;
}

beforeEach(async () => {
	FakeRecognition.instances = [];
	FakeRecognition.withAudioStart = true;
	ctxCalls.length = 0;
	host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Probe />));
});
afterEach(async () => {
	await act(async () => current?.cancel());
	await act(async () => root?.unmount());
	host?.remove();
	mock.timers.reset();
	mock.restoreAll();
	resumeGate = Promise.resolve();
});

describe("dictation: the red dot lights only when audio is captured", () => {
	it("click → connecting; start alone → still connecting; audiostart → recording", async () => {
		const recog = await startRun();
		assert.equal(current!.phase, "connecting", "the click alone is not listening");
		await act(async () => recog.fire("onstart"));
		assert.equal(current!.phase, "connecting", "start is not capture where audiostart exists");
		await act(async () => recog.fire("onaudiostart"));
		assert.equal(current!.phase, "recording");
	});

	it("a result proves capture: lights the dot even without audiostart", async () => {
		const recog = await startRun();
		await act(async () => recog.fire("onstart"));
		assert.equal(current!.phase, "connecting");
		await act(async () => recog.say("hola"));
		assert.equal(current!.phase, "recording");
	});

	it("engines without audiostart fall back to start", async () => {
		FakeRecognition.withAudioStart = false;
		const recog = await startRun();
		await act(async () => recog.fire("onstart"));
		assert.equal(current!.phase, "recording");
	});

	it("the bar's dot follows the phase", () => {
		const bar = (phase: Dictation["phase"]) =>
			renderToStaticMarkup(<DictationBar dictation={{ ...current!, phase, active: true }} />);
		assert.match(bar("recording"), /data-testid="dictation-live" data-listening="true"/);
		assert.match(bar("connecting"), /data-testid="dictation-live" data-listening="false"/);
		assert.match(bar("connecting"), /opacity-40/, "the meter dims while not listening");
	});
});

describe("dictation: segment renewal waits for a pause", () => {
	it("speech past the soft mark defers the renewal; a pause renews; the gap reads connecting", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const now = { t: 0 };
		mock.method(performance, "now", () => now.t);
		const recog = await startRun();
		await act(async () => recog.fire("onaudiostart"));
		// Talking continuously across the soft mark: no renewal.
		for (let t = 100; t <= ROTATE_SOFT_MS + 2_000; t += 100) {
			now.t = t;
			recog.say("bla");
			mock.timers.tick(100);
		}
		assert.equal(recog.stopped, false, "never cut mid-speech");
		// A pause: renewed within one quiet window (+ a poll).
		const pauseAt = now.t;
		for (let t = pauseAt; t <= pauseAt + ROTATE_QUIET_MS + 400; t += 50) {
			now.t = t;
			await act(async () => mock.timers.tick(50));
		}
		assert.equal(recog.stopped, true, "renewed at the pause");
		assert.equal(current!.phase, "connecting", "the renewal gap is not listening");
		await act(async () => recog.fire("onend"));
		const next = FakeRecognition.instances.at(-1)!;
		assert.notEqual(next, recog, "a fresh segment");
		assert.equal(current!.phase, "connecting");
		await act(async () => next.fire("onaudiostart"));
		assert.equal(current!.phase, "recording");
	});

	it("non-stop speech is renewed at the hard cap anyway", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"] });
		const now = { t: 0 };
		mock.method(performance, "now", () => now.t);
		const recog = await startRun();
		await act(async () => recog.fire("onaudiostart"));
		for (let t = 100; t <= ROTATE_HARD_MS + 300; t += 100) {
			now.t = t;
			recog.say("bla");
			await act(async () => mock.timers.tick(100));
		}
		assert.equal(recog.stopped, true);
	});
});

describe("dictation: the audio stack sleeps between runs", () => {
	it("teardown suspends the AudioContext; the next run resumes it", async () => {
		const recog = await startRun();
		await act(async () => recog.fire("onaudiostart"));
		await flush();
		assert.ok(ctxCalls.includes("resume"));
		await act(async () => current!.toggle()); // stop
		await act(async () => recog.fire("onend")); // the recognizer's last finals land
		await flush();
		assert.equal(ctxCalls.at(-1), "suspend", "suspended at teardown");
		await startRun();
		await flush();
		assert.equal(ctxCalls.at(-1), "resume", "the next run resumes");
	});

	it("a teardown racing the resume still leaves the context suspended", async () => {
		let open!: () => void;
		resumeGate = new Promise<void>((r) => (open = r));
		await startRun(); // openCapture now waits inside resume()
		assert.equal(ctxCalls.at(-1), "resume");
		await act(async () => current!.cancel()); // teardown: suspend
		open(); // the resume lands AFTER the teardown's suspend
		await flush();
		await flush();
		assert.equal(FakeAudioContext.last!.state, "suspended", "re-suspended: no run owns the context");
	});
});
