/**
 * What the lane timeline adds for the stage and for I1: each lane's intent (from the plan's kind, job and results, or an
 * unplanned worker's role, never from the display word), whether a writer is unscoped, the hub name of its worker, its
 * result pieces, the team's milestones, the budget's warning moment, and the user's direct turns and stops (I2, I4).
 */
import { expect, test } from "bun:test";
import { LaneTimeline } from "../src/view/lane/timeline.ts";
import { stageScene } from "../src/view/stage/scene.ts";
import { stageAt, stagePlan } from "../src/view/stage/sequencer.ts";
import type { LaneSnapshot, LaneTrack } from "../src/view/lane/model.ts";
import type { AgentEntry, PlanLane, RunRecord, RunResult, SpawnRecord } from "../src/types.ts";
import { agentEntry, runRecord, spawnRecord } from "./fixtures.ts";

const START = Date.parse("2026-11-20T09:00:00.000Z");
const iso = (offset: number): string => new Date(START + offset).toISOString();

function worker(id: string, lane: string | undefined, over: Partial<AgentEntry> = {}, spawn: Partial<SpawnRecord> = {}): { agent: AgentEntry; spawn: SpawnRecord } {
	return {
		agent: agentEntry({ id, state: "running", startedAt: START, lastActivityAt: START, ...over }),
		spawn: spawnRecord({ spawnKey: id, ...(lane === undefined ? {} : { lane }), ts: iso(0), ...spawn }),
	};
}

function run(lanes: PlanLane[], over: { workers?: { agent: AgentEntry; spawn: SpawnRecord }[]; results?: RunResult[]; submittedAt?: string } & Partial<RunRecord> = {}): RunRecord {
	const { workers = [], results = [], submittedAt = iso(0), ...rest } = over;
	return runRecord({
		status: "running",
		startedAt: iso(0),
		plan: { lanes, workers: {}, submittedAt },
		results,
		agents: workers.map(item => item.agent),
		spawns: workers.map(item => item.spawn),
		...rest,
	});
}

function track(snapshot: LaneSnapshot, name: string): LaneTrack {
	const found = snapshot.lanes.find(item => item.name === name);
	if (found === undefined) throw new Error(`no lane ${name}`);
	return found;
}

test("a lane's intent comes from its kind, job and declared results, not from the word shown next to it", () => {
	const timeline = new LaneTimeline();
	const lanes: PlanLane[] = [
		{ name: "read", kind: "explore", role: "explorer" },
		{ name: "design", kind: "design", role: "architect" },
		{ name: "write", kind: "code", role: "implementer" },
		{ name: "scoped", kind: "code", role: "implementer", files: ["src/a.ts"] },
		{ name: "isolated", kind: "code", role: "implementer", isolationReason: "실험" },
		{ name: "review", kind: "review", role: "reviewer" },
		{ name: "job", kind: "run", role: "quick", job: "lint" },
		// An explore lane that promises a change writes: the policy's own read-intent rule.
		{ name: "explore-change", kind: "explore", role: "explorer", results: [{ id: "c", kind: "change", criterion: "c", path: "a.ts" }] },
		// The role says explorer, the kind says code: the kind wins.
		{ name: "odd-role", kind: "code", role: "explorer" },
	];
	timeline.observe(run(lanes), "workers", START);
	const snapshot = timeline.snapshot(START + 1_000);
	const intents = Object.fromEntries(snapshot.lanes.map(item => [item.name, item.intent]));
	expect(intents).toEqual({
		read: "read", design: "read", write: "write", scoped: "write", isolated: "write", review: "review", job: "job",
		"explore-change": "write", "odd-role": "write",
	});
	const unscoped = snapshot.lanes.filter(item => item.unscoped === true).map(item => item.name);
	expect(unscoped).toEqual(["write", "explore-change", "odd-role"]);
});

test("a lane row names the worker the hub shows: the running one, else the latest; an unplanned row its own worker", () => {
	const timeline = new LaneTimeline();
	const lanes: PlanLane[] = [{ name: "api", kind: "code", role: "implementer" }, { name: "docs", kind: "code", role: "implementer" }];
	const workers = [
		worker("ApiOld", "api", { state: "idle", startedAt: START }),
		worker("ApiNew", "api", { state: "running", startedAt: START - 5_000 }),
		worker("DocsA", "docs", { state: "idle", startedAt: START }),
		worker("DocsB", "docs", { state: "idle", startedAt: START + 1 }),
		worker("Scout", undefined, { role: "explorer", name: "scout" }),
		worker("Judge", undefined, { role: "reviewer", name: "storm-reviewer" }),
		worker("Fixer", undefined),
	];
	timeline.observe(run(lanes, { workers }), "workers", START + 2_000);
	const snapshot = timeline.snapshot(START + 2_000);
	expect(track(snapshot, "api").agent).toBe("ApiNew");
	expect(track(snapshot, "docs").agent).toBe("DocsB");
	expect(track(snapshot, "Scout")).toMatchObject({ agent: "Scout", intent: "read" });
	expect(track(snapshot, "Judge")).toMatchObject({ agent: "Judge", intent: "review" });
	expect(track(snapshot, "Fixer")).toMatchObject({ agent: "Fixer", intent: "write", unscoped: true });
	// A lane nobody has worked on yet has no worker to talk to.
	timeline.observe(run([...lanes, { name: "later", kind: "code", role: "implementer" }], { workers }), "workers", START + 3_000);
	expect(track(timeline.snapshot(START + 3_000), "later").agent).toBeUndefined();
});

