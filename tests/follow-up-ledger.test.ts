/**
 * A follow-up's result reaches the result ledger (F1).
 *
 * omp registers a woken or revived worker's turn as a job under the agent id again once the earlier job's row has been
 * evicted (30 s after it was consumed), so the real collector and the real run controller meet the same job id for two
 * turns. These tests drive both as the extension does (admission, write-time job binding, a delivery by `wait` or as a
 * pushed `async-result`, the agent going idle) with run and agent ids of the real shape: `run-20261126-102646-74da-lane-3`
 * makes a 67 character attempt id, past the 64 characters the code used to allow.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AttemptCollector } from "../src/runtime/attempt-collector.ts";
import { ATTEMPT_REF } from "../src/runtime/attempt-report.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { dependencyBlock, LEDGER_NOTICE_TAG, LEDGER_READY_LEAD } from "../src/runtime/lanes.ts";
import { resetCloseoutChoices } from "../src/runtime/closeout.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { CONTINUATION_HEAD, EARLIER_REQUEST_MARKER, findResumeCandidate, resumePointerFile, resumeSpec } from "../src/runtime/resume.ts";
import { CONTINUE_SAME_TURN, RESUME_POINTER_FAILED } from "../src/runtime/controller.ts";
import { NO_END_REASON, stopWords } from "../src/runtime/rounds.ts";
import { readRun, writeRun } from "../src/runtime/run.ts";
import type { PlanLane, RunPlan, RunSpec } from "../src/types.ts";
import { type FakeSession, fakeSession } from "./fake-session.ts";
import { TEST_TIMINGS } from "./timings.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-26T05:20:00Z");
const RESULT = "head-total";
const CITED = "The head_total is 42 (knowledge/k3.md:3)";
const UNCITED = "I looked at the head control and found nothing to cite.";

const plan: RunPlan = {
	submittedAt: new Date(T0).toISOString(),
	workers: { explorer: 1 },
	lanes: [
		{
			name: "Pin",
			kind: "explore",
			role: "explorer",
			results: [{ id: RESULT, kind: "answer", criterion: "state the head total from source", path: "knowledge/k3.md", contains: "head_total: 42" }],
		},
		{
			name: "Build",
			kind: "explore",
			role: "explorer",
			dependsOn: [{ lane: "Pin", need: "result" }],
			results: [{ id: "build-note", kind: "answer", criterion: "note" }],
		},
	],
};
const pinLane = plan.lanes[0] as PlanLane;

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-followup-")));
	await mkdir(path.join(root, "knowledge"), { recursive: true });
	await writeFile(path.join(root, "knowledge", "k3.md"), "# k3\nline two\nhead_total: 42\n");
});

afterEach(async () => {
	resetCloseoutChoices();
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

interface Rig {
	h: FakeSession;
	runId: string;
	/** The worker's id: `<runId>-lane-1`, also omp's job id for its first turn. */
	agent: string;
	collector: AttemptCollector;
	settlements: string[];
	now: number;
	/** Storm's agents table: what `storm agents` and the readiness row's third term read. */
	idle(): void;
	row(): { state: string; attemptId?: string; reason?: string; finalized?: string };
	view(): Promise<{ running: boolean; state: string; reason?: string; blocked: string | undefined }>;
	wait(row: { id: string; settledAtMs: number; durationMs: number; text: string }): Promise<void>;
	pushed(jobId: string, text: string, jobs?: readonly { id: string; agentId: string; startTime: number; status: string }[]): Promise<void>;
	followUp(toolCallId: string): Promise<void>;
	bind(jobs: readonly { id: string; startTime: number; status: string }[]): void;
}

/** A run with the explorer lane admitted and its first dispatch prepared at `T0 + 1000`. */
async function rig(task?: string): Promise<Rig> {
	const agents: ReturnType<typeof agentEntry>[] = [];
	const h = fakeSession({ root, agents, timings: TEST_TIMINGS });
	const runId = await h.start(task === undefined ? undefined : { task });
	expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
	const bound = h.controller.runLanes()!.assign({ name: pinLane.name, agent: "storm-explorer" }, plan, h.config, {});
	if (!bound.ok) throw new Error(bound.reason);
	const agent = (bound.input as { name: string }).name;
	h.controller.runLanes()!.admit({ spawnKey: agent, agent: "storm-explorer", outcome: "routed" });
	const settlements: string[] = [];
	const state: { now: number } = { now: T0 + 1_000 };
	const collector = new AttemptCollector({
		port: {
			prepare: input => h.controller.prepareAttempt({ ...input, runId }),
			settle: async input => {
				settlements.push(input.report.attemptId ?? "none");
				await h.controller.settleAttempt({ ...input, runId });
			},
			discard: input => h.controller.discardAttempt(input),
		},
		registry: () => ({ get: id => ({ id, parentId: "main", session: null }), onChange: () => () => undefined }),
		now: () => state.now,
	});
	await collector.admitSpawn({ runId, parentId: "main", spawnKey: agent, lane: pinLane, artifactMode: "shared", startedAt: state.now });
	const rows = (): ReturnType<Rig["row"]> => h.controller.active()!.results!.find(candidate => candidate.id === RESULT)!;
	const out: Rig = {
		h,
		runId,
		agent,
		collector,
		settlements,
		get now() {
			return state.now;
		},
		set now(value: number) {
			state.now = value;
		},
		idle: () => {
			agents.splice(0, agents.length, agentEntry({ id: agent, name: "storm-explorer", role: "explorer", state: "idle", requests: 8, lastActivityAt: state.now }));
		},
		row: rows,
		view: async () => {
			const readiness = (await h.controller.laneReadiness(plan, new Set([pinLane.name]))).get(pinLane.name)!;
			const result = readiness.results[0]!;
			return {
				running: readiness.running,
				state: result.state,
				...(result.reason === undefined ? {} : { reason: result.reason }),
				blocked: dependencyBlock(plan.lanes[1]!, new Map([[pinLane.name, readiness]])),
			};
		},
		wait: async row => {
			state.now = row.settledAtMs + 5;
			await collector.observeWaitResult({
				runId,
				parentId: "main",
				observedAt: state.now,
				details: { op: "wait", jobs: [{ id: row.id, type: "task", status: "completed", agentUrlId: agent, settledAtMs: row.settledAtMs, durationMs: row.durationMs, resultText: row.text }] },
			});
		},
		pushed: async (jobId, text, jobs) => {
			await collector.observeMessage({
				runId,
				parentId: "main",
				observedAt: state.now,
				message: { customType: "async-result", content: text, details: { jobs: [{ jobId, agentId: agent, status: "completed" }] } },
				...(jobs === undefined ? {} : { jobs }),
			});
		},
		followUp: async toolCallId => {
			await collector.admitFollowUp({ runId, parentId: "main", spawnKey: agent, lane: pinLane, artifactMode: "shared", toolCallId, startedAt: state.now });
		},
		bind: jobs => {
			collector.bindFollowUpJobs({ runId, spawnKey: agent, jobs: jobs.map(job => ({ ...job, agentId: agent })) });
		},
	};
	return out;
}

/** The first turn, delivered as a pushed job under the agent id; its answer cites nothing, so the row is `unmet`. */
async function firstTurn(r: Rig, at = T0 + 2_000): Promise<string> {
	r.now = at;
	await r.pushed(r.agent, UNCITED);
	r.idle();
	expect(r.row().state).toBe("unmet");
	expect(r.settlements).toHaveLength(1);
	const first = r.settlements[0]!;
	expect(first).toBe(`job:${r.agent}:${r.agent}`);
	return first;
}

