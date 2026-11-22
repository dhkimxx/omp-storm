/**
 * Resuming is offered only for a run this machine started. Run records live in the repository and can be committed
 * or rewritten by anyone; the pointer beside the repo's approvals is outside it, so a planted record is not a run.
 *
 * The pointer for one work tree is a bounded collection, not just the last start: a later quick or read-only run must
 * not hide an interrupted substantive one. It is read as the 0.14 single-entry object `{runId, requestSha256}` and is
 * rewritten as a collection on the next start (one-direction upgrade: older Storm versions cannot read it back). The
 * stored fields are only what this machine knew at start; plan, status and request text still come from the run
 * record and stay untrusted, as before.
 */
import * as path from "node:path";
import { sha256Hex } from "../config/canonical.ts";
import { isRecord } from "../config/schema.ts";
import { readJson, serialized, writeJsonAtomic } from "../fsutil.ts";
import { runSpec, type SpecResult } from "../request/args.ts";
import type { RunRecord } from "../types.ts";
import { isRunId, readRun, resumableRun, RUN_KEEP } from "./run.ts";

/**
 * `<storeDir>/resume-<16 hex>.json` of the runs this machine started in `root`. The store is shared by every work
 * tree of the repository, so the name carries a short hash of the work tree's root path.
 */
export function resumePointerFile(storeDir: string, root: string): string {
	return path.join(storeDir, `resume-${sha256Hex(root).slice(0, 16)}.json`);
}

const POINTERS_SCHEMA = "storm.resume-pointers/v1";
/** Entries kept; the same bound as run records, so a pointer does not outlive the record it names. */
export const RESUME_POINTERS_MAX = RUN_KEEP;
const SHA256 = /^[0-9a-f]{64}$/;

interface ResumeEntry {
	runId: string;
	requestSha256: string;
	/** When this machine recorded the start: trusted ordering, unlike the repository record's timestamp. */
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
	const startedAt = value.startedAt;
	if (startedAt !== undefined && (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt)))) return undefined;
	const resumeOf = value.resumeOf;
	if (resumeOf !== undefined && (typeof resumeOf !== "string" || !isRunId(resumeOf))) return undefined;
	return {
		runId: value.runId,
		requestSha256,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(resumeOf !== undefined ? { resumeOf } : {}),
	};
}

/**
 * The entries of a pointer file. An `entries` (or `runs`) array is this version's collection shape; a foreign schema
 * is ignored rather than imported. A file with no schema and no such array is the 0.14 single entry `{runId,
 * requestSha256}`. Unknown fields never carry plan, task or scope into the handoff.
 */
function entriesOf(value: unknown): ResumeEntry[] {
	if (!isRecord(value)) return [];
	let raw: unknown[];
	if (value.schema !== undefined && value.schema !== POINTERS_SCHEMA) raw = [];
	else if (Array.isArray(value.entries)) raw = value.entries;
	else if (Array.isArray(value.runs)) raw = value.runs;
	else if (value.schema === undefined) raw = [value];
	else raw = [];
	const byId = new Map<string, ResumeEntry>();
	for (const item of raw) {
		const entry = entryOf(item);
		if (entry) byId.set(entry.runId, entry);
	}
	return [...byId.values()];
}

/** The pointer was written here for this exact run and this exact retained request. */
function matches(entry: ResumeEntry, run: RunRecord): boolean {
	return run.runId === entry.runId && typeof run.request === "string" && sha256Hex(run.request) === entry.requestSha256;
}

interface LiveEntry {
	entry: ResumeEntry;
	run: RunRecord | undefined;
	trusted: boolean;
}

