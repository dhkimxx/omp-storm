/**
 * Bounded, host-authored evidence for one native task attempt.
 *
 * The extension is the only adapter: it sees `tool_result` (`task` synchronous results; `wait` terminal job rows),
 * `message_end` (`customType:"async-result"`, background jobs) and the parent-side `AgentRegistry` mirror. This
 * module turns one of those envelopes into a small report a run can bind to `runId` + parent + admitted `spawnKey`;
 * it never reads model text, markdown, `agent://` output or a path copied from either.
 *
 * Artifacts need a parent-made capture (existence, size, digest) at or after admission, and the capture path must
 * equal the exact path the host declared for that kind. Async jobs carry no artifact path, so an async patch is
 * accepted only from a registry fact that names the same parent and session home, carries the same history path,
 * and proves the history is this attempt's: either attempt-versioned host metadata (`RegistryCapture.jobId`) or a
 * digest transition from the parent's admission baseline. A fresh event repeating the prior patch is not new proof.
 *
 * No module state, no I/O, no timers, no model calls. The integration owner calls these functions from the three
 * existing hooks; `local://attempt-report-integration.md` lists the exact data to capture.
 */
import { isAbsolute } from "node:path";

/** Wire tag of the stored/returned report; bump only when an existing field changes meaning. */
export const ATTEMPT_REPORT_SCHEMA = "storm.attempt-report/v1";
export const UNKNOWN_HOST_VERSION = "unknown";

/** A native id is at most this many characters (`nativeId`). */
const NATIVE_ID_MAX_CHARS = 120;
/** The longest `.t<start>` stamp: a safe integer has at most 16 digits. */
const STAMP_MAX_CHARS = ".t".length + String(Number.MAX_SAFE_INTEGER).length;
/**
 * The longest attempt id Storm keeps: the widest id `asyncAttemptId` can build, `job:<job>.t<start>:<agent>` with two
 * host ids of the longest length `nativeId` allows and the longest start stamp. A real run's ids are already 67
 * characters (`job:` + `run-20261126-051651-7850-lane-3` twice), so a limit near 64 silently dropped them. Every place
 * that validates an attempt reference uses this one, and `asyncAttemptId` never builds an id past it, so a stamped id
 * can never be refused where its plain id fits (the replay guard would then take a real new turn for a replay).
 */
export const ATTEMPT_ID_MAX_CHARS = "job:".length + NATIVE_ID_MAX_CHARS + STAMP_MAX_CHARS + ":".length + NATIVE_ID_MAX_CHARS;
/** A host attempt reference is a bounded token, never a path or model text; an unsafe one is omitted. */
export const ATTEMPT_REF = new RegExp(`^[A-Za-z0-9:._-]{1,${ATTEMPT_ID_MAX_CHARS}}$`, "u");

export const ATTEMPT_TEXT_MAX = 320;
export const ATTEMPT_ARTIFACT_MAX = 8;
export const ATTEMPT_OBSERVATION_MAX = 12;

/** Native result surfaces the parent runtime can observe without polling. */
export type AttemptChannel = "task-result" | "async-result" | "wait-result" | "registry";

/**
 * Why a report is not `observed`. Stable machine codes: the report layer owns wording.
 *
 * - `native-result-missing` / `native-delivery-missing`: no native envelope or no item for this spawn.
 * - `spawn-mismatch`: a native item names another child than the admitted spawn key.
 * - `parent-mismatch` / `registry-identity-missing`: the registry fact cannot bind parent and session home.
 * - `registry-mismatch`: the registry fact names another child.
 * - `job-not-settled`: a delivered job is not terminally settled (running/unknown).
 * - `exit-code-missing`: the host omitted the sync exit status this report needs.
 * - `artifact-capture-stale`: the capture predates this attempt.
 * - `artifact-path-mismatch`: the capture path differs from the host-declared path for its kind.
 * - `patch-artifact-missing` / `patch-artifact-empty`: no patch was captured, or not positive bytes.
 * - `patch-artifact-unchanged` / `patch-artifact-unproven`: the registry patch cannot be shown to be new for this attempt.
 * - `attempt-replayed`: the derived native attempt id was already bound to this spawn.
 * - `attempt-not-current`: this first delivery is not the exact native attempt the caller is waiting for.
 * - `attempt-clock`: the result claims to have happened before admission.
 * - `identity-invalid`: a required trusted identity field was malformed.
 */
