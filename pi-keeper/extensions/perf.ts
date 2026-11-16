/**
 * Counting seam for the performance bench (`scripts/bench.ts`) and
 * `tests/unit/perf.test.ts`. Off by default, and `countWork` costs one call
 * when it is off.
 *
 * Nothing a permission decision needs reads these numbers. The counters are
 * process-global on purpose: the work being counted happens several modules
 * deep (a poll tick reaches ask-mailbox.ts and secure-file.ts, a decision
 * reaches project-rules.ts through index.ts), and threading a counter through
 * every signature would change the code under measurement.
 *
 * Free of pi types so it is testable (like config.ts).
 */

let enabled = false;
const counters = new Map<string, number>();

/** Turn counting on (and clear the counters) or off. Returns the previous state. */
export function enablePerfCounting(on = true): boolean {
	const previous = enabled;
	enabled = on;
	counters.clear();
	return previous;
}

export function countingEnabled(): boolean {
	return enabled;
}

/** Record one unit of work under `name`; a no-op unless counting is on. */
export function countWork(name: string): void {
	if (!enabled) return;
	counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function resetCounters(): void {
	counters.clear();
}

/** How much work `name` recorded since the last reset (0 when counting is off). */
export function counter(name: string): number {
	return counters.get(name) ?? 0;
}

/** Every counter, highest first, so a bench table reads like a cost ranking. */
export function countersSnapshot(): Array<[string, number]> {
	return [...counters.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function counterTotal(): number {
	let total = 0;
	for (const value of counters.values()) total += value;
	return total;
}
