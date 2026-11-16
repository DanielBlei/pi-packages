/**
 * The `subagent-thinking` setting: a child's thinking level is its own
 * (`role`) or the higher of its own and the parent session's (`follow`), and
 * the level travels to children through the same relay/snapshot the session
 * grants use.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { THINKING_LEVELS, childThinkingLevel, isSubagentThinkingMode, isThinkingLevel, maxThinking } from "../../extensions/thinking.ts";
import { parseConfig } from "../../extensions/config.ts";

test("levels are the ones pi supports, in order", () => {
	assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
	for (const value of [undefined, null, "", "MEDIUM", "maximum", 3, false]) assert.equal(isThinkingLevel(value), false);
	assert.equal(isSubagentThinkingMode("follow"), true);
	assert.equal(isSubagentThinkingMode("role"), true);
	assert.equal(isSubagentThinkingMode("inherit"), false);
});

test("maxThinking takes the higher level and tolerates a missing side", () => {
	assert.equal(maxThinking("medium", "high"), "high");
	assert.equal(maxThinking("high", "medium"), "high");
	assert.equal(maxThinking("low", "off"), "low");
	assert.equal(maxThinking("xhigh", "max"), "max");
	assert.equal(maxThinking(undefined, "high"), "high");
	assert.equal(maxThinking("low", undefined), "low");
	assert.equal(maxThinking(undefined, undefined), undefined);
});

test("follow raises an unset child to the parent, and never lowers a role's level", () => {
	// unset child: the parent's level
	assert.equal(childThinkingLevel(undefined, "high", "follow"), "high");
	// the role floor survives a parent that lowers its level
	assert.equal(childThinkingLevel("medium", "low", "follow"), "medium");
	// a parent that raises its level lifts the role
	assert.equal(childThinkingLevel("medium", "high", "follow"), "high");
	// a per-run higher level survives a lower parent
	assert.equal(childThinkingLevel("high", "medium", "follow"), "high");
	// no parent level: nothing to follow
	assert.equal(childThinkingLevel("medium", undefined, "follow"), "medium");
});

test("role mode leaves every child exactly as its agent file asked", () => {
	assert.equal(childThinkingLevel("medium", "high", "role"), undefined);
	assert.equal(childThinkingLevel(undefined, "high", "role"), undefined);
});

test("the setting parses, defaults to follow, and rejects a wrong value with a warning", () => {
	assert.equal(parseConfig("{}").subagentThinking, "follow");
	assert.equal(parseConfig(`{"subagentThinking":"role"}`).subagentThinking, "role");
	const bad = parseConfig(`{"subagentThinking":"inherit"}`);
	assert.equal(bad.subagentThinking, "follow");
	assert.match(bad.warnings.join("\n"), /subagentThinking must be "follow" or "role"/);
});
