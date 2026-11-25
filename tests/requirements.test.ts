/**
 * S3 requirement bookkeeping, through the real RunController APIs the attempt collector calls:
 * - an equivalent contract may move lanes and keep its obligation identity;
 * - a changed contract under the same id is refused before the plan or ledger is touched;
 * - a consumer records the producer versions it started from, and only those consumers reopen when a producer changes;
 * - an older attempt settlement cannot reinstate a success or overwrite newer evidence;
 * - a status-only replan reopens nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import {
	attemptInputsCurrent,
	changedInputRequirements,
	currentInputVersion,
	declaredInputFingerprint,
	declaredInputs,
	recordedInputsMatch,
	requirementConflict,
	resultInputs,
	sameDeclaredInputs,
	staleRequirementIds,
	staleRequirementIdsForPlan,
} from "../src/runtime/requirements.ts";
import { resultContractIdentity } from "../src/runtime/result-evidence.ts";
import type { AgentEntry, RunPlan, RunResult, StormConfig } from "../src/types.ts";
import { fakeSession, until, type FakeSession } from "./fake-session.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", quick: "a/q", reviewer: "a/r" });

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-requirements-")));
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (agents: AgentEntry[]) => fakeSession({ root, agents, config: TEAM });

const planFor = (lanes: RunPlan["lanes"], workers: Record<string, number>): RunPlan => ({
	lanes,
	workers,
	submittedAt: new Date(T0).toISOString(),
});

/** A report the adapter would accept; tests override only the host facts they exercise. */
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

/** Admits one planned lane the way manual direction does: unique handle, role-unique lane, checked late fence. */
async function admit(h: FakeSession, plan: RunPlan, agents: AgentEntry[], laneName: string, at = T0 + 1): Promise<string> {
	const lane = plan.lanes.find(candidate => candidate.name === laneName);
	if (lane === undefined) throw new Error(`no lane ${laneName}`);
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const needed = new Set(plan.lanes.flatMap(candidate => (candidate.dependsOn ?? []).map(dependency => dependency.lane)));
	const readiness = needed.size === 0 ? undefined : await h.controller.laneReadiness(plan, needed);
	const spawnKey = `${laneName}-${++admitSerial}`;
	const bound = lanes.place({ name: spawnKey, agent, task: "do the lane" }, plan, h.config, readiness === undefined ? {} : { readiness });
	if (!bound.ok) throw new Error(bound.reason);
	const admission = lanes.admitChecked({ spawnKey, agent, outcome: "routed" }, { plan, config: h.config });
	if (!admission.ok) throw new Error(admission.reason);
	agents.push(agentEntry({ id: spawnKey, name: agent, role: lane.role, state: "idle", requests: 1, lastActivityAt: at }));
	return spawnKey;
}

let admitSerial = 0;

/** Settles one attempt and releases its shared write reservation, as the host's child-end event does. */
async function settle(h: FakeSession, input: AttemptSettlement): Promise<void> {
	await h.controller.settleAttempt(input);
	h.controller.runLanes()?.releaseAgent(input.spawnKey);
}

const row = (h: FakeSession, id: string): RunResult | undefined => h.controller.active()?.results?.find(item => item.id === id);

/** The shared T05 shape: B produces, A consumes B, C is independent. */
const t05Plan = (progress?: string): RunPlan =>
	planFor(
		[
			{
				name: "b-produce",
				kind: "code",
				role: "implementer",
				files: ["b.txt"],
				goal: "Publish the B result",
				...(progress === undefined ? {} : { progress }),
				results: [{ id: "b-result", kind: "change", criterion: "b.txt holds a versioned result", path: "b.txt", contains: "version:" }],
			},
			{
				name: "a-consume",
				kind: "code",
				role: "quick",
				files: ["a.txt"],
				goal: "Consume the current B result",
				results: [{ id: "a-result", kind: "change", criterion: "a.txt accepts the B result", path: "a.txt", contains: "result: accepted" }],
				dependsOn: [{ lane: "b-produce", need: "result" }],
			},
			{
				name: "c-independent",
				kind: "code",
				role: "explorer",
				files: ["c.txt"],
				goal: "Produce an independent result",
				results: [{ id: "c-result", kind: "change", criterion: "c.txt is independent", path: "c.txt", contains: "independent" }],
			},
		],
		{ implementer: 1, quick: 2 },
	);

