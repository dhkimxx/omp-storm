/**
 * Approval-bound execution of a config's named `jobs`.
 *
 * A job is one executable and its arguments, copied from the approved config and spawned directly in the caller's
 * target tree: no shell, no interpolation, no generated script, no terminal and no model-chosen argument. This module
 * decides only whether the caller may start that exact command and records what the OS actually did. Plan binding,
 * selection, storage, dedup and automatic scheduling stay with the parent runtime; a job name is never authority by
 * itself.
 *
 * Resource fences are host-global for one user, not a cross-machine queue. Each explicit canonical key gets a lock
 * record in a fixed per-user lock root (`/tmp` on macOS and Linux; the OS temp directory elsewhere), created with a
 * hard link so a record is never partially visible. Sorted keys are acquired in order and held until the child's
 * `close` is observed; unrelated keys overlap. A job that declares no resources has no implicit key here: the caller
 * must pass a target-exclusive key for it, because this module cannot know its write footprint. When teardown cannot
 * prove the child ended, the fence is kept and the receipt says so instead of pretending the resource is free.
 *
 * A recorded owner's death is never proof its detached child process group ended. This module therefore never deletes
 * a fence merely because the recorded parent PID is gone; it refuses to start, names the fence path and asks a human
 * to verify that no child remains before removing it. Queue waiting is finite and uses the job's own timeout.
 *
 * A caller that holds the target's write lease can also set `targetFence`. For each attempt that reaches the spawn
 * point, a durable marker is written in the same host-global namespace, keyed by the target's `stat` dev+ino rather
 * than by a declared resource key. It survives an OMP crash or an unproven child and is removed only after OS proof or
 * before a child exists. `targetJobBlock` is the read-only guard a new run uses before touching that target.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
	canonicalResourceKey,
	isRecord,
	MAX_CHECK_ARG_LENGTH,
	MAX_CHECK_ARGS,
	MAX_CHECK_ARGV_LENGTH,
	MAX_CHECK_NAME_LENGTH,
	MAX_JOB_RESOURCES,
	MAX_JOB_TIMEOUT_MS,
	MAX_RESOURCE_KEY_LENGTH,
} from "../config/schema.ts";
import type { ConfiguredJob } from "../types.ts";
import { MAX_CHECK_OUTPUT_BYTES, runBoundedProcess, type BoundedProcessResult, type CheckOutput } from "./checks.ts";
import {
	acquireTargetMarker,
	ensureLockDir,
	errorCode,
	HOST,
	isFenceOwner,
	ownerState,
	PROCESS_START,
	releaseTargetMarker,
	type FenceOwner,
	type TargetMarker,
} from "./job-fence.ts";

/** Per-job wall clock when the approved config sets none. */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
/** The scheduler accepts a bounded key set per call; config validation bounds the declared list separately. */
const MAX_RUNTIME_RESOURCE_KEYS = 64;
const LOCK_SCHEMA = "storm.job-resource/v1";
/** Lock records are small; anything larger is not one of ours and must not be parsed. */
const MAX_LOCK_RECORD_BYTES = 16_384;
const LOCK_POLL_MS = 25;
const EMPTY_OUTPUT: Readonly<CheckOutput> = Object.freeze({ tail: "", totalBytes: 0, truncated: false });

export type JobStatus = "passed" | "failed" | "timed-out" | "cancelled" | "spawn-error" | "unrun";

/** Why a job never produced a child. The caller decides which of these are retryable waits and which are blockers. */
export type JobUnrunCause =
	| "queue-timeout"
	| "owner-dead"
	| "owner-unknown"
	| "record-invalid"
	| "revoked"
	| "cancelled"
	| "invalid";

export type JobFenceCause = "process-unproven" | "lock-unreleased";

/** A fence retained by this attempt, with every file a human or a later proof must release. */
export interface JobFence {
	cause: JobFenceCause;
	paths: readonly string[];
}

/**
 * What one configured job did. `argv` is deliberately absent: the caller already bound the approved name to an
 * argv, and copying it into a receipt would invite a later reader to treat output as a new command.
 */
