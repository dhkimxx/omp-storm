/**
 * A lane's line: its colour flows along the path with the worker's activity, comets run along a running stretch, and
 * every state has its own shape (dotted, double rail, thin, solid) so colour is never the only signal.
 */
import { mix } from "../colour.ts";
import {
	greenOf, greyOf, HUE_GREEN, hot, lineColour, redOf, white,
} from "./colours.ts";
import { finaleFlash } from "./ending.ts";
import { ageOf, type Fx, marksOf } from "./fx.ts";
import { accumulate, clamp, lerp, mod, pingPong, smooth, TAU } from "./math.ts";
import { beside, type Route } from "./routes.ts";
import { LIGHTNING_MS } from "./timing.ts";

const DRIFT_DEGREES = 26;
const DRIFT_WAVELENGTH = 64;
const FLOW_BASE = 12;
const FLOW_ACTIVITY = 34;
const COMET_TAIL = 18;
const COMET_GAP = 30;
const COMET_BASE = 24;
const COMET_ACTIVITY = 44;
const SCAN_HALF = 9;
/** Dots of a quiet lane's open end that breathe. */
const QUIET_BREATH_DOTS = 9;

export function drawRoute(fx: Fx, route: Route): void {
	const { lane, pts, hue } = route;
	const last = route.last;
	const settled = last === "accepted";
	const accept = marksOf(fx, "accept", lane)[0];
	const acceptAge = accept === undefined ? Number.POSITIVE_INFINITY : ageOf(fx, accept.at);
	const drain = settled ? (fx.motion ? smooth((acceptAge - 500) / 1300) : 1) : last === "excluded" ? 1 : 0;
	const blocked = marksOf(fx, "blocked", lane)[0];
	const blockAge = blocked === undefined ? Number.POSITIVE_INFINITY : ageOf(fx, blocked.at);
	const redness = last === "blocked" ? (fx.motion ? smooth(blockAge / (LIGHTNING_MS * 0.85)) : 1) : 0;
	const act = route.activity;
	const flowSpeed = FLOW_BASE + FLOW_ACTIVITY * act;
	const flow = fx.motion ? accumulate(`drift:${fx.scene.snapshot.lanes[lane]?.name ?? lane}`, fx.t, flowSpeed) : lane * 0.37 + 0.3;
	const scan = (fx.motion ? pingPong(fx.t) : 0.5) * route.length;
	const base = lineColour(fx, hue);
	const flashRow = finaleFlash(fx, lane);
	const lastIndex = pts.length - 1;
	const quietBreath = 0.5 + 0.5 * Math.sin((fx.t / 3400) * TAU);

	pts.forEach((p, i) => {
		let colour = lineColour(fx, hue + DRIFT_DEGREES * Math.sin(TAU * (p.s / DRIFT_WAVELENGTH - flow / 4)));
		let energy = 0.55;
		let offs: readonly number[] = [0];
		let visible = true;
		switch (p.state) {
			case "reserved": visible = i % 4 === 0; colour = base; energy = 0.55; break;
			case "waiting": visible = i % 6 === 0; colour = mix(base, greyOf(fx), 0.6); energy = 0.34; break;
			case "running": energy = 0.8 + 0.3 * act; offs = [-1, 0, 1]; break;
			case "quiet":
				colour = mix(base, greyOf(fx), 0.25);
				energy = 0.5;
				offs = [0, 1];
				if (i >= lastIndex - QUIET_BREATH_DOTS && fx.motion) { energy = 0.5 + 0.6 * quietBreath; if (quietBreath > 0.55) offs = [-1, 0, 1, 2]; }
				break;
			case "submitted": offs = [-1, 1]; colour = mix(base, white(fx), 0.25); energy = 0.75; break;
			case "reviewing": {
				offs = [-1, 1];
				colour = base;
				energy = 0.68;
				const v = clamp(1 - Math.abs(p.s - scan) / SCAN_HALF);
				if (v > 0) { colour = mix(greenOf(fx), hot(fx, HUE_GREEN), v * v); energy = 0.5 + 0.9 * v; if (v > 0.3) offs = [-1, 0, 1]; }
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

	if (last === "running") drawComets(fx, route);
	if (last === "running" || last === "reviewing" || last === "submitted") headGlow(fx, route);
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
function drawComets(fx: Fx, route: Route): void {
	const pts = route.pts;
	let k = pts.length - 1;
	while (k > 0 && pts[k - 1]!.state === "running") k--;
	const s0 = pts[k]!.s;
	const run = route.length - s0;
	if (run < 4) return;
	const count = 1 + Math.floor(clamp(route.activity) * 2.99);
	const speed = COMET_BASE + COMET_ACTIVITY * route.activity;
	const name = fx.scene.snapshot.lanes[route.lane]?.name ?? route.lane;
	const ph = fx.motion ? accumulate(`comet:${name}`, fx.t, speed) : 0.55 * (run + COMET_GAP);
	const cycle = run + COMET_GAP;
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
			const width = d < 8 ? 1 : 0;
			for (let o = -width; o <= width; o++) beside(fx, p, o, colour, o === 0 ? energy : energy * 0.7, route.lane);
		}
	}
}
