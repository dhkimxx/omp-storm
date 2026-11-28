/**
 * The one derivation of a run's result facts. A run with no declared rows must never look verified by a fraction or a
 * complete mark; removed and orphaned rows stay visible as what they are; workers are counted apart from result rows.
 */
import { describe, expect, test } from "bun:test";
import { NO_DECLARED_RESULTS, OUT_OF_PLAN_LABEL, resultFacts, workerCountText } from "../src/runtime/result-facts.ts";
import type { PlanLane, RunPlan, RunResult, UnplannedDelivery } from "../src/types.ts";
import { agentEntry, runRecord, spawnRecord } from "./fixtures.ts";

const planOf = (...lanes: PlanLane[]): RunPlan => ({ lanes, workers: {}, submittedAt: "2026-11-20T09:00:00.000Z" });
const lane = (name: string, results?: PlanLane["results"]): PlanLane => ({
	name,
	kind: "code",
	role: "implementer",
	...(results === undefined ? {} : { results }),
});
const declared = (id: string): NonNullable<PlanLane["results"]>[number] => ({ id, kind: "change", criterion: id, path: "a.ts" });
const row = (id: string, state: RunResult["state"], extra: Partial<RunResult> = {}): RunResult => ({ id, lane: "L", state, ...extra });
const rowNoLane = (id: string, state: RunResult["state"]): RunResult => ({ id, state });
const delivery = (agent: string, extra: Partial<UnplannedDelivery> = {}): UnplannedDelivery => ({
	id: `task:call:${agent}`,
	kind: "unplaced",
	agent,
	endedAt: Date.parse("2026-11-20T09:05:00.000Z"),
	...extra,
});

describe("declared, mixed and none", () => {
	test("a run that declares nothing and did nothing stays quiet", () => {
		const facts = resultFacts(runRecord());
		expect(facts.declaration).toBe("none");
		expect(facts.hasDeclared).toBe(false);
		expect(facts.noResultsNotice).toBe(false);
		expect(facts.headline).toBe(NO_DECLARED_RESULTS);
		expect(facts.complete).toBe(false);
		expect(facts.tone).toBe("muted");
	});

	test("a declared run counts its rows and is complete only when every in-scope row is accepted", () => {
		const plan = planOf(lane("L", [declared("r1"), declared("r2")]));
		const open = resultFacts(runRecord({ plan, results: [row("r1", "accepted"), row("r2", "unmet")] }));
		expect(open.declaration).toBe("declared");
		expect(open.hasDeclared).toBe(true);
		expect(open.rows).toEqual({ total: 2, declared: 2, removed: 0, orphaned: 0, excluded: 0 });
		expect(open.coverage).toEqual({ lanes: 1, declaredLanes: 1, declared: 2, recorded: 2, missing: 0 });
		expect(open.complete).toBe(false);
		const done = resultFacts(runRecord({ plan, results: [row("r1", "accepted"), row("r2", "accepted")] }));
		expect(done.complete).toBe(true);
	});

	test("a declared run with out-of-plan work is mixed and says 계획 밖 N beside the counts", () => {
		const plan = planOf(lane("L", [declared("r1")]));
		const facts = resultFacts(
			runRecord({
				plan,
				results: [row("r1", "accepted")],
				spawns: [spawnRecord({ spawnKey: "out" })],
				unplanned: [delivery("out")],
				unplannedCount: 1,
			}),
		);
		expect(facts.declaration).toBe("mixed");
		expect(facts.outOfPlan).toBe(1);
		expect(facts.parts.at(-1)).toBe(`${OUT_OF_PLAN_LABEL} 1`);
		expect(facts.headline).toContain(`${OUT_OF_PLAN_LABEL} 1`);
		expect(facts.complete).toBe(true);
	});

	test("an out-of-plan placement is activity until a delivery makes the run mixed", () => {
		const plan = planOf(lane("L", [declared("r1")]));
		const placed = resultFacts(
			runRecord({ plan, results: [row("r1", "accepted")], spawns: [spawnRecord({ spawnKey: "out" })] }),
		);
		expect(placed.declaration).toBe("declared");
		expect(placed.activity.unplannedPlaced).toBe(1);
		const delivered = resultFacts({ ...runRecord({ plan, results: [row("r1", "accepted")], spawns: [spawnRecord({ spawnKey: "out" })] }), unplanned: [delivery("out")], unplannedCount: 1 });
		expect(delivered.declaration).toBe("mixed");
	});

	test("a plan with no result rows or a plan-less worker run says so", () => {
		expect(resultFacts(runRecord({ plan: planOf(lane("read")) })).noResultsNotice).toBe(true);
		expect(resultFacts(runRecord({ spawns: [spawnRecord({ spawnKey: "w" })] })).noResultsNotice).toBe(true);
		expect(resultFacts(runRecord({ agents: [agentEntry()] })).noResultsNotice).toBe(false);
	});
});

