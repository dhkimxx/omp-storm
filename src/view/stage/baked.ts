/**
 * The baked stage art, format v1 (shared with the art agent):
 *
 *   assets/stage/index.json  { "schema": "storm.stage-assets/v1", "cell": { "w": 9, "h": 18 },
 *                              "sequences": { "<species>/<actor>/<name>": { "w", "h", "anchor": { "x", "y" }, "frameMs",
 *                                "frames", "loop", "t1": "<path>.png", "t2": "<path>.png", "accent"?: { "t1", "t2" } } } }
 *
 * Sheets are 8-bit grey+alpha PNGs with the frames side by side, left to right. A T1 frame is `w` by `h` pixels at 9x18
 * per cell; a T2 frame is one pixel per half cell (each a 9x9 block of T1). Sheets are decoded when first used and kept.
 *
 * A sequence that is not baked draws nothing: `meta` and `frame` are undefined for it.
 */
import { readFileSync } from "node:fs";
import { type SequenceId, type SequenceMeta, type StageAssets, type StageFrame, type StageTier, T1_CELL_PX } from "./assets.ts";
import { decodePng } from "./png.ts";

export const STAGE_ASSETS_SCHEMA = "storm.stage-assets/v1";
/** Where the package keeps the baked art. */
export const STAGE_ASSETS_DIR = new URL("../../../assets/stage/", import.meta.url);

/** Cut frames kept at once: what one stage plays over a few seconds, not every frame of every sequence. */
const FRAME_CACHE = 512;

interface SequenceEntry {
	w: number;
	h: number;
	anchor: { x: number; y: number };
	frameMs: number;
	frames: number;
	loop: boolean;
	t1: string;
	t2: string;
	accent?: { t1: string; t2: string };
}
interface Index { schema: string; cell: { w: number; h: number }; sequences: Record<string, SequenceEntry> }

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

function validEntry(entry: unknown): entry is SequenceEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	const anchor = e.anchor as Record<string, unknown> | undefined;
	return positive(e.w) && positive(e.h) && positive(e.frameMs) && positive(e.frames) && typeof e.loop === "boolean" &&
		typeof e.t1 === "string" && typeof e.t2 === "string" && typeof anchor?.x === "number" && typeof anchor.y === "number";
}

/** Reads the v1 index from `dir`; undefined when there is none or it is not v1 at the cell size the renderers use. */
function readIndex(dir: URL): Index | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(new URL("index.json", dir), "utf8"));
	} catch {
		return undefined;
	}
	const index = parsed as Partial<Index>;
	if (index.schema !== STAGE_ASSETS_SCHEMA || index.cell?.w !== T1_CELL_PX.w || index.cell.h !== T1_CELL_PX.h) return undefined;
	const sequences: Record<string, SequenceEntry> = {};
	for (const [id, entry] of Object.entries(index.sequences ?? {})) if (validEntry(entry)) sequences[id] = entry;
	return { schema: index.schema, cell: index.cell, sequences };
}

interface Sheet { w: number; h: number; rgba: Uint8ClampedArray }

export class BakedAssets implements StageAssets {
	readonly #dir: URL;
	readonly #index: Index | undefined;
	readonly #sheets = new Map<string, Sheet | null>();
	/** Cut frames by sheet, index and tier: the same frame is the same object, so renderers can key caches on it. */
	readonly #frames = new Map<string, StageFrame>();

	constructor(dir: URL = STAGE_ASSETS_DIR) {
		this.#dir = dir;
		this.#index = readIndex(dir);
	}

	/** Whether `id` has baked sheets. */
	baked(id: SequenceId): boolean {
		return this.#index?.sequences[id] !== undefined;
	}

	meta(id: SequenceId): SequenceMeta | undefined {
		const entry = this.#index?.sequences[id];
		if (entry === undefined) return undefined;
		return { durationMs: entry.frameMs * entry.frames, loop: entry.loop, size: { w: entry.w, h: entry.h }, anchor: { ...entry.anchor } };
	}

	frame(id: SequenceId, tMs: number, tier: StageTier): StageFrame | undefined {
		const entry = this.#index?.sequences[id];
		if (entry === undefined) return undefined;
		return this.#cut(entry, tier === "t1" ? entry.t1 : entry.t2, tMs, tier);
	}

	accent(id: SequenceId, tMs: number, tier: StageTier): StageFrame | undefined {
		const entry = this.#index?.sequences[id];
		if (entry?.accent === undefined) return undefined;
		return this.#cut(entry, tier === "t1" ? entry.accent.t1 : entry.accent.t2, tMs, tier);
	}

	#sheet(path: string): Sheet | undefined {
		let sheet = this.#sheets.get(path);
		if (sheet === undefined) {
			try {
				const decoded = decodePng(readFileSync(new URL(path, this.#dir)));
				sheet = { w: decoded.w, h: decoded.h, rgba: new Uint8ClampedArray(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.byteLength) };
			} catch {
				sheet = null;
			}
			this.#sheets.set(path, sheet);
		}
		return sheet ?? undefined;
	}

	#cut(entry: SequenceEntry, path: string, tMs: number, tier: StageTier): StageFrame | undefined {
		const sheet = this.#sheet(path);
		if (sheet === undefined) return undefined;
		const w = tier === "t1" ? entry.w : Math.ceil(entry.w / T1_CELL_PX.w);
		const h = tier === "t1" ? entry.h : Math.ceil(entry.h / (T1_CELL_PX.h / 2));
		if (sheet.w < w * entry.frames || sheet.h < h) return undefined;
		const t = Number.isFinite(tMs) ? Math.max(0, tMs) : 0;
		const step = Math.floor(t / entry.frameMs);
		const k = entry.loop ? step % entry.frames : Math.min(entry.frames - 1, step);
		const key = `${path}|${k}|${tier}`;
		const kept = this.#frames.get(key);
		if (kept !== undefined) return kept;
		const rgba = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) {
			const from = (y * sheet.w + k * w) * 4;
			rgba.set(sheet.rgba.subarray(from, from + w * 4), y * w * 4);
		}
		const frame: StageFrame = tier === "t1" ? { tier, w, h, rgba } : { tier, w, h, rgba };
		if (this.#frames.size >= FRAME_CACHE) this.#frames.clear();
		this.#frames.set(key, frame);
		return frame;
	}
}

/** The art every stage renderer draws with. */
export const STAGE_ASSETS: StageAssets = new BakedAssets();
