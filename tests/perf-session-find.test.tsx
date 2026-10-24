/**
 * Session Find's rescan filter (perf round, 2026-10-24).
 *
 * With Find open during a turn, the Shimmer ("THINKING…", live tool cards)
 * rewrites its own inline backgroundPosition every animation frame, and
 * Find's MutationObserver watches `style` (inline display/visibility/opacity
 * really do hide text) — so it re-walked the whole transcript ~60×/s. The
 * Shimmer is now marked style-inert and Find skips exactly those records;
 * every other mutation still triggers a rescan, including style changes
 * anywhere else (the inline-hide paths Find must keep seeing).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { sessionFindMutationRelevant } from "../components/session-find-dom.ts";
import { Shimmer } from "../components/ai-elements/shimmer.tsx";

const { document } = parseHTML("<html><body></body></html>");

function el(html: string): Element {
	const host = document.createElement("div");
	host.innerHTML = html;
	return host.firstElementChild!;
}
const record = (over: Partial<MutationRecord>): MutationRecord => ({ type: "attributes", attributeName: "style", ...over }) as MutationRecord;

describe("sessionFindMutationRelevant", () => {
	const inert = el('<p data-session-find-style-inert="">THINKING…</p>');
	const plain = el("<p>visible text</p>");

	it("skips style-only changes on a style-inert element (the shimmer frame)", () => {
		assert.equal(sessionFindMutationRelevant(record({ target: inert })), false);
	});

	it("still sees style changes on any other element (inline hide paths)", () => {
		assert.equal(sessionFindMutationRelevant(record({ target: plain })), true);
		assert.equal(sessionFindMutationRelevant(record({ target: inert.parentElement! })), true, "an ancestor of the shimmer is not inert");
	});

	it("still sees every non-style change, inert element or not", () => {
		for (const target of [inert, plain]) {
			assert.equal(sessionFindMutationRelevant(record({ target, attributeName: "class" })), true);
			assert.equal(sessionFindMutationRelevant(record({ target, attributeName: "hidden" })), true);
			assert.equal(sessionFindMutationRelevant(record({ target, type: "childList", attributeName: null })), true);
			assert.equal(sessionFindMutationRelevant(record({ target: target.firstChild!, type: "characterData", attributeName: null })), true);
		}
	});
});

describe("Shimmer carries the style-inert marker", () => {
	it("renders the marker on its animated element, text unchanged", () => {
		const html = renderToStaticMarkup(<Shimmer>THINKING…</Shimmer>);
		const node = el(html);
		assert.ok(node.hasAttribute("data-session-find-style-inert"));
		assert.equal(node.textContent, "THINKING…");
	});
});
