"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { CodeExercisePanel } from "@/components/code-exercise";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import {
	CODE_KIND_LABEL,
	buildAnswer,
	exerciseKind,
	normalizeQuizType,
	renderExerciseSubmission,
	type CodeSubmission,
	type ExerciseToolInput,
	type QuestionAnswerData,
	type QuestionData,
} from "@/src/core";

/**
 * The teacher's coding exercise in the question dock (owner, 2026-10-25):
 * the statement, the code panel (any of the four kinds) and the learner's
 * "Your thinking" — which rides the submission, like a quiz answer's.
 * The panel's own Submit sends: the submission text (code + run, or the
 * locked prediction + run) is the answer; the committed modelSolution
 * snapshots into it for the reveal, and the teacher grades in its reply.
 */
export function ExerciseDockForm({
	toolCallId,
	input,
	onSubmit,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
}: {
	toolCallId: string;
	input: ExerciseToolInput;
	onSubmit: (output: QuestionAnswerData) => void;
	onEscape?: () => void;
	dictationClaim?: boolean;
	compactionRunning?: boolean;
}) {
	const qd = useMemo<QuestionData>(
		() => ({
			id: toolCallId,
			kind: "exercise",
			questionType: normalizeQuizType((input as { type?: unknown }).type),
			question: input.question,
			context: input.details,
			mode: "text",
			options: [],
			committedAnswer: input.modelSolution,
			createdAt: new Date().toISOString(),
		}),
		[toolCallId, input],
	);

	const [thinking, setThinking] = useState("");
	// The ref mirrors the field: a submit resuming after `await
	// finishDictation()` reads the dictated tail, never a stale closure.
	const thinkingRef = useRef("");
	useDictationTarget(
		useCallback((t: string) => {
			const v = joinDictation(thinkingRef.current, t);
			thinkingRef.current = v;
			setThinking(v);
		}, []),
		dictationClaim,
	);

	const send = (submission: CodeSubmission) => {
		const text = renderExerciseSubmission(input.code, submission);
		onSubmit(buildAnswer(qd, { text, thinking: thinkingRef.current.trim() || undefined }, "exercise"));
	};
	const submitCode = async (submission: CodeSubmission) => {
		if (compactionRunning) return;
		// Finish dictation first: spoken reasoning still in flight lands in
		// the thinking field before the answer is built.
		if (isDictationActive()) await finishDictation();
		send(submission);
	};

	const kind = exerciseKind(input.code);
	return (
		// The whole dock is capped by the measured column: statement + code
		// scroll together, the thinking field stays pinned below.
		<div data-testid="exercise-dock" data-kind={kind} className="flex max-h-[var(--dock-max-h,55dvh)] flex-col">
			<div data-session-find-root="" className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Exercise{kind !== "write" ? ` · ${CODE_KIND_LABEL[kind]}` : ""}
				</div>
				<div className="mb-3 font-medium">
					<ToolContentResponse>{input.question}</ToolContentResponse>
				</div>
				{input.details && (
					<div className="mb-3 text-sm text-muted-foreground">
						<ToolContentResponse>{input.details}</ToolContentResponse>
					</div>
				)}
				<div className="pb-2" data-testid="exercise-code">
					<CodeExercisePanel
						exercise={input.code}
						draftKey={toolCallId}
						onSubmit={submitCode}
						submitLabel="Submit"
						disabled={compactionRunning}
					/>
				</div>
			</div>
			<div
				data-testid="exercise-thinking-field"
				className="m-1.5 shrink-0 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
			>
				<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">YOUR THINKING</div>
				<textarea
					value={thinking}
					onChange={(e) => {
						thinkingRef.current = e.target.value;
						setThinking(e.target.value);
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape" && onEscape) {
							e.preventDefault();
							e.stopPropagation();
							onEscape();
						}
					}}
					placeholder="Think out loud — it goes with your submission."
					rows={2}
					className="field-sizing-content lh-input max-h-48 min-h-12 w-full resize-none bg-transparent px-2.5 pb-2 outline-none placeholder:text-muted-foreground"
				/>
				<div className="px-2.5 pb-2 text-xs text-muted-foreground" aria-hidden>
					{compactionRunning ? "compacting session…" : "Submit in the code panel sends your work and this thinking"}
				</div>
			</div>
		</div>
	);
}
