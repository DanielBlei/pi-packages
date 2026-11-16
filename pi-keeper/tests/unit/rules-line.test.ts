/**
 * The rules line names the user's rules a mode honours, and only those (see
 * extensions/rules-line.ts). Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES_LINE_CAP, rulesLine } from "../../extensions/rules-line.ts";
import { NO_PROJECT_RULES, type ProjectPermissions } from "../../extensions/project-rules.ts";
import type { UiRelaySessionRules } from "../../extensions/ui-relay.ts";

const project: ProjectPermissions = {
	allow: { prefixes: [["npm", "test"]], exact: [["make", "check"]] },
	ask: [{ text: "Bash(git push:*)", tokens: ["git", "push"], exact: false }],
	deny: [{ text: "Bash(rm:*)", tokens: ["rm"], exact: false }],
	readDirs: ["/srv/data"],
	fetchHosts: ["docs.example.com"],
};
const session: UiRelaySessionRules = { prefixes: [["cargo", "build"]], exact: [], edits: true, outsideReads: false, outsideReadDirs: ["/opt/ref"] };

test("no rules, no line", () => {
	for (const mode of ["default", "plan", "auto"] as const) {
		assert.equal(rulesLine({ mode, project: NO_PROJECT_RULES, session: undefined }), "");
	}
});

test("default mode: every kind of rule is named", () => {
	const line = rulesLine({ mode: "default", project, session });
	for (const part of ["deny: `rm …`", "ask before: `git push …`", "`npm test …`", "`make check`", "`cargo build …`", "/srv/data/", "/opt/ref/", "All file edits"]) {
		assert.ok(line.includes(part), `missing ${part}: ${line}`);
	}
});

test("plan mode: project allow rules and session edits are not promised (plan ignores them)", () => {
	const line = rulesLine({ mode: "plan", project, session });
	assert.doesNotMatch(line, /npm test|make check|All file edits/);
	// session prefixes, reads and ask/deny still apply in plan mode
	for (const part of ["`cargo build …`", "/srv/data/", "`git push …`", "`rm …`"]) assert.ok(line.includes(part), `missing ${part}: ${line}`);
});

test("auto mode: no allow list (everything else already runs), ask/deny and reads named", () => {
	const line = rulesLine({ mode: "auto", project, session });
	assert.doesNotMatch(line, /without asking|All file edits|docs\.example\.com/);
	for (const part of ["`git push …`", "`rm …`", "/srv/data/"]) assert.ok(line.includes(part), `missing ${part}: ${line}`);
});

test(`at most ${RULES_LINE_CAP} entries, the rest counted`, () => {
	const many = Array.from({ length: 30 }, (_, i) => ["tool", `t${i}`]);
	const line = rulesLine({ mode: "default", project: { ...NO_PROJECT_RULES, allow: { prefixes: many, exact: [] } }, session: undefined });
	assert.equal((line.match(/`tool /g) ?? []).length, RULES_LINE_CAP);
	assert.match(line, /\+10 more/);
});

test("default and plan name the fetch hosts", () => {
	for (const mode of ["default", "plan"] as const) {
		const line = rulesLine({ mode, project, session: { ...session, fetchHosts: ["pypi.org"] } });
		assert.match(line, /Hosts curl\/wget GETs reach without asking: docs\.example\.com, pypi\.org\./, line);
	}
});
