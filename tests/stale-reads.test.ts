import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STALE_READ_MAX_CHARS, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";

/** Stale bulky reads (fork, 2026-10-24): a big web_fetch/read result is
 *  projected as a stub once the learner has spoken again. */
const big = "x".repeat(STALE_READ_MAX_CHARS + 500);
const call = (id: string, name: string, args: object) =>
	({ id: `a_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: 1 }) as unknown as LhMessage;
const result = (id: string, name: string, text: string) =>
	({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1 }) as unknown as LhMessage;
const user = (text: string) => ({ id: `u_${text}`, role: "user", content: text, timestamp: 1 }) as unknown as LhMessage;
const textOf = (m: unknown) => JSON.stringify((m as { content: unknown }).content);

describe("stale bulky reads", () => {
	it("keeps a read whole within the run that made it", () => {
		const out = toLlmMessages([user("lee esto"), call("f1", "web_fetch", { url: "https://e.com" }), result("f1", "web_fetch", big)]);
		assert.ok(!textOf(out.at(-1)).includes("elided"));
	});

	it("elides it once the learner has spoken again — the record untouched", () => {
		const reply = { id: "a_reply", role: "assistant", content: [{ type: "text", text: "Leído." }], stopReason: "stop", timestamp: 1 } as unknown as LhMessage;
		const record = [user("lee esto"), call("f1", "web_fetch", { url: "https://e.com/page" }), result("f1", "web_fetch", big), reply, user("vale, sigue")];
		const out = toLlmMessages(record);
		const stub = textOf(out[2]);
		assert.match(stub, /web_fetch result elided from context/);
		assert.match(stub, /https:\/\/e\.com\/page/);
		assert.ok(stub.length < 1_200);
		assert.equal(textOf(record[2]).length > STALE_READ_MAX_CHARS, true, "the record keeps the full result");
	});

	it("a question answer counts as the learner speaking; small reads and other tools stay whole", () => {
		const record = [
			call("f1", "read", { path: "~/notes.md" }),
			result("f1", "read", big),
			call("f2", "web_fetch", { url: "https://small.com" }),
			result("f2", "web_fetch", "short page"),
			call("p1", "pdf", {}),
			result("p1", "pdf", big),
			call("q1", "quiz", {}),
			result("q1", "quiz", '{"correct":true}'),
		];
		const out = toLlmMessages(record);
		assert.match(textOf(out[1]), /read result elided.*notes\.md/);
		assert.equal(textOf(out[3]), JSON.stringify([{ type: "text", text: "short page" }]));
		assert.ok(!textOf(out[5]).includes("elided"), "only web_fetch/read elide");
	});

	it("a read the model never answered after stays whole (audit, 2026-10-25)", () => {
		// A steer lands right after the fetch result.
		const steered = toLlmMessages([user("lee esto"), call("f1", "web_fetch", { url: "https://e.com" }), result("f1", "web_fetch", big), user("y fíjate en la tabla")]);
		assert.ok(!textOf(steered[2]).includes("elided"));
		// The fetch and a question in ONE message; the answer arrives later.
		const both = {
			id: "a_both",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "f2", name: "web_fetch", arguments: { url: "https://e.com" } },
				{ type: "toolCall", id: "q2", name: "quiz", arguments: {} },
			],
			stopReason: "toolUse",
			timestamp: 1,
		} as unknown as LhMessage;
		const asked = toLlmMessages([user("hola"), both, result("f2", "web_fetch", big), result("q2", "quiz", '{"correct":true}')]);
		assert.ok(!textOf(asked[2]).includes("elided"));
		// A failed or aborted reply in between never saw the page either.
		for (const stopReason of ["error", "aborted"]) {
			const failed = { id: `a_${stopReason}`, role: "assistant", content: [], stopReason, timestamp: 1 } as unknown as LhMessage;
			const out = toLlmMessages([user("lee"), call("f3", "web_fetch", { url: "https://e.com" }), result("f3", "web_fetch", big), failed, user("sigue")]);
			assert.ok(!textOf(out[2]).includes("elided"), stopReason);
		}
	});
});
