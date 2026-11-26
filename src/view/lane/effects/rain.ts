/**
 * Rain: slanted streaks that fall in the cells no line, glyph or label uses. It is the picture's weather: with two or
 * more running lanes the heads shed spray into the empty stretch ahead of them, and a thinner shower falls wherever else
 * a gap is free. Streaks are tinted by the nearest running lane and fade out with the distance from the heads.
 */
import { mix } from "../colour.ts";
import { hot, lineColour } from "./colours.ts";
import { type Fx, perceived } from "./fx.ts";
import { clamp, hash, mod } from "./math.ts";
import type { Route } from "./routes.ts";

/** How far ahead of the heads the spray reaches, in dots; the last part of it fades. */
const REACH = 56;
const STREAK = 5;
const ENERGY = 0.95;

export function rain(fx: Fx, routes: readonly Route[]): void {
	const running = routes.filter((r) => r.last === "running" && (fx.scene.rowOf[r.lane] ?? -1) >= 0);
	if (running.length < 2 || !fx.motion || fx.frozen) return;
	const x0 = fx.scene.graph.cx0 * 2;
	const headX = fx.scene.headX;
	const x1 = Math.min(fx.scene.graph.cx1 * 2, Math.max(x0 + 10, headX + REACH));
	const ahead = Math.max(0, x1 - headX);
	// Most of the drops go where there is room: ahead of the heads. The rest try their luck among the lines.
	const spray = Math.min(170, Math.round(running.length * (ahead / 4)));
	const shower = Math.min(40, Math.round(running.length * (Math.max(0, headX - x0) / 24)));
	for (let j = 0; j < spray; j++) drop(fx, running, j, headX, headX + ahead);
	for (let j = 0; j < shower; j++) drop(fx, running, 1000 + j, x0, headX);
}

function drop(fx: Fx, running: readonly Route[], j: number, xa: number, xb: number): void {
	const height = fx.height;
	const range = Math.max(1, xb - xa);
	const fall = 14 + 22 * hash(j + 40);
	const along = mod(hash(j) * (height + 12) + (fx.t / 1000) * fall, height + 12) - 6;
	const slantX = xa + mod(hash(j + 900) * range + (fx.t / 1000) * (fall * 0.45) - along * 0.5, range);
	for (let k = 0; k < STREAK; k++) {
		const dx = Math.round(slantX - k * 0.5);
		const dy = Math.round(along - k);
		if (dx < 0 || dy < 4 || dx >= fx.width || dy >= height) continue;
		if (fx.busy[(dy >> 2) * fx.canvas.cw + (dx >> 1)] === 1) continue;
		const spent = dx > fx.scene.headX ? clamp(1.6 * (1 - (dx - fx.scene.headX) / REACH)) : 1;
		// The leading dot is white-hot, the tail the lane's own hue.
		const colour = k === 0 ? mix(hot(fx, nearestHue(fx, running, dy)), lineColour(fx, nearestHue(fx, running, dy)), 0.35) : lineColour(fx, nearestHue(fx, running, dy) + 10 * k);
		fx.canvas.dot(dx, dy, colour, perceived(Math.min(1.25, (k === 0 ? 1.2 : ENERGY - k * 0.12) * spent) * fx.gain, fx.dark));
	}
}

/** The hue of the running lane whose row is nearest to dot row `y`. */
function nearestHue(fx: Fx, running: readonly Route[], y: number): number {
	let best = running[0]!;
	let bestD = Number.POSITIVE_INFINITY;
	for (const r of running) {
		const d = Math.abs((fx.scene.rowOf[r.lane] ?? 0) * 4 + 1.5 - y);
		if (d < bestD) { bestD = d; best = r; }
	}
	return best.hue;
}
