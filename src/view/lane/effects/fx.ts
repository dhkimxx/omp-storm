/**
 * The painting context: everything one `paint` call needs, derived once from the scene, plus the two primitives
 * (`dot`, `text`) that apply the dimming rules of the moment (waiting between rounds, lights out, a lightning strike).
 *
 * Time. `t` is animation time in ms and `now` the run time the effects see. Event effects read how long ago their
 * mark happened from `now - mark.at`; continuous effects follow the lane state and `activity`. In the phases that stop
 * (see `settleMs`) both clocks run until the phase has settled and then stand still at that moment, derived from the
 * snapshot alone, so a picture that stops really stops: it does not depend on `t` any more. With `motion` false
 * nothing is animated: events count as long past and continuous effects sit at a fixed, flattering moment.
 *
 * Energy. Every dot has a colour and an energy (see canvas.ts): 0 is the background, 1 the full colour, above 1 pushes
 * toward white. Brightness therefore says how hard something works; saturation says whether it is alive.
 */
import type { RunPhase } from "../../appearance.ts";
import type { Canvas } from "../canvas.ts";
import { laneHue, type Rgb } from "../colour.ts";
import type { LaneState } from "../model.ts";
import type { Mark, MarkKind, Scene } from "../scene.ts";
import { lerp, smooth } from "./math.ts";
import { DIM_WAIT_MS, settleMs } from "./timing.ts";
import type { Tint } from "./colours.ts";

/** The animation time a still picture is frozen at: comets and bands sit somewhere flattering. */
export const STILL_T = 2300;
const DIM_WAIT = 0.55;
/** How long a strike dims the lanes around it. */
export const STRIKE_DIM_MS = 260;

export interface AuroraEntry { hue: number; chroma: number; x: number; at: number; phase: number }
/** A fresh lightning strike: the lanes near it dim for a moment so the bolt stands out from the bright heads. */
export interface Strike { x: number; lane: number; strength: number }

export interface Fx extends Tint {
	scene: Scene;
	canvas: Canvas;
	motion: boolean;
	/** Animation time, standing still once the phase has settled. */
	t: number;
	/** The time the caller passed: it keeps running, for the one thing that pulses while everything else is frozen. */
	liveT: number;
	/** Run time as the effects see it, standing still like `t`. */
	now: number;
	phase: RunPhase;
	/** Milliseconds into the phase, not beyond the moment it settles. */
	age: number;
	/** The clocks have stopped. */
	frozen: boolean;
	finale: boolean;
	lightsOut: boolean;
	gain: number;
	/** Canvas size in dots. */
	width: number;
	height: number;
	/** One flag per cell: a line, glyph or label is there, so rain keeps out. */
	busy: Uint8Array;
	hues: number[];
	last: LaneState[];
	marks: Map<string, Mark[]>;
	strikes: Strike[];
	/** Distance the aurora bands have flowed, and the bands themselves (set by `startAurora`). */
	shift: number;
	entries: AuroraEntry[];
	/** Highest canvas row that holds a lane. */
	rows: number;
}

export function makeFx(scene: Scene, canvas: Canvas, t: number, motion: boolean): Fx {
	const snap = scene.snapshot;
	const phase = scene.phase;
	const finale = phase === "stopping" && snap.complete;
	const lightsOut = phase === "stopping" && !snap.complete;
	const limit = settleMs(phase, snap.complete);
	const frozen = motion && scene.phaseAge >= limit;
	const age = motion ? Math.min(scene.phaseAge, limit) : 0;
	// The frozen clocks are the run time the phase settled at: the same for every call, whatever `t` is.
	const settledAt = snap.now - scene.phaseAge + limit;
	const now = frozen ? settledAt : snap.now;
	const animT = !motion ? STILL_T : frozen ? settledAt : t;
	const marks = new Map<string, Mark[]>();
	for (const mark of scene.marks) {
		const key = `${mark.kind}:${mark.lane}`;
		const list = marks.get(key);
		if (list === undefined) marks.set(key, [mark]);
		else list.push(mark);
	}
	const lanes = snap.lanes;
	const fx: Fx = {
		scene, canvas, motion, dark: canvas.look.dark, bg: canvas.look.background, t: animT, liveT: motion ? t : STILL_T, now, phase, age,
		frozen, finale, lightsOut,
		gain: phase === "between-rounds" ? lerp(1, DIM_WAIT, motion ? smooth(age / DIM_WAIT_MS) : 1) : 1,
		width: canvas.cw * 2, height: canvas.ch * 4, busy: new Uint8Array(canvas.cw * canvas.ch),
		hues: lanes.map((lane, i) => laneHue(lane.slot ?? i)),
		last: lanes.map((lane) => lane.spans[lane.spans.length - 1]?.state ?? "reserved"),
		marks, strikes: [], shift: 0, entries: [], rows: Math.max(1, ...scene.rowOf),
	};
	fx.strikes = strikesOf(fx);
	return fx;
}

