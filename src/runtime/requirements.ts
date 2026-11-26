/**
 * Requirement bookkeeping for one run. The plan declares contract input (`lane.results`); the run record owns the
 * obligation (`RunRecord.results`). This module only reads those facts:
 * - an id always means one contract, even when an equivalent contract moves to another lane;
 * - an input means a logical producer result id and the strength its edge demands, never the predecessor lane name;
 * - a consumer attempt records the producer versions it started from, and those versions are what invalidation reads;
 * - only rows that actually depended on a changed producer are reopened, transitively.
 *
 * It never writes a row, calls a model, reads a file or decides `done/verified`: the controller owns writes and the
 * round gate owns the final call.
 */
import type { LaneNeed, PlanLane, ResultInputVersion, RunPlan, RunResult } from "../types.ts";
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
 * One logical requirement input: the producer result id and the strongest edge level the plan declares to it. The
 * predecessor lane name is deliberately absent. Moving the same result id to another lane is a rename, while a
 * different result id is a changed input even under the same lane name; a stronger level is one only until the
 * producer already satisfies it.
 */
export interface DeclaredInput {
	/** Producer result id, the only stable upstream identity a plan has. */
	id: string;
	/** Strongest declared edge to this id: `reviewable` < `result` < `integrated`. */
	need: LaneNeed;
}

/**
 * Whether a producer result id satisfies a declared edge level now, from facts the caller has verified. `reviewable`
 * and `result` can be read from the ledger row's state; `integrated` needs the controller's tree fact, which a row
 * does not carry.
 */
export type InputSatisfaction = (id: string, need: LaneNeed) => boolean;

/**
 * Builds the `satisfies now` predicate for a plan comparison. The row-state halves mirror `dependencyShortfall` in
 * `lanes.ts`: a `reviewable` edge accepts an accepted or reviewable submission while a `result` edge needs acceptance.
 * Integration is not a row fact — the caller supplies its verified tree answer, and that answer is what makes an
 * accepted producer enough for an `integrated` edge. Location and receipt liveness of an accepted row stay with the
 * controller's own revalidation passes; this predicate never overrides a row that no longer has evidence.
 */
export function ledgerInputSatisfaction(
	rows: readonly RunResult[] | undefined,
	integrated: (id: string) => boolean,
): InputSatisfaction {
	const byId = new Map((rows ?? []).map(row => [row.id, row]));
	return (id, need) => {
		const row = byId.get(id);
		if (row === undefined) return false;
		if (need === "integrated") return row.state === "accepted" && integrated(id);
		return row.state === "accepted" || (need === "reviewable" && row.state === "reviewable");
	};
}

/** Strength order for two edges that reach the same producer result; the stricter edge subsumes the weaker one. */
const INPUT_STRENGTH: Readonly<Record<LaneNeed, number>> = { reviewable: 0, result: 1, integrated: 2 };

