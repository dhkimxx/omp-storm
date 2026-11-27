/**
 * A lane may start before its prerequisite is accepted. What makes that safe is the run record, so these tests drive the
 * real RunController and RunLanes the way the extension does (readiness, placement, attempt, settlement) and read the
 * result rows:
 * - the consumer's call carries a note that says what state the prerequisite is in;
 * - a consumer that started on a prerequisite with no usable submission records that input as `missing` and is never
 *   accepted on it, whatever the prerequisite does afterwards;
 * - a consumer that started on an accepted row whose worker was running again is reopened when that row changes;
 * - the one case the record does not tie (an `integrated` edge on a result the tree does not carry) keeps its refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { dependencyStart } from "../src/runtime/lanes.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { staleRequirementIdsForPlan } from "../src/runtime/requirements.ts";
import type { AgentEntry, PlanLane, RunPlan, RunResult, StormConfig } from "../src/types.ts";
import { fakeSession, type FakeSession } from "./fake-session.ts";
import { TEST_TIMINGS } from "./timings.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", quick: "a/q", reviewer: "a/r" });

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-early-start-")));
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

/** B produces b.txt; A consumes it (`need` on the edge) and writes a.txt. */
function plan(need: "result" | "integrated" = "result"): RunPlan {
	return {
		lanes: [
			{
				name: "b-produce",
				kind: "code",
				role: "implementer",
				files: ["b.txt"],
				goal: "Publish the B result",
				results: [{ id: "b-result", kind: "change", criterion: "b.txt holds a version", path: "b.txt", contains: "version:" }],
			},
			{
				name: "a-consume",
				kind: "code",
				role: "quick",
				files: ["a.txt"],
				goal: "Build on the B result",
				results: [{ id: "a-result", kind: "change", criterion: "a.txt accepts its input", path: "a.txt", contains: "result: accepted" }],
				dependsOn: [{ lane: "b-produce", need }],
			},
		],
		workers: { implementer: 1, quick: 1 },
		submittedAt: new Date(T0).toISOString(),
	};
}

const report = (over: Partial<AttemptReport> & Pick<AttemptReport, "runId" | "spawnKey" | "attemptId">): AttemptReport => ({
	schema: "storm.attempt-report/v1",
	parentId: "main",
	outcome: "success",
	capture: "observed",
	observedAt: T0 + 1,
	version: "unknown",
	artifacts: [],
	observations: [],
	...over,
});

interface Run {
	h: FakeSession;
	runId: string;
	agents: AgentEntry[];
	p: RunPlan;
}

async function begin(p: RunPlan): Promise<Run> {
	const agents: AgentEntry[] = [];
	const h = fakeSession({ root, agents, config: TEAM, timings: TEST_TIMINGS });
	const runId = await h.start();
	expect(await h.controller.setPlan(h.ctx, p)).toEqual({ ok: true });
	return { h, runId, agents, p };
}

/** Places and prepares one attempt as the extension does; returns its spawn key and the notes the call carried. */
async function start(run: Run, laneName: string, dispatch: string): Promise<{ spawnKey: string; notes: string[] | undefined }> {
	const { h, runId, agents, p } = run;
	const lane = p.lanes.find(candidate => candidate.name === laneName)!;
	const lanes = h.controller.runLanes()!;
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const needed = new Set(p.lanes.flatMap(candidate => (candidate.dependsOn ?? []).map(dependency => dependency.lane)));
	const readiness = needed.size === 0 ? undefined : await h.controller.laneReadiness(p, needed);
	// R4: manual planned items are keyed by their lane's own name.
	const spawnKey = laneName;
	const bound = lanes.place({ name: laneName, agent, task: "do the lane" }, p, h.config, readiness === undefined ? {} : { readiness });
	if (!bound.ok) throw new Error(bound.reason);
	const admission = lanes.admitChecked({ spawnKey, agent, outcome: "routed" }, { plan: p, config: h.config });
	if (!admission.ok) throw new Error(admission.reason);
	agents.push(agentEntry({ id: spawnKey, name: agent, role: lane.role, state: "running", requests: 1, lastActivityAt: T0 + 1 }));
	expect(await h.controller.prepareAttempt({
		runId, lane: laneName, spawnKey, parentId: "main", dispatch, followUp: false, artifactMode: "shared", startedAt: T0,
	})).toEqual({ ok: true });
	return { spawnKey, notes: bound.notes };
}

