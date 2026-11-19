/**
 * Replay recorded bash decisions against a code tree (dev-only; not in the npm package).
 *
 *   node scripts/replay.ts run --session <parent.jsonl> --code <tree> [--out <file>] [--agent-dir <dir>]
 *   node scripts/replay.ts compare <old.jsonl> <new.jsonl> [--fixture <path>] [--code-old <tree>] [--code-new <tree>]
 *
 * `<tree>` is a pi-keeper package directory (the working tree, or a baseline export holding
 * extensions/, prompts/ and package.json). `run` is one process per tree; `compare` is a third.
 *
 * The decision context is rebuilt from the log alone: the mode of the telemetry row, the cwd of the
 * session header, NO session grants (they are not in the log), project rules loaded from the cwd when
 * it exists. A second, labelled count adds the prefix grants parsed from recorded choices.
 *
 * Privacy: the output holds keys, modes and rule names, never a command. `--out` inside a git
 * repository is refused. Terminal output never prints more than one line per command-derived text.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModeName } from "../extensions/modes.ts";
import type { EvalContext, ToolCall } from "../extensions/rules.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TELEMETRY_TYPE = "pi-keeper-permission";
const DECISION_PHASES = new Set(["decide", "redecide"]);
const MODE_NAMES: readonly string[] = ["default", "auto", "plan"];

type Rec = Record<string, unknown>;
type Origin = "parent" | "fg-child" | "bg-child";

interface Api {
	rules: typeof import("../extensions/rules.ts");
	modes: typeof import("../extensions/modes.ts");
	utils: typeof import("../extensions/utils.ts");
	projectRules: typeof import("../extensions/project-rules.ts");
	telemetry: typeof import("../extensions/telemetry.ts");
}

/** The decision API a fixture `judge` receives. */
function decisionApi(api: Api) {
	return {
		evaluate: api.rules.evaluate,
		MODES: api.modes.MODES,
		GLOBAL_RULES: api.modes.GLOBAL_RULES,
		approvalBreakdown: api.utils.approvalBreakdown,
		formatBreakdown: api.utils.formatBreakdown,
		isReadOnlyCommand: api.utils.isReadOnlyCommand,
		/** The dialog's Why lines; absent in a tree that predates `bashWhy` (the breakdown stands in). */
		bashWhy: api.rules.bashWhy as typeof import("../extensions/rules.ts").bashWhy | undefined,
	};
}

async function loadTree(tree: string): Promise<Api> {
	const load = (name: string) => import(pathToFileURL(join(resolve(tree), "extensions", `${name}.ts`)).href);
	const [rules, modes, utils, projectRules, telemetry] = await Promise.all([load("rules"), load("modes"), load("utils"), load("project-rules"), load("telemetry")]);
	return { rules, modes, utils, projectRules, telemetry };
}

// ---------------------------------------------------------------------------
// Session reading (ports scripts/extract_flow.py: load_session, load_children, parse_transcript)
// ---------------------------------------------------------------------------

interface Call {
	id: string;
	tool: string;
	command: string | undefined;
	ts: number;
}

interface Session {
	path: string;
	id: string;
	cwd: string;
	name: string;
	telemetry: Rec[];
	calls: Map<string, Call>;
	/** Text of custom and user messages, searched for the `Scratch dir:` line. */
	texts: string[];
}

function parseTs(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? 0 : ms;
	}
	return 0;
}

function readJsonl(path: string): Rec[] {
	const out: Rec[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (value !== null && typeof value === "object" && !Array.isArray(value)) out.push(value as Rec);
		} catch {
			// a torn line is skipped, as the python reader does
		}
	}
	return out;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block !== null && typeof block === "object" && (block as Rec).type === "text" ? String((block as Rec).text ?? "") : "")).join("\n");
}

