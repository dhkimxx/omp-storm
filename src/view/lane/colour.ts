/**
 * Colour maths for the lane view: OKLCH in, packed sRGB out, mixing in linear light.
 * No dependencies; every function is pure.
 */

/** 0xRRGGBB. */
export type Rgb = number;
/** What the terminal looks like. */
export interface Look { dark: boolean; background: Rgb }

/** The background colour the view assumes for a dark or a light terminal (a terminal's real colour is unknown). */
export const DARK_BACKGROUND: Rgb = 0x101216;
export const LIGHT_BACKGROUND: Rgb = 0xf5f5f2;

export function lookOf(dark: boolean): Look {
	return { dark, background: dark ? DARK_BACKGROUND : LIGHT_BACKGROUND };
}

// sRGB byte -> linear light, one lookup per channel.
const TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
	const s = i / 255;
	TO_LINEAR[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function toSrgbByte(linear: number): number {
	const v = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
	const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	return Math.round(s * 255);
}

export function red(rgb: Rgb): number { return (rgb >> 16) & 0xff; }
export function green(rgb: Rgb): number { return (rgb >> 8) & 0xff; }
export function blue(rgb: Rgb): number { return rgb & 0xff; }
export function pack(r: number, g: number, b: number): Rgb { return (r << 16) | (g << 8) | b; }

/** Linear-light channels of an OKLCH colour, not yet clamped. */
function oklchLinear(l: number, c: number, h: number): [number, number, number] {
	const rad = (h * Math.PI) / 180;
	const a = c * Math.cos(rad);
	const b = c * Math.sin(rad);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
	];
}

const EPS = 1e-4;
function inGamut([r, g, b]: [number, number, number]): boolean {
	return r >= -EPS && r <= 1 + EPS && g >= -EPS && g <= 1 + EPS && b >= -EPS && b <= 1 + EPS;
}

/**
 * l 0..1, c 0..0.4, h in degrees; clamped into sRGB. A colour outside the gamut keeps its lightness and hue and loses
 * chroma (a plain channel clamp would shift the hue), so a rainbow of equal `l` stays equally bright.
 */
export function oklch(l: number, c: number, h: number): Rgb {
	const lightness = Math.min(1, Math.max(0, l));
	let chroma = Math.min(0.4, Math.max(0, c));
	let lin = oklchLinear(lightness, chroma, h);
	if (!inGamut(lin)) {
		let lo = 0;
		let hi = chroma;
		for (let i = 0; i < 14; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(oklchLinear(lightness, mid, h))) lo = mid;
			else hi = mid;
		}
		chroma = lo;
		lin = oklchLinear(lightness, chroma, h);
	}
	return pack(toSrgbByte(lin[0]), toSrgbByte(lin[1]), toSrgbByte(lin[2]));
}

/** Mixes in linear light; t = 0 gives a, 1 gives b. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
	if (t <= 0) return a;
	if (t >= 1) return b;
	const channel = (shift: number): number => {
		const x = TO_LINEAR[(a >> shift) & 0xff]!;
		const y = TO_LINEAR[(b >> shift) & 0xff]!;
		return toSrgbByte(x + (y - x) * t);
	};
	return pack(channel(16), channel(8), channel(0));
}

/** The grey of the same luminance as `rgb`. */
export function grey(rgb: Rgb): Rgb {
	const y = 0.2126 * TO_LINEAR[red(rgb)]! + 0.7152 * TO_LINEAR[green(rgb)]! + 0.0722 * TO_LINEAR[blue(rgb)]!;
	const v = toSrgbByte(y);
	return pack(v, v, v);
}

/** Hue of the first lane; the golden angle then walks the wheel from here. */
const FIRST_HUE = 250;
const GOLDEN_ANGLE = 137.50776405003785;

/** Hue in degrees for a lane index, golden-angle spaced. */
export function laneHue(index: number): number {
	const h = (FIRST_HUE + index * GOLDEN_ANGLE) % 360;
	return h < 0 ? h + 360 : h;
}
