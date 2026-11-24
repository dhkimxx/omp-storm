/**
 * The planned optional lane wire (S1 results, S2 dependencies), in one place so every acceptance scenario submits
 * the same shape and the baseline case differs only by dropping these optional fields.
 *
 * Baseline does not know these fields: `contract: false` keeps the pre-S1 lane shape for the original binary. The
 * current fresh-plan boundary refuses a deliverable lane without results, so baseline runs are historical evidence;
 * candidate acceptance always uses `contract: true`.
 */
import type { Step } from "./fake-llm.ts";

export type LaneResultKind = "change" | "artifact" | "answer";
export type LaneNeed = "result" | "integrated" | "reviewable";

/** One required outcome of a lane: what to check and where. */
export interface LaneResult {
	id: string;
	kind: LaneResultKind;
	criterion: string;
	path?: string;
	contains?: string;
	check?: string;
}

/** A prerequisite lane and the state its consumer needs. */
export interface LaneDependency {
	lane: string;
	need: LaneNeed;
}

export type ContractLaneKind = "explore" | "code" | "run" | "review" | "design";

/** A plan lane with the optional result/dependency wire appended. */
export interface ContractLane {
	name: string;
	kind: ContractLaneKind;
	role?: string;
	files?: string[];
	goal?: string;
	isolationReason?: string;
	progress?: string;
	results?: readonly LaneResult[];
	dependsOn?: readonly LaneDependency[];
}

export interface ContractPlanOptions {
	/** Per-role live agent counts, as the storm plan tool takes them. */
	workers?: Record<string, number>;
	/** Submit the planned fields; false keeps only the pre-S1 lane shape. */
	contract: boolean;
}

export function requiredResult(id: string, kind: LaneResultKind, criterion: string, extra: Omit<LaneResult, "id" | "kind" | "criterion"> = {}): LaneResult {
	return { id, kind, criterion, ...extra };
}

/** The lane fields the pre-S1 validator reads; `progress` is copied too because it is status text, not contract. */
function baselineLane(lane: ContractLane): Record<string, unknown> {
	const next: Record<string, unknown> = { name: lane.name, kind: lane.kind };
	if (lane.role !== undefined) next.role = lane.role;
	if (lane.files !== undefined) next.files = lane.files;
	if (lane.goal !== undefined) next.goal = lane.goal;
	if (lane.isolationReason !== undefined) next.isolationReason = lane.isolationReason;
	if (lane.progress !== undefined) next.progress = lane.progress;
	return next;
}

/** A `storm plan` step with the planned wire, or with only the fields the baseline validator knows. */
export function contractPlan(lanes: readonly ContractLane[], options: ContractPlanOptions): Step {
	const submitted = options.contract ? lanes.map(lane => ({ ...lane })) : lanes.map(baselineLane);
	return {
		storm: {
			action: "plan",
			plan: {
				lanes: submitted,
				...(options.workers !== undefined ? { workers: options.workers } : {}),
			},
		},
	};
}