function loadSession(path: string): Session {
	const session: Session = { path, id: "", cwd: "", name: "", telemetry: [], calls: new Map(), texts: [] };
	for (const entry of readJsonl(path)) {
		const ts = parseTs(entry.timestamp);
		const kind = entry.type;
		if (kind === "session") {
			session.id = String(entry.id ?? "");
			session.cwd = String(entry.cwd ?? "");
		} else if (kind === "session_info") {
			if (typeof entry.name === "string" && entry.name !== "") session.name = entry.name;
		} else if (kind === "custom") {
			if (entry.customType === TELEMETRY_TYPE && entry.data !== null && typeof entry.data === "object") session.telemetry.push({ ...(entry.data as Rec), _ts: ts });
		} else if (kind === "custom_message") {
			session.texts.push(textOf(entry.content));
		} else if (kind === "message") {
			const message = (entry.message ?? {}) as Rec;
			if (message.role === "user" || message.customType !== undefined) session.texts.push(textOf(message.content));
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content as Rec[]) {
					if (block === null || typeof block !== "object" || block.type !== "toolCall") continue;
					const args = block.arguments !== null && typeof block.arguments === "object" ? (block.arguments as Rec) : {};
					const id = String(block.id ?? "");
					session.calls.set(id, { id, tool: String(block.name ?? "?"), command: typeof args.command === "string" ? args.command : undefined, ts });
				}
			}
		}
	}
	return session;
}

/** A pi-subagents transcript of an async child: bash calls from `tool_start` records (full command from argsPayload). */
function parseTranscript(path: string): Call[] {
	const calls: Call[] = [];
	for (const record of readJsonl(path)) {
		if (record.recordType !== "tool_start") continue;
		const payload = record.argsPayload !== null && typeof record.argsPayload === "object" ? (record.argsPayload as Rec) : {};
		const command = typeof payload.command === "string" ? payload.command : typeof record.argsPreview === "string" ? record.argsPreview : undefined;
		calls.push({ id: String(record.toolCallId ?? ""), tool: String(record.toolName ?? "?"), command, ts: parseTs(record.ts ?? record.timestamp) });
	}
	return calls;
}

