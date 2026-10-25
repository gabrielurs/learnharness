/**
 * Store read-path equivalence + read-count guards (perf round, 2026-10-24).
 *
 * The sidebar list, the activity feed, the graph snapshot's session labels
 * and the graph cost pill all used to re-parse every chat transcript (and,
 * for the feed, every job file once PER CHAT). This suite pins their OUTPUT
 * to reference implementations copied verbatim from the pre-cache code, so
 * the cached paths can only ever be faster — never different — and guards
 * the read counts so the quadratic scans cannot come back.
 *
 * Own temp data dir, set BEFORE any config-loading import (every app-module
 * import is dynamic) — npm test's shared LH_DATA_DIR is never touched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { describe, it, mock } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, "fixtures", "golden-data");

// the broken-projection fixture logs its honest refusal on every list — expected here
mock.method(console, "error", () => {});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-perf-reads-"));
process.env.LH_DATA_DIR = TMP;

const CHATS = path.join(TMP, "chats");
const JOBS = path.join(TMP, "jobs");
fs.mkdirSync(CHATS, { recursive: true });
fs.mkdirSync(JOBS, { recursive: true });
fs.cpSync(path.join(GOLDEN, "graph"), path.join(TMP, "graph"), { recursive: true });

// ── fixtures: real golden transcripts cloned under the graph's provenance ids ──
const TEACH = JSON.parse(fs.readFileSync(path.join(GOLDEN, "chats", "chat_mv27rrra_feff23b6.json"), "utf-8"));
const PRACTICE = JSON.parse(fs.readFileSync(path.join(GOLDEN, "chats", "chat_mv293wv5_10656952.json"), "utf-8"));

function usageRun(startedAt: number) {
	const step = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: undefined };
	return {
		startedAt,
		at: new Date(startedAt).toISOString(),
		durationMs: 4200,
		stages: {
			extractor: { model: "openrouter:anthropic/claude-sonnet-4.5", steps: [step] },
			auditor: { model: "openrouter:anthropic/claude-sonnet-4.5", steps: [step, step] },
		},
	};
}

// graph provenance ids (tests/fixtures/golden-data/graph/nodes.jsonl) that get a real record
const LABELLED = ["chat_munfo08r_8172fd8a", "chat_muvot9vr_d0a5dd8f", "chat_musxkzk4_b84ec3f5"];
const BROKEN_PROJECTION = "chat_mv19m6xe_1481b07e"; // readable record, summary projection throws
const FUTURE_VERSION = "chat_mur9v4qb_fb4c99e5"; // stamped newer than this build — reads as absent
const TIE_A = "chat_tie00000_aaaaaaaa";
const TIE_B = "chat_tie00000_bbbbbbbb";
const TIE_AT = "2026-10-20T10:00:00.000Z";

function writeRecord(id: string, record: Record<string, unknown>): void {
	fs.writeFileSync(path.join(CHATS, `${id}.json`), JSON.stringify(record, null, "\t"), "utf-8");
}

LABELLED.forEach((id, i) => {
	const template = i % 2 === 0 ? TEACH : PRACTICE;
	writeRecord(id, {
		...template,
		id,
		title: `Labelled session ${i}`,
		updatedAt: `2026-10-1${i}T08:00:00.000Z`,
		...(i === 0 ? { extractions: [usageRun(1_760_000_000_000), usageRun(1_760_000_100_000)] } : {}),
	});
});
for (let i = 0; i < 9; i++) {
	const id = `chat_bulk000${i}_0000000${i}`;
	writeRecord(id, {
		...(i % 3 === 0 ? PRACTICE : TEACH),
		id,
		title: `Bulk ${i}`,
		updatedAt: `2026-09-${String(10 + i).padStart(2, "0")}T12:00:00.000Z`,
		...(i % 4 === 1 ? { extractions: [usageRun(1_759_000_000_000 + i)] } : {}),
	});
}
writeRecord(TIE_A, { ...TEACH, id: TIE_A, title: "Tie A", updatedAt: TIE_AT });
writeRecord(TIE_B, { ...TEACH, id: TIE_B, title: "Tie B", updatedAt: TIE_AT, extractions: [usageRun(1_761_000_000_000)] });
writeRecord(BROKEN_PROJECTION, { ...TEACH, id: BROKEN_PROJECTION, title: "Broken projection", messages: null, extractions: [usageRun(1_762_000_000_000)] });
writeRecord(FUTURE_VERSION, { ...TEACH, id: FUTURE_VERSION, title: "From the future", version: 999 });
fs.writeFileSync(path.join(CHATS, "chat_corrupt0_00000000.json"), "{ not json", "utf-8");
fs.writeFileSync(path.join(CHATS, "README.txt"), "not a record", "utf-8");
fs.writeFileSync(path.join(CHATS, `${TIE_A}.json.tmp-deadbeef`), "{ torn", "utf-8");

// jobs: the golden records plus running ones across chats (ties included),
// one on the broken-projection chat and one on a chat that does not exist
for (const f of fs.readdirSync(path.join(GOLDEN, "jobs"))) fs.copyFileSync(path.join(GOLDEN, "jobs", f), path.join(JOBS, f));
function writeJob(id: string, chatId: string, status: string, updatedAt: string, usage?: Record<string, unknown>): void {
	const job = { id, kind: "research", chatId, toolCallId: `tc_${id}`, status, activity: "working", createdAt: updatedAt, updatedAt, ...(usage ? { usage } : {}) };
	fs.writeFileSync(path.join(JOBS, `${id}.json`), JSON.stringify(job, null, "\t"), "utf-8");
}
writeJob("job_run00001_aaaaaaaa", LABELLED[0]!, "running", "2026-10-21T09:00:00.000Z", { model: "openrouter:anthropic/claude-sonnet-4.5", steps: 2 });
writeJob("job_run00002_bbbbbbbb", LABELLED[0]!, "running", TIE_AT);
writeJob("job_run00003_cccccccc", TIE_A, "running", TIE_AT);
writeJob("job_run00004_dddddddd", TIE_B, "running", TIE_AT);
writeJob("job_run00005_eeeeeeee", LABELLED[1]!, "running", "2026-10-19T09:00:00.000Z");
writeJob("job_run00006_ffffffff", LABELLED[1]!, "done", "2026-10-22T09:00:00.000Z");
writeJob("job_run00007_gggggggg", BROKEN_PROJECTION, "running", "2026-10-18T09:00:00.000Z");
writeJob("job_run00008_hhhhhhhh", "chat_ghost000_00000000", "running", "2026-10-17T09:00:00.000Z");

// ── the app modules, AFTER the seam ──────────────────────────────────────────
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { stores } = await import("../src/server/stores.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const { graphCosts, graphView } = await import("../src/server/graph.ts");
const { graphCostSummary } = await import("../src/core/cost-summary.ts");
const { callCost, jobCost } = await import("../src/server/pricing.ts");
const { graphSnapshot } = await import("../src/core/graph.ts");
const { catalogContextLimits } = await import("../src/server/model-catalog.ts");
const { phaseAt3Lh } = await import("../src/core/phases.ts");
const { activeProblemOf, danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { CURRENT_CHAT_VERSION } = await import("../src/core/contracts.ts");
type ChatRecord = import("../src/core/contracts.ts").ChatRecord;
type ChatSummary = import("../src/core/contracts.ts").ChatSummary;
type JobRecord = import("../src/core/contracts.ts").JobRecord;
type ChatStore = import("../src/core/ports.ts").ChatStore;

// ── reference implementations: the pre-cache code, verbatim in behavior ─────
function refGetChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(CHATS, `${id}.json`), "utf-8"));
	} catch {
		return null;
	}
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) return null;
	return parsed as ChatRecord;
}

function refListChats(): ChatSummary[] {
	return fs
		.readdirSync(CHATS)
		.filter((f) => f.endsWith(".json"))
		.map((f) => refGetChat(f.slice(0, -5)))
		.filter((r): r is ChatRecord => r !== null)
		.map(({ messages, tree, turns, extractions, ...summary }) => {
			void tree;
			void turns;
			void extractions;
			try {
				return {
					...summary,
					kind: summary.kind ?? "teach",
					messageCount: messages.length,
					phase: phaseAt3Lh(messages),
					pendingQuestion: danglingQuestionOf(messages) !== null,
					// the one intentional projection change since the copy: the
					// declared-but-never-projected field (tests/chat-kind.test.ts)
					pendingProblem: activeProblemOf(messages) !== null,
				};
			} catch {
				return null;
			}
		})
		.filter((s): s is ChatSummary => s !== null)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function refListJobs(chatId: string): JobRecord[] {
	return fs
		.readdirSync(JOBS)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			try {
				return JSON.parse(fs.readFileSync(path.join(JOBS, f), "utf-8")) as JobRecord;
			} catch {
				return null;
			}
		})
		.filter((j): j is JobRecord => j !== null && j.chatId === chatId)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function refFeedJobs() {
	const limits = catalogContextLimits();
	const jobs = [];
	for (const chat of refListChats()) {
		for (const job of refListJobs(chat.id)) {
			if (job.status === "running") {
				jobs.push({ ...job, costUsd: jobCost(job), title: chat.title ?? chat.id, contextLimit: job.usage ? (limits.get(job.usage.model) ?? null) : null });
			}
		}
	}
	jobs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	return jobs;
}

function refGraphCosts() {
	const chats = refListChats().flatMap((summary) => {
		const record = refGetChat(summary.id);
		return record?.extractions?.length ? [{ title: record.title ?? summary.id, extractions: record.extractions }] : [];
	});
	const sources = stores.graphStore
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources }, callCost);
}

/** A ChatStore whose every read is the naive full parse — what the graph
 *  snapshot used to see through getChat. */
