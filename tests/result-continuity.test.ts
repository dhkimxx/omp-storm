/**
 * Focused proof for the independent review's B3, M1 and M7 findings:
 * - B3: a no-op follow-up must not erase a still-valid reviewable submission.
 * - M1: a requirement whose lane left the plan must ask for a same-id replan, never an impossible review.
 * - M7: an unavailable approved check defers only the check; absent content stays unmet.
 *
 * Each case has a valid control so the fix cannot pass by refusing everything.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { buildRoundMessage, nextRemedy, type CoverageResult } from "../src/runtime/rounds.ts";
import type { AgentEntry, RunPlan, StormConfig } from "../src/types.ts";
import { fakeSession, type FakeSession, SESSION_TEAM, until } from "./fake-session.ts";
import { agentEntry } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-result-continuity-")));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** The host attempt report every test settles with; only the bound attempt id changes. */
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

/** A director plan with the run's workers; the submission time never matters to the ledger. */
function planFor(lanes: RunPlan["lanes"], workers: Record<string, number>): RunPlan {
	return { lanes, workers, submittedAt: new Date(T0).toISOString() };
}

/**
 * Admits one lane the way the dispatcher does, records its worker in the session's agent ledger, and returns the host
 * spawn key the attempt binds to.
 */
function admit(h: FakeSession, plan: RunPlan, lane: string, agents: AgentEntry[], role = "implementer"): string {
	const agent = `storm-${role}`;
	const bound = h.controller.runLanes()!.assign({ name: lane, agent }, plan, h.config);
	if (!bound.ok) throw new Error(bound.reason);
	const spawnKey = (bound.input as Record<string, unknown>).name as string;
	h.controller.runLanes()!.admit({ spawnKey, agent, outcome: "routed" });
	agents.push(agentEntry({ id: spawnKey, name: agent, role, state: "idle", requests: 1, lastChangeAt: T0, lastActivityAt: T0 + 1 }));
	return spawnKey;
}

/** A reviewable change contract: no `contains`/`check`, so a written file needs the reviewer's judgement. */
function reviewablePlan(target: string): RunPlan {
	return planFor(
		[{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "submitted", kind: "change", criterion: "submitted for natural language judgment", path: target }] }],
		{ implementer: 1 },
	);
}

/** A change contract whose acceptance depends on an approved check, with config that names that check. */
function checkedPlan(target: string): { plan: RunPlan; config: StormConfig } {
	return {
		config: { ...SESSION_TEAM, requiredChecks: [{ name: "unit-check", argv: ["/bin/sh", "-c", "true"] }] },
		plan: planFor(
			[{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "checked-change", kind: "change", criterion: "the checked change is present", path: target, check: "unit-check" }] }],
			{ implementer: 1 },
		),
	};
}

async function firstReviewableSubmission(target: string): Promise<{ h: FakeSession; runId: string; spawnKey: string }> {
	const agents: AgentEntry[] = [];
	const h = fakeSession({ root, agents });
	const runId = await h.start();
	const plan = reviewablePlan(target);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const spawnKey = admit(h, plan, "write", agents);
	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "v1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "the submitted change\n");
	await h.controller.settleAttempt({
		runId,
		lane: "write",
		spawnKey,
		parentId: "main",
		dispatch: "v1",
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey, attemptId: `job:v1:${spawnKey}` }),
		citations: [],
	});
	return { h, runId, spawnKey };
}

