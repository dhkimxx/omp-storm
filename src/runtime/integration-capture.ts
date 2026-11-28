import type { AttemptSettlement } from "./attempt-bridge.ts";
import type { AttemptOutcome, SyncResultFact } from "./attempt-report.ts";
import type {
	AdmissionKey, ChildEntryClaim, DirectorIdentity, FrozenIntegrationAdmission, IntegrationCandidateId,
	IntegrationCheck, IntegrationProblem, IntegrationRead, NativeTaskItem, ObservationIdentity,
} from "./integration-admission.ts";
import type { ExactDeltaProof, StoredPatchRef } from "./integration-delta.ts";

export interface NativeJobExecution {
	readonly jobId: string;
	readonly type: "task";
	readonly agentId: NativeTaskItem["handle"];
	/** Opaque token from proved per-item owner/start binding (or unique first execution), not a timestamp or label. */
	readonly execution: string;
}
export type BoundTerminal = {
	readonly observedAt: number;
	readonly outcome: IntegrationRead<AttemptOutcome>;
	readonly structured: "not-requested" | "valid" | "invalid" | "unknown";
	readonly stopCause: IntegrationRead<"user" | "budget" | "guard" | "host-abort" | "failed-yield" | "capture-error">;
	readonly cancelRequested: boolean;
	readonly nativeLink: string;
} & (
	| { readonly carrier: "sync"; readonly item: NativeTaskItem; readonly exitCode: number; readonly aborted: boolean }
	| { readonly carrier: "wait" | "push"; readonly job: NativeJobExecution; readonly status: "completed" | "failed" | "cancelled" }
);
export interface PartRef {
	readonly nativePath: string;
	readonly copy: IntegrationRead<StoredPatchRef>;
}
export interface NestedPartRef extends PartRef {
	/** Known only if typed by host; never derived from filename. */
	readonly relativeRepo: IntegrationRead<string>;
}
export interface RecoveryBranch {
	readonly ref: string;
	readonly typedBaseOid: IntegrationRead<string>;
	readonly observedTipOid: IntegrationRead<string>;
}
export type CheckoutObservation =
	| { readonly kind: "present" | "not-found"; readonly checkedAt: number }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };
/** Branch, copies, native path and exact checkout have separate lifetimes. An empty observation says nothing absent. */
export interface RecoveryFacts {
	readonly root: IntegrationRead<PartRef>;
	readonly nested: IntegrationRead<readonly NestedPartRef[]>;
	readonly branch: IntegrationRead<RecoveryBranch>;
	readonly checkout: CheckoutObservation;
	readonly nativeLink: IntegrationRead<string>;
}
export type EmittedBundle =
	| { readonly kind: "root-only"; readonly basis: "sync-explicit" | "native-success-registry"; readonly root: StoredPatchRef }
	| { readonly kind: "confirmed-empty"; readonly basis: "sync-explicit" | "native-success-registry"; readonly root: StoredPatchRef }
	| { readonly kind: "kept-only"; readonly problem: IntegrationProblem }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };
export interface SealedCaptureManifest {
	readonly schema: "storm.integration-capture/v1";
	/** Hash of canonical validated manifest payload excluding this digest. Includes any exact delta, never mutable state. */
	readonly digest: string;
	readonly admission: FrozenIntegrationAdmission;
	readonly childClaim: IntegrationRead<ChildEntryClaim>;
	readonly terminal: IntegrationRead<BoundTerminal>;
	readonly bundle: EmittedBundle;
	readonly delta: IntegrationRead<ExactDeltaProof>;
	readonly recovery: RecoveryFacts;
}
export interface LateRecoveryObservation {
	readonly schema: "storm.integration-recovery/v1";
	readonly key: AdmissionKey;
	readonly candidateId: IntegrationCandidateId;
	readonly observationKey: string;
	readonly observedAt: number;
	readonly facts: RecoveryFacts;
	/** A bound contradiction can revoke unused readiness, never rewrite a manifest or issue a receipt. */
	readonly contradiction: IntegrationRead<IntegrationProblem>;
}
export type CaptureUpdate =
	| { readonly kind: "sealed"; readonly manifest: SealedCaptureManifest; readonly journalSequence: number; readonly settlement?: AttemptSettlement }
	| { readonly kind: "recovery"; readonly observation: LateRecoveryObservation; readonly journalSequence: number }
	/** Active-run fail-closed diagnostic only; never a durable record, a readiness grant, or an acceptance. */
	| { readonly kind: "unavailable"; readonly key: AdmissionKey; readonly candidateId: IntegrationCandidateId; readonly problem: IntegrationProblem };

/** B implements as a facet of the one journal; A calls after its safe copy and delta attempt. Never starts parent
 * work or overwrites a seal. Unknown store/durability returns unknown, never a sequence C may use as authority. */
export interface CaptureJournalPort {
	appendManifest(manifest: SealedCaptureManifest): Promise<IntegrationRead<number>>;
	appendRecovery(observation: LateRecoveryObservation): Promise<IntegrationRead<number>>;
}
export interface RegistrySnapshotInput {
	readonly director: DirectorIdentity;
	readonly registryInstance: string;
	readonly event: "registered" | "metadata_changed" | "status_changed" | "removed";
	readonly handle: string;
	readonly parentId: string | null;
	readonly parentSessionKey: string | null;
	readonly generation: number | null;
	readonly childSessionFile: string | null;
	readonly history: { readonly patchPath?: string; readonly nestedPatchPaths?: readonly string[]; readonly branchName?: string };
	readonly observedAt: number;
}
export interface AsyncObservationInput {
	readonly director: DirectorIdentity;
	readonly carrier: "registration" | "ack" | "wait" | "push";
	/**
	 * Host call id for an `ack` envelope. Required to bind the resolved job to the exact admitted call/item; absent
	 * means the acknowledgement cannot authorize a positive capture.
	 */
	readonly toolCallId?: string | undefined;
	/**
	 * Host details unchanged. An `ack` carries `async.executions[]` of exact per-item execution proofs; `wait` and
	 * `push` rows carry the same proof as `execution`. A stock row has no proof and can never authorize a positive.
	 */
	readonly details: unknown;
	readonly observedAt: number;
}

/** A implements; E attaches before dispatch, C receives durable updates or a fail-closed diagnostic. Never interprets
 * merge-summary as evidence, watches a mutable ref after the event, wakes a worker, repeats wait, or applies anything.
 * Unbound events get no candidate; missing facts are unknown, and copy/terminal can complete in either order. */
export interface IntegrationCapturePort {
	track(admission: FrozenIntegrationAdmission): IntegrationCheck;
	abandonBeforeDispatch(key: AdmissionKey): void;
	/** Invoke in the registry listener stack, before any await; the adapter snapshots primitive data/part list here. */
	observeRegistry(snapshot: RegistrySnapshotInput): void;
	/** `results` are the host's rows unchanged, including each row's original-call `index`; E never re-indexes a batch. */
	observeSync(input: { readonly director: DirectorIdentity; readonly toolCallId: string; readonly results: readonly (SyncResultFact & { readonly index?: unknown; readonly isolated?: unknown; readonly branchName?: unknown; readonly branchBaseSha?: unknown })[]; readonly observedAt: number }): void;
	observeAsync(input: AsyncObservationInput): void;
	/** Called only for the matching first-execution admission, never from wake/arrival fallback. */
	observeClaim(entry: ObservationIdentity, claim: ChildEntryClaim): void;
}
