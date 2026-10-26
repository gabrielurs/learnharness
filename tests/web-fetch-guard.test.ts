import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { describe, it, mock } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPrivateHost, webFetchTool } from "../src/agent/tools/web.ts";
import { createPdfReadTools } from "../src/agent/tools/pdf-read.ts";

/** web_fetch's public-web guard (fork, 2026-10-25 audit): each bypass below
 *  reached this app's own API before the fix. */

const fetchText = async (url: string) => JSON.stringify((await webFetchTool.execute("t", { url } as never)).content);

describe("web_fetch guard: literal hosts", () => {
	it("refuses IPv4-mapped IPv6 (both forms) and trailing-dot names", () => {
		for (const h of ["[::ffff:7f00:1]", "::ffff:127.0.0.1", "[::ffff:c0a8:10a]", "localhost.", "LOCALHOST..", "224.0.0.1", "[fe90::1]", "[ff02::1]"]) {
			assert.equal(isPrivateHost(h), true, h);
		}
	});

	it("no longer refuses public names that merely start with fc/fd", () => {
		for (const h of ["fcc.gov", "fdroid.org", "fda.gov", "fc2.com"]) assert.equal(isPrivateHost(h), false, h);
	});

	it("refuses IPv4 embedded in IPv6 forms, keeps public IPv6 (audit W2, 2026-10-26)", () => {
		for (const h of ["[::7f00:1]", "[::ffff:0:7f00:1]", "[64:ff9b::7f00:1]", "[64:ff9b::192.168.1.1]", "[2002:7f00:1::]", "[2002:c0a8:101::1]", "[fec0::1]"]) {
			assert.equal(isPrivateHost(h), true, h);
		}
		for (const h of ["[2001:4860:4860::8888]", "[2606:4700:4700::1111]", "[64:ff9b::8.8.8.8]"]) assert.equal(isPrivateHost(h), false, h);
	});

	it("execute refuses the mapped and trailing-dot forms without fetching", async () => {
		assert.match(await fetchText("http://[::ffff:127.0.0.1]:3000/api/activity"), /refused/);
		assert.match(await fetchText("http://localhost.:3000/api/activity"), /refused/);
		assert.match(await fetchText("ftp://example.com/"), /invalid URL|Only http/);
		assert.match(await fetchText("http://no-such-host.invalid/"), /could not resolve/);
	});

	it("web_fetch_pdf goes through the same guard", async () => {
		const pdf = createPdfReadTools(mkdtempSync(path.join(tmpdir(), "lh-pdf-guard-"))).web_fetch_pdf!;
		const r = JSON.stringify((await pdf.execute("t", { url: "http://127.0.0.1:3000/api/x.pdf" } as never)).content);
		assert.match(r, /local or private-network address/);
	});
});

const online = await lookup("httpbin.org").then(() => true, () => false);

describe("web_fetch guard: DNS and redirects (network)", { skip: online ? false : "offline" }, () => {
	it("refuses a public name that resolves to loopback", async () => {
		assert.match(await fetchText("http://127.0.0.1.nip.io:3000/api/activity"), /refused: .*resolves to/);
	});

	it("a DNS answer that flips to loopback at connect time is refused (rebinding)", async () => {
		// assertPublicUrl's lookup (dns/promises) sees the real, public answer;
		// the socket's own lookup is made to answer 127.0.0.1 — the pinned
		// connection must refuse it instead of connecting.
		const fake = mock.method(dns, "lookup", (_host: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
			cb(null, [{ address: "127.0.0.1", family: 4 }]),
		);
		syncBuiltinESMExports();
		try {
			assert.match(await fetchText("http://example.com:3000/api/activity"), /refused: .*resolves to .*127\.0\.0\.1/);
		} finally {
			fake.mock.restore();
			syncBuiltinESMExports();
		}
		assert.match(await fetchText("https://en.wikipedia.org/wiki/Pomodoro_Technique"), /Pomodoro/);
	});

	it("refuses a public URL that redirects to loopback", async () => {
		const target = encodeURIComponent("http://127.0.0.1:3000/api/activity");
		assert.match(await fetchText(`https://httpbin.org/redirect-to?url=${target}`), /refused: 127\.0\.0\.1/);
	});
});
