/**
 * Run-end janitor: Storm code, not an LLM worker. It trims this session's own stores to their limits and, only when
 * the team approved `cleanup`, removes the omp records (transcripts, sidecars, tombstones, nested transcripts) of
 * parked subagents of older Storm runs. Outputs (`*.md`) always stay, so `agent://<id>` keeps answering.
 *
 * Every Storm path here comes from the captured native session's store, never from the target work tree, the current
 * cwd or another session. Deletion candidates come only from that store's trusted list (`<sessionDir>/state/runs.jsonl`),
 * which only this machine's Storm writes at run end. Reset and retention never enumerate another session's artifacts.
 */
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonl, serialized, writeTextAtomic } from "../fsutil.ts";
import { assertSessionPathSafe } from "../session-scope.ts";
import type { AgentEntry, CleanupResult, RunRecord, StorageDetailLine, StormConfig } from "../types.ts";
import { readRun, runIds, stateDir, writeRun } from "./run.ts";
import { pruneTrialStates } from "./state-files.ts";

/** Runs whose subagent records stay for result checks and analysis, newest first. */
export const KEEP_RECENT_RUNS = 3;
/** Trusted run entries kept per repo. */
export const TRUSTED_RUNS_MAX = 200;

/** The approval store's limit step, as the janitor needs it (`ApprovalStore.prune`). */
export interface ApprovalPrunePort {
	prune(keepHash: string | null): Promise<number>;
}

/** One line of `<sessionDir>/state/runs.jsonl`: a Storm run this session ran, and where its subagents' records live. */
export interface TrustedRun {
	runId: string;
	/** The main session's artifacts dir (`<session>/`), beside its `<session>.jsonl`. */
	artifactsDir: string;
	/** `processKey()` of the omp process that ran it. */
	process: string;
	/** Subagent ids of the run. */
	agents: string[];
	/** ISO 8601. */
	endedAt: string;
	/** Ids whose omp records the janitor removed. */
	cleaned?: string[];
}

export interface JanitorInput {
	/** The captured native session's own store: run records, index, trial counters and the trusted cleanup list. */
	sessionDir: string;
	/** `<agentDir>/sessions`: an artifacts dir is accepted only below it. */
	sessionsRoot: string;
	/** The approved config in force at run end. */
	config: StormConfig;
	/** The config the ended run started with. omp records go only when both have `cleanup: true`. */
	startConfig: StormConfig;
	/** The approved hash in force; its snapshot and record always stay. */
	configHash: string | null;
	/** The run that just ended; never cleaned. */
	runId: string;
	/** `processKey()` of this process. */
	process: string;
	now: number;
	/** This process's agent ledger (`listAgents()`): agents in it that are not parked are live and never cleaned. */
	ledger: readonly AgentEntry[];
	approvals?: ApprovalPrunePort;
	/** Whether the omp process of a `processKey()` may still run; defaults to a signal-0 probe of its pid. */
	alive?: (key: string) => boolean;
}

export interface JanitorOutput {
	result: CleanupResult;
	/** Cleaned ids from runs of this process only: the ones to pass to `markAgentsCleaned`. */
	cleaned: string[];
}

/** "<pid>:<process start ms>": tells this omp process apart from earlier ones, even when a pid is reused. */
export function processKey(): string {
	return `${process.pid}:${Math.round(performance.timeOrigin)}`;
}

/** Whether the process of a key may still be running; a dead or unparsable key is not alive. */
function processAlive(key: string): boolean {
	const pid = Number(key.split(":")[0]);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const RECORD_SUFFIXES = [".jsonl", ".json", ".jsonl.tombstone"] as const;
const AGENT_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
/** Top-level names under an artifacts dir that are not subagents: `local/` is the main session's `local://` root. */
const RESERVED_IDS: Record<string, true> = { local: true };

interface RecordFile {
	file: string;
	bytes: number;
}

async function lstatOrUndefined(file: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(file);
	} catch {
		return undefined;
	}
}

// ── Trusted run list ──────────────────────────────────────────────────────────

function trustedRunsFile(sessionDir: string): string {
	return path.join(stateDir(sessionDir), "runs.jsonl");
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");

function isTrustedRun(value: unknown): value is TrustedRun {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.runId === "string" &&
		typeof v.artifactsDir === "string" &&
		path.isAbsolute(v.artifactsDir) &&
		typeof v.process === "string" &&
		isStringArray(v.agents) &&
		typeof v.endedAt === "string" &&
		(v.cleaned === undefined || isStringArray(v.cleaned))
	);
}

/** Trusted runs of this session, oldest first; torn or foreign lines are skipped. */
export async function readTrustedRuns(sessionDir: string): Promise<TrustedRun[]> {
	const file = trustedRunsFile(sessionDir);
	await assertSessionPathSafe(sessionDir, file);
	return readJsonl(file, isTrustedRun);
}

