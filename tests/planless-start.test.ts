/**
 * P3-start: the controller's plan-less automatic door (R9), the same-turn rule for every automatic start, the early
 * finish past the host's handler deadline, the continuation handoff (R12), an unplanned worker's expected delivery
 * (R11a), the director's own edit fact (R10) and the spend close at the limit (R15).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AsyncJobSnapshot, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AcquireRunLeaseInput, LeaseMode, LeaseRecord, LeaseSnapshot, RunLease } from "../src/runtime/lease.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetCloseoutChoices } from "../src/runtime/closeout.ts";
import { type PlanlessStart, RunController, noteRunSpawn } from "../src/runtime/controller.ts";
import { activeLedgerRun, recordCost, resetLedger } from "../src/runtime/ledger.ts";
import { PLANLESS_DEADLINE, PLANLESS_SAME_TURN } from "../src/runtime/planless.ts";
import { readRun, runIds } from "../src/runtime/run.ts";
import { stopWords } from "../src/runtime/rounds.ts";
import { unplannedNotice } from "../src/runtime/unplanned.ts";
import type { RunPlan, RunSpec, StormConfig } from "../src/types.ts";
import { FIXTURE_SESSION_ID, approvedState, spawnRecord } from "./fixtures.ts";
import { SESSION_TEAM, fakeSession, type SessionOptions } from "./fake-session.ts";
import { scriptedUi } from "./support.ts";

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-planless-start-")));
});

afterEach(async () => {
	resetCloseoutChoices();
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (opts: Omit<SessionOptions, "root"> = {}) => fakeSession({ root, ...opts });
const ask = (task: string): RunSpec => ({ task });

/** A plan with one writing implementer lane; its lane is the work the continuation carries. */
const writePlan = (results = false): RunPlan => ({
	lanes: [
		{
			name: "probe",
			kind: "code",
			role: "implementer",
			...(results ? { results: [{ id: "probe-note", kind: "answer" as const, criterion: "state what changed" }] } : {}),
		},
	],
	workers: { implementer: 1 },
	submittedAt: "2026-11-20T09:00:00.000Z",
});

