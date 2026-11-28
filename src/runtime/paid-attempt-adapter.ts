/**
 * Narrow structural adapter to the host's paid-attempt gate (Slice Y shape, omp 19.2.1 upstream patch).
 *
 * Stock npm 19.2.1 has no `ctx.paidAttempts`; this module therefore reads the API structurally and never imports a
 * private host module. It reports an absent/malformed/unmanaged surface as `unavailable`, and only installs a decision
 * after it has positively read the exact owner session id, found `managed === true`, and had `authorize` accept the
 * decider without throwing. A subagent's read-only proxy that refuses `authorize` therefore cannot look like an owner.
 *
 * When bound, the adapter owns one run of one owner tree. It records the host's `lastSeq` as its baseline, rejects
 * receipts at or below that baseline as another binding's business, and accepts only the contiguous, immutable,
 * strictly increasing receipt sequence the host publishes. Its known cost is the caller-supplied start cost plus the
 * observed `costTotal` of in-scope receipts; pending attempts are unknown, never zero. In finite-budget mode it refuses
 * every further paid attempt while an attempt is pending, an in-scope receipt is unresolved, or the exact authorized
 * cost exceeds the approved limit. A caller that opts into `leader-and-exact-worker` may still send the director's own
 * `loop` continuation at or past the known threshold, or a continuation from an actor with an in-scope admitted receipt
 * whose observed cost is exact; every attempt without that provenance stays refused. Earlier-run receipts stay visible
 * with `inScope: false` but cannot spend this run's budget. A caller may also name attempt ids left pending by an earlier
 * binding of the same owner: they are excluded even when their late receipt's sequence follows this baseline, so a
 * durable late receipt never charges the next run. The host's refusal is terminal, so there is no resend path.
 *
 * The adapter never reads assistant `message_end` usage or `model_usage` journal rows. When it is effective the wiring
 * metadata says the native receipts are the only spend source; adding those legacy carriers as well would double count.
 * No claim is made here about release readiness, pooled placement, or throughput.
 */
import { sharedMap } from "./thread-state.ts";

/** The published host shape this adapter reads. Not an npm dependency: stock 19.2.1 is checked at runtime. */
export const PAID_ATTEMPT_HOST_SHAPE = "19.2.1-slice-y";
/** Stable prefix of every refusal reason handed back to the host. */
export const PAID_ATTEMPT_REFUSAL_TAG = "storm-paid-attempt";
/** Model bucket for a pending attempt whose model field was not readable. */
export const PAID_ATTEMPT_UNKNOWN_MODEL = "(unknown)";

/** The adapter makes none of these claims; wiring must not infer them from a successful binding. */
export const PAID_ATTEMPT_CLAIMS = Object.freeze({
	release: false,
	pooledEnabled: false,
	throughput: false,
});

/** When native receipts are the sole spend source, these legacy additions must stay off. */
export const PAID_ATTEMPT_NO_LEGACY_ADD = Object.freeze({
	addAssistantMessageCost: false,
	addJournalCost: false,
});

/** When the host API is unusable, existing legacy accounting remains the only source. */
export const PAID_ATTEMPT_LEGACY_ADD = Object.freeze({
	addAssistantMessageCost: true,
	addJournalCost: true,
});

const COST_EPSILON = 1e-9;
const MAX_DETAIL = 220;

/** One state of the host's per-tree authority, narrowed to the fields this adapter reads. */
export interface PaidAttemptsSurface {
	readonly ownerSessionId: string;
	readonly managed: boolean;
	authorize(decider: PaidAttemptDecider | undefined): void;
	state(): PaidAttemptStateView;
	receipts(): readonly PaidAttemptReceiptView[];
	onReceipt(listener: (receipt: PaidAttemptReceiptView) => void): () => void;
}

/** One pre-send request, narrowed to identity and sequencing fields. */
export interface PaidAttemptRequestView {
	readonly attemptId: string;
	readonly sessionId: string;
	readonly actorSessionId: string;
	readonly purpose: string;
	readonly provider: string;
	readonly model: string;
	readonly attempt: number;
	readonly startedAt: number;
	readonly retryOf?: string;
}

/** One settled host receipt, narrowed to accounting and append proof. */
export interface PaidAttemptReceiptView {
	readonly attemptId: string;
	readonly seq: number;
	readonly sessionId: string;
	readonly actorSessionId: string;
	readonly purpose: string;
	readonly provider: string;
	readonly model: string;
	readonly attempt: number;
	readonly startedAt: number;
	readonly settledAt: number;
	readonly gate: "admitted" | "refused" | "bypassed";
	readonly sent: boolean | "unknown";
	readonly outcome: "completed" | "failed" | "cancelled" | "refused" | "unknown";
	readonly costBasis: "observed" | "unknown";
	readonly costTotal?: number;
	readonly append: "flushed" | "failed" | "unavailable";
	readonly receiptEntryId?: string;
}

/** One admitted attempt that has not settled. Its cost is unknown, not zero. */
export interface PaidAttemptPendingView {
	readonly attemptId: string;
	readonly model: string;
	readonly purpose: string;
	readonly actorSessionId: string;
}

/** The accounting snapshot handed to a decision. */
export interface PaidAttemptStateView {
	readonly observedCost: number;
	readonly pending: readonly PaidAttemptPendingView[];
	readonly unresolved: readonly PaidAttemptReceiptView[];
	readonly lastSeq: number;
}

/** The synchronous owner decision the host installs. */
export type PaidAttemptDecision = { readonly send: true } | { readonly send: false; readonly reason: string };
export type PaidAttemptDecider = (attempt: PaidAttemptRequestView, state: PaidAttemptStateView) => PaidAttemptDecision;

/** Exact refusal shapes returned to the manager and recorded for wiring. */
export type PaidAttemptUnavailableCode =
	| "invalid-options"
	| "unknown-baseline-spend"
	| "host-absent"
	| "host-invalid"
	| "host-unmanaged"
	| "host-owner-mismatch"
	| "host-readonly"
	| "already-bound";

export type PaidAttemptRefusalCode =
	| "adapter-disposed"
	| "adapter-revoked"
	| "revocation-unknown"
	| "host-unmanaged"
	| "host-owner-mismatch"
	| "host-unavailable"
	| "host-invalid"
	| "host-state-invalid"
	| "host-state-inconsistent"
	| "receipt-sequence"
	| "receipt-mutated"
	| "receipt-unknown-owner"
	| "receipt-unknown-pricing"
	| "receipt-append-unproven"
	| "receipt-malformed"
	| "observed-cost-mismatch"
	| "unresolved-pending"
	| "unresolved-receipt"
	| "limit-exceeded"
	| "dispatch-invalid"
	| "dispatch-owner-mismatch";

export interface PaidAttemptRefusal {
	readonly code: PaidAttemptRefusalCode;
	readonly detail: string;
	readonly reason: string;
}

export type PaidAttemptAccounting = "effective" | "faulted" | "unavailable";
export type PaidAttemptLegacyPolicy = "native-only" | "legacy-allowed";
export type PaidAttemptContinuationPolicy = "refuse" | "leader-and-exact-worker";

export type PaidAttemptLimit =
	| { readonly mode: "finite"; readonly usd: number }
	| { readonly mode: "unbounded" };

/** Everything later coordinator wiring needs; emitted for both a bound and an unavailable surface. */
export interface PaidAttemptMetadata {
	readonly kind: "storm.paid-attempt-adapter";
	readonly version: 1;
	readonly hostShape: typeof PAID_ATTEMPT_HOST_SHAPE;
	readonly apiPath: "ctx.paidAttempts";
	readonly available: boolean;
	readonly runId: string;
	readonly expectedOwnerSessionId: string;
	readonly hostOwnerSessionId?: string;
	readonly bindingToken?: string;
	readonly startSeq?: number;
	readonly startCostUsd: number;
	readonly limit: PaidAttemptLimit;
	readonly authorization: "installed" | "not-installed";
	readonly nativeAccounting: PaidAttemptAccounting;
	readonly legacyCostPolicy: PaidAttemptLegacyPolicy;
	readonly addAssistantMessageCost: boolean;
	readonly addJournalCost: boolean;
	readonly resendOnRefusal: false;
	readonly claims: typeof PAID_ATTEMPT_CLAIMS;
	readonly reason?: PaidAttemptUnavailableCode;
	readonly detail?: string;
}

