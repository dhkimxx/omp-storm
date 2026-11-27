/**
 * W2: every surface tells the truth about isolated work in 0.29.0.
 *
 * Row 1: an accepted retained artifact is called kept, with a digest-bound patch reference, and no count or banner
 * reads as if the target tree held it. Row 2: an isolated `change` is never accepted or reviewable, whatever the parent
 * tree holds (ISO P7-B), and the reason names the missing integration. Row 5: an `integrated` prerequisite on an
 * isolated producer cannot be met, and the refusal says so. Rows 6/7/9/11: the plan reply, the worker contract and the
 * closeout carry the checkout qualification. D11: every added surface stays fixed-size at a hundred workers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import {
	CHECKOUT_CLEANUP_NOTE,
	CHECKOUT_PLACEMENT_NOTE,
	CHECKOUT_SNAPSHOT_NOTE,
} from "../src/runtime/contract-text.ts";
import {
	closeoutBrief,
	closeoutHandoff,
	CLOSEOUT_HANDOFF_MAX_BYTES,
	RETAINED_ONLY_VERDICT,
	STOP_SEPARATE_NOTE,
} from "../src/runtime/closeout.ts";
import {
	ISOLATED_CHANGE_REASON,
	resultContractIdentity,
} from "../src/runtime/result-evidence.ts";
import { revalidateCheckpointProof } from "../src/runtime/checkpoint-import.ts";
import { CANCEL_IDENTITY_UNKNOWN, EMPTY_CAPTURE_REASON, ISOLATED_BRANCH_UNREAD, ISOLATED_INTEGRATED_REASON } from "../src/runtime/controller.ts";
import { dependencyBlock, dependencyStart, ISOLATED_STALE_ADVICE, type LaneReadinessView } from "../src/runtime/lanes.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { treeFingerprint } from "../src/runtime/rounds.ts";
import { resultFacts } from "../src/runtime/result-facts.ts";
import {
	CHECKOUT_PLAN_NOTE,
	ISOLATED_INTEGRATED_WARNING,
	PRIVATE_OVERLAP_WARNING,
	validatePlan,
} from "../src/plan/validate.ts";
import { INTEGRATED_UNAVAILABLE, renderPlanView } from "../src/tool/plan-view.ts";
import type { AgentEntry, RunPlan, RunRecord, RunResult, StormConfig } from "../src/types.ts";
import { renderCloseout } from "../src/view/closeout.ts";
import { isolationNote } from "../src/view/render.ts";
import { liveMetricFacts } from "../src/view/live-metrics.ts";
import { RETAINED_ACCEPTED, RETAINED_REF_UNKNOWN, resultRowText, type ResultRow } from "../src/view/results.ts";
import { fakeSession, type FakeSession } from "./fake-session.ts";
import { agentEntry, runRecord, teamOf, treeOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const START = "2026-11-20T09:00:00.000Z";
const TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", quick: "a/q", reviewer: "a/r" });

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const plan = (...lanes: RunPlan["lanes"]): RunPlan => ({
	lanes,
	workers: { implementer: lanes.length, explorer: lanes.length },
	submittedAt: START,
});

const artifact = (id: string, over: Partial<NonNullable<RunPlan["lanes"][number]["results"]>[number]> = {}) => ({
	id,
	kind: "artifact" as const,
	criterion: `${id} carries the candidate`,
	path: "i0.txt",
	contains: "LANE-I0",
	...over,
});

const lane = (name: string, over: Partial<RunPlan["lanes"][number]> = {}) => ({
	name,
	kind: "code" as const,
	role: "implementer" as const,
	files: ["i0.txt"],
	...over,
});

/** An accepted retained artifact row exactly as S1 binds it. */
const keptRow = (id: string, laneName: string, artifactPath: string, digest: string): RunResult => {
	const contract = artifact(id);
	const identity = resultContractIdentity(contract);
	return {
		id,
		lane: laneName,
		state: "accepted",
		attemptId: "job:I0:I0",
		identity,
		contentVersion: "a".repeat(64),
		contract,
		proof: {
			item: {
				id,
				kind: "artifact",
				identity,
				criterion: contract.criterion,
				attemptId: "job:I0:I0",
				state: "accepted",
				path: "i0.txt",
				artifact: "file",
				digest,
			},
			artifact: { attemptId: "job:I0:I0", path: artifactPath, form: "file", expectedDigest: digest },
		},
	};
};

