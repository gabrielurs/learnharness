/**
 * The study timer (fork, 2026-10-24) — work/break cycles and a daily
 * focus counter. PURE, browser-safe: state in, state out; the component
 * (components/study-timer.tsx) owns the clock, storage and alerts.
 *
 * Defaults follow the literature the owner asked for:
 *  - 25-minute focus blocks with 5-minute breaks — the structured schedule
 *    with (modest) experimental support over self-chosen breaks: better
 *    concentration and motivation (Biwer et al. 2023, Br J Educ Psychol),
 *    ~20% less fatigue across the RCTs of a 2025 scoping review (BMC Med
 *    Educ). No study compares 25 vs 50 minutes head-to-head; brief periodic
 *    disengagement is what prevents the vigilance decrement (Ariga &
 *    Lleras 2011, Cognition), which favors shorter blocks.
 *  - A LONGER break every 4 blocks: ≤10-minute micro-breaks restore vigor
 *    and fatigue but not performance on demanding tasks, and longer breaks
 *    help performance more (Albulescu et al. 2022, PLOS ONE); 10 minutes of
 *    quiet wakeful rest after learning improves retention (Dewar et al.
 *    2012). 20 minutes covers both.
 *  - Daily marks at 2 h and 4 h of focus: training studies show reduced
 *    benefit beyond ~2 h of deliberate practice a day and essentially none
 *    beyond 4 h (Ericsson, Krampe & Tesch-Römer 1993) — upper bounds, not
 *    a tested optimum. Spreading study over days beats massing it (Cepeda
 *    et al. 2006, Psychol Bull).
 */

export interface TimerSettings {
	focusMin: number;
	shortBreakMin: number;
	longBreakMin: number;
	/** Focus blocks per round; the round ends with the long break. */
	blocksPerRound: number;
	/** Daily focus marks (minutes): diminishing returns, then the ceiling. */
	softCapMin: number;
	hardCapMin: number;
	/** Start focus blocks on study activity (owner default: on). */
	auto: boolean;
}

export const DEFAULT_TIMER_SETTINGS: TimerSettings = {
	focusMin: 25,
	shortBreakMin: 5,
	longBreakMin: 20,
	blocksPerRound: 4,
	softCapMin: 120,
	hardCapMin: 240,
	auto: true,
};

export type TimerPhase = "idle" | "focus" | "short" | "long";

export interface TimerState {
	phase: TimerPhase;
	/** Epoch ms the running phase ends; absent when idle or paused. */
	endsAt?: number;
	/** Remaining ms while paused (a paused phase keeps its phase). */
	pausedMs?: number;
	/** Focus blocks finished in the current round. */
	blocksDone: number;
	/** Epoch ms the current focus stretch (re)started — for crediting. */
	focusSince?: number;
}

export const IDLE_TIMER: TimerState = { phase: "idle", blocksDone: 0 };

/** One day's credited focus time. */
export interface DailyFocus {
	date: string;
	focusMs: number;
}

const MIN = 60_000;

/** Clamp user-entered settings to sane bounds (corrupt storage included). */
export function sanitizeTimerSettings(raw: Partial<TimerSettings> | null | undefined): TimerSettings {
	const pick = (v: unknown, fallback: number, lo: number, hi: number) =>
		typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
	const d = DEFAULT_TIMER_SETTINGS;
	const s = raw ?? {};
	const softCapMin = pick(s.softCapMin, d.softCapMin, 15, 720);
	return {
		focusMin: pick(s.focusMin, d.focusMin, 1, 180),
		shortBreakMin: pick(s.shortBreakMin, d.shortBreakMin, 1, 60),
		longBreakMin: pick(s.longBreakMin, d.longBreakMin, 1, 120),
		blocksPerRound: pick(s.blocksPerRound, d.blocksPerRound, 1, 12),
		softCapMin,
		hardCapMin: Math.max(softCapMin, pick(s.hardCapMin, d.hardCapMin, 15, 960)),
		auto: typeof s.auto === "boolean" ? s.auto : d.auto,
	};
}

