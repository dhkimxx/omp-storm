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
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { sha256Hex } from "./config/canonical.ts";
import { serialized, writeJsonAtomic } from "./fsutil.ts";
import { withJosa } from "./josa.ts";
import { canonicalScope, normalizeScopePath, type LanePolicy } from "./policy/capability.ts";
import { isSpendClose, type SpendClose, type SpendCloseRead } from "./policy/spend-close.ts";
import { assertSessionStoreSafe } from "./session-scope.ts";
import { EFFORTS } from "./types.ts";

export const WORKER_ADMISSION_SCHEMA = "storm.worker-admission/v1";
const KEY = /^[0-9a-f]{64}$/;
const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_ID = 512;
const MAX_PATHS = 256;
const MAX_PATH = 1024;
const MAX_RECORDS = 512;
/** One worker's approved-model snapshot: a role's models plus a trial candidate. More is not a team this check can hold. */
const MAX_APPROVED = 256;
const ACTIVE_TTL_MS = 7 * 24 * 60 * 60_000;
const CLOSED_TTL_MS = 24 * 60 * 60_000;
const LOCK_RETRY_MS = 10;

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

/** One approved model entry: `provider/id`, bounded and free of control characters, at a known effort when one is given. */
function isApprovedEntry(value: unknown): value is { selector: string; effort?: (typeof EFFORTS)[number] } {
	if (!isRecord(value) || typeof value.selector !== "string") return false;
	const selector = value.selector;
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1 || selector.length > MAX_ID || CONTROL_CHARS.test(selector)) return false;
	return value.effort === undefined || (typeof value.effort === "string" && EFFORTS.includes(value.effort as (typeof EFFORTS)[number]));
}

function isAdmission(value: unknown): value is WorkerAdmissionRecord {
	if (!isRecord(value) || value.schema !== WORKER_ADMISSION_SCHEMA) return false;
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
		if (!Array.isArray(value.approved) || value.approved.length > MAX_APPROVED || !value.approved.every(isApprovedEntry)) return false;
	}
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

async function readRecordFile(file: string): Promise<{ kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "value"; value: unknown }> {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", reason: "자식 권한 기록을 확인하지 못했습니다" };
	}
	// A symlink is not a record Storm wrote; never follow it.
	if (!info.isFile()) return { kind: "invalid", reason: "자식 권한 기록이 일반 파일이 아닙니다" };
	try {
		return { kind: "value", value: JSON.parse(await readFile(file, "utf8")) };
	} catch {
		return { kind: "invalid", reason: "자식 권한 기록이 손상됐습니다" };
	}
}

async function prune(dir: string, now: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	let active = 0;
	const records: Array<{ name: string; at: number; closed: boolean }> = [];
	for (const name of names) {
		const file = path.join(dir, name);
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) continue;
		const isRecord = /^[0-9a-f]{64}\.json$/.test(name);
		if (isRecord) {
			const read = await readRecordFile(file);
			const record = read.kind === "value" && isAdmission(read.value) ? read.value : undefined;
			const closed = record !== undefined && (record.revokedAt !== undefined || record.endedAt !== undefined);
			const age = now - info.mtimeMs;
			if ((closed && age > CLOSED_TTL_MS) || (record !== undefined && record.expiresAt < now)) {
				await rm(file, { force: true });
				continue;
			}
			if (!closed) active++;
			records.push({ name, at: record?.createdAt ?? info.mtimeMs, closed });
			continue;
		}
		if (name.endsWith(".claim") && now - info.mtimeMs > CLOSED_TTL_MS) await rm(file, { force: true });
	}
	if (records.length <= MAX_RECORDS) return;
	records.sort((a, b) => (a.closed === b.closed ? a.at - b.at : a.closed ? -1 : 1));
	for (const record of records.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
		if (!record.closed) break;
		await rm(path.join(dir, record.name), { force: true });
	}
	if (active > MAX_RECORDS) throw new Error("보관 중인 자식 권한 기록이 너무 많습니다");
	// A stop directory belongs to one run; a run's own end removes it. A store left behind by a crash must not accumulate.
	const stops = path.join(dir, "stops");
	for (const name of await readdir(stops).catch(() => [] as string[])) {
		const file = path.join(stops, name);
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined || !info.isDirectory()) continue;
		if (now - info.mtimeMs > ACTIVE_TTL_MS) await rm(file, { recursive: true, force: true });
	}
}

