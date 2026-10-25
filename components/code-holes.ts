import { EditorSelection, EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";

/**
 * Fill-the-gaps editing (owner, 2026-10-25): the exercise's holes are the
 * ONLY editable ranges — everything else is locked. Each hole is a
 * {from, to} range that grows as the learner types into it (its start
 * stays put, its end follows insertions), highlighted when filled and
 * shown as an empty box when not. Tab / Shift-Tab select the next /
 * previous hole whole, so typing replaces it.
 */

export interface HoleRange {
	from: number;
	to: number;
}

const holeField = StateField.define<readonly HoleRange[]>({
	create: () => [],
	update: (holes, tr) =>
		tr.docChanged ? holes.map((h) => ({ from: tr.changes.mapPos(h.from, -1), to: tr.changes.mapPos(h.to, 1) })) : holes,
});

/** The current hole ranges (exported for the panel's draft and for tests). */
export function holeRanges(state: EditorState): readonly HoleRange[] {
	return state.field(holeField, false) ?? [];
}

/** Changes are suppressed everywhere OUTSIDE the holes — and only there:
 *  a transaction that also touches locked code (indentOnInput reindenting
 *  the line of a typed `}`) keeps its in-gap part instead of losing the
 *  keystroke. Insertions at a gap's own edges count as inside. */
const onlyInsideHoles = EditorState.changeFilter.of((tr) => {
	const holes = [...tr.startState.field(holeField)].sort((a, b) => a.from - b.from);
	const locked: number[] = [];
	let pos = 0;
	for (const h of holes) {
		if (h.from > pos) locked.push(pos, h.from);
		pos = Math.max(pos, h.to);
	}
	if (pos < tr.startState.doc.length) locked.push(pos, tr.startState.doc.length);
	return locked.length > 0 ? locked : true;
});

/** The one leak in range suppression: an insertion exactly at a locked
 *  range's edge passes. Those edges are gap edges (allowed) or the
 *  document's own start and end — refused here unless a gap sits there. */
const noInsertAtDocEdges = EditorState.changeFilter.of((tr) => {
	const holes = tr.startState.field(holeField);
	const end = tr.startState.doc.length;
	let ok = true;
	tr.changes.iterChangedRanges((fromA, toA) => {
		if (fromA !== toA) return;
		if (fromA === 0 && !holes.some((h) => h.from === 0)) ok = false;
		if (fromA === end && !holes.some((h) => h.to === end)) ok = false;
	});
	return ok;
});

class EmptyHole extends WidgetType {
	eq() {
		return true;
	}
	/** A click on the empty box reaches the editor: the caret lands in the gap. */
	ignoreEvent() {
		return false;
	}
	toDOM() {
		const el = document.createElement("span");
		el.className = "lh-code-hole-empty";
		el.setAttribute("aria-label", "empty gap");
		return el;
	}
}
const emptyHole = Decoration.widget({ widget: new EmptyHole(), side: 1 });
const filledHole = Decoration.mark({ class: "lh-code-hole" });

const holeDecorations = EditorView.decorations.compute([holeField], (state): DecorationSet =>
	Decoration.set(
		holeRanges(state).map((h) => (h.from === h.to ? emptyHole.range(h.from) : filledHole.range(h.from, h.to))),
		true,
	),
);

/** Select the next (dir 1) / previous (dir -1) hole, wrapping around. */
export function moveToHole(view: { state: EditorState; dispatch: (tr: { selection: EditorSelection; scrollIntoView: boolean }) => void }, dir: 1 | -1): boolean {
	const holes = holeRanges(view.state);
	if (holes.length === 0) return false;
	const head = view.state.selection.main.head;
	const current = holes.findIndex((h) => head >= h.from && head <= h.to);
	let index: number;
	if (current !== -1) index = (current + dir + holes.length) % holes.length;
	else if (dir === 1) index = Math.max(0, holes.findIndex((h) => h.from > head));
	else {
		const before = holes.map((h, i) => (h.to < head ? i : -1)).filter((i) => i !== -1);
		index = before.length ? before.at(-1)! : holes.length - 1;
	}
	const target = holes[index]!;
	view.dispatch({ selection: EditorSelection.single(target.from, target.to), scrollIntoView: true });
	return true;
}

/** The fill-mode extension: `holes` are offsets into the initial document
 *  (each an empty gap at that point — contracts/code.ts splitHoles), or
 *  full ranges when restoring a draft. */
export function codeHoles(holes: readonly (number | HoleRange)[]): Extension {
	const initial = holes.map((h) => (typeof h === "number" ? { from: h, to: h } : h));
	return [
		holeField.init(() => initial),
		onlyInsideHoles,
		noInsertAtDocEdges,
		holeDecorations,
		keymap.of([
			{ key: "Tab", run: (view) => moveToHole(view, 1) },
			{ key: "Shift-Tab", run: (view) => moveToHole(view, -1) },
		]),
	];
}
