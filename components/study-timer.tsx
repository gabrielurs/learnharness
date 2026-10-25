"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TimerIcon } from "lucide-react";
import { STUDY_ACTIVITY_EVENT } from "@/components/study-activity";
import { cn } from "@/lib/utils";
import {
	DEFAULT_TIMER_SETTINGS,
	IDLE_TIMER,
	advance,
	creditFocus,
	dailyLevel,
	focusElapsed,
	formatClock,
	formatDuration,
	isRunning,
	nextClockWake,
	onStudyActivity,
	pause,
	phaseMinutes,
	remainingMs,
	resume,
	sanitizeTimerSettings,
	startFocus,
	todayFocusMs,
	type DailyFocus,
	type TimerSettings,
	type TimerState,
} from "@/src/core";

/**
 * The study timer pill (fork, 2026-10-24 — owner: bottom bar, alert on
 * phase end, daily counter). Logic and the evidence behind the defaults:
 * src/core/study-timer.ts.
 *
 * State lives in localStorage (one timer for the whole app: it survives
 * reloads and page changes, and tabs stay in sync through the storage
 * event). The clock is wall time (endsAt), so a backgrounded tab never
 * drifts; the 1 s tick only repaints and catches phase ends.
 */

const KEY = "lh-study-timer";

interface Stored {
	state: TimerState;
	settings: TimerSettings;
	daily: DailyFocus | null;
}

function load(): Stored {
	try {
		const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<Stored> | null;
		return {
			state: raw?.state && typeof raw.state.phase === "string" ? raw.state : IDLE_TIMER,
			settings: sanitizeTimerSettings(raw?.settings),
			daily: raw?.daily ?? null,
		};
	} catch {
		return { state: IDLE_TIMER, settings: DEFAULT_TIMER_SETTINGS, daily: null };
	}
}

function save(value: Stored): void {
	try {
		window.localStorage.setItem(KEY, JSON.stringify(value));
	} catch {}
}

/** A soft two-note chime (no asset: WebAudio). */
function chime(): void {
	try {
		const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		const ctx = new Ctx();
		[660, 880].forEach((freq, i) => {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.frequency.value = freq;
			osc.type = "sine";
			const t = ctx.currentTime + i * 0.25;
			gain.gain.setValueAtTime(0.0001, t);
			gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
			osc.connect(gain).connect(ctx.destination);
			osc.start(t);
			osc.stop(t + 0.65);
		});
		setTimeout(() => void ctx.close(), 1500);
	} catch {}
}

function notify(title: string, body: string): void {
	try {
		if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, silent: true });
	} catch {}
}

const PHASE_LABEL = { idle: "Ready", focus: "Focus", short: "Break", long: "Long break" } as const;

