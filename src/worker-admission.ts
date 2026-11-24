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
import { writeJsonAtomic } from "./fsutil.ts";
import { canonicalScope, normalizeScopePath, type LanePolicy } from "./policy/capability.ts";
import { assertSessionStoreSafe } from "./session-scope.ts";

export const WORKER_ADMISSION_SCHEMA = "storm.worker-admission/v1";
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

export interface WorkerAdmissionPolicy {
	kind: LanePolicy["kind"];
	/** Canonical workspace-relative scopes for `paths`; empty for every other kind. */
	paths: readonly string[];
	reason: string;
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
	/** Set by the parent's run/session revocation. A closed record denies writes but still proves management. */
	revokedAt?: number;
	/** Set when the child's own settled turn ends; a follow-up admission opens a new attempt. */
	endedAt?: number;
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
}

export type WorkerAdmissionRead =
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	| { kind: "record"; key: string; record: WorkerAdmissionRecord };

function identity(value: unknown, what: string): string {
	if (typeof value !== "string" || value.trim() === "" || CONTROL_CHARS.test(value) || value.length > MAX_ID) {
		throw new Error(`${what}가 없거나 올바르지 않습니다`);
	}
	return value;
}

function requireAbsolute(value: unknown, what: string): string {
	const raw = identity(value, what);
	if (!path.isAbsolute(raw)) throw new Error(`${what}는 절대 경로여야 합니다`);
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
	return value.paths.every(item => typeof item === "string" && item.length <= MAX_PATH && normalizeScopePath(item) === item);
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
	if (value.revokedAt !== undefined && (typeof value.revokedAt !== "number" || !Number.isFinite(value.revokedAt))) return false;
	if (value.endedAt !== undefined && (typeof value.endedAt !== "number" || !Number.isFinite(value.endedAt))) return false;
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
	return { kind: policy.kind, paths, reason: policy.reason.slice(0, 2_000) };
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
	match: { runId?: string; sessionId?: string; key?: string; attempt?: string },
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
		if (record.revokedAt !== undefined) continue;
		if (await rewriteRecord(file, value => ({ ...value, revokedAt: now }))) count++;
	}
	// A run marker must close too: otherwise a child that never received a record in this run would still look
	// managed while a finished run blocks it forever, or an unrecorded child would lose the managed marker. An exact
	// key/attempt revocation is for one child, not the run marker.
	const root = runsDir(dir);
	const markers = match.key === undefined && match.attempt === undefined ? await readdir(root).catch(() => [] as string[]) : [];
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
			if (!isRecord(value) || value.schema !== "storm.worker-claim/v1" || value.session !== sha256Hex(`claim\u0000${session}`)) return false;
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
