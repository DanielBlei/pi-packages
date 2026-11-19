/**
 * Grant sharing, as a matrix: every permission the user grants reaches every
 * subagent, and a grant given while one subagent asks covers its siblings.
 * Grant kinds x paths, each cell checking that the second call raises no dialog.
 *
 * Paths (answerer -> the call that must not ask again):
 *   parent -> foreground child   (live, through the UI relay)
 *   parent -> background child   (through the published snapshot)
 *   fg child A -> fg child B     (relayed dialog answer, shared list)
 *   bg child A -> bg child B     (answered in the parent, then the snapshot)
 *   fg child -> bg sibling, and the reverse
 *
 * Deliberate exception, pinned at the end: the parent's own verbatim grant ("this
 * exact command this session") is never published to a child. A child's
 * exact-command answer is stored as an exact pattern in the shared list instead.
 * Run: npm run test:integration
 */
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, restoreBell, startPi, type Harness, type Sandbox } from "../mocks/pi.ts";
import { BACKGROUND_ASKS_ENV } from "../../extensions/config.ts";
import { PARENT_SESSION_ENV } from "../../extensions/session-grants.ts";
import { RELAY_KEY } from "../../extensions/ui-relay.ts";

after(() => restoreBell());

const TMPDIR = process.env.TMPDIR;
const created: Sandbox[] = [];
after(() => {
	for (const sandbox of created) sandbox.cleanup();
});

