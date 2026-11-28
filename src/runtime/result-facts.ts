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
import type { AgentEntry, InfoTone, PlanLaneResult, RunRecord, RunResult, SpawnRecord, WorkerStopReason } from "../types.ts";
import { attemptAgentId } from "./attempt-report.ts";
import { resultProgress, type ResultProgress } from "../view/results.ts";
import { unplannedSplit, unplannedTotal } from "./unplanned.ts";

/** The head word every surface uses for a run whose record holds no declared result row. */
export const NO_DECLARED_RESULTS = "선언된 결과 없음";
/** The fact counted beside a declared run: work that answers no declared result. */
export const OUT_OF_PLAN_LABEL = "계획 밖";
/** The unit word before a worker count; no particle follows an inserted value. */
export const WORKER_LABEL = "워커";
/** A worker's file-change record, never a tree count: the ledger counted that worker's changing tool results. */
export const WORKER_CHANGE_LABEL = "변경 기록 워커";
/** A parent-tree change count, shown only when the caller's named check actually read the tree. */
export const TREE_CHANGE_LABEL = "부모 트리 변경";
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
	/** Workers whose host record says they changed files; never a count of changed paths, and never a tree claim alone. */
	readonly changed: number;
	/** Deliveries that answer no declared result. */
	readonly unplanned: number;
	/** Placements without a lane: workers the director placed outside the plan. */
	readonly unplannedPlaced: number;
}

/**
 * Where the workers that recorded changes wrote. Only a worker's own accepted parent-tree result (a shared `change` or
 * `artifact`) positively places its writes in the parent; a lane the plan marks isolated, or an accepted retained
 * artifact, places them outside. Everything else — a plan-less placement, a team-isolated plan whose team fact the
 * record does not store, or an accepted row that names no attempt — is unknown. Counts only, so this fact is the same
 * size at any team size.
 */
export interface ChangeAttribution {
	readonly shared: number;
	readonly outside: number;
	readonly unknown: number;
}

/** A stopped or failed worker whose retained patch or branch the record does not bind; the native record is the pointer. */
export interface CaptureUnknown {
	/** Distinct stopped/failed workers on work that could have a checkout, with no bound retained reference. */
	readonly count: number;
	/** The first such worker's native handle (`agent://<id>`); absent when no safe id was recorded. */
	readonly native?: string;
}

/** One cause of a worker stop Storm recorded on its own admission: a count and the first usable native handle. */
export interface StormStopFact {
	readonly reason: WorkerStopReason;
	readonly count: number;
	/** `agent://<id>` is usable for this worker; absent when no safe id was recorded. */
	readonly first?: string;
}

/**
 * Workers Storm itself stopped, counted by cause. The director reads the same fixed sentence per cause, not one line
 * per worker: at a hundred workers this stays two reasons and two handles (fault 2, D11).
 */
