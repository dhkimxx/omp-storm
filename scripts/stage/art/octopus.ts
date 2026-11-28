/**
 * The octopus's art generator: writes every key-pose SVG and sequence spec under assets/stage/src/octopus (director,
 * worker, fx/background) from a few parametric parts, so the poses share one drawing. The written SVGs are what the
 * bake reads; edit the parameters here and regenerate rather than hand-editing them.
 *
 *   bun scripts/stage/art/octopus.ts
 *   bun scripts/stage/bake.ts --only octopus --no-write --contact /tmp/octopus
 *
 * Director: a luminous mantle with two eyes (the accent layer, amber while waiting for the user), four short arm roots
 * and the result orb. Worker: one curled arm tip with glowing suckers and the light piece it shapes; the scene draws the
 * arm from the body to the tip's anchor. Background: a dim sea floor, slow currents, drifting motes.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../../assets/stage/src/octopus/", import.meta.url));
const f = (n: number): string => {
	const r = Math.round(n * 100) / 100;
	return r === 0 ? "0" : String(r);
};
const grey = (pct: number): string => `rgb(${f(pct)}%,${f(pct)}%,${f(pct)}%)`;
/** Coordinates at a tenth of a T1 pixel. */
const c = (n: number): string => {
	const r = Math.round(n * 10) / 10;
	return r === 0 ? "0" : String(r);
};
const rad = (deg: number): number => (deg * Math.PI) / 180;
type P = [number, number];

/** Catmull-Rom through `pts` as cubic Béziers (open or closed). */
function smooth(pts: P[], closed: boolean): string {
	const n = pts.length;
	const at = (i: number): P => (closed ? pts[(i + n) % n]! : pts[Math.max(0, Math.min(n - 1, i))]!);
	let d = `M${c(pts[0]![0])} ${c(pts[0]![1])}`;
	const segs = closed ? n : n - 1;
	for (let i = 0; i < segs; i++) {
		const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
		const c1: P = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
		const c2: P = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
		d += ` C${c(c1[0])} ${c(c1[1])} ${c(c2[0])} ${c(c2[1])} ${c(p2[0])} ${c(p2[1])}`;
	}
	return closed ? `${d} Z` : d;
}

interface Tentacle { x: number; y: number; phi: number; len: number; curl: number; w0: number; taper?: number; power?: number }
interface Shape { outline: string; spine: string; pts: P[]; phis: number[]; widths: number[]; inner: number }

/** A tapered arm: heading `phi` (deg, screen), turning by `curl` degrees towards the tip (positive turns anticlockwise on screen). */
function tentacle(t: Tentacle, n = 12): Shape {
	const power = t.power ?? 1.6;
	const taper = t.taper ?? 0.82;
	const pts: P[] = [];
	const phis: number[] = [];
	const widths: number[] = [];
	let x = t.x, y = t.y;
	const ds = t.len / (n - 1);
	for (let i = 0; i < n; i++) {
		const s = i / (n - 1);
		const phi = rad(t.phi - t.curl * s ** power);
		if (i > 0) {
			const mid = rad(t.phi - t.curl * ((i - 0.5) / (n - 1)) ** power);
			x += Math.cos(mid) * ds;
			y += Math.sin(mid) * ds;
		}
		pts.push([x, y]);
		phis.push(phi);
		widths.push(t.w0 * (1 - taper * s));
	}
	const inner = t.curl >= 0 ? 1 : -1;
	const side = (k: number): P[] =>
		pts.map(([px, py], i) => [px + k * Math.sin(phis[i]!) * (widths[i]! / 2), py - k * Math.cos(phis[i]!) * (widths[i]! / 2)]);
	const a = side(1);
	const b = side(-1).reverse();
	const tip = pts[n - 1]!;
	const tphi = phis[n - 1]!;
	const tipPt: P = [tip[0] + Math.cos(tphi) * widths[n - 1]! * 0.6, tip[1] + Math.sin(tphi) * widths[n - 1]! * 0.6];
	const outline = smooth([...a, tipPt, ...b], true);
	return { outline, spine: smooth(pts, false), pts, phis, widths, inner };
}

/** A point on the inner side of the arm at fraction s, `depth` 0 (spine) .. 1 (edge). */
function innerAt(sh: Shape, s: number, depth: number): { x: number; y: number; w: number } {
	const i = Math.min(sh.pts.length - 1, Math.round(s * (sh.pts.length - 1)));
	const [x, y] = sh.pts[i]!;
	const phi = sh.phis[i]!;
	const w = sh.widths[i]!;
	return { x: x + sh.inner * Math.sin(phi) * (w / 2) * depth, y: y - sh.inner * Math.cos(phi) * (w / 2) * depth, w };
}

// ---------------------------------------------------------------------------------------------------------------
// Director: a luminous mantle with two eyes, four short arm roots and the result orb
// ---------------------------------------------------------------------------------------------------------------

const DW = 63, DH = 72;
const CX = 31.5, CY = 30;

interface Director {
	bx: number; by: number; rot: number; sx: number; sy: number; lean: number;
	energy: number; halo: number; lantern: number; spots: number;
	eyeOpen: number; eyeR: number; eyeGlow: number; eyeDx: number; eyeDy: number; pupilDx: number; pupilDy: number; pupilW: number;
	roots: [Tentacle, Tentacle, Tentacle, Tentacle];
	ox: number; oy: number; or: number; orb: number; orbGlow: number; orbRing: number;
	alpha: number;
}

const ROOTS: Director["roots"] = [
	{ x: 20, y: 43, phi: 115, len: 24, curl: -200, w0: 4.6, power: 2.4 },
	{ x: 27, y: 46, phi: 115, len: 17, curl: 170, w0: 4.2, power: 1.6 },
	{ x: 36, y: 46, phi: 65, len: 17, curl: -170, w0: 4.2, power: 1.6 },
	{ x: 43, y: 43, phi: 65, len: 24, curl: 200, w0: 4.6, power: 2.4 },
];

const D0: Director = {
	bx: 0, by: 0, rot: 0, sx: 1, sy: 1, lean: 0,
	energy: 1, halo: 0.55, lantern: 0.55, spots: 0.7,
	eyeOpen: 1, eyeR: 3.3, eyeGlow: 0.55, eyeDx: 0, eyeDy: 0, pupilDx: 0, pupilDy: 0, pupilW: 1.9,
	roots: ROOTS,
	ox: 31.5, oy: 58, or: 4.6, orb: 0.8, orbGlow: 0.5, orbRing: 0.6,
	alpha: 1,
};

