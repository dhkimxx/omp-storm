/**
 * The stage on the braille canvas (T3, and the path every terminal uses until the cell and pixel renderers land): the
 * scene's individuals sampled from their T1 frames at dot resolution and tinted, the pieces, the flock, the weather,
 * and the one-line phrase on the stage's last row so species and state read without colour or motion.
 */
import { Canvas, textWidth } from "../lane/canvas.ts";
import { laneHue, lookOf, mix, type Rgb } from "../lane/colour.ts";
import { amberOf, BASE_CHROMA, BASE_HUE, greenOf, greyOf, hot, lineColour, redOf, textGrey, type Tint } from "../lane/effects/colours.ts";
import { hash, mod } from "../lane/effects/math.ts";
import type { LaneSnapshot } from "../lane/model.ts";
import { type StageAssets, T1_CELL_PX, type T1Frame } from "./assets.ts";
import { STAGE_ASSETS } from "./baked.ts";
import { castLine } from "./cast.ts";
import { stageAt } from "./sequencer.ts";
import { type StageScene, stageScene } from "./scene.ts";

/** Below this many rows the stage is not drawn; the lane view grows to it while the stage is there. */
export const STAGE_MIN_ROWS = 5;

export interface StageFrameOptions { motion: boolean; colour: "truecolor" | "256"; dark: boolean }

const PX_PER_DOT_X = T1_CELL_PX.w / 2;
const PX_PER_DOT_Y = T1_CELL_PX.h / 4;
/** A pixel this opaque lights its dot. */
const COVER = 96;
const AMBER_BLINK_MS = 2400;

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

function draw(canvas: Canvas, frame: T1Frame, anchor: { x: number; y: number }, x: number, y: number, colour: Rgb, energy: number, edge: Rgb | undefined, flip = false): void {
	const dw = Math.ceil(frame.w / PX_PER_DOT_X);
	const dh = Math.ceil(frame.h / PX_PER_DOT_Y);
	const x0 = Math.round(x - (flip ? frame.w - anchor.x : anchor.x) / PX_PER_DOT_X);
	const y0 = Math.round(y - anchor.y / PX_PER_DOT_Y);
	const covered = (dx: number, dy: number): number => {
		if (dx < 0 || dy < 0 || dx >= dw || dy >= dh) return 0;
		const px = Math.min(frame.w - 1, Math.floor((dx + 0.5) * PX_PER_DOT_X));
		const py = Math.min(frame.h - 1, Math.floor((dy + 0.5) * PX_PER_DOT_Y));
		return frame.rgba[(py * frame.w + px) * 4 + 3]!;
	};
	for (let dy = 0; dy < dh; dy++) {
		for (let dx = 0; dx < dw; dx++) {
			const alpha = covered(dx, dy);
			if (alpha < COVER) continue;
			const rim = edge !== undefined && (covered(dx - 1, dy) < COVER || covered(dx + 1, dy) < COVER || covered(dx, dy - 1) < COVER || covered(dx, dy + 1) < COVER);
			canvas.dot(x0 + (flip ? dw - 1 - dx : dx), y0 + dy, rim ? edge! : colour, (alpha / 255) * energy * (rim ? 1.2 : 1));
		}
	}
}

