/**
 * Resuming is offered only for a run this machine started in the same native session and on the same target. The
 * pointer lives in the session's own profile store; run records themselves are never authority for a resume. A
 * pointer entry also names the canonical target it was recorded for, so a session that moved to another work tree
 * cannot replay an old run's plan or results there.
 *
 * The pointer collection is bounded, not just the last start: a later quick or read-only run must not hide an
 * interrupted substantive one. The stored fields are only what this machine knew at start; plan, status and request
 * text still come from the run record and stay untrusted. No older pointer shape is imported.
 */
import * as path from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import { isRecord } from "../config/schema.ts";
import { readJson, serialized, writeJsonAtomic } from "../fsutil.ts";
import { assertSessionPathSafe } from "../session-scope.ts";
import { runSpec, type SpecResult } from "../request/args.ts";
import type { RunRecord } from "../types.ts";
import { isRunId, readRun, resumableRun, RUN_KEEP, stateDir } from "./run.ts";

/** The canonical target an entry belongs to: the repo identity and the actual worktree top level. */
export interface ResumeTarget {
	repoId: string;
	root: string;
}

/** `<sessionDir>/state/resume.json`: one session's own bounded collection of started runs. */
export function resumePointerFile(sessionDir: string): string {
	return path.join(stateDir(sessionDir), "resume.json");
}

const POINTERS_SCHEMA = "storm.resume-pointers/v2";
/** Entries kept; the same bound as run records, so a pointer does not outlive the record it names. */
export const RESUME_POINTERS_MAX = RUN_KEEP;
const SHA256 = /^[0-9a-f]{64}$/;

interface ResumeEntry {
	runId: string;
	requestSha256: string;
	/** The target this start was recorded for; a resume on another target is not this run's. */
	repoId: string;
	root: string;
	/** When this machine recorded the start: trusted ordering, unlike the session store record's timestamp. */
	startedAt?: string;
	/** The run this one was started to continue, as recorded at start; used only to supersede, never for scope. */
	resumeOf?: string;
}

/** One entry, with unknown and malformed fields rejected rather than carried forward. */
function entryOf(value: unknown): ResumeEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.runId !== "string" || !isRunId(value.runId)) return undefined;
	if (typeof value.requestSha256 !== "string") return undefined;
	const requestSha256 = value.requestSha256.toLowerCase();
	if (!SHA256.test(requestSha256)) return undefined;
	const { repoId, root } = value;
	if (typeof repoId !== "string" || repoId.length === 0) return undefined;
	if (typeof root !== "string" || !path.isAbsolute(root)) return undefined;
	const startedAt = value.startedAt;
	if (startedAt !== undefined && (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt)))) return undefined;
	const resumeOf = value.resumeOf;
	if (resumeOf !== undefined && (typeof resumeOf !== "string" || !isRunId(resumeOf))) return undefined;
	return {
		runId: value.runId,
		requestSha256,
		repoId,
		root,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(resumeOf !== undefined ? { resumeOf } : {}),
	};
}

/**
 * The entries of this version's pointer file. A foreign schema, a torn file, or the retired single-entry shape is
 * ignored rather than imported. Unknown fields never carry plan, task or scope into the handoff.
 */
function entriesOf(value: unknown): ResumeEntry[] {
	if (!isRecord(value) || value.schema !== POINTERS_SCHEMA || !Array.isArray(value.entries)) return [];
	const byId = new Map<string, ResumeEntry>();
	for (const item of value.entries) {
		const entry = entryOf(item);
		if (entry) byId.set(entry.runId, entry);
	}
	return [...byId.values()];
}

/** This store's run is the one the pointer recorded with this exact retained request. */
function requestMatches(entry: ResumeEntry, run: RunRecord): boolean {
	return run.runId === entry.runId && typeof run.request === "string" && sha256Hex(run.request) === entry.requestSha256;
}

/** The pointer was written here for this exact run, this exact retained request and this exact target. */
function matches(entry: ResumeEntry, run: RunRecord, target: ResumeTarget): boolean {
	return entry.repoId === target.repoId && entry.root === target.root && requestMatches(entry, run);
}

interface LiveEntry {
	entry: ResumeEntry;
	run: RunRecord | undefined;
	trusted: boolean;
}

async function readPointerEntries(sessionDir: string): Promise<ResumeEntry[]> {
	const file = resumePointerFile(sessionDir);
	await assertSessionPathSafe(sessionDir, file);
	return entriesOf(await readJson(file));
}

async function liveEntries(sessionDir: string): Promise<LiveEntry[]> {
	const entries = await readPointerEntries(sessionDir);
	return Promise.all(
		entries.map(async entry => {
			const run = await readRun(sessionDir, entry.runId);
			return { entry, run, trusted: run !== undefined && requestMatches(entry, run) };
		}),
	);
}

/**
 * Runs a later locally-recorded continuation replaced. A start-failed attempt never replaced its parent: no handoff
 * reached the director, so the earlier run is still the work to continue.
 */
