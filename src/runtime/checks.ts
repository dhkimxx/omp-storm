/**
 * Bounded execution of an approved config's `requiredChecks`.
 *
 * A check is one executable and its arguments, spawned directly in the run's target tree: no shell, no interpolation,
 * no generated script. This module is deliberately separate from the controller: it decides only whether the config
 * carries an approved obligation and records what the process actually did. The runtime binds the report's tree
 * fingerprint to the tree it trusts and rejects failed, stale or unrun evidence.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { MAX_JOB_TIMEOUT_MS } from "../config/schema.ts";
import type { ApprovalRecord, ConfigLoad, RequiredCheck } from "../types.ts";
import { DEFAULT_TIMINGS, type StormTimings } from "./timings.ts";

/**
 * Per-check wall clock when the check sets none: the job default. Spelled out rather than imported because the job
 * executor imports this module, so a check cannot depend on its own caller.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;
/** A check may take as long as a configured job, never longer. */
export const MAX_CHECK_TIMEOUT_MS = MAX_JOB_TIMEOUT_MS;
/** Bytes kept from each stream; the rest is counted and dropped rather than carried into a conversation. */
export const DEFAULT_CHECK_OUTPUT_BYTES = 4_096;
export const MAX_CHECK_OUTPUT_BYTES = 65_536;
/**
 * Whether a command's process group can be observed. POSIX only: the leader is started with its own group and
 * `kill(-pgid, 0)` answers ESRCH exactly when no member is left. Where this is false (Windows) the end of the command
 * is the leader's `close`, which says nothing about processes it started; the limit is the same as for a member that
 * left the group (see `PROCESS_GROUP_LIMIT`).
 */
export const PROCESS_GROUPS_OBSERVABLE = process.platform !== "win32";

/**
 * What Storm cannot know about a command it ran, for the user who writes jobs and checks. Stated once so docs, notes
 * and tests agree: Storm proves that its process group is empty, not that nothing the command started is still running.
 */
export const PROCESS_GROUP_LIMIT =
	"Storm은 명령이 시작한 프로세스 그룹이 비었는지만 확인합니다. 명령이 하위 프로세스를 새 세션이나 새 그룹으로 떼어 놓은 경우(setsid, 데몬화)와 프로세스 그룹이 없는 플랫폼(Windows)에서는 그런 프로세스가 남아 있는지 알 수 없습니다.";

/** A command that left group members behind: they were stopped, and the run is not counted as passed. */
export const LEFT_BEHIND_STOPPED_NOTE =
	"명령이 끝난 뒤에도 같은 프로세스 그룹에 하위 프로세스가 남아 있어 종료했습니다. 중간에 멈춘 작업이 있을 수 있어 통과로 보지 않습니다. 명령이 하위 프로세스를 기다린 뒤 끝나도록 하세요";
/** The same, but the members could not be stopped in time: the end is unproven and the fence stays. */
export const LEFT_BEHIND_ALIVE_NOTE =
	"명령이 끝난 뒤에도 같은 프로세스 그룹에 하위 프로세스가 남아 있고 종료하지 못했습니다. 끝났다고 볼 수 없으니 통과로 보지 않습니다";

/** Why checks did not run. Configured checks are never run without an approved config. */
export type CheckSkipReason = "no-config" | "invalid-config" | "unapproved" | "no-checks";

export type CheckStatus = "passed" | "failed" | "timed-out" | "cancelled" | "spawn-error" | "unrun";

/** A bounded tail of one stream, with the real size so a caller can tell a short log from a cut one. */
export interface CheckOutput {
	/** Last at most `outputLimitBytes` of the stream, decoded as UTF-8; possibly starting inside a character. */
	tail: string;
	totalBytes: number;
	truncated: boolean;
}

