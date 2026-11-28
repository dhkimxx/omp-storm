/**
 * Generates the owl's and the starling's stage art (docs/stage.md): every key SVG and sequence JSON under
 * assets/stage/src/owl/ and assets/stage/src/starling/. The folders are rewritten from scratch, so edit the art here and
 * regenerate, never the SVGs by hand.
 *
 *   bun scripts/stage/art/owl-starling/gen.ts            # owl director, both backgrounds, starling
 *   bun scripts/stage/art/owl-starling/gen.ts work,rest  # only these owl director sequences
 *   bun scripts/stage/art/owl-starling/peek.ts /tmp/peek.png 4 assets/stage/src/owl/director/work.a.svg
 *   bun scripts/stage/bake.ts --only owl --no-write --contact /tmp/owl-contact
 */
import { rmSync } from "node:fs";
import { writeOwlBackground, writeStarlingBackground } from "./bg.ts";
import { type Key, owl, OWL_BOX as box, type OwlPose, SRC, type SequenceSpec, write } from "./owl.ts";
import { writeStarling } from "./starling.ts";

const only = process.argv[2];
const OWL = `${SRC}/owl/director`;
const seq = (name: string, spec: Omit<SequenceSpec, keyof typeof box>, keys: Key<OwlPose>[]): void => {
	if (only !== undefined && !only.split(",").includes(name)) return;
	write(OWL, name, { ...box, ...spec }, owl, keys);
};
if (only === undefined) rmSync(OWL, { recursive: true, force: true });

// Staring at the pieces: the head tilts one way, straightens, tilts the other way over 4 s; the pupils narrow as it
// tilts (focus) and open as it straightens.
const stareL: OwlPose = { ha: -10, hx: -1, hy: 1.2, look: 1.4, pupil: 1.4, lid: 0.28, bs: 1.01 };
const midA: OwlPose = { ha: 0, hy: 0.6, look: 0.9, pupil: 2.7, lid: 0.18 };
const stareR: OwlPose = { ha: 12, hx: 1.2, hy: 1.2, look: 1.4, pupil: 1.3, lid: 0.28, bs: 1.01 };
const midB: OwlPose = { ha: 1, hy: 0.4, look: 0.8, pupil: 2.8, lid: 0.16 };
seq("work", { frameMs: 125, durationMs: 4000, loop: true }, [
	{ at: 0, pose: stareL },
	{ at: 1000, pose: midA },
	{ at: 2000, pose: stareR },
	{ at: 3000, pose: midB },
	{ at: 4000, pose: stareL },
]);

// Facing the user: upright, tufts raised, eyes wide; only a slow glow breathes with the renderer's amber blink.
const face: OwlPose = { ha: 0, hy: -0.6, look: -0.4, tuft: 1, eye: 5.1, pupil: 3.3, lid: 0, eyeGlow: 1, glow: 0.55 };
seq("waiting-user", { frameMs: 200, durationMs: 2400, loop: true }, [
	{ at: 0, pose: face },
	{ at: 1200, pose: { ...face, glow: 0.7, pupil: 3.6 } },
	{ at: 2400, pose: face },
]);

// Direct edit: one foot lifts a piece to the chest; the talons loosen, turn it, grip again.
const hold: OwlPose = { foot: 1, grip: 1, piece: 1, pa: 0, ha: 7, hy: 1.6, look: 2, pupil: 1.6, lid: 0.25 };
seq("edit", { frameMs: 100, durationMs: 2400, loop: true }, [
	{ at: 0, pose: hold },
	{ at: 600, pose: { ...hold, grip: 0.2, pa: 18, ha: 3, pupil: 2.2 } },
	{ at: 1200, pose: { ...hold, pa: 45, ha: 10, pupil: 1.5 } },
	{ at: 1800, pose: { ...hold, grip: 0.2, pa: 66, ha: 4, pupil: 2.2 } },
	{ at: 2400, pose: { ...hold, pa: 90 } },
]);

// Resting: eyes half closed, tufts down, feathers fluffed; a slow breath.
const rest: OwlPose = { lid: 0.58, tuft: 0.15, bs: 1.03, hy: 1.6, look: 0.6, eye: 4.2, pupil: 2.4, eyeGlow: 0.65, glow: 0.36 };
seq("rest", { frameMs: 166, durationMs: 3400, loop: true }, [
	{ at: 0, pose: rest },
	{ at: 1700, pose: { ...rest, bs: 1.055, hy: 1.1, lid: 0.52, glow: 0.42 } },
	{ at: 3400, pose: rest },
]);

// Finale: upright, one short nod, then settles into the resting posture.
const up: OwlPose = { ha: 0, hy: -0.4, look: 0, tuft: 0.8, pupil: 2.8, lid: 0.1, glow: 0.6 };
seq("finale", { frameMs: 83, durationMs: 2200, loop: false }, [
	{ at: 0, pose: up },
	{ at: 380, pose: { ...up, hy: 3.6, look: 1.8, lid: 0.42, pupil: 2.2 }, ease: "out" },
	{ at: 760, pose: { ...up, hy: -0.8, glow: 0.7 } },
	{ at: 2200, pose: { ...rest, glow: 0.45 } },
]);

// Lights out with work left: it bows its head to the piece below and the light ebbs.
const down: OwlPose = { ha: -6, hx: -0.6, hy: 2.6, look: 2.2, pupil: 1.8, lid: 0.36, tuft: 0.4 };
seq("lights-out", { frameMs: 166, durationMs: 4000, loop: false }, [
	{ at: 0, pose: {} },
	{ at: 1600, pose: down },
	{ at: 4000, pose: { ...down, ha: -8, lid: 0.48, op: 0.58, glow: 0.14, eyeGlow: 0.45, tuft: 0.25 } },
]);

// Arriving (handoff into the owl): it glides down onto the branch, folds its wings and looks down at the pieces.
seq("gather", { frameMs: 83, durationMs: 1200, loop: false }, [
	{ at: 0, pose: { op: 0, branch: 0, wing: 1, by: -14, tuft: 0.3, lid: 0, glow: 0.7 } },
	{ at: 650, pose: { op: 1, branch: 1, wing: 0.75, by: -2, tuft: 0.4, lid: 0, glow: 0.7 }, ease: "out" },
	{ at: 1200, pose: { ...down, ha: 0, hx: 0, hy: 1.6, look: 1.6 } },
]);

// Leaving (handoff out of the owl): it spreads its wings, lets the piece fall toward the next species and lifts off.
seq("excluded", { frameMs: 83, durationMs: 1200, loop: false }, [
	{ at: 0, pose: { foot: 0.7, grip: 1, piece: 1, tuft: 0.7 } },
	{ at: 450, pose: { foot: 0.45, grip: 0, piece: 1, pdx: 3, pdy: 7, wing: 1, by: -3, tuft: 0.8, glow: 0.7 }, ease: "out" },
	{ at: 1200, pose: { foot: 0, grip: 0, piece: 0, pdx: 6, pdy: 20, wing: 0.85, by: -16, op: 0, branch: 0.4, tuft: 0.8, glow: 0.7 }, ease: "in" },
]);

if (only === undefined) {
	writeOwlBackground();
	writeStarlingBackground();
	writeStarling();
}
