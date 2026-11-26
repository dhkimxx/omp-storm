/**
 * The lane frame as the widget sees it: how many rows, how wide, what a still picture does with time, which colour
 * codes it writes, and what it costs.
 */
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { LANE_MIN_COLUMNS, type LaneFrameOptions, laneFrame, laneLiveliness } from "../src/view/lane/frame.ts";
import { liveliness } from "../src/view/lane/effects.ts";
import type { LaneSnapshot, LaneSpan, LaneState, LaneTrack } from "../src/view/lane/model.ts";

const SECOND = 1000;
const SGR = /\x1b\[[0-9;]*m/g;

function lane(name: string, steps: readonly (readonly [number, LaneState])[], extra: Partial<LaneTrack> = {}): LaneTrack {
	const spans: LaneSpan[] = steps.map(([from, state], i) => {
		const next = steps[i + 1];
		return next === undefined ? { from: from * SECOND, state } : { from: from * SECOND, to: next[0] * SECOND, state };
	});
	return { name, label: "구현", dependsOn: [], spans, ...extra };
}

function snapshot(nowSeconds: number, lanes: readonly LaneTrack[], extra: Partial<LaneSnapshot> = {}): LaneSnapshot {
	return { now: nowSeconds * SECOND, phases: [{ from: 0, phase: "workers" }], rounds: [0], lanes, complete: false, ...extra };
}

function mixed(n: number, nowSeconds = 600): LaneSnapshot {
	const cycle: LaneState[] = ["running", "accepted", "reserved", "waiting", "quiet", "reviewing", "blocked", "excluded", "submitted", "unmet", "idle"];
	const lanes = Array.from({ length: n }, (_, i): LaneTrack => {
		const state = cycle[i % cycle.length]!;
		const start = (i * 7) % 300;
		const steps: (readonly [number, LaneState])[] = state === "reserved" || state === "waiting" ? [[start, state]] : [[start, "running"], [start + 100 + (i % 50), state]];
		return lane(`lane-${i}`, steps, { activity: (i % 4) / 3, dependsOn: i > 0 && i % 5 === 0 ? [`lane-${i - 1}`] : [], ...(i % 3 === 0 ? { progress: { met: i % 4, total: 4 } } : {}) });
	});
	return snapshot(nowSeconds, lanes, { rounds: [0, 120 * SECOND] });
}

/** The same picture as a different object, so nothing is served from the last call's memory. */
function copy(snap: LaneSnapshot): LaneSnapshot {
	return structuredClone(snap);
}

function options(extra: Partial<LaneFrameOptions> = {}): LaneFrameOptions {
	return { motion: true, maxRows: 12, colour: "truecolor", dark: true, ...extra };
}

function plain(row: string): string {
	return row.replace(SGR, "");
}

describe("shape", () => {
	test("at most maxRows rows, each exactly as wide as the terminal, for every size, colour, motion and time", () => {
		const times = [0, 17, 4_321, 123_456];
		for (const cols of [60, 61, 80, 99, 100, 121, 200]) {
			for (const maxRows of [1, 2, 3, 6, 9, 12]) {
				for (const n of [0, 1, 4, 11, 40, 256]) {
					const snap = mixed(n, n === 0 ? 5 : 900);
					for (const colour of ["truecolor", "256"] as const) {
						for (const motion of [true, false]) {
							const t = times[(cols + maxRows + n) % times.length]!;
							const rows = laneFrame(copy(snap), cols, t, options({ maxRows, colour, motion, dark: (cols + n) % 2 === 0 }));
							expect(rows.length).toBeGreaterThanOrEqual(1);
							expect(rows.length).toBeLessThanOrEqual(maxRows);
							for (const row of rows) expect(visibleWidth(row)).toBe(cols);
						}
					}
				}
			}
		}
	});

	test("a row is a single line and carries colour codes only", () => {
		const rows = laneFrame(mixed(12), 100, 1000, options());
		for (const row of rows) {
			expect(row).not.toMatch(/[\n\r]/);
			expect(plain(row)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		}
	});

	test("rows are the trunk, the lanes and a summary only when lanes fold", () => {
		expect(laneFrame(mixed(3), 100, 0, options())).toHaveLength(4);
		expect(laneFrame(mixed(10), 100, 0, options({ maxRows: 11 }))).toHaveLength(11);
		expect(laneFrame(mixed(40), 100, 0, options({ maxRows: 11 }))).toHaveLength(11);
		expect(laneFrame(snapshot(5, []), 100, 0, options())).toHaveLength(1);
		expect(laneFrame(mixed(40), 100, 0, options({ maxRows: 1 }))).toHaveLength(1);
	});

	test("nothing to draw below the minimum width or without rows", () => {
		expect(laneFrame(mixed(3), LANE_MIN_COLUMNS - 1, 0, options())).toEqual([]);
		expect(laneFrame(mixed(3), 0, 0, options())).toEqual([]);
		expect(laneFrame(mixed(3), 100, 0, options({ maxRows: 0 }))).toEqual([]);
		expect(laneFrame(mixed(3), LANE_MIN_COLUMNS, 0, options()).length).toBeGreaterThan(0);
	});

	test("the first row is the trunk and the trunk has something drawn on it", () => {
		const [trunk] = laneFrame(mixed(3), 100, 0, options());
		expect(plain(trunk!).trim().length).toBeGreaterThan(0);
	});
});

describe("labels in the picture", () => {
	test("Korean names and role words keep every column in place", () => {
		const lanes = [
			lane("첫번째 레인", [[0, "running"]], { label: "탐색" }),
			lane("implementer-with-a-long-name", [[1, "running"]], { label: "구현" }),
			lane("혼합 mix 이름", [[2, "running"]], { label: "검토" }),
			lane("a", [[3, "quiet"]], { label: "설계" }),
		];
		for (const cols of [60, 80, 100, 160]) {
			const rows = laneFrame(snapshot(200, lanes), cols, 500, options({ colour: "256" }));
			expect(rows).toHaveLength(5);
			for (const row of rows) expect(visibleWidth(row)).toBe(cols);
			const starts = new Set<number>();
			lanes.forEach((l, i) => {
				const text = plain(rows[i + 1]!);
				const at = text.indexOf(l.label);
				expect(at).toBeGreaterThan(0);
				starts.add(visibleWidth(text.slice(0, at)));
			});
			expect(starts.size).toBe(1);
		}
	});

	test("a lane's name and role word are on its own row, in row order", () => {
		const lanes = [lane("first-lane", [[0, "running"]]), lane("second-lane", [[5, "running"]]), lane("third-lane", [[10, "running"]])];
		const rows = laneFrame(snapshot(100, lanes), 120, 0, options({ colour: "256", dark: false })).map(plain);
		expect(rows[1]).toContain("first-lane");
		expect(rows[2]).toContain("second-lane");
		expect(rows[3]).toContain("third-lane");
		expect(rows[0]).not.toContain("lane");
	});

	test("progress is in the row of its lane", () => {
		const lanes = [lane("one", [[0, "running"]], { progress: { met: 1, total: 3 } }), lane("two", [[5, "running"]])];
		const rows = laneFrame(snapshot(100, lanes), 100, 0, options({ colour: "256" })).map(plain);
		expect(rows[1]).toContain("1/3");
		expect(rows[2]).not.toContain("/");
	});
});

describe("colour", () => {
	test("truecolor writes 24-bit codes and no palette codes; 256 the other way round", () => {
		const snap = mixed(8);
		const truecolor = laneFrame(copy(snap), 100, 1000, options({ colour: "truecolor" })).join("");
		const palette = laneFrame(copy(snap), 100, 1000, options({ colour: "256" })).join("");
		expect(truecolor).toMatch(/38;2;\d+;\d+;\d+m/);
		expect(truecolor).not.toContain("38;5;");
		expect(palette).toMatch(/38;5;\d+m/);
		expect(palette).not.toContain("38;2;");
	});

	test("a light terminal is drawn with other colours than a dark one", () => {
		const snap = mixed(8);
		const dark = laneFrame(copy(snap), 100, 1000, options({ dark: true }));
		const light = laneFrame(copy(snap), 100, 1000, options({ dark: false }));
		expect(light.join("")).not.toBe(dark.join(""));
		// Colour is the difference; where things are is not.
		expect(light.map(plain)).toEqual(dark.map(plain));
	});
});

describe("time", () => {
	test("with motion off the picture does not depend on t", () => {
		const snaps = [mixed(9), mixed(40), snapshot(90, [lane("a", [[0, "running"]]), lane("b", [[5, "quiet"]])], { phases: [{ from: 0, phase: "waiting-user" }] })];
		for (const snap of snaps) {
			for (const colour of ["truecolor", "256"] as const) {
				const reference = laneFrame(copy(snap), 100, 0, options({ motion: false, colour }));
				for (const t of [1, 333, 2_300, 99_999, 3_600_000]) {
					expect(laneFrame(copy(snap), 100, t, options({ motion: false, colour }))).toEqual(reference);
				}
			}
		}
	});

	test("with motion on a working picture moves", () => {
		const snap = snapshot(120, [lane("a", [[0, "running"]], { activity: 1 }), lane("b", [[10, "running"]], { activity: 0.6 })]);
		const a = laneFrame(copy(snap), 100, 1000, options());
		const b = laneFrame(copy(snap), 100, 1530, options());
		expect(b.join("\n")).not.toBe(a.join("\n"));
	});

	test("asking again with the very same snapshot gives the same picture, and a changed snapshot a new one", () => {
		const snap = mixed(9);
		const still = options({ motion: false });
		const first = laneFrame(snap, 100, 0, still);
		expect(laneFrame(snap, 100, 7777, still)).toEqual(first);
		expect(laneFrame(snap, 100, 0, options({ motion: false, colour: "256" }))).not.toEqual(first);
		expect(laneFrame(snap, 100, 0, options({ motion: false, dark: false }))).not.toEqual(first);
		expect(laneFrame(snap, 100, 0, options({ motion: false, maxRows: 4 }))).toHaveLength(4);
		expect(laneFrame(snap, 100, 0, still)).toEqual(first);
		expect(laneFrame(snap, 120, 0, still).every((r) => visibleWidth(r) === 120)).toBe(true);
		// A still picture remembered for this snapshot does not answer a call that wants motion.
		const moving = options({ motion: true });
		expect(laneFrame(snap, 120, 1234, moving)).toEqual(laneFrame(copy(snap), 120, 1234, moving));
		expect(laneFrame(snap, 120, 1234, moving)).not.toEqual(laneFrame(snap, 120, 0, still));
		const later = { ...snap, now: snap.now + 90 * SECOND };
		expect(laneFrame(later, 100, 0, still)).not.toEqual(first);
	});

	test("frames of a moving picture differ over time but always keep their shape", () => {
		const snap = mixed(12, 300);
		for (let t = 0; t < 4_000; t += 83) {
			const rows = laneFrame(snap, 90, t, options({ colour: "256" }));
			expect(rows.length).toBeLessThanOrEqual(12);
			for (const row of rows) expect(visibleWidth(row)).toBe(90);
		}
	});
});

describe("liveliness", () => {
	test("is the effects' answer, one of the three words", () => {
		for (const snap of [mixed(0, 5), mixed(9), mixed(40), snapshot(60, [lane("a", [[0, "accepted"]])], { complete: true, phases: [{ from: 0, phase: "stopping" }] }), snapshot(60, [lane("a", [[0, "running"]])], { phases: [{ from: 0, phase: "waiting-user" }] })]) {
			const answer = laneLiveliness(snap);
			expect(["full", "slow", "still"]).toContain(answer);
			expect(answer).toBe(liveliness(snap));
		}
	});
});

describe("cost", () => {
	test("a frame of a busy run (256 lanes, 12 rows, 120 columns) stays well inside the twelve-per-second budget", () => {
		const snap = mixed(256, 7_200);
		const o = options({ maxRows: 12, colour: "truecolor" });
		for (let i = 0; i < 20; i++) laneFrame(snap, 120, i * 83, o);
		const frames = 300;
		const started = performance.now();
		for (let i = 0; i < frames; i++) laneFrame({ ...snap, now: snap.now + i * 83 }, 120, 2_000 + i * 83, o);
		const each = (performance.now() - started) / frames;
		// Measured near 1 ms; the bound is loose enough for a loaded machine and tight enough to catch a regression.
		expect(each).toBeLessThan(8);
	});

	test("a still picture asked for again with the same snapshot costs next to nothing", () => {
		const snap = mixed(40, 900);
		const o = options({ motion: false });
		laneFrame(snap, 120, 0, o);
		const started = performance.now();
		for (let i = 0; i < 2_000; i++) laneFrame(snap, 120, i, o);
		expect((performance.now() - started) / 2_000).toBeLessThan(0.1);
	});
});
