/**
 * Slice A's owned integration store: candidate identity, exact native-slot reservation, the prepared admission and
 * child-entry claim, and one verified content-addressed copy of a host-declared patch.
 *
 * Nothing here trusts a filename from model text or a persisted JSON field for authority: a candidate id is re-derived
 * from its versioned admission key, every byte copy is read from one open handle with the file identity and length
 * proven before and after, and only a slot/owner/attempt token written by this module can release or replace a record.
 * B consumes `IntegrationBytePort.readPatch` and `CaptureJournalPort`; A never opens a native path for installation.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getWorktreesDir } from "@oh-my-pi/pi-utils";
import type { LiveCheck, PlanLaneResult } from "../types.ts";
import type { WorkerAdmissionRecord } from "../worker-admission.ts";
import type {
	AdmissionKey,
	AdmissionSubject,
	IntegrationAdmissionPort,
	ApplyPolicyProofRef,
	ChildEntryClaim,
	ConsumedInput,
	DirectorIdentity,
	FrozenIntegrationAdmission,
	FrozenScope,
	GitObjectSource,
	InputSubject,
	IntegrationCandidateId,
	IntegrationCheck,
	IntegrationProblem,
	IntegrationRead,
	IntegrationTarget,
	LocatedInputPath,
	NativeSlotLease,
	NativeTaskItem,
	ObservationIdentity,
	PathImage,
	ReceiptRef,
	SpaceIdentity,
} from "./integration-admission.ts";
import type { ByteWindow, IntegrationBytePort, StoredPatchRef } from "./integration-delta.ts";

export const INTEGRATION_ADMISSION_SCHEMA = "storm.integration-admission/v1";
export const INTEGRATION_PATCH_SCHEMA = "storm.integration-patch/v1";
export const INTEGRATION_POLICY_HOST = "19.2.1";
/** Per source patch / per owned object. A larger native patch is not copied or hashed whole. */
export const INTEGRATION_PATCH_MAX_BYTES = 64 * 1024 * 1024;
/** Per director run, including nested recovery parts. */
export const INTEGRATION_RUN_MAX_BYTES = 256 * 1024 * 1024;
/** I/O only: eight concurrent copies per profile store, never a worker cap. */
export const INTEGRATION_COPY_CONCURRENCY = 8;
const CANDIDATE = /^c1_[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OBJECT_KEY = /^v1\/objects\/[0-9a-f]{64}$/u;
const MAX_PATH = 4096;
const MAX_ID = 512;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_MARKER_BYTES = 8 * 1024;
const SLOT_LOCK_WAIT_MS = 2_000;

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

const refused = (code: string, reason: string, path?: string): IntegrationCheck => ({
	ok: false,
	problem: problem(code, reason, path),
});

function boundedId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID && !CONTROL.test(value);
}

function boundedPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PATH &&
		!CONTROL.test(value) &&
		isAbsolute(value)
	);
}

function decimal(value: unknown): value is string {
	return typeof value === "string" && /^\d{1,32}$/u.test(value);
}

/** `JSON.stringify` with object keys sorted, used only for equality and digests over our own typed records. */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** A versioned admission key must be exactly the three trusted fields; the brand is only re-derived, never persisted. */
export function isAdmissionKey(value: unknown): value is AdmissionKey {
	return (
		record(value) &&
		value.schema === INTEGRATION_ADMISSION_SCHEMA &&
		boundedId(value.runId) &&
		boundedId(value.dispatch)
	);
}

/** The one stable candidate spelling: c1_ plus SHA-256 of `[schema, runId, dispatch]` in UTF-8. */
export function integrationCandidateId(key: AdmissionKey): IntegrationCandidateId {
	if (!isAdmissionKey(key)) throw new Error("integration admission key is not valid");
	return `c1_${sha256Hex(JSON.stringify([key.schema, key.runId, key.dispatch]))}` as IntegrationCandidateId;
}

export function isIntegrationCandidateId(value: unknown): value is IntegrationCandidateId {
	return typeof value === "string" && CANDIDATE.test(value);
}

/** Validate a persisted candidate id against the key; a stored id alone never grants the TypeScript brand. */
function candidateIdForStored(key: AdmissionKey, stored: unknown): IntegrationRead<IntegrationCandidateId> {
	const derived = integrationCandidateId(key);
	if (stored !== derived) return unknown("candidate-id-mismatch", "저장된 후보 ID가 이 승인 키에서 파생되지 않았습니다");
	return { kind: "known", value: derived };
}

function isSpaceIdentity(value: unknown): value is SpaceIdentity {
	return record(value) && boundedPath(value.canonicalPath) && decimal(value.device) && decimal(value.inode);
}

function isObjectSource(value: unknown): value is GitObjectSource {
	return (
		record(value) &&
		isSpaceIdentity(value.commonDir) &&
		isSpaceIdentity(value.objects) &&
		(value.objectFormat === "sha1" || value.objectFormat === "sha256")
	);
}

function isPlatformTarget(value: unknown): value is IntegrationTarget {
	return (
		record(value) &&
		boundedId(value.leaseKey) &&
		isSpaceIdentity(value.authorizedRoot) &&
		isSpaceIdentity(value.gitRoot) &&
		isSpaceIdentity(value.gitDir) &&
		isObjectSource(value.sourceOdb) &&
		typeof value.targetPrefix === "string" &&
		safePrefix(value.targetPrefix)
	);
}

function safePrefix(value: string): boolean {
	if (value === "" || value === ".") return true;
	if (value.length > MAX_PATH || value.startsWith("/") || CONTROL.test(value)) return false;
	return !value.split("/").includes("..");
}

function isScope(value: unknown): value is FrozenScope {
	if (!record(value)) return false;
	if (value.kind === "unbounded") return true;
	return Array.isArray(value.paths) && value.paths.length <= 4096 && value.paths.every(item => typeof item === "string" && safePrefix(item));
}

function isPlanResult(value: unknown): value is Readonly<PlanLaneResult> {
	if (!record(value) || !boundedId(value.id) || typeof value.kind !== "string") return false;
	if (!["change", "artifact", "answer"].includes(value.kind)) return false;
	return (
		typeof value.criterion === "string" &&
		value.criterion.length <= 2_000 &&
		(value.path === undefined || typeof value.path === "string") &&
		(value.contains === undefined || typeof value.contains === "string") &&
		(value.check === undefined || typeof value.check === "string")
	);
}

function isInputSubject(value: unknown): value is InputSubject {
	if (!record(value)) return false;
	if (value.kind === "result") return boundedId(value.id);
	return value.kind === "resultless-footprint" && boundedId(value.lane);
}

function isLocatedPath(value: unknown): value is LocatedInputPath {
	return record(value) && typeof value.path === "string" && safePrefix(value.path) && isPathImage(value.image);
}

function isPathImage(value: unknown): value is PathImage {
	if (!record(value)) return false;
	if (value.kind === "absent") return true;
	return (
		value.kind === "file" &&
		(value.mode === "100644" || value.mode === "100755") &&
		typeof value.bytes === "number" &&
		Number.isSafeInteger(value.bytes) &&
		value.bytes >= 0 &&
		typeof value.sha256 === "string" &&
		SHA256.test(value.sha256)
	);
}

function isReceiptRef(value: unknown): value is ReceiptRef {
	return (
		record(value) &&
		isAdmissionKey(value.key) &&
		isIntegrationCandidateId(value.candidateId) &&
		typeof value.manifestDigest === "string" &&
		SHA256.test(value.manifestDigest) &&
		Number.isSafeInteger(value.intentSequence) &&
		Number.isSafeInteger(value.receiptSequence)
	);
}

function isConsumedInput(value: unknown): value is ConsumedInput {
	if (!record(value) || !boundedId(value.producerLane)) return false;
	if (typeof value.need !== "string" || !["result", "integrated", "reviewable"].includes(value.need)) return false;
	if (!isInputSubject(value.subject)) return false;
	if (value.state === "missing") return true;
	if (typeof value.version !== "string" || value.version.length > 2_000) return false;
	if (value.state === "version") return true;
	return (
		value.state === "integrated" &&
		isReceiptRef(value.receipt) &&
		Array.isArray(value.paths) &&
		value.paths.length <= 4096 &&
		value.paths.every(isLocatedPath)
	);
}

function isSubject(value: unknown): value is AdmissionSubject {
	if (!record(value)) return false;
	if (value.kind === "unplanned") return true;
	return (
		value.kind === "planned" &&
		boundedId(value.lane) &&
		typeof value.epoch === "number" &&
		Number.isSafeInteger(value.epoch) &&
		value.epoch >= 0 &&
		typeof value.contractDigest === "string" &&
		value.contractDigest.length <= 512 &&
		Array.isArray(value.results) &&
		value.results.length <= 256 &&
		value.results.every(isPlanResult) &&
		Array.isArray(value.consumed) &&
		value.consumed.length <= 256 &&
		value.consumed.every(isConsumedInput)
	);
}

function isItem(value: unknown): value is NativeTaskItem {
	return (
		record(value) &&
		boundedId(value.toolCallId) &&
		typeof value.itemIndex === "number" &&
		Number.isSafeInteger(value.itemIndex) &&
		value.itemIndex >= 0 &&
		boundedId(value.handle)
	);
}

function isSlot(value: unknown, key: AdmissionKey): value is NativeSlotLease {
	return (
		record(value) &&
		isAdmissionKey(value.key) &&
		value.key.schema === key.schema &&
		value.key.runId === key.runId &&
		value.key.dispatch === key.dispatch &&
		boundedId(value.profile) &&
		boundedPath(value.slotPath) &&
		boundedId(value.ownerToken)
	);
}

function isApplyProof(value: unknown): value is ApplyPolicyProofRef {
	return (
		record(value) &&
		boundedId(value.id) &&
		value.host === INTEGRATION_POLICY_HOST &&
		boundedId(value.settingsInstance) &&
		Number.isSafeInteger(value.relevantEpoch) &&
		boundedId(value.directorInstance) &&
		boundedId(value.toolCallId) &&
		value.enabled === true &&
		boundedId(value.backendProofId) &&
		value.apply === false &&
		value.merge === "patch" &&
		value.captureContract === "native-git-synthetic-tree" &&
		typeof value.backendSetting === "string" &&
		value.backendSetting.length <= 128 &&
		boundedId(value.profile) &&
		boundedId(value.guardBuild)
	);
}

