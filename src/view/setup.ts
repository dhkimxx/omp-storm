/** Turns recommendations into a Storm config. */
import { DEFAULT_WORKERS, workerRange } from "../roles.ts";
import { formatModelEntry } from "../selector.ts";
import type { Candidate, Priority, RoleConfig, RoleRecommendation, StormConfig } from "../types.ts";

/** Run settings of a first setup. */
const FIRST_ISOLATION: StormConfig["isolation"] = "shared";

/** A models[] entry with the candidate's effort for the role; bare when the model has no effort control. */
function candidateEntry(c: Candidate): string {
	return formatModelEntry(c.effort ? { selector: c.selector, effort: c.effort } : { selector: c.selector });
}

/** A role's recommended models: the chosen candidate, then the fallback on another provider. None without a candidate. */
export function recommendedModels(rec: RoleRecommendation): string[] | undefined {
	const chosen = rec.candidates[rec.chosenIndex];
	if (!chosen) return undefined;
	return rec.fallback ? [candidateEntry(chosen), candidateEntry(rec.fallback)] : [candidateEntry(chosen)];
}

/**
 * Storm's own team for `priority`. Only the models are new: what the user chose before (worker ranges,
 * disabled roles, run settings, budget, the docs and cleanup switches, a deliberate block of other agents, trials)
 * carries over from `current`. A first setup recommends cleanup on.
 */
export function recommendedConfig(recs: RoleRecommendation[], priority: Priority, current?: StormConfig): StormConfig {
	const disabled = current?.disabledRoles ?? [];
	const roles: Record<string, RoleConfig> = {};
	for (const rec of recs) {
		const id = rec.role.id;
		const models = recommendedModels(rec);
		if (!models || disabled.includes(id)) continue;
		const prev = current?.roles[id];
		roles[id] = {
			agent: rec.role.agent,
			models,
			workers: prev ? workerRange(id, prev) : { ...DEFAULT_WORKERS[id] },
		};
	}
	const config: StormConfig = {
		version: 1,
		priority,
		roles,
		isolation: current?.isolation ?? FIRST_ISOLATION,
	};
	if (current?.budget) config.budget = { ...current.budget };
	if (current?.rounds !== undefined) config.rounds = current.rounds;
	if (current ? current.cleanup === true : true) config.cleanup = true;
	if (current?.docs === false) config.docs = false;
	if (current?.requiredChecks !== undefined) config.requiredChecks = structuredClone(current.requiredChecks);
	if (current?.jobs !== undefined) config.jobs = structuredClone(current.jobs);
	if (disabled.length) config.disabledRoles = [...disabled];
	// Without a current team other agents borrow the implementer's models; an absent fallbackRole in one is a deliberate block.
	const fallback = current ? current.fallbackRole : "implementer";
	if (fallback !== undefined && Object.hasOwn(roles, fallback)) config.fallbackRole = fallback;
	const trials = current?.trials?.filter((t) => Object.hasOwn(roles, t.role));
	if (trials?.length) config.trials = structuredClone(trials);
	return config;
}
