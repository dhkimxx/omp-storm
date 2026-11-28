import type { IntegrationFacts } from "../../runtime/result-facts.ts";
import type { RunResultState } from "../../types.ts";
import type { RunPhase } from "../appearance.ts";

export type LaneState =
	| "reserved" | "waiting" | "running" | "quiet" | "submitted" | "reviewing"
	| "accepted" | "unmet" | "blocked" | "excluded" | "idle" | "refused";
/** The role word of a row that exists because the run placed a worker outside the plan. */
export const UNPLANNED_LABEL = "계획 밖";
/** Milliseconds from run start. `to` absent means the span is still open at `now`. */
export interface LaneSpan { from: number; to?: number; state: LaneState }
export interface PhaseSpan { from: number; to?: number; phase: RunPhase }
/**
 * What a lane's worker may do, read from the record: a job lane runs an approved job, a review lane judges, a read lane
 * declares no writable result (the policy's `readOnlyIntent`), everything else writes. An unplanned worker's intent
 * comes from its role. Never from `label`, which is only a display word.
 */
export type LaneIntent = "read" | "write" | "review" | "job";
/** One required result of a lane: one piece on the stage. `state` is the ledger's; `excluded` the user's scope decision. */
export interface LanePiece { id: string; state: RunResultState; excluded?: true }
/** A moment the team was (re)assembled: the run started, continued an earlier run, or the plan's lane set changed. */
export interface LaneMilestone { at: number; kind: "start" | "resume" | "replan" }
/** A moment one of a lane's rows got a new judgment while the view watched: a delivery, a verdict, a block. */
export interface LaneJudgment { at: number; kind: "submit" | "accept" | "unmet" | "blocked" }
export interface LaneTrack {
	name: string;
	/** Short Korean word for what the lane does, shown next to its name. */
	label: string;
	/** A fixed job rather than a worker: drawn with square nodes. */
	job?: true;
	dependsOn: readonly string[];
	/** Ordered, gapless from the lane's first appearance to now. */
	spans: readonly LaneSpan[];
	/** Stable colour slot, assigned when the lane is first seen; a replan that drops or adds lanes does not recolour the others. Absent: the lane's index. */
	slot?: number;
	/** 0..1, how busy the worker is right now; drives flow speed. */
	activity?: number;
	/** Results of this lane that are met, of those in scope; shown when total is above 1. */
	progress?: { met: number; total: number };
	/**
	 * Every accepted result is a retained artifact kept outside the target: the lane's work was not applied, so the
	 * picture must not draw it as an integrated acceptance (B7).
	 */
	retained?: true;
	/** Absent on scripted tracks: a job lane counts as `job`, any other as `write`. */
	intent?: LaneIntent;
	/** A write lane whose write set cannot be narrowed (no file list, no isolation): one at a time against other writers. */
	unscoped?: true;
	/** The hub-visible name (`agent://<id>`) of the lane's running worker, else its latest one; absent before any worker. */
	agent?: string;
	/** The lane's required results in ledger order. */
	pieces?: readonly LanePiece[];
	/** Offsets at which the user sent this lane's worker a turn directly (I2), one per turn, never one already there when the lane was first seen. */
	steeredAt?: readonly number[];
	/** Offsets at which the user stopped this lane's worker (I4), by the same rule. */
	stoppedAt?: readonly number[];
	/**
	 * The moments a row of this lane got a new judgment (state, remedy, attempt, content version or authority) while
	 * the view watched; a worker settling is not one. A lane with `pieces` takes its result acts from these alone.
	 */
	judgedAt?: readonly LaneJudgment[];
}
export interface LaneSnapshot {
	now: number;
	phases: readonly PhaseSpan[];
	/** Offsets at which a round started; the first is 0. */
	rounds: readonly number[];
	lanes: readonly LaneTrack[];
	/** Every in-scope result is met: a stopping run ends in the finale instead of lights out. */
	complete: boolean;
	/** The run's integration queue, from C's one projection; absent when the caller read no journal. */
	integration?: IntegrationFacts;
	/** When the team was assembled: the start (or resume) at 0 and every later change of the plan's lane set. */
	milestones?: readonly LaneMilestone[];
	/** Offset at which spend first reached the approved warning line; absent while it has not. */
	budgetWarnAt?: number;
	/**
	 * View-only evidence from the live controller, like the phase: the director's own path edit holds the tree right now.
	 * Never stored and never used to decide the run.
	 */
	directorEditing?: true;
}