function isDirector(value: unknown): value is DirectorIdentity {
	return (
		record(value) &&
		boundedId(value.sessionId) &&
		boundedId(value.sessionInstance) &&
		boundedPath(value.sessionDir) &&
		boundedId(value.parentId)
	);
}

function isWorkerPick(value: unknown): value is Pick<WorkerAdmissionRecord, "key" | "attempt" | "approved"> {
	if (!record(value) || typeof value.key !== "string" || !SHA256.test(value.key)) return false;
	if (typeof value.attempt !== "string" || !ATTEMPT.test(value.attempt)) return false;
	if (value.approved === undefined) return true;
	return (
		Array.isArray(value.approved) &&
		value.approved.every(
			entry =>
				record(entry) &&
				typeof entry.selector === "string" &&
				entry.selector.length <= MAX_ID &&
				(entry.effort === undefined || typeof entry.effort === "string"),
		)
	);
}

/** Enough of the frozen admission is validated that persisted JSON cannot add or replace authority fields. */
export function validateFrozenAdmission(value: unknown): IntegrationRead<FrozenIntegrationAdmission> {
	if (!record(value)) return unknown("admission-invalid", "승인 레코드가 객체가 아닙니다");
	if (!isAdmissionKey(value.key)) return unknown("admission-key-invalid", "승인 키가 올바르지 않습니다");
	const key = value.key;
	const candidate = candidateIdForStored(key, value.candidateId);
	if (candidate.kind === "unknown") return candidate;
	if (!isDirector(value.director)) return unknown("admission-director-invalid", "감독 세션 신원이 올바르지 않습니다");
	if (!isPlatformTarget(value.target)) return unknown("admission-target-invalid", "대상 저장소 신원이 올바르지 않습니다");
	if (!isSpaceIdentity(value.artifactRoot)) return unknown("admission-artifact-root-invalid", "아티팩트 루트가 올바르지 않습니다");
	if (!isItem(value.item)) return unknown("admission-item-invalid", "네이티브 작업 항목이 올바르지 않습니다");
	if (typeof value.placementOrdinal !== "number" || !Number.isSafeInteger(value.placementOrdinal) || value.placementOrdinal < 0) {
		return unknown("admission-ordinal-invalid", "배치 순번이 올바르지 않습니다");
	}
	if (typeof value.approvedDefinitionDigest !== "string" || value.approvedDefinitionDigest.length > 512) {
		return unknown("admission-definition-invalid", "승인 정의 다이제스트가 올바르지 않습니다");
	}
	if (typeof value.approvalDigest !== "string" || value.approvalDigest.length > 512) {
		return unknown("admission-approval-invalid", "승인 다이제스트가 올바르지 않습니다");
	}
	if (!isWorkerPick(value.workerAdmission)) return unknown("admission-worker-invalid", "작업자 승인 신원이 올바르지 않습니다");
	if (!isScope(value.scope)) return unknown("admission-scope-invalid", "고정 범위가 올바르지 않습니다");
	if (!isSubject(value.subject)) return unknown("admission-subject-invalid", "승인 주체가 올바르지 않습니다");
	if (!isApplyProof(value.policy)) return unknown("admission-policy-unproved", "적용 금지 정책 증명이 없습니다");
	if (!isSlot(value.slot, key)) return unknown("admission-slot-invalid", "네이티브 슬롯 임차가 올바르지 않습니다");
	if (value.slot.profile !== value.policy.profile) return unknown("admission-profile-mismatch", "슬롯과 정책 프로필이 다릅니다");
	if (value.policy.toolCallId !== value.item.toolCallId) return unknown("admission-policy-call-mismatch", "정책 증명이 다른 호출을 가리킵니다");
	if (typeof value.startedAt !== "number" || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) {
		return unknown("admission-clock-invalid", "승인 시각이 올바르지 않습니다");
	}
	return { kind: "known", value: value as unknown as FrozenIntegrationAdmission };
}

// ── file identity and safe reads ─────────────────────────────────────────────────────────────────────────────────

interface StatIdentity {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mode: bigint;
	nlink: bigint;
	mtimeNs: bigint;
}

interface PathStat extends StatIdentity {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

async function statOf(path: string): Promise<PathStat> {
	const stat = await fs.lstat(path, { bigint: true });
	return {
		dev: stat.dev,
		ino: stat.ino,
		size: stat.size,
		mode: stat.mode,
		nlink: stat.nlink,
		mtimeNs: stat.mtimeNs,
		isFile: stat.isFile(),
		isDirectory: stat.isDirectory(),
		isSymbolicLink: stat.isSymbolicLink(),
	};
}

function sameIdentity(a: StatIdentity, b: StatIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

function sameReadStat(a: StatIdentity, b: StatIdentity): boolean {
	return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function spaceOf(path: string, stat: StatIdentity): SpaceIdentity {
	return { canonicalPath: path, device: stat.dev.toString(), inode: stat.ino.toString() };
}

function checkedSegment(segment: string): boolean {
	return segment !== "" && segment !== "." && segment !== ".." && !CONTROL.test(segment);
}

/** Verify every ancestor is a real directory (never a symlink) below the already canonical root. */
async function proveAncestors(root: string, path: string): Promise<string> {
	const rel = relative(root, resolve(path));
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw problem("path-outside-root", "네이티브 경로가 소유 아티팩트 루트 밖입니다", path);
	}
	const segments = rel.split(sep);
	if (!segments.every(checkedSegment)) throw problem("path-form-invalid", "네이티브 경로에 안전하지 않은 구성요소가 있습니다", path);
	let current = root;
	for (const segment of segments.slice(0, -1)) {
		current = join(current, segment);
		let stat;
		try {
			stat = await statOf(current);
		} catch {
			throw problem("path-missing", "네이티브 경로의 상위 디렉터리를 읽지 못했습니다", path);
		}
		if (!stat.isDirectory || stat.isSymbolicLink) {
			throw problem("path-ancestor-unsafe", "네이티브 경로의 상위 디렉터리가 심볼릭 링크이거나 디렉터리가 아닙니다", path);
		}
	}
	return join(root, rel);
}

async function fsyncDir(dir: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(dir, fsConstants.O_RDONLY);
		await handle.sync();
	} catch {
		// Directory fsync is best-effort on platforms that refuse it; the file itself is synced before rename.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Open the admitted artifact root itself and prove the admitted device/inode on that handle. Every native byte read
 * below stays anchored to this handle: a whole-directory replacement at the same spelling is not the admitted root
 * even when its child file has the expected name, size and mode.
 */
async function openRootAnchor(root: string, expected: SpaceIdentity): Promise<FileHandle> {
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(
			root,
			fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_DIRECTORY ?? 0),
		);
		const anchored = await handle.stat({ bigint: true });
		if (
			!anchored.isDirectory() ||
			anchored.dev.toString() !== expected.device ||
			anchored.ino.toString() !== expected.inode
		) {
			throw problem("artifact-root-replaced", "아티팩트 루트 신원이 승인 뒤 바뀌었습니다", root);
		}
		return handle;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (record(error) && typeof error.code === "string") throw error;
		throw problem("artifact-root-open-failed", "아티팩트 루트를 안전하게 열지 못했습니다", root);
	}
}

/** The path must still name exactly the admitted directory held by the open anchor. */
async function proveRootIdentity(root: string, anchor: FileHandle, expected: SpaceIdentity): Promise<void> {
	let anchored;
	try {
		anchored = await anchor.stat({ bigint: true });
	} catch {
		throw problem("artifact-root-replaced", "아티팩트 루트 핸들을 다시 확인하지 못했습니다", root);
	}
	if (
		!anchored.isDirectory() ||
		anchored.dev.toString() !== expected.device ||
		anchored.ino.toString() !== expected.inode
	) {
		throw problem("artifact-root-replaced", "아티팩트 루트 신원이 승인 뒤 바뀌었습니다", root);
	}
	let current;
	try {
		current = await statOf(root);
	} catch {
		throw problem("artifact-root-missing", "아티팩트 루트를 읽지 못했습니다", root);
	}
	if (
		!current.isDirectory ||
		current.isSymbolicLink ||
		current.dev.toString() !== expected.device ||
		current.ino.toString() !== expected.inode
	) {
		throw problem("artifact-root-replaced", "아티팩트 루트 신원이 승인 뒤 바뀌었습니다", root);
	}
}

/** Open one owner-bound regular file without following a replaced link, then prove its exact identity. */
async function openVerified(
	root: string,
	path: string,
	maxBytes: number,
	anchor: FileHandle,
	expectedRoot: SpaceIdentity,
): Promise<{ handle: FileHandle; stat: StatIdentity; realPath: string }> {
	await proveRootIdentity(root, anchor, expectedRoot);
	const realPath = await proveAncestors(root, path);
	try {
		const parent = await fs.realpath(resolve(realPath, ".."));
		if (parent !== resolve(realPath, "..")) {
			throw problem("path-ancestor-race", "네이티브 경로의 상위 디렉터리가 심볼릭 링크로 바뀌었습니다", path);
		}
	} catch (error) {
		if (record(error) && typeof error.code === "string") throw error;
		throw problem("path-ancestor-race", "네이티브 경로의 상위 디렉터리를 확인하지 못했습니다", path);
	}
	let before;
	try {
		before = await statOf(realPath);
	} catch {
		throw problem("path-missing", "네이티브 파일을 읽지 못했습니다", path);
	}
	if (before.isSymbolicLink) throw problem("path-symlink", "네이티브 파일이 심볼릭 링크입니다", path);
	if (!before.isFile) throw problem("path-not-file", "네이티브 경로가 일반 파일이 아닙니다", path);
	if (before.nlink !== 1n) throw problem("path-hardlink", "네이티브 파일이 다른 이름으로도 연결되어 있습니다", path);
	if (before.size > BigInt(maxBytes)) throw problem("path-too-large", "네이티브 파일이 복사 상한을 넘습니다", path);
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		const opened = await handle.stat({ bigint: true });
		const afterStat: StatIdentity = {
			dev: opened.dev,
			ino: opened.ino,
			size: opened.size,
			mode: opened.mode,
			nlink: opened.nlink,
			mtimeNs: opened.mtimeNs,
		};
		if (!opened.isFile() || !sameIdentity(before, afterStat) || opened.size !== before.size) {
			throw problem("path-replaced", "네이티브 파일이 확인 중 교체되었습니다", path);
		}
		// The handle is the file; the path root must still be the admitted directory the handle was opened under.
		await proveRootIdentity(root, anchor, expectedRoot);
		return { handle, stat: afterStat, realPath };
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (record(error) && typeof error.code === "string") throw error;
		throw problem("path-open-failed", "네이티브 파일을 안전하게 열지 못했습니다", path);
	}
}