/** What one configured check did. `argv` is copied from the approved config, not reconstructed from output. */
export interface CheckEvidence {
	name: string;
	argv: readonly string[];
	status: CheckStatus;
	/** Real exit code when the process reported one; null for a signal, spawn error, cancellation or unrun. */
	exitCode: number | null;
	/** The OS signal that ended the process, if any. */
	signal: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number;
	stdout: CheckOutput;
	stderr: CheckOutput;
	/** A short fixed explanation (timeout, cancellation, spawn failure); never raw command output. */
	note?: string;
}

export interface CheckReport {
	status: "passed" | "failed" | "aborted";
	/** The approved config hash these obligations came from. */
	configHash: string;
	/** The tree fingerprint the caller read before the run; evidence after a different tree is not this report's. */
	fingerprint: string;
	/** Every configured check was started; false when cancellation or an unproven end left `unrun` entries. */
	complete: boolean;
	aborted: boolean;
	/**
	 * Present when a check's process group could not be proven empty: its processes may still be running in the tree,
	 * so the later checks did not start and the tree fingerprint is not a reading of a quiet tree. In memory only.
	 */
	endUnproven?: { check: string };
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	/** In configured order, `unrun` entries included, so an absent pass is visible. */
	checks: CheckEvidence[];
}

export type RequiredChecksResult = { status: "skipped"; reason: CheckSkipReason } | CheckReport;

export interface RequiredChecksInput {
	/** The loaded config; `status: "ok"` is required for its checks to run. */
	config: ConfigLoad;
	/** The active approval record. Its `configHash` must equal the loaded config's hash. */
	approval: ApprovalRecord | undefined;
	/** The run's target tree. Checks run here, and only here. */
	cwd: string;
	/** Tree fingerprint read before this call; copied into the report for the runtime's stale check. */
	fingerprint: string;
	/** Cancels the run and terminates its current process group with bounded teardown. */
	signal?: AbortSignal;
	/** Bytes kept from each output stream; clamped to 1..`MAX_CHECK_OUTPUT_BYTES`. */
	outputLimitBytes?: number;
	/**
	 * Called once when a check's end could not be proven, with the promise that resolves if the OS later proves it. A
	 * caller that holds the target (the write lease) must keep it until `ended` resolves: checks have no durable fence
	 * of their own.
	 */
	onEndUnproven?: (info: { check: string; ended: Promise<void> }) => void;
	/** Teardown and group-probe waits; the product's when absent (see `timings.ts`). */
	timings?: StormTimings;
}

export type CheckGate =
	| { status: "skipped"; reason: CheckSkipReason }
	| { status: "ready"; configHash: string; checks: readonly RequiredCheck[] };

/**
 * Whether a config's checks may run at all. A missing or invalid config has none; a valid one needs the approval of
 * exactly its hash. This is intentionally independent of the runner so callers can show or block before spawning.
 */
export function checkGate(config: ConfigLoad, approval: ApprovalRecord | undefined): CheckGate {
	if (config.status === "missing") return { status: "skipped", reason: "no-config" };
	if (config.status === "invalid") return { status: "skipped", reason: "invalid-config" };
	if (approval === undefined || approval.status !== "active" || approval.configHash !== config.hash) {
		return { status: "skipped", reason: "unapproved" };
	}
	const checks = config.config.requiredChecks;
	if (checks === undefined || checks.length === 0) return { status: "skipped", reason: "no-checks" };
	return { status: "ready", configHash: config.hash, checks };
}

/**
 * Targets whose required check ended without proof that its process group is empty, by root, in this process. Checks have
 * no durable fence of their own, so this is what keeps a later run from taking the target before the processes are seen gone.
 */
const unprovenChecks = new Map<string, number>();

/** Records that a check on `root` is not proven ended; the returned function lifts it. `ended` is only for the caller's own wait. */
export function trackUnprovenCheck(root: string, _ended: Promise<void>): () => void {
	unprovenChecks.set(root, (unprovenChecks.get(root) ?? 0) + 1);
	let lifted = false;
	return () => {
		if (lifted) return;
		lifted = true;
		const left = (unprovenChecks.get(root) ?? 1) - 1;
		if (left <= 0) unprovenChecks.delete(root);
		else unprovenChecks.set(root, left);
	};
}

