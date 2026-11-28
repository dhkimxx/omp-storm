/**
 * The stage as pixels, for the T1 image and the T2 half-block cells: one opaque frame composited from the scene (B0:
 * one image per frame), in the stage's own night (or day) colour. Scene coordinates are braille dots (2 by 4 per cell);
 * T1 has 9x18 pixels per cell (4.5 per dot), T2 one pixel per half cell (0.5 per dot).
 *
 * Colour follows the lane view's energy rule: the art is grey plus alpha, its brightness is energy, and energy takes
 * the individual's colour from the background up to the full colour and on toward the flash. An `accent` layer is
 * drawn in the state's fixed meaning colour: amber waiting for the user, red blocked, green accepted, white otherwise.
 */
import { laneHue, lookOf, mix, type Rgb } from "../lane/colour.ts";
import { amberOf, BASE_CHROMA, BASE_HUE, greenOf, greyOf, hot, lineColour, redOf, textGrey, type Tint, white } from "../lane/effects/colours.ts";
import { hash, mod } from "../lane/effects/math.ts";
import type { LaneSnapshot } from "../lane/model.ts";
import { sequenceId, type StageAssets, type StageFrame, T1_CELL_PX } from "./assets.ts";
import type { Species } from "./cast.ts";
import type { StageChange, StageIndividual, StageScene } from "./scene.ts";

/** Each species' world is drawn in one dim colour of the director's ice-blue family. */
const BACKGROUND_HUE: Readonly<Record<Species, number>> = { octopus: 225, bee: 205, ant: 238, orca: 212, owl: 255, starling: 218 };
const BACKGROUND_CHROMA = 0.09;
const BACKGROUND_ENERGY = 0.5;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How much of the arriving world shows at pixel (x, y) of a `w` by `h` picture; `soft` is the edge's width. */
export function changeMask(change: StageChange, x: number, y: number, w: number, h: number, soft: number): number {
	const p = change.progress;
	switch (change.style) {
		case "rise": {
			// The water line, a little wavy.
			const edge = h * (1 - p) + Math.sin(x / (w / 12 + 1) + p * 6) * soft * 2;
			return clamp01((y - edge) / soft + 0.5);
		}
		case "sink":
			return clamp01((h * p - y) / soft + 0.5);
		case "sweep":
			return clamp01((w * p - x) / soft + 0.5);
		case "radial":
			return clamp01((p * Math.hypot(w, h) * 0.6 - Math.hypot(x - w / 2, y - h / 2)) / soft + 0.5);
		default:
			return p;
	}
}

/** A species' background loop, cut from the left at the stage's width and set on the stage's floor. */
function background(px: Pixels, frame: StageFrame, colour: Rgb, light: number, cover: (x: number, y: number) => number): void {
	const top = px.h - frame.h;
	const table = px.table(colour);
	const scale = (BACKGROUND_ENERGY * light) / 255;
	for (let y = Math.max(0, top); y < px.h; y++) {
		const fy = y - top;
		for (let x = 0; x < Math.min(px.w, frame.w); x++) {
			const i = (fy * frame.w + x) * 4;
			const a = frame.rgba[i + 3]!;
			if (a === 0) continue;
			const c = cover(x, y);
			if (c <= 0) continue;
			px.put(x, y, shadeIn(table, frame.rgba[i]! * scale), (a / 255) * c);
		}
	}
}

/** Tinted background layers by art frame, kept while the frame object lives (baked frames are cached by the loader). */
const backgroundLayers = new WeakMap<StageFrame, Map<string, Uint8Array>>();
const LAYERS_PER_FRAME = 8;

