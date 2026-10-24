"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2Icon, PlayIcon } from "lucide-react";
import { CodeEditor } from "@/components/code-editor";
import { cn } from "@/lib/utils";
import {
	CODE_LANGUAGE_LABEL,
	caseStatus,
	runSummary,
	type CodeExercise,
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

export function CodeExercisePanel({
	exercise,
	draftKey,
	onSubmit,
	submitLabel = "Submit",
	disabled = false,
}: {
	exercise: CodeExercise;
	draftKey: string;
	/** Submit: every test ran; the caller forwards source + result. */
	onSubmit?: (source: string, result: CodeRunResult) => void | Promise<void>;
	submitLabel?: string;
	disabled?: boolean;
}) {
	const storageKey = `lh-code-draft:${draftKey}`;
	const [initial] = useState(() => (typeof window === "undefined" ? null : readDraft(storageKey)) ?? exercise.starterCode ?? "");
	const sourceRef = useRef(initial);
	const [busy, setBusy] = useState<"run" | "submit" | null>(null);
	const [result, setResult] = useState<CodeRunResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [customStdin, setCustomStdin] = useState<string | null>(null);

	const visible = exercise.tests.filter((t) => !t.hidden);
	const hiddenCount = exercise.tests.length - visible.length;

	const onChange = useCallback(
		(source: string) => {
			sourceRef.current = source;
			writeDraft(storageKey, source);
		},
		[storageKey],
	);

	const run = useCallback(async () => {
		if (busy || !sourceRef.current.trim()) return;
		setBusy("run");
		setError(null);
		try {
			const body =
				customStdin !== null || visible.length === 0
					? { language: exercise.language, source: sourceRef.current, stdin: customStdin ?? "" }
					: { language: exercise.language, source: sourceRef.current, tests: visible };
			setResult(await postRun(body));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, [busy, customStdin, exercise.language, visible]);

	const submit = useCallback(async () => {
		if (busy || !onSubmit || !sourceRef.current.trim()) return;
		setBusy("submit");
		setError(null);
		try {
			const source = sourceRef.current;
			const full = await postRun({ language: exercise.language, source, tests: exercise.tests });
			setResult(full);
			await onSubmit(source, full);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	}, [busy, exercise.language, exercise.tests, onSubmit]);

	const summary = result ? runSummary(result) : null;

	return (
		<div className="flex flex-col gap-2" data-testid="code-exercise">
			<div className="flex items-center justify-between font-ui text-[11px] uppercase tracking-wide text-muted-foreground">
				<span>
					{CODE_LANGUAGE_LABEL[exercise.language]} · {visible.length} visible test{visible.length === 1 ? "" : "s"}
					{hiddenCount > 0 ? ` + ${hiddenCount} hidden` : ""}
				</span>
				<span className="normal-case tracking-normal">⌘↵ run</span>
			</div>
			<CodeEditor initial={initial} onChange={onChange} onRun={() => void run()} ariaLabel={`${CODE_LANGUAGE_LABEL[exercise.language]} editor`} />

			{customStdin !== null && (
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
				<button
					type="button"
					onClick={() => void run()}
					disabled={disabled || busy !== null}
					className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
					data-testid="code-run"
				>
					{busy === "run" ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
					Run{customStdin !== null || visible.length === 0 ? "" : " tests"}
				</button>
				<button
					type="button"
					onClick={() => setCustomStdin((s) => (s === null ? "" : null))}
					className="rounded-md px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					{customStdin === null ? "Custom input" : "Use tests"}
				</button>
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
			</div>

			{error && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-xs">{error}</div>}

			{result && (
				<div className="flex flex-col gap-1.5 text-xs" data-testid="code-result">
					{!result.compile.ok ? (
						<Output label="Compilation failed" text={result.compile.output} tone="bad" />
					) : (
						<>
							{result.compile.output.trim() && <Output label="Compiler warnings" text={result.compile.output} tone="warn" />}
							{summary && summary.total > 0 && (
								<div className={cn("font-ui font-medium", summary.allPassed ? "text-green-500" : "text-destructive")}>
									{summary.passed}/{summary.total} tests passed
								</div>
							)}
							{result.cases.map((c, i) => (
								<CaseRow key={i} index={i} c={c} test={exercise.tests.find((t) => t.stdin === c.stdin && t.expected === c.expected)} />
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