describe("requirement identity and dependency fingerprints", () => {
	test("the same id may move lanes only with the exact contract; a new criterion is refused", () => {
		const contract = { id: "r", kind: "change" as const, criterion: "file holds ok", path: "out.txt", contains: "ok" };
		const rows = [{ id: "r", identity: resultContractIdentity(contract) }] as RunResult[];
		expect(requirementConflict(rows, planFor([{ name: "moved", kind: "code", role: "implementer", results: [contract] }], { implementer: 1 }))).toBeUndefined();
		const changed = requirementConflict(
			rows,
			planFor([{ name: "moved", kind: "code", role: "implementer", results: [{ ...contract, criterion: "file maybe holds ok" }] }], { implementer: 1 }),
		);
		expect(changed).toContain("r");
		expect(changed).toContain("계약");
	});

	test("invalidation is transitive and preserves rows that consumed nothing", () => {
		const rows: RunResult[] = [
			{ id: "b", state: "accepted", contentVersion: "v1" },
			{ id: "a", state: "accepted", contentVersion: "va", consumed: [{ id: "b", version: "v1" }] },
			{ id: "d", state: "accepted", contentVersion: "vd", consumed: [{ id: "a", version: "va" }] },
			{ id: "c", state: "accepted", contentVersion: "vc" },
		];
		expect([...staleRequirementIds(rows)].sort()).toEqual([]);
		// Progress-only changes never touch contentVersion, so the same rows stay valid.
		rows[0]!.contentVersion = "v1";
		expect([...staleRequirementIds(rows)].sort()).toEqual([]);
		rows[0]!.contentVersion = "v2";
		expect([...staleRequirementIds(rows)].sort()).toEqual(["a", "d"]);
		// A requirement that had no usable input when consumed is stale immediately, even while the producer is still
		// missing; accepting the producer later cannot validate the earlier attempt.
		expect(currentInputVersion({ id: "b", state: "pending" })).toBe("missing");
		const missing: RunResult[] = [
			{ id: "b", state: "pending" },
			{ id: "a", state: "accepted", contentVersion: "va", consumed: [{ id: "b", version: "missing" }] },
		];
		expect([...staleRequirementIds(missing)]).toEqual(["a"]);
		missing[0] = { id: "b", state: "accepted", contentVersion: "v1" };
		expect([...staleRequirementIds(missing)]).toEqual(["a"]);
	});
});

