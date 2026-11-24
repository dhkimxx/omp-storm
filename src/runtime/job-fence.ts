/**
 * Durable, same-user fences for configured-job execution.
 *
 * Resource locks in `job-executor.ts` serialize the keys a job declares. A target marker is different: it records that
 * this user actually spawned a job in one canonical worktree, keyed by `stat` dev+ino so two paths to the same tree
 * share one marker. A marker is written after the resource locks and immediately before the spawn; it is removed only
 * after the OS proves the child ended, or when no child was started. If OMP crashes, or teardown cannot prove the end,
 * the marker stays behind and `targetJobBlock` tells the next run (and a human) exactly which file to verify and
 * remove. Markers are per job and per token, so distinct jobs of one approved batch may overlap in the same worktree;
 * a new run is stopped by the controller's read of `targetJobBlock`, never by a timeout or a dead PID alone.
 *
 * The namespace is host-global for one user, outside the target tree, at the same fixed root as the resource locks.
 * Records are published by rename so a reader never sees a partial JSON document, and every directory is accepted only
 * when it is a real directory private to this user.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_CHECK_NAME_LENGTH } from "../config/schema.ts";

/** Target markers are small; anything larger is not one of ours and must not be parsed. */
const MAX_MARKER_BYTES = 16_384;
const MAX_HOST_LENGTH = 255;
const MAX_ROOT_LENGTH = 4_096;
const MAX_IDENTITY_LENGTH = 1_024;
const TOKEN_RE = /^[A-Za-z0-9-]{8,128}$/;
const TARGET_SCHEMA = "storm.job-target/v1";
const TARGETS_DIR = "targets";

/** Same hostname rule as the resource locks: an unusable hostname becomes one shared `unknown-host` value. */
export const HOST = (() => {
	const hostname = os.hostname();
	if (hostname.length > 0 && hostname.length <= MAX_HOST_LENGTH && !/[\u0000-\u001f\u007f]/.test(hostname)) {
		return hostname;
	}
	return "unknown-host";
})();
/** Identifies this process incarnation; a recycled PID with a different start time is not this process. */
export const PROCESS_START = Math.round(performance.timeOrigin);

export interface FenceOwner {
	token: string;
	pid: number;
	host: string;
	processStart: number;
}

export type OwnerState = "alive" | "dead" | "unknown";

export function errorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code.slice(0, 40);
	}
	return "알 수 없는 오류";
}

export function isFenceOwner(value: unknown): value is FenceOwner {
	if (typeof value !== "object" || value === null) return false;
	const owner = value as Record<string, unknown>;
	if (typeof owner.token !== "string" || !TOKEN_RE.test(owner.token)) return false;
	if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
	if (
		typeof owner.host !== "string" ||
		owner.host.length === 0 ||
		owner.host.length > MAX_HOST_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(owner.host)
	) {
		return false;
	}
	return typeof owner.processStart === "number" && Number.isFinite(owner.processStart) && owner.processStart > 0;
}

/** A fixed base, not `os.tmpdir()`: TMPDIR can differ between sessions and would split one user's fences. */
function lockBaseDir(): string {
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	const base = process.platform === "darwin" || process.platform === "linux" ? "/tmp" : os.tmpdir();
	return path.join(base, `omp-storm-jobs-${uid}`, "v1");
}

/** Read-only form of the directory check, so `targetJobBlock` never creates anything. */
async function inspectPrivateDir(dir: string): Promise<{ ok: true } | { ok: false; detail: string }> {
	try {
		const st = await fs.stat(dir, { bigint: true });
		if (!st.isDirectory()) return { ok: false, detail: "잠금 경로가 디렉터리가 아닙니다" };
		if (typeof process.getuid === "function" && Number(st.uid) !== process.getuid()) {
			return { ok: false, detail: "잠금 디렉터리의 소유자가 이 사용자가 아닙니다" };
		}
		if ((Number(st.mode) & 0o077) !== 0) {
			return { ok: false, detail: "잠금 디렉터리가 이 사용자 전용이 아닙니다 (0700 필요)" };
		}
	} catch (error) {
		return { ok: false, detail: `잠금 디렉터리를 확인할 수 없습니다 (${errorCode(error)})` };
	}
	return { ok: true };
}

