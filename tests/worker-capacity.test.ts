import { beforeEach, describe, expect, test } from "bun:test";
import {
	activeAgents,
	decideSpawn,
	releaseWorkerSlot,
	reserveWorkerSlot,
	reservedWorkers,
	resetWorkerSlots,
	workerSlot,
} from "../src/policy/spawn.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { deliveredFollowUp, followUpProgress } from "../src/policy/followup.ts";
import { laneRouteFingerprint, plannedTaskLanes, replanConflict, RunLanes } from "../src/runtime/lanes.ts";
import type { ApprovalRecord, ConfigLoad, PlanLane, RunPlan, SpawnEvent, SpawnOutcome, SpawnRuntime, StormConfig } from "../src/types.ts";
import { agentEntry, approvalRecord, spawnRecord, teamOf } from "./fixtures.ts";

const NOW = Date.parse("2026-11-24T00:00:00.000Z");
const HASH = `jcs-sha256:${"cd34".repeat(16)}`;
const RUN = "run-capacity";
const team: StormConfig = teamOf(
	{
		implementer: { models: ["a/i"], workers: { min: 1, max: 2 } },
		explorer: { models: ["a/e"], workers: { min: 2, max: 4 } },
		quick: { models: ["a/q"], workers: { min: 1, max: 2 } },
	},
	{ isolation: "shared" },
);
const approval: ApprovalRecord = approvalRecord(HASH, { repoId: "git-r-000000000000000000000000" });
const load: Extract<ConfigLoad, { status: "ok" }> = {
	status: "ok",
	path: "/r/.omp/storm/config.json",
	config: team,
	hash: HASH,
	warnings: [],
};
const plan = (workers: RunPlan["workers"] = { implementer: 1, explorer: 1 }): RunPlan => ({
	lanes: [
		{ name: "build", kind: "code", role: "implementer" },
		{ name: "look", kind: "explore", role: "explorer" },
	],
	workers,
	submittedAt: "2026-11-23T00:00:00.000Z",
});
const event = (agent: string, spawnKey: string): SpawnEvent => ({ agent, invocationKind: "task", patterns: [], spawnKey });
const runtime = (runPlan: RunPlan, over: Partial<SpawnRuntime> = {}): SpawnRuntime => ({
	now: NOW,
	quotaMarks: [],
	trials: {},
	run: {
		runId: RUN,
		costUsd: 0,
		plan: runPlan,
		active: activeAgents([], [], NOW, reservedWorkers(RUN)),
	},
	...over,
});
const codeOf = (outcome: SpawnOutcome): string | undefined =>
	outcome.decision !== undefined && "block" in outcome.decision ? /^\[storm:([a-z-]+)\] /.exec(outcome.decision.reason)?.[1] : undefined;

beforeEach(() => resetWorkerSlots());

