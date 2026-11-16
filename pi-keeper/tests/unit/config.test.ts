/**
 * Tests for the user-level settings file. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULT_READ_ONLY_TOOLS, formatDuration, loadConfig, parseConfig, parseDuration, saveConfig } from "../../extensions/config.ts";

const defaults = new Set(DEFAULT_READ_ONLY_TOOLS);

test("defaults cover the web, code-overview, LSP, ast and MCP readers", () => {
	// the whole set, so adding or dropping a name is a deliberate decision
	assert.deepEqual([...DEFAULT_READ_ONLY_TOOLS].sort(), [
		"ast_search", "bg_wait", "code_overview", "fetch_content", "get_search_content",
		"list_mcp_resource_templates", "list_mcp_resources", "lsp_code_actions", "lsp_completions",
		"lsp_definition", "lsp_diagnostics", "lsp_hover", "lsp_references", "lsp_symbols",
		"read_mcp_resource", "source_check", "todo", "web_search",
	]);
	for (const name of ["bash", "edit", "write", "exit_plan_mode"]) assert.ok(!defaults.has(name), name);
	// only previews a rename today, but the name promises a write: fail closed
	assert.ok(!defaults.has("lsp_rename"), "lsp_rename");
});

test("a listed readOnlyTools replaces the defaults", () => {
	const config = parseConfig(JSON.stringify({ readOnlyTools: ["my_tool", "other-tool"] }));
	assert.deepEqual([...config.readOnlyTools].sort(), ["my_tool", "other-tool"]);
	assert.deepEqual(config.warnings, []);
});

test("an empty list turns the allowance off", () => {
	assert.equal(parseConfig('{"readOnlyTools": []}').readOnlyTools.size, 0);
});

test("a file without readOnlyTools keeps the defaults without a warning", () => {
	const config = parseConfig("{}");
	assert.deepEqual(config.readOnlyTools, defaults);
	assert.deepEqual(config.warnings, []);
});

test("names must be plain tool names; the rest are ignored with a warning", () => {
	const config = parseConfig(JSON.stringify({ readOnlyTools: ["ok_tool", "*", "bash -c", 7, "../x", ""] }));
	assert.deepEqual([...config.readOnlyTools], ["ok_tool"]);
	assert.equal(config.warnings.length, 5);
});

test("unusable files fall back to the defaults with one warning", () => {
	for (const text of ["not json", "[]", "null", '{"readOnlyTools": "web_search"}']) {
		const config = parseConfig(text);
		assert.deepEqual(config.readOnlyTools, defaults, text);
		assert.equal(config.warnings.length, 1, text);
	}
});

test("loadConfig reads <agent dir>/pi-keeper.json; absent means defaults and no warning", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		assert.deepEqual(loadConfig(dir), { readOnlyTools: defaults, autoSubagents: false, persistentProjectRules: false, backgroundAuto: false, projectCommands: true, projectReadDirs: false, modeInstructions: "message", backgroundAsks: true, backgroundAskTimeoutMs: 300000, backgroundAskPopup: "idle", subagentThinking: "follow", previewTextColor: "dim", warnings: [] });
		writeFileSync(join(dir, CONFIG_FILE), '{"readOnlyTools": ["x_tool"]}');
		assert.deepEqual([...loadConfig(dir).readOnlyTools], ["x_tool"]);
		writeFileSync(join(dir, CONFIG_FILE), "{broken");
		assert.equal(loadConfig(dir).warnings.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("autoSubagents, persistentProjectRules and backgroundAuto: absent or a boolean reads as-is, anything else warns and stays off", () => {
	assert.equal(parseConfig("{}").autoSubagents, false);
	assert.equal(parseConfig('{"autoSubagents": true}').autoSubagents, true);
	assert.equal(parseConfig('{"autoSubagents": false}').autoSubagents, false);
	assert.equal(parseConfig("{}").persistentProjectRules, false);
	assert.equal(parseConfig('{"persistentProjectRules": true}').persistentProjectRules, true);
	assert.equal(parseConfig("{}").backgroundAuto, false);
	assert.equal(parseConfig('{"backgroundAuto": true}').backgroundAuto, true);
	const bad = parseConfig('{"autoSubagents": "yes", "persistentProjectRules": 7, "backgroundAuto": "on"}');
	assert.equal(bad.autoSubagents, false);
	assert.equal(bad.persistentProjectRules, false);
	assert.equal(bad.backgroundAuto, false);
	assert.deepEqual(bad.warnings, ["autoSubagents must be true or false; using false", "persistentProjectRules must be true or false; using false", "backgroundAuto must be true or false; using false"]);
	// one bad key doesn't hide the other
	const mixed = parseConfig('{"readOnlyTools": ["x_tool"], "autoSubagents": 7}');
	assert.deepEqual([...mixed.readOnlyTools], ["x_tool"]);
	assert.equal(mixed.autoSubagents, false);
});

test("saveConfig merges into the file, keeps unknown keys, creates it when absent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		const file = join(dir, CONFIG_FILE);
		// absent: created
		assert.equal(saveConfig(dir, { autoSubagents: true }), undefined);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).autoSubagents, true);
		// merges into what is there, keeping unknown keys and other settings
		writeFileSync(file, '{"readOnlyTools": ["x_tool"], "future": {"a": 1}}');
		assert.equal(saveConfig(dir, { autoSubagents: false, persistentProjectRules: true, backgroundAuto: true }), undefined);
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(saved, { readOnlyTools: ["x_tool"], future: { a: 1 }, autoSubagents: false, persistentProjectRules: true, backgroundAuto: true });
		assert.ok(statSync(file).isFile());
		// what it wrote loads back
		assert.equal(loadConfig(dir).autoSubagents, false);
		assert.deepEqual([...loadConfig(dir).readOnlyTools], ["x_tool"]);
		// a broken file is replaced, not merged
		writeFileSync(file, "{broken");
		assert.equal(saveConfig(dir, { autoSubagents: true }), undefined);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).autoSubagents, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveConfig warns instead of throwing when the file can't be written", () => {
	// the config path is a directory: neither read nor write can work
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		mkdirSync(join(dir, CONFIG_FILE));
		assert.match(saveConfig(dir, { autoSubagents: true }) ?? "", /could not (read|write)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tools that front other tools, and the writers, are rejected with a warning each", () => {
	const config = parseConfig(JSON.stringify({ readOnlyTools: ["mcp", "subagent", "bash", "powershell", "edit", "write", "exit_plan_mode", "web_search"] }));
	assert.deepEqual([...config.readOnlyTools], ["web_search"]);
	assert.equal(config.warnings.length, 7);
	assert.ok(config.warnings.every((w) => /can't be listed/.test(w)));
	for (const name of ["mcp", "subagent", "bash", "edit", "write"]) assert.ok(!defaults.has(name), `${name} is not a default`);
});

test("previewTextColor: the five values read as-is; absent is dim; anything else warns and stays dim", () => {
	assert.equal(parseConfig("{}").previewTextColor, "dim");
	for (const value of ["dim", "muted", "text", "builtin-syntax", "shell-highlight"]) {
		assert.equal(parseConfig(`{"previewTextColor": "${value}"}`).previewTextColor, value);
	}
	// the old single "syntax" value is gone: a stale file says so instead of meaning something else
	for (const text of ['{"previewTextColor": "warning"}', '{"previewTextColor": "syntax"}', '{"previewTextColor": 7}', '{"previewTextColor": null}']) {
		const config = parseConfig(text);
		assert.equal(config.previewTextColor, "dim", text);
		assert.deepEqual(config.warnings, ['previewTextColor must be "dim", "muted", "text", "builtin-syntax" or "shell-highlight"; using "dim"'], text);
	}
});

test("saveConfig keeps a hand-written previewTextColor when it writes another setting", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		writeFileSync(join(dir, CONFIG_FILE), '{"previewTextColor": "muted"}');
		assert.equal(saveConfig(dir, { autoSubagents: true }), undefined);
		const saved = JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"));
		assert.equal(saved.previewTextColor, "muted");
		assert.equal(saved.autoSubagents, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backgroundAskPopup: idle, always or badge reads as-is; absent is idle; anything else warns and stays idle", () => {
	assert.equal(parseConfig("{}").backgroundAskPopup, "idle");
	for (const value of ["idle", "always", "badge"]) assert.equal(parseConfig(`{"backgroundAskPopup": "${value}"}`).backgroundAskPopup, value);
	for (const text of ['{"backgroundAskPopup": "never"}', '{"backgroundAskPopup": true}']) {
		const config = parseConfig(text);
		assert.equal(config.backgroundAskPopup, "idle", text);
		assert.deepEqual(config.warnings, ['backgroundAskPopup must be "idle", "always" or "badge"; using "idle"'], text);
	}
});

test("backgroundAsks defaults to true; backgroundAskTimeoutMs defaults to 5 minutes and is bounded with a warning", () => {
	assert.equal(parseConfig("{}").backgroundAsks, true);
	assert.equal(parseConfig('{"backgroundAsks": false}').backgroundAsks, false);
	assert.deepEqual(parseConfig('{"backgroundAsks": "no"}').warnings, ["backgroundAsks must be true or false; using true"]);
	assert.equal(parseConfig("{}").backgroundAskTimeoutMs, 300000);
	assert.equal(parseConfig('{"backgroundAskTimeoutMs": 60000}').backgroundAskTimeoutMs, 60000);
	const low = parseConfig('{"backgroundAskTimeoutMs": 5}');
	assert.equal(low.backgroundAskTimeoutMs, 10000);
	assert.equal(low.warnings.length, 1);
	assert.equal(parseConfig('{"backgroundAskTimeoutMs": 99999999}').backgroundAskTimeoutMs, 1800000);
	const bad = parseConfig('{"backgroundAskTimeoutMs": "soon"}');
	assert.equal(bad.backgroundAskTimeoutMs, 300000);
	assert.equal(bad.warnings.length, 1);
});

test("parseDuration takes minutes and/or seconds with units, nothing else", () => {
	assert.equal(parseDuration("90s"), 90_000);
	assert.equal(parseDuration("5m"), 300_000);
	assert.equal(parseDuration("2m30s"), 150_000);
	assert.equal(parseDuration(" 5M "), 300_000);
	assert.equal(parseDuration("0s"), 0);
	for (const bad of ["", "5", "300", "m", "s", "5h", "1.5m", "-5m", "30s2m", "2m 30s", "5 m", "1e3s", "5min", "0x10s"]) assert.equal(parseDuration(bad), undefined, bad);
});

test("formatDuration reads back what parseDuration took", () => {
	assert.equal(formatDuration(300_000), "5 min");
	assert.equal(formatDuration(90_000), "1 min 30 s");
	assert.equal(formatDuration(10_000), "10 s");
	assert.equal(formatDuration(1_800_000), "30 min");
	assert.equal(formatDuration(0), "0 s");
});

test("saveConfig writes the popup policy, the ask timeout and the subagent thinking mode, and they load back", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		writeFileSync(join(dir, CONFIG_FILE), '{"future": 1}');
		assert.equal(saveConfig(dir, { backgroundAskPopup: "badge", backgroundAskTimeoutMs: 150_000, subagentThinking: "role" }), undefined);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8")), { future: 1, backgroundAskPopup: "badge", backgroundAskTimeoutMs: 150_000, subagentThinking: "role" });
		const loaded = loadConfig(dir);
		assert.equal(loaded.backgroundAskPopup, "badge");
		assert.equal(loaded.backgroundAskTimeoutMs, 150_000);
		assert.equal(loaded.subagentThinking, "role");
		assert.deepEqual(loaded.warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
