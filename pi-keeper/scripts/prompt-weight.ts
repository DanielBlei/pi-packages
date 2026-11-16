/**
 * What the model is told, and what it costs: the text this extension injects per
 * mode, measured through the mock harness so the numbers are the ones pi really
 * sends (the constant contract section on every request, the mode message on a
 * switch, the rulebook warning only when a rule fires).
 *
 * Prints a table and never fails on a threshold — `tests/unit/prompt-weight.test.ts`
 * holds the caps. Run: `npm run prompt-weight`.
 */

import { DEFAULT_READ_ONLY_TOOLS } from "../extensions/config.ts";
import { estimateTokens } from "../extensions/prompt-blocks.ts";
import { correctionText, RULE_BODY_CAP, RULE_TEXT_CAP, type RulebookRule } from "../extensions/rulebook.ts";
import { makeSandbox, restoreBell, startPi, type Harness } from "../tests/mocks/pi.ts";

const MODES = ["default", "auto", "plan"] as const;

function row(label: string, text: string, note: string): void {
	console.log(`  ${label.padEnd(26)} ${String(text.length).padStart(6)} chars  ${String(estimateTokens(text)).padStart(5)} tokens (est.)  ${note}`);
}

/** The text pi sends for `mode`: the part in the system prompt, and the mode message in the conversation. */
async function measure(mode: (typeof MODES)[number]): Promise<{ system: string; block: string }> {
	// startPi points TMPDIR at the sandbox, so it must be put back before the next sandbox is made
	const savedTmp = process.env.TMPDIR;
	const sandbox = makeSandbox();
	try {
		const h: Harness = await startPi({ sandbox });
		await h.session();
		if (mode !== "default") await h.command("mode", mode);
		const { systemPrompt } = await h.prompt("go");
		return { system: systemPrompt, block: h.modeBlocks().at(-1) ?? "" };
	} finally {
		sandbox.cleanup();
		if (savedTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmp;
	}
}

/** A rule as the file parser would hand it over, to render the real warning text at two sizes. */
const rule = (body: string): RulebookRule => ({ name: "no-claims", kind: "user", file: "/rules/no-claims.md", description: "Do not claim that tests pass when they did not run.", condition: "(?i)\\ball tests pass\\b", pattern: /\ball tests pass\b/i, body, hash: "" });

console.log("Prompt weight of pi-keeper (characters, and a chars/4 estimate: the same rule pi uses)");
console.log(`  read-only tools allowed by default: ${DEFAULT_READ_ONLY_TOOLS.length}`);
console.log("");
console.log("  Every request — the constant system-prompt section:");
row("pi_keeper section", (await measure("default")).system, "sent once per session, byte-identical until a mode switch");
console.log("");
console.log("  On a mode switch — one hidden conversation message (plus the user's rules line):");
for (const mode of MODES) row(`${mode} mode message`, (await measure(mode)).block, "no user rules, no session grants");
console.log("");
console.log("  Only when a rule fires — one hidden message, at most once per rule per session:");
row("warning, one short rule", correctionText([rule("Do not say \"it should work\". Run it and quote the output.")]), "typical rule");
row("warning, body at the cap", correctionText([rule("x".repeat(RULE_BODY_CAP))]), `RULE_BODY_CAP = ${RULE_BODY_CAP} chars per rule`);
row("warning, two rules at the cap", correctionText([rule("x".repeat(RULE_BODY_CAP)), rule("y".repeat(RULE_BODY_CAP))]), `whole message capped at RULE_TEXT_CAP = ${RULE_TEXT_CAP}`);
restoreBell();
