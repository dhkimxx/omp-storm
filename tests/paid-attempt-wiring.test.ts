/**
 * P5: the coordinator's wiring of the verified paid-attempt adapter.
 *
 * These tests use the controller over a fake main session and a structural fake of the host's Slice Y surface. They
 * cover the exact-owner/run binding with a zero baseline, the finite run budget, one-time native receipt ingestion,
 * explicit pending/unresolved states, retirement at finalization, a durable late receipt that must not charge the next
 * run, stock-host legacy behavior, and fail-closed handling of a present but malformed surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetCloseoutChoices } from "../src/runtime/closeout.ts";
import {
	activeLedgerRun,
	attachPaidAccounting,
	getLedgerRun,
	noteEvalModelCalls,
	recordEvalCost,
	recordPaidCost,
	resetLedger,
	spendNote,
	startLedgerRun,
} from "../src/runtime/ledger.ts";
import {
	PAID_ATTEMPT_REFUSAL_TAG,
	type PaidAttemptDecider,
	type PaidAttemptDecision,
	type PaidAttemptPendingView,
	type PaidAttemptReceiptView,
	type PaidAttemptsSurface,
} from "../src/runtime/paid-attempt-adapter.ts";
import type { StormConfig } from "../src/types.ts";
import { fakeSession, SESSION_TEAM, type FakeSession } from "./fake-session.ts";

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-paid-wiring-")));
});

afterEach(async () => {
	resetCloseoutChoices();
	resetLedger();
	await rm(root, { recursive: true, force: true });
});

const CONFIG: StormConfig = {
	...SESSION_TEAM,
	budget: { perRunUsd: 1, warnAtUsd: 0.8, onExceed: "block-spawns" },
};

interface FakePaid {
	readonly api: PaidAttemptsSurface;
	readonly authorizeCalls: Array<PaidAttemptDecider | undefined>;
	readonly add: (usd: number, over?: Partial<PaidAttemptReceiptView>) => PaidAttemptReceiptView;
	readonly addUnknown: (over?: Partial<PaidAttemptReceiptView>) => PaidAttemptReceiptView;
	readonly pend: (attemptId: string) => void;
	readonly invoke: () => PaidAttemptDecision;
}

/** The published surface shape, with a receipt store the test settles by hand. */
function fakePaid(owner: string): FakePaid {
	const authorizeCalls: Array<PaidAttemptDecider | undefined> = [];
	const receipts: PaidAttemptReceiptView[] = [];
	let pending: PaidAttemptPendingView[] = [];
	let decider: PaidAttemptDecider | undefined;
	let observedCost = 0;
	let lastSeq = 0;
	let serial = 0;
	const api: PaidAttemptsSurface = {
		ownerSessionId: owner,
		get managed(): boolean {
			return decider !== undefined;
		},
		authorize(next): void {
			authorizeCalls.push(next);
			decider = next;
		},
		state() {
			return {
				observedCost,
				pending: pending.map(item => ({ ...item })),
				unresolved: receipts.filter(receipt => receipt.costBasis === "unknown"),
				lastSeq,
			};
		},
		receipts() {
			return receipts.map(receipt => ({ ...receipt }));
		},
		onReceipt() {
			return () => undefined;
		},
	};
	const add = (usd: number, over: Partial<PaidAttemptReceiptView> = {}): PaidAttemptReceiptView => {
		const n = ++serial;
		const seq = ++lastSeq;
		const receipt: PaidAttemptReceiptView = {
			attemptId: `a${n}`,
			seq,
			sessionId: owner,
			actorSessionId: owner,
			purpose: "loop",
			provider: "openai",
			model: "gpt-test",
			attempt: 1,
			startedAt: 1_000,
			settledAt: 2_000,
			gate: "admitted",
			sent: true,
			outcome: "completed",
			costBasis: "observed",
			costTotal: usd,
			append: "flushed",
			receiptEntryId: `entry-${n}`,
			...over,
		};
		receipts.push(receipt);
		pending = pending.filter(item => item.attemptId !== receipt.attemptId);
		observedCost += usd;
		return receipt;
	};
	const addUnknown = (over: Partial<PaidAttemptReceiptView> = {}): PaidAttemptReceiptView => {
		const n = ++serial;
		const seq = ++lastSeq;
		const receipt: PaidAttemptReceiptView = {
			attemptId: `u${n}`,
			seq,
			sessionId: owner,
			actorSessionId: owner,
			purpose: "loop",
			provider: "openai",
			model: "gpt-test",
			attempt: 1,
			startedAt: 1_000,
			settledAt: 2_000,
			gate: "admitted",
			sent: true,
			outcome: "completed",
			costBasis: "unknown",
			append: "flushed",
			receiptEntryId: `entry-${n}`,
			...over,
		};
		receipts.push(receipt);
		pending = pending.filter(item => item.attemptId !== receipt.attemptId);
		return receipt;
	};
	return {
		api,
		authorizeCalls,
		add,
		addUnknown,
		pend(attemptId: string): void {
			pending = [...pending, { attemptId, model: "gpt-test", purpose: "loop", actorSessionId: owner }];
		},
		invoke() {
			if (decider === undefined) throw new Error("no paid-attempt decision installed");
			return decider(
				{
					attemptId: "next",
					sessionId: owner,
					actorSessionId: owner,
					purpose: "loop",
					provider: "openai",
					model: "gpt-test",
					attempt: 1,
					startedAt: 3_000,
				},
				api.state(),
			);
		},
	};
}

