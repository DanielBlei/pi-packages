/**
 * Tests for the UI relay registry. Run: npm test
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { findUiRelay, registerUiRelay, RELAY_KEY, type UiRelay } from "../../extensions/ui-relay.ts";

/** A minimal well-formed relay. */
function relay(overrides: Partial<UiRelay> = {}): UiRelay {
	return {
		version: 1,
		sessionId: "parent-1",
		select: () => Promise.resolve(undefined),
		input: () => Promise.resolve(undefined),
		notify: () => undefined,
		sessionRules: () => ({ prefixes: [], exact: [], edits: false, outsideReads: false }),
		rememberSession: () => undefined,
		setSessionFlag: () => undefined,
		...overrides,
	};
}

const root: Record<symbol, unknown> = {};

beforeEach(() => {
	delete root[RELAY_KEY];
});
afterEach(() => {
	delete root[RELAY_KEY];
});

test("nothing registered: find returns undefined, never throws", () => {
	assert.equal(findUiRelay({ root }), undefined);
	root[RELAY_KEY] = undefined;
	assert.equal(findUiRelay({ root }), undefined);
});

test("register and find; dispose removes; a second find after dispose fails", () => {
	const first = registerUiRelay(relay(), { root });
	assert.ok(first);
	assert.equal(findUiRelay({ root })?.sessionId, "parent-1");
	first.dispose();
	assert.equal(findUiRelay({ root }), undefined);
});

test("re-registering replaces; the old dispose no longer removes the new relay", () => {
	const first = registerUiRelay(relay(), { root });
	assert.ok(first);
	const second = registerUiRelay(relay({ sessionId: "parent-2" }), { root });
	assert.ok(second);
	assert.equal(findUiRelay({ root })?.sessionId, "parent-2");
	first.dispose();
	assert.equal(findUiRelay({ root })?.sessionId, "parent-2");
	second.dispose();
	assert.equal(findUiRelay({ root }), undefined);
});

test("malformed registry values fail closed", () => {
	for (const value of [null, 42, "relay", {}, { version: 2 }, { version: 1 }, { version: 1, sessionId: 1, select: () => undefined }]) {
		root[RELAY_KEY] = value;
		assert.equal(findUiRelay({ root }), undefined, `value: ${JSON.stringify(String(value))}`);
	}
});

test("a malformed relay is not registered", () => {
	assert.equal(registerUiRelay({ version: 1 } as unknown as UiRelay, { root }), undefined);
	assert.equal(findUiRelay({ root }), undefined);
});

test("grantReadDirs is optional: a relay without it (or with older session rules) is still usable", () => {
	assert.ok(registerUiRelay(relay(), { root }));
	assert.equal(findUiRelay({ root })?.grantReadDirs, undefined);
	assert.equal(findUiRelay({ root })?.sessionRules().outsideReadDirs, undefined);
	// a published grantReadDirs must be a function
	delete root[RELAY_KEY];
	assert.equal(registerUiRelay(relay({ grantReadDirs: "no" as never }), { root }), undefined);
	const granted: string[] = [];
	assert.ok(registerUiRelay(relay({ grantReadDirs: (dirs) => granted.push(...dirs) }), { root }));
	findUiRelay({ root })?.grantReadDirs?.(["/a"]);
	assert.deepEqual(granted, ["/a"]);
});