function mantle(lean: number): string {
	const W = 19, T = 9;
	return [
		`M${f(CX + lean)} ${T}`,
		`C${f(CX + lean + W * 0.6)} ${T} ${f(CX + W)} 15 ${f(CX + W)} 25`,
		`C${f(CX + W)} 33 ${f(CX + 15)} 37 ${f(CX + 14)} 42`,
		`C${f(CX + 13)} 46 ${f(CX + 6)} 47.5 ${f(CX)} 47.5`,
		`C${f(CX - 6)} 47.5 ${f(CX - 13)} 46 ${f(CX - 14)} 42`,
		`C${f(CX - 15)} 37 ${f(CX - W)} 33 ${f(CX - W)} 25`,
		`C${f(CX - W)} 15 ${f(CX + lean - W * 0.6)} ${T} ${f(CX + lean)} ${T} Z`,
	].join(" ");
}

function directorSvg(p: Director): string {
	const E = p.energy;
	const body = `translate(${f(CX + p.bx)} ${f(CY + p.by)}) rotate(${f(p.rot)}) scale(${f(p.sx)} ${f(p.sy)}) translate(${f(-CX)} ${f(-CY)})`;
	const m = mantle(p.lean);
	const roots = p.roots.map(r => tentacle(r, 8));
	const rootDefs = roots.map((sh, i) => `<path id="r${i}" d="${sh.outline}"/>`).join("");
	const rootSvg =
		`<g fill="${grey(42 * E)}" fill-opacity="0.95" stroke="${grey(88 * E)}" stroke-width="0.7">${roots.map((_, i) => `<use href="#r${i}"/>`).join("")}</g>` +
		`<g fill="none" stroke="${grey(100)}" stroke-opacity="${f(0.35 * E)}" stroke-width="0.7" stroke-linecap="round">${roots.map(sh => `<path d="${sh.spine}"/>`).join("")}</g>`;
	const rootHalo = roots.map((_, i) => `<use href="#r${i}"/>`).join("");
	const spots: [number, number, number][] = [[24, 17, 1.1], [31.5, 13.5, 1.3], [39, 17, 1.1], [27.5, 24, 0.9], [35.5, 24, 0.9]];
	const eyes = [CX - 9, CX + 9].map(ex => {
		const x = ex + p.eyeDx, y = 40.5 + p.eyeDy;
		const ry = p.eyeR * p.eyeOpen;
		return (
			`<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(p.eyeR + 1.6)}" ry="${f(ry + 1.6)}" fill="${grey(100)}" opacity="${f(p.eyeGlow)}" filter="url(#eg)"/>` +
			`<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(p.eyeR)}" ry="${f(ry)}" fill="${grey(100)}"/>` +
			`<ellipse cx="${f(x + p.pupilDx)}" cy="${f(y + p.pupilDy)}" rx="${f(p.pupilW)}" ry="${f(Math.min(0.85, ry * 0.5))}" fill="${grey(0)}"/>`
		);
	});
	const sockets = [CX - 9, CX + 9].map(ex => `<ellipse cx="${f(ex + p.eyeDx)}" cy="${f(40.5 + p.eyeDy)}" rx="${f(p.eyeR + 0.9)}" ry="${f(p.eyeR + 0.9)}" fill="${grey(4)}"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}" viewBox="0 0 ${DW} ${DH}">
<defs>
<filter id="halo" filterUnits="userSpaceOnUse" x="-12" y="-12" width="87" height="96"><feGaussianBlur stdDeviation="3.2"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-12" y="-12" width="87" height="96"><feGaussianBlur stdDeviation="1.4"/></filter>
<filter id="lamp" filterUnits="userSpaceOnUse" x="-12" y="-12" width="87" height="96"><feGaussianBlur stdDeviation="4.5"/></filter>
<filter id="eg" filterUnits="userSpaceOnUse" x="-12" y="-12" width="87" height="96"><feGaussianBlur stdDeviation="1.3"/></filter>
<radialGradient id="flesh" cx="0.5" cy="0.36" r="0.64">
<stop offset="0" stop-color="${grey(78 * E)}"/>
<stop offset="0.5" stop-color="${grey(44 * E)}"/>
<stop offset="0.84" stop-color="${grey(36 * E)}"/>
<stop offset="1" stop-color="${grey(70 * E)}"/>
</radialGradient>
<radialGradient id="pearl" cx="0.4" cy="0.36" r="0.7">
<stop offset="0" stop-color="${grey(100)}"/>
<stop offset="0.45" stop-color="${grey(92 * p.orb)}"/>
<stop offset="1" stop-color="${grey(55 * p.orb)}"/>
</radialGradient>
<path id="m" d="${m}"/>
${rootDefs}
</defs>
<g opacity="${f(p.alpha)}">
<g fill="${grey(100)}" opacity="${f(p.halo * 0.8)}" filter="url(#halo)">${rootHalo}</g>
<g transform="${body}">
<use href="#m" fill="${grey(100)}" opacity="${f(p.halo)}" filter="url(#halo)"/>
</g>
${rootSvg}
<g transform="${body}">
<use href="#m" fill="url(#flesh)" fill-opacity="0.96"/>
<ellipse cx="${CX}" cy="22" rx="11" ry="9" fill="${grey(100)}" opacity="${f(p.lantern)}" filter="url(#lamp)"/>
<g fill="${grey(100)}" opacity="${f(p.spots)}" filter="url(#soft)">${spots.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${f(r * 1.6)}"/>`).join("")}</g>
<g fill="${grey(100)}" opacity="${f(Math.min(1, p.spots + 0.15))}">${spots.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${f(r * 0.75)}"/>`).join("")}</g>
<use href="#m" fill="none" stroke="${grey(96 * E)}" stroke-width="1.1"/>
${sockets}
</g>
<circle cx="${f(p.ox)}" cy="${f(p.oy)}" r="${f(p.or * 2.1)}" fill="${grey(100)}" opacity="${f(p.orbGlow)}" filter="url(#halo)"/>
<circle cx="${f(p.ox)}" cy="${f(p.oy)}" r="${f(p.or)}" fill="url(#pearl)"/>
<circle cx="${f(p.ox)}" cy="${f(p.oy)}" r="${f(p.or + 1.3)}" fill="none" stroke="${grey(100)}" stroke-opacity="${f(p.orbRing)}" stroke-width="0.6"/>
</g>
<g id="accent">
<g opacity="${f(p.alpha)}" transform="${body}">${eyes.join("")}</g>
</g>
</svg>
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Worker: one curled arm tip with glowing suckers and the light piece it shapes
// ---------------------------------------------------------------------------------------------------------------

const WW = 36, WH = 45;
const AX = 0, AY = 32;

interface Worker {
	phi: number; curl: number; len: number; w0: number; power: number;
	energy: number; halo: number; suckers: number;
	piece: { x: number; y: number; s: number; rot: number; glow: number; op: number };
	sparks: [number, number, number][]; spark: number;
	alpha: number;
	edge: number; flash: { x: number; y: number; r: number; op: number; core: number }; scan: { x: number; op: number }; star: { x: number; y: number; s: number; op: number };
}

const W0: Worker = {
	phi: -6, curl: 285, len: 39, w0: 5.2, power: 2.4,
	energy: 1, halo: 0.5, suckers: 0.75,
	piece: { x: 14, y: 20, s: 2.6, rot: 0, glow: 0.7, op: 1 },
	sparks: [[12, 15, 0.6], [20, 17, 0.5], [17, 24, 0.5]], spark: 0,
	alpha: 1,
	edge: 0, flash: { x: 14, y: 20, r: 2, op: 0, core: 0 }, scan: { x: 14, op: 0 }, star: { x: 14, y: 20, s: 2, op: 0 },
};

/** The piece's natural seat: the hollow of the curl. */
function hollow(w: Worker): { x: number; y: number } {
	const sh = tentacle({ x: AX, y: AY, phi: w.phi, len: w.len, curl: w.curl, w0: w.w0, power: w.power });
	const p = innerAt(sh, 0.72, 1);
	const i = Math.round(0.72 * (sh.pts.length - 1));
	const phi = sh.phis[i]!;
	return { x: p.x + sh.inner * Math.sin(phi) * 3.6, y: p.y - sh.inner * Math.cos(phi) * 3.6 };
}

const SUCKERS = [0.2, 0.32, 0.44, 0.55, 0.65, 0.74, 0.82, 0.89];

function workerSvg(p: Worker): string {
	const E = p.energy;
	const sh = tentacle({ x: AX, y: AY, phi: p.phi, len: p.len, curl: p.curl, w0: p.w0, power: p.power });
	const suckers = SUCKERS.map(s => innerAt(sh, s, 0.5));
	const pc = p.piece;
	const rh = (s: number): string => {
		const c = Math.cos(rad(pc.rot)), sn = Math.sin(rad(pc.rot));
		const pts: P[] = [[0, -s * 1.25], [s * 0.8, 0], [0, s * 1.25], [-s * 0.8, 0]];
		return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${f(pc.x + x * c - y * sn)} ${f(pc.y + x * sn + y * c)}`).join(" ") + " Z";
	};
	const st = p.star;
	const star = `M${f(st.x)} ${f(st.y - st.s * 2)} L${f(st.x + st.s * 0.35)} ${f(st.y - st.s * 0.35)} L${f(st.x + st.s * 2)} ${f(st.y)} L${f(st.x + st.s * 0.35)} ${f(st.y + st.s * 0.35)} L${f(st.x)} ${f(st.y + st.s * 2)} L${f(st.x - st.s * 0.35)} ${f(st.y + st.s * 0.35)} L${f(st.x - st.s * 2)} ${f(st.y)} L${f(st.x - st.s * 0.35)} ${f(st.y - st.s * 0.35)} Z`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${WW}" height="${WH}" viewBox="0 0 ${WW} ${WH}">
<defs>
<filter id="halo" filterUnits="userSpaceOnUse" x="-12" y="-12" width="60" height="69"><feGaussianBlur stdDeviation="2.2"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-12" y="-12" width="60" height="69"><feGaussianBlur stdDeviation="0.9"/></filter>
<filter id="wide" filterUnits="userSpaceOnUse" x="-12" y="-12" width="60" height="69"><feGaussianBlur stdDeviation="3"/></filter>
<path id="arm" d="${sh.outline}"/>
</defs>
<g opacity="${f(p.alpha)}">
<use href="#arm" fill="${grey(100)}" stroke="${grey(100)}" stroke-width="1.5" opacity="${f(p.halo)}" filter="url(#halo)"/>
<use href="#arm" fill="${grey(40 * E)}" fill-opacity="0.95" stroke="${grey(90 * E)}" stroke-width="0.75"/>
<path d="${sh.spine}" fill="none" stroke="${grey(100)}" stroke-opacity="${f(0.3 * E)}" stroke-width="0.8" stroke-linecap="round"/>
<g fill="${grey(100)}" opacity="${f(p.suckers * 0.9)}" filter="url(#soft)">${suckers.map(s => `<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(Math.max(0.5, s.w * 0.36))}"/>`).join("")}</g>
<g fill="${grey(100)}" opacity="${f(p.suckers)}">${suckers.map(s => `<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(Math.max(0.35, s.w * 0.2))}"/>`).join("")}</g>
<g opacity="${f(pc.op)}">
<circle cx="${f(pc.x)}" cy="${f(pc.y)}" r="${f(pc.s * 2)}" fill="${grey(100)}" opacity="${f(pc.glow)}" filter="url(#wide)"/>
<path d="${rh(pc.s)}" fill="${grey(78)}" stroke="${grey(100)}" stroke-width="0.6"/>
<path d="${rh(pc.s * 0.5)}" fill="${grey(100)}"/>
</g>
<g fill="${grey(100)}" opacity="${f(p.spark)}">${p.sparks.map(([x, y, r]) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}"/>`).join("")}</g>
</g>
<g id="accent">
<use href="#arm" fill="none" stroke="${grey(100)}" stroke-width="1.3" opacity="${f(p.edge)}"/>
<circle cx="${f(p.flash.x)}" cy="${f(p.flash.y)}" r="${f(p.flash.r)}" fill="none" stroke="${grey(100)}" stroke-width="1.6" opacity="${f(p.flash.op)}"/>
<circle cx="${f(p.flash.x)}" cy="${f(p.flash.y)}" r="${f(p.flash.r * 0.55)}" fill="${grey(100)}" opacity="${f(p.flash.core)}" filter="url(#soft)"/>
<rect x="${f(p.scan.x - 0.6)}" y="${f(pc.y - 5)}" width="1.2" height="10" fill="${grey(100)}" opacity="${f(p.scan.op)}"/>
<path d="${star}" fill="${grey(100)}" opacity="${f(st.op)}"/>
</g>
</svg>
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------------------------------------------

type Ease = "linear" | "in" | "out" | "inOut";
interface Key<T> { at: number; pose: T; ease?: Ease }
interface Seq<T> { name: string; durationMs: number; loop: boolean; frameMs?: number; keys: Key<T>[] }

function writeSeqs<T>(actor: string, seqs: Seq<T>[], render: (p: T) => string, box: { w: number; h: number; anchor: { x: number; y: number } }): void {
	const dir = join(OUT, actor);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const shared = new Map<string, string>();
	for (const seq of seqs) {
		let own = 0;
		const keys = seq.keys.map((key, n) => {
			const svg = render(key.pose);
			let file = shared.get(svg);
			if (file === undefined) {
				file = `${seq.name}.${String.fromCharCode(97 + own++)}.svg`;
				shared.set(svg, file);
				writeFileSync(join(dir, file), svg);
			}
			return { at: key.at, svg: file, ...(n > 0 && key.ease !== undefined ? { ease: key.ease } : {}) };
		});
		const spec = { w: box.w, h: box.h, anchor: box.anchor, frameMs: seq.frameMs ?? 83, durationMs: seq.durationMs, loop: seq.loop, keys };
		writeFileSync(join(dir, `${seq.name}.json`), `${JSON.stringify(spec, null, "\t")}\n`);
	}
}

const d = (o: Partial<Director> = {}): Director => ({ ...D0, ...o });
const roots = (adjust: (r: Tentacle, i: number) => Partial<Tentacle>): Director["roots"] =>
	ROOTS.map((r, i) => ({ ...r, ...adjust(r, i) })) as Director["roots"];

const breatheIn = (o: Partial<Director> = {}): Director =>
	d({ sx: 1.035, sy: 1.04, by: -0.6, halo: 0.68, lantern: 0.72, spots: 0.9, roots: roots((r, i) => ({ curl: r.curl * 1.1, phi: r.phi + (i < 2 ? 4 : -4) })), ...o });

const directorSeqs: Seq<Director>[] = [
	{ name: "ready", durationMs: 3400, loop: true, frameMs: 243, keys: [
		{ at: 0, pose: d() },
		{ at: 1700, pose: breatheIn() },
		{ at: 3400, pose: d() },
	] },
	{ name: "work", durationMs: 2400, loop: true, frameMs: 120, keys: [
		{ at: 0, pose: d({ pupilDx: 1.2, pupilDy: -0.5, orbGlow: 0.5 }) },
		{ at: 600, pose: d({ pupilDx: 1.4, pupilDy: 0.5, by: -0.4, sy: 1.015, orbGlow: 0.62, lantern: 0.62, roots: roots((r, i) => ({ curl: r.curl * (i % 2 ? 1.08 : 0.94) })) }) },
		{ at: 1200, pose: d({ pupilDx: 0.6, pupilDy: 0, orbGlow: 0.5, spots: 0.85 }) },
		{ at: 1800, pose: d({ pupilDx: 1.4, pupilDy: -0.6, by: -0.4, sy: 1.015, orbGlow: 0.62, lantern: 0.62, roots: roots((r, i) => ({ curl: r.curl * (i % 2 ? 0.94 : 1.08) })) }) },
		{ at: 2400, pose: d({ pupilDx: 1.2, pupilDy: -0.5, orbGlow: 0.5 }) },
	] },
	{ name: "quiet", durationMs: 2400, loop: true, frameMs: 120, keys: [
		{ at: 0, pose: d({ pupilDx: 1, pupilDy: 0.3, energy: 0.92 }) },
		{ at: 1200, pose: d({ pupilDx: 1.3, pupilDy: 0.6, by: -0.2, sy: 1.008, energy: 0.92, lantern: 0.6, roots: roots((r, i) => ({ curl: r.curl * (i % 2 ? 1.04 : 0.97) })) }) },
		{ at: 2400, pose: d({ pupilDx: 1, pupilDy: 0.3, energy: 0.92 }) },
	] },
	{ name: "submit", durationMs: 900, loop: false, keys: [
		{ at: 0, pose: d({ pupilDx: 1, pupilDy: 0 }) },
		{ at: 350, pose: d({ pupilDx: 1.6, pupilDy: -0.9, eyeDy: -0.6, by: -1.2, sy: 1.03, eyeR: 3.6, halo: 0.7, orbGlow: 0.7 }), ease: "out" },
		{ at: 900, pose: d({ pupilDx: 1.5, pupilDy: -0.8, eyeDy: -0.4, by: -0.8, sy: 1.02, eyeR: 3.5, halo: 0.62, orbGlow: 0.62 }) },
	] },
	{ name: "review", durationMs: 2900, loop: true, frameMs: 121, keys: [
		{ at: 0, pose: d({ pupilDx: -1.3, rot: -2, eyeDx: -0.6 }) },
		{ at: 1450, pose: d({ pupilDx: 1.5, rot: 2, eyeDx: 0.6, lantern: 0.66 }) },
		{ at: 2900, pose: d({ pupilDx: -1.3, rot: -2, eyeDx: -0.6 }) },
	] },
	{ name: "accepted", durationMs: 1300, loop: false, frameMs: 100, keys: [
		{ at: 0, pose: d({ pupilDy: 0.8 }) },
		{ at: 250, pose: d({ pupilDy: 1, oy: 56.5, or: 5.6, orb: 1, orbGlow: 1, orbRing: 1, halo: 0.8, lantern: 0.85, spots: 1, roots: roots((r, i) => ({ curl: r.curl * (i === 1 || i === 2 ? 1.25 : 1.05) })) }), ease: "out" },
		{ at: 1300, pose: d({ pupilDy: 0.4, or: 5, orb: 0.92, orbGlow: 0.66, orbRing: 0.8, halo: 0.62 }), ease: "inOut" },
	] },
	{ name: "unmet", durationMs: 600, loop: false, keys: [
		{ at: 0, pose: d() },
		{ at: 120, pose: d({ bx: -1.6, by: 0.8, sx: 0.96, sy: 0.97, eyeOpen: 0.45, rot: -3, roots: roots(r => ({ curl: r.curl * 1.2 })) }), ease: "out" },
		{ at: 600, pose: d({ pupilDx: 1 }) },
	] },
	{ name: "blocked", durationMs: 600, loop: false, keys: [
		{ at: 0, pose: d() },
		{ at: 140, pose: d({ rot: 7, bx: 1.6, sx: 0.95, sy: 1.05, eyeDx: 1.6, pupilDx: 1.6, eyeR: 3.7, halo: 0.42, lantern: 0.4, roots: roots((r, i) => ({ curl: r.curl * 0.8, phi: r.phi + (i < 2 ? -6 : 6) })) }), ease: "out" },
		{ at: 600, pose: d({ rot: 6, bx: 1.4, sx: 0.96, sy: 1.04, eyeDx: 1.5, pupilDx: 1.7, eyeR: 3.6, halo: 0.42, lantern: 0.4, roots: roots((r, i) => ({ curl: r.curl * 0.82, phi: r.phi + (i < 2 ? -5 : 5) })) }) },
	] },
	{ name: "excluded", durationMs: 800, loop: false, frameMs: 100, keys: [
		{ at: 0, pose: d() },
		{ at: 350, pose: d({ by: 1.5, pupilDy: 1.2, oy: 66, or: 4.2, orb: 0.7, orbGlow: 0.35, roots: roots((r, i) => ({ phi: r.phi + (i < 2 ? -8 : 8), curl: r.curl * 0.7, len: r.len * 1.1 })) }), ease: "inOut" },
		{ at: 800, pose: d({ energy: 0.55, halo: 0.18, lantern: 0.15, spots: 0.25, eyeOpen: 0.4, eyeGlow: 0.15, sx: 0.9, sy: 0.9, by: -2, pupilDy: 1, oy: 66.5, or: 4, orb: 0.55, orbGlow: 0.2, orbRing: 0.3, alpha: 0.65, roots: roots(r => ({ curl: r.curl * 1.35, len: r.len * 0.8 })) }), ease: "out" },
	] },
	{ name: "rest", durationMs: 3400, loop: true, frameMs: 243, keys: [
		{ at: 0, pose: d({ energy: 0.8, halo: 0.36, lantern: 0.35, spots: 0.45, eyeOpen: 0.55, eyeGlow: 0.35, by: 1 }) },
		{ at: 1700, pose: d({ energy: 0.84, halo: 0.44, lantern: 0.45, spots: 0.55, eyeOpen: 0.55, eyeGlow: 0.35, by: 0.5, sx: 1.02, sy: 1.025, roots: roots(r => ({ curl: r.curl * 1.06 })) }) },
		{ at: 3400, pose: d({ energy: 0.8, halo: 0.36, lantern: 0.35, spots: 0.45, eyeOpen: 0.55, eyeGlow: 0.35, by: 1 }) },
	] },
	{ name: "waiting-user", durationMs: 2400, loop: true, keys: [
		{ at: 0, pose: d({ eyeR: 3.9, pupilW: 1.2, eyeGlow: 1 }) },
		{ at: 950, pose: d({ eyeR: 3.9, pupilW: 1.2, eyeGlow: 0.35 }), ease: "inOut" },
		{ at: 1100, pose: d({ eyeR: 3.9, pupilW: 1.2, eyeGlow: 0.35, eyeOpen: 0.1 }), ease: "in" },
		{ at: 1300, pose: d({ eyeR: 3.9, pupilW: 1.2, eyeGlow: 0.6 }), ease: "out" },
		{ at: 2400, pose: d({ eyeR: 3.9, pupilW: 1.2, eyeGlow: 1 }) },
	] },
	{ name: "finale", durationMs: 2200, loop: false, frameMs: 122, keys: [
		{ at: 0, pose: d() },
		{ at: 900, pose: d({ by: 4.5, sy: 0.97, ox: 31.5, oy: 7, or: 4.3, orb: 1, orbGlow: 0.75, orbRing: 1, halo: 0.75, lantern: 0.8, spots: 1, pupilDy: -1.2, eyeDy: -0.6, roots: roots((r, i) => ({ phi: [225, 150, 30, 315][i]!, curl: r.curl * 0.3, len: r.len * 1.1 })) }), ease: "inOut" },
		{ at: 2200, pose: d({ by: 4.5, sy: 0.97, ox: 31.5, oy: 6.5, or: 4.2, orb: 1, orbGlow: 0.6, orbRing: 0.9, halo: 0.6, lantern: 0.7, spots: 0.9, eyeOpen: 0.75, roots: roots((r, i) => ({ phi: [105, 100, 80, 75][i]!, curl: r.curl * 1.6, len: r.len * 0.85 })) }), ease: "inOut" },
	] },
	{ name: "lights-out", durationMs: 4000, loop: false, frameMs: 333, keys: [
		{ at: 0, pose: d({ pupilDy: 1, pupilDx: 0, oy: 59, or: 4.2, orb: 0.75, orbGlow: 0.4 }) },
		{ at: 1600, pose: d({ pupilDy: 1, eyeDy: 0.6, by: 0.8, lean: -1, oy: 59, or: 4.2, orb: 0.7, orbGlow: 0.35, energy: 0.85, halo: 0.4, lantern: 0.4 }) },
		{ at: 4000, pose: d({ pupilDy: 1, eyeDy: 0.8, by: 1.4, lean: -1.5, oy: 59.5, or: 4, orb: 0.55, orbGlow: 0.25, energy: 0.5, halo: 0.12, lantern: 0.1, spots: 0.15, eyeOpen: 0.5, eyeGlow: 0.15, orbRing: 0.25, alpha: 0.7, roots: roots(r => ({ curl: r.curl * 1.1 })) }) },
	] },
	{ name: "gather", durationMs: 2400, loop: false, frameMs: 200, keys: [
		{ at: 0, pose: d({ alpha: 0, sx: 0.4, sy: 0.4, halo: 1, lantern: 1, orb: 0.3, orbGlow: 0, eyeOpen: 0.1, roots: roots(r => ({ len: r.len * 0.3, curl: r.curl * 2 })) }) },
		{ at: 1400, pose: d({ alpha: 0.85, sx: 0.9, sy: 0.9, halo: 0.9, lantern: 0.9, orbGlow: 0.3, eyeOpen: 0.3 }), ease: "out" },
		{ at: 2400, pose: d(), ease: "inOut" },
	] },
];

// Worker sequences
const w = (o: Partial<Worker> = {}): Worker => {
	const base: Worker = { ...W0, ...o };
	return base;
};
/** A worker with the piece seated in its curl. */
const seated = (o: Partial<Worker> = {}, piece: Partial<Worker["piece"]> = {}): Worker => {
	const base = w(o);
	const h = hollow(base);
	return { ...base, piece: { ...base.piece, x: h.x, y: h.y, ...piece } };
};
const noPiece = { op: 0, glow: 0 };

const open = seated({ phi: -6, curl: 280, suckers: 0.7 }, { s: 2.6, rot: -10, glow: 0.65 });
const wrapped = seated({ phi: -12, curl: 375, len: 40, power: 2.6, suckers: 1, halo: 0.62, spark: 0.9 }, { s: 2.2, rot: 25, glow: 0.45 });
const pressed = seated({ phi: -2, curl: 310, suckers: 0.85, spark: 0.4 }, { s: 2.9, rot: 0, glow: 0.95 });

const ready0 = w({ phi: -2, curl: 320, len: 36, power: 2.5, suckers: 0.5, energy: 0.85, halo: 0.4, piece: { ...W0.piece, ...noPiece } });
const ready1 = w({ phi: -9, curl: 345, len: 36.5, power: 2.5, suckers: 0.62, energy: 0.88, halo: 0.48, piece: { ...W0.piece, ...noPiece } });

const quiet0 = seated({ phi: -6, curl: 295, suckers: 0.72, energy: 0.92 }, { s: 2.5, rot: 0, glow: 0.6 });
const quiet1 = seated({ phi: -9, curl: 325, suckers: 0.88, energy: 0.92, spark: 0.45 }, { s: 2.4, rot: 12, glow: 0.55 });

/** The arm raised, the piece held just above its tip; low enough that the piece's glow stays inside the box. */
const lifted = (o: Partial<Worker> = {}): Worker => {
	const base = w({ phi: -30, curl: 150, len: 21, power: 2.6, suckers: 0.9, halo: 0.6, ...o });
	const sh = tentacle({ x: AX, y: AY, phi: base.phi, len: base.len, curl: base.curl, w0: base.w0, power: base.power });
	const tip = sh.pts[sh.pts.length - 1]!;
	return { ...base, piece: { ...base.piece, x: tip[0] + 0.5, y: Math.max(15, tip[1] - 4), s: 2.8, rot: 0, glow: 1, op: 1 } };
};

const present = seated({ phi: -26, curl: 235, len: 37, power: 2.3, suckers: 0.8 }, { s: 2.9, rot: 0, glow: 0.8 });
const scanAt = (pose: Worker, dx: number, op: number): Worker => ({ ...pose, scan: { x: pose.piece.x + dx, op } });

/** Three sparks around a point, in one of two arrangements. */
const sparksAt = (x: number, y: number, k: 0 | 1): Worker["sparks"] =>
	k === 0 ? [[x - 3.5, y - 4.5, 0.6], [x + 5, y - 2, 0.5], [x + 2.5, y + 4.5, 0.5]] : [[x - 4.5, y - 1.5, 0.6], [x + 3.5, y - 5.5, 0.5], [x + 5.5, y + 2.5, 0.5]];
const withSparks = (p: Worker, k: 0 | 1): Worker => ({ ...p, sparks: sparksAt(p.piece.x, p.piece.y, k) });

const workOpen = withSparks(open, 0);
const off = { ...W0.piece, ...noPiece };
const restPose = (breath: number): Worker =>
	w({ phi: 14 - 4 * breath, curl: 330 + 18 * breath, len: 34 + 0.5 * breath, power: 2.5, suckers: 0.35 + 0.1 * breath, energy: 0.75 + 0.03 * breath, halo: 0.3 + 0.06 * breath, piece: off });
const still = seated({ phi: -6, curl: 290, suckers: 0.55, energy: 0.85, halo: 0.38 }, { s: 2.5, glow: 0.45 });

const workerSeqs: Seq<Worker>[] = [
	{ name: "ready", durationMs: 3400, loop: true, frameMs: 170, keys: [
		{ at: 0, pose: ready0 },
		{ at: 1700, pose: ready1 },
		{ at: 3400, pose: ready0 },
	] },
	{ name: "work", durationMs: 2000, loop: true, keys: [
		{ at: 0, pose: workOpen },
		{ at: 500, pose: withSparks(wrapped, 0) },
		{ at: 1000, pose: withSparks(pressed, 1) },
		{ at: 1500, pose: withSparks({ ...wrapped, piece: { ...wrapped.piece, rot: -20 } }, 1) },
		{ at: 2000, pose: workOpen },
	] },
	{ name: "quiet", durationMs: 2000, loop: true, keys: [
		{ at: 0, pose: withSparks(quiet0, 0) },
		{ at: 1000, pose: withSparks(quiet1, 0) },
		{ at: 2000, pose: withSparks(quiet0, 0) },
	] },
	{ name: "submit", durationMs: 900, loop: false, keys: [
		{ at: 0, pose: open },
		{ at: 380, pose: (() => { const l = lifted(); return { ...l, star: { x: l.piece.x, y: l.piece.y, s: 2.2, op: 1 } }; })(), ease: "out" },
		{ at: 900, pose: (() => { const l = lifted({ phi: -34, curl: 140 }); return { ...l, piece: { ...l.piece, glow: 0.85 }, star: { x: l.piece.x, y: l.piece.y, s: 1.4, op: 0.35 } }; })() },
	] },
	{ name: "review", durationMs: 2900, loop: true, keys: [
		{ at: 0, pose: scanAt(present, -4, 0) },
		{ at: 300, pose: scanAt(present, -3, 0.9), ease: "linear" },
		{ at: 1250, pose: scanAt({ ...present, suckers: 0.95 }, 3, 0.9), ease: "linear" },
		{ at: 1450, pose: scanAt(present, 4, 0), ease: "linear" },
		{ at: 1750, pose: scanAt(present, 3, 0.9), ease: "linear" },
		{ at: 2700, pose: scanAt({ ...present, suckers: 0.95 }, -3, 0.9), ease: "linear" },
		{ at: 2900, pose: scanAt(present, -4, 0), ease: "linear" },
	] },
	{ name: "accepted", durationMs: 1300, loop: false, keys: [
		{ at: 0, pose: present },
		{ at: 300, pose: (() => { const p = seated({ phi: -22, curl: 175, len: 40, power: 2.2, suckers: 1, halo: 0.7 }, { s: 2.6, glow: 1 }); return { ...p, flash: { x: p.piece.x, y: p.piece.y, r: 1.5, op: 1, core: 1 } }; })(), ease: "in" },
		{ at: 750, pose: (() => { const p = seated({ phi: -16, curl: 220, len: 39, power: 2.3, suckers: 1, halo: 0.8 }, { s: 1, glow: 0.4, op: 0 }); return { ...p, flash: { x: p.piece.x, y: p.piece.y, r: 11, op: 0.45, core: 0.25 } }; })(), ease: "out" },
		{ at: 1300, pose: (() => { const p = seated({ phi: -8, curl: 290, len: 38, suckers: 0.85, halo: 0.55 }, { s: 1, glow: 0, op: 0 }); return { ...p, flash: { x: p.piece.x, y: p.piece.y, r: 15, op: 0, core: 0 } }; })(), ease: "out" },
	] },
	{ name: "unmet", durationMs: 600, loop: false, keys: [
		{ at: 0, pose: open },
		{ at: 130, pose: { ...w({ phi: 16, curl: 430, len: 31, power: 2.3, suckers: 0.4, halo: 0.35 }), piece: { ...open.piece, x: 31, y: 36, rot: 70, glow: 0.4 } }, ease: "out" },
		{ at: 380, pose: { ...w({ phi: 8, curl: 60, len: 38, power: 2.2, suckers: 0.75 }), piece: { ...open.piece, x: 33, y: 37, rot: 100, glow: 0.5 } }, ease: "inOut" },
		{ at: 600, pose: { ...open, piece: { ...open.piece, rot: 170 } }, ease: "inOut" },
	] },
	{ name: "blocked", durationMs: 600, loop: false, keys: [
		{ at: 0, pose: open },
		{ at: 110, pose: { ...w({ phi: -34, curl: 45, len: 36, w0: 5.4, power: 2.8, suckers: 0.25, halo: 0.25, energy: 0.8, edge: 1 }), piece: { ...open.piece, x: 32, y: 6, rot: 0, glow: 0.3 } }, ease: "out" },
		{ at: 600, pose: { ...w({ phi: -32, curl: 40, len: 36, w0: 5.4, power: 2.8, suckers: 0.2, halo: 0.2, energy: 0.75, edge: 0.9 }), piece: { ...open.piece, x: 32, y: 7, rot: 0, glow: 0.25 } }, ease: "out" },
	] },
	{ name: "excluded", durationMs: 800, loop: false, keys: [
		{ at: 0, pose: open },
		{ at: 350, pose: { ...w({ phi: 30, curl: 200, len: 38, power: 2.2, suckers: 0.5, halo: 0.35, energy: 0.8 }), piece: { ...open.piece, x: 24, y: 40, rot: 90, glow: 0.45 } }, ease: "inOut" },
		{ at: 800, pose: { ...w({ phi: 10, curl: 480, len: 25, w0: 4.6, power: 2.2, suckers: 0.12, halo: 0.08, energy: 0.45, alpha: 0.6 }), piece: { ...open.piece, x: 24, y: 41, rot: 90, glow: 0.3, op: 0.9 } }, ease: "out" },
	] },
	{ name: "user-steer", durationMs: 900, loop: false, keys: [
		{ at: 0, pose: open },
		{ at: 260, pose: seated({ phi: -24, curl: 130, len: 36, power: 2.6, suckers: 1, halo: 0.7 }, { s: 2.7, glow: 0.8 }), ease: "out" },
		{ at: 480, pose: seated({ phi: -8, curl: 240, len: 37, power: 3, suckers: 0.9, halo: 0.6 }, { s: 2.6, glow: 0.7 }), ease: "inOut" },
		{ at: 900, pose: open, ease: "inOut" },
	] },
	{ name: "user-stop", durationMs: 1200, loop: false, keys: [
		{ at: 0, pose: open },
		{ at: 450, pose: { ...w({ phi: 30, curl: 200, len: 38, power: 2.2, suckers: 0.5, halo: 0.4, energy: 0.85 }), piece: { ...open.piece, x: 24, y: 40, rot: 90, glow: 0.5 } }, ease: "inOut" },
		{ at: 1200, pose: { ...w({ phi: 0, curl: 330, len: 7, w0: 4.6, power: 2, suckers: 0, halo: 0, energy: 0.5, alpha: 0 }), piece: { ...open.piece, x: 24, y: 41, rot: 90, glow: 0.3, op: 0.85 } }, ease: "in" },
	] },
	{ name: "rest", durationMs: 3400, loop: true, frameMs: 170, keys: [
		{ at: 0, pose: restPose(0) },
		{ at: 1700, pose: restPose(1) },
		{ at: 3400, pose: restPose(0) },
	] },
	{ name: "waiting-user", durationMs: 2400, loop: true, frameMs: 2400, keys: [
		{ at: 0, pose: still },
		{ at: 2400, pose: still },
	] },
	{ name: "finale", durationMs: 2200, loop: false, frameMs: 100, keys: [
		{ at: 0, pose: open },
		{ at: 800, pose: (() => { const l = lifted({ phi: -45, curl: 60, len: 19, power: 2, suckers: 1, halo: 0.75 }); return { ...l, piece: { ...l.piece, op: 0.6, glow: 0.8 } }; })(), ease: "inOut" },
		{ at: 1250, pose: (() => { const l = lifted({ phi: -38, curl: 120, len: 20, power: 2.4, suckers: 1, halo: 0.7 }); return { ...l, piece: { ...l.piece, s: 1.5, op: 0, glow: 0 } }; })(), ease: "inOut" },
		{ at: 2200, pose: (() => { const p = w({ phi: 4, curl: 470, len: 33, suckers: 0.85, halo: 0.55, power: 2 }); return { ...p, piece: { ...p.piece, x: 12, y: -4, op: 0, glow: 0 } }; })(), ease: "inOut" },
	] },
	{ name: "lights-out", durationMs: 4000, loop: false, frameMs: 250, keys: [
		{ at: 0, pose: seated({ phi: -10, curl: 280 }, { s: 2.7, glow: 0.6 }) },
		{ at: 1800, pose: seated({ phi: -4, curl: 295, energy: 0.85, halo: 0.35, suckers: 0.5 }, { s: 2.7, glow: 0.5 }) },
		{ at: 4000, pose: seated({ phi: 4, curl: 305, len: 37, energy: 0.5, halo: 0.12, suckers: 0.15, alpha: 0.7 }, { s: 2.6, glow: 0.35, op: 0.85 }) },
	] },
	{ name: "gather", durationMs: 2400, loop: false, frameMs: 120, keys: [
		{ at: 0, pose: w({ len: 6, curl: 60, alpha: 0, halo: 1, piece: off, spark: 1, sparks: [[8, 14, 0.8], [14, 40, 0.7], [28, 24, 0.7]] }) },
		{ at: 1500, pose: w({ len: 30, curl: 260, alpha: 0.85, halo: 0.8, piece: off, spark: 0.5, sparks: [[12, 20, 0.6], [16, 30, 0.5], [22, 24, 0.5]] }), ease: "out" },
		{ at: 2400, pose: ready0, ease: "inOut" },
	] },
];

// ---------------------------------------------------------------------------------------------------------------
// Background: a dim sea floor with slow currents and drifting light motes
// ---------------------------------------------------------------------------------------------------------------

const BW = 432, BH = 90;
const BG_KEYS = 4;
const BG_MS = 4800;
let seed = 7;
/** A fixed pseudo-random sequence, so the floor is the same on every run. */
const rnd = (): number => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
};

const motes = Array.from({ length: 34 }, () => ({
	x: rnd() * BW, y: 6 + rnd() * 64, r: 0.5 + rnd() * 0.8, a: 0.18 + rnd() * 0.32, phase: rnd(), orbit: 1.2 + rnd() * 2.2, rise: rnd() < 0.5 ? 1 : -1,
}));
const fronds = Array.from({ length: 9 }, (_, i) => ({ x: 20 + i * 47 + rnd() * 20, h: 9 + rnd() * 9, phase: rnd() }));
const rocks = Array.from({ length: 14 }, (_, i) => ({ x: i * 33 + rnd() * 18, w: 10 + rnd() * 16, h: 2.5 + rnd() * 4 }));

/** The floor's top contour at x. */
const floorY = (x: number): number => 80 + 2.2 * Math.sin(x / 37) + 1.4 * Math.sin(x / 13 + 1.3);

function floorEdge(): string {
	let d = `M0 ${f(floorY(0))}`;
	for (let x = 12; x <= BW; x += 12) d += ` L${x} ${f(floorY(x))}`;
	return d;
}
function rock(r: (typeof rocks)[number]): string {
	const y = floorY(r.x + r.w / 2) + 0.5;
	return `M${f(r.x)} ${f(y)} C${f(r.x + r.w * 0.1)} ${f(y - r.h)} ${f(r.x + r.w * 0.9)} ${f(y - r.h)} ${f(r.x + r.w)} ${f(y)} Z`;
}
/** A seaweed frond swaying with phase p (0..1 of the loop). */
function frond(fr: (typeof fronds)[number], p: number): string {
	const base = floorY(fr.x);
	const s = Math.sin((p + fr.phase) * Math.PI * 2);
	return `M${f(fr.x)} ${f(base)} C${f(fr.x + 1.5 * s)} ${f(base - fr.h * 0.4)} ${f(fr.x - 1 + 3 * s)} ${f(base - fr.h * 0.7)} ${f(fr.x + 0.5 + 4 * s)} ${f(base - fr.h)}`;
}
/** Slow currents: long waves whose dashes travel one period over the loop. */
const currents = [
	{ y: 18, amp: 3, len: 90, op: 0.1 },
	{ y: 38, amp: 4, len: 120, op: 0.08 },
	{ y: 58, amp: 2.5, len: 75, op: 0.09 },
];
function currentPath(cur: (typeof currents)[number]): string {
	let d = `M-10 ${f(cur.y)}`;
	for (let x = 0; x <= BW + 10; x += 18) d += ` L${x} ${f(cur.y + cur.amp * Math.sin(x / 31 + cur.y))}`;
	return d;
}

/** The background at key `k` of `BG_KEYS`: the loop's phase k / BG_KEYS. */
function backgroundSvg(k: number): string {
	const p = k / BG_KEYS;
	const moteSvg = motes
		.map(m => {
			const a = (p + m.phase) * Math.PI * 2;
			const x = m.x + m.orbit * Math.cos(a);
			const y = m.y + m.rise * m.orbit * 0.8 * Math.sin(a);
			const twinkle = 0.6 + 0.4 * Math.sin(a * 2);
			return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(m.r)}" opacity="${f(m.a * twinkle)}"/>`;
		})
		.join("");
	const currentSvg = currents
		.map(cur => `<path d="${currentPath(cur)}" stroke-dasharray="${cur.len} ${cur.len}" stroke-dashoffset="${f(-2 * cur.len * p)}" opacity="${cur.op}"/>`)
		.join("");
	const tips = fronds
		.map(fr => {
			const a = (p + fr.phase) * Math.PI * 2;
			return `<circle cx="${f(fr.x + 0.5 + 4 * Math.sin(a))}" cy="${f(floorY(fr.x) - fr.h)}" r="0.9" opacity="${f(0.3 + 0.15 * Math.cos(a))}"/>`;
		})
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${BW}" height="${BH}" viewBox="0 0 ${BW} ${BH}">
<defs>
<filter id="haze" filterUnits="userSpaceOnUse" x="-20" y="-20" width="472" height="130"><feGaussianBlur stdDeviation="1.6"/></filter>
<filter id="mote" filterUnits="userSpaceOnUse" x="-20" y="-20" width="472" height="130"><feGaussianBlur stdDeviation="0.7"/></filter>
<linearGradient id="deep" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${grey(30)}" stop-opacity="0"/>
<stop offset="1" stop-color="${grey(30)}" stop-opacity="0.16"/>
</linearGradient>
</defs>
<rect x="0" y="40" width="${BW}" height="50" fill="url(#deep)"/>
<g fill="none" stroke="${grey(60)}" stroke-width="2.2" stroke-linecap="round" filter="url(#haze)">${currentSvg}</g>
<g fill="none" stroke="${grey(34)}" stroke-width="1.1" stroke-linecap="round" opacity="0.7">${fronds.map(fr => `<path d="${frond(fr, p)}"/>`).join("")}</g>
<g fill="${grey(85)}" filter="url(#mote)">${tips}</g>
<path d="${floorEdge()} L${BW} ${BH} L0 ${BH} Z" fill="${grey(9)}" fill-opacity="0.92"/>
<g fill="${grey(13)}">${rocks.map(r => `<path d="${rock(r)}"/>`).join("")}</g>
<path d="${floorEdge()}" fill="none" stroke="${grey(32)}" stroke-width="0.8" opacity="0.55"/>
<g fill="${grey(80)}" filter="url(#mote)">${moteSvg}</g>
</svg>
`;
}

const backgroundSeq: Seq<number> = {
	name: "background",
	durationMs: BG_MS,
	loop: true,
	frameMs: 480,
	keys: Array.from({ length: BG_KEYS + 1 }, (_, k) => ({ at: (BG_MS * k) / BG_KEYS, pose: k, ease: "linear" as const })),
};

writeSeqs("director", directorSeqs, directorSvg, { w: DW, h: DH, anchor: { x: 31, y: 36 } });
writeSeqs("worker", workerSeqs, workerSvg, { w: WW, h: WH, anchor: { x: AX, y: AY } });
writeSeqs("fx", [backgroundSeq], backgroundSvg, { w: BW, h: BH, anchor: { x: 0, y: 0 } });
console.log(`authored ${directorSeqs.length + workerSeqs.length + 1} octopus sequences`);
