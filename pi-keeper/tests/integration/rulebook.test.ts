/**
 * The rulebook story: a rule file fires once per session, the model gets one
 * hidden correction, a card appears, the prompt stays byte-identical, and
 * `/rules` tells the user what happened. Plus the trust gate for project rule
 * files and the "an uncompilable pattern is skipped, the session starts" case.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantMessage, KEY, makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { RULE_FIRED_ENTRY, RULE_MESSAGE } from "../../extensions/rulebook.ts";

after(() => restoreBell());

const TMPDIR = process.env.TMPDIR;
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(): Sandbox {
	if (TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = TMPDIR;
	const sandbox = makeSandbox();
	created.push(sandbox);
	return sandbox;
}

const root = globalThis as unknown as Record<symbol, unknown>;
let savedRelay: unknown;
const started: Harness[] = [];
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(async () => {
	for (const harness of started.splice(0)) await harness.shutdown();
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
});

async function start(sandbox: Sandbox): Promise<Harness> {
	const h = await startPi({ sandbox });
	started.push(h);
	return h;
}

/** Write a rule file; `dir` is the user's rulebook unless given. */
function writeRule(sandbox: Sandbox, name: string, fields: string, body: string, dir = join(sandbox.agentDir, "pi-keeper", "rules")): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, `---\n${fields}\n---\n${body}\n`);
	return file;
}

const NO_CLAIMS = ["description: Do not claim tests pass when they did not run.", "condition: (?i)\\ball tests pass\\b", "Run the tests with `npm test`, then quote the line that shows the result."] as const;
const BREAKS = assistantMessage("All tests pass. Everything is done.");

describe("a rule fires once, as a warning", () => {
	it("one hidden correction, one card, one record, the prompt unchanged, `/rules` shows the fire", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		const { systemPrompt } = await h.prompt("do the task");
		const modesBefore = h.modeBlocks().length;

		const first = await h.turnEnd(BREAKS);
		assert.equal(first.continue, true, "a fire with no tool results asks for one continuation");
		assert.deepEqual(h.delivered(RULE_MESSAGE).length, 1, "exactly one hidden correction");
		assert.match(h.delivered(RULE_MESSAGE)[0], /Rule: no-claims/);
		assert.match(h.delivered(RULE_MESSAGE)[0], /Run the tests with `npm test`/);

		const records = h.entries.filter((e) => e.type === "custom" && e.customType === RULE_FIRED_ENTRY);
		assert.equal(records.length, 1, "one fired record, which is also the card");
		assert.deepEqual((records[0] as unknown as { data: unknown }).data, { rule: "no-claims", kind: "user", description: NO_CLAIMS[0].replace("description: ", ""), at: (records[0] as unknown as { data: { at: string } }).data.at });
		assert.equal(h.entries.some((e) => e.type === "custom_message" && e.customType === RULE_MESSAGE && (e as unknown as { display: boolean }).display === false), true, "the correction is hidden from the transcript");

		// pi's prompt is untouched: same bytes, and no mode message re-sent because of the fire
		const afterFire = await h.prompt("keep going");
		assert.equal(afterFire.systemPrompt, systemPrompt, "the system prompt is byte-identical after a fire");
		assert.equal(h.modeBlocks().length, modesBefore, "a fire sends no mode message");

		const second = await h.turnEnd(BREAKS);
		assert.equal(second.continue, false, "an already-fired rule asks for nothing");
		assert.equal(h.delivered(RULE_MESSAGE).length, 1, "still one correction: a rule fires once per session");

		h.answer(/Rulebook rules/, "esc");
		await h.command("rules");
		const listing = h.dialogs.at(-1)?.title ?? "";
		assert.match(listing, /no-claims/);
		assert.match(listing, /1 fire/);
		assert.match(listing, /\/permissions/, "the view points at /permissions for permission rules");
	});

	it("a resume keeps the fire: the session entries, not memory, decide", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		await h.turnEnd(BREAKS);
		await h.session("resume");
		const again = await h.turnEnd(BREAKS);
		assert.equal(again.continue, false);
		assert.equal(h.delivered(RULE_MESSAGE).length, 1);
	});

	it("a fork keeps the fire: a forked session started from the same entries does not fire it again", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		await h.turnEnd(BREAKS);
		// a fork carries the branch's entries (the fired record and the correction) into the new session
		const forked = await startPi({ sandbox: sb, entries: [...h.entries] });
		started.push(forked);
		await forked.session("fork");
		const again = await forked.turnEnd(BREAKS);
		assert.equal(again.continue, false, "an already-fired rule asks for nothing in the fork");
		assert.equal(forked.delivered(RULE_MESSAGE).length, 1, "only the correction the parent sent is in the branch");
	});

	it("only the text blocks are matched: a match in a thinking block or in a tool call's arguments does not fire, the same text in a text block does", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		const inThinking = { role: "assistant", content: [{ type: "thinking", thinking: "All tests pass." }, { type: "text", text: "Looking into it." }], stopReason: "stop", timestamp: Date.now() };
		const inToolArgs = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo 'All tests pass.'" } }, { type: "text", text: "Checking." }], stopReason: "stop", timestamp: Date.now() };
		assert.equal((await h.turnEnd(inThinking)).continue, false, "a match only in thinking does not fire");
		assert.equal((await h.turnEnd(inToolArgs)).continue, false, "a match only in tool arguments does not fire");
		assert.deepEqual(h.delivered(RULE_MESSAGE), [], "no correction for either");
		assert.equal((await h.turnEnd(assistantMessage("All tests pass."))).continue, true, "the same text in a text block fires");
		assert.equal(h.delivered(RULE_MESSAGE).length, 1);
	});

	it("an aborted or empty turn fires nothing", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		assert.equal((await h.turnEnd(BREAKS, { outcome: "aborted" })).continue, false);
		assert.equal((await h.turnEnd(assistantMessage("  "))).continue, false);
		assert.deepEqual(h.delivered(RULE_MESSAGE), []);
	});

	it("the card renders the rule name and, expanded, where the correction went", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		await h.turnEnd(BREAKS);
		const data = (h.entries.find((e) => e.type === "custom" && e.customType === RULE_FIRED_ENTRY) as unknown as { data: unknown }).data;
		const line = h.renderEntry(RULE_FIRED_ENTRY, data).join("\n");
		assert.match(line, /rule fired: no-claims/);
		assert.match(line, /Do not claim tests pass/);
		const expanded = h.renderEntry(RULE_FIRED_ENTRY, data, { expanded: true }).join("\n");
		assert.match(expanded, /hidden message/);
	});

});