function updateTrustedRuns(sessionDir: string, update: (runs: TrustedRun[]) => TrustedRun[]): Promise<void> {
	const file = path.resolve(trustedRunsFile(sessionDir));
	return serialized(file, async () => {
		const next = update(await readTrustedRuns(sessionDir)).slice(-TRUSTED_RUNS_MAX);
		await assertSessionPathSafe(sessionDir, file);
		await writeTextAtomic(file, next.map(r => `${JSON.stringify(r)}\n`).join(""));
	});
}

/**
 * Adds a run to this session's trusted list, keeping the newest `TRUSTED_RUNS_MAX`. A run already on it is replaced in
 * place (its age is its first recording) and the ids the janitor already cleaned for it stay cleaned.
 */
export function recordTrustedRun(sessionDir: string, entry: Omit<TrustedRun, "cleaned">): Promise<void> {
	return updateTrustedRuns(sessionDir, runs => {
		const next: TrustedRun = { ...entry, agents: [...entry.agents] };
		const at = runs.findIndex(r => r.runId === entry.runId);
		if (at < 0) return [...runs, next];
		const cleaned = runs[at]?.cleaned;
		if (cleaned?.length) next.cleaned = cleaned;
		return runs.map((r, i) => (i === at ? next : r));
	});
}

// ── Record files ──────────────────────────────────────────────────────────────

/**
 * The artifacts dir by realpath when it is a real directory strictly below `sessionsRoot` with its session
 * transcript `<dir>.jsonl` beside it; otherwise undefined.
 */
async function acceptedArtifactsDir(artifactsDir: string, sessionsRoot: string): Promise<string | undefined> {
	try {
		const [dir, sessions] = await Promise.all([fs.realpath(artifactsDir), fs.realpath(sessionsRoot)]);
		if (!dir.startsWith(`${sessions}${path.sep}`)) return undefined;
		if (!(await fs.lstat(dir)).isDirectory()) return undefined;
		return (await lstatOrUndefined(`${dir}.jsonl`))?.isFile() ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** Record files under `dir` whose names start with `prefix`, recursively; symlinks are never followed, `*.md` never listed. */
async function walkRecords(dir: string, prefix: string, out: RecordFile[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.name.startsWith(prefix) || entry.isSymbolicLink()) continue;
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) await walkRecords(file, prefix, out);
		else if (entry.isFile() && RECORD_SUFFIXES.some(suffix => entry.name.endsWith(suffix))) {
			const st = await lstatOrUndefined(file);
			if (st?.isFile()) out.push({ file, bytes: Number(st.size) });
		}
	}
}

/**
 * The omp record files of one subagent under its main session's artifacts dir: `X.jsonl`, `X.json`,
 * `X.jsonl.tombstone` and the record files inside `X/` named `X.…` (its nested agents). Dotted ids nest
 * (`A.B.C` → `A/A.B/A.B.C.*`). Reserved ids (`local`), anything behind a symlink and anything outside the
 * artifacts dir (by realpath) are never listed.
 */
export async function agentRecordFiles(artifactsDir: string, id: string): Promise<RecordFile[]> {
	if (!AGENT_ID.test(id) || RESERVED_IDS[id.split(".")[0] ?? ""]) return [];
	let base: string;
	try {
		base = await fs.realpath(artifactsDir);
	} catch {
		return [];
	}
	const parts = id.split(".");
	let dir = base;
	for (let i = 1; i < parts.length; i++) {
		dir = path.join(dir, parts.slice(0, i).join("."));
		if (!(await lstatOrUndefined(dir))?.isDirectory()) return [];
	}
	const out: RecordFile[] = [];
	for (const suffix of RECORD_SUFFIXES) {
		const file = path.join(dir, `${id}${suffix}`);
		const st = await lstatOrUndefined(file);
		if (st?.isFile()) out.push({ file, bytes: Number(st.size) });
	}
	const own = path.join(dir, id);
	if ((await lstatOrUndefined(own))?.isDirectory()) await walkRecords(own, `${id}.`, out);
	const inside = `${base}${path.sep}`;
	return out.filter(r => r.file.startsWith(inside));
}

// ── Janitor ───────────────────────────────────────────────────────────────────

/**
 * Run records still `running` whose process is gone (a crash, a kill) become `stopped`, ended at their last live
 * write: they then count as this session's last run instead of staying invisible. At session start no process is
 * named, so every record in this session's store is probed; at a run end the starting process is passed and its other
 * records are stale too. Records of other sessions are never read or written here.
 */
export interface DeadRunSweep {
	/** The captured session's store; only its `state/runs/` records are swept. */
	sessionDir: string;
	/** This process, at a run end: another record of it cannot be live (one run per session). */
	process?: string;
	/** The run that is ending: its record is not swept. */
	runId?: string;
	alive?: (key: string) => boolean;
}

