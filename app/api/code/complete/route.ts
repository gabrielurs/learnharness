/**
 * POST /api/code/complete (owner, 2026-10-25) — clangd completions at the
 * editor's caret (src/server/clangd.ts). POST only: clangd is spawned on
 * demand, never from a GET. `available: false` = no clangd right now (Docker
 * closed or its image still building).
 */
import { CodeRunRequestError, parseCodeAssistRequest } from "@/src/core";
import { clangdComplete } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	let request;
	try {
		request = parseCodeAssistRequest(await req.json().catch(() => null), true);
	} catch (err) {
		if (err instanceof CodeRunRequestError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	try {
		return Response.json(await clangdComplete(request));
	} catch {
		// clangd hiccups (a timeout, a crash) degrade to "no suggestions".
		return Response.json({ available: true, items: [] });
	}
}
