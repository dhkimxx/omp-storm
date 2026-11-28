/**
 * Generates the orca's stage art (docs/stage.md): every key SVG and sequence JSON under assets/stage/src/orca/.
 * The folder is rewritten from scratch, so edit the art here and regenerate, never the SVGs by hand.
 *
 *   bun scripts/stage/art/orca.ts
 *   bun scripts/stage/bake.ts --only orca --no-write --contact /tmp/orca-contact
 *
 * Workers are orcas facing right (the renderer mirrors those swimming left), the director is the target under review
 * (a turning bipyramid of light), `fx/background` is light shafts and motes under the surface the renderer draws.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../../../assets/stage/src/orca/", import.meta.url));
const n = (v: number): string => {
	const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
	return s === "-0" ? "0" : s;
};
const grey = (p: number): string => { const v = n(Math.max(0, Math.min(100, p))); return `rgb(${v}%,${v}%,${v}%)`; };
const deg = (r: number): number => (r * 180) / Math.PI;

/** Closed Catmull-Rom through points as cubic Béziers (fixed commands for a fixed point count). */
function closed(pts: [number, number][], tension = 1 / 6): string {
	const m = pts.length;
	let d = `M${n(pts[0]![0])} ${n(pts[0]![1])}`;
	for (let i = 0; i < m; i++) {
		const p0 = pts[(i - 1 + m) % m]!, p1 = pts[i]!, p2 = pts[(i + 1) % m]!, p3 = pts[(i + 2) % m]!;
		const c1 = [p1[0] + (p2[0] - p0[0]) * tension, p1[1] + (p2[1] - p0[1]) * tension];
		const c2 = [p2[0] - (p3[0] - p1[0]) * tension, p2[1] - (p3[1] - p1[1]) * tension];
		d += ` C${n(c1[0]!)} ${n(c1[1]!)} ${n(c2[0]!)} ${n(c2[1]!)} ${n(p2[0])} ${n(p2[1])}`;
	}
	return `${d} Z`;
}

// ---------------------------------------------------------------------------------------------------------------
// Worker: one orca, facing right, local origin at the body's centre.
// ---------------------------------------------------------------------------------------------------------------

interface Orca {
	tx: number; ty: number; rot: number; sc: number; sx: number; op: number;
	beat: number; // tail position -1 (down) .. 1 (up)
	fluke: number; // extra fluke angle (deg)
	arch: number; // spine arch (+ = hump up in the middle)
	pec: number; // pectoral fin angle (deg)
	fin: number; // dorsal lean (deg)
	glow: number; // halo opacity
	lum: number; // body brightness 0..1.3
	rim: number; // rim stroke opacity
	patch: number; // eye patch (accent) opacity
	bubbles: [number, number, number, number][]; // local x, y, r, opacity (3)
	ripple: [number, number, number][]; // local cx offset, rx, opacity (3)
	spray: [number, number, number, number][]; // box x, y, r, opacity (6)
	splash: [number, number, number]; // box-space ring: rx, ry, opacity (centred on anchor)
}

const L = 48;
const NOSE = 26;
function g(s: number, a: number, b: number): number {
	let max = 0;
	for (let i = 1; i < 200; i++) { const t = i / 200; max = Math.max(max, t ** a * (1 - t) ** b); }
	return (s ** a * (1 - s) ** b) / max;
}
function spineY(o: Orca, s: number): number {
	return o.beat * 2.6 * s ** 2.4 - o.beat * 0.6 * (1 - s) ** 3 - o.arch * 4 * s * (1 - s);
}
function slope(o: Orca, s: number): number {
	const e = 0.01;
	return Math.atan((spineY(o, s + e) - spineY(o, s - e)) / (-L * 2 * e));
}
const X = (s: number): number => NOSE - L * s;
const upper = (s: number): number => 7.4 * g(s, 0.45, 0.95) + 1.1 * s;
const lower = (s: number): number => 6.2 * g(s, 0.55, 1.1) + 1.1 * s;
const SAMPLES = [0.06, 0.15, 0.27, 0.4, 0.53, 0.66, 0.78, 0.89, 1];

function bodyPath(o: Orca, inset = 0): string {
	const pts: [number, number][] = [[X(0) - inset, spineY(o, 0) + 0.3]];
	for (const s of SAMPLES) pts.push([X(s), spineY(o, s) - Math.max(0.3, upper(s) - inset)]);
	for (const s of [...SAMPLES].reverse()) pts.push([X(s), spineY(o, s) + Math.max(0.3, lower(s) - inset)]);
	return closed(pts);
}
/** The white chin and belly: from the chin along the lower body to past the middle. */
function bellyPath(o: Orca): string {
	// Inner edge as a fraction of the lower half: the chin, the belly, then the flank patch sweeping above the midline.
	const ss = [0.05, 0.16, 0.3, 0.45, 0.58, 0.68, 0.79];
	const inner = [0.75, 0.1, 0.3, 0.45, -0.45, -0.35, 0.75];
	const pts: [number, number][] = [];
	for (const s of ss) pts.push([X(s), spineY(o, s) + lower(s) - 0.7]);
	for (let i = ss.length - 1; i >= 0; i--) pts.push([X(ss[i]!), spineY(o, ss[i]!) + lower(ss[i]!) * inner[i]!]);
	return closed(pts);
}

