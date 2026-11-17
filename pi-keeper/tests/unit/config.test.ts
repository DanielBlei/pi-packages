/**
 * Tests for the user-level settings file. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, DEFAULT_READ_ONLY_TOOLS, effectiveCommandColors, formatDuration, loadConfig, parseConfig, parseDuration, saveConfig } from "../../extensions/config.ts";

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
		assert.deepEqual(loadConfig(dir), { readOnlyTools: defaults, subagentsFollowAuto: false, projectExactCommands: false, backgroundAutoFallback: false, projectCommandApprovals: true, projectReadApprovals: false, ccExtensionsPrompt: true, modeInstructions: "message", backgroundAsks: true, backgroundAskTimeoutMs: 300000, backgroundAskPopup: "always", subagentThinking: "follow", commandColors: undefined, warnings: [] });
		writeFileSync(join(dir, CONFIG_FILE), '{"readOnlyTools": ["x_tool"]}');
		assert.deepEqual([...loadConfig(dir).readOnlyTools], ["x_tool"]);
		writeFileSync(join(dir, CONFIG_FILE), "{broken");
		assert.equal(loadConfig(dir).warnings.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("subagentsFollowAuto, projectExactCommands and backgroundAutoFallback: absent or a boolean reads as-is, anything else warns and stays off", () => {
	assert.equal(parseConfig("{}").subagentsFollowAuto, false);
	assert.equal(parseConfig('{"subagentsFollowAuto": true}').subagentsFollowAuto, true);
	assert.equal(parseConfig('{"subagentsFollowAuto": false}').subagentsFollowAuto, false);
	assert.equal(parseConfig("{}").projectExactCommands, false);
	assert.equal(parseConfig('{"projectExactCommands": true}').projectExactCommands, true);
	assert.equal(parseConfig("{}").backgroundAutoFallback, false);
	assert.equal(parseConfig('{"backgroundAutoFallback": true}').backgroundAutoFallback, true);
	const bad = parseConfig('{"subagentsFollowAuto": "yes", "projectExactCommands": 7, "backgroundAutoFallback": "on"}');
	assert.equal(bad.subagentsFollowAuto, false);
	assert.equal(bad.projectExactCommands, false);
	assert.equal(bad.backgroundAutoFallback, false);
	assert.deepEqual(bad.warnings, ["subagentsFollowAuto must be true or false; using false", "projectExactCommands must be true or false; using false", "backgroundAutoFallback must be true or false; using false"]);
	// one bad key doesn't hide the other
	const mixed = parseConfig('{"readOnlyTools": ["x_tool"], "subagentsFollowAuto": 7}');
	assert.deepEqual([...mixed.readOnlyTools], ["x_tool"]);
	assert.equal(mixed.subagentsFollowAuto, false);
});

test("ccExtensionsPrompt: absent is true, a boolean reads as-is, anything else warns and is true", () => {
	assert.equal(parseConfig("{}").ccExtensionsPrompt, true);
	assert.equal(parseConfig('{"ccExtensionsPrompt": false}').ccExtensionsPrompt, false);
	assert.equal(parseConfig('{"ccExtensionsPrompt": true}').ccExtensionsPrompt, true);
	const bad = parseConfig('{"ccExtensionsPrompt": "no"}');
	assert.equal(bad.ccExtensionsPrompt, true);
	assert.deepEqual(bad.warnings, ["ccExtensionsPrompt must be true or false; using true"]);
	assert.equal(parseConfig("not json").ccExtensionsPrompt, true, "the unusable-file fallback");
});

test("saveConfig writes ccExtensionsPrompt and it loads back", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		assert.equal(saveConfig(dir, { ccExtensionsPrompt: false }), undefined);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8")), { ccExtensionsPrompt: false });
		assert.equal(loadConfig(dir).ccExtensionsPrompt, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveConfig merges into the file, keeps unknown keys, creates it when absent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		const file = join(dir, CONFIG_FILE);
		// absent: created
		assert.equal(saveConfig(dir, { subagentsFollowAuto: true }), undefined);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).subagentsFollowAuto, true);
		// merges into what is there, keeping unknown keys and other settings
		writeFileSync(file, '{"readOnlyTools": ["x_tool"], "future": {"a": 1}}');
		assert.equal(saveConfig(dir, { subagentsFollowAuto: false, projectExactCommands: true, backgroundAutoFallback: true }), undefined);
		const saved = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(saved, { readOnlyTools: ["x_tool"], future: { a: 1 }, subagentsFollowAuto: false, projectExactCommands: true, backgroundAutoFallback: true });
		assert.ok(statSync(file).isFile());
		// what it wrote loads back
		assert.equal(loadConfig(dir).subagentsFollowAuto, false);
		assert.deepEqual([...loadConfig(dir).readOnlyTools], ["x_tool"]);
		// a broken file is refused, not replaced: the error says so and the file is left as it was
		writeFileSync(file, "{broken");
		assert.match(saveConfig(dir, { subagentsFollowAuto: true }) ?? "", /not valid JSON/);
		assert.equal(readFileSync(file, "utf8"), "{broken");
		// a valid file that is not an object is refused too (a save would discard its content)
		writeFileSync(file, "[1, 2]");
		assert.match(saveConfig(dir, { subagentsFollowAuto: true }) ?? "", /is not a JSON object/);
		assert.equal(readFileSync(file, "utf8"), "[1, 2]");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveConfig warns instead of throwing when the file can't be written", () => {
	// the config path is a directory: neither read nor write can work
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		mkdirSync(join(dir, CONFIG_FILE));
		assert.match(saveConfig(dir, { subagentsFollowAuto: true }) ?? "", /could not (read|write)/);
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

test("commandColors: the five values read as-is; absent is unset (undefined); anything else warns and is unset", () => {
	assert.equal(parseConfig("{}").commandColors, undefined);
	for (const value of ["dim", "muted", "text", "builtin-syntax", "shell-highlight"]) {
		assert.equal(parseConfig(`{"commandColors": "${value}"}`).commandColors, value);
	}
	// the old single "syntax" value is gone: a stale file says so instead of meaning something else
	for (const text of ['{"commandColors": "warning"}', '{"commandColors": "syntax"}', '{"commandColors": 7}', '{"commandColors": null}']) {
		const config = parseConfig(text);
		assert.equal(config.commandColors, undefined, text);
		assert.deepEqual(config.warnings, ['commandColors must be "dim", "muted", "text", "builtin-syntax" or "shell-highlight"; using the default'], text);
	}
});

test("effectiveCommandColors: unset means shell-highlight when the highlighter is loaded, else dim", () => {
	assert.equal(effectiveCommandColors(undefined, true), "shell-highlight");
	assert.equal(effectiveCommandColors(undefined, false), "dim");
});

test("effectiveCommandColors: an explicit value is respected, except shell-highlight without its package, which is dim", () => {
	assert.equal(effectiveCommandColors("dim", true), "dim");
	assert.equal(effectiveCommandColors("muted", false), "muted");
	assert.equal(effectiveCommandColors("shell-highlight", false), "dim");
	assert.equal(effectiveCommandColors("shell-highlight", true), "shell-highlight");
	assert.equal(effectiveCommandColors("builtin-syntax", false), "builtin-syntax");
	assert.equal(effectiveCommandColors("builtin-syntax", true), "builtin-syntax");
});

test("saveConfig keeps a hand-written commandColors when it writes another setting", () => {
	const dir = mkdtempSync(join(tmpdir(), "pdf-config-"));
	try {
		writeFileSync(join(dir, CONFIG_FILE), '{"commandColors": "muted"}');
		assert.equal(saveConfig(dir, { subagentsFollowAuto: true }), undefined);
		const saved = JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"));
		assert.equal(saved.commandColors, "muted");
		assert.equal(saved.subagentsFollowAuto, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("backgroundAskPopup: idle, always or badge reads as-is; absent is always; anything else warns and stays always", () => {
	assert.equal(parseConfig("{}").backgroundAskPopup, "always");
	for (const value of ["idle", "always", "badge"]) assert.equal(parseConfig(`{"backgroundAskPopup": "${value}"}`).backgroundAskPopup, value);
	for (const text of ['{"backgroundAskPopup": "never"}', '{"backgroundAskPopup": true}']) {
		const config = parseConfig(text);
		assert.equal(config.backgroundAskPopup, "always", text);
		assert.deepEqual(config.warnings, ['backgroundAskPopup must be "idle", "always" or "badge"; using "always"'], text);
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
