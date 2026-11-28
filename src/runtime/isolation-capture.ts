/**
 * Slice A's native capture join: one candidate per exact admitted placement, built from independent terminal and
 * artifact evidence.
 *
 * The sync `task` result is the only route with a typed part list. Async wait/push rows are terminal identity only; the
 * registry snapshot carries the patch paths and must be a fresh, identity-bearing metadata publication for a successful
 * first execution. A wait replay, an empty wait, a push followed by a wait, a batch acknowledgement job id or a mutable
 * `ref` never mint or bind a candidate. Every part is copied once by `IntegrationArtifactStore`; the seal is emitted only
 * after that copy (and, for a root-only success, B's read-only `proveRoot` when available).
 *
 * After the bounded missing-evidence disposition a manifest is immutable. Later bound evidence becomes a separate
 * `LateRecoveryObservation`; a contradiction is recorded there and readiness is C's decision, never a seal rewrite.
 */
import { createHash } from "node:crypto";
import type { AttemptSettlement } from "./attempt-bridge.ts";
import type { AttemptOutcome, SyncResultFact } from "./attempt-report.ts";
import type {
	AdmissionKey,
	ChildEntryClaim,
	DirectorIdentity,
	FrozenIntegrationAdmission,
	IntegrationCandidateId,
	IntegrationCheck,
	IntegrationProblem,
	IntegrationRead,
	ObservationIdentity,
} from "./integration-admission.ts";
import type {
	AsyncObservationInput,
	IntegrationCapturePort,
	BoundTerminal,
	CaptureJournalPort,
	CaptureUpdate,
	CheckoutObservation,
	EmittedBundle,
	LateRecoveryObservation,
	NativeJobExecution,
	NestedPartRef,
	PartRef,
	RecoveryBranch,
	RecoveryFacts,
	RegistrySnapshotInput,
	SealedCaptureManifest,
} from "./integration-capture.ts";
import type { ByteWindow, ExactDeltaProof, IntegrationDeltaPort, StoredPatchRef } from "./integration-delta.ts";
import {
	canonicalJson,
	integrationCandidateId,
	isAdmissionKey,
	isIntegrationCandidateId,
	validateFrozenAdmission,
	type CopyPatchInput,
} from "./integration-artifacts.ts";

/** Default bounded wait for an independent capture input after terminal/positive evidence. */
export const CAPTURE_MISSING_EVIDENCE_MS = 15_000;
/** A native patch is never copied or proven whole past this size; nested parts count against the same ceiling. */
export const CAPTURE_MAX_PATCH_BYTES = 64 * 1024 * 1024;
/** At most eight typed parts are sealed in one manifest. */
export const CAPTURE_MAX_PARTS = 8;
const MAX_TRACKED = 512;
const MAX_LATE_RECOVERIES = 64;
const MAX_DIAGNOSTICS = 64;
/** The host mints an opaque UUID per job registration; a label, timestamp or path is never this token. */
const EXECUTION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** One additive host execution proof; any missing/ill-typed field makes the whole row stock, never partly authoritative. */
function executionProof(value: unknown): NativeExecutionProof | undefined {
	if (!record(value) || value.revision !== 1 || value.type !== "task") return undefined;
	if (typeof value.jobId !== "string" || value.jobId === "" || value.jobId.length > 512) return undefined;
	if (typeof value.executionToken !== "string" || !EXECUTION_TOKEN.test(value.executionToken)) return undefined;
	if (typeof value.itemIndex !== "number" || !Number.isSafeInteger(value.itemIndex) || value.itemIndex < 0) return undefined;
	if (typeof value.agentId !== "string" || value.agentId === "" || value.agentId.length > 512) return undefined;
	if (typeof value.ownerSessionId !== "string" || value.ownerSessionId === "" || value.ownerSessionId.length > 512) return undefined;
	return {
		jobId: value.jobId,
		executionToken: value.executionToken,
		itemIndex: value.itemIndex,
		agentId: value.agentId,
		ownerSessionId: value.ownerSessionId,
	};
}

const problem = (code: string, reason: string, path?: string): IntegrationProblem => ({
	code,
	reason,
	...(path === undefined ? {} : { path }),
});

const unknown = <T>(code: string, reason: string, path?: string): IntegrationRead<T> => ({
	kind: "unknown",
	problem: problem(code, reason, path),
});

const known = <T>(value: T): IntegrationRead<T> => ({ kind: "known", value });

function absolutePath(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.startsWith("/") && !value.includes("\u0000")
		? value
		: undefined;
}

function sameDirector(a: DirectorIdentity, b: DirectorIdentity): boolean {
	return (
		a.sessionId === b.sessionId &&
		a.sessionInstance === b.sessionInstance &&
		a.sessionDir === b.sessionDir &&
		a.parentId === b.parentId
	);
}

/** The capture-side registry surface; structurally the host AgentRegistry mirror, kept free of host imports. */
export interface CaptureRegistryRef {
	readonly id: string;
	readonly parentId?: string | undefined;
	readonly parentSessionKey?: string | null | undefined;
	readonly generation?: number | null | undefined;
	readonly sessionFile?: string | null | undefined;
	readonly session?: { readonly instanceKey?: string | undefined } | null | undefined;
	readonly history?: {
		readonly outputPath?: string | undefined;
		readonly patchPath?: string | undefined;
		readonly nestedPatchPaths?: readonly string[] | undefined;
		readonly branchName?: string | undefined;
	} | undefined;
}

export interface CaptureRegistryEvent {
	readonly type: "registered" | "status_changed" | "metadata_changed" | "removed";
	readonly ref: CaptureRegistryRef;
}

export interface CaptureRegistry {
	get(id: string): CaptureRegistryRef | undefined;
	onChange(listener: (event: CaptureRegistryEvent) => void): () => void;
}

/** The one owned-byte operation capture needs; the real store also serves B through `readPatch`. */
export interface CaptureCopyPort {
	copyPatch(input: CopyPatchInput): Promise<IntegrationRead<StoredPatchRef>>;
}

export interface IsolationCaptureOptions {
	readonly artifacts: CaptureCopyPort;
	readonly journal: CaptureJournalPort;
	/** C's durable-update seam; an unavailable update is a fail-closed diagnostic, never a manifest. */
	readonly publish: (update: CaptureUpdate) => void | Promise<void>;
	readonly delta?: IntegrationDeltaPort | undefined;
	/** Subscribe before the first possible registration; omit when E supplies snapshots itself. */
	readonly registry?: (() => CaptureRegistry) | undefined;
	readonly now?: (() => number) | undefined;
	readonly missingEvidenceMs?: number | undefined;
	readonly copyTimeoutMs?: number | undefined;
	/**
	 * E's slot-release seam: invoked exactly once for a candidate whose native effect end is proved by an exact
	 * origin-validated terminal. A capture timeout, a weak registry, an unbound or stock row, or a merely acknowledged
	 * job is not proof and never calls this. The callback's failure never rewrites capture evidence.
	 */
	readonly onNativeEnded?: ((admission: FrozenIntegrationAdmission) => void | Promise<void>) | undefined;
}

interface SyncFacts {
	readonly isolated: boolean | undefined;
	readonly rootPath: string | undefined;
	readonly nestedList: "explicit" | "missing" | "invalid";
	readonly nestedTyped: "explicit" | "missing";
	readonly nestedPaths: readonly string[];
	readonly nestedRelative: readonly (IntegrationRead<string>)[];
	readonly hasRootChanges: boolean | undefined;
	readonly branchName: string | undefined;
	readonly branchBase: string | undefined;
}

interface RegistryEvidence {
	readonly registryInstance: string;
	readonly generation: number | null;
	readonly childSessionFile: string | null;
	readonly patchPath: string | undefined;
	readonly nestedList: "explicit" | "missing" | "invalid";
	readonly nestedPaths: readonly string[];
	readonly branchName: string | undefined;
	/** A `metadata_changed` snapshot that carried both the patch path and an explicit nested list. */
	readonly positive: boolean;
}

/** The host's additive per-execution proof; every field is required for positive authority. */
interface NativeExecutionProof {
	readonly jobId: string;
	readonly executionToken: string;
	readonly itemIndex: number;
	readonly agentId: string;
	readonly ownerSessionId: string;
}

/** Exact first-execution binding: owner/director from the event, call/item from the admission, job from the host ack. */
interface JobBinding {
	readonly jobId: string;
	readonly agentId: string;
	readonly execution: string;
	readonly executionToken: string;
	/** When the acknowledgement was observed; a terminal registered after this cannot be this job. */
	readonly ackAt: number;
}

/** A typed terminal row that has not yet been tied to an acknowledged first execution. */
interface PendingTerminal {
	readonly jobId: string;
	readonly agentId: string;
	readonly executionToken: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly structured: BoundTerminal["structured"];
	readonly carrier: "wait" | "push";
	readonly observedAt: number;
}

interface AsyncFacts {
	bound?: JobBinding;
	ackProblem?: IntegrationProblem | undefined;
	pending?: PendingTerminal[];
	registry?: RegistryEvidence;
	registryProblem?: IntegrationProblem;
}

interface TrackedCapture {
	readonly admission: FrozenIntegrationAdmission;
	readonly candidateId: IntegrationCandidateId;
	readonly handle: string;
	readonly toolCallId: string;
	readonly itemIndex: number;
	claim?: ChildEntryClaim;
	claimProblem?: IntegrationProblem;
	registry?: RegistryEvidence;
	registryProblem?: IntegrationProblem;
	sync?: SyncFacts;
	syncProblem?: IntegrationProblem | undefined;
	async?: AsyncFacts;
	terminal?: BoundTerminal;
	terminalProblem?: IntegrationProblem;
	terminalAt?: number;
	rootCopy?: IntegrationRead<StoredPatchRef>;
	nestedCopy?: IntegrationRead<readonly NestedPartRef[]>;
	copyState: "none" | "running" | "done";
	copyController?: AbortController;
	bundle?: EmittedBundle;
	delta?: IntegrationRead<ExactDeltaProof>;
	recovery?: RecoveryFacts;
	/** Typed facts that only became bound after the seal; recovery inputs, never a second manifest. */
	lateSync?: SyncFacts;
	lateParts?: {
		readonly rootPath: string | undefined;
		readonly rootCopy: IntegrationRead<StoredPatchRef> | undefined;
		readonly nestedPaths: readonly string[];
		readonly nestedCopy: IntegrationRead<readonly NestedPartRef[]> | undefined;
	};
	lateCopyKey?: string;
	lateController?: AbortController;
	manifest?: SealedCaptureManifest;
	journalSequence?: number;
	settlement?: AttemptSettlement;
	settlementPublished: boolean;
	/** The origin-validated native terminal has been delivered to E's release seam exactly once. */
	nativeEnded: boolean;
	lateJournalSent: boolean;
	deadlineTimer?: NodeJS.Timeout;
	deadlineReached: boolean;
	job?: Promise<void>;
	dirty: boolean;
	lateKeys: Set<string>;
	abandoned: boolean;
	unavailableSent: boolean;
}