async function finish(run: Run, laneName: string, spawnKey: string, dispatch: string): Promise<void> {
	const { h, runId, agents } = run;
	const entry = agents.find(candidate => candidate.id === spawnKey);
	if (entry !== undefined) entry.state = "idle";
	await h.controller.settleAttempt({
		runId, lane: laneName, spawnKey, parentId: "main", dispatch, startedAt: T0, observedAt: T0 + 2,
		report: report({ runId, spawnKey, attemptId: `job:${dispatch}:${spawnKey}` }),
		citations: [],
	});
	h.controller.runLanes()?.releaseAgent(spawnKey);
}

async function complete(run: Run, laneName: string, dispatch: string, file: string, content: string): Promise<string> {
	const { spawnKey } = await start(run, laneName, dispatch);
	await writeFile(path.join(root, file), content);
	await finish(run, laneName, spawnKey, dispatch);
	return spawnKey;
}

const row = (run: Run, id: string): RunResult | undefined => run.h.controller.active()?.results?.find(item => item.id === id);

describe("a consumer that starts before its prerequisite has any submission", () => {
	test("the call says so, the input is recorded as missing, and the consumer's result is not accepted, now or after the prerequisite lands", async () => {
		const run = await begin(plan());
		const { spawnKey, notes } = await start(run, "a-consume", "a1");
		// The call that started it carries what state the prerequisite is in and what that means for the work.
		expect(notes).toHaveLength(1);
		expect(notes![0]).toContain("'a-consume' 레인은 선행 'b-produce' 레인의");
		expect(notes![0]).toContain("수용되지 않습니다");
		// The input is bound as missing at the moment of the start.
		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await finish(run, "a-consume", spawnKey, "a1");
		const early = row(run, "a-result");
		expect(early?.state).not.toBe("accepted");
		expect(early?.consumed).toEqual([{ id: "b-result", version: "missing" }]);

		// The producer lands later: nothing revives the consumer's earlier evidence.
		await complete(run, "b-produce", "b1", "b.txt", "version: b1\n");
		expect(row(run, "b-result")).toMatchObject({ state: "accepted" });
		expect(row(run, "a-result")?.state).not.toBe("accepted");

		// Rerunning the consumer on the accepted input is what accepts it, bound to the producer's real version.
		await complete(run, "a-consume", "a2", "a.txt", "result: accepted\nsecond: yes\n");
		expect(row(run, "a-result")).toMatchObject({ state: "accepted", consumed: [{ id: "b-result", version: row(run, "b-result")?.contentVersion }] });
	});

	test("a producer that is accepted while the consumer runs makes the consumer's success unmet, not accepted", async () => {
		const run = await begin(plan());
		const { spawnKey } = await start(run, "a-consume", "a1");
		await complete(run, "b-produce", "b1", "b.txt", "version: b1\n");
		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await finish(run, "a-consume", spawnKey, "a1");
		expect(row(run, "b-result")).toMatchObject({ state: "accepted" });
		expect(row(run, "a-result")).toMatchObject({ state: "unmet" });
		expect(row(run, "a-result")?.reason).toContain("선행 결과가");
		expect(row(run, "a-result")?.contentVersion).toBeUndefined();
	});
});

describe("a consumer that starts while its accepted prerequisite runs again", () => {
	test("the call says the result reopens if the prerequisite changes; the row stands while it does not and reopens when it does", async () => {
		const run = await begin(plan());
		await complete(run, "b-produce", "b1", "b.txt", "version: b1\n");
		const v1 = row(run, "b-result")?.contentVersion;
		expect(v1).toBeDefined();

		// The producer runs again; the consumer starts from the accepted row it has.
		const rerun = await start(run, "b-produce", "b2");
		const { spawnKey, notes } = await start(run, "a-consume", "a1");
		expect(notes).toHaveLength(1);
		expect(notes![0]).toContain("아직 실행 중");
		expect(notes![0]).toContain("다시 열립니다");
		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await finish(run, "a-consume", spawnKey, "a1");
		expect(row(run, "a-result")).toMatchObject({ state: "accepted", consumed: [{ id: "b-result", version: v1 }] });

		// The producer's rerun changes its content: the consumer's evidence no longer stands.
		await writeFile(path.join(root, "b.txt"), "version: b2\n");
		await finish(run, "b-produce", rerun.spawnKey, "b2");
		expect(row(run, "b-result")?.contentVersion).not.toBe(v1);
		expect(row(run, "a-result")).toMatchObject({ state: "unmet", origin: "plan" });
		expect(row(run, "a-result")?.contentVersion).toBeUndefined();
	});
});

