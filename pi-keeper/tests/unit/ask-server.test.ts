/**
 * Tests for the parent side of the ask mailbox: the pure helpers, and the
 * server against a real mailbox directory with the judge, the dialog and the
 * timer stepped by hand.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HEARTBEAT_EVERY_MS, HEARTBEAT_STALE_MS, heartbeatFresh } from "../../extensions/ask-heartbeat.ts";
import { askDirFor, newAskId, newNonce, readReply, writeCancel, writeRequest, type AskReply, type AskRequest } from "../../extensions/ask-mailbox.ts";
import { childModeFor, relaylessChildMode } from "../../extensions/subagents-bridge.ts";
import { ASK_TTL_MS, askTtlMs, backgroundChildMode, badgeText, MAX_QUEUE, mayPopUp, startAskServer, stricterMode, type AskServer, type AskServerOptions, type PopupState, type ServerEvent, type Verdict } from "../../extensions/ask-server.ts";

describe("backgroundChildMode: the mode this parent gives a background child", () => {
	// every combination: 3 parent modes x subagentsFollowAuto x backgroundAutoFallback x asks (a parent whose server runs has asks on, but the formula is shared with the child)
	// with asks reachable the child follows its parent like a foreground one (backgroundAutoFallback is moot); otherwise backgroundAutoFallback decides
	const expectedFor = (parent: "default" | "auto" | "plan", subagentsFollowAuto: boolean, backgroundAutoFallback: boolean, asks: boolean): string => {
		if (parent === "plan") return "plan";
		const registered = parent === "auto" && subagentsFollowAuto ? "auto" : "default";
		if (asks) return registered;
		return backgroundAutoFallback ? "auto" : "default";
	};
	let count = 0;
	for (const parent of ["plan", "default", "auto"] as const) {
		for (const subagentsFollowAuto of [false, true]) {
			for (const backgroundAutoFallback of [false, true]) {
				for (const backgroundAsks of [false, true]) {
					count++;
					it(`${parent} parent, subagentsFollowAuto ${subagentsFollowAuto}, backgroundAutoFallback ${backgroundAutoFallback}, asks ${backgroundAsks}`, () => {
						const expected = expectedFor(parent, subagentsFollowAuto, backgroundAutoFallback, backgroundAsks);
						assert.equal(backgroundChildMode(parent, { subagentsFollowAuto, backgroundAutoFallback, backgroundAsks }), expected);
						// the child side: the same formula over the entry file the bridge registered
						if (parent !== "plan") {
							const registered = childModeFor(parent, subagentsFollowAuto) as "default" | "auto";
							assert.equal(relaylessChildMode(registered, { backgroundAsks, backgroundAutoFallback }), expected);
						}
					});
				}
			}
		}
	}
	it("covers all 24 combinations", () => assert.equal(count, 24));
});

describe("stricterMode", () => {
	it("ranks plan > default > auto, whatever the order", () => {
		const modes = ["auto", "default", "plan"] as const;
		for (const [i, a] of modes.entries()) for (const [j, b] of modes.entries()) assert.equal(stricterMode(a, b), modes[Math.max(i, j)], `${a} vs ${b}`);
	});
});

it("badgeText counts the waiting approvals and names the command", () => {
	assert.equal(badgeText(1), "1 background approval waiting · /approvals");
	assert.equal(badgeText(3), "3 background approvals waiting · /approvals");
});

describe("mayPopUp", () => {
	const base: PopupState = { policy: "idle", forced: false, assumeIdle: false, idle: false, editorEmpty: true };
	it("idle: needs an idle session and an empty editor; a run that just ended counts as idle", () => {
		assert.equal(mayPopUp({ ...base, idle: true }), true);
		assert.equal(mayPopUp({ ...base, idle: true, editorEmpty: false }), false);
		assert.equal(mayPopUp(base), false);
		assert.equal(mayPopUp({ ...base, assumeIdle: true }), true);
		assert.equal(mayPopUp({ ...base, assumeIdle: true, editorEmpty: false }), false);
	});
	it("always: whatever the session is doing", () => {
		assert.equal(mayPopUp({ ...base, policy: "always" }), true);
		assert.equal(mayPopUp({ ...base, policy: "always", editorEmpty: false }), true);
	});
	it("badge: never by itself", () => {
		assert.equal(mayPopUp({ ...base, policy: "badge", idle: true }), false);
	});
	it("/approvals (forced) overrides every policy", () => {
		for (const policy of ["idle", "always", "badge"] as const) assert.equal(mayPopUp({ ...base, policy, forced: true, editorEmpty: false }), true);
	});
});

describe("the ask server", () => {
	let base: string;
	let dir: string;
	let tick: (() => void) | undefined;
	let timerStopped: boolean;
	let clock: number;
	let alive: boolean;
	let verdicts: Map<string, Verdict>;
	let dialogs: Array<{ request: AskRequest; signal: AbortSignal; settle: (decision: "allow" | "deny") => void }>;
	let events: ServerEvent[];
	let badges: number[];
	let rings: number;
	let ui: { hasUI: boolean; idle: boolean; editorEmpty: boolean; busy: boolean; popup: "idle" | "always" | "badge" };
	let server: AskServer;

	const ask: Verdict = { action: "ask", mode: "default", matcher: null };
	const allow: Verdict = { action: "allow", mode: "default", matcher: "readOnlyBash" };
	const deny: Verdict = { action: "deny", mode: "default", matcher: "dangerousBash" };

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pdf-askserver-")));
		dir = askDirFor(base, "session-1");
		tick = undefined;
		timerStopped = false;
		clock = 1_000_000;
		alive = true;
		verdicts = new Map();
		dialogs = [];
		events = [];
		badges = [];
		rings = 0;
		ui = { hasUI: true, idle: true, editorEmpty: true, busy: false, popup: "idle" };
		start();
	});
	afterEach(() => {
		server.stop();
		rmSync(base, { recursive: true, force: true });
	});

	function start(over: Partial<AskServerOptions> = {}): void {
		server?.stop();
		server = startAskServer({
			dir,
			judge: (request) => verdicts.get(request.id) ?? ask,
			ask: (request, signal) => new Promise((resolve) => {
				const entry = { request, signal, settle: resolve };
				dialogs.push(entry);
				signal.addEventListener("abort", () => resolve("deny"), { once: true });
			}),
			hasUI: () => ui.hasUI,
			isIdle: () => ui.idle,
			editorEmpty: () => ui.editorEmpty,
			dialogBusy: () => ui.busy,
			popup: () => ui.popup,
			attention: () => void rings++,
			badge: (count) => void badges.push(count),
			onEvent: (event) => void events.push(event),
			setTimer: (fn) => {
				tick = fn;
				return { stop: () => void (timerStopped = true) };
			},
			now: () => clock,
			alive: () => alive,
			...over,
		});
	}

	function file(over: Partial<AskRequest> = {}): AskRequest {
		const request: AskRequest = { v: 1, id: newAskId(), nonce: newNonce(), childPid: process.pid, childLabel: "scout", childMode: "default", cwd: "/work", call: { toolName: "bash", input: { command: "npm test" } }, ...over };
		writeRequest(dir, request);
		return request;
	}
	const replyOf = (request: AskRequest): AskReply | undefined => readReply(dir, request.id, request.nonce);
	const poll = (): void => tick?.();
	const kinds = (): string[] => events.map((e) => e.kind);

	it("answers allow and deny at once, without a dialog; deny carries the reason rules", () => {
		const a = file();
		const b = file();
		verdicts.set(a.id, allow);
		verdicts.set(b.id, deny);
		poll();
		assert.equal(replyOf(a)?.decision, "allow");
		assert.deepEqual([replyOf(b)?.decision, replyOf(b)?.reason], ["deny", "rules"]);
		assert.equal(dialogs.length, 0);
		assert.equal(rings, 0);
		assert.deepEqual(kinds().sort(), ["auto-allow", "auto-deny"]);
		assert.equal(server.pending(), 0);
	});

	it("an ask opens one dialog (ringing first); the user's answer becomes the reply, deny with reason user", () => {
		const a = file();
		poll();
		assert.equal(dialogs.length, 1);
		assert.equal(rings, 1);
		assert.equal(replyOf(a), undefined);
		dialogs[0].settle("deny");
		return Promise.resolve().then(() => {
			assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "user"]);
			assert.equal(server.pending(), 0);
		});
	});

	it("an approval answers allow", async () => {
		const a = file();
		poll();
		dialogs[0].settle("allow");
		await Promise.resolve();
		assert.equal(replyOf(a)?.decision, "allow");
		assert.equal(replyOf(a)?.reason, undefined);
	});

	it("dialogs are one at a time, and a later request is judged again when its turn comes", async () => {
		const requests = [file(), file()];
		poll();
		assert.equal(dialogs.length, 1);
		// the mailbox hands requests out in file name order: whichever came first is on screen
		const second = requests.find((r) => r.id !== dialogs[0].request.id) as AskRequest;
		// the first answer grants something that settles the second
		verdicts.set(second.id, allow);
		dialogs[0].settle("allow");
		await Promise.resolve();
		assert.equal(replyOf(second)?.decision, "allow");
		assert.equal(dialogs.length, 1, "no second dialog");
		assert.ok(kinds().includes("auto-allow"));
	});

	it("without a free dialog slot nothing opens; the next poll opens it", () => {
		file();
		ui.busy = true;
		poll();
		assert.equal(dialogs.length, 0);
		ui.busy = false;
		poll();
		assert.equal(dialogs.length, 1);
	});

	it("idle policy: a busy session or typed text shows the badge instead; a run ending or /approvals opens it", () => {
		file();
		ui.idle = false;
		poll();
		assert.equal(dialogs.length, 0);
		assert.deepEqual(badges, [1]);
		server.runEnded(); // the run is over and the editor is empty
		assert.equal(dialogs.length, 1);
		assert.deepEqual(badges, [1, 0], "the badge clears once the dialog is open (nothing else waits)");
	});

	it("idle policy: typed text blocks even an idle session, until /approvals", () => {
		file();
		ui.editorEmpty = false;
		poll();
		server.runEnded();
		assert.equal(dialogs.length, 0);
		assert.equal(server.openNow(), 1);
		assert.equal(dialogs.length, 1);
	});

	it("always opens at once, badge only on /approvals", () => {
		ui.popup = "always";
		ui.idle = false;
		ui.editorEmpty = false;
		file();
		poll();
		assert.equal(dialogs.length, 1);
	});

	it("badge policy never opens by itself; /approvals opens everything that waits, one at a time", async () => {
		ui.popup = "badge";
		file();
		file();
		poll();
		server.runEnded();
		assert.equal(dialogs.length, 0);
		assert.deepEqual(badges, [2]);
		assert.equal(server.openNow(), 2);
		assert.equal(dialogs.length, 1);
		dialogs[0].settle("allow");
		await Promise.resolve();
		assert.equal(dialogs.length, 2, "the forced state holds until the queue is empty");
	});

	it("/approvals with nothing waiting returns 0 and opens nothing", () => {
		assert.equal(server.openNow(), 0);
	});

	it("without a UI an ask is denied with reason no-ui (not a user decline)", () => {
		const a = file();
		ui.hasUI = false;
		poll();
		assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "no-ui"]);
		assert.equal(dialogs.length, 0);
		assert.deepEqual(kinds(), ["no-ui"]);
	});

	it("a cancel aborts the open dialog and replies cancelled; a queued request is cancelled without one", async () => {
		const requests = [file(), file()];
		poll();
		const open = requests.find((r) => r.id === dialogs[0].request.id) as AskRequest;
		const queued = requests.find((r) => r !== open) as AskRequest;
		writeCancel(dir, open.id);
		writeCancel(dir, queued.id);
		poll();
		assert.equal(dialogs[0].signal.aborted, true);
		await Promise.resolve();
		assert.equal(replyOf(open)?.decision, "cancelled");
		assert.equal(replyOf(queued)?.decision, "cancelled");
		assert.equal(dialogs.length, 1);
		assert.deepEqual(kinds().filter((k) => k === "cancelled").length, 2);
		assert.equal(server.pending(), 0);
	});

	it("a request whose child died is dropped: no reply, its files go, an open dialog is closed", async () => {
		const a = file();
		poll();
		assert.equal(dialogs.length, 1);
		alive = false;
		poll();
		assert.equal(dialogs[0].signal.aborted, true);
		await Promise.resolve();
		assert.equal(replyOf(a), undefined);
		assert.equal(server.pending(), 0);
		assert.deepEqual(kinds(), ["dropped"]);
	});

	it("a request nobody answered in the TTL is denied with reason timeout", () => {
		const a = file();
		ui.popup = "badge";
		poll();
		clock += ASK_TTL_MS;
		poll();
		assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "timeout"]);
		assert.equal(server.pending(), 0);
	});

	it("the TTL follows backgroundAskTimeoutMs: pending at 16 minutes, timed out after 21 with a 20 minute wait", () => {
		assert.equal(askTtlMs(5 * 60_000), ASK_TTL_MS);
		assert.equal(askTtlMs(20 * 60_000), 21 * 60_000);
		start({ ttlMs: askTtlMs(20 * 60_000) });
		const a = file();
		ui.popup = "badge";
		poll();
		clock += 16 * 60_000;
		poll();
		assert.equal(replyOf(a), undefined);
		assert.equal(server.pending(), 1);
		clock += 5 * 60_000 + 1;
		poll();
		assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "timeout"]);
	});

	it("a ttlMs function is read at every poll: a longer limit keeps a pending ask, a shorter one times it out", () => {
		let limit = askTtlMs(5 * 60_000);
		start({ ttlMs: () => limit });
		const a = file();
		ui.popup = "badge";
		poll();
		clock += 10 * 60_000;
		limit = askTtlMs(20 * 60_000); // raised before the old limit passed
		poll();
		clock += 10 * 60_000; // 20 minutes since it arrived
		poll();
		assert.equal(replyOf(a), undefined);
		assert.equal(server.pending(), 1);
		limit = 19.5 * 60_000; // below the 20 minutes waited, above the mailbox sweep's grace
		poll();
		assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "timeout"]);
	});

	it("lowering the limit under an ask that waited longer still leaves its timeout reply for the child", () => {
		let limit = askTtlMs(30 * 60_000); // 31 minutes
		start({ ttlMs: () => limit });
		const a = file();
		ui.popup = "badge";
		poll();
		clock += 20 * 60_000;
		poll();
		assert.equal(replyOf(a), undefined);
		limit = askTtlMs(60_000); // 15 minutes now
		poll();
		assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "timeout"]);
		poll();
		assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "timeout"], "still there on the next poll");
	});

	it("stop removes the replies and claimed requests it left for children that are gone", () => {
		const answered = file();
		verdicts.set(answered.id, allow);
		poll();
		assert.equal(replyOf(answered)?.decision, "allow");
		alive = false; // the child died after its request was answered; nothing will read the reply
		server.stop();
		assert.deepEqual(readdirSync(join(dir, "replies")), []);
		assert.deepEqual(readdirSync(join(dir, "requests")), []);
	});

	it("stop keeps the reply of a child still running, which reads it and removes its own files", () => {
		const answered = file();
		verdicts.set(answered.id, allow);
		poll();
		server.stop();
		assert.equal(replyOf(answered)?.decision, "allow");
	});

	it("stop denies everything pending with parent-session-ended, closes the dialog, clears the badge and stops the timer", async () => {
		const open = file();
		const queued = file();
		poll();
		const late = file(); // arrived since the last poll
		server.stop();
		assert.equal(dialogs[0].signal.aborted, true);
		for (const r of [open, queued, late]) assert.deepEqual([replyOf(r)?.decision, replyOf(r)?.reason], ["deny", "parent-session-ended"]);
		assert.equal(timerStopped, true);
		assert.equal(kinds().filter((k) => k === "parent-gone").length, 3);
		await Promise.resolve();
		assert.equal(server.pending(), 0);
		// stopped: a later poll does nothing
		const after = file();
		poll();
		assert.equal(replyOf(after), undefined);
	});

	it("keeps <dir>/alive fresh, throttled to every 10 s, and removes it on stop", () => {
		const alive = (): boolean => heartbeatFresh(dir, process.pid, clock);
		assert.equal(alive(), true, "written at start");
		const written = (): number => (JSON.parse(readFileSync(join(dir, "alive"), "utf8")) as { at: number }).at;
		const first = written();
		clock += HEARTBEAT_EVERY_MS - 1000;
		poll();
		assert.equal(written(), first, "throttled");
		clock += 1100;
		poll();
		assert.equal(written(), clock);
		// a parent that stops polling goes stale
		clock += HEARTBEAT_STALE_MS;
		assert.equal(alive(), false);
		server.stop();
		assert.equal(existsSync(join(dir, "alive")), false);
	});

	it("a judge that throws denies (fail closed); more than MAX_QUEUE queued requests are denied unseen", () => {
		start({ judge: () => { throw new Error("boom"); } });
		const a = file();
		poll();
		assert.deepEqual([replyOf(a)?.decision, replyOf(a)?.reason], ["deny", "rules"]);

		start({ popup: () => "badge" });
		const requests: AskRequest[] = [];
		for (let i = 0; i < MAX_QUEUE + 3; i++) requests.push(file());
		// the mailbox hands out MAX_PER_PASS (64) per poll
		poll();
		poll();
		assert.equal(server.pending(), MAX_QUEUE);
		assert.equal(requests.filter((r) => replyOf(r)?.decision === "deny").length, 3);
	});

	it("a mode the request claimed that differs from the judged one is noted once, not believed", () => {
		const a = file({ childMode: "auto" });
		verdicts.set(a.id, { ...ask, claimed: "auto" });
		ui.popup = "badge";
		poll();
		poll();
		poll();
		assert.deepEqual(kinds(), ["clamped"]);
	});

	it("the default timer ticks on its own and is stopped by stop()", async () => {
		const real = startAskServer({ dir, judge: () => allow, ask: async () => "deny", hasUI: () => true, isIdle: () => true, editorEmpty: () => true, dialogBusy: () => false, popup: () => "idle", attention() {}, badge() {}, onEvent() {} });
		const a = file();
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(replyOf(a)?.decision, "allow");
		real.stop();
		const b = file();
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal(replyOf(b), undefined);
	});
});
