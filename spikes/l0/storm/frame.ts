/**
 * Variant "storm": glue between the layout, the canvas and the effects.
 *
 *   layout (storm/layout.ts)  ->  Scene
 *   Canvas (storm/canvas.ts)  <-  paint (storm/effects.ts)
 *   canvas.rows(options)      ->  the lines
 *
 * ASCII mode and widths under 60 columns are handed to the first Braille variant, which has a one-line fallback.
 */
import type { Frame } from "../model.ts";
import { frame as brailleFrame } from "../braille/frame.ts";
import { Canvas } from "./canvas.ts";
import { lookOf } from "./colour.ts";
import { paint } from "./effects.ts";
import { layout } from "./layout.ts";

export const MIN_COLUMNS = 60;

export const frame: Frame = (snapshot, cols, t, options) => {
	if (options.ascii || cols < MIN_COLUMNS) return brailleFrame(snapshot, cols, t, options);
	const scene = layout(snapshot, cols, options.maxRows);
	const canvas = new Canvas(cols, scene.rows, lookOf(options.dark !== false));
	paint(scene, canvas, t, options.motion);
	return canvas.rows(options);
};
