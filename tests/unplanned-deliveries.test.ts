/**
 * Deliveries that answer no declared result (P1-a). The run used to drop them without a trace: a worker that a peer woke
 * answered and omp delivered it to the director, and Storm ignored it (probe C of the worker-messages report). Now the
 * collector hands each one to the port as a fact, once, and the controller keeps it in the record. None of it may
 * change a result row or count as acceptance.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AttemptCollector,
	type AttemptRegistry,
	type AttemptRegistryEvent,
	type AttemptRegistryRef,
	type AttemptSettlementPort,
	type AttemptUnplannedDelivery,
} from "../src/runtime/attempt-collector.ts";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { noteRunSpawn } from "../src/runtime/controller.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { UNPLANNED_MAX, unplannedLine, unplannedNotice } from "../src/runtime/unplanned.ts";
import type { PlanLane, PlanLaneResult, SpawnRecord } from "../src/types.ts";
import { fakeSession } from "./fake-session.ts";
import { agentEntry } from "./fixtures.ts";

class Registry implements AttemptRegistry {
	readonly refs = new Map<string, AttemptRegistryRef>();
	get(id: string): AttemptRegistryRef | undefined {
		return this.refs.get(id);
	}
	onChange(_listener: (event: AttemptRegistryEvent) => void): () => void {
		return () => undefined;
	}
}

interface Rig {
	collector: AttemptCollector;
	registry: Registry;
	settlements: AttemptSettlement[];
	unplanned: AttemptUnplannedDelivery[];
}

function rig(now = 1_000): Rig {
	const settlements: AttemptSettlement[] = [];
	const unplanned: AttemptUnplannedDelivery[] = [];
	const port: AttemptSettlementPort = {
		prepare: async () => ({ ok: true }),
		settle: async input => {
			settlements.push(input);
		},
		unplanned: input => {
			unplanned.push(input);
		},
	};
	const registry = new Registry();
	return { collector: new AttemptCollector({ port, registry: () => registry, now: () => now }), registry, settlements, unplanned };
}

const answer: PlanLaneResult = { id: "ans", kind: "answer", criterion: "the answer cites notes.md" };
const lane = (results?: PlanLaneResult[]): PlanLane => ({ name: "look", kind: "explore", role: "explorer", ...(results === undefined ? {} : { results }) });
const delivery = (jobId: string, agentId: string, status = "completed") => ({
	customType: "async-result",
	content: "done",
	details: { jobs: [{ jobId, agentId, status }] },
});

afterEach(() => {
	resetLedger();
	resetAgents();
});

describe("a delivery that answers no declared result is handed over, once", () => {
	test("a worker woken after its dispatch settled: the answer is a fact, the first settlement stands (probe C)", async () => {
		const r = rig();
		await r.collector.admitSpawn({ runId: "run-1", parentId: "Main", spawnKey: "look", lane: lane([answer]), artifactMode: "shared", startedAt: 1_000 });
		await r.collector.observeMessage({ runId: "run-1", parentId: "Main", observedAt: 1_200, message: delivery("look", "look"), jobs: [{ id: "look", agentId: "look", status: "completed", startTime: 1_000 }] });
		expect(r.settlements).toHaveLength(1);
		expect(r.unplanned).toEqual([]);

		// A peer wakes the worker: omp reuses the job id and the row carries the new turn's start.
		r.registry.refs.set("look", { id: "look", parentId: "Main", session: null });
		await r.collector.observeMessage({ runId: "run-1", parentId: "Main", observedAt: 3_000, message: delivery("look", "look"), jobs: [{ id: "look", agentId: "look", status: "completed", startTime: 2_500 }] });
		expect(r.settlements).toHaveLength(1);
		expect(r.unplanned).toHaveLength(1);
		expect(r.unplanned[0]).toMatchObject({ runId: "run-1", kind: "woken", agent: "look", lane: "look", parentId: "Main", startedAt: 2_500, endedAt: 3_000, status: "completed" });
	});

	test("the same delivery again, by the second of two paths or as a replay, is recorded once", async () => {
		const r = rig();
		await r.collector.admitSpawn({ runId: "run-1", parentId: "Main", spawnKey: "look", lane: lane([answer]), artifactMode: "shared", startedAt: 1_000 });
		await r.collector.observeMessage({ runId: "run-1", parentId: "Main", observedAt: 1_200, message: delivery("look", "look"), jobs: [{ id: "look", agentId: "look", status: "completed", startTime: 1_000 }] });
		const woken = { runId: "run-1", parentId: "Main", observedAt: 3_000, message: delivery("look", "look"), jobs: [{ id: "look", agentId: "look", status: "completed" as const, startTime: 2_500 }] };
		await r.collector.observeMessage(woken);
		await r.collector.observeMessage(woken);
		// The first turn's message delivered again: its job started before the delivery already seen.
		await r.collector.observeMessage({ runId: "run-1", parentId: "Main", observedAt: 3_500, message: delivery("look", "look"), jobs: [{ id: "look", agentId: "look", status: "completed", startTime: 1_000 }] });
		expect(r.unplanned).toHaveLength(1);
	});

	test("a worker no dispatch of the run waits for (a lane without declared results) is recorded as unplaced", async () => {
		const r = rig();
		await r.collector.admitSpawn({ runId: "run-1", parentId: "Main", spawnKey: "scout", lane: lane(), artifactMode: "shared", startedAt: 1_000 });
		r.registry.refs.set("scout", { id: "scout", parentId: "Main", session: null });
		await r.collector.observeMessage({ runId: "run-1", parentId: "Main", observedAt: 1_400, message: delivery("job_9", "scout", "failed"), jobs: [] });
		expect(r.settlements).toEqual([]);
		expect(r.unplanned).toHaveLength(1);
		expect(r.unplanned[0]).toMatchObject({ kind: "unplaced", agent: "scout", status: "failed", endedAt: 1_400 });
		expect(r.unplanned[0]?.id).toBe("job:job_9:scout");
	});

	test("a child of a child is attributed to its own parent, not to the director", async () => {
		const r = rig();
		r.registry.refs.set("grand", { id: "grand", parentId: "worker-1", session: null });
		await r.collector.observeMessage({ runId: "run-1", parentId: "Main", observedAt: 1_400, message: delivery("job_1", "grand"), jobs: [] });
		expect(r.unplanned[0]).toMatchObject({ agent: "grand", parentId: "worker-1", receiverId: "Main" });
	});

	test("a delivery of an earlier run's worker answers nothing in this run", async () => {
		const r = rig();
		await r.collector.admitSpawn({ runId: "run-1", parentId: "Main", spawnKey: "look", lane: lane([answer]), artifactMode: "shared", startedAt: 1_000 });
		await r.collector.observeMessage({ runId: "run-2", parentId: "Main", observedAt: 1_400, message: delivery("look", "look"), jobs: [] });
		expect(r.settlements).toEqual([]);
		expect(r.unplanned[0]).toMatchObject({ runId: "run-2", kind: "unplaced" });
	});

	test("a synchronous task result for a child the run has no dispatch for carries its own price", async () => {
		const r = rig();
		await r.collector.observeTaskResult({
			runId: "run-1",
			parentId: "Main",
			toolCallId: "call_1",
			observedAt: 5_000,
			details: { results: [{ id: "free", exitCode: 0, durationMs: 800, usage: { cost: { total: 0.25 } } }] },
		});
		expect(r.unplanned).toHaveLength(1);
		expect(r.unplanned[0]).toMatchObject({ id: "task:call_1:free", kind: "unplaced", agent: "free", status: "completed", costUsd: 0.25, startedAt: 4_200, endedAt: 5_000 });
	});

	test("a result row a wait hands over for an untracked worker is recorded; an empty aggregate row is not", async () => {
		const r = rig();
		const wait = {
			op: "wait",
			jobs: [
				{ type: "task", id: "job_a", agentUrlId: "peer", status: "completed", resultText: "ok", settledAtMs: 7_000, durationMs: 500 },
				{ type: "task", id: "job_b", agentUrlId: "other", status: "completed", settledAtMs: 7_000, durationMs: 500 },
			],
		};
		await r.collector.observeWaitResult({ runId: "run-1", parentId: "Main", details: wait, observedAt: 7_100 });
		expect(r.unplanned.map(item => item.agent)).toEqual(["peer"]);
		expect(r.unplanned[0]).toMatchObject({ startedAt: 6_500, endedAt: 7_000 });
	});

	test("a port without the method changes nothing", async () => {
		const settlements: AttemptSettlement[] = [];
		const collector = new AttemptCollector({
			port: { prepare: async () => ({ ok: true }), settle: async input => void settlements.push(input) },
			registry: () => new Registry(),
		});
		await collector.observeMessage({ runId: "run-1", parentId: "Main", observedAt: 1, message: delivery("j", "x"), jobs: [] });
		expect(settlements).toEqual([]);
	});
});

describe("the controller keeps them in the run record and tells the director once", () => {
	let root: string;
	const make = async () => {
		root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-unplanned-")));
		return fakeSession({ root, agents: [agentEntry({ id: "peer", name: "storm-implementer", role: "implementer", costUsd: 0.4, changes: 1, lastChangeAt: 9_000, requests: 2 })] });
	};
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const input = (over: Partial<AttemptUnplannedDelivery> = {}): AttemptUnplannedDelivery => ({
		runId: "",
		id: "job:j1:peer",
		kind: "woken",
		agent: "peer",
		receiverId: "Main",
		startedAt: 8_000,
		endedAt: 10_000,
		status: "completed",
		...over,
	});

	test("one entry per delivery, one notice line, no result row touched", async () => {
		const h = await make();
		const runId = await h.start({ task: "t" });
		const before = JSON.stringify(h.controller.active()?.results ?? []);
		h.controller.noteUnplannedDelivery(input({ runId }));
		h.controller.noteUnplannedDelivery(input({ runId }));
		const run = h.controller.active();
		expect(run?.unplanned).toHaveLength(1);
		expect(run?.unplanned?.[0]).toMatchObject({ id: "job:j1:peer", kind: "woken", agent: "peer", parentId: "Main", agentCostUsd: 0.4, changed: true, startedAt: 8_000, endedAt: 10_000 });
		expect(run?.unplannedCount).toBe(1);
		expect(JSON.stringify(run?.results ?? [])).toBe(before);
		const notice = h.controller.takeNotices();
		expect(notice).toBe(unplannedNotice({ agent: "peer", kind: "woken" }));
		expect(notice?.split("\n")).toHaveLength(1);
		expect(h.controller.takeNotices()).toBeUndefined();
		await h.controller.finish("shutdown");
	});

	test("a delivery Storm asked for is not one nobody planned: a worker placed in a lane delivers once, and once more per follow-up the director sent it; a refused spawn delivers its refusal", async () => {
		const h = await make();
		const runId = await h.start({ task: "t" });
		const spawn = (spawnKey: string, over: Partial<SpawnRecord>): SpawnRecord => ({ ts: new Date(1).toISOString(), agent: "storm-reviewer", invocationKind: "task", requested: [], outcome: "routed", spawnKey, ...over });
		noteRunSpawn(runId, spawn("peer", { lane: "review" }));
		noteRunSpawn(runId, spawn("refused", { outcome: "blocked", code: "unapproved" }));
		const arrive = (agent: string, n: number) => h.controller.noteUnplannedDelivery(input({ runId, kind: "unplaced", agent, id: `job:j${n}:${agent}`, startedAt: 8_000 + n }));
		// The worker `peer` (the fixture agent has one follow-up of its own below): its first delivery, and the refused spawn's, are expected.
		arrive("peer", 1);
		arrive("refused", 1);
		expect(h.controller.active()?.unplanned).toBeUndefined();
		expect(h.controller.takeNotices()).toBeUndefined();
		// Someone else woke it: the second delivery with no follow-up behind it is recorded and told. A worker with no spawn row always is.
		arrive("peer", 2);
		arrive("stranger", 1);
		expect(h.controller.active()?.unplanned?.map(item => item.agent)).toEqual(["peer", "stranger"]);
		await h.controller.finish("shutdown");
	});

	// R-final N9: a work message omp folded into a turn that was already open starts none, so it makes no delivery expected.
	test("each follow-up that started a turn of a lane-bound worker makes one more delivery expected; a message folded into the open turn makes none", async () => {
		root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-unplanned-")));
		// Three work messages were sent (followUps: 3, what the report counts); two of them woke a turn.
		const h = fakeSession({ root, agents: [agentEntry({ id: "rev", name: "storm-reviewer", role: "reviewer", followUps: 3, requests: 3 })] });
		const runId = await h.start({ task: "t" });
		noteRunSpawn(runId, { ts: new Date(1).toISOString(), agent: "storm-reviewer", invocationKind: "task", requested: [], outcome: "routed", spawnKey: "rev", lane: "review" });
		h.controller.noteWakingFollowUp(runId, "rev");
		h.controller.noteWakingFollowUp(runId, "rev");
		h.controller.noteWakingFollowUp("run-other", "rev");
		for (const n of [1, 2, 3]) h.controller.noteUnplannedDelivery(input({ runId, kind: "unplaced", agent: "rev", id: `job:j${n}:rev` }));
		expect(h.controller.active()?.unplanned).toBeUndefined();
		h.controller.noteUnplannedDelivery(input({ runId, kind: "unplaced", agent: "rev", id: "job:j4:rev" }));
		expect(h.controller.active()?.unplanned?.map(item => item.id)).toEqual(["job:j4:rev"]);
		await h.controller.finish("shutdown");
	});

	test("a delivery of another run, or with no run, is ignored", async () => {
		const h = await make();
		const runId = await h.start({ task: "t" });
		h.controller.noteUnplannedDelivery(input({ runId: "run-other" }));
		expect(h.controller.active()?.unplanned).toBeUndefined();
		expect(h.controller.takeNotices()).toBeUndefined();
		await h.controller.finish("shutdown");
		h.controller.noteUnplannedDelivery(input({ runId }));
		expect(h.controller.takeNotices()).toBeUndefined();
	});

	test("the list is bounded and the count keeps what it cut; the finished record carries both", async () => {
		const h = await make();
		const runId = await h.start({ task: "t" });
		for (let i = 0; i < UNPLANNED_MAX + 5; i++) h.controller.noteUnplannedDelivery(input({ runId, id: `job:j${i}:peer`, endedAt: 10_000 + i }));
		const live = h.controller.active();
		expect(live?.unplanned).toHaveLength(UNPLANNED_MAX);
		expect(live?.unplanned?.[0]?.id).toBe("job:j5:peer");
		expect(live?.unplannedCount).toBe(UNPLANNED_MAX + 5);
		const done = await h.controller.finish("shutdown");
		expect(done?.unplanned).toHaveLength(UNPLANNED_MAX);
		expect(done?.unplannedCount).toBe(UNPLANNED_MAX + 5);
		expect(unplannedLine(done!)).toContain(String(UNPLANNED_MAX + 5));
	});
});
