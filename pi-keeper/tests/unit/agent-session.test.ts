import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { writeAgentSession, type AgentSession } from "../fixtures/replay/agent-session.ts";

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));

interface Row {
	key: string;
	origin: string;
	mode: string;
	recorded: { action: string; waitMs?: number; choice?: string | null };
	decided: { action: string };
	dialog: boolean;
}

describe("agent-style synthetic session", () => {
	let work: string;
	let session: AgentSession;
	let meta: Record<string, unknown>;
	let rows: Row[];

	before(() => {
		work = mkdtempSync(join(tmpdir(), "agent-session-test-"));
		session = writeAgentSession(join(work, "tree"));
		const out = join(work, "out", "new.jsonl");
		const run = spawnSync(process.execPath, [join(PACKAGE, "scripts", "replay.ts"), "run", "--session", session.parentPath, "--code", PACKAGE, "--out", out, "--agent-dir", join(work, "agent")], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120_000,
		});
		assert.equal(run.status, 0, run.stderr);
		const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		meta = lines[0].meta as Record<string, unknown>;
		rows = lines.slice(1) as unknown as Row[];
	});
	after(() => {
		rmSync(work, { recursive: true, force: true });
		rmSync(session.scratchDir, { recursive: true, force: true });
	});

	it("is measured by the harness: 145 decisions, 116 dialogs, 95 background, every ask paired", () => {
		assert.equal(meta.rows, 145);
		assert.deepEqual(meta.pairingProblems, [], "no missing or ambiguous background pairs");
		const dialogs = rows.filter((row) => row.recorded.action === "ask");
		assert.equal(dialogs.length, 116);
		assert.equal(dialogs.filter((row) => row.origin === "bg-child").length, 95);
		assert.equal(rows.filter((row) => row.recorded.action === "allow").length, 29);
		assert.ok(dialogs.every((row) => row.recorded.choice === "Yes"));
		// the self-check ran: every row carries a recomputed verdict (how many still ask is the measurement)
		assert.ok(rows.every((row) => typeof row.dialog === "boolean" && typeof row.decided.action === "string"));
	});

	it("has the measured wait profile and mode mix", () => {
		const waits = rows.filter((row) => row.recorded.action === "ask").map((row) => (row.recorded.waitMs ?? 0) / 1000).sort((a, b) => a - b);
		const sum = waits.reduce((a, b) => a + b, 0);
		assert.ok(Math.abs((waits[57] + waits[58]) / 2 - 2.4) < 0.3, `median ${waits[57]}`);
		assert.ok(waits[110] >= 120 && waits[110] <= 130, `p95 ${waits[110]}`);
		assert.equal(waits[115], 700);
		assert.ok(sum > 42 * 60 && sum < 44 * 60, `sum ${sum}`);
		const plan = rows.filter((row) => row.mode === "plan").length;
		assert.ok(plan >= 3 && plan < 15, `plan rows ${plan}`);
	});

	it("maps every dialog key to a category", () => {
		const keys = new Set(rows.filter((row) => row.recorded.action === "ask").map((row) => row.key));
		assert.deepEqual([...keys].sort(), Object.keys(session.categories).sort());
		const counts = new Map<string, number>();
		for (const category of Object.values(session.categories)) counts.set(category, (counts.get(category) ?? 0) + 1);
		assert.deepEqual(Object.fromEntries([...counts].sort()), { assign: 3, cd: 4, checksum: 2, glob: 3, heredoc: 20, interp: 14, loop: 56, redirect: 8, subst: 6 });
	});
});
