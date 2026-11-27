import { expect, test } from "bun:test";
import type { RunPhase } from "../src/view/appearance.ts";
import { QUIET_MS, LaneTimeline } from "../src/view/lane/timeline.ts";
import { UNPLANNED_LABEL, type LaneSnapshot, type LaneSpan, type LaneState, type LaneTrack } from "../src/view/lane/model.ts";
import type { AgentEntry, PlanLane, RunJob, RunRecord, RunResult, SpawnRecord } from "../src/types.ts";
import { agentEntry, runRecord, spawnRecord } from "./fixtures.ts";

const START = Date.parse("2026-11-20T09:00:00.000Z");
const iso = (offset: number): string => new Date(START + offset).toISOString();

function lane(name: string, over: Partial<PlanLane> = {}): PlanLane {
	return { name, kind: "code", role: "implementer", ...over };
}

function result(id: string, laneName: string, state: RunResult["state"], over: Partial<RunResult> = {}): RunResult {
	return { id, lane: laneName, state, ...over };
}

/** A worker the ledger shows for a lane: the spawn carries the lane name and the agent shares its key. */
function worker(id: string, laneName: string | undefined, over: Partial<AgentEntry> = {}): { agent: AgentEntry; spawn: SpawnRecord } {
	return {
		agent: agentEntry({ id, state: "running", startedAt: START, lastActivityAt: START, ...over }),
		spawn: spawnRecord({ spawnKey: id, ...(laneName === undefined ? {} : { lane: laneName }), ts: new Date(over.startedAt ?? START).toISOString() }),
	};
}

interface World {
	lanes?: PlanLane[];
	/** False writes a record with no plan at all (the plan-less run). */
	plan?: false;
	results?: RunResult[];
	workers?: { agent: AgentEntry; spawn: SpawnRecord }[];
	jobs?: RunJob[];
	turns?: number;
	status?: RunRecord["status"];
	startedAt?: string;
	submittedAt?: string;
}

function world(w: World): RunRecord {
	const lanes = (w.lanes ?? []).map(item => {
		// A ledger row bound to a lane is a declared result of that lane; the fixture's plan states the same declaration.
		if (item.results !== undefined) return item;
		const declared = (w.results ?? [])
			.filter(row => row.lane === item.name)
			.map(row => ({ id: row.id, kind: "change" as const, criterion: row.id, path: "a.ts" }));
		return declared.length === 0 ? item : { ...item, results: declared };
	});
	return runRecord({
		status: w.status ?? "running",
		startedAt: w.startedAt ?? iso(0),
		...(w.plan === false ? {} : { plan: { lanes, workers: {}, submittedAt: w.submittedAt ?? iso(0) } }),
		results: w.results ?? [],
		agents: (w.workers ?? []).map(item => item.agent),
		spawns: (w.workers ?? []).map(item => item.spawn),
		...(w.jobs === undefined ? {} : { jobs: w.jobs }),
		...(w.turns === undefined ? {} : { turns: w.turns }),
	});
}

function track(snapshot: LaneSnapshot, name: string): LaneTrack {
	const found = snapshot.lanes.find(item => item.name === name);
	if (found === undefined) throw new Error(`no lane ${name}`);
	return found;
}

const story = (spans: readonly LaneSpan[]): [LaneState, number][] => spans.map(span => [span.state, span.from]);
const states = (spans: readonly LaneSpan[]): LaneState[] => spans.map(span => span.state);

/** The invariants every picture relies on, checked on every snapshot a test takes. */
function assertWellFormed(snapshot: LaneSnapshot): void {
	for (const item of snapshot.lanes) {
		expect(item.spans.length).toBeGreaterThan(0);
		item.spans.forEach((span, index) => {
			const next = item.spans[index + 1];
			if (next === undefined) {
				expect(span.to).toBeUndefined();
				expect(span.from).toBeLessThanOrEqual(snapshot.now);
			} else {
				// Gapless, ordered, never zero-length, and never two neighbours in the same state.
				expect(span.to).toBe(next.from);
				expect(span.to!).toBeGreaterThan(span.from);
				expect(next.state).not.toBe(span.state);
			}
		});
		if (item.activity !== undefined) {
			expect(item.activity).toBeGreaterThanOrEqual(0);
			expect(item.activity).toBeLessThanOrEqual(1);
		}
	}
	snapshot.phases.forEach((span, index) => {
		const next = snapshot.phases[index + 1];
		if (next === undefined) expect(span.to).toBeUndefined();
		else {
			expect(span.to).toBe(next.from);
			expect(next.from).toBeGreaterThan(span.from);
			expect(next.phase).not.toBe(span.phase);
		}
	});
	expect(snapshot.phases[0]?.from ?? 0).toBe(0);
	expect(snapshot.rounds[0]).toBe(0);
	snapshot.rounds.forEach((value, index) => {
		if (index > 0) expect(value).toBeGreaterThanOrEqual(snapshot.rounds[index - 1]!);
	});
}

