import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTree, type Tree } from "../fixtures/replay/session-tree.ts";
import { parsePrefixGrants, scratchOf, targetMatches } from "../../scripts/replay.ts";

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(PACKAGE, "scripts", "replay.ts");
const MINI = join(PACKAGE, "tests", "fixtures", "replay", "mini-decisions.ts");

interface Row {
	key: string;
	origin: string;
	mode: string;
	recorded: { action: string; matcher: string | null; choice?: string | null; waitMs?: number };
	decided: { action: string; rule: string; why?: string };
	dialog: boolean;
	dialogWithPrefixGrants: boolean;
	envFingerprint: { node: string; projectRules: boolean };
}

function replay(args: string[]) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readRun(path: string): { meta: Record<string, unknown>; rows: Row[] } {
	const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	return { meta: lines[0].meta as Record<string, unknown>, rows: lines.slice(1) as unknown as Row[] };
}

describe("replay", () => {
	let work: string;
	let tree: Tree;
	let oldOut: string;
	let newOut: string;
	let newCode: string;

	before(() => {
		work = mkdtempSync(join(tmpdir(), "replay-test-"));
		tree = buildTree(join(work, "data"));
		// a second code tree whose evaluate allows everything: a planted loosening
		newCode = join(work, "loose");
		mkdirSync(join(newCode, "extensions"), { recursive: true });
		for (const name of ["rules", "modes", "utils", "project-rules", "telemetry"]) {
			const real = pathToFileURL(join(PACKAGE, "extensions", `${name}.ts`)).href;
			const extra = name === "rules" ? `export const evaluate = () => ({ action: "allow" as const });\n` : "";
			writeFileSync(join(newCode, "extensions", `${name}.ts`), `export * from ${JSON.stringify(real)};\n${extra}`);
		}
		oldOut = join(work, "out", "old.jsonl");
		newOut = join(work, "out", "new.jsonl");
	});
	after(() => rmSync(work, { recursive: true, force: true }));

	it("replays parent, foreground and background decisions, joined by id", () => {
		const run = replay(["run", "--session", tree.parent, "--code", PACKAGE, "--out", oldOut, "--agent-dir", join(work, "agent")]);
		assert.equal(run.status, 0, run.stderr);
		const { meta, rows } = readRun(oldOut);
		const byKey = new Map(rows.map((row) => [row.key, row]));
		assert.deepEqual([...byKey.keys()].sort(), ["bg-child:run-bg#req-1", "fg-child:run-fg#c1", "parent:parent#p1", "parent:parent#p2", "parent:parent#p3"]);

		// the 200+ character command is judged from the full toolCall text: npm install is not read-only
		const long = byKey.get("parent:parent#p2");
		assert.ok(long);
		assert.equal(long.origin, "parent");
		assert.equal(long.recorded.action, "ask");
		assert.equal(long.recorded.choice, "Yes, and always allow npm install");
		assert.equal(long.recorded.waitMs, 1200);
		assert.equal(long.decided.action, "ask");
		assert.equal(long.dialog, true);
		assert.equal(byKey.get("parent:parent#p1")?.decided.action, "allow");

		// no session grants without parsed ones; the parsed prefix covers the later install
		const later = byKey.get("parent:parent#p3");
		assert.equal(later?.dialog, true);
		assert.equal(later?.dialogWithPrefixGrants, false);
		assert.equal(long.dialogWithPrefixGrants, true, "a grant parsed from this row's own choice does not apply to it");

		const fg = byKey.get("fg-child:run-fg#c1");
		assert.equal(fg?.origin, "fg-child");
		assert.equal(fg?.recorded.choice, "Yes", "the relayed choice row of the parent joins the child's call");

		assert.ok(rows.every((row) => row.envFingerprint.projectRules === true && row.envFingerprint.node === process.version));
		assert.equal(JSON.stringify(rows).includes("pkg-number"), false, "no command text is written");
		assert.equal(meta.rows, 5);
	});

	it("rows carry the bashWhy text of the code tree, and a tree without bashWhy still runs", () => {
		const row = readRun(oldOut).rows.find((r) => r.key === "parent:parent#p2");
		assert.match(row?.decided.why ?? "", /npm install/);
		// a baseline tree that predates bashWhy: rules exports only evaluate
		const baseline = join(work, "baseline");
		mkdirSync(join(baseline, "extensions"), { recursive: true });
		for (const name of ["rules", "modes", "utils", "project-rules", "telemetry"]) {
			const real = pathToFileURL(join(PACKAGE, "extensions", `${name}.ts`)).href;
			writeFileSync(join(baseline, "extensions", `${name}.ts`), name === "rules" ? `export { evaluate } from ${JSON.stringify(real)};\n` : `export * from ${JSON.stringify(real)};\n`);
		}
		const out = join(work, "out", "baseline.jsonl");
		const run = replay(["run", "--session", tree.parent, "--code", baseline, "--out", out, "--agent-dir", join(work, "agent")]);
		assert.equal(run.status, 0, run.stderr);
		const old = readRun(out).rows.find((r) => r.key === "parent:parent#p2");
		assert.equal(old?.decided.action, "ask");
		assert.match(old?.decided.why ?? "", /npm install/);
	});

	it("pairs a background ask by recomputed target and reports ambiguous and missing ones", () => {
		const { meta, rows } = readRun(oldOut);
		const bg = rows.find((row) => row.origin === "bg-child");
		assert.ok(bg);
		assert.equal(bg.key, "bg-child:run-bg#req-1");
		assert.equal(bg.dialog, true, "child and parent both ask for rm -rf");
		assert.equal(bg.recorded.choice, "allow/user");
		const problems = meta.pairingProblems as { kind: string; key: string }[];
		assert.deepEqual(problems.map((p) => `${p.kind}:${p.key}`).sort(), ["ambiguous:bg-child:#req-2", "missing:bg-child:#req-3"]);
		assert.ok(rows.every((row) => !row.key.includes("req-2") && !row.key.includes("req-3")));
	});

	it("refuses an --out inside a git repository", () => {
		const result = replay(["run", "--session", tree.parent, "--code", PACKAGE, "--out", join(PACKAGE, "replay-should-not-exist.jsonl")]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /refusing --out inside a git repository/);
	});

	it("compare prints the self-check and exits 0 when nothing loosened", () => {
		const result = replay(["compare", oldOut, oldOut, "--fixture", MINI]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /recorded dialogs: 4/);
		assert.match(result.stdout, /recomputed old dialogs \(self-check against recorded\): 4/);
		assert.match(result.stdout, /disagreements: 0/);
		assert.match(result.stdout, /# NEW-ALLOW\n\(none\)/);
		assert.match(result.stdout, /0 new allow\(s\)/);
	});

	it("compare lists new allows and exits 1 when a guard entry becomes allow", () => {
		const run = replay(["run", "--session", tree.parent, "--code", newCode, "--out", newOut, "--agent-dir", join(work, "agent")]);
		assert.equal(run.status, 0, run.stderr);
		const result = replay(["compare", oldOut, newOut, "--fixture", MINI]);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /parent:parent#p2 \| parent \| ask -> allow/);
		assert.match(result.stdout, /# NEW-ALLOW\nparent:parent#p2/);
		assert.match(result.stdout, /GUARD FAIL mini\/sudo \[default\]: deny -> allow/);
		assert.match(result.stdout, /flips grouped by old reason/);
	});

	it("warns when the env fingerprints differ", () => {
		const { meta, rows } = readRun(newOut);
		const tampered = join(work, "out", "tampered.jsonl");
		const changed = rows.map((row) => ({ ...row, envFingerprint: { ...row.envFingerprint, node: "v0.0.0" } }));
		writeFileSync(tampered, [{ meta }, ...changed].map((r) => JSON.stringify(r)).join("\n") + "\n");
		const result = replay(["compare", oldOut, tampered, "--fixture", MINI, "--code-new", PACKAGE]);
		assert.equal(result.status, 0, result.stdout);
		assert.match(result.stdout, /WARNING: env fingerprints differ/);
	});

	it("helpers: scratch detection, prefix grants, truncated targets", () => {
		assert.equal(scratchOf(["x\nScratch dir: /tmp/pi-keeper-abc123\ny"], []), "/tmp/pi-keeper-abc123");
		const a = `${tmpdir()}/pi-keeper-aaaaaa`;
		const b = `${tmpdir()}/pi-keeper-bbbbbb`;
		assert.equal(scratchOf([], [`ls ${a}/x`, `cat ${a}/y`]), a);
		assert.equal(scratchOf([], [`ls ${a}/x`, `cat ${b}/y`]), undefined);
		assert.deepEqual(parsePrefixGrants("npm test *, git log *"), [["npm", "test"], ["git", "log"]]);
		assert.deepEqual(parsePrefixGrants("exact: foo bar"), []);
		const full = `${"a".repeat(130)} ${"b".repeat(100)}`;
		const shrunk = `${full.slice(0, 120)}…[+${full.length - 200}]…${full.slice(-80)}`;
		assert.equal(targetMatches(full, shrunk), true);
		assert.equal(targetMatches(`${full}x`, shrunk), false);
		assert.equal(dirname(SCRIPT).endsWith("scripts"), true);
	});
});
