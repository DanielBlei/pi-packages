/**
 * Tests for the wave-2a classifier additions: checksum tools, plain scratch heredocs, blocker texts.
 * Run: node --test tests/unit/classifier-additions.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_RULES, MODES, type ModeName } from "../../extensions/modes.ts";
import { createScratchDir, maskScratchHeredocs, readOnlyBlockers } from "../../extensions/utils.ts";
import { evaluate, type Action, type EvalContext } from "../../extensions/rules.ts";

const CWD = "/home/user/project";
const AGENT_DIR = `${homedir()}/.pi/agent`;
const PLAN_FILE = `${AGENT_DIR}/plans/project-2026-10-04-120000-ab12.md`;
const MODE_NAMES: ModeName[] = ["default", "plan", "auto"];

function withScratch(run: (scratch: string, at: (mode: ModeName, command: string) => Action) => void): void {
	const base = mkdtempSync(join(tmpdir(), "pk-additions-"));
	try {
		const scratch = realpathSync(createScratchDir(base));
		const at = (mode: ModeName, command: string): Action => {
			const ctx: EvalContext = { cwd: CWD, agentDir: AGENT_DIR, planFile: PLAN_FILE, remembered: [], scratchDir: scratch };
			return evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: "bash", input: { command } }, ctx).action;
		};
		run(scratch, at);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

test("checksum tools are read-only, and the scanners still judge their arguments", () => {
	withScratch((_scratch, at) => {
		for (const mode of ["default", "plan"] as const) {
			for (const tool of ["sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "md5sum", "b2sum", "cksum", "sum"]) {
				assert.equal(at(mode, `${tool} src/a.ts`), "allow", `${mode} ${tool}`);
			}
		}
		for (const mode of MODE_NAMES) {
			assert.equal(at(mode, "sha256sum /etc/hosts"), "ask", `${mode} outside cwd`);
			assert.equal(at(mode, "sha256sum .env"), "ask", `${mode} secret`);
		}
		// auto allows what it does not classify; the read-only table decides in default and plan
		for (const mode of ["default", "plan"] as const) {
			for (const flags of ["-c", "--check", "-bc", "--chec", "-cw"]) {
				assert.equal(at(mode, `sha256sum ${flags} sums.txt`), "ask", `${mode} ${flags}`);
			}
		}
		assert.match(readOnlyBlockers("sha256sum -c sums.txt", CWD).join("; "), /`sha256sum -c` reads the file names to check from a file, so the files it reads can't be checked/);
		assert.match(readOnlyBlockers("md5sum -bc sums.txt", CWD).join("; "), /`md5sum -bc`/);
	});
});

test("plain scratch heredocs: unquoted delimiter with an inert body, and append", () => {
	withScratch((scratch, at) => {
		for (const mode of ["default", "plan"] as const) {
			assert.equal(at(mode, `cat > ${scratch}/n <<EOF\nhello\nEOF`), "allow", `${mode} unquoted plain`);
			assert.equal(at(mode, `cat >> ${scratch}/n <<'EOF'\nx\nEOF`), "allow", `${mode} append`);
			assert.equal(at(mode, `cat >> ${scratch}/n <<EOF\nx\nEOF`), "allow", `${mode} append unquoted`);
		}
		for (const mode of ["default", "plan"] as const) {
			assert.equal(at(mode, `cat > ${scratch}/n <<EOF\nhello $x\nEOF`), "ask", `${mode} $`);
			assert.equal(at(mode, `cat > ${scratch}/n <<EOF\nhello \`id\`\nEOF`), "ask", `${mode} backtick`);
			assert.equal(at(mode, `cat > ${scratch}/n <<EOF\nhello \\n\nEOF`), "ask", `${mode} backslash`);
			assert.equal(at(mode, `cat > ${scratch}/n <<-EOF\nhello\nEOF`), "ask", `${mode} <<- unquoted`);
			assert.equal(at(mode, `cat >> src/n <<'EOF'\nx\nEOF`), "ask", `${mode} append outside scratch`);
			assert.equal(at(mode, `sh > ${scratch}/n <<EOF\nls\nEOF`), "ask", `${mode} non-cat`);
			assert.equal(at(mode, `sh >> ${scratch}/n <<'EOF'\nls\nEOF`), "ask", `${mode} non-cat append`);
			assert.equal(at(mode, `cat > out.md <<EOF\nhello\nEOF`), "ask", `${mode} unquoted outside scratch`);
		}
		assert.equal(maskScratchHeredocs("cat > /s/n <<EOF\n$x\nEOF", "/s"), "cat > /s/n <<EOF\n$x\nEOF");
	});
});