test("S3.3/B3: a no-op follow-up keeps an unchanged reviewable submission on its first attempt", async () => {
	const target = "reviewable.txt";
	const { h, runId, spawnKey } = await firstReviewableSubmission(target);
	const first = h.controller.active()?.results?.find(item => item.id === "submitted");
	expect(first).toMatchObject({ state: "reviewable", lane: "write", attemptId: `job:v1:${spawnKey}` });
	const firstVersion = first?.contentVersion;
	expect(firstVersion).toBeTruthy();

	// The follow-up edits an unrelated file only; the submitted content is untouched.
	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "v2", followUp: true, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
	await writeFile(path.join(root, "unrelated.txt"), "unrelated\n");
	await h.controller.settleAttempt({
		runId,
		lane: "write",
		spawnKey,
		parentId: "main",
		dispatch: "v2",
		startedAt: T0 + 2,
		observedAt: T0 + 3,
		report: report({ runId, spawnKey, attemptId: `job:v2:${spawnKey}`, observedAt: T0 + 3 }),
		citations: [],
	});

	const preserved = h.controller.active()?.results?.find(item => item.id === "submitted");
	expect(preserved).toMatchObject({ state: "reviewable", lane: "write", attemptId: `job:v1:${spawnKey}` });
	expect(preserved?.contentVersion).toBe(firstVersion);
	expect(await readFile(path.join(root, target), "utf8")).toBe("the submitted change\n");
});

test("S3.3/B3 control: a follow-up that replaces the required content rebinds the reviewable submission", async () => {
	const target = "reviewable.txt";
	const { h, runId, spawnKey } = await firstReviewableSubmission(target);
	const firstVersion = h.controller.active()?.results?.find(item => item.id === "submitted")?.contentVersion;

	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "v2", followUp: true, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "a genuinely new submission\n");
	await h.controller.settleAttempt({
		runId,
		lane: "write",
		spawnKey,
		parentId: "main",
		dispatch: "v2",
		startedAt: T0 + 2,
		observedAt: T0 + 3,
		report: report({ runId, spawnKey, attemptId: `job:v2:${spawnKey}`, observedAt: T0 + 3 }),
		citations: [],
	});

	const rebound = h.controller.active()?.results?.find(item => item.id === "submitted");
	expect(rebound).toMatchObject({ state: "reviewable", attemptId: `job:v2:${spawnKey}` });
	expect(rebound?.contentVersion).not.toBe(firstVersion);
	expect(await readFile(path.join(root, target), "utf8")).toBe("a genuinely new submission\n");
});

test("S1/S3 control: a no-op follow-up still preserves an accepted result", async () => {
	const target = "accepted.txt";
	const agents: AgentEntry[] = [];
	const h = fakeSession({ root, agents });
	const runId = await h.start();
	const plan = planFor(
		[{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "accepted-change", kind: "change", criterion: "the accepted content is GOOD", path: target, contains: "GOOD" }] }],
		{ implementer: 1 },
	);
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const spawnKey = admit(h, plan, "write", agents);
	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "a1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "GOOD\n");
	await h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "a1", startedAt: T0, observedAt: T0 + 1, report: report({ runId, spawnKey, attemptId: `job:a1:${spawnKey}` }), citations: [] });
	const first = h.controller.active()?.results?.find(item => item.id === "accepted-change");
	expect(first).toMatchObject({ state: "accepted", attemptId: `job:a1:${spawnKey}` });
	const firstVersion = first?.contentVersion;

	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "a2", followUp: true, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
	await writeFile(path.join(root, "unrelated.txt"), "unrelated\n");
	await h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "a2", startedAt: T0 + 2, observedAt: T0 + 3, report: report({ runId, spawnKey, attemptId: `job:a2:${spawnKey}`, observedAt: T0 + 3 }), citations: [] });

	const preserved = h.controller.active()?.results?.find(item => item.id === "accepted-change");
	expect(preserved).toMatchObject({ state: "accepted", attemptId: `job:a1:${spawnKey}` });
	expect(preserved?.contentVersion).toBe(firstVersion);
});

test("S1/M7: an unavailable approved check does not turn absent content into a reviewable submission", async () => {
	const target = "checked.txt";
	await writeFile(path.join(root, target), "already here\n");
	const { plan, config } = checkedPlan(target);
	const agents: AgentEntry[] = [];
	const h = fakeSession({ root, agents, config });
	const runId = await h.start();
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const spawnKey = admit(h, plan, "write", agents);
	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "m1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	// The worker changes nothing: the required change is absent. The check's evidence is also absent.
	await h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "m1", startedAt: T0, observedAt: T0 + 1, report: report({ runId, spawnKey, attemptId: `job:m1:${spawnKey}` }), citations: [] });

	const unmet = h.controller.active()?.results?.find(item => item.id === "checked-change");
	expect(unmet).toMatchObject({ state: "unmet", lane: "write", attemptId: `job:m1:${spawnKey}` });
	expect(unmet?.reason).toContain("바뀐 내용이 없습니다");
	expect(unmet?.reason).not.toContain("기다립니다");
});

