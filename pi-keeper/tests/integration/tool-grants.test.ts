/**
 * Tool grants end to end: a tool that is not built in, and a call through the `mcp` gateway,
 * ask once with "don't ask again for `<key>` this session" and "always allow `<key>` in this
 * project"; the grant covers later calls of the same key (default mode only), is shared with
 * foreground and background subagents both ways, and `/permissions` lists and removes it.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";
import { PARENT_SESSION_ENV, readParentGrants } from "../../extensions/session-grants.ts";
import { askDirFor, newAskId, newNonce, readReply, writeRequest, type AskRequest } from "../../extensions/ask-mailbox.ts";
import { BACKGROUND_ASKS_ENV } from "../../extensions/config.ts";
import { TELEMETRY_ENTRY } from "../../extensions/telemetry.ts";

after(() => restoreBell());

const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(): Sandbox {
	const sandbox = makeSandbox();
	created.push(sandbox);
	return sandbox;
}

const root = globalThis as unknown as Record<symbol, unknown>;
let savedRelay: unknown;
const savedEnv = { parent: process.env[PARENT_SESSION_ENV], kill: process.env[BACKGROUND_ASKS_ENV] };
const started: Harness[] = [];
beforeEach(() => {
	savedRelay = root[RELAY_KEY];
	delete root[RELAY_KEY];
});
afterEach(async () => {
	for (const harness of started.splice(0)) await harness.shutdown();
	if (savedRelay === undefined) delete root[RELAY_KEY];
	else root[RELAY_KEY] = savedRelay;
	if (savedEnv.parent === undefined) delete process.env[PARENT_SESSION_ENV];
	else process.env[PARENT_SESSION_ENV] = savedEnv.parent;
	if (savedEnv.kill === undefined) delete process.env[BACKGROUND_ASKS_ENV];
	else process.env[BACKGROUND_ASKS_ENV] = savedEnv.kill;
});

async function open(sandbox: Sandbox, options: { toolAnnotations?: Record<string, Record<string, unknown>> } = {}): Promise<Harness> {
	const h = await startPi({ sandbox, ...options });
	started.push(h);
	await h.session();
	return h;
}

const PERMISSION = /Permission required/;
const SUB = /Permission required \(subagent, default mode\)/;
const BG = /Background subagent scout: Permission required \(subagent, default mode\)/;
const sessionLabel = (key: string, suffix = ""): string => `Yes, and don't ask again for \`${key}\` this session${suffix}`;
const projectLabel = (key: string, suffix = ""): string => `Yes, and always allow \`${key}\` in this project${suffix}`;
const SEARCH = { tool: "search", server: "docs", args: { q: "x" } };
/** Answer the ask with No and start a new run afterwards (a rejected call ends the current one). */
async function refuse(h: Harness, tool: string, input: unknown): Promise<boolean> {
	h.answer(PERMISSION, "No");
	const outcome = await h.tool(tool, input as Record<string, unknown>);
	await h.prompt("go on");
	return outcome.blocked;
}
const settingsFile = (sandbox: Sandbox): string => join(sandbox.cwd, ".pi", "settings.local.json");
const telemetry = (h: Harness): Array<Record<string, unknown>> => h.entries.filter((e) => e.type === "custom" && e.customType === TELEMETRY_ENTRY).map((e) => e.data as Record<string, unknown>);

