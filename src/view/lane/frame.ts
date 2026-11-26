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