/** Merge duplicate producer ids by their strongest edge and sort by id, so two equivalent declarations compare equal. */
function canonicalInputs(inputs: readonly DeclaredInput[]): DeclaredInput[] {
	const merged = new Map<string, LaneNeed>();
	for (const input of inputs) {
		const before = merged.get(input.id);
		merged.set(input.id, before === undefined || INPUT_STRENGTH[input.need] >= INPUT_STRENGTH[before] ? input.need : before);
	}
	return [...merged].map(([id, need]) => ({ id, need })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * The logical inputs a lane declares: every producer result reachable through its dependency edges, keyed by result id
 * and carrying the strongest declared level. A predecessor lane with no declared results contributes no result
 * identity, so renaming it cannot change this fingerprint. The result is canonical (unique ids, id order).
 */
export function declaredInputs(plan: RunPlan | undefined, lane: PlanLane): DeclaredInput[] {
	if (plan === undefined) return [];
	const lanes = new Map(plan.lanes.map(candidate => [candidate.name, candidate]));
	const inputs: DeclaredInput[] = [];
	for (const dependency of lane.dependsOn ?? []) {
		for (const result of lanes.get(dependency.lane)?.results ?? []) {
			inputs.push({ id: result.id, need: dependency.need });
		}
	}
	return canonicalInputs(inputs);
}

/**
 * Whether two declarations are equivalent: the same logical result ids, and no level that got stronger unless the
 * producer satisfies the new level now. `left` is the earlier declaration and `right` the later one. A weaker or equal
 * new level never asks for more of the same consumed content, so it is not a change. Without a `satisfied` fact a
 * stronger level is a change, which keeps the conservative answer for callers that cannot verify the producer's current
 * state. Added, removed or swapped ids are a change whatever the predicate says.
 */
export function sameDeclaredInputs(
	left: readonly DeclaredInput[],
	right: readonly DeclaredInput[],
	satisfied?: InputSatisfaction,
): boolean {
	const before = new Map(canonicalInputs(left).map(input => [input.id, input.need]));
	const after = canonicalInputs(right);
	if (before.size !== after.length) return false;
	for (const input of after) {
		const old = before.get(input.id);
		if (old === undefined) return false;
		if (INPUT_STRENGTH[input.need] > INPUT_STRENGTH[old] && !(satisfied?.(input.id, input.need) ?? false)) return false;
	}
	return true;
}

/** Exact, order-independent fingerprint for an attempt snapshot; never includes a lane name. */
export function declaredInputFingerprint(inputs: readonly DeclaredInput[]): string {
	return JSON.stringify(canonicalInputs(inputs).map(input => [input.id, input.need]));
}

/** The inputs declared for the lane that currently owns `resultId`; undefined when the plan no longer owns that id. */
export function resultInputs(plan: RunPlan | undefined, resultId: string): DeclaredInput[] | undefined {
	if (plan === undefined) return undefined;
	for (const lane of plan.lanes) {
		if ((lane.results ?? []).some(result => result.id === resultId)) return declaredInputs(plan, lane);
	}
	return undefined;
}

/**
 * Requirement ids whose logical upstream inputs differ between two plans. Requirements are located by id in both
 * plans, so renaming a producer or consumer lane (with the edges following the same result ids) is not a change. A
 * level that got weaker is not a change, and a level that got stronger is one only while `satisfied` cannot confirm
 * the producer meets it. A new id has no earlier evidence and is absent; a removed id is left to the ledger's orphan
 * handling.
 */
export function changedInputRequirements(
	previous: RunPlan | undefined,
	next: RunPlan,
	satisfied?: InputSatisfaction,
): Set<string> {
	const changed = new Set<string>();
	if (previous === undefined) return changed;
	const before = new Map<string, DeclaredInput[]>();
	for (const lane of previous.lanes) {
		for (const result of lane.results ?? []) before.set(result.id, declaredInputs(previous, lane));
	}
	for (const lane of next.lanes) {
		for (const result of lane.results ?? []) {
			const old = before.get(result.id);
			if (old === undefined) continue;
			if (!sameDeclaredInputs(old, declaredInputs(next, lane), satisfied)) changed.add(result.id);
		}
	}
	return changed;
}

/**
 * Whether a recorded producer-id snapshot still names exactly the declared logical inputs. This is the identity half:
 * versions are compared by `staleRequirementIds`, and strength comes from the plan transition or a captured attempt
 * declaration. Duplicate or missing ids are a mismatch, and an absent snapshot means the attempt declared no inputs.
 */
export function recordedInputsMatch(
	declared: readonly DeclaredInput[],
	consumed: readonly ResultInputVersion[] | undefined,
): boolean {
	const expected = canonicalInputs(declared).map(input => input.id);
	const recorded = (consumed ?? []).map(input => input.id).sort();
	if (recorded.length !== expected.length) return false;
	const unique = new Set(recorded);
	if (unique.size !== recorded.length) return false;
	return expected.every((id, index) => id === recorded[index]);
}

/**
 * Whether an in-flight attempt's captured declaration still equals what the current plan declares for every result it
 * can produce. Result ids locate the lane, so a pure lane rename preserves the attempt; a swapped, added or removed
 * input makes its late result unusable. A level that got weaker keeps it; a level that got stronger keeps it only when
 * `satisfied` confirms the producer meets the new level now.
 */
export function attemptInputsCurrent(
	plan: RunPlan | undefined,
	produced: readonly string[],
	captured: readonly DeclaredInput[] | undefined,
	satisfied?: InputSatisfaction,
): boolean {
	// A run without a plan has no declaration to compare against; the existing version snapshot remains the guard.
	if (plan === undefined || produced.length === 0) return true;
	for (const id of produced) {
		const current = resultInputs(plan, id);
		if (current === undefined || !sameDeclaredInputs(captured ?? [], current, satisfied)) return false;
	}
	return true;
}

/**
 * Transitive producer-version fixpoint. `bad` may already hold ids invalidated by a plan comparison; every recorded
 * consumer of one of those ids is added too, then the ordinary version/missing checks continue to a fixpoint.
 */
function staleInputFixpoint(
	rows: readonly RunResult[],
	byId: ReadonlyMap<string, RunResult>,
	bad: Set<string>,
): Set<string> {
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

/**
 * Requirement ids whose current evidence no longer matches the producer versions they started from. The fixpoint is
 * transitive: a row that depended on an already-invalid row is invalid too, even when the producer's own content did
 * not change again. A row with no recorded inputs is independent and never appears here. `missing` is stale by
 * definition: an attempt that started before its prerequisite had a usable submission cannot become valid later.
 */
export function staleRequirementIds(rows: readonly RunResult[]): Set<string> {
	return staleInputFixpoint(rows, new Map(rows.map(row => [row.id, row])), new Set<string>());
}

/** Whether one row's recorded producer versions still describe the current ledger. */
export function hasStaleInputs(row: RunResult | undefined, rows: readonly RunResult[]): boolean {
	if (row === undefined || (row.consumed ?? []).length === 0) return false;
	const byId = new Map(rows.map(candidate => [candidate.id, candidate]));
	return (row.consumed ?? []).some(input => input.version === MISSING_INPUT || currentInputVersion(byId.get(input.id)) !== input.version);
}

/**
 * Requirement ids whose evidence cannot stand under `plan`, including evidence carried by a finalized row.
 *
 * The plan half compares the recorded producer ids with the logical inputs declared for the lane that currently owns
 * the requirement, and checks each declared level against the producer's current state. Passing `previous` adds the
 * exact plan transition: a requirement whose producer set changed, or whose level got stronger beyond what `satisfied`
 * can confirm, is invalid even while its version snapshot still names the same content. Once seeded, the version
 * fixpoint makes the answer transitive, so a consumer of an invalid requirement is reopened in the same pass without
 * waiting for a row write. Rows whose id left the plan have no current declaration and are left to orphan handling; no
 * row is written here.
 */
export function staleRequirementIdsForPlan(
	rows: readonly RunResult[],
	plan: RunPlan | undefined,
	previous?: RunPlan,
	satisfied?: InputSatisfaction,
): Set<string> {
	const byId = new Map(rows.map(row => [row.id, row]));
	const bad = plan === undefined || previous === undefined ? new Set<string>() : changedInputRequirements(previous, plan, satisfied);
	if (plan !== undefined) {
		for (const row of rows) {
			if (row.scope === "excluded-by-user") continue;
			const declared = resultInputs(plan, row.id);
			if (declared === undefined) continue;
			// A requirement that never attempted records nothing; only evidence or a recorded snapshot can disagree.
			if (row.state !== "accepted" && row.state !== "reviewable" && row.consumed === undefined) continue;
			if (!recordedInputsMatch(declared, row.consumed)) {
				bad.add(row.id);
				continue;
			}
			for (const input of declared) {
				const producer = byId.get(input.id);
				const usable = producer !== undefined &&
					(input.need === "reviewable"
						? producer.state === "accepted" || producer.state === "reviewable"
						: producer.state === "accepted");
				if (!usable) {
					bad.add(row.id);
					break;
				}
			}
		}
	}
	return staleInputFixpoint(rows, byId, bad);
}

/** The requirement facts a conflict check reads; a full row satisfies it without constructing anything. */
type RequirementIdentity = Pick<RunResult, "id" | "identity">;

function conflict(known: readonly RequirementIdentity[], plan: RunPlan): string | undefined {
	const byId = new Map(known.flatMap(row => (row.identity === undefined ? [] : [[row.id, row.identity] as const])));
	const seen = new Set<string>();
	for (const lane of plan.lanes) {
		for (const result of lane.results ?? []) {
			if (seen.has(result.id)) {
				return `'${result.id}' 결과 id가 계획 안에서 중복되었습니다. 한 id는 하나의 필수 요구만 뜻합니다.`;
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
