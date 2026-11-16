/**
 * Tests for the child lane line and the parent hint. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { childLaneLine, childLaneName, mutationToolsOf, parentLaneHint } from "../../extensions/child-lane.ts";

/** A typical worker toolset: read/search/shell/writers + the protocol tool. */
const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"];
/** A typical scout toolset: read/search/shell only. */
const SCOUT_TOOLS = ["read", "grep", "find", "ls", "bash", "contact_supervisor"];

test("mutationToolsOf keeps the stable order and drops non-mutation tools", () => {
	assert.deepEqual(mutationToolsOf(["write", "read", "bash", "edit"]), ["edit", "write", "bash"]);
	assert.deepEqual(mutationToolsOf(SCOUT_TOOLS), ["bash"]);
	assert.deepEqual(mutationToolsOf(["read", "grep"]), []);
});

test("lane names couple the lane line to the deny messages", () => {
	assert.equal(childLaneName("plan", true), "read-only plan child");
	assert.equal(childLaneName("plan", false), "read-only plan child");
	assert.equal(childLaneName("default", true), "default child with a relay");
	assert.equal(childLaneName("default", false), "default child with no relay");
	assert.equal(childLaneName("auto", false), "auto child with no relay");
});

test("plan child: writes denied, reads run, relay decides the asks", () => {
	const relayed = childLaneLine({ mode: "plan", relay: true, activeTools: WORKER_TOOLS });
	assert.match(relayed, /Your lane: read-only plan child\./);
	assert.match(relayed, /Reading, searching and read-only bash run freely/);
	assert.match(relayed, /File edits and writes \(edit and write\) are denied everywhere except the scratch dir/);
	assert.match(relayed, /ask, relayed to the parent's user/);
	assert.doesNotMatch(relayed, /do not probe/);

	const relayless = childLaneLine({ mode: "plan", relay: false, activeTools: WORKER_TOOLS });
	assert.match(relayless, /Your lane: read-only plan child\./);
	assert.match(relayless, /denied too \(no interactive user\)/);
	assert.match(relayless, /do not probe another tool or another path/);
	assert.match(relayless, /contact_supervisor \(reason "need_decision"\)/);
});

test("plan child without write tools says so instead of naming absent tools", () => {
	const line = childLaneLine({ mode: "plan", relay: false, activeTools: SCOUT_TOOLS });
	assert.match(line, /You have no file-writing tools\./);
	assert.doesNotMatch(line, /edit/);
});

test("default child with a relay: mutations ask through the relay", () => {
	const line = childLaneLine({ mode: "default", relay: true, activeTools: WORKER_TOOLS });
	assert.match(line, /Your lane: default child with a relay\./);
	assert.match(line, /Mutations, secrets and first reads outside the working directory ask first: the permission dialog is relayed to the parent's user/);
	assert.match(line, /project-allowed commands/);
	assert.doesNotMatch(line, /do not probe/);
});

test("default child with no relay: every mutation denied, no probing, stage and report", () => {
	const line = childLaneLine({ mode: "default", relay: false, activeTools: WORKER_TOOLS });
	assert.match(line, /Your lane: default child with no relay\./);
	assert.match(line, /Every mutation — edit, write and non-read-only bash — is denied, for every path/);
	assert.match(line, /do not probe another tool or another path/);
	assert.match(line, /First reads outside the working directory and secrets are denied too/);
	assert.match(line, /What still runs: reading, searching, read-only bash, project-allowed commands/);
	assert.match(line, /Stage deliverables in the scratch dir/);
	assert.match(line, /contact_supervisor \(reason "need_decision"\)/);
});

test("default relayless child without writers names only the shell gate", () => {
	const line = childLaneLine({ mode: "default", relay: false, activeTools: SCOUT_TOOLS });
	assert.match(line, /Every mutation \(non-read-only bash\) is denied/);
});

test("default relayless child with no mutation tools states what runs", () => {
	const line = childLaneLine({ mode: "default", relay: false, activeTools: ["read", "grep", "contact_supervisor"] });
	assert.doesNotMatch(line, /Every mutation/);
	assert.match(line, /What still runs: reading, searching, read-only commands/);
});

test("auto child: inside cwd runs unasked, the guarded list depends on the relay", () => {
	const relayed = childLaneLine({ mode: "auto", relay: true, activeTools: WORKER_TOOLS });
	assert.match(relayed, /Your lane: auto child with a relay\./);
	assert.match(relayed, /Edits and commands inside the working directory run without asking/);
	assert.match(relayed, /still ask, relayed to the parent's user/);
	assert.doesNotMatch(relayed, /fail-closed/);

	const relayless = childLaneLine({ mode: "auto", relay: false, activeTools: WORKER_TOOLS });
	assert.match(relayless, /Your lane: auto child with no relay\./);
	assert.match(relayless, /are denied instead \(fail-closed\)/);
	assert.match(relayless, /do not probe variants/);
	assert.match(relayless, /contact_supervisor \(reason "need_decision"\)/);
});

test("parent hint: one sentence per mode, reflecting backgroundAuto", () => {
	assert.match(parentLaneHint("plan", true), /stay read-only like you/);
	assert.match(parentLaneHint("default", true), /background \(async\) children run in the auto lane and can write inside this directory/);
	assert.match(parentLaneHint("auto", true), /reviewer = checker/);
	assert.match(parentLaneHint("default", false), /have every mutation denied/);
	assert.match(parentLaneHint("auto", false), /stage work in their scratch dir and report it/);
	// the fan-out form that survives a reply which already made a tool call
	for (const mode of ["plan", "default", "auto"] as const) {
		assert.match(parentLaneHint(mode, true), /options: \{ script: "…" \}/, mode);
		assert.match(parentLaneHint(mode, true), /fenced ```js workflow block is dropped/, mode);
	}
	for (const mode of ["plan", "default", "auto"] as const) {
		for (const backgroundAuto of [true, false]) {
			// one sentence: exactly one terminating period
			assert.equal((parentLaneHint(mode, backgroundAuto).match(/\./g) ?? []).length, 1, `${mode}/${backgroundAuto}`);
		}
	}
});

test("every lane × tool set: the relay decides ask-or-deny wording, never both; no double spaces", () => {
	const toolSets: Record<string, string[]> = {
		"writers + bash": WORKER_TOOLS,
		"edit only": ["read", "edit"],
		"bash only": SCOUT_TOOLS,
		"powershell only": ["read", "powershell"],
		"no mutation tools": ["read", "grep"],
	};
	for (const mode of ["plan", "default", "auto"] as const) {
		for (const relay of [true, false]) {
			for (const [name, activeTools] of Object.entries(toolSets)) {
				const line = childLaneLine({ mode, relay, activeTools });
				const where = `${mode}/${relay ? "relay" : "no relay"}/${name}: ${line}`;
				assert.doesNotMatch(line, /\S {2,}\S/, where);
				if (relay) {
					assert.match(line, /relayed to the parent's user/, where);
					assert.match(line, /If an ask is rejected, do not retry it/, where);
					assert.doesNotMatch(line, /no interactive user|fail-closed/, where);
				} else {
					assert.match(line, /do not retry/, where);
					assert.doesNotMatch(line, /relayed/, where);
				}
			}
		}
	}
});

test("background child with parent asks: relayed wording, decline guidance, never 'denied' or 'no relay'", () => {
	assert.equal(childLaneName("default", false, true), "default background child");
	assert.equal(childLaneName("auto", false, true), "auto background child");
	assert.equal(childLaneName("plan", false, true), "read-only plan child");
	assert.equal(childLaneName("default", true, true), "default child with a relay");
	for (const mode of ["plan", "default", "auto"] as const) {
		const line = childLaneLine({ mode, relay: false, parentAsks: true, activeTools: WORKER_TOOLS });
		assert.match(line, /relayed to the parent's user/, mode);
		assert.match(line, /The user may approve or decline each ask\. If one is declined or goes unanswered, continue without that call: do not retry it or probe variants/, mode);
		assert.doesNotMatch(line, /no relay|fail-closed|no interactive user|Stage deliverables/, mode);
		assert.doesNotMatch(line, /\S {2,}\S/, mode);
	}
	assert.match(childLaneLine({ mode: "default", relay: false, parentAsks: true, activeTools: WORKER_TOOLS }), /Your lane: default background child\./);
	// a foreground relay lane says the same about approving or declining
	assert.match(childLaneLine({ mode: "default", relay: true, activeTools: WORKER_TOOLS }), /The user may approve or decline each ask\. If an ask is rejected, do not retry it or probe variants/);
});

test("parent hint with background asks on: children ask the user, nothing about denial or backgroundAuto", () => {
	for (const backgroundAuto of [true, false]) {
		const hint = parentLaneHint("default", backgroundAuto, true);
		assert.match(hint, /background \(async\) children ask the user through this session like foreground ones/);
		assert.doesNotMatch(hint, /denied|auto lane/);
		assert.equal((hint.match(/\./g) ?? []).length, 1);
	}
	assert.match(parentLaneHint("plan", false, true), /stay read-only like you/);
});
