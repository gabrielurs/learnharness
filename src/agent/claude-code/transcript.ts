import {
	getSystemMessageText,
	renderSystemMessageUpdate,
	type ImageContent,
	type Message,
	type TextContent,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

/**
 * The Claude Code bridge's transcript renderer (claude-code provider,
 * 2026-10-24). PURE — no fs, no process: pi's normalized transcript in,
 * what one `claude -p` call needs out.
 *
 * The CLI runs with its built-in tools disabled (`--tools ""`). The app's
 * tools reach it as a throwaway MCP server (cli.ts) under the
 * `mcp__lh__` prefix, so the model calls them natively against their
 * real schemas; the bridge captures those calls and ends the CLI run
 * before anything executes, and pi's agent loop runs them exactly as it
 * does for any provider. Their results come back on the next call as
 * <tool_result> blocks.
 *
 * Each call is STATELESS (no CLI session is resumed): the whole
 * transcript is re-rendered every time, matching the app's own
 * stateless per-turn engine. Rendering is deterministic so the CLI's
 * prompt cache can reuse the unchanged prefix.
 */

/** The MCP server name the app's tools are exposed under. */
export const BRIDGE_MCP_SERVER = "lh";
/** How the CLI names an app tool: `mcp__lh__quiz` for `quiz`. */
export const BRIDGE_TOOL_PREFIX = `mcp__${BRIDGE_MCP_SERVER}__`;

/** One block of the bridged user message (Anthropic content shape). */
export type BridgeBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** What one bridged CLI call is made of. */
export interface BridgePrompt {
	/** Goes to `--system-prompt-file`: the app's prompt + the bridge note. */
	systemPrompt: string;
	/** Goes to stdin as ONE stream-json user message: the rendered
	 *  conversation + the continuation cue, images inline where they
	 *  occurred (vision slot: the visual maker and PDF reader see pages). */
	content: BridgeBlock[];
	/** The tool set in force at the end of the transcript (→ the MCP server). */
	tools: Tool[];
}

const BRIDGE_NOTE = `# Tool access (Claude Code bridge)

You are running inside LearnHarness through a bridge. Every tool this prompt names is available to you as a native tool with the "${BRIDGE_TOOL_PREFIX}" prefix: \`quiz\` is \`${BRIDGE_TOOL_PREFIX}quiz\`, and so on. Call them natively, exactly as their schemas define.

The conversation so far is given to you as a sequence of <user>, <assistant> and <tool_result> records, oldest first; reply with the next assistant message. In it, your earlier tool calls appear as <tool_call> records and their outcomes as <tool_result> blocks; a result with is_error="true" means the call was rejected, so read the error and retry correctly. Those records are history only: never write tool calls as text.`;

/** Accumulates the message: text runs merge WITHIN one transcript
 *  message, images split them, and every message starts a new block.
 *  Block boundaries are what Anthropic's prompt cache keys on: with one
 *  block per message, the previous call's prefix ends on a boundary of
 *  the next call, so each call reuses the whole history and only writes
 *  the new turn (one merged block re-wrote the full transcript every call). */
class BlockWriter {
	readonly blocks: BridgeBlock[] = [];
	private open = false;
	/** Start the next transcript message in a fresh block. */
	boundary(): void {
		this.open = false;
	}
	text(text: string): void {
		const last = this.blocks.at(-1);
		if (this.open && last?.type === "text") last.text += text;
		else this.blocks.push({ type: "text", text });
		this.open = true;
	}
	content(content: string | (TextContent | ImageContent)[]): void {
		if (typeof content === "string") return this.text(content);
		content.forEach((block, i) => {
			if (i > 0) this.text("\n");
			if (block.type === "text") this.text(block.text);
			else {
				this.blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
				this.open = false;
			}
		});
	}
}

function attr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function renderMessage(message: Message, out: BlockWriter): void {
	out.boundary();
	switch (message.role) {
		case "system": {
			// A tools-only update renders empty: the MCP tool list already
			// reflects it.
			const update = renderSystemMessageUpdate(message);
			if (update) out.text(`<system_update>\n${update}\n</system_update>\n`);
			return;
		}
		case "user":
			out.text("<user>\n");
			out.content(message.content);
			out.text("\n</user>\n");
			return;
		case "assistant": {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) parts.push(block.text);
				// Prior thinking stays out: it was the model's own scratch, and
				// replaying it as text would read as said-to-the-learner.
				if (block.type === "toolCall") {
					parts.push(`<tool_call id="${attr(block.id)}" name="${attr(block.name)}">${JSON.stringify(block.arguments)}</tool_call>`);
				}
			}
			out.text(`<assistant>\n${parts.join("\n")}\n</assistant>\n`);
			return;
		}
		case "toolResult":
			out.text(`<tool_result id="${attr(message.toolCallId)}" name="${attr(message.toolName)}" is_error="${message.isError}">\n`);
			out.content(message.content);
			out.text("\n</tool_result>\n");
			return;
	}
}

/**
 * Render a normalized transcript into one bridged call. The LEADING system
 * message is the base prompt; later system messages render in place as
 * <system_update> blocks, and the tool set is replayed in order so the
 * MCP server lists exactly the tools in force now.
 */
export function renderBridgePrompt(context: TranscriptContext): BridgePrompt {
	const [first, ...rest] = context.messages;
	const leading = first?.role === "system" ? first : undefined;
	const body = leading ? rest : context.messages;

	const tools = new Map<string, Tool>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
	}

	const systemPrompt = [leading ? getSystemMessageText(leading).trim() : "", BRIDGE_NOTE].filter(Boolean).join("\n\n---\n\n");

	// No wrapper and no trailing cue: the LAST block must be the last
	// message, or the cache prefix would differ on every call.
	const out = new BlockWriter();
	for (const message of body) renderMessage(message, out);
	if (out.blocks.length === 0) out.text("(The conversation is empty: begin.)");
	// No trailing whitespace on any block: the CLI trims the LAST block, so
	// an untrimmed block would read differently once it is no longer last
	// and miss the cache it wrote.
	for (const block of out.blocks) if (block.type === "text") block.text = block.text.trimEnd();

	return { systemPrompt, content: out.blocks, tools: [...tools.values()] };
}
