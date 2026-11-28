/**
 * The bee's art generator: writes every key-pose SVG and sequence spec under assets/stage/src/bee (director, worker,
 * fx/background) from a few parametric parts, so the poses share one drawing. The written SVGs are what the bake reads;
 * edit the parameters here and regenerate rather than hand-editing them.
 *
 *   bun scripts/stage/art/bee.ts
 *   bun scripts/stage/bake.ts --only bee --no-write --contact /tmp/bee
 *
 * Director: a comb hanging from a branch, its hex cells filled with light (the accent layer rims it amber while waiting
 * for the user). Worker: one bee with beating wings over its light flower (the source): scouting and gathering pollen,
 * the waggle dance on submit, a second bee feeling the piece in review, held by wind when blocked. Background: a dim
 * field of light flowers, drifting pollen.
 *
 * resvg (2.6.2) panics on a filtered group whose children are all invisible, and on some translucent groups around
 * the bee's blurred parts: the bee fades on each element, and glows blur each element rather than a group.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../../assets/stage/src/bee/", import.meta.url));
const f = (n: number): string => {
	const r = Math.round(n * 100) / 100;
	return r === 0 ? "0" : String(r);
};
const grey = (pct: number): string => `rgb(${f(pct)}%,${f(pct)}%,${f(pct)}%)`;
const rad = (deg: number): number => (deg * Math.PI) / 180;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
type P = [number, number];

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function defs(w: number, h: number): string {
	const region = `filterUnits="userSpaceOnUse" x="-40" y="-40" width="${w + 80}" height="${h + 80}"`;
	return (
		`<defs>\n` +
		`<filter id="halo" ${region}><feGaussianBlur stdDeviation="2.2"/></filter>\n` +
		`<filter id="wide" ${region}><feGaussianBlur stdDeviation="3.2"/></filter>\n` +
		`<filter id="soft" ${region}><feGaussianBlur stdDeviation="0.8"/></filter>\n` +
		`<filter id="wing" ${region}><feGaussianBlur stdDeviation="0.35"/></filter>\n` +
		`<filter id="blur" ${region}><feGaussianBlur stdDeviation="1.3"/></filter>\n` +
		`</defs>\n`
	);
}

// ---------------------------------------------------------------------------------------------------------------
// The bee: drawn facing right, thorax at the origin
// ---------------------------------------------------------------------------------------------------------------

interface Bee {
	x: number; y: number; rot: number; sx: number; s: number;
	/** Abdomen swing (deg): the waggle. */
	abd: number;
	/** 0 folded along the back .. 1 raised and beating. */
	wing: number;
	/** The motion-blur ghost of beating wings. */
	buzz: number;
	/** Antenna angles, deg below straight forward-up. */
	antA: number; antB: number;
	/** 0 standing (legs down) .. 1 flying (legs trailing). */
	legs: number;
	/** The pollen basket's light. */
	pollen: number;
	glow: number;
	bright: number;
	op: number;
}

const B0: Bee = { x: 16, y: 15, rot: -4, sx: 1, s: 0.9, abd: 0, wing: 1, buzz: 1, antA: -55, antB: -40, legs: 1, pollen: 0.25, glow: 1, bright: 1, op: 1 };
const bee = (o: Partial<Bee>): Bee => ({ ...B0, ...o });
/** Perched on the worker's flower. */
const PERCH = { x: 29, y: 23.4, rot: 0, legs: 0 };
const HOVER = { x: 16, y: 15 };

function antenna(bx: number, by: number, deg: number): { d: string; tip: P } {
	const a1 = rad(deg);
	const ex = bx + Math.cos(a1) * 2;
	const ey = by + Math.sin(a1) * 2;
	const a2 = rad(deg + 35);
	const tx = ex + Math.cos(a2) * 2.4;
	const ty = ey + Math.sin(a2) * 2.4;
	return { d: `M${f(bx)} ${f(by)} Q${f(ex)} ${f(ey)} ${f(tx)} ${f(ty)}`, tip: [tx, ty] };
}

/** The abdomen's two dark bands: vertical slices of its ellipse, a hair inside the edge. */
const STRIPES = [[-5.5, -4.15], [-8.6, -7.35]]
	.map(([x0, x1]) => {
		const half = (x: number): number => 3.25 * Math.sqrt(Math.max(0, 1 - ((x + 6.2) / 4.9) ** 2));
		return `M${f(x0!)} ${f(0.6 - half(x0!))} L${f(x1!)} ${f(0.6 - half(x1!))} L${f(x1!)} ${f(0.6 + half(x1!))} L${f(x0!)} ${f(0.6 + half(x0!))} Z`;
	})
	.join(" ");

function beeTransform(p: Bee): string {
	return `translate(${f(p.x)} ${f(p.y)}) rotate(${f(p.rot)}) scale(${f(p.sx * p.s)} ${f(p.s)})`;
}