export interface StormStopFacts {
	readonly count: number;
	readonly reasons: readonly StormStopFact[];
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
	/** Declared rows exist, but every one is out of the user's scope: no fraction and no success may be shown. */
	readonly allExcluded: boolean;
	/**
	 * Accepted retained artifacts, kept outside the target (row 1). `capture` and `attempt` are the first row's safe,
	 * digest-bound reference; the count is all of them. Fixed size: no list grows with the number of workers.
	 */
	readonly retained: RetainedFacts;
	readonly rows: ResultRowFacts;
	readonly coverage: ResultCoverage;
	readonly activity: WorkerActivity;
	/** Where the workers that recorded changes wrote: parent, outside, or not established. Counts only. */
	readonly changes: ChangeAttribution;
	/**
	 * A stopped or failed worker on work that could have a checkout, with no bound retained reference. Absent when there
	 * is nothing unbound to point at. One count and one native handle: no list grows with the number of workers.
	 */
	readonly captureUnknown?: CaptureUnknown;
	/**
	 * Workers this run's own spawn record says Storm stopped, by cause. Absent when Storm stopped none. Fixed size:
	 * one entry per cause (two today), never one per worker.
	 */
	readonly stormStops?: StormStopFacts;
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

/** A text fact that is present and not blank. */
const hasText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The longest native id a surface will link; matches the host's id bound used by attempt reports. */
const NATIVE_ID = /^[A-Za-z0-9._-]{1,120}$/u;

/**
 * Where each changed worker's writes went, from the record alone. A row's accepted parent-tree result names its attempt,
 * so the worker id is its last segment; a retained artifact is read outside the parent whatever its lane says. A lane
 * the plan marks isolated is outside; a plan-less placement or a lane whose team isolation was not stored is unknown.
 * One pass over the plan, the rows, the spawns and the agents: linear, with keyed maps, never a per-worker scan.
 */
export function changeAttribution(run: RunRecord): ChangeAttribution {
	const isolatedLanes = new Set<string>();
	const plannedById = new Map<string, PlanLaneResult>();
	for (const lane of Array.isArray(run.plan?.lanes) ? run.plan.lanes : []) {
		if (!hasText(lane?.name)) continue;
		if (hasText(lane.isolationReason)) isolatedLanes.add(lane.name);
		for (const result of lane.results ?? []) {
			if (hasText(result?.id) && !plannedById.has(result.id)) plannedById.set(result.id, result);
		}
	}
	const sharedAgents = new Set<string>();
	const outsideAgents = new Set<string>();
	for (const value of Array.isArray(run.results) ? run.results : []) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const row = value as RunResult;
		if (row.state !== "accepted") continue;
		const agent = attemptAgentId(row.attemptId);
		if (agent === undefined) continue;
		const kind = row.contract?.kind ?? plannedById.get(row.id)?.kind;
		const kept = row.proof?.item.artifact !== undefined ||
			(hasText(row.lane) && isolatedLanes.has(row.lane) && kind === "artifact");
		if (kept) outsideAgents.add(agent);
		// 0.29.0 accepts a change only from the parent tree; a shared artifact is read there as well. An answer and a
		// pending or unmet row place no writes.
		else if (kind === "change" || kind === "artifact") sharedAgents.add(agent);
	}
	const laneByAgent = new Map<string, string>();
	for (const spawn of Array.isArray(run.spawns) ? run.spawns : []) {
		if (spawn.outcome === "blocked" || !hasText(spawn.spawnKey) || !hasText(spawn.lane)) continue;
		laneByAgent.set(spawn.spawnKey, spawn.lane);
	}
	let shared = 0;
	let outside = 0;
	let unknown = 0;
	for (const agent of Array.isArray(run.agents) ? run.agents : []) {
		if (!((agent.changes ?? 0) > 0) || agent.role === "quick") continue;
		if (sharedAgents.has(agent.id)) shared += 1;
		else if (outsideAgents.has(agent.id)) outside += 1;
		else if (isolatedLanes.has(laneByAgent.get(agent.id) ?? "\u0000")) outside += 1;
		else unknown += 1;
	}
	return { shared, outside, unknown };
}

/**
 * A stopped or failed worker's retained patch or branch is a native fact this version does not bind. When that exact
 * worker's own accepted row carries a bound retained source, the record shows it as recovery and nothing is unknown;
 * otherwise the surface says capture unknown and points at the native delivery (Run P §6). The line claims no capture:
 * it says only what this record binds, and one native handle is enough to reach the host's own record. One pass over
 * agents, spawns, deliveries and accepted rows, keyed by worker id.
 */