/** What a new run on `root` is told while a required check of an earlier run is not proven ended; undefined when none is. */
export function uncertainCheckBlock(root: string): string | undefined {
	if (!unprovenChecks.has(root)) return undefined;
	return "[storm:check-fence] 이전 실행의 필수 검사 프로세스가 아직 끝났다고 확인되지 않아 이 작업 대상을 쓰는 새 실행을 시작하지 않았습니다. 잠시 뒤 다시 시도하세요. 계속되면 그 검사가 남긴 프로세스를 직접 확인해 종료하세요.";
}

function numberIn(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), 1), max);
}

/** The wall clock one configured check may use: its own limit, or the job default when it sets none. */
export function checkTimeoutMs(check: RequiredCheck): number {
	return numberIn(check.timeoutMs, DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS);
}

function unrun(check: RequiredCheck): CheckEvidence {
	return {
		name: check.name,
		argv: [...check.argv],
		status: "unrun",
		exitCode: null,
		signal: null,
		startedAt: null,
		finishedAt: null,
		durationMs: 0,
		stdout: { tail: "", totalBytes: 0, truncated: false },
		stderr: { tail: "", totalBytes: 0, truncated: false },
	};
}

/** A bounded tail of a byte stream: counts everything, retains only the end. */
class BoundedTail {
	private readonly chunks: Buffer[] = [];
	private kept = 0;
	total = 0;

	constructor(private readonly limit: number) {}

	add(chunk: Buffer): void {
		this.total += chunk.length;
		if (chunk.length >= this.limit) {
			const tail = chunk.subarray(chunk.length - this.limit);
			this.chunks.length = 0;
			this.chunks.push(Buffer.from(tail));
			this.kept = tail.length;
			return;
		}
		this.chunks.push(chunk);
		this.kept += chunk.length;
		while (this.kept > this.limit) {
			const first = this.chunks[0]!;
			const excess = this.kept - this.limit;
			if (first.length <= excess) {
				this.chunks.shift();
				this.kept -= first.length;
			} else {
				this.chunks[0] = first.subarray(excess);
				this.kept -= excess;
			}
		}
	}

	result(): CheckOutput {
		if (this.kept === 0) return { tail: "", totalBytes: this.total, truncated: this.total > 0 };
		return {
			tail: Buffer.concat(this.chunks, this.kept).toString("utf8"),
			totalBytes: this.total,
			truncated: this.total > this.kept,
		};
	}
}

/** The child's own process group on POSIX: children a check starts die with it. */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
		return;
	}
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// No group (spawn failed or the group exited); fall through to the child itself.
	}
	try {
		child.kill(signal);
	} catch {
		// Already gone.
	}
}

/**
 * `empty` only when the OS says no process is left in the group (ESRCH). A group that exists, one that cannot be
 * signalled (EPERM still means a member exists) and any other error are all `occupied`: the end is proven by ESRCH
 * and by nothing else, so an unexpected answer keeps the fence. While any member lives the pgid cannot be reused as
 * a pid, so ESRCH is not a stale answer about another process.
 */
function groupState(pid: number): "empty" | "occupied" {
	try {
		process.kill(-pid, 0);
		return "occupied";
	} catch (error) {
		return (error as NodeJS.ErrnoException | null | undefined)?.code === "ESRCH" ? "empty" : "occupied";
	}
}

function spawnErrorNote(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	return typeof code === "string" && code.length <= 40 ? `실행하지 못했습니다 (${code})` : "실행하지 못했습니다";
}

/**
 * Stops reading without destroying the pipe: `destroy()` makes Node emit `close` immediately, which would turn our own
 * teardown into false proof that the child ended. `pause()` + `unref()` let this process exit while a later, genuine
 * `close` still reports the end when the last process holding the pipe goes away.
 */