describe("the plan-less automatic start (R9)", () => {
	const start = (lease: PlanlessStart["lease"], turnStartedAt = Date.now() - 1_000): PlanlessStart => ({
		turnStartedAt,
		deadline: Date.now() + 60_000,
		lease,
	});

	test("the first task of a user's turn opens a run inside that turn, with no plan, no handoff and no compaction", async () => {
		const h = session({ hold: { idle: false }, usage: { tokens: 300_000, contextWindow: 400_000, percent: 75 } });
		const opened = await h.controller.startPlanless(h.ctx, ask("고쳐 줘"), start("read"));
		if (!opened.ok) throw new Error(opened.reason);
		expect(h.controller.directing()).toBe(true);
		// The turn is already running: no handoff message, no dialog, no compaction, no select.
		expect(h.sent).toEqual([]);
		expect(h.events).toEqual([]);
		expect(activeLedgerRun(h.sessionDir)?.plan).toBeUndefined();
		const record = await readRun(h.sessionDir, opened.runId);
		expect(record).toMatchObject({ status: "running", turns: 0 });
		expect(record?.plan).toBeUndefined();
		expect(record?.results).toBeUndefined();
		// The in-flight turn is round one; the batch is placed by the same handler, so the run waits for nothing else.
		expect(h.timers.pending()).toBe(0);
		await h.controller.finish("shutdown");
	});

	test("the lease is what the batch needs: a read-only batch stays a reader, a writer batch takes the write claim", async () => {
		const reader = session();
		const read = await reader.controller.startPlanless(reader.ctx, ask("look"), start("read"));
		expect(read.ok).toBe(true);
		expect(reader.leases.held[0]?.mode).toBe("read");
		await reader.controller.finish("shutdown");

		const writer = session();
		const write = await writer.controller.startPlanless(writer.ctx, ask("change"), start("write"));
		expect(write.ok).toBe(true);
		expect(writer.leases.held[0]?.mode).toBe("write");
		await writer.controller.finish("shutdown");
	});

	test("a run of this session and target stopped in this turn refuses the next plan and plan-less open, before any lease", async () => {
		const clock = { now: Date.parse("2026-11-27T00:00:00Z") };
		const h = session({
			config: { ...SESSION_TEAM, budget: { perRunUsd: 1, warnAtUsd: 0.5, onExceed: "stop" } },
			now: () => clock.now,
		});
		const turnStartedAt = clock.now;
		const runId = await h.start();
		h.controller.onAgentStart();
		clock.now += 1_000;
		recordCost(runId, "a/i", 1);
		await h.controller.onAgentEnd({}, h.ctx);
		expect((await readRun(h.sessionDir, runId))?.endReason).toBe("budget");
		expect(h.leases.held).toEqual([]);
		const leased = h.leases.acquired.length;

		const plan = await h.controller.startWithPlan(h.ctx, ask("probe"), writePlan(), undefined, turnStartedAt);
		expect(plan).toEqual({ ok: false, reason: PLANLESS_SAME_TURN });
		const planless = await h.controller.startPlanless(h.ctx, ask("직접 고쳐 줘"), {
			turnStartedAt,
			deadline: clock.now + 60_000,
			lease: "write",
		});
		expect(planless).toEqual({ ok: false, reason: PLANLESS_SAME_TURN });
		// No run, no record and no lease was taken by either refusal.
		expect(h.controller.directing()).toBe(false);
		expect(h.leases.acquired).toHaveLength(leased);
		expect(h.leases.held).toEqual([]);
		expect(await runIds(h.sessionDir)).toHaveLength(1);

		// The user speaks after the stop: the same plan opens a run now.
		clock.now += 1_000;
		const later = await h.controller.startWithPlan(h.ctx, ask("probe"), writePlan(), undefined, clock.now);
		expect(later.ok).toBe(true);
		expect(await runIds(h.sessionDir)).toHaveLength(2);
		await h.controller.finish("shutdown");
	});

	test("a plan-less open already past the handler deadline never takes a lease or writes a record", async () => {
		const clock = { now: Date.parse("2026-11-27T00:00:00Z") };
		const h = session({ now: () => clock.now });
		const opened = await h.controller.startPlanless(h.ctx, ask("look"), {
			turnStartedAt: clock.now - 5_000,
			deadline: clock.now - 1,
			lease: "read",
		});
		expect(opened).toEqual({ ok: false, reason: PLANLESS_DEADLINE });
		expect(h.controller.directing()).toBe(false);
		expect(h.sent).toEqual([]);
		expect(h.leases.held).toEqual([]);
		expect(h.leases.acquired).toEqual([]);
		expect(await runIds(h.sessionDir)).toEqual([]);
	});

	test("an automatic plan whose owning request is withdrawn during preparation takes no lease and leaves no record", async () => {
		let withdrawn = false;
		const h = session({ state: s => { withdrawn = true; return s; } });
		const reason = "request withdrawn";
		const started = await h.controller.startWithPlan(h.ctx, ask("prepare"), writePlan(), undefined, Date.now(), () => withdrawn ? reason : undefined);
		expect(started).toEqual({ ok: false, reason });
		expect(h.leases.acquired).toEqual([]);
		expect(await runIds(h.sessionDir)).toEqual([]);
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
	});

	test("another session of the same profile cannot reuse a finished run's id", async () => {
		const first = session();
		const runId = "run-20261127-000000-fixed";
		expect(await first.controller.start(first.ctx, ask("first"), runId)).toMatchObject({ ok: true, runId });
		await first.controller.finish("shutdown");
		const next = session({ agentDir: first.agentDir });
		expect(await next.controller.start(next.ctx, ask("second"), runId)).toMatchObject({
			ok: false, reason: expect.stringContaining("이미 사용된 실행 ID"),
		});
		expect(await runIds(next.sessionDir)).toEqual([]);
		expect((await readRun(first.sessionDir, runId))?.request).toBe("first");
	});

	test("a refused plan-less open leaves no run, lease or ledger entry", async () => {
		const h = session({ state: s => ({ ...s, approval: undefined }) });
		const opened = await h.controller.startPlanless(h.ctx, ask("고쳐 줘"), {
			turnStartedAt: Date.now() - 1_000,
			deadline: Date.now() + 60_000,
			lease: "write",
		});
		expect(opened.ok).toBe(false);
		expect(h.controller.directing()).toBe(false);
		expect(h.leases.acquired).toEqual([]);
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
		expect(await runIds(h.sessionDir)).toEqual([]);
		expect(h.sent).toEqual([]);
	});
});

