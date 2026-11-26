/**
 * The lane layout: which lane is on which row, what folds when the lanes do not fit, and that every point, mark and
 * label stays on the canvas and in the order of time.
 */
import { describe, expect, test } from "bun:test";
import { textWidth } from "../src/view/lane/canvas.ts";
import { TRUNK_LABEL, layout } from "../src/view/lane/layout.ts";
import type { LaneSnapshot, LaneSpan, LaneState, LaneTrack } from "../src/view/lane/model.ts";
import type { Scene, Strand } from "../src/view/lane/scene.ts";

const SECOND = 1000;
const TERMINAL: readonly LaneState[] = ["accepted", "blocked", "excluded"];

/** A lane from `[from seconds, state]` pairs; every span runs to the next one and the last is open. */
function lane(name: string, steps: readonly (readonly [number, LaneState])[], extra: Partial<LaneTrack> = {}): LaneTrack {
	const spans: LaneSpan[] = steps.map(([from, state], i) => {
		const next = steps[i + 1];
		return next === undefined ? { from: from * SECOND, state } : { from: from * SECOND, to: next[0] * SECOND, state };
	});
	return { name, label: "구현", dependsOn: [], spans, ...extra };
}

function snapshot(nowSeconds: number, lanes: readonly LaneTrack[], extra: Partial<LaneSnapshot> = {}): LaneSnapshot {
	return {
		now: nowSeconds * SECOND,
		phases: [{ from: 0, phase: "workers" }],
		rounds: [0],
		lanes,
		complete: false,
		...extra,
	};
}

function lastState(l: LaneTrack): LaneState {
	return l.spans[l.spans.length - 1]!.state;
}

/** Recursively freezes, so a layout that writes into its input throws. */
function freeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** A run with `n` lanes in a mix of states, starting a few seconds apart. */
function mixed(n: number, nowSeconds = 600): LaneSnapshot {
	const cycle: LaneState[] = ["running", "accepted", "reserved", "waiting", "quiet", "reviewing", "blocked", "excluded", "submitted", "unmet", "idle"];
	const lanes = Array.from({ length: n }, (_, i): LaneTrack => {
		const state = cycle[i % cycle.length]!;
		const start = (i * 7) % 300;
		const steps: (readonly [number, LaneState])[] = state === "reserved" || state === "waiting" ? [[start, state]] : [[start, "running"], [start + 100 + (i % 50), state]];
		return lane(`lane-${i}`, steps, { dependsOn: i > 0 && i % 5 === 0 ? [`lane-${i - 1}`] : [] });
	});
	return snapshot(nowSeconds, lanes, { rounds: [0, 120 * SECOND] });
}

function wdOf(scene: Scene): number {
	return (scene.graph.cx1 - scene.graph.cx0) * 2;
}

/** Everything that must hold for any scene, whatever the input. */
function expectSound(scene: Scene, cols: number, maxRows: number): void {
	expect(scene.rows).toBeLessThanOrEqual(maxRows);
	expect(scene.cols).toBe(cols);
	expect(scene.graph.cx0).toBeGreaterThan(0);
	expect(scene.graph.cx1).toBeLessThanOrEqual(cols);
	expect(scene.headX).toBeGreaterThanOrEqual(scene.graph.cx0 * 2);
	expect(scene.headX).toBeLessThanOrEqual(scene.graph.cx1 * 2 - 1);

	for (const strand of scene.strands) {
		let before = -Infinity;
		for (const p of strand.points) {
			expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
			expect(p.x).toBeGreaterThanOrEqual(0);
			expect(p.x).toBeLessThanOrEqual(cols * 2 - 1);
			expect(p.y).toBeGreaterThanOrEqual(0);
			expect(p.y).toBeLessThanOrEqual(scene.rows * 4 - 1);
			// A strand never runs backwards in time.
			expect(p.at).toBeGreaterThanOrEqual(before);
			before = p.at;
		}
	}
	for (const mark of scene.marks) {
		expect(mark.cx).toBeGreaterThanOrEqual(0);
		expect(mark.cx).toBeLessThan(cols);
		expect(mark.cy).toBeGreaterThanOrEqual(0);
		expect(mark.cy).toBeLessThan(scene.rows);
	}
	for (const label of scene.labels) {
		expect(label.width).toBe(textWidth(label.text));
		expect(label.cx).toBeGreaterThanOrEqual(0);
		expect(label.cx + label.width).toBeLessThanOrEqual(cols);
		expect(label.cy).toBeGreaterThanOrEqual(0);
		expect(label.cy).toBeLessThan(scene.rows);
		// Labels never run into the graph from either side.
		if (label.side === "left") expect(label.cx + label.width).toBeLessThanOrEqual(scene.graph.cx0);
		if (label.side === "right") expect(label.cx).toBeGreaterThanOrEqual(scene.graph.cx1);
	}
	// A lane has a row of its own, or none; the rows are 1..n without holes.
	const rows = scene.rowOf.filter((r) => r >= 0);
	expect(new Set(rows).size).toBe(rows.length);
	expect([...rows].sort((a, b) => a - b)).toEqual(rows.map((_, i) => i + 1));
}