export async function stopDeadRuns(input: DeadRunSweep): Promise<void> {
	const alive = input.alive ?? processAlive;
	for (const id of await runIds(input.sessionDir)) {
		if (id === input.runId) continue;
		const record = await readRun(input.sessionDir, id);
		if (record?.status !== "running") continue;
		// Without a named process every record is probed: a live one stays, a dead one is closed. A record of the named
		// process itself is stale (one run per session), so it is closed without a probe.
		if (record.process !== undefined && record.process !== input.process && alive(record.process)) continue;
		// A record of another, dead process (or one whose process was never named) ended with its host: say so, so a crash
		// is not read as the user stopping the run. The record stays exactly as resumable as a reasonless stop.
		// Only a stale record of the very process that is ending is not the host's death. A record that names no process
		// (older Storm, or a process the sweep was not told) is probed and closed here too, and its host is gone as well.
		const hostEnded = !(record.process !== undefined && record.process === input.process);
		await writeRun(input.sessionDir, {
			...record,
			status: "stopped",
			endedAt: record.updatedAt ?? record.startedAt,
			...(hostEnded && record.endReason === undefined ? { endReason: "host-ended" as const } : {}),
		});
	}
}

/**
 * Runs once at each run end: after the run joined the trusted list (`recordTrustedRun`), before its final record,
 * its index line and `pruneRuns` (the record carries this cleanup's result).
 * Storm limits always apply; omp records go only when the run's start config and the config in force both have
 * `cleanup: true`, and only for agents of trusted runs older than the newest `KEEP_RECENT_RUNS`.
 */
export async function runJanitor(input: JanitorInput): Promise<JanitorOutput> {
	const result: CleanupResult = { agents: 0, files: 0, bytes: 0, stormFiles: 0 };
	const cleaned: string[] = [];
	const alive = input.alive ?? processAlive;
	if (input.approvals) result.stormFiles += await input.approvals.prune(input.configHash);
	const trialIds = [...(input.config.trials ?? []), ...(input.startConfig.trials ?? [])].map(t => t.id);
	result.stormFiles += await pruneTrialStates(input.sessionDir, trialIds);
	await stopDeadRuns({
		sessionDir: input.sessionDir,
		process: input.process,
		runId: input.runId,
		...(input.alive ? { alive: input.alive } : {}),
	});
	if (input.config.cleanup !== true || input.startConfig.cleanup !== true) return { result, cleaned };

	// Same-process agents absent from the ledger were parked long ago (the ledger only drops parked entries).
	const live = input.ledger.filter(e => e.state !== "parked").map(e => e.id);
	const older = (await readTrustedRuns(input.sessionDir))
		.reverse()
		.slice(KEEP_RECENT_RUNS)
		.filter(r => r.runId !== input.runId);
	const done = new Map<string, string[]>();
	for (const run of older) {
		const sameProcess = run.process === input.process;
		// Another omp process that still runs may hold its agents in memory; B0 showed deleting those loses data.
		if (!sameProcess && alive(run.process)) continue;
		const dir = await acceptedArtifactsDir(run.artifactsDir, input.sessionsRoot);
		if (dir === undefined) continue;
		const already = new Set(run.cleaned ?? []);
		const ids: string[] = [];
		for (const id of run.agents) {
			if (already.has(id) || live.some(l => l === id || l.startsWith(`${id}.`))) continue;
			const records = await agentRecordFiles(dir, id);
			if (records.length === 0) continue;
			let failed = false;
			for (const record of records) {
				try {
					await fs.rm(record.file);
					result.files++;
					result.bytes += record.bytes;
				} catch {
					// Left for the next run end.
					failed = true;
				}
			}
			if (failed) continue;
			result.agents++;
			ids.push(id);
			if (sameProcess) cleaned.push(id);
		}
		if (ids.length) done.set(run.runId, ids);
	}
	if (done.size === 0) return { result, cleaned };
	await updateTrustedRuns(input.sessionDir, runs =>
		runs.map(r => {
			const ids = done.get(r.runId);
			return ids ? { ...r, cleaned: [...(r.cleaned ?? []), ...ids] } : r;
		}),
	);
	// Display only: this session's run records show which agents were cleaned.
	for (const [runId, ids] of done) {
		const record = await readRun(input.sessionDir, runId);
		if (!record?.agents) continue;
		const set = new Set(ids);
		await writeRun(input.sessionDir, {
			...record,
			agents: record.agents.map(a => (set.has(a.id) && a.cleanedAt === undefined ? { ...a, cleanedAt: input.now } : a)),
		});
	}
	return { result, cleaned };
}

// ── Storage line ──────────────────────────────────────────────────────────────

async function treeBytes(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let total = 0;
	for (const entry of entries) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) total += await treeBytes(file);
		else if (entry.isFile()) total += Number((await lstatOrUndefined(file))?.size ?? 0);
	}
	return total;
}

