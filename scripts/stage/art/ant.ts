/**
 * Generates assets/stage/src/ant (docs/stage.md, 개미): the structure (director), the column's ants (workers) and
 * the soil background, as key SVGs plus sequence JSON in the bake's format v1 (assets/stage/src/README.md).
 *
 *   bun scripts/stage/art/ant.ts                      # rewrite src/ant from scratch
 *   bun scripts/stage/art/ant.ts worker/work,fx/background   # rewrite only those sequences
 *
 * Every key of a sequence comes from one template function, so keys differ only in numbers.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../../assets/stage/src/ant/", import.meta.url));
const f = (n: number): string => {
	const v = Math.round(n * 10) / 10;
	return v === 0 ? "0" : String(v);
};
type P = { x: number; y: number };
const rot = (p: P, c: P, deg: number): P => {
	const a = (deg * Math.PI) / 180;
	const dx = p.x - c.x;
	const dy = p.y - c.y;
	return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
};
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });

// ---------------------------------------------------------------- worker (ant)
const W = { w: 45, h: 36, anchor: { x: 22, y: 18 } };
const GROUND = 30;
const T0: P = { x: 20, y: 22.5 };

interface Antenna { a1: number; a2: number }
interface Piece { x: number; y: number; r: number; fo: number; so: number; s: number }
interface Spark { x: number; y: number; r: number; o: number }
interface AntPose {
	bx: number; by: number; tilt: number; head: number; gaster: number;
	near: Antenna; far: Antenna;
	/** six feet: near front, mid, hind, far front, mid, hind (world). */
	feet: P[];
	piece: Piece;
	glow: number; dim: number;
	sparks: Spark[];
	stone: number;
	mand: number;
}
const NO_PIECE: Piece = { x: 7, y: 21, r: 0, fo: 0, so: 0, s: 1 };
const carried = (p: Partial<Piece> = {}): Piece => ({ x: 7.2, y: 20.6, r: 0, fo: 0.95, so: 1, s: 1, ...p });
const NEUTRAL_FEET = { near: [-8, -0.6, 8.6], far: [-6, 1.4, 10.2] };
/** Feet: offsets added to the neutral spot; `lift` raises. tripod A = near front, near hind, far mid. */
function gait(sx: number, a: number, aLift: number, b: number, bLift: number, spread = 1, y = GROUND): P[] {
	const A = [true, false, true, false, true, false];
	return [0, 1, 2, 3, 4, 5].map(i => {
		const side = i < 3 ? NEUTRAL_FEET.near : NEUTRAL_FEET.far;
		const base = side[i % 3]! * spread;
		const inA = A[i]!;
		const off = inA ? a : b;
		const lift = inA ? aLift : bLift;
		return { x: T0.x + sx + base + off, y: (i < 3 ? y : y - 0.6) - lift };
	});
}
function knee(hip: P, foot: P, l1: number, l2: number, pref: P): P {
	const dx = foot.x - hip.x;
	const dy = foot.y - hip.y;
	let d = Math.hypot(dx, dy);
	const ux = dx / d;
	const uy = dy / d;
	d = Math.min(d, l1 + l2 - 0.01);
	const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
	const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
	const mx = hip.x + ux * a;
	const my = hip.y + uy * a;
	const k1 = { x: mx - uy * h, y: my + ux * h };
	const k2 = { x: mx + uy * h, y: my - ux * h };
	const score = (k: P): number => (k.x - mx) * pref.x + (k.y - my) * pref.y;
	return score(k1) >= score(k2) ? k1 : k2;
}

