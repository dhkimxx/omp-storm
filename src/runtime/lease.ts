/**
 * Per-worktree execution lease: at most one OMP process may run a Storm run in one worktree.
 *
 * The lock is a hard link into a private per-user directory outside the work tree
 * (`<os.tmpdir()>/omp-storm-leases-<uid>`, or an absolute `OMP_STORM_LEASE_DIR`). Because the record is written to a
 * temp file first and then linked into place, the lock either does not exist or carries a complete owner record; there
 * is no check-then-write window, and no partial owner can be observed. The directory is never inside the work tree, so
 * the lock never shows up in `git status`, a diff, or a scan of the repository, and it is not one of Git's own
 * `.git/*.lock` files, which this module never reads, writes or deletes.
 *
 * Scope: one worktree, not one repository. The key is the canonical worktree directory's (device, inode), so a linked
 * worktree (`git worktree add`) gets its own execution slot even though it shares the repository's common Git dir.
 * Symlinked or differently cased aliases of the same directory canonicalize to that same key. Project-wide team
 * approval is a different concern and stays keyed by `RepoIdentity.repoId`; this lease must not be used to scope
 * approvals. Non-Git roots work the same way: any existing directory gets its own slot. No `git` command is run and
 * `.git` is never read or written. Callers must pass the worktree top level, not a subdirectory; a subdirectory is a
 * different directory and therefore a different slot.
 *
 * Platform: macOS and Linux. Both provide atomic `link(2)` (`EEXIST`, never overwrite) and `mkdir(2)` (`EEXIST`) on
 * local filesystems. Hard links are required; filesystems that reject them fail closed with a reason. Other platforms
 * fail closed.
 *
 * Owner identity: host + pid + process start (`performance.timeOrigin`) identifies the OS process; a random
 * acquisition nonce separates two acquisitions by the same process. `runId` is recorded for diagnostics. `release()`
 * accepts only the nonce returned with this lease and refuses to unlink a record whose token/runId is not its own.
 * This is an exclusion protocol between OMP processes of one OS user, not a security boundary against that user.
 *
 * Crash recovery is conservative, never TTL based:
 * - The recorded owner is probed on every acquisition. `alive` refuses. `unknown` (another host, an unreadable probe,
 *   an unexpected signal error) refuses and names the lock for a human check. Only `dead` may be reclaimed.
 * - Reclaim takes an exclusive `<lock>.reclaim` directory first, re-reads the lock under it, probes the re-read owner
 *   again, verifies the path still names the same inode, and only then unlinks the dead lock. A new owner can appear
 *   only after that unlink, so this process never deletes a lock that belongs to a live or newly acquired owner.
 * - A process that dies in the tiny reclaim critical section leaves the empty guard behind. No TTL removes it:
 *   acquisition fails closed with the guard's path and tells the user to remove it only after confirming no OMP run is
 *   active. The stale lock itself (the common crash) is reclaimed automatically.
 * - Reused pids other than our own make the default probe say `alive` for an unrelated process. That refuses rather
 *   than risks stealing a live lease; a human must verify the recorded owner. A record carrying our pid with a
 *   different process start is provably from a dead earlier process and is reclaimed. The lease dir must not be shared
 *   between containers, VMs or PID namespaces, where `kill(pid, 0)` cannot prove global death.
 *
 * Caller obligations:
 * - Acquire once per run, as the last step before execution starts (after dialogs and compaction), and hold the lease
 *   for the whole run, subagents included.
 * - `release()` in a `finally` exactly once, including failed/aborted starts. It throws if the lock disappeared or its
 *   owner changed; surface that instead of ignoring it, because another process may now own the worktree.
 * - A failed acquisition is a refusal to run. Report `reason` as-is; do not proceed without a lease.
 * - All contenders must resolve to the same lease directory. The default is profile-independent; only override
 *   `OMP_STORM_LEASE_DIR` with an absolute directory outside every worktree/repository, when every OMP profile that
 *   can run in this worktree sees the same path.
 */
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SCHEMA = "storm.lease/v1";
const LEASE_DIR_ENV = "OMP_STORM_LEASE_DIR";
/** Owner probes are small; anything larger is not one of ours and must not be parsed. */
const MAX_RECORD_BYTES = 16_384;
/** Contenders that lose a reclaim guard wait for the short critical section to end. */
const MAX_ATTEMPTS = 40;
const RETRY_MS = 10;
const MAX_RUN_ID = 200;