describe("logical upstream identity and strength", () => {
	const contract = (id: string) => ({ id, kind: "change" as const, criterion: `${id} is visible`, path: `${id}.txt`, contains: "ok" });
	type Edge = NonNullable<RunPlan["lanes"][number]["dependsOn"]>[number];
	const planWith = (consumer: string, producer: string, edges: Edge[]): RunPlan =>
		planFor(
			[
				{ name: producer, kind: "code", role: "implementer", results: [contract("b-result")] },
				{ name: "c", kind: "code", role: "explorer", results: [contract("c-result")] },
				{ name: consumer, kind: "code", role: "quick", results: [contract("a-result")], dependsOn: edges },
				{ name: "d", kind: "code", role: "reviewer", results: [contract("d-result")], dependsOn: [{ lane: consumer, need: "result" }] },
			],
			{},
		);
	const laneOf = (plan: RunPlan, name: string) => plan.lanes.find(lane => lane.name === name)!;

	test("producer and consumer renames keep the exact logical input fingerprint", () => {
		const base = planWith("a", "b", [{ lane: "b", need: "result" }]);
		const renamed = planWith("a-moved", "b-moved", [{ lane: "b-moved", need: "result" }]);
		const before = declaredInputs(base, laneOf(base, "a"));
		expect(before).toEqual([{ id: "b-result", need: "result" }]);
		expect(sameDeclaredInputs(before, declaredInputs(renamed, laneOf(renamed, "a-moved")))).toBe(true);
		expect(declaredInputFingerprint(before)).toBe(declaredInputFingerprint(declaredInputs(renamed, laneOf(renamed, "a-moved"))));
		expect([...changedInputRequirements(base, renamed)]).toEqual([]);
		expect(resultInputs(renamed, "a-result")).toEqual(before);
		expect(attemptInputsCurrent(renamed, ["a-result"], before)).toBe(true);
	});

	test("order and duplicate weaker edges are equivalent; added, removed, swapped or re-levelled inputs change", () => {
		const base = planWith("a", "b", [{ lane: "b", need: "result" }]);
		const before = declaredInputs(base, laneOf(base, "a"));
		const reversed = planWith("a", "b", [{ lane: "c", need: "integrated" }, { lane: "b", need: "result" }]);
		const two = planWith("a", "b", [{ lane: "b", need: "result" }, { lane: "c", need: "integrated" }]);
		expect(declaredInputFingerprint(declaredInputs(reversed, laneOf(reversed, "a"))))
			.toBe(declaredInputFingerprint(declaredInputs(two, laneOf(two, "a"))));
		const duplicate = planWith("a", "b", [{ lane: "b", need: "reviewable" }, { lane: "b", need: "result" }]);
		expect(sameDeclaredInputs(before, declaredInputs(duplicate, laneOf(duplicate, "a")))).toBe(true);
		expect([...changedInputRequirements(base, duplicate)]).toEqual([]);

		const swapped = planWith("a", "b", [{ lane: "c", need: "result" }]);
		const added = planWith("a", "b", [{ lane: "b", need: "result" }, { lane: "c", need: "result" }]);
		const removed = planWith("a", "b", []);
		const weaker = planWith("a", "b", [{ lane: "b", need: "reviewable" }]);
		for (const next of [swapped, added, removed, weaker]) {
			expect([...changedInputRequirements(base, next)]).toEqual(["a-result"]);
			expect(attemptInputsCurrent(next, ["a-result"], before)).toBe(false);
		}
		expect(resultInputs(swapped, "z-result")).toBeUndefined();
		expect(attemptInputsCurrent(swapped, ["z-result"], before)).toBe(false);
	});

	test("the recorded producer-id snapshot compares as an unordered identity set; versions are not its half", () => {
		const base = planWith("a", "b", [{ lane: "b", need: "result" }]);
		const before = declaredInputs(base, laneOf(base, "a"));
		expect(recordedInputsMatch(before, [{ id: "b-result", version: "v1" }])).toBe(true);
		expect(recordedInputsMatch(before, [{ id: "b-result", version: "missing" }])).toBe(true);
		expect(recordedInputsMatch(before, [])).toBe(false);
		expect(recordedInputsMatch(before, undefined)).toBe(false);
		expect(recordedInputsMatch(before, [{ id: "c-result", version: "v1" }])).toBe(false);
		expect(recordedInputsMatch([], undefined)).toBe(true);
		const two = planWith("a", "b", [{ lane: "b", need: "result" }, { lane: "c", need: "integrated" }]);
		const both = declaredInputs(two, laneOf(two, "a"));
		expect(recordedInputsMatch(both, [{ id: "c-result", version: "vc" }, { id: "b-result", version: "vb" }])).toBe(true);
		expect(recordedInputsMatch(both, [{ id: "b-result", version: "vb" }, { id: "b-result", version: "vb" }])).toBe(false);
	});

	test("a replanned input swap reopens the consumer and its consumers before any row write", () => {
		const previous = planWith("a", "b", [{ lane: "b", need: "result" }]);
		const next = planWith("a", "b", [{ lane: "c", need: "result" }]);
		const rows: RunResult[] = [
			{ id: "b-result", state: "accepted", contentVersion: "vb" },
			{ id: "c-result", state: "accepted", contentVersion: "vc" },
			{ id: "a-result", state: "accepted", contentVersion: "va", consumed: [{ id: "b-result", version: "vb" }] },
			{ id: "d-result", state: "accepted", contentVersion: "vd", consumed: [{ id: "a-result", version: "va" }] },
		];
		expect([...staleRequirementIds(rows)]).toEqual([]);
		expect([...staleRequirementIdsForPlan(rows, previous)]).toEqual([]);
		expect([...staleRequirementIdsForPlan(rows, next, previous)].sort()).toEqual(["a-result", "d-result"]);
		const renamed = planWith("a-moved", "b-moved", [{ lane: "b-moved", need: "result" }]);
		expect([...staleRequirementIdsForPlan(rows, renamed, previous)]).toEqual([]);
	});

	test("a different edge level or a weaker current producer state reopens even with the same content version", () => {
		const previous = planWith("a", "b", [{ lane: "b", need: "reviewable" }]);
		const next = planWith("a", "b", [{ lane: "b", need: "result" }]);
		const rows: RunResult[] = [
			{ id: "b-result", state: "accepted", contentVersion: "vb" },
			{ id: "a-result", state: "accepted", contentVersion: "va", consumed: [{ id: "b-result", version: "vb" }] },
			{ id: "d-result", state: "accepted", contentVersion: "vd", consumed: [{ id: "a-result", version: "va" }] },
			{ id: "c-result", state: "accepted", contentVersion: "vc" },
		];
		expect([...changedInputRequirements(previous, next)]).toEqual(["a-result"]);
		expect([...staleRequirementIdsForPlan(rows, next, previous)].sort()).toEqual(["a-result", "d-result"]);
		// Same plan, same bytes: an accepted producer downgraded to reviewable no longer satisfies a `result` edge.
		const lowered = rows.map(row => (row.id === "b-result" ? { ...row, state: "reviewable" as const } : row));
		expect([...staleRequirementIds(lowered)]).toEqual([]);
		expect([...staleRequirementIdsForPlan(lowered, next)].sort()).toEqual(["a-result", "d-result"]);
		// A reviewable producer remains usable for a `reviewable` edge.
		const weak = planWith("a", "b", [{ lane: "b", need: "reviewable" }]);
		expect([...staleRequirementIdsForPlan(lowered, weak)]).toEqual([]);
	});

	test("a missing recorded fingerprint, a finalized marker, or an orphan id does not exempt plan invalidation", () => {
		const plan = planWith("a", "b", [{ lane: "b", need: "result" }]);
		const rows: RunResult[] = [
			{ id: "b-result", state: "accepted", contentVersion: "vb" },
			{ id: "a-result", state: "accepted", contentVersion: "va", finalized: "revoked" },
			{ id: "d-result", state: "accepted", contentVersion: "vd", consumed: [{ id: "a-result", version: "va" }] },
			{ id: "orphan-result", state: "accepted", contentVersion: "vo" },
			{ id: "c-result", state: "accepted", contentVersion: "vc" },
		];
		expect([...staleRequirementIdsForPlan(rows, plan)].sort()).toEqual(["a-result", "d-result"]);
		expect([...staleRequirementIdsForPlan(rows, undefined)]).toEqual([]);
	});
});

