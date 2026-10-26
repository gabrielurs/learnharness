import { autocompletion, insertCompletionText, pickedCompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import type { CodeCompletionResult, CodeDiagnosticsResult, CodeLanguage } from "@/src/core";

/**
 * IDE assistance in the code editor (owner, 2026-10-25): clangd's
 * completions — a list while typing, Enter accepts, Esc closes, snippet
 * fields walked with Tab — and its errors/warnings underlined as you type.
 * Both go through POST /api/code/{complete,diagnostics}; the server spawns
 * clangd (in Docker) on demand. While it is unavailable — Docker closed,
 * its image still building — the editor is plain and asks again only
 * after ASSIST_RETRY_MS (owner, 2026-10-26), so assistance comes back by
 * itself when Docker does, without a reload.
 */

/** After an "unavailable" answer, the next request waits this long. */
export const ASSIST_RETRY_MS = 30_000;
let unavailableUntil = 0;
const unavailable = () => Date.now() < unavailableUntil;
const markUnavailable = () => void (unavailableUntil = Date.now() + ASSIST_RETRY_MS);

/** clangd's LSP snippet → CodeMirror's template (`$1` → `${1}`; `${1:x}`
 *  and `${0}` read the same; `\$` unescapes). */
export function lspSnippetToCodeMirror(text: string): string {
	return text.replace(/\\\$/g, "\u0000").replace(/\$(\d+)/g, "${$1}").replace(/\u0000/g, "$");
}

/** LSP CompletionItemKind → CodeMirror's completion type (its icon). */
const KIND_TYPE: Record<number, string> = {
	1: "text", 2: "method", 3: "function", 4: "function", 5: "property", 6: "variable", 7: "class", 8: "interface",
	9: "namespace", 10: "property", 12: "constant", 13: "enum", 14: "keyword", 15: "text", 20: "constant", 21: "constant",
	22: "class", 25: "type",
};

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
	try {
		const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
		return res.ok ? ((await res.json()) as T) : null;
	} catch {
		return null;
	}
}

/** The completion and lint sources for one document (exported for tests;
 *  the editor takes them through codeAssist). */
export function assistSources({ docId, language }: { docId: string; language: CodeLanguage }) {
	const id = docId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "doc";

	const complete = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
		if (unavailable()) return null;
		const word = ctx.matchBefore(/[A-Za-z_]\w*/);
		const member = /(?:\.|->|::)$/.test(ctx.state.sliceDoc(Math.max(0, ctx.pos - 2), ctx.pos));
		if (!ctx.explicit && !member && (!word || word.from === word.to)) return null;
		const abort = new AbortController();
		ctx.addEventListener("abort", () => abort.abort(), { onDocChange: true });
		const result = await post<CodeCompletionResult>(
			"/api/code/complete",
			{ docId: id, language, source: ctx.state.doc.toString(), offset: ctx.pos },
			abort.signal,
		);
		if (!result) return null;
		if (!result.available) {
			markUnavailable();
			return null;
		}
		if (result.items.length === 0) return null;
		const from = result.items[0]!.from;
		const options: Completion[] = result.items.map((item) => {
			const template = item.snippet ? snippet(lspSnippetToCodeMirror(item.insert)) : null;
			// The list shares one `from`; an item whose own edit starts
			// elsewhere keeps its range, shifted with the list's.
			const shift = item.from - from;
			const apply: Completion["apply"] =
				shift === 0
					? (template ?? item.insert)
					: (view, completion, start, end) => {
							// Clamped: the document may have moved since the request.
							const at = Math.min(Math.max(0, start + shift), end);
							if (template) template(view, completion, at, end);
							else view.dispatch({ ...insertCompletionText(view.state, item.insert, at, end), annotations: pickedCompletion.of(completion) });
						};
			return {
				label: item.label,
				...(item.detail ? { detail: item.detail } : {}),
				...(item.kind !== undefined && KIND_TYPE[item.kind] ? { type: KIND_TYPE[item.kind] } : {}),
				apply,
			};
		});
		// Keep filtering locally while the word grows — no request per key.
		return { from, options, validFor: /^\w*$/ };
	};

	const diagnose = async (view: { state: { doc: { toString(): string; length: number } } }): Promise<Diagnostic[]> => {
		if (unavailable()) return [];
		const source = view.state.doc.toString();
		const result = await post<CodeDiagnosticsResult>("/api/code/diagnostics", { docId: id, language, source });
		if (!result) return [];
		if (!result.available) {
			markUnavailable();
			return [];
		}
		const length = view.state.doc.length;
		return result.diagnostics.map((d) => ({
			from: Math.min(d.from, length),
			to: Math.min(Math.max(d.to, d.from), length),
			severity: d.severity,
			message: d.message,
			source: "clangd",
		}));
	};

	return { complete, diagnose };
}

/** The editor's assist extension for one document. `docId` must be stable
 *  for the exercise (clangd keeps the document open under it). */
export function codeAssist(doc: { docId: string; language: CodeLanguage }): Extension {
	const { complete, diagnose } = assistSources(doc);
	return [autocompletion({ override: [complete], icons: true }), linter(diagnose, { delay: 700 })];
}

/** Tests: forget a previous "unavailable" answer. */
export function resetAssistAvailability(): void {
	unavailableUntil = 0;
}