function withPaid(h: FakeSession, paid: FakePaid): void {
	Object.assign(h.ctx, { paidAttempts: paid.api });
}

describe("coordinator paid-attempt wiring", () => {
	test("binds exact owner/run with a zero baseline, ingests receipts once, keeps pending explicit, and retires", async () => {
		const owner = "native-owner-a";
		const paid = fakePaid(owner);
		const h = fakeSession({ root, sessionId: owner, config: CONFIG });
		withPaid(h, paid);
		const runId = await h.start();
		const ledger = getLedgerRun(runId);
		expect(ledger?.paid).toMatchObject({
			ownerSessionId: owner,
			startSeq: 0,
			startCostUsd: 0,
			limitUsd: 1,
			pending: 0,
			unresolved: 0,
			accounting: "effective",
		});
		expect(paid.authorizeCalls).toHaveLength(1);

		paid.add(0.25);
		h.controller.ingestPaidSpend();
		expect(ledger?.costUsd).toBeCloseTo(0.25);
		h.controller.ingestPaidSpend();
		expect(ledger?.costUsd).toBeCloseTo(0.25);

		paid.pend("p1");
		h.controller.ingestPaidSpend();
		expect(spendNote(ledger)).toEqual({ lowerBound: true, paidPending: 1 });
		paid.add(0.5, { attemptId: "p1" });
		h.controller.ingestPaidSpend();
		expect(ledger?.costUsd).toBeCloseTo(0.75);
		expect(spendNote(ledger)).toBeUndefined();

		paid.addUnknown();
		h.controller.ingestPaidSpend();
		expect(ledger?.costUsd).toBeCloseTo(0.75);
		expect(spendNote(ledger)).toEqual({ lowerBound: true, paidUnresolved: 1 });

		const final = await h.controller.finish("no-changes");
		expect(paid.authorizeCalls.at(-1)).toBeUndefined();
		expect(getLedgerRun(runId)).toBeUndefined();
		expect(final?.costUsd).toBeCloseTo(0.75);
		expect(final?.spend).toEqual({ lowerBound: true, paidUnresolved: 1 });
	});

	test("block-spawns keeps exact overrun accounting; its dispatch gates, not the provider gate, refuse new work", async () => {
		const owner = "native-owner-budget";
		const paid = fakePaid(owner);
		const h = fakeSession({ root, sessionId: owner, config: CONFIG });
		withPaid(h, paid);
		const runId = await h.start();
		expect(getLedgerRun(runId)?.paid?.limitUsd).toBe(1);
		expect(paid.invoke().send).toBe(true);

		paid.add(1.2);
		h.controller.ingestPaidSpend();
		expect(getLedgerRun(runId)?.exceeded).toBe(true);
		// block-spawns leaves the current turns and director alive; new spawns/messages are refused by Storm's gates.
		expect(paid.invoke().send).toBe(true);
		await h.controller.finish("budget");
	});

	test("stop keeps the adapter's exact next-send refusal after the limit", async () => {
		const owner = "native-owner-stop";
		const paid = fakePaid(owner);
		const stopConfig: StormConfig = {
			...CONFIG,
			budget: { perRunUsd: 1, warnAtUsd: 0.8, onExceed: "stop" },
		};
		const h = fakeSession({ root, sessionId: owner, config: stopConfig });
		withPaid(h, paid);
		const runId = await h.start();
		// A stop aborts the active turn; keep it open so the installed next-send decision is still observable.
		h.controller.onAgentStart();
		paid.add(1.2);
		h.controller.ingestPaidSpend();
		expect(getLedgerRun(runId)?.exceeded).toBe(true);
		const decision = paid.invoke();
		expect(decision.send).toBe(false);
		if (decision.send === false) expect(decision.reason).toContain("limit-exceeded");
		await h.controller.finish("budget");
	});

	test("journal carriers add nothing while native receipts own the run", () => {
		const run = startLedgerRun({ runId: "run-native", sessionId: "owner", sessionDir: "/profile/storm/sessions/native", repoId: "repo", root: "/work", startedAt: 0 });
		attachPaidAccounting(run.runId, {
			ownerSessionId: "owner",
			bindingToken: "storm-paid-attempt:test",
			startSeq: 0,
			startCostUsd: 0,
			receiptsUsd: 0,
			receipts: 0,
			lastSeq: 0,
			pending: 0,
			unresolved: 0,
			accounting: "effective",
		});
		noteEvalModelCalls(run.runId, "session.jsonl");
		recordEvalCost(run.runId, "session.jsonl", 3);
		expect(run.costUsd).toBe(0);
		expect(run.evalUnread.size).toBe(0);
		expect(spendNote(run)).toBeUndefined();
		recordPaidCost(run.runId, { "gpt-test": 0.25 }, 0.25, "(unknown)");
		expect(run.costUsd).toBeCloseTo(0.25);
		expect(spendNote(run)).toBeUndefined();
	});

	test("a stock host keeps the legacy accounting and installs no native binding", async () => {
		const h = fakeSession({ root, sessionId: "stock-owner", config: CONFIG });
		const runId = await h.start();
		expect(getLedgerRun(runId)?.paid).toBeUndefined();
		expect(activeLedgerRun(h.sessionDir)?.runId).toBe(runId);
		await h.controller.finish("no-changes");
	});

	test("a present but malformed surface fails the start closed instead of falling back", async () => {
		const h = fakeSession({ root, sessionId: "broken-owner", config: CONFIG });
		Object.assign(h.ctx, { paidAttempts: { ownerSessionId: h.sessionId, managed: true } });
		const started = await h.controller.start(h.ctx, { task: "x" });
		expect(started.ok).toBe(false);
		if (started.ok === false) expect(started.reason).toContain(PAID_ATTEMPT_REFUSAL_TAG);
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
	});

	test("an earlier run's unresolved receipt does not make the next run's total a floor", async () => {
		const owner = "native-owner-prior-unknown";
		const paid = fakePaid(owner);
		const first = fakeSession({ root, sessionId: owner, config: CONFIG });
		withPaid(first, paid);
		await first.start();
		paid.addUnknown();
		first.controller.ingestPaidSpend();
		const firstFinal = await first.controller.finish("no-changes");
		expect(firstFinal?.spend).toEqual({ lowerBound: true, paidUnresolved: 1 });

		const second = fakeSession({ root, sessionId: owner, config: CONFIG });
		withPaid(second, paid);
		const secondRun = await second.start();
		second.controller.ingestPaidSpend();
		expect(getLedgerRun(secondRun)?.costUsd).toBe(0);
		expect(spendNote(getLedgerRun(secondRun))).toBeUndefined();
		await second.controller.finish("no-changes");
	});

	test("durable late receipts of a retired run never charge the next run", async () => {
		const owner = "native-owner-late";
		const paid = fakePaid(owner);
		const first = fakeSession({ root, sessionId: owner, config: CONFIG });
		withPaid(first, paid);
		await first.start();
		paid.add(0.4);
		first.controller.ingestPaidSpend();
		paid.pend("late-before");
		paid.pend("late-after");
		const firstFinal = await first.controller.finish("no-changes");
		expect(firstFinal?.costUsd).toBeCloseTo(0.4);
		expect(firstFinal?.spend).toEqual({ lowerBound: true, paidPending: 2 });

		const second = fakeSession({ root, sessionId: owner, config: CONFIG });
		withPaid(second, paid);
		const secondRun = await second.start();
		expect(getLedgerRun(secondRun)?.paid?.startSeq).toBe(1);
		// Both settle after the next run is already bound; their seq is in its range, their attempt ids are not.
		paid.add(0.9, { attemptId: "late-before" });
		paid.add(0.7, { attemptId: "late-after" });
		second.controller.ingestPaidSpend();
		expect(getLedgerRun(secondRun)?.costUsd).toBe(0);
		expect(spendNote(getLedgerRun(secondRun))).toBeUndefined();
		expect(paid.invoke().send).toBe(true);
		paid.add(0.2);
		second.controller.ingestPaidSpend();
		expect(getLedgerRun(secondRun)?.costUsd).toBeCloseTo(0.2);
		await second.controller.finish("no-changes");
	});
});