export function StudyTimer() {
	const [data, setData] = useState<Stored | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	// Mount: read storage (client-only — no SSR mismatch), follow other tabs.
	useEffect(() => {
		setData(load());
		const onStorage = (e: StorageEvent) => {
			if (e.key === KEY) setData(load());
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const commit = useCallback((next: Stored) => {
		save(next);
		setData(next);
	}, []);

	// AUTO MODE (owner: "que se active automáticamente"): studying starts a
	// block when the timer is idle. Reads storage fresh — another tab or a
	// page change may have moved the timer since this render.
	useEffect(() => {
		const onActivity = () => {
			const current = load();
			const now = Date.now();
			const state = onStudyActivity(current.state, current.settings, now);
			if (state !== current.state) commit({ ...current, state });
		};
		window.addEventListener(STUDY_ACTIVITY_EVENT, onActivity);
		return () => window.removeEventListener(STUDY_ACTIVITY_EVENT, onActivity);
	}, [commit]);

	// The tick: repaint, and roll the phase over when it ends. Only while a
	// phase runs — idle and paused never wake the CPU — on each second
	// boundary when visible, once at the phase end when hidden.
	const runningState = data && isRunning(data.state) ? data.state : null;
	useEffect(() => {
		if (!runningState) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			const t = Date.now();
			setNow(t);
			const wait = nextClockWake(runningState, t, document.hidden);
			timer = wait === null ? undefined : setTimeout(tick, wait);
		};
		const onVisibility = () => {
			clearTimeout(timer);
			tick();
		};
		tick();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [runningState]);
	useEffect(() => {
		if (!data || !isRunning(data.state) || remainingMs(data.state, now) > 0) return;
		const ended = data.state.phase;
		const daily = ended === "focus" ? creditFocus(data.daily, focusElapsed(data.state, now), now) : data.daily;
		const state = advance(data.state, data.settings, now);
		commit({ ...data, state, daily });
		chime();
		if (ended === "focus") {
			const level = dailyLevel(todayFocusMs(daily, now), data.settings);
			const extra = level === "hard" ? " You've passed today's ceiling — call it a day." : level === "soft" ? " Past 2 h today: returns diminish from here." : "";
			notify(
				state.phase === "long" ? "Round done — long break" : "Block done — take a break",
				`${phaseMinutes(state.phase as "short" | "long", data.settings)} min. Step away from the screen: quiet rest helps the material settle.${extra}`,
			);
		} else {
			notify(
				"Break over",
				data.settings.auto ? "The next block starts on its own when you get back to studying." : "Start the next focus block when you're ready.",
			);
		}
	}, [data, now, commit]);

	// Close the popover on outside pointer / Escape (the stats-bar discipline).
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!data) return null;
	const { state, settings } = data;
	const t = Date.now();
	// Render-time clock, not `now`: `now` only advances while a phase runs,
	// so after an idle stretch it is stale for the first frame of a start.
	const left = remainingMs(state, t);
	const running = isRunning(state);
	const today = todayFocusMs(data.daily, t) + (state.phase === "focus" && running ? focusElapsed(state, t) : 0);
	const level = dailyLevel(today, settings);

	const askPermission = () => {
		try {
			if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
		} catch {}
	};
	const credit = (s: TimerState) => (s.phase === "focus" ? creditFocus(data.daily, focusElapsed(s, Date.now()), Date.now()) : data.daily);
	const startBlock = () => {
		askPermission();
		commit({ ...data, daily: credit(state), state: startFocus(state, settings, Date.now()) });
	};
	const togglePause = () => {
		if (running) commit({ ...data, daily: credit(state), state: pause(state, Date.now()) });
		else commit({ ...data, state: resume(state, Date.now()) });
	};
	const skip = () => commit({ ...data, daily: credit(state), state: advance(state, settings, Date.now()) });
	const reset = () => commit({ ...data, daily: credit(state), state: IDLE_TIMER });
	const setSetting = (k: keyof TimerSettings, v: number | boolean) => commit({ ...data, settings: sanitizeTimerSettings({ ...settings, [k]: v }) });

	const pillLabel = state.phase === "idle" ? formatClock(settings.focusMin * 60_000) : formatClock(left);
	return (
		<div ref={wrapRef} className="relative shrink-0" data-testid="study-timer">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				aria-label={`Study timer: ${PHASE_LABEL[state.phase]} ${pillLabel}`}
				className={cn(
					"flex items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 tabular-nums shadow-lg backdrop-blur transition-colors hover:bg-muted",
					state.phase === "focus" && running && "text-card-foreground",
					(state.phase === "short" || state.phase === "long") && "border-green-500/50 text-green-500",
					state.pausedMs !== undefined && "opacity-70",
				)}
			>
				<TimerIcon className="size-3.5" />
				<span>{pillLabel}</span>
				{level !== "ok" && <span aria-hidden className={cn("size-1.5 rounded-full", level === "hard" ? "bg-red-500" : "bg-amber-500")} />}
			</button>

			{open && (
				<div className="absolute right-0 bottom-full z-40 mb-1.5 w-80 rounded-xl border bg-card p-3 text-xs shadow-xl" data-testid="study-timer-panel">
					<div className="mb-2 flex items-baseline justify-between">
						<span className="font-medium uppercase tracking-wide text-muted-foreground">{PHASE_LABEL[state.phase]}</span>
						<span className="font-mono text-2xl tabular-nums text-card-foreground">{pillLabel}</span>
					</div>
					<div className="mb-2 text-muted-foreground">
						Block {Math.min(state.blocksDone + (state.phase === "focus" ? 1 : 0), settings.blocksPerRound)} of {settings.blocksPerRound} · long break after the {settings.blocksPerRound}th
					</div>

					<div className="mb-3 flex flex-wrap gap-1.5">
						{state.phase !== "focus" && (
							<button type="button" onClick={startBlock} className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background hover:opacity-90" data-testid="timer-start">
								{state.phase === "idle" ? "Start focus" : "End break · focus"}
							</button>
						)}
						{state.phase !== "idle" && (
							<button type="button" onClick={togglePause} className="rounded-md border px-2.5 py-1 hover:bg-accent">
								{running ? "Pause" : "Resume"}
							</button>
						)}
						{state.phase !== "idle" && (
							<button type="button" onClick={skip} className="rounded-md border px-2.5 py-1 hover:bg-accent">
								Skip
							</button>
						)}
						{state.phase !== "idle" && (
							<button type="button" onClick={reset} className="rounded-md px-2.5 py-1 text-muted-foreground hover:text-foreground">
								Reset
							</button>
						)}
					</div>

					<div className={cn("mb-3 rounded-md border px-2 py-1.5", level === "hard" ? "border-red-500/50 text-red-500" : level === "soft" ? "border-amber-500/50 text-amber-500" : "text-card-foreground")}>
						<div className="flex justify-between">
							<span>Focus today</span>
							<span className="tabular-nums">{formatDuration(today)}</span>
						</div>
						{level !== "ok" && (
							<div className="mt-1">
								{level === "hard"
									? `Past ${formatDuration(settings.hardCapMin * 60_000)}: extra practice adds little today — tomorrow's session will do more.`
									: `Past ${formatDuration(settings.softCapMin * 60_000)}: returns diminish from here; spacing it over days works better.`}
							</div>
						)}
					</div>

					<label className="mb-2 flex items-center justify-between gap-2 text-muted-foreground" title="Sending a message, answering or running code starts a focus block when the timer is idle">
						<span>
							<span className="text-card-foreground">Auto</span> — studying starts the next block
						</span>
						<input type="checkbox" checked={settings.auto} onChange={(e) => setSetting("auto", e.target.checked)} data-testid="timer-auto" />
					</label>

					<div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
						{(
							[
								["focusMin", "Focus (min)"],
								["shortBreakMin", "Break (min)"],
								["longBreakMin", "Long break (min)"],
								["blocksPerRound", "Blocks per round"],
							] as const
						).map(([k, label]) => (
							<label key={k} className="flex items-center justify-between gap-2 text-muted-foreground">
								{label}
								<input
									type="number"
									value={settings[k]}
									min={1}
									onChange={(e) => setSetting(k, Number(e.target.value))}
									className="w-14 rounded border bg-background px-1.5 py-0.5 text-right tabular-nums text-card-foreground"
								/>
							</label>
						))}
					</div>

					<details className="text-muted-foreground">
						<summary className="cursor-pointer">Why these numbers</summary>
						<p className="mt-1.5 leading-relaxed">
							Fixed short blocks beat “stop when tired”: structured 25/5 breaks gave better concentration and motivation (Biwer et al., 2023) and
							less fatigue across small RCTs (BMC Med Educ scoping review, 2025). Brief, periodic disengagement prevents the vigilance decrement
							(Ariga &amp; Lleras, 2011). Short breaks restore energy but demanding work needs longer ones (Albulescu et al., 2022), and 10 min of
							quiet rest after learning boosts retention (Dewar et al., 2012) — hence the 20-min long break. Benefit drops past ~2 h of focused
							practice a day and is near zero past ~4 h (Ericsson et al., 1993); spreading sessions over days beats one long one (Cepeda et al., 2006).
						</p>
					</details>
				</div>
			)}
		</div>
	);
}
