/**
 * The one derivation of a run's result facts that every Storm surface reads: the live chip, the one-line closeout,
 * the card, the status history line, the historical handoff and resume.
 *
 * Three questions have different answers and must not be conflated:
 * - what the run declared (`declared`, `mixed` or `none`);
 * - which ledger rows still answer a declaration, and which were removed or orphaned by a replan;
 * - what its workers did, counted apart from result rows (placed, refused at their hook, started, settled, failed and
 *   deliveries that answer no declared result).
 *
 * A run with no declared results must never look verified by the row count: `hasDeclared` is false there, and every
 * view says so instead of drawing `0/0` or an acceptance mark. Nothing here reads plan text as proof; a plan only says
 * which ids are declared.
 */
import type { AgentEntry, InfoTone, RunRecord, SpawnRecord } from "../types.ts";
import { resultProgress, type ResultProgress } from "../view/results.ts";
import { unplannedTotal } from "./unplanned.ts";

/** The head word every surface uses for a run whose record holds no declared result row. */
export const NO_DECLARED_RESULTS = "선언된 결과 없음";
/** The fact counted beside a declared run: work that answers no declared result. */
export const OUT_OF_PLAN_LABEL = "계획 밖";
/** The unit word before a worker count; no particle follows an inserted value. */
export const WORKER_LABEL = "워커";
/** The one line a run says the first time it places a worker outside the plan, for the task result. */
export const UNPLANNED_WORKER_NOTE = "계획 밖 워커: 결과 집계에 들어가지 않습니다. 결과로 세려면 계획의 레인 이름을 쓰세요.";

/** `mixed` means declared rows exist and out-of-plan deliveries also happened. */
export type ResultDeclaration = "declared" | "mixed" | "none";

export interface ResultRowFacts {
	/** Every valid ledger row, excluded ones included. */
	readonly total: number;
	/** Rows whose id the plan in force still declares (every row when the record carries no plan). */
	readonly declared: number;
	/** Rows whose id the plan in force no longer declares: they keep their state but nothing in the plan owns them. */
	readonly removed: number;
	/** A removed row that is not accepted and has no lane: only reassignment or an explicit scope change clears it. */
	readonly orphaned: number;
	/** Operator-excluded rows, counted separately and never added to an in-scope count. */
	readonly excluded: number;
}

/** Planned coverage: the ids a plan declares against the rows the record actually holds. */
export interface ResultCoverage {
	readonly lanes: number;
	readonly declaredLanes: number;
	readonly declared: number;
	readonly recorded: number;
	readonly missing: number;
}

/** Accepted retained artifacts kept outside the target: a count plus one safe reference, never a per-worker list. */
export interface RetainedFacts {
	readonly count: number;
	/** The first accepted retained row's safe digest-bound capture reference. */
	readonly capture?: string;
	/** The first accepted retained row's host attempt. */
	readonly attempt?: string;
}

/** Worker activity, counted apart from result rows. */
export interface WorkerActivity {
	/** Spawns this run routed (a worker it placed, with or without a lane). */
	readonly placed: number;
	/** Spawns refused at their hook; every blocked spawn record is a hook refusal. */
	readonly refused: number;
	/** Subagent entries the run's ledger observed: the host started these workers. */
	readonly started: number;
	/** Started workers whose latest turn is over (idle or parked). */
	readonly settled: number;
	/** Workers whose latest settled turn reported an error, abort or output limit. */
	readonly failed: number;
	/** Workers whose host record says they changed files; never a count of changed paths. */
	readonly changed: number;
	/** Deliveries that answer no declared result. */
	readonly unplanned: number;
	/** Placements without a lane: workers the director placed outside the plan. */
	readonly unplannedPlaced: number;
}

export interface ResultFactOptions {
	/**
	 * Paths the shared tree changed since the run's baseline, when the caller read the tree. Absent means the record
	 * holds no such fact; a view must then show what it does hold (changed workers), never an invented path count.
	 */
	readonly changedPaths?: number;
}

export interface ResultFacts {
	readonly declaration: ResultDeclaration;
	/** A declared result row exists. False means no surface may show a result fraction or an acceptance mark. */
	readonly hasDeclared: boolean;
	/**
	 * The record has no declared rows but does have a plan or worker activity: the views say `선언된 결과 없음`
	 * instead of drawing nothing. A run that did nothing at all stays as quiet as it always was.
	 */
	readonly noResultsNotice: boolean;
	readonly progress: ResultProgress;
	/**
	 * Accepted retained artifacts, kept outside the target (row 1). `capture` and `attempt` are the first row's safe,
	 * digest-bound reference; the count is all of them. Fixed size: no list grows with the number of workers.
	 */
	readonly retained: RetainedFacts;
	readonly rows: ResultRowFacts;
	readonly coverage: ResultCoverage;
	readonly activity: WorkerActivity;
	/** Deliveries that answer no declared result; a mixed run shows this beside its declared rows. */
	readonly outOfPlan: number;
	/** Only when the caller supplied it. */
	readonly changedPaths?: number;
	/** The result disposition alone: `선언된 결과 없음`, or the focus headline plus `계획 밖 N` when mixed. */
	readonly headline: string;
	/** The same facts as counts, for a caller that already names the focus. */
	readonly parts: readonly string[];
	readonly tone: InfoTone;
	/** Every in-scope declared row is met. Always false without declared rows. */
	readonly complete: boolean;
	/** Changes whenever any displayed fact changes. */
	readonly key: string;
}