async function liveEntries(storeDir: string, root: string): Promise<LiveEntry[]> {
	const entries = entriesOf(await readJson(resumePointerFile(storeDir, root)));
	return Promise.all(
		entries.map(async entry => {
			const run = await readRun(root, entry.runId);
			return { entry, run, trusted: run !== undefined && matches(entry, run) };
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
 * run over that quick probe. Old runs with no typed plan can still be substantive when they spawned workers.
 */
function durableRun(item: { entry: ResumeEntry; run: RunRecord }): boolean {
	const { entry, run } = item;
	const lanes = run.plan?.lanes;
	return (
		entry.resumeOf !== undefined ||
		(Array.isArray(lanes)
			? lanes.length > 1 || lanes.some(lane => isRecord(lane) && lane.kind !== "explore")
			: run.spawns.length > 0 || run.endReason === undefined) ||
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
 * The newest unfinished run this machine started in `root` that is still worth continuing. It scans every trusted
 * entry, not only the newest run record, so a later quick/read-only run does not hide an interrupted substantive one;
 * a later trusted continuation supersedes its parent. Run records stay untrusted: without an entry whose request hash
 * matches, nothing is offered.
 */
export async function findResumeCandidate(storeDir: string, root: string): Promise<(RunRecord & { request: string }) | undefined> {
	const live = await liveEntries(storeDir, root);
	const blocked = superseded(live);
	const candidates: Array<{ entry: ResumeEntry; run: RunRecord & { request: string } }> = [];
	for (const item of live) {
		const run = item.run;
		if (!item.trusted || run === undefined || !resumableRun(run)) continue;
		if (blocked.has(run.runId)) continue;
		candidates.push({ entry: item.entry, run });
	}
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => startKey(a) - startKey(b) || a.entry.runId.localeCompare(b.entry.runId));
	const substantive = candidates.filter(durableRun);
	return (substantive.length ? substantive : candidates).at(-1)?.run;
}

/**
 * Run ids normal retention must not delete: this machine's running runs, every trusted unfinished run, and every
 * trusted continuation. A continuation's record says whether it superseded its parent or failed before the handoff;
 * pruning it early would resurrect the parent as a resume candidate.
 */
export async function protectedResumeRunIds(storeDir: string, root: string): Promise<string[]> {
	const live = await liveEntries(storeDir, root);
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
async function trimResumeEntries(root: string, entries: ResumeEntry[], keepId: string): Promise<ResumeEntry[]> {
	if (entries.length <= RESUME_POINTERS_MAX) return entries;
	const live = await Promise.all(
		entries.map(async (entry, index) => {
			const run = await readRun(root, entry.runId);
			return { entry, index, run, trusted: run !== undefined && matches(entry, run) };
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

/**
 * Records the run this machine started in `root`, with the request the resume block will send. An existing 0.14
 * single-entry pointer is kept as an entry of the collection rather than overwritten.
 */
export function noteResumePointer(storeDir: string, root: string, run: RunRecord): Promise<void> {
	const file = path.resolve(resumePointerFile(storeDir, root));
	return serialized(file, async () => {
		const current = entriesOf(await readJson(file));
		const entry: ResumeEntry = {
			runId: run.runId,
			requestSha256: sha256Hex(run.request ?? ""),
			...(Number.isFinite(Date.parse(run.startedAt)) ? { startedAt: run.startedAt } : {}),
			...(run.resumeOf !== undefined && isRunId(run.resumeOf) ? { resumeOf: run.resumeOf } : {}),
		};
		const merged = [...current.filter(item => item.runId !== entry.runId), entry];
		const kept = await trimResumeEntries(root, merged, entry.runId);
		await writeJsonAtomic(file, { schema: POINTERS_SCHEMA, entries: kept });
	});
}

/** The pointer names this run and its request is byte-for-byte the one the machine started it with. */
export async function trustedResume(storeDir: string, root: string, run: RunRecord): Promise<boolean> {
	const entries = entriesOf(await readJson(resumePointerFile(storeDir, root)));
	return entries.some(entry => matches(entry, run));
}

/**
 * The given run when it stopped unfinished and this machine can prove it started it in `root`; otherwise nothing.
 * A caller that only has the newest run record should use `findResumeCandidate`, which scans the collection.
 */
export async function resumeCandidate(
	storeDir: string,
	root: string,
	run: RunRecord | undefined,
): Promise<(RunRecord & { request: string }) | undefined> {
	if (!resumableRun(run)) return undefined;
	return (await trustedResume(storeDir, root, run)) ? run : undefined;
}

/** A resume spec goes through `runSpec` like a typed request, so its limits are checked the same way. */
export function resumeSpec(run: RunRecord & { request: string }, said?: string): SpecResult {
	const result = runSpec(run.request, run.limits, run.runId);
	if (!result.ok) return result;
	return { ok: true, spec: { ...result.spec, ...(said ? { resumeNote: said } : {}) } };
}
