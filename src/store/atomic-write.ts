/**
 * Crash-safe whole-file writes for the JSON record stores (perf round,
 * 2026-10-24): tmp-in-same-dir + rename, the precedent rewriteLedgers and
 * writePositionMap already follow (store/graph.ts). A torn write (crash,
 * full disk) only ever tears the tmp — the previous record stays readable,
 * so a session can never vanish from the sidebar and settings never reset
 * to defaults. Readers filter on the exact ".json" suffix, so a stranded
 * "<file>.tmp-xxxxxxxx" is never mistaken for a record.
 */

import * as fs from "node:fs";

export function writeFileAtomic(file: string, data: string): void {
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, data, "utf-8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}