function look(timeline: LaneTimeline, offset: number): LaneSnapshot {
	const snapshot = timeline.snapshot(START + offset);
	assertWellFormed(snapshot);
	return snapshot;
}

function see(timeline: LaneTimeline, run: RunRecord, offset: number, phase: RunPhase = "workers"): void {
	timeline.observe(run, phase, START + offset);
}

test("a lane that starts, goes quiet, submits, is reviewed and accepted keeps those spans in order with the times they were seen", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	const pending = [result("r1", "api", "pending")];
	see(timeline, world({ lanes: plan, results: pending }), 0, "working");
	expect(story(track(look(timeline, 0), "api").spans)).toEqual([["reserved", 0]]);

	const busy = worker("w1", "api", { startedAt: START + 1_000, lastActivityAt: START + 1_000 });
	see(timeline, world({ lanes: plan, results: pending, workers: [busy] }), 1_000);
	expect(states(track(look(timeline, 1_000), "api").spans)).toEqual(["reserved", "running"]);

	// Nobody tells Storm the worker went silent: the picture records it at the moment the allowance ran out.
	const quiet = look(timeline, 1_000 + QUIET_MS + 5_000);
	expect(story(track(quiet, "api").spans)).toEqual([["reserved", 0], ["running", 1_000], ["quiet", 1_000 + QUIET_MS]]);

	const submitted = world({
		lanes: plan,
		results: [result("r1", "api", "reviewable")],
		workers: [worker("w1", "api", { state: "idle", startedAt: START + 1_000, lastActivityAt: START + 70_000 })],
	});
	see(timeline, submitted, 70_000, "verifying");
	expect(states(track(look(timeline, 70_000), "api").spans)).toEqual(["reserved", "running", "quiet", "submitted"]);

	const reviewer = worker("rv", undefined, { role: "reviewer", startedAt: START + 80_000, lastActivityAt: START + 80_000 });
	const reviewing = world({ lanes: plan, results: [result("r1", "api", "reviewable")], workers: [...submitted.agents!.map(agent => ({ agent, spawn: submitted.spawns[0]! })), reviewer] });
	see(timeline, reviewing, 80_000, "verifying");
	expect(track(look(timeline, 80_000), "api").spans.at(-1)).toEqual({ from: 80_000, state: "reviewing" });

	const accepted = world({
		lanes: plan,
		results: [result("r1", "api", "accepted")],
		workers: [worker("w1", "api", { state: "idle" }), worker("rv", undefined, { role: "reviewer", state: "idle" })],
	});
	see(timeline, accepted, 90_000, "working");
	const final = look(timeline, 95_000);
	expect(story(track(final, "api").spans)).toEqual([
		["reserved", 0],
		["running", 1_000],
		["quiet", 1_000 + QUIET_MS],
		["submitted", 70_000],
		["reviewing", 80_000],
		["accepted", 90_000],
	]);
	expect(final.complete).toBe(true);
	expect(final.now).toBe(95_000);
	expect(final.phases.map(span => [span.phase, span.from])).toEqual([["working", 0], ["workers", 1_000], ["verifying", 70_000], ["working", 90_000]]);
});

test("an unmet result shows unmet, and the retry shows running again before the lane is accepted", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	const first = worker("w1", "api", { startedAt: START, lastActivityAt: START + 4_000 });
	see(timeline, world({ lanes: plan, results: [result("r1", "api", "pending")], workers: [first] }), 5_000);
	const failed = world({
		lanes: plan,
		results: [result("r1", "api", "unmet", { reason: "check failed" })],
		workers: [worker("w1", "api", { state: "idle", lastActivityAt: START + 20_000 })],
	});
	see(timeline, failed, 20_000);
	expect(look(timeline, 20_000).complete).toBe(false);
	expect(track(look(timeline, 20_000), "api").spans.at(-1)?.state).toBe("unmet");

	const retry = world({
		lanes: plan,
		results: [result("r1", "api", "unmet")],
		workers: [worker("w1", "api", { state: "running", lastActivityAt: START + 30_000 })],
	});
	see(timeline, retry, 30_000);
	const done = world({
		lanes: plan,
		results: [result("r1", "api", "accepted")],
		workers: [worker("w1", "api", { state: "idle", lastActivityAt: START + 40_000 })],
	});
	see(timeline, done, 40_000);
	const spans = track(look(timeline, 41_000), "api").spans;
	expect(story(spans)).toEqual([["running", 0], ["unmet", 20_000], ["running", 30_000], ["accepted", 40_000]]);
});

