/** Turns recommendations into a Storm config and an approved config into its approval scope. */
import { pickEffort, ROLE_EFFORT } from "../recommend/recommend.ts";
import { formatModelEntry, parseModelEntry } from "../selector.ts";
import type {
	ApprovalScope,
	BudgetConfig,
	Effort,
	Priority,
	RoleConfig,
	RoleRecommendation,
	ShadowInfo,
	StormConfig,
	TrialConfig,
} from "../types.ts";
import { fallbackOf, type PickedModel, type RolePick } from "./render.ts";

/** Run settings of a first setup. */
export const SETUP_DEFAULTS: Pick<StormConfig, "parallelism" | "isolation" | "contract"> = {
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
};

export function buildConfig(
	recs: RoleRecommendation[],
	picks: Record<string, RolePick>,
	opts: {
		priority: Priority;
		parallelism: number;
		isolation: StormConfig["isolation"];
		contract: StormConfig["contract"];
		budget?: BudgetConfig;
		/** Workers per role id; roles not listed get `defaultWorkers`. */
		workers?: Record<string, number>;
		/** undefined → implementer when present; null → non-Storm agents are blocked during a run. */
		fallbackRole?: string | null;
		/** Kept for roles that still exist. */
		trials?: TrialConfig[];
	},
): StormConfig {
	const roles: Record<string, RoleConfig> = {};
	for (const rec of recs) {
		const pick = picks[rec.role.id];
		if (!pick) continue;
		// Each model carries its own effort suffix, so the role-level default stays unset.
		const models = [formatModelEntry(pick.primary)];
		if (pick.fallback) models.push(formatModelEntry(pick.fallback));
		roles[rec.role.id] = {
			agent: rec.role.agent,
			models,
			workers: opts.workers?.[rec.role.id] ?? defaultWorkers(rec.role.id),
		};
	}
	const config: StormConfig = {
		version: 1,
		priority: opts.priority,
		roles,
		parallelism: opts.parallelism,
		isolation: opts.isolation,
		contract: opts.contract,
		runtime: "omp",
	};
	if (opts.budget) config.budget = opts.budget;
	const fallback = opts.fallbackRole === undefined ? "implementer" : opts.fallbackRole;
	if (fallback !== null && Object.hasOwn(roles, fallback)) config.fallbackRole = fallback;
	const trials = opts.trials?.filter((t) => Object.hasOwn(roles, t.role));
	if (trials?.length) config.trials = structuredClone(trials);
	return config;
}

/**
 * Storm's own team: each role's chosen candidate plus the best one on another provider, each at the
 * role's effort nearest what the model supports. Run settings, workers, a deliberate block of other
 * agents, budget and trials carry over from `current`.
 */
export function recommendedConfig(
	recs: RoleRecommendation[],
	efforts: (selector: string) => readonly Effort[],
	priority: Priority,
	current?: StormConfig,
): StormConfig {
	const picks: Record<string, RolePick> = {};
	for (const rec of recs) {
		const c = rec.candidates[rec.chosenIndex];
		if (!c) continue;
		const pick = (selector: string, label: string): PickedModel => {
			const effort = pickEffort(ROLE_EFFORT[rec.role.id], efforts(selector));
			return effort ? { selector, label, effort } : { selector, label };
		};
		const fb = fallbackOf(rec, c.selector);
		picks[rec.role.id] = fb ? { primary: pick(c.selector, c.label), fallback: pick(fb.selector, fb.label) } : { primary: pick(c.selector, c.label) };
	}
	const workers: Record<string, number> = {};
	for (const [id, r] of Object.entries(current?.roles ?? {})) if (r.workers !== undefined) workers[id] = r.workers;
	const fallbackRole = initialFallback(current);
	return buildConfig(recs, picks, {
		priority,
		parallelism: current?.parallelism ?? SETUP_DEFAULTS.parallelism,
		isolation: current?.isolation ?? SETUP_DEFAULTS.isolation,
		contract: current?.contract ?? SETUP_DEFAULTS.contract,
		workers,
		...(fallbackRole !== undefined ? { fallbackRole } : {}),
		...(current?.budget ? { budget: current.budget } : {}),
		...(current?.trials ? { trials: current.trials } : {}),
	});
}

export function deriveScope(config: StormConfig, shadows: ShadowInfo[]): ApprovalScope {
	const providers = new Set<string>();
	for (const r of Object.values(config.roles)) {
		for (const m of r.models) {
			const selector = parseModelEntry(m).selector;
			const i = selector.indexOf("/");
			providers.add(i < 0 ? selector : selector.slice(0, i));
		}
	}
	const scope: ApprovalScope = {
		providers: [...providers].sort(),
		roles: structuredClone(config.roles),
		runtime: config.runtime,
		shadowedAgents: [...shadows],
	};
	if (config.budget) scope.budget = { ...config.budget };
	if (config.fallbackRole !== undefined) scope.fallbackRole = config.fallbackRole;
	if (config.trials) scope.trials = structuredClone(config.trials);
	return scope;
}

/** Explorers fan out over independent reads; other roles default to one worker. */
export function defaultWorkers(roleId: string): number {
	return roleId === "explorer" ? 2 : 1;
}

/** Fallback role carried over from the current config. A v0.2 config (roles carry workers) without fallbackRole was blocked on purpose. */
function initialFallback(current: StormConfig | undefined): string | null | undefined {
	if (!current) return undefined;
	if (current.fallbackRole !== undefined) return current.fallbackRole;
	return Object.values(current.roles).some((r) => r.workers !== undefined) ? null : undefined;
}
