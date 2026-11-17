/**
 * Tests for the permission telemetry payloads. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	logChoice,
	logDecision,
	logPattern,
	logPlanApproval,
	logRulesReview,
	logSession,
	targetOf,
	TELEMETRY_ENTRY,
	TARGET_LIMIT,
	TEXT_LIMIT,
} from "../../extensions/telemetry.ts";

function fakePi(): { pi: ExtensionAPI; entries: Array<{ type: string; data: Record<string, unknown> }> } {
	const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
	const pi = {
		appendEntry(type: string, data: Record<string, unknown>) {
			entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, entries };
}

test("logDecision records phase, mode, action and matcher", () => {
	const { pi, entries } = fakePi();
	logDecision(pi, "decide", "call-1", { toolName: "bash", input: { command: "npm test" } }, "default", { action: "ask" });
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, TELEMETRY_ENTRY);
	assert.deepEqual(entries[0].data, {
		phase: "decide",
		toolCallId: "call-1",
		tool: "bash",
		mode: "default",
		target: "npm test",
		action: "ask",
		matcher: null,
	});
});

test("logDecision records how long the decision took when the caller timed it", () => {
	const { pi, entries } = fakePi();
	logDecision(pi, "decide", "call-1", { toolName: "bash", input: { command: "npm test" } }, "default", { action: "allow" }, 0.123456);
	assert.equal(entries[0].data.decideMs, 0.123);
	// absent, not 0: an untimed decision must not look like a fast one
	const untimed = fakePi();
	logDecision(untimed.pi, "decide", "call-2", { toolName: "bash", input: { command: "npm test" } }, "default", { action: "allow" });
	assert.equal("decideMs" in untimed.entries[0].data, false);
});

/** The logged target of a bash command, as the session log stores it. */
function loggedCommand(command: string): string {
	const { pi, entries } = fakePi();
	logDecision(pi, "decide", "call-1", { toolName: "bash", input: { command } }, "default", { action: "ask" });
	return entries[0].data.target as string;
}

test("secrets in a logged bash command are replaced with ***, the rest of the command is kept", () => {
	assert.equal(loggedCommand('curl -H "Authorization: Bearer abc123" https://api.example.test/x'), 'curl -H "Authorization: ***" https://api.example.test/x');
	assert.equal(loggedCommand("curl -H 'Authorization: token ghp_9' -s https://h"), "curl -H 'Authorization: ***' -s https://h");
	assert.equal(loggedCommand('curl -H "X-Trace: 1" -H "Authorization: Basic dXNlcg==" url'), 'curl -H "X-Trace: 1" -H "Authorization: ***" url');
	assert.equal(loggedCommand("echo Bearer xyz.123 done"), "echo Bearer *** done");
	assert.equal(loggedCommand("gh api --token=ghp_123 repos/x"), "gh api --token=*** repos/x");
	assert.equal(loggedCommand("mytool --password hunter2 run"), "mytool --password *** run");
	assert.equal(loggedCommand('tool --api-key "a b c" go'), 'tool --api-key *** go');
	assert.equal(loggedCommand("API_KEY=sk-123 npm test"), "API_KEY=*** npm test");
	assert.equal(loggedCommand('GITHUB_TOKEN="a b" make'), "GITHUB_TOKEN=*** make");
	// not credentials: kept as written
	assert.equal(loggedCommand('git commit --author="Jane <j@x>" -m msg'), 'git commit --author="Jane <j@x>" -m msg');
	assert.equal(loggedCommand("npm test --coverage PATH=/usr/bin npm run build"), "npm test --coverage PATH=/usr/bin npm run build");
	// a flag with no value is not given the next flag as one
	assert.equal(loggedCommand("tool --token --verbose"), "tool --token --verbose");
});

test("redaction happens before the length limit, so a secret at the end of a long command is hidden", () => {
	const target = loggedCommand(`${"x".repeat(400)} --token=abc999`);
	assert.doesNotMatch(target, /abc999/);
	assert.match(target, /--token=\*\*\*$/);
});

test("the pattern and plan commands written to the log are redacted too", () => {
	const { pi, entries } = fakePi();
	logPattern(pi, "call-1", "curl -H Authorization:xyz *", "project");
	logPlanApproval(pi, "call-2", ["execute-auto"], "execute-auto", "execute-auto", ["gh --token=ghp_1 x"]);
	assert.equal(entries[0].data.pattern, "curl -H Authorization:*** *");
	assert.deepEqual(entries[1].data.commands, ["gh --token=*** x"]);
});

