import { ROLE_AGENT_PREFIX } from "../roles.ts";
import { activeTrialFor, shouldRouteToTrial } from "../runtime/trials.ts";
import {
	EFFORTS,
	type Effort,
	type QuotaMark,
	type SpawnEvent,
	type SpawnOutcome,
	type SpawnRecord,
	type SpawnRuntime,
	type SpawnState,
	type StormConfig,
} from "../types.ts";

/** "$12.34" at ≥ $1, "$0.0123" below. */
export function formatUsd(usd: number): string {
	return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

/** Drops a trailing ":<effort>" only when it is a known effort, so ids like "x:thinking" stay intact. */
export function stripEffort(pattern: string): string {
	const colon = pattern.lastIndexOf(":");
	if (colon < 0) return pattern;
	const suffix = pattern.slice(colon + 1);
	return (EFFORTS as readonly string[]).includes(suffix) ? pattern.slice(0, colon) : pattern;
}

/** omp model patterns take thinking effort as a ":<level>" suffix on the id part; an existing suffix wins. */
export function withEffort(selector: string, effort: Effort | undefined): string {
	if (!effort) return selector;
	return selector.slice(selector.lastIndexOf("/") + 1).includes(":") ? selector : `${selector}:${effort}`;
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
		return { ok: false, reason: `승인되지 않은 Storm 설정입니다(${short}). /storm review 로 승인하세요.` };
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

/** Decides how a spawn runs: `storm-*` agents always, other agents only while a Storm run is active. */
export function decideSpawn(event: SpawnEvent, state: SpawnState, runtime: SpawnRuntime): SpawnOutcome {
	const base: SpawnRecord = {
		ts: new Date(runtime.now).toISOString(),
		agent: event.agent,
		invocationKind: event.invocationKind,
		requested: [...event.patterns],
		outcome: "blocked",
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
		const requested = stripEffort(event.patterns[0] ?? "");
		if (approvedSelectors(checked.config).has(requested)) {
			return { decision: undefined, record: { ...base, outcome: "allowed" } };
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
	if (!entry) return block(`Storm 설정에 ${event.agent} 역할이 없습니다.`);
	const [roleKey, role] = entry;

	const approvedShadows = checked.approved.scope.shadowedAgents;
	for (const shadow of state.shadows) {
		if (shadow.agent !== event.agent) continue;
		if (approvedShadows.some(a => a.agent === shadow.agent && a.sha256 === shadow.sha256)) continue;
		return block(`승인되지 않은 역할 정의가 있습니다: ${shadow.path}. /storm review 로 확인하세요.`, { role: roleKey });
	}

	if (role.models.length === 0) return block(`Storm 설정의 ${event.agent} 역할에 모델이 없습니다.`, { role: roleKey });
	const overBudget = budgetBlock(runtime);
	if (overBudget) return block(overBudget, { role: roleKey });

	const ordered = orderByQuota(role.models, runtime.quotaMarks).map(m => withEffort(m, role.effort));
	const trial = activeTrialFor(config, roleKey, runtime.trials, runtime.now);
	const trialTag: Partial<SpawnRecord> = trial ? { trialId: trial.id } : {};
	if (trial && shouldRouteToTrial(trial, runtime.trials[trial.id])) {
		const models = dedupeBySelector([withEffort(trial.model, trial.effort ?? role.effort), ...ordered]);
		return route(models, { outcome: "trial", role: roleKey, ...trialTag });
	}
	return route(ordered, { outcome: "routed", role: roleKey, ...trialTag });
}
