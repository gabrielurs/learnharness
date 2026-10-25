import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_TIMER_SETTINGS as S,
	IDLE_TIMER,
	advance,
	creditFocus,
	dailyLevel,
	focusElapsed,
	formatClock,
	isRunning,
	onStudyActivity,
	pause,
	remainingMs,
	resume,
	sanitizeTimerSettings,
	startFocus,
	todayFocusMs,
} from "../src/core/study-timer.ts";

const MIN = 60_000;

describe("study timer (fork, 2026-10-24)", () => {
	it("defaults follow the evidence: 25/5, a 20-min long break every 4 blocks, marks at 2 h and 4 h", () => {
		assert.deepEqual(S, { focusMin: 25, shortBreakMin: 5, longBreakMin: 20, blocksPerRound: 4, softCapMin: 120, hardCapMin: 240, auto: true });
	});

	it("runs a round: focus → short breaks → the long break after the 4th block → a fresh round", () => {
		let st = startFocus(IDLE_TIMER, S, 0);
		assert.equal(remainingMs(st, 0), 25 * MIN);
		for (let block = 1; block <= 3; block++) {
			st = advance(st, S, 0);
			assert.equal(st.phase, "short");
			assert.equal(remainingMs(st, 0), 5 * MIN);
			st = advance(st, S, 0);
			assert.equal(st.phase, "idle", "a break ends waiting for the learner");
			st = startFocus(st, S, 0);
		}
		st = advance(st, S, 0);
		assert.equal(st.phase, "long");
		assert.equal(remainingMs(st, 0), 20 * MIN);
		assert.equal(advance(st, S, 0).blocksDone, 0, "the long break closes the round");
	});

	it("pauses and resumes without losing time, crediting only focus actually run", () => {
		let st = startFocus(IDLE_TIMER, S, 0);
		assert.equal(focusElapsed(st, 10 * MIN), 10 * MIN);
		st = pause(st, 10 * MIN);
		assert.equal(isRunning(st), false);
		assert.equal(remainingMs(st, 99 * MIN), 15 * MIN);
		st = resume(st, 50 * MIN);
		assert.equal(remainingMs(st, 50 * MIN), 15 * MIN);
		assert.equal(focusElapsed(st, 60 * MIN), 10 * MIN);
	});

	it("counts focus per calendar day and flags the marks", () => {
		const now = new Date(2026, 9, 24, 12).getTime();
		let day = creditFocus(null, 90 * MIN, now);
		day = creditFocus(day, 40 * MIN, now);
		assert.equal(todayFocusMs(day, now), 130 * MIN);
		assert.equal(dailyLevel(todayFocusMs(day, now), S), "soft");
		assert.equal(dailyLevel(241 * MIN, S), "hard");
		const tomorrow = new Date(2026, 9, 25, 9).getTime();
		assert.equal(todayFocusMs(day, tomorrow), 0);
		assert.equal(creditFocus(day, MIN, tomorrow).focusMs, MIN);
	});

	it("auto mode: activity starts a block only when idle — never cuts a break or overrides a pause", () => {
		const started = onStudyActivity(IDLE_TIMER, S, 0);
		assert.equal(started.phase, "focus");
		const inBreak = advance(started, S, 0);
		assert.equal(onStudyActivity(inBreak, S, 1000), inBreak, "a break is left alone");
		const paused = pause(startFocus(IDLE_TIMER, S, 0), 1000);
		assert.equal(onStudyActivity(paused, S, 2000), paused, "a manual pause is left alone");
		assert.equal(onStudyActivity(IDLE_TIMER, { ...S, auto: false }, 0), IDLE_TIMER, "auto off: manual only");
	});

	it("sanitizes stored settings and formats the clock", () => {
		assert.deepEqual(sanitizeTimerSettings({ focusMin: 0, longBreakMin: 999, softCapMin: 300, hardCapMin: 100 }), {
			...S,
			focusMin: 1,
			longBreakMin: 120,
			softCapMin: 300,
			hardCapMin: 300,
		});
		assert.deepEqual(sanitizeTimerSettings(null), S);
		assert.equal(formatClock(25 * MIN), "25:00");
		assert.equal(formatClock(61_500), "01:02");
	});
});