function strandsOf(scene: Scene, laneIndex: number, kind?: Strand["kind"]): Strand[] {
	return scene.strands.filter((s) => s.lane === laneIndex && (kind === undefined || s.kind === kind));
}

describe("rows", () => {
	test("the trunk comes first, then one row per lane in start order, no summary when everything fits", () => {
		const snap = snapshot(120, [
			lane("late", [[60, "running"]]),
			lane("early", [[2, "running"]]),
			lane("middle", [[30, "running"]]),
		]);
		const scene = layout(snap, 100, 12);
		expect(scene.rows).toBe(4);
		expect(scene.rowOf).toEqual([3, 1, 2]);
		expect(scene.labels.filter((l) => l.lane === -1 && l.cy > 0)).toHaveLength(0);
	});

	test("a lane is drawn only on its own row", () => {
		const scene = layout(mixed(8), 100, 12);
		const seen = new Map<number, number>();
		scene.strands.forEach((strand) => {
			if (strand.kind !== "lane") return;
			const row = scene.rowOf[strand.lane]!;
			expect(row).toBeGreaterThan(0);
			for (const p of strand.points) expect(p.y).toBe(4 * row + 1);
			const owner = seen.get(4 * row + 1);
			expect(owner === undefined || owner === strand.lane).toBe(true);
			seen.set(4 * row + 1, strand.lane);
		});
		// And the lanes that were drawn are all the shown ones.
		expect(new Set(seen.values()).size).toBe(scene.rowOf.filter((r) => r > 0).length);
	});

	test("the label of a lane sits on the lane's row", () => {
		const scene = layout(mixed(6), 100, 12);
		for (const label of scene.labels) {
			if (label.lane < 0) continue;
			expect(label.cy).toBe(scene.rowOf[label.lane]!);
		}
	});

	test("no lanes: the trunk alone", () => {
		const scene = layout(snapshot(5, []), 80, 12);
		expect(scene.rows).toBe(1);
		expectSound(scene, 80, 12);
		expect(scene.strands.some((s) => s.kind === "trunk")).toBe(true);
	});

	test("maxRows of one draws the trunk alone, zero or less draws nothing", () => {
		expect(layout(mixed(5), 80, 1).rows).toBe(1);
		expect(layout(mixed(5), 80, 1).rowOf.every((r) => r === -1)).toBe(true);
		expect(layout(mixed(5), 80, 0).rows).toBe(0);
		expect(layout(mixed(5), 80, -3).rows).toBe(0);
	});

	test("a lane without any span, or first seen already finished, is handled", () => {
		const empty: LaneTrack = { name: "empty", label: "구현", dependsOn: [], spans: [] };
		const finished = lane("done", [[40, "accepted"]]);
		const scene = layout(snapshot(100, [empty, finished, lane("busy", [[10, "running"]])]), 90, 12);
		expectSound(scene, 90, 12);
		expect(scene.rowOf[0]).toBe(-1);
		expect(scene.rowOf[1]).toBeGreaterThan(0);
		// The finished lane still has a line to climb from and a join into the trunk.
		expect(strandsOf(scene, 1, "lane").length).toBeGreaterThan(0);
		expect(strandsOf(scene, 1, "join")).toHaveLength(1);
	});

	test("does not write into its input", () => {
		const snap = freeze(mixed(30));
		expect(() => layout(snap, 100, 12)).not.toThrow();
	});

	test("the same input gives the same scene", () => {
		const snap = mixed(30);
		const a = layout(snap, 100, 11);
		const b = layout(snap, 100, 11);
		expect(b.strands).toEqual(a.strands);
		expect(b.marks).toEqual(a.marks);
		expect(b.labels).toEqual(a.labels);
		expect(b.rowOf).toEqual(a.rowOf);
	});
});

