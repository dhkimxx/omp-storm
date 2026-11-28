/**
 * One admitted Storm worker's write authority, persisted in the profile so a child session can enforce it after its
 * extension module is rebound on another host thread.
 *
 * The in-process authority map is fast but thread-local: a pooled child runs its own copy of this extension and never
 * sees the parent's map. The parent therefore writes one small record under `<agentDir>/storm/admissions/` before the
 * spawn returns, keyed by the host's artifact root, the spawning agent id and the child id. A child looks it up with
 * only those host-supplied facts: never cwd alone, a model reply, or a bare id. The record is a claimable, revocable
 * capability, not a second team approval: a missing or invalid record never grants anything.
 */
import { FileLock } from "@oh-my-pi/pi-natives";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, chmod, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { buildId } from "./build.ts";
import { canonicalJson, sha256Hex } from "./config/canonical.ts";
import { ADMISSION_CLOSING_ROOM, MAX_ADMISSION_BYTES, validModelSelector } from "./config/schema.ts";
import { serialized, writeJsonAtomic } from "./fsutil.ts";
import { withJosa } from "./josa.ts";
import { canonicalScope, normalizeScopePath, type LanePolicy } from "./policy/capability.ts";
import { isSpendClose, type SpendClose, type SpendCloseRead } from "./policy/spend-close.ts";
import { assertSessionStoreSafe } from "./session-scope.ts";
import { EFFORTS, type WorkerStopReason } from "./types.ts";

export const WORKER_ADMISSION_SCHEMA = "storm.worker-admission/v2";
const KEY = /^[0-9a-f]{64}$/;
const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_ID = 512;
const MAX_PATHS = 256;
const MAX_PATH = 1024;
/** The admission store's hard cap: a writer that would add one record to a full store fails closed. */
export const MAX_ADMISSION_RECORDS = 512;
const ACTIVE_TTL_MS = 7 * 24 * 60 * 60_000;
const CLOSED_TTL_MS = 24 * 60 * 60_000;
const LOCK_RETRY_MS = 10;
/** How long a conditional update waits for another copy's short critical section before refusing. */
const LOCK_WAIT_MS = 2_000;
/** Schema tags an older release wrote. Housekeeping recognizes them only to remove them after their own lifetime; never to grant. */
const OBSOLETE_ADMISSION_SCHEMAS: readonly string[] = ["storm.worker-admission/v1"];
const OBSOLETE_RUN_SCHEMAS: readonly string[] = ["storm.worker-run/v1"];

export interface WorkerAdmissionPolicy {
	kind: LanePolicy["kind"];
	/** Canonical workspace-relative scopes for `paths`; empty for every other kind. */
	paths: readonly string[];
	reason: string;
	/**
	 * A review lane approved to run commands (`bash`) as well as read. Absent in every record written before it existed,
	 * which then reads as a plain reader: the shell is refused, never granted by a missing field.
	 */
	shell?: true;
}

/** The exact authority one admitted worker may exercise on the target. */
export interface WorkerAdmissionRecord {
	schema: typeof WORKER_ADMISSION_SCHEMA;
	/** The build of Storm that wrote this record; a copy of another build never reads it. */
	build: string;
	/** sha256 of the canonical artifact root, parent id and child id. */
	key: string;
	runId: string;
	sessionId: string;
	sessionDir: string;
	repoId: string;
	targetRoot: string;
	artifactRoot: string;
	parentId: string;
	childId: string;
	lane?: string;
	/** New on every admission and follow-up; a claim is bound to exactly one attempt. */
	attempt: string;
	policy: WorkerAdmissionPolicy;
	createdAt: number;
	expiresAt: number;
	/**
	 * The key of the write reservation bound to this attempt, written only by the main session's spawn hook after
	 * `admitChecked` bound one (R7). An admission with no lane may use tools beyond reading only while this field is
	 * present and the record is open; absent keeps the read-only meaning every earlier record has.
	 */
	hold?: string;
	/** Set by the parent's run/session revocation. A closed record denies writes but still proves management. */
	revokedAt?: number;
	/** Set when the child's own settled turn ends; a follow-up admission opens a new attempt. */
	endedAt?: number;
	/**
	 * The models (and efforts) the team approves for what this worker runs as (its role's entries, plus its trial's candidate), written at
	 * admission for a worker on another thread, which can read only disk. Absent in records written before it existed, or when the parent
	 * could not name them: a worker whose run is not in its thread's memory and whose record lacks them is stopped, never let through.
	 */
	approved?: ReadonlyArray<{ selector: string; effort?: string }>;
	/**
	 * Why this attempt was stopped by the worker's own instance, written at the moment it withdrew the record's authority.
	 * A closed reason, not free text: the director writes its own sentence from it. Absent for an ordinary end.
	 */
	stop?: WorkerStop;
}

/** Why a worker stopped itself: the closed set the director turns into a sentence. */
export type { WorkerStopReason };

export interface WorkerStop {
	reason: WorkerStopReason;
	at: number;
}

const STOP_REASONS: readonly WorkerStopReason[] = ["pooled-thread", "state-not-shared"];

/** One worker's stop as the director's thread reads it: the attempt it belongs to, never an earlier one. */
export interface WorkerStopReading {
	childId: string;
	attempt: string;
	reason: WorkerStopReason;
	at: number;
}

export interface WorkerAdmissionInput {
	agentDir: string;
	artifactRoot: string | undefined;
	parentId: string;
	/** The run owner, not the immediate parent of a nested worker. */
	directorId?: string;
	childId: string;
	runId: string;
	sessionId: string;
	sessionDir: string;
	repoId: string;
	targetRoot: string;
	lane?: string;
	policy: LanePolicy;
	/** The bound reservation key behind an unplanned worker's non-read tools (see `WorkerAdmissionRecord.hold`). */
	hold?: string;
	/** See `WorkerAdmissionRecord.approved`. */
	approved?: ReadonlyArray<{ selector: string; effort?: string }>;
	/** A managed warm reentry replaces only this exact, ended, unrevoked prior attempt. */
	replaceEnded?: WorkerAdmissionRecord;
}

export type WorkerAdmissionRead =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "record"; key: string; record: WorkerAdmissionRecord };

// ── exact managed worker turn ────────────────────────────────────────────────────────────────────────────────────────────────
//
// The native host mints one immutable `ManagedWorkerTurnScope` for an isolated child's exact first turn. The shape below is a
// structural mirror of the host type; it is evidence, never authority. The owner's live router is the only place that can
// validate the token against the actual owner/actor/registry, and the native paid-attempt gate is the only place that can
// refuse a send. Storm's disk record below proves only that this exact durable worker attempt was bound to that exact
// native tuple and the physical child/session it named. A missing, replaced, revoked or expired record always refuses; there
// is no unmanaged fallback on this path.

/** Structural mirror of the host's `ManagedWorkerTurnScope` v1. */
export interface ManagedWorkerTurnScope {
	readonly revision: 1;
	readonly token: string;
	readonly guard: string;
	readonly runId: string;
	readonly admissionKey: string;
	readonly admissionAttempt: string;
	readonly ownerSessionId: string;
	readonly ownerInstanceKey: string;
	readonly parentAgentId: string;
	readonly agentId: string;
	readonly actorSessionId: string;
	readonly actorInstanceKey: string;
	readonly generation: number;
	readonly dispatchId: string;
	readonly kind: "first" | "wake";
}

export const WORKER_TURN_SCHEMA = "storm.worker-turn/v1" as const;
const TURN_TEXT_LIMIT = 512;
const TURN_TOKEN_LIMIT = 128;
const TURN_PATH_LIMIT = 1024;
const TURN_MAX_BYTES = 64 * 1024;
const TURN_DIGEST = /^[0-9a-f]{64}$/;
const TURN_DEVICE = /^[0-9]{1,32}$/;

/** One exact physical file identity from the host's entry tuple. */
export interface WorkerTurnFileIdentity {
	readonly canonicalPath: string;
	readonly device: string;
	readonly inode: string;
}

/** The physical child incarnation this durable attempt was bound to. */
export interface WorkerTurnChildIdentity {
	/** sha256 of the exact native child session id, never the id itself. */
	readonly sessionIdSha256: string;
	readonly sessionFile: WorkerTurnFileIdentity;
	readonly checkout: WorkerTurnFileIdentity;
	/** Exact child registry instance key at entry. */
	readonly registryInstance: string;
	readonly generation: number;
}

/** Cross-reference to the already-published integration admission this turn belongs to. */
export interface WorkerTurnIntegrationRef {
	readonly runId: string;
	readonly dispatch: string;
	readonly candidateId: string;
	readonly policyProofId: string;
	readonly slotOwnerToken: string;
	readonly guardBuild: string;
}

/** Host process identity the integration claim proved at entry. */
export interface WorkerTurnHostOwner {
	readonly pid: number;
	readonly processStart: number;
	readonly host: string;
}

/**
 * The immutable source of one warm wake's physical proof. A wake attempt carries no new integration admission: it keeps
 * pointing at the first attempt's admitted candidate and claim, and these digests make that exact custody checkable after
 * the first record was replaced.
 */
export interface WorkerTurnWakeSource {
	/** The first worker attempt whose admission/claim remain this actor's invariant physical source. */
	readonly sourceAttempt: string;
	/** sha256 of the canonical source `FrozenIntegrationAdmission`. */
	readonly admissionDigest: string;
	/** sha256 of the canonical source `ChildEntryClaim`. */
	readonly claimDigest: string;
	/** sha256 of the current wake record's `{policy, lane, hold, approved}` authority. */
	readonly grantDigest: string;
}

/**
 * One durable, immutable worker-turn claim. It is keyed by the exact admission key and attempt and written only while that
 * attempt is current. The record is a tombstone after end/revoke; readers still compare the exact tuple. A `wake` claim
 * names the first attempt's admission/claim as its physical source; a first-turn claim has none.
 */
export interface WorkerAdmissionTurn {
	readonly schema: typeof WORKER_TURN_SCHEMA;
	readonly build: string;
	readonly key: string;
	readonly attempt: string;
	readonly turn: ManagedWorkerTurnScope;
	readonly child: WorkerTurnChildIdentity;
	readonly integration?: WorkerTurnIntegrationRef;
	readonly wake?: WorkerTurnWakeSource;
	readonly host: WorkerTurnHostOwner;
	readonly boundAt: number;
}

export type WorkerTurnBindResult =
	| { readonly kind: "bound" | "already-bound"; readonly record: WorkerAdmissionRecord; readonly binding: WorkerAdmissionTurn }
	| { readonly kind: "refused"; readonly code: string; readonly reason: string };

/** Exact optional expectations the caller's current native context must still satisfy. */
export interface WorkerTurnExpectation {
	readonly runId?: string;
	readonly actorSessionId?: string;
	readonly actorInstanceKey?: string;
	readonly generation?: number;
	readonly dispatchId?: string;
	readonly kind?: ManagedWorkerTurnScope["kind"];
}

/** Disk proof of the exact entitlement; it is not the native owner's live authority. */
export type WorkerTurnReadResult =
	| { readonly kind: "proved"; readonly record: WorkerAdmissionRecord; readonly binding: WorkerAdmissionTurn }
	| { readonly kind: "refused"; readonly code: string; readonly reason: string };

export type WorkerTurnEndResult =
	| { readonly kind: "ended" | "already-ended"; readonly record: WorkerAdmissionRecord; readonly binding: WorkerAdmissionTurn }
	| { readonly kind: "refused"; readonly code: string; readonly reason: string };

function boundedTurnText(value: unknown, limit = TURN_TEXT_LIMIT): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= limit && !CONTROL_CHARS.test(value) ? value : undefined;
}

/** Validate and clone one native scope. Shape alone never grants anything; the native owner validates the live binding. */
export function parseWorkerTurnScope(value: unknown): ManagedWorkerTurnScope | undefined {
	if (!isRecord(value) || value.revision !== 1) return undefined;
	const token = boundedTurnText(value.token, TURN_TOKEN_LIMIT);
	const guard = boundedTurnText(value.guard);
	const runId = boundedTurnText(value.runId);
	const admissionKey = boundedTurnText(value.admissionKey);
	const admissionAttempt = boundedTurnText(value.admissionAttempt);
	const ownerSessionId = boundedTurnText(value.ownerSessionId);
	const ownerInstanceKey = boundedTurnText(value.ownerInstanceKey);
	const parentAgentId = boundedTurnText(value.parentAgentId);
	const agentId = boundedTurnText(value.agentId);
	const actorSessionId = boundedTurnText(value.actorSessionId);
	const actorInstanceKey = boundedTurnText(value.actorInstanceKey);
	const generation = typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : undefined;
	const dispatchId = boundedTurnText(value.dispatchId);
	if (token === undefined || guard === undefined || runId === undefined || admissionKey === undefined ||
		admissionAttempt === undefined || ownerSessionId === undefined || ownerInstanceKey === undefined ||
		parentAgentId === undefined || agentId === undefined || actorSessionId === undefined ||
		actorInstanceKey === undefined || generation === undefined || dispatchId === undefined ||
		(value.kind !== "first" && value.kind !== "wake")) {
		return undefined;
	}
	return Object.freeze({
		revision: 1, token, guard, runId, admissionKey, admissionAttempt, ownerSessionId, ownerInstanceKey,
		parentAgentId, agentId, actorSessionId, actorInstanceKey, generation, dispatchId, kind: value.kind,
	});
}

