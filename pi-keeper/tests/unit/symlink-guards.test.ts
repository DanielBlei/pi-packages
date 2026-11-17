/**
 * The path guards judge a symbolic link by where it points too, not only by
 * its own name. Uses real links in a temp dir (never the real home).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_RULES, MODES, type ModeName } from "../../extensions/modes.ts";
import { evaluate, type Action } from "../../extensions/rules.ts";
import { isOutsideCwd, isProtectedPath, isSecretFile } from "../../extensions/utils.ts";

/** A project, a second directory outside it, and the agent dir; removed by `done`. */
function layout(): { project: string; other: string; agent: string; done: () => void } {
	const base = mkdtempSync(join(tmpdir(), "pk-links-"));
	const project = join(base, "project");
	const other = join(base, "other");
	const agent = join(base, "agent");
	mkdirSync(join(project, ".git", "hooks"), { recursive: true });
	mkdirSync(other);
	mkdirSync(agent);
	writeFileSync(join(agent, "auth.json"), "{}");
	writeFileSync(join(other, ".env"), "TOKEN=x");
	writeFileSync(join(other, "file.txt"), "hi");
	writeFileSync(join(project, "real.txt"), "hi");
	writeFileSync(join(project, ".git", "hooks", "pre-commit"), "#!/bin/sh");
	return { project, other, agent, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("isSecretFile follows a symlink to a secret, and a link to a plain file stays allowed", () => {
	const t = layout();
	try {
		symlinkSync(join(t.agent, "auth.json"), join(t.project, "creds"));
		symlinkSync(join(t.project, "real.txt"), join(t.project, "alias"));
		assert.equal(isSecretFile("creds", { cwd: t.project, agentDir: t.agent }), true);
		assert.equal(isSecretFile("alias", { cwd: t.project, agentDir: t.agent }), false);
	} finally {
		t.done();
	}
});

test("isSecretFile follows a symlink to a .env file", () => {
	const t = layout();
	try {
		symlinkSync(join(t.other, ".env"), join(t.project, "notes"));
		assert.equal(isSecretFile("notes", { cwd: t.project, agentDir: t.agent }), true);
	} finally {
		t.done();
	}
});

test("isOutsideCwd is true for a link that points out of the project, false for one inside", () => {
	const t = layout();
	try {
		symlinkSync(join(t.other, "file.txt"), join(t.project, "out"));
		symlinkSync(join(t.project, "real.txt"), join(t.project, "inside"));
		assert.equal(isOutsideCwd("out", { cwd: t.project }), true);
		assert.equal(isOutsideCwd("inside", { cwd: t.project }), false);
	} finally {
		t.done();
	}
});

test("isOutsideCwd does not flag the cwd when it is reached through a symlinked directory", () => {
	const t = layout();
	try {
		// the project is reached as <base>/link; its real location is still the project
		const link = join(t.project, "..", "link");
		symlinkSync(t.project, link);
		assert.equal(isOutsideCwd("real.txt", { cwd: link }), false);
		assert.equal(isOutsideCwd("real.txt", { cwd: t.project }), false);
	} finally {
		t.done();
	}
});

test("isProtectedPath follows a link into .git, and a link to a plain file stays unprotected", () => {
	const t = layout();
	try {
		symlinkSync(join(t.project, ".git", "hooks", "pre-commit"), join(t.project, "hook"));
		symlinkSync(join(t.project, "real.txt"), join(t.project, "alias"));
		assert.equal(isProtectedPath("hook", { cwd: t.project }), true);
		assert.equal(isProtectedPath("alias", { cwd: t.project }), false);
	} finally {
		t.done();
	}
});

test("a dangling link is judged by where it points, and a missing path does not throw", () => {
	const t = layout();
	try {
		// a link to a secret location that does not exist yet: a write through it would create the secret
		symlinkSync(join(t.agent, "auth.json"), join(t.project, "dangle-secret"));
		symlinkSync(join(t.project, "nowhere"), join(t.project, "dangle"));
		assert.equal(isSecretFile("dangle-secret", { cwd: t.project, agentDir: t.agent }), true);
		assert.equal(isSecretFile("dangle", { cwd: t.project, agentDir: t.agent }), false);
		assert.equal(isOutsideCwd("dangle", { cwd: t.project }), false);
		assert.equal(isProtectedPath("dangle", { cwd: t.project }), false);
		assert.equal(isSecretFile("missing/deep/file.txt", { cwd: t.project, agentDir: t.agent }), false);
		assert.equal(isOutsideCwd("missing/deep/file.txt", { cwd: t.project }), false);
	} finally {
		t.done();
	}
});

const decideIn = (project: string, agent: string, mode: ModeName, toolName: string, input: unknown): Action =>
	evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName, input }, { cwd: project, agentDir: agent, remembered: [] }).action;

test("evaluate: a read tool on a link to a secret asks in default, auto and plan", () => {
	const t = layout();
	try {
		symlinkSync(join(t.agent, "auth.json"), join(t.project, "creds"));
		for (const mode of ["default", "auto", "plan"] as const) {
			assert.equal(decideIn(t.project, t.agent, mode, "read", { path: "creds" }), "ask", mode);
		}
	} finally {
		t.done();
	}
});

test("evaluate: bash cat on a link to a secret asks, and cat on a plain link is unchanged", () => {
	const t = layout();
	try {
		symlinkSync(join(t.agent, "auth.json"), join(t.project, "creds"));
		symlinkSync(join(t.project, "real.txt"), join(t.project, "alias"));
		for (const mode of ["default", "auto", "plan"] as const) {
			assert.equal(decideIn(t.project, t.agent, mode, "bash", { command: "cat creds" }), "ask", mode);
		}
		assert.equal(decideIn(t.project, t.agent, "default", "bash", { command: "cat alias" }), "allow");
	} finally {
		t.done();
	}
});
