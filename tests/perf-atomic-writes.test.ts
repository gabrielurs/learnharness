/**
 * Crash-safe record writes (perf round, 2026-10-24).
 *
 * Chats, jobs, settings, notes sources and render settings used to be
 * written in place: a crash (or full disk) mid-write left a torn file that
 * every reader parses as "absent" — a session vanishing from the sidebar,
 * or the user's model slots silently reset to defaults. Each writer now
 * goes tmp-in-same-dir + rename (the positions/ledger/auth precedent). This
 * suite simulates a torn write (half the bytes land, then the call throws)
 * and asserts the previous file survives byte-for-byte, no tmp debris is
 * left, and a successful write produces exactly the old bytes.
 *
 * Own temp data dir, set BEFORE any config-loading import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { describe, it, mock } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-perf-atomic-"));
process.env.LH_DATA_DIR = TMP;

const { PATHS, SETTINGS_FILE, SOURCES_FILE, RENDER_SETTINGS_FILE } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { writeRenderSettings } = await import("../src/store/render-settings.ts");
const { DEFAULT_RENDER_SETTINGS } = await import("../src/core/render-settings.ts");
const { CURRENT_CHAT_VERSION } = await import("../src/core/contracts.ts");

/** Run fn with the NEXT writeFileSync torn: half the payload lands at the
 *  given path, then the call throws (ENOSPC-style). Later writes are real. */
function withTornWrite(fn: () => void): unknown {
	const original = fs.writeFileSync;
	let armed = true;
	const spy = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
		if (!armed) return (original as (...a: unknown[]) => unknown)(...args);
		armed = false;
		const [file, data] = args;
		const text = String(data);
		original(file, text.slice(0, Math.floor(text.length / 2)), "utf-8");
		throw Object.assign(new Error("ENOSPC: simulated torn write"), { code: "ENOSPC" });
	});
	syncBuiltinESMExports();
	try {
		fn();
		return null;
	} catch (err) {
		return err;
	} finally {
		spy.mock.restore();
		syncBuiltinESMExports();
	}
}

function debris(dir: string): string[] {
	return fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
}

const jobFile = (id: string) => path.join(PATHS.data, "jobs", `${id}.json`);

describe("torn writes never replace the previous record", () => {
	it("chat record (saveMessages)", () => {
		const chat = chatStore.createChat("Atomic chat");
		const file = path.join(PATHS.chats, `${chat.id}.json`);
		const before = fs.readFileSync(file);
		const err = withTornWrite(() => chatStore.saveMessages(chat.id, []));
		assert.ok(err, "the failed write still surfaces to the caller");
		assert.deepEqual(fs.readFileSync(file), before, "previous bytes intact");
		assert.notEqual(chatStore.getChat(chat.id), null, "the session is still readable");
		assert.deepEqual(debris(PATHS.chats), []);
	});

	it("job record (updateJob)", () => {
		const chat = chatStore.createChat("Atomic jobs");
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tc_atomic" });
		const before = fs.readFileSync(jobFile(job.id));
		const err = withTornWrite(() => jobStore.updateJob(job.id, { activity: "half" }));
		assert.ok(err);
		assert.deepEqual(fs.readFileSync(jobFile(job.id)), before);
		assert.equal(jobStore.getJob(job.id)?.status, "running");
		assert.deepEqual(debris(path.dirname(jobFile(job.id))), []);
	});

	it("user settings (writeSettings)", () => {
		settingsStore.writeSettings({} as never);
		const before = fs.readFileSync(SETTINGS_FILE);
		const err = withTornWrite(() => settingsStore.writeSettings({} as never));
		assert.ok(err);
		assert.deepEqual(fs.readFileSync(SETTINGS_FILE), before);
		assert.notEqual(settingsStore.readSettings(), null, "settings still parse — no silent reset to defaults");
		assert.deepEqual(debris(path.dirname(SETTINGS_FILE)), []);
	});

	it("notes sources (upsertSource)", () => {
		const source = { id: "src_atomic000001", filePath: "/notes/a.md", importedAt: "2026-10-24T10:00:00.000Z", extractions: [] };
		graphStore.upsertSource(source as never);
		const before = fs.readFileSync(SOURCES_FILE);
		const err = withTornWrite(() => graphStore.upsertSource({ ...source, filePath: "/notes/b.md" } as never));
		assert.ok(err);
		assert.deepEqual(fs.readFileSync(SOURCES_FILE), before);
		assert.equal(graphStore.readSources().find((s) => s.id === source.id)?.filePath, "/notes/a.md");
		assert.deepEqual(debris(path.dirname(SOURCES_FILE)), []);
	});

	it("render settings (writeRenderSettings)", () => {
		writeRenderSettings(DEFAULT_RENDER_SETTINGS);
		const before = fs.readFileSync(RENDER_SETTINGS_FILE);
		const err = withTornWrite(() => writeRenderSettings(DEFAULT_RENDER_SETTINGS));
		assert.ok(err);
		assert.deepEqual(fs.readFileSync(RENDER_SETTINGS_FILE), before);
		assert.deepEqual(debris(path.dirname(RENDER_SETTINGS_FILE)), []);
	});
});

describe("successful writes produce exactly the previous on-disk format", () => {
	it("chat, job, settings, sources and render settings bytes", () => {
		const chat = chatStore.createChat("Format chat");
		chatStore.renameChat(chat.id, "Format chat renamed");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(
			fs.readFileSync(path.join(PATHS.chats, `${chat.id}.json`), "utf-8"),
			JSON.stringify({ ...record, version: CURRENT_CHAT_VERSION }, null, "\t"),
		);

		const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "tc_format" });
		assert.equal(fs.readFileSync(jobFile(job.id), "utf-8"), JSON.stringify(job, null, "\t"));
		const updated = jobStore.updateJob(job.id, { activity: "step two" })!;
		assert.equal(fs.readFileSync(jobFile(job.id), "utf-8"), JSON.stringify(updated, null, "\t"));

		const settings = settingsStore.writeSettings({} as never);
		assert.equal(fs.readFileSync(SETTINGS_FILE, "utf-8"), JSON.stringify(settings, null, "\t"));

		const rendered = writeRenderSettings(DEFAULT_RENDER_SETTINGS);
		assert.equal(fs.readFileSync(RENDER_SETTINGS_FILE, "utf-8"), JSON.stringify(rendered, null, "\t"));

		fs.rmSync(SOURCES_FILE, { force: true }); // independent of the torn-write cases above
		graphStore.upsertSource({ id: "src_format000001", filePath: "/notes/f.md", importedAt: "2026-10-24T11:00:00.000Z", extractions: [] } as never);
		const sources = Object.fromEntries(graphStore.readSources().map((s) => [s.id, s]));
		assert.equal(fs.readFileSync(SOURCES_FILE, "utf-8"), JSON.stringify(sources, null, "\t"));

		for (const dir of [PATHS.chats, path.dirname(jobFile(job.id)), path.dirname(SETTINGS_FILE), path.dirname(SOURCES_FILE)]) {
			assert.deepEqual(debris(dir), [], `no tmp debris in ${dir}`);
		}
	});
});
