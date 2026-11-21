/**
 * Run-end janitor: Storm code, not an LLM worker. It trims Storm's own stores to their limits and, only when the team
 * approved `cleanup`, removes the omp records (transcripts, sidecars, tombstones, nested transcripts) of parked
 * subagents of older Storm runs. Outputs (`*.md`) always stay, so `agent://<id>` keeps answering.
 *
 * Deletion paths never come from the repo: run records under `.omp/storm/` sit in the work tree and can be committed
 * by anyone. Candidates come only from the per-machine trusted list next to the repo's approval records
 * (`<store.dir>/runs.jsonl`), which only this machine's Storm writes at run end.
 */
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pruneProposals } from "../proposals/store.ts";
import type { AgentEntry, CleanupResult, RunRecord, StormConfig } from "../types.ts";
import { readRun, runsDir, writeRun } from "./run.ts";
import { pruneTrialStates } from "./state-files.ts";

/** Runs whose subagent records stay for result checks and analysis, newest first. */
export const KEEP_RECENT_RUNS = 3;
/** Trusted run entries kept per repo. */
export const TRUSTED_RUNS_MAX = 200;

/** The approval store's limit step, as the janitor needs it (`ApprovalStore.prune`). */
export interface ApprovalPrunePort {
	prune(keepHash: string | null): Promise<number>;
}

/** One line of `<store.dir>/runs.jsonl`: a Storm run this machine ran, and where its subagents' records live. */
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
	/** Project root: Storm's trial counters and proposals, and run records for the display-only `cleanedAt`. */
	root: string;
	/** `ApprovalStore.dir` of this repo: holds the trusted run list. */
	storeDir: string;
	/** `<agentDir>/sessions`: an artifacts dir is accepted only below it. */
	sessionsRoot: string;
	/** The approved config in force at run end. */
	config: StormConfig;
	/** The config the ended run started with. omp records go only when both have `cleanup: true`. */
	startConfig: StormConfig;
	/** The approved hash in force; its snapshot, evidence and record always stay. */
	configHash: string | null;
	/** The run that just ended; never cleaned. */
	runId: string;
	/** `processKey()` of this process. */
	process: string;
	now: number;
	/** This process's agent ledger (`listAgents()`): agents in it that are not parked are live and never cleaned. */
	ledger: readonly AgentEntry[];
	approvals?: ApprovalPrunePort;
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

function trustedRunsFile(storeDir: string): string {
	return path.join(storeDir, "runs.jsonl");
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

/** Trusted runs, oldest first; torn or foreign lines are skipped. */
export async function readTrustedRuns(storeDir: string): Promise<TrustedRun[]> {
	let text: string;
	try {
		text = await fs.readFile(trustedRunsFile(storeDir), "utf8");
	} catch {
		return [];
	}
	const out: TrustedRun[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isTrustedRun(value)) out.push(value);
		} catch {
			// torn line
		}
	}
	return out;
}

// Read-modify-write of the list; a per-file chain keeps two updates in one process from losing each other.
const chains = new Map<string, Promise<void>>();

function updateTrustedRuns(storeDir: string, update: (runs: TrustedRun[]) => TrustedRun[]): Promise<void> {
	const file = path.resolve(trustedRunsFile(storeDir));
	const step = (chains.get(file) ?? Promise.resolve()).then(async () => {
		const next = update(await readTrustedRuns(storeDir)).slice(-TRUSTED_RUNS_MAX);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const tmp = path.join(path.dirname(file), `.runs.jsonl.${process.pid}.${crypto.randomUUID()}.tmp`);
		try {
			await fs.writeFile(tmp, next.map(r => `${JSON.stringify(r)}\n`).join(""));
			await fs.rename(tmp, file);
		} catch (error) {
			await fs.rm(tmp, { force: true });
			throw error;
		}
	});
	const tail = step.then(
		() => undefined,
		() => undefined,
	);
	chains.set(file, tail);
	void tail.then(() => {
		if (chains.get(file) === tail) chains.delete(file);
	});
	return step;
}

/**
 * Adds a run to the machine's trusted list, keeping the newest `TRUSTED_RUNS_MAX`. A run already on it is replaced in
 * place (its age is its first recording) and the ids the janitor already cleaned for it stay cleaned.
 */
