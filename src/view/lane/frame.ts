/**
 * The lane view: glue between the layout, the canvas and the effects.
 *
 *   layout (layout.ts)     ->  Scene
 *   Canvas (canvas.ts)     <-  paint (effects.ts)
 *   canvas.rows(colour)    ->  the lines
 *
 * The widget calls this about twelve times a second for as long as a run lasts, so a frame does no work that an earlier
 * frame of the same snapshot already did: the layout and, for a still picture, the finished rows are kept from the last
 * call, and the canvas is reused while its size and look stay the same. The snapshot is therefore treated as
 * immutable: change it and hand over a new object.
 */
import { Canvas } from "./canvas.ts";
import { lookOf } from "./colour.ts";
import { liveliness, paint } from "./effects.ts";
import { layout } from "./layout.ts";
import type { LaneSnapshot } from "./model.ts";
import type { Scene } from "./scene.ts";
import { STAGE_MIN_ROWS, stageFrame } from "../stage/render-braille.ts";
import { stageBusy } from "../stage/sequencer.ts";
import { stageCellsFrame } from "../stage/render-pixels.ts";

/** Below this width the widget does not draw the lane view at all. */
export const LANE_MIN_COLUMNS = 60;

export interface LaneFrameOptions { motion: boolean; maxRows: number; colour: "truecolor" | "256"; dark: boolean }

interface Memo {
	snapshot: LaneSnapshot;
	cols: number;
	maxRows: number;
	scene: Scene;
	/** The finished rows of a still picture; absent once `t` mattered. */
	rows?: { colour: LaneFrameOptions["colour"]; dark: boolean; lines: readonly string[] } | undefined;
}

let memo: Memo | undefined;
let canvas: Canvas | undefined;

/**
 * The trunk row, lane rows and the optional summary row: at most `maxRows` strings, each exactly `cols` cells wide.
 * `t` is animation time in ms; with `motion` false the picture does not depend on `t`.
 * Below `LANE_MIN_COLUMNS` there is nothing to draw and the result is empty.
 */
export function laneFrame(snapshot: LaneSnapshot, cols: number, t: number, options: LaneFrameOptions): readonly string[] {
	const width = Math.floor(cols);
	const maxRows = Math.floor(options.maxRows);
	if (!(width >= LANE_MIN_COLUMNS) || !(maxRows >= 1)) return [];

	if (memo === undefined || memo.snapshot !== snapshot || memo.cols !== width || memo.maxRows !== maxRows) {
		memo = { snapshot, cols: width, maxRows, scene: layout(snapshot, width, maxRows) };
	}
	const still = !options.motion;
	const kept = memo.rows;
	if (still && kept !== undefined && kept.colour === options.colour && kept.dark === options.dark) return kept.lines;

	const { scene } = memo;
	if (canvas === undefined || canvas.cw !== width || canvas.ch !== scene.rows || canvas.look.dark !== options.dark) {
		canvas = new Canvas(width, scene.rows, lookOf(options.dark));
	} else {
		canvas.clear();
	}
	paint(scene, canvas, t, options.motion);
	const lines = canvas.rows(options.colour);
	memo.rows = still ? { colour: options.colour, dark: options.dark, lines } : undefined;
	return lines;
}

/** "full": things move every frame; "slow": only a slow pulse (waiting for the user); "still": nothing moves. */
export function laneLiveliness(snapshot: LaneSnapshot): "full" | "slow" | "still" {
	return liveliness(snapshot);
}

/** The stage takes this share of the lane view's width, clamped to the columns below. */
const STAGE_SHARE = 0.3;
export const STAGE_MIN_COLUMNS = 28;
export const STAGE_MAX_COLUMNS = 48;

/** The stage's columns on a lane view `cols` wide; 0 when the graph beside it would be narrower than the lane view's minimum. */
export function stageColumns(cols: number): number {
	const width = Math.floor(cols);
	const stage = Math.min(STAGE_MAX_COLUMNS, Math.max(STAGE_MIN_COLUMNS, Math.round(width * STAGE_SHARE)));
	return width - stage - 1 >= LANE_MIN_COLUMNS ? stage : 0;
}

/** Where the stage and the graph sit in a lane view `cols` wide, and the graph's rows; undefined without a stage. */
export interface LaneViewParts {
	stageCols: number;
	graphCols: number;
	/** The view's rows: the stage's picture rows plus its phrase row. */
	rows: number;
	graph: readonly string[];
}

/** The lane view's parts when it has a stage: the graph rendered at its width, and the rows the stage takes. */
export function laneViewParts(snapshot: LaneSnapshot, cols: number, t: number, options: LaneFrameOptions): LaneViewParts | undefined {
	const width = Math.floor(cols);
	const maxRows = Math.floor(options.maxRows);
	const stageCols = stageColumns(width);
	if (stageCols === 0 || !(maxRows >= STAGE_MIN_ROWS)) return undefined;
	const graphCols = width - stageCols - 1;
	const graph = laneFrame(snapshot, graphCols, t, options);
	if (graph.length === 0) return undefined;
	return { stageCols, graphCols, rows: Math.min(maxRows, Math.max(graph.length, STAGE_MIN_ROWS)), graph };
}

/**
 * The whole lane view: the stage on the left, one blank column, the lane graph on the right, row by row. While the stage
 * is there the view is at least `STAGE_MIN_ROWS` tall (within `maxRows`); its height still follows the graph's rows, so
 * it changes only when a lane comes or goes. Too narrow or too short for a stage: the graph alone, as `laneFrame`.
 * `stage` is the text tier: half blocks (T2) or braille (T3); the image tier (T1) composes `laneViewParts` itself.
 */
export function laneViewFrame(snapshot: LaneSnapshot, cols: number, t: number, options: LaneFrameOptions, stage: "t2" | "t3" = "t3"): readonly string[] {
	const parts = laneViewParts(snapshot, cols, t, options);
	if (parts === undefined) return laneFrame(snapshot, Math.floor(cols), t, options);
	const { stageCols, graphCols, rows, graph } = parts;
	const lines = stage === "t2"
		? stageCellsFrame(snapshot, stageCols, rows, t, options)
		: stageFrame(snapshot, stageCols, rows, t, options);
	const blank = " ".repeat(graphCols);
	return lines.map((line, i) => `${line} ${graph[i] ?? blank}`);
}

/** `laneLiveliness`, kept at full pace while the stage plays a transition, an act or a gathering. */
export function laneViewLiveliness(snapshot: LaneSnapshot, cols: number, maxRows: number): "full" | "slow" | "still" {
	const lane = liveliness(snapshot);
	if (lane === "full" || stageColumns(cols) === 0 || !(Math.floor(maxRows) >= STAGE_MIN_ROWS)) return lane;
	return stageBusy(snapshot) ? "full" : lane;
}