describe("a follow-up after omp evicted the earlier job row (the job id is the agent id again)", () => {
	const FOLLOW_AT = T0 + 90_000;
	const START = FOLLOW_AT + 400;

	async function writeFollowUp(r: Rig, boundAtWrite: boolean): Promise<void> {
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		if (boundAtWrite) r.bind([{ id: r.agent, startTime: START, status: "running" }]);
	}

	test("the answer delivered by wait becomes the lane's newest attempt, the lane stops running and the dependant is admitted", async () => {
		const r = await rig();
		const first = await firstTurn(r);
		expect(await r.view()).toMatchObject({ running: false, state: "unmet", blocked: expect.any(String) });
		await writeFollowUp(r, true);
		// The write opened a dispatch for the lane: it is running until the follow-up's job delivers.
		expect(await r.view()).toMatchObject({ running: true });
		await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: CITED });
		r.idle();
		const row = r.row();
		expect(row.state).toBe("accepted");
		expect(row.attemptId).toBe(`job:${r.agent}.t${START}:${r.agent}`);
		expect(row.attemptId).not.toBe(first);
		expect(ATTEMPT_REF.test(row.attemptId!)).toBe(true);
		expect(await r.view()).toMatchObject({ running: false, state: "accepted", blocked: undefined });
		expect(r.settlements).toEqual([first, row.attemptId!]);
	});

	test("the same answer pushed as an async-result is recorded, with the parent's job rows as the start evidence", async () => {
		const r = await rig();
		await firstTurn(r);
		await writeFollowUp(r, true);
		r.now = START + 2_100;
		await r.pushed(r.agent, CITED, [{ id: r.agent, agentId: r.agent, startTime: START, status: "completed" }]);
		r.idle();
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${START}:${r.agent}` });
		expect(await r.view()).toMatchObject({ running: false, blocked: undefined });
	});

	test("a pushed delivery with no job rows at all still settles a follow-up that was bound at the write", async () => {
		const r = await rig();
		await firstTurn(r);
		await writeFollowUp(r, true);
		r.now = START + 2_100;
		await r.pushed(r.agent, CITED);
		r.idle();
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${START}:${r.agent}` });
		expect(await r.view()).toMatchObject({ running: false });
	});

	test("a follow-up whose job was not visible at the write settles from the delivery's own start time (wait, then pushed)", async () => {
		for (const how of ["wait", "pushed"] as const) {
			const r = await rig();
			await firstTurn(r);
			await writeFollowUp(r, false);
			if (how === "wait") await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: CITED });
			else {
				r.now = START + 2_100;
				await r.pushed(r.agent, CITED, [{ id: r.agent, agentId: r.agent, startTime: START, status: "completed" }]);
			}
			r.idle();
			expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${START}:${r.agent}` });
			expect(await r.view()).toMatchObject({ running: false, blocked: undefined });
			resetLedger();
			resetAgents();
		}
	});

	test("a pushed delivery with no proof it began after the write is refused, and the lane keeps reading as running", async () => {
		const r = await rig();
		await firstTurn(r);
		await writeFollowUp(r, false);
		r.now = START + 2_100;
		await r.pushed(r.agent, CITED);
		expect(r.settlements).toHaveLength(1);
		expect(r.row().state).toBe("unmet");
	});

	test("a replay of the first job is refused whether or not the new job was bound: the stale result cannot overwrite the newer one", async () => {
		for (const bound of [true, false]) {
			const r = await rig();
			const first = await firstTurn(r);
			await writeFollowUp(r, bound);
			// The first job again, with its real start (before the write): by wait, then pushed with the parent's row for it.
			await r.wait({ id: r.agent, settledAtMs: T0 + 1_900, durationMs: 800, text: CITED });
			r.now = FOLLOW_AT + 100;
			await r.pushed(r.agent, CITED, [{ id: r.agent, agentId: r.agent, startTime: T0 + 1_100, status: "completed" }]);
			expect(r.settlements).toEqual([first]);
			expect(r.row().state).toBe("unmet");
			// The real follow-up job still settles afterwards.
			await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: CITED });
			expect(r.settlements).toHaveLength(2);
			expect(r.row().state).toBe("accepted");
			resetLedger();
			resetAgents();
		}
	});

	test("a delivery of the newer job cannot be replayed either", async () => {
		const r = await rig();
		await firstTurn(r);
		await writeFollowUp(r, true);
		await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: CITED });
		const second = r.row().attemptId;
		await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: UNCITED });
		await r.pushed(r.agent, UNCITED, [{ id: r.agent, agentId: r.agent, startTime: START, status: "completed" }]);
		expect(r.settlements).toHaveLength(2);
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: second });
	});

	test("a later follow-up after a second reuse is a third attempt with its own id", async () => {
		const r = await rig();
		await firstTurn(r);
		await writeFollowUp(r, true);
		await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: UNCITED });
		r.idle();
		const secondId = r.row().attemptId;
		const later = FOLLOW_AT + 200_000;
		r.now = later;
		await r.followUp("call_write_2");
		r.bind([{ id: r.agent, startTime: later + 300, status: "running" }]);
		await r.wait({ id: r.agent, settledAtMs: later + 2_300, durationMs: 2_000, text: CITED });
		r.idle();
		expect(r.settlements).toHaveLength(3);
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${later + 300}:${r.agent}` });
		expect(r.row().attemptId).not.toBe(secondId);
		expect(await r.view()).toMatchObject({ running: false });
	});
});

describe("a repeat of the earlier turn's delivery is not taken for the follow-up's when nothing proves its start", () => {
	const FOLLOW_AT = T0 + 90_000;
	const START = FOLLOW_AT + 400;

	test("a running row for the reused job id is the next turn's and proves nothing about the job being delivered", async () => {
		const r = await rig();
		await firstTurn(r);
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		// Not bound at the write. The first job is delivered again while the parent's row for that id is already the
		// follow-up's running one.
		r.now = START + 100;
		await r.pushed(r.agent, UNCITED, [{ id: r.agent, agentId: r.agent, startTime: START, status: "running" }]);
		expect(r.settlements).toHaveLength(1);
		expect(await r.view()).toMatchObject({ running: true });
		// The follow-up's own delivery, with its completed row, is recorded.
		r.now = START + 2_100;
		await r.pushed(r.agent, CITED, [{ id: r.agent, agentId: r.agent, startTime: START, status: "completed" }]);
		expect(r.settlements).toHaveLength(2);
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${START}:${r.agent}` });
	});

	test("a bound follow-up refuses a delivery that is the earlier answer again when no start comes with it, and closes the dispatch", async () => {
		const r = await rig();
		const first = await firstTurn(r);
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: START, status: "running" }]);
		r.now = START + 100;
		await r.pushed(r.agent, UNCITED);
		// The refusal settles the dispatch as an unusable `attempt-replayed` report, which binds no attempt: the lane stops
		// reading as running, the earlier verdict stands and the end of the run does not rewrite it.
		expect(r.settlements).toEqual([first, "none"]);
		expect(await r.view()).toMatchObject({ running: false, state: "unmet" });
		expect(r.row().attemptId).toBe(first);
		await r.h.controller.finish("no-progress");
		const final = (await readRun(r.h.sessionDir, r.runId))?.results?.find(candidate => candidate.id === RESULT);
		expect(final?.finalized).toBeUndefined();
		expect(final).toMatchObject({ state: "unmet", attemptId: first });
	});

	test("a worker that really gives the same accepted answer twice, pushed without its job row, keeps its accepted row and does not read as running", async () => {
		const r = await rig();
		r.now = T0 + 2_000;
		await r.pushed(r.agent, CITED);
		r.idle();
		const first = r.row().attemptId;
		expect(r.row().state).toBe("accepted");
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: START, status: "running" }]);
		r.now = START + 2_100;
		// The same answer again; the parent's rows no longer list the job (more than five settled since).
		await r.pushed(r.agent, CITED);
		r.idle();
		expect(await r.view()).toMatchObject({ running: false, state: "accepted", blocked: undefined });
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: first });
		await r.h.controller.finish("no-progress");
		const final = (await readRun(r.h.sessionDir, r.runId))?.results?.find(candidate => candidate.id === RESULT);
		expect(final).toMatchObject({ state: "accepted" });
		expect(final?.finalized).toBeUndefined();
	});

	test("the same refusal on the wait channel closes the dispatch too", async () => {
		const r = await rig();
		const first = await firstTurn(r);
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: START, status: "running" }]);
		// A wait row with no duration proves no start.
		r.now = START + 100;
		await r.collector.observeWaitResult({
			runId: r.runId,
			parentId: "main",
			observedAt: r.now,
			details: { op: "wait", jobs: [{ id: r.agent, type: "task", status: "completed", agentUrlId: r.agent, settledAtMs: r.now, resultText: UNCITED }] },
		});
		expect(r.settlements).toEqual([first, "none"]);
		expect(await r.view()).toMatchObject({ running: false });
	});

	test("a worker that really answers the same thing again is recorded when the delivery carries its start", async () => {
		const r = await rig();
		await firstTurn(r);
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: START, status: "running" }]);
		r.now = START + 2_100;
		await r.pushed(r.agent, UNCITED, [{ id: r.agent, agentId: r.agent, startTime: START, status: "completed" }]);
		expect(r.settlements).toHaveLength(2);
		expect(r.row().attemptId).toBe(`job:${r.agent}.t${START}:${r.agent}`);
		expect(await r.view()).toMatchObject({ running: false });
	});
});

describe("a follow-up to a worker whose earlier turns this collector no longer remembers", () => {
	const FOLLOW_AT = T0 + 90_000;
	const START = FOLLOW_AT + 400;

	test("it opens a dispatch, and only a delivery that proves it began after the write settles it", async () => {
		const r = await rig();
		await firstTurn(r);
		// The conversation was re-opened: the collector dropped every dispatch, the worker lives on.
		r.collector.stop();
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		expect(await r.view()).toMatchObject({ running: true });
		// The earlier job's delivery again, with its real start: not this turn's.
		r.now = FOLLOW_AT + 100;
		await r.pushed(r.agent, UNCITED, [{ id: r.agent, agentId: r.agent, startTime: T0 + 1_100, status: "completed" }]);
		await r.pushed(r.agent, UNCITED);
		expect(r.settlements).toHaveLength(1);
		expect(await r.view()).toMatchObject({ running: true });
		// The follow-up's own job, with its start after the write, is recorded as the lane's newest attempt.
		r.now = START + 2_100;
		await r.pushed(r.agent, CITED, [{ id: r.agent, agentId: r.agent, startTime: START, status: "completed" }]);
		expect(r.settlements).toHaveLength(2);
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${START}:${r.agent}` });
		expect(await r.view()).toMatchObject({ running: false, blocked: undefined });
	});

	test("a write that fails leaves nothing open and the worker unknown again", async () => {
		const r = await rig();
		await firstTurn(r);
		r.collector.stop();
		r.now = FOLLOW_AT;
		await r.followUp("call_write_failed");
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_write_failed" });
		expect(await r.view()).toMatchObject({ running: false, state: "unmet" });
		await r.h.controller.finish("no-progress");
		expect(((await readRun(r.h.sessionDir, r.runId))?.results ?? []).every(row => row.finalized !== "unsettled")).toBe(true);
	});
});

