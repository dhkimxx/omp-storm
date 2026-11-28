/**
 * Bakes the stage art (docs/stage.md "키프레임 제작"; the tool and format choices are docs/spikes.md S0).
 *
 * Every `assets/stage/src/<species>/<actor>/<name>.json` is one sequence:
 *
 *   { "w", "h", "anchor": { "x", "y" }, "frameMs", "durationMs", "loop",
 *     "keys": [{ "at": ms, "svg": "file.svg", "ease"?: "linear" | "in" | "out" | "inOut" }] }
 *
 * The key SVGs of a sequence share one text: tokenised into numbers and the text between them, the text must match key
 * for key, and only the numbers move. A frame mixes the numbers of the two keys around its time with the arriving key's
 * easing (default "inOut"). Frames are rasterised with resvg at T1 size; a top-level `<g id="accent">` is split into
 * the accent layer (the base renders without it, the accent with only it and the `<defs>`). Sheets are 8-bit
 * greyscale+alpha PNGs, frames left to right: grey is luminance, the renderer tints it. The T2 sheet has one pixel per
 * half cell, the average of each 9x9 T1 block. `assets/stage/index.json` lists every sequence (format
 * `storm.stage-assets/v1`). The bake fails past the size caps and gives the same bytes for the same sources. The caps
 * count what ships (index.json and the sheets); the package leaves `assets/stage/src` out.
 *
 * index.json also records what each sequence was baked from: `source`, the sha256 of its spec and key SVGs, and at the
 * top `baker`, the sha256 of this script and the PNG encoder with the resvg version. `--check` compares those with the
 * sources as they are now, without rendering (rendered bytes can differ by an antialiasing bit across platforms, so CI
 * compares sources, not sheets), and checks that every sheet exists within the caps.
 *
 *   bun scripts/stage/bake.ts                       # bake assets/stage (index.json and every sheet)
 *   bun scripts/stage/bake.ts --check               # fail if any sequence is unbaked, stale, orphaned or over a cap
 *   bun scripts/stage/bake.ts --contact DIR         # also write a contact sheet per sequence and per actor
 *   bun scripts/stage/bake.ts --only SPECIES --no-write --contact DIR   # preview one species, write no assets
 *
 * Usage for art authors: assets/stage/src/README.md.
 */
import type { Resvg as ResvgClass } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.ts";

const require = createRequire(import.meta.url);
let resvgClass: typeof ResvgClass | undefined;
/** A resvg renderer; the native module loads on first use, so `--check` never loads it. */
function newResvg(...args: ConstructorParameters<typeof ResvgClass>): ResvgClass {
	resvgClass ??= (require("@resvg/resvg-js") as { Resvg: typeof ResvgClass }).Resvg;
	return new resvgClass(...args);
}

const ROOT = fileURLToPath(new URL("../../assets/stage/", import.meta.url));
const SRC = join(ROOT, "src");
const INDEX = join(ROOT, "index.json");
const SCHEMA = "storm.stage-assets/v1";
const CELL = { w: 9, h: 18 } as const;
/** A T2 pixel covers half a cell: 9 by 9 T1 pixels. */
const HALF = 9;
/** What ships: index.json and every sheet. */
const CAP_TOTAL = 4 * 1024 * 1024;
const CAP_SEQUENCE = 96 * 1024;
/** The renderer's pose names, in the order contact sheets list them. */
const POSE_ORDER = ["ready", "work", "quiet", "submit", "review", "accepted", "unmet", "blocked", "excluded", "rest", "waiting-user", "finale", "lights-out", "gather", "user-steer", "user-stop"];

