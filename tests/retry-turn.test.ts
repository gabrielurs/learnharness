import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatInputError, assertRetryable, inputAppends, parseChatInput, trailingFailure, withoutTrailingFailures, type LhMessage } from "../src/core/index.ts";

/** Retry (fork, 2026-10-24): a failed model call strands the turn; the
 *  learner re-runs it from their last input. */
const user = { role: "user", content: "hola", timestamp: 1 } as unknown as LhMessage;
const answer = { role: "toolResult", toolCallId: "c1", toolName: "probe", content: [], isError: false, timestamp: 2 } as unknown as LhMessage;
const failed = (msg: string) => ({ role: "assistant", content: [], stopReason: "error", errorMessage: msg, timestamp: 3 }) as unknown as LhMessage;
const ok = { role: "assistant", content: [{ type: "text", text: "bien" }], stopReason: "stop", timestamp: 4 } as unknown as LhMessage;

describe("retry a failed turn", () => {
	it("detects a record that ends on a failed model call", () => {
		assert.equal(trailingFailure([user, answer, failed("Claude Code ended without a response (exit 143)")]), "Claude Code ended without a response (exit 143)");
		assert.equal(trailingFailure([user, ok]), null);
		assert.equal(trailingFailure([user, failed("x"), ok]), null, "a later success means nothing is stranded");
		assert.equal(trailingFailure([]), null);
	});

	it("drops every failed message at the tail — and nothing before it", () => {
		assert.deepEqual(withoutTrailingFailures([user, answer, failed("a"), failed("b")]), [user, answer]);
		assert.deepEqual(withoutTrailingFailures([user, failed("a"), ok]), [user, failed("a"), ok]);
	});

	it("parses, and refuses a retry with nothing to retry", () => {
		assert.deepEqual(parseChatInput({ type: "retry" }), { type: "retry" });
		assert.deepEqual(inputAppends({ messages: [user, answer, failed("x")] }, { type: "retry" }), []);
		assert.throws(() => inputAppends({ messages: [user, ok] }, { type: "retry" }), ChatInputError);
	});

	it("UI-only markers after the failure never hide it (upstream PR #184): plan block, compaction", () => {
		const plan = { role: "custom", customType: "plan-block", content: "", display: true, timestamp: 5 } as unknown as LhMessage;
		const compaction = { role: "custom", customType: "compaction", content: "summary", display: false, timestamp: 6 } as unknown as LhMessage;
		const f = failed("boom");
		assert.equal(trailingFailure([user, answer, f, plan]), "boom", "plan_init succeeded, the next call failed");
		assert.equal(trailingFailure([user, f, compaction]), "boom", "the settle kick compacted after the failure");
		assert.deepEqual(withoutTrailingFailures([user, answer, f, plan]), [user, answer, plan], "the failure goes, the marker stays");
		assert.deepEqual(inputAppends({ messages: [user, answer, f, plan] }, { type: "retry" }), []);
		const note = { role: "custom", customType: "graph-context", content: "", display: false, timestamp: 7 } as unknown as LhMessage;
		assert.equal(trailingFailure([user, f, note]), null, "any other message after the failure still counts as later");
	});

	it("refuses a retry that would leave nothing to run from (an assistant before the failure)", () => {
		assert.throws(() => assertRetryable([user, ok, failed("x")]), /no input left/);
		assert.throws(() => assertRetryable([failed("x")]), /no input left/);
		assert.doesNotThrow(() => assertRetryable([user, failed("x")]));
	});
});
