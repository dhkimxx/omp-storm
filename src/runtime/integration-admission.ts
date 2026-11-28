import type { LaneNeed, LiveCheck, PlanLaneResult, RunRecord } from "../types.ts";
import type { WorkerAdmissionRecord } from "../worker-admission.ts";
import type { AttemptPreparation } from "./attempt-bridge.ts";

export type RunId = RunRecord["runId"];
export type DispatchId = AttemptPreparation["dispatch"];
declare const candidateIdBrand: unique symbol;
/** Runtime spelling: c1_ plus 64 lowercase hex; minted once from the versioned admission key. */
export type IntegrationCandidateId = string & { readonly [candidateIdBrand]: true };
export interface AdmissionKey {
	readonly schema: "storm.integration-admission/v1";
	readonly runId: RunId;
	readonly dispatch: DispatchId;
}
export interface IntegrationProblem<Code extends string = string> {
	readonly code: Code;
	/** Bounded diagnostic/next action; never an authority or interpreted as a path. */
	readonly reason: string;
	readonly path?: string;
}
export type IntegrationRead<T> =
	| { readonly kind: "known"; readonly value: T }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };
export type IntegrationCheck = { readonly ok: true } | { readonly ok: false; readonly problem: IntegrationProblem };
export interface SpaceIdentity {
	readonly canonicalPath: string;
	/** Decimal strings, from a pinned handle or equivalent; do not round stat IDs to a JS number. */
	readonly device: string;
	readonly inode: string;
}
export interface DirectorIdentity {
	readonly sessionId: WorkerAdmissionRecord["sessionId"];
	readonly sessionInstance: string;
	readonly sessionDir: WorkerAdmissionRecord["sessionDir"];
	readonly parentId: WorkerAdmissionRecord["parentId"];
}
export interface GitObjectSource {
	readonly commonDir: SpaceIdentity;
	readonly objects: SpaceIdentity;
	readonly objectFormat: "sha1" | "sha256";
}
export interface IntegrationTarget {
	/** Same physical-worktree key/digest used by the existing RunLease, never a repo slug or HEAD. */
	readonly leaseKey: string;
	readonly authorizedRoot: SpaceIdentity;
	readonly gitRoot: SpaceIdentity;
	readonly gitDir: SpaceIdentity;
	readonly sourceOdb: GitObjectSource;
	/** Authorized root relative to gitRoot; empty for top level. */
	readonly targetPrefix: string;
}
export type FrozenScope = { readonly kind: "unbounded" } | { readonly kind: "paths"; readonly paths: readonly string[] };
export type RegularFileMode = "100644" | "100755";
export type PathImage =
	| { readonly kind: "absent" }
	| { readonly kind: "file"; readonly mode: RegularFileMode; readonly bytes: number; readonly sha256: string };
export interface LocatedInputPath {
	/** Literal, canonical, authorized-target-relative path. */
	readonly path: string;
	readonly image: PathImage;
}
export interface ReceiptRef {
	readonly key: AdmissionKey;
	readonly candidateId: IntegrationCandidateId;
	readonly manifestDigest: string;
	readonly intentSequence: number;
	readonly receiptSequence: number;
}
export type InputSubject =
	| { readonly kind: "result"; readonly id: string }
	| { readonly kind: "resultless-footprint"; readonly lane: string };
export type ConsumedInput = {
	readonly producerLane: string;
	readonly need: LaneNeed;
	readonly subject: InputSubject;
} & (
	| { readonly state: "missing" }
	| { readonly state: "version"; readonly version: string }
	| { readonly state: "integrated"; readonly version: string; readonly receipt: ReceiptRef; readonly paths: readonly LocatedInputPath[] }
);
export type AdmissionSubject =
	| {
		readonly kind: "planned";
		readonly lane: string;
		readonly epoch: number;
		readonly contractDigest: string;
		readonly results: readonly Readonly<PlanLaneResult>[];
		readonly consumed: readonly ConsumedInput[];
	}
	| { readonly kind: "unplanned" };
