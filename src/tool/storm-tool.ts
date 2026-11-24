/**
 * The `storm` tool of the main session: `run` queues a Storm run for the end of the turn, `plan` puts a run plan in
 * force (refusing one past the approved bounds), `brief` stages the director's closeout for the current run,
 * `status` and `agents` report. Team changes are not here: the user makes them through `/storm`.
 */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import { isRecord, MAX_CHECK_NAME_LENGTH } from "../config/schema.ts";
import {
	LANE_NEEDS,
	MAX_LANE_DEPENDENCIES,
	MAX_LANE_RESULTS,
	MAX_LANE_TEXT,
	MAX_RESULT_CONTAINS,
	MAX_RESULT_CRITERION,
	MAX_RESULT_ID,
	MAX_RESULT_PATH,
	type PlanGap,
	RESULT_ID_RE,
	RESULT_KINDS,
	validatePlan,
} from "../plan/validate.ts";
import { agentRows, renderAgentRows } from "../report/agents.ts";
import { type ActionOutcome, type ActionReply, NO_CONFIG } from "../request/actions.ts";
import { runSpec } from "../request/args.ts";
import { LANE_ROLES, ROLES, roleTitle, workerRange } from "../roles.ts";
import { CLOSEOUT_NEXT_MAX, CLOSEOUT_TEXT_MAX, closeoutSessionId, parseCloseout } from "../runtime/closeout.ts";
import type { ProjectState } from "../state.ts";
import type { LaneKind, LaneNeed, LaneResultKind, PlanRequest, RoleId, RunPlan, StormConfig, StormToolAction, StormToolParams } from "../types.ts";
import type { StormToolHost } from "./host.ts";

type Zod = ExtensionAPI["zod"];
/** The parsed shape is checked against `StormToolInput` where the schema is built. */
export type StormToolSchema = ZodLikeSchema<StormToolInput>;

export type StormToolOutcome = ActionOutcome | "queued";
export interface StormToolDetails {
	action: StormToolAction;
	outcome: StormToolOutcome;
}
export type StormToolReply = ActionReply<StormToolOutcome>;
/** `StormToolParams` as the schema parses it: optional fields may come back as explicit `undefined`. */
export type StormToolInput = { action: StormToolAction } & {
	[K in Exclude<keyof StormToolParams, "action">]?: StormToolParams[K] | undefined;
};

const ACTIONS = ["run", "plan", "execute", "brief", "status", "agents"] as const satisfies readonly StormToolAction[];
const ROLE_IDS = ROLES.map((r) => r.id) as [RoleId, ...RoleId[]];
const LANE_KINDS = Object.keys(LANE_ROLES) as [LaneKind, ...LaneKind[]];
const RESULT_KIND_IDS = RESULT_KINDS as unknown as [LaneResultKind, ...LaneResultKind[]];
const LANE_NEED_IDS = LANE_NEEDS as unknown as [LaneNeed, ...LaneNeed[]];

const DESCRIPTION = `OMP Storm: plan, delegate, and close approved work.
- run {task}: queue verbatim request; end turn.
- plan {plan}: before work. Each non-review lane needs results; dependsOn waits for proof. Keep name, kind, role, job, files and goal on replan; progress is status, new scope needs a new name. Review the dirty tree. Sequence overlaps.
- execute {lanes}: ready run lanes with an approved job, not AI workers. Use a pathless answer with an exact stdout contains marker. Exit and marker prove execution only. Batch independent jobs; do not repeat accepted jobs.
- brief {brief}: result, verification, remaining?, three concrete next directions (first recommended). Stages only; skip trivial.
- status: team, approval, runs, approved job names.
- agents: existing workers and follow-up allowance.
Team: /storm.`;