interface AsyncRow {
	readonly type: string | undefined;
	readonly jobId: string | undefined;
	readonly agentId: string | undefined;
	/** Original-call position for an acknowledgement progress row; undefined on wait/push job rows. */
	readonly index: number | undefined;
	readonly status: "completed" | "failed" | "cancelled" | "running" | undefined;
	/** The additive typed execution object; absent on a stock row, which is recovery only. */
	readonly execution: NativeExecutionProof | undefined;
	readonly structured: "valid" | "invalid" | "unknown";
}

/** Stable digest of the canonical manifest payload. Consumers recompute it; a stored `digest` never authorizes one. */
export function captureManifestDigest(manifest: Omit<SealedCaptureManifest, "digest">): string {
	return sha256Hex(canonicalJson(manifest));
}

/** The one capture join for a director. E constructs it before dispatch and calls the port hooks. */
export class IsolationCapture implements IntegrationCapturePort {
	readonly #artifacts: CaptureCopyPort;
	readonly #journal: CaptureJournalPort;
	readonly #publish: (update: CaptureUpdate) => void | Promise<void>;
	readonly #delta: IntegrationDeltaPort | undefined;
	readonly #registryFactory: (() => CaptureRegistry) | undefined;
	readonly #now: () => number;
	readonly #missingMs: number;
	readonly #copyMs: number;
	readonly #onNativeEnded: ((admission: FrozenIntegrationAdmission) => void | Promise<void>) | undefined;
	readonly #tracked = new Map<IntegrationCandidateId, TrackedCapture>();
	readonly #byHandle = new Map<string, Set<IntegrationCandidateId>>();
	readonly #jobs = new Set<Promise<void>>();
	readonly #unmatched = new Map<string, number>();
	#unsubscribe: (() => void) | undefined;
	#stopped = false;
	/** Bumped on every accepted evidence mutation; a seal revalidates it after every await. */
	#revision = 0;

	constructor(options: IsolationCaptureOptions) {
		this.#artifacts = options.artifacts;
		this.#journal = options.journal;
		this.#publish = options.publish;
		this.#delta = options.delta;
		this.#registryFactory = options.registry;
		this.#now = options.now ?? Date.now;
		this.#missingMs = Math.max(0, options.missingEvidenceMs ?? CAPTURE_MISSING_EVIDENCE_MS);
		this.#copyMs = Math.max(1, options.copyTimeoutMs ?? this.#missingMs);
		this.#onNativeEnded = options.onNativeEnded;
	}