const ORCA_W = 90;
const ORCA_DEFS = (w: number, h: number): string => `<defs>
<filter id="halo" filterUnits="userSpaceOnUse" x="-20" y="-20" width="${w + 40}" height="${h + 40}"><feGaussianBlur stdDeviation="2.6"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-20" y="-20" width="${w + 40}" height="${h + 40}"><feGaussianBlur stdDeviation="0.8"/></filter>
</defs>`;

function orcaSvg(o: Orca, w: number, h: number, ax: number, ay: number): string {
	const place = `translate(${n(ax + o.tx)} ${n(ay + o.ty)}) rotate(${n(o.rot)}) scale(${n(o.sc * o.sx)} ${n(o.sc)})`;
	const body = bodyPath(o);
	const sFin = 0.42;
	const finX = X(sFin), finY = spineY(o, sFin) - upper(sFin) + 0.8;
	const finRot = deg(slope(o, sFin)) + o.fin;
	const sPec = 0.26;
	const pecX = X(sPec), pecY = spineY(o, sPec) + lower(sPec) - 1.2;
	const tailX = X(1), tailY = spineY(o, 1);
	const flukeRot = deg(slope(o, 1)) - o.beat * 10 + o.fluke;
	const eyeX = X(0.13), eyeY = spineY(o, 0.13) + 0.2;
	const patchX = X(0.23), patchY = spineY(o, 0.23) - 1.6;
	const saddleX = X(0.56), saddleY = spineY(o, 0.56) - upper(0.56) + 1.6;
	const lum = o.lum;
	const fill = `<linearGradient id="skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${grey(20 * lum)}"/><stop offset="0.6" stop-color="${grey(30 * lum)}"/><stop offset="1" stop-color="${grey(44 * lum)}"/></linearGradient>`;
	const fluke = `<g transform="translate(${n(tailX)} ${n(tailY)}) rotate(${n(flukeRot)})"><path d="M0.5 -1 C-3 -1.8 -6.4 -3.4 -10.4 -3.6 C-9.6 -2 -9.2 -1 -8.4 -0.1 C-9.2 1 -9.8 2.4 -10.6 4 C-6.6 3.4 -3 2 0.5 1 Z"/></g>`;
	const finPath = `<g transform="translate(${n(finX)} ${n(finY)}) rotate(${n(finRot)})"><path d="M5.6 1.6 C3.6 -3 1 -9.6 -1.8 -15.6 C-3 -10 -4.6 -3.6 -7.2 1.6 Z"/></g>`;
	const pecPath = `<g transform="translate(${n(pecX)} ${n(pecY)}) rotate(${n(o.pec)})"><path d="M2.4 -0.8 C1.6 2.2 -0.6 5 -4 6.8 C-4.2 3.6 -3.4 1 -2.2 -1 Z"/></g>`;
	const shape = `${fluke}${finPath}${pecPath}<path d="${body}"/>`;
	const bubbles = o.bubbles.map(([x, y, r, op]) => `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" opacity="${n(op)}"/>`).join("");
	const ripple = o.ripple.map(([x, rx, op]) => `<ellipse cx="${n(x)}" cy="0" rx="${n(rx)}" ry="${n(rx * 0.5)}" opacity="${n(op)}"/>`).join("");
	const spray = o.spray.map(([x, y, r, op]) => `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" opacity="${n(op)}"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${ORCA_DEFS(w, h).replace("</defs>", `${fill}\n</defs>`)}
<g fill="none" stroke="rgb(80%,80%,80%)" stroke-width="0.7" transform="${place}">${ripple}</g>
<g opacity="${n(o.op)}" transform="${place}">
<g fill="rgb(100%,100%,100%)" opacity="${n(o.glow)}" filter="url(#halo)">${shape}</g>
<g fill="rgb(100%,100%,100%)" opacity="0.8">${bubbles}</g>
<g fill="url(#skin)" stroke="${grey(88 * Math.min(1.1, lum + 0.1))}" stroke-opacity="${n(o.rim)}" stroke-width="0.8" stroke-linejoin="round">${shape}</g>
<path d="${bellyPath(o)}" fill="${grey(92 * lum)}" opacity="0.95"/>
<ellipse cx="${n(saddleX)}" cy="${n(saddleY)}" rx="5" ry="1.4" fill="${grey(70 * lum)}" opacity="0.45" filter="url(#soft)"/>
<circle cx="${n(eyeX)}" cy="${n(eyeY)}" r="0.9" fill="rgb(4%,4%,4%)"/>
</g>
<g id="accent">
<g opacity="${n(o.op * o.patch)}" transform="${place}"><ellipse cx="${n(patchX)}" cy="${n(patchY)}" rx="4.8" ry="2" transform="rotate(-12 ${n(patchX)} ${n(patchY)})" fill="rgb(100%,100%,100%)"/></g>
<g fill="rgb(100%,100%,100%)">${spray}</g>
<ellipse cx="${n(ax)}" cy="${n(ay)}" rx="${n(o.splash[0])}" ry="${n(o.splash[1])}" fill="none" stroke="rgb(100%,100%,100%)" stroke-width="0.9" opacity="${n(o.splash[2])}"/>
</g>
</svg>
`;
}

const NO_BUBBLES: Orca["bubbles"] = [[-26, 0, 0.8, 0], [-26, 0, 0.7, 0], [-26, 0, 0.6, 0]];
const NO_RIPPLE: Orca["ripple"] = [[-24, 2, 0], [-24, 2, 0], [-24, 2, 0]];
const NO_SPRAY: Orca["spray"] = Array.from({ length: 6 }, () => [0, 0, 0.8, 0] as [number, number, number, number]);
const BASE: Orca = {
	tx: 0, ty: 0, rot: 0, sc: 1, sx: 1, op: 1, beat: 0, fluke: 0, arch: 0, pec: 10, fin: 0, glow: 0.5, lum: 1, rim: 0.85, patch: 0.95,
	bubbles: NO_BUBBLES, ripple: NO_RIPPLE, spray: NO_SPRAY, splash: [2, 1, 0],
};
const o = (p: Partial<Orca>): Orca => ({ ...BASE, ...p });
/** Bubbles trailing from the tail at phase p (0..1 along their life), three staggered. */
const trail = (p: number, strength: number, y = 0): Orca["bubbles"] =>
	[0, 1 / 3, 2 / 3].map((off, i) => {
		const q = (p + off) % 1;
		return [-30 - q * 12, y - 1 + i * 1.2 - q * 2.5, 0.9 - q * 0.3, strength * Math.sin(q * Math.PI)] as [number, number, number, number];
	});

// ---------------------------------------------------------------------------------------------------------------
// Director: the target under review, a turning bipyramid of light.
// ---------------------------------------------------------------------------------------------------------------

interface Target { th: number; ty: number; lum: number; glow: number; core: number; ring: number; ringR: number; rays: number; raysR: number; sc: number; op: number }
const DIR_W = 63, DIR_H = 72, DAX = 31, DAY = 36;
function targetSvg(t: Target): string {
	const R = 14, E = 4.2, TOP = -21, BOT = 19;
	const v = [0, 1, 2, 3].map(k => {
		const a = ((t.th + 90 * k) * Math.PI) / 180;
		return { x: R * Math.cos(a), y: E * Math.sin(a), a };
	});
	const faces: string[] = [];
	const edges: string[] = [];
	for (const [apex, up] of [[TOP, true], [BOT, false]] as const) {
		for (let k = 0; k < 4; k++) {
			const p = v[k]!, q = v[(k + 1) % 4]!;
			const facing = Math.sin(((t.th + 90 * k + 45) * Math.PI) / 180); // +1 toward viewer
			const light = Math.max(0, Math.cos(((t.th + 90 * k + 45 - 120) * Math.PI) / 180));
			const lumF = (up ? 50 : 34) + 40 * light * Math.max(0, facing);
			const op = 0.16 + 0.62 * Math.max(0, facing);
			faces.push(`<path d="M0 ${n(apex)} L${n(p.x)} ${n(p.y)} L${n(q.x)} ${n(q.y)} Z" fill="${grey(lumF * t.lum)}" opacity="${n(op)}"/>`);
			edges.push(`<path d="M0 ${n(apex)} L${n(p.x)} ${n(p.y)}" stroke-opacity="${n(0.25 + 0.65 * Math.max(0, Math.sin(p.a)))}"/>`);
		}
	}
	const eq = v.map(p => `${n(p.x)} ${n(p.y)}`);
	// The halo hugs the silhouette: top and bottom apex, the outermost equator vertex on each side.
	const right = v.reduce((a, b) => (b.x > a.x ? b : a));
	const left = v.reduce((a, b) => (b.x < a.x ? b : a));
	const hull = `<path d="M0 ${n(TOP)} L${n(right.x)} ${n(right.y)} L0 ${n(BOT)} L${n(left.x)} ${n(left.y)} Z"/>`;
	const place = `translate(${DAX} ${n(DAY + t.ty)}) scale(${n(t.sc)})`;
	const rays = [0, 1, 2, 3, 4, 5, 6, 7].map(k => {
		const a = (k * Math.PI) / 4 + Math.PI / 8;
		const r0 = t.raysR * 0.55, r1 = t.raysR;
		return `<path d="M${n(r0 * Math.cos(a))} ${n(r0 * Math.sin(a) * 0.9)} L${n(r1 * Math.cos(a))} ${n(r1 * Math.sin(a) * 0.9)}"/>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIR_W}" height="${DIR_H}" viewBox="0 0 ${DIR_W} ${DIR_H}">
<defs>
<filter id="halo" filterUnits="userSpaceOnUse" x="-20" y="-20" width="${DIR_W + 40}" height="${DIR_H + 40}"><feGaussianBlur stdDeviation="4"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-20" y="-20" width="${DIR_W + 40}" height="${DIR_H + 40}"><feGaussianBlur stdDeviation="1.6"/></filter>
<radialGradient id="core"><stop offset="0" stop-color="rgb(100%,100%,100%)"/><stop offset="0.5" stop-color="rgb(100%,100%,100%)" stop-opacity="0.5"/><stop offset="1" stop-color="rgb(100%,100%,100%)" stop-opacity="0"/></radialGradient>
</defs>
<g transform="${place}" opacity="${n(t.op)}">
<g fill="rgb(100%,100%,100%)" opacity="${n(t.glow)}" filter="url(#halo)">${hull}</g>
${faces.join("\n")}
<g fill="none" stroke="${grey(92 * Math.min(1.08, t.lum))}" stroke-width="0.8" stroke-linecap="round">${edges.join("")}<path d="M${eq[0]} L${eq[1]} L${eq[2]} L${eq[3]} Z" stroke-opacity="0.55"/></g>
<ellipse cx="0" cy="0" rx="${n(t.ringR)}" ry="${n(t.ringR * 0.3)}" fill="none" stroke="rgb(85%,85%,85%)" stroke-width="0.8" opacity="${n(t.ring)}"/>
<g fill="none" stroke="rgb(90%,90%,90%)" stroke-width="1" stroke-linecap="round" opacity="${n(t.rays)}">${rays}</g>
</g>
<g id="accent">
<g transform="${place}" opacity="${n(t.core * t.op)}">
<ellipse cx="0" cy="-1" rx="7" ry="8.5" fill="url(#core)" opacity="0.7"/>
<path d="M0 -6.5 L3.2 -1 L0 4.5 L-3.2 -1 Z" fill="rgb(100%,100%,100%)" filter="url(#soft)"/>
<path d="M0 -4.5 L2 -1 L0 2.5 L-2 -1 Z" fill="rgb(100%,100%,100%)"/>
</g>
</g>
</svg>
`;
}
const TB: Target = { th: 0, ty: 0, lum: 1, glow: 0.45, core: 0.9, ring: 0.25, ringR: 19, rays: 0, raysR: 22, sc: 1, op: 1 };
const tg = (p: Partial<Target>): Target => ({ ...TB, ...p });

// ---------------------------------------------------------------------------------------------------------------
// Background: light shafts and motes, no surface (raster.ts draws it); fades at the top and bottom edges.
// ---------------------------------------------------------------------------------------------------------------

function backgroundSvg(p: number): string {
	const W = 432, H = 90;
	const shafts = [18, 74, 128, 170, 236, 292, 338, 398].map((x0, i) => {
		const sway = 6 * Math.sin((p + i * 0.37) * Math.PI * 2);
		const wTop = 7 + (i % 3) * 3, wBot = wTop * 2.4;
		const x = x0 + sway;
		const lean = 22;
		const op = 0.5 + 0.35 * Math.sin((p * 2 + i * 0.23) * Math.PI * 2);
		return `<path d="M${n(x - wTop / 2)} -4 L${n(x + wTop / 2)} -4 L${n(x - lean + wBot / 2)} ${H + 4} L${n(x - lean - wBot / 2)} ${H + 4} Z" opacity="${n(op)}"/>`;
	}).join("");
	const motes = Array.from({ length: 22 }, (_, i) => {
		const hx = ((i * 0.6180339) % 1) * W;
		const hy = ((i * 0.4142) % 1) * (H - 16) + 8;
		const y = hy - 3 * Math.sin((p + i * 0.21) * Math.PI * 2); // a slow periodic drift, seamless over the loop
		const x = hx + 2 * Math.sin((p + i * 0.3) * Math.PI * 2);
		const op = 0.5 * Math.sin(Math.PI * ((p + i * 0.137) % 1));
		return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(0.7 + (i % 3) * 0.25)}" opacity="${n(op)}"/>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<filter id="blur" filterUnits="userSpaceOnUse" x="-20" y="-20" width="${W + 40}" height="${H + 40}"><feGaussianBlur stdDeviation="5"/></filter>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(100%,100%,100%)" stop-opacity="0"/><stop offset="0.3" stop-color="rgb(100%,100%,100%)" stop-opacity="1"/><stop offset="0.6" stop-color="rgb(100%,100%,100%)" stop-opacity="0.7"/><stop offset="1" stop-color="rgb(100%,100%,100%)" stop-opacity="0"/></linearGradient>
<mask id="edge" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#fade)"/></mask>
</defs>
<g mask="url(#edge)">
<g fill="rgb(62%,62%,62%)" opacity="0.2" filter="url(#blur)">${shafts}</g>
<g fill="rgb(75%,75%,75%)">${motes}</g>
</g>
</svg>
`;
}

// ---------------------------------------------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------------------------------------------

interface Key<T> { at: number; pose: T; ease?: "linear" | "in" | "out" | "inOut" }
interface Seq<T> { actor: string; name: string; w: number; h: number; anchor: [number, number]; frameMs: number; loop: boolean; keys: Key<T>[]; render: (pose: T) => string }

function emit<T>(seq: Seq<T>): void {
	const dir = join(OUT, seq.actor);
	mkdirSync(dir, { recursive: true });
	const files = new Map<string, string>();
	const keys = seq.keys.map(key => {
		const svg = seq.render(key.pose);
		let file = files.get(svg);
		if (file === undefined) {
			file = `${seq.name}.${String.fromCharCode(97 + files.size)}.svg`;
			files.set(svg, file);
			writeFileSync(join(dir, file), svg);
		}
		return { at: key.at, svg: file, ...(key.ease === undefined ? {} : { ease: key.ease }) };
	});
	const durationMs = seq.keys[seq.keys.length - 1]!.at;
	const spec = { w: seq.w, h: seq.h, anchor: { x: seq.anchor[0], y: seq.anchor[1] }, frameMs: seq.frameMs, durationMs, loop: seq.loop, keys };
	writeFileSync(join(dir, `${seq.name}.json`), `${JSON.stringify(spec, null, "\t")}\n`);
}

rmSync(OUT, { recursive: true, force: true });

const WH = 54, AX = 46, AY = 30;
const worker = (name: string, frameMs: number, loop: boolean, keys: Key<Orca>[], h = WH, ay = AY): Seq<Orca> =>
	({ actor: "worker", name, w: ORCA_W, h, anchor: [AX, ay], frameMs, loop, keys, render: pose => orcaSvg(pose, ORCA_W, h, AX, ay) });

// work: 2 s loop, two tail beats, bubbles trailing.
const work = (p: number, beat: number, extra: Partial<Orca> = {}): Orca => o({ beat, ty: -beat * 0.8, rot: beat * 1.2, pec: 8 + beat * 6, bubbles: trail(p, 0.8), ...extra });
const workKeys: Key<Orca>[] = [
	{ at: 0, pose: work(0, 1) }, { at: 500, pose: work(0.25, -1) }, { at: 1000, pose: work(0.5, 1) }, { at: 1500, pose: work(0.75, -1) }, { at: 2000, pose: work(1, 1, { bubbles: trail(0, 0.8) }) },
];
emit(worker("work", 83, true, workKeys));

// quiet: half amplitude, fins doing the fine work.
const quiet = (p: number, beat: number, pec: number): Orca => o({ beat, ty: -beat * 0.4, pec, glow: 0.4, bubbles: trail(p, 0.35, 1) });
emit(worker("quiet", 83, true, [
	{ at: 0, pose: quiet(0, 0.5, 0) }, { at: 500, pose: quiet(0.25, -0.5, 28) }, { at: 1000, pose: quiet(0.5, 0.5, 0) }, { at: 1500, pose: quiet(0.75, -0.5, 28) }, { at: 2000, pose: quiet(0, 0.5, 0) },
]));

// ready: holding station, slow breath, nose a little up, fins spread.
emit(worker("ready", 113, true, [
	{ at: 0, pose: o({ beat: 0.25, rot: -3, ty: 0.6, pec: 22, glow: 0.38, lum: 0.9 }) },
	{ at: 1700, pose: o({ beat: -0.25, rot: -4.5, ty: -1.2, pec: 32, glow: 0.5, lum: 0.95, arch: 0.15 }) },
	{ at: 3400, pose: o({ beat: 0.25, rot: -3, ty: 0.6, pec: 22, glow: 0.38, lum: 0.9 }) },
]));

// rest: idle drift, nose down, dim, fins tucked.
emit(worker("rest", 113, true, [
	{ at: 0, pose: o({ beat: -0.35, rot: 5, ty: 2, pec: 0, glow: 0.22, lum: 0.72, rim: 0.55, patch: 0.6, arch: -0.2 }) },
	{ at: 1700, pose: o({ beat: -0.15, rot: 6, ty: 3, pec: 4, glow: 0.28, lum: 0.74, rim: 0.55, patch: 0.6, arch: -0.2 }) },
	{ at: 3400, pose: o({ beat: -0.35, rot: 5, ty: 2, pec: 0, glow: 0.22, lum: 0.72, rim: 0.55, patch: 0.6, arch: -0.2 }) },
]));

// submit: rises and lifts its nose toward the target, one bright pulse, then holds.
emit(worker("submit", 83, false, [
	{ at: 0, pose: o({ beat: 0.4 }) },
	{ at: 350, pose: o({ beat: -0.8, rot: -12, ty: -4, pec: 30, glow: 1, lum: 1.25, splash: [10, 4, 0.7] }), ease: "out" },
	{ at: 900, pose: o({ beat: 0.2, rot: -8, ty: -3, pec: 24, glow: 0.7, lum: 1.1, splash: [20, 8, 0] }) },
]));

// review: cruising slowly with a head sweep, scanning.
const review = (beat: number, rot: number, p: number): Orca => o({ beat, rot, ty: rot * 0.25, pec: 14 - rot, glow: 0.55, patch: 1, bubbles: trail(p, 0.5) });
emit(worker("review", 100, true, [
	{ at: 0, pose: review(0.7, -6, 0) },
	{ at: 725, pose: review(-0.7, -1, 0.25) },
	{ at: 1450, pose: review(0.7, 6, 0.5) },
	{ at: 2175, pose: review(-0.7, 1, 0.75) },
	{ at: 2900, pose: review(0.7, -6, 0) },
]));

// accepted: the breach. A taller box; the body leaps above its place and drops back.
const BH = 117, BAY = 93;
const spray = (spread: number, rise: number, op: number, cx = 0): Orca["spray"] =>
	[-1, -0.6, -0.2, 0.2, 0.6, 1].map((u, i) => [AX + cx + u * spread, BAY - 6 - rise * (1 - u * u * 0.6) + (i % 2) * 2, 0.9 + (i % 3) * 0.3, op] as [number, number, number, number]);
emit(worker("accepted", 83, false, [
	{ at: 0, pose: o({ beat: 0.5, spray: spray(2, 0, 0) }) },
	{ at: 260, pose: o({ beat: -1, rot: -28, ty: 4, tx: -3, glow: 0.8, lum: 1.15, spray: spray(2, 0, 0) }), ease: "inOut" },
	{ at: 620, pose: o({ beat: 0.6, rot: -60, ty: -42, tx: 2, glow: 1, lum: 1.3, spray: spray(10, 8, 0.9, -2), splash: [8, 3, 0.9] }), ease: "out" },
	{ at: 900, pose: o({ beat: 0.3, arch: 0.6, rot: -10, ty: -60, tx: 9, glow: 1, lum: 1.35, spray: spray(16, 18, 0.5, -2), splash: [16, 5, 0.4] }), ease: "inOut" },
	{ at: 1180, pose: o({ beat: -0.4, arch: 0.3, rot: 55, ty: -30, tx: 14, glow: 0.9, lum: 1.25, spray: spray(18, 6, 0, -2), splash: [22, 7, 0] }), ease: "in" },
	{ at: 1320, pose: o({ beat: 0, rot: 75, ty: -6, tx: 16, op: 0.15, glow: 0.8, lum: 1.2, spray: spray(3, 0, 0, 16), splash: [3, 1, 0.9] }), ease: "linear" },
	{ at: 1560, pose: o({ beat: 0.2, rot: 0, ty: 1, tx: 0, op: 0.95, glow: 0.7, lum: 1.15, spray: spray(14, 22, 0.8, 16), splash: [14, 4.5, 0.6] }), ease: "out" },
	{ at: 1900, pose: o({ beat: 0.4, glow: 0.6, lum: 1.1, spray: spray(18, 4, 0, 16), splash: [22, 7, 0] }) },
], BH, BAY));

// unmet: knocked out of line: falls back and wide, then swims to catch up.
emit(worker("unmet", 83, false, [
	{ at: 0, pose: o({ beat: 0.3 }) },
	{ at: 180, pose: o({ beat: -1, fluke: -10, rot: 14, ty: 3, tx: -5, pec: 40, glow: 0.8, lum: 1.05 }), ease: "out" },
	{ at: 600, pose: o({ beat: 0.6, rot: 4, ty: 5, tx: -8, pec: 18, glow: 0.42, lum: 0.92, bubbles: trail(0.4, 0.6) }), ease: "inOut" },
]));

// blocked: stopped dead under the surface, the body still, only the pectoral fins sculling.
const blocked = (pec: number, fin: number): Orca => o({ beat: -0.2, rot: 2, ty: 1, pec, fin, glow: 0.3, lum: 0.85, rim: 0.7, patch: 1 });
emit(worker("blocked", 100, true, [
	{ at: 0, pose: blocked(-12, 0) }, { at: 600, pose: blocked(30, 2) }, { at: 1200, pose: blocked(-12, 0) }, { at: 1800, pose: blocked(30, 2) }, { at: 2400, pose: blocked(-12, 0) },
]));

// excluded: sinks away into the dark, smaller and fainter.
emit(worker("excluded", 83, false, [
	{ at: 0, pose: o({ beat: 0.2 }) },
	{ at: 800, pose: o({ beat: -0.3, rot: 12, ty: 8, tx: -4, sc: 0.72, op: 0.4, pec: 0, glow: 0.12, lum: 0.7, rim: 0.4, patch: 0.4 }), ease: "out" },
]));

// waiting-user: everyone holds still.
emit(worker("waiting-user", 2400, true, [
	{ at: 0, pose: o({ beat: 0.1, pec: 18, glow: 0.4, lum: 0.92 }) },
	{ at: 2400, pose: o({ beat: 0.1, pec: 18, glow: 0.4, lum: 0.92 }) },
]));

// finale: one long stroke, then a glide forward leaving a ripple, the pod aligned.
const ripple = (k: number, op: number): Orca["ripple"] => [0, 1, 2].map(i => [-30 - i * 6 - k * 10, 2 + i * 3 + k * 8, op * (1 - i * 0.25)] as [number, number, number]);
emit(worker("finale", 110, false, [
	{ at: 0, pose: o({ beat: 0.3, ripple: ripple(0, 0) }) },
	{ at: 450, pose: o({ beat: 1, tx: -2, rot: -1, glow: 0.7, ripple: ripple(0, 0.2) }), ease: "inOut" },
	{ at: 900, pose: o({ beat: -1, tx: 2, glow: 0.85, lum: 1.15, ripple: ripple(0.3, 0.7), bubbles: trail(0.3, 0.7) }), ease: "inOut" },
	{ at: 2200, pose: o({ beat: 0, tx: 9, glow: 0.6, lum: 1.05, pec: 4, ripple: ripple(1, 0.15), bubbles: trail(0.95, 0.1) }), ease: "out" },
]));

// lights-out: slows, sinks a little and dims, still facing its piece.
emit(worker("lights-out", 250, false, [
	{ at: 0, pose: o({ beat: 0.5 }) },
	{ at: 1300, pose: o({ beat: -0.4, glow: 0.4, ty: 1 }) },
	{ at: 4000, pose: o({ beat: -0.1, rot: 3, ty: 3, pec: 6, glow: 0.12, lum: 0.62, rim: 0.45, patch: 0.45 }), ease: "out" },
]));

// user-steer: the user spoke to it: it turns toward the viewer, nods once, and turns back into line.
emit(worker("user-steer", 83, false, [
	{ at: 0, pose: o({ beat: 0.3 }) },
	{ at: 280, pose: o({ sx: 0.42, rot: -4, beat: 0, pec: 34, glow: 0.75, lum: 1.12, patch: 1 }), ease: "out" },
	{ at: 450, pose: o({ sx: 0.42, rot: 12, ty: 2, beat: 0.2, pec: 30, glow: 0.8, lum: 1.15, patch: 1 }), ease: "inOut" },
	{ at: 600, pose: o({ sx: 0.42, rot: -3, ty: 0, beat: 0, pec: 34, glow: 0.75, lum: 1.12, patch: 1 }), ease: "inOut" },
	{ at: 900, pose: o({ beat: 0.5, glow: 0.55, bubbles: trail(0.3, 0.6) }), ease: "inOut" },
]));

// user-stop: the user stopped it: it leaves the line and dives deep until it is gone.
emit(worker("user-stop", 83, false, [
	{ at: 0, pose: o({ beat: 0.3 }) },
	{ at: 300, pose: o({ beat: 1, fluke: 8, rot: 20, ty: 2, tx: 2, pec: 0, glow: 0.6 }), ease: "out" },
	{ at: 1200, pose: o({ beat: -0.6, rot: 42, ty: 24, tx: 10, sc: 0.62, op: 0, pec: -4, glow: 0.1, lum: 0.6, patch: 0.3, bubbles: trail(0.6, 0.9, -6) }), ease: "in" },
], 72, AY));

// gather: the species arrives: it rises from the deep and swims into line.
emit(worker("gather", 100, false, [
	{ at: 0, pose: o({ beat: 0.6, rot: -30, ty: 22, tx: -8, sc: 0.62, op: 0, glow: 0.1, lum: 0.6, patch: 0.3 }) },
	{ at: 700, pose: o({ beat: -1, rot: -14, ty: 5, tx: -2, sc: 0.92, glow: 0.7, lum: 1.05, bubbles: trail(0.5, 0.8, 3) }), ease: "out" },
	{ at: 1200, pose: o({ beat: 0.4, glow: 0.55, bubbles: trail(0.9, 0.3) }), ease: "inOut" },
], 72, AY));

// Director.
const director = (name: string, frameMs: number, loop: boolean, keys: Key<Target>[]): Seq<Target> =>
	({ actor: "director", name, w: DIR_W, h: DIR_H, anchor: [DAX, DAY], frameMs, loop, keys, render: targetSvg });
emit(director("work", 160, true, [
	{ at: 0, pose: tg({ th: 0, core: 0.85 }) },
	{ at: 1200, pose: tg({ th: 22.5, core: 1, glow: 0.55 }), ease: "linear" },
	{ at: 2400, pose: tg({ th: 45, core: 0.85 }), ease: "linear" },
	{ at: 3600, pose: tg({ th: 67.5, core: 1, glow: 0.55 }), ease: "linear" },
	{ at: 4800, pose: tg({ th: 90, core: 0.85 }), ease: "linear" },
]));
emit(director("waiting-user", 2400, true, [
	{ at: 0, pose: tg({ th: 45, core: 1, glow: 0.4 }) },
	{ at: 2400, pose: tg({ th: 45, core: 1, glow: 0.4 }) },
]));
emit(director("finale", 120, false, [
	{ at: 0, pose: tg({ th: 0 }) },
	{ at: 900, pose: tg({ th: 60, ty: -3, lum: 1.25, glow: 0.9, core: 1, ring: 0.9, ringR: 20, rays: 0.9, raysR: 24 }), ease: "inOut" },
	{ at: 2200, pose: tg({ th: 90, ty: -2, lum: 1.15, glow: 0.65, core: 1, ring: 0, ringR: 30, rays: 0, raysR: 32 }), ease: "out" },
]));
emit(director("lights-out", 250, false, [
	{ at: 0, pose: tg({ th: 0 }) },
	{ at: 4000, pose: tg({ th: 40, lum: 0.6, glow: 0.12, core: 0.35, ring: 0.05 }), ease: "out" },
]));
// rest: almost still, a very slow breath of light.
emit(director("rest", 170, true, [
	{ at: 0, pose: tg({ th: 12, lum: 0.78, glow: 0.28, core: 0.55, ring: 0.12 }) },
	{ at: 1700, pose: tg({ th: 14, lum: 0.9, glow: 0.42, core: 0.8, ring: 0.2 }) },
	{ at: 3400, pose: tg({ th: 12, lum: 0.78, glow: 0.28, core: 0.55, ring: 0.12 }) },
]));
// excluded: the species leaves: the crystal sinks and fades.
emit(director("excluded", 100, false, [
	{ at: 0, pose: tg({ th: 0 }) },
	{ at: 1200, pose: tg({ th: 25, ty: 15, sc: 0.8, lum: 0.45, glow: 0, core: 0.2, ring: 0, op: 0 }), ease: "in" },
]));
// gather: the species arrives: the crystal rises out of the deep and lights up.
emit(director("gather", 100, false, [
	{ at: 0, pose: tg({ th: -30, ty: 15, sc: 0.8, lum: 0.5, glow: 0, core: 0.3, ring: 0, op: 0 }) },
	{ at: 800, pose: tg({ th: -5, ty: -2, lum: 1.2, glow: 0.85, core: 1, ring: 0.7, ringR: 21 }), ease: "out" },
	{ at: 1200, pose: tg({ th: 0, ring: 0.25, ringR: 19 }), ease: "inOut" },
]));

// Background: 4 s loop, six frames.
emit({ actor: "fx", name: "background", w: 432, h: 90, anchor: [0, 0], frameMs: 667, loop: true, render: backgroundSvg, keys: [
	{ at: 0, pose: 0, ease: "linear" }, { at: 1000, pose: 0.25, ease: "linear" }, { at: 2000, pose: 0.5, ease: "linear" }, { at: 3000, pose: 0.75, ease: "linear" }, { at: 4000, pose: 1, ease: "linear" },
] });
console.log("ok");