function stormParams(z: Zod): StormToolSchema {
	return z.object({
		action: z.enum(ACTIONS).describe("Operation to perform"),
		task: z.string().optional().describe("run: the user's task request, verbatim"),
		lanes: z.array(z.string().min(1).max(MAX_LANE_TEXT)).min(1).max(50).optional().describe("execute: exact planned job lane names"),
		plan: z
			.object({
				lanes: z
					.array(
						z.object({
							name: z.string().describe("Unique lane name"),
							kind: z.enum(LANE_KINDS).describe("explore|code|run|review|design"),
							role: z.enum(ROLE_IDS).optional().describe("Role doing the lane; default from kind"),
							job: z.string().max(MAX_CHECK_NAME_LENGTH).optional().describe("Approved project job name; use with kind run instead of an AI worker"),
							files: z.array(z.string()).optional().describe("Files the lane may change"),
							goal: z.string().max(MAX_LANE_TEXT).optional().describe("What the lane delivers; keep it on replan"),
							isolationReason: z
								.string()
								.max(MAX_LANE_TEXT)
								.optional()
								.describe("Only for an independent experiment preserved outside the parent tree; one safe line. Omit to share the tree"),
							progress: z.string().max(MAX_LANE_TEXT).optional().describe("Lane status only; a real scope change needs a new name"),
							results: z
								.array(
									z
										.object({
											id: z
												.string()
												.max(MAX_RESULT_ID)
												.regex(RESULT_ID_RE, "id: 영문·숫자로 시작하고 영문·숫자·. _ -만 쓰는 64자 이하 id")
												.describe("Stable plan-wide result id; same id on replan keeps the requirement"),
											kind: z.enum(RESULT_KIND_IDS).describe("change|artifact|answer: where the result is observed"),
											criterion: z
												.string()
												.max(MAX_RESULT_CRITERION)
												.describe("What the attempt must show, as one visible line; never proof by itself"),
											path: z
												.string()
												.max(MAX_RESULT_PATH)
												.optional()
												.describe("Safe workspace-relative path; pathless change uses lane.files; answer may cite a source"),
											contains: z
												.string()
												.max(MAX_RESULT_CONTAINS)
												.optional()
												.describe("Exact literal, whitespace kept; on answer it is matched in the cited source; optional"),
											check: z
												.string()
												.optional()
												.describe("Name of a check in the approved requiredChecks; never a command line"),
										})
										.strict(),
								)
								.min(1)
								.max(MAX_LANE_RESULTS)
								.optional()
								.describe("Required on every non-review lane: observable outcomes; plan input, not evidence"),
							dependsOn: z
								.array(
									z
										.object({
											lane: z.string().min(1).max(MAX_LANE_TEXT).describe("Prerequisite lane name in this plan"),
											need: z
												.enum(LANE_NEED_IDS)
												.describe("result|integrated|reviewable: the state that must hold before this lane starts"),
										})
										.strict(),
								)
								.min(1)
								.max(MAX_LANE_DEPENDENCIES)
								.optional()
								.describe("Prerequisite lanes; plan input, not proof that the need holds"),
						}),
					)
					.describe("1-50 lanes"),
				workers: z.record(z.string(), z.number()).optional().describe("Live agents per role id used by the lanes"),
				note: z.string().optional(),
			})
			.optional()
			.describe("plan: the run plan"),
		brief: z
			.object({
				result: z.string().max(CLOSEOUT_TEXT_MAX).describe("What the run delivered, with evidence locations"),
				verification: z.string().max(CLOSEOUT_TEXT_MAX).describe("What proves it, with evidence locations"),
				remaining: z.string().max(CLOSEOUT_TEXT_MAX).optional().describe("What is still open; omit when nothing is"),
				next: z
					.array(z.string().max(CLOSEOUT_NEXT_MAX))
					.refine(directions => directions.length === 3, "next: 정확히 세 방향이어야 합니다")
					.transform(directions => directions as [string, string, string])
					.describe("Three concrete next directions; the first is recommended"),
			})
			.transform(value => {
				const { remaining, ...rest } = value;
				return remaining === undefined ? rest : { ...rest, remaining };
			})
			.optional()
			.describe("brief: results and the next directions for the current run"),
	});
}