	/** Subscribe once, before the first possible registration. Idempotent and independent of the legacy collector. */
	start(): void {
		if (this.#stopped || this.#unsubscribe !== undefined || this.#registryFactory === undefined) return;
		const registry = this.#registryFactory();
		this.#unsubscribe = registry.onChange(event => {
			// The listener body runs synchronously: copy every primitive now, never queue the mutable ref.
			const ref = event.ref;
			const instance = typeof ref.session?.instanceKey === "string" ? ref.session.instanceKey : undefined;
			const nested = Array.isArray(ref.history?.nestedPatchPaths) ? [...ref.history.nestedPatchPaths] : undefined;
			const history = ref.history === undefined
				? {}
				: {
						...(typeof ref.history.patchPath === "string" ? { patchPath: ref.history.patchPath } : {}),
						...(nested === undefined ? {} : { nestedPatchPaths: nested }),
						...(typeof ref.history.branchName === "string" ? { branchName: ref.history.branchName } : {}),
					};
			const observedAt = this.#now();
			const directors = new Map<string, DirectorIdentity>();
			for (const candidateId of this.#byHandle.get(ref.id) ?? []) {
				const tracked = this.#tracked.get(candidateId);
				if (tracked === undefined || tracked.abandoned) continue;
				const director = tracked.admission.director;
				directors.set(`${director.sessionId}\0${director.sessionInstance}\0${director.sessionDir}\0${director.parentId}`, director);
			}
			for (const director of directors.values()) {
				const childSessionFile = typeof ref.sessionFile === "string" ? ref.sessionFile : null;
				this.observeRegistry({
					director,
					registryInstance: instance ?? "",
					event: event.type,
					handle: ref.id,
					parentId: typeof ref.parentId === "string" ? ref.parentId : null,
					parentSessionKey: typeof ref.parentSessionKey === "string" ? ref.parentSessionKey : null,
					generation: typeof ref.generation === "number" ? ref.generation : null,
					childSessionFile,
					history: {
						...(history.patchPath === undefined ? {} : { patchPath: history.patchPath }),
						...(history.nestedPatchPaths === undefined ? {} : { nestedPatchPaths: history.nestedPatchPaths }),
						...(history.branchName === undefined ? {} : { branchName: history.branchName }),
					},
					observedAt,
				});
			}
		});
	}

	stop(): void {
		this.#stopped = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const tracked of this.#tracked.values()) {
			clearTimeout(tracked.deadlineTimer);
			tracked.copyController?.abort();
		}
		this.#tracked.clear();
		this.#byHandle.clear();
		this.#jobs.clear();
	}

	/** Test/measurement seam: await every scheduled copy, seal and late recovery. */
	async drain(): Promise<void> {
		while (this.#jobs.size > 0) await Promise.allSettled([...this.#jobs]);
	}

	/** Bounded counters for unbound native observations; never candidate evidence. */
	stats(): { readonly tracked: number; readonly unmatched: Readonly<Record<string, number>> } {
		return { tracked: this.#tracked.size, unmatched: Object.fromEntries(this.#unmatched) };
	}

	track(admission: FrozenIntegrationAdmission): IntegrationCheck {
		const checked = validateFrozenAdmission(admission);
		if (checked.kind === "unknown") return { ok: false, problem: checked.problem };
		const value = checked.value;
		this.start();
		if (this.#tracked.size >= MAX_TRACKED) this.#pruneSealed();
		if (this.#tracked.size >= MAX_TRACKED) return { ok: false, problem: problem("capture-capacity", "후보 추적 상한을 넘었습니다") };
		const candidateId = integrationCandidateId(value.key);
		const existing = this.#tracked.get(candidateId);
		if (existing !== undefined) {
			if (canonicalJson(existing.admission) !== canonicalJson(value)) {
				return { ok: false, problem: problem("capture-admission-conflict", "같은 후보 ID에 다른 승인이 있습니다") };
			}
			return { ok: true };
		}
		const tracked: TrackedCapture = {
			admission: value,
			candidateId,
			handle: value.item.handle,
			toolCallId: value.item.toolCallId,
			itemIndex: value.item.itemIndex,
			copyState: "none",
			settlementPublished: false,
			nativeEnded: false,
			lateJournalSent: false,
			deadlineReached: false,
			dirty: false,
			lateKeys: new Set(),
			abandoned: false,
			unavailableSent: false,
		};
		this.#tracked.set(candidateId, tracked);
		const set = this.#byHandle.get(tracked.handle) ?? new Set<IntegrationCandidateId>();
		set.add(candidateId);
		this.#byHandle.set(tracked.handle, set);
		return { ok: true };
	}

	#pruneSealed(): void {
		// A sealed candidate lives in the journal; dropping this process's copy never deletes a host workspace or receipt.
		for (const [candidateId, tracked] of this.#tracked) {
			if (tracked.manifest === undefined || tracked.job !== undefined) continue;
			this.#tracked.delete(candidateId);
			const set = this.#byHandle.get(tracked.handle);
			set?.delete(candidateId);
			if (set?.size === 0) this.#byHandle.delete(tracked.handle);
			if (this.#tracked.size < Math.floor(MAX_TRACKED * 3 / 4)) return;
		}
	}

	abandonBeforeDispatch(key: AdmissionKey): void {
		if (!isAdmissionKey(key)) return;
		const candidateId = integrationCandidateId(key);
		const tracked = this.#tracked.get(candidateId);
		if (tracked === undefined) return;
		if (tracked.manifest !== undefined) return;
		tracked.abandoned = true;
		clearTimeout(tracked.deadlineTimer);
		tracked.copyController?.abort();
		this.#tracked.delete(candidateId);
		const set = this.#byHandle.get(tracked.handle);
		set?.delete(candidateId);
		if (set?.size === 0) this.#byHandle.delete(tracked.handle);
	}

	observeRegistry(snapshot: RegistrySnapshotInput): void {
		if (this.#stopped) return;
		const candidates = [...this.#tracked.values()].filter(
			tracked =>
				!tracked.abandoned &&
				tracked.handle === snapshot.handle &&
				(snapshot.parentId === null || tracked.admission.director.parentId === snapshot.parentId) &&
				(snapshot.parentSessionKey === null || tracked.admission.director.sessionInstance === snapshot.parentSessionKey) &&
				sameDirector(tracked.admission.director, snapshot.director),
		);
		if (candidates.length === 0) {
			this.#bump("registry-unbound");
			return;
		}
		// `parentSessionKey` binds the director; `registryInstance` is the child session instance carried by the ref, so the
		// two must never be compared to each other. With a reused handle, prefer the candidate whose child claim names the
		// same child instance, then the newest admission; never fan one mutable ref out to several candidates.
		const exact = candidates.filter(
			tracked =>
				tracked.claim !== undefined &&
				snapshot.registryInstance !== "" &&
				tracked.claim.entry.registryInstance === snapshot.registryInstance,
		);
		const pool = exact.length > 0 ? exact : candidates;
		const tracked = pool.reduce((latest, item) => (item.admission.startedAt >= latest.admission.startedAt ? item : latest));
		if (pool.some(item => item !== tracked && item.admission.startedAt === tracked.admission.startedAt)) {
			this.#bump("registry-ambiguous");
			return;
		}
		const observedAt = Number.isSafeInteger(snapshot.observedAt) ? snapshot.observedAt : this.#now();
		if (observedAt < tracked.admission.startedAt) {
			this.#bump("registry-stale");
			return;
		}
		const otherExecution =
			(snapshot.parentSessionKey !== null && snapshot.parentSessionKey !== tracked.admission.director.sessionInstance) ||
			(snapshot.parentId !== null && snapshot.parentId !== tracked.admission.director.parentId) ||
			(tracked.claim !== undefined &&
				snapshot.registryInstance !== "" &&
				tracked.claim.entry.registryInstance !== snapshot.registryInstance) ||
			(tracked.registry !== undefined &&
				tracked.registry.registryInstance !== "" &&
				snapshot.registryInstance !== "" &&
				tracked.registry.registryInstance !== snapshot.registryInstance);
		if (otherExecution) {
			// A reused handle from another run, wake or child instance is not this candidate's evidence; it neither mints
			// a candidate nor revokes a sealed one.
			this.#bump("registry-other-execution");
			return;
		}
		const rawNested = snapshot.history.nestedPatchPaths;
		const validatedNested = Array.isArray(rawNested)
			? rawNested.slice(0, 256).map(path => absolutePath(path))
			: undefined;
		const nestedList: RegistryEvidence["nestedList"] =
			validatedNested === undefined ? "missing" : validatedNested.every((path): path is string => path !== undefined) ? "explicit" : "invalid";
		const nestedPaths = (validatedNested ?? []).filter((path): path is string => path !== undefined);
		const patchPath = absolutePath(snapshot.history.patchPath);
		const branchName = typeof snapshot.history.branchName === "string" && snapshot.history.branchName !== "" ? snapshot.history.branchName : undefined;
		const identityProblem = this.#checkRegistryIdentity(tracked, snapshot);
		if (identityProblem !== undefined) {
			const before = tracked.registryProblem?.code;
			tracked.registryProblem ??= identityProblem;
			if (before !== tracked.registryProblem.code) this.#revision += 1;
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		const prior = tracked.registry;
		if (prior !== undefined) {
			if (prior.patchPath !== undefined && patchPath !== undefined && prior.patchPath !== patchPath) {
				const before = tracked.registryProblem?.code;
				tracked.registryProblem ??= problem("registry-parts-changed", "같은 후보에 다른 루트 패치 경로가 관측되었습니다");
				if (before !== tracked.registryProblem.code) this.#revision += 1;
				if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
				else this.#schedule(tracked);
				return;
			}
			if (prior.nestedList === "explicit" && nestedList === "explicit" && canonicalJson(prior.nestedPaths) !== canonicalJson(nestedPaths)) {
				const before = tracked.registryProblem?.code;
				tracked.registryProblem ??= problem("registry-parts-changed", "같은 후보에 다른 중첩 패치 목록이 관측되었습니다");
				if (before !== tracked.registryProblem.code) this.#revision += 1;
				if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
				else this.#schedule(tracked);
				return;
			}
		}
		const positive =
			snapshot.event === "metadata_changed" &&
			patchPath !== undefined &&
			nestedList === "explicit" &&
			snapshot.parentSessionKey !== null &&
			typeof snapshot.registryInstance === "string" &&
			snapshot.registryInstance !== "" &&
			typeof snapshot.generation === "number" &&
			snapshot.generation >= 0 &&
			typeof snapshot.childSessionFile === "string" &&
			snapshot.childSessionFile !== "";
		const evidence: RegistryEvidence = {
			registryInstance: snapshot.registryInstance !== "" ? snapshot.registryInstance : (prior?.registryInstance ?? ""),
			generation: snapshot.generation ?? prior?.generation ?? null,
			childSessionFile: snapshot.childSessionFile ?? prior?.childSessionFile ?? null,
			patchPath: patchPath ?? prior?.patchPath,
			nestedList: nestedList === "explicit" ? "explicit" : (prior?.nestedList ?? "missing"),
			nestedPaths: nestedList === "explicit" ? nestedPaths : (prior?.nestedPaths ?? []),
			branchName: branchName ?? prior?.branchName,
			positive: positive || prior?.positive === true,
		};
		tracked.registry = evidence;
		this.#revision += 1;
		if (positive) this.#armDeadline(tracked);
		if (tracked.manifest !== undefined) {
			this.#scheduleLate(tracked);
			return;
		}
		// Sync typed facts stay authoritative for eligibility; a registry branch is a recovery fact and may change it to
		// kept-only, so a pre-seal registry event still re-evaluates the bundle.
		this.#schedule(tracked);
	}

	observeSync(input: {
		readonly director: DirectorIdentity;
		readonly toolCallId: string;
		readonly results: readonly (SyncResultFact & {
			readonly index?: unknown;
			readonly isolated?: unknown;
			readonly branchName?: unknown;
			readonly branchBaseSha?: unknown;
			readonly hasRootChanges?: unknown;
			readonly nestedPatches?: unknown;
			readonly nestedPatchPaths?: unknown;
		})[];
		readonly observedAt: number;
	}): void {
		if (this.#stopped) return;
		const results = Array.isArray(input.results) ? input.results : [];
		for (const tracked of [...this.#tracked.values()]) {
			if (tracked.abandoned) continue;
			if (tracked.toolCallId !== input.toolCallId || !sameDirector(tracked.admission.director, input.director)) continue;
			// The host compacts the batch but keeps each spawn's original-call `index`; position in this array is not the
			// item index. Bind the typed index and the exact handle together, and refuse a duplicate handle anywhere.
			const exact = results.filter(item => record(item) && item.index === tracked.itemIndex);
			if (exact.length !== 1) {
				this.#bump(exact.length === 0 ? "sync-item-unbound" : "sync-item-duplicate");
				continue;
			}
			const result = exact[0] as SyncResultFact;
			if (result.id !== tracked.handle) {
				this.#bump("sync-item-unbound");
				continue;
			}
			if (results.filter(item => record(item) && item.id === tracked.handle).length !== 1) {
				this.#bump("sync-item-duplicate");
				continue;
			}
			const observedAt = Number.isSafeInteger(input.observedAt) ? input.observedAt : this.#now();
			if (observedAt < tracked.admission.startedAt) {
				this.#bump("sync-stale");
				continue;
			}
			if (tracked.sync !== undefined) {
				// A replay of the same terminal is not new. A later, different terminal is a contradiction even before the
				// seal; after the seal it is a recovery observation. The part list is never replaced by a second envelope.
				const terminal = syncTerminal(tracked.admission, result, observedAt);
				if (terminal.kind === "known") {
					const before = tracked.terminal === undefined ? undefined : terminalStatus(tracked.terminal);
					const after = terminalStatus(terminal.value);
					if (before !== after) {
						if (before !== undefined) tracked.terminalProblem = problem("terminal-contradicted", "같은 승인에 다른 동기 종료 사실이 도착했습니다");
						tracked.terminal = terminal.value;
						this.#revision += 1;
						if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
						else this.#schedule(tracked);
					}
					// The exact result already proves the native effect end even when the capture itself stays recovery.
					this.#noteNativeEnded(tracked);
				} else if (terminal.problem.code !== "exit-code-missing") {
					const before = tracked.terminalProblem?.code;
					tracked.terminalProblem = terminal.problem;
					if (before !== terminal.problem.code) {
						this.#revision += 1;
						if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
						else this.#schedule(tracked);
					}
				}
				const next = syncFacts(result);
				if (tracked.manifest === undefined) {
					if (canonicalJson(syncParts(next)) !== canonicalJson(syncParts(tracked.sync))) {
						const before = tracked.syncProblem?.code;
						tracked.syncProblem = problem("sync-parts-changed", "같은 승인에 다른 동기 캡처 부품이 도착했습니다");
						if (before !== tracked.syncProblem.code) this.#revision += 1;
						this.#schedule(tracked);
					}
				} else if (canonicalJson(syncParts(next)) !== canonicalJson(syncParts(tracked.lateSync ?? tracked.sync))) {
					// A late envelope can name a patch/ref the seal never saw. It is copied into recovery only.
					tracked.lateSync = next;
					this.#revision += 1;
					this.#scheduleLate(tracked);
				}
				continue;
			}
			const terminal = syncTerminal(tracked.admission, result, observedAt);
			if (terminal.kind === "known") {
				if (tracked.terminal !== undefined && terminalStatus(tracked.terminal) !== terminalStatus(terminal.value)) {
					tracked.terminalProblem = problem("terminal-contradicted", "같은 승인에 다른 동기 종료 사실이 도착했습니다");
				}
				tracked.terminal = terminal.value;
				this.#noteNativeEnded(tracked);
			} else tracked.terminalProblem = terminal.problem;
			tracked.terminalAt = observedAt;
			tracked.sync = syncFacts(result);
			tracked.syncProblem = undefined;
			this.#revision += 1;
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
		}
	}

	observeAsync(input: AsyncObservationInput): void {
		if (this.#stopped) return;
		const rows = asyncRows(input);
		if (rows.length === 0) {
			this.#bump(input.carrier === "ack" ? "async-ack-empty" : `async-${input.carrier}-empty`);
			return;
		}
		const observedAt = Number.isSafeInteger(input.observedAt) ? input.observedAt : this.#now();
		for (const row of rows) {
			if (row.type !== "task") {
				this.#bump("async-not-task");
				continue;
			}
			if (row.agentId === undefined) {
				this.#bump("async-agent-missing");
				continue;
			}
			const candidates = [...this.#tracked.values()].filter(
				tracked =>
					!tracked.abandoned &&
					tracked.sync === undefined &&
					tracked.handle === row.agentId &&
					sameDirector(tracked.admission.director, input.director),
			);
			if (candidates.length === 0) {
				this.#bump("async-unbound");
				continue;
			}
			if (observedAt < Math.min(...candidates.map(tracked => tracked.admission.startedAt))) {
				this.#bump("async-stale");
				continue;
			}
			if (input.carrier === "ack") {
				// The ack names one resolved job per original item; the call id plus the typed execution object selects the
				// admission. A label, a batch-primary id or a stock progress row is never an item binding.
				const matched = candidates.filter(
					tracked =>
						input.toolCallId !== undefined &&
						tracked.toolCallId === input.toolCallId &&
						tracked.itemIndex === row.index &&
						tracked.handle === row.agentId,
				);
				if (matched.length !== 1) {
					if (candidates.length === 1) {
						// A sole candidate still gets the precise reason its acknowledgement could not bind; this is a
						// diagnostic and never a positive fact.
						const only = candidates[0] as TrackedCapture;
						const state: AsyncFacts = only.async ?? {};
						only.async = state;
						const before = state.ackProblem?.code;
						state.ackProblem ??= problem(
							matched.length === 0 ? "async-ack-unbound" : "async-ack-ambiguous",
							"확인 응답을 이 승인의 호출/항목에 정확히 결합하지 못했습니다",
						);
						if (before !== state.ackProblem.code) this.#revision += 1;
						if (only.manifest !== undefined) this.#scheduleLate(only);
						else this.#schedule(only);
					}
					this.#bump(matched.length === 0 ? "async-ack-unbound" : "async-ack-ambiguous");
					continue;
				}
				if (rows.filter(other => other.index === row.index && other.agentId === row.agentId).length !== 1) {
					this.#bump("async-ack-duplicate");
					continue;
				}
				const tracked = matched[0] as TrackedCapture;
				this.#acknowledge(tracked, row, input, observedAt);
				continue;
			}
			if (input.carrier === "registration") {
				// A registration/status event names no admitted call; it cannot authorize a positive first execution.
				this.#bump("async-registration-unproven");
				continue;
			}
			if (row.status === undefined || row.status === "running") {
				this.#bump("async-not-terminal");
				continue;
			}
			if (row.jobId === undefined) {
				this.#bump("async-job-missing");
				continue;
			}
			const bound = candidates.filter(tracked => tracked.async?.bound?.jobId === row.jobId);
			if (bound.length > 1) {
				this.#bump("async-ambiguous");
				continue;
			}
			if (bound.length === 0 && candidates.length > 1) {
				this.#bump("async-ambiguous");
				continue;
			}
			const tracked = (bound[0] ?? candidates[0]) as TrackedCapture;
			this.#terminalRow(tracked, row, input.carrier === "push" ? "push" : "wait", observedAt);
		}
	}

	#acknowledge(tracked: TrackedCapture, row: AsyncRow, input: AsyncObservationInput, observedAt: number): void {
		const state: AsyncFacts = tracked.async ?? {};
		tracked.async = state;
		const proof = row.execution;
		const exact =
			proof !== undefined &&
			input.toolCallId !== undefined &&
			input.toolCallId === tracked.toolCallId &&
			proof.itemIndex === tracked.itemIndex &&
			proof.agentId === tracked.handle &&
			proof.ownerSessionId === tracked.admission.director.parentId &&
			proof.jobId === row.jobId;
		if (!exact) {
			const before = state.ackProblem?.code;
			state.ackProblem ??= problem(
				proof === undefined ? "async-ack-stock" : "async-ack-unproven",
				proof === undefined
					? "확인 응답에 항목별 타입 실행 증명이 없습니다"
					: "확인 응답의 실행 증명이 이 승인의 소유자/호출/항목과 다릅니다",
			);
			if (before !== state.ackProblem.code) this.#revision += 1;
			this.#bump(proof === undefined ? "async-ack-stock" : "async-ack-unproven");
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		const execution = jobExecution(tracked, proof.jobId, proof.executionToken);
		if (state.bound !== undefined) {
			if (state.bound.jobId !== proof.jobId || state.bound.executionToken !== proof.executionToken) {
				const before = state.ackProblem?.code;
				state.ackProblem ??= problem("async-ack-conflict", "같은 승인에 다른 실행 증명이 도착했습니다");
				if (before !== state.ackProblem.code) this.#revision += 1;
				this.#bump("async-ack-conflict");
				if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
				else this.#schedule(tracked);
			}
			return;
		}
		state.bound = {
			jobId: proof.jobId,
			agentId: proof.agentId,
			execution,
			executionToken: proof.executionToken,
			ackAt: observedAt,
		};
		state.ackProblem = undefined;
		this.#revision += 1;
		this.#joinPending(tracked);
		if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
		else this.#schedule(tracked);
	}

	#terminalRow(tracked: TrackedCapture, row: AsyncRow, carrier: "wait" | "push", observedAt: number): void {
		if (row.jobId === undefined || row.agentId === undefined || row.status === undefined || row.status === "running") return;
		const proof = row.execution;
		if (proof === undefined) {
			// Stock wait/push rows carry no nonreused execution token. They may bound the wait (so a manifest records the
			// recovery) but can never become positive evidence.
			this.#bump("async-stock-unproven");
			this.#armDeadline(tracked);
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		if (
			proof.jobId !== row.jobId ||
			proof.agentId !== row.agentId ||
			proof.itemIndex !== tracked.itemIndex ||
			proof.agentId !== tracked.handle ||
			proof.ownerSessionId !== tracked.admission.director.parentId
		) {
			this.#bump("async-job-conflict");
			return;
		}
		const state: AsyncFacts = tracked.async ?? {};
		tracked.async = state;
		if (tracked.manifest !== undefined && tracked.terminal !== undefined && tracked.terminal.carrier !== "sync") {
			if (tracked.terminal.job.jobId !== row.jobId) {
				this.#bump("async-late-other-execution");
				return;
			}
		}
		const pending: PendingTerminal = {
			jobId: row.jobId,
			agentId: row.agentId,
			executionToken: proof.executionToken,
			status: row.status,
			structured: row.structured,
			carrier,
			observedAt,
		};
		const bound = state.bound;
		if (bound === undefined) {
			// Too early to know whose execution this is. Keep the typed row; only an exact acknowledgement can redeem it.
			if (this.#rememberPending(state, pending)) this.#revision += 1;
			this.#armDeadline(tracked);
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		if (
			pending.jobId !== bound.jobId ||
			pending.agentId !== bound.agentId ||
			pending.executionToken !== bound.executionToken
		) {
			// A different token is another execution that reused the job id; it cannot replace this acknowledgement.
			this.#bump("async-late-other-execution");
			return;
		}
		this.#bindTerminal(tracked, pending);
	}

	#joinPending(tracked: TrackedCapture): void {
		const state = tracked.async;
		const bound = state?.bound;
		if (bound === undefined || state === undefined) return;
		const pending = (state.pending ?? []).filter(
			item =>
				item.jobId === bound.jobId &&
				item.agentId === bound.agentId &&
				item.executionToken === bound.executionToken,
		);
		for (const item of pending) this.#bindTerminal(tracked, item);
	}

	#rememberPending(state: AsyncFacts, pending: PendingTerminal): boolean {
		const list = state.pending ?? (state.pending = []);
		const key = `${pending.jobId}\0${pending.agentId}\0${pending.executionToken}\0${pending.status}\0${pending.structured}`;
		for (const item of list) {
			const existing = `${item.jobId}\0${item.agentId}\0${item.executionToken}\0${item.status}\0${item.structured}`;
			if (existing === key) return false;
		}
		list.push(pending);
		if (list.length > 8) list.shift();
		return true;
	}

	#bindTerminal(tracked: TrackedCapture, pending: PendingTerminal): void {
		const state = tracked.async;
		const bound = state?.bound;
		if (bound === undefined) return;
		const job: NativeJobExecution = { jobId: bound.jobId, type: "task", agentId: bound.agentId, execution: bound.execution };
		const carried: BoundTerminal = {
			observedAt: pending.observedAt,
			outcome: known<AttemptOutcome>(
				pending.status === "cancelled"
					? "cancel"
					: pending.status === "completed" && pending.structured !== "invalid"
						? "success"
						: "failure",
			),
			structured: pending.structured,
			stopCause: unknown("stop-cause-unproved", "중단 원인이 네이티브 필드로 확인되지 않았습니다"),
			cancelRequested: false,
			nativeLink: `history://${tracked.handle}`,
			carrier: pending.carrier,
			job,
			status: pending.status,
		};
		const before = tracked.terminal === undefined ? undefined : terminalStatus(tracked.terminal);
		const after = terminalStatus(carried);
		if (before !== undefined && before !== after) {
			tracked.terminalProblem ??= problem("terminal-contradicted", "같은 승인에 다른 비동기 종료 사실이 도착했습니다");
			this.#revision += 1;
			this.#bump("terminal-contradicted");
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		if (before === after) {
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			return;
		}
		tracked.terminal = carried;
		this.#revision += 1;
		this.#noteNativeEnded(tracked);
		this.#armDeadline(tracked);
		if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
		else this.#schedule(tracked);
	}

	observeClaim(entry: ObservationIdentity, claim: ChildEntryClaim): void {
		if (this.#stopped) return;
		if (!isIntegrationCandidateId(claim.candidateId)) return;
		const tracked = this.#tracked.get(claim.candidateId);
		if (tracked === undefined || tracked.abandoned) {
			this.#bump("claim-unbound");
			return;
		}
		if (
			claim.key.runId !== tracked.admission.key.runId ||
			claim.key.dispatch !== tracked.admission.key.dispatch ||
			claim.key.schema !== tracked.admission.key.schema ||
			claim.childHandle !== tracked.handle ||
			claim.workerAttempt !== tracked.admission.workerAdmission.attempt ||
			claim.slotOwnerToken !== tracked.admission.slot.ownerToken ||
			claim.policyProofId !== tracked.admission.policy.id ||
			claim.guardBuild !== tracked.admission.policy.guardBuild ||
			claim.checkoutTargetPrefix !== tracked.admission.target.targetPrefix ||
			canonicalJson(claim.sourceOdb) !== canonicalJson(tracked.admission.target.sourceOdb)
		) {
			const before = tracked.claimProblem?.code;
			tracked.claimProblem ??= problem("claim-admission-mismatch", "자식 진입 주장이 이 승인과 다릅니다");
			if (before !== tracked.claimProblem.code) this.#revision += 1;
			this.#bump("claim-admission-mismatch");
			this.#armDeadline(tracked);
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		if (canonicalJson(entry) !== canonicalJson(claim.entry)) {
			const before = tracked.claimProblem?.code;
			tracked.claimProblem ??= problem("claim-observation-conflict", "자식 진입 관측과 주장이 다릅니다");
			if (before !== tracked.claimProblem.code) this.#revision += 1;
			this.#bump("claim-entry-mismatch");
			this.#armDeadline(tracked);
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		if (tracked.claim !== undefined) {
			if (canonicalJson(tracked.claim) !== canonicalJson(claim)) {
				const before = tracked.claimProblem?.code;
				tracked.claimProblem ??= problem("claim-conflict", "같은 승인에 다른 자식 진입 주장이 있습니다");
				if (before !== tracked.claimProblem.code) this.#revision += 1;
				this.#bump("claim-conflict");
				this.#armDeadline(tracked);
				if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
				else this.#schedule(tracked);
			}
			return;
		}
		if (tracked.registry !== undefined && !registryMatchesClaim(tracked.registry, claim)) {
			tracked.claimProblem ??= problem("claim-registry-mismatch", "자식 진입 신원이 관측된 레지스트리 세대와 다릅니다");
		}
		tracked.claim = claim;
		this.#revision += 1;
		if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
		else this.#schedule(tracked);
	}

	/** E binds the existing attempt settlement for the exact planned dispatch; A never calls the evaluator itself. */
	noteSettlement(settlement: AttemptSettlement): void {
		for (const tracked of this.#tracked.values()) {
			if (tracked.admission.key.runId !== settlement.runId || tracked.admission.key.dispatch !== settlement.dispatch) continue;
			if (tracked.settlement !== undefined) return;
			tracked.settlement = settlement;
			if (tracked.manifest !== undefined && tracked.journalSequence !== undefined && !tracked.settlementPublished) {
				tracked.settlementPublished = true;
				this.#deliver({
					kind: "sealed",
					manifest: tracked.manifest,
					journalSequence: tracked.journalSequence,
					settlement,
				});
			}
			return;
		}
	}

	// ── scheduling and seal ─────────────────────────────────────────────────────────────────────────────────────

	#schedule(tracked: TrackedCapture): void {
		if (tracked.abandoned || this.#stopped) return;
		if (tracked.job !== undefined) {
			tracked.dirty = true;
			return;
		}
		let job!: Promise<void>;
		job = this.#work(tracked)
			.catch(() => undefined)
			.finally(() => {
				this.#jobs.delete(job);
				if (tracked.job !== job) return;
				delete tracked.job;
				if (tracked.dirty) {
					tracked.dirty = false;
					this.#schedule(tracked);
				}
			});
		tracked.job = job;
		this.#jobs.add(job);
	}

	async #work(tracked: TrackedCapture): Promise<void> {
		if (tracked.manifest !== undefined) {
			await this.#lateObservation(tracked);
			return;
		}
		if (tracked.copyState === "none") {
			const plan = this.#copyPlan(tracked);
			if (plan !== undefined) {
				tracked.copyState = "running";
				await this.#acquire(tracked, plan.root, plan.nested);
				tracked.copyState = "done";
			} else if (
				tracked.deadlineReached ||
				tracked.registryProblem !== undefined ||
				tracked.claimProblem !== undefined ||
				tracked.terminalProblem !== undefined
			) {
				tracked.copyState = "done";
				tracked.rootCopy ??= unknown("native-root-missing", "네이티브 루트 패치 경로가 없습니다");
				tracked.nestedCopy ??= unknown("native-nested-missing", "네이티브 중첩 패치 목록이 없습니다");
			}
		}
		await this.#maybeSeal(tracked);
	}

	#copyPlan(tracked: TrackedCapture): { root: string | undefined; nested: readonly string[]; relative: readonly (IntegrationRead<string>)[] } | undefined {
		if (tracked.sync !== undefined) {
			return { root: tracked.sync.rootPath, nested: tracked.sync.nestedPaths, relative: tracked.sync.nestedRelative };
		}
		const registry = tracked.registry;
		const state = tracked.async;
		if (registry === undefined) return undefined;
		if (state?.bound === undefined && tracked.claim === undefined) return undefined;
		if (registry.patchPath === undefined && registry.nestedList === "missing") return undefined;
		return {
			root: registry.patchPath,
			nested: registry.nestedList === "explicit" ? registry.nestedPaths : [],
			relative: [],
		};
	}

	async #acquire(tracked: TrackedCapture, rootPath: string | undefined, nestedPaths: readonly string[]): Promise<void> {
		if (nestedPaths.length > CAPTURE_MAX_PARTS) {
			tracked.nestedCopy = unknown("capture-part-capacity", "한 매니페스트의 타입 부품 상한을 넘었습니다");
		}
		const deadline = this.#now() + this.#copyMs;
		const controller = new AbortController();
		tracked.copyController = controller;
		if (rootPath === undefined) {
			tracked.rootCopy = unknown("native-root-missing", "네이티브 루트 패치 경로가 없습니다");
		} else {
			tracked.rootCopy = await this.#artifacts.copyPatch({
				admission: tracked.admission,
				kind: "root",
				nativePath: rootPath,
				deadline,
				signal: controller.signal,
			});
		}
		if (nestedPaths.length === 0) {
			tracked.nestedCopy =
				tracked.sync?.nestedList === "explicit" || tracked.registry?.nestedList === "explicit"
					? known([])
					: unknown("native-nested-missing", "네이티브 중첩 패치 목록이 없습니다");
			return;
		}
		const parts: NestedPartRef[] = [];
		for (const [index, path] of nestedPaths.slice(0, CAPTURE_MAX_PARTS).entries()) {
			const relative = tracked.sync?.nestedRelative[index] ?? unknown<string>("nested-repo-unproved", "중첩 저장소 상대 경로가 타입으로 확인되지 않았습니다");
			const copy = await this.#artifacts.copyPatch({
				admission: tracked.admission,
				kind: "nested",
				nativePath: path,
				deadline,
				signal: controller.signal,
			});
			parts.push({ nativePath: path, copy, relativeRepo: relative });
		}
		tracked.nestedCopy = known(parts);
	}

	async #maybeSeal(tracked: TrackedCapture): Promise<void> {
		if (tracked.manifest !== undefined || tracked.abandoned || this.#stopped) return;
		if (tracked.copyState !== "done") return;
		const state = tracked.async;
		if (tracked.terminal === undefined && tracked.terminalProblem === undefined && !tracked.deadlineReached) return;
		if (tracked.sync === undefined) {
			const ready = tracked.terminal !== undefined && state?.bound !== undefined && tracked.claim !== undefined && tracked.registry?.positive === true;
			const contradiction =
				tracked.registryProblem !== undefined || tracked.claimProblem !== undefined || tracked.terminalProblem !== undefined;
			if (!ready && !tracked.deadlineReached && !contradiction) {
				this.#armDeadline(tracked);
				return;
			}
		} else {
			// A sync result is complete native evidence, but it is not a successful placement without the exact child
			// entry claim. A missing claim gets the same bounded disposition as any other missing capture input; a known
			// contradiction fails closed immediately, and the copied bytes remain recovery facts.
			const contradiction =
				tracked.claimProblem !== undefined ||
				tracked.registryProblem !== undefined ||
				tracked.terminalProblem !== undefined ||
				tracked.syncProblem !== undefined;
			if (tracked.claim === undefined && !contradiction && !tracked.deadlineReached) {
				this.#armDeadline(tracked);
				return;
			}
		}
		await this.#seal(tracked);
	}

	#armDeadline(tracked: TrackedCapture): void {
		if (tracked.deadlineTimer !== undefined || tracked.deadlineReached || tracked.manifest !== undefined) return;
		tracked.deadlineTimer = setTimeout(() => {
			if (this.#stopped || tracked.manifest !== undefined || tracked.abandoned) return;
			tracked.deadlineReached = true;
			this.#schedule(tracked);
		}, this.#missingMs);
		tracked.deadlineTimer.unref?.();
	}

	async #seal(tracked: TrackedCapture): Promise<void> {
		if (tracked.manifest !== undefined || tracked.abandoned || this.#stopped) return;
		clearTimeout(tracked.deadlineTimer);
		const revision = this.#revision;
		let bundle = this.#bundle(tracked);
		const rootRef = tracked.rootCopy?.kind === "known" ? tracked.rootCopy.value : undefined;
		let delta: IntegrationRead<ExactDeltaProof> = unknown("delta-not-root-only", "루트 전용 성공 후보가 아니라 델타를 증명하지 않았습니다");
		if (bundle.kind === "root-only" && rootRef !== undefined && this.#delta !== undefined) {
			const window: ByteWindow = {
				maxBytes: CAPTURE_MAX_PATCH_BYTES,
				deadline: this.#now() + this.#copyMs,
				signal: new AbortController().signal,
			};
			delta = await this.#delta.proveRoot(
				{
					key: tracked.admission.key,
					candidateId: tracked.candidateId,
					target: tracked.admission.target,
					scope: tracked.admission.scope,
					sourceOdb: tracked.admission.target.sourceOdb,
					root: rootRef,
				},
				window,
			);
			if (this.#stopped || tracked.abandoned || tracked.manifest !== undefined) return;
			if (this.#revision !== revision) {
				// A claim, terminal or part changed during the proof. Never publish a ready manifest built from the older
				// snapshot: reschedule and seal from the new revision (or fail closed if it is a contradiction).
				this.#schedule(tracked);
				return;
			}
		}
		// Everything the payload names is read after the last await, so a delta proved for one bundle can never be paired
		// with a different bundle or a newer claim/terminal.
		const recovery = this.#recovery(tracked);
		bundle = this.#bundle(tracked);
		if (bundle.kind === "root-only" && rootRef !== undefined && delta.kind === "known") {
			const proved = delta.value;
			if (proved.root.sha256 !== rootRef.sha256 || proved.root.bytes !== rootRef.bytes) {
				delta = unknown("delta-stale", "증명된 델타가 봉인할 루트 사본과 다릅니다");
			}
		} else if (bundle.kind !== "root-only" && delta.kind === "known") {
			delta = unknown("delta-not-root-only", "루트 전용 성공 후보가 아니라 델타를 증명하지 않았습니다");
		}
		if (this.#revision !== revision) {
			this.#schedule(tracked);
			return;
		}
		tracked.bundle = bundle;
		tracked.delta = delta;
		tracked.recovery = recovery;
		const childClaim: IntegrationRead<ChildEntryClaim> =
			tracked.claim !== undefined
				? known(tracked.claim)
				: unknown(
						tracked.claimProblem?.code ?? "child-claim-missing",
						tracked.claimProblem?.reason ?? "자식 진입 주장이 확인되지 않았습니다",
					);
		const terminal: IntegrationRead<BoundTerminal> =
			tracked.terminal !== undefined
				? known(tracked.terminal)
				: unknown(
						tracked.terminalProblem?.code ?? "native-terminal-missing",
						tracked.terminalProblem?.reason ?? "네이티브 종료 사실이 확인되지 않았습니다",
					);
		const payload: Omit<SealedCaptureManifest, "digest"> = {
			schema: "storm.integration-capture/v1",
			admission: tracked.admission,
			childClaim,
			terminal,
			bundle,
			delta,
			recovery,
		};
		const manifest: SealedCaptureManifest = { ...payload, digest: captureManifestDigest(payload) };
		const appendRevision = this.#revision;
		let sequence: IntegrationRead<number>;
		try {
			sequence = await this.#journal.appendManifest(manifest);
		} catch {
			sequence = unknown("journal-append-failed", "통합 저널에 캡처를 기록하지 못했습니다");
		}
		if (sequence.kind === "unknown") {
			if (!tracked.unavailableSent) {
				tracked.unavailableSent = true;
				this.#deliver({
					kind: "unavailable",
					key: tracked.admission.key,
					candidateId: tracked.candidateId,
					problem: sequence.problem,
				});
			}
			return;
		}
		tracked.manifest = manifest;
		tracked.journalSequence = sequence.value;
		const update: CaptureUpdate =
			tracked.settlement === undefined
				? { kind: "sealed", manifest, journalSequence: sequence.value }
				: { kind: "sealed", manifest, journalSequence: sequence.value, settlement: tracked.settlement };
		tracked.settlementPublished = tracked.settlement !== undefined;
		this.#deliver(update);
		// The manifest is immutable, so a fact that changed while the append ran is recorded as its own late recovery
		// observation, never folded into a rewrite or a second seal.
		if (this.#revision !== appendRevision) this.#scheduleLate(tracked);
	}

	#bundle(tracked: TrackedCapture): EmittedBundle {
		const terminal = tracked.terminal;
		if (tracked.terminalProblem !== undefined) return { kind: "unknown", problem: tracked.terminalProblem };
		if (terminal === undefined) {
			return {
				kind: "unknown",
				problem:
					tracked.terminalProblem ??
					(tracked.sync === undefined ? tracked.async?.ackProblem : undefined) ??
					problem("native-terminal-missing", "네이티브 종료 사실이 없습니다"),
			};
		}
		const outcome = terminal.outcome;
		if (outcome.kind === "unknown") {
			return { kind: "unknown", problem: outcome.problem };
		}
		if (outcome.value !== "success") {
			const hasBytes =
				(tracked.rootCopy?.kind === "known" && tracked.rootCopy.value.bytes > 0) ||
				(tracked.nestedCopy?.kind === "known" && tracked.nestedCopy.value.length > 0);
			return hasBytes
				? { kind: "kept-only", problem: problem("terminal-not-success", "성공하지 않은 작업의 바이트는 복구용일 뿐 통합 후보가 아닙니다") }
				: { kind: "unknown", problem: problem("terminal-not-success", "성공하지 않은 작업에서 캡처된 바이트가 없습니다") };
		}
		if (tracked.sync !== undefined) return this.#syncBundle(tracked, tracked.sync);
		return this.#asyncBundle(tracked);
	}

	#syncBundle(tracked: TrackedCapture, facts: SyncFacts): EmittedBundle {
		if (facts.isolated !== true) return { kind: "unknown", problem: problem("sync-not-isolated", "동기 결과가 격리 실행을 타입으로 표시하지 않았습니다") };
		if (tracked.claim === undefined) {
			return { kind: "unknown", problem: tracked.claimProblem ?? problem("child-claim-missing", "자식 진입 주장이 없습니다") };
		}
		if (tracked.claimProblem !== undefined) return { kind: "unknown", problem: tracked.claimProblem };
		if (tracked.registryProblem !== undefined) return { kind: "unknown", problem: tracked.registryProblem };
		if (tracked.syncProblem !== undefined) return { kind: "unknown", problem: tracked.syncProblem };
		if (facts.branchName !== undefined || tracked.registry?.branchName !== undefined) {
			return { kind: "kept-only", problem: problem("branch-capture", "브랜치 캡처는 복구 전용입니다") };
		}
		const nestedCount = facts.nestedList === "explicit" ? facts.nestedPaths.length : -1;
		if (nestedCount > 0) return { kind: "kept-only", problem: problem("nested-parts", "루트 외 중첩 부품이 있는 캡처는 복구 전용입니다") };
		if (facts.nestedRelative.length > 0) return { kind: "kept-only", problem: problem("nested-parts", "타입 중첩 부품이 있는 캡처는 복구 전용입니다") };
		if (nestedCount < 0) return { kind: "unknown", problem: problem("nested-list-missing", "동기 결과에 중첩 패치 목록이 없습니다") };
		if (facts.nestedTyped !== "explicit") return { kind: "unknown", problem: problem("nested-list-missing", "동기 결과에 타입 있는 중첩 부품 목록이 없습니다") };
		const root = tracked.rootCopy;
		if (root === undefined || root.kind === "unknown") {
			return { kind: "unknown", problem: root?.problem ?? problem("native-root-missing", "네이티브 루트 패치를 복사하지 못했습니다") };
		}
		if (root.value.bytes > 0) {
			if (facts.hasRootChanges !== true) {
				return { kind: "unknown", problem: problem("has-root-changes", "양수 루트 패치와 hasRootChanges가 일치하지 않습니다") };
			}
			return { kind: "root-only", basis: "sync-explicit", root: root.value };
		}
		if (facts.hasRootChanges === true) {
			return { kind: "unknown", problem: problem("has-root-changes", "0바이트 루트 패치와 hasRootChanges:true가 모순입니다") };
		}
		if (facts.hasRootChanges !== false) {
			return { kind: "unknown", problem: problem("has-root-changes-missing", "0바이트 패치의 hasRootChanges가 확인되지 않았습니다") };
		}
		return { kind: "confirmed-empty", basis: "sync-explicit", root: root.value };
	}

	#asyncBundle(tracked: TrackedCapture): EmittedBundle {
		const state = tracked.async;
		const registry = tracked.registry;
		if (state?.bound === undefined) {
			return {
				kind: "unknown",
				problem:
					state?.ackProblem ??
					problem("async-execution-unproved", "첫 실행 작업 결합이 확인되지 않았습니다"),
			};
		}
		if (tracked.claim === undefined) return { kind: "unknown", problem: tracked.claimProblem ?? problem("child-claim-missing", "자식 진입 주장이 없습니다") };
		if (tracked.claimProblem !== undefined) return { kind: "unknown", problem: tracked.claimProblem };
		if (registry?.branchName !== undefined) return { kind: "kept-only", problem: problem("branch-capture", "브랜치 캡처는 복구 전용입니다") };
		if (registry === undefined || !registry.positive) {
			return { kind: "unknown", problem: tracked.registryProblem ?? problem("registry-bundle-missing", "신선한 네이티브 메타데이터 캡처가 없습니다") };
		}
		if (tracked.registryProblem !== undefined) return { kind: "unknown", problem: tracked.registryProblem };
		if (registry.nestedList === "invalid") return { kind: "unknown", problem: problem("nested-list-invalid", "네이티브 중첩 패치 경로가 안전하지 않습니다") };
		if (registry.nestedList === "missing") return { kind: "unknown", problem: problem("nested-list-missing", "네이티브 메타데이터에 중첩 패치 목록이 없습니다") };
		if (registry.nestedPaths.length > 0) return { kind: "kept-only", problem: problem("nested-parts", "루트 외 중첩 부품이 있는 캡처는 복구 전용입니다") };
		const root = tracked.rootCopy;
		if (root === undefined || root.kind === "unknown") {
			return { kind: "unknown", problem: root?.problem ?? problem("native-root-missing", "네이티브 루트 패치를 복사하지 못했습니다") };
		}
		return root.value.bytes > 0
			? { kind: "root-only", basis: "native-success-registry", root: root.value }
			: { kind: "confirmed-empty", basis: "native-success-registry", root: root.value };
	}

	#recovery(tracked: TrackedCapture, late = false): RecoveryFacts {
		const sync = late ? (tracked.lateSync ?? tracked.sync) : tracked.sync;
		const registry = tracked.registry;
		const parts = late ? tracked.lateParts : undefined;
		const rootPath = parts !== undefined ? parts.rootPath : (sync?.rootPath ?? registry?.patchPath);
		const rootCopy = parts !== undefined ? parts.rootCopy : tracked.rootCopy;
		let root: IntegrationRead<PartRef>;
		if (rootPath === undefined) {
			root = unknown("native-root-missing", "네이티브 루트 패치 경로가 없습니다");
		} else {
			root = known({
				nativePath: rootPath,
				copy: rootCopy ?? unknown("patch-not-copied", "루트 패치를 복사하지 않았습니다"),
			});
		}
		let nested: IntegrationRead<readonly NestedPartRef[]>;
		if (parts !== undefined && parts.nestedCopy !== undefined) {
			nested = parts.nestedCopy;
		} else if (tracked.nestedCopy !== undefined) {
			nested = tracked.nestedCopy;
		} else if (sync?.nestedList === "explicit") {
			nested = known([]);
		} else if (registry?.nestedList === "explicit") {
			nested = known([]);
		} else if (registry?.nestedList === "invalid") {
			nested = unknown("nested-list-invalid", "네이티브 중첩 패치 경로가 안전하지 않습니다");
		} else {
			nested = unknown("native-nested-missing", "네이티브 중첩 패치 목록이 없습니다");
		}
		const branchName = sync?.branchName ?? registry?.branchName;
		const branch: IntegrationRead<RecoveryBranch> =
			branchName === undefined
				? unknown("branch-not-observed", "네이티브 브랜치 참조가 관측되지 않았습니다")
				: known({
						ref: branchName,
						typedBaseOid: sync?.branchBase === undefined
							? unknown("branch-base-unproved", "비동기 경로에는 타입 있는 브랜치 기반이 없습니다")
							: known(sync.branchBase),
						observedTipOid: unknown("branch-tip-not-read", "브랜치 팁은 캡처 이벤트에 타입으로 오지 않습니다"),
					});
		const checkout: CheckoutObservation =
			tracked.claim !== undefined
				? { kind: "present", checkedAt: tracked.claim.checkedAt }
				: {
						kind: "unknown",
						problem: tracked.claimProblem ?? problem("checkout-unproved", "자식 체크아웃이 확인되지 않았습니다"),
					};
		const nativeLink: IntegrationRead<string> = known(`history://${tracked.handle}`);
		return { root, nested, branch, checkout, nativeLink };
	}

	// ── late recovery ───────────────────────────────────────────────────────────────────────────────────────────

	#scheduleLate(tracked: TrackedCapture): void {
		if (tracked.lateKeys.size >= MAX_LATE_RECOVERIES) {
			this.#bump("late-capacity");
			return;
		}
		this.#schedule(tracked);
	}

	async #lateSalvage(tracked: TrackedCapture): Promise<void> {
		const manifest = tracked.manifest;
		if (manifest === undefined) return;
		const sync = tracked.lateSync ?? tracked.sync;
		const registry = tracked.registry;
		const rootPath = sync?.rootPath ?? registry?.patchPath;
		const nestedPaths =
			sync?.nestedList === "explicit"
				? sync.nestedPaths
				: registry?.nestedList === "explicit"
					? registry.nestedPaths
					: undefined;
		const sealedRootPath = manifest.recovery.root.kind === "known" ? manifest.recovery.root.value.nativePath : undefined;
		const sealedRootCopy = manifest.recovery.root.kind === "known" ? manifest.recovery.root.value.copy : undefined;
		const sealedNested =
			manifest.recovery.nested.kind === "known"
				? new Map(manifest.recovery.nested.value.map(part => [part.nativePath, part] as const))
				: new Map<string, NestedPartRef>();
		const rootChanged = rootPath !== undefined && rootPath !== sealedRootPath;
		const nestedChanged = nestedPaths !== undefined && canonicalJson(nestedPaths) !== canonicalJson([...sealedNested.keys()]);
		if (!rootChanged && !nestedChanged) return;
		const key = canonicalJson([rootPath ?? null, nestedPaths ?? null]);
		if (tracked.lateCopyKey === key) return;
		tracked.lateCopyKey = key;
		const controller = new AbortController();
		tracked.lateController?.abort();
		tracked.lateController = controller;
		const deadline = this.#now() + this.#copyMs;
		let rootCopy: IntegrationRead<StoredPatchRef> | undefined = sealedRootCopy;
		if (rootChanged && rootPath !== undefined) {
			rootCopy = await this.#artifacts.copyPatch({
				admission: tracked.admission,
				kind: "root",
				nativePath: rootPath,
				deadline,
				signal: controller.signal,
			});
			if (this.#stopped || tracked.abandoned) return;
		}
		let nestedCopy: IntegrationRead<readonly NestedPartRef[]> | undefined;
		if (nestedChanged && nestedPaths !== undefined) {
			const parts: NestedPartRef[] = [];
			for (const [index, path] of nestedPaths.slice(0, CAPTURE_MAX_PARTS).entries()) {
				const existing = sealedNested.get(path);
				if (existing !== undefined) {
					parts.push(existing);
					continue;
				}
				const copy = await this.#artifacts.copyPatch({
					admission: tracked.admission,
					kind: "nested",
					nativePath: path,
					deadline,
					signal: controller.signal,
				});
				if (this.#stopped || tracked.abandoned) return;
				parts.push({
					nativePath: path,
					copy,
					relativeRepo:
						sync?.nestedRelative[index] ??
						unknown<string>("nested-repo-unproved", "중첩 저장소 상대 경로가 타입으로 확인되지 않았습니다"),
				});
			}
			nestedCopy = known(parts);
		}
		tracked.lateParts = { rootPath, rootCopy, nestedPaths: nestedPaths ?? [], nestedCopy };
		this.#revision += 1;
	}

	async #lateObservation(tracked: TrackedCapture): Promise<void> {
		if (tracked.manifest === undefined || tracked.abandoned) return;
		if (tracked.lateKeys.size >= MAX_LATE_RECOVERIES) return;
		if (
			tracked.claim === undefined &&
			tracked.registry === undefined &&
			tracked.terminal === undefined &&
			tracked.lateSync === undefined
		) {
			return;
		}
		await this.#lateSalvage(tracked);
		if (this.#stopped || tracked.abandoned) return;
		const facts = this.#recovery(tracked, true);
		const contradiction = this.#contradiction(tracked);
		const observationKey = sha256Hex(
			canonicalJson({
				candidate: tracked.candidateId,
				registry:
					tracked.registry === undefined
						? null
						: {
								registryInstance: tracked.registry.registryInstance,
								generation: tracked.registry.generation,
								childSessionFile: tracked.registry.childSessionFile,
								patchPath: tracked.registry.patchPath,
								nestedList: tracked.registry.nestedList,
								nestedPaths: tracked.registry.nestedPaths,
								branchName: tracked.registry.branchName,
								positive: tracked.registry.positive,
							},
				sync:
					tracked.lateSync === undefined && tracked.sync === undefined
						? null
						: {
								rootPath: (tracked.lateSync ?? tracked.sync)?.rootPath ?? null,
								nestedList: (tracked.lateSync ?? tracked.sync)?.nestedList ?? null,
								nestedPaths: (tracked.lateSync ?? tracked.sync)?.nestedPaths ?? null,
								branchName: (tracked.lateSync ?? tracked.sync)?.branchName ?? null,
								branchBase: (tracked.lateSync ?? tracked.sync)?.branchBase ?? null,
							},
				claim: tracked.claim === undefined ? null : tracked.claim.entry,
				terminal: tracked.terminal === undefined ? null : terminalStatus(tracked.terminal),
				parts:
					tracked.lateParts === undefined
						? null
						: {
								rootPath: tracked.lateParts.rootPath ?? null,
								rootCopy: readKey(tracked.lateParts.rootCopy),
								nestedPaths: tracked.lateParts.nestedPaths,
								nestedCopy: readKey(tracked.lateParts.nestedCopy),
							},
				// A benign replay of the same facts and a changed-part revocation must not share a key.
				contradiction: contradiction.kind === "known" ? contradiction.value.code : null,
			}),
		);
		if (tracked.lateKeys.has(observationKey)) return;
		tracked.lateKeys.add(observationKey);
		const observation: LateRecoveryObservation = {
			schema: "storm.integration-recovery/v1",
			key: tracked.admission.key,
			candidateId: tracked.candidateId,
			observationKey,
			observedAt: this.#now(),
			facts,
			contradiction,
		};
		let sequence: IntegrationRead<number>;
		try {
			sequence = await this.#journal.appendRecovery(observation);
		} catch {
			sequence = unknown("journal-append-failed", "통합 저널에 복구 관측을 기록하지 못했습니다");
		}
		if (sequence.kind === "unknown") {
			this.#bump("late-journal-failed");
			if (!tracked.lateJournalSent) {
				tracked.lateJournalSent = true;
				this.#deliver({
					kind: "unavailable",
					key: tracked.admission.key,
					candidateId: tracked.candidateId,
					problem: sequence.problem,
				});
			}
			return;
		}
		this.#deliver({ kind: "recovery", observation, journalSequence: sequence.value });
	}

	#contradiction(tracked: TrackedCapture): IntegrationRead<IntegrationProblem> {
		const manifest = tracked.manifest;
		if (manifest === undefined) return unknown("no-contradiction", "봉인 이후 모순이 기록되지 않았습니다");
		if (tracked.terminalProblem !== undefined) return known(tracked.terminalProblem);
		if (tracked.registryProblem !== undefined && manifest.bundle.kind !== "unknown") return known(tracked.registryProblem);
		if (tracked.claimProblem !== undefined && manifest.childClaim.kind === "known") return known(tracked.claimProblem);
		if (tracked.syncProblem !== undefined) return known(tracked.syncProblem);
		const sealed = manifest.bundle;
		const current = this.#bundle(tracked);
		if (sealed.kind === "root-only" || sealed.kind === "confirmed-empty") {
			const sealedRootPath = manifest.recovery.root.kind === "known" ? manifest.recovery.root.value.nativePath : undefined;
			const lateSync = tracked.lateSync;
			if (lateSync?.rootPath !== undefined && sealedRootPath !== undefined && lateSync.rootPath !== sealedRootPath) {
				return known(problem("readiness-contradicted", "봉인 뒤 다른 루트 패치 경로가 관측되었습니다"));
			}
			if (
				lateSync?.nestedList === "explicit" &&
				manifest.recovery.nested.kind === "known" &&
				canonicalJson(lateSync.nestedPaths) !== canonicalJson(manifest.recovery.nested.value.map(part => part.nativePath))
			) {
				return known(problem("readiness-contradicted", "봉인 뒤 중첩 부품 목록이 달라졌습니다"));
			}
			if (current.kind !== sealed.kind && current.kind !== "unknown") {
				return known(problem("readiness-contradicted", "봉인된 루트 전용 캡처와 늦은 네이티브 사실이 모순됩니다"));
			}
			if (
				sealed.kind === "root-only" &&
				current.kind === "root-only" &&
				(sealed.root.sha256 !== current.root.sha256 || sealed.root.bytes !== current.root.bytes)
			) {
				return known(problem("readiness-contradicted", "봉인된 루트 패치와 늦은 캡처의 바이트가 다릅니다"));
			}
			if (tracked.registry?.branchName !== undefined && manifest.recovery.branch.kind === "unknown") {
				return known(problem("readiness-contradicted", "봉인 뒤 브랜치 캡처가 관측되었습니다"));
			}
			if (tracked.registry !== undefined && tracked.registry.nestedList === "explicit" && tracked.registry.nestedPaths.length > 0 &&
				manifest.recovery.nested.kind === "known" && manifest.recovery.nested.value.length === 0) {
				return known(problem("readiness-contradicted", "봉인 뒤 중첩 부품이 관측되었습니다"));
			}
		}
		if (manifest.terminal.kind === "known" && tracked.terminal !== undefined) {
			const before = terminalStatus(manifest.terminal.value);
			const after = terminalStatus(tracked.terminal);
			if (before !== after) return known(problem("readiness-contradicted", "봉인된 종료 상태와 늦은 종료 사실이 다릅니다"));
		}
		return unknown("no-contradiction", "봉인 이후 모순이 기록되지 않았습니다");
	}

	// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

	#checkRegistryIdentity(tracked: TrackedCapture, snapshot: RegistrySnapshotInput): IntegrationProblem | undefined {
		if (snapshot.parentSessionKey !== null && snapshot.parentSessionKey !== tracked.admission.director.sessionInstance) {
			return problem("registry-parent-instance", "레지스트리 이벤트의 부모 세션 인스턴스가 승인된 감독 세션과 다릅니다");
		}
		if (snapshot.parentId !== null && snapshot.parentId !== tracked.admission.director.parentId) {
			return problem("registry-parent-mismatch", "레지스트리 부모가 승인된 감독 세션과 다릅니다");
		}
		if (snapshot.generation !== null && (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0)) {
			return problem("registry-generation-invalid", "레지스트리 세대가 올바르지 않습니다");
		}
		const prior = tracked.registry;
		if (prior !== undefined) {
			if (prior.generation !== null && snapshot.generation !== null && snapshot.generation < prior.generation) {
				return problem("registry-generation-regressed", "레지스트리 세대가 뒤로 갔습니다");
			}
			if (prior.childSessionFile !== null && snapshot.childSessionFile !== null && prior.childSessionFile !== snapshot.childSessionFile) {
				return problem("registry-session-changed", "같은 후보에 다른 자식 세션 파일이 관측되었습니다");
			}
		}
		if (snapshot.childSessionFile !== null && snapshot.childSessionFile !== "") {
			if (!absolutePath(snapshot.childSessionFile)) return problem("registry-session-path", "자식 세션 파일 경로가 올바르지 않습니다");
		}
		if (tracked.claim !== undefined) {
			const claim = tracked.claim.entry;
			if (snapshot.registryInstance !== "" && claim.registryInstance !== snapshot.registryInstance) {
				return problem("registry-claim-mismatch", "자식 진입 주장과 레지스트리 인스턴스가 다릅니다");
			}
			if (snapshot.generation !== null && claim.generation !== snapshot.generation) {
				return problem("registry-claim-mismatch", "자식 진입 주장과 레지스트리 세대가 다릅니다");
			}
			if (snapshot.childSessionFile !== null && claim.childSessionFile.canonicalPath !== snapshot.childSessionFile) {
				return problem("registry-claim-mismatch", "자식 진입 주장과 세션 파일이 다릅니다");
			}
		}
		return undefined;
	}

	/** Deliver a proved native effect end to E once; a callback failure never rewrites capture evidence or retries. */
	#noteNativeEnded(tracked: TrackedCapture): void {
		if (tracked.nativeEnded) return;
		tracked.nativeEnded = true;
		const callback = this.#onNativeEnded;
		if (callback === undefined) return;
		try {
			const result = callback(tracked.admission);
			if (result !== undefined) void Promise.resolve(result).catch(() => this.#bump("native-ended-callback-failed"));
		} catch {
			this.#bump("native-ended-callback-failed");
		}
	}

	#bump(key: string): void {
		const current = this.#unmatched.get(key) ?? 0;
		if (current === 0 && this.#unmatched.size >= MAX_DIAGNOSTICS) return;
		this.#unmatched.set(key, Math.min(current + 1, 1_000_000));
	}

	#deliver(update: CaptureUpdate): void {
		try {
			const result = this.#publish(update);
			if (result !== undefined) void result.catch(() => undefined);
		} catch {
			// A publishing adapter must not throw into the native event handler; the journal record remains authoritative.
		}
	}
}

