/**
 * Pure builders for storm-tool proposals. Each returns the next config plus a one-line summary,
 * or an error the tool reports as a rejection. Nothing here reads or writes state.
 */
import { fallbackOf, priorityLabel, roleTitle } from "../interview/render.ts";
import { pickEffort, ROLE_EFFORT } from "../recommend/recommend.ts";
import { MAX_WORKERS, ROLES, workerRange } from "../roles.ts";
import { entryEffort, formatModelEntry, parseModelEntry } from "../selector.ts";
import type {
	BudgetConfig,
	Effort,
	ModelInfo,
	Priority,
	RoleRecommendation,
	RoleSpec,
	StormConfig,
	TrialConfig,
} from "../types.ts";

export type Built = { config: StormConfig; summary: string } | { error: string };
export type ModelCheck = { ok: true; label: string; efforts: Effort[] } | { ok: false; reason: string };

const DAY_MS = 86_400_000;
export const TRIAL_DEFAULTS = { share: 0.25, maxSpawns: 20, days: 7, budgetUsd: 2 } as const;

export function roleSpec(role: string): RoleSpec | undefined {
	return ROLES.find((r) => r.id === role);
}

export function providerOf(selector: string): string {
	const i = selector.indexOf("/");
	return i < 0 ? selector : selector.slice(0, i);
}

function defaultEffort(role: string): Effort {
	const spec = roleSpec(role);
	return spec ? ROLE_EFFORT[spec.id] : "medium";
}

/** Keeps the given effort when the new model supports it, else the role default nearest the model's levels. */
export function effortFor(role: string, current: Effort | undefined, efforts: readonly Effort[]): Effort | null {
	if (current !== undefined && efforts.includes(current)) return current;
	return pickEffort(defaultEffort(role), efforts);
}

/** Supported efforts of a model; none when it does not check out. */
export function effortsOf(check: (selector: string) => ModelCheck, selector: string): Effort[] {
	const r = check(selector);
	return r.ok ? r.efforts : [];
}

/** A models[] entry with its own effort suffix, or bare when the model has no effort control. */
function entry(selector: string, effort: Effort | null | undefined): string {
	return formatModelEntry(effort ? { selector, effort } : { selector });
}

function selectorOf(model: string): string {
	return parseModelEntry(model).selector;
}

/** A trial for a role whose primary is now the candidate has been adopted; it would only route to itself. */
function dropAdoptedTrials(config: StormConfig): void {
	if (!config.trials) return;
	const kept = config.trials.filter((t) => {
		const first = config.roles[t.role]?.models[0];
		return first === undefined || selectorOf(first) !== selectorOf(t.model);
	});
	if (kept.length) config.trials = kept;
	else delete config.trials;
}

export function newProposalId(now: number): string {
	const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Checks a user-named model: usable now, tool-capable, and with enough context for the role. */
export function checkRoleModel(
	role: string,
	selector: string,
	check: (selector: string) => ModelCheck,
	available: readonly ModelInfo[],
): ModelCheck {
	const r = check(selector);
	if (!r.ok) return r;
	const min = roleSpec(role)?.minContext ?? 0;
	const ctx = available.find((m) => m.selector === selector)?.contextWindow ?? null;
	if (ctx !== null && ctx < min) {
		return { ok: false, reason: `${selector}: 컨텍스트 ${ctx.toLocaleString("en-US")} 토큰으로 ${roleTitle(role)} 역할 최소 ${min.toLocaleString("en-US")} 토큰보다 작습니다` };
	}
	return r;
}

/**
 * Re-picks every configured role for the new priority the way setup does: chosen candidate, then a fallback on
 * another provider. Each model carries its own effort; the role-level default is dropped.
 */
export function buildPriority(
	current: StormConfig,
	priority: Priority,
	recs: RoleRecommendation[],
	efforts: (selector: string) => readonly Effort[],
): Built {
	const next = structuredClone(current);
	next.priority = priority;
	const kept: string[] = [];
	for (const [id, role] of Object.entries(next.roles)) {
		const rec = recs.find((r) => r.role.id === id);
		const c = rec && rec.chosenIndex >= 0 ? rec.candidates[rec.chosenIndex] : undefined;
		if (!rec || !c) {
			kept.push(roleTitle(id));
			continue;
		}
		const fb = fallbackOf(rec, c.selector);
		const primary = entry(c.selector, c.effort);
		role.models = fb ? [primary, entry(fb.selector, pickEffort(defaultEffort(id), efforts(fb.selector)))] : [primary];
		delete role.effort;
	}
	dropAdoptedTrials(next);
	const note = kept.length ? ` (후보 없어 유지: ${kept.join(", ")})` : "";
	return { config: next, summary: `우선순위를 ${priorityLabel(priority)}(으)로 바꾸고 역할 모델을 다시 추천합니다${note}` };
}

/** Why a role-targeted proposal cannot apply to a role that is not in `roles`. */
function missingRole(config: StormConfig, role: string): string {
	if (config.disabledRoles?.includes(role)) {
		return `${roleTitle(role)}(${role}): 사용 안 함으로 설정된 역할입니다. 다시 쓰려면 /storm 에서 팀 다시 설정을 고르세요`;
	}
	return `${role}: 설정에 없는 역할입니다`;
}

/** Sets a role's worker range; an unset bound keeps the current one. Writes the { min, max } form. */
export function buildWorkers(current: StormConfig, role: string, min: number | undefined, max: number | undefined): Built {
	const prev = current.roles[role];
	if (!prev) return { error: missingRole(current, role) };
	if (min === undefined && max === undefined) return { error: "min이나 max가 필요합니다" };
	const now = workerRange(role, prev);
	const range = { min: min ?? Math.min(now.min, max ?? now.min), max: max ?? Math.max(now.max, min ?? now.max) };
	if (![range.min, range.max].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_WORKERS) || range.min > range.max) {
		return { error: `workers: 1 ≤ min ≤ max ≤ ${MAX_WORKERS} 정수여야 합니다` };
	}
	const next = structuredClone(current);
	next.roles[role]!.workers = range;
	return { config: next, summary: `${roleTitle(role)} 워커를 ${range.min}~${range.max}개로 바꿉니다` };
}