/** A background frame drawn over the stage's own colour at `w` by `h`: the picture's starting pixels. */
function backgroundLayer(frame: StageFrame, colour: Rgb, light: number, w: number, h: number, tint: Tint): Uint8Array {
	const key = `${colour}|${light}|${w}x${h}|${tint.dark ? "d" : "l"}`;
	let layers = backgroundLayers.get(frame);
	const kept = layers?.get(key);
	if (kept !== undefined) return kept;
	const px = new Pixels(w, h, tint);
	background(px, frame, colour, light, () => 1);
	if (layers === undefined) backgroundLayers.set(frame, (layers = new Map()));
	if (layers.size >= LAYERS_PER_FRAME) layers.clear();
	layers.set(key, px.rgb);
	return px.rgb;
}

export type PixelTier = "t1" | "t2";

/** How wide the octopus's worker sprite takes the arm at its anchor, in T1 pixels (the art's own arm start). */
export const ARM_TIP_WIDTH_PX = 5.2;
/** The arm leaves the body this many times as wide as it meets the tip: thick at the body, thin toward the tip. */
export const ARM_ROOT_RATIO = 1.8;

/**
 * The arm's radius in pixels at `u` (0 at the socket, 1 at the tip) for `k` pixels per dot: from `ARM_ROOT_RATIO`
 * times the tip's width at the body down to exactly the tip sprite's width, so the joint does not pinch (T2 keeps the
 * same proportion, never under one pixel).
 */
export function armRadius(u: number, k: number): number {
	const tip = ARM_TIP_WIDTH_PX / 2 / pixelsPerDot("t1");
	const root = tip * ARM_ROOT_RATIO;
	return Math.max(0.5, (root + (tip - root) * u) * k);
}

/** Pixels per braille dot, horizontally and vertically (equal for both tiers at 9x18 per cell). */
export function pixelsPerDot(tier: PixelTier): number {
	return tier === "t1" ? T1_CELL_PX.w / 2 : 0.5;
}

/** The pixel size of a stage picture of `cols` by `rows` cells. */
export function stagePixels(tier: PixelTier, cols: number, rows: number): { w: number; h: number } {
	return tier === "t1" ? { w: cols * T1_CELL_PX.w, h: rows * T1_CELL_PX.h } : { w: cols, h: rows * 2 };
}

const ENERGY_CURVE_DARK = 1.8;
const ENERGY_CURVE_LIGHT = 1.2;
const AMBER_BLINK_MS = 2400;

/** 256 shades of one colour by energy 0..1 (index = energy * 255), then the same up to the flash. */
function shades(tint: Tint, colour: Rgb): Int32Array {
	const out = new Int32Array(512);
	const flash = tint.dark ? 0xffffff : mix(colour, 0x000000, 0.6);
	const curve = tint.dark ? ENERGY_CURVE_DARK : ENERGY_CURVE_LIGHT;
	for (let i = 0; i < 256; i++) out[i] = mix(tint.bg, colour, (i / 255) ** curve);
	for (let i = 0; i < 256; i++) out[256 + i] = mix(colour, flash, i / 255);
	return out;
}

/** Shade tables by look and colour, kept across frames (a frame uses a dozen colours; building one costs 512 mixes). */
const shadeTables = { dark: new Map<Rgb, Int32Array>(), light: new Map<Rgb, Int32Array>() };
const SHADE_TABLES = 256;

/** The colour at `energy` (0..2) in a shade table. */
function shadeIn(table: Int32Array, energy: number): Rgb {
	const e = energy <= 0 ? 0 : energy >= 2 ? 2 : energy;
	return e <= 1 ? table[(e * 255 + 0.5) | 0]! : table[256 + (((e - 1) * 255 + 0.5) | 0)]!;
}

class Pixels {
	readonly rgb: Uint8Array;
	/** Coverage scratch for strokes: each pixel is blended once, at the stroke's highest coverage there. */
	readonly #cover: Float32Array;