test("a lane waits for its prerequisite and starts counting as reserved only once the result it needs is met", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("model"), lane("view", { dependsOn: [{ lane: "model", need: "result" }, { lane: "ghost", need: "result" }] })];
	const rows = (model: RunResult["state"]): RunResult[] => [result("m", "model", model), result("v", "view", "pending")];
	see(timeline, world({ lanes: plan, results: rows("pending"), workers: [worker("w1", "model", { lastActivityAt: START })] }), 0);
	let snapshot = look(timeline, 0);
	expect(track(snapshot, "view").spans.at(-1)?.state).toBe("waiting");
	// An edge to a lane the plan does not have is dropped; the lane that exists stays.
	expect(track(snapshot, "view").dependsOn).toEqual(["model"]);

	// A submission of the prerequisite is not the `result` it needs; its acceptance is.
	see(timeline, world({ lanes: plan, results: rows("reviewable"), workers: [worker("w1", "model", { state: "idle" })] }), 10_000);
	expect(track(look(timeline, 10_000), "view").spans.at(-1)?.state).toBe("waiting");
	see(timeline, world({ lanes: plan, results: rows("accepted"), workers: [worker("w1", "model", { state: "idle" })] }), 20_000);
	snapshot = look(timeline, 20_000);
	expect(story(track(snapshot, "view").spans)).toEqual([["waiting", 0], ["reserved", 20_000]]);
});

test("an edge that asks only for a reviewable submission is satisfied by one", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("model"), lane("check", { kind: "review", role: "reviewer", dependsOn: [{ lane: "model", need: "reviewable" }] })];
	see(timeline, world({ lanes: plan, results: [result("m", "model", "reviewable"), result("c", "check", "pending")], workers: [worker("w1", "model", { state: "idle" })] }), 0);
	expect(track(look(timeline, 0), "check").spans.at(-1)?.state).toBe("reserved");
});

test("a lane whose results the user took out of scope shows excluded and does not stand in the way of complete", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api"), lane("docs")];
	const rows = (docs: Partial<RunResult>): RunResult[] => [result("a", "api", "accepted"), result("d", "docs", "pending", docs)];
	see(timeline, world({ lanes: plan, results: rows({}) }), 0);
	expect(look(timeline, 0).complete).toBe(false);
	see(timeline, world({ lanes: plan, results: rows({ scope: "excluded-by-user" }) }), 5_000);
	const snapshot = look(timeline, 5_000);
	expect(story(track(snapshot, "docs").spans)).toEqual([["reserved", 0], ["excluded", 5_000]]);
	expect(track(snapshot, "docs").progress).toBeUndefined();
	expect(snapshot.complete).toBe(true);
});

test("excluding a lane takes it out of the plan but it stays in the picture as excluded, where it was", () => {
	const timeline = new LaneTimeline();
	const rows = (excluded: boolean): RunResult[] => [
		result("a", "a", "accepted"),
		result("b", "b", "pending"),
		result("c", "c", "pending", excluded ? { scope: "excluded-by-user" } : {}),
	];
	see(timeline, world({ lanes: [lane("a"), lane("b"), lane("c")], results: rows(false) }), 0);
	const slot = track(look(timeline, 0), "c").slot;
	// The record after the exclusion: the plan no longer lists the lane; its result row keeps the lane and the scope.
	see(timeline, world({ lanes: [lane("a"), lane("b")], results: rows(true) }), 6_000);
	const snapshot = look(timeline, 6_000);
	expect(snapshot.lanes.map(item => item.name)).toEqual(["a", "b", "c"]);
	expect(story(track(snapshot, "c").spans)).toEqual([["reserved", 0], ["excluded", 6_000]]);
	expect(track(snapshot, "c").slot).toBe(slot);
	expect(track(snapshot, "c").progress).toBeUndefined();
	// Later observations keep it, without a new span.
	see(timeline, world({ lanes: [lane("a"), lane("b")], results: rows(true) }), 9_000);
	expect(story(track(look(timeline, 9_000), "c").spans)).toEqual([["reserved", 0], ["excluded", 6_000]]);
	// A lane the plan dropped with results still in scope is a replan, not an exclusion: it leaves.
	see(timeline, world({ lanes: [lane("a")], results: [result("a", "a", "accepted"), result("b", "b", "pending")] }), 12_000);
	expect(look(timeline, 12_000).lanes.map(item => item.name)).toEqual(["a"]);
});

