/**
 * B0 probe: bake one creature sequence from SVG key poses the way B2 would. Two key poses of an octopus share one path
 * topology (same commands, same order); the frames between are the numbers of the paths interpolated with an ease
 * in-out curve. Every frame is rasterised with resvg, packed into a T1 sprite sheet (RGBA PNG) and a T2 sheet (one
 * pixel per half cell, RGBA PNG), and the sizes are extrapolated to the plan's ~80 sequences.
 *
 *   node_modules/.bin/bun add -d @resvg/resvg-js   # not a devDependency yet; B2 adds it
 *   node_modules/.bin/bun scripts/stage/svg-bake.ts [--out DIR]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

interface ResvgModule {
	Resvg: new (
		svg: string,
		options?: { fitTo?: { mode: "width"; value: number }; background?: string; font?: { loadSystemFonts?: boolean } },
	) => { render(): { width: number; height: number; pixels: Uint8Array; asPng(): Uint8Array } };
}

/** Logical pixels per cell: the stage canvas is cols×9 by rows×18 whatever cell size the terminal reports. */
const CELL_W = 9;
const CELL_H = 18;
/** A lane creature's sprite box (8×4 cells) and the frames of one 2 s loop at the lane view's 85 ms tick. */
const SPRITE = { w: 8 * CELL_W, h: 4 * CELL_H };
const FRAMES = 24;

type Pose = { readonly body: string; readonly arms: readonly string[]; readonly glow: number };

/** Key pose A and B: same commands in the same order in every path, only numbers differ. */
const KEYS: readonly [Pose, Pose] = [
	{
		body: "M36 6 C50 6 58 16 58 26 C58 34 50 38 36 38 C22 38 14 34 14 26 C14 16 22 6 36 6 Z",
		arms: [
			"M22 34 C18 44 12 52 8 66",
			"M30 37 C28 48 26 58 24 68",
			"M42 37 C44 48 46 58 48 68",
			"M50 34 C54 44 60 52 64 66",
		],
		glow: 2.5,
	},
	{
		body: "M36 9 C51 9 60 18 60 27 C60 35 51 39 36 39 C21 39 12 35 12 27 C12 18 21 9 36 9 Z",
		arms: [
			"M22 35 C14 42 16 56 6 62",
			"M30 38 C34 50 22 58 28 70",
			"M42 38 C38 50 50 58 44 70",
			"M50 35 C58 42 56 56 66 62",
		],
		glow: 4,
	},
];