const refChatStore = {
	...chatStore,
	getChat: refGetChat,
	listChats: refListChats,
} as ChatStore;

// ── read counting ────────────────────────────────────────────────────────────
function countReads<T>(fn: () => T): { result: T; chatReads: number; jobReads: number } {
	let chatReads = 0;
	let jobReads = 0;
	const original = fs.readFileSync;
	const spy = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
		const p = String(args[0]);
		if (p.startsWith(CHATS)) chatReads++;
		if (p.startsWith(JOBS)) jobReads++;
		return (original as (...a: unknown[]) => unknown)(...args);
	});
	syncBuiltinESMExports();
	try {
		return { result: fn(), chatReads, jobReads };
	} finally {
		spy.mock.restore();
		syncBuiltinESMExports();
	}
}

const JOB_FILES = () => fs.readdirSync(JOBS).filter((f) => f.endsWith(".json")).length;

// ── equivalence: the output can never change ────────────────────────────────
describe("store read paths match the pre-cache reference exactly", () => {
	it("listChats: same summaries, same order (ties included), corrupt/future/broken records excluded", () => {
		const expected = refListChats();
		assert.deepStrictEqual(chatStore.listChats(), expected);
		assert.deepStrictEqual(chatStore.listChats(), expected, "a second (cached) call is identical");
		const ids = expected.map((c) => c.id);
		assert.ok(!ids.includes(FUTURE_VERSION));
		assert.ok(!ids.includes(BROKEN_PROJECTION));
		assert.ok(ids.includes(TIE_A) && ids.includes(TIE_B));
		assert.equal(expected.length, LABELLED.length + 9 + 2);
	});

	it("activityFeed jobs: same rows, same title join, same stable tie order", () => {
		const expected = refFeedJobs();
		assert.deepStrictEqual(activityFeed().jobs, expected);
		assert.deepStrictEqual(activityFeed().jobs, expected, "second call identical");
		const ids = expected.map((j) => j.id);
		assert.ok(!ids.includes("job_run00007_gggggggg"), "a job on a chat the list excludes stays out");
		assert.ok(!ids.includes("job_run00008_hhhhhhhh"), "a job on a missing chat stays out");
	});

	it("graphCosts: same summary as the double-parse reference", () => {
		assert.deepStrictEqual(graphCosts(), refGraphCosts());
	});

	it("graphSnapshot: same session labels as per-id getChat (a readable record with a broken projection keeps its title)", () => {
		const expected = graphSnapshot({ ...stores, chatStore: refChatStore });
		const actual = graphView();
		assert.deepStrictEqual(actual, expected);
		assert.equal(actual.sessions[BROKEN_PROJECTION], "Broken projection");
		assert.equal(actual.sessions[LABELLED[0]!], "Labelled session 0");
		assert.equal(actual.sessions[FUTURE_VERSION], undefined);
	});
});

