/**
 * The `storm` tool of the main session: `run` queues a Storm run for the end of the turn, `plan` puts a run plan in
 * force (asking the user when it goes past the approved bounds), `status` and `agents` report. Team changes are not
 * here: the user makes them through `/storm`.
 */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import { isRecord, teamPriority } from "../config/schema.ts";
import { planChange } from "../plan/change.ts";
import { type PlanGap, validatePlan } from "../plan/validate.ts";
import { modelWarnings } from "../proposals/build.ts";
import { NEEDS_APPROVAL } from "../proposals/decide.ts";
import { agentRows, renderAgentRows } from "../report/agents.ts";
import { type ActionOutcome, type ActionReply, NO_CONFIG, propose } from "../request/actions.ts";
import { runSpec } from "../request/args.ts";
import { LANE_ROLES, ROLES, roleTitle, workerRange } from "../roles.ts";
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

const ACTIONS = ["run", "plan", "status", "agents"] as const satisfies readonly StormToolAction[];
const ROLE_IDS = ROLES.map((r) => r.id) as [RoleId, ...RoleId[]];
const LANE_KINDS = Object.keys(LANE_ROLES) as [LaneKind, ...LaneKind[]];

const DESCRIPTION = `OMP Storm: hand work to this project's approved multi-agent team, and direct a run.
- run {task}: the user wants work done by the team. task: the request verbatim. Call it, then end your reply at once: Storm starts the run after this turn.
- plan {plan}: required during a run before any spawn. lanes [{name, kind, role?, files?, goal?}], kind explore|code|run|review|design; workers: live agents per role. Past the approved bounds the user approves a config change in a dialog. Resubmit when the plan changes.
- status: team, approval, runs, trials, subagents.
- agents: this session's subagents: context against the cap, whether a follow-up is allowed.
Team setup and changes are the user's, through /storm.`;

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
							goal: z.string().optional().describe("What the lane delivers"),
						}),
					)
					.describe("1-50 lanes"),
				workers: z.record(z.string(), z.number()).optional().describe("Live agents per role id used by the lanes"),
				note: z.string().optional(),
			})
			.optional()
			.describe("plan: the run plan"),
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
		// Reports change nothing; a run or a plan does.
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
	}
}

/** Lanes and workers of a plan per role, as the director and the dialog read them. */
function planLines(config: StormConfig, plan: RunPlan): string[] {
	const out: string[] = [];
	for (const [role, n] of Object.entries(plan.workers)) {
		const lanes = plan.lanes.filter((l) => l.role === role).map((l) => l.name);
		out.push(`- ${roleTitle(role)}(${role}): 워커 ${n}개/최대 ${workerRange(role, config.roles[role]).max} · 레인 ${lanes.join(", ")}`);
	}
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
		const context = ["### 실행 계획", ...check.plan.lanes.map((l) => `- ${l.name} (${l.kind} → ${roleTitle(l.role)})${l.files?.length ? `: ${l.files.join(", ")}` : ""}`), "", "### 범위를 넘는 것", ...gapLines(gaps)].join("\n");
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
