/**
 * Grants for tools that are not built in: an MCP tool registered under its own
 * name, a tool of another package, and calls through the `mcp` gateway tool.
 * One grant names one key:
 *
 *   Tool(<name>)               a directly registered tool
 *   Mcp(<server>/<tool>)       a gateway call `{ tool, server, args }`
 *   Mcp(<tool>)                the same call without a server
 *   Mcp(<server>/catalog)      a gateway lookup (search, describe, list, status, instructions)
 *   Mcp(catalog)               the same lookup without a server
 *
 * A key matches exactly: a server-qualified key never covers an unqualified
 * call and the other way round. The arguments are not part of the key.
 * Never grantable: connecting a server, any `action`, `mcpScript`, an unknown
 * gateway input key, every tool that can run or change things by itself
 * (UNLISTABLE_TOOLS), the built-in tools, and a tool whose annotations say
 * `destructiveHint: true`.
 *
 * The same text is the session grant, the project rule (allow, ask, deny) and
 * the telemetry label. Free of pi types so it is testable.
 */

import { UNLISTABLE_TOOLS } from "./config.ts";
import { BUILTIN_SEARCH_TOOLS, CHILD_PROTOCOL_TOOLS, LAUNCH_TOOLS, READ_TOOLS } from "./modes.ts";

/** The gateway tool's own name. */
export const MCP_GATEWAY = "mcp";

/** The one pseudo tool name a catalog lookup stands for. A real tool of that name is never grantable (it would collide). */
const CATALOG = "catalog";

/** A tool or server name: plain identifier characters, no `/`, no parentheses. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/** Tools pi-keeper itself knows: never grantable here. */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([...READ_TOOLS, ...BUILTIN_SEARCH_TOOLS, ...LAUNCH_TOOLS, ...CHILD_PROTOCOL_TOOLS]);

/** Keys of a gateway call that runs a sub-tool. */
const CALL_KEYS = new Set(["tool", "server", "args"]);
/** Keys of a gateway catalog lookup. */
const LOOKUP_KEYS = new Set(["search", "describe", "instructions", "server"]);

export interface ToolHints {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
}

export interface ToolGrant {
	/** The rule text, `Tool(...)` or `Mcp(...)`. */
	key: string;
	/** The tool or sub-tool name looks like it changes things: the options say so. */
	risky: boolean;
}

/** A name compared loosely: lowercase, without `_`, `-`, `.`. */
export function looseName(name: string): string {
	return name.toLowerCase().replace(/[_.-]/g, "");
}

const UNLISTABLE_LOOSE: ReadonlySet<string> = new Set([...UNLISTABLE_TOOLS].map(looseName));

function isNeverByName(name: string): boolean {
	return UNLISTABLE_LOOSE.has(looseName(name)) || BUILTIN_TOOLS.has(name);
}

/** Words that mark a name as one that probably changes data. */
const WRITE_WORDS = new Set(["delete", "remove", "drop", "destroy", "purge", "write", "create", "update", "set", "put", "post", "send", "exec", "execute", "run", "kill"]);

/** The words of a tool name: split on `_`, `-`, `.`, `:` and camel case, lowercase. */
export function nameWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[\s_.:-]+/)
		.filter((w) => w !== "")
		.map((w) => w.toLowerCase());
}

