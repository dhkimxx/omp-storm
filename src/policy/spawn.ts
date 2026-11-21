import { BUILTIN_AGENT_ROLES, ROLE_AGENT_PREFIX, ROLE_STAND_INS, ROLES, workerRange } from "../roles.ts";
import { activeTrialFor, shouldRouteToTrial } from "../runtime/trials.ts";
import { formatModelEntry, parseModelEntry } from "../selector.ts";
import type {
	AgentEntry,
	Effort,
	QuotaMark,
	SpawnEvent,
	SpawnOutcome,
	SpawnRecord,
	SpawnRuntime,
	SpawnState,
	StormConfig,
} from "../types.ts";

/** "$12.34" at ≥ $1, "$0.0123" below. */
export function formatUsd(usd: number): string {
	return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

/** Drops a trailing ":<effort>" only when it is a known effort, so ids like "x:thinking" stay intact. */
export function stripEffort(pattern: string): string {
	return parseModelEntry(pattern).selector;
}

/** omp model patterns take thinking effort as a ":<level>" suffix on the id part; any existing suffix wins. */
export function withEffort(selector: string, effort: Effort | undefined): string {
	if (!effort || selector.slice(selector.lastIndexOf("/") + 1).includes(":")) return selector;
	return formatModelEntry({ selector, effort });
}

/** Every model the approved config may run: all role models and all trial candidates, without effort. */
export function approvedSelectors(config: StormConfig): Set<string> {
	const out = new Set<string>();
	for (const role of Object.values(config.roles)) for (const m of role.models) out.add(stripEffort(m));
	for (const trial of config.trials ?? []) out.add(stripEffort(trial.model));
	return out;
}

function providerOf(selector: string): string {
	const slash = selector.indexOf("/");
	return slash < 0 ? selector : selector.slice(0, slash);
}

/** Models on providers marked out of quota go last; the order is kept when all or none are marked. */
export function orderByQuota(models: readonly string[], marks: readonly QuotaMark[]): string[] {
	const marked = new Set(marks.map(m => m.provider));
	const fresh = models.filter(m => !marked.has(providerOf(m)));
	if (fresh.length === 0 || fresh.length === models.length) return [...models];
	return [...fresh, ...models.filter(m => marked.has(providerOf(m)))];
}

type Gate =
	| { ok: false; reason: string }
	| { ok: true; config: StormConfig; approved: NonNullable<SpawnState["approval"]> };

/** Config present, valid, and approved for this exact hash. */
function gate(state: SpawnState): Gate {
	const load = state.config;
	if (load.status === "missing") return { ok: false, reason: "Storm 설정이 없습니다. /storm 으로 팀을 설정하세요." };
	if (load.status === "invalid") return { ok: false, reason: `Storm 설정 오류: ${load.errors[0] ?? "알 수 없는 오류"}` };
	const approval = state.approval;
	// An approval for another hash must never authorize the current file.
	if (!approval || approval.status !== "active" || approval.configHash !== load.hash) {
		const short = load.hash.replace(/^jcs-sha256:/, "").slice(0, 12);
		return { ok: false, reason: `승인되지 않은 Storm 설정입니다(${short}). /storm 으로 승인하세요.` };
	}
	return { ok: true, config: load.config, approved: approval };
}

function budgetBlock(runtime: SpawnRuntime): string | undefined {
	const run = runtime.run;
	if (!run?.budget || run.costUsd < run.budget.perRunUsd) return undefined;
	return `Storm 실행 예산 ${formatUsd(run.budget.perRunUsd)}을 넘었습니다(누계 ${formatUsd(run.costUsd)}). 새 스폰을 막습니다.`;
}

function dedupeBySelector(models: readonly string[]): string[] {
	const seen = new Set<string>();
	return models.filter(m => {
		const key = stripEffort(m);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** A configured, enabled role with at least one model. */
export function usableRole(config: StormConfig, id: string): StormConfig["roles"][string] | undefined {
	const role = config.roles[id];
	return role && role.models.length > 0 && !config.disabledRoles?.includes(id) ? role : undefined;
}

/** A spawn decided this recently whose agent has not reported yet still counts as live: it is starting. */
export const PENDING_SPAWN_MS = 120_000;

/** The role a live spawn counts against: a stand-in spawn counts against the role it asked for, not the borrowed one. */
function countedRole(record: SpawnRecord): string | undefined {
	if (record.outcome === "substituted" && record.agent.startsWith(ROLE_AGENT_PREFIX)) {
		return ROLES.find(r => r.agent === record.agent)?.id ?? record.role;
	}
	return record.role;
}

/**
 * Live agents of a run: spawns Storm let through whose agent is running in the ledger, or that have no ledger entry
 * yet and were decided within `PENDING_SPAWN_MS`. Records without a spawn key cannot be matched and do not count.
 */
export function activeAgents(
	spawns: readonly SpawnRecord[],
	agents: readonly AgentEntry[],
	now: number,
): { total: number; byRole: Record<string, number> } {
	const byId = new Map(agents.map(a => [a.id, a]));
	const byRole: Record<string, number> = {};
	let total = 0;
	for (const record of spawns) {
		if (record.outcome === "blocked" || record.spawnKey === undefined) continue;
		const agent = byId.get(record.spawnKey);
		const live = agent ? agent.state === "running" : now - Date.parse(record.ts) < PENDING_SPAWN_MS;
		if (!live) continue;
		total++;
		const role = countedRole(record);
		if (role !== undefined) byRole[role] = (byRole[role] ?? 0) + 1;
	}
	return { total, byRole };
}

/** During a run every Storm-decided spawn waits for the director's run plan. */
function planBlock(runtime: SpawnRuntime): string | undefined {
	if (!runtime.run || runtime.run.plan) return undefined;
	return "실행 계획이 없어 스폰을 막았습니다. 먼저 storm 도구의 plan 동작으로 실행 계획을 내세요: 레인(kind·role·files)과 역할별 워커 수. 작은 작업은 레인 하나면 됩니다.";
}

/** Live agents of the run against the team's parallelism. */
function totalBlock(config: StormConfig, runtime: SpawnRuntime): string | undefined {
	const total = runtime.run?.active?.total ?? 0;
	if (!runtime.run || total < config.parallelism) return undefined;
	return `서브에이전트 ${total}개가 실행 중이라 팀 동시 상한 ${config.parallelism}개에 닿아 스폰을 막았습니다. 하나가 끝나기를 기다리거나, 컨텍스트 상한 아래의 유휴 에이전트를 재사용하세요(write agent://<id>).`;
}

/** Live agents of one role against the run plan's workers for it. */
function roleCapBlock(config: StormConfig, runtime: SpawnRuntime, roleId: string, agent: string): string | undefined {
	const run = runtime.run;
	const plan = run?.plan;
	if (!run || !plan) return undefined;
	const cap = plan.workers[roleId] ?? 0;
	if (cap <= 0) {
		return `실행 계획에 ${roleId} 역할 레인이 없어 ${agent} 스폰을 막았습니다. 이 역할이 필요하면 storm 도구의 plan 동작으로 계획을 다시 내세요.`;
	}
	const running = run.active?.byRole[roleId] ?? 0;
	if (running < cap) return undefined;
	const max = workerRange(roleId, config.roles[roleId]).max;
	return `${agent} ${running}개가 실행 중이라 실행 계획의 ${roleId} 상한 ${cap}개에 닿아 스폰을 막았습니다. 컨텍스트 상한 아래의 유휴 ${agent} 를 재사용하거나(write agent://<id>), 하나가 끝나기를 기다리거나, plan 동작으로 워커를 늘려 계획을 다시 내세요(이 역할 최대 ${max}개).`;
}

/** Decides how a spawn runs: `storm-*` agents always, other agents only while a Storm run is active. */
export function decideSpawn(event: SpawnEvent, state: SpawnState, runtime: SpawnRuntime): SpawnOutcome {
	const base: SpawnRecord = {
		ts: new Date(runtime.now).toISOString(),
		agent: event.agent,
		invocationKind: event.invocationKind,
		requested: [...event.patterns],
		outcome: "blocked",
		...(event.spawnKey ? { spawnKey: event.spawnKey } : {}),
	};
	const block = (reason: string, extra: Partial<SpawnRecord> = {}): SpawnOutcome => ({
		decision: { block: true, reason },
		record: { ...base, ...extra, outcome: "blocked", reason },
	});
	const route = (models: string[], extra: Partial<SpawnRecord> & Pick<SpawnRecord, "outcome">): SpawnOutcome => ({
		decision: { model: models, note: `storm: ${event.agent} → ${models[0]}` },
		record: { ...base, ...extra, models },
	});

	if (!event.agent.startsWith(ROLE_AGENT_PREFIX)) {
		if (!runtime.run) return { decision: undefined };
		const checked = gate(state);
		if (!checked.ok) return block(checked.reason);
		const overBudget = budgetBlock(runtime);
		if (overBudget) return block(overBudget);
		const runBlock = planBlock(runtime) ?? totalBlock(checked.config, runtime);
		if (runBlock) return block(runBlock);
		const requested = stripEffort(event.patterns[0] ?? "");
		if (approvedSelectors(checked.config).has(requested)) {
			return { decision: undefined, record: { ...base, outcome: "allowed" } };
		}
		const builtinKey = BUILTIN_AGENT_ROLES[event.agent];
		const builtin = builtinKey === undefined ? undefined : usableRole(checked.config, builtinKey);
		if (builtinKey !== undefined && builtin) {
			const models = orderByQuota(builtin.models, runtime.quotaMarks).map(m => withEffort(m, builtin.effort));
			return route(models, {
				outcome: "substituted",
				role: builtinKey,
				reason: `승인 밖 모델 ${requested || "없음"} → ${builtinKey} 역할 모델`,
			});
		}
		const fallbackKey = checked.config.fallbackRole;
		const fallback = fallbackKey === undefined ? undefined : checked.config.roles[fallbackKey];
		if (fallbackKey !== undefined && fallback && fallback.models.length > 0) {
			const models = orderByQuota(fallback.models, runtime.quotaMarks).map(m => withEffort(m, fallback.effort));
			return route(models, {
				outcome: "substituted",
				role: fallbackKey,
				reason: `승인 밖 모델 ${requested || "없음"} → ${fallbackKey} 역할 모델`,
			});
		}
		return block(
			`Storm 실행 중에는 승인된 모델만 쓸 수 있습니다(요청: ${requested || "없음"}). /storm 으로 대체 역할을 정하세요.`,
		);
	}

	const checked = gate(state);
	if (!checked.ok) return block(checked.reason);
	const config = checked.config;
	const entry = Object.entries(config.roles).find(([, r]) => r.agent === event.agent);
	let roleKey: string;
	/** The role id this spawn asked for: a stand-in borrows `roleKey`'s models but counts against this one. */
	let requestedRole: string;
	let role: StormConfig["roles"][string];
	let standIn = false;
	if (entry) {
		[roleKey, role] = entry;
		requestedRole = roleKey;
	} else {
		const spec = ROLES.find(r => r.agent === event.agent);
		if (!spec) return block(`Storm 설정에 ${event.agent} 역할이 없습니다.`);
		const usable = ROLE_STAND_INS[spec.id].find(id => usableRole(config, id));
		if (config.disabledRoles?.includes(spec.id)) {
			const suggest = (usable === undefined ? undefined : config.roles[usable]?.agent) ?? "storm-implementer";
			return block(`${event.agent}(${spec.title})는 이 팀에서 쓰지 않습니다(설정에서 사용 안 함). 대신 ${suggest} 를 쓰세요.`, {
				role: spec.id,
			});
		}
		const borrowed = usable === undefined ? undefined : usableRole(config, usable);
		if (usable === undefined || !borrowed) return block(`Storm 설정에 ${event.agent} 역할이 없습니다.`);
		roleKey = usable;
		role = borrowed;
		standIn = true;
		requestedRole = spec.id;
	}

	const approvedShadows = checked.approved.scope.shadowedAgents;
	for (const shadow of state.shadows) {
		if (shadow.agent !== event.agent) continue;
		if (approvedShadows.some(a => a.agent === shadow.agent && a.sha256 === shadow.sha256)) continue;
		return block(`승인되지 않은 역할 정의가 있습니다: ${shadow.path}. /storm 으로 확인하세요.`, { role: roleKey });
	}

	if (role.models.length === 0) return block(`Storm 설정의 ${event.agent} 역할에 모델이 없습니다.`, { role: roleKey });
	const overBudget = budgetBlock(runtime);
	if (overBudget) return block(overBudget, { role: roleKey });
	const runBlock =
		planBlock(runtime) ?? roleCapBlock(config, runtime, requestedRole, event.agent) ?? totalBlock(config, runtime);
	if (runBlock) return block(runBlock, { role: roleKey });

	const ordered = orderByQuota(role.models, runtime.quotaMarks).map(m => withEffort(m, role.effort));
	if (standIn) return route(ordered, { outcome: "substituted", role: roleKey, reason: `설정에 없는 역할 → ${roleKey} 역할 모델` });
	const trial = activeTrialFor(config, roleKey, runtime.trials, runtime.now);
	const trialTag: Partial<SpawnRecord> = trial ? { trialId: trial.id } : {};
	if (trial && shouldRouteToTrial(trial, runtime.trials[trial.id])) {
		const models = dedupeBySelector([withEffort(trial.model, trial.effort ?? role.effort), ...ordered]);
		return route(models, { outcome: "trial", role: roleKey, ...trialTag });
	}
	return route(ordered, { outcome: "routed", role: roleKey, ...trialTag });
}
