/**
 * Glyph marks (the dots on the lines that are text, so they stay readable), the round ticks, and the labels.
 *
 * Labels. Left: the lane's name in its hue (bold while running, pale when finished) and its role word in grey. Right:
 * the state word coloured by state, and the lane's progress beside it when it has several results. The trunk row
 * carries the director's name and the phase word, coloured character by character from the aurora while the picture
 * moves.
 */
import type { RunPhase } from "../../appearance.ts";
import { mix, type Rgb } from "../colour.ts";
import type { LaneState } from "../model.ts";
import type { Label, Mark } from "../scene.ts";
import { aurora } from "./trunk.ts";
import {
	BASE_HUE, greenOf, greyOf, HUE_AMBER, HUE_GREEN, HUE_RED, hot, lineColour, redOf, textColour, textGrey, white,
} from "./colours.ts";
import { roundWipe } from "./events.ts";
import { ageOf, dot, type Fx, text } from "./fx.ts";
import { SCAN_PERIOD_MS, smooth, TAU } from "./math.ts";
import { BOUNCE_MS, BURST_MS, WIPE_MS } from "./timing.ts";

export function drawMarks(fx: Fx): void {
	const { scene } = fx;
	const jobCount = new Map<number, number>();
	for (const mark of scene.marks) if (mark.kind === "job") jobCount.set(mark.lane, (jobCount.get(mark.lane) ?? 0) + 1);
	const jobSeen = new Map<number, number>();
	const ordered = [...scene.marks].sort((a, b) => a.cx - b.cx);
	for (const mark of ordered) {
		const hue = mark.lane >= 0 ? (fx.hues[mark.lane] ?? 0) : BASE_HUE;
		const age = ageOf(fx, mark.at);
		switch (mark.kind) {
			case "accept": {
				const flashing = age < BURST_MS;
				const colour = flashing ? mix(hot(fx, HUE_GREEN), greenOf(fx), smooth((age - 150) / 700)) : greenOf(fx);
				text(fx, mark.cx, mark.cy, "●", colour, flashing ? 1.4 : 0.95, true);
				break;
			}
			case "unmet": {
				const colour = age < BOUNCE_MS ? hot(fx, hue) : mix(lineColour(fx, hue), white(fx), 0.3);
				text(fx, mark.cx, mark.cy, "○", colour, 1, true);
				break;
			}
			case "blocked": {
				text(fx, mark.cx, mark.cy, "✕", age < 200 ? hot(fx, HUE_RED) : redOf(fx), fx.lightsOut && fx.motion ? 0.95 : 1, true);
				break;
			}
			case "excluded": text(fx, mark.cx, mark.cy, "⊘", greyOf(fx), 0.6); break;
			case "review": {
				const v = fx.motion ? 0.5 + 0.5 * Math.sin((fx.t / SCAN_PERIOD_MS) * TAU * 2) : 0.8;
				text(fx, mark.cx, mark.cy, "◆", mix(greenOf(fx), hot(fx, HUE_GREEN), v * 0.7), 0.9 + 0.4 * v, true);
				break;
			}
			case "job": {
				const lane = mark.lane;
				const n = jobSeen.get(lane) ?? 0;
				jobSeen.set(lane, n + 1);
				// A running job fills its nodes in turn; otherwise a node is full when the job is done.
				const running = fx.last[lane] === "running" && fx.motion;
				const fill = running ? Math.floor(fx.t / 420) % ((jobCount.get(lane) ?? 0) + 1) : -1;
				const full = fill >= 0 ? n < fill : mark.done === true;
				const final = fx.last[lane] === "accepted";
				const colour = final ? mix(lineColour(fx, hue), greyOf(fx), 0.7) : lineColour(fx, hue);
				text(fx, mark.cx, mark.cy, full ? "■" : "□", colour, final ? 0.45 : 0.95, full && !final);
				break;
			}
			default: break;
		}
	}
}

