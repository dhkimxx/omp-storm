/**
 * Finalization evidence for S1/S3: a verified close waits for an in-flight settlement, re-locates accepted machines
 * evidence (shared change, retained artifact) at the gate, keeps an answer's own proof, and leaves an independent
 * accepted result alone when another result vanishes.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import type { AgentEntry, PlanLane, RunPlan } from "../src/types.ts";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetAgents } from "../src/runtime/agents.ts";
import { dependencyBlock, type LaneReadinessView, type LaneResultReadiness } from "../src/runtime/lanes.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { treeFingerprint } from "../src/runtime/rounds.ts";
import { readRun } from "../src/runtime/run.ts";
import type { TreeReading } from "../src/runtime/tree.ts";
import { fakeSession, until, type FakeSession } from "./fake-session.ts";
import { agentEntry, treeOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const REPORT = "report.json";

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-finalization-")));
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (agents: AgentEntry[] = [], tree?: () => TreeReading) =>
	fakeSession({ root, agents, ...(tree === undefined ? {} : { tree }) });

function planFor(lanes: RunPlan["lanes"], workers: Record<string, number>): RunPlan {
	return { lanes, workers, submittedAt: new Date(T0).toISOString() };
}

function report(over: Partial<AttemptReport> & Pick<AttemptReport, "runId" | "spawnKey" | "attemptId">): AttemptReport {
	return {
		schema: "storm.attempt-report/v1",
		parentId: "main",
		outcome: "success",
		capture: "observed",
		observedAt: T0 + 1,
		version: "unknown",
		artifacts: [],
		observations: [],
		...over,
	};
}

/** Admits a planned lane the way the extension does, with an idle agent the run's ledger can see. */
function admit(h: FakeSession, plan: RunPlan, agents: AgentEntry[], laneName: string, at = T0 + 1): string {
	const lane = plan.lanes.find(candidate => candidate.name === laneName);
	if (lane === undefined) throw new Error(`no lane ${laneName}`);
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const bound = lanes.assign({ name: laneName, agent }, plan, h.config);
	if (!bound.ok) throw new Error(bound.reason);
	const spawnKey = (bound.input as Record<string, unknown>).name;
	if (typeof spawnKey !== "string") throw new Error("the lane binding has no task name");
	lanes.admit({ spawnKey, agent, outcome: "routed" });
	agents.push(
		agentEntry({
			id: spawnKey,
			name: agent,
			role: lane.role,
			state: "idle",
			requests: 1,
			lastActivityAt: at,
			...(lane.role === "implementer" ? { changes: 1, lastChangeAt: T0, lastActivityAt: at } : {}),
		}),
	);
	return spawnKey;
}

async function settle(h: FakeSession, input: AttemptSettlement): Promise<void> {
	await h.controller.settleAttempt(input);
	h.controller.runLanes()?.releaseAgent(input.spawnKey);
}

/**
 * One accepted GOOD attempt, then a follow-up that writes BAD and starts its settlement. The returned promise is
 * the settlement already inside `settleAttempt`; `own.settling` is set before its first await.
 */
async function settleThenRace() {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const target = "race.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const plan = planFor(
		[{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "race-change", kind: "change", criterion: "race content", path: target, contains: "GOOD" }] }],
		{ implementer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const spawnKey = admit(h, plan, agents, "write");
	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "c1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "GOOD\n");
	await settle(h, { runId, lane: "write", spawnKey, parentId: "main", dispatch: "c1", startedAt: T0, observedAt: T0 + 1, report: report({ runId, spawnKey, attemptId: `job:c1:${spawnKey}` }), citations: [] });
	expect(h.controller.active()?.results?.find(item => item.id === "race-change")?.state).toBe("accepted");

	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "c2", followUp: true, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "BAD\n");
	const settling = h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "c2", startedAt: T0 + 2, observedAt: T0 + 3, report: report({ runId, spawnKey, attemptId: `job:c2:${spawnKey}`, observedAt: T0 + 3 }), citations: [] });
	return { h, runId, settling, spawnKey, target };
}

