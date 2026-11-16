// pi-session-topic — give a session a one-line topic title.
//
// The `/resume` picker shows `session.name ?? firstMessage`
// (pi source: modes/interactive/components/session-selector.js). A long first
// prompt therefore fills the whole row. This extension names the session from
// its first prompt through a side-channel model call, so the picker shows a
// short topic instead. The call is a separate provider request: it appends
// nothing to the session and never enters the transcript or context window, so
// the agent's own prompt prefix — and its prompt cache — is untouched.
//
// Rules, all enforced by generateAndApply():
//   - a manual name (`/name`, `--name`, picker rename) always wins;
//   - the reply is dropped when the session switched while it was in flight;
//   - failures are silent: an empty title or a 4xx counts toward a cap of two
//     attempts per session, while network errors, timeouts, 429 and 5xx retry
//     on the next message.
//
// Commands:
//   /topic [title]     regenerate from the first message, or set a title
//   /session-topic     show or change the settings (see CONFIG_HELP)

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
	applyEnv,
	coerceConfig,
	CONFIG_HELP,
	describeConfig,
	loadConfig,
	resetConfig,
	saveConfig,
	type TopicConfig,
} from "./config.ts"
import { assistantText, buildTopicRequest, generateAndApply } from "./title.ts"

/** Deterministic failures (empty title, 4xx) stop retrying after this many. */
const MAX_ATTEMPTS = 2
/** Upper bound on one title request; it must never outlive a session by much. */
const REQUEST_TIMEOUT_MS = 20_000
const TITLE_MAX_TOKENS = 512
/** Safety net for a model that spends the whole first budget before the title. */
const RETRY_MAX_TOKENS = 2048
/** Thinking allowance for the lowest effort, where the adapter honours it. */
const MINIMAL_THINKING_BUDGET = { minimal: 256 }

interface SessionState {
	pending: boolean
	attempts: number
}

export default function sessionTopic(pi: ExtensionAPI): void {
	const states = new Map<string, SessionState>()
	// Settings are re-read on every session start, so a `/session-topic` change
	// (or a hand edit) applies without a reload.
	let config: TopicConfig = applyEnv(loadConfig())

	const reloadConfig = () => {
		config = applyEnv(loadConfig())
	}

	pi.on("session_start", () => {
		states.clear()
		reloadConfig()
	})
	pi.on("session_shutdown", () => states.clear())

	pi.on("before_agent_start", (event, ctx) => {
		// Custom-message runs have no prompt; only a user prompt can carry a topic.
		const outgoing = (event as { prompt?: unknown }).prompt
		if (typeof outgoing !== "string") return
		if (!config.enabled) return

		const prompt = outgoing.trim()
		if (!prompt) return
		if (pi.getSessionName()?.trim()) return

		const sessionId = ctx.sessionManager.getSessionId()
		const state = states.get(sessionId) ?? { pending: false, attempts: 0 }
		states.set(sessionId, state)
		if (state.pending || state.attempts >= MAX_ATTEMPTS) return

		const model = resolveModel(ctx, config.model)
		if (!model) return

		state.pending = true
		// The handler must return synchronously: pi awaits it before the run
		// starts, and the title must not delay the user's work.
		void nameSession(pi, ctx, sessionId, prompt, model, state, config).catch((error) =>
			debug(config, `failed: ${describe(error)}`),
		)
	})

	pi.registerCommand("topic", {
		description: "Regenerate this session's title from its first message, or set one (usage: /topic [title])",
		handler: async (args, ctx) => {
			const manual = args.trim()
			if (manual) {
				pi.setSessionName(manual)
				ctx.ui.notify(`Session title: ${manual}`, "info")
				return
			}

			const prompt = firstUserText(ctx)
			if (!prompt) {
				ctx.ui.notify("No user message in this session yet", "warning")
				return
			}
			const model = resolveModel(ctx, config.model)
			if (!model) {
				ctx.ui.notify("No model available for title generation", "warning")
				return
			}

			try {
				const outcome = await generateAndApply(prompt, {
					sessionId: ctx.sessionManager.getSessionId(),
					currentSessionId: () => ctx.sessionManager.getSessionId(),
					getSessionName: () => pi.getSessionName(),
					setSessionName: (name) => pi.setSessionName(name),
					completeQuestion: (text) => completeTitle(ctx, model, text, config),
					maxWidth: config.maxCells,
					force: true,
				})
				if (outcome === "switched") ctx.ui.notify("Session changed; title not applied", "warning")
				else if (outcome === "empty") ctx.ui.notify("The model returned no usable title", "warning")
				else ctx.ui.notify(`Session title: ${pi.getSessionName() ?? "(unchanged)"}`, "info")
				debug(config, `manual outcome=${outcome} name=${JSON.stringify(pi.getSessionName())}`)
			} catch (error) {
				ctx.ui.notify(`Title generation failed: ${describe(error)}`, "error")
			}
		},
	})

	pi.registerCommand("session-topic", {
		description: "Show or change pi-session-topic settings (usage: /session-topic [key value])",
		handler: async (args, ctx) => {
			const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean)
			if (!key) {
				ctx.ui.notify(`${describeConfig(config)}\n\n${CONFIG_HELP}`, "info")
				return
			}

			const value = rest.join(" ")
			const patch = parseSetting(key, value)
			if (typeof patch === "string") {
				ctx.ui.notify(patch, "warning")
				return
			}

			const stored = patch ? saveConfig(patch) : resetConfig()
			reloadConfig()
			ctx.ui.notify(`${patch ? "Saved" : "Reset to defaults"}\n\n${describeConfig(applyEnv(stored))}`, "info")
		},
	})
}

