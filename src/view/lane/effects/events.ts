/**
 * Event effects: things that happen once, tied to a real event of the run. Each one reads how long ago its mark
 * happened (`ageOf`), so it plays out whenever the picture is drawn and is gone for good when it is over.
 *
 * - branch: a lane leaves the trunk.
 * - merge burst: an accepted lane's light climbs into the trunk and flashes it.
 * - lightning: a lane is blocked.
 * - bounce: a lane's result was found not met; light recoils from the hollow circle.
 * - round wipe: a new round starts; a bar of light sweeps the whole view.
 */
import { mix, type Rgb } from "../colour.ts";
import type { Mark } from "../scene.ts";
import { greenOf, HUE_GREEN, HUE_RED, hot, lineColour, redOf } from "./colours.ts";
import { ageOf, dot, type Fx, marksOf } from "./fx.ts";
import { clamp, hash, lerp, smooth, TAU } from "./math.ts";
import { nearest, pulse, type Route, beside } from "./routes.ts";
import { BOUNCE_MS, BRANCH_MS, BURST_MS, LIGHTNING_MS, WIPE_MS } from "./timing.ts";

/** Sparks fly from (x0, y0) for `life` ms; `down` sends them only into the lower half-plane (the trunk is the top row). */
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

// ---------------------------------------------------------------------------------------------------------------
// Branch and merge
// ---------------------------------------------------------------------------------------------------------------

export function branchEffect(fx: Fx, route: Route): void {
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

export function mergeEffect(fx: Fx, route: Route): void {
	const accept = marksOf(fx, "accept", route.lane)[0];
	if (accept === undefined) return;
	const age = ageOf(fx, accept.at);
	if (age > BURST_MS) return;
	const u = age / BURST_MS;
	const jx = accept.cx * 2 + 1;
	const jy = accept.cy * 4 + 1.5;
	const green = greenOf(fx);
	// The lane's light is drawn up into the trunk.
	if (u < 0.45) {
		const head = lerp(route.length - 70, route.length, smooth(u / 0.38));
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
			const e = 1.55 * (1 - w / 18) * (1 - u) ** 0.8;
			const colour = mix(hot(fx, HUE_GREEN), green, clamp(u * 1.8 + w / 30));
			dot(fx, x, 1, colour, e);
			dot(fx, x, 2, colour, e);
			if (w < 7) { dot(fx, x, 0, colour, e * 0.8); dot(fx, x, 3, colour, e * 0.8); }
		}
	}
	// The join itself glows.
	for (let y = 0; y < 4; y++) for (let dx = -2; dx <= 2; dx++) dot(fx, jx + dx, y, hot(fx, HUE_GREEN), 1.6 * (1 - u) ** 0.7);
	// Sparks in the lane's hue, a few in green; the trunk is the top row, so they fly downward only.
	sparks(fx, jx, jy, route.lane * 11 + 5, 16, age, 900, 46, hot(fx, route.hue), lineColour(fx, route.hue), -1, true);
	sparks(fx, jx, jy, route.lane * 13 + 9, 10, age, 800, 34, hot(fx, HUE_GREEN), green, -1, true);
}

// ---------------------------------------------------------------------------------------------------------------
// Lightning
// ---------------------------------------------------------------------------------------------------------------

/** Where in time the two bolts and the thunder ripple sit inside `LIGHTNING_MS`. */
const BOLT_ONE: readonly (readonly [from: number, to: number])[] = [[0, 90], [135, 240]];
const BOLT_TWO: readonly [from: number, to: number] = [275, 500];
const RIPPLE_FROM_MS = 150;
const RIPPLE_REACH = 64;

/**
 * A zigzag of long strokes (about 5 dots tall, 4 to 9 dots sideways): a core two dots thick in `core`, sheathed in
 * `halo`. The halo is what sets it apart from the lane heads, which are a single hue with no sheath.
 */
