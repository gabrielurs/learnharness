import { timingSafeEqual } from "node:crypto";

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential. Browser-only mode is unchanged. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) return true;
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/**
 * Browser-mode request guard (fork, 2026-10-25 audit): without the desktop
 * capability, ANY web page the learner has open could POST to this API — a
 * cross-origin "simple" request (text/plain body) skips CORS preflight, and
 * /api/code/run compiles and runs what it is sent. Refused:
 *  - a Host outside loopback (DNS rebinding) unless listed in
 *    LH_ALLOWED_HOSTS (comma-separated host[:port]). A LAN client can
 *    forge Host, so LAN exposure is closed by BINDING to loopback (the
 *    dev/start scripts pass -H 127.0.0.1; the desktop server binds it too);
 *  - Sec-Fetch-Site other than same-origin / none (typed URL, bookmark);
 *  - an Origin that is not this host ("null" included).
 * A request with neither header is a non-browser client (curl, tests) and
 * cannot be forged by a web page, so it passes the origin checks.
 */
export function browserAPIRequestAllowed(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const host = (headers.get("host") ?? "").toLowerCase();
	const allowed = (env.LH_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
	if (!LOOPBACK_HOST.test(host) && !allowed.includes(host)) return false;
	const site = headers.get("sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none") return false;
	const origin = headers.get("origin");
	if (origin !== null) {
		try {
			if (new URL(origin).host.toLowerCase() !== host) return false;
		} catch {
			return false;
		}
	}
	return true;
}
