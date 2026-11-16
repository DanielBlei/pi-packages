/**
 * Tests for the footer mode chip styling. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { BUILTIN_SEARCH_HINT, MODES, MODE_ANNOUNCEMENTS, PRIVILEGE_REASON, RTK_SEARCH_HINT, rtkOnPath, searchHint, formatModeStatus, type StatusTheme } from "../../extensions/modes.ts";

const theme: StatusTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `<b>${text}</b>`,
};

test("each mode chip is bold in its Claude Code-style color", () => {
	assert.equal(formatModeStatus(theme, "default", false), "<b><mdLink>● default</mdLink></b>");
	assert.equal(formatModeStatus(theme, "auto", false), "<b><warning>⏵⏵ auto</warning></b>");
	assert.equal(formatModeStatus(theme, "plan", false), "<b><success>⏸ plan</success></b>");
});

test("session edits add a dim separator and a bold yellow `edits` flag", () => {
	assert.equal(
		formatModeStatus(theme, "default", true),
		"<b><mdLink>● default</mdLink></b><dim> · </dim><b><warning>edits</warning></b>",
	);
});

// Model-facing text must be short and say what to do next (docs/architecture.md, "Model-facing text").
test("every mode's closing instruction says what to do next and stays short", () => {
	// the mode message ends with it; the rules themselves are in prompts/<mode>-mode.md
	assert.match(MODE_ANNOUNCEMENTS.plan, /exit_plan_mode/);
	assert.match(MODE_ANNOUNCEMENTS.default, /Continue the task/);
	assert.match(MODE_ANNOUNCEMENTS.auto, /Continue the task/);
	for (const text of Object.values(MODE_ANNOUNCEMENTS)) assert.ok(text.length <= 120, `${text.length} chars: ${text}`);
});

test("the mode prompts stay short and name what their mode allows", () => {
	const caps = { default: 12, auto: 18, plan: 45 } as const;
	for (const mode of ["default", "auto", "plan"] as const) {
		const prompt = MODES[mode].prompt;
		const lines = prompt.split("\n").length;
		assert.ok(lines <= caps[mode], `prompts/${mode}-mode.md grew to ${lines} lines (cap ${caps[mode]}): move mode-independent rules into prompts/contract.md`);
	}
	const plan = MODES.plan.prompt;
	for (const part of ["`Plan file` line", "`write` or `edit`", "`exit_plan_mode`"]) assert.ok(plan.includes(part), part);
});

test("the privilege reason says what to do instead", () => {
	assert.match(PRIVILEGE_REASON, /Give the user the exact command/);
});

test("the rtk search hint warns that rtk grep drops indentation, so edits use the read tool", () => {
	assert.match(RTK_SEARCH_HINT, /trims indentation/);
	assert.match(RTK_SEARCH_HINT, /`read` tool/);
});

test("the built-in search hint names no binary and still sends edits to the read tool", () => {
	assert.match(BUILTIN_SEARCH_HINT, /built-in `grep`, `find` and `ls`/);
	assert.match(BUILTIN_SEARCH_HINT, /`read` tool/);
	assert.ok(!BUILTIN_SEARCH_HINT.includes("rtk"), "a user without rtk is not told to run rtk");
});

test("searchHint picks the nudge from the rtk probe, never a mix", () => {
	assert.equal(searchHint(true), RTK_SEARCH_HINT);
	assert.equal(searchHint(false), BUILTIN_SEARCH_HINT);
	assert.notEqual(searchHint(true), searchHint(false));
});

test("rtkOnPath finds an executable on PATH and is fooled by neither a plain file nor RTK_DISABLED", () => {
	const root = mkdtempSync(join(tmpdir(), "keeper-rtk-"));
	try {
		const empty = join(root, "empty");
		mkdirSync(empty);
		const bin = join(root, "bin");
		mkdirSync(bin);
		// a plain, non-executable file called rtk is not an rtk
		writeFileSync(join(bin, "rtk"), "#!/bin/sh\necho 0.23.0\n", { mode: 0o644 });
		assert.equal(rtkOnPath({ PATH: empty }, "linux"), false, "an empty PATH has no rtk");
		assert.equal(rtkOnPath({ PATH: bin }, "linux"), false, "a non-executable rtk does not count");
		chmodSync(join(bin, "rtk"), 0o755);
		assert.equal(rtkOnPath({ PATH: `${empty}${delimiter}${bin}` }, "linux"), true, "an executable rtk on PATH counts");
		assert.equal(rtkOnPath({ PATH: bin, RTK_DISABLED: "1" }, "linux"), false, "RTK_DISABLED=1 (rtk's own kill switch) turns the nudge off");
		assert.equal(rtkOnPath({}, "linux"), false, "no PATH at all has no rtk");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
