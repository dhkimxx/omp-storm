import type { LiveCheck } from "../types.ts";
import type {
	AdmissionKey, DirectorIdentity, IntegrationCandidateId, IntegrationCheck, IntegrationProblem, IntegrationRead,
	IntegrationTarget, PathImage, ReceiptRef, RunId, SpaceIdentity,
} from "./integration-admission.ts";
import type { CaptureJournalPort, LateRecoveryObservation, SealedCaptureManifest } from "./integration-capture.ts";
import type { ByteWindow, ExactDeltaProof, Presence } from "./integration-delta.ts";
import type { LeaseOwner, RunLease } from "./lease.ts";

export interface CandidateRevision {
	readonly key: AdmissionKey;
	readonly candidateId: IntegrationCandidateId;
	readonly manifestDigest: string;
}
export interface SelectionKey {
	readonly runId: RunId;
	readonly callId: string;
}
export interface SelectionSnapshot {
	readonly key: SelectionKey;
	readonly chosen: readonly IntegrationCandidateId[];
	readonly ordered: readonly IntegrationCandidateId[];
}
export interface WriteAuthorityAudit {
	readonly selection: SelectionKey;
	readonly director: DirectorIdentity;
	readonly conversationId: string;
	readonly askId: string;
	readonly deadline: number;
}
export interface IntegrationLiveGrant {
	readonly audit: WriteAuthorityAudit;
	readonly signal: AbortSignal;
	/** C/E validate live owner, target, mode, consent, deadline, spend and stop. B checks this inside commit. */
	check(): LiveCheck;
	/** C refreshes consumed versions and actual source locations under the segment; failure refuses live dispatch. */
	revalidateCandidate(candidate: CandidateRevision, window: ByteWindow): Promise<LiveCheck>;
	/** C checks current manifest/revocation, original epoch/contract and consumed input versions plus locations.
	 * This is the synchronous publication check after refreshed file/image preflight, never permission to start a check. */
	checkCandidate(candidate: CandidateRevision): LiveCheck;
}
export interface IntentPath {
	readonly path: string;
	readonly before: PathImage;
	readonly after: PathImage;
}
export interface WriteIntent {
	readonly schema: "storm.integration-intent/v1";
	readonly sequence: number;
	readonly candidate: CandidateRevision;
	readonly deltaDigest: string;
	readonly target: IntegrationTarget;
	readonly index: { readonly path: string; readonly file: SpaceIdentity | null; readonly sha256: string | null };
	readonly head: { readonly ref: string | null; readonly oid: string | null };
	readonly paths: readonly IntentPath[];
	readonly audit: WriteAuthorityAudit;
	readonly owner: Readonly<LeaseOwner>;
	readonly holderKey: string;
	/** B's fixed installer-effect identity is durable before dispatch; a crashed director alone proves no end. */
	readonly effectToken: string;
}
export interface ProvenEffectEnd {
	readonly token: WriteIntent["effectToken"];
	readonly basis: "never-dispatched" | "installer-exit-proved";
	readonly observedAt: number;
}
export interface WriteReceipt {
	readonly schema: "storm.integration-receipt/v1";
	readonly ref: ReceiptRef;
	readonly intent: WriteIntent;
	readonly end: Omit<ProvenEffectEnd, "basis"> & { readonly basis: "installer-exit-proved" };
	readonly readBackAt: number;
}
export interface TargetFenceRef {
	readonly leaseKey: string;
	readonly root: string;
	readonly runId: RunId;
	readonly intentSequence: number;
	readonly effectToken: WriteIntent["effectToken"];
}
export type TargetFenceLookup =
	| { readonly kind: "clear" }
	| { readonly kind: "fenced"; readonly fence: TargetFenceRef }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };
export interface FenceInspection {
	readonly fence: TargetFenceRef;
	readonly effectEnd: IntegrationRead<ProvenEffectEnd>;
	readonly images: IntegrationRead<"all-pre" | "all-post" | "mixed">;
	readonly receipt: IntegrationRead<WriteReceipt | null>;
}
export interface FenceResolutionRequest {
	readonly fence: TargetFenceRef;
	readonly audit: { readonly sessionId: string; readonly userActionId: string; readonly acknowledgedAt: number };
	/** E supplies direct operator confirmation only, C forwards it; not model authorization. */
	checkOperator(): LiveCheck;
}
export type FenceResolution =
	| { readonly kind: "released"; readonly disposition: "proved-no-effect" | "present-unattributed" | "durable-receipt" }
	| { readonly kind: "kept"; readonly problem: IntegrationProblem };