describe("the offer", () => {
	it("an unknown tool asks and offers the session and the project option", async () => {
		const h = await open(sandboxed());
		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("docs_lookup", { id: "1" })).blocked, true);
		assert.ok(h.dialogs[0].options.includes(sessionLabel("Tool(docs_lookup)")), h.dialogs[0].options.join(" | "));
		assert.ok(h.dialogs[0].options.includes(projectLabel("Tool(docs_lookup)")));
		h.assertNoPendingAnswers();
	});

	it("a gateway call asks with its server-qualified key; the same call without a server is another key", async () => {
		const h = await open(sandboxed());
		await refuse(h, "mcp", SEARCH);
		assert.ok(h.dialogs[0].options.includes(sessionLabel("Mcp(docs/search)")), h.dialogs[0].options.join(" | "));
		await refuse(h, "mcp", { tool: "search", args: {} });
		assert.ok(h.dialogs[1].options.includes(sessionLabel("Mcp(search)")), h.dialogs[1].options.join(" | "));
		await refuse(h, "mcp", { search: "issues", server: "tracker" });
		assert.ok(h.dialogs[2].options.includes(sessionLabel("Mcp(tracker/catalog)")), h.dialogs[2].options.join(" | "));
		h.assertNoPendingAnswers();
	});

	it("a write-like name ends the options with (may change data)", async () => {
		const h = await open(sandboxed());
		h.answer(PERMISSION, "No");
		await h.tool("mcp", { tool: "delete_issue", server: "tracker", args: {} });
		assert.ok(h.dialogs[0].options.includes(sessionLabel("Mcp(tracker/delete_issue)", " (may change data)")), h.dialogs[0].options.join(" | "));
		assert.ok(h.dialogs[0].options.includes(projectLabel("Mcp(tracker/delete_issue)", " (may change data)")));
		h.assertNoPendingAnswers();
	});

	it("the project option is hidden when project approvals are off", async () => {
		const sb = sandboxed();
		writeFileSync(join(sb.agentDir, "pi-keeper.json"), JSON.stringify({ projectCommandApprovals: false }));
		const h = await open(sb);
		h.answer(PERMISSION, "No");
		await h.tool("docs_lookup", {});
		assert.ok(h.dialogs[0].options.includes(sessionLabel("Tool(docs_lookup)")));
		assert.ok(!h.dialogs[0].options.some((o) => o.startsWith("Yes, and always allow")), h.dialogs[0].options.join(" | "));
	});

	it("mcpScript, connect, actions, unknown keys and a destructive-hinted tool get no option", async () => {
		const h = await open(sandboxed(), { toolAnnotations: { docs_drop: { destructiveHint: true } } });
		const calls: Array<[string, unknown]> = [
			["mcpScript", { code: "1+1" }],
			["mcp", { connect: "docs" }],
			["mcp", { action: "ui-messages" }],
			["mcp", { tool: "search", server: "docs", extra: true }],
			["docs_drop", {}],
		];
		for (const [tool, input] of calls) {
			assert.equal(await refuse(h, tool, input), true, tool);
		}
		for (const dialog of h.dialogs) {
			assert.ok(!dialog.options.some((o) => /don't ask again for `(Tool|Mcp)\(|always allow `(Tool|Mcp)\(/.test(o)), dialog.options.join(" | "));
		}
		h.assertNoPendingAnswers();
	});
});

describe("session grants", () => {
	it("the grant covers the next call of the same key and nothing else", async () => {
		const h = await open(sandboxed());
		h.answer(PERMISSION, sessionLabel("Mcp(docs/search)"));
		assert.equal((await h.tool("mcp", SEARCH)).blocked, false);
		assert.equal((await h.tool("mcp", { ...SEARCH, args: { q: "other" } })).blocked, false);
		assert.equal(h.dialogs.length, 1, "no second dialog");
		assert.equal(await refuse(h, "mcp", { tool: "search", args: {} }), true, "unqualified is another key");
		assert.equal(await refuse(h, "mcp", { tool: "fetch", server: "docs" }), true);
		assert.equal(await refuse(h, "mcp", { connect: "docs" }), true);
		const logged = telemetry(h).find((d) => d.phase === "choice" && d.remembered === "Mcp(docs/search)");
		assert.equal(logged?.scope, "session");
		assert.equal(logged?.outcome, "remember-session");
	});

	it("a direct tool grant works, plan mode still denies it and auto stays as it was", async () => {
		const h = await open(sandboxed());
		h.answer(PERMISSION, sessionLabel("Tool(docs_lookup)"));
		assert.equal((await h.tool("docs_lookup", {})).blocked, false);
		await h.command("mode", "plan");
		assert.equal((await h.tool("docs_lookup", {})).blocked, true, "plan denies");
		await h.command("mode", "auto");
		assert.equal((await h.tool("docs_lookup", {})).blocked, false, "auto allows");
		assert.equal((await h.tool("other_tool", {})).blocked, false, "auto allows any tool");
		assert.equal(h.dialogs.length, 1);
		h.assertNoPendingAnswers();
	});

	it("/permissions lists the grant and removes it", async () => {
		const h = await open(sandboxed());
		h.answer(PERMISSION, sessionLabel("Tool(docs_lookup)"));
		await h.tool("docs_lookup", {});
		h.answer(/Permission rules/, "[session] Tool(docs_lookup) allowed");
		h.answer(/Tool\(docs_lookup\)/, "Remove");
		await h.command("permissions");
		h.answer(PERMISSION, "Yes");
		await h.tool("docs_lookup", {});
		assert.equal(h.dialogs.filter((d) => PERMISSION.test(d.title)).length, 2, "removed: asks again");
		h.assertNoPendingAnswers();
	});
});