/** Newest run record of this session carrying a cleanup result; display only. */
async function lastCleanupRecord(sessionDir: string): Promise<RunRecord | undefined> {
	for (const id of (await runIds(sessionDir)).reverse()) {
		const run = await readRun(sessionDir, id);
		if (run?.cleanup) return run;
	}
	return undefined;
}

export interface StorageTally {
	files: number;
	bytes: number;
}

/** Child record files under a session dir: subagent transcripts and their sidecars, counted apart. */
export interface StorageFiles {
	transcripts: StorageTally;
	sidecars: StorageTally;
}

export type StorageGroup = "recent" | "live" | "unclassified" | "candidate" | "unknown";

/** What the inventory could not see. A zero next to a gap is not a measured zero. */
export interface StorageGaps {
	/** `<agentDir>/sessions` itself was unavailable, so no root could be validated. */
	sessionsRoot: boolean;
	/** The current project session dir was not named, missing, or rejected. */
	currentSession?: "unnamed" | "missing" | "invalid";
	/** The named project session dir's own entries were read. */
	project: boolean;
	/** Child dirs under the project session dir without a regular sibling parent transcript. */
	staleSessions: number;
	/** Trusted-run entries whose artifacts dir was missing or rejected. */
	trustRoots: number;
	/** Accepted roots whose top-level directory could not be read. */
	roots: number;
	/** Nested entries whose metadata could not be read. */
	entries: number;
	/** Symlinks skipped; they are never followed. */
	symlinks: number;
	/** Accepted roots whose top-level directory was read. */
	scanned: number;
}

export interface StorageView {
	/** This native session's Storm store: config, approvals for its target, runs, index and counters. */
	stormBytes: number;
	/** Distinct physical child record files under the scanned session roots. */
	total: StorageFiles;
	/** Disjoint classification of `total`; a protected owner wins over a cleanup candidate. */
	groups: Record<StorageGroup, StorageFiles>;
	/** `unclassified` files by the reason a candidate cannot be proven now. */
	unclassifiedReasons: { sameProcess: number; cleaned: number; other: number };
	/** Parent session transcripts (`<session>.jsonl`), never part of `total`. */
	parent?: StorageTally;
	/** `local://` spill files (`<session>/local/<n>.log`), never part of `total`. */
	spill?: StorageTally;
	gaps: StorageGaps;
	lastCleanup?: { at: string; result: CleanupResult };
}

export interface StorageReadOptions {
	/** The current native session's omp transcript/artifact dir (holding `<session>.jsonl` files and `<session>/` dirs). */
	ompSessionDir?: string;
	/** Whether the approved config currently permits cleanup; only then are older trusted records candidates. */
	cleanup?: boolean;
	/** This process; defaults to `processKey()`. */
	process?: string;
	/** Whether a process key may still run; defaults to a signal-0 probe. */
	alive?: (key: string) => boolean;
}

interface SessionsScope {
	/** The supplied path, used only to map an absolute artifacts dir to `real`. */
	given: string;
	/** Resolved sessions root: every accepted root is a regular dir below it, with no symlink component. */
	real: string;
}

interface AcceptedRoot {
	dir: string;
	key: string;
	parent: string;
	parentSize: number;
	parentKey: string;
}

type RootFailure = { reason: "missing" | "invalid" };

interface RunOwner {
	index: number;
	recent: boolean;
	live: boolean;
	sameProcess: boolean;
}

interface AgentOwner {
	id: string;
	run: RunOwner;
	cleaned: boolean;
}

interface FileOwner {
	run: RunOwner;
	cleaned: boolean;
}

interface RootPlan extends AcceptedRoot {
	agents: Map<string, AgentOwner[]>;
}

type RecordKind = "transcripts" | "sidecars";

interface InventoryRecord {
	kind: RecordKind;
	bytes: number;
	owners: Map<string, FileOwner>;
}

const newStorageFiles = (): StorageFiles => ({ transcripts: { files: 0, bytes: 0 }, sidecars: { files: 0, bytes: 0 } });

const addFile = (files: StorageFiles, kind: RecordKind, bytes: number): void => {
	files[kind].files++;
	files[kind].bytes += bytes;
};

const countFiles = (files: StorageFiles): StorageTally => ({
	files: files.transcripts.files + files.sidecars.files,
	bytes: files.transcripts.bytes + files.sidecars.bytes,
});

interface AcceptedDir {
	dir: string;
	key: string;
}