/**
 * Puts `model` first and keeps the role's other models behind it as fallbacks. The new model keeps the old
 * primary's effort when it supports it; the others keep the effort they ran with, now as their own suffix.
 */
export function buildReselect(current: StormConfig, role: string, model: string, efforts: readonly Effort[]): Built {
	const prev = current.roles[role];
	if (!prev) return { error: missingRole(current, role) };
	const next = structuredClone(current);
	const r = next.roles[role]!;
	const selector = selectorOf(model);
	const first = prev.models[0];
	const effort = effortFor(role, first === undefined ? undefined : entryEffort(first, prev.effort), efforts);
	const rest = prev.models
		.filter((m) => selectorOf(m) !== selector)
		.map((m) => entry(selectorOf(m), entryEffort(m, prev.effort)));
	r.models = [entry(selector, effort), ...rest];
	delete r.effort;
	dropAdoptedTrials(next);
	return { config: next, summary: `${roleTitle(role)} 역할 모델을 ${selector}(으)로 바꿉니다` };
}

export interface QuotaImpact {
	role: string;
	/** The role's current first model, on the exhausted provider. */
	from: string;
	/** First approved model of the role on another provider; null when there is none. */
	alternative: string | null;
}

/** Roles whose first model runs on `provider`, with the approved model they would fall back to. */
export function quotaPlan(config: StormConfig, provider: string): QuotaImpact[] {
	const out: QuotaImpact[] = [];
	for (const [role, r] of Object.entries(config.roles)) {
		const first = r.models[0];
		if (first === undefined || providerOf(selectorOf(first)) !== provider) continue;
		out.push({ role, from: first, alternative: r.models.find((m) => providerOf(selectorOf(m)) !== provider) ?? null });
	}
	return out;
}

/**
 * Adds the best recommended model off `provider` as a fallback for roles that have none. The
 * primary stays first: a quota mark reorders approved models only while it lasts.
 */
export function buildQuota(
	current: StormConfig,
	provider: string,
	roles: string[],
	recs: RoleRecommendation[],
): Built {
	const next = structuredClone(current);
	const added: string[] = [];
	const missing: string[] = [];
	for (const id of roles) {
		const r = next.roles[id];
		const pick = recs.find((x) => x.role.id === id)?.candidates.find((c) => providerOf(c.selector) !== provider);
		if (!r || !pick) {
			missing.push(roleTitle(id));
			continue;
		}
		r.models = [...r.models.filter((m) => selectorOf(m) !== pick.selector), entry(pick.selector, pick.effort)];
		added.push(`${roleTitle(id)} → ${pick.selector}`);
	}
	if (!added.length) return { error: `${provider} 밖에서 쓸 후보가 없습니다: ${missing.join(", ")}` };
	const note = missing.length ? ` (후보 없음: ${missing.join(", ")})` : "";
	return { config: next, summary: `${provider} 쿼터 대비 폴백 추가: ${added.join(", ")}${note}` };
}

export interface TrialInput {
	role: string;
	model: string;
	efforts: readonly Effort[];
	share?: number | undefined;
	maxSpawns?: number | undefined;
	days?: number | undefined;
	budgetUsd?: number | undefined;
	now: number;
}