export interface JobExecutionReceipt {
	name: string;
	status: JobStatus;
	/** Real exit code when the process reported one; null for a signal, spawn error, cancellation or unrun. */
	exitCode: number | null;
	/** The OS signal that ended the process, if any. */
	signal: string | null;
	/** ISO 8601 of the actual spawn; null when nothing was started. */
	startedAt: string | null;
	/** ISO 8601 of the observed end; null when nothing was started. */
	finishedAt: string | null;
	durationMs: number;
	/** Bounded tail of each stream, with the real byte count so a caller can tell a short log from a cut one. */
	stdout: CheckOutput;
	stderr: CheckOutput;
	/** A short fixed explanation (timeout, cancellation, lock uncertainty); never raw command output. */
	detail?: string;
	/**
	 * Present only when this attempt kept a fence: `process-unproven` when the child's end could not be confirmed,
	 * `lock-unreleased` when the child ended or never started but a lock file stayed. Absent means everything was
	 * released or no fence was needed.
	 */
	fence?: JobFence;
	/** Present only with `status: "unrun"`; typed at the source, never parsed back from `detail`. */
	unrunCause?: JobUnrunCause;
}

export interface RunConfiguredJobInput {
	/** The exact approved job. The caller selects it by name; this module never resolves a name to a command. */
	job: ConfiguredJob;
	/** The run's target tree. The executable runs here and nowhere else. */
	cwd: string;
	/**
	 * Opaque canonical resource keys to hold exclusively for this attempt. The caller derives them from approved plan
	 * data, never from model text. A job with no declared resources must be passed a target-exclusive key by the
	 * caller; an empty list means the caller has proven the job needs no fence.
	 */
	resourceKeys: readonly string[];
	/** Cancels both queue waiting and the running process group. */
	signal?: AbortSignal;
	/**
	 * Set only when the caller holds the target's write lease and wants a durable per-spawn marker in the host-global
	 * fence namespace. The marker is keyed by the canonical target identity (stat dev+ino) and is written after the
	 * resource locks and before `canStart`. It survives an OMP crash or an unproven child and is removed only after the
	 * OS proves the child ended or before any child exists.
	 */
	targetFence?: true;
	/**
	 * Revalidated after every lock is held and immediately before spawning. Return false when the selection, approval,
	 * plan or tree changed while this attempt waited; the job is then `unrun` and every lock is released.
	 */
	canStart?: () => boolean | Promise<boolean>;
}

interface ResourceLockRecord {
	schema: typeof LOCK_SCHEMA;
	key: string;
	owner: FenceOwner;
	acquiredAt: string;
}

interface HeldLock {
	path: string;
	key: string;
	token: string;
}

type LockRead =
	| { kind: "missing" }
	| { kind: "invalid"; detail: string }
	| { kind: "valid"; record: ResourceLockRecord };

