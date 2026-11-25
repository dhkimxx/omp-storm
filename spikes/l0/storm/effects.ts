/**
 * The painter of the "storm" variant: every strand, mark and label of a scene, with the colours and effects of the
 * design table (see DESIGN.md for the list and every number).
 *
 * Time. `t` is animation time in ms. Event effects (branch, merge burst, lightning, bounce, round wipe) read how long
 * ago their mark happened from `snapshot.now - mark.at`; continuous effects follow the strand state and the lane's
 * `activity`. In the phases that are still (waiting for the user, between rounds, the settled end of stopping) both
 * clocks are frozen at the moment the phase began, so a picture that stops really stops. With `motion` false nothing
 * is animated: events count as long past, continuous effects are frozen at a fixed, pleasant moment.
 *
 * Energy. Every dot has a colour and an energy (see canvas.ts): 0 is the background, 1 the full colour, above 1 pushes
 * toward white. Brightness therefore says how hard something works; saturation says whether it is alive.
 */
import type { LaneState, Phase } from "../model.ts";
import type { Canvas } from "./canvas.ts";
import { laneHue, mix, oklch, type Rgb } from "./colour.ts";
import type { Label, Mark, MarkKind, Scene, Strand, StrandKind } from "./scene.ts";

// ---------------------------------------------------------------------------------------------------------------
// Numbers (DESIGN.md lists them again, for the product)
// ---------------------------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
/** Hue of the trunk before any lane has been accepted: a cold blue-cyan, the radar's colour. */
const BASE_HUE = 218;
/** The start colour is a pale ice blue, so every accepted lane's hue arrives as a visible colour. */
const BASE_CHROMA = 0.15;
const HUE_GREEN = 152;
const HUE_AMBER = 78;
const HUE_RED = 24;
const CHROMA = 0.2;
/** Lightness of line colours: lighter on a dark terminal, deeper on a light one. */
const LIGHTNESS_DARK = 0.76;
const LIGHTNESS_LIGHT = 0.54;

// Aurora.
const AURORA_WAVELENGTH = 40;
const AURORA_PHASE_STEP = 0.145;
const AURORA_RAMP_DOTS = 18;
const AURORA_ENTER_DELAY_MS = 900;
const AURORA_ENTER_MS = 1100;
const AURORA_SPEED: Record<Phase, number> = {
	working: 17, workers: 5, verifying: 8, "waiting-user": 0, "between-rounds": 0, stopping: 0,
};
const WAVE_LENGTH = 18;
const WAVE_HZ = 0.9;
const WAVE_AMPLITUDE = 1.5;
const WAVE_IN_MS = 500;
const WAVE_OUT_MS = 1200;
const HEAD_SPEED = 28;
const HEAD_TRAIL = 22;
const BREATH_MS = 4200;
const SCAN_PERIOD_MS = 2900;
const SCAN_HALF = 9;
const SCAN_TRUNK_HALF = 12;

// Lanes.
const DRIFT_DEGREES = 26;
const DRIFT_WAVELENGTH = 64;
const FLOW_BASE = 12;
const FLOW_ACTIVITY = 34;
const COMET_TAIL = 18;
const COMET_GAP = 30;
const COMET_BASE = 24;
const COMET_ACTIVITY = 44;

// Events.
const BRANCH_MS = 600;
const BURST_MS = 1300;
const LIGHTNING_MS = 500;
const BOUNCE_MS = 600;
const WIPE_MS = 800;
const FINALE_MS = 2000;
const LIGHTS_OUT_MS = 4000;
const FREEZE_DRAIN_MS = 500;
const FREEZE_DRAIN = 0.85;
const BLOCK_PULSE_MS = 2400;
const DIM_WAIT = 0.55;
/** The animation time a still picture is frozen at: comets and bands sit somewhere flattering. */
const STILL_T = 2300;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const smooth = (u: number): number => {
	const c = clamp(u);
	return c * c * (3 - 2 * c);
};
const mod = (a: number, n: number): number => ((a % n) + n) % n;
const hueMod = (h: number): number => mod(h, 360);