describe("a follow-up whose job id is new (omp still held the earlier row)", () => {
	test("the `<agent>-2` job settles by wait and by a pushed result, bound or proven by its start", async () => {
		for (const path of ["wait-bound", "pushed-bound", "wait-unbound", "pushed-unbound"]) {
			const r = await rig();
			await firstTurn(r);
			r.now = T0 + 12_000;
			await r.followUp("call_write_1");
			const job = `${r.agent}-2`;
			if (path.endsWith("-bound")) r.bind([{ id: job, startTime: T0 + 12_300, status: "running" }]);
			if (path.startsWith("wait")) await r.wait({ id: job, settledAtMs: T0 + 14_300, durationMs: 2_000, text: CITED });
			else {
				r.now = T0 + 14_400;
				await r.pushed(job, CITED, path.endsWith("-unbound") ? [{ id: job, agentId: r.agent, startTime: T0 + 12_300, status: "completed" }] : undefined);
			}
			r.idle();
			expect(r.row(), path).toMatchObject({ state: "accepted", attemptId: `job:${job}:${r.agent}` });
			expect(await r.view(), path).toMatchObject({ running: false, blocked: undefined });
			resetLedger();
			resetAgents();
		}
	});
});

describe("a follow-up written into a worker whose turn is still open", () => {
	const WRITE_AT = T0 + 20_000;

	test("the job the message joined settles the lane when it completes, by wait or pushed", async () => {
		for (const how of ["wait", "pushed"] as const) {
			const r = await rig();
			// The first turn has not delivered: its job (the agent id) is still running when the message is written.
			r.now = WRITE_AT;
			await r.followUp("call_write_1");
			r.bind([{ id: r.agent, startTime: T0 + 1_100, status: "running" }]);
			expect(await r.view()).toMatchObject({ running: true });
			if (how === "wait") await r.wait({ id: r.agent, settledAtMs: WRITE_AT + 5_000, durationMs: WRITE_AT + 5_000 - (T0 + 1_100), text: CITED });
			else {
				r.now = WRITE_AT + 5_100;
				await r.pushed(r.agent, CITED, [{ id: r.agent, agentId: r.agent, startTime: T0 + 1_100, status: "completed" }]);
			}
			r.idle();
			expect(r.settlements, how).toEqual([`job:${r.agent}:${r.agent}`]);
			expect(r.row(), how).toMatchObject({ state: "accepted" });
			expect(await r.view(), how).toMatchObject({ running: false, blocked: undefined });
			resetLedger();
			resetAgents();
		}
	});

	test("the completion settles it even when the snapshot at the write did not hold the job (a wait row carries its own start)", async () => {
		const r = await rig();
		r.now = WRITE_AT;
		await r.followUp("call_write_1");
		await r.wait({ id: r.agent, settledAtMs: WRITE_AT + 5_000, durationMs: WRITE_AT + 5_000 - (T0 + 1_100), text: CITED });
		r.idle();
		expect(r.settlements).toEqual([`job:${r.agent}:${r.agent}`]);
		expect(r.row().state).toBe("accepted");
		expect(await r.view()).toMatchObject({ running: false });
	});

	test("four messages into one open turn leave one open dispatch, and the end of the run keeps the delivered row", async () => {
		const r = await rig();
		for (const [index, at] of [T0 + 10_000, T0 + 12_000, T0 + 14_000, T0 + 16_000].entries()) {
			r.now = at;
			await r.followUp(`call_write_${index}`);
			r.bind([{ id: r.agent, startTime: T0 + 1_100, status: "running" }]);
		}
		await r.wait({ id: r.agent, settledAtMs: T0 + 20_000, durationMs: 20_000 - 1_100, text: CITED });
		r.idle();
		expect(r.row().state).toBe("accepted");
		expect(await r.view()).toMatchObject({ running: false });
		await r.h.controller.finish("no-progress");
		const final = (await readRun(r.h.sessionDir, r.runId))?.results?.find(candidate => candidate.id === RESULT);
		expect(final).toMatchObject({ state: "accepted" });
		expect(final?.finalized).toBeUndefined();
	});
});