function releasePipes(child: ChildProcess): void {
	for (const stream of [child.stdout, child.stderr]) {
		if (stream === null) continue;
		const pipe = stream as typeof stream & { pause?: () => void; unref?: () => void };
		try {
			pipe.pause?.();
			pipe.unref?.();
		} catch {
			// Leaving the pipe paused but referenced is safer than destroying it and faking a close.
		}
	}
}

export interface BoundedProcessInput {
	/** Executable first, then its arguments; never a shell command line. */
	argv: readonly string[];
	cwd: string;
	timeoutMs: number;
	outputLimitBytes: number;
	signal?: AbortSignal;
	/** Teardown and group-probe waits; the product's when absent (see `timings.ts`). */
	timings?: StormTimings;
}

export interface BoundedProcessResult {
	status: Exclude<CheckStatus, "unrun">;
	exitCode: number | null;
	signal: string | null;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	stdout: CheckOutput;
	stderr: CheckOutput;
	/** True only when the OS reported the child closed (or it never started); false means teardown gave up. */
	processEnded: boolean;
	/**
	 * Resolves when the OS reports the child's stdio closed, even after `processEnded: false` settled the result.
	 * A caller holding a fence waits for this before releasing; it never resolves if the OS never reports the end.
	 */
	ended: Promise<void>;
	note?: string;
}

/**
 * Spawns one command and waits for it. A timeout or abort sends SIGTERM to its process group, then SIGKILL, and settles
 * the result even if teardown does not finish, so a caller can never hang forever. Stdout/stderr are retained only as
 * bounded tails. `processEnded` tells a caller whether releasing a resource fence is provable; when teardown gave up,
 * `ended` resolves only if the OS later proves the end, so a caller can release exact tokens then.
 *
 * "Ended" means the leader exited, its pipes closed AND its process group is empty (POSIX; see
 * `PROCESS_GROUPS_OBSERVABLE`). A command that exits while members of its group still run (a helper whose output was
 * redirected keeps neither pipe) gets those members stopped (SIGTERM, then SIGKILL) before the end is reported, on
 * every way a run finishes: normal exit, non-zero exit, timeout and abort. A clean exit that needed this is `failed`
 * with the leader's exit code kept and a note, because the helpers were cut off mid-work. A member that left the group
 * is not seen (`PROCESS_GROUP_LIMIT`).
 */