describe("folding", () => {
	function names(scene: Scene): string[] {
		return scene.rowOf.flatMap((row, i) => (row > 0 ? [scene.snapshot.lanes[i]!.name] : []));
	}
	function summaryOf(scene: Scene): { left: string; right: string } | undefined {
		const row = scene.rows - 1;
		const left = scene.labels.find((l) => l.side === "left" && l.lane === -1 && l.cy === row && row > 0);
		const right = scene.labels.find((l) => l.side === "right" && l.lane === -1 && l.cy === row && row > 0);
		return left === undefined || right === undefined ? undefined : { left: left.text, right: right.text };
	}

	test("40 lanes on 11 rows: the working lanes stay, finished ones fold first, then those not started", () => {
		const lanes = [
			...Array.from({ length: 10 }, (_, i) => lane(`done-${i}`, [[i, "running"], [20 + i * 10, "accepted"]])),
			...Array.from({ length: 6 }, (_, i) => lane(`work-${i}`, [[5 + i, i % 3 === 0 ? "running" : i % 3 === 1 ? "quiet" : "reviewing"]])),
			...Array.from({ length: 24 }, (_, i) => lane(`later-${i}`, [[i < 12 ? 0 : 30, i % 2 === 0 ? "reserved" : "waiting"]])),
		];
		const scene = layout(snapshot(400, lanes), 100, 11);
		expectSound(scene, 100, 11);
		// 1 trunk + 9 lanes + 1 summary = exactly the rows asked for.
		expect(scene.rows).toBe(11);
		const shown = names(scene);
		expect(shown).toHaveLength(9);
		for (let i = 0; i < 6; i++) expect(shown).toContain(`work-${i}`);
		expect(shown.some((n) => n.startsWith("done-"))).toBe(false);
		// The three free rows go to lanes that have not started, early in the plan (the latest-planned folds first).
		const rest = shown.filter((n) => n.startsWith("later-"));
		expect(rest).toHaveLength(3);
		for (const n of rest) expect(Number(n.slice("later-".length))).toBeLessThan(12);
		// The summary row names how many are folded: 10 + 21.
		const summary = summaryOf(scene)!;
		expect(summary.left).toContain("31");
		// Folded lanes have no row and no lane strands.
		scene.rowOf.forEach((row, i) => {
			if (row > 0) return;
			expect(strandsOf(scene, i)).toHaveLength(0);
		});
	});

	test("more working lanes than rows: working lanes fill the rows, the others are the summary", () => {
		const lanes = [
			...Array.from({ length: 28 }, (_, i) => lane(`done-${i}`, [[0, "running"], [30 + i, "accepted"]])),
			...Array.from({ length: 12 }, (_, i) => lane(`work-${i}`, [[10 + i, "running"]])),
		];
		const scene = layout(snapshot(300, lanes), 100, 11);
		const shown = names(scene);
		expect(shown).toHaveLength(9);
		expect(shown.every((n) => n.startsWith("work-"))).toBe(true);
		// Of equals, the lanes first in the plan stay.
		expect(shown).toEqual(Array.from({ length: 9 }, (_, i) => `work-${i}`));
		expect(summaryOf(scene)!.left).toContain("31");
	});

	test("a blocked lane stays visible over lanes that are finished or have not started", () => {
		const lanes = [
			...Array.from({ length: 6 }, (_, i) => lane(`done-${i}`, [[0, "running"], [20, "accepted"]])),
			...Array.from({ length: 6 }, (_, i) => lane(`later-${i}`, [[0, "reserved"]])),
			lane("stuck", [[0, "running"], [40, "blocked"]]),
			lane("busy", [[5, "running"]]),
		];
		const scene = layout(snapshot(100, lanes), 100, 5); // trunk + 3 lanes + summary
		expect(names(scene).sort()).toEqual(["busy", "stuck", "later-0"].sort());
	});

	test("among finished lanes the one that finished first folds first", () => {
		const lanes = [
			lane("old", [[0, "running"], [10, "accepted"]]),
			lane("newest", [[1, "running"], [90, "accepted"]]),
			lane("new", [[2, "running"], [50, "accepted"]]),
			lane("working", [[3, "running"]]),
		];
		const scene = layout(snapshot(100, lanes), 100, 4); // trunk + 2 lanes + summary
		expect(names(scene).sort()).toEqual(["newest", "working"].sort());
	});

	test("lanes that exactly fit are not folded; one more folds, and one row goes to the summary", () => {
		const fit = layout(mixed(10), 100, 11);
		expect(fit.rows).toBe(11);
		expect(fit.rowOf.every((r) => r > 0)).toBe(true);
		expect(summaryOf(fit)).toBeUndefined();

		const over = layout(mixed(11), 100, 11);
		expect(over.rows).toBe(11);
		expect(over.rowOf.filter((r) => r > 0)).toHaveLength(9);
		expect(summaryOf(over)!.left).toContain("2");
	});

	test("two rows: the trunk and a summary of everything", () => {
		const scene = layout(mixed(7), 100, 2);
		expect(scene.rows).toBe(2);
		expect(scene.rowOf.every((r) => r === -1)).toBe(true);
		expect(summaryOf(scene)!.left).toContain("7");
	});

	test("a folded lane that was accepted still joins the trunk, at its own time", () => {
		const lanes = [
			lane("done", [[0, "running"], [50, "accepted"]]),
			lane("a", [[1, "running"]]),
			lane("b", [[2, "running"]]),
		];
		const scene = layout(snapshot(100, lanes), 100, 3); // trunk + 1 lane + summary
		expect(scene.rowOf[0]).toBe(-1);
		const accept = scene.marks.find((m) => m.kind === "accept" && m.lane === 0)!;
		expect(accept.cy).toBe(0);
		expect(accept.at).toBe(50 * SECOND);
	});

	test("which lanes stay does not depend on how the lanes are listed in time order, only on state and plan order", () => {
		const a = layout(mixed(40), 100, 11);
		const b = layout(mixed(40), 100, 11);
		expect(a.rowOf).toEqual(b.rowOf);
		const withLater = mixed(40, 900);
		// More time passing changes nothing about who is folded while the states are the same.
		expect(layout(withLater, 100, 11).rowOf.map((r) => r > 0)).toEqual(a.rowOf.map((r) => r > 0));
	});

	test("the summary names the biggest groups and fits its column", () => {
		const scene = layout(mixed(60), 60, 11);
		const summary = summaryOf(scene)!;
		const right = scene.labels.find((l) => l.side === "right" && l.cy === scene.rows - 1)!;
		expect(summary.right.length).toBeGreaterThan(0);
		expect(right.cx + right.width).toBeLessThanOrEqual(60);
	});

	test("256 lanes on 12 rows lay out in well under a frame's budget", () => {
		const snap = mixed(256);
		layout(snap, 120, 12);
		const started = performance.now();
		for (let i = 0; i < 50; i++) layout(snap, 120, 12);
		const each = (performance.now() - started) / 50;
		expect(each).toBeLessThan(5);
		const scene = layout(snap, 120, 12);
		expectSound(scene, 120, 12);
		expect(scene.rows).toBe(12);
	});
});

