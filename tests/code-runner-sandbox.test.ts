import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { describe, it } from "node:test";
import { findCompiler, runCode } from "../src/server/code-runner.ts";

/** The macOS sandbox around learner binaries (fork, 2026-10-25): no fork,
 *  no writes outside the run dir, no network, no reading $HOME, and a
 *  memory watchdog — while ordinary programs and sanitizer reports work. */

const sandboxed = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !!findCompiler("c");
const run = async (source: string, stdin = "") => (await runCode({ language: "c", source, stdin })).cases[0]!;

describe("code runner sandbox (macOS, real clang)", { skip: sandboxed ? false : "needs macOS sandbox-exec and clang" }, () => {
	it("ordinary programs and graded tests still work", async () => {
		const r = await runCode({
			language: "c",
			source: '#include <stdio.h>\nint main(void){int a,b; if(scanf("%d %d",&a,&b)!=2) return 1; printf("%d\\n",a+b); return 0;}\n',
			tests: [{ stdin: "2 3", expected: "5" }, { stdin: "40 2", expected: "42" }],
		});
		assert.deepEqual(r.cases.map((c) => c.passed), [true, true]);
	});

	it("sanitizer reports still reach stderr", async () => {
		const c = await run("#include <stdio.h>\nint main(void){int a[3]; for(int i=0;i<=3;i++) a[i]=i; printf(\"%d\\n\",a[0]); return 0;}\n");
		assert.match(c.stderr, /out of bounds/);
	});

	it("fork() is denied", async () => {
		const c = await run('#include <stdio.h>\n#include <unistd.h>\nint main(void){ printf("%d\\n", (int)fork()); return 0; }\n');
		assert.equal(c.stdout.trim(), "-1");
	});

	it("writes outside the run dir are denied; inside are fine", async () => {
		const outside = `/tmp/lh-sandbox-escape-${process.pid}.txt`;
		rmSync(outside, { force: true });
		const c = await run(`#include <stdio.h>\nint main(void){ FILE*f=fopen("${outside}","w"); FILE*g=fopen("ok.txt","w"); printf("%s %s\\n", f?"escaped":"denied", g?"ok":"no"); return 0; }\n`);
		assert.equal(c.stdout.trim(), "denied ok");
		assert.equal(existsSync(outside), false);
	});

	it("the network and the learner's home are off limits", async () => {
		const c = await run(`#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
int main(void){
  int s = socket(AF_INET, SOCK_STREAM, 0); struct sockaddr_in a = {0}; a.sin_family = AF_INET; a.sin_port = htons(3000);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  char p[512]; snprintf(p, sizeof p, "%s/.zshrc", "${process.env.HOME}");
  printf("%s %s\\n", (s >= 0 && connect(s, (void*)&a, sizeof a) == 0) ? "connected" : "no-net", fopen(p, "r") ? "read-home" : "no-home");
  return 0; }
`);
		assert.equal(c.stdout.trim(), "no-net no-home");
	});

	it("a memory hog is killed at the limit", async () => {
		const c = await run(`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static char *keep[64];
int main(void){ long sum = 0; for(int i=0;i<64;i++){ keep[i]=malloc(64<<20); if(!keep[i]) return 2; memset(keep[i],1,64<<20); sum += keep[i][i]; } printf("survived %ld\\n", sum); return 0; }
`);
		assert.doesNotMatch(c.stdout, /survived/);
		assert.match(c.stderr, /memory limit exceeded/);
	});
});
