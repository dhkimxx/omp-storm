/**
 * The `storm` tool: what `/storm <natural language>` resolves to. Reads answer directly; every
 * config change is a proposal the user approves in a dialog (exact label "승인") or defers.
 * `propose` answers a `<storm-setup>` request with a whole team. Config and approvals are written
 * only through `host.approveAndSave`.
 */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import { configHash } from "../config/canonical.ts";
import { validateConfig } from "../config/schema.ts";
import { buildEvidence } from "../evidence.ts";
import { priorityLabel, renderStatus, roleTitle } from "../interview/render.ts";
import { deriveScope } from "../interview/setup.ts";
import {
	type Built,
	buildBudget,
	buildPriority,
	buildQuota,
	buildReselect,
	buildTrial,
	buildWorkers,
	checkRoleModel,
	effortsOf,
	newProposalId,
	quotaPlan,
} from "../proposals/build.ts";
import { presentProposal } from "../proposals/present.ts";
import { renderModelCheck } from "../report/models.ts";
import { adviseRows, agentsReport } from "../report/agents.ts";
import { parseModelEntry } from "../selector.ts";
import type { ProjectState } from "../state.ts";
import { ROLES } from "../roles.ts";
import type {
	AgentEntry,
	EvidenceRecord,
	LifecycleSettings,
	Proposal,
	ProposalKind,
	RoleId,
	StatusView,
	StormConfig,
	StormToolAction,
	StormToolParams,
} from "../types.ts";
import type { StormToolHost } from "./host.ts";

type Zod = ExtensionAPI["zod"];
/** The parsed shape is checked against `StormToolInput` where the schema is built. */
export type StormToolSchema = ZodLikeSchema<StormToolInput>;

export type StormToolOutcome = "ok" | "approved" | "deferred" | "cancelled" | "rejected" | "queued";
export interface StormToolDetails {
	action: StormToolAction;
	outcome: StormToolOutcome;
}
export interface StormToolReply {
	outcome: StormToolOutcome;
	text: string;
}
/** `StormToolParams` as the schema parses it: optional fields may come back as explicit `undefined`. */
export type StormToolInput = { action: StormToolAction } & {
	[K in Exclude<keyof StormToolParams, "action">]?: StormToolParams[K] | undefined;
};

const ACTIONS = ["status", "models", "priority", "workers", "reselect", "quota", "trial", "budget", "run", "agents", "propose"] as const satisfies readonly StormToolAction[];
const ROLE_IDS = ROLES.map((r) => r.id) as [RoleId, ...RoleId[]];
const QUOTA_MARK_MS = 5 * 3_600_000;
const NO_CONFIG = "Storm 설정이 없습니다(또는 오류). /storm 으로 먼저 팀을 설정하세요.";

const DESCRIPTION = `Manage this project's OMP Storm multi-agent team, or hand a task to a Storm run.
Actions:
- status: team, approval, active/last run, trials, quota marks, pending proposals, subagents of this session.
- models: check configured models for newer versions, better/cheaper/faster alternatives and upgrades that need another provider login. Slow (reads usage history).
- priority {priority}: re-recommend every role's model for a new optimization priority.
- workers {role, workers}: how many workers of a role one run may keep busy (1-16).
- reselect {role, model?}: change a role's model; omit model to let the user pick from recommendations.
- quota {provider}: the user says a provider ran out of quota. Approved fallbacks go first for 5 hours; roles without one get a fallback proposal.
- trial {role, model, share?, maxSpawns?, days?, budgetUsd?}: route a bounded share of a role's spawns to a candidate model for a while (defaults 0.25, 20 spawns, 7 days, $2).
- budget {budgetUsd, warnAtUsd?, onExceed?}: per-run spend limit; 0 removes it.
- run {task}: the user wants work done by the Storm team. Call it, then end your reply at once; never do the task yourself in the same turn. Storm starts the run with the approved team contract right after.
- agents: subagents of this session with lifecycle advice (reuse / fresh / cleanup) and warnings on omp's idle park vs prompt cache. Before giving new work to a subagent, check for a reusable one: follow-ups in the same area (fixing review findings, a second pass) go to the finished agent via \`write agent://<id>\` (or the eval handle's .send()) instead of a new spawn.
- propose {config, rationale}: only to answer a <storm-setup> request, after interviewing the user with the ask tool. config is the whole team (same shape as <storm-recommended-config>), rationale explains it in Korean. The user approves or cancels it in Storm's dialog.
priority, workers, reselect, trial, budget (and quota when new models are needed) only propose: the user sees a diff and approves or defers it in a dialog. Do not ask for approval yourself; relay the result as returned and never claim a change was saved unless the result says so.
Setting the team up (again), rolling back to an earlier approval and resetting Storm are not actions: tell the user to type /storm.`;

