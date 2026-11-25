/**
 * Parent-side attempt collector: the one place Storm turns OMP's native result surfaces into attempt reports.
 *
 * OMP exposes a synchronous `task` result (`tool_result` with `details.results[]`), asynchronous job deliveries
 * (`message_end` with `customType:"async-result"`), a native `wait` result that consumes pending job deliveries
 * (`details.op:"wait"` with `details.jobs[]`), and the process-global `AgentRegistry` mirror. None of them is a Storm
 * completion verdict. This module binds each host envelope to the exact child Storm admitted, captures only
 * host-named artifacts from the parent side, and hands one bounded `AttemptReport` to the run controller through the
 * type-only seam in `attempt-bridge.ts`.
 *
 * Trust rules:
 * - identities come from host fields only (`spawnKey`, `toolCallId`, `result.id`, `jobId`, `agentId`, registry
 *   `ref.id`/`parentId`/`session.instanceKey`); model text is never parsed for a job or a path.
 * - a model-supplied path is only a candidate answer citation; the evidence evaluator re-reads it.
 * - a patch is evidence only after the parent stat+sha256 of the exact host-declared path with positive bytes and a
 *   digest. An unchanged registry patch is not new authority.
 * - missing, stale, replayed and unbound deliveries never become a success: the run's requirement stays pending or
 *   unmet with the adapter's stable reason.
 *
 * No I/O beyond parent-side stat/read of host-named paths, no shell, no model call, no second record store.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { RESULT_EVIDENCE_LIMITS, type AnswerCitation } from "./result-evidence.ts";
import {
	UNKNOWN_HOST_VERSION,
	asyncAttemptId,
	asyncAttemptReport,
	attemptUsable,
	missingAttemptReport,
	retryAttemptOf,
	syncAttemptId,
	syncAttemptReport,
	type AsyncJobFact,
	type AttemptReport,
	type AttemptSubject,
	type HostArtifactCapture,
	type RegistryCapture,
	type SyncResultFact,
} from "./attempt-report.ts";
import type { AttemptAdmission, AttemptArtifactMode, AttemptPreparation, AttemptSettlement } from "./attempt-bridge.ts";
import type { PlanLane } from "../types.ts";

/**
 * Largest host output file read as a whole answer: the evaluator's scan bound in characters, at four UTF-8 bytes at
 * most each. A longer output stays the host's partial text and goes to review with its handle.
 */
export const WHOLE_OUTPUT_MAX_BYTES = RESULT_EVIDENCE_LIMITS.answerChars * 4;
/** A patch larger than this is not hashed or accepted as a retained result. */
export const ATTEMPT_PATCH_MAX_BYTES = 64 * 1024 * 1024;
/** How long an isolated async delivery waits for its registry patch before it fails closed. */
export const ATTEMPT_REGISTRY_WAIT_MS = 15_000;
/**
 * How long a native progress retry fact stays eligible for its dispatch. The job's final delivery normally follows
 * immediately; an older progress row must not be attached to a later turn or a reused child.
 */
export const ATTEMPT_PROGRESS_TTL_MS = 15 * 60_000;

/** The run-controller side. Two methods, no second state store. */
export interface AttemptSettlementPort {
	/** Capture and keep the pre-write baseline for this dispatch; fail closed before work starts. */
	prepare(input: AttemptPreparation): Promise<AttemptAdmission>;
	/** Evaluate this exact host attempt against the lane contract and persist the result evidence. */
	settle(input: AttemptSettlement): Promise<void>;
}

/** The subset of `AgentRegistryApi` the collector uses, so tests and host versions stay decoupled. */
export interface AttemptRegistryRef {
	id: string;
	parentId?: string;
	session: { instanceKey?: string } | null;
	history?: {
		outputPath?: string;
		patchPath?: string;
	};
}

export type AttemptRegistryEventType = "registered" | "status_changed" | "metadata_changed" | "removed";

export interface AttemptRegistryEvent {
	type: AttemptRegistryEventType;
	ref: AttemptRegistryRef;
}

export interface AttemptRegistry {
	get(id: string): AttemptRegistryRef | undefined;
	onChange(listener: (event: AttemptRegistryEvent) => void): () => void;
}

export interface AttemptCollectorDeps {
	port: AttemptSettlementPort;
	registry(): AttemptRegistry;
	now?(): number;
	/** Bounded wait for an isolated async registry patch; tests tighten it. */
	registryWaitMs?: number;
}

/** One open native `task` tool call; used only to attach the host's toolCallId to admitted sync children. */
interface OpenTaskCall {
	runId: string;
	toolCallId: string;
	startedAt: number;
	/** The task item names this call asked for; the host spawn key matches one for a manual/auto single item. */
	names: string[];
}

/** The host's early async spawn acknowledgment, kept until the matching `before_subagent_spawn` is admitted. */
interface SpawnAcknowledgement {
	toolCallId: string;
	observedAt: number;
	jobId?: string;
}

/** Parent capture of a registry fact for one child, taken when the event arrived. */
interface RegistryObservation {
	event: AttemptRegistryEventType;
	observedAt: number;
	id: string;
	parentId?: string;
	home?: string;
	outputPath?: string;
	patchPath?: string;
	artifacts: HostArtifactCapture[];
}

/** What one delivery carried as answer text. When the host cut it, the whole output is read at settlement. */
interface DeliveredAnswer {
	text?: string;
	/** The end of the whole output the host kept when it cut it: a preview keeps the head, a sync result the tail. */
	cut?: "head" | "tail";
	/** The host's structured data payload; citation candidates come from it and from the final answer text. */
	data?: unknown;
	/** The output path the delivery itself named (a sync result); otherwise the registry's is used. */
	outputPath?: string;
	/** The host's exact character count of the whole output, when the delivery states one (sync `outputMeta`). */
	chars?: number;
}

const NO_ANSWER: DeliveredAnswer = {};

interface PendingAsync {
	job: AsyncJobFact;
	observedAt: number;
	/** Native surface that delivered the terminal row; kept so the registry settlement cites the same channel. */
	channel: "async-result" | "wait-result";
	answer: DeliveredAnswer;
	timer?: NodeJS.Timeout;
}

interface TrackedAttempt {
	runId: string;
	lane: string;
	spawnKey: string;
	parentId: string;
	dispatch: string;
	followUp: boolean;
	artifactMode: AttemptArtifactMode;
	requiresPatch: boolean;
	startedAt: number;
	priorAttemptIds: string[];
	expectedAttemptId?: string;
	admissionPatch?: HostArtifactCapture | null;
	toolCallId?: string;
	/** A native terminal retry fact observed on this dispatch's own progress; cleared at settlement or expiry. */
	retry?: { attempt: number; observedAt: number; toolCallId: string };
	pending?: PendingAsync;
	/** Latest registry fact for this child at/after admission. */
	registry?: RegistryObservation;
	/** Last usable patch this spawn produced; a follow-up's admission baseline when the registry cannot show one. */
	lastPatch?: HostArtifactCapture;
	settled: boolean;
}

/** A lane with no declared results keeps the pre-contract behavior: no baseline, no settlement. */
export interface AttemptSpawnInput {
	runId: string;
	parentId: string;
	spawnKey: string;
	lane: PlanLane;
	artifactMode: AttemptArtifactMode;
	startedAt: number;
}

export interface AttemptFollowUpInput {
	runId: string;
	parentId: string;
	spawnKey: string;
	lane: PlanLane | undefined;
	artifactMode: AttemptArtifactMode;
	/** The `write agent://<id>` tool call that dispatched this turn; scopes any native progress to it. */
	toolCallId?: string;
	startedAt: number;
}