export interface PaidAttemptGateCounts {
	readonly knownCostUsd: number;
	readonly lastSeq: number;
	readonly pendingCount: number;
	readonly unresolvedCount: number;
}

export type PaidAttemptRefusalGate = PaidAttemptGateCounts & {
	readonly send: false;
	readonly code: PaidAttemptRefusalCode;
	readonly detail: string;
	readonly reason: string;
};

export type PaidAttemptGate =
	| (PaidAttemptGateCounts & { readonly send: true })
	| PaidAttemptRefusalGate;

export interface PaidAttemptModelObservation {
	readonly knownUsd: number;
	readonly observedReceipts: number;
	readonly unresolvedReceipts: number;
	readonly pendingAttempts: number;
}

export interface PaidAttemptPendingFact {
	readonly attemptId: string;
	readonly model: string;
	readonly purpose: string;
	readonly actorSessionId: string;
}

export type PaidAttemptUnresolvedReason =
	| "unknown-pricing"
	| "bypassed-gate"
	| "append-unproven"
	| "host-unresolved"
	| "malformed";

export interface PaidAttemptUnresolvedFact {
	readonly attemptId: string;
	readonly seq: number;
	readonly model: string;
	readonly inScope: boolean;
	readonly reasons: readonly PaidAttemptUnresolvedReason[];
}

export interface PaidAttemptObservation {
	readonly runId: string;
	readonly ownerSessionId: string;
	readonly bindingToken: string;
	readonly limit: PaidAttemptLimit;
	readonly knownCostUsd: number;
	readonly startCostUsd: number;
	readonly knownReceipts: number;
	readonly settledReceipts: number;
	readonly byModel: Readonly<Record<string, PaidAttemptModelObservation>>;
	readonly pending: readonly PaidAttemptPendingFact[];
	readonly unresolved: readonly PaidAttemptUnresolvedFact[];
	readonly pendingCount: number;
	readonly unresolvedCount: number;
	readonly lastSeq: number;
	readonly startSeq: number;
	readonly receiptToken: string;
	readonly accounting: "effective" | "faulted";
	readonly complete: boolean;
	readonly disposed: boolean;
	readonly legacy: typeof PAID_ATTEMPT_NO_LEGACY_ADD;
	readonly fault?: { readonly code: PaidAttemptRefusalCode; readonly detail: string };
	readonly lastRefusal?: PaidAttemptRefusal;
	readonly gate: PaidAttemptGate;
}

export interface PaidAttemptDelta {
	readonly runId: string;
	readonly ownerSessionId: string;
	readonly bindingToken: string;
	readonly usd: number;
	readonly byModel: Readonly<Record<string, number>>;
	readonly settledReceipts: number;
	readonly fromSeq: number;
	readonly toSeq: number;
	readonly receiptToken: string;
	readonly pendingCount: number;
	readonly unresolvedCount: number;
	/** Unresolved facts that belong to this binding: an earlier run's receipt never makes this run's live total a floor. */
	readonly inScopeUnresolvedCount: number;
}

export interface PaidAttemptCleanup {
	readonly disposed: boolean;
}

export interface PaidAttemptBindOptions {
	readonly ctx: unknown;
	readonly runId: string;
	/** The exact owner session id from the run's ledger/native main session; ambient ctx ids are never inferred. */
	readonly ownerSessionId: string;
	/** A finite approved run limit in USD. Omitted means observation without a budget decision. */
	readonly limitUsd?: number;
	/**
	 * Exact run cost already known before this binding whose receipts are excluded at or below the baseline seq. Required
	 * for a finite limit (use 0 at run start); never a legacy message/journal figure that the native receipts also carry.
	 */
	readonly spentUsd?: number;
	/** Rechecked for every decision. Throwing is an unknown revocation state and refuses. */
	readonly isRevoked?: () => boolean;
	/**
	 * Which over-limit provider attempts may still send. Default `refuse` refuses every send once exact in-scope cost
	 * exceeds `limitUsd`. `leader-and-exact-worker` (Storm's `block-spawns`) additionally permits the director's own
	 * `loop` continuation at or past the known threshold, and a continuation from an actor with an in-scope admitted
	 * receipt whose observed cost is exact. An actor with no such grant, or an attempt whose provenance is missing or
	 * unknown, is still refused; new spawns/work messages are the caller's dispatch gates' business.
	 */
	readonly continuationPolicy?: PaidAttemptContinuationPolicy;
	/**
	 * Attempt ids retired by an earlier binding of the same owner but not yet settled when it closed. They remain visible
	 * to the host's contiguous receipt sequence yet never count toward this run: a durable late receipt that arrives
	 * after this binding must not charge the next run.
	 */
	readonly excludeAttemptIds?: readonly string[];
}

export type PaidAttemptBindResult =
	| {
			readonly status: "bound";
			readonly adapter: PaidAttemptAdapter;
			readonly metadata: PaidAttemptMetadata;
	  }
	| {
			readonly status: "unavailable";
			readonly code: PaidAttemptUnavailableCode;
			readonly detail: string;
			readonly metadata: PaidAttemptMetadata;
	  };

interface Fault {
	readonly code: PaidAttemptRefusalCode;
	readonly detail: string;
}

interface ParsedReceipt {
	readonly receipt: PaidAttemptReceiptView;
	readonly fingerprint: string;
}

interface MutableModel {
	knownUsd: number;
	observedReceipts: number;
	unresolvedReceipts: number;
	pendingAttempts: number;
}

interface Classification {
	readonly spendKnown: boolean;
	readonly spendUsd: number;
	readonly reasons: readonly PaidAttemptUnresolvedReason[];
}

const FAULT_ORDER: readonly PaidAttemptRefusalCode[] = [
	"host-unmanaged",
	"host-owner-mismatch",
	"host-unavailable",
	"host-invalid",
	"host-state-invalid",
	"receipt-unknown-owner",
	"receipt-mutated",
	"receipt-sequence",
	"observed-cost-mismatch",
];

const UNRESOLVED_ORDER: readonly PaidAttemptUnresolvedReason[] = [
	"unknown-pricing",
	"bypassed-gate",
	"append-unproven",
	"host-unresolved",
	"malformed",
];

// One owner tree has one installed decider. The token also names the binding in observations and lets dispose clear only
// the authorization this adapter installed.
const activeAdapters = sharedMap<string, string>("storm.paid-attempt.active");
let bindSerial = 0;

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && !value.includes("\u0000");
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function integerAtLeast(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
}

function limitOf(mode: "finite" | "unbounded", usd: number | undefined): PaidAttemptLimit {
	return mode === "finite" && usd !== undefined ? { mode: "finite", usd } : { mode: "unbounded" };
}

function optionalText(
	record: Record<string, unknown>,
	key: string,
): { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly detail: string } {
	const value = record[key];
	if (value === undefined) return { ok: true };
	if (!nonEmpty(value)) return { ok: false, detail: `${key} is not a non-empty string` };
	return { ok: true, value };
}

