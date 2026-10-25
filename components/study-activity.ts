/**
 * The study-activity signal (fork, 2026-10-24): the learner DID something
 * — sent a message, answered, submitted or ran code. The study timer
 * listens and starts a focus block on its own (owner: "si tengo que estar
 * yo mirándolo menudo palo"). Window-level, fire-and-forget.
 */
export const STUDY_ACTIVITY_EVENT = "lh:study-activity";

export function signalStudyActivity(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(STUDY_ACTIVITY_EVENT));
}
