/**
 * The one durable integration journal, its target fence pointers, and the exclusive parent writer.
 *
 * Capture manifests, recovery observations, selections, write intents, proved effect ends and receipts are append-only
 * records in `<sessionDir>/state/integration/runs/<runId>/journal.jsonl`, each carrying its sequence, the previous
 * record's hash and its own hash. A torn or foreign tail is unknown, never empty. The target fence pointer lives under
 * the lease namespace keyed by the canonical worktree identity, so a later managed session can find an unresolved
 * write without reading another session's store. The writer never stages, never rolls back and never clears a fence on
 * a timeout: only a coherent all-pre with a proved end, an all-post with a proved end, or a durable receipt releases it.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { serialized } from "../fsutil.ts";
import { assertSessionPathSafe } from "../session-scope.ts";
import type { LiveCheck } from "../types.ts";
import type {
	AdmissionKey, DirectorIdentity, IntegrationCandidateId, IntegrationCheck, IntegrationProblem, IntegrationRead,
	IntegrationTarget, PathImage, ReceiptRef, RunId, SpaceIdentity,
} from "./integration-admission.ts";
import type { CaptureJournalPort, LateRecoveryObservation, SealedCaptureManifest } from "./integration-capture.ts";
import type {
	ByteWindow, DeltaImage, ExactDeltaProof, IntegrationBytePort, IntegrationDeltaPort, Presence, StoredPatchRef,
} from "./integration-delta.ts";
import {
	ByteBudget, cleanIntegrationPath, deltaDigest, GitInstaller, spawnGit, type GitRun, type InstallOutcome, type Installer,
	type Footprint, readFootprint, verifyFootprint, observePostimages,
} from "./integration-git.ts";
import { runLanes } from "./lanes.ts";
import { canonicalWorktree, integrationFenceFile, integrationFenceFiles, leaseNamespace, type LeaseDeps, type LeaseOwner, type LeaseSnapshot, type RunLease } from "./lease.ts";
import { isRunId } from "./run.ts";

const JOURNAL_SCHEMA = "storm.integration-journal/v1";
const MANIFEST_SCHEMA = "storm.integration-capture/v1";
const RECOVERY_SCHEMA = "storm.integration-recovery/v1";
const FENCE_SCHEMA = "storm.integration-fence/v1";
const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CLOSURE_RESERVE = 16 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_FENCE_BYTES = 16_384;
const MAX_SELECTION = 128;
const CANDIDATE_ID = /^c1_[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

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

/** The journal is bound to one owner store; a symlink alias of the same physical store is the same store. */
async function sameSessionStore(a: string, b: string): Promise<boolean> {
	if (a === b) return true;
	try {
		return (await fs.realpath(a)) === (await fs.realpath(b));
	} catch {
		return false;
	}
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The one canonical plain-object guard for the integration wire records this module parses from disk and from the
 * ports. Every field is then checked by its own guard; this only distinguishes an object from `null`, arrays and
 * primitives at the boundary.
 */
export function isIntegrationObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problem(code: string, reason: string, at?: string): IntegrationProblem {
	return at === undefined ? { code, reason } : { code, reason, path: at };
}

function errorCodeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function isProblem(value: unknown): value is IntegrationProblem {
	return isIntegrationObject(value) && typeof value.code === "string" && typeof value.reason === "string";
}

function isAdmissionKey(value: unknown): value is AdmissionKey {
	return isIntegrationObject(value) && value.schema === "storm.integration-admission/v1" && typeof value.runId === "string" && typeof value.dispatch === "string";
}

function isCandidateId(value: unknown): value is IntegrationCandidateId {
	return typeof value === "string" && CANDIDATE_ID.test(value);
}

/**
 * The candidate identity the wire contract mints: SHA-256 of the versioned admission tuple. Exported once so the
 * admission owner, the journal and the tool all validate the same spelling; persisted JSON never grants the brand.
 */
export function integrationCandidateId(key: AdmissionKey): IntegrationCandidateId {
	if (!isAdmissionKey(key) || !isRunId(key.runId) || key.dispatch.length === 0 || key.dispatch.length > 4_096) {
		throw new Error("통합 후보 키가 올바르지 않습니다.");
	}
	const digest = sha256(JSON.stringify([key.schema, key.runId, key.dispatch]));
	return `c1_${digest}` as IntegrationCandidateId;
}

function sameKey(a: AdmissionKey, b: AdmissionKey): boolean {
	return a.schema === b.schema && a.runId === b.runId && a.dispatch === b.dispatch;
}

function isSelectionKey(value: unknown): value is SelectionKey {
	return isIntegrationObject(value) && typeof value.runId === "string" && isRunId(value.runId) && typeof value.callId === "string" && value.callId.length > 0;
}

function isSelection(value: unknown): value is SelectionSnapshot {
	if (!isIntegrationObject(value) || !isSelectionKey(value.key)) return false;
	if (!Array.isArray(value.chosen) || !Array.isArray(value.ordered)) return false;
	if (value.chosen.length === 0 || value.chosen.length > MAX_SELECTION) return false;
	if (value.chosen.length !== value.ordered.length) return false;
	if (!value.chosen.every(isCandidateId) || !value.ordered.every(isCandidateId)) return false;
	if (new Set(value.chosen).size !== value.chosen.length) return false;
	const ordered = new Set(value.ordered);
	return value.chosen.every(candidate => ordered.has(candidate));
}

function isStep(value: unknown): value is WriteStepRecord {
	if (!isIntegrationObject(value) || !isCandidateId(value.candidateId) || typeof value.state !== "string") return false;
	const states = ["written", "already-written", "conflict", "refused", "no-effect", "present-unattributed", "recovery-required", "not-ready", "not-started"];
	return states.includes(value.state) && (value.problem === undefined || isProblem(value.problem));
}

function isStoredPatchRef(value: unknown): value is StoredPatchRef {
	return isIntegrationObject(value) &&
		value.schema === "storm.integration-patch/v1" &&
		isAdmissionKey(value.key) &&
		typeof value.objectKey === "string" && value.objectKey.length > 0 &&
		typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
		typeof value.sha256 === "string" && DIGEST.test(value.sha256);
}

function isManifest(value: unknown): value is SealedCaptureManifest {
	if (!isIntegrationObject(value) || value.schema !== MANIFEST_SCHEMA || typeof value.digest !== "string" || !DIGEST.test(value.digest)) return false;
	const admission = value.admission;
	if (!isIntegrationObject(admission) || !isAdmissionKey(admission.key) || !isCandidateId(admission.candidateId)) return false;
	if (!isIntegrationTarget(admission.target)) return false;
	if (!isIntegrationObject(value.bundle) || typeof value.bundle.kind !== "string") return false;
	if (value.bundle.kind === "root-only" || value.bundle.kind === "confirmed-empty") {
		if (!isStoredPatchRef(value.bundle.root) || !sameKey(value.bundle.root.key, admission.key)) return false;
	}
	if (!isIntegrationObject(value.delta) || (value.delta.kind !== "known" && value.delta.kind !== "unknown")) return false;
	return true;
}

function isRecovery(value: unknown): value is LateRecoveryObservation {
	if (!isIntegrationObject(value) || value.schema !== RECOVERY_SCHEMA || !isAdmissionKey(value.key) || !isCandidateId(value.candidateId)) return false;
	return typeof value.observationKey === "string" && value.observationKey.length > 0 && typeof value.observedAt === "number" && isIntegrationObject(value.facts);
}

function isSpaceIdentity(value: unknown): value is SpaceIdentity {
	return isIntegrationObject(value) &&
		typeof value.canonicalPath === "string" &&
		path.isAbsolute(value.canonicalPath) &&
		typeof value.device === "string" && /^\d+$/u.test(value.device) &&
		typeof value.inode === "string" && /^\d+$/u.test(value.inode);
}

function isIntegrationTarget(value: unknown): value is IntegrationTarget {
	if (!isIntegrationObject(value)) return false;
	if (typeof value.leaseKey !== "string" || value.leaseKey.length === 0) return false;
	if (!isSpaceIdentity(value.authorizedRoot) || !isSpaceIdentity(value.gitRoot) || !isSpaceIdentity(value.gitDir)) return false;
	if (!isIntegrationObject(value.sourceOdb) || !isSpaceIdentity(value.sourceOdb.commonDir) || !isSpaceIdentity(value.sourceOdb.objects)) return false;
	if (value.sourceOdb.objectFormat !== "sha1" && value.sourceOdb.objectFormat !== "sha256") return false;
	return typeof value.targetPrefix === "string" && (value.targetPrefix === "" || cleanIntegrationPath(value.targetPrefix) === value.targetPrefix);
}

function isPathImageValue(value: unknown): value is PathImage {
	if (!isIntegrationObject(value) || typeof value.kind !== "string") return false;
	if (value.kind === "absent") return true;
	if (value.kind !== "file") return false;
	if (value.mode !== "100644" && value.mode !== "100755") return false;
	if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0) return false;
	return typeof value.sha256 === "string" && DIGEST.test(value.sha256);
}

function isIntent(value: unknown): value is WriteIntent {
	if (!isIntegrationObject(value) || value.schema !== "storm.integration-intent/v1") return false;
	if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return false;
	const candidate = value.candidate;
	if (!isIntegrationObject(candidate) || !isAdmissionKey(candidate.key) || !isCandidateId(candidate.candidateId)) return false;
	if (typeof candidate.manifestDigest !== "string" || !DIGEST.test(candidate.manifestDigest)) return false;
	if (typeof value.deltaDigest !== "string" || !DIGEST.test(value.deltaDigest)) return false;
	if (typeof value.effectToken !== "string" || value.effectToken.length < 8 || typeof value.holderKey !== "string") return false;
	if (!isIntegrationTarget(value.target)) return false;
	if (!Array.isArray(value.paths) || value.paths.length === 0) return false;
	for (const entry of value.paths) {
		if (!isIntegrationObject(entry) || typeof entry.path !== "string") return false;
		if (cleanIntegrationPath(entry.path) !== entry.path) return false;
		if (!isPathImageValue(entry.before) || !isPathImageValue(entry.after)) return false;
	}
	const head = value.head;
	if (!isIntegrationObject(head) || (head.ref !== null && typeof head.ref !== "string") || (head.oid !== null && typeof head.oid !== "string")) return false;
	const index = value.index;
	if (!isIntegrationObject(index) || typeof index.path !== "string") return false;
	if (index.file !== null && !isSpaceIdentity(index.file)) return false;
	if (index.sha256 !== null && (typeof index.sha256 !== "string" || !DIGEST.test(index.sha256))) return false;
	const audit = value.audit;
	if (!isIntegrationObject(audit) || !isIntegrationObject(audit.selection) || typeof audit.conversationId !== "string" || typeof audit.askId !== "string" || typeof audit.deadline !== "number") return false;
	const owner = value.owner;
	if (!isIntegrationObject(owner) || typeof owner.token !== "string" || typeof owner.pid !== "number" || typeof owner.host !== "string" || typeof owner.processStart !== "number") return false;
	return true;
}

