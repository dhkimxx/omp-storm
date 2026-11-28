/**
 * The T1 stage's 256-colour palette (B0: one indexed PNG per frame). It is built from what can be on stage, so the
 * same lanes and look always give the same palette: the background, a brightness ramp of the director's ice blue, of
 * every active lane colour, of the fixed meaning colours (amber waiting, red blocked, green accepted, white light) and
 * of grey, plus a hue wheel for the finale's rainbow. Brightness follows the lane view's energy rule (`canvas.ts`):
 * from the background up to the full colour, and past it toward the flash.
 */
import { lookOf, mix, oklch, type Rgb } from "../lane/colour.ts";
import { amberOf, BASE_CHROMA, BASE_HUE, greenOf, greyOf, hot, lineColour, redOf, type Tint, white } from "../lane/effects/colours.ts";
import { paletteLut } from "./png.ts";

const SIZE = 256;
const ICE_STEPS = 24;
const MEANING_STEPS = 12;
const GREY_STEPS = 16;
const WHEEL = 12;
/** Lanes beyond this share the ramps nearest to them. */
const MAX_LANE_RAMPS = 8;

/** `steps` colours from just above the background to the colour and on toward its flash. */
function ramp(out: Rgb[], bg: Rgb, colour: Rgb, flash: Rgb, steps: number): void {
	const full = Math.max(2, Math.round(steps * 0.75));
	for (let k = 1; k <= full; k++) out.push(mix(bg, colour, k / full));
	for (let k = 1; k <= steps - full; k++) out.push(mix(colour, flash, k / (steps - full + 1)));
}

export interface StagePalette { key: string; plte: Uint8Array; lut: Uint8Array }

const cache = new Map<string, StagePalette>();
const CACHE_LIMIT = 4;

/** The palette for these lane colours on this look; the lookup table is built once per distinct palette. */
export function stagePalette(dark: boolean, laneColours: readonly Rgb[]): StagePalette {
	const lanes = laneColours.slice(0, MAX_LANE_RAMPS);
	const key = `${dark ? "d" : "l"}:${lanes.join(",")}`;
	const kept = cache.get(key);
	if (kept !== undefined) return kept;
	const bg = lookOf(dark).background;
	const tint: Tint = { dark, bg };
	const colours: Rgb[] = [bg];
	ramp(colours, bg, lineColour(tint, BASE_HUE, BASE_CHROMA), hot(tint, BASE_HUE), ICE_STEPS);
	for (const meaning of [amberOf(tint), redOf(tint), greenOf(tint), white(tint)]) ramp(colours, bg, meaning, white(tint), MEANING_STEPS);
	ramp(colours, bg, greyOf(tint), white(tint), GREY_STEPS);
	for (let i = 0; i < WHEEL; i++) colours.push(oklch(dark ? 0.76 : 0.54, 0.2, (360 * i) / WHEEL));
	const left = SIZE - colours.length;
	const steps = lanes.length === 0 ? 0 : Math.floor(left / lanes.length);
	for (const lane of lanes) ramp(colours, bg, lane, white(tint), steps);
	while (colours.length < SIZE) colours.push(bg);
	const plte = new Uint8Array(SIZE * 3);
	colours.slice(0, SIZE).forEach((rgb, i) => {
		plte[i * 3] = (rgb >> 16) & 0xff;
		plte[i * 3 + 1] = (rgb >> 8) & 0xff;
		plte[i * 3 + 2] = rgb & 0xff;
	});
	const palette = { key, plte, lut: paletteLut(plte) };
	if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	cache.set(key, palette);
	return palette;
}
