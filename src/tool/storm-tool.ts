/**
 * The `storm` tool of the main session: `run` queues a Storm run for the end of the turn, `plan` puts a run plan in
 * force (refusing one past the approved bounds), `brief` stages the director's closeout for the current run,
 * `status` and `agents` report. Team changes are not here: the user makes them through `/storm`.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import { isRecord, MAX_CHECK_NAME_LENGTH } from "../config/schema.ts";
import { effectiveAgentTools, lanePolicy, shellReader, shellReaderWhy } from "../policy/capability.ts";
import {
	LANE_NEEDS,
	MAX_LANES,
	MAX_LANE_DEPENDENCIES,
	MAX_LANE_FILES,
	MAX_LANE_NAME,
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
import { LANE_ROLES, ROLES, roleTitle } from "../roles.ts";
import {
	CLOSEOUT_NEXT_COUNT,
	CLOSEOUT_NEXT_MAX,
	CLOSEOUT_RESULT_MAX,
	CLOSEOUT_TEXT_MAX,
	CLOSEOUT_WHY_MAX,
	type CloseoutNext,
	closeoutSessionId,
	parseCloseout,
} from "../runtime/closeout.ts";
import { PLANLESS_NO_TURN_TIME } from "../runtime/planless.ts";
import { LANE_ADDRESS_HINT, PLAN_LANE_NAMES_SHOWN, PLAN_WORKER_COUNT_NOTE } from "../runtime/contract-text.ts";
import { continuedHandoffText } from "../runtime/resume.ts";
import type { ProjectState } from "../state.ts";
import type { LaneKind, LaneNeed, LaneResultKind, PlanRequest, RoleId, RunPlan, ShadowInfo, StormConfig, StormToolAction, StormToolParams } from "../types.ts";
import {
	INTEGRATION_CANDIDATE_ID_RE,
	INTEGRATION_RUN_ID_RE,
	INTEGRATION_SELECTION_MAX,
	integrationIdListProblem,
	type ContinuedRun,
	type StormToolHost,
} from "./host.ts";
import { planPreviewLanes, renderPlanView } from "./plan-view.ts";

type Zod = ExtensionAPI["zod"];
/** The parsed shape is checked against `StormToolInput` where the schema is built. */
export type StormToolSchema = ZodLikeSchema<StormToolInput>;

export type StormToolOutcome = ActionOutcome | "queued";
/** The integration actions share the one storm tool; they are not a second model-facing surface. */
export type StormToolIntegrationAction = "candidates" | "integrate";
export type StormToolAnyAction = StormToolAction | StormToolIntegrationAction;
export interface StormToolDetails {
	action: StormToolAnyAction;
	outcome: StormToolOutcome;
}
export type StormToolReply = ActionReply<StormToolOutcome>;
/** Fields of the integration actions. B adds the same optional names to `StormToolParams`; this local arm keeps E building alone. */
export interface StormToolIntegrationFields {
	/** candidates detail: one exact candidate id. */
	candidateId?: string | undefined;
	/** candidates: read-only history of one run id; never live authority. */
	candidateRunId?: string | undefined;
	/** candidates overview: exclusive exact-ID cursor. */
	candidateAfter?: string | undefined;
	/** integrate: 1-128 distinct exact candidate ids. */
	candidateIds?: readonly string[] | undefined;
}
/** `StormToolParams` as the schema parses it: optional fields may come back as explicit `undefined`. */
export type StormToolInput = { action: StormToolAnyAction } & {
	[K in Exclude<keyof StormToolParams, "action">]?: StormToolParams[K] | undefined;
} & StormToolIntegrationFields;