test("logSession records the model and the prompt version once per session", () => {
	const { pi, entries } = fakePi();
	logSession(pi, { model: "anthropic/claude", promptVersion: "abc123" });
	assert.deepEqual(entries[0].data, { phase: "session", model: "anthropic/claude", promptVersion: "abc123" });
	logSession(pi, { model: null, promptVersion: "abc123" });
	assert.equal(entries[1].data.model, null);
});

test("logDecision truncates long commands keeping head and tail, and names the matcher", () => {
	const { pi, entries } = fakePi();
	const long = "cd /tmp && echo " + "x".repeat(400) + " | tee out.txt";
	logDecision(pi, "redecide", "call-2", { toolName: "bash", input: { command: long } }, "auto", {
		action: "ask",
		rule: { tools: ["bash"], match: "dangerousBash", action: "ask" },
	});
	const data = entries[0].data;
	assert.equal(data.phase, "redecide");
	assert.equal(data.matcher, "dangerousBash");
	const target = String(data.target);
	assert.ok(target.startsWith("cd /tmp && echo "));
	assert.ok(target.endsWith("| tee out.txt"));
	assert.ok(target.includes("…[+"));
	assert.ok(target.length <= TARGET_LIMIT + 20);
});

test("targetOf: command for bash, path for file tools, JSON otherwise", () => {
	assert.equal(targetOf({ toolName: "bash", input: { command: "ls" } }), "ls");
	assert.equal(targetOf({ toolName: "edit", input: { path: "src/index.ts" } }), "src/index.ts");
	assert.equal(targetOf({ toolName: "web_search", input: { query: "x" } }), '{"query":"x"}');
});

test("logChoice records options, choice, outcome and extras, bounded", () => {
	const { pi, entries } = fakePi();
	logChoice(pi, {
		toolCallId: "call-3",
		tool: "bash",
		mode: "default",
		target: "git commit -m " + "y".repeat(400),
		matcher: null,
		options: { primary: ["Yes", "Allow " + "z".repeat(300) + " for this session", "No"], secondary: [] },
		choice: null,
		outcome: "reject-feedback",
		waitMs: 4321,
		feedback: "f".repeat(300),
	});
	const data = entries[0].data;
	assert.equal(data.phase, "choice");
	assert.equal(data.outcome, "reject-feedback");
	assert.equal(data.choice, null);
	assert.equal(data.waitMs, 4321);
	assert.ok(String(data.target).length <= TARGET_LIMIT + 20);
	assert.ok((data.options as { primary: string[] }).primary[1].length <= 161);
	assert.ok(String(data.feedback).length <= TEXT_LIMIT + 20);
});

test("logPattern, logPlanApproval and logRulesReview shapes", () => {
	const { pi, entries } = fakePi();
	logPattern(pi, "call-4", "git commit *", "project");
	logPlanApproval(pi, "call-5", ["Yes, execute in auto mode", "No, keep planning"], "No, keep planning", "keep-planning", ["npm test"], "add tests first");
	logRulesReview(pi, "load", 3);
	assert.deepEqual(entries[0].data, { phase: "pattern", toolCallId: "call-4", pattern: "git commit *", scope: "project" });
	assert.deepEqual(entries[1].data, {
		phase: "plan",
		toolCallId: "call-5",
		options: ["Yes, execute in auto mode", "No, keep planning"],
		choice: "No, keep planning",
		outcome: "keep-planning",
		commands: ["npm test"],
		feedback: "add tests first",
	});
	assert.deepEqual(entries[2].data, { phase: "rules-review", choice: "load", rules: 3 });
});

test("a failing appendEntry never breaks the permission flow", () => {
	const pi = {
		appendEntry() {
			throw new Error("no session");
		},
	} as unknown as ExtensionAPI;
	assert.doesNotThrow(() => {
		logDecision(pi, "decide", "call-6", { toolName: "bash", input: { command: "ls" } }, "default", { action: "allow" });
		logChoice(pi, {
			toolCallId: "call-6",
			tool: "bash",
			mode: "default",
			target: "ls",
			matcher: null,
			options: { primary: [], secondary: [] },
			choice: null,
			outcome: "reject",
			waitMs: 0,
		});
	});
});