/**
 * Creates a directory 0700 and accepts an existing one only when it is a real directory private to this user.
 * `container`, when set, must contain the real path: a symlink that escapes the fence namespace is refused.
 */
async function ensurePrivateDir(
	dir: string,
	container?: string,
): Promise<{ ok: true; dir: string } | { ok: false; detail: string }> {
	try {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	} catch (error) {
		return { ok: false, detail: `잠금 디렉터리를 만들 수 없습니다 (${errorCode(error)})` };
	}
	let real: string;
	try {
		real = await fs.realpath(dir);
	} catch (error) {
		return { ok: false, detail: `잠금 디렉터리를 확인할 수 없습니다 (${errorCode(error)})` };
	}
	if (container !== undefined && real !== container && !real.startsWith(container + path.sep)) {
		return { ok: false, detail: "잠금 디렉터리가 이 사용자의 잠금 범위를 벗어났습니다" };
	}
	const checked = await inspectPrivateDir(real);
	if (!checked.ok) return checked;
	return { ok: true, dir: real };
}

/** Creates the host-global lock root, the parent of both resource locks and target markers. */
export function ensureLockDir(): Promise<{ ok: true; dir: string } | { ok: false; detail: string }> {
	return ensurePrivateDir(lockBaseDir());
}

/**
 * Conservative liveness. Another host is `unknown` (this namespace is local only) and an unreadable probe is
 * `unknown`. `dead` is not permission to reclaim a fence: a detached child process group can outlive its parent.
 */
export function ownerState(owner: FenceOwner): OwnerState {
	if (owner.host !== HOST) return "unknown";
	if (owner.pid === process.pid) return owner.processStart === PROCESS_START ? "alive" : "dead";
	try {
		process.kill(owner.pid, 0);
		return "alive";
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

interface CanonicalTarget {
	/** Real path, used only in messages; identity is what names the marker directory. */
	root: string;
	identity: string;
}

async function canonicalTarget(
	root: string,
): Promise<{ ok: true; target: CanonicalTarget } | { ok: false; detail: string }> {
	if (typeof root !== "string" || root.trim() === "") return { ok: false, detail: "작업 대상 경로가 비어 있습니다" };
	if (root.length > MAX_ROOT_LENGTH) return { ok: false, detail: `작업 대상 경로가 ${MAX_ROOT_LENGTH}자를 넘습니다` };
	let real: string;
	try {
		real = await fs.realpath(root);
	} catch (error) {
		return { ok: false, detail: `작업 대상 경로를 확인할 수 없습니다: ${root} (${errorCode(error)})` };
	}
	try {
		const st = await fs.stat(real, { bigint: true });
		if (!st.isDirectory()) return { ok: false, detail: `작업 대상이 디렉터리가 아닙니다: ${real}` };
		const identity = st.ino !== 0n ? `dev:${st.dev.toString()}:ino:${st.ino.toString()}` : `path:${real}`;
		if (identity.length > MAX_IDENTITY_LENGTH) {
			return { ok: false, detail: "작업 대상의 정체성 정보가 너무 깁니다" };
		}
		return { ok: true, target: { root: real, identity } };
	} catch (error) {
		return { ok: false, detail: `작업 대상 상태를 확인할 수 없습니다: ${real} (${errorCode(error)})` };
	}
}

function targetHash(identity: string): string {
	return createHash("sha256").update(identity).digest("hex");
}

interface TargetMarkerRecord {
	schema: typeof TARGET_SCHEMA;
	identity: string;
	root: string;
	/** The approved job name, for the human who has to verify the marker. Never command text. */
	job: string;
	owner: FenceOwner;
	startedAt: string;
}

type MarkerRead =
	| { kind: "missing" }
	| { kind: "invalid"; detail: string }
	| { kind: "valid"; record: TargetMarkerRecord };

function isTargetRecord(value: unknown, identity: string): value is TargetMarkerRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.schema !== TARGET_SCHEMA || record.identity !== identity) return false;
	if (
		typeof record.root !== "string" ||
		record.root.length === 0 ||
		record.root.length > MAX_ROOT_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(record.root)
	) {
		return false;
	}
	if (
		typeof record.job !== "string" ||
		record.job.length === 0 ||
		record.job.length > MAX_CHECK_NAME_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(record.job)
	) {
		return false;
	}
	if (!isFenceOwner(record.owner)) return false;
	return typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt));
}