export type AttemptCaptureError =
	| "native-result-missing"
	| "native-delivery-missing"
	| "spawn-mismatch"
	| "parent-mismatch"
	| "registry-identity-missing"
	| "registry-mismatch"
	| "job-not-settled"
	| "exit-code-missing"
	| "artifact-capture-stale"
	| "artifact-path-mismatch"
	| "patch-artifact-missing"
	| "patch-artifact-empty"
	| "patch-artifact-unchanged"
	| "patch-artifact-unproven"
	| "attempt-replayed"
	| "attempt-not-current"
	| "attempt-clock"
	| "identity-invalid";

/** Host settlement authority, not the obligation verdict: `accepted`/`reviewable` are decided elsewhere. */
export type AttemptOutcome = "success" | "cancel" | "failure";

/** `observed` is the only usable state; the others must keep the bound requirement pending/unmet. */
export type AttemptCaptureState = "observed" | "missing" | "invalid" | "stale";

export type AttemptSchemaStatus = "valid" | "invalid" | "unavailable";

/**
 * Trusted identity of one attempt: the active Storm run, the parent agent that owns the task call/job, and the child
 * id the host admitted (`before_subagent_spawn.spawnKey`, also the task item name and `result.id`/`agentId`).
 * `runId`/`parentId` never come from model text; the caller passes them from the captured run and extension context.
 */
export interface AttemptSubject {
	runId: string;
	parentId: string;
	spawnKey: string;
	/** Epoch ms when this attempt was admitted / the follow-up was dispatched. Captures older are stale. */
	startedAt: number;
	/** Exact native attempt the caller is waiting for; any other first delivery is stale. */
	expectedAttemptId?: string;
	/** Native attempt ids already bound to this spawn; a repeat delivery must not become a new success. */
	priorAttemptIds?: readonly string[];
}

/** One parent-made capture of a host-named artifact path. A bare path is not an artifact and is never accepted. */
export interface HostArtifactCapture {
	/** Native id the host named the path for: sync `result.id`, registry `ref.id`. */
	id: string;
	kind: "output" | "patch";
	/** Absolute host-declared path. */
	path: string;
	/** Whether the parent could stat/read it at `capturedAt`; false is a missing artifact, not evidence. */
	exists: boolean;
	/** Size observed by the parent. A patch needs positive bytes. */
	bytes?: number;
	/** Parent-computed digest of the captured bytes; a patch needs one to be bound to an attempt. */
	digest?: string;
	/** Epoch ms of the parent capture, compared with {@link AttemptSubject.startedAt}. */
	capturedAt: number;
}

/** The fields of OMP `SingleResult` this adapter reads; every field is defensive because it is wire data. */
export interface SyncResultFact {
	id?: unknown;
	exitCode?: unknown;
	error?: unknown;
	aborted?: unknown;
	outputPath?: unknown;
	patchPath?: unknown;
	structuredOutput?: {
		status?: unknown;
		error?: unknown;
	} | undefined;
	/** Native terminal auto-retry failure, if this exact result reported one. Its message is never diagnosis. */
	retryFailure?: {
		attempt?: unknown;
		errorMessage?: unknown;
	} | undefined;
}

/** One synchronous `task` tool_result envelope; a batch holds one item per child. */
export interface SyncTaskCapture {
	channel: "task-result";
	/** Host tool-call id of the `task` call; part of the attempt id. */
	toolCallId: string;
	observedAt: number;
	results: readonly SyncResultFact[];
	/** Parent captures of this result's declared `outputPath`/`patchPath`; a patch needs bytes + digest. */
	artifacts?: readonly HostArtifactCapture[];
	hostVersion?: string;
}

/** The fields of one `async-result` job this adapter reads. */
export interface AsyncJobFact {
	jobId?: unknown;
	agentId?: unknown;
	status?: unknown;
	/** When the host started this job (epoch ms), when it said so; tells two turns that share a reused job id apart. */
	startTime?: unknown;
	schema?: {
		status?: unknown;
		error?: unknown;
	} | undefined;
}

/**
 * One delivered `message_end` with `customType:"async-result"`, or one terminal task row of a native `wait` result,
 * for exactly one job. `wait-result` is a direct delivery by the wait call (the row carries the result text); a later
 * aggregate row whose result was already consumed is not a delivery and must not be passed here.
 */
