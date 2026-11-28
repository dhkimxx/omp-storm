/**
 * The animal stage: the species table (`docs/stage.md` "종 고르기"), the sequencer's transition, accent and cut-in
 * rules, the scene's cap and pieces, and the lane view that puts the stage beside the graph. Every input is a lane
 * snapshot, as the widget hands it over.
 */
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { RunPhase } from "../src/view/appearance.ts";
import { laneFrame, laneViewFrame, laneViewLiveliness, stageColumns } from "../src/view/lane/frame.ts";
import { layout } from "../src/view/lane/layout.ts";
import type { LaneIntent, LaneMilestone, LanePiece, LaneSnapshot, LaneSpan, LaneState, LaneTrack } from "../src/view/lane/model.ts";
import { sequenceId } from "../src/view/stage/assets.ts";
import { FAKE_ART } from "./stage-fake-art.ts";
import { CAST_PHRASE, castAt, castLine, GATHER_MS, SPECIES_NAME, type Species } from "../src/view/stage/cast.ts";
import { stageScene } from "../src/view/stage/scene.ts";
import { ACTS, BIG_GAP_MS, CROSSFADE_MS, HANDOFF_MS, stageAt, stagePlan } from "../src/view/stage/sequencer.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (rows: readonly string[]): string[] => rows.map(row => row.replace(ANSI, ""));

interface LaneSpec {
	name?: string;
	intent?: LaneIntent;
	unscoped?: true;
	agent?: string;
	pieces?: LanePiece[];
	/** `[from, state]` steps; the last stays open. */
	steps: readonly (readonly [number, LaneState])[];
}

function spans(steps: LaneSpec["steps"]): LaneSpan[] {
	return steps.map(([from, state], i) => {
		const next = steps[i + 1];
		return next === undefined ? { from, state } : { from, to: next[0], state };
	});
}

function snap(
	lanes: readonly LaneSpec[],
	over: { now?: number; phases?: readonly (readonly [number, RunPhase])[]; milestones?: LaneMilestone[]; complete?: boolean; rounds?: number[]; budgetWarnAt?: number } = {},
): LaneSnapshot {
	const now = over.now ?? 60_000;
	const phases = (over.phases ?? [[0, "workers"]]).map(([from, phase], i, all) => {
		const next = all[i + 1];
		return next === undefined ? { from, phase } : { from, to: next[0], phase };
	});
	const tracks: LaneTrack[] = lanes.map((spec, i) => ({
		name: spec.name ?? `lane${i}`,
		label: "구현",
		dependsOn: [],
		spans: spans(spec.steps),
		slot: i,
		...(spec.intent === undefined ? {} : { intent: spec.intent }),
		...(spec.unscoped === undefined ? {} : { unscoped: spec.unscoped }),
		...(spec.agent === undefined ? {} : { agent: spec.agent }),
		...(spec.pieces === undefined ? {} : { pieces: spec.pieces }),
	}));
	return {
		now,
		phases,
		rounds: over.rounds ?? [0],
		lanes: tracks,
		complete: over.complete ?? false,
		milestones: over.milestones ?? [],
		...(over.budgetWarnAt === undefined ? {} : { budgetWarnAt: over.budgetWarnAt }),
	};
}

const lane = (intent: LaneIntent, state: LaneState, extra: Partial<LaneSpec> = {}): LaneSpec => ({ intent, steps: [[0, state]], ...extra });

