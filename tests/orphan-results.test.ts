/**
 * B2: an accepted result outlives the lane that produced it. A replan may remove the lane, but the run's obligation
 * and the bounded contract stay: finalization re-locates every accepted change/artifact at its current source (an
 * orphan included) and keeps a review-accepted row only while its bound tree still matches. Intact orphans stay
 * accepted, transferred ids keep their proof, and a same-id contract rewrite is refused before it can relax one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import type { TaskPlacementOptions } from "../src/runtime/lanes.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { treeFingerprint } from "../src/runtime/rounds.ts";
import { readRun } from "../src/runtime/run.ts";
import type { TreeReading } from "../src/runtime/tree.ts";
import type { AgentEntry, PlanLaneResult, RunPlan } from "../src/types.ts";
import { fakeSession, until, type FakeSession } from "./fake-session.ts";
import { agentEntry, treeOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-orphan-results-")));
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (agents: AgentEntry[], tree?: () => TreeReading) =>
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
function admit(
	h: FakeSession,
	plan: RunPlan,
	agents: AgentEntry[],
	laneName: string,
	at = T0 + 1,
	options: Omit<TaskPlacementOptions, "rewriteNames"> = {},
): string {
	const lane = plan.lanes.find(candidate => candidate.name === laneName);
	if (lane === undefined) throw new Error(`no lane ${laneName}`);
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const bound = lanes.assign({ name: laneName, agent }, plan, h.config, options);
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
			...(lane.role === "implementer" ? { changes: 1, lastChangeAt: T0 } : {}),
		}),
	);
	return spawnKey;
}

async function settle(h: FakeSession, input: AttemptSettlement): Promise<void> {
	await h.controller.settleAttempt(input);
	h.controller.runLanes()?.releaseAgent(input.spawnKey);
}

const row = (h: FakeSession, id: string) => h.controller.active()?.results?.find(item => item.id === id);

/** One accepted shared change: capture, write the required content, settle, release. */
async function acceptShared(
	h: FakeSession,
	runId: string,
	plan: RunPlan,
	agents: AgentEntry[],
	laneName: string,
	dispatch: string,
	file: string,
	content: string,
): Promise<string> {
	const spawnKey = admit(h, plan, agents, laneName);
	expect(await h.controller.prepareAttempt({ runId, lane: laneName, spawnKey, parentId: "main", dispatch, followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, file), content);
	await settle(h, {
		runId,
		lane: laneName,
		spawnKey,
		parentId: "main",
		dispatch,
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey, attemptId: `job:${dispatch}:${spawnKey}` }),
		citations: [],
	});
	return spawnKey;
}

/** A reviewer verdict bound to one exact tree fingerprint, the shape the round gate reads. */
function verdict(at: number, tree: string): AgentEntry {
	return {
		...agentEntry({
			id: "Rev",
			name: "storm-reviewer",
			role: "reviewer",
			review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] },
			lastVerdict: { at, correct: true, tree },
		}),
		reviewLog: [{ at, correct: true, findings: [], tree }],
	} as AgentEntry;
}

const reviewLane = (name = "review") => ({ name, kind: "review" as const, role: "reviewer", goal: "Review the tree" });

test("B2: a reverted accepted change after its lane leaves the plan closes no-progress, row unmet", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const target = "orphan-owned.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const contract: PlanLaneResult = { id: "orphan-change", kind: "change", criterion: "GOOD content", path: target, contains: "GOOD" };
	const plan = planFor([{ name: "write", kind: "code", role: "implementer", files: [target], results: [contract] }, reviewLane()], { implementer: 1, reviewer: 1 });
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	await acceptShared(h, runId, plan, agents, "write", "o1", target, "GOOD\n");
	const accepted = row(h, "orphan-change");
	expect(accepted).toMatchObject({ state: "accepted", lane: "write" });
	const attempt = accepted?.attemptId;

	// The director drops the producing lane; the accepted row keeps the bounded contract it was observed for.
	expect(await h.controller.setPlan(h.ctx, planFor([reviewLane()], { reviewer: 1 }))).toEqual({ ok: true });
	expect(row(h, "orphan-change")).toMatchObject({ state: "accepted", contract });
	await writeFile(path.join(root, target), "ORIGINAL\n");

	const final = await h.controller.finish("verified");
	expect(final?.endReason).toBe("no-progress");
	expect(final?.status).not.toBe("done");
	const reopened = final?.results?.find(item => item.id === "orphan-change");
	expect(reopened).toMatchObject({ state: "unmet", identity: accepted?.identity, contract });
	expect(reopened?.contentVersion).toBeUndefined();
	expect(reopened?.attemptId).toBe(attempt);
	expect(reopened?.reason).toContain("확인되지 않았습니다");
	expect(await readFile(path.join(root, target), "utf8")).toBe("ORIGINAL\n");
});

