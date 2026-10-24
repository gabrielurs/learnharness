/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { writeFileAtomic } from "./atomic-write.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat). */
function writeChat(record: ChatRecord): void {
	writeFileAtomic(chatFile(record.id), JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t"));
	readCache.delete(record.id);
}

function getChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as ChatRecord;
}

/** THE READ CACHE (perf round, 2026-10-24): the sidebar list, the activity
 *  feed, the graph snapshot's labels and the cost pill used to re-parse
 *  every transcript (hundreds of KB each) on every call. Each readable
 *  record's derived read-model — summary, title, extraction log — is kept
 *  per file, keyed by its on-disk identity (inode:mtime:size). Every write
 *  here is tmp+rename (a fresh inode) and also drops the entry, and every
 *  read re-stats first, so an edit from anywhere — another module copy of
 *  this store (Next dev bundles one per route), a script, a hand edit — is
 *  re-parsed on the next read; nothing is ever served stale. Unreadable
 *  files (corrupt, future-version) are never cached: they keep their
 *  per-read refusal exactly as before. Callers get deep copies. */
interface CachedChat {
	stamp: string;
	title: string;
	extractions: ExtractionRunUsage[] | undefined;
	/** The list projection, or the error it threw (logged on every list,
	 *  as the uncached projection always did). */
	projection: { summary: ChatSummary } | { error: unknown; recordId: string };
}

const readCache = new Map<string, CachedChat>();

function cachedChat(id: string): CachedChat | null {
	let stamp: string;
	try {
		const stat = fs.statSync(chatFile(id));
		stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		readCache.delete(id);
		return null;
	}
	const hit = readCache.get(id);
	if (hit?.stamp === stamp) return hit;
	// A write landing between the stat and this read caches newer content
	// under the older stamp — the next stat mismatches and re-parses.
	const record = getChat(id);
	if (!record) {
		readCache.delete(id);
		return null;
	}
	const entry: CachedChat = { stamp, title: record.title, extractions: record.extractions, projection: project(record) };
	readCache.set(id, entry);
	return entry;
}

function project({ messages, tree, turns, extractions, ...summary }: ChatRecord): CachedChat["projection"] {
	// Per-record isolation (Wave B): a record whose messages fail the
	// projection (e.g. pre-Wave-B UIMessage-format scratch — the
	// zero-back-compat wipe makes these "corrupt") must not blank the
	// whole sidebar — same isolation getChat's per-file catch gives.
	try {
		return {
			summary: {
				// turns and extractions stay out of the list payload (list =
				// summaries; usage aggregates ride the full record, the picker
				// never needs them).
				...summary,
				// Normalized kind: absent record field reads as teach.
				kind: summary.kind ?? "teach",
				messageCount: messages.length,
				// Record-derived status for the session picker: phase from the
				// transcript's explicit events (probe_done concluded / verdict
				// accepted — docs/probe-teach-split.md §4), pending question
				// from the native dangling-call scan. Wave D: both folds read
				// the NATIVE record (core/phases.ts phaseAt3Lh +
				// native-messages.ts danglingQuestionOf). Liveness (busy) is
				// NOT record-derived — the API route merges it (ChatListItem).
				phase: phaseAt3Lh(messages),
				pendingQuestion: danglingQuestionOf(messages) !== null,
			} as ChatSummary,
		};
	} catch (error) {
		return { error, recordId: summary.id };
	}
}

/** Every readable record in directory order, pruning entries whose file is gone. */
function cachedChats(): Array<[string, CachedChat]> {
	fs.mkdirSync(PATHS.chats, { recursive: true });
	const ids = fs
		.readdirSync(PATHS.chats)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -5));
	const present = new Set(ids);
	for (const id of readCache.keys()) if (!present.has(id)) readCache.delete(id);
	return ids.flatMap((id) => {
		const entry = cachedChat(id);
		return entry ? [[id, entry] as [string, CachedChat]] : [];
	});
}

/** The listed (projectable) records, newest activity first — the sort is
 *  stable over directory order, as it always was. */
function listedChats(): Array<{ entry: CachedChat; summary: ChatSummary }> {
	return cachedChats()
		.flatMap(([, entry]) => {
			if ("error" in entry.projection) {
				console.error(`[chat ${entry.projection.recordId}] summary projection failed:`, entry.projection.error);
				return [];
			}
			return [{ entry, summary: entry.projection.summary }];
		})
		.sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt));
}

function listChats(): ChatSummary[] {
	try {
		return listedChats().map(({ summary }) => structuredClone(summary));
	} catch {
		return [];
	}
}

function chatTitles(): Map<string, string> {
	try {
		return new Map(cachedChats().map(([id, entry]) => [id, entry.title]));
	} catch {
		return new Map();
	}
}

function chatExtractions(): Array<{ id: string; title: string; extractions: ExtractionRunUsage[] }> {
	try {
		return listedChats().flatMap(({ entry, summary }) =>
			entry.extractions?.length
				? [{ id: summary.id, title: entry.title ?? summary.id, extractions: structuredClone(entry.extractions) }]
				: [],
		);
	} catch {
		return [];
	}
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	writeChat(record);
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	try {
		fs.unlinkSync(chatFile(id));
		readCache.delete(id);
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat(record);
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	chatTitles,
	chatExtractions,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};