describe("controller requirement ledger", () => {
	test("T05: a replaced producer reopens only its consumer; the consumer's late success cannot reinstate it", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const plan = t05Plan();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });

		// B v1, accepted.
		const b1 = await admit(h, plan, agents, "b-produce");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-produce", spawnKey: b1, parentId: "main", dispatch: "b1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "version: v1\n");
		await settle(h, {
			runId, lane: "b-produce", spawnKey: b1, parentId: "main", dispatch: "b1", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b1, attemptId: `job:b1:${b1}` }),
			citations: [],
		});
		const bVersion1 = row(h, "b-result")?.contentVersion;
		expect(row(h, "b-result")).toMatchObject({ state: "accepted", contentVersion: bVersion1 });

		// A consumes B v1 and C is an independent accepted result.
		const a1 = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: a1, parentId: "main", dispatch: "a1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "a.txt"), "result: accepted\ninput: version v1\n");
		await settle(h, {
			runId, lane: "a-consume", spawnKey: a1, parentId: "main", dispatch: "a1", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: a1, attemptId: `job:a1:${a1}` }),
			citations: [],
		});
		expect(row(h, "a-result")).toMatchObject({ state: "accepted", consumed: [{ id: "b-result", version: bVersion1 }] });
		const aVersion = row(h, "a-result")?.contentVersion;

		const c1 = await admit(h, plan, agents, "c-independent");
		expect(await h.controller.prepareAttempt({ runId, lane: "c-independent", spawnKey: c1, parentId: "main", dispatch: "c1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "c.txt"), "independent\n");
		await settle(h, {
			runId, lane: "c-independent", spawnKey: c1, parentId: "main", dispatch: "c1", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: c1, attemptId: `job:c1:${c1}` }),
			citations: [],
		});
		expect(row(h, "c-result")).toMatchObject({ state: "accepted" });

		// A second A attempt is admitted against B v1 while B v2 is produced concurrently. Its success settles last.
		const a2 = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: a2, parentId: "main", dispatch: "a2", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		const b2 = await admit(h, plan, agents, "b-produce");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-produce", spawnKey: b2, parentId: "main", dispatch: "b2", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "version: v2\n");
		await settle(h, {
			runId, lane: "b-produce", spawnKey: b2, parentId: "main", dispatch: "b2", startedAt: T0, observedAt: T0 + 2,
			report: report({ runId, spawnKey: b2, attemptId: `job:b2:${b2}` }),
			citations: [],
		});
		const bVersion2 = row(h, "b-result")?.contentVersion;
		expect(bVersion2).not.toBe(bVersion1);
		// B changed: A's old acceptance is reopened, C never consumed B and stays accepted.
		expect(row(h, "a-result")).toMatchObject({ state: "unmet" });
		expect(row(h, "a-result")?.reason).toContain("선행 결과");
		expect(row(h, "c-result")).toMatchObject({ state: "accepted" });

		await writeFile(path.join(root, "a.txt"), "result: accepted\ninput: version v1\n");
		await settle(h, {
			runId, lane: "a-consume", spawnKey: a2, parentId: "main", dispatch: "a2", startedAt: T0, observedAt: T0 + 3,
			report: report({ runId, spawnKey: a2, attemptId: `job:a2:${a2}` }),
			citations: [],
		});
		// The late success used B v1; it cannot reinstate A against B v2 or revive the old content version.
		const late = row(h, "a-result");
		expect(late).toMatchObject({ state: "unmet", attemptId: `job:a2:${a2}`, consumed: [{ id: "b-result", version: bVersion1 }] });
		expect(late?.contentVersion).toBeUndefined();
		expect(late?.contentVersion).not.toBe(aVersion);
	});

	test("T05 control: a progress-only replan reopens nothing", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const plan = t05Plan();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const b = await admit(h, plan, agents, "b-produce");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-produce", spawnKey: b, parentId: "main", dispatch: "p", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "version: control\n");
		await settle(h, {
			runId, lane: "b-produce", spawnKey: b, parentId: "main", dispatch: "p", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b, attemptId: `job:p:${b}` }), citations: [],
		});
		const a = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: a, parentId: "main", dispatch: "q", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await settle(h, {
			runId, lane: "a-consume", spawnKey: a, parentId: "main", dispatch: "q", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: a, attemptId: `job:q:${a}` }), citations: [],
		});
		const before = { b: row(h, "b-result"), a: row(h, "a-result") };
		expect(before.b).toMatchObject({ state: "accepted" });
		expect(before.a).toMatchObject({ state: "accepted" });

		expect(await h.controller.setPlan(h.ctx, t05Plan("B result unchanged; status only"))).toEqual({ ok: true });
		expect(row(h, "b-result")).toMatchObject({ state: "accepted", contentVersion: before.b?.contentVersion });
		expect(row(h, "a-result")).toMatchObject({
			state: "accepted",
			contentVersion: before.a?.contentVersion,
			consumed: [{ id: "b-result", version: before.b?.contentVersion }],
		});
	});

	test("an accepted requirement keeps its proof and its consumer across an exact contract transfer", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const plan = t05Plan();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const b = await admit(h, plan, agents, "b-produce");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-produce", spawnKey: b, parentId: "main", dispatch: "tb1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "version: v1\n");
		await settle(h, {
			runId, lane: "b-produce", spawnKey: b, parentId: "main", dispatch: "tb1", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b, attemptId: `job:tb1:${b}` }), citations: [],
		});
		const a = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: a, parentId: "main", dispatch: "ta1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await settle(h, {
			runId, lane: "a-consume", spawnKey: a, parentId: "main", dispatch: "ta1", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: a, attemptId: `job:ta1:${a}` }), citations: [],
		});
		const bBefore = row(h, "b-result");
		const aBefore = row(h, "a-result");
		expect(bBefore).toMatchObject({ state: "accepted" });
		expect(aBefore).toMatchObject({ state: "accepted" });

		// The exact b-result contract moves to a new lane and A's edge follows it. Neither proof is reopened.
		const moved = t05Plan();
		moved.lanes[0] = { ...moved.lanes[0]!, name: "b-moved" };
		moved.lanes[1] = { ...moved.lanes[1]!, dependsOn: [{ lane: "b-moved", need: "result" }] };
		expect(await h.controller.setPlan(h.ctx, moved)).toEqual({ ok: true });
		expect(row(h, "b-result")).toMatchObject({
			state: "accepted",
			lane: "b-moved",
			contentVersion: bBefore?.contentVersion,
			attemptId: bBefore?.attemptId,
		});
		expect(row(h, "a-result")).toMatchObject({
			state: "accepted",
			contentVersion: aBefore?.contentVersion,
			consumed: [{ id: "b-result", version: bBefore?.contentVersion }],
		});
	});

	test("a newer attempt fences an older settlement even when the old one arrives first", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const plan = t05Plan();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const b = await admit(h, plan, agents, "b-produce");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-produce", spawnKey: b, parentId: "main", dispatch: "sb", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "version: v1\n");
		await settle(h, {
			runId, lane: "b-produce", spawnKey: b, parentId: "main", dispatch: "sb", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b, attemptId: `job:sb:${b}` }), citations: [],
		});

		const old = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: old, parentId: "main", dispatch: "old", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		// The host reports the old worker's turn end before its async result arrives, so the retry is admissible.
		h.controller.runLanes()?.releaseAgent(old);
		const latest = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: latest, parentId: "main", dispatch: "new", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });

		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await settle(h, {
			runId, lane: "a-consume", spawnKey: old, parentId: "main", dispatch: "old", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: old, attemptId: `job:old:${old}` }), citations: [],
		});
		// The superseded attempt changed nothing; the requirement is still pending for the newer attempt.
		expect(row(h, "a-result")).toMatchObject({ state: "pending" });

		await settle(h, {
			runId, lane: "a-consume", spawnKey: latest, parentId: "main", dispatch: "new", startedAt: T0, observedAt: T0 + 2,
			report: report({ runId, spawnKey: latest, attemptId: `job:new:${latest}` }), citations: [],
		});
		expect(row(h, "a-result")).toMatchObject({ state: "accepted", attemptId: `job:new:${latest}` });
	});

	test("T04: a failed requirement survives a dropped lane, then an exact contract transfer repairs only it", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const bContract = { id: "b-result", kind: "change" as const, criterion: "b.txt holds the accepted result", path: "b.txt", contains: "b-status: ok" };
		const initial = planFor(
			[
				{ name: "a-read", kind: "code", role: "explorer", files: ["a.txt"], results: [{ id: "a-result", kind: "change", criterion: "a.txt is ready", path: "a.txt", contains: "a-ok" }] },
				{ name: "b-write", kind: "code", role: "implementer", files: ["b.txt"], results: [bContract] },
				{
					name: "review", kind: "review", role: "reviewer", goal: "Verify the integration",
					dependsOn: [{ lane: "a-read", need: "reviewable" }, { lane: "b-write", need: "result" }],
				},
			],
			{ quick: 1, implementer: 1, reviewer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, initial)).toEqual({ ok: true });

		// A succeeds and is never rerun; B fails for real.
		const a = await admit(h, initial, agents, "a-read");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-read", spawnKey: a, parentId: "main", dispatch: "ra", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "a.txt"), "a-ok\n");
		await settle(h, {
			runId, lane: "a-read", spawnKey: a, parentId: "main", dispatch: "ra", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: a, attemptId: `job:ra:${a}` }), citations: [],
		});
		const b = await admit(h, initial, agents, "b-write");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-write", spawnKey: b, parentId: "main", dispatch: "rb", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await settle(h, {
			runId, lane: "b-write", spawnKey: b, parentId: "main", dispatch: "rb", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b, attemptId: `job:rb:${b}`, outcome: "failure", retry: { attempt: 1 } }), citations: [],
		});
		const bIdentity = row(h, "b-result")?.identity;
		const aVersion = row(h, "a-result")?.contentVersion;
		expect(row(h, "b-result")).toMatchObject({ state: "unmet", remedy: "retry" });
		expect(row(h, "b-result")?.reason).toContain("재시도");

		// Dropping b-write is allowed, but the obligation stays in the ledger with no lane and blocks a normal close.
		const dropped = planFor(
			[
				initial.lanes[0]!,
				{ name: "review", kind: "review", role: "reviewer", goal: "Verify the integration", dependsOn: [{ lane: "a-read", need: "reviewable" }] },
			],
			{ quick: 1, reviewer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, dropped)).toEqual({ ok: true });
		expect(row(h, "b-result")).toMatchObject({ state: "unmet", identity: bIdentity });
		expect(row(h, "b-result")?.lane).toBeUndefined();
		expect(row(h, "b-result")?.reason).toContain("계획에서 빠진");
		expect(row(h, "a-result")).toMatchObject({ state: "accepted", contentVersion: aVersion });
		const final = await h.controller.finish("verified");
		expect(final?.endReason).toBe("no-progress");
		expect(final?.status).not.toBe("done");
		expect(final?.results?.find(item => item.id === "b-result")).toMatchObject({ state: "unmet", identity: bIdentity });
	});

	test("T04 repair: only the exact contract transfer keeps the id, identity and existing A result", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const bContract = { id: "b-result", kind: "change" as const, criterion: "b.txt holds the accepted result", path: "b.txt", contains: "b-status: ok" };
		const initial = planFor(
			[
				{ name: "a-read", kind: "code", role: "explorer", files: ["a.txt"], results: [{ id: "a-result", kind: "change", criterion: "a.txt is ready", path: "a.txt", contains: "a-ok" }] },
				{ name: "b-write", kind: "code", role: "implementer", files: ["b.txt"], results: [bContract] },
			],
			{ quick: 1, implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, initial)).toEqual({ ok: true });
		const a = await admit(h, initial, agents, "a-read");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-read", spawnKey: a, parentId: "main", dispatch: "ta", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "a.txt"), "a-ok\n");
		await settle(h, {
			runId, lane: "a-read", spawnKey: a, parentId: "main", dispatch: "ta", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: a, attemptId: `job:ta:${a}` }), citations: [],
		});
		const b = await admit(h, initial, agents, "b-write");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-write", spawnKey: b, parentId: "main", dispatch: "tb", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await settle(h, {
			runId, lane: "b-write", spawnKey: b, parentId: "main", dispatch: "tb", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b, attemptId: `job:tb:${b}`, outcome: "failure", retry: { attempt: 1 } }), citations: [],
		});
		const bIdentity = row(h, "b-result")?.identity;
		expect(row(h, "b-result")).toMatchObject({ state: "unmet", remedy: "retry" });
		expect(row(h, "b-result")?.reason).toContain("재시도");

		// A weakened "repair" under the same id is refused and changes nothing.
		const weaker = planFor(
			[
				initial.lanes[0]!,
				{ name: "b-repair", kind: "code", role: "quick", files: ["b.txt"], results: [{ ...bContract, contains: "b-status:" }] },
			],
			{ quick: 1 },
		);
		const refused = await h.controller.setPlan(h.ctx, weaker);
		expect(refused.ok).toBe(false);
		expect(row(h, "b-result")).toMatchObject({ state: "unmet", lane: "b-write", identity: bIdentity });

		// The exact contract may move to b-repair: requirement, state and A's result are preserved.
		const repair = planFor(
			[
				initial.lanes[0]!,
				{ name: "b-repair", kind: "code", role: "quick", files: ["b.txt"], results: [bContract] },
			],
			{ quick: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, repair)).toEqual({ ok: true });
		expect(row(h, "b-result")).toMatchObject({ state: "unmet", lane: "b-repair", identity: bIdentity });
		expect(row(h, "a-result")).toMatchObject({ state: "accepted" });

		const repairKey = await admit(h, repair, agents, "b-repair");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-repair", spawnKey: repairKey, parentId: "main", dispatch: "tr", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "b-status: ok\n");
		await settle(h, {
			runId, lane: "b-repair", spawnKey: repairKey, parentId: "main", dispatch: "tr", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: repairKey, attemptId: `job:tr:${repairKey}` }), citations: [],
		});
		expect(row(h, "b-result")).toMatchObject({ state: "accepted", lane: "b-repair", identity: bIdentity });
		expect(row(h, "b-result")?.remedy).toBeUndefined();
		expect(row(h, "b-result")?.unblock).toBeUndefined();
		// A was not rerun and remains the same accepted result.
		expect(row(h, "a-result")).toMatchObject({ state: "accepted" });
		expect(agents.filter(agent => agent.role === "explorer").length).toBe(1); // A once.
		expect(agents.filter(agent => agent.role === "quick").length).toBe(1); // b-repair once.
	});

	test("the round message names the open consumer from its official row, not lane counts", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const plan = t05Plan();
		plan.lanes = plan.lanes.filter(lane => lane.name !== "c-independent");
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const b1 = await admit(h, plan, agents, "b-produce");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-produce", spawnKey: b1, parentId: "main", dispatch: "mb1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "version: v1\n");
		await settle(h, {
			runId, lane: "b-produce", spawnKey: b1, parentId: "main", dispatch: "mb1", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b1, attemptId: `job:mb1:${b1}` }), citations: [],
		});
		const a1 = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: a1, parentId: "main", dispatch: "ma1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "a.txt"), "result: accepted\n");
		await settle(h, {
			runId, lane: "a-consume", spawnKey: a1, parentId: "main", dispatch: "ma1", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: a1, attemptId: `job:ma1:${a1}` }), citations: [],
		});
		const a2 = await admit(h, plan, agents, "a-consume");
		expect(await h.controller.prepareAttempt({ runId, lane: "a-consume", spawnKey: a2, parentId: "main", dispatch: "ma2", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		const b2 = await admit(h, plan, agents, "b-produce");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-produce", spawnKey: b2, parentId: "main", dispatch: "mb2", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "b.txt"), "version: v2\n");
		await settle(h, {
			runId, lane: "b-produce", spawnKey: b2, parentId: "main", dispatch: "mb2", startedAt: T0, observedAt: T0 + 2,
			report: report({ runId, spawnKey: b2, attemptId: `job:mb2:${b2}` }), citations: [],
		});
		await settle(h, {
			runId, lane: "a-consume", spawnKey: a2, parentId: "main", dispatch: "ma2", startedAt: T0, observedAt: T0 + 3,
			report: report({ runId, spawnKey: a2, attemptId: `job:ma2:${a2}` }), citations: [],
		});
		expect(row(h, "a-result")).toMatchObject({ state: "unmet" });

		// One settled turn with no accepted change yet opens a round: the message must carry the official open row.
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length >= 2);
		const round = h.sent[1] ?? "";
		expect(round).toContain("a-result");
		expect(round).toContain("a-consume");
		expect(round).toContain("Next:");
		expect(round).not.toContain("verified");
	});

	test("an exhausted native retry blocks the same route even after a rename and allows a genuinely different route", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const contract = { id: "b-result", kind: "change" as const, criterion: "b.txt holds the accepted result", path: "b.txt", contains: "b-status: ok" };
		const initial = planFor(
			[{ name: "b-write", kind: "code", role: "implementer", files: ["b.txt"], goal: "Produce the required B result", results: [contract] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, initial)).toEqual({ ok: true });
		const b = await admit(h, initial, agents, "b-write");
		expect(await h.controller.prepareAttempt({ runId, lane: "b-write", spawnKey: b, parentId: "main", dispatch: "eb", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await settle(h, {
			runId, lane: "b-write", spawnKey: b, parentId: "main", dispatch: "eb", startedAt: T0, observedAt: T0 + 1,
			report: report({ runId, spawnKey: b, attemptId: `job:eb:${b}`, outcome: "failure", retry: { attempt: 1 } }), citations: [],
		});
		expect(row(h, "b-result")).toMatchObject({ state: "unmet", remedy: "retry" });
		const route = row(h, "b-result")?.retryRoute;
		expect(route).toBeTruthy();

		// A rename with the same role, goal, files and isolation is the same route; it gets no fresh attempt.
		const renamed = planFor(
			[{ name: "b-renamed", kind: "code", role: "implementer", files: ["b.txt"], goal: "Produce the required B result", results: [contract] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, renamed)).toEqual({ ok: true });
		expect(row(h, "b-result")).toMatchObject({ lane: "b-renamed", remedy: "retry", retryRoute: route });
		const sameRoute = await h.controller.prepareAttempt({ runId, lane: "b-renamed", spawnKey: "same-route", parentId: "main", dispatch: "same", followUp: false, artifactMode: "shared", startedAt: T0 });
		expect(sameRoute.ok).toBe(false);
		if (!sameRoute.ok) expect(sameRoute.reason).toContain("같은 레인/경로");

		// A genuinely different approved route may reassign the same requirement; its retry remedy is cleared.
		const different = planFor(
			[{ name: "b-repair", kind: "code", role: "quick", files: ["b.txt"], goal: "Recover the required B result", results: [contract] }],
			{ quick: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, different)).toEqual({ ok: true });
		expect(row(h, "b-result")).toMatchObject({ lane: "b-repair" });
		expect(row(h, "b-result")?.remedy).toBeUndefined();
		expect(row(h, "b-result")?.retryRoute).toBeUndefined();
		const repair = await h.controller.prepareAttempt({ runId, lane: "b-repair", spawnKey: "different-route", parentId: "main", dispatch: "different", followUp: false, artifactMode: "shared", startedAt: T0 });
		expect(repair).toEqual({ ok: true });
	});
});