	constructor(readonly w: number, readonly h: number, readonly tint: Tint) {
		this.rgb = new Uint8Array(w * h * 3);
		this.#cover = new Float32Array(w * h);
		const bg = tint.bg;
		for (let i = 0; i < w * h; i++) {
			this.rgb[i * 3] = (bg >> 16) & 0xff;
			this.rgb[i * 3 + 1] = (bg >> 8) & 0xff;
			this.rgb[i * 3 + 2] = bg & 0xff;
		}
	}

	/** The shade table of `colour` on this look; fetch it once per sprite or stroke, not per pixel. */
	table(colour: Rgb): Int32Array {
		const tables = this.tint.dark ? shadeTables.dark : shadeTables.light;
		let table = tables.get(colour);
		if (table === undefined) {
			table = shades(this.tint, colour);
			if (tables.size >= SHADE_TABLES) tables.clear();
			tables.set(colour, table);
		}
		return table;
	}

	/** The colour of `colour` at `energy` (0..2) on this look. */
	shade(colour: Rgb, energy: number): Rgb {
		return shadeIn(this.table(colour), energy);
	}

	/**
	 * A stroke of soft discs (pixel centres and radii), blended once per pixel at its highest coverage: overlapping
	 * stamps cost a max, not a blend each.
	 */
	stroke(stamps: readonly { x: number; y: number; r: number }[], rgb: Rgb, alpha: number): void {
		let x0 = this.w;
		let y0 = this.h;
		let x1 = -1;
		let y1 = -1;
		const cover = this.#cover;
		for (const { x, y, r } of stamps) {
			const radius = Math.max(0.5, r);
			const inner = Math.max(0, radius - 0.5) ** 2;
			const top = Math.max(0, Math.floor(y - radius));
			const bottom = Math.min(this.h - 1, Math.ceil(y + radius));
			const left = Math.max(0, Math.floor(x - radius));
			const right = Math.min(this.w - 1, Math.ceil(x + radius));
			for (let py = top; py <= bottom; py++) {
				const dy = py + 0.5 - y;
				for (let px = left; px <= right; px++) {
					const dx = px + 0.5 - x;
					const d2 = dx * dx + dy * dy;
					const c = d2 <= inner ? 1 : radius + 0.5 - Math.sqrt(d2);
					const i = py * this.w + px;
					if (c > cover[i]!) cover[i] = c > 1 ? 1 : c;
				}
			}
			if (left < x0) x0 = left;
			if (top < y0) y0 = top;
			if (right > x1) x1 = right;
			if (bottom > y1) y1 = bottom;
		}
		for (let py = y0; py <= y1; py++) {
			for (let px = x0; px <= x1; px++) {
				const i = py * this.w + px;
				const c = cover[i]!;
				if (c <= 0) continue;
				cover[i] = 0;
				this.put(px, py, rgb, alpha * c);
			}
		}
	}

	/** Alpha-over one pixel. */
	put(x: number, y: number, rgb: Rgb, alpha: number): void {
		const px = Math.floor(x);
		const py = Math.floor(y);
		if (!(px >= 0 && py >= 0 && px < this.w && py < this.h) || !(alpha > 0)) return;
		const a = alpha >= 1 ? 1 : alpha;
		const i = (py * this.w + px) * 3;
		this.rgb[i] = this.rgb[i]! + (((rgb >> 16) & 0xff) - this.rgb[i]!) * a;
		this.rgb[i + 1] = this.rgb[i + 1]! + (((rgb >> 8) & 0xff) - this.rgb[i + 1]!) * a;
		this.rgb[i + 2] = this.rgb[i + 2]! + ((rgb & 0xff) - this.rgb[i + 2]!) * a;
	}

