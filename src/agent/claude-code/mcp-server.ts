/**
 * The throwaway MCP server the Claude Code bridge hands the CLI (2026-10-24):
 * it only LISTS the app's tools (name, description, JSON Schema) so the
 * model can call them natively. It never runs one — the bridge captures
 * the call from the CLI's stream and ends the run as the assistant
 * message completes; pi's agent loop does the real execution. A call that
 * does reach it gets an error result, never a side effect.
 *
 * Shipped as SOURCE TEXT and written next to each call (no extra file to
 * package): plain CommonJS over newline-delimited JSON-RPC on stdio, run
 * by the app's own runtime (process.execPath; ELECTRON_RUN_AS_NODE makes
 * the desktop build's binary behave as node).
 *
 * argv: <tools.json> — [{name, description, inputSchema}].
 */
export const MCP_SERVER_SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const tools = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, nl).trim();
		buffer = buffer.slice(nl + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		if (msg.id === undefined || msg.id === null) continue;
		switch (msg.method) {
			case "initialize":
				reply(msg.id, {
					protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "learnharness", version: "1" },
				});
				break;
			case "tools/list":
				reply(msg.id, { tools });
				break;
			case "tools/call":
				reply(msg.id, { content: [{ type: "text", text: "This tool runs in LearnHarness, not here." }], isError: true });
				break;
			case "ping":
				reply(msg.id, {});
				break;
			default:
				send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
`;