function isEffectEnd(value: unknown): value is ProvenEffectEnd {
	return isIntegrationObject(value) && typeof value.token === "string" &&
		(value.basis === "never-dispatched" || value.basis === "installer-exit-proved") &&
		typeof value.observedAt === "number";
}

function isReceipt(value: unknown): value is WriteReceipt {
	if (!isIntegrationObject(value) || value.schema !== "storm.integration-receipt/v1") return false;
	if (!isIntegrationObject(value.ref) || !isAdmissionKey(value.ref.key) || !isCandidateId(value.ref.candidateId)) return false;
	if (typeof value.ref.manifestDigest !== "string" || !Number.isSafeInteger(value.ref.intentSequence)) return false;
	if (!Number.isSafeInteger(value.ref.receiptSequence)) return false;
	if (!isIntent(value.intent) || !isIntegrationObject(value.end) || value.end.basis !== "installer-exit-proved") return false;
	return typeof value.readBackAt === "number";
}

function isFence(value: unknown): value is TargetFenceRef {
	return isIntegrationObject(value) &&
		typeof value.leaseKey === "string" && DIGEST.test(value.leaseKey) &&
		typeof value.root === "string" && path.isAbsolute(value.root) &&
		typeof value.runId === "string" &&
		isRunId(value.runId) &&
		Number.isSafeInteger(value.intentSequence) &&
		typeof value.effectToken === "string";
}

type JournalKind = "manifest" | "recovery" | "selection" | "step" | "intent" | "effect-end" | "receipt" | "fence-clear";

interface JournalRecord {
	readonly schema: typeof JOURNAL_SCHEMA;
	readonly seq: number;
	readonly prev: string;
	readonly at: number;
	readonly kind: JournalKind;
	readonly payload: unknown;
	readonly hash: string;
}

function isRecord(value: unknown): value is JournalRecord {
	if (!isIntegrationObject(value) || value.schema !== JOURNAL_SCHEMA) return false;
	if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 1) return false;
	if (typeof value.prev !== "string" || typeof value.hash !== "string" || !DIGEST.test(value.hash)) return false;
	if (typeof value.at !== "number" || typeof value.kind !== "string") return false;
	const kinds: readonly string[] = ["manifest", "recovery", "selection", "step", "intent", "effect-end", "receipt", "fence-clear"];
	return kinds.includes(value.kind);
}

function recordHash(record: Omit<JournalRecord, "hash">): string {
	return sha256(JSON.stringify({
		schema: record.schema,
		seq: record.seq,
		prev: record.prev,
		at: record.at,
		kind: record.kind,
		payload: record.payload,
	}));
}

function payloadOf(record: JournalRecord): Record<string, unknown> | undefined {
	return isIntegrationObject(record.payload) ? record.payload : undefined;
}

function manifestOf(record: JournalRecord): SealedCaptureManifest | undefined {
	const payload = payloadOf(record);
	return payload !== undefined && isManifest(payload.manifest) ? payload.manifest : undefined;
}

function recoveryOf(record: JournalRecord): LateRecoveryObservation | undefined {
	const payload = payloadOf(record);
	return payload !== undefined && isRecovery(payload.observation) ? payload.observation : undefined;
}

function selectionOf(record: JournalRecord): SelectionSnapshot | undefined {
	const payload = payloadOf(record);
	return payload !== undefined && isSelection(payload.selection) ? payload.selection : undefined;
}

function stepOf(record: JournalRecord): { selection: SelectionKey; step: WriteStepRecord } | undefined {
	const payload = payloadOf(record);
	if (payload === undefined || !isSelectionKey(payload.selection) || !isStep(payload.step)) return undefined;
	return { selection: payload.selection, step: payload.step };
}

function intentOf(record: JournalRecord): WriteIntent | undefined {
	const payload = payloadOf(record);
	return payload !== undefined && isIntent(payload.intent) ? payload.intent : undefined;
}

function effectEndOf(record: JournalRecord): ProvenEffectEnd | undefined {
	const payload = payloadOf(record);
	return payload !== undefined && isEffectEnd(payload.end) ? payload.end : undefined;
}

function receiptOf(record: JournalRecord): WriteReceipt | undefined {
	const payload = payloadOf(record);
	return payload !== undefined && isReceipt(payload.receipt) ? payload.receipt : undefined;
}

/** Order-independent equality for persisted records: object keys are sorted before comparison. */
function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (isIntegrationObject(value)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
		return out;
	}
	return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function fenceReason(fence: TargetFenceRef): string {
	return `${fence.root} (실행 ${fence.runId}, 의도 ${fence.intentSequence}, 효과 ${fence.effectToken.slice(0, 8)})`;
}

function sameFence(a: TargetFenceRef, b: TargetFenceRef): boolean {
	return a.leaseKey === b.leaseKey && a.root === b.root && a.runId === b.runId && a.intentSequence === b.intentSequence && a.effectToken === b.effectToken;
}

/** The per-run journal bytes cap plus the owner-profile cap, checked before every append. */
interface StoreCache {
	readonly at: number;
	readonly bytes: number;
}

interface HeadCache {
	readonly size: number;
	readonly seq: number;
	readonly prev: string;
	readonly torn: IntegrationProblem | undefined;
}

interface RunCache {
	readonly size: number;
	readonly records: readonly JournalRecord[];
}

export interface IntegrationJournalOptions {
	readonly sessionDir: string;
	readonly now?: () => number;
	readonly leaseDeps?: LeaseDeps;
}

/** What the writer needs from the journal beyond the wire port; the class below implements both. */
export interface IntegrationJournalStore extends IntegrationJournalPort {
	readonly sessionDir: string;
	cachedFence(root: string): TargetFenceLookup;
	appendIntent(input: {
		readonly runId: RunId;
		readonly build: (sequence: number) => WriteIntent;
	}): Promise<IntegrationRead<WriteIntent>>;
	writeFence(intent: WriteIntent): Promise<IntegrationRead<TargetFenceRef>>;
	appendEffectEnd(runId: RunId, end: ProvenEffectEnd): Promise<IntegrationCheck>;
	appendReceipt(runId: RunId, candidateId: IntegrationCandidateId, build: (sequence: number) => WriteReceipt): Promise<IntegrationRead<WriteReceipt>>;
	receiptFor(runId: RunId, candidateId: IntegrationCandidateId): Promise<IntegrationRead<WriteReceipt | null>>;
	clearFence(fence: TargetFenceRef): Promise<IntegrationCheck>;
	fencePointer(fence: TargetFenceRef): Promise<IntegrationRead<{ readonly file: string; readonly journalPath: string }>>;
}

/** B's journal: one append protocol for A's capture, C's selection and its own write records. */
export class IntegrationJournal implements IntegrationJournalStore {
	readonly sessionDir: string;
	private readonly now: () => number;
	private readonly leaseBase: string;
	private readonly heads = new Map<string, HeadCache>();
	private readonly runs = new Map<string, RunCache>();
	private readonly fenceCache = new Map<string, TargetFenceLookup>();
	private storeCache: StoreCache | undefined;
	private storeDirty = true;

	constructor(options: IntegrationJournalOptions) {
		if (!path.isAbsolute(options.sessionDir)) throw new Error("통합 저장소는 절대 경로의 세션 디렉터리여야 합니다.");
		this.sessionDir = options.sessionDir;
		this.now = options.now ?? Date.now;
		this.leaseBase = leaseNamespace(options.leaseDeps);
	}

	get leaseNamespace(): string {
		return this.leaseBase;
	}