const RUN_MARKER_SCHEMA = "storm.worker-run/v1";
const RUN_KEY = /^[0-9a-f]{64}$/;
const MAX_RUN_MARKERS = 128;

interface WorkerRunMarker {
	schema: typeof RUN_MARKER_SCHEMA;
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
	 * Set when the director's instance observed spend reach the user's limit; absent means the run has not closed its
	 * spend. Workers read it from disk, often on another thread, through `readWorkerSpendClose` (D8, R15). The value
	 * carries the user's own `budget.onExceed`, because the workers must know which stop the user chose.
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
	// A spawn admitted after the limit must not erase the close: the director refuses new spawns past it, but one
	// already in flight can still reach here. A new run of the same tree and parent writes its own run id, so it is open.
	const existing = await readRecordFile(file);
	if (existing.kind === "value" && isRunMarker(existing.value) && existing.value.runId === marker.runId && existing.value.spendClosedAt !== undefined) {
		marker.spendClosedAt = existing.value.spendClosedAt;
	}
	await writeJsonAtomic(file, marker);
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
	const kept: Array<{ name: string; at: number; closed: boolean }> = [];
	for (const name of names) {
		if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
		const file = path.join(root, name);
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) continue;
		const read = await readRecordFile(file);
		const marker = read.kind === "value" && isRunMarker(read.value) ? read.value : undefined;
		const closed = marker?.revokedAt !== undefined;
		if ((closed && now - info.mtimeMs > CLOSED_TTL_MS) || (marker !== undefined && marker.expiresAt < now)) {
			await rm(file, { force: true });
			continue;
		}
		kept.push({ name, at: marker?.createdAt ?? info.mtimeMs, closed });
	}
	if (kept.length <= MAX_RUN_MARKERS) return;
	kept.sort((a, b) => (a.closed === b.closed ? a.at - b.at : a.closed ? -1 : 1));
	for (const marker of kept.slice(0, kept.length - MAX_RUN_MARKERS)) {
		if (!marker.closed) break;
		await rm(path.join(root, marker.name), { force: true });
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
	if (read.value.key !== key || read.value.artifactRoot !== artifactRoot || read.value.parentId !== parentId) {
		return { kind: "invalid", reason: "관리 실행 표시의 신원이 일치하지 않습니다" };
	}
	return { kind: "record", marker: read.value };
}

/** One cached marker close, keyed by the marker file: a worker reads it on every tool call and every request. */
interface SpendCloseCacheEntry {
	mtimeMs: number;
	size: number;
	read: SpendCloseRead;
}

const spendCloseCache = new Map<string, SpendCloseCacheEntry>();

