/**
 * Tests for the permission dialog's option lists. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_LOOP_GLOBS, ALLOW_LOOP_GLOBS_SHARED, ALLOW_PYTHON_WHILE, ALLOW_PYTHON_WHILE_SHARED, dialogOptions, gitGrantLabel, readGrantLabel, type DialogOptionsInput } from "../../extensions/options.ts";

const SESSION = "Yes, and don't ask again for `sed` this session";
const PROJECT = "Yes, and always allow `sed` in this project";
const FEEDBACK = "No, and tell pi what to do instead";
const OTHER = "Allow a different command pattern…";
const AUTO = "Yes, and switch to auto mode";
const OUTSIDE = "Yes, allow reads outside the working directory for this session";
const EDITS = "Yes, allow all edits this session";

const base: DialogOptionsInput = { mode: "default", toolName: "bash", ruleMatch: undefined, hasLadder: false };

test("default bash, rememberable: session, project, then More with the other three", () => {
	const { primary, secondary } = dialogOptions({ ...base, sessionLabel: SESSION, projectLabel: PROJECT, hasLadder: true });
	assert.deepEqual(primary, ["Yes", SESSION, PROJECT, "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, OTHER, AUTO]);
});

test("default bash, not rememberable: no session/project/pattern options", () => {
	const { primary, secondary } = dialogOptions(base);
	assert.deepEqual(primary, ["Yes", "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, AUTO]);
});

test("default edit: allow edits is primary", () => {
	const { primary, secondary } = dialogOptions({ ...base, toolName: "edit" });
	assert.deepEqual(primary, ["Yes", EDITS, "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, AUTO]);
});

test("protected-path ask: one secondary option, appended without More", () => {
	const { primary, secondary } = dialogOptions({ ...base, toolName: "edit", ruleMatch: "protectedPath" });
	assert.deepEqual(primary, ["Yes", "No", FEEDBACK]);
	assert.deepEqual(secondary, [FEEDBACK]);
});

test("outside-read ask: the directory grant is primary, all reads sit behind More", () => {
	const grant = readGrantLabel(["/etc"]);
	assert.equal(grant, "Yes, and allow reading from /etc/ this session");
	const { primary, secondary } = dialogOptions({ ...base, toolName: "bash", ruleMatch: "outsideCwdRead", readGrantLabel: grant });
	assert.deepEqual(primary, ["Yes", grant, "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, OUTSIDE]);
});

test("outside-read ask with no grantable directory: Yes, No, More with the all-reads option", () => {
	const { primary, secondary } = dialogOptions({ ...base, toolName: "read", ruleMatch: "outsideCwdRead" });
	assert.deepEqual(primary, ["Yes", "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, OUTSIDE]);
});

test("readGrantLabel lists and truncates several directories", () => {
	assert.equal(readGrantLabel(["/a", "/b"]), "Yes, and allow reading from /a/, /b/ this session");
	assert.equal(readGrantLabel(["/a", "/b", "/c", "/d"]), "Yes, and allow reading from /a/, /b/ (+2 more) this session");
});

test("plan unapprovedBash: session option, ladder, no project option or auto switch", () => {
	const { primary, secondary } = dialogOptions({ ...base, mode: "plan", ruleMatch: "unapprovedBash", sessionLabel: SESSION, hasLadder: true });
	assert.deepEqual(primary, ["Yes", SESSION, "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, OTHER]);
	// not rememberable: only the feedback option remains
	assert.deepEqual(dialogOptions({ ...base, mode: "plan", ruleMatch: "unapprovedBash" }).primary, ["Yes", "No", FEEDBACK]);
});

test("auto dangerous ask: Yes, No, feedback", () => {
	const { primary, secondary } = dialogOptions({ ...base, mode: "auto", ruleMatch: "dangerousBash" });
	assert.deepEqual(primary, ["Yes", "No", FEEDBACK]);
	assert.deepEqual(secondary, [FEEDBACK]);
});

test("a subagent child never gets the auto-switch option (children can't switch modes)", () => {
	// default-mode fallback ask, like a child's edit
	assert.deepEqual(dialogOptions({ ...base, toolName: "edit", child: true }).primary, ["Yes", EDITS, "No", FEEDBACK]);
	assert.deepEqual(dialogOptions({ ...base, toolName: "edit", child: true }).secondary, [FEEDBACK]);
	// not rememberable bash: no pattern ladder either, and still no auto switch
	assert.deepEqual(dialogOptions({ ...base, child: true }).secondary, [FEEDBACK]);
});

const EXACT = "Yes, and don't ask again for this exact command this session";
const EXACT_SHARED = "Yes, and don't ask again for this exact command this session, for me and my subagents";
const SESSION_CHILD = "Yes, and don't ask again for `sed` this session, for me and my subagents";
const EXACT_PROJECT = "Yes, and always allow this exact command in this project";

test("default bash with no prefix possible offers the exact command after Yes", () => {
	const { primary, secondary } = dialogOptions({ ...base, exactCommand: true });
	assert.deepEqual(primary, ["Yes", EXACT, "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, AUTO]);
});

test("the exact command option is not offered with a session option, or in plan or auto mode", () => {
	assert.ok(!dialogOptions({ ...base, exactCommand: true, sessionLabel: SESSION, projectLabel: PROJECT }).primary.includes(EXACT));
	assert.ok(!dialogOptions({ ...base, mode: "plan", exactCommand: true }).primary.includes(EXACT));
	assert.ok(!dialogOptions({ ...base, mode: "auto", exactCommand: true }).primary.includes(EXACT));
	// a child gets the shared wording instead
	assert.ok(!dialogOptions({ ...base, exactCommand: true, child: true }).primary.includes(EXACT));
	assert.ok(dialogOptions({ ...base, exactCommand: true, child: true }).primary.includes(EXACT_SHARED));
	assert.ok(!dialogOptions(base).primary.includes(EXACT));
});

test("the project-exact-commands setting adds the project option after the session one", () => {
	const { primary, secondary } = dialogOptions({ ...base, exactCommand: true, projectExactCommands: true });
	assert.deepEqual(primary, ["Yes", EXACT, EXACT_PROJECT, "No", "More…"]);
	assert.deepEqual(secondary, [FEEDBACK, AUTO]);
});

test("the project-exact-commands option is offered to a child (it saves to the child's project) next to the shared session option", () => {
	const { primary } = dialogOptions({ ...base, exactCommand: true, projectExactCommands: true, child: true });
	// a child's session grant lands in the parent session, so its label says who it covers
	assert.ok(!primary.includes(EXACT));
	assert.ok(primary.includes(EXACT_SHARED));
	// no switch-to-auto for a child: the secondary list has one option, so it sits in the primary list
	assert.deepEqual(primary, ["Yes", EXACT_SHARED, EXACT_PROJECT, "No", FEEDBACK]);
});

test("a child's session grants are worded for the parent session and its subagents", () => {
	const child = dialogOptions({ ...base, child: true, sessionLabel: SESSION_CHILD, projectLabel: PROJECT }).primary;
	assert.ok(child.includes(SESSION_CHILD));
	assert.ok(!child.includes(SESSION));
	assert.match(SESSION_CHILD, /for me and my subagents$/);
	// the parent's own dialog keeps the plain wording
	assert.ok(dialogOptions({ ...base, sessionLabel: SESSION }).primary.includes(SESSION));
});

test("the project-exact-commands option is not offered with a session option, in plan or auto mode, or when the setting is off", () => {
	assert.ok(!dialogOptions({ ...base, projectExactCommands: true, sessionLabel: SESSION, projectLabel: PROJECT }).primary.includes(EXACT_PROJECT));
	assert.ok(!dialogOptions({ ...base, mode: "plan", projectExactCommands: true }).primary.includes(EXACT_PROJECT));
	assert.ok(!dialogOptions({ ...base, mode: "auto", projectExactCommands: true }).primary.includes(EXACT_PROJECT));
	assert.ok(!dialogOptions({ ...base, exactCommand: true }).primary.includes(EXACT_PROJECT));
	assert.ok(!dialogOptions(base).primary.includes(EXACT_PROJECT));
});

test("the git grant label names the repo roots, sanitized, with a count past two", () => {
	assert.equal(gitGrantLabel(["/x/harbor"]), "Yes, and allow git in /x/harbor/ this session");
	assert.equal(gitGrantLabel(["/x/a", "/x/b"]), "Yes, and allow git in /x/a/, /x/b/ this session");
	assert.equal(gitGrantLabel(["/x/a", "/x/b", "/x/c"]), "Yes, and allow git in /x/a/, /x/b/ (+1 more) this session");
	assert.equal(gitGrantLabel(["/x/a\u001b[31mred"]), "Yes, and allow git in /x/a\u241b[31mred/ this session");
});

test("the git grant is offered after the fetch options, before No, and never replaces the cd options", () => {
	const label = gitGrantLabel(["/x/harbor"]);
	assert.deepEqual(dialogOptions({ ...base, gitGrantLabel: label }).primary, ["Yes", label, "No", "More…"]);
	assert.deepEqual(dialogOptions({ ...base, mode: "plan", gitGrantLabel: label }).primary, ["Yes", label, "No", FEEDBACK]);
});

test("the loop-glob option is offered when asked for, shared for a background ask, and never in auto", () => {
		const base: DialogOptionsInput = { mode: "default", toolName: "bash", ruleMatch: undefined, hasLadder: false, loopGlobsGrant: true };
		assert.ok(dialogOptions(base).primary.includes(ALLOW_LOOP_GLOBS));
		assert.ok(dialogOptions({ ...base, mode: "plan" }).primary.includes(ALLOW_LOOP_GLOBS));
		assert.ok(dialogOptions({ ...base, sharedEdits: true }).primary.includes(ALLOW_LOOP_GLOBS_SHARED));
		assert.ok(!dialogOptions({ ...base, mode: "auto" }).primary.includes(ALLOW_LOOP_GLOBS));
		assert.ok(!dialogOptions({ ...base, loopGlobsGrant: undefined }).primary.includes(ALLOW_LOOP_GLOBS));
});

test("the python-while option is offered when asked for, shared for a background ask, and never in auto", () => {
	const base: DialogOptionsInput = { mode: "default", toolName: "bash", ruleMatch: undefined, hasLadder: false, pythonWhileGrant: true };
	assert.ok(dialogOptions(base).primary.includes(ALLOW_PYTHON_WHILE));
	assert.ok(dialogOptions({ ...base, mode: "plan" }).primary.includes(ALLOW_PYTHON_WHILE));
	assert.ok(dialogOptions({ ...base, sharedEdits: true }).primary.includes(ALLOW_PYTHON_WHILE_SHARED));
	assert.ok(!dialogOptions({ ...base, mode: "auto" }).primary.includes(ALLOW_PYTHON_WHILE));
	assert.ok(!dialogOptions({ ...base, pythonWhileGrant: undefined }).primary.includes(ALLOW_PYTHON_WHILE));
	assert.match(ALLOW_PYTHON_WHILE, /higher risk: a loop may not end or may fill memory/);
});