describe("a follow-up written as the worker's turn is ending", () => {
	const WRITE_AT = T0 + 20_000;
	const J1_START = T0 + 1_100;
	const J2_START = WRITE_AT + 300;
	const second = (agent: string) => `job:${agent}-2:${agent}`;

	test("omp ran the message as a new job while the finishing one still showed running: the new job is the follow-up's, the old one's answer is not", async () => {
		for (const how of ["pushed", "wait"] as const) {
			const r = await rig();
			r.now = WRITE_AT;
			await r.followUp("call_write_1");
			// What the parent's snapshot held at the write's result: the finishing job and the one the write woke.
			r.bind([
				{ id: r.agent, startTime: J1_START, status: "running" },
				{ id: `${r.agent}-2`, startTime: J2_START, status: "running" },
			]);
			// The first job delivers its own answer (it never saw the message): it must not settle the follow-up's dispatch.
			if (how === "pushed") {
				r.now = WRITE_AT + 500;
				await r.pushed(r.agent, UNCITED, [{ id: r.agent, agentId: r.agent, startTime: J1_START, status: "completed" }, { id: `${r.agent}-2`, agentId: r.agent, startTime: J2_START, status: "running" }]);
			} else {
				await r.wait({ id: r.agent, settledAtMs: WRITE_AT + 400, durationMs: WRITE_AT + 400 - J1_START, text: UNCITED });
			}
			expect(r.settlements, how).toHaveLength(0);
			expect(await r.view(), how).toMatchObject({ running: true });
			// The woken job's answer is.
			await r.wait({ id: `${r.agent}-2`, settledAtMs: J2_START + 2_000, durationMs: 2_000, text: CITED });
			r.idle();
			expect(r.settlements, how).toEqual([second(r.agent)]);
			expect(r.row(), how).toMatchObject({ state: "accepted", attemptId: second(r.agent) });
			expect(await r.view(), how).toMatchObject({ running: false, blocked: undefined });
			resetLedger();
			resetAgents();
		}
	});

	test("a later job that no write of this dispatch started (a quiet progress note woke the idle worker) does not take the binding: the joined turn's answer settles", async () => {
		for (const how of ["pushed", "wait"] as const) {
			const r = await rig();
			r.now = WRITE_AT;
			await r.followUp("call_write_1");
			// The message joined the one running turn, which is the only job in the rows at the write.
			r.bind([{ id: r.agent, startTime: J1_START, status: "running" }]);
			// That turn finishes with the answer to the message. Before its delivery is read, a progress note woke the
			// now idle worker: a second job exists, started after the write, which no write of this dispatch started.
			const rowsLater = [
				{ id: r.agent, agentId: r.agent, startTime: J1_START, status: "completed" },
				{ id: `${r.agent}-2`, agentId: r.agent, startTime: J2_START, status: "running" },
			];
			if (how === "pushed") {
				r.now = WRITE_AT + 500;
				await r.pushed(r.agent, CITED, rowsLater);
			} else {
				r.now = WRITE_AT + 400;
				await r.collector.observeWaitResult({
					runId: r.runId,
					parentId: "main",
					observedAt: r.now,
					jobs: rowsLater,
					details: { op: "wait", jobs: [{ id: r.agent, type: "task", status: "completed", agentUrlId: r.agent, settledAtMs: WRITE_AT + 400, durationMs: WRITE_AT + 400 - J1_START, resultText: CITED }] },
				});
			}
			expect(r.settlements, how).toEqual([`job:${r.agent}:${r.agent}`]);
			expect(r.row(), how).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}:${r.agent}` });
			r.idle();
			expect(await r.view(), how).toMatchObject({ running: false });
			// The progress note's reply has no dispatch to settle and changes nothing.
			await r.wait({ id: `${r.agent}-2`, settledAtMs: J2_START + 2_000, durationMs: 2_000, text: UNCITED });
			expect(r.row(), how).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}:${r.agent}` });
			resetLedger();
			resetAgents();
		}
	});

	test("with no later job in the rows, the one running job that the message joined settles the lane as before", async () => {
		const r = await rig();
		r.now = WRITE_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: J1_START, status: "running" }]);
		r.now = WRITE_AT + 5_000;
		await r.pushed(r.agent, CITED, [{ id: r.agent, agentId: r.agent, startTime: J1_START, status: "completed" }]);
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}:${r.agent}` });
	});
});

describe("no dispatch stays open once the worker has delivered", () => {
	test("a follow-up written before the earlier job was delivered, then a second one: the delivered answer is kept at the end of the run", async () => {
		const r = await rig();
		await firstTurn(r);
		// Follow-up 1 wakes the idle worker (bare id again); its result is never consumed. Follow-up 2 is written into
		// that still-running wake turn and joins it.
		r.now = T0 + 90_000;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: T0 + 90_300, status: "running" }]);
		r.now = T0 + 95_000;
		await r.followUp("call_write_2");
		r.bind([{ id: r.agent, startTime: T0 + 90_300, status: "running" }]);
		await r.wait({ id: r.agent, settledAtMs: T0 + 99_000, durationMs: 99_000 - 90_300, text: CITED });
		r.idle();
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${T0 + 90_300}:${r.agent}` });
		expect(await r.view()).toMatchObject({ running: false, blocked: undefined });
		await r.h.controller.finish("no-progress");
		const final = (await readRun(r.h.sessionDir, r.runId))?.results?.find(candidate => candidate.id === RESULT);
		expect(final).toMatchObject({ state: "accepted" });
		expect(final?.finalized).toBeUndefined();
	});

	test("a settled newest dispatch closes the lane's older open ones, so the end of the run cannot rewrite its judged rows", async () => {
		const agents: ReturnType<typeof agentEntry>[] = [];
		const h = fakeSession({ root, agents, timings: TEST_TIMINGS });
		const runId = await h.start();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const input = (dispatch: string, startedAt: number) => ({ runId, lane: "Pin", spawnKey: "agent-a", parentId: "main", dispatch, followUp: false, artifactMode: "shared" as const, startedAt });
		expect(await h.controller.prepareAttempt(input("d1", T0))).toEqual({ ok: true });
		expect(await h.controller.prepareAttempt(input("d2", T0 + 1_000))).toEqual({ ok: true });
		expect((await h.controller.laneReadiness(plan, new Set(["Pin"]))).get("Pin")!.running).toBe(true);
		await h.controller.settleAttempt({
			runId, lane: "Pin", spawnKey: "agent-a", parentId: "main", dispatch: "d2", startedAt: T0 + 1_000, observedAt: T0 + 2_000,
			report: {
				schema: "storm.attempt-report/v1", runId, parentId: "main", spawnKey: "agent-a", attemptId: "job:agent-a.t1:agent-a",
				outcome: "success", capture: "observed", observedAt: T0 + 2_000, version: "unknown", artifacts: [], observations: [],
			},
			reportText: CITED,
			citations: [{ path: "knowledge/k3.md", line: 3 }],
		});
		agents.push(agentEntry({ id: "agent-a", name: "storm-explorer", role: "explorer", state: "idle", requests: 3, lastActivityAt: T0 + 2_000 }));
		expect((await h.controller.laneReadiness(plan, new Set(["Pin"]))).get("Pin")!.running).toBe(false);
		await h.controller.finish("no-progress");
		const final = (await readRun(h.sessionDir, runId))?.results?.find(candidate => candidate.id === RESULT);
		expect(final?.finalized).toBeUndefined();
	});
});

describe("a helper bound to a lane only by its role does not take the lane over", () => {
	const HELPER = "old-helper-from-run-a";

	test("while the lane's own worker is running, a write to the helper opens no dispatch: the lane's cited answer is the result", async () => {
		const r = await rig();
		r.now = T0 + 1_500;
		// The extension binds the helper to the lane because it is the only lane of the helper's role.
		await r.collector.admitFollowUp({ runId: r.runId, parentId: "main", spawnKey: HELPER, lane: pinLane, artifactMode: "shared", toolCallId: "call_helper", startedAt: r.now });
		r.now = T0 + 2_000;
		await r.pushed(r.agent, CITED);
		r.idle();
		expect(r.settlements).toEqual([`job:${r.agent}:${r.agent}`]);
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}:${r.agent}` });
		expect(await r.view()).toMatchObject({ running: false, blocked: undefined });
		// The helper's own answer has no dispatch to settle and changes nothing.
		r.now = T0 + 3_000;
		await r.collector.observeMessage({
			runId: r.runId,
			parentId: "main",
			observedAt: r.now,
			message: { customType: "async-result", content: UNCITED, details: { jobs: [{ jobId: HELPER, agentId: HELPER, status: "completed" }] } },
		});
		expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}:${r.agent}` });
		expect(r.settlements).toHaveLength(1);
	});

	test("once the lane has nothing open, the same write does open a dispatch and its answer is recorded (the case where the reused worker is the lane's only one)", async () => {
		const r = await rig();
		r.now = T0 + 2_000;
		await r.pushed(r.agent, UNCITED);
		r.idle();
		expect(r.settlements).toHaveLength(1);
		r.now = T0 + 90_000;
		await r.collector.admitFollowUp({ runId: r.runId, parentId: "main", spawnKey: HELPER, lane: pinLane, artifactMode: "shared", toolCallId: "call_helper", startedAt: r.now });
		expect(await r.view()).toMatchObject({ running: true });
		await r.collector.observeMessage({
			runId: r.runId,
			parentId: "main",
			observedAt: r.now + 2_000,
			message: { customType: "async-result", content: CITED, details: { jobs: [{ jobId: HELPER, agentId: HELPER, status: "completed" }] } },
			jobs: [{ id: HELPER, agentId: HELPER, startTime: r.now + 300, status: "completed" }],
		});
		expect(r.row().state).toBe("accepted");
		expect(r.settlements).toHaveLength(2);
	});
});