const ACTIONS = ["run", "plan", "execute", "brief", "status", "agents", "continue", "candidates", "integrate"] as const satisfies readonly StormToolAnyAction[];
const CANDIDATE_ID_MESSAGE = "c1_ 뒤에 소문자 16진수 64자를 쓰는 정확한 후보 id여야 합니다.";
const RUN_ID_MESSAGE = "영문·숫자로 시작하는 120자 이하의 실행 id여야 합니다.";
const ROLE_IDS = ROLES.map((r) => r.id) as [RoleId, ...RoleId[]];
const LANE_KINDS = Object.keys(LANE_ROLES) as [LaneKind, ...LaneKind[]];
const RESULT_KIND_IDS = RESULT_KINDS as unknown as [LaneResultKind, ...LaneResultKind[]];
const LANE_NEED_IDS = LANE_NEEDS as unknown as [LaneNeed, ...LaneNeed[]];
const NEXT_KINDS = ["resume", "run", "user"] as const satisfies readonly CloseoutNext["kind"][];

/** The bundled agent definitions: the same files the start reads the worker's tools from. */
const PLUGIN_AGENTS_DIR = fileURLToPath(new URL("../../agents/", import.meta.url));

const DESCRIPTION = `OMP Storm: plan, delegate, close approved work.
- run {task}: queue the request, then end the turn.
- plan {plan}: opens this turn's run. Lanes declare results; dependsOn waits for proof. A replan keeps name, kind, role, job, files and goal; progress is status only.
- execute {lanes}: approved job lanes, not AI workers; exit and an exact stdout marker prove execution only.
- brief {brief}: stage result, verification, remaining? and 0-3 next, best first; never verifies or ends the run.
- status: team, approval, runs, approved jobs and this run's plan with each result's state.
- continue: reopen an interrupted run once the user asked to go on; plan rules, results carried.
- agents: existing workers and follow-up allowance.
- candidates/integrate: read this run's isolated candidates, or explicitly land exact current-run ids under this live turn.
Team changes: /storm.`;