function parseTurnFileIdentity(value: unknown): WorkerTurnFileIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const canonicalPath = boundedTurnText(value.canonicalPath, TURN_PATH_LIMIT);
	const device = value.device;
	const inode = value.inode;
	if (canonicalPath === undefined || !path.isAbsolute(canonicalPath)) return undefined;
	if (typeof device !== "string" || !TURN_DEVICE.test(device) || typeof inode !== "string" || !TURN_DEVICE.test(inode)) return undefined;
	return Object.freeze({ canonicalPath, device, inode });
}

function parseTurnChildIdentity(value: unknown): WorkerTurnChildIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const sessionIdSha256 = value.sessionIdSha256;
	const registryInstance = boundedTurnText(value.registryInstance);
	const generation = typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : undefined;
	const sessionFile = parseTurnFileIdentity(value.sessionFile);
	const checkout = parseTurnFileIdentity(value.checkout);
	if (typeof sessionIdSha256 !== "string" || !TURN_DIGEST.test(sessionIdSha256) || registryInstance === undefined ||
		generation === undefined || sessionFile === undefined || checkout === undefined) {
		return undefined;
	}
	return Object.freeze({ sessionIdSha256, sessionFile, checkout, registryInstance, generation });
}

function parseTurnIntegrationRef(value: unknown): WorkerTurnIntegrationRef | undefined {
	if (!isRecord(value)) return undefined;
	const runId = boundedTurnText(value.runId);
	const dispatch = boundedTurnText(value.dispatch);
	const candidateId = boundedTurnText(value.candidateId);
	const policyProofId = boundedTurnText(value.policyProofId);
	const slotOwnerToken = boundedTurnText(value.slotOwnerToken);
	const guardBuild = boundedTurnText(value.guardBuild);
	if (runId === undefined || dispatch === undefined || candidateId === undefined || policyProofId === undefined ||
		slotOwnerToken === undefined || guardBuild === undefined) {
		return undefined;
	}
	return Object.freeze({ runId, dispatch, candidateId, policyProofId, slotOwnerToken, guardBuild });
}

function parseTurnHostOwner(value: unknown): WorkerTurnHostOwner | undefined {
	if (!isRecord(value)) return undefined;
	const pid = value.pid;
	const processStart = value.processStart;
	const host = boundedTurnText(value.host);
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (typeof processStart !== "number" || !Number.isSafeInteger(processStart) || processStart < 0) return undefined;
	if (host === undefined) return undefined;
	return Object.freeze({ pid, processStart, host });
}

function parseTurnWakeSource(value: unknown): WorkerTurnWakeSource | undefined {
	if (!isRecord(value)) return undefined;
	const sourceAttempt = boundedTurnText(value.sourceAttempt);
	const admissionDigest = value.admissionDigest;
	const claimDigest = value.claimDigest;
	const grantDigest = value.grantDigest;
	if (sourceAttempt === undefined || !ATTEMPT.test(sourceAttempt)) return undefined;
	if (typeof admissionDigest !== "string" || !TURN_DIGEST.test(admissionDigest) ||
		typeof claimDigest !== "string" || !TURN_DIGEST.test(claimDigest) ||
		typeof grantDigest !== "string" || !TURN_DIGEST.test(grantDigest)) {
		return undefined;
	}
	const parsed = Object.freeze({ sourceAttempt, admissionDigest, claimDigest, grantDigest });
	// A wake source is a closed record; an added field could claim more custody than these four digests prove.
	return canonicalJson(parsed) === canonicalJson(value) ? parsed : undefined;
}

function parseTurnBinding(value: unknown, key?: string, attempt?: string, token?: string): WorkerAdmissionTurn | undefined {
	if (!isRecord(value) || value.schema !== WORKER_TURN_SCHEMA) return undefined;
	if (typeof value.build !== "string" || value.build.length === 0 || value.build.length > MAX_ID) return undefined;
	const bindingKey = boundedTurnText(value.key);
	const bindingAttempt = boundedTurnText(value.attempt);
	const boundAt = value.boundAt;
	const turn = parseWorkerTurnScope(value.turn);
	// Reject unknown/extra fields in the mutable turn object: a revalidated native tuple is rebuilt from the exact fields.
	if (turn === undefined || value.turn === undefined || canonicalJson(turn) !== canonicalJson(value.turn)) return undefined;
	const child = parseTurnChildIdentity(value.child);
	const host = parseTurnHostOwner(value.host);
	const integration = value.integration === undefined ? undefined : parseTurnIntegrationRef(value.integration);
	const wake = value.wake === undefined ? undefined : parseTurnWakeSource(value.wake);
	if (bindingKey === undefined || bindingAttempt === undefined || child === undefined || host === undefined ||
		typeof boundAt !== "number" || !Number.isFinite(boundAt) || boundAt <= 0) {
		return undefined;
	}
	if (value.integration !== undefined && integration === undefined) return undefined;
	if (value.wake !== undefined && wake === undefined) return undefined;
	// A wake source belongs only to a wake turn and never names its own attempt; a first turn has no source.
	if (wake !== undefined && (turn.kind !== "wake" || wake.sourceAttempt === bindingAttempt)) return undefined;
	if (key !== undefined && bindingKey !== key) return undefined;
	if (attempt !== undefined && bindingAttempt !== attempt) return undefined;
	if (token !== undefined && turn.token !== token) return undefined;
	// The stored scope and child identity must be one internally consistent tuple; a tampered clone never reads as one attempt.
	if (sha256Hex(turn.actorSessionId) !== child.sessionIdSha256 || turn.actorInstanceKey !== child.registryInstance ||
		turn.generation !== child.generation) {
		return undefined;
	}
	return Object.freeze({
		schema: WORKER_TURN_SCHEMA,
		build: value.build,
		key: bindingKey,
		attempt: bindingAttempt,
		turn,
		child,
		...(integration === undefined ? {} : { integration }),
		...(wake === undefined ? {} : { wake }),
		host,
		boundAt,
	});
}

/** `boundAt` is the first binding's clock reading; a retry of the same exact tuple is idempotent, not a conflict. */
function sameTurnBinding(a: WorkerAdmissionTurn, b: WorkerAdmissionTurn): boolean {
	return a.schema === b.schema && a.build === b.build && a.key === b.key && a.attempt === b.attempt &&
		canonicalJson(a.turn) === canonicalJson(b.turn) && canonicalJson(a.child) === canonicalJson(b.child) &&
		canonicalJson(a.integration ?? null) === canonicalJson(b.integration ?? null) &&
		canonicalJson(a.wake ?? null) === canonicalJson(b.wake ?? null) && canonicalJson(a.host) === canonicalJson(b.host);
}

function turnFile(dir: string, key: string, attempt: string): string {
	if (!KEY.test(key) || !ATTEMPT.test(attempt)) throw new Error("자식 턴 기록의 키나 시도가 올바르지 않습니다");
	return path.join(dir, `${key}.${attempt}.turn`);
}

/** Why this exact attempt is not currently open. It never looks up a newer attempt. */
function openTurnProblem(record: WorkerAdmissionRecord, key: string, attempt: string, now: number): { code: string; reason: string } | undefined {
	if (record.build !== buildId()) return { code: "record-build", reason: "다른 빌드의 Storm이 쓴 자식 권한 기록입니다" };
	if (record.key !== key) return { code: "record-key", reason: "자식 권한 키가 다릅니다" };
	if (record.attempt !== attempt) return { code: "attempt-replaced", reason: "이 자식 작업 시도는 더 새로운 시도로 교체됐습니다" };
	if (record.revokedAt !== undefined) return { code: "revoked", reason: "이 작업의 실행 권한이 취소됐습니다" };
	if (record.endedAt !== undefined) return { code: "ended", reason: "이 작업의 실행 권한은 이번 턴에서 끝났습니다" };
	if (record.expiresAt <= now) return { code: "expired", reason: "이 작업의 실행 권한이 만료됐습니다" };
	return undefined;
}

/** Scope-to-record relations only; the caller has already checked the record's own open state. */
function turnRecordProblem(record: WorkerAdmissionRecord, turn: ManagedWorkerTurnScope, key: string, attempt: string): { code: string; reason: string } | undefined {
	if (turn.admissionKey !== key || turn.admissionAttempt !== attempt) {
		return { code: "turn-admission", reason: "네이티브 턴이 이 자식 작업 시도와 다릅니다" };
	}
	if (turn.runId !== record.runId) return { code: "run-mismatch", reason: "네이티브 턴의 실행 id가 자식 권한 기록과 다릅니다" };
	if (turn.ownerSessionId !== record.sessionId) return { code: "owner-session", reason: "네이티브 턴의 소유 세션이 자식 권한 기록과 다릅니다" };
	if (turn.parentAgentId !== record.parentId) return { code: "parent-agent", reason: "네이티브 턴의 부모 에이전트가 자식 권한 기록과 다릅니다" };
	if (turn.agentId !== record.childId) return { code: "actor-agent", reason: "네이티브 턴의 자식 에이전트가 자식 권한 기록과 다릅니다" };
	return undefined;
}

function expectationProblem(turn: ManagedWorkerTurnScope, expect: WorkerTurnExpectation | undefined): { code: string; reason: string } | undefined {
	if (expect === undefined) return undefined;
	if (expect.runId !== undefined && expect.runId !== turn.runId) return { code: "expect-run", reason: "현재 네이티브 실행 id가 결속된 턴과 다릅니다" };
	if (expect.actorSessionId !== undefined && expect.actorSessionId !== turn.actorSessionId) return { code: "expect-actor-session", reason: "현재 자식 세션 id가 결속된 턴과 다릅니다" };
	if (expect.actorInstanceKey !== undefined && expect.actorInstanceKey !== turn.actorInstanceKey) return { code: "expect-actor-instance", reason: "현재 자식 세션 인스턴스가 결속된 턴과 다릅니다" };
	if (expect.generation !== undefined && expect.generation !== turn.generation) return { code: "expect-generation", reason: "현재 자식 레지스트리 세대가 결속된 턴과 다릅니다" };
	if (expect.dispatchId !== undefined && expect.dispatchId !== turn.dispatchId) return { code: "expect-dispatch", reason: "현재 네이티브 디스패치가 결속된 턴과 다릅니다" };
	if (expect.kind !== undefined && expect.kind !== turn.kind) return { code: "expect-kind", reason: "현재 턴 종류가 결속된 턴과 다릅니다" };
	return undefined;
}

async function readTurnFile(file: string, key: string, attempt: string, token?: string): Promise<WorkerAdmissionTurn | "missing" | "invalid"> {
	const read = await readRecordFile(file, TURN_MAX_BYTES);
	if (read.kind === "missing") return "missing";
	if (read.kind !== "value") return "invalid";
	const binding = parseTurnBinding(read.value, key, attempt, token);
	return binding === undefined || binding.build !== buildId() ? "invalid" : binding;
}

