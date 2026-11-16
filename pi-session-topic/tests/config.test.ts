import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
	applyEnv,
	coerceConfig,
	CONFIG_FILE,
	configPath,
	DEFAULT_CONFIG,
	describeConfig,
	loadConfig,
	resetConfig,
	saveConfig,
	validCells,
} from "../extensions/config.ts"

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-topic-"))
	test.after?.(() => rmSync(dir, { recursive: true, force: true }))
	return dir
}

test("loadConfig: a missing file is the default config", () => {
	assert.deepEqual(loadConfig(tempDir()), DEFAULT_CONFIG)
})

test("loadConfig: a broken file is the default config, not a crash", () => {
	const dir = tempDir()
	writeFileSync(configPath(dir), "{ not json")
	assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG)
})

test("coerceConfig: one bad field does not discard the good ones", () => {
	const config = coerceConfig({ enabled: false, maxCells: "nonsense", model: 42, debug: true, extra: "ignored" })
	assert.deepEqual(config, { enabled: false, model: null, maxCells: DEFAULT_CONFIG.maxCells, debug: true })
})

test("coerceConfig: a blank model is null (session model)", () => {
	assert.equal(coerceConfig({ model: "   " }).model, null)
	assert.equal(coerceConfig({ model: " openai/gpt-5-mini " }).model, "openai/gpt-5-mini")
})

test("validCells: bounds and parsing", () => {
	assert.equal(validCells(48), 48)
	assert.equal(validCells("32"), 32)
	assert.equal(validCells(7), undefined)
	assert.equal(validCells(201), undefined)
	assert.equal(validCells("x"), undefined)
	assert.equal(validCells(undefined), undefined)
})

test("saveConfig: merges into the stored config and writes the file", () => {
	const dir = tempDir()
	saveConfig({ enabled: false }, dir)
	saveConfig({ maxCells: 32 }, dir)
	assert.deepEqual(loadConfig(dir), { ...DEFAULT_CONFIG, enabled: false, maxCells: 32 })

	const written = JSON.parse(readFileSync(configPath(dir), "utf8"))
	assert.equal(written.enabled, false)
	assert.equal(written.maxCells, 32)
	assert.equal(CONFIG_FILE, "pi-session-topic.json")
})

test("resetConfig: overwrites stored values with the defaults on disk", () => {
	const dir = tempDir()
	saveConfig({ maxCells: 100, enabled: false, model: "a/b" }, dir)
	assert.deepEqual(resetConfig(dir), DEFAULT_CONFIG)
	assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG)

	const written = JSON.parse(readFileSync(configPath(dir), "utf8"))
	assert.equal(written.maxCells, DEFAULT_CONFIG.maxCells)
	assert.equal(written.enabled, DEFAULT_CONFIG.enabled)
	assert.equal(written.model, DEFAULT_CONFIG.model)
})

test("applyEnv: overrides the file, and empty values are ignored", () => {
	const base = { enabled: true, model: "a/b", maxCells: 48, debug: false }
	assert.deepEqual(applyEnv(base, { PI_SESSION_TOPIC_OFF: "1" }), { ...base, enabled: false })
	assert.deepEqual(applyEnv(base, { PI_SESSION_TOPIC_OFF: "0" }), { ...base, enabled: true })
	assert.deepEqual(applyEnv(base, { PI_SESSION_TOPIC_MODEL: "c/d" }), { ...base, model: "c/d" })
	assert.deepEqual(applyEnv(base, { PI_SESSION_TOPIC_MODEL: "  " }), base)
	assert.deepEqual(applyEnv(base, { PI_SESSION_TOPIC_MAX_CELLS: "24" }), { ...base, maxCells: 24 })
	assert.deepEqual(applyEnv(base, { PI_SESSION_TOPIC_MAX_CELLS: "4" }), base)
	assert.deepEqual(applyEnv(base, { PI_SESSION_TOPIC_DEBUG: "on" }), { ...base, debug: true })
	assert.deepEqual(applyEnv(base, {}), base)
})

test("describeConfig: names the session model and flags env overrides", () => {
	const env = { PI_SESSION_TOPIC_MODEL: "c/d" }
	const text = describeConfig(applyEnv(DEFAULT_CONFIG, env), env)
	assert.match(text, /model\s+c\/d\s+\(env override\)/)
	assert.match(text, /enabled\s+on/)
	assert.match(text, /maxCells\s+48/)
})