/**
 * Closes this run's spend in the marker the workers read. Called once, by the director's own instance, when observed
 * spend reaches the limit. The run id is checked so a stale caller cannot close another run's marker, and a missing
 * marker is a failure the caller must tell the user about rather than a silent no-op: no worker would see the stop.
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
		const file = path.join(runsDir(admissionsDir(input.agentDir)), `${key}.json`);
		const read = await readRecordFile(file);
		if (read.kind === "missing") return { ok: false, reason: "이 실행의 관리 표시가 없어 예산 한도를 워커에게 알리지 못했습니다" };
		if (read.kind === "invalid") return { ok: false, reason: read.reason };
		if (!isRunMarker(read.value) || read.value.key !== key || read.value.artifactRoot !== artifactRoot || read.value.parentId !== input.parentId) {
			return { ok: false, reason: "관리 실행 표시의 신원이 일치하지 않아 예산 한도를 워커에게 알리지 못했습니다" };
		}
		if (read.value.runId !== input.runId) return { ok: false, reason: "관리 실행 표시가 다른 실행을 가리켜 예산 한도를 워커에게 알리지 못했습니다" };
		const marker: WorkerRunMarker = { ...read.value, spendClosedAt: { at: input.now ?? Date.now(), onExceed: input.onExceed } };
		await writeJsonAtomic(file, marker);
		await chmod(file, 0o600).catch(() => undefined);
		return { ok: true };
	} catch {
		return { ok: false, reason: "예산 한도를 실행 표시에 쓰지 못했습니다" };
	}
}

/**
 * What this run's marker says about the spend limit, for a worker's guard and the check before its requests. The marker
 * is looked up by the canonical artifact root and the parent id the host gave the child, never by memory: the worker may
 * run on another host thread (D8, HF-4). Reads are cached by the marker's modification time and size; the file is
 * replaced atomically, so a changed file changes the cache key.
 */
export async function readWorkerSpendClose(input: {
	agentDir: string;
	artifactRoot: string | undefined;
	parentId: string | undefined;
}): Promise<SpendCloseRead> {
	try {
		if (input.parentId === undefined) return { kind: "unknown", reason: "부모 에이전트 id를 확인하지 못했습니다" };
		const artifactRoot = await canonicalWorkerArtifactRoot(input.artifactRoot);
		if (artifactRoot === undefined) return { kind: "unknown", reason: "자식 산출물 루트를 확인하지 못했습니다" };
		const key = runMarkerKey(artifactRoot, input.parentId);
		const file = path.join(runsDir(admissionsDir(input.agentDir)), `${key}.json`);
		const info = await lstat(file).catch(() => undefined);
		if (info === undefined) {
			spendCloseCache.delete(file);
			return { kind: "open" };
		}
		if (!info.isFile()) return { kind: "unknown", reason: "관리 실행 표시가 일반 파일이 아닙니다" };
		const cached = spendCloseCache.get(file);
		if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.read;
		const read = await readRecordFile(file);
		let answer: SpendCloseRead;
		if (read.kind === "missing") {
			spendCloseCache.delete(file);
			return { kind: "open" };
		} else if (read.kind === "invalid") {
			answer = { kind: "unknown", reason: read.reason };
		} else if (
			!isRunMarker(read.value) ||
			read.value.key !== key ||
			read.value.artifactRoot !== artifactRoot ||
			read.value.parentId !== input.parentId
		) {
			answer = { kind: "unknown", reason: "관리 실행 표시의 형식이나 신원이 올바르지 않습니다" };
		} else if (read.value.spendClosedAt === undefined) {
			answer = { kind: "open" };
		} else {
			answer = { kind: "closed", close: read.value.spendClosedAt };
		}
		spendCloseCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, read: answer });
		return answer;
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
	const key = workerAdmissionKey(artifactRoot, parentId, childId);
	const record: WorkerAdmissionRecord = {
		schema: WORKER_ADMISSION_SCHEMA,
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
		if (input.approved.length > MAX_APPROVED || !input.approved.every(isApprovedEntry)) throw new Error("승인된 모델 목록이 올바르지 않거나 너무 많습니다");
		record.approved = input.approved.map(entry => ({ selector: entry.selector, ...(entry.effort === undefined ? {} : { effort: entry.effort }) }));
	}
	const file = admissionFile(dir, key);
	await writeJsonAtomic(file, record);
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
		await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
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