describe("choosing the species", () => {
	// One row per line of the plan's table, plus the edges each row's wording implies. The first match wins.
	const rows: Array<[string, LaneSnapshot, Species | undefined, string]> = [
		["busy readers only", snap([lane("read", "running"), lane("read", "quiet")]), "bee", CAST_PHRASE.survey],
		["a reader and a writer", snap([lane("read", "running"), lane("write", "running")]), "octopus", CAST_PHRASE.split],
		["two isolated writers", snap([lane("write", "running"), lane("write", "running")]), "octopus", CAST_PHRASE.split],
		["a lone writer with nobody waiting", snap([lane("write", "running"), lane("read", "accepted")]), "octopus", CAST_PHRASE.split],
		["a job runs", snap([lane("job", "running"), lane("read", "running")]), "ant", CAST_PHRASE.serial],
		["one unscoped writer, another write lane waits", snap([lane("write", "running", { unscoped: true }), lane("write", "reserved")]), "ant", CAST_PHRASE.serial],
		// A scoped writer is not ordered against the waiting one: that is two writers' work, not a queue.
		["one scoped writer, another write lane waits", snap([lane("write", "running"), lane("write", "waiting")]), "octopus", CAST_PHRASE.split],
		// A waiting reader is no G1 turn.
		["one unscoped writer, a reader waits", snap([lane("write", "running", { unscoped: true }), lane("read", "reserved")]), "octopus", CAST_PHRASE.split],
		["a submission under review", snap([lane("write", "reviewing"), lane("read", "running")]), "orca", CAST_PHRASE.review],
		["a review lane's worker runs", snap([lane("review", "running"), lane("job", "running")]), "orca", CAST_PHRASE.review],
		["nobody busy", snap([lane("write", "submitted"), lane("read", "idle"), lane("write", "accepted")]), "owl", CAST_PHRASE.solo],
		["no lanes at all", snap([]), "owl", CAST_PHRASE.solo],
		["the start's gathering", snap([lane("read", "running")], { now: 1_000, milestones: [{ at: 0, kind: "start" }] }), "starling", CAST_PHRASE.gather],
		["a replan's gathering", snap([lane("read", "running")], { now: 20_500, milestones: [{ at: 0, kind: "start" }, { at: 20_000, kind: "replan" }] }), "starling", CAST_PHRASE.gather],
		["after the gathering", snap([lane("read", "running")], { now: GATHER_MS, milestones: [{ at: 0, kind: "start" }] }), "bee", CAST_PHRASE.survey],
	];
	for (const [name, snapshot, species, phrase] of rows) {
		test(name, () => {
			const cast = castAt(snapshot, snapshot.now);
			expect(cast.species).toBe(species!);
			expect(cast.phrase).toBe(phrase);
			expect(cast.pose).toBe(species === "starling" ? "gather" : "work");
		});
	}

	test("waiting for the user and stopping keep the species on stage; the gathering does not outrank them", () => {
		const waiting = snap([lane("read", "running")], { now: 1_000, phases: [[0, "waiting-user"]], milestones: [{ at: 0, kind: "start" }] });
		expect(castAt(waiting, 1_000, "orca")).toEqual({ rule: "waiting-user", species: "orca", pose: "waiting-user", phrase: CAST_PHRASE["waiting-user"] });
		// Without a held species it keeps what the workers show.
		expect(castAt(waiting, 1_000).species).toBe("bee");
		const done = snap([lane("write", "accepted")], { phases: [[0, "stopping"]], complete: true });
		expect(castAt(done, done.now, "octopus")).toMatchObject({ species: "octopus", pose: "finale", phrase: CAST_PHRASE.stopping });
		const left = snap([lane("write", "unmet")], { phases: [[0, "stopping"]] });
		expect(castAt(left, left.now, "ant").pose).toBe("lights-out");
	});

	test("a still picture never freezes on the gathering: with motion off the stage shows who works", () => {
		const gathering = snap([lane("read", "running")], { now: 1_000, milestones: [{ at: 0, kind: "start" }] });
		expect(stageAt(gathering, 1_000, true).cast.species).toBe("starling");
		const still = stageAt(gathering, 1_000, false);
		expect(still.cast).toMatchObject({ species: "bee", pose: "work", phrase: CAST_PHRASE.survey });
		expect(still.species).toBe("bee");
	});

	test("the intent decides, never the label: a lane labelled 탐색 that writes is a writer", () => {
		const snapshot = snap([lane("write", "running", { name: "탐색" }), lane("write", "running")]);
		snapshot.lanes.forEach(track => Object.assign(track, { label: "탐색" }));
		expect(castAt(snapshot, snapshot.now).species).toBe("octopus");
	});

	test("the one-line phrase names the species", () => {
		expect(castLine({ species: "octopus", phrase: CAST_PHRASE.split })).toBe("문어 · 일을 나눠 맡기는 중");
		for (const phrase of Object.values(CAST_PHRASE)) expect([...phrase].length).toBeLessThanOrEqual(15);
		expect(Object.keys(SPECIES_NAME).sort()).toEqual(["ant", "bee", "octopus", "orca", "owl", "starling"]);
	});
});

