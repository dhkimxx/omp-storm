/**
 * The lane view's effects, through the product renderer: edges that must not throw, pictures that must not move when
 * they are meant to be still, and `liveliness` agreeing with what the picture really does.
 */
import { describe, expect, test } from "bun:test";
import type { RunPhase } from "../src/view/appearance.ts";
import { Canvas, textWidth } from "../src/view/lane/canvas.ts";
import { lookOf } from "../src/view/lane/colour.ts";
import { liveliness, paint } from "../src/view/lane/effects.ts";
import { type LaneFrameOptions, laneFrame } from "../src/view/lane/frame.ts";
import { layout } from "../src/view/lane/layout.ts";
import type { LaneSnapshot, LaneSpan, LaneState, LaneTrack, PhaseSpan } from "../src/view/lane/model.ts";
import type { Scene } from "../src/view/lane/scene.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const OPTIONS: LaneFrameOptions = { motion: true, maxRows: 10, colour: "truecolor", dark: true };

/** A lane whose spans are given as [from, state] steps; the last stays open. */
function lane(name: string, steps: ReadonlyArray<readonly [number, LaneState]>, extra: Partial<LaneTrack> = {}): LaneTrack {
	const spans: LaneSpan[] = steps.map(([from, state], i) => {
		const to = steps[i + 1]?.[0];
		return to === undefined ? { from, state } : { from, to, state };
	});
	return { name, label: "구현", dependsOn: [], spans, ...extra };
}

function phases(steps: ReadonlyArray<readonly [number, RunPhase]>): PhaseSpan[] {
	return steps.map(([from, phase], i) => {
		const to = steps[i + 1]?.[0];
		return to === undefined ? { from, phase } : { from, to, phase };
	});
}

function snapshot(now: number, phaseSteps: ReadonlyArray<readonly [number, RunPhase]>, lanes: readonly LaneTrack[], complete = false): LaneSnapshot {
	return { now, phases: phases(phaseSteps), rounds: [0], lanes, complete };
}

/** A new object every call: the renderer keeps what it computed for a snapshot it has seen. */
const fresh = (s: LaneSnapshot): LaneSnapshot => structuredClone(s);
const frame = (s: LaneSnapshot, t: number, options: Partial<LaneFrameOptions> = {}, cols = 120): readonly string[] =>
	laneFrame(fresh(s), cols, t, { ...OPTIONS, ...options });
const plain = (line: string): string => line.replace(ANSI, "");

/** One entry per terminal cell: its colour, weight and glyph, so two frames can be compared cell by cell. */
function cells(line: string): string[] {
	const out: string[] = [];
	let colour = "";
	let bold = false;
	for (const match of line.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/gu)) {
		if (match[1] !== undefined) {
			if (match[1] === "0") { colour = ""; bold = false; }
			else if (match[1] === "1") bold = true;
			else if (match[1] === "22") bold = false;
			else colour = match[1];
		} else {
			const width = textWidth(match[2]!);
			// A blank shows no colour, whatever the state of the escape codes before it.
			if (width > 0) out.push(match[2] === " " ? " " : `${colour}|${bold}|${match[2]!}`);
			for (let i = 1; i < width; i++) out.push("");
		}
	}
	return out;
}

const WORKING = [[0, "working"]] as const;

/** Hue in degrees of a colour, or undefined when it is nearly grey. */
function hueOf(r: number, g: number, b: number): number | undefined {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max - min < 70) return undefined;
	const d = max - min;
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}

/** A busy mid-run picture: lanes in most states, so every continuous effect is on screen. */
function busy(now: number, phaseSteps: ReadonlyArray<readonly [number, RunPhase]> = WORKING): LaneSnapshot {
	return snapshot(now, phaseSteps, [
		lane("a", [[1000, "reserved"], [2000, "running"]], { activity: 0.9 }),
		lane("b", [[1000, "reserved"], [2000, "running"], [9000, "quiet"]], { activity: 0.05 }),
		lane("c", [[1000, "waiting"], [6000, "running"]], { activity: 0.5, progress: { met: 1, total: 3 } }),
		lane("d", [[1000, "reserved"], [2000, "running"], [8000, "submitted"], [10000, "reviewing"]], { job: true }),
		lane("e", [[1000, "reserved"], [2000, "running"], [8000, "accepted"]]),
		lane("f", [[1000, "reserved"], [2000, "running"], [7000, "unmet"], [9000, "running"]], { activity: 0.6 }),
		lane("g", [[1000, "reserved"], [2000, "running"], [7000, "blocked"]]),
		lane("h", [[1000, "reserved"], [2000, "running"], [6000, "idle"], [9500, "excluded"]]),
	]);
}