async function rewriteRecord(file: string, change: (record: WorkerAdmissionRecord) => WorkerAdmissionRecord): Promise<boolean> {
	const read = await readRecordFile(file);
	if (read.kind !== "value" || !isAdmission(read.value)) return false;
	const next = change(read.value);
	await writeJsonAtomic(file, next);
	await chmod(file, 0o600).catch(() => undefined);
	return true;
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
		const read = await readRecordFile(file);
		if (read.kind !== "value" || !isAdmission(read.value)) continue;
		const record = read.value;
		if (match.runId !== undefined && record.runId !== match.runId) continue;
		if (match.sessionId !== undefined && record.sessionId !== match.sessionId) continue;
		if (match.key !== undefined && record.key !== match.key) continue;
		if (match.attempt !== undefined && record.attempt !== match.attempt) continue;
		if (match.childId !== undefined && record.childId !== match.childId) continue;
		if (match.createdBefore !== undefined && record.createdAt >= match.createdBefore) continue;
		if (record.revokedAt !== undefined) continue;
		if (await rewriteRecord(file, value => ({ ...value, revokedAt: now }))) count++;
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
		const read = await readRecordFile(file);
		if (read.kind !== "value" || !isRunMarker(read.value)) continue;
		const marker = read.value;
		if (match.runId !== undefined && marker.runId !== match.runId) continue;
		if (match.sessionId !== undefined && marker.sessionId !== match.sessionId) continue;
		if (marker.revokedAt !== undefined) continue;
		const next: WorkerRunMarker = { ...marker, revokedAt: now };
		await writeJsonAtomic(file, next);
		await chmod(file, 0o600).catch(() => undefined);
		count++;
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
	return rewriteRecord(file, record => (record.attempt === attempt && record.revokedAt === undefined ? { ...record, endedAt: now } : record));
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

// ── why a child on another thread was stopped ──────────────────────────────────────────────────────────────────────────────

/**
 * What a worker whose omp thread does not share the director's Storm instance still owes the director: why it was stopped.
 * omp runs the ninth and later concurrent subagents on pooled threads, each with its own module state; a Storm worker found
 * there stops before its first request (decision D5), and this one small file per child carries the sentence to the director's
 * thread. It carries no spend and no model verdict: those cannot be established for a thread Storm does not own, and the worker
 * never runs a request there. Every field is checked before it is trusted (filename hash, bounded identities, a known attempt,
 * a finite time, a bounded one-line notice), and adoption deletes the file, so reading it twice changes nothing.
 */
const STOP_SCHEMA = "storm.child-stop/v1";
const MAX_STOP_BYTES = 8 * 1024;
const MAX_STOPS_PER_RUN = 1024;
const MAX_NOTICE = 4_000;

export interface ChildStop {
	schema: typeof STOP_SCHEMA;
	runId: string;
	childId: string;
	/** The admission attempt the stop belongs to; a newer attempt of the same child is a different record. */
	attempt: string;
	/** Why the worker was stopped, for the director. One line. */
	notice: string;
	at: number;
}

function stopsRoot(agentDir: string): string {
	return path.join(admissionsDir(agentDir), "stops");
}

function stopsDir(agentDir: string, runId: string): string {
	return path.join(stopsRoot(agentDir), sha256Hex(`stops\u0000${runId}`));
}

function stopFile(dir: string, childId: string): string {
	return path.join(dir, `${sha256Hex(`child\u0000${childId}`)}.json`);
}

/** Whether the raw value is a stop this schema and run accept; the filename and the child's admission are checked by the caller. */
function isChildStop(value: unknown, runId: string, now: number): value is ChildStop {
	if (!isRecord(value) || value.schema !== STOP_SCHEMA) return false;
	if (value.runId !== runId) return false;
	if (typeof value.childId !== "string" || value.childId.trim() === "" || value.childId.length > MAX_ID || CONTROL_CHARS.test(value.childId)) return false;
	if (typeof value.attempt !== "string" || !ATTEMPT.test(value.attempt)) return false;
	if (typeof value.notice !== "string" || value.notice.trim() === "" || value.notice.length > MAX_NOTICE || CONTROL_CHARS.test(value.notice)) return false;
	if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at <= 0) return false;
	// A timestamp far outside this store's life is not a stop Storm wrote now; do not trust it as one.
	return value.at <= now + 300_000 && value.at >= now - ACTIVE_TTL_MS;
}