/** A real directory strictly below the profile sessions root, with no symlink component on the way. */
async function acceptedDirBelow(candidate: string, scope: SessionsScope): Promise<AcceptedDir | RootFailure> {
	if (!path.isAbsolute(candidate)) return { reason: "invalid" };
	const resolved = path.resolve(candidate);
	let relative: string | undefined;
	for (const base of new Set([scope.given, scope.real])) {
		const rel = path.relative(base, resolved);
		if (rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
			relative = rel;
			break;
		}
	}
	if (relative === undefined) return { reason: "invalid" };
	let dir = scope.real;
	let stat: Stats | undefined;
	for (const part of relative.split(path.sep)) {
		if (part === "") continue;
		dir = path.join(dir, part);
		stat = await lstatOrUndefined(dir);
		if (stat === undefined) return { reason: "missing" };
		if (stat.isSymbolicLink() || !stat.isDirectory()) return { reason: "invalid" };
	}
	if (stat === undefined) return { reason: "invalid" };
	return { dir, key: `${stat.dev}:${stat.ino}` };
}

/** Root accepted only when it is a regular dir strictly below the sessions root, with its regular parent transcript. */
async function acceptedInventoryRoot(candidate: string, scope: SessionsScope): Promise<AcceptedRoot | RootFailure> {
	const accepted = await acceptedDirBelow(candidate, scope);
	if ("reason" in accepted) return accepted;
	const parent = `${accepted.dir}.jsonl`;
	const parentStat = await lstatOrUndefined(parent);
	if (parentStat === undefined) return { reason: "missing" };
	if (!parentStat.isFile()) return { reason: "invalid" };
	return {
		...accepted,
		parent,
		parentSize: Number(parentStat.size),
		parentKey: `${parentStat.dev}:${parentStat.ino}`,
	};
}

/** The profile sessions root by realpath when it is a real directory; otherwise undefined. */
async function sessionsScope(sessionsRoot: string): Promise<SessionsScope | undefined> {
	try {
		const real = await fs.realpath(sessionsRoot);
		return (await fs.lstat(real)).isDirectory() ? { given: path.resolve(sessionsRoot), real } : undefined;
	} catch {
		return undefined;
	}
}

/** A child record name and its agent id, or undefined for a name omp's record layout does not describe. */
function recordMeta(name: string): { kind: RecordKind; id: string } | undefined {
	for (const suffix of RECORD_SUFFIXES) {
		if (!name.endsWith(suffix)) continue;
		const id = name.slice(0, -suffix.length);
		if (!AGENT_ID.test(id) || RESERVED_IDS[id.split(".")[0] ?? ""]) return undefined;
		return { kind: suffix === ".jsonl" ? "transcripts" : "sidecars", id };
	}
	return undefined;
}

/**
 * A record file sits in the cumulative id directories its name implies: `A/A.B/A.B.C.jsonl` for `A.B.C`. Advisor
 * transcripts are documented at any depth, so their parent dirs only need to be valid agent names.
 */
function recordPathMatches(dirParts: readonly string[], id: string): boolean {
	if (id === "__advisor" || id.startsWith("__advisor.")) {
		return dirParts.every(part => AGENT_ID.test(part) && !RESERVED_IDS[part.split(".")[0] ?? ""]);
	}
	const parts = id.split(".");
	const expected = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("."));
	return dirParts.length === expected.length && expected.every((part, i) => dirParts[i] === part);
}

/** Protection wins over a later group: a file owned by both a recent and an old run is protected. */
function storageGroup(owners: readonly FileOwner[], cleanup: boolean): StorageGroup {
	if (owners.length === 0) return "unknown";
	if (owners.some(owner => owner.run.recent)) return "recent";
	if (owners.some(owner => owner.run.live)) return "live";
	// This process may hold its agents live in memory; without the ledger it is not proven either way.
	if (!cleanup || owners.some(owner => owner.run.sameProcess)) return "unclassified";
	if (owners.some(owner => !owner.cleaned)) return "candidate";
	return "unclassified";
}

