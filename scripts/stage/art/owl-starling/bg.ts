/** The owl's night wood and the starling's dusk sky (`fx/background`, 432x90 loops). Run through gen.ts. */
import { f, SRC, type SequenceSpec, write } from "./owl.ts";

// Deterministic pseudo-random.
const rnd = (seed: number): (() => number) => {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
};

const head = `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="90" viewBox="0 0 432 90">`;
const filters = `<filter id="haze" filterUnits="userSpaceOnUse" x="-30" y="-30" width="492" height="150"><feGaussianBlur stdDeviation="2.2"/></filter>
<filter id="far" filterUnits="userSpaceOnUse" x="-30" y="-30" width="492" height="150"><feGaussianBlur stdDeviation="1.1"/></filter>
<filter id="mote" filterUnits="userSpaceOnUse" x="-30" y="-30" width="492" height="150"><feGaussianBlur stdDeviation="0.8"/></filter>
<filter id="wide" filterUnits="userSpaceOnUse" x="-60" y="-60" width="552" height="210"><feGaussianBlur stdDeviation="9"/></filter>`;
const spec: SequenceSpec = { w: 432, h: 90, anchor: { x: 0, y: 0 }, frameMs: 500, durationMs: 4000, loop: true };
/** Four linear keys a second apart, the fifth back on the first: phase k of 4. */
const quarters = [0, 1, 2, 3, 4].map(k => ({ at: k * 1000, pose: k % 4, ease: "linear" as const }));

/** The owl: a night wood. Distant moonlit trunks, a long branch at the owl's perch height, mist, fireflies. */
export function writeOwlBackground(): void {
	const r = rnd(7);
	const trunks: { x: number; w: number; lean: number; near: number }[] = [];
	// Far trunks: thin, soft, faint; near trunks: wider, tapering, with a moonlit edge and a knot or two.
	for (let x = 8; x < 432; x += 22 + r() * 26) trunks.push({ x, w: 2.5 + r() * 3, lean: (r() - 0.5) * 8, near: 0 });
	for (let x = 30 + r() * 20; x < 432; x += 70 + r() * 50) trunks.push({ x, w: 9 + r() * 7, lean: (r() - 0.5) * 5, near: 1 });
	const flies = Array.from({ length: 11 }, (_, i) => ({ x: 20 + i * 38 + r() * 22, y: 22 + r() * 50, phase: r(), amp: 2 + r() * 3 }));
	const draw = (k: number): string => {
		const t = k / 4;
		const trunkSvg = trunks.map(({ x, w, lean, near }) => {
			const top = w * (near ? 0.7 : 0.8);
			const body = `M${f(x - top / 2 + lean)} -2 C${f(x - top / 2 + lean * 0.5)} 40 ${f(x - w / 2 - 0.5)} 70 ${f(x - w / 2 - 1.5)} 90 L${f(x + w / 2 + 1.5)} 90 C${f(x + w / 2 + 0.5)} 70 ${f(x + top / 2 + lean * 0.5)} 40 ${f(x + top / 2 + lean)} -2 Z`;
			const rim = `M${f(x + top / 2 + lean - 0.5)} -2 C${f(x + top / 2 + lean * 0.5 - 0.5)} 40 ${f(x + w / 2)} 70 ${f(x + w / 2 + 1)} 90`;
			return near
				? `<path d="${body}" fill="rgb(20%,20%,20%)" opacity="0.62"/><path d="${rim}" stroke="rgb(52%,52%,52%)" stroke-width="1" opacity="0.4" fill="none" filter="url(#mote)"/><ellipse cx="${f(x + lean * 0.4)}" cy="${f(30 + (x % 37))}" rx="1.6" ry="2.4" fill="rgb(8%,8%,8%)" opacity="0.7"/>`
				: `<path d="${body}" fill="rgb(26%,26%,26%)" opacity="0.32" filter="url(#far)"/>`;
		}).join("\n");
		const canopy = Array.from({ length: 9 }, (_, i) => `<ellipse cx="${f(i * 52 + 10 + ((i * 29) % 17))}" cy="${f(-4 + ((i * 13) % 9))}" rx="${f(30 + ((i * 7) % 14))}" ry="9" fill="rgb(30%,30%,30%)" opacity="0.2"/>`).join("");
		const fly = flies.map(({ x, y, phase, amp }) => {
			const a = (phase + t) * Math.PI * 2;
			const glow = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(a * 2));
			return `<circle cx="${f(x + amp * Math.cos(a))}" cy="${f(y + amp * 0.6 * Math.sin(a * 2))}" r="1.6" fill="rgb(100%,100%,100%)" opacity="${f(glow * 0.6)}" filter="url(#mote)"/><circle cx="${f(x + amp * Math.cos(a))}" cy="${f(y + amp * 0.6 * Math.sin(a * 2))}" r="0.6" fill="rgb(100%,100%,100%)" opacity="${f(glow)}"/>`;
		}).join("");
		const mist = 0.14 + 0.03 * Math.sin(t * Math.PI * 2);
		return `${head}
<defs>
${filters}
<linearGradient id="mist" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="rgb(40%,40%,40%)" stop-opacity="0"/>
<stop offset="1" stop-color="rgb(40%,40%,40%)" stop-opacity="${f(mist)}"/>
</linearGradient>
</defs>
<ellipse cx="350" cy="4" rx="70" ry="26" fill="rgb(60%,60%,60%)" opacity="0.14" filter="url(#wide)"/>
<g filter="url(#haze)">${canopy}</g>
${trunkSvg}
<path d="M-4 70 C60 66 120 71 190 68 C260 65 330 70 436 67 L436 71.5 C330 74 260 69.5 190 72.5 C120 75 60 70.5 -4 74 Z" fill="rgb(22%,22%,22%)" opacity="0.7"/>
<path d="M-4 70 C60 66 120 71 190 68 C260 65 330 70 436 67" fill="none" stroke="rgb(50%,50%,50%)" stroke-width="0.8" opacity="0.45"/>
<g fill="none" stroke="rgb(30%,30%,30%)" stroke-width="1.1" stroke-linecap="round" opacity="0.6"><path d="M48 68.5 C52 63 58 61 63 60"/><path d="M142 71 C147 76 150 80 156 83"/><path d="M262 68 C266 62 271 60 277 58.5"/><path d="M384 69 C389 74 393 77 399 79"/></g>
<rect x="0" y="52" width="432" height="38" fill="url(#mist)"/>
${fly}
</svg>
`;
	};
	write(`${SRC}/owl/fx`, "background", spec, draw, quarters);
}