describe("geometry", () => {
	const sizes: readonly [number, number][] = [[60, 6], [60, 12], [61, 9], [79, 12], [80, 8], [99, 12], [100, 12], [137, 7], [200, 12], [300, 12]];
	const counts = [0, 1, 2, 5, 11, 12, 40, 256];

	test("every point, mark and label is on the canvas, in time order, for every width, height and lane count", () => {
		for (const [cols, maxRows] of sizes) {
			for (const n of counts) {
				for (const nowSeconds of [0, 1, 45, 600, 40_000]) {
					const scene = layout(mixed(n, nowSeconds), cols, maxRows);
					expectSound(scene, cols, maxRows);
				}
			}
		}
	});

	test("open ends line up at now: the trunk and every lane that has not finished end on the head", () => {
		const scene = layout(mixed(9, 700), 100, 12);
		const wd = wdOf(scene);
		const dot = scene.span / (wd - 1) + 1;
		const trunk = scene.strands.find((s) => s.kind === "trunk")!;
		expect(trunk.points[trunk.points.length - 1]!.x).toBe(scene.headX);
		expect(trunk.points[trunk.points.length - 1]!.at).toBeLessThanOrEqual(scene.snapshot.now);

		scene.snapshot.lanes.forEach((l, i) => {
			if (scene.rowOf[i]! < 0) return;
			const open = strandsOf(scene, i, "lane").filter((s) => s.open);
			if (TERMINAL.includes(lastState(l))) {
				expect(open).toHaveLength(0);
				return;
			}
			expect(open).toHaveLength(1);
			const end = open[0]!.points[open[0]!.points.length - 1]!;
			expect(end.x).toBe(scene.headX);
			expect(end.at).toBeLessThanOrEqual(scene.snapshot.now);
			expect(scene.snapshot.now - end.at).toBeLessThanOrEqual(dot);
			expect(scene.marks.filter((m) => m.kind === "head" && m.lane === i)).toHaveLength(1);
			expect(scene.marks.find((m) => m.kind === "head" && m.lane === i)!.cx).toBe(scene.headX >> 1);
		});
	});

	test("an open end stays on the head even when another lane's stem crosses it", () => {
		// `late` starts a moment before now, so its stem drops right beside the head of `long`, which is still running.
		const snap = snapshot(300, [lane("long", [[0, "running"]]), lane("mid", [[150, "running"]]), lane("late", [[299, "running"]])]);
		const scene = layout(snap, 100, 12);
		const stem = strandsOf(scene, 2, "stem")[0]!;
		expect(Math.abs(stem.points[0]!.x - scene.headX)).toBeLessThanOrEqual(1);
		for (const laneIndex of [0, 1]) {
			const open = strandsOf(scene, laneIndex, "lane").filter((s) => s.open);
			expect(open).toHaveLength(1);
			expect(open[0]!.points[open[0]!.points.length - 1]!.x).toBe(scene.headX);
		}
		// A crossing further left leaves a gap on the row: pieces, not one stroke.
		const early = layout(snapshot(300, [lane("long", [[0, "running"]]), lane("late", [[200, "running"]])]), 100, 12);
		expect(strandsOf(early, 0, "lane").length).toBeGreaterThan(1);
	});

	test("a lane that started this very moment still has its line on the head", () => {
		const snap = snapshot(100, [lane("fresh", [[100, "running"]])]);
		const scene = layout(snap, 100, 12);
		const open = strandsOf(scene, 0, "lane").filter((s) => s.open);
		expect(open).toHaveLength(1);
		const pts = open[0]!.points;
		expect(pts[pts.length - 1]!.x).toBe(scene.headX);
		expectSound(scene, 100, 12);
	});

	test("a lane that claims to start after now is treated as starting now", () => {
		const snap = snapshot(10, [lane("ahead", [[50, "running"]])]);
		const scene = layout(snap, 100, 12);
		expectSound(scene, 100, 12);
		expect(strandsOf(scene, 0, "lane").some((s) => s.open)).toBe(true);
	});

	test("an accepted lane joins the trunk: its join ends on the trunk row, and joins do not merge", () => {
		const lanes = Array.from({ length: 6 }, (_, i) => lane(`l${i}`, [[i, "running"], [200 + i, "accepted"]]));
		const scene = layout(snapshot(600, lanes), 100, 12);
		const xs: number[] = [];
		lanes.forEach((_, i) => {
			const join = strandsOf(scene, i, "join");
			expect(join).toHaveLength(1);
			const points = join[0]!.points;
			expect(points[points.length - 1]!.y).toBe(1);
			expect(scene.marks.filter((m) => m.kind === "accept" && m.lane === i)).toHaveLength(1);
			expect(strandsOf(scene, i, "lane").every((s) => !s.open)).toBe(true);
			xs.push(points[points.length - 1]!.x);
		});
		const sorted = [...xs].sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(2);
	});

	test("a dependency on a shown lane draws one link, on a missing or folded lane none, and never crashes", () => {
		const lanes = [
			lane("base", [[0, "running"]]),
			lane("next", [[0, "waiting"], [100, "running"]], { dependsOn: ["base", "ghost", "next"] }),
		];
		const scene = layout(snapshot(200, lanes), 100, 12);
		const links = strandsOf(scene, 1, "link");
		expect(links).toHaveLength(1);
		expect(links[0]!.points.length).toBeGreaterThan(1);
		expectSound(scene, 100, 12);

		const folded = layout(snapshot(200, lanes), 100, 3); // trunk + 1 lane + summary
		expectSound(folded, 100, 3);
	});

	test("a job lane has job nodes along it", () => {
		const scene = layout(snapshot(200, [lane("check", [[0, "running"]], { job: true })]), 100, 12);
		expect(scene.marks.filter((m) => m.kind === "job").length).toBeGreaterThan(2);
	});

	test("the time axis grows in steps and keeps now inside the picture", () => {
		const spans = new Set<number>();
		for (const s of [1, 20, 31, 100, 3_000, 40_000, 90_000, 400_000]) {
			const scene = layout(snapshot(s, [lane("a", [[0, "running"]])]), 100, 12);
			spans.add(scene.span);
			expect(scene.span).toBeGreaterThanOrEqual(s * SECOND * 1.08);
			expect(scene.headX).toBeLessThan(scene.graph.cx1 * 2 - 1);
		}
		expect(spans.size).toBeGreaterThan(4);
	});

	test("a now that is not a number or is negative does not break the layout", () => {
		for (const now of [Number.NaN, -5, Infinity]) {
			const scene = layout({ ...snapshot(0, [lane("a", [[0, "running"]])]), now }, 100, 12);
			expect(scene.rows).toBe(2);
			for (const s of scene.strands) for (const p of s.points) expect(Number.isFinite(p.x + p.y + p.at)).toBe(true);
		}
	});

	test("the phase comes from the last phase span, and its age from where that span began", () => {
		const snap = snapshot(100, [], { phases: [{ from: 0, to: 40 * SECOND, phase: "workers" }, { from: 40 * SECOND, phase: "waiting-user" }] });
		const scene = layout(snap, 100, 12);
		expect(scene.phase).toBe("waiting-user");
		expect(scene.phaseAge).toBe(60 * SECOND);
		expect(layout(snapshot(5, [], { phases: [] }), 100, 12).phase).toBe("working");
	});
});