// ── native fact narrowing ──────────────────────────────────────────────────────────────────────────────────────

function syncTerminal(
	admission: FrozenIntegrationAdmission,
	result: SyncResultFact & { readonly aborted?: unknown },
	observedAt: number,
): IntegrationRead<BoundTerminal> {
	const aborted = result.aborted === true;
	const exitCode = typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : undefined;
	if (!aborted && exitCode === undefined) {
		return unknown("exit-code-missing", "동기 결과에 종료 코드가 없습니다");
	}
	const schema = record(result.structuredOutput) ? result.structuredOutput : undefined;
	const structured: BoundTerminal["structured"] =
		schema === undefined
			? "not-requested"
			: schema.status === "valid"
				? "valid"
				: schema.status === "invalid"
					? "invalid"
					: "unknown";
	const error = typeof result.error === "string" && result.error !== "";
	const outcome: IntegrationRead<AttemptOutcome> =
		aborted
			? known("cancel")
			: exitCode === 0 && !error && structured !== "invalid"
				? known("success")
				: known("failure");
	return known({
		observedAt,
		outcome,
		structured,
		stopCause: unknown("stop-cause-unproved", "중단 원인이 네이티브 필드로 확인되지 않았습니다"),
		cancelRequested: false,
		nativeLink: `history://${admission.item.handle}`,
		carrier: "sync",
		item: admission.item,
		exitCode: exitCode ?? -1,
		aborted,
	});
}

