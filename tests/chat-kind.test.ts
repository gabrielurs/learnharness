/**
 * SESSION-KIND PINS (practice sessions, owner 2026-10-04): ChatRecord.kind
 * is ABSENT-BY-DEFAULT — absence reads as teach, so pre-practice records
 * never migrate; "practice" marks an adaptive-practice session (the
 * practice agent + its two tools from turn 1, no extraction, no graph
 * writes). The store normalizes at the summary projection; createChat
 * stamps the marker only for practice. Runs under an isolated LH_DATA_DIR
 * (the chat-birth-stamp discipline: the seam is set before any
 * config-loading import, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-kind-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL } = await import("../src/core/native-messages.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("session kind (practice sessions, 2026-10-04)", () => {
	it("createChat default carries NO kind field — absence reads as teach", () => {
		const chat = chatStore.createChat("plain session");
		assert.equal("kind" in chat, false, "teach records carry no kind marker");
	});

	it("createChat(kind: 'practice') stamps the marker on record + list", () => {
		const chat = chatStore.createChat("practice session", "practice");
		assert.equal(chat.kind, "practice");
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.kind, "practice");
	});

	it("the summary projection NORMALIZES: absent record field reads as teach", () => {
		const chat = chatStore.createChat("another plain one");
		const listed = chatStore.listChats().find((c) => c.id === chat.id);
		assert.equal(listed?.kind, "teach");
	});
});

// The sidebar's "Problem waiting" (9362baf): the summary carries
// pendingProblem from the honest active-problem fold — a posed problem with
// a clean ack and no clean conclude. It was declared but never projected,
// so the meta line never showed.
describe("summary pendingProblem (the sidebar's 'Problem waiting')", () => {
	const stamps = {
		api: "faux",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
	};
	const toolPair = (callId: string, name: string, args: Record<string, unknown>, ack: string) => [
		{ id: `msg_a_${callId}`, role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], timestamp: 1, ...stamps },
		{ id: `msg_r_${callId}`, role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: ack }], details: null, isError: false, timestamp: 2 },
	];
	const pose = () => toolPair("call_p1", PRACTICE_PROBLEM_TOOL, { statement: "Show that…", mode: "recall", modelSolution: "…" }, "Problem posed — the turn ends here.");
	const conclude = () => toolPair("call_c1", PRACTICE_CONCLUDE_TOOL, { outcome: "solved" }, "Problem concluded.");
	const summaryOf = (id: string) => chatStore.listChats().find((c) => c.id === id)!;

	it("a posed, unconcluded problem → true", () => {
		const chat = chatStore.createChat("practice with a problem", "practice");
		chatStore.saveMessages(chat.id, pose() as never);
		assert.equal(summaryOf(chat.id).pendingProblem, true);
	});

	it("a concluded problem → false", () => {
		const chat = chatStore.createChat("practice, concluded", "practice");
		chatStore.saveMessages(chat.id, [...pose(), ...conclude()] as never);
		assert.equal(summaryOf(chat.id).pendingProblem, false);
	});

	it("no problem ever posed (any session kind) → false, never absent", () => {
		const practice = chatStore.createChat("fresh practice", "practice");
		const teach = chatStore.createChat("teach session");
		assert.equal(summaryOf(practice.id).pendingProblem, false);
		assert.equal(summaryOf(teach.id).pendingProblem, false);
	});
});
