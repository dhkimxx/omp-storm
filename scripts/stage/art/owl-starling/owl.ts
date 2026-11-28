/**
 * The owl director's key poses (one parametric drawing: every key has the same text, only numbers move) and the writer
 * every owl and starling generator here shares. Run through gen.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** assets/stage/src of this repository. */
export const SRC = fileURLToPath(new URL("../../../../assets/stage/src", import.meta.url));

export type Pt = [number, number];
export type Ease = "linear" | "in" | "out" | "inOut";
export interface SequenceSpec { w: number; h: number; anchor: { x: number; y: number }; frameMs: number; durationMs: number; loop: boolean }
/** One key: its time and the pose drawn there. Keys with the same pose (by identity) share one SVG file. */
export interface Key<Pose> { at: number; pose: Pose; ease?: Ease }

export const f = (n: number): string => {
	const r = Math.round(n * 100) / 100;
	return Object.is(r, -0) ? "0" : String(r);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const P = (a: Pt, b: Pt, t: number): Pt => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
const pt = (p: Pt): string => `${f(p[0])} ${f(p[1])}`;

/** Drawing units: the owl is drawn on a 72x81 grid and shown at 3/4, so a 5-row stage (72 px picture) fits it whole. */
const SCALE = 0.75;
const CX = 36;
/**
 * The sequence box: 54x63 T1 px. The feet stand on the sprite's branch at y 49.7 (drawing y 66.26), 15.7 px below the
 * anchor; the raised ear tufts reach y 0.4.
 */
export const OWL_BOX = { w: 54, h: 63, anchor: { x: 27, y: 34 } };

export const NEUTRAL = {
	op: 1, glow: 0.5, branch: 1,
	bx: 0, by: 0, bs: 1,
	hx: 0, hy: 0, ha: 0, look: 0, tuft: 0.6,
	eye: 4.4, pupil: 2.6, lid: 0.15, eyeGlow: 0.9,
	wing: 0, foot: 0, grip: 1, piece: 0, pa: 0, pdx: 0, pdy: 0,
};
export type OwlPose = Partial<typeof NEUTRAL>;

// Folded and spread left wing: M S C a b T C c d M2 C e g S Z
const WING_FOLD: Pt[] = [[24, 37.5], [17.5, 43], [16.5, 57], [27, 67], [27, 62], [26, 57], [25.5, 52], [25, 46], [25, 41]];
const WING_OPEN: Pt[] = [[24, 40], [15, 29], [7, 22], [0, 18], [3, 30], [7, 40], [13, 49], [17, 47], [21, 44]];
function wingPath(t: number, mirror: boolean): string {
	const p = WING_FOLD.map((a, i): Pt => {
		const q = P(a, WING_OPEN[i]!, t);
		return mirror ? [2 * CX - q[0], q[1]] : q;
	});
	return `M${pt(p[0]!)} C${pt(p[1]!)} ${pt(p[2]!)} ${pt(p[3]!)} C${pt(p[4]!)} ${pt(p[5]!)} ${pt(p[6]!)} C${pt(p[7]!)} ${pt(p[8]!)} ${pt(p[0]!)} Z`;
}
// Primary feathers: three lines from the wrist toward the tip.
function featherPath(t: number, mirror: boolean): string {
	const m = (p: Pt): Pt => (mirror ? [2 * CX - p[0], p[1]] : p);
	const lines: [Pt, Pt, Pt, Pt][] = [
		[[22, 46], [24, 62], [14, 36], [3, 22]],
		[[21, 50], [22, 60], [13, 42], [5, 33]],
		[[22, 54], [23, 58], [16, 46], [10, 42]],
	];
	return lines.map(([a0, a1, b0, b1]) => `M${pt(m(P(a0, b0, t)))} L${pt(m(P(a1, b1, t)))}`).join(" ");
}
// Toes: three per foot from the ankle; on the branch they spread over it, curled they close around a piece.
function toes(ankle: Pt, curl: number): string {
	return [-1, 0, 1].map(k => {
		const open: Pt = [ankle[0] + k * 3.2, ankle[1] + 4.2];
		const ctrlOpen: Pt = [ankle[0] + k * 2.6, ankle[1] + 1.2];
		const shut: Pt = [ankle[0] + k * 1.6 + 0.2, ankle[1] + 7.2];
		const ctrlShut: Pt = [ankle[0] + k * 4.2, ankle[1] + 3.4];
		return `M${pt(ankle)} Q${pt(P(ctrlOpen, ctrlShut, curl))} ${pt(P(open, shut, curl))}`;
	}).join(" ");
}

/** The owl on its branch, 72x81, in pose `o` (unset fields are NEUTRAL). The eyes are the accent layer. */
export function owl(o: OwlPose): string {
	const p = { ...NEUTRAL, ...o };
	const bodyT = `translate(${f(p.bx)} ${f(p.by)}) translate(36 66) scale(${f(p.bs)}) translate(-36 -66)`;
	const headT = `translate(${f(p.hx + p.bx)} ${f(p.hy + p.by)}) rotate(${f(p.ha)} 36 34)`;
	const ey = 22 + p.look;
	const lidY = ey - 5.8 + p.lid * 11.6;
	const tl = P([17.5, 10], [15, 0.5], p.tuft);
	const tr: Pt = [2 * CX - tl[0], tl[1]];
	// Feet: the left one stays on the branch; the right one lifts to the chest when it holds a piece.
	const ankleL: Pt = [30 + p.bx, 63.5 + p.by];
	const ankleR = P([42, 63.5], [50, 47], p.foot);
	ankleR[0] += p.bx;
	ankleR[1] += p.by;
	const curlR = p.foot * (0.35 + 0.65 * p.grip);
	const piece: Pt = [ankleR[0] + p.pdx, ankleR[1] + 7.5 + p.pdy];
	const legR = P([41, 61], [46, 52], p.foot);
	const head = "M36 8 C47.5 8 55 14 55 23 C55 32.5 47 38 36 38 C25 38 17 32.5 17 23 C17 14 24.5 8 36 8 Z";
	const body = "M36 33.5 C44 33.5 50 40 51.5 50 C53 60 46 67 36 67 C26 67 19 60 20.5 50 C22 40 28 33.5 36 33.5 Z";
	const c2: Pt = [tl[0] + 4, tl[1] + 3.5];
	const tufts = `M20.5 13 C19 10 ${pt(tl)} ${pt(tl)} C${pt(c2)} 22.5 8.5 25.5 9.8 Z M51.5 13 C53 10 ${pt(tr)} ${pt(tr)} C${pt([72 - c2[0], c2[1]])} 49.5 8.5 46.5 9.8 Z`;
	const chevrons = [[31, 45], [41, 45], [36, 49], [30, 53], [42, 53], [36, 57], [32, 61], [40, 61]]
		.map(([x, y]) => `M${x! - 2} ${y} L${x} ${y! + 1.6} L${x! + 2} ${y}`).join(" ");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${OWL_BOX.w}" height="${OWL_BOX.h}" viewBox="0 0 ${OWL_BOX.w} ${OWL_BOX.h}">
<defs>
<filter id="halo" filterUnits="userSpaceOnUse" x="-14" y="-14" width="100" height="109"><feGaussianBlur stdDeviation="3.4"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-14" y="-14" width="100" height="109"><feGaussianBlur stdDeviation="1.2"/></filter>
<filter id="eg" filterUnits="userSpaceOnUse" x="-14" y="-14" width="100" height="109"><feGaussianBlur stdDeviation="1.5"/></filter>
<radialGradient id="plume" cx="0.5" cy="0.32" r="0.66">
<stop offset="0" stop-color="rgb(70%,70%,70%)"/>
<stop offset="0.55" stop-color="rgb(40%,40%,40%)"/>
<stop offset="0.86" stop-color="rgb(34%,34%,34%)"/>
<stop offset="1" stop-color="rgb(72%,72%,72%)"/>
</radialGradient>
<radialGradient id="disc" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="rgb(30%,30%,30%)"/>
<stop offset="0.7" stop-color="rgb(62%,62%,62%)"/>
<stop offset="1" stop-color="rgb(86%,86%,86%)"/>
</radialGradient>
<linearGradient id="bark" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="rgb(40%,40%,40%)" stop-opacity="0"/>
<stop offset="0.22" stop-color="rgb(40%,40%,40%)" stop-opacity="1"/>
<stop offset="0.78" stop-color="rgb(40%,40%,40%)" stop-opacity="1"/>
<stop offset="1" stop-color="rgb(40%,40%,40%)" stop-opacity="0"/>
</linearGradient>
<linearGradient id="barkedge" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="rgb(80%,80%,80%)" stop-opacity="0"/>
<stop offset="0.3" stop-color="rgb(80%,80%,80%)" stop-opacity="1"/>
<stop offset="0.7" stop-color="rgb(80%,80%,80%)" stop-opacity="1"/>
<stop offset="1" stop-color="rgb(80%,80%,80%)" stop-opacity="0"/>
</linearGradient>
<clipPath id="sockets"><circle cx="29.5" cy="${f(ey)}" r="5.8"/><circle cx="42.5" cy="${f(ey)}" r="5.8"/></clipPath>
<clipPath id="open"><rect x="0" y="${f(lidY)}" width="72" height="81"/></clipPath>
</defs>
<g transform="scale(${SCALE})">
<g opacity="${f(p.branch)}">
<path d="M0 67.5 C18 65.5 50 65.8 72 68.5 L72 72.5 C50 70.6 18 70.4 0 72.5 Z" fill="url(#bark)"/>
<path d="M0 67.5 C18 65.5 50 65.8 72 68.5" fill="none" stroke="url(#barkedge)" stroke-width="0.8" stroke-opacity="0.7"/>
<path d="M14 71 C11 74 9 77 6 79" fill="none" stroke="rgb(40%,40%,40%)" stroke-width="1.4" stroke-linecap="round"/>
<g fill="rgb(100%,100%,100%)" filter="url(#soft)" opacity="0.7"><circle cx="18" cy="68.5" r="1"/><circle cx="54" cy="69.2" r="1.1"/><circle cx="60" cy="70.4" r="0.8"/></g>
</g>
<g opacity="${f(p.op)}">
<g transform="${bodyT}">
<path d="${body}" fill="rgb(100%,100%,100%)" opacity="${f(p.glow)}" filter="url(#halo)"/>
<path d="${wingPath(p.wing, false)} ${wingPath(p.wing, true)}" fill="rgb(100%,100%,100%)" opacity="${f(p.glow * p.wing)}" filter="url(#halo)"/>
<path d="${body}" fill="url(#plume)" fill-opacity="0.97"/>
<path d="${chevrons}" fill="none" stroke="rgb(92%,92%,92%)" stroke-width="0.9" stroke-opacity="0.6" stroke-linecap="round" stroke-linejoin="round"/>
<path d="${body}" fill="none" stroke="rgb(95%,95%,95%)" stroke-width="1.1"/>
<path d="${wingPath(p.wing, false)} ${wingPath(p.wing, true)}" fill="rgb(38%,38%,38%)" stroke="rgb(88%,88%,88%)" stroke-width="0.9" stroke-linejoin="round"/>
<path d="${featherPath(p.wing, false)} ${featherPath(p.wing, true)}" fill="none" stroke="rgb(70%,70%,70%)" stroke-width="0.7" stroke-opacity="${f(0.55 + 0.35 * p.wing)}" stroke-linecap="round"/>
</g>
<g opacity="${f(p.piece)}">
<rect x="${f(piece[0] - 4.5)}" y="${f(piece[1] - 4.5)}" width="9" height="9" fill="rgb(100%,100%,100%)" opacity="0.75" filter="url(#halo)"/>
<rect x="${f(piece[0] - 3.1)}" y="${f(piece[1] - 3.1)}" width="6.2" height="6.2" transform="rotate(${f(45 + p.pa)} ${f(piece[0])} ${f(piece[1])})" fill="rgb(100%,100%,100%)" stroke="rgb(100%,100%,100%)" stroke-width="0.6"/>
</g>
<path d="M33 61 L${pt(ankleL)} M${pt([legR[0] + p.bx, legR[1] + p.by])} L${pt(ankleR)}" fill="none" stroke="rgb(85%,85%,85%)" stroke-width="2" stroke-linecap="round"/>
<path d="${toes(ankleL, 0)} ${toes(ankleR, curlR)}" fill="none" stroke="rgb(100%,100%,100%)" stroke-width="1.3" stroke-linecap="round"/>
<g transform="${headT}">
<path d="${head} ${tufts}" fill="rgb(100%,100%,100%)" opacity="${f(p.glow)}" filter="url(#halo)"/>
<path d="${tufts}" fill="rgb(72%,72%,72%)" stroke="rgb(96%,96%,96%)" stroke-width="1" stroke-linejoin="round"/>
<path d="${head}" fill="url(#plume)" fill-opacity="0.97"/>
<path d="M36 ${f(15 + p.look * 0.5)} C31 ${f(13 + p.look * 0.5)} 20.5 14.5 20.5 ${f(23 + p.look * 0.6)} C20.5 30.5 28 34 36 ${f(31.5 + p.look * 0.4)} C44 34 51.5 30.5 51.5 ${f(23 + p.look * 0.6)} C51.5 14.5 41 ${f(13 + p.look * 0.5)} 36 ${f(15 + p.look * 0.5)} Z" fill="url(#disc)" fill-opacity="0.7"/>
<path d="${head}" fill="none" stroke="rgb(95%,95%,95%)" stroke-width="1.1"/>
<circle cx="29.5" cy="${f(ey)}" r="5.8" fill="rgb(3%,3%,3%)"/><circle cx="42.5" cy="${f(ey)}" r="5.8" fill="rgb(3%,3%,3%)"/>
<g clip-path="url(#sockets)"><rect x="22" y="${f(ey - 6.2)}" width="28" height="${f(lidY - ey + 6.2)}" fill="rgb(56%,56%,56%)"/><path d="M22 ${f(lidY)} L50 ${f(lidY)}" stroke="rgb(100%,100%,100%)" stroke-width="0.9" stroke-opacity="${f(Math.min(1, p.lid * 3))}"/></g>
<path d="M34.3 ${f(ey + 4.2)} L37.7 ${f(ey + 4.2)} L36 ${f(ey + 8.6)} Z" fill="rgb(90%,90%,90%)"/>
</g>
</g>
</g>
<g id="accent" transform="scale(${SCALE})">
<g opacity="${f(p.op * p.eyeGlow)}" transform="${headT}"><g clip-path="url(#open)">
<circle cx="29.5" cy="${f(ey)}" r="${f(p.eye + 1.4)}" fill="rgb(100%,100%,100%)" opacity="0.5" filter="url(#eg)"/><circle cx="42.5" cy="${f(ey)}" r="${f(p.eye + 1.4)}" fill="rgb(100%,100%,100%)" opacity="0.5" filter="url(#eg)"/>
<circle cx="29.5" cy="${f(ey)}" r="${f(p.eye)}" fill="rgb(100%,100%,100%)"/><circle cx="42.5" cy="${f(ey)}" r="${f(p.eye)}" fill="rgb(100%,100%,100%)"/>
<circle cx="29.5" cy="${f(ey + 0.2)}" r="${f(p.pupil)}" fill="rgb(0%,0%,0%)"/><circle cx="42.5" cy="${f(ey + 0.2)}" r="${f(p.pupil)}" fill="rgb(0%,0%,0%)"/>
</g></g>
</g>
</svg>
`;
}

/** Writes `<dir>/<name>.json` and one SVG per distinct pose (`<name>.a.svg`, `.b.svg`, … in order of first use). */
export function write<Pose>(dir: string, name: string, spec: SequenceSpec, draw: (pose: Pose) => string, keys: readonly Key<Pose>[]): void {
	mkdirSync(dir, { recursive: true });
	const letters = "abcdefghij";
	const files: { pose: Pose; file: string }[] = [];
	const keySpecs = keys.map(k => {
		let file = files.find(x => x.pose === k.pose)?.file;
		if (file === undefined) {
			file = `${name}.${letters[files.length]}.svg`;
			files.push({ pose: k.pose, file });
			writeFileSync(join(dir, file), draw(k.pose));
		}
		return { at: k.at, svg: file, ...(k.ease ? { ease: k.ease } : {}) };
	});
	writeFileSync(join(dir, `${name}.json`), `${JSON.stringify({ ...spec, keys: keySpecs }, null, "\t")}\n`);
}
