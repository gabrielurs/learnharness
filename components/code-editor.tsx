"use client";

import { useEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { codeHoles, holeRanges, type HoleRange } from "@/components/code-holes";
import { codeAssist } from "@/components/code-assist";
import type { CodeLanguage } from "@/src/core";

/**
 * The C/C++ code editor (fork, 2026-10-24 — owner pick: CodeMirror 6).
 * Uncontrolled: `initial` seeds it once; every edit reports through
 * `onChange`. Tab indents (4 spaces); ⌘/Ctrl+Enter runs `onRun`.
 * Token colors are `tok-*` classes styled in app/globals.css.
 * `readOnly` shows code to read (predict exercises); `holes` makes only
 * those gaps editable (fill exercises — components/code-holes.ts), and
 * every change then reports the current hole ranges too. `assist` arms
 * clangd's completions and diagnostics (components/code-assist.ts) on an
 * editable document.
 */
export function CodeEditor({
	initial,
	onChange,
	onRun,
	ariaLabel = "Code editor",
	readOnly = false,
	holes,
	assist,
}: {
	initial: string;
	onChange: (source: string, holes?: readonly HoleRange[]) => void;
	onRun?: () => void;
	ariaLabel?: string;
	readOnly?: boolean;
	holes?: readonly (number | HoleRange)[];
	assist?: { docId: string; language: CodeLanguage };
}) {
	const host = useRef<HTMLDivElement | null>(null);
	const onChangeRef = useRef(onChange);
	const onRunRef = useRef(onRun);
	onChangeRef.current = onChange;
	onRunRef.current = onRun;

	useEffect(() => {
		if (!host.current) return;
		const modeExtensions: Extension[] = readOnly
			? [EditorState.readOnly.of(true)]
			: holes
				? [codeHoles(holes)]
				: [placeholder("// write your code here")];
		if (assist && !readOnly) modeExtensions.push(codeAssist(assist));
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: initial,
				// Fill: the caret starts in the first gap.
				...(holes?.length ? { selection: { anchor: typeof holes[0] === "number" ? holes[0] : holes[0]!.from } } : {}),
				extensions: [
					lineNumbers(),
					history(),
					drawSelection(),
					highlightActiveLine(),
					indentOnInput(),
					bracketMatching(),
					closeBrackets(),
					indentUnit.of("    "),
					cpp(),
					syntaxHighlighting(classHighlighter),
					...modeExtensions,
					keymap.of([
						{
							key: "Mod-Enter",
							run: () => {
								onRunRef.current?.();
								return true;
							},
						},
						...(holes || readOnly ? [] : [indentWithTab]),
						...closeBracketsKeymap,
						...defaultKeymap,
						...historyKeymap,
					]),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) onChangeRef.current(u.state.doc.toString(), holes ? holeRanges(u.state) : undefined);
					}),
					EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: "false" }),
				],
			}),
		});
		// The editor owns Tab / Shift-Tab / Esc while focused: the window
		// shortcut layer must not also act on them (Esc would cancel
		// dictation or open the dismiss confirm, Shift-Tab would cycle the
		// thinking level). A native listener on the editor root: it runs
		// after CodeMirror's own handling, whether or not a keymap took it.
		const isolate = (e: KeyboardEvent) => {
			if (e.key === "Tab" || e.key === "Escape") e.stopPropagation();
		};
		view.dom.addEventListener("keydown", isolate);
		return () => {
			view.dom.removeEventListener("keydown", isolate);
			view.destroy();
		};
		// Seeded once by design: the editor owns its document from mount.
	}, []);

	return <div ref={host} className="lh-code-editor" data-testid="code-editor" />;
}