export function trialId(role: string, model: string, now: number): string {
	const slug = model
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${role}-${slug}-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}`;
}

export function buildTrial(current: StormConfig, input: TrialInput): Built {
	const prev = current.roles[input.role];
	if (!prev) return { error: missingRole(current, input.role) };
	if (prev.models[0] !== undefined && selectorOf(prev.models[0]) === selectorOf(input.model)) {
		return { error: `${input.model}: 이미 ${roleTitle(input.role)} 역할의 기본 모델입니다` };
	}
	const share = input.share ?? TRIAL_DEFAULTS.share;
	const maxSpawns = input.maxSpawns ?? TRIAL_DEFAULTS.maxSpawns;
	const days = input.days ?? TRIAL_DEFAULTS.days;
	const budgetUsd = input.budgetUsd ?? TRIAL_DEFAULTS.budgetUsd;
	if (!(Number.isFinite(share) && share > 0 && share <= 1)) return { error: "share: 0보다 크고 1 이하여야 합니다" };
	if (!Number.isInteger(maxSpawns) || maxSpawns < 1 || maxSpawns > 1000) return { error: "maxSpawns: 1~1000 사이 정수여야 합니다" };
	if (!(Number.isFinite(days) && days >= 1 && days <= 30)) return { error: "days: 1~30 사이여야 합니다" };
	if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) return { error: "budgetUsd: 0보다 커야 합니다" };

	const endsAt = input.now + days * DAY_MS;
	const trial: TrialConfig = {
		id: trialId(input.role, input.model, input.now),
		role: input.role,
		model: input.model,
		share,
		maxSpawns,
		startsAt: new Date(input.now).toISOString(),
		endsAt: new Date(endsAt).toISOString(),
		budgetUsd,
	};
	const first = prev.models[0];
	const effort = effortFor(input.role, first === undefined ? prev.effort : entryEffort(first, prev.effort), input.efforts);
	if (effort) trial.effort = effort;
	const next = structuredClone(current);
	next.trials = [...(current.trials ?? []).filter((t) => t.role !== input.role), trial];
	return {
		config: next,
		summary:
			`${roleTitle(input.role)} 역할 시험 사용: ${input.model}에 스폰의 ${Math.round(share * 100)}%, ` +
			`최대 ${maxSpawns}회, ${days}일(${trial.endsAt.slice(0, 10)}까지), 예산 $${budgetUsd}`,
	};
}

export function buildBudget(
	current: StormConfig,
	budgetUsd: number,
	warnAtUsd: number | undefined,
	onExceed: BudgetConfig["onExceed"] | undefined,
): Built {
	if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return { error: "budgetUsd: 0 이상이어야 합니다(0은 예산 해제)" };
	const next = structuredClone(current);
	if (budgetUsd === 0) {
		if (!current.budget) return { error: "설정된 예산이 없습니다" };
		delete next.budget;
		return { config: next, summary: "실행당 예산을 해제합니다" };
	}
	if (warnAtUsd !== undefined && !(Number.isFinite(warnAtUsd) && warnAtUsd > 0 && warnAtUsd < budgetUsd)) {
		return { error: "warnAtUsd: 0보다 크고 budgetUsd보다 작아야 합니다" };
	}
	// Same default warning point as setup.
	const warn = warnAtUsd ?? Math.round(budgetUsd * 0.8 * 1e6) / 1e6;
	next.budget = { perRunUsd: budgetUsd, warnAtUsd: warn, onExceed: onExceed ?? "block-spawns" };
	return {
		config: next,
		summary: `실행당 예산을 $${budgetUsd}(경고 $${warn}, 초과 시 ${next.budget.onExceed})로 정합니다`,
	};
}

/**
 * The team switches. A switch at its default leaves the config (cleanup off, docs on), so turning one back costs no
 * stray field; an unchanged request comes back as the same config and the proposal step reports nothing to change.
 */
export function buildSettings(current: StormConfig, cleanup: boolean | undefined, docs: boolean | undefined): Built {
	if (cleanup === undefined && docs === undefined) return { error: "cleanup이나 docs가 필요합니다" };
	const next = structuredClone(current);
	const parts: string[] = [];
	if (cleanup !== undefined) {
		if (cleanup) next.cleanup = true;
		else delete next.cleanup;
		parts.push(`실행이 끝나면 정리를 ${cleanup ? "켭니다" : "끕니다"}`);
	}
	if (docs !== undefined) {
		if (docs) delete next.docs;
		else next.docs = false;
		parts.push(`문서 정합을 ${docs ? "켭니다" : "끕니다"}`);
	}
	return { config: next, summary: parts.join(" · ") };
}
