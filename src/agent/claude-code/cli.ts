import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type JsonObject,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import { SEND_TO_USER_TOOL } from "../../core/native-messages.ts";
import { MCP_SERVER_SOURCE } from "./mcp-server.ts";
import { BRIDGE_MCP_SERVER, BRIDGE_TOOL_PREFIX, renderBridgePrompt } from "./transcript.ts";

/**
 * The Claude Code CLI seam (claude-code provider, 2026-10-24): find the
 * `claude` binary, run ONE headless call per model request, and translate
 * the raw API stream it relays (`--include-partial-messages`) into pi's
 * AssistantMessageEventStream — text streams live, tool calls arrive
 * natively through the throwaway MCP server (mcp-server.ts).
 *
 * Only the FIRST assistant message of a run is the response: the moment
 * it completes the bridge ends the run, so a tool call is never executed
 * by the CLI (pi executes it) and the CLI never takes a second turn.
 *
 * The CLI authenticates with the user's own Claude Code login, so requests
 * ride their Claude subscription instead of an API key. To keep it that
 * way the child env drops the Anthropic API-key vars — with
 * ANTHROPIC_API_KEY set the CLI would bill the API instead.
 *
 * The call is sealed off from the user's Claude Code setup: no built-in
 * tools, no settings/hooks/plugins (`--setting-sources ""`), only the
 * bridge's MCP server, no skills, no saved session, and an empty scratch
 * cwd so no CLAUDE.md is discovered.
 */

/** Override for the binary location (packaged apps may lack the shell PATH). */
export const CLAUDE_BIN_ENV = "LH_CLAUDE_BIN";

const BIN_NAMES = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];

/** Install locations checked after PATH — a packaged Electron app starts
 *  with a minimal PATH that misses the user's shell additions. */
