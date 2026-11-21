import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatUsd, usableRole } from "../policy/spawn.ts";
import { BUILTIN_AGENT_ROLES, contextCapFor, LANE_ROLES, ROLE_STAND_INS, ROLES, workerRange } from "../roles.ts";
import type { LaneKind, RoleId, RunRecord, StormConfig } from "../types.ts";

/** What each lane kind covers beyond its name, where the role alone does not say it. */
const LANE_NOTE: Partial<Record<LaneKind, string>> = { run: "긴 빌드·기기 실행·대기·로그 수집" };

/** `explore→storm-explorer, …`: each lane kind's role, falling back along `ROLE_STAND_INS` when it is not usable. */
function laneRoles(config: StormConfig): string {
	return Object.entries(LANE_ROLES)
		.flatMap(([kind, roleId]) => {
			const id = usableRole(config, roleId) ? roleId : ROLE_STAND_INS[roleId].find(r => usableRole(config, r));
			const agent = id === undefined ? undefined : config.roles[id]?.agent;
			if (agent === undefined) return [];
			const note = LANE_NOTE[kind as LaneKind];
			return [`${kind}→${agent}${note ? `(${note})` : ""}`];
		})
		.join(", ");
}

/** When the director should reach for each role, as the team line shows it. */
const ROLE_USE: Record<RoleId, string> = {
	explorer: "넓게 읽고 근거 모으기",
	implementer: "코드 수정",
	reviewer: "독립 검증",
	quick: "작고 기계적인 수정",
	architect: "작업 분해·설계 판단, 아껴 쓰기",
};

export function stateDir(root: string): string {
	return path.join(root, ".omp", "storm", "state");
}

export function runsDir(root: string): string {
	return path.join(stateDir(root), "runs");
}

/** Writes JSON through a temp file and rename so readers never see a partial file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
	try {
		await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true });
		throw error;
	}
}

/** Reads and parses JSON; any failure (missing, unreadable, corrupt) is undefined. */
export async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
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

async function runFiles(root: string): Promise<string[]> {
	try {
		const names = await fs.readdir(runsDir(root));
		return names.filter(n => n.endsWith(".json") && RUN_ID.test(n.slice(0, -5)));
	} catch {
		return [];
	}
}

