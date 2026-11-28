/**
 * P5: the narrow paid-attempt adapter over the published Slice Y shape.
 *
 * These tests use a fake structural `ctx.paidAttempts`, not the private host package. They cover stock 19.2.1's absent
 * surface, positive owner/authorization establishment, pending as unknown, finite-limit refusal, unresolved pricing and
 * append proof, immutable monotone receipts, revocation, deterministic cleanup, and the baseline rule that keeps a
 * mid-run binding from double-adding an earlier native receipt (and keeps legacy message/journal cost out).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	bindPaidAttemptAdapter,
	PAID_ATTEMPT_CLAIMS,
	PAID_ATTEMPT_REFUSAL_TAG,
	type PaidAttemptAdapter,
	type PaidAttemptBindOptions,
	type PaidAttemptBindResult,
	type PaidAttemptDecider,
	type PaidAttemptDecision,
	type PaidAttemptGate,
	type PaidAttemptPendingView,
	type PaidAttemptReceiptView,
	type PaidAttemptRefusalGate,
	type PaidAttemptRequestView,
	type PaidAttemptsSurface,
} from "../src/runtime/paid-attempt-adapter.ts";

interface FakeHostDecision {
	readonly decision: PaidAttemptDecision;
	readonly attemptId: string;
	readonly receipt?: PaidAttemptReceiptView;
}

interface FakeHost {
	readonly api: PaidAttemptsSurface;
	readonly add: (overrides?: Partial<PaidAttemptReceiptView>) => PaidAttemptReceiptView;
	readonly addWithoutCost: (overrides?: Partial<PaidAttemptReceiptView>) => PaidAttemptReceiptView;
	readonly addUnflushed: (overrides?: Partial<PaidAttemptReceiptView>) => PaidAttemptReceiptView;
	readonly addFailed: (overrides?: Partial<PaidAttemptReceiptView>) => PaidAttemptReceiptView;
	readonly markFlushed: (attemptId: string) => PaidAttemptReceiptView;
	readonly duplicateFirst: () => PaidAttemptReceiptView;
	readonly mutate: (index: number, changes: Partial<PaidAttemptReceiptView>) => void;
	readonly pend: (attemptId: string, overrides?: Partial<PaidAttemptPendingView>) => void;
	readonly settlePending: (attemptId: string, overrides?: Partial<PaidAttemptReceiptView>) => PaidAttemptReceiptView;
	readonly invoke: (overrides?: Partial<PaidAttemptRequestView>) => PaidAttemptDecision;
	readonly invokeThroughHost: (overrides?: Partial<PaidAttemptRequestView>) => FakeHostDecision;
	readonly request: (overrides?: Partial<PaidAttemptRequestView>) => PaidAttemptRequestView;
	readonly authorization: () => PaidAttemptDecider | undefined;
	readonly authorizeCalls: Array<PaidAttemptDecider | undefined>;
	readonly receipts: PaidAttemptReceiptView[];
	readonly pending: PaidAttemptPendingView[];
	readonly hostUnresolved: PaidAttemptReceiptView[];
	readonly observed: () => number;
	readonly setManaged: (value: boolean) => void;
	readonly setStateThrows: (value: boolean) => void;
	readonly setReceiptsThrows: (value: boolean) => void;
}

function fakeHost(
	options: {
		readonly owner?: string;
		readonly managed?: boolean;
		readonly authorizeThrows?: boolean;
		/** Real host shape: managed is false until a decider is installed, then follows the decider. */
		readonly reactiveManaged?: boolean;
		/** A lying surface that renames its owner as soon as a decision is installed. */
		readonly ownerAfterAuthorize?: string;
	} = {},
): FakeHost {
	let owner = options.owner ?? "owner-1";
	const reactiveManaged = options.reactiveManaged === true;
	let managed = options.managed ?? !reactiveManaged;
	let authorizeThrows = options.authorizeThrows ?? false;
	let stateThrows = false;
	let receiptsThrows = false;
	let authorized: PaidAttemptDecider | undefined;
	const authorizeCalls: Array<PaidAttemptDecider | undefined> = [];
	const receipts: PaidAttemptReceiptView[] = [];
	const pending: PaidAttemptPendingView[] = [];
	const hostUnresolved: PaidAttemptReceiptView[] = [];
	let observedCost = 0;
	let lastSeq = 0;
	let serial = 0;

	const api: PaidAttemptsSurface = {
		get ownerSessionId(): string {
			return owner;
		},
		get managed(): boolean {
			return managed;
		},
		authorize(decider): void {
			authorizeCalls.push(decider);
			if (authorizeThrows) throw new Error("read-only authority");
			authorized = decider;
			if (reactiveManaged) managed = decider !== undefined;
			if (options.ownerAfterAuthorize !== undefined) owner = options.ownerAfterAuthorize;
		},
		state() {
			if (stateThrows) throw new Error("state unavailable");
			return {
				observedCost,
				pending: pending.map(item => ({ ...item })),
				unresolved: [...hostUnresolved],
				lastSeq,
			};
		},
		receipts() {
			if (receiptsThrows) throw new Error("receipts unavailable");
			return [...receipts];
		},
		onReceipt(_next): () => void {
			return () => {};
		},
	};

	const makeReceipt = (overrides: Partial<PaidAttemptReceiptView> = {}): PaidAttemptReceiptView => {
		const n = ++serial;
		return {
			attemptId: `a${n}`,
			seq: n,
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
			costTotal: 0,
			append: "flushed",
			receiptEntryId: `entry-${n}`,
			...overrides,
		};
	};

	const record = (receipt: PaidAttemptReceiptView): PaidAttemptReceiptView => {
		receipts.push(receipt);
		lastSeq = Math.max(lastSeq, receipt.seq);
		if (receipt.costBasis === "observed" && typeof receipt.costTotal === "number") observedCost += receipt.costTotal;
		const index = pending.findIndex(item => item.attemptId === receipt.attemptId);
		if (index >= 0) pending.splice(index, 1);
		return receipt;
	};

	const add = (overrides: Partial<PaidAttemptReceiptView> = {}): PaidAttemptReceiptView => record(makeReceipt(overrides));

	const addWithoutCost = (overrides: Partial<PaidAttemptReceiptView> = {}): PaidAttemptReceiptView => {
		const receipt: Record<string, unknown> = { ...makeReceipt(overrides), costBasis: "unknown" };
		delete receipt.costTotal;
		return record(receipt as unknown as PaidAttemptReceiptView);
	};

	const addUnflushed = (overrides: Partial<PaidAttemptReceiptView> = {}): PaidAttemptReceiptView => {
		const receipt: Record<string, unknown> = { ...makeReceipt(overrides), append: "unavailable" };
		delete receipt.receiptEntryId;
		return record(receipt as unknown as PaidAttemptReceiptView);
	};

	const addFailed = (overrides: Partial<PaidAttemptReceiptView> = {}): PaidAttemptReceiptView => {
		const receipt: Record<string, unknown> = { ...makeReceipt(overrides), append: "failed" };
		delete receipt.receiptEntryId;
		return record(receipt as unknown as PaidAttemptReceiptView);
	};

	const markFlushed = (attemptId: string): PaidAttemptReceiptView => {
		const index = receipts.findIndex(item => item.attemptId === attemptId);
		if (index < 0) throw new Error(`no receipt ${attemptId}`);
		const current = receipts[index];
		if (current === undefined) throw new Error(`no receipt ${attemptId}`);
		const next: PaidAttemptReceiptView = { ...current, append: "flushed", receiptEntryId: `late-${current.seq}` };
		receipts[index] = next;
		return next;
	};

	const duplicateFirst = (): PaidAttemptReceiptView => {
		const first = receipts[0];
		if (first === undefined) throw new Error("no receipt to duplicate");
		receipts.push(first);
		return first;
	};

	const mutate = (index: number, changes: Partial<PaidAttemptReceiptView>): void => {
		const current = receipts[index];
		if (current === undefined) throw new Error("no receipt to mutate");
		const next = { ...current, ...changes };
		const oldCost = current.costBasis === "observed" && typeof current.costTotal === "number" ? current.costTotal : 0;
		const newCost = next.costBasis === "observed" && typeof next.costTotal === "number" ? next.costTotal : 0;
		observedCost += newCost - oldCost;
		receipts[index] = next;
	};

	const pend = (attemptId: string, overrides: Partial<PaidAttemptPendingView> = {}): void => {
		pending.push({ attemptId, model: "gpt-test", purpose: "loop", actorSessionId: owner, ...overrides });
	};

	const request = (overrides: Partial<PaidAttemptRequestView> = {}): PaidAttemptRequestView => ({
		attemptId: "next-attempt",
		sessionId: owner,
		actorSessionId: owner,
		purpose: "loop",
		provider: "openai",
		model: "gpt-test",
		attempt: 1,
		startedAt: 3_000,
		...overrides,
	});

	const invoke = (overrides: Partial<PaidAttemptRequestView> = {}) => {
		const decider = authorized;
		if (decider === undefined) throw new Error("no decision is installed");
		return decider(request(overrides), api.state());
	};

	const invokeThroughHost = (overrides: Partial<PaidAttemptRequestView> = {}): FakeHostDecision => {
		const attempt = request(overrides);
		const decider = authorized;
		if (decider === undefined) throw new Error("no decision is installed");
		const decision = decider(attempt, api.state());
		if (decision.send) {
			pending.push({
				attemptId: attempt.attemptId,
				model: attempt.model,
				purpose: attempt.purpose,
				actorSessionId: attempt.actorSessionId,
			});
			return { decision, attemptId: attempt.attemptId };
		}
		const receipt: Record<string, unknown> = {
			...makeReceipt({
				attemptId: attempt.attemptId,
				sessionId: attempt.sessionId,
				actorSessionId: attempt.actorSessionId,
				purpose: attempt.purpose,
				provider: attempt.provider,
				model: attempt.model,
				attempt: attempt.attempt,
				startedAt: attempt.startedAt,
				gate: "refused",
				sent: false,
				outcome: "refused",
				costBasis: "unknown",
				append: "flushed",
			}),
			receiptEntryId: `refused-${lastSeq + 1}`,
		};
		delete receipt.costTotal;
		const recorded = record(receipt as unknown as PaidAttemptReceiptView);
		// The host keeps refused receipts in `state.unresolved` because their cost basis is unknown.
		hostUnresolved.push(recorded);
		return { decision, attemptId: attempt.attemptId, receipt: recorded };
	};

	return {
		api,
		add,
		addWithoutCost,
		addUnflushed,
		addFailed,
		markFlushed,
		duplicateFirst,
		mutate,
		pend,
		settlePending: (attemptId: string, overrides: Partial<PaidAttemptReceiptView> = {}) => add({ attemptId, ...overrides }),
		invoke,
		invokeThroughHost,
		request,
		authorization: () => authorized,
		authorizeCalls,
		receipts,
		pending,
		hostUnresolved,
		observed: () => observedCost,
		setManaged: (value: boolean) => {
			managed = value;
		},
		setStateThrows: (value: boolean) => {
			stateThrows = value;
		},
		setReceiptsThrows: (value: boolean) => {
			receiptsThrows = value;
		},
	};
}

