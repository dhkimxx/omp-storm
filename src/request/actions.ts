/**
 * Team changes a `/storm <request>` resolves to: priority, workers, model reselection, quota marks, trials, budget
 * and switches. Each builds a config with the builders and goes through `decideProposal`, so nothing is saved
 * without the exact approval label. The storm tool's plan action uses the same `propose` for out-of-bounds plans.
 */
import { shortHash } from "../config/canonical.ts";
import { isRecord, teamPriority } from "../config/schema.ts";
import { time } from "../view/render.ts";
import {
	type Built,
	buildBudget,
	buildPriority,
	buildQuota,
	buildReselect,
	buildSettings,
	buildTrial,
	buildWorkers,
	checkRoleModel,
	effortsOf,
	missingRole,
	modelWarnings,
	providerOf,
	quotaPlan,
} from "../proposals/build.ts";
import { type DecideHost, decideProposal, NEEDS_APPROVAL } from "../proposals/decide.ts";
import { ROLES, roleTitle } from "../roles.ts";
import { FALLBACK_MARK_MS } from "../runtime/quota-auto.ts";
import { parseModelEntry } from "../selector.ts";
import { isApproved, type ProjectState } from "../state.ts";
import {
	type AnalysisContext,
	type BudgetConfig,
	PRIORITIES,
	type Priority,
	type ProposalKind,
	type QuotaMark,
	type QuotaStatus,
	type RoleId,
	type StormConfig,
} from "../types.ts";

export type ActionOutcome = "ok" | "approved" | "cancelled" | "rejected";
export interface ActionReply<Outcome extends string = ActionOutcome> {
	outcome: Outcome;
	text: string;
}

export type ChangeAction =
	| { action: "priority"; priority: Priority }
	| { action: "workers"; role: RoleId; min?: number; max?: number }
	| { action: "reselect"; role: RoleId; model?: string }
	| { action: "quota"; provider: string }
	| { action: "trial"; role: RoleId; model: string; share?: number; maxSpawns?: number; days?: number; budgetUsd?: number }
	| { action: "budget"; budgetUsd: number; warnAtUsd?: number; onExceed?: BudgetConfig["onExceed"] }
	| { action: "settings"; cleanup?: boolean; docs?: boolean };

export const CHANGE_ACTIONS = ["priority", "workers", "reselect", "quota", "trial", "budget", "settings"] as const satisfies readonly ChangeAction["action"][];

export interface ActionHost extends DecideHost {
	now(): number;
	/** Reads catalog, quota and usage, then analyzes. Slow (seconds); may refresh omp's stats DB. */
	prepare(): Promise<AnalysisContext>;
	addQuotaMark(mark: QuotaMark): Promise<void>;
	/** omp's own quota view: when an exhausted provider resets. Empty when it cannot be read. */
	quota(): Promise<QuotaStatus[]>;
}

export const NO_CONFIG = "Storm 팀 설정이 없거나 오류가 있습니다. /storm 으로 먼저 팀을 설정해야 합니다.";
export const NOTHING_CHANGED = "바꾸지 않았습니다. 바뀐 것은 없습니다.";

const rejected = (text: string): ActionReply => ({ outcome: "rejected", text });

/** Runs a built change through the shared approval path and words the result. */
export async function propose(
	host: DecideHost,
	state: ProjectState,
	kind: ProposalKind,
	built: Built,
	opts: { warnings?: readonly string[]; context?: string } = {},
): Promise<ActionReply> {
	if ("error" in built) return rejected(built.error);
	const decision = await decideProposal(host, state, { kind, summary: built.summary, config: built.config }, opts);
	switch (decision.outcome) {
		case "approved":
			return { outcome: "approved", text: `${built.summary}\n승인하고 저장했습니다(${shortHash(decision.hash)}).` };
		case "unchanged":
			return { outcome: "ok", text: "이미 그 팀 설정입니다. 바꿀 것이 없습니다." };
		case "rejected":
			return rejected(decision.reason);
		default:
			return { outcome: "cancelled", text: NOTHING_CHANGED };
	}
}

const ROLE_IDS: readonly string[] = ROLES.map(role => role.id);

/**
 * Checks a change as a model wrote it (one JSON object): the action's required fields with their types; optional
 * fields that are absent or null are left out, and one of the wrong type makes the whole change invalid.
 */