export interface AsyncResultCapture {
	channel: "async-result" | "wait-result";
	observedAt: number;
	/** The one job being reported. The caller iterates a batch; this adapter never chooses a job itself. */
	job: AsyncJobFact;
	hostVersion?: string;
}

/** One parent-observed `AgentRegistry.global().onChange` fact, narrowed to what attempt binding needs. */
export interface RegistryCapture {
	channel: "registry";
	observedAt: number;
	event: "registered" | "status_changed" | "metadata_changed" | "removed";
	id: string;
	/** Owning parent the registry reports (`ref.parentId`); required for an artifact. */
	parentId?: string;
	/** Host session home/instance (`ref.session.instanceKey` prefix, e.g. "main" or "w1"); required for an artifact. */
	home?: string;
	/** Attempt-versioned host metadata when the host provides it; must match this job's id. */
	jobId?: string;
	history?: {
		outputPath?: unknown;
		patchPath?: unknown;
	};
	/** Parent captures of the exact `history` paths. */
	artifacts?: readonly HostArtifactCapture[];
	hostVersion?: string;
}

export interface SyncReportOptions {
	/** The lane needs a durable isolated patch (independent experiment). */
	requirePatch?: boolean;
}

export interface AsyncReportOptions {
	/** Parent capture of the later registry event naming this child's output/patch. */
	registry?: RegistryCapture;
	/**
	 * The child's patch state at admission: a capture, `null` when it had no patch, or omitted when the caller did
	 * not record one. An unchanged same-path/same-digest patch is not new authority; omitted cannot prove a first
	 * patch either, unless the registry fact carries attempt-versioned `jobId`.
	 */
	admissionPatch?: HostArtifactCapture | null;
	requirePatch?: boolean;
	/**
	 * Native `retryFailure.attempt` observed for this exact async job from bound progress. Applied only when the
	 * delivered job itself settles as a failure; a success after a retry stays a success.
	 */
	retryAttempt?: unknown;
}

export interface MissingReportInput {
	channel: "task-result" | "async-result" | "wait-result";
	observedAt: number;
	hostVersion?: string;
	reason?: AttemptCaptureError;
}

/** One structured fact with the native channel, ref and host version that authored it. */
export interface AttemptObservation {
	facet: "outcome" | "error" | "schema" | "artifact" | "capture";
	value: string | number | boolean | null;
	source: {
		channel: AttemptChannel;
		ref: string;
		version: string;
	};
}

/** A host-named artifact the parent actually captured for this attempt. */
export interface ReportedArtifact {
	kind: "output" | "patch";
	path: string;
	bytes?: number;
	digest?: string;
	capturedAt: number;
	source: "task-result" | "registry";
}

export interface AttemptReport {
	schema: typeof ATTEMPT_REPORT_SCHEMA;
	runId: string;
	parentId: string;
	spawnKey: string;
	/** Host-derived `task:<toolCallId>:<resultId>` or `job:<jobId>:<agentId>`. Absent when nothing native was captured. */
	attemptId?: string;
	outcome: AttemptOutcome;
	capture: AttemptCaptureState;
	/** Compact machine code when `capture !== "observed"`. */
	captureError?: AttemptCaptureError;
	/** Host error/validation text, bounded and control-stripped. Never a path or a success claim. */
	error?: string;
	schemaError?: string;
	exitCode?: number;
	schemaStatus?: AttemptSchemaStatus;
	/**
	 * The host's terminal auto-retry/fallback exhaustion, when its native `retryFailure` reported one. This is a fact,
	 * not a Storm instruction: the run must not start another retry outside its configured limits.
	 */
	retry?: { attempt: number };
	observedAt: number;
	/** Host runtime version at observation time (`unknown` when the adapter was not told). */
	version: string;
	artifacts: ReportedArtifact[];
	observations: AttemptObservation[];
}

/** The only admissibility check the integration should use before binding a result. */
export function attemptUsable(report: AttemptReport): boolean {
	return report.capture === "observed" && report.attemptId !== undefined;
}

/** Strict native id: 1-120 ASCII letters/digits/`.`/`_`/`-`. Anything else is rejected, never rewritten. */
function nativeId(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= NATIVE_ID_MAX_CHARS && /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
}

