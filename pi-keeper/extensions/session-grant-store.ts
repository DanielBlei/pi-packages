/**
 * The session grants: what the user approved with "Yes, and don't ask again
 * … this session" (command prefixes, exact commands, whole commands, reads
 * outside the working directory, read dirs, fetch hosts). Process memory
 * only; persistent per-project rules live in project-rules.ts, and the
 * on-disk snapshot a background child reads is session-grants.ts.
 *
 * One store per extension instance. A subagent child does not see its
 * parent's: pi evaluates each extension path with its own module cache, so a
 * child holds its own (empty) store and gets the parent's grants through
 * sharedRules() (the UI relay, or the published snapshot for a background
 * child). reset() runs on session_start (/new, /resume, fork) in a parent
 * session only, so it begins without grants, as the dialog says; a child holds
 * none of its own and reads the parent's through the relay or the snapshot.
 *
 * The getters are live on purpose: the relay hands them to an in-process
 * child, which reads them on every check. Changes go through the methods. snapshot() is the frozen copy.
 *
 * Free of pi types so it is testable (like child-lane.ts).
 */

/** A copy of the grants at one moment; later changes to the store don't reach it. */
export interface SessionGrantsSnapshot {
	readonly prefixes: readonly (readonly string[])[];
	readonly exact: readonly (readonly string[])[];
	readonly verbatim: readonly string[];
	readonly outsideReadsAllowed: boolean;
	readonly outsideReadDirs: readonly string[];
	readonly fetchHosts: readonly string[];
	readonly gitRepos: readonly string[];
	readonly loopGlobs: boolean;
}

export class SessionGrants {
	readonly #prefixes: string[][] = [];
	readonly #exact: string[][] = [];
	readonly #verbatim: string[] = [];
	#outsideReadsAllowed = false;
	readonly #outsideReadDirs: string[] = [];
	readonly #fetchHosts: string[] = [];
	readonly #gitRepos: string[] = [];
	#loopGlobs = false;

	/** Command prefixes approved for the session. */
	get prefixes(): readonly (readonly string[])[] {
		return this.#prefixes;
	}

	/** Exact commands approved via "Allow a different command pattern…"; same lifetime as the prefixes. */
	get exact(): readonly (readonly string[])[] {
		return this.#exact;
	}

	/** Whole commands approved via "don't ask again for this exact command" (verbatimKey); default mode only. */
	get verbatim(): readonly string[] {
		return this.#verbatim;
	}

	/** "Yes, allow reads outside the working directory". */
	get outsideReadsAllowed(): boolean {
		return this.#outsideReadsAllowed;
	}

	/** "Yes, and allow reading from <dir>/ this session": realpaths of granted directories. */
	get outsideReadDirs(): readonly string[] {
		return this.#outsideReadDirs;
	}

	/** "Yes, allow fetching from <host> this session": lowercase hostnames. */
	get fetchHosts(): readonly string[] {
		return this.#fetchHosts;
	}

	/** "Yes, and allow git in <repo>/ this session": realpaths of granted git repository roots. */
	get gitRepos(): readonly string[] {
		return this.#gitRepos;
	}

	/** "Yes, and allow loops over globs this session": a `for` loop over a glob may be unrolled (the hard limits still ask). */
	get loopGlobs(): boolean {
		return this.#loopGlobs;
	}

	/** Empty everything in place (the arrays keep their identity, so a live reader sees the reset). */
	reset(): void {
		this.#prefixes.length = 0;
		this.#exact.length = 0;
		this.#verbatim.length = 0;
		this.#outsideReadsAllowed = false;
		this.#outsideReadDirs.length = 0;
		this.#fetchHosts.length = 0;
		this.#gitRepos.length = 0;
		this.#loopGlobs = false;
	}

	/** A deep copy, frozen: mutating it can't reach the live state. */
	snapshot(): SessionGrantsSnapshot {
		const copy = (lists: readonly (readonly string[])[]) => Object.freeze(lists.map((l) => Object.freeze([...l])));
		return Object.freeze({
			prefixes: copy(this.#prefixes),
			exact: copy(this.#exact),
			verbatim: Object.freeze([...this.#verbatim]),
			outsideReadsAllowed: this.#outsideReadsAllowed,
			outsideReadDirs: Object.freeze([...this.#outsideReadDirs]),
			fetchHosts: Object.freeze([...this.#fetchHosts]),
			gitRepos: Object.freeze([...this.#gitRepos]),
			loopGlobs: this.#loopGlobs,
		});
	}

	/** Remember a token prefix, or the whole command when `exact` (deduplicated by its text). */
	addPattern(tokens: readonly string[], exact: boolean): void {
		const list = exact ? this.#exact : this.#prefixes;
		if (!list.some((t) => t.join(" ") === tokens.join(" "))) list.push([...tokens]);
	}

	removePattern(tokens: readonly string[], exact: boolean): void {
		const list = exact ? this.#exact : this.#prefixes;
		const at = list.findIndex((t) => t.join(" ") === tokens.join(" "));
		if (at !== -1) list.splice(at, 1);
	}

	allowLoopGlobs(): void {
		this.#loopGlobs = true;
	}

	revokeLoopGlobs(): void {
		this.#loopGlobs = false;
	}

	allowOutsideReads(): void {
		this.#outsideReadsAllowed = true;
	}

	revokeOutsideReads(): void {
		this.#outsideReadsAllowed = false;
	}

	addVerbatim(key: string): void {
		if (!this.#verbatim.includes(key)) this.#verbatim.push(key);
	}

	removeVerbatim(key: string): void {
		const at = this.#verbatim.indexOf(key);
		if (at !== -1) this.#verbatim.splice(at, 1);
	}

	addReadDir(realpath: string): void {
		if (!this.#outsideReadDirs.includes(realpath)) this.#outsideReadDirs.push(realpath);
	}

	removeReadDir(realpath: string): void {
		const at = this.#outsideReadDirs.indexOf(realpath);
		if (at !== -1) this.#outsideReadDirs.splice(at, 1);
	}

	addFetchHost(host: string): void {
		if (!this.#fetchHosts.includes(host)) this.#fetchHosts.push(host);
	}

	removeFetchHost(host: string): void {
		const at = this.#fetchHosts.indexOf(host);
		if (at !== -1) this.#fetchHosts.splice(at, 1);
	}

	addGitRepo(realpath: string): void {
		if (!this.#gitRepos.includes(realpath)) this.#gitRepos.push(realpath);
	}

	removeGitRepo(realpath: string): void {
		const at = this.#gitRepos.indexOf(realpath);
		if (at !== -1) this.#gitRepos.splice(at, 1);
	}
}