type Ease = "linear" | "in" | "out" | "inOut";
const EASE: Readonly<Record<Ease, (t: number) => number>> = {
	linear: t => t,
	in: t => t * t * t,
	out: t => 1 - (1 - t) ** 3,
	inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

interface KeySpec { at: number; svg: string; ease?: Ease }
interface SequenceSpec {
	w: number;
	h: number;
	anchor: { x: number; y: number };
	frameMs: number;
	durationMs: number;
	loop: boolean;
	keys: KeySpec[];
}
interface Tokens { file: string; source: string; texts: string[]; numbers: string[]; offsets: number[] }
interface Layer { t1: Uint8Array; t2: Uint8Array }
interface Baked {
	id: string;
	spec: SequenceSpec;
	frames: number;
	base: Layer;
	accent?: Layer;
	/** sha256 of the sources the sequence was baked from. */
	source: string;
	/** Relative path under assets/stage → bytes. */
	files: Map<string, Buffer>;
}

class BakeError extends Error {}
function fail(file: string, message: string): never {
	throw new BakeError(`${relative(process.cwd(), file)}: ${message}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------------------

function sequenceFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir).sort()) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (entry.endsWith(".json")) out.push(path);
		}
	};
	if (existsSync(SRC)) walk(SRC);
	return out;
}

function sequenceId(file: string): string {
	const id = relative(SRC, file).replace(/\\/g, "/").replace(/\.json$/, "");
	if (id.split("/").length !== 3) fail(file, "sequences live at src/<species>/<actor>/<name>.json");
	return id;
}

/** sha256 over a sequence's spec and the key SVGs it names: their paths under src/, sorted, each with its bytes. */
function sourceHash(file: string, spec: SequenceSpec): string {
	const paths = new Set([file, ...spec.keys.map(key => join(dirname(file), key.svg))]);
	const hash = createHash("sha256");
	for (const path of [...paths].map(p => relative(SRC, p).replace(/\\/g, "/")).sort()) {
		if (!existsSync(join(SRC, path))) fail(file, `key ${path} is missing`);
		hash.update(`${path}\0`);
		hash.update(readFileSync(join(SRC, path)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** What made the sheets: this script and the PNG encoder (by content) and the resvg version. */
function bakerVersion(): { sha256: string; resvg: string } {
	const hash = createHash("sha256");
	for (const name of ["bake.ts", "png.ts"]) {
		hash.update(`${name}\0`);
		hash.update(readFileSync(fileURLToPath(new URL(name, import.meta.url))));
		hash.update("\0");
	}
	const resvg = (JSON.parse(readFileSync(require.resolve("@resvg/resvg-js/package.json"), "utf8")) as { version: string }).version;
	return { sha256: hash.digest("hex"), resvg };
}

function readSpec(file: string): SequenceSpec {
	let spec: SequenceSpec;
	try {
		spec = JSON.parse(readFileSync(file, "utf8")) as SequenceSpec;
	} catch (error) {
		fail(file, `not JSON: ${(error as Error).message}`);
	}
	const positive = (value: unknown, name: string): void => {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(file, `${name} must be a positive number`);
	};
	positive(spec.w, "w");
	positive(spec.h, "h");
	positive(spec.frameMs, "frameMs");
	positive(spec.durationMs, "durationMs");
	if (!Number.isInteger(spec.w) || !Number.isInteger(spec.h)) fail(file, "w and h must be whole pixels");
	if (spec.w % HALF !== 0 || spec.h % HALF !== 0) fail(file, `w and h must be multiples of ${HALF} (one T2 pixel per half cell)`);
	if (typeof spec.anchor?.x !== "number" || typeof spec.anchor?.y !== "number") fail(file, "anchor needs x and y");
	if (typeof spec.loop !== "boolean") fail(file, "loop must be true or false");
	if (!Array.isArray(spec.keys) || spec.keys.length === 0) fail(file, "keys must list at least one key");
	spec.keys.forEach((key, n) => {
		if (typeof key.at !== "number" || typeof key.svg !== "string") fail(file, `key ${n} needs at and svg`);
		if (n > 0 && key.at < spec.keys[n - 1]!.at) fail(file, `key ${n} at ${key.at} comes before key ${n - 1}`);
		if (key.ease !== undefined && !(key.ease in EASE)) fail(file, `key ${n} has an unknown ease "${key.ease}"`);
	});
	if (spec.keys[0]!.at !== 0) fail(file, "the first key must be at 0");
	if (spec.keys[spec.keys.length - 1]!.at !== spec.durationMs) fail(file, "the last key must be at durationMs");
	return spec;
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)/g;

function tokenise(file: string): Tokens {
	const source = readFileSync(file, "utf8");
	const texts: string[] = [];
	const numbers: string[] = [];
	const offsets: number[] = [];
	let last = 0;
	for (const match of source.matchAll(NUMBER)) {
		texts.push(source.slice(last, match.index));
		offsets.push(last);
		numbers.push(match[0]);
		last = match.index + match[0].length;
	}
	texts.push(source.slice(last));
	offsets.push(last);
	return { file, source, texts, numbers, offsets };
}

function position(source: string, offset: number): string {
	const before = source.slice(0, offset).split("\n");
	return `line ${before.length}, column ${before[before.length - 1]!.length + 1}`;
}

/** Fails unless `other` has the same text as `first` between its numbers. */
function sameText(spec: string, first: Tokens, other: Tokens): void {
	const n = Math.min(first.texts.length, other.texts.length);
	for (let i = 0; i < n; i++) {
		if (first.texts[i] === other.texts[i]) continue;
		const a = first.texts[i]!;
		const b = other.texts[i]!;
		let k = 0;
		while (k < a.length && k < b.length && a[k] === b[k]) k++;
		const snippet = (text: string): string => JSON.stringify(text.slice(Math.max(0, k - 12), k + 24));
		fail(
			spec,
			`${relative(SRC, other.file)} differs from ${relative(SRC, first.file)} outside numbers at ${position(other.source, other.offsets[i]! + k)} ` +
				`(${position(first.source, first.offsets[i]! + k)} there): ${snippet(b)} vs ${snippet(a)}`,
		);
	}
	if (first.texts.length !== other.texts.length) {
		fail(spec, `${relative(SRC, other.file)} has ${other.numbers.length} numbers, ${relative(SRC, first.file)} has ${first.numbers.length}`);
	}
}

function mixNumber(a: string, b: string, t: number): string {
	if (a === b) return a;
	const value = Math.round((Number(a) + (Number(b) - Number(a)) * t) * 1000) / 1000;
	return value === 0 ? "0" : String(value);
}

/** The SVG of the sequence at `t` ms. */
function svgAt(spec: SequenceSpec, keys: readonly Tokens[], t: number): string {
	let i = 0;
	while (i + 1 < spec.keys.length && spec.keys[i + 1]!.at <= t) i++;
	const from = keys[i]!;
	if (i + 1 >= spec.keys.length) return from.source;
	const to = keys[i + 1]!;
	const span = spec.keys[i + 1]!.at - spec.keys[i]!.at;
	const p = EASE[spec.keys[i + 1]!.ease ?? "inOut"]((t - spec.keys[i]!.at) / span);
	let out = from.texts[0]!;
	for (let n = 0; n < from.numbers.length; n++) out += mixNumber(from.numbers[n]!, to.numbers[n]!, p) + from.texts[n + 1]!;
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Layers and rasters
// ---------------------------------------------------------------------------------------------------------------

const TAG = /<(\/?)([A-Za-z][\w:.-]*)\b[^>]*?(\/?)>|<!--[\s\S]*?-->/g;

/** The base SVG without `<g id="accent">`, and one with only the accent group (and the defs it may use). */
function splitAccent(svg: string, file: string): { base: string; accent: string } | undefined {
	const at = svg.indexOf('<g id="accent"');
	if (at < 0) return undefined;
	let depth = 0;
	let start = -1;
	let rootEnd = -1;
	for (const match of svg.matchAll(TAG)) {
		if (match[2] === undefined) continue;
		const closing = match[1] === "/";
		const selfClosing = match[3] === "/";
		if (match.index === at) {
			if (depth !== 1) fail(file, '<g id="accent"> must be a direct child of <svg>');
			start = at;
		}
		if (rootEnd < 0 && match[2] === "svg" && !closing) rootEnd = match.index + match[0].length;
		if (closing) {
			depth--;
			if (start >= 0 && depth === 1) {
				const end = match.index + match[0].length;
				const defs = svg.match(/<defs>[\s\S]*?<\/defs>/g) ?? [];
				return {
					base: svg.slice(0, start) + svg.slice(end),
					accent: `${svg.slice(0, rootEnd)}${defs.join("")}${svg.slice(start, end)}</svg>`,
				};
			}
		} else if (!selfClosing) depth++;
	}
	fail(file, '<g id="accent"> is not closed');
}

/** One frame as greyscale+alpha: grey is the unpremultiplied mean of the channels. */
function raster(svg: string, spec: SequenceSpec, file: string): Uint8Array {
	const image = newResvg(svg, { font: { loadSystemFonts: false } }).render();
	if (image.width !== spec.w || image.height !== spec.h) fail(file, `a key renders ${image.width}x${image.height}, not ${spec.w}x${spec.h}`);
	const rgba = image.pixels;
	const out = new Uint8Array(spec.w * spec.h * 2);
	for (let i = 0, o = 0; i < rgba.length; i += 4, o += 2) {
		const a = rgba[i + 3]!;
		if (a === 0) continue;
		out[o] = Math.min(255, Math.round(((rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / 3) * (255 / a)));
		out[o + 1] = a;
	}
	return out;
}

/** One pixel per half cell: the mean coverage of each 9x9 block, its grey weighted by coverage. */
function halfCells(ga: Uint8Array, w: number, h: number): Uint8Array {
	const tw = w / HALF;
	const th = h / HALF;
	const out = new Uint8Array(tw * th * 2);
	for (let by = 0; by < th; by++) {
		for (let bx = 0; bx < tw; bx++) {
			let alpha = 0;
			let grey = 0;
			for (let y = by * HALF; y < (by + 1) * HALF; y++) {
				for (let x = bx * HALF; x < (bx + 1) * HALF; x++) {
					const a = ga[(y * w + x) * 2 + 1]!;
					alpha += a;
					grey += ga[(y * w + x) * 2]! * a;
				}
			}
			const o = (by * tw + bx) * 2;
			out[o] = alpha === 0 ? 0 : Math.round(grey / alpha);
			out[o + 1] = Math.round(alpha / (HALF * HALF));
		}
	}
	return out;
}

/** Frames side by side in one row. */
function sheet(frames: readonly Uint8Array[], w: number, h: number): Uint8Array {
	const out = new Uint8Array(frames.length * w * h * 2);
	frames.forEach((frame, f) => {
		for (let y = 0; y < h; y++) out.set(frame.subarray(y * w * 2, (y + 1) * w * 2), (y * frames.length * w + f * w) * 2);
	});
	return out;
}

function frameTimes(spec: SequenceSpec): number[] {
	if (spec.loop) {
		const frames = Math.max(1, Math.round(spec.durationMs / spec.frameMs));
		return Array.from({ length: frames }, (_, f) => (spec.durationMs * f) / frames);
	}
	const steps = Math.max(1, Math.round(spec.durationMs / spec.frameMs));
	return Array.from({ length: steps + 1 }, (_, f) => (spec.durationMs * f) / steps);
}

function bakeSequence(file: string): Baked {
	const id = sequenceId(file);
	const spec = readSpec(file);
	const source = sourceHash(file, spec);
	const keys = spec.keys.map(key => tokenise(join(dirname(file), key.svg)));
	for (const key of keys.slice(1)) sameText(file, keys[0]!, key);
	const base: Uint8Array[] = [];
	const accent: Uint8Array[] = [];
	for (const t of frameTimes(spec)) {
		const svg = svgAt(spec, keys, t);
		const layers = splitAccent(svg, file);
		base.push(raster(layers?.base ?? svg, spec, file));
		if (layers !== undefined) accent.push(raster(layers.accent, spec, file));
	}
	const t2w = spec.w / HALF;
	const t2h = spec.h / HALF;
	const layer = (frames: readonly Uint8Array[]): Layer => ({
		t1: sheet(frames, spec.w, spec.h),
		t2: sheet(frames.map(frame => halfCells(frame, spec.w, spec.h)), t2w, t2h),
	});
	const files = new Map<string, Buffer>();
	const baseLayer = layer(base);
	files.set(`${id}.t1.png`, encodePng(baseLayer.t1, spec.w * base.length, spec.h, 2));
	files.set(`${id}.t2.png`, encodePng(baseLayer.t2, t2w * base.length, t2h, 2));
	const visible = accent.some(frame => frame.some((value, i) => i % 2 === 1 && value > 0));
	const accentLayer = visible ? layer(accent) : undefined;
	if (accentLayer !== undefined) {
		files.set(`${id}.accent.t1.png`, encodePng(accentLayer.t1, spec.w * accent.length, spec.h, 2));
		files.set(`${id}.accent.t2.png`, encodePng(accentLayer.t2, t2w * accent.length, t2h, 2));
	}
	return { id, spec, frames: base.length, base: baseLayer, ...(accentLayer === undefined ? {} : { accent: accentLayer }), source, files };
}

// ---------------------------------------------------------------------------------------------------------------
// Index, caps, output
// ---------------------------------------------------------------------------------------------------------------

function indexOf(baked: readonly Baked[]): string {
	const sequences: Record<string, unknown> = {};
	for (const { id, spec, frames, accent, source } of baked) {
		sequences[id] = {
			w: spec.w,
			h: spec.h,
			anchor: { x: spec.anchor.x, y: spec.anchor.y },
			frameMs: spec.frameMs,
			frames,
			loop: spec.loop,
			t1: `${id}.t1.png`,
			t2: `${id}.t2.png`,
			...(accent === undefined ? {} : { accent: { t1: `${id}.accent.t1.png`, t2: `${id}.accent.t2.png` } }),
			source,
		};
	}
	return `${JSON.stringify({ schema: SCHEMA, cell: CELL, baker: bakerVersion(), sequences }, null, "\t")}\n`;
}

/** The parts of index.json `--check` reads. */
interface IndexRecord {
	baker?: { sha256?: string; resvg?: string };
	sequences?: Record<string, { source?: string; t1?: string; t2?: string; accent?: { t1?: string; t2?: string } }>;
}

/**
 * Fails unless index.json matches the sources as they are: the same bake tool, every sequence with sources baked from
 * exactly those sources, no baked sequence without sources, every sheet present and within the caps. No rendering.
 */
function check(): void {
	if (!existsSync(INDEX)) throw new BakeError(`${relative(process.cwd(), INDEX)} is missing: run bun scripts/stage/bake.ts`);
	let index: IndexRecord;
	try {
		index = JSON.parse(readFileSync(INDEX, "utf8")) as IndexRecord;
	} catch (error) {
		fail(INDEX, `not JSON: ${(error as Error).message}`);
	}
	const baked = index.sequences ?? {};
	const problems: string[] = [];
	const baker = bakerVersion();
	if (index.baker?.sha256 !== baker.sha256 || index.baker?.resvg !== baker.resvg) {
		problems.push(`the bake tool changed since the last bake (bake.ts, png.ts or resvg ${index.baker?.resvg ?? "?"} → ${baker.resvg}): rebake needed`);
	}
	const sourced = new Set<string>();
	for (const file of sequenceFiles()) {
		try {
			const id = sequenceId(file);
			sourced.add(id);
			const source = sourceHash(file, readSpec(file));
			const entry = baked[id];
			if (entry === undefined) problems.push(`${id}: has sources but is not baked`);
			else if (entry.source !== source) problems.push(`${id}: sources changed since the last bake`);
		} catch (error) {
			if (!(error instanceof BakeError)) throw error;
			problems.push(error.message);
		}
	}
	let total = statSync(INDEX).size;
	for (const [id, entry] of Object.entries(baked)) {
		if (!sourced.has(id)) problems.push(`${id}: baked, but its sources are gone`);
		let bytes = 0;
		for (const sheet of [entry.t1, entry.t2, entry.accent?.t1, entry.accent?.t2]) {
			if (sheet === undefined) continue;
			const path = join(ROOT, sheet);
			if (existsSync(path)) bytes += statSync(path).size;
			else problems.push(`${id}: ${sheet} is missing`);
		}
		if (entry.t1 === undefined || entry.t2 === undefined) problems.push(`${id}: index.json names no t1 or t2 sheet`);
		if (bytes > CAP_SEQUENCE) problems.push(`${id} is ${kib(bytes)} (cap ${kib(CAP_SEQUENCE)})`);
		total += bytes;
	}
	if (total > CAP_TOTAL) problems.push(`the baked assets are ${kib(total)} (cap ${kib(CAP_TOTAL)})`);
	if (problems.length > 0) throw new BakeError(`stage assets out of date; rebake with bun scripts/stage/bake.ts:\n  ${problems.join("\n  ")}`);
	console.log(`stage assets match their sources: ${Object.keys(baked).length} sequences, ${kib(total)}`);
}

/** Removes baked files no sequence produces any more (everything under assets/stage but the sources). */
function removeStale(keep: ReadonlySet<string>): void {
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (path === SRC) continue;
			if (statSync(path).isDirectory()) {
				walk(path);
				if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
			} else if (entry.endsWith(".png") && !keep.has(relative(ROOT, path).replace(/\\/g, "/"))) rmSync(path);
		}
	};
	if (existsSync(ROOT)) walk(ROOT);
}

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

// ---------------------------------------------------------------------------------------------------------------
// Contact sheets
// ---------------------------------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number];
const NIGHT: Rgb = [7, 10, 24];
const TINT: Readonly<Record<string, Rgb>> = { director: [150, 205, 255], worker: [96, 226, 196], fx: [110, 150, 210] };
const AMBER: Rgb = [255, 176, 56];
/** The renderer's state colours of a worker's accent layer. */
const WORKER_ACCENT: Readonly<Record<string, Rgb>> = { blocked: [255, 72, 72], accepted: [96, 240, 128] };
const WHITE: Rgb = [255, 255, 255];

/** One frame of a layer pair, tinted and composited on the night sky as opaque RGBA, scaled up by `scale`. */
function composite(base: Uint8Array, accent: Uint8Array | undefined, w: number, h: number, scale: number, tint: Rgb, hot: Rgb): Uint8Array {
	const out = new Uint8Array(w * scale * h * scale * 4);
	for (let y = 0; y < h * scale; y++) {
		for (let x = 0; x < w * scale; x++) {
			const i = (Math.floor(y / scale) * w + Math.floor(x / scale)) * 2;
			const o = (y * w * scale + x) * 4;
			for (let c = 0; c < 3; c++) {
				let v = NIGHT[c]!;
				const a = base[i + 1]! / 255;
				v = v * (1 - a) + (tint[c]! * base[i]!) / 255 * a;
				if (accent !== undefined) {
					const b = accent[i + 1]! / 255;
					v = v * (1 - b) + (hot[c]! * accent[i]!) / 255 * b;
				}
				out[o + c] = Math.round(v);
			}
			out[o + 3] = 255;
		}
	}
	return out;
}

/** Frame `f` of a sheet. */
function frameOf(sheetPx: Uint8Array, frames: number, w: number, h: number, f: number): Uint8Array {
	const out = new Uint8Array(w * h * 2);
	for (let y = 0; y < h; y++) out.set(sheetPx.subarray((y * frames * w + f * w) * 2, (y * frames * w + (f + 1) * w) * 2), y * w * 2);
	return out;
}

const dataUri = (px: Uint8Array, w: number, h: number): string => `data:image/png;base64,${encodePng(px, w, h, 4).toString("base64")}`;
const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The frames of a sequence at both tiers (T2 blown up to the T1 box), `zoom` times. */
function tiles(b: Baked, picks: readonly number[], zoom: number): { t1: string[]; t2: string[]; w: number; h: number } {
	const { w, h } = b.spec;
	const [, actor, name] = b.id.split("/") as [string, string, string];
	const tint = TINT[actor] ?? WHITE;
	const hot = name === "waiting-user" ? AMBER : actor === "worker" ? (WORKER_ACCENT[name] ?? WHITE) : WHITE;
	const t2w = w / HALF;
	const t2h = h / HALF;
	return {
		w: w * zoom,
		h: h * zoom,
		t1: picks.map(f =>
			dataUri(composite(frameOf(b.base.t1, b.frames, w, h, f), b.accent && frameOf(b.accent.t1, b.frames, w, h, f), w, h, zoom, tint, hot), w * zoom, h * zoom),
		),
		t2: picks.map(f =>
			dataUri(
				composite(frameOf(b.base.t2, b.frames, t2w, t2h, f), b.accent && frameOf(b.accent.t2, b.frames, t2w, t2h, f), t2w, t2h, HALF * zoom, tint, hot),
				w * zoom,
				h * zoom,
			),
		),
	};
}

function renderContact(svg: string): Buffer {
	return newResvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Menlo" } }).render().asPng();
}

/** Every frame of one sequence: T1 rows, then T2 rows. */
function sequenceContact(b: Baked): Buffer {
	const zoom = b.spec.w > 150 ? 1 : 2;
	const perRow = 12;
	const picks = Array.from({ length: b.frames }, (_, f) => f);
	const { t1, t2, w, h } = tiles(b, picks, zoom);
	const rows = Math.ceil(b.frames / perRow);
	const gap = 4;
	const top = 22;
	const width = perRow * (w + gap) + gap;
	const height = top + 2 * rows * (h + gap) + 18 + gap;
	const images: string[] = [];
	const place = (uris: readonly string[], y0: number): void =>
		uris.forEach((uri, f) => {
			const x = gap + (f % perRow) * (w + gap);
			const y = y0 + Math.floor(f / perRow) * (h + gap);
			images.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" image-rendering="optimizeSpeed" href="${uri}"/>`);
		});
	place(t1, top);
	const t2Top = top + rows * (h + gap) + 18;
	place(t2, t2Top);
	const label = `${b.id}  ${b.frames} frames x ${b.spec.frameMs} ms${b.spec.loop ? " loop" : ""}`;
	return renderContact(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="rgb(20,22,34)"/>` +
			`<text x="${gap}" y="15" font-size="13" fill="white">${escapeXml(label)}  (T1 x${zoom})</text>` +
			`<text x="${gap}" y="${t2Top - 5}" font-size="13" fill="white">T2 (one block per half cell)</text>${images.join("")}</svg>`,
	);
}

/** One row per sequence of an actor: evenly picked frames at T1, then the same frames at T2. */
function actorContact(baked: readonly Baked[]): Buffer {
	const wide = baked.some(b => b.spec.w > 150);
	const zoom = wide ? 1 : 2;
	const samples = wide ? 3 : 6;
	const label = 120;
	const gap = 4;
	const rows = baked.map(b => {
		const picks = Array.from({ length: Math.min(samples, b.frames) }, (_, k) => (b.frames === 1 ? 0 : Math.round((k * (b.frames - 1)) / Math.max(1, samples - 1))));
		return { b, ...tiles(b, picks, zoom) };
	});
	const w = Math.max(...rows.map(row => row.w));
	const h = Math.max(...rows.map(row => row.h));
	const half = samples * (w + gap);
	const width = label + 2 * half + 3 * gap;
	const height = rows.length * (h + gap) + gap;
	const parts: string[] = [];
	rows.forEach((row, r) => {
		const y = gap + r * (h + gap);
		parts.push(`<text x="${gap}" y="${y + h / 2}" font-size="13" fill="white">${escapeXml(row.b.id.split("/")[2]!)}</text>`);
		row.t1.forEach((uri, k) => parts.push(`<image x="${label + k * (w + gap)}" y="${y}" width="${row.w}" height="${row.h}" image-rendering="optimizeSpeed" href="${uri}"/>`));
		row.t2.forEach((uri, k) => parts.push(`<image x="${label + half + 2 * gap + k * (w + gap)}" y="${y}" width="${row.w}" height="${row.h}" image-rendering="optimizeSpeed" href="${uri}"/>`));
	});
	return renderContact(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="rgb(20,22,34)"/>` +
			`<line x1="${label + half + gap}" y1="0" x2="${label + half + gap}" y2="${height}" stroke="rgb(70,74,96)"/>${parts.join("")}</svg>`,
	);
}

