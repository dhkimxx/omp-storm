/**
 * Routes: a lane's whole path (stem, row, join) as one dense list of dots in the direction of time, with the distance
 * travelled, so an effect can run along it.
 */
import type { Fx } from "./fx.ts";
import { dot } from "./fx.ts";
import { clamp, lerp, smooth } from "./math.ts";
import { mix, type Rgb } from "../colour.ts";
import type { LaneState } from "../model.ts";
import type { Mark, Strand, StrandKind } from "../scene.ts";

export interface Pt {
	x: number;
	y: number;
	/** Distance travelled along the route. */
	s: number;
	at: number;
	state: LaneState;
	/** The lane runs steeply here: thickness goes sideways instead of up and down. */
	steep: boolean;
	/** Which stretch of the lane's path this point is on. */
	kind: StrandKind;
}

export interface Route {
	lane: number;
	hue: number;
	pts: Pt[];
	length: number;
	last: LaneState;
	activity: number;
}

interface Raw { x: number; y: number; at: number }

/** Steps between points until neighbouring dots touch. */
export function densify(points: readonly Raw[]): Raw[] {
	const out: Raw[] = [];
	points.forEach((p, i) => {
		const prev = points[i - 1];
		if (prev === undefined) {
			out.push({ x: Math.round(p.x), y: Math.round(p.y), at: p.at });
			return;
		}
		const steps = Math.ceil(Math.max(Math.abs(p.x - prev.x), Math.abs(p.y - prev.y), 1));
		for (let k = 1; k <= steps; k++) {
			const u = k / steps;
			const x = Math.round(lerp(prev.x, p.x, u));
			const y = Math.round(lerp(prev.y, p.y, u));
			const last = out[out.length - 1];
			if (last === undefined || last.x !== x || last.y !== y) out.push({ x, y, at: lerp(prev.at, p.at, u) });
		}
	});
	return out;
}

const KIND_ORDER: Partial<Record<StrandKind, number>> = { stem: 0, lane: 1, join: 2 };

export function buildRoutes(fx: Fx): Route[] {
	const byLane = new Map<number, Strand[]>();
	for (const strand of fx.scene.strands) {
		if (strand.lane < 0 || KIND_ORDER[strand.kind] === undefined) continue;
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
		if (pts.length === 0) continue;
		pts.forEach((p, i) => {
			const a = pts[Math.max(0, i - 2)]!;
			const b = pts[Math.min(pts.length - 1, i + 2)]!;
			p.steep = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
		});
		routes.push({
			lane, hue: fx.hues[lane] ?? 0, pts, length: s, last: fx.last[lane] ?? "running",
			activity: fx.scene.snapshot.lanes[lane]?.activity ?? 0.5,
		});
	}
	return routes;
}

/** Puts a dot beside a route point; `o` steps sideways along the normal. */
export function beside(fx: Fx, p: Pt, o: number, colour: Rgb, energy: number, lane: number, keep = false): void {
	if (p.steep) dot(fx, p.x + o, p.y, colour, energy, lane, keep);
	else dot(fx, p.x, p.y + o, colour, energy, lane, keep);
}

/** A light on the route with a tail: `dir` 1 has the tail behind (lower s), -1 ahead. */
export function pulse(fx: Fx, route: Route, head: number, dir: 1 | -1, tail: number, from: Rgb, to: Rgb, energy: number): void {
	for (const p of route.pts) {
		const d = (head - p.s) * dir;
		if (d < -1 || d > tail) continue;
		const u = clamp(d / tail);
		const e = energy * (1 - u) ** 1.4;
		const colour = mix(from, to, smooth(u * 1.6));
		for (let o = -1; o <= 1; o++) beside(fx, p, o, colour, o === 0 ? e : e * 0.6, route.lane);
	}
}

/** Index of the route point nearest to a mark. */
export function nearest(route: Route, mark: Mark): number {
	const x = mark.cx * 2 + 1;
	const y = mark.cy * 4 + 1.5;
	let best = 0;
	let bestD = Number.POSITIVE_INFINITY;
	route.pts.forEach((p, i) => {
		const d = (p.x - x) ** 2 + (p.y - y) ** 2;
		if (d < bestD) { bestD = d; best = i; }
	});
	return best;
}
