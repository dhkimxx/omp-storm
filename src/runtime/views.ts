import { loadUsageBetween, type StatsEnv } from "../context.ts";
import { compareTrial } from "../report/trials.ts";
import { parseModelEntry } from "../selector.ts";
import type { StormConfig, TrialView } from "../types.ts";
import { readTrialStates } from "./state-files.ts";
import { trialPhase } from "./trials.ts";

/**
 * Trials of the config with counters and phase. An ended trial gets the measured comparison over its own period:
 * start to scheduled end, or to the moment it reached its spawn cap or budget (to now for counters that recorded no
 * such moment), so both sides cover the same requests; omp's stats DB is synced first when it ends before that
 * period does.
 */
export async function trialViews(env: StatsEnv, root: string, config: StormConfig, now: number): Promise<TrialView[]> {
	const trials = config.trials ?? [];
	if (trials.length === 0) return [];
	const states = await readTrialStates(root);
	const views: TrialView[] = [];
	for (const trial of trials) {
		const state = states[trial.id];
		const { phase, endReason } = trialPhase(trial, state, now);
		const view: TrialView = { trial, state, phase, ...(endReason ? { endReason } : {}) };
		views.push(view);
		const primary = config.roles[trial.role]?.models[0];
		const from = Date.parse(trial.startsAt);
		const stopped = state?.stoppedAt === undefined ? Number.NaN : Date.parse(state.stoppedAt);
		const to = Math.min(Date.parse(trial.endsAt), Number.isFinite(stopped) ? stopped : now);
		if (phase !== "ended" || primary === undefined || !(to > from)) continue;
		const usage = await loadUsageBetween(env, from, to);
		if (usage.status === "ok") view.comparison = compareTrial(trial, parseModelEntry(primary).selector, usage);
	}
	return views;
}
