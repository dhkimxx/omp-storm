/**
 * The painter of the lane view: every strand, mark and label of a scene, with the colours and effects of the design
 * (see `effects/README.md` for the list and the numbers). The work is split by what is drawn:
 *
 *   effects/trunk.ts   aurora colour, the director's line, the finale rainbow
 *   effects/lanes.ts   a lane's line: flowing colour, comets, state shapes
 *   effects/events.ts  branch, merge burst, lightning, bounce, round wipe
 *   effects/rain.ts    spray ahead of the running heads
 *   effects/marks.ts   glyph marks, round ticks and labels
 *   effects/ending.ts  the waiting block and the finale's lane flashes
 *   effects/fx.ts      the context of one paint (clocks, dimming) and the two drawing primitives
 */
import type { Canvas } from "./canvas.ts";
import { branchEffect, bounce, lightning, mergeEffect } from "./effects/events.ts";
import { freeze } from "./effects/ending.ts";
import { dot, makeFx } from "./effects/fx.ts";
import { drawRoute } from "./effects/lanes.ts";
import { drawLabels, drawMarks, drawRoundTicks } from "./effects/marks.ts";
import { rain } from "./effects/rain.ts";
import { buildRoutes, densify } from "./effects/routes.ts";
import { greyOf, lineColour } from "./effects/colours.ts";
import { phaseAgeOf, phaseOf, settleMs } from "./effects/timing.ts";
import { drawTrunk, startAurora } from "./effects/trunk.ts";
import { mix } from "./colour.ts";
import type { LaneSnapshot } from "./model.ts";
import type { Scene } from "./scene.ts";

/**
 * Paints `scene` onto `canvas`. `t` is animation time in ms; with `motion` false nothing is animated and the picture does
 * not depend on `t`.
 */
export function paint(scene: Scene, canvas: Canvas, t: number, motion: boolean): void {
	const fx = makeFx(scene, canvas, t, motion);
	startAurora(fx);
	drawTrunk(fx);
	const routes = buildRoutes(fx);
	const shown = routes.filter((route) => (scene.rowOf[route.lane] ?? -1) >= 0);
	// Settled lanes first so live ones stay on top where cells are shared.
	const settled = (last: string): number => (last === "accepted" || last === "excluded" || last === "refused" ? 1 : 0);
	shown.sort((a, b) => settled(b.last) - settled(a.last));
	for (const route of shown) drawRoute(fx, route);
	for (const strand of scene.strands) {
		if (strand.kind !== "link") continue;
		const colour = mix(lineColour(fx, fx.hues[strand.lane] ?? 0), greyOf(fx), 0.6);
		densify(strand.points).forEach((p, i) => { if (i % 3 === 0) dot(fx, p.x, p.y, colour, 0.28, strand.lane); });
	}
	for (const route of shown) {
		branchEffect(fx, route);
		mergeEffect(fx, route);
		bounce(fx, route);
		lightning(fx, route);
	}
	drawRoundTicks(fx);
	drawMarks(fx);
	for (const label of scene.labels) for (let i = 0; i < label.width; i++) fx.busy[label.cy * canvas.cw + label.cx + i] = 1;
	rain(fx, routes);
	drawLabels(fx);
	if (fx.phase === "waiting-user") freeze(fx);
}

/**
 * How lively the picture is, so the widget can slow down or stop its timer:
 * - "full": something moves every frame. The working, workers and verifying phases always do (the trunk and the running
 *   lanes flow); so does a phase that is settling (the last events of a wait play out, the finale or the lights-out runs).
 * - "slow": only the amber block pulses (the run waits for the user).
 * - "still": nothing moves (between rounds, the settled end of a run).
 * This is the one place that says when a picture has finished moving, and it reads the same clocks as the painter
 * (`settleMs`), so an effect that has played out never keeps it at "full".
 */
export function liveliness(snapshot: LaneSnapshot): "full" | "slow" | "still" {
	const phase = phaseOf(snapshot);
	if (phaseAgeOf(snapshot) < settleMs(phase, snapshot.complete)) return "full";
	return phase === "waiting-user" ? "slow" : "still";
}
