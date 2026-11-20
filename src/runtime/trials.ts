import type { StormConfig, TrialConfig, TrialState } from "../types.ts";

export function trialPhase(
	trial: TrialConfig,
	state: TrialState | undefined,
	now: number,
): { phase: "pending" | "active" | "ended"; endReason?: "time" | "spawns" | "budget" } {
	// Once a trial was recorded as ended it never routes again, even if the counters were reset.
	if (state?.endedAt) return { phase: "ended", endReason: state.endReason ?? "time" };
	const startsAt = Date.parse(trial.startsAt);
	const endsAt = Date.parse(trial.endsAt);
	if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return { phase: "ended", endReason: "time" };
	if (now < startsAt) return { phase: "pending" };
	if (now >= endsAt) return { phase: "ended", endReason: "time" };
	if ((state?.routed ?? 0) >= trial.maxSpawns) return { phase: "ended", endReason: "spawns" };
	if ((state?.costUsd ?? 0) >= trial.budgetUsd) return { phase: "ended", endReason: "budget" };
	return { phase: "active" };
}

/** Deterministic share: route when doing so keeps routed/seen at or under `share` (0.25 → every 4th spawn). */
export function shouldRouteToTrial(trial: TrialConfig, state: TrialState | undefined): boolean {
	const seen = state?.seen ?? 0;
	const routed = state?.routed ?? 0;
	// The epsilon keeps shares like 0.3 from missing their turn to float rounding.
	return routed + 1 <= trial.share * (seen + 1) + 1e-9;
}

export function activeTrialFor(
	config: StormConfig,
	roleKey: string,
	trials: Record<string, TrialState>,
	now: number,
): TrialConfig | undefined {
	return config.trials?.find(t => t.role === roleKey && trialPhase(t, trials[t.id], now).phase === "active");
}