function antSvg(p: AntPose, opts: { stone: boolean; sparks: number }): string {
	const T = { x: T0.x + p.bx, y: T0.y + p.by };
	const R = (q: P, deg = p.tilt): P => rot(add(T, q), T, deg);
	const neck = R({ x: -4.4, y: -0.9 });
	const headRot = p.tilt + p.head;
	const headC = rot(add(neck, { x: -3.2, y: -0.9 }), neck, p.head);
	const pet = R({ x: 5.2, y: 0.4 });
	const gasC = rot(add(pet, { x: 6.2, y: 0.7 }), pet, p.gaster);
	const H = (q: P): P => rot(add(headC, q), headC, headRot);
	const hips = [R({ x: -2.6, y: 1.4 }), R({ x: -0.2, y: 1.8 }), R({ x: 2.2, y: 1.6 })];
	const farHips = hips.map(h => ({ x: h.x + 0.7, y: h.y - 0.7 }));
	const prefs = [{ x: -0.8, y: -1 }, { x: 0.1, y: -1 }, { x: 0.9, y: -1 }];
	const leg = (hip: P, foot: P, pref: P): string => {
		const k = knee(hip, foot, 6.2, 7, pref);
		return `M${f(hip.x)} ${f(hip.y)} ${f(k.x)} ${f(k.y)} ${f(foot.x)} ${f(foot.y)}`;
	};
	const nearLegs = [0, 1, 2].map(i => leg(hips[i]!, p.feet[i]!, prefs[i]!)).join(" ");
	const farLegs = [0, 1, 2].map(i => leg(farHips[i]!, p.feet[i + 3]!, prefs[i]!)).join(" ");
	const antenna = (base: P, a: Antenna): string => {
		const d1 = rot({ x: -Math.cos((a.a1 * Math.PI) / 180), y: -Math.sin((a.a1 * Math.PI) / 180) }, { x: 0, y: 0 }, headRot);
		const d2 = rot({ x: -Math.cos((a.a2 * Math.PI) / 180), y: -Math.sin((a.a2 * Math.PI) / 180) }, { x: 0, y: 0 }, headRot);
		const e = { x: base.x + d1.x * 4.2, y: base.y + d1.y * 4.2 };
		const t = { x: e.x + d2.x * 5.4, y: e.y + d2.y * 5.4 };
		return `M${f(base.x)} ${f(base.y)} ${f(e.x)} ${f(e.y)} ${f(t.x)} ${f(t.y)}`;
	};
	const nearAnt = antenna(H({ x: -1.4, y: -2.3 }), p.near);
	const farAnt = antenna(H({ x: -0.6, y: -2.6 }), p.far);
	const eye = H({ x: -1.3, y: -0.5 });
	const m0 = H({ x: -3.2, y: 0.6 });
	const m1 = H({ x: -5.4 - p.mand, y: 1.3 });
	const m2 = H({ x: -5.2, y: 2.4 + p.mand });
	const pc = { x: p.piece.x, y: p.piece.y };
	const corner = (dx: number, dy: number): P => rot({ x: pc.x + dx * p.piece.s, y: pc.y + dy * p.piece.s }, pc, p.piece.r);
	const pts = [corner(-2.8, -2.2), corner(2.8, -2.2), corner(2.8, 2.2), corner(-2.8, 2.2)];
	const pieceD = `M${pts.map(q => `${f(q.x)} ${f(q.y)}`).join(" ")}Z`;
	const core = [corner(-1.3, -0.9), corner(1.3, -0.9), corner(1.3, 0.9), corner(-1.3, 0.9)];
	const coreD = `M${core.map(q => `${f(q.x)} ${f(q.y)}`).join(" ")}Z`;
	const stone = opts.stone
		? `<path d="M2.5 30.5 C1.5 26 3.5 21.5 7.5 21 C11.5 20.6 13.3 25 12.8 30.5 Z" fill="dimgray" fill-opacity="${f(p.stone)}" stroke="gray" stroke-opacity="${f(p.stone)}" stroke-width=".6"/>\n`
		: "";
	const body =
		`<path d="${farLegs}" stroke="darkgray" stroke-opacity=".55" stroke-width=".8"/>\n` +
		`<path d="${farAnt}" stroke="darkgray" stroke-opacity=".6" stroke-width=".7"/>\n` +
		`<g fill="darkgray" stroke="white" stroke-width=".6">` +
		`<ellipse cx="${f(gasC.x)}" cy="${f(gasC.y)}" rx="6" ry="4.1" transform="rotate(${f(p.tilt + p.gaster)} ${f(gasC.x)} ${f(gasC.y)})"/>` +
		`<circle cx="${f(pet.x)}" cy="${f(pet.y)}" r="1.3"/>` +
		`<ellipse cx="${f(T.x)}" cy="${f(T.y)}" rx="4.6" ry="2.5" transform="rotate(${f(p.tilt)} ${f(T.x)} ${f(T.y)})"/>` +
		`<ellipse cx="${f(headC.x)}" cy="${f(headC.y)}" rx="3.5" ry="2.9" transform="rotate(${f(headRot)} ${f(headC.x)} ${f(headC.y)})"/></g>\n` +
		`<g fill="white" opacity=".75"><ellipse cx="${f(gasC.x + 0.6)}" cy="${f(gasC.y - 0.9)}" rx="3" ry="1.7" transform="rotate(${f(p.tilt + p.gaster)} ${f(gasC.x)} ${f(gasC.y)})"/>` +
		`<ellipse cx="${f(T.x)}" cy="${f(T.y - 0.4)}" rx="2.2" ry="1" transform="rotate(${f(p.tilt)} ${f(T.x)} ${f(T.y)})"/>` +
		`<circle cx="${f(eye.x)}" cy="${f(eye.y)}" r=".8"/></g>\n` +
		`<path d="M${f(m0.x)} ${f(m0.y)} L${f(m1.x)} ${f(m1.y)} M${f(m0.x)} ${f(m0.y + 0.6)} L${f(m2.x)} ${f(m2.y)}" stroke="white" stroke-width=".7"/>\n` +
		`<path d="${nearLegs}" stroke="gainsboro" stroke-width="1"/>\n` +
		`<path d="${nearAnt}" stroke="white" stroke-width=".8"/>\n` +
		`<path d="${pieceD}" fill="lightgray" fill-opacity="${f(p.piece.fo)}" stroke="white" stroke-opacity="${f(p.piece.so)}" stroke-width=".7" stroke-linejoin="round"/>\n` +
		`<path d="${coreD}" fill="white" fill-opacity="${f(p.piece.fo)}"/>`;
	const sparks = p.sparks.slice(0, opts.sparks).map(s => sparkPath(s)).join("\n");
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W.w}" height="${W.h}" viewBox="0 0 ${W.w} ${W.h}">\n` +
		`<defs><filter id="h" filterUnits="userSpaceOnUse" x="-10" y="-10" width="65" height="56"><feGaussianBlur stdDeviation="1.7"/></filter>\n` +
		`<g id="a" fill="none" stroke-linecap="round" stroke-linejoin="round">\n${stone}${body}\n</g></defs>\n` +
		`<g opacity="${f(p.dim)}"><use xlink:href="#a" filter="url(#h)" opacity="${f(p.glow)}"/><use xlink:href="#a"/></g>\n` +
		(opts.sparks > 0 ? `<g id="accent">\n${sparks}\n</g>\n` : "") +
		`</svg>\n`
	);
}
function sparkPath(s: Spark): string {
	const q = s.r * 0.28;
	const pts = [
		[s.x, s.y - s.r], [s.x + q, s.y - q], [s.x + s.r, s.y], [s.x + q, s.y + q],
		[s.x, s.y + s.r], [s.x - q, s.y + q], [s.x - s.r, s.y], [s.x - q, s.y - q],
	];
	return `<path d="M${pts.map(([x, y]) => `${f(x!)} ${f(y!)}`).join(" ")}Z" fill="white" opacity="${f(s.o)}"/>`;
}

const UP: Antenna = { a1: 58, a2: 8 };
const FAR_UP: Antenna = { a1: 68, a2: 22 };
function pose(over: Partial<AntPose> = {}): AntPose {
	return {
		bx: 0, by: 0, tilt: 0, head: 0, gaster: 0,
		near: UP, far: FAR_UP,
		feet: gait(0, 0, 0, 0, 0),
		piece: NO_PIECE, glow: 0.6, dim: 1, sparks: [], stone: 0, mand: 0,
		...over,
	};
}