/** Opens without following a symlink and reads a bounded record; any failure other than ENOENT is `invalid`. */
async function readMarker(file: string, identity: string): Promise<MarkerRead> {
	let handle: FileHandle;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", detail: `표시 파일을 열 수 없습니다 (${errorCode(error)})` };
	}
	try {
		const st = await handle.stat({ bigint: true });
		if (!st.isFile()) return { kind: "invalid", detail: "표시 파일이 일반 파일이 아닙니다" };
		if (st.size > BigInt(MAX_MARKER_BYTES)) return { kind: "invalid", detail: "표시 파일이 너무 큽니다" };
		let text: string;
		try {
			text = await handle.readFile({ encoding: "utf8" });
		} catch (error) {
			return { kind: "invalid", detail: `표시 파일을 읽을 수 없습니다 (${errorCode(error)})` };
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return { kind: "invalid", detail: "JSON이 아닙니다" };
		}
		if (!isTargetRecord(value, identity)) return { kind: "invalid", detail: "표시 기록 형식이 올바르지 않습니다" };
		return { kind: "valid", record: value };
	} catch (error) {
		return { kind: "invalid", detail: `표시 파일을 확인할 수 없습니다 (${errorCode(error)})` };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function markerFiles(dir: string): Promise<string[]> {
	const names = await fs.readdir(dir);
	return names.filter((name) => name.endsWith(".marker")).map((name) => path.join(dir, name)).sort();
}

export interface TargetMarker {
	path: string;
	token: string;
	identity: string;
}

export type TargetMarkerRefusal = "owner-dead" | "owner-unknown" | "record-invalid" | "invalid";

/**
 * Writes one durable marker for this spawn. Markers owned by this process are allowed: jobs of one approved batch
 * overlap in the same worktree. Any other marker stops the attempt, because a dead or unverifiable owner may still
 * have a detached child running.
 */
export async function acquireTargetMarker(
	root: string,
	job: string,
): Promise<{ ok: true; marker: TargetMarker } | { ok: false; cause: TargetMarkerRefusal; detail: string }> {
	const canonical = await canonicalTarget(root);
	if (!canonical.ok) return { ok: false, cause: "invalid", detail: canonical.detail };
	const target = canonical.target;
	const base = await ensureLockDir();
	if (!base.ok) return { ok: false, cause: "invalid", detail: base.detail };
	const targets = await ensurePrivateDir(path.join(base.dir, TARGETS_DIR), base.dir);
	if (!targets.ok) return { ok: false, cause: "invalid", detail: targets.detail };
	const dir = await ensurePrivateDir(path.join(targets.dir, targetHash(target.identity)), targets.dir);
	if (!dir.ok) return { ok: false, cause: "invalid", detail: dir.detail };

	let files: string[];
	try {
		files = await markerFiles(dir.dir);
	} catch (error) {
		return { ok: false, cause: "invalid", detail: `작업 대상 표시 목록을 읽을 수 없습니다 (${errorCode(error)})` };
	}
	for (const file of files) {
		const read = await readMarker(file, target.identity);
		if (read.kind === "missing") continue;
		if (read.kind === "invalid") {
			return {
				ok: false,
				cause: "record-invalid",
				detail: `작업 대상 표시를 확인할 수 없습니다: ${file} (${read.detail}). 실행 중인 자식 프로세스가 없는지 확인한 뒤 이 파일을 직접 지우세요.`,
			};
		}
		const owner = read.record.owner;
		if (owner.pid === process.pid && owner.processStart === PROCESS_START) continue;
		const state = owner.host === HOST ? ownerState(owner) : "unknown";
		if (state === "dead") {
			return {
				ok: false,
				cause: "owner-dead",
				detail: `작업 대상 ${target.root}의 표시 소유자(pid ${owner.pid}, 호스트 ${owner.host})가 종료된 것으로 보이지만, 그 프로세스가 띄운 자식 프로세스 그룹이 아직 실행 중일 수 있어 자동으로 지우지 않았습니다. 실행 중인 자식이 없는지 확인한 뒤 이 파일을 직접 지우세요: ${file}`,
			};
		}
		if (state === "alive") {
			return {
				ok: false,
				cause: "owner-unknown",
				detail: `작업 대상 ${target.root}의 표시 소유자(pid ${owner.pid}, 호스트 ${owner.host})가 아직 실행 중이라 시작하지 않았습니다. 그 실행이 끝난 뒤 다시 시도하세요: ${file}`,
			};
		}
		return {
			ok: false,
			cause: "owner-unknown",
			detail: `작업 대상 ${target.root}의 표시 소유자(pid ${owner.pid}, 호스트 ${owner.host})가 종료됐는지 확인할 수 없습니다. 실행 중인 자식이 없는지 확인한 뒤 이 파일을 직접 지우세요: ${file}`,
		};
	}

	const token = randomUUID();
	const record: TargetMarkerRecord = {
		schema: TARGET_SCHEMA,
		identity: target.identity,
		root: target.root,
		job: job.trim().slice(0, MAX_CHECK_NAME_LENGTH) || "job",
		owner: { token, pid: process.pid, host: HOST, processStart: PROCESS_START },
		startedAt: new Date().toISOString(),
	};
	const file = path.join(dir.dir, `${token}.marker`);
	const tmp = path.join(dir.dir, `.${token}.tmp`);
	let handle: FileHandle;
	try {
		handle = await fs.open(tmp, "wx", 0o600);
	} catch (error) {
		return { ok: false, cause: "invalid", detail: `작업 대상 표시를 준비할 수 없습니다 (${errorCode(error)})` };
	}
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		await fs.unlink(tmp).catch(() => undefined);
		return { ok: false, cause: "invalid", detail: `작업 대상 표시를 쓸 수 없습니다 (${errorCode(error)})` };
	} finally {
		await handle.close().catch(() => undefined);
	}
	try {
		// The rename publishes a complete record; a reader never parses a half-written marker.
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.unlink(tmp).catch(() => undefined);
		return { ok: false, cause: "invalid", detail: `작업 대상 표시를 게시할 수 없습니다 (${errorCode(error)})` };
	}
	return { ok: true, marker: { path: file, token, identity: target.identity } };
}