/** Exact owner identity when the lease was taken. */
export interface LeaseOwner {
	/** Random per acquisition; `release()` accepts only this ownership nonce. */
	token: string;
	pid: number;
	host: string;
	/** `Math.round(performance.timeOrigin)` of the owning process: tells pid reuse apart. */
	processStart: number;
}

/** The complete lock record on disk. */
export interface LeaseRecord {
	schema: typeof SCHEMA;
	/** `sha256("<device>:<inode>")` of the canonical worktree directory. */
	worktree: string;
	/** Canonical (`realpath`) worktree top level. */
	root: string;
	runId: string;
	owner: LeaseOwner;
	/** ISO 8601, display only; never used for staleness. */
	acquiredAt: string;
}

/** Result of asking whether the recorded owner may still run. Only `dead` permits reclaim. */
export type LeaseOwnerStatus = "alive" | "dead" | "unknown";

/** Narrow test hooks. Production callers omit both. */
export interface LeaseDeps {
	/** Absolute directory for lock files; tests pass a temp dir. Defaults to the per-user OS temp dir. */
	dir?: string;
	/**
	 * Owner liveness probe for tests or special hosts. It must return `dead` only when death is proven; any doubt is
	 * `unknown`. The default on macOS/Linux uses the hostname and `kill(pid, 0)`.
	 */
	liveness?: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>;
}

/** A held execution slot. Keep it for the whole run; `release()` is the only way to open the slot. */
export interface RunLease {
	readonly runId: string;
	/** Canonical worktree top level the lease is keyed by. */
	readonly root: string;
	/** Absolute lock file; diagnostics and tests only. Do not touch it directly. */
	readonly path: string;
	readonly owner: Readonly<LeaseOwner>;
	readonly record: Readonly<LeaseRecord>;
	release(): Promise<void>;
}

export type AcquireRunLeaseResult = { ok: true; lease: RunLease } | { ok: false; reason: string };

function fail(reason: string): AcquireRunLeaseResult {
	return { ok: false, reason };
}

function errCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function errText(error: unknown): string {
	const code = errCode(error);
	if (code !== undefined) return code;
	return error instanceof Error ? error.message : String(error);
}

function cleanId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_RUN_ID &&
		/^[A-Za-z0-9._:-]+$/.test(value)
	);
}

function cleanToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9-]{8,128}$/.test(value);
}

