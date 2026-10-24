/**
 * Heavy-dependency reachability (perf round, 2026-10-24).
 *
 * mermaid (+ dagre/lodash, ~1MB+) used to load with every chat page, even
 * for sessions that never draw a diagram: components/mermaid-render.ts
 * imported the plugin statically. It now loads on the first renderMermaid
 * call. This suite walks the STATIC import graph (TypeScript's parser;
 * type-only imports and dynamic import() excluded — exactly what a bundler
 * puts in the initial chunk) from the chat page and asserts mermaid is not
 * reachable from any repo module. Bare packages are recorded, not walked.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveLocal(from: string, specifier: string): string | null {
	const base = specifier.startsWith("@/")
		? path.join(REPO, specifier.slice(2))
		: specifier.startsWith(".")
			? path.resolve(path.dirname(from), specifier)
			: null;
	if (!base) return null;
	for (const ext of EXTENSIONS) {
		const candidate = base + ext;
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

function staticSpecifiers(file: string): string[] {
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, false);
	const out: string[] = [];
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
			out.push((statement.moduleSpecifier as ts.StringLiteral).text);
		} else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
			out.push((statement.moduleSpecifier as ts.StringLiteral).text);
		}
	}
	return out;
}

/** Every bare package statically imported by any repo module reachable from entry → the importer chain. */
function reachablePackages(entry: string): Map<string, string[]> {
	const packages = new Map<string, string[]>();
	const seen = new Set<string>();
	const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [path.relative(REPO, entry)] }];
	while (queue.length) {
		const { file, chain } = queue.shift()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const specifier of staticSpecifiers(file)) {
			const local = resolveLocal(file, specifier);
			if (local) queue.push({ file: local, chain: [...chain, path.relative(REPO, local)] });
			else if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !packages.has(specifier)) packages.set(specifier, chain);
		}
	}
	return packages;
}

describe("static import graph of the chat page", () => {
	const packages = reachablePackages(path.join(REPO, "components", "chat.tsx"));

	it("the walk sees the page's real dependencies (sanity)", () => {
		assert.ok(packages.has("react"));
		assert.ok(packages.has("streamdown"), "the markdown renderer is (correctly) eager");
	});

	for (const heavy of ["mermaid", "@streamdown/mermaid"]) {
		it(`${heavy} is not statically reachable`, () => {
			assert.equal(packages.get(heavy), undefined, `${heavy} reached via ${packages.get(heavy)?.join(" → ")}`);
		});
	}
});

// node:crypto in a client graph pulls the crypto-browserify polyfill into
// every page. The shell reaches core only through the @/src/core barrel, so
// the barrel's own graph must stay free of it (coverage.ts hashes with it —
// server/agent code imports that module by direct path).
describe("static import graph of the core barrel (every page's client surface)", () => {
	const packages = reachablePackages(path.join(REPO, "src", "core", "index.ts"));

	it("node:crypto is not statically reachable", () => {
		assert.equal(packages.get("node:crypto"), undefined, `node:crypto reached via ${packages.get("node:crypto")?.join(" → ")}`);
	});
});
