/**
 * The painter's colours. Line colours are OKLCH with one lightness for every hue, so a rainbow is even; text is lighter
 * (dark terminal) or deeper (light terminal) so labels read on both. The three colours with a fixed meaning carry their
 * own lightness: a deep red reads as danger, a bright amber as a call, green as done.
 */
import { mix, oklch, type Rgb } from "../colour.ts";
import { hueMod } from "./math.ts";

/** What the colours depend on: the terminal's brightness and its assumed background. */
export interface Tint { dark: boolean; bg: Rgb }

/** Hue of the trunk before any lane has been accepted: a cold blue-cyan. */
export const BASE_HUE = 218;
/** The start colour is a pale ice blue, so every accepted lane's hue arrives as a visible colour. */
export const BASE_CHROMA = 0.15;
export const HUE_GREEN = 152;
export const HUE_AMBER = 78;
export const HUE_RED = 24;
export const CHROMA = 0.2;
const LIGHTNESS_DARK = 0.76;
const LIGHTNESS_LIGHT = 0.54;

/** A line colour of the given hue. */
export function lineColour(tint: Tint, hue: number, chroma = CHROMA): Rgb {
	return oklch(tint.dark ? LIGHTNESS_DARK : LIGHTNESS_LIGHT, chroma, hueMod(hue));
}

/** Readable text of a hue. */
export function textColour(tint: Tint, hue: number, chroma = 0.13): Rgb {
	return oklch(tint.dark ? 0.84 : 0.42, chroma, hueMod(hue));
}

/** The "white" of flashes: nearly white on a dark terminal, a deep saturated tone of the hue on a light one. */
export function hot(tint: Tint, hue: number): Rgb {
	return tint.dark ? mix(lineColour(tint, hue), 0xffffff, 0.8) : oklch(0.34, 0.19, hueMod(hue));
}

export const white = (tint: Tint): Rgb => (tint.dark ? 0xffffff : 0x14161a);
export const greyOf = (tint: Tint): Rgb => (tint.dark ? 0x8d939c : 0x7a7f86);
export const greenOf = (tint: Tint): Rgb => oklch(tint.dark ? 0.8 : 0.56, 0.2, HUE_GREEN);
export const amberOf = (tint: Tint): Rgb => oklch(tint.dark ? 0.84 : 0.68, 0.17, HUE_AMBER);
export const redOf = (tint: Tint): Rgb => oklch(tint.dark ? 0.66 : 0.54, 0.225, HUE_RED);
export const textGrey = (tint: Tint): Rgb => mix(tint.bg, tint.dark ? 0xffffff : 0x000000, tint.dark ? 0.58 : 0.7);