function stormParams(z: Zod): StormToolSchema {
	return z.object({
		action: z.enum(ACTIONS).describe("Operation"),
		candidateId: z.string().regex(INTEGRATION_CANDIDATE_ID_RE, CANDIDATE_ID_MESSAGE).optional().describe("exact id"),
		candidateRunId: z.string().regex(INTEGRATION_RUN_ID_RE, RUN_ID_MESSAGE).optional().describe("run id"),
		candidateAfter: z.string().regex(INTEGRATION_CANDIDATE_ID_RE, CANDIDATE_ID_MESSAGE).optional().describe("cursor"),
		candidateIds: z
			.array(z.string().regex(INTEGRATION_CANDIDATE_ID_RE, CANDIDATE_ID_MESSAGE))
			.min(1)
			.max(INTEGRATION_SELECTION_MAX)
			.optional()
			.describe("exact ids"),
		task: z.string().optional().describe("run: the request verbatim"),
		lanes: z.array(z.string().min(1).max(MAX_LANE_NAME)).min(1).max(MAX_LANES).optional().describe("execute: planned job lane names"),
		plan: z
			.object({
				lanes: z
					.array(
						z.object({
							name: z.string().min(1).max(MAX_LANE_NAME).describe("Unique lane name"),
							kind: z.enum(LANE_KINDS).describe("explore|code|run|review|design"),
							role: z.enum(ROLE_IDS).optional().describe("lane role"),
							job: z.string().max(MAX_CHECK_NAME_LENGTH).optional().describe("approved job name"),
							files: z.array(z.string()).max(MAX_LANE_FILES).optional().describe("Files the lane may change"),
							goal: z.string().max(MAX_LANE_TEXT).optional().describe("what the lane delivers"),
							isolationReason: z
								.string()
								.max(MAX_LANE_TEXT)
								.optional()
								.describe("isolated experiment"),
							progress: z.string().max(MAX_LANE_TEXT).optional().describe("status only; scope change = new name"),
							results: z
								.array(
									z
										.object({
											id: z
												.string()
												.max(MAX_RESULT_ID)
												.regex(RESULT_ID_RE, "id: 영문·숫자로 시작하고 영문·숫자·. _ -만 쓰는 64자 이하 id")
												.describe("Stable id; same id on replan"),
											kind: z.enum(RESULT_KIND_IDS).describe("change|artifact|answer"),
											criterion: z
												.string()
												.max(MAX_RESULT_CRITERION)
												.describe("visible line; not proof"),
											path: z
												.string()
												.max(MAX_RESULT_PATH)
												.optional()
												.describe("workspace-relative; answer needs a source"),
											contains: z
												.string()
												.max(MAX_RESULT_CONTAINS)
												.optional()
												.describe("exact literal, whitespace kept"),
											check: z
												.string()
												.optional()
												.describe("approved check name"),
										})
										.strict(),
								)
								.min(1)
								.max(MAX_LANE_RESULTS)
								.optional()
								.describe("required on non-review lanes"),
							dependsOn: z
								.array(
									z
										.object({
											lane: z.string().min(1).max(MAX_LANE_NAME).describe("Prerequisite lane in this plan"),
											need: z
												.enum(LANE_NEED_IDS)
												.describe("result|integrated|reviewable"),
										})
										.strict(),
								)
								.min(1)
								.max(MAX_LANE_DEPENDENCIES)
								.optional()
								.describe("prerequisite lanes; not proof"),
						}),
					)
					.max(MAX_LANES)
					.describe(`1-${MAX_LANES} lanes`),
				workers: z.record(z.string(), z.number()).optional().describe("Live agents per lane role"),
				note: z.string().max(MAX_LANE_TEXT).optional(),
			})
			.optional()
			.describe("plan: lanes and workers"),
		brief: z
			.object({
				result: z.string().max(CLOSEOUT_RESULT_MAX).describe("delivered, with locations"),
				verification: z.string().max(CLOSEOUT_TEXT_MAX).describe("What proves it, with locations"),
				remaining: z.string().max(CLOSEOUT_RESULT_MAX).optional().describe("Still open; omit if none"),
				next: z
					.array(
						z
							.object({
								kind: z.enum(NEXT_KINDS),
								task: z.string().max(CLOSEOUT_NEXT_MAX).optional(),
								why: z.string().max(CLOSEOUT_WHY_MAX).optional(),
								text: z.string().max(CLOSEOUT_NEXT_MAX).optional(),
							})
							.strict(),
					)
					.max(CLOSEOUT_NEXT_COUNT)
					.optional()
					.describe("0-3 distinct, best first"),
			})
			.transform(value => {
				const { remaining, next, ...rest } = value;
				// Explicit undefined fields are dropped so the domain parser sees only what was sent.
				const directions = (next ?? []).map(item =>
					Object.fromEntries(Object.entries(item).filter(([, field]) => field !== undefined)),
				) as unknown as CloseoutNext[];
				return remaining === undefined ? { ...rest, next: directions } : { ...rest, remaining, next: directions };
			})
			.optional()
			.describe("brief: result, verification, next"),
	});
}