const opened: PaidAttemptAdapter[] = [];

afterEach(() => {
	for (const adapter of opened.splice(0)) adapter.dispose();
});

const bound = (result: PaidAttemptBindResult): PaidAttemptAdapter => {
	if (result.status !== "bound") throw new Error(`expected a binding, got ${result.code}: ${result.detail}`);
	return result.adapter;
};

const bind = (fake: FakeHost, overrides: Partial<PaidAttemptBindOptions> = {}): PaidAttemptAdapter => {
	const adapter = bound(
		bindPaidAttemptAdapter({
			ctx: { paidAttempts: fake.api },
			runId: "run-1",
			ownerSessionId: fake.api.ownerSessionId,
			limitUsd: 1,
			spentUsd: 0,
			...overrides,
		}),
	);
	opened.push(adapter);
	return adapter;
};

const refusal = (gate: PaidAttemptGate): PaidAttemptRefusalGate => {
	if (gate.send) throw new Error("expected a refusal");
	return gate;
};

describe("stock 19.2.1 and unusable authorities", () => {
	test("an absent paidAttempts surface is unavailable and leaves legacy accounting disclosed", () => {
		const result = bindPaidAttemptAdapter({
			ctx: { sessionId: "session-1" },
			runId: "run-stock",
			ownerSessionId: "owner-stock",
			limitUsd: 1,
			spentUsd: 0,
		});
		expect(result.status).toBe("unavailable");
		if (result.status !== "unavailable") return;
		expect(result.code).toBe("host-absent");
		expect(result.metadata).toMatchObject({
			kind: "storm.paid-attempt-adapter",
			hostShape: "19.2.1-slice-y",
			apiPath: "ctx.paidAttempts",
			available: false,
			authorization: "not-installed",
			nativeAccounting: "unavailable",
			legacyCostPolicy: "legacy-allowed",
			addAssistantMessageCost: true,
			addJournalCost: true,
			resendOnRefusal: false,
			startCostUsd: 0,
			limit: { mode: "finite", usd: 1 },
			claims: PAID_ATTEMPT_CLAIMS,
		});
		expect(result.metadata.claims).toEqual({ release: false, pooledEnabled: false, throughput: false });
	});

	test("a mismatched owner never authorizes", () => {
		const mismatch = fakeHost({ owner: "host-owner" });
		const mismatchResult = bindPaidAttemptAdapter({
			ctx: { paidAttempts: mismatch.api },
			runId: "run-mismatch",
			ownerSessionId: "run-owner",
			limitUsd: 1,
			spentUsd: 0,
		});
		expect(mismatchResult.status).toBe("unavailable");
		if (mismatchResult.status === "unavailable") {
			expect(mismatchResult.code).toBe("host-owner-mismatch");
			expect(mismatchResult.metadata.hostOwnerSessionId).toBe("host-owner");
		}
		expect(mismatch.authorizeCalls).toHaveLength(0);
	});

	test("a fresh unmanaged real-shape owner becomes managed only after this authorize", () => {
		const fake = fakeHost({ owner: "owner-reactive", reactiveManaged: true });
		expect(fake.api.managed).toBe(false);
		const adapter = bind(fake);
		expect(fake.api.managed).toBe(true);
		expect(fake.authorizeCalls).toHaveLength(1);
		expect(typeof fake.authorizeCalls[0]).toBe("function");
		expect(adapter.metadata).toMatchObject({
			available: true,
			authorization: "installed",
			nativeAccounting: "effective",
			hostOwnerSessionId: "owner-reactive",
		});
		expect(adapter.check().send).toBe(true);
		expect(adapter.dispose()).toEqual({ disposed: true });
		expect(fake.api.managed).toBe(false);
		expect(fake.authorizeCalls).toHaveLength(2);
		expect(fake.authorizeCalls[1]).toBeUndefined();
	});

	test("an owner that changes immediately after authorize is rejected and not undone", () => {
		const fake = fakeHost({ owner: "owner-before", ownerAfterAuthorize: "owner-after" });
		const result = bindPaidAttemptAdapter({
			ctx: { paidAttempts: fake.api },
			runId: "run-owner-change",
			ownerSessionId: "owner-before",
			limitUsd: 1,
			spentUsd: 0,
		});
		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") {
			expect(result.code).toBe("host-owner-mismatch");
			expect(result.metadata.hostOwnerSessionId).toBe("owner-before");
		}
		expect(fake.authorizeCalls).toHaveLength(1);
		expect(typeof fake.authorizeCalls[0]).toBe("function");
	});

	test("a lying surface that stays false and a throwing proxy are never unauthorized", () => {
		const lying = fakeHost({ owner: "owner-lying", managed: false });
		const lyingResult = bindPaidAttemptAdapter({
			ctx: { paidAttempts: lying.api },
			runId: "run-lying",
			ownerSessionId: "owner-lying",
			limitUsd: 1,
			spentUsd: 0,
		});
		expect(lyingResult.status).toBe("unavailable");
		if (lyingResult.status === "unavailable") {
			expect(lyingResult.code).toBe("host-unmanaged");
			expect(lyingResult.metadata.addJournalCost).toBe(true);
		}
		expect(lying.authorizeCalls).toHaveLength(1);
		expect(typeof lying.authorizeCalls[0]).toBe("function");

		const readOnly = fakeHost({ owner: "owner-readonly", authorizeThrows: true });
		const readOnlyResult = bindPaidAttemptAdapter({
			ctx: { paidAttempts: readOnly.api },
			runId: "run-readonly",
			ownerSessionId: "owner-readonly",
			limitUsd: 1,
			spentUsd: 0,
		});
		expect(readOnlyResult.status).toBe("unavailable");
		if (readOnlyResult.status === "unavailable") expect(readOnlyResult.code).toBe("host-readonly");
		expect(readOnly.authorization()).toBeUndefined();
		expect(readOnly.authorizeCalls).toHaveLength(1);
		expect(typeof readOnly.authorizeCalls[0]).toBe("function");
		expect(readOnlyResult.metadata.addJournalCost).toBe(true);
	});
});