/** Host-derived id for a synchronous child result; undefined when either component is malformed. */
export function syncAttemptId(toolCallId: string, resultId: string): string | undefined {
	const task = nativeId(toolCallId);
	const result = nativeId(resultId);
	return task === undefined || result === undefined ? undefined : `task:${task}:${result}`;
}

/**
 * Host-derived id for a delivered background job; undefined when a component is malformed or the id would not fit
 * `ATTEMPT_ID_MAX_CHARS`. `startTime` stamps a job whose id omp reused: it hands a follow-up turn the agent id again
 * once the earlier job's row was evicted, so one job id can name two turns and only the start tells them apart.
 */
export function asyncAttemptId(jobId: string, agentId: string, startTime?: number): string | undefined {
	const job = nativeId(jobId);
	const agent = nativeId(agentId);
	if (job === undefined || agent === undefined) return undefined;
	if (startTime !== undefined && !(Number.isSafeInteger(startTime) && startTime >= 0)) return undefined;
	const id = `job:${job}${startTime === undefined ? "" : `.t${startTime}`}:${agent}`;
	return id.length > ATTEMPT_ID_MAX_CHARS ? undefined : id;
}

/**
 * The attempt id of one delivered job for this subject. A job whose plain id this spawn already settled is either a
 * replay of that job or a new turn that omp registered under the reused id. It is the new turn only when the job's
 * start time proves it began after this dispatch was admitted, or is the very start of the job the dispatch was bound
 * to; its id then carries the start. Without that proof the plain id is returned and the replay guard refuses it, so a
 * stale delivery can never overwrite a newer result. `startTime` is a host fact (a job row's `startTime`, or a wait
 * row's `settledAtMs - durationMs`), never model text.
 */
export function deliveredAttemptId(subject: AttemptSubject, jobId: unknown, agentId: unknown, startTime: unknown): string | undefined {
	if (typeof jobId !== "string" || typeof agentId !== "string") return undefined;
	const plain = asyncAttemptId(jobId, agentId);
	if (plain === undefined) return undefined;
	const prior = Array.isArray(subject.priorAttemptIds) ? subject.priorAttemptIds : [];
	if (!prior.includes(plain)) return plain;
	const start = finite(startTime);
	if (start === undefined || !Number.isSafeInteger(start) || start < 0) return plain;
	const stamped = asyncAttemptId(jobId, agentId, start);
	if (stamped === undefined) return plain;
	// The same wall-clock comparison as `#unboundDelivery` in the collector: exact, equal counts as later, and a clock
	// that stepped backwards after the admission can only make a real new turn read as the earlier one (fail closed).
	return start >= subject.startedAt || stamped === subject.expectedAttemptId ? stamped : plain;
}

/** A report for the case where no native envelope/result arrived. It never claims an attempt id or a success. */
export function missingAttemptReport(subject: AttemptSubject, input: MissingReportInput): AttemptReport {
	assertSubject(subject);
	const version = boundedVersion(input.hostVersion);
	const error =
		nativeId(subject.spawnKey) === undefined
			? "identity-invalid"
			: input.reason ?? (input.channel === "task-result" ? "native-result-missing" : "native-delivery-missing");
	const report: AttemptReport = {
		schema: ATTEMPT_REPORT_SCHEMA,
		runId: subject.runId,
		parentId: subject.parentId,
		spawnKey: subject.spawnKey,
		outcome: "failure",
		capture: error === "identity-invalid" ? "invalid" : "missing",
		captureError: error,
		observedAt: finite(input.observedAt) ?? subject.startedAt,
		version,
		artifacts: [],
		observations: [],
	};
	observe(report, {
		facet: "capture",
		value: error,
		source: { channel: input.channel, ref: `missing:${subject.spawnKey}`, version },
	});
	return report;
}