test("B2: the same reverted orphan is not verified by a normal turn with a correct current-tree verdict", async () => {
	const agents: AgentEntry[] = [];
	let tree = treeOf("d0", "f0");
	const h = session(agents, () => ({ base: "b0", state: tree }));
	const runId = await h.start();
	const target = "orphan-turn.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const plan = planFor(
		[
			{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "turn-change", kind: "change", criterion: "GOOD content", path: target, contains: "GOOD" }] },
			reviewLane(),
		],
		{ implementer: 1, reviewer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	await acceptShared(h, runId, plan, agents, "write", "t1", target, "GOOD\n");
	expect(row(h, "turn-change")?.state).toBe("accepted");

	const replanned = planFor([reviewLane()], { reviewer: 1 });
	expect(await h.controller.setPlan(h.ctx, replanned)).toEqual({ ok: true });
	await writeFile(path.join(root, target), "ORIGINAL\n");
	admit(h, replanned, agents, "review");
	tree = treeOf("d1", "f1");
	agents.push(verdict(T0 + 4, treeFingerprint(tree)));

	await h.turn();
	h.timers.fire();
	await until(async () => (await readRun(h.sessionDir, runId))?.endedAt !== undefined);
	const final = await readRun(h.sessionDir, runId);
	expect(final?.endReason).not.toBe("verified");
	expect(final?.status).not.toBe("done");
	expect(final?.results?.find(item => item.id === "turn-change")).toMatchObject({ state: "unmet" });
	expect(final?.results?.find(item => item.id === "turn-change")?.reason).toContain("확인되지 않았습니다");
});

