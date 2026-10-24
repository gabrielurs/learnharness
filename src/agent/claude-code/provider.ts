import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { findClaudeBinary, streamClaudeCode } from "./cli.ts";

/**
 * The "claude-code" provider (2026-10-24): Claude models served through
 * the user's local Claude Code CLI and its subscription login, instead of
 * an API key. Owner scope: Opus 5.5 and Sonnet 5.5 only.
 *
 * Registered into piModels() beside the builtin providers, so every
 * agent, sub-agent, picker and settings path sees it as one more provider;
 * nothing downstream knows a CLI is involved. "Configured" means the
 * `claude` binary is installed — the login itself is the CLI's business,
 * and an unauthenticated CLI fails its first call with its own message.
 */

export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_API = "claude-code-cli";

/** The CLI owns effort; the models expose the same levels Anthropic's
 *  catalog maps for these ids (no off/minimal: they always reason). */
const THINKING_LEVEL_MAP = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } as const;

function cliModel(id: string, name: string): Model<typeof CLAUDE_CODE_API> {
	return {
		id,
		name,
		api: CLAUDE_CODE_API,
		provider: CLAUDE_CODE_PROVIDER,
		baseUrl: "cli://claude",
		reasoning: true,
		// Images ride the bridged user message inline (stream-json input).
		input: ["text", "image"],
		// Subscription usage: no per-token price, so the cost meter reads 0.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Conservative: the window a subscription session gets is not exposed.
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinkingLevelMap: THINKING_LEVEL_MAP,
	};
}

export const CLAUDE_CODE_MODELS = [
	cliModel("claude-opus-5-5", "Claude Opus 5.5 (Claude Code)"),
	cliModel("claude-sonnet-5-5", "Claude Sonnet 5.5 (Claude Code)"),
] as const;

/** Is the bridge usable right now (the CLI is installed)? */
export function claudeCodeAvailable(): boolean {
	return findClaudeBinary() !== undefined;
}

export function claudeCodeProvider(): Provider {
	return createProvider({
		id: CLAUDE_CODE_PROVIDER,
		name: "Claude Code",
		auth: {
			apiKey: {
				name: "Claude Code login",
				resolve: async () => (claudeCodeAvailable() ? { auth: {}, source: "claude CLI" } : undefined),
			},
		},
		models: CLAUDE_CODE_MODELS,
		api: { stream: streamClaudeCode, streamSimple: streamClaudeCode },
	}) as Provider;
}
