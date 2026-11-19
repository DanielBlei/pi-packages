/**
 * Tool grants: the key of a call (`Tool(<name>)`, `Mcp([<server>/]<tool>)`), exact matching,
 * what is never grantable, the risk label and the project-rule entries.
 * Run: npm run test:unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { grantableTool, looksLikeWrite, parseGrantKey, toolCallKey, toolRuleMatches } from "../../extensions/tool-grants.ts";
import { evaluate, type EvalContext } from "../../extensions/rules.ts";
import { GLOBAL_RULES, MODES } from "../../extensions/modes.ts";
import { NO_PROJECT_RULES, parseRules, saveRules, compilePermissions } from "../../extensions/project-rules.ts";
import { toolGrantLabel, projectToolGrantLabel, dialogOptions } from "../../extensions/options.ts";
import { UNLISTABLE_TOOLS } from "../../extensions/config.ts";
import { SessionGrants } from "../../extensions/session-grant-store.ts";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = (tool: string, input: unknown = {}): string | undefined => toolCallKey(tool, input)?.key;

describe("key derivation", () => {
	it("a direct tool is Tool(<name>)", () => {
		assert.equal(key("docs_search"), "Tool(docs_search)");
		assert.equal(key("context7_resolve-library-id"), "Tool(context7_resolve-library-id)");
	});

	it("a gateway call is Mcp(<server>/<tool>) with a server, Mcp(<tool>) without", () => {
		assert.equal(key("mcp", { tool: "search", server: "docs", args: { q: "x" } }), "Mcp(docs/search)");
		assert.equal(key("mcp", { tool: "search", args: {} }), "Mcp(search)");
		assert.equal(key("mcp", { tool: "search" }), "Mcp(search)");
	});

	it("a gateway lookup is Mcp(<server>/catalog) or Mcp(catalog)", () => {
		assert.equal(key("mcp", { search: "issues" }), "Mcp(catalog)");
		assert.equal(key("mcp", { search: "issues", server: "tracker" }), "Mcp(tracker/catalog)");
		assert.equal(key("mcp", { describe: "create_issue", server: "tracker" }), "Mcp(tracker/catalog)");
		assert.equal(key("mcp", { describe: "create_issue" }), "Mcp(catalog)");
		assert.equal(key("mcp", { server: "docs" }), "Mcp(docs/catalog)");
		assert.equal(key("mcp", {}), "Mcp(catalog)");
		assert.equal(key("mcp", { instructions: true }), "Mcp(catalog)");
		assert.equal(key("mcp", { instructions: true, server: "docs" }), "Mcp(docs/catalog)");
	});

	it("is never grantable for connect, action, mcpScript, unknown keys and mixed shapes", () => {
		assert.equal(key("mcp", { connect: "docs" }), undefined);
		assert.equal(key("mcp", { connect: "docs", server: "docs" }), undefined);
		assert.equal(key("mcp", { action: "ui-messages" }), undefined);
		assert.equal(key("mcp", { tool: "search", action: "x" }), undefined);
		assert.equal(key("mcp", { tool: "search", extra: 1 }), undefined);
		assert.equal(key("mcp", { search: "x", extra: 1 }), undefined);
		assert.equal(key("mcp", { search: "x", describe: "y" }), undefined);
		assert.equal(key("mcp", { tool: "search", search: "x" }), undefined);
		assert.equal(key("mcp", { tool: "mcpScript" }), undefined);
		assert.equal(key("mcpScript", { code: "1" }), undefined);
		assert.equal(key("mcp", { tool: "catalog" }), undefined, "a real tool named catalog would collide with the lookups");
		assert.equal(key("mcp", { tool: "a/b", server: "docs" }), undefined);
		assert.equal(key("mcp", { tool: "x", server: "d/ocs" }), undefined);
		assert.equal(key("mcp", { tool: 5 }), undefined);
		assert.equal(key("mcp", "text"), undefined);
		assert.equal(key("mcp", null), undefined);
	});

	it("is never grantable for the unlistable and built-in tools", () => {
		for (const name of [...[...UNLISTABLE_TOOLS].filter((n) => n !== "mcp"), "read", "grep", "find", "ls", "contact_supervisor", "bg_wait"]) assert.equal(key(name), undefined, name);
		assert.ok(UNLISTABLE_TOOLS.has("mcpScript"));
		assert.equal(parseGrantKey("Tool(mcp)") !== undefined && "error" in parseGrantKey("Tool(mcp)")!, true);
		assert.equal(key("weird name"), undefined);
		assert.equal(key("a(b)"), undefined);
	});

	it("a destructive annotation removes the grant, a read-only one does not", () => {
		assert.equal(grantableTool("docs_drop", {}, { destructiveHint: true }), undefined);
		assert.equal(grantableTool("docs_drop", {}, { readOnlyHint: true, destructiveHint: true }), undefined);
		assert.equal(grantableTool("docs_list", {}, { destructiveHint: false })?.key, "Tool(docs_list)");
		assert.equal(toolCallKey("docs_drop", {})?.key, "Tool(docs_drop)", "the key itself ignores annotations (ask and deny rules still apply)");
	});
});

describe("risk label", () => {
	it("flags write-like words in snake, kebab, dotted and camel case names", () => {
		for (const name of ["delete_issue", "remove-item", "docs.update", "createIssue", "runQuery", "tracker_set_status", "put", "post_comment", "send_mail", "exec_sql", "kill-job", "drop_table", "purge", "write_file", "destroyAll", "deletes"]) {
			assert.equal(looksLikeWrite(name), true, name);
		}
	});

	it("does not flag read-like names or words that merely contain a write word", () => {
		for (const name of ["search", "list_issues", "get_dataset", "settings", "resolve-library-id", "describe", "postgres_query", "runtime_info", "offset", "status"]) {
			assert.equal(looksLikeWrite(name), false, name);
		}
	});

	it("the key carries the flag and the labels end with (may change data)", () => {
		assert.equal(toolCallKey("tracker_create_issue", {})?.risky, true);
		assert.equal(toolCallKey("mcp", { tool: "delete_issue", server: "tracker" })?.risky, true);
		assert.equal(toolCallKey("mcp", { tool: "search", server: "docs" })?.risky, false);
		assert.equal(toolCallKey("mcp", { search: "x" })?.risky, false);
		assert.equal(toolGrantLabel("Tool(a_delete)", true, false), "Yes, and don't ask again for `Tool(a_delete)` this session (may change data)");
		assert.equal(toolGrantLabel("Tool(a_list)", false, true), "Yes, and don't ask again for `Tool(a_list)` this session, for me and my subagents");
		assert.equal(toolGrantLabel("Tool(a_delete)", true, true), "Yes, and don't ask again for `Tool(a_delete)` this session, for me and my subagents (may change data)");
		assert.equal(projectToolGrantLabel("Mcp(docs/search)", false), "Yes, and always allow `Mcp(docs/search)` in this project");
		assert.equal(projectToolGrantLabel("Mcp(tracker/delete_issue)", true), "Yes, and always allow `Mcp(tracker/delete_issue)` in this project (may change data)");
	});

	it("dialogOptions lists both labels before No", () => {
		const options = dialogOptions({ mode: "default", toolName: "docs_search", ruleMatch: undefined, hasLadder: false, toolGrantLabel: "S", projectToolGrantLabel: "P" });
		assert.deepEqual(options.primary.slice(0, 3), ["Yes", "S", "P"]);
	});
});

describe("matching is exact", () => {
	const base: EvalContext = { cwd: "/p", remembered: [] };
	const decide = (mode: "default" | "plan" | "auto", tool: string, input: unknown, ctx: Partial<EvalContext> = {}) => evaluate(MODES[mode].permissions, GLOBAL_RULES, { toolName: tool, input }, { ...base, ...ctx }).action;

	it("a session grant allows only its own key, in default mode", () => {
		const ctx = { toolGrants: ["Mcp(docs/search)", "Tool(docs_list)"] };
		assert.equal(decide("default", "mcp", { tool: "search", server: "docs", args: {} }, ctx), "allow");
		assert.equal(decide("default", "mcp", { tool: "search", args: {} }, ctx), "ask", "a server-qualified rule never covers an unqualified call");
		assert.equal(decide("default", "mcp", { tool: "search", server: "tracker" }, ctx), "ask");
		assert.equal(decide("default", "mcp", { tool: "fetch", server: "docs" }, ctx), "ask");
		assert.equal(decide("default", "docs_list", {}, ctx), "allow");
		assert.equal(decide("default", "docs_list2", {}, ctx), "ask");
		assert.equal(decide("default", "mcp", { tool: "search", server: "docs", connect: "x" }, ctx), "ask");
		assert.equal(decide("default", "mcp", { tool: "docs_list" }, ctx), "ask", "Tool(x) does not cover the gateway");
	});

	it("an unqualified rule never covers a qualified call", () => {
		assert.equal(decide("default", "mcp", { tool: "search", server: "docs" }, { toolGrants: ["Mcp(search)"] }), "ask");
		assert.equal(decide("default", "mcp", { tool: "search" }, { toolGrants: ["Mcp(search)"] }), "allow");
		assert.equal(decide("default", "mcp", { search: "x", server: "docs" }, { toolGrants: ["Mcp(catalog)"] }), "ask");
		assert.equal(decide("default", "mcp", { search: "x" }, { toolGrants: ["Mcp(catalog)"] }), "allow");
	});

	it("plan keeps denying and auto keeps allowing, whatever is granted", () => {
		const ctx = { toolGrants: ["Tool(docs_list)"] };
		assert.equal(decide("plan", "docs_list", {}, ctx), "deny");
		assert.equal(decide("auto", "docs_list", {}), "allow");
	});

	it("a destructive annotation keeps asking even when the key is granted", () => {
		assert.equal(decide("default", "docs_drop", {}, { toolGrants: ["Tool(docs_drop)"], annotationsOf: () => ({ destructiveHint: true }) }), "ask");
	});

	it("project allow keys work in default mode only; ask and deny keys apply in every mode", () => {
		const project = { ...NO_PROJECT_RULES, tools: ["Tool(docs_list)"], askTools: ["Tool(docs_ask)"], denyTools: ["Mcp(docs/drop)"] };
		assert.equal(decide("default", "docs_list", {}, { project }), "allow");
		assert.equal(decide("plan", "docs_list", {}, { project }), "deny");
		for (const mode of ["default", "auto", "plan"] as const) {
			assert.equal(decide(mode, "mcp", { tool: "drop", server: "docs" }, { project, toolGrants: ["Mcp(docs/drop)"] }), "deny", mode);
		}
		assert.equal(decide("auto", "docs_ask", {}, { project }), "ask");
		assert.equal(decide("default", "docs_ask", {}, { project: { ...project, tools: ["Tool(docs_ask)"] } }), "ask", "ask beats allow");
		assert.equal(decide("default", "docs_drop", {}, { project: { ...NO_PROJECT_RULES, denyTools: ["Tool(docs_drop)"] }, annotationsOf: () => ({ destructiveHint: true }) }), "deny");
	});
});

describe("project rules", () => {
	const parse = (allow: unknown[] = [], ask: unknown[] = [], deny: unknown[] = []) => parseRules({ "pi-keeper": { permissions: { allow, ask, deny } } });

	it("reads Tool(...) and Mcp(...) in all three lists", () => {
		const rules = parse(["Tool(docs_list)", "Mcp(docs/search)", "Mcp(catalog)"], ["Tool(docs_ask)"], ["Mcp(tracker/delete_issue)"]);
		assert.deepEqual(rules.allowTools.map((r) => r.key), ["Tool(docs_list)", "Mcp(docs/search)", "Mcp(catalog)"]);
		assert.deepEqual(rules.askTools.map((r) => r.key), ["Tool(docs_ask)"]);
		assert.deepEqual(rules.denyTools.map((r) => r.key), ["Mcp(tracker/delete_issue)"]);
		assert.deepEqual(rules.warnings, []);
		assert.deepEqual(rules.allow, []);
	});

	it("reports what cannot be granted and keeps the rest", () => {
		const rules = parse(["Tool(bash)", "Tool(mcp)", "Tool(mcpScript)", "Tool(read)", "Mcp(docs/mcpScript)", "Mcp(a/b/c)", "Mcp()", "Tool(a b)", "Mcp(a/)", "Tool(docs_ok)"]);
		assert.deepEqual(rules.allowTools.map((r) => r.key), ["Tool(docs_ok)"]);
		assert.equal(rules.warnings.length, 9);
		assert.ok(rules.warnings.every((w) => w.startsWith("allow: ignored")), rules.warnings.join("\n"));
		assert.match(rules.warnings[0], /Tool\(bash\).*can't be granted/);
	});

	it("only trusted allow entries take effect; ask and deny always do", () => {
		const rules = parse(["Tool(docs_list)"], ["Tool(a_b)"], ["Tool(c_d)"]);
		assert.deepEqual(compilePermissions(rules, false).tools, []);
		assert.deepEqual(compilePermissions(rules, true).tools, ["Tool(docs_list)"]);
		assert.deepEqual(compilePermissions(rules, false).askTools, ["Tool(a_b)"]);
		assert.deepEqual(compilePermissions(rules, false).denyTools, ["Tool(c_d)"]);
	});

	it("saveRules writes an allow entry and refuses a bad one", () => {
		const dir = mkdtempSync(join(tmpdir(), "tool-rules-"));
		mkdirSync(join(dir, ".git"));
		const agent = join(dir, "agent");
		saveRules(dir, agent, "allow", ["Mcp(docs/search)"]);
		const file = JSON.parse(readFileSync(join(dir, ".pi", "settings.local.json"), "utf8"));
		assert.deepEqual(file["pi-keeper"].permissions.allow, ["Mcp(docs/search)"]);
		assert.throws(() => saveRules(dir, agent, "allow", ["Tool(bash)"]), /can't be granted/);
	});

	it("parseGrantKey canonicalises and rejects", () => {
		assert.deepEqual(parseGrantKey(" Tool( docs_list ) "), { key: "Tool(docs_list)" });
		assert.equal(parseGrantKey("Bash(ls)"), undefined);
		assert.ok("error" in (parseGrantKey("Mcp(a b)") ?? {}));
	});
});

describe("session store", () => {
	it("adds without duplicates, removes, snapshots and resets", () => {
		const grants = new SessionGrants();
		grants.addTool("Tool(a_b)");
		grants.addTool("Tool(a_b)");
		grants.addTool("Mcp(docs/search)");
		assert.deepEqual(grants.tools, ["Tool(a_b)", "Mcp(docs/search)"]);
		assert.deepEqual(grants.snapshot().tools, ["Tool(a_b)", "Mcp(docs/search)"]);
		grants.removeTool("Tool(a_b)");
		assert.deepEqual(grants.tools, ["Mcp(docs/search)"]);
		grants.reset();
		assert.deepEqual(grants.tools, []);
	});
});

describe("never-grantable names are compared loosely", () => {
	const variants = ["mcp_script", "McpScript", "MCPSCRIPT", "mcpScript", "Mcp", "BASH", "Power-Shell", "exit.plan.mode", "Subagent_Launch", "edit", "Write"];
	it("no key for a direct tool or a gateway tool", () => {
		for (const name of variants) {
			assert.equal(key(name), undefined, name);
			assert.equal(key("mcp", { tool: name }), undefined, name);
			assert.equal(key("mcp", { tool: name, server: "docs" }), undefined, name);
		}
	});
	it("parseGrantKey refuses them", () => {
		for (const name of variants) {
			for (const entry of [`Tool(${name})`, `Mcp(${name})`, `Mcp(docs/${name})`]) {
				const parsed = parseGrantKey(entry);
				assert.ok(parsed !== undefined && "error" in parsed, entry);
			}
		}
	});
});

describe("deny and ask matching is broad", () => {
	const m = (rule: string, tool: string, input: unknown = {}): boolean => toolRuleMatches(rule, tool, input);
	it("Mcp(s/x) matches the reshaped calls", () => {
		const rule = "Mcp(s/rm)";
		assert.equal(m(rule, "mcp", { tool: "rm", server: "s" }), true);
		assert.equal(m(rule, "mcp", { tool: "rm" }), true);
		assert.equal(m(rule, "mcp", { tool: "rm", server: "S" }), true);
		assert.equal(m(rule, "mcp", { tool: "RM", server: "s" }), true);
		assert.equal(m(rule, "mcp", { tool: "rm", server: "s", connect: "x" }), true);
		assert.equal(m(rule, "mcp", { tool: "rm", server: "s", action: "x", extra: 1 }), true);
		for (const sep of ["_", "-", ".", ":"]) {
			assert.equal(m(rule, "mcp", { tool: `s${sep}rm` }), true, sep);
			assert.equal(m(rule, `s${sep}rm`), true, sep);
			assert.equal(m(rule, `S${sep}RM`), true, sep);
		}
		assert.equal(m(rule, "mcp", { tool: "rm", server: "other" }), false);
		assert.equal(m(rule, "mcp", { tool: "ls", server: "s" }), false);
		assert.equal(m(rule, "rm"), false);
	});
	it("Mcp(x) matches tool x with any server; catalog and Tool rules", () => {
		assert.equal(m("Mcp(rm)", "mcp", { tool: "rm", server: "any" }), true);
		assert.equal(m("Mcp(rm)", "mcp", { tool: "rm" }), true);
		assert.equal(m("Mcp(s/catalog)", "mcp", { search: "x" }), true);
		assert.equal(m("Mcp(s/catalog)", "mcp", { search: "x", server: "s" }), true);
		assert.equal(m("Mcp(s/catalog)", "mcp", { search: "x", server: "t" }), false);
		assert.equal(m("Mcp(catalog)", "mcp", { describe: "x", server: "t" }), true);
		assert.equal(m("Tool(Docs_Drop)", "docs_drop"), true);
		assert.equal(m("Tool(docs_drop)", "mcp", { tool: "docs_drop" }), false);
	});
	it("allow matching stays exact", () => {
		assert.equal(key("mcp", { tool: "x" }), "Mcp(x)");
		assert.notEqual(key("mcp", { tool: "x" }), "Mcp(s/x)");
	});
});