	#runDir(runId: RunId): string {
		if (!isRunId(runId)) throw new Error(`실행 id가 올바르지 않습니다: ${JSON.stringify(runId)}`);
		return path.join(this.sessionDir, "state", "integration", "runs", runId);
	}

	#journalFile(runId: RunId): string {
		return path.join(this.#runDir(runId), "journal.jsonl");
	}

	/** Reads and validates the whole run journal; any torn/foreign/corrupt record is unknown, never an empty list. */
	async #records(runId: RunId): Promise<IntegrationRead<readonly JournalRecord[]>> {
		const file = this.#journalFile(runId);
		let st;
		try {
			st = await fs.stat(file);
		} catch (error) {
			if (errorCodeOf(error) === "ENOENT") {
				this.runs.set(runId, { size: 0, records: [] });
				return { kind: "known", value: [] };
			}
			return { kind: "unknown", problem: problem("integration-journal", "통합 저널을 확인할 수 없습니다.") };
		}
		if (st.size > JOURNAL_MAX_BYTES) {
			return { kind: "unknown", problem: problem("integration-journal-capacity", "통합 저널이 실행별 한도를 넘었습니다.") };
		}
		const cached = this.runs.get(runId);
		if (cached !== undefined && cached.size === st.size) return { kind: "known", value: cached.records };
		let text: string;
		try {
			text = await fs.readFile(file, "utf8");
		} catch {
			return { kind: "unknown", problem: problem("integration-journal", "통합 저널을 읽을 수 없습니다.") };
		}
		if (text.length > 0 && !text.endsWith("\n")) {
			return { kind: "unknown", problem: problem("integration-journal-torn", "통합 저널의 마지막 기록이 완결되지 않았습니다.") };
		}
		const records: JournalRecord[] = [];
		let prev = "";
		for (const line of text.split("\n")) {
			if (line === "") continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				return { kind: "unknown", problem: problem("integration-journal-torn", "통합 저널 기록이 JSON이 아닙니다.") };
			}
			if (!isRecord(value)) return { kind: "unknown", problem: problem("integration-journal-foreign", "통합 저널 기록의 형식이 올바르지 않습니다.") };
			if (value.seq !== records.length + 1 || value.prev !== prev) {
				return { kind: "unknown", problem: problem("integration-journal-chain", "통합 저널의 순서가 끊겼습니다.") };
			}
			if (recordHash(value) !== value.hash) {
				return { kind: "unknown", problem: problem("integration-journal-hash", "통합 저널 기록의 무결성이 맞지 않습니다.") };
			}
			prev = value.hash;
			records.push(value);
		}
		this.runs.set(runId, { size: st.size, records });
		return { kind: "known", value: records };
	}

	/** The append head: the last complete, hash-valid record; a torn tail refuses every append. */
	async #head(runId: RunId): Promise<IntegrationRead<HeadCache>> {
		const file = this.#journalFile(runId);
		let size: number;
		try {
			size = (await fs.stat(file)).size;
		} catch (error) {
			if (errorCodeOf(error) !== "ENOENT") return { kind: "unknown", problem: problem("integration-journal", "통합 저널을 확인할 수 없습니다.") };
			return { kind: "known", value: { size: 0, seq: 0, prev: "", torn: undefined } };
		}
		if (size > JOURNAL_MAX_BYTES) {
			return { kind: "unknown", problem: problem("integration-journal-capacity", "통합 저널이 실행별 한도를 넘었습니다.") };
		}
		const cached = this.heads.get(runId);
		if (cached !== undefined && cached.size === size) return { kind: "known", value: cached };
		if (size === 0) {
			const head: HeadCache = { size: 0, seq: 0, prev: "", torn: undefined };
			this.heads.set(runId, head);
			return { kind: "known", value: head };
		}
		let handle: FileHandle;
		try {
			handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		} catch {
			return { kind: "unknown", problem: problem("integration-journal", "통합 저널을 열 수 없습니다.") };
		}
		const opened = handle;
		try {
			// Find the last complete line, growing the tail until it starts at a newline or the file start. A record is
			// capped by MAX_RECORD_BYTES, so this never reads an unbounded suffix.
			let windowSize = 64 * 1024;
			let text = "";
			for (;;) {
				const start = Math.max(0, size - windowSize);
				const length = size - start;
				const buffer = new Uint8Array(length);
				await opened.read(buffer, 0, length, start);
				text = new TextDecoder().decode(buffer);
				if (!text.endsWith("\n")) {
					const torn: HeadCache = { size, seq: 0, prev: "", torn: problem("integration-journal-torn", "통합 저널의 마지막 기록이 완결되지 않았습니다.") };
					this.heads.set(runId, torn);
					return { kind: "known", value: torn };
				}
				const body = text.slice(0, -1);
				if (start === 0 || body.includes("\n") || windowSize >= MAX_RECORD_BYTES) break;
				windowSize = Math.min(MAX_RECORD_BYTES, windowSize * 4);
			}
			const body = text.slice(0, -1);
			const breakAt = body.lastIndexOf("\n");
			const line = breakAt >= 0 ? body.slice(breakAt + 1) : body;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				const torn: HeadCache = { size, seq: 0, prev: "", torn: problem("integration-journal-torn", "통합 저널의 마지막 기록이 JSON이 아닙니다.") };
				this.heads.set(runId, torn);
				return { kind: "known", value: torn };
			}
			if (!isRecord(value) || recordHash(value) !== value.hash) {
				const torn: HeadCache = { size, seq: 0, prev: "", torn: problem("integration-journal-foreign", "통합 저널의 마지막 기록을 확인할 수 없습니다.") };
				this.heads.set(runId, torn);
				return { kind: "known", value: torn };
			}
			const head: HeadCache = { size, seq: value.seq, prev: value.hash, torn: undefined };
			this.heads.set(runId, head);
			return { kind: "known", value: head };
		} finally {
			await opened.close().catch(() => undefined);
		}
	}

	/** Bytes below the owner store, for the 2 GiB cap; never follows symlinks and is cached briefly. */
	async #storeBytes(): Promise<number> {
		const now = this.now();
		if (!this.storeDirty && this.storeCache !== undefined && now - this.storeCache.at < 5_000) return this.storeCache.bytes;
		const root = path.join(this.sessionDir, "state", "integration");
		const bytes = await directoryBytes(root);
		this.storeCache = { at: now, bytes };
		this.storeDirty = false;
		return bytes;
	}

	#markStoreDirty(): void {
		this.storeDirty = true;
	}

	async #append(runId: RunId, kind: JournalKind, build: (sequence: number) => unknown): Promise<IntegrationRead<JournalRecord>> {
		const file = this.#journalFile(runId);
		return serialized(file, async () => {
			const head = await this.#head(runId);
			if (head.kind === "unknown") return head;
			if (head.value.torn !== undefined) return { kind: "unknown", problem: head.value.torn };
			this.#markStoreDirty();
			const sequence = head.value.seq + 1;
			let payload: unknown;
			try {
				payload = build(sequence);
			} catch (error) {
				return { kind: "unknown", problem: problem("integration-journal-record", error instanceof Error ? error.message : String(error)) };
			}
			const line = (record: JournalRecord): string => `${JSON.stringify(record)}\n`;
			const base = {
				schema: JOURNAL_SCHEMA as typeof JOURNAL_SCHEMA,
				seq: sequence,
				prev: head.value.prev,
				at: this.now(),
				kind,
				payload,
			};
			const record: JournalRecord = { ...base, hash: recordHash(base) };
			const text = line(record);
			const bytes = Buffer.byteLength(text, "utf8");
			if (bytes > MAX_RECORD_BYTES) return { kind: "unknown", problem: problem("integration-journal-record", "통합 저널 기록이 너무 큽니다.") };
			if (head.value.size + bytes + CLOSURE_RESERVE > JOURNAL_MAX_BYTES) {
				return { kind: "unknown", problem: problem("integration-journal-capacity", "실행별 통합 저널 공간이 부족합니다. 남은 후보는 기록하지 않았습니다.") };
			}
			const store = await this.#storeBytes();
			if (store + bytes > STORE_MAX_BYTES) {
				return { kind: "unknown", problem: problem("integration-store-capacity", "이 프로필의 통합 저장 공간이 부족합니다.") };
			}
			try {
				await assertSessionPathSafe(this.sessionDir, file);
				await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
				const openedNew = head.value.size === 0;
				const handle = await fs.open(file, "a", 0o600);
				try {
					await handle.writeFile(text, "utf8");
					await handle.sync();
				} finally {
					await handle.close().catch(() => undefined);
				}
				if (openedNew) await syncDir(path.dirname(file));
			} catch (error) {
				return {
					kind: "unknown",
					problem: problem("integration-journal", `통합 저널 기록을 저장하지 못했습니다${errorCodeOf(error) === undefined ? "" : ` (${errorCodeOf(error)})`}.`),
				};
			}
			this.heads.set(runId, { size: head.value.size + Buffer.byteLength(text, "utf8"), seq: record.seq, prev: record.hash, torn: undefined });
			const cached = this.runs.get(runId);
			if (cached !== undefined) this.runs.set(runId, { size: cached.size + Buffer.byteLength(text, "utf8"), records: [...cached.records, record] });
			return { kind: "known", value: record };
		});
	}

	async appendManifest(manifest: SealedCaptureManifest): Promise<IntegrationRead<number>> {
		try {
			if (!isManifest(manifest)) return { kind: "unknown", problem: problem("integration-manifest", "캡처 manifest의 형식이 올바르지 않습니다.") };
			const key = manifest.admission.key;
			if (manifest.admission.candidateId !== integrationCandidateId(key)) {
				return { kind: "unknown", problem: problem("integration-manifest", "캡처 manifest의 후보 id가 키와 맞지 않습니다.") };
			}
			if (!isIntegrationObject(manifest.recovery) || !isIntegrationObject(manifest.recovery.nested)) {
				return { kind: "unknown", problem: problem("integration-manifest", "캡처 manifest의 복구 사실이 올바르지 않습니다.") };
			}
			const nested = manifest.recovery.nested;
			if (nested.kind === "known") {
				if (!Array.isArray(nested.value)) return { kind: "unknown", problem: problem("integration-manifest", "중첩 부품 목록이 올바르지 않습니다.") };
				if (nested.value.length + 1 > 8) {
					return { kind: "unknown", problem: problem("integration-manifest-parts", "캡처 부품이 한도(8개)를 넘습니다.") };
				}
			}
			const records = await this.#records(key.runId);
			if (records.kind === "unknown") return records;
			const existing = records.value.filter(record => {
				const found = record.kind === "manifest" ? manifestOf(record) : undefined;
				return found !== undefined && sameKey(found.admission.key, key);
			});
			for (const record of existing) {
				const found = manifestOf(record)!;
				if (found.admission.candidateId === manifest.admission.candidateId) {
					if (deepEqual(found, manifest)) return { kind: "known", value: record.seq };
					return { kind: "unknown", problem: problem("integration-seal-conflict", "같은 후보의 봉인이 다른 내용으로 이미 기록되어 있습니다.") };
				}
				return { kind: "unknown", problem: problem("integration-seal-conflict", "같은 배치에 다른 후보의 봉인이 이미 기록되어 있습니다.") };
			}
			const appended = await this.#append(key.runId, "manifest", () => ({ manifest }));
			return appended.kind === "unknown" ? appended : { kind: "known", value: appended.value.seq };
		} catch (error) {
			return { kind: "unknown", problem: problem("integration-manifest", error instanceof Error ? error.message : String(error)) };
		}
	}

	async appendRecovery(observation: LateRecoveryObservation): Promise<IntegrationRead<number>> {
		if (!isRecovery(observation) || !isRunId(observation.key.runId)) return { kind: "unknown", problem: problem("integration-recovery", "복구 관찰의 형식이 올바르지 않습니다.") };
		const records = await this.#records(observation.key.runId);
		if (records.kind === "unknown") return records;
		const manifest = records.value
			.filter(record => record.kind === "manifest")
			.map(manifestOf)
			.find(found => found !== undefined && found.admission.candidateId === observation.candidateId);
		if (manifest === undefined) return { kind: "unknown", problem: problem("integration-recovery", "봉인된 캡처 없이 복구 관찰을 기록할 수 없습니다.") };
		for (const record of records.value) {
			if (record.kind !== "recovery") continue;
			const found = recoveryOf(record);
			if (found === undefined || found.candidateId !== observation.candidateId || found.observationKey !== observation.observationKey) continue;
			if (deepEqual(found, observation)) return { kind: "known", value: record.seq };
			return { kind: "unknown", problem: problem("integration-recovery-conflict", "같은 복구 관찰 키가 다른 내용으로 이미 기록되어 있습니다.") };
		}
		const appended = await this.#append(observation.key.runId, "recovery", () => ({ observation }));
		return appended.kind === "unknown" ? appended : { kind: "known", value: appended.value.seq };
	}

	async beginSelection(selection: SelectionSnapshot): Promise<IntegrationCheck> {
		if (!isSelection(selection)) return { ok: false, problem: problem("integration-selection", "후보 선택 형식이 올바르지 않습니다.") };
		const records = await this.#records(selection.key.runId);
		if (records.kind === "unknown") return { ok: false, problem: records.problem };
		for (const record of records.value) {
			if (record.kind !== "selection") continue;
			const found = selectionOf(record);
			if (found === undefined || found.key.runId !== selection.key.runId || found.key.callId !== selection.key.callId) continue;
			return deepEqual(found, selection)
				? { ok: true }
				: { ok: false, problem: problem("integration-selection-conflict", "같은 호출의 선택이 다른 내용으로 이미 기록되어 있습니다.") };
		}
		const appended = await this.#append(selection.key.runId, "selection", () => ({ selection }));
		return appended.kind === "unknown" ? { ok: false, problem: appended.problem } : { ok: true };
	}

	async recordStep(selection: SelectionKey, step: WriteStepRecord): Promise<IntegrationCheck> {
		if (!isSelectionKey(selection) || !isStep(step)) return { ok: false, problem: problem("integration-step", "기록 단계가 올바르지 않습니다.") };
		const records = await this.#records(selection.runId);
		if (records.kind === "unknown") return { ok: false, problem: records.problem };
		const found = records.value.some(record => {
			if (record.kind !== "selection") return false;
			const chosen = selectionOf(record);
			return chosen !== undefined && chosen.key.runId === selection.runId && chosen.key.callId === selection.callId;
		});
		if (!found) return { ok: false, problem: problem("integration-step", "기록되지 않은 선택에는 단계를 붙일 수 없습니다.") };
		let last: WriteStepRecord | undefined;
		for (const record of records.value) {
			const entry = record.kind === "step" ? stepOf(record) : undefined;
			if (entry === undefined || entry.selection.runId !== selection.runId || entry.selection.callId !== selection.callId) continue;
			if (entry.step.candidateId === step.candidateId) last = entry.step;
		}
		if (last !== undefined && last.state === step.state && deepEqual(last.problem, step.problem)) return { ok: true };
		const appended = await this.#append(selection.runId, "step", () => ({ selection, step }));
		return appended.kind === "unknown" ? { ok: false, problem: appended.problem } : { ok: true };
	}

	async readCandidate(runId: RunId, candidateId: IntegrationCandidateId): Promise<IntegrationRead<StoredCandidate | null>> {
		if (!isRunId(runId) || !isCandidateId(candidateId)) return { kind: "unknown", problem: problem("integration-run", "실행 또는 후보 id가 올바르지 않습니다.") };
		const records = await this.#records(runId);
		if (records.kind === "unknown") return records;
		let manifest: SealedCaptureManifest | undefined;
		const recovery: LateRecoveryObservation[] = [];
		let lastWrite: CandidateWriteResult | null = null;
		let touched = false;
		for (const record of records.value) {
			if (record.kind === "manifest") {
				const found = manifestOf(record);
				if (found !== undefined && found.admission.candidateId === candidateId) {
					touched = true;
					if (manifest !== undefined) return { kind: "unknown", problem: problem("integration-manifest-duplicate", "같은 후보의 봉인이 둘 이상입니다.") };
					manifest = found;
				}
				continue;
			}
			if (record.kind === "recovery") {
				const found = recoveryOf(record);
				if (found !== undefined && found.candidateId === candidateId) {
					touched = true;
					recovery.push(found);
				}
				continue;
			}
			if (record.kind === "step") {
				const entry = stepOf(record);
				if (entry !== undefined && entry.step.candidateId === candidateId) {
					touched = true;
					lastWrite = stepToResult(entry.step);
				}
			}
		}
		if (!touched) return { kind: "known", value: null };
		if (manifest === undefined) return { kind: "unknown", problem: problem("integration-manifest", "봉인 없이 후보 기록만 있습니다.") };
		return { kind: "known", value: { manifest, recovery, lastWrite } };
	}

	async replay(runId: RunId, onCandidate: (entry: StoredCandidate) => void): Promise<IntegrationRead<{ readonly lastSequence: number } | null>> {
		if (!isRunId(runId)) return { kind: "unknown", problem: problem("integration-run", "실행 id가 올바르지 않습니다.") };
		const records = await this.#records(runId);
		if (records.kind === "unknown") return records;
		if (records.value.length === 0) return { kind: "known", value: null };
		const manifests: SealedCaptureManifest[] = [];
		const recovery = new Map<string, LateRecoveryObservation[]>();
		const steps = new Map<string, CandidateWriteResult | null>();
		for (const record of records.value) {
			if (record.kind === "manifest") {
				const found = manifestOf(record);
				if (found !== undefined) manifests.push(found);
			} else if (record.kind === "recovery") {
				const found = recoveryOf(record);
				if (found !== undefined) {
					const list = recovery.get(found.candidateId) ?? [];
					list.push(found);
					recovery.set(found.candidateId, list);
				}
			} else if (record.kind === "step") {
				const entry = stepOf(record);
				if (entry !== undefined) steps.set(entry.step.candidateId, stepToResult(entry.step));
			}
		}
		for (const manifest of manifests) {
			onCandidate({
				manifest,
				recovery: recovery.get(manifest.admission.candidateId) ?? [],
				lastWrite: steps.get(manifest.admission.candidateId) ?? null,
			});
		}
		return { kind: "known", value: { lastSequence: records.value[records.value.length - 1]!.seq } };
	}

	async findFence(target: { readonly canonicalRoot: string; readonly leaseKey?: string }): Promise<TargetFenceLookup> {
		const canonical = await canonicalWorktree(target.canonicalRoot);
		if (canonical === undefined) {
			const unknown: TargetFenceLookup = { kind: "unknown", problem: problem("integration-fence", "대상 루트의 정체성을 확인할 수 없습니다.") };
			this.fenceCache.set(target.canonicalRoot, unknown);
			return unknown;
		}
		if (target.leaseKey !== undefined && target.leaseKey !== canonical.key) {
			const unknown: TargetFenceLookup = { kind: "unknown", problem: problem("integration-fence-identity", "대상의 lease key가 실제 물리 identity와 다릅니다.") };
			this.fenceCache.set(canonical.root, unknown);
			return unknown;
		}
		let files: string[];
		try {
			files = await integrationFenceFiles(this.leaseBase, canonical.root, canonical.key);
		} catch {
			const unknown: TargetFenceLookup = { kind: "unknown", problem: problem("integration-fence", "통합 펜스 디렉터리를 읽을 수 없습니다.") };
			this.fenceCache.set(canonical.root, unknown);
			return unknown;
		}
		let found: TargetFenceRef | undefined;
		for (const file of files) {
			const read = await readFenceFile(file);
			if (read.kind === "unknown") {
				this.fenceCache.set(canonical.root, read);
				return read;
			}
			const fence = read.fence;
			if ((fence.root !== canonical.root && fence.leaseKey !== canonical.key) ||
				file !== integrationFenceFile(this.leaseBase, fence.root, fence.leaseKey, fence.effectToken)) {
				const unknown: TargetFenceLookup = { kind: "unknown", problem: problem("integration-fence", "펜스의 파일명과 대상이 일치하지 않습니다.") };
				this.fenceCache.set(canonical.root, unknown);
				return unknown;
			}
			found ??= fence;
		}
		if (found === undefined) {
			const clear: TargetFenceLookup = { kind: "clear" };
			this.fenceCache.set(canonical.root, clear);
			return clear;
		}
		const fenced: TargetFenceLookup = { kind: "fenced", fence: found };
		this.fenceCache.set(canonical.root, fenced);
		return fenced;
	}

	cachedFence(root: string): TargetFenceLookup {
		const cached = this.fenceCache.get(root);
		if (cached !== undefined) return cached;
		return { kind: "unknown", problem: problem("integration-fence", "이 실행에서 대상 펜스를 아직 확인하지 않았습니다.") };
	}

	async inspectFence(fence: TargetFenceRef, window: ByteWindow): Promise<IntegrationRead<FenceInspection>> {
		const early = window.signal.aborted ? problem("integration-fence", "중단되어 펜스를 확인하지 않았습니다.") : undefined;
		if (early !== undefined) return { kind: "unknown", problem: early };
		if (!(Date.now() < window.deadline)) return { kind: "unknown", problem: problem("integration-fence", "시간이 지나 펜스를 확인하지 않았습니다.") };
		const pointer = await this.fencePointer(fence);
		if (pointer.kind === "unknown") return pointer;
		const records = await readJournalFile(pointer.value.journalPath);
		if (records.kind === "unknown") return records;
		const intent = records.value.map(intentOf).find(found => found !== undefined && found.effectToken === fence.effectToken && found.sequence === fence.intentSequence);
		if (intent === undefined) return { kind: "unknown", problem: problem("integration-fence-intent", "펜스가 가리키는 의도를 저널에서 확인할 수 없습니다.") };
		const end = records.value.map(effectEndOf).find(found => found !== undefined && found.token === fence.effectToken);
		const receipt = records.value.map(receiptOf).find(found => found !== undefined && found.intent.effectToken === fence.effectToken) ?? null;
		const images = await observeIntentImages(intent);
		return {
			kind: "known",
			value: {
				fence,
				effectEnd: end === undefined ? { kind: "unknown", problem: problem("integration-fence-end", "효과 종료 증명이 없습니다.") } : { kind: "known", value: end },
				images,
				receipt: { kind: "known", value: receipt },
			},
		};
	}

	async resolveFence(input: FenceResolutionRequest, window: ByteWindow): Promise<FenceResolution> {
		const late = window.signal.aborted
			? problem("integration-fence", "중단되어 펜스를 정리하지 않았습니다.")
			: !(Date.now() < window.deadline)
				? problem("integration-fence", "시간이 지나 펜스를 정리하지 않았습니다.")
				: undefined;
		if (late !== undefined) return { kind: "kept", problem: late };
		let live: LiveCheck;
		try {
			live = input.checkOperator();
		} catch {
			live = { ok: false, reason: "운영자 확인을 받지 못했습니다." };
		}
		if (!live.ok) return { kind: "kept", problem: problem("integration-fence-operator", live.reason) };
		if (!isFence(input.fence)) return { kind: "kept", problem: problem("integration-fence", "펜스 형식이 올바르지 않습니다.") };
		const inspected = await this.inspectFence(input.fence, window);
		if (inspected.kind === "unknown") return { kind: "kept", problem: inspected.problem };
		const value = inspected.value;
		if (value.effectEnd.kind === "unknown" || value.images.kind === "unknown") {
			return { kind: "kept", problem: problem("integration-fence", "효과 종료나 대상 이미지를 확인할 수 없어 펜스를 유지합니다.") };
		}
		if (value.receipt.kind === "unknown") return { kind: "kept", problem: value.receipt.problem };
		const receipt = value.receipt.value;
		const images = value.images.value;
		let disposition: Extract<FenceResolution, { kind: "released" }>["disposition"] | undefined;
		if (receipt !== null && images === "all-post") disposition = "durable-receipt";
		else if (receipt === null && images === "all-post" && value.effectEnd.value.basis === "installer-exit-proved") disposition = "present-unattributed";
		else if (images === "all-pre") disposition = "proved-no-effect";
		if (disposition === undefined) {
			return { kind: "kept", problem: problem("integration-fence-mixed", "대상 이미지가 일관된 이전/이후 상태가 아니어서 펜스를 유지합니다.") };
		}
		const pointer = await this.fencePointer(input.fence);
		if (pointer.kind === "unknown") return { kind: "kept", problem: pointer.problem };
		const records = await readJournalFile(pointer.value.journalPath);
		if (records.kind === "unknown") return { kind: "kept", problem: records.problem };
		const clear = await appendJournalFile(pointer.value.journalPath, "fence-clear", {
			fence: input.fence,
			disposition,
			audit: input.audit,
		});
		if (!clear.ok) return { kind: "kept", problem: clear.problem };
		const cleared = await this.clearFence(input.fence);
		if (!cleared.ok) return { kind: "kept", problem: cleared.problem };
		this.fenceCache.set(input.fence.root, { kind: "clear" });
		return { kind: "released", disposition };
	}

	async appendIntent(input: { readonly runId: RunId; readonly build: (sequence: number) => WriteIntent }): Promise<IntegrationRead<WriteIntent>> {
		if (!isRunId(input.runId)) return { kind: "unknown", problem: problem("integration-run", "실행 id가 올바르지 않습니다.") };
		let intent: WriteIntent | undefined;
		const appended = await this.#append(input.runId, "intent", sequence => {
			const value = input.build(sequence);
			if (!isIntent(value)) throw new Error("쓰기 의도가 올바르지 않습니다.");
			if (value.candidate.key.runId !== input.runId) throw new Error("쓰기 의도의 실행이 저널과 다릅니다.");
			intent = value;
			return { intent: value };
		});
		if (appended.kind === "unknown") return appended;
		if (intent === undefined) return { kind: "unknown", problem: problem("integration-intent", "쓰기 의도를 만들지 못했습니다.") };
		return { kind: "known", value: intent };
	}

	async writeFence(intent: WriteIntent): Promise<IntegrationRead<TargetFenceRef>> {
		const fence: TargetFenceRef = {
			leaseKey: intent.target.leaseKey,
			root: intent.target.authorizedRoot.canonicalPath,
			runId: intent.candidate.key.runId,
			intentSequence: intent.sequence,
			effectToken: intent.effectToken,
		};
		const canonical = await canonicalWorktree(fence.root);
		if (canonical === undefined) return { kind: "unknown", problem: problem("integration-fence", "대상 루트의 정체성을 확인할 수 없습니다.") };
		if (canonical.key !== fence.leaseKey) return { kind: "unknown", problem: problem("integration-fence-identity", "대상 lease key가 물리 identity와 다릅니다.") };
		const file = integrationFenceFile(this.leaseBase, fence.root, fence.leaseKey, fence.effectToken);
		const dir = path.dirname(file);
		const record = {
			schema: FENCE_SCHEMA,
			fence,
			journalPath: this.#journalFile(fence.runId),
			writtenAt: this.now(),
		};
		try {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
			const handle = await fs.open(tmp, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close().catch(() => undefined);
			}
			await fs.rename(tmp, file);
			await syncDir(dir);
		} catch {
			return { kind: "unknown", problem: problem("integration-fence", "대상 펜스를 쓰지 못했습니다.") };
		}
		this.fenceCache.set(canonical.root, { kind: "fenced", fence });
		return { kind: "known", value: fence };
	}

	async appendEffectEnd(runId: RunId, end: ProvenEffectEnd): Promise<IntegrationCheck> {
		if (!isRunId(runId)) return { ok: false, problem: problem("integration-run", "실행 id가 올바르지 않습니다.") };
		if (!isEffectEnd(end)) return { ok: false, problem: problem("integration-effect-end", "효과 종료 형식이 올바르지 않습니다.") };
		const appended = await this.#append(runId, "effect-end", () => ({ end }));
		return appended.kind === "unknown" ? { ok: false, problem: appended.problem } : { ok: true };
	}

	async appendReceipt(runId: RunId, candidateId: IntegrationCandidateId, build: (sequence: number) => WriteReceipt): Promise<IntegrationRead<WriteReceipt>> {
		if (!isRunId(runId)) return { kind: "unknown", problem: problem("integration-run", "실행 id가 올바르지 않습니다.") };
		if (!isCandidateId(candidateId)) return { kind: "unknown", problem: problem("integration-receipt", "영수증 후보 id가 올바르지 않습니다.") };
		const records = await this.#records(runId);
		if (records.kind === "unknown") return records;
		for (const record of records.value) {
			const found = receiptOf(record);
			if (found !== undefined && found.ref.candidateId === candidateId) return { kind: "known", value: found };
		}
		let receipt: WriteReceipt | undefined;
		const appended = await this.#append(runId, "receipt", sequence => {
			const value = build(sequence);
			if (!isReceipt(value)) throw new Error("영수증 형식이 올바르지 않습니다.");
			if (value.ref.candidateId !== candidateId) throw new Error("영수증의 후보가 요청과 다릅니다.");
			receipt = value;
			return { receipt: value };
		});
		if (appended.kind === "unknown") return appended;
		if (receipt === undefined) return { kind: "unknown", problem: problem("integration-receipt", "영수증을 만들지 못했습니다.") };
		return { kind: "known", value: receipt };
	}

	async receiptFor(runId: RunId, candidateId: IntegrationCandidateId): Promise<IntegrationRead<WriteReceipt | null>> {
		if (!isRunId(runId) || !isCandidateId(candidateId)) return { kind: "unknown", problem: problem("integration-run", "실행 또는 후보 id가 올바르지 않습니다.") };
		const records = await this.#records(runId);
		if (records.kind === "unknown") return records;
		let found: WriteReceipt | null = null;
		for (const record of records.value) {
			const receipt = record.kind === "receipt" ? receiptOf(record) : undefined;
			if (receipt !== undefined && receipt.ref.candidateId === candidateId) found = receipt;
		}
		return { kind: "known", value: found };
	}

	async fencePointer(fence: TargetFenceRef): Promise<IntegrationRead<{ readonly file: string; readonly journalPath: string }>> {
		if (!isFence(fence)) return { kind: "unknown", problem: problem("integration-fence", "펜스 형식이 올바르지 않습니다.") };
		const canonical = await canonicalWorktree(fence.root);
		if (canonical === undefined || canonical.key !== fence.leaseKey) {
			return { kind: "unknown", problem: problem("integration-fence-identity", "펜스 대상의 정체성을 확인할 수 없습니다.") };
		}
		const file = integrationFenceFile(this.leaseBase, fence.root, fence.leaseKey, fence.effectToken);
		const read = await readFenceFile(file);
		if (read.kind === "unknown") return read;
		if (!sameFence(read.fence, fence)) return { kind: "unknown", problem: problem("integration-fence", "펜스의 소유자가 다릅니다.") };
		const journalPath = read.journalPath;
		if (!path.isAbsolute(journalPath) || path.basename(journalPath) !== "journal.jsonl") {
			return { kind: "unknown", problem: problem("integration-fence", "펜스의 저널 경로가 올바르지 않습니다.") };
		}
		return { kind: "known", value: { file, journalPath } };
	}

	async clearFence(fence: TargetFenceRef): Promise<IntegrationCheck> {
		const pointer = await this.fencePointer(fence);
		if (pointer.kind === "unknown") return { ok: false, problem: pointer.problem };
		const read = await readFenceFile(pointer.value.file);
		if (read.kind !== "fenced" || !sameFence(read.fence, fence)) {
			return { ok: false, problem: problem("integration-fence", "펜스 파일이 확인 중에 바뀌었습니다.") };
		}
		try {
			await fs.unlink(pointer.value.file);
			await syncDir(path.dirname(pointer.value.file));
		} catch (error) {
			if (errorCodeOf(error) !== "ENOENT") return { ok: false, problem: problem("integration-fence", "펜스 파일을 지우지 못했습니다.") };
		}
		this.fenceCache.set(fence.root, { kind: "clear" });
		return { ok: true };
	}
}