function superseded(live: readonly LiveEntry[]): Set<string> {
	const out = new Set<string>();
	for (const { entry, run, trusted } of live) {
		if (!trusted || entry.resumeOf === undefined) continue;
		if (run?.endReason === "start-failed") continue;
		out.add(entry.resumeOf);
	}
	return out;
}

/**
 * A stopped one-lane lookup can have a plan and a worker too. Prefer a continuing, writing, design or verification
 * run over that quick probe. Runs with no typed plan can still be substantive when they spawned workers.
 */
function durableRun(item: { entry: ResumeEntry; run: RunRecord }): boolean {
	const { entry, run } = item;
	const lanes = run.plan?.lanes;
	return (
		entry.resumeOf !== undefined ||
		(Array.isArray(lanes)
			? lanes.length > 1 || lanes.some(lane => isRecord(lane) && lane.kind !== "explore")
			: run.spawns.length > 0 || run.endReason === undefined || run.endReason === "host-ended") ||
		(run.checkpoints?.length ?? 0) > 0 ||
		(run.blockedEdits ?? 0) > 0 ||
		(run.blockedFollowUps ?? 0) > 0
	);
}

function startKey(item: { entry: ResumeEntry; run: RunRecord | undefined }): number {
	const text = item.entry.startedAt ?? item.run?.startedAt;
	const at = text === undefined ? Number.NaN : Date.parse(text);
	return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * The newest unfinished run this machine started in this session on `target` and that is still worth continuing. It
 * scans every trusted entry, not only the newest run record, so a later quick/read-only run does not hide an
 * interrupted substantive one; a later trusted continuation supersedes its parent. Without an entry whose target and
 * request hash match, nothing is offered, even if a run record sits in the store.
 */
export async function findResumeCandidate(
	sessionDir: string,
	target: ResumeTarget,
): Promise<(RunRecord & { request: string }) | undefined> {
	const live = await liveEntries(sessionDir);
	const blocked = superseded(live);
	const candidates: Array<{ entry: ResumeEntry; run: RunRecord & { request: string } }> = [];
	for (const item of live) {
		const run = item.run;
		if (!item.trusted || run === undefined || !resumableRun(run)) continue;
		if (!matches(item.entry, run, target)) continue;
		if (blocked.has(run.runId)) continue;
		candidates.push({ entry: item.entry, run });
	}
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => startKey(a) - startKey(b) || a.entry.runId.localeCompare(b.entry.runId));
	const substantive = candidates.filter(durableRun);
	return (substantive.length ? substantive : candidates).at(-1)?.run;
}

/**
 * Run ids normal retention must not delete: this session's running runs, every trusted unfinished run, and every
 * trusted continuation, whichever target it was recorded for. A continuation's record says whether it superseded its
 * parent or failed before the handoff; pruning it early would resurrect the parent as a resume candidate. This only
 * reads this session's own store, never another session's records.
 */
export async function protectedResumeRunIds(sessionDir: string): Promise<string[]> {
	const live = await liveEntries(sessionDir);
	const out = new Set<string>();
	for (const item of live) {
		const run = item.run;
		if (!item.trusted || run === undefined) continue;
		if (run.status === "running" || resumableRun(run) || item.entry.resumeOf !== undefined) out.add(run.runId);
	}
	return [...out];
}

/**
 * Keeps the collection bounded without dropping what still matters: the run just noted, running records, unresolved
 * candidates, then continuations, unfinished and finished entries, oldest last. Records are read only when the bound
 * is exceeded.
 */
async function trimResumeEntries(sessionDir: string, entries: ResumeEntry[], keepId: string): Promise<ResumeEntry[]> {
	if (entries.length <= RESUME_POINTERS_MAX) return entries;
	const live = await Promise.all(
		entries.map(async (entry, index) => {
			const run = await readRun(sessionDir, entry.runId);
			return { entry, index, run, trusted: run !== undefined && requestMatches(entry, run) };
		}),
	);
	const blocked = superseded(live);
	const priorityOf = (item: (typeof live)[number]): number => {
		const { entry, run, trusted } = item;
		if (entry.runId === keepId) return 6;
		if (!trusted || run === undefined) return 0;
		if (run.status === "running") return 5;
		if (resumableRun(run) && !blocked.has(run.runId)) return 4;
		if (entry.resumeOf !== undefined) return 3;
		if (run.status === "stopped" || run.status === "budget-exceeded") return 2;
		return 1;
	};
	const kept = new Set(
		live
			.sort((a, b) => priorityOf(b) - priorityOf(a) || b.index - a.index)
			.slice(0, RESUME_POINTERS_MAX)
			.map(item => item.entry.runId),
	);
	// File order is start order: the newest entry stays last, like the run ids.
	return entries.filter(entry => kept.has(entry.runId));
}

