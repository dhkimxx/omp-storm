import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { shortHash } from "../config/canonical.ts";
import { writeJsonAtomic } from "../fsutil.ts";
import { assertSessionPathSafe, sessionStateDir } from "../session-scope.ts";
import { docsEnabled } from "../policy/docs.ts";
import { formatUsd, usableRole } from "../policy/spawn.ts";
import { LANE_ROLES, ROLE_STAND_INS, roleTitle, workerRange } from "../roles.ts";
import type { LaneKind, RoleId, RunRecord, StormConfig } from "../types.ts";
import { END_STATUS } from "./rounds.ts";

/** What a lane kind covers beyond its name, where the role alone does not say it. */
const LANE_NOTE: Partial<Record<LaneKind, string>> = { run: "long builds, device runs, waiting, logs" };

/** The agent doing a role's work in this team: the role's own, else its nearest usable stand-in's. */
function agentFor(config: StormConfig, roleId: RoleId): string | undefined {
	const id = usableRole(config, roleId) ? roleId : ROLE_STAND_INS[roleId].find(r => usableRole(config, r));
	return id === undefined ? undefined : config.roles[id]?.agent;
}

/** `explore→storm-explorer, …`: each lane kind's role, falling back along `ROLE_STAND_INS` when it is not usable. */
function laneRoles(config: StormConfig): string {
	return Object.entries(LANE_ROLES)
		.flatMap(([kind, roleId]) => {
			const agent = agentFor(config, roleId);
			if (agent === undefined) return [];
			const note = LANE_NOTE[kind as LaneKind];
			return [`${kind}${note ? ` (${note})` : ""}→${agent}`];
		})
		.join(", ");
}

/** Storm's own state under one native session's captured store: `<sessionDir>/state`. Never the target work tree. */
export function stateDir(sessionDir: string): string {
	return sessionStateDir(sessionDir);
}

export function runsDir(sessionDir: string): string {
	return path.join(stateDir(sessionDir), "runs");
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "run-YYYYMMDD-HHMMSS-xxxx" in UTC: sorts by start time, random tail keeps same-second runs apart. */
export function newRunId(now: number): string {
	const d = new Date(now);
	const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
	const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
	const tail = Array.from(crypto.getRandomValues(new Uint8Array(2)), b => b.toString(16).padStart(2, "0")).join("");
	return `run-${date}-${time}-${tail}`;
}

// Run ids become file names; anything else could escape runs/.
const RUN_ID = /^run-[0-9A-Za-z-]+$/;

/** Whether a string is a run id this module stores as a file name. */
export function isRunId(value: string): boolean {
	return RUN_ID.test(value);
}

/** The session-store-relative run record path, for text that must point at a record without copying it. */
export function runRecordRef(runId: string): string | undefined {
	return isRunId(runId) ? `state/runs/${runId}.json` : undefined;
}

function runFile(sessionDir: string, runId: string): string | undefined {
	return isRunId(runId) ? path.join(runsDir(sessionDir), `${runId}.json`) : undefined;
}

const RUN_STATUSES: readonly string[] = ["running", "done", "ended", "budget-exceeded", "stopped"];

function isRunRecord(value: unknown): value is RunRecord {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		v.schema === "storm.run/v1" &&
		typeof v.runId === "string" &&
		typeof v.startedAt === "string" &&
		typeof v.status === "string" &&
		RUN_STATUSES.includes(v.status) &&
		typeof v.costUsd === "number" &&
		Array.isArray(v.spawns)
	);
}

export async function writeRun(sessionDir: string, run: RunRecord): Promise<void> {
	const file = runFile(sessionDir, run.runId);
	if (!file) throw new Error(`잘못된 실행 id입니다: ${run.runId}`);
	await assertSessionPathSafe(sessionDir, file);
	await writeJsonAtomic(file, run);
}

/** One run record is bounded before parsing: a large, replaced or non-regular file is not a record. */
export const RUN_RECORD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reads one run record within a byte bound. The file must be a regular file, is opened without following a symlink,
 * and the inode must not change between `lstat` and `open`; a record whose size changes while it is read is rejected
 * rather than parsed as a torn prefix. Unreadable input is "no record", as `readJson` treated it.
 */
async function readRunJson(file: string): Promise<unknown> {
	let before;
	try {
		before = await fs.lstat(file);
	} catch {
		return undefined;
	}
	if (!before.isFile() || before.size > RUN_RECORD_MAX_BYTES) return undefined;
	let handle: FileHandle;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	} catch {
		return undefined;
	}
	try {
		const after = await handle.stat();
		if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) return undefined;
		const buffer = Buffer.alloc(after.size + 1);
		let read = 0;
		for (;;) {
			const next = await handle.read(buffer, read, buffer.length - read, read);
			if (next.bytesRead === 0) break;
			read += next.bytesRead;
			if (read === buffer.length) break;
		}
		if (read !== after.size) return undefined;
		return JSON.parse(buffer.subarray(0, read).toString("utf8"));
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export async function readRun(sessionDir: string, runId: string): Promise<RunRecord | undefined> {
	const file = runFile(sessionDir, runId);
	if (!file) return undefined;
	await assertSessionPathSafe(sessionDir, file);
	const value = await readRunJson(file);
	return isRunRecord(value) && value.runId === runId ? value : undefined;
}

