import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The learner-filesystem ACCESS POLICY (file-access wave): which paths the
 * read/ls/find/grep tools and the pdf job may touch. The agent layer may not
 * import settings or config-derived secrets locations, so the policy
 * arrives through this seam — the server composition root installs a
 * provider (src/server/file-access.ts) that reads settings FRESH per call,
 * so a folder change in the settings page applies on the next tool call.
 *
 * Two rules, checked on the REAL path (symlinks resolved first, so a link
 * inside an allowed folder cannot reach outside it):
 *   - denied: the app's own private files (keys, credentials, data dir) are
 *     refused ALWAYS — the tutor has no reason to read them, and a prompt-
 *     injected tutor must not be able to;
 *   - folders: when non-empty, every path must sit inside one of them.
 *     Empty = the home-wide sources-v1 scope.
 *
 * Plus the learner's own secret stores (owner, 2026-10-26 — "home minus
 * the sensitive"), refused ALWAYS and owned HERE so they hold even before
 * the server installs its provider: HOME_SECRETS under the home directory,
 * and env files (.env, .env.*) anywhere.
 */

/** Secret stores under the learner's home, never readable. */
export const HOME_SECRETS: readonly string[] = [
	".ssh", ".aws", ".gnupg", ".config", "Library",
	".netrc", ".git-credentials", ".npmrc", ".docker", ".kube", ".claude",
	".zsh_history", ".bash_history",
	".codex", ".cursor", ".gemini", ".azure", ".pypirc", ".mozilla",
	"AppData/Local/Google/Chrome", "AppData/Local/BraveSoftware", "AppData/Local/Microsoft/Edge",
	"AppData/Roaming/Mozilla",
];
/** Env files — keys and tokens by convention — anywhere. */
const ENV_FILE = /^\.env(\..*)?$/i;

export interface FileAccessPolicy {
	/** Absolute folders the tools may read inside; empty = unrestricted. */
	folders: readonly string[];
	/** Absolute files/folders never readable, whatever `folders` says. */
	denied: readonly string[];
	/** A malformed saved policy: with no folders, every read is refused
	 *  (fail closed). Absent = the normal rule above. */
	restricted?: boolean;
	/** Why the policy is restricted; shown in the denial. */
	error?: string;
}

const OPEN_POLICY: FileAccessPolicy = { folders: [], denied: [] };
let currentPolicy: () => FileAccessPolicy = () => OPEN_POLICY;

/** Install the policy provider (composition root only; tests reset it). */
export function setFileAccessPolicy(provider: () => FileAccessPolicy): void {
	currentPolicy = provider;
}

export function fileAccessPolicy(): FileAccessPolicy {
	return currentPolicy();
}

/** The anchor for relative/absent paths: the first allowed folder when the
 *  scope is restricted (home would be refused anyway), else home. */
export function sourceAnchor(policy: FileAccessPolicy = fileAccessPolicy()): string {
	return policy.folders[0] ?? os.homedir();
}

/** `child` is `parent` or lies beneath it (both absolute, normalized). */
export function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** realpath when the path exists; otherwise the resolved path (a denied
 *  file that doesn't exist yet must still match once it does). */
async function realOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

/** The policy with every entry realpath-resolved — compare like with like
 *  (macOS: /var → /private/var, /tmp → /private/tmp). */
export async function resolvePolicy(policy: FileAccessPolicy = fileAccessPolicy()): Promise<FileAccessPolicy> {
	const home = os.homedir();
	const [folders, denied] = await Promise.all([
		Promise.all(policy.folders.map(realOrResolved)),
		Promise.all([...policy.denied, ...HOME_SECRETS.map((s) => path.join(home, s))].map(realOrResolved)),
	]);
	return { folders, denied, ...(policy.restricted ? { restricted: true, error: policy.error } : {}) };
}

/** True when a REAL path is refused by an already-resolved policy. */
export function isRefused(realPath: string, resolved: FileAccessPolicy): boolean {
	if (isDenied(realPath, resolved)) return true;
	if (resolved.restricted && resolved.folders.length === 0) return true;
	return resolved.folders.length > 0 && !resolved.folders.some((f) => isWithin(realPath, f));
}

/** A path the tutor may never read, whatever the folders: the app's
 *  private data, the home secret stores, an env file. */
export function isDenied(realPath: string, resolved: FileAccessPolicy): boolean {
	const file = comparisonPath(realPath);
	return ENV_FILE.test(path.basename(file)) || resolved.denied.some((d) => isWithin(file, comparisonPath(d)));
}

/** Comparison key only, never for opening a file: case-folded (`.SSH` and
 *  `.ssh` name one folder on macOS and Windows), and on Windows the namespace
 *  prefixes (`\\?\`) and alternate data streams (`file:stream`) are dropped. */
function comparisonPath(absolute: string): string {
	let normalized = path.resolve(absolute);
	if (process.platform === "win32") {
		if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
		else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
		const base = path.basename(normalized);
		const stream = base.indexOf(":");
		if (stream !== -1) normalized = path.join(path.dirname(normalized), base.slice(0, stream));
	}
	return normalized.toLowerCase();
}

/**
 * Gate one tool path: resolve it to its real location and refuse it per the
 * policy. Returns the real path — callers read THAT, never the raw input, so
 * the checked path and the opened path are the same file. Missing paths
 * throw "Path not found" (the tools' existing wording) with the errno code.
 */
export async function guardSourcePath(absolute: string): Promise<string> {
	let real: string;
	try {
		real = await fs.realpath(absolute);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		throw new Error(`Path not found: ${absolute}${code ? ` (${code})` : ""}`);
	}
	const resolved = await resolvePolicy();
	if (isDenied(real, resolved)) {
		throw new Error(`Access denied: ${absolute} is private app data or a secret store (keys, credentials, records) and is never readable by the tutor.`);
	}
	if (isRefused(real, resolved)) {
		if (resolved.restricted && resolved.folders.length === 0) {
			throw new Error(
				`Access denied: ${absolute} — ${resolved.error ?? "the file-access policy is malformed"}. ` +
					"Fix it in Settings → Agent → File access.",
			);
		}
		throw new Error(
			`Access denied: ${absolute} is outside the folders the learner allowed (${fileAccessPolicy().folders.join(", ")}). ` +
				"Ask the learner to move the file into an allowed folder or add its folder in Settings → Agent → File access.",
		);
	}
	return real;
}
