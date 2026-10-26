"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2Icon, PlayIcon } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import type { HoleRange } from "@/components/code-holes";
import { signalStudyActivity } from "@/components/study-activity";
import { cn } from "@/lib/utils";
import {
	CODE_LANGUAGE_LABEL,
	CODE_KIND_LABEL,
	caseStatus,
	exerciseKind,
	exerciseTests,
	outputsMatch,
	runSummary,
	splitHoles,
	type CodeExercise,
	type CodeSubmission,
	type CodeRunCase,
	type CodeRunResult,
	type CodeTest,
} from "@/src/core";

/**
 * The coding-exercise panel (fork, 2026-10-24): the editor, Run (the
 * VISIBLE tests, or a custom stdin) and Submit (EVERY test, hidden
 * included → `onSubmit` with the source and the result). Runs go to
 * POST /api/code/run — the learner's own clang compiles them locally.
 *
 * The draft survives remounts (reload, dock re-render) in localStorage,
 * keyed by `draftKey` — best-effort, a blocked storage just doesn't keep it.
 */

function readDraft(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}
function writeDraft(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {}
}

async function postRun(body: unknown): Promise<CodeRunResult> {
	const res = await fetch("/api/code/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = (await res.json().catch(() => ({}))) as CodeRunResult & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `run failed (${res.status})`);
	return data;
}

/** The fill draft: the document plus its gap ranges (offsets alone can't
 *  be recovered from edited text). */
interface FillDraft {
	doc: string;
	holes: readonly HoleRange[];
}
function readJson<T>(key: string): T | null {
	try {
		const raw = readDraft(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

/** What the learner has done on an exercise so far, from its drafts (an
 *  ask-before-check carries it to the teacher — owner, 2026-10-26): his
 *  code, or a predict's prediction. Undefined when nothing was started
 *  (the draft still equals the starter, or there is none). */
export function exerciseWorkSoFar(exercise: CodeExercise, draftKey: string): string | undefined {
	if (typeof window === "undefined") return undefined;
	const kind = exerciseKind(exercise);
	const starter = exercise.starterCode ?? "";
	if (kind === "predict") {
		const saved = readJson<{ text?: unknown }>(`lh-code-predict:${draftKey}`);
		const text = typeof saved?.text === "string" ? saved.text.trim() : "";
		return text ? `Predicted output so far:\n${text}` : undefined;
	}
	const doc =
		kind === "fill"
			? readJson<FillDraft>(`lh-code-draft:${draftKey}:fill`)?.doc
			: readDraft(`lh-code-draft:${draftKey}`);
	if (typeof doc !== "string" || !doc.trim()) return undefined;
	if (doc === starter || (kind === "fill" && doc === splitHoles(starter).doc)) return undefined;
	return doc;
}

export function CodeExercisePanel({
	exercise,
	draftKey,
	onSubmit,
	submitLabel = "Submit",
	disabled = false,
}: {
	exercise: CodeExercise;
	draftKey: string;
	/** write/fix/fill: every test ran. predict: the locked prediction plus
	 *  the learner's run, if he made one. The caller forwards it. */
	onSubmit?: (submission: CodeSubmission) => void | Promise<void>;
	submitLabel?: string;
	disabled?: boolean;
}) {
	const kind = exerciseKind(exercise);
	const tests = exerciseTests(exercise);
	const storageKey = `lh-code-draft:${draftKey}`;
	const fillKey = `${storageKey}:fill`;
	const predictKey = `lh-code-predict:${draftKey}`;
	const [seed] = useState<{ doc: string; holes?: readonly (number | HoleRange)[] }>(() => {
		const starter = exercise.starterCode ?? "";
		if (kind === "predict") return { doc: starter };
		if (kind === "fill") {
			const draft = typeof window === "undefined" ? null : readJson<FillDraft>(fillKey);
			if (draft && typeof draft.doc === "string" && Array.isArray(draft.holes)) return draft;
			return splitHoles(starter);
		}
		return { doc: (typeof window === "undefined" ? null : readDraft(storageKey)) ?? starter };
	});
	const sourceRef = useRef(seed.doc);
	const [busy, setBusy] = useState<"run" | "submit" | null>(null);
	const [result, setResult] = useState<CodeRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [customStdin, setCustomStdin] = useState<string | null>(null);
	// predict: the prediction LOCKS before any run (owner, 2026-10-25) and
	// stays locked across reloads — seeing the output never rewrites it.
	const [prediction, setPrediction] = useState<{ text: string; locked: boolean }>(() => {
		const saved = kind === "predict" && typeof window !== "undefined" ? readJson<{ text?: unknown; locked?: unknown }>(predictKey) : null;
		return { text: typeof saved?.text === "string" ? saved.text : "", locked: saved?.locked === true };
	});
	const savePrediction = (next: { text: string; locked: boolean }) => {
		setPrediction(next);
		writeDraft(predictKey, JSON.stringify(next));
	};

	const visible = tests.filter((t) => !t.hidden);
	const hiddenCount = tests.length - visible.length;

	const onChange = useCallback(
		(source: string, holes?: readonly HoleRange[]) => {
			sourceRef.current = source;
			if (holes) writeDraft(fillKey, JSON.stringify({ doc: source, holes } satisfies FillDraft));
			else writeDraft(storageKey, source);
		},
		[storageKey, fillKey],
	);

	const run = useCallback(async () => {
		if (busy || !sourceRef.current.trim()) return;
		if (kind === "predict" && !prediction.locked) return;
		signalStudyActivity();
		setBusy("run");
		setError(null);
		try {
			const body =
				kind === "predict"
					? { language: exercise.language, source: sourceRef.current, stdin: exercise.stdin ?? "" }
					: customStdin !== null || visible.length === 0
						? { language: exercise.language, source: sourceRef.current, stdin: customStdin ?? "" }
						: { language: exercise.language, source: sourceRef.current, tests: visible };
			setResult(await postRun(body));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, [busy, customStdin, exercise.language, exercise.stdin, visible, kind, prediction.locked]);

	const submit = useCallback(async () => {
		if (busy || !onSubmit || !sourceRef.current.trim()) return;
		if (kind === "predict" && !prediction.locked) return;
		setBusy("submit");
		setError(null);
		try {
			const source = sourceRef.current;
			if (kind === "predict") {
				await onSubmit({ source, result, prediction: prediction.text });
			} else {
				const full = await postRun({ language: exercise.language, source, tests });
				setResult(full);
				await onSubmit({ source, result: full });
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, [busy, exercise.language, tests, onSubmit, kind, prediction, result]);

	const summary = result ? runSummary(result) : null;
	const predicted = kind === "predict" && result?.compile.ok && result.cases[0] ? outputsMatch(result.cases[0].stdout, prediction.text) : null;

	return (
		<div className="flex flex-col gap-2" data-testid="code-exercise" data-kind={kind}>
			<div className="flex items-center justify-between font-ui text-[11px] uppercase tracking-wide text-muted-foreground">
				<span>
					{CODE_LANGUAGE_LABEL[exercise.language]}
					{kind !== "write" ? ` · ${CODE_KIND_LABEL[kind]}` : ""}
					{kind !== "predict" && (
						<>
							{" "}
							· {visible.length} visible test{visible.length === 1 ? "" : "s"}
							{hiddenCount > 0 ? ` + ${hiddenCount} hidden` : ""}
						</>
					)}
				</span>
				<span className="normal-case tracking-normal">
					{kind === "fill" ? "Tab next gap · " : ""}
					{kind === "predict" ? "" : "⌘↵ run"}
				</span>
			</div>
			<CodeEditor
				initial={seed.doc}
				onChange={onChange}
				onRun={() => void run()}
				ariaLabel={`${CODE_LANGUAGE_LABEL[exercise.language]} ${kind === "predict" ? "code to read" : "editor"}`}
				readOnly={kind === "predict"}
				holes={kind === "fill" ? seed.holes : undefined}
				assist={{ docId: draftKey, language: exercise.language }}
			/>

			{kind === "predict" && (
				<>
					{exercise.stdin ? <Output label="stdin" text={exercise.stdin} tone="plain" /> : null}
					<textarea
						value={prediction.text}
						onChange={(e) => savePrediction({ text: e.target.value, locked: false })}
						disabled={prediction.locked || disabled}
						placeholder="What does it print? Write the exact output."
						rows={3}
						className="w-full resize-y rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-muted-foreground disabled:opacity-70"
						data-testid="code-prediction"
						aria-label="Your predicted output"
					/>
				</>
			)}

			{customStdin !== null && kind !== "predict" && (
				<textarea
					value={customStdin}
					onChange={(e) => setCustomStdin(e.target.value)}
					placeholder="stdin for your run"
					rows={3}
					className="w-full resize-y rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-muted-foreground"
					data-testid="code-stdin"
				/>
			)}

			<div className="flex flex-wrap items-center gap-2">
				{kind === "predict" && !prediction.locked ? (
					<button
						type="button"
						onClick={() => savePrediction({ text: prediction.text, locked: true })}
						disabled={disabled || !prediction.text.trim()}
						className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1 font-ui text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
						data-testid="code-lock"
					>
						Lock prediction
					</button>
				) : (
					<>
						<button
							type="button"
							onClick={() => void run()}
							disabled={disabled || busy !== null}
							className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
							data-testid="code-run"
						>
							{busy === "run" ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
							Run{kind === "predict" || customStdin !== null || visible.length === 0 ? "" : " tests"}
						</button>
						{kind !== "predict" && (
							<button
								type="button"
								onClick={() => setCustomStdin((s) => (s === null ? "" : null))}
								className="rounded-md px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:text-foreground"
							>
								{customStdin === null ? "Custom input" : "Use tests"}
							</button>
						)}
						{onSubmit && (
							<button
								type="button"
								onClick={() => void submit()}
								disabled={disabled || busy !== null}
								className="ml-auto flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1 font-ui text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
								data-testid="code-submit"
							>
								{busy === "submit" && <Loader2Icon className="size-3.5 animate-spin" />}
								{submitLabel}
							</button>
						)}
					</>
				)}
			</div>

			{error && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-xs">{error}</div>}

			{result && (
				<div className="flex flex-col gap-1.5 text-xs" data-testid="code-result">
					{!result.compile.ok ? (
						<Output label="Compilation failed" text={result.compile.output} tone="bad" />
					) : (
						<>
							{result.compile.output.trim() && <Output label="Compiler warnings" text={result.compile.output} tone="warn" />}
							{predicted !== null && (
								<div className={cn("font-ui font-medium", predicted ? "text-green-500" : "text-destructive")} data-testid="code-prediction-verdict">
									{predicted ? "Your prediction matches the output" : "The output differs from your prediction"}
								</div>
							)}
							{summary && summary.total > 0 && (
								<div className={cn("font-ui font-medium", summary.allPassed ? "text-green-500" : "text-destructive")}>
									{summary.passed}/{summary.total} tests passed
								</div>
							)}
							{result.cases.map((c, i) => (
								<CaseRow key={i} index={i} c={c} test={tests.find((t) => t.stdin === c.stdin && t.expected === c.expected)} />
							))}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function Output({ label, text, tone }: { label: string; text: string; tone: "bad" | "warn" | "plain" }) {
	return (
		<div>
			<div className={cn("font-ui text-[11px] uppercase tracking-wide", tone === "bad" ? "text-destructive" : tone === "warn" ? "text-yellow-500" : "text-muted-foreground")}>{label}</div>
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] text-foreground">{text || "(empty)"}</pre>
		</div>
	);
}

function CaseRow({ index, c, test }: { index: number; c: CodeRunCase; test?: CodeTest }) {
	const status = caseStatus(c);
	const ok = c.passed === true || (c.passed === undefined && c.exitCode === 0 && !c.timedOut && !c.signal);
	const hidden = c.hidden ?? test?.hidden;
	return (
		<div className="rounded-md border border-border px-2 py-1.5">
			<div className="flex items-center gap-2 font-ui">
				<span className={cn("font-medium", ok ? "text-green-500" : "text-destructive")}>{ok ? "✓" : "✗"} {status}</span>
				<span className="text-muted-foreground">
					{c.passed === undefined ? "run" : `test ${index + 1}`}
					{hidden ? " (hidden)" : ""} · {c.ms} ms
				</span>
			</div>
			{!hidden && (
				<div className="mt-1 grid gap-1">
					{c.stdin && <Output label="stdin" text={c.stdin} tone="plain" />}
					{c.expected !== undefined && !c.passed && <Output label="expected" text={c.expected} tone="plain" />}
					<Output label={c.truncated ? "stdout (truncated)" : "stdout"} text={c.stdout} tone="plain" />
				</div>
			)}
			{c.stderr.trim() && <Output label="stderr" text={c.stderr} tone="bad" />}
		</div>
	);
}