function stormParams(z: Zod): StormToolSchema {
	return z.object({
		action: z.enum(ACTIONS).describe("Operation to perform"),
		priority: z.enum(["balanced", "quality", "cost", "speed", "quota"]).optional().describe("priority: new optimization priority"),
		role: z.enum(ROLE_IDS).optional().describe("workers, reselect, trial: target role (must be configured, not disabled)"),
		workers: z.number().optional().describe("workers: absolute worker count for the role (1-16)"),
		model: z.string().optional().describe('reselect: model the user named; trial: candidate. "provider/id"'),
		provider: z.string().optional().describe("quota: provider that ran out"),
		share: z.number().optional().describe("trial: fraction of the role's spawns routed to the candidate (0-1]"),
		maxSpawns: z.number().optional().describe("trial: spawn cap for the candidate (1-1000)"),
		days: z.number().optional().describe("trial: duration in days (1-30)"),
		budgetUsd: z.number().optional().describe("trial: spend cap in USD; budget: per-run limit in USD, 0 removes it"),
		warnAtUsd: z.number().optional().describe("budget: warn at this run spend (below budgetUsd)"),
		onExceed: z.enum(["block-spawns", "stop"]).optional().describe("budget: what happens past the limit"),
		task: z.string().optional().describe("run: the user's task request, verbatim"),
		config: z.record(z.string(), z.unknown()).optional().describe("propose: the whole team as a Storm config object"),
		rationale: z.string().optional().describe("propose: why this team, in Korean"),
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
		// Off until a Storm project's main session (or a /storm request) turns it on, so other sessions never carry its schema.
		defaultInactive: true,
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reply = await runStormTool(hostFor(ctx), params);
			return { content: [{ type: "text", text: reply.text }], details: { action: params.action, outcome: reply.outcome } };
		},
	};
}

const rejected = (text: string): StormToolReply => ({ outcome: "rejected", text });

interface Current {
	state: ProjectState;
	config: StormConfig;
	hash: string;
}

/** What a proposal is built on: the current config, or none for a first setup (or over an invalid file). */
interface Base {
	state: ProjectState;
	config: StormConfig | undefined;
	hash: string | null;
}

async function loadCurrent(host: StormToolHost): Promise<Current | StormToolReply> {
	const state = await host.loadState();
	if (state.config.status !== "ok") return rejected(NO_CONFIG);
	return { state, config: state.config.config, hash: state.config.hash };
}

function shortHash(hash: string): string {
	return hash.replace(/^jcs-sha256:/, "").slice(0, 12);
}

function sameShadows(a: ProjectState["shadows"], b: ProjectState["shadows"]): boolean {
	const key = (s: ProjectState["shadows"]) => s.map((x) => `${x.path}\n${x.sha256}`).sort().join("\n");
	return key(a) === key(b);
}

