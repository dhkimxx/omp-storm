import { parseModelEntry } from "../selector.ts";
import type { StormConfig, TrialConfig, TrialState } from "../types.ts";
import { sharedMap } from "./thread-state.ts";

export function trialPhase(
	trial: TrialConfig,
	state: TrialState | undefined,
	now: number,
): { phase: "pending" | "active" | "ended"; endReason?: "time" | "spawns" | "budget" } {
	const startsAt = Date.parse(trial.startsAt);
	const endsAt = Date.parse(trial.endsAt);
	if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return { phase: "ended", endReason: "time" };
	if (now < startsAt) return { phase: "pending" };
	if (now >= endsAt) return { phase: "ended", endReason: "time" };
	if ((state?.routed ?? 0) >= trial.maxSpawns) return { phase: "ended", endReason: "spawns" };
	if ((state?.costUsd ?? 0) >= trial.budgetUsd) return { phase: "ended", endReason: "budget" };
	return { phase: "active" };
}

/**
 * Stamps the counters the first time they reach the trial's spawn cap or budget. Requests after that moment are
 * not the trial's, so the comparison window ends there. A trial that only runs out of time needs no stamp.
 */
export function markTrialStop(trial: TrialConfig | undefined, state: TrialState, now: number): TrialState {
	if (!trial || state.stoppedAt !== undefined) return state;
	const { endReason } = trialPhase(trial, state, now);
	return endReason === "spawns" || endReason === "budget" ? { ...state, stoppedAt: new Date(now).toISOString() } : state;
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

/**
 * Spawn key (omp names the subagent after it, so it is the agent id) → the trial its spawn was routed to, per owner
 * session store. Module-level on purpose: the subagent's own session reports its spend through this same module. The
 * scope keeps two profiles or native sessions from charging one session's trial for another's same-named agent.
 */
const routedAgents = sharedMap<string, string>("storm.trials.routedAgents");

function routedKey(scope: string, spawnKey: string): string {
	return `${scope}\u0000${spawnKey}`;
}

/** Remembers that the spawn with this key was routed to a trial candidate under `scope`. */
export function noteTrialSpawn(spawnKey: string, trialId: string, scope: string): void {
	routedAgents.set(routedKey(scope, spawnKey), trialId);
}

/**
 * The trial whose budget a message of `agentId` on model `selector` counts against: only subagents whose spawn was
 * routed to the trial under the same session store, and only while they run the candidate (a routed agent may fall
 * back to the role's own models). The main session, other roles on the same model and work outside the trial are
 * never charged. Without a scope entry, nothing is charged.
 */
export function trialCharge(agentId: string, selector: string, config: Pick<StormConfig, "trials">, scope: string): string | undefined {
	const trialId = routedAgents.get(routedKey(scope, agentId));
	if (trialId === undefined) return undefined;
	const trial = config.trials?.find(t => t.id === trialId);
	return trial && parseModelEntry(trial.model).selector === selector ? trialId : undefined;
}

/** Tests only. */
export function resetTrialSpawns(): void {
	routedAgents.clear();
}