function parseReceipt(
	record: Record<string, unknown>,
	ownerSessionId: string,
): { readonly ok: true; readonly parsed: ParsedReceipt } | { readonly ok: false; readonly code: PaidAttemptRefusalCode; readonly detail: string } {
	if (!nonEmpty(record.attemptId)) return { ok: false, code: "receipt-malformed", detail: "receipt attemptId is missing" };
	if (!integerAtLeast(record.seq, 1)) return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} seq is not a positive integer` };
	if (!nonEmpty(record.sessionId)) return { ok: false, code: "receipt-unknown-owner", detail: `receipt ${record.attemptId} has no owner session id` };
	if (record.sessionId !== ownerSessionId) {
		return { ok: false, code: "receipt-unknown-owner", detail: `receipt ${record.attemptId} belongs to ${record.sessionId}, not ${ownerSessionId}` };
	}
	if (!nonEmpty(record.actorSessionId)) return { ok: false, code: "receipt-unknown-owner", detail: `receipt ${record.attemptId} has no actor session id` };
	if (!nonEmpty(record.purpose)) return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} has no purpose` };
	if (!nonEmpty(record.provider)) return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} has no provider` };
	if (!nonEmpty(record.model)) return { ok: false, code: "receipt-unknown-pricing", detail: `receipt ${record.attemptId} has no model to attribute cost to` };
	if (!integerAtLeast(record.attempt, 1)) return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} attempt is not a positive integer` };
	if (!finiteNonNegative(record.startedAt)) return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} startedAt is not a finite timestamp` };
	if (!finiteNonNegative(record.settledAt)) return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} settledAt is not a finite timestamp` };
	if (record.gate !== "admitted" && record.gate !== "refused" && record.gate !== "bypassed") {
		return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} gate is unknown` };
	}
	if (typeof record.sent !== "boolean" && record.sent !== "unknown") {
		return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} sent is unknown` };
	}
	if (record.outcome !== "completed" && record.outcome !== "failed" && record.outcome !== "cancelled" && record.outcome !== "refused" && record.outcome !== "unknown") {
		return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} outcome is unknown` };
	}
	if (record.costBasis !== "observed" && record.costBasis !== "unknown") {
		return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} costBasis is unknown` };
	}
	if (record.append !== "flushed" && record.append !== "failed" && record.append !== "unavailable") {
		return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} append is unknown` };
	}
	if (record.costTotal !== undefined && !finiteNonNegative(record.costTotal)) {
		return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId} costTotal is not a finite nonnegative number` };
	}
	const entry = optionalText(record, "receiptEntryId");
	if (!entry.ok) return { ok: false, code: "receipt-malformed", detail: `receipt ${record.attemptId}: ${entry.detail}` };

	const receipt: PaidAttemptReceiptView = {
		attemptId: record.attemptId,
		seq: record.seq,
		sessionId: record.sessionId,
		actorSessionId: record.actorSessionId,
		purpose: record.purpose,
		provider: record.provider,
		model: record.model,
		attempt: record.attempt,
		startedAt: record.startedAt,
		settledAt: record.settledAt,
		gate: record.gate,
		sent: record.sent,
		outcome: record.outcome,
		costBasis: record.costBasis,
		...(record.costTotal === undefined ? {} : { costTotal: record.costTotal }),
		append: record.append,
		...(entry.value === undefined ? {} : { receiptEntryId: entry.value }),
	};
	const fingerprint = JSON.stringify([
		receipt.attemptId,
		receipt.seq,
		receipt.sessionId,
		receipt.actorSessionId,
		receipt.purpose,
		receipt.provider,
		receipt.model,
		receipt.attempt,
		receipt.startedAt,
		receipt.settledAt,
		receipt.gate,
		receipt.sent,
		receipt.outcome,
		receipt.costBasis,
		receipt.costTotal ?? null,
	]);
	return { ok: true, parsed: { receipt, fingerprint } };
}

function parseState(
	value: unknown,
	ownerSessionId: string,
): { readonly ok: true; readonly state: PaidAttemptStateView } | { readonly ok: false; readonly code: PaidAttemptRefusalCode; readonly detail: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, code: "host-state-invalid", detail: "paid-attempt state is not an object" };
	}
	const record = value as Record<string, unknown>;
	if (!finiteNonNegative(record.observedCost)) return { ok: false, code: "host-state-invalid", detail: "state observedCost is not a finite nonnegative number" };
	if (!integerAtLeast(record.lastSeq, 0)) return { ok: false, code: "host-state-invalid", detail: "state lastSeq is not a nonnegative integer" };
	if (!Array.isArray(record.pending)) return { ok: false, code: "host-state-invalid", detail: "state pending is not an array" };
	if (!Array.isArray(record.unresolved)) return { ok: false, code: "host-state-invalid", detail: "state unresolved is not an array" };

	const seenPending = new Set<string>();
	const pending: PaidAttemptPendingView[] = [];
	for (const item of record.pending) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return { ok: false, code: "host-state-invalid", detail: "a pending attempt is not an object" };
		}
		const row = item as Record<string, unknown>;
		if (!nonEmpty(row.attemptId)) {
			return { ok: false, code: "host-state-invalid", detail: "a pending attempt has no attempt id" };
		}
		if (seenPending.has(row.attemptId)) {
			return { ok: false, code: "host-state-invalid", detail: `pending attempt ${row.attemptId} appears twice` };
		}
		seenPending.add(row.attemptId);
		pending.push({
			attemptId: row.attemptId,
			model: nonEmpty(row.model) ? row.model : PAID_ATTEMPT_UNKNOWN_MODEL,
			purpose: nonEmpty(row.purpose) ? row.purpose : "unknown",
			actorSessionId: nonEmpty(row.actorSessionId) ? row.actorSessionId : "unknown",
		});
	}

	const seenUnresolved = new Set<string>();
	const unresolved: PaidAttemptReceiptView[] = [];
	for (const item of record.unresolved) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return { ok: false, code: "host-state-invalid", detail: "an unresolved receipt is not an object" };
		}
		const parsed = parseReceipt(item as Record<string, unknown>, ownerSessionId);
		if (!parsed.ok) return parsed;
		const receipt = parsed.parsed.receipt;
		if (seenUnresolved.has(receipt.attemptId)) {
			return { ok: false, code: "host-state-invalid", detail: `unresolved receipt ${receipt.attemptId} appears twice` };
		}
		seenUnresolved.add(receipt.attemptId);
		unresolved.push(receipt);
	}

	return { ok: true, state: { observedCost: record.observedCost, pending, unresolved, lastSeq: record.lastSeq } };
}

function parseAttempt(
	value: unknown,
	ownerSessionId: string,
): { readonly ok: true; readonly attempt: PaidAttemptRequestView } | { readonly ok: false; readonly code: PaidAttemptRefusalCode; readonly detail: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, code: "dispatch-invalid", detail: "attempt is not an object" };
	}
	const record = value as Record<string, unknown>;
	if (!nonEmpty(record.attemptId)) return { ok: false, code: "dispatch-invalid", detail: "attempt id is missing" };
	if (!nonEmpty(record.sessionId)) return { ok: false, code: "dispatch-invalid", detail: "attempt owner is missing" };
	if (record.sessionId !== ownerSessionId) {
		return { ok: false, code: "dispatch-owner-mismatch", detail: `attempt owner ${record.sessionId} is not ${ownerSessionId}` };
	}
	if (!nonEmpty(record.actorSessionId)) return { ok: false, code: "dispatch-invalid", detail: "attempt actor is missing" };
	if (!nonEmpty(record.purpose)) return { ok: false, code: "dispatch-invalid", detail: "attempt purpose is missing" };
	if (!nonEmpty(record.provider)) return { ok: false, code: "dispatch-invalid", detail: "attempt provider is missing" };
	if (!nonEmpty(record.model)) return { ok: false, code: "dispatch-invalid", detail: "attempt model is missing" };
	if (!integerAtLeast(record.attempt, 1)) return { ok: false, code: "dispatch-invalid", detail: "attempt ordinal is not a positive integer" };
	if (!finiteNonNegative(record.startedAt)) return { ok: false, code: "dispatch-invalid", detail: "attempt startedAt is not a finite timestamp" };
	const retry = optionalText(record, "retryOf");
	if (!retry.ok) return { ok: false, code: "dispatch-invalid", detail: retry.detail };
	if (record.attempt > 1 && retry.value === undefined) {
		return { ok: false, code: "dispatch-invalid", detail: "a retry does not name the attempt it retries" };
	}
	if (record.attempt === 1 && retry.value !== undefined) {
		return { ok: false, code: "dispatch-invalid", detail: "a first attempt names a retry" };
	}
	return {
		ok: true,
		attempt: {
			attemptId: record.attemptId,
			sessionId: record.sessionId,
			actorSessionId: record.actorSessionId,
			purpose: record.purpose,
			provider: record.provider,
			model: record.model,
			attempt: record.attempt,
			startedAt: record.startedAt,
			...(retry.value === undefined ? {} : { retryOf: retry.value }),
		},
	};
}