describe("a follow-up that never reached the worker is not left open", () => {
	const FOLLOW_AT = T0 + 90_000;

	test("a refused or failed write drops its dispatch: the lane stops reading as running and the earlier answer stands", async () => {
		const r = await rig();
		const first = await firstTurn(r);
		r.now = FOLLOW_AT;
		await r.followUp("call_write_failed");
		expect(await r.view()).toMatchObject({ running: true });
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_write_failed" });
		expect(await r.view()).toMatchObject({ running: false, state: "unmet" });
		expect(r.row().attemptId).toBe(first);
		// The worker's earlier job is not this write's: a later real follow-up still binds and settles.
		r.now = FOLLOW_AT + 60_000;
		await r.followUp("call_write_2");
		r.bind([{ id: r.agent, startTime: r.now + 300, status: "running" }]);
		await r.wait({ id: r.agent, settledAtMs: r.now + 2_300, durationMs: 2_000, text: CITED });
		expect(r.row().state).toBe("accepted");
		expect(r.settlements).toHaveLength(2);
		await r.h.controller.finish("no-progress");
		expect(((await readRun(r.h.sessionDir, r.runId))?.results ?? []).every(row => row.finalized !== "unsettled")).toBe(true);
	});

	test("a write that did wake the worker (its job was bound) is not abandoned by a late error report", async () => {
		const r = await rig();
		await firstTurn(r);
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: FOLLOW_AT + 300, status: "running" }]);
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_write_1" });
		expect(await r.view()).toMatchObject({ running: true });
		await r.wait({ id: r.agent, settledAtMs: FOLLOW_AT + 2_300, durationMs: 2_000, text: CITED });
		expect(r.row().state).toBe("accepted");
	});

	test("another call's failure, or a repeated abandon, drops nothing", async () => {
		const r = await rig();
		await firstTurn(r);
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_other" });
		await r.collector.abandonFollowUp({ runId: "run-other", spawnKey: r.agent, toolCallId: "call_write_1" });
		expect(await r.view()).toMatchObject({ running: true });
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_write_1" });
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_write_1" });
		expect(await r.view()).toMatchObject({ running: false });
	});

	for (const order of [["call_a", "call_b"], ["call_b", "call_a"]] as const) {
		test(`two writes to one worker in one director message that both fail (reported ${order.join(" then ")}) leave nothing open`, async () => {
			const r = await rig();
			r.now = T0 + 2_000;
			await r.pushed(r.agent, CITED);
			r.idle();
			const first = r.row().attemptId;
			expect(r.row().state).toBe("accepted");
			// Both writes pass the tool_call hook before either runs: two dispatches are open at once.
			r.now = FOLLOW_AT;
			await r.followUp("call_a");
			await r.followUp("call_b");
			expect(await r.view()).toMatchObject({ running: true });
			for (const call of order) await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: call });
			expect(await r.view()).toMatchObject({ running: false, state: "accepted", blocked: undefined });
			expect(r.row().attemptId).toBe(first);
			// The worker is still tracked: the next real follow-up opens a dispatch and its answer is the lane's attempt.
			r.now = FOLLOW_AT + 60_000;
			await r.followUp("call_c");
			expect(await r.view()).toMatchObject({ running: true });
			r.bind([{ id: r.agent, startTime: r.now + 300, status: "running" }]);
			await r.wait({ id: r.agent, settledAtMs: r.now + 2_300, durationMs: 2_000, text: CITED });
			expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${FOLLOW_AT + 60_300}:${r.agent}` });
			expect(r.settlements).toHaveLength(2);
			await r.h.controller.finish("no-progress");
			expect(((await readRun(r.h.sessionDir, r.runId))?.results ?? []).every(row => row.finalized !== "unsettled")).toBe(true);
		});
	}

	test("one of two writes in one message fails and the other wakes the worker: the failed one is cut out, the other settles", async () => {
		for (const failed of ["call_a", "call_b"]) {
			const r = await rig();
			r.now = T0 + 2_000;
			await r.pushed(r.agent, CITED);
			r.idle();
			r.now = FOLLOW_AT;
			await r.followUp("call_a");
			await r.followUp("call_b");
			await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: failed });
			r.bind([{ id: r.agent, startTime: FOLLOW_AT + 300, status: "running" }]);
			expect(await r.view()).toMatchObject({ running: true });
			await r.wait({ id: r.agent, settledAtMs: FOLLOW_AT + 2_300, durationMs: 2_000, text: CITED });
			r.idle();
			expect(r.row()).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}.t${FOLLOW_AT + 300}:${r.agent}` });
			expect(await r.view()).toMatchObject({ running: false });
			await r.h.controller.finish("no-progress");
			expect(((await readRun(r.h.sessionDir, r.runId))?.results ?? []).every(row => row.finalized !== "unsettled")).toBe(true);
			await r.h.controller.finish("no-progress");
		}
	});

	test("the controller drops one prepared dispatch and keeps the lane's earlier open one live", async () => {
		const agents: ReturnType<typeof agentEntry>[] = [];
		const h = fakeSession({ root, agents, timings: TEST_TIMINGS });
		const runId = await h.start();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const input = (dispatch: string, startedAt: number) => ({ runId, lane: "Pin", spawnKey: "agent-a", parentId: "main", dispatch, followUp: false, artifactMode: "shared" as const, startedAt });
		expect(await h.controller.prepareAttempt(input("d1", T0))).toEqual({ ok: true });
		expect(await h.controller.prepareAttempt(input("d2", T0 + 1_000))).toEqual({ ok: true });
		await h.controller.discardAttempt({ runId, dispatch: "d2" });
		await h.controller.discardAttempt({ runId, dispatch: "d2" });
		expect((await h.controller.laneReadiness(plan, new Set(["Pin"]))).get("Pin")!.running).toBe(true);
		// The earlier dispatch still settles: dropping the newer one gave its fence back.
		await h.controller.settleAttempt({
			runId, lane: "Pin", spawnKey: "agent-a", parentId: "main", dispatch: "d1", startedAt: T0, observedAt: T0 + 2_000,
			report: {
				schema: "storm.attempt-report/v1", runId, parentId: "main", spawnKey: "agent-a", attemptId: "job:agent-a:agent-a",
				outcome: "success", capture: "observed", observedAt: T0 + 2_000, version: "unknown", artifacts: [], observations: [],
			},
			reportText: CITED,
			citations: [{ path: "knowledge/k3.md", line: 3 }],
		});
		agents.push(agentEntry({ id: "agent-a", name: "storm-explorer", role: "explorer", state: "idle", requests: 3, lastActivityAt: T0 + 2_000 }));
		expect(h.controller.active()!.results!.find(row => row.id === RESULT)).toMatchObject({ state: "accepted", attemptId: "job:agent-a:agent-a" });
		expect((await h.controller.laneReadiness(plan, new Set(["Pin"]))).get("Pin")!.running).toBe(false);
	});
});