/** Newest finished run by startedAt; unreadable files are skipped. */
export async function lastRun(root: string): Promise<RunRecord | undefined> {
	const names = await runFiles(root);
	const runs = await Promise.all(names.map(n => readRun(root, n.slice(0, -5))));
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

/** Keeps the newest `keep` run files; run ids sort by start time. */
export async function pruneRuns(root: string, keep = 50): Promise<void> {
	const names = (await runFiles(root)).sort().reverse();
	await Promise.all(names.slice(Math.max(0, keep)).map(n => fs.rm(path.join(runsDir(root), n), { force: true })));
}

export function pickKeyword(
	config: StormConfig,
	usable: { workflowz: boolean; orchestrate: boolean },
): "workflowz" | "orchestrate" | null {
	if (usable[config.contract]) return config.contract;
	const other = config.contract === "workflowz" ? "orchestrate" : "workflowz";
	return usable[other] ? other : null;
}

/**
 * The message that starts a Storm run. Only line 1 may carry a magic keyword: the team contract sits in an XML
 * section, which omp's keyword matcher skips, so the rules can never trigger a second workflow.
 */
export function buildHandoff(input: {
	runId: string;
	config: StormConfig;
	hash: string;
	task: string;
	keyword: "workflowz" | "orchestrate" | null;
}): string {
	const { config } = input;
	const short = input.hash.replace(/^jcs-sha256:/, "").slice(0, 12);
	// Effort is per model and chosen at spawn, so the team line names only the role, its workers and its context cap.
	const team = Object.entries(config.roles).map(([key, role]) => {
		const spec = ROLES.find(r => r.id === key) ?? ROLES.find(r => r.agent === role.agent);
		const use = spec ? ROLE_USE[spec.id] : undefined;
		const range = workerRange(key, role);
		const cap = Math.round(contextCapFor(config, key, undefined) / 1000);
		return `- ${role.agent}: ${spec?.title ?? key}${use ? `(${use})` : ""}, 기본 ${range.min} · 최대 ${range.max}개 · 컨텍스트 상한 ${cap}k 토큰`;
	});
	const usable = new Set<RoleId>(ROLES.filter(r => r.id in config.roles).map(r => r.id));
	for (const spec of ROLES) {
		if (spec.id in config.roles || config.disabledRoles?.includes(spec.id)) continue;
		const standIn = ROLE_STAND_INS[spec.id].find(id => usableRole(config, id));
		if (standIn === undefined) continue;
		usable.add(spec.id);
		team.push(`- ${spec.agent}: ${spec.title}(${ROLE_USE[spec.id]}), 설정에 없어 ${standIn} 역할 모델로 실행`);
	}
	const disabled = ROLES.filter(r => config.disabledRoles?.includes(r.id));
	if (disabled.length) {
		team.push(`- 쓰지 않음: ${disabled.map(r => `${r.agent}(${r.title})`).join(", ")}. 띄우지 않습니다.`);
	}
	const duties = [
		usable.has("implementer") ? "수정은 storm-implementer" : "",
		usable.has("quick") ? "작고 기계적인 수정은 storm-quick" : "",
		usable.has("explorer") ? "넓은 탐색은 storm-explorer" : "",
		usable.has("reviewer") ? "리뷰는 storm-reviewer" : "",
		usable.has("architect") ? "작업 분해·막힌 디버깅·설계 판단은 storm-architect(비싼 모델이라 꼭 필요할 때만)" : "",
	].filter(Boolean);
	const rules = [
		`- 감독: 이 실행에서 당신은 감독입니다. 작업 트리 파일을 직접 고치지 않습니다(edit·write·ast_edit 는 막혀 있습니다). ${duties.join(", ")} 에 맡기고, 결과는 파일을 읽어 검증합니다.`,
		"- bash 는 테스트·빌드 확인·git 조회 같은 검증에만 쓰고, bash 로 파일을 바꾸지 않습니다. 메모는 local:// 에 씁니다.",
		"- 서브에이전트는 위 storm-* 에이전트로만 띄웁니다(task 도구 또는 eval 의 agent()).",
		"- model 을 넘기지 않습니다. 스폰할 때 Storm 이 승인된 모델을 고릅니다.",
		`- 계획 먼저: 스폰하기 전에 storm 도구의 plan 동작으로 실행 계획을 냅니다. 레인(이름·kind·role·files·goal)과 역할별 워커 수를 넣고, 작은 작업은 레인 하나면 됩니다. kind 는 ${laneRoles(config)} 로 이어집니다. 워커는 역할별 최대 안에서 정합니다. 범위 안이면 바로 적용되고, 넘으면 승인 창이 뜹니다. 실행 중 언제든 다시 낼 수 있습니다. 계획 없이 띄우는 스폰은 막힙니다.`,
		`- 동시 상한: 역할별로 계획의 워커 수, 전체로 ${config.parallelism}개까지 서브에이전트가 동시에 돕니다. 넘는 스폰은 Storm 이 막습니다.`,
		config.isolation === "isolated"
			? "- 격리: task 도구의 작업 항목마다 `isolated: true` 를 넣어 각자 격리된 작업 공간에서 일하게 합니다. omp 설정 `task.isolation.enabled` 가 켜져 있어야 적용됩니다."
			: "- 격리 없음: 서브에이전트가 같은 작업 트리를 함께 씁니다.",
		"- 동시에 도는 작업 항목은 서로 다른 파일을 맡게 나눕니다. 같은 파일을 고쳐야 하는 일은 한 항목에 묶거나 순서대로 돌립니다.",
	];
	if (config.budget) rules.push(`- 이 실행 예산 ${formatUsd(config.budget.perRunUsd)}: 넘으면 새 스폰이 막힙니다.`);
	const mapped = Object.entries(BUILTIN_AGENT_ROLES).filter(([, id]) => usableRole(config, id));
	const mappedText = mapped.length ? ` ${mapped.map(([agent, id]) => `${agent} → ${id}`).join(", ")} 역할 모델로 바뀌고,` : "";
	const fallback = config.fallbackRole === undefined ? undefined : config.roles[config.fallbackRole];
	rules.push(
		fallback && fallback.models.length > 0
			? `- 다른 에이전트(task, scout 등)는 승인된 모델로만 실행됩니다. 승인 밖 모델을 요청하면${mappedText} ${mapped.length ? "그 밖의 에이전트는 " : ""}${fallback.agent} 역할의 모델로 바뀝니다.`
			: `- 다른 에이전트(task, scout 등)는 승인된 모델로만 실행됩니다. 승인 밖 모델을 요청하면${mappedText} ${mapped.length ? "그 밖의 에이전트는 " : ""}스폰이 막힙니다.`,
	);
	if ("reviewer" in config.roles) {
		rules.push(
			"- storm-reviewer 의 판정(correct/incorrect)과 P0~P3 지적은 실행 기록에 남습니다. incorrect 판정이나 처리하지 않은 P0 를 남긴 채 실행을 끝내지 않습니다.",
		);
	}
	rules.push(
		"- 컨텍스트 상한: 같은 영역의 후속 작업(리뷰 지적 수정, 두 번째 패스)은 끝난 storm-* 에이전트가 컨텍스트 상한 아래일 때만 그 에이전트에 `write agent://<id>` 로 보냅니다. 상한을 넘은 에이전트로 가는 후속 지시는 Storm 이 막으니, 결과를 요약해 새 에이전트를 띄웁니다. 확실하지 않으면 먼저 storm 도구의 agents 동작으로 확인합니다.",
	);
	const lines = [
		...(input.keyword ? [input.keyword] : []),
		`<storm-run id="${input.runId}" config="${short}">`,
		"이 작업은 승인된 Storm 팀으로 진행합니다.",
		"팀:",
		...team,
		"규칙:",
		...rules,
		"</storm-run>",
		"",
		input.task,
	];
	return lines.join("\n");
}