describe("continuing a run with nothing to carry (R12)", () => {
	test("a run with no result rows and no plan is a handoff: a new run, no plan, and the caller is told", async () => {
		const h = session();
		const first = await h.controller.startPlanless(h.ctx, ask("고쳐 줘"), {
			turnStartedAt: Date.now() - 1_000,
			deadline: Date.now() + 60_000,
			lease: "read",
		});
		if (!first.ok) throw new Error(first.reason);
		await h.controller.finish("interrupted");
		expect(h.sent).toEqual([]);

		const result = await h.controller.continueInTurn(h.ctx, "이어서", Date.now() + 60_000);
		if (!result.ok) throw new Error(result.reason);
		expect(result.continued).toEqual({
			mode: "handoff",
			from: first.runId,
			ended: stopWords("interrupted"),
			kept: 0,
			reopened: 0,
			blocked: 0,
			open: [],
		});
		const next = h.controller.active()!;
		expect(next.runId).not.toBe(first.runId);
		expect(next.resumeOf).toBe(first.runId);
		expect(next.plan).toBeUndefined();
		expect(next.results ?? []).toEqual([]);
		expect(await readRun(h.sessionDir, next.runId)).toMatchObject({ status: "running", resumeOf: first.runId });
		expect(h.sent).toEqual([]);
		await h.controller.finish("shutdown");
	});

	test("a planned run with no result rows is a handoff too: the plan is not applied", async () => {
		const h = session();
		const first = await h.controller.startWithPlan(h.ctx, ask("probe"), writePlan());
		if (!first.ok) throw new Error(first.reason);
		await h.controller.finish("interrupted");
		const result = await h.controller.continueInTurn(h.ctx, "이어서", Date.now() + 60_000);
		if (!result.ok) throw new Error(result.reason);
		expect(result.continued).toMatchObject({ mode: "handoff", from: first.runId, kept: 0, reopened: 0, open: [] });
		expect(h.controller.active()?.plan).toBeUndefined();
		await h.controller.finish("shutdown");
	});

	test("a planned run with a result row is carried as before: its plan is in force and its row is reopened", async () => {
		const h = session();
		const first = await h.controller.startWithPlan(h.ctx, ask("probe"), writePlan(true));
		if (!first.ok) throw new Error(first.reason);
		await h.controller.finish("interrupted");
		const result = await h.controller.continueInTurn(h.ctx, "이어서", Date.now() + 60_000);
		if (!result.ok) throw new Error(result.reason);
		expect(result.continued).toMatchObject({ mode: "carry", from: first.runId, kept: 0, reopened: 1, blocked: 0, open: ["probe"] });
		expect(h.controller.active()?.plan?.lanes.map(lane => lane.name)).toEqual(["probe"]);
		expect(h.controller.active()?.results?.map(row => row.id)).toEqual(["probe-note"]);
		await h.controller.finish("shutdown");
	});
});

describe("a worker this run placed without a lane (R11a)", () => {
	test("its first answer and one per follow-up are recorded for the views, never told as a delivery nobody asked for", async () => {
		const h = session();
		const runId = await h.start({ task: "t" });
		const delivery = (agent: string, n: number) => ({
			runId,
			id: `job:j${n}:${agent}`,
			kind: "unplaced" as const,
			agent,
			receiverId: "Main",
			endedAt: 1_000 + n,
		});
		noteRunSpawn(runId, spawnRecord({ spawnKey: "odd", agent: "storm-implementer" }));
		h.controller.noteUnplannedDelivery(delivery("odd", 1));
		// Recorded: the activity views count the unplanned worker's expected answer.
		expect(h.controller.active()?.unplanned?.map(item => item.agent)).toEqual(["odd"]);
		expect(h.controller.active()?.unplannedCount).toBe(1);
		// Not told: its own answer is not a delivery nobody asked for.
		expect(h.controller.takeNotices()).toBeUndefined();
		// A follow-up this run woke makes exactly one more answer expected.
		h.controller.noteWakingFollowUp(runId, "odd");
		h.controller.noteUnplannedDelivery(delivery("odd", 2));
		expect(h.controller.active()?.unplanned?.map(item => item.id)).toEqual(["job:j1:odd", "job:j2:odd"]);
		expect(h.controller.takeNotices()).toBeUndefined();
		// An extra wake nobody asked for is told.
		h.controller.noteUnplannedDelivery(delivery("odd", 3));
		expect(h.controller.takeNotices()).toBe(unplannedNotice({ agent: "odd", kind: "unplaced" }));
		// A worker this run never placed is told and recorded as before.
		h.controller.noteUnplannedDelivery(delivery("stranger", 1));
		expect(h.controller.takeNotices()).toBe(unplannedNotice({ agent: "stranger", kind: "unplaced" }));
		await h.controller.finish("shutdown");
	});

	test("a lane-bound worker's expected result stays out of the unplanned list and its notice", async () => {
		const h = session();
		const runId = await h.start({ task: "t" });
		noteRunSpawn(runId, spawnRecord({ spawnKey: "laned", lane: "probe" }));
		h.controller.noteUnplannedDelivery({
			runId,
			id: "job:j1:laned",
			kind: "unplaced",
			agent: "laned",
			receiverId: "Main",
			endedAt: 2_000,
		});
		expect(h.controller.active()?.unplanned).toBeUndefined();
		expect(h.controller.takeNotices()).toBeUndefined();
		await h.controller.finish("shutdown");
	});
});