interface ChildRun {
	runId: string;
	meta: Rec;
	source: "session" | "transcript";
	session?: Session;
	calls?: Call[];
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/** Direct children of one parent session: foreground (nested session files) and background (artifact transcripts). */
function loadChildren(parent: Session): ChildRun[] {
	if (!parent.path.endsWith(".jsonl") || parent.id === "") return [];
	const artifacts = join(dirname(parent.path), "subagent-artifacts");
	const metas = new Map<string, Rec>();
	for (const file of listDir(artifacts)) {
		if (!file.endsWith("_meta.json")) continue;
		try {
			const meta = JSON.parse(readFileSync(join(artifacts, file), "utf8")) as Rec;
			if (meta !== null && typeof meta === "object" && String(meta.parentSessionId ?? "") === parent.id && String(meta.runId ?? "") !== "") metas.set(String(meta.runId), meta);
		} catch {
			// unreadable meta: not ours
		}
	}
	const children: ChildRun[] = [];
	const seen = new Set<string>();
	const nested = parent.path.slice(0, -".jsonl".length);
	for (const dirId of listDir(nested)) {
		for (const run of listDir(join(nested, dirId))) {
			const file = join(nested, dirId, run, "session.jsonl");
			if (!run.startsWith("run-") || !existsSync(file)) continue;
			const session = loadSession(file);
			// the directory id and the artifacts runId differ: the child's display name carries the runId
			let meta = metas.get(dirId);
			if (meta === undefined) for (const [runId, candidate] of metas) if (session.name.includes(runId)) meta = candidate;
			const runId = String(meta?.runId ?? dirId);
			children.push({ runId, meta: meta ?? {}, source: "session", session });
			seen.add(runId);
		}
	}
	for (const [runId, meta] of [...metas].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (seen.has(runId)) continue;
		let transcript = String(meta.transcriptPath ?? "");
		if (transcript === "" || !existsSync(transcript)) {
			const hit = listDir(artifacts).find((file) => file.startsWith(`${runId}_`) && file.endsWith("_transcript.jsonl"));
			transcript = hit === undefined ? "" : join(artifacts, hit);
		}
		children.push({ runId, meta, source: "transcript", calls: transcript === "" ? [] : parseTranscript(transcript) });
	}
	return children;
}

// ---------------------------------------------------------------------------
// Context pieces
// ---------------------------------------------------------------------------

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `Scratch dir: <path>` from the session's messages, else the single `<tmpdir>/pi-keeper-XXXXXX` prefix of its commands. */
export function scratchOf(texts: readonly string[], commands: readonly string[]): string | undefined {
	for (const text of texts) {
		const hit = /Scratch dir: (\S+)/.exec(text);
		if (hit !== null) return hit[1];
	}
	const prefix = new RegExp(`${escapeRegex(tmpdir())}/pi-keeper-[A-Za-z0-9]{6}`, "g");
	const found = new Set<string>();
	for (const command of commands) for (const match of command.matchAll(prefix)) found.add(match[0]);
	return found.size === 1 ? [...found][0] : undefined;
}

/** Prefix token arrays from a recorded `remembered` string of the "tok tok *, tok *" form; other forms yield none. */
export function parsePrefixGrants(remembered: unknown): string[][] {
	if (typeof remembered !== "string") return [];
	const out: string[][] = [];
	for (const part of remembered.split(", ")) {
		const hit = /^(\S+(?: \S+)*) \*$/.exec(part.trim());
		if (hit !== null) out.push(hit[1].split(" "));
	}
	return out;
}

function envFingerprint(projectRules: boolean) {
	const names = createHash("sha256").update(Object.keys(process.env).sort().join("\n")).digest("hex").slice(0, 12);
	return { node: process.version, platform: process.platform, tmpdir: tmpdir(), envNames: names, projectRules };
}

/** A recorded target is the full text, or `head…[+N]…tail` (telemetry shrinkMiddle: limit 200, head 120). */
export function targetMatches(full: string, recorded: string): boolean {
	if (full === recorded) return true;
	const hit = /^([\s\S]{120})…\[\+(\d+)\]…([\s\S]*)$/.exec(recorded);
	if (hit === null) return false;
	return full.length === 120 + Number(hit[2]) + hit[3].length && full.startsWith(hit[1]) && full.endsWith(hit[3]);
}

// ---------------------------------------------------------------------------
// Decisions to replay
// ---------------------------------------------------------------------------

interface Recorded {
	action: string;
	matcher: string | null;
	choice?: string | null;
	waitMs?: number;
}

interface Item {
	key: string;
	origin: Origin;
	mode: string;
	cwd: string;
	scratch: string | undefined;
	command: string;
	recorded: Recorded;
	ts: number;
	/** Background asks: the parent stage, judged with no scratch dir in the child's cwd. */
	parentStage?: { mode: string };
	/** Grants recorded in a choice of this item's own session (time-ordered pool key). */
	pool: string;
}

interface Grant {
	ts: number;
	prefixes: string[][];
}

const bashRows = (rows: readonly Rec[]) => rows.filter((row) => row.tool === "bash" && typeof row.toolCallId === "string");

function recordedOf(rows: readonly Rec[]): Recorded {
	let decide: Rec | undefined;
	let choice: Rec | undefined;
	for (const row of [...rows].sort((a, b) => Number(a._ts) - Number(b._ts))) {
		if (DECISION_PHASES.has(String(row.phase))) decide = row;
		else if (row.phase === "choice") choice = row;
	}
	const base = decide ?? choice;
	const out: Recorded = { action: decide !== undefined ? String(decide.action) : "ask", matcher: typeof base?.matcher === "string" ? base.matcher : null };
	if (choice !== undefined) {
		out.choice = typeof choice.choice === "string" ? choice.choice : null;
		if (typeof choice.waitMs === "number") out.waitMs = choice.waitMs;
	}
	return out;
}

function groupById(rows: readonly Rec[]): Map<string, Rec[]> {
	const map = new Map<string, Rec[]>();
	for (const row of rows) {
		const id = String(row.toolCallId);
		map.set(id, [...(map.get(id) ?? []), row]);
	}
	return map;
}

interface Collected {
	items: Item[];
	grants: Map<string, Grant[]>;
	problems: { kind: string; key: string }[];
	sessions: number;
}

function collect(parentPath: string, tree: Api["telemetry"]): Collected {
	const out: Collected = { items: [], grants: new Map(), problems: [], sessions: 1 };
	const parent = loadSession(parentPath);
	const stem = basename(parentPath).replace(/\.jsonl$/, "");
	const children = loadChildren(parent);
	const pool = parent.id || stem;
	const fgIds = new Set<string>();
	for (const child of children) if (child.session !== undefined) for (const id of child.session.calls.keys()) fgIds.add(id);

	const addGrants = (rows: readonly Rec[]) => {
		for (const row of rows) {
			if (row.phase !== "choice") continue;
			const prefixes = parsePrefixGrants(row.remembered);
			if (prefixes.length > 0) out.grants.set(pool, [...(out.grants.get(pool) ?? []), { ts: Number(row._ts), prefixes }]);
		}
	};

	// the parent's own bash calls
	const parentRows = bashRows(parent.telemetry).filter((row) => ["decide", "redecide", "choice"].includes(String(row.phase)));
	addGrants(parentRows);
	const parentCommands = [...parent.calls.values()].filter((call) => call.tool === "bash" && call.command !== undefined).map((call) => call.command as string);
	const parentScratch = scratchOf(parent.texts, parentCommands);
	const byId = groupById(parentRows);
	for (const [id, rows] of byId) {
		const call = parent.calls.get(id);
		if (call === undefined || call.tool !== "bash" || call.command === undefined) continue;
		const decideRow = rows.find((row) => DECISION_PHASES.has(String(row.phase))) ?? rows[0];
		out.items.push({ key: `parent:${stem}#${id}`, origin: "parent", mode: String(decideRow.mode), cwd: parent.cwd, scratch: parentScratch, command: call.command, recorded: recordedOf(rows), ts: Number(decideRow._ts), pool });
	}

	// foreground children: their own telemetry, plus the parent's choice rows for relayed asks
	for (const child of children) {
		if (child.session === undefined) continue;
		out.sessions++;
		const session = child.session;
		const rowsAll = [...bashRows(session.telemetry), ...parentRows.filter((row) => session.calls.has(String(row.toolCallId)))].filter((row) => ["decide", "redecide", "choice"].includes(String(row.phase)));
		addGrants(rowsAll);
		const commands = [...session.calls.values()].filter((call) => call.tool === "bash" && call.command !== undefined).map((call) => call.command as string);
		const scratch = scratchOf(session.texts, commands);
		for (const [id, rows] of groupById(rowsAll)) {
			const call = session.calls.get(id);
			if (call === undefined || call.tool !== "bash" || call.command === undefined) continue;
			const decideRow = rows.find((row) => DECISION_PHASES.has(String(row.phase))) ?? rows[0];
			out.items.push({ key: `fg-child:${child.runId}#${id}`, origin: "fg-child", mode: String(decideRow.mode), cwd: session.cwd, scratch, command: call.command, recorded: recordedOf(rows), ts: Number(decideRow._ts), pool });
		}
	}

	// background asks: parent rows keyed by an ask request id that is no tool call of the parent or a foreground child
	const requests = [...groupById(parentRows)].filter(([id]) => !parent.calls.has(id) && !fgIds.has(id));
	const remoteModes = new Map<string, string>();
	for (const row of bashRowsAll(parent.telemetry)) if (row.phase === "remote-mode") remoteModes.set(String(row.toolCallId), String(row.claimed ?? ""));
	const bg = children.filter((child) => child.source === "transcript");
	const candidates = bg.flatMap((child) => (child.calls ?? []).filter((call) => call.tool === "bash" && call.command !== undefined).map((call) => ({ child, call })));
	const requestsPerTarget = new Map<string, number>();
	for (const [, rows] of requests) {
		const target = String(rows.find((row) => typeof row.target === "string")?.target ?? "");
		requestsPerTarget.set(target, (requestsPerTarget.get(target) ?? 0) + 1);
	}
	for (const [id, rows] of requests) {
		const target = String(rows.find((row) => typeof row.target === "string")?.target ?? "");
		const key = `bg-child:#${id}`;
		const hits = candidates.filter(({ call }) => targetMatches(tree.targetOf({ toolName: "bash", input: { command: call.command as string } }), target));
		if (hits.length === 0) {
			out.problems.push({ kind: "missing", key });
			continue;
		}
		if (hits.length > 1 || (requestsPerTarget.get(target) ?? 0) > 1) {
			out.problems.push({ kind: "ambiguous", key });
			continue;
		}
		const { child, call } = hits[0];
		const decideRow = rows.find((row) => DECISION_PHASES.has(String(row.phase))) ?? rows[0];
		const childCommands = (child.calls ?? []).flatMap((c) => (c.command === undefined ? [] : [c.command]));
		const claimed = remoteModes.get(id);
		const childMode = typeof child.meta.mode === "string" ? child.meta.mode : claimed !== undefined && claimed !== "" ? claimed : String(decideRow.mode);
		addGrants(rows);
		out.items.push({
			key: `bg-child:${child.runId}#${id}`,
			origin: "bg-child",
			mode: childMode,
			cwd: typeof child.meta.cwd === "string" ? child.meta.cwd : parent.cwd,
			scratch: scratchOf([], childCommands),
			command: call.command as string,
			recorded: recordedOf(rows),
			ts: Number(decideRow._ts),
			parentStage: { mode: String(decideRow.mode) },
			pool,
		});
	}
	return out;
}

function bashRowsAll(rows: readonly Rec[]): Rec[] {
	return rows.filter((row) => typeof row.toolCallId === "string");
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface Stage {
	action: string;
	rule: string;
	why?: string;
}

function oneLine(text: string, limit = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function judgeStage(api: Api, project: ReturnType<Api["projectRules"]["compilePermissions"]> | undefined, args: { mode: string; cwd: string; scratch: string | undefined; command: string; child: boolean; agentDir: string; grants: string[][] }): Stage | undefined {
	if (!MODE_NAMES.includes(args.mode)) return undefined;
	const mode = api.modes.MODES[args.mode as ModeName];
	const permissions = project ?? { allow: { prefixes: [], exact: [], verbatim: [] }, ask: [], deny: [], readDirs: [], fetchHosts: [] };
	const ctx: EvalContext = {
		cwd: args.cwd,
		scratchDir: args.scratch,
		agentDir: args.agentDir,
		outsideReadDirs: [],
		fetchHosts: permissions.fetchHosts,
		gitRepos: [],
		remembered: args.grants,
		rememberedExact: [],
		rememberedVerbatim: permissions.allow.verbatim ?? [],
		readOnlyTools: new Set(),
		outsideReadsAllowed: false,
		sessionEdits: false,
		project: permissions,
		commandGrants: { prefixes: [], exact: [] },
		subagentBridge: args.child,
		child: args.child,
	};
	const call: ToolCall = { toolName: "bash", input: { command: args.command } };
	const decision = api.rules.evaluate(mode.permissions, api.modes.GLOBAL_RULES, call, ctx);
	const stage: Stage = { action: decision.action, rule: decision.rule?.match ?? "fallback" };
	if (decision.action === "ask") {
		try {
			const lines = api.rules.bashWhy === undefined
				? api.utils.formatBreakdown(api.utils.approvalBreakdown(args.command, args.cwd, [], args.scratch, permissions.fetchHosts, []))
				: api.rules.bashWhy(args.command, ctx, []);
			if (lines.length > 0) stage.why = oneLine(lines[0]);
		} catch {
			// the breakdown is explanatory only
		}
	}
	return stage;
}

/** True when `path` lies inside a git work tree (the nearest existing ancestor chain holds a `.git`). */
export function insideGitRepo(path: string): boolean {
	let dir = resolve(path);
	while (!existsSync(dir)) dir = dirname(dir);
	dir = realpathSync(dir);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return true;
		const up = dirname(dir);
		if (up === dir) return false;
		dir = up;
	}
}

async function runCommand(opts: Map<string, string>): Promise<number> {
	const session = opts.get("session");
	const code = opts.get("code");
	if (session === undefined || code === undefined) return usage("run needs --session and --code");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const out = resolve(opts.get("out") ?? join(tmpdir(), `pi-keeper-replay-${stamp}`, "replay.jsonl"));
	if (insideGitRepo(dirname(out))) {
		console.error(`replay: refusing --out inside a git repository (${dirname(out)}); rows describe private sessions`);
		return 2;
	}
	const agentDir = resolve(opts.get("agent-dir") ?? join(process.env.HOME ?? tmpdir(), ".pi", "agent"));
	const api = await loadTree(code);
	const collected = collect(resolve(session), api.telemetry);
	const rows: unknown[] = [];
	let skipped = 0;
	let withGrants = 0;
	let projectLoaded = 0;
	const projectCache = new Map<string, { loaded: boolean; permissions?: ReturnType<Api["projectRules"]["compilePermissions"]> }>();
	const projectOf = (cwd: string) => {
		let hit = projectCache.get(cwd);
		if (hit === undefined) {
			if (existsSync(cwd) && statSync(cwd).isDirectory()) {
				const loaded = api.projectRules.loadProjectRules(cwd, agentDir);
				hit = { loaded: true, permissions: api.projectRules.compilePermissions(loaded.rules, loaded.trusted, loaded.broken) };
			} else hit = { loaded: false };
			projectCache.set(cwd, hit);
		}
		return hit;
	};
	for (const item of collected.items.sort((a, b) => a.ts - b.ts)) {
		const project = projectOf(item.cwd);
		const earlier = (collected.grants.get(item.pool) ?? []).filter((grant) => grant.ts < item.ts).flatMap((grant) => grant.prefixes);
		const run = (grants: string[][]) => {
			const base = { mode: item.mode, cwd: item.cwd, scratch: item.scratch, command: item.command, agentDir, grants };
			if (item.origin !== "bg-child") return { decided: judgeStage(api, project.permissions, { ...base, child: item.origin !== "parent" }), dialog: undefined as boolean | undefined, stages: undefined };
			// background ask: the child decides locally, then the parent judges the request (no scratch dir, the child's cwd, its own mode)
			const local = judgeStage(api, project.permissions, { ...base, child: true });
			const remote = judgeStage(api, project.permissions, { ...base, mode: item.parentStage?.mode ?? item.mode, scratch: undefined, child: true });
			if (local === undefined || remote === undefined) return { decided: undefined, dialog: undefined, stages: undefined };
			const dialog = local.action === "ask" && remote.action === "ask";
			return { decided: local.action !== "ask" ? local : remote, dialog, stages: { child: local, parent: remote } };
		};
		const plain = run([]);
		if (plain.decided === undefined) {
			skipped++;
			continue;
		}
		const dialog = plain.dialog ?? plain.decided.action === "ask";
		const granted = run(earlier);
		const dialogGranted = granted.dialog ?? granted.decided?.action === "ask";
		if (dialogGranted) withGrants++;
		if (project.loaded) projectLoaded++;
		rows.push({
			key: item.key,
			origin: item.origin,
			mode: item.mode,
			recorded: item.recorded,
			decided: plain.decided,
			dialog,
			dialogWithPrefixGrants: dialogGranted,
			...(plain.stages === undefined ? {} : { stages: plain.stages }),
			envFingerprint: envFingerprint(project.loaded),
		});
	}
	const meta = {
		meta: {
			code: resolve(code),
			rows: rows.length,
			sessions: collected.sessions,
			skippedUnknownMode: skipped,
			projectRulesLoadedRows: projectLoaded,
			pairingProblems: collected.problems,
			dialogsWithParsedPrefixGrants: withGrants,
		},
	};
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, [meta, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n");
	const dialogs = rows.filter((row) => (row as { dialog: boolean }).dialog).length;
	console.log(`replay run: ${rows.length} decisions from ${collected.sessions} session(s); ${dialogs} ask(s) without grants; ${withGrants} ask(s) with parsed prefix grants (labelled, informational)`);
	for (const problem of collected.problems) console.log(`  background ask ${problem.kind}: ${problem.key} (excluded from counts)`);
	if (skipped > 0) console.log(`  ${skipped} row(s) skipped: unknown mode`);
	console.log(`  wrote ${out}`);
	return 0;
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

interface Row {
	key: string;
	origin: Origin;
	mode: string;
	recorded: Recorded;
	decided: Stage;
	dialog: boolean;
	dialogWithPrefixGrants?: boolean;
	envFingerprint: unknown;
}

function readRows(path: string): { meta: Rec; rows: Row[] } {
	const lines = readJsonl(path);
	const meta = lines.find((line) => line.meta !== undefined);
	return { meta: (meta?.meta ?? {}) as Rec, rows: lines.filter((line) => line.key !== undefined) as unknown as Row[] };
}

/** Extension point for `--probe python` (phase 4, not implemented): a probe would add rows that flip with the analyzer. */
const PROBES: Record<string, never> = {};

interface FixtureEntry {
	id: string;
	guard?: true;
	command: (env: { scratch: string; cwd: string }) => string;
}
interface Fixture {
	ENTRIES: FixtureEntry[];
	judge: (entry: FixtureEntry, mode: ModeName, api: ReturnType<typeof decisionApi>, env: { scratch: string; cwd: string }) => { action: string; rule: string; why?: string };
}

async function compareCommand(args: string[], opts: Map<string, string>): Promise<number> {
	const [oldPath, newPath] = args;
	if (oldPath === undefined || newPath === undefined) return usage("compare needs <old.jsonl> <new.jsonl>");
	const probe = opts.get("probe");
	if (probe !== undefined) {
		if (!(probe in PROBES)) {
			console.error(`replay: --probe ${probe} is not implemented yet`);
			return 2;
		}
	}
	const oldRun = readRows(oldPath);
	const newRun = readRows(newPath);
	const newByKey = new Map(newRun.rows.map((row) => [row.key, row]));
	const oldByKey = new Map(oldRun.rows.map((row) => [row.key, row]));

	console.log(`# per row: key | origin | old -> new | old reason`);
	const flips = new Map<string, string[]>();
	const newAllow: string[] = [];
	for (const row of oldRun.rows) {
		const next = newByKey.get(row.key);
		if (next === undefined) {
			console.log(`${row.key} | ${row.origin} | ${row.decided.action} -> (missing in new) | ${row.decided.rule}`);
			continue;
		}
		console.log(`${row.key} | ${row.origin} | ${row.decided.action} -> ${next.decided.action} | ${row.decided.rule}`);
		if (row.decided.action !== next.decided.action) {
			flips.set(row.decided.rule, [...(flips.get(row.decided.rule) ?? []), `${row.key} ${row.decided.action}->${next.decided.action}`]);
			if (row.decided.action !== "allow" && next.decided.action === "allow") newAllow.push(`${row.key} | ${row.origin} | ${row.decided.action} -> allow | ${row.decided.rule}`);
		}
	}
	for (const row of newRun.rows) if (!oldByKey.has(row.key)) console.log(`${row.key} | ${row.origin} | (missing in old) -> ${row.decided.action} | -`);

	const recorded = oldRun.rows.filter((row) => row.recorded.action === "ask");
	const recomputed = oldRun.rows.filter((row) => row.dialog);
	console.log("\n# totals");
	console.log(`recorded dialogs: ${recorded.length}`);
	console.log(`recomputed old dialogs (self-check against recorded): ${recomputed.length}`);
	const disagree = oldRun.rows.filter((row) => (row.recorded.action === "ask") !== row.dialog);
	console.log(`  disagreements: ${disagree.length}`);
	for (const row of disagree) console.log(`  ${row.key} | recorded ${row.recorded.action}${row.recorded.matcher ? `/${row.recorded.matcher}` : ""} | recomputed ${row.decided.action}/${row.decided.rule}${row.decided.why ? ` | ${oneLine(row.decided.why, 100)}` : ""}`);
	console.log(`new dialogs: ${newRun.rows.filter((row) => row.dialog).length}`);
	console.log(`with parsed prefix grants (labelled): old ${oldRun.rows.filter((row) => row.dialogWithPrefixGrants).length}, new ${newRun.rows.filter((row) => row.dialogWithPrefixGrants).length}`);
	for (const [side, run] of [["old", oldRun], ["new", newRun]] as const) {
		const problems = (run.meta.pairingProblems ?? []) as { kind: string; key: string }[];
		for (const problem of problems) console.log(`${side}: background ask ${problem.kind}: ${problem.key} (excluded)`);
	}

	console.log("\n# flips grouped by old reason");
	if (flips.size === 0) console.log("(none)");
	for (const [reason, list] of [...flips].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`${reason}: ${list.length}`);
		for (const line of list) console.log(`  ${line}`);
	}
	console.log("\n# NEW-ALLOW");
	if (newAllow.length === 0) console.log("(none)");
	for (const line of newAllow) console.log(line);

	const fingerprints = (rows: readonly Row[]) => [...new Set(rows.map((row) => JSON.stringify(row.envFingerprint)))].sort();
	const [fo, fn] = [fingerprints(oldRun.rows), fingerprints(newRun.rows)];
	if (JSON.stringify(fo) !== JSON.stringify(fn)) console.log(`\nWARNING: env fingerprints differ between the runs (node, platform, tmpdir, env names or project rules); the comparison may be unsound\n  old: ${fo.length} variant(s); new: ${fn.length} variant(s)`);

	// fixture guard: every `guard: true` entry, in every mode, on both trees
	const fixturePath = resolve(opts.get("fixture") ?? join(PACKAGE_ROOT, "tests", "fixtures", "decisions.ts"));
	const codeOld = opts.get("code-old") ?? (oldRun.meta.code as string | undefined) ?? PACKAGE_ROOT;
	const codeNew = opts.get("code-new") ?? (newRun.meta.code as string | undefined) ?? PACKAGE_ROOT;
	console.log("\n# fixture guard");
	if (!existsSync(fixturePath)) {
		console.log(`fixture not found: ${fixturePath}`);
		return 1;
	}
	const fixture = (await import(pathToFileURL(fixturePath).href)) as Fixture;
	const [apiOld, apiNew] = [decisionApi(await loadTree(codeOld)), decisionApi(await loadTree(codeNew))];
	const scratch = mkdtempSync(join(tmpdir(), "pi-keeper-"));
	const cwd = mkdtempSync(join(tmpdir(), "replay-cwd-"));
	const env = { scratch, cwd };
	let guards = 0;
	const failures: string[] = [];
	for (const entry of fixture.ENTRIES.filter((e) => e.guard === true)) {
		for (const mode of Object.keys(apiNew.MODES) as ModeName[]) {
			guards++;
			const verdict = (api: typeof apiNew) => {
				try {
					return fixture.judge(entry, mode, api, env).action;
				} catch (error) {
					return `error(${(error as Error).message.split("\n")[0]})`;
				}
			};
			const [before, after] = [verdict(apiOld), verdict(apiNew)];
			if (after === "allow" && before !== "allow") failures.push(`${entry.id} [${mode}]: ${before} -> allow`);
		}
	}
	console.log(`${guards} guard check(s); ${failures.length} new allow(s)`);
	for (const line of failures) console.log(`  GUARD FAIL ${line}`);
	return failures.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(problem?: string): number {
	if (problem !== undefined) console.error(`replay: ${problem}`);
	console.error("usage: replay run --session <parent.jsonl> --code <tree> [--out <file>] [--agent-dir <dir>]\n       replay compare <old.jsonl> <new.jsonl> [--fixture <path>] [--code-old <tree>] [--code-new <tree>]");
	return 2;
}

function parseArgs(argv: string[]): { positional: string[]; opts: Map<string, string> } {
	const positional: string[] = [];
	const opts = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) opts.set(arg.slice(2), argv[++i] ?? "");
		else positional.push(arg);
	}
	return { positional, opts };
}

async function main(): Promise<number> {
	const [command, ...rest] = process.argv.slice(2);
	const { positional, opts } = parseArgs(rest);
	if (command === "run") return runCommand(opts);
	if (command === "compare") return compareCommand(positional, opts);
	return usage();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}
