/**
 * The AuthStore adapter (auth-keys wave, 2026-09-19): the flat {VAR: value}
 * auth.json map at config.AUTH_FILE — the SAME file the Electron app has
 * always hand-edited (owner decision: option A — same file, env-located,
 * zero migration). 0600, atomic writes, hand-edits keep working (the file
 * is re-read from disk on every access).
 *
 * The server (src/server/keys.ts) is the only intended writer: it applies
 * shape validation before setAuthVar and env precedence on top of
 * authVars(). This adapter persists what it is given, never throws
 * (absent/corrupt file = {} = "no keys yet", the documented first-boot
 * state, matching settings doctrine), and preserves unknown vars verbatim
 * (forward-compat: future entries — e.g. a plans-login token — ride along
 * untouched until a catalog entry adopts them).
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import type { AuthStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/** The flat string→string map, or {} for absent/corrupt/non-object. */
function readMap(): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return Object.fromEntries(
			Object.entries(raw).filter(([, v]) => typeof v === "string") as [string, string][],
		);
	} catch {
		return {}; // absent or corrupt — the documented state is "no keys yet"
	}
}

/** Write the map atomically at mode 0600: a partial write must never
 *  leave a 0644 file (secrets) or a truncated JSON (looks like "no keys").
 *  writeFileAtomicSync fchmods the temp to `mode` before the rename, so the
 *  mode never exists relaxed on the final path. */
function writeMap(map: Record<string, string>): void {
	fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
	writeFileAtomicSync(AUTH_FILE, `${JSON.stringify(map, null, "\t")}\n`, { mode: 0o600 });
}

export const authStore: AuthStore = {
	authVars() {
		return readMap();
	},
	setAuthVar(name, value) {
		const map = readMap();
		map[name] = value;
		writeMap(map);
	},
	deleteAuthVar(name) {
		const map = readMap();
		if (!(name in map)) return; // absent = silent success, idempotent
		delete map[name];
		writeMap(map);
	},
};