function beeSvg(p: Bee): string {
	const L = (a: number, b: number): number => lerp(a, b, p.wing);
	const K = (a: number, b: number): number => lerp(a, b, p.legs);
	const br = p.bright;
	// resvg can panic on a translucent group holding filtered parts, so the fade goes on every element instead.
	const o = p.op;
	const wing = (cx: number, cy: number, rx: number, ry: number, r: number, a: number): string =>
		`<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" transform="rotate(${f(r)} ${f(cx)} ${f(cy)})" fill="${grey(92 * br)}" fill-opacity="${f(o * a)}" stroke="${grey(100 * br)}" stroke-opacity="${f(o * a * 0.9)}" stroke-width="0.4" filter="url(#wing)"/>`;
	const back = wing(L(-4.4, -2.8), L(-2.5, -5.2), 4.3, L(1.1, 2.1), L(-6, -30), L(0.5, 0.55));
	const front = wing(L(-3.4, 0.2), L(-2.9, -5.8), L(4.5, 4.9), L(1.2, 2.4), L(-3, -10), L(0.55, 0.6));
	const ghost = `<ellipse cx="-1.2" cy="-5.6" rx="5.8" ry="3.6" transform="rotate(-18 -1.2 -5.6)" fill="${grey(100)}" opacity="${f(0.3 * p.buzz * p.wing * o)}" filter="url(#blur)"/>`;
	const legs = [
		[-1.4, 2.3, K(-1.6, -3.4), K(5.2, 4.6)],
		[0, 2.6, K(0.2, -1.4), K(5.4, 5.3)],
		[1.4, 2.3, K(2.1, 0.9), K(5.1, 5)],
	]
		.map(([x1, y1, x2, y2]) => `<path d="M${f(x1!)} ${f(y1!)} L${f(x2!)} ${f(y2!)}" stroke="${grey(62 * br)}" stroke-opacity="${f(o)}" stroke-width="0.55" stroke-linecap="round"/>`)
		.join("");
	const bx = K(-1.6, -3.4), by = K(5.2, 4.6);
	const basket =
		`<circle cx="${f(bx)}" cy="${f(by)}" r="${f(1.4 + 1.6 * p.pollen)}" fill="${grey(100)}" opacity="${f(0.6 * p.pollen * o)}" filter="url(#soft)"/>` +
		`<circle cx="${f(bx)}" cy="${f(by)}" r="${f(0.45 + 0.85 * p.pollen)}" fill="${grey(100)}" opacity="${f((0.2 + 0.8 * p.pollen) * o)}"/>`;
	const ant = [antenna(4.9, -0.8, p.antA), antenna(4.5, -1.1, p.antB)]
		.map(
			(an, i) =>
				`<path d="${an.d}" fill="none" stroke="${grey(88 * br)}" stroke-opacity="${f((i === 0 ? 1 : 0.7) * o)}" stroke-width="0.55" stroke-linecap="round"/>` +
				`<circle cx="${f(an.tip[0])}" cy="${f(an.tip[1])}" r="0.5" fill="${grey(100 * br)}" opacity="${f(o)}"/>`,
		)
		.join("");
	return (
		`<g transform="${beeTransform(p)}">` +
		`<ellipse cx="-2.5" cy="-1.5" rx="10" ry="7" fill="${grey(100)}" opacity="${f(0.2 * p.glow * o)}" filter="url(#halo)"/>` +
		back +
		ghost +
		`<g transform="rotate(${f(p.abd)} -2.2 0.4)">` +
		`<path d="M-10.7 0.4 L-12.9 1.3 L-10.6 1.9 Z" fill="${grey(80 * br)}" opacity="${f(o)}"/>` +
		`<ellipse cx="-6.2" cy="0.6" rx="4.9" ry="3.4" fill="${grey(80 * br)}" opacity="${f(o)}"/>` +
		`<path d="${STRIPES}" fill="${grey(16)}" opacity="${f(o)}"/>` +
		`<ellipse cx="-5.6" cy="-1" rx="2.7" ry="1.1" fill="${grey(100)}" opacity="${f(0.4 * br * o)}" filter="url(#soft)"/>` +
		`<ellipse cx="-6.2" cy="0.6" rx="4.9" ry="3.4" fill="none" stroke="${grey(100 * br)}" stroke-opacity="${f(0.75 * o)}" stroke-width="0.45"/>` +
		`</g>` +
		legs +
		basket +
		`<circle cx="0" cy="0" r="3.5" fill="${grey(100)}" opacity="${f(0.35 * p.glow * o)}" filter="url(#soft)"/>` +
		`<circle cx="0" cy="0" r="2.9" fill="${grey(94 * br)}" opacity="${f(o)}"/>` +
		`<circle cx="3.9" cy="0.8" r="2.1" fill="${grey(74 * br)}" opacity="${f(o)}"/>` +
		`<ellipse cx="4.5" cy="0.3" rx="0.85" ry="1.2" fill="${grey(6)}" opacity="${f(o)}"/>` +
		ant +
		front +
		`</g>`
	);
}

/** The bee's edge, for the red accent of a held bee. */
function beeRim(p: Bee, op: number): string {
	return (
		`<g opacity="${f(op)}" transform="${beeTransform(p)}" fill="none" stroke="${grey(100)}" stroke-width="0.8">` +
		`<g transform="rotate(${f(p.abd)} -2.2 0.4)"><ellipse cx="-6.2" cy="0.6" rx="5.3" ry="3.8"/></g>` +
		`<circle cx="0" cy="0" r="3.3"/><circle cx="3.9" cy="0.8" r="2.5"/>` +
		`</g>`
	);
}

// ---------------------------------------------------------------------------------------------------------------
// The flower (the source) and loose light
// ---------------------------------------------------------------------------------------------------------------

interface Flower { x: number; y: number; open: number; tilt: number; glow: number; op: number }
const F0: Flower = { x: 31, y: 28.5, open: 1, tilt: 0, glow: 0.8, op: 1 };
const flower = (o: Partial<Flower>): Flower => ({ ...F0, ...o });

function flowerSvg(p: Flower, h: number): string {
	const base: P = [30, h + 1];
	const q: P = [lerp(base[0], p.x, 0.3) - 2.2, lerp(base[1], p.y, 0.5)];
	const petals = Array.from({ length: 5 }, (_, k) => {
		const r = p.tilt + k * 72;
		const cy = p.y - 2.3 * p.open;
		return `<ellipse cx="${f(p.x)}" cy="${f(cy)}" rx="${f(0.5 + 1.25 * p.open)}" ry="${f(0.8 + 1.6 * p.open)}" transform="rotate(${f(r)} ${f(p.x)} ${f(p.y)})"/>`;
	}).join("");
	return (
		`<g opacity="${f(p.op)}">` +
		`<path d="M${f(base[0])} ${f(base[1])} Q${f(q[0])} ${f(q[1])} ${f(p.x)} ${f(p.y + 1.2)}" fill="none" stroke="${grey(40)}" stroke-width="0.8" stroke-linecap="round"/>` +
		`<ellipse cx="${f(q[0] + 2)}" cy="${f(q[1] + 1.5)}" rx="2.2" ry="0.8" transform="rotate(-30 ${f(q[0] + 2)} ${f(q[1] + 1.5)})" fill="${grey(34)}"/>` +
		`<ellipse cx="${f(p.x)}" cy="${f(p.y)}" rx="6.5" ry="4.8" fill="${grey(100)}" opacity="${f(0.3 * p.glow)}" filter="url(#halo)"/>` +
		`<g fill="${grey(58)}" fill-opacity="0.9" stroke="${grey(82)}" stroke-opacity="0.6" stroke-width="0.35">${petals}</g>` +
		`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(1.5 + 0.9 * p.glow)}" fill="${grey(100)}" opacity="${f(0.55 * p.glow)}" filter="url(#soft)"/>` +
		`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="1.2" fill="${grey(100)}"/>` +
		`</g>`
	);
}

interface Dot { x: number; y: number; r: number; o: number }
function dotsSvg(dots: Dot[]): string {
	return (
		`<g fill="${grey(100)}">${dots.map(d => `<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r * 2.2)}" opacity="${f(d.o * 0.6)}" filter="url(#soft)"/>`).join("")}</g>` +
		`<g fill="${grey(100)}">${dots.map(d => `<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(d.r)}" opacity="${f(d.o)}"/>`).join("")}</g>`
	);
}
/** `n` dots all at one point, hidden. */
const gathered = (n: number, x: number, y: number, o = 0, r = 0.5): Dot[] => Array.from({ length: n }, () => ({ x, y, r, o }));
/** `n` dots spread on a ring around (x, y). */
const ringDots = (n: number, x: number, y: number, rx: number, ry: number, o: number, r = 0.5, turn = 0): Dot[] =>
	Array.from({ length: n }, (_, i) => {
		const a = rad(turn + (360 * i) / n);
		return { x: x + rx * Math.cos(a), y: y + ry * Math.sin(a), r, o };
	});