function stepToResult(step: WriteStepRecord): CandidateWriteResult | null {
	if (step.state === "not-ready" || step.state === "not-started") return null;
	if (step.problem === undefined) return null;
	switch (step.state) {
		case "conflict":
		case "refused":
			return { kind: step.state, problem: step.problem };
		case "no-effect":
			return { kind: "no-effect", end: { token: "", basis: "never-dispatched", observedAt: 0 }, problem: step.problem };
		case "present-unattributed":
			return { kind: "present-unattributed", observedAt: 0, problem: step.problem };
		case "recovery-required":
			return { kind: "recovery-required", fence: { kind: "unknown", problem: step.problem }, problem: step.problem };
		default:
			return null;
	}
}

async function directoryBytes(root: string): Promise<number> {
	let total = 0;
	let entries;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (errorCodeOf(error) === "ENOENT") return 0;
		throw error;
	}
	for (const entry of entries) {
		const child = path.join(root, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) total += await directoryBytes(child);
		else if (entry.isFile()) {
			try {
				total += (await fs.stat(child)).size;
			} catch {
				// an unreadable file still counts as unknown pressure; the append cap refuses on the next write
			}
		}
	}
	return total;
}

async function syncDir(dir: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(dir, fsConstants.O_RDONLY);
		await handle.sync();
	} catch {
		// Directory fsync is unavailable on some hosts; the file itself was synced before publication.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

interface FenceFileRead {
	readonly kind: "fenced";
	readonly fence: TargetFenceRef;
	readonly journalPath: string;
}

async function readFenceFile(file: string): Promise<FenceFileRead | { kind: "unknown"; problem: IntegrationProblem }> {
	let handle: FileHandle;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		if (errorCodeOf(error) === "ENOENT") return { kind: "unknown", problem: problem("integration-fence", "펜스 파일이 사라졌습니다.") };
		return { kind: "unknown", problem: problem("integration-fence", "펜스 파일을 열 수 없습니다.") };
	}
	const opened = handle;
	try {
		const st = await opened.stat({ bigint: true });
		if (!st.isFile() || st.size > BigInt(MAX_FENCE_BYTES)) {
			return { kind: "unknown", problem: problem("integration-fence", "펜스 파일이 올바르지 않습니다.") };
		}
		let value: unknown;
		try {
			value = JSON.parse(await opened.readFile({ encoding: "utf8" }));
		} catch {
			return { kind: "unknown", problem: problem("integration-fence", "펜스 파일이 JSON이 아닙니다.") };
		}
		if (!isIntegrationObject(value) || value.schema !== FENCE_SCHEMA || !isFence(value.fence) || typeof value.journalPath !== "string") {
			return { kind: "unknown", problem: problem("integration-fence", "펜스 파일 형식이 올바르지 않습니다.") };
		}
		return { kind: "fenced", fence: value.fence, journalPath: value.journalPath };
	} catch {
		return { kind: "unknown", problem: problem("integration-fence", "펜스 파일을 확인할 수 없습니다.") };
	} finally {
		await opened.close().catch(() => undefined);
	}
}