export function createStormTool(
	z: Zod,
	hostFor: (ctx: ExtensionContext, signal?: AbortSignal, toolCallId?: string) => StormToolHost,
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
			const host = hostFor(ctx, signal, _toolCallId);
			let reply = await runStormTool(host, params, signal);
			const cut = host.checkStartReply?.();
			const lateRefusal = cut instanceof Promise ? await cut : cut;
			if (lateRefusal !== undefined) reply = rejected(lateRefusal);
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
	"run은 턴이 끝난 뒤 시작할 실행을 예약하는데, 자동 위임에서는 이번 턴이 실행의 첫 라운드라 예약하지 않았습니다. 이번 사용자 요청의 계획을 plan으로 제출하세요. 계획이 같은 턴에서 실행을 열고, 그 범위 안에서 승인된 워커를 스폰할 수 있습니다.";
const AUTO_NO_TASK =
	"자동 위임에서 실행을 열 사용자 요청을 찾지 못했습니다. 계획을 저장하지 않았습니다. 사용자에게 요청을 새로 입력해 달라고 안내하세요. 사진이나 첨부만 있고 글이 없는 요청은 실행으로 열 수 없습니다.";
const BRIEF_INVALID =
	"마무리 보고가 올바르지 않습니다. result(결과)와 verification(검증 근거)을 증거 위치와 함께 한 줄씩 적고, next는 서로 다른 0~3개로 다시 제출하세요. 이어 가기는 {kind:\"resume\"}, 새 범위 작업은 {kind:\"run\", task}, 사용자가 직접 할 일은 {kind:\"user\", text}입니다.";
const BRIEF_NO_HOST =
	"이 호스트에서는 마무리 보고를 준비할 수 없습니다. 보고 내용은 응답에 직접 적고, 실행 종료는 Storm에 맡기세요.";
const INTEGRATION_UNAVAILABLE =
	"이 세션에는 격리 통합 기록이나 쓰기 권한이 연결되어 있지 않습니다. 후보를 만들려면 관리 격리 실행을 시작해야 하고, 그 경로가 이 호스트에서 증명되지 않으면 아무것도 시작하지 않습니다. /storm status로 현재 실행을 확인하세요.";
const INTEGRATION_SELECTION_REQUIRED = `통합할 후보 id를 1~${INTEGRATION_SELECTION_MAX}개 정확히 넣으세요. 전체·범위·암시적 선택은 받지 않습니다.`;
const BRIEF_STAGED =
	"마무리 보고를 준비했습니다. 최종 판정과 실행 종료는 Storm 검증 게이트가 결정하고, 실행이 끝나면 Storm이 공식 결과를 먼저 보여줍니다. 짧고 깨끗하게 끝나면 한 줄 기록만 남으니 평소처럼 설명하고, 미해결·잔여 위험이 있거나 오래 걸린 실행은 카드에 이 보고의 결과와 남은 일이 실리므로 응답은 짧게 마치세요. 응답에 번호 목록을 다시 쓰지 말고, 검증 전에는 검증됐다고 말하지 마세요. 이후 라운드에서 결과가 바뀌면 새 보고로 다시 제출하세요.";

/**
 * The turn's user request, or the refusal that says there is none. Every automatic start (a first plan, a continuation)
 * asks this one question: the prompt the host reported for this turn is the user's, and only it opens a run.
 */
function userTurnTask(host: StormToolHost, refusal: string): { task: string; startedAt: number | undefined } | StormToolReply {
	const auto = host.auto?.();
	const task = auto?.task;
	return task === undefined || task.trim() === "" ? rejected(refusal) : { task, startedAt: auto?.turnStartedAt };
}

const CONTINUE_MANUAL =
	"자동 위임이 꺼져 있어 이어 가기는 사용자만 합니다. 사용자가 /storm 에서 이어 가기를 고르면 중단된 실행을 이어 갑니다. 자동 위임을 켜는 것도 /storm 입니다.";
const CONTINUE_ACTIVE = "이 세션에 이미 실행이 진행 중이라 이어 가지 않았습니다.";
const CONTINUE_NO_TURN =
	"이어 갈 근거가 되는 이번 사용자 요청을 찾지 못했습니다. 이어 가지 않았습니다. 사용자에게 이어 가라고 다시 말해 달라고 안내하세요.";
const CONTINUE_NO_HOST = "이 호스트에서는 중단된 실행을 이어 갈 수 없습니다. 사용자가 /storm 에서 이어 가기를 고르게 안내하세요.";

/** What a continued run carried over, in the words the director acts on. Facts and the next step, no plan dump. */
function continuedText(runId: string, carried: ContinuedRun): string {
	// R12: a run with no result rows opens a handoff, not a carry; it must never say the old plan was applied.
	if (carried.mode === "handoff") return continuedHandoffText(runId, carried.from, carried.ended, carried.allExcluded === true);
	const parts = [`이어받은 결과 ${carried.kept}개(현재 근거로 다시 확인함)`, `다시 할 결과 ${carried.reopened}개`];
	if (carried.blocked > 0) parts.push(`막힌 결과 ${carried.blocked}개`);
	const open = carried.open.length === 0 ? "" : ` 남은 레인: ${carried.open.join(", ")}.`;
	return (
		`중단된 실행(${carried.from}, 멈춘 이유: ${carried.ended})을 이어 새 실행(${runId})을 열고 이전 계획을 적용했습니다. ${parts.join(", ")}.${open} ` +
		"작업은 이 레인들의 목표이고, 방금 사용자의 말을 함께 반영하세요. 승인된 범위에서 워커를 스폰하거나 정형 레인을 실행하세요."
	);
}

/**
 * Continues the interrupted run when the user asked the work to go on. It starts a run exactly where a first plan
 * starts one, under the same conditions: automatic delegation, no run active, this turn's own user prompt, and the
 * host's start. The bounds a plan is held to apply to the old plan inside the start.
 */
async function continueRun(host: StormToolHost): Promise<StormToolReply> {
	if (host.auto?.().enabled !== true) return rejected(CONTINUE_MANUAL);
	if (host.runtime.runActive?.() !== false) return rejected(CONTINUE_ACTIVE);
	const turn = userTurnTask(host, CONTINUE_NO_TURN);
	if ("outcome" in turn) return turn;
	// Without a recorded time for the user's message nothing can show that it came after the run stopped: refuse.
	if (turn.startedAt === undefined) return rejected(CONTINUE_NO_TURN);
	const start = host.runtime.continueRun;
	if (start === undefined) return rejected(CONTINUE_NO_HOST);
	const started = await start(turn.task, turn.startedAt);
	if (!started.ok) return rejected(started.reason);
	if (started.continued === undefined) return { outcome: "ok", text: `실행(${started.runId})을 열었습니다.` };
	return { outcome: "ok", text: continuedText(started.runId, started.continued) };
}

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
		case "status": {
			const text = await host.statusText({ quota: false });
			// The plan in force, as submitted, with the states Storm holds: the director's own plan, without a worker.
			const view = host.planView?.();
			const plan = view === undefined ? undefined : renderPlanView(view);
			return { outcome: "ok", text: plan === undefined ? text : `${text}\n\n${plan}` };
		}
		case "agents": {
			const rows = agentRows(host.runtime.agents());
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
		case "continue":
			return continueRun(host);
		case "execute": {
			const lanes = params.lanes;
			if (lanes === undefined || lanes.length === 0 || lanes.length > MAX_LANES || new Set(lanes).size !== lanes.length) {
				return rejected(`실행할 서로 다른 계획 레인 이름 1~${MAX_LANES}개가 필요합니다.`);
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
		case "candidates": {
			const integration = host.integration;
			if (integration === undefined) return rejected(INTEGRATION_UNAVAILABLE);
			if (params.candidateId !== undefined && params.candidateAfter !== undefined) {
				return rejected("candidates는 정확한 후보 하나(candidateId)와 목록 커서(candidateAfter)를 함께 받지 않습니다. 하나만 고르세요.");
			}
			const reply = await integration.candidates(
				{
					...(params.candidateId === undefined ? {} : { candidateId: params.candidateId }),
					...(params.candidateRunId === undefined ? {} : { candidateRunId: params.candidateRunId }),
					...(params.candidateAfter === undefined ? {} : { candidateAfter: params.candidateAfter }),
				},
				signal,
			);
			return reply.outcome === "ok" ? { outcome: "ok", text: reply.text } : rejected(reply.text);
		}
		case "integrate": {
			const integration = host.integration;
			if (integration === undefined) return rejected(INTEGRATION_UNAVAILABLE);
			if (params.candidateId !== undefined || params.candidateRunId !== undefined || params.candidateAfter !== undefined) {
				return rejected("integrate는 candidateIds 하나만 받습니다. 조회용 id·실행·커서를 함께 보내지 마세요.");
			}
			const ids = params.candidateIds;
			if (ids === undefined || ids.length === 0) return rejected(INTEGRATION_SELECTION_REQUIRED);
			// The whole request is refused before any writer: one bad id never lets the valid prefix through.
			const problem = integrationIdListProblem(ids);
			if (problem !== undefined) return rejected(problem);
			const reply = await integration.integrate(ids, signal);
			return reply.outcome === "ok" ? { outcome: "ok", text: reply.text } : rejected(reply.text);
		}
	}
}

/** The one plan line for selective isolation; shared lanes add no line. */
function isolationLine(plan: RunPlan): string | undefined {
	const isolated = plan.lanes.flatMap((l) => (l.isolationReason === undefined ? [] : [`${l.name} — ${l.isolationReason}`]));
	return isolated.length === 0 ? undefined : `- 격리(부모 트리 밖 보존): ${isolated.join(" · ")}`;
}

/**
 * Shared writers the start will run one at a time, and why. It classifies each lane with the same `lanePolicy` the
 * task guard uses (same agent definition, isolation and automatic flag), so what the plan says is what the start does.
 * Two lanes are named when the classification makes one of them an exclusive writer and the plan does not already
 * order them through `dependsOn`. Lanes that only overlap by path are left to the refusal, which names the paths.
 */
function writerOrderLine(config: StormConfig, plan: RunPlan, shadows: readonly ShadowInfo[], auto: boolean): string | undefined {
	const after = new Map(plan.lanes.map(lane => [lane.name, (lane.dependsOn ?? []).map(dependency => dependency.lane)]));
	const ordered = (from: string, to: string, seen = new Set<string>()): boolean => {
		if (seen.has(from)) return false;
		seen.add(from);
		return (after.get(from) ?? []).some(next => next === to || ordered(next, to, seen));
	};
	const writers: { name: string; exclusive: boolean; why: string }[] = [];
	for (const lane of plan.lanes) {
		if (lane.job !== undefined) continue;
		const agent = config.roles[lane.role]?.agent ?? ROLES.find(role => role.id === lane.role)?.agent;
		if (agent === undefined) continue;
		const policy = lanePolicy({
			lane,
			tools: effectiveAgentTools(agent, shadows, PLUGIN_AGENTS_DIR),
			isolated: config.isolation === "isolated" || lane.isolationReason !== undefined,
			auto,
		});
		if (policy.kind === "unknown") writers.push({ name: lane.name, exclusive: true, why: policy.reason });
		// A read lane that may run commands (a review lane or any other) is ordered like an exclusive writer, so the plan says it runs alone.
		else if (shellReader(policy)) writers.push({ name: lane.name, exclusive: true, why: shellReaderWhy(lane) });
		else if (policy.kind === "paths") writers.push({ name: lane.name, exclusive: false, why: "" });
	}
	const serial = writers.filter(a =>
		writers.some(b => b !== a && (a.exclusive || b.exclusive) && !ordered(a.name, b.name) && !ordered(b.name, a.name)),
	);
	const exclusive = serial.filter(writer => writer.exclusive);
	if (exclusive.length === 0) return undefined;
	const names = serial.map(writer => writer.name);
	const shown = names.length > 4 ? `${names.slice(0, 4).join(", ")} 외 ${names.length - 4}개` : names.join(", ");
	const whys = [...new Set(exclusive.map(writer => writer.why))].join("; ");
	return `- 쓰기 순서: ${shown} 레인은 파일 목록과 무관하게 한 번에 하나씩 시작합니다(${whys}). 호출마다 쓰기 레인은 하나만 담고, 읽기 전용 레인은 함께 보내도 됩니다.`;
}

/** Isolated lanes cannot start while omp isolation is off; only a proven `false` is reported, never an unknown. */
function isolationOffLine(plan: RunPlan, enabled: boolean | undefined): string | undefined {
	if (enabled !== false) return undefined;
	const names = plan.lanes.filter(lane => lane.isolationReason !== undefined).map(lane => lane.name);
	if (names.length === 0) return undefined;
	return `- 격리 불가: ${names.join(", ")} 레인은 omp 격리(task.isolation.enabled)가 꺼져 있어 시작할 수 없습니다. 켜는 것은 사용자의 설정이며, 지금은 isolationReason을 빼야 합니다.`;
}

/** The one plan line for prerequisites; a plan whose lanes declare none adds no line. */
function dependencyLine(plan: RunPlan): string | undefined {
	const edges = plan.lanes.flatMap((lane) =>
		(lane.dependsOn ?? []).map((dependency) => `${lane.name} ← ${dependency.lane}(${dependency.need})`),
	);
	return edges.length === 0 ? undefined : `- 선행: ${edges.join(" · ")}`;
}

/** Lanes and workers of a plan per role, as the director and the dialog read them. */
function planLines(plan: RunPlan): string[] {
	const out: string[] = [];
	for (const [role, n] of Object.entries(plan.workers)) {
		const lanes = plan.lanes.filter((l) => l.role === role).map((l) => l.name);
		const shown = lanes.slice(0, PLAN_LANE_NAMES_SHOWN);
		const rest = lanes.length - shown.length;
		// The lane names are what the director addresses; the worker number is a plan fact, never a limit (faults 6/7).
		const laneText = rest > 0 ? `${shown.join(", ")} 외 ${rest}개(전체는 storm status)` : shown.join(", ");
		out.push(`- ${roleTitle(role)}(${role}): 레인 ${lanes.length}개 — ${laneText} · 역할별 워커 ${n}개(${PLAN_WORKER_COUNT_NOTE})`);
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

/** The first line of every plan-mode preview: nothing opened, nothing started, and what ends the preview. */
export const PLAN_PREVIEW_HEAD =
	"[계획 미리 보기] omp 계획 모드라 실행을 열지 않고 계획도 적용하지 않았습니다. 아무것도 시작하지 않았습니다. 계획 모드가 끝난 뒤 같은 계획으로 storm plan을 부르면 실행이 열립니다.";
/** The writer-order section when the policy puts no lane in a one-at-a-time order. */
export const PLAN_PREVIEW_TOGETHER =
	"- 함께 돌기: 한 번에 하나씩 시작해야 하는 레인은 없습니다. 선행 관계를 기다리는 레인과 파일이 겹치는 쓰기는 시작 때 순서가 정해집니다.";

/** Approved models per role the plan uses, in attempt order, as the start would hand them to the workers. */
function roleModelLines(config: StormConfig, plan: RunPlan): string[] {
	const roles = [...new Set(plan.lanes.filter(lane => lane.job === undefined).map(lane => lane.role))];
	return roles.map(role => {
		const models = config.roles[role]?.models ?? [];
		const effort = config.roles[role]?.effort;
		const shown = models.length === 0 ? "승인된 모델 없음" : models.join(" → ");
		return `- ${roleTitle(role)}(${role}): ${shown}${effort === undefined ? "" : ` · 기본 effort ${effort}`}`;
	});
}

/** The isolation the plan needs: the team's own setting, the lanes that ask for a checkout, and omp's switch when proven. */
function isolationNeedLines(config: StormConfig, plan: RunPlan, enabled: boolean | undefined): string[] {
	const lanes = plan.lanes.filter(lane => lane.isolationReason !== undefined).map(lane => lane.name);
	if (config.isolation !== "isolated" && lanes.length === 0) return ["- 격리: 필요 없음(모든 레인이 부모 트리에서 돕니다)."];
	const who = config.isolation === "isolated" ? "팀 설정이 모든 워커를 격리합니다" : `${lanes.join(", ")} 레인이 격리를 요청합니다`;
	const state = enabled === true ? "켜져 있음" : enabled === false ? "꺼져 있음" : "확인하지 못함";
	return [`- 격리: ${who}. omp 격리(task.isolation.enabled)가 필요합니다 — 지금 ${state}.`];
}

/**
 * omp plan mode means the user asked for a plan only (G4): the validated plan is answered as a preview and nothing
 * else happens. The order line comes from the same `writerOrderLine` the applied plan's reply uses.
 */
async function planPreviewReply(host: StormToolHost, cur: Current, plan: RunPlan, warnings: readonly string[], order: string | undefined): Promise<StormToolReply> {
	const config = cur.config;
	const out = [PLAN_PREVIEW_HEAD, `레인 ${plan.lanes.length}개와 결과:`, ...planPreviewLanes(plan), "역할별 모델:", ...roleModelLines(config, plan)];
	out.push("함께 돌 수 있는 레인:", order ?? PLAN_PREVIEW_TOGETHER);
	out.push(...isolationNeedLines(config, plan, host.isolationEnabled?.()));
	const off = isolationOffLine(plan, host.isolationEnabled?.());
	if (off !== undefined) out.push(off);
	if (warnings.length) out.push("경고:", ...warnings.map(w => `- ${w}`));
	const report = await host.preflight?.(cur.state);
	if (report === undefined) {
		if (cur.state.approval?.status !== "active") out.push("시작 전 점검:", "- 막힘: 이 팀 설정은 아직 승인되지 않았습니다. 사용자가 /storm에서 승인해야 시작할 수 있습니다.");
	} else {
		// The preview exists because plan mode is on; that block is the preview's own premise, not a blocker to fix.
		const blocked = report.items.filter(item => item.status === "blocked" && item.mode !== "plan");
		out.push("시작 전 점검:");
		if (blocked.length === 0) out.push("- 막힘 없음.");
		for (const item of blocked) {
			const detail = item.detail === undefined ? "" : ` — ${item.detail}`;
			const command = item.command === undefined ? "" : ` (${item.command})`;
			out.push(`- 막힘: ${item.label}${detail}${command}`);
		}
	}
	return { outcome: "ok", text: out.join("\n") };
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
	const body = [`레인 ${plan.lanes.length}개:`, ...planLines(plan), `- ${LANE_ADDRESS_HINT}`];
	if (check.warnings.length) body.push("경고:", ...check.warnings.map((w) => `- ${w}`));
	const auto = host.auto?.();
	const order = writerOrderLine(config, plan, cur.state.shadows, auto?.enabled === true);
	if (order !== undefined) body.push(order);
	// Plan mode: the user asked for a plan only. Preview it and touch nothing: no run, no plan in force, no start.
	if (host.planMode?.() === true) return planPreviewReply(host, cur, plan, check.warnings, order);
	const off = isolationOffLine(plan, host.isolationEnabled?.());
	if (off !== undefined) body.push(off);
	if (auto?.enabled === true && host.runtime.runActive?.() === false) {
		// Automatic delegation: this turn's user request is the task, and the plan must be bound before the first spawn.
		const start = host.runtime.startWithPlan;
		if (start === undefined) return rejected("이 호스트에서는 자동 위임 실행을 열 수 없습니다. /storm auto를 끄거나 호스트를 업데이트하세요.");
		const turn = userTurnTask(host, AUTO_NO_TASK);
		if ("outcome" in turn) return turn;
		// R9's same-turn rule needs the time the user's message arrived; without it no start can be shown to follow
		// a stop, so the plan is checked but no run opens.
		if (turn.startedAt === undefined) return rejected(PLANLESS_NO_TURN_TIME);
		const spec = runSpec(turn.task);
		if (!spec.ok) return rejected(spec.error);
		const started = await start(spec.spec, plan, validatedHash, turn.startedAt);
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