// ---------------------------------------------------------------- director (structure)
/** 7 cells by 3.5 rows: fits under the 4 picture rows of a 5-row stage. The anchor is the middle of the base. */
const D = { w: 72, h: 63, anchor: { x: 36, y: 57 } };
const ROWS = [6, 5, 4, 3, 2, 1];
const BW = 9;
const BH = 5;
const BASE_Y = 57;
interface DirPose {
	/** brightness per row 0..1 */
	rows: number[];
	/** sink offset (gather/excluded) and per-row extra drop for rising row by row. */
	sink: number;
	rowDrop: number[];
	rowOp: number[];
	/** The waiting slot on top; `y` is the piece's offset from resting in it. */
	ghost: { y: number; fo: number; so: number };
	eyes: { r: number; o: number };
	glow: number; dim: number; arch: number;
	sparks: Spark[];
	crown: number;
}
function dirPose(over: Partial<DirPose> = {}): DirPose {
	return {
		rows: ROWS.map(() => 0.55), sink: 0, rowDrop: ROWS.map(() => 0), rowOp: ROWS.map(() => 1),
		ghost: { y: 0, fo: 0.12, so: 0.45 }, eyes: { r: 0.9, o: 0.55 }, glow: 0.7, dim: 1, arch: 0.3,
		sparks: [], crown: 0, ...over,
	};
}
function rowTop(i: number): number {
	return BASE_Y - (i + 1) * (BH + 1);
}
function dirSvg(p: DirPose): string {
	let blocks = "";
	ROWS.forEach((n, i) => {
		const width = n * BW + (n - 1);
		const x0 = 36 - width / 2;
		const y = rowTop(i) + p.sink + p.rowDrop[i]!;
		const b = p.rows[i]!;
		// One path per row: the first block absolute, the rest relative, so only the first point moves.
		const row = `M${f(x0)} ${f(y)}h${BW}v${BH}h-${BW}z${`m${BW + 1} 0h${BW}v${BH}h-${BW}z`.repeat(n - 1)}`;
		blocks += `<path d="${row}" fill="white" fill-opacity="${f(0.25 + 0.55 * b)}" stroke-opacity="${f(0.5 + 0.5 * b)}" stroke-width=".7" opacity="${f(p.rowOp[i]!)}"/>\n`;
		// The bright seam on top of each row.
		blocks += `<path d="M${f(x0 + 1)} ${f(y + 1.2)}H${f(x0 + width - 1)}" stroke-opacity="${f(0.2 + 0.8 * b)}" stroke-width=".6" opacity="${f(p.rowOp[i]!)}"/>\n`;
	});
	const top = rowTop(5) + p.sink;
	const g = p.ghost;
	const ghost = `<rect x="31.5" y="${f(rowTop(6) + g.y + p.sink)}" width="${BW}" height="${BH}" rx="1" fill="white" fill-opacity="${f(g.fo)}" stroke="white" stroke-opacity="${f(g.so)}" stroke-width=".7" stroke-dasharray="1.5 1"/>\n`;
	const crown = `<path d="M36 ${f(top - 13)} L37.2 ${f(top - 9.5)} L36 ${f(top - 7)} L34.8 ${f(top - 9.5)} Z" fill="white" opacity="${f(p.crown)}"/>\n`;
	const arch = `<path d="M3 ${f(BASE_Y)} C3 6 69 6 69 ${f(BASE_Y)}" fill="none" stroke="darkgray" stroke-opacity="${f(p.arch)}" stroke-width=".8" stroke-dasharray="3 2"/>\n`;
	const floor = `<rect x="0" y="${f(BASE_Y)}" width="72" height="6" fill="url(#fl)" opacity="${f(p.arch)}"/>\n`;
	const ey = top + 2.4;
	const eyes = `<circle cx="33.8" cy="${f(ey)}" r="${f(p.eyes.r)}" fill="white" opacity="${f(p.eyes.o)}"/><circle cx="38.2" cy="${f(ey)}" r="${f(p.eyes.r)}" fill="white" opacity="${f(p.eyes.o)}"/>`;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${D.w}" height="${D.h}" viewBox="0 0 ${D.w} ${D.h}">\n` +
		`<defs><filter id="h" filterUnits="userSpaceOnUse" x="-10" y="-10" width="92" height="83"><feGaussianBlur stdDeviation="2.4"/></filter>\n` +
		`<linearGradient id="fl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="white" stop-opacity=".5"/><stop offset="1" stop-color="white" stop-opacity="0"/></linearGradient>\n` +
		`<g id="s" stroke="white" stroke-linejoin="round">\n${blocks}${ghost}${crown}</g></defs>\n` +
		`<g opacity="${f(p.dim)}">${arch}${floor}<use xlink:href="#s" filter="url(#h)" opacity="${f(p.glow)}"/><use xlink:href="#s"/></g>\n` +
		`<g id="accent">\n<g opacity="${f(p.dim)}">${eyes}</g>\n${p.sparks.map(sparkPath).join("\n")}\n</g>\n` +
		`</svg>\n`
	);
}

// ---------------------------------------------------------------- background
const BG = { w: 432, h: 90 };
interface BgPose { pulse: number[]; tips: number[] }
function bgSvg(p: BgPose): string {
	// Strata: soft bands of soil, darker below; a tunnel whose floor (y 77) is the column's ground on a 5-row stage.
	let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${BG.w}" height="${BG.h}" viewBox="0 0 ${BG.w} ${BG.h}">\n`;
	s += `<defs><filter id="b" filterUnits="userSpaceOnUse" x="-10" y="-10" width="452" height="110"><feGaussianBlur stdDeviation="1.6"/></filter>\n`;
	s += `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(40%,40%,40%)" stop-opacity="0"/><stop offset=".5" stop-color="rgb(40%,40%,40%)" stop-opacity=".12"/><stop offset="1" stop-color="dimgray" stop-opacity=".22"/></linearGradient>\n`;
	s += `<linearGradient id="r" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="18"><stop offset="0" stop-color="rgb(80%,80%,80%)" stop-opacity="0"/><stop offset="1" stop-color="rgb(80%,80%,80%)" stop-opacity="1"/></linearGradient></defs>\n`;
	s += `<rect x="0" y="0" width="432" height="90" fill="url(#g)"/>\n`;
	// Strata lines.
	const strata = [
		"M0 20 C60 17 110 23 170 20 C230 17 300 22 360 19 C390 18 415 20 432 19",
		"M0 41 C50 44 120 38 190 42 C250 45 320 39 380 42 C405 43 420 41 432 42",
		"M0 85 C70 83 140 87 210 85 C280 83 350 87 432 85",
	];
	s += `<path d="${strata.join(" ")}" fill="none" stroke="rgb(60%,60%,60%)" stroke-opacity=".14" stroke-width=".8"/>\n`;
	// The tunnel: a darker hollow with a faint floor.
	s += `<path d="M0 54 C80 51 160 55 240 52 C320 50 380 53 432 52 L432 77 C350 78 280 76 200 77 C120 78 60 76 0 77 Z" fill="rgb(0%,0%,0%)" fill-opacity=".35"/>\n`;
	s += `<path d="M0 77 C60 76 120 78 200 77 C280 76 350 78 432 77" fill="none" stroke="darkgray" stroke-opacity=".22" stroke-width=".7"/>\n`;
	// Pebbles.
	let pebbles = "";
	const rnd = (i: number): number => {
		const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
		return x - Math.floor(x);
	};
	for (let i = 0; i < 34; i++) {
		const x = rnd(i) * 432;
		let y = 4 + rnd(i + 50) * 82;
		if (y > 47 && y < 80) y = y < 62 ? 45 - rnd(i + 9) * 22 : 81 + rnd(i + 9) * 6;
		const r = 0.8 + rnd(i + 99) * 1.6;
		pebbles += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(r * 1.4)}" ry="${f(r)}"/>`;
	}
	s += `<g fill="gray" fill-opacity=".16">${pebbles}</g>\n`;
	// Roots from the top, each a faint line of light; a pulse travels down and the tip glows.
	const roots = [
		{ x: 40, d: "M40 0 C42 10 36 18 41 28 C44 34 40 40 43 46" , tip: [43, 46] },
		{ x: 128, d: "M128 0 C124 8 131 14 127 22 C124 28 129 32 126 38", tip: [126, 38] },
		{ x: 205, d: "M205 0 C209 9 202 17 207 26 C210 33 205 40 209 48", tip: [209, 48] },
		{ x: 300, d: "M300 0 C297 7 303 13 299 20 C296 26 300 30 298 34", tip: [298, 34] },
		{ x: 372, d: "M372 0 C376 10 369 19 374 29 C377 36 372 41 375 47", tip: [375, 47] },
	];
	const side = [
		"M41 28 C46 30 50 29 54 33", "M127 22 C121 24 118 23 114 27", "M207 26 C213 27 216 30 219 30", "M299 20 C305 22 307 21 311 24", "M374 29 C368 31 366 30 362 34",
	];
	roots.forEach((r, i) => {
		s += `<path d="${r.d} ${side[i]}" fill="none" stroke="url(#r)" stroke-opacity="${f(0.12 + 0.18 * p.pulse[i]!)}" stroke-width=".9" stroke-linecap="round"/>\n`;
		s += `<circle cx="${r.tip[0]}" cy="${r.tip[1]}" r="${f(1.6 + 1.2 * p.tips[i]!)}" fill="white" fill-opacity="${f(0.15 + 0.4 * p.tips[i]!)}" filter="url(#b)"/>\n`;
	});
	s += `</svg>\n`;
	return s;
}

