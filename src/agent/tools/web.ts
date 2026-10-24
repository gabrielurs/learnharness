import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
// The search-hit shape lives in the core port since the search wave
// (2026-09-20); this alias keeps callers churn-free.
import type { SearchHit as WebSearchResult, SearchProvider } from "../../core/search.ts";
export type { WebSearchResult };
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * Server-side web tools for the researcher sub-agent — a minimal port of the
 * pi extensions (~/.pi/agent/extensions/web-search + web-fetch):
 *
 *   web_search(query, count?) → {title, url, snippet}[]   (injected search port)
 *   web_fetch(url)            → readable markdown text     (Readability + Turndown,
 *                                                          Jina Reader fallback for
 *                                                          JS-rendered pages)
 *
 * SEARCH REWIRING (search port wave, 2026-09-20): the Google CSE backend is
 * retired — web_search now runs on the injected search port (core/search.ts).
 * The live adapter (Tavily/Brave — server/search.ts) arrives as a DEPENDENCY
 * (import law: this tool depends on the core port, never server code). NO
 * silent fallback (owner decision): provider absent → search is honestly
 * unavailable, and the composition root drops the research dispatch tool on
 * the same signal (the jobTools seam, src/agent/tools/jobs.ts).
 *
 * Tool contract: NEVER throw into the agent loop — missing provider and
 * every failure path return a clear error STRING as the tool output, so the
 * researcher can adapt (or report) instead of crashing.
 */

// ── web_search ───────────────────────────────────────────────────────────────
// (WebSearchResult is the core SearchHit, re-exported above.)

// ── web_fetch ────────────────────────────────────────────────────────────────

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Keep the researcher's context sane — long pages truncate with a marker. */
const MAX_CONTENT_CHARS = 40_000;
/** Below this, a Readability extraction is suspected to be a JS shell. */
const THIN_CONTENT_CHARS = 1_500;
const MIN_USEFUL_CONTENT = 200;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function truncate(text: string): string {
	if (text.length <= MAX_CONTENT_CHARS) return text;
	return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[Truncated at ${MAX_CONTENT_CHARS} characters]`;
}

/** Jina Reader fallback for JS-rendered pages (no deps — plain fetch). */
async function fetchViaJina(url: string): Promise<string | null> {
	try {
		const res = await fetch(`https://r.jina.ai/${url}`, {
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const content = await res.text();
		const marker = "Markdown Content:";
		const start = content.indexOf(marker);
		if (start < 0) return null;
		const markdown = content.slice(start + marker.length).trim();
		if (markdown.length < MIN_USEFUL_CONTENT || markdown.startsWith("Loading...")) return null;
		return markdown;
	} catch {
		return null;
	}
}

function htmlToMarkdown(html: string): { title: string; content: string } | null {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as Document).parse();
	if (!article?.content) return null;
	const markdown = turndown.turndown(article.content);
	if (markdown.trim().length < MIN_USEFUL_CONTENT) return null;
	return { title: article.title ?? "", content: markdown };
}

