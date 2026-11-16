/**
 * Hardened file helpers shared by the files two pi processes exchange under
 * the agent dir (session-grants.ts, ask-mailbox.ts): an atomic 0600 write, a
 * pid-alive check, a 0700 directory chain that must be ours and symlink-free,
 * and a size-capped, owner-checked JSON read that refuses symlinks.
 *
 * Free of pi types so it is testable (like config.ts).
 */

import { chmodSync, closeSync, constants, fchmodSync, fstatSync, type Stats, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { relative, sep } from "node:path";
import { countWork } from "./perf.ts";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The current uid, or undefined where there is none (Windows). */
export function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Whether a process with this pid exists. */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Write `text` to `file` atomically, mode 0600: a fresh random-named tmp file
 * opened O_EXCL|O_NOFOLLOW (a planted file or symlink at the name fails), then
 * rename. The tmp is removed if anything fails. Throws on failure.
 */
export function writeFileAtomic(file: string, text: string): void {
	const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
	countWork("write");
	try {
		countWork("fs");
		const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
		try {
			countWork("fs");
			writeSync(fd, text);
		} finally {
			countWork("fs");
			closeSync(fd);
		}
		countWork("fs");
		renameSync(tmp, file);
	} catch (error) {
		countWork("fs");
		rmSync(tmp, { force: true });
		throw error;
	}
}

/**
 * Walk every component below `below` down to `dir`, requiring each to be a real directory (not a symlink)
 * owned by `uid`. Missing levels are created one at a time (never behind a
 * symlink). A component with group or other bits is chmod'ed to 0700 through
 * a descriptor (it is ours, so tightening is safe) rather than refused.
 * Throws otherwise.
 */
export function ensureSecureDir(dir: string, uid: number | undefined = currentUid(), below: string = dir): void {
	// one level at a time, so nothing is ever created behind a symlinked ancestor
	const rel = relative(below, dir);
	const levels: string[] = [];
	let at = below;
	for (const part of rel === "" ? [] : rel.split(sep)) {
		at = at === sep ? at + part : `${at}${sep}${part}`;
		levels.push(at);
	}
	if (levels.length === 0) levels.push(dir);
	for (const level of levels) {
		let stat: Stats;
		countWork("fs");
		countWork("ensureSecureDir");
		try {
			stat = lstatSync(level);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			countWork("fs");
			mkdirSync(level, { recursive: false, mode: 0o700 });
			countWork("fs");
			stat = lstatSync(level);
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`not a plain directory: ${level}`);
		if (uid !== undefined && stat.uid !== uid) throw new Error(`directory not owned by this user: ${level}`);
		if ((stat.mode & 0o077) !== 0) tighten(level, uid);
	}
}

/** chmod a directory we own to 0700 through a descriptor, so a swap for a symlink can't redirect it. */
function tighten(dir: string, uid: number | undefined): void {
	if (constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) {
		countWork("fs");
		chmodSync(dir, 0o700);
		return;
	}
	countWork("fs");
	const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		countWork("fs");
		const stat = fstatSync(fd);
		if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new Error(`not a plain directory: ${dir}`);
		countWork("fs");
		fchmodSync(fd, 0o700);
	} finally {
		countWork("fs");
		closeSync(fd);
	}
}

/**
 * Read and parse a JSON file. The file is opened O_NOFOLLOW|O_NONBLOCK and
 * every check runs on the open descriptor (no check-then-use race, and a FIFO
 * swapped in cannot hang us): regular file only, our uid, at most `maxBytes`.
 * Where O_NOFOLLOW does not exist it falls back to lstat. Throws with a short
 * reason; the caller turns that into a warning or a fail-closed answer.
 */
export function readJsonFile(file: string, maxBytes: number, uid: number | undefined = currentUid()): unknown {
	countWork("readJsonFile");
	if (constants.O_NOFOLLOW === undefined) {
		countWork("fs");
		const stat = lstatSync(file);
		if (!stat.isFile()) throw new Error("not a regular file");
		if (uid !== undefined && stat.uid !== uid) throw new Error("not owned by this user");
		if (stat.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
		countWork("fs");
		return JSON.parse(readFileSync(file, "utf8")) as unknown;
	}
	countWork("fs");
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		countWork("fs");
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("not a regular file");
		if (uid !== undefined && stat.uid !== uid) throw new Error("not owned by this user");
		if (stat.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			countWork("fs");
			const n = readSync(fd, buffer, length, buffer.length - length, null);
			if (n === 0) break;
			length += n;
		}
		if (length > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
		return JSON.parse(buffer.toString("utf8", 0, length)) as unknown;
	} finally {
		countWork("fs");
		closeSync(fd);
	}
}