/** Validates, shows and asks; writes only on the exact approval label and only if nothing moved underneath. */
async function propose(
	host: StormToolHost,
	cur: Base,
	kind: ProposalKind,
	built: Built,
	evidence?: EvidenceRecord,
	warnings: string[] = [],
): Promise<StormToolReply> {
	if ("error" in built) return rejected(built.error);
	const next = built.config;
	const checked = validateConfig(next);
	if (!checked.config) return rejected(`제안한 설정이 올바르지 않습니다: ${checked.errors.join("; ")}`);
	// A setup proposal of the current but unapproved config still needs the dialog: approving it is the change.
	if (configHash(next) === cur.hash && (kind !== "setup" || cur.state.approval)) {
		return { outcome: "ok", text: "이미 그 설정입니다. 바꿀 것이 없습니다." };
	}
	const now = host.now();
	const proposal: Proposal = {
		schema: "storm.proposal/v1",
		id: newProposalId(now),
		kind,
		createdAt: new Date(now).toISOString(),
		summary: built.summary,
		baseHash: cur.hash ?? "",
		config: next,
	};
	if (evidence) proposal.evidence = evidence;

	const answer = await presentProposal(host.ui, proposal, cur.config, { shadows: cur.state.shadows, warnings: [...checked.warnings, ...warnings] });
	if (answer === "cancelled") return { outcome: "cancelled", text: "바꾸지 않았습니다." };
	if (answer === "deferred") {
		await host.proposals.save(proposal);
		return { outcome: "deferred", text: `${built.summary}\n보류했습니다. /storm 메뉴에서 승인할 수 있습니다.` };
	}
	const fresh = await host.loadState();
	const freshHash = fresh.config.status === "ok" ? fresh.config.hash : null;
	if (freshHash !== cur.hash || !sameShadows(fresh.shadows, cur.state.shadows)) {
		return rejected("승인하는 사이 설정이나 가림 정의가 바뀌어 적용하지 않았습니다. 다시 요청하세요.");
	}
	const hash = await host.approveAndSave(fresh, next, deriveScope(next, fresh.shadows), evidence);
	return { outcome: "approved", text: `${built.summary}\n승인하고 저장했습니다(${shortHash(hash)}).` };
}

/** A whole team from a `<storm-setup>` interview; works without a current config. */
async function proposeSetup(host: StormToolHost, params: StormToolInput): Promise<StormToolReply> {
	if (params.config === undefined) return rejected("config가 필요합니다. <storm-setup> 요청에 답할 때만 propose를 쓰세요.");
	const checked = validateConfig(params.config);
	if (!checked.config) return rejected(`설정이 올바르지 않습니다. 고쳐서 다시 제안하세요: ${checked.errors.join("; ")}`);
	const config = checked.config;
	const state = await host.loadState();
	const ok = state.config.status === "ok" ? state.config : undefined;
	const ctx = await host.prepare();
	const available = new Set(ctx.available.map((m) => m.selector));
	const used = [...Object.values(config.roles).flatMap((r) => r.models), ...(config.trials ?? []).map((t) => t.model)];
	const unknown = [...new Set(used.map((m) => parseModelEntry(m).selector))].filter((s) => !available.has(s));
	const warnings = unknown.map((s) => `${s}: 지금 쓸 수 있는 모델 목록에 없습니다. 이 모델로는 실행되지 않을 수 있습니다.`);
	const evidence = buildEvidence({
		source: "setup",
		priority: config.priority,
		dataAsOf: ctx.usage.dataAsOf,
		recommendations: ctx.recommend(config.priority),
		config,
		now: host.now(),
	});
	const rationale = params.rationale?.trim();
	if (rationale) evidence.rationale = rationale;
	const summary = `Storm 팀 ${ok ? "재설정" : "설정"} 제안 (${priorityLabel(config.priority)})`;
	const reply = await propose(host, { state, config: ok?.config, hash: ok?.hash ?? null }, "setup", { config, summary }, evidence, warnings);
	if (reply.outcome === "cancelled") return { outcome: "cancelled", text: "저장하지 않았습니다. 바뀐 것은 없습니다." };
	return reply;
}

