/**
 * `subagent-thinking`: a child follows its parent session's thinking level.
 * The parent publishes the level with its session grants (the relay for a
 * foreground child, the snapshot file for a background one), and the child
 * applies it at session start and before every run — never below the level its
 * own agent file asked for, and not at all with `role`.
 *
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { PARENT_SESSION_ENV, readParentGrants } from "../../extensions/session-grants.ts";

const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(): Sandbox {
	const sandbox = makeSandbox();
	created.push(sandbox);
	return sandbox;
}

// the relay registry and the parent-session env are process-global: leave them as found
const root = globalThis as unknown as Record<symbol, unknown>;
let savedRelay: unknown;
const savedParent = process.env[PARENT_SESSION_ENV];
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(() => {
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
	if (savedParent === undefined) delete process.env[PARENT_SESSION_ENV];
	else process.env[PARENT_SESSION_ENV] = savedParent;
});

/** A parent in `level` (no UI: it publishes a snapshot instead of relaying), at `config`. */
async function parentAt(sandbox: Sandbox, level: string, config?: Record<string, unknown>): Promise<Harness> {
	if (config !== undefined) writeFileSync(join(sandbox.agentDir, "pi-keeper.json"), JSON.stringify(config));
	const parent = await startPi({ sandbox, ui: "none", thinkingLevel: level });
	await parent.session();
	return parent;
}

/** A detached child of that parent (no relay; it reads the published snapshot). */
async function childOf(sandbox: Sandbox, parent: Harness, level: string): Promise<Harness> {
	process.env[PARENT_SESSION_ENV] = parent.sessionId;
	const child = await startPi({ sandbox, entry: "child-default", ui: "none", thinkingLevel: level });
	await child.session();
	return child;
}

describe("a child follows the parent's thinking level", () => {
	it("the parent publishes its level with the grants snapshot", async () => {
		const sb = sandboxed();
		const parent = await parentAt(sb, "high");
		assert.equal(readParentGrants(sb.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId })?.thinking, "high");
	});

	it("an unset child takes the parent's level", async () => {
		const sb = sandboxed();
		const parent = await parentAt(sb, "high");
		const child = await childOf(sb, parent, "medium");
		assert.deepEqual(child.thinkingLevelCalls, ["high"]);
		assert.equal(child.thinkingLevel, "high");
	});

	it("a parent that lowered its level does not lower the child", async () => {
		const sb = sandboxed();
		const parent = await parentAt(sb, "low");
		const child = await childOf(sb, parent, "medium");
		assert.deepEqual(child.thinkingLevelCalls, []);
	});

	it("a parent at the child's level changes nothing", async () => {
		const sb = sandboxed();
		const parent = await parentAt(sb, "medium");
		const child = await childOf(sb, parent, "medium");
		assert.deepEqual(child.thinkingLevelCalls, []);
	});

	it("a level the parent raises after the child started reaches the child's next run", async () => {
		const sb = sandboxed();
		const parent = await parentAt(sb, "medium");
		const child = await childOf(sb, parent, "medium");
		assert.deepEqual(child.thinkingLevelCalls, []);
		// the parent goes to xhigh, republishing its snapshot
		parent.thinkingLevel = "medium";
		await parent.thinkingLevelSelected("xhigh");
		assert.equal(readParentGrants(sb.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId })?.thinking, "xhigh");
		await child.prompt("go");
		assert.deepEqual(child.thinkingLevelCalls, ["xhigh"]);
	});

	it("role mode leaves the child alone", async () => {
		const sb = sandboxed();
		const parent = await parentAt(sb, "xhigh", { subagentThinking: "role" });
		assert.equal(readParentGrants(sb.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId })?.thinking, "xhigh");
		const child = await childOf(sb, parent, "medium");
		assert.deepEqual(child.thinkingLevelCalls, []);
		assert.equal(child.thinkingLevel, "medium");
	});

	it("no parent session in the environment: the child keeps its own level", async () => {
		const sb = sandboxed();
		process.env[PARENT_SESSION_ENV] = "no-such-session";
		const child = await startPi({ sandbox: sb, entry: "child-default", ui: "none", thinkingLevel: "medium" });
		await child.session();
		assert.deepEqual(child.thinkingLevelCalls, []);
	});
});
