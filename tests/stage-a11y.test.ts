/**
 * B4 accessibility: the stage reads without motion and without colour.
 *
 * - Motion off: one still frame per moment, independent of time, and the still frame of every species and of every
 *   state (work, waiting for the user, finale, lights out, a blocked lane, an accepted lane) differs from the others
 *   by a visible number of pixels, so species and state read from that one frame.
 * - Colour removed: the same comparisons on luminance alone (T1 and T2 pixels as grey), and on the braille tier with
 *   every colour code stripped (dots and words only). Waiting, stopping and the species also differ by phrase.
 * - The one-line phrase exists for every species and every row of the table, within 15 characters.
 *
 * Runs on the test-only fake art and, when `assets/stage/index.json` exists, again on the baked art (an unbaked
 * sequence draws nothing). `STAGE_A11Y_REPORT=1` prints the difference matrices.
 */
import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { RunPhase } from "../src/view/appearance.ts";
import { grey } from "../src/view/lane/colour.ts";
import type { LaneIntent, LaneMilestone, LaneSnapshot, LaneState, LaneTrack } from "../src/view/lane/model.ts";
import { laneFrame } from "../src/view/lane/frame.ts";
import type { StageAssets } from "../src/view/stage/assets.ts";
import { FAKE_ART } from "./stage-fake-art.ts";
import { BakedAssets, STAGE_ASSETS_DIR } from "../src/view/stage/baked.ts";
import { CAST_PHRASE, castLine, SPECIES_NAME, type Species } from "../src/view/stage/cast.ts";
import { stageFrame } from "../src/view/stage/render-braille.ts";
import { stagePicture } from "../src/view/stage/render-pixels.ts";
import { stageAt } from "../src/view/stage/sequencer.ts";

const NOW = 60_000;
const COLS = 40;
const ROWS = 7;
const ANSI = /\x1b\[[0-9;]*m/g;

/** `then`: the lane changes to this state at the moment the phase changes (the last acceptance and the stop seen together). */
interface LaneSpec { intent: LaneIntent; state: LaneState; unscoped?: true; job?: true; then?: LaneState }
const PHASE_AT = 50_000;

function snapshot(lanes: readonly LaneSpec[], over: { phase?: RunPhase; complete?: boolean; milestones?: LaneMilestone[] } = {}): LaneSnapshot {
	const tracks: LaneTrack[] = lanes.map((spec, i) => ({
		name: `lane${i}`,
		label: "구현",
		dependsOn: [],
		spans: spec.then === undefined
			? [{ from: 0, to: 1_000, state: "reserved" }, { from: 1_000, state: spec.state }]
			: [{ from: 0, to: 1_000, state: "reserved" }, { from: 1_000, to: PHASE_AT, state: spec.state }, { from: PHASE_AT, state: spec.then }],
		slot: i,
		intent: spec.intent,
		...(spec.unscoped === undefined ? {} : { unscoped: spec.unscoped }),
		...(spec.job === undefined ? {} : { job: spec.job }),
		pieces: [{ id: `r${i}`, state: (spec.then ?? spec.state) === "accepted" ? "accepted" : spec.state === "submitted" ? "reviewable" : "pending" }],
	}));
	const phase = over.phase ?? "workers";
	return {
		now: NOW,
		phases: phase === "workers" ? [{ from: 0, phase }] : [{ from: 0, to: PHASE_AT, phase: "workers" }, { from: PHASE_AT, phase }],
		rounds: [0],
		lanes: tracks,
		complete: over.complete ?? false,
		milestones: over.milestones ?? [{ at: 0, kind: "start" }],
	};
}

/** One working cast per species; the starlings gather from a replan a second ago. */
const SPECIES_CASTS: Readonly<Record<Species, LaneSpec[]>> = {
	octopus: [{ intent: "read", state: "running" }, { intent: "write", state: "running" }, { intent: "write", state: "running" }],
	bee: [{ intent: "read", state: "running" }, { intent: "read", state: "running" }, { intent: "read", state: "running" }],
	ant: [{ intent: "job", state: "running", job: true }, { intent: "write", state: "running", unscoped: true }, { intent: "write", state: "reserved" }],
	orca: [{ intent: "review", state: "running" }, { intent: "write", state: "reviewing" }, { intent: "write", state: "reviewing" }],
	owl: [{ intent: "write", state: "idle" }, { intent: "read", state: "idle" }, { intent: "write", state: "submitted" }],
	starling: [{ intent: "read", state: "running" }, { intent: "write", state: "running" }, { intent: "write", state: "running" }],
};
const SPECIES = Object.keys(SPECIES_CASTS) as Species[];
/** The species a still picture can show: the starlings gather for a moment and never stand in a still frame. */
const STILL_SPECIES = SPECIES.filter(species => species !== "starling");

function speciesSnapshot(species: Species): LaneSnapshot {
	const milestones: LaneMilestone[] = species === "starling" ? [{ at: 0, kind: "start" }, { at: NOW - 1_000, kind: "replan" }] : [{ at: 0, kind: "start" }];
	return snapshot(SPECIES_CASTS[species], { milestones });
}

type StateName = "work" | "waiting-user" | "finale" | "lights-out" | "blocked" | "accepted";
const STATES: readonly StateName[] = ["work", "waiting-user", "finale", "lights-out", "blocked", "accepted"];

/** A working species (not the owl or the starlings, which have no lane individuals) in one state. */
function stateSnapshot(species: Species, state: StateName): LaneSnapshot {
	const cast = SPECIES_CASTS[species];
	switch (state) {
		case "work":
			return snapshot(cast);
		case "waiting-user":
			return snapshot(cast, { phase: "waiting-user" });
		case "finale":
			return snapshot(cast.map(lane => ({ ...lane, then: "accepted" as const })), { phase: "stopping", complete: true });
		case "lights-out":
			return snapshot(cast, { phase: "stopping" });
		case "blocked":
			return snapshot([cast[0]!, ...cast.slice(1).map(lane => ({ ...lane, state: "blocked" as const }))]);
		case "accepted":
			// The first lane keeps working (it decides the species); the others are accepted.
			return snapshot([cast[0]!, ...cast.slice(1).map(lane => ({ ...lane, state: "accepted" as const }))]);
	}
}

type Tier = "t1" | "t2";

/** The still picture as luminance (0..255 per pixel): what is left without colour. */
function luminance(snap: LaneSnapshot, tier: Tier, assets: StageAssets, t = 0): Uint8Array {
	const picture = stagePicture(snap, COLS, ROWS, t, { motion: false, dark: true }, tier, assets);
	const out = new Uint8Array(picture.w * picture.h);
	for (let i = 0; i < out.length; i++) out[i] = grey((picture.rgb[i * 3]! << 16) | (picture.rgb[i * 3 + 1]! << 8) | picture.rgb[i * 3 + 2]!) & 0xff;
	return out;
}

/** Pixels whose luminance differs by more than a just-visible step. */
function differing(a: Uint8Array, b: Uint8Array): number {
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 24) n++;
	return n;
}

