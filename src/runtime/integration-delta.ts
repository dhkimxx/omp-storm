import type {
	AdmissionKey, ChildEntryClaim, ConsumedInput, FrozenScope, GitObjectSource, IntegrationCandidateId,
	IntegrationCheck, IntegrationProblem, IntegrationRead, IntegrationTarget, LocatedInputPath, PathImage,
} from "./integration-admission.ts";

export interface StoredPatchRef {
	readonly schema: "storm.integration-patch/v1";
	readonly key: AdmissionKey;
	/** Owner-store key, not a host path; namespace and record ownership matter even for identical bytes. */
	readonly objectKey: string;
	readonly bytes: number;
	readonly sha256: string;
}
export interface ByteWindow {
	readonly maxBytes: number;
	readonly deadline: number;
	readonly signal: AbortSignal;
}
/** A implements, B calls. Never accepts a raw filename, exceeds the caller's cap or gives bytes to live install
 * before verification. Returns unknown on missing/unsafe/drifted content; no re-open-by-name after verification. */
export interface IntegrationBytePort {
	readPatch(ref: StoredPatchRef, window: ByteWindow): Promise<IntegrationRead<Uint8Array>>;
}
export interface ObjectImage {
	readonly state: Extract<PathImage, { kind: "file" }>;
	readonly oid: string;
}
export type DeltaImage = ObjectImage | { readonly state: Extract<PathImage, { kind: "absent" }> };
export interface ExactPathDelta {
	readonly gitPath: string;
	readonly targetPath: string;
	readonly encoding: "text" | "binary";
	readonly before: DeltaImage;
	readonly after: DeltaImage;
}
export interface RootProofRequest {
	readonly key: AdmissionKey;
	readonly candidateId: IntegrationCandidateId;
	readonly target: IntegrationTarget;
	readonly scope: FrozenScope;
	readonly sourceOdb: GitObjectSource;
	readonly root: StoredPatchRef;
}
export interface ExactDeltaProof extends RootProofRequest {
	readonly schema: "storm.integration-delta/v1";
	/** Digest covers binding, root copy and complete ordered path map. One unsupported entry voids this whole proof. */
	readonly digest: string;
	readonly entries: readonly ExactPathDelta[];
	readonly expandedBytes: number;
}
export type Presence =
	| { readonly kind: "present"; readonly observedAt: number }
	| { readonly kind: "changed"; readonly observedAt: number; readonly firstPath: string }
	| { readonly kind: "unknown"; readonly problem: IntegrationProblem };
export type DirtyPaths = { readonly total: number; readonly examples: readonly string[]; readonly dirtyDeletes: readonly string[] };

/** B implements; A calls proveRoot before sealing, B consumes the proof at install, C calls presence/detail and E
 * injects checkout-input verification. Never mutates target/index/HEAD, uses HEAD as a preimage, guesses an OID, or
 * scans the worktree. Unknown or unsupported leaves no proof; unreadable observations return unknown. */
export interface IntegrationDeltaPort {
	proveRoot(request: RootProofRequest, window: ByteWindow): Promise<IntegrationRead<ExactDeltaProof>>;
	verifyCheckoutInputs(claim: ChildEntryClaim, inputs: readonly ConsumedInput[], window: ByteWindow): Promise<IntegrationCheck>;
	observePresence(target: IntegrationTarget, paths: readonly LocatedInputPath[], window: ByteWindow): Promise<Presence>;
	observeDirtyPaths(proof: ExactDeltaProof, window: ByteWindow): Promise<IntegrationRead<DirtyPaths>>;
}
