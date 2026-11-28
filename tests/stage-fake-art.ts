/**
 * Test-only art: plain procedural shapes for every species, actor and pose the scene can ask for, with each pose's
 * motion baked into its frames. Tests that need art independent of the baked sheets (or every pose at once) draw with
 * it; the product draws only the baked art in `assets/stage/`.
 */
import type { Species } from "../src/view/stage/cast.ts";
import {
	type SequenceId,
	type SequenceMeta,
	type StageActor,
	type StageAssets,
	type StageFrame,
	type StageTier,
	T1_CELL_PX,
	type T1Frame,
	type T2Frame,
} from "../src/view/stage/assets.ts";

/** Coverage 0..1 of a shape at (u, v), both -1..1 across the sequence's box. */
type Shape = (u: number, v: number) => number;

const disc = (cx: number, cy: number, rx: number, ry: number): Shape => (u, v) => (((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1 ? 1 : 0);
const union = (...shapes: Shape[]): Shape => (u, v) => Math.max(...shapes.map(shape => shape(u, v)));
const minus = (a: Shape, b: Shape): Shape => (u, v) => (b(u, v) > 0 ? 0 : a(u, v));
const ring = (rx: number, ry: number, width: number): Shape => minus(disc(0, 0, rx, ry), disc(0, 0, rx - width, ry - width));
const tri = (top: number, bottom: number, half: number): Shape => (u, v) => (v >= top && v <= bottom && Math.abs(u) <= (half * (v - top)) / (bottom - top) ? 1 : 0);

/** One plain, recognisable silhouette per species and actor. */
const SHAPES: Readonly<Record<Species, { director: Shape; worker: Shape; size: { director: [number, number]; worker: [number, number] } }>> = {
	// A round body with two eyes; a worker is one curled arm tip.
	octopus: {
		director: minus(disc(0, -0.15, 0.85, 0.75), union(disc(-0.35, -0.2, 0.16, 0.2), disc(0.35, -0.2, 0.16, 0.2))),
		worker: union(disc(0, 0.2, 0.55, 0.55), disc(0.45, -0.45, 0.3, 0.3)),
		size: { director: [54, 54], worker: [27, 36] },
	},
	// A hive of rows; a worker is a striped body with wings.
	bee: {
		director: minus(disc(0, 0, 0.8, 0.95), union(...[-0.45, 0, 0.45].map(y => (_u: number, v: number) => (Math.abs(v - y) < 0.07 ? 1 : 0)))),
		worker: union(minus(disc(0, 0.2, 0.7, 0.45), (u: number) => (Math.abs(u) < 0.08 || Math.abs(u - 0.35) < 0.08 ? 1 : 0)), disc(-0.25, -0.45, 0.3, 0.3), disc(0.25, -0.45, 0.3, 0.3)),
		size: { director: [45, 54], worker: [27, 36] },
	},
	// A mound; a worker is three beads in a row.
	ant: {
		director: tri(-0.9, 0.9, 0.95),
		worker: union(disc(-0.6, 0.2, 0.3, 0.35), disc(0, 0.2, 0.25, 0.3), disc(0.55, 0.15, 0.4, 0.45)),
		size: { director: [54, 54], worker: [27, 18] },
	},
	// A ring to circle; a worker is a long body with a dorsal fin.
	orca: {
		director: ring(0.8, 0.8, 0.25),
		worker: union(disc(0, 0.3, 0.95, 0.4), tri(-0.95, 0.1, 0.3)),
		size: { director: [45, 54], worker: [45, 36] },
	},
	// A tall body with two large eyes and ear tufts; no workers stand on the owl's stage.
	owl: {
		director: union(
			minus(disc(0, 0.15, 0.75, 0.8), union(ring(0.22, 0.22, 0.08), disc(-0.32, -0.15, 0.22, 0.22), disc(0.32, -0.15, 0.22, 0.22))),
			tri(-0.95, -0.5, 0.25),
		),
		worker: disc(0, 0, 0.4, 0.4),
		size: { director: [45, 72], worker: [9, 18] },
	},
	// A starling is a dot; the flock is drawn by the scene.
	starling: {
		director: disc(0, 0, 0.6, 0.6),
		worker: disc(0, 0, 0.9, 0.9),
		size: { director: [18, 18], worker: [9, 9] },
	},
};

/** A pose's motion: vertical bob and horizontal sway (fractions of the box), scale and coverage gain, over its loop. */
interface PoseMotion { ms: number; loop: boolean; at(p: number): { dx: number; dy: number; scale: number; gain: number } }

const still = { dx: 0, dy: 0, scale: 1, gain: 1 };
const wave = (p: number): number => Math.sin(p * Math.PI * 2);

const POSES: Readonly<Record<string, PoseMotion>> = {
	// Waiting for a turn: a slow breath in place.
	ready: { ms: 3400, loop: true, at: p => ({ ...still, scale: 1 + 0.04 * wave(p), gain: 0.7 }) },
	work: { ms: 2000, loop: true, at: p => ({ ...still, dy: 0.08 * wave(p), dx: 0.05 * wave(p * 2) }) },
	quiet: { ms: 2000, loop: true, at: p => ({ ...still, dy: 0.04 * wave(p), gain: 0.85 }) },
	submit: { ms: 900, loop: false, at: p => ({ ...still, dy: -0.2 * Math.min(1, p * 3), gain: 1.1 }) },
	review: { ms: 2900, loop: true, at: p => ({ ...still, dx: 0.12 * wave(p) }) },
	accepted: { ms: 1300, loop: false, at: p => ({ ...still, gain: 1 + 0.6 * (1 - p) }) },
	unmet: { ms: 600, loop: false, at: p => ({ ...still, dx: 0.15 * wave(p * 3) * (1 - p) }) },
	// Frozen: no motion at all.
	blocked: { ms: 600, loop: false, at: () => still },
	excluded: { ms: 800, loop: false, at: p => ({ ...still, scale: 1 - 0.3 * p, gain: 1 - 0.6 * p }) },
	rest: { ms: 3400, loop: true, at: p => ({ ...still, gain: 0.6 + 0.05 * wave(p) }) },
	"waiting-user": { ms: 2400, loop: true, at: () => still },
	finale: { ms: 2200, loop: false, at: p => ({ ...still, dy: -0.15 * Math.sin(p * Math.PI), gain: 1 + 0.5 * Math.sin(p * Math.PI) }) },
	"lights-out": { ms: 4000, loop: false, at: p => ({ ...still, gain: 1 - 0.55 * p }) },
	gather: { ms: 2400, loop: false, at: p => ({ ...still, scale: 0.6 + 0.4 * p }) },
	// The director edits a file itself: it re-grips its piece (the owl's talons), a small steady working motion.
	edit: { ms: 1600, loop: true, at: p => ({ ...still, dx: 0.04 * wave(p), dy: 0.03 * wave(p * 2) }) },
	// The user turned to it: a short nod (down and back), then work again (I2).
	"user-steer": { ms: 900, loop: false, at: p => ({ ...still, dy: 0.1 * Math.sin(p * Math.PI * 2), gain: 1.1 }) },
	// The user stopped it: it slides out of the stage and fades (I4).
	"user-stop": { ms: 1000, loop: false, at: p => ({ ...still, dx: 0.6 * p, gain: 1 - 0.8 * p }) },
};
const FRAME_MS = 1000 / 12;
const CACHE_LIMIT = 512;

function parse(id: SequenceId): { species: Species; actor: StageActor; name: string } | undefined {
	const [species, actor, name] = id.split("/") as [Species, StageActor, string];
	if (!(species in SHAPES) || (actor !== "director" && actor !== "worker" && actor !== "fx") || name === undefined) return undefined;
	return { species, actor, name };
}

/** Actors only: a background or a flock bird has no shape here and is not drawn. */
function motionOf(actor: StageActor, name: string): PoseMotion | undefined {
	return actor === "fx" ? undefined : POSES[name];
}

/** Box-filters a T1 frame down to one pixel per half cell. */
function toT2(frame: T1Frame): T2Frame {
	const halfH = T1_CELL_PX.h / 2;
	const w = Math.ceil(frame.w / T1_CELL_PX.w);
	const h = Math.ceil(frame.h / halfH);
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let py = 0; py < h; py++) {
		for (let px = 0; px < w; px++) {
			const sum = [0, 0, 0, 0];
			let n = 0;
			for (let y = py * halfH; y < Math.min(frame.h, (py + 1) * halfH); y++) {
				for (let x = px * T1_CELL_PX.w; x < Math.min(frame.w, (px + 1) * T1_CELL_PX.w); x++) {
					const at = (y * frame.w + x) * 4;
					for (let c = 0; c < 4; c++) sum[c] += frame.rgba[at + c]!;
					n++;
				}
			}
			const at = (py * w + px) * 4;
			for (let c = 0; c < 4; c++) rgba[at + c] = n === 0 ? 0 : sum[c] / n;
		}
	}
	return { tier: "t2", w, h, rgba };
}

/** Plain shapes, the pose's motion baked into each frame. */
class FakeArt implements StageAssets {
	readonly #cache = new Map<string, StageFrame>();

	meta(id: SequenceId): SequenceMeta | undefined {
		const parsed = parse(id);
		if (parsed === undefined) return undefined;
		const motion = motionOf(parsed.actor, parsed.name);
		if (motion === undefined) return undefined;
		const actor = parsed.actor === "director" ? "director" : "worker";
		const [w, h] = SHAPES[parsed.species].size[actor];
		return { durationMs: motion.ms, loop: motion.loop, size: { w, h }, anchor: { x: Math.floor(w / 2), y: Math.floor(h / 2) } };
	}

	frame(id: SequenceId, tMs: number, tier: StageTier): StageFrame | undefined {
		const meta = this.meta(id);
		if (meta === undefined) return undefined;
		const { species, actor, name } = parse(id)!;
		const motion = motionOf(actor, name)!;
		const t = Number.isFinite(tMs) ? Math.max(0, tMs) : 0;
		const local = meta.loop ? t % meta.durationMs : Math.min(t, meta.durationMs);
		const index = Math.floor(local / FRAME_MS);
		const key = `${id}|${index}|${tier}`;
		const kept = this.#cache.get(key);
		if (kept !== undefined) return kept;
		const shape = SHAPES[species][actor === "director" ? "director" : "worker"];
		const pose = motion.at(Math.min(1, (index * FRAME_MS) / meta.durationMs));
		const { w, h } = meta.size;
		const rgba = new Uint8ClampedArray(w * h * 4);
		const alpha = Math.round(255 * Math.min(1, Math.max(0, pose.gain)));
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const u = ((x + 0.5) / w) * 2 - 1;
				const v = ((y + 0.5) / h) * 2 - 1;
				const covered = shape((u - pose.dx * 2) / pose.scale, (v - pose.dy * 2) / pose.scale);
				if (covered <= 0) continue;
				const at = (y * w + x) * 4;
				rgba[at] = 255;
				rgba[at + 1] = 255;
				rgba[at + 2] = 255;
				rgba[at + 3] = alpha;
			}
		}
		const t1: T1Frame = { tier: "t1", w, h, rgba };
		const frame = tier === "t1" ? t1 : toT2(t1);
		if (this.#cache.size >= CACHE_LIMIT) this.#cache.clear();
		this.#cache.set(key, frame);
		return frame;
	}
}

export const FAKE_ART: StageAssets = new FakeArt();