export function createStormTool(
	z: Zod,
	hostFor: (ctx: ExtensionContext) => StormToolHost,
): ToolDefinition<StormToolSchema, StormToolDetails> {
	return {
		name: "storm",
		label: "Storm",
		description: DESCRIPTION,
		parameters: stormParams(z),
		loadMode: "essential",
		// Off until a Storm project's main session turns it on, so other sessions never carry its schema.
		defaultInactive: true,
		// Reports change nothing; a run, a plan or a staged brief does.
		approval: (args) => (isRecord(args) && (args.action === "status" || args.action === "agents") ? "read" : "write"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Storm data belongs to one native main session. A child's own session is never a Storm session, and a host
			// that exposes no identity has nowhere to keep the team: both fail closed without touching the conversation.
			const refusal =
				ctx.agent.kind !== "main"
					? "Storm 도구는 메인 세션에서만 쓸 수 있습니다. 이 서브에이전트의 부모 실행을 통해 결과만 보고하세요."
					: closeoutSessionId(ctx) === undefined
						? "Storm이 이 세션의 id를 확인하지 못해 아무것도 저장하지 않았습니다. 새 대화를 연 뒤 다시 시도하세요."
						: undefined;
			if (refusal !== undefined) {
				return { content: [{ type: "text", text: refusal }], details: { action: params.action, outcome: "rejected" } };
			}
			const reply = await runStormTool(hostFor(ctx), params, signal);
			return { content: [{ type: "text", text: reply.text }], details: { action: params.action, outcome: reply.outcome } };
		},
	};
}

const rejected = (text: string): StormToolReply => ({ outcome: "rejected", text });

/**
 * Automatic delegation has one way to open a run: the first plan, in the same user turn, using the prompt the host
 * reported. `run` would queue a second handoff instead of binding the plan before the turn's first spawn.
 */
const AUTO_RUN_REJECTED =
	"자동 위임에서는 run으로 실행을 예약하지 않습니다. 이번 사용자 요청의 계획을 plan으로 제출하세요. 계획이 같은 턴에서 실행을 열고, 그 범위 안에서 승인된 워커를 스폰할 수 있습니다.";
const AUTO_NO_TASK =
	"자동 위임에서 실행을 열 사용자 요청을 찾지 못했습니다. 계획을 저장하지 않았습니다. 사용자에게 요청을 새로 입력해 달라고 안내하세요. 사진이나 첨부만 있고 글이 없는 요청은 실행으로 열 수 없습니다.";
const BRIEF_INVALID =
	"마무리 보고가 올바르지 않습니다. result(결과), verification(검증 근거), next(구체적인 다음 방향 3개, 첫 번째가 추천)를 증거 위치와 함께 적어 다시 제출하세요. 단순 조회에는 쓰지 않습니다.";
const BRIEF_NO_HOST =
	"이 호스트에서는 마무리 보고를 준비할 수 없습니다. 보고 내용은 응답에 직접 적고, 실행 종료는 Storm에 맡기세요.";
const BRIEF_STAGED =
	"마무리 보고를 준비했습니다. 최종 검증과 실행 종료는 Storm 검증 게이트가 결정합니다. 다음 방향 메뉴는 실행이 끝난 뒤 Storm이 사용자에게 보여주므로 응답에 번호 목록을 다시 쓰지 말고, 검증 전에는 검증됐다고 말하지 마세요. 이후 라운드에서 결과가 바뀌면 새 보고로 다시 제출하세요.";

interface Current {
	state: ProjectState;
	config: StormConfig;
}

async function loadCurrent(host: StormToolHost): Promise<Current | StormToolReply> {
	const state = await host.loadState();
	if (state.config.status !== "ok") return rejected(NO_CONFIG);
	return { state, config: state.config.config };
}

