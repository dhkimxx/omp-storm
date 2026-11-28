import type { PlanLane, RunResultState } from "../types.ts";
import type { AttemptPreparation, AttemptSettlement } from "./attempt-bridge.ts";
import type {
	AdmissionKey, ConsumedInput, FrozenIntegrationAdmission, IntegrationCandidateId, IntegrationCheck, IntegrationProblem,
	IntegrationRead, LocatedInputPath, ReceiptRef, RunId,
} from "./integration-admission.ts";
import type { CaptureUpdate, CheckoutObservation, EmittedBundle } from "./integration-capture.ts";
import type { ByteWindow, DirtyPaths, Presence } from "./integration-delta.ts";
import type {
	CandidateRevision, FenceResolution, FenceResolutionRequest, IntegrationLiveGrant, SelectionSnapshot, WriteReceipt,
	WriteStepRecord,
} from "./integration-record.ts";

/** Only C constructs, the existing evaluator/location code consumes. A receipt is necessary, not an acceptance.
 * Unknown, stale, outside-scope, or noncurrent bytes return no witness, never the last known receipt as live proof. */
export interface AttemptWriteWitness {
	readonly attemptId: NonNullable<AttemptSettlement["report"]["attemptId"]>;
	readonly dispatch: AttemptPreparation["dispatch"];
	readonly lane: string;
	readonly epoch: number;
	readonly contractDigest: string;
	readonly consumed: readonly ConsumedInput[];
	readonly receipt: ReceiptRef;
	/** Exact before/after content-change intersection with original evaluation scope; no mode-only credit. */
	readonly attributable: readonly LocatedInputPath[];
	readonly observedAt: number;
}
export type IntegratedInput = Extract<ConsumedInput, { state: "integrated" }>;
export interface IntegratedProducerQuery {
	readonly runId: RunId;
	readonly lane: PlanLane["name"];
}
/** C implements; E calls prepare/discard, B's dependencyStart reads a refreshed readiness snapshot, and C alone
 * reads witnesses. Never promotes pending, pathless answer/artifact, stale receipt or prior run; returns unknown. */
export interface IntegrationAttemptPort {
	prepareAdmission(input: {
		readonly admission: Omit<FrozenIntegrationAdmission, "subject">;
		readonly placement: { readonly kind: "planned"; readonly lane: string } | { readonly kind: "unplanned" };
	}): Promise<IntegrationRead<FrozenIntegrationAdmission>>;
	/** E calls in the final synchronous grant step; only committed admissions appear in C's active queue. */
	commitAdmission(key: AdmissionKey): IntegrationCheck;
	discardAdmission(key: AdmissionKey): void;
	/** Internal C adapter to the original evaluator; B and E must not call this to manufacture acceptance. */
	readWitness(settlement: AttemptSettlement, resultId: string, window: ByteWindow): Promise<IntegrationRead<AttemptWriteWitness>>;
	/** Same-run, current qualifying verdict/location for each in-scope declared result, or one dedicated resultless footprint. */
	readIntegratedProducer(query: IntegratedProducerQuery): IntegrationRead<readonly IntegratedInput[]>;
}
export type QueueReadiness =
	| { readonly kind: "awaiting-native" | "ready" | "confirmed-empty" }
	| { readonly kind: "kept-only" | "unknown" | "conflict" | "stale"; readonly problem: IntegrationProblem };
export type QueueWrite =
	| { readonly kind: "not-written" }
	| { readonly kind: "not-recorded" | "present-unattributed" | "no-effect" | "recovery-required"; readonly problem: IntegrationProblem }
	| { readonly kind: "written"; readonly receipt: ReceiptRef; readonly at: number };