function planIds(run: RunRecord): { readonly declared: ReadonlySet<string>; readonly lanes: number; readonly declaredLanes: number } {
	const lanes = Array.isArray(run.plan?.lanes) ? run.plan.lanes : undefined;
	if (lanes === undefined) return { declared: new Set<string>(), lanes: 0, declaredLanes: 0 };
	const declared = new Set<string>();
	let declaredLanes = 0;
	for (const lane of lanes) {
		let laneHasResult = false;
		for (const result of lane.results ?? []) {
			if (typeof result?.id !== "string" || result.id === "") continue;
			declared.add(result.id);
			laneHasResult = true;
		}
		if (laneHasResult) declaredLanes += 1;
	}
	return { declared, lanes: lanes.length, declaredLanes };
}

/**
 * Every result fact a surface may show, derived once. `run.plan` is the only declaration; `run.results` is the only row
 * state; `run.spawns` and `run.agents` are worker facts; `run.unplanned` is the delivery fact. A model's own progress
 * text is never read.
 */
export function resultFacts(run: RunRecord, options: ResultFactOptions = {}): ResultFacts {
	const progress = resultProgress(run);
	const plan = planIds(run);
	const planned = Array.isArray(run.plan?.lanes);
	let declaredRows = 0;
	let removed = 0;
	let orphaned = 0;
	for (const row of progress.rows) {
		const isDeclared = !planned || plan.declared.has(row.id);
		if (isDeclared) {
			declaredRows += 1;
			continue;
		}
		removed += 1;
		if (row.state !== "accepted" && row.lane === undefined) orphaned += 1;
	}

	const spawns: readonly SpawnRecord[] = Array.isArray(run.spawns) ? run.spawns : [];
	let placed = 0;
	let refused = 0;
	let unplannedPlaced = 0;
	for (const spawn of spawns) {
		if (spawn.outcome === "blocked") {
			refused += 1;
			continue;
		}
		placed += 1;
		if (spawn.lane === undefined) unplannedPlaced += 1;
	}
	const agents: readonly AgentEntry[] = Array.isArray(run.agents) ? run.agents : [];
	const started = agents.length;
	const settled = agents.filter(agent => agent.state !== "running").length;
	const failed = agents.filter(agent => agent.lastWorkFailed === true).length;
	const changed = agents.filter(agent => (agent.changes ?? 0) > 0).length;
	const unplanned = unplannedTotal(run);
	const outOfPlan = unplanned;

	const hasDeclared = declaredRows > 0;
	const declaration: ResultDeclaration = !hasDeclared ? "none" : outOfPlan > 0 ? "mixed" : "declared";
	const noResultsNotice =
		!hasDeclared && (planned || placed > 0 || refused > 0 || unplanned > 0 || unplannedPlaced > 0);

	const mixedText = outOfPlan > 0 ? `${OUT_OF_PLAN_LABEL} ${outOfPlan}` : undefined;
	const parts = hasDeclared
		? [...progress.parts, ...(mixedText === undefined ? [] : [mixedText])]
		: [NO_DECLARED_RESULTS];
	const headline = hasDeclared
		? [progress.headline, mixedText].filter(part => part !== undefined && part !== "").join(" · ")
		: NO_DECLARED_RESULTS;
	const recorded = declaredRows;
	const coverage: ResultCoverage = {
		lanes: plan.lanes,
		declaredLanes: plan.declaredLanes,
		declared: plan.declared.size,
		recorded,
		missing: Math.max(0, plan.declared.size - recorded),
	};
	const changedPaths =
		typeof options.changedPaths === "number" && Number.isFinite(options.changedPaths) && options.changedPaths >= 0
			? Math.floor(options.changedPaths)
			: undefined;
	const activity: WorkerActivity = {
		placed,
		refused,
		started,
		settled,
		failed,
		changed,
		unplanned,
		unplannedPlaced,
	};
	const keptRows = progress.rows.filter(row => !row.excluded && row.state === "accepted" && row.kept);
	const firstKept = keptRows[0];
	const retained: RetainedFacts = {
		count: keptRows.length,
		...(firstKept?.capture === undefined ? {} : { capture: firstKept.capture }),
		...(firstKept?.attempt === undefined ? {} : { attempt: firstKept.attempt }),
	};
	return {
		declaration,
		hasDeclared,
		noResultsNotice,
		progress,
		retained,
		rows: { total: progress.rows.length, declared: declaredRows, removed, orphaned, excluded: progress.counts.excluded },
		coverage,
		activity,
		outOfPlan,
		...(changedPaths === undefined ? {} : { changedPaths }),
		headline,
		parts,
		tone: hasDeclared ? progress.tone : "muted",
		complete: hasDeclared && progress.counts.inScope > 0 && progress.counts.accepted === progress.counts.inScope,
		key: JSON.stringify([
			declaration,
			hasDeclared,
			noResultsNotice,
			progress.key,
			recorded,
			removed,
			orphaned,
			coverage.declared,
			coverage.missing,
			activity,
			retained,
			outOfPlan,
			changedPaths ?? null,
		]),
	};
}

/** `워커 N`: the worker count every no-result view composes the same way. */
export function workerCountText(activity: Pick<WorkerActivity, "placed">): string {
	return `${WORKER_LABEL} ${activity.placed}`;
}