describe("positive binding and the pre-send decision", () => {
	test("the exact owner installs one decision", () => {
		const fake = fakeHost({ owner: "owner-bound" });
		const adapter = bind(fake);
		expect(fake.authorizeCalls).toHaveLength(1);
		expect(typeof fake.authorization()).toBe("function");
		expect(adapter.metadata).toMatchObject({
			available: true,
			authorization: "installed",
			nativeAccounting: "effective",
			legacyCostPolicy: "native-only",
			addAssistantMessageCost: false,
			addJournalCost: false,
			startSeq: 0,
			startCostUsd: 0,
			claims: PAID_ATTEMPT_CLAIMS,
		});
		expect(adapter.metadata.bindingToken).toContain("owner-bound");
		expect(adapter.check()).toEqual({
			send: true,
			knownCostUsd: 0,
			lastSeq: 0,
			pendingCount: 0,
			unresolvedCount: 0,
		});
		expect(fake.invoke()).toEqual({ send: true });
	});

	test("a pending attempt is unknown, not zero, and blocks finite dispatch until it settles", () => {
		const fake = fakeHost({ owner: "owner-pending" });
		fake.pend("pending-1");
		const adapter = bind(fake, { limitUsd: 0.01 });
		const blocked = refusal(adapter.check());
		expect(blocked.code).toBe("unresolved-pending");
		expect(blocked.knownCostUsd).toBe(0);
		expect(blocked.pendingCount).toBe(1);
		const decision = fake.invoke();
		expect(decision.send).toBe(false);
		if (!decision.send) expect(decision.reason).toContain("unresolved-pending");

		const observation = adapter.observe();
		expect(observation.knownCostUsd).toBe(0);
		expect(observation.pendingCount).toBe(1);
		expect(observation.pending[0]).toMatchObject({ attemptId: "pending-1", model: "gpt-test" });
		expect(observation.byModel["gpt-test"]?.pendingAttempts).toBe(1);
		expect(observation.complete).toBe(false);

		fake.settlePending("pending-1", { costTotal: 0.004 });
		expect(adapter.check()).toMatchObject({ send: true, knownCostUsd: 0.004, pendingCount: 0 });
		expect(adapter.observe().knownCostUsd).toBeCloseTo(0.004);
	});

	test("finite mode refuses the next attempt only after exact authorized cost exceeds the limit", () => {
		const fake = fakeHost({ owner: "owner-limit" });
		const adapter = bind(fake, { limitUsd: 0.01 });
		fake.add({ costTotal: 0.004 });
		expect(adapter.check().send).toBe(true);
		fake.add({ costTotal: 0.006 });
		expect(adapter.check().send).toBe(true);
		expect(adapter.check().knownCostUsd).toBeCloseTo(0.01);
		fake.add({ costTotal: 0.000001 });

		const over = refusal(adapter.check());
		expect(over.code).toBe("limit-exceeded");
		expect(over.reason.startsWith(PAID_ATTEMPT_REFUSAL_TAG)).toBe(true);
		const hostRefusal = fake.invokeThroughHost();
		expect(hostRefusal.decision.send).toBe(false);
		if (!hostRefusal.decision.send) expect(hostRefusal.decision.reason).toContain("limit-exceeded");
		expect(hostRefusal.receipt?.gate).toBe("refused");
		expect(hostRefusal.receipt?.sent).toBe(false);
		expect(adapter.metadata.resendOnRefusal).toBe(false);
		expect(refusal(adapter.check()).code).toBe("limit-exceeded");
		const observation = adapter.observe();
		expect(observation.knownCostUsd).toBeCloseTo(0.010001);
		expect(observation.unresolvedCount).toBe(0);
		expect(observation.complete).toBe(true);
		expect(fake.receipts).toHaveLength(4);
		expect(fake.receipts[3]?.seq).toBe(4);
		expect(fake.pending).toHaveLength(0);
	});

	test("an unbounded observer reports pending but makes no budget refusal", () => {
		const fake = fakeHost({ owner: "owner-unbounded" });
		const adapter = bound(
			bindPaidAttemptAdapter({
				ctx: { paidAttempts: fake.api },
				runId: "run-unbounded",
				ownerSessionId: "owner-unbounded",
			}),
		);
		opened.push(adapter);
		fake.pend("pending-u");
		expect(adapter.metadata.limit).toEqual({ mode: "unbounded" });
		expect(adapter.check()).toMatchObject({ send: true, knownCostUsd: 0, pendingCount: 1 });
		expect(adapter.observe().complete).toBe(false);
	});
});

