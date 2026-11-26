/**
 * What the picture is doing at the end of the phase it is in, from the snapshot alone: how long each effect plays and
 * when the clocks stop. The painter (`fx.ts`) and `liveliness` read the same function, so the timer the widget slows
 * down is never ahead of or behind the picture.
 */
import type { RunPhase } from "../../appearance.ts";
import type { LaneSnapshot } from "../model.ts";

/** The longest an event effect plays: the aurora band of an accepted lane enters 0.9 s after it and takes 1.1 s. */
export const EVENT_TAIL_MS = 2000;
export const BRANCH_MS = 600;
export const BURST_MS = 1300;
export const LIGHTNING_MS = 600;
export const BOUNCE_MS = 600;
export const WIPE_MS = 800;
/** The finale: the rainbow front runs the trunk in 1.4 s, and the lanes flash top to bottom in the time left. */
export const FINALE_MS = 2200;
export const LIGHTS_OUT_MS = 4000;
export const FREEZE_DRAIN_MS = 500;
export const DIM_WAIT_MS = 400;

export function phaseOf(snapshot: LaneSnapshot): RunPhase {
	return snapshot.phases[snapshot.phases.length - 1]?.phase ?? "working";
}

/** Milliseconds since the current phase began. */
export function phaseAgeOf(snapshot: LaneSnapshot): number {
	const last = snapshot.phases[snapshot.phases.length - 1];
	return last === undefined ? 0 : Math.max(0, snapshot.now - last.from);
}

/**
 * How long a phase's picture keeps moving before its clocks stop; Infinity when it never stops. The phases that wait
 * (for the user, between rounds) first let the last events play out; the end of a run plays its finale or its lights-out.
 */
export function settleMs(phase: RunPhase, complete: boolean): number {
	switch (phase) {
		case "waiting-user":
		case "between-rounds":
			return EVENT_TAIL_MS;
		case "stopping":
			return complete ? FINALE_MS : LIGHTS_OUT_MS;
		default:
			return Number.POSITIVE_INFINITY;
	}
}