/** Build a report from the synchronous `task` result for `subject.spawnKey`. */
export function syncAttemptReport(subject: AttemptSubject, capture: SyncTaskCapture, options: SyncReportOptions = {}): AttemptReport {
	assertSubject(subject);
	const version = boundedVersion(capture.hostVersion);
	const observedAt = finite(capture.observedAt) ?? subject.startedAt;
	const toolCallId = nativeId(capture.toolCallId);
	if (capture.channel !== "task-result" || toolCallId === undefined || nativeId(subject.spawnKey) === undefined) {
		return invalid(subject, "task-result", observedAt, version, "identity-invalid");
	}
	if (observedAt < subject.startedAt) return invalid(subject, "task-result", observedAt, version, "attempt-clock");

	const results = Array.isArray(capture.results) ? capture.results : [];
	const result = results.find(candidate => nativeId(candidate.id) === subject.spawnKey);
	if (result === undefined) return missingNative(subject, "task-result", observedAt, version, "native-result-missing");
	const resultId = nativeId(result.id) as string;
	const attemptId = syncAttemptId(toolCallId, resultId);
	if (attemptId === undefined) return invalid(subject, "task-result", observedAt, version, "identity-invalid");

	const report = base(subject, attemptId, observedAt, version);
	const notCurrent = attemptedEarlier(subject, attemptId);
	if (notCurrent !== undefined) return unusable(report, "task-result", "stale", notCurrent);

	const aborted = result.aborted === true;
	const exitCode = typeof result.exitCode === "number" && Number.isInteger(result.exitCode) ? result.exitCode : undefined;
	const error = boundedText(result.error);
	if (!aborted && exitCode === undefined) return unusable(report, "task-result", "invalid", "exit-code-missing");
	const schema = schemaFact(result.structuredOutput);
	const retry = retryFact(result.retryFailure?.attempt);
	report.outcome = aborted ? "cancel" : exitCode !== 0 || error !== undefined || schema?.status === "invalid" || retry !== undefined ? "failure" : "success";
	observe(report, { facet: "outcome", value: report.outcome, source: sourceOf("task-result", attemptId, version) });
	if (retry !== undefined && report.outcome === "failure") report.retry = retry;
	if (exitCode !== undefined) report.exitCode = exitCode;
	if (error !== undefined) {
		report.error = error;
		observe(report, { facet: "error", value: error, source: sourceOf("task-result", attemptId, version) });
	}
	applySchema(report, schema, "task-result", attemptId, version);

	const patchFailure = acceptSyncArtifacts(report, subject, result, resultId, capture.artifacts, version);
	if (options.requirePatch === true && !report.artifacts.some(artifact => artifact.kind === "patch")) {
		return failCapture(report, "task-result", patchFailure ?? "patch-artifact-missing");
	}
	return report;
}

/** Build a report from exactly one delivered `async-result` job, plus the later registry capture when supplied. */
export function asyncAttemptReport(subject: AttemptSubject, capture: AsyncResultCapture, options: AsyncReportOptions = {}): AttemptReport {
	assertSubject(subject);
	const version = boundedVersion(capture.hostVersion);
	const observedAt = finite(capture.observedAt) ?? subject.startedAt;
	const channel = capture.channel === "wait-result" ? "wait-result" : "async-result";
	if (capture.channel !== "async-result" && capture.channel !== "wait-result") {
		return invalid(subject, "async-result", observedAt, version, "identity-invalid");
	}
	if (observedAt < subject.startedAt) return invalid(subject, channel, observedAt, version, "attempt-clock");

	const jobId = nativeId(capture.job.jobId);
	const agentId = nativeId(capture.job.agentId);
	if (jobId === undefined || agentId === undefined || nativeId(subject.spawnKey) === undefined) {
		return invalid(subject, channel, observedAt, version, "identity-invalid");
	}
	if (agentId !== subject.spawnKey) return invalid(subject, channel, observedAt, version, "spawn-mismatch");
	const attemptId = deliveredAttemptId(subject, jobId, agentId, capture.job.startTime);
	if (attemptId === undefined) return invalid(subject, channel, observedAt, version, "identity-invalid");

	const report = base(subject, attemptId, observedAt, version);
	const notCurrent = attemptedEarlier(subject, attemptId);
	if (notCurrent !== undefined) return unusable(report, channel, "stale", notCurrent);

	const status = text(capture.job.status);
	const schema = schemaFact(capture.job.schema);
	if (status === "cancelled") report.outcome = "cancel";
	else if (status === "completed") report.outcome = schema?.status === "invalid" ? "failure" : "success";
	else if (status === "failed") report.outcome = "failure";
	else return unusable(report, channel, "invalid", "job-not-settled");
	observe(report, { facet: "outcome", value: report.outcome, source: sourceOf(channel, attemptId, version) });
	applySchema(report, schema, channel, attemptId, version);
	const retry = retryFact(options.retryAttempt);
	if (retry !== undefined && report.outcome === "failure") report.retry = retry;

	const patchFailure = acceptRegistry(report, subject, capture, options, jobId);
	if (options.requirePatch === true && !report.artifacts.some(artifact => artifact.kind === "patch")) {
		return failCapture(report, "registry", patchFailure ?? "patch-artifact-missing");
	}
	return report;
}

