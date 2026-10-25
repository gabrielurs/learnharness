import assert from "node:assert/strict";
import { test } from "node:test";
import { browserAPIRequestAllowed } from "../src/server/desktop-access.ts";

/** Browser-mode API guard (fork, 2026-10-25 audit): a cross-origin simple
 *  POST used to compile and run C via /api/code/run. */

const allowed = (h: Record<string, string>, env: Record<string, string> = {}) => browserAPIRequestAllowed(new Headers(h), env);

test("same-origin app requests, typed URLs and non-browser clients pass", () => {
	assert.ok(allowed({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }));
	assert.ok(allowed({ host: "127.0.0.1:3000", "sec-fetch-site": "none" }));
	assert.ok(allowed({ host: "[::1]:3000" }));
	assert.ok(allowed({ host: "127.0.0.1:3000" }), "curl / tests: no Origin, no Sec-Fetch-Site");
});

test("cross-origin pages are refused, simple requests included", () => {
	assert.ok(!allowed({ host: "127.0.0.1:3000", origin: "https://evil.example", "content-type": "text/plain" }));
	assert.ok(!allowed({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }));
	assert.ok(!allowed({ host: "localhost:3000", "sec-fetch-site": "same-site", origin: "http://localhost:3001" }), "another local port");
	assert.ok(!allowed({ host: "localhost:3000", origin: "null" }), "sandboxed iframe / file:");
	assert.ok(!allowed({ host: "localhost:3000", origin: "http://localhost:3001" }));
});

test("non-loopback Host (DNS rebinding, LAN) is refused unless allow-listed", () => {
	assert.ok(!allowed({ host: "evil.example:3000", origin: "http://evil.example:3000", "sec-fetch-site": "same-origin" }));
	assert.ok(!allowed({ host: "192.168.1.15:3000" }));
	assert.ok(!allowed({}), "no Host at all");
	assert.ok(allowed({ host: "mac.lan:3000", origin: "http://mac.lan:3000" }, { LH_ALLOWED_HOSTS: "mac.lan:3000" }));
});