test("everything excluded is not a finished run", () => {
	const timeline = new LaneTimeline();
	see(timeline, world({ lanes: [lane("docs")], results: [result("d", "docs", "pending", { scope: "excluded-by-user" })] }), 0);
	const snapshot = look(timeline, 0);
	expect(track(snapshot, "docs").spans.at(-1)?.state).toBe("excluded");
	expect(snapshot.complete).toBe(false);
});

test("a structured blocker shows blocked, and a worker that tries again shows running instead", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	const blocked = [result("r", "api", "unmet", { remedy: "blocked", unblock: "log in" })];
	see(timeline, world({ lanes: plan, results: blocked, workers: [worker("w1", "api", { state: "idle" })] }), 0);
	expect(track(look(timeline, 0), "api").spans.at(-1)?.state).toBe("blocked");
	see(timeline, world({ lanes: plan, results: blocked, workers: [worker("w1", "api", { lastActivityAt: START + 8_000 })] }), 8_000);
	expect(states(track(look(timeline, 8_000), "api").spans)).toEqual(["blocked", "running"]);
});

test("an exhausted retry route is unmet, not blocked", () => {
	const timeline = new LaneTimeline();
	see(timeline, world({ lanes: [lane("api")], results: [result("r", "api", "unmet", { remedy: "retry" })], workers: [worker("w1", "api", { state: "idle" })] }), 0);
	expect(track(look(timeline, 0), "api").spans.at(-1)?.state).toBe("unmet");
});

test("a job lane is marked as a job, runs while its receipt says started, and is accepted when its result is met", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("lint", { job: "lint", role: "quick", kind: "run" })];
	const receipt = (status: RunJob["status"]): RunJob => ({ lane: "lint", name: "lint", status, exitCode: status === "passed" ? 0 : null, startedAt: iso(2_000), finishedAt: status === "started" ? null : iso(9_000) });
	see(timeline, world({ lanes: plan, results: [result("l", "lint", "pending")] }), 0);
	see(timeline, world({ lanes: plan, results: [result("l", "lint", "pending")], jobs: [receipt("started")] }), 2_000);
	const running = look(timeline, 5_000);
	expect(track(running, "lint").job).toBe(true);
	expect(track(running, "lint").spans.at(-1)?.state).toBe("running");
	expect(track(running, "lint").activity).toBeGreaterThan(0);
	expect(track(running, "lint").label).not.toBe("");
	see(timeline, world({ lanes: plan, results: [result("l", "lint", "accepted")], jobs: [receipt("passed")] }), 9_000);
	expect(story(track(look(timeline, 9_500), "lint").spans)).toEqual([["reserved", 0], ["running", 2_000], ["accepted", 9_000]]);
});

test("a passed job lane with no declared results is idle, not accepted", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("lint", { job: "lint", role: "quick", kind: "run" })];
	const receipt: RunJob = { lane: "lint", name: "lint", status: "passed", exitCode: 0, startedAt: iso(2_000), finishedAt: iso(9_000) };
	see(timeline, world({ lanes: plan, jobs: [receipt] }), 9_000);
	const snapshot = look(timeline, 9_500);
	expect(track(snapshot, "lint").spans.at(-1)?.state).toBe("idle");
	expect(snapshot.complete).toBe(false);
});

test("a worker placed without a lane gets a row after the plan's, running then idle, never accepted", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	const rows = [result("r", "api", "pending")];
	const busy = worker("outside", undefined, { state: "running", startedAt: START, lastActivityAt: START });
	see(timeline, world({ lanes: plan, results: rows, workers: [busy] }), 0);
	const live = look(timeline, 0);
	expect(live.lanes.map(item => item.name)).toEqual(["api", "outside"]);
	expect(track(live, "outside").label).toBe(UNPLANNED_LABEL);
	expect(states(track(live, "outside").spans)).toEqual(["running"]);

	const settled = worker("outside", undefined, { state: "idle", startedAt: START, lastActivityAt: START });
	see(timeline, world({ lanes: plan, results: rows, workers: [settled] }), 5_000);
	const done = track(look(timeline, 5_000), "outside");
	expect(done.spans.at(-1)?.state).toBe("idle");
	expect(done.spans.some(span => span.state === "accepted")).toBe(false);
});

test("a plan-less run draws its placed workers and its refusals, never accepted", () => {
	const timeline = new LaneTimeline();
	const placed = worker("w", undefined, { state: "running", startedAt: START, lastActivityAt: START });
	see(timeline, world({ plan: false, workers: [placed] }), 0);
	const live = look(timeline, 0);
	expect(live.lanes.map(item => item.name)).toEqual(["w"]);
	expect(track(live, "w").label).toBe(UNPLANNED_LABEL);
	expect(live.complete).toBe(false);

	const refused = runRecord({
		status: "running",
		startedAt: iso(0),
		spawns: [spawnRecord({ spawnKey: "r", outcome: "blocked", code: "internal", reason: "not admitted" })],
	});
	see(timeline, refused, 1_000);
	const row = track(look(timeline, 1_000), "r");
	expect(states(row.spans)).toEqual(["refused"]);
	expect(row.label).toBe(UNPLANNED_LABEL);
});

