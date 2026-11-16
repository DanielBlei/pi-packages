/**
 * Tests for the terminal attention sequence. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionSequence } from "../../extensions/attention.ts";

test("BEL plus OSC 777 by default, with the fixed label", () => {
	assert.equal(attentionSequence("pi: permission needed", {}), "\x07\x1b]777;notify;pi;pi: permission needed\x07");
});

test("kitty gets OSC 99", () => {
	const sequence = attentionSequence("pi: plan ready for approval", { KITTY_WINDOW_ID: "3" });
	assert.ok(sequence.startsWith("\x07\x1b]99;"));
	assert.ok(!sequence.includes("777"));
});

test("PI_KEEPER_BELL=0 disables it; other values do not", () => {
	assert.equal(attentionSequence("pi: permission needed", { PI_KEEPER_BELL: "0" }), "");
	assert.notEqual(attentionSequence("pi: permission needed", { PI_KEEPER_BELL: "1" }), "");
});