describe("a prerequisite that was judged unmet is told apart from one that was accepted and lost its location", () => {
	test("judged unmet, never accepted: the readiness view carries no standing version, the consumer starts with its note and records the input as missing", async () => {
		const run = await begin(plan());
		// The producer delivers a file that does not hold what its result requires: the row is unmet (it never stood accepted).
		await complete(run, "b-produce", "b1", "b.txt", "nothing useful\n");
		expect(row(run, "b-result")?.state).toBe("unmet");
		const view = await run.h.controller.laneReadiness(run.p, new Set(["b-produce"]));
		const result = view.get("b-produce")!.results[0]!;
		expect(result.state).toBe("unmet");
		expect(result.standingVersion).toBeUndefined();
		expect(dependencyStart(run.p.lanes[1] as PlanLane, view).ok).toBe(true);
		// Through the real placement: the call starts and says so; its result binds the input as missing.
		const { spawnKey, notes } = await start(run, "a-consume", "a1");
		expect(notes?.[0]).toContain("수용되지 않습니다");
		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await finish(run, "a-consume", spawnKey, "a1");
		expect(row(run, "a-result")?.state).not.toBe("accepted");
		expect(row(run, "a-result")?.consumed).toEqual([{ id: "b-result", version: "missing" }]);
	});

	test("accepted and then its location no longer holds: the row stands with a version a consumer would bind, so the start stays refused", async () => {
		const run = await begin(plan("integrated"));
		await complete(run, "b-produce", "b1", "b.txt", "version: b1\n");
		expect(row(run, "b-result")?.state).toBe("accepted");
		// The shared tree stops carrying the accepted file (a revert); the ledger row still says accepted.
		await rm(path.join(root, "b.txt"));
		const view = await run.h.controller.laneReadiness(run.p, new Set(["b-produce"]));
		const result = view.get("b-produce")!.results[0]!;
		expect(row(run, "b-result")?.state).toBe("accepted");
		expect(result.state).toBe("unmet");
		expect(result.standingVersion).toBe(true);
		expect(dependencyStart(run.p.lanes[1] as PlanLane, view).ok).toBe(false);
	});
});

describe("what the record cannot tie keeps the refusal", () => {
	test("an `integrated` edge on a result the parent does not carry: the consumer would bind a real version and nothing reopens it", () => {
		const p = plan("integrated");
		const rows: RunResult[] = [
			{ id: "b-result", state: "accepted", contentVersion: "v1", attemptId: "job:b" },
			{ id: "a-result", state: "accepted", contentVersion: "va", attemptId: "job:a", consumed: [{ id: "b-result", version: "v1" }] },
		];
		// The ledger rows alone call this consistent: the producer is accepted at the version the consumer started from,
		// whether or not the tree ever carried it. That is why the start is refused instead of recorded.
		expect([...staleRequirementIdsForPlan(rows, p)]).toEqual([]);
		const consumer = p.lanes[1] as PlanLane;
		const readiness = new Map([
			["b-produce", { results: [{ id: "b-result", kind: "change" as const, state: "accepted" as const, integrated: false, version: "v1" }], settled: true, integrated: false, running: false }],
		]);
		const start = dependencyStart(consumer, readiness);
		expect(start.ok).toBe(false);
	});

	test("a reviewable prerequisite on a `result` edge: the record reopens the consumer at once, so the start is allowed", () => {
		const p = plan("result");
		const rows: RunResult[] = [
			{ id: "b-result", state: "reviewable", contentVersion: "v1", attemptId: "job:b" },
			{ id: "a-result", state: "accepted", contentVersion: "va", attemptId: "job:a", consumed: [{ id: "b-result", version: "v1" }] },
		];
		expect([...staleRequirementIdsForPlan(rows, p)]).toEqual(["a-result"]);
		const readiness = new Map([
			["b-produce", { results: [{ id: "b-result", kind: "change" as const, state: "reviewable" as const, integrated: false, version: "v1" }], settled: true, integrated: false, running: false }],
		]);
		expect(dependencyStart(p.lanes[1] as PlanLane, readiness).ok).toBe(true);
	});
});