describe("effects on edges", () => {
	const hour = 3_600_000;
	const cases: Array<[string, LaneSnapshot]> = [
		["no lanes", snapshot(5000, WORKING, [])],
		["no lanes and no phase", { now: 0, phases: [], rounds: [0], lanes: [], complete: false }],
		["one lane", snapshot(5000, WORKING, [lane("only", [[1000, "running"]])])],
		["a lane that has just appeared", snapshot(1000, WORKING, [lane("new", [[1000, "reserved"]])])],
		["a lane with no spans yet", snapshot(5000, WORKING, [{ name: "none", label: "구현", dependsOn: [], spans: [] }])],
		["a run two days long", snapshot(48 * hour, [[0, "working"], [hour, "workers"]], [
			lane("long", [[0, "running"], [24 * hour, "submitted"], [30 * hour, "reviewing"]], { activity: 1 }),
			lane("done", [[0, "running"], [47 * hour, "accepted"]]),
		])],
		["every state at once", busy(12000)],
		["more lanes than rows", snapshot(30000, WORKING, Array.from({ length: 40 }, (_, i) => lane(`lane-${i}`, [[i * 100, "running"]], { activity: (i % 10) / 10 })))],
		["a long lane name", snapshot(5000, WORKING, [lane("x".repeat(200), [[100, "running"]])])],
		["a finale", snapshot(20000, [[0, "working"], [15000, "stopping"]], [lane("a", [[0, "running"], [14000, "accepted"]])], true)],
		["a lights-out", snapshot(20000, [[0, "working"], [15000, "stopping"]], [lane("a", [[0, "running"], [14000, "blocked"]])], false)],
	];
	const variants: Array<Partial<LaneFrameOptions>> = [
		{}, { motion: false }, { dark: false }, { colour: "256" }, { maxRows: 1 }, { maxRows: 2 }, { maxRows: 12, motion: false, dark: false },
	];

	for (const [name, snap] of cases) {
		test(`${name}: every frame is as wide as asked and no taller than asked`, () => {
			for (const options of variants) {
				for (const cols of [60, 61, 120]) {
					for (const t of [0, 1234, 1e12]) {
						const lines = frame(snap, t, options, cols);
						expect(lines.length).toBeGreaterThan(0);
						expect(lines.length).toBeLessThanOrEqual(options.maxRows ?? OPTIONS.maxRows);
						for (const line of lines) expect(textWidth(plain(line))).toBe(cols);
					}
				}
			}
		});
	}

	test("the painter copes with a scene that has no lanes, strands, marks or labels", () => {
		const empty: Scene = {
			snapshot: snapshot(1000, WORKING, []), cols: 60, rows: 1, phase: "working", phaseAge: 1000, span: 30000,
			graph: { cx0: 10, cx1: 50 }, headX: 40, rowOf: [], strands: [], marks: [], labels: [],
		};
		for (const phase of ["working", "workers", "verifying", "waiting-user", "between-rounds", "stopping"] as const) {
			for (const motion of [true, false]) {
				const canvas = new Canvas(60, 1, lookOf(true));
				expect(() => paint({ ...empty, phase }, canvas, 500, motion)).not.toThrow();
			}
		}
	});
});

describe("a still picture", () => {
	const snaps: Array<[string, LaneSnapshot]> = [
		["a busy run", busy(12000)],
		["verifying", busy(12000, [[0, "working"], [8000, "verifying"]])],
		["waiting for the user", busy(30000, [[0, "working"], [8000, "waiting-user"]])],
		["a finale", snapshot(30000, [[0, "working"], [8000, "stopping"]], [lane("a", [[0, "running"], [7000, "accepted"]])], true)],
		["a lights-out", busy(30000, [[0, "working"], [8000, "stopping"]])],
	];
	for (const [name, snap] of snaps) {
		test(`with motion off, ${name} does not depend on t`, () => {
			const first = frame(snap, 0, { motion: false });
			for (const t of [1, 333, 98765, 1e9]) expect(frame(snap, t, { motion: false })).toEqual(first);
		});
	}

	test("with motion off an event that is happening looks like one long past", () => {
		const snap = snapshot(5100, WORKING, [lane("a", [[0, "running"], [5000, "accepted"]]), lane("b", [[0, "running"], [5050, "blocked"]]), lane("c", [[0, "running"], [4000, "unmet"], [4800, "running"]])]);
		const scene = layout(snap, 120, 10);
		const draw = (now: number): readonly string[] => {
			const canvas = new Canvas(120, scene.rows, lookOf(true));
			paint({ ...scene, snapshot: { ...snap, now } }, canvas, 0, false);
			return canvas.rows("truecolor");
		};
		expect(draw(5100)).toEqual(draw(500_000));
	});
});

describe("a frozen picture (waiting for the user)", () => {
	const waiting = busy(40000, [[0, "working"], [8000, "waiting-user"]]);

	test("only the amber block and its glow move", () => {
		// The accumulators that keep flows smooth are history; one frame first, then two that must agree.
		frame(waiting, 5000);
		const a = frame(waiting, 6000);
		const b = frame(waiting, 6700);
		expect(a.length).toBe(b.length);
		const block = plain(a[0]!).indexOf("█");
		expect(block).toBeGreaterThan(0);
		const blockCell = textWidth(plain(a[0]!).slice(0, block));
		let changed = 0;
		a.forEach((line, row) => {
			const x = cells(line);
			const y = cells(b[row]!);
			expect(y.length).toBe(x.length);
			x.forEach((cell, col) => {
				if (cell === y[col]) return;
				changed++;
				expect(row).toBe(0);
				expect(col).toBeGreaterThanOrEqual(blockCell - 3);
				expect(col).toBeLessThanOrEqual(blockCell);
			});
		});
		expect(changed).toBeGreaterThan(0);
	});

	test("while the wait is young the last events still play, and later the picture stops", () => {
		const young = busy(8500, [[0, "working"], [8000, "waiting-user"]]);
		expect(liveliness(young)).toBe("full");
		expect(liveliness(waiting)).toBe("slow");
	});
});

