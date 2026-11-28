/**
 * The T1 stage: one picture per frame, sent as a 256-colour indexed PNG through the host's inline images (B0), and
 * which tier the stage draws in.
 *
 * - One key per stage. The host's image store replaces a keyed picture in place (delete, then transmit under the same
 *   number); a fresh key per frame would leave earlier placements on screen in direct-placement terminals.
 * - Direct placements are rows that measure 0 cells: the host's writer only rewrites a row whose text changed, so a
 *   new picture under the same key would vanish. Such rows get a harmless SGR (`ESC[22m`) on every other frame.
 * - Before the stage leaves, it draws one transparent frame under its key so the last picture is deleted.
 * - Transfer budget: 32 KiB a frame and 400 KiB a second. Over it, the frame interval doubles (up to 4x); still over
 *   at 4x, the stage drops to T2 for the rest of the run.
 */
import type { Rgb } from "../lane/colour.ts";
import { indexedPng, rgbaPng } from "./png.ts";
import { stagePalette } from "./palette.ts";

/** T1 image, T2 half blocks, T3 braille. */
export type StageDrawTier = "t1" | "t2" | "t3";

export const FRAME_BUDGET_BYTES = 32 * 1024;
export const RATE_BUDGET_BYTES = 400 * 1024;
export const MAX_STRETCH = 4;
/** A frame this far over the frame budget cannot be saved by waiting longer between frames. */
const HOPELESS_FRAME = 2;
/** Under half the budgets for this long, the interval halves again. */
const RELAX_MS = 3000;
/** The SGR a direct-placement row toggles so the writer redraws it. */
export const PLACEMENT_TOGGLE = "\x1b[22m";

/** What the stage knows about the terminal. */
export interface StageTerminal {
	/** The host's image protocol for this terminal, or null when it draws none. */
	images: "kitty" | "sixel" | "iterm" | null;
	multiplexer: "tmux" | "zellij" | "screen" | null;
	/** Kitty draws images as placeholder cells (they move with the text, inside tmux too). */
	placeholders: boolean;
	truecolor: boolean;
	/** The session runs over SSH. */
	ssh: boolean;
}

/**
 * The tier the stage draws in. Without true colour the braille stage (T3); without images, over SSH, or in tmux
 * unless kitty draws placeholder cells: half blocks (T2). SIXEL shows a still picture only, so a moving stage there is
 * T2 too. Everything else: the image (T1).
 */
export function selectStageTier(terminal: StageTerminal, motion: boolean): StageDrawTier {
	if (!terminal.truecolor) return "t3";
	if (terminal.images === null || terminal.ssh) return "t2";
	if (terminal.multiplexer !== null && !(terminal.images === "kitty" && terminal.placeholders)) return "t2";
	if (terminal.images === "sixel" && motion) return "t2";
	return "t1";
}

/** What `images.rows` takes: the host's `ImageSource`. */
export interface StageImage { key: string; data: string; mime: "image/png"; widthPx: number; heightPx: number }

/** The picture the channel encodes: opaque RGB and the lane colours on stage (they pick the palette). */
export interface StageImagePixels { w: number; h: number; rgb: Uint8Array; dark: boolean; laneColours: readonly Rgb[] }

/** A base64 indexed PNG of the picture, in the stage palette. Deterministic for the same pixels and colours. */
export function encodeStageFrame(pixels: StageImagePixels): string {
	const palette = stagePalette(pixels.dark, pixels.laneColours);
	return Buffer.from(indexedPng(pixels.rgb, pixels.w, pixels.h, palette.plte, palette.lut)).toString("base64");
}

/**
 * One stage's image stream: when a new frame is due, the budget, and the key every frame is sent under. It holds no
 * terminal: the painter hands its sources to the host.
 */
export class StageImageChannel {
	readonly key: string;
	readonly #encode: (pixels: StageImagePixels) => string;
	#stretch = 1;
	#demoted = false;
	#last: { at: number; source: StageImage } | undefined;
	#sent: { at: number; bytes: number }[] = [];
	#calmSince: number | undefined;
	#frames = 0;

	/** `encode` turns a picture into the base64 the host sends; the indexed PNG unless a caller measures another. */
	constructor(key: string, encode: (pixels: StageImagePixels) => string = encodeStageFrame) {
		this.key = key;
		this.#encode = encode;
	}

	/** How many times the base interval a frame waits now: 1, 2 or 4. */
	get stretch(): number {
		return this.#stretch;
	}

	/** The budget could not be kept: the stage draws T2 from now on. */
	get demoted(): boolean {
		return this.#demoted;
	}