describe("row 1: a retained artifact is kept, not landed", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-w2-kept-")));
	});
	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	const fixture = (rows: RunResult[]): RunRecord =>
		runRecord({
			startedAt: START,
			endedAt: "2026-11-20T09:01:00.000Z",
			status: "done",
			endReason: "verified",
			results: rows,
			plan: plan(lane("I0", { isolationReason: "isolated candidate", results: [artifact("i0-patch")] })),
		});

	test("the kept row names its digest-bound source, and the target path is not called its source", async () => {
		const source = path.join(tmp, "I0.patch");
		await writeFile(source, "LANE-I0\n");
		const digest = sha("LANE-I0\n");
		const facts = resultFacts(fixture([keptRow("i0-patch", "I0", source, digest)]));
		expect(facts.retained.count).toBe(1);
		expect(facts.progress.counts.retained).toBe(1);
		expect(facts.progress.parts[0]).toStartWith(RETAINED_ACCEPTED);
		const row = facts.progress.rows[0] as ResultRow;
		expect(row.kept).toBe(true);
		expect(row.capture).toContain(digest.slice(0, 12));
		expect(row.capture).toContain("I0.patch");
		const text = resultRowText(row);
		expect(text).toContain(`대상: i0.txt`);
		expect(text).toContain("보존:");
		expect(text).not.toContain(tmp);
	});

	test("an old accepted isolated artifact without a bound source says the reference is unknown", async () => {
		const row: RunResult = {
			id: "i0-patch",
			lane: "I0",
			state: "accepted",
			attemptId: "job:I0:I0",
			identity: resultContractIdentity(artifact("i0-patch")),
			contract: artifact("i0-patch"),
		};
		const facts = resultFacts(fixture([row]));
		expect(facts.retained.count).toBe(1);
		expect(facts.progress.rows[0]?.capture).toBe(RETAINED_REF_UNKNOWN);
	});

	test("closeout calls it kept, shows the reference, and carries no success mark or tree count", async () => {
		const source = path.join(tmp, "I0.patch");
		await writeFile(source, "LANE-I0\n");
		const digest = sha("LANE-I0\n");
		const run = fixture([keptRow("i0-patch", "I0", source, digest)]);
		const brief = closeoutBrief(run);
		// A retained acceptance deserves a card: the one-line closeout would hide where the bytes are.
		expect(brief.tier).toBe("card");
		expect(brief.official.label).toContain(RETAINED_ONLY_VERDICT);
		expect(brief.official.tone).toBe("accent");
		expect(brief.retained?.count).toBe(1);
		const card = renderCloseout(brief, false);
		expect(card.markdown).toContain(`${RETAINED_ACCEPTED} 1/1`);
		expect(card.markdown).toContain("보존:");
		expect(card.markdown).toContain(digest.slice(0, 12));
		expect(card.markdown).toContain(CHECKOUT_PLACEMENT_NOTE);
		expect(card.markdown).toContain(CHECKOUT_CLEANUP_NOTE);
		// No tick and no count that reads as landed tree work.
		const title = card.info.find(line => line.emphasis === "title");
		expect(title?.icon).toBe("status.info");
		expect(card.markdown).not.toContain("· 수용 1/1");
		expect(closeoutHandoff(run)).toContain("Retained: 1");
	});

	test("a hundred retained rows stay one bounded closeout and one reference, not a list", async () => {
		const source = path.join(tmp, "I0.patch");
		await writeFile(source, "LANE-I0\n");
		const digest = sha("LANE-I0\n");
		const rows = Array.from({ length: 100 }, (_, i) => ({ ...keptRow(`r${i}`, "I0", source, digest), id: `r${i}` }));
		const run = fixture(rows);
		const facts = resultFacts(run);
		expect(facts.retained.count).toBe(100);
		expect(facts.retained.capture).toBeDefined();
		const card = renderCloseout(closeoutBrief(run), false).markdown;
		expect(card.split("\n").length).toBeLessThan(20);
		expect(card.match(/보존:/g)?.length).toBe(1);
		expect(Buffer.byteLength(closeoutHandoff(run), "utf8")).toBeLessThanOrEqual(CLOSEOUT_HANDOFF_MAX_BYTES);
		const handoff = closeoutHandoff(run);
		expect(handoff.match(/Retained:/g)?.length).toBe(1);
		expect(handoff).toContain("Retained: 100");
	});

	test("the live chip and status text use the retained count", async () => {
		const source = path.join(tmp, "I0.patch");
		await writeFile(source, "LANE-I0\n");
		const run = fixture([keptRow("i0-patch", "I0", source, sha("LANE-I0\n"))]);
		const metrics = liveMetricFacts(run, "workers", T0);
		expect(metrics.chips[0]?.aria).toContain(RETAINED_ACCEPTED);
	});

	test("a stopped run with accepted evidence names its stop separately", async () => {
		const source = path.join(tmp, "I0.patch");
		await writeFile(source, "LANE-I0\n");
		const run = { ...fixture([keptRow("i0-patch", "I0", source, sha("LANE-I0\n"))]), status: "stopped" as const, endReason: "no-progress" as const };
		const card = renderCloseout(closeoutBrief(run), false).markdown;
		expect(card).toContain(STOP_SEPARATE_NOTE);
	});
});