describe("liveliness", () => {
	const lanes = [lane("a", [[0, "running"]], { activity: 0.5 })];
	const at = (phase: RunPhase, age: number, complete = false): LaneSnapshot => snapshot(10000 + age, [[0, "working"], [10000, phase]], lanes, complete);

	test("the phases that work are always full", () => {
		for (const phase of ["working", "workers", "verifying"] as const) {
			for (const age of [0, 1000, 60_000, 3_600_000]) expect(liveliness(at(phase, age))).toBe("full");
		}
	});

	test("waiting for the user settles into slow, between rounds into still", () => {
		expect(liveliness(at("waiting-user", 0))).toBe("full");
		expect(liveliness(at("waiting-user", 60_000))).toBe("slow");
		expect(liveliness(at("between-rounds", 0))).toBe("full");
		expect(liveliness(at("between-rounds", 60_000))).toBe("still");
	});

	test("a run that has ended drops to still, after a finale and after lights out, and stays there", () => {
		for (const complete of [true, false]) {
			let settled = -1;
			for (let age = 0; age <= 20_000; age += 100) {
				const level = liveliness(at("stopping", age, complete));
				expect(level).not.toBe("slow");
				if (level === "still" && settled < 0) settled = age;
				if (settled >= 0) expect(level).toBe("still");
			}
			expect(settled).toBeGreaterThan(0);
			expect(settled).toBeLessThanOrEqual(5000);
		}
	});

	test("an empty run is working", () => {
		expect(liveliness({ now: 0, phases: [], rounds: [0], lanes: [], complete: false })).toBe("full");
	});

	test("still means still: the picture does not change with t, whatever the lanes were doing", () => {
		const states: Array<[string, LaneSnapshot]> = [
			["between rounds", busy(40000, [[0, "working"], [8000, "between-rounds"]])],
			["a finale", snapshot(40000, [[0, "working"], [8000, "stopping"]], [lane("a", [[0, "running"], [7000, "accepted"]]), lane("b", [[0, "running"], [7500, "accepted"]])], true)],
			["a lights-out", busy(40000, [[0, "working"], [8000, "stopping"]])],
		];
		for (const [name, snap] of states) {
			expect(liveliness(snap), name).toBe("still");
			frame(snap, 100);
			const first = frame(snap, 1000);
			for (const t of [1010, 1500, 8765]) expect(frame(snap, t), name).toEqual(first);
		}
	});

	test("a picture that moves is said to move: full frames differ from one tick to the next", () => {
		const snap = busy(12000, [[0, "working"], [8000, "workers"]]);
		expect(liveliness(snap)).toBe("full");
		expect(frame(snap, 2000)).not.toEqual(frame(snap, 2085));
	});
});

describe("the end of a run", () => {
	const lanesDone = [lane("a", [[0, "running"], [7000, "accepted"]]), lane("b", [[0, "running"], [7200, "accepted"]]), lane("c", [[0, "running"], [7400, "accepted"]])];
	const ended = (complete: boolean, lanes: readonly LaneTrack[]): LaneSnapshot => snapshot(40000, [[0, "working"], [8000, "stopping"]], lanes, complete);

	test("a complete run settles into a rainbow, not into the pale aurora of its lanes", () => {
		const trunk = frame(ended(true, lanesDone), 5000)[0]!;
		const hues = new Set<number>();
		for (const match of trunk.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)) {
			const hue = hueOf(Number(match[1]), Number(match[2]), Number(match[3]));
			if (hue !== undefined) hues.add(Math.floor(hue / 45));
		}
		expect(hues.size).toBeGreaterThanOrEqual(6);
	});

	test("an incomplete run goes dark instead", () => {
		const done = frame(ended(true, lanesDone), 5000);
		const dark = frame(ended(false, lanesDone), 5000);
		expect(dark).not.toEqual(done);
		const brightness = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + [...line.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].reduce((s, m) => s + Number(m[1]) + Number(m[2]) + Number(m[3]), 0), 0);
		expect(brightness(dark)).toBeLessThan(brightness(done));
	});
});

describe("lane labels", () => {
	test("progress shows beside the state word only when the lane has several results", () => {
		const many = snapshot(10000, WORKING, [lane("a", [[0, "running"]], { progress: { met: 2, total: 5 } })]);
		const one = snapshot(10000, WORKING, [lane("a", [[0, "running"]], { progress: { met: 0, total: 1 } })]);
		const rows = (s: LaneSnapshot): string => frame(s, 0, {}, 120).map(plain).join("\n");
		expect(rows(many)).toContain("2/5");
		expect(rows(one)).not.toContain("0/1");
	});
});
