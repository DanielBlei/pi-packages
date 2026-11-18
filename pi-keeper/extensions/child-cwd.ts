/**
 * Where a subagent child may work. Every "inside the working directory" rule
 * trusts the session cwd, and a child's cwd is whatever the parent model put
 * in the subagent call: `cwd: "/"` made the whole disk "inside" (seen in a
 * real run). A child therefore checks its cwd against its parent's project
 * (shared through the UI relay or the background grant snapshot) and refuses
 * a root no session should have. A child whose cwd fails is locked down
 * (index.ts): every call is denied except contact_supervisor and its report.
 *
 * Accepted:
 * - inside the parent's cwd, or inside the parent's project root (the nearest
 *   ancestor with .git: a parent started in a subdirectory may launch at the
 *   repository root);
 * - a linked git worktree of the parent's repository (pi-subagents'
 *   `worktree: true` runs live beside the checkout, in
 *   `<repo parent>/worktrees/<project>/pi-worktree-*`): its `.git` file
 *   points into `<parent root>/.git/worktrees/`.
 * Refused even without parent information: "/", the home directory and its
 * ancestors.
 *
 * Free of pi types so it is testable (like config.ts).
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { findProjectRoot } from "./project-rules.ts";

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function inside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** The repository a linked worktree belongs to: `<main>/.git/worktrees/<name>` from its `.git` file, else undefined. */
function worktreeGitDir(dir: string): string | undefined {
	const root = findProjectRoot(dir);
	const marker = join(root, ".git");
	try {
		if (!statSync(marker).isFile()) return undefined;
		const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(marker, "utf8"));
		return m === null ? undefined : real(resolve(root, m[1].trim()));
	} catch {
		return undefined;
	}
}

/**
 * Why a child may not work in `childCwd`, or undefined when it may.
 * `parentCwd` is undefined when the parent is unknown: then only the
 * root/home check applies, unless `parentExpected` (the env names a parent
 * session and the child runs in auto), where the cwd cannot be checked and
 * the child fails closed.
 */
export function childCwdProblem(childCwd: string, parentCwd: string | undefined, home: string = homedir(), parentExpected = false): string | undefined {
	const cwd = real(childCwd);
	const realHome = real(home);
	if (cwd === sep || cwd === realHome || inside(realHome, cwd)) {
		return `your working directory ${cwd} is / or the home directory (or above it), which would put every file "inside" it`;
	}
	if (parentCwd === undefined) {
		return parentExpected ? `your working directory ${cwd} cannot be checked because the parent session's grants could not be read` : undefined;
	}
	const parent = real(parentCwd);
	const parentRoot = real(findProjectRoot(parent));
	// a repository at or above the home directory (a dotfiles repo in $HOME) is no project: it would accept all of home
	const projectRoot = parentRoot === sep || parentRoot === realHome || inside(realHome, parentRoot) ? undefined : parentRoot;
	if (inside(cwd, parent) || (projectRoot !== undefined && inside(cwd, projectRoot))) return undefined;
	const gitDir = worktreeGitDir(cwd);
	if (gitDir !== undefined && projectRoot !== undefined && inside(gitDir, join(projectRoot, ".git", "worktrees"))) return undefined;
	return `your working directory ${cwd} is outside the parent session's project (${parentRoot})`;
}
