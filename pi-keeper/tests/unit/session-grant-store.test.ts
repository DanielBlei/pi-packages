import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionGrants } from "../../extensions/session-grant-store.ts";
import { grantsFile, PARENT_SESSION_ENV, publishGrants, readParentGrants } from "../../extensions/session-grants.ts";

describe("SessionGrants", () => {
	it("adds patterns once, by their text, and keeps prefixes and exact apart", () => {
		const g = new SessionGrants();
		g.addPattern(["git", "commit"], false);
		g.addPattern(["git", "commit"], false);
		g.addPattern(["git", "commit"], true);
		assert.deepEqual(g.prefixes, [["git", "commit"]]);
		assert.deepEqual(g.exact, [["git", "commit"]]);
	});

	it("stores a copy of the tokens", () => {
		const g = new SessionGrants();
		const tokens = ["npm", "test"];
		g.addPattern(tokens, false);
		tokens.push("x");
		assert.deepEqual(g.prefixes, [["npm", "test"]]);
	});

	it("dedupes verbatim keys, read dirs and fetch hosts, and removes them", () => {
		const g = new SessionGrants();
		g.addVerbatim("a");
		g.addVerbatim("a");
		g.addReadDir("/data");
		g.addReadDir("/data");
		g.addFetchHost("pypi.org");
		g.addFetchHost("pypi.org");
		assert.deepEqual(g.verbatim, ["a"]);
		assert.deepEqual(g.outsideReadDirs, ["/data"]);
		assert.deepEqual(g.fetchHosts, ["pypi.org"]);
		g.removePattern(["x"], false);
		g.removeVerbatim("a");
		g.removeReadDir("/data");
		g.removeFetchHost("pypi.org");
		assert.deepEqual(g.snapshot(), { prefixes: [], exact: [], verbatim: [], outsideReadsAllowed: false, outsideReadDirs: [], fetchHosts: [], gitRepos: [], loopGlobs: false });
	});

	it("removes one pattern by text", () => {
		const g = new SessionGrants();
		g.addPattern(["a"], false);
		g.addPattern(["b"], false);
		g.removePattern(["a"], false);
		assert.deepEqual(g.prefixes, [["b"]]);
	});

	it("reset() clears everything in place, so a live reader sees it", () => {
		const g = new SessionGrants();
		const live = g.prefixes;
		g.addPattern(["a"], false);
		g.addPattern(["b"], true);
		g.addVerbatim("v");
		g.allowOutsideReads();
		g.addReadDir("/d");
		g.addFetchHost("h.io");
		g.reset();
		assert.equal(g.prefixes, live);
		assert.deepEqual(g.snapshot(), { prefixes: [], exact: [], verbatim: [], outsideReadsAllowed: false, outsideReadDirs: [], fetchHosts: [], gitRepos: [], loopGlobs: false });
	});

	it("dedupes git repos, removes them, and resets them with the rest", () => {
		const g = new SessionGrants();
		const live = g.gitRepos;
		g.addGitRepo("/x/harbor");
		g.addGitRepo("/x/harbor");
		g.addGitRepo("/x/third");
		assert.deepEqual(g.gitRepos, ["/x/harbor", "/x/third"]);
		assert.deepEqual(g.snapshot().gitRepos, ["/x/harbor", "/x/third"]);
		g.removeGitRepo("/x/harbor");
		assert.deepEqual(g.gitRepos, ["/x/third"]);
		g.reset();
		assert.equal(g.gitRepos, live);
		assert.deepEqual(g.gitRepos, []);
	});

	it("snapshot() is detached from the store in both directions", () => {
		const g = new SessionGrants();
		g.addPattern(["a", "b"], false);
		g.addReadDir("/d");
		const snap = g.snapshot();
		assert.ok(Object.isFrozen(snap));
		assert.throws(() => (snap.outsideReadDirs as string[]).push("/x"));
		assert.throws(() => (snap.prefixes[0] as string[]).push("c"));
		g.addPattern(["c"], false);
		g.addReadDir("/e");
		g.allowOutsideReads();
		assert.deepEqual(snap.prefixes, [["a", "b"]]);
		assert.deepEqual(snap.outsideReadDirs, ["/d"]);
		assert.equal(snap.outsideReadsAllowed, false);
		assert.deepEqual(g.prefixes, [["a", "b"], ["c"]]);
	});

	it("removePattern touches only its own list", () => {
		const g = new SessionGrants();
		g.addPattern(["a"], false);
		g.addPattern(["a"], true);
		g.removePattern(["a"], true);
		assert.deepEqual(g.prefixes, [["a"]]);
		assert.deepEqual(g.exact, []);
		g.addPattern(["a"], true);
		g.removePattern(["a"], false);
		assert.deepEqual(g.prefixes, []);
		assert.deepEqual(g.exact, [["a"]]);
	});

	it("outsideReadsAllowed is live on the field and cleared by reset()", () => {
		const g = new SessionGrants();
		g.allowOutsideReads();
		assert.equal(g.outsideReadsAllowed, true);
		g.revokeOutsideReads();
		assert.equal(g.outsideReadsAllowed, false);
		g.allowOutsideReads();
		g.reset();
		assert.equal(g.outsideReadsAllowed, false);
	});
});

describe("the published grants carry git repos to children", () => {
	it("a snapshot with git repos reads back; an old snapshot without the field still reads, with none", () => {
		const dir = mkdtempSync(join(tmpdir(), "grants-"));
		const env = { [PARENT_SESSION_ENV]: "session-1" };
		try {
			publishGrants(dir, "session-1", { prefixes: [], exact: [], edits: false, outsideReads: false, gitRepos: ["/x/harbor"] });
			assert.deepEqual(readParentGrants(dir, env)?.gitRepos, ["/x/harbor"]);
			const file = grantsFile(dir, "session-1");
			const old = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			delete old.gitRepos;
			writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
			const read = readParentGrants(dir, env);
			assert.notEqual(read, undefined);
			assert.deepEqual(read?.gitRepos, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the loop-glob grant", () => {
	it("is off by default, set by allowLoopGlobs, in the snapshot, cleared by reset", () => {
		const g = new SessionGrants();
		assert.equal(g.loopGlobs, false);
		g.allowLoopGlobs();
		assert.equal(g.loopGlobs, true);
		assert.equal(g.snapshot().loopGlobs, true);
		g.reset();
		assert.equal(g.loopGlobs, false);
		assert.equal(g.snapshot().loopGlobs, false);
		g.allowLoopGlobs();
		g.revokeLoopGlobs();
		assert.equal(g.loopGlobs, false);
	});

	it("travels in the published snapshot; an old snapshot without the key reads as false", () => {
		const dir = mkdtempSync(join(tmpdir(), "grants-"));
		const env = { [PARENT_SESSION_ENV]: "session-1" };
		try {
			publishGrants(dir, "session-1", { prefixes: [], exact: [], edits: false, outsideReads: false, loopGlobs: true });
			assert.equal(readParentGrants(dir, env)?.loopGlobs, true);
			const file = grantsFile(dir, "session-1");
			const old = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			delete old.loopGlobs;
			writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
			assert.equal(readParentGrants(dir, env)?.loopGlobs, false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