function sandboxed(): Sandbox {
	// startPi points TMPDIR into the previous sandbox; put it back so this one can be created
	if (TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = TMPDIR;
	const sandbox = makeSandbox();
	created.push(sandbox);
	mkdirSync(join(sandbox.cwd, "data"), { recursive: true });
	writeFileSync(join(sandbox.cwd, "data", "a.json"), "{}");
	writeFileSync(join(sandbox.cwd, "data", "b.json"), "{}");
	return sandbox;
}

// the relay registry and two env vars are process-global: leave them as found
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

type Role = "parent" | "fg" | "bg";
interface Actor {
	role: Role;
	h: Harness;
}

interface World {
	sb: Sandbox;
	parent: Harness;
	relay: unknown;
	make(role: Role): Promise<Actor>;
	run(actor: Actor, tool: string, input: Record<string, unknown>): Promise<{ blocked: boolean; reason?: string }>;
}

const until = async (done: () => boolean): Promise<void> => {
	for (let i = 0; i < 1200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

async function world(): Promise<World> {
	const sb = sandboxed();
	const parent = await startPi({ sandbox: sb });
	started.push(parent);
	await parent.session();
	const relay = root[RELAY_KEY];
	return {
		sb,
		parent,
		relay,
		async make(role) {
			if (role === "parent") return { role, h: parent };
			if (role === "fg") {
				const h = await startPi({ sandbox: sb, entry: "child-default" });
				started.push(h);
				await h.session();
				return { role, h };
			}
			// a background child: another process, so no relay; told its parent session; quick polls
			delete root[RELAY_KEY];
			process.env[PARENT_SESSION_ENV] = parent.sessionId;
			try {
				const h = await startPi({ sandbox: sb, entry: "child-default", remoteRelay: { pollMs: 5, timeoutMs: 5_000 } });
				started.push(h);
				await h.session();
				return { role, h };
			} finally {
				root[RELAY_KEY] = relay;
			}
		},
		async run(actor, tool, input) {
			if (actor.role !== "bg") return actor.h.tool(tool, input);
			// in the runner process there is no relay; the parent's ask timer is stepped by hand while the child waits
			delete root[RELAY_KEY];
			try {
				let done = false;
				const call = actor.h.tool(tool, input).finally(() => {
					done = true;
				});
				await until(() => {
					parent.pollAsks();
					return done;
				});
				return await call;
			} finally {
				root[RELAY_KEY] = relay;
			}
		},
	};
}

interface Kind {
	name: string;
	/** The dialog's choice that grants it for the session (or the project). */
	choice: RegExp;
	/** Prepares fixtures; returns the first (asking) call and a second call the grant must cover. */
	calls(sb: Sandbox): { first: [string, Record<string, unknown>]; second: [string, Record<string, unknown>] };
	/** Only a child's answer shares it (the parent's own verbatim grant is the deliberate exception). */
	childAnswerOnly?: boolean;
	/** The choice sits behind "More…" in the parent's and a foreground child's dialog (a background ask lists it up front). */
	viaMore?: boolean;
	/** Extra check after the grant, e.g. the project file. */
	after?: (sb: Sandbox) => void;
}

const editCall = (path: string): [string, Record<string, unknown>] => ["edit", { path, edits: [{ oldText: "one", newText: "two" }] }];

/** Outside the project: two directories with a file each. */
function outside(sb: Sandbox): { one: string; two: string } {
	const base = realpathSync(sb.root);
	const one = mkdtempSync(join(base, "out-one-"));
	const two = mkdtempSync(join(base, "out-two-"));
	writeFileSync(join(one, "a.md"), "x");
	writeFileSync(join(one, "b.md"), "x");
	writeFileSync(join(two, "c.md"), "x");
	return { one, two };
}

function repo(dir: string): string {
	mkdirSync(join(dir, ".git"), { recursive: true });
	mkdirSync(join(dir, "src"), { recursive: true });
	return dir;
}

const kinds: Kind[] = [
	{
		name: "session command prefix",
		choice: /^Yes, and don't ask again for `npm test` this session/,
		calls: () => ({ first: ["bash", { command: "npm test" }], second: ["bash", { command: "npm test" }] }),
	},
	{
		name: "child's exact-command pattern",
		choice: /^Yes, and don't ask again for this exact command this session/,
		childAnswerOnly: true,
		calls: () => ({ first: ["bash", { command: "python3 x.py" }], second: ["bash", { command: "python3 x.py" }] }),
	},
	{
		name: "edits flag",
		choice: /^Yes, allow all edits this session/,
		calls: () => ({ first: editCall("src/a.ts"), second: editCall("src/b.ts") }),
	},
	{
		name: "all outside reads",
		choice: /^Yes, allow reads outside the working directory for this session/,
		viaMore: true,
		calls: (sb) => {
			const { one, two } = outside(sb);
			return { first: ["read", { path: join(one, "a.md") }], second: ["read", { path: join(two, "c.md") }] };
		},
	},
	{
		name: "outside read dir",
		choice: /^Yes, and allow reading from .* this session/,
		calls: (sb) => {
			const { one } = outside(sb);
			return { first: ["read", { path: join(one, "a.md") }], second: ["read", { path: join(one, "b.md") }] };
		},
	},
	{
		name: "fetch host",
		choice: /^Yes, and allow fetching from pypi\.org this session/,
		calls: () => ({
			first: ["bash", { command: "curl -s https://pypi.org/simple/requests/" }],
			second: ["bash", { command: "curl -s https://pypi.org/pypi/x/json" }],
		}),
	},
	{
		name: "git repo",
		choice: /^Yes, and allow git in .* this session/,
		calls: (sb) => {
			const harbor = repo(join(realpathSync(sb.tmp), "harbor"));
			return {
				first: ["bash", { command: `cd ${harbor} && git log --oneline -5; echo x; find . -maxdepth 2 -type d 2>/dev/null | head` }],
				second: ["bash", { command: `git -C ${harbor} log --oneline -3` }],
			};
		},
	},
	{
		name: "loop-globs",
		choice: /^Yes, and allow loops over globs this session/,
		calls: () => ({
			first: ["bash", { command: 'for f in data/*.json; do cat "$f"; done' }],
			second: ["bash", { command: 'for f in data/*.json; do head -n 1 "$f"; done' }],
		}),
	},
	{
		name: "tool grant (Tool(x))",
		choice: /^Yes, and don't ask again for `Tool\(docs_lookup\)` this session/,
		calls: () => ({ first: ["docs_lookup", { id: "1" }], second: ["docs_lookup", { id: "2" }] }),
	},
	{
		name: "gateway tool grant (Mcp(server/tool))",
		choice: /^Yes, and don't ask again for `Mcp\(docs\/search\)` this session/,
		calls: () => ({
			first: ["mcp", { tool: "search", server: "docs", args: { q: "x" } }],
			second: ["mcp", { tool: "search", server: "docs", args: { q: "other" } }],
		}),
	},
	{
		name: "python while",
		choice: /^Yes, and allow python `while` loops this session/,
		calls: () => ({
			first: ["bash", { command: "python3 - <<'PYEOF'\nn = 3\nwhile n:\n    n -= 1\nprint(n)\nPYEOF" }],
			second: ["bash", { command: "python3 - <<'PYEOF'\ntotal = 0\nwhile total < 5:\n    total += 2\nprint(total)\nPYEOF" }],
		}),
	},
	{
		name: "project rule (always allow in this project)",
		choice: /^Yes, and always allow `npm test` in this project/,
		calls: () => ({ first: ["bash", { command: "npm test" }], second: ["bash", { command: "npm test" }] }),
		after: (sb) => assert.match(readFileSync(join(sb.cwd, ".pi", "settings.local.json"), "utf8"), /Bash\(npm test/),
	},
];

const paths: Array<[Role, Role]> = [
	["parent", "fg"],
	["parent", "bg"],
	["fg", "fg"],
	["bg", "bg"],
	["fg", "bg"],
	["bg", "fg"],
];

/** Cells where today's code does not share the kind: name -> the gap. */
const GAPS: Record<string, string> = {};

describe("a grant reaches every subagent, whoever answered", () => {
	for (const kind of kinds) {
		for (const [answerer, second] of paths) {
			if (kind.childAnswerOnly && answerer === "parent") continue; // the verbatim exception, pinned below
			const name = `${kind.name}: ${answerer} -> ${second}`;
			const gap = GAPS[name];
			const body = async (): Promise<void> => {
				const w = await world();
				const { first, second: next } = kind.calls(w.sb);
				// the sibling is already running when the grant is made
				const b = await w.make(second);
				const a = answerer === "parent" ? await w.make("parent") : await w.make(answerer);
				if (kind.viaMore === true && answerer !== "bg") w.parent.answer(/./s, "More…");
				w.parent.answer(/./s, kind.choice);
				const granted = await w.run(a, first[0], first[1]);
				assert.equal(granted.blocked, false, `the granting call: ${granted.reason ?? ""}`);
				w.parent.assertNoPendingAnswers();
				kind.after?.(w.sb);
				const dialogs = w.parent.dialogs.length;
				const outcome = await w.run(b, next[0], next[1]);
				assert.equal(outcome.blocked, false, `the second call: ${outcome.reason ?? ""}`);
				assert.equal(w.parent.dialogs.length, dialogs, "no dialog for the second call");
				if (b.role !== "parent") assert.equal(b.h.dialogs.length, 0);
			};
			if (gap === undefined) it(name, body);
			else it.todo(`${name} (gap: ${gap})`);
		}
	}
});

describe("the verbatim exception: the parent's own exact-command grant asks in every child", () => {
	for (const role of ["fg", "bg"] as const) {
		it(`parent verbatim grant -> ${role} child still asks`, async () => {
			const w = await world();
			const child = await w.make(role);
			w.parent.answer(/Permission required/, "Yes, and don't ask again for this exact command this session");
			assert.equal((await w.parent.tool("bash", { command: "python3 x.py" })).blocked, false);
			assert.equal((await w.parent.tool("bash", { command: "python3 x.py" })).blocked, false, "the parent itself is covered");
			assert.equal(w.parent.dialogs.length, 1);
			w.parent.answer(/Permission required/, "esc");
			const outcome = await w.run(child, "bash", { command: "python3 x.py" });
			assert.equal(outcome.blocked, true);
			assert.equal(w.parent.dialogs.length, 2, "the child's ask reached the parent's user");
			w.parent.assertNoPendingAnswers();
		});
	}
});
