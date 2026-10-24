/**
 * POST /api/code/run (fork, 2026-10-24) — compile the learner's C/C++ with
 * the local clang and run it on each test case (or once on stdin). Only
 * the posted source executes; tests are data (src/core/contracts/code.ts).
 */
import { CodeRunRequestError, parseCodeRunRequest } from "@/src/core";
import { CompilerMissingError, runCode } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
	let request;
	try {
		request = parseCodeRunRequest(await req.json().catch(() => null));
	} catch (err) {
		if (err instanceof CodeRunRequestError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	try {
		return Response.json(await runCode(request));
	} catch (err) {
		if (err instanceof CompilerMissingError) return Response.json({ error: err.message }, { status: 503 });
		throw err;
	}
}