function bolt(fx: Fx, x0: number, y0: number, x1: number, y1: number, seed: number, core: Rgb, halo: Rgb, energy: number): void {
	const nodes = Math.max(2, Math.round(Math.abs(y1 - y0) / 5));
	let px = x0;
	let py = y0;
	for (let k = 1; k <= nodes; k++) {
		const u = k / nodes;
		const side = k % 2 === 0 ? 1 : -1;
		const nx = k === nodes ? x1 : lerp(x0, x1, u) + side * (4 + 5 * hash(seed * 97 + k));
		const ny = lerp(y0, y1, u);
		const steps = Math.max(1, Math.ceil(Math.max(Math.abs(nx - px), Math.abs(ny - py))));
		for (let n = 0; n <= steps; n++) {
			const x = lerp(px, nx, n / steps);
			const y = lerp(py, ny, n / steps);
			for (const o of [-3, -2, 3, 4]) dot(fx, x + o, y, halo, energy * 0.6);
			dot(fx, x, y, core, energy);
			dot(fx, x + 1, y, core, energy);
		}
		// A short fork now and then.
		if (k < nodes && hash(seed * 31 + k) > 0.4) {
			const fork = k % 2 === 0 ? -1 : 1;
			for (let f = 1; f <= 6; f++) dot(fx, nx + fork * f * 1.3, ny + f * 0.9, core, energy * (1 - f / 7) * 0.9);
		}
		px = nx;
		py = ny;
	}
}

export function lightning(fx: Fx, route: Route): void {
	const mark = marksOf(fx, "blocked", route.lane)[0];
	if (mark === undefined) return;
	const age = ageOf(fx, mark.at);
	if (age > LIGHTNING_MS) return;
	const x = mark.cx * 2 + 1;
	const yc = mark.cy * 4 + 1.5;
	const core = fx.dark ? 0xffffff : hot(fx, HUE_RED);
	const halo = mix(redOf(fx), core, 0.2);
	// Bolt one flickers (on, off, on) and slashes in from far to the left, so it crosses the lane bodies and not the heads.
	if (BOLT_ONE.some(([from, to]) => age >= from && age < to)) bolt(fx, x - 32, 1, x, yc, route.lane * 5 + 1, core, halo, 2);
	else if (age >= BOLT_TWO[0] && age < BOLT_TWO[1]) {
		const u = (age - BOLT_TWO[0]) / (BOLT_TWO[1] - BOLT_TWO[0]);
		bolt(fx, x - 18, 1, x, yc, route.lane * 5 + 2, mix(core, redOf(fx), smooth(u * 1.4)), halo, 1.7 * (1 - 0.5 * u));
	}
	// Thunder: a ripple runs back along the struck lane, white into red.
	if (age > RIPPLE_FROM_MS) {
		const u = (age - RIPPLE_FROM_MS) / (LIGHTNING_MS - RIPPLE_FROM_MS);
		const head = route.length - RIPPLE_REACH * (1 - (1 - u) ** 2);
		pulse(fx, route, head, -1, 24, mix(core, redOf(fx), 0.4), redOf(fx), 1.5 * (1 - u));
	}
	// The cross lights up under the bolt.
	const glow = 1 - age / LIGHTNING_MS;
	for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
		const d = Math.hypot(dx, dy / 1.4);
		if (d < 3.2) dot(fx, x + dx, yc + dy, mix(core, redOf(fx), age / LIGHTNING_MS), 1.4 * glow * (1 - d / 3.4), route.lane, true);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Bounce and round wipe
// ---------------------------------------------------------------------------------------------------------------

export function bounce(fx: Fx, route: Route): void {
	for (const mark of marksOf(fx, "unmet", route.lane)) {
		const age = ageOf(fx, mark.at);
		if (age > BOUNCE_MS) continue;
		const u = age / BOUNCE_MS;
		const at = route.pts[nearest(route, mark)]!;
		// Light recoils from the hollow circle back toward the branch; its tail trails toward the circle.
		const recoil = 1 - (1 - clamp(u / 0.75)) ** 2;
		pulse(fx, route, at.s - 38 * recoil, -1, 20, hot(fx, route.hue), lineColour(fx, route.hue), 1.5 * (1 - 0.6 * u));
		sparks(fx, at.x, at.y, route.lane * 3 + 1, 6, age, 450, 22, hot(fx, route.hue), lineColour(fx, route.hue), route.lane);
	}
}

/** The round wipe: a bar of light sweeps the whole view left to right. Returns true while the tick should not show yet. */
export function roundWipe(fx: Fx, mark: Mark): boolean {
	const age = ageOf(fx, mark.at);
	if (age > WIPE_MS) return false;
	const barX = (age / WIPE_MS) * (fx.width + 20) - 4;
	const colour = hot(fx, 200);
	for (let y = 0; y < fx.height; y++) {
		for (let w = 0; w < 3; w++) dot(fx, barX - w, y, colour, 1.35 - w * 0.2);
		for (let w = 3; w < 16; w++) if ((y + w) % 2 === 0) dot(fx, barX - w, y, lineColour(fx, 205), 0.5 * (1 - w / 16));
	}
	return barX < mark.cx * 2;
}