describe("a follow-up that never reached the worker does not spend the user's retry", () => {
	const RETRY_TEXT = "사용자 요청으로 같은 계약을 한 번 더 시도합니다.";

	test("the retry comes back with the row's own reason and an unstamped acknowledgement, and the next real attempt takes it", async () => {
		const r = await rig();
		await firstTurn(r);
		const before = r.row().reason;
		expect(before).not.toBe(RETRY_TEXT);
		expect(await r.h.controller.adjust(r.h.ctx, { kind: "retry", target: RESULT, exact: true, source: "command" })).toMatchObject({ ok: true });
		const entry = () => r.h.controller.active()!.adjustments!.at(-1)!;
		expect(entry()).toMatchObject({ kind: "retry", id: RESULT });
		expect(entry().takenAt).toBeUndefined();

		// The write passes Storm's hook: the attempt takes the grant. Then the host fails the write.
		r.now = T0 + 90_000;
		await r.followUp("call_write_failed");
		expect(typeof entry().takenAt).toBe("string");
		expect(r.row().reason).toBe(RETRY_TEXT);
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_write_failed" });
		expect(entry().takenAt).toBeUndefined();
		expect(r.row().reason).toBe(before);
		// A dependant's refusal says what the row says, never that a retry is under way.
		expect((await r.view()).reason).not.toBe(RETRY_TEXT);
		expect(await r.h.controller.adjust(r.h.ctx, { kind: "retry", target: RESULT, exact: true, source: "command" })).toMatchObject({ ok: true, already: true });

		// The next real follow-up is the retry the user asked for.
		r.now = T0 + 150_000;
		await r.followUp("call_write_2");
		expect(typeof entry().takenAt).toBe("string");
		expect(r.row().reason).toBe(RETRY_TEXT);
	});

	/** Every order of 1..n permutations, for the writes of one director message. */
	const orders = (calls: readonly string[]): string[][] =>
		calls.length <= 1 ? [[...calls]] : calls.flatMap((call, index) => orders([...calls.slice(0, index), ...calls.slice(index + 1)]).map(rest => [call, ...rest]));

	for (const calls of [["call_a", "call_b"], ["call_a", "call_b", "call_c"]]) {
		for (const order of orders(calls)) {
			test(`${calls.length} writes in one message that all fail, reported ${order.join(" then ")}, give the retry back to the user`, async () => {
				const r = await rig();
				await firstTurn(r);
				const before = r.row().reason;
				expect(await r.h.controller.adjust(r.h.ctx, { kind: "retry", target: RESULT, exact: true, source: "command" })).toMatchObject({ ok: true });
				const entry = () => r.h.controller.active()!.adjustments!.at(-1)!;
				r.now = T0 + 90_000;
				// All writes pass the hook before any runs: the grant sits on the first dispatch, which is not the newest.
				for (const call of calls) await r.followUp(call);
				expect(typeof entry().takenAt).toBe("string");
				for (const call of order) await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: call });
				expect(await r.view()).toMatchObject({ running: false });
				expect(entry().takenAt).toBeUndefined();
				expect(r.row().reason).toBe(before);
				expect(await r.h.controller.adjust(r.h.ctx, { kind: "retry", target: RESULT, exact: true, source: "command" })).toMatchObject({ ok: true, already: true });
				// Owed again: the next real write takes it.
				r.now = T0 + 150_000;
				await r.followUp("call_next");
				expect(typeof entry().takenAt).toBe("string");
			});
		}
	}

	test("a write that holds the grant fails while a later one is still open: the grant stays spent, on the attempt that will run", async () => {
		for (const failed of ["call_a", "call_b"]) {
			const r = await rig();
			await firstTurn(r);
			expect(await r.h.controller.adjust(r.h.ctx, { kind: "retry", target: RESULT, exact: true, source: "command" })).toMatchObject({ ok: true });
			const entry = () => r.h.controller.active()!.adjustments!.at(-1)!;
			r.now = T0 + 90_000;
			await r.followUp("call_a");
			await r.followUp("call_b");
			await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: failed });
			// The other write woke the worker: a retry is under way, so the grant is not handed back.
			expect(typeof entry().takenAt).toBe("string");
			expect(r.row().reason).toBe(RETRY_TEXT);
			// When the attempt that carries it fails too, nothing ran: the grant goes back to the user.
			const other = failed === "call_a" ? "call_b" : "call_a";
			await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: other });
			expect(entry().takenAt).toBeUndefined();
			resetLedger();
			resetAgents();
		}
	});

	test("a retry the plan has since moved away from is not handed back", async () => {
		const r = await rig();
		await firstTurn(r);
		expect(await r.h.controller.adjust(r.h.ctx, { kind: "retry", target: RESULT, exact: true, source: "command" })).toMatchObject({ ok: true });
		r.now = T0 + 90_000;
		await r.followUp("call_write_failed");
		const changed: RunPlan = { ...plan, lanes: [{ ...pinLane, name: "Pin-moved" }] };
		expect(await r.h.controller.setPlan(r.h.ctx, changed)).toEqual({ ok: true });
		await r.collector.abandonFollowUp({ runId: r.runId, spawnKey: r.agent, toolCallId: "call_write_failed" });
		expect(r.h.controller.active()!.adjustments!.at(-1)!.takenAt).toBeDefined();
	});
});

describe("the readiness row carries the ledger's reason", () => {
	test("an unmet answer's reason reaches the dependant's refusal", async () => {
		const r = await rig();
		await firstTurn(r);
		const view = await r.view();
		expect(view.state).toBe("unmet");
		expect(view.reason).toBe(r.row().reason);
		expect(view.reason).toBeDefined();
		expect(view.blocked).toContain(view.reason!.replace(/[.。]+$/u, ""));
	});

	test("a reviewable answer carries its reason, an accepted one none", async () => {
		const r = await rig();
		r.now = T0 + 2_000;
		await r.pushed(r.agent, "It says the head total is about forty-two, see knowledge/k3.md:3");
		r.idle();
		expect(r.row().state).toBe("reviewable");
		const reviewable = await r.view();
		expect(reviewable).toMatchObject({ state: "reviewable" });
		expect(reviewable.reason).toBe(r.row().reason);
		expect(reviewable.reason).toBeDefined();

		const accepted = await rig();
		accepted.now = T0 + 2_000;
		await accepted.pushed(accepted.agent, CITED);
		accepted.idle();
		const view = await accepted.view();
		expect(view).toMatchObject({ state: "accepted", blocked: undefined });
		expect(view.reason).toBeUndefined();
	});
});

describe("an attempt id of the real length", () => {
	test("the reference pattern holds a real 67 character id, the widest shapes and nothing unsafe", () => {
		const real = "job:run-20261126-051651-7850-lane-3:run-20261126-051651-7850-lane-3";
		expect(real).toHaveLength(67);
		expect(ATTEMPT_REF.test(real)).toBe(true);
		expect(ATTEMPT_REF.test(`task:${"c".repeat(120)}:${"a".repeat(120)}`)).toBe(true);
		expect(ATTEMPT_REF.test(`job:${"j".repeat(120)}.t1795688212331:${"a".repeat(120)}`)).toBe(true);
		expect(ATTEMPT_REF.test("job:a/b:c")).toBe(false);
		expect(ATTEMPT_REF.test("job:a@b:c")).toBe(false);
		expect(ATTEMPT_REF.test("")).toBe(false);
	});

	test("an accepted answer with a real attempt id is carried across a resume", async () => {
		const r = await rig();
		r.now = T0 + 2_000;
		await r.pushed(r.agent, CITED);
		r.idle();
		const accepted = r.row();
		expect(accepted).toMatchObject({ state: "accepted", attemptId: `job:${r.agent}:${r.agent}` });
		await r.h.controller.finish("interrupted");
		await r.h.start({ task: "continue", resumeOf: r.runId });
		const restored = r.h.controller.active()!.results!.find(candidate => candidate.id === RESULT);
		expect(restored).toMatchObject({ state: "accepted", restoredFrom: r.runId, attemptId: accepted.attemptId });
	});
});

// ── What the director reads when a delivery changed the ledger (G3) ──────────────────────────────────────────────────