function sparkle(x: number, y: number, s: number, o: number): string {
	const d = `M${f(x)} ${f(y - 3 * s)} L${f(x + 0.6 * s)} ${f(y - 0.6 * s)} L${f(x + 3 * s)} ${f(y)} L${f(x + 0.6 * s)} ${f(y + 0.6 * s)} L${f(x)} ${f(y + 3 * s)} L${f(x - 0.6 * s)} ${f(y + 0.6 * s)} L${f(x - 3 * s)} ${f(y)} L${f(x - 0.6 * s)} ${f(y - 0.6 * s)} Z`;
	return `<path d="${d}" fill="${grey(100)}" opacity="${f(o)}"/>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------------------------------------------

type Ease = "linear" | "in" | "out" | "inOut";
interface Key<T> { at: number; p: T; ease?: Ease }
interface Seq<T> { name: string; durationMs: number; loop: boolean; frameMs?: number; keys: Key<T>[] }
interface Box { w: number; h: number; anchor: { x: number; y: number } }

function writeSeqs<T>(actor: string, seqs: Seq<T>[], render: (p: T) => string, box: Box): void {
	const dir = join(OUT, actor);
	mkdirSync(dir, { recursive: true });
	for (const seq of seqs) {
		const letters = "abcdefghijklmnopqrstuvwxyz";
		const files: string[] = [];
		const seen = new Map<T, string>();
		const keys = seq.keys.map((key, i) => {
			let file = seen.get(key.p);
			if (file === undefined) {
				file = `${seq.name}.${letters[seen.size]}.svg`;
				seen.set(key.p, file);
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}">\n${defs(box.w, box.h)}${render(key.p)}\n</svg>\n`;
				writeFileSync(join(dir, file), svg);
				files.push(file);
			}
			return { at: key.at, svg: file, ...(i > 0 && key.ease !== undefined ? { ease: key.ease } : {}) };
		});
		const spec = { w: box.w, h: box.h, anchor: box.anchor, frameMs: seq.frameMs ?? 83, durationMs: seq.durationMs, loop: seq.loop, keys };
		writeFileSync(join(dir, `${seq.name}.json`), `${JSON.stringify(spec, null, "\t")}\n`);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Worker: one bee over its flower
// ---------------------------------------------------------------------------------------------------------------

const WB: Box = { w: 54, h: 36, anchor: { x: 16, y: 15 } };

interface W {
	bees: Bee[];
	fl: Flower;
	dots: Dot[];
	/** The waggle dance's figure eight: 0 undrawn .. 1 drawn, and its light. */
	trail?: { drawn: number; o: number; run: number };
	wind?: { shift: number; o: number };
	accent?: string;
}

const EIGHT_LEN = 92;
function trailSvg(t: W["trail"]): string {
	if (t === undefined) return "";
	const eight = "M23 14 L9 14 C5 14 5 6 12 6 C19 6 22 9 23 14 C24 19 21 22 14 22 C7 22 5 14 9 14";
	const zig = "M23 14 L21.5 12.6 L20 15.4 L18.5 12.6 L17 15.4 L15.5 12.6 L14 15.4 L12.5 12.6 L11 15.4 L9.5 14";
	return (
		`<path d="${eight}" fill="none" stroke="${grey(100)}" stroke-width="2.2" opacity="${f(t.o * 0.35)}" filter="url(#soft)" stroke-dasharray="${EIGHT_LEN} ${EIGHT_LEN}" stroke-dashoffset="${f(EIGHT_LEN * (0.96 - 0.96 * t.drawn))}"/>` +
		`<path d="${eight}" fill="none" stroke="${grey(100)}" stroke-width="0.6" opacity="${f(t.o)}" stroke-dasharray="${EIGHT_LEN} ${EIGHT_LEN}" stroke-dashoffset="${f(EIGHT_LEN * (0.96 - 0.96 * t.drawn))}"/>` +
		`<path d="${zig}" fill="none" stroke="${grey(100)}" stroke-width="0.5" stroke-linejoin="round" opacity="${f(t.run)}"/>`
	);
}

function windSvg(w: W["wind"]): string {
	if (w === undefined) return "";
	const streaks: [number, number, number][] = [[5, 46, 22], [11, 50, 16], [19, 47, 26], [26, 52, 14], [32, 48, 20]];
	return streaks
		.map(
			([y, x0, len], i) =>
				`<path d="M${x0} ${y} C${x0 - 12} ${y - 1.5} ${x0 - 24} ${y + 1.5} ${x0 - 40} ${y}" fill="none" stroke="${grey(100)}" stroke-width="${i % 2 === 0 ? 0.6 : 0.45}" stroke-linecap="round" stroke-dasharray="${len} 60" stroke-dashoffset="${f(w.shift + i * 7)}" opacity="${f(w.o * (i % 2 === 0 ? 0.7 : 0.45))}"/>`,
		)
		.join("");
}

function workerSvg(p: W): string {
	return (
		`<g>${windSvg(p.wind)}${flowerSvg(p.fl, WB.h)}${trailSvg(p.trail)}${p.bees.map(beeSvg).join("")}${dotsSvg(p.dots)}</g>` +
		(p.accent === undefined ? "" : `\n<g id="accent">${p.accent}</g>`)
	);
}

const NP = 6;
const restDots = gathered(NP, 31, 28.5);
const w = (o: Partial<W> & { bees: Bee[] }): W => ({ fl: F0, dots: restDots, ...o });

// work: scout the flower, land, gather light pollen, lift off.
const workA = w({ bees: [bee({ ...HOVER, rot: -6, pollen: 0.35, antA: -60, antB: -45 })], fl: flower({ tilt: 0 }) });
const workB = w({ bees: [bee({ x: 23.5, y: 18.5, rot: 14, pollen: 0.4, antA: -30, antB: -15, legs: 0.6 })], fl: flower({ tilt: -4 }) });
const workC = w({
	bees: [bee({ ...PERCH, rot: 6, pollen: 0.75, antA: 10, antB: 25, buzz: 0.6, wing: 0.85 })],
	fl: flower({ tilt: 6, glow: 1.2 }),
	dots: [
		{ x: 31.5, y: 27, r: 0.5, o: 0.9 }, { x: 33.5, y: 26.5, r: 0.45, o: 0.8 }, { x: 29.5, y: 26.8, r: 0.4, o: 0.7 },
		{ x: 30.6, y: 25.5, r: 0.55, o: 0.9 }, { x: 32.6, y: 25, r: 0.4, o: 0.7 }, { x: 34.4, y: 27.6, r: 0.35, o: 0.6 },
	],
});
const workD = w({
	bees: [bee({ x: 22, y: 10.5, rot: -16, pollen: 1, antA: -70, antB: -55 })],
	fl: flower({ tilt: -3, glow: 0.9 }),
	dots: [
		{ x: 22.4, y: 14.6, r: 0.4, o: 0.6 }, { x: 24.5, y: 15.5, r: 0.35, o: 0.5 }, { x: 26.4, y: 18, r: 0.35, o: 0.35 },
		{ x: 28.2, y: 21, r: 0.3, o: 0.25 }, { x: 30, y: 23.5, r: 0.3, o: 0.2 }, { x: 31, y: 26, r: 0.3, o: 0.1 },
	],
});
const work: Seq<W> = {
	name: "work", durationMs: 2000, loop: true,
	keys: [{ at: 0, p: workA }, { at: 500, p: workB }, { at: 1000, p: workC }, { at: 1500, p: workD }, { at: 2000, p: workA }],
};