/** Ids of the run records on disk, oldest first (run ids sort by start time). */
export async function runIds(sessionDir: string): Promise<string[]> {
	const dir = runsDir(sessionDir);
	await assertSessionPathSafe(sessionDir, dir);
	try {
		const names = await fs.readdir(dir);
		return names.flatMap(n => (n.endsWith(".json") && RUN_ID.test(n.slice(0, -5)) ? [n.slice(0, -5)] : [])).sort();
	} catch {
		return [];
	}
}

/** Newest finished run by startedAt; unreadable files are skipped. */
export async function lastRun(sessionDir: string): Promise<RunRecord | undefined> {
	const runs = await Promise.all((await runIds(sessionDir)).map(id => readRun(sessionDir, id)));
	let best: RunRecord | undefined;
	let bestAt = Number.NEGATIVE_INFINITY;
	for (const run of runs) {
		if (!run || run.status === "running") continue;
		const at = Date.parse(run.startedAt);
		const key = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
		if (!best || key > bestAt || (key === bestAt && run.runId > best.runId)) {
			best = run;
			bestAt = key;
		}
	}
	return best;
}

/** Run files retention keeps by default; the resume pointer collection is bounded by the same number. */
export const RUN_KEEP = 50;

/**
 * Keeps the newest `keep` run files. A record still marked running is never deleted by retention, and neither is an id
 * the caller protects: a run-end caller passes `protectedResumeRunIds(sessionDir, target)` from `resume.ts` so
 * trusted unfinished runs stay. Only `run-*.json` files are candidates: other files in `runs/` are left alone.
 */
export async function pruneRuns(sessionDir: string, keep = RUN_KEEP, protect: readonly string[] = []): Promise<void> {
	const ids = (await runIds(sessionDir)).reverse();
	const guarded = new Set(protect);
	await Promise.all(
		ids.slice(Math.max(0, keep)).map(async id => {
			if (guarded.has(id)) return;
			// A run whose process is still alive cannot be known to be finished here: keep its record until it stops.
			const run = await readRun(sessionDir, id);
			if (run?.status === "running") return;
			const file = path.join(runsDir(sessionDir), `${id}.json`);
			await assertSessionPathSafe(sessionDir, file);
			await fs.rm(file, { force: true });
		}),
	);
}

/** How much of a request a run record keeps for a later run to resume from. */
export const REQUEST_LIMIT = 20_000;

// END_STATUS is keyed by the current reasons; a run record from disk may carry a retired one, which has no status.
const END_STATUS_BY_NAME = END_STATUS as Readonly<Record<string, string | undefined>>;

/** A run a later run can continue: it stopped unfinished and kept its request. */
export function resumableRun(run: RunRecord | undefined): run is RunRecord & { request: string } {
	if (run === undefined || typeof run.request !== "string" || run.request.length === 0) return false;
	if (run.status !== "stopped" && run.status !== "budget-exceeded") return false;
	const reason = run.endReason;
	return reason === undefined || (reason !== "start-failed" && END_STATUS_BY_NAME[reason] === "stopped");
}

/** The run this one continues, as much of it as the handoff needs. */
export interface ResumeInfo {
	runId: string;
	endReason?: string;
	turns?: number;
	/** Length of the stored request: the limit is named when the record itself holds no more. */
	requestLength?: number;
	/** The user's words when they asked to resume, not part of the task. */
	said?: string;
	/**
	 * Present when the old record's accepted proof was revalidated into this run: counts of what survives, plus a
	 * short list of lanes still open. Counts only — the old record is never replayed into the handoff.
	 */
	checkpoint?: { kept: number; reopened: number; blocked: number; laneNames?: readonly string[]; planUnavailable?: true };
}

/** Still-open lanes a restored handoff names, and one name's bound. */
const RESUME_OPEN_LANES = 8;
const RESUME_OPEN_LANE_CHARS = 60;
/** The user's sentence is a note, not a second task. */
const RESUME_SAID_CHARS = 1_000;

/** The user's sentence in one line, short enough to stay a note. */
function resumeSaid(said: string | undefined): string | undefined {
	if (said === undefined) return undefined;
	const text = said.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return `On resuming the user said: ${text}`.slice(0, RESUME_SAID_CHARS);
}

/** Counts from a stored record are labels: never negative, never fractional, never NaN. */
function resumeCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** One short still-open lane list; a stored name is a label, so controls and extra lines are removed. */
function checkpointLanes(names: readonly string[] | undefined): string[] {
	if (!Array.isArray(names)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (typeof name !== "string") continue;
		const clean = name
			.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, RESUME_OPEN_LANE_CHARS);
		if (clean === "" || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
		if (out.length === RESUME_OPEN_LANES) break;
	}
	return out;
}

/**
 * What a restored checkpoint contributes: how much proof survived and which lanes are still open. The detailed old
 * plan is deliberately not replayed — the plan was re-validated and seeded, and imported rows already carry their
 * evidence; only counts and a short open list help the director choose the next round.
 */
