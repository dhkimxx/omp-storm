/**
 * A Braille dot canvas with one colour per terminal cell.
 *
 * Every cell is 2 by 4 dots. A cell shows all its lit dots as one Braille glyph in the colour of its most energetic dot.
 * A terminal has no transparency, so "how bright" is a blend toward the background colour: energy 0 is the background,
 * 1 is the full colour, and above 1 the colour is pushed toward white on a dark terminal (toward a deep tone on a light
 * one, where white would vanish).
 *
 * Output has three modes, chosen by `FrameOptions.colour`:
 * - "truecolor": `38;2;r;g;b`, written only where the colour changes along the row. Blank cells keep the current colour
 *   (nothing is written for a space), and a colour within a few units of the current one is not rewritten. That is what
 *   keeps a frame cheap over SSH.
 * - "256": the nearest xterm 256-colour index; runs of the same index share one code.
 * - "tones" (or absent): the colour is mapped to one of the 13 tones and written through `options.paint`.
 */
import type { FrameOptions, Tone } from "../model.ts";
import { blue, green, grey, type Look, mix, type Rgb, red, toOklch } from "./colour.ts";

/** Shapes the energy-to-blend curve: perceived brightness against linear-light mixing (gentler on a light terminal). */
const ENERGY_CURVE_DARK = 1.8;
const ENERGY_CURVE_LIGHT = 1.2;
/** Energy below this lights nothing: the dot would be invisible anyway. */
const MIN_ENERGY = 0.03;
/** Energy at which the colour is fully white-hot. */
const MAX_ENERGY = 2;
/** A truecolor change smaller than this (sum of the channel differences) is not written. */
const SAME_COLOUR = 16;

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

/** Bit of the dot at (column 0..1, row 0..3) in a Braille glyph. */
const BIT: readonly (readonly number[])[] = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
];
const BRAILLE: readonly string[] = Array.from({ length: 256 }, (_, mask) => (mask === 0 ? " " : String.fromCharCode(0x2800 + mask)));

const EMPTY = 0;
const TEXT = 1;
const CONTINUATION = 2;