// quiet: on the flower, fine work at half amplitude.
const quietA = w({ bees: [bee({ ...PERCH, pollen: 0.5, antA: 5, antB: 25, wing: 0.7, buzz: 0.4 })], fl: flower({ glow: 0.9 }) });
const quietB = w({
	bees: [bee({ ...PERCH, y: 23, rot: 3, pollen: 0.65, antA: 22, antB: 8, wing: 0.75, buzz: 0.5 })],
	fl: flower({ tilt: 3, glow: 1.1 }),
	dots: [
		{ x: 31.6, y: 26.8, r: 0.45, o: 0.8 }, { x: 33.2, y: 26.6, r: 0.4, o: 0.6 }, { x: 30, y: 26.4, r: 0.35, o: 0.5 },
		{ x: 31, y: 28.5, r: 0.3, o: 0 }, { x: 31, y: 28.5, r: 0.3, o: 0 }, { x: 31, y: 28.5, r: 0.3, o: 0 },
	],
});
const quiet: Seq<W> = { name: "quiet", durationMs: 2000, loop: true, keys: [{ at: 0, p: quietA }, { at: 1000, p: quietB }, { at: 2000, p: quietA }] };

// ready: hovering in place over the flower, a slow breath.
const readyA = w({ bees: [bee({ ...HOVER, y: 14.4, rot: -3, pollen: 0, glow: 0.75, bright: 0.85, buzz: 0.7 })], fl: flower({ glow: 0.5 }) });
const readyB = w({ bees: [bee({ ...HOVER, y: 15.8, rot: 2, pollen: 0, glow: 0.95, bright: 0.85, buzz: 1, antA: -45, antB: -30 })], fl: flower({ glow: 0.6 }) });
const ready: Seq<W> = { name: "ready", durationMs: 3400, loop: true, frameMs: 113, keys: [{ at: 0, p: readyA }, { at: 1700, p: readyB }, { at: 3400, p: readyA }] };

// rest: perched, wings folded, dim.
const restA = w({ bees: [bee({ ...PERCH, wing: 0, buzz: 0, pollen: 0, glow: 0.45, bright: 0.7, antA: 30, antB: 45 })], fl: flower({ glow: 0.4 }) });
const restB = w({ bees: [bee({ ...PERCH, y: 23.7, wing: 0.05, buzz: 0, pollen: 0, glow: 0.65, bright: 0.72, antA: 35, antB: 48 })], fl: flower({ glow: 0.5 }) });
const rest: Seq<W> = { name: "rest", durationMs: 3400, loop: true, frameMs: 166, keys: [{ at: 0, p: restA }, { at: 1700, p: restB }, { at: 3400, p: restA }] };

// submit: the waggle dance in front of the hive (to the left), then the bee holds, pollen raised.
const T0 = { drawn: 0, o: 0, run: 0 };
const dance = (o: Partial<Bee>, trail: NonNullable<W["trail"]>): W => w({ bees: [bee({ pollen: 1, buzz: 1, ...o })], trail });
const LIN = "linear" as const;
const submitKeys: Key<W>[] = [
	{ at: 0, p: dance({ ...HOVER, rot: -6, sx: 1 }, T0) },
	{ at: 200, p: dance({ x: 23, y: 14, sx: -1, rot: 0 }, { drawn: 0, o: 0.5, run: 0.3 }) },
	{ at: 350, p: dance({ x: 20.5, y: 14, sx: -1, abd: 24 }, { drawn: 0.05, o: 0.6, run: 0.6 }), ease: LIN },
	{ at: 500, p: dance({ x: 17, y: 14, sx: -1, abd: -24 }, { drawn: 0.09, o: 0.65, run: 0.7 }), ease: LIN },
	{ at: 650, p: dance({ x: 13.5, y: 14, sx: -1, abd: 24 }, { drawn: 0.13, o: 0.7, run: 0.75 }), ease: LIN },
	{ at: 800, p: dance({ x: 10, y: 14, sx: -1, abd: 0 }, { drawn: 0.16, o: 0.7, run: 0.6 }), ease: LIN },
	{ at: 1000, p: dance({ x: 10.5, y: 8, sx: -1, rot: 35 }, { drawn: 0.26, o: 0.7, run: 0.5 }), ease: LIN },
	{ at: 1150, p: dance({ x: 16.5, y: 6, sx: -1, rot: 0 }, { drawn: 0.36, o: 0.7, run: 0.45 }), ease: LIN },
	{ at: 1300, p: dance({ x: 22.5, y: 9, sx: -1, rot: -35 }, { drawn: 0.46, o: 0.7, run: 0.45 }), ease: LIN },
	{ at: 1400, p: dance({ x: 23, y: 14, sx: -1, rot: 0 }, { drawn: 0.52, o: 0.7, run: 0.5 }), ease: LIN },
	{ at: 1500, p: dance({ x: 20, y: 14, sx: -1, abd: -24 }, { drawn: 0.52, o: 0.7, run: 0.75 }), ease: LIN },
	{ at: 1600, p: dance({ x: 16.5, y: 14, sx: -1, abd: 24 }, { drawn: 0.52, o: 0.75, run: 0.8 }), ease: LIN },
	{ at: 1700, p: dance({ x: 13, y: 14, sx: -1, abd: -24 }, { drawn: 0.52, o: 0.75, run: 0.8 }), ease: LIN },
	{ at: 1800, p: dance({ x: 10, y: 14, sx: -1, abd: 0 }, { drawn: 0.56, o: 0.75, run: 0.7 }), ease: LIN },
	{ at: 1950, p: dance({ x: 10.5, y: 20, sx: -1, rot: -35 }, { drawn: 0.68, o: 0.7, run: 0.6 }), ease: LIN },
	{ at: 2100, p: dance({ x: 16.5, y: 22, sx: -1, rot: 0 }, { drawn: 0.8, o: 0.7, run: 0.5 }), ease: LIN },
	{ at: 2250, p: dance({ x: 22, y: 19, sx: -1, rot: 30 }, { drawn: 0.92, o: 0.65, run: 0.45 }), ease: LIN },
	{ at: 2400, p: dance({ x: 18, y: 13.5, sx: -1, rot: -12, antA: -75, antB: -60 }, { drawn: 1, o: 0.45, run: 0.35 }), ease: "out" },
];
const submit: Seq<W> = { name: "submit", durationMs: 2400, loop: false, keys: submitKeys };

// review: a second bee touches the raised piece (scene: about local (34, 6)) with its antennae.
const reviewer = (o: Partial<Bee>): Bee => bee({ sx: -1, s: 0.8, pollen: 0, bright: 0.72, glow: 0.6, op: 0.9, ...o });
const own = bee({ x: 17, y: 16, rot: -10, pollen: 0.8, antA: -70, antB: -60, buzz: 0.8 });
const reviewA = w({ bees: [own, reviewer({ x: 41.5, y: 12, rot: 14, antA: -40, antB: -25 })], dots: [{ x: 35.8, y: 6.4, r: 0.3, o: 0 }, ...gathered(NP - 1, 31, 28.5)] });
const reviewB = w({
	bees: [own, reviewer({ x: 40, y: 9, rot: 2, antA: -30, antB: -10 })],
	dots: [{ x: 35.8, y: 6.6, r: 0.6, o: 0.9 }, ...gathered(NP - 1, 31, 28.5)],
});
const reviewC = w({ bees: [own, reviewer({ x: 40.5, y: 3.5, rot: -18, antA: 5, antB: 22 })], dots: [{ x: 35.4, y: 5.4, r: 0.4, o: 0.4 }, ...gathered(NP - 1, 31, 28.5)] });
const reviewD = w({
	bees: [own, reviewer({ x: 39.5, y: 7, rot: -4, antA: -15, antB: 5 })],
	dots: [{ x: 35.8, y: 6.2, r: 0.6, o: 0.9 }, ...gathered(NP - 1, 31, 28.5)],
});
const review: Seq<W> = {
	name: "review", durationMs: 2900, loop: true, frameMs: 100,
	keys: [{ at: 0, p: reviewA }, { at: 700, p: reviewB }, { at: 1450, p: reviewC }, { at: 2150, p: reviewD }, { at: 2900, p: reviewA }],
};