export interface AttemptTaskCallInput {
	runId: string;
	parentId: string;
	toolCallId: string;
	/** The host task tool input; only item names are read, to correlate concurrent calls to a spawn key. */
	input?: unknown;
	startedAt: number;
}

/** The fields of one synchronous result the collector reads beyond the adapter's identity/outcome facts. */
export interface AttemptSyncResult extends SyncResultFact {
	/** The child's final text; host-authored, used only as answer text. */
	output?: unknown;
	/** True when the host kept only the tail of the child's output in `output`; the whole is at `outputPath`. */
	truncated?: unknown;
	/** The host's own size of the whole output; `charCount` binds a read of `outputPath` to this result. */
	outputMeta?: { charCount?: unknown } | undefined;
	/** The host schema envelope including its data payload; citations are candidates only. */
	structuredOutput?: { status?: unknown; error?: unknown; data?: unknown };
}

/** Host `TaskToolDetails.results`: object items only; attempt-report validates every field it reads. */
function taskResults(details: unknown): readonly AttemptSyncResult[] | undefined {
	if (details === null || typeof details !== "object" || !("results" in details)) return undefined;
	const results = details.results;
	return Array.isArray(results) ? results.filter((item): item is AttemptSyncResult => item !== null && typeof item === "object") : undefined;
}

/** The async delivery envelope, narrowed without trusting any other field. */
function asyncEnvelope(value: unknown): { jobs: unknown; content?: unknown } | undefined {
	if (value === null || typeof value !== "object" || !("customType" in value) || value.customType !== "async-result") return undefined;
	if (!("details" in value) || value.details === null || typeof value.details !== "object" || !("jobs" in value.details)) return undefined;
	return { jobs: value.details.jobs, ...("content" in value ? { content: value.content } : {}) };
}

/** A native wait snapshot; `op` is the host's own discriminator, not a guess from the result text. */
function waitJobs(details: unknown): readonly Record<string, unknown>[] | undefined {
	if (!record(details) || details.op !== "wait" || !Array.isArray(details.jobs)) return undefined;
	return details.jobs.filter(record);
}

/** A wait row is a delivery only when the host still had a result or structured payload to hand over. */
function waitDeliverable(job: Record<string, unknown>): boolean {
	if (hostText(job.resultText) !== undefined || hostText(job.errorText) !== undefined) return true;
	return record(job.structured) && (job.structured.status !== undefined || job.structured.data !== undefined || job.structured.error !== undefined);
}

/**
 * The native `wait` tool result. Only an exact `details.op:"wait"` snapshot is read: its `jobs[]` rows are the host's
 * terminal task facts, and `agentUrlId` is the agent identity (`spawnKey`). A row that carries no result/structured
 * deliverable is an aggregate snapshot of an already-consumed result, never a new completion.
 */
export interface AttemptWaitResultInput {
	runId: string;
	parentId: string;
	details: unknown;
	observedAt: number;
}

export interface AttemptTaskResultInput {
	runId: string;
	parentId: string;
	toolCallId: string;
	/** The host `TaskToolDetails`; only `results`, `progress` and `async` are read. */
	details: unknown;
	/** The task tool's result content; only a fallback for the child's own output. */
	content?: unknown;
	observedAt: number;
}

export interface AttemptMessageInput {
	runId: string;
	parentId: string;
	/** The host message; only a custom `async-result` envelope with `details.jobs` is read. */
	message: unknown;
	observedAt: number;
}

/** One `tool_execution_update` for a task/write call; only `partialResult.details.progress[]` is read. */
export interface AttemptProgressInput {
	runId: string;
	parentId: string;
	toolCallId: string;
	/** Host `tool_execution_update.partialResult`; never model text. */
	partialResult: unknown;
	observedAt: number;
}

export interface AttemptFollowUpJobInput {
	runId: string;
	spawnKey: string;
	jobs: readonly {
		id?: unknown;
		agentId?: unknown;
		startTime?: unknown;
		status?: unknown;
	}[];
}

const HOST_VERSION = UNKNOWN_HOST_VERSION;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Task item names from the host tool input; concurrent calls are correlated to a spawn key by this exact name. */
function taskNames(input: unknown): string[] {
	if (!record(input)) return [];
	const items = Array.isArray(input.tasks) ? input.tasks : [input];
	const names: string[] = [];
	for (const item of items) {
		if (record(item) && typeof item.name === "string" && item.name !== "") names.push(item.name);
	}
	return [...new Set(names)].slice(0, 32);
}

/** The host's async spawn marker: the `task` result names a job that is still running. */
function asyncSpawn(details: unknown): { jobId?: string; running: boolean } | undefined {
	if (!record(details) || !("async" in details) || !record(details.async)) return undefined;
	return {
		running: details.async.state === "running",
		...(typeof details.async.jobId === "string" ? { jobId: details.async.jobId } : {}),
	};
}

/** A non-terminal progress row for this child, used as an older-host fallback for the async spawn marker. */
function openProgress(details: unknown, spawnKey: string): boolean {
	if (!record(details) || !Array.isArray(details.progress)) return false;
	return details.progress.some(item => record(item) && item.id === spawnKey && (item.status === "pending" || item.status === "running"));
}

/** The progress rows of a `tool_execution_update.partialResult`, object entries only. */
function progressRows(partialResult: unknown): Record<string, unknown>[] {
	if (!record(partialResult) || !("details" in partialResult) || !record(partialResult.details)) return [];
	const progress = partialResult.details.progress;
	return Array.isArray(progress) ? progress.filter(record) : [];
}

/**
 * The exact job id a single-item async spawn acknowledged, when the host's own evidence names it. A batch leaves this
 * undefined: its first per-agent delivery binds instead of one item's id being guessed for every child.
 */
function asyncJobFor(details: unknown, spawnKey: string): string | undefined {
	const spawn = asyncSpawn(details);
	if (spawn?.running !== true || spawn.jobId === undefined) return undefined;
	if (spawn.jobId === spawnKey) return spawn.jobId;
	if (!record(details) || !Array.isArray(details.progress)) return undefined;
	const entries = details.progress.filter(record);
	if (entries.length !== 1) return undefined;
	const only = entries[0];
	if (only?.id !== spawnKey || (only.status !== "pending" && only.status !== "running")) return undefined;
	return spawn.jobId;
}

/**
 * Host text with control characters removed, never an identity or a path. It is never cut: an answer is judged and
 * digested whole, and only what Storm puts in a record or a model-facing packet is bounded.
 */
function hostText(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return clean === "" ? undefined : clean;
}