describe("a project rule needs one review", () => {
	it("ignored: it never fires; loaded: it fires and the trust is recorded", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2], join(sb.cwd, ".pi", "rules"));

		const ignored = await start(sb);
		ignored.answer(/Load .*rulebook rule/, "Ignore for this session");
		await ignored.session();
		await ignored.prompt("go");
		await ignored.turnEnd(BREAKS);
		assert.deepEqual(ignored.delivered(RULE_MESSAGE), [], "an unreviewed project rule is not loaded");

		const loaded = await start(sb);
		loaded.answer(/Load .*rulebook rule/, "Load them");
		await loaded.session();
		await loaded.prompt("go");
		await loaded.turnEnd(BREAKS);
		assert.equal(loaded.delivered(RULE_MESSAGE).length, 1);
		assert.match(loaded.delivered(RULE_MESSAGE)[0], /Rule: no-claims/);
	});

	it("a malformed trust store does not stop a loaded project rule from firing this session", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2], join(sb.cwd, ".pi", "rules"));
		mkdirSync(join(sb.agentDir, "pi-keeper"), { recursive: true });
		writeFileSync(join(sb.agentDir, "pi-keeper", "trusted-rules.json"), "{ nope");
		const h = await start(sb);
		h.answer(/Load .*rulebook rule/, "Load them");
		await h.session();
		await h.prompt("go");
		await h.turnEnd(BREAKS);
		assert.equal(h.delivered(RULE_MESSAGE).length, 1, "the approved rule fires in this session");
		assert.ok(h.notifications.some((n) => n.type === "warning" && /trusted-rules\.json is not valid JSON/.test(n.message)), JSON.stringify(h.notifications));
	});

	it("a user rule and a project rule of the same name: the user's fires, once", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, "Mine.");
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, "Theirs.", join(sb.cwd, ".pi", "rules"));
		const h = await start(sb);
		h.answer(/Load .*rulebook rule/, "Load them");
		await h.session();
		await h.prompt("go");
		await h.turnEnd(BREAKS);
		assert.equal(h.delivered(RULE_MESSAGE).length, 1);
		assert.match(h.delivered(RULE_MESSAGE)[0], /Mine\./);
		assert.doesNotMatch(h.delivered(RULE_MESSAGE)[0], /Theirs\./);
	});
});

describe("a broken rule file", () => {
	it("is skipped with one warning and the session still starts and works", async () => {
		const sb = sandboxed();
		writeRule(sb, "broken.md", "description: Broken.\ncondition: (?i)[", "body");
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		const warnings = h.notifications.filter((n) => n.type === "warning").map((n) => n.message);
		assert.equal(warnings.length, 1, JSON.stringify(warnings));
		assert.match(warnings[0], /broken\.md: the condition does not compile/);
		await h.turnEnd(BREAKS);
		assert.equal(h.delivered(RULE_MESSAGE).length, 1, "the good rule still works");

		h.answer(/Rulebook rules/, "esc");
		await h.command("rules");
		assert.match(h.dialogs.at(-1)?.title ?? "", /broken\.md · skipped/);
	});

	it("warns once per file change, not once per prompt", async () => {
		const sb = sandboxed();
		writeRule(sb, "broken.md", "description: Broken.\ncondition: (unclosed", "body");
		const h = await start(sb);
		await h.session();
		await h.prompt("one");
		await h.prompt("two");
		assert.equal(h.notifications.filter((n) => n.type === "warning").length, 1);
	});
});