/** What the status storage line shows; reads only stat and directory metadata, never a transcript. */
export async function readStorage(
	sessionDir: string,
	sessionsRoot: string,
	options: StorageReadOptions = {},
): Promise<StorageView> {
	const [local, trusted, last] = await Promise.all([treeBytes(sessionDir), readTrustedRuns(sessionDir), lastCleanupRecord(sessionDir)]);
	const cleanup = options.cleanup === true;
	const me = options.process ?? processKey();
	const alive = options.alive ?? processAlive;
	const ompSessionDir = options.ompSessionDir === "" ? undefined : options.ompSessionDir;
	const gaps: StorageGaps = { sessionsRoot: false, project: false, staleSessions: 0, trustRoots: 0, roots: 0, entries: 0, symlinks: 0, scanned: 0 };
	const plans = new Map<string, RootPlan>();
	const projectParents: Stats[] = [];
	const scope = await sessionsScope(sessionsRoot);
	if (scope === undefined) {
		gaps.sessionsRoot = true;
		if (ompSessionDir !== undefined) gaps.currentSession = "invalid";
		else gaps.currentSession = "unnamed";
	} else {
		const recentStart = Math.max(0, trusted.length - KEEP_RECENT_RUNS);
		for (const [index, run] of trusted.entries()) {
			const accepted = await acceptedInventoryRoot(run.artifactsDir, scope);
			if ("reason" in accepted) {
				gaps.trustRoots++;
				continue;
			}
			let plan = plans.get(accepted.key);
			if (plan === undefined) {
				plan = { ...accepted, agents: new Map() };
				plans.set(accepted.key, plan);
			}
			const sameProcess = run.process === me;
			const owner: RunOwner = { index, recent: index >= recentStart, sameProcess, live: !sameProcess && alive(run.process) };
			const cleaned = new Set(run.cleaned ?? []);
			for (const id of run.agents) {
				if (!AGENT_ID.test(id) || RESERVED_IDS[id.split(".")[0] ?? ""]) continue;
				const agents = plan.agents.get(id) ?? [];
				agents.push({ id, run: owner, cleaned: cleaned.has(id) });
				plan.agents.set(id, agents);
			}
		}
		if (ompSessionDir === undefined) gaps.currentSession = "unnamed";
		else {
			const project = await acceptedDirBelow(ompSessionDir, scope);
			if ("reason" in project) gaps.currentSession = project.reason;
			else {
				let entries: Dirent[] = [];
				try {
					entries = await fs.readdir(project.dir, { withFileTypes: true });
					gaps.project = true;
				} catch {
					gaps.roots++;
				}
				for (const entry of entries) {
					if (entry.isSymbolicLink()) {
						gaps.symlinks++;
						continue;
					}
					const child = path.join(project.dir, entry.name);
					if (entry.isFile() && entry.name.endsWith(".jsonl")) {
						const stat = await lstatOrUndefined(child);
						if (stat === undefined) gaps.entries++;
						else if (stat.isFile()) projectParents.push(stat);
						else if (stat.isSymbolicLink()) gaps.symlinks++;
						continue;
					}
					if (!entry.isDirectory()) continue;
					// A session dir is recognized only with its regular sibling parent transcript.
					const accepted = await acceptedInventoryRoot(child, scope);
					if ("reason" in accepted) {
						gaps.staleSessions++;
						continue;
					}
					if (!plans.has(accepted.key)) plans.set(accepted.key, { ...accepted, agents: new Map() });
				}
			}
		}
	}

	const records = new Map<string, InventoryRecord>();
	const parentSeen = new Set<string>();
	const spillSeen = new Set<string>();
	const parent: StorageTally = { files: 0, bytes: 0 };
	const spill: StorageTally = { files: 0, bytes: 0 };

	const addRecord = async (plan: RootPlan, dirParts: readonly string[], name: string, file: string): Promise<void> => {
		const meta = recordMeta(name);
		if (meta === undefined || !recordPathMatches(dirParts, meta.id)) return;
		const stat = await lstatOrUndefined(file);
		if (stat === undefined) {
			gaps.entries++;
			return;
		}
		if (!stat.isFile()) {
			if (stat.isSymbolicLink()) gaps.symlinks++;
			return;
		}
		const owners = new Map<string, FileOwner>();
		const idParts = meta.id.split(".");
		for (let i = 1; i <= idParts.length; i++) {
			const ownerId = idParts.slice(0, i).join(".");
			for (const agent of plan.agents.get(ownerId) ?? []) {
				owners.set(`${agent.run.index}:${agent.id}`, { run: agent.run, cleaned: agent.cleaned });
			}
		}
		const key = `${stat.dev}:${stat.ino}`;
		let record = records.get(key);
		if (record === undefined) {
			record = { kind: meta.kind, bytes: Number(stat.size), owners: new Map() };
			records.set(key, record);
		}
		for (const [id, owner] of owners) record.owners.set(id, owner);
	};

	const scanSpill = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") gaps.entries++;
			return;
		}
		for (const entry of entries) {
			if (!/^\d+\.log$/.test(entry.name)) continue;
			if (entry.isSymbolicLink()) {
				gaps.symlinks++;
				continue;
			}
			if (!entry.isFile()) continue;
			const stat = await lstatOrUndefined(path.join(dir, entry.name));
			if (stat === undefined) {
				gaps.entries++;
				continue;
			}
			if (!stat.isFile()) {
				if (stat.isSymbolicLink()) gaps.symlinks++;
				continue;
			}
			const key = `${stat.dev}:${stat.ino}`;
			if (spillSeen.has(key)) continue;
			spillSeen.add(key);
			spill.files++;
			spill.bytes += Number(stat.size);
		}
	};

	const walk = async (plan: RootPlan, dir: string, dirParts: string[], depth: number): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			if (depth === 0) gaps.roots++;
			else gaps.entries++;
			return;
		}
		if (depth === 0) gaps.scanned++;
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				gaps.symlinks++;
				continue;
			}
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth === 0 && entry.name === "local") {
					await scanSpill(file);
					continue;
				}
				await walk(plan, file, [...dirParts, entry.name], depth + 1);
			} else if (entry.isFile()) await addRecord(plan, dirParts, entry.name, file);
		}
	};

	const rememberParent = (key: string, size: number): void => {
		if (parentSeen.has(key)) return;
		parentSeen.add(key);
		parent.files++;
		parent.bytes += size;
	};
	for (const stat of projectParents) rememberParent(`${stat.dev}:${stat.ino}`, Number(stat.size));
	for (const plan of plans.values()) {
		rememberParent(plan.parentKey, plan.parentSize);
		await walk(plan, plan.dir, [], 0);
	}

	const total = newStorageFiles();
	const groups: Record<StorageGroup, StorageFiles> = {
		recent: newStorageFiles(),
		live: newStorageFiles(),
		unclassified: newStorageFiles(),
		candidate: newStorageFiles(),
		unknown: newStorageFiles(),
	};
	const unclassifiedReasons = { sameProcess: 0, cleaned: 0, other: 0 };
	for (const record of records.values()) {
		addFile(total, record.kind, record.bytes);
		const owners = [...record.owners.values()];
		const group = storageGroup(owners, cleanup);
		addFile(groups[group], record.kind, record.bytes);
		if (group !== "unclassified") continue;
		if (!cleanup) unclassifiedReasons.other++;
		else if (owners.some(owner => owner.run.sameProcess)) unclassifiedReasons.sameProcess++;
		else if (owners.every(owner => owner.cleaned)) unclassifiedReasons.cleaned++;
		else unclassifiedReasons.other++;
	}

	const view: StorageView = {
		stormBytes: local,
		total,
		groups,
		unclassifiedReasons,
		...(parent.files ? { parent } : {}),
		...(spill.files ? { spill } : {}),
		gaps,
	};
	if (last?.cleanup) view.lastCleanup = { at: last.endedAt ?? last.updatedAt ?? last.startedAt, result: last.cleanup };
	return view;
}