/** True when a word of `name` is a write-like word (`delete_issue`, `runQuery`, `docs.update`, plurals too). */
export function looksLikeWrite(name: string): boolean {
	return nameWords(name).some((w) => WRITE_WORDS.has(w) || (w.endsWith("s") && WRITE_WORDS.has(w.slice(0, -1))));
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

/**
 * The key a call would be granted under, ignoring annotations (a project ask or
 * deny rule for a destructive tool still applies). Undefined when the call has
 * no key: a built-in or unlistable tool, a gateway call that connects, acts,
 * runs a script or carries an unknown key, or a name that is not a plain name.
 */
export function toolCallKey(toolName: string, input: unknown): ToolGrant | undefined {
	if (toolName !== MCP_GATEWAY) {
		if (isNeverByName(toolName) || !NAME.test(toolName)) return undefined;
		return { key: `Tool(${toolName})`, risky: looksLikeWrite(toolName) };
	}
	const record = asRecord(input);
	if (record === undefined) return undefined;
	const keys = Object.keys(record).filter((k) => record[k] !== undefined);
	let server: string | undefined;
	if (record.server !== undefined) {
		if (typeof record.server !== "string" || !NAME.test(record.server)) return undefined;
		server = record.server;
	}
	const qualify = (name: string): string => `Mcp(${server === undefined ? "" : `${server}/`}${name})`;
	if (record.tool !== undefined) {
		const tool = record.tool;
		if (typeof tool !== "string" || !NAME.test(tool) || tool === CATALOG || isNeverByName(tool)) return undefined;
		if (!keys.every((k) => CALL_KEYS.has(k))) return undefined;
		return { key: qualify(tool), risky: looksLikeWrite(tool) };
	}
	// a lookup: at most one of search, describe, instructions; `{}` is the status
	if (!keys.every((k) => LOOKUP_KEYS.has(k))) return undefined;
	if (keys.filter((k) => k !== "server").length > 1) return undefined;
	return { key: qualify(CATALOG), risky: false };
}

/** The key a call may be granted under, or undefined (see the header). */
export function grantableTool(toolName: string, input: unknown, hints?: ToolHints): ToolGrant | undefined {
	if (hints?.destructiveHint === true) return undefined;
	return toolCallKey(toolName, input);
}

/** Parse `Tool(<name>)` / `Mcp([<server>/]<tool>)`: undefined when the text is neither, an error when it names something that can't be granted. */
export function parseGrantKey(entry: string): { key: string } | { error: string } | undefined {
	const m = /^(Tool|Mcp)\(([\s\S]*)\)$/.exec(entry.trim());
	if (m === null) return undefined;
	const body = m[2].trim();
	if (m[1] === "Tool") {
		if (!NAME.test(body)) return { error: "not of the form Tool(<tool name>)" };
		if (isNeverByName(body)) return { error: "can't be granted (the tool can run or change things by itself)" };
		return { key: `Tool(${body})` };
	}
	const parts = body.split("/");
	if (parts.length > 2 || parts.some((p) => !NAME.test(p))) return { error: "not of the form Mcp(<tool>) or Mcp(<server>/<tool>)" };
	const tool = parts[parts.length - 1];
	if (isNeverByName(tool)) return { error: "can't be granted (the tool can run or change things by itself)" };
	return { key: `Mcp(${parts.join("/")})` };
}

const SEPARATORS = ["_", "-", ".", ":"];

/**
 * Broad matching for project deny and ask rules (allow matching stays exact).
 * `Mcp(s/x)` matches a gateway call of tool `x` with server `s` or no server,
 * and a gateway or direct tool named `s` + one of `_ - . :` + `x`; `Mcp(x)`
 * matches tool `x` with any server; `Mcp(s/catalog)` matches lookups for `s`
 * or no server; `Tool(n)` matches a direct tool `n`. Case-insensitive; only the
 * `tool` and `server` fields count, extra keys (connect, action, ...) do not hide a match.
 */
export function toolRuleMatches(rule: string, toolName: string, input: unknown): boolean {
	const m = /^(Tool|Mcp)\(([\s\S]*)\)$/.exec(rule.trim());
	if (m === null) return false;
	const body = m[2].trim().toLowerCase();
	const name = toolName.toLowerCase();
	if (m[1] === "Tool") return name === body;
	const parts = body.split("/");
	const x = parts[parts.length - 1];
	const s = parts.length === 2 ? parts[0] : undefined;
	if (SEPARATORS.some((sep) => s !== undefined && name === s + sep + x)) return true;
	if (name !== MCP_GATEWAY) return false;
	const record = asRecord(input);
	if (record === undefined) return false;
	const server = typeof record.server === "string" ? record.server.toLowerCase() : undefined;
	const serverOk = s === undefined || server === undefined || server === s;
	if (typeof record.tool === "string") {
		const tool = record.tool.toLowerCase();
		if (s !== undefined && SEPARATORS.some((sep) => tool === s + sep + x)) return true;
		return tool === x && serverOk;
	}
	if (record.tool !== undefined) return false;
	return x === CATALOG && serverOk;
}

/** True when any rule of the list matches the call (see `toolRuleMatches`). */
export function anyToolRuleMatches(rules: readonly string[] | undefined, toolName: string, input: unknown): boolean {
	return rules?.some((r) => toolRuleMatches(r, toolName, input)) === true;
}