test("B2: a vanished retained artifact is not verified after its isolated lane leaves the plan", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const patchPath = path.join(os.tmpdir(), `storm-orphan-art-${process.pid}-${Date.now()}.patch`);
	const patch = ["diff --git a/experiment.txt b/experiment.txt", "new file mode 100644", "--- /dev/null", "+++ b/experiment.txt", "@@ -0,0 +1 @@", "+experiment change", ""].join("\n");
	await writeFile(patchPath, patch);
	try {
		const plan = planFor(
			[{ name: "experiment", kind: "run", role: "implementer", files: ["experiment.txt"], isolationReason: "result stays outside", results: [{ id: "experiment-patch", kind: "artifact", criterion: "patch carries experiment change", path: "experiment.txt", contains: "experiment change" }] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "experiment", T0 + 1, { host: { enabled: true, apply: false } });
		expect(await h.controller.prepareAttempt({ runId, lane: "experiment", spawnKey, parentId: "main", dispatch: "a1", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
		await settle(h, {
			runId,
			lane: "experiment",
			spawnKey,
			parentId: "main",
			dispatch: "a1",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({
				runId,
				spawnKey,
				attemptId: `job:a1:${spawnKey}`,
				artifacts: [{ kind: "patch", path: patchPath, bytes: Buffer.byteLength(patch), capturedAt: T0 + 1, source: "task-result" }],
			}),
			citations: [],
		});
		expect(row(h, "experiment-patch")).toMatchObject({ state: "accepted", contract: { kind: "artifact" } });
		expect(await h.controller.setPlan(h.ctx, planFor([reviewLane()], { reviewer: 1 }))).toEqual({ ok: true });
		await rm(patchPath, { force: true });

		const final = await h.controller.finish("verified");
		expect(final?.endReason).toBe("no-progress");
		const reopened = final?.results?.find(item => item.id === "experiment-patch");
		expect(reopened).toMatchObject({ state: "unmet" });
		expect(reopened?.reason).toContain("보존된 산출물");
	} finally {
		await rm(patchPath, { force: true });
	}
});

test("B2 control: an intact orphaned accepted change stays accepted and verifiable", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const target = "intact-orphan.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const contract: PlanLaneResult = { id: "intact-change", kind: "change", criterion: "GOOD content", path: target, contains: "GOOD" };
	const plan = planFor([{ name: "write", kind: "code", role: "implementer", files: [target], results: [contract] }, reviewLane()], { implementer: 1, reviewer: 1 });
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	await acceptShared(h, runId, plan, agents, "write", "i1", target, "GOOD\n");
	const accepted = row(h, "intact-change");
	expect(await h.controller.setPlan(h.ctx, planFor([reviewLane()], { reviewer: 1 }))).toEqual({ ok: true });

	const final = await h.controller.finish("verified");
	expect(final?.endReason).toBe("verified");
	expect(final?.status).toBe("done");
	expect(final?.results?.find(item => item.id === "intact-change")).toMatchObject({
		state: "accepted",
		contract,
		contentVersion: accepted?.contentVersion,
		attemptId: accepted?.attemptId,
	});
});

test("B2 transfer: moving the exact contract to a new lane keeps its accepted proof", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const target = "transfer.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const contract: PlanLaneResult = { id: "moved-change", kind: "change", criterion: "GOOD content", path: target, contains: "GOOD" };
	const plan = planFor([{ name: "write", kind: "code", role: "implementer", files: [target], results: [contract] }, reviewLane()], { implementer: 1, reviewer: 1 });
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	await acceptShared(h, runId, plan, agents, "write", "m1", target, "GOOD\n");
	const before = row(h, "moved-change");

	expect(await h.controller.setPlan(h.ctx, planFor([{ name: "write-again", kind: "code", role: "implementer", files: [target], results: [contract] }, reviewLane()], { implementer: 1, reviewer: 1 }))).toEqual({ ok: true });
	expect(row(h, "moved-change")).toMatchObject({
		state: "accepted",
		lane: "write-again",
		contract,
		contentVersion: before?.contentVersion,
		attemptId: before?.attemptId,
	});

	const final = await h.controller.finish("verified");
	expect(final?.endReason).toBe("verified");
	expect(final?.results?.find(item => item.id === "moved-change")).toMatchObject({ state: "accepted", lane: "write-again", contract });
});

test("B2 scoped same-id replan cannot rewrite an orphaned acceptance criterion", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const target = "scoped.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const contract: PlanLaneResult = { id: "scoped-change", kind: "change", criterion: "GOOD content", path: target, contains: "GOOD" };
	const plan = planFor([{ name: "write", kind: "code", role: "implementer", files: [target], results: [contract] }, reviewLane()], { implementer: 1, reviewer: 1 });
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	await acceptShared(h, runId, plan, agents, "write", "s1", target, "GOOD\n");
	expect(await h.controller.setPlan(h.ctx, planFor([reviewLane()], { reviewer: 1 }))).toEqual({ ok: true });
	const before = row(h, "scoped-change");

	const weakened = await h.controller.setPlan(
		h.ctx,
		planFor([{ name: "write-again", kind: "code", role: "implementer", files: [target], results: [{ ...contract, contains: "ORIGINAL" }] }, reviewLane()], { implementer: 1, reviewer: 1 }),
	);
	expect(weakened.ok).toBe(false);
	if (!weakened.ok) expect(weakened.reason).toContain("계약");
	expect(row(h, "scoped-change")).toMatchObject({ state: "accepted", contract, contentVersion: before?.contentVersion });

	const final = await h.controller.finish("verified");
	expect(final?.endReason).toBe("verified");
	expect(final?.results?.find(item => item.id === "scoped-change")).toMatchObject({ state: "accepted", contract });
});

test("B2 dependencies: an orphaned producer reversion reopens its accepted consumer across replans", async () => {
	const agents: AgentEntry[] = [];
	const h = session(agents);
	const runId = await h.start();
	const producerFile = "producer.txt";
	const consumerFile = "consumer.txt";
	await writeFile(path.join(root, producerFile), "ORIGINAL\n");
	const plan = planFor(
		[
			{ name: "produce", kind: "code", role: "implementer", files: [producerFile], results: [{ id: "p-change", kind: "change", criterion: "P-OK content", path: producerFile, contains: "P-OK" }] },
			{
				name: "consume",
				kind: "code",
				role: "implementer",
				files: [consumerFile],
				results: [{ id: "c-change", kind: "change", criterion: "C-OK content", path: consumerFile, contains: "C-OK" }],
				dependsOn: [{ lane: "produce", need: "result" }],
			},
			reviewLane(),
		],
		{ implementer: 2, reviewer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	await acceptShared(h, runId, plan, agents, "produce", "p1", producerFile, "P-OK\n");
	const lanes = h.controller.runLanes()!;
	const readiness = await h.controller.laneReadiness(plan, new Set(["produce"]));
	const consumeKey = "consume";
	const placed = lanes.place({ name: consumeKey, agent: "storm-implementer", task: "consume the producer result" }, plan, h.config, { readiness });
	if (!placed.ok) throw new Error(placed.reason);
	const admitted = lanes.admitChecked({ spawnKey: consumeKey, agent: "storm-implementer", outcome: "routed" }, { plan, config: h.config });
	if (!admitted.ok) throw new Error(admitted.reason);
	agents.push(agentEntry({ id: consumeKey, name: "storm-implementer", role: "implementer", state: "idle", requests: 1, lastActivityAt: T0 + 1, changes: 1, lastChangeAt: T0 }));
	expect(await h.controller.prepareAttempt({ runId, lane: "consume", spawnKey: consumeKey, parentId: "main", dispatch: "c1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, consumerFile), "C-OK\n");
	await settle(h, {
		runId,
		lane: "consume",
		spawnKey: consumeKey,
		parentId: "main",
		dispatch: "c1",
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey: consumeKey, attemptId: `job:c1:${consumeKey}` }),
		citations: [],
	});
	expect(row(h, "p-change")?.state).toBe("accepted");
	expect(row(h, "c-change")).toMatchObject({ state: "accepted", consumed: [{ id: "p-change" }] });

	// The producer lane leaves the plan; the consumer keeps its own lane but not a stale edge to a removed name.
	const orphaned = planFor(
		[
			{ name: "consume", kind: "code", role: "implementer", files: [consumerFile], results: [{ id: "c-change", kind: "change", criterion: "C-OK content", path: consumerFile, contains: "C-OK" }] },
			reviewLane(),
		],
		{ implementer: 1, reviewer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, orphaned)).toEqual({ ok: true });
	// Dropping the consumer's declared input is itself a changed input declaration: the consumer reopens at the replan.
	expect(row(h, "c-change")?.state).not.toBe("accepted");
	expect(row(h, "c-change")?.reason).toContain("선행 입력");
	// A second replan still omits the producer: the obligation and its bounded contract survive both.
	expect(await h.controller.setPlan(h.ctx, { ...orphaned, note: "still missing the producer" })).toEqual({ ok: true });
	expect(row(h, "p-change")).toMatchObject({ state: "accepted", contract: { id: "p-change", kind: "change" } });

	await writeFile(path.join(root, producerFile), "ORIGINAL\n");
	const final = await h.controller.finish("verified");
	expect(final?.endReason).toBe("no-progress");
	expect(final?.results?.find(item => item.id === "p-change")).toMatchObject({ state: "unmet" });
	expect(final?.results?.find(item => item.id === "c-change")).toMatchObject({ state: "unmet" });
	expect(final?.results?.find(item => item.id === "c-change")?.reason).toContain("선행 입력");
});

test("B2 review-origin: a review-accepted orphan reopens when the tree digest it was bound to no longer matches", async () => {
	const agents: AgentEntry[] = [];
	let tree = treeOf("d0", "f0");
	const h = session(agents, () => ({ base: "b0", state: tree }));
	const runId = await h.start();
	const target = "qualitative.txt";
	await writeFile(path.join(root, target), "ORIGINAL\n");
	const contract: PlanLaneResult = { id: "quality-change", kind: "change", criterion: "quality judged by the reviewer", path: target };
	const plan = planFor(
		[
			{ name: "write", kind: "code", role: "implementer", files: [target], results: [contract] },
			reviewLane(),
			{ name: "later", kind: "code", role: "implementer", files: ["later.txt"], results: [{ id: "later-change", kind: "change", criterion: "later work", path: "later.txt", contains: "LATER" }] },
		],
		{ implementer: 2, reviewer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	await acceptShared(h, runId, plan, agents, "write", "q1", target, "the submitted change\n");
	expect(row(h, "quality-change")?.state).toBe("reviewable");

	agents.push(verdict(T0 + 4, treeFingerprint(tree)));
	await h.turn();
	h.timers.fire();
	await until(() => row(h, "quality-change")?.state === "accepted");
	const accepted = row(h, "quality-change");
	expect(accepted).toMatchObject({ state: "accepted", origin: "review", reviewTree: treeFingerprint(tree) });

	// The review lane stays; its verdict was bound to the tree above. Removing the producing lane does not keep the
	// digest current: a later tree move reopens the submission instead of carrying the old verdict into the record.
	expect(await h.controller.setPlan(h.ctx, planFor([reviewLane()], { reviewer: 1 }))).toEqual({ ok: true });
	tree = treeOf("d1", "f1");
	await writeFile(path.join(root, target), "reverted\n");
	const final = await h.controller.finish("verified");
	expect(final?.endReason).toBe("no-progress");
	expect(final?.status).not.toBe("done");
	const reopened = final?.results?.find(item => item.id === "quality-change");
	expect(reopened).toMatchObject({ state: "reviewable", contract });
	expect(reopened?.reason).toContain("리뷰 이후 트리");
	expect(reopened?.reviewTree).toBeUndefined();
});