test("every required result is one piece with its ledger state, and a change of state rebuilds the lane", () => {
	const timeline = new LaneTimeline();
	const lanes: PlanLane[] = [{
		name: "api",
		kind: "code",
		role: "implementer",
		results: [{ id: "r1", kind: "change", criterion: "r1", path: "a.ts" }, { id: "r2", kind: "change", criterion: "r2", path: "b.ts" }],
	}];
	timeline.observe(run(lanes, { results: [{ id: "r1", lane: "api", state: "pending" }, { id: "r2", lane: "api", state: "pending" }] }), "workers", START);
	expect(track(timeline.snapshot(START), "api").pieces).toEqual([{ id: "r1", state: "pending" }, { id: "r2", state: "pending" }]);
	timeline.observe(run(lanes, { results: [{ id: "r1", lane: "api", state: "accepted" }, { id: "r2", lane: "api", state: "reviewable" }] }), "workers", START + 1_000);
	expect(track(timeline.snapshot(START + 1_000), "api").pieces).toEqual([{ id: "r1", state: "accepted" }, { id: "r2", state: "reviewable" }]);
});

test("milestones: the start (or resume) at 0, a replan when a new plan changes the lane set, and nothing for a resubmitted same plan", () => {
	const a: PlanLane = { name: "a", kind: "code", role: "implementer" };
	const b: PlanLane = { name: "b", kind: "explore", role: "explorer" };
	const timeline = new LaneTimeline();
	timeline.observe(run([a]), "workers", START);
	expect(timeline.snapshot(START).milestones).toEqual([{ at: 0, kind: "start" }]);
	// The same lanes resubmitted later: not a new team.
	timeline.observe(run([a], { submittedAt: iso(5_000) }), "workers", START + 5_000);
	expect(timeline.snapshot(START + 5_000).milestones).toEqual([{ at: 0, kind: "start" }]);
	// A new lane set from a new plan: the team gathers again.
	timeline.observe(run([a, b], { submittedAt: iso(9_000) }), "workers", START + 9_000);
	expect(timeline.snapshot(START + 9_000).milestones).toEqual([{ at: 0, kind: "start" }, { at: 9_000, kind: "replan" }]);

	const resumed = new LaneTimeline();
	resumed.observe(run([a], { resumeOf: "run-0" }), "workers", START);
	expect(resumed.snapshot(START).milestones).toEqual([{ at: 0, kind: "resume" }]);

	// A run that starts without a plan gathers when its first plan lands, as its start.
	const late = new LaneTimeline();
	late.observe(runRecord({ status: "running", startedAt: iso(0), spawns: [] }), "working", START);
	late.observe(run([a], { submittedAt: iso(4_000) }), "workers", START + 4_000);
	expect(late.snapshot(START + 4_000).milestones).toEqual([{ at: 0, kind: "start" }, { at: 4_000, kind: "start" }]);
});