export function phaseMinutes(phase: Exclude<TimerPhase, "idle">, s: TimerSettings): number {
	return phase === "focus" ? s.focusMin : phase === "short" ? s.shortBreakMin : s.longBreakMin;
}

/** Ms left in the phase (0 when idle). */
export function remainingMs(state: TimerState, now: number): number {
	if (state.phase === "idle") return 0;
	if (state.pausedMs !== undefined) return state.pausedMs;
	return Math.max(0, (state.endsAt ?? now) - now);
}

export function isRunning(state: TimerState): boolean {
	return state.phase !== "idle" && state.pausedMs === undefined;
}

/** Start a focus block (from idle, or to cut a break short). */
export function startFocus(state: TimerState, s: TimerSettings, now: number): TimerState {
	return { phase: "focus", endsAt: now + s.focusMin * MIN, blocksDone: state.phase === "long" ? 0 : state.blocksDone, focusSince: now };
}

export function pause(state: TimerState, now: number): TimerState {
	if (!isRunning(state)) return state;
	const { endsAt: _e, focusSince: _f, ...rest } = state;
	return { ...rest, pausedMs: remainingMs(state, now) };
}

export function resume(state: TimerState, now: number): TimerState {
	if (state.phase === "idle" || state.pausedMs === undefined) return state;
	const { pausedMs, ...rest } = state;
	return { ...rest, endsAt: now + pausedMs, ...(state.phase === "focus" ? { focusSince: now } : {}) };
}

/** Focus ms to credit when a focus stretch stops (pause, end, reset). */
export function focusElapsed(state: TimerState, now: number): number {
	return state.phase === "focus" && state.focusSince !== undefined ? Math.max(0, Math.min(now, state.endsAt ?? now) - state.focusSince) : 0;
}

/**
 * The phase that follows the current one ENDING: focus → a break (the long
 * one when the round completes; breaks start on their own); a break →
 * idle, waiting for the learner to start the next block (no clock running
 * while they are away).
 */
export function advance(state: TimerState, s: TimerSettings, now: number): TimerState {
	if (state.phase === "focus") {
		const blocksDone = state.blocksDone + 1;
		const phase = blocksDone >= s.blocksPerRound ? "long" : "short";
		return { phase, endsAt: now + phaseMinutes(phase, s) * MIN, blocksDone };
	}
	if (state.phase === "long") return { phase: "idle", blocksDone: 0 };
	return { phase: "idle", blocksDone: state.blocksDone };
}

/** Local calendar date key (YYYY-MM-DD) for the daily counter. */
export function dayKey(now: number): string {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Add focus time to today's counter (a new day starts from zero). */
export function creditFocus(daily: DailyFocus | null, ms: number, now: number): DailyFocus {
	const date = dayKey(now);
	const base = daily && daily.date === date ? daily.focusMs : 0;
	return { date, focusMs: base + Math.max(0, ms) };
}

export function todayFocusMs(daily: DailyFocus | null, now: number): number {
	return daily && daily.date === dayKey(now) ? daily.focusMs : 0;
}

/** Where today's focus sits against the evidence-based marks. */
export function dailyLevel(focusMs: number, s: TimerSettings): "ok" | "soft" | "hard" {
	if (focusMs >= s.hardCapMin * MIN) return "hard";
	if (focusMs >= s.softCapMin * MIN) return "soft";
	return "ok";
}

export function formatClock(ms: number): string {
	const total = Math.ceil(ms / 1000);
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
	const min = Math.floor(ms / MIN);
	return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
}

/**
 * Auto mode (fork, 2026-10-24): the learner's study activity starts a
 * focus block when the timer is IDLE — first activity of the day, or the
 * first after a break ended. A running block, a break, or a manual pause
 * is left alone (a break is the point; a pause is the learner's call).
 */
export function onStudyActivity(state: TimerState, s: TimerSettings, now: number): TimerState {
	if (!s.auto || state.phase !== "idle") return state;
	return startFocus(state, s, now);
}
