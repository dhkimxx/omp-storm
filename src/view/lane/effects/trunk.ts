/**
 * The trunk: the director's line across the top. Its colour is the aurora (a band per accepted lane, flowing right),
 * its shape follows the phase (rolling wave while the director works, a calm breathing line while workers work, a green
 * scan while verifying) and the end of a run paints it with a full rainbow.
 */
import type { RunPhase } from "../../appearance.ts";
import { HUE_GREEN, mix, type Rgb } from "../colour.ts";
import { BASE_CHROMA, BASE_HUE, greenOf, greyOf, hot, lineColour } from "./colours.ts";
import { densify } from "./routes.ts";
import { dot, type Fx, type AuroraEntry, STILL_T } from "./fx.ts";
import { clamp, lerp, mod, pingPong, smooth, TAU } from "./math.ts";
import { FINALE_MS } from "./timing.ts";

const AURORA_WAVELENGTH = 40;
const AURORA_PHASE_STEP = 0.145;
const AURORA_RAMP_DOTS = 18;
const AURORA_ENTER_DELAY_MS = 900;
const AURORA_ENTER_MS = 1100;
/** A band reaches a little to the left of its join too, fading over this many dots, so the settled trunk is not bare there. */
const AURORA_LEAK = 0.45;
const AURORA_LEAK_REACH = 60;
const AURORA_SPEED: Record<RunPhase, number> = {
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
const SCAN_TRUNK_HALF = 12;
const FINALE_FRONT_MS = 1400;
const FINALE_WIDTH = 70;

// ---------------------------------------------------------------------------------------------------------------
// Aurora
// ---------------------------------------------------------------------------------------------------------------

/** Sets how far the bands have flowed and which bands exist, from the run so far. */
export function startAurora(fx: Fx): void {
	fx.shift = auroraShift(fx);
	fx.entries = auroraEntries(fx);
}

/** The integral of the phase's speed over the run, frozen with the picture. */
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

/** Colour and energy of the trunk at dot column `x`: the bands of every hue accepted near it, flowing right. */
export function aurora(fx: Fx, x: number): { colour: Rgb; energy: number } {
	let sx = 0;
	let sy = 0;
	let total = 0;
	let chroma = 0;
	let peak = 0;
	fx.entries.forEach((entry, i) => {
		const dx = x - entry.x;
		const space = i === 0
			? Math.max(0.35, 1 - 0.12 * (fx.entries.length - 1))
			: Math.max(smooth(dx / AURORA_RAMP_DOTS), AURORA_LEAK * Math.exp(Math.min(0, dx) / AURORA_LEAK_REACH));
		// A lane accepted after the clocks stopped is simply there; otherwise its band enters after the burst.
		const entered = i === 0 || !fx.motion || (fx.frozen && entry.at > fx.now);
		const time = entered ? 1 : smooth((fx.now - entry.at - AURORA_ENTER_DELAY_MS) / AURORA_ENTER_MS);
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
// The trunk line
// ---------------------------------------------------------------------------------------------------------------

function trunkAmplitude(fx: Fx): number {
	const phases = fx.scene.snapshot.phases;
	const before = phases[phases.length - 2]?.phase;
	if (!fx.motion) return fx.phase === "working" ? WAVE_AMPLITUDE : 0;
	if (fx.phase === "working") return WAVE_AMPLITUDE * smooth(fx.age / WAVE_IN_MS);
	if (fx.phase === "workers" && before === "working") return WAVE_AMPLITUDE * (1 - smooth(fx.age / WAVE_OUT_MS));
	return 0;
}

/** Position along the trunk as a rainbow: every hue once, the same for every call once the finale has settled. */
function rainbow(fx: Fx, x: number, x0: number, x1: number): Rgb {
	const drift = 0.04 * (fx.motion ? Math.min(fx.age, FINALE_MS) : FINALE_MS);
	return lineColour(fx, ((x - x0) / Math.max(1, x1 - x0)) * 330 + 20 + drift, 0.27);
}

export function drawTrunk(fx: Fx): void {
	const { scene } = fx;
	const trunk = scene.strands.filter((s) => s.kind === "trunk").flatMap((s) => densify(s.points));
	let x0 = Number.POSITIVE_INFINITY;
	let xMax = 0;
	for (const p of trunk) { x0 = Math.min(x0, p.x); xMax = Math.max(xMax, p.x); }
	if (trunk.length === 0) x0 = 0;
	const x1 = Math.min(scene.headX, xMax);
	const amp = trunkAmplitude(fx);
	const head = fx.motion ? mod((fx.t / 1000) * HEAD_SPEED, x1 + 12) : x1 * 0.62;
	const breath = fx.motion ? 0.5 + 0.5 * Math.sin((fx.t / BREATH_MS) * TAU) : 0.7;
	const scanCentre = (fx.motion ? pingPong(fx.t) : 0.45) * (x1 - x0) + x0;
	let prevTop = -1;
	for (let x = x0; x <= x1; x++) {
		const { colour: base, energy: baseEnergy } = aurora(fx, x);
		let colour = base;
		let energy = baseEnergy;
		let extra = 0;
		const top = amp > 0.01 ? clamp(Math.round(1.5 + amp * Math.sin(TAU * (x / WAVE_LENGTH - (fx.t / 1000) * WAVE_HZ)) - 0.5), 0, 2) : 0;
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
		if (fx.finale) {
			// A bright rainbow front runs the trunk once and leaves the rainbow behind it.
			const front = fx.motion ? (fx.age / FINALE_FRONT_MS) * (x1 + FINALE_WIDTH) : Number.POSITIVE_INFINITY;
			const d = front - x;
			if (d >= 0) {
				const strength = d < FINALE_WIDTH ? 1 - d / FINALE_WIDTH : 0;
				colour = rainbow(fx, x, x0, x1);
				energy = Math.max(energy, 0.95 + 0.6 * strength);
				extra = strength > 0.15 ? 1 : 0;
			}
		}
		const rows = [top, top + 1];
		// Calm phases are three dots thick (rows 0..2) so the bands show; the rolling wave is two thick.
		if (amp < 0.6 || fx.finale) rows.push(top + 2);
		if (extra > 0) rows.push(top - 1, top + 2, top + 3);
		if (prevTop >= 0 && prevTop !== top) {
			for (let y = Math.min(prevTop, top); y <= Math.max(prevTop, top) + 1; y++) if (!rows.includes(y)) rows.push(y);
		}
		for (const y of rows) dot(fx, x, y, colour, y >= top && y <= top + 2 ? energy : energy * 0.75);
		prevTop = top;
	}
	// A shimmer: a second, thinner wave in the opposite direction while the director works.
	if (fx.phase === "working" && fx.motion) {
		for (let x = x0; x <= x1; x += 2) {
			const y2 = Math.round(1.5 + 1.5 * Math.sin(TAU * (x / 11 + (fx.t / 1000) * 0.55) + 1.3));
			dot(fx, x, y2, aurora(fx, x + 14).colour, 0.3);
		}
	}
	// Time still to come: a faint dotted ruler.
	for (const strand of scene.strands) {
		if (strand.kind !== "future") continue;
		densify(strand.points).forEach((p, i) => { if (i % 4 === 0) dot(fx, p.x, p.y, greyOf(fx), 0.22); });
	}
}