// ── internals ────────────────────────────────────────────────────────────────────────────────────────────────────

interface SchemaFact {
	status?: AttemptSchemaStatus;
	error?: string;
}

function base(subject: AttemptSubject, attemptId: string, observedAt: number, version: string): AttemptReport {
	return {
		schema: ATTEMPT_REPORT_SCHEMA,
		runId: subject.runId,
		parentId: subject.parentId,
		spawnKey: subject.spawnKey,
		attemptId,
		outcome: "failure",
		capture: "observed",
		observedAt,
		version,
		artifacts: [],
		observations: [],
	};
}

function invalid(
	subject: AttemptSubject,
	channel: "task-result" | "async-result" | "wait-result",
	observedAt: number,
	version: string,
	error: AttemptCaptureError,
): AttemptReport {
	const report: AttemptReport = {
		schema: ATTEMPT_REPORT_SCHEMA,
		runId: subject.runId,
		parentId: subject.parentId,
		spawnKey: subject.spawnKey,
		outcome: "failure",
		capture: "invalid",
		captureError: error,
		observedAt,
		version,
		artifacts: [],
		observations: [],
	};
	observe(report, { facet: "capture", value: error, source: sourceOf(channel, `capture:${subject.spawnKey}`, version) });
	return report;
}

/** The native envelope arrived but held no item for this admitted spawn. */
function missingNative(
	subject: AttemptSubject,
	channel: "task-result" | "async-result" | "wait-result",
	observedAt: number,
	version: string,
	error: AttemptCaptureError,
): AttemptReport {
	const report = invalid(subject, channel, observedAt, version, error);
	report.capture = "missing";
	return report;
}

function unusable(report: AttemptReport, channel: AttemptChannel, state: AttemptCaptureState, error: AttemptCaptureError): AttemptReport {
	report.capture = state;
	report.captureError = error;
	observe(report, { facet: "capture", value: error, source: sourceOf(channel, report.attemptId ?? report.spawnKey, report.version) });
	return report;
}

function failCapture(report: AttemptReport, channel: AttemptChannel, error: AttemptCaptureError): AttemptReport {
	const state = error === "artifact-capture-stale" ? "stale" : error === "patch-artifact-empty" ? "invalid" : "missing";
	return unusable(report, channel, state, error);
}

/**
 * A stale first delivery of an earlier attempt is caught by the caller's exact current binding, not only by replay
 * history. Once a spawn has history, a replacement must name the exact new native attempt; otherwise nothing binds.
 */
function attemptedEarlier(subject: AttemptSubject, attemptId: string): AttemptCaptureError | undefined {
	const prior = Array.isArray(subject.priorAttemptIds) ? subject.priorAttemptIds : [];
	if (prior.includes(attemptId)) return "attempt-replayed";
	if (subject.expectedAttemptId !== undefined) return subject.expectedAttemptId === attemptId ? undefined : "attempt-not-current";
	return prior.length > 0 ? "attempt-not-current" : undefined;
}

/** A native terminal retry count: a finite safe positive integer, never inferred from an error message. */
export function retryAttemptOf(attempt: unknown): number | undefined {
	return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0 ? attempt : undefined;
}

function retryFact(attempt: unknown): { attempt: number } | undefined {
	const count = retryAttemptOf(attempt);
	return count === undefined ? undefined : { attempt: count };
}

function schemaFact(value: { status?: unknown; error?: unknown } | undefined): SchemaFact | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const status = text(value.status);
	const error = boundedText(value.error);
	const fact: SchemaFact = {};
	if (status === "valid" || status === "invalid" || status === "unavailable") fact.status = status;
	if (error !== undefined) fact.error = error;
	return fact.status === undefined && fact.error === undefined ? undefined : fact;
}

function applySchema(report: AttemptReport, schema: SchemaFact | undefined, channel: AttemptChannel, ref: string, version: string): void {
	if (schema?.status !== undefined) {
		report.schemaStatus = schema.status;
		observe(report, { facet: "schema", value: schema.status, source: sourceOf(channel, ref, version) });
	}
	if (schema?.error !== undefined) {
		report.schemaError = schema.error;
		observe(report, { facet: "schema", value: schema.error, source: sourceOf(channel, ref, version) });
	}
}