export function runBoundedProcess(input: BoundedProcessInput): Promise<BoundedProcessResult> {
	const { argv, cwd, timeoutMs, outputLimitBytes, signal } = input;
	const timings = input.timings ?? DEFAULT_TIMINGS;
	const stdout = new BoundedTail(outputLimitBytes);
	const stderr = new BoundedTail(outputLimitBytes);
	const startedAt = new Date().toISOString();
	const began = performance.now();
	const { promise, resolve } = Promise.withResolvers<BoundedProcessResult>();
	const ended = Promise.withResolvers<void>();
	const executable = argv[0];
	if (executable === undefined) {
		ended.resolve();
		resolve({
			status: "spawn-error",
			exitCode: null,
			signal: null,
			startedAt,
			finishedAt: new Date().toISOString(),
			durationMs: Math.round(performance.now() - began),
			stdout: stdout.result(),
			stderr: stderr.result(),
			processEnded: true,
			ended: ended.promise,
			note: "실행 파일이 없습니다",
		});
		return promise;
	}
	let child: ChildProcess;
	try {
		child = spawn(executable, argv.slice(1), {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
	} catch (error) {
		ended.resolve();
		resolve({
			status: "spawn-error",
			exitCode: null,
			signal: null,
			startedAt,
			finishedAt: new Date().toISOString(),
			durationMs: Math.round(performance.now() - began),
			stdout: stdout.result(),
			stderr: stderr.result(),
			processEnded: true,
			ended: ended.promise,
			note: spawnErrorNote(error),
		});
		return promise;
	}

	let settled = false;
	let timedOut = false;
	let cancelled = false;
	let spawnError: string | undefined;
	/** The leader closed and its group still had members that nobody asked to stop (no timeout, no abort). */
	let leftBehind = false;
	/** What the leader reported at `close`; teardown that gives up later still reports the leader's own outcome. */
	let leader: { code: number | null; endedBy: string | null } | undefined;
	let deadline: NodeJS.Timeout | undefined;
	let killGrace: NodeJS.Timeout | undefined;
	let hardTeardown: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const finish = (code: number | null, endedBy: string | null, processEnded: boolean): void => {
		if (settled) return;
		settled = true;
		clearTimeout(deadline);
		clearTimeout(killGrace);
		clearTimeout(hardTeardown);
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
		// A leader that exited cleanly while its helpers were still running did not finish what it started: they were
		// stopped (or could not be), so its exit code no longer vouches for the tree. The code is kept as observed.
		const unfinished = leftBehind && !timedOut && !cancelled && spawnError === undefined;
		const status: Exclude<CheckStatus, "unrun"> = timedOut
			? "timed-out"
			: cancelled
				? "cancelled"
				: spawnError !== undefined
					? "spawn-error"
					: code === 0 && !unfinished
						? "passed"
						: "failed";
		const note = spawnError ??
			(timedOut ? `시간 한도 ${timeoutMs}ms를 넘었습니다` : cancelled ? "취소되었습니다" : undefined) ??
			(unfinished ? (processEnded ? LEFT_BEHIND_STOPPED_NOTE : LEFT_BEHIND_ALIVE_NOTE) : undefined);
		resolve({
			status,
			exitCode: code,
			signal: endedBy,
			startedAt,
			finishedAt: new Date().toISOString(),
			durationMs: Math.round(performance.now() - began),
			stdout: stdout.result(),
			stderr: stderr.result(),
			processEnded,
			ended: ended.promise,
			...(note === undefined ? {} : { note }),
		});
	};
	/** Stops the group: SIGTERM now, SIGKILL after the grace, and a result without proof after the hard limit. */
	const beginTeardown = (): void => {
		if (settled || killGrace !== undefined) return;
		signalChild(child, "SIGTERM");
		killGrace = setTimeout(() => {
			if (!settled) signalChild(child, "SIGKILL");
		}, timings.killGraceMs);
		hardTeardown = setTimeout(() => {
			if (settled) return;
			// A process that cannot be reaped must not keep this promise or this process alive. Its end is unproven, but
			// the `close` listener and the group probe stay: `ended` resolves only when the OS later proves the end.
			releasePipes(child);
			child.unref();
			finish(leader?.code ?? null, leader?.endedBy ?? null, false);
		}, timings.killGraceMs + timings.hardTeardownMs);
	};
	const terminate = (timeout: boolean): void => {
		if (settled) return;
		if (timeout) timedOut = true;
		else cancelled = true;
		// A second abort/timeout keeps the first teardown schedule; only its classification is updated.
		beginTeardown();
	};

	child.on("error", (error) => {
		spawnError = spawnErrorNote(error);
		// A spawn that never got a pid never created a process; an error after a pid exists does not prove it ended.
		if (child.pid === undefined) ended.resolve();
		finish(null, null, child.pid === undefined);
	});
	child.on("close", (code, endedBy) => {
		// A spawn that never got a pid is a spawn failure even if only `close` reports it.
		if (spawnError === undefined && child.pid === undefined) spawnError = "실행하지 못했습니다";
		leader = { code, endedBy };
		const pid = child.pid;
		if (pid === undefined || !PROCESS_GROUPS_OBSERVABLE) {
			// Nothing was started, or there is no group to ask about (see `PROCESS_GROUPS_OBSERVABLE`).
			ended.resolve();
			finish(code, endedBy, true);
			return;
		}
		// `close` says the leader exited and its pipes are shut. It does not say the group is empty: a member that
		// redirected its output is still running and may still write. The end is proven only by an empty group, and
		// `ended` (what a retained fence waits for, even after the result gave up) resolves only then.
		const closedAt = performance.now();
		const probe = (): void => {
			if (groupState(pid) === "empty") {
				ended.resolve();
				finish(code, endedBy, true);
				return;
			}
			// Members were left behind. If nobody asked to stop the command, stop them now; a timeout or an abort already
			// runs its own teardown, which this probe only observes.
			if (!settled && killGrace === undefined && performance.now() - closedAt >= timings.groupSettleMs) {
				leftBehind = true;
				beginTeardown();
			}
			const next = setTimeout(probe, settled ? timings.groupLateProbeMs : timings.groupProbeMs);
			// A result that already gave up must not keep this process alive while it waits for a proof that may never come.
			if (settled) next.unref();
		};
		probe();
	});
	child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));

	const abortListener = (): void => terminate(false);
	onAbort = abortListener;
	if (signal !== undefined) {
		if (signal.aborted) terminate(false);
		else signal.addEventListener("abort", abortListener, { once: true });
	}
	deadline = setTimeout(() => terminate(true), timeoutMs);
	return promise;
}