function isOwner(value: unknown): value is LeaseOwner {
	if (typeof value !== "object" || value === null) return false;
	if (!("token" in value) || !cleanToken(value.token)) return false;
	if (!("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
		return false;
	}
	if (
		!("host" in value) ||
		typeof value.host !== "string" ||
		value.host.length === 0 ||
		value.host.length > 255 ||
		/[\u0000-\u001f\u007f]/.test(value.host)
	) {
		return false;
	}
	return (
		"processStart" in value &&
		typeof value.processStart === "number" &&
		Number.isFinite(value.processStart) &&
		value.processStart > 0
	);
}

/** A record is valid only for the worktree whose lock path carried it. */
function isLeaseRecord(value: unknown, worktree: string): value is LeaseRecord {
	if (typeof value !== "object" || value === null) return false;
	if (!("schema" in value) || value.schema !== SCHEMA) return false;
	if (!("worktree" in value) || value.worktree !== worktree) return false;
	if (
		!("root" in value) ||
		typeof value.root !== "string" ||
		value.root.length === 0 ||
		value.root.length > 4_096 ||
		value.root.includes("\u0000")
	) {
		return false;
	}
	if (!("runId" in value) || !cleanId(value.runId)) return false;
	if (!("owner" in value) || !isOwner(value.owner)) return false;
	return (
		"acquiredAt" in value &&
		typeof value.acquiredAt === "string" &&
		Number.isFinite(Date.parse(value.acquiredAt))
	);
}

/** `child` is `parent` or below it, after both were canonicalized. */
function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function defaultLeaseDir(): { dir: string } | { reason: string } {
	const configured = process.env[LEASE_DIR_ENV];
	if (configured !== undefined && configured !== "") {
		if (!path.isAbsolute(configured)) {
			return { reason: `${LEASE_DIR_ENV}는 절대 경로여야 합니다: ${configured}` };
		}
		return { dir: configured };
	}
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return { dir: path.join(os.tmpdir(), `omp-storm-leases-${uid}`) };
}

/**
 * The path a not-yet-created directory will have once its existing ancestor is resolved: catches a parent symlink
 * that points inside the worktree before anything is created there.
 */
async function prospectivePath(target: string): Promise<string | undefined> {
	let current = path.resolve(target);
	const missing: string[] = [];
	for (;;) {
		try {
			const real = await fs.realpath(current);
			return path.join(real, ...missing.reverse());
		} catch (error) {
			if (errCode(error) !== "ENOENT") return undefined;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			missing.push(path.basename(current));
			current = parent;
		}
	}
}

/** Creates the lease directory 0700 and accepts an existing one only if it is private to this user. */
async function prepareLeaseDir(dir: string, root: string): Promise<{ dir: string } | { reason: string }> {
	if (!path.isAbsolute(dir)) return { reason: `잠금 디렉터리는 절대 경로여야 합니다: ${dir}` };
	let created: string | undefined = undefined;
	try {
		// A defined result means this call created the final directory (possibly together with missing parents), so it
		// is ours to tighten even under an unusual umask. An already existing directory is never chmodded.
		created = await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	} catch (error) {
		return { reason: `잠금 디렉터리를 만들 수 없습니다: ${dir} (${errText(error)})` };
	}
	let real: string;
	try {
		real = await fs.realpath(dir);
	} catch (error) {
		return { reason: `잠금 디렉터리를 확인할 수 없습니다: ${dir} (${errText(error)})` };
	}
	if (isInside(root, real)) {
		return { reason: `잠금 디렉터리가 worktree 안에 있습니다: ${real}. worktree 밖의 디렉터리를 지정하세요.` };
	}
	try {
		const st = await fs.lstat(real, { bigint: true });
		if (!st.isDirectory()) return { reason: `잠금 경로가 디렉터리가 아닙니다: ${real}` };
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (uid !== undefined && st.uid !== BigInt(uid)) {
			return { reason: `잠금 디렉터리가 다른 사용자 소유입니다: ${real}. 이 OMP 사용자만 쓸 수 있는 디렉터리를 지정하세요.` };
		}
		if (created !== undefined) {
			await fs.chmod(real, 0o700);
		} else if ((st.mode & 0o077n) !== 0n) {
			const mode = (st.mode & 0o777n).toString(8).padStart(3, "0");
			return {
				reason: `잠금 디렉터리 권한이 너무 넓습니다: ${real} (${mode}). 다른 사용자가 잠금을 읽거나 바꾸지 못하도록 chmod 700 ${JSON.stringify(real)} 후 다시 시작하세요.`,
			};
		}
	} catch (error) {
		return { reason: `잠금 디렉터리를 확인할 수 없습니다: ${real} (${errText(error)})` };
	}
	return { dir: real };
}

async function canonicalizeRoot(root: string): Promise<{ root: string; worktree: string } | { reason: string }> {
	let real: string;
	try {
		real = await fs.realpath(root);
	} catch (error) {
		return { reason: `worktree 루트를 확인할 수 없습니다: ${root} (${errText(error)}). 실행을 시작하지 않았습니다.` };
	}
	let st: BigIntStats;
	try {
		st = await fs.stat(real, { bigint: true });
	} catch (error) {
		return { reason: `worktree 루트를 확인할 수 없습니다: ${real} (${errText(error)}). 실행을 시작하지 않았습니다.` };
	}
	if (!st.isDirectory()) {
		return { reason: `worktree 루트가 디렉터리가 아닙니다: ${real}. 실행을 시작하지 않았습니다.` };
	}
	const worktree = createHash("sha256").update(`${st.dev}:${st.ino}`).digest("hex");
	return { root: real, worktree };
}

type LockRead =
	| { kind: "missing" }
	| { kind: "invalid"; detail: string }
	| { kind: "valid"; record: LeaseRecord; dev: bigint; ino: bigint };

/**
 * Opens without following a symlink and reads at most `MAX_RECORD_BYTES`, so an unrelated file cannot be mistaken for
 * a lease or exhaust memory. Any failure other than ENOENT is `invalid`: the caller refuses.
 */
async function readLock(lockPath: string, worktree: string): Promise<LockRead> {
	let fh: FileHandle | undefined;
	try {
		fh = await fs.open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		if (errCode(error) === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", detail: `잠금 파일을 열 수 없습니다 (${errText(error)})` };
	}
	if (!fh) return { kind: "invalid", detail: "잠금 파일을 열 수 없습니다" };
	const handle = fh;
	try {
		const st = await handle.stat({ bigint: true });
		if (!st.isFile()) return { kind: "invalid", detail: "잠금 파일이 일반 파일이 아닙니다" };
		if (st.size > BigInt(MAX_RECORD_BYTES)) return { kind: "invalid", detail: "잠금 파일이 너무 큽니다" };
		let text: string;
		try {
			text = await handle.readFile({ encoding: "utf8" });
		} catch (error) {
			return { kind: "invalid", detail: `잠금 파일을 읽을 수 없습니다 (${errText(error)})` };
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return { kind: "invalid", detail: "JSON이 아닙니다" };
		}
		if (!isLeaseRecord(value, worktree)) return { kind: "invalid", detail: "소유자 기록 형식이 올바르지 않습니다" };
		return { kind: "valid", record: value, dev: st.dev, ino: st.ino };
	} catch (error) {
		return { kind: "invalid", detail: `잠금 파일을 확인할 수 없습니다 (${errText(error)})` };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** The path still names the inode whose record was inspected; used immediately before deleting a dead lock. */
async function sameInode(lockPath: string, seen: { dev: bigint; ino: bigint }): Promise<boolean> {
	try {
		const st = await fs.lstat(lockPath, { bigint: true });
		return st.isFile() && st.dev === seen.dev && st.ino === seen.ino;
	} catch {
		return false;
	}
}

function defaultOwnerStatus(owner: LeaseOwner, host: string): LeaseOwnerStatus {
	if (owner.host !== host) return "unknown";
	// Another process cannot share our pid in this namespace: a record with our pid and a different start belongs to a
	// previous process that already died, so the slot is safely reclaimable. For any other pid, `kill` cannot tell a
	// reused pid from the recorded owner; `alive` then refuses rather than guessing.
	if (owner.pid === process.pid) {
		return owner.processStart === Math.round(performance.timeOrigin) ? "alive" : "dead";
	}
	try {
		process.kill(owner.pid, 0);
		return "alive";
	} catch (error) {
		const code = errCode(error);
		if (code === "ESRCH") return "dead";
		// EPERM means the pid exists (owned by someone else): alive. Any other error proves nothing.
		if (code === "EPERM") return "alive";
		return "unknown";
	}
}

async function probeOwner(
	liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>,
	owner: LeaseOwner,
): Promise<LeaseOwnerStatus> {
	try {
		const status = await liveness(owner);
		return status === "alive" || status === "dead" || status === "unknown" ? status : "unknown";
	} catch {
		return "unknown";
	}
}

function busyReason(record: LeaseRecord): string {
	return `이 worktree에서 다른 OMP 실행(${record.runId})이 진행 중입니다(pid ${record.owner.pid}, 호스트 ${record.owner.host}). 그 실행이 끝난 뒤 다시 시작하세요.`;
}

function unknownOwnerReason(record: LeaseRecord, lockPath: string): string {
	return `실행 잠금 소유자(실행 ${record.runId}, pid ${record.owner.pid}, 호스트 ${record.owner.host})가 종료됐는지 확인할 수 없습니다. 그 프로세스가 이 worktree를 아직 쓰고 있는지 확인한 뒤 다시 시작하세요. 확인 전에는 잠금 파일(${lockPath})을 지우지 마세요.`;
}

function invalidLockReason(lockPath: string, detail: string): string {
	return `실행 잠금의 소유자 정보를 확인할 수 없습니다: ${lockPath} (${detail}). 다른 OMP 실행이 이 worktree를 쓰고 있을 수 있으니, 실행 중인 OMP가 없는지 확인한 뒤에만 이 파일을 지우세요.`;
}

function guardReason(guardPath: string): string {
	return `종료된 실행 잠금을 회수하는 가드가 남아 있습니다: ${guardPath}. 다른 OMP 실행이 회수 중일 수 있으니 잠시 뒤 다시 시작하세요. 오래 남아 있고 이 worktree를 쓰는 OMP가 없다면 확인 후 그 디렉터리를 지우세요.`;
}

function contentionReason(lockPath: string): string {
	return `실행 잠금(${lockPath})을 얻지 못했습니다. 다른 OMP 실행이 이 worktree를 쓰고 있는지 확인한 뒤 다시 시작하세요.`;
}

function leaseReleaseError(lockPath: string, detail: string): Error {
	return new Error(`실행 잠금(${lockPath})을 해제하지 않았습니다: ${detail}. 다른 프로세스가 이 worktree를 실행 중일 수 있으니 상태를 확인하세요.`);
}

/** Removes our own lock record, but only after proving the path still carries the exact owner we took. */
async function releaseLock(lockPath: string, record: LeaseRecord, worktree: string): Promise<void> {
	if (record.owner.pid !== process.pid || record.owner.processStart !== Math.round(performance.timeOrigin)) {
		throw leaseReleaseError(lockPath, "이 프로세스가 획득한 잠금이 아닙니다");
	}
	const current = await readLock(lockPath, worktree);
	if (current.kind === "missing") {
		throw leaseReleaseError(lockPath, "잠금 파일이 사라졌습니다");
	}
	if (current.kind === "invalid") {
		throw leaseReleaseError(lockPath, current.detail);
	}
	if (current.record.owner.token !== record.owner.token || current.record.runId !== record.runId) {
		throw leaseReleaseError(lockPath, `다른 실행(${current.record.runId}) 또는 다른 소유자의 잠금입니다`);
	}
	if (!(await sameInode(lockPath, current))) {
		throw leaseReleaseError(lockPath, "잠금 파일이 확인 중에 바뀌었습니다");
	}
	try {
		await fs.unlink(lockPath);
	} catch (error) {
		throw leaseReleaseError(lockPath, `삭제할 수 없습니다 (${errText(error)})`);
	}
}

function makeLease(lockPath: string, record: LeaseRecord, worktree: string): RunLease {
	const owner = Object.freeze({ ...record.owner });
	const frozen = Object.freeze({ ...record, owner });
	let releasePromise: Promise<void> | undefined;
	return Object.freeze({
		runId: record.runId,
		root: record.root,
		path: lockPath,
		owner,
		record: frozen,
		release(): Promise<void> {
			releasePromise ??= releaseLock(lockPath, frozen, worktree);
			return releasePromise;
		},
	});
}

async function writeLockTemp(tmp: string, payload: string): Promise<void> {
	const fh = await fs.open(tmp, "wx", 0o600);
	try {
		await fh.writeFile(payload, "utf8");
		// The link publishes the record; sync first so a host crash cannot publish an empty/partial owner.
		await fh.sync();
	} finally {
		await fh.close().catch(() => undefined);
	}
}

/** Tries to publish `tmp` as the lock; only one `link` can succeed. */
async function publish(tmp: string, lockPath: string): Promise<boolean> {
	try {
		await fs.link(tmp, lockPath);
		return true;
	} catch (error) {
		if (errCode(error) === "EEXIST") return false;
		throw error;
	}
}

/**
 * Acquires the single execution slot of the canonical worktree containing `root`.
 *
 * On success the caller owns the slot until `lease.release()` settles. On failure nothing was written or deleted that
 * belongs to another owner; `reason` is written for the model/user and says what to check before retrying.
 */
export async function acquireRunLease(
	root: string,
	runId: string,
	deps: LeaseDeps = {},
): Promise<AcquireRunLeaseResult> {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		return fail(`실행 잠금은 macOS와 Linux에서만 지원합니다(현재 ${process.platform}). 실행을 시작하지 않았습니다.`);
	}
	if (typeof root !== "string" || root.length === 0) {
		return fail("worktree 루트가 비어 있습니다. 실행을 시작하지 않았습니다.");
	}
	if (!cleanId(runId)) {
		return fail(`실행 id가 올바르지 않습니다: ${JSON.stringify(runId)}. 실행을 시작하지 않았습니다.`);
	}

	const canonical = await canonicalizeRoot(root);
	if (!("worktree" in canonical)) return fail(canonical.reason);

	let configured: { dir: string } | { reason: string };
	try {
		configured = deps.dir !== undefined ? { dir: deps.dir } : defaultLeaseDir();
	} catch (error) {
		return fail(`잠금 디렉터리를 정할 수 없습니다 (${errText(error)}). ${LEASE_DIR_ENV}를 절대 경로로 지정하세요.`);
	}
	if ("reason" in configured) return fail(configured.reason);
	// Resolve the existing ancestor before creating anything, so a symlinked parent into the worktree is caught
	// without writing there. prepareLeaseDir repeats the check on the real path before tightening permissions.
	const prospective = await prospectivePath(configured.dir);
	if (prospective === undefined) {
		return fail(`잠금 디렉터리 경로를 확인할 수 없습니다: ${configured.dir}. 접근 가능한 절대 경로를 지정하세요.`);
	}
	if (isInside(canonical.root, prospective)) {
		return fail(`잠금 디렉터리가 worktree 안에 있습니다: ${prospective}. worktree 밖의 디렉터리를 지정하세요.`);
	}
	const prepared = await prepareLeaseDir(configured.dir, canonical.root);
	if ("reason" in prepared) return fail(prepared.reason);

	const worktree = canonical.worktree;
	const lockPath = path.join(prepared.dir, `${worktree}.lock`);
	const guardPath = `${lockPath}.reclaim`;
	let host: string;
	try {
		host = os.hostname();
	} catch (error) {
		return fail(`호스트 이름을 확인할 수 없습니다 (${errText(error)}). 실행을 시작하지 않았습니다.`);
	}
	const owner: LeaseOwner = {
		token: randomUUID(),
		pid: process.pid,
		host,
		processStart: Math.round(performance.timeOrigin),
	};
	const record: LeaseRecord = {
		schema: SCHEMA,
		worktree,
		root: canonical.root,
		runId,
		owner,
		acquiredAt: new Date().toISOString(),
	};
	const payload = `${JSON.stringify(record)}\n`;
	const tmp = path.join(prepared.dir, `.${worktree}.${process.pid}.${owner.token}.tmp`);
	const liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus> =
		deps.liveness ?? ((candidate: LeaseOwner): LeaseOwnerStatus => defaultOwnerStatus(candidate, host));

	try {
		try {
			await writeLockTemp(tmp, payload);
		} catch (error) {
			return fail(
				`실행 잠금 파일을 준비할 수 없습니다: ${prepared.dir} (${errText(error)}). 잠금 디렉터리가 하드 링크를 지원하는 로컬 파일시스템인지 확인하세요.`,
			);
		}

		let lastGuard = "";
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			let published = false;
			try {
				published = await publish(tmp, lockPath);
			} catch (error) {
				return fail(
					`실행 잠금을 만들 수 없습니다: ${lockPath} (${errText(error)}). 잠금 디렉터리가 하드 링크를 지원하는 로컬 파일시스템인지 확인하세요.`,
				);
			}
			if (published) return { ok: true, lease: makeLease(lockPath, record, worktree) };

			const current = await readLock(lockPath, worktree);
			if (current.kind === "missing") continue;
			if (current.kind === "invalid") return fail(invalidLockReason(lockPath, current.detail));

			const state = await probeOwner(liveness, current.record.owner);
			if (state === "alive") return fail(busyReason(current.record));
			if (state === "unknown") return fail(unknownOwnerReason(current.record, lockPath));

			// Dead: serialize reclaimers before touching the lock. Only one can create the guard directory.
			try {
				await fs.mkdir(guardPath, { mode: 0o700 });
			} catch (error) {
				if (errCode(error) === "EEXIST") {
					lastGuard = guardReason(guardPath);
					await Bun.sleep(RETRY_MS);
					continue;
				}
				return fail(`실행 잠금 회수 가드를 만들 수 없습니다: ${guardPath} (${errText(error)}). 실행을 시작하지 않았습니다.`);
			}
			try {
				// Re-read under the guard: a contender may have reclaimed and republished while we waited for the guard.
				const again = await readLock(lockPath, worktree);
				if (again.kind === "missing") continue;
				if (again.kind === "invalid") return fail(invalidLockReason(lockPath, again.detail));
				const second = await probeOwner(liveness, again.record.owner);
				if (second === "alive") return fail(busyReason(again.record));
				if (second === "unknown") return fail(unknownOwnerReason(again.record, lockPath));
				// Never unlink a path that was replaced after the probe; the next attempt starts over.
				if (!(await sameInode(lockPath, again))) continue;
				try {
					await fs.unlink(lockPath);
				} catch (error) {
					if (errCode(error) !== "ENOENT") {
						return fail(`종료된 실행 잠금을 지울 수 없습니다: ${lockPath} (${errText(error)}). 실행을 시작하지 않았습니다.`);
					}
				}
			} finally {
				// The guard is ours and empty; failing to remove it only makes the next attempt report it.
				await fs.rmdir(guardPath).catch(() => undefined);
			}
		}
		return fail(lastGuard || contentionReason(lockPath));
	} finally {
		await fs.unlink(tmp).catch(() => undefined);
	}
}