// accepted: the pollen streams off toward the hive, a green flash, the bee loops once for joy.
const ringAcc = (r: number, o: number, s: number): string =>
	`<circle cx="17" cy="13" r="${f(r)}" fill="none" stroke="${grey(100)}" stroke-width="0.9" opacity="${f(o)}"/>` +
	sparkle(9, 7, s, o) + sparkle(26, 6, s * 0.8, o) + sparkle(27, 20, s * 0.7, o * 0.8) + sparkle(7, 20, s * 0.6, o * 0.7);
const accA = w({ bees: [bee({ ...HOVER, pollen: 1 })], accent: ringAcc(2, 0, 0.2) });
const accB = w({
	bees: [bee({ x: 17, y: 11, rot: -14, pollen: 0.5, antA: -75, antB: -60 })],
	dots: [
		{ x: 9, y: 13, r: 0.55, o: 0.95 }, { x: 5, y: 11, r: 0.5, o: 0.85 }, { x: 1.5, y: 12.5, r: 0.45, o: 0.7 },
		{ x: 7, y: 16, r: 0.45, o: 0.8 }, { x: 3, y: 15.5, r: 0.4, o: 0.6 }, { x: 11, y: 10, r: 0.4, o: 0.7 },
	],
	accent: ringAcc(7, 0.9, 0.9),
});
const accC = w({
	bees: [bee({ x: 22, y: 8, rot: 20, pollen: 0, antA: -60, antB: -45 })],
	dots: [
		{ x: -3, y: 12, r: 0.4, o: 0 }, { x: -4, y: 10, r: 0.4, o: 0 }, { x: -5, y: 13, r: 0.4, o: 0 },
		{ x: -3, y: 15, r: 0.4, o: 0 }, { x: -5, y: 15, r: 0.4, o: 0 }, { x: -2, y: 9, r: 0.4, o: 0 },
	],
	accent: ringAcc(12, 0.35, 0.5),
});
const accD = w({ bees: [bee({ ...HOVER, rot: -4, pollen: 0 })], dots: accC.dots, accent: ringAcc(14, 0, 0.2) });
const accepted: Seq<W> = {
	name: "accepted", durationMs: 1300, loop: false,
	keys: [{ at: 0, p: accA }, { at: 350, p: accB, ease: "out" }, { at: 800, p: accC }, { at: 1300, p: accD }],
};

// unmet: the pollen scatters, the bee darts off and swings back to gather again.
const unA = w({ bees: [bee({ x: 19, y: 16, rot: 4, pollen: 1 })], dots: gathered(NP, 16.8, 19.6, 0.9, 0.5) });
const unB = w({ bees: [bee({ x: 15.5, y: 13, rot: -24, pollen: 0.2, antA: -85, antB: -75 })], dots: ringDots(NP, 18, 20, 7, 5, 0.9, 0.5, 20) });
const unC = w({ bees: [bee({ x: 11, y: 8, rot: -18, pollen: 0 })], dots: ringDots(NP, 18, 22, 13, 9, 0.3, 0.35, 30) });
const unD = w({ bees: [bee({ x: 20, y: 15, rot: 18, pollen: 0, antA: -30, antB: -15 })], dots: ringDots(NP, 18, 24, 16, 11, 0, 0.3, 35) });
const unmet: Seq<W> = {
	name: "unmet", durationMs: 600, loop: false,
	keys: [{ at: 0, p: unA }, { at: 150, p: unB, ease: "out" }, { at: 380, p: unC }, { at: 600, p: unD }],
};

// blocked: a gust holds the bee in place; it braces, wings swept back, the flower bent.
const blA = w({ bees: [bee({ ...HOVER, pollen: 0.5 })], wind: { shift: 60, o: 0 }, accent: beeRim(bee({ ...HOVER, pollen: 0.5 }), 0) });
const blBee = bee({ x: 13.5, y: 15.5, rot: -24, pollen: 0.5, wing: 0.55, buzz: 0.3, antA: 60, antB: 75, legs: 1 });
const blB = w({ bees: [blBee], fl: flower({ x: 28.5, tilt: -28, glow: 0.6 }), wind: { shift: 20, o: 0.9 }, accent: beeRim(blBee, 1) });
const blCBee = bee({ x: 14, y: 15.5, rot: -20, pollen: 0.5, wing: 0.5, buzz: 0.2, antA: 65, antB: 80, legs: 1 });
const blC = w({ bees: [blCBee], fl: flower({ x: 29, tilt: -22, glow: 0.6 }), wind: { shift: -6, o: 0.75 }, accent: beeRim(blCBee, 1) });
const blocked: Seq<W> = { name: "blocked", durationMs: 900, loop: false, keys: [{ at: 0, p: blA }, { at: 250, p: blB, ease: "out" }, { at: 900, p: blC }] };

// excluded (and leaving the stage in a handoff): the bee sets its pollen down on the flower and flies up, fading.
const exA = w({ bees: [bee({ ...HOVER, pollen: 0.8 })], dots: gathered(NP, 14.4, 19.2, 0, 0.5) });
const exB = w({
	bees: [bee({ x: 24, y: 19, rot: 12, pollen: 0, legs: 0.5 })],
	dots: [
		{ x: 22.5, y: 23, r: 0.5, o: 0.9 }, { x: 25, y: 25, r: 0.45, o: 0.8 }, { x: 28, y: 26.6, r: 0.45, o: 0.8 },
		{ x: 30.4, y: 27.6, r: 0.4, o: 0.7 }, { x: 27, y: 25, r: 0.4, o: 0.7 }, { x: 24, y: 24, r: 0.4, o: 0.6 },
	],
});
const exC = w({
	bees: [bee({ x: 12, y: 3, rot: -22, pollen: 0, op: 0.25, glow: 0.4, bright: 0.7, s: 0.75 })],
	fl: flower({ open: 0.55, glow: 0.25, op: 0.45 }),
	dots: [
		{ x: 30, y: 28, r: 0.4, o: 0.35 }, { x: 31.8, y: 28.4, r: 0.35, o: 0.3 }, { x: 30.8, y: 29, r: 0.35, o: 0.3 },
		{ x: 31, y: 28.5, r: 0.3, o: 0 }, { x: 31, y: 28.5, r: 0.3, o: 0 }, { x: 31, y: 28.5, r: 0.3, o: 0 },
	],
});
const excluded: Seq<W> = { name: "excluded", durationMs: 1200, loop: false, keys: [{ at: 0, p: exA }, { at: 500, p: exB }, { at: 1200, p: exC, ease: "in" }] };