describe("one authoritative worker accounting", () => {
	test("a reservation counts before the host row and does not expire on a timer", () => {
		reserveWorkerSlot({ runId: RUN, key: "Impl", role: "implementer", now: NOW });
		expect(workerSlot(RUN, "Impl")).toMatchObject({ key: "Impl", role: "implementer" });
		// Far past PENDING_SPAWN_MS: the host has not shown an agent row, but the admission is still live.
		expect(activeAgents([], [], NOW + 86_400_000, reservedWorkers(RUN))).toEqual({ total: 1, byRole: { implementer: 1 } });
		releaseWorkerSlot(RUN, "Impl");
		expect(workerSlot(RUN, "Impl")).toBeUndefined();
		expect(activeAgents([], [], NOW + 86_400_000, reservedWorkers(RUN))).toEqual({ total: 0, byRole: {} });
		// A spawn record with no reservation is not kept alive by the legacy pending window when an authority is given.
		const ghost = spawnRecord({ spawnKey: "Ghost", ts: new Date(NOW - 120_000).toISOString() });
		expect(activeAgents([ghost], [], NOW, [])).toEqual({ total: 0, byRole: {} });
	});

	test("a reservation, its running row, and its spawn record are one slot, not three", () => {
		reserveWorkerSlot({ runId: RUN, key: "Impl", role: "implementer", now: NOW });
		const running = agentEntry({ id: "Impl", state: "running" });
		const record = spawnRecord({ spawnKey: "Impl", role: "implementer" });
		expect(activeAgents([record], [running], NOW, reservedWorkers(RUN))).toEqual({ total: 1, byRole: { implementer: 1 } });
		// A reused running worker with no current spawn row is still one worker.
		expect(activeAgents([], [running], NOW, [])).toEqual({ total: 1, byRole: { implementer: 1 } });
		// Re-reserving the same key is not a second slot.
		reserveWorkerSlot({ runId: RUN, key: "Impl", role: "implementer", now: NOW + 1 });
		expect(reservedWorkers(RUN)).toHaveLength(1);
	});

	test("a failed start and a settled worker both release; no timer does", () => {
		const lanes = new RunLanes(RUN);
		reserveWorkerSlot({ runId: RUN, key: "Impl", role: "implementer", now: NOW });
		lanes.cancel("Impl");
		expect(workerSlot(RUN, "Impl")).toBeUndefined();
		reserveWorkerSlot({ runId: RUN, key: "Impl", role: "implementer", now: NOW });
		lanes.releaseAgent("Impl");
		expect(workerSlot(RUN, "Impl")).toBeUndefined();
	});

	test("total saturation blocks a fresh start and release lets the same spawn retry", () => {
		reserveWorkerSlot({ runId: RUN, key: "Scout", role: "explorer", now: NOW });
		const full = runtime(plan(), {
			maxConcurrency: 1,
			run: { ...runtime(plan()).run!, active: activeAgents([], [], NOW, reservedWorkers(RUN)) },
		});
		expect(codeOf(decideSpawn(event("storm-implementer", "Impl"), { config: load, approval, shadows: [] }, full))).toBe("parallelism");
		releaseWorkerSlot(RUN, "Scout");
		expect(codeOf(decideSpawn(event("storm-implementer", "Impl"), { config: load, approval, shadows: [] }, runtime(plan(), { maxConcurrency: 1 })))).toBeUndefined();
	});

	test("OMP 0 is unlimited, and an absent host ceiling adds no Storm default", () => {
		reserveWorkerSlot({ runId: RUN, key: "Scout", role: "explorer", now: NOW });
		const busy = { run: { ...runtime(plan()).run!, active: activeAgents([], [], NOW, reservedWorkers(RUN)) } };
		expect(codeOf(decideSpawn(event("storm-implementer", "Impl"), { config: load, approval, shadows: [] }, runtime(plan(), busy)))).toBeUndefined();
		expect(codeOf(decideSpawn(event("storm-implementer", "Impl"), { config: load, approval, shadows: [] }, runtime(plan(), { ...busy, maxConcurrency: 0 })))).toBeUndefined();
		releaseWorkerSlot(RUN, "Scout");
	});

	test("role saturation blocks a fresh start and release lets it retry", () => {
		reserveWorkerSlot({ runId: RUN, key: "Impl", role: "implementer", now: NOW });
		const full = runtime(plan(), { run: { ...runtime(plan()).run!, active: activeAgents([], [], NOW, reservedWorkers(RUN)) } });
		expect(codeOf(decideSpawn(event("storm-implementer", "Impl2"), { config: load, approval, shadows: [] }, full))).toBe("role-cap");
		releaseWorkerSlot(RUN, "Impl");
		expect(codeOf(decideSpawn(event("storm-implementer", "Impl2"), { config: load, approval, shadows: [] }, runtime(plan())))).toBeUndefined();
	});
});