export interface NativeTaskItem {
	readonly toolCallId: string;
	readonly itemIndex: number;
	readonly handle: WorkerAdmissionRecord["childId"];
}
export interface ObservationIdentity {
	readonly registryInstance: string;
	readonly generation: number;
	readonly childSessionFile: SpaceIdentity;
}
export interface NativeSlotLease {
	readonly key: AdmissionKey;
	readonly profile: string;
	readonly slotPath: string;
	readonly ownerToken: string;
}
export interface ApplyPolicyProofRef {
	readonly id: string;
	readonly host: "19.2.1";
	readonly settingsInstance: string;
	readonly relevantEpoch: number;
	readonly directorInstance: string;
	readonly toolCallId: string;
	readonly enabled: true;
	/** Proof basis must cover the later host backend read too, not only observation before the spawn hook returns. */
	readonly backendProofId: string;
	readonly apply: false;
	/** Managed positive launch is patch mode only; explicit source-proved non-ovnfs route. */
	readonly merge: "patch";
	readonly captureContract: "native-git-synthetic-tree";
	readonly backendSetting: string;
	readonly profile: string;
	readonly guardBuild: string;
}
export interface FrozenIntegrationAdmission {
	readonly key: AdmissionKey;
	readonly candidateId: IntegrationCandidateId;
	readonly director: DirectorIdentity;
	readonly target: IntegrationTarget;
	readonly artifactRoot: SpaceIdentity;
	readonly item: NativeTaskItem;
	readonly placementOrdinal: number;
	readonly approvedDefinitionDigest: string;
	readonly approvalDigest: string;
	readonly workerAdmission: Pick<Readonly<WorkerAdmissionRecord>, "key" | "attempt" | "approved">;
	readonly scope: FrozenScope;
	readonly subject: AdmissionSubject;
	readonly policy: ApplyPolicyProofRef;
	readonly slot: NativeSlotLease;
	readonly startedAt: number;
}
export interface ChildEntryClaim {
	readonly key: AdmissionKey;
	readonly candidateId: IntegrationCandidateId;
	readonly entry: ObservationIdentity;
	readonly childHandle: NativeTaskItem["handle"];
	readonly policyProofId: ApplyPolicyProofRef["id"];
	readonly workerAttempt: WorkerAdmissionRecord["attempt"];
	readonly slotOwnerToken: NativeSlotLease["ownerToken"];
	readonly hostOwner: { readonly pid: number; readonly processStart: number; readonly host: string };
	readonly checkout: SpaceIdentity;
	readonly checkoutGitDir: SpaceIdentity;
	readonly checkoutIndexPath: string;
	readonly checkoutTargetPrefix: string;
	readonly sourceOdb: GitObjectSource;
	readonly guardBuild: string;
	readonly preWorkHead: string | null;
	readonly checkedAt: number;
}

/** E implements and calls at the owning tool/hook boundary. Never uses a global Settings fallback or final-value-only proof.
 * Unknown identity, epoch, backend choice, profile or guard becomes unknown at arm / a failed final check; no grant. */
export interface ApplyPolicyPort {
	arm(input: { readonly director: DirectorIdentity; readonly toolCallId: string }): IntegrationRead<ApplyPolicyProofRef>;
	checkBeforeGrant(proof: ApplyPolicyProofRef, item: NativeTaskItem): IntegrationCheck;
}

/** A implements (disk admission/slot/claim); E calls, A's collector reads. Never launches, grants a live user turn,
 * resolves a native slot from model text, or reaps a checkout. Unknown admission/claim is not published as a grant. */
export interface IntegrationAdmissionPort {
	reserveSlot(input: {
		readonly key: AdmissionKey; readonly target: IntegrationTarget; readonly item: NativeTaskItem; readonly profile: string;
	}): Promise<IntegrationRead<NativeSlotLease>>;
	/** Prepare before E's final synchronous policy/live checks; aborted grants are rolled back by exact owner. */
	persistPrepared(admission: FrozenIntegrationAdmission): Promise<IntegrationCheck>;
	readPrepared(worker: Pick<Readonly<WorkerAdmissionRecord>, "key" | "attempt">): Promise<IntegrationRead<FrozenIntegrationAdmission>>;
	/** Revoke by exact admission/slot owner if the final grant did not publish; never touches a replacement. */
	abandonPrepared(admission: FrozenIntegrationAdmission): Promise<IntegrationCheck>;
	/** Child boundary. A anchors cwd, marker and Git admin, verifies actual input bytes via B before durable publish. */
	claimAtEntry(input: {
		readonly admission: FrozenIntegrationAdmission;
		readonly worker: Readonly<WorkerAdmissionRecord>;
		readonly entry: ObservationIdentity;
		readonly childCwd: string;
		readonly guardBuild: string;
		readonly live: () => LiveCheck;
		readonly verifyInputs: (claim: ChildEntryClaim, inputs: readonly ConsumedInput[]) => Promise<IntegrationCheck>;
	}): Promise<IntegrationRead<ChildEntryClaim>>;
	readClaim(key: AdmissionKey): Promise<IntegrationRead<ChildEntryClaim>>;
	/** Only releases this reservation after proved no dispatch or proved native effect end; unknown stays held. */
	releaseSlot(slot: NativeSlotLease, cause: "not-dispatched" | "native-ended"): Promise<IntegrationCheck>;
}