async function fetchAndExtract(url: string): Promise<string> {
	const resp = await fetch(url, {
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

	// Final URL after redirects + status — the researcher's only way to
	// tell a real page from a 200-served error body (owner-reported
	// "ill-formed request" case: the SITE answered, we just relayed it).
	const sourceLine = `Source: ${resp.url || url} (HTTP ${resp.status})`;

	const contentType = resp.headers.get("content-type") ?? "";
	if (contentType.includes("application/pdf")) {
		// Pointer, not dead-end (researcher PDF wave, 2026-10-07): the
		// researcher's web_fetch_pdf tool downloads + triages PDFs.
		return `web_fetch: this URL is a PDF document — call web_fetch_pdf on it to download and read it.`;
	}
	if (/image\/|audio\/|video\/|zip|octet-stream/.test(contentType)) {
		throw new Error(`Unsupported content type: ${contentType.split(";")[0]}`);
	}
	const length = Number(resp.headers.get("content-length") ?? 0);
	if (length > MAX_RESPONSE_BYTES) throw new Error("Response too large");

	const text = await resp.text();
	if (!contentType.includes("html")) return `${sourceLine}\n\n${truncate(text)}`; // plain text / markdown / code

	const extracted = htmlToMarkdown(text);
	const local = extracted
		? (extracted.title ? `# ${extracted.title}\n\n${sourceLine}\n\n---\n\n` : `${sourceLine}\n\n---\n\n`) + extracted.content
		: null;
	// A THIN extraction (fork, 2026-10-24) is usually a JS-rendered page whose
	// shell Readability happily "succeeds" on (nav + footer only): try Jina
	// Reader too and keep the richer of the two.
	if (local && (extracted?.content.length ?? 0) >= THIN_CONTENT_CHARS) return truncate(local);
	// Readability failed or came back thin — likely JS-rendered. Try Jina Reader.
	const jina = await fetchViaJina(url);
	const best = [local, jina].filter((t): t is string => !!t).sort((a, b) => b.length - a.length)[0];
	if (best) return truncate(best);
	throw new Error("Could not extract readable content (the page may be JavaScript-rendered)");
}

/** Loopback, private, link-local and local-name hosts (literal checks —
 *  exported for tests). */
export function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
	if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
	const v4 = h.replace(/^::ffff:/, "").match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// ── tool registry ────────────────────────────────────────────────────────────

const webSearchInput = Type.Object({
	query: Type.String({ description: "The search query (a normal search string, phrases included)" }),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Number of results (default 5, max 10)" }),
	),
});

const webFetchInput = Type.Object({
	url: Type.String({ description: "The URL to fetch" }),
});

export function createWebTools(search: () => SearchProvider | null): Record<string, AgentTool<any>> {
	return {
		web_search: {
			name: "web_search",
			label: "web_search",
			description: "Search the web. One search per call — use one call per search angle. " +
				"Returns an array of results with title, url, and snippet.",
			parameters: webSearchInput,
			execute: serverExecute("web_search", webSearchInput, async ({ query, count }): Promise<WebSearchResult[] | string> => {
				const provider = search();
				if (!provider) {
					return (
						"web_search is not available: no search engine is configured. " +
						"Set a Tavily or Brave search API key in settings. Report in your brief that web search is unavailable."
					);
				}
				try {
					return await provider.search(query, count ?? 5);
				} catch (err) {
					return `web_search failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},

		web_fetch: {
			name: "web_fetch",
			label: "web_fetch",
			description:
				"Fetch a web page and extract its readable content as markdown (Readability). " +
				"Handles HTML pages and plain text; JS-rendered pages fall back to a reader service.",
			parameters: webFetchInput,
			execute: serverExecute("web_fetch", webFetchInput, async ({ url }): Promise<string> => {
				try {
					const parsed = new URL(url);
					// URL.protocol carries a TRAILING COLON ("https:", WHATWG) — the
					// colon-less comparison born from the py-harness port (urlparse's
					// scheme has NO colon) rejected every valid URL ever fetched
					// (owner-reported via OpenRouter logs, 2026-10-07).
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
						throw new Error("Only http(s) URLs are supported");
				} catch {
					return `web_fetch failed: invalid URL "${url}"`;
				}
				// Public web only (fork, 2026-10-24 — web_fetch is now always on
				// for the conversation agents): a fetched page could steer the
				// agent toward the learner's own machine or LAN (this app's API
				// included). Literal private/loopback hosts are refused.
				if (isPrivateHost(new URL(url).hostname)) {
					return `web_fetch refused: ${new URL(url).hostname} is a local or private-network address`;
				}
				try {
					return await fetchAndExtract(url);
				} catch (err) {
					return `web_fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`;
				}
			}),
		},
	};
}

/** web_fetch for the CONVERSATION agents (fork, 2026-10-24): reading a URL
 *  the learner hands over needs no search engine, so prober, teacher and
 *  practitioner carry it always — keyless. The page lands in the record
 *  as the tool result (truncated at MAX_CONTENT_CHARS), so later turns
 *  still have it. */
export const webFetchTool: AgentTool<any> = createWebTools(() => null).web_fetch!;

/** The provider-less backstop (tests pin the shape with it; the runner
 *  always injects the real seam — an absent seam reads as unavailable,
 *  never a crash and never a silent alternative engine). */
export const webTools = createWebTools(() => null);
