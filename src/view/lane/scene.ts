/**
 * What `layout` hands to the painter. Dot coordinates are on the full-width canvas (2 by 4 dots per cell); `at` is the
 * run time in ms a point or mark stands for, so an effect can ask how long ago something happened without knowing the
 * layout.
 */
import type { RunPhase } from "../appearance.ts";
import type { LaneSnapshot, LaneState } from "./model.ts";

/** Dot coordinates on the full-width canvas; `at` is the run time in ms this point stands for. */
export interface PathPoint { x: number; y: number; at: number }
export type StrandKind = "trunk" | "future" | "stem" | "lane" | "join" | "link";
export interface Strand {
	kind: StrandKind;
	/** Index into `snapshot.lanes`; -1 on the trunk. */
	lane: number;
	/** The lane state this stretch was in; null on the trunk. */
	state: LaneState | null;
	from: number;
	to: number;
	/** True when the stretch ends at now. */
	open: boolean;
	/** Ordered in the direction of time. */
	points: readonly PathPoint[];
}
export type MarkKind = "start" | "round" | "accept" | "unmet" | "blocked" | "excluded" | "review" | "job" | "head" | "trunk-head";
/** A node or an event at a cell. `at` lets an effect know how long ago it happened. */
export interface Mark { kind: MarkKind; lane: number; cx: number; cy: number; at: number; done?: boolean; round?: number }
export interface Label {
	side: "left" | "right" | "scale";
	lane: number;
	cx: number;
	cy: number;
	/** Display cells the text occupies. */
	width: number;
	text: string;
	/**
	 * On a lane's labels: `text.slice(0, split)` is the main part (the name, or the state word) and `text.slice(split)`
	 * the secondary part (the role word after the name, or the progress after the state word). Absent elsewhere.
	 */
	split?: number;
}
export interface Scene {
	snapshot: LaneSnapshot;
	cols: number;
	rows: number;
	phase: RunPhase;
	phaseAge: number;
	/** Run time the picture covers. */
	span: number;
	/** Cell columns of the graph area, between the label columns. `cx0` is the first cell, `cx1` is one past the last. */
	graph: { cx0: number; cx1: number };
	/** Dot x of now. */
	headX: number;
	/** Canvas row per lane index; -1 when the lane is folded. */
	rowOf: readonly number[];
	strands: readonly Strand[];
	marks: readonly Mark[];
	labels: readonly Label[];
}