async function proveUnchangedAfter(
	root: string,
	path: string,
	opened: StatIdentity,
	anchor: FileHandle,
	expectedRoot: SpaceIdentity,
): Promise<void> {
	await proveRootIdentity(root, anchor, expectedRoot);
	let after;
	try {
		after = await statOf(await proveAncestors(root, path));
	} catch {
		throw problem("path-replaced", "복사 뒤 네이티브 파일을 다시 확인하지 못했습니다", path);
	}
	if (!sameReadStat(opened, after) || after.nlink !== 1n) {
		throw problem("path-replaced", "복사 뒤 네이티브 파일 내용이 바뀌었습니다", path);
	}
}

// ── candidate-facing patch forms ───────────────────────────────────────────────────────────────────────────────

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The root patch must be exactly the handle-named file; copyPatch proves its parent against the canonical root. */
function isRootPatchPath(handle: string, path: string): boolean {
	return isAbsolute(path) && basename(path) === `${handle}.patch`;
}

function isNestedPatchPath(handle: string, path: string): boolean {
	return (
		isAbsolute(path) &&
		new RegExp(`^${escapeRegExp(handle)}\\.nested-\\d+-[^/\\\\]+\\.patch$`, "u").test(basename(path))
	);
}

// ── owned byte store ────────────────────────────────────────────────────────────────────────────────────────────

export interface IntegrationArtifactStoreOptions {
	/** Profile-wide owner store; one directory per agent profile. */
	agentDir: string;
	now?: () => number;
	maxObjectBytes?: number;
	maxRunBytes?: number;
	maxConcurrentCopies?: number;
	/** Owner-profile cap for this store's owned objects (journal bytes are B's separate accounting). */
	maxStoreBytes?: number;
}

export interface CopyPatchInput {
	admission: FrozenIntegrationAdmission;
	kind: "root" | "nested";
	nativePath: string;
	/** Nested part ordinal from the host list; never parsed from the filename for repository identity. */
	index?: number;
	deadline?: number;
	signal?: AbortSignal;
}

/**
 * One profile-wide, content-addressed owned-byte store plus the byte reader B consumes. A copy is charged before it
 * queues, streams from one proven handle into a private synced temp file, and publishes only a fully synced object.
 */
export class IntegrationArtifactStore implements IntegrationBytePort {
	readonly root: string;
	readonly objectsDir: string;
	readonly #now: () => number;
	readonly #maxObjectBytes: number;
	readonly #maxRunBytes: number;
	readonly #maxConcurrent: number;
	readonly #maxStoreBytes: number;
	readonly #runBytes = new Map<string, number>();
	#reservedStoreBytes = 0;
	readonly #waiters: Array<() => void> = [];
	#active = 0;
	#knownBytes: number | undefined;

	constructor(options: IntegrationArtifactStoreOptions) {
		if (!boundedPath(options.agentDir)) throw new Error("integration store needs an absolute agent directory");
		this.root = join(options.agentDir, "integration");
		this.objectsDir = join(this.root, "v1", "objects");
		this.#now = options.now ?? Date.now;
		this.#maxObjectBytes = options.maxObjectBytes ?? INTEGRATION_PATCH_MAX_BYTES;
		this.#maxRunBytes = options.maxRunBytes ?? INTEGRATION_RUN_MAX_BYTES;
		this.#maxConcurrent = Math.max(1, options.maxConcurrentCopies ?? INTEGRATION_COPY_CONCURRENCY);
		this.#maxStoreBytes = options.maxStoreBytes ?? 2 * 1024 * 1024 * 1024;
	}

	objectKeyOf(digest: string): string {
		return `v1/objects/${digest}`;
	}

	/** Account and copy exactly one typed native patch. Unknown leaves no selectable reference. */
	async copyPatch(input: CopyPatchInput): Promise<IntegrationRead<StoredPatchRef>> {
		const checked = validateFrozenAdmission(input.admission);
		if (checked.kind === "unknown") return checked;
		const admission = checked.value;
		const handle = admission.item.handle;
		const artifactRoot = admission.artifactRoot.canonicalPath;
		const nameOk = input.kind === "root" ? isRootPatchPath(handle, input.nativePath) : isNestedPatchPath(handle, input.nativePath);
		if (!nameOk) return unknown("patch-name-invalid", "네이티브 패치 경로가 이 작업자의 파일 형식이 아닙니다", input.nativePath);
		if (input.deadline !== undefined && this.#now() > input.deadline) return unknown("copy-deadline", "복사 제한 시간이 지났습니다", input.nativePath);
		if (input.signal?.aborted === true) return unknown("copy-aborted", "복사가 취소되었습니다", input.nativePath);
		let rootStat;
		try {
			rootStat = await statOf(artifactRoot);
		} catch {
			return unknown("artifact-root-missing", "아티팩트 루트를 읽지 못했습니다", artifactRoot);
		}
		if (!rootStat.isDirectory || rootStat.isSymbolicLink) return unknown("artifact-root-unsafe", "아티팩트 루트가 안전한 디렉터리가 아닙니다", artifactRoot);
		if (
			spaceOf(artifactRoot, rootStat).device !== admission.artifactRoot.device ||
			spaceOf(artifactRoot, rootStat).inode !== admission.artifactRoot.inode
		) {
			return unknown("artifact-root-replaced", "아티팩트 루트 신원이 승인 뒤 바뀌었습니다", artifactRoot);
		}
		// The preflight lstat gives a diagnostic before any bytes move; the opened directory handle below is the
		// authority every later read and commit is checked against.
		let anchor: FileHandle;
		try {
			anchor = await openRootAnchor(artifactRoot, admission.artifactRoot);
		} catch (error) {
			const detail = record(error) && typeof error.reason === "string" ? error : undefined;
			return unknown(
				detail?.code === undefined ? "artifact-root-open-failed" : String(detail.code),
				detail?.reason === undefined ? "아티팩트 루트를 안전하게 열지 못했습니다" : String(detail.reason),
				artifactRoot,
			);
		}
		try {
			// The host may spell the artifact root through an alias (e.g. /tmp on macOS while the canonical root is
			// /private/tmp). Resolve only the parent to the already bound canonical root; the final component is still
			// opened with O_NOFOLLOW and its exact inode/length/digest is compared.
			const canonicalParent = await fs.realpath(dirname(input.nativePath)).catch(() => undefined);
			if (canonicalParent === undefined || canonicalParent !== artifactRoot) {
				return unknown("path-outside-root", "네이티브 경로의 상위 디렉터리가 소유 아티팩트 루트가 아닙니다", input.nativePath);
			}
			const canonicalPath = join(canonicalParent, basename(input.nativePath));
			let opened;
			try {
				opened = await openVerified(artifactRoot, canonicalPath, this.#maxObjectBytes, anchor, admission.artifactRoot);
			} catch (error) {
				const detail = record(error) && typeof error.reason === "string" ? error : undefined;
				return unknown(
					detail?.code === undefined ? "patch-read-failed" : String(detail.code),
					detail?.reason === undefined ? "네이티브 패치를 안전하게 읽지 못했습니다" : String(detail.reason),
					input.nativePath,
				);
			}
			try {
				const size = Number(opened.stat.size);
				if (!Number.isSafeInteger(size) || size > this.#maxObjectBytes) {
					return unknown("patch-too-large", "네이티브 패치가 상한을 넘습니다", input.nativePath);
				}
				const charged = this.#charge(admission.key.runId, size, await this.#ownedBytes());
				if (charged !== undefined) return charged;
				const release = await this.#acquire(input.deadline, input.signal).catch(() => undefined);
				if (release === undefined) {
					this.#refund(admission.key.runId, size);
					return unknown("copy-deadline", "복사 대기 제한 시간이 지났습니다", input.nativePath);
				}
				try {
					const copied = await this.#streamObject(admission, input, opened, size, anchor);
					if (copied.kind === "unknown") this.#refund(admission.key.runId, size);
					else {
						this.#reservedStoreBytes = Math.max(0, this.#reservedStoreBytes - size);
						this.#knownBytes = undefined;
					}
					return copied;
				} catch {
					this.#refund(admission.key.runId, size);
					return unknown("patch-copy-failed", "네이티브 패치를 소유 저장소로 복사하지 못했습니다", input.nativePath);
				} finally {
					release();
				}
			} finally {
				await opened.handle.close().catch(() => undefined);
			}
		} finally {
			await anchor.close().catch(() => undefined);
		}
	}

	#charge(runId: string, bytes: number, storeBytes: number): IntegrationRead<StoredPatchRef> | undefined {
		const current = this.#runBytes.get(runId) ?? 0;
		if (current + bytes > this.#maxRunBytes) {
			return unknown("run-capacity", "이 실행의 소유 패치 용량 상한을 넘습니다");
		}
		if (storeBytes + this.#reservedStoreBytes + bytes > this.#maxStoreBytes) {
			return unknown("store-capacity", "프로필 통합 저장 용량 상한을 넘습니다");
		}
		this.#runBytes.set(runId, current + bytes);
		this.#reservedStoreBytes += bytes;
		return undefined;
	}

	#refund(runId: string, bytes: number): void {
		const current = this.#runBytes.get(runId) ?? 0;
		this.#runBytes.set(runId, Math.max(0, current - bytes));
		this.#reservedStoreBytes = Math.max(0, this.#reservedStoreBytes - bytes);
	}