function joinDetails(...details: Array<string | undefined>): string | undefined {
	const parts = details.filter((detail): detail is string => detail !== undefined && detail !== "");
	return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Read the abort flag without TypeScript narrowing every later `signal.aborted` read to the first check. */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function fenceOf(cause: JobFenceCause, paths: readonly string[]): JobFence {
	return { cause, paths: Object.freeze([...new Set(paths)]) };
}

function emptyReceipt(
	name: string,
	detail: string,
	extra: { unrunCause: JobUnrunCause; fence?: JobFence },
): JobExecutionReceipt {
	return {
		name,
		status: "unrun",
		exitCode: null,
		signal: null,
		startedAt: null,
		finishedAt: null,
		durationMs: 0,
		stdout: EMPTY_OUTPUT,
		stderr: EMPTY_OUTPUT,
		detail,
		unrunCause: extra.unrunCause,
		...(extra.fence === undefined ? {} : { fence: extra.fence }),
	};
}

function executedReceipt(
	name: string,
	result: BoundedProcessResult,
	extra: { detail?: string | undefined; fence?: JobFence },
): JobExecutionReceipt {
	const detail = joinDetails(result.note, extra.detail);
	return {
		name,
		status: result.status,
		exitCode: result.exitCode,
		signal: result.signal,
		startedAt: result.startedAt,
		finishedAt: result.finishedAt,
		durationMs: result.durationMs,
		stdout: result.stdout,
		stderr: result.stderr,
		...(detail === undefined ? {} : { detail }),
		...(extra.fence === undefined ? {} : { fence: extra.fence }),
	};
}

/** A defensive check at the execution boundary: config validation normally made every one of these true. */
function jobIssue(job: ConfiguredJob): string | undefined {
	if (typeof job !== "object" || job === null) return "작업 정의가 객체가 아닙니다";
	if (
		typeof job.name !== "string" ||
		job.name.trim() === "" ||
		job.name !== job.name.trim() ||
		job.name.length > MAX_CHECK_NAME_LENGTH
	) {
		return `작업 이름은 앞뒤 공백 없이 ${MAX_CHECK_NAME_LENGTH}자 이하여야 합니다`;
	}
	if (!Array.isArray(job.argv) || job.argv.length === 0) return "작업 argv: 실행 파일과 인자를 담은 배열이어야 합니다";
	if (job.argv.length > MAX_CHECK_ARGS) return `작업 argv: 최대 ${MAX_CHECK_ARGS}개까지 둘 수 있습니다`;
	let total = 0;
	for (const [index, arg] of job.argv.entries()) {
		if (typeof arg !== "string" || arg.length > MAX_CHECK_ARG_LENGTH) {
			return `작업 argv[${index}]: ${MAX_CHECK_ARG_LENGTH}자 이하의 문자열이어야 합니다`;
		}
		if (index === 0 && arg.trim() === "") return "작업 argv[0]: 실행 파일이 비어 있습니다";
		total += arg.length;
	}
	if (total > MAX_CHECK_ARGV_LENGTH) return `작업 argv: 실행 파일과 인자를 합쳐 ${MAX_CHECK_ARGV_LENGTH}자 이하여야 합니다`;
	if (job.resources !== undefined) {
		if (!Array.isArray(job.resources) || job.resources.length > MAX_JOB_RESOURCES) {
			return `작업 resources: 최대 ${MAX_JOB_RESOURCES}개의 배열이어야 합니다`;
		}
		const seen = new Set<string>();
		for (const resource of job.resources) {
			const key = canonicalResourceKey(resource);
			if (key === undefined) {
				return `작업 resources: ${MAX_RESOURCE_KEY_LENGTH}자 이하의 영문·숫자·. _ : / @ + = # - 자원 키여야 합니다`;
			}
			if (seen.has(key)) return `작업 resources: 중복된 자원 키입니다 (${key})`;
			seen.add(key);
		}
	}
	if (
		job.timeoutMs !== undefined &&
		(!Number.isInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > MAX_JOB_TIMEOUT_MS)
	) {
		return `작업 timeoutMs: 1~${MAX_JOB_TIMEOUT_MS} 사이 정수여야 합니다`;
	}
	return undefined;
}

function canonicalResourceKeys(
	input: readonly string[],
): { ok: true; keys: readonly string[] } | { ok: false; detail: string } {
	if (!Array.isArray(input)) return { ok: false, detail: "resourceKeys: 배열이어야 합니다" };
	if (input.length > MAX_RUNTIME_RESOURCE_KEYS) {
		return { ok: false, detail: `resourceKeys: 최대 ${MAX_RUNTIME_RESOURCE_KEYS}개까지 받을 수 있습니다` };
	}
	const unique = new Set<string>();
	for (const value of input) {
		const key = canonicalResourceKey(value);
		if (key === undefined) {
			return {
				ok: false,
				detail: `resourceKeys: ${MAX_RESOURCE_KEY_LENGTH}자 이하의 영문·숫자·. _ : / @ + = # - 자원 키여야 합니다`,
			};
		}
		unique.add(key);
	}
	return { ok: true, keys: Object.freeze([...unique].sort()) };
}

function lockPathFor(dir: string, key: string): string {
	return path.join(dir, `${createHash("sha256").update(key).digest("hex")}.lock`);
}

function isLockRecord(value: unknown, key: string): value is ResourceLockRecord {
	if (!isRecord(value) || value.schema !== LOCK_SCHEMA || value.key !== key) return false;
	if (!isFenceOwner(value.owner)) return false;
	return typeof value.acquiredAt === "string" && Number.isFinite(Date.parse(value.acquiredAt));
}

/**
 * Opens without following a symlink and reads at most `MAX_LOCK_RECORD_BYTES`, so an unrelated file cannot be mistaken
 * for a lock or exhaust memory. Any failure other than ENOENT is `invalid`: the caller refuses rather than guesses.
 */
async function readLockRecord(lockPath: string, key: string): Promise<LockRead> {
	let handle: FileHandle;
	try {
		handle = await fs.open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", detail: `잠금 파일을 열 수 없습니다 (${errorCode(error)})` };
	}
	try {
		const st = await handle.stat({ bigint: true });
		if (!st.isFile()) return { kind: "invalid", detail: "잠금 파일이 일반 파일이 아닙니다" };
		if (st.size > BigInt(MAX_LOCK_RECORD_BYTES)) return { kind: "invalid", detail: "잠금 파일이 너무 큽니다" };
		let text: string;
		try {
			text = await handle.readFile({ encoding: "utf8" });
		} catch (error) {
			return { kind: "invalid", detail: `잠금 파일을 읽을 수 없습니다 (${errorCode(error)})` };
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return { kind: "invalid", detail: "JSON이 아닙니다" };
		}
		if (!isLockRecord(value, key)) return { kind: "invalid", detail: "소유자 기록 형식이 올바르지 않습니다" };
		return { kind: "valid", record: value };
	} catch (error) {
		return { kind: "invalid", detail: `잠금 파일을 확인할 수 없습니다 (${errorCode(error)})` };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function waitForResource(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (isAborted(signal)) return Promise.resolve(false);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const finish = (value: boolean): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		resolve(value);
	};
	const timer = setTimeout(() => finish(true), ms);
	const onAbort = (): void => finish(false);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

async function writeLockRecord(
	dir: string,
	key: string,
	record: ResourceLockRecord,
): Promise<{ ok: true; tmp: string } | { ok: false; detail: string }> {
	const prefix = createHash("sha256").update(key).digest("hex").slice(0, 16);
	const tmp = path.join(dir, `.${prefix}.${record.owner.token}.tmp`);
	let handle: FileHandle;
	try {
		handle = await fs.open(tmp, "wx", 0o600);
	} catch (error) {
		return { ok: false, detail: `자원 잠금 파일을 준비할 수 없습니다 (${errorCode(error)})` };
	}
	try {
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		// The link publishes the record; sync first so a host crash cannot publish an empty/partial owner.
		await handle.sync();
		return { ok: true, tmp };
	} catch (error) {
		await fs.unlink(tmp).catch(() => undefined);
		return { ok: false, detail: `자원 잠금 파일을 쓸 수 없습니다 (${errorCode(error)})` };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** Only one `link` can publish the fixed name, so a lock record is either absent or complete. */
async function publishLock(tmp: string, lockPath: string): Promise<boolean> {
	try {
		await fs.link(tmp, lockPath);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
}

/**
 * Acquires one fence. It never removes an existing record: a dead parent PID does not prove the detached child
 * process group ended, so a dead or unreadable owner stops the attempt and returns the fence path for manual
 * verification. Only an owner proven alive is waited on, until the caller's finite queue deadline.
 */
async function acquireResourceLock(
	dir: string,
	key: string,
	signal: AbortSignal | undefined,
	deadline: number,
	queueTimeoutMs: number,
): Promise<{ ok: true; held: HeldLock } | { ok: false; cause: JobUnrunCause; detail: string }> {
	const lockPath = lockPathFor(dir, key);
	const record: ResourceLockRecord = {
		schema: LOCK_SCHEMA,
		key,
		owner: { token: randomUUID(), pid: process.pid, host: HOST, processStart: PROCESS_START },
		acquiredAt: new Date().toISOString(),
	};
	const written = await writeLockRecord(dir, key, record);
	if (!written.ok) return { ok: false, cause: "invalid", detail: written.detail };
	try {
		for (;;) {
			if (isAborted(signal)) {
				return { ok: false, cause: "cancelled", detail: "자원을 기다리는 중에 취소되었습니다" };
			}
			if (performance.now() >= deadline) {
				return {
					ok: false,
					cause: "queue-timeout",
					detail: `자원 ${key} 대기 시간 한도 ${queueTimeoutMs}ms를 넘었습니다. 다른 실행이 그 자원을 쓰고 있는지 확인하세요: ${lockPath}`,
				};
			}
			let linked: boolean;
			try {
				linked = await publishLock(written.tmp, lockPath);
			} catch (error) {
				return { ok: false, cause: "invalid", detail: `자원 잠금을 만들 수 없습니다 (${errorCode(error)})` };
			}
			if (linked) {
				return { ok: true, held: { path: lockPath, key, token: record.owner.token } };
			}
			const current = await readLockRecord(lockPath, key);
			if (current.kind === "missing") continue;
			if (current.kind === "invalid") {
				return {
					ok: false,
					cause: "record-invalid",
					detail: `자원 ${key}의 잠금 기록을 확인할 수 없습니다: ${lockPath} (${current.detail}). 실행 중인 자식 프로세스가 없는지 확인한 뒤 이 잠금 파일을 직접 지우세요.`,
				};
			}
			const owner = current.record.owner;
			const state = ownerState(owner);
			if (state === "alive") {
				const waitMs = Math.min(LOCK_POLL_MS, Math.max(0, deadline - performance.now()));
				if (waitMs <= 0) {
					return {
						ok: false,
						cause: "queue-timeout",
						detail: `자원 ${key} 대기 시간 한도 ${queueTimeoutMs}ms를 넘었습니다. 다른 실행이 그 자원을 쓰고 있는지 확인하세요: ${lockPath}`,
					};
				}
				if (!(await waitForResource(waitMs, signal))) {
					return { ok: false, cause: "cancelled", detail: "자원을 기다리는 중에 취소되었습니다" };
				}
				continue;
			}
			if (state === "dead") {
				return {
					ok: false,
					cause: "owner-dead",
					detail: `자원 ${key}의 잠금 소유자(pid ${owner.pid}, 호스트 ${owner.host})가 종료된 것으로 보이지만, 그 프로세스가 띄운 자식 프로세스 그룹이 아직 실행 중일 수 있어 자동으로 지우지 않았습니다. 실행 중인 자식이 없는지 확인한 뒤 이 잠금 파일을 직접 지우세요: ${lockPath}`,
				};
			}
			return {
				ok: false,
				cause: "owner-unknown",
				detail: `자원 ${key}의 잠금 소유자(pid ${owner.pid}, 호스트 ${owner.host})가 종료됐는지 확인할 수 없습니다. 실행 중인 자식이 없는지 확인한 뒤 이 잠금 파일을 직접 지우세요: ${lockPath}`,
			};
		}
	} finally {
		await fs.unlink(written.tmp).catch(() => undefined);
	}
}

async function releaseResourceLock(held: HeldLock): Promise<{ ok: true } | { ok: false; detail: string }> {
	const current = await readLockRecord(held.path, held.key);
	if (current.kind === "missing") return { ok: true };
	if (current.kind === "invalid") {
		return { ok: false, detail: `자원 ${held.key}의 잠금 기록을 확인할 수 없어 해제하지 않았습니다: ${held.path}` };
	}
	if (current.record.owner.token !== held.token) {
		return { ok: false, detail: `자원 ${held.key}의 잠금 소유자가 바뀌어 해제하지 않았습니다: ${held.path}` };
	}
	try {
		await fs.unlink(held.path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { ok: true };
		return { ok: false, detail: `자원 ${held.key}의 잠금을 해제하지 못했습니다 (${errorCode(error)}): ${held.path}` };
	}
	return { ok: true };
}

async function releaseLocks(
	held: readonly HeldLock[],
): Promise<{ paths: readonly string[]; detail?: string }> {
	const paths: string[] = [];
	const failures: string[] = [];
	for (const lock of held) {
		const released = await releaseResourceLock(lock);
		if (released.ok) continue;
		paths.push(lock.path);
		failures.push(released.detail);
	}
	return { paths, ...(failures.length === 0 ? {} : { detail: failures.join(" · ") }) };
}

/**
 * Runs one approved job under its caller-supplied resource keys and, when the caller holds the target's write lease,
 * one durable target marker. The job is `unrun` when validation, lock acquisition, a dead/unreadable fence, bounded
 * queue waiting, cancellation or `canStart` stops it before a child exists; `unrunCause` says which. A running child,
 * including one ended by timeout or abort, reports the OS outcome. Fences are released only after the OS proves the
 * end (or before any child exists), and a failed release is reported as `lock-unreleased` with every exact path. When
 * teardown cannot prove the end, the receipt says `process-unproven`; a later `close` releases only this attempt's
 * exact tokens, and never on a timeout or a dead PID alone.
 */
export async function runConfiguredJob(input: RunConfiguredJobInput): Promise<JobExecutionReceipt> {
	const job = input.job;
	const issue = jobIssue(job);
	if (issue !== undefined) {
		const name = typeof job === "object" && job !== null && typeof job.name === "string"
			? job.name.slice(0, MAX_CHECK_NAME_LENGTH)
			: "";
		return emptyReceipt(name, issue, { unrunCause: "invalid" });
	}
	const name = job.name;
	const keys = canonicalResourceKeys(input.resourceKeys);
	if (!keys.ok) return emptyReceipt(name, keys.detail, { unrunCause: "invalid" });
	if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
		return emptyReceipt(name, "작업 디렉터리가 비어 있습니다", { unrunCause: "invalid" });
	}
	if (isAborted(input.signal)) return emptyReceipt(name, "취소되었습니다", { unrunCause: "cancelled" });

	const timeoutMs = job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
	const held: HeldLock[] = [];
	let marker: TargetMarker | undefined;
	const stopBeforeSpawn = async (cause: JobUnrunCause, detail: string): Promise<JobExecutionReceipt> => {
		const markerRelease = marker === undefined ? { ok: true as const } : await releaseTargetMarker(marker);
		const released = await releaseLocks(held);
		const paths = [...(markerRelease.ok || marker === undefined ? [] : [marker.path]), ...released.paths];
		const fullDetail = joinDetails(detail, markerRelease.ok ? undefined : markerRelease.detail, released.detail) ?? detail;
		return emptyReceipt(name, fullDetail, {
			unrunCause: cause,
			...(paths.length === 0 ? {} : { fence: fenceOf("lock-unreleased", paths) }),
		});
	};

	if (keys.keys.length > 0) {
		const prepared = await ensureLockDir();
		if (!prepared.ok) return emptyReceipt(name, prepared.detail, { unrunCause: "invalid" });
		// The job's own timeout also bounds queue waiting; the process gets a fresh full timeout after spawning.
		const queueDeadline = performance.now() + timeoutMs;
		for (const key of keys.keys) {
			const acquired = await acquireResourceLock(prepared.dir, key, input.signal, queueDeadline, timeoutMs);
			if (!acquired.ok) return stopBeforeSpawn(acquired.cause, acquired.detail);
			held.push(acquired.held);
		}
	}
	if (isAborted(input.signal)) return stopBeforeSpawn("cancelled", "취소되었습니다");

	// After the resource locks and before `canStart`: the controller journals a write-ahead receipt in `canStart`, so a
	// crash between the two still leaves a target marker for the next run to find.
	if (input.targetFence === true) {
		const acquired = await acquireTargetMarker(input.cwd, name);
		if (!acquired.ok) return stopBeforeSpawn(acquired.cause, acquired.detail);
		marker = acquired.marker;
	}
	if (isAborted(input.signal)) return stopBeforeSpawn("cancelled", "취소되었습니다");

	if (input.canStart !== undefined) {
		let canStart = false;
		try {
			canStart = await input.canStart();
		} catch {
			canStart = false;
		}
		if (!canStart) return stopBeforeSpawn("revoked", "시작 조건이 더 이상 충족되지 않아 실행하지 않았습니다");
	}
	if (isAborted(input.signal)) return stopBeforeSpawn("cancelled", "취소되었습니다");

	let result: BoundedProcessResult;
	try {
		result = await runBoundedProcess({
			argv: job.argv,
			cwd: input.cwd,
			timeoutMs,
			outputLimitBytes: MAX_CHECK_OUTPUT_BYTES,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
	} catch (error) {
		// The shared runner settles instead of throwing; if that ever changes, the child's end is unproven.
		const paths = [...(marker === undefined ? [] : [marker.path]), ...held.map((lock) => lock.path)];
		return {
			name,
			status: "failed",
			exitCode: null,
			signal: null,
			startedAt: null,
			finishedAt: new Date().toISOString(),
			durationMs: 0,
			stdout: EMPTY_OUTPUT,
			stderr: EMPTY_OUTPUT,
			detail: `프로세스 실행 결과를 받지 못해 자원 잠금을 유지했습니다 (${errorCode(error)})`,
			fence: fenceOf("process-unproven", paths),
		};
	}
	if (!result.processEnded) {
		const retained = marker;
		// `close` is the same OS proof the normal path uses. It can arrive after hard teardown; only this attempt's
		// exact tokens are released, and only when that proof arrives.
		void result.ended
			.then(async () => {
				if (retained !== undefined) await releaseTargetMarker(retained);
				await releaseLocks(held);
			})
			.catch(() => undefined);
		const paths = [...(retained === undefined ? [] : [retained.path]), ...held.map((lock) => lock.path)];
		return executedReceipt(name, result, {
			detail: "프로세스 종료를 확인하지 못해 자원 잠금과 대상 표시를 유지했습니다. 상태를 확인하기 전에는 같은 자원으로 시작하지 마세요",
			fence: fenceOf("process-unproven", paths),
		});
	}
	const markerRelease = marker === undefined ? { ok: true as const } : await releaseTargetMarker(marker);
	const released = await releaseLocks(held);
	const paths = [...(markerRelease.ok || marker === undefined ? [] : [marker.path]), ...released.paths];
	return executedReceipt(name, result, {
		detail: joinDetails(markerRelease.ok ? undefined : markerRelease.detail, released.detail),
		...(paths.length === 0 ? {} : { fence: fenceOf("lock-unreleased", paths) }),
	});
}

export { targetJobBlock } from "./job-fence.ts";