describe("the sequencer", () => {
	test("a species that stood more than three seconds hands over; a shorter one crossfades", () => {
		// Bee for 5 s, octopus for 1 s, then ant.
		const snapshot = snap([
			{ intent: "read", steps: [[0, "running"]] },
			{ intent: "write", steps: [[0, "reserved"], [5_000, "running"], [6_000, "submitted"]] },
			{ intent: "job", steps: [[0, "reserved"], [6_000, "running"]] },
		], { now: 10_000 });
		const { transitions } = stagePlan(snapshot);
		expect(transitions.map(item => [item.from, item.to, item.kind, item.at])).toEqual([
			["bee", "octopus", "handoff", 5_000],
			// The octopus stood only one second (counted from the end of the handoff into it): a crossfade, queued after it.
			["octopus", "ant", "crossfade", 6_200],
		]);
		expect(transitions[0]!.ms).toBe(HANDOFF_MS);
		expect(transitions[1]!.ms).toBe(CROSSFADE_MS);
		// While the handoff plays the stage shows it; once it is over the new species stands.
		expect(stageAt(snapshot, 5_600).transition).toMatchObject({ from: "bee", to: "octopus", kind: "handoff" });
		expect(stageAt(snapshot, 6_100)).toMatchObject({ species: "octopus" });
		// The record says ant from 6 s; the phrase follows the record even while the picture catches up.
		expect(stageAt(snapshot, 6_100).cast.species).toBe("ant");
		expect(stageAt(snapshot, 7_000).species).toBe("ant");
		expect(stageAt(snapshot, 7_000).transition).toBeUndefined();
	});

	test("same-kind events within half a second play as one act, and a big accent waits for the 1.5 s budget", () => {
		const snapshot = snap([
			{ intent: "write", steps: [[0, "running"], [10_000, "accepted"]] },
			{ intent: "write", steps: [[0, "running"], [10_300, "accepted"]] },
			{ intent: "write", steps: [[0, "running"], [11_000, "accepted"]] },
			{ intent: "read", steps: [[0, "running"]] },
			// A writer that keeps running, so the species (and no transition) stays while the acceptances arrive.
			{ intent: "write", steps: [[0, "running"]] },
		], { now: 20_000 });
		const accepts = stagePlan(snapshot).acts.filter(act => act.kind === "accept");
		expect(accepts.map(act => [act.at, act.lanes])).toEqual([[10_000, [0, 1]], [10_000 + BIG_GAP_MS, [2]]]);
		// The merged act grows as its events arrive: at 10.1 s only the first lane has been accepted.
		const early = stageAt(snapshot, 10_100).acts.find(item => item.act.kind === "accept")!;
		expect(early.lanes).toEqual([0]);
	});

	test("among accents waiting for the budget, the higher priority plays first", () => {
		const snapshot = snap([
			{ intent: "write", steps: [[0, "running"], [10_000, "accepted"]] },
			{ intent: "write", steps: [[0, "running"], [10_600, "accepted"]] },
			{ intent: "write", steps: [[0, "running"], [10_700, "blocked"]] },
			{ intent: "read", steps: [[0, "running"]] },
			{ intent: "write", steps: [[0, "running"]] },
		], { now: 20_000 });
		const big = stagePlan(snapshot).acts.filter(act => ACTS[act.kind].big).map(act => [act.kind, act.at, act.lanes]);
		expect(big).toEqual([["accept", 10_000, [0]], ["blocked", 11_500, [2]], ["accept", 13_000, [1]]]);
	});

	test("an act that arrives during a transition plays after it; waiting for the user cuts in, stops what plays and drops what waited", () => {
		const lanes: LaneSpec[] = [
			{ intent: "read", steps: [[0, "running"], [9_000, "submitted"]] },
			{ intent: "write", steps: [[0, "reserved"], [9_000, "running"], [9_200, "submitted"]] },
		];
		const plan = stagePlan(snap(lanes, { now: 20_000 }));
		// Bee -> octopus at 9 s, a full handoff until 10.2 s; octopus -> owl queued behind it, a crossfade to 10.45 s.
		expect(plan.transitions.map(item => [item.to, item.at, item.kind])).toEqual([["octopus", 9_000, "handoff"], ["owl", 10_200, "crossfade"]]);
		// Both submissions (0.2 s apart: one act) and lane 1's start wait for the transitions.
		expect(plan.acts.filter(act => act.kind === "submit").map(act => [act.at, act.lanes])).toEqual([[10_450, [0, 1]]]);
		expect(plan.acts.filter(act => act.kind === "start").map(act => [act.at, act.lanes])).toEqual([[0, [0]], [10_450, [1]]]);

		// The same record with a wait for the user at 9.4 s: what waited behind the transitions never plays.
		const waited = stagePlan(snap(lanes, { now: 20_000, phases: [[0, "workers"], [9_400, "waiting-user"]] }));
		expect(waited.acts.map(act => [act.kind, act.at])).toEqual([["start", 0], ["waiting", 9_400]]);

		// A blocked lane's lightning that plays when the wait begins stops there.
		const cut = stagePlan(snap([
			lane("read", "running"),
			lane("write", "running"),
			{ intent: "write", steps: [[0, "running"], [9_000, "blocked"]] },
		], { now: 20_000, phases: [[0, "workers"], [9_200, "waiting-user"]] }));
		expect(cut.acts.find(act => act.kind === "blocked")).toMatchObject({ at: 9_000, ms: 200 });
	});

	test("a lane first seen already accepted plays no acceptance; a refusal plays from its first stretch", () => {
		const snapshot = snap([
			{ intent: "write", steps: [[0, "accepted"]] },
			{ intent: "write", steps: [[4_000, "refused"]] },
		]);
		const kinds = stagePlan(snapshot).acts.map(act => act.kind);
		expect(kinds).not.toContain("accept");
		expect(kinds).toContain("blocked");
	});

	test("the finale plays only for a complete run, lights out otherwise; the round and the budget line have their acts", () => {
		const done = snap([{ intent: "write", steps: [[0, "running"], [5_000, "accepted"]] }], { phases: [[0, "workers"], [8_000, "stopping"]], complete: true, rounds: [0, 3_000], budgetWarnAt: 4_000 });
		expect(stagePlan(done).acts.map(act => act.kind)).toEqual(["start", "round", "budget", "accept", "finale"]);
		const left = { ...done, complete: false };
		expect(stagePlan(left).acts.map(act => act.kind)).toContain("lights-out");
		expect(stagePlan(left).acts.map(act => act.kind)).not.toContain("finale");
		expect(stageAt(done, 6_000).dim).toBe(true);
		expect(stageAt(done, 3_000).dim).toBe(false);
	});

	test("deterministic: the same snapshot and time give the same moment, whatever came before", () => {
		const make = (): LaneSnapshot => snap([
			{ intent: "read", steps: [[0, "running"], [9_000, "submitted"], [12_000, "reviewing"]] },
			{ intent: "write", steps: [[0, "reserved"], [9_000, "running"], [14_000, "accepted"]] },
		], { now: 15_000, milestones: [{ at: 0, kind: "start" }] });
		const a = stageAt(make(), 14_200);
		stageAt(snap([lane("job", "running")]), 100);
		const b = stageAt(make(), 14_200);
		expect(b).toEqual(a);
		// Motion off: one still moment with the cast and no act or transition.
		expect(stageAt(make(), 9_100, false)).toEqual({ cast: castAt(make(), 9_100), species: castAt(make(), 9_100).species, acts: [], dim: false });
	});
});

