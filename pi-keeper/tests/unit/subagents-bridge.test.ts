/**
 * Tests for the pi-subagents registry bridge. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRIDGE_ID, REGISTRY_KEY, childModeFor, registerChildMode } from "../../extensions/subagents-bridge.ts";

const entryFile = (mode: string): string => realpathSync(fileURLToPath(new URL(`../../extensions/child-${mode}.ts`, import.meta.url)));

/** A stand-in for globalThis, so no test touches the real registry. */
const makeRoot = (): Record<symbol, unknown> => ({});

type Store = { version: number; bySession: Map<string, readonly Record<string, unknown>[]> };

test("children follow the parent: plan -> plan, default -> default, auto -> default (auto only with the setting)", () => {
	assert.equal(childModeFor("plan"), "plan");
	assert.equal(childModeFor("default"), "default");
	assert.equal(childModeFor("auto"), "default");
	assert.equal(childModeFor("auto", true), "auto");
	assert.equal(childModeFor("auto", false), "default");
	// the setting never lifts the other modes
	assert.equal(childModeFor("plan", true), "plan");
	assert.equal(childModeFor("default", true), "default");
});

test("registering child-auto points at child-auto.ts", () => {
	const root = makeRoot();
	assert.ok(registerChildMode("s1", "auto", { root }));
	const snapshot = (root[REGISTRY_KEY] as Store).bySession.get("s1");
	assert.equal(snapshot?.[0].path, entryFile("auto"));
});

test("registering creates the registry with one frozen entry holding the realpath of the child file", () => {
	const root = makeRoot();
	const registration = registerChildMode("s1", "plan", { root });
	assert.ok(registration);
	const store = root[REGISTRY_KEY] as Store;
	assert.equal(store.version, 1);
	assert.ok(store.bySession instanceof Map);
	const snapshot = store.bySession.get("s1");
	assert.deepEqual(snapshot, [{ id: BRIDGE_ID, path: entryFile("plan"), requireForAllRunners: true }]);
	assert.ok(Object.isFrozen(snapshot));
	assert.ok(Object.isFrozen(snapshot?.[0]));
	assert.match(BRIDGE_ID, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
	assert.equal(registration.childMode, "plan");
	assert.equal(registration.isCurrent(), true);
});

test("a default registration points at child-default.ts", () => {
	const root = makeRoot();
	registerChildMode("s1", "default", { root });
	const snapshot = (root[REGISTRY_KEY] as Store).bySession.get("s1");
	assert.equal(snapshot?.[0].path, entryFile("default"));
});

test("an existing valid registry is reused and other sessions are left alone", () => {
	const root = makeRoot();
	const other = Object.freeze([Object.freeze({ id: "other", path: "/x.ts" })]);
	const store: Store = { version: 1, bySession: new Map([["other-session", other]]) };
	root[REGISTRY_KEY] = store;
	assert.ok(registerChildMode("s1", "default", { root }));
	assert.equal(root[REGISTRY_KEY], store);
	assert.equal(store.bySession.get("other-session"), other);
	assert.equal(store.bySession.size, 2);
});

test("a malformed or different-version registry fails closed without throwing or being touched", () => {
	for (const bad of [null, "x", 42, {}, { version: 2, bySession: new Map() }, { version: 1 }, { version: 1, bySession: {} }]) {
		const root = makeRoot();
		root[REGISTRY_KEY] = bad;
		assert.equal(registerChildMode("s1", "plan", { root }), undefined, JSON.stringify(bad));
		assert.equal(root[REGISTRY_KEY], bad);
	}
});

test("a session that already has a registration is not clobbered", () => {
	const root = makeRoot();
	const theirs = Object.freeze([Object.freeze({ id: "theirs", path: "/x.ts" })]);
	root[REGISTRY_KEY] = { version: 1, bySession: new Map([["s1", theirs]]) };
	assert.equal(registerChildMode("s1", "plan", { root }), undefined);
	assert.equal((root[REGISTRY_KEY] as Store).bySession.get("s1"), theirs);
});

test("invalid session ids fail closed", () => {
	for (const id of ["", " s1", "s1 ", "a\0b", "x".repeat(257)]) {
		assert.equal(registerChildMode(id, "plan", { root: makeRoot() }), undefined, JSON.stringify(id));
	}
});

test("dispose removes the entry, but not a newer registration of the same session", () => {
	const root = makeRoot();
	const first = registerChildMode("s1", "plan", { root });
	assert.ok(first);
	const store = root[REGISTRY_KEY] as Store;
	first.dispose();
	assert.equal(store.bySession.has("s1"), false);
	assert.equal(first.isCurrent(), false);

	const second = registerChildMode("s1", "default", { root });
	assert.ok(second);
	first.dispose(); // stale: must not remove the newer one
	assert.equal(second.isCurrent(), true);
	assert.equal(store.bySession.get("s1")?.[0].path, entryFile("default"));
	second.dispose();
	assert.equal(store.bySession.size, 0);
});

test("a second register without dispose is refused; dispose then register switches the mode", () => {
	const root = makeRoot();
	const first = registerChildMode("s1", "plan", { root });
	assert.ok(first);
	assert.equal(registerChildMode("s1", "default", { root }), undefined);
	assert.equal(first.isCurrent(), true);
	first.dispose();
	assert.ok(registerChildMode("s1", "default", { root }));
});

test("isCurrent turns false when someone replaces the entry", () => {
	const root = makeRoot();
	const registration = registerChildMode("s1", "plan", { root });
	assert.ok(registration);
	(root[REGISTRY_KEY] as Store).bySession.set("s1", Object.freeze([]));
	assert.equal(registration.isCurrent(), false);
});