describe("reactivations use the same slots as fresh starts", () => {
	const work = (): RunLanes => new RunLanes(RUN);
	const follow = (lanes: RunLanes, id: string, agents = [agentEntry({ id, state: "idle" })], over: Partial<RunPlan> = {}) => {
		const runPlan = { ...plan(), ...over };
		const lane = runPlan.lanes.find(candidate => candidate.role === "implementer")!;
		return lanes.checkFollowUp({
			runId: RUN,
			agentId: id,
			agent: "storm-implementer",
			role: "implementer",
			lane,
			plan: runPlan,
			config: team,
			isolated: false,
			agents,
			now: NOW,
		});
	};

	test("an idle worker's first new turn takes a slot; a second note does not add one", () => {
		const lanes = work();
		const first = follow(lanes, "Impl");
		expect(first.ok && first.reserved).toBe(true);
		if (first.ok) lanes.finishFollowUp(first.token, true);
		expect(activeAgents([], [agentEntry({ id: "Impl", state: "idle" })], NOW, reservedWorkers(RUN))).toEqual({
			total: 1,
			byRole: { implementer: 1 },
		});
		const again = follow(lanes, "Impl");
		expect(again.ok).toBe(true);
		if (again.ok) {
			expect(again.reserved).toBeUndefined();
			lanes.finishFollowUp(again.token, true);
		}
		expect(reservedWorkers(RUN)).toHaveLength(1);
	});

	test("role saturation blocks a reactivation, while a running worker stays one slot", () => {
		const lanes = work();
		const occupied = follow(lanes, "Impl");
		expect(occupied.ok).toBe(true);
		if (occupied.ok) lanes.finishFollowUp(occupied.token, true);
		const blocked = follow(lanes, "Other", [agentEntry({ id: "Other", state: "idle" })]);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) {
			expect(blocked.code).toBe("lane-capacity");
			expect(blocked.retry).toBe(true);
		}
		// A note to the already running worker is not another slot and is not refused by the cap.
		const running = [agentEntry({ id: "Impl", state: "running" })];
		const note = follow(lanes, "Impl", running);
		expect(note.ok).toBe(true);
		if (note.ok) {
			expect(note.reserved).toBeUndefined();
			lanes.finishFollowUp(note.token, true);
		}
		expect(activeAgents([], running, NOW, reservedWorkers(RUN))).toEqual({ total: 1, byRole: { implementer: 1 } });
	});

	test("total saturation blocks a reactivation too, and release lets it retry", () => {
		const lanes = work();
		const runPlan = plan();
		const build = runPlan.lanes.find(candidate => candidate.role === "implementer")!;
		reserveWorkerSlot({ runId: RUN, key: "Scout", role: "explorer", now: NOW });
		const blocked = lanes.checkFollowUp({
			runId: RUN,
			agentId: "Impl",
			agent: "storm-implementer",
			role: "implementer",
			lane: build,
			plan: runPlan,
			config: team,
			maxConcurrency: 1,
			isolated: false,
			agents: [agentEntry({ id: "Impl", state: "idle" })],
			now: NOW,
		});
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) {
			expect(blocked.code).toBe("lane-capacity");
			expect(blocked.reason).toContain("task.maxConcurrency 1");
			expect(blocked.retry).toBe(true);
		}
		releaseWorkerSlot(RUN, "Scout");
		const retry = lanes.checkFollowUp({
			runId: RUN,
			agentId: "Impl",
			agent: "storm-implementer",
			role: "implementer",
			lane: build,
			plan: runPlan,
			config: team,
			maxConcurrency: 1,
			isolated: false,
			agents: [agentEntry({ id: "Impl", state: "idle" })],
			now: NOW,
		});
		expect(retry.ok && retry.reserved).toBe(true);
	});

	test("a reactivation respects OMP 0 as unlimited and counts an observed non-Storm running worker once", () => {
		const lanes = work();
		const runPlan = plan();
		const build = runPlan.lanes.find(candidate => candidate.role === "implementer")!;
		const gate = (maxConcurrency: number) => lanes.checkFollowUp({
			runId: RUN,
			agentId: "Impl",
			agent: "storm-implementer",
			role: "implementer",
			lane: build,
			plan: runPlan,
			config: team,
			maxConcurrency,
			isolated: false,
			agents: [agentEntry({ id: "Impl", state: "idle" })],
			otherActive: 1,
			now: NOW,
		});
		const blocked = gate(1);
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) {
			expect(blocked.code).toBe("lane-capacity");
			expect(blocked.reason).toContain("task.maxConcurrency 1");
		}
		expect(gate(0).ok).toBe(true);
		// A work-bearing note to an already running worker never checks the ceiling or takes a second slot.
		const running = [agentEntry({ id: "Impl", state: "running" })];
		expect(lanes.checkFollowUp({
			runId: RUN,
			agentId: "Impl",
			agent: "storm-implementer",
			role: "implementer",
			lane: build,
			plan: runPlan,
			config: team,
			maxConcurrency: 1,
			isolated: false,
			agents: running,
			otherActive: 1,
			now: NOW,
		}).ok).toBe(true);
	});

	test("a refused preflight releases a slot it created, so the retry can start", () => {
		const lanes = work();
		const first = follow(lanes, "Impl");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// The delivery failed after preflight: the slot this call created must not block the retry.
		lanes.finishFollowUp(first.token, false);
		expect(reservedWorkers(RUN)).toHaveLength(0);
		const retry = follow(lanes, "Impl");
		expect(retry.ok && retry.reserved).toBe(true);
		if (retry.ok) lanes.finishFollowUp(retry.token, true);
	});

	test("a progress note is never a follow-up and never reserves", () => {
		expect(followUpProgress("write", { path: "agent://Impl?progress" })).toBe(true);
		expect(deliveredFollowUp("write", { path: "agent://Impl?progress" }, false)).toBeUndefined();
		expect(deliveredFollowUp("write", { path: "agent://Impl" }, false)).toBe("Impl");
	});
});