/** Whether a receipt proves that no provider request was sent at all: a known exact zero. */
function isExactRefusal(receipt: PaidAttemptReceiptView): boolean {
	return receipt.gate === "refused" && receipt.sent === false && receipt.outcome === "refused";
}

function classify(receipt: PaidAttemptReceiptView): Classification {
	const reasons: PaidAttemptUnresolvedReason[] = [];
	const spendKnown = receipt.costBasis === "observed" && finiteNonNegative(receipt.costTotal);
	if (isExactRefusal(receipt)) {
		// No request left the process; a positive provider cost in that receipt is contradictory rather than spend.
		if (spendKnown && receipt.costTotal !== undefined && receipt.costTotal > 0) reasons.push("malformed");
		return { spendKnown: false, spendUsd: 0, reasons };
	}
	if (!spendKnown) reasons.push("unknown-pricing");
	if (receipt.gate === "bypassed") reasons.push("bypassed-gate");
	if (receipt.append !== "flushed" || receipt.receiptEntryId === undefined) reasons.push("append-unproven");
	if (receipt.gate === "admitted" && receipt.sent !== true) reasons.push("malformed");
	if (receipt.gate === "bypassed" && receipt.sent !== "unknown" && receipt.sent !== true) reasons.push("malformed");
	if (receipt.gate === "refused") reasons.push("malformed");
	if (receipt.outcome === "refused") reasons.push("malformed");
	const seen = new Set(reasons);
	return {
		spendKnown,
		spendUsd: spendKnown && receipt.costTotal !== undefined ? receipt.costTotal : 0,
		reasons: UNRESOLVED_ORDER.filter(reason => seen.has(reason)),
	};
}

function observedCostOf(entries: readonly ParsedReceipt[]): { readonly known: boolean; readonly usd: number } {
	let usd = 0;
	for (const entry of entries) {
		const receipt = entry.receipt;
		if (receipt.costBasis !== "observed") continue;
		if (!finiteNonNegative(receipt.costTotal)) return { known: false, usd };
		usd += receipt.costTotal;
	}
	return { known: true, usd };
}

/** Bind one run to the host's paid-attempt authority, or report exactly why that is impossible. */
export function bindPaidAttemptAdapter(options: PaidAttemptBindOptions): PaidAttemptBindResult {
	const runId = nonEmpty(options.runId) ? options.runId : "";
	const expectedOwnerSessionId = nonEmpty(options.ownerSessionId) ? options.ownerSessionId : "";
	const rawLimit = options.limitUsd;
	const rawSpent = options.spentUsd;
	const limitValid = rawLimit === undefined || finiteNonNegative(rawLimit);
	const spentValid = rawSpent === undefined || finiteNonNegative(rawSpent);
	const revokedValid = options.isRevoked === undefined || typeof options.isRevoked === "function";
	const continuationPolicy = options.continuationPolicy ?? "refuse";
	const continuationPolicyValid = continuationPolicy === "refuse" || continuationPolicy === "leader-and-exact-worker";
	const excludedRaw = options.excludeAttemptIds;
	const excludedValid =
		excludedRaw === undefined ||
		(Array.isArray(excludedRaw) && excludedRaw.every(nonEmpty) && new Set(excludedRaw).size === excludedRaw.length);
	const excludeAttemptIds = new Set(excludedValid && excludedRaw !== undefined ? excludedRaw : []);
	const finite = finiteNonNegative(rawLimit);
	const startCostUsd = finiteNonNegative(rawSpent) ? rawSpent : 0;
	const limit = limitOf(finite ? "finite" : "unbounded", finite ? rawLimit : undefined);

	if (runId === "" || expectedOwnerSessionId === "" || !limitValid || !spentValid || !revokedValid || !excludedValid || !continuationPolicyValid) {
		return unavailable("invalid-options", "runId/ownerSessionId must be non-empty, limit/spent finite nonnegative, continuationPolicy valid, and excluded attempt ids unique non-empty strings", {
			runId: runId || "(missing run id)",
			expectedOwnerSessionId: expectedOwnerSessionId || "(missing owner session id)",
			startCostUsd,
			limit,
		});
	}
	if (finite && rawSpent === undefined) {
		return unavailable("unknown-baseline-spend", "a finite-budget binding requires the exact start cost (use 0 at run start)", {
			runId,
			expectedOwnerSessionId,
			startCostUsd,
			limit,
		});
	}

	const surface = surfaceOf(options.ctx);
	if (surface.kind === "absent") {
		return unavailable("host-absent", "ctx.paidAttempts is absent (stock 19.2.1)", {
			runId,
			expectedOwnerSessionId,
			startCostUsd,
			limit,
		});
	}
	if (surface.kind === "invalid") {
		return unavailable("host-invalid", surface.detail, {
			runId,
			expectedOwnerSessionId,
			startCostUsd,
			limit,
		});
	}
	if (surface.ownerSessionId !== expectedOwnerSessionId) {
		return unavailable("host-owner-mismatch", `ctx.paidAttempts owner ${surface.ownerSessionId} is not ${expectedOwnerSessionId}`, {
			runId,
			expectedOwnerSessionId,
			hostOwnerSessionId: surface.ownerSessionId,
			startCostUsd,
			limit,
		});
	}
	if (activeAdapters.has(expectedOwnerSessionId)) {
		return unavailable("already-bound", `owner session ${expectedOwnerSessionId} already has an active paid-attempt adapter`, {
			runId,
			expectedOwnerSessionId,
			hostOwnerSessionId: surface.ownerSessionId,
			startCostUsd,
			limit,
		});
	}

	const serial = ++bindSerial;
	const bindingToken = `${PAID_ATTEMPT_REFUSAL_TAG}:${serial}:${expectedOwnerSessionId}:${runId}`;
	activeAdapters.set(expectedOwnerSessionId, bindingToken);
	const adapter = PaidAttemptAdapter.create({
		api: surface.api,
		runId,
		ownerSessionId: expectedOwnerSessionId,
		mode: finite ? "finite" : "unbounded",
		limitUsd: finite ? rawLimit : undefined,
		startCostUsd,
		bindingToken,
		isRevoked: options.isRevoked,
		continuationPolicy,
		excludeAttemptIds,
	});
	let failure: { readonly code: PaidAttemptUnavailableCode; readonly detail: string } | undefined;
	try {
		failure = adapter.install();
	} catch (error) {
		adapter.dispose();
		return unavailable("host-invalid", `installing the paid-attempt decision failed: ${messageOf(error)}`, {
			runId,
			expectedOwnerSessionId,
			hostOwnerSessionId: surface.ownerSessionId,
			startCostUsd,
			limit,
		});
	}
	if (failure !== undefined) {
		adapter.dispose();
		return unavailable(failure.code, failure.detail, {
			runId,
			expectedOwnerSessionId,
			hostOwnerSessionId: surface.ownerSessionId,
			startCostUsd,
			limit,
		});
	}
	return { status: "bound", adapter, metadata: adapter.metadata };
}

type SurfaceRead =
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly detail: string }
	| {
			readonly kind: "surface";
			readonly api: PaidAttemptsSurface;
			readonly ownerSessionId: string;
	  };

function surfaceOf(ctx: unknown): SurfaceRead {
	if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) return { kind: "absent" };
	let value: unknown;
	try {
		value = (ctx as Record<string, unknown>).paidAttempts;
	} catch (error) {
		return { kind: "invalid", detail: `reading ctx.paidAttempts failed: ${messageOf(error)}` };
	}
	if (value === undefined) return { kind: "absent" };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { kind: "invalid", detail: "ctx.paidAttempts is not an object" };
	}
	const apiRecord = value as Record<string, unknown>;
	let owner: unknown;
	let managed: unknown;
	let authorize: unknown;
	let state: unknown;
	let receipts: unknown;
	let onReceipt: unknown;
	try {
		owner = apiRecord.ownerSessionId;
		managed = apiRecord.managed;
		authorize = apiRecord.authorize;
		state = apiRecord.state;
		receipts = apiRecord.receipts;
		onReceipt = apiRecord.onReceipt;
	} catch (error) {
		return { kind: "invalid", detail: `reading ctx.paidAttempts fields failed: ${messageOf(error)}` };
	}
	if (!nonEmpty(owner)) return { kind: "invalid", detail: "ctx.paidAttempts.ownerSessionId is not a non-empty string" };
	if (typeof managed !== "boolean") return { kind: "invalid", detail: "ctx.paidAttempts.managed is not a boolean" };
	if (typeof authorize !== "function" || typeof state !== "function" || typeof receipts !== "function" || typeof onReceipt !== "function") {
		return { kind: "invalid", detail: "ctx.paidAttempts does not expose authorize/state/receipts/onReceipt functions" };
	}
	return { kind: "surface", api: apiRecord as unknown as PaidAttemptsSurface, ownerSessionId: owner };
}

