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

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

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

function sameHandle(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
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

interface AsyncFacts {
	bound?: {
		readonly jobId: string;
		readonly agentId: string;
		readonly execution: string;
		readonly startTime: number | undefined;
	};
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
	manifest?: SealedCaptureManifest;
	journalSequence?: number;
	settlement?: AttemptSettlement;
	settlementPublished: boolean;
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
	readonly status: "completed" | "failed" | "cancelled" | "running" | undefined;
	readonly startTime: number | undefined;
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
	readonly #tracked = new Map<IntegrationCandidateId, TrackedCapture>();
	readonly #byHandle = new Map<string, Set<IntegrationCandidateId>>();
	readonly #jobs = new Set<Promise<void>>();
	readonly #unmatched = new Map<string, number>();
	#unsubscribe: (() => void) | undefined;
	#stopped = false;

	constructor(options: IsolationCaptureOptions) {
		this.#artifacts = options.artifacts;
		this.#journal = options.journal;
		this.#publish = options.publish;
		this.#delta = options.delta;
		this.#registryFactory = options.registry;
		this.#now = options.now ?? Date.now;
		this.#missingMs = Math.max(0, options.missingEvidenceMs ?? CAPTURE_MISSING_EVIDENCE_MS);
		this.#copyMs = Math.max(1, options.copyTimeoutMs ?? this.#missingMs);
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
			tracked.registryProblem ??= identityProblem;
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
			else this.#schedule(tracked);
			return;
		}
		const prior = tracked.registry;
		if (prior !== undefined) {
			if (prior.patchPath !== undefined && patchPath !== undefined && prior.patchPath !== patchPath) {
				tracked.registryProblem ??= problem("registry-parts-changed", "같은 후보에 다른 루트 패치 경로가 관측되었습니다");
				if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
				else this.#schedule(tracked);
				return;
			}
			if (prior.nestedList === "explicit" && nestedList === "explicit" && canonicalJson(prior.nestedPaths) !== canonicalJson(nestedPaths)) {
				tracked.registryProblem ??= problem("registry-parts-changed", "같은 후보에 다른 중첩 패치 목록이 관측되었습니다");
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
		if (positive) this.#armDeadline(tracked);
		if (tracked.manifest !== undefined) {
			this.#scheduleLate(tracked);
			return;
		}
		// Sync typed facts stay authoritative for eligibility; a registry branch is a recovery fact and may change it to
		// kept-only, so a pre-seal registry event still re-evaluates the bundle.
		this.#schedule(tracked);
		this.#schedule(tracked);
	}

	observeSync(input: {
		readonly director: DirectorIdentity;
		readonly toolCallId: string;
		readonly results: readonly (SyncResultFact & {
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
			const result = results[tracked.itemIndex];
			if (!record(result) || result.id !== tracked.handle) {
				this.#bump("sync-item-unbound");
				continue;
			}
			if (results.filter(item => record(item) && item.id === tracked.handle).length !== 1) {
				this.#bump("sync-item-duplicate");
				continue;
			}
			if (tracked.sync !== undefined && tracked.manifest === undefined) continue;
			const observedAt = Number.isSafeInteger(input.observedAt) ? input.observedAt : this.#now();
			if (observedAt < tracked.admission.startedAt) {
				this.#bump("sync-stale");
				continue;
			}
			if (tracked.sync !== undefined) {
				// After the bounded disposition only the independent terminal fact is a late recovery input; the sealed
				// part list and owned bytes are never replaced by a second sync envelope. An exact replay is not new.
				const terminal = syncTerminal(tracked.admission, result, observedAt);
				if (terminal.kind === "known") {
					const before = tracked.terminal === undefined ? undefined : terminalStatus(tracked.terminal);
					const after = terminalStatus(terminal.value);
					if (before !== after) {
						if (before !== undefined) tracked.terminalProblem = problem("terminal-contradicted", "같은 승인에 다른 동기 종료 사실이 도착했습니다");
						tracked.terminal = terminal.value;
						this.#scheduleLate(tracked);
					}
				} else if (terminal.problem.code !== "exit-code-missing") {
					const before = tracked.terminalProblem?.code;
					tracked.terminalProblem = terminal.problem;
					if (before !== terminal.problem.code) this.#scheduleLate(tracked);
				}
				continue;
			}
			const terminal = syncTerminal(tracked.admission, result, observedAt);
			if (terminal.kind === "known") {
				if (tracked.terminal !== undefined && terminalStatus(tracked.terminal) !== terminalStatus(terminal.value)) {
					tracked.terminalProblem = problem("terminal-contradicted", "같은 승인에 다른 동기 종료 사실이 도착했습니다");
				}
				tracked.terminal = terminal.value;
			} else tracked.terminalProblem = terminal.problem;
			tracked.terminalAt = observedAt;
			tracked.sync = syncFacts(result);
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
		for (const row of rows) {
			if (row.type !== undefined && row.type !== "task") {
				this.#bump("async-not-task");
				continue;
			}
			if ((input.carrier === "wait" || input.carrier === "push") && row.type !== "task") {
				this.#bump("async-task-type-missing");
				continue;
			}
			if (row.agentId === undefined) {
				this.#bump("async-agent-missing");
				continue;
			}
			const candidates = [...this.#tracked.values()].filter(
				tracked =>
					!tracked.abandoned &&
					tracked.handle === row.agentId &&
					sameDirector(tracked.admission.director, input.director),
			);
			if (candidates.length === 0) {
				this.#bump("async-unbound");
				continue;
			}
			if (candidates.length > 1) {
				const claimed = candidates.filter(tracked => tracked.claim !== undefined);
				if (claimed.length !== 1) {
					this.#bump("async-ambiguous");
					continue;
				}
				candidates.splice(0, candidates.length, claimed[0] as TrackedCapture);
			}
			const tracked = candidates[0] as TrackedCapture;
			const state: AsyncFacts = tracked.async ?? {};
			tracked.async = state;
			const observedAt = Number.isSafeInteger(input.observedAt) ? input.observedAt : this.#now();
			if (observedAt < tracked.admission.startedAt) {
				this.#bump("async-stale");
				continue;
			}
			if (input.carrier === "ack") {
				const multi = rows.length > 1;
				if (state.bound === undefined && !multi && row.jobId !== undefined && row.agentId === tracked.handle) {
					state.bound = {
						jobId: row.jobId,
						agentId: row.agentId,
						execution: sha256Hex(`job\u0000${row.jobId}\u0000${row.agentId}`),
						startTime: row.startTime,
					};
				}
				this.#schedule(tracked);
				continue;
			}
			if (input.carrier === "registration") {
				const binding = bindJob(state, row, tracked, false);
				if (binding === "conflict") this.#bump("async-job-conflict");
				if (binding === "stale") this.#bump("async-job-stale");
				this.#schedule(tracked);
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
			if (tracked.manifest !== undefined && tracked.terminal !== undefined && tracked.terminal.carrier !== "sync") {
				const sealedJob = tracked.terminal.job.jobId;
				if (row.jobId !== sealedJob) {
					this.#bump("async-late-other-execution");
					continue;
				}
			}
			const binding = bindJob(state, row, tracked, true);
			if (binding === "conflict") {
				this.#bump("async-job-conflict");
				continue;
			}
			if (binding === "stale") {
				this.#bump("async-job-stale");
				continue;
			}
			if (state.bound === undefined) {
				this.#bump("async-job-unbound");
				continue;
			}
			const job: NativeJobExecution = {
				jobId: state.bound.jobId,
				type: "task",
				agentId: state.bound.agentId,
				execution: state.bound.execution,
			};
			const terminal: BoundTerminal = {
				observedAt,
				outcome: known<AttemptOutcome>(
					row.status === "cancelled"
						? "cancel"
						: row.status === "completed" && row.structured !== "invalid"
							? "success"
							: "failure",
				),
				structured: row.structured,
				stopCause: unknown("stop-cause-unproved", "중단 원인이 네이티브 필드로 확인되지 않았습니다"),
				cancelRequested: false,
				nativeLink: `history://${tracked.handle}`,
				carrier: "wait",
				job,
				status: row.status,
			};
			// Push rows carry the same terminal fields; the carrier label is diagnostic and never a separate candidate.
			const carried: BoundTerminal = input.carrier === "push"
				? { ...terminal, carrier: "push" }
				: { ...terminal, carrier: "wait" };
			const beforeStatus = tracked.terminal === undefined ? undefined : terminalStatus(tracked.terminal);
			const afterStatus = terminalStatus(carried);
			if (beforeStatus === afterStatus && tracked.manifest !== undefined) {
				// An exact replay of the same terminal delivery is not a new late observation.
				continue;
			}
			if (beforeStatus !== undefined && beforeStatus !== afterStatus) {
				tracked.terminalProblem = problem("terminal-contradicted", "같은 승인에 다른 비동기 종료 사실이 도착했습니다");
			}
			tracked.terminal = carried;
			tracked.async = state;
			this.#armDeadline(tracked);
			this.#schedule(tracked);
			if (tracked.manifest !== undefined) this.#scheduleLate(tracked);
		}
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
			tracked.claimProblem ??= problem("claim-admission-mismatch", "자식 진입 주장이 이 승인과 다릅니다");
			this.#bump("claim-admission-mismatch");
			return;
		}
		if (canonicalJson(entry) !== canonicalJson(claim.entry)) {
			tracked.claimProblem ??= problem("claim-observation-conflict", "자식 진입 관측과 주장이 다릅니다");
			this.#bump("claim-entry-mismatch");
			return;
		}
		if (tracked.claim !== undefined) {
			if (canonicalJson(tracked.claim) !== canonicalJson(claim)) {
				tracked.claimProblem ??= problem("claim-conflict", "같은 승인에 다른 자식 진입 주장이 있습니다");
				this.#bump("claim-conflict");
			}
			return;
		}
		if (tracked.registry !== undefined && !registryMatchesClaim(tracked.registry, claim)) {
			tracked.claimProblem ??= problem("claim-registry-mismatch", "자식 진입 신원이 관측된 레지스트리 세대와 다릅니다");
		}
		tracked.claim = claim;
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
		if (tracked.manifest !== undefined || tracked.abandoned) return;
		clearTimeout(tracked.deadlineTimer);
		const recovery = this.#recovery(tracked);
		const bundle = this.#bundle(tracked);
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
	}

	#bundle(tracked: TrackedCapture): EmittedBundle {
		const terminal = tracked.terminal;
		if (tracked.terminalProblem !== undefined) return { kind: "unknown", problem: tracked.terminalProblem };
		if (terminal === undefined) {
			return { kind: "unknown", problem: tracked.terminalProblem ?? problem("native-terminal-missing", "네이티브 종료 사실이 없습니다") };
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
		if (state?.bound === undefined) return { kind: "unknown", problem: problem("async-execution-unproved", "첫 실행 작업 결합이 확인되지 않았습니다") };
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

	#recovery(tracked: TrackedCapture): RecoveryFacts {
		const sync = tracked.sync;
		const registry = tracked.registry;
		const rootPath = sync?.rootPath ?? registry?.patchPath;
		let root: IntegrationRead<PartRef>;
		if (rootPath === undefined) {
			root = unknown("native-root-missing", "네이티브 루트 패치 경로가 없습니다");
		} else {
			root = known({
				nativePath: rootPath,
				copy: tracked.rootCopy ?? unknown("patch-not-copied", "루트 패치를 복사하지 않았습니다"),
			});
		}
		let nested: IntegrationRead<readonly NestedPartRef[]>;
		if (tracked.nestedCopy !== undefined) {
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

	async #lateObservation(tracked: TrackedCapture): Promise<void> {
		if (tracked.manifest === undefined || tracked.abandoned) return;
		if (tracked.lateKeys.size >= MAX_LATE_RECOVERIES) return;
		if (tracked.claim === undefined && tracked.registry === undefined && tracked.terminal === undefined) return;
		const facts = this.#recovery(tracked);
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
				claim: tracked.claim === undefined ? null : tracked.claim.entry,
				terminal: tracked.terminal === undefined ? null : terminalStatus(tracked.terminal),
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
		const sealed = manifest.bundle;
		const current = this.#bundle(tracked);
		if (sealed.kind === "root-only" || sealed.kind === "confirmed-empty") {
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
		const progress = Array.isArray(details.progress) ? details.progress.filter(record) : [];
		const jobId = record(details.async) && typeof details.async.jobId === "string" ? details.async.jobId : undefined;
		return progress
			.filter(row => typeof row.id === "string")
			.map(row => ({
				type: "task" as const,
				jobId,
				agentId: row.id as string,
				status: row.status === "pending" || row.status === "running" ? "running" : undefined,
				startTime: undefined,
				structured: "unknown" as const,
			}));
	}
	const rows: Record<string, unknown>[] = [];
	if (Array.isArray(details)) rows.push(...details.filter(record));
	else if (Array.isArray(details.jobs)) rows.push(...details.jobs.filter(record));
	else if (record(details.details) && Array.isArray(details.details.jobs)) rows.push(...details.details.jobs.filter(record));
	else rows.push(details);
	return rows
		.map(row => {
			const type = typeof row.type === "string" ? row.type : undefined;
			const jobId =
				typeof row.jobId === "string"
					? row.jobId
					: typeof row.id === "string"
						? row.id
						: undefined;
			const agentId =
				typeof row.agentId === "string"
					? row.agentId
					: typeof row.agentUrlId === "string"
						? row.agentUrlId
						: typeof row.label === "string"
							? row.label
							: undefined;
			const status =
				row.status === "completed" || row.status === "failed" || row.status === "cancelled" || row.status === "running"
					? row.status
					: undefined;
			const settledAt = typeof row.settledAtMs === "number" && Number.isFinite(row.settledAtMs) ? row.settledAtMs : undefined;
			const duration = typeof row.durationMs === "number" && Number.isFinite(row.durationMs) ? row.durationMs : undefined;
			const startTime =
				typeof row.startTime === "number" && Number.isFinite(row.startTime)
					? row.startTime
					: settledAt !== undefined && duration !== undefined
						? settledAt - duration
						: undefined;
			const schema = record(row.schema) ? row.schema : undefined;
			const structured: AsyncRow["structured"] =
				schema === undefined ? "unknown" : schema.status === "valid" ? "valid" : schema.status === "invalid" ? "invalid" : "unknown";
			return { type, jobId, agentId, status, startTime, structured };
		});
}

function bindJob(
	state: AsyncFacts,
	row: AsyncRow,
	tracked: TrackedCapture,
	authoritative: boolean,
): "bound" | "kept" | "conflict" | "stale" {
	if (row.jobId === undefined || row.agentId === undefined) return "conflict";
	if (row.agentId !== tracked.handle) return "conflict";
	if (state.bound === undefined) {
		if (row.startTime !== undefined && row.startTime < tracked.admission.startedAt) return "stale";
		state.bound = {
			jobId: row.jobId,
			agentId: row.agentId,
			execution: sha256Hex(`job\u0000${row.jobId}\u0000${row.agentId}`),
			startTime: row.startTime,
		};
		return "bound";
	}
	if (!sameHandle(state.bound.jobId, row.jobId)) return "conflict";
	if (state.bound.startTime !== undefined && row.startTime !== undefined && state.bound.startTime !== row.startTime) {
		// A reused job id names a new turn. A start before the admission is the earlier turn; a later start is a
		// different execution and cannot retroactively become this admission's terminal.
		return row.startTime < tracked.admission.startedAt ? "stale" : "conflict";
	}
	if (authoritative && state.bound.jobId !== row.jobId) {
		// The acknowledgement may carry the primary id while wait/push carries the resolved collision-suffixed id.
		state.bound = {
			jobId: row.jobId,
			agentId: row.agentId,
			execution: sha256Hex(`job\u0000${row.jobId}\u0000${row.agentId}`),
			startTime: state.bound.startTime ?? row.startTime,
		};
	}
	return "kept";
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
	if (terminal.carrier === "sync") return `${terminal.outcome.value}:sync:${terminal.aborted ? "aborted" : terminal.exitCode}`;
	return `${terminal.outcome.value}:${terminal.carrier}:${terminal.status}`;
}
