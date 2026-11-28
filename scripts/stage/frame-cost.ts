/**
 * B0 probe: what one T1 stage frame costs at runtime. A synthetic stage (baked opaque background, 7 baked creature
 * sprites picked from 24-frame loops, glow fragments, rain) is composed into one RGB frame, PNG-encoded with node:zlib
 * and wrapped in each image protocol's escape sequence exactly as the host's encoders write it. A half-block T2 frame
 * of the same picture is built for comparison.
 *
 *   node_modules/.bin/bun scripts/stage/frame-cost.ts [--frames N] [--png DIR]
 *
 * `--png DIR` also writes one composed frame per size as PNG so a person can look at what was measured.
 * Numbers are per frame: median and p95 over N frames (default 240) after a warm-up.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, crc32, deflateSync } from "node:zlib";
import { encodeSixelAsync } from "@oh-my-pi/pi-natives";
import { itermImage } from "@oh-my-pi/pi-tui/driver/images/iterm";
import { kittyPlaceholderRows, kittyPlacementRows, kittyTransmit } from "@oh-my-pi/pi-tui/driver/images/kitty";

/** Premultiplied RGBA pixels. */
interface Sprite {
	readonly w: number;
	readonly h: number;
	readonly px: Uint8Array;
}

const LANE_COLOURS: readonly (readonly [number, number, number])[] = [
	[120, 200, 255],
	[255, 150, 210],
	[140, 255, 170],
	[255, 210, 120],
	[190, 150, 255],
	[110, 240, 230],
	[255, 130, 120],
];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** A deterministic pseudo-random source, so every run measures the same pictures. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x1_0000_0000;
	};
}

/** The opaque baked background: night gradient, an aurora band, stars. RGB. */
function background(w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h * 3);
	const rand = rng(7);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const t = y / h;
			const band = Math.exp(-(((y / h - 0.32 - 0.08 * Math.sin(x / w * 6.3)) / 0.09) ** 2));
			const i = (y * w + x) * 3;
			out[i] = clamp(8 + 10 * t + 30 * band, 0, 255);
			out[i + 1] = clamp(12 + 14 * t + 110 * band * (0.6 + 0.4 * Math.sin(x / 23)), 0, 255);
			out[i + 2] = clamp(28 + 30 * t + 70 * band, 0, 255);
		}
	}
	for (let k = 0; k < (w * h) / 900; k++) {
		const i = (Math.floor(rand() * h) * w + Math.floor(rand() * w)) * 3;
		out[i] = out[i + 1] = out[i + 2] = 200 + Math.floor(rand() * 55);
	}
	return out;
}

/** One creature pose: a glowing body with four waving arms, soft edges, premultiplied. `phase` in [0, 1). */
function creature(size: number, colour: readonly [number, number, number], phase: number): Sprite {
	const w = size;
	const h = size;
	const px = new Uint8Array(w * h * 4);
	const cx = w / 2;
	const cy = h * 0.38;
	const r = size * 0.18;
	const cover = (x: number, y: number): number => {
		let best = Math.hypot((x - cx) / 1.1, y - cy) - r;
		for (let arm = 0; arm < 4; arm++) {
			const base = cx + (arm - 1.5) * r * 0.55;
			for (let s = 0; s <= 10; s++) {
				const u = s / 10;
				const ax = base + Math.sin(phase * Math.PI * 2 + arm + u * 3) * size * 0.08 * u;
				const ay = cy + r * 0.6 + u * size * 0.45;
				best = Math.min(best, Math.hypot(x - ax, y - ay) - size * 0.045 * (1 - 0.6 * u));
			}
		}
		return best;
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const d = cover(x + 0.5, y + 0.5);
			const body = clamp(0.5 - d, 0, 1);
			const glow = 0.45 * Math.exp(-Math.max(0, d) / (size * 0.06));
			const a = clamp(body + glow * (1 - body), 0, 1);
			const light = body * (0.75 + 0.25 * Math.sin((y / h) * 9 + phase * 6));
			const i = (y * w + x) * 4;
			px[i] = clamp((colour[0] * (0.4 + 0.6 * light) + 255 * 0.2 * body) * a, 0, 255);
			px[i + 1] = clamp((colour[1] * (0.4 + 0.6 * light) + 255 * 0.2 * body) * a, 0, 255);
			px[i + 2] = clamp((colour[2] * (0.4 + 0.6 * light) + 255 * 0.2 * body) * a, 0, 255);
			px[i + 3] = Math.round(a * 255);
		}
	}
	return { w, h, px };
}