describe("row 2/row 5: isolated judgement in the controller", () => {
	let root: string;
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-w2-controller-")));
	});
	afterEach(async () => {
		resetLedger();
		resetAgents();
		await rm(root, { recursive: true, force: true });
	});

	const session = (): FakeSession => fakeSession({ root, agents: [], config: TEAM });
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

	test("an isolated change that matches bytes another writer put in the parent is still unmet, with the version reason", async () => {
		const h = session();
		const runId = await h.start();
		const lanePlan = plan(lane("I0", { isolationReason: "isolated candidate", results: [{ id: "i0-change", kind: "change", criterion: "candidate", path: "i0.txt", contains: "LANE-I0" }] }));
		expect(await h.controller.setPlan(h.ctx, lanePlan)).toEqual({ ok: true });
		await writeFile(path.join(root, "i0.txt"), "BASE\n");
		const spawnKey = "I0";
		expect(await h.controller.prepareAttempt({ runId, lane: "I0", spawnKey, parentId: "main", dispatch: "c1", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
		// Another writer (not the worker) puts the literal into the parent during the attempt: ISO P7-B.
		await writeFile(path.join(root, "i0.txt"), "LANE-I0\n");
		const settlement: AttemptSettlement = {
			runId,
			lane: "I0",
			spawnKey,
			parentId: "main",
			dispatch: "c1",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:c1:${spawnKey}` }),
			citations: [],
		};
		await h.controller.settleAttempt(settlement);
		const row = h.controller.active()?.results?.find(candidate => candidate.id === "i0-change");
		expect(row?.state).toBe("unmet");
		expect(row?.reason).toBe(ISOLATED_CHANGE_REASON);
		expect(row?.reason).not.toContain("바뀐 내용이 없습니다");
	});

	test("an integrated prerequisite on an isolated producer says it cannot be met in this version", async () => {
		const h = session();
		const runId = await h.start();
		const producer = lane("P", { isolationReason: "retained candidate", results: [artifact("p0")] });
		const consumer = lane("C", { files: ["c0.txt"], dependsOn: [{ lane: "P", need: "integrated" }], results: [{ id: "c0", kind: "change", criterion: "consumer", path: "c0.txt" }] });
		const lanePlan = plan(producer, consumer);
		expect(await h.controller.setPlan(h.ctx, lanePlan)).toEqual({ ok: true });
		// The retained source S1 would bind, outside the target.
		const artifactDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-w2-retained-")));
		const source = path.join(artifactDir, "i0.txt");
		await writeFile(source, "LANE-I0\n");
		const row = h.controller.active()?.results?.find(candidate => candidate.id === "p0");
		if (row === undefined) throw new Error("the plan produced no p0 row");
		Object.assign(row, keptRow("p0", "P", source, sha("LANE-I0\n")), { lane: "P" });
		const readiness = await h.controller.laneReadiness(lanePlan, new Set(["P"]));
		const p = readiness.get("P");
		expect(p?.results[0]?.integrated).toBe(false);
		expect(p?.results[0]?.reason).toBe(ISOLATED_INTEGRATED_REASON);
		const refusal = dependencyBlock(consumer, readiness as LaneReadinessView);
		expect(refusal).toContain(ISOLATED_INTEGRATED_REASON);
		expect(renderPlanView({ runId, plan: lanePlan, results: h.controller.active()?.results })).toContain(INTEGRATED_UNAVAILABLE);
		await rm(artifactDir, { recursive: true, force: true });
	});
	test("a success with no patch says a branch is unread; an empty capture says no change, never a failed attempt", async () => {
		const h = session();
		const runId = await h.start();
		const lanePlan = plan(lane("I0", { isolationReason: "retained candidate", results: [artifact("i0-patch")] }));
		expect(await h.controller.setPlan(h.ctx, lanePlan)).toEqual({ ok: true });
		const settle = async (dispatch: string, captureError: NonNullable<AttemptReport["captureError"]>) => {
			const spawnKey = "I0";
			expect(await h.controller.prepareAttempt({ runId, lane: "I0", spawnKey, parentId: "main", dispatch, followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
			await h.controller.settleAttempt({
				runId,
				lane: "I0",
				spawnKey,
				parentId: "main",
				dispatch,
				startedAt: T0,
				observedAt: T0 + 1,
				report: report({ runId, spawnKey, attemptId: `job:${dispatch}:${spawnKey}`, capture: "missing", captureError }),
				citations: [],
			});
			const row = h.controller.active()?.results?.find(candidate => candidate.id === "i0-patch");
			return row?.reason ?? "";
		};
		const branch = await settle("c1", "patch-artifact-missing");
		expect(branch).toContain(ISOLATED_BRANCH_UNREAD);
		expect(branch).toContain("agent://I0");
		expect(branch).not.toContain("변경이 없");
		const empty = await settle("c2", "patch-artifact-empty");
		expect(empty).toContain(EMPTY_CAPTURE_REASON);
		expect(empty).not.toContain("확인하지 못했습니다");
	});

	test("a cancel whose identity could not be bound says the cause is unconfirmed", async () => {
		const h = session();
		const runId = await h.start();
		const lanePlan = plan(lane("I0", { isolationReason: "retained candidate", results: [artifact("i0-patch")] }));
		expect(await h.controller.setPlan(h.ctx, lanePlan)).toEqual({ ok: true });
		const spawnKey = "I0";
		expect(await h.controller.prepareAttempt({ runId, lane: "I0", spawnKey, parentId: "main", dispatch: "k1", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "I0",
			spawnKey,
			parentId: "main",
			dispatch: "k1",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:k1:${spawnKey}`, outcome: "cancel", capture: "missing", captureError: "registry-identity-missing" }),
			citations: [],
		});
		const reason = h.controller.active()?.results?.find(candidate => candidate.id === "i0-patch")?.reason ?? "";
		expect(reason).toContain(CANCEL_IDENTITY_UNKNOWN);
		expect(reason).toContain("registry-identity-missing");
	});

	test("a restored accepted isolated change is not revalidated on parent bytes", async () => {
		const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-w2-restore-")));
		await writeFile(path.join(parent, "i0.txt"), "LANE-I0\n");
		const result = { id: "i0-change", kind: "change" as const, criterion: "candidate", path: "i0.txt" };
		const identity = resultContractIdentity(result);
		const digest = sha("LANE-I0\n");
		const row: RunResult = {
			id: "i0-change",
			lane: "I0",
			state: "accepted",
			attemptId: "job:c:I0",
			identity,
			contentVersion: "a".repeat(64),
			contract: result,
			proof: {
				item: { id: "i0-change", kind: "change", identity, criterion: result.criterion, attemptId: "job:c:I0", state: "accepted", path: "i0.txt", digest, contentVersion: "a".repeat(64) },
			},
		};
		const isolated = await revalidateCheckpointProof({ row, result, root: parent, isolated: true });
		expect(isolated.ok).toBe(false);
		expect(isolated.ok ? "" : isolated.reason).toBe(ISOLATED_CHANGE_REASON);
		// Control: the fixture is otherwise valid as a shared change re-located in the parent.
		expect((await revalidateCheckpointProof({ row, result, root: parent, isolated: false })).ok).toBe(true);
		await rm(parent, { recursive: true, force: true });
	});

	test("an older reviewable isolated change is not accepted by a current-tree review", async () => {
		const agents: AgentEntry[] = [];
		let tree = treeOf("d0", "f0");
		const h = fakeSession({ root, agents, tree: () => ({ base: "b0", state: tree }) });
		const runId = await h.start();
		const lanePlan = plan(lane("I0", { isolationReason: "isolated candidate", results: [{ id: "i0-change", kind: "change", criterion: "candidate", path: "i0.txt" }] }));
		expect(await h.controller.setPlan(h.ctx, lanePlan)).toEqual({ ok: true });
		await writeFile(path.join(root, "i0.txt"), "BASE\n");
		expect(await h.controller.prepareAttempt({ runId, lane: "I0", spawnKey: "I0", parentId: "main", dispatch: "c1", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "i0.txt"), "CHANGED\n");
		await h.controller.settleAttempt({
			runId,
			lane: "I0",
			spawnKey: "I0",
			parentId: "main",
			dispatch: "c1",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey: "I0", attemptId: "job:c1:I0" }),
			citations: [],
		});
		// An older 0.28.0 record could hold this row reviewable; the refresh must not turn it into an acceptance.
		const row = h.controller.active()?.results?.find(candidate => candidate.id === "i0-change");
		if (row === undefined) throw new Error("no row");
		Object.assign(row, { state: "reviewable", origin: "attempt", contentVersion: "a".repeat(64) });
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
		expect(h.controller.active()?.results?.find(candidate => candidate.id === "i0-change")?.state).not.toBe("accepted");
	});

	test("a change with no literal that the parent now satisfies is unmet, never reviewable", async () => {
		const h = session();
		const runId = await h.start();
		const lanePlan = plan(lane("I0", { isolationReason: "isolated candidate", results: [{ id: "i0-change", kind: "change", criterion: "candidate", path: "i0.txt" }] }));
		expect(await h.controller.setPlan(h.ctx, lanePlan)).toEqual({ ok: true });
		await writeFile(path.join(root, "i0.txt"), "BASE\n");
		const spawnKey = "I0";
		expect(await h.controller.prepareAttempt({ runId, lane: "I0", spawnKey, parentId: "main", dispatch: "c1", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, "i0.txt"), "CHANGED\n");
		await h.controller.settleAttempt({
			runId,
			lane: "I0",
			spawnKey,
			parentId: "main",
			dispatch: "c1",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:c1:${spawnKey}` }),
			citations: [],
		});
		const row = h.controller.active()?.results?.find(candidate => candidate.id === "i0-change");
		expect(row?.state).toBe("unmet");
		expect(row?.reason).toBe(ISOLATED_CHANGE_REASON);
		// A consumer may still start speculatively, but the advice says a fresh isolated attempt, never a follow-up to
		// a checkout that is gone.
		const consumer = lane("C", { files: ["c0.txt"], dependsOn: [{ lane: "I0", need: "result" }], results: [{ id: "c0", kind: "change", criterion: "consumer", path: "c0.txt" }] });
		const readiness = await h.controller.laneReadiness(lanePlan, new Set(["I0"]));
		const start = dependencyStart(consumer, readiness);
		expect(start.ok).toBe(true);
		expect(start.ok ? start.notes.join(" ") : "").toContain(ISOLATED_STALE_ADVICE);
	});
});

describe("rows 6/7/9/11: the plan reply and every checkout note", () => {
	test("two private lanes sharing a file are told they may implement together but their landings can conflict", () => {
		const privateLane = (name: string) => lane(name, { isolationReason: "independent", results: [artifact(`${name}-patch`)] });
		const r = validatePlan(TEAM, { lanes: [privateLane("A"), privateLane("B")] }, T0);
		expect(r.errors).toEqual([]);
		const overlap = r.warnings.find(warning => warning.includes("A, B 레인"));
		expect(overlap).toContain(PRIVATE_OVERLAP_WARNING);
		expect(r.warnings).toContain(CHECKOUT_PLAN_NOTE);
	});

	test("an integrated edge on an isolated producer is named in the plan reply", () => {
		const producer = lane("P", { isolationReason: "retained", results: [artifact("p0")] });
		const consumer = lane("C", { files: ["c0.txt"], dependsOn: [{ lane: "P", need: "integrated" }], results: [{ id: "c0", kind: "change", criterion: "consumer", path: "c0.txt" }] });
		const r = validatePlan(TEAM, { lanes: [producer, consumer] }, T0);
		expect(r.errors).toEqual([]);
		const warning = r.warnings.find(text => text.includes(ISOLATED_INTEGRATED_WARNING));
		expect(warning).toContain("C");
		expect(r.warnings).toContain(CHECKOUT_PLAN_NOTE);
	});

	test("the status note carries the same facts and does not grow with the lane count", () => {
		const one = isolationNote(plan(lane("I0", { isolationReason: "one" })));
		expect(one).toContain(CHECKOUT_PLACEMENT_NOTE);
		expect(one).toContain(CHECKOUT_SNAPSHOT_NOTE);
		expect(one).toContain(CHECKOUT_CLEANUP_NOTE);
		const many = isolationNote(plan(...Array.from({ length: 100 }, (_, i) => lane(`I${i}`, { isolationReason: `lane ${i}` }))));
		expect(many).toBe(one);
		expect((many ?? "").length).toBeLessThan(400);
	});
});