describe("unresolved receipts, owner proof and sequence proof", () => {
	test("unknown pricing and an unproved append stay unresolved and never enter the total as zero", () => {
		const fake = fakeHost({ owner: "owner-unresolved" });
		const adapter = bind(fake, { limitUsd: 1 });
		fake.addWithoutCost();
		const unknown = refusal(adapter.check());
		expect(unknown.code).toBe("unresolved-receipt");
		expect(unknown.detail).toContain("unknown-pricing");
		const first = adapter.observe();
		expect(first.knownCostUsd).toBe(0);
		expect(first.unresolvedCount).toBe(1);
		expect(first.unresolved[0]?.reasons).toContain("unknown-pricing");
		expect(first.byModel["gpt-test"]?.unresolvedReceipts).toBe(1);
		expect(first.complete).toBe(false);

		fake.addFailed({ costTotal: 0.002 });
		const unproven = refusal(adapter.check());
		expect(unproven.code).toBe("unresolved-receipt");
		expect(unproven.detail).toContain("append-unproven");
		const second = adapter.observe();
		expect(second.knownCostUsd).toBeCloseTo(0.002);
		expect(second.unresolvedCount).toBe(2);
		expect(second.byModel["gpt-test"]?.knownUsd).toBeCloseTo(0.002);
		expect(second.complete).toBe(false);
	});

	test("an append proof that arrives later resolves the same receipt without counting it twice", () => {
		const fake = fakeHost({ owner: "owner-append-late" });
		const adapter = bind(fake, { limitUsd: 1 });
		const receipt = fake.addUnflushed({ costTotal: 0.002 });
		expect(refusal(adapter.check()).code).toBe("unresolved-receipt");
		expect(adapter.observe().knownCostUsd).toBeCloseTo(0.002);
		expect(adapter.observe().complete).toBe(false);
		const before = adapter.takeDelta();
		expect(before.usd).toBeCloseTo(0.002);
		expect(before.settledReceipts).toBe(1);

		fake.markFlushed(receipt.attemptId);
		expect(adapter.check()).toMatchObject({ send: true, knownCostUsd: 0.002, unresolvedCount: 0 });
		expect(adapter.observe().complete).toBe(true);
		const after = adapter.takeDelta();
		expect(after.usd).toBe(0);
		expect(after.settledReceipts).toBe(0);
	});

	test("a bypassed receipt is unresolved even with observed cost and a flushed append", () => {
		const fake = fakeHost({ owner: "owner-bypassed" });
		const adapter = bind(fake, { limitUsd: 1 });
		const receipt = fake.add({ gate: "bypassed", sent: "unknown", outcome: "unknown", costTotal: 0.003 });
		fake.hostUnresolved.push(receipt);
		const blocked = refusal(adapter.check());
		expect(blocked.code).toBe("unresolved-receipt");
		const observation = adapter.observe();
		expect(observation.knownCostUsd).toBeCloseTo(0.003);
		expect(observation.unresolved[0]?.reasons).toContain("bypassed-gate");
		expect(observation.unresolved[0]?.reasons).toContain("host-unresolved");
	});

	test("an exact refused receipt is a known zero and does not poison later finite dispatch", () => {
		const fake = fakeHost({ owner: "owner-refused" });
		const adapter = bind(fake, { limitUsd: 0.001 });
		const refused = fake.addWithoutCost({ gate: "refused", sent: false, outcome: "refused" });
		fake.hostUnresolved.push(refused);
		expect(adapter.check().send).toBe(true);
		expect(adapter.observe().unresolvedCount).toBe(0);
		fake.add({ costTotal: 0.001 });
		expect(adapter.check().send).toBe(true);
	});

	test("a foreign owner receipt is a fault and a foreign owner attempt is refused before accounting", () => {
		const fake = fakeHost({ owner: "owner-scope" });
		const adapter = bind(fake, { limitUsd: 1 });
		fake.add({ sessionId: "someone-else" });
		const blocked = refusal(adapter.check());
		expect(blocked.code).toBe("receipt-unknown-owner");
		expect(adapter.observe().accounting).toBe("faulted");
		expect(adapter.observe().fault?.code).toBe("receipt-unknown-owner");

		const decision = fake.invoke({ sessionId: "someone-else" });
		expect(decision.send).toBe(false);
		if (!decision.send) expect(decision.reason).toContain("dispatch-owner-mismatch");
	});

	test("receipts must be one contiguous immutable sequence and duplicate notices count once", () => {
		const fake = fakeHost({ owner: "owner-sequence" });
		const adapter = bind(fake, { limitUsd: 1 });
		fake.add({ costTotal: 0.001 });
		expect(adapter.check().send).toBe(true);
		fake.duplicateFirst();
		expect(adapter.check().send).toBe(true);
		expect(adapter.observe().knownCostUsd).toBeCloseTo(0.001);
		expect(adapter.observe().settledReceipts).toBe(1);

		fake.add({ seq: 3, costTotal: 0.002 });
		const gap = refusal(adapter.check());
		expect(gap.code).toBe("receipt-sequence");
		expect(gap.detail).toContain("seq 3");

		const mutated = fakeHost({ owner: "owner-mutated" });
		const mutant = bind(mutated, { limitUsd: 1 });
		mutated.add({ costTotal: 0.001 });
		expect(mutant.check().send).toBe(true);
		mutated.mutate(0, { costTotal: 0.002 });
		const changed = refusal(mutant.check());
		expect(changed.code).toBe("receipt-mutated");
		expect(mutant.observe().accounting).toBe("faulted");
	});
});