/** A small glow dot (a fragment of a result). */
function fragment(size: number, colour: readonly [number, number, number]): Sprite {
	const px = new Uint8Array(size * size * 4);
	const c = size / 2;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const a = clamp(Math.exp(-((Math.hypot(x + 0.5 - c, y + 0.5 - c) / (size * 0.28)) ** 2)), 0, 1);
			const i = (y * size + x) * 4;
			px[i] = colour[0] * a;
			px[i + 1] = colour[1] * a;
			px[i + 2] = colour[2] * a;
			px[i + 3] = a * 255;
		}
	}
	return { w: size, h: size, px };
}

/** Premultiplied source-over onto an opaque RGB frame, clipped. */
function blit(frame: Uint8Array, fw: number, fh: number, s: Sprite, ox: number, oy: number): void {
	const x0 = Math.max(0, -ox);
	const y0 = Math.max(0, -oy);
	const x1 = Math.min(s.w, fw - ox);
	const y1 = Math.min(s.h, fh - oy);
	const px = s.px;
	for (let y = y0; y < y1; y++) {
		let si = (y * s.w + x0) * 4;
		let di = ((oy + y) * fw + ox + x0) * 3;
		for (let x = x0; x < x1; x++, si += 4, di += 3) {
			const a = px[si + 3]!;
			if (a === 0) continue;
			const k = 255 - a;
			frame[di] = px[si]! + ((frame[di]! * k + 127) / 255 | 0);
			frame[di + 1] = px[si + 1]! + ((frame[di + 1]! * k + 127) / 255 | 0);
			frame[di + 2] = px[si + 2]! + ((frame[di + 2]! * k + 127) / 255 | 0);
		}
	}
}

/** Additive rain streaks (weather layer). */
function rain(frame: Uint8Array, fw: number, fh: number, t: number, count: number): void {
	for (let k = 0; k < count; k++) {
		const x = Math.floor((k * 97 + t * 0.05 * (1 + (k % 3))) % fw);
		const y0 = Math.floor((k * 53 + t * 0.4) % fh);
		for (let d = 0; d < 6; d++) {
			const y = (y0 + d) % fh;
			const i = (y * fw + x) * 3;
			frame[i] = Math.min(255, frame[i]! + 30);
			frame[i + 1] = Math.min(255, frame[i + 1]! + 40);
			frame[i + 2] = Math.min(255, frame[i + 2]! + 60);
		}
	}
}

export interface Stage {
	readonly w: number;
	readonly h: number;
	readonly bg: Uint8Array;
	/** Per creature, a 24-pose loop. */
	readonly loops: readonly (readonly Sprite[])[];
	readonly glow: readonly Sprite[];
}

export function bakeStage(w: number, h: number): Stage {
	const size = Math.round(h * 0.55);
	const loops = LANE_COLOURS.map((colour, n) =>
		Array.from({ length: 24 }, (_, f) => creature(n === 0 ? Math.round(size * 1.3) : size, colour, f / 24)),
	);
	const glow = LANE_COLOURS.map(colour => fragment(Math.max(6, Math.round(h / 14)), colour));
	return { w, h, bg: background(w, h), loops, glow };
}

