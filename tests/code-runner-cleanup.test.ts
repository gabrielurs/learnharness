import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findCompiler, runCode } from "../src/server/code-runner.ts";

/** Code runner cleanup (fork, 2026-10-25 audit) — each case misbehaved
 *  before the fix: a surviving fork()ed child, a setsid child holding the
 *  run (and its slot) open, and a chmod'ed dir turning the result into a 500. */

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const FORK_ORPHAN = `#include <stdio.h>
#include <unistd.h>
int main(void){ pid_t p = fork(); if (p == 0) { close(1); close(2); for(;;) sleep(1); }
  printf("%d\\n", (int)p); return 0; }
`;

const SETSID_HOLDER = `#include <stdio.h>
#include <unistd.h>
int main(void){ pid_t p = fork(); if (p == 0) { setsid(); sleep(7); return 0; }
  printf("%d\\n", (int)p); fflush(stdout); return 0; }
`;

const CHMOD_DIR = `#include <stdio.h>
#include <sys/stat.h>
int main(void){ mkdir("d", 0700); FILE *f = fopen("d/x", "w"); if (f) fclose(f); chmod("d", 0); puts("ok"); return 0; }
`;

describe("code runner cleanup (real clang)", { skip: findCompiler("c") ? false : "no clang on this machine" }, () => {
	it("kills a fork()ed child when the program exits", async () => {
		const r = await runCode({ language: "c", source: FORK_ORPHAN, stdin: "" });
		const pid = Number(r.cases[0]!.stdout.trim());
		assert.ok(pid > 0, r.cases[0]!.stdout);
		await new Promise((res) => setTimeout(res, 100));
		assert.equal(alive(pid), false, "orphan still running");
	});

	it("a setsid child holding stdout neither stalls the run nor misgrades it", async () => {
		const t0 = Date.now();
		const r = await runCode({ language: "c", source: SETSID_HOLDER, tests: [{ stdin: "", expected: "" }] });
		const c = r.cases[0]!;
		assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
		assert.equal(c.timedOut, false);
		assert.equal(c.exitCode, 0);
		const pid = Number(c.stdout.trim());
		await new Promise((res) => setTimeout(res, 100));
		assert.equal(alive(pid), false, "setsid child still running");
	});

	it("an unreadable subdirectory doesn't replace the result with an error", async () => {
		const r = await runCode({ language: "c", source: CHMOD_DIR, stdin: "" });
		assert.equal(r.cases[0]!.stdout, "ok\n");
	});
});