describe("the notice a delivery leaves for the director", () => {
	/** The text the director's next request carries, taken once. */
	const notice = (r: Rig): string | undefined => r.h.controller.takeNotices();

	test("a refused answer names the result, its state and reason, the citation form that is read and nothing else", async () => {
		const r = await rig();
		await firstTurn(r);
		const text = notice(r);
		expect(text).toBeDefined();
		expect(text).toContain(LEDGER_NOTICE_TAG);
		expect(text).toContain("Pin");
		expect(text).toContain(RESULT);
		expect(text).toContain("미충족");
		expect(text).toContain(r.row().reason!.replace(/[.。]+$/u, ""));
		// For an answer: the one form that is read, and the two that are not.
		expect(text).toContain("path:line");
		expect(text).toContain("local://");
		// The dependant waits on a result that is not accepted: it cannot start, so it is not named.
		expect(text).not.toContain(LEDGER_READY_LEAD);
		// Short, and taken once.
		expect(text!.length).toBeLessThan(420);
		expect(notice(r)).toBeUndefined();
	});

	test("an accepted delivery names the waiting lane it releases, and only that", async () => {
		const r = await rig();
		r.now = T0 + 2_000;
		await r.pushed(r.agent, CITED);
		r.idle();
		const text = notice(r);
		expect(text).toBeDefined();
		expect(text).toContain("Build");
		expect(text).toContain(LEDGER_READY_LEAD);
		expect(text).not.toContain("수용하지 않았습니다");
		expect(text).not.toContain(RESULT);
		// Nothing was started by it: the dependant has no worker and no attempt.
		expect(r.h.controller.runLanes()!.agentForLane("Build")).toBeUndefined();
		expect(r.h.controller.active()!.spawns).toEqual([]);
	});

	test("an accepted delivery with nothing waiting on it says nothing", async () => {
		const solo: RunPlan = { ...plan, lanes: [plan.lanes[0] as PlanLane] };
		const agents: ReturnType<typeof agentEntry>[] = [];
		const h = fakeSession({ root, agents, timings: TEST_TIMINGS });
		const runId = await h.start();
		expect(await h.controller.setPlan(h.ctx, solo)).toEqual({ ok: true });
		const bound = h.controller.runLanes()!.assign({ name: pinLane.name, agent: "storm-explorer" }, solo, h.config, {});
		if (!bound.ok) throw new Error(bound.reason);
		const agent = (bound.input as { name: string }).name;
		h.controller.runLanes()!.admit({ spawnKey: agent, agent: "storm-explorer", outcome: "routed" });
		const collector = new AttemptCollector({
			port: {
				prepare: input => h.controller.prepareAttempt({ ...input, runId }),
				settle: input => h.controller.settleAttempt({ ...input, runId }),
				discard: input => h.controller.discardAttempt(input),
			},
			registry: () => ({ get: id => ({ id, parentId: "main", session: null }), onChange: () => () => undefined }),
			now: () => T0 + 2_000,
		});
		await collector.admitSpawn({ runId, parentId: "main", spawnKey: agent, lane: pinLane, artifactMode: "shared", startedAt: T0 + 1_000 });
		await collector.observeMessage({
			runId,
			parentId: "main",
			observedAt: T0 + 2_000,
			message: { customType: "async-result", content: CITED, details: { jobs: [{ jobId: agent, agentId: agent, status: "completed" }] } },
		});
		expect(h.controller.active()!.results!.find(candidate => candidate.id === RESULT)).toMatchObject({ state: "accepted" });
		expect(h.controller.takeNotices()).toBeUndefined();
	});

	test("the same attempt is reported once, however many ways it arrives", async () => {
		const r = await rig();
		r.now = T0 + 2_000;
		await r.pushed(r.agent, UNCITED);
		r.idle();
		expect(notice(r)).toBeDefined();
		// The same job again, as a wait row and as a second push: already evaluated, nothing new to say.
		await r.wait({ id: r.agent, settledAtMs: T0 + 2_000, durationMs: 900, text: UNCITED });
		await r.pushed(r.agent, UNCITED);
		expect(notice(r)).toBeUndefined();
	});

	test("a later attempt of the lane is a new attempt and is reported again", async () => {
		const FOLLOW_AT = T0 + 90_000;
		const START = FOLLOW_AT + 400;
		const r = await rig();
		await firstTurn(r);
		expect(notice(r)).toContain("미충족");
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: START, status: "running" }]);
		await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: CITED });
		r.idle();
		const text = notice(r);
		expect(text).toContain("Build");
		expect(text).toContain(LEDGER_READY_LEAD);
		expect(text).not.toContain("수용하지 않았습니다");
		// Prerequisites met is not a promise to start: the spawn guard's other checks still decide.
		expect(text).not.toContain("시작할 수 있");
		expect(text).toContain("스폰 검사");
	});

	test("a lane told startable is not told again by an attempt that changes nothing for it", async () => {
		const FOLLOW_AT = T0 + 90_000;
		const START = FOLLOW_AT + 400;
		const r = await rig();
		r.now = T0 + 2_000;
		await r.pushed(r.agent, CITED);
		r.idle();
		expect(notice(r)).toContain("Build");
		r.now = FOLLOW_AT;
		await r.followUp("call_write_1");
		r.bind([{ id: r.agent, startTime: START, status: "running" }]);
		await r.wait({ id: r.agent, settledAtMs: START + 2_000, durationMs: 2_000, text: CITED });
		r.idle();
		expect(notice(r)).toBeUndefined();
	});

	test("a stale delivery (a newer attempt of the lane governs) reports nothing", async () => {
		const r = await rig();
		await firstTurn(r);
		notice(r);
		r.now = T0 + 90_000;
		await r.followUp("call_write_1");
		// The old turn's job delivered again after the follow-up opened: refused as not current, no notice for it.
		r.now = T0 + 90_100;
		await r.pushed(r.agent, UNCITED);
		expect(notice(r)).toBeUndefined();
	});
});

// ── The director continues an interrupted run (G3) ───────────────────────────────────────────────────────────────────

