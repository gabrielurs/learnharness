"use client";

import { useEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";

/**
 * The C/C++ code editor (fork, 2026-10-24 — owner pick: CodeMirror 6).
 * Uncontrolled: `initial` seeds it once; every edit reports through
 * `onChange`. Tab indents (4 spaces); ⌘/Ctrl+Enter runs `onRun`.
 * Token colors are `tok-*` classes styled in app/globals.css.
 */
export function CodeEditor({
	initial,
	onChange,
	onRun,
	ariaLabel = "Code editor",
}: {
	initial: string;
	onChange: (source: string) => void;
	onRun?: () => void;
	ariaLabel?: string;
}) {
	const host = useRef<HTMLDivElement | null>(null);
	const onChangeRef = useRef(onChange);
	const onRunRef = useRef(onRun);
	onChangeRef.current = onChange;
	onRunRef.current = onRun;

	useEffect(() => {
		if (!host.current) return;
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: initial,
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
					placeholder("// write your code here"),
					keymap.of([
						{
							key: "Mod-Enter",
							run: () => {
								onRunRef.current?.();
								return true;
							},
						},
						indentWithTab,
						...closeBracketsKeymap,
						...defaultKeymap,
						...historyKeymap,
					]),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) onChangeRef.current(u.state.doc.toString());
					}),
					EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: "false" }),
				],
			}),
		});
		return () => view.destroy();
		// Seeded once by design: the editor owns its document from mount.
	}, []);

	return <div ref={host} className="lh-code-editor" data-testid="code-editor" />;
}