/** `/session-topic key value` → patch, a warning string, or undefined for "reset". */
function parseSetting(key: string, value: string): Partial<TopicConfig> | string | undefined {
	const text = value.trim()
	switch (key.toLowerCase()) {
		case "reset":
			return undefined
		case "enabled":
			if (text === "on" || text === "true" || text === "1") return { enabled: true }
			if (text === "off" || text === "false" || text === "0") return { enabled: false }
			return `enabled takes on or off, not "${text}".\n\n${CONFIG_HELP}`
		case "debug":
			if (text === "on" || text === "true" || text === "1") return { debug: true }
			if (text === "off" || text === "false" || text === "0") return { debug: false }
			return `debug takes on or off, not "${text}".\n\n${CONFIG_HELP}`
		case "model":
			if (!text || text === "session" || text === "default") return { model: null }
			return { model: text }
		case "maxcells":
		case "max-cells": {
			const cells = Number.parseInt(text, 10)
			if (!Number.isFinite(cells)) return `maxCells takes a number, not "${text}".\n\n${CONFIG_HELP}`
			if (coerceConfig({ maxCells: cells }).maxCells !== cells) {
				return `maxCells must be between 8 and 200, not ${cells}.`
			}
			return { maxCells: cells }
		}
		default:
			return `Unknown setting "${key}".\n\n${CONFIG_HELP}`
	}
}

async function nameSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	sessionId: string,
	prompt: string,
	model: Model<Api>,
	state: SessionState,
	config: TopicConfig,
): Promise<void> {
	try {
		const outcome = await generateAndApply(prompt, {
			sessionId,
			currentSessionId: () => ctx.sessionManager.getSessionId(),
			getSessionName: () => pi.getSessionName(),
			setSessionName: (name) => pi.setSessionName(name),
			completeQuestion: (text) => completeTitle(ctx, model, text, config),
			maxWidth: config.maxCells,
		})
		if (outcome === "empty") state.attempts++
		debug(config, `auto outcome=${outcome} name=${JSON.stringify(pi.getSessionName())} session=${sessionId}`)
	} catch (error) {
		// pi replaces the runtime on /new, /resume, /fork and /reload. A title that
		// lands after that has no session to name: drop it, do not count a failure.
		if (isStaleRuntime(error)) {
			debug(config, "dropped: runtime replaced while the request was in flight")
			return
		}
		// A 4xx is deterministic (wrong model id, rejected prompt) and stops
		// retrying; network errors, timeouts and 429 retry on the next message.
		if (isDeterministic(error)) state.attempts++
		debug(config, `auto error=${describe(error)} attempts=${state.attempts}`)
	} finally {
		state.pending = false
	}
}

async function completeTitle(
	ctx: ExtensionContext,
	model: Model<Api>,
	prompt: string,
	config: TopicConfig,
): Promise<string> {
	const request = buildTopicRequest(prompt)
	const ask = async (maxTokens: number) => {
		// `streamSimple` carries the thinking control. A reasoning model asked at
		// its default effort spends whole budgets thinking and never writes the
		// title, so it gets the lowest effort here.
		const message = await ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt: request.systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: request.userText }], timestamp: Date.now() }],
				},
				{
					maxTokens,
					temperature: 0.2,
					maxRetries: 0,
					...(model.reasoning ? { reasoning: "minimal" as const, thinkingBudgets: MINIMAL_THINKING_BUDGET } : {}),
					// A title prompt is too small to be worth caching in any direction.
					cacheRetention: "none",
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				},
			)
			.result()
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? message.stopReason)
		}
		const text = assistantText(message)
		debug(config, `reply stop=${message.stopReason} maxTokens=${maxTokens} chars=${text.length}`)
		return text
	}

	const text = await ask(TITLE_MAX_TOKENS)
	// Safety net: an empty reply retries once with a larger budget.
	return text || ask(RETRY_MAX_TOKENS)
}

/** `provider/model-id`, or a bare model id resolved against the catalogue. */
function resolveModel(ctx: ExtensionContext, override: string | null): Model<Api> | undefined {
	if (!override) return ctx.model as Model<Api> | undefined

	const slash = override.indexOf("/")
	if (slash > 0) {
		const found = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1))
		if (found) return found
	}
	const bare = ctx.modelRegistry.getAll().filter((model) => model.id === override || `${model.provider}/${model.id}` === override)
	return (bare.find((model) => ctx.modelRegistry.hasConfiguredAuth(model)) ?? bare[0]) as Model<Api> | undefined
}

/** First user message text on the active branch, for `/topic`. */
function firstUserText(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue
		const message = entry.message as { role?: string; content?: unknown }
		if (message.role !== "user") continue
		const text = messageText(message.content)
		if (text?.trim()) return text
	}
	return undefined
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.filter((part): part is { type: string; text: string } => {
			const candidate = part as { type?: unknown; text?: unknown }
			return candidate.type === "text" && typeof candidate.text === "string"
		})
		.map((part) => part.text)
		.join("\n")
}

function isDeterministic(error: unknown): boolean {
	const status = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode
	return typeof status === "number" && status >= 400 && status < 500 && status !== 429
}

/** pi's wording when a captured `pi` or `ctx` belongs to a replaced runtime. */
function isStaleRuntime(error: unknown): boolean {
	return /ctx is stale/i.test(describe(error))
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Diagnostics for a silent feature: `debug` setting or PI_SESSION_TOPIC_DEBUG=1. */
function debug(config: TopicConfig, message: string): void {
	if (!config.debug) return
	process.stderr.write(`[pi-session-topic] ${message}\n`)
}