describe("the scene", () => {
	const crowd = (count: number): LaneSnapshot =>
		snap(Array.from({ length: count }, (_, i) => lane(i % 2 === 0 ? "read" : "write", i < 3 ? "running" : "reserved")));

	test("at most 6, 7 or 8 individuals by stage width; the rest gather as a swarm with its count", () => {
		for (const [cols, cap] of [[28, 6], [36, 7], [44, 8]] as const) {
			const snapshot = crowd(11);
			const scene = stageScene({ snapshot, moment: stageAt(snapshot, snapshot.now, false), cols, rows: 4, t: 0, motion: false });
			expect(scene.species).toBe("octopus");
			expect(scene.individuals.filter(item => item.lane >= 0)).toHaveLength(cap);
			expect(scene.individuals.filter(item => item.lane < 0)).toHaveLength(1);
			expect(scene.swarm?.count).toBe(11 - cap);
			// The busy lanes always stand on stage.
			for (const busy of [0, 1, 2]) expect(scene.individuals.some(item => item.lane === busy)).toBe(true);
		}
	});

	test("the owl stands alone; every result id is one piece, accepted ones ring the director", () => {
		const pieces: LanePiece[] = [{ id: "a1", state: "accepted" }, { id: "a2", state: "pending" }];
		const snapshot = snap([lane("write", "idle", { pieces }), lane("read", "submitted", { pieces: [{ id: "b1", state: "reviewable" }] })]);
		const scene = stageScene({ snapshot, moment: stageAt(snapshot, snapshot.now, false), cols: 36, rows: 4, t: 0, motion: false });
		expect(scene.species).toBe("owl");
		expect(scene.individuals.map(item => item.lane)).toEqual([-1]);
		expect(scene.pieces.map(piece => piece.id)).toEqual(["a1", "a2", "b1"]);
		const director = scene.individuals[0]!;
		const ring = scene.pieces.find(piece => piece.id === "a1")!;
		expect(Math.hypot(ring.x - director.x, ring.y - director.y)).toBeLessThan(12);
	});

	test("a blocked lane is frozen with its edge; waiting for the user puts the director's amber on and stops the loops", () => {
		const snapshot = snap([lane("write", "running"), lane("read", "running"), { intent: "write", steps: [[0, "running"], [50_000, "blocked"]] }], { phases: [[0, "workers"], [55_000, "waiting-user"]] });
		const scene = (t: number) => stageScene({ snapshot, moment: stageAt(snapshot), cols: 36, rows: 4, t, motion: true });
		const first = scene(0);
		expect(first.individuals.find(item => item.lane === 2)).toMatchObject({ blocked: true });
		expect(first.individuals.find(item => item.lane < 0)).toMatchObject({ amber: true, seq: sequenceId("octopus", "director", "waiting-user") });
		expect(scene(4_321)).toEqual(first);
	});

	test("every sequence the scene asks for exists in the test's fake art, in both tiers", () => {
		const snapshot = snap([lane("write", "running"), lane("read", "submitted"), lane("job", "running"), lane("write", "blocked"), lane("write", "excluded")], { milestones: [] });
		for (const species of ["octopus", "bee", "ant", "orca", "owl", "starling"] as const) {
			const moment = { ...stageAt(snapshot, snapshot.now, false), species };
			for (const item of stageScene({ snapshot, moment, cols: 40, rows: 4, t: 0, motion: false, assets: FAKE_ART }).individuals) {
				expect(FAKE_ART.meta(item.seq)).toBeDefined();
				const t1 = FAKE_ART.frame(item.seq, item.t, "t1")!;
				expect(t1.tier).toBe("t1");
				expect(t1.rgba.length).toBe(t1.w * t1.h * 4);
				expect(t1.rgba.some((value, i) => i % 4 === 3 && value > 0)).toBe(true);
				const t2 = FAKE_ART.frame(item.seq, item.t, "t2")!;
				expect(t2.tier).toBe("t2");
				expect(t2.rgba.length).toBe(t2.w * t2.h * 4);
			}
		}
		expect(FAKE_ART.meta("octopus/worker/nope" as never)).toBeUndefined();
	});
});

