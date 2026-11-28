/**
 * The stage's art, behind one interface: every individual plays a sequence `<species>/<actor>/<name>` and asks it for the
 * frame at a time. Both tiers are straight-alpha RGBA, so overlapping sprites, weather and background composite in one
 * pixel space (B0): a T1 frame at `T1_CELL_PX` per cell, a T2 frame at half-block resolution (one pixel per half cell;
 * the T2 renderer emits `▀` with the top pixel as foreground and the bottom as background). The T3 braille stage
 * samples the T1 frame at dot resolution. The scene decides who stands where and which sequence plays; the art only
 * says how it looks.
 *
 * The art is the baked sheets in `assets/stage/` (`baked.ts`); a sequence that is not baked draws nothing.
 *
 * Colour: art is grey with coverage in alpha; brightness is energy. The renderer tints it with the individual's colour
 * (the lane's colour, the director's ice blue), so one sequence serves every lane.
 */
import type { Species } from "./cast.ts";

export type StageActor = "director" | "worker" | "fx";
/** `<species>/<actor>/<name>`. */
export type SequenceId = `${Species}/${StageActor}/${string}`;
export type StageTier = "t1" | "t2";

/** T1 pixels of one terminal cell, whatever cell size the terminal reports (it scales the image). */
export const T1_CELL_PX = { w: 9, h: 18 } as const;

export interface SequenceMeta {
	durationMs: number;
	loop: boolean;
	/** In T1 pixels. */
	size: { w: number; h: number };
	/** The pixel that sits on the individual's position. */
	anchor: { x: number; y: number };
}
export interface T1Frame { tier: "t1"; w: number; h: number; rgba: Uint8ClampedArray }
/** One pixel per half cell: `w` columns by `h` half rows (`h` = rows * 2). */
export interface T2Frame { tier: "t2"; w: number; h: number; rgba: Uint8ClampedArray }
export type StageFrame = T1Frame | T2Frame;

export interface StageAssets {
	meta(id: SequenceId): SequenceMeta | undefined;
	/** Grey plus alpha: brightness is energy, the renderer tints it with the individual's colour. */
	frame(id: SequenceId, tMs: number, tier: StageTier): StageFrame | undefined;
	/** The parts drawn in the state's fixed meaning colour (eyes, a rim), when the sequence has them. */
	accent?(id: SequenceId, tMs: number, tier: StageTier): StageFrame | undefined;
}

export function sequenceId(species: Species, actor: StageActor, name: string): SequenceId {
	return `${species}/${actor}/${name}`;
}

