/**
 * S3 selective rework at the contract level, through the real RunController plan and attempt APIs:
 * - after a completed A consumed B@1, a replan that makes A consume C@1 reopens A and everything that consumed A, and
 *   A's lane becomes runnable again against C; B and C keep their checkpointed evidence;
 * - an A attempt admitted under the old declaration cannot settle (accept, or leave an exhausted-route block on) the
 *   new contract, even though every producer version it recorded is still current;
 * - a pure lane rename with the same result ids and levels reopens nothing and does not supersede an in-flight attempt;
 * - an added, removed or re-levelled input reopens A and its consumers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { dependencyBlock } from "../src/runtime/lanes.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import type { AgentEntry, PlanLane, RunPlan, RunResult, StormConfig } from "../src/types.ts";
import { fakeSession, type FakeSession } from "./fake-session.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", quick: "a/q", reviewer: "a/r" });

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-selective-rework-")));
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

type Edge = NonNullable<PlanLane["dependsOn"]>[number];

/** B and C are independent producers, A consumes whatever `aEdges` declares, D consumes A. */
function s3Plan(aEdges: Edge[], names: { b?: string; a?: string } = {}): RunPlan {
	const b = names.b ?? "b-produce";
	const a = names.a ?? "a-consume";
	return {
		lanes: [
			{
				name: b,
				kind: "code",
				role: "implementer",
				files: ["b.txt"],
				goal: "Publish the B result",
				results: [{ id: "b-result", kind: "change", criterion: "b.txt holds a versioned result", path: "b.txt", contains: "version:" }],
			},
			{
				name: "c-produce",
				kind: "code",
				role: "explorer",
				files: ["c.txt"],
				goal: "Publish the C result",
				results: [{ id: "c-result", kind: "change", criterion: "c.txt holds a versioned result", path: "c.txt", contains: "version:" }],
			},
			{
				name: a,
				kind: "code",
				role: "quick",
				files: ["a.txt"],
				goal: "Consume the declared upstream result",
				results: [{ id: "a-result", kind: "change", criterion: "a.txt accepts its input", path: "a.txt", contains: "result: accepted" }],
				dependsOn: aEdges.map(edge => (edge.lane === "b-produce" ? { ...edge, lane: b } : edge)),
			},
			{
				name: "d-downstream",
				kind: "code",
				role: "quick",
				files: ["d.txt"],
				goal: "Consume the A result",
				results: [{ id: "d-result", kind: "change", criterion: "d.txt accepts A", path: "d.txt", contains: "downstream: ok" }],
				dependsOn: [{ lane: a, need: "result" }],
			},
		],
		workers: { implementer: 1, quick: 2 },
		submittedAt: new Date(T0).toISOString(),
	};
}

const ON_B: Edge[] = [{ lane: "b-produce", need: "result" }];
const ON_C: Edge[] = [{ lane: "c-produce", need: "result" }];

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

let serial = 0;

interface Run {
	h: FakeSession;
	runId: string;
	agents: AgentEntry[];
}

async function begin(plan: RunPlan): Promise<Run> {
	const agents: AgentEntry[] = [];
	const h = fakeSession({ root, agents, config: TEAM });
	const runId = await h.start();
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	return { h, runId, agents };
}

/** Admits and prepares one attempt of a planned lane the way manual direction does; returns its spawn key. */
async function start(run: Run, plan: RunPlan, laneName: string, dispatch: string): Promise<string> {
	const { h, runId, agents } = run;
	const lane = plan.lanes.find(candidate => candidate.name === laneName);
	if (lane === undefined) throw new Error(`no lane ${laneName}`);
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const needed = new Set(plan.lanes.flatMap(candidate => (candidate.dependsOn ?? []).map(dependency => dependency.lane)));
	const readiness = needed.size === 0 ? undefined : await h.controller.laneReadiness(plan, needed);
	const spawnKey = `${laneName}-${++serial}.${laneName}`;
	const bound = lanes.place({ name: laneName, agent, task: "do the lane" }, plan, h.config, readiness === undefined ? {} : { readiness });
	if (!bound.ok) throw new Error(bound.reason);
	const admission = lanes.admitChecked({ spawnKey, agent, outcome: "routed" }, { plan, config: h.config });
	if (!admission.ok) throw new Error(admission.reason);
	agents.push(agentEntry({ id: spawnKey, name: agent, role: lane.role, state: "idle", requests: 1, lastActivityAt: T0 + 1 }));
	expect(await h.controller.prepareAttempt({
		runId, lane: laneName, spawnKey, parentId: "main", dispatch, followUp: false, artifactMode: "shared", startedAt: T0,
	})).toEqual({ ok: true });
	return spawnKey;
}