export async function runStormTool(host: StormToolHost, params: StormToolInput): Promise<StormToolReply> {
	switch (params.action) {
		case "status": {
			const state = await host.loadState();
			const [lastRun, trials, quotaMarks, pending] = await Promise.all([
				host.runtime.lastRun(),
				host.runtime.trials(),
				host.runtime.quotaMarks(),
				host.proposals.list(),
			]);
			// Quota is left out: reading it costs seconds; `models` and setup read it.
			const view: StatusView = {
				repo: state.repo,
				config: state.config,
				approval: state.approval,
				shadows: state.shadows,
				quota: [],
				dataAsOf: null,
				trials,
				quotaMarks,
				pending,
			};
			const run = host.runtime.activeRun();
			if (run) view.run = run;
			if (lastRun) view.lastRun = lastRun;
			const entries = host.runtime.agents();
			if (entries.length) {
				const settings = await host.lifecycleSettings();
				view.agents = agentRows(host, entries, settings);
				view.lifecycle = settings;
			}
			return { outcome: "ok", text: renderStatus(view, host.now()) };
		}
		case "agents": {
			const [settings, state] = await Promise.all([host.lifecycleSettings(), host.loadState()]);
			const config = state.config.status === "ok" ? state.config.config : undefined;
			const text = agentsReport(host.runtime.agents(), {
				now: host.now(),
				settings,
				cost: (m) => host.modelCost(m),
				...(config ? { config } : {}),
			});
			return { outcome: "ok", text };
		}
		case "models": {
			const state = await host.loadState();
			const ctx = await host.prepare();
			return { outcome: "ok", text: renderModelCheck(ctx, state.config.status === "ok" ? state.config.config : undefined) };
		}
		case "run": {
			const task = params.task?.trim() ?? "";
			if (!task) return rejected("실행할 작업 내용이 비어 있습니다.");
			const r = host.runtime.requestRun(task);
			if (!r.ok) return rejected(r.reason);
			return {
				outcome: "queued",
				text:
					`Storm 실행을 예약했습니다(${r.runId}). 이 작업을 지금 직접 하지 말고 응답을 바로 마치세요. ` +
					"응답이 끝나면 Storm이 승인된 팀 계약으로 실행을 시작합니다.",
			};
		}
		case "propose":
			return proposeSetup(host, params);
		default:
			return write(host, params);
	}
}

function agentRows(host: StormToolHost, entries: AgentEntry[], settings: LifecycleSettings): NonNullable<StatusView["agents"]> {
	return adviseRows(entries, { now: host.now(), settings, cost: (m) => host.modelCost(m) });
}