export interface CandidateLine {
	readonly candidateId: IntegrationCandidateId;
	readonly childHandle: string;
	readonly subject: { readonly kind: "planned"; readonly lane: string } | { readonly kind: "unplanned" };
	readonly readiness: QueueReadiness;
	readonly write: QueueWrite;
	readonly presence: Presence;
}
export interface QueueOverview {
	readonly runId: RunId;
	readonly observedAt: number;
	readonly readiness: Readonly<Record<QueueReadiness["kind"], number>>;
	readonly writes: Readonly<Record<QueueWrite["kind"], number>>;
	readonly present: number;
	readonly changed: number;
	readonly unknownPresence: number;
	/** At most three lines in stable placement/ID order; exact ID remains retrievable. */
	readonly examples: readonly CandidateLine[];
	/** At most 20 opaque IDs in placement/ID order, so the director can actually select beyond the examples. */
	readonly page: readonly IntegrationCandidateId[];
	readonly nextAfter: IntegrationCandidateId | null;
}
export interface CandidateDetail {
	readonly line: CandidateLine;
	readonly revision: CandidateRevision | null;
	readonly provenance: {
		readonly key: AdmissionKey;
		readonly placementOrdinal: number;
		readonly carrier: IntegrationRead<"sync" | "wait" | "push">;
		readonly checkoutClaim: IntegrationRead<{ readonly reference: string; readonly checkedAt: number }>;
	};
	readonly outcome: IntegrationRead<"success" | "failure" | "cancel">;
	readonly stopCause: IntegrationRead<string>;
	readonly cancelRequested: boolean;
	readonly bundle: EmittedBundle["kind"];
	readonly recovery: {
		readonly stormCopy: IntegrationRead<{ readonly reference: string; readonly bytes: number; readonly sha256: string }>;
		readonly nativePatch: IntegrationRead<string>;
		readonly nativeBranch: IntegrationRead<{ readonly ref: string; readonly base: IntegrationRead<string>; readonly tip: IntegrationRead<string> }>;
		readonly nestedCount: IntegrationRead<number>;
		/** Bounded typed references to verified recovery parts, not arguments to integrate. */
		readonly nestedExamples: readonly { readonly reference: string; readonly relativeRepo: IntegrationRead<string> }[];
		readonly checkout: CheckoutObservation;
		readonly nativeLink: IntegrationRead<string>;
	};
	readonly dirtyPaths: IntegrationRead<DirtyPaths>;
	readonly resultStates: readonly { readonly id: string; readonly state: RunResultState }[];
}
export type CandidateQuery =
	| { readonly kind: "overview"; readonly runId?: RunId; readonly after?: IntegrationCandidateId }
	| { readonly kind: "detail"; readonly runId?: RunId; readonly candidateId: IntegrationCandidateId };
export type CandidateProjection =
	| { readonly kind: "not-recorded" }
	| { readonly kind: "overview"; readonly value: QueueOverview }
	| { readonly kind: "detail"; readonly value: CandidateDetail }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };
export type IntegrationSelectionReply =
	| { readonly kind: "refused"; readonly problem: IntegrationProblem }
	| {
		readonly kind: "selection";
		readonly selection: SelectionSnapshot;
		readonly started: number;
		readonly written: number;
		readonly skipped: number;
		readonly notStarted: number;
		readonly examples: readonly WriteStepRecord[];
		readonly firstNotStarted: IntegrationCandidateId | null;
		readonly stop: IntegrationProblem | null;
	};

/** D implements pure formatting in runtime/views.ts; E calls. Never reads the filesystem or treats unknown as empty. */
export interface IntegrationViewPort {
	formatIntegrationCandidates(projection: CandidateProjection): string;
	formatIntegrationSelection(reply: IntegrationSelectionReply): string;
}

/** C implements; A sends durable updates, E calls from the owning session, D reads projections only. Never starts a
 * target effect via ingest, projection, native wake, close, resume or reconciliation; only select uses B's writer.
 * Unknown history is not an empty list, and selection validation failure refuses the entire request before writes. */
export interface IntegrationControllerPort {
	observe(update: CaptureUpdate): Promise<void>;
	project(query: CandidateQuery, window: ByteWindow): Promise<CandidateProjection>;
	/** Untrusted tool text until all IDs and the owning live ask are checked. No selection is resumed automatically. */
	select(input: { readonly candidateIds: readonly string[]; readonly live: Omit<IntegrationLiveGrant, "revalidateCandidate" | "checkCandidate"> }): Promise<IntegrationSelectionReply>;
	/** C exposes this only to the user-facing operator flow in E, never to the registered model tool. */
	reconcile(input: FenceResolutionRequest, window: ByteWindow): Promise<FenceResolution>;
}

/** Internal C handoff only: B supplies the durable receipt; C may re-enter the original evaluator once after fresh
 * validation. Never accepts on write receipt alone; unknown attestation or cancelled/closed authority yields no new judgment. */
export type OnIntegrationReceipt = (receipt: WriteReceipt) => Promise<void>;