function unavailable(
	code: PaidAttemptUnavailableCode,
	detail: string,
	input: {
		readonly runId: string;
		readonly expectedOwnerSessionId: string;
		readonly hostOwnerSessionId?: string;
		readonly startCostUsd: number;
		readonly limit: PaidAttemptLimit;
	},
): PaidAttemptBindResult {
	return {
		status: "unavailable",
		code,
		detail: oneLine(detail),
		metadata: metadataOf({
			...input,
			authorization: "not-installed",
			accounting: "unavailable",
			reason: code,
			detail: oneLine(detail),
		}),
	};
}

function metadataOf(input: {
	readonly runId: string;
	readonly expectedOwnerSessionId: string;
	readonly hostOwnerSessionId?: string;
	readonly bindingToken?: string;
	readonly startSeq?: number;
	readonly startCostUsd: number;
	readonly limit: PaidAttemptLimit;
	readonly authorization: "installed" | "not-installed";
	readonly accounting: PaidAttemptAccounting;
	readonly reason?: PaidAttemptUnavailableCode;
	readonly detail?: string;
}): PaidAttemptMetadata {
	const legacy = input.accounting === "unavailable";
	return {
		kind: "storm.paid-attempt-adapter",
		version: 1,
		hostShape: PAID_ATTEMPT_HOST_SHAPE,
		apiPath: "ctx.paidAttempts",
		available: input.authorization === "installed",
		runId: input.runId,
		expectedOwnerSessionId: input.expectedOwnerSessionId,
		...(input.hostOwnerSessionId === undefined ? {} : { hostOwnerSessionId: input.hostOwnerSessionId }),
		...(input.bindingToken === undefined ? {} : { bindingToken: input.bindingToken }),
		...(input.startSeq === undefined ? {} : { startSeq: input.startSeq }),
		startCostUsd: input.startCostUsd,
		limit: input.limit,
		authorization: input.authorization,
		nativeAccounting: input.accounting,
		legacyCostPolicy: legacy ? "legacy-allowed" : "native-only",
		addAssistantMessageCost: legacy,
		addJournalCost: legacy,
		resendOnRefusal: false,
		claims: PAID_ATTEMPT_CLAIMS,
		...(input.reason === undefined ? {} : { reason: input.reason }),
		...(input.detail === undefined ? {} : { detail: input.detail }),
	};
}

interface PaidAttemptAdapterInput {
	readonly api: PaidAttemptsSurface;
	readonly runId: string;
	readonly ownerSessionId: string;
	readonly mode: "finite" | "unbounded";
	readonly limitUsd: number | undefined;
	readonly startCostUsd: number;
	readonly bindingToken: string;
	readonly isRevoked: (() => boolean) | undefined;
	readonly continuationPolicy: PaidAttemptContinuationPolicy;
	readonly excludeAttemptIds: ReadonlySet<string>;
}

/** One run's read-only accounting plus its installed pre-send decision. */
export class PaidAttemptAdapter {
	readonly runId: string;
	readonly ownerSessionId: string;
	readonly bindingToken: string;
	readonly mode: "finite" | "unbounded";
	readonly limitUsd: number | undefined;
	readonly #api: PaidAttemptsSurface;
	readonly #startCostUsd: number;
	readonly #isRevoked: (() => boolean) | undefined;
	readonly #continuationPolicy: PaidAttemptContinuationPolicy;
	readonly #excludeAttemptIds: ReadonlySet<string>;
	/** In-scope worker actors with an admitted receipt whose observed cost is exact; their continuations are granted. */
	#grantedActors = new Set<string>();
	readonly #decider: PaidAttemptDecider = (attempt, state) => this.#decide(attempt, state);
	#baselineKnown = false;
	#baselineSeq = 0;
	#maxSeqSeen = 0;
	#lastSeq = 0;
	#hostObservedCost = 0;
	#disposed = false;
	#revokedReason: string | undefined;
	/** True only after `authorize` returned and the same surface reported managed/owner accepted. */
	#authorizationInstalled = false;
	#stickyFaults: Fault[] = [];
	#computedFaults: Fault[] = [];
	#fingerprints = new Map<string, string>();
	/** Append proof is allowed to advance (unavailable -> failed/flushed, entry id appears); it is not a receipt mutation. */
	#appendProof = new Map<string, { readonly append: PaidAttemptReceiptView["append"]; readonly entryId: string | undefined }>();
	#pending: PaidAttemptPendingFact[] = [];
	#unresolved: PaidAttemptUnresolvedFact[] = [];
	#byModel = new Map<string, MutableModel>();
	#knownCostUsd = 0;
	#knownReceipts = 0;
	#settledReceipts = 0;
	#deltaSeen = new Set<string>();
	#deltaUsd = 0;
	#deltaByModel = new Map<string, number>();
	#deltaSettled = 0;
	#deltaFromSeq = 0;
	#lastRefusal: PaidAttemptRefusal | undefined;
	#metadataValue: PaidAttemptMetadata | undefined;

	/** Binding is the only supported construction path; it owns the owner slot and the installed decision. */
	static create(input: PaidAttemptAdapterInput): PaidAttemptAdapter {
		return new PaidAttemptAdapter(input);
	}

	private constructor(input: PaidAttemptAdapterInput) {
		this.#api = input.api;
		this.runId = input.runId;
		this.ownerSessionId = input.ownerSessionId;
		this.mode = input.mode;
		this.limitUsd = input.limitUsd;
		this.#startCostUsd = input.startCostUsd;
		this.#knownCostUsd = input.startCostUsd;
		this.bindingToken = input.bindingToken;
		this.#isRevoked = input.isRevoked;
		this.#continuationPolicy = input.continuationPolicy;
		this.#excludeAttemptIds = input.excludeAttemptIds;
	}

	get metadata(): PaidAttemptMetadata {
		const value = this.#metadataValue;
		if (value === undefined) throw new Error("paid-attempt adapter is not installed");
		return value;
	}

	/** The exact pre-send decision the host should use; no provider request is sent after a refusal. */
	check(): PaidAttemptGate {
		return this.#currentGate();
	}