describe("a fired rule never blocks anything", () => {
	it("a tool call after a fire runs exactly as it would without the rule", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		await h.turnEnd(BREAKS);
		assert.equal((await h.tool("lsp_diagnostics", { path: "x.ts" })).blocked, false);
		// and the run that fired one correction is still free to write the plan file in plan mode
		await h.command("mode", "plan");
		await h.prompt("plan it");
		const plan = h.modeBlocks().at(-1) ?? "";
		const file = /Plan file: (.+)/.exec(plan)?.[1]?.trim() ?? "";
		assert.ok(file !== "", "plan mode names its file");
		assert.equal((await h.tool("write", { path: file, content: "# Plan\n" })).blocked, false);
	});
});

describe("/rules renders the rulebook", () => {
	it("in a TUI it opens the coloured panel: name, source, fires and description", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		await h.turnEnd(BREAKS);
		h.answer(/Rulebook rules/, "esc");
		await h.command("rules");
		const panel = h.dialogs.at(-1);
		assert.equal(panel?.kind, "custom", "a panel, not a muted notification");
		assert.match(panel?.title ?? "", /Rulebook rules/);
		assert.match(panel?.title ?? "", /no-claims/);
		assert.match(panel?.title ?? "", /user/);
		assert.match(panel?.title ?? "", /1 fire/);
		assert.match(panel?.title ?? "", /Do not claim tests pass/);
		assert.match(panel?.title ?? "", /Enter shows the rule/, "the footer says how to get more");
		assert.deepEqual(h.notifications.filter((n) => /Rulebook rules/.test(n.message)), [], "no plain-text listing when a panel opened");
	});

	it("session start alone creates the folder and the example, so an updated install is retrofitted", async () => {
		const sb = sandboxed();
		const h = await start(sb);
		await h.session();
		assert.equal(existsSync(join(sb.agentDir, "pi-keeper", "rules", "example-rule.md")), true);
	});

	it("on a fresh install /rules creates the folder, seeds the dummy example and lists it", async () => {
		const sb = sandboxed();
		const dir = join(sb.agentDir, "pi-keeper", "rules");
		assert.equal(existsSync(dir), false);
		const h = await start(sb);
		await h.session();
		h.answer(/Rulebook rules/, "esc");
		await h.command("rules");
		assert.equal(existsSync(join(dir, "example-rule.md")), true, "the example is written");
		const panel = h.dialogs.at(-1);
		assert.equal(panel?.kind, "custom", "something is shown, not nothing");
		assert.match(panel?.title ?? "", /example-rule/);
		assert.match(panel?.title ?? "", /not fired/);
	});

	it("Enter opens one rule in the panel (condition, file, body), Esc backs out and closes", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		const h = await start(sb);
		await h.session();
		await h.prompt("go");
		h.answer(/Rulebook rules/, { keys: [KEY.enter, KEY.escape, KEY.escape] });
		await h.command("rules");
		assert.equal(h.dialogs.at(-1)?.kind, "custom");
	});

	it("without a TUI, /rules <name> prints that one rule; an unknown name says so", async () => {
			const sb = sandboxed();
			writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
			writeRule(sb, "other.md", "description: Another rule.\ncondition: (?i)\\bother thing\\b", "Other body.");
			const h = await startPi({ sandbox: sb, ui: "none" });
			started.push(h);
			await h.session();
			await h.command("rules", "no-claims");
			const shown = h.notifications.at(-1);
			assert.equal(shown?.type, "info");
			assert.match(shown?.message ?? "", /no-claims \(user\) — not fired/);
			assert.match(shown?.message ?? "", /Do not claim tests pass when they did not run\./);
			assert.match(shown?.message ?? "", /condition: \(\?i\)\\ball tests pass\\b/);
			assert.match(shown?.message ?? "", /Run the tests with `npm test`, then quote the line that shows the result\./);
			assert.doesNotMatch(shown?.message ?? "", /Other body\./, "only the named rule is printed");

			await h.command("rules", "nope");
			const missing = h.notifications.at(-1);
			assert.equal(missing?.type, "error");
			assert.match(missing?.message ?? "", /No rulebook rule is named nope\. Known: no-claims, other/);
		});

		it("without a TUI it notifies the plain listing, including the files it skipped", async () => {
		const sb = sandboxed();
		writeRule(sb, "no-claims.md", `${NO_CLAIMS[0]}\n${NO_CLAIMS[1]}`, NO_CLAIMS[2]);
		writeRule(sb, "broken.md", "description: Broken.\ncondition: (?i)[", "body");
		const h = await startPi({ sandbox: sb, ui: "none" });
		started.push(h);
		await h.session();
		await h.prompt("go");
		await h.command("rules");
		const text = h.notifications.at(-1)?.message ?? "";
		assert.match(text, /no-claims · user · not fired · Do not claim tests pass/);
		assert.match(text, /broken\.md · skipped: the condition does not compile/);
		assert.match(text, /permission rules are \/permissions/);
	});
});