/** Settles one prepared attempt and releases its lane, as the host's child-end event does. */
async function finish(run: Run, laneName: string, spawnKey: string, dispatch: string, over: Partial<AttemptReport> = {}): Promise<void> {
	const { h, runId } = run;
	await h.controller.settleAttempt({
		runId, lane: laneName, spawnKey, parentId: "main", dispatch, startedAt: T0, observedAt: T0 + 2,
		report: report({ runId, spawnKey, attemptId: `job:${dispatch}:${spawnKey}`, ...over }),
		citations: [],
	});
	h.controller.runLanes()?.releaseAgent(spawnKey);
}

/** One complete successful attempt that writes `content` to the lane's file. */
async function complete(run: Run, plan: RunPlan, laneName: string, dispatch: string, file: string, content: string): Promise<string> {
	const spawnKey = await start(run, plan, laneName, dispatch);
	await writeFile(path.join(root, file), content);
	await finish(run, laneName, spawnKey, dispatch);
	return spawnKey;
}

const row = (run: Run, id: string): RunResult | undefined => run.h.controller.active()?.results?.find(item => item.id === id);
const copy = (value: RunResult | undefined): RunResult | undefined => (value === undefined ? undefined : structuredClone(value));

/** B, C, A (on `aEdges`) and D all accepted under `plan`. */
async function acceptAll(run: Run, plan: RunPlan, aLane = "a-consume"): Promise<void> {
	await complete(run, plan, plan.lanes[0]!.name, "b1", "b.txt", "version: b1\n");
	await complete(run, plan, "c-produce", "c1", "c.txt", "version: c1\n");
	await complete(run, plan, aLane, "a1", "a.txt", "result: accepted\ninput: first\n");
	await complete(run, plan, "d-downstream", "d1", "d.txt", "downstream: ok\nfrom: a1\n");
	for (const id of ["b-result", "c-result", "a-result", "d-result"]) expect(row(run, id)).toMatchObject({ state: "accepted" });
}

async function blockOf(run: Run, plan: RunPlan, laneName: string): Promise<string | undefined> {
	const lane = plan.lanes.find(candidate => candidate.name === laneName)!;
	const needed = new Set((lane.dependsOn ?? []).map(dependency => dependency.lane));
	return dependencyBlock(lane, await run.h.controller.laneReadiness(plan, needed));
}