	/** Cumulative exact receipts plus pending/unresolved facts. Pure with respect to the delta cursor. */
	observe(): PaidAttemptObservation {
		const gate = this.#currentGate();
		const fault = this.#firstFault();
		const byModel: Record<string, PaidAttemptModelObservation> = {};
		for (const key of [...this.#byModel.keys()].sort()) {
			const value = this.#byModel.get(key);
			if (value === undefined) continue;
			byModel[key] = {
				knownUsd: value.knownUsd,
				observedReceipts: value.observedReceipts,
				unresolvedReceipts: value.unresolvedReceipts,
				pendingAttempts: value.pendingAttempts,
			};
		}
		const pending = [...this.#pending].sort((a, b) => a.attemptId.localeCompare(b.attemptId));
		const unresolved = [...this.#unresolved].sort((a, b) => a.seq - b.seq || a.attemptId.localeCompare(b.attemptId));
		return {
			runId: this.runId,
			ownerSessionId: this.ownerSessionId,
			bindingToken: this.bindingToken,
			limit: limitOf(this.mode, this.limitUsd),
			knownCostUsd: this.#knownCostUsd,
			startCostUsd: this.#startCostUsd,
			knownReceipts: this.#knownReceipts,
			settledReceipts: this.#settledReceipts,
			byModel,
			pending,
			unresolved,
			pendingCount: pending.length,
			unresolvedCount: unresolved.length,
			lastSeq: this.#lastSeq,
			startSeq: this.#baselineSeq,
			receiptToken: this.#receiptToken(),
			accounting: fault === undefined ? "effective" : "faulted",
			complete: !this.#disposed && fault === undefined && pending.length === 0 && unresolved.length === 0,
			disposed: this.#disposed,
			legacy: PAID_ATTEMPT_NO_LEGACY_ADD,
			...(fault === undefined ? {} : { fault: { code: fault.code, detail: fault.detail } }),
			...(this.#lastRefusal === undefined ? {} : { lastRefusal: this.#lastRefusal }),
			gate,
		};
	}

	/** New in-scope exact receipts since the previous take, by model. Duplicate observations add nothing. */
	takeDelta(): PaidAttemptDelta {
		if (!this.#disposed) {
			this.#checkHostIdentity();
			this.#reconcileSafely();
		}
		const byModel: Record<string, number> = {};
		for (const key of [...this.#deltaByModel.keys()].sort()) {
			const value = this.#deltaByModel.get(key);
			if (value !== undefined) byModel[key] = value;
		}
		const delta: PaidAttemptDelta = {
			runId: this.runId,
			ownerSessionId: this.ownerSessionId,
			bindingToken: this.bindingToken,
			usd: this.#deltaUsd,
			byModel,
			settledReceipts: this.#deltaSettled,
			fromSeq: this.#deltaFromSeq,
			toSeq: this.#lastSeq,
			receiptToken: this.#receiptToken(),
			pendingCount: this.#pending.length,
			unresolvedCount: this.#unresolved.length,
			// The delta is this run's business only: an earlier binding's unresolved receipt stays visible in `observe`
			// but must not make this run's live spend a floor.
			inScopeUnresolvedCount: this.#unresolved.filter(fact => fact.inScope).length,
		};
		this.#deltaUsd = 0;
		this.#deltaByModel = new Map();
		this.#deltaSettled = 0;
		this.#deltaFromSeq = this.#lastSeq;
		return delta;
	}

	/** Known revocation of this run. The first reason wins; the host decision stays installed to refuse. */
	revoke(reason: string): boolean {
		if (this.#disposed || this.#revokedReason !== undefined) return false;
		if (!nonEmpty(reason)) throw new Error("paid-attempt revoke reason must be a non-empty string");
		this.#revokedReason = oneLine(reason);
		return true;
	}

	/** Clear only a decision this adapter installed, then release its slot. Idempotent. */
	dispose(): PaidAttemptCleanup {
		if (this.#disposed) return { disposed: false };
		this.#disposed = true;
		this.#revokedReason ??= "adapter disposed";
		if (activeAdapters.get(this.ownerSessionId) === this.bindingToken) {
			activeAdapters.delete(this.ownerSessionId);
			if (this.#authorizationInstalled) {
				this.#authorizationInstalled = false;
				try {
					this.#api.authorize(undefined);
				} catch {
					// The authority is being abandoned; the retained decider still refuses.
				}
			}
		}
		return { disposed: true };
	}

	install(): { readonly code: PaidAttemptUnavailableCode; readonly detail: string } | undefined {
		// Receipts are observed by pull at every decision/observation boundary. Subscribing to onReceipt and rescanning
		// the complete receipts() array per notification was quadratic in the receipt count and added no exactness: the
		// same state()/receipts() snapshot is read immediately before each use. `onReceipt` remains a required surface
		// capability but is not installed here.
		try {
			this.#api.authorize(this.#decider);
		} catch (error) {
			// A refusal leaves any previous fail-closed or unowned authority exactly as it was.
			return { code: "host-readonly", detail: `authorize refused the owner decision: ${messageOf(error)}` };
		}
		let managed: unknown;
		let owner: unknown;
		try {
			managed = this.#api.managed;
			owner = this.#api.ownerSessionId;
		} catch (error) {
			return {
				code: "host-invalid",
				detail: `authorize returned but the authority could not be re-read: ${messageOf(error)}`,
			};
		}
		if (owner !== this.ownerSessionId) {
			// Do not clear a decision on a surface that no longer names this owner.
			return { code: "host-owner-mismatch", detail: `authorize changed the owner to ${String(owner)}` };
		}
		if (managed !== true) {
			// A no-op authorize must not be followed by authorize(undefined), which could turn a previously
			// fail-closed authority into an unmanaged one.
			return { code: "host-unmanaged", detail: "authorize returned but managed stayed false" };
		}
		this.#authorizationInstalled = true;

		const initial = this.#readState();
		if (initial.ok) {
			this.#baselineKnown = true;
			this.#baselineSeq = initial.state.lastSeq;
			this.#deltaFromSeq = initial.state.lastSeq;
		}
		this.#maxSeqSeen = this.#baselineSeq;
		this.#reconcileSafely();
		const fault = this.#firstFault();
		this.#metadataValue = metadataOf({
			runId: this.runId,
			expectedOwnerSessionId: this.ownerSessionId,
			hostOwnerSessionId: this.ownerSessionId,
			bindingToken: this.bindingToken,
			startSeq: this.#baselineSeq,
			startCostUsd: this.#startCostUsd,
			limit: limitOf(this.mode, this.limitUsd),
			authorization: "installed",
			accounting: fault === undefined ? "effective" : "faulted",
		});
		return undefined;
	}

	#decide(attemptRaw: unknown, stateRaw: unknown): PaidAttemptDecision {
		try {
			return this.#decideChecked(attemptRaw, stateRaw);
		} catch (error) {
			const detail = `the paid-attempt decision failed: ${messageOf(error)}`;
			this.#fault("host-state-invalid", detail, true);
			return { send: false, reason: this.#refuse("host-state-invalid", detail).reason };
		}
	}

	#decideChecked(attemptRaw: unknown, stateRaw: unknown): PaidAttemptDecision {
		if (this.#disposed) {
			const gate = this.#currentGate();
			return gate.send ? { send: true } : { send: false, reason: gate.reason };
		}
		const parsed = parseAttempt(attemptRaw, this.ownerSessionId);
		if (!parsed.ok) {
			const gate = this.#refuse(parsed.code, parsed.detail);
			return { send: false, reason: gate.reason };
		}
		const gate = this.#currentGate(parsed.attempt);
		if (!gate.send) return { send: false, reason: gate.reason };
		const passed = parseState(stateRaw, this.ownerSessionId);
		if (!passed.ok) {
			this.#fault(passed.code, passed.detail, true);
			return { send: false, reason: this.#refuse(passed.code, passed.detail).reason };
		}
		if (!this.#matchesPassedState(passed.state)) {
			return { send: false, reason: this.#refuse("host-state-inconsistent", "the state handed to the decision is not the reconciled state").reason };
		}
		return { send: true };
	}

	#matchesPassedState(state: PaidAttemptStateView): boolean {
		if (state.lastSeq !== this.#lastSeq) return false;
		if (Math.abs(state.observedCost - this.#hostObservedCost) > COST_EPSILON) return false;
		const passedPending = state.pending
			.filter(item => !this.#excludeAttemptIds.has(item.attemptId))
			.map(item => item.attemptId)
			.sort()
			.join("\u0000");
		const currentPending = this.#pending
			.map(item => item.attemptId)
			.sort()
			.join("\u0000");
		return passedPending === currentPending;
	}

	#currentGate(attempt?: PaidAttemptRequestView): PaidAttemptGate {
		if (this.#disposed) return this.#refuse("adapter-disposed", "the adapter was disposed");
		this.#checkHostIdentity();
		this.#reconcileSafely();
		const fault = this.#firstFault();
		const revoked = this.#revocation();
		if (revoked !== undefined) return revoked;
		if (fault !== undefined) return this.#refuse(fault.code, fault.detail);
		const continuation = attempt !== undefined && this.#continuationAllowed(attempt);
		if (this.mode === "finite") {
			if (this.#pending.length > 0 && !continuation) {
				// No exact upper bound for an unsettled provider attempt exists at this boundary, so a finite budget
				// that cannot bound it refuses the next dispatch rather than treating pending as zero.
				const ids = this.#pending
					.slice(0, 3)
					.map(item => item.attemptId)
					.join(",");
				return this.#refuse(
					"unresolved-pending",
					`${this.#pending.length} admitted attempt(s) await settlement; cost is unknown, not zero: ${ids}${this.#pending.length > 3 ? ",..." : ""}`,
				);
			}
			const relevant = this.#unresolved.filter(fact => fact.inScope);
			if (relevant.length > 0 && !continuation) {
				const facts = relevant
					.slice(0, 3)
					.map(item => `${item.attemptId}[${item.reasons.join(",")}]`)
					.join(" ");
				return this.#refuse(
					"unresolved-receipt",
					`${relevant.length} in-scope settled receipt(s) lack exact native proof: ${facts}${relevant.length > 3 ? ",..." : ""}`,
				);
			}
			if (!continuation && this.limitUsd !== undefined && this.#knownCostUsd > this.limitUsd) {
				return this.#refuse(
					"limit-exceeded",
					`exact authorized cost ${this.#knownCostUsd} exceeds the approved limit ${this.limitUsd}`,
				);
			}
		}
		return {
			send: true,
			knownCostUsd: this.#knownCostUsd,
			lastSeq: this.#lastSeq,
			pendingCount: this.#pending.length,
			unresolvedCount: this.#unresolved.length,
		};
	}

	/** Whether this exact attempt is a continuation the caller's block-spawns policy proved, not a new dispatch. */
	#continuationAllowed(attempt: PaidAttemptRequestView): boolean {
		if (this.#continuationPolicy !== "leader-and-exact-worker") return false;
		if (attempt.actorSessionId === this.ownerSessionId) {
			// The leader's own loop is the active turn finishing/reporting after the known threshold. A leader title,
			// label or probe is not that continuation and keeps the ordinary refusal.
			return attempt.purpose === "loop" && this.limitUsd !== undefined && this.#knownCostUsd >= this.limitUsd;
		}
		// A worker actor is granted only after an in-scope admitted receipt with observed exact cost. The receipt's own
		// append ack is a separate durability flag (the persisted row is written before the flush ack); cost exactness is
		// what this grant proves. A pending or unknown attempt has no grant and a never-admitted worker stays terminal.
		return this.#grantedActors.has(attempt.actorSessionId);
	}

	#revocation(): PaidAttemptGate | undefined {
		if (this.#revokedReason !== undefined) return this.#refuse("adapter-revoked", this.#revokedReason);
		if (this.#isRevoked === undefined) return undefined;
		try {
			const value = this.#isRevoked();
			if (value === true) return this.#refuse("adapter-revoked", "the run reported itself revoked");
			if (value !== false) return this.#refuse("revocation-unknown", "the run revocation check did not return a boolean");
			return undefined;
		} catch (error) {
			return this.#refuse("revocation-unknown", `the run revocation check failed: ${messageOf(error)}`);
		}
	}

	#checkHostIdentity(): void {
		try {
			if (this.#api.managed !== true) {
				this.#fault("host-unmanaged", "ctx.paidAttempts.managed is no longer true", true);
				return;
			}
			if (this.#api.ownerSessionId !== this.ownerSessionId) {
				this.#fault("host-owner-mismatch", `ctx.paidAttempts owner changed to ${this.#api.ownerSessionId}`, true);
			}
		} catch (error) {
			this.#fault("host-unavailable", `re-reading the paid-attempt authority failed: ${messageOf(error)}`, true);
		}
	}

	#readState():
		| { readonly ok: true; readonly state: PaidAttemptStateView }
		| { readonly ok: false; readonly code: PaidAttemptRefusalCode; readonly detail: string } {
		let raw: unknown;
		try {
			raw = this.#api.state();
		} catch (error) {
			const detail = `state() failed: ${messageOf(error)}`;
			this.#fault("host-unavailable", detail, true);
			return { ok: false, code: "host-unavailable", detail };
		}
		const parsed = parseState(raw, this.ownerSessionId);
		if (!parsed.ok) this.#fault(parsed.code, parsed.detail, true);
		return parsed;
	}

	#readReceipts():
		| { readonly ok: true; readonly entries: readonly ParsedReceipt[] }
		| { readonly ok: false; readonly code: PaidAttemptRefusalCode; readonly detail: string } {
		let raw: unknown;
		try {
			raw = this.#api.receipts();
		} catch (error) {
			const detail = `receipts() failed: ${messageOf(error)}`;
			this.#fault("host-unavailable", detail, true);
			return { ok: false, code: "host-unavailable", detail };
		}
		if (!Array.isArray(raw)) {
			const detail = "receipts() did not return an array";
			this.#fault("host-state-invalid", detail, true);
			return { ok: false, code: "host-state-invalid", detail };
		}
		const entries: ParsedReceipt[] = [];
		for (const item of raw) {
			const parsed = parseReceipt(item, this.ownerSessionId);
			if (!parsed.ok) {
				this.#fault(parsed.code, parsed.detail, true);
				return { ok: false, code: parsed.code, detail: parsed.detail };
			}
			entries.push(parsed.parsed);
		}
		return { ok: true, entries };
	}

	#reconcileSafely(): void {
		try {
			this.#reconcile();
		} catch (error) {
			this.#fault("host-state-invalid", `reconciliation failed: ${messageOf(error)}`, true);
		}
	}

	#reconcile(): void {
		if (this.#disposed) return;
		// Without a readable baseline, no receipt can be placed inside or outside this run. Refuse (the initial read
		// already left a sticky fault) and keep the known cost at the explicit start cost rather than guessing scope.
		if (!this.#baselineKnown) return;
		const state = this.#readState();
		if (!state.ok) return;
		const listed = this.#readReceipts();
		if (!listed.ok) return;

		const unique: ParsedReceipt[] = [];
		const byId = new Map<string, ParsedReceipt>();
		const seqOwner = new Map<number, string>();
		for (const entry of listed.entries) {
			const receipt = entry.receipt;
			const prior = byId.get(receipt.attemptId);
			if (prior !== undefined) {
				if (prior.fingerprint !== entry.fingerprint) {
					this.#fault("receipt-mutated", `receipt ${receipt.attemptId} changed between snapshots`, true);
					return;
				}
				continue;
			}
			const owner = seqOwner.get(receipt.seq);
			if (owner !== undefined) {
				this.#fault("receipt-sequence", `seq ${receipt.seq} is claimed by ${owner} and ${receipt.attemptId}`, false);
				return;
			}
			byId.set(receipt.attemptId, entry);
			seqOwner.set(receipt.seq, receipt.attemptId);
			unique.push(entry);
		}
		for (let index = 0; index < unique.length; index++) {
			const entry = unique[index];
			if (entry === undefined) continue;
			const expected = index + 1;
			if (entry.receipt.seq !== expected) {
				this.#fault(
					"receipt-sequence",
					`receipt ${entry.receipt.attemptId} has seq ${entry.receipt.seq} where ${expected} was expected`,
					false,
				);
				return;
			}
		}
		if (unique.length !== state.state.lastSeq) {
			this.#fault(
				"receipt-sequence",
				`receipts() has ${unique.length} entries for lastSeq ${state.state.lastSeq}`,
				false,
			);
			return;
		}
		if (state.state.lastSeq < this.#maxSeqSeen) {
			this.#fault("receipt-sequence", `lastSeq went backwards from ${this.#maxSeqSeen} to ${state.state.lastSeq}`, true);
			return;
		}

		const nextFingerprints = new Map(this.#fingerprints);
		for (const entry of unique) {
			const prior = nextFingerprints.get(entry.receipt.attemptId);
			if (prior !== undefined && prior !== entry.fingerprint) {
				this.#fault("receipt-mutated", `receipt ${entry.receipt.attemptId} changed after it was observed`, true);
				return;
			}
			nextFingerprints.set(entry.receipt.attemptId, entry.fingerprint);
		}
		for (const attemptId of this.#fingerprints.keys()) {
			if (!nextFingerprints.has(attemptId)) {
				this.#fault("receipt-mutated", `receipt ${attemptId} disappeared from receipts()`, true);
				return;
			}
		}

		const nextProof = new Map(this.#appendProof);
		for (const entry of unique) {
			const receipt = entry.receipt;
			const prior = nextProof.get(receipt.attemptId);
			if (prior !== undefined) {
				if (prior.append === "flushed" && receipt.append !== "flushed") {
					this.#fault("receipt-mutated", `receipt ${receipt.attemptId} lost its flushed append`, true);
					return;
				}
				if (prior.append === "failed" && receipt.append === "unavailable") {
					this.#fault("receipt-mutated", `receipt ${receipt.attemptId} append regressed from failed`, true);
					return;
				}
				if (prior.entryId !== undefined && receipt.receiptEntryId !== prior.entryId) {
					this.#fault("receipt-mutated", `receipt ${receipt.attemptId} changed its receipt entry`, true);
					return;
				}
			}
			nextProof.set(receipt.attemptId, { append: receipt.append, entryId: receipt.receiptEntryId });
		}

		const observed = observedCostOf(unique);
		const computed: Fault[] = [];
		if (observed.known && Math.abs(observed.usd - state.state.observedCost) > COST_EPSILON) {
			computed.push({
				code: "observed-cost-mismatch",
				detail: `state observedCost ${state.state.observedCost} is not receipts' ${observed.usd}`,
			});
		}
		const receiptIds = new Set(unique.map(entry => entry.receipt.attemptId));
		for (const pending of state.state.pending) {
			if (receiptIds.has(pending.attemptId)) {
				computed.push({
					code: "host-state-invalid",
					detail: `attempt ${pending.attemptId} is both pending and settled`,
				});
				break;
			}
		}

		this.#fingerprints = nextFingerprints;
		this.#appendProof = nextProof;
		this.#maxSeqSeen = Math.max(this.#maxSeqSeen, state.state.lastSeq);
		this.#lastSeq = state.state.lastSeq;
		this.#hostObservedCost = state.state.observedCost;
		const snapshotFaults = this.#buildSnapshot(state.state, unique);
		this.#computedFaults = [...computed, ...snapshotFaults];
	}

	#buildSnapshot(state: PaidAttemptStateView, entries: readonly ParsedReceipt[]): Fault[] {
		const faults: Fault[] = [];
		const byModel = new Map<string, MutableModel>();
		const unresolved = new Map<string, { readonly receipt: PaidAttemptReceiptView; readonly reasons: Set<PaidAttemptUnresolvedReason>; readonly inScope: boolean }>();
		const modelOf = (model: string): MutableModel => {
			let value = byModel.get(model);
			if (value === undefined) {
				value = { knownUsd: 0, observedReceipts: 0, unresolvedReceipts: 0, pendingAttempts: 0 };
				byModel.set(model, value);
			}
			return value;
		};
		const addUnresolved = (
			receipt: PaidAttemptReceiptView,
			reasons: readonly PaidAttemptUnresolvedReason[],
			inScope: boolean,
		): void => {
			let fact = unresolved.get(receipt.attemptId);
			if (fact === undefined) {
				fact = { receipt, reasons: new Set(), inScope };
				unresolved.set(receipt.attemptId, fact);
			}
			for (const reason of reasons) fact.reasons.add(reason);
		};

		let knownCostUsd = this.#startCostUsd;
		let knownReceipts = 0;
		let settledReceipts = 0;
		const classifications = new Map<string, Classification>();
		const grantedActors = new Set<string>();
		for (const entry of entries) {
			const receipt = entry.receipt;
			const inScope = receipt.seq > this.#baselineSeq && !this.#excludeAttemptIds.has(receipt.attemptId);
			const classification = classify(receipt);
			classifications.set(receipt.attemptId, classification);
			if (inScope) {
				settledReceipts++;
				if (classification.spendKnown) {
					knownCostUsd += classification.spendUsd;
					knownReceipts++;
					const model = modelOf(receipt.model);
					model.knownUsd += classification.spendUsd;
					model.observedReceipts++;
					if (receipt.gate === "admitted" && receipt.sent === true && receipt.actorSessionId !== this.ownerSessionId) {
						grantedActors.add(receipt.actorSessionId);
					}
				}
			}
			if (classification.reasons.length > 0 && !this.#excludeAttemptIds.has(receipt.attemptId)) {
				addUnresolved(receipt, classification.reasons, inScope);
			}
		}

		for (const receipt of state.unresolved) {
			// The host keeps every refused receipt in `unresolved` because its costBasis is unknown. A refused receipt
			// proves `sent: false`, so its exact spend is zero; treating it as unresolved would block every later permit
			// for the rest of the run after the first refusal.
			if (isExactRefusal(receipt) || this.#excludeAttemptIds.has(receipt.attemptId)) continue;
			const inScope = receipt.seq > this.#baselineSeq;
			addUnresolved(receipt, ["host-unresolved"], inScope);
		}

		const pending: PaidAttemptPendingFact[] = state.pending
			.filter(item => !this.#excludeAttemptIds.has(item.attemptId))
			.map(item => ({
				attemptId: item.attemptId,
				model: item.model,
				purpose: item.purpose,
				actorSessionId: item.actorSessionId,
			}));
		for (const item of pending) {
			if (unresolved.has(item.attemptId)) {
				faults.push({
					code: "host-state-invalid",
					detail: `attempt ${item.attemptId} is both pending and unresolved`,
				});
				break;
			}
			modelOf(item.model).pendingAttempts++;
		}

		for (const fact of unresolved.values()) {
			modelOf(fact.receipt.model).unresolvedReceipts++;
		}

		for (const entry of entries) {
			const receipt = entry.receipt;
			if (receipt.seq <= this.#baselineSeq || this.#excludeAttemptIds.has(receipt.attemptId)) continue;
			if (this.#deltaSeen.has(receipt.attemptId)) continue;
			this.#deltaSeen.add(receipt.attemptId);
			this.#deltaSettled++;
			const classification = classifications.get(receipt.attemptId);
			const spend = classification?.spendKnown === true ? classification.spendUsd : 0;
			this.#deltaUsd += spend;
			this.#deltaByModel.set(receipt.model, (this.#deltaByModel.get(receipt.model) ?? 0) + spend);
		}

		this.#pending = pending;
		this.#unresolved = [...unresolved.values()].map(fact => ({
			attemptId: fact.receipt.attemptId,
			seq: fact.receipt.seq,
			model: fact.receipt.model,
			inScope: fact.inScope,
			reasons: UNRESOLVED_ORDER.filter(reason => fact.reasons.has(reason)),
		}));
		this.#byModel = byModel;
		this.#grantedActors = grantedActors;
		this.#knownCostUsd = knownCostUsd;
		this.#knownReceipts = knownReceipts;
		this.#settledReceipts = settledReceipts;
		return faults;
	}

	#fault(code: PaidAttemptRefusalCode, detail: string, sticky = false): void {
		const target = sticky ? this.#stickyFaults : this.#computedFaults;
		if (target.some(fault => fault.code === code)) return;
		target.push({ code, detail: oneLine(detail) });
	}

	#firstFault(): Fault | undefined {
		const all = [...this.#stickyFaults, ...this.#computedFaults];
		for (const code of FAULT_ORDER) {
			const found = all.find(fault => fault.code === code);
			if (found !== undefined) return found;
		}
		return all[0];
	}

	#refuse(code: PaidAttemptRefusalCode, detail: string): PaidAttemptRefusalGate {
		const safe = oneLine(detail);
		const reason = `${PAID_ATTEMPT_REFUSAL_TAG} ${code}: ${safe}`;
		this.#lastRefusal = { code, detail: safe, reason };
		return {
			send: false,
			code,
			detail: safe,
			reason,
			knownCostUsd: this.#knownCostUsd,
			lastSeq: this.#lastSeq,
			pendingCount: this.#pending.length,
			unresolvedCount: this.#unresolved.length,
		};
	}

	#receiptToken(): string {
		return `${this.bindingToken}#${this.#lastSeq}`;
	}
}