test("a hundred placements stay one bounded picture: every row is present and none is accepted", () => {
	const timeline = new LaneTimeline();
	const workers = Array.from({ length: 120 }, (_, index) =>
		worker(`w${index}`, undefined, { state: index % 2 === 0 ? "running" : "idle", startedAt: START, lastActivityAt: START }),
	);
	see(timeline, world({ plan: false, workers }), 0);
	const snapshot = look(timeline, 0);
	expect(snapshot.lanes).toHaveLength(120);
	expect(snapshot.lanes.every(item => item.spans.at(-1)?.state !== "accepted")).toBe(true);
	expect(snapshot.complete).toBe(false);
});

test("a failed job is unmet and a job that could not be spawned is blocked", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("a", { job: "a" }), lane("b", { job: "b" })];
	const receipt = (name: string, status: RunJob["status"]): RunJob => ({ lane: name, name, status, exitCode: 1, startedAt: iso(0), finishedAt: iso(1_000) });
	see(timeline, world({ lanes: plan, results: [result("a", "a", "pending"), result("b", "b", "pending")], jobs: [receipt("a", "failed"), receipt("b", "spawn-error")] }), 2_000);
	const snapshot = look(timeline, 2_000);
	expect(track(snapshot, "a").spans.at(-1)?.state).toBe("unmet");
	expect(track(snapshot, "b").spans.at(-1)?.state).toBe("blocked");
});

test("job lanes without a worker are labelled with Storm's job word, worker lanes with their role's word", () => {
	const timeline = new LaneTimeline();
	see(timeline, world({ lanes: [lane("lint", { job: "lint" }), lane("api"), lane("look", { kind: "explore", role: "explorer" })] }), 0);
	const snapshot = look(timeline, 0);
	const labels = snapshot.lanes.map(item => item.label);
	expect(new Set(labels).size).toBe(3);
	expect(track(snapshot, "lint").job).toBe(true);
	expect(track(snapshot, "api").job).toBeUndefined();
});

test("a new round is recorded when the counter moves, and phases keep their own spans", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	see(timeline, world({ lanes: plan, turns: 0 }), 0, "working");
	see(timeline, world({ lanes: plan, turns: 0 }), 3_000, "working");
	see(timeline, world({ lanes: plan, turns: 1 }), 30_000, "between-rounds");
	see(timeline, world({ lanes: plan, turns: 1 }), 31_000, "working");
	see(timeline, world({ lanes: plan, turns: 2 }), 60_000, "stopping");
	const snapshot = look(timeline, 61_000);
	expect(snapshot.rounds).toEqual([0, 30_000, 60_000]);
	expect(snapshot.phases.map(span => [span.phase, span.from])).toEqual([["working", 0], ["between-rounds", 30_000], ["working", 31_000], ["stopping", 60_000]]);
});

test("the first observation of a run that is already under way draws each lane's earlier life as one stretch", () => {
	const timeline = new LaneTimeline();
	const startedAt = iso(0);
	const now = 600_000;
	const plan = [lane("done"), lane("busy"), lane("next", { dependsOn: [{ lane: "busy", need: "result" }] }), lane("stuck")];
	const run = world({
		startedAt,
		submittedAt: iso(20_000),
		lanes: plan,
		results: [
			result("d", "done", "accepted"),
			result("b", "busy", "pending"),
			result("n", "next", "pending"),
			result("s", "stuck", "unmet"),
		],
		workers: [
			worker("w-done", "done", { state: "idle", startedAt: START + 30_000, lastActivityAt: START + 200_000 }),
			worker("w-busy", "busy", { startedAt: START + 240_000, lastActivityAt: START + now - 1_000 }),
			worker("w-stuck", "stuck", { state: "idle", startedAt: START + 50_000, lastActivityAt: START + 90_000 }),
		],
		turns: 3,
	});
	see(timeline, run, now, "workers");
	const snapshot = look(timeline, now);
	expect(story(track(snapshot, "done").spans)).toEqual([["reserved", 20_000], ["accepted", 30_000]]);
	expect(story(track(snapshot, "busy").spans)).toEqual([["reserved", 20_000], ["running", 240_000]]);
	expect(story(track(snapshot, "stuck").spans)).toEqual([["reserved", 20_000], ["unmet", 50_000]]);
	expect(story(track(snapshot, "next").spans)).toEqual([["waiting", 20_000]]);
	// The phase and the rounds begin at the run's start: the record does not date what happened before.
	expect(snapshot.phases).toEqual([{ from: 0, phase: "workers" }]);
	expect(snapshot.rounds).toEqual([0]);
	expect(snapshot.now).toBe(now);
});