describe("the director's own path edit (R10)", () => {
	test("is a run-level fact raised through the controller, and a late raise never marks another run", async () => {
		const h = session();
		expect(h.controller.directorEdited()).toBe(false);
		const runId = await h.start({ task: "t" });
		h.controller.noteDirectorEdit("run-other");
		expect(h.controller.directorEdited()).toBe(false);
		h.controller.noteDirectorEdit(runId);
		expect(h.controller.directorEdited()).toBe(true);
		await h.controller.finish("shutdown");
		expect(h.controller.directorEdited()).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------------------------------
// A host with only what a start and a limit need, so the controller's R15 dependency can be observed. `fake-session`
// builds its own dependency object and is not this suite's file to change.
// ---------------------------------------------------------------------------------------------------------------------

function testLease(input: AcquireRunLeaseInput): RunLease {
	let mode: LeaseMode = input.mode;
	let epoch = 0;
	const owner = { token: "test-lease", pid: process.pid, host: "test", processStart: 1 };
	const snapshot = (): LeaseSnapshot => ({
		runId: input.runId,
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		root: input.root,
		mode,
		paths: undefined,
		epoch,
	});
	const record = (): LeaseRecord => ({
		schema: "storm.lease/v2",
		kind: mode === "read" ? "read" : "write",
		key: input.root,
		root: input.root,
		runId: input.runId,
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		owner,
		acquiredAt: new Date(0).toISOString(),
		acquiredAtMs: 1,
	});
	return {
		runId: input.runId,
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		root: input.root,
		get mode() {
			return mode;
		},
		get paths() {
			return undefined;
		},
		get epoch() {
			return epoch;
		},
		owner,
		get record() {
			return record();
		},
		get path() {
			return "";
		},
		get sessionPath() {
			return "";
		},
		snapshot,
		assertCurrent() {
			// The fake has one writer: nothing changes under a snapshot it handed out.
		},
		async upgrade() {
			mode = "write";
			epoch += 1;
			return { ok: true };
		},
		async setWritePaths() {
			return { ok: true };
		},
		async release() {
			// In memory only: releasing twice is the same as once.
		},
	};
}

function limitHost(dir: string, config: StormConfig, closeSpend: (runId: string, onExceed: "block-spawns" | "stop") => void) {
	const state = approvedState(dir, config);
	const ui = scriptedUi();
	const ctx = {
		cwd: dir,
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { getEditorText: () => "" },
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }) as unknown as AsyncJobSnapshot,
		compact: async () => undefined,
		abort: () => undefined,
		agent: { kind: "main", id: "main" },
		sessionManager: {
			getSessionId: () => FIXTURE_SESSION_ID,
			getArtifactsDir: () => "",
			getSessionDir: () => "",
		},
	} as unknown as ExtensionContext;
	const controller = new RunController({
		pi: { sendUserMessage: async () => undefined },
		ui: () => ui.ui,
		loadState: async () => state,
		now: () => Date.now(),
		agents: () => [],
		timers: { set: () => ({}), clear: () => undefined },
		lease: async (input: AcquireRunLeaseInput) => ({ ok: true, lease: testLease(input) }),
		closeSpend,
	});
	return { controller, ctx, ui };
}

describe("the spend close at the limit (R15)", () => {
	test("the controller calls it once, at the limit, with the run's own onExceed, and not at the warning line", async () => {
		for (const onExceed of ["stop", "block-spawns"] as const) {
			const calls: Array<[string, string]> = [];
			const dir = path.join(root, `limit-${onExceed}`);
			await mkdir(dir, { recursive: true });
			const h = limitHost(
				dir,
				{ ...SESSION_TEAM, budget: { perRunUsd: 1, warnAtUsd: 0.5, onExceed } },
				(runId, mode) => {
					calls.push([runId, mode]);
				},
			);
			const opened = await h.controller.startPlanless(h.ctx, ask("t"), {
				turnStartedAt: Date.now() - 1_000,
				deadline: Date.now() + 60_000,
				lease: "read",
			});
			if (!opened.ok) throw new Error(opened.reason);
			recordCost(opened.runId, "a/i", 0.5);
			expect(calls).toEqual([]);
			recordCost(opened.runId, "a/i", 0.6);
			expect(calls).toEqual([[opened.runId, onExceed]]);
			// The ledger's exceeded flag makes the limit a one-time fact.
			recordCost(opened.runId, "a/i", 0.4);
			expect(calls).toHaveLength(1);
			await h.controller.finish("shutdown");
		}
	});
});
