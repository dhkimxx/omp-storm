/** The two ways a picture comes to rest: the amber block of a run that waits for the user, and the finale's lane flashes. */
import { amberOf } from "./colours.ts";
import type { Fx } from "./fx.ts";
import { smooth, TAU } from "./math.ts";
import { FREEZE_DRAIN_MS } from "./timing.ts";

const FREEZE_DRAIN = 0.85;
const BLOCK_PULSE_MS = 2400;
const FLASH_FIRST_MS = 500;
const FLASH_STEP_MS = 170;
const FLASH_MS = 380;
/** Every lane has flashed by this many ms into the finale, however many lanes there are. */
const FLASH_STAGGER_BUDGET_MS = 1200;

/** 0..1: how strongly a lane flashes in the finale; the lanes flash top to bottom. */
export function finaleFlash(fx: Fx, lane: number): number {
	if (!fx.finale || !fx.motion) return 0;
	const row = fx.scene.rowOf[lane] ?? -1;
	if (row < 1) return 0;
	const step = Math.min(FLASH_STEP_MS, FLASH_STAGGER_BUDGET_MS / Math.max(1, fx.rows - 1));
	const u = (fx.age - (FLASH_FIRST_MS + (row - 1) * step)) / FLASH_MS;
	return u < 0 || u > 1 ? 0 : Math.sin(u * Math.PI);
}

/**
 * Waiting for the user: everything is drained toward grey and stops; only the amber block at the trunk head and the
 * three dot columns before it pulse. The pulse runs on the caller's own time, because every other clock stands still.
 */
export function freeze(fx: Fx): void {
	const amount = FREEZE_DRAIN * (fx.motion ? smooth(fx.age / FREEZE_DRAIN_MS) : 1);
	fx.canvas.drain(amount);
	const mark = fx.scene.marks.find((m) => m.kind === "trunk-head");
	const cx = mark?.cx ?? Math.max(0, Math.round(fx.scene.headX / 2) - 1);
	const cy = mark?.cy ?? 0;
	const pulseV = fx.motion ? 0.5 + 0.5 * Math.sin((fx.liveT / BLOCK_PULSE_MS) * TAU) : 0.8;
	const amber = amberOf(fx);
	// The glow before the block, then the block itself; this alone is not drained.
	for (let k = 1; k <= 3; k++) {
		const e = (0.35 + 0.55 * pulseV) * (1 - k / 4);
		for (let y = 0; y < 4; y++) fx.canvas.dot((cx - k) * 2 + 1, cy * 4 + y, amber, e);
	}
	fx.canvas.text(cx, cy, "█", amber, 0.6 + 0.4 * pulseV, true);
}