	/** A soft disc of radius `r` pixels (at least one pixel) at (x, y). */
	disc(x: number, y: number, r: number, rgb: Rgb, alpha: number): void {
		const radius = Math.max(0.5, r);
		const small = radius <= 0.75;
		for (let py = Math.floor(y - radius); py <= Math.ceil(y + radius); py++) {
			const dy = py + 0.5 - y;
			for (let px = Math.floor(x - radius); px <= Math.ceil(x + radius); px++) {
				const dx = px + 0.5 - x;
				const d = Math.sqrt(dx * dx + dy * dy);
				const cover = small ? (d <= 0.75 ? 1 : 0) : radius + 0.5 - d;
				if (cover > 0) this.put(px, py, rgb, cover >= 1 ? alpha : alpha * cover);
			}
		}
	}
}

/** Draws one sprite frame tinted by `colour`; `rim` paints the edge (blocked); `flip` mirrors it left to right. */
function sprite(px: Pixels, frame: StageFrame, x0: number, y0: number, colour: Rgb, energy: number, alpha: number, rim: Rgb | undefined, flip = false): void {
	const { w, h, rgba } = frame;
	const table = px.table(colour);
	const scale = energy / 255;
	const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : rgba[(y * w + x) * 4 + 3]!);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const a = rgba[i + 3]!;
			if (a === 0) continue;
			const edge = rim !== undefined && (at(x - 1, y) < 64 || at(x + 1, y) < 64 || at(x, y - 1) < 64 || at(x, y + 1) < 64);
			const rgb = edge ? rim! : shadeIn(table, rgba[i]! * scale);
			px.put(x0 + (flip ? w - 1 - x : x), y0 + y, rgb, (a / 255) * alpha);
		}
	}
}

/** The fixed meaning colour of an individual's accent layer. */
function meaningOf(tint: Tint, item: StageIndividual): Rgb {
	if (item.amber === true) return amberOf(tint);
	if (item.blocked === true) return redOf(tint);
	if ((item.flash ?? 0) > 0) return greenOf(tint);
	return white(tint);
}

export interface RasterInput {
	scene: StageScene;
	snapshot: LaneSnapshot;
	tier: PixelTier;
	/** Stage picture size in cells (without the phrase row). */
	cols: number;
	rows: number;
	dark: boolean;
	/** Live animation time: the amber blink keeps going while the rest stands still. */
	liveT: number;
	motion: boolean;
	assets: StageAssets;
}

