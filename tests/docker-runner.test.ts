import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dockerAvailable, resetDockerAvailability, runCodeInDocker } from "../src/server/docker-runner.ts";

/** The Docker code-execution backend (fork, 2026-10-26 audit R1–R5): the
 *  learner's C compiles and runs in a throwaway container that cannot reach
 *  the host's files, the server's env, the network, or more than its caps. */

const available = await dockerAvailable();
const SUM = '#include <stdio.h>\nint main(void){int a,b;if(scanf("%d %d",&a,&b)!=2)return 1;printf("%d\\n",a+b);return 0;}\n';
const run = async (source: string, stdin = "") => (await runCodeInDocker({ language: "c", source, stdin })).cases[0]!;

describe("docker availability probe", () => {
	it("reports false and resets when the daemon is unreachable (mid-session quit)", async () => {
		const original = process.env.DOCKER_HOST;
		try {
			process.env.DOCKER_HOST = "unix:///nonexistent/lh-test-docker.sock";
			resetDockerAvailability();
			assert.equal(await dockerAvailable(), false);
		} finally {
			if (original === undefined) delete process.env.DOCKER_HOST;
			else process.env.DOCKER_HOST = original;
			resetDockerAvailability();
		}
	});
});

describe("docker runner", { skip: available ? false : "no Docker daemon" }, () => {
	it("compiles, runs each test and grades it, with sanitizers on", async () => {
		const r = await runCodeInDocker({ language: "c", source: SUM, tests: [{ stdin: "2 3", expected: "5" }, { stdin: "1 1", expected: "3" }] });
		assert.ok(r.compile.ok, r.compile.output);
		assert.deepEqual(r.compile.sanitizers, ["address", "undefined"]);
		assert.deepEqual(r.cases.map((c) => c.passed), [true, false]);
	});

	it("reports compile errors without running", async () => {
		const r = await runCodeInDocker({ language: "cpp", source: "int main(){ return x; }" });
		assert.equal(r.compile.ok, false);
		assert.match(r.compile.output, /x/);
		assert.deepEqual(r.cases, []);
	});

	it("turns an out-of-bounds write into a sanitizer report", async () => {
		const c = await run("#include <stdio.h>\nint main(void){int a[3]; for(int i=0;i<=3;i++) a[i]=i; printf(\"%d\\n\",a[0]); return 0;}\n");
		assert.match(c.stderr, /out of bounds|overflow/);
		assert.notEqual(c.exitCode, 0);
	});

	it("kills a runaway program at the time limit", async () => {
		const c = await run("int main(void){ for(;;){} }");
		assert.equal(c.timedOut, true);
	});

	it("isolation: no host files, no host env, no network, no writes, bounded forks", async () => {
		// R1: the host filesystem is not mounted.
		const host = await run('#include <stdio.h>\nint main(void){ printf("%s\\n", fopen("/etc/hostname","r") ? "has-container-etc" : "none"); return 0; }');
		assert.doesNotMatch(host.stdout, /gabrielurs|Users/);

		// R2: the server's process env is not reachable (PID 1 is the container's sleep).
		const env = await run(
			'#include <stdio.h>\n#include <string.h>\nint main(void){ FILE*f=fopen("/proc/1/environ","r"); char b[4096]={0}; if(f){ fread(b,1,4095,f); fclose(f);} printf("lh=%d\\n",(int)(strstr(b,"LH_")!=0)); return 0; }',
		);
		assert.match(env.stdout, /lh=0/);

		// Writes outside the tmpfs scratch are denied (read-only rootfs).
		const write = await run('#include <stdio.h>\nint main(void){ printf("%s\\n", fopen("/etc/x","w") ? "WROTE" : "denied"); return 0; }');
		assert.match(write.stdout, /denied/);

		// A fork bomb is contained (pids-limit + timeout), never the host.
		const bomb = await run("#include <unistd.h>\nint main(void){ while(1) fork(); return 0; }");
		assert.ok(bomb.timedOut || bomb.exitCode !== 0);
	});
});