export function drawRoundTicks(fx: Fx): void {
	const rounds = fx.scene.marks.filter((m) => m.kind === "round");
	const wiping = new Set<Mark>();
	for (const mark of rounds) if (roundWipe(fx, mark)) wiping.add(mark);
	let newest = -1;
	for (const mark of rounds) newest = Math.max(newest, mark.at);
	for (const mark of rounds) {
		if (wiping.has(mark)) continue;
		const latest = mark.at === newest;
		const stamped = ageOf(fx, mark.at) < WIPE_MS + 260;
		const colour = latest ? (stamped ? hot(fx, 200) : lineColour(fx, 205)) : mix(lineColour(fx, 215), greyOf(fx), 0.6);
		const energy = latest ? (stamped ? 1.5 : 1) : 0.5;
		for (let y = 0; y < 4; y++) dot(fx, mark.cx * 2, y, colour, energy);
		text(fx, mark.cx + 1, mark.cy, String(mark.round ?? ""), colour, latest ? 1 : 0.65, latest);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------------------------

const PHASE_HUE: Record<RunPhase, number | null> = {
	working: null, workers: null, verifying: HUE_GREEN, "waiting-user": HUE_AMBER, "between-rounds": null, stopping: null,
};

/** Text coloured char by char from the aurora, for the trunk's own labels. */
function auroraText(fx: Fx, label: Label, bold: boolean): void {
	let cx = label.cx;
	for (const char of label.text) {
		const a = aurora(fx, (cx - fx.scene.graph.cx0) * 2 + fx.scene.headX * 0.5);
		const colour = fx.dark ? mix(a.colour, 0xffffff, 0.12) : mix(a.colour, 0x000000, 0.3);
		cx += text(fx, cx, label.cy, char, colour, 1, bold);
	}
}

function stateStyle(fx: Fx, lane: number, state: LaneState): { colour: Rgb; energy: number; bold: boolean } {
	const hue = fx.hues[lane] ?? 0;
	switch (state) {
		case "running": return { colour: textColour(fx, hue, 0.15), energy: 1, bold: true };
		case "quiet": return { colour: textColour(fx, hue, 0.08), energy: 0.8, bold: false };
		case "submitted": return { colour: textColour(fx, hue, 0.05), energy: 0.95, bold: false };
		case "reviewing": return { colour: textColour(fx, HUE_GREEN, 0.16), energy: 1, bold: true };
		case "accepted": return { colour: textColour(fx, HUE_GREEN, 0.1), energy: 0.85, bold: false };
		case "unmet": return { colour: textColour(fx, hue, 0.1), energy: 1, bold: true };
		case "blocked": return { colour: textColour(fx, HUE_RED, 0.18), energy: 1, bold: true };
		default: return { colour: textGrey(fx), energy: 0.8, bold: false };
	}
}

export function drawLabels(fx: Fx): void {
	const { scene } = fx;
	for (const label of scene.labels) {
		const lane = label.lane;
		if (label.side === "scale") {
			text(fx, label.cx, label.cy, label.text, textGrey(fx), 0.8);
			continue;
		}
		if (lane < 0 && label.cy === 0) {
			// The trunk row: the director and the phase word, in aurora colours while the picture moves.
			if (label.side === "left") auroraText(fx, label, true);
			else {
				const hue = PHASE_HUE[fx.phase];
				if (hue !== null) text(fx, label.cx, label.cy, label.text, textColour(fx, hue, 0.16), 1, true);
				else if (fx.phase === "working" || fx.phase === "workers") auroraText(fx, label, true);
				else text(fx, label.cx, label.cy, label.text, textGrey(fx), 0.9, true);
			}
			continue;
		}
		const track = scene.snapshot.lanes[lane];
		if (lane < 0 || track === undefined) {
			text(fx, label.cx, label.cy, label.text, textGrey(fx), 0.8);
			continue;
		}
		const state = fx.last[lane] ?? "idle";
		const hue = fx.hues[lane] ?? 0;
		if (label.side === "left") {
			const final = state === "accepted" || state === "excluded";
			const roleAt = track.label !== "" && label.text.endsWith(track.label) ? label.text.length - track.label.length : -1;
			const name = roleAt >= 0 ? label.text.slice(0, roleAt) : label.text;
			const colour = final ? mix(textColour(fx, hue, 0.13), textGrey(fx), fx.dark ? 0.4 : 0.2) : textColour(fx, hue, state === "waiting" || state === "idle" ? 0.07 : 0.14);
			const used = text(fx, label.cx, label.cy, name, colour, final ? 0.9 : 1, !final && state === "running");
			if (roleAt >= 0) text(fx, label.cx + used, label.cy, track.label, mix(colour, textGrey(fx), 0.3), 0.9);
		} else {
			// The layout puts the progress after the state word in one label; it gets its own colour here.
			const style = stateStyle(fx, lane, state);
			const progress = track.progress;
			const count = progress !== undefined && progress.total > 1 ? ` ${progress.met}/${progress.total}` : "";
			const split = count !== "" && label.text.endsWith(count) ? label.text.length - count.length : -1;
			const used = text(fx, label.cx, label.cy, split >= 0 ? label.text.slice(0, split) : label.text, style.colour, style.energy, style.bold);
			if (split >= 0 && progress !== undefined) {
				text(fx, label.cx + used, label.cy, count, progress.met >= progress.total ? greenOf(fx) : textGrey(fx), 0.9);
			}
		}
	}
}
