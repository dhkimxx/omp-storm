/**
 * What the `storm` tool needs from the extension. The extension wires real implementations;
 * tests pass fakes. The tool never writes config or approvals except through `approveAndSave`,
 * and only after the user picked the exact approval label.
 */
import type { ProjectState } from "../state.ts";
import type {
	AgentEntry,
	AnalysisContext,
	ApprovalScope,
	EvidenceRecord,
	LifecycleSettings,
	ModelCost,
	Proposal,
	QuotaMark,
	RunRecord,
	StormConfig,
	TrialView,
	UiPort,
} from "../types.ts";

export type RunRequestResult = { ok: true; runId: string } | { ok: false; reason: string };

export interface StormToolHost {
	ui: UiPort;
	now(): number;
	/** Project state read fresh (no cache). */
	loadState(): Promise<ProjectState>;
	/** Reads catalog, quota and usage, then analyzes. Slow (seconds); may refresh omp's stats DB. */
	prepare(): Promise<AnalysisContext>;
	/** Writes the approval (with evidence) first, then the config; returns the new config hash. */
	approveAndSave(state: ProjectState, config: StormConfig, scope: ApprovalScope, evidence?: EvidenceRecord): Promise<string>;
	runtime: {
		/** The run active in this process for this project. */
		activeRun(): RunRecord | undefined;
		lastRun(): Promise<RunRecord | undefined>;
		/** Trials of the current config with counters, phase and (when ended) the measured comparison. */
		trials(): Promise<TrialView[]>;
		/** Active marks only. */
		quotaMarks(): Promise<QuotaMark[]>;
		addQuotaMark(mark: QuotaMark): Promise<void>;
		/** Queues a run that starts once the current agent turn settles. */
		requestRun(task: string): RunRequestResult;
		/** Subagents spawned under this session (any depth), from the agent ledger. */
		agents(): AgentEntry[];
	};
	/** omp's idle-park TTL and cache retention as configured; fields are undefined when unreadable. */
	lifecycleSettings(): Promise<LifecycleSettings>;
	/** List prices of a "provider/id" (effort suffix allowed), when the model is known. */
	modelCost(selector: string): ModelCost | undefined;
	proposals: {
		/** Pending proposals built on the current config hash (stale ones are dropped). */
		list(): Promise<Proposal[]>;
		save(proposal: Proposal): Promise<void>;
		remove(id: string): Promise<void>;
	};
}