describe("removed and orphaned rows", () => {
	test("a row whose id the plan no longer declares is removed; an open removed row with no lane is orphaned", () => {
		const plan = planOf(lane("L", [declared("keep")]));
		const facts = resultFacts(
			runRecord({
				plan,
				results: [
					row("keep", "accepted"),
					row("old-with-lane", "unmet"),
					rowNoLane("old-no-lane", "unmet"),
					rowNoLane("old-accepted", "accepted"),
				],
			}),
		);
		expect(facts.rows).toEqual({ total: 4, declared: 1, removed: 3, orphaned: 1, excluded: 0 });
		expect(facts.headline).not.toContain(NO_DECLARED_RESULTS);
	});

	test("a record with no plan keeps every row as declared, as old records read today", () => {
		const facts = resultFacts(runRecord({ results: [rowNoLane("only", "unmet")] }));
		expect(facts.rows).toEqual({ total: 1, declared: 1, removed: 0, orphaned: 0, excluded: 0 });
		expect(facts.declaration).toBe("declared");
	});
});

describe("excluded rows", () => {
	test("everything excluded keeps declared rows but no comparable fraction", () => {
		const plan = planOf(lane("L", [declared("r1")]));
		const facts = resultFacts(
			runRecord({ plan, results: [row("r1", "pending", { scope: "excluded-by-user" })] }),
		);
		expect(facts.declaration).toBe("declared");
		expect(facts.rows.excluded).toBe(1);
		expect(facts.progress.counts.inScope).toBe(0);
		expect(facts.complete).toBe(false);
		expect(facts.tone).toBe("muted");
	});
});

describe("worker activity counted apart", () => {
	test("placed, refused and unplanned placements are distinct facts", () => {
		const facts = resultFacts(
			runRecord({
				spawns: [
					spawnRecord({ spawnKey: "planned", lane: "L" }),
					spawnRecord({ spawnKey: "outside" }),
					spawnRecord({ spawnKey: "refused", outcome: "blocked" }),
				],
			}),
		);
		expect(facts.activity).toMatchObject({ placed: 2, refused: 1, unplannedPlaced: 1, started: 0, settled: 0 });
	});

	test("started, settled and failed read the agent ledger, not the spawn outcome", () => {
		const running = resultFacts(runRecord({ agents: [agentEntry({ state: "running" })] }));
		expect(running.activity).toMatchObject({ started: 1, settled: 0, failed: 0 });
		const settled = resultFacts(runRecord({ agents: [agentEntry({ state: "idle" })] }));
		expect(settled.activity).toMatchObject({ started: 1, settled: 1, failed: 0 });
		const failed = resultFacts(runRecord({ agents: [agentEntry({ state: "idle", lastWorkFailed: true }), agentEntry({ id: "changed", changes: 2 })] }));
		expect(failed.activity).toMatchObject({ started: 2, settled: 2, failed: 1, changed: 1 });
	});

	test("unplanned deliveries count from the kept list and the full count; only asked-for work is out-of-plan", () => {
		const facts = resultFacts(runRecord({ unplanned: [delivery("a")], unplannedCount: 7 }));
		expect(facts.activity.unplanned).toBe(7);
		// Nobody this run placed delivered it: it is an arrival, not out-of-plan activity (B8).
		expect(facts.outOfPlan).toBe(0);
		const placed = resultFacts(runRecord({
			spawns: [spawnRecord({ spawnKey: "a", agent: "storm-explorer" })],
			unplanned: [delivery("a")],
		}));
		expect(placed.outOfPlan).toBe(1);
	});
});

describe("cost with many workers", () => {
	test("a hundred placements stay a count: no per-worker text in the headline or parts", () => {
		const spawns = Array.from({ length: 120 }, (_, index) =>
			spawnRecord({ spawnKey: `w${index}`, agent: `storm-explorer-${index}` }),
		);
		const agents = spawns.map((spawn, index) => agentEntry({ id: spawn.spawnKey!, name: "storm-explorer", state: index % 2 ? "idle" : "running", changes: index % 3 }));
		const facts = resultFacts(runRecord({ spawns, agents }));
		expect(facts.activity.placed).toBe(120);
		expect(facts.activity.started).toBe(120);
		expect(facts.headline).toBe(NO_DECLARED_RESULTS);
		expect(facts.parts).toEqual([NO_DECLARED_RESULTS]);
		expect(facts.headline.length).toBeLessThan(40);
		expect(workerCountText(facts.activity)).toBe("워커 120");
	});
});

describe("the changed-path count is never invented", () => {
	test("it is shown only when the caller read the tree, and a changed worker is a separate fact", () => {
		const run = runRecord({ agents: [agentEntry({ changes: 4 })] });
		expect(resultFacts(run).changedPaths).toBeUndefined();
		expect(resultFacts(run).activity.changed).toBe(1);
		expect(resultFacts(run, { changedPaths: 7 }).changedPaths).toBe(7);
		expect(resultFacts(run, { changedPaths: Number.NaN }).changedPaths).toBeUndefined();
	});
});
