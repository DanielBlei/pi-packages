// Settings for pi-session-topic.
//
// Stored in `<agent dir>/pi-session-topic.json` (the same place pi-keeper
// and pi-cc-extensions keep theirs), re-read on `session_start`, written by
// `/session-topic`. Environment variables stay as one-off overrides and win
// over the file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

export interface TopicConfig {
	/** Automatic naming on the first prompt of an unnamed session. */
	enabled: boolean
	/** `provider/model-id` for the title request; null uses the session model. */
	model: string | null
	/** Title budget in terminal cells (CJK counts double). */
	maxCells: number
	/** Write request outcomes to stderr. */
	debug: boolean
}

export const CONFIG_FILE = "pi-session-topic.json"

export const DEFAULT_CONFIG: TopicConfig = {
	enabled: true,
	model: null,
	maxCells: 48,
	debug: false,
}

export const MIN_CELLS = 8
export const MAX_CELLS = 200

export function configPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, CONFIG_FILE)
}

/** Read the file, keeping only valid fields; a missing or broken file is the default. */
export function loadConfig(agentDir: string = getAgentDir()): TopicConfig {
	const path = configPath(agentDir)
	if (!existsSync(path)) return { ...DEFAULT_CONFIG }
	try {
		return coerceConfig(JSON.parse(readFileSync(path, "utf8")))
	} catch {
		return { ...DEFAULT_CONFIG }
	}
}

/** Field-by-field validation: one bad value must not discard the rest. */
export function coerceConfig(raw: unknown): TopicConfig {
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
	return {
		enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.enabled,
		model: typeof source.model === "string" && source.model.trim() ? source.model.trim() : null,
		maxCells: validCells(source.maxCells) ?? DEFAULT_CONFIG.maxCells,
		debug: typeof source.debug === "boolean" ? source.debug : DEFAULT_CONFIG.debug,
	}
}

export function validCells(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN
	if (!Number.isFinite(parsed)) return undefined
	if (parsed < MIN_CELLS || parsed > MAX_CELLS) return undefined
	return Math.round(parsed)
}

/** Merge a patch into the stored config and write it back. */
export function saveConfig(patch: Partial<TopicConfig>, agentDir: string = getAgentDir()): TopicConfig {
	const next = coerceConfig({ ...loadConfig(agentDir), ...patch })
	const path = configPath(agentDir)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
	return next
}

/** Write the defaults over the stored file. A merge would keep the old values. */
export function resetConfig(agentDir: string = getAgentDir()): TopicConfig {
	const path = configPath(agentDir)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
	return { ...DEFAULT_CONFIG }
}

export interface ConfigEnvironment {
	PI_SESSION_TOPIC_OFF?: string
	PI_SESSION_TOPIC_MODEL?: string
	PI_SESSION_TOPIC_MAX_CELLS?: string
	PI_SESSION_TOPIC_DEBUG?: string
}

/** Environment overrides on top of the file. Empty values are ignored. */
export function applyEnv(config: TopicConfig, env: ConfigEnvironment = process.env): TopicConfig {
	const resolved = { ...config }
	const off = flag(env.PI_SESSION_TOPIC_OFF)
	if (off !== undefined) resolved.enabled = !off

	const model = env.PI_SESSION_TOPIC_MODEL?.trim()
	if (model) resolved.model = model

	const cells = validCells(env.PI_SESSION_TOPIC_MAX_CELLS)
	if (cells !== undefined) resolved.maxCells = cells

	const debug = flag(env.PI_SESSION_TOPIC_DEBUG)
	if (debug !== undefined) resolved.debug = debug
	return resolved
}

function flag(value: string | undefined): boolean | undefined {
	const text = value?.trim().toLowerCase()
	if (!text) return undefined
	if (text === "1" || text === "true" || text === "on") return true
	if (text === "0" || text === "false" || text === "off") return false
	return undefined
}

/** Multi-line summary for `/session-topic`. */
export function describeConfig(config: TopicConfig, env: ConfigEnvironment = process.env): string {
	const overridden = (name: keyof ConfigEnvironment, active: boolean) =>
		active && env[name]?.trim() ? "  (env override)" : ""
	const lines = [
		`enabled   ${config.enabled ? "on" : "off"}${overridden("PI_SESSION_TOPIC_OFF", true)}`,
		`model     ${config.model ?? "session model"}${overridden("PI_SESSION_TOPIC_MODEL", true)}`,
		`maxCells  ${config.maxCells}${overridden("PI_SESSION_TOPIC_MAX_CELLS", true)}`,
		`debug     ${config.debug ? "on" : "off"}${overridden("PI_SESSION_TOPIC_DEBUG", true)}`,
		`file      ${configPath()}`,
	]
	return lines.join("\n")
}

export const CONFIG_HELP =
	"Usage: /session-topic [enabled on|off] [model <provider/id>|session] [maxCells <8-200>] [debug on|off] [reset]"