export async function runStormTool(host: StormToolHost, params: StormToolInput, signal?: AbortSignal): Promise<StormToolReply> {
	switch (params.action) {
		// Quota is left out: reading it costs seconds, and `/storm status` shows it.
		case "status":
			return { outcome: "ok", text: await host.statusText({ quota: false }) };
		case "agents": {
			const state = await host.loadState();
			const rows = agentRows(host.runtime.agents(), state.config.status === "ok" ? state.config.config : undefined);
			return { outcome: "ok", text: renderAgentRows(rows, host.now()) };
		}
		case "run": {
			if (host.auto?.().enabled === true) return rejected(AUTO_RUN_REJECTED);
			const spec = runSpec(params.task ?? "");
			if (!spec.ok) return rejected(spec.error);
			// A run can only start once this turn is over, so it is queued for the turn's end.
			const queued = host.runtime.requestRun(spec.spec);
			if (!queued.ok) return rejected(queued.reason);
			return {
				outcome: "queued",
				text:
					`Storm 실행을 예약했습니다(${queued.runId}). 이 작업을 지금 직접 하지 말고 응답을 바로 마치세요. ` +
					"응답이 끝나면 Storm이 승인된 팀으로 실행을 시작합니다.",
			};
		}
		case "plan":
			return submitPlan(host, params.plan);
		case "execute": {
			const lanes = params.lanes;
			if (lanes === undefined || lanes.length === 0 || lanes.length > 50 || new Set(lanes).size !== lanes.length) {
				return rejected("실행할 서로 다른 계획 레인 이름 1~50개가 필요합니다.");
			}
			const reply = await host.runtime.executeJobs?.(lanes, signal);
			return reply?.ok === true ? { outcome: "ok", text: reply.text } : rejected(reply?.reason ?? "이 호스트는 정형 실행을 지원하지 않습니다.");
		}
		case "brief": {
			// Brief only stages a closeout for the current run: it never opens, plans, approves, or ends anything.
			const draft = parseCloseout(params.brief);
			if (draft === undefined) return rejected(BRIEF_INVALID);
			const staged = host.runtime.submitCloseout?.(draft);
			if (staged === undefined) return rejected(BRIEF_NO_HOST);
			if (!staged.ok) return rejected(staged.reason);
			return { outcome: "ok", text: BRIEF_STAGED };
		}
	}
}

/** The one plan line for selective isolation; shared lanes add no line. */
function isolationLine(plan: RunPlan): string | undefined {
	const isolated = plan.lanes.flatMap((l) => (l.isolationReason === undefined ? [] : [`${l.name} — ${l.isolationReason}`]));
	return isolated.length === 0 ? undefined : `- 격리(부모 트리 밖 보존): ${isolated.join(" · ")}`;
}

/** The one plan line for prerequisites; a plan whose lanes declare none adds no line. */
function dependencyLine(plan: RunPlan): string | undefined {
	const edges = plan.lanes.flatMap((lane) =>
		(lane.dependsOn ?? []).map((dependency) => `${lane.name} ← ${dependency.lane}(${dependency.need})`),
	);
	return edges.length === 0 ? undefined : `- 선행: ${edges.join(" · ")}`;
}

/** Lanes and workers of a plan per role, as the director and the dialog read them. */
function planLines(config: StormConfig, plan: RunPlan): string[] {
	const out: string[] = [];
	for (const [role, n] of Object.entries(plan.workers)) {
		const lanes = plan.lanes.filter((l) => l.role === role).map((l) => l.name);
		out.push(`- ${roleTitle(role)}(${role}): 워커 ${n}개/최대 ${workerRange(role, config.roles[role]).max} · 레인 ${lanes.join(", ")}`);
	}
	const jobs = plan.lanes.filter(lane => lane.job !== undefined).map(lane => `${lane.name} ← ${lane.job}`);
	if (jobs.length > 0) out.push(`- 승인된 정형 작업: ${jobs.join(" · ")}`);
	const isolation = isolationLine(plan);
	if (isolation !== undefined) out.push(isolation);
	const dependencies = dependencyLine(plan);
	if (dependencies !== undefined) out.push(dependencies);
	return out;
}

/** What lies past the approved bounds, one line each: the exact role, its used count and the approved max. */
function gapLines(gaps: readonly PlanGap[]): string[] {
	return gaps.map((g) =>
		g.kind === "workers"
			? `- ${roleTitle(g.role)}(${g.role}): 워커 ${g.want}개 사용, 승인된 최대 ${g.max}개`
			: `- ${roleTitle(g.role)}(${g.role}): 승인된 팀에 ${g.state === "disabled" ? "사용 안 함으로 설정된 역할" : "없는 역할"}`,
	);
}

