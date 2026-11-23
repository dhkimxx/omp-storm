/**
 * The `storm` tool of the main session: `run` queues a Storm run for the end of the turn, `plan` puts a run plan in
 * force (asking the user when it goes past the approved bounds), `brief` stages the director's closeout for the
 * current run, `status` and `agents` report. Team changes are not here: the user makes them through `/storm`.
 */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import { isRecord, teamPriority } from "../config/schema.ts";
import { planChange } from "../plan/change.ts";
import { MAX_LANE_TEXT, type PlanGap, validatePlan } from "../plan/validate.ts";
import { modelWarnings } from "../proposals/build.ts";
import { NEEDS_APPROVAL } from "../proposals/decide.ts";
import { agentRows, renderAgentRows } from "../report/agents.ts";
import { type ActionOutcome, type ActionReply, NO_CONFIG, propose } from "../request/actions.ts";
import { runSpec } from "../request/args.ts";
import { LANE_ROLES, ROLES, roleTitle, workerRange } from "../roles.ts";
import { CLOSEOUT_NEXT_MAX, CLOSEOUT_TEXT_MAX, parseCloseout } from "../runtime/closeout.ts";
import { isApproved, type ProjectState } from "../state.ts";
import type { LaneKind, PlanRequest, RoleId, RunPlan, StormConfig, StormToolAction, StormToolParams } from "../types.ts";
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

const ACTIONS = ["run", "plan", "brief", "status", "agents"] as const satisfies readonly StormToolAction[];
const ROLE_IDS = ROLES.map((r) => r.id) as [RoleId, ...RoleId[]];
const LANE_KINDS = Object.keys(LANE_ROLES) as [LaneKind, ...LaneKind[]];

const DESCRIPTION = `OMP Storm: hand work to the team and direct a run.
- run {task}: user wants team work; task verbatim, then end reply: Storm starts after this turn.
- plan {plan}: required before spawns. lanes [{name, kind, role?, files?, goal?, progress?, isolationReason?}]; workers per role. Lanes share the parent tree: reviews see dirty changes, overlaps are sequenced, never isolated. isolationReason (one safe line) only for an independent experiment kept outside the parent tree, never final review. Replan: same name/kind/role/files/goal; progress is status, new scope needs a name. Past bounds: approval.
- brief {brief}: once after substantial work: result, verification, remaining?, 3 directions (first recommended). Stages only; Storm shows the menu. Skip trivial.
- status: team, approval, runs, trials, subagents.
- agents: session subagents: context cap, follow-up allowance.
Team changes: /storm.`;