describe("project grants", () => {
	it("the project option writes the rule and a new session honours it", async () => {
		const sb = sandboxed();
		const h = await open(sb);
		h.answer(PERMISSION, projectLabel("Mcp(docs/search)"));
		assert.equal((await h.tool("mcp", SEARCH)).blocked, false);
		const rules = JSON.parse(readFileSync(settingsFile(sb), "utf8"));
		assert.deepEqual(rules["pi-keeper"].permissions.allow, ["Mcp(docs/search)"]);
		assert.equal(telemetry(h).find((d) => d.remembered === "Mcp(docs/search)")?.scope, "project");
		const next = await open(sb);
		assert.equal((await next.tool("mcp", SEARCH)).blocked, false);
		assert.equal(next.dialogs.length, 0);
		await next.command("mode", "plan");
		assert.equal((await next.tool("mcp", SEARCH)).blocked, true, "plan still denies");
		const background = await startPi({ sandbox: sb, entry: "child-default" });
		started.push(background);
		await background.session();
		assert.equal((await background.tool("mcp", SEARCH)).blocked, false, "a background child inherits the project grant");
	});

	it("a hand-written allow entry is reviewed, then lets the call run", async () => {
		const sb = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(settingsFile(sb), JSON.stringify({ "pi-keeper": { permissions: { allow: ["Tool(docs_lookup)"] } } }));
		const h = await startPi({ sandbox: sb });
		started.push(h);
		h.answer(/Load 1 allow rule/, "Load them");
		await h.session();
		assert.equal((await h.tool("docs_lookup", {})).blocked, false);
		assert.equal(h.dialogs.length, 1, "only the rules review");
	});

	it("project ask and deny entries apply in every mode, even over a session grant", async () => {
		const sb = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(settingsFile(sb), JSON.stringify({ "pi-keeper": { permissions: { ask: ["Tool(docs_ask)"], deny: ["Mcp(tracker/delete_issue)", "Tool(docs_drop)"] } } }));
		const h = await open(sb, { toolAnnotations: { docs_drop: { destructiveHint: true } } });
		for (const mode of ["default", "auto", "plan"]) {
			await h.command("mode", mode);
			const denied = await h.tool("mcp", { tool: "delete_issue", server: "tracker" });
			assert.equal(denied.blocked, true, mode);
			assert.match(denied.reason ?? "", /blocked by a project rule/);
			assert.equal((await h.tool("docs_drop", {})).blocked, true, mode);
		}
		await h.command("mode", "auto");
		h.answer(PERMISSION, "No");
		assert.equal((await h.tool("docs_ask", {})).blocked, true, "ask applies in auto");
		h.assertNoPendingAnswers();
	});

	it("project deny and ask rules match reshaped calls in every mode", async () => {
		const sb = sandboxed();
		mkdirSync(join(sb.cwd, ".pi"), { recursive: true });
		writeFileSync(settingsFile(sb), JSON.stringify({ "pi-keeper": { permissions: { ask: ["Mcp(s/ask)"], deny: ["Mcp(s/rm)"] } } }));
		const h = await open(sb);
		const denied: Array<[string, unknown]> = [
			["mcp", { tool: "rm" }],
			["mcp", { tool: "rm", server: "S" }],
			["mcp", { tool: "s_rm" }],
			["mcp", { tool: "rm", server: "s", connect: "x" }],
			["s_rm", {}],
		];
		for (const mode of ["default", "plan", "auto"]) {
			await h.command("mode", mode);
			for (const [tool, input] of denied) {
				const result = await h.tool(tool, input as Record<string, unknown>);
				assert.equal(result.blocked, true, `${mode} ${JSON.stringify(input)}`);
				assert.match(result.reason ?? "", /blocked by a project rule/);
			}
		}
		await h.command("mode", "auto");
		for (const input of [{ tool: "ask" }, { tool: "ask", server: "s", action: "x" }]) {
			const before = h.dialogs.length;
			assert.equal(await refuse(h, "mcp", input), true, JSON.stringify(input));
			assert.equal(h.dialogs.length, before + 1, JSON.stringify(input));
		}
		h.assertNoPendingAnswers();
	});

	it("mcpScript variants get no option and no key", async () => {
		const h = await open(sandboxed());
		const calls: Array<[string, unknown]> = [
			["mcp_script", { code: "1" }],
			["McpScript", { code: "1" }],
			["MCPSCRIPT", { code: "1" }],
			["mcp", { tool: "mcp_script" }],
			["mcp", { tool: "MCPSCRIPT", server: "docs" }],
		];
		for (const [tool, input] of calls) assert.equal(await refuse(h, tool, input), true, tool);
		for (const dialog of h.dialogs) {
			assert.ok(!dialog.options.some((o) => /(Tool|Mcp)\(/.test(o)), dialog.options.join(" | "));
		}
		h.assertNoPendingAnswers();
	});

	it("/permissions lists and removes a project tool rule", async () => {
		const sb = sandboxed();
		const h = await open(sb);
		h.answer(PERMISSION, projectLabel("Tool(docs_lookup)"));
		await h.tool("docs_lookup", {});
		h.answer(/Permission rules/, /\[project allow\] Tool\(docs_lookup\)/);
		h.answer(/Tool\(docs_lookup\)/, "Remove");
		await h.command("permissions");
		assert.equal(JSON.parse(readFileSync(settingsFile(sb), "utf8"))["pi-keeper"]?.permissions?.allow, undefined);
		h.assertNoPendingAnswers();
	});
});

describe("subagents", () => {
	it("a foreground child inherits a parent grant", async () => {
		const sb = sandboxed();
		const parent = await open(sb);
		const child = await startPi({ sandbox: sb, entry: "child-default" });
		started.push(child);
		await child.session();
		parent.answer(PERMISSION, sessionLabel("Mcp(docs/search)"));
		assert.equal((await parent.tool("mcp", SEARCH)).blocked, false);
		const count = parent.dialogs.length;
		assert.equal((await child.tool("mcp", SEARCH)).blocked, false);
		assert.equal(parent.dialogs.length, count);
		assert.equal(child.dialogs.length, 0);
	});

	it("a grant chosen in child A's relayed dialog (shared wording) covers the parent and sibling child B", async () => {
		const sb = sandboxed();
		const parent = await open(sb);
		const a = await startPi({ sandbox: sb, entry: "child-default" });
		const b = await startPi({ sandbox: sb, entry: "child-default" });
		started.push(a, b);
		await a.session();
		await b.session();
		parent.answer(SUB, sessionLabel("Tool(docs_lookup)", ", for me and my subagents"));
		assert.equal((await a.tool("docs_lookup", {})).blocked, false);
		assert.ok(parent.dialogs[0].options.includes(projectLabel("Tool(docs_lookup)")), parent.dialogs[0].options.join(" | "));
		assert.equal((await b.tool("docs_lookup", {})).blocked, false);
		assert.equal((await parent.tool("docs_lookup", {})).blocked, false);
		assert.equal(parent.dialogs.length, 1, "one dialog only");
		parent.assertNoPendingAnswers();
	});

	it("a background child reads the parent's published grant", async () => {
		const sb = sandboxed();
		const parent = await open(sb);
		parent.answer(PERMISSION, sessionLabel("Mcp(docs/search)"));
		await parent.tool("mcp", SEARCH);
		const shared = readParentGrants(sb.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId });
		assert.deepEqual(shared?.tools, ["Mcp(docs/search)"]);
		const relay = root[RELAY_KEY];
		delete root[RELAY_KEY];
		process.env[PARENT_SESSION_ENV] = parent.sessionId;
		process.env[BACKGROUND_ASKS_ENV] = "0";
		try {
			const child = await startPi({ sandbox: sb, entry: "child-default" });
			started.push(child);
			await child.session();
			assert.equal((await child.tool("mcp", SEARCH)).blocked, false);
			assert.equal((await child.tool("mcp", { tool: "search", args: {} })).blocked, true, "another key is not covered");
			assert.equal(child.dialogs.length, 0);
		} finally {
			if (relay !== undefined) root[RELAY_KEY] = relay;
		}
	});

	it("a grant chosen for a background child's request lands in the parent and covers a sibling child", async () => {
		const sb = sandboxed();
		const parent = await open(sb);
		const dir = askDirFor(sb.agentDir, parent.sessionId);
		const request: AskRequest = { v: 1, id: newAskId(), nonce: newNonce(), childPid: process.pid, childLabel: "scout", childMode: "default", cwd: sb.cwd, call: { toolName: "mcp", input: SEARCH } };
		writeRequest(dir, request);
		parent.answer(BG, sessionLabel("Mcp(docs/search)", ", for me and my subagents"));
		parent.pollAsks();
		for (let i = 0; i < 1200 && readReply(dir, request.id, request.nonce) === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(readReply(dir, request.id, request.nonce)?.decision, "allow");
		assert.ok(parent.dialogs[0].options.includes(projectLabel("Mcp(docs/search)")), parent.dialogs[0].options.join(" | "));
		assert.deepEqual(readParentGrants(sb.agentDir, { [PARENT_SESSION_ENV]: parent.sessionId })?.tools, ["Mcp(docs/search)"]);
		// the parent's own call and a sibling foreground child need no dialog
		assert.equal((await parent.tool("mcp", SEARCH)).blocked, false);
		const sibling = await startPi({ sandbox: sb, entry: "child-default" });
		started.push(sibling);
		await sibling.session();
		assert.equal((await sibling.tool("mcp", SEARCH)).blocked, false);
		assert.equal(parent.dialogs.length, 1);
		parent.assertNoPendingAnswers();
	});
});