async function publishTurnFile(
	file: string,
	binding: WorkerAdmissionTurn,
): Promise<"created" | "exists" | "failed"> {
	const dir = path.dirname(file);
	const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temp, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(binding, null, 2)}\n`, "utf8");
	} catch {
		return "failed";
	} finally {
		await handle?.close().catch(() => undefined);
	}
	try {
		await link(temp, file);
		await chmod(file, 0o600).catch(() => undefined);
		return "created";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
	} finally {
		await rm(temp, { force: true }).catch(() => undefined);
	}
}

/**
 * Bind one exact native first-turn tuple to the current durable worker attempt and physical child/session identity. The
 * record is re-read under its per-key lock after every caller await; a replacement, revoke, end or expiry writes nothing.
 * A second bind of the same attempt may return `already-bound` only for the byte-identical tuple.
 */
export async function bindWorkerAdmissionTurn(input: {
	agentDir: string;
	key: string;
	attempt: string;
	turn: unknown;
	child: WorkerTurnChildIdentity;
	integration?: WorkerTurnIntegrationRef;
	wake?: WorkerTurnWakeSource;
	host: WorkerTurnHostOwner;
	now?: number;
}): Promise<WorkerTurnBindResult> {
	const turn = parseWorkerTurnScope(input.turn);
	const child = parseTurnChildIdentity(input.child);
	const integration = input.integration === undefined ? undefined : parseTurnIntegrationRef(input.integration);
	const wake = input.wake === undefined ? undefined : parseTurnWakeSource(input.wake);
	const host = parseTurnHostOwner(input.host);
	if (!KEY.test(input.key) || !ATTEMPT.test(input.attempt)) return { kind: "refused", code: "identity-invalid", reason: "자식 권한 키나 시도가 올바르지 않습니다" };
	if (turn === undefined) return { kind: "refused", code: "turn-invalid", reason: "네이티브 턴의 형식이 올바르지 않습니다" };
	if (turn.admissionKey !== input.key || turn.admissionAttempt !== input.attempt) {
		return { kind: "refused", code: "turn-admission", reason: "네이티브 턴이 이 자식 작업 시도와 다릅니다" };
	}
	if (input.wake !== undefined && wake === undefined) return { kind: "refused", code: "wake-invalid", reason: "웜 웨이크의 원본 물리 증명이 올바르지 않습니다" };
	if (wake !== undefined && (turn.kind !== "wake" || wake.sourceAttempt === input.attempt)) {
		return { kind: "refused", code: "wake-turn", reason: "웜 웨이크 원본은 첫 턴이 아닌 새 웨이크 시도에만 붙습니다" };
	}
	if (child === undefined) return { kind: "refused", code: "child-invalid", reason: "물리 자식 신원이 올바르지 않습니다" };
	if (sha256Hex(turn.actorSessionId) !== child.sessionIdSha256 || turn.actorInstanceKey !== child.registryInstance ||
		turn.generation !== child.generation) {
		return { kind: "refused", code: "child-mismatch", reason: "물리 자식 신원이 네이티브 턴의 액터, 인스턴스 또는 세대와 다릅니다" };
	}
	if (host === undefined) return { kind: "refused", code: "host-invalid", reason: "자식 호스트 신원이 올바르지 않습니다" };
	if (input.integration !== undefined && integration === undefined) return { kind: "refused", code: "integration-invalid", reason: "통합 승인 참조가 올바르지 않습니다" };
	if (integration !== undefined && (integration.runId !== turn.runId || integration.guardBuild !== turn.guard)) {
		return { kind: "refused", code: "integration-mismatch", reason: "통합 승인 참조의 실행 id나 가드가 네이티브 턴과 다릅니다" };
	}
	const now = input.now ?? Date.now();
	const initial = await readWorkerAdmissionByKey(input.agentDir, input.key);
	if (initial.kind !== "record") {
		return { kind: "refused", code: initial.kind === "missing" ? "record-missing" : "record-invalid", reason: initial.kind === "missing" ? "이 자식 작업 시도의 권한 기록이 없습니다" : initial.reason };
	}
	let dir: string;
	try {
		dir = await ensureAdmissionsDir(input.agentDir, initial.record.targetRoot);
	} catch (error) {
		return { kind: "refused", code: "store-unavailable", reason: error instanceof Error ? error.message : "자식 권한 저장소를 확인하지 못했습니다" };
	}
	const binding: WorkerAdmissionTurn = Object.freeze({
		schema: WORKER_TURN_SCHEMA,
		build: buildId(),
		key: input.key,
		attempt: input.attempt,
		turn,
		child,
		...(integration === undefined ? {} : { integration }),
		...(wake === undefined ? {} : { wake }),
		host,
		boundAt: now,
	});
	const file = turnFile(dir, input.key, input.attempt);
	return withRecordLock(dir, input.key, async () => {
		const read = await readRecordFile(admissionFile(dir, input.key));
		if (read.kind !== "value" || !isAdmission(read.value)) return { kind: "refused" as const, code: "record-invalid", reason: "자식 권한 기록을 읽지 못했습니다" };
		const record = read.value;
		const open = openTurnProblem(record, input.key, input.attempt, now);
		if (open !== undefined) return { kind: "refused" as const, ...open };
		const relation = turnRecordProblem(record, turn, input.key, input.attempt);
		if (relation !== undefined) return { kind: "refused" as const, ...relation };
		const existing = await readTurnFile(file, input.key, input.attempt);
		if (existing === "invalid") return { kind: "refused" as const, code: "turn-file-invalid", reason: "기존 자식 턴 기록이 올바르지 않습니다" };
		if (existing === "missing") {
			const published = await publishTurnFile(file, binding);
			if (published === "created") return { kind: "bound" as const, record, binding };
			if (published === "failed") return { kind: "refused" as const, code: "turn-write-failed", reason: "자식 턴 기록을 저장하지 못했습니다" };
			const raced = await readTurnFile(file, input.key, input.attempt);
			if (raced === "invalid") return { kind: "refused" as const, code: "turn-file-invalid", reason: "기존 자식 턴 기록이 올바르지 않습니다" };
			if (raced === "missing") return { kind: "refused" as const, code: "turn-write-failed", reason: "자식 턴 기록을 저장하지 못했습니다" };
			return sameTurnBinding(raced, binding)
				? { kind: "already-bound" as const, record, binding: raced }
				: { kind: "refused" as const, code: "turn-conflict", reason: "이 자식 작업 시도에 다른 네이티브 턴이 이미 결속됐습니다" };
		}
		return sameTurnBinding(existing, binding)
			? { kind: "already-bound" as const, record, binding: existing }
			: { kind: "refused" as const, code: "turn-conflict", reason: "이 자식 작업 시도에 다른 네이티브 턴이 이미 결속됐습니다" };
	});
}

/** Prove only the exact attempt/token, with optional live-context expectations. Missing is a refusal, not "unmanaged". */
export async function readWorkerAdmissionTurn(input: {
	agentDir: string;
	key: string;
	attempt: string;
	turnToken: string;
	expect?: WorkerTurnExpectation;
	now?: number;
}): Promise<WorkerTurnReadResult> {
	if (!KEY.test(input.key) || !ATTEMPT.test(input.attempt) || typeof input.turnToken !== "string" ||
		input.turnToken.length === 0 || input.turnToken.length > TURN_TOKEN_LIMIT) {
		return { kind: "refused", code: "identity-invalid", reason: "자식 권한 키, 시도 또는 턴 토큰이 올바르지 않습니다" };
	}
	const read = await readWorkerAdmissionByKey(input.agentDir, input.key);
	if (read.kind !== "record") {
		return { kind: "refused", code: read.kind === "missing" ? "record-missing" : "record-invalid", reason: read.kind === "missing" ? "이 자식 작업 시도의 권한 기록이 없습니다" : read.reason };
	}
	const record = read.record;
	const now = input.now ?? Date.now();
	const open = openTurnProblem(record, input.key, input.attempt, now);
	if (open !== undefined) return { kind: "refused", ...open };
	const readBinding = await readTurnFile(turnFile(admissionsDir(input.agentDir), input.key, input.attempt), input.key, input.attempt, input.turnToken);
	if (readBinding === "missing") return { kind: "refused", code: "turn-missing", reason: "이 자식 작업 시도의 결속된 네이티브 턴이 없습니다" };
	if (readBinding === "invalid") return { kind: "refused", code: "turn-file-invalid", reason: "자식 턴 기록이 올바르지 않습니다" };
	const relation = turnRecordProblem(record, readBinding.turn, input.key, input.attempt);
	if (relation !== undefined) return { kind: "refused", ...relation };
	const expected = expectationProblem(readBinding.turn, input.expect);
	if (expected !== undefined) return { kind: "refused", ...expected };
	return { kind: "proved", record, binding: readBinding };
}

/**
 * End exactly the attempt and turn that were bound. The record CAS compares the full prior record, so a replaced attempt,
 * a revoked record, changed scope or missing turn writes nothing and never ends the newest attempt.
 */
export async function endWorkerAdmissionTurn(input: {
	agentDir: string;
	key: string;
	attempt: string;
	turnToken: string;
	childSessionId: string;
	now?: number;
}): Promise<WorkerTurnEndResult> {
	if (!KEY.test(input.key) || !ATTEMPT.test(input.attempt) || typeof input.turnToken !== "string" ||
		input.turnToken.length === 0 || input.turnToken.length > TURN_TOKEN_LIMIT) {
		return { kind: "refused", code: "identity-invalid", reason: "자식 권한 키, 시도 또는 턴 토큰이 올바르지 않습니다" };
	}
	const session = boundedTurnText(input.childSessionId);
	if (session === undefined) return { kind: "refused", code: "session-invalid", reason: "자식 세션 id가 올바르지 않습니다" };
	const read = await readWorkerAdmissionByKey(input.agentDir, input.key);
	if (read.kind !== "record") {
		return { kind: "refused", code: read.kind === "missing" ? "record-missing" : "record-invalid", reason: read.kind === "missing" ? "이 자식 작업 시도의 권한 기록이 없습니다" : read.reason };
	}
	const readBinding = await readTurnFile(turnFile(admissionsDir(input.agentDir), input.key, input.attempt), input.key, input.attempt, input.turnToken);
	if (readBinding === "missing") return { kind: "refused", code: "turn-missing", reason: "이 자식 작업 시도의 결속된 네이티브 턴이 없습니다" };
	if (readBinding === "invalid") return { kind: "refused", code: "turn-file-invalid", reason: "자식 턴 기록이 올바르지 않습니다" };
	if (readBinding.turn.actorSessionId !== session || readBinding.child.sessionIdSha256 !== sha256Hex(session)) {
		return { kind: "refused", code: "session-mismatch", reason: "이 자식 세션이 결속된 턴의 세션과 다릅니다" };
	}
	const now = input.now ?? Date.now();
	const record = read.record;
	if (record.key !== input.key || record.build !== buildId()) return { kind: "refused", code: "record-invalid", reason: "자식 권한 기록의 신원이 올바르지 않습니다" };
	if (record.attempt !== input.attempt) return { kind: "refused", code: "attempt-replaced", reason: "이 자식 작업 시도는 더 새로운 시도로 교체됐습니다" };
	if (record.revokedAt !== undefined) return { kind: "refused", code: "revoked", reason: "이 작업의 실행 권한이 취소됐습니다" };
	const relation = turnRecordProblem(record, readBinding.turn, input.key, input.attempt);
	if (relation !== undefined) return { kind: "refused", ...relation };
	if (record.endedAt !== undefined) return { kind: "already-ended", record, binding: readBinding };
	if (record.expiresAt <= now) return { kind: "refused", code: "expired", reason: "이 작업의 실행 권한이 만료됐습니다" };
	const dir = admissionsDir(input.agentDir);
	const file = admissionFile(dir, input.key);
	const changed = await mutateRecord(dir, file, input.key, current => {
		if (current.attempt !== input.attempt || current.build !== buildId()) return undefined;
		if (current.revokedAt !== undefined || current.endedAt !== undefined) return undefined;
		if (current.expiresAt <= now) return undefined;
		if (turnRecordProblem(current, readBinding.turn, input.key, input.attempt) !== undefined) return undefined;
		return { ...current, endedAt: now };
	});
	const after = await readWorkerAdmissionByKey(input.agentDir, input.key);
	if (after.kind !== "record") return { kind: "refused", code: "end-unproved", reason: "턴을 끝낸 뒤 자식 권한 기록을 다시 읽지 못했습니다" };
	if (after.record.attempt !== input.attempt) return { kind: "refused", code: "attempt-replaced", reason: "턴을 끝내는 사이 더 새로운 시도가 열렸습니다" };
	if (!changed) {
		if (after.record.endedAt !== undefined) return { kind: "already-ended", record: after.record, binding: readBinding };
		if (after.record.revokedAt !== undefined) return { kind: "refused", code: "revoked", reason: "이 작업의 실행 권한이 취소됐습니다" };
		if (after.record.expiresAt <= now) return { kind: "refused", code: "expired", reason: "이 작업의 실행 권한이 만료됐습니다" };
		return { kind: "refused", code: "end-not-applied", reason: "이 자식 작업 시도의 턴을 끝내지 못했습니다" };
	}
	return { kind: "ended", record: after.record, binding: readBinding };
}

function identity(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "" || CONTROL_CHARS.test(value) || value.length > MAX_ID) {
		throw new Error(`${withJosa(what, "이/가")} 없거나 올바르지 않습니다`);
	}
	return value;
}

function requireAbsolute(value: unknown, what: string): string {
	const raw = identity(value, what);
	if (!path.isAbsolute(raw)) throw new Error(`${withJosa(what, "은/는")} 절대 경로여야 합니다`);
	return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPolicy(value: unknown): value is WorkerAdmissionPolicy {
	if (!isRecord(value)) return false;
	if (!["read", "private", "paths", "unknown", "blocked"].includes(String(value.kind))) return false;
	if (typeof value.reason !== "string" || value.reason.length > 2_000) return false;
	if (!Array.isArray(value.paths) || value.paths.length > MAX_PATHS) return false;
	if (value.shell !== undefined && value.shell !== true) return false;
	return value.paths.every(item => typeof item === "string" && item.length <= MAX_PATH && normalizeScopePath(item) === item);
}

/** One approved model entry: `provider/id` under the same rule the team config uses, at a known effort when one is given. */
function isApprovedEntry(value: unknown): value is { selector: string; effort?: (typeof EFFORTS)[number] } {
	if (!isRecord(value) || !validModelSelector(value.selector)) return false;
	return value.effort === undefined || (typeof value.effort === "string" && EFFORTS.includes(value.effort as (typeof EFFORTS)[number]));
}

function isStop(value: unknown): value is WorkerStop {
	if (!isRecord(value)) return false;
	if (typeof value.reason !== "string" || !STOP_REASONS.includes(value.reason as WorkerStopReason)) return false;
	return typeof value.at === "number" && Number.isFinite(value.at) && value.at > 0;
}

function isAdmission(value: unknown): value is WorkerAdmissionRecord {
	if (!isRecord(value) || value.schema !== WORKER_ADMISSION_SCHEMA) return false;
	if (typeof value.build !== "string" || value.build === "" || value.build.length > MAX_ID) return false;
	if (typeof value.key !== "string" || !KEY.test(value.key)) return false;
	if (typeof value.attempt !== "string" || !ATTEMPT.test(value.attempt)) return false;
	for (const field of ["runId", "sessionId", "sessionDir", "repoId", "targetRoot", "artifactRoot", "parentId", "childId"] as const) {
		const fieldValue = value[field];
		if (typeof fieldValue !== "string" || fieldValue.trim() === "") return false;
	}
	const sessionDir = value.sessionDir;
	const targetRoot = value.targetRoot;
	const artifactRoot = value.artifactRoot;
	if (typeof sessionDir !== "string" || typeof targetRoot !== "string" || typeof artifactRoot !== "string") return false;
	if (!path.isAbsolute(sessionDir) || !path.isAbsolute(targetRoot) || !path.isAbsolute(artifactRoot)) return false;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
	if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return false;
	if (!isPolicy(value.policy)) return false;
	if (value.lane !== undefined && (typeof value.lane !== "string" || value.lane.length > MAX_ID)) return false;
	if (value.hold !== undefined && (typeof value.hold !== "string" || value.hold.trim() === "" || CONTROL_CHARS.test(value.hold) || value.hold.length > MAX_ID)) return false;
	if (value.revokedAt !== undefined && (typeof value.revokedAt !== "number" || !Number.isFinite(value.revokedAt))) return false;
	if (value.endedAt !== undefined && (typeof value.endedAt !== "number" || !Number.isFinite(value.endedAt))) return false;
	if (value.approved !== undefined) {
		if (!Array.isArray(value.approved) || !value.approved.every(isApprovedEntry)) return false;
	}
	if (value.stop !== undefined && !isStop(value.stop)) return false;
	return true;
}

/** The key only from an already canonical artifact root; the parent and child both resolve it with `realpath`. */
export function workerAdmissionKey(artifactRoot: string, parentId: string, childId: string): string {
	return sha256Hex(`${artifactRoot}\u0000${parentId}\u0000${childId}`);
}

/** The physical artifact root the host supplied, or undefined when it cannot be attested as a real directory. */
export async function canonicalWorkerArtifactRoot(value: string | undefined): Promise<string | undefined> {
	if (typeof value !== "string" || !path.isAbsolute(value) || CONTROL_CHARS.test(value)) return undefined;
	// OMP creates the session artifact directory lazily: only an ancestor may exist when the first child is admitted.
	// Resolve the deepest existing physical ancestor and append the missing ordinary components. A dangling or
	// unresolvable existing component is not proof and never silently becomes a different root.
	let current = path.resolve(value);
	const tail: string[] = [];
	for (;;) {
		try {
			const real = await realpath(current);
			const info = await stat(real).catch(() => undefined);
			if (info === undefined || !info.isDirectory()) return undefined;
			return tail.length === 0 ? real : path.join(real, ...tail.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
			if (code !== "ENOENT") return undefined;
			const exists = await lstat(current).then(
				() => true,
				(e: unknown) => {
					if ((e as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") return false;
					throw e;
				},
			);
			if (exists) return undefined;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

function admissionsDir(agentDir: string): string {
	return path.join(requireAbsolute(agentDir, "에이전트 디렉터리"), "storm", "admissions");
}

function admissionFile(dir: string, key: string): string {
	if (!KEY.test(key)) throw new Error("자식 권한 키가 올바르지 않습니다");
	return path.join(dir, `${key}.json`);
}

function claimFile(dir: string, key: string, attempt: string): string {
	if (!KEY.test(key) || !ATTEMPT.test(attempt)) throw new Error("자식 권한 시도 id가 올바르지 않습니다");
	return path.join(dir, `${key}.${attempt}.claim`);
}

/** The queue one child's persisted authority is written, stopped and revoked through, so those steps never interleave. */
export function admissionKey(runId: string, childId: string): string {
	return `admission:${runId}:${childId}`;
}

/** Create the profile-owned admission directory and prove it is neither a symlink escape nor inside the target. */
async function ensureAdmissionsDir(agentDir: string, targetRoot: string): Promise<string> {
	const dir = admissionsDir(agentDir);
	const [realAgent, realTarget] = await Promise.all([realpath(agentDir), realpath(targetRoot)]);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const realDir = await realpath(dir);
	if (realDir !== path.join(realAgent, "storm", "admissions")) {
		throw new Error("자식 권한 저장소가 프로필 밖으로 연결되어 있습니다");
	}
	if (realDir === realTarget || realDir.startsWith(realTarget + path.sep)) {
		throw new Error("자식 권한 저장소가 작업 트리 안에 있습니다");
	}
	return realDir;
}

function policyOf(policy: LanePolicy): WorkerAdmissionPolicy {
	const paths =
		policy.kind === "paths"
			? [...new Set(policy.paths.map(item => normalizeScopePath(item)).filter((item): item is string => item !== undefined))].sort()
			: [];
	if (policy.kind === "paths" && paths.length === 0) throw new Error("경로 레인의 쓰기 범위가 비어 있습니다");
	if (paths.length > MAX_PATHS || paths.some(item => item.length > MAX_PATH)) throw new Error("쓰기 범위가 너무 큽니다");
	return { kind: policy.kind, paths, reason: policy.reason.slice(0, 2_000), ...(policy.kind === "read" && policy.shell === true ? { shell: true as const } : {}) };
}

async function readRecordFile(file: string, maxBytes = MAX_ADMISSION_BYTES): Promise<{ kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "value"; value: unknown }> {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: "자식 권한 기록을 확인하지 못했습니다" };
	}
	// A symlink is not a record Storm wrote; never follow it.
	if (!info.isFile()) return { kind: "invalid", reason: "자식 권한 기록이 일반 파일이 아닙니다" };
	if (info.size > maxBytes) return { kind: "invalid", reason: "자식 권한 기록이 너무 큽니다" };
	try {
		return { kind: "value", value: JSON.parse(await readFile(file, "utf8")) };
	} catch {
		return { kind: "invalid", reason: "자식 권한 기록이 손상됐습니다" };
	}
}

/**
 * The OS owns the advisory lock until release or process exit. Never reclaim it by age: a paused writer can still
 * resume between its final comparison and rename. Stable stripes bound the number of persistent lock sidecars.
 */
async function withRecordLock<T>(dir: string, key: string, task: () => Promise<T>): Promise<T> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `.record-lock-${key.slice(0, 2)}`);
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		const lock = FileLock.tryAcquire(file);
		if (lock.acquired) {
			try {
				return await task();
			} finally {
				lock.release();
			}
		}
		if (Date.now() >= deadline) throw new Error("자식 권한 기록의 잠금을 기다리다 시간이 지났습니다");
		await Bun.sleep(LOCK_RETRY_MS);
	}
}

/**
 * Publishes `next` only if the record is still the record `expected` was read as, under the record's lock. The new
 * content is written to a temp file first, so the lock is held only for the compare and the rename. This is what makes
 * every change conditional on the attempt it was read for: a stop for attempt T can never replace T+1, whichever copy
 * or thread writes it.
 */
async function publishRecord(dir: string, file: string, key: string, expected: WorkerAdmissionRecord, next: WorkerAdmissionRecord): Promise<boolean> {
	const temp = path.join(dir, `.${key}.${randomUUID()}.tmp`);
	await writeJsonAtomic(temp, next);
	try {
		return await withRecordLock(dir, key, async () => {
			const read = await readRecordFile(file);
			if (read.kind !== "value" || !isAdmission(read.value)) return false;
			const current = read.value;
			if (current.build !== expected.build || current.attempt !== expected.attempt) return false;
			if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
			await rename(temp, file);
			await chmod(file, 0o600).catch(() => undefined);
			return true;
		});
	} finally {
		await rm(temp, { force: true }).catch(() => undefined);
	}
}

/**
 * Reads one record of this build and publishes what `change` derives from it, retrying when another copy changed the
 * record between the read and the publish. A record of another build, or a change that no longer applies, writes nothing.
 */
async function mutateRecord(
	dir: string,
	file: string,
	key: string,
	change: (record: WorkerAdmissionRecord) => WorkerAdmissionRecord | undefined,
): Promise<boolean> {
	for (let round = 0; round < 3; round++) {
		const read = await readRecordFile(file);
		if (read.kind !== "value" || !isAdmission(read.value)) return false;
		const current = read.value;
		if (current.build !== buildId()) return false;
		const next = change(current);
		if (next === undefined) return false;
		if (JSON.stringify(next) === JSON.stringify(current)) return true;
		if (await publishRecord(dir, file, key, current, next)) return true;
	}
	return false;
}

/** The same conditional publication for one run marker. */
async function mutateMarker(
	dir: string,
	file: string,
	key: string,
	change: (marker: WorkerRunMarker) => WorkerRunMarker | undefined,
): Promise<boolean> {
	for (let round = 0; round < 3; round++) {
		const read = await readRecordFile(file);
		if (read.kind !== "value" || !isRunMarker(read.value)) return false;
		const current = read.value;
		if (current.build !== buildId()) return false;
		const next = change(current);
		if (next === undefined) return false;
		if (JSON.stringify(next) === JSON.stringify(current)) return true;
		const temp = path.join(dir, `.${key}.${randomUUID()}.tmp`);
		await writeJsonAtomic(temp, next);
		try {
			const published = await withRecordLock(dir, key, async () => {
				const again = await readRecordFile(file);
				if (again.kind !== "value" || !isRunMarker(again.value)) return false;
				if (again.value.build !== current.build || again.value.key !== current.key) return false;
				if (JSON.stringify(again.value) !== JSON.stringify(current)) return false;
				await rename(temp, file);
				await chmod(file, 0o600).catch(() => undefined);
				return true;
			});
			if (published) return true;
		} finally {
			await rm(temp, { force: true }).catch(() => undefined);
		}
	}
	return false;
}

function obsoleteSchema(value: unknown, schemas: readonly string[]): boolean {
	return isRecord(value) && typeof value.schema === "string" && schemas.includes(value.schema);
}

/** Whether the record's own run marker still names a live run of this build: a live run's records are never pruned for age. */
async function runIsLive(dir: string, record: WorkerAdmissionRecord, now: number): Promise<boolean> {
	const key = runMarkerKey(record.artifactRoot, record.parentId);
	const read = await readRecordFile(path.join(runsDir(dir), `${key}.json`));
	// Only a readable marker of this build for this exact run proves the run closed. Anything else cannot prove it, and a
	// record whose run may still be live is kept rather than pruned.
	if (read.kind === "missing") return false;
	if (read.kind === "invalid" || !isRunMarker(read.value)) return true;
	const marker = read.value;
	if (marker.build !== buildId() || marker.key !== key) return true;
	if (marker.runId !== record.runId || marker.artifactRoot !== record.artifactRoot || marker.parentId !== record.parentId) return true;
	return marker.revokedAt === undefined && marker.expiresAt > now;
}

/** Removes one record under its lock if it is still this build's same attempt and `due` says so of the current one. */
async function removeRecordIf(
	dir: string,
	file: string,
	expected: WorkerAdmissionRecord,
	due: (record: WorkerAdmissionRecord, ageMs: number) => boolean | Promise<boolean>,
): Promise<boolean> {
	const key = path.basename(file, ".json");
	return withRecordLock(dir, key, async () => {
		const current = await readRecordFile(file);
		if (current.kind !== "value" || !isAdmission(current.value)) return false;
		const record = current.value;
		if (record.build !== buildId() || record.attempt !== expected.attempt || record.runId !== expected.runId) return false;
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined) return false;
		if (!(await due(record, Date.now() - info.mtimeMs))) return false;
		await rm(file, { force: true });
		return true;
	});
}

/**
 * Removes one record of an older release under the record lock, and only when it is still the same file this scan read:
 * the same modification time and still a schema of that older format. A bare removal could delete the fresh record a
 * concurrent admission wrote in its place (RF6o case 4).
 */
async function removeObsoleteRecordIf(dir: string, file: string, expectedMtimeMs: number, schemas: readonly string[]): Promise<boolean> {
	const key = path.basename(file, ".json");
	return withRecordLock(dir, key, async () => {
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined || !info.isFile() || info.mtimeMs !== expectedMtimeMs) return false;
		const read = await readRecordFile(file);
		if (read.kind !== "value" || !obsoleteSchema(read.value, schemas)) return false;
		await rm(file, { force: true });
		return true;
	});
}

/**
 * Removes one run marker under the marker's lock, only while it is still the same marker the scan read (build, key, run
 * and creation time) and `due` says so of the current one. A marker removed bare could delete the live marker its own
 * session rewrote in that instant (RF6o case 5).
 */
async function removeMarkerIf(
	dir: string,
	file: string,
	expected: WorkerRunMarker,
	due: (marker: WorkerRunMarker) => boolean,
): Promise<boolean> {
	const key = path.basename(file, ".json");
	return withRecordLock(dir, key, async () => {
		const read = await readRecordFile(file);
		if (read.kind !== "value" || !isRunMarker(read.value)) return false;
		const marker = read.value;
		if (marker.build !== expected.build || marker.key !== expected.key || marker.runId !== expected.runId) return false;
		if (marker.createdAt !== expected.createdAt) return false;
		if (!due(marker)) return false;
		await rm(file, { force: true });
		return true;
	});
}

/**
 * Housekeeping for the admission store, run only by a writer that would add a record while the store already holds the
 * cap. One listing is the whole cost of the common case (`admittedNames`), so an admission never pays for the records
 * already stored: the count comes from the directory every time, never from this process's memory, because the store is
 * shared by every session and every loaded copy of the build.
 *
 * After it returns the store has room for exactly one more record. A store that cannot make room fails the writer here,
 * at the moment it would cross the cap, instead of growing past it.
 */
async function prune(dir: string, now: number, admittedNames?: readonly string[]): Promise<void> {
	let names: readonly string[];
	if (admittedNames === undefined) {
		try {
			names = await readdir(dir);
		} catch {
			return;
		}
	} else names = admittedNames;
	let remaining = 0;
	for (const name of names) if (/^[0-9a-f]{64}\.json$/.test(name)) remaining++;
	// One record of room for the caller's own write; a store under the cap needs no scan at all.
	if (remaining < MAX_ADMISSION_RECORDS) return;
	const records: Array<{ name: string; at: number; closed: boolean; live: boolean; record: WorkerAdmissionRecord }> = [];
	for (const name of names) {
		const file = path.join(dir, name);
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) continue;
		if (/^[0-9a-f]{64}\.json$/.test(name)) {
			const read = await readRecordFile(file);
			const value = read.kind === "value" ? read.value : undefined;
			// An older release's tombstone carries no authority in this build; housekeeping may remove it once its own
			// active lifetime is over. It is never read as this build's admission.
			if (obsoleteSchema(value, OBSOLETE_ADMISSION_SCHEMAS)) {
				if (now - info.mtimeMs > ACTIVE_TTL_MS) {
					if (await removeObsoleteRecordIf(dir, file, info.mtimeMs, OBSOLETE_ADMISSION_SCHEMAS)) remaining--;
				}
				continue;
			}
			// A record of another build, or one this build cannot read, is never removed; it still occupies a place in
			// the store, so it holds against the cap and this writer fails closed if the store cannot make room.
			if (value === undefined || !isAdmission(value) || value.build !== buildId()) continue;
			const record = value;
			const closed = record.revokedAt !== undefined || record.endedAt !== undefined;
			const live = closed && (await runIsLive(dir, record, now));
			const age = now - info.mtimeMs;
			if (!live && ((closed && age > CLOSED_TTL_MS) || record.expiresAt < now)) {
				const removed = await removeRecordIf(dir, file, record, async (current, currentAge) => {
					const nowClosed = current.revokedAt !== undefined || current.endedAt !== undefined;
					if (!nowClosed && current.expiresAt >= now) return false;
					if (nowClosed && currentAge <= CLOSED_TTL_MS && current.expiresAt >= now) return false;
					return !(nowClosed && (await runIsLive(dir, current, now)));
				});
				if (removed) {
					remaining--;
					continue;
				}
			}
			records.push({ name, at: record.createdAt, closed, live, record });
			continue;
		}
		if (name.endsWith(".turn")) {
			// A turn binding lives as long as the admission it belongs to can; the 24h claim sweep must not remove it.
			if (now - info.mtimeMs > ACTIVE_TTL_MS) await rm(file, { force: true });
			continue;
		}
		if (name.endsWith(".claim") && now - info.mtimeMs > CLOSED_TTL_MS) await rm(file, { force: true });
	}
	if (remaining < MAX_ADMISSION_RECORDS) return;
	// Only a closed record of a run that is no longer live may go early: an open record is a worker's authority.
	records.sort((a, b) => (a.closed === b.closed ? a.at - b.at : a.closed ? -1 : 1));
	for (const entry of records) {
		if (remaining < MAX_ADMISSION_RECORDS) break;
		if (!entry.closed) break;
		if (entry.live) continue;
		if (await removeRecordIf(dir, path.join(dir, entry.name), entry.record, current => current.revokedAt !== undefined || current.endedAt !== undefined)) {
			remaining--;
		}
	}
	if (remaining >= MAX_ADMISSION_RECORDS) throw new Error("보관 중인 자식 권한 기록이 너무 많습니다");
}

const RUN_MARKER_SCHEMA = "storm.worker-run/v2";
const RUN_KEY = /^[0-9a-f]{64}$/;
const MAX_RUN_MARKERS = 128;

interface WorkerRunMarker {
	schema: typeof RUN_MARKER_SCHEMA;
	build: string;
	key: string;
	runId: string;
	sessionId: string;
	sessionDir: string;
	repoId: string;
	targetRoot: string;
	artifactRoot: string;
	parentId: string;
	directorId?: string;
	createdAt: number;
	expiresAt: number;
	revokedAt?: number;
}

function runMarkerKey(artifactRoot: string, parentId: string): string {
	return sha256Hex(`run\u0000${artifactRoot}\u0000${parentId}`);
}

function runsDir(dir: string): string {
	return path.join(dir, "runs");
}

function isRunMarker(value: unknown): value is WorkerRunMarker {
	if (!isRecord(value) || value.schema !== RUN_MARKER_SCHEMA) return false;
	if (typeof value.build !== "string" || value.build === "" || value.build.length > MAX_ID) return false;
	if (typeof value.key !== "string" || !RUN_KEY.test(value.key)) return false;
	for (const field of ["runId", "sessionId", "sessionDir", "repoId", "targetRoot", "artifactRoot", "parentId"] as const) {
		const fieldValue = value[field];
		if (typeof fieldValue !== "string" || fieldValue.trim() === "") return false;
	}
	if (value.directorId !== undefined && (typeof value.directorId !== "string" || value.directorId.trim() === "")) return false;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
	if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return false;
	if (value.revokedAt !== undefined && (typeof value.revokedAt !== "number" || !Number.isFinite(value.revokedAt))) return false;
	return true;
}

/** The facts a run's marker is written from: the store's admission directory and the run's already canonical identity. */
interface WorkerRunMarkerFacts {
	dir: string;
	artifactRoot: string;
	parentId: string;
	directorId: string;
	runId: string;
	sessionId: string;
	sessionDir: string;
	repoId: string;
	targetRoot: string;
	now: number;
}

/** The marker proves a managed run exists even when a particular child never received a record. */
async function writeWorkerRunMarker(input: WorkerRunMarkerFacts): Promise<void> {
	const dir = runsDir(input.dir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const real = await realpath(dir);
	if (!real.startsWith(input.dir + path.sep)) throw new Error("자식 권한 실행 표시가 프로필 밖으로 연결되어 있습니다");
	const marker: WorkerRunMarker = {
		schema: RUN_MARKER_SCHEMA,
		build: buildId(),
		key: runMarkerKey(input.artifactRoot, input.parentId),
		runId: input.runId,
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		repoId: input.repoId,
		targetRoot: input.targetRoot,
		artifactRoot: input.artifactRoot,
		parentId: input.parentId,
		directorId: input.directorId,
		createdAt: input.now,
		expiresAt: input.now + ACTIVE_TTL_MS,
	};
	const file = path.join(dir, `${marker.key}.json`);
	// The content is complete before the lock: the section only re-reads the marker and renames.
	const temp = path.join(dir, `.${marker.key}.${randomUUID()}.tmp`);
	await writeJsonAtomic(temp, marker);
	let published = false;
	try {
		await withRecordLock(dir, marker.key, async () => {
			const existing = await readRecordFile(file);
			// Another build's marker means this profile is shared with a copy whose state this build cannot read: never replace it.
			if (existing.kind === "invalid") throw new Error(`기존 관리 실행 표시를 읽을 수 없어 덮어쓰지 않았습니다: ${existing.reason}`);
			if (existing.kind === "value") {
				const value = existing.value;
				if (isRunMarker(value)) {
					if (value.build !== marker.build) throw new Error("다른 빌드의 Storm이 쓴 관리 실행 표시가 있어 덮어쓰지 않았습니다");
					// The close is not carried here: it lives in its own run-keyed receipt, which no admission rewrites. A
					// marker that still names this run is simply rewritten with its current facts.
				} else if (!obsoleteSchema(value, OBSOLETE_RUN_SCHEMAS)) {
					throw new Error("기존 관리 실행 표시의 형식이 올바르지 않아 덮어쓰지 않았습니다");
				}
			}
			await rename(temp, file);
			published = true;
		});
	} finally {
		if (!published) await rm(temp, { force: true }).catch(() => undefined);
	}
	await chmod(file, 0o600).catch(() => undefined);
	// Markers outlive their runs for a day (closed) or a week (open): the one write a run makes also keeps that store
	// bounded, so no spawn has to scan it.
	await pruneRunMarkers(input.dir, input.now);
}

/**
 * Writes this run's marker only when the tree has none this build can attest for this run. A run with a readable,
 * live marker of its own pays one read and takes no lock; a marker another writer removed, or one naming another run
 * of the same tree, is written again (under the marker's lock, by `writeWorkerRunMarker`, which also refuses a
 * foreign build's marker). This is what makes the proof exist before any child of the run can look for it without
 * making the hundredth worker wait behind the first worker's marker.
 */
async function ensureRunMarker(input: WorkerRunMarkerFacts): Promise<void> {
	const key = runMarkerKey(input.artifactRoot, input.parentId);
	const file = path.join(runsDir(input.dir), `${key}.json`);
	const read = await readRecordFile(file);
	if (read.kind === "value" && isRunMarker(read.value)) {
		const marker = read.value;
		if (
			marker.build === buildId() &&
			marker.key === key &&
			marker.runId === input.runId &&
			marker.directorId === input.directorId &&
			marker.sessionId === input.sessionId &&
			marker.targetRoot === input.targetRoot &&
			marker.revokedAt === undefined &&
			marker.expiresAt > input.now
		) {
			return;
		}
	}
	await writeWorkerRunMarker(input);
}

/** A run's marker facts as a caller outside the store knows them: the profile, the run and its captured session. */
export interface WorkerRunMarkerInput {
	agentDir: string;
	artifactRoot: string | undefined;
	parentId: string;
	runId: string;
	sessionId: string;
	sessionDir: string;
	repoId: string;
	targetRoot: string;
	now?: number;
}

/**
 * Attests a run in its tree before any worker of it exists, from the same facts its admissions are written with.
 * A run start uses it so no spawn pays for the first marker; every admission uses it too, which repairs the proof when
 * another process replaced or removed it. A failure here is a store that cannot attest the run: the caller that
 * writes an admission turns it into the spawn's refusal.
 */
export async function ensureWorkerRunMarker(input: WorkerRunMarkerInput): Promise<void> {
	const parentId = identity(input.parentId, "부모 에이전트 id");
	const runId = identity(input.runId, "실행 id");
	const sessionId = identity(input.sessionId, "세션 id");
	const repoId = identity(input.repoId, "저장소 id");
	const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
	if (artifactRoot === undefined) throw new Error("자식 산출물 루트를 확인하지 못했습니다");
	const targetRoot = await realpath(input.targetRoot);
	const sessionDir = requireAbsolute(input.sessionDir, "세션 저장소");
	await assertSessionStoreSafe(sessionDir, targetRoot);
	const sessionStat = await stat(sessionDir).catch(() => undefined);
	if (sessionStat === undefined || !sessionStat.isDirectory()) throw new Error("세션 저장소가 없습니다");
	const dir = await ensureAdmissionsDir(input.agentDir, targetRoot);
	await ensureRunMarker({ dir, artifactRoot, parentId, directorId: parentId, runId, sessionId, sessionDir, repoId, targetRoot, now: input.now ?? Date.now() });
}

async function pruneRunMarkers(dir: string, now: number): Promise<void> {
	const root = runsDir(dir);
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return;
	}
	const kept: Array<{ name: string; at: number; closed: boolean; record: WorkerRunMarker }> = [];
	for (const name of names) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const file = path.join(root, name);
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) continue;
		const read = await readRecordFile(file);
		const value = read.kind === "value" ? read.value : undefined;
		// An older release's marker is not this build's; housekeeping removes it only after its own active lifetime, and
		// only under the marker's lock after reading it again, so a live marker rewritten in that instant survives.
		if (obsoleteSchema(value, OBSOLETE_RUN_SCHEMAS)) {
			if (now - info.mtimeMs > ACTIVE_TTL_MS) await removeObsoleteRecordIf(root, file, info.mtimeMs, OBSOLETE_RUN_SCHEMAS);
			continue;
		}
		// Another build's marker, or one this build cannot read: never removed, never counted.
		if (value === undefined || !isRunMarker(value) || value.build !== buildId()) continue;
		const marker = value;
		const closed = marker.revokedAt !== undefined;
		if ((closed && now - info.mtimeMs > CLOSED_TTL_MS) || marker.expiresAt < now) {
			await removeMarkerIf(root, file, marker, current =>
				(current.revokedAt !== undefined && now - info.mtimeMs > CLOSED_TTL_MS) || current.expiresAt < now,
			);
			continue;
		}
		kept.push({ name, at: marker.createdAt, closed, record: marker });
	}
	if (kept.length <= MAX_RUN_MARKERS) return;
	kept.sort((a, b) => (a.closed === b.closed ? a.at - b.at : a.closed ? -1 : 1));
	for (const marker of kept.slice(0, kept.length - MAX_RUN_MARKERS)) {
		if (!marker.closed) break;
		// The marker may have been rewritten as live since the scan; remove only what is still the closed marker read.
		await removeMarkerIf(root, path.join(root, marker.name), marker.record, current => current.revokedAt !== undefined);
	}
}

/**
 * Proves a managed run for this exact artifact root and parent. A missing marker is unrelated native work; a marker
 * that exists (active or revoked) makes an unrecorded child fail closed instead of becoming unmanaged.
 */
async function readWorkerRunMarker(
	agentDir: string,
	artifactRoot: string,
	parentId: string,
): Promise<{ kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "record"; marker: WorkerRunMarker }> {
	const root = runsDir(admissionsDir(agentDir));
	const key = runMarkerKey(artifactRoot, parentId);
	const read = await readRecordFile(path.join(root, `${key}.json`));
	if (read.kind === "missing") return { kind: "missing" };
	if (read.kind === "invalid") return read;
	if (!isRunMarker(read.value)) return { kind: "invalid", reason: "관리 실행 표시의 형식이 올바르지 않습니다" };
	if (read.value.build !== buildId()) return { kind: "invalid", reason: "다른 빌드의 Storm이 쓴 관리 실행 표시입니다" };
	if (read.value.key !== key || read.value.artifactRoot !== artifactRoot || read.value.parentId !== parentId) {
		return { kind: "invalid", reason: "관리 실행 표시의 신원이 일치하지 않습니다" };
	}
	return { kind: "record", marker: read.value };
}

const SPEND_CLOSE_SCHEMA = "storm.worker-spend-close/v1";

/**
 * One close per owning session, target and director, not just per run id. Nested workers use their marker's director
 * rather than their immediate parent. An exclusive link publishes the close once.
 */
type SpendOwner = Pick<WorkerRunMarker, "runId" | "sessionId" | "artifactRoot" | "targetRoot"> & { directorId: string };

interface WorkerSpendCloseRecord extends SpendOwner {
	schema: typeof SPEND_CLOSE_SCHEMA;
	build: string;
	close: SpendClose;
}

function spendCloseDir(dir: string): string {
	return path.join(dir, "closes");
}

function spendCloseKey(owner: SpendOwner): string {
	return sha256Hex(JSON.stringify([owner.runId, owner.sessionId, owner.artifactRoot, owner.targetRoot, owner.directorId]));
}

function isSpendCloseRecord(value: unknown, owner: SpendOwner): value is WorkerSpendCloseRecord {
	return isRecord(value) && value.schema === SPEND_CLOSE_SCHEMA && value.build === buildId() &&
		value.runId === owner.runId && value.sessionId === owner.sessionId && value.artifactRoot === owner.artifactRoot &&
		value.targetRoot === owner.targetRoot && value.directorId === owner.directorId && isSpendClose(value.close);
}

/** One file as the cache sees it: identity and change facts, so an atomically replaced file is never served stale. */
interface FileIdentity {
	dev: number;
	ino: number;
	mtimeMs: number;
	size: number;
}

type FileProbe = { kind: "file"; id: FileIdentity } | { kind: "missing" } | { kind: "error"; reason: string };

async function probeFile(file: string): Promise<FileProbe> {
	try {
		const info = await lstat(file);
		if (!info.isFile()) return { kind: "error", reason: "예산 한도 상태를 담은 파일이 일반 파일이 아닙니다" };
		return { kind: "file", id: { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size } };
	} catch (error) {
		// Only a missing file is a fact; any other failure means the state cannot be established.
		if ((error as NodeJS.ErrnoException | null | undefined)?.code === "ENOENT") return { kind: "missing" };
		return { kind: "error", reason: "예산 한도 상태를 담은 파일을 읽지 못했습니다" };
	}
}

function identityOf(id: FileIdentity): string {
	return `${id.dev}:${id.ino}:${id.mtimeMs}:${id.size}`;
}

/** One cached close receipt, keyed by the file's device, inode, modification time and size. */
interface SpendCloseCacheEntry {
	key: string;
	read: SpendCloseRead;
}

const spendCloseCache = new Map<string, SpendCloseCacheEntry>();

/**
 * One run's receipt as this build reads it: absent, closed, or a file that exists but cannot be read as this build's
 * close. The cache is keyed by the file identity, so an atomically replaced receipt is never served stale.
 */
async function readCloseReceipt(dir: string, owner: SpendOwner): Promise<SpendCloseRead | undefined> {
	const file = path.join(spendCloseDir(dir), `${spendCloseKey(owner)}.json`);
	const probe = await probeFile(file);
	if (probe.kind === "missing") {
		spendCloseCache.delete(file);
		return undefined;
	}
	if (probe.kind === "error") return { kind: "unknown", reason: probe.reason };
	const key = identityOf(probe.id);
	const cached = spendCloseCache.get(file);
	if (cached !== undefined && cached.key === key) return cached.read;
	const read = await readRecordFile(file);
	const answer: SpendCloseRead =
		read.kind === "value" && isSpendCloseRecord(read.value, owner)
			? { kind: "closed", close: read.value.close }
			: { kind: "unknown", reason: "예산 한도 기록의 형식이나 신원이 올바르지 않습니다" };
	spendCloseCache.set(file, { key, read: answer });
	return answer;
}

/** Old close receipts cannot outlive the marker expiry: one small file per closed run of the last seven days. */
async function pruneSpendCloses(dir: string): Promise<void> {
	const now = Date.now();
	const names = await readdir(dir).catch(() => [] as string[]);
	for (const name of names) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const file = path.join(dir, name);
		const info = await lstat(file).catch(() => undefined);
		if (info !== undefined && info.isFile() && now - info.mtimeMs > ACTIVE_TTL_MS) await rm(file, { force: true }).catch(() => undefined);
	}
}

/**
 * Closes this run's spend where every worker of the run reads it. Called by the director's own instance when observed
 * spend reaches the limit. The run marker proves this caller names the run that exists; the close itself is a separate,
 * run-keyed receipt, because the marker is rewritten by every admission of the run and by a new run of the same parent.
 * Once written the receipt never changes: a later call returns ok without touching it, so no admission, revocation or
 * second close can undo a close a worker may already have read.
 */
export async function closeWorkerSpend(input: {
	agentDir: string;
	artifactRoot: string | undefined;
	parentId: string;
	runId: string;
	onExceed: SpendClose["onExceed"];
	now?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (input.onExceed !== "block-spawns" && input.onExceed !== "stop") {
		return { ok: false, reason: "사용자가 고른 예산 초과 동작을 확인하지 못해 예산 한도를 워커에게 알리지 못했습니다" };
	}
	try {
		const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
		if (artifactRoot === undefined) return { ok: false, reason: "자식 산출물 루트를 확인하지 못해 예산 한도를 워커에게 알리지 못했습니다" };
		const key = runMarkerKey(artifactRoot, input.parentId);
		const dir = admissionsDir(input.agentDir);
		const file = path.join(runsDir(dir), `${key}.json`);
		const read = await readRecordFile(file);
		if (read.kind === "missing") return { ok: false, reason: "이 실행의 관리 표시가 없어 예산 한도를 워커에게 알리지 못했습니다" };
		if (read.kind === "invalid") return { ok: false, reason: read.reason };
		if (!isRunMarker(read.value) || read.value.key !== key || read.value.artifactRoot !== artifactRoot || read.value.parentId !== input.parentId) {
			return { ok: false, reason: "관리 실행 표시의 신원이 일치하지 않아 예산 한도를 워커에게 알리지 못했습니다" };
		}
		if (read.value.build !== buildId()) return { ok: false, reason: "다른 빌드의 Storm이 쓴 관리 실행 표시라 예산 한도를 워커에게 알리지 못했습니다" };
		if (read.value.runId !== input.runId || read.value.directorId !== input.parentId) {
			return { ok: false, reason: "관리 실행 표시가 다른 실행 또는 감독을 가리켜 예산 한도를 워커에게 알리지 못했습니다" };
		}
		const { runId, sessionId, targetRoot, directorId } = read.value;
		const owner: SpendOwner = { runId, sessionId, artifactRoot, targetRoot, directorId };
		const closeKey = spendCloseKey(owner);
		const at = input.now ?? Date.now();
		const root = spendCloseDir(dir);
		await mkdir(root, { recursive: true, mode: 0o700 });
		const [real, realDir] = await Promise.all([realpath(root), realpath(dir)]);
		if (!real.startsWith(realDir + path.sep)) return { ok: false, reason: "예산 한도 기록이 프로필 밖으로 연결되어 있습니다" };
		const closeFile = path.join(real, `${closeKey}.json`);
		const existing = await readRecordFile(closeFile);
		if (existing.kind === "invalid") return { ok: false, reason: `이 실행의 예산 한도 기록을 읽을 수 없어 덮어쓰지 않았습니다: ${existing.reason}` };
		if (existing.kind === "value") {
			if (!isSpendCloseRecord(existing.value, owner)) {
				return { ok: false, reason: "이 실행의 예산 한도 기록의 형식이나 신원이 올바르지 않습니다" };
			}
			// The first close stands. A second observation of the limit, or a changed user option, never restates it.
			return { ok: true };
		}
		const record: WorkerSpendCloseRecord = { schema: SPEND_CLOSE_SCHEMA, build: buildId(), ...owner, close: { at, onExceed: input.onExceed } };
		const temp = path.join(real, `.${closeKey}.${randomUUID()}.tmp`);
		// The content is complete before the exclusive link that publishes it, so a reader never sees a partial receipt.
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
		} finally {
			await handle.close().catch(() => undefined);
		}
		try {
			// Exclusive publication: two copies that both saw no close cannot both write one, and the loser re-reads the
			// winner's fact instead of replacing it.
			await link(temp, closeFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, reason: "예산 한도 기록을 쓰지 못했습니다" };
			const raced = await readRecordFile(closeFile);
			if (raced.kind === "value" && isSpendCloseRecord(raced.value, owner)) {
				return { ok: true };
			}
			return { ok: false, reason: "예산 한도 기록이 그 사이에 바뀌어 덮어쓰지 않았습니다" };
		} finally {
			await rm(temp, { force: true }).catch(() => undefined);
		}
		await chmod(closeFile, 0o600).catch(() => undefined);
		await pruneSpendCloses(real);
		return { ok: true };
	} catch {
		return { ok: false, reason: "예산 한도를 실행 표시에 쓰지 못했습니다" };
	}
}

/**
 * What this run says about the spend limit, for a worker's guard and the check before its requests. A worker may run on
 * another host thread, so the parent marker supplies the run and director. The close receipt must match both,
 * including the native session and canonical target and artifact roots.
 *
 * A missing or unreadable marker is `unknown` for a managed worker, never `open`: the marker is written before every
 * admission, so its absence for a worker Storm admitted means the fact cannot be established, and that worker is then
 * treated as closed. An ordinary native child (no run id and no admission record) keeps the open answer, so a tree
 * without a Storm run is not fenced. `unknown` is likewise a close Storm could not read. The cache is keyed by both
 * files' device, inode, modification time and size, so an atomically replaced file is always read again.
 */
export async function readWorkerSpendClose(input: {
	agentDir: string;
	artifactRoot: string | undefined;
	parentId: string | undefined;
	/** The run named by the worker's own admission; when absent the run the parent's marker names is used. */
	runId?: string;
	/** The child's host id: a record of this build for it makes a missing marker a managed worker's unknown state. */
	childId?: string;
	/** The host identified a Storm-role definition even when it cannot supply the storage identity. */
	stormRole?: boolean;
}): Promise<SpendCloseRead> {
	const unavailable = (reason: string): SpendCloseRead =>
		input.runId !== undefined || input.stormRole === true ? { kind: "unknown", reason } : { kind: "open" };
	try {
		if (input.parentId === undefined) return unavailable("부모 에이전트 id를 확인하지 못했습니다");
		const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
		if (artifactRoot === undefined) return unavailable("자식 산출물 루트를 확인하지 못했습니다");
		const key = runMarkerKey(artifactRoot, input.parentId);
		const dir = admissionsDir(input.agentDir);
		const file = path.join(runsDir(dir), `${key}.json`);
		const markerProbe = await probeFile(file);
		if (markerProbe.kind === "missing") {
			// A managed worker cannot establish the fact: a run id of its own, or its own admission record, proves the
			// worker is Storm's, so the missing marker is treated as closed. An ordinary native child has neither and
			// keeps the ordinary answer; its writes are still fenced by the managed tree's own authority check.
			if (input.runId !== undefined || input.stormRole === true) return { kind: "unknown", reason: "관리 실행 표시가 없어 예산 한도 상태를 확인하지 못했습니다" };
			if (input.childId !== undefined) {
				const record = await readWorkerAdmission({ agentDir: input.agentDir, artifactRoot, parentId: input.parentId, childId: input.childId });
				if (record.kind !== "missing") return { kind: "unknown", reason: "관리 실행 표시가 없어 예산 한도 상태를 확인하지 못했습니다" };
			}
			return { kind: "open" };
		}
		if (markerProbe.kind === "error") return { kind: "unknown", reason: markerProbe.reason };
		const read = await readRecordFile(file);
		if (
			read.kind !== "value" ||
			!isRunMarker(read.value) ||
			read.value.build !== buildId() ||
			read.value.key !== key ||
			read.value.artifactRoot !== artifactRoot ||
			read.value.parentId !== input.parentId
		) {
			return { kind: "unknown", reason: "관리 실행 표시의 형식이나 신원이 올바르지 않습니다" };
		}
		const marker = read.value;
		if (marker.directorId === undefined) return { kind: "unknown", reason: "관리 실행 표시에서 감독의 신원을 확인하지 못했습니다" };
		// The caller's own run is the one its admission names; a marker for another run cannot answer for it.
		if (input.runId !== undefined && marker.runId !== input.runId) {
			return { kind: "unknown", reason: "관리 실행 표시가 워커의 실행과 다릅니다" };
		}
		if (input.runId === undefined && input.childId !== undefined) {
			const admission = await readWorkerAdmission({ agentDir: input.agentDir, artifactRoot, parentId: input.parentId, childId: input.childId });
			if (admission.kind === "invalid") return { kind: "unknown", reason: admission.reason };
			if (admission.kind === "record" && (admission.record.runId !== marker.runId ||
				admission.record.sessionId !== marker.sessionId || admission.record.targetRoot !== marker.targetRoot)) {
				return { kind: "unknown", reason: "관리 실행 표시가 워커의 권한 기록과 다릅니다" };
			}
		}
		return (await readCloseReceipt(dir, { ...marker, directorId: marker.directorId })) ?? { kind: "open" };
	} catch {
		return { kind: "unknown", reason: "관리 실행 표시를 읽지 못했습니다" };
	}
}

/** Whether any managed run is live in this exact artifact tree; used to fence unattributed child spawns. */
export async function activeWorkerRunInTree(agentDir: string, artifactRoot: string | undefined): Promise<boolean> {
	const root = await canonicalWorkerArtifactRoot(artifactRoot);
	if (root === undefined) return false;
	return hasActiveWorkerRun(agentDir, root, Date.now());
}

/** An active managed run in this exact artifact tree, even when the child did not report a parent id. */
async function hasActiveWorkerRun(agentDir: string, artifactRoot: string, now: number): Promise<boolean> {
	const root = runsDir(admissionsDir(agentDir));
	const names = await readdir(root).catch(() => [] as string[]);
	for (const name of names) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const read = await readRecordFile(path.join(root, name));
		if (read.kind !== "value" || !isRunMarker(read.value)) continue;
		const marker = read.value;
		if (marker.build !== buildId()) continue;
		if (marker.artifactRoot !== artifactRoot) continue;
		if (marker.revokedAt === undefined && marker.expiresAt > now) return true;
	}
	return false;
}

/**
 * Writes the parent's admission before the child executes. Every field is derived from the parent's run and the
 * host's artifact/parent/child identity; a failed write must block the spawn, never degrade into no authority.
 */
export async function persistWorkerAdmission(input: WorkerAdmissionInput): Promise<{ key: string; record: WorkerAdmissionRecord }> {
	const parentId = identity(input.parentId, "부모 에이전트 id");
	const childId = identity(input.childId, "자식 에이전트 id");
	// A hold is the reservation key behind the child's non-read tools: an empty one names nothing, so it is refused
	// before any file of this admission is written.
	const hold = input.hold === undefined ? undefined : identity(input.hold, "예약 키");
	const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
	if (artifactRoot === undefined) throw new Error("자식 산출물 루트를 확인하지 못했습니다");
	const targetRoot = await realpath(input.targetRoot);
	const sessionDir = requireAbsolute(input.sessionDir, "세션 저장소");
	await assertSessionStoreSafe(sessionDir, targetRoot);
	const sessionStat = await stat(sessionDir).catch(() => undefined);
	if (sessionStat === undefined || !sessionStat.isDirectory()) throw new Error("세션 저장소가 없습니다");
	const dir = await ensureAdmissionsDir(input.agentDir, targetRoot);
	const now = Date.now();
	// One listing is the whole per-admission cost of the store: its records are read only by the writer that would
	// cross the cap (G2). The count is never remembered in this process, because the directory is shared by every
	// session and every loaded copy of the build. The one place where a second writer can make this listing stale is a
	// store one record below its cap: that single case re-lists after the publish and withdraws this writer's own
	// record if the cap was crossed, so the store is left at or under the cap.
	const names = await readdir(dir);
	const atBoundary = names.filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length === MAX_ADMISSION_RECORDS - 1;
	await prune(dir, now, names);
	const runId = identity(input.runId, "실행 id");
	const sessionId = identity(input.sessionId, "세션 id");
	const repoId = identity(input.repoId, "저장소 id");
	const key = workerAdmissionKey(artifactRoot, parentId, childId);
	const record: WorkerAdmissionRecord = {
		schema: WORKER_ADMISSION_SCHEMA,
		build: buildId(),
		key,
		runId,
		sessionId,
		sessionDir,
		repoId,
		targetRoot,
		artifactRoot,
		parentId,
		childId,
		attempt: randomUUID(),
		policy: policyOf(input.policy),
		createdAt: now,
		expiresAt: now + ACTIVE_TTL_MS,
	};
	if (input.lane !== undefined) record.lane = identity(input.lane, "레인 이름");
	if (hold !== undefined) record.hold = hold;
	if (input.approved !== undefined) {
		if (!input.approved.every(isApprovedEntry)) throw new Error("승인된 모델 목록이 올바르지 않습니다");
		record.approved = input.approved.map(entry => ({ selector: entry.selector, ...(entry.effort === undefined ? {} : { effort: entry.effort }) }));
	}
	// The bound is the record as it is written, less room for the fields a stop, end or revoke adds later: a record that
	// fits only until it is closed would become unreadable exactly when its worker is stopped (RF6o cases 6 and 7).
	const encoded = `${JSON.stringify(record, null, 2)}\n`;
	if (Buffer.byteLength(encoded) > MAX_ADMISSION_BYTES - ADMISSION_CLOSING_ROOM) {
		throw new Error(`자식 권한 기록이 ${MAX_ADMISSION_BYTES - ADMISSION_CLOSING_ROOM}바이트를 넘습니다. 역할의 모델 목록이나 레인 경로를 줄여 다시 승인하세요`);
	}
	// The marker is written only after the record can fit: a live marker for an admission that can never be stored
	// would make every other unrecorded child of the run read as unknown. One read when the run's marker is already
	// readable and current; a write (and its lock) only when it is missing or names another run of this tree.
	if (input.replaceEnded === undefined) await ensureRunMarker({
		dir,
		artifactRoot,
		parentId,
		directorId: input.directorId === undefined ? parentId : identity(input.directorId, "메인 에이전트 id"),
		runId,
		sessionId,
		sessionDir,
		repoId,
		targetRoot,
		now,
	});
	// The content is written before the lock: the section only re-reads the record and renames, so a paused writer can
	// never hold the lock through a slow write, and its temp is ready before anyone can observe it.
	const file = admissionFile(dir, key);
	const temp = path.join(dir, `.${key}.${randomUUID()}.tmp`);
	await writeJsonAtomic(temp, record);
	let published = false;
	try {
		await withRecordLock(dir, key, async () => {
			const existing = await readRecordFile(file);
			const prior = input.replaceEnded;
			if (prior !== undefined && (prior.key !== key || prior.build !== record.build || prior.runId !== record.runId ||
				prior.endedAt === undefined || prior.revokedAt !== undefined ||
				existing.kind !== "value" || JSON.stringify(existing.value) !== JSON.stringify(prior))) {
				throw new Error("종료가 확인된 이전 자식 권한이 바뀌어 후속 작업을 열지 않았습니다");
			}
			// A record this build cannot read is not replaced: it may belong to another build sharing the profile, and a copy
			// of another build must not replace what it cannot read. A missing file, this build's own record, or an older
			// release's record are the only states a new attempt is written over.
			if (existing.kind === "invalid") throw new Error(`기존 자식 권한 기록을 읽을 수 없어 덮어쓰지 않았습니다: ${existing.reason}`);
			if (existing.kind === "value") {
				const value = existing.value;
				if (isAdmission(value)) {
					if (value.build !== record.build) throw new Error("다른 빌드의 Storm이 쓴 자식 권한 기록이 있어 덮어쓰지 않았습니다");
				} else if (!obsoleteSchema(value, OBSOLETE_ADMISSION_SCHEMAS)) {
					throw new Error("기존 자식 권한 기록의 형식이 올바르지 않아 덮어쓰지 않았습니다");
				}
			}
			await rename(temp, file);
			published = true;
		});
	} finally {
		if (!published) await rm(temp, { force: true }).catch(() => undefined);
	}
	if (!published) throw new Error("자식 권한 기록을 쓰지 못했습니다. 다시 스폰하세요");
	await chmod(file, 0o600).catch(() => undefined);
	if (atBoundary) {
		// Another writer added the same last place in this instant; only a count read after the publish can tell. This
		// writer takes its own record back rather than leave the store over its cap, and fails the spawn closed.
		const after = (await readdir(dir)).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length;
		if (after > MAX_ADMISSION_RECORDS) {
			await removeRecordIf(dir, file, record, () => true).catch(() => false);
			throw new Error("보관 중인 자식 권한 기록이 너무 많습니다");
		}
	}
	return { key, record };
}

/**
 * Read one record by its exact durable key, never by a newest-row lookup. The caller must still compare its parent/child/
 * artifact identity; this is the only lookup the managed-turn path uses.
 */
export async function readWorkerAdmissionByKey(agentDir: string, key: string): Promise<WorkerAdmissionRead> {
	if (!KEY.test(key)) return { kind: "invalid", reason: "자식 권한 키가 올바르지 않습니다" };
	let dir: string;
	try {
		dir = admissionsDir(agentDir);
	} catch {
		return { kind: "invalid", reason: "에이전트 디렉터리가 올바르지 않습니다" };
	}
	const read = await readRecordFile(admissionFile(dir, key));
	if (read.kind === "missing") return { kind: "missing" };
	if (read.kind === "invalid") return read;
	if (!isAdmission(read.value)) return { kind: "invalid", reason: "자식 권한 기록의 형식이 올바르지 않습니다" };
	const record = read.value;
	if (record.build !== buildId()) return { kind: "invalid", reason: "다른 빌드의 Storm이 쓴 자식 권한 기록입니다" };
	if (record.key !== key) return { kind: "invalid", reason: "자식 권한 기록의 신원이 일치하지 않습니다" };
	return { kind: "record", key, record };
}

/** A record for exactly this host parent/child/artifact identity; missing is unmanaged, invalid is fail-closed. */
export async function readWorkerAdmission(input: {
	agentDir: string;
	artifactRoot: string | undefined;
	parentId: string | undefined;
	childId: string;
}): Promise<WorkerAdmissionRead> {
	if (input.parentId === undefined) return { kind: "missing" };
	let parentId: string;
	let childId: string;
	try {
		parentId = identity(input.parentId, "부모 에이전트 id");
		childId = identity(input.childId, "자식 에이전트 id");
	} catch {
		return { kind: "missing" };
	}
	const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
	if (artifactRoot === undefined) return { kind: "missing" };
	const key = workerAdmissionKey(artifactRoot, parentId, childId);
	const read = await readWorkerAdmissionByKey(input.agentDir, key);
	if (read.kind !== "record") return read;
	if (read.record.parentId !== parentId || read.record.childId !== childId || read.record.artifactRoot !== artifactRoot) {
		return { kind: "invalid", reason: "자식 권한 기록의 신원이 일치하지 않습니다" };
	}
	return read;
}

/**
 * The one rule R7 asks of a worker's guard: may this admission use a tool other than reading? A planned lane's powers
 * are the lane policy's to grant or refuse. An admission with no lane gets them only from the write reservation its
 * attempt holds: `hold` is written by the main session's hook after `admitChecked` bound one, and it ends with that
 * reservation. A record without it (every record written before this field) keeps the read-only meaning; a revoked or
 * ended record grants nothing even when it still carries one.
 */
export function admissionMayUseNonReadTools(record: Pick<WorkerAdmissionRecord, "lane" | "hold" | "revokedAt" | "endedAt">): boolean {
	if (record.revokedAt !== undefined || record.endedAt !== undefined) return false;
	if (record.lane !== undefined) return true;
	return record.hold !== undefined && record.hold.trim() !== "";
}

/**
 * Binds an active record to one child native session, so a later child that reuses the same host id cannot claim the
 * previous session's authority. The claim is per attempt and published by an exclusive hard link.
 */
export async function claimWorkerAdmission(
	agentDir: string,
	key: string,
	record: WorkerAdmissionRecord,
	childSessionId: string,
	childCwd: string,
): Promise<{ ok: true; checkout: string } | { ok: false; reason: string }> {
	if (record.revokedAt !== undefined || record.endedAt !== undefined) return { ok: false, reason: "이 작업의 실행 권한이 이미 끝났습니다" };
	if (record.expiresAt <= Date.now()) return { ok: false, reason: "이 작업의 실행 권한이 만료됐습니다" };
	let session: string;
	try {
		session = identity(childSessionId, "자식 세션 id");
	} catch {
		return { ok: false, reason: "자식 세션 id를 확인하지 못해 쓰기 권한을 검증할 수 없습니다" };
	}
	const [checkout, target] = await Promise.all([physical(childCwd), physical(record.targetRoot)]);
	if (checkout === undefined || target === undefined) return { ok: false, reason: "자식 작업 트리를 확인하지 못했습니다" };
	if (record.policy.kind === "private") {
		if (checkout === target) return { ok: false, reason: "격리 워커가 통합 작업 트리에서 실행됐습니다" };
	} else if (checkout !== target) {
		return { ok: false, reason: "공유 레인 워커의 작업 트리가 승인한 대상과 다릅니다" };
	}
	const dir = admissionsDir(agentDir);
	const file = claimFile(dir, key, record.attempt);
	const claim: WorkerClaim = { schema: "storm.worker-claim/v1", session: sha256Hex(session), checkout };
	const content = JSON.stringify(claim);
	const matches = (value: unknown): boolean => {
		if (!isRecord(value) || value.schema !== "storm.worker-claim/v1") return false;
		return typeof value.session === "string" && typeof value.checkout === "string" && value.session === claim.session && value.checkout === checkout;
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		const existing = await lstat(file).catch(() => undefined);
		if (existing !== undefined) {
			if (!existing.isFile()) return { ok: false, reason: "자식 권한 서명이 일반 파일이 아닙니다" };
			let value: unknown;
			try {
				value = JSON.parse(await readFile(file, "utf8"));
			} catch {
				return { ok: false, reason: "자식 권한 서명이 손상됐습니다" };
			}
			return matches(value)
				? { ok: true, checkout }
				: { ok: false, reason: "다른 자식 세션 또는 다른 체크아웃이 이 실행 권한을 점유했습니다" };
		}
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const tmp = path.join(dir, `.${key}.${randomUUID()}.tmp`);
		try {
			const handle = await open(tmp, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
			} finally {
				await handle.close().catch(() => undefined);
			}
			await link(tmp, file);
			return { ok: true, checkout };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return { ok: false, reason: "자식 권한 서명을 저장하지 못했습니다" };
			}
		} finally {
			await rm(tmp, { force: true }).catch(() => undefined);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, LOCK_RETRY_MS);
		await promise;
	}
	return { ok: false, reason: "자식 권한 서명을 확인하지 못했습니다" };
}

interface WorkerClaim {
	schema: "storm.worker-claim/v1";
	/** sha256 of the native child session id. */
	session: string;
	/** Physical checkout this attempt was bound to. */
	checkout: string;
}

/** Parent-side revocation for one run, one session, or one exact attempt. Closed records remain as tombstones. */
export async function revokeWorkerAdmissions(
	agentDir: string,
	match: {
		runId?: string;
		sessionId?: string;
		key?: string;
		attempt?: string;
		/** One child of the run: what the end of that worker's write reservation revokes. The run marker stays. */
		childId?: string;
		/**
		 * Only a record written before this moment. The end of a reservation is observed after the fact, so a follow-up
		 * that already reopened the same child with a newer attempt must not be closed by the older worker's end.
		 */
		createdBefore?: number;
	},
	now = Date.now(),
): Promise<number> {
	const dir = admissionsDir(agentDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	let count = 0;
	for (const name of names) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const file = path.join(dir, name);
		const key = path.basename(name, ".json");
		if (await mutateRecord(dir, file, key, record => {
			if (record.build !== buildId()) return undefined;
			if (match.runId !== undefined && record.runId !== match.runId) return undefined;
			if (match.sessionId !== undefined && record.sessionId !== match.sessionId) return undefined;
			if (match.key !== undefined && record.key !== match.key) return undefined;
			if (match.attempt !== undefined && record.attempt !== match.attempt) return undefined;
			if (match.childId !== undefined && record.childId !== match.childId) return undefined;
			if (match.createdBefore !== undefined && record.createdAt >= match.createdBefore) return undefined;
			if (record.revokedAt !== undefined) return undefined;
			return { ...record, revokedAt: now };
		})) count++;
	}
	// A run marker must close too: otherwise a child that never received a record in this run would still look
	// managed while a finished run blocks it forever, or an unrecorded child would lose the managed marker. An exact
	// key/attempt/child revocation is for one child, not the run marker.
	const root = runsDir(dir);
	const forOneChild = match.key !== undefined || match.attempt !== undefined || match.childId !== undefined || match.createdBefore !== undefined;
	const markers = forOneChild ? [] : await readdir(root).catch(() => [] as string[]);
	for (const name of markers) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const file = path.join(root, name);
		const key = path.basename(name, ".json");
		const closed = await mutateMarker(root, file, key, marker => {
			if (marker.build !== buildId()) return undefined;
			if (match.runId !== undefined && marker.runId !== match.runId) return undefined;
			if (match.sessionId !== undefined && marker.sessionId !== match.sessionId) return undefined;
			if (marker.revokedAt !== undefined) return undefined;
			return { ...marker, revokedAt: now };
		});
		if (closed) count++;
	}
	return count;
}

/** The child's own settled turn closes its attempt; a follow-up admission reopens a new attempt before delivery. */
export async function endWorkerAdmission(
	agentDir: string,
	key: string,
	attempt: string,
	childSessionId: string | undefined,
	now = Date.now(),
): Promise<boolean> {
	if (childSessionId === undefined) return false;
	let session: string;
	try {
		session = identity(childSessionId, "자식 세션 id");
	} catch {
		return false;
	}
	const dir = admissionsDir(agentDir);
	const claimPath = claimFile(dir, key, attempt);
	const claim = await lstat(claimPath).catch(() => undefined);
	if (claim !== undefined) {
		if (!claim.isFile()) return false;
		try {
			const value: unknown = JSON.parse(await readFile(claimPath, "utf8"));
			// The same digest `claimWorkerAdmission` wrote: a different one here never matched, so a claimed attempt was never closed.
			if (!isRecord(value) || value.schema !== "storm.worker-claim/v1" || value.session !== sha256Hex(session)) return false;
		} catch {
			return false;
		}
	}
	const file = admissionFile(dir, key);
	return mutateRecord(dir, file, key, record => (record.attempt === attempt && record.revokedAt === undefined ? { ...record, endedAt: now } : undefined));
}

export type WorkerAdmissionCheck =
	| { kind: "unmanaged" }
	| { kind: "authorized"; record: WorkerAdmissionRecord; checkout?: string }
	| { kind: "denied"; reason: string };

async function physical(value: string): Promise<string | undefined> {
	try {
		return await realpath(value);
	} catch {
		return undefined;
	}
}

/**
 * What a child tool handler may exercise. Only the exact host artifact/parent/child identity finds a record; a record
 * that exists but fails any check is denied, never treated as unmanaged. A child's cwd is used for validation only,
 * never lookup: shared lanes must be the target tree and isolated lanes a distinct real checkout.
 */
export async function resolveWorkerAdmission(input: {
	agentDir: string;
	artifactRoot: string | undefined;
	parentId: string | undefined;
	childId: string;
	childSessionId: string | undefined;
	childCwd: string;
	now?: number;
}): Promise<WorkerAdmissionCheck> {
	const read = await readWorkerAdmission(input);
	if (read.kind === "missing") {
		// No per-child record is not automatically unrelated: a managed run in this exact artifact/parent tree makes
		// an unrecorded child fail closed instead of gaining ordinary powers.
		const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
		if (artifactRoot === undefined) return { kind: "unmanaged" };
		const now = input.now ?? Date.now();
		if (input.parentId === undefined) {
			return (await hasActiveWorkerRun(input.agentDir, artifactRoot, now))
				? { kind: "denied", reason: "관리 실행 중인 트리의 부모를 특정하지 못한 자식이라 쓰기 권한을 주지 않았습니다" }
				: { kind: "unmanaged" };
		}
		const marker = await readWorkerRunMarker(input.agentDir, artifactRoot, input.parentId);
		if (marker.kind === "invalid") return { kind: "denied", reason: marker.reason };
		if (marker.kind === "record" && marker.marker.revokedAt === undefined && marker.marker.expiresAt > (input.now ?? Date.now())) {
			return { kind: "denied", reason: "관리 실행의 승인된 레인에 속하지 않은 자식이라 쓰기 권한을 주지 않았습니다" };
		}
		// A revoked/expired marker means the managed run is over: ordinary native work in the same tree is untouched.
		// A child that actually held an admission is denied by its own record above.
		return { kind: "unmanaged" };
	}
	if (read.kind === "invalid") return { kind: "denied", reason: read.reason };
	const record = read.record;
	const now = input.now ?? Date.now();
	if (record.revokedAt !== undefined) return { kind: "denied", reason: "이 작업의 실행 권한이 끝났습니다" };
	if (record.endedAt !== undefined) return { kind: "denied", reason: "이 작업의 실행 권한은 이번 턴에서 끝났습니다" };
	if (record.expiresAt <= now) return { kind: "denied", reason: "이 작업의 실행 권한이 만료됐습니다" };
	if (input.childSessionId === undefined) return { kind: "denied", reason: "자식 세션 id를 확인하지 못해 쓰기 권한을 검증할 수 없습니다" };
	const [target, cwd, session] = await Promise.all([
		physical(record.targetRoot),
		physical(input.childCwd),
		physical(record.sessionDir),
	]);
	if (target === undefined || cwd === undefined) return { kind: "denied", reason: "실행 대상이나 자식 작업 트리를 확인하지 못했습니다" };
	if (session === undefined) return { kind: "denied", reason: "세션 저장소가 없습니다" };
	const targetStat = await stat(target).catch(() => undefined);
	if (targetStat === undefined || !targetStat.isDirectory()) return { kind: "denied", reason: "실행 대상 작업 트리가 없습니다" };
	try {
		await assertSessionStoreSafe(record.sessionDir, record.targetRoot);
	} catch {
		return { kind: "denied", reason: "세션 저장소의 위치를 안전하게 확인하지 못했습니다" };
	}
	if (record.policy.kind === "private") {
		if (cwd === target) return { kind: "denied", reason: "격리 워커가 통합 작업 트리에서 실행됐습니다" };
	} else if (cwd !== target) {
		return { kind: "denied", reason: "공유 레인 워커의 작업 트리가 승인한 대상과 다릅니다" };
	}
	if (record.policy.kind === "paths") {
		const canonical = await canonicalScope(record.targetRoot, record.policy.paths);
		if (canonical === undefined || canonical.join("\n") !== [...record.policy.paths].sort().join("\n")) {
			return { kind: "denied", reason: "레인의 쓰기 경로가 승인 당시와 달라졌습니다" };
		}
	}
	const claimed = await claimWorkerAdmission(input.agentDir, read.key, record, input.childSessionId, input.childCwd);
	if (!claimed.ok) return { kind: "denied", reason: claimed.reason };
	return { kind: "authorized", record, checkout: claimed.checkout };
}

// ── why a worker was stopped, on the worker's own record ───────────────────────────────────────────────────────────────────

/**
 * A worker's own instance can stop it where the director's memory is not shared: on the host's pooled thread (decision D5)
 * or, on the main thread, when no run of this build is in the shared state (a foreign build or lost state). It then owes
 * the director one fact: why. That reason is a closed enum written onto the admission record the parent already wrote, at
 * the attempt the worker is withdrawing, never free text and never a second file. The director reads its own run's
 * records and writes the sentence itself. A record read twice is harmless: the director's seen-attempt set keeps it once.
 */
export async function recordWorkerStop(
	agentDir: string,
	input: { key: string; runId: string; childId: string; attempt: string; reason: WorkerStopReason },
	now = Date.now(),
): Promise<boolean> {
	if (!KEY.test(input.key) || !ATTEMPT.test(input.attempt)) return false;
	if (!STOP_REASONS.includes(input.reason)) return false;
	try {
		const runId = identity(input.runId, "실행 id");
		const childId = identity(input.childId, "자식 에이전트 id");
		const dir = admissionsDir(agentDir);
		const file = admissionFile(dir, input.key);
		// The record's own attempt decides: a stop that was read while attempt T was current writes nothing once any copy
		// has opened T+1. The conditional publish is what makes that hold across loaded copies and threads.
		return await serialized(admissionKey(runId, childId), () =>
			mutateRecord(dir, file, input.key, record => {
				if (record.runId !== runId || record.childId !== childId || record.attempt !== input.attempt) return undefined;
				return { ...record, stop: { reason: input.reason, at: now }, revokedAt: record.revokedAt ?? now };
			}),
		);
	} catch {
		return false;
	}
}

/**
 * The stops this build's records of one run carry. With `childIds`, exactly those children; without, every record this
 * build wrote for the run, which is the evidence that the director admitted the child (a spawn row is not: a reused
 * worker admitted again by a follow-up has none). Each reading is tied to the record's current attempt: a follow-up that
 * opened a newer one is a different attempt, and an earlier stop is not confused with it. A missing or foreign record is
 * not a stop.
 */
export async function readWorkerStops(
	agentDir: string,
	input: { runId: string; artifactRoot: string | undefined; parentId: string | undefined; childIds?: readonly string[] },
): Promise<WorkerStopReading[]> {
	if (input.childIds !== undefined) {
		const readings = await Promise.all(
			[...new Set(input.childIds)].map(async childId => {
				const read = await readWorkerAdmission({ agentDir, artifactRoot: input.artifactRoot, parentId: input.parentId, childId });
				if (read.kind !== "record" || read.record.runId !== input.runId || read.record.stop === undefined) return undefined;
				return { childId: read.record.childId, attempt: read.record.attempt, reason: read.record.stop.reason, at: read.record.stop.at } satisfies WorkerStopReading;
			}),
		);
		return readings.filter((reading): reading is WorkerStopReading => reading !== undefined);
	}
	const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
	if (artifactRoot === undefined || input.parentId === undefined) return [];
	const dir = admissionsDir(agentDir);
	const names = await readdir(dir).catch(() => [] as string[]);
	const readings: WorkerStopReading[] = [];
	for (const name of names) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const read = await readRecordFile(path.join(dir, name));
		if (read.kind !== "value" || !isAdmission(read.value)) continue;
		const record = read.value;
		if (record.build !== buildId() || record.runId !== input.runId) continue;
		if (record.artifactRoot !== artifactRoot || record.parentId !== input.parentId) continue;
		if (record.key !== path.basename(name, ".json") || record.key !== workerAdmissionKey(artifactRoot, input.parentId, record.childId)) continue;
		if (record.stop === undefined) continue;
		readings.push({ childId: record.childId, attempt: record.attempt, reason: record.stop.reason, at: record.stop.at });
	}
	return readings.sort((a, b) => (a.childId === b.childId ? a.attempt.localeCompare(b.attempt) : a.childId.localeCompare(b.childId)));
}

/** The run a child on this thread belongs to, from its persisted admission when the thread's memory has no run for it. */
export type ChildBinding =
	| { kind: "bound"; key: string; runId: string; sessionId: string; sessionDir: string; repoId: string; root: string; artifactRoot: string; attempt: string; createdAt: number; revokedAt?: number; approved?: ReadonlyArray<{ selector: string; effort?: string }> }
	| { kind: "unmanaged" }
	| { kind: "unknown"; reason: string };

/**
 * Whom a child answers to, read from disk: its admission record names the run (and the session and the work tree), and a live run
 * marker for its parent with no record of it means a managed child whose run cannot be named, which is unknown (never unmanaged).
 * `unmanaged` only when neither exists, or the run's marker is closed: ordinary native work.
 */
export async function readChildBinding(input: { agentDir: string; artifactRoot: string | undefined; parentId: string | undefined; childId: string; now?: number }): Promise<ChildBinding> {
	const read = await readWorkerAdmission(input);
	if (read.kind === "invalid") return { kind: "unknown", reason: read.reason };
	if (read.kind === "record") {
		const { record } = read;
		return { kind: "bound", key: read.key, runId: record.runId, sessionId: record.sessionId, sessionDir: record.sessionDir, repoId: record.repoId, root: record.targetRoot, artifactRoot: record.artifactRoot, attempt: record.attempt, createdAt: record.createdAt, ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }), ...(record.approved === undefined ? {} : { approved: record.approved }) };
	}
	const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
	if (artifactRoot === undefined) return { kind: "unmanaged" };
	const now = input.now ?? Date.now();
	if (input.parentId === undefined) {
		return (await hasActiveWorkerRun(input.agentDir, artifactRoot, now)) ? { kind: "unknown", reason: "관리 실행 중인 트리의 부모를 특정하지 못한 자식입니다" } : { kind: "unmanaged" };
	}
	const marker = await readWorkerRunMarker(input.agentDir, artifactRoot, input.parentId);
	if (marker.kind === "invalid") return { kind: "unknown", reason: marker.reason };
	if (marker.kind === "record" && marker.marker.revokedAt === undefined && marker.marker.expiresAt > now) {
		return { kind: "unknown", reason: "관리 실행의 자식인데 그 워커의 승인 기록이 없습니다" };
	}
	return { kind: "unmanaged" };
}