function syncFacts(
	result: SyncResultFact & {
		readonly isolated?: unknown;
		readonly branchName?: unknown;
		readonly branchBaseSha?: unknown;
		readonly hasRootChanges?: unknown;
		readonly nestedPatches?: unknown;
		readonly nestedPatchPaths?: unknown;
	},
): SyncFacts {
	const nestedPatchPaths = Array.isArray(result.nestedPatchPaths)
		? result.nestedPatchPaths.filter((path): path is string => typeof path === "string")
		: undefined;
	const nestedPaths = nestedPatchPaths?.map(path => absolutePath(path)).filter((path): path is string => path !== undefined) ?? [];
	const nestedList: SyncFacts["nestedList"] =
		nestedPatchPaths === undefined ? "missing" : nestedPaths.length === nestedPatchPaths.length ? "explicit" : "invalid";
	const typed = Array.isArray(result.nestedPatches)
		? result.nestedPatches.filter(record).map(item => (typeof item.relativePath === "string" && item.relativePath !== "" ? known(item.relativePath) : unknown<string>("nested-repo-unproved", "중첩 상대 경로가 없습니다")))
		: [];
	const nestedTyped: SyncFacts["nestedTyped"] = Array.isArray(result.nestedPatches) ? "explicit" : "missing";
	const nestedRelative: IntegrationRead<string>[] = [];
	for (let index = 0; index < nestedPaths.length; index += 1) {
		nestedRelative.push(typed[index] ?? unknown<string>("nested-repo-unproved", "중첩 상대 경로가 타입으로 확인되지 않았습니다"));
	}
	return {
		isolated: result.isolated === true ? true : result.isolated === false ? false : undefined,
		rootPath: absolutePath(result.patchPath),
		nestedList,
		nestedTyped,
		nestedPaths,
		nestedRelative,
		hasRootChanges:
			typeof result.hasRootChanges === "boolean" ? result.hasRootChanges : undefined,
		branchName: typeof result.branchName === "string" && result.branchName !== "" ? result.branchName : undefined,
		branchBase: typeof result.branchBaseSha === "string" && /^[0-9a-f]{40,64}$/u.test(result.branchBaseSha) ? result.branchBaseSha : undefined,
	};
}

