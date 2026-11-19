/**
 * Builds a synthetic session tree for the replay tests: a parent session, one foreground child, one
 * background child with its meta files, and the background asks the parent answered. Synthetic only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const at = (n: number) => new Date(T0 + n * 1000).toISOString();

/** The telemetry shrink: head 120, tail 80, `…[+N]…` between. */
export function shrinkTarget(text: string): string {
	return text.length <= 200 ? text : `${text.slice(0, 120)}…[+${text.length - 200}]…${text.slice(-80)}`;
}

export const LONG_COMMAND = `npm install ${Array.from({ length: 40 }, (_, i) => `pkg-number-${i}`).join(" ")}`;
export const PAIRED_COMMAND = "rm -rf ./build";
export const AMBIGUOUS_COMMAND = "rm -rf ./dist";
export const MISSING_COMMAND = "rm -rf ./cache";

export interface Tree {
	root: string;
	parent: string;
	project: string;
}

const line = (value: unknown) => JSON.stringify(value);
const tel = (n: number, data: Record<string, unknown>) => line({ type: "custom", customType: "pi-keeper-permission", timestamp: at(n), data });
const call = (n: number, id: string, command: string) => line({ type: "message", timestamp: at(n), message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } });

export function buildTree(root: string): Tree {
	const sessions = join(root, "sessions");
	const artifacts = join(sessions, "subagent-artifacts");
	const project = join(root, "project");
	mkdirSync(project, { recursive: true });
	mkdirSync(artifacts, { recursive: true });
	const scratch = join(root, "scratch-dir");
	const parent = join(sessions, "parent.jsonl");
	const decide = (n: number, id: string, command: string, action: string, matcher: string | null, phase = "decide", mode = "default") =>
		tel(n, { phase, toolCallId: id, tool: "bash", mode, target: shrinkTarget(command), action, matcher });
	const choice = (n: number, id: string, command: string, extra: Record<string, unknown>) =>
		tel(n, { phase: "choice", toolCallId: id, tool: "bash", mode: "default", target: shrinkTarget(command), matcher: null, options: { primary: [], secondary: [] }, ...extra });

	writeFileSync(
		parent,
		[
			line({ type: "session", id: "parent-id", cwd: project, timestamp: at(0) }),
			line({ type: "custom_message", customType: "pi-keeper-mode", timestamp: at(0), content: `Scratch dir: ${scratch}\nYou may create files there.` }),
			call(1, "p1", "ls -la"),
			decide(1, "p1", "ls -la", "allow", "readOnlyBash"),
			call(2, "p2", LONG_COMMAND),
			decide(2, "p2", LONG_COMMAND, "ask", null),
			choice(3, "p2", LONG_COMMAND, { choice: "Yes, and always allow npm install", outcome: "remember-session", waitMs: 1200, remembered: "npm install *" }),
			call(10, "p3", "npm install left-pad"),
			decide(10, "p3", "npm install left-pad", "ask", null),
			// a relayed ask of the foreground child, answered in this session
			choice(21, "c1", "mkdir newdir", { choice: "Yes", outcome: "allow-once", waitMs: 800, via: "child-relay" }),
			// background asks: keyed by a request id that is no tool call
			tel(29, { phase: "remote-mode", toolCallId: "req-1", claimed: "default", mode: "default" }),
			decide(30, "req-1", PAIRED_COMMAND, "ask", null, "redecide"),
			choice(31, "req-1", PAIRED_COMMAND, { choice: "allow/user", outcome: "remote-allowed", waitMs: 500, via: "background" }),
			decide(32, "req-2", AMBIGUOUS_COMMAND, "ask", null, "redecide"),
			decide(33, "req-3", MISSING_COMMAND, "ask", null, "redecide"),
		].join("\n") + "\n",
	);

	const fg = join(sessions, "parent", "dir1", "run-0");
	mkdirSync(fg, { recursive: true });
	writeFileSync(
		join(fg, "session.jsonl"),
		[
			line({ type: "session", id: "fg-id", cwd: project, timestamp: at(19) }),
			line({ type: "session_info", name: "subagent-worker-run-fg-0", timestamp: at(19) }),
			call(20, "c1", "mkdir newdir"),
			decide(20, "c1", "mkdir newdir", "ask", null),
		].join("\n") + "\n",
	);
	writeFileSync(join(artifacts, "run-fg_meta.json"), JSON.stringify({ runId: "run-fg", parentSessionId: "parent-id", agent: "worker" }));

	const transcript = join(artifacts, "run-bg_worker_transcript.jsonl");
	const start = (n: number, id: string, command: string) => line({ recordType: "tool_start", ts: at(n), toolCallId: id, toolName: "bash", argsPreview: command.slice(0, 40), argsPayload: { command } });
	writeFileSync(transcript, [start(25, "t1", PAIRED_COMMAND), start(26, "t2", AMBIGUOUS_COMMAND), start(27, "t3", AMBIGUOUS_COMMAND)].join("\n") + "\n");
	writeFileSync(join(artifacts, "run-bg_meta.json"), JSON.stringify({ runId: "run-bg", parentSessionId: "parent-id", agent: "worker", transcriptPath: transcript, cwd: project }));

	return { root, parent, project };
}