/** Validates a journal written by any managed session; no append and no repair. */
async function readJournalFile(file: string): Promise<IntegrationRead<readonly JournalRecord[]>> {
	let text: string;
	try {
		const st = await fs.stat(file);
		if (st.size > JOURNAL_MAX_BYTES) return { kind: "unknown", problem: problem("integration-journal-capacity", "통합 저널이 한도를 넘었습니다.") };
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (errorCodeOf(error) === "ENOENT") return { kind: "unknown", problem: problem("integration-fence", "의도 저널이 없습니다.") };
		return { kind: "unknown", problem: problem("integration-fence", "의도 저널을 읽을 수 없습니다.") };
	}
	if (text.length > 0 && !text.endsWith("\n")) return { kind: "unknown", problem: problem("integration-journal-torn", "통합 저널의 마지막 기록이 완결되지 않았습니다.") };
	const records: JournalRecord[] = [];
	let prev = "";
	for (const line of text.split("\n")) {
		if (line === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return { kind: "unknown", problem: problem("integration-journal-torn", "통합 저널 기록이 JSON이 아닙니다.") };
		}
		if (!isRecord(value) || value.seq !== records.length + 1 || value.prev !== prev || recordHash(value) !== value.hash) {
			return { kind: "unknown", problem: problem("integration-journal-chain", "통합 저널 기록을 확인할 수 없습니다.") };
		}
		prev = value.hash;
		records.push(value);
	}
	return { kind: "known", value: records };
}

