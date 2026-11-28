import type { IntegrationFacts } from "../../runtime/result-facts.ts";
import type { RunPhase } from "../appearance.ts";

export type LaneState =
	| "reserved" | "waiting" | "running" | "quiet" | "submitted" | "reviewing"
	| "accepted" | "unmet" | "blocked" | "excluded" | "idle" | "refused";
/** The role word of a row that exists because the run placed a worker outside the plan. */
export const UNPLANNED_LABEL = "계획 밖";
/** Milliseconds from run start. `to` absent means the span is still open at `now`. */
export interface LaneSpan { from: number; to?: number; state: LaneState }
export interface PhaseSpan { from: number; to?: number; phase: RunPhase }
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
}