/** One stage frame at `t` ms into `frame` (RGB, w*h*3). */
export function compose(stage: Stage, frame: Uint8Array, t: number): void {
	const { w, h } = stage;
	frame.set(stage.bg);
	stage.loops.forEach((loop, n) => {
		const pose = loop[Math.floor(t / 80 + n * 3) % loop.length]!;
		const x = n === 0 ? Math.round(w / 2 - pose.w / 2) : Math.round(((n - 0.5) / 6) * w - pose.w / 2);
		const y = n === 0 ? Math.round(h * 0.05) : Math.round(h * 0.42 + Math.sin(t / 700 + n) * h * 0.05);
		blit(frame, w, h, pose, x, y);
	});
	for (let k = 0; k < 24; k++) {
		const g = stage.glow[k % stage.glow.length]!;
		const x = Math.round((w * (0.1 + 0.8 * ((k * 0.37 + t / 9000) % 1))) - g.w / 2);
		const y = Math.round(h * (0.15 + 0.7 * ((k * 0.61) % 1)) + Math.sin(t / 400 + k) * 3);
		blit(frame, w, h, g, x, y);
	}
	rain(frame, w, h, t, Math.round(w / 8));
}

type Filter = "none" | "up" | "paeth";

/** PNG filter bytes + scanlines of an RGB frame. */
function filtered(frame: Uint8Array, w: number, h: number, filter: Filter, out: Uint8Array): Uint8Array {
	const stride = w * 3;
	for (let y = 0; y < h; y++) {
		const row = y * stride;
		const at = y * (stride + 1);
		out[at] = filter === "none" ? 0 : filter === "up" ? 2 : 4;
		for (let x = 0; x < stride; x++) {
			const v = frame[row + x]!;
			if (filter === "none") out[at + 1 + x] = v;
			else if (filter === "up") out[at + 1 + x] = v - (y > 0 ? frame[row - stride + x]! : 0);
			else {
				const a = x >= 3 ? frame[row + x - 3]! : 0;
				const b = y > 0 ? frame[row - stride + x]! : 0;
				const c = x >= 3 && y > 0 ? frame[row - stride + x - 3]! : 0;
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				out[at + 1 + x] = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
			}
		}
	}
	return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
	return out;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** An RGB (colour type 2) PNG of `frame`. */
function png(frame: Uint8Array, w: number, h: number, filter: Filter, level: number, scratch: Uint8Array): Uint8Array {
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, w);
	view.setUint32(4, h);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const idat = deflateSync(filtered(frame, w, h, filter, scratch), { level, strategy: constants.Z_DEFAULT_STRATEGY });
	return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/** The 256-colour palette Bun.Image's quantiser picks for `samples` stacked (the bake would do this once per species). */
export async function paletteOf(samples: readonly Uint8Array[], w: number, h: number): Promise<Uint8Array> {
	const stack = new Uint8Array(samples.length * w * h * 3);
	samples.forEach((sample, n) => stack.set(sample, n * w * h * 3));
	const rgb = png(stack, w, h * samples.length, "none", 1, new Uint8Array((w * 3 + 1) * h * samples.length));
	const bytes = await new Bun.Image(rgb).png({ palette: true, colors: 256 }).bytes();
	for (let at = 8; at < bytes.length; ) {
		const length = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		if (type === "PLTE") return bytes.slice(at + 8, at + 8 + length);
		at += 12 + length;
	}
	throw new Error("the quantiser wrote no PLTE chunk");
}

/** RGB565 → nearest palette index (built once per palette; 64 KiB). */
export function lutOf(plte: Uint8Array): Uint8Array {
	const lut = new Uint8Array(65536);
	const n = plte.length / 3;
	for (let key = 0; key < 65536; key++) {
		const r = ((key >> 11) << 3) | 4;
		const g = (((key >> 5) & 63) << 2) | 2;
		const b = ((key & 31) << 3) | 4;
		let best = 0;
		let bestD = Number.POSITIVE_INFINITY;
		for (let i = 0; i < n; i++) {
			const d = (plte[i * 3]! - r) ** 2 * 3 + (plte[i * 3 + 1]! - g) ** 2 * 4 + (plte[i * 3 + 2]! - b) ** 2 * 2;
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		lut[key] = best;
	}
	return lut;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** An indexed (colour type 3) PNG of `frame`: 4×4 ordered dither, RGB565 LUT, no filter. */
export function indexedPng(frame: Uint8Array, w: number, h: number, plte: Uint8Array, lut: Uint8Array, level: number, scratch: Uint8Array): Uint8Array {
	for (let y = 0; y < h; y++) {
		const at = y * (w + 1);
		scratch[at] = 0;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			const d = BAYER4[(y & 3) * 4 + (x & 3)]! - 7.5;
			const r = clamp(frame[i]! + d, 0, 255);
			const g = clamp(frame[i + 1]! + d * 0.5, 0, 255);
			const b = clamp(frame[i + 2]! + d, 0, 255);
			scratch[at + 1 + x] = lut[((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)]!;
		}
	}
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, w);
	view.setUint32(4, h);
	ihdr[8] = 8;
	ihdr[9] = 3;
	const idat = deflateSync(scratch.subarray(0, (w + 1) * h), { level });
	return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/** A truecolor half-block T2 frame of `frame` at `cols`×`rows` cells (box-averaged), as one ANSI string. */
function halfBlock(frame: Uint8Array, w: number, h: number, cols: number, rows: number): string {
	const sample = (cx: number, py: number): [number, number, number] => {
		const x0 = Math.floor((cx * w) / cols);
		const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / cols));
		const y0 = Math.floor((py * h) / (rows * 2));
		const y1 = Math.max(y0 + 1, Math.floor(((py + 1) * h) / (rows * 2)));
		let r = 0;
		let g = 0;
		let b = 0;
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = (y * w + x) * 3;
				r += frame[i]!;
				g += frame[i + 1]!;
				b += frame[i + 2]!;
			}
		}
		const n = (x1 - x0) * (y1 - y0);
		return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
	};
	let out = "";
	for (let row = 0; row < rows; row++) {
		let fg = "";
		let bg = "";
		for (let col = 0; col < cols; col++) {
			const top = sample(col, row * 2).join(";");
			const bottom = sample(col, row * 2 + 1).join(";");
			if (top !== fg) out += `\x1b[38;2;${(fg = top)}m`;
			if (bottom !== bg) out += `\x1b[48;2;${(bg = bottom)}m`;
			out += "▀";
		}
		out += "\x1b[0m\n";
	}
	return out;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