/** Removes only this exact token; a missing file is already released, anything else is a retained fence. */
export async function releaseTargetMarker(
	marker: TargetMarker,
): Promise<{ ok: true } | { ok: false; detail: string }> {
	const read = await readMarker(marker.path, marker.identity);
	if (read.kind === "missing") return { ok: true };
	if (read.kind === "invalid") {
		// An unreadable record is not proof the file is ours; leave it for manual verification.
		return { ok: false, detail: `작업 대상 표시를 확인할 수 없어 해제하지 않았습니다: ${marker.path} (${read.detail})` };
	}
	if (read.record.owner.token !== marker.token) {
		return { ok: false, detail: `작업 대상 표시의 소유자가 바뀌어 해제하지 않았습니다: ${marker.path}` };
	}
	try {
		await fs.unlink(marker.path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { ok: true };
		return { ok: false, detail: `작업 대상 표시를 해제하지 못했습니다 (${errorCode(error)}): ${marker.path}` };
	}
	return { ok: true };
}

/**
 * Read-only guard for the controller: any marker for this canonical worktree means a previous spawn was not proven
 * ended (or another run is still inside it). It never removes anything; a human or the owning process must. A missing
 * namespace, an unreadable namespace, or an unverifiable target is reported as blocked rather than assumed clear.
 */
export async function targetJobBlock(root: string): Promise<string | undefined> {
	const canonical = await canonicalTarget(root);
	if (!canonical.ok) {
		return `작업 대상의 정체성을 확인할 수 없어 정형 작업을 시작할 수 없습니다: ${canonical.detail}`;
	}
	const target = canonical.target;
	let base: string;
	try {
		base = await fs.realpath(lockBaseDir());
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return `정형 작업 잠금 영역을 확인할 수 없어 시작할 수 없습니다: ${lockBaseDir()} (${errorCode(error)})`;
	}
	const baseCheck = await inspectPrivateDir(base);
	if (!baseCheck.ok) return `정형 작업 잠금 영역을 신뢰할 수 없어 시작할 수 없습니다: ${baseCheck.detail}`;
	const targetsPath = path.join(base, TARGETS_DIR);
	let targetsReal: string;
	try {
		targetsReal = await fs.realpath(targetsPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return `작업 대상 표시 영역을 확인할 수 없어 시작할 수 없습니다: ${targetsPath} (${errorCode(error)})`;
	}
	if (!targetsReal.startsWith(base + path.sep)) {
		return `작업 대상 표시 영역이 잠금 범위를 벗어나 시작할 수 없습니다: ${targetsReal}`;
	}
	const targetsCheck = await inspectPrivateDir(targetsReal);
	if (!targetsCheck.ok) {
		return `작업 대상 표시 영역을 신뢰할 수 없어 시작할 수 없습니다: ${targetsCheck.detail}`;
	}
	const dir = path.join(targetsReal, targetHash(target.identity));
	let realDir: string;
	try {
		realDir = await fs.realpath(dir);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return `작업 대상 표시 영역을 확인할 수 없어 시작할 수 없습니다: ${dir} (${errorCode(error)})`;
	}
	if (!realDir.startsWith(targetsReal + path.sep)) {
		return `작업 대상 표시 영역이 잠금 범위를 벗어나 시작할 수 없습니다: ${realDir}`;
	}
	const dirCheck = await inspectPrivateDir(realDir);
	if (!dirCheck.ok) return `작업 대상 표시 영역을 신뢰할 수 없어 시작할 수 없습니다: ${dirCheck.detail}`;
	let files: string[];
	try {
		files = await markerFiles(realDir);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return `작업 대상 표시 목록을 읽을 수 없어 시작할 수 없습니다: ${realDir} (${errorCode(error)})`;
	}
	for (const file of files) {
		const read = await readMarker(file, target.identity);
		if (read.kind === "missing") continue;
		if (read.kind === "invalid") {
			return `작업 대상 ${target.root}에 정형 작업 표시가 남아 있습니다: ${file} (표시 기록을 확인할 수 없습니다: ${read.detail}). 실행 중인 자식 프로세스가 없는지 확인한 뒤 이 표시 파일을 직접 지워야 합니다.`;
		}
		const owner = read.record.owner;
		const state = owner.host === HOST ? ownerState(owner) : "unknown";
		const subject = `작업 ${read.record.job}, pid ${owner.pid}, 호스트 ${owner.host}`;
		if (owner.pid === process.pid && owner.processStart === PROCESS_START) {
			return `작업 대상 ${target.root}에 이 프로세스가 남긴 정형 작업 표시가 있습니다: ${file} (${subject}). 자식 프로세스가 남아 있지 않은지 확인한 뒤 이 표시 파일을 직접 지워야 합니다.`;
		}
		if (state === "alive") {
			return `작업 대상 ${target.root}에 정형 작업 표시가 남아 있습니다: ${file} (${subject}, 아직 실행 중). 그 실행이 끝날 때까지 기다린 뒤, 표시가 남아 있으면 실행 중인 자식 프로세스가 없는지 확인하고 이 파일을 직접 지워야 합니다.`;
		}
		const reason =
			state === "dead"
				? "종료된 것으로 보이지만 자식 프로세스가 남아 있을 수 있음"
				: "종료 여부를 확인할 수 없음";
		return `작업 대상 ${target.root}에 정형 작업 표시가 남아 있습니다: ${file} (${subject}, ${reason}). 실행 중인 자식 프로세스가 없는지 확인한 뒤 이 표시 파일을 직접 지워야 합니다.`;
	}
	return undefined;
}