test("the budget's warning moment is the first observation at or past the approved warning line, and it stays", () => {
	const timeline = new LaneTimeline();
	const lanes: PlanLane[] = [{ name: "a", kind: "code", role: "implementer" }];
	const budget = { perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" as const };
	timeline.observe(run(lanes, { budget, costUsd: 1 }), "workers", START);
	expect(timeline.snapshot(START).budgetWarnAt).toBeUndefined();
	timeline.observe(run(lanes, { budget, costUsd: 4.2 }), "workers", START + 7_000);
	expect(timeline.snapshot(START + 7_000).budgetWarnAt).toBe(7_000);
	timeline.observe(run(lanes, { budget, costUsd: 4.5 }), "workers", START + 9_000);
	expect(timeline.snapshot(START + 9_000).budgetWarnAt).toBe(7_000);
});

test("a turn or stop the user gives a lane's worker while the view watches is one act; counts already there, or seen again, are none", () => {
	const lanes: PlanLane[] = [{ name: "api", kind: "code", role: "implementer" }];
	const counted = (userTurns: number, userStops: number) => run(lanes, { workers: [worker("Api", "api", { userTurns, userStops, lastActivityAt: START + 100_000 })] });
	const timeline = new LaneTimeline();
	// First seen with two turns and a stop already given: nothing to play.
	timeline.observe(counted(2, 1), "workers", START);
	const first = timeline.snapshot(START);
	expect(track(first, "api").steeredAt).toBeUndefined();
	expect(stagePlan(first).acts.filter(act => act.kind === "user-steer" || act.kind === "user-stop")).toEqual([]);
	// The same counts again: still nothing.
	timeline.observe(counted(2, 1), "workers", START + 3_000);
	expect(track(timeline.snapshot(START + 3_000), "api").steeredAt).toBeUndefined();
	// One more turn: one act, at the moment it was seen, on that lane.
	timeline.observe(counted(3, 1), "workers", START + 5_000);
	const steered = timeline.snapshot(START + 5_000);
	expect(track(steered, "api").steeredAt).toEqual([5_000]);
	const steers = stagePlan(steered).acts.filter(act => act.kind === "user-steer");
	expect(steers.map(act => [act.at, act.lanes])).toEqual([[5_000, [0]]]);
	// Seen again unchanged: no second act.
	timeline.observe(counted(3, 1), "workers", START + 8_000);
	const later = timeline.snapshot(START + 8_000);
	expect(stagePlan(later).acts.filter(act => act.kind === "user-steer")).toHaveLength(1);
	// A stop: its own act, and the worker plays it on stage while it lasts.
	timeline.observe(counted(3, 2), "workers", START + 10_000);
	const stopped = timeline.snapshot(START + 10_200);
	expect(stagePlan(stopped).acts.filter(act => act.kind === "user-stop").map(act => act.at)).toEqual([10_000]);
	const scene = stageScene({ snapshot: stopped, moment: stageAt(stopped), cols: 36, rows: 4, t: 0, motion: true });
	expect(scene.individuals.find(item => item.lane === 0)?.seq).toMatch(/\/worker\/user-stop$/);
});

test("a verdict plays once when it is given; a worker settling on an old verdict, or a verdict there before the view, plays none", () => {
	const lanes: PlanLane[] = [{ name: "api", kind: "code", role: "implementer", results: [{ id: "r", kind: "change", criterion: "r", path: "a.ts" }] }];
	const at = (state: AgentEntry["state"], result: RunResult) =>
		run(lanes, { workers: [worker("Api", "api", { state, lastActivityAt: START + 100_000 })], results: [result] });
	const unmet = (attemptId: string): RunResult => ({ id: "r", lane: "api", state: "unmet", attemptId });
	const timeline = new LaneTimeline();
	// First seen idle with an unmet verdict: no act for it.
	timeline.observe(at("idle", unmet("a1")), "workers", START);
	// A follow-up runs and settles; the row is still the old verdict.
	timeline.observe(at("running", unmet("a1")), "workers", START + 5_000);
	timeline.observe(at("idle", unmet("a1")), "workers", START + 8_000);
	const settled = timeline.snapshot(START + 8_000);
	expect(track(settled, "api").spans.at(-1)?.state).toBe("unmet");
	const kinds = (snap: LaneSnapshot, kind: string) => stagePlan(snap).acts.filter(act => act.kind === kind).map(act => act.at);
	expect(kinds(settled, "unmet")).toEqual([]);
	// Nor a start: the lane ran before the view looked.
	expect(kinds(settled, "start")).toEqual([]);
	// A new attempt judged unmet again: one act, when it was seen.
	timeline.observe(at("idle", unmet("a2")), "workers", START + 12_000);
	expect(kinds(timeline.snapshot(START + 12_000), "unmet")).toEqual([12_000]);
	// Delivered and accepted: a submit, then an accept.
	timeline.observe(at("idle", { id: "r", lane: "api", state: "reviewable", attemptId: "a3" }), "workers", START + 15_000);
	timeline.observe(at("idle", { id: "r", lane: "api", state: "accepted", attemptId: "a3" }), "workers", START + 20_000);
	const done = timeline.snapshot(START + 20_000);
	expect(kinds(done, "submit")).toEqual([15_000]);
	expect(kinds(done, "accept")).toEqual([20_000]);
});

test("a budget line already crossed when the view first looks dims the stage from the start and plays no act", () => {
	const timeline = new LaneTimeline();
	const lanes: PlanLane[] = [{ name: "a", kind: "code", role: "implementer" }];
	timeline.observe(run(lanes, { budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" }, costUsd: 4.5 }), "workers", START + 31_400);
	const snap = timeline.snapshot(START + 31_400);
	expect(snap.budgetWarnAt).toBe(0);
	expect(stageAt(snap).dim).toBe(true);
	expect(stageAt(snap).acts.map(item => item.act.kind)).not.toContain("budget");
});

test("the director's own edit is view-only evidence: present while the controller says so, gone after", () => {
	const timeline = new LaneTimeline();
	const lanes: PlanLane[] = [{ name: "a", kind: "code", role: "implementer" }];
	timeline.observe(run(lanes), "working", START);
	expect(timeline.snapshot(START).directorEditing).toBeUndefined();
	// Past the start's gathering, with no worker busy: the owl's stage.
	timeline.observe(run(lanes), "working", START + 5_000, undefined, true);
	const editing = timeline.snapshot(START + 5_000);
	expect(editing.directorEditing).toBe(true);
	expect(stageScene({ snapshot: editing, moment: stageAt(editing), cols: 36, rows: 4, t: 0, motion: true }).individuals.find(item => item.lane < 0)?.seq).toBe("owl/director/edit");
	timeline.observe(run(lanes), "working", START + 9_000, undefined, false);
	expect(timeline.snapshot(START + 9_000).directorEditing).toBeUndefined();
});