const OUT_OF_BOUNDS = "계획이 승인된 팀 범위를 넘어 적용하지 않았습니다. 팀 설정과 승인은 도구에서 바꾸지 않습니다.";

/** A refused plan changes no config, approval, plan in force or spawn: only a new submitted plan can apply. */
function outOfBoundsReply(config: StormConfig, gaps: readonly PlanGap[]): StormToolReply {
	const approved = Object.keys(config.roles).map((id) => `${roleTitle(id)}(${id})`).join(", ") || "없음";
	return rejected(
		[
			OUT_OF_BOUNDS,
			...gapLines(gaps),
			`- 승인된 역할: ${approved}`,
			"워커 수를 승인된 최대 이하로 줄이거나 같은 역할의 승인된 워커 수만큼 레인을 순차 실행하도록 계획을 다시 제출하세요. 레인이나 필수 결과를 빼지 말고, 레인의 안전 범위(읽기·쓰기·리뷰)를 유지한 채 승인된 역할을 쓰세요. 역할 추가·활성화나 상한 변경은 사용자가 /storm에서 직접 해야 합니다.",
		].join("\n"),
	);
}

/**
 * Validates a run plan. Past the approved bounds it is refused before it can reach the config, approval or run; a
 * valid plan goes in force for the active run, and outside a run it is only checked.
 */
async function submitPlan(host: StormToolHost, raw: PlanRequest | undefined): Promise<StormToolReply> {
	if (raw === undefined) return rejected("plan이 필요합니다.");
	const cur = await loadCurrent(host);
	if ("outcome" in cur) return cur;
	const config = cur.config;
	const validatedHash = cur.state.config.status === "ok" ? cur.state.config.hash : undefined;
	const check = validatePlan(config, raw, host.now());
	if (check.errors.length) return rejected(`계획이 올바르지 않습니다. 고쳐서 다시 제출하세요.\n${check.errors.map((e) => `- ${e}`).join("\n")}`);
	// A reused lane keeps the identity its evidence is bound to. Refuse before the bounds check or any application:
	// a status update belongs in progress, and an actual change needs a new lane name.
	const conflict = host.runtime.replanConflict?.(check.plan!);
	if (conflict !== undefined) return rejected(`계획을 적용하지 않았습니다. ${conflict}`);
	if (check.outOfBounds.length) return outOfBoundsReply(config, check.outOfBounds);
	const plan = check.plan!;
	const body = [`레인 ${plan.lanes.length}개:`, ...planLines(config, plan)];
	if (check.warnings.length) body.push("경고:", ...check.warnings.map((w) => `- ${w}`));
	const auto = host.auto?.();
	if (auto?.enabled === true && host.runtime.runActive?.() === false) {
		// Automatic delegation: this turn's user request is the task, and the plan must be bound before the first spawn.
		const start = host.runtime.startWithPlan;
		if (start === undefined) return rejected("이 호스트에서는 자동 위임 실행을 열 수 없습니다. /storm auto를 끄거나 호스트를 업데이트하세요.");
		const task = auto.task;
		if (task === undefined || task.trim() === "") return rejected(AUTO_NO_TASK);
		const spec = runSpec(task);
		if (!spec.ok) return rejected(spec.error);
		const started = await start(spec.spec, plan, validatedHash);
		if (!started.ok) return rejected(started.reason);
		return {
			outcome: "ok",
			text: [`자동 위임 실행(${started.runId})을 열고 계획을 적용했습니다. 승인된 범위에서 워커를 스폰하거나 정형 레인을 실행하세요.`, ...body].join("\n"),
		};
	}
	const set = await host.runtime.setRunPlan(plan);
	if (!set.ok) {
		return { outcome: "ok", text: [`실행 중이 아니라 계획을 저장하지 않았습니다(검증만 했습니다). ${set.reason}`, ...body].join("\n") };
	}
	return { outcome: "ok", text: ["실행 계획을 적용했습니다. 승인된 범위에서 워커를 스폰하거나 정형 레인을 실행하세요.", ...body].join("\n") };
}