describe("the lane view with its stage", () => {
	const options = { motion: true, maxRows: 11, colour: "truecolor" as const, dark: true };
	const snapshot = snap([
		lane("read", "running", { name: "탐색", agent: "Scout1" }),
		lane("write", "running", { name: "구현", agent: "Impl1" }),
	]);

	test("the stage takes 30% of the width, 28 to 48 columns, and only when the graph keeps its 60", () => {
		expect([88, 89, 100, 120, 160, 200].map(stageColumns)).toEqual([0, 28, 30, 36, 48, 48]);
	});

	test("every row is exactly the width; the stage keeps five rows; its last row says the species and what it does", () => {
		for (const cols of [89, 100, 120, 200]) {
			const rows = laneViewFrame(snapshot, cols, 1_000, options);
			expect(rows).toHaveLength(5);
			for (const row of rows) expect(visibleWidth(row)).toBe(cols);
			expect(plain(rows)[4]!.startsWith("문어 · 일을 나눠 맡기는 중")).toBe(true);
			expect(plain(rows).every(row => row.trim() !== "")).toBe(true);
		}
		// Too narrow for a stage, or too short: the graph alone, exactly as before.
		expect(laneViewFrame(snapshot, 88, 1_000, options)).toEqual(laneFrame(snapshot, 88, 1_000, options));
		expect(laneViewFrame(snapshot, 120, 1_000, { ...options, maxRows: 4 })).toEqual(laneFrame(snapshot, 120, 1_000, { ...options, maxRows: 4 }));
	});

	test("motion off: one still frame, independent of time", () => {
		const still = { ...options, motion: false };
		const first = laneViewFrame(snapshot, 120, 0, still);
		expect(laneViewFrame(snapshot, 120, 98_765, still)).toEqual(first);
	});

	test("the view keeps its full pace while the stage plays, even in a phase that has settled", () => {
		const settled = snap([{ intent: "write", steps: [[0, "running"], [30_000, "idle"]] }], { now: 31_000, phases: [[0, "workers"], [20_000, "between-rounds"]] });
		// The lane graph has settled (its events ended long ago); the stage still hands the octopus over to the owl.
		expect(stageAt(settled).transition).toBeDefined();
		expect(laneViewLiveliness(settled, 120, 11)).toBe("full");
		expect(laneViewLiveliness({ ...settled, now: 40_000 }, 120, 11)).toBe("still");
	});

	test("a lane row keeps its full name and its role word beside the stage; the hub's long worker name never takes the row (I1)", () => {
		const scene = layout(snap([lane("write", "running", { name: "api-verify", agent: "run-20261128-103231-0gu9wyjamkxs3-lane-1" })]), 84, 6);
		const left = scene.labels.filter(label => label.side === "left" && label.lane >= 0).map(label => label.text);
		expect(left[0]).toContain("api-verify");
		expect(left[0]).toContain("구현");
		expect(left[0]).not.toContain("run-");
	});
});
