/**
 * POST /api/code/diagnostics (owner, 2026-10-25) — clangd's errors and
 * warnings for the editor's text (src/server/clangd.ts). POST only: clangd
 * is spawned on demand, never from a GET. `available: false` = no clangd
 * right now (Docker closed or its image still building).
 */
import { CodeRunRequestError, parseCodeAssistRequest } from "@/src/core";
import { clangdDiagnostics } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	let request;
	try {
		request = parseCodeAssistRequest(await req.json().catch(() => null), false);
	} catch (err) {
		if (err instanceof CodeRunRequestError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	try {
		return Response.json(await clangdDiagnostics(request));
	} catch {
		return Response.json({ available: true, diagnostics: [] });
	}
}