test("finish(verified) waits for an in-flight settlement and records its unmet outcome", async () => {
	const { h, runId, settling, spawnKey, target } = await settleThenRace();

	const early = await h.controller.finish("verified");
	expect(early).toBeUndefined();
	// Nothing is persisted as a finished record while the settlement is still evaluating.
	expect((await readRun(h.sessionDir, runId))?.endedAt).toBeUndefined();
	await settling;

	h.timers.fire();
	await until(async () => (await readRun(h.sessionDir, runId))?.endedAt !== undefined);
	const final = await readRun(h.sessionDir, runId);
	expect(final?.endReason).not.toBe("verified");
	expect(final).toMatchObject({ status: "stopped", endReason: "no-progress" });
	expect(final?.results?.find(item => item.id === "race-change")).toMatchObject({ state: "unmet", attemptId: `job:c2:${spawnKey}` });
	expect(await readFile(path.join(root, target), "utf8")).toBe("BAD\n");
	// The lease was released exactly once, by the one finalization that wrote the record.
	await until(() => h.leases.released.length === 1);
	expect(h.leases.released).toEqual([runId]);

	// A repeated delivery for the consumed dispatch cannot change the finished record.
	await h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "c2", startedAt: T0 + 2, observedAt: T0 + 3, report: report({ runId, spawnKey, attemptId: `job:c2:${spawnKey}`, observedAt: T0 + 3 }), citations: [] });
	expect((await readRun(h.sessionDir, runId))?.results?.find(item => item.id === "race-change")).toMatchObject({ state: "unmet", attemptId: `job:c2:${spawnKey}` });
});

test("a limit close waits for the settlement and no late delivery rewrites the finished record", async () => {
	const { h, runId, settling, spawnKey } = await settleThenRace();

	const early = await h.controller.finish("budget");
	expect(early).toBeUndefined();
	await settling;
	h.timers.fire();
	await until(async () => (await readRun(h.sessionDir, runId))?.endedAt !== undefined);

	const final = await readRun(h.sessionDir, runId);
	expect(final).toMatchObject({ status: "stopped", endReason: "budget" });
	expect(final?.results?.find(item => item.id === "race-change")).toMatchObject({ state: "unmet", attemptId: `job:c2:${spawnKey}` });
	await until(() => h.leases.released.length === 1);
	expect(h.leases.released).toEqual([runId]);

	const before = JSON.stringify(await readRun(h.sessionDir, runId));
	await h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "c2", startedAt: T0 + 2, observedAt: T0 + 4, report: report({ runId, spawnKey, attemptId: `job:c2:${spawnKey}`, observedAt: T0 + 4 }), citations: [] });
	expect(JSON.stringify(await readRun(h.sessionDir, runId))).toBe(before);
});