function stormParams(z: Zod): StormToolSchema {
	return z.object({
		action: z.enum(ACTIONS).describe("Operation to perform"),
		task: z.string().optional().describe("run: the user's task request, verbatim"),
		plan: z
			.object({
				lanes: z
					.array(
						z.object({
							name: z.string().describe("Unique lane name"),
							kind: z.enum(LANE_KINDS).describe("explore|code|run|review|design"),
							role: z.enum(ROLE_IDS).optional().describe("Role doing the lane; default from kind"),
							files: z.array(z.string()).optional().describe("Files the lane may change"),
							goal: z.string().max(MAX_LANE_TEXT).optional().describe("What the lane delivers; keep it on replan"),
							isolationReason: z
								.string()
								.max(MAX_LANE_TEXT)
								.optional()
								.describe("Only for an independent experiment preserved outside the parent tree; one safe line. Omit to share the tree"),
							progress: z.string().max(MAX_LANE_TEXT).optional().describe("Lane status only; a real scope change needs a new name"),
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reply = await runStormTool(hostFor(ctx), params);
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

export async function runStormTool(host: StormToolHost, params: StormToolInput): Promise<StormToolReply> {
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

/** Lanes and workers of a plan per role, as the director and the dialog read them. */
function planLines(config: StormConfig, plan: RunPlan): string[] {
	const out: string[] = [];
	for (const [role, n] of Object.entries(plan.workers)) {
		const lanes = plan.lanes.filter((l) => l.role === role).map((l) => l.name);
		out.push(`- ${roleTitle(role)}(${role}): 워커 ${n}개/최대 ${workerRange(role, config.roles[role]).max} · 레인 ${lanes.join(", ")}`);
	}
	const isolation = isolationLine(plan);
	if (isolation !== undefined) out.push(isolation);
	return out;
}

/** What lies past the approved bounds, one line each. */
function gapLines(gaps: readonly PlanGap[]): string[] {
	return gaps.map((g) =>
		g.kind === "workers"
			? `- ${roleTitle(g.role)}(${g.role}): 워커 ${g.want}개 요청, 최대 ${g.max}`
			: `- ${roleTitle(g.role)}(${g.role}): ${g.state === "disabled" ? "사용 안 함으로 설정된 역할" : "팀 설정에 없는 역할"}`,
	);
}

/**
 * Validates a run plan; past the approved bounds the user approves (or cancels) the config change first.
 * The plan goes in force for the active run; outside a run it is only checked.
 */
async function submitPlan(host: StormToolHost, raw: PlanRequest | undefined): Promise<StormToolReply> {
	if (raw === undefined) return rejected("plan이 필요합니다.");
	const cur = await loadCurrent(host);
	if ("outcome" in cur) return cur;
	let config = cur.config;
	let validatedHash = cur.state.config.status === "ok" ? cur.state.config.hash : undefined;
	let check = validatePlan(config, raw, host.now());
	if (check.errors.length) return rejected(`계획이 올바르지 않습니다. 고쳐서 다시 제출하세요.\n${check.errors.map((e) => `- ${e}`).join("\n")}`);
	// A reused lane keeps the identity its evidence is bound to. Refuse before an out-of-bounds plan can open a team
	// config proposal: a status update belongs in progress, and an actual change needs a new lane name.
	const conflict = host.runtime.replanConflict?.(check.plan!);
	if (conflict !== undefined) return rejected(`계획을 적용하지 않았습니다. ${conflict}`);
	const head: string[] = [];
	const gaps = check.outOfBounds;
	if (gaps.length && check.plan) {
		if (!isApproved(cur.state)) return rejected(NEEDS_APPROVAL);
		const adding = gaps.some((g) => g.kind === "role");
		const ctx = adding ? await host.prepare() : undefined;
		const built = planChange(config, gaps, ctx && { recs: ctx.recommend(teamPriority(config)) });
		const maxima = Object.keys(check.plan.workers)
			.filter((id) => config.roles[id])
			.map((id) => `${roleTitle(id)} 최대 ${workerRange(id, config.roles[id]).max}`)
			.join(", ");
		const fit = `승인된 범위 안으로 계획을 줄여 다시 제출하세요(${maxima || "설정된 역할만 쓰세요"}).`;
		if ("error" in built) return rejected(`계획이 승인된 범위를 넘습니다.\n${gapLines(gaps).join("\n")}\n${built.error}\n${fit}`);
		const isolation = isolationLine(check.plan);
		const context = [
			"### 실행 계획",
			...check.plan.lanes.map((l) => `- ${l.name} (${l.kind} → ${roleTitle(l.role)})${l.files?.length ? `: ${l.files.join(", ")}` : ""}`),
			...(isolation === undefined ? [] : [isolation]),
			"",
			"### 범위를 넘는 것",
			...gapLines(gaps),
		].join("\n");
		const reply = await propose(host, cur.state, "plan", built, {
			warnings: [...check.warnings, ...(ctx ? modelWarnings(built.config, ctx) : [])],
			context,
		});
		if (reply.outcome === "cancelled") {
			return { outcome: "cancelled", text: `팀 설정을 바꾸지 않아 계획을 적용하지 않았습니다. 범위를 넘는 것:\n${gapLines(gaps).join("\n")}\n${fit}` };
		}
		if (reply.outcome !== "approved") return reply;
		head.push(reply.text);
		const fresh = await loadCurrent(host);
		if ("outcome" in fresh) return fresh;
		config = fresh.config;
		validatedHash = fresh.state.config.status === "ok" ? fresh.state.config.hash : validatedHash;
		check = validatePlan(config, raw, host.now());
		if (check.errors.length || check.outOfBounds.length) {
			return rejected(`${head.join("\n")}\n저장한 팀 설정으로도 계획이 범위를 넘습니다. 다시 제출하세요.\n${[...check.errors.map((e) => `- ${e}`), ...gapLines(check.outOfBounds)].join("\n")}`);
		}
	}
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
			outcome: head.length ? "approved" : "ok",
			text: [...head, `자동 위임 실행(${started.runId})을 열고 계획을 적용했습니다. 이 계획 범위 안에서 승인된 팀 워커를 스폰하세요.`, ...body].join("\n"),
		};
	}
	const set = host.runtime.setRunPlan(plan);
	if (!set.ok) {
		const saved = head.length ? " 승인한 범위 변경은 저장했습니다." : "";
		return { outcome: head.length ? "approved" : "ok", text: [...head, `실행 중이 아니라 계획을 저장하지 않았습니다(검증만 했습니다).${saved} ${set.reason}`, ...body].join("\n") };
	}
	return { outcome: head.length ? "approved" : "ok", text: [...head, "실행 계획을 적용했습니다. 이 범위 안에서 스폰하세요.", ...body].join("\n") };
}