test("a run observed again after a restart sees no live workers: a stale running agent does not run", () => {
	const timeline = new LaneTimeline();
	const run = world({
		status: "interrupted" as RunRecord["status"],
		lanes: [lane("api")],
		results: [result("r", "api", "pending")],
		workers: [worker("w1", "api", { state: "running", lastActivityAt: START + 1_000 })],
	});
	see(timeline, run, 5_000);
	expect(track(look(timeline, 5_000), "api").spans.at(-1)?.state).toBe("idle");
});

test("progress counts the in-scope results a lane has met, and a lane without results has none", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api"), lane("old")];
	see(timeline, world({ lanes: plan, results: [result("a", "api", "accepted"), result("b", "api", "pending"), result("c", "api", "pending", { scope: "excluded-by-user" })] }), 0);
	let snapshot = look(timeline, 0);
	expect(track(snapshot, "api").progress).toEqual({ met: 1, total: 2 });
	expect(track(snapshot, "old").progress).toBeUndefined();
	see(timeline, world({ lanes: plan, results: [result("a", "api", "accepted"), result("b", "api", "accepted"), result("c", "api", "pending", { scope: "excluded-by-user" })] }), 4_000);
	snapshot = look(timeline, 4_000);
	expect(track(snapshot, "api").progress).toEqual({ met: 2, total: 2 });
	expect(track(snapshot, "api").spans.at(-1)?.state).toBe("accepted");
});

test("complete is true only when every in-scope result of every lane is met", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api"), lane("view")];
	const done = (a: RunResult["state"], v: RunResult["state"]): RunRecord => world({ lanes: plan, results: [result("a", "api", a), result("v", "view", v)] });
	see(timeline, done("accepted", "reviewable"), 0);
	expect(look(timeline, 0).complete).toBe(false);
	see(timeline, done("accepted", "accepted"), 1_000);
	expect(look(timeline, 1_000).complete).toBe(true);
	// A result that becomes unmet again takes the run out of its finished state.
	see(timeline, done("accepted", "unmet"), 2_000);
	expect(look(timeline, 2_000).complete).toBe(false);
	// A run with no result ledger has nothing the status line could call met.
	const legacy = new LaneTimeline();
	see(legacy, world({ lanes: plan }), 0);
	expect(look(legacy, 0).complete).toBe(false);
});

test("a lane the plan drops leaves the picture, and a lane a replan adds starts when it was seen", () => {
	const timeline = new LaneTimeline();
	see(timeline, world({ lanes: [lane("a"), lane("b")], results: [result("a", "a", "pending"), result("b", "b", "pending")] }), 0);
	see(timeline, world({ lanes: [lane("a"), lane("c")], results: [result("a", "a", "pending"), result("c", "c", "pending")] }), 9_000);
	const snapshot = look(timeline, 9_000);
	expect(snapshot.lanes.map(item => item.name)).toEqual(["a", "c"]);
	expect(story(track(snapshot, "c").spans)).toEqual([["reserved", 9_000]]);
});

test("a lane keeps its colour slot when a replan drops or adds other lanes", () => {
	const timeline = new LaneTimeline();
	const pending = (names: string[]) => names.map(name => result(name, name, "pending"));
	see(timeline, world({ lanes: [lane("a"), lane("b"), lane("c")], results: pending(["a", "b", "c"]) }), 0);
	const before = look(timeline, 0);
	const slotB = track(before, "b").slot;
	const slotC = track(before, "c").slot;
	expect(new Set([track(before, "a").slot, slotB, slotC]).size).toBe(3);
	see(timeline, world({ lanes: [lane("b"), lane("c"), lane("d")], results: pending(["b", "c", "d"]) }), 5_000);
	const after = look(timeline, 5_000);
	expect(track(after, "b").slot).toBe(slotB);
	expect(track(after, "c").slot).toBe(slotC);
	// A new lane never takes the slot of one that left.
	expect([track(before, "a").slot, slotB, slotC]).not.toContain(track(after, "d").slot);
	// A lane that returns is a new lane.
	see(timeline, world({ lanes: [lane("a"), lane("b"), lane("c")], results: pending(["a", "b", "c"]) }), 9_000);
	expect(track(look(timeline, 9_000), "b").slot).toBe(slotB);
});