// gather (arriving in a handoff): the bee flies in from the upper left toward its flower and settles into a hover.
const gaA = w({ bees: [bee({ x: -6, y: 4, rot: 18, op: 0, s: 0.7, pollen: 0 })], fl: flower({ open: 0.3, glow: 0, op: 0 }) });
const gaB = w({ bees: [bee({ x: 9, y: 10, rot: 12, op: 0.8, s: 0.85, pollen: 0 })], fl: flower({ open: 0.7, glow: 0.4, op: 0.7 }) });
const gaC = w({ bees: [bee({ ...HOVER, rot: -4, pollen: 0 })], fl: flower({ glow: 0.7 }) });
const gather: Seq<W> = { name: "gather", durationMs: 1200, loop: false, keys: [{ at: 0, p: gaA }, { at: 600, p: gaB, ease: "out" }, { at: 1200, p: gaC }] };

// waiting-user: everyone stands still; one held frame.
const waiting: Seq<W> = { name: "waiting-user", durationMs: 2400, loop: true, frameMs: 2400, keys: [{ at: 0, p: w({ bees: [bee({ ...HOVER, buzz: 0, pollen: 0.5, antA: -50, antB: -35 })] }) }, { at: 2400, p: w({ bees: [bee({ ...HOVER, buzz: 0, pollen: 0.5, antA: -50, antB: -35 })] }) }] };

// finale: the bee circles once and lands on its flower, which blooms bright.
const fiKeys: Key<W>[] = [
	{ at: 0, p: w({ bees: [bee({ ...HOVER, pollen: 0.4 })] }) },
	{ at: 450, p: w({ bees: [bee({ x: 22, y: 6.5, rot: -4, pollen: 0.4 })] }) },
	{ at: 850, p: w({ bees: [bee({ x: 31, y: 11, rot: 22, pollen: 0.4 })] }) },
	{ at: 1200, p: w({ bees: [bee({ x: 22, y: 17.5, sx: -1, rot: 0, pollen: 0.4 })] }) },
	{ at: 1500, p: w({ bees: [bee({ x: 12, y: 12, sx: -1, rot: 14, pollen: 0.4 })] }) },
	{ at: 1800, p: w({ bees: [bee({ x: 20, y: 15, sx: 1, rot: 12, pollen: 0.4, legs: 0.6 })], fl: flower({ glow: 1 }) }) },
	{ at: 2200, p: w({ bees: [bee({ ...PERCH, wing: 0.15, buzz: 0, pollen: 0.4, glow: 1.2, antA: -20, antB: -5 })], fl: flower({ glow: 1.6 }) }), ease: "out" },
];
const finale: Seq<W> = { name: "finale", durationMs: 2200, loop: false, keys: fiKeys };

// lights-out: holding the pollen left, the bee settles on the flower facing the hive while the light goes down.
const loA = w({ bees: [bee({ ...HOVER, pollen: 0.9 })] });
const loB = w({ bees: [bee({ x: 24, y: 19, sx: -1, rot: -6, pollen: 0.85, glow: 0.8, legs: 0.5 })], fl: flower({ glow: 0.6 }) });
const loC = w({
	bees: [bee({ ...PERCH, x: 30, sx: -1, wing: 0, buzz: 0, pollen: 0.75, glow: 0.4, bright: 0.6, op: 0.75, antA: -45, antB: -30 })],
	fl: flower({ glow: 0.25, op: 0.7 }),
});
const loTurn = w({ bees: [bee({ ...HOVER, sx: -1, rot: 4, pollen: 0.9 })] });
const lightsOut: Seq<W> = {
	name: "lights-out", durationMs: 4000, loop: false, frameMs: 166,
	keys: [{ at: 0, p: loA }, { at: 400, p: loTurn }, { at: 1800, p: loB }, { at: 4000, p: loC }],
};

// user-steer: the user spoke to this worker: it stops, looks up and nods twice, and dives back to its flower.
const usA = w({ bees: [bee({ ...HOVER, rot: -6, pollen: 0.35, antA: -60, antB: -45 })] });
const usNod = (rot: number, ant: number, glow: number): W => w({ bees: [bee({ ...HOVER, y: 13.5, rot, pollen: 0.35, antA: ant, antB: ant + 12, glow, buzz: 0.4 })] });
const userSteer: Seq<W> = {
	name: "user-steer", durationMs: 900, loop: false,
	keys: [
		{ at: 0, p: usA },
		{ at: 180, p: usNod(-28, -95, 1.6) },
		{ at: 330, p: usNod(14, -50, 1.3), ease: "out" },
		{ at: 450, p: usNod(-22, -95, 1.4) },
		{ at: 580, p: usNod(12, -50, 1.2), ease: "out" },
		{ at: 900, p: w({ bees: [bee({ x: 22, y: 18, rot: 14, pollen: 0.35, antA: -35, antB: -20, legs: 0.8 })] }) },
	],
};

// user-stop: the user stopped this worker: it drops its pollen on the flower and flies off the stage.
const ustB = w({
	bees: [bee({ x: 22, y: 17, rot: 10, pollen: 0, legs: 0.6 })],
	dots: [
		{ x: 21, y: 22, r: 0.5, o: 0.9 }, { x: 23.5, y: 24, r: 0.45, o: 0.8 }, { x: 26.5, y: 26, r: 0.45, o: 0.8 },
		{ x: 29.5, y: 27.5, r: 0.4, o: 0.7 }, { x: 25, y: 25.5, r: 0.4, o: 0.7 }, { x: 22.5, y: 23.5, r: 0.4, o: 0.6 },
	],
});
const ustC = w({
	bees: [bee({ x: -10, y: -6, rot: -30, sx: -1, pollen: 0, s: 0.8, op: 0.3 })],
	dots: [
		{ x: 29.4, y: 28, r: 0.45, o: 0.7 }, { x: 31.5, y: 28.6, r: 0.4, o: 0.6 }, { x: 32.8, y: 27.8, r: 0.4, o: 0.5 },
		{ x: 30.5, y: 29.3, r: 0.35, o: 0.5 }, { x: 31, y: 28.5, r: 0.3, o: 0 }, { x: 31, y: 28.5, r: 0.3, o: 0 },
	],
});
const userStop: Seq<W> = {
	name: "user-stop", durationMs: 1200, loop: false,
	keys: [{ at: 0, p: w({ bees: [bee({ ...HOVER, pollen: 0.9 })], dots: gathered(NP, 14.4, 19.2, 0, 0.5) }) }, { at: 450, p: ustB }, { at: 1200, p: ustC, ease: "in" }],
};

// ---------------------------------------------------------------------------------------------------------------
// Director: the hanging comb
// ---------------------------------------------------------------------------------------------------------------

const DB: Box = { w: 54, h: 63, anchor: { x: 27, y: 33 } };
const HEX_R = 4.45;
const ROWS = [3, 4, 5, 4, 3];
const CELLS: P[] = ROWS.flatMap((n, r) => Array.from({ length: n }, (_, i): P => [27 + (i - (n - 1) / 2) * 8.66, 17 + r * 7.5]));
const CENTER = 9;

