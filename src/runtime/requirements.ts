/**
 * Requirement bookkeeping for one run. The plan declares contract input (`lane.results`); the run record owns the
 * obligation (`RunRecord.results`). This module only reads those facts:
 * - an id always means one contract, even when an equivalent contract moves to another lane;
 * - a consumer attempt records the producer versions it started from, and those versions are what invalidation reads;
 * - only rows that actually depended on a changed producer are reopened, transitively.
 *
 * It never writes a row, calls a model, reads a file or decides `done/verified`: the controller owns writes and the
 * round gate owns the final call.
 */
import type { PlanLane, ResultInputVersion, RunPlan, RunResult } from "../types.ts";
import { resultContractIdentity } from "./result-evidence.ts";

/** Sentinel for a prerequisite with no usable submission when the consuming attempt started. */
export const MISSING_INPUT = "missing";

/** The version another attempt may rely on now; state is part of it because an unmet result is no longer usable. */
export function currentInputVersion(row: RunResult | undefined): string {
	if (row === undefined) return MISSING_INPUT;
	if (row.state !== "accepted" && row.state !== "reviewable") return MISSING_INPUT;
	return row.contentVersion ?? row.attemptId ?? "observed";
}

/** The producer result ids a lane's declared edges make it consume, in plan order, or none for a lane without edges. */
export function consumedIds(plan: RunPlan | undefined, lane: PlanLane): string[] {
	if (plan === undefined || (lane.dependsOn ?? []).length === 0) return [];
	const lanes = new Map(plan.lanes.map(candidate => [candidate.name, candidate]));
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const dependency of lane.dependsOn ?? []) {
		for (const result of lanes.get(dependency.lane)?.results ?? []) {
			if (seen.has(result.id)) continue;
			seen.add(result.id);
			ids.push(result.id);
		}
	}
	return ids;
}

/** The exact producer version snapshot a consumer attempt starts from; a missing row stays `missing`, never valid later. */
export function inputSnapshot(plan: RunPlan | undefined, lane: PlanLane, rows: readonly RunResult[] | undefined): ResultInputVersion[] {
	const byId = new Map((rows ?? []).map(row => [row.id, row]));
	return consumedIds(plan, lane).map(id => ({ id, version: currentInputVersion(byId.get(id)) }));
}

/**
 * Requirement ids whose current evidence no longer matches the producer versions they started from. The fixpoint is
 * transitive: a row that depended on an already-invalid row is invalid too, even when the producer's own content did
 * not change again. A row with no recorded inputs is independent and never appears here. `missing` is stale by
 * definition: an attempt that started before its prerequisite had a usable submission cannot become valid later.
 */
export function staleRequirementIds(rows: readonly RunResult[]): Set<string> {
	const byId = new Map(rows.map(row => [row.id, row]));
	const bad = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const row of rows) {
			if (bad.has(row.id) || (row.consumed ?? []).length === 0) continue;
			for (const input of row.consumed ?? []) {
				if (input.version === MISSING_INPUT || bad.has(input.id) || currentInputVersion(byId.get(input.id)) !== input.version) {
					bad.add(row.id);
					changed = true;
					break;
				}
			}
		}
	}
	return bad;
}

/** Whether one row's recorded producer versions still describe the current ledger. */
export function hasStaleInputs(row: RunResult | undefined, rows: readonly RunResult[]): boolean {
	if (row === undefined || (row.consumed ?? []).length === 0) return false;
	const byId = new Map(rows.map(candidate => [candidate.id, candidate]));
	return (row.consumed ?? []).some(input => input.version === MISSING_INPUT || currentInputVersion(byId.get(input.id)) !== input.version);
}

/** The requirement facts a conflict check reads; a full row satisfies it without constructing anything. */
type RequirementIdentity = Pick<RunResult, "id" | "identity">;

function conflict(known: readonly RequirementIdentity[], plan: RunPlan): string | undefined {
	const byId = new Map(known.flatMap(row => (row.identity === undefined ? [] : [[row.id, row.identity] as const])));
	const seen = new Set<string>();
	for (const lane of plan.lanes) {
		for (const result of lane.results ?? []) {
			if (seen.has(result.id)) {
				return `결과 id '${result.id}'가 계획 안에서 중복되었습니다. 한 id는 하나의 필수 요구만 뜻합니다.`;
			}
			seen.add(result.id);
			const identity = resultContractIdentity(result);
			const before = byId.get(result.id);
			if (before !== undefined && before !== identity) {
				return `결과 id '${result.id}'의 계약(kind·criterion·path·contains·check)이 이전과 다릅니다. 같은 id로 기존 요구를 바꾸거나 약화할 수 없습니다. 담당 레인을 옮기는 것은 같지만, 실제 범위 변경은 새 id로 내고 사용자가 새 실행에서 승인해야 합니다.`;
			}
		}
	}
	return undefined;
}

/**
 * Refuses a plan that gives an existing requirement id a different contract. The id is the obligation: an exact
 * contract may move to another lane (a transfer keeps its proof), but a changed criterion, kind, path, literal or
 * check needs a new id. A director cannot relax an obligation by reusing its id.
 */
export function requirementConflict(rows: readonly RunResult[] | undefined, plan: RunPlan): string | undefined {
	return conflict(rows ?? [], plan);
}

/** The same check against the plan in force, for the early tool-level replan gate (the run record still checks last). */
export function requirementConflictFromPlan(previous: RunPlan | undefined, next: RunPlan): string | undefined {
	if (previous === undefined) return undefined;
	return conflict(
		previous.lanes.flatMap(lane => (lane.results ?? []).map(result => ({ id: result.id, identity: resultContractIdentity(result) }))),
		next,
	);
}
