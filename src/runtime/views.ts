import { readUsage, statsDbPath } from "../history/stats.ts";
import { compareTrial } from "../report/trials.ts";
import { parseModelEntry } from "../selector.ts";
import type { StormConfig, TrialView } from "../types.ts";
import { readTrialStates } from "./state-files.ts";
import { trialPhase } from "./trials.ts";

const DAY_MS = 86_400_000;

/** Trials of the config with counters and phase; ended trials get the measured comparison from omp's stats DB. */
export async function trialViews(root: string, config: StormConfig, now: number): Promise<TrialView[]> {
	const trials = config.trials ?? [];
	if (trials.length === 0) return [];
	const states = await readTrialStates(root);
	const views: TrialView[] = trials.map(trial => {
		const state = states[trial.id];
		return { trial, state, phase: trialPhase(trial, state, now).phase };
	});
	const ended = views.filter(view => view.phase === "ended");
	const starts = ended.map(view => Date.parse(view.trial.startsAt)).filter(Number.isFinite);
	if (starts.length === 0) return views;
	// Only requests since the earliest ended trial began, so both sides cover the same period.
	const usage = readUsage({ dbPath: statsDbPath(), windowDays: (now - Math.min(...starts)) / DAY_MS, now });
	if (usage.status !== "ok") return views;
	for (const view of ended) {
		const first = config.roles[view.trial.role]?.models[0];
		if (first !== undefined) view.comparison = compareTrial(view.trial, parseModelEntry(first).selector, usage);
	}
	return views;
}