function fallbackDirs(): string[] {
	const home = homedir();
	return [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
}

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The `claude` binary to run, or undefined when none is installed. Read
 *  fresh per call (cheap stat calls) so installing the CLI needs no restart. */
export function findClaudeBinary(env: Record<string, string | undefined> = process.env): string | undefined {
	const override = env[CLAUDE_BIN_ENV];
	if (override) return isExecutable(override) ? override : undefined;
	const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...fallbackDirs()];
	for (const dir of dirs) {
		for (const name of BIN_NAMES) {
			const candidate = path.join(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Vars that would switch the CLI from the subscription login to API billing. */
const API_AUTH_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out = { ...env };
	for (const name of API_AUTH_VARS) delete out[name];
	return out;
}

/** pi thinking level → `--effort`. Levels the models map to null
 *  (off/minimal) never reach here: pi clamps them first. */
const EFFORT: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** The argv of one bridged call (exported for tests). */
export function bridgeArgs(modelId: string, files: { systemPrompt: string; mcpConfig: string }, reasoning: string | undefined): string[] {
	const args = [
		"-p",
		"--model",
		modelId,
		"--tools",
		"",
		"--setting-sources",
		"",
		"--mcp-config",
		files.mcpConfig,
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--no-session-persistence",
		"--system-prompt-file",
		files.systemPrompt,
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--verbose",
	];
	const effort = reasoning ? EFFORT[reasoning] : undefined;
	if (effort) args.push("--effort", effort);
	return args;
}

/** The MCP tool list the bridge's server serves (exported for tests). */
export function mcpToolList(tools: readonly Tool[]): { name: string; description: string; inputSchema: unknown }[] {
	return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** The CLI's Anthropic usage block → pi Usage. Cost stays zero: the call
 *  is covered by the subscription, not billed per token. */
export function toPiUsage(raw: unknown): Usage {
	const u = (raw ?? {}) as Record<string, any>;
	const input = Number(u.input_tokens ?? 0);
	const output = Number(u.output_tokens ?? 0);
	const cacheRead = Number(u.cache_read_input_tokens ?? 0);
	const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
	const reasoning = u.output_tokens_details?.thinking_tokens;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(typeof reasoning === "number" ? { reasoning } : {}),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { ...ZERO_COST },
	};
}

function emptyMessage(model: Pick<Model<Api>, "api" | "provider" | "id">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: toPiUsage(undefined),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A tool call written as PROSE (the model's own call markup leaking into
 *  text instead of a native call — seen live with Opus mid-lesson). */
const FAKE_CALL_START = /(?:<(?:\w+:)?function_calls>\s*)?<(?:\w+:)?invoke name="/g;
/** Results the model INVENTS for its own fake call — the loop signature. */
const FAKE_RESULT = /<(?:\w+:)?function_results>|<tool_result[\s>]|<tool_call_error>/;
const FAKE_RESULT_G = new RegExp(FAKE_RESULT.source, "g");

/** Is `at` inside a fenced code block? Fences are ``` or ~~~ runs (3+)
 *  opening a line; a fence closes on the same character, at least as long. */
function insideFence(text: string, at: number): boolean {
	let open: string | null = null;
	for (const m of text.slice(0, at).matchAll(/^[ \t]{0,3}(`{3,}|~{3,})/gm)) {
		const run = m[1]!;
		if (open === null) open = run;
		else if (run[0] === open[0] && run.length >= open.length) open = null;
	}
	return open !== null;
}

const atLineStart = (text: string, at: number) => !text.slice(text.lastIndexOf("\n", at - 1) + 1, at).trim();

/** First match of `re` (global) at or after `from` that is leaked MARKUP, not
 *  an example (audit, 2026-10-25): outside a code fence, and — for matches
 *  `lineStartOnly` picks — starting a line ("the <tool_result> tag" in a
 *  sentence is prose). -1 = none. */
function markupAt(text: string, re: RegExp, from: number, lineStartOnly: (match: string) => boolean = () => false): number {
	re.lastIndex = from;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (insideFence(text, m.index)) continue;
		if (lineStartOnly(m[0]) && !atLineStart(text, m.index)) continue;
		return m.index;
	}
	return -1;
}
/** `<tool_result` is also the bridge's own record name — prose may cite it,
 *  so only a line-start one counts; the others are never prose. */
const fakeResultAt = (text: string, from: number) => markupAt(text, FAKE_RESULT_G, from, (m) => m.startsWith("<tool_result"));

/** Parse leaked call markup into tool calls (exported for tests). Values
 *  that parse as JSON (arrays, objects, numbers) are taken as JSON; the
 *  rest stay strings. Only COMPLETE invokes count. */
export function parseLeakedCalls(markup: string): { name: string; arguments: JsonObject }[] {
	const calls: { name: string; arguments: JsonObject }[] = [];
	const invoke = /<(?:\w+:)?invoke name="([^"]+)">([\s\S]*?)<\/(?:\w+:)?invoke>/g;
	for (const m of markup.matchAll(invoke)) {
		const args: JsonObject = {};
		const param = /<(?:\w+:)?parameter name="([^"]+)">([\s\S]*?)<\/(?:\w+:)?parameter>/g;
		for (const p of m[2]!.matchAll(param)) {
			const raw = p[2]!;
			try {
				args[p[1]!] = JSON.parse(raw.trim());
			} catch {
				args[p[1]!] = raw;
			}
		}
		const name = m[1]!;
		calls.push({ name: name.startsWith(BRIDGE_TOOL_PREFIX) ? name.slice(BRIDGE_TOOL_PREFIX.length) : name, arguments: args });
	}
	return calls;
}
/** A single response past this is a runaway, not a lesson. */
const MAX_TEXT_CHARS = 120_000;
/** No CLI output for this long → the run is declared stuck. */
const IDLE_TIMEOUT_MS = 180_000;

type Block =
	| { kind: "text"; index: number; capture?: string; held?: string; scanFrom?: number; midLine?: boolean }
	| { kind: "thinking"; text: string; signature: string }
	| { kind: "tool"; index: number; json: string; call: ToolCall }
	| { kind: "skip" };

/**
 * Builds ONE pi assistant message from the CLI's stream-json lines
 * (exported for tests: lines in, pi events out). `feed` returns true once
 * the first assistant message is complete — the caller then ends the run.
 */
export class BridgeAssembler {
	readonly output: AssistantMessage;
	private blocks = new Map<number, Block>();
	private started = false;
	private finished = false;
	private rawUsage: Record<string, unknown> = {};
	private stopReason: string | undefined;
	/** The CLI's own error, when the run failed before any message. */
	resultError: string | undefined;

	constructor(
		model: Pick<Model<Api>, "api" | "provider" | "id">,
		private readonly push: (event: AssistantMessageEvent) => void,
		/** The app tool names served this call: a leaked call naming none of
		 *  them is an example, not a call. Absent → any name counts. */
		private readonly served?: ReadonlySet<string>,
		/** This step's prose already went out through send_to_user (upstream
		 *  0.3.8): an empty closing reply is the documented way to end. */
		private readonly delivered = false,
	) {
		this.output = emptyMessage(model);
	}

	get done(): boolean {
		return this.finished;
	}

	/** Emit `start` (idempotent) — the stream opens as soon as the run does. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.push({ type: "start", partial: this.output });
	}

	feed(line: string): boolean {
		if (this.finished || !line.trim()) return this.finished;
		let event: Record<string, any>;
		try {
			event = JSON.parse(line);
		} catch {
			return false;
		}
		if (event.type === "result") {
			if (event.is_error || event.subtype !== "success") {
				const detail = typeof event.result === "string" && event.result ? event.result : event.subtype ?? "unknown error";
				this.resultError = `Claude Code: ${detail}`;
			}
			return false;
		}
		// Only the top-level conversation's raw API events build the message.
		if (event.type !== "stream_event" || event.parent_tool_use_id) return false;
		this.onApiEvent(event.event ?? {});
		return this.finished;
	}

	private onApiEvent(e: Record<string, any>): void {
		switch (e.type) {
			case "message_start":
				this.rawUsage = { ...(e.message?.usage ?? {}) };
				this.output.responseId = e.message?.id;
				this.start();
				return;
			case "content_block_start":
				return this.onBlockStart(e.index, e.content_block ?? {});
			case "content_block_delta":
				return this.onBlockDelta(e.index, e.delta ?? {});
			case "content_block_stop":
				return this.onBlockStop(e.index);
			case "message_delta":
				if (e.delta?.stop_reason) this.stopReason = e.delta.stop_reason;
				for (const [k, v] of Object.entries(e.usage ?? {})) if (v !== null && v !== undefined) this.rawUsage[k] = v;
				return;
			case "message_stop":
				return this.finish();
		}
	}

	private onBlockStart(apiIndex: number, block: Record<string, any>): void {
		this.start();
		if (block.type === "text") {
			const index = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.blocks.set(apiIndex, { kind: "text", index });
			this.push({ type: "text_start", contentIndex: index, partial: this.output });
		} else if (block.type === "thinking") {
			this.blocks.set(apiIndex, { kind: "thinking", text: block.thinking ?? "", signature: "" });
		} else if (block.type === "tool_use") {
			const name = String(block.name ?? "");
			const call: ToolCall = {
				type: "toolCall",
				id: String(block.id ?? `cc_${apiIndex}`),
				name: name.startsWith(BRIDGE_TOOL_PREFIX) ? name.slice(BRIDGE_TOOL_PREFIX.length) : name,
				arguments: {},
			};
			const index = this.output.content.length;
			this.output.content.push(call);
			this.blocks.set(apiIndex, { kind: "tool", index, json: "", call });
			this.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
		} else {
			this.blocks.set(apiIndex, { kind: "skip" });
		}
	}

	private onBlockDelta(apiIndex: number, delta: Record<string, any>): void {
		const block = this.blocks.get(apiIndex);
		if (!block) return;
		if (block.kind === "text" && delta.type === "text_delta") {
			// Capturing a leaked call: nothing more reaches the learner.
			if (block.capture !== undefined) {
				block.capture += delta.text ?? "";
				block.held = (block.held ?? "") + (delta.text ?? "");
				if (fakeResultAt(block.capture, 0) !== -1) this.endCapture(apiIndex, false);
				return;
			}
			const content = this.output.content[block.index] as TextContent;
			content.text += delta.text ?? "";
			this.push({ type: "text_delta", contentIndex: block.index, delta: delta.text ?? "", partial: this.output });
			this.guardText(apiIndex, content);
		} else if (block.kind === "thinking") {
			if (delta.type === "thinking_delta") block.text += delta.thinking ?? "";
			if (delta.type === "signature_delta") block.signature += delta.signature ?? "";
		} else if (block.kind === "tool" && delta.type === "input_json_delta") {
			block.json += delta.partial_json ?? "";
			this.push({ type: "toolcall_delta", contentIndex: block.index, delta: delta.partial_json ?? "", partial: this.output });
		}
	}

	private onBlockStop(apiIndex: number): void {
		const block = this.blocks.get(apiIndex);
		if (!block) return;
		if (block.kind === "text") {
			if (block.capture !== undefined) return this.endCapture(apiIndex, true);
			const text = (this.output.content[block.index] as TextContent).text;
			this.push({ type: "text_end", contentIndex: block.index, content: text, partial: this.output });
		} else if (block.kind === "thinking") {
			// Claude Code may relay thinking with its text withheld (signature
			// only); an empty block carries nothing worth recording.
			if (!block.text) return;
			const index = this.output.content.length;
			const thinking: ThinkingContent = { type: "thinking", thinking: "", ...(block.signature ? { thinkingSignature: block.signature } : {}) };
			this.output.content.push(thinking);
			this.push({ type: "thinking_start", contentIndex: index, partial: this.output });
			thinking.thinking = block.text;
			this.push({ type: "thinking_delta", contentIndex: index, delta: block.text, partial: this.output });
			this.push({ type: "thinking_end", contentIndex: index, content: block.text, partial: this.output });
		} else if (block.kind === "tool") {
			const raw = block.json.trim() || "{}";
			try {
				const parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) block.call.arguments = parsed as JsonObject;
				else block.call.argumentsError = `Tool arguments were not a JSON object: ${raw}`;
			} catch {
				block.call.argumentsError = `Tool arguments were not valid JSON: ${raw}`;
			}
			this.push({ type: "toolcall_end", contentIndex: block.index, toolCall: block.call, partial: this.output });
		}
	}

	/** Guards on the streamed prose:
	 *  - a tool call written as TEXT → stop showing it, capture the markup
	 *    to its end, and turn it into a real call (endCapture);
	 *  - invented tool results (the fake-call loop) → end right there;
	 *  - a text past MAX_TEXT_CHARS → a runaway, end as "length". */
	private guardText(apiIndex: number, content: TextContent): void {
		const block = this.blocks.get(apiIndex) as Extract<Block, { kind: "text" }>;
		const call = markupAt(content.text, FAKE_CALL_START, block.scanFrom ?? 0);
		if (call !== -1) {
			block.capture = content.text.slice(call);
			block.midLine = !atLineStart(content.text, call);
			const kept = content.text.slice(0, call).trimEnd();
			block.held = content.text.slice(kept.length);
			content.text = kept;
			if (fakeResultAt(block.capture, 0) !== -1) this.endCapture(apiIndex, false);
			return;
		}
		const result = fakeResultAt(content.text, block.scanFrom ?? 0);
		const runaway = content.text.length > MAX_TEXT_CHARS;
		if (result === -1 && !runaway) return;
		if (result !== -1) content.text = content.text.slice(0, result).trimEnd();
		this.onBlockStop(apiIndex);
		this.blocks.delete(apiIndex);
		if (runaway) this.stopReason = "max_tokens";
		this.finish();
	}

	/** Close a captured leaked call (atStop: the block ended; else an
	 *  invented result ended it):
	 *  - complete invokes of SERVED tools → real calls; prose and unserved
	 *    examples before the first one are given back as text;
	 *  - only unserved invokes, or an incomplete mid-line mention → an
	 *    example: given back, streaming continues — unless an invented
	 *    result follows (a hallucinated tool loop): cut there instead;
	 *  - an incomplete line-start call → the turn fails honestly (Retry). */
	private endCapture(apiIndex: number, atStop: boolean): void {
		const block = this.blocks.get(apiIndex) as Extract<Block, { kind: "text" }>;
		const markup = block.capture ?? "";
		const held = block.held ?? markup;
		block.capture = undefined;
		block.held = undefined;
		const content = this.output.content[block.index] as TextContent;
		const parsed = parseLeakedCalls(markup);
		const served = (name: string) => !this.served || this.served.has(name);
		const calls = parsed.filter((c) => served(c.name));
		const example = calls.length === 0 && (parsed.length > 0 || block.midLine);
		if (example && atStop) {
			this.giveBack(block, content, held);
			this.push({ type: "text_end", contentIndex: block.index, content: content.text, partial: this.output });
			this.blocks.delete(apiIndex);
			return;
		}
		if (example) {
			// Unserved markup followed by an invented result: the model is
			// role-playing a tool loop. Keep what it said before; end there.
			this.push({ type: "text_end", contentIndex: block.index, content: content.text, partial: this.output });
			this.blocks.delete(apiIndex);
			this.finish();
			return;
		}
		if (calls.length > 0) {
			// Give back whatever came before the first served invoke.
			const first = [...markup.matchAll(/<(?:\w+:)?invoke name="([^"]+)">/g)].find((m) => served(m[1]!.replace(BRIDGE_TOOL_PREFIX, "")));
			const before = held.slice(0, held.length - markup.length + (first?.index ?? 0)).replace(/<(?:\w+:)?function_calls>\s*$/, "").trimEnd();
			if (before.trim()) this.giveBack(block, content, before);
		}
		this.push({ type: "text_end", contentIndex: block.index, content: content.text, partial: this.output });
		this.blocks.delete(apiIndex);
		console.warn(`[claude-code] tool call written as text — recovered ${calls.length}: ${markup.slice(0, 300).replace(/\s+/g, " ")}`);
		if (calls.length === 0) {
			this.fail("error", "Claude wrote a tool call as text and it could not be recovered — press Retry");
			return;
		}
		calls.forEach((c, n) => {
			const index = this.output.content.length;
			const toolCall: ToolCall = { type: "toolCall", id: `cc_text_${Date.now().toString(36)}_${n}`, name: c.name, arguments: c.arguments };
			this.output.content.push(toolCall);
			this.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
			this.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: this.output });
		});
		this.finish();
	}

	/** Return held text to the visible message; later scans start after it. */
	private giveBack(block: Extract<Block, { kind: "text" }>, content: TextContent, text: string): void {
		content.text += text;
		block.scanFrom = content.text.length;
		block.midLine = undefined;
		this.push({ type: "text_delta", contentIndex: block.index, delta: text, partial: this.output });
	}

	private finish(): void {
		// An EMPTY reply — no text, no call (seen live 2026-10-26: a stop with
		// 0 output tokens right after a probe answer) — would end the turn
		// silently with nothing on screen; fail it so the learner gets Retry.
		const said = this.output.content.some((c) => (c.type === "text" && c.text.trim()) || c.type === "toolCall");
		if (!said && !this.delivered && this.stopReason !== "max_tokens") {
			this.output.usage = toPiUsage(this.rawUsage);
			this.fail("error", "Claude returned an empty reply — press Retry");
			return;
		}
		this.finished = true;
		this.output.usage = toPiUsage(this.rawUsage);
		// Ended before the API's final usage (a guard cut the stream): the
		// message_start count is a placeholder (1-3) — estimate from what was
		// produced instead (chars/4, pi's heuristic) so the meters stay honest.
		if (!this.stopReason) {
			const produced = this.output.content.reduce(
				(n, c) => n + (c.type === "text" ? c.text.length : c.type === "toolCall" ? JSON.stringify(c.arguments).length : c.type === "thinking" ? c.thinking.length : 0),
				0,
			);
			const estimate = Math.ceil(produced / 4);
			if (estimate > this.output.usage.output) {
				this.output.usage.totalTokens += estimate - this.output.usage.output;
				this.output.usage.output = estimate;
			}
		}
		if (this.stopReason) this.output.rawStopReason = this.stopReason;
		const hasCalls = this.output.content.some((c) => c.type === "toolCall");
		const reason = hasCalls ? "toolUse" : this.stopReason === "max_tokens" ? "length" : "stop";
		this.output.stopReason = reason;
		this.push({ type: "done", reason, message: this.output });
	}

	/** End the stream as failed/aborted (after `start`, per pi's protocol). */
	fail(reason: "error" | "aborted", message: string): void {
		if (this.finished) return;
		this.finished = true;
		this.start();
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.push({ type: "error", reason, error: this.output });
	}
}

/** Where bridged calls run: an empty dir, so the CLI finds no CLAUDE.md. */
function scratchRoot(): string {
	const root = path.join(tmpdir(), "learnharness-claude-code");
	mkdirSync(root, { recursive: true });
	return root;
}

/** Write one call's files: system prompt, MCP server + its tool list, MCP config. */
function writeCallFiles(dir: string, systemPrompt: string, tools: readonly Tool[]) {
	const files = {
		systemPrompt: path.join(dir, "system-prompt.md"),
		mcpConfig: path.join(dir, "mcp.json"),
	};
	const serverFile = path.join(dir, "mcp-server.cjs");
	const toolsFile = path.join(dir, "tools.json");
	writeFileSync(files.systemPrompt, systemPrompt);
	writeFileSync(serverFile, MCP_SERVER_SOURCE);
	writeFileSync(toolsFile, JSON.stringify(mcpToolList(tools)));
	writeFileSync(
		files.mcpConfig,
		JSON.stringify({
			mcpServers: {
				[BRIDGE_MCP_SERVER]: { command: process.execPath, args: [serverFile, toolsFile], env: { ELECTRON_RUN_AS_NODE: "1" } },
			},
		}),
	);
	return files;
}

/** Did the model already call send_to_user since the learner last spoke
 *  (a user message or a question answer)? Then an empty reply just ends
 *  the turn; otherwise it is the silent-turn failure (exported for tests). */
export function deliveredSinceLearner(context: TranscriptContext): boolean {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const m = context.messages[i]!;
		if (m.role === "user") return false;
		if (m.role === "toolResult" && (QUESTION_TOOLS as readonly string[]).includes(m.toolName)) return false;
		if (m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.name === SEND_TO_USER_TOOL)) return true;
	}
	return false;
}

/** Stream one model request through `claude -p`. */
export function streamClaudeCode(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const { systemPrompt, content, tools } = renderBridgePrompt(context);
	const assembler = new BridgeAssembler(model, (event) => stream.push(event), new Set(tools.map((t) => t.name)), deliveredSinceLearner(context));
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		stream.end(assembler.output);
	};

	const bin = findClaudeBinary();
	if (!bin) {
		queueMicrotask(() => {
			assembler.fail("error", `Claude Code CLI not found — install it or set ${CLAUDE_BIN_ENV}`);
			end();
		});
		return stream;
	}

	const callDir = mkdtempSync(path.join(scratchRoot(), "call-"));
	const files = writeCallFiles(callDir, systemPrompt, tools);

	const child = spawn(bin, bridgeArgs(model.id, files, options?.reasoning), {
		cwd: callDir,
		env: childEnv(process.env),
		stdio: ["pipe", "pipe", "pipe"],
	});

	let settled = false;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const touch = () => {
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => settle(() => assembler.fail("error", "Claude Code stopped responding (no output for 3 minutes)")), IDLE_TIMEOUT_MS);
	};
	const settle = (run: () => void) => {
		if (settled) return;
		settled = true;
		if (idle) clearTimeout(idle);
		options?.signal?.removeEventListener("abort", onAbort);
		if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
		rmSync(callDir, { recursive: true, force: true });
		run();
		end();
	};
	const onAbort = () => settle(() => assembler.fail("aborted", "Request was aborted"));
	if (options?.signal?.aborted) {
		onAbort();
		return stream;
	}
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	let pending = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	touch();
	child.stdout.on("data", (chunk: string) => {
		touch();
		pending += chunk;
		let nl: number;
		while ((nl = pending.indexOf("\n")) !== -1) {
			const line = pending.slice(0, nl);
			pending = pending.slice(nl + 1);
			// First message complete → the response is whole; end the run
			// before the CLI does anything with it.
			if (assembler.feed(line)) {
				settle(() => {});
				return;
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});
	child.on("error", (err) => settle(() => assembler.fail("error", `Claude Code CLI failed to start: ${err.message}`)));
	child.on("close", (code) => {
		settle(() => {
			if (pending) assembler.feed(pending);
			if (assembler.done) return;
			const tail = stderr.trim() ? ` — ${stderr.trim().split("\n").slice(-3).join(" ")}` : "";
			const base = assembler.resultError ?? "Claude Code ended without a response";
			assembler.fail("error", `${base}${code ? ` (exit ${code})` : ""}${tail}`);
		});
	});

	child.stdin.on("error", () => {});
	// One stream-json user message, then EOF: the CLI answers it and ends.
	child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
	return stream;
}