function captureUnknownFact(run: RunRecord): CaptureUnknown | undefined {
	const ids = new Set<string>();
	for (const agent of Array.isArray(run.agents) ? run.agents : []) {
		if (agent.lastWorkFailed === true && hasText(agent.id)) ids.add(agent.id);
	}
	// A worker its own admission stopped (a closed spend) can have left a patch too; the stop is a spawn fact.
	for (const spawn of Array.isArray(run.spawns) ? run.spawns : []) {
		if (spawn?.stop !== undefined && hasText(spawn.spawnKey)) ids.add(spawn.spawnKey);
	}
	for (const delivery of Array.isArray(run.unplanned) ? run.unplanned : []) {
		if ((delivery?.status === "failed" || delivery?.status === "cancelled") && hasText(delivery.agent)) ids.add(delivery.agent);
	}
	if (ids.size === 0) return undefined;
	// A failed worker whose own attempt holds an accepted, bound retained source is recovery, not an unknown capture.
	const recovered = new Set<string>();
	for (const value of Array.isArray(run.results) ? run.results : []) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const row = value as RunResult;
		if (row.state !== "accepted" || row.proof?.item.artifact === undefined) continue;
		const agent = attemptAgentId(row.attemptId);
		if (agent !== undefined) recovered.add(agent);
	}
	for (const id of [...ids]) if (recovered.has(id)) ids.delete(id);
	if (ids.size === 0) return undefined;
	const first = [...ids].find(id => NATIVE_ID.test(id));
	return { count: ids.size, ...(first === undefined ? {} : { native: `agent://${first}` }) };
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
	// A worker its own admission stopped (D5, a closed spend): the record says Storm ended it, not the host. Counted
	// by cause with one native handle, so no list grows with the number of workers (fault 2, D11).
	const stopCounts = new Map<WorkerStopReason, { count: number; first?: string }>();
	for (const spawn of spawns) {
		const stop = spawn.stop;
		if (stop !== undefined) {
			const entry = stopCounts.get(stop.reason) ?? { count: 0 };
			entry.count += 1;
			if (entry.first === undefined && hasText(spawn.spawnKey) && NATIVE_ID.test(spawn.spawnKey)) entry.first = spawn.spawnKey;
			stopCounts.set(stop.reason, entry);
		}
		if (spawn.outcome === "blocked") {
			refused += 1;
			continue;
		}
		placed += 1;
		if (spawn.lane === undefined) unplannedPlaced += 1;
	}
	const stormStops: StormStopFacts | undefined =
		stopCounts.size === 0
			? undefined
			: {
					count: [...stopCounts.values()].reduce((sum, entry) => sum + entry.count, 0),
					reasons: [...stopCounts.entries()]
						.map(([reason, entry]) => ({ reason, count: entry.count, ...(entry.first === undefined ? {} : { first: entry.first }) }))
						.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
				};
	const agents: readonly AgentEntry[] = Array.isArray(run.agents) ? run.agents : [];
	const started = agents.length;
	const settled = agents.filter(agent => agent.state !== "running").length;
	const failed = agents.filter(agent => agent.lastWorkFailed === true).length;
	const changed = agents.filter(agent => (agent.changes ?? 0) > 0).length;
	const unplanned = unplannedTotal(run);
	// `outOfPlan` is work this run asked for outside its declared results; unsolicited arrivals stay in the closeout's
	// own line and never read as planned activity (B8).
	const outOfPlan = unplannedSplit(run).outOfPlan;

	const hasDeclared = declaredRows > 0;
	const allExcluded = hasDeclared && progress.counts.inScope === 0;
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
	const changes = changeAttribution(run);
	const captureUnknown = captureUnknownFact(run);
	return {
		declaration,
		hasDeclared,
		noResultsNotice,
		progress,
		retained,
		allExcluded,
		rows: { total: progress.rows.length, declared: declaredRows, removed, orphaned, excluded: progress.counts.excluded },
		coverage,
		activity,
		changes,
		...(captureUnknown === undefined ? {} : { captureUnknown }),
		...(stormStops === undefined ? {} : { stormStops }),
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
			changes,
			captureUnknown ?? null,
			stormStops ?? null,
			retained,
			allExcluded,
			outOfPlan,
			changedPaths ?? null,
		]),
	};
}

/** `워커 N`: the worker count every no-result view composes the same way. */
export function workerCountText(activity: Pick<WorkerActivity, "placed">): string {
	return `${WORKER_LABEL} ${activity.placed}`;
}
