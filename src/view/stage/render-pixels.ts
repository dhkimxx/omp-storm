/**
 * The pixel tiers of the stage. T2 draws the composited picture as half blocks: `▀` with the top pixel as the
 * foreground and the bottom pixel as the background, one cell per column and two pixels per row. T1 hands the same
 * picture at 9x18 pixels per cell to the image path (`t1.ts`). Both end with the phrase row, as the braille stage does.
 */
import { textWidth } from "../lane/canvas.ts";
import { laneHue, lookOf, type Rgb } from "../lane/colour.ts";
import { lineColour, textGrey } from "../lane/effects/colours.ts";
import type { LaneSnapshot } from "../lane/model.ts";
import type { StageAssets } from "./assets.ts";
import { STAGE_ASSETS } from "./baked.ts";
import { castLine } from "./cast.ts";
import { type PixelTier, rasterStage } from "./raster.ts";
import { stageScene } from "./scene.ts";
import { stageAt } from "./sequencer.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const sgr = (rgb: number, ground: 38 | 48): string => `${ESC}${ground};2;${(rgb >> 16) & 0xff};${(rgb >> 8) & 0xff};${rgb & 0xff}m`;

/** Rows of `▀` cells for an RGB picture `w` pixels wide and `h` (even) tall; every row is exactly `w` cells. */
export function halfBlockRows(rgb: Uint8Array, w: number, h: number): string[] {
	const at = (x: number, y: number): number => {
		const i = (y * w + x) * 3;
		return (rgb[i]! << 16) | (rgb[i + 1]! << 8) | rgb[i + 2]!;
	};
	const rows: string[] = [];
	for (let y = 0; y + 1 < h; y += 2) {
		let row = "";
		let fg = -1;
		let bg = -1;
		for (let x = 0; x < w; x++) {
			const top = at(x, y);
			const bottom = at(x, y + 1);
			if (top !== fg) row += sgr((fg = top), 38);
			if (bottom !== bg) row += sgr((bg = bottom), 48);
			row += "▀";
		}
		rows.push(row + RESET);
	}
	return rows;
}

function clip(text: string, width: number): string {
	if (textWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const char of text) {
		const w = textWidth(char);
		if (used + w > width - 1) break;
		out += char;
		used += w;
	}
	return `${out}…`;
}

/** The phrase row: the phrase in the view's grey, padded to exactly `cols` cells. */
export function phraseRow(text: string, cols: number, dark: boolean, colour: "truecolor" | "256"): string {
	const shown = clip(text, cols);
	const rgb = textGrey({ dark, bg: lookOf(dark).background });
	const open = colour === "truecolor" ? sgr(rgb, 38) : `${ESC}38;5;${dark ? 248 : 242}m`;
	return `${open}${shown}${RESET}${" ".repeat(Math.max(0, cols - textWidth(shown)))}`;
}

export interface StagePicture {
	w: number;
	h: number;
	rgb: Uint8Array;
	/** The phrase row's text: the cast's line, and how many lanes the swarm holds. */
	phrase: string;
}

/** The stage picture of `cols` by `rows` cells (the phrase row not included) at the tier's pixel size. */
export function stagePicture(
	snapshot: LaneSnapshot,
	cols: number,
	rows: number,
	t: number,
	options: { motion: boolean; dark: boolean },
	tier: PixelTier,
	assets: StageAssets = STAGE_ASSETS,
): StagePicture {
	const moment = stageAt(snapshot, snapshot.now, options.motion);
	const scene = stageScene({ snapshot, moment, cols, rows, t, motion: options.motion });
	const picture = rasterStage({ scene, snapshot, tier, cols, rows, dark: options.dark, liveT: t, motion: options.motion, assets });
	return { ...picture, phrase: phraseOf(moment.cast, scene.swarm?.count) };
}

function phraseOf(cast: Parameters<typeof castLine>[0], swarm: number | undefined): string {
	return `${castLine(cast)}${swarm === undefined ? "" : ` +${swarm}`}`;
}

/** The phrase row's text for a stage of `cols` by `rows` picture cells: the cast's line and the swarm's count. */
export function stagePhrase(snapshot: LaneSnapshot, cols: number, rows: number, motion: boolean): string {
	const moment = stageAt(snapshot, snapshot.now, motion);
	return phraseOf(moment.cast, stageScene({ snapshot, moment, cols, rows, t: 0, motion: false }).swarm?.count);
}

/** The lane colours that can be on stage, in slot order: they pick the T1 palette. */
export function stageLaneColours(snapshot: LaneSnapshot, dark: boolean): Rgb[] {
	const tint = { dark, bg: lookOf(dark).background };
	return snapshot.lanes.map((lane, i) => lineColour(tint, laneHue(lane.slot ?? i)));
}

let still: { snapshot: LaneSnapshot; cols: number; rows: number; dark: boolean; lines: readonly string[] } | undefined;

/** The T2 stage: `rows` strings of exactly `cols` cells, the last one the phrase. With motion off it does not depend on `t`. */
export function stageCellsFrame(
	snapshot: LaneSnapshot,
	cols: number,
	rows: number,
	t: number,
	options: { motion: boolean; dark: boolean },
	assets: StageAssets = STAGE_ASSETS,
): readonly string[] {
	const width = Math.floor(cols);
	const height = Math.floor(rows);
	if (!(width >= 1) || !(height >= 2)) return [];
	if (!options.motion && still?.snapshot === snapshot && still.cols === width && still.rows === height && still.dark === options.dark) return still.lines;
	const picture = stagePicture(snapshot, width, height - 1, t, options, "t2", assets);
	const lines = [...halfBlockRows(picture.rgb, picture.w, picture.h), phraseRow(picture.phrase, width, options.dark, "truecolor")];
	if (!options.motion) still = { snapshot, cols: width, rows: height, dark: options.dark, lines };
	return lines;
}
