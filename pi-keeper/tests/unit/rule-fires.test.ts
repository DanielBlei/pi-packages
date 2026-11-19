/**
 * Tests for the lifetime rule-fire store: counts per scope, projects kept apart,
 * a damaged file reads as empty, permissions, atomic writes.
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuleFires, recordRuleFire, ruleFireCounts, ruleFiresFile } from "../../extensions/rule-fires.ts";

function dirs(): { agent: string; projA: string; projB: string; done: () => void } {
	const base = mkdtempSync(join(tmpdir(), "rule-fires-"));
	const [agent, projA, projB] = ["agent", "a", "b"].map((name) => join(base, name)) as [string, string, string];
	for (const dir of [agent, projA, projB]) mkdirSync(join(dir, ".pi"), { recursive: true });
	return { agent, projA, projB, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("a user rule is counted globally, a project rule per project", () => {
	const { agent, projA, projB, done } = dirs();
	try {
		assert.deepEqual(readRuleFires(agent), { version: 1, user: {}, projects: {} }, "no file reads as empty");
		assert.equal(recordRuleFire(agent, projA, "user", "no-claims"), 1);
		assert.equal(recordRuleFire(agent, projB, "user", "no-claims"), 2, "the user rule counts across projects");
		assert.equal(recordRuleFire(agent, projA, "project", "no-scope"), 1);
		assert.equal(recordRuleFire(agent, projA, "project", "no-scope"), 2);
		assert.equal(recordRuleFire(agent, projB, "project", "no-scope"), 1, "another project starts at zero");
		assert.deepEqual(ruleFireCounts(agent, projA), { user: { "no-claims": 2 }, project: { "no-scope": 2 } });
		assert.deepEqual(ruleFireCounts(agent, projB), { user: { "no-claims": 2 }, project: { "no-scope": 1 } });
		const store = JSON.parse(readFileSync(ruleFiresFile(agent), "utf8")) as { version: number; projects: Record<string, unknown> };
		assert.equal(store.version, 1);
		assert.equal(Object.keys(store.projects).length, 2);
		assert.ok(Object.keys(store.projects).every((key) => /^[0-9a-f]{64}$/.test(key)), "keyed by a sha256, not a path");
	} finally {
		done();
	}
});

test("every increment re-reads the file: a count another session wrote is kept", () => {
	const { agent, projA, done } = dirs();
	try {
		recordRuleFire(agent, projA, "user", "r");
		writeFileSync(ruleFiresFile(agent), JSON.stringify({ version: 1, user: { r: 10 }, projects: {} }));
		assert.equal(recordRuleFire(agent, projA, "user", "r"), 11);
	} finally {
		done();
	}
});

test("a corrupt or wrong-shaped file reads as empty and the next fire rewrites it", () => {
	const { agent, projA, done } = dirs();
	try {
		mkdirSync(join(agent, "pi-keeper"), { recursive: true });
		for (const text of ["{not json", "[]", "null", "42", JSON.stringify({ user: { r: "x", s: -1, t: 1.5 }, projects: { k: [] } })]) {
			writeFileSync(ruleFiresFile(agent), text);
			assert.deepEqual(readRuleFires(agent).user, {}, text);
			assert.doesNotThrow(() => ruleFireCounts(agent, projA));
		}
		writeFileSync(ruleFiresFile(agent), "{not json");
		assert.equal(recordRuleFire(agent, projA, "user", "r"), 1);
		assert.deepEqual(readRuleFires(agent).user, { r: 1 });
	} finally {
		done();
	}
});

test("a write that fails is ignored: no throw, undefined, no temp file left", () => {
	const { agent, projA, done } = dirs();
	try {
		mkdirSync(join(agent, "pi-keeper"), { recursive: true });
		mkdirSync(ruleFiresFile(agent)); // a directory where the file belongs: the rename fails
		assert.equal(recordRuleFire(agent, projA, "user", "r"), undefined);
		assert.deepEqual(readdirSync(join(agent, "pi-keeper")), ["rule-fires.json"], "the temp file is removed");
		writeFileSync(join(agent, "blocker"), "");
		assert.equal(recordRuleFire(join(agent, "blocker"), projA, "user", "r"), undefined, "an unusable agent dir");
	} finally {
		done();
	}
});

test("the directory is 0700, the file 0600, and no temp file stays behind", () => {
	const { agent, projA, done } = dirs();
	try {
		recordRuleFire(agent, projA, "user", "r");
		assert.equal(statSync(join(agent, "pi-keeper")).mode & 0o777, 0o700);
		assert.equal(statSync(ruleFiresFile(agent)).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(join(agent, "pi-keeper")), ["rule-fires.json"], "atomic: written to a temp file and renamed");
	} finally {
		done();
	}
});