test("a worker is running while it has acted within the allowance, quiet after, and its activity eases down in between", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	see(timeline, world({ lanes: plan, results: [result("r", "api", "pending")], workers: [worker("w1", "api", { lastActivityAt: START })] }), 0);
	const fresh = track(look(timeline, 0), "api");
	const later = track(look(timeline, QUIET_MS / 2), "api");
	const edge = track(look(timeline, QUIET_MS - 1), "api");
	const quiet = track(look(timeline, QUIET_MS + 1), "api");
	expect(fresh.spans.at(-1)?.state).toBe("running");
	expect(fresh.activity).toBe(1);
	expect(later.activity!).toBeLessThan(fresh.activity!);
	expect(edge.activity!).toBeLessThan(later.activity!);
	expect(quiet.spans.at(-1)?.state).toBe("quiet");
	expect(quiet.activity!).toBeLessThan(edge.activity!);
	expect(quiet.activity!).toBeGreaterThan(0);
	// An observation that shows fresh activity brings it back at that activity, not at the moment it was noticed.
	see(timeline, world({ lanes: plan, results: [result("r", "api", "pending")], workers: [worker("w1", "api", { lastActivityAt: START + 90_000 })] }), 95_000);
	const resumed = look(timeline, 95_000);
	expect(story(track(resumed, "api").spans)).toEqual([["running", 0], ["quiet", QUIET_MS], ["running", 90_000]]);
	// Settled lanes carry no activity.
	see(timeline, world({ lanes: plan, results: [result("r", "api", "reviewable")], workers: [worker("w1", "api", { state: "idle" })] }), 100_000);
	expect(track(look(timeline, 100_000), "api").activity).toBeUndefined();
});

test("a worker with no activity on record is quiet at once", () => {
	const timeline = new LaneTimeline();
	see(timeline, world({ lanes: [lane("api")], results: [result("r", "api", "pending")], workers: [worker("w1", "api", { lastActivityAt: 0 })] }), 1_000);
	expect(track(look(timeline, 1_000), "api").spans.at(-1)?.state).toBe("quiet");
});

test("a reviewer lane that depends on a lane marks that lane as being reviewed", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api"), lane("check", { kind: "review", role: "reviewer", dependsOn: [{ lane: "api", need: "reviewable" }] }), lane("other")];
	const run = world({
		lanes: plan,
		results: [result("a", "api", "reviewable"), result("c", "check", "pending"), result("o", "other", "reviewable")],
		workers: [worker("w1", "api", { state: "idle" }), worker("w2", "check", { role: "reviewer", lastActivityAt: START })],
	});
	see(timeline, run, 0);
	const snapshot = look(timeline, 0);
	expect(track(snapshot, "api").spans.at(-1)?.state).toBe("reviewing");
	expect(track(snapshot, "check").spans.at(-1)?.state).toBe("running");
	// A reviewer that is bound to another lane says nothing about a lane it does not depend on.
	expect(track(snapshot, "other").spans.at(-1)?.state).toBe("submitted");
});

test("a review lane that declares no dependency is the batch review: every reviewable lane shows the scan", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("a"), lane("b"), lane("c"), lane("gate", { kind: "review", role: "reviewer" })];
	see(timeline, world({
		lanes: plan,
		results: [result("ra", "a", "reviewable"), result("rb", "b", "reviewable"), result("rc", "c", "pending"), result("rg", "gate", "pending")],
		workers: [worker("w1", "a", { state: "idle" }), worker("w2", "b", { state: "idle" }), worker("rv", "gate", { role: "reviewer", lastActivityAt: START })],
	}), 0);
	const snapshot = look(timeline, 0);
	expect(track(snapshot, "a").spans.at(-1)?.state).toBe("reviewing");
	expect(track(snapshot, "b").spans.at(-1)?.state).toBe("reviewing");
	// Nothing to judge on a lane whose result is not reviewable, and the gate itself works.
	expect(track(snapshot, "c").spans.at(-1)?.state).toBe("reserved");
	expect(track(snapshot, "gate").spans.at(-1)?.state).toBe("running");
});

test("changes seen in the same instant leave one span, and flapping back inside it leaves none", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	const pending = [result("r", "api", "pending")];
	see(timeline, world({ lanes: plan, results: pending }), 0);
	see(timeline, world({ lanes: plan, results: [result("r", "api", "reviewable")], workers: [worker("w1", "api", { state: "idle" })] }), 1_000);
	expect(story(track(look(timeline, 1_000), "api").spans)).toEqual([["reserved", 0], ["submitted", 1_000]]);
	see(timeline, world({ lanes: plan, results: pending, workers: [worker("w1", "api", { lastActivityAt: START + 1_000 })] }), 1_000);
	expect(story(track(look(timeline, 1_000), "api").spans)).toEqual([["reserved", 0], ["running", 1_000]]);
	see(timeline, world({ lanes: plan, results: pending }), 1_000);
	expect(story(track(look(timeline, 1_000), "api").spans)).toEqual([["reserved", 0]]);
});