describe("S3 selective rework after an input swap", () => {
	test("A consumed B@1; swapping A's input to C@1 reopens A and D only, keeps B and C, and A reruns against C", async () => {
		const old = s3Plan(ON_B);
		const run = await begin(old);
		await acceptAll(run, old);
		const b = copy(row(run, "b-result"));
		const c = copy(row(run, "c-result"));
		const aBefore = copy(row(run, "a-result"));
		expect(aBefore?.consumed).toEqual([{ id: "b-result", version: b!.contentVersion! }]);
		expect(row(run, "d-result")?.consumed).toEqual([{ id: "a-result", version: aBefore!.contentVersion! }]);

		const next = s3Plan(ON_C);
		expect(await run.h.controller.setPlan(run.h.ctx, next)).toEqual({ ok: true });

		// The rework is not lost: A is reopened by the plan transition itself, before any attempt settles.
		const reopened = row(run, "a-result");
		expect(reopened).toMatchObject({ state: "unmet", origin: "plan", attemptId: aBefore?.attemptId });
		expect(reopened?.reason).toContain("선행 입력");
		expect(reopened?.contentVersion).toBeUndefined();
		// Transitive: D consumed A's old evidence.
		expect(row(run, "d-result")).toMatchObject({ state: "unmet" });
		expect(row(run, "d-result")?.contentVersion).toBeUndefined();
		// Preserved checkpoint: neither producer is touched.
		expect(row(run, "b-result")).toMatchObject({ state: "accepted", contentVersion: b?.contentVersion, attemptId: b?.attemptId });
		expect(row(run, "c-result")).toMatchObject({ state: "accepted", contentVersion: c?.contentVersion, attemptId: c?.attemptId });

		// A is runnable against C, and D waits for the new A.
		expect(await blockOf(run, next, "a-consume")).toBeUndefined();
		expect(await blockOf(run, next, "d-downstream")).toBeDefined();
		await complete(run, next, "a-consume", "a2", "a.txt", "result: accepted\ninput: c1\n");
		const aAfter = row(run, "a-result");
		expect(aAfter).toMatchObject({ state: "accepted", consumed: [{ id: "c-result", version: c?.contentVersion }] });
		expect(aAfter?.contentVersion).not.toBe(aBefore?.contentVersion);
		// D still stands on the old A version until it reruns; then it binds the new one.
		expect(row(run, "d-result")).toMatchObject({ state: "unmet" });
		await complete(run, next, "d-downstream", "d2", "d.txt", "downstream: ok\nfrom: a2\n");
		expect(row(run, "d-result")).toMatchObject({ state: "accepted", consumed: [{ id: "a-result", version: aAfter?.contentVersion }] });
		// Only the impacted work reran: B and C still carry their first attempts.
		expect(row(run, "b-result")).toMatchObject({ state: "accepted", attemptId: b?.attemptId });
		expect(row(run, "c-result")).toMatchObject({ state: "accepted", attemptId: c?.attemptId });
	});

	test("an A attempt queued under B cannot certify the C contract even though B@1 is still current", async () => {
		const old = s3Plan(ON_B);
		const run = await begin(old);
		await acceptAll(run, old);
		const b = copy(row(run, "b-result"));

		// A follow-up A attempt is admitted under the old declaration, then the plan swaps A's input to C.
		const queued = await start(run, old, "a-consume", "a-queued");
		const next = s3Plan(ON_C);
		expect(await run.h.controller.setPlan(run.h.ctx, next)).toEqual({ ok: true });
		expect(row(run, "a-result")).toMatchObject({ state: "unmet" });

		// It succeeds with changed content: still only evidence for "A on B", never for "A on C".
		await writeFile(path.join(root, "a.txt"), "result: accepted\ninput: b1 again\n");
		await finish(run, "a-consume", queued, "a-queued");
		const late = row(run, "a-result");
		expect(late).toMatchObject({
			state: "unmet",
			attemptId: `job:a-queued:${queued}`,
			consumed: [{ id: "b-result", version: b?.contentVersion }],
		});
		expect(late?.reason).toContain("계획의 선행 입력");
		expect(late?.contentVersion).toBeUndefined();
		expect(row(run, "d-result")).toMatchObject({ state: "unmet" });
		expect(await blockOf(run, next, "d-downstream")).toBeDefined();

		// A fresh attempt under the new declaration is what settles the contract.
		await complete(run, next, "a-consume", "a-new", "a.txt", "result: accepted\ninput: c1\n");
		expect(row(run, "a-result")).toMatchObject({ state: "accepted", consumed: [{ id: "c-result", version: row(run, "c-result")?.contentVersion }] });
	});

	test("a superseded attempt's exhausted host retry does not block the rerun the replan owes", async () => {
		const old = s3Plan(ON_B);
		const run = await begin(old);
		await acceptAll(run, old);
		const queued = await start(run, old, "a-consume", "a-queued");
		const next = s3Plan(ON_C);
		expect(await run.h.controller.setPlan(run.h.ctx, next)).toEqual({ ok: true });
		await finish(run, "a-consume", queued, "a-queued", { outcome: "failure", retry: { attempt: 2 } });
		expect(row(run, "a-result")).toMatchObject({ state: "unmet" });
		expect(row(run, "a-result")?.remedy).toBeUndefined();
		expect(row(run, "a-result")?.retryRoute).toBeUndefined();
		await complete(run, next, "a-consume", "a-new", "a.txt", "result: accepted\ninput: c1\n");
		expect(row(run, "a-result")).toMatchObject({ state: "accepted" });
	});

	test("an exhausted retry recorded against the old inputs is lifted by the input swap on the same route", async () => {
		const old = s3Plan(ON_B);
		const run = await begin(old);
		await complete(run, old, "b-produce", "b1", "b.txt", "version: b1\n");
		await complete(run, old, "c-produce", "c1", "c.txt", "version: c1\n");
		const failed = await start(run, old, "a-consume", "a-fail");
		await finish(run, "a-consume", failed, "a-fail", { outcome: "failure", retry: { attempt: 2 } });
		expect(row(run, "a-result")).toMatchObject({ state: "unmet", remedy: "retry" });

		// Same lane, role, goal and files: only the input changed, and that is a changed condition.
		const next = s3Plan(ON_C);
		expect(await run.h.controller.setPlan(run.h.ctx, next)).toEqual({ ok: true });
		expect(row(run, "a-result")?.remedy).toBeUndefined();
		await complete(run, next, "a-consume", "a-new", "a.txt", "result: accepted\ninput: c1\n");
		expect(row(run, "a-result")).toMatchObject({ state: "accepted", consumed: [{ id: "c-result", version: row(run, "c-result")?.contentVersion }] });
	});
});