/** Appends one operator resolution to the owner's journal without changing any earlier byte. */
async function appendJournalFile(file: string, kind: JournalKind, payload: unknown): Promise<IntegrationCheck> {
	return serialized(file, async () => {
		const records = await readJournalFile(file);
		if (records.kind === "unknown") return { ok: false, problem: records.problem };
		const last = records.value[records.value.length - 1];
		const base = {
			schema: JOURNAL_SCHEMA as typeof JOURNAL_SCHEMA,
			seq: (last?.seq ?? 0) + 1,
			prev: last?.hash ?? "",
			at: Date.now(),
			kind,
			payload,
		};
		const record: JournalRecord = { ...base, hash: recordHash(base) };
		try {
			const handle = await fs.open(file, "a", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close().catch(() => undefined);
			}
			return { ok: true };
		} catch {
			return { ok: false, problem: problem("integration-journal", "펜스 정리 기록을 저장하지 못했습니다.") };
		}
	});
}

/** The wire image form of a PathImage; a file image keeps its exact mode, size and digest. */
function imageState(image: PathImage): DeltaImage {
	return image.kind === "absent" ? { state: { kind: "absent" } } : { state: image, oid: "" };
}

async function observeIntentImages(intent: WriteIntent): Promise<IntegrationRead<"all-pre" | "all-post" | "mixed">> {
	const footprint: Footprint = {
		paths: intent.paths.map(entry => ({
			gitPath: entry.path,
			targetPath: entry.path,
			before: imageState(entry.before),
			after: imageState(entry.after),
			head: null,
			index: null,
		})),
		head: { ref: intent.head.ref, oid: intent.head.oid },
		index: { path: intent.index.path, file: intent.index.file, sha256: intent.index.sha256 },
	};
	const target: IntegrationTarget = {
		leaseKey: intent.target.leaseKey,
		authorizedRoot: intent.target.authorizedRoot,
		gitRoot: intent.target.gitRoot,
		gitDir: intent.target.gitDir,
		sourceOdb: intent.target.sourceOdb,
		targetPrefix: intent.target.targetPrefix,
	};
	if (footprint.paths.length === 0) return { kind: "unknown", problem: problem("integration-fence", "의도에 대상 경로가 없습니다.") };
	return observePostimages(footprint, target);
}

/** The live lease token and the table entry are both required at the effect boundary; neither is inferred. */
function leaseStillHeld(lease: RunLease, snapshot: LeaseSnapshot, root: string): IntegrationCheck {
	try {
		lease.assertCurrent(snapshot);
	} catch (error) {
		return { ok: false, problem: problem("integration-lease", error instanceof Error ? error.message : String(error)) };
	}
	if (lease.mode !== "write" || lease.paths !== undefined) {
		return { ok: false, problem: problem("integration-lease", "통합 적용에는 대상 전체의 쓰기 lease가 필요합니다.") };
	}
	if (lease.root !== root) return { ok: false, problem: problem("integration-lease", "lease 루트가 승인 대상과 다릅니다.") };
	return { ok: true };
}

interface HeldSegment {
	readonly key: string;
	readonly lease: RunLease;
	readonly snapshot: LeaseSnapshot;
	readonly target: IntegrationTarget;
	readonly selection: SelectionSnapshot;
	readonly live: IntegrationLiveGrant;
	readonly window: ByteWindow;
	readonly leaseRoot: string;
	closed: boolean;
	readonly attempted: Set<string>;
}

export interface IntegrationWriterOptions {
	readonly journal: IntegrationJournalStore;
	readonly bytes: IntegrationBytePort;
	readonly delta: IntegrationDeltaPort;
	readonly installer?: Installer;
	readonly run?: GitRun;
	readonly now?: () => number;
	readonly maxExpandedBytes?: number;
}

/** B's exclusive parent writer. C alone calls it from an explicit selected action under the live ask. */
export class IntegrationWriter implements IntegrationWriterPort {
	private readonly journal: IntegrationJournalStore;
	private readonly bytes: IntegrationBytePort;
	private readonly delta: IntegrationDeltaPort;
	private readonly installer: Installer;
	private readonly run: GitRun;
	private readonly now: () => number;
	private readonly maxExpandedBytes: number;
	private readonly segments = new Map<string, HeldSegment>();

	constructor(options: IntegrationWriterOptions) {
		this.journal = options.journal;
		this.bytes = options.bytes;
		this.delta = options.delta;
		this.installer = options.installer ?? new GitInstaller(options.run ?? spawnGit);
		this.run = options.run ?? spawnGit;
		this.now = options.now ?? Date.now;
		this.maxExpandedBytes = options.maxExpandedBytes ?? 64 * 1024 * 1024;
	}