	/** Frames encoded so far; its parity drives the direct-placement toggle. */
	get frames(): number {
		return this.#frames;
	}

	/** Whether a picture was sent that a clear frame must remove. */
	get showing(): boolean {
		return this.#last !== undefined;
	}

	/**
	 * The source to draw at `now`: a new frame when `intervalMs` (stretched) has passed since the last one, else the
	 * last one again. `still` frames are encoded only when `stillKey` changes (a still picture redraws on events).
	 * Undefined once demoted.
	 */
	frame(now: number, intervalMs: number, pixels: () => StageImagePixels, still?: string): StageImage | undefined {
		if (this.#demoted) return undefined;
		const last = this.#last;
		if (last !== undefined) {
			if (still !== undefined ? still === this.#stillKey : now - last.at < intervalMs * this.#stretch) return last.source;
		}
		const picture = pixels();
		const data = this.#encode(picture);
		const source: StageImage = { key: this.key, data, mime: "image/png", widthPx: picture.w, heightPx: picture.h };
		this.#stillKey = still;
		this.#last = { at: now, source };
		this.#frames++;
		this.#account(now, data.length);
		return this.#demoted ? undefined : source;
	}

	#stillKey: string | undefined;

	/** The transparent frame that deletes the last picture under the key; the channel then shows nothing. */
	clear(): StageImage {
		const w = this.#last?.source.widthPx ?? 1;
		const h = this.#last?.source.heightPx ?? 1;
		this.#last = undefined;
		this.#stillKey = undefined;
		const data = Buffer.from(rgbaPng(new Uint8Array(w * h * 4), w, h)).toString("base64");
		return { key: this.key, data, mime: "image/png", widthPx: w, heightPx: h };
	}

	#account(now: number, bytes: number): void {
		this.#sent.push({ at: now, bytes });
		while (this.#sent.length > 0 && now - this.#sent[0]!.at >= 1000) this.#sent.shift();
		const rate = this.#sent.reduce((sum, item) => sum + item.bytes, 0);
		const over = bytes > FRAME_BUDGET_BYTES || rate > RATE_BUDGET_BYTES;
		if (bytes > FRAME_BUDGET_BYTES * HOPELESS_FRAME) {
			this.#demoted = true;
			return;
		}
		if (over) {
			this.#calmSince = undefined;
			if (this.#stretch < MAX_STRETCH) {
				this.#stretch *= 2;
				// The window measured the old pace; the new one starts counting afresh.
				this.#sent = [];
			} else if (rate > RATE_BUDGET_BYTES) this.#demoted = true;
			return;
		}
		const calm = bytes * 2 <= FRAME_BUDGET_BYTES && rate * 2 <= RATE_BUDGET_BYTES;
		if (!calm || this.#stretch === 1) {
			this.#calmSince = undefined;
			return;
		}
		this.#calmSince ??= now;
		if (now - this.#calmSince >= RELAX_MS) {
			this.#stretch /= 2;
			this.#calmSince = undefined;
		}
	}
}

/** What `images.rows` returned: rows that may measure 0 cells (placements) and the cells the picture spans. */
export interface StageImageRows { rows: readonly string[]; columns: number }

/**
 * The view's rows: each stage image row, then the graph's row beside it. A row that measures 0 cells is a placement:
 * the cursor steps over the stage (spaces would erase the pixels) and, on odd frames, carries the toggle. The phrase
 * row and any row the picture does not reach are text.
 */
export function joinStageRows(
	image: StageImageRows,
	stageCols: number,
	pictureRows: number,
	phrase: string,
	graph: readonly string[],
	graphCols: number,
	measure: (row: string) => number,
	toggle: boolean,
): string[] {
	const blank = " ".repeat(graphCols);
	const out: string[] = [];
	for (let i = 0; i < pictureRows + 1; i++) {
		const right = graph[i] ?? blank;
		if (i === pictureRows) {
			out.push(`${phrase} ${right}`);
			continue;
		}
		const cell = image.rows[i];
		if (cell === undefined) {
			out.push(`${" ".repeat(stageCols + 1)}${right}`);
			continue;
		}
		const width = measure(cell);
		const mark = toggle && cell.includes("\x1b_G") ? PLACEMENT_TOGGLE : "";
		const skip = width === 0 ? `\x1b[${stageCols + 1}C` : " ".repeat(Math.max(1, stageCols + 1 - width));
		out.push(`${cell}${mark}${skip}${right}`);
	}
	return out;
}