/** Byte size in binary units: "512B", "512KB", "38MB", "1.3GB". */
export function bytesText(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}${units[unit]}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const tallyText = (tally: StorageTally): string => `${tally.files.toLocaleString("en-US")}개 ${bytesText(tally.bytes)}`;
const pairText = (files: StorageFiles): string => {
	if (!files.transcripts.files && !files.sidecars.files) return "";
	return `전사 ${tallyText(files.transcripts)} · 부속 ${tallyText(files.sidecars)}`;
};

function gapText(gaps: StorageGaps): string | undefined {
	const parts: string[] = [];
	if (gaps.sessionsRoot) parts.push("프로필 세션 폴더를 읽지 못함");
	if (gaps.currentSession !== undefined) {
		const state = gaps.currentSession;
		parts.push(state === "unnamed" ? "현재 세션 폴더 미지정" : state === "missing" ? "현재 세션 폴더 없음" : "현재 세션 폴더 사용 불가");
	}
	if (gaps.trustRoots) parts.push(`실행 목록의 세션 폴더 ${gaps.trustRoots}곳 사용 불가`);
	if (gaps.staleSessions) parts.push(`상위 세션 기록이 없는 폴더 ${gaps.staleSessions}곳 제외`);
	if (gaps.roots) parts.push(`세션 폴더 ${gaps.roots}곳 읽기 실패`);
	if (gaps.entries) parts.push(`하위 항목 ${gaps.entries}곳 읽기 실패`);
	if (gaps.symlinks) parts.push(`심볼릭 링크 ${gaps.symlinks}개 건너뜀`);
	return parts.length ? parts.join(" · ") : undefined;
}

function unclassifiedText(view: StorageView, cleanupOn: boolean): string {
	const parts: string[] = [];
	if (!cleanupOn) parts.push("정리 꺼짐");
	if (view.unclassifiedReasons.sameProcess) parts.push(`이 프로세스 실행 ${view.unclassifiedReasons.sameProcess}개(라이브 확인 불가)`);
	if (view.unclassifiedReasons.cleaned) parts.push(`정리 기록 뒤 남음 ${view.unclassifiedReasons.cleaned}개`);
	if (view.unclassifiedReasons.other) parts.push(`그 밖의 근거 부족 ${view.unclassifiedReasons.other}개`);
	return parts.join(" · ");
}

function cleanupText(view: StorageView): string {
	if (view.lastCleanup === undefined) return "마지막 정리 없음";
	const d = new Date(view.lastCleanup.at);
	const r = view.lastCleanup.result;
	const when = Number.isFinite(d.getTime()) ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : view.lastCleanup.at;
	return `마지막 정리 ${when}(에이전트 ${r.agents}개 ${bytesText(r.bytes)}, Storm 파일 ${r.stormFiles}개)`;
}