test("time never runs backwards when the clock or the record disagrees", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api")];
	see(timeline, world({ lanes: plan, results: [result("r", "api", "pending")] }), 10_000);
	see(timeline, world({ lanes: plan, results: [result("r", "api", "reviewable")], workers: [worker("w1", "api", { state: "idle" })] }), 4_000);
	const snapshot = look(timeline, 3_000);
	expect(snapshot.now).toBeGreaterThanOrEqual(10_000);
	expect(states(track(snapshot, "api").spans)).toEqual(["reserved", "submitted"]);
});

test("before any observation there is nothing to draw", () => {
	const snapshot = new LaneTimeline().snapshot(START);
	expect(snapshot.lanes).toEqual([]);
	expect(snapshot.complete).toBe(false);
	expect(snapshot.rounds).toEqual([0]);
});

test("history grows with the number of changes, not with observations or time", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("api"), lane("view")];
	const run = world({
		lanes: plan,
		results: [result("a", "api", "pending"), result("v", "view", "pending")],
		workers: [worker("w1", "api", { state: "idle" })],
	});
	see(timeline, run, 0);
	const before = look(timeline, 0);
	for (let step = 1; step <= 5_000; step++) {
		see(timeline, run, step * 1_000);
		timeline.snapshot(START + step * 1_000 + 500);
	}
	const after = look(timeline, 5_000_000);
	expect(track(after, "api").spans.length).toBe(track(before, "api").spans.length);
	expect(after.phases.length).toBe(1);
	expect(after.rounds).toEqual([0]);
	// The snapshot of a still picture hands out the same arrays frame after frame: nothing is rebuilt.
	const a = timeline.snapshot(START + 6_000_000);
	const b = timeline.snapshot(START + 6_000_033);
	expect(b.lanes).toBe(a.lanes);
	expect(b.phases).toBe(a.phases);
	expect(b.now).toBeGreaterThan(a.now);
});

test("a long quiet stretch adds exactly one span however often it is looked at", () => {
	const timeline = new LaneTimeline();
	see(timeline, world({ lanes: [lane("api")], results: [result("r", "api", "pending")], workers: [worker("w1", "api", { lastActivityAt: START })] }), 0);
	for (let step = 0; step < 2_000; step++) look(timeline, 1_000 + step * 500);
	expect(states(track(look(timeline, 2_000_000), "api").spans)).toEqual(["running", "quiet"]);
});

test("a long mixed sequence keeps every lane's spans gapless, ordered and alternating", () => {
	const timeline = new LaneTimeline();
	const plan = [lane("a"), lane("b", { dependsOn: [{ lane: "a", need: "result" }] }), lane("c", { job: "c" })];
	let seed = 7;
	const next = (n: number): number => {
		seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
		return seed % n;
	};
	const rowStates: RunResult["state"][] = ["pending", "unmet", "reviewable", "accepted"];
	const phases: RunPhase[] = ["working", "workers", "verifying", "waiting-user", "between-rounds", "stopping"];
	let offset = 0;
	for (let step = 0; step < 400; step++) {
		offset += next(40_000);
		const crew = [
			...(next(2) === 0 ? [worker("wa", "a", { state: next(2) === 0 ? "running" : "idle", lastActivityAt: START + offset - next(90_000) })] : []),
			...(next(2) === 0 ? [worker("wb", "b", { state: next(2) === 0 ? "running" : "idle", lastActivityAt: START + offset - next(90_000) })] : []),
			...(next(3) === 0 ? [worker("rv", undefined, { role: "reviewer", state: next(2) === 0 ? "running" : "idle" })] : []),
		];
		const run = world({
			lanes: plan,
			results: [
				result("a", "a", rowStates[next(4)]!, next(9) === 0 ? { scope: "excluded-by-user" } : {}),
				result("b", "b", rowStates[next(4)]!, next(5) === 0 ? { remedy: "blocked" } : {}),
				result("c", "c", rowStates[next(4)]!),
			],
			workers: crew,
			jobs: next(2) === 0 ? [{ lane: "c", name: "c", status: (["started", "passed", "failed", "unrun"] as const)[next(4)]!, exitCode: null, startedAt: iso(0), finishedAt: null }] : [],
			turns: Math.floor(step / 50),
		});
		see(timeline, run, offset, phases[next(6)]!);
		look(timeline, offset + next(70_000));
	}
	look(timeline, offset + 10_000_000);
	expect(timeline.snapshot(START + offset + 10_000_000).rounds.length).toBe(8);
});