// ---------------------------------------------------------------- writing
interface Key { at: number; svg: string; ease?: string }
function sequence(actor: string, name: string, box: { w: number; h: number; anchor: P }, spec: { frameMs: number; durationMs: number; loop: boolean }, keys: { at: number; svg: string; ease?: string }[]): void {
	const dir = join(OUT, actor);
	mkdirSync(dir, { recursive: true });
	for (const entry of readdirSync(dir)) if (entry.startsWith(`${name}.`)) rmSync(join(dir, entry));
	const names = new Map<string, string>();
	const out: Key[] = [];
	let letter = 0;
	for (const k of keys) {
		let file = names.get(k.svg);
		if (file === undefined) {
			file = `${name}.${String.fromCharCode(97 + letter++)}.svg`;
			names.set(k.svg, file);
			writeFileSync(join(dir, file), k.svg);
		}
		out.push({ at: k.at, svg: file, ...(k.ease === undefined ? {} : { ease: k.ease }) });
	}
	writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ w: box.w, h: box.h, anchor: box.anchor, frameMs: spec.frameMs, durationMs: spec.durationMs, loop: spec.loop, keys: out }, null, "\t")}\n`);
}

const only = process.argv[2];
if (only === undefined) rmSync(OUT, { recursive: true, force: true });
const want = (name: string): boolean => only === undefined || only.split(",").includes(name);

const PLAIN = { stone: false, sparks: 0 };
type K = [number, AntPose, string?];
function worker(name: string, spec: { frameMs: number; durationMs: number; loop: boolean }, keys: K[], opts = PLAIN): void {
	if (!want(`worker/${name}`)) return;
	sequence("worker", name, W, spec, keys.map(([at, p, ease]) => ({ at, svg: antSvg(p, opts), ...(ease === undefined ? {} : { ease }) })));
}
function director(name: string, spec: { frameMs: number; durationMs: number; loop: boolean }, keys: [number, DirPose, string?][]): void {
	if (!want(`director/${name}`)) return;
	sequence("director", name, D, spec, keys.map(([at, p, ease]) => ({ at, svg: dirSvg(p), ...(ease === undefined ? {} : { ease }) })));
}
const FRAME = 83;
const LIFT = 2.4;
const STRIDE = 2.2;
const ANT_TAP = { a1: 52, a2: -10 };

// ---------------------------------------------------------------- worker
// work: 5 beats of 420 ms; three walking beats carrying, the stack beat, the release and pick-up beat.
{
	const c = carried();
	const k: K[] = [
		[0, pose({ feet: gait(0, -STRIDE, 0, STRIDE, 0), piece: c })],
		[210, pose({ by: -0.4, feet: gait(0, 0, 0, 0, LIFT), piece: carried({ y: 20.2 }), near: { a1: 62, a2: 12 } })],
		[420, pose({ feet: gait(0, STRIDE, 0, -STRIDE, 0), piece: c })],
		[630, pose({ by: -0.4, feet: gait(0, 0, LIFT, 0, 0), piece: carried({ y: 20.2 }), far: { a1: 72, a2: 28 } })],
		[840, pose({ feet: gait(0, -STRIDE, 0, STRIDE, 0), piece: c })],
		[1050, pose({ by: -0.4, feet: gait(0, 0, 0, 0, LIFT), piece: carried({ y: 20.2 }), near: { a1: 62, a2: 12 } })],
		[1260, pose({ feet: gait(0, STRIDE, 0, -STRIDE, 0), piece: c })],
		// Stack: rear up and push the piece up onto the build ahead.
		[1470, pose({ bx: -2.2, by: -1.4, tilt: 16, head: 14, gaster: -10, feet: gait(0, STRIDE, 0, -STRIDE, 0), piece: carried({ x: 4.5, y: 8.5, r: -8 }), near: { a1: 80, a2: 50 }, far: { a1: 88, a2: 60 }, glow: 0.8 })],
		// Released: the piece goes on ahead and is gone; the head comes down.
		[1680, pose({ bx: -1, tilt: -4, head: -8, feet: gait(0, STRIDE, 0, -STRIDE, 0), piece: carried({ x: 0.5, y: 3, r: -14, fo: 0, so: 0 }), near: { a1: 60, a2: 14 }, far: { a1: 70, a2: 26 } })],
		// The same moment with the hidden piece moved down to the floor, where the next one is picked up.
		[1680, pose({ bx: -1, tilt: -4, head: -8, feet: gait(0, STRIDE, 0, -STRIDE, 0), piece: carried({ x: 6.5, y: 27.6, r: 0, fo: 0, so: 0 }), near: { a1: 60, a2: 14 }, far: { a1: 70, a2: 26 } })],
		// Pick up the next piece from the floor.
		[1890, pose({ bx: -0.5, tilt: -6, head: -22, gaster: 4, feet: gait(0, 0, LIFT, 0, 0), piece: carried({ x: 6.5, y: 27.4, fo: 0.9, so: 1 }), near: ANT_TAP, far: { a1: 60, a2: 0 } })],
		[2100, pose({ feet: gait(0, -STRIDE, 0, STRIDE, 0), piece: c })],
	];
	worker("work", { frameMs: FRAME, durationMs: 2100, loop: true }, k);
}

// ready: marching in place at the back of the column, piece held, a slow breath.
{
	const piece = carried({ fo: 0.6, so: 0.75 });
	const still = (by: number, glow: number): AntPose => pose({ by, glow, feet: gait(0, 0, 0, 0, 0), piece });
	worker("ready", { frameMs: 113, durationMs: 3400, loop: true }, [
		[0, still(0, 0.45)],
		[425, pose({ by: -0.5, glow: 0.5, feet: gait(0, 0, LIFT * 0.9, 0, 0), piece: carried({ fo: 0.6, so: 0.75, y: 20.1 }), near: { a1: 64, a2: 16 } })],
		[850, still(0, 0.55)],
		[1275, pose({ by: -0.5, glow: 0.6, feet: gait(0, 0, 0, 0, LIFT * 0.9), piece: carried({ fo: 0.6, so: 0.75, y: 20.1 }), far: { a1: 74, a2: 30 } })],
		[1700, still(0, 0.6)],
		[2125, pose({ by: -0.5, glow: 0.55, feet: gait(0, 0, LIFT * 0.9, 0, 0), piece: carried({ fo: 0.6, so: 0.75, y: 20.1 }), near: { a1: 64, a2: 16 } })],
		[2550, still(0, 0.5)],
		[2975, pose({ by: -0.5, glow: 0.45, feet: gait(0, 0, 0, 0, LIFT * 0.9), piece: carried({ fo: 0.6, so: 0.75, y: 20.1 }), far: { a1: 74, a2: 30 } })],
		[3400, still(0, 0.45)],
	]);
}

// quiet: fine work on a piece on the floor, half the amplitude.
{
	const floorPiece = (fo: number, y = 27.6): Piece => carried({ x: 6.3, y, fo, so: 1 });
	const bent = (head: number, near: { a1: number; a2: number }, far: { a1: number; a2: number }, y: number, glow: number): AntPose =>
		pose({ tilt: -5, head, gaster: 4, near, far, feet: gait(0, -0.6, 0, 0.6, 0), piece: floorPiece(0.85, y), glow });
	worker("quiet", { frameMs: FRAME, durationMs: 2000, loop: true }, [
		[0, bent(-16, { a1: 40, a2: -20 }, { a1: 50, a2: -8 }, 27.6, 0.5)],
		[500, bent(-21, { a1: 36, a2: -30 }, { a1: 54, a2: -4 }, 27.8, 0.6)],
		[1000, bent(-16, { a1: 44, a2: -14 }, { a1: 46, a2: -16 }, 27.6, 0.5)],
		[1500, bent(-21, { a1: 40, a2: -24 }, { a1: 52, a2: -26 }, 27.8, 0.6)],
		[2000, bent(-16, { a1: 40, a2: -20 }, { a1: 50, a2: -8 }, 27.6, 0.5)],
	]);
}

// submit: rear up and hold the piece over the column, half transparent: placed on top, not yet locked.
const REAR = (over: Partial<AntPose> = {}): AntPose =>
	pose({ bx: -1.4, by: -1.6, tilt: 20, head: 12, gaster: -12, feet: gait(0, 0.6, 0, -0.6, 0), piece: carried({ x: 5.2, y: 6.4, fo: 0.3, so: 0.95, s: 1.15 }), near: { a1: 84, a2: 56 }, far: { a1: 92, a2: 64 }, glow: 0.75, ...over });
worker("submit", { frameMs: FRAME, durationMs: 900, loop: false }, [
	[0, pose({ piece: carried() })],
	[380, REAR({ by: -2.2, piece: carried({ x: 4.8, y: 5.2, fo: 0.45, so: 1, s: 1.15 }), glow: 0.9 }), "out"],
	[900, REAR()],
]);

// review: the piece held out while the antennae sweep over it.
{
	const held = (fo: number): Piece => carried({ x: 5.6, y: 16.5, fo, so: 1, s: 1.1 });
	const scan = (near: { a1: number; a2: number }, far: { a1: number; a2: number }, fo: number): AntPose =>
		pose({ tilt: 6, head: 8, feet: gait(0, -0.4, 0, 0.4, 0), piece: held(fo), near, far, glow: 0.55 + fo * 0.2 });
	worker("review", { frameMs: FRAME, durationMs: 2900, loop: true }, [
		[0, scan({ a1: 70, a2: -40 }, { a1: 84, a2: -10 }, 0.7)],
		[725, scan({ a1: 46, a2: -62 }, { a1: 64, a2: -30 }, 0.95)],
		[1450, scan({ a1: 30, a2: -70 }, { a1: 50, a2: -50 }, 0.7)],
		[2175, scan({ a1: 52, a2: -56 }, { a1: 70, a2: -22 }, 0.95)],
		[2900, scan({ a1: 70, a2: -40 }, { a1: 84, a2: -10 }, 0.7)],
	]);
}

// accepted: the half-transparent piece locks, flashes and flies to the build; dust sparkles; the ant settles.
{
	const dust = (x: number, y: number, spread: number, r: number, o: number): Spark[] => [
		{ x: x - spread, y: y - spread * 0.4, r, o },
		{ x: x + spread * 0.8, y: y - spread * 0.7, r: r * 0.8, o },
		{ x: x + spread * 0.3, y: y + spread * 0.7, r: r * 0.7, o },
		{ x: x - spread * 0.6, y: y + spread * 0.9, r: r * 0.6, o: o * 0.8 },
	];
	const opts = { stone: false, sparks: 4 };
	worker("accepted", { frameMs: FRAME, durationMs: 1300, loop: false }, [
		[0, REAR({ sparks: dust(5.2, 6.4, 0.5, 0.2, 0) })],
		[300, REAR({ piece: carried({ x: 4.6, y: 5.8, fo: 1, so: 1, s: 1.2 }), sparks: dust(5, 6, 3.2, 2.2, 1), glow: 1 }), "in"],
		[750, pose({ bx: -0.6, tilt: 6, head: 6, feet: gait(0, 0.3, 0, -0.3, 0), piece: carried({ x: -2, y: 2, r: -30, fo: 0, so: 0, s: 0.6 }), near: { a1: 74, a2: 34 }, far: { a1: 82, a2: 44 }, sparks: dust(4, 7, 6, 1.4, 0.7), glow: 0.8 }), "out"],
		[1300, pose({ near: { a1: 66, a2: 24 }, far: { a1: 76, a2: 34 }, sparks: dust(3, 8, 8, 0.4, 0), glow: 0.6 })],
	], opts);
}

// unmet: the piece tumbles down, the ant picks it up again.
worker("unmet", { frameMs: FRAME, durationMs: 600, loop: false }, [
	[0, pose({ piece: carried() })],
	[130, pose({ bx: 0.8, tilt: 8, head: 10, piece: carried({ x: 3.5, y: 15, r: -50 }), near: { a1: 80, a2: 50 }, far: { a1: 86, a2: 58 }, glow: 0.75 }), "out"],
	[380, pose({ bx: 0.2, tilt: -6, head: -22, gaster: 4, piece: carried({ x: 5.4, y: 27.6, r: -90 }), near: ANT_TAP, far: { a1: 60, a2: 0 } }), "inOut"],
	[600, pose({ piece: carried() }), "inOut"],
]);

// blocked: stopped before a stone, antennae probing for a way round, then frozen.
{
	const opts = { stone: true, sparks: 1 };
	const at = (over: Partial<AntPose>): AntPose => pose({ bx: 1.4, stone: 1, piece: carried({ x: 8.6 }), feet: gait(1.4, -0.4, 0, 0.4, 0), sparks: [{ x: 12.6, y: 20.8, r: 0.1, o: 0 }], ...over });
	worker("blocked", { frameMs: FRAME, durationMs: 1600, loop: false }, [
		[0, at({ bx: 0.4, feet: gait(0.4, -0.4, 0, 0.4, 0), piece: carried({ x: 7.6 }), near: { a1: 40, a2: 0 }, far: { a1: 50, a2: 10 } })],
		[180, at({ bx: 2.2, tilt: 5, head: 4, piece: carried({ x: 9.4, y: 20.2 }), near: { a1: 44, a2: 10 }, far: { a1: 54, a2: 18 }, sparks: [{ x: 12.4, y: 20.4, r: 2.6, o: 1 }] }), "out"],
		[600, at({ tilt: 4, head: 14, near: { a1: 70, a2: 56 }, far: { a1: 84, a2: 70 }, sparks: [{ x: 12.4, y: 20.4, r: 1.4, o: 0.6 }] })],
		[1000, at({ tilt: 0, head: -10, near: { a1: 30, a2: -40 }, far: { a1: 70, a2: 40 }, sparks: [{ x: 12.4, y: 20.4, r: 0.8, o: 0.3 }] })],
		[1600, at({ tilt: 3, head: 6, near: { a1: 60, a2: 88 }, far: { a1: 40, a2: -30 }, sparks: [{ x: 12.4, y: 20.4, r: 0.6, o: 0.25 }] })],
	], opts);
}

// excluded (also the column's exit in a handoff): it lets the piece go, folds and backs off, dim.
worker("excluded", { frameMs: FRAME, durationMs: 1200, loop: false }, [
	[0, pose({ piece: carried() })],
	[800, pose({ bx: 3.5, by: 2, tilt: -4, head: -18, gaster: 6, feet: gait(3.5, 0, 0, 0, 0, 0.45, 29), piece: carried({ x: 6, y: 28, fo: 0.3, so: 0.4 }), near: { a1: -150, a2: -170 }, far: { a1: -140, a2: -165 }, glow: 0.15, dim: 0.45 }), "out"],
	[1200, pose({ bx: 6, by: 2.4, tilt: -4, head: -18, gaster: 6, feet: gait(6, 0, 0, 0, 0, 0.45, 29), piece: carried({ x: 6, y: 28, fo: 0.15, so: 0.25 }), near: { a1: -150, a2: -170 }, far: { a1: -140, a2: -165 }, glow: 0.1, dim: 0.3 }), "inOut"],
]);

// gather: the column files in from the right, piece held, legs walking.
{
	const walk = (sx: number, phase: number, dim: number): AntPose => {
		const a = phase % 2 === 0 ? -STRIDE : STRIDE;
		return pose({ bx: sx, feet: gait(sx, a, 0, -a, 0), piece: carried({ x: 7.2 + sx, fo: 0.95 * dim, so: dim }), dim, glow: 0.6 * dim });
	};
	const swing = (sx: number, lift: "a" | "b", dim: number): AntPose =>
		pose({ bx: sx, by: -0.4, feet: gait(sx, 0, lift === "a" ? LIFT : 0, 0, lift === "b" ? LIFT : 0), piece: carried({ x: 7.2 + sx, y: 20.2, fo: 0.95 * dim, so: dim }), dim, glow: 0.6 * dim });
	worker("gather", { frameMs: FRAME, durationMs: 1200, loop: false }, [
		[0, walk(10, 0, 0)],
		[200, swing(8.5, "b", 0.4), "linear"],
		[400, walk(7, 1, 0.75), "linear"],
		[600, swing(5, "a", 0.95), "linear"],
		[800, walk(3, 0, 1), "linear"],
		[1000, swing(1.6, "b", 1), "out"],
		[1200, pose({ piece: carried() }), "inOut"],
	]);
}

// rest (idle): lowered, legs splayed, antennae down, a slow breath.
{
	const rest = (glow: number, by: number, a: number): AntPose =>
		pose({ by, tilt: -3, head: -10, gaster: 8, feet: gait(0, 0, 0, 0, 0, 1.15), near: { a1: 20 + a, a2: -50 }, far: { a1: 30 + a, a2: -40 }, glow });
	worker("rest", { frameMs: 113, durationMs: 3400, loop: true }, [
		[0, rest(0.3, 1.6, 0)],
		[1700, rest(0.45, 1.2, 6)],
		[3400, rest(0.3, 1.6, 0)],
	]);
}

// waiting-user: everyone stops, head up toward the viewer, piece held.
{
	const still = pose({ tilt: 4, head: 10, feet: gait(0, -0.3, 0, 0.3, 0), piece: carried({ y: 20 }), near: { a1: 78, a2: 52 }, far: { a1: 86, a2: 62 }, glow: 0.55 });
	worker("waiting-user", { frameMs: 2400, durationMs: 2400, loop: true }, [[0, still], [2400, still]]);
}

// finale: place the last piece up ahead, step back, look up at the build.
{
	const look = (over: Partial<AntPose>): AntPose =>
		pose({ bx: 3.4, tilt: 12, head: 16, gaster: -6, feet: gait(3.4, 0, 0, 0, 0), near: { a1: 84, a2: 58 }, far: { a1: 92, a2: 66 }, glow: 0.8, ...over });
	worker("finale", { frameMs: FRAME, durationMs: 2200, loop: false }, [
		[0, pose({ piece: carried() })],
		[650, REAR({ piece: carried({ x: 4.6, y: 5.8, fo: 1, so: 1, s: 1.15 }), glow: 1 }), "inOut"],
		[1000, REAR({ piece: carried({ x: -1, y: 1.5, r: -20, fo: 0, so: 0, s: 0.7 }), glow: 0.9 }), "in"],
		[1350, pose({ bx: 1.6, by: -0.4, feet: gait(1.6, 0, LIFT, 0, 0), near: { a1: 70, a2: 40 }, far: { a1: 80, a2: 50 } }), "inOut"],
		[1700, look({ feet: gait(3.4, 0, 0, 0, LIFT) }), "inOut"],
		[2200, look({ glow: 0.95 }), "out"],
	]);
}

// lights-out: holding the piece that is left, looking at the build while the light goes.
{
	const look = (glow: number, dim: number, head: number): AntPose =>
		pose({ tilt: 4, head, piece: carried({ y: 20.2, fo: 0.8 }), near: { a1: 70, a2: 36 }, far: { a1: 80, a2: 46 }, glow, dim });
	worker("lights-out", { frameMs: 166, durationMs: 4000, loop: false }, [
		[0, look(0.6, 1, 4)],
		[1800, look(0.35, 0.8, 10)],
		[4000, look(0.15, 0.55, 6)],
	]);
}

// user-steer: stop, face the viewer, a nod of the antennae, back to work.
{
	const face = (head: number, near: { a1: number; a2: number }, far: { a1: number; a2: number }, glow: number): AntPose =>
		pose({ tilt: 6, head, piece: carried({ y: 20 }), near, far, glow });
	worker("user-steer", { frameMs: FRAME, durationMs: 900, loop: false }, [
		[0, pose({ piece: carried() })],
		[220, face(14, { a1: 86, a2: 70 }, { a1: 94, a2: 78 }, 0.8), "out"],
		[440, face(-4, { a1: 62, a2: 20 }, { a1: 70, a2: 30 }, 0.7), "inOut"],
		[620, face(10, { a1: 80, a2: 60 }, { a1: 88, a2: 68 }, 0.75), "inOut"],
		[900, pose({ piece: carried() }), "inOut"],
	]);
}

// user-stop: put the piece down, step out of the column and walk off the stage (down and back).
{
	const away = (sx: number, by: number, lift: "a" | "b" | "", dim: number): AntPose =>
		pose({ bx: sx, by, tilt: -6, feet: gait(sx, 0, lift === "a" ? LIFT : 0, 0, lift === "b" ? LIFT : 0, 1, 30 + by), piece: carried({ x: 6.3, y: 27.6, fo: 0.85, so: 1 }), near: { a1: 50, a2: 0 }, far: { a1: 60, a2: 10 }, dim, glow: 0.5 * dim });
	worker("user-stop", { frameMs: FRAME, durationMs: 1200, loop: false }, [
		[0, pose({ piece: carried() })],
		[300, pose({ tilt: -6, head: -22, gaster: 4, piece: carried({ x: 6.3, y: 27.6, fo: 0.85, so: 1 }), near: ANT_TAP, far: { a1: 60, a2: 0 } }), "inOut"],
		[550, away(3, 0.8, "a", 0.9), "inOut"],
		[800, away(7, 2, "b", 0.6), "linear"],
		[1000, away(9.5, 3.2, "a", 0.3), "linear"],
		[1200, away(12, 4.4, "", 0), "linear"],
	]);
}

// ---------------------------------------------------------------- director
const N = 6;
const band = (row: number, base: number, amp: number): number[] => Array.from({ length: N }, (_, i) => base + amp * Math.max(0, 1 - Math.abs(i - row) * 0.9));
// work: one row lights each 420 ms beat, bottom to top, while the slot on top waits for the next piece.
director("work", { frameMs: FRAME, durationMs: 2520, loop: true }, [
	[0, dirPose({ rows: band(-1, 0.5, 0.5), ghost: { y: 0, fo: 0.08, so: 0.35 } })],
	[420, dirPose({ rows: band(0, 0.5, 0.5), ghost: { y: 0, fo: 0.1, so: 0.4 } })],
	[840, dirPose({ rows: band(1, 0.5, 0.5), ghost: { y: 0, fo: 0.12, so: 0.45 } })],
	[1260, dirPose({ rows: band(2, 0.5, 0.5), ghost: { y: 26.5, fo: 0.16, so: 0.55 } })],
	[1680, dirPose({ rows: band(3, 0.5, 0.5), ghost: { y: 26.5, fo: 0.2, so: 0.65 }, eyes: { r: 1, o: 0.65 } })],
	[2100, dirPose({ rows: band(4, 0.5, 0.5), ghost: { y: 0, fo: 0.18, so: 0.6 }, glow: 0.8 })],
	[2520, dirPose({ rows: band(6, 0.5, 0.5), ghost: { y: 0, fo: 0.08, so: 0.35 } })],
]);
// waiting-user: everything holds, the two lights at the top open wide (amber).
{
	const hold = (r: number, o: number): DirPose => dirPose({ rows: band(-1, 0.5, 0), eyes: { r, o }, ghost: { y: 0, fo: 0.08, so: 0.35 } });
	director("waiting-user", { frameMs: FRAME, durationMs: 2400, loop: true }, [
		[0, hold(1.6, 0.8)],
		[1200, hold(1.9, 1)],
		[2400, hold(1.6, 0.8)],
	]);
}
// finale: the last piece comes down into the slot, locks, a glow runs up the build, a light on top.
{
	const top: Spark[] = [
		{ x: 36, y: 13, r: 0.1, o: 0 }, { x: 29, y: 15, r: 0.1, o: 0 }, { x: 43, y: 15, r: 0.1, o: 0 }, { x: 33, y: 9, r: 0.1, o: 0 }, { x: 40, y: 9, r: 0.1, o: 0 },
	];
	const burst = (r: number, o: number): Spark[] => [
		{ x: 36, y: 10, r: r * 1.2, o }, { x: 26, y: 14, r, o }, { x: 46, y: 14, r, o }, { x: 30, y: 5, r: r * 0.8, o }, { x: 42, y: 5, r: r * 0.8, o },
	];
	director("finale", { frameMs: FRAME, durationMs: 2200, loop: false }, [
		[0, dirPose({ rows: band(-1, 0.5, 0), ghost: { y: -13, fo: 0.3, so: 0.7 }, sparks: top })],
		[600, dirPose({ rows: band(-1, 0.5, 0), ghost: { y: 0, fo: 0.6, so: 1 }, sparks: top }), "in"],
		[850, dirPose({ rows: band(5, 0.55, 0.45), ghost: { y: 0, fo: 0.95, so: 1 }, sparks: burst(2.6, 1), glow: 0.95, eyes: { r: 1.1, o: 0.9 } }), "out"],
		[1300, dirPose({ rows: band(2.5, 0.75, 0.25), ghost: { y: 0, fo: 0.9, so: 1 }, sparks: burst(1.6, 0.6), glow: 1, crown: 0.5 })],
		[1700, dirPose({ rows: band(0, 0.8, 0.2), ghost: { y: 0, fo: 0.85, so: 1 }, sparks: burst(0.8, 0.2), glow: 1, crown: 0.9 })],
		[2200, dirPose({ rows: band(-2, 0.8, 0), ghost: { y: 0, fo: 0.8, so: 1 }, sparks: burst(0.4, 0), glow: 0.9, crown: 0.8, eyes: { r: 1, o: 0.8 } })],
	]);
}
// lights-out: the build dims; the empty slot on top stays as a faint outline.
director("lights-out", { frameMs: 166, durationMs: 4000, loop: false }, [
	[0, dirPose({ rows: band(-1, 0.5, 0), ghost: { y: 0, fo: 0.1, so: 0.45 } })],
	[1600, dirPose({ rows: band(-1, 0.32, 0), ghost: { y: 0, fo: 0.06, so: 0.4 }, glow: 0.45, eyes: { r: 0.8, o: 0.3 }, arch: 0.2 })],
	[4000, dirPose({ rows: band(-1, 0.15, 0), ghost: { y: 0, fo: 0.03, so: 0.3 }, glow: 0.2, eyes: { r: 0.7, o: 0.12 }, dim: 0.75, arch: 0.12 })],
]);
// rest (between rounds): the build rests dim; only the top block breathes slowly.
{
	const breath = (top: number, eyes: number, glow: number): DirPose =>
		dirPose({ rows: [0.22, 0.22, 0.22, 0.22, 0.24, top], ghost: { y: 0, fo: 0.04, so: 0.25 }, eyes: { r: 0.8, o: eyes }, glow, arch: 0.18 });
	director("rest", { frameMs: 113, durationMs: 3400, loop: true }, [
		[0, breath(0.25, 0.25, 0.4)],
		[1700, breath(0.85, 0.5, 0.55)],
		[3400, breath(0.25, 0.25, 0.4)],
	]);
}
// excluded (leaving): the build sinks into the ground, as if under water, top row last.
director("excluded", { frameMs: FRAME, durationMs: 1200, loop: false }, [
	[0, dirPose()],
	[500, dirPose({ sink: 8, rows: band(-1, 0.4, 0), glow: 0.5, eyes: { r: 0.8, o: 0.35 }, ghost: { y: 0, fo: 0.05, so: 0.2 }, dim: 0.8 }), "in"],
	[1200, dirPose({ sink: 22, rows: band(-1, 0.25, 0), rowOp: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], glow: 0.2, eyes: { r: 0.6, o: 0 }, ghost: { y: 0, fo: 0, so: 0 }, dim: 0.35, arch: 0.1 })],
]);
// gather (arriving): the build rises row by row out of the soil.
director("gather", { frameMs: FRAME, durationMs: 1200, loop: false }, [
	[0, dirPose({ sink: 0, rowDrop: [12, 20, 28, 36, 44, 52], rowOp: [0, 0, 0, 0, 0, 0], rows: band(-1, 0.3, 0), glow: 0.2, eyes: { r: 0.5, o: 0 }, ghost: { y: 0, fo: 0, so: 0 }, arch: 0 })],
	[500, dirPose({ rowDrop: [0, 3, 12, 22, 32, 42], rowOp: [1, 0.8, 0.4, 0.15, 0, 0], rows: band(0, 0.4, 0.5), glow: 0.5, eyes: { r: 0.5, o: 0 }, ghost: { y: 0, fo: 0, so: 0 }, arch: 0.15 }), "out"],
	[900, dirPose({ rowDrop: [0, 0, 0, 2, 6, 12], rowOp: [1, 1, 1, 0.8, 0.6, 0.4], rows: band(3, 0.5, 0.5), glow: 0.7, eyes: { r: 0.7, o: 0.3 }, ghost: { y: 0, fo: 0.04, so: 0.2 } }), "out"],
	[1200, dirPose({ rows: band(6, 0.5, 0.5) }), "out"],
]);

// ---------------------------------------------------------------- background
if (want("fx/background")) {
	const k = (pulse: number[], tips: number[]): string => bgSvg({ pulse, tips });
	sequence("fx", "background", { w: BG.w, h: BG.h, anchor: { x: 0, y: 0 } }, { frameMs: 400, durationMs: 4800, loop: true }, [
		{ at: 0, svg: k([0.2, 1, 0.4, 0, 0.7], [0.3, 0.8, 0.2, 0.1, 1]) },
		{ at: 1600, svg: k([0.9, 0.3, 0, 0.7, 0.2], [1, 0.2, 0.3, 0.8, 0.3]) },
		{ at: 3200, svg: k([0.3, 0, 1, 0.4, 0.5], [0.2, 0.3, 1, 0.4, 0.2]) },
		{ at: 4800, svg: k([0.2, 1, 0.4, 0, 0.7], [0.3, 0.8, 0.2, 0.1, 1]) },
	]);
}
