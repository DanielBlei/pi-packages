/**
 * Session grants for background subagent children. A foreground child runs in
 * the parent's process and reads the parent's session-scope grants live
 * through the UI relay (ui-relay.ts). A background child (`async: true`) runs
 * in a detached pi-subagents runner process, so the parent also publishes the
 * same state to a file the child reads on each decision:
 *
 *   <agent dir>/pi-keeper/session-grants/<sha256(session id)>.json
 *
 * keyed by the parent's session id, which pi-subagents hands the runner as
 * PI_SUBAGENT_PARENT_SESSION. The grants stay session-scope: the file is
 * removed at session shutdown and on a session switch, and a file whose
 * owning pi process is gone (a crash) is ignored and swept at the next start.
 * Nothing is ever written to the project.
 *
 * The directory sits under the agent dir, a protected path, so a child's tool
 * writes there ask. The parent in turn trusts nothing from a child except the
 * tool call it judges (ask-server.ts): a background ask's reply is only allow
 * or deny, and any grant is applied on the parent side. Fail closed: a
 * missing, unreadable, malformed, foreign or stale file means no grants.
 * Nothing here throws.
 *
 * Free of pi types so it is testable (like config.ts).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive as alive, readJsonFile, writeFileAtomic } from "./secure-file.ts";
import type { UiRelaySessionRules } from "./ui-relay.ts";

/** pi-subagents' env var naming the parent session of a runner process. */
export const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

const VERSION = 1;
/** A snapshot larger than this is not a snapshot we wrote. */
const MAX_BYTES = 256 * 1024;

/** The session-scope rules a child reads (the relay's, which carry the optional gitRepos). */
export type SessionGitRules = UiRelaySessionRules;

interface Snapshot extends SessionGitRules {
	version: number;
	sessionId: string;
	/** The parent pi process; a snapshot whose process is gone is stale. */
	pid: number;
}

export function grantsDir(agentDir: string): string {
	return join(agentDir, "pi-keeper", "session-grants");
}

export function grantsFile(agentDir: string, sessionId: string): string {
	return join(grantsDir(agentDir), `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

/** Parent: write (or replace) this session's snapshot. Atomic, 0600. */
export function publishGrants(agentDir: string, sessionId: string, rules: SessionGitRules): void {
	try {
		mkdirSync(grantsDir(agentDir), { recursive: true, mode: 0o700 });
		const file = grantsFile(agentDir, sessionId);
		const snapshot: Snapshot = {
			version: VERSION,
			sessionId,
			pid: process.pid,
			prefixes: rules.prefixes,
			exact: rules.exact,
			edits: rules.edits,
			outsideReads: rules.outsideReads,
			outsideReadDirs: rules.outsideReadDirs ?? [],
			fetchHosts: rules.fetchHosts ?? [],
			gitRepos: rules.gitRepos ?? [],
			loopGlobs: rules.loopGlobs === true,
			pythonWhile: rules.pythonWhile === true,
			tools: rules.tools ?? [],
			...(rules.cwd !== undefined ? { cwd: rules.cwd } : {}),
			...(rules.thinking !== undefined ? { thinking: rules.thinking } : {}),
		};
		writeFileAtomic(file, JSON.stringify(snapshot));
	} catch {
		// no snapshot: background children get no session grants (fail-closed)
	}
}

/** Parent: remove this session's snapshot (shutdown, session switch). */
export function withdrawGrants(agentDir: string, sessionId: string): void {
	try {
		rmSync(grantsFile(agentDir, sessionId), { force: true });
	} catch {
		// a leftover is ignored once its process is gone, and swept at the next start
	}
}

/** Parent at start: remove snapshots whose pi process is gone (crashes skip shutdown). */
export function sweepStaleGrants(agentDir: string): void {
	let names: string[];
	try {
		names = readdirSync(grantsDir(agentDir));
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(grantsDir(agentDir), name);
		const snapshot = parse(file);
		if (snapshot === undefined || !alive(snapshot.pid)) rmSync(file, { force: true });
	}
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parse(file: string): Snapshot | undefined {
	try {
		// readJsonFile: no symlink, regular file, our uid, at most MAX_BYTES; throws otherwise
		const value = readJsonFile(file, MAX_BYTES) as Partial<Snapshot> | null;
		if (value === null || typeof value !== "object" || value.version !== VERSION) return undefined;
		if (typeof value.sessionId !== "string" || typeof value.pid !== "number") return undefined;
		const prefixes = value.prefixes;
		const exact = value.exact;
		if (!Array.isArray(prefixes) || !prefixes.every(strings)) return undefined;
		if (!Array.isArray(exact) || !exact.every(strings)) return undefined;
		if (typeof value.edits !== "boolean" || typeof value.outsideReads !== "boolean") return undefined;
		if (!strings(value.outsideReadDirs)) return undefined;
		if (value.fetchHosts !== undefined && !strings(value.fetchHosts)) return undefined;
		if (value.gitRepos !== undefined && !strings(value.gitRepos)) return undefined;
		if (value.loopGlobs !== undefined && typeof value.loopGlobs !== "boolean") return undefined;
		if (value.pythonWhile !== undefined && typeof value.pythonWhile !== "boolean") return undefined;
		if (value.tools !== undefined && !strings(value.tools)) return undefined;
		if (value.cwd !== undefined && (typeof value.cwd !== "string" || !value.cwd.startsWith("/"))) return undefined;
		if (value.thinking !== undefined && typeof value.thinking !== "string") return undefined;
		return value as Snapshot;
	} catch {
		return undefined;
	}
}

/**
 * Child: the parent session's grants, or undefined (no parent session in the
 * env, no file, a foreign or malformed file, or a parent process that is gone).
 */
export function readParentGrants(agentDir: string, env: NodeJS.ProcessEnv = process.env): SessionGitRules | undefined {
	const sessionId = env[PARENT_SESSION_ENV];
	if (typeof sessionId !== "string" || sessionId === "") return undefined;
	const snapshot = parse(grantsFile(agentDir, sessionId));
	if (snapshot === undefined || snapshot.sessionId !== sessionId || !alive(snapshot.pid)) return undefined;
	return {
		prefixes: snapshot.prefixes,
		exact: snapshot.exact,
		edits: snapshot.edits,
		outsideReads: snapshot.outsideReads,
		outsideReadDirs: snapshot.outsideReadDirs,
		fetchHosts: snapshot.fetchHosts ?? [],
		gitRepos: snapshot.gitRepos ?? [],
		loopGlobs: snapshot.loopGlobs === true,
		pythonWhile: snapshot.pythonWhile === true,
		tools: snapshot.tools ?? [],
		...(snapshot.cwd !== undefined ? { cwd: snapshot.cwd } : {}),
		...(snapshot.thinking !== undefined ? { thinking: snapshot.thinking } : {}),
	};
}

/** Child: the pid of the live parent process that published the snapshot, or undefined (same checks as readParentGrants). */
export function readParentPid(agentDir: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
	const sessionId = env[PARENT_SESSION_ENV];
	if (typeof sessionId !== "string" || sessionId === "") return undefined;
	const snapshot = parse(grantsFile(agentDir, sessionId));
	return snapshot !== undefined && snapshot.sessionId === sessionId && alive(snapshot.pid) ? snapshot.pid : undefined;
}