function checkpointBlock(checkpoint: NonNullable<ResumeInfo["checkpoint"]>): string[] {
	const lanes = checkpointLanes(checkpoint.laneNames);
	return [
		`Checkpoint restored: kept ${resumeCount(checkpoint.kept)} accepted, reopened ${resumeCount(checkpoint.reopened)}, blocked ${resumeCount(checkpoint.blocked)}.`,
		...(lanes.length === 0 ? [] : [`Still open: ${lanes.join(", ")}`]),
	];
}

/** What the director of a resumed run reads before the team: the old run, where it stopped, and what still holds. */
function resumeBlock(resume: ResumeInfo): string[] {
	const rounds = resumeCount(resume.turns ?? 0);
	// Both came from the session store: an id that is not a run id or a reason this version does not know is not shown.
	const subject = RUN_ID.test(resume.runId) ? `run ${resume.runId}` : "the earlier run";
	const reason =
		resume.endReason !== undefined && Object.hasOwn(END_STATUS, resume.endReason) ? ` (${resume.endReason})` : "";
	const header = `Continues ${subject}, which stopped${reason} after ${rounds} rounds.`;
	const said = resumeSaid(resume.said);
	const limit = resume.requestLength === REQUEST_LIMIT ? ["The stored request was cut at 20,000 characters."] : [];
	return [
		header,
		...(resume.checkpoint === undefined ? [] : checkpointBlock(resume.checkpoint)),
		resume.checkpoint === undefined || resume.checkpoint.planUnavailable === true
			? "The old plan could not be restored. Check `storm status` for remaining requirements and submit a plan."
			: "Finish every open lane; accepted results restored from the checkpoint need no new work. See `storm status` for the current plan and results.",
		...limit,
		...(said ? [said] : []),
	];
}

/**
 * The message that starts a Storm run: the task, the team and the few rules the director needs up front. Enforced
 * rules are taught by their block reasons, so each has at most one clause here. `maxRounds` is the run's whole round
 * budget, fixed by the controller when the run starts. `resume` names the run this one continues. Everything sits in
 * one XML section: omp's keyword matcher skips those, so neither this text nor the task can attach an omp workflow
 * notice (whose instructions contradict what Storm enforces).
 */
export function buildHandoff(input: {
	runId: string;
	config: StormConfig;
	hash: string;
	task: string;
	maxRounds: number;
	resume?: ResumeInfo;
}): string {
	const { config } = input;
	const team = Object.entries(config.roles).flatMap(([id, role]) => {
		if (!usableRole(config, id)) return [];
		const max = workerRange(id, role).max;
		return [`- ${role.agent}: ${roleTitle(id)}, up to ${max} ${max === 1 ? "worker" : "workers"}`];
	});
	const isolated = config.isolation === "isolated";
	const rules = [
		"- Delegate all changes; your own file edits are blocked.",
		`- Before spawning use \`storm plan\`; non-review lanes need \`results\`. Kinds: ${laneRoles(config)}.`,
		"- Replan: keep goal/kind/role/job/files/results; `progress`=status, new name=scope.",
		"- Cite file:line or command/exit/log; verify ranges.",
		isolated
			? "- `isolated: true`: a separate checkout apart from a branch; changes land only as omp applies them. An isolated review must match the integrated tree to verify. For follow-up, a new agent reads `agent://<id>`."
			: "- Share this checkout, reviewer too; sequence overlapping edits. Only independent lanes set `isolationReason`; work stays outside. Follow up: `write agent://<id>`; if refused, a new agent reads `agent://<id>`.",
		`- Resolve \`incorrect\` reviews and open P0s${docsEnabled(config) ? ", including doc findings" : ""}.`,
		"- Finish every lane or report its blocker.",
		"- Stage `storm brief` from evidence, best next first; Storm reports after it settles.",
	];
	if (config.jobs?.length) {
		rules.push(`- Approved project jobs: ${JSON.stringify(config.jobs.map(job => job.name))}. Plan kind run with job and use storm execute instead of spawning a worker.`);
	}
	const reviewer = usableRole(config, "reviewer")?.agent;
	if (reviewer) {
		const check = `- Storm checks the run: changes, including shell edits, need a later \`correct\` verdict from \`${reviewer}\`.`;
		rules.push(
			input.maxRounds === 1
				? `${check} Without it the run ends unverified.`
				: `${check} Without it Storm sends you back, up to ${input.maxRounds} rounds in all.`,
		);
	}
	if (config.budget) {
		const past = config.budget.onExceed === "stop" ? "the run stops" : "new spawns are blocked";
		rules.push(`- Budget: ${formatUsd(config.budget.perRunUsd)} for this run; past it ${past}.`);
	}
	const resume = input.resume ? resumeBlock(input.resume) : [];
	return [
		`<storm-run id="${input.runId}" config="${shortHash(input.hash)}">`,
		"Task:",
		input.task,
		...(resume.length ? ["", ...resume] : []),
		"",
		"Team (spawn only these):",
		...team,
		"Rules:",
		...rules,
		"</storm-run>",
	].join("\n");
}