function hexPath(cx: number, cy: number, r: number): string {
	const pts = Array.from({ length: 6 }, (_, k): P => [cx + r * Math.cos(rad(-90 + 60 * k)), cy + r * Math.sin(rad(-90 + 60 * k))]);
	return `M${pts.map(p => `${f(p[0])} ${f(p[1])}`).join(" L")} Z`;
}
/** The comb's wax outline: round the outer cells. */
const COMB = (() => {
	const pts: P[] = [];
	const R = 5.9;
	for (let a = 0; a < 360; a += 15) {
		// The farthest cell edge in this direction.
		let best = 0;
		for (const [cx, cy] of CELLS) {
			const d = (cx - 27) * Math.cos(rad(a)) + (cy - 32) * Math.sin(rad(a));
			if (d > best) best = d;
		}
		pts.push([27 + (best + R) * Math.cos(rad(a)), 32 + (best + R) * 0.98 * Math.sin(rad(a))]);
	}
	const n = pts.length;
	let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
	for (let i = 0; i < n; i++) {
		const p0 = pts[(i - 1 + n) % n]!, p1 = pts[i]!, p2 = pts[(i + 1) % n]!, p3 = pts[(i + 2) % n]!;
		d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
	}
	return `${d} Z`;
})();

interface D {
	lum: number[];
	glow: number;
	wax: number;
	op: number;
	dy: number;
	dots: Dot[];
	accent?: { o: number };
}

function directorSvg(p: D): string {
	const cells = CELLS.map(([cx, cy], i) => {
		const l = p.lum[i]!;
		return `<path d="${hexPath(cx, cy, HEX_R)}" fill="${grey(10 + 86 * l)}" stroke="${grey(55 + 40 * l)}" stroke-width="0.6"/>`;
	}).join("");
	const glows = CELLS.map(([cx, cy], i) => `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(2.5 + 2.5 * p.lum[i]!)}" opacity="${f(0.7 * p.lum[i]! ** 1.5)}" filter="url(#soft)"/>`).join("");
	const cores = CELLS.map(([cx, cy], i) => `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(0.4 + 1.3 * p.lum[i]!)}" opacity="${f(Math.max(0, p.lum[i]! - 0.35) * 1.4)}"/>`).join("");
	const body =
		`<g opacity="${f(p.op)}">` +
		`<path d="M-2 8.5 C12 6 20 9.5 27 8.5 C36 7.2 44 6.6 56 9" fill="none" stroke="${grey(38)}" stroke-width="2.2" stroke-linecap="round"/>` +
		`<ellipse cx="9" cy="5.6" rx="3.2" ry="1.3" transform="rotate(-25 9 5.6)" fill="${grey(30)}"/>` +
		`<ellipse cx="45" cy="5.4" rx="3.4" ry="1.3" transform="rotate(20 45 5.4)" fill="${grey(30)}"/>` +
		`<g transform="translate(0 ${f(p.dy)})">` +
		`<ellipse cx="27" cy="32" rx="21" ry="20" fill="${grey(100)}" opacity="${f(0.3 * p.glow)}" filter="url(#wide)"/>` +
		`<path d="M21 8.5 L33 8.5 L32 13 L22 13 Z" fill="${grey(26)}"/>` +
		`<path d="${COMB}" fill="${grey(20 + 10 * p.wax)}" stroke="${grey(60 + 30 * p.wax)}" stroke-width="0.8"/>` +
		cells +
		`<g fill="${grey(100)}">${glows}</g>` +
		`<g fill="${grey(100)}">${cores}</g>` +
		`</g>` +
		dotsSvg(p.dots) +
		`</g>`;
	const accent =
		p.accent === undefined
			? ""
			: `\n<g id="accent"><g opacity="${f(p.accent.o)}" transform="translate(0 ${f(p.dy)})">` +
				`<path d="${COMB}" fill="none" stroke="${grey(100)}" stroke-width="1.6" filter="url(#soft)"/>` +
				`<path d="${COMB}" fill="none" stroke="${grey(100)}" stroke-width="0.7"/>` +
				`<path d="${hexPath(CELLS[CENTER]![0], CELLS[CENTER]![1], HEX_R)}" fill="${grey(100)}" fill-opacity="0.85"/>` +
				`<circle cx="${f(CELLS[CENTER]![0])}" cy="${f(CELLS[CENTER]![1])}" r="6" fill="${grey(100)}" opacity="0.6" filter="url(#halo)"/>` +
				`</g></g>`;
	return body + accent;
}

/** Cells filled with light from earlier acceptances: a fixed, irregular set. */
const LIT = [0.75, 0.2, 0.15, 0.15, 0.8, 0.7, 0.2, 0.3, 0.85, 0.65, 0.2, 0.15, 0.18, 0.7, 0.2, 0.2, 0.15, 0.6, 0.15];
const ND = 8;
const noDots = gathered(ND, 27, 32);
const D0: D = { lum: LIT, glow: 0.8, wax: 0.5, op: 1, dy: 0, dots: noDots };
/** A wave of light sweeping the comb at phase k (0..1). */
const shimmer = (k: number): number[] =>
	CELLS.map(([cx, cy], i) => {
		const ph = ((cx - 5) / 44 + (cy - 17) / 60) * 0.85;
		const wave = Math.max(0, Math.cos((ph - k) * Math.PI * 2));
		return Math.min(1, LIT[i]! + 0.32 * wave ** 3);
	});
const dWork: Seq<D> = {
	name: "work", durationMs: 2400, loop: true,
	keys: [0, 0.25, 0.5, 0.75].map((k, i) => ({ at: i * 600, p: { ...D0, lum: shimmer(k), glow: 0.75 + 0.1 * Math.sin(k * Math.PI * 2) }, ease: "linear" as Ease })),
};
dWork.keys.push({ at: 2400, p: dWork.keys[0]!.p, ease: "linear" });

const dWaitA: D = { ...D0, lum: LIT, glow: 0.6, accent: { o: 0.55 } };
const dWaitB: D = { ...D0, lum: LIT, glow: 0.6, accent: { o: 1 } };
const dWait: Seq<D> = { name: "waiting-user", durationMs: 2400, loop: true, frameMs: 100, keys: [{ at: 0, p: dWaitA }, { at: 1200, p: dWaitB }, { at: 2400, p: dWaitA }] };

const byDistance = CELLS.map(([cx, cy]) => Math.hypot(cx - 27, (cy - 32) * 1.15));
const maxDist = Math.max(...byDistance);
const fillTo = (reach: number, top: number): number[] => CELLS.map((_, i) => (byDistance[i]! / maxDist <= reach ? top : LIT[i]!));
// Pieces fly in from around the hive into its cells.
const inbound = (t: number): Dot[] =>
	Array.from({ length: ND }, (_, i) => {
		const a = rad(-90 + (360 * i) / ND);
		const cell = CELLS[[0, 3, 7, 12, 18, 15, 11, 4][i]!]!;
		const sx = 27 + 30 * Math.cos(a), sy = 32 + 30 * Math.sin(a);
		return { x: lerp(sx, cell[0], t), y: lerp(sy, cell[1], t), r: 0.8, o: t >= 1 ? 0 : t === 0 ? 0 : 0.95 };
	});
