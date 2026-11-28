/**
 * Session and worktree execution leases for one Storm run.
 *
 * Two different questions are answered by two different locks:
 *
 * - Session ownership: one active run per native OMP main session, including two processes that reopen the same
 *   session. The key is the canonical session directory (which already contains the profile) plus the full public
 *   session id. A nonce record is published with a hard link, so a session either has no owner or one complete owner.
 * - Worktree contention: a read lease may coexist with other read leases; a writer may not coexist with a reader; an
 *   unbounded writer is exclusive; a path-scoped writer may coexist only with strictly disjoint path claims. The key is
 *   the canonical target worktree's `(device, inode)`, so a linked worktree, a symlink alias and a differently cased
 *   alias resolve to the intended physical tree.
 *
 * The lock directory is outside every worktree, in the private per-user OS temp directory by default. Records are
 * written completely to a temp file and linked into place: no partial owner is observable, and a lock never appears in
 * `git status`, a diff or a worktree scan. Old lease records are never read, migrated, renamed or deleted.
 *
 * Conservative liveness: a recorded owner is probed on every contention check. `alive` refuses, `unknown` (another
 * host, an unreadable probe, an unexpected signal error) refuses and names the record for a human check, and only
 * `dead` permits deleting that exact record. A worktree reader/writer record has a unique file name, so reclaiming a
 * dead record cannot delete a newer owner. The fixed session lock uses a short `.reclaim` guard; a process that dies
 * in that guard leaves it behind, and later acquisitions fail closed instead of guessing.
 *
 * Access transitions are explicit. A manual or not-yet-planned run starts with a read lease. Before its first write,
 * its caller upgrades to a writer (unbounded for shell/unknown/undeclared writes; path-scoped only when every write is
 * attributable to those paths). A read lease is kept while the writer record is published and is only dropped after
 * the worktree is exclusively ours, so a failed upgrade leaves the read lease intact and the run must stop. A
 * successful upgrade or path-set change increments `epoch`; review/check snapshots taken under an older epoch must be
 * refused rather than applied to a different access state.
 *
 * Callers must pass the actual target worktree top level as `root`, the session directory returned by the profile's
 * session scope as `sessionDir`, the native main session id as `sessionId`, and a bounded run id. They must hold the
 * lease for the whole run, call `release()` exactly once in a `finally`, and surface a release failure: another
 * process may now own part of the worktree.
 */
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withJosa } from "../josa.ts";

const SCHEMA = "storm.lease/v2";
/** Owner records are small; anything larger is not one of ours and must not be parsed. */
const MAX_RECORD_BYTES = 16_384;
/** Contenders that lose a publication race wait for the short critical section to end. */
const MAX_ATTEMPTS = 40;
const RETRY_MS = 10;
const MAX_RUN_ID = 200;
const MAX_IDENTITY = 4_096;
const MAX_PATH = 4_096;

/** Exact owner identity when a record was published. */
export interface LeaseOwner {
	/** Random per run; every release accepts only this ownership nonce. */
	token: string;
	pid: number;
	host: string;
	/** `Math.round(performance.timeOrigin)` of the owning process: tells pid reuse apart. */
	processStart: number;
}

export type LeaseMode = "read" | "write";

/** A writer's complete declared write surface. `unbounded` means shell, shared state, or undeclared writes. */
export type WriteScope = { kind: "unbounded" } | { kind: "paths"; paths: readonly string[] };

export type LeaseRecordKind = "session" | "read" | "write";

/** The complete lock record on disk. One schema serves the session record and the worktree records. */
export interface LeaseRecord {
	schema: typeof SCHEMA;
	kind: LeaseRecordKind;
	/** `sha256` of the session identity or of the canonical worktree `(device:inode)`. */
	key: string;
	/** Canonical target worktree top level; coordination and diagnostics only. */
	root: string;
	runId: string;
	sessionId: string;
	/** Canonical session directory; contains the profile and the session-store hash. */
	sessionDir: string;
	owner: LeaseOwner;
	/** ISO 8601, display only; never used for staleness. */
	acquiredAt: string;
	/** Local clock milliseconds of publication; audit/diagnostic only, never used for staleness or authority. */
	acquiredAtMs: number;
	/** Writer only. Absent is an unbounded writer; present is the complete path claim, sorted and normalized. */
	paths?: readonly string[];
}

/** Result of asking whether the recorded owner may still run. Only `dead` permits reclaim. */
export type LeaseOwnerStatus = "alive" | "dead" | "unknown";

/** Narrow test hooks. Production callers omit both. */
export interface LeaseDeps {
	/** Absolute directory for lock files; tests pass a temp dir. Defaults to the private per-user OS temp dir. */
	dir?: string;
	/**
	 * Owner liveness probe for tests or special hosts. It must return `dead` only when death is proven; any doubt is
	 * `unknown`. The default on macOS/Linux uses the hostname and `kill(pid, 0)`.
	 */
	liveness?: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>;
}

/** The exact access facts an evidence snapshot was taken under. */
export interface LeaseSnapshot {
	readonly runId: string;
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly root: string;
	readonly mode: LeaseMode;
	/** `undefined` for a read lease and for an unbounded writer; sorted paths for a path-scoped writer. */
	readonly paths: readonly string[] | undefined;
	readonly epoch: number;
}

/** A held execution lease. Keep it for the whole run; `release()` is the only way to open every slot it holds. */
export interface RunLease {
	readonly runId: string;
	readonly sessionId: string;
	readonly sessionDir: string;
	/** Canonical target worktree top level the worktree lease is keyed by. */
	readonly root: string;
	readonly mode: LeaseMode;
	/** `undefined` for a read lease and an unbounded writer; sorted paths for a path-scoped writer. */
	readonly paths: readonly string[] | undefined;
	/** Increments on every successful access change; evidence snapshots compare it. */
	readonly epoch: number;
	readonly owner: Readonly<LeaseOwner>;
	/** The current worktree record; diagnostics and tests only. Do not touch it directly. */
	readonly record: Readonly<LeaseRecord>;
	/** Absolute current worktree record path; diagnostics and tests only. */
	readonly path: string;
	/** Absolute session ownership record path; diagnostics and tests only. */
	readonly sessionPath: string;
	snapshot(): LeaseSnapshot;
	/**
	 * Throws unless the lease still holds the exact access state in `snapshot`. Call this immediately before accepting
	 * review/check evidence that was produced under that snapshot.
	 */
	assertCurrent(snapshot: LeaseSnapshot): void;
	/**
	 * Read -> write transition. With no scope it becomes an unbounded writer; `{ kind: "paths" }` is a path-scoped
	 * writer. On failure the read lease is still held, so the caller must stop instead of continuing to write.
	 */
	upgrade(input?: { scope?: WriteScope }): Promise<UpgradeResult>;
	/** Atomically replaces a writer's complete path claim; a read lease must upgrade first. */
	setWritePaths(paths: readonly string[]): Promise<UpgradeResult>;
	release(): Promise<void>;
}