export type CandidateWriteResult =
	| { readonly kind: "written"; readonly receipt: WriteReceipt }
	| { readonly kind: "already-written"; readonly receipt: WriteReceipt; readonly presence: Presence }
	| { readonly kind: "conflict" | "refused"; readonly problem: IntegrationProblem }
	| { readonly kind: "no-effect"; readonly end: ProvenEffectEnd; readonly problem: IntegrationProblem }
	| { readonly kind: "present-unattributed"; readonly observedAt: number; readonly problem: IntegrationProblem }
	| { readonly kind: "recovery-required"; readonly fence: IntegrationRead<TargetFenceRef>; readonly problem: IntegrationProblem };
export interface WriteStepRecord {
	readonly candidateId: IntegrationCandidateId;
	readonly state: CandidateWriteResult["kind"] | "not-ready" | "not-started";
	readonly problem?: IntegrationProblem;
}
export interface StoredCandidate {
	readonly manifest: SealedCaptureManifest;
	readonly recovery: readonly LateRecoveryObservation[];
	readonly lastWrite: CandidateWriteResult | null;
}

/** B implements, C calls. Never confuses unreadable with empty or clears a fence because of timeout, restart, or
 * candidate absence. Fences are keyed by physical target with canonical-root fallback under the lease protocol. */
export interface IntegrationJournalPort extends CaptureJournalPort {
	readCandidate(runId: RunId, candidateId: IntegrationCandidateId): Promise<IntegrationRead<StoredCandidate | null>>;
	/** One bounded keyed replay for an authorized owner/run; null means the run has no integration record. */
	replay(runId: RunId, onCandidate: (entry: StoredCandidate) => void): Promise<IntegrationRead<{ readonly lastSequence: number } | null>>;
	beginSelection(selection: SelectionSnapshot): Promise<IntegrationCheck>;
	/** Writer outcomes needed for recovery also get recorded by B at the intent boundary, not inferred from this audit. */
	recordStep(selection: SelectionKey, step: WriteStepRecord): Promise<IntegrationCheck>;
	findFence(target: { readonly canonicalRoot: string; readonly leaseKey?: string }): Promise<TargetFenceLookup>;
	inspectFence(fence: TargetFenceRef, window: ByteWindow): Promise<IntegrationRead<FenceInspection>>;
	/** Under the same target protocol, effect end plus exact observations; never installs, restores, or adopts success. */
	resolveFence(input: FenceResolutionRequest, window: ByteWindow): Promise<FenceResolution>;
}

declare const segmentHolderBrand: unique symbol;
export type SegmentHolder = { readonly key: string; readonly [segmentHolderBrand]: true };
export interface WriterSegmentRequest {
	readonly lease: RunLease;
	readonly target: IntegrationTarget;
	readonly selection: SelectionSnapshot;
	readonly live: IntegrationLiveGrant;
	readonly window: ByteWindow;
}
/** B implements in integration-git/record and the real table/lease; C alone calls from an explicit selected action.
 * Never starts with unknown holder/lease/fence, upgrades automatically on delivery or releases during possible effects.
 * Unknown before dispatch is refused; uncertainty after dispatch is fenced and terminates the segment. */
export interface IntegrationWriterPort {
	reserveSegment(request: WriterSegmentRequest): Promise<IntegrationRead<SegmentHolder>>;
	/** B binds proof to the durable manifest, reopens the exact copy, and rechecks lease/live/inputs at the effect. */
	applyCandidate(input: {
		readonly holder: SegmentHolder; readonly candidate: CandidateRevision; readonly proof: ExactDeltaProof;
		readonly window: ByteWindow;
	}): Promise<CandidateWriteResult>;
	/** Only ends the bounded table holder; recovery fencing is independent and survives it and the run lease. */
	finishSegment(holder: SegmentHolder): Promise<IntegrationCheck>;
}
