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
/** SIGTERM is followed by SIGKILL on this schedule; the result settles even if the child cannot be reaped. */
const KILL_GRACE_MS = 1_000;
const HARD_TEARDOWN_MS = 3_000;

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
	/** Every configured check was started; false when cancellation left `unrun` entries. */
	complete: boolean;
	aborted: boolean;
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
 * `ended` resolves only if the OS later reports the child's actual close, so a caller can release exact tokens then.
 */
export function runBoundedProcess(input: BoundedProcessInput): Promise<BoundedProcessResult> {
	const { argv, cwd, timeoutMs, outputLimitBytes, signal } = input;
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
		const status: Exclude<CheckStatus, "unrun"> = timedOut
			? "timed-out"
			: cancelled
				? "cancelled"
				: spawnError !== undefined
					? "spawn-error"
					: code === 0
						? "passed"
						: "failed";
		const note = spawnError ?? (timedOut ? `시간 한도 ${timeoutMs}ms를 넘었습니다` : cancelled ? "취소되었습니다" : undefined);
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
	const terminate = (timeout: boolean): void => {
		if (settled) return;
		if (timeout) timedOut = true;
		else cancelled = true;
		// A second abort/timeout keeps the first teardown schedule; only its classification is updated.
		if (killGrace !== undefined) return;
		signalChild(child, "SIGTERM");
		killGrace = setTimeout(() => {
			if (!settled) signalChild(child, "SIGKILL");
		}, KILL_GRACE_MS);
		hardTeardown = setTimeout(() => {
			if (settled) return;
			// A process that cannot be reaped must not keep this promise or this process alive. Its end is unproven, but
			// the `close` listener stays: `ended` resolves only when the OS later reports the actual end.
			releasePipes(child);
			child.unref();
			finish(null, null, false);
		}, KILL_GRACE_MS + HARD_TEARDOWN_MS);
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
		// This is the OS proof a retained fence waits for, including when it arrives after hard teardown.
		ended.resolve();
		finish(code, endedBy, true);
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
		// A cancellation that landed while this check ran leaves the rest unstarted.
		if (result.status === "cancelled") {
			aborted = true;
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
	};
}
