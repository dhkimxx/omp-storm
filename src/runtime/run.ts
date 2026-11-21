import * as fs from "node:fs/promises";
import * as path from "node:path";
import { shortHash } from "../config/canonical.ts";
import { readJson, writeJsonAtomic } from "../fsutil.ts";
import { docsEnabled } from "../policy/docs.ts";
import { formatUsd, usableRole } from "../policy/spawn.ts";
import { LANE_ROLES, ROLE_STAND_INS, roleTitle, workerRange } from "../roles.ts";
import type { LaneKind, RoleId, RunMode, RunRecord, StormConfig } from "../types.ts";

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

const RUN_STATUSES: readonly string[] = ["running", "done", "budget-exceeded", "stopped"];

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

/**
 * The message that starts a Storm run: the task, the team and the few rules the director needs up front. Enforced
 * rules are taught by their block reasons, so each has at most one clause here. A goal or loop run adds one line on
 * what its omp mode asks of the director. Everything sits in one XML section: omp's keyword matcher skips those, so
 * neither this text nor the task can attach an omp workflow notice (whose instructions contradict what Storm enforces).
 */
export function buildHandoff(input: { runId: string; config: StormConfig; hash: string; task: string; mode?: RunMode }): string {
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
	if (input.mode === "goal") {
		rules.push(
			`- Goal run: omp continues you until the goal ends. Call the \`goal\` tool's complete only after \`${agentFor(config, "reviewer") ?? "a reviewer"}\` checked the objective against the current state.`,
		);
	} else if (input.mode === "loop") {
		rules.push("- Loop run: this task is sent again after each turn. Improve on the last result; keep notes in `local://`.");
	}
	if (config.budget) {
		const past = config.budget.onExceed === "stop" ? "the run stops" : "new spawns are blocked";
		rules.push(`- Budget: ${formatUsd(config.budget.perRunUsd)} for this run; past it ${past}.`);
	}
	return [
		`<storm-run id="${input.runId}" config="${shortHash(input.hash)}">`,
		"Task:",
		input.task,
		"",
		"Team (spawn only these):",
		...team,
		"Rules:",
		...rules,
		"</storm-run>",
	].join("\n");
}

/**
 * What omp's loop submits again on every repeat of a loop run: the task inside the run's section, so omp's keyword
 * matcher skips it like the handoff and the director knows it for the run's task, with the one rule a compacted
 * context must not lose.
 */
export function buildLoopBody(runId: string, task: string): string {
	return [
		`<storm-run id="${runId}" repeat="true">`,
		"Task, sent again by the loop. Improve on the last result. You still direct this run: delegate every change to the team, under the rules of the run's first message.",
		task,
		"</storm-run>",
	].join("\n");
}