describe("job lanes are never AI worker targets", () => {
	const job: PlanLane = { name: "bench", kind: "run", role: "quick", job: "bench" };
	const worker: PlanLane = { name: "quick-work", kind: "run", role: "quick" };
	const jobPlan: RunPlan = { lanes: [job, worker], workers: { quick: 1 }, submittedAt: "2026-11-23T00:00:00.000Z" };

	test("native task matching skips the job lane but can still use a distinct quick worker lane", () => {
		const resolved = plannedTaskLanes({ agent: "storm-quick", name: "bench", task: "Run" }, jobPlan, team);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) expect(resolved.reason).toContain("정형 작업");
		const lane = plannedTaskLanes({ agent: "storm-quick", task: "Work" }, jobPlan, team);
		expect(lane.ok).toBe(true);
		if (lane.ok) expect(lane.lanes[0]?.name).toBe("quick-work");
		const work = new RunLanes(RUN);
		expect(work.place({ agent: "storm-quick", name: "bench", task: "Run" }, jobPlan, team).ok).toBe(false);
	});

	test("IRC reuse cannot bind to a job lane; job identity changes the route and replan", () => {
		const lanes = new RunLanes(RUN);
		const follow = lanes.checkFollowUp({
			runId: RUN,
			agentId: "Bench",
			agent: "storm-quick",
			role: "quick",
			lane: job,
			plan: jobPlan,
			config: team,
			isolated: false,
			agents: [agentEntry({ id: "Bench", role: "quick", state: "idle" })],
			now: NOW,
		});
		expect(follow.ok).toBe(false);
		if (!follow.ok) expect(follow.code).toBe("lane-job");
		expect(reservedWorkers(RUN)).toHaveLength(0);
		expect(laneRouteFingerprint(job)).not.toBe(laneRouteFingerprint({ ...job, job: "other" }));
		expect(replanConflict(jobPlan, { ...jobPlan, lanes: [{ ...job, job: "other" }, worker] })).toContain("job");
	});

	test("an omitted worker count follows actual worker lanes, ignores job lanes, and keeps explicit lower counts", () => {
		const jobTeam: StormConfig = teamOf(
			{ explorer: { models: ["a/e"], workers: { min: 2, max: 4 } }, quick: { models: ["a/q"], workers: { min: 1, max: 2 } } },
			{ jobs: [{ name: "bench", argv: ["true"] }] },
		);
		const checked = validatePlan(
			jobTeam,
			{
				lanes: [
					{ name: "look", kind: "explore", results: [{ id: "look", kind: "answer", criterion: "read the tree" }] },
					{
						name: "bench",
						kind: "run",
						job: "bench",
						results: [{ id: "bench-out", kind: "answer", criterion: "stdout shows ok", contains: "ok" }],
					},
				],
			},
			NOW,
		);
		expect(checked.errors).toEqual([]);
		expect(checked.plan?.workers).toEqual({ explorer: 1 });
		const lower = validatePlan(
			jobTeam,
			{
				lanes: [{ name: "look", kind: "explore", results: [{ id: "look", kind: "answer", criterion: "read the tree" }] }],
				workers: { explorer: 1 },
			},
			NOW,
		);
		expect(lower.plan?.workers).toEqual({ explorer: 1 });
	});
});
