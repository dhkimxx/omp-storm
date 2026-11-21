import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "../config/schema.ts";
import { shortHash } from "../config/canonical.ts";
import { readJson, writeJsonAtomic } from "../fsutil.ts";
import { docsEnabled } from "../policy/docs.ts";
import { formatUsd, usableRole } from "../policy/spawn.ts";
import { LANE_ROLES, ROLE_STAND_INS, roleTitle, workerRange } from "../roles.ts";
import type { LaneKind, RoleId, RunPlan, RunRecord, StormConfig } from "../types.ts";
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

export function stateDir(root: string): string {
	return path.join(root, ".omp", "storm", "state");
}

export function runsDir(root: string): string {
	return path.join(stateDir(root), "runs");
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

function runFile(root: string, runId: string): string | undefined {
	return RUN_ID.test(runId) ? path.join(runsDir(root), `${runId}.json`) : undefined;
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

export async function writeRun(root: string, run: RunRecord): Promise<void> {
	const file = runFile(root, run.runId);
	if (!file) throw new Error(`잘못된 실행 id입니다: ${run.runId}`);
	await writeJsonAtomic(file, run);
}

export async function readRun(root: string, runId: string): Promise<RunRecord | undefined> {
	const file = runFile(root, runId);
	if (!file) return undefined;
	const value = await readJson(file);
	return isRunRecord(value) && value.runId === runId ? value : undefined;
}

/** Ids of the run records on disk, oldest first (run ids sort by start time). */
export async function runIds(root: string): Promise<string[]> {
	try {
		const names = await fs.readdir(runsDir(root));
		return names.flatMap(n => (n.endsWith(".json") && RUN_ID.test(n.slice(0, -5)) ? [n.slice(0, -5)] : [])).sort();
	} catch {
		return [];
	}
}

/** Newest finished run by startedAt; unreadable files are skipped. */
export async function lastRun(root: string): Promise<RunRecord | undefined> {
	const runs = await Promise.all((await runIds(root)).map(id => readRun(root, id)));
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

/** Keeps the newest `keep` run files. */
export async function pruneRuns(root: string, keep = 50): Promise<void> {
	const ids = (await runIds(root)).reverse();
	await Promise.all(ids.slice(Math.max(0, keep)).map(id => fs.rm(path.join(runsDir(root), `${id}.json`), { force: true })));
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
	plan?: RunPlan;
	/** Length of the stored request: the limit is named when the record itself holds no more. */
	requestLength?: number;
	/** The user's words when they asked to resume, not part of the task. */
	said?: string;
}

/** Lanes a resume handoff names: the whole plan would bury the rules. */
const RESUME_LANES = 12;
/** One line is all a lane may take in the handoff. */
const RESUME_LANE_CHARS = 160;
/** The user's sentence is a note, not a second task. */
const RESUME_SAID_CHARS = 1_000;

interface ResumeLane {
	name: string;
	role: string;
	goal?: string;
}

/** A stored plan is repository data: only an array of objects with a string name is a plan. */
function resumeLanes(plan: unknown): ResumeLane[] | undefined {
	if (!isRecord(plan) || !Array.isArray(plan.lanes)) return undefined;
	const out: ResumeLane[] = [];
	for (const lane of plan.lanes) {
		if (!isRecord(lane) || typeof lane.name !== "string") return undefined;
		out.push({
			name: lane.name,
			role: typeof lane.role === "string" ? lane.role : "",
			...(typeof lane.goal === "string" && lane.goal.trim() ? { goal: lane.goal } : {}),
		});
	}
	return out;
}

/** One plan line: its name and the agent doing it, and its goal when it had one. */
function resumeLane(config: StormConfig, lane: ResumeLane): string {
	const agent = lane.role === "" ? undefined : (usableRole(config, lane.role)?.agent ?? lane.role);
	const head = agent === undefined ? `- ${lane.name}` : `- ${lane.name} (${agent})`;
	const line = lane.goal ? `${head}: ${lane.goal}` : head;
	// A goal is the model's text: keep its line breaks from adding lines the bounds above do not cover.
	return line.replace(/\s+/g, " ").slice(0, RESUME_LANE_CHARS);
}

/** The user's sentence in one line, short enough to stay a note. */
function resumeSaid(said: string | undefined): string | undefined {
	if (said === undefined) return undefined;
	const text = said.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return `On resuming the user said: ${text}`.slice(0, RESUME_SAID_CHARS);
}

/** What the director of a resumed run reads before the team: the old run, where it stopped, and the plan it was following. */
function resumeBlock(config: StormConfig, resume: ResumeInfo): string[] {
	const lanes = (resumeLanes(resume.plan) ?? []).slice(0, RESUME_LANES);
	const turns = resume.turns ?? 0;
	const rounds = Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : 0;
	// Both came from a repository file: an id that is not a run id or a reason this version does not know is not shown.
	const subject = RUN_ID.test(resume.runId) ? `run ${resume.runId}` : "the earlier run";
	const reason =
		resume.endReason !== undefined && Object.hasOwn(END_STATUS, resume.endReason) ? ` (${resume.endReason})` : "";
	const said = resumeSaid(resume.said);
	return [
		`Continues ${subject}, which stopped${reason} after ${rounds} rounds. Its changes are in the working tree or committed.`,
		"First check the current state (git status and diff, the tests), then finish what is left. Do not redo finished work.",
		...(resume.requestLength === REQUEST_LIMIT ? ["The stored request was cut at 20,000 characters."] : []),
		...(said ? [said] : []),
		...(lanes.length ? ["Earlier plan:", ...lanes.map(lane => resumeLane(config, lane))] : []),
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
		"- You direct this run: your file edits are blocked. Delegate every change to the team.",
		`- Before spawning, submit a plan with the \`storm\` tool (action \`plan\`). Lane kinds: ${laneRoles(config)}.`,
		"- Results carry evidence locations (file and line range, command and exit code, log path). Verify by reading those ranges, not whole files.",
		isolated
			? "- Put `isolated: true` on each task item. Isolated agents take no messages: for follow-up work start a fresh agent that reads `agent://<id>`."
			: "- Follow up on the same area with `write agent://<id>`. When Storm blocks it, start a fresh agent that reads `agent://<id>`.",
		`- Do not finish with an \`incorrect\` review verdict or an open P0${docsEnabled(config) ? "; doc findings count like code findings" : ""}.`,
		"- Keep going until every lane is done or blocked.",
	];
	const reviewer = usableRole(config, "reviewer")?.agent;
	if (reviewer) {
		const check = `- When you stop, Storm checks the run: files changed during it, with any tool or shell command, need a \`correct\` verdict from \`${reviewer}\` given after the last change.`;
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
	const resume = input.resume ? resumeBlock(config, input.resume) : [];
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