async function readStopFile(file: string, runId: string, now: number): Promise<ChildStop | undefined> {
	const info = await lstat(file).catch(() => undefined);
	if (info === undefined || !info.isFile() || info.size > MAX_STOP_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
	return isChildStop(value, runId, now) ? value : undefined;
}

/** Writes this child's stop, whole and atomically. A failure is returned, not thrown: the stop itself already happened. */
export async function writeChildStop(agentDir: string, stop: Omit<ChildStop, "schema" | "at">, now = Date.now()): Promise<boolean> {
	try {
		const runId = identity(stop.runId, "실행 id");
		const childId = identity(stop.childId, "자식 에이전트 id");
		const dir = stopsDir(agentDir, runId);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const root = stopsRoot(agentDir);
		const [realDir, realRoot] = await Promise.all([realpath(dir), realpath(root)]);
		if (!realDir.startsWith(realRoot + path.sep)) throw new Error("자식 중지 기록이 프로필 밖으로 연결되어 있습니다");
		await serialized(`child-stop\u0000${agentDir}\u0000${runId}\u0000${childId}`, async () => {
			await writeJsonAtomic(stopFile(dir, childId), { schema: STOP_SCHEMA, ...stop, runId, childId, at: now } satisfies ChildStop);
			await chmod(stopFile(dir, childId), 0o600).catch(() => undefined);
		});
		return true;
	} catch {
		return false;
	}
}

/** Every well-formed stop of one run, filtered before any cap so an unreadable old file cannot starve a later one. */
export async function readChildStops(agentDir: string, runId: string, now = Date.now()): Promise<ChildStop[]> {
	const dir = stopsDir(agentDir, runId);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const candidates = names.filter(name => /^[0-9a-f]{64}\.json$/.test(name));
	if (candidates.length > MAX_STOPS_PER_RUN) throw new Error("자식 중지 기록이 너무 많습니다");
	const out: ChildStop[] = [];
	for (const name of candidates) {
		const stop = await readStopFile(path.join(dir, name), runId, now);
		// The filename must be the child's own hash: a record renamed onto another child is not that child's stop.
		if (stop === undefined || path.basename(stopFile(dir, stop.childId)) !== name) continue;
		out.push(stop);
	}
	return out;
}

/** Deletes one adopted stop. Another stop for the same child (a newer attempt) is left for the next adoption. */
export async function acknowledgeChildStop(agentDir: string, stop: ChildStop): Promise<void> {
	try {
		const dir = stopsDir(agentDir, stop.runId);
		const file = stopFile(dir, stop.childId);
		await serialized(`child-stop\u0000${agentDir}\u0000${stop.runId}\u0000${stop.childId}`, async () => {
			const current = await readStopFile(file, stop.runId, Date.now());
			if (current === undefined || current.attempt !== stop.attempt || current.at !== stop.at) return;
			await rm(file, { force: true });
		});
	} catch {
		// A stop that cannot be deleted is already recorded; the run-scoped cleanup below is the backstop.
	}
}

/** Removes one run's stops (a finished run leaves nothing behind). Best effort: cleanup never fails the caller. */
export async function clearChildStops(agentDir: string, runId: string): Promise<void> {
	try {
		await rm(stopsDir(agentDir, identity(runId, "실행 id")), { recursive: true, force: true });
	} catch {
		// A stale directory is pruned with the rest of the admission store.
	}
}

/** The run a child on this thread belongs to, from its persisted admission when the thread's memory has no run for it. */
export type ChildBinding =
	| { kind: "bound"; runId: string; sessionId: string; sessionDir: string; repoId: string; root: string; artifactRoot: string; attempt: string; createdAt: number; approved?: ReadonlyArray<{ selector: string; effort?: string }> }
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
		return { kind: "bound", runId: record.runId, sessionId: record.sessionId, sessionDir: record.sessionDir, repoId: record.repoId, root: record.targetRoot, artifactRoot: record.artifactRoot, attempt: record.attempt, createdAt: record.createdAt, ...(record.approved === undefined ? {} : { approved: record.approved }) };
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