/** Milliseconds ago an event at run time `at` happened; infinite when it has not happened yet or `motion` is off. */
export function ageOf(fx: Fx, at: number): number {
	if (!fx.motion) return Number.POSITIVE_INFINITY;
	const a = fx.now - at;
	return a < 0 ? Number.POSITIVE_INFINITY : a;
}

export function marksOf(fx: Fx, kind: MarkKind, lane: number): readonly Mark[] {
	return fx.marks.get(`${kind}:${lane}`) ?? [];
}

// ---------------------------------------------------------------------------------------------------------------
// Dimming rules
// ---------------------------------------------------------------------------------------------------------------

function strikesOf(fx: Fx): Strike[] {
	const out: Strike[] = [];
	for (const mark of fx.scene.marks) {
		if (mark.kind !== "blocked") continue;
		const age = ageOf(fx, mark.at);
		if (age < STRIKE_DIM_MS) out.push({ x: mark.cx * 2 + 1, lane: mark.lane, strength: 1 - smooth(age / STRIKE_DIM_MS) * 0.6 });
	}
	return out;
}

/** How dark the lights-out has made a place: 1 untouched, near 0 gone. `lane` -1 is the trunk. */
export function darkness(fx: Fx, x: number, lane: number): number {
	if (!fx.lightsOut || !fx.motion) return 1;
	const front = (fx.age / 3200) * (fx.width + 28);
	let m = 0.04 + 0.96 * smooth((x - (front - 16)) / 16);
	if (lane >= 0) {
		const row = fx.scene.rowOf[lane] ?? 1;
		const when = 500 + ((Math.max(1, row) - 1) / Math.max(1, fx.rows - 1)) * 2600;
		m = Math.min(m, 1 - 0.96 * smooth((fx.age - when) / 500));
	}
	return m;
}

/** Lanes near a fresh strike dim, so the bolt is the brightest thing in the picture. */
function lull(fx: Fx, x: number, lane: number): number {
	let m = 1;
	for (const strike of fx.strikes) {
		if (strike.lane === lane || x < strike.x - 44 || x > strike.x + 16) continue;
		m = Math.min(m, 1 - 0.55 * strike.strength);
	}
	return m;
}

/** The canvas blends with energy ** 1.8; the energies here are meant as perceived brightness, so undo that curve. */
export const perceived = (e: number, dark = true): number => (e <= 1 ? e ** (dark ? 0.55 : 0.42) : e);

/**
 * Places one dot. Energy is scaled by the dim wait, the lights-out and, for a lane's own dots, a strike nearby.
 * `keep` is for red marks that survive the dimming.
 */
export function dot(fx: Fx, x: number, y: number, colour: Rgb, energy: number, lane = -1, keep = false): void {
	const dx = Math.round(x);
	const dy = Math.round(y);
	if (dx < 0 || dy < 0 || dx >= fx.width || dy >= fx.height) return;
	let e = energy * fx.gain;
	const d = darkness(fx, dx, lane);
	e *= keep ? Math.max(d, 0.9) : d;
	if (lane >= 0 && !keep && fx.strikes.length > 0) e *= lull(fx, dx, lane);
	if (e < 0.04) return;
	fx.busy[(dy >> 2) * fx.canvas.cw + (dx >> 1)] = 1;
	fx.canvas.dot(dx, dy, colour, perceived(e, fx.dark));
}

/** Text with the same dimming rules. */
export function text(fx: Fx, cx: number, cy: number, str: string, colour: Rgb, energy = 1, bold = false): number {
	let e = energy;
	if (fx.lightsOut && fx.motion) e *= 1 - 0.45 * smooth(fx.age / 3000);
	e *= fx.phase === "between-rounds" ? lerp(1, 0.75, smooth(fx.age / DIM_WAIT_MS)) : 1;
	if (cy >= 0 && cy < fx.canvas.ch && cx >= 0 && cx < fx.canvas.cw) fx.busy[cy * fx.canvas.cw + cx] = 1;
	return fx.canvas.text(cx, cy, str, colour, e, bold);
}