/** One concise line for the hub: Storm data, the child records seen, and the last cleanup. */
export function formatStorage(view: StorageView, cleanupOn: boolean): string {
	const storm = `Storm 데이터 ${bytesText(view.stormBytes)}`;
	const last = cleanupText(view);
	if (view.gaps.scanned === 0 && !view.gaps.project) return `저장: ${storm} · omp 기록 측정 불가(${gapText(view.gaps) ?? "세션 폴더 없음"}) · ${last}`;
	const total = countFiles(view.total);
	const gap = gapText(view.gaps);
	const unseen = view.gaps.staleSessions + view.gaps.trustRoots + view.gaps.roots + view.gaps.entries + view.gaps.symlinks;
	let omp: string;
	if (total.files === 0 && unseen > 0) omp = "omp 자식 기록 확인 불가(일부 누락)";
	else {
		omp = `omp 자식 기록 ${total.files.toLocaleString("en-US")}개 ${bytesText(total.bytes)}`;
		const candidate = countFiles(view.groups.candidate);
		if (candidate.files) omp += ` · 정리 후보 ${tallyText(candidate)}`;
		const unknown = countFiles(view.groups.unknown);
		if (unknown.files) omp += ` · 소유 미상 ${tallyText(unknown)}`;
		if (gap !== undefined) omp += " · 일부 누락(/storm status)";
	}
	return `저장: ${storm} · ${omp}${cleanupOn ? "" : " · 자동 정리 꺼짐"} · ${last}`;
}

/**
 * The full storage section for `/storm status`, tagged from the same decisions that choose each row: `warning` marks
 * only a real measurement gap or an unknown owner, never policy (cleanup off) or an ordinary cleanup candidate.
 * Parent transcripts, spill files and every zero outside the record walk stay apart.
 */
export function storageDetailLines(view: StorageView, cleanupOn: boolean): StorageDetailLine[] {
	const out: StorageDetailLine[] = [];
	const add = (text: string, warning = false): void => {
		out.push(warning ? { text, warning: true } : { text });
	};
	add(`Storm 세션 데이터: ${bytesText(view.stormBytes)} (이 세션의 저장소)`);
	if (view.gaps.scanned === 0 && !view.gaps.project) {
		add(`omp 자식 기록: 측정 불가(${gapText(view.gaps) ?? "측정할 세션 폴더 없음"})`, true);
		add(cleanupText(view));
		return out;
	}
	const gap = gapText(view.gaps);
	const measured = pairText(view.total);
	add(`omp 자식 기록: ${measured || (gap !== undefined ? "없음(일부 누락)" : "없음")} — 이 프로필에서 확인한 세션 폴더(사용자 전체 아님)`, measured.length === 0 && gap !== undefined);
	const recent = pairText(view.groups.recent);
	if (recent) add(`최근 3개 실행 보호: ${recent}`);
	const live = pairText(view.groups.live);
	if (live) add(`실행 중 프로세스 보호: ${live} — 다른 omp 프로세스가 살아 있음(프로세스 생존만 확인)`);
	if (countFiles(view.groups.unclassified).files) {
		const reasons = view.unclassifiedReasons;
		// "정리 꺼짐" is a policy, not a gap; when cleanup is on, an unexplained remainder is.
		const warning = reasons.sameProcess > 0 || reasons.cleaned > 0 || (cleanupOn && reasons.other > 0);
		const reason = unclassifiedText(view, cleanupOn);
		add(`판단 보류: ${pairText(view.groups.unclassified)}${reason ? ` — ${reason}` : ""}`, warning);
	}
	const candidate = pairText(view.groups.candidate);
	if (candidate) add(`정리 후보: ${candidate} — 3개 이전·프로세스 종료 확인 기준, 정리 켜짐. 실제 삭제는 실행 시 동의와 라이브 확인 뒤`);
	else if (!cleanupOn) add("정리 후보: 없음 — 자동 정리가 꺼져 있음");
	const unknown = pairText(view.groups.unknown);
	if (unknown) add(`소유 미상: ${unknown} — 이 기기 실행 목록에 없는 기록은 자동 삭제하지 않음`, true);
	if (view.parent) add(`상위 세션 전사: ${tallyText(view.parent)} — 자식 기록과 분리, 정리 대상 아님`);
	if (view.spill) add(`세션 spill: ${tallyText(view.spill)} — 자식 기록과 분리, 정리 대상 아님`);
	if (gap !== undefined) add(`집계 누락: ${gap} — 합계에 포함되지 않음`, true);
	add(cleanupText(view));
	return out;
}

/** The plain inventory rows; `formatStorageDetail` stays the public text-only form. */
export function formatStorageDetail(view: StorageView, cleanupOn: boolean): string[] {
	return storageDetailLines(view, cleanupOn).map(line => line.text);
}
