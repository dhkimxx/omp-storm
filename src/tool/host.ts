/**
 * What the `storm` tool needs from the extension. The extension wires real implementations;
 * tests pass fakes. The tool never writes config or approvals except through `approveAndSave`,
 * and only after the user picked the exact approval label.
 */
import type { DecideHost } from "../proposals/decide.ts";
import type { AgentEntry, AnalysisContext, RunPlan, RunSpec } from "../types.ts";

export type RunRequestResult = { ok: true; runId: string } | { ok: false; reason: string };

/**
 * The personal automatic-delegation policy of the main session owning a tool call. Consent is read from the
 * approval store, never derived from team approval: a blocked state keeps the main session's direct tools blocked
 * instead of silently falling back to them.
 */
export interface AutoDelegationState {
	/** The user's explicit opt-in for this profile and repository. */
	enabled: boolean;
	/** Why an automatic run cannot start now (team config/approval or an omp mode); absent when it can. */
	blocked?: string;
	/** The ordinary user prompt this turn started from: the task a first plan opens the run for. Absent on a revive, an empty prompt, or after the turn settled. */
	task?: string;
}

/** `ui`, `loadState` and `approveAndSave` are the approval path's (`DecideHost`). */
export interface StormToolHost extends DecideHost {
	now(): number;
	/** Reads catalog, quota and usage, then analyzes. Slow (seconds); may refresh omp's stats DB. */
	prepare(): Promise<AnalysisContext>;
	/** The status report `/storm status` shows, as markdown; `quota` adds omp's provider quota (about a second). */
	statusText(opts: { quota: boolean }): Promise<string>;
	/** The main session's automatic-delegation policy; absent hosts behave as if it were never opted in. */
	auto?(): AutoDelegationState;
	runtime: {
		/** Queues a run that starts once the current agent turn settles. */
		requestRun(spec: RunSpec): RunRequestResult;
		/** Puts a validated plan in force for the active run (replacing any earlier one); fails when no run is active. */
		setRunPlan(plan: RunPlan): { ok: true } | { ok: false; reason: string };
		/** Whether this session itself directs a run now; another session's run in the same repo is not this one. */
		runActive?(): boolean;
		/**
		 * Automatic delegation only: opens a run for this turn's user request with `plan` already in force. It sends
		 * no handoff; the in-flight turn is the run's first round.
		 */
		startWithPlan?(spec: RunSpec, plan: RunPlan, validatedHash?: string): Promise<RunRequestResult>;
		/** Subagents spawned under this session (any depth), from the agent ledger. */
		agents(): AgentEntry[];
	};
}