/** Accepted sync artifacts must match the result's exact declared path for their kind; a patch needs bytes + digest. */
function acceptSyncArtifacts(
	report: AttemptReport,
	subject: AttemptSubject,
	result: SyncResultFact,
	resultId: string,
	captures: readonly HostArtifactCapture[] | undefined,
	version: string,
): AttemptCaptureError | undefined {
	const declared = { output: declaredPath(result.outputPath), patch: declaredPath(result.patchPath) };
	let failure: AttemptCaptureError | undefined;
	for (const candidate of captures ?? []) {
		if (!validCapture(candidate) || candidate.id !== resultId) continue;
		if (candidate.capturedAt < subject.startedAt) {
			if (candidate.kind === "patch") failure = "artifact-capture-stale";
			continue;
		}
		const expected = declared[candidate.kind];
		if (expected === undefined || candidate.path !== expected) {
			if (candidate.kind === "patch") failure = "artifact-path-mismatch";
			continue;
		}
		if (!candidate.exists) {
			if (candidate.kind === "patch") failure = "patch-artifact-missing";
			continue;
		}
		if (candidate.kind === "patch") {
			const problem = patchProblem(candidate);
			if (problem !== undefined) {
				failure = problem;
				continue;
			}
		}
		addCapture(report, candidate, "task-result", version);
	}
	return failure;
}

/** Async has no artifact path of its own: accept only registry captures matching the declared history paths. */
function acceptRegistry(
	report: AttemptReport,
	subject: AttemptSubject,
	capture: AsyncResultCapture,
	options: AsyncReportOptions,
	jobId: string,
): AttemptCaptureError | undefined {
	const registry = options.registry;
	if (registry === undefined) return undefined;
	const registryVersion = boundedVersion(registry.hostVersion ?? capture.hostVersion);
	const declared = { output: declaredPath(registry.history?.outputPath), patch: declaredPath(registry.history?.patchPath) };
	const patchCandidates = (registry.artifacts ?? []).filter(candidate => candidate.kind === "patch" && candidate.id === subject.spawnKey);
	const identity = registryIdentityProblem(registry, subject);
	if (identity !== undefined) return patchCandidates.length > 0 ? identity : undefined;

	let failure: AttemptCaptureError | undefined;
	for (const candidate of registry.artifacts ?? []) {
		if (!validCapture(candidate) || candidate.id !== subject.spawnKey) continue;
		if (candidate.capturedAt < subject.startedAt) {
			if (candidate.kind === "patch") failure = "artifact-capture-stale";
			continue;
		}
		if (candidate.kind === "output") {
			if (declared.output === undefined || candidate.path !== declared.output || !candidate.exists) continue;
			addCapture(report, candidate, "registry", registryVersion);
			continue;
		}
		if (declared.patch === undefined || candidate.path !== declared.patch) {
			failure = "artifact-path-mismatch";
			continue;
		}
		if (!candidate.exists) {
			failure = "patch-artifact-missing";
			continue;
		}
		const problem = patchProblem(candidate);
		if (problem !== undefined) {
			failure = problem;
			continue;
		}
		if (registry.jobId !== undefined) {
			if (nativeId(registry.jobId) !== jobId) {
				failure = "patch-artifact-unproven";
				continue;
			}
		} else {
			const baseline = options.admissionPatch;
			if (baseline === undefined) {
				failure = "patch-artifact-unproven";
				continue;
			}
			if (baseline !== null && baseline.path === candidate.path) {
				const before = stableDigest(baseline.digest);
				if (before === undefined) {
					failure = "patch-artifact-unproven";
					continue;
				}
				if (before === stableDigest(candidate.digest)) {
					failure = "patch-artifact-unchanged";
					continue;
				}
			}
		}
		addCapture(report, candidate, "registry", registryVersion);
	}
	if (declared.patch !== undefined && !report.artifacts.some(artifact => artifact.kind === "patch") && failure === undefined) {
		failure = "patch-artifact-missing";
	}
	return failure;
}