/** The starling: an empty dusk sky. The last light along the horizon, two thin cloud streaks, the first stars. */
export function writeStarlingBackground(): void {
	const r = rnd(11);
	const stars = Array.from({ length: 16 }, () => ({ x: r() * 432, y: 3 + r() * 34, phase: r(), size: 0.5 + r() * 0.5 }));
	const draw = (k: number): string => {
		const t = k / 4;
		const sway = Math.sin(t * Math.PI * 2);
		const starSvg = stars.map(({ x, y, phase, size }) => {
			const glow = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((phase + t) * Math.PI * 4));
			return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(size)}" fill="rgb(100%,100%,100%)" opacity="${f(glow * 0.7)}"/>`;
		}).join("");
		return `${head}
<defs>
${filters}
<linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="rgb(50%,50%,50%)" stop-opacity="0"/>
<stop offset="0.5" stop-color="rgb(50%,50%,50%)" stop-opacity="0.05"/>
<stop offset="1" stop-color="rgb(62%,62%,62%)" stop-opacity="${f(0.3 + 0.02 * sway)}"/>
</linearGradient>
</defs>
<rect x="0" y="0" width="432" height="90" fill="url(#dusk)"/>
<ellipse cx="300" cy="96" rx="180" ry="20" fill="rgb(70%,70%,70%)" opacity="0.18" filter="url(#wide)"/>
<g fill="rgb(55%,55%,55%)" filter="url(#haze)">
<ellipse cx="${f(120 + 6 * sway)}" cy="58" rx="110" ry="1.8" opacity="0.22"/>
<ellipse cx="${f(330 - 5 * sway)}" cy="70" rx="140" ry="2.2" opacity="0.26"/>
<ellipse cx="${f(230 + 4 * sway)}" cy="46" rx="70" ry="1.2" opacity="0.14"/>
</g>
${starSvg}
<path d="M0 88 C80 86.5 160 87.5 230 86.8 C300 86 370 87.4 432 86.6 L432 90 L0 90 Z" fill="rgb(14%,14%,14%)" opacity="0.6"/>
</svg>
`;
	};
	write(`${SRC}/starling/fx`, "background", spec, draw, quarters);
}