	async reserveSegment(request: WriterSegmentRequest): Promise<IntegrationRead<SegmentHolder>> {
		const windowProblem = this.#window(request.window);
		if (windowProblem !== undefined) return { kind: "unknown", problem: windowProblem };
		const selection = request.selection;
		if (!isSelection(selection)) return { kind: "unknown", problem: problem("integration-selection", "후보 선택이 올바르지 않습니다.") };
		if (selection.key.runId !== request.lease.runId) return { kind: "unknown", problem: problem("integration-selection", "선택과 lease의 실행이 다릅니다.") };
		if (request.lease.mode !== "write" || request.lease.paths !== undefined) {
			return { kind: "unknown", problem: problem("integration-lease", "통합 적용 전에 대상 전체 쓰기 lease로 올려야 합니다.") };
		}
		if (!(await sameSessionStore(request.lease.sessionDir, this.journal.sessionDir))) {
			return { kind: "unknown", problem: problem("integration-lease", "저널과 lease의 소유 저장소가 다릅니다.") };
		}
		const canonical = await canonicalWorktree(request.lease.root);
		const target = request.target;
		if (canonical === undefined || canonical.root !== target.authorizedRoot.canonicalPath ||
			canonical.device !== target.authorizedRoot.device || canonical.inode !== target.authorizedRoot.inode) {
			return { kind: "unknown", problem: problem("integration-target", "승인 대상과 lease 루트의 물리 identity가 다릅니다.") };
		}
		const live = this.#live(request.live);
		if (!live.ok) return { kind: "unknown", problem: problem("integration-live", live.reason) };
		if (request.live.signal.aborted || request.window.signal.aborted) {
			return { kind: "unknown", problem: problem("integration-aborted", "통합 작업이 중단되었습니다.") };
		}
		if (!(this.now() < request.live.audit.deadline)) return { kind: "unknown", problem: problem("integration-deadline", "통합 적용 시간이 지났습니다.") };
		const selectionCheck = await this.journal.beginSelection(selection);
		if (!selectionCheck.ok) return { kind: "unknown", problem: selectionCheck.problem };
		const fence = await this.journal.findFence({ canonicalRoot: target.authorizedRoot.canonicalPath, leaseKey: target.leaseKey });
		if (fence.kind !== "clear") {
			return {
				kind: "unknown",
				problem: fence.kind === "fenced"
					? problem("integration-fence", `대상에 남은 통합 펜스가 있습니다: ${fenceReason(fence.fence)}`)
					: fence.problem,
			};
		}
		const lanes = runLanes(request.lease.runId);
		if (lanes === undefined) return { kind: "unknown", problem: problem("integration-table", "이 실행의 쓰기 표를 찾지 못했습니다.") };
		if (!lanes.bindIntegration({
			root: target.authorizedRoot.canonicalPath,
			fence: () => {
				const found = this.journal.cachedFence(target.authorizedRoot.canonicalPath);
				if (found.kind === "clear") return { kind: "clear" };
				return found.kind === "fenced"
					? { kind: "fenced", reason: fenceReason(found.fence) }
					: { kind: "unknown", reason: found.problem.reason };
			},
		})) {
			return { kind: "unknown", problem: problem("integration-table", "쓰기 표의 대상이 다릅니다.") };
		}
		const key = `segment-${randomUUID()}`;
		const committed = lanes.commitIntegration({
			key,
			live: () => this.#live(request.live),
			now: this.now(),
			deadline: request.live.audit.deadline,
		});
		if (!committed.ok) return { kind: "unknown", problem: problem("integration-table", committed.reason) };
		const holderKey = key;
		this.segments.set(holderKey, {
			key: holderKey,
			lease: request.lease,
			snapshot: request.lease.snapshot(),
			target,
			selection,
			live: request.live,
			window: request.window,
			leaseRoot: request.lease.root,
			closed: false,
			attempted: new Set(),
		});
		// The brand is a compiler-only distinction; this object is constructed here and never parsed from storage.
		const holder = { key: holderKey } as SegmentHolder;
		return { kind: "known", value: holder };
	}

