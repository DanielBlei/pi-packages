/**
 * `/keeper` settings that are not plain toggles: `background-ask-popup`
 * (a choice) and `background-ask-timeout` (a duration). Headless form,
 * completions, the no-UI listing and the two-step selector.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEY, makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

const TMPDIR = process.env.TMPDIR;
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(config?: Record<string, unknown>): Sandbox {
	if (TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = TMPDIR;
	const sandbox = makeSandbox();
	created.push(sandbox);
	if (config !== undefined) writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), JSON.stringify(config));
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

async function parentOf(sandbox: Sandbox, ui: "tui" | "none" = "tui"): Promise<Harness> {
	const h = await startPi({ sandbox, ui });
	started.push(h);
	await h.session();
	return h;
}

const saved = (sandbox: Sandbox): Record<string, unknown> => {
	const file = join(sandbox.agentDir, "pi-keeper.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
};
const lastNote = (h: Harness): { message: string; type: string | undefined } | undefined => h.notifications[h.notifications.length - 1];

describe("/keeper background-ask-popup", () => {
	it("sets each policy and saves it", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		for (const policy of ["badge", "always", "idle"]) {
			await h.command("keeper", `background-ask-popup ${policy}`);
			assert.equal(saved(sb).backgroundAskPopup, policy);
			assert.match(lastNote(h)?.message ?? "", new RegExp(`When background asks pop up: ${policy} — saved`));
		}
	});

	it("the same value again is unchanged; no value or an unknown one is a usage error", async () => {
		const sb = sandboxed({ backgroundAskPopup: "badge" });
		const h = await parentOf(sb);
		await h.command("keeper", "background-ask-popup badge");
		assert.match(lastNote(h)?.message ?? "", /\(unchanged\)/);
		for (const text of ["background-ask-popup", "background-ask-popup on", "background-ask-popup never", "background-ask-popup idle extra"]) {
			await h.command("keeper", text);
			assert.equal(lastNote(h)?.type, "error", text);
			assert.match(lastNote(h)?.message ?? "", /Usage: \/keeper background-ask-popup <idle\|always\|badge>/);
		}
		assert.equal(saved(sb).backgroundAskPopup, "badge");
	});

	it("completions offer the three values", async () => {
		const h = await parentOf(sandboxed());
		assert.deepEqual(h.complete("keeper", "background-ask-popup ")?.map((i) => i.label), ["idle", "always", "badge"]);
		assert.deepEqual(h.complete("keeper", "background-ask-popup a"), [{ value: "background-ask-popup always", label: "always", description: "When background asks pop up: always" }]);
	});
});

describe("/keeper background-ask-timeout", () => {
	it("takes 90s, 5m and 2m30s and saves milliseconds", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		const cases: Array<[string, number, string]> = [["90s", 90_000, "1 min 30 s"], ["10m", 600_000, "10 min"], ["2m30s", 150_000, "2 min 30 s"]];
		for (const [text, ms, shown] of cases) {
			await h.command("keeper", `background-ask-timeout ${text}`);
			assert.equal(saved(sb).backgroundAskTimeoutMs, ms);
			assert.equal(lastNote(h)?.message, `Background ask timeout: ${shown} — saved to pi-keeper.json`);
		}
	});

	it("refuses anything but minutes and seconds with units, with a usage error", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		for (const text of ["background-ask-timeout", "background-ask-timeout 300", "background-ask-timeout 5min", "background-ask-timeout on", "background-ask-timeout 1.5m", "background-ask-timeout 5m 1s"]) {
			await h.command("keeper", text);
			assert.equal(lastNote(h)?.type, "error", text);
			assert.match(lastNote(h)?.message ?? "", /^Usage: \/keeper background-ask-timeout <duration: 10 s to 30 min, e\.g\. 90s, 5m, 2m30s>$/, text);
		}
		assert.equal(saved(sb).backgroundAskTimeoutMs, undefined);
	});

	it("refuses out-of-range values, stating the range, and does not clamp", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		for (const [text, shown] of [["9s", "9 s"], ["31m", "31 min"], ["0s", "0 s"]]) {
			await h.command("keeper", `background-ask-timeout ${text}`);
			assert.equal(lastNote(h)?.type, "error");
			assert.equal(lastNote(h)?.message, `background-ask-timeout must be between 10 s and 30 min, not ${shown}`);
		}
		assert.equal(saved(sb).backgroundAskTimeoutMs, undefined);
		await h.command("keeper", "background-ask-timeout 10s");
		await h.command("keeper", "background-ask-timeout 30m");
		assert.equal(saved(sb).backgroundAskTimeoutMs, 1_800_000);
	});

	it("the current value is unchanged; completions offer presets", async () => {
		const h = await parentOf(sandboxed());
		await h.command("keeper", "background-ask-timeout 5m");
		assert.match(lastNote(h)?.message ?? "", /Background ask timeout: 5 min \(unchanged\)/);
		assert.deepEqual(h.complete("keeper", "background-ask-timeout ")?.map((i) => i.label), ["1m", "2m", "5m", "10m", "15m", "30m"]);
		assert.deepEqual(h.complete("keeper", "background-ask-timeout 1")?.map((i) => i.value), ["background-ask-timeout 1m", "background-ask-timeout 10m", "background-ask-timeout 15m"]);
	});
});

const down = (times: number): string[] => Array.from({ length: times }, () => KEY.down);

describe("the no-UI listing and the panel", () => {
	it("without a UI the listing shows each setting's own usage, not on|off for the non-toggles", async () => {
		const h = await parentOf(sandboxed(), "none");
		await h.command("keeper");
		const text = lastNote(h)?.message ?? "";
		assert.match(text, /When background asks pop up: always — /);
		assert.match(text, /Background ask timeout: 5 min — /);
		assert.match(text, /Command colors in the dialog: dim \(default; pi-shell-highlight not installed\) — /);
		assert.match(text, /subagents-follow-auto <on\|off>/);
		assert.match(text, /background-ask-popup <idle\|always\|badge>/);
		assert.match(text, /background-ask-timeout <duration: 10 s to 30 min, e\.g\. 90s, 5m, 2m30s>/);
		assert.match(text, /command-colors <dim\|muted\|text\|builtin-syntax\|shell-highlight>/);
		assert.doesNotMatch(text, /background-ask-popup <on\|off>|background-ask-timeout <on\|off>/);
	});

	it("the panel opens on the Saving approvals tab, with tabs, aligned rows and the values", async () => {
		const h = await parentOf(sandboxed());
		h.answer(/pi-keeper settings/, "esc");
		await h.command("keeper");
		const shown = h.dialogs[0];
		assert.equal(shown.kind, "custom");
		// one tab line, in order, the active one first
		assert.match(shown.title, /Saving approvals to this project \/ Subagents \/ Dialog/);
		// rows are labels without the value; the value is the right-hand column
		assert.deepEqual(shown.options, ['Offer "always allow in this project" for commands', 'Offer "always allow in this project" for outside read directories', 'Offer "always allow in this project" for exact commands']);
		assert.match(shown.title, /for commands +on/);
		h.assertNoPendingAnswers();
	});

	it("Tab and Shift+Tab switch sections, wrapping around", async () => {
		const h = await parentOf(sandboxed());
		// Tab twice: Subagents, then Dialog; Shift+Tab goes back to Subagents
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, KEY.shiftTab, KEY.shiftTab, KEY.escape] });
		await h.command("keeper");
		const shown = h.dialogs[0];
		assert.deepEqual(shown.options.slice(0, 2), ['Offer "always allow in this project" for commands', 'Offer "always allow in this project" for outside read directories'], "the first render lists the first tab");
		h.assertNoPendingAnswers();
	});

	it("a choice cycles with Enter and saves each value", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		// Subagents tab, then down 4 rows to When background asks pop up (default always): always -> badge -> idle
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, ...down(4), KEY.enter, KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).backgroundAskPopup, "idle");
		h.assertNoPendingAnswers();
	});

	it("a duration opens a one-line input; a value out of range is refused and snaps back", async () => {
		const sb = sandboxed({ backgroundAskTimeoutMs: 120_000 });
		const h = await parentOf(sb);
		const toRow = [KEY.tab, ...down(5)];
		// in, type something unusable, enter: refused, the row keeps 2 min; then a good value
		h.answer(/pi-keeper settings/, { keys: [...toRow, KEY.enter, ..."5min".split(""), KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).backgroundAskTimeoutMs, 120_000, "nothing saved for an unusable duration");

		h.answer(/pi-keeper settings/, { keys: [...toRow, KEY.enter, ..."15m".split(""), KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).backgroundAskTimeoutMs, 900_000);
		h.assertNoPendingAnswers();
	});

	it("Esc in the input leaves the value alone; a toggle flips on Enter", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		// Subagents tab, row 0 is Subagents follow auto mode: Enter flips it
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).subagentsFollowAuto, true);

		// the timeout row again, but Esc inside the input: no second dialog, nothing saved
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, ...down(5), KEY.enter, KEY.escape, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).backgroundAskTimeoutMs, undefined);
		assert.equal(h.dialogs.length, 2, "the input is part of the panel, not a second dialog");
		h.assertNoPendingAnswers();
	});

	it("the dialog's command colors are a row of their own in the Dialog section", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		// Tab twice to Dialog, Enter once: dim -> muted
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, KEY.tab, KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).commandColors, "muted");
		h.assertNoPendingAnswers();
	});
});

describe("/keeper subagent-thinking", () => {
	it("sets follow or role headlessly, saves it, and lists the other value in completions", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		await h.command("keeper", "subagent-thinking role");
		assert.equal(saved(sb).subagentThinking, "role");
		assert.deepEqual(h.complete("keeper", "subagent-thinking ")?.map((i) => i.label), ["follow", "role"]);
		await h.command("keeper", "subagent-thinking follow");
		assert.equal(saved(sb).subagentThinking, "follow");
		// anything but the two words is a usage error, and nothing is saved
		await h.command("keeper", "subagent-thinking inherit");
		assert.match(lastNote(h)?.message ?? "", /Usage: \/keeper subagent-thinking <follow\|role>/);
		assert.equal(saved(sb).subagentThinking, "follow");
	});

	it("picking it in the panel cycles to the other value and saves it", async () => {
		const sb = sandboxed({ subagentThinking: "role" });
		const h = await parentOf(sb);
		// Subagents tab, down 3 rows to Subagent thinking: role -> follow
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, ...down(3), KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).subagentThinking, "follow");
		h.assertNoPendingAnswers();
	});
});

describe("/keeper mode-flash", () => {
	it("sets off, 1s, 2s, 3s or 5s headlessly and saves seconds", async () => {
		const sb = sandboxed();
		const h = await parentOf(sb);
		await h.command("keeper", "mode-flash off");
		assert.equal(saved(sb).modeFlashSecs, 0);
		assert.match(lastNote(h)?.message ?? "", /Mode line after a switch: off — saved/);
		await h.command("keeper", "mode-flash 5s");
		assert.equal(saved(sb).modeFlashSecs, 5);
		await h.command("keeper", "mode-flash 1s");
		assert.equal(saved(sb).modeFlashSecs, 1);
	});

	it("shows a hand-edited length as it is, and an unknown value is a usage error", async () => {
		const sb = sandboxed({ modeFlashSecs: 2.5 });
		const h = await parentOf(sb, "none");
		await h.command("keeper", "");
		assert.match(lastNote(h)?.message ?? "", /Mode line after a switch: 2.5 s — /);
		await h.command("keeper", "mode-flash 7s");
		assert.equal(saved(sb).modeFlashSecs, 2.5, "nothing saved");
		assert.match(lastNote(h)?.message ?? "", /mode-flash <off\|1s\|2s\|3s\|5s>/);
	});

	it("the panel row sits after command colors in the Dialog section and cycles off -> 1s", async () => {
		const sb = sandboxed({ modeFlashSecs: 5 });
		const h = await parentOf(sb);
		// Tab twice to Dialog, Down to the second row, Enter once: 5s -> off (wraps)
		h.answer(/pi-keeper settings/, { keys: [KEY.tab, KEY.tab, KEY.down, KEY.enter, KEY.escape] });
		await h.command("keeper");
		assert.equal(saved(sb).modeFlashSecs, 0);
		h.assertNoPendingAnswers();
	});
});
