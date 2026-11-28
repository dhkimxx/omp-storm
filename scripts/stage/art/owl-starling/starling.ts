/** The starling flock bird (`worker/fly`) and the lead bird (`director/gather`, `director/excluded`). Run through gen.ts. */
import { rmSync } from "node:fs";
import { f, type Key, SRC, write } from "./owl.ts";

interface BirdPose { flap?: number; op?: number; dx?: number; dy?: number; glow?: number }

// One starling in flight seen from behind: a small body, two pointed wings. `flap` 1 = wings up, -1 = down, 0 = glide.
// Drawn in a `w` by `h` box around its centre; `s` scales the drawing (1 = a 9 px flock bird).
function bird(w: number, h: number, s: number, blur: number): (pose: BirdPose) => string {
	return ({ flap = 0, op = 1, dx = 0, dy = 0, glow = 0.55 }) => {
		const cx = w / 2 + dx;
		const cy = h / 2 + dy;
		const tipY = cy - flap * 3.6 * s + 0.4 * s;
		const tipX = 4.3 * s - Math.abs(flap) * 0.5 * s;
		const ctrlY = cy - flap * 2 * s;
		const wing = (side: number): string => `M${f(cx - side * 0.2 * s)} ${f(cy - 0.6 * s)} Q${f(cx + side * 2.2 * s)} ${f(ctrlY - 0.6 * s)} ${f(cx + side * tipX)} ${f(tipY)} Q${f(cx + side * 2.2 * s)} ${f(ctrlY + 1.3 * s)} ${f(cx - side * 0.2 * s)} ${f(cy + 0.9 * s)} Z`;
		const wings = `${wing(-1)} ${wing(1)}`;
		const tail = `M${f(cx - 0.8 * s)} ${f(cy + 0.6 * s)} L${f(cx)} ${f(cy + 2.4 * s)} L${f(cx + 0.8 * s)} ${f(cy + 0.6 * s)} Z`;
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>
<filter id="halo" filterUnits="userSpaceOnUse" x="-10" y="-10" width="${w + 20}" height="${h + 20}"><feGaussianBlur stdDeviation="${blur}"/></filter>
</defs>
<g opacity="${f(op)}">
<path d="${wings} ${tail}" fill="rgb(100%,100%,100%)" opacity="${f(glow)}" filter="url(#halo)"/>
<path d="${wings}" fill="rgb(82%,82%,82%)"/>
<path d="${tail}" fill="rgb(70%,70%,70%)"/>
<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(0.8 * s)}" ry="${f(1.25 * s)}" fill="rgb(100%,100%,100%)"/>
</g>
</svg>
`;
	};
}

/** Rewrites src/starling/worker and src/starling/director. */
export function writeStarling(): void {
	const root = `${SRC}/starling`;
	rmSync(`${root}/worker`, { recursive: true, force: true });
	rmSync(`${root}/director`, { recursive: true, force: true });

	// The flock bird: two frames, wings up and wings down; 9x9 T1 px is one T2 pixel, so at T2 each bird is a dot.
	const wingsUp: BirdPose = { flap: 1, glow: 0.85 };
	write(`${root}/worker`, "fly", { w: 9, h: 9, anchor: { x: 4, y: 4 }, frameMs: 83, durationMs: 166, loop: true }, bird(9, 9, 1, 0.7), [
		{ at: 0, pose: wingsUp },
		{ at: 83, pose: { flap: -1, glow: 0.85 }, ease: "linear" },
		{ at: 166, pose: wingsUp, ease: "linear" },
	]);

	// The lead bird the murmuration turns around: arrives flapping, then glides.
	const lead = bird(36, 27, 3, 1.6);
	const up: BirdPose = { flap: 1 };
	const down: BirdPose = { flap: -1 };
	const flaps: Key<BirdPose>[] = [];
	for (let i = 1; i < 8; i++) flaps.push({ at: i * 180, pose: i % 2 === 0 ? up : down });
	write(`${root}/director`, "gather", { w: 36, h: 27, anchor: { x: 18, y: 13 }, frameMs: 83, durationMs: 2400, loop: false }, lead, [
		{ at: 0, pose: { flap: 1, op: 0, dy: 2 } },
		...flaps,
		{ at: 1700, pose: { flap: 0.15, glow: 0.7 }, ease: "out" },
		{ at: 2400, pose: { flap: 0, dy: -0.5, glow: 0.6 } },
	]);
	// Leaving: a few strong beats and it is gone.
	write(`${root}/director`, "excluded", { w: 36, h: 27, anchor: { x: 18, y: 13 }, frameMs: 83, durationMs: 1200, loop: false }, lead, [
		{ at: 0, pose: { flap: 0 } },
		{ at: 200, pose: { flap: 1, dy: -0.5 } },
		{ at: 400, pose: { flap: -1, dy: -1.5, dx: 1 } },
		{ at: 600, pose: { flap: 1, dy: -2.5, dx: 2, op: 0.8 } },
		{ at: 800, pose: { flap: -1, dy: -3.5, dx: 3, op: 0.5 } },
		{ at: 1200, pose: { flap: 1, dy: -5, dx: 5, op: 0 } },
	]);
}