describe("revocation, host loss and cleanup", () => {
	test("a known revocation, a non-boolean check or a thrown check refuses further dispatch", () => {
		const fake = fakeHost({ owner: "owner-revoke" });
		const adapter = bind(fake, { limitUsd: 1 });
		expect(adapter.revoke("run stopped")).toBe(true);
		expect(adapter.revoke("a second reason")).toBe(false);
		const blocked = refusal(adapter.check());
		expect(blocked.code).toBe("adapter-revoked");
		expect(blocked.detail).toBe("run stopped");
		expect(fake.invoke().send).toBe(false);

		const throwing = fakeHost({ owner: "owner-revoke-throwing" });
		const thrown = bind(throwing, {
			limitUsd: 1,
			isRevoked: () => {
				throw new Error("no live lease");
			},
		});
		expect(refusal(thrown.check()).code).toBe("revocation-unknown");

		const revoked = fakeHost({ owner: "owner-revoke-true" });
		const known = bind(revoked, { limitUsd: 1, isRevoked: () => true });
		expect(refusal(known.check()).code).toBe("adapter-revoked");
	});

	test("a lost authority stays a fault even if the host would recover", () => {
		const fake = fakeHost({ owner: "owner-lost" });
		const adapter = bind(fake);
		fake.setManaged(false);
		expect(refusal(adapter.check()).code).toBe("host-unmanaged");
		fake.setManaged(true);
		expect(refusal(adapter.check()).code).toBe("host-unmanaged");

		const down = fakeHost({ owner: "owner-down" });
		const unavailable = bind(down);
		down.setStateThrows(true);
		expect(refusal(unavailable.check()).code).toBe("host-unavailable");
		down.setStateThrows(false);
		expect(refusal(unavailable.check()).code).toBe("host-unavailable");
	});

	test("cleanup clears only its installed decision once; a later run can bind the same owner", () => {
		const fake = fakeHost({ owner: "owner-dispose" });
		const adapter = bind(fake);
		const retained = fake.authorization();
		if (retained === undefined) throw new Error("no decision installed");
		const firstToken = adapter.metadata.bindingToken;
		expect(adapter.dispose()).toEqual({ disposed: true });
		expect(fake.authorization()).toBeUndefined();
		expect(fake.authorizeCalls).toHaveLength(2);
		expect(fake.authorizeCalls[1]).toBeUndefined();
		expect(adapter.dispose()).toEqual({ disposed: false });
		expect(fake.authorizeCalls).toHaveLength(2);

		const retainedDecision = retained(fake.request(), fake.api.state());
		expect(retainedDecision.send).toBe(false);
		if (!retainedDecision.send) expect(retainedDecision.reason).toContain("adapter-disposed");
		expect(refusal(adapter.check()).code).toBe("adapter-disposed");

		const reborn = bind(fake);
		expect(reborn.metadata.bindingToken).not.toBe(firstToken);
		expect(reborn.check().send).toBe(true);
	});
});