	async #acquire(deadline: number | undefined, signal: AbortSignal | undefined): Promise<(() => void) | undefined> {
		while (this.#active >= this.#maxConcurrent) {
			if (deadline !== undefined && this.#now() >= deadline) return undefined;
			await new Promise<void>(resolvePromise => this.#waiters.push(resolvePromise));
			if (signal?.aborted === true) throw new Error("copy aborted");
		}
		this.#active += 1;
		return () => {
			this.#active -= 1;
			this.#waiters.shift()?.();
		};
	}

	async #streamObject(
		admission: FrozenIntegrationAdmission,
		input: CopyPatchInput,
		opened: { handle: FileHandle; stat: StatIdentity; realPath: string },
		size: number,
		anchor: FileHandle,
	): Promise<IntegrationRead<StoredPatchRef>> {
		await fs.mkdir(join(this.root, "v1", "tmp"), { recursive: true });
		await fs.mkdir(this.objectsDir, { recursive: true });
		const tmp = join(this.root, "v1", "tmp", `${process.pid}.${randomUUID()}.part`);
		const hash = createHash("sha256");
		let written = 0;
		let out: FileHandle | undefined;
		try {
			out = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let position = 0;
			while (position < size) {
				if (input.signal?.aborted === true) throw new Error("copy aborted");
				if (input.deadline !== undefined && this.#now() > input.deadline) throw new Error("copy deadline");
				const want = Math.min(buffer.length, size - position);
				const { bytesRead } = await opened.handle.read(buffer, 0, want, position);
				if (bytesRead <= 0) throw new Error("short read");
				const chunk = buffer.subarray(0, bytesRead);
				hash.update(chunk);
				let offset = 0;
				while (offset < bytesRead) {
					const { bytesWritten } = await out.write(chunk, offset, bytesRead - offset);
					if (bytesWritten <= 0) throw new Error("short write");
					offset += bytesWritten;
				}
				position += bytesRead;
				written += bytesRead;
			}
			if (written !== size) throw new Error("size changed");
			await out.sync();
			const after = await opened.handle.stat({ bigint: true });
			if (after.size !== BigInt(size) || !sameReadStat(opened.stat, {
				dev: after.dev,
				ino: after.ino,
				size: after.size,
				mode: after.mode,
				nlink: after.nlink,
				mtimeNs: after.mtimeNs,
			})) {
				throw new Error("file changed during copy");
			}
			await proveUnchangedAfter(
				admission.artifactRoot.canonicalPath,
				opened.realPath,
				opened.stat,
				anchor,
				admission.artifactRoot,
			);
			const digest = hash.digest("hex");
			const objectPath = join(this.objectsDir, digest);
			let existing: PathStat | undefined;
			try {
				existing = await statOf(objectPath);
			} catch {
				existing = undefined;
			}
			if (existing !== undefined) {
				if (!existing.isFile || existing.size !== BigInt(size) || existing.nlink !== 1n) {
					return unknown("object-conflict", "같은 다이제스트의 소유 객체가 다른 내용입니다", objectPath);
				}
				await fs.rm(tmp, { force: true }).catch(() => undefined);
			} else {
				await fs.rename(tmp, objectPath);
				await fsyncDir(this.objectsDir);
				this.#knownBytes = undefined;
			}
			return {
				kind: "known",
				value: {
					schema: INTEGRATION_PATCH_SCHEMA,
					key: admission.key,
					objectKey: this.objectKeyOf(digest),
					bytes: size,
					sha256: digest,
				},
			};
		} catch {
			await fs.rm(tmp, { force: true }).catch(() => undefined);
			return unknown("patch-copy-failed", "네이티브 패치를 소유 저장소로 복사하지 못했습니다", input.nativePath);
		} finally {
			await out?.close().catch(() => undefined);
		}
	}

	/** B's only way to read owned bytes: exact length and digest from one opened object, never a re-open by host path. */
	async readPatch(ref: StoredPatchRef, window: ByteWindow): Promise<IntegrationRead<Uint8Array>> {
		if (!record(ref) || ref.schema !== INTEGRATION_PATCH_SCHEMA) return unknown("patch-ref-invalid", "소유 패치 참조가 올바르지 않습니다");
		if (!isAdmissionKey(ref.key)) return unknown("patch-ref-key-invalid", "소유 패치 참조 키가 올바르지 않습니다");
		if (typeof ref.objectKey !== "string" || !OBJECT_KEY.test(ref.objectKey)) {
			return unknown("patch-ref-object-invalid", "소유 객체 키가 올바르지 않습니다");
		}
		if (typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256)) return unknown("patch-ref-digest-invalid", "소유 객체 다이제스트가 올바르지 않습니다");
		if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) return unknown("patch-ref-size-invalid", "소유 객체 크기가 올바르지 않습니다");
		if (ref.objectKey !== this.objectKeyOf(ref.sha256)) return unknown("patch-ref-object-mismatch", "객체 키와 다이제스트가 다릅니다");
		if (ref.bytes > window.maxBytes) return unknown("patch-read-over-cap", "요청한 읽기 상한보다 큰 패치입니다");
		if (this.#now() > window.deadline) return unknown("patch-read-deadline", "패치 읽기 제한 시간이 지났습니다");
		if (window.signal.aborted) return unknown("patch-read-aborted", "패치 읽기가 취소되었습니다");
		const path = join(this.objectsDir, ref.sha256);
		let handle: FileHandle | undefined;
		try {
			handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
			const before = await handle.stat({ bigint: true });
			if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(ref.bytes)) {
				return unknown("patch-object-invalid", "소유 객체의 크기나 형식이 참조와 다릅니다", path);
			}
			const buffer = Buffer.allocUnsafe(ref.bytes);
			let offset = 0;
			while (offset < ref.bytes) {
				if (window.signal.aborted) return unknown("patch-read-aborted", "패치 읽기가 취소되었습니다");
				if (this.#now() > window.deadline) return unknown("patch-read-deadline", "패치 읽기 제한 시간이 지났습니다");
				const { bytesRead } = await handle.read(buffer, offset, ref.bytes - offset, offset);
				if (bytesRead <= 0) return unknown("patch-object-short", "소유 객체를 끝까지 읽지 못했습니다", path);
				offset += bytesRead;
			}
			if (window.signal.aborted) return unknown("patch-read-aborted", "패치 읽기가 취소되었습니다");
			const digest = createHash("sha256").update(buffer).digest("hex");
			if (digest !== ref.sha256) return unknown("patch-object-digest", "소유 객체 다이제스트가 참조와 다릅니다", path);
			const after = await handle.stat({ bigint: true });
			if (after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino) {
				return unknown("patch-object-replaced", "읽는 동안 소유 객체가 바뀌었습니다", path);
			}
			return { kind: "known", value: new Uint8Array(buffer) };
		} catch {
			return unknown("patch-object-missing", "소유 객체를 읽지 못했습니다", path);
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	/** Total owned object bytes, read once and kept until a new object is published (never per observation). */
	async #ownedBytes(): Promise<number> {
		if (this.#knownBytes !== undefined) return this.#knownBytes;
		let total = 0;
		try {
			for (const entry of await fs.readdir(this.objectsDir, { withFileTypes: true })) {
				if (!entry.isFile() || !SHA256.test(entry.name)) continue;
				try {
					total += Number((await statOf(join(this.objectsDir, entry.name))).size);
				} catch {
					// A concurrently removed object (never by this module) does not make the rest unreadable.
				}
			}
		} catch {
			total = 0;
		}
		this.#knownBytes = total;
		return total;
	}
}

// ── native slot reservation ────────────────────────────────────────────────────────────────────────────────────

/** The same process-instance token the pinned host writes into `.omp-isolation-owner.json`. */
async function processStartToken(pid: number): Promise<string | null> {
	if (process.platform === "win32") return null;
	if (process.platform === "linux") {
		try {
			const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
			const commEnd = stat.lastIndexOf(")");
			if (commEnd < 0) return null;
			const starttime = stat.slice(commEnd + 2).split(" ")[19];
			return typeof starttime === "string" && starttime.length > 0 ? starttime : null;
		} catch {
			return null;
		}
	}
	const { promise, resolve: resolvePromise } = Promise.withResolvers<string | null>();
	execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 2_000 }, (error, stdout) => {
		if (error !== null) {
			resolvePromise(null);
			return;
		}
		const value = stdout.trim();
		resolvePromise(value === "" ? null : value);
	});
	return promise;
}

let ownStartToken: Promise<string | null> | undefined;

export interface IntegrationAdmissionStoreOptions {
	agentDir: string;
	/** Test/edge override; production uses the pinned host worktree root for the active profile. */
	worktreesDir?: string;
	now?: () => number;
	hostOwner?: () => Promise<{ pid: number; processStart: string | null }>;
}

interface SlotOwnerRecord {
	schema: "storm.integration-slot/v1";
	key: AdmissionKey;
	candidateId: IntegrationCandidateId;
	profile: string;
	slotPath: string;
	ownerToken: string;
	handle: string;
	pid: number;
	processStart: string | null;
	createdAt: number;
}

function isSlotOwner(value: unknown): value is SlotOwnerRecord {
	return (
		record(value) &&
		value.schema === "storm.integration-slot/v1" &&
		isAdmissionKey(value.key) &&
		isIntegrationCandidateId(value.candidateId) &&
		value.candidateId === integrationCandidateId(value.key) &&
		boundedId(value.profile) &&
		boundedPath(value.slotPath) &&
		boundedId(value.ownerToken) &&
		boundedId(value.handle) &&
		Number.isSafeInteger(value.pid) &&
		(value.processStart === null || typeof value.processStart === "string") &&
		Number.isSafeInteger(value.createdAt)
	);
}

function slotOwnedBy(owner: SlotOwnerRecord, slot: NativeSlotLease, key: AdmissionKey, handle: string): boolean {
	return (
		owner.ownerToken === slot.ownerToken &&
		owner.profile === slot.profile &&
		owner.handle === handle &&
		owner.key.schema === key.schema &&
		owner.key.runId === key.runId &&
		owner.key.dispatch === key.dispatch &&
		resolve(owner.slotPath) === resolve(slot.slotPath)
	);
}