function hash(n: number): number {
	let h = Math.imul(Math.floor(n) + 0x9e3779b9, 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function pingPong(t: number): number {
	const u = mod(t, SCAN_PERIOD_MS) / SCAN_PERIOD_MS;
	return u < 0.5 ? u * 2 : 2 - u * 2;
}

/** A phase accumulator for a speed that changes over time: position += speed * dt, keyed so lanes stay independent. */
const accumulators = new Map<string, { ph: number; at: number }>();
function accumulate(key: string, t: number, speed: number): number {
	const found = accumulators.get(key);
	if (found === undefined) {
		const fresh = { ph: (t * speed) / 1000, at: t };
		accumulators.set(key, fresh);
		return fresh.ph;
	}
	const dt = t - found.at;
	if (dt > 0 && dt < 500) found.ph += (speed * dt) / 1000;
	found.at = t;
	return found.ph;
}

// ---------------------------------------------------------------------------------------------------------------
// The painting context
// ---------------------------------------------------------------------------------------------------------------

interface Route {
	lane: number;
	hue: number;
	/** Dense points in the direction of time, `s` the distance travelled. */
	pts: Pt[];
	length: number;
	last: LaneState;
	activity: number;
}

interface Pt {
	x: number;
	y: number;
	s: number;
	at: number;
	state: LaneState;
	/** The lane runs steeply here: thickness goes sideways instead of up and down. */
	steep: boolean;
	/** Which stretch of the lane's path this point is on. */
	kind: StrandKind;
}

interface Fx {
	scene: Scene;
	canvas: Canvas;
	motion: boolean;
	dark: boolean;
	bg: Rgb;
	/** Animation time, frozen in still phases. */
	t: number;
	/** Run time as the effects see it, frozen like `t`. */
	now: number;
	phase: Phase;
	age: number;
	finale: boolean;
	lightsOut: boolean;
	gain: number;
	width: number;
	height: number;
	busy: Uint8Array;
	hues: number[];
	last: LaneState[];
	marks: Map<string, Mark[]>;
	/** Distance the aurora bands have flowed. */
	shift: number;
	entries: AuroraEntry[];
	rows: number;
}

interface AuroraEntry { hue: number; chroma: number; x: number; at: number; phase: number }

function isStill(phase: Phase): boolean {
	return phase === "waiting-user" || phase === "between-rounds";
}

function makeFx(scene: Scene, canvas: Canvas, t: number, motion: boolean): Fx {
	const snap = scene.snapshot;
	const phase = scene.phase;
	const age = motion ? scene.phaseAge : 0;
	const finale = phase === "stopping" && snap.counts.inScope > 0 && snap.counts.accepted >= snap.counts.inScope;
	const lightsOut = phase === "stopping" && !finale;
	let animT = motion ? t : STILL_T;
	let now = snap.now;
	if (motion) {
		let frozen = 0;
		if (isStill(phase)) frozen = scene.phaseAge;
		else if (phase === "stopping") frozen = Math.max(0, scene.phaseAge - (finale ? FINALE_MS : LIGHTS_OUT_MS));
		animT -= frozen;
		now -= frozen;
	}
	const lanes = snap.lanes;
	const marks = new Map<string, Mark[]>();
	for (const mark of scene.marks) {
		const key = `${mark.kind}:${mark.lane}`;
		const list = marks.get(key);
		if (list === undefined) marks.set(key, [mark]);
		else list.push(mark);
	}
	const fx: Fx = {
		scene, canvas, motion, dark: canvas.look.dark, bg: canvas.look.background, t: animT, now, phase, age, finale, lightsOut,
		gain: phase === "between-rounds" ? lerp(1, DIM_WAIT, motion ? smooth(age / 400) : 1) : 1,
		width: canvas.cw * 2, height: canvas.ch * 4, busy: new Uint8Array(canvas.cw * canvas.ch),
		hues: lanes.map((_, i) => laneHue(i)),
		last: lanes.map((lane) => lane.spans[lane.spans.length - 1]?.state ?? "reserved"),
		marks, shift: 0, entries: [], rows: Math.max(1, ...scene.rowOf),
	};
	fx.shift = auroraShift(fx);
	fx.entries = auroraEntries(fx);
	return fx;
}

/** Seconds ago an event at run time `at` happened; infinite when it has not happened yet or `motion` is off. */
function ageOf(fx: Fx, at: number): number {
	if (!fx.motion) return Infinity;
	const a = fx.now - at;
	return a < 0 ? Infinity : a;
}

function marksOf(fx: Fx, kind: MarkKind, lane: number): readonly Mark[] {
	return fx.marks.get(`${kind}:${lane}`) ?? [];
}

// ---------------------------------------------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------------------------------------------

/** A line colour of the given hue: equal lightness for every hue, so the rainbow is even. */
function lineColour(fx: Fx, hue: number, chroma = CHROMA): Rgb {
	return oklch(fx.dark ? LIGHTNESS_DARK : LIGHTNESS_LIGHT, chroma, hueMod(hue));
}

/** Readable text of a hue: lighter than a line on a dark terminal, darker on a light one. */
function textColour(fx: Fx, hue: number, chroma = 0.13): Rgb {
	return oklch(fx.dark ? 0.84 : 0.42, chroma, hueMod(hue));
}

/** The "white" of flashes: white on a dark terminal, a deep saturated tone of the hue on a light one. */
function hot(fx: Fx, hue: number): Rgb {
	return fx.dark ? mix(lineColour(fx, hue), 0xffffff, 0.8) : oklch(0.34, 0.19, hueMod(hue));
}

const white = (fx: Fx): Rgb => (fx.dark ? 0xffffff : 0x14161a);
const greyOf = (fx: Fx): Rgb => (fx.dark ? 0x8d939c : 0x7a7f86);
// The three colours with a fixed meaning carry their own lightness: a deep red reads as danger, a bright amber as a call.
const greenOf = (fx: Fx): Rgb => oklch(fx.dark ? 0.8 : 0.56, 0.2, HUE_GREEN);
const amberOf = (fx: Fx): Rgb => oklch(fx.dark ? 0.84 : 0.68, 0.17, HUE_AMBER);
const redOf = (fx: Fx): Rgb => oklch(fx.dark ? 0.66 : 0.54, 0.225, HUE_RED);
const textGrey = (fx: Fx): Rgb => mix(fx.bg, fx.dark ? 0xffffff : 0x000000, fx.dark ? 0.58 : 0.7);

/** How dark the lights-out has made a place: 1 untouched, near 0 gone. `lane` -1 is the trunk. */
function darkness(fx: Fx, x: number, lane: number): number {
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

/** The canvas blends with energy ** 1.8; my energies are meant as perceived brightness, so undo that curve. */
const perceived = (e: number, dark = true): number => (e <= 1 ? e ** (dark ? 0.55 : 0.42) : e);

/** Places one dot; energy is scaled by the dim wait and the lights-out. `keep` is for red marks that survive both. */
function dot(fx: Fx, x: number, y: number, colour: Rgb, energy: number, lane = -1, keep = false): void {
	const dx = Math.round(x);
	const dy = Math.round(y);
	if (dx < 0 || dy < 0 || dx >= fx.width || dy >= fx.height) return;
	let e = energy * fx.gain;
	const d = darkness(fx, dx, lane);
	e *= keep ? Math.max(d, 0.9) : d;
	if (e < 0.04) return;
	fx.busy[(dy >> 2) * fx.canvas.cw + (dx >> 1)] = 1;
	fx.canvas.dot(dx, dy, colour, perceived(e, fx.dark));
}

/** Text with the same dimming rules, one call per character when `gradient` gives colours. */
function text(fx: Fx, cx: number, cy: number, str: string, colour: Rgb, energy = 1, bold = false): number {
	let e = energy;
	if (fx.lightsOut && fx.motion) e *= 1 - 0.45 * smooth(fx.age / 3000);
	e *= fx.phase === "between-rounds" ? lerp(1, 0.75, smooth(fx.age / 400)) : 1;
	fx.busy[cy * fx.canvas.cw + cx] = 1;
	return fx.canvas.text(cx, cy, str, colour, e, bold);
}

// ---------------------------------------------------------------------------------------------------------------
// Aurora
// ---------------------------------------------------------------------------------------------------------------

/** How far the bands have flowed: the integral of the phase's speed over the run, frozen with the picture. */
function auroraShift(fx: Fx): number {
	if (!fx.motion) return STILL_T * 0.012;
	let total = 0;
	for (const span of fx.scene.snapshot.phases) {
		const end = Math.min(span.to ?? fx.now, fx.now);
		if (end > span.from) total += (AURORA_SPEED[span.phase] * (end - span.from)) / 1000;
	}
	return total;
}

function auroraEntries(fx: Fx): AuroraEntry[] {
	const entries: AuroraEntry[] = [{ hue: BASE_HUE, chroma: BASE_CHROMA, x: -1e9, at: -1e9, phase: 0 }];
	const joins = fx.scene.marks.filter((m) => m.kind === "accept").sort((a, b) => a.at - b.at);
	for (const mark of joins) {
		entries.push({ hue: fx.hues[mark.lane] ?? BASE_HUE, chroma: 0.27, x: mark.cx * 2 + 1, at: mark.at, phase: entries.length * AURORA_PHASE_STEP });
	}
	return entries;
}

/** Colour and energy of the trunk at dot column `x`: the bands of every hue accepted to the left of it, flowing right. */
function aurora(fx: Fx, x: number): { colour: Rgb; energy: number } {
	let sx = 0;
	let sy = 0;
	let total = 0;
	let chroma = 0;
	let peak = 0;
	fx.entries.forEach((entry, i) => {
		const space = i === 0 ? Math.max(0.35, 1 - 0.12 * (fx.entries.length - 1)) : smooth((x - entry.x) / AURORA_RAMP_DOTS);
		const time = i === 0 || !fx.motion ? 1 : smooth((fx.now - entry.at - AURORA_ENTER_DELAY_MS) / AURORA_ENTER_MS);
		const w = space * time;
		if (w <= 0) return;
		const b = 0.5 + 0.5 * Math.cos(TAU * ((x - fx.shift) / AURORA_WAVELENGTH - entry.phase));
		const weight = w * (b ** 3 + (i === 0 ? 0.03 : 0));
		const rad = (entry.hue * Math.PI) / 180;
		sx += Math.cos(rad) * weight * entry.chroma;
		sy += Math.sin(rad) * weight * entry.chroma;
		chroma += weight * entry.chroma;
		total += weight;
		peak = Math.max(peak, w * b);
	});
	const hue = (Math.atan2(sy, sx) * 180) / Math.PI;
	return { colour: lineColour(fx, hue, total > 0 ? chroma / total : BASE_CHROMA), energy: 0.8 + 0.34 * peak };
}

// ---------------------------------------------------------------------------------------------------------------
// Routes: the dense path of each lane
// ---------------------------------------------------------------------------------------------------------------

/** Steps between points until neighbouring dots touch. */
function densify(points: readonly { x: number; y: number; at: number }[]): { x: number; y: number; at: number }[] {
	const out: { x: number; y: number; at: number }[] = [];
	points.forEach((p, i) => {
		const prev = points[i - 1];
		if (prev === undefined) {
			out.push({ x: Math.round(p.x), y: Math.round(p.y), at: p.at });
			return;
		}
		const steps = Math.max(Math.abs(p.x - prev.x), Math.abs(p.y - prev.y), 1);
		for (let k = 1; k <= Math.ceil(steps); k++) {
			const u = k / Math.ceil(steps);
			const x = Math.round(lerp(prev.x, p.x, u));
			const y = Math.round(lerp(prev.y, p.y, u));
			const last = out[out.length - 1];
			if (last === undefined || last.x !== x || last.y !== y) out.push({ x, y, at: lerp(prev.at, p.at, u) });
		}
	});
	return out;
}

const KIND_ORDER: Record<string, number> = { stem: 0, lane: 1, join: 2 };

function buildRoutes(fx: Fx): Route[] {
	const { scene } = fx;
	const byLane = new Map<number, Strand[]>();
	for (const strand of scene.strands) {
		if (strand.lane < 0 || !(strand.kind in KIND_ORDER)) continue;
		const list = byLane.get(strand.lane);
		if (list === undefined) byLane.set(strand.lane, [strand]);
		else list.push(strand);
	}
	const routes: Route[] = [];
	for (const [lane, strands] of byLane) {
		strands.sort((a, b) => (KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]!) || a.from - b.from);
		const pts: Pt[] = [];
		let s = 0;
		for (const strand of strands) {
			const state: LaneState = strand.state ?? "running";
			for (const p of densify(strand.points)) {
				const prev = pts[pts.length - 1];
				if (prev !== undefined) s += Math.hypot(p.x - prev.x, p.y - prev.y);
				pts.push({ x: p.x, y: p.y, s, at: p.at, state, steep: false, kind: strand.kind });
			}
		}
		pts.forEach((p, i) => {
			const a = pts[Math.max(0, i - 2)]!;
			const b = pts[Math.min(pts.length - 1, i + 2)]!;
			p.steep = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
		});
		if (pts.length === 0) continue;
		routes.push({
			lane, hue: fx.hues[lane] ?? 0, pts, length: s, last: fx.last[lane] ?? "running",
			activity: scene.snapshot.lanes[lane]?.activity ?? 0.5,
		});
	}
	return routes;
}

/** Puts a dot beside a route point; `o` steps sideways along the normal. */
function beside(fx: Fx, p: Pt, o: number, colour: Rgb, energy: number, lane: number, keep = false): void {
	if (p.steep) dot(fx, p.x + o, p.y, colour, energy, lane, keep);
	else dot(fx, p.x, p.y + o, colour, energy, lane, keep);
}

// ---------------------------------------------------------------------------------------------------------------
// Trunk
// ---------------------------------------------------------------------------------------------------------------

function trunkAmplitude(fx: Fx): number {
	const phases = fx.scene.snapshot.phases;
	const before = phases[phases.length - 2]?.phase;
	if (!fx.motion) return fx.phase === "working" ? WAVE_AMPLITUDE : 0;
	if (fx.phase === "working") return WAVE_AMPLITUDE * smooth(fx.age / WAVE_IN_MS);
	if (fx.phase === "workers" && before === "working") return WAVE_AMPLITUDE * (1 - smooth(fx.age / WAVE_OUT_MS));
	return 0;
}

function drawTrunk(fx: Fx): void {
	const { scene } = fx;
	const trunk = scene.strands.filter((s) => s.kind === "trunk").flatMap((s) => densify(s.points));
	const xs = trunk.length > 0 ? trunk.map((p) => p.x) : [0];
	const x0 = Math.min(...xs);
	const x1 = Math.min(scene.headX, Math.max(...xs));
	const amp = trunkAmplitude(fx);
	const head = fx.motion ? mod((fx.t / 1000) * HEAD_SPEED, x1 + 12) : x1 * 0.62;
	const breath = fx.motion ? 0.5 + 0.5 * Math.sin((fx.t / BREATH_MS) * TAU) : 0.7;
	const scanCentre = (fx.motion ? pingPong(fx.t) : 0.45) * (x1 - x0) + x0;
	const lightWorking = fx.phase === "working";
	let prevTop = -1;
	for (let x = x0; x <= x1; x++) {
		const { colour: base, energy: baseEnergy } = aurora(fx, x);
		let colour = base;
		let energy = baseEnergy;
		let top = 1;
		let extra = 0;
		if (amp > 0.01) {
			const yw = 1.5 + amp * Math.sin(TAU * (x / WAVE_LENGTH - (fx.t / 1000) * WAVE_HZ));
			top = clamp(Math.round(yw - 0.5), 0, 2);
		} else top = 0;
		switch (fx.phase) {
			case "working": {
				const behind = head - x;
				if (behind >= 0 && behind < 3) { colour = hot(fx, 220); energy = 1.5; extra = 1; }
				else if (behind >= 0 && behind < HEAD_TRAIL) { energy = lerp(1.05, baseEnergy, behind / HEAD_TRAIL); extra = behind < 9 ? 1 : 0; }
				else if (behind < 0 && behind > -6) { energy = lerp(baseEnergy, 0.95, 1 + behind / 6); }
				break;
			}
			case "workers": {
				energy = baseEnergy * (0.78 + 0.34 * breath);
				extra = breath > 0.85 ? 1 : 0;
				break;
			}
			case "verifying": {
				const d = Math.abs(x - scanCentre);
				energy = baseEnergy * 0.7;
				if (d < SCAN_TRUNK_HALF) {
					const v = 1 - d / SCAN_TRUNK_HALF;
					colour = mix(greenOf(fx), hot(fx, HUE_GREEN), v * v);
					energy = 0.7 + 0.75 * v;
					extra = v > 0.35 ? 1 : 0;
				}
				break;
			}
			case "waiting-user": energy = baseEnergy * 0.8; break;
			case "between-rounds": energy = baseEnergy * 0.85; break;
			default: energy = baseEnergy * 0.9;
		}
		if (fx.phase === "stopping" && fx.finale) {
			const front = (fx.age / 1400) * (x1 + 70);
			const d = front - x;
			if (d >= 0 && d < 70) {
				const strength = 1 - d / 70;
				colour = lineColour(fx, hueMod((x / Math.max(1, x1)) * 330 + 20 + fx.age * 0.04), 0.27);
				energy = Math.max(energy, 0.55 + 0.75 * strength);
				extra = 1;
			}
		}
		const rows = [top, top + 1];
		// Calm phases are three dots thick (rows 0..2) so the bands show; the rolling wave is two thick.
		if (amp < 0.6) rows.push(top + 2);
		if (extra > 0) rows.push(top - 1, top + 2, top + 3);
		if (prevTop >= 0 && prevTop !== top) {
			for (let y = Math.min(prevTop, top); y <= Math.max(prevTop, top) + 1; y++) if (!rows.includes(y)) rows.push(y);
		}
		for (const y of rows) dot(fx, x, y, colour, y >= top && y <= top + 2 ? energy : energy * 0.75);
		prevTop = top;
	}
	// A shimmer: a second, thinner wave in the opposite direction while working.
	if (lightWorking && fx.motion) {
		for (let x = x0; x <= x1; x += 2) {
			const y2 = Math.round(1.5 + 1.5 * Math.sin(TAU * (x / 11 + (fx.t / 1000) * 0.55) + 1.3));
			const a = aurora(fx, x + 14);
			dot(fx, x, y2, a.colour, 0.3);
		}
	}
	// Time still to come: a faint dotted ruler.
	for (const strand of scene.strands) {
		if (strand.kind !== "future") continue;
		densify(strand.points).forEach((p, i) => { if (i % 4 === 0) dot(fx, p.x, p.y, greyOf(fx), 0.22); });
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------------------------------------------

function drawRoute(fx: Fx, route: Route): void {
	const { lane, pts, hue } = route;
	const last = route.last;
	const settled = last === "accepted";
	const accept = marksOf(fx, "accept", lane)[0];
	const acceptAge = accept === undefined ? Infinity : ageOf(fx, accept.at);
	const drain = settled ? (fx.motion ? smooth((acceptAge - 500) / 1300) : 1) : last === "excluded" ? 1 : 0;
	const blocked = marksOf(fx, "blocked", lane)[0];
	const blockAge = blocked === undefined ? Infinity : ageOf(fx, blocked.at);
	const redness = last === "blocked" ? (fx.motion ? smooth(blockAge / LIGHTNING_MS) : 1) : 0;
	const act = route.activity;
	const flowSpeed = FLOW_BASE + FLOW_ACTIVITY * act;
	const flow = fx.motion ? accumulate(`drift:${lane}`, fx.t, flowSpeed) : lane * 0.37 + 0.3;
	const scan = (fx.motion ? pingPong(fx.t) : 0.5) * route.length;
	const base = lineColour(fx, hue);
	const flashRow = finaleFlash(fx, lane);
	const sorted = pts;
	const lastIndex = sorted.length - 1;
	const quietBreath = 0.5 + 0.5 * Math.sin((fx.t / 3400) * TAU);

	sorted.forEach((p, i) => {
		const state = p.state;
		let colour = lineColour(fx, hue + DRIFT_DEGREES * Math.sin(TAU * (p.s / DRIFT_WAVELENGTH - flow / 4)));
		let energy = 0.55;
		let offs: readonly number[] = [0];
		let visible = true;
		switch (state) {
			case "reserved": visible = i % 4 === 0; colour = base; energy = 0.55; break;
			case "waiting": visible = i % 6 === 0; colour = mix(base, greyOf(fx), 0.6); energy = 0.34; break;
			case "running": energy = 0.8 + 0.3 * act; offs = [-1, 0, 1]; break;
			case "quiet": {
				colour = mix(base, greyOf(fx), 0.25);
				energy = 0.5;
				offs = [0, 1];
				if (i >= lastIndex - 9 && fx.motion) { energy = 0.5 + 0.6 * quietBreath; if (quietBreath > 0.55) offs = [-1, 0, 1, 2]; }
				break;
			}
			case "submitted": offs = [-1, 1]; colour = mix(base, white(fx), 0.25); energy = 0.75; break;
			case "reviewing": {
				offs = [-1, 1];
				colour = base;
				energy = 0.68;
				const d = Math.abs(p.s - scan);
				{
					const v = clamp(1 - d / SCAN_HALF);
					if (v > 0) { colour = mix(greenOf(fx), hot(fx, HUE_GREEN), v * v); energy = 0.5 + 0.9 * v; offs = v > 0.3 ? [-1, 0, 1] : offs; }
				}
				break;
			}
			case "unmet": visible = i % 2 === 0; colour = mix(base, white(fx), 0.3); energy = 0.7; break;
			case "idle": colour = mix(base, greyOf(fx), 0.7); energy = 0.3; break;
			case "excluded": visible = i % 3 === 0; colour = greyOf(fx); energy = 0.34; break;
			case "blocked": colour = base; energy = 0.6; offs = [0, 1]; break;
			case "accepted": energy = 0.7; offs = [0, 1]; break;
			default: break;
		}
		if (last === "excluded") { visible = i % 3 === 0; colour = greyOf(fx); energy = 0.34; offs = [0]; }
		// Stems and joins are the graph's own lines: one clear thin line in the lane's hue, as bright as the lane itself.
		if (p.kind === "stem" || p.kind === "join") {
			visible = true;
			colour = last === "excluded" ? mix(base, greyOf(fx), 0.6) : base;
			energy = last === "excluded" ? 0.5 : p.kind === "join" ? 0.8 : 0.9;
			offs = [0];
		}
		if (!visible) return;
		if (drain > 0 && p.kind !== "join") {
			// A finished lane keeps a pale tint of its own hue instead of going grey.
			colour = mix(colour, lineColour(fx, hue, 0.075), 0.8 * drain);
			energy = lerp(energy, Math.min(energy, p.kind === "lane" ? 0.46 : 0.6), drain);
		}
		if (redness > 0) { colour = mix(colour, redOf(fx), 0.85 * redness); energy = lerp(energy, 0.5, redness); }
		if (flashRow > 0) { colour = mix(colour, hot(fx, hue), flashRow * 0.8); energy += 0.9 * flashRow; }
		const keep = last === "blocked" && redness > 0.9;
		for (const o of offs) beside(fx, p, o, colour, energy, lane, keep);
	});

	if (route.last === "running" || route.last === "quiet") drawComets(fx, route, flowSpeed);
	if (route.last === "running" || route.last === "reviewing" || route.last === "submitted") headGlow(fx, route);
}

/** The head of an open lane: a small bright pulse where the work is happening now. */
function headGlow(fx: Fx, route: Route): void {
	const p = route.pts[route.pts.length - 1]!;
	const pulse = fx.motion ? 0.5 + 0.5 * Math.sin((fx.t / 520) * TAU + route.lane) : 0.7;
	const colour = route.last === "reviewing" ? greenOf(fx) : hot(fx, route.hue);
	const e = (route.last === "running" ? 0.7 + 0.5 * route.activity : 0.6) * (0.75 + 0.25 * pulse);
	beside(fx, p, 0, colour, e, route.lane);
	beside(fx, p, 1, colour, e * 0.8, route.lane);
	beside(fx, p, -1, colour, e * 0.8, route.lane);
}

/** Bright fat lumps that leave the branch point and run to the head with a fading tail; more of them with activity. */
function drawComets(fx: Fx, route: Route, flowSpeed: number): void {
	if (route.last !== "running") return;
	const pts = route.pts;
	let k = pts.length - 1;
	while (k > 0 && pts[k - 1]!.state === "running") k--;
	const s0 = pts[k]!.s;
	const run = route.length - s0;
	if (run < 4) return;
	const count = 1 + Math.floor(clamp(route.activity) * 2.99);
	const speed = COMET_BASE + COMET_ACTIVITY * route.activity;
	const ph = fx.motion ? accumulate(`comet:${route.lane}`, fx.t, speed) : 0.55 * (run + COMET_GAP);
	const cycle = run + COMET_GAP;
	void flowSpeed;
	for (let c = 0; c < count; c++) {
		const head = s0 + mod(ph + (c * cycle) / count, cycle);
		for (let i = k; i < pts.length; i++) {
			const p = pts[i]!;
			const d = head - p.s;
			if (d < 0 || d > COMET_TAIL) continue;
			const u = d / COMET_TAIL;
			const hueHere = route.hue + DRIFT_DEGREES * Math.sin(TAU * (p.s / DRIFT_WAVELENGTH));
			const colour = mix(mix(hot(fx, hueHere), lineColour(fx, hueHere), 0.35), lineColour(fx, hueHere), smooth(u * 1.8));
			const energy = 1.2 * (1 - u) ** 1.5 + 0.35;
			const width = d < 3 ? 1 : d < 8 ? 1 : 0;
			for (let o = -width; o <= width; o++) beside(fx, p, o, colour, o === 0 ? energy : energy * 0.7, route.lane);
		}
	}
}

/** A route pulse with a tail: `dir` 1 has the tail behind (lower s), -1 ahead. */
function pulse(fx: Fx, route: Route, head: number, dir: 1 | -1, tail: number, from: Rgb, to: Rgb, energy: number): void {
	for (const p of route.pts) {
		const d = (head - p.s) * dir;
		if (d < -1 || d > tail) continue;
		const u = clamp(d / tail);
		const e = energy * (1 - u) ** 1.4;
		const colour = mix(from, to, smooth(u * 1.6));
		for (let o = -1; o <= 1; o++) beside(fx, p, o, colour, o === 0 ? e : e * 0.6, route.lane);
	}
}

function nearest(route: Route, mark: Mark): number {
	const x = mark.cx * 2 + 1;
	const y = mark.cy * 4 + 1.5;
	let best = 0;
	let bestD = Infinity;
	route.pts.forEach((p, i) => {
		const d = (p.x - x) ** 2 + (p.y - y) ** 2;
		if (d < bestD) { bestD = d; best = i; }
	});
	return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Event effects
// ---------------------------------------------------------------------------------------------------------------

function sparks(fx: Fx, x0: number, y0: number, seed: number, count: number, tau: number, life: number, speed: number, a: Rgb, b: Rgb, lane = -1, down = false): void {
	if (tau < 0 || tau > life) return;
	const u = tau / life;
	const sec = tau / 1000;
	for (let k = 0; k < count; k++) {
		const angle = hash(seed * 131 + k) * (down ? Math.PI : TAU);
		const sp = speed * (0.35 + 0.65 * hash(seed * 17 + k));
		const x = x0 + Math.cos(angle) * sp * sec;
		const y = y0 + Math.sin(angle) * sp * sec * 0.55 + 14 * sec * sec;
		dot(fx, x, y, mix(a, b, smooth(u * 1.4)), 1.35 * (1 - u) ** 1.2, lane);
	}
}

function branchEffect(fx: Fx, route: Route): void {
	const start = marksOf(fx, "start", route.lane).at(-1);
	if (start === undefined) return;
	const age = ageOf(fx, start.at);
	if (age > BRANCH_MS) return;
	const u = age / BRANCH_MS;
	// The route as far as the lane has grown: a bright spark at its tip, the new curve thick and white-hot.
	const grown = route.pts.filter((p) => p.at >= start.at - 80);
	if (grown.length === 0) return;
	const reveal = Math.max(8, Math.ceil(grown.length * Math.min(1, 0.35 + u)));
	const tip = grown[Math.min(grown.length - 1, reveal - 1)]!;
	grown.slice(0, reveal).forEach((p, i) => {
		const near = clamp(1 - (reveal - i) / 14);
		const colour = mix(lineColour(fx, route.hue), hot(fx, route.hue), 0.4 + 0.6 * near);
		const e = (0.5 + 0.9 * near) * (1 - 0.5 * u);
		beside(fx, p, 0, colour, e, route.lane);
		if (near > 0.3) { beside(fx, p, -1, colour, e * 0.7, route.lane); beside(fx, p, 1, colour, e * 0.7, route.lane); }
	});
	sparks(fx, tip.x, tip.y, route.lane * 7 + 3, 7, age, BRANCH_MS, 26, hot(fx, route.hue), lineColour(fx, route.hue), route.lane);
}

function mergeEffect(fx: Fx, route: Route): void {
	const accept = marksOf(fx, "accept", route.lane)[0];
	if (accept === undefined) return;
	const age = ageOf(fx, accept.at);
	if (age > BURST_MS) return;
	const u = age / BURST_MS;
	const jx = accept.cx * 2 + 1;
	const jy = accept.cy * 4 + 1.5;
	const lane = route.lane;
	const green = greenOf(fx);
	// The lane's light is drawn up into the trunk.
	const rise = smooth(u / 0.38);
	if (u < 0.45) {
		const head = lerp(route.length - 70, route.length, rise);
		pulse(fx, route, head, 1, 46, hot(fx, route.hue), lineColour(fx, route.hue), 1.5);
	}
	// A white flash spreads both ways along the trunk, then turns green and fades.
	const front = smooth(u / 0.9) * 80;
	for (const side of [-1, 1]) {
		for (let w = 0; w < 18; w++) {
			const d = front - w;
			if (d < 1) continue;
			const x = jx + side * d;
			if (x < fx.scene.graph.cx0 * 2 || x >= fx.scene.graph.cx1 * 2) continue;
			const strength = (1 - w / 18) * (1 - u) ** 0.8;
			const colour = mix(hot(fx, HUE_GREEN), green, clamp(u * 1.8 + w / 30));
			const e = 1.55 * strength;
			dot(fx, x, 1, colour, e);
			dot(fx, x, 2, colour, e);
			if (w < 7) { dot(fx, x, 0, colour, e * 0.8); dot(fx, x, 3, colour, e * 0.8); }
		}
	}
	// The join itself glows.
	for (let y = 0; y < 4; y++) for (let dx = -2; dx <= 2; dx++) dot(fx, jx + dx, y, hot(fx, HUE_GREEN), 1.6 * (1 - u) ** 0.7);
	// Sparks in the lane's hue above and below the join, a few in green.
	sparks(fx, jx, jy, lane * 11 + 5, 16, age, 900, 46, hot(fx, route.hue), lineColour(fx, route.hue), -1, true);
	sparks(fx, jx, jy, lane * 13 + 9, 10, age, 800, 34, hot(fx, HUE_GREEN), green, -1, true);
}

function bolt(fx: Fx, x0: number, y0: number, x1: number, y1: number, seed: number, colour: Rgb, energy: number): void {
	// A zigzag of a few long strokes (about 5 dots tall, up to 7 dots sideways), two dots thick with a dim halo, so it
	// reads as a bolt and not as a noisy column next to the lane heads.
	const nodes = Math.max(2, Math.round(Math.abs(y1 - y0) / 5));
	let px = x0;
	let py = y0;
	for (let k = 1; k <= nodes; k++) {
		const u = k / nodes;
		const side = k % 2 === 0 ? 1 : -1;
		const nx = k === nodes ? x1 : lerp(x0, x1, u) + side * (4 + 4 * hash(seed * 97 + k));
		const ny = lerp(y0, y1, u);
		const steps = Math.max(1, Math.ceil(Math.max(Math.abs(nx - px), Math.abs(ny - py))));
		for (let n = 0; n <= steps; n++) {
			const x = lerp(px, nx, n / steps);
			const y = lerp(py, ny, n / steps);
			dot(fx, x, y, colour, energy);
			dot(fx, x + 1, y, colour, energy);
			dot(fx, x - 1.5, y, colour, energy * 0.4);
			dot(fx, x + 2.5, y, colour, energy * 0.4);
		}
		// A short fork now and then.
		if (k < nodes && hash(seed * 31 + k) > 0.45) {
			const fork = k % 2 === 0 ? -1 : 1;
			for (let f = 1; f <= 5; f++) dot(fx, nx + fork * f * 1.2, ny + f * 0.8, colour, energy * (1 - f / 6) * 0.9);
		}
		px = nx;
		py = ny;
	}
}

function lightning(fx: Fx, lane: number): void {
	const mark = marksOf(fx, "blocked", lane)[0];
	if (mark === undefined) return;
	const age = ageOf(fx, mark.at);
	if (age > LIGHTNING_MS) return;
	const x = mark.cx * 2 + 1;
	const yc = mark.cy * 4 + 1.5;
	if (age < 170) bolt(fx, x - 22, 2, x, yc, lane * 5 + 1, hot(fx, HUE_RED), 1.8);
	else if (age > 230 && age < 460) {
		const u = (age - 230) / 230;
		bolt(fx, x - 14, 2, x, yc, lane * 5 + 2, mix(hot(fx, HUE_RED), redOf(fx), smooth(u * 1.4)), 1.5 * (1 - 0.5 * u));
	}
	// The cross lights up under the bolt.
	for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
		const d = Math.hypot(dx, dy / 1.4);
		if (d < 3.2) dot(fx, x + dx, yc + dy, mix(hot(fx, HUE_RED), redOf(fx), age / LIGHTNING_MS), 1.3 * (1 - age / LIGHTNING_MS) * (1 - d / 3.4), lane, true);
	}
}

function bounce(fx: Fx, route: Route): void {
	for (const mark of marksOf(fx, "unmet", route.lane)) {
		const age = ageOf(fx, mark.at);
		if (age > BOUNCE_MS) continue;
		const u = age / BOUNCE_MS;
		const at = route.pts[nearest(route, mark)]!;
		// Light recoils from the hollow circle back toward the branch; its tail trails toward the circle.
		const recoil = 1 - (1 - clamp(u / 0.75)) ** 2;
		const head = at.s - 38 * recoil;
		pulse(fx, route, head, -1, 20, hot(fx, route.hue), lineColour(fx, route.hue), 1.5 * (1 - 0.6 * u));
		sparks(fx, at.x, at.y, route.lane * 3 + 1, 6, age, 450, 22, hot(fx, route.hue), lineColour(fx, route.hue), route.lane);
	}
}

/** The round wipe: a bar of light sweeps the whole view left to right. Returns true while the tick should not show yet. */
function roundWipe(fx: Fx, mark: Mark): boolean {
	const age = ageOf(fx, mark.at);
	if (age > WIPE_MS) return false;
	const u = age / WIPE_MS;
	const barX = u * (fx.width + 20) - 4;
	const colour = hot(fx, 200);
	for (let y = 0; y < fx.height; y++) {
		for (let w = 0; w < 3; w++) dot(fx, barX - w, y, colour, 1.35 - w * 0.2);
		for (let w = 3; w < 16; w++) if ((y + w) % 2 === 0) dot(fx, barX - w, y, lineColour(fx, 205), 0.5 * (1 - w / 16));
	}
	return barX < mark.cx * 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Rain
// ---------------------------------------------------------------------------------------------------------------

function rain(fx: Fx, routes: readonly Route[]): void {
	const running = routes.filter((r) => r.last === "running" && (fx.scene.rowOf[r.lane] ?? -1) >= 0);
	if (running.length < 2 || !fx.motion) return;
	const x0 = fx.scene.graph.cx0 * 2;
	const x1 = Math.max(x0 + 10, fx.scene.headX + 26);
	const range = x1 - x0;
	const height = fx.height;
	const count = Math.min(110, Math.round(running.length * (range / 9)));
	for (let j = 0; j < count; j++) {
		const fall = 9 + 16 * hash(j + 40);
		const along = mod(hash(j) * (height + 10) + (fx.t / 1000) * fall, height + 10) - 5;
		const slantX = x0 + mod(hash(j + 900) * range + (fx.t / 1000) * (fall * 0.45) - along * 0.5, range);
		for (let k = 0; k < 3; k++) {
			const y = along - k;
			const x = slantX - k * 0.5;
			const dx = Math.round(x);
			const dy = Math.round(y);
			if (dx < 0 || dy < 4 || dx >= fx.width || dy >= height) continue;
			if (fx.busy[(dy >> 2) * fx.canvas.cw + (dx >> 1)] === 1) continue;
			// Tinted by the nearest running lane.
			let best = running[0]!;
			let bestD = Infinity;
			for (const r of running) {
				const d = Math.abs((fx.scene.rowOf[r.lane] ?? 0) * 4 + 1.5 - y);
				if (d < bestD) { bestD = d; best = r; }
			}
			const spent = clamp(1 - (dx - fx.scene.headX) / 26);
				fx.canvas.dot(dx, dy, lineColour(fx, best.hue + 10 * k), perceived((0.62 - k * 0.14) * spent * fx.gain, fx.dark));
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Finale
// ---------------------------------------------------------------------------------------------------------------

/** 0..1: how strongly a lane flashes in the finale; the lanes flash top to bottom. */
function finaleFlash(fx: Fx, lane: number): number {
	if (!fx.finale || !fx.motion) return 0;
	const row = fx.scene.rowOf[lane] ?? -1;
	if (row < 1) return 0;
	const at = 500 + (row - 1) * 170;
	const u = (fx.age - at) / 380;
	return u < 0 || u > 1 ? 0 : Math.sin(u * Math.PI);
}

// ---------------------------------------------------------------------------------------------------------------
// Glyph marks
// ---------------------------------------------------------------------------------------------------------------

function drawMarks(fx: Fx, routes: readonly Route[]): void {
	const { scene } = fx;
	const jobFill = new Map<number, number>();
	for (const route of routes) {
		const lane = scene.snapshot.lanes[route.lane];
		if (lane?.job !== true) continue;
		const count = scene.marks.filter((m) => m.kind === "job" && m.lane === route.lane).length;
		jobFill.set(route.lane, route.last === "running" && fx.motion ? Math.floor(fx.t / 420) % (count + 1) : -1);
	}
	const jobSeen = new Map<number, number>();
	const ordered = [...scene.marks].sort((a, b) => a.cx - b.cx);
	for (const mark of ordered) {
		const hue = mark.lane >= 0 ? (fx.hues[mark.lane] ?? 0) : BASE_HUE;
		const age = ageOf(fx, mark.at);
		switch (mark.kind) {
			case "accept": {
				const flashing = age < BURST_MS;
				const colour = flashing ? mix(hot(fx, HUE_GREEN), greenOf(fx), smooth((age - 150) / 700)) : greenOf(fx);
				text(fx, mark.cx, mark.cy, "●", colour, flashing ? 1.4 : 0.95, true);
				break;
			}
			case "unmet": {
				const colour = age < BOUNCE_MS ? hot(fx, hue) : mix(lineColour(fx, hue), white(fx), 0.3);
				text(fx, mark.cx, mark.cy, "○", colour, 1, true);
				break;
			}
			case "blocked": {
				const colour = age < 200 ? hot(fx, HUE_RED) : redOf(fx);
				const dark = fx.lightsOut && fx.motion;
				text(fx, mark.cx, mark.cy, "✕", colour, dark ? 0.95 : 1, true);
				break;
			}
			case "excluded": text(fx, mark.cx, mark.cy, "⊘", greyOf(fx), 0.6); break;
			case "review": {
				const v = fx.motion ? 0.5 + 0.5 * Math.sin((fx.t / SCAN_PERIOD_MS) * TAU * 2) : 0.8;
				text(fx, mark.cx, mark.cy, "◆", mix(greenOf(fx), hot(fx, HUE_GREEN), v * 0.7), 0.9 + 0.4 * v, true);
				break;
			}
			case "job": {
				const n = jobSeen.get(mark.lane) ?? 0;
				jobSeen.set(mark.lane, n + 1);
				const fill = jobFill.get(mark.lane) ?? -1;
				const full = fill >= 0 ? n < fill : mark.done === true;
				const final = fx.last[mark.lane] === "accepted";
				const colour = final ? mix(lineColour(fx, hue), greyOf(fx), 0.7) : lineColour(fx, hue);
				text(fx, mark.cx, mark.cy, full ? "■" : "□", colour, final ? 0.45 : 0.95, full && !final);
				break;
			}
			default: break;
		}
	}
}

function drawRoundTicks(fx: Fx): void {
	const wiping = new Set<Mark>();
	for (const mark of fx.scene.marks) if (mark.kind === "round" && roundWipe(fx, mark)) wiping.add(mark);
	const rounds = fx.scene.marks.filter((m) => m.kind === "round");
	const newest = Math.max(...rounds.map((m) => m.at), -1);
	for (const mark of rounds) {
		if (wiping.has(mark)) continue;
		const latest = mark.at === newest;
		const age = ageOf(fx, mark.at);
		const stamped = age < WIPE_MS + 260;
		const colour = latest ? (stamped ? hot(fx, 200) : lineColour(fx, 205)) : mix(lineColour(fx, 215), greyOf(fx), 0.6);
		const energy = latest ? (stamped ? 1.5 : 1) : 0.5;
		for (let y = 0; y < 4; y++) dot(fx, mark.cx * 2, y, colour, energy);
		text(fx, mark.cx + 1, mark.cy, String(mark.round ?? ""), colour, latest ? 1 : 0.65, latest);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------------

const ROLE_WORDS = ["탐색", "구현", "검토", "빠른", "설계"];
const PHASE_HUE: Record<Phase, number | null> = {
	working: null, workers: null, verifying: HUE_GREEN, "waiting-user": HUE_AMBER, "between-rounds": null, stopping: null,
};

/** Text coloured char by char from the aurora, for the trunk's own labels. */
function auroraText(fx: Fx, label: Label, bold: boolean, energy: number): void {
	let cx = label.cx;
	for (const char of label.text) {
		const a = aurora(fx, (cx - fx.scene.graph.cx0) * 2 + fx.scene.headX * 0.5);
		const colour = fx.dark ? mix(a.colour, 0xffffff, 0.12) : mix(a.colour, 0x000000, 0.3);
		cx += text(fx, cx, label.cy, char, colour, energy, bold);
	}
}

function stateStyle(fx: Fx, lane: number, state: LaneState): { colour: Rgb; energy: number; bold: boolean } {
	const hue = fx.hues[lane] ?? 0;
	switch (state) {
		case "running": return { colour: textColour(fx, hue, 0.15), energy: 1, bold: true };
		case "quiet": return { colour: textColour(fx, hue, 0.08), energy: 0.8, bold: false };
		case "submitted": return { colour: textColour(fx, hue, 0.05), energy: 0.95, bold: false };
		case "reviewing": return { colour: textColour(fx, HUE_GREEN, 0.16), energy: 1, bold: true };
		case "accepted": return { colour: textColour(fx, HUE_GREEN, 0.1), energy: 0.85, bold: false };
		case "unmet": return { colour: textColour(fx, hue, 0.1), energy: 1, bold: true };
		case "blocked": return { colour: textColour(fx, HUE_RED, 0.18), energy: 1, bold: true };
		default: return { colour: textGrey(fx), energy: 0.8, bold: false };
	}
}

function drawLabels(fx: Fx): void {
	const { scene } = fx;
	for (const label of scene.labels) {
		const lane = label.lane;
		if (label.side === "scale") {
			text(fx, label.cx, label.cy, label.text, textGrey(fx), 0.8);
			continue;
		}
		if (lane < 0 && label.cy === 0) {
			// The trunk row: the director and the phase word, in aurora colours while the picture moves.
			if (label.side === "left") {
				auroraText(fx, label, true, 1);
			} else {
				const hue = PHASE_HUE[fx.phase];
				if (hue !== null) text(fx, label.cx, label.cy, label.text, textColour(fx, hue, 0.16), 1, true);
				else if (fx.phase === "working" || fx.phase === "workers") auroraText(fx, label, true, 1);
				else text(fx, label.cx, label.cy, label.text, textGrey(fx), 0.9, true);
			}
			continue;
		}
		if (lane < 0) {
			text(fx, label.cx, label.cy, label.text, textGrey(fx), 0.8);
			continue;
		}
		const state = fx.last[lane] ?? "idle";
		const hue = fx.hues[lane] ?? 0;
		if (label.side === "left") {
			const final = state === "accepted" || state === "excluded";
			const split = label.text.lastIndexOf(" ");
			const roleWord = split >= 0 ? label.text.slice(split + 1) : "";
			const name = ROLE_WORDS.includes(roleWord) ? label.text.slice(0, split) : label.text;
			const colour = final ? mix(textColour(fx, hue, 0.13), textGrey(fx), fx.dark ? 0.4 : 0.2) : textColour(fx, hue, state === "waiting" || state === "idle" ? 0.07 : 0.14);
			const used = text(fx, label.cx, label.cy, name, colour, final ? 0.9 : 1, !final && state === "running");
			if (name !== label.text) text(fx, label.cx + used, label.cy, ` ${roleWord}`, mix(colour, textGrey(fx), 0.3), 0.9);
		} else {
			const style = stateStyle(fx, lane, state);
			text(fx, label.cx, label.cy, label.text, style.colour, style.energy, style.bold);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting for the user
// ---------------------------------------------------------------------------------------------------------------

function freeze(fx: Fx): void {
	const amount = FREEZE_DRAIN * (fx.motion ? smooth(fx.age / FREEZE_DRAIN_MS) : 1);
	fx.canvas.drain(amount);
	const mark = fx.scene.marks.find((m) => m.kind === "trunk-head");
	const cx = mark?.cx ?? Math.max(0, Math.round(fx.scene.headX / 2) - 1);
	const cy = mark?.cy ?? 0;
	const pulseV = fx.motion ? 0.5 + 0.5 * Math.sin((fx.t / BLOCK_PULSE_MS) * TAU) : 0.8;
	const amber = amberOf(fx);
	// The glow before the block, then the block itself; this alone is not drained.
	for (let k = 1; k <= 3; k++) {
		const e = (0.35 + 0.55 * pulseV) * (1 - k / 4);
		for (let y = 0; y < 4; y++) fx.canvas.dot((cx - k) * 2 + 1, cy * 4 + y, amber, e);
	}
	fx.canvas.text(cx, cy, "█", amber, 0.6 + 0.4 * pulseV, true);
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

export function paint(scene: Scene, canvas: Canvas, t: number, motion: boolean): void {
	const fx = makeFx(scene, canvas, t, motion);
	drawTrunk(fx);
	const routes = buildRoutes(fx);
	// Settled lanes first so live ones stay on top where cells are shared.
	const order = [...routes].sort((a, b) => Number(b.last === "accepted" || b.last === "excluded") - Number(a.last === "accepted" || a.last === "excluded"));
	for (const route of order) {
		if ((scene.rowOf[route.lane] ?? -1) < 0) continue;
		drawRoute(fx, route);
	}
	for (const strand of scene.strands) {
		if (strand.kind !== "link") continue;
		const lane = strand.lane;
		densify(strand.points).forEach((p, i) => { if (i % 3 === 0) dot(fx, p.x, p.y, mix(lineColour(fx, fx.hues[lane] ?? 0), greyOf(fx), 0.6), 0.28, lane); });
	}
	for (const route of order) {
		if ((scene.rowOf[route.lane] ?? -1) < 0) continue;
		branchEffect(fx, route);
		mergeEffect(fx, route);
		bounce(fx, route);
		lightning(fx, route.lane);
	}
	drawRoundTicks(fx);
	drawMarks(fx, routes);
	for (const label of scene.labels) for (let i = 0; i < label.width; i++) fx.busy[label.cy * canvas.cw + label.cx + i] = 1;
	rain(fx, routes);
	drawLabels(fx);
	if (fx.phase === "waiting-user") freeze(fx);
}