function asyncRows(input: AsyncObservationInput): AsyncRow[] {
	const details = input.details;
	if (!Array.isArray(details) && !record(details)) return [];
	if (input.carrier === "ack") {
		if (!record(details)) return [];
		const executions = record(details.async) && Array.isArray(details.async.executions) ? details.async.executions : undefined;
		if (executions !== undefined) {
			// The additive ack names every original item's resolved job; a stock progress row is still returned below when
			// the host does not have this field, but it carries no execution and can never bind.
			return executions.map(value => {
				const proof = executionProof(value);
				return {
					type: proof === undefined ? (record(value) && typeof value.type === "string" ? value.type : undefined) : "task",
					jobId: proof?.jobId,
					agentId: proof?.agentId,
					index: proof?.itemIndex,
					status: undefined,
					execution: proof,
					structured: "unknown" as const,
				};
			});
		}
		const progress = Array.isArray(details.progress) ? details.progress.filter(record) : [];
		return progress
			.filter(row => typeof row.id === "string")
			.map(row => ({
				type: "task" as const,
				jobId: record(details.async) && typeof details.async.jobId === "string" ? details.async.jobId : undefined,
				agentId: row.id as string,
				index: typeof row.index === "number" && Number.isSafeInteger(row.index) ? row.index : undefined,
				status: undefined,
				execution: undefined,
				structured: "unknown" as const,
			}));
	}
	const rows: Record<string, unknown>[] = [];
	if (Array.isArray(details)) rows.push(...details.filter(record));
	else if (Array.isArray(details.jobs)) rows.push(...details.jobs.filter(record));
	else if (record(details.details) && Array.isArray(details.details.jobs)) rows.push(...details.details.jobs.filter(record));
	else rows.push(details);
	return rows.map(row => {
		const type = typeof row.type === "string" ? row.type : undefined;
		const proof = executionProof(row.execution);
		const jobId =
			typeof row.jobId === "string" ? row.jobId : proof !== undefined ? proof.jobId : typeof row.id === "string" ? row.id : undefined;
		// A pushed row names `agentId`; a wait row names `agentUrlId` on stock hosts and `agentId` with the additive execution
		// object. `label` is prose and never an identity.
		const agentId =
			typeof row.agentId === "string" && row.agentId !== ""
				? row.agentId
				: typeof row.agentUrlId === "string" && row.agentUrlId !== ""
					? row.agentUrlId
					: undefined;
		const status =
			row.status === "completed" || row.status === "failed" || row.status === "cancelled" || row.status === "running"
				? row.status
				: undefined;
		// Wait rows publish `structured`; pushed delivery rows publish `schema`. Parse both, and treat a conflict as a
		// failed schema verdict so a completed job can never become a positive capture from the weaker field.
		const waitSchema =
			record(row.structured) && row.structured.status === "valid"
				? "valid"
				: record(row.structured) && row.structured.status === "invalid"
					? "invalid"
					: undefined;
		const pushSchema =
			record(row.schema) && row.schema.status === "valid"
				? "valid"
				: record(row.schema) && row.schema.status === "invalid"
					? "invalid"
					: undefined;
		const structured: AsyncRow["structured"] =
			waitSchema === undefined
				? (pushSchema ?? "unknown")
				: pushSchema === undefined
					? waitSchema
					: waitSchema === pushSchema
						? waitSchema
						: "invalid";
		return {
			type,
			jobId,
			agentId,
			index: undefined,
			status,
			execution: proof,
			structured,
		};
	});
}

