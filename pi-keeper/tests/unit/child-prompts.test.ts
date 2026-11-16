/**
 * The prompt/lane split for subagent children. Run: npm test
 *
 * A child's system prompt is its mode prompt (prompts/child-<mode>.md) plus
 * its lane line (extensions/child-lane.ts). The same mode prompt is sent in
 * every lane of that mode — with a relay to the parent's user and without
 * one — so it may only say what holds in all of them: what runs freely and
 * which actions are gated. What happens to a gated action (asked through the
 * parent's user, or denied fail-closed) and the retry guidance depend on the
 * relay, so they belong in the lane line.
 *
 * If this test fails, a mode prompt makes a relay-dependent claim: move the
 * sentence into childLaneLine (per lane), not into the prompt.
 * tests/integration/child-lanes.test.ts checks each lane end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_PROMPTS, type ChildMode } from "../../extensions/modes.ts";
import { childLaneLine } from "../../extensions/child-lane.ts";

/** Wording that is only true in some lanes of a mode. */
const LANE_DEPENDENT = [
	/relay/i,
	/parent's user/i,
	/to the parent/i,
	/\bask(s|ed)? the user/i,
	/approv/i,
	/\bretry/i,
	/\bdenied\b/i,
	/no interactive user/i,
	/fail-closed/i,
];

for (const mode of ["plan", "default", "auto"] as ChildMode[]) {
	test(`child-${mode}.md holds only what is true in every ${mode} lane`, () => {
		const prompt = CHILD_PROMPTS[mode];
		assert.notEqual(prompt, "", `prompts/child-${mode}.md loaded`);
		for (const pattern of LANE_DEPENDENT) {
			const hit = prompt.split("\n").find((line) => pattern.test(line));
			assert.equal(hit, undefined, `child-${mode}.md: lane-dependent wording ${pattern} in "${hit}" belongs in the lane line`);
		}
		// it points at the lane line for the outcome instead
		assert.match(prompt, /lane line/);
	});
}

test("the relayed default lane tells a child to name files directly and to ask for a second tree once", () => {
	const line = childLaneLine({ mode: "default", relay: true, activeTools: ["bash", "read"] });
	assert.match(line, /Name files from the working directory/);
	assert.match(line, /ask once for its directory/);
	// the mode prompt keeps only the fact that another tree is gated
	assert.match(CHILD_PROMPTS.default, /Reading another tree is gated/);
	assert.doesNotMatch(CHILD_PROMPTS.default, /ask once for its directory/);
});