export function parseChange(raw: unknown): ChangeAction | undefined {
	if (!isRecord(raw)) return undefined;
	let bad = false;
	const field = <T>(key: string, is: (value: unknown) => value is T): T | undefined => {
		const value = raw[key];
		if (value === undefined || value === null) return undefined;
		if (is(value)) return value;
		bad = true;
		return undefined;
	};
	const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
	const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
	const isFlag = (value: unknown): value is boolean => typeof value === "boolean";
	const role = field("role", (value): value is RoleId => typeof value === "string" && ROLE_IDS.includes(value));
	const model = field("model", isText)?.trim();
	const budgetUsd = field("budgetUsd", isNumber);
	let change: ChangeAction | undefined;
	switch (raw.action) {
		case "priority": {
			const priority = field("priority", (value): value is Priority => PRIORITIES.some(p => p === value));
			if (priority) change = { action: "priority", priority };
			break;
		}
		case "workers": {
			const min = field("min", isNumber);
			const max = field("max", isNumber);
			if (role && (min !== undefined || max !== undefined)) {
				change = { action: "workers", role, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
			}
			break;
		}
		case "reselect":
			if (role) change = { action: "reselect", role, ...(model ? { model } : {}) };
			break;
		case "quota": {
			const provider = field("provider", isText)?.trim();
			if (provider) change = { action: "quota", provider };
			break;
		}
		case "trial": {
			const share = field("share", isNumber);
			const maxSpawns = field("maxSpawns", isNumber);
			const days = field("days", isNumber);
			if (role && model) {
				change = {
					action: "trial",
					role,
					model,
					...(share !== undefined ? { share } : {}),
					...(maxSpawns !== undefined ? { maxSpawns } : {}),
					...(days !== undefined ? { days } : {}),
					...(budgetUsd !== undefined ? { budgetUsd } : {}),
				};
			}
			break;
		}
		case "budget": {
			const warnAtUsd = field("warnAtUsd", isNumber);
			const onExceed = field("onExceed", (value): value is BudgetConfig["onExceed"] => value === "block-spawns" || value === "stop");
			if (budgetUsd !== undefined) {
				change = { action: "budget", budgetUsd, ...(warnAtUsd !== undefined ? { warnAtUsd } : {}), ...(onExceed ? { onExceed } : {}) };
			}
			break;
		}
		case "settings": {
			const cleanup = field("cleanup", isFlag);
			const docs = field("docs", isFlag);
			if (cleanup !== undefined || docs !== undefined) {
				change = { action: "settings", ...(cleanup !== undefined ? { cleanup } : {}), ...(docs !== undefined ? { docs } : {}) };
			}
			break;
		}
		default:
			break;
	}
	return bad ? undefined : change;
}

export async function runChange(host: ActionHost, change: ChangeAction): Promise<ActionReply> {
	const state = await host.loadState();
	if (state.config.status !== "ok") return rejected(NO_CONFIG);
	const config = state.config.config;
	if (change.action === "quota") return quota(host, state, config, change.provider.trim());
	// A quota mark only reorders approved models; every other change proposes a diff against an approved config.
	if (!isApproved(state)) return rejected(NEEDS_APPROVAL);
	if ("role" in change && !config.roles[change.role]) return rejected(missingRole(config, change.role));

	switch (change.action) {
		case "priority": {
			const ctx = await host.prepare();
			const built = buildPriority(config, change.priority, ctx.recommend(change.priority));
			return propose(host, state, "priority", built, "error" in built ? {} : { warnings: modelWarnings(built.config, ctx) });
		}
		case "workers":
			return propose(host, state, "workers", buildWorkers(config, change.role, change.min, change.max));
		case "reselect": {
			const { role } = change;
			const ctx = await host.prepare();
			let built: Built;
			if (change.model !== undefined) {
				const check = checkRoleModel(role, change.model, ctx);
				if (!check.ok) return rejected(check.reason);
				built = buildReselect(config, role, change.model, check.efforts);
			} else {
				const rec = ctx.recommend(teamPriority(config)).find(r => r.role.id === role);
				if (!rec?.candidates.length) return rejected(`${roleTitle(role)} 역할에 추천할 후보가 없습니다. 모델을 직접 지정하세요.`);
				const first = config.roles[role]?.models[0];
				const current = first === undefined ? undefined : parseModelEntry(first).selector;
				const labels = rec.candidates.map(c => `${c.label} (${c.selector})${c.selector === current ? " · 현재" : ""}`);
				const answer = await host.ui.select(`${roleTitle(role)} 역할 모델 선택`, [...labels, "취소"]);
				const picked = answer === undefined ? undefined : rec.candidates[labels.indexOf(answer)];
				if (!picked) return { outcome: "cancelled", text: NOTHING_CHANGED };
				built = buildReselect(config, role, picked.selector, effortsOf(ctx.checkModel, picked.selector));
			}
			return propose(host, state, "reselect", built, "error" in built ? {} : { warnings: modelWarnings(built.config, ctx) });
		}
		case "trial": {
			const ctx = await host.prepare();
			const check = checkRoleModel(change.role, change.model, ctx);
			if (!check.ok) return rejected(check.reason);
			const built = buildTrial(config, {
				role: change.role,
				model: change.model,
				efforts: check.efforts,
				share: change.share,
				maxSpawns: change.maxSpawns,
				days: change.days,
				budgetUsd: change.budgetUsd,
				now: host.now(),
			});
			return propose(host, state, "trial", built, "error" in built ? {} : { warnings: modelWarnings(built.config, ctx) });
		}
		case "budget":
			return propose(host, state, "budget", buildBudget(config, change.budgetUsd, change.warnAtUsd, change.onExceed));
		case "settings":
			return propose(host, state, "settings", buildSettings(config, change.cleanup, change.docs));
	}
}

/** The provider as the team's models spell it, whatever case the user typed. */
function teamProvider(config: StormConfig, typed: string): string {
	const wanted = typed.toLowerCase();
	const models = [...Object.values(config.roles).flatMap(role => role.models), ...(config.trials ?? []).map(trial => trial.model)];
	return models.map(providerOf).find(provider => provider.toLowerCase() === wanted) ?? typed;
}

/**
 * A quota mark only reorders approved models, so it needs no approval. It lasts until omp's own reset time for the
 * provider when that is known, else five hours. Roles with no approved model off the provider get a proposal adding
 * one; once approved, the mark puts it first until it lapses.
 */
async function quota(host: ActionHost, state: ProjectState, config: StormConfig, typed: string): Promise<ActionReply> {
	if (!typed) return rejected("provider가 필요합니다.");
	const provider = teamProvider(config, typed);
	const plan = quotaPlan(config, provider);
	if (!plan.length) return { outcome: "ok", text: `Provider ${provider}: 기본 모델로 쓰는 역할이 없습니다. 바꿀 것이 없습니다.` };
	const now = host.now();
	const statuses = await host.quota().catch((): QuotaStatus[] => []);
	const resetsAt = statuses.find(status => status.provider.toLowerCase() === provider.toLowerCase())?.resetsAt ?? null;
	const until = resetsAt !== null && resetsAt > now ? resetsAt : now + FALLBACK_MARK_MS;
	await host.addQuotaMark({ provider, source: "user", markedAt: new Date(now).toISOString(), until: new Date(until).toISOString() });
	const lasts = until === resetsAt ? `omp가 알려 준 초기화 시각(${time(until)})까지` : `${time(until)}까지(5시간)`;
	const lines = [`Provider ${provider}: 쿼터 소진으로 표시했습니다. 표시는 ${lasts} 유지됩니다.`];
	for (const p of plan) if (p.alternative) lines.push(`- ${roleTitle(p.role)}: ${p.from} → ${p.alternative}`);
	const missing = plan.filter(p => !p.alternative).map(p => p.role);
	if (!missing.length) return { outcome: "ok", text: lines.join("\n") };

	lines.push(`- 승인된 다른 Provider 모델이 없는 역할: ${missing.map(roleTitle).join(", ")}`);
	if (!isApproved(state)) return rejected(`${lines.join("\n")}\n${NEEDS_APPROVAL}`);
	const ctx = await host.prepare();
	const recs = ctx.recommend(teamPriority(config)).filter(r => missing.includes(r.role.id));
	const built = buildQuota(config, provider, missing, recs);
	if ("error" in built) return rejected(`${lines.join("\n")}\n${built.error}`);
	const reply = await propose(host, state, "quota", built, { warnings: modelWarnings(built.config, ctx) });
	return { outcome: reply.outcome, text: `${lines.join("\n")}\n${reply.text}` };
}