export type AcquireRunLeaseResult = { ok: true; lease: RunLease } | { ok: false; reason: string };
export type UpgradeResult = { ok: true } | { ok: false; reason: string };

/** A reset or other session-only operation: it owns no worktree access, only this native session. */
export interface SessionLease {
	readonly runId: string;
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly owner: Readonly<LeaseOwner>;
	readonly record: Readonly<LeaseRecord>;
	/** Absolute session lock path; diagnostics and tests only. */
	readonly path: string;
	release(): Promise<void>;
}

export type AcquireSessionLeaseResult = { ok: true; lease: SessionLease } | { ok: false; reason: string };

export interface AcquireSessionLeaseInput {
	sessionDir: string;
	sessionId: string;
	runId: string;
}

/** Everything a run must identify to take its own session slot and a worktree access record. */
export interface AcquireRunLeaseInput {
	/** The profile's session store directory for this native session; absolute. */
	sessionDir: string;
	/** The native OMP main session id; opaque, non-empty. */
	sessionId: string;
	/** The actual target worktree top level; not a subdirectory and not an alias. */
	root: string;
	runId: string;
	mode: LeaseMode;
	/** Required for `mode: "write"` only. Omit for read; `undefined` writer scope means unbounded. */
	scope?: WriteScope;
}

function fail(reason: string): AcquireRunLeaseResult {
	return { ok: false, reason };
}

