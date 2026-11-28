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
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { buildId } from "./build.ts";
import { sha256Hex } from "./config/canonical.ts";
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
const MAX_RECORDS = 512;
const ACTIVE_TTL_MS = 7 * 24 * 60 * 60_000;
const CLOSED_TTL_MS = 24 * 60 * 60_000;
const LOCK_RETRY_MS = 10;
/** How long a conditional record update waits for another copy's short critical section, and when a leftover lock is abandoned. */
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 5_000;
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
}

export type WorkerAdmissionRead =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "record"; key: string; record: WorkerAdmissionRecord };

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
 * One record's short critical section, shared by every loaded copy of this build on every thread: an exclusive create
 * under the profile. The section itself is a read and a rename, never a slow write, because the content that precedes it
 * is a temp file made outside the lock. A lock a writer left behind by dying is abandoned after `LOCK_STALE_MS`; a live
 * one is waited for only `LOCK_WAIT_MS`, then the caller fails closed.
 *
 * The lock file carries a random owner token. A writer that was paused past `LOCK_STALE_MS` lost the lock: its release
 * removes nothing, and its last check before the rename sees a token that is not its own and publishes nothing. Without
 * both checks a late writer could overwrite a record written by the lock's new owner.
 */
async function withRecordLock<T>(dir: string, key: string, task: (held: () => Promise<boolean>) => Promise<T>): Promise<T> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const lock = path.join(dir, `.${key}.lock`);
	const token = randomUUID();
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const handle = await open(lock, "wx", 0o600);
			try {
				await handle.writeFile(token, "utf8");
			} finally {
				await handle.close().catch(() => undefined);
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = await lstat(lock).catch(() => undefined);
			if (info !== undefined && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
				await rm(lock, { force: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() >= deadline) throw new Error("자식 권한 기록의 잠금을 기다리다 시간이 지났습니다");
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, LOCK_RETRY_MS);
			await promise;
		}
	}
	const held = async (): Promise<boolean> => {
		try {
			return (await readFile(lock, "utf8")) === token;
		} catch {
			return false;
		}
	};
	try {
		return await task(held);
	} finally {
		// Only the owner of the token may release the lock. A holder that was taken over must not delete the new one.
		try {
			if ((await readFile(lock, "utf8")) === token) await rm(lock, { force: true });
		} catch {
			// Already gone, or replaced: either way not this holder's to remove.
		}
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
		return await withRecordLock(dir, key, async held => {
			const read = await readRecordFile(file);
			if (read.kind !== "value" || !isAdmission(read.value)) return false;
			const current = read.value;
			if (current.build !== expected.build || current.attempt !== expected.attempt) return false;
			if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
			// The lock may have been taken over while this writer was paused past `LOCK_STALE_MS`; a holder that no
			// longer owns it publishes nothing, so a late write can never land over the new owner's record.
			if (!(await held())) return false;
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
			const published = await withRecordLock(dir, key, async held => {
				const again = await readRecordFile(file);
				if (again.kind !== "value" || !isRunMarker(again.value)) return false;
				if (again.value.build !== current.build || again.value.key !== current.key) return false;
				if (JSON.stringify(again.value) !== JSON.stringify(current)) return false;
				if (!(await held())) return false;
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

async function prune(dir: string, now: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	let active = 0;
	const records: Array<{ name: string; at: number; closed: boolean; live: boolean; record: WorkerAdmissionRecord }> = [];
	for (const name of names) {
		const file = path.join(dir, name);
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) continue;
		const isRecord = /^[0-9a-f]{64}\.json$/.test(name);
		if (isRecord) {
			const read = await readRecordFile(file);
			const value = read.kind === "value" ? read.value : undefined;
			// An older release's tombstone carries no authority in this build; housekeeping may remove it once its own
			// active lifetime is over. It is never read as this build's admission.
			if (obsoleteSchema(value, OBSOLETE_ADMISSION_SCHEMAS)) {
				if (now - info.mtimeMs > ACTIVE_TTL_MS) await removeObsoleteRecordIf(dir, file, info.mtimeMs, OBSOLETE_ADMISSION_SCHEMAS);
				continue;
			}
			// A record of another build, or one this build cannot read, is never removed and never counted here.
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
				if (removed) continue;
			}
			if (!closed) active++;
			records.push({ name, at: record.createdAt, closed, live, record });
			continue;
		}
		if (name.endsWith(".claim") && now - info.mtimeMs > CLOSED_TTL_MS) await rm(file, { force: true });
	}
	if (records.length <= MAX_RECORDS) return;
	records.sort((a, b) => (a.closed === b.closed ? a.at - b.at : a.closed ? -1 : 1));
	for (const entry of records.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
		if (!entry.closed) break;
		if (entry.live) continue;
		await removeRecordIf(dir, path.join(dir, entry.name), entry.record, current => current.revokedAt !== undefined || current.endedAt !== undefined);
	}
	if (active > MAX_RECORDS) throw new Error("보관 중인 자식 권한 기록이 너무 많습니다");
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
	createdAt: number;
	expiresAt: number;
	revokedAt?: number;
	/**
	 * The close written by the unreleased 0.29.0 build, which kept it on the marker. It is validated and read for
	 * compatibility; this build writes no close here. The close itself is the run-keyed receipt (B4).
	 */
	spendClosedAt?: SpendClose;
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
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
	if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return false;
	if (value.revokedAt !== undefined && (typeof value.revokedAt !== "number" || !Number.isFinite(value.revokedAt))) return false;
	if (value.spendClosedAt !== undefined && !isSpendClose(value.spendClosedAt)) return false;
	return true;
}

/** The marker proves a managed run exists even when a particular child never received a record. */
async function writeWorkerRunMarker(input: {
	dir: string;
	artifactRoot: string;
	parentId: string;
	runId: string;
	sessionId: string;
	sessionDir: string;
	repoId: string;
	targetRoot: string;
	now: number;
}): Promise<void> {
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
		createdAt: input.now,
		expiresAt: input.now + ACTIVE_TTL_MS,
	};
	const file = path.join(dir, `${marker.key}.json`);
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
		await writeJsonAtomic(file, marker);
	});
	await chmod(file, 0o600).catch(() => undefined);
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
 * One run's close of its spend, keyed by the run id so every descendant finds the same fact through the run named in
 * its own admission. Written once, by an exclusive link; no later write replaces or restates it (B4).
 */
interface WorkerSpendCloseRecord {
	schema: typeof SPEND_CLOSE_SCHEMA;
	build: string;
	runId: string;
	close: SpendClose;
}

function spendCloseDir(dir: string): string {
	return path.join(dir, "closes");
}

function spendCloseKey(runId: string): string {
	return sha256Hex(`closed\u0000${runId}`);
}

function isSpendCloseRecord(value: unknown): value is WorkerSpendCloseRecord {
	if (!isRecord(value) || value.schema !== SPEND_CLOSE_SCHEMA) return false;
	if (typeof value.build !== "string" || value.build === "" || value.build.length > MAX_ID) return false;
	if (typeof value.runId !== "string" || value.runId.trim() === "" || CONTROL_CHARS.test(value.runId) || value.runId.length > MAX_ID) return false;
	return isSpendClose(value.close);
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
async function readCloseReceipt(dir: string, runId: string): Promise<SpendCloseRead | undefined> {
	const file = path.join(spendCloseDir(dir), `${spendCloseKey(runId)}.json`);
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
		read.kind === "value" && isSpendCloseRecord(read.value) && read.value.build === buildId() && read.value.runId === runId
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
		if (read.value.runId !== input.runId) return { ok: false, reason: "관리 실행 표시가 다른 실행을 가리켜 예산 한도를 워커에게 알리지 못했습니다" };
		const at = input.now ?? Date.now();
		const root = spendCloseDir(dir);
		await mkdir(root, { recursive: true, mode: 0o700 });
		const [real, realDir] = await Promise.all([realpath(root), realpath(dir)]);
		if (!real.startsWith(realDir + path.sep)) return { ok: false, reason: "예산 한도 기록이 프로필 밖으로 연결되어 있습니다" };
		const closeFile = path.join(real, `${spendCloseKey(input.runId)}.json`);
		const existing = await readRecordFile(closeFile);
		if (existing.kind === "invalid") return { ok: false, reason: `이 실행의 예산 한도 기록을 읽을 수 없어 덮어쓰지 않았습니다: ${existing.reason}` };
		if (existing.kind === "value") {
			if (!isSpendCloseRecord(existing.value) || existing.value.build !== buildId() || existing.value.runId !== input.runId) {
				return { ok: false, reason: "이 실행의 예산 한도 기록의 형식이나 신원이 올바르지 않습니다" };
			}
			// The first close stands. A second observation of the limit, or a changed user option, never restates it.
			return { ok: true };
		}
		const record: WorkerSpendCloseRecord = { schema: SPEND_CLOSE_SCHEMA, build: buildId(), runId: input.runId, close: { at, onExceed: input.onExceed } };
		const temp = path.join(real, `.${spendCloseKey(input.runId)}.${randomUUID()}.tmp`);
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
			if (raced.kind === "value" && isSpendCloseRecord(raced.value) && raced.value.build === buildId() && raced.value.runId === input.runId) {
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
 * another host thread, so the answer comes from the profile: the marker its parent names supplies the run (or the
 * caller's own `runId` checks it), and the run-keyed close receipt is the one fact the director writes at the limit.
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
}): Promise<SpendCloseRead> {
	try {
		if (input.parentId === undefined) return { kind: "unknown", reason: "부모 에이전트 id를 확인하지 못했습니다" };
		const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
		if (artifactRoot === undefined) return { kind: "unknown", reason: "자식 산출물 루트를 확인하지 못했습니다" };
		const key = runMarkerKey(artifactRoot, input.parentId);
		const dir = admissionsDir(input.agentDir);
		// The run named by the worker's own admission is the one that owns its close: read that receipt first, so a
		// descendant reaches it even when its own parent's marker is gone (B4).
		if (input.runId !== undefined) {
			const direct = await readCloseReceipt(dir, input.runId);
			if (direct !== undefined) return direct;
		}
		const file = path.join(runsDir(dir), `${key}.json`);
		const markerProbe = await probeFile(file);
		if (markerProbe.kind === "missing") {
			// A managed worker cannot establish the fact: a run id of its own, or its own admission record, proves the
			// worker is Storm's, so the missing marker is treated as closed. An ordinary native child has neither and
			// keeps the ordinary answer; its writes are still fenced by the managed tree's own authority check.
			if (input.runId !== undefined) return { kind: "unknown", reason: "관리 실행 표시가 없어 예산 한도 상태를 확인하지 못했습니다" };
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
		// The caller's own run is the one its admission names; a marker for another run cannot answer for it.
		if (input.runId !== undefined && marker.runId !== input.runId) {
			return { kind: "unknown", reason: "관리 실행 표시가 워커의 실행과 다릅니다" };
		}
		const runId = input.runId ?? marker.runId;
		const receipt = await readCloseReceipt(dir, runId);
		if (receipt !== undefined) return receipt;
		if (marker.spendClosedAt !== undefined) {
			// A marker written by the unreleased 0.29.0 build carries the close itself; it is read for compatibility,
			// never written, and no new close ever lands there.
			return { kind: "closed", close: marker.spendClosedAt };
		}
		return { kind: "open" };
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
	await prune(dir, now);
	await pruneRunMarkers(dir, now);
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
	// would make every other unrecorded child of the run read as unknown.
	await writeWorkerRunMarker({
		dir,
		artifactRoot,
		parentId,
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
		await withRecordLock(dir, key, async held => {
			const existing = await readRecordFile(file);
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
			// A writer paused past `LOCK_STALE_MS` lost the lock; it publishes nothing rather than a stale attempt over
			// the record the new owner wrote.
			if (!(await held())) throw new Error("자식 권한 기록을 쓰는 중에 잠금이 다른 사본으로 넘어가 기록을 남기지 않았습니다. 다시 스폰하세요");
			await rename(temp, file);
			published = true;
		});
	} finally {
		if (!published) await rm(temp, { force: true }).catch(() => undefined);
	}
	if (!published) throw new Error("자식 권한 기록을 쓰지 못했습니다. 다시 스폰하세요");
	await chmod(file, 0o600).catch(() => undefined);
	return { key, record };
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
	const dir = admissionsDir(input.agentDir);
	const key = workerAdmissionKey(artifactRoot, parentId, childId);
	const read = await readRecordFile(admissionFile(dir, key));
	if (read.kind === "missing") return { kind: "missing" };
	if (read.kind === "invalid") return read;
	if (!isAdmission(read.value)) return { kind: "invalid", reason: "자식 권한 기록의 형식이 올바르지 않습니다" };
	const record = read.value;
	if (record.build !== buildId()) return { kind: "invalid", reason: "다른 빌드의 Storm이 쓴 자식 권한 기록입니다" };
	if (record.key !== key || record.parentId !== parentId || record.childId !== childId || record.artifactRoot !== artifactRoot) {
		return { kind: "invalid", reason: "자식 권한 기록의 신원이 일치하지 않습니다" };
	}
	return { kind: "record", key, record };
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
