/**
 * What the `storm` tool needs from the extension. The extension wires real implementations;
 * tests pass fakes. The tool never writes config or approvals except through `approveAndSave`,
 * and only after the user picked the exact approval label.
 */
import type { DecideHost } from "../proposals/decide.ts";
import type { AgentEntry, AnalysisContext, RunPlan, RunSpec } from "../types.ts";

export type RunRequestResult = { ok: true; runId: string } | { ok: false; reason: string };

/** `ui`, `loadState` and `approveAndSave` are the approval path's (`DecideHost`). */
export interface StormToolHost extends DecideHost {
	now(): number;
	/** Reads catalog, quota and usage, then analyzes. Slow (seconds); may refresh omp's stats DB. */
	prepare(): Promise<AnalysisContext>;
	/** The status report `/storm status` shows, as markdown; `quota` adds omp's provider quota (about a second). */
	statusText(opts: { quota: boolean }): Promise<string>;
	runtime: {
		/** Queues a run that starts once the current agent turn settles. */
		requestRun(spec: RunSpec): RunRequestResult;
		/** Puts a validated plan in force for the active run (replacing any earlier one); fails when no run is active. */
		setRunPlan(plan: RunPlan): { ok: true } | { ok: false; reason: string };
		/** Subagents spawned under this session (any depth), from the agent ledger. */
		agents(): AgentEntry[];
	};
}