async function readJsonFile(path: string): Promise<unknown> {
	try {
		const text = await fs.readFile(path, "utf8");
		if (text.length > MAX_MARKER_BYTES * 16) return undefined;
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/** Durable exclusive create through a synced temp file and a hard link; a second writer never overwrites. */
async function writeExclusive(file: string, value: unknown): Promise<"created" | "exists" | "failed"> {
	const dir = resolve(file, "..");
	await fs.mkdir(dir, { recursive: true });
	const text = `${canonicalJson(value)}\n`;
	const tmp = join(dir, `.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
		await handle.writeFile(text, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.link(tmp, file);
		await fsyncDir(dir);
		return "created";
	} catch (error) {
		if (record(error) && error.code === "EEXIST") return "exists";
		return "failed";
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.rm(tmp, { force: true }).catch(() => undefined);
	}
}

/**
 * The on-disk half of `IntegrationAdmissionPort`: an exclusive native slot across managed sessions of one profile,
 * the provisional admission E may publish only after its final checks, and the cooperative child-entry claim.
 */
export class IntegrationAdmissionStore implements IntegrationAdmissionPort {
	readonly storeRoot: string;
	readonly #agentDir: string;
	readonly #worktreesDirOverride: string | undefined;
	readonly #now: () => number;
	readonly #hostOwner: () => Promise<{ pid: number; processStart: string | null }>;
	readonly artifacts: IntegrationArtifactStore;

	constructor(options: IntegrationAdmissionStoreOptions) {
		if (!boundedPath(options.agentDir)) throw new Error("integration admission store needs an absolute agent directory");
		this.#agentDir = options.agentDir;
		this.storeRoot = join(options.agentDir, "integration");
		this.#worktreesDirOverride = options.worktreesDir;
		this.#now = options.now ?? Date.now;
		this.#hostOwner =
			options.hostOwner ??
			(async () => {
				ownStartToken ??= processStartToken(process.pid);
				return { pid: process.pid, processStart: await ownStartToken };
			});
		this.artifacts = new IntegrationArtifactStore({ agentDir: this.#agentDir, now: this.#now });
	}

	#worktreesDir(): string {
		return this.#worktreesDirOverride ?? getWorktreesDir();
	}

	#preparedDir(key: string): string {
		return join(this.storeRoot, "v1", "prepared", key);
	}

	#preparedPath(workerKey: string, attempt: string): string {
		return join(this.#preparedDir(workerKey), `${attempt}.json`);
	}

	#abandonedPath(workerKey: string, attempt: string): string {
		return join(this.#preparedDir(workerKey), `${attempt}.abandoned.json`);
	}

	#claimPath(candidateId: IntegrationCandidateId): string {
		return join(this.storeRoot, "v1", "claims", `${candidateId}.json`);
	}

	#slotIndexPath(key: AdmissionKey): string {
		return join(this.storeRoot, "v1", "slots", "by-key", `${sha256Hex(`${key.schema}\u0000${key.runId}\u0000${key.dispatch}`)}.json`);
	}

	#slotLockDir(slotPath: string): string {
		const digest = sha256Hex(resolve(slotPath));
		return join(this.storeRoot, "v1", "slots", digest);
	}

	async #slotOwner(slotPath: string): Promise<IntegrationRead<SlotOwnerRecord | null>> {
		const ownerPath = join(this.#slotLockDir(slotPath), "owner.json");
		const parsed = await readJsonFile(ownerPath);
		if (parsed === undefined) {
			try {
				await statOf(join(this.#slotLockDir(slotPath)));
				return unknown("slot-unknown", "슬롯 잠금은 있지만 소유자 기록을 읽지 못했습니다");
			} catch {
				return { kind: "known", value: null };
			}
		}
		if (!isSlotOwner(parsed) || resolve(parsed.slotPath) !== resolve(slotPath)) {
			return unknown("slot-unknown", "슬롯 소유자 기록이 올바르지 않습니다");
		}
		return { kind: "known", value: parsed };
	}

	async reserveSlot(input: {
		readonly key: AdmissionKey;
		readonly target: IntegrationTarget;
		readonly item: NativeTaskItem;
		readonly profile: string;
		readonly nativeSlotPath: string;
	}): Promise<IntegrationRead<NativeSlotLease>> {
		if (!isAdmissionKey(input.key)) return unknown("slot-key-invalid", "슬롯 승인 키가 올바르지 않습니다");
		if (!isItem(input.item)) return unknown("slot-item-invalid", "슬롯 작업 항목이 올바르지 않습니다");
		if (!boundedId(input.profile)) return unknown("slot-profile-invalid", "프로필 이름이 올바르지 않습니다");
		if (!isPlatformTarget(input.target)) return unknown("slot-target-invalid", "슬롯 대상 신원이 올바르지 않습니다");
		try {
			const root = await statOf(input.target.gitRoot.canonicalPath);
			if (!root.isDirectory || root.isSymbolicLink) return unknown("slot-repo-unsafe", "저장소 루트가 안전한 디렉터리가 아닙니다");
			if (spaceOf(input.target.gitRoot.canonicalPath, root).device !== input.target.gitRoot.device ||
				spaceOf(input.target.gitRoot.canonicalPath, root).inode !== input.target.gitRoot.inode) {
				return unknown("slot-repo-replaced", "저장소 루트 신원이 승인 뒤 바뀌었습니다");
			}
		} catch {
			return unknown("slot-repo-missing", "저장소 루트를 읽지 못했습니다", input.target.gitRoot.canonicalPath);
		}
		const slotPath = input.nativeSlotPath;
		if (!boundedPath(slotPath) || slotPath !== resolve(slotPath) || dirname(slotPath) !== resolve(this.#worktreesDir()) ||
			!/^t[0-9a-f]{9}$/u.test(basename(slotPath))) {
			return unknown("slot-path-unproved", "호스트가 고정한 슬롯이 이 프로필의 네이티브 작업 디렉터리 밖에 있습니다", slotPath);
		}
		const lockDir = this.#slotLockDir(slotPath);
		const ownerPath = join(lockDir, "owner.json");
		const indexPath = this.#slotIndexPath(input.key);
		const deadline = this.#now() + SLOT_LOCK_WAIT_MS;
		const indexed = await readJsonFile(indexPath);
		if (indexed !== undefined) {
			if (!isSlotOwner(indexed)) return unknown("slot-index-unknown", "슬롯 인덱스 기록을 읽지 못했습니다");
			if (indexed.handle !== input.item.handle || indexed.profile !== input.profile || resolve(indexed.slotPath) !== resolve(slotPath)) {
				return unknown("slot-key-reused", "같은 승인 키가 다른 작업 항목에 다시 쓰였습니다", indexPath);
			}
			const owner = await this.#slotOwner(indexed.slotPath);
			if (owner.kind === "unknown") return owner;
			if (owner.value === null || owner.value.ownerToken !== indexed.ownerToken) {
				return unknown("slot-index-unknown", "슬롯 인덱스가 살아 있는 예약을 가리키지 않습니다", indexPath);
			}
			return {
				kind: "known",
				value: { key: input.key, profile: input.profile, slotPath: indexed.slotPath, ownerToken: indexed.ownerToken },
			};
		}
		const occupied = await statOf(slotPath).catch(() => undefined);
		if (occupied !== undefined) {
			const marker = await readJsonFile(join(slotPath, ".omp-isolation-owner.json"));
			const owner = await this.#hostOwner();
			const sameOwner =
				record(marker) &&
				marker.id === input.item.handle &&
				marker.pid === owner.pid &&
				(typeof marker.startToken !== "string" || owner.processStart === null || marker.startToken === owner.processStart);
			if (!occupied.isDirectory || !sameOwner) {
				return unknown("slot-occupied", "네이티브 슬롯에 다른 소유자의 흔적이 있습니다", slotPath);
			}
		}
		while (true) {
			const existing = await this.#slotOwner(slotPath);
			if (existing.kind === "unknown") return existing;
			if (existing.value !== null) {
				const same =
					existing.value.key.schema === input.key.schema &&
					existing.value.key.runId === input.key.runId &&
					existing.value.key.dispatch === input.key.dispatch &&
					existing.value.handle === input.item.handle &&
					existing.value.profile === input.profile;
				if (same) {
					const sameLease = {
						kind: "known" as const,
						value: {
							key: input.key,
							profile: existing.value.profile,
							slotPath,
							ownerToken: existing.value.ownerToken,
						},
					};
					const indexedAgain = await writeExclusive(indexPath, existing.value);
					if (indexedAgain === "failed") return unknown("slot-index-write-failed", "슬롯 인덱스를 기록하지 못했습니다", indexPath);
					if (indexedAgain === "exists") {
						const stored = await readJsonFile(indexPath);
						if (!isSlotOwner(stored) || stored.ownerToken !== existing.value.ownerToken) {
							return unknown("slot-key-reused", "같은 승인 키가 다른 작업 항목에 다시 쓰였습니다", indexPath);
						}
					}
					return sameLease;
				}
				return unknown("slot-held", "같은 네이티브 슬롯을 다른 관리 세션이 이미 예약했습니다", slotPath);
			}
			try {
				await fs.mkdir(lockDir, { recursive: true });
				const owner = await this.#hostOwner();
				const candidateId = integrationCandidateId(input.key);
				const recordValue: SlotOwnerRecord = {
					schema: "storm.integration-slot/v1",
					key: input.key,
					candidateId,
					profile: input.profile,
					slotPath,
					ownerToken: randomUUID(),
					handle: input.item.handle,
					pid: owner.pid,
					processStart: owner.processStart,
					createdAt: this.#now(),
				};
				const written = await writeExclusive(ownerPath, recordValue);
				if (written === "created") {
					const reread = await this.#slotOwner(slotPath);
					if (reread.kind === "unknown") return reread;
					if (reread.value === null || reread.value.ownerToken !== recordValue.ownerToken) {
						return unknown("slot-race", "슬롯 예약이 다른 기록으로 바뀌었습니다", slotPath);
					}
					const keyIndex = await writeExclusive(indexPath, recordValue);
					if (keyIndex === "created") {
						return {
							kind: "known",
							value: { key: input.key, profile: input.profile, slotPath, ownerToken: recordValue.ownerToken },
						};
					}
					// Another item already owns this admission key; never leave a second slot behind.
					await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
					const other = await readJsonFile(indexPath);
					if (isSlotOwner(other) && other.ownerToken === recordValue.ownerToken) {
						return {
							kind: "known",
							value: { key: input.key, profile: input.profile, slotPath, ownerToken: recordValue.ownerToken },
						};
					}
					return unknown("slot-key-reused", "같은 승인 키가 다른 작업 항목에 다시 쓰였습니다", indexPath);
				}
				if (written === "failed") return unknown("slot-write-failed", "슬롯 예약을 기록하지 못했습니다", slotPath);
			} catch {
				return unknown("slot-write-failed", "슬롯 예약을 기록하지 못했습니다", slotPath);
			}
			if (this.#now() >= deadline) return unknown("slot-contended", "슬롯 예약이 다른 세션과 경합했습니다", slotPath);
			const { promise, resolve: releaseWait } = Promise.withResolvers<void>();
			setTimeout(releaseWait, 10);
			await promise;
		}
	}

	async persistPrepared(admission: FrozenIntegrationAdmission): Promise<IntegrationCheck> {
		const checked = validateFrozenAdmission(admission);
		if (checked.kind === "unknown") return { ok: false, problem: checked.problem };
		const value = checked.value;
		const owner = await this.#slotOwner(value.slot.slotPath);
		if (owner.kind === "unknown") return { ok: false, problem: owner.problem };
		if (owner.value === null || !slotOwnedBy(owner.value, value.slot, value.key, value.item.handle)) {
			return refused("slot-not-held", "승인된 슬롯을 이 호출이 소유하지 않습니다", value.slot.slotPath);
		}
		const candidate = integrationCandidateId(value.key);
		const file = this.#preparedPath(value.workerAdmission.key, value.workerAdmission.attempt);
		const written = await writeExclusive(file, value);
		if (written === "created") return { ok: true };
		if (written === "failed") return refused("admission-write-failed", "승인 레코드를 내구성 있게 쓰지 못했습니다", file);
		const existing = await readJsonFile(file);
		const checkedExisting = validateFrozenAdmission(existing);
		if (checkedExisting.kind === "unknown") return { ok: false, problem: checkedExisting.problem };
		if (checkedExisting.value.candidateId !== candidate || canonicalJson(checkedExisting.value) !== canonicalJson(value)) {
			return refused("admission-conflict", "같은 작업 시도의 승인 레코드가 다른 내용으로 이미 있습니다", file);
		}
		return { ok: true };
	}

	async readPrepared(worker: Pick<Readonly<WorkerAdmissionRecord>, "key" | "attempt">): Promise<IntegrationRead<FrozenIntegrationAdmission>> {
		if (typeof worker.key !== "string" || !SHA256.test(worker.key) || typeof worker.attempt !== "string" || !ATTEMPT.test(worker.attempt)) {
			return unknown("worker-identity-invalid", "작업자 키나 시도가 올바르지 않습니다");
		}
		const file = this.#preparedPath(worker.key, worker.attempt);
		const abandoned = await statOf(this.#abandonedPath(worker.key, worker.attempt)).catch(() => undefined);
		if (abandoned !== undefined) return unknown("admission-abandoned", "철회된 승인입니다");
		const parsed = await readJsonFile(file);
		if (parsed === undefined) return unknown("admission-missing", "내구성 있는 승인 레코드가 없습니다", file);
		const checked = validateFrozenAdmission(parsed);
		if (checked.kind === "unknown") return checked;
		if (checked.value.workerAdmission.key !== worker.key || checked.value.workerAdmission.attempt !== worker.attempt) {
			return unknown("admission-worker-mismatch", "승인 레코드가 다른 작업자 시도를 가리킵니다", file);
		}
		const owner = await this.#slotOwner(checked.value.slot.slotPath);
		if (owner.kind === "unknown") return owner;
		if (owner.value === null || !slotOwnedBy(owner.value, checked.value.slot, checked.value.key, checked.value.item.handle)) {
			return unknown("slot-not-held", "승인 레코드의 슬롯이 더 이상 이 승인 소유가 아닙니다", checked.value.slot.slotPath);
		}
		return checked;
	}

	async abandonPrepared(admission: FrozenIntegrationAdmission): Promise<IntegrationCheck> {
		const checked = validateFrozenAdmission(admission);
		if (checked.kind === "unknown") return { ok: false, problem: checked.problem };
		const value = checked.value;
		const file = this.#preparedPath(value.workerAdmission.key, value.workerAdmission.attempt);
		const parsed = await readJsonFile(file);
		if (parsed === undefined) return this.releaseSlot(value.slot, "not-dispatched");
		const existing = validateFrozenAdmission(parsed);
		if (existing.kind === "unknown") return { ok: false, problem: existing.problem };
		if (
			existing.value.candidateId !== value.candidateId ||
			existing.value.slot.ownerToken !== value.slot.ownerToken ||
			existing.value.workerAdmission.attempt !== value.workerAdmission.attempt
		) {
			return refused("admission-not-owner", "이 승인이 소유한 준비 기록이 아닙니다", file);
		}
		const tombstone = this.#abandonedPath(value.workerAdmission.key, value.workerAdmission.attempt);
		const tomb = await writeExclusive(tombstone, { ...value, abandonedAt: this.#now() });
		if (tomb !== "created" && tomb !== "exists") return refused("admission-abandon-failed", "철회 기록을 쓰지 못했습니다", tombstone);
		await fs.rm(file, { force: true }).catch(() => undefined);
		await this.releaseSlot(value.slot, "not-dispatched");
		return { ok: true };
	}

	async releaseSlot(slot: NativeSlotLease, cause: "not-dispatched" | "native-ended"): Promise<IntegrationCheck> {
		if (!isAdmissionKey(slot.key) || typeof slot.ownerToken !== "string" || !boundedPath(slot.slotPath)) {
			return refused("slot-release-invalid", "슬롯 해제 요청이 올바르지 않습니다");
		}
		if (cause !== "not-dispatched" && cause !== "native-ended") {
			return refused("slot-release-cause", "슬롯 해제 사유가 올바르지 않습니다");
		}
		const lockDir = this.#slotLockDir(slot.slotPath);
		const owner = await this.#slotOwner(slot.slotPath);
		if (owner.kind === "unknown") return { ok: false, problem: owner.problem };
		if (owner.value === null) return { ok: true };
		if (owner.value.ownerToken !== slot.ownerToken) {
			return refused("slot-not-owner", "이 슬롯을 소유한 예약이 아닙니다", slot.slotPath);
		}
		// Move the whole lock aside first. A newer owner can only have written after this rename, so the comparison below
		// never deletes a replacement; a mismatch puts the lock back when nothing new claimed it.
		const tomb = `${lockDir}.released-${randomUUID()}`;
		try {
			await fs.rename(lockDir, tomb);
		} catch (error) {
			if (record(error) && error.code === "ENOENT") return { ok: true };
			return refused("slot-release-failed", "슬롯 잠금을 해제 위치로 옮기지 못했습니다", slot.slotPath);
		}
		const moved = await readJsonFile(join(tomb, "owner.json"));
		if (!isSlotOwner(moved) || moved.ownerToken !== slot.ownerToken || resolve(moved.slotPath) !== resolve(slot.slotPath)) {
			await fs.rename(tomb, lockDir).catch(() => undefined);
			return refused("slot-not-owner", "이 슬롯을 소유한 예약이 아닙니다", slot.slotPath);
		}
		const index = await readJsonFile(this.#slotIndexPath(slot.key));
		if (isSlotOwner(index) && index.ownerToken === slot.ownerToken) {
			await fs.rm(this.#slotIndexPath(slot.key), { force: true }).catch(() => undefined);
		}
		await fs.rm(tomb, { recursive: true, force: true });
		return { ok: true };
	}

	async claimAtEntry(input: {
		readonly admission: FrozenIntegrationAdmission;
		readonly worker: Readonly<WorkerAdmissionRecord>;
		readonly entry: ObservationIdentity;
		readonly childCwd: string;
		readonly guardBuild: string;
		readonly live: () => LiveCheck;
		readonly verifyInputs: (claim: ChildEntryClaim, inputs: readonly ConsumedInput[]) => Promise<IntegrationCheck>;
	}): Promise<IntegrationRead<ChildEntryClaim>> {
		const checked = validateFrozenAdmission(input.admission);
		if (checked.kind === "unknown") return checked;
		const claimed = checked.value;
		if (
			input.worker.key !== claimed.workerAdmission.key ||
			input.worker.attempt !== claimed.workerAdmission.attempt
		) {
			return unknown("entry-worker-mismatch", "자식 작업자 시도가 승인과 다릅니다");
		}
		if (canonicalJson(input.worker.approved ?? null) !== canonicalJson(claimed.workerAdmission.approved ?? null)) {
			return unknown("entry-approval-mismatch", "자식 승인 모델이 승인 시점과 다릅니다");
		}
		if (input.worker.revokedAt !== undefined) return unknown("entry-revoked", "철회된 작업자입니다");
		if (input.worker.endedAt !== undefined) return unknown("entry-ended", "이미 끝난 작업자 시도입니다");
		const workerArtifact = await fs.realpath(input.worker.artifactRoot).catch(() => undefined);
		if (workerArtifact === undefined || workerArtifact !== claimed.artifactRoot.canonicalPath) {
			return unknown("entry-artifact-root-mismatch", "작업자 아티팩트 루트가 승인과 다릅니다");
		}
		const workerTarget = await fs.realpath(input.worker.targetRoot).catch(() => undefined);
		if (workerTarget === undefined || workerTarget !== claimed.target.authorizedRoot.canonicalPath) {
			return unknown("entry-target-root-mismatch", "작업자 대상 루트가 승인과 다릅니다");
		}
		if (input.guardBuild !== claimed.policy.guardBuild) return unknown("entry-guard-mismatch", "자식 가드 빌드가 승인과 다릅니다");
		if (!boundedPath(input.childCwd)) return unknown("entry-cwd-invalid", "자식 작업 디렉터리가 올바르지 않습니다");
		if (!isObservation(input.entry)) return unknown("entry-observation-invalid", "레지스트리 관측 신원이 올바르지 않습니다");

		const prepared = await this.readPrepared(input.worker);
		if (prepared.kind === "unknown") return prepared;
		// The durable record, not the caller's object, seeds every later proof. Only the candidate id would let two
		// different admissions with the same key seed different claim fields.
		if (canonicalJson(prepared.value) !== canonicalJson(claimed)) {
			return unknown("entry-admission-mismatch", "준비된 승인과 전달된 승인이 다릅니다");
		}
		const admission = prepared.value;

		const target = await this.#matchTarget(admission);
		if (!target.ok) return { kind: "unknown", problem: target.problem };
		const owner = await this.#slotOwner(admission.slot.slotPath);
		if (owner.kind === "unknown") return owner;
		if (owner.value === null || !slotOwnedBy(owner.value, admission.slot, admission.key, admission.item.handle)) {
			return unknown("entry-slot-not-held", "자식 네이티브 슬롯을 이 승인이 소유하지 않습니다", admission.slot.slotPath);
		}

		let childCwd: string;
		let expectedCwd: string;
		try {
			childCwd = await fs.realpath(input.childCwd);
			expectedCwd = await fs.realpath(join(admission.slot.slotPath, "m"));
		} catch {
			return unknown("entry-cwd-missing", "자식 작업 디렉터리나 슬롯 마운트를 확인하지 못했습니다", input.childCwd);
		}
		if (childCwd !== expectedCwd) {
			return unknown("entry-cwd-mismatch", "자식 작업 디렉터리가 이 승인의 네이티브 슬롯이 아닙니다", input.childCwd);
		}

		const marker = await this.#checkMarker(admission);
		if (!marker.ok) return { kind: "unknown", problem: marker.problem };
		const hostOwner = await this.#hostOwner();
		const slotOwner = owner.value;
		if (slotOwner.pid !== hostOwner.pid) return unknown("entry-owner-pid", "슬롯 소유 프로세스가 다릅니다");
		if (slotOwner.processStart !== null && hostOwner.processStart !== null && slotOwner.processStart !== hostOwner.processStart) {
			return unknown("entry-owner-instance", "슬롯 소유 프로세스 인스턴스가 다릅니다");
		}

		const checkoutDir = await this.#checkoutIdentity(childCwd);
		if (checkoutDir.kind === "unknown") return checkoutDir;
		const { checkout, gitDir, index } = checkoutDir.value;
		if (sameSpace(gitDir, admission.target.gitDir)) return unknown("entry-admin-shared", "자식 Git 관리 디렉터리가 부모와 같습니다", gitDir.canonicalPath);
		if (index.canonicalPath === join(admission.target.gitDir.canonicalPath, "index")) {
			return unknown("entry-admin-shared", "자식 인덱스가 부모 인덱스와 같습니다", index.canonicalPath);
		}
		if (sameSpace(gitDir, admission.target.authorizedRoot) || sameSpace(gitDir, admission.target.gitRoot)) {
			return unknown("entry-admin-parent", "자식 Git 관리 디렉터리가 부모 체크아웃입니다", gitDir.canonicalPath);
		}
		const odb = await this.#checkObjectStore(gitDir.canonicalPath, checkout.canonicalPath, admission.target);
		if (!odb.ok) return { kind: "unknown", problem: odb.problem };
		const entryFile = await this.#entryFileIdentity(input.entry);
		if (entryFile.kind === "unknown") return entryFile;

		const live = input.live();
		if (!live.ok) return unknown("entry-live-refused", live.reason);
		const ownerAtEffect = await this.#slotOwner(admission.slot.slotPath);
		if (ownerAtEffect.kind === "unknown") return ownerAtEffect;
		if (ownerAtEffect.value === null || !slotOwnedBy(ownerAtEffect.value, admission.slot, admission.key, admission.item.handle)) {
			return unknown("entry-slot-not-held", "자식 진입 직전에 슬롯 소유가 바뀌었습니다", admission.slot.slotPath);
		}
		const preWorkHead = await readHead(gitDir.canonicalPath);
		const parsedStart = slotOwner.processStart === null ? undefined : Date.parse(slotOwner.processStart);
		const processStart = parsedStart !== undefined && Number.isFinite(parsedStart) && parsedStart >= 0 ? parsedStart : 0;

		const claim: ChildEntryClaim = {
			key: admission.key,
			candidateId: admission.candidateId,
			entry: { ...input.entry, childSessionFile: entryFile.value },
			childHandle: admission.item.handle,
			policyProofId: admission.policy.id,
			workerAttempt: admission.workerAdmission.attempt,
			slotOwnerToken: admission.slot.ownerToken,
			hostOwner: { pid: hostOwner.pid, processStart, host: admission.policy.host },
			checkout,
			checkoutGitDir: gitDir,
			checkoutIndexPath: index.canonicalPath,
			checkoutTargetPrefix: admission.target.targetPrefix,
			sourceOdb: admission.target.sourceOdb,
			guardBuild: admission.policy.guardBuild,
			preWorkHead,
			checkedAt: this.#now(),
		};
		const inputs = admission.subject.kind === "planned" ? admission.subject.consumed : [];
		let verified: IntegrationCheck;
		try {
			verified = await input.verifyInputs(claim, inputs);
		} catch {
			return unknown("entry-input-check-failed", "소비 입력 검증이 실패했습니다");
		}
		if (!verified.ok) return { kind: "unknown", problem: verified.problem };
		// verifyInputs is caller code and may await arbitrarily long: the durable admission, its slot and the
		// live/spend close can all change meanwhile. Re-authorize them immediately before the claim becomes durable;
		// a stale child entry must not be granted first work under closed or withdrawn authority.
		const settled = await this.readPrepared(input.worker);
		if (settled.kind === "unknown") return settled;
		if (canonicalJson(settled.value) !== canonicalJson(admission)) {
			return unknown("entry-admission-mismatch", "입력 검증 중 준비된 승인이 바뀌었습니다");
		}
		const liveAfter = input.live();
		if (!liveAfter.ok) return unknown("entry-live-refused", liveAfter.reason);
		const ownerAfterVerify = await this.#slotOwner(admission.slot.slotPath);
		if (ownerAfterVerify.kind === "unknown") return ownerAfterVerify;
		if (
			ownerAfterVerify.value === null ||
			!slotOwnedBy(ownerAfterVerify.value, admission.slot, admission.key, admission.item.handle)
		) {
			return unknown("entry-slot-not-held", "입력 검증 중 자식 네이티브 슬롯 소유가 바뀌었습니다", admission.slot.slotPath);
		}
		const written = await writeExclusive(this.#claimPath(admission.candidateId), claim);
		if (written === "failed") return unknown("entry-claim-write-failed", "자식 진입 주장을 내구성 있게 쓰지 못했습니다");
		if (written === "exists") {
			const existing = await this.readClaim(admission.key);
			if (existing.kind === "unknown") return existing;
			if (canonicalJson(existing.value.entry) !== canonicalJson(claim.entry) ||
				existing.value.checkout.canonicalPath !== claim.checkout.canonicalPath ||
				existing.value.checkoutGitDir.canonicalPath !== claim.checkoutGitDir.canonicalPath) {
				return unknown("entry-claim-conflict", "같은 승인에 다른 자식 진입 주장이 이미 있습니다");
			}
			return existing;
		}
		return { kind: "known", value: claim };
	}

	async readClaim(key: AdmissionKey): Promise<IntegrationRead<ChildEntryClaim>> {
		if (!isAdmissionKey(key)) return unknown("claim-key-invalid", "진입 주장 키가 올바르지 않습니다");
		const candidateId = integrationCandidateId(key);
		const parsed = await readJsonFile(this.#claimPath(candidateId));
		if (parsed === undefined) return unknown("claim-missing", "내구성 있는 자식 진입 주장이 없습니다");
		if (!isChildClaim(parsed, key)) return unknown("claim-invalid", "자식 진입 주장이 올바르지 않습니다");
		return { kind: "known", value: parsed };
	}

	async #matchTarget(admission: FrozenIntegrationAdmission): Promise<IntegrationCheck> {
		const identities: Array<[string, SpaceIdentity]> = [
			["authorizedRoot", admission.target.authorizedRoot],
			["gitRoot", admission.target.gitRoot],
			["gitDir", admission.target.gitDir],
			["sourceCommonDir", admission.target.sourceOdb.commonDir],
			["sourceObjects", admission.target.sourceOdb.objects],
		];
		for (const [label, identity] of identities) {
			let statValue;
			try {
				statValue = await statOf(identity.canonicalPath);
			} catch {
				return refused("target-missing", "승인된 대상 경로를 읽지 못했습니다", identity.canonicalPath);
			}
			if (!statValue.isDirectory || statValue.isSymbolicLink) {
				return refused("target-unsafe", "승인된 대상 경로가 안전한 디렉터리가 아닙니다", identity.canonicalPath);
			}
			const current = spaceOf(identity.canonicalPath, statValue);
			if (current.device !== identity.device || current.inode !== identity.inode) {
				return refused("target-replaced", `승인된 대상 ${label} 신원이 바뀌었습니다`, identity.canonicalPath);
			}
		}
		return { ok: true };
	}

	#checkMarker(admission: FrozenIntegrationAdmission): Promise<IntegrationCheck> {
		return (async () => {
			const markerPath = join(admission.slot.slotPath, ".omp-isolation-owner.json");
			let marker;
			try {
				marker = await statOf(markerPath);
			} catch {
				return refused("entry-marker-missing", "네이티브 슬롯 소유자 마커가 없습니다", markerPath);
			}
			if (!marker.isFile || marker.isSymbolicLink || marker.size > BigInt(MAX_MARKER_BYTES)) {
				return refused("entry-marker-unsafe", "네이티브 슬롯 소유자 마커가 안전한 파일이 아닙니다", markerPath);
			}
			const parsed = await readJsonFile(markerPath);
			if (
				!record(parsed) ||
				typeof parsed.pid !== "number" ||
				!Number.isSafeInteger(parsed.pid) ||
				parsed.pid <= 0 ||
				parsed.id !== admission.item.handle ||
				(parsed.startToken !== undefined && typeof parsed.startToken !== "string")
			) {
				return refused("entry-marker-invalid", "네이티브 슬롯 소유자 마커가 이 작업자를 가리키지 않습니다", markerPath);
			}
			const hostOwner = await this.#hostOwner();
			if (parsed.pid !== hostOwner.pid) return refused("entry-marker-pid", "네이티브 슬롯 마커의 프로세스가 다릅니다", markerPath);
			if (typeof parsed.startToken === "string" && hostOwner.processStart !== null && parsed.startToken !== hostOwner.processStart) {
				return refused("entry-marker-instance", "네이티브 슬롯 마커의 프로세스 인스턴스가 다릅니다", markerPath);
			}
			return { ok: true };
		})();
	}

	async #checkoutIdentity(childCwd: string): Promise<IntegrationRead<{ checkout: SpaceIdentity; gitDir: SpaceIdentity; index: SpaceIdentity }>> {
		let checkoutStat;
		try {
			checkoutStat = await statOf(childCwd);
		} catch {
			return unknown("entry-checkout-missing", "자식 체크아웃을 읽지 못했습니다", childCwd);
		}
		if (!checkoutStat.isDirectory || checkoutStat.isSymbolicLink) return unknown("entry-checkout-unsafe", "자식 체크아웃이 안전한 디렉터리가 아닙니다", childCwd);
		const dotGit = join(childCwd, ".git");
		let gitDirPath: string;
		try {
			const dot = await statOf(dotGit);
			if (dot.isSymbolicLink) return unknown("entry-gitdir-symlink", "자식 .git이 심볼릭 링크입니다", dotGit);
			if (dot.isDirectory) gitDirPath = dotGit;
			else if (dot.isFile) {
				const raw = (await fs.readFile(dotGit, "utf8")).slice(0, MAX_MARKER_BYTES);
				const line = raw.split("\n", 1)[0] ?? "";
				if (!line.startsWith("gitdir: ")) return unknown("entry-gitdir-invalid", "자식 .git 파일에 gitdir가 없습니다", dotGit);
				gitDirPath = resolve(childCwd, line.slice("gitdir: ".length).trim());
			} else return unknown("entry-gitdir-invalid", "자식 .git이 파일이나 디렉터리가 아닙니다", dotGit);
		} catch {
			return unknown("entry-gitdir-missing", "자식 .git을 읽지 못했습니다", dotGit);
		}
		let canonicalGitDir: string;
		try {
			canonicalGitDir = await fs.realpath(gitDirPath);
		} catch {
			return unknown("entry-gitdir-missing", "자식 Git 관리 디렉터리를 해석하지 못했습니다", gitDirPath);
		}
		const gitStat = await statOf(canonicalGitDir).catch(() => undefined);
		if (gitStat === undefined || !gitStat.isDirectory || gitStat.isSymbolicLink) {
			return unknown("entry-gitdir-unsafe", "자식 Git 관리 디렉터리가 안전하지 않습니다", canonicalGitDir);
		}
		const indexPath = join(canonicalGitDir, "index");
		const indexStat = await statOf(indexPath).catch(() => undefined);
		if (indexStat !== undefined && (!indexStat.isFile || indexStat.isSymbolicLink || indexStat.nlink !== 1n)) {
			return unknown("entry-index-unsafe", "자식 인덱스가 안전한 파일이 아닙니다", indexPath);
		}
		return {
			kind: "known",
			value: {
				checkout: spaceOf(childCwd, checkoutStat),
				gitDir: spaceOf(canonicalGitDir, gitStat),
				index: {
					canonicalPath: indexPath,
					device: (indexStat ?? gitStat).dev.toString(),
					inode: (indexStat ?? gitStat).ino.toString(),
				},
			},
		};
	}

	async #checkObjectStore(gitDir: string, checkoutRoot: string, target: IntegrationTarget): Promise<IntegrationCheck> {
		const privateDir = (path: string): boolean => {
			const rel = relative(checkoutRoot, path);
			return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
		};
		const common = await fs.realpath(await commonDirOf(gitDir)).catch(() => undefined);
		if (common === undefined || !privateDir(gitDir) || !privateDir(common)) {
			return refused("entry-admin-shared", "자식의 Git common 디렉터리가 실제 격리 체크아웃에 속하지 않습니다", gitDir);
		}
		const objectsPath = join(common, "objects");
		const objects = await statOf(objectsPath).catch(() => undefined);
		if (objects === undefined || !objects.isDirectory || objects.isSymbolicLink ||
			(objects.dev.toString() === target.sourceOdb.objects.device && objects.ino.toString() === target.sourceOdb.objects.inode)) {
			return refused("entry-object-source", "자식의 Git 객체 디렉터리가 별도의 실제 디렉터리가 아닙니다", objectsPath);
		}
		const configPath = join(common, "config");
		let format: "sha1" | "sha256" = "sha1";
		try {
			const text = (await fs.readFile(configPath, "utf8")).slice(0, 256 * 1024);
			const section = /\[extensions\]([^[]*)/u.exec(text)?.[1] ?? "";
			const value = /^\s*objectformat\s*=\s*(\S+)\s*$/imu.exec(section)?.[1];
			if (value === "sha256") format = "sha256";
			else if (value !== undefined && value !== "sha1") return refused("entry-object-format", "자식 객체 형식을 지원하지 않습니다", configPath);
		} catch {
			return refused("entry-config-missing", "자식 Git 설정을 읽지 못했습니다", configPath);
		}
		if (format !== target.sourceOdb.objectFormat) {
			return refused("entry-object-format", "자식 객체 형식이 소스 ODB와 다릅니다", configPath);
		}
		const alternatesPath = join(objectsPath, "info", "alternates");
		try {
			const stat = await statOf(alternatesPath);
			if (!stat.isFile || stat.isSymbolicLink || stat.size > 256n * 1024n) {
				return refused("entry-object-source", "자식 객체 저장소의 alternates가 안전한 파일이 아닙니다", alternatesPath);
			}
			const alternates = (await fs.readFile(alternatesPath, "utf8")).split("\n").map(line => line.trim()).filter(Boolean);
			const sourceObjects = target.sourceOdb.objects.canonicalPath;
			for (const alternate of alternates) {
				const canonical = await fs.realpath(resolve(objectsPath, alternate)).catch(() => undefined);
				if (canonical === sourceObjects) return { ok: true };
			}
			return refused("entry-object-source", "자식의 detached 객체 저장소가 승인된 소스 ODB를 가리키지 않습니다", alternatesPath);
		} catch (error) {
			// Native copy / APFS clones keep a private object store without alternates. At terminal capture the host
			// builds synthetic root trees in the original, attested worktree ODB, not this private copy.
			if (!record(error) || error.code !== "ENOENT") {
				return refused("entry-object-source", "자식 객체 저장소의 alternates를 확인할 수 없습니다", alternatesPath);
			}
		}
		return { ok: true };
	}

	async #entryFileIdentity(entry: ObservationIdentity): Promise<IntegrationRead<SpaceIdentity>> {
		if (!isSpaceIdentity(entry.childSessionFile)) return unknown("entry-session-invalid", "자식 세션 파일 신원이 올바르지 않습니다");
		try {
			if (entry.hostSessionFile !== undefined && await fs.realpath(entry.hostSessionFile) !== entry.childSessionFile.canonicalPath) {
				return unknown("entry-session-invalid", "호스트 세션 경로와 물리 파일이 다릅니다", entry.hostSessionFile);
			}
			const stat = await statOf(entry.childSessionFile.canonicalPath);
			if (!stat.isFile || stat.isSymbolicLink) return unknown("entry-session-unsafe", "자식 세션 파일이 안전한 파일이 아닙니다");
			const identity = spaceOf(entry.childSessionFile.canonicalPath, stat);
			if (identity.device !== entry.childSessionFile.device || identity.inode !== entry.childSessionFile.inode) {
				return unknown("entry-session-replaced", "자식 세션 파일 신원이 관측과 다릅니다");
			}
			return { kind: "known", value: identity };
		} catch {
			return unknown("entry-session-missing", "자식 세션 파일을 읽지 못했습니다");
		}
	}
}

function sameSpace(a: SpaceIdentity, b: SpaceIdentity): boolean {
	return resolve(a.canonicalPath) === resolve(b.canonicalPath) && a.device === b.device && a.inode === b.inode;
}

function isObservation(value: unknown): value is ObservationIdentity {
	return (
		record(value) &&
		boundedId(value.registryInstance) &&
		typeof value.generation === "number" &&
		Number.isSafeInteger(value.generation) &&
		value.generation >= 0 &&
		isSpaceIdentity(value.childSessionFile) &&
		(value.hostSessionFile === undefined || boundedPath(value.hostSessionFile))
	);
}

function isChildClaim(value: unknown, key?: AdmissionKey): value is ChildEntryClaim {
	if (!record(value)) return false;
	if (!isAdmissionKey(value.key) || !isIntegrationCandidateId(value.candidateId)) return false;
	if (key !== undefined && (value.key.runId !== key.runId || value.key.dispatch !== key.dispatch || value.candidateId !== integrationCandidateId(key))) return false;
	if (!isObservation(value.entry) || !boundedId(value.childHandle) || !boundedId(value.policyProofId)) return false;
	if (typeof value.workerAttempt !== "string" || !ATTEMPT.test(value.workerAttempt)) return false;
	if (!boundedId(value.slotOwnerToken) || !record(value.hostOwner)) return false;
	if (typeof value.hostOwner.pid !== "number" || !Number.isSafeInteger(value.hostOwner.pid) || typeof value.hostOwner.processStart !== "number" || !boundedId(value.hostOwner.host)) return false;
	if (!isSpaceIdentity(value.checkout) || !isSpaceIdentity(value.checkoutGitDir)) return false;
	if (!boundedPath(value.checkoutIndexPath) || typeof value.checkoutTargetPrefix !== "string") return false;
	if (!isObjectSource(value.sourceOdb) || !boundedId(value.guardBuild)) return false;
	if (value.preWorkHead !== null && (typeof value.preWorkHead !== "string" || !/^[0-9a-f]{40,64}$/u.test(value.preWorkHead))) return false;
	return typeof value.checkedAt === "number" && Number.isSafeInteger(value.checkedAt) && value.checkedAt > 0;
}

async function commonDirOf(gitDir: string): Promise<string> {
	try {
		const raw = (await fs.readFile(join(gitDir, "commondir"), "utf8")).trim();
		if (raw !== "") return await fs.realpath(resolve(gitDir, raw));
	} catch {
		// A normal repository has no commondir.
	}
	return gitDir;
}

async function readHead(gitDir: string): Promise<string | null> {
	try {
		const head = (await fs.readFile(join(gitDir, "HEAD"), "utf8")).trim();
		if (/^[0-9a-f]{40,64}$/u.test(head)) return head;
		if (!head.startsWith("ref: ")) return null;
		const ref = head.slice("ref: ".length).trim();
		if (ref === "" || ref.includes("..") || CONTROL.test(ref)) return null;
		try {
			const value = (await fs.readFile(join(gitDir, ref), "utf8")).trim();
			return /^[0-9a-f]{40,64}$/u.test(value) ? value : null;
		} catch {
			try {
				const packed = await fs.readFile(join(gitDir, "packed-refs"), "utf8");
				for (const line of packed.split("\n")) {
					const [oid, name] = line.trim().split(" ");
					if (oid !== undefined && name === ref && /^[0-9a-f]{40,64}$/u.test(oid)) return oid;
				}
			} catch {
				// no packed refs
			}
			return null;
		}
	} catch {
		return null;
	}
}
