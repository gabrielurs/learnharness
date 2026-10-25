import { NextResponse, type NextRequest } from "next/server";
import { browserAPIRequestAllowed, desktopAPIAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	// Browser mode (no desktop capability): same-origin pages only — see
	// browserAPIRequestAllowed (fork, 2026-10-25).
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || !!process.env.LH_DESKTOP_API_SECRET;
	if (!desktop && !browserAPIRequestAllowed(request.headers)) {
		return NextResponse.json(
			{ error: "Cross-origin or non-local requests to the LearnHarness API are refused." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