/** Parent + session home + exact child, from an event at/after admission; a removed child owns no artifact. */
function registryIdentityProblem(registry: RegistryCapture, subject: AttemptSubject): AttemptCaptureError | undefined {
	const observed = finite(registry.observedAt);
	if (registry.channel !== "registry" || observed === undefined || observed < subject.startedAt) return "artifact-capture-stale";
	if (registry.id !== subject.spawnKey) return "registry-mismatch";
	if (registry.parentId === undefined || registry.home === undefined || registry.home === "") return "registry-identity-missing";
	if (registry.parentId !== subject.parentId) return "parent-mismatch";
	return registry.event === "removed" ? "artifact-capture-stale" : undefined;
}

/** A patch is evidence only with positive bytes and a parent-computed digest. */
function patchProblem(capture: HostArtifactCapture): AttemptCaptureError | undefined {
	if (!(typeof capture.bytes === "number" && Number.isFinite(capture.bytes) && capture.bytes > 0)) return "patch-artifact-empty";
	return stableDigest(capture.digest) === undefined ? "patch-artifact-unproven" : undefined;
}

function addCapture(report: AttemptReport, capture: HostArtifactCapture, source: "task-result" | "registry", version: string): void {
	if (report.artifacts.length >= ATTEMPT_ARTIFACT_MAX) return;
	if (report.artifacts.some(artifact => artifact.kind === capture.kind && artifact.path === capture.path)) return;
	const artifact: ReportedArtifact = { kind: capture.kind, path: capture.path, capturedAt: capture.capturedAt, source };
	if (typeof capture.bytes === "number") artifact.bytes = capture.bytes;
	const digest = stableDigest(capture.digest);
	if (digest !== undefined) artifact.digest = digest;
	report.artifacts.push(artifact);
	observe(report, {
		facet: "artifact",
		value: `${capture.kind}:${capture.path.length <= 200 ? capture.path : capture.path.slice(0, 200)}`,
		source: sourceOf(source, `${capture.id}:${capture.kind}`, version),
	});
}

function validCapture(capture: HostArtifactCapture): boolean {
	return (
		capture !== null &&
		typeof capture === "object" &&
		(capture.kind === "output" || capture.kind === "patch") &&
		typeof capture.id === "string" &&
		typeof capture.path === "string" &&
		capture.path !== "" &&
		typeof capture.exists === "boolean" &&
		Number.isFinite(capture.capturedAt) &&
		(capture.bytes === undefined || (Number.isFinite(capture.bytes) && capture.bytes >= 0)) &&
		(capture.digest === undefined || typeof capture.digest === "string")
	);
}

function observe(report: AttemptReport, observation: AttemptObservation): void {
	if (report.observations.length >= ATTEMPT_OBSERVATION_MAX) return;
	const value = observation.value;
	report.observations.push({
		facet: observation.facet,
		value: typeof value === "string" ? boundedText(value) ?? "" : value,
		source: {
			channel: observation.source.channel,
			ref: boundedText(observation.source.ref) ?? "",
			version: boundedText(observation.source.version) ?? UNKNOWN_HOST_VERSION,
		},
	});
}

function sourceOf(channel: AttemptChannel, ref: string, version: string): AttemptObservation["source"] {
	return { channel, ref, version };
}

/** Caller-owned fields only: a malformed host spawn key is reported as `invalid/identity-invalid`, never thrown. */
function assertSubject(subject: AttemptSubject): void {
	for (const value of [subject.runId, subject.parentId]) {
		if (typeof value !== "string" || value === "") throw new TypeError("attempt subject requires runId and parentId");
	}
	if (!Number.isFinite(subject.startedAt)) throw new TypeError("attempt subject requires a finite startedAt");
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function boundedText(value: unknown): string | undefined {
	const raw = text(value);
	if (raw === undefined) return undefined;
	const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return clean === "" ? undefined : clean.slice(0, ATTEMPT_TEXT_MAX);
}

function boundedVersion(value: unknown): string {
	const clean = boundedText(value);
	return clean === undefined ? UNKNOWN_HOST_VERSION : clean.slice(0, 64);
}

/** A digest is accepted as-is only when it is a bounded, whitespace-free token; never synthesized from a path. */
function stableDigest(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9+/=_-]{16,128}$/.test(value) ? value : undefined;
}

/** An absolute host path within a sane bound, or undefined. Relative and text-shaped values are not paths. */
function declaredPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\u0000")) return undefined;
	return isAbsolute(value) ? value : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