/** Paints `scene` onto `canvas`; `liveT` keeps the amber blink going while everything else stands still. */
export function paintStage(scene: StageScene, snapshot: LaneSnapshot, canvas: Canvas, tint: Tint, liveT: number, motion: boolean, assets: StageAssets): void {
	const { width: w, height: h, light } = scene;
	const hueOf = (lane: number): number => laneHue(snapshot.lanes[lane]?.slot ?? lane);
	const laneColour = (lane: number): Rgb => lineColour(tint, hueOf(lane));
	const ice = lineColour(tint, BASE_HUE, BASE_CHROMA);
	const grey = greyOf(tint);

	// The floor of the species' world, faint: seabed, meadow, soil, water, branch.
	const floorY = h - 1;
	for (let x = scene.species === "owl" ? Math.floor(w * 0.3) : 0; x < (scene.species === "owl" ? Math.ceil(w * 0.7) : w); x += scene.species === "orca" ? 2 : 3) {
		canvas.dot(x, scene.species === "orca" ? 0 : floorY, scene.species === "orca" ? ice : grey, 0.22 * light);
	}

	// Rain: how much parallel work runs.
	const drops = Math.round(scene.rain * ((w * h) / 60));
	for (let k = 0; k < drops; k++) {
		const x = Math.floor(hash(k * 13 + 1) * w);
		const y = Math.floor(mod(hash(k * 13 + 2) * h + liveT * 0.012 * (1 + hash(k * 13 + 3)), h));
		canvas.dot(x, y, textGrey(tint), 0.2);
	}

	// The finale's rainbow, drawn around the director as it grows.
	if (scene.rainbow !== undefined) {
		const director = scene.individuals.find(item => item.lane === -1);
		const cx = director?.x ?? w / 2;
		const r = Math.min(w * 0.45, h * 1.1);
		const steps = Math.ceil(r * 3);
		for (let i = 0; i <= steps * scene.rainbow; i++) {
			const a = Math.PI + (Math.PI * i) / steps;
			for (let band = 0; band < 3; band++) {
				canvas.dot(cx + (r - band) * Math.cos(a), h - 1 + (r - band) * 0.55 * Math.sin(a), lineColour(tint, 20 + (i / steps) * 300), 0.7 * light);
			}
		}
	}

	for (const arm of scene.arms) {
		const steps = 24;
		for (let s = 0; s <= steps; s++) {
			const u = s / steps;
			const v = 1 - u;
			const x = v * v * arm.from.x + 2 * v * u * arm.control.x + u * u * arm.to.x;
			const y = v * v * arm.from.y + 2 * v * u * arm.control.y + u * u * arm.to.y;
			canvas.dot(x, y, laneColour(arm.lane), (0.75 - 0.35 * u) * arm.alpha * light);
		}
	}

	for (const item of scene.individuals) {
		const meta = assets.meta(item.seq);
		const frame = assets.frame(item.seq, item.t, "t1");
		if (meta === undefined || frame === undefined || frame.tier !== "t1") continue;
		let colour = item.lane < 0 ? ice : laneColour(item.lane);
		if (item.amber === true) {
			const blink = motion ? 0.5 + 0.5 * Math.sin((liveT / AMBER_BLINK_MS) * Math.PI * 2) : 1;
			colour = mix(ice, amberOf(tint), 0.45 + 0.55 * blink);
		}
		if (item.lane >= 0 && (item.state === "excluded" || item.state === "idle" || item.state === "refused")) colour = mix(colour, grey, 0.6);
		const flash = item.flash ?? 0;
		if (flash > 0) colour = mix(colour, greenOf(tint), flash);
		draw(canvas, frame, meta.anchor, item.x, item.y, colour, item.alpha * light * (1 + 0.8 * flash), item.blocked === true ? redOf(tint) : undefined, item.flip === true);
	}

	for (const piece of scene.pieces) {
		const colour = piece.excluded ? grey : piece.state === "accepted" ? mix(laneColour(piece.lane), greenOf(tint), 0.35) : laneColour(piece.lane);
		const energy = piece.alpha * light * (piece.state === "accepted" ? 1.05 : 0.8);
		canvas.dot(piece.x, piece.y, colour, energy);
		canvas.dot(piece.x + 1, piece.y, colour, energy);
	}

	for (const dot of scene.flock) canvas.dot(dot.x, dot.y, dot.lane < 0 ? ice : laneColour(dot.lane), 0.85 * light);

	if (scene.swarm !== undefined) {
		const { x, y, count, lanes } = scene.swarm;
		lanes.slice(0, 12).forEach((lane, k) => canvas.dot(x - 4 + hash(k * 5 + 1) * 6, y - 3 + hash(k * 5 + 2) * 4, laneColour(lane), 0.6 * light));
		const label = `+${count}`;
		canvas.text(Math.max(0, Math.floor(x / 2) - label.length + 2), Math.min(canvas.ch - 2, Math.floor(y / 4)), label, textGrey(tint), 0.9);
	}

	for (const bolt of scene.bolts) {
		const fade = 1 - bolt.progress;
		let x = bolt.x;
		for (let y = 0; y < bolt.y - 3; y++) {
			if (y % 2 === 0) x += hash(y * 17 + Math.round(bolt.x)) < 0.5 ? -1 : 1;
			canvas.dot(x, y, hot(tint, 24), 1.6 * fade);
		}
	}
	for (const burst of scene.bursts) {
		const r = 2 + burst.progress * 8;
		const colour = burst.kind === "accept" ? greenOf(tint) : laneColour(burst.lane);
		for (let i = 0; i < 12; i++) {
			const a = (Math.PI * 2 * i) / 12;
			canvas.dot(burst.x + r * Math.cos(a), burst.y + r * 0.6 * Math.sin(a), colour, 1.2 * (1 - burst.progress));
		}
	}
	if (scene.wipe !== undefined) for (let y = 0; y < h; y++) canvas.dot(scene.wipe, y, textGrey(tint), 0.5);
}

interface Memo {
	snapshot: LaneSnapshot;
	cols: number;
	rows: number;
	colour: StageFrameOptions["colour"];
	dark: boolean;
	lines: readonly string[];
}
let still: Memo | undefined;
let canvas: Canvas | undefined;

/**
 * The stage: `rows` strings of exactly `cols` cells. The last row is the phrase; the rows above are the picture.
 * With `motion` false the result does not depend on `t` and is kept for the same snapshot and look.
 */
export function stageFrame(snapshot: LaneSnapshot, cols: number, rows: number, t: number, options: StageFrameOptions, assets: StageAssets = STAGE_ASSETS): readonly string[] {
	const width = Math.floor(cols);
	const height = Math.floor(rows);
	if (!(width >= 1) || !(height >= 2)) return [];
	if (!options.motion && still !== undefined && still.snapshot === snapshot && still.cols === width && still.rows === height && still.colour === options.colour && still.dark === options.dark) {
		return still.lines;
	}
	const look = lookOf(options.dark);
	if (canvas === undefined || canvas.cw !== width || canvas.ch !== height || canvas.look.dark !== options.dark) canvas = new Canvas(width, height, look);
	else canvas.clear();
	const tint: Tint = { dark: options.dark, bg: look.background };
	const moment = stageAt(snapshot, snapshot.now, options.motion);
	canvas.text(0, height - 1, clip(castLine(moment.cast), width), textGrey(tint), 1);
	const scene = stageScene({ snapshot, moment, cols: width, rows: height - 1, t, motion: options.motion });
	paintStage(scene, snapshot, canvas, tint, t, options.motion, assets);
	const lines = canvas.rows(options.colour);
	if (!options.motion) still = { snapshot, cols: width, rows: height, colour: options.colour, dark: options.dark, lines };
	return lines;
}