/** The stage picture as opaque RGB pixels. */
export function rasterStage(input: RasterInput): { w: number; h: number; rgb: Uint8Array } {
	const { scene, snapshot, tier, motion, assets } = input;
	const { w, h } = stagePixels(tier, input.cols, input.rows);
	const tint: Tint = { dark: input.dark, bg: lookOf(input.dark).background };
	const px = new Pixels(w, h, tint);
	const k = pixelsPerDot(tier);
	const light = scene.light;
	const hueOf = (lane: number): number => laneHue(snapshot.lanes[lane]?.slot ?? lane);
	const laneColour = (lane: number): Rgb => lineColour(tint, hueOf(lane));
	const ice = lineColour(tint, BASE_HUE, BASE_CHROMA);
	const grey = greyOf(tint);
	const dot = (x: number, y: number, rgb: Rgb, energy: number, r = 0.5): void => px.disc(x * k, y * k, r * k, px.shade(rgb, energy), 1);

	// The species' world behind everything; during a change the two worlds meet along the change's edge. A world is
	// drawn once per art frame and look, then copied: it is the largest layer of the picture.
	const world = (species: Species): Uint8Array | undefined => {
		const frame = assets.frame(sequenceId(species, "fx", "background"), scene.backgroundT, tier);
		// The light is stepped so a dimming change reuses a few layers instead of drawing one per frame.
		return frame === undefined ? undefined : backgroundLayer(frame, lineColour(tint, BACKGROUND_HUE[species], BACKGROUND_CHROMA), Math.round(light * 32) / 32, w, h, tint);
	};
	const change = scene.change;
	if (change === undefined) {
		const layer = world(scene.species);
		if (layer !== undefined) px.rgb.set(layer);
	} else {
		const empty = px.rgb.slice();
		const was = world(change.from) ?? empty;
		const next = world(change.to) ?? empty;
		const soft = Math.max(1, k * 0.5);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const m = changeMask(change, x, y, w, h, soft);
				const i = (y * w + x) * 3;
				for (let c = 0; c < 3; c++) px.rgb[i + c] = was[i + c]! + (next[i + c]! - was[i + c]!) * m;
			}
		}
	}

	// The floor of the species' world.
	const orca = scene.species === "orca";
	const x0 = scene.species === "owl" ? Math.floor(scene.width * 0.3) : 0;
	const x1 = scene.species === "owl" ? Math.ceil(scene.width * 0.7) : scene.width;
	for (let x = x0; x < x1; x += orca ? 2 : 3) dot(x, orca ? 0.5 : scene.height - 0.5, orca ? ice : grey, 0.3 * light, 0.4);

	const drops = Math.round(scene.rain * ((scene.width * scene.height) / 60));
	for (let i = 0; i < drops; i++) {
		const x = hash(i * 13 + 1) * scene.width;
		const y = mod(hash(i * 13 + 2) * scene.height + input.liveT * 0.012 * (1 + hash(i * 13 + 3)), scene.height);
		dot(x, y, textGrey(tint), 0.25, 0.3);
	}

	if (scene.rainbow !== undefined) {
		const director = scene.individuals.find(item => item.lane === -1);
		const cx = director?.x ?? scene.width / 2;
		const r = Math.min(scene.width * 0.45, scene.height * 1.1);
		const steps = Math.ceil(r * 6);
		for (let i = 0; i <= steps * scene.rainbow; i++) {
			const a = Math.PI + (Math.PI * i) / steps;
			for (let band = 0; band < 3; band++) {
				dot(cx + (r - band) * Math.cos(a), scene.height - 1 + (r - band) * 0.55 * Math.sin(a), lineColour(tint, 20 + Math.round((i / steps) * 24) * 12.5), 0.75 * light, 0.5);
			}
		}
	}

	// The arms first, so the body and the tips sit on them; they taper from the socket to the tip.
	for (const arm of scene.arms) {
		const length = Math.hypot(arm.to.x - arm.from.x, arm.to.y - arm.from.y) + Math.hypot(arm.control.x - arm.from.x, arm.control.y - arm.from.y);
		// Stamps closer than the arm's narrowest radius overlap into a smooth stroke, each pixel blended once.
		const steps = Math.max(8, Math.ceil((length * k) / Math.max(1, armRadius(1, k))));
		const stamps: { x: number; y: number; r: number }[] = [];
		for (let s = 0; s <= steps; s++) {
			const u = s / steps;
			const v = 1 - u;
			const x = v * v * arm.from.x + 2 * v * u * arm.control.x + u * u * arm.to.x;
			const y = v * v * arm.from.y + 2 * v * u * arm.control.y + u * u * arm.to.y;
			// From the socket to the tip's width (5.2 px wide where the tip sprite takes over), so the joint does not pinch.
			stamps.push({ x: x * k, y: y * k, r: armRadius(u, k) });
		}
		px.stroke(stamps, px.shade(laneColour(arm.lane), 0.7 * light), arm.alpha * 0.9);
	}

	const tierScale = tier === "t1" ? 1 : 1 / T1_CELL_PX.w;
	for (const item of scene.individuals) {
		const meta = assets.meta(item.seq);
		const frame = assets.frame(item.seq, item.t, tier);
		if (meta === undefined || frame === undefined) continue;
		let colour = item.lane < 0 ? ice : laneColour(item.lane);
		if (item.amber === true) {
			// Colours that change every frame are stepped, so the shade tables stay few.
			const blink = motion ? Math.round((0.5 + 0.5 * Math.sin((input.liveT / AMBER_BLINK_MS) * Math.PI * 2)) * 12) / 12 : 1;
			colour = mix(ice, amberOf(tint), 0.45 + 0.55 * blink);
		}
		if (item.lane >= 0 && (item.state === "excluded" || item.state === "idle" || item.state === "refused")) colour = mix(colour, grey, 0.6);
		const flash = item.flash ?? 0;
		if (flash > 0) colour = mix(colour, greenOf(tint), Math.round(flash * 8) / 8);
		// A mirrored sprite keeps its anchor on the same body point.
		const anchorX = item.flip === true ? meta.size.w - meta.anchor.x : meta.anchor.x;
		const left = Math.round(item.x * k - anchorX * tierScale);
		const top = Math.round(item.y * k - meta.anchor.y * tierScale);
		const energy = light * (1 + 0.8 * flash);
		sprite(px, frame, left, top, colour, energy, item.alpha, item.blocked === true ? redOf(tint) : undefined, item.flip === true);
		const accent = assets.accent?.(item.seq, item.t, tier);
		if (accent !== undefined) sprite(px, accent, left, top, meaningOf(tint, item), light * 1.1, item.alpha, undefined, item.flip === true);
	}

	for (const piece of scene.pieces) {
		const colour = piece.excluded ? grey : piece.state === "accepted" ? mix(laneColour(piece.lane), greenOf(tint), 0.35) : laneColour(piece.lane);
		const p = px.shade(colour, light * (piece.state === "accepted" ? 1.1 : 0.85));
		px.disc((piece.x + 0.5) * k, piece.y * k, 0.7 * k, p, piece.alpha);
	}
	// The flock: a bird sprite per dot when it is baked, each a little out of phase, else a dot.
	const fly = sequenceId("starling", "worker", "fly");
	const bird = assets.meta(fly);
	scene.flock.forEach((item, i) => {
		const colour = item.lane < 0 ? ice : laneColour(item.lane);
		// At T2 a bird is a pixel or two: its sprite averages to a faint dot, so the flock draws its own bright dots there.
		// A still picture holds every bird at one wing beat; only a moving one flaps.
		const frame = bird === undefined || tier === "t2" ? undefined : assets.frame(fly, (motion ? input.liveT : 0) + i * 37, tier);
		if (bird === undefined || frame === undefined) return dot(item.x, item.y, colour, 0.9 * light, 0.45);
		sprite(px, frame, Math.round(item.x * k - bird.anchor.x * tierScale), Math.round(item.y * k - bird.anchor.y * tierScale), colour, light, 1, undefined);
	});
	if (scene.swarm !== undefined) {
		const { x, y, lanes } = scene.swarm;
		lanes.slice(0, 12).forEach((lane, i) => dot(x - 4 + hash(i * 5 + 1) * 6, y - 3 + hash(i * 5 + 2) * 4, laneColour(lane), 0.65 * light, 0.45));
	}
	for (const bolt of scene.bolts) {
		const fade = 1 - bolt.progress;
		let x = bolt.x;
		for (let y = 0; y < bolt.y - 3; y += 0.5) {
			if (Math.floor(y) % 2 === 0 && y === Math.floor(y)) x += hash(y * 17 + Math.round(bolt.x)) < 0.5 ? -1 : 1;
			px.disc(x * k, y * k, 0.35 * k, hot(tint, 24), fade);
		}
	}
	for (const burst of scene.bursts) {
		const r = 2 + burst.progress * 8;
		const colour = burst.kind === "accept" ? greenOf(tint) : laneColour(burst.lane);
		for (let i = 0; i < 16; i++) {
			const a = (Math.PI * 2 * i) / 16;
			dot(burst.x + r * Math.cos(a), burst.y + r * 0.6 * Math.sin(a), colour, 1.3 * (1 - burst.progress), 0.4);
		}
	}
	if (scene.wipe !== undefined) for (let y = 0; y < scene.height; y++) dot(scene.wipe, y, textGrey(tint), 0.5, 0.3);
	return { w, h, rgb: px.rgb };
}