async function write(host: StormToolHost, params: StormToolInput): Promise<StormToolReply> {
	const cur = await loadCurrent(host);
	if ("outcome" in cur) return cur;
	const { config } = cur;
	const role = params.role;
	if (role !== undefined && !config.roles[role]) return rejected(`${roleTitle(role)}: 설정에 없는 역할입니다.`);

	switch (params.action) {
		case "priority": {
			if (!params.priority) return rejected("priority가 필요합니다.");
			const ctx = await host.prepare();
			const recs = ctx.recommend(params.priority).filter((r) => r.role.id in config.roles);
			const built = buildPriority(config, params.priority, recs, (s) => effortsOf(ctx.checkModel, s));
			if ("error" in built) return rejected(built.error);
			const evidence = buildEvidence({
				source: "priority",
				priority: params.priority,
				dataAsOf: ctx.usage.dataAsOf,
				recommendations: recs,
				config: built.config,
				now: host.now(),
			});
			return propose(host, cur, "priority", built, evidence);
		}
		case "workers": {
			if (role === undefined || params.workers === undefined) return rejected("role과 workers가 필요합니다.");
			return propose(host, cur, "workers", buildWorkers(config, role, params.workers));
		}
		case "reselect": {
			if (role === undefined) return rejected("role이 필요합니다.");
			const ctx = await host.prepare();
			const rec = ctx.recommend(config.priority).find((r) => r.role.id === role);
			let built: Built;
			if (params.model !== undefined) {
				const model = params.model.trim();
				const check = checkRoleModel(role, model, ctx.checkModel, ctx.available);
				if (!check.ok) return rejected(check.reason);
				built = buildReselect(config, role, model, check.efforts);
			} else {
				if (!rec?.candidates.length) return rejected(`${roleTitle(role)} 역할에 추천할 후보가 없습니다. 모델을 직접 지정하세요.`);
				const first = config.roles[role]!.models[0];
				const current = first === undefined ? undefined : parseModelEntry(first).selector;
				const labels = rec.candidates.map((c) => `${c.label} (${c.selector})${c.selector === current ? " · 현재" : ""}`);
				const answer = await host.ui.select(`${roleTitle(role)} 역할 모델 선택`, [...labels, "취소"]);
				const picked = answer === undefined ? undefined : rec.candidates[labels.indexOf(answer)];
				if (!picked) return { outcome: "cancelled", text: "바꾸지 않았습니다." };
				built = buildReselect(config, role, picked.selector, effortsOf(ctx.checkModel, picked.selector));
			}
			if ("error" in built) return rejected(built.error);
			const evidence = rec
				? buildEvidence({
						source: "reselect",
						priority: config.priority,
						dataAsOf: ctx.usage.dataAsOf,
						recommendations: [rec],
						config: built.config,
						now: host.now(),
					})
				: undefined;
			return propose(host, cur, "reselect", built, evidence);
		}
		case "quota":
			return quota(host, cur, params.provider?.trim() ?? "");
		case "trial": {
			if (role === undefined || params.model === undefined) return rejected("role과 model이 필요합니다.");
			const model = params.model.trim();
			const ctx = await host.prepare();
			const check = checkRoleModel(role, model, ctx.checkModel, ctx.available);
			if (!check.ok) return rejected(check.reason);
			return propose(
				host,
				cur,
				"trial",
				buildTrial(config, {
					role,
					model,
					efforts: check.efforts,
					share: params.share,
					maxSpawns: params.maxSpawns,
					days: params.days,
					budgetUsd: params.budgetUsd,
					now: host.now(),
				}),
			);
		}
		case "budget": {
			if (params.budgetUsd === undefined) return rejected("budgetUsd가 필요합니다(0은 예산 해제).");
			return propose(host, cur, "budget", buildBudget(config, params.budgetUsd, params.warnAtUsd, params.onExceed));
		}
		default:
			return rejected(`알 수 없는 동작: ${params.action}`);
	}
}

/**
 * A quota mark only reorders approved models, so it needs no approval. Roles with no approved model
 * off the provider get a proposal adding one; once approved, the mark puts it first until it lapses.
 */
async function quota(host: StormToolHost, cur: Current, provider: string): Promise<StormToolReply> {
	if (!provider) return rejected("provider가 필요합니다.");
	const plan = quotaPlan(cur.config, provider);
	if (!plan.length) return { outcome: "ok", text: `${provider}를 기본 모델로 쓰는 역할이 없습니다. 바꿀 것이 없습니다.` };
	const now = host.now();
	await host.runtime.addQuotaMark({
		provider,
		source: "user",
		markedAt: new Date(now).toISOString(),
		until: new Date(now + QUOTA_MARK_MS).toISOString(),
	});
	const lines = [`${provider} 쿼터 소진으로 표시했습니다. 표시는 5시간 뒤 만료됩니다.`];
	for (const p of plan) if (p.alternative) lines.push(`- ${roleTitle(p.role)}: ${p.from} → ${p.alternative}`);
	const missing = plan.filter((p) => !p.alternative).map((p) => p.role);
	if (!missing.length) return { outcome: "ok", text: lines.join("\n") };

	lines.push(`- 승인된 다른 Provider 모델이 없는 역할: ${missing.map(roleTitle).join(", ")}`);
	const ctx = await host.prepare();
	const recs = ctx.recommend(cur.config.priority).filter((r) => missing.includes(r.role.id));
	const built = buildQuota(cur.config, provider, missing, recs);
	if ("error" in built) return rejected(`${lines.join("\n")}\n${built.error}`);
	const evidence = buildEvidence({
		source: "quota",
		priority: cur.config.priority,
		dataAsOf: ctx.usage.dataAsOf,
		recommendations: recs,
		config: built.config,
		now,
	});
	const reply = await propose(host, cur, "quota", built, evidence);
	return { outcome: reply.outcome, text: `${lines.join("\n")}\n${reply.text}` };
}