test("a reverted shared change reopens at the verified gate and blocks a result consumer, keeping an independent result", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const a = "a.txt";
	const c = "c.txt";
	const d = "d.txt";
	await writeFile(path.join(root, a), "ORIGINAL-A\n");
	await writeFile(path.join(root, c), "ORIGINAL-C\n");
	await writeFile(path.join(root, d), "ORIGINAL-D\n");
	const plan = planFor(
		[
			{ name: "a-write", kind: "code", role: "implementer", files: [a], results: [{ id: "a-change", kind: "change", criterion: "a is GOOD", path: a, contains: "GOOD" }] },
			{ name: "c-write", kind: "code", role: "implementer", files: [c], results: [{ id: "c-change", kind: "change", criterion: "c is CGOOD", path: c, contains: "CGOOD" }] },
			{ name: "d-write", kind: "code", role: "implementer", files: [d], results: [{ id: "d-change", kind: "change", criterion: "d is DGOOD", path: d, contains: "DGOOD" }], dependsOn: [{ lane: "a-write", need: "result" }] },
			{ name: "consume", kind: "explore", role: "explorer", goal: "Consume A", dependsOn: [{ lane: "a-write", need: "result" }] },
		],
		{ implementer: 1, explorer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const aKey = admit(h, plan, agents, "a-write");
	expect(await h.controller.prepareAttempt({ runId, lane: "a-write", spawnKey: aKey, parentId: "main", dispatch: "a1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, a), "GOOD\n");
	await settle(h, { runId, lane: "a-write", spawnKey: aKey, parentId: "main", dispatch: "a1", startedAt: T0, observedAt: T0 + 1, report: report({ runId, spawnKey: aKey, attemptId: `job:a1:${aKey}` }), citations: [] });
	const cKey = admit(h, plan, agents, "c-write", T0 + 1);
	expect(await h.controller.prepareAttempt({ runId, lane: "c-write", spawnKey: cKey, parentId: "main", dispatch: "c1", followUp: false, artifactMode: "shared", startedAt: T0 + 1 })).toEqual({ ok: true });
	await writeFile(path.join(root, c), "CGOOD\n");
	await settle(h, { runId, lane: "c-write", spawnKey: cKey, parentId: "main", dispatch: "c1", startedAt: T0 + 1, observedAt: T0 + 2, report: report({ runId, spawnKey: cKey, attemptId: `job:c1:${cKey}` }), citations: [] });
	// D consumes A's accepted version, so a later A change must reopen D and leave independent C alone.
	const aReadiness = await h.controller.laneReadiness(plan, new Set(["a-write"]));
	const dBound = lanes.assign({ name: "d-write", agent: "storm-implementer" }, plan, h.config, { readiness: aReadiness });
	if (!dBound.ok) throw new Error(dBound.reason);
	const dKey = (dBound.input as Record<string, unknown>).name;
	if (typeof dKey !== "string") throw new Error("the lane binding has no task name");
	lanes.admit({ spawnKey: dKey, agent: "storm-implementer", outcome: "routed" });
	agents.push(agentEntry({ id: dKey, name: "storm-implementer", role: "implementer", state: "idle", requests: 1, changes: 1, lastChangeAt: T0 + 2, lastActivityAt: T0 + 2 }));
	expect(await h.controller.prepareAttempt({ runId, lane: "d-write", spawnKey: dKey, parentId: "main", dispatch: "d1", followUp: false, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
	await writeFile(path.join(root, d), "DGOOD\n");
	await settle(h, { runId, lane: "d-write", spawnKey: dKey, parentId: "main", dispatch: "d1", startedAt: T0 + 2, observedAt: T0 + 3, report: report({ runId, spawnKey: dKey, attemptId: `job:d1:${dKey}` }), citations: [] });
	expect(h.controller.active()?.results?.find(item => item.id === "d-change")?.consumed?.map(item => item.id)).toEqual(["a-change"]);

	const before = await h.controller.laneReadiness(plan, new Set(["a-write"]));
	expect(before.get("a-write")?.results[0]).toMatchObject({ id: "a-change", kind: "change", state: "accepted", integrated: true });

	// A later unrelated write restores A's pre-run bytes. No new attempt of A exists.
	await writeFile(path.join(root, a), "ORIGINAL-A\n");
	const after = await h.controller.laneReadiness(plan, new Set(["a-write"]));
	const reverted = after.get("a-write")?.results[0];
	expect(reverted).toMatchObject({ id: "a-change", kind: "change", state: "unmet", integrated: false });
	expect(reverted?.reason).toContain("reverted");
	const consumer = plan.lanes.find(lane => lane.name === "consume");
	if (consumer === undefined) throw new Error("no consumer lane");
	const blocked = lanes.place({ name: "consume", agent: "storm-explorer", task: "Consume A" }, plan, h.config, { readiness: after });
	expect(blocked.ok).toBe(false);
	if (!blocked.ok) {
		expect(blocked.code).toBe("lane-dependency");
		expect(blocked.reason).toContain("미충족");
		expect(blocked.reason).toContain("reverted");
	}

	const final = await h.controller.finish("verified");
	expect(final).toMatchObject({ status: "stopped", endReason: "no-progress" });
	expect(final?.results?.find(item => item.id === "a-change")).toMatchObject({ state: "unmet" });
	const dependent = final?.results?.find(item => item.id === "d-change");
	expect(dependent).toMatchObject({ state: "unmet" });
	expect(dependent?.reason).toContain("선행 결과가 바뀌어");
	expect(final?.results?.find(item => item.id === "c-change")).toMatchObject({ state: "accepted" });
	expect(await readFile(path.join(root, c), "utf8")).toBe("CGOOD\n");
	const persisted = await readRun(h.sessionDir, runId);
	expect(persisted?.endReason).toBe("no-progress");
	expect(persisted?.results?.find(item => item.id === "c-change")).toMatchObject({ state: "accepted" });
	// A row finalization did not change carries no marker.
	expect(persisted?.results?.find(item => item.id === "c-change")?.finalized).toBeUndefined();
});

test("an ordinary turn cannot verify a tree whose accepted shared change was reverted", async () => {
	const agents: AgentEntry[] = [];
	let tree = treeOf("d0", "f0");
	const h = session(agents, () => ({ base: "b0", state: tree }));
	const runId = await h.start();
	await writeFile(path.join(root, "a.txt"), "ORIGINAL-A\n");
	await writeFile(path.join(root, "b.txt"), "ORIGINAL-B\n");
	const plan = planFor(
		[
			{ name: "a-write", kind: "code", role: "implementer", files: ["a.txt"], results: [{ id: "a-change", kind: "change", criterion: "a is GOOD", path: "a.txt", contains: "GOOD" }] },
			{ name: "b-write", kind: "code", role: "implementer", files: ["b.txt"], results: [{ id: "b-change", kind: "change", criterion: "b is BGOOD", path: "b.txt", contains: "BGOOD" }] },
			{ name: "review", kind: "review", role: "reviewer", goal: "Review the tree" },
		],
		{ implementer: 1, reviewer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const aKey = admit(h, plan, agents, "a-write");
	expect(await h.controller.prepareAttempt({ runId, lane: "a-write", spawnKey: aKey, parentId: "main", dispatch: "ra", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, "a.txt"), "GOOD\n");
	await settle(h, { runId, lane: "a-write", spawnKey: aKey, parentId: "main", dispatch: "ra", startedAt: T0, observedAt: T0 + 2, report: report({ runId, spawnKey: aKey, attemptId: `job:ra:${aKey}`, observedAt: T0 + 2 }), citations: [] });

	const bKey = admit(h, plan, agents, "b-write", T0 + 1);
	expect(await h.controller.prepareAttempt({ runId, lane: "b-write", spawnKey: bKey, parentId: "main", dispatch: "rb", followUp: false, artifactMode: "shared", startedAt: T0 + 1 })).toEqual({ ok: true });
	await writeFile(path.join(root, "b.txt"), "BGOOD\n");
	await settle(h, { runId, lane: "b-write", spawnKey: bKey, parentId: "main", dispatch: "rb", startedAt: T0 + 1, observedAt: T0 + 3, report: report({ runId, spawnKey: bKey, attemptId: `job:rb:${bKey}`, observedAt: T0 + 3 }), citations: [] });
	admit(h, plan, agents, "review");
	expect(h.controller.active()?.results?.map(item => [item.id, item.state])).toEqual([["a-change", "accepted"], ["b-change", "accepted"]]);

	// B's later write restores A's pre-run bytes, then the reviewer's current-tree verdict lands.
	await writeFile(path.join(root, "a.txt"), "ORIGINAL-A\n");
	tree = treeOf("d1", "f1");
	const current = treeFingerprint(tree);
	agents.push({
		...agentEntry({
			id: "Rev",
			name: "storm-reviewer",
			role: "reviewer",
			state: "idle",
			requests: 1,
			lastActivityAt: T0 + 3,
			review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] },
			lastVerdict: { at: T0 + 4, correct: true, tree: current },
		}),
		reviewLog: [{ at: T0 + 4, correct: true, findings: [], tree: current }],
	} as AgentEntry);
	await h.turn();

	const final = await readRun(h.sessionDir, runId);
	expect(final?.endReason).not.toBe("verified");
	expect(final?.results?.find(item => item.id === "a-change")).toMatchObject({ state: "unmet" });
	expect(final?.results?.find(item => item.id === "b-change")).toMatchObject({ state: "accepted" });
	expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("ORIGINAL-A\n");
});

async function retainedPlan(h: FakeSession) {
	const agents: AgentEntry[] = [];
	const patchPath = path.join(os.tmpdir(), `storm-final-retained-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
	const patch = ["diff --git a/experiment.txt b/experiment.txt", "new file mode 100644", "--- /dev/null", "+++ b/experiment.txt", "@@ -0,0 +1 @@", "+experiment change", ""].join("\n");
	await writeFile(patchPath, patch);
	const plan = planFor(
		[
			{ name: "experiment", kind: "run", role: "implementer", files: ["experiment.txt"], isolationReason: "result stays outside", results: [{ id: "experiment-patch", kind: "artifact", criterion: "patch carries experiment change", path: "experiment.txt", contains: "experiment change" }] },
			{ name: "consume", kind: "explore", role: "explorer", goal: "Read the experiment", dependsOn: [{ lane: "experiment", need: "result" }] },
		],
		{ implementer: 1, explorer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const bound = lanes.assign({ name: "experiment", agent: "storm-implementer" }, plan, h.config, { host: { enabled: true, apply: false } });
	if (!bound.ok) throw new Error(bound.reason);
	const spawnKey = (bound.input as Record<string, unknown>).name;
	if (typeof spawnKey !== "string") throw new Error("the lane binding has no task name");
	lanes.admit({ spawnKey, agent: "storm-implementer", outcome: "routed" });
	agents.push(agentEntry({ id: spawnKey, name: "storm-implementer", role: "implementer", state: "idle", requests: 1, lastActivityAt: T0 + 1 }));
	return { agents, patch, patchPath, plan, spawnKey };
}

test("a valid retained-only artifact stays accepted at the verified gate and satisfies a result consumer", async () => {
	const h = session();
	const runId = await h.start();
	const { patch, patchPath, plan, spawnKey } = await retainedPlan(h);
	expect(await h.controller.prepareAttempt({ runId, lane: "experiment", spawnKey, parentId: "main", dispatch: "artifact", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
	await settle(h, {
		runId,
		lane: "experiment",
		spawnKey,
		parentId: "main",
		dispatch: "artifact",
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey, attemptId: `job:ja:${spawnKey}`, artifacts: [{ kind: "patch", path: patchPath, bytes: Buffer.byteLength(patch), capturedAt: T0 + 1, source: "task-result" }] }),
		citations: [],
	});

	const readiness = await h.controller.laneReadiness(plan, new Set(["experiment"]));
	const view = readiness.get("experiment");
	expect(view?.results[0]).toMatchObject({ id: "experiment-patch", kind: "artifact", state: "accepted", integrated: false });
	expect(view?.results[0]?.retained?.path).toBe(await realpath(patchPath));
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const consumer = lanes.place({ name: "consume", agent: "storm-explorer", task: "Read the experiment" }, plan, h.config, { readiness });
	expect(consumer.ok).toBe(true);
	if (consumer.ok) expect(String(consumer.input.task)).toContain("experiment-patch=accepted");

	const final = await h.controller.finish("verified");
	expect(final).toMatchObject({ status: "done", endReason: "verified" });
	expect(final?.results?.find(item => item.id === "experiment-patch")).toMatchObject({ state: "accepted" });
	await rm(patchPath, { force: true });
});

test("a vanished retained artifact is not verified and reopens its row", async () => {
	const h = session();
	const runId = await h.start();
	const { patch, patchPath, spawnKey } = await retainedPlan(h);
	expect(await h.controller.prepareAttempt({ runId, lane: "experiment", spawnKey, parentId: "main", dispatch: "artifact", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
	await settle(h, {
		runId,
		lane: "experiment",
		spawnKey,
		parentId: "main",
		dispatch: "artifact",
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey, attemptId: `job:ja:${spawnKey}`, artifacts: [{ kind: "patch", path: patchPath, bytes: Buffer.byteLength(patch), capturedAt: T0 + 1, source: "task-result" }] }),
		citations: [],
	});
	await rm(patchPath, { force: true });

	const final = await h.controller.finish("verified");
	expect(final).toMatchObject({ status: "stopped", endReason: "no-progress" });
	const row = final?.results?.find(item => item.id === "experiment-patch");
	expect(row).toMatchObject({ state: "unmet" });
	expect(row?.reason).toContain("보존");
	// Finalization reopened accepted evidence: the closeout can tell it apart from a judged miss.
	expect(row?.finalized).toBe("revoked");
	expect((await readRun(h.sessionDir, runId))?.results?.find(item => item.id === "experiment-patch")?.finalized).toBe("revoked");
});

test("an accepted answer is proof at the verified gate and is not treated like a missing patch", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	await writeFile(path.join(root, REPORT), '{\n  "total": 42\n}\n');
	const plan = planFor(
		[{ name: "read-report", kind: "explore", role: "explorer", goal: "Answer the total", results: [{ id: "report-answer", kind: "answer", criterion: "states the total and cites report.json", path: REPORT, contains: '"total": 42' }] }],
		{ explorer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const spawnKey = admit(h, plan, agents, "read-report");
	expect(await h.controller.prepareAttempt({ runId, lane: "read-report", spawnKey, parentId: "main", dispatch: "answer", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await settle(h, {
		runId,
		lane: "read-report",
		spawnKey,
		parentId: "main",
		dispatch: "answer",
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey, attemptId: `job:answer:${spawnKey}` }),
		reportText: "The total is 42 (report.json:2).",
		citations: [{ path: REPORT, line: 2 }],
	});

	const final = await h.controller.finish("verified");
	expect(final).toMatchObject({ status: "done", endReason: "verified" });
	expect(final?.results?.find(item => item.id === "report-answer")).toMatchObject({ state: "accepted" });
	expect(final?.results?.find(item => item.id === "report-answer")?.finalized).toBeUndefined();
});

test("a result edge needs the accepted result's current location, not only its ledger state", () => {
	const consumer: PlanLane = {
		name: "consume",
		kind: "explore",
		role: "explorer",
		dependsOn: [{ lane: "produce", need: "result" }],
	};
	const integratedConsumer: PlanLane = { ...consumer, dependsOn: [{ lane: "produce", need: "integrated" }] };
	const view = (result: LaneResultReadiness): LaneReadinessView =>
		new Map([["produce", { results: [result], settled: true, integrated: result.integrated, running: false }]]);

	// An accepted shared change whose bytes are gone is not current input for a result consumer.
	const reverted = dependencyBlock(consumer, view({ id: "p", kind: "change", state: "accepted", integrated: false }));
	expect(reverted).toContain("현재 위치 미확인");

	// A verified retained source is a valid `result` without being integrated into the parent.
	const retained: LaneResultReadiness = {
		id: "p",
		kind: "artifact",
		state: "accepted",
		integrated: false,
		retained: { ref: "p@v1", path: "/tmp/p.patch", kind: "patch" },
	};
	expect(dependencyBlock(consumer, view(retained))).toBeUndefined();
	// But `integrated` still means the parent tree, never a retained-only artifact.
	expect(dependencyBlock(integratedConsumer, view(retained))).toContain("통합 미확인");

	// An answer's recorded proof has no patch location to lose; it still cannot be integrated.
	expect(dependencyBlock(consumer, view({ id: "p", kind: "answer", state: "accepted", integrated: false }))).toBeUndefined();
	expect(dependencyBlock(integratedConsumer, view({ id: "p", kind: "answer", state: "accepted", integrated: false }))).toBeDefined();
});

test("an ordinary turn that races a settlement is re-gated after the barrier instead of writing verified", async () => {
	const agents: AgentEntry[] = [];
	const tree = treeOf("d0", "f0");
	const current = treeFingerprint(tree);
	const h = session(agents, () => ({ base: "b0", state: tree }));
	const runId = await h.start({ task: "t" });
	const target = "turn-race.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const plan = planFor(
		[
			{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "turn-change", kind: "change", criterion: "turn race content", path: target, contains: "GOOD" }] },
			{ name: "review", kind: "review", role: "reviewer", goal: "Independent verdict" },
		],
		{ implementer: 1, reviewer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const spawnKey = admit(h, plan, agents, "write");
	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "t1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "GOOD\n");
	await settle(h, { runId, lane: "write", spawnKey, parentId: "main", dispatch: "t1", startedAt: T0, observedAt: T0 + 1, report: report({ runId, spawnKey, attemptId: `job:t1:${spawnKey}` }), citations: [] });
	admit(h, plan, agents, "review");
	agents.push({
		...agentEntry({
			id: "Rev",
			name: "storm-reviewer",
			role: "reviewer",
			state: "idle",
			requests: 1,
			lastActivityAt: T0 + 1,
			review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] },
			lastVerdict: { at: T0 + 2, correct: true, tree: current },
		}),
		reviewLog: [{ at: T0 + 2, correct: true, findings: [], tree: current }],
	} as AgentEntry);

	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "t2", followUp: true, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "BAD\n");
	const settling = h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "t2", startedAt: T0 + 2, observedAt: T0 + 3, report: report({ runId, spawnKey, attemptId: `job:t2:${spawnKey}`, observedAt: T0 + 3 }), citations: [] });
	await h.turn();
	// The turn's verified decision waits for the settlement instead of writing the older accepted row.
	expect((await readRun(h.sessionDir, runId))?.endedAt).toBeUndefined();
	await settling;
	h.timers.fire();
	await until(async () => (await readRun(h.sessionDir, runId))?.endedAt !== undefined);

	const final = await readRun(h.sessionDir, runId);
	expect(final?.endReason).not.toBe("verified");
	expect(final?.results?.find(item => item.id === "turn-change")).toMatchObject({ state: "unmet" });
});
