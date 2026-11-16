/**
 * One dialog at a time. pi shows an extension dialog (select, input, custom,
 * editor) in a single editor slot and does not queue them: a second dialog
 * replaces the first, whose promise is never settled. Every place that opens
 * one for the user takes this lock first.
 *
 * A bare FIFO mutex, no policy: waiters run in the order they asked, a
 * rejection of one does not hold up the next, and a waiter whose signal
 * aborts before its turn gives up without ever opening a dialog.
 *
 * The lock is module-level, so there is one per extension instance. That is
 * the parent's: a subagent child has its own instance (and so its own,
 * unused lock) but opens no dialog itself; its asks arrive through the UI
 * relay (ui-relay.ts) and open in the parent, under the parent's lock, the
 * same one the parent's own asks take.
 *
 * Not reentrant: code running inside the lock must not take it again (it
 * would wait for itself). The dialogs here never nest; a follow-up dialog
 * (the "different command pattern" input after its select) opens after the
 * first one has closed, and takes the lock on its own.
 *
 * Free of pi types so it is testable (like session-grant-store.ts).
 */

/** Settles when the last waiter in line has finished; never rejects. */
let tail: Promise<void> = Promise.resolve();
/** Waiters in line or running; 0 = free, so fn can start in the same tick. */
let queued = 0;

/** Runs fn once every earlier waiter has finished; undefined without running it when `signal` aborts first. */
export function withDialogLock<T>(fn: () => Promise<T>): Promise<T>;
export function withDialogLock<T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined>;
export function withDialogLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
	if (signal?.aborted) return Promise.resolve(undefined);
	const previous = tail;
	const free = queued === 0;
	queued++;
	let release!: () => void;
	tail = new Promise<void>((resolve) => {
		release = resolve;
	});
	return (async () => {
		let onAbort: (() => void) | undefined;
		try {
			if (!free) {
				const turn = await Promise.race([
					previous.then(() => true),
					new Promise<false>((resolve) => {
						onAbort = () => resolve(false);
						signal?.addEventListener("abort", onAbort, { once: true });
					}),
				]);
				if (!turn || signal?.aborted) return undefined;
			}
			return await fn();
		} finally {
			if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
			// an aborted waiter still passes the turn on only once the one ahead is done
			void previous.then(() => {
				queued--;
				release();
			});
		}
	})();
}

/** True while a dialog is open or waiting for the slot. */
export function isDialogLocked(): boolean {
	return queued > 0;
}