function charWidth(code: number): number {
	if (code === 0 || (code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
	return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)
		? 2 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Colour reduction
// ---------------------------------------------------------------------------------------------------------------

const CUBE = [0, 95, 135, 175, 215, 255] as const;
const indexCache = new Map<Rgb, number>();

function nearestCubeLevel(v: number): number {
	let best = 0;
	for (let i = 1; i < CUBE.length; i++) if (Math.abs(CUBE[i]! - v) < Math.abs(CUBE[best]! - v)) best = i;
	return best;
}

/** The nearest xterm 256-colour index (6x6x6 cube or the grey ramp), by redmean distance. */
function xterm256(rgb: Rgb): number {
	const cached = indexCache.get(rgb);
	if (cached !== undefined) return cached;
	const r = red(rgb);
	const g = green(rgb);
	const b = blue(rgb);
	const distance = (r2: number, g2: number, b2: number): number => {
		const mean = (r + r2) / 2;
		return (2 + mean / 256) * (r - r2) ** 2 + 4 * (g - g2) ** 2 + (2 + (255 - mean) / 256) * (b - b2) ** 2;
	};
	const [ir, ig, ib] = [nearestCubeLevel(r), nearestCubeLevel(g), nearestCubeLevel(b)];
	const cubeIndex = 16 + 36 * ir + 6 * ig + ib;
	const cubeDistance = distance(CUBE[ir]!, CUBE[ig]!, CUBE[ib]!);
	const step = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
	const level = 8 + step * 10;
	const index = distance(level, level, level) < cubeDistance ? 232 + step : cubeIndex;
	if (indexCache.size > 20000) indexCache.clear();
	indexCache.set(rgb, index);
	return index;
}

/**
 * The tone nearest to a colour and its energy. Hue picks the tone (the plain palette has one tone per hue family:
 * red error, amber warning, green success, then blue, purple, pink, orange and teal roles); energy picks dim, normal
 * or bold. White-hot cells use `bright`.
 */
function toneOf(colour: Rgb, energy: number): { tone: Tone; bold: boolean } {
	if (energy < 0.22) return { tone: "dim", bold: false };
	const { c, h } = toOklch(colour);
	if (energy > 1.3 && c < 0.06) return { tone: "bright", bold: true };
	const bold = energy > 0.85;
	if (c < 0.04) return { tone: energy < 0.5 ? "muted" : "fg", bold };
	let tone: Tone;
	if (h < 10 || h >= 335) tone = "role5";
	else if (h < 40) tone = "error";
	else if (h < 70) tone = "role3";
	else if (h < 115) tone = "warning";
	else if (h < 165) tone = "success";
	else if (h < 215) tone = "role4";
	else if (h < 280) tone = "role1";
	else tone = "role2";
	return { tone, bold };
}

// ---------------------------------------------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------------------------------------------

export class Canvas {
	readonly cw: number;
	readonly ch: number;
	readonly look: Look;
	readonly #mask: Uint8Array;
	readonly #energy: Float32Array;
	readonly #colour: Int32Array;
	readonly #kind: Uint8Array;
	readonly #wide: Uint8Array;
	readonly #bold: Uint8Array;
	readonly #glyph: string[];

	/** `cw` by `ch` terminal cells; dots are 2 by 4 per cell. */
	constructor(cw: number, ch: number, look: Look) {
		this.cw = Math.max(0, Math.floor(cw));
		this.ch = Math.max(0, Math.floor(ch));
		this.look = look;
		const size = this.cw * this.ch;
		this.#mask = new Uint8Array(size);
		this.#energy = new Float32Array(size);
		this.#colour = new Int32Array(size);
		this.#kind = new Uint8Array(size);
		this.#wide = new Uint8Array(size);
		this.#bold = new Uint8Array(size);
		this.#glyph = new Array<string>(size).fill("");
	}

	/**
	 * Lights the dot at dot coordinates (x, y). `energy` 0..1 is how bright it is against the background; above 1 pushes
	 * toward white for flashes. A cell shows the colour of its most energetic dot (the later call wins a tie). A cell
	 * that holds text ignores dots: glyphs stay readable on top of the picture.
	 */
	dot(x: number, y: number, colour: Rgb, energy: number): void {
		if (!(energy >= MIN_ENERGY)) return;
		const dx = Math.floor(x);
		const dy = Math.floor(y);
		const cx = dx >> 1;
		const cy = dy >> 2;
		if (dx < 0 || dy < 0 || cx >= this.cw || cy >= this.ch) return;
		const i = cy * this.cw + cx;
		if (this.#kind[i] !== EMPTY) return;
		const lit = this.#mask[i]!;
		this.#mask[i] = lit | BIT[dx & 1]![dy & 3]!;
		const e = energy > MAX_ENERGY ? MAX_ENERGY : energy;
		if (lit === 0 || e >= this.#energy[i]!) {
			this.#energy[i] = e;
			this.#colour[i] = colour;
		}
	}

	/** Puts ordinary text on the cells starting at cell (cx, cy), replacing dots there. Returns the cells used. */
	text(cx: number, cy: number, text: string, colour: Rgb, energy: number = 1, bold: boolean = false): number {
		const row = Math.floor(cy);
		if (row < 0 || row >= this.ch) return 0;
		const e = energy > MAX_ENERGY ? MAX_ENERGY : energy;
		let at = Math.floor(cx);
		let used = 0;
		for (const char of text) {
			const w = charWidth(char.codePointAt(0)!);
			if (w === 0) continue;
			if (at + w > this.cw) break;
			if (at >= 0) {
				const i = row * this.cw + at;
				this.#blank(i);
				if (w === 2) this.#blank(i + 1);
				this.#kind[i] = TEXT;
				this.#wide[i] = w;
				this.#glyph[i] = char;
				this.#colour[i] = colour;
				this.#energy[i] = e;
				this.#bold[i] = bold ? 1 : 0;
				if (w === 2) this.#kind[i + 1] = CONTINUATION;
			}
			at += w;
			used += w;
		}
		return used;
	}

	/** Pulls every cell's colour toward grey by `amount` 0..1 (the freeze). */
	drain(amount: number): void {
		if (!(amount > 0)) return;
		const a = amount > 1 ? 1 : amount;
		for (let i = 0; i < this.#colour.length; i++) {
			if (this.#mask[i] === 0 && this.#kind[i] !== TEXT) continue;
			const c = this.#colour[i]!;
			this.#colour[i] = mix(c, grey(c), a);
		}
	}

	/** One string per row, `cw` cells wide, coloured for `options`. */
	rows(options: FrameOptions): string[] {
		const mode = options.colour ?? "tones";
		const out: string[] = [];
		for (let cy = 0; cy < this.ch; cy++) out.push(mode === "tones" ? this.#toneRow(cy, options) : this.#ansiRow(cy, mode === "256"));
		return out;
	}

	// -----------------------------------------------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------------------------------------------

	#reset(i: number): void {
		this.#kind[i] = EMPTY;
		this.#mask[i] = 0;
		this.#energy[i] = 0;
		this.#wide[i] = 0;
		this.#bold[i] = 0;
		this.#glyph[i] = "";
	}

	/** Empties a cell; the other half of a wide character that it belonged to goes too. */
	#blank(i: number): void {
		const kind = this.#kind[i];
		if (kind === CONTINUATION) {
			if (i > 0) this.#reset(i - 1);
		} else if (kind === TEXT && this.#wide[i] === 2 && i + 1 < this.#kind.length) {
			this.#reset(i + 1);
		}
		this.#reset(i);
	}

	/** The glyph a cell shows (a space for an empty cell). */
	#glyphAt(i: number): string {
		return this.#kind[i] === TEXT ? this.#glyph[i]! : BRAILLE[this.#mask[i]!]!;
	}

	/** The colour a cell is drawn in: its colour blended toward the background by its energy. */
	#shown(i: number): Rgb {
		const e = this.#energy[i]!;
		const base = this.#colour[i]!;
		const blended = mix(this.look.background, base, e >= 1 ? 1 : e ** (this.look.dark ? ENERGY_CURVE_DARK : ENERGY_CURVE_LIGHT));
		if (e <= 1) return blended;
		const hot = this.look.dark ? 0xffffff : mix(base, 0x000000, 0.6);
		return mix(blended, hot, Math.min(1, e - 1));
	}

	#ansiRow(cy: number, palette256: boolean): string {
		let out = "";
		let current = -1;
		let currentRgb: Rgb = -1;
		let bold = false;
		const base = cy * this.cw;
		for (let cx = 0; cx < this.cw; cx++) {
			const i = base + cx;
			const kind = this.#kind[i]!;
			if (kind === CONTINUATION) continue;
			const glyph = this.#glyphAt(i);
			if (glyph === " ") {
				out += " ";
				continue;
			}
			const wantBold = kind === TEXT && this.#bold[i] === 1;
			if (wantBold !== bold) {
				out += wantBold ? `${ESC}1m` : `${ESC}22m`;
				bold = wantBold;
			}
			const rgb = this.#shown(i);
			if (palette256) {
				const index = xterm256(rgb);
				if (index !== current) {
					out += `${ESC}38;5;${index}m`;
					current = index;
				}
			} else if (
				currentRgb < 0 ||
				Math.abs(red(rgb) - red(currentRgb)) + Math.abs(green(rgb) - green(currentRgb)) + Math.abs(blue(rgb) - blue(currentRgb)) > SAME_COLOUR
			) {
				out += `${ESC}38;2;${red(rgb)};${green(rgb)};${blue(rgb)}m`;
				currentRgb = rgb;
			}
			out += glyph;
		}
		return current >= 0 || currentRgb >= 0 || bold ? out + RESET : out;
	}

	#toneRow(cy: number, options: FrameOptions): string {
		let out = "";
		let run = "";
		let runTone: Tone | undefined;
		let runBold = false;
		const flush = (): void => {
			if (run === "") return;
			out += runTone === undefined ? run : options.paint(runTone, run, runBold);
			run = "";
		};
		const base = cy * this.cw;
		for (let cx = 0; cx < this.cw; cx++) {
			const i = base + cx;
			const kind = this.#kind[i]!;
			if (kind === CONTINUATION) continue;
			const glyph = this.#glyphAt(i);
			if (glyph === " ") {
				run += " ";
				continue;
			}
			const { tone, bold } = toneOf(this.#colour[i]!, this.#energy[i]!);
			if (tone !== runTone || bold !== runBold) {
				// Spaces waiting in `run` belong to the run that is closing.
				flush();
				runTone = tone;
				runBold = bold;
			}
			run += glyph;
		}
		flush();
		return out;
	}
}