describe("the director continues the interrupted run", () => {
	const reopened = (r: Rig, over: { root?: string; config?: Parameters<typeof fakeSession>[0]["config"]; sessionId?: string } = {}): FakeSession =>
		fakeSession({
			root: over.root ?? root,
			sessionId: over.sessionId ?? r.h.sessionId,
			agentDir: r.h.agentDir,
			timings: TEST_TIMINGS,
			...(over.config === undefined ? {} : { config: over.config }),
		});

	async function interruptedWithAnswer(task = "작업현황"): Promise<Rig> {
		const r = await rig(task);
		r.now = T0 + 2_000;
		await r.pushed(r.agent, CITED);
		r.idle();
		await r.h.controller.finish("interrupted");
		return r;
	}

	test("the session is opened again: the run continues with its accepted result proven again, its goal and its lineage", async () => {
		const r = await interruptedWithAnswer();
		const again = reopened(r);
		const result = await again.controller.continueInTurn(again.ctx, "이어서 해줘", Date.now());
		expect(result).toMatchObject({ ok: true, continued: { from: r.runId, kept: 1, reopened: 1, blocked: 0, open: ["Build"] } });
		const next = again.controller.active()!;
		expect(next.resumeOf).toBe(r.runId);
		expect(next.goal).toMatchObject({ runs: 1 });
		expect(next.results!.find(candidate => candidate.id === RESULT)).toMatchObject({ state: "accepted", restoredFrom: r.runId });
		// The old plan is in force before any spawn, and it is the director's turn that goes on: no handoff, no dialog.
		expect(next.plan?.lanes.map(lane => lane.name)).toEqual(["Pin", "Build"]);
		expect(again.sent).toEqual([]);
		expect(again.ui.events.some(event => event.startsWith("select"))).toBe(false);
		// The lineage is on disk and the pointer names the new run for a later resume.
		expect(await readRun(again.sessionDir, next.runId)).toMatchObject({ status: "running", resumeOf: r.runId, plan: { lanes: [{ name: "Pin" }, { name: "Build" }] } });
		await again.controller.finish("interrupted");
	});

	// What the menu can resume, the director can continue once the user has spoken after the stop: the reach is the menu's.
	const STOPS = ["interrupted", "budget", "time-limit", "round-limit", "no-progress", "shutdown"] as const;
	for (const reason of STOPS) {
		test(`a run stopped as ${reason}: refused in the turn that began before it stopped, continued in a later turn, with the reason named`, async () => {
			const r = await rig("작업현황");
			r.now = T0 + 2_000;
			await r.pushed(r.agent, CITED);
			r.idle();
			const turnBegan = Date.now();
			// The run stops inside the turn the user's message began (the director's own `plan` or `continue` in it).
			await new Promise(resolve => setTimeout(resolve, 5));
			await r.h.controller.finish(reason);
			const stopped = (await readRun(r.h.sessionDir, r.runId))!;
			expect(Date.parse(stopped.endedAt!)).toBeGreaterThan(turnBegan);
			const again = reopened(r);
			const refused = await again.controller.continueInTurn(again.ctx, "이어서", turnBegan);
			expect(refused).toEqual({ ok: false, reason: CONTINUE_SAME_TURN });
			expect(again.controller.active()).toBeUndefined();
			// Nothing was spent by the refusal: the record is still the candidate, and the user's next message continues it.
			const later = Date.parse(stopped.endedAt!) + 1;
			const result = await again.controller.continueInTurn(again.ctx, "이어서", later);
			expect(result).toMatchObject({ ok: true, continued: { from: r.runId, ended: stopWords(reason) } });
			await again.controller.finish("interrupted");
		});
	}

	test("an old record with no reason is continued by a later message and says so", async () => {
		const r = await interruptedWithAnswer();
		const stopped = (await readRun(r.h.sessionDir, r.runId))!;
		const without = { ...stopped };
		delete without.endReason;
		await writeRun(r.h.sessionDir, without);
		const again = reopened(r);
		const result = await again.controller.continueInTurn(again.ctx, "이어서", Date.parse(stopped.endedAt!) + 1);
		expect(result).toMatchObject({ ok: true, continued: { ended: NO_END_REASON } });
		await again.controller.finish("interrupted");
	});

	test("a continued run whose lineage pointer cannot be written does not go on, and the parent stays the candidate", async () => {
		const r = await interruptedWithAnswer();
		const again = reopened(r);
		// The pointer file's directory cannot be written, while the run records (in a subdirectory) still can.
		const pointer = resumePointerFile(again.sessionDir);
		await mkdir(path.dirname(pointer), { recursive: true });
		await chmod(path.dirname(pointer), 0o555);
		try {
			const result = await again.controller.continueInTurn(again.ctx, "이어서", Date.now());
			expect(result).toEqual({ ok: false, reason: RESUME_POINTER_FAILED });
			expect(again.controller.active()).toBeUndefined();
		} finally {
			await chmod(path.dirname(pointer), 0o755);
		}
		// Nothing claims the parent: the next continue takes it, once, and records its successor.
		const next = reopened(r);
		expect(await next.controller.continueInTurn(next.ctx, "이어서", Date.now())).toMatchObject({ ok: true, continued: { from: r.runId } });
		await next.controller.finish("interrupted");
	});

	test("the task is the work and not the question the run was opened with", async () => {
		const r = await interruptedWithAnswer("작업현황");
		const again = reopened(r);
		expect(await again.controller.continueInTurn(again.ctx, "재개", Date.now())).toMatchObject({ ok: true });
		const record = await readRun(again.sessionDir, again.controller.active()!.runId);
		expect(record?.request).toContain("Pin");
		expect(record?.request).toContain("Build");
		expect(record?.request).toContain(pinLane.results![0]!.criterion);
		// It leads with the work; the question is only the earlier request, after its marker.
		const [work, earlier] = record!.request!.split(`\n${EARLIER_REQUEST_MARKER}\n`);
		expect(record?.request?.startsWith(CONTINUATION_HEAD)).toBe(true);
		expect(work).not.toContain("작업현황");
		expect(earlier).toBe("작업현황");
		await again.controller.finish("interrupted");
	});

	test("an accepted result is carried only when its source still proves it", async () => {
		const r = await interruptedWithAnswer();
		await writeFile(path.join(root, "knowledge", "k3.md"), "# k3\nline two\nhead_total: 43\n");
		const again = reopened(r);
		const result = await again.controller.continueInTurn(again.ctx, "이어서 해줘", Date.now());
		expect(result).toMatchObject({ ok: true, continued: { kept: 0, open: ["Pin", "Build"] } });
		expect(again.controller.active()!.results!.find(candidate => candidate.id === RESULT)?.state).not.toBe("accepted");
		await again.controller.finish("interrupted");
	});

	test("no interrupted run: nothing starts", async () => {
		const fresh = fakeSession({ root, timings: TEST_TIMINGS });
		const result = await fresh.controller.continueInTurn(fresh.ctx, "이어서 해줘", Date.now());
		expect(result.ok).toBe(false);
		expect(fresh.controller.active()).toBeUndefined();
		expect(fresh.sent).toEqual([]);
		expect(fresh.leases.held).toEqual([]);
	});

	test("a run that finished is not continued", async () => {
		const r = await rig("끝난 작업");
		await r.h.controller.finish("no-changes");
		const again = reopened(r);
		expect((await again.controller.continueInTurn(again.ctx, "이어서", Date.now())).ok).toBe(false);
		expect(again.controller.active()).toBeUndefined();
	});

	test("a candidate of another session, or of another project, is not continued", async () => {
		const r = await interruptedWithAnswer();
		const otherSession = reopened(r, { sessionId: "another-session-id" });
		expect((await otherSession.controller.continueInTurn(otherSession.ctx, "이어서", Date.now())).ok).toBe(false);
		expect(otherSession.controller.active()).toBeUndefined();
		const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-elsewhere-")));
		try {
			const otherProject = reopened(r, { root: elsewhere });
			expect((await otherProject.controller.continueInTurn(otherProject.ctx, "이어서", Date.now())).ok).toBe(false);
			expect(otherProject.controller.active()).toBeUndefined();
			expect(otherProject.leases.held).toEqual([]);
		} finally {
			await rm(elsewhere, { recursive: true, force: true });
		}
	});

	test("with a run already active nothing is started, and the active run is untouched", async () => {
		const r = await interruptedWithAnswer();
		const again = reopened(r);
		expect(await again.controller.continueInTurn(again.ctx, "이어서", Date.now())).toMatchObject({ ok: true });
		const active = again.controller.active()!.runId;
		expect((await again.controller.continueInTurn(again.ctx, "한 번 더", Date.now())).ok).toBe(false);
		expect(again.controller.active()!.runId).toBe(active);
		await again.controller.finish("interrupted");
	});

	test("a plan the approved team no longer allows starts nothing", async () => {
		const r = await interruptedWithAnswer();
		// The explorer role is gone from the team: the old plan is outside what a plan could be given today.
		const narrowed = reopened(r, { config: teamOf({ implementer: "a/i", reviewer: "a/r" }) });
		const result = await narrowed.controller.continueInTurn(narrowed.ctx, "이어서 해줘", Date.now());
		expect(result.ok).toBe(false);
		expect(narrowed.controller.active()).toBeUndefined();
		expect(narrowed.leases.held).toEqual([]);
		expect(narrowed.sent).toEqual([]);
		// The earlier run is still the candidate: nothing was recorded over it.
		const survivor = reopened(r);
		expect(await survivor.controller.continueInTurn(survivor.ctx, "이어서", Date.now())).toMatchObject({ ok: true, continued: { from: r.runId } });
		await survivor.controller.finish("interrupted");
	});

	test("the menu's resume carries the same task: the work, with the question kept as history", async () => {
		const r = await interruptedWithAnswer("작업현황");
		const candidate = await findResumeCandidate(r.h.sessionDir, { repoId: r.h.repo.repoId, root: r.h.repo.root });
		expect(candidate?.runId).toBe(r.runId);
		const spec = resumeSpec(candidate!, "재개");
		expect(spec).toMatchObject({ ok: true });
		const task = (spec as { spec: { task: string } }).spec.task;
		expect(task.startsWith(CONTINUATION_HEAD)).toBe(true);
		expect(task).toContain("Pin");
		expect(task.split(`\n${EARLIER_REQUEST_MARKER}\n`)[0]).not.toContain("작업현황");
		const again = reopened(r);
		await again.start((spec as { spec: RunSpec }).spec);
		const handoff = again.sent[0]!;
		const taskBlock = handoff.slice(handoff.indexOf("Task:"), handoff.indexOf("Continues"));
		// The director reads the work first; the question, if it is shown at all, comes after its marker.
		expect(taskBlock.indexOf("Pin")).toBeGreaterThan(-1);
		expect(taskBlock.indexOf("Pin")).toBeLessThan(taskBlock.indexOf(EARLIER_REQUEST_MARKER));
		expect(taskBlock.split(EARLIER_REQUEST_MARKER)[0]).not.toContain("작업현황");
		await again.controller.finish("interrupted");
	});
});