function upgradeFail(reason: string): UpgradeResult {
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

function cleanIdentity(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${withJosa(field, "이/가")} 문자열이 아닙니다. 실행을 시작하지 않았습니다.`);
	if (value.trim() === "" || value.length > MAX_IDENTITY || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error(`${withJosa(field, "이/가")} 올바르지 않습니다. 실행을 시작하지 않았습니다.`);
	}
	return value;
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

function isPathText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PATH &&
		!value.includes("\u0000") &&
		!value.startsWith("/") &&
		!path.isAbsolute(value)
	);
}

/**
 * The one accepted path form: a repo-relative POSIX-style path without empty, `.` or `..` segments. Refusing unusual
 * spellings is safer than guessing which two spellings name one file. Comparison is on NFC text.
 */
function normalizePath(value: unknown): string | undefined {
	if (!isPathText(value)) return undefined;
	if (value.includes("\\") || value.includes("\u0000")) return undefined;
	const segments = value.split("/");
	if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return undefined;
	if (value.endsWith("/")) return undefined;
	return value.normalize("NFC");
}

/** Validates and canonicalizes a writer's complete path claim; at least one path is required. */
function normalizePaths(input: readonly string[]): { paths: readonly string[] } | { reason: string } {
	if (!Array.isArray(input) || input.length === 0) {
		return { reason: "경로 범위 쓰기는 하나 이상의 저장소 상대 경로가 필요합니다. 실행을 시작하지 않았습니다." };
	}
	if (input.length > 4_096) {
		return { reason: "경로 범위 쓰기의 경로가 너무 많습니다. 실행을 시작하지 않았습니다." };
	}
	const unique = new Set<string>();
	for (const value of input) {
		const normalized = normalizePath(value);
		if (normalized === undefined) {
			return { reason: `경로 범위 쓰기의 경로가 올바르지 않습니다: ${JSON.stringify(value)}. 저장소 상대 경로만 쓰세요.` };
		}
		unique.add(normalized);
	}
	return { paths: Object.freeze([...unique].sort()) };
}

/** True when two normalized paths name the same file or one is a directory ancestor of the other. */
function pathsOverlap(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function claimsOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	// An absent claim is an unbounded writer: it overlaps every other writer.
	if (a === undefined || b === undefined) return true;
	for (const left of a) {
		for (const right of b) {
			if (pathsOverlap(left, right)) return true;
		}
	}
	return false;
}

function samePaths(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A record is valid only for the exact identity whose lock path carried it. */
function isLeaseRecord(value: unknown, kind: LeaseRecordKind, key: string): value is LeaseRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.schema !== SCHEMA || record.kind !== kind || record.key !== key) return false;
	for (const field of ["root", "sessionId", "sessionDir"] as const) {
		if (typeof record[field] !== "string") return false;
		const text = record[field];
		if (text.length > MAX_IDENTITY || /[\u0000-\u001f\u007f]/.test(text)) return false;
		if (text.length === 0 && (field !== "root" || kind !== "session")) return false;
	}
	if (!cleanId(record.runId)) return false;
	if (!isOwner(record.owner)) return false;
	if (typeof record.acquiredAt !== "string" || !Number.isFinite(Date.parse(record.acquiredAt))) return false;
	if (
		typeof record.acquiredAtMs !== "number" ||
		!Number.isSafeInteger(record.acquiredAtMs) ||
		record.acquiredAtMs <= 0
	) {
		return false;
	}
	if (kind !== "write") return record.paths === undefined;
	if (record.paths === undefined) return true;
	if (!Array.isArray(record.paths) || record.paths.length === 0 || record.paths.length > 4_096) return false;
	let previous = "";
	for (const [index, item] of record.paths.entries()) {
		if (typeof item !== "string" || !isPathText(item)) return false;
		const normalized = normalizePath(item);
		if (normalized === undefined || normalized !== item) return false;
		if (index > 0 && item <= previous) return false;
		previous = item;
	}
	return true;
}

/** `child` is `parent` or below it, after both were canonicalized. */
function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function defaultLeaseDir(): string {
	const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	// A new subdirectory keeps every previous-format lease file byte untouched and out of this protocol.
	return path.join(os.tmpdir(), `omp-storm-leases-${uid}`, "v2");
}

/**
 * The one lease namespace a caller uses. Integration fences live under the same namespace so a later session can find
 * a failed target write by the canonical worktree identity, not by a run id or a session store it cannot read.
 */
export function leaseNamespace(deps: LeaseDeps = {}): string {
	return deps.dir !== undefined ? deps.dir : defaultLeaseDir();
}

const FENCE_EXT = ".fence.json";

/** A single published record is discoverable by either physical target or canonical path, including after replacement. */
export function integrationFenceFile(baseDir: string, root: string, key: string, effectToken: string): string {
	const rootKey = createHash("sha256").update(root).digest("hex");
	const effectKey = createHash("sha256").update(effectToken).digest("hex");
	return path.join(baseDir, "integration-fences", `${key}.${rootKey}.${effectKey}${FENCE_EXT}`);
}

export async function integrationFenceFiles(baseDir: string, root: string, key: string): Promise<string[]> {
	const dir = path.join(baseDir, "integration-fences");
	const rootKey = createHash("sha256").update(root).digest("hex");
	const physicalPrefix = `${key}.`;
	const rootPrefix = `${rootKey}.`;
	let names: string[];
	try {
		const info = await fs.lstat(dir);
		if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`유효한 통합 펜스 디렉터리가 아닙니다: ${dir}`);
		names = await fs.readdir(dir);
	} catch (error) {
		if (errCode(error) === "ENOENT") return [];
		throw error;
	}
	const files: string[] = [];
	for (const name of names) {
		if (!name.endsWith(FENCE_EXT) || !(name.startsWith(physicalPrefix) || name.startsWith(rootPrefix, physicalPrefix.length))) continue;
		files.push(path.join(dir, name));
	}
	return files;
}

async function writerFenceBlock(baseDir: string, record: LeaseRecord): Promise<string | undefined> {
	const target = await canonicalWorktree(record.root);
	if (target?.key !== record.key || target.root !== record.root) return "쓰기 lease를 얻기 전에 작업 트리의 정체성이 바뀌었습니다.";
	const [fence] = await integrationFenceFiles(baseDir, record.root, record.key);
	return fence === undefined ? undefined : `이 대상에 끝났는지 확인되지 않은 통합 펜스가 남아 있어 쓰기 lease를 얻지 않았습니다: ${fence}`;
}

/** The canonical worktree identity the lease and the integration fence both key on. */
export interface CanonicalWorktree {
	/** Real path of the worktree top level. */
	readonly root: string;
	/** `sha256("<dev>:<ino>")`: the same key the lease record uses. */
	readonly key: string;
	/** Decimal device and inode, never rounded through a JS number. */
	readonly device: string;
	readonly inode: string;
}

/**
 * Canonicalizes an existing worktree top level for a fence lookup. `undefined` means the path is gone, unreadable or
 * not a directory: a caller must not read that as "no fence". The key matches `canonicalizeRoot` exactly, so a symlink
 * alias, a differently cased path and a linked worktree resolve to one physical identity.
 */
export async function canonicalWorktree(root: string): Promise<CanonicalWorktree | undefined> {
	try {
		const real = await fs.realpath(root);
		const st = await fs.stat(real, { bigint: true });
		if (!st.isDirectory()) return undefined;
		return {
			root: real,
			key: createHash("sha256").update(`${st.dev}:${st.ino}`).digest("hex"),
			device: st.dev.toString(),
			inode: st.ino.toString(),
		};
	} catch {
		return undefined;
	}
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
async function prepareLeaseDir(dir: string, root?: string): Promise<{ dir: string } | { reason: string }> {
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
	if (root !== undefined && isInside(root, real)) {
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

async function ensurePrivateDir(base: string, ...parts: string[]): Promise<string> {
	const dir = path.join(base, ...parts);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
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

async function canonicalizeSessionDir(sessionDir: string): Promise<string | undefined> {
	if (!path.isAbsolute(sessionDir)) return undefined;
	const prospective = await prospectivePath(sessionDir);
	if (prospective === undefined) return undefined;
	try {
		const st = await fs.stat(prospective);
		if (!st.isDirectory()) return undefined;
	} catch (error) {
		if (errCode(error) !== "ENOENT") return undefined;
	}
	return prospective;
}

function sessionKey(sessionDir: string, sessionId: string): string {
	return createHash("sha256").update(`storm.lease/v2/session\u0000${sessionDir}\u0000${sessionId}`).digest("hex");
}

type LockRead =
	| { kind: "missing" }
	| { kind: "invalid"; detail: string }
	| { kind: "valid"; record: LeaseRecord; dev: bigint; ino: bigint };

/**
 * Opens without following a symlink and reads at most `MAX_RECORD_BYTES`, so an unrelated file cannot be mistaken for
 * a lease or exhaust memory. Any failure other than ENOENT is `invalid`: the caller refuses.
 */
async function readRecord(recordPath: string, kind: LeaseRecordKind, key: string): Promise<LockRead> {
	let fh: FileHandle | undefined;
	try {
		fh = await fs.open(recordPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
		if (!isLeaseRecord(value, kind, key)) {
			return { kind: "invalid", detail: "소유자 기록 형식이 올바르지 않습니다" };
		}
		return { kind: "valid", record: value, dev: st.dev, ino: st.ino };
	} catch (error) {
		return { kind: "invalid", detail: `잠금 파일을 확인할 수 없습니다 (${errText(error)})` };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** The path still names the inode whose record was inspected; used immediately before deleting a dead record. */
async function sameInode(recordPath: string, seen: { dev: bigint; ino: bigint }): Promise<boolean> {
	try {
		const st = await fs.lstat(recordPath, { bigint: true });
		return st.isFile() && st.dev === seen.dev && st.ino === seen.ino;
	} catch {
		return false;
	}
}

async function unlinkIfSame(recordPath: string, seen: { dev: bigint; ino: bigint }): Promise<void> {
	if (!(await sameInode(recordPath, seen))) {
		throw new Error(`잠금 파일이 확인 중에 바뀌었습니다: ${recordPath}`);
	}
	try {
		await fs.unlink(recordPath);
	} catch (error) {
		if (errCode(error) !== "ENOENT") throw error;
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

function sessionBusyReason(record: LeaseRecord): string {
	return `이 세션(${record.sessionId})에서 다른 Storm 실행(${record.runId})이 진행 중입니다(pid ${record.owner.pid}, 호스트 ${record.owner.host}). 그 실행이 끝난 뒤 다시 시작하세요.`;
}

function sessionUnknownReason(record: LeaseRecord, lockPath: string): string {
	return `세션 잠금 소유자(실행 ${record.runId}, pid ${record.owner.pid}, 호스트 ${record.owner.host})가 종료됐는지 확인할 수 없습니다. 그 프로세스가 이 세션 상태를 아직 쓰고 있는지 확인한 뒤 다시 시작하세요. 확인 전에는 잠금 파일(${lockPath})을 지우지 마세요.`;
}

function invalidRecordReason(lockPath: string, detail: string): string {
	return `실행 잠금의 소유자 정보를 확인할 수 없습니다: ${lockPath} (${detail}). 다른 OMP 실행이 이 세션/worktree를 쓰고 있을 수 있으니, 실행 중인 OMP가 없는지 확인한 뒤에만 이 파일을 지우세요.`;
}

function sessionGuardReason(guardPath: string): string {
	return `종료된 세션 잠금을 회수하는 가드가 남아 있습니다: ${guardPath}. 다른 OMP 실행이 회수 중일 수 있으니 잠시 뒤 다시 시작하세요. 오래 남아 있고 이 세션을 쓰는 OMP가 없다면 확인 후 그 디렉터리를 지우세요.`;
}

function sessionContentionReason(lockPath: string): string {
	return `세션 잠금(${lockPath})을 얻지 못했습니다. 다른 OMP 실행이 이 세션을 쓰고 있는지 확인한 뒤 다시 시작하세요.`;
}

function readerConflictReason(writer: LeaseRecord, reader: LeaseRecord): string {
	return `읽기 실행(${reader.runId})이 같은 worktree 경로(${writer.root})를 읽고 있습니다. 쓰기 실행(${writer.runId})은 그 읽기가 끝난 뒤에만 시작할 수 있습니다.`;
}

function writerConflictReason(other: LeaseRecord, pathText: string | undefined): string {
	const scope = pathText === undefined ? "이 worktree 전체" : `경로 ${pathText}`;
	return `다른 Storm 실행(${other.runId}, 세션 ${other.sessionId})이 ${withJosa(scope, "을/를")} 쓰고 있습니다. 그 실행이 끝난 뒤 다시 시작하세요.`;
}

function leaseReleaseError(lockPath: string, detail: string): Error {
	return new Error(`실행 잠금(${lockPath})을 해제하지 않았습니다: ${detail}. 다른 프로세스가 이 세션/worktree를 실행 중일 수 있으니 상태를 확인하세요.`);
}

function leaseChangedError(): Error {
	return new Error("실행 잠금의 접근 상태가 바뀌어 이전 스냅샷을 받아들일 수 없습니다. 검토·검사 근거를 무효로 하고 실행을 중단하세요.");
}

async function writeRecordTemp(tmp: string, payload: string): Promise<void> {
	const fh = await fs.open(tmp, "wx", 0o600);
	try {
		await fh.writeFile(payload, "utf8");
		// The link publishes the record; sync first so a host crash cannot publish an empty/partial owner.
		await fh.sync();
	} finally {
		await fh.close().catch(() => undefined);
	}
}

/** Tries to publish `tmp` as the fixed session lock; only one `link` can succeed. */
async function publish(tmp: string, lockPath: string): Promise<boolean> {
	try {
		await fs.link(tmp, lockPath);
		return true;
	} catch (error) {
		if (errCode(error) === "EEXIST") return false;
		throw error;
	}
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms).unref?.();
	return promise;
}

interface SessionSlot {
	path: string;
	record: LeaseRecord;
}

async function acquireSessionSlot(
	baseDir: string,
	key: string,
	record: LeaseRecord,
	liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>,
): Promise<{ ok: true; slot: SessionSlot } | { ok: false; reason: string }> {
	const dir = await ensurePrivateDir(baseDir, "sessions");
	const lockPath = path.join(dir, `${key}.lock`);
	const guardPath = `${lockPath}.reclaim`;
	const tmp = path.join(dir, `.${key}.${record.owner.token}.tmp`);
	const payload = `${JSON.stringify(record)}\n`;
	try {
		try {
			await writeRecordTemp(tmp, payload);
		} catch (error) {
			return { ok: false, reason: `실행 잠금 파일을 준비할 수 없습니다: ${dir} (${errText(error)}). 잠금 디렉터리가 하드 링크를 지원하는 로컬 파일시스템인지 확인하세요.` };
		}
		let lastGuard = "";
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			let published = false;
			try {
				published = await publish(tmp, lockPath);
			} catch (error) {
				return { ok: false, reason: `실행 잠금을 만들 수 없습니다: ${lockPath} (${errText(error)}). 잠금 디렉터리가 하드 링크를 지원하는 로컬 파일시스템인지 확인하세요.` };
			}
			if (published) return { ok: true, slot: { path: lockPath, record } };
			const current = await readRecord(lockPath, "session", key);
			if (current.kind === "missing") continue;
			if (current.kind === "invalid") return { ok: false, reason: invalidRecordReason(lockPath, current.detail) };
			const state = await probeOwner(liveness, current.record.owner);
			if (state === "alive") return { ok: false, reason: sessionBusyReason(current.record) };
			if (state === "unknown") return { ok: false, reason: sessionUnknownReason(current.record, lockPath) };
			// Dead: serialize reclaimers before touching the fixed lock path. Only one can create the guard directory.
			try {
				await fs.mkdir(guardPath, { mode: 0o700 });
			} catch (error) {
				if (errCode(error) === "EEXIST") {
					lastGuard = sessionGuardReason(guardPath);
					await delay(RETRY_MS);
					continue;
				}
				return { ok: false, reason: `실행 잠금 회수 가드를 만들 수 없습니다: ${guardPath} (${errText(error)}). 실행을 시작하지 않았습니다.` };
			}
			try {
				// Re-read under the guard: a contender may have reclaimed and republished while we waited for the guard.
				const again = await readRecord(lockPath, "session", key);
				if (again.kind === "missing") continue;
				if (again.kind === "invalid") return { ok: false, reason: invalidRecordReason(lockPath, again.detail) };
				const second = await probeOwner(liveness, again.record.owner);
				if (second === "alive") return { ok: false, reason: sessionBusyReason(again.record) };
				if (second === "unknown") return { ok: false, reason: sessionUnknownReason(again.record, lockPath) };
				// Never unlink a path that was replaced after the probe; the next attempt starts over.
				if (!(await sameInode(lockPath, again))) continue;
				try {
					await fs.unlink(lockPath);
				} catch (error) {
					if (errCode(error) !== "ENOENT") {
						return { ok: false, reason: `종료된 실행 잠금을 지울 수 없습니다: ${lockPath} (${errText(error)}). 실행을 시작하지 않았습니다.` };
					}
				}
			} finally {
				// The guard is ours and empty; failing to remove it only makes the next attempt report it.
				await fs.rmdir(guardPath).catch(() => undefined);
			}
		}
		return { ok: false, reason: lastGuard || sessionContentionReason(lockPath) };
	} finally {
		await fs.unlink(tmp).catch(() => undefined);
	}
}

/** Publishes a uniquely named worktree record; the name cannot be reused by a later owner. */
async function publishWorktreeRecord(
	dir: string,
	prefix: "read" | "write",
	record: LeaseRecord,
): Promise<string> {
	const payload = `${JSON.stringify(record)}\n`;
	for (;;) {
		const file = path.join(dir, `${prefix}-${record.owner.token}-${randomUUID()}.json`);
		const tmp = path.join(dir, `.${record.owner.token}-${randomUUID()}.tmp`);
		try {
			await writeRecordTemp(tmp, payload);
		} catch (error) {
			throw new Error(`실행 잠금 파일을 준비할 수 없습니다: ${dir} (${errText(error)})`);
		}
		try {
			await fs.link(tmp, file);
			return file;
		} catch (error) {
			if (errCode(error) === "EEXIST") continue;
			throw error;
		} finally {
			await fs.unlink(tmp).catch(() => undefined);
		}
	}
}

async function removePublished(recordPath: string): Promise<void> {
	try {
		await fs.unlink(recordPath);
	} catch (error) {
		if (errCode(error) !== "ENOENT") throw error;
	}
}

interface ActiveRecords {
	records: Array<{ path: string; record: LeaseRecord }>;
}

/**
 * Reads every live record of one kind in one worktree directory, reclaiming only records whose owner is provably dead.
 * Invalid records and owners whose death cannot be proven are failures, never skips.
 */
async function activeWorktreeRecords(
	dir: string,
	kind: "read" | "write",
	key: string,
	liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>,
	ignorePath?: string,
): Promise<{ ok: true; active: ActiveRecords } | { ok: false; reason: string }> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if (errCode(error) === "ENOENT") return { ok: true, active: { records: [] } };
		return { ok: false, reason: `실행 잠금 디렉터리를 읽을 수 없습니다: ${dir} (${errText(error)})` };
	}
	const active: ActiveRecords = { records: [] };
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".")) continue;
		const recordPath = path.join(dir, name);
		if (recordPath === ignorePath) continue;
		const read = await readRecord(recordPath, kind, key);
		if (read.kind === "missing") continue;
		if (read.kind === "invalid") return { ok: false, reason: invalidRecordReason(recordPath, read.detail) };
		const state = await probeOwner(liveness, read.record.owner);
		if (state === "alive") {
			active.records.push({ path: recordPath, record: read.record });
			continue;
		}
		if (state === "unknown") {
			const what = kind === "read" ? "읽기" : "쓰기";
			return {
				ok: false,
				reason: `실행 ${read.record.runId}의 ${what} 잠금 소유자(pid ${read.record.owner.pid}, 호스트 ${read.record.owner.host})가 종료됐는지 확인할 수 없습니다. 그 프로세스가 이 worktree를 아직 쓰고 있는지 확인한 뒤 다시 시작하세요. 확인 전에는 잠금 파일(${recordPath})을 지우지 마세요.`,
			};
		}
		// The file name is unique to that acquisition, so unlinking it cannot remove a newer owner.
		try {
			await unlinkIfSame(recordPath, read);
		} catch (error) {
			return { ok: false, reason: `종료된 실행 잠금을 지울 수 없습니다: ${recordPath} (${errText(error)})` };
		}
	}
	return { ok: true, active };
}

interface WorktreeRecord {
	path: string;
	record: LeaseRecord;
}

function writeGuardReason(guardPath: string): string {
	return `쓰기 실행 잠금을 조정하는 가드가 남아 있습니다: ${guardPath}. 다른 OMP 실행이 잠금을 바꾸는 중일 수 있으니 잠시 뒤 다시 시작하세요. 오래 남아 있고 이 worktree를 쓰는 OMP가 없다면 확인 후 그 디렉터리를 지우세요.`;
}

/**
 * Serializes every writer acquisition and writer scope change for one worktree. Readers never take this guard; a writer
 * publishes its record while holding it, then checks readers and overlapping writers. A stale guard is never reclaimed
 * on a timer: later writers fail closed and name it.
 */
async function withWriterGuard<T>(
	worktreeDir: string,
	run: () => Promise<{ ok: true; held: T } | { ok: false; reason: string }>,
): Promise<{ ok: true; held: T } | { ok: false; reason: string }> {
	await fs.mkdir(worktreeDir, { recursive: true, mode: 0o700 });
	const guardPath = path.join(worktreeDir, "writer.guard");
	let last = "";
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			await fs.mkdir(guardPath, { mode: 0o700 });
		} catch (error) {
			if (errCode(error) === "EEXIST") {
				last = writeGuardReason(guardPath);
				await delay(RETRY_MS);
				continue;
			}
			return { ok: false, reason: `쓰기 실행 가드를 만들 수 없습니다: ${guardPath} (${errText(error)})` };
		}
		try {
			return await run();
		} finally {
			await fs.rmdir(guardPath).catch(() => undefined);
		}
	}
	return { ok: false, reason: last || writeGuardReason(guardPath) };
}

async function acquireReader(
	worktreeDir: string,
	key: string,
	record: LeaseRecord,
	liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>,
): Promise<{ ok: true; held: WorktreeRecord } | { ok: false; reason: string }> {
	const readersDir = await ensurePrivateDir(worktreeDir, "readers");
	const writersDir = await ensurePrivateDir(worktreeDir, "writers");
	const heldPath = await publishWorktreeRecord(readersDir, "read", record);
	const writers = await activeWorktreeRecords(writersDir, "write", key, liveness);
	if (!writers.ok) {
		await removePublished(heldPath).catch(() => undefined);
		return { ok: false, reason: writers.reason };
	}
	const conflict = writers.active.records[0];
	if (conflict !== undefined) {
		await removePublished(heldPath).catch(() => undefined);
		return { ok: false, reason: readerConflictReason(record, conflict.record) };
	}
	return { ok: true, held: { path: heldPath, record } };
}

/**
 * Publishes a writer under the worktree writer guard, then checks every reader and overlapping writer. The guard makes
 * writer transitions atomic with respect to each other; a reader that races the publication either sees this record and
 * backs out or is seen here, so readers and writers never both return success.
 */
async function acquireWriter(
	baseDir: string,
	worktreeDir: string,
	key: string,
	record: LeaseRecord,
	liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>,
	ignorePath?: string,
): Promise<{ ok: true; held: WorktreeRecord } | { ok: false; reason: string }> {
	return withWriterGuard(worktreeDir, async () => {
		const readersDir = await ensurePrivateDir(worktreeDir, "readers");
		const writersDir = await ensurePrivateDir(worktreeDir, "writers");
		const heldPath = await publishWorktreeRecord(writersDir, "write", record);
		const fail = async (reason: string): Promise<{ ok: false; reason: string }> => {
			await removePublished(heldPath).catch(() => undefined);
			return { ok: false, reason };
		};
		const readers = await activeWorktreeRecords(readersDir, "read", key, liveness, ignorePath);
		if (!readers.ok) return fail(readers.reason);
		const reader = readers.active.records[0];
		if (reader !== undefined) return fail(readerConflictReason(record, reader.record));
		const writers = await activeWorktreeRecords(writersDir, "write", key, liveness, heldPath);
		if (!writers.ok) return fail(writers.reason);
		for (const other of writers.active.records) {
			if (!claimsOverlap(record.paths, other.record.paths)) continue;
			return fail(writerConflictReason(other.record, overlappingPath(record.paths, other.record.paths)));
		}
		const fenced = await writerFenceBlock(baseDir, record).catch(error => `통합 펜스를 확인할 수 없습니다: ${errText(error)}`);
		if (fenced !== undefined) return fail(fenced);
		return { ok: true, held: { path: heldPath, record } };
	});
}

function overlappingPath(a: readonly string[] | undefined, b: readonly string[] | undefined): string | undefined {
	if (a === undefined || b === undefined) return undefined;
	for (const left of a) {
		for (const right of b) {
			if (!pathsOverlap(left, right)) continue;
			return left === right || left.startsWith(`${right}/`) ? right : left;
		}
	}
	return undefined;
}

/**
 * Publishes a replacement writer record for an already held writer. The old record stays until the new one is proven
 * free of new conflicts, so the transition is atomic from every other process's point of view.
 */
async function replaceWriter(
	baseDir: string,
	worktreeDir: string,
	key: string,
	current: WorktreeRecord,
	next: LeaseRecord,
	liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>,
): Promise<{ ok: true; held: WorktreeRecord } | { ok: false; reason: string }> {
	return withWriterGuard(worktreeDir, async () => {
		const writersDir = await ensurePrivateDir(worktreeDir, "writers");
		const heldPath = await publishWorktreeRecord(writersDir, "write", next);
		const fail = async (reason: string): Promise<{ ok: false; reason: string }> => {
			await removePublished(heldPath).catch(() => undefined);
			return { ok: false, reason };
		};
		const writers = await activeWorktreeRecords(writersDir, "write", key, liveness, heldPath);
		if (!writers.ok) return fail(writers.reason);
		for (const other of writers.active.records) {
			if (other.path === current.path || !claimsOverlap(next.paths, other.record.paths)) continue;
			return fail(writerConflictReason(other.record, overlappingPath(next.paths, other.record.paths)));
		}
		const fenced = await writerFenceBlock(baseDir, next).catch(error => `통합 펜스를 확인할 수 없습니다: ${errText(error)}`);
		if (fenced !== undefined) return fail(fenced);
		return { ok: true, held: { path: heldPath, record: next } };
	});
}

/** Removes our own record after proving the path still carries the exact owner we published. */
async function removeOwnedRecord(
	recordPath: string,
	record: LeaseRecord,
	kind: LeaseRecordKind,
	key: string,
): Promise<void> {
	const current = await readRecord(recordPath, kind, key);
	if (current.kind === "missing") throw leaseReleaseError(recordPath, "잠금 파일이 사라졌습니다");
	if (current.kind === "invalid") throw leaseReleaseError(recordPath, current.detail);
	if (
		current.record.owner.token !== record.owner.token ||
		current.record.runId !== record.runId ||
		current.record.kind !== record.kind
	) {
		throw leaseReleaseError(recordPath, `다른 실행(${current.record.runId}) 또는 다른 소유자의 잠금입니다`);
	}
	if (!(await sameInode(recordPath, current))) {
		throw leaseReleaseError(recordPath, "잠금 파일이 확인 중에 바뀌었습니다");
	}
	try {
		await fs.unlink(recordPath);
	} catch (error) {
		throw leaseReleaseError(recordPath, `삭제할 수 없습니다 (${errText(error)})`);
	}
}

interface LeaseState {
	readonly runId: string;
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly root: string;
	readonly worktree: string;
	readonly baseDir: string;
	readonly owner: Readonly<LeaseOwner>;
	readonly sessionPath: string;
	readonly sessionRecord: Readonly<LeaseRecord>;
	mode: LeaseMode;
	paths: readonly string[] | undefined;
	epoch: number;
	record: Readonly<LeaseRecord>;
	recordPath: string;
	closing: boolean;
	released: boolean;
}

function snapshotOf(state: LeaseState): LeaseSnapshot {
	const paths = state.paths === undefined ? undefined : Object.freeze([...state.paths]);
	return Object.freeze({
		runId: state.runId,
		sessionId: state.sessionId,
		sessionDir: state.sessionDir,
		root: state.root,
		mode: state.mode,
		paths,
		epoch: state.epoch,
	});
}

function sameSnapshot(state: LeaseState, snapshot: LeaseSnapshot): boolean {
	return (
		state.runId === snapshot.runId &&
		state.sessionId === snapshot.sessionId &&
		state.sessionDir === snapshot.sessionDir &&
		state.root === snapshot.root &&
		state.mode === snapshot.mode &&
		state.epoch === snapshot.epoch &&
		samePaths(state.paths, snapshot.paths)
	);
}

function makeLease(state: LeaseState, liveness: (owner: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus>): RunLease {
	const owner = state.owner;
	let tail: Promise<unknown> = Promise.resolve();
	let releasePromise: Promise<void> | undefined;

	/** All mutations run in order: a delayed upgrade cannot interleave with a release or a second upgrade. */
	function exclusive<T>(run: () => Promise<T>): Promise<T> {
		const next = tail.then(run, run);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	function nextRecord(kind: "write", modePaths: readonly string[] | undefined): LeaseRecord {
		return {
			schema: SCHEMA,
			kind,
			key: state.worktree,
			root: state.root,
			runId: state.runId,
			sessionId: state.sessionId,
			sessionDir: state.sessionDir,
			owner: { ...owner },
			acquiredAt: new Date().toISOString(),
			acquiredAtMs: Date.now(),
			...(modePaths !== undefined ? { paths: [...modePaths] } : {}),
		};
	}

	async function transitionToWriter(scope: WriteScope | undefined): Promise<UpgradeResult> {
		let paths: readonly string[] | undefined;
		if (scope !== undefined && scope.kind === "paths") {
			const normalized = normalizePaths(scope.paths);
			if ("reason" in normalized) return upgradeFail(normalized.reason);
			paths = normalized.paths;
		}
		if (state.mode !== "read") return upgradeFail("이미 쓰기 실행입니다.");
		const next = nextRecord("write", paths);
		let acquired: { ok: true; held: WorktreeRecord } | { ok: false; reason: string };
		try {
			acquired = await acquireWriter(
				state.baseDir,
				path.join(state.baseDir, "worktrees", state.worktree),
				state.worktree,
				next,
				liveness,
				state.recordPath,
			);
		} catch (error) {
			return upgradeFail(`실행 잠금을 쓰기로 바꾸지 못했습니다: ${errText(error)}`);
		}
		if (!acquired.ok) return upgradeFail(acquired.reason);
		try {
			// The read record is only dropped after the writer exists and the worktree is exclusively ours.
			await removeOwnedRecord(state.recordPath, state.record, "read", state.worktree);
		} catch (error) {
			await removePublished(acquired.held.path).catch(() => undefined);
			return upgradeFail(`읽기 잠금을 정리하지 못해 쓰기로 바꾸지 않았습니다: ${errText(error)}`);
		}
		state.mode = "write";
		state.paths = paths;
		state.record = Object.freeze(next);
		state.recordPath = acquired.held.path;
		state.epoch++;
		return { ok: true };
	}

	async function replaceScope(paths: readonly string[] | undefined): Promise<UpgradeResult> {
		if (state.mode !== "write") return upgradeFail("읽기 실행은 먼저 upgrade로 쓰기 실행이 되어야 합니다.");
		if (samePaths(state.paths, paths)) return { ok: true };
		const next = nextRecord("write", paths);
		let replaced: { ok: true; held: WorktreeRecord } | { ok: false; reason: string };
		try {
			replaced = await replaceWriter(
				state.baseDir,
				path.join(state.baseDir, "worktrees", state.worktree),
				state.worktree,
				{ path: state.recordPath, record: state.record },
				next,
				liveness,
			);
		} catch (error) {
			return upgradeFail(`쓰기 경로 범위를 바꾸지 못했습니다: ${errText(error)}`);
		}
		if (!replaced.ok) return upgradeFail(replaced.reason);
		try {
			await removeOwnedRecord(state.recordPath, state.record, "write", state.worktree);
		} catch (error) {
			await removePublished(replaced.held.path).catch(() => undefined);
			return upgradeFail(`이전 쓰기 잠금을 정리하지 못해 경로 범위를 바꾸지 않았습니다: ${errText(error)}`);
		}
		state.paths = paths;
		state.record = Object.freeze(next);
		state.recordPath = replaced.held.path;
		state.epoch++;
		return { ok: true };
	}

	async function releaseInternal(): Promise<void> {
		state.released = true;
		const errors: string[] = [];
		try {
			await removeOwnedRecord(state.recordPath, state.record, state.mode === "read" ? "read" : "write", state.worktree);
		} catch (error) {
			errors.push(errText(error));
		}
		try {
			await removeOwnedRecord(state.sessionPath, state.sessionRecord, "session", sessionKey(state.sessionDir, state.sessionId));
		} catch (error) {
			errors.push(errText(error));
		}
		if (errors.length > 0) throw leaseReleaseError(`${state.recordPath}, ${state.sessionPath}`, errors.join("; "));
	}

	return Object.freeze({
		runId: state.runId,
		sessionId: state.sessionId,
		sessionDir: state.sessionDir,
		root: state.root,
		get mode(): LeaseMode {
			return state.mode;
		},
		get paths(): readonly string[] | undefined {
			return state.paths === undefined ? undefined : Object.freeze([...state.paths]);
		},
		get epoch(): number {
			return state.epoch;
		},
		owner,
		get record(): Readonly<LeaseRecord> {
			return state.record;
		},
		get path(): string {
			return state.recordPath;
		},
		sessionPath: state.sessionPath,
		snapshot(): LeaseSnapshot {
			return snapshotOf(state);
		},
		assertCurrent(snapshot: LeaseSnapshot): void {
			if (state.closing || state.released || !sameSnapshot(state, snapshot)) throw leaseChangedError();
		},
		upgrade(input: { scope?: WriteScope } = {}): Promise<UpgradeResult> {
			return exclusive(async () => {
				if (state.closing || state.released) return upgradeFail("이미 해제된 실행 잠금은 바꿀 수 없습니다.");
				if (state.mode === "read") return transitionToWriter(input.scope);
				if (input.scope === undefined || input.scope.kind === "unbounded") return replaceScope(undefined);
				const normalized = normalizePaths(input.scope.paths);
				if ("reason" in normalized) return upgradeFail(normalized.reason);
				return replaceScope(normalized.paths);
			});
		},
		setWritePaths(paths: readonly string[]): Promise<UpgradeResult> {
			return exclusive(async () => {
				if (state.closing || state.released) return upgradeFail("이미 해제된 실행 잠금은 바꿀 수 없습니다.");
				const normalized = normalizePaths(paths);
				if ("reason" in normalized) return upgradeFail(normalized.reason);
				return replaceScope(normalized.paths);
			});
		},
		release(): Promise<void> {
			if (releasePromise === undefined) {
				state.closing = true;
				releasePromise = exclusive(releaseInternal);
			}
			return releasePromise;
		},
	});
}

/**
 * Acquires one session slot and the worktree access it needs.
 *
 * On success the caller owns both until `lease.release()` settles. A failed acquisition leaves no record of this run:
 * every publication is removed before the refusal returns, and only records proven dead are ever deleted.
 */
export async function acquireRunLease(
	input: AcquireRunLeaseInput,
	deps: LeaseDeps = {},
): Promise<AcquireRunLeaseResult> {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		return fail(`실행 잠금은 macOS와 Linux에서만 지원합니다(현재 ${process.platform}). 실행을 시작하지 않았습니다.`);
	}
	if (!cleanId(input.runId)) {
		return fail(`실행 id가 올바르지 않습니다: ${JSON.stringify(input.runId)}. 실행을 시작하지 않았습니다.`);
	}
	let sessionId: string;
	let sessionDirText: string;
	try {
		sessionId = cleanIdentity(input.sessionId, "세션 id");
		sessionDirText = cleanIdentity(input.sessionDir, "세션 디렉터리");
	} catch (error) {
		return fail(errText(error));
	}
	if (!path.isAbsolute(sessionDirText)) {
		return fail(`세션 디렉터리는 절대 경로여야 합니다: ${sessionDirText}. 실행을 시작하지 않았습니다.`);
	}
	if (input.mode !== "read" && input.mode !== "write") {
		return fail("실행 잠금 모드는 read 또는 write여야 합니다. 실행을 시작하지 않았습니다.");
	}
	let paths: readonly string[] | undefined;
	if (input.mode === "read") {
		if (input.scope !== undefined) return fail("읽기 실행에는 쓰기 경로 범위를 줄 수 없습니다. 실행을 시작하지 않았습니다.");
	} else if (input.scope !== undefined && input.scope.kind === "paths") {
		const normalized = normalizePaths(input.scope.paths);
		if ("reason" in normalized) return fail(normalized.reason);
		paths = normalized.paths;
	} else if (input.scope !== undefined && input.scope.kind !== "unbounded") {
		return fail("쓰기 실행의 범위 형식이 올바르지 않습니다. 실행을 시작하지 않았습니다.");
	}

	if (typeof input.root !== "string" || input.root.length === 0) {
		return fail("worktree 루트가 비어 있습니다. 실행을 시작하지 않았습니다.");
	}
	const canonical = await canonicalizeRoot(input.root);
	if (!("worktree" in canonical)) return fail(canonical.reason);
	const canonicalSessionDir = await canonicalizeSessionDir(sessionDirText);
	if (canonicalSessionDir === undefined) {
		return fail(`세션 디렉터리를 확인할 수 없습니다: ${sessionDirText}. 실행을 시작하지 않았습니다.`);
	}

	let baseDir: string;
	try {
		baseDir = deps.dir !== undefined ? deps.dir : defaultLeaseDir();
	} catch (error) {
		return fail(`잠금 디렉터리를 정할 수 없습니다 (${errText(error)}). 실행을 시작하지 않았습니다.`);
	}
	if (!path.isAbsolute(baseDir)) return fail(`잠금 디렉터리는 절대 경로여야 합니다: ${baseDir}. 실행을 시작하지 않았습니다.`);
	// Resolve the existing ancestor before creating anything, so a symlinked parent into the worktree is caught
	// without writing there. prepareLeaseDir repeats the check on the real path before tightening permissions.
	const prospective = await prospectivePath(baseDir);
	if (prospective === undefined) {
		return fail(`잠금 디렉터리 경로를 확인할 수 없습니다: ${baseDir}. 접근 가능한 절대 경로를 지정하세요.`);
	}
	if (isInside(canonical.root, prospective)) {
		return fail(`잠금 디렉터리가 worktree 안에 있습니다: ${prospective}. worktree 밖의 디렉터리를 지정하세요.`);
	}
	const prepared = await prepareLeaseDir(baseDir, canonical.root);
	if ("reason" in prepared) return fail(prepared.reason);
	baseDir = prepared.dir;

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
	const now = Date.now();
	const common = {
		schema: SCHEMA as typeof SCHEMA,
		root: canonical.root,
		runId: input.runId,
		sessionId,
		sessionDir: canonicalSessionDir,
		owner,
		acquiredAt: new Date(now).toISOString(),
		acquiredAtMs: now,
	};
	const key = sessionKey(canonicalSessionDir, sessionId);
	const sessionRecord: LeaseRecord = { ...common, kind: "session", key };
	const liveness: (candidate: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus> =
		deps.liveness ?? ((candidate: LeaseOwner): LeaseOwnerStatus => defaultOwnerStatus(candidate, host));

	let session: { ok: true; slot: SessionSlot } | { ok: false; reason: string };
	try {
		session = await acquireSessionSlot(baseDir, key, sessionRecord, liveness);
	} catch (error) {
		return fail(`세션 실행 잠금을 확인하지 못했습니다: ${errText(error)}. 실행을 시작하지 않았습니다.`);
	}
	if (!session.ok) return fail(session.reason);

	const releaseSession = async (): Promise<string | undefined> => {
		try {
			await removeOwnedRecord(session.slot.path, session.slot.record, "session", key);
			return undefined;
		} catch (error) {
			return errText(error);
		}
	};

	const worktreeDir = await ensurePrivateDir(baseDir, "worktrees", canonical.worktree).catch(async error => {
		const cleanup = await releaseSession();
		return fail(`실행 잠금 디렉터리를 만들 수 없습니다: ${errText(error)}${cleanup === undefined ? "" : ` (${cleanup})`}`);
	});
	if (typeof worktreeDir !== "string") return worktreeDir;

	let held: { ok: true; held: WorktreeRecord } | { ok: false; reason: string };
	try {
		if (input.mode === "read") {
			const readRecord: LeaseRecord = { ...common, kind: "read", key: canonical.worktree };
			held = await acquireReader(worktreeDir, canonical.worktree, readRecord, liveness);
		} else {
			const writeRecord: LeaseRecord = {
				...common,
				kind: "write",
				key: canonical.worktree,
				...(paths !== undefined ? { paths: [...paths] } : {}),
			};
			held = await acquireWriter(baseDir, worktreeDir, canonical.worktree, writeRecord, liveness);
		}
	} catch (error) {
		const cleanup = await releaseSession();
		return fail(`실행 잠금을 확인하지 못했습니다: ${errText(error)}${cleanup === undefined ? "" : ` (${cleanup})`}`);
	}
	if (!held.ok) {
		const cleanup = await releaseSession();
		return fail(`${held.reason}${cleanup === undefined ? "" : ` (세션 잠금 정리 실패: ${cleanup})`}`);
	}

	const state: LeaseState = {
		runId: input.runId,
		sessionId,
		sessionDir: canonicalSessionDir,
		root: canonical.root,
		worktree: canonical.worktree,
		baseDir,
		owner: Object.freeze({ ...owner }),
		sessionPath: session.slot.path,
		sessionRecord: Object.freeze(session.slot.record),
		mode: input.mode,
		paths,
		epoch: 0,
		record: Object.freeze(held.held.record),
		recordPath: held.held.path,
		closing: false,
		released: false,
	};
	return { ok: true, lease: makeLease(state, liveness) };
}

/**
 * Takes only the session owner slot, with no worktree read/write record.
 *
 * `/storm reset` uses this so it can clear this session's own Storm data while a different native session writes the
 * same worktree; an active run of the same session is still refused. The returned lease never touches the worktree.
 */
export async function acquireSessionLease(
	input: AcquireSessionLeaseInput,
	deps: LeaseDeps = {},
): Promise<AcquireSessionLeaseResult> {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		return { ok: false, reason: `실행 잠금은 macOS와 Linux에서만 지원합니다(현재 ${process.platform}). 실행을 시작하지 않았습니다.` };
	}
	if (!cleanId(input.runId)) {
		return { ok: false, reason: `실행 id가 올바르지 않습니다: ${JSON.stringify(input.runId)}. 실행을 시작하지 않았습니다.` };
	}
	let sessionId: string;
	let sessionDirText: string;
	try {
		sessionId = cleanIdentity(input.sessionId, "세션 id");
		sessionDirText = cleanIdentity(input.sessionDir, "세션 디렉터리");
	} catch (error) {
		return { ok: false, reason: errText(error) };
	}
	if (!path.isAbsolute(sessionDirText)) {
		return { ok: false, reason: `세션 디렉터리는 절대 경로여야 합니다: ${sessionDirText}. 실행을 시작하지 않았습니다.` };
	}
	const canonicalSessionDir = await canonicalizeSessionDir(sessionDirText);
	if (canonicalSessionDir === undefined) {
		return { ok: false, reason: `세션 디렉터리를 확인할 수 없습니다: ${sessionDirText}. 실행을 시작하지 않았습니다.` };
	}
	let baseDir: string;
	try {
		baseDir = deps.dir !== undefined ? deps.dir : defaultLeaseDir();
	} catch (error) {
		return { ok: false, reason: `잠금 디렉터리를 정할 수 없습니다 (${errText(error)}). 실행을 시작하지 않았습니다.` };
	}
	if (!path.isAbsolute(baseDir)) {
		return { ok: false, reason: `잠금 디렉터리는 절대 경로여야 합니다: ${baseDir}. 실행을 시작하지 않았습니다.` };
	}
	const prepared = await prepareLeaseDir(baseDir);
	if ("reason" in prepared) return { ok: false, reason: prepared.reason };
	baseDir = prepared.dir;
	let host: string;
	try {
		host = os.hostname();
	} catch (error) {
		return { ok: false, reason: `호스트 이름을 확인할 수 없습니다 (${errText(error)}). 실행을 시작하지 않았습니다.` };
	}
	const owner: LeaseOwner = {
		token: randomUUID(),
		pid: process.pid,
		host,
		processStart: Math.round(performance.timeOrigin),
	};
	const now = Date.now();
	const key = sessionKey(canonicalSessionDir, sessionId);
	const record: LeaseRecord = {
		schema: SCHEMA,
		kind: "session",
		key,
		root: "",
		runId: input.runId,
		sessionId,
		sessionDir: canonicalSessionDir,
		owner,
		acquiredAt: new Date(now).toISOString(),
		acquiredAtMs: now,
	};
	const liveness: (candidate: LeaseOwner) => LeaseOwnerStatus | Promise<LeaseOwnerStatus> =
		deps.liveness ?? ((candidate: LeaseOwner): LeaseOwnerStatus => defaultOwnerStatus(candidate, host));
	let acquired: { ok: true; slot: SessionSlot } | { ok: false; reason: string };
	try {
		acquired = await acquireSessionSlot(baseDir, key, record, liveness);
	} catch (error) {
		return { ok: false, reason: `세션 실행 잠금을 확인하지 못했습니다: ${errText(error)}. 실행을 시작하지 않았습니다.` };
	}
	if (!acquired.ok) return { ok: false, reason: acquired.reason };
	const frozenOwner = Object.freeze({ ...owner });
	const frozenRecord = Object.freeze(record);
	let releasePromise: Promise<void> | undefined;
	return {
		ok: true,
		lease: Object.freeze({
			runId: input.runId,
			sessionId,
			sessionDir: canonicalSessionDir,
			owner: frozenOwner,
			record: frozenRecord,
			path: acquired.slot.path,
			release(): Promise<void> {
				releasePromise ??= removeOwnedRecord(acquired.slot.path, frozenRecord, "session", key);
				return releasePromise;
			},
		}),
	};
}