const dFinale: Seq<D> = {
	name: "finale", durationMs: 2200, loop: false,
	keys: [
		{ at: 0, p: { ...D0, dots: inbound(0) } },
		{ at: 500, p: { ...D0, lum: fillTo(0.2, 1), glow: 1, dots: inbound(0.55) } },
		{ at: 1000, p: { ...D0, lum: fillTo(0.65, 1), glow: 1.3, dots: inbound(0.98), wax: 0.8 } },
		{ at: 1400, p: { ...D0, lum: fillTo(1, 1), glow: 1.8, dots: inbound(1), wax: 1 } },
		{ at: 2200, p: { ...D0, lum: fillTo(1, 0.88), glow: 1.15, dots: inbound(1), wax: 0.8 }, ease: "out" },
	],
};
const dark = (k: number): number[] => LIT.map(l => (l > 0.5 ? l * k : l * k * 0.4));
// rest (between rounds): the comb dims down; a few cells breathe slowly brighter and back.
const BREATH = [4, 9, 13];
const restLum = (k: number): number[] => dark(0.45).map((l, i) => (BREATH.includes(i) ? l + (0.55 - l) * k : l));
const dRestA: D = { ...D0, lum: restLum(0), glow: 0.3, wax: 0.3 };
const dRest: Seq<D> = {
	name: "rest", durationMs: 3400, loop: true, frameMs: 166,
	keys: [{ at: 0, p: dRestA }, { at: 1700, p: { ...D0, lum: restLum(1), glow: 0.42, wax: 0.3 } }, { at: 3400, p: dRestA }],
};
const dLights: Seq<D> = {
	name: "lights-out", durationMs: 4000, loop: false, frameMs: 166,
	keys: [
		{ at: 0, p: D0 },
		{ at: 1800, p: { ...D0, lum: dark(0.65), glow: 0.5, wax: 0.35 } },
		{ at: 4000, p: { ...D0, lum: dark(0.42), glow: 0.25, wax: 0.15, op: 0.85 } },
	],
};
// excluded (leaving in a handoff): the comb's light drains and it fades back into the dark.
const dExcluded: Seq<D> = {
	name: "excluded", durationMs: 1200, loop: false,
	keys: [
		{ at: 0, p: D0 },
		{ at: 1200, p: { ...D0, lum: dark(0.25), glow: 0, wax: 0, op: 0.2, dy: 1.5 }, ease: "in" },
	],
};
// gather (arriving): the comb glows up out of the dark while motes of light swarm in to it.
const swarmIn = (t: number, o: number): Dot[] =>
	Array.from({ length: ND }, (_, i) => {
		const a = rad(200 + 47 * i);
		const r = lerp(34, 9, t);
		return { x: 27 + r * Math.cos(a + t * 1.4), y: 32 + r * 0.8 * Math.sin(a + t * 1.4), r: 0.6, o };
	});
const dGather: Seq<D> = {
	name: "gather", durationMs: 1200, loop: false,
	keys: [
		{ at: 0, p: { ...D0, lum: dark(0.1), glow: 0, wax: 0, op: 0, dy: -2, dots: swarmIn(0, 0) } },
		{ at: 600, p: { ...D0, lum: dark(0.6), glow: 0.5, wax: 0.3, op: 0.8, dy: -0.5, dots: swarmIn(0.6, 0.9) }, ease: "out" },
		{ at: 1200, p: { ...D0, dots: swarmIn(1, 0) } },
	],
};

// ---------------------------------------------------------------------------------------------------------------
// Background: a dim field of light flowers, pollen drifting
// ---------------------------------------------------------------------------------------------------------------

const BG: Box = { w: 432, h: 90, anchor: { x: 0, y: 0 } };
const r = rng(7);
const FIELD = Array.from({ length: 30 }, (_, i) => {
	const x = i * 14.6 + r() * 9;
	const y = 62 + r() * 20;
	return { x, y, s: 0.7 + r() * 0.9, o: 0.35 + r() * 0.3, lean: (r() - 0.5) * 5 };
});
const GRASS = Array.from({ length: 40 }, (_, i) => ({ x: i * 11 + r() * 8, h: 6 + r() * 12, lean: (r() - 0.5) * 6 }));
const POLLEN = Array.from({ length: 34 }, () => ({ x: r() * 432, y: 6 + r() * 70, rad: 2 + r() * 4, ph: r() * 360, sz: 0.45 + r() * 0.4, o: 0.25 + r() * 0.35, tw: r() * 6 }));

function backgroundSvg(k: number): string {
	const grass = GRASS.map(g => `<path d="M${f(g.x)} 90 Q${f(g.x + g.lean * 0.3)} ${f(90 - g.h * 0.6)} ${f(g.x + g.lean)} ${f(90 - g.h)}"/>`).join("");
	const stems = FIELD.map(fl => `<path d="M${f(fl.x - fl.lean)} 90 Q${f(fl.x - fl.lean * 0.3)} ${f((fl.y + 90) / 2)} ${f(fl.x)} ${f(fl.y)}"/>`).join("");
	const halos = FIELD.map(fl => `<circle cx="${f(fl.x)}" cy="${f(fl.y)}" r="${f(4 * fl.s)}" opacity="${f(fl.o * 0.5)}"/>`).join("");
	const petals = FIELD.map(fl =>
		Array.from({ length: 5 }, (_, j) => `<ellipse cx="${f(fl.x)}" cy="${f(fl.y - 1.6 * fl.s)}" rx="${f(0.9 * fl.s)}" ry="${f(1.5 * fl.s)}" transform="rotate(${f(j * 72 + fl.lean * 8)} ${f(fl.x)} ${f(fl.y)})" opacity="${f(fl.o)}"/>`).join(""),
	).join("");
	const centres = FIELD.map(fl => `<circle cx="${f(fl.x)}" cy="${f(fl.y)}" r="${f(0.7 * fl.s)}" opacity="${f(Math.min(1, fl.o * 1.5))}"/>`).join("");
	const pollen = POLLEN.map(p => {
		const a = rad(p.ph + k * 60);
		const x = p.x + p.rad * Math.cos(a);
		const y = p.y + p.rad * 0.6 * Math.sin(a);
		const o = p.o * (0.6 + 0.4 * Math.cos(rad(p.tw * 60 + k * 120)));
		return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(p.sz)}" opacity="${f(o)}"/>`;
	}).join("");
	return (
		`<ellipse cx="216" cy="92" rx="260" ry="14" fill="${grey(60)}" opacity="0.18" filter="url(#wide)"/>` +
		`<g fill="none" stroke="${grey(30)}" stroke-width="0.6" stroke-linecap="round" opacity="0.5">${grass}</g>` +
		`<g fill="none" stroke="${grey(28)}" stroke-width="0.6" stroke-linecap="round" opacity="0.7">${stems}</g>` +
		`<g fill="${grey(70)}" filter="url(#halo)">${halos}</g>` +
		`<g fill="${grey(45)}">${petals}</g>` +
		`<g fill="${grey(80)}">${centres}</g>` +
		`<g fill="${grey(85)}">${pollen}</g>`
	);
}
const background: Seq<number> = {
	name: "background", durationMs: 6000, loop: true, frameMs: 200,
	keys: Array.from({ length: 7 }, (_, k) => ({ at: k * 1000, p: k % 6, ease: "linear" as Ease })),
};

// ---------------------------------------------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
writeSeqs("worker", [ready, work, quiet, submit, review, accepted, unmet, blocked, excluded, rest, waiting, finale, lightsOut, gather, userSteer, userStop], workerSvg, WB);
writeSeqs("director", [dWork, dWait, dFinale, dLights, dExcluded, dGather, dRest], directorSvg, DB);
writeSeqs("fx", [background], backgroundSvg, BG);
console.log("written", OUT);