describe("S3 preserved placement", () => {
	test("renaming the producer and consumer lanes with the same result ids and levels reopens nothing", async () => {
		const old = s3Plan(ON_B);
		const run = await begin(old);
		await acceptAll(run, old);
		const before = Object.fromEntries(["a-result", "b-result", "c-result", "d-result"].map(id => [id, copy(row(run, id))]));

		const renamed = s3Plan(ON_B, { b: "b-moved", a: "a-moved" });
		expect(await run.h.controller.setPlan(run.h.ctx, renamed)).toEqual({ ok: true });
		for (const id of ["a-result", "b-result", "c-result", "d-result"]) {
			expect(row(run, id)).toMatchObject({
				state: "accepted",
				contentVersion: before[id]?.contentVersion,
				attemptId: before[id]?.attemptId,
				...(before[id]?.consumed === undefined ? {} : { consumed: before[id]?.consumed }),
			});
		}
		expect(row(run, "a-result")?.lane).toBe("a-moved");
		expect(row(run, "b-result")?.lane).toBe("b-moved");
	});

	test("an in-flight A attempt survives a pure producer rename and settles normally", async () => {
		const old = s3Plan(ON_B);
		const run = await begin(old);
		await complete(run, old, "b-produce", "b1", "b.txt", "version: b1\n");
		const a = await start(run, old, "a-consume", "a1");
		expect(await run.h.controller.setPlan(run.h.ctx, s3Plan(ON_B, { b: "b-moved" }))).toEqual({ ok: true });
		await writeFile(path.join(root, "a.txt"), "result: accepted\ninput: b1\n");
		await finish(run, "a-consume", a, "a1");
		expect(row(run, "a-result")).toMatchObject({
			state: "accepted",
			attemptId: `job:a1:${a}`,
			consumed: [{ id: "b-result", version: row(run, "b-result")?.contentVersion }],
		});
	});
});

describe("S3 changed input declarations", () => {
	const variants: Array<[string, Edge[]]> = [
		["an added input", [...ON_B, ...ON_C]],
		["a removed input", []],
		["a different level on the same input", [{ lane: "b-produce", need: "reviewable" }]],
	];
	for (const [name, edges] of variants) {
		test(`${name} reopens A and, transitively, D while the producers keep their evidence`, async () => {
			const old = s3Plan(ON_B);
			const run = await begin(old);
			await acceptAll(run, old);
			const b = copy(row(run, "b-result"));
			expect(await run.h.controller.setPlan(run.h.ctx, s3Plan(edges))).toEqual({ ok: true });
			expect(row(run, "a-result")).toMatchObject({ state: "unmet", origin: "plan" });
			expect(row(run, "a-result")?.reason).toContain("선행 입력");
			expect(row(run, "d-result")).toMatchObject({ state: "unmet" });
			expect(row(run, "b-result")).toMatchObject({ state: "accepted", contentVersion: b?.contentVersion, attemptId: b?.attemptId });
			expect(row(run, "c-result")).toMatchObject({ state: "accepted" });
		});
	}
});