const kb = (n: number): string => `${(n / 1024).toFixed(1)}K`;
const ms = (n: number): string => n.toFixed(2);

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const frames = Number(args[args.indexOf("--frames") + 1]) || 240;
	const pngDir = args.includes("--png") ? args[args.indexOf("--png") + 1] : undefined;
	// 40×8 cells at 8×17 (plan), 9×18 (host default cell), 16×34 (a Retina kitty reports device pixels).
	const sizes: readonly (readonly [number, number])[] = [
		[320, 136],
		[360, 144],
		[640, 272],
	];
	for (const [w, h] of sizes) {
		const bakeStart = performance.now();
		const stage = bakeStage(w, h);
		const bakeMs = performance.now() - bakeStart;
		const frame = new Uint8Array(w * h * 3);
		const scratch = new Uint8Array((w * 3 + 1) * h);
		console.log(`\n== ${w}x${h} (baking the synthetic sprites took ${bakeMs.toFixed(0)} ms, not a runtime cost)`);
		const composeMs: number[] = [];
		for (let f = 0; f < frames + 20; f++) {
			const start = performance.now();
			compose(stage, frame, f * 85);
			if (f >= 20) composeMs.push(performance.now() - start);
		}
		console.log(`compose (copy bg + 7 creatures + 24 glows + rain): median ${ms(median(composeMs))} ms, p95 ${ms(p95(composeMs))} ms`);
		let sample: Uint8Array | undefined;
		for (const filter of ["up", "paeth"] as const) {
			for (const level of [1, 3, 6]) {
				const encodeMs: number[] = [];
				const sizesOut: number[] = [];
				for (let f = 0; f < frames + 20; f++) {
					compose(stage, frame, f * 85);
					const start = performance.now();
					const bytes = png(frame, w, h, filter, level, scratch);
					const b64 = Buffer.from(bytes).toString("base64");
					if (f >= 20) {
						encodeMs.push(performance.now() - start);
						sizesOut.push(b64.length);
					}
					if (filter === "paeth" && level === 1 && f === 60) sample = bytes;
				}
				console.log(
					`png ${filter.padEnd(5)} zlib ${level}: encode+base64 median ${ms(median(encodeMs))} ms, p95 ${ms(p95(encodeMs))} ms; base64 median ${kb(median(sizesOut))}, max ${kb(Math.max(...sizesOut))}`,
				);
			}
		}
		const samples: Uint8Array[] = [];
		for (let f = 0; f < 240; f += 30) {
			compose(stage, frame, f * 85);
			samples.push(frame.slice());
		}
		const paletteStart = performance.now();
		const plte = await paletteOf(samples, w, h);
		const lut = lutOf(plte);
		console.log(`indexed: palette from 8 sample frames + RGB565 LUT built in ${(performance.now() - paletteStart).toFixed(0)} ms (bake-time or once per species at load)`);
		let indexedSample: Uint8Array | undefined;
		for (const level of [1, 3, 6]) {
			const encodeMs: number[] = [];
			const sizesOut: number[] = [];
			for (let f = 0; f < frames + 20; f++) {
				compose(stage, frame, f * 85);
				const start = performance.now();
				const bytes = indexedPng(frame, w, h, plte, lut, level, scratch);
				const b64 = Buffer.from(bytes).toString("base64");
				if (f >= 20) {
					encodeMs.push(performance.now() - start);
					sizesOut.push(b64.length);
				}
				if (level === 3 && f === 60) indexedSample = bytes;
			}
			console.log(
				`png indexed zlib ${level}: dither+LUT+encode+base64 median ${ms(median(encodeMs))} ms, p95 ${ms(p95(encodeMs))} ms; base64 median ${kb(median(sizesOut))}, max ${kb(Math.max(...sizesOut))}`,
			);
		}
		if (!sample || !indexedSample) continue;
		if (pngDir) {
			mkdirSync(pngDir, { recursive: true });
			writeFileSync(join(pngDir, `stage-${w}x${h}-rgb.png`), sample);
			writeFileSync(join(pngDir, `stage-${w}x${h}-indexed.png`), indexedSample);
		}
		const cols = 40;
		const rows = 8;
		for (const [name, bytes] of [["RGB paeth/zlib 1", sample], ["indexed/zlib 3", indexedSample]] as const) {
			const data = Buffer.from(bytes).toString("base64");
			const image = { id: 0x12_3456, widthPx: w, heightPx: h };
			const kittyDirect = kittyTransmit(data, image.id) + kittyPlacementRows(image, cols, rows, 1).join("");
			const kittyPlaceholder = kittyTransmit(data, image.id) + kittyPlaceholderRows({ id: image.id, placement: 1, columns: cols, rows }).join("");
			const kittyTmux = kittyTransmit(data, image.id, "tmux") + kittyPlacementRows(image, cols, rows, 1, "tmux").join("");
			const iterm = itermImage(data, cols, rows);
			const sixelTimes: number[] = [];
			let sixel = "";
			for (let k = 0; k < 20; k++) {
				const start = performance.now();
				sixel = await encodeSixelAsync(bytes, w, h, 0x101820);
				sixelTimes.push(performance.now() - start);
			}
			console.log(`bytes per frame (${name}, PNG ${kb(bytes.length)}):`);
			console.log(`  kitty direct (transmit + 8 placement rows): ${kb(Buffer.byteLength(kittyDirect))}`);
			console.log(`  kitty placeholders (transmit + 40x8 U+10EEEE cells): ${kb(Buffer.byteLength(kittyPlaceholder))}`);
			console.log(`  kitty direct under tmux passthrough: ${kb(Buffer.byteLength(kittyTmux))}`);
			console.log(`  iTerm2 OSC 1337: ${kb(Buffer.byteLength(iterm))}`);
			console.log(`  SIXEL (pi-natives encode, off-thread, median ${ms(median(sixelTimes))} ms): ${kb(Buffer.byteLength(sixel))}`);
		}
		const t2Times: number[] = [];
		let t2 = "";
		for (let k = 0; k < 100; k++) {
			const start = performance.now();
			t2 = halfBlock(frame, w, h, cols, rows);
			t2Times.push(performance.now() - start);
		}
		console.log(`T2 half-block 40x8 cells from the same frame: ${kb(Buffer.byteLength(t2))} in ${ms(median(t2Times))} ms`);
	}
}

if (import.meta.main) await main();