function jobExecution(tracked: TrackedCapture, jobId: string, executionToken: string): string {
	const director = tracked.admission.director;
	return sha256Hex(
		canonicalJson([
			"storm.integration-job/v2",
			director.sessionId,
			director.sessionInstance,
			director.sessionDir,
			director.parentId,
			tracked.toolCallId,
			tracked.itemIndex,
			tracked.handle,
			jobId,
			executionToken,
		]),
	);
}

/** The part-bearing subset of sync facts; a late envelope may change only these. */
function syncParts(facts: SyncFacts): unknown {
	return {
		rootPath: facts.rootPath ?? null,
		nestedList: facts.nestedList,
		nestedPaths: facts.nestedPaths,
		nestedRelative: facts.nestedRelative,
		branchName: facts.branchName ?? null,
		branchBase: facts.branchBase ?? null,
	};
}

function readKey(read: IntegrationRead<unknown> | undefined): string | null {
	if (read === undefined) return null;
	return read.kind === "known" ? canonicalJson(read.value) : `unknown:${read.problem.code}`;
}

function registryMatchesClaim(registry: RegistryEvidence, claim: ChildEntryClaim): boolean {
	const entry = claim.entry;
	if (entry.registryInstance !== registry.registryInstance) return false;
	if (registry.generation !== null && entry.generation !== registry.generation) return false;
	if (registry.childSessionFile !== null && entry.childSessionFile.canonicalPath !== registry.childSessionFile) return false;
	return true;
}

function terminalStatus(terminal: BoundTerminal): string {
	if (terminal.outcome.kind === "unknown") return `unknown:${terminal.outcome.problem.code}`;
	if (terminal.carrier === "sync") {
		return `${terminal.outcome.value}:sync:${terminal.structured}:${terminal.aborted ? "aborted" : terminal.exitCode}`;
	}
	// Wait and push are two deliveries of one execution: the carrier is diagnostic, never a different terminal.
	return `${terminal.outcome.value}:async:${terminal.structured}:${terminal.status}:${terminal.job.jobId}:${terminal.job.agentId}`;
}