/** Records the run this machine started in this session for `target`, with the request the resume block will send. */
export function noteResumePointer(sessionDir: string, target: ResumeTarget, run: RunRecord): Promise<void> {
	const file = path.resolve(resumePointerFile(sessionDir));
	return serialized(file, async () => {
		await assertSessionPathSafe(sessionDir, file);
		const current = entriesOf(await readJson(file));
		const entry: ResumeEntry = {
			runId: run.runId,
			requestSha256: sha256Hex(run.request ?? ""),
			repoId: target.repoId,
			root: target.root,
			...(Number.isFinite(Date.parse(run.startedAt)) ? { startedAt: run.startedAt } : {}),
			...(run.resumeOf !== undefined && isRunId(run.resumeOf) ? { resumeOf: run.resumeOf } : {}),
		};
		const merged = [...current.filter(item => item.runId !== entry.runId), entry];
		const kept = await trimResumeEntries(sessionDir, merged, entry.runId);
		await assertSessionPathSafe(sessionDir, file);
		await writeJsonAtomic(file, { schema: POINTERS_SCHEMA, entries: kept });
	});
}

/** The pointer names this run, its request and `target` byte-for-byte as the machine recorded them. */
export async function trustedResume(sessionDir: string, target: ResumeTarget, run: RunRecord): Promise<boolean> {
	const entries = await readPointerEntries(sessionDir);
	return entries.some(entry => matches(entry, run, target));
}

/**
 * The given run when it stopped unfinished and this machine can prove it started it in this session on `target`;
 * otherwise nothing. A caller that only has the newest run record should use `findResumeCandidate`.
 */
export async function resumeCandidate(
	sessionDir: string,
	target: ResumeTarget,
	run: RunRecord | undefined,
): Promise<(RunRecord & { request: string }) | undefined> {
	if (!resumableRun(run)) return undefined;
	return (await trustedResume(sessionDir, target, run)) ? run : undefined;
}

/** What the task of a continued run says about one lane, and the whole task's bound. */
const TASK_LANE_CHARS = 160;
const TASK_CHARS = 1_800;

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The task a continued run carries. A run opened under automatic delegation records the user's chat message of that
 * turn as its request, and that can be a question ("작업현황") or "go on": it names no work. What the run was for is in
 * its plan, which the director wrote and the checkpoint carries, so a plan with lanes states the task: each lane with
 * its goal, else the first result it owes. The earlier request follows, marked as the earlier request: for a run the
 * user typed it is the user's own wording of the work (constraints included), for a chat turn it is only background,
 * and the task never leads with it either way. A continuation of a continuation keeps the original request, not the
 * generated text around it. Without a plan the request is all there is.
 */
export function continuationTask(run: RunRecord & { request: string }): string {
	const lanes = Array.isArray(run.plan?.lanes) ? run.plan.lanes : [];
	const lines: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const lane of lanes) {
		if (!isRecord(lane) || typeof lane.name !== "string" || lane.name.trim() === "") continue;
		const first = Array.isArray(lane.results) ? lane.results.find(result => isRecord(result) && typeof result.criterion === "string") : undefined;
		const said = typeof lane.goal === "string" && lane.goal.trim() !== "" ? lane.goal : isRecord(first) ? String(first.criterion) : "";
		const line = `- ${oneLine(lane.name, 80)}${said === "" ? "" : `: ${oneLine(said, TASK_LANE_CHARS)}`}`;
		if (used + line.length > TASK_CHARS) {
			omitted += 1;
			continue;
		}
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return run.request;
	const earlier = earlierRequestOf(run.request);
	return [
		CONTINUATION_HEAD,
		...lines,
		...(omitted > 0 ? [`- 외 ${omitted}개`] : []),
		...(earlier === "" ? [] : ["", EARLIER_REQUEST_MARKER, earlier]),
	].join("\n");
}

/** First line of a generated continuation task, and the line that introduces the earlier request inside it. */
export const CONTINUATION_HEAD = "이전 실행의 계획 범위를 이어서 끝냅니다. 레인과 목표:";
export const EARLIER_REQUEST_MARKER = "이전 요청(참고용 원문):";
const EARLIER_REQUEST_CHARS = 4_000;

/** The request as the user's turn or command wrote it: what follows the marker of a generated task, else the request. */
function earlierRequestOf(request: string): string {
	const at = request.startsWith(CONTINUATION_HEAD) ? request.indexOf(`\n${EARLIER_REQUEST_MARKER}\n`) : -1;
	const original = at < 0 ? (request.startsWith(CONTINUATION_HEAD) ? "" : request) : request.slice(at + EARLIER_REQUEST_MARKER.length + 2);
	const flat = original.trim();
	return flat.length > EARLIER_REQUEST_CHARS ? `${flat.slice(0, EARLIER_REQUEST_CHARS - 1)}…` : flat;
}

/**
 * A resume spec goes through `runSpec` like a typed request, so its limits are checked the same way. Its task is the
 * work (`continuationTask`), whoever asks and however: the `/storm` menu, the closeout card and the director's own
 * `continue` all start from this one function.
 */
export function resumeSpec(run: RunRecord & { request: string }, said?: string): SpecResult {
	const result = runSpec(continuationTask(run), run.limits, run.runId);
	if (!result.ok) return result;
	return { ok: true, spec: { ...result.spec, ...(said ? { resumeNote: said } : {}) } };
}