/** The braille tier with its colour codes removed: dots and words only. */
function glyphs(snap: LaneSnapshot, assets: StageAssets): string[] {
	// A fresh object per call: the braille renderer keeps its last still frame by snapshot identity.
	return stageFrame({ ...snap }, COLS, ROWS + 1, 0, { motion: false, colour: "256", dark: true }, assets).map(row => row.replace(ANSI, ""));
}

/** Cells that differ between two glyph pictures, the phrase row excluded. */
function differingCells(a: readonly string[], b: readonly string[]): number {
	let n = 0;
	for (let row = 0; row < a.length - 1; row++) {
		const x = [...a[row]!];
		const y = [...b[row]!];
		for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) n++;
	}
	return n;
}

/** The least difference a pair must show, per tier: T1 a few percent of one lane's sprite, T2 and braille a few cells. */
const MIN_DIFF = { t1: 120, t2: 6, braille: 6 } as const;

const ASSET_SETS: Array<[string, StageAssets]> = [["fake art", FAKE_ART]];
if (existsSync(new URL("index.json", STAGE_ASSETS_DIR))) ASSET_SETS.push(["baked art", new BakedAssets()]);

const report = process.env.STAGE_A11Y_REPORT === "1";

for (const [artName, assets] of ASSET_SETS) {
	describe(`motion off and colour removed (${artName})`, () => {
		test("the still frame does not depend on time", () => {
			for (const species of SPECIES) {
				const snap = speciesSnapshot(species);
				expect(differing(luminance(snap, "t1", assets, 0), luminance(snap, "t1", assets, 4_321)), species).toBe(0);
			}
		});

		test("every species still is its own picture, in luminance and in bare braille", () => {
			const failures: string[] = [];
			const rows: Record<string, Record<string, string>> = {};
			const pictures = new Map(STILL_SPECIES.map(species => [species, {
				t1: luminance(speciesSnapshot(species), "t1", assets),
				t2: luminance(speciesSnapshot(species), "t2", assets),
				braille: glyphs(speciesSnapshot(species), assets),
			}]));
			for (const a of STILL_SPECIES) {
				rows[a] = {};
				for (const b of STILL_SPECIES) {
					if (a === b) continue;
					const pa = pictures.get(a)!;
					const pb = pictures.get(b)!;
					const d = { t1: differing(pa.t1, pb.t1), t2: differing(pa.t2, pb.t2), braille: differingCells(pa.braille, pb.braille) };
					rows[a]![b] = `${d.t1}/${d.t2}/${d.braille}`;
					for (const tier of ["t1", "t2", "braille"] as const) if (d[tier] < MIN_DIFF[tier]) failures.push(`${a} vs ${b} ${tier}: ${d[tier]}`);
				}
			}
			if (report) {
				console.log(`species, ${artName}: differing T1 px / T2 px / braille cells`);
				console.table(rows);
			}
			expect(failures).toEqual([]);
		});

		test("a still frame taken while the starlings gather shows who works, so it stays true after they are gone", () => {
			const gathering = speciesSnapshot("starling");
			expect(differing(luminance(gathering, "t1", assets), luminance(speciesSnapshot("octopus"), "t1", assets))).toBe(0);
		});

		test("every state of every working species reads from one still: by shape in T1 luminance, by shape or words in the text tiers", () => {
			const failures: string[] = [];
			const weak: string[] = [];
			for (const species of ["octopus", "bee", "ant", "orca"] as const) {
				const pictures = new Map(STATES.map(state => {
					const snap = stateSnapshot(species, state);
					const braille = glyphs(snap, assets);
					return [state, {
						t1: luminance(snap, "t1", assets),
						t2: luminance(snap, "t2", assets),
						braille,
						phrase: braille[braille.length - 1]!.trim(),
						// The lane graph beside the stage keeps each lane's state word (principle 4: facts are text).
						graph: laneFrame({ ...snap }, 90, 0, { motion: false, maxRows: 8, colour: "256", dark: true }).map(row => row.replace(ANSI, "")).join("\n"),
					}] as const;
				}));
				const rows: Record<string, Record<string, string>> = {};
				for (const a of STATES) {
					rows[a] = {};
					for (const b of STATES) {
						if (a === b) continue;
						const pa = pictures.get(a)!;
						const pb = pictures.get(b)!;
						const d = { t1: differing(pa.t1, pb.t1), t2: differing(pa.t2, pb.t2), braille: differingCells(pa.braille, pb.braille) };
						const words = pa.phrase !== pb.phrase ? "phrase" : pa.graph !== pb.graph ? "graph" : "-";
						rows[a]![b] = `${d.t1}/${d.t2}/${d.braille} ${words}`;
						if (d.t1 < MIN_DIFF.t1) failures.push(`${species} ${a} vs ${b} t1: ${d.t1}`);
						for (const tier of ["t2", "braille"] as const) {
							if (d[tier] >= MIN_DIFF[tier]) continue;
							if (words === "-") failures.push(`${species} ${a} vs ${b} ${tier}: ${d[tier]}, same words`);
							else if (a < b) weak.push(`${species} ${a}/${b} ${tier} ${d[tier]} (${words})`);
						}
					}
				}
				if (report) {
					console.log(`${species} states, ${artName}: differing T1 px / T2 px / braille cells, and the words that differ`);
					console.table(rows);
				}
			}
			if (report) console.log(`pairs the stage alone barely separates in a text tier (${artName}):\n  ${weak.join("\n  ")}`);
			expect(failures).toEqual([]);
		});

		test("waiting, stopping and each species also say so in words", () => {
			for (const species of ["octopus", "bee", "ant", "orca"] as const) {
				const line = (state: StateName): string => castLine(stageAt(stateSnapshot(species, state), NOW, false).cast);
				expect(line("work")).toContain(SPECIES_NAME[species]);
				expect(line("waiting-user")).toBe(`${SPECIES_NAME[species]} · ${CAST_PHRASE["waiting-user"]}`);
				expect(line("finale")).toBe(`${SPECIES_NAME[species]} · ${CAST_PHRASE.stopping}`);
				expect(line("lights-out")).toBe(`${SPECIES_NAME[species]} · ${CAST_PHRASE.stopping}`);
				// The phrase row of the bare braille still carries the same words.
				const rows = glyphs(stateSnapshot(species, "waiting-user"), assets);
				expect(rows[rows.length - 1]!.trim()).toBe(line("waiting-user"));
			}
		});
	});
}

describe("the one-line phrase", () => {
	test("every species and every row of the table has its phrase, within 15 characters", () => {
		for (const species of SPECIES) {
			// The gathering is a moment the moving stage plays; a still one shows who works instead.
			const cast = stageAt(speciesSnapshot(species), NOW, species === "starling").cast;
			expect(cast.species).toBe(species);
			expect(castLine(cast)).toBe(`${SPECIES_NAME[species]} · ${cast.phrase}`);
		}
		for (const phrase of Object.values(CAST_PHRASE)) {
			expect(phrase.length).toBeGreaterThan(0);
			expect([...phrase].length).toBeLessThanOrEqual(15);
		}
	});
});