export function recordTrustedRun(storeDir: string, entry: Omit<TrustedRun, "cleaned">): Promise<void> {
	return updateTrustedRuns(storeDir, runs => {
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
 * Runs once at each run end, after the run is recorded (`recordTrustedRun`, `writeRun`, index, `pruneRuns`).
 * Storm limits always apply; omp records go only when the run's start config and the config in force both have
 * `cleanup: true`, and only for agents of trusted runs older than the newest `KEEP_RECENT_RUNS`.
 */
export async function runJanitor(input: JanitorInput): Promise<JanitorOutput> {
	const result: CleanupResult = { agents: 0, files: 0, bytes: 0, stormFiles: 0 };
	const cleaned: string[] = [];
	if (input.approvals) result.stormFiles += await input.approvals.prune(input.configHash);
	const trialIds = [...(input.config.trials ?? []), ...(input.startConfig.trials ?? [])].map(t => t.id);
	result.stormFiles += await pruneTrialStates(input.root, trialIds);
	result.stormFiles += await pruneProposals(input.root, input.now);
	if (input.config.cleanup !== true || input.startConfig.cleanup !== true) return { result, cleaned };

	// Same-process agents absent from the ledger were parked long ago (the ledger only drops parked entries).
	const live = input.ledger.filter(e => e.state !== "parked").map(e => e.id);
	const older = (await readTrustedRuns(input.storeDir))
		.reverse()
		.slice(KEEP_RECENT_RUNS)
		.filter(r => r.runId !== input.runId);
	const done = new Map<string, string[]>();
	for (const run of older) {
		const sameProcess = run.process === input.process;
		// Another omp process that still runs may hold its agents in memory; B0 showed deleting those loses data.
		if (!sameProcess && processAlive(run.process)) continue;
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
	await updateTrustedRuns(input.storeDir, runs =>
		runs.map(r => {
			const ids = done.get(r.runId);
			return ids ? { ...r, cleaned: [...(r.cleaned ?? []), ...ids] } : r;
		}),
	);
	// Display only: the repo's run records show which agents were cleaned.
	for (const [runId, ids] of done) {
		const record = await readRun(input.root, runId);
		if (!record?.agents) continue;
		const set = new Set(ids);
		await writeRun(input.root, {
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

/** Newest repo run record carrying a cleanup result; display only. */
async function lastCleanupRecord(root: string): Promise<RunRecord | undefined> {
	let names: string[];
	try {
		names = await fs.readdir(runsDir(root));
	} catch {
		return undefined;
	}
	const ids = names
		.filter(n => /^run-[0-9A-Za-z-]+\.json$/.test(n))
		.map(n => n.slice(0, -5))
		.sort()
		.reverse();
	for (const id of ids) {
		const run = await readRun(root, id);
		if (run?.cleanup) return run;
	}
	return undefined;
}

export interface StorageView {
	/** `.omp/storm/` plus this repo's approval records. */
	stormBytes: number;
	/** Record files still on disk of not-cleaned subagents of trusted Storm runs. */
	ompFiles: number;
	ompBytes: number;
	lastCleanup?: { at: string; result: CleanupResult };
}

/** What the status storage line shows; reads only. */
export async function readStorage(root: string, storeDir: string, sessionsRoot: string): Promise<StorageView> {
	const [local, approvals, trusted, last] = await Promise.all([
		treeBytes(path.join(root, ".omp", "storm")),
		treeBytes(storeDir),
		readTrustedRuns(storeDir),
		lastCleanupRecord(root),
	]);
	const view: StorageView = { stormBytes: local + approvals, ompFiles: 0, ompBytes: 0 };
	for (const run of trusted) {
		const dir = await acceptedArtifactsDir(run.artifactsDir, sessionsRoot);
		if (dir === undefined) continue;
		const cleanedIds = new Set(run.cleaned ?? []);
		for (const id of run.agents) {
			if (cleanedIds.has(id)) continue;
			for (const record of await agentRecordFiles(dir, id)) {
				view.ompFiles++;
				view.ompBytes += record.bytes;
			}
		}
	}
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

/** One line: Storm data size, remaining omp records of Storm runs, and the last cleanup. */
export function formatStorage(view: StorageView, cleanupOn: boolean): string {
	const omp = `남은 omp 기록 ${bytesText(view.ompBytes)}(파일 ${view.ompFiles}개${cleanupOn ? "" : ", 자동 정리 꺼짐"})`;
	let last = "마지막 정리 없음";
	if (view.lastCleanup) {
		const d = new Date(view.lastCleanup.at);
		const r = view.lastCleanup.result;
		const when = Number.isFinite(d.getTime()) ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : view.lastCleanup.at;
		last = `마지막 정리 ${when}(에이전트 ${r.agents}개 ${bytesText(r.bytes)}, Storm 파일 ${r.stormFiles}개)`;
	}
	return `저장: Storm 데이터 ${bytesText(view.stormBytes)} · ${omp} · ${last}`;
}