describe("baseline and accounting-source discipline", () => {
	test("a mid-run binding excludes earlier receipts and never adds legacy carriers", () => {
		const fake = fakeHost({ owner: "owner-baseline" });
		fake.add({ costTotal: 0.9 });
		const adapter = bind(fake, { limitUsd: 1, spentUsd: 0.25 });
		expect(adapter.metadata.startSeq).toBe(1);
		expect(adapter.metadata.startCostUsd).toBe(0.25);
		expect(adapter.metadata.addAssistantMessageCost).toBe(false);
		expect(adapter.metadata.addJournalCost).toBe(false);
		const first = adapter.observe();
		expect(first.knownCostUsd).toBe(0.25);
		expect(first.startSeq).toBe(1);
		expect(first.settledReceipts).toBe(0);
		expect(adapter.check()).toMatchObject({ send: true, knownCostUsd: 0.25, lastSeq: 1 });

		fake.add({ costTotal: 0.1 });
		expect(adapter.observe().knownCostUsd).toBeCloseTo(0.35);
		const delta = adapter.takeDelta();
		expect(delta.usd).toBeCloseTo(0.1);
		expect(delta.settledReceipts).toBe(1);
		expect(delta.fromSeq).toBe(1);
		expect(delta.toSeq).toBe(2);
		expect(delta.byModel["gpt-test"]).toBeCloseTo(0.1);
		expect(delta.receiptToken).toBe(`${adapter.metadata.bindingToken}#2`);
	});

	test("cumulative receipts and per-model deltas are exact and a second take is empty", () => {
		const fake = fakeHost({ owner: "owner-delta" });
		const adapter = bind(fake, { limitUsd: 1 });
		fake.add({ model: "model-a", costTotal: 0.001 });
		fake.add({ model: "model-b", costTotal: 0.002 });
		fake.add({ model: "model-a", costTotal: 0.003 });
		const observation = adapter.observe();
		expect(observation.knownCostUsd).toBeCloseTo(0.006);
		expect(observation.knownReceipts).toBe(3);
		expect(observation.settledReceipts).toBe(3);
		expect(observation.byModel["model-a"]?.knownUsd).toBeCloseTo(0.004);
		expect(observation.byModel["model-b"]?.knownUsd).toBeCloseTo(0.002);

		const delta = adapter.takeDelta();
		expect(delta.usd).toBeCloseTo(0.006);
		expect(delta.byModel["model-a"]).toBeCloseTo(0.004);
		expect(delta.byModel["model-b"]).toBeCloseTo(0.002);
		expect(delta.settledReceipts).toBe(3);
		expect(delta.fromSeq).toBe(0);
		expect(delta.toSeq).toBe(3);

		const again = adapter.takeDelta();
		expect(again.usd).toBe(0);
		expect(again.byModel).toEqual({});
		expect(again.settledReceipts).toBe(0);
		expect(again.fromSeq).toBe(3);
		expect(again.toSeq).toBe(3);

		fake.add({ model: "model-a", costTotal: 0.001 });
		const next = adapter.takeDelta();
		expect(next.usd).toBeCloseTo(0.001);
		expect(next.settledReceipts).toBe(1);
		expect(next.fromSeq).toBe(3);
		expect(next.toSeq).toBe(4);
	});

	test("an earlier run's unresolved receipt is reported but does not block a fresh finite run", () => {
		const fake = fakeHost({ owner: "owner-prior-unresolved" });
		fake.addUnflushed({ costTotal: 0.05 });
		const adapter = bind(fake, { limitUsd: 1, spentUsd: 0 });
		const prior = adapter.observe();
		expect(prior.unresolvedCount).toBe(1);
		expect(prior.unresolved[0]?.inScope).toBe(false);
		expect(prior.complete).toBe(false);
		expect(adapter.check()).toMatchObject({ send: true, knownCostUsd: 0, unresolvedCount: 1 });

		const current = fake.addUnflushed({ costTotal: 0.01 });
		expect(refusal(adapter.check()).code).toBe("unresolved-receipt");
		expect(adapter.observe().unresolved.some(fact => fact.inScope && fact.attemptId === current.attemptId)).toBe(true);
	});

	test("an unreadable baseline never attributes later receipts to the run", () => {
		const fake = fakeHost({ owner: "owner-no-baseline" });
		fake.setStateThrows(true);
		const adapter = bind(fake);
		expect(adapter.metadata.nativeAccounting).toBe("faulted");
		expect(refusal(adapter.check()).code).toBe("host-unavailable");
		fake.setStateThrows(false);
		fake.add({ costTotal: 0.05 });
		expect(refusal(adapter.check()).code).toBe("host-unavailable");
		const observation = adapter.observe();
		expect(observation.knownCostUsd).toBe(0);
		expect(observation.accounting).toBe("faulted");
		expect(adapter.takeDelta().usd).toBe(0);
	});

	test("a finite binding without an exact start cost and a duplicate owner binding refuse before install", () => {
		const fake = fakeHost({ owner: "owner-baseline-unknown" });
		const missing = bindPaidAttemptAdapter({
			ctx: { paidAttempts: fake.api },
			runId: "run-missing",
			ownerSessionId: "owner-baseline-unknown",
			limitUsd: 1,
		});
		expect(missing.status).toBe("unavailable");
		if (missing.status === "unavailable") {
			expect(missing.code).toBe("unknown-baseline-spend");
			expect(missing.metadata.nativeAccounting).toBe("unavailable");
			expect(missing.metadata.addJournalCost).toBe(true);
		}
		expect(fake.authorizeCalls).toHaveLength(0);

		const first = bind(fake, { limitUsd: 1 });
		const duplicate = bindPaidAttemptAdapter({
			ctx: { paidAttempts: fake.api },
			runId: "run-duplicate",
			ownerSessionId: "owner-baseline-unknown",
			limitUsd: 1,
			spentUsd: 0,
		});
		expect(duplicate.status).toBe("unavailable");
		if (duplicate.status === "unavailable") expect(duplicate.code).toBe("already-bound");
		expect(first.check().send).toBe(true);
	});
});
