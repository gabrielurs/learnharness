import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserSpeechRecognition, speechErrorMessage } from "../components/dictation.tsx";

/**
 * The browser dictation engine (fork, 2026-10-24): the Web Speech API
 * wherever the platform has it, Deepgram where it doesn't.
 */
describe("browser dictation engine", () => {
	it("picks the standard constructor, then the webkit one, else none (→ Deepgram)", () => {
		class Std {}
		class Webkit {}
		assert.equal(browserSpeechRecognition({ SpeechRecognition: Std, webkitSpeechRecognition: Webkit }), Std);
		assert.equal(browserSpeechRecognition({ webkitSpeechRecognition: Webkit }), Webkit);
		assert.equal(browserSpeechRecognition({}), null);
		assert.equal(browserSpeechRecognition(undefined), null);
	});

	it("treats silence and our own abort as benign; names the real failures", () => {
		assert.equal(speechErrorMessage("no-speech"), null);
		assert.equal(speechErrorMessage("aborted"), null);
		assert.match(speechErrorMessage("not-allowed")!, /permission denied/);
		assert.match(speechErrorMessage("network")!, /unreachable/);
		assert.equal(speechErrorMessage("weird"), "Dictation failed (weird)");
	});
});