describe("labels", () => {
	function leftOf(scene: Scene, laneIndex: number) {
		return scene.labels.find((l) => l.side === "left" && l.lane === laneIndex)!;
	}
	function rightOf(scene: Scene, laneIndex: number) {
		return scene.labels.find((l) => l.side === "right" && l.lane === laneIndex)!;
	}

	test("the trunk is labelled with the director's word and no round, count or cost", () => {
		const scene = layout(snapshot(100, [lane("a", [[0, "running"]])], { rounds: [0, 50 * SECOND, 80 * SECOND] }), 100, 12);
		const trunk = scene.labels.find((l) => l.side === "left" && l.lane === -1 && l.cy === 0)!;
		expect(trunk.text).toBe(TRUNK_LABEL);
		expect(trunk.text).not.toMatch(/[0-9R/$]/);
	});

	test("the role word of every lane starts in the same display column, whatever the names are made of", () => {
		const lanes = [
			lane("a", [[0, "running"]], { label: "탐색" }),
			lane("긴 한글 이름의 레인", [[1, "running"]], { label: "구현" }),
			lane("very-long-english-lane-name-indeed", [[2, "running"]], { label: "검토" }),
			lane("혼합 mix", [[3, "running"]], { label: "설계" }),
			lane("x", [[4, "running"]], { label: "빠른" }),
		];
		for (const cols of [60, 80, 100, 160]) {
			const scene = layout(snapshot(100, lanes), cols, 12);
			const columns = new Set<number>();
			lanes.forEach((l, i) => {
				const label = leftOf(scene, i);
				expect(label.split).toBeDefined();
				columns.add(textWidth(label.text.slice(0, label.split)));
				expect(label.text.slice(label.split!)).toContain(l.label);
				expect(label.width).toBeLessThanOrEqual(scene.graph.cx0);
			});
			expect(columns.size).toBe(1);
		}
	});

	test("a lane without a label gets its whole column for the name; with a label the name is cut with an ellipsis", () => {
		const name = "an-exceptionally-long-lane-name";
		const scene = layout(snapshot(100, [lane(name, [[0, "running"]], { label: "" }), lane(name, [[0, "running"]], { label: "구현" })]), 100, 12);
		const bare = leftOf(scene, 0);
		const labelled = leftOf(scene, 1);
		expect(bare.text.trim().length).toBeGreaterThan(labelled.text.indexOf(" ") - 1);
		expect(labelled.text).toContain("…");
		expect(labelled.text).toContain("구현");
	});

	test("an escape sequence in a lane name cannot reach a label", () => {
		const scene = layout(snapshot(100, [lane("bad\x1b[31mname", [[0, "running"]])]), 100, 12);
		const label = leftOf(scene, 0);
		expect(label.width).toBe(textWidth(label.text));
	});

	test("progress shows beside the state word when the lane has more than one result, and only then", () => {
		const lanes = [
			lane("many", [[0, "running"]], { progress: { met: 2, total: 5 } }),
			lane("one", [[1, "running"]], { progress: { met: 0, total: 1 } }),
			lane("none", [[2, "running"]]),
		];
		for (const cols of [60, 80, 100, 200]) {
			const scene = layout(snapshot(100, lanes), cols, 12);
			const many = rightOf(scene, 0);
			expect(many.text).toContain("2/5");
			expect(many.split).toBeDefined();
			expect(many.text.slice(many.split!).trim()).toBe("2/5");
			expect(rightOf(scene, 1).text).not.toContain("/");
			expect(rightOf(scene, 2).text).not.toContain("/");
			expect(many.cx).toBeGreaterThanOrEqual(scene.graph.cx1);
			expect(many.cx + many.width).toBeLessThanOrEqual(cols);
		}
	});

	test("progress with big numbers still fits the column, and the word gives way before the progress does", () => {
		const lane1 = lane("big", [[0, "waiting"]], { progress: { met: 12, total: 40 } });
		const scene = layout(snapshot(100, [lane1]), 60, 12);
		const right = rightOf(scene, 0);
		expect(right.text).toContain("12/40");
		expect(right.cx + right.width).toBeLessThanOrEqual(60);
	});

	test("the state word follows the lane's current state, and each state has one", () => {
		const states: LaneState[] = ["reserved", "waiting", "running", "quiet", "submitted", "reviewing", "accepted", "unmet", "blocked", "excluded", "idle"];
		const lanes = states.map((s, i) => lane(`l${i}`, [[i, s]]));
		const words = new Set<string>();
		const scene = layout(snapshot(100, lanes), 120, 12);
		lanes.forEach((_, i) => {
			const text = rightOf(scene, i).text.trim();
			expect(text.length).toBeGreaterThan(0);
			words.add(text);
		});
		expect(words.size).toBe(states.length);
	});

	test("the phase word on the trunk fits its column at every width", () => {
		for (const phase of ["working", "workers", "waiting-user", "verifying", "between-rounds", "stopping"] as const) {
			for (const cols of [60, 80, 100]) {
				const scene = layout(snapshot(100, [], { phases: [{ from: 0, phase }] }), cols, 12);
				const word = scene.labels.find((l) => l.side === "right" && l.lane === -1 && l.cy === 0)!;
				expect(word.text.length).toBeGreaterThan(0);
				expect(word.cx + word.width).toBeLessThanOrEqual(cols);
			}
		}
	});
});