// ── freshness: a cache must never serve stale data ──────────────────────────
describe("cached reads stay fresh", () => {
	it("an out-of-process edit to a record file is seen on the next list", () => {
		const id = LABELLED[2]!;
		const file = path.join(CHATS, `${id}.json`);
		chatStore.listChats(); // warm
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, title: "Edited elsewhere!" }, null, "\t"), "utf-8");
		assert.equal(chatStore.listChats().find((c) => c.id === id)?.title, "Edited elsewhere!");
		assert.deepStrictEqual(chatStore.listChats(), refListChats());
		fs.writeFileSync(file, JSON.stringify(record, null, "\t"), "utf-8");
		assert.deepStrictEqual(chatStore.listChats(), refListChats());
	});

	it("in-process writes (rename, saveMessages, create, delete) are seen", () => {
		const created = chatStore.createChat("Fresh one");
		try {
			assert.deepStrictEqual(chatStore.listChats(), refListChats());
			chatStore.renameChat(created.id, "Renamed fresh one");
			assert.equal(chatStore.listChats().find((c) => c.id === created.id)?.title, "Renamed fresh one");
			chatStore.saveMessages(created.id, TEACH.messages);
			assert.deepStrictEqual(chatStore.listChats(), refListChats());
		} finally {
			chatStore.deleteChat(created.id);
		}
		assert.ok(!chatStore.listChats().some((c) => c.id === created.id));
		assert.deepStrictEqual(chatStore.listChats(), refListChats());
	});

	it("callers mutating a returned summary cannot corrupt later reads", () => {
		const first = chatStore.listChats();
		first[0]!.title = "MUTATED";
		(first[0] as { settings?: unknown }).settings = { poisoned: true };
		assert.deepStrictEqual(chatStore.listChats(), refListChats());
	});

	it("a job flip is seen by the next feed", () => {
		const id = "job_run00005_eeeeeeee";
		activityFeed(); // warm
		jobStore.updateJob(id, { status: "done" });
		assert.ok(!activityFeed().jobs.some((j) => j.id === id));
		assert.deepStrictEqual(activityFeed().jobs, refFeedJobs());
		jobStore.updateJob(id, { status: "running" });
		assert.deepStrictEqual(activityFeed().jobs, refFeedJobs());
	});
});

// ── read counts: the quadratic scans cannot come back ───────────────────────
describe("read counts", () => {
	it("a warm listChats re-reads no transcript", () => {
		chatStore.listChats();
		const { chatReads } = countReads(() => chatStore.listChats());
		// only the unreadable files (corrupt + future-version + broken projection
		// keep their honest per-call refusal) may be touched again
		assert.ok(chatReads <= 2, `warm listChats read ${chatReads} chat files`);
	});

	it("activityFeed reads each job file at most once (not once per chat)", () => {
		activityFeed();
		const { jobReads } = countReads(() => activityFeed());
		assert.ok(jobReads <= JOB_FILES(), `feed read ${jobReads} job files for ${JOB_FILES()} on disk`);
	});

	it("warm graphCosts and graph snapshot re-read no transcript", () => {
		graphCosts();
		graphView();
		assert.ok(countReads(() => graphCosts()).chatReads <= 2);
		assert.ok(countReads(() => graphView()).chatReads <= 2);
	});
});