	#window(window: ByteWindow): IntegrationProblem | undefined {
		if (window.signal.aborted) return problem("integration-aborted", "통합 작업이 중단되었습니다.");
		if (!(this.now() < window.deadline)) return problem("integration-deadline", "통합 작업 시간이 지났습니다.");
		if (!Number.isSafeInteger(window.maxBytes) || window.maxBytes <= 0) return problem("integration-window", "통합 바이트 한도를 확인할 수 없습니다.");
		return undefined;
	}

	#live(grant: IntegrationLiveGrant): LiveCheck {
		try {
			return grant.check();
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async applyCandidate(input: {
		readonly holder: SegmentHolder;
		readonly candidate: CandidateRevision;
		readonly proof: ExactDeltaProof;
		readonly window: ByteWindow;
	}): Promise<CandidateWriteResult> {
		const segment = this.segments.get(input.holder.key);
		if (segment === undefined || segment.closed) return { kind: "refused", problem: problem("integration-holder", "통합 적용 자리가 유효하지 않습니다.") };
		if (!segment.selection.ordered.includes(input.candidate.candidateId)) {
			return { kind: "refused", problem: problem("integration-selection", "선택되지 않은 후보는 적용할 수 없습니다.") };
		}
		const windowProblem = this.#window(input.window);
		if (windowProblem !== undefined) return { kind: "refused", problem: windowProblem };
		const live = this.#live(segment.live);
		if (!live.ok) return { kind: "refused", problem: problem("integration-live", live.reason) };
		const budget = new ByteBudget(input.window, this.now, this.maxExpandedBytes);
		if (input.proof.expandedBytes < 0 || input.proof.expandedBytes > Math.min(input.window.maxBytes, 64 * 1024 * 1024)) {
			return { kind: "refused", problem: problem("integration-delta", "델타 증명의 검증 바이트가 한도를 넘습니다.") };
		}
		const stored = await this.journal.readCandidate(input.candidate.key.runId, input.candidate.candidateId);
		if (stored.kind === "unknown") return { kind: "refused", problem: stored.problem };
		if (stored.value === null) return { kind: "refused", problem: problem("integration-manifest", "후보의 봉인된 캡처가 없습니다.") };
		const manifest = stored.value.manifest;
		if (manifest.digest !== input.candidate.manifestDigest) {
			return { kind: "refused", problem: problem("integration-manifest", "후보 개정의 봉인 다이제스트가 저장된 값과 다릅니다.") };
		}
		if (!sameKey(manifest.admission.key, input.candidate.key) || manifest.admission.candidateId !== input.candidate.candidateId) {
			return { kind: "refused", problem: problem("integration-manifest", "후보 개정의 키가 봉인과 다릅니다.") };
		}
		const targetCheck = sameTarget(manifest.admission.target, segment.target);
		if (!targetCheck.ok) return { kind: "refused", problem: targetCheck.problem };
		if (!sameKey(input.proof.key, input.candidate.key) || input.proof.candidateId !== input.candidate.candidateId) {
			return { kind: "refused", problem: problem("integration-delta", "델타 증명의 후보가 개정과 다릅니다.") };
		}
		const proofTarget = sameTarget(input.proof.target, segment.target);
		if (!proofTarget.ok) return { kind: "refused", problem: proofTarget.problem };
		if (manifest.bundle.kind !== "root-only") {
			return { kind: "refused", problem: problem("integration-bundle", "루트 전용 캡처가 아니면 적용할 수 없습니다.") };
		}
		if (manifest.bundle.root.sha256 !== input.proof.root.sha256 || manifest.bundle.root.bytes !== input.proof.root.bytes) {
			return { kind: "refused", problem: problem("integration-manifest", "봉인된 루트 패치와 증명된 패치가 다릅니다.") };
		}
		const computed = deltaDigest({ request: proofRequestOf(input.proof), entries: input.proof.entries });
		if (computed !== input.proof.digest) return { kind: "refused", problem: problem("integration-delta", "델타 증명의 다이제스트가 맞지 않습니다.") };
		const sealedDelta = manifest.delta.kind === "known" ? manifest.delta.value : undefined;
		if (sealedDelta === undefined || sealedDelta.digest !== input.proof.digest || !deepEqual(sealedDelta.entries, input.proof.entries)) {
			return { kind: "refused", problem: problem("integration-manifest", "봉인된 델타와 제출된 증명이 다릅니다.") };
		}
		let patch: Uint8Array;
		try {
			const read = await this.bytes.readPatch(input.proof.root, input.window);
			if (read.kind === "unknown") return { kind: "refused", problem: read.problem };
			patch = read.value;
		} catch (error) {
			return { kind: "refused", problem: problem("integration-patch", error instanceof Error ? error.message : String(error)) };
		}
		if (patch.byteLength !== input.proof.root.bytes || createHash("sha256").update(patch).digest("hex") !== input.proof.root.sha256) {
			return { kind: "refused", problem: problem("integration-patch", "패치 바이트가 봉인된 값과 다릅니다.") };
		}
		const refreshed = await this.#refresh(segment, input.candidate, input.window);
		if (refreshed !== undefined) return { kind: "refused", problem: refreshed };
		const already = await this.journal.receiptFor(input.candidate.key.runId, input.candidate.candidateId);
		if (already.kind === "unknown") return { kind: "refused", problem: already.problem };
		if (already.value !== null) {
			if (already.value.ref.key.runId !== input.candidate.key.runId || already.value.ref.manifestDigest !== input.candidate.manifestDigest) {
				return { kind: "refused", problem: problem("integration-receipt-stale", "영수증이 현재 봉인이나 실행과 다릅니다.") };
			}
			const presence = await this.delta.observePresence(
				segment.target,
				input.proof.entries.map(entry => ({ path: entry.targetPath, image: imageOf(entry.after) })),
				input.window,
			);
			return { kind: "already-written", receipt: already.value, presence };
		}
		const fence = await this.journal.findFence({ canonicalRoot: segment.target.authorizedRoot.canonicalPath, leaseKey: segment.target.leaseKey });
		if (fence.kind !== "clear") {
			return {
				kind: "recovery-required",
				fence: fence.kind === "fenced" ? { kind: "known", value: fence.fence } : { kind: "unknown", problem: fence.problem },
				problem: fence.kind === "fenced" ? problem("integration-fence", `대상에 남은 통합 펜스가 있습니다: ${fenceReason(fence.fence)}`) : fence.problem,
			};
		}
		const footprint = await readFootprint(input.proof, segment.target, this.run, budget);
		if (footprint.kind === "unknown") return { kind: "refused", problem: footprint.problem };
		// A matching postimage is not a write, and the live file is never read to invent a preimage: report it before
		// the preimage check would reject the same bytes as drift.
		const postObservation = await observePostimages(footprint.value, segment.target);
		if (postObservation.kind === "unknown") return { kind: "refused", problem: postObservation.problem };
		if (postObservation.value === "all-post") {
			return { kind: "present-unattributed", observedAt: this.now(), problem: problem("integration-present", "선택 전에 대상이 이미 이후 상태와 같습니다. 영수증 없이 적용으로 기록하지 않습니다.") };
		}
		const pre = await verifyFootprint(footprint.value, segment.target, this.run, budget, "pre");
		if (!pre.ok) return { kind: "conflict", problem: pre.problem };
		const preliminary = this.#live(segment.live);
		if (!preliminary.ok) return { kind: "refused", problem: problem("integration-live", preliminary.reason) };
		const publication = segment.live.checkCandidate(input.candidate);
		if (!publication.ok) return { kind: "refused", problem: problem("integration-publish", publication.reason) };
		const effectToken = randomUUID();
		const intentBuild = (sequence: number): WriteIntent => ({
			schema: "storm.integration-intent/v1",
			sequence,
			candidate: input.candidate,
			deltaDigest: input.proof.digest,
			target: segment.target,
			index: { path: footprint.value.index.path, file: footprint.value.index.file, sha256: footprint.value.index.sha256 },
			head: footprint.value.head,
			paths: footprint.value.paths.map(entry => ({
				path: entry.targetPath,
				before: imageOf(entry.before),
				after: imageOf(entry.after),
			})),
			audit: segment.live.audit,
			owner: segment.lease.owner,
			holderKey: segment.key,
			effectToken,
		});
		const intentRead = await this.journal.appendIntent({ runId: input.candidate.key.runId, build: intentBuild });
		if (intentRead.kind === "unknown") return { kind: "refused", problem: intentRead.problem };
		const intent = intentRead.value;
		const finalLease = leaseStillHeld(segment.lease, segment.snapshot, segment.leaseRoot);
		if (!finalLease.ok) return { kind: "refused", problem: finalLease.problem };
		const finalLive = this.#live(segment.live);
		if (!finalLive.ok) return { kind: "refused", problem: problem("integration-live", finalLive.reason) };
		const finalPublication = segment.live.checkCandidate(input.candidate);
		if (!finalPublication.ok) return { kind: "refused", problem: problem("integration-publish", finalPublication.reason) };
		const lanes = runLanes(input.candidate.key.runId);
		if (lanes === undefined || !lanes.integrationHeld(segment.key)) {
			return { kind: "refused", problem: problem("integration-table", "통합 적용 자리가 더 이상 이 실행의 것이 아닙니다.") };
		}
		const finalPre = await verifyFootprint(footprint.value, segment.target, this.run, budget, "pre");
		if (!finalPre.ok) return { kind: "conflict", problem: finalPre.problem };
		const fenceRead = await this.journal.writeFence(intent);
		if (fenceRead.kind === "unknown") return { kind: "refused", problem: fenceRead.problem };
		// Every await after the intent and fence gets the same recheck; the fence now exists, so the table entry and the
		// exact preimages carry the proof that this segment is still the writer.
		const afterFenceLease = leaseStillHeld(segment.lease, segment.snapshot, segment.leaseRoot);
		if (!afterFenceLease.ok) return { kind: "recovery-required", fence: fenceRead, problem: afterFenceLease.problem };
		const afterFenceLive = this.#live(segment.live);
		if (!afterFenceLive.ok) return { kind: "recovery-required", fence: fenceRead, problem: problem("integration-live", afterFenceLive.reason) };
		const afterFencePublication = segment.live.checkCandidate(input.candidate);
		if (!afterFencePublication.ok) return { kind: "recovery-required", fence: fenceRead, problem: problem("integration-publish", afterFencePublication.reason) };
		const afterFenceLanes = runLanes(input.candidate.key.runId);
		if (afterFenceLanes === undefined || !afterFenceLanes.integrationHeld(segment.key)) {
			return { kind: "recovery-required", fence: fenceRead, problem: problem("integration-table", "통합 적용 자리가 더 이상 이 실행의 것이 아닙니다.") };
		}
		const afterFencePre = await verifyFootprint(footprint.value, segment.target, this.run, budget, "pre");
		if (!afterFencePre.ok) return { kind: "recovery-required", fence: fenceRead, problem: afterFencePre.problem };
		if (!(this.now() < segment.live.audit.deadline)) {
			return { kind: "recovery-required", fence: fenceRead, problem: problem("integration-deadline", "효과 직전에 허용 시간이 끝났습니다.") };
		}
		segment.attempted.add(input.candidate.candidateId);
		const outcome: InstallOutcome = await this.installer.install({ target: segment.target, patch, window: input.window });
		const observedAt = this.now();
		if (outcome.kind === "never-dispatched") {
			await this.journal.appendEffectEnd(input.candidate.key.runId, { token: intent.effectToken, basis: "never-dispatched", observedAt });
			await this.journal.clearFence(fenceRead.value);
			await this.journal.recordStep(segment.selection.key, { candidateId: input.candidate.candidateId, state: "no-effect", problem: problem("integration-installer", outcome.reason) });
			return { kind: "no-effect", end: { token: intent.effectToken, basis: "never-dispatched", observedAt }, problem: problem("integration-installer", outcome.reason) };
		}
		const end: ProvenEffectEnd = { token: intent.effectToken, basis: "installer-exit-proved", observedAt };
		const endRecorded = await this.journal.appendEffectEnd(input.candidate.key.runId, end);
		const post = await verifyFootprint(footprint.value, segment.target, this.run, budget, "post");
		const images = await observePostimages(footprint.value, segment.target);
		if (!endRecorded.ok) return { kind: "recovery-required", fence: fenceRead, problem: endRecorded.problem };
		if (images.kind === "unknown") return { kind: "recovery-required", fence: fenceRead, problem: images.problem };
		if (images.value === "all-pre") {
			await this.journal.clearFence(fenceRead.value);
			const noEffect = problem("integration-no-effect", `설치 프로그램이 종료됐지만 대상 바이트는 이전 상태 그대로입니다(종료 ${outcome.code}).`);
			await this.journal.recordStep(segment.selection.key, { candidateId: input.candidate.candidateId, state: "no-effect", problem: noEffect });
			return { kind: "no-effect", end, problem: noEffect };
		}
		if (images.value !== "all-post" || !post.ok || outcome.code !== 0) {
			return {
				kind: "recovery-required",
				fence: fenceRead,
				problem: post.ok
					? problem("integration-readback", outcome.code === 0 ? "대상 이미지가 일관된 이후 상태가 아닙니다." : `설치 프로그램이 0이 아닌 코드로 끝났습니다(${outcome.code}).`)
					: post.problem,
			};
		}
		const receiptRead = await this.journal.appendReceipt(input.candidate.key.runId, input.candidate.candidateId, sequence => ({
			schema: "storm.integration-receipt/v1",
			ref: {
				key: input.candidate.key,
				candidateId: input.candidate.candidateId,
				manifestDigest: manifest.digest,
				intentSequence: intent.sequence,
				receiptSequence: sequence,
			},
			intent,
			end: { token: intent.effectToken, basis: "installer-exit-proved", observedAt },
			readBackAt: this.now(),
		}));
		if (receiptRead.kind === "unknown") {
			return { kind: "recovery-required", fence: fenceRead, problem: receiptRead.problem };
		}
		await this.journal.clearFence(fenceRead.value);
		await this.journal.recordStep(segment.selection.key, { candidateId: input.candidate.candidateId, state: "written" });
		return { kind: "written", receipt: receiptRead.value };
	}

	async #refresh(segment: HeldSegment, candidate: CandidateRevision, window: ByteWindow): Promise<IntegrationProblem | undefined> {
		if (window.signal.aborted || segment.live.signal.aborted) return problem("integration-aborted", "통합 작업이 중단되었습니다.");
		try {
			const result = await segment.live.revalidateCandidate(candidate, window);
			if (!result.ok) return problem("integration-input", result.reason);
		} catch (error) {
			return problem("integration-input", error instanceof Error ? error.message : String(error));
		}
		const live = this.#live(segment.live);
		if (!live.ok) return problem("integration-live", live.reason);
		const lease = leaseStillHeld(segment.lease, segment.snapshot, segment.leaseRoot);
		if (!lease.ok) return problem("integration-lease", lease.problem.reason);
		if (!(this.now() < segment.live.audit.deadline)) return problem("integration-deadline", "통합 적용 시간이 지났습니다.");
		return undefined;
	}

	async finishSegment(holder: SegmentHolder): Promise<IntegrationCheck> {
		const segment = this.segments.get(holder.key);
		if (segment === undefined) return { ok: true };
		segment.closed = true;
		this.segments.delete(holder.key);
		runLanes(segment.selection.key.runId)?.releaseIntegration(segment.key);
		return { ok: true };
	}
}

function imageOf(image: { readonly state: { readonly kind: "absent" } | { readonly kind: "file"; readonly mode: string; readonly bytes: number; readonly sha256: string } }): { readonly kind: "absent" } | { readonly kind: "file"; readonly mode: "100644" | "100755"; readonly bytes: number; readonly sha256: string } {
	return image.state.kind === "absent"
		? { kind: "absent" }
		: { kind: "file", mode: image.state.mode === "100755" ? "100755" : "100644", bytes: image.state.bytes, sha256: image.state.sha256 };
}

function sameTarget(a: IntegrationTarget, b: IntegrationTarget): IntegrationCheck {
	if (a.leaseKey !== b.leaseKey) return { ok: false, problem: problem("integration-target", "대상 lease key가 다릅니다.") };
	for (const [left, right, label] of [
		[a.authorizedRoot, b.authorizedRoot, "승인 대상"],
		[a.gitRoot, b.gitRoot, "Git 루트"],
		[a.gitDir, b.gitDir, "Git 디렉터리"],
		[a.sourceOdb.commonDir, b.sourceOdb.commonDir, "Git common"],
		[a.sourceOdb.objects, b.sourceOdb.objects, "Git 객체"],
	] as const) {
		if (left.canonicalPath !== right.canonicalPath || left.device !== right.device || left.inode !== right.inode) {
			return { ok: false, problem: problem("integration-target", `${label}의 identity가 다릅니다.`) };
		}
	}
	if (a.targetPrefix !== b.targetPrefix) return { ok: false, problem: problem("integration-target", "승인 대상 접두사가 다릅니다.") };
	if (a.sourceOdb.objectFormat !== b.sourceOdb.objectFormat) return { ok: false, problem: problem("integration-target", "객체 형식이 다릅니다.") };
	return { ok: true };
}

function proofRequestOf(proof: ExactDeltaProof) {
	return {
		key: proof.key,
		candidateId: proof.candidateId,
		target: proof.target,
		scope: proof.scope,
		sourceOdb: proof.sourceOdb,
		root: proof.root,
	};
}