test("S1/M7 control: an unavailable approved check defers only itself when the content is submitted", async () => {
	const target = "checked.txt";
	const { plan, config } = checkedPlan(target);
	const agents: AgentEntry[] = [];
	const h = fakeSession({ root, agents, config });
	const runId = await h.start();
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const spawnKey = admit(h, plan, "write", agents);
	expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "m2", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
	await writeFile(path.join(root, target), "submitted for the check\n");
	await h.controller.settleAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "m2", startedAt: T0, observedAt: T0 + 1, report: report({ runId, spawnKey, attemptId: `job:m2:${spawnKey}` }), citations: [] });

	const waiting = h.controller.active()?.results?.find(item => item.id === "checked-change");
	expect(waiting).toMatchObject({ state: "reviewable", lane: "write", attemptId: `job:m2:${spawnKey}` });
	expect(waiting?.reason).toContain("기다립니다");
});

test("S3/M1: a removed lane's reviewable row asks for a same-id replan, never a review", async () => {
	const target = "orphan.txt";
	const { h } = await firstReviewableSubmission(target);
	expect(h.controller.active()?.results?.find(item => item.id === "submitted")).toMatchObject({ state: "reviewable", lane: "write" });

	// The director drops the producing lane; the submitted requirement stays owed with no lane to judge it.
	expect(await h.controller.setPlan(h.ctx, planFor([{ name: "review", kind: "review", role: "reviewer", goal: "Review" }], { reviewer: 1 }))).toEqual({ ok: true });
	const orphan = h.controller.active()?.results?.find(item => item.id === "submitted");
	expect(orphan).toMatchObject({ state: "reviewable" });
	expect(orphan?.lane).toBeUndefined();
	expect(orphan?.reason).toContain("계획에서 빠진");

	await h.turn();
	h.timers.fire();
	await until(() => h.sent.length > 1);
	const message = h.sent.at(-1) ?? "";
	expect(message).toContain("submitted");
	expect(message).toContain("Replan it onto an approved lane");
	expect(message).toContain("same id");
	expect(message).toContain("scope change");
	expect(message).not.toContain("judge the submitted");
});

test("S3/M1 control: reassigning the same requirement id clears the orphan state", async () => {
	const target = "orphan.txt";
	const { h } = await firstReviewableSubmission(target);
	expect(await h.controller.setPlan(h.ctx, planFor([{ name: "later", kind: "review", role: "reviewer", goal: "Review" }], { reviewer: 1 }))).toEqual({ ok: true });
	expect(h.controller.active()?.results?.find(item => item.id === "submitted")?.lane).toBeUndefined();

	const reassigned = reviewablePlan(target);
	reassigned.lanes[0]!.name = "write-again";
	expect(await h.controller.setPlan(h.ctx, reassigned)).toEqual({ ok: true });
	const moved = h.controller.active()?.results?.find(item => item.id === "submitted");
	expect(moved).toMatchObject({ state: "reviewable", lane: "write-again" });
	expect(moved?.reason).not.toContain("계획에서 빠진");
});

test("S3/M1: the replan remedy is honored over review for a requirement without a lane", () => {
	const open: CoverageResult = { id: "submitted", state: "reviewable", remedy: "replan", judgeable: false };
	expect(nextRemedy(open, true)).toBe("replan");
	const message = buildRoundMessage({
		runId: "run-orphan",
		round: 2,
		maxRounds: 4,
		reviewer: "storm-reviewer",
		gate: {
			state: "unverified",
			cause: "results",
			changes: 1,
			reviews: 0,
			requests: 2,
			result: "submitted",
			resultState: "reviewable",
			resultRemedy: "replan",
		},
	});
	expect(message).toContain("Replan it onto an approved lane");
	expect(message).toContain("same id");
	expect(message).not.toContain("judge the submitted");
});