function svgOf(pose: Pose, colour: string): string {
	const arms = pose.arms.map(d => `<path d="${d}" stroke="${colour}" stroke-width="4.5" stroke-linecap="round" fill="none"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SPRITE.w}" height="${SPRITE.h}" viewBox="0 0 ${SPRITE.w} ${SPRITE.h}">
<defs>
<radialGradient id="body" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="${colour}"/><stop offset="1" stop-color="${colour}" stop-opacity="0.6"/></radialGradient>
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${pose.glow.toFixed(2)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<g filter="url(#glow)">${arms}<path d="${pose.body}" fill="url(#body)"/><circle cx="29" cy="24" r="2.4" fill="#0b1020"/><circle cx="43" cy="24" r="2.4" fill="#0b1020"/></g>
</svg>`;
}

/** Path numbers of `a` and `b` mixed at `t`; the commands must match one for one (fixed topology). */
function mixPath(a: string, b: string, t: number): string {
	const commands = (d: string): string => d.replace(/[-\d.]+/g, "").replace(/\s+/g, "");
	if (commands(a) !== commands(b)) throw new Error(`key poses differ in topology: ${a} | ${b}`);
	const numbers = b.match(/[-\d.]+/g)!.map(Number);
	let index = 0;
	return a.replace(/[-\d.]+/g, value => {
		const mixed = Number(value) + (numbers[index++]! - Number(value)) * t;
		return String(Math.round(mixed * 100) / 100);
	});
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** The pose of frame `f` of a loop A → B → A. */
function poseAt(f: number): Pose {
	const phase = f / FRAMES;
	const t = easeInOut(phase < 0.5 ? phase * 2 : 2 - phase * 2);
	const [a, b] = KEYS;
	return {
		body: mixPath(a.body, b.body, t),
		arms: a.arms.map((arm, n) => mixPath(arm, b.arms[n]!, t)),
		glow: a.glow + (b.glow - a.glow) * t,
	};
}

/** An RGBA PNG (colour type 6), deflate level 9: bake-time, so size wins over speed. */
function rgbaPng(px: Uint8Array, w: number, h: number): Buffer {
	const chunk = (type: string, data: Uint8Array): Buffer => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
		return out;
	};
	const raw = new Uint8Array((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 1;
		for (let x = 0; x < w * 4; x++) {
			const v = px[y * w * 4 + x]!;
			raw[y * (w * 4 + 1) + 1 + x] = v - (x >= 4 ? px[y * w * 4 + x - 4]! : 0);
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", new Uint8Array(0)),
	]);
}

/** One sprite frame at half-cell resolution (1 px per column, 2 px per row): alpha-weighted box filter. */
function halfCells(px: Uint8Array, w: number, h: number): { px: Uint8Array; w: number; h: number } {
	const ow = Math.ceil(w / CELL_W);
	const oh = Math.ceil(h / (CELL_H / 2));
	const out = new Uint8Array(ow * oh * 4);
	for (let oy = 0; oy < oh; oy++) {
		for (let ox = 0; ox < ow; ox++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;
			for (let y = oy * (CELL_H / 2); y < Math.min(h, (oy + 1) * (CELL_H / 2)); y++) {
				for (let x = ox * CELL_W; x < Math.min(w, (ox + 1) * CELL_W); x++) {
					const i = (y * w + x) * 4;
					const alpha = px[i + 3]!;
					r += px[i]! * alpha;
					g += px[i + 1]! * alpha;
					b += px[i + 2]! * alpha;
					a += alpha;
					n++;
				}
			}
			const o = (oy * ow + ox) * 4;
			if (a > 0) {
				out[o] = r / a;
				out[o + 1] = g / a;
				out[o + 2] = b / a;
			}
			out[o + 3] = a / n;
		}
	}
	return { px: out, w: ow, h: oh };
}

/** Frames side by side in one sheet. */
function sheet(frames: readonly Uint8Array[], w: number, h: number): Uint8Array {
	const out = new Uint8Array(frames.length * w * h * 4);
	frames.forEach((frame, f) => {
		for (let y = 0; y < h; y++) out.set(frame.subarray(y * w * 4, (y + 1) * w * 4), (y * frames.length * w + f * w) * 4);
	});
	return out;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
	// A variable specifier: resvg is a bake-time tool that is not installed until B2 adds it as a devDependency.
	const specifier = "@resvg/resvg-js";
	let resvg: ResvgModule;
	try {
		resvg = (await import(specifier)) as ResvgModule;
	} catch {
		console.error("@resvg/resvg-js is not installed: node_modules/.bin/bun add -d @resvg/resvg-js");
		process.exit(1);
	}
	const t1: Uint8Array[] = [];
	const t2: Uint8Array[] = [];
	let t2Size = { w: 0, h: 0 };
	const times: number[] = [];
	for (let f = 0; f < FRAMES; f++) {
		const svg = svgOf(poseAt(f), "#78c8ff");
		const start = performance.now();
		// Without `loadSystemFonts: false` resvg scans every system font first: ~300 ms per render instead of ~0.5 ms.
		const image = new resvg.Resvg(svg, { fitTo: { mode: "width", value: SPRITE.w }, font: { loadSystemFonts: false } }).render();
		times.push(performance.now() - start);
		t1.push(image.pixels);
		const half = halfCells(image.pixels, image.width, image.height);
		t2.push(half.px);
		t2Size = { w: half.w, h: half.h };
		if (outDir && f === 0) {
			mkdirSync(outDir, { recursive: true });
			writeFileSync(join(outDir, "key-a.svg"), svg);
		}
	}
	times.sort((a, b) => a - b);
	const t1Png = rgbaPng(sheet(t1, SPRITE.w, SPRITE.h), SPRITE.w * FRAMES, SPRITE.h);
	const t2Png = rgbaPng(sheet(t2, t2Size.w, t2Size.h), t2Size.w * FRAMES, t2Size.h);
	const palette = await new Bun.Image(t1Png).png({ palette: true, colors: 256 }).bytes();
	console.log(`resvg: ${FRAMES} frames of ${SPRITE.w}x${SPRITE.h} (8x4 cells), median ${times[FRAMES >> 1]!.toFixed(2)} ms, max ${times.at(-1)!.toFixed(2)} ms per frame`);
	console.log(`T1 sheet RGBA PNG (sub filter, zlib 9): ${(t1Png.length / 1024).toFixed(1)} KiB; same sheet quantised to 256 colours: ${(palette.length / 1024).toFixed(1)} KiB`);
	console.log(`T2 sheet ${t2Size.w}x${t2Size.h} per frame (RGBA, 1 px per half cell): ${(t2Png.length / 1024).toFixed(2)} KiB`);
	// Plan: ~80 sequences. Per species about 3 lane-creature loops, 4 events, 1 finale (8x4 cells) and director
	// sequences twice that box; starlings are procedural dots. Count a director frame as 2 lane frames.
	const laneSequences = 60;
	const directorSequences = 20;
	const perSequence = t1Png.length + t2Png.length;
	const estimate = laneSequences * perSequence + directorSequences * 2 * perSequence;
	console.log(
		`estimate for ${laneSequences} lane + ${directorSequences} director sequences of ${FRAMES} frames: ${(estimate / 1024 / 1024).toFixed(2)} MiB (RGBA); ${(((laneSequences + 2 * directorSequences) * (palette.length + t2Png.length)) / 1024 / 1024).toFixed(2)} MiB (T1 quantised)`,
	);
	if (outDir) {
		writeFileSync(join(outDir, "sheet-t1.png"), t1Png);
		writeFileSync(join(outDir, "sheet-t1-palette.png"), palette);
		writeFileSync(join(outDir, "sheet-t2.png"), t2Png);
	}
}

await main();