/**
 * Runs every configured check in order, or explains why none ran. Each check uses its own time limit, or the job
 * default when it sets none. Failures and timeouts do not stop later checks: the complete set of evidence is what the
 * runtime decides on. Cancellation marks the current check `cancelled` and every later one `unrun`, and makes the
 * report `aborted`.
 */
export async function runRequiredChecks(input: RequiredChecksInput): Promise<RequiredChecksResult> {
	const gate = checkGate(input.config, input.approval);
	if (gate.status === "skipped") return gate;
	const outputLimitBytes = numberIn(input.outputLimitBytes, DEFAULT_CHECK_OUTPUT_BYTES, MAX_CHECK_OUTPUT_BYTES);
	const startedAt = new Date().toISOString();
	const began = performance.now();
	const evidence: CheckEvidence[] = [];
	let aborted = false;
	let endUnproven: { check: string } | undefined;

	for (const [index, check] of gate.checks.entries()) {
		if (input.signal?.aborted === true) {
			aborted = true;
			for (const rest of gate.checks.slice(index)) evidence.push(unrun(rest));
			break;
		}
		const result = await runBoundedProcess({
			argv: check.argv,
			cwd: input.cwd,
			timeoutMs: checkTimeoutMs(check),
			outputLimitBytes,
			...(input.signal === undefined ? {} : { signal: input.signal }),
			...(input.timings === undefined ? {} : { timings: input.timings }),
		});
		evidence.push({
			name: check.name,
			argv: [...check.argv],
			status: result.status,
			exitCode: result.exitCode,
			signal: result.signal,
			startedAt: result.startedAt,
			finishedAt: result.finishedAt,
			durationMs: result.durationMs,
			stdout: result.stdout,
			stderr: result.stderr,
			...(result.note === undefined ? {} : { note: result.note }),
		});
		// Every later check runs in the same tree, so it must not start while this one's processes may still be there.
		if (!result.processEnded) {
			endUnproven = { check: check.name };
			input.onEndUnproven?.({ check: check.name, ended: result.ended });
		}
		// A cancellation that landed while this check ran leaves the rest unstarted.
		if (result.status === "cancelled") {
			aborted = true;
			for (const rest of gate.checks.slice(index + 1)) evidence.push(unrun(rest));
			break;
		}
		if (endUnproven !== undefined) {
			for (const rest of gate.checks.slice(index + 1)) evidence.push(unrun(rest));
			break;
		}
	}

	const complete = evidence.every((check) => check.status !== "unrun");
	const status = aborted ? "aborted" : evidence.every((check) => check.status === "passed") ? "passed" : "failed";
	return {
		status,
		configHash: gate.configHash,
		fingerprint: input.fingerprint,
		complete,
		aborted,
		startedAt,
		finishedAt: new Date().toISOString(),
		durationMs: Math.round(performance.now() - began),
		checks: evidence,
		...(endUnproven === undefined ? {} : { endUnproven }),
	};
}