function poseRank(id: string): string {
	const name = id.split("/")[2]!;
	const rank = POSE_ORDER.indexOf(name);
	return `${id.split("/").slice(0, 2).join("/")}/${String(rank < 0 ? 99 : rank).padStart(2, "0")}${name}`;
}

function writeContacts(dir: string, baked: readonly Baked[]): void {
	mkdirSync(dir, { recursive: true });
	const actors = new Map<string, Baked[]>();
	for (const b of [...baked].sort((a, c) => poseRank(a.id).localeCompare(poseRank(c.id)))) {
		writeFileSync(join(dir, `${b.id.replace(/\//g, "-")}.png`), sequenceContact(b));
		const actor = b.id.split("/").slice(0, 2).join("-");
		actors.set(actor, [...(actors.get(actor) ?? []), b]);
	}
	for (const [actor, list] of actors) {
		const path = join(dir, `${actor}.png`);
		writeFileSync(path, actorContact(list));
		console.log(`contact ${path}`);
	}
}

// ---------------------------------------------------------------------------------------------------------------

function main(): void {
	const args = process.argv.slice(2);
	if (args.includes("--check")) {
		if (args.length > 1) throw new BakeError("--check takes no other options");
		check();
		return;
	}
	const option = (name: string): string | undefined => {
		const at = args.indexOf(name);
		if (at < 0) return undefined;
		const value = args[at + 1];
		if (value === undefined || value.startsWith("--")) throw new BakeError(`${name} needs a value`);
		return value;
	};
	const contact = option("--contact");
	const only = option("--only");
	const write = !args.includes("--no-write");
	if (only !== undefined && write) throw new BakeError("--only bakes one species, and index.json lists them all: add --no-write");
	const files = sequenceFiles().filter(file => only === undefined || relative(SRC, file).split(/[\\/]/)[0] === only);
	if (files.length === 0) throw new BakeError(`no sequences under ${relative(process.cwd(), SRC)}${only === undefined ? "" : ` for species "${only}"`}`);
	const baked = files.map(bakeSequence);

	const over: string[] = [];
	let total = 0;
	for (const b of baked) {
		let bytes = 0;
		for (const buffer of b.files.values()) bytes += buffer.length;
		total += bytes;
		console.log(`${b.id.padEnd(36)} ${String(b.frames).padStart(3)} frames  ${kib(bytes).padStart(10)}`);
		if (bytes > CAP_SEQUENCE) over.push(`${b.id} is ${kib(bytes)} (cap ${kib(CAP_SEQUENCE)})`);
	}
	const index = indexOf(baked);
	total += Buffer.byteLength(index);
	console.log(`total baked ${kib(total)} (cap ${kib(CAP_TOTAL)})${only === undefined ? "" : ` with only ${only}`}`);
	if (total > CAP_TOTAL) over.push(`the baked assets are ${kib(total)} (cap ${kib(CAP_TOTAL)})`);
	if (contact !== undefined) writeContacts(contact, baked);
	if (over.length > 0) throw new BakeError(`size cap exceeded:\n  ${over.join("\n  ")}`);
	if (!write) {
		console.log("--no-write: assets left as they were");
		return;
	}
	const keep = new Set<string>();
	for (const b of baked) {
		for (const [path, buffer] of b.files) {
			keep.add(path);
			mkdirSync(dirname(join(ROOT, path)), { recursive: true });
			writeFileSync(join(ROOT, path), buffer);
		}
	}
	removeStale(keep);
	writeFileSync(INDEX, index);
}

try {
	main();
} catch (error) {
	if (!(error instanceof BakeError)) throw error;
	console.error(`bake failed: ${error.message}`);
	process.exit(1);
}