/** The raw text of an extension content field (string or text parts), before any cleaning. */
function rawContentText(value: unknown): string | undefined {
	if (typeof value === "string") return value === "" ? undefined : value;
	if (!Array.isArray(value)) return undefined;
	const parts: string[] = [];
	for (const part of value) {
		if (record(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

/*
 * Native result framing. OMP 19 renders a settled task job's result as the `task-summary.md` envelope
 * (`<task-result id agent status duration>` … `<output>`/`<preview>` … `</task-result>`) followed by the
 * `task-follow-up.md` hint line, and an `async-result` notice wraps one or more such results in `async-result.md`
 * (`<system-notice>`, a per-job `── Job <id> (<label>) ──` header when batched, optional `Agent:` / `Structured
 * output:` suffixes). The child's own output inside `<output>` is escaped only for harness tags, so it can contain any
 * other text, including a quoted `<task-result>` of another job. The envelope is therefore anchored at the host-rendered
 * start and end only, located from the host's structured `details.jobs[]`, never searched for in model text. A shape
 * that cannot be attributed to exactly one job yields no text (the answer stays missing, never accepted).
 */

/** `task-follow-up.md` lead-ins after `{{agentId}} `. */
const FOLLOW_UP_HINTS = [
	"is now idle",
	"was stopped but is still resumable",
	"was aborted",
	"ran isolated and cannot be resumed or messaged",
	"stopped and cannot be messaged",
] as const;
/** OMP's `escapeHarnessTags`: applied to every label/result rendered into the notice. */
const HARNESS_TAG_START = /<(?=\s*\/?\s*(?:irc|tangent-notice|system-[a-z][a-z-]*)(?![\w-]))/gi;
const TASK_RESULT_OPEN = /^<task-result id="([^"\n]*)" agent="[^"\n]*" status="[^"\n]*" duration="[^"\n]*">\n/;
const TASK_RESULT_CLOSE = "</task-result>";
/** `formatResultOutputFallback` for a child that produced nothing. */
const NO_OUTPUT = /^\(no output\)(?: after \d+ req)?$/;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function countOf(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count += 1;
	return count;
}

/** Removes the host's own trailing follow-up hint for exactly this agent; anything else is kept. */
function withoutFollowUpHint(value: string, agentId: string): string {
	const hint = new RegExp(`\\n\\n${escapeRegExp(agentId)} (?:${FOLLOW_UP_HINTS.map(escapeRegExp).join("|")}) — [^\\n]*$`);
	const match = hint.exec(value);
	return match === null ? value : value.slice(0, match.index);
}

/** Skips one optional host-authored `<tag>…</tag>` preamble element at `at`. */
function skipElement(inner: string, at: number, tag: string): number | undefined {
	if (!inner.startsWith(`<${tag}>`, at)) return at;
	const close = inner.indexOf(`</${tag}>\n`, at);
	return close < 0 ? undefined : close + tag.length + 4;
}

function skipBlankLines(inner: string, at: number): number {
	while (inner[at] === "\n") at += 1;
	return at;
}

/**
 * The worker output of one native task-job result string (a wait row's `resultText`/`errorText`, or one job's result
 * isolated from an `async-result` notice). A bare result (no envelope) is the host's genuine shape for follow-up turns
 * and failures and is returned as-is; a wrapped result must be this exact agent's well-formed envelope.
 */
export function nativeJobOutput(result: string, agentId: string): NativeJobOutput | undefined {
	const value = withoutFollowUpHint(result.trimEnd(), agentId).trim();
	if (!value.startsWith("<task-result")) return value === "" ? undefined : { text: value, preview: false };
	const open = TASK_RESULT_OPEN.exec(value);
	// Another job's (or a malformed/truncated) envelope is never this agent's answer.
	if (open === null || open[1] !== agentId || !value.endsWith(TASK_RESULT_CLOSE)) return undefined;
	const inner = value.slice(open[0].length, value.length - TASK_RESULT_CLOSE.length);
	// Front: host preamble (optional meta, abort reason, error), then exactly one body opener.
	let at: number | undefined = skipBlankLines(inner, 0);
	if (/^<meta lines="\d+" size="[^"\n]*" \/>\n/.test(inner.slice(at))) at = skipBlankLines(inner, inner.indexOf("\n", at) + 1);
	at = skipElement(inner, at, "abort-reason");
	if (at === undefined) return undefined;
	at = skipElement(inner, skipBlankLines(inner, at), "error");
	if (at === undefined) return undefined;
	at = skipBlankLines(inner, at);
	const previewOpen = `<preview full-output="agent://${agentId}">\n`;
	const kind = inner.startsWith("<output>\n", at) ? "output" : inner.startsWith(previewOpen, at) ? "preview" : undefined;
	if (kind === undefined) return undefined;
	const start = at + (kind === "output" ? "<output>\n".length : previewOpen.length);
	// Back: the body closes at the real end of the envelope (optionally before the host's merge summary), so a closing
	// tag quoted inside the child's own output stays part of that output.
	const close = `\n</${kind}>\n`;
	let end: number;
	if (inner.endsWith(close)) end = inner.length - close.length;
	else if (inner.endsWith("\n</merge-summary>\n")) end = inner.lastIndexOf(`${close}<merge-summary>\n`);
	else return undefined;
	if (end < start) return undefined;
	const body = inner.slice(start, end).trim();
	return body === "" || NO_OUTPUT.test(body) ? undefined : { text: body, preview: kind === "preview" };
}

/** One job's output as the host delivered it, and whether that is only the host's preview of a longer output. */
export interface NativeJobOutput {
	text: string;
	/** The host cut the output to a `<preview full-output="agent://<id>">` head; the whole is in its output file. */
	preview: boolean;
}

/** A delivered job output as answer text: a preview keeps the head of the whole output. */
function deliveredOf(output: NativeJobOutput | undefined, data: unknown): DeliveredAnswer {
	const text = hostText(output?.text);
	return {
		...(text === undefined ? {} : { text }),
		...(output?.preview === true ? { cut: "head" as const } : {}),
		...(data === undefined ? {} : { data }),
	};
}

/**
 * The result of `jobs[index]` isolated from an `async-result` notice by re-deriving the `async-result.md` frame from
 * the host's own `details.jobs[]`. Returns undefined when the frame does not match or the job's segment is ambiguous.
 */
function asyncJobResult(content: string, jobs: readonly unknown[], index: number): string | undefined {
	const job = jobs[index];
	if (!record(job) || typeof job.jobId !== "string") return undefined;
	const text = content.trim();
	// An unframed single delivery (older host or adapter) is the result itself; a batch cannot be attributed.
	if (!text.startsWith("<system-notice>")) return jobs.length === 1 ? text : undefined;
	const framed = text.startsWith("<system-notice>\n") && text.endsWith("\n</system-notice>");
	if (!framed) return undefined;
	const body = text.slice("<system-notice>\n".length, text.length - "\n</system-notice>".length);
	let segment: string;
	if (jobs.length === 1) {
		const header = `Background job ${job.jobId} has completed.\nResume your work using the result below.\n`;
		if (!body.startsWith(header)) return undefined;
		segment = body.slice(header.length);
	} else {
		const intro = `${jobs.length} background jobs have completed. Resume your work using the results below.\n\n`;
		if (!body.startsWith(intro)) return undefined;
		const headerOf = (candidate: unknown): string | undefined => {
			if (!record(candidate) || typeof candidate.jobId !== "string") return undefined;
			const label = typeof candidate.label === "string" && candidate.label !== "" ? candidate.label.replace(HARNESS_TAG_START, "&lt;") : undefined;
			return `── Job ${candidate.jobId}${label === undefined ? "" : ` (${label})`} ──\n`;
		};
		const header = headerOf(job);
		if (header === undefined || countOf(body, header) !== 1) return undefined;
		const start = body.indexOf(header);
		if (index === 0 ? start !== intro.length : body[start - 1] !== "\n") return undefined;
		let end = body.length;
		if (index < jobs.length - 1) {
			const next = headerOf(jobs[index + 1]);
			if (next === undefined || countOf(body, next) !== 1) return undefined;
			const nextAt = body.indexOf(next);
			if (nextAt <= start || body[nextAt - 1] !== "\n") return undefined;
			end = nextAt - 1;
		}
		segment = body.slice(start + header.length, end);
	}
	// Host suffixes after `{{this.result}}`: the structured-output block (only when the job row carries a schema) and
	// the `Agent:` handles line.
	const agentUrlId = typeof job.agentId === "string" ? job.agentId : job.jobId;
	if (record(job.schema) && job.schema.status !== undefined) {
		const marker = "\n\nStructured output: ";
		if (countOf(segment, marker) !== 1) return undefined;
		segment = segment.slice(0, segment.indexOf(marker));
	}
	for (const handles of [`\n\nAgent: agent://${agentUrlId}, history://${agentUrlId}`, `\n\nAgent: history://${agentUrlId}`]) {
		if (segment.endsWith(handles)) {
			segment = segment.slice(0, segment.length - handles.length);
			break;
		}
	}
	return segment;
}

/** Worker output for one correlated async job, or undefined when the host shape cannot be attributed. */
function asyncJobOutput(content: unknown, jobs: readonly unknown[], index: number, agentId: string): NativeJobOutput | undefined {
	const raw = rawContentText(content);
	if (raw === undefined) return undefined;
	const result = asyncJobResult(raw, jobs, index);
	return result === undefined ? undefined : nativeJobOutput(result, agentId);
}

/** An absolute host path within the adapter's own declared-path bound. */
function declaredPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > RESULT_EVIDENCE_LIMITS.pathChars || value.includes("\u0000")) return undefined;
	return isAbsolute(value) ? value : undefined;
}

function safeRelativePath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > RESULT_EVIDENCE_LIMITS.pathChars) return undefined;
	if (value.startsWith("/") || value.includes("\0") || /[<>:"|?*\u0000-\u001f]/u.test(value)) return undefined;
	if (value.split(/[\\/]+/).includes("..")) return undefined;
	return value;
}

/**
 * The whole output the host cut, read from its own output file. The path must be host-declared and absolute, name
 * exactly this agent's `<id>.md`, and be a regular file (no symlink) within the scan bound. The text must contain the
 * delivered part at the end the host kept, and match the host's own character count when it stated one; otherwise
 * the file is another turn's or not this output, and nothing is read.
 */
async function readWholeOutput(path: string, agentId: string, answer: DeliveredAnswer): Promise<string | undefined> {
	const declared = declaredPath(path);
	if (declared === undefined || basename(declared) !== `${agentId}.md`) return undefined;
	let handle: FileHandle | undefined;
	try {
		const link = await fs.lstat(declared);
		if (link.isSymbolicLink() || !link.isFile()) return undefined;
		handle = await fs.open(declared, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size <= 0 || stat.size > WHOLE_OUTPUT_MAX_BYTES) return undefined;
		const raw = (await handle.readFile()).toString("utf8");
		if (raw.length > RESULT_EVIDENCE_LIMITS.answerChars) return undefined;
		if (answer.chars !== undefined && raw.length !== answer.chars) return undefined;
		const whole = hostText(raw);
		if (whole === undefined) return undefined;
		const part = answer.text;
		if (part !== undefined && !(answer.cut === "tail" ? whole.endsWith(part) : whole.startsWith(part))) return undefined;
		return whole;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Parent capture of the exact host-declared path. A path that was not declared by the host, is relative, or names a
 * non-file is not an artifact. Only patches are hashed: the adapter needs a digest to call one new.
 */
async function captureArtifact(
	id: string,
	kind: "output" | "patch",
	path: string,
	capturedAt: number,
): Promise<HostArtifactCapture> {
	try {
		const link = await fs.lstat(path);
		if (link.isSymbolicLink()) return { id, kind, path, exists: false, bytes: 0, capturedAt };
		const stat = link.isFile() ? link : await fs.stat(path);
		if (!stat.isFile()) return { id, kind, path, exists: false, bytes: 0, capturedAt };
		const capture: HostArtifactCapture = { id, kind, path, exists: true, bytes: stat.size, capturedAt };
		if (kind !== "patch" || stat.size <= 0 || stat.size > ATTEMPT_PATCH_MAX_BYTES) return capture;
		const digest = await hashFile(path, ATTEMPT_PATCH_MAX_BYTES);
		return digest === undefined ? capture : { ...capture, digest };
	} catch {
		return { id, kind, path, exists: false, bytes: 0, capturedAt };
	}
}

/** Streaming sha256 with a hard byte ceiling; over-budget or unreadable files produce no digest. */
async function hashFile(path: string, maxBytes: number): Promise<string | undefined> {
	const hash = createHash("sha256");
	const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
	let bytes = 0;
	try {
		for await (const chunk of stream) {
			const buffer = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), "utf8");
			bytes += buffer.byteLength;
			if (bytes > maxBytes) {
				stream.destroy();
				return undefined;
			}
			hash.update(buffer);
		}
	} catch {
		return undefined;
	}
	return hash.digest("hex");
}

/** The registry home is the instance-key prefix (`main` / `w1`), never guessed from a path. */
function registryHome(ref: AttemptRegistryRef): string | undefined {
	const key = ref.session?.instanceKey;
	if (typeof key !== "string" || key === "") return undefined;
	return key.split(":")[0];
}

/** Whether a patch failure can still be fixed by a later registry event. */
function waitablePatch(error: string | undefined): boolean {
	return error === "patch-artifact-missing" || error === "patch-artifact-unchanged" || error === "artifact-capture-stale";
}

/** Citation candidates from one attempt's structured data and its own text; at most the evaluator's citation count. */
export function answerCitations(structured: unknown, text: string | undefined): AnswerCitation[] {
	const out: AnswerCitation[] = [];
	const seen = new Set<string>();
	const add = (pathValue: unknown, lineValue: unknown, quoteValue?: unknown): void => {
		if (out.length >= RESULT_EVIDENCE_LIMITS.citations) return;
		const path = safeRelativePath(pathValue);
		if (path === undefined) return;
		const line = typeof lineValue === "number" && Number.isSafeInteger(lineValue) && lineValue > 0 && lineValue <= 10_000_000 ? lineValue : undefined;
		const quote = hostText(quoteValue)?.slice(0, RESULT_EVIDENCE_LIMITS.quoteChars);
		const key = `${path}\0${line ?? ""}\0${quote ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ path, ...(line === undefined ? {} : { line }), ...(quote === undefined ? {} : { quote }) });
	};

	if (record(structured) && Array.isArray(structured.citations)) {
		for (const candidate of structured.citations) {
			if (record(candidate)) add(candidate.path, candidate.line, candidate.quote);
		}
	}

	if (text !== undefined) {
		// `path:line` / `path:start-end` references are exact locations; the evaluator re-reads each source.
		const pattern = /(?:^|[\s(`"'])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]+):(\d{1,7})\b/g;
		for (const match of text.matchAll(pattern)) {
			add(match[1], Number(match[2]));
			if (out.length >= RESULT_EVIDENCE_LIMITS.citations) break;
		}
	}
	return out;
}

/** The collector. One instance belongs to the main session's extension module. */
export class AttemptCollector {
	readonly #deps: AttemptCollectorDeps;
	readonly #now: () => number;
	readonly #waitMs: number;
	#registry: AttemptRegistry | undefined;
	#unsubscribe: (() => void) | undefined;
	#tracked = new Map<string, TrackedAttempt>();
	#openCalls = new Map<string, OpenTaskCall[]>();
	/** Keyed `runId\0parentId\0spawnKey`: the host named the child before omp emitted its spawn event. */
	#acknowledged = new Map<string, SpawnAcknowledgement>();
	#serial = 0;
	#registryChain: Promise<void> = Promise.resolve();
	#stopped = false;

	constructor(deps: AttemptCollectorDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#waitMs = deps.registryWaitMs ?? ATTEMPT_REGISTRY_WAIT_MS;
	}

	/** Subscribe once, before the first contract-bearing child starts. Idempotent. */
	start(): void {
		if (this.#unsubscribe !== undefined) return;
		this.#stopped = false;
		const registry = this.#deps.registry();
		this.#registry = registry;
		this.#unsubscribe = registry.onChange(event => {
			// Registry listeners are synchronous; capture may read files, so order events through one chain.
			this.#registryChain = this.#registryChain.then(() => this.#observeRegistry(event)).catch(() => undefined);
		});
	}

	/** Unsubscribe and drop this session's transient attempts. Timers are cleared; nothing is settled after stop. */
	stop(): void {
		this.#stopped = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#registry = undefined;
		for (const tracked of this.#tracked.values()) this.#clearPending(tracked);
		this.#tracked.clear();
		this.#openCalls.clear();
		this.#acknowledged.clear();
		this.#registryChain = Promise.resolve();
	}

	/** Records an open `task` call so admitted sync children can carry its exact host toolCallId. */
	observeTaskCall(input: AttemptTaskCallInput): void {
		if (this.#stopped) return;
		const list = this.#openCalls.get(input.parentId) ?? [];
		list.push({ runId: input.runId, toolCallId: input.toolCallId, startedAt: input.startedAt, names: taskNames(input.input) });
		this.#openCalls.set(input.parentId, list.slice(-8));
	}

	/**
	 * Binds native progress to the dispatch it actually belongs to. Progress rows are not proof; only a
	 * `retryFailure.attempt` on the current child's row, for the same run/parent/toolCall and after admission, is kept
	 * for the final delivery. A later turn replaces the tracked attempt, so an old row cannot attach to it.
	 */
	observeProgress(input: AttemptProgressInput): void {
		if (this.#stopped) return;
		const rows = progressRows(input.partialResult);
		if (rows.length === 0) return;
		for (const tracked of this.#tracked.values()) {
			if (tracked.settled || tracked.runId !== input.runId || tracked.parentId !== input.parentId) continue;
			if (tracked.toolCallId !== input.toolCallId || input.observedAt < tracked.startedAt) continue;
			const row = rows.find(item => item.id === tracked.spawnKey);
			if (row === undefined || !record(row.retryFailure)) continue;
			const attempt = retryAttemptOf(row.retryFailure.attempt);
			if (attempt === undefined) continue;
			tracked.retry = { attempt, observedAt: input.observedAt, toolCallId: input.toolCallId };
		}
	}

	/**
	 * Admission of a fresh spawn, after every existing refusal and the lane/ledger binding. The controller's baseline
	 * is captured here, immediately before omp starts the child. A refusal blocks the spawn.
	 */
	async admitSpawn(input: AttemptSpawnInput): Promise<AttemptAdmission> {
		const lane = input.lane.results !== undefined && input.lane.results.length > 0 ? input.lane : undefined;
		if (lane === undefined) return { ok: true };
		this.start();
		const dispatch = this.#dispatch(input.spawnKey, input.startedAt);
		const open = (this.#openCalls.get(input.parentId) ?? []).filter(call => call.runId === input.runId);
		const named = open.filter(call => call.names.includes(input.spawnKey));
		let toolCallId = named.length === 1 ? named[0]?.toolCallId : open.length === 1 ? open[0]?.toolCallId : undefined;
		let acknowledgedJobId: string | undefined;
		// The async spawn acknowledgment may already have named this child before the host emitted its spawn event.
		const ackKey = `${input.runId}\0${input.parentId}\0${input.spawnKey}`;
		const acknowledged = this.#acknowledged.get(ackKey);
		this.#acknowledged.delete(ackKey);
		if (toolCallId === undefined && acknowledged !== undefined) {
			const age = input.startedAt - acknowledged.observedAt;
			if (age >= 0 && age <= ATTEMPT_PROGRESS_TTL_MS) {
				toolCallId = acknowledged.toolCallId;
				acknowledgedJobId = acknowledged.jobId;
			}
		}
		const requiresPatch = input.artifactMode === "isolated" && lane.results?.some(result => result.kind === "artifact") === true;
		const admissionPatch = requiresPatch ? await this.#admissionPatch(input.spawnKey, undefined, true) : undefined;
		const expectedAttemptId = acknowledgedJobId === undefined ? undefined : asyncAttemptId(acknowledgedJobId, input.spawnKey);
		const tracked: TrackedAttempt = {
			runId: input.runId,
			lane: lane.name,
			spawnKey: input.spawnKey,
			parentId: input.parentId,
			dispatch,
			followUp: false,
			artifactMode: input.artifactMode,
			requiresPatch,
			startedAt: input.startedAt,
			priorAttemptIds: [],
			settled: false,
			...(toolCallId === undefined ? {} : { toolCallId }),
			...(expectedAttemptId === undefined ? {} : { expectedAttemptId }),
			...(admissionPatch === undefined ? {} : { admissionPatch }),
		};
		const prepared = await this.#prepare(tracked);
		if (!prepared.ok) return prepared;
		const previous = this.#tracked.get(input.spawnKey);
		if (previous !== undefined) this.#clearPending(previous);
		this.#tracked.set(input.spawnKey, tracked);
		return { ok: true };
	}

	/**
	 * Admission of a `write agent://<id>` turn. The pre-write baseline is the state before that turn. A child that
	 * this run did not admit is left alone (no baseline, no settlement).
	 */
	async admitFollowUp(input: AttemptFollowUpInput): Promise<AttemptAdmission> {
		const previous = this.#tracked.get(input.spawnKey);
		const lane = input.lane !== undefined && input.lane.results !== undefined && input.lane.results.length > 0 ? input.lane : undefined;
		if (lane === undefined) return { ok: true };
		if (previous === undefined || previous.runId !== input.runId) return { ok: true };
		this.start();
		// A follow-up cannot start while the previous turn's patch is still pending; fail it closed first.
		if (previous.pending !== undefined) await this.#settlePending(previous, true);
		const dispatch = this.#dispatch(input.spawnKey, input.startedAt);
		const requiresPatch = input.artifactMode === "isolated" && lane.results?.some(result => result.kind === "artifact") === true;
		const admissionPatch = requiresPatch ? await this.#admissionPatch(input.spawnKey, previous.lastPatch, false) : undefined;
		const tracked: TrackedAttempt = {
			runId: input.runId,
			lane: lane.name,
			spawnKey: input.spawnKey,
			parentId: input.parentId,
			dispatch,
			followUp: true,
			artifactMode: input.artifactMode,
			requiresPatch,
			startedAt: input.startedAt,
			priorAttemptIds: [...previous.priorAttemptIds],
			settled: false,
			...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
			...(admissionPatch === undefined ? {} : { admissionPatch }),
		};
		const prepared = await this.#prepare(tracked);
		if (!prepared.ok) return prepared;
		this.#tracked.set(input.spawnKey, tracked);
		return { ok: true };
	}

	/**
	 * Binds the exact new async job of an accepted follow-up from the parent session's own job snapshot. Without this,
	 * a same-agent follow-up's first delivery is stale by design (`priorAttemptIds` is non-empty).
	 */
	bindFollowUpJobs(input: AttemptFollowUpJobInput): void {
		const tracked = this.#tracked.get(input.spawnKey);
		if (tracked === undefined || tracked.runId !== input.runId || tracked.settled || !tracked.followUp) return;
		const candidates = input.jobs.filter(job => {
			if (typeof job.agentId !== "string" || job.agentId !== input.spawnKey) return false;
			if (typeof job.id !== "string" || job.id === "") return false;
			if (typeof job.startTime !== "number" || !Number.isFinite(job.startTime)) return false;
			return job.startTime >= tracked.startedAt;
		});
		if (candidates.length !== 1) return;
		const jobId = candidates[0]?.id;
		const attemptId = typeof jobId === "string" ? asyncAttemptId(jobId, input.spawnKey) : undefined;
		if (attemptId !== undefined) tracked.expectedAttemptId = attemptId;
	}

	/**
	 * The sync `task` envelope. Called before any `event.isError` return: a failed tool call still carries host
	 * results, and one missing item must be reported rather than silently treated as no work.
	 */
	async observeTaskResult(input: AttemptTaskResultInput): Promise<void> {
		if (this.#stopped) return;
		const open = this.#openCalls.get(input.parentId) ?? [];
		const index = open.findIndex(call => call.toolCallId === input.toolCallId);
		if (index >= 0) open.splice(index, 1);
		if (open.length === 0) this.#openCalls.delete(input.parentId);
		const results = taskResults(input.details);
		const spawn = asyncSpawn(input.details);
		// OMP can emit the async spawn acknowledgment before `before_subagent_spawn` admits the child. Keep the host's
		// exact tool call (and job id when it names this child) for that admission; a stale entry is dropped at use.
		if (results?.length === 0 && spawn?.running === true && record(input.details) && Array.isArray(input.details.progress)) {
			for (const row of input.details.progress) {
				if (!record(row) || typeof row.id !== "string" || this.#tracked.has(row.id)) continue;
				const jobId = asyncJobFor(input.details, row.id);
				this.#acknowledged.set(`${input.runId}\0${input.parentId}\0${row.id}`, {
					toolCallId: input.toolCallId,
					observedAt: input.observedAt,
					...(jobId === undefined ? {} : { jobId }),
				});
			}
		}
		// The sync tool content is the host's `<task-result>` summary; only a single-result call can be attributed.
		const rawContent = rawContentText(input.content);
		const fallbackOutput: NativeJobOutput | undefined =
			rawContent === undefined
				? undefined
				: results?.length === 1 && typeof results[0]?.id === "string"
					? nativeJobOutput(rawContent, results[0].id)
					: rawContent.includes("<task-result")
						? undefined
						: { text: rawContent, preview: false };
		for (const tracked of [...this.#tracked.values()]) {
			if (tracked.settled || tracked.followUp || tracked.runId !== input.runId) continue;
			if (tracked.parentId !== input.parentId) continue;
			const bound = tracked.toolCallId === input.toolCallId;
			const result = results?.find(candidate => candidate.id === tracked.spawnKey);
			if (result === undefined) {
				// An async spawn's task tool_result is only an acknowledgment (`results: []`, job still running). The real
				// result arrives later as `async-result`; settling here would consume the dispatch before it exists.
				const preliminary = spawn?.running === true || (results?.length === 0 && openProgress(input.details, tracked.spawnKey));
				if (preliminary) {
					// A parallel task call may leave several calls open at admission. The host's own progress row names
					// this child, so the acknowledgment binds the exact call after the fact; later progress can then be
					// scoped to it without guessing from timing.
					if (!bound && tracked.toolCallId === undefined && openProgress(input.details, tracked.spawnKey)) {
						tracked.toolCallId = input.toolCallId;
					}
					if (tracked.toolCallId === input.toolCallId) {
						const jobId = asyncJobFor(input.details, tracked.spawnKey);
						const expected = jobId === undefined ? undefined : asyncAttemptId(jobId, tracked.spawnKey);
						if (expected !== undefined) tracked.expectedAttemptId = expected;
					}
					continue;
				}
				if (bound) await this.#settleMissing(tracked, input.observedAt);
				continue;
			}
			if (!bound && tracked.toolCallId !== undefined) continue;
			const artifacts = await this.#syncArtifacts(result, tracked.spawnKey, input.observedAt);
			const expected = bound ? syncAttemptId(input.toolCallId, tracked.spawnKey) : undefined;
			const report = syncAttemptReport(this.#subject(tracked, expected), {
				channel: "task-result",
				toolCallId: input.toolCallId,
				observedAt: input.observedAt,
				results: [result],
				artifacts,
				hostVersion: HOST_VERSION,
			}, { requirePatch: tracked.requiresPatch });
			if (!this.#deliveryBelongs(tracked, report)) continue;
			const structured = result.structuredOutput;
			const data = structured !== null && typeof structured === "object" && "data" in structured ? structured.data : undefined;
			const own = hostText(result.output);
			const outputPath = declaredPath(result.outputPath);
			const chars = record(result.outputMeta) && Number.isSafeInteger(result.outputMeta.charCount) ? result.outputMeta.charCount as number : undefined;
			const delivered: DeliveredAnswer =
				own === undefined
					? deliveredOf(fallbackOutput, data)
					: { text: own, ...(result.truncated === true ? { cut: "tail" as const } : {}), ...(data === undefined ? {} : { data }) };
			await this.#settleReport(tracked, report, {
				...delivered,
				...(outputPath === undefined ? {} : { outputPath }),
				...(chars === undefined ? {} : { chars }),
			});
		}
	}

	/** Async deliveries. One `async-result` may batch jobs; each job is its own attempt. */
	async observeMessage(input: AttemptMessageInput): Promise<void> {
		if (this.#stopped) return;
		const envelope = asyncEnvelope(input.message);
		if (envelope === undefined) return;
		const jobs = envelope.jobs;
		if (!Array.isArray(jobs)) return;
		for (const [index, job] of jobs.entries()) {
			if (!record(job)) continue;
			const agentId = typeof job.agentId === "string" ? job.agentId : undefined;
			if (agentId === undefined) continue;
			const tracked = this.#tracked.get(agentId);
			if (tracked === undefined || tracked.runId !== input.runId || tracked.settled) continue;
			// Only this job's own output, never the notice frame or a sibling job's answer.
			await this.#observeAsyncJob(tracked, job, input.observedAt, asyncJobOutput(envelope.content, jobs, index, agentId));
		}
	}

	/**
	 * The native `wait` result. A wait consumes the jobs it reports, so its terminal task rows are deliveries even
	 * though no `async-result` message follows. Each row is reconciled against the one admitted dispatch: run, parent,
	 * host agent id, exact expected job (when the host already named it), and settlement after admission. A repeated
	 * or aggregate row can never settle twice; an empty completed row (already delivered elsewhere) is not a delivery.
	 */
	async observeWaitResult(input: AttemptWaitResultInput): Promise<void> {
		if (this.#stopped) return;
		const jobs = waitJobs(input.details);
		if (jobs === undefined) return;
		for (const job of jobs) {
			if (job.type !== "task") continue;
			const jobId = typeof job.id === "string" ? job.id : undefined;
			const agentId = typeof job.agentUrlId === "string" ? job.agentUrlId : undefined;
			if (jobId === undefined || agentId === undefined) continue;
			const tracked = this.#tracked.get(agentId);
			if (tracked === undefined || tracked.runId !== input.runId || tracked.parentId !== input.parentId || tracked.settled) continue;
			if (input.observedAt < tracked.startedAt) continue;
			// The wait snapshot is the delivery only when the host still holds a result for this row; a later aggregate
			// row of an independently delivered job carries no text and must not replace that completion.
			const status = typeof job.status === "string" ? job.status : undefined;
			const raw = typeof job.resultText === "string" && job.resultText !== "" ? job.resultText : job.errorText;
			const output = typeof raw === "string" ? nativeJobOutput(raw, agentId) : undefined;
			if (status === "completed" && !waitDeliverable(job)) continue;
			// The job can be enqueued just before `before_subagent_spawn`; admission is the child-start epoch, so the
			// terminal settlement must not precede it. A pre-admission job (another turn or a reused child) is ignored.
			const settledAt = typeof job.settledAtMs === "number" && Number.isFinite(job.settledAtMs) ? job.settledAtMs : undefined;
			if (settledAt === undefined || settledAt < tracked.startedAt) continue;
			const attemptId = asyncAttemptId(jobId, agentId);
			if (attemptId === undefined) continue;
			// Once the host named the exact job, only that job can settle this dispatch.
			if (tracked.expectedAttemptId !== undefined && tracked.expectedAttemptId !== attemptId) continue;
			// A follow-up/reused child has attempt history: its wait row must be the exact job bound to this turn. A row
			// that merely shares the agent id is the old turn's result and must not resurrect it.
			if ((tracked.followUp || tracked.priorAttemptIds.length > 0) && tracked.expectedAttemptId === undefined) continue;
			const structured = record(job.structured) ? job.structured : undefined;
			const fact: AsyncJobFact = {
				jobId,
				agentId,
				status,
				...(structured === undefined
					? {}
					: { schema: { status: structured.status, error: structured.error } }),
			};
			await this.#observeJobDelivery(
				tracked,
				fact,
				input.observedAt,
				deliveredOf(output, structured !== undefined && "data" in structured ? structured.data : undefined),
				"wait-result",
			);
		}
	}

	/** Exposed for tests; production uses the registry subscription. */
	async observeRegistry(event: AttemptRegistryEvent): Promise<void> {
		await this.#observeRegistry(event);
	}

	async #prepare(tracked: TrackedAttempt): Promise<AttemptAdmission> {
		try {
			return await this.#deps.port.prepare({
				runId: tracked.runId,
				lane: tracked.lane,
				spawnKey: tracked.spawnKey,
				parentId: tracked.parentId,
				dispatch: tracked.dispatch,
				followUp: tracked.followUp,
				artifactMode: tracked.artifactMode,
				startedAt: tracked.startedAt,
				...(tracked.admissionPatch === undefined ? {} : { admissionPatch: tracked.admissionPatch }),
			});
		} catch {
			return { ok: false, reason: "결과 기준선을 준비하지 못해 작업을 시작하지 않았습니다. 실행 상태를 확인한 뒤 다시 시도하세요." };
		}
	}

	#dispatch(spawnKey: string, startedAt: number): string {
		this.#serial += 1;
		return `attempt:${spawnKey}:${startedAt}:${this.#serial}`;
	}

	/** The dispatch-scoped native retry count, or undefined when it expired or belongs to another turn. */
	#retryOf(tracked: TrackedAttempt): number | undefined {
		const retry = tracked.retry;
		if (retry === undefined) return undefined;
		if (retry.toolCallId !== tracked.toolCallId) return undefined;
		if (this.#now() - retry.observedAt > ATTEMPT_PROGRESS_TTL_MS) {
			delete tracked.retry;
			return undefined;
		}
		return retry.attempt;
	}

	#subject(tracked: TrackedAttempt, expected = tracked.expectedAttemptId): AttemptSubject {
		return {
			runId: tracked.runId,
			parentId: tracked.parentId,
			spawnKey: tracked.spawnKey,
			startedAt: tracked.startedAt,
			...(expected === undefined ? {} : { expectedAttemptId: expected }),
			priorAttemptIds: [...tracked.priorAttemptIds],
		};
	}

	/**
	 * Admission baseline for a required patch. `null` means the registry showed no patch then; undefined means no
	 * trustworthy baseline exists and a later patch must not be promoted.
	 */
	async #admissionPatch(
		spawnKey: string,
		previous: HostArtifactCapture | undefined,
		fresh: boolean,
	): Promise<HostArtifactCapture | null | undefined> {
		const ref = this.#registry?.get(spawnKey);
		const path = declaredPath(ref?.history?.patchPath);
		if (path !== undefined) {
			const captured = await captureArtifact(spawnKey, "patch", path, this.#now());
			if (captured.exists && captured.digest !== undefined) return captured;
			return previous ?? captured;
		}
		// A registered child with no patch is a real "no patch yet" baseline. A fresh host child id cannot inherit a
		// patch; a follow-up with no visible history and no prior usable patch cannot prove a later one.
		if (ref !== undefined) return previous ?? null;
		return fresh ? null : previous;
	}

	async #syncArtifacts(result: AttemptSyncResult, resultId: string, observedAt: number): Promise<HostArtifactCapture[]> {
		const captures: HostArtifactCapture[] = [];
		for (const [kind, value] of [["output", result.outputPath], ["patch", result.patchPath]] as const) {
			const path = declaredPath(value);
			if (path === undefined) continue;
			captures.push(await captureArtifact(resultId, kind, path, observedAt));
		}
		return captures;
	}

	/** A delivery must be the exact current attempt; stale/replayed proofs are ignored without consuming the dispatch. */
	#deliveryBelongs(tracked: TrackedAttempt, report: AttemptReport): boolean {
		if (report.captureError === "attempt-replayed") return false;
		if (report.captureError === "attempt-not-current") return false;
		if (report.captureError === "spawn-mismatch" || report.captureError === "identity-invalid") return false;
		if (report.captureError === "job-not-settled") return false;
		if (report.captureError === "native-delivery-missing" || report.captureError === "native-result-missing") {
			return tracked.toolCallId !== undefined || report.attemptId !== undefined;
		}
		return true;
	}

	async #observeAsyncJob(tracked: TrackedAttempt, job: Record<string, unknown>, observedAt: number, output: NativeJobOutput | undefined): Promise<void> {
		const fact: AsyncJobFact = {
			jobId: job.jobId,
			agentId: job.agentId,
			status: job.status,
			schema: record(job.schema)
				? { status: job.schema.status, error: job.schema.error }
				: undefined,
		};
		await this.#observeJobDelivery(
			tracked,
			fact,
			observedAt,
			deliveredOf(output, record(job.schema) && "data" in job.schema ? job.schema.data : undefined),
			"async-result",
		);
	}

	/** Common delivery path for a terminal job row from `async-result` or a wait snapshot. */
	async #observeJobDelivery(
		tracked: TrackedAttempt,
		fact: AsyncJobFact,
		observedAt: number,
		answer: DeliveredAnswer,
		channel: "async-result" | "wait-result",
	): Promise<void> {
		const registry = tracked.registry === undefined ? undefined : this.#registryCapture(tracked.registry);
		const retry = this.#retryOf(tracked);
		const report = asyncAttemptReport(this.#subject(tracked), {
			channel,
			observedAt,
			job: fact,
			hostVersion: HOST_VERSION,
		}, {
			...(registry === undefined ? {} : { registry }),
			...(tracked.admissionPatch === undefined ? {} : { admissionPatch: tracked.admissionPatch }),
			requirePatch: tracked.requiresPatch,
			...(retry === undefined ? {} : { retryAttempt: retry }),
		});
		if (!this.#deliveryBelongs(tracked, report)) return;
		if (tracked.requiresPatch && report.capture !== "observed" && waitablePatch(report.captureError)) {
			this.#holdAsync(tracked, fact, observedAt, answer, channel);
			return;
		}
		await this.#settleReport(tracked, report, answer);
	}

	/** Hold an isolated async delivery until its registry patch arrives; the timeout fails it closed. */
	#holdAsync(
		tracked: TrackedAttempt,
		job: AsyncJobFact,
		observedAt: number,
		answer: DeliveredAnswer,
		channel: "async-result" | "wait-result",
	): void {
		if (tracked.pending !== undefined) return;
		const pending: PendingAsync = { job, observedAt, channel, answer };
		pending.timer = setTimeout(() => {
			// The timer callback must not act for a replaced or stopped attempt.
			if (this.#tracked.get(tracked.spawnKey) !== tracked || this.#stopped) return;
			void this.#settlePending(tracked, true);
		}, this.#waitMs);
		pending.timer.unref?.();
		tracked.pending = pending;
	}

	#clearPending(tracked: TrackedAttempt): void {
		if (tracked.pending?.timer !== undefined) clearTimeout(tracked.pending.timer);
		delete tracked.pending;
	}

	async #settlePending(tracked: TrackedAttempt, timedOut: boolean): Promise<void> {
		const pending = tracked.pending;
		if (pending === undefined || tracked.settled) return;
		this.#clearPending(tracked);
		const registry = tracked.registry === undefined ? undefined : this.#registryCapture(tracked.registry);
		const retry = this.#retryOf(tracked);
		const report = asyncAttemptReport(this.#subject(tracked), {
			channel: pending.channel,
			observedAt: pending.observedAt,
			job: pending.job,
			hostVersion: HOST_VERSION,
		}, {
			...(registry === undefined ? {} : { registry }),
			...(tracked.admissionPatch === undefined ? {} : { admissionPatch: tracked.admissionPatch }),
			requirePatch: tracked.requiresPatch,
			...(retry === undefined ? {} : { retryAttempt: retry }),
		});
		if (timedOut && !this.#deliveryBelongs(tracked, report)) {
			await this.#settleReport(
				tracked,
				missingAttemptReport(this.#subject(tracked), {
					channel: pending.channel,
					observedAt: this.#now(),
					hostVersion: HOST_VERSION,
					reason: "patch-artifact-missing",
				}),
				pending.answer,
			);
			return;
		}
		await this.#settleReport(tracked, report, pending.answer);
	}

	async #observeRegistry(event: AttemptRegistryEvent): Promise<void> {
		if (this.#stopped) return;
		const tracked = this.#tracked.get(event.ref.id);
		if (tracked === undefined || tracked.settled) return;
		const observedAt = this.#now();
		if (observedAt < tracked.startedAt) return;
		// A later status event may report no session/home or no history; the earlier post-admission facts still belong
		// to this child. Never invent one, but do not lose a metadata path to a later lifecycle event.
		const prior = tracked.registry;
		const home = registryHome(event.ref) ?? prior?.home;
		const parentId = event.ref.parentId ?? prior?.parentId;
		const outputPath = declaredPath(event.ref.history?.outputPath) ?? prior?.outputPath;
		const patchPath = declaredPath(event.ref.history?.patchPath) ?? prior?.patchPath;
		const artifacts: HostArtifactCapture[] = [];
		if (outputPath !== undefined) artifacts.push(await captureArtifact(tracked.spawnKey, "output", outputPath, observedAt));
		if (patchPath !== undefined) artifacts.push(await captureArtifact(tracked.spawnKey, "patch", patchPath, observedAt));
		const observation: RegistryObservation = {
			event: event.type,
			observedAt,
			id: event.ref.id,
			artifacts,
			...(parentId === undefined ? {} : { parentId }),
			...(home === undefined ? {} : { home }),
			...(outputPath === undefined ? {} : { outputPath }),
			...(patchPath === undefined ? {} : { patchPath }),
		};
		tracked.registry = observation;
		const patch = artifacts.find(artifact => artifact.kind === "patch");
		if (patch?.exists === true && patch.digest !== undefined) tracked.lastPatch = patch;
		if (tracked.pending === undefined) return;
		const registry = this.#registryCapture(observation);
		const pending = tracked.pending;
		const retry = this.#retryOf(tracked);
		const report = asyncAttemptReport(this.#subject(tracked), {
			channel: pending.channel,
			observedAt: pending.observedAt,
			job: pending.job,
			hostVersion: HOST_VERSION,
		}, {
			registry,
			...(tracked.admissionPatch === undefined ? {} : { admissionPatch: tracked.admissionPatch }),
			requirePatch: tracked.requiresPatch,
			...(retry === undefined ? {} : { retryAttempt: retry }),
		});
		if (report.capture === "observed") {
			await this.#settleReport(tracked, report, pending.answer);
			return;
		}
		if (waitablePatch(report.captureError)) return;
		// A wrong parent, wrong child, empty patch or missing baseline cannot be fixed by another registry event.
		await this.#settleReport(tracked, report, pending.answer);
	}

	#registryCapture(observation: RegistryObservation): RegistryCapture {
		return {
			channel: "registry",
			observedAt: observation.observedAt,
			event: observation.event,
			id: observation.id,
			...(observation.parentId === undefined ? {} : { parentId: observation.parentId }),
			...(observation.home === undefined ? {} : { home: observation.home }),
			...(observation.outputPath === undefined && observation.patchPath === undefined
				? {}
				: {
						history: {
							...(observation.outputPath === undefined ? {} : { outputPath: observation.outputPath }),
							...(observation.patchPath === undefined ? {} : { patchPath: observation.patchPath }),
						},
					}),
			artifacts: observation.artifacts,
			hostVersion: HOST_VERSION,
		};
	}

	async #settleMissing(tracked: TrackedAttempt, observedAt: number): Promise<void> {
		if (tracked.settled) return;
		await this.#settleReport(
			tracked,
			missingAttemptReport(this.#subject(tracked), {
				channel: "task-result",
				observedAt,
				hostVersion: HOST_VERSION,
				reason: "native-result-missing",
			}),
			NO_ANSWER,
		);
	}

	/**
	 * The answer text a settlement carries. A cut delivery is replaced by the whole output read from the host's output
	 * file for this agent (the delivery's own path, else the registry's); when that cannot be read safely the cut text
	 * stays and is marked partial, so it is judged only by review with the agent's handle, never accepted or failed.
	 */
	async #wholeAnswer(tracked: TrackedAttempt, answer: DeliveredAnswer): Promise<{ text?: string; partial: boolean }> {
		const delivered = answer.text === undefined ? {} : { text: answer.text };
		if (answer.cut === undefined) return { ...delivered, partial: false };
		const path = answer.outputPath ?? tracked.registry?.outputPath ?? declaredPath(this.#registry?.get(tracked.spawnKey)?.history?.outputPath);
		const whole = path === undefined ? undefined : await readWholeOutput(path, tracked.spawnKey, answer);
		return whole === undefined ? { ...delivered, partial: true } : { text: whole, partial: false };
	}

	/** The only settlement path. One dispatch settles once; a controller failure leaves it closed, never retried. */
	async #settleReport(tracked: TrackedAttempt, report: AttemptReport, answer: DeliveredAnswer): Promise<void> {
		if (tracked.settled) return;
		tracked.settled = true;
		this.#clearPending(tracked);
		delete tracked.retry;
		if (attemptUsable(report) && report.attemptId !== undefined) {
			if (!tracked.priorAttemptIds.includes(report.attemptId)) tracked.priorAttemptIds.push(report.attemptId);
			const patch = report.artifacts.find(artifact => artifact.kind === "patch");
			if (patch?.digest !== undefined) {
				tracked.lastPatch = {
					id: tracked.spawnKey,
					kind: "patch",
					path: patch.path,
					exists: true,
					...(patch.bytes === undefined ? {} : { bytes: patch.bytes }),
					digest: patch.digest,
					capturedAt: patch.capturedAt,
				};
			}
		}
		try {
			// Only a usable attempt's text can become evidence; nothing is read for a failed or unbound one.
			const final = attemptUsable(report) ? await this.#wholeAnswer(tracked, answer) : { ...(answer.text === undefined ? {} : { text: answer.text }), partial: false };
			const reportText = final.text;
			const citations = answerCitations(answer.data, reportText);
			await this.#deps.port.settle({
				runId: tracked.runId,
				lane: tracked.lane,
				spawnKey: tracked.spawnKey,
				parentId: tracked.parentId,
				dispatch: tracked.dispatch,
				startedAt: tracked.startedAt,
				observedAt: report.observedAt,
				report,
				...(reportText === undefined ? {} : { reportText }),
				...(final.partial ? { reportPartial: true as const } : {}),
				citations,
			});
		} catch {
			// The collector must never throw into an omp event handler. A missing record keeps the requirement pending.
		}
	}
}
