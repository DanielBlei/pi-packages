/**
 * Tests for the seam to pi-shell-highlight: what it accepts, and what it refuses
 * without throwing. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandHighlighter, HIGHLIGHTER_KEY } from "../../extensions/shell-highlight-bridge.ts";

const registry = globalThis as unknown as Record<symbol, unknown>;

/** Runs `body` with the registry set to `value`, and clears it afterwards. */
function withRegistry<T>(value: unknown, body: () => T): T {
	try {
		registry[HIGHLIGHTER_KEY] = value;
		return body();
	} finally {
		delete registry[HIGHLIGHTER_KEY];
	}
}

test("the key is the one pi-shell-highlight publishes", () => {
	assert.equal(HIGHLIGHTER_KEY, Symbol.for("pi.shell-highlight.v1"));
});

test("nothing registered means no highlighter", () => {
	assert.equal(commandHighlighter(), undefined);
});

test("a registered highlighter is returned as the function itself", () => {
	const highlight = (text: string): string[] => text.split("\n");
	assert.equal(withRegistry({ highlightCommand: highlight }, commandHighlighter), highlight);
});

test("anything of the wrong shape is refused instead of throwing", () => {
	for (const value of [undefined, null, {}, { highlightCommand: 7 }, { highlightCommand: "x" }, "nope", 42, []]) {
		assert.equal(withRegistry(value, commandHighlighter), undefined, String(value));
	}
});
