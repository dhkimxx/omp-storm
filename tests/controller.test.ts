import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AsyncJobSnapshot, CompactOptions, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configHash } from "../src/config/canonical.ts";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { tokens } from "../src/report/agents.ts";
import { directorRead, noteChildRead } from "../src/policy/reads.ts";
import { listAgents, noteAgentParked, noteAgentStart, resetAgents } from "../src/runtime/agents.ts";
import {
	CLOSEOUT_TITLE,
	closeoutBrief,
	type CloseoutDraft,
	resetCloseoutChoices,
	takeCloseoutChoice,
} from "../src/runtime/closeout.ts";
import { noteRunSpawn, noteRunUserWait, runSpawns, summarizeRun, touchRun } from "../src/runtime/controller.ts";
import { processKey, readTrustedRuns, recordTrustedRun } from "../src/runtime/janitor.ts";
import { activeLedgerRun, getLedgerRun, recordCost, resetLedger } from "../src/runtime/ledger.ts";
import { HOLD_MS, ROUND_DELAY_MS, treeFingerprint } from "../src/runtime/rounds.ts";
import { lastRun, readRun, runIds, runsDir, writeRun } from "../src/runtime/run.ts";
import { trustedResume, resumePointerFile, noteResumePointer } from "../src/runtime/resume.ts";
import { readRunIndex } from "../src/runtime/run-index.ts";
import { readTrialStates, updateTrialState } from "../src/runtime/state-files.ts";
import type { TreeReading, TreeState } from "../src/runtime/tree.ts";
import type { RunPhase } from "../src/view/appearance.ts";
import { CLOSEOUT_CHOICE_HINT, renderCloseout } from "../src/view/closeout.ts";
import type { ProjectState } from "../src/state.ts";
import type {
	AgentEntry,
	CloseoutRecordStyle,
	RunPlan,
	RunRecord,
	RunSpec,
	ShadowInfo,
	SpawnBlockCode,
	SpawnRecord,
	StormConfig,
} from "../src/types.ts";
import { fakeModes, fakeSession, SESSION_TEAM, type FakeSession, type SessionOptions, until } from "./fake-session.ts";
import { agentEntry, approvedState, DEAD_PROCESS, runRecord, spawnRecord, treeOf } from "./fixtures.ts";

const spawn = spawnRecord();
const agent = agentEntry;

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-controller-")));
});

afterEach(async () => {
	vi.useRealTimers();
	resetCloseoutChoices();
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (opts: Omit<SessionOptions, "root"> = {}) => fakeSession({ root, ...opts });
const ask = (task: string): RunSpec => ({ task });
const usage = (tokens: number, percent: number, contextWindow = 400_000) => ({ tokens, contextWindow, percent });
const T0 = Date.parse("2026-11-20T09:00:00Z");
const TREE_BASE = "base-0";
const TREE0 = treeOf("d0", "f0");
const F0 = treeFingerprint(TREE0);
const treeAt = (state: TreeState = TREE0, base = TREE_BASE): TreeReading => ({ base, state });
const writer = (over: Partial<AgentEntry> = {}): AgentEntry => agentEntry({ changes: 1, lastChangeAt: T0, ...over });
interface StructuredReviewAgent extends AgentEntry {
	reviewLog: Array<{ at: number; correct: boolean; findings: never[]; tree?: string }>;
}
/**
 * A reviewer verdict with both the legacy latest verdict and the structured proof the current gate reads. Without a
 * tree fingerprint the verdict is readable history but cannot bind to the tree, which is what the gate should reject.
 */
const verdict = (at: number, correct: boolean, tree?: string, over: Partial<AgentEntry> = {}): StructuredReviewAgent => ({
	...agentEntry({
		id: "Rev",
		name: "storm-reviewer",
		role: "reviewer",
		review: { reviews: 1, passed: correct ? 1 : 0, failed: correct ? 0 : 1, findings: [0, 0, 0, 0] },
		lastVerdict: { at, correct, ...(tree !== undefined ? { tree } : {}) },
		...over,
	}),
	reviewLog: [{ at, correct, findings: [], ...(tree !== undefined ? { tree } : {}) }],
});

/** Admits the plan's first lane and settles a successful worker for it, as the extension does on a real spawn. */
function completeLane(h: FakeSession, plan: RunPlan, agents: AgentEntry[], at = T0 + 1): void {
	const lane = plan.lanes[0];
	if (lane === undefined) return;
	const lanes = h.controller.runLanes();
	if (lanes === undefined) throw new Error("the run has no lane matcher");
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const bound = lanes.assign({ name: lane.name, agent }, plan, h.config);
	if (!bound.ok) throw new Error(bound.reason);
	const name = (bound.input as Record<string, unknown>).name;
	if (typeof name !== "string") throw new Error("the lane binding has no task name");
	lanes.admit({ spawnKey: name, agent, outcome: "routed" });
	agents.push(agentEntry({ id: name, name: agent, role: lane.role, state: "idle", requests: 1, lastActivityAt: at }));
}

describe("live run record", () => {
	// The live rewrite is debounced on a real timer: these two drive it with fake timers and wait only for the file.
	test("a running run is rewritten after spawns and spend: the record a crash leaves behind", async () => {
		const h = session({ agents: [agent()] });
		const runId = await h.start();
		expect((await readRun(h.sessionDir, runId))?.spawns).toEqual([]);

		vi.useFakeTimers();
		noteRunSpawn(runId, spawn);
		recordCost(runId, "a/i", 1.25);
		touchRun(runId);
		vi.runAllTimers();
		await until(async () => (await readRun(h.sessionDir, runId))?.updatedAt !== undefined);

		const live = await readRun(h.sessionDir, runId);
		expect(live).toMatchObject({ status: "running", costUsd: 1.25, spawns: [{ spawnKey: "Impl" }], agents: [{ id: "Impl" }] });
		await h.controller.finish("no-changes");
	});

	test("the final record is not overwritten by a pending live write, and a finished run takes no more of them", async () => {
		const h = session({ agents: [agent({ followUps: 2 })] });
		const runId = await h.start();
		vi.useFakeTimers();
		noteRunSpawn(runId, spawn);
		const final = await h.controller.finish("no-changes");
		touchRun(runId);
		vi.runAllTimers();

		const stored = await readRun(h.sessionDir, runId);
		expect(stored).toMatchObject({ status: "ended", spawns: [{ spawnKey: "Impl" }], agents: [{ id: "Impl", followUps: 2 }] });
		expect(stored?.endedAt).toBe(final?.endedAt);
		expect(stored?.updatedAt).toBeUndefined();
		// The run's spawn list ended with it.
		expect(runSpawns(runId)).toEqual([]);
	});
});

describe("live status line", () => {
	test("the run is reported at its start, when a round is sent, and undefined once at its verified end", async () => {
		const calls: Array<RunRecord | undefined> = [];
		const agents = [writer()];
		const h = session({ agents, tree: () => treeAt(), live: (_ctx, run) => calls.push(run) });
		const runId = await h.start();
		expect(calls.at(-1)).toMatchObject({ runId, status: "running", turns: 0, maxRounds: 4 });
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(calls.at(-1)).toMatchObject({ runId, status: "running", turns: 1, maxRounds: 4 });
		agents.push(verdict(T0 + 1, true, F0));
		await h.turn();
		expect(calls.filter(run => run === undefined)).toHaveLength(1);
		expect(calls.at(-1)).toBeUndefined();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "done", endReason: "verified" });
	});

	test("an interrupted end reports the end once", async () => {
		const calls: Array<RunRecord | undefined> = [];
		const h = session({ live: (_ctx, run) => calls.push(run) });
		const runId = await h.start();
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx);
		expect(calls.filter(run => run === undefined)).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "interrupted" });
	});

	test("an end taken at the round timer reports the end once", async () => {
		const calls: Array<RunRecord | undefined> = [];
		let now = T0;
		const h = session({ agents: [writer()], now: () => now, live: (_ctx, run) => calls.push(run) });
		const runId = await h.start({ task: "t", minutes: 10 });
		await h.turn();
		expect(calls.filter(run => run === undefined)).toHaveLength(0);
		now = T0 + 10 * 60_000;
		h.timers.fire();
		await until(() => calls.some(run => run === undefined));
		expect(calls.filter(run => run === undefined)).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "time-limit" });
	});

	test("a budget stop between turns reports the end once", async () => {
		const calls: Array<RunRecord | undefined> = [];
		const h = session({
			config: { ...SESSION_TEAM, budget: { perRunUsd: 1, onExceed: "stop" } },
			agents: [writer()],
			live: (_ctx, run) => calls.push(run),
		});
		const runId = await h.start();
		await h.turn();
		recordCost(runId, "a/i", 2);
		await until(() => calls.some(run => run === undefined));
		expect(calls.filter(run => run === undefined)).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget" });
	});

	test("a live flush hands the hook the record as it is then", async () => {
		const calls: Array<RunRecord | undefined> = [];
		const h = session({ live: (_ctx, run) => calls.push(run) });
		const runId = await h.start();
		vi.useFakeTimers();
		noteRunSpawn(runId, spawn);
		touchRun(runId);
		vi.runAllTimers();
		expect(calls.at(-1)).toMatchObject({ runId, status: "running", spawns: [{ spawnKey: "Impl" }] });
		await h.controller.finish("no-changes");
	});

	test("the end is reported only once the final record is on disk", async () => {
		const seen: Array<{ status: string; endReason?: string }> = [];
		let runId = "";
		const h = session({
			live: (_ctx, run) => {
				if (run !== undefined) return;
				// Read synchronously at the call: a record still saying running would be the one before the final write.
				const stored = JSON.parse(readFileSync(path.join(runsDir(h.sessionDir), `${runId}.json`), "utf8")) as RunRecord;
				seen.push({ status: stored.status, ...(stored.endReason !== undefined ? { endReason: stored.endReason } : {}) });
			},
		});
		runId = await h.start();
		await h.turn();
		expect(seen).toEqual([{ status: "ended", endReason: "no-changes" }]);
	});

	test("a live hook that throws does not keep the run from ending", async () => {
		const h = session({
			agents: [writer()],
			live: () => {
				throw new Error("status line failed");
			},
		});
		const runId = await h.start();
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		await h.turn();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "no-progress" });
		expect(h.summaries()).toBe(1);
	});
});

describe("live phase", () => {
	test("no run claims no phase; a run starts working, stops explicitly and clears", async () => {
		const phases: Array<RunPhase | undefined> = [];
		let h!: FakeSession;
		h = session({
			live: (_ctx, run) => {
				phases.push(run === undefined ? undefined : h.controller.phase());
			},
		});
		expect(h.controller.phase()).toBeUndefined();
		await h.start();
		expect(h.controller.phase()).toBe("working");
		await h.controller.finish("no-changes", h.ctx);
		expect(h.controller.phase()).toBeUndefined();
		// The live callback saw the working start, the stopping edge and the final clear, in that order.
		expect(phases.filter(phase => phase !== undefined)).toEqual(["working", "stopping"]);
		expect(phases.at(-1)).toBeUndefined();
	});

	test("real dialogs are waiting-user; resolving, settling or finishing clears them", async () => {
		const h = session();
		const runId = await h.start();
		noteRunUserWait(runId, "ask:1", true);
		expect(h.controller.phase()).toBe("waiting-user");
		noteRunUserWait(runId, "approval:2", true);
		expect(h.controller.phase()).toBe("waiting-user");
		noteRunUserWait(runId, "ask:1", false);
		expect(h.controller.phase()).toBe("waiting-user");
		noteRunUserWait(runId, "approval:2", false);
		expect(h.controller.phase()).toBe("working");

		// A settled turn drops a key its dialog never closed (an aborted prompt has no matching end event).
		noteRunUserWait(runId, "ask:aborted", true);
		await h.turn();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "ended" });
		expect(h.controller.phase()).toBeUndefined();
	});

	test("a late dialog from a finished run cannot mark the next run as waiting", async () => {
		const first = session();
		const firstId = await first.start();
		noteRunUserWait(firstId, "ask:old", true);
		expect(first.controller.phase()).toBe("waiting-user");
		await first.controller.finish("no-changes");

		const second = session();
		const secondId = await second.start();
		noteRunUserWait(firstId, "ask:old-end", false);
		noteRunUserWait(firstId, "ask:late", true);
		expect(second.controller.phase()).toBe("working");
		// A key of the live run still works, and its own end clears only itself.
		noteRunUserWait(secondId, "ask:new", true);
		expect(second.controller.phase()).toBe("waiting-user");
		noteRunUserWait(secondId, "ask:new", false);
		expect(second.controller.phase()).toBe("working");
		await second.controller.finish("no-changes");
	});

	test("workers and verifying come from run-bound agents, never from a plan or another session's jobs", async () => {
		const agents: AgentEntry[] = [];
		let running: AsyncJobSnapshot["running"] = [
			{ id: "foreign", type: "task", status: "running", label: "other session", startTime: 0, ownerId: "Other" },
		];
		const h = session({
			agents,
			asyncJobs: () => ({ running, recent: [], delivery: {} as AsyncJobSnapshot["delivery"] }),
		});
		const runId = await h.start();
		h.controller.onAgentStart();
		expect(h.controller.phase()).toBe("working");
		// A global job that belongs to no run agent is not this run's worker.
		touchRun(runId);
		expect(h.controller.phase()).toBe("working");

		agents.push(agentEntry({ id: "Impl", name: "storm-implementer", role: "implementer", state: "running" }));
		touchRun(runId);
		expect(h.controller.phase()).toBe("workers");

		agents[0]!.state = "idle";
		agents.push(agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", state: "running" }));
		touchRun(runId);
		expect(h.controller.phase()).toBe("verifying");

		// Settling the reviewer returns to the director's own turn, not a leftover verifying claim.
		agents[1]!.state = "idle";
		touchRun(runId);
		expect(h.controller.phase()).toBe("working");

		// A host async job is evidence only when bound to an agent of this run.
		running = [{ id: "job", type: "task", status: "running", label: "run job", startTime: 0, agentId: "Impl" }];
		touchRun(runId);
		expect(h.controller.phase()).toBe("workers");

		running = [];
		// Async waiting is a round wait, never a question to the user.
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		expect(h.controller.phase()).toBe("between-rounds");
		h.controller.onAgentStart();
		expect(h.controller.phase()).toBe("working");
		await h.controller.finish("no-changes");
	});

	test("a stopping run keeps the stopping phase while it drains, then reports none", async () => {
		const agents = [agentEntry({ id: "Impl", role: "implementer", state: "running" })];
		const h = session({ agents });
		const runId = await h.start();
		expect(await h.controller.finish("no-changes")).toBeUndefined();
		expect(h.controller.phase()).toBe("stopping");
		agents[0]!.state = "idle";
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.status !== "running");
		expect(h.controller.phase()).toBeUndefined();
	});

	test("verifying is claimed only while runRequiredChecks is actually running", async () => {
		const agents: AgentEntry[] = [writer(), verdict(T0 + 1, true, "d1:f0")];
		let tree = treeOf("d0", "f0");
		const config: StormConfig = {
			...SESSION_TEAM,
			requiredChecks: [{ name: "slow", argv: ["/bin/sh", "-c", "sleep 0.2"] }],
		};
		const h = session({ config, agents, tree: () => treeAt(tree) });
		const runId = await h.start({ task: "probe", rounds: 1 });
		tree = treeOf("d1", "f0");
		await h.turn();
		// The round is over and the check look is pending: a round wait, not verification yet.
		expect(h.controller.phase()).toBe("between-rounds");
		h.timers.fire();
		await until(() => h.controller.phase() === "verifying");
		await until(async () => (await readRun(h.sessionDir, runId))?.status !== "running");
		expect(h.controller.phase()).toBeUndefined();
	});
});

describe("run start", () => {
	test("starts without asking: record written, ledger opened, one handoff carrying the task and the run id", async () => {
		const task = "fix the login bug";
		const h = session();
		const result = await h.controller.start(h.ctx, ask(task));
		if (!result.ok) throw new Error(result.reason);
		expect(h.controller.directing()).toBe(true);
		expect(h.controller.runId()).toBe(result.runId);
		expect(activeLedgerRun(h.sessionDir)?.runId).toBe(result.runId);
		const record = await readRun(h.sessionDir, result.runId);
		expect(record).toMatchObject({ status: "running", configHash: configHash(SESSION_TEAM), task, process: processKey(), turns: 0 });
		expect(record?.limits).toBeUndefined();
		// Nothing of the retired keyword contract is written any more.
		expect(record && "contract" in record).toBe(false);
		expect(record && "approvalId" in record).toBe(false);
		expect(h.ui.selects).toEqual([]);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain(task);
		expect(h.sent[0]).toContain(result.runId);
		await h.controller.finish("no-changes");
	});

	test("the record keeps the limits the user stated with the request", async () => {
		const h = session();
		const runId = await h.start({ task: "t", rounds: 5, minutes: 30 });
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ turns: 0, limits: { rounds: 5, minutes: 30 } });
		await h.controller.finish("no-changes");
		const one = session();
		const only = await one.start({ task: "t", minutes: 1 });
		expect((await readRun(one.sessionDir, only))?.limits).toEqual({ minutes: 1 });
		await one.controller.finish("no-changes");
	});

	test("the record keeps the round bound fixed at its start; the index line does not carry it", async () => {
		const h = session();
		const runId = await h.start({ task: "t", rounds: 5 });
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ turns: 0, maxRounds: 5 });
		await h.turn();
		const [line] = await readRunIndex(h.sessionDir);
		expect(line).toMatchObject({ runId, turns: 1 });
		expect(line && "maxRounds" in line).toBe(false);
	});

	test("a start is refused while omp's goal is active or its loop is on", async () => {
		for (const modes of [fakeModes({ goal: "active" }), fakeModes({ loop: "active" }), fakeModes({ loop: "paused" })]) {
			const h = session({ modes });
			const result = await h.controller.start(h.ctx, ask("t"));
			expect(result.ok).toBe(false);
			expect(h.sent).toEqual([]);
			expect(h.controller.directing()).toBe(false);
			expect(await runIds(h.sessionDir)).toEqual([]);
		}
	});

	test("a paused goal and a host without mode control still start", async () => {
		for (const modes of [fakeModes({ goal: "paused" }), null]) {
			const h = session({ modes });
			const runId = await h.start(ask("t"));
			expect((await readRun(h.sessionDir, runId))?.status).toBe("running");
			await h.controller.finish("shutdown");
		}
	});

	test("an active goal or loop refuses before asking to leave vibe", async () => {
		for (const modes of [fakeModes({ vibe: true, goal: "active" }), fakeModes({ vibe: true, loop: "active" })]) {
			const h = session({ modes, answers: [options => options[0]] });
			expect((await h.controller.start(h.ctx, ask("t"))).ok).toBe(false);
			expect(h.ui.selects).toEqual([]);
			expect(h.modes?.state.vibe.status).toBe("active");
			expect(h.sent).toEqual([]);
		}
	});

	test("omp vibe mode is left first when the user agrees; declining starts nothing", async () => {
		const h = session({ modes: fakeModes({ vibe: true }), answers: [options => options[0]] });
		await h.start(ask("t"));
		expect(h.ui.selects).toHaveLength(1);
		expect(h.events.slice(0, 2)).toEqual(["select", "set:vibe:exit"]);
		expect(h.modes?.state.vibe.status).toBe("inactive");
		await h.controller.finish("shutdown");
		for (const answer of [(options: string[]) => options[1], undefined]) {
			const declined = session({ modes: fakeModes({ vibe: true }), answers: [answer] });
			expect((await declined.controller.start(declined.ctx, ask("t"))).ok).toBe(false);
			expect(declined.sent).toEqual([]);
		}
	});

	test("the record keeps the first 200 characters of a long request; the handoff carries all of it", async () => {
		const task = "x".repeat(500);
		const h = session();
		const runId = await h.start(ask(task));
		const record = await readRun(h.sessionDir, runId);
		expect(record?.task).toHaveLength(200);
		expect(record?.request).toBe(task);
		expect(h.sent[0]).toContain(task);
		await h.controller.finish("no-changes");
	});

	test("the recorded request is cut at 20,000 characters", async () => {
		const task = "y".repeat(20_500);
		const h = session();
		const runId = await h.start(ask(task));
		expect((await readRun(h.sessionDir, runId))?.request).toHaveLength(20_000);
		await h.controller.finish("no-changes");
	});

	test("a run started with resumeOf records it and the handoff continues the old run with its plan", async () => {
		const old = runRecord({
			runId: "run-20261119-090000-aaaa",
			startedAt: "2026-11-19T09:00:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			turns: 2,
			request: "the earlier request",
			plan: {
				lanes: [{ name: "login", kind: "code", role: "implementer", goal: "fix the login", files: ["login.ts"],
					results: [{ id: "login-fix", kind: "change", criterion: "fix the login", path: "login.ts" }] }],
				workers: { implementer: 1 },
				submittedAt: "2026-11-19T09:00:00.000Z",
			},
		});
		const h = session();
		await writeRun(h.sessionDir, old);
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old);
		const runId = await h.start({ task: "carry on", resumeOf: old.runId });
		expect(await readRun(h.sessionDir, runId)).toMatchObject({
			request: "carry on", resumeOf: old.runId, plan: { lanes: old.plan!.lanes },
		});
		expect(h.sent[0]).toContain(old.runId);
		expect(h.sent[0]).toContain("(interrupted)");
		expect(h.sent[0]).toContain("Still open: login");
		await h.controller.finish("no-changes");
	});

	test("a continuation with no readable record cannot start work from scratch", async () => {
		const h = session();
		const result = await h.controller.start(h.ctx, { task: "t", resumeOf: "run-20261119-000000-none" });
		expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("이전 실행을 읽을 수 없어") });
		expect(await runIds(h.sessionDir)).toEqual([]);
	});

	test("a started call with no receipt remains non-replayable across a continuation that omitted its lane", async () => {
		const marker = path.join(root, "reran");
		const h = session({
			config: { ...SESSION_TEAM, jobs: [{ name: "experiment", argv: [process.execPath, "-e",
				`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected"); console.log("OK");`] }] },
		});
		const old = runRecord({
			runId: "run-20261119-090000-ab12", status: "stopped", request: "run the experiment", endReason: "interrupted",
			jobs: [{ lane: "experiment", name: "experiment", status: "started", exitCode: null,
				startedAt: "2026-11-19T09:00:00.000Z", finishedAt: null, attemptId: "job:run-20261119-090000-ab12:1" }],
		});
		await writeRun(h.sessionDir, old);
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old);
		const middle = await h.start({ task: "continue", resumeOf: old.runId });
		await h.controller.finish("interrupted");

		const next = await h.start({ task: "continue again", resumeOf: middle });
		const plan: RunPlan = {
			submittedAt: "2026-11-20T09:00:00.000Z", workers: {},
			lanes: [{ name: "experiment", kind: "run", role: "quick", job: "experiment",
				results: [{ id: "experiment-outcome", kind: "answer", criterion: "record observed outcome", contains: "OK" }] }],
		};
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		expect(await h.controller.executeJobs(h.ctx, ["experiment"], () => true)).toMatchObject({
			ok: true, text: expect.stringContaining("재실행하지 않습니다"),
		});
		await h.controller.finish("no-progress");
		expect(existsSync(marker)).toBe(false);
		expect(await readRun(h.sessionDir, next)).toMatchObject({
			results: [{ id: "experiment-outcome", state: "unmet", remedy: "blocked" }],
			jobs: [{ name: "experiment", status: "unknown" }],
		});
	});

	test("a start points this machine at its run; the pointer covers the request", async () => {
		const h = session();
		const runId = await h.start({ task: "the request" });
		const record = await readRun(h.sessionDir, runId);
		if (!record) throw new Error("the run record is missing");
		const target = { repoId: h.repo.repoId, root: h.repo.root };
		expect(await trustedResume(h.sessionDir, target, record)).toBe(true);
		// A record edited after the start, or named as another run, is not what this machine started.
		expect(await trustedResume(h.sessionDir, target, { ...record, request: "edited request" })).toBe(false);
		expect(await trustedResume(h.sessionDir, target, { ...record, runId: "run-20261119-000000-other" })).toBe(false);
		await h.controller.finish("no-changes");
	});

	test("a pointer that cannot be written does not stop the run", async () => {
		const h = session();
		// The pointer path exists as a directory, so the atomic write of the resume pointer fails while the run record
		// itself is still writable.
		await mkdir(resumePointerFile(h.sessionDir), { recursive: true });
		const runId = await h.start({ task: "t" });
		expect(h.controller.directing()).toBe(true);
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "running" });
		await h.controller.finish("no-changes");
	});

	test("a malformed plan in the old record gives no plan part and the start succeeds", async () => {
		const old = runRecord({
			runId: "run-20261119-090000-bad0",
			status: "stopped",
			endReason: "interrupted",
			turns: 1,
			request: "the earlier request",
			task: "the earlier request",
			plan: { lanes: "x" } as unknown as NonNullable<RunRecord["plan"]>,
		});
		const h = session();
		await writeRun(h.sessionDir, old);
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old);
		const runId = await h.start({ task: "carry on", resumeOf: old.runId });
		expect(h.sent[0]).toContain(old.runId);
		expect(h.sent[0]).not.toContain("Earlier plan:");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ resumeOf: old.runId, status: "running" });
		await h.controller.finish("no-changes");
	});

	test("a resume pointer recorded on one target cannot continue the run on another target", async () => {
		const first = session();
		const old = runRecord({
			runId: "run-20261119-090000-tgt0",
			startedAt: "2026-11-19T09:00:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			request: "the earlier request",
		});
		await writeRun(first.sessionDir, old);
		await noteResumePointer(first.sessionDir, { repoId: first.repo.repoId, root: first.repo.root }, old);

		// The same native session reopens its own store but the target is a different work tree.
		const otherRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-other-target-")));
		try {
			const otherState = approvedState(otherRoot, SESSION_TEAM, { agentDir: first.agentDir, sessionId: first.sessionId });
			const moved = fakeSession({
				root: otherRoot,
				agentDir: first.agentDir,
				sessionId: first.sessionId,
				loadState: async () => otherState,
			});
			expect(moved.sessionDir).toBe(first.sessionDir);
			const result = await moved.controller.start(moved.ctx, { task: "carry on", resumeOf: old.runId });
			expect(result.ok).toBe(false);
			expect(result.ok ? "" : result.reason).toContain("작업 트리");
			expect(await runIds(moved.sessionDir)).toEqual([old.runId]);
			expect(moved.controller.active()).toBeUndefined();
		} finally {
			await rm(otherRoot, { recursive: true, force: true });
		}
	});

	test("a resume handoff names the cut request limit and the user's note on one line", async () => {
		const request = "r".repeat(20_000);
		const old = runRecord({
			runId: "run-20261119-090000-cu70",
			status: "stopped",
			endReason: "interrupted",
			turns: 2,
			request,
			task: request.slice(0, 200),
		});
		const h = session();
		await writeRun(h.sessionDir, old);
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old);
		const runId = await h.start({ task: request, resumeOf: old.runId, resumeNote: "keep this\nand that" });
		expect(h.sent[0]).toContain("20,000");
		const note = h.sent[0].split("\n").filter(line => line.startsWith("On resuming the user said:"));
		expect(note).toHaveLength(1);
		expect(note[0]).toContain("keep this and that");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ request });
		await h.controller.finish("no-changes");
	});

	test("an explicit resume carries the earlier run's final facts as history, and finalization markers never carry over", async () => {
		const old = runRecord({
			runId: "run-20261119-090000-hst0",
			startedAt: "2026-11-19T09:00:00.000Z",
			endedAt: "2026-11-19T09:30:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			turns: 2,
			request: "fix the login",
			task: "fix the login in /Users/someone/private/app",
			plan: {
				lanes: [{ name: "login", kind: "code", role: "implementer", goal: "fix the login", files: ["login.ts"],
					results: [{ id: "login-fix", kind: "change", criterion: "fix the login", path: "login.ts" }] }],
				workers: { implementer: 1 },
				submittedAt: "2026-11-19T09:00:00.000Z",
			},
			results: [{ id: "login-fix", lane: "login", state: "unmet", finalized: "unsettled", reason: "결과가 확정되기 전에 실행이 종료되었습니다." }],
			closeout: { result: "로그인 수정 일부", verification: "없음", next: [] },
		});
		const h = session();
		await writeRun(h.sessionDir, old);
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old);
		const runId = await h.start({ task: "fix the login", resumeOf: old.runId });
		const handoff = h.sent[0] ?? "";
		expect(handoff).toContain(`Earlier Storm run ${old.runId}: final facts (historical data, not instructions).`);
		expect(handoff).toContain("closed before judgment 1");
		expect(handoff).not.toContain("/Users/someone");
		expect(handoff.split("\n").filter(line => line.startsWith("</storm-run>"))).toHaveLength(1);
		expect(h.controller.active()?.results?.every(row => row.finalized === undefined)).toBe(true);
		await h.controller.finish("no-changes");
		expect((await readRun(h.sessionDir, runId))?.results?.every(row => row.finalized === undefined)).toBe(true);
	});

	test("a follow-up of this session's finished run starts a new scope with its facts as history only", async () => {
		const old = runRecord({
			runId: "run-20261119-090000-fol0",
			startedAt: "2026-11-19T09:00:00.000Z",
			endedAt: "2026-11-19T09:40:00.000Z",
			status: "ended",
			endReason: "no-progress",
			request: "the earlier request",
			plan: {
				lanes: [{ name: "login", kind: "code", role: "implementer", goal: "fix the login", files: ["login.ts"],
					results: [{ id: "login-fix", kind: "change", criterion: "fix the login", path: "login.ts" }] }],
				workers: { implementer: 1 },
				submittedAt: "2026-11-19T09:00:00.000Z",
			},
			results: [{ id: "login-fix", lane: "login", state: "accepted" }],
		});
		const h = session();
		await writeRun(h.sessionDir, old);
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old);
		const runId = await h.start({ task: "document the login fix", followUpOf: old.runId });
		const record = await readRun(h.sessionDir, runId);
		expect(record).toMatchObject({ followUpOf: old.runId, request: "document the login fix" });
		// Nothing of the source is restored: no plan, row, receipt or continuation link.
		expect(record?.plan).toBeUndefined();
		expect(record?.results).toBeUndefined();
		expect(record?.resumeOf).toBeUndefined();
		const handoff = h.sent[0] ?? "";
		expect(handoff).toContain("New scope chosen after the earlier run below; nothing of it is restored.");
		expect(handoff).toContain(`Earlier Storm run ${old.runId}: final facts`);
		expect(handoff).not.toContain("Continues run");
		await h.controller.finish("no-changes");
	});

	test("a stale, foreign or unfinished follow-up reference is declined, and an unrelated task carries no history", async () => {
		const h = session();
		const finished = runRecord({ runId: "run-20261119-090000-fol1", status: "done", endReason: "verified", request: "earlier" });
		const running = runRecord({ runId: "run-20261119-090000-fol2", status: "running", request: "still going" });
		const unpointed = runRecord({ runId: "run-20261119-090000-fol3", status: "done", endReason: "verified", request: "not ours" });
		for (const run of [finished, running, unpointed]) await writeRun(h.sessionDir, run);
		const target = { repoId: h.repo.repoId, root: h.repo.root };
		await noteResumePointer(h.sessionDir, target, running);
		// The pointer names a different request than the record now holds: an edited record is not what this machine ran.
		await noteResumePointer(h.sessionDir, target, { ...finished, request: "something else" });
		for (const ref of [running.runId, unpointed.runId, finished.runId, "run-20261119-090000-none", "../escape"]) {
			const result = await h.controller.start(h.ctx, { task: "next", followUpOf: ref });
			expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("후속 작업") });
			expect(h.sent).toEqual([]);
		}
		const both = await h.controller.start(h.ctx, { task: "next", followUpOf: finished.runId, resumeOf: finished.runId });
		expect(both.ok).toBe(false);
		const runId = await h.start({ task: "an unrelated request" });
		expect((await readRun(h.sessionDir, runId))?.followUpOf).toBeUndefined();
		expect(h.sent[0]).not.toContain("Earlier Storm run");
		await h.controller.finish("no-changes");
	});

	test("a team that may not run starts nothing: no config, invalid, unapproved, another hash, an unapproved shadow", async () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/r/.omp/agents/rev.md", scope: "project", sha256: "1".repeat(64) };
		const broken: Array<(state: ProjectState) => ProjectState> = [
			s => ({ ...s, config: { status: "missing", path: "x" } }),
			s => ({ ...s, config: { status: "invalid", path: "x", errors: ["bad"] } }),
			s => ({ ...s, approval: undefined }),
			s => ({ ...s, approval: s.approval && { ...s.approval, configHash: `jcs-sha256:${"f".repeat(64)}` } }),
			s => ({ ...s, shadows: [shadow] }),
		];
		const reasons = new Set<string>();
		for (const state of broken) {
			const h = session({ state });
			const result = await h.controller.start(h.ctx, ask("task"));
			expect(result.ok).toBe(false);
			if (!result.ok) reasons.add(result.reason);
			expect(h.controller.directing()).toBe(false);
			expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
			expect(h.sent).toEqual([]);
			// The refusal is not sticky: nothing is left starting or queued.
			expect(h.controller.refusal()).toBeUndefined();
			expect(await lastRun(h.sessionDir)).toBeUndefined();
		}
		// Missing, invalid, unapproved (either way) and shadowed each say something different.
		expect(reasons.size).toBe(4);
	});

	test("a run refuses to start when the host exposes no session identity", async () => {
		const h = session();
		Object.assign(h.ctx, { sessionManager: { ...h.ctx.sessionManager, getSessionId: (() => undefined) as unknown as () => string } });
		const result = await h.controller.start(h.ctx, ask("t"));
		expect(result.ok).toBe(false);
		expect(h.controller.directing()).toBe(false);
		expect(await runIds(h.sessionDir)).toEqual([]);
	});

	test("one run per session; a different session may read the same target at the same time", async () => {
		const first = session();
		await first.start();
		expect((await first.controller.start(first.ctx, ask("again"))).ok).toBe(false);
		expect(first.controller.request(ask("again")).ok).toBe(false);
		// Different native sessions own different stores and read claims: they do not refuse each other.
		const second = session();
		expect((await second.controller.start(second.ctx, ask("other session"))).ok).toBe(true);
		expect(second.sent).toHaveLength(1);
		expect(await runIds(second.sessionDir)).toHaveLength(1);
		expect(await runIds(first.sessionDir)).toHaveLength(1);
		await first.controller.finish("no-changes");
		await second.controller.finish("no-changes");
	});

	test("a different session's concurrent read run does not block this start", async () => {
		const other = session();
		const h = session({ usage: usage(200_000, 50), compact: async () => void (await other.start()) });
		const result = await h.controller.start(h.ctx, ask("late"));
		expect(result.ok).toBe(true);
		expect(h.sent).toHaveLength(1);
		expect(h.controller.directing()).toBe(true);
		expect(await runIds(h.sessionDir)).toHaveLength(1);
		expect(await runIds(other.sessionDir)).toHaveLength(1);
		await h.controller.finish("no-changes");
		await other.controller.finish("no-changes");
	});

	test("below both thresholds nothing is compacted; 150k tokens or half the window is heavy", async () => {
		const compactions = async (tokens: number, percent: number): Promise<number> => {
			const h = session({ usage: usage(tokens, percent) });
			await h.start();
			expect(h.sent).toHaveLength(1);
			await h.controller.finish("no-changes");
			return h.events.filter(event => event === "compact").length;
		};
		expect(await compactions(149_999, 49)).toBe(0);
		expect(await compactions(150_000, 10)).toBe(1);
		expect(await compactions(60_000, 50)).toBe(1);
		// No usage known (a fresh session): nothing to compact.
		const blind = session();
		await blind.start();
		expect(blind.events).toEqual(["send"]);
		await blind.controller.finish("no-changes");
	});

	test("a heavy context is compacted first: the size is announced, then the compaction, then the handoff", async () => {
		const seen: Array<{ notices: number; sent: number; directing: boolean; instructions: number }> = [];
		const h = session({
			usage: usage(160_000, 40),
			compact: async instructions => {
				seen.push({ notices: h.notices.length, sent: h.sent.length, directing: h.controller.directing(), instructions: instructions.length });
			},
		});
		await h.start();
		// One notice before the compaction, naming the size being compacted; nothing of the run exists yet.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ notices: 1, sent: 0, directing: false });
		expect(seen[0]?.instructions).toBeGreaterThan(0);
		expect(h.notices[0]?.text).toContain(tokens(160_000));
		expect(h.events).toEqual(["compact", "send"]);
		await h.controller.finish("no-changes");
	});

	test("a failed compaction is reported and the run starts anyway", async () => {
		const h = session({
			usage: usage(300_000, 75),
			compact: async () => {
				throw new Error("already compacting");
			},
		});
		const runId = await h.start();
		const warnings = h.notices.filter(n => n.level === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.text).toContain("already compacting");
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "running" });
		await h.controller.finish("no-changes");
	});

	test("a queued run starts detached from the agent_end handler: a slow compaction does not hold the handler", async () => {
		const compaction = Promise.withResolvers<void>();
		const task = "after the slow compaction";
		const h = session({ usage: usage(200_000, 50), compact: () => compaction.promise });
		const queued = h.controller.request(ask(task));
		if (!queued.ok) throw new Error(queued.reason);

		// omp gives the handler 30 s; it returns while the compaction is still running.
		await h.controller.onAgentEnd({}, h.ctx);
		await until(() => h.events.includes("compact"));
		expect(h.sent).toEqual([]);
		expect(h.controller.directing()).toBe(false);
		// The session settles again meanwhile (the compaction itself ends a loop): nothing starts twice, nothing ends.
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.request(ask("second")).ok).toBe(false);
		expect((await h.controller.start(h.ctx, ask("second"))).ok).toBe(false);

		compaction.resolve();
		await until(() => h.sent.length > 0);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain(task);
		expect(h.controller.runId()).toBe(queued.runId);
		expect(h.notices.some(n => n.level !== "info")).toBe(false);
		await h.controller.finish("no-changes");
	});

	test("a queued run waits for a terminal agent_end and starts exactly once", async () => {
		const h = session();
		const queued = h.controller.request(ask("queued"));
		if (!queued.ok) throw new Error(queued.reason);
		// Queued: a second request and a direct start are refused, and nothing has started.
		expect(h.controller.request(ask("second")).ok).toBe(false);
		expect((await h.controller.start(h.ctx, ask("second"))).ok).toBe(false);
		await h.controller.onAgentEnd({ willContinue: true }, h.ctx);
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		expect(h.sent).toEqual([]);
		expect(await runIds(h.sessionDir)).toEqual([]);

		await h.controller.onAgentEnd({}, h.ctx);
		await until(() => h.sent.length > 0);
		expect(h.controller.runId()).toBe(queued.runId);
		// Later settles before the handoff turn begins start nothing more and end nothing.
		await h.controller.onAgentEnd({}, h.ctx);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await runIds(h.sessionDir)).toEqual([queued.runId]);
		expect(h.notices.some(n => n.level !== "info")).toBe(false);
		expect(h.controller.directing()).toBe(true);
		await h.controller.finish("no-changes");
	});

	test("a detached start that is refused or throws ends in a notice, never in a silent nothing", async () => {
		const refused = session({ state: s => ({ ...s, approval: undefined }) });
		refused.controller.request(ask("task"));
		await refused.controller.onAgentEnd({}, refused.ctx);
		await until(() => refused.notices.length > 0);
		expect(refused.notices).toHaveLength(1);
		expect(refused.notices[0]?.level).toBe("warning");

		const failing = session({
			loadState: async () => {
				throw new Error("git is gone");
			},
		});
		failing.controller.request(ask("task"));
		await failing.controller.onAgentEnd({}, failing.ctx);
		await until(() => failing.notices.length > 0);
		expect(failing.notices[0]).toMatchObject({ level: "error" });
		expect(failing.notices[0]?.text).toContain("git is gone");
		// The failed start left nothing behind: the next request is accepted.
		expect(failing.controller.request(ask("again")).ok).toBe(true);
	});

	test("launch starts at once and reports a refusal the same way", async () => {
		const h = session();
		h.controller.launch(h.ctx, ask("direct"));
		await until(() => h.sent.length > 0);
		expect(h.controller.directing()).toBe(true);
		h.controller.launch(h.ctx, ask("second"));
		await until(() => h.notices.some(n => n.level === "warning"));
		expect(h.sent).toHaveLength(1);
		await h.controller.finish("no-changes");
	});

	test("a handoff that cannot be sent stops the run", async () => {
		const h = session({
			send: async () => {
				throw new Error("session closed");
			},
		});
		const runId = await h.start();
		await until(() => h.notices.some(n => n.level === "error"));
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "start-failed");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", turns: 0 });
		expect(h.controller.directing()).toBe(false);
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
		// The detached stop also appends the index line and prunes: let it finish before the directory goes.
		await until(async () => (await readRunIndex(h.sessionDir)).length === 1);
	});
});

describe("start with plan", () => {
	const plan: RunPlan = {
		lanes: [{ name: "probe", kind: "code", role: "implementer" }],
		workers: { implementer: 1 },
		submittedAt: "2026-11-20T09:00:00.000Z",
	};

	test("starts in the running turn without idle wait, compaction or a handoff, and binds the first plan", async () => {
		const h = session({ hold: { idle: false }, usage: usage(300_000, 75) });
		const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan, configHash(h.config));
		if (!result.ok) throw new Error(result.reason);
		expect(h.controller.directing()).toBe(true);
		expect(h.sent).toEqual([]);
		expect(h.events).toEqual([]);
		expect(h.ui.selects).toEqual([]);
		// Bound before admission returned: a spawn decided now reads this plan from the ledger.
		expect(activeLedgerRun(h.sessionDir)?.plan).toEqual(plan);
		expect(h.controller.active()?.plan).toEqual(plan);
		expect(await readRun(h.sessionDir, result.runId)).toMatchObject({ status: "running", turns: 0, plan });
		await h.controller.finish("no-changes");
	});

	test("the in-flight turn is round one; a reported continuation adds no phantom round or start", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents });
		const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan);
		if (!result.ok) throw new Error(result.reason);
		// omp reports the tool call's continuation before the turn is over: no round is counted or sent yet.
		await h.controller.onAgentEnd({ willContinue: true }, h.ctx);
		expect(h.controller.directing()).toBe(true);
		expect(h.sent).toEqual([]);
		expect(h.timers.pending()).toBe(0);
		h.controller.onAgentStart();
		completeLane(h, plan, agents);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(false);
		expect(await readRun(h.sessionDir, result.runId)).toMatchObject({ turns: 1, endReason: "no-changes" });
		expect(h.sent).toEqual([]);
		expect(h.timers.pending()).toBe(0);
		// A routine automatic end uses the live status line only, not a transcript summary.
		expect(h.summaries()).toBe(0);
	});

	test("a write-capable plan holds the target write claim before admission; a read-only plan stays a reader", async () => {
		const writer = session({ hold: { idle: false } });
		const started = await writer.controller.startWithPlan(writer.ctx, ask("probe"), plan);
		expect(started.ok).toBe(true);
		expect(writer.leases.held[0]?.mode).toBe("write");
		await writer.controller.finish("no-changes");

		const reader = session({ hold: { idle: false } });
		const readPlan: RunPlan = {
			lanes: [{ name: "look", kind: "explore", role: "explorer" }],
			workers: { explorer: 1 },
			submittedAt: "2026-11-20T09:00:00.000Z",
		};
		expect((await reader.controller.startWithPlan(reader.ctx, ask("look"), readPlan)).ok).toBe(true);
		expect(reader.leases.held[0]?.mode).toBe("read");
		await reader.controller.finish("no-changes");

		// A manual start begins safe; binding a write-capable plan upgrades before the plan becomes spawn authority.
		const manual = session();
		await manual.start();
		expect(manual.leases.held[0]?.mode).toBe("read");
		expect(await manual.controller.setPlan(manual.ctx, plan)).toEqual({ ok: true });
		expect(manual.leases.held[0]?.mode).toBe("write");
		expect((await manual.controller.ensureWrite(manual.ctx)).ok).toBe(true);
		await manual.controller.finish("no-changes");
	});

	test("a refused admission leaves no run, record or ledger entry", async () => {
		const h = session({ state: s => ({ ...s, approval: undefined }) });
		const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan);
		expect(result.ok).toBe(false);
		expect(h.controller.directing()).toBe(false);
		expect(h.controller.refusal()).toBeUndefined();
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
		expect(await runIds(h.sessionDir)).toEqual([]);
		expect(h.sent).toEqual([]);
	});

	test("automatic admission refuses active modes instead of changing them from a tool call", async () => {
		for (const modes of [fakeModes({ vibe: true }), fakeModes({ goal: "active" }), fakeModes({ loop: "active" })]) {
			const before = modes.snapshot();
			const h = session({ modes, answers: [options => options[0]] });
			const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan);
			expect(result.ok).toBe(false);
			expect(h.ui.selects).toEqual([]);
			expect(modes.requests).toEqual([]);
			expect(modes.state).toEqual(before);
			expect(h.sent).toEqual([]);
		}
	});

	test("a team change after the plan was checked refuses instead of using the new authority", async () => {
		const first = approvedState(root, SESSION_TEAM);
		const changed = approvedState(root, { ...SESSION_TEAM, contextCap: 300_000 });
		let loads = 0;
		const h = session({ loadState: async () => (++loads === 1 ? first : changed) });
		const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan);
		expect(result.ok).toBe(false);
		expect(loads).toBe(2);
		expect(h.leases.acquired).toHaveLength(1);
		expect(h.leases.released).toHaveLength(1);
		expect(h.controller.directing()).toBe(false);
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
		expect(await runIds(h.sessionDir)).toEqual([]);
	});

	test("a shutdown while admission waits leaves nothing for the next session", async () => {
		const waiting = Promise.withResolvers<void>();
		const state = approvedState(root, SESSION_TEAM);
		let loads = 0;
		const h = session({
			loadState: async () => {
				loads++;
				if (loads === 1) await waiting.promise;
				return state;
			},
		});
		const start = h.controller.startWithPlan(h.ctx, ask("probe"), plan);
		await until(() => loads === 1);
		await h.controller.finish("shutdown");
		waiting.resolve();
		expect(await start).toMatchObject({ ok: false });
		expect(h.controller.directing()).toBe(false);
		expect(h.controller.refusal()).toBeUndefined();
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
		expect(await runIds(h.sessionDir)).toEqual([]);
	});

	test("a routine automatic end stays out of the transcript, but a blocked spawn is reported", async () => {
		const quietAgents: AgentEntry[] = [];
		const quiet = session({ agents: quietAgents });
		await quiet.controller.startWithPlan(quiet.ctx, ask("probe"), plan);
		completeLane(quiet, plan, quietAgents);
		await quiet.controller.onAgentEnd({}, quiet.ctx);
		expect(quiet.summaries()).toBe(0);

		const loudAgents: AgentEntry[] = [];
		const loud = session({ agents: loudAgents });
		const started = await loud.controller.startWithPlan(loud.ctx, ask("probe"), plan);
		if (!started.ok) throw new Error(started.reason);
		completeLane(loud, plan, loudAgents);
		noteRunSpawn(started.runId, { ...spawn, outcome: "blocked", code: "budget", reason: "no budget" });
		await loud.controller.onAgentEnd({}, loud.ctx);
		expect(loud.summaries()).toBe(1);
	});
});

describe("lease, drain and required checks", () => {
	const plan: RunPlan = {
		lanes: [{ name: "probe", kind: "code", role: "implementer" }],
		workers: { implementer: 1 },
		submittedAt: "2026-11-20T09:00:00.000Z",
	};
	const checkTeam = (): StormConfig => ({
		...SESSION_TEAM,
		requiredChecks: [{ name: "unit", argv: ["/bin/sh", "-c", "echo x >> check-count"] }],
	});

	test("a start takes the lease after compaction and releases it only at finalization", async () => {
		const h = session({ usage: usage(200_000, 50) });
		const runId = await h.start();
		expect(h.leases.acquired).toEqual([runId]);
		expect(h.leases.released).toEqual([]);
		expect(h.events).toContain("compact");
		await h.controller.finish("no-changes");
		expect(h.leases.released).toEqual([runId]);
	});

	test("a failed lease acquisition refuses the start and leaves no run", async () => {
		const h = session({ lease: async () => ({ ok: false, reason: "다른 실행이 이 작업 트리를 쓰고 있습니다." }) });
		const result = await h.controller.start(h.ctx, ask("task"));
		expect(result).toMatchObject({ ok: false, reason: "다른 실행이 이 작업 트리를 쓰고 있습니다." });
		expect(h.controller.directing()).toBe(false);
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
		expect(await runIds(h.sessionDir)).toEqual([]);
	});

	test("a plan hash other than the approved team refuses before taking the lease", async () => {
		const h = session();
		const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan, configHash({ ...h.config, contextCap: 300_000 }));
		expect(result.ok).toBe(false);
		expect(h.leases.acquired).toEqual([]);
		expect(h.controller.directing()).toBe(false);
		expect(await runIds(h.sessionDir)).toEqual([]);
	});

	test("a no-change round with an open planned lane continues once, then ends no-progress", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents });
		const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan);
		if (!result.ok) throw new Error(result.reason);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(true);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 1);
		expect(h.sent[0]).toContain('round="2/4"');
		await h.turn();
		expect(await readRun(h.sessionDir, result.runId)).toMatchObject({ status: "stopped", endReason: "no-progress", turns: 2 });
	});

	test("stopping with a running owned worker keeps scope, lease and record until it settles", async () => {
		const agents = [agentEntry({ id: "Impl", role: "implementer", state: "running" })];
		const h = session({ agents });
		const runId = await h.start();
		expect(await h.controller.finish("no-changes")).toBeUndefined();
		expect(getLedgerRun(runId)?.closing).toBe(true);
		expect(h.leases.released).toEqual([]);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "running" });
		expect(h.timers.pending()).toBeGreaterThan(0);
		agents[0]!.state = "idle";
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.status === "ended");
		await until(() => h.leases.released.length === 1);
		expect(h.leases.released).toEqual([runId]);
		expect(getLedgerRun(runId)).toBeUndefined();
	});

	test("a running async job owned by the run also defers finalization", async () => {
		let running: AsyncJobSnapshot["running"] = [
			{ id: "job", type: "task", status: "running", label: "job", startTime: 0, ownerId: "Impl" },
		];
		const h = session({
			agents: [agentEntry({ id: "Impl", role: "implementer" })],
			asyncJobs: () => ({ running, recent: [], delivery: {} as AsyncJobSnapshot["delivery"] }),
		});
		const runId = await h.start();
		expect(await h.controller.finish("shutdown")).toBeUndefined();
		expect(h.leases.released).toEqual([]);
		running = [];
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.status === "stopped");
		await until(() => h.leases.released.length === 1);
		expect(h.leases.released).toEqual([runId]);
	});

	test("a verified run that had to drain rechecks its proof before keeping the label", async () => {
		const agents: AgentEntry[] = [writer(), verdict(T0 + 1, true, "d1:f0"), agentEntry({ id: "Slow", role: "explorer", state: "running" })];
		let tree = treeOf("d0", "f0");
		const h = session({ agents, tree: () => treeAt(tree) });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		// The gate passed, but an owned worker was still running: finalization waits instead of recording verified.
		expect(getLedgerRun(runId)?.closing).toBe(true);
		expect(h.leases.released).toEqual([]);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "running" });
		tree = treeOf("d2", "f0");
		agents[2]!.state = "idle";
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.status !== "running");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ endReason: "no-progress" });
		await until(() => h.leases.released.length === 1);
		expect(h.leases.released).toEqual([runId]);
	});

	test("a lane round is sent even when the team has no reviewer role", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ config: { ...SESSION_TEAM, disabledRoles: ["reviewer"] }, agents });
		const result = await h.controller.startWithPlan(h.ctx, ask("probe"), plan);
		if (!result.ok) throw new Error(result.reason);
		await h.controller.onAgentEnd({}, h.ctx);
		h.timers.fire();
		await until(() => h.sent.length === 1);
		expect(h.sent[0]).toContain('round="2/4"');
		await h.controller.finish("shutdown");
	});

	test("a last-round review with a pending check verifies from the timer without another model round", async () => {
		const agents: AgentEntry[] = [writer(), verdict(T0 + 1, true, "d1:f0")];
		let tree = treeOf("d0", "f0");
		const h = session({ config: checkTeam(), agents, tree: () => treeAt(tree) });
		const runId = await h.start({ task: "probe", rounds: 1 });
		tree = treeOf("d1", "f0");
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.pending()).toBe(1);
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "verified");
		expect(h.sent).toHaveLength(1);
		expect((await readRun(h.sessionDir, runId))?.checks).toEqual([{ name: "unit", status: "passed", exitCode: 0, tree: "d1:f0" }]);
	});

	test("a failed verification-only check ends the last round honestly and does not retry", async () => {
		const agents: AgentEntry[] = [writer(), verdict(T0 + 1, true, "d1:f0")];
		let tree = treeOf("d0", "f0");
		const config: StormConfig = { ...SESSION_TEAM, requiredChecks: [{ name: "unit", argv: ["/bin/sh", "-c", "echo x >> check-count; exit 1"] }] };
		const h = session({ config, agents, tree: () => treeAt(tree) });
		const runId = await h.start({ task: "probe", rounds: 1 });
		tree = treeOf("d1", "f0");
		await h.turn();
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.status !== "running");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ endReason: "round-limit", turns: 1 });
		expect(h.sent).toHaveLength(1);
		expect(readFileSync(path.join(root, "check-count"), "utf8")).toBe("x\n");
	});

	test("required checks run once for a changed tree and their compact evidence is recorded", async () => {
		const agents: AgentEntry[] = [writer()];
		let tree = treeOf("d0", "f0");
		const h = session({ config: checkTeam(), agents, tree: () => treeAt(tree) });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		agents.push(verdict(T0 + 1, true, "d1:f0"));
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "verified");
		expect(readFileSync(path.join(root, "check-count"), "utf8")).toBe("x\n");
		expect(((await readRun(h.sessionDir, runId)) as RunRecord).checks).toEqual([
			{ name: "unit", status: "passed", exitCode: 0, tree: "d1:f0" },
		]);
	});

	test("required checks do not run for a round that changed nothing", async () => {
		const h = session({ config: checkTeam() });
		const runId = await h.start();
		await h.turn();
		expect(existsSync(path.join(root, "check-count"))).toBe(false);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ endReason: "no-changes" });
	});

	test("a withdrawn approval withholds the pass without executing checks", async () => {
		let state = approvedState(root, checkTeam());
		const agents: AgentEntry[] = [writer()];
		let tree = treeOf("d0", "f0");
		const h = session({ config: checkTeam(), agents, tree: () => treeAt(tree), loadState: async () => state });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		state = { ...state, approval: undefined };
		agents.push(verdict(T0 + 1, true, "d1:f0"));
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(existsSync(path.join(root, "check-count"))).toBe(false);
		expect((await readRun(h.sessionDir, runId))?.endReason).toBeUndefined();
		await h.controller.finish("shutdown");
	});
});

describe("run end", () => {
	test("the run ends when the session settles after its handoff turn began, not before and not while work continues", async () => {
		const h = session();
		const runId = await h.start();
		// The settle that started the run: the handoff turn has not begun.
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(true);
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({ willContinue: true }, h.ctx);
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		expect(h.controller.directing()).toBe(true);
		// omp resumes a paused run with a new turn; its end is the round.
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(false);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "ended", turns: 1, endReason: "no-changes" });
		expect(await readRunIndex(h.sessionDir)).toMatchObject([{ runId, turns: 1, endReason: "no-changes" }]);
	});

	test("a run ends once: one summary, one index line, the ledger closed, and later events change nothing", async () => {
		const h = session();
		const runId = await h.start();
		noteRunSpawn(runId, spawn);
		await h.turn();
		expect(h.summaries()).toBe(1);
		// A short clean end leaves one factual line; the ledger detail stays in status.
		const settled = (await readRun(h.sessionDir, runId)) as RunRecord;
		expect(closeoutBrief(settled).tier).toBe("line");
		expect(h.ui.records[0]?.title).toBe(CLOSEOUT_TITLE);
		expect(h.ui.records[0]?.markdown).toBe(renderCloseout(closeoutBrief(settled), false).markdown);
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
		const ended = (await readRun(h.sessionDir, runId))?.endedAt;

		await h.turn();
		await h.controller.onAgentEnd({}, h.ctx);
		expect(await h.controller.finish("shutdown")).toBeUndefined();
		expect(h.summaries()).toBe(1);
		expect(await readRunIndex(h.sessionDir)).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "ended", endReason: "no-changes", endedAt: ended as string });
		// The session is free again: the next request is taken.
		expect(h.controller.request(ask("next")).ok).toBe(true);
	});

	test("the read index lives as long as the run: a subagent's read counts during it and is forgotten after", async () => {
		const h = session();
		const runId = await h.start();
		const indexed = () => {
			noteChildRead(runId, "Impl", "notes.md", root);
			return directorRead({ runId, path: "notes.md", cwd: root })?.indexed;
		};
		expect(indexed()).toBe(true);
		await h.controller.finish("no-changes");
		expect(indexed()).toBe(false);
	});

	test("ending a run keeps the project's newest 50 run records", async () => {
		const h = session();
		for (let n = 0; n < 55; n++) await writeRun(h.sessionDir, runRecord({ runId: `run-20261101-0000${String(n).padStart(2, "0")}-old0` }));
		const runId = await h.start();
		await h.turn();
		const ids = await runIds(h.sessionDir);
		expect(ids).toHaveLength(50);
		expect(ids).toContain(runId);
		expect(ids).not.toContain("run-20261101-000000-old0");
	});

	test("a session shutdown ends the run as stopped, without a summary and without cleaning anything", async () => {
		let loads = 0;
		let state: ProjectState;
		const h = session({
			loadState: async () => {
				loads++;
				return state;
			},
		});
		state = approvedState(root, SESSION_TEAM, { agentDir: h.agentDir, sessionId: h.sessionId });
		const runId = await h.start();
		expect(loads).toBe(1);
		await h.controller.finish("shutdown");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "shutdown" });
		expect(h.summaries()).toBe(0);
		// The janitor needs the state in force; a shutdown does not wait for it.
		expect(loads).toBe(1);
	});

	test("a run past its budget ends as budget-exceeded, whatever ended it", async () => {
		const h = session({ config: { ...SESSION_TEAM, budget: { perRunUsd: 1, onExceed: "block-spawns" } } });
		const runId = await h.start();
		expect((await readRun(h.sessionDir, runId))?.budget).toEqual({ perRunUsd: 1, onExceed: "block-spawns" });
		recordCost(runId, "a/i", 0.5);
		expect(activeLedgerRun(h.sessionDir)?.exceeded).toBe(false);
		recordCost(runId, "a/i", 0.5);
		expect(activeLedgerRun(h.sessionDir)?.exceeded).toBe(true);
		expect(await h.controller.finish("no-changes")).toMatchObject({ status: "budget-exceeded", endReason: "no-changes", costUsd: 1 });
	});

	test("a team with doc consistency off records no doc findings", async () => {
		const review = { reviews: 1, passed: 0, failed: 1, findings: [0, 1, 0, 0] as [number, number, number, number], docFindings: 2 };
		const on = session({ agents: [agent({ review })] });
		await on.start();
		expect((await on.controller.finish("no-changes"))?.agents?.[0]?.review?.docFindings).toBe(2);
		const off = session({ config: { ...SESSION_TEAM, docs: false }, agents: [agent({ review })] });
		await off.start();
		const record = await off.controller.finish("no-changes");
		expect(record?.agents?.[0]?.review).toEqual({ reviews: 1, passed: 0, failed: 1, findings: [0, 1, 0, 0] });
	});
});

describe("round loop", () => {
	test("no records of changes: one round ends no-changes, nothing sent besides the handoff", async () => {
		const h = session();
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "ended", endReason: "no-changes", turns: 1 });
	});

	test("a writer with no verdict gets round 2; a correct verdict after the change then verifies it", async () => {
		const agents = [writer()];
		const h = session({ agents, tree: () => treeAt() });
		const runId = await h.start();
		await h.turn();
		expect(h.controller.directing()).toBe(true);
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="2/4">`);

		agents.push(verdict(T0 + 1, true, F0));
		await h.turn();
		expect(h.sent).toHaveLength(2);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("an incorrect verdict and a round that changes and reviews nothing ends no-progress", async () => {
		const h = session({ agents: [writer(), verdict(T0 + 1, false)] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toContain('round="2/4"');
		await h.turn();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "no-progress", turns: 2 });
	});

	test("config extra rounds: progress every round but no verdict ends on the round limit after two rounds", async () => {
		const agents = [writer()];
		const h = session({ config: { ...SESSION_TEAM, rounds: 1 }, agents });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toContain('round="2/2"');
		agents.push(writer({ id: "Impl2", lastChangeAt: T0 + 2 }));
		await h.turn();
		expect(h.sent).toHaveLength(2);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "round-limit", turns: 2 });
	});

	test("the request's own rounds limit of 1 ends the unverified first round at once", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start({ task: "t", rounds: 1 });
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "round-limit", turns: 1 });
	});

	test("the request's minutes limit is checked when a round ends", async () => {
		let clock = T0;
		const h = session({ now: () => clock, agents: [writer()] });
		const runId = await h.start({ task: "t", minutes: 10 });
		clock += 11 * 60_000;
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "time-limit", turns: 1 });
	});

	test("an aborted turn with unverified changes ends interrupted and sends nothing", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start();
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "interrupted", turns: 1 });
	});

	test("a held session waits: the delay look arms HOLD_MS until the draft is gone, and a turn clears the wait", async () => {
		const agents = [writer()];
		const h = session({ agents });
		await h.start();
		h.hold.editor = "draft";
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		// The first look is held: it arms the hold wait instead of sending.
		h.timers.fire();
		await until(() => h.timers.delays().length === 1);
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([HOLD_MS]);
		// Still held: firing only arms the next look.
		h.timers.fire();
		await until(() => h.timers.delays().length === 1);
		expect(h.timers.delays()).toEqual([HOLD_MS]);
		expect(h.sent).toHaveLength(1);
		// The draft is gone: the same timer sends the round.
		h.hold.editor = "";
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.timers.pending()).toBe(0);
		expect(h.sent[1]?.split("\n")[0]).toContain('round="2/4"');

		// The next round's delay is pending; the turn that starts clears it.
		agents.push(writer({ id: "Impl2", lastChangeAt: T0 + 3 }));
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.controller.onAgentStart();
		expect(h.timers.pending()).toBe(0);
		await h.controller.finish("shutdown");
	});

	test("an unverified round waits out the delay: nothing is sent until the timer fires", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="2/4">`);
		await h.controller.finish("shutdown");
	});

	test("a verdict that arrives before the timer fires is used: the run verifies, nothing is sent", async () => {
		const agents = [writer()];
		const h = session({ agents, tree: () => treeAt() });
		const runId = await h.start();
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		agents.push(verdict(T0 + 1, true, F0));
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "verified");
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 1 });
	});

	test("a turn that starts before the timer fires clears it, and its end decides again", async () => {
		const agents = [writer()];
		const h = session({ agents, tree: () => treeAt() });
		const runId = await h.start();
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.controller.onAgentStart();
		expect(h.timers.pending()).toBe(0);
		// The user's own turn can verify the work, but it does not spend another scheduled verification round.
		agents.push(verdict(T0 + 1, true, F0));
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 1 });
	});

	test("a round message that cannot be sent ends the run no-progress with a warning", async () => {
		const h = session({
			agents: [writer()],
			send: async text => {
				if (text.includes('round="2/4"')) throw new Error("session closed");
			},
		});
		const runId = await h.start();
		await h.turn();
		// The agent_end handler has returned; the rejection arrives from the send the timer started.
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "no-progress");
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "no-progress", turns: 1 });
	});

	test("a round send that rejects after the run ended leaves the record alone", async () => {
		const send = Promise.withResolvers<void>();
		const h = session({
			agents: [writer()],
			send: async text => {
				if (text.includes('round="2/4"')) await send.promise;
			},
		});
		const runId = await h.start();
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		await h.controller.finish("shutdown");
		const ended = await readRun(h.sessionDir, runId);
		const summaries = h.summaries();
		const warnings = h.notices.filter(n => n.level === "warning").length;

		send.reject(new Error("session closed"));
		await until(() => h.notices.filter(n => n.level === "warning").length === warnings + 1);
		expect(h.summaries()).toBe(summaries);
		expect(await readRun(h.sessionDir, runId)).toEqual(ended);
	});

	test("a send that never settles does not hold the round or the next turn", async () => {
		const pending = Promise.withResolvers<void>();
		const agents = [writer()];
		const h = session({
			agents,
			tree: () => treeAt(),
			send: async text => {
				if (text.includes('round="2/4"')) await pending.promise;
			},
		});
		const runId = await h.start();
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		// The next turn starts and settles while that send is still pending.
		agents.push(verdict(T0 + 1, true, F0));
		await h.turn();
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "verified");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
		pending.resolve();
	});

	test("a team whose reviewer role is disabled ends a writer's changes no-reviewer", async () => {
		const h = session({ config: { ...SESSION_TEAM, disabledRoles: ["reviewer"] }, agents: [writer()] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "ended", endReason: "no-reviewer", turns: 1 });
	});

	test("a run past a block-spawns budget with unverified changes ends budget and sends nothing", async () => {
		const h = session({
			config: { ...SESSION_TEAM, budget: { perRunUsd: 1, onExceed: "block-spawns" } },
			agents: [writer()],
		});
		const runId = await h.start();
		recordCost(runId, "a/i", 2);
		expect(activeLedgerRun(h.sessionDir)?.exceeded).toBe(true);
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget", turns: 1 });
	});

	test("a quick agent's changes alone end unreviewed", async () => {
		const h = session({ agents: [agentEntry({ role: "quick", changes: 2, lastChangeAt: T0 })] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "ended", endReason: "unreviewed", turns: 1 });
	});

	test("a streaming session, queued messages and plan mode each hold the round", async () => {
		for (const hold of [{ idle: false }, { pending: true }] as const) {
			const h = session({ agents: [writer()], hold });
			await h.start();
			await h.turn();
			h.timers.fire();
			await until(() => h.timers.delays().length === 1);
			expect(h.sent).toHaveLength(1);
			expect(h.timers.delays()).toEqual([HOLD_MS]);
			await h.controller.finish("shutdown");
		}
		const modes = fakeModes();
		modes.state.plan.status = "active";
		const planning = session({ agents: [writer()], modes });
		await planning.start();
		await planning.turn();
		planning.timers.fire();
		await until(() => planning.timers.delays().length === 1);
		expect(planning.sent).toHaveLength(1);
		expect(planning.timers.delays()).toEqual([HOLD_MS]);
		await planning.controller.finish("shutdown");
	});

	test("a pending round wait dies with the run: shutdown and a budget stop between turns send nothing", async () => {
		for (const end of ["shutdown", "budget"] as const) {
			const h =
				end === "budget"
					? session({ config: { ...SESSION_TEAM, budget: { perRunUsd: 1, onExceed: "stop" } }, agents: [writer()] })
					: session({ agents: [writer()] });
			const runId = await h.start();
			await h.turn();
			expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
			if (end === "budget") recordCost(runId, "a/i", 2);
			else await h.controller.finish("shutdown");
			expect(h.controller.directing()).toBe(false);
			expect(h.timers.pending()).toBe(0);
			await until(async () => (await readRun(h.sessionDir, runId))?.status !== "running");
			expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: end === "budget" ? "budget-exceeded" : "stopped", endReason: end });
			h.timers.fire();
			expect(h.sent).toHaveLength(1);
		}
	});
});

describe("changes seen through the work tree", () => {
	const BASE = "base-0";
	const implementer = agentEntry({ id: "Impl", role: "implementer", changes: 0 });
	const reading = (state: TreeState, base = BASE): TreeReading => ({ base, state });
	/** Lets every promise continuation queued so far run: the macrotask after them cannot overtake any. */
	const drained = async (): Promise<void> => {
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	};

	test("a tree change without an edit tool gets a round, and a verdict against the tree now verifies the run", async () => {
		let tree = treeOf("d0", "f0");
		const agents: AgentEntry[] = [implementer];
		const h = session({ agents: () => agents, tree: () => reading(tree) });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="2/4">`);

		agents.push(verdict(T0 + 1, true, "d1:f0"));
		await h.turn();
		expect(h.sent).toHaveLength(2);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("the run reads its main tree against the start commit at every decision", async () => {
		const calls: Array<{ root: string; base?: string }> = [];
		let tree = treeOf("d0", "f0");
		const h = session({
			agents: [implementer],
			tree: (readRoot, base) => {
				calls.push({ root: readRoot, ...(base !== undefined ? { base } : {}) });
				return reading(tree);
			},
		});
		await h.start();
		expect(calls).toEqual([{ root }]);
		expect(activeLedgerRun(h.sessionDir)?.base).toBe(BASE);
		tree = treeOf("d1", "f0");
		await h.turn();
		expect(calls.at(-1)).toEqual({ root, base: BASE });
		await h.controller.finish("shutdown");
	});

	test("a tree that changes after every verdict gets one re-review, then stops no-progress", async () => {
		let now = T0;
		let tree = treeOf("d0", "f0");
		const agents: AgentEntry[] = [implementer];
		const review = (at: number, treeHash: string): StructuredReviewAgent => ({
			...agentEntry({
				id: `Rev${at}`,
				name: "storm-reviewer",
				role: "reviewer",
				review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] },
				lastVerdict: { at, correct: true, tree: treeHash },
			}),
			reviewLog: [{ at, correct: true, findings: [], tree: treeHash }],
		});
		const h = session({ agents: () => agents, tree: () => reading(tree), now: () => now });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);

		// Round 2: a verdict against d1, then the tree moves again before the turn ends.
		agents.push(review(T0 + 10, "d1:f0"));
		tree = treeOf("d2", "f0");
		now = T0 + 100;
		await h.turn();
		expect(h.sent).toHaveLength(2);
		h.timers.fire();
		await until(() => h.sent.length === 3);
		expect(h.sent[2]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="3/4">`);

		// After the one asked-for tree review, another moved tree is exhausted proof, not a pass.
		agents.push(review(T0 + 200, "d2:f0"));
		tree = treeOf("d3", "f0");
		await h.turn();
		expect(h.sent).toHaveLength(3);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "no-progress", turns: 3 });
	});

	test("a team change after the re-review's verdict is not excused and gets another round", async () => {
		let now = T0;
		let tree = treeOf("d0", "f0");
		const impl = agentEntry({ id: "Impl", role: "implementer", changes: 0 });
		const agents: AgentEntry[] = [impl];
		const review = (at: number, pair: string): StructuredReviewAgent => ({
			...agentEntry({
				id: `Rev${at}`,
				name: "storm-reviewer",
				role: "reviewer",
				review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] },
				lastVerdict: { at, correct: true, tree: pair },
			}),
			reviewLog: [{ at, correct: true, findings: [], tree: pair }],
		});
		const h = session({ agents: () => agents, tree: () => reading(tree), now: () => now });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);

		// Round 2: the tree moves with no other agent active, so this is the one tree-only re-review.
		agents.push(review(T0 + 10, "d1:f0"));
		tree = treeOf("d2", "f0");
		now = T0 + 100;
		await h.turn();
		expect(h.sent).toHaveLength(2);
		h.timers.fire();
		await until(() => h.sent.length === 3);

		// Round 3: a fresh verdict, then the team works and the tree moves: not an outside change, so no excuse.
		agents.push(review(T0 + 200, "d2:f0"));
		impl.lastActivityAt = T0 + 250;
		tree = treeOf("d3", "f0");
		await h.turn();
		expect(h.sent).toHaveLength(3);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 4);
		expect(h.sent[3]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="4/4">`);
		await h.controller.finish("shutdown");
	});

	test("a tree that changes while no agent does anything ends no-progress", async () => {
		let tree = treeOf("d0", "f0");
		const h = session({ tree: () => reading(tree) });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		tree = treeOf("d2", "f0");
		await h.turn();
		expect(h.sent).toHaveLength(2);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "no-progress", turns: 2 });
	});

	test("a tree read that fails after a known start counts as a change", async () => {
		let calls = 0;
		const h = session({
			agents: [implementer],
			tree: () => (++calls === 1 ? reading(treeOf("d0", "f0")) : undefined),
		});
		await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		expect(h.controller.active()).toMatchObject({ status: "running", turns: 1 });
		await h.controller.finish("shutdown");
	});

	test("a tree that changes after the passing verdict makes the next gate stale", async () => {
		let tree = treeOf("d0", "f0");
		const agents: AgentEntry[] = [implementer];
		const h = session({ agents: () => agents, tree: () => reading(tree) });
		const runId = await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);

		// Round 2: a passing verdict against d1, then the tree moves again before the turn ends.
		agents.push(verdict(T0 + 1, true, "d1:f0"));
		tree = treeOf("d2", "f0");
		await h.turn();
		expect(h.sent).toHaveLength(2);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 3);
		expect(h.sent[2]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="3/4">`);

		agents.push(verdict(T0 + 2, true, "d2:f0", { id: "Rev2" }));
		await h.turn();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 3 });
	});

	test("a held look reads no tree until the hold clears", async () => {
		let calls = 0;
		let tree = treeOf("d0", "f0");
		const h = session({
			agents: [implementer],
			tree: () => {
				calls++;
				return reading(tree);
			},
		});
		await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.hold.editor = "draft";
		h.timers.fire();
		expect(h.timers.delays()).toEqual([HOLD_MS]);
		expect(calls).toBe(2);
		h.timers.fire();
		expect(h.timers.delays()).toEqual([HOLD_MS]);
		expect(calls).toBe(2);
		// The hold has cleared: the look decides, reading the tree once.
		h.hold.editor = "";
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(calls).toBe(3);
		await h.controller.finish("shutdown");
	});

	test("without a tree dep a positive verdict cannot bind, so the run stays unverified", async () => {
		const agents: AgentEntry[] = [writer()];
		const h = session({ agents });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		agents.push(verdict(T0 + 1, true));
		await h.turn();
		expect(h.controller.active()).toMatchObject({ status: "running", turns: 2 });
		expect((await readRun(h.sessionDir, runId))?.endReason).toBeUndefined();
		await h.controller.finish("shutdown");
	});

	test("a decision that resolves after a turn started is dropped", async () => {
		let calls = 0;
		let resolveNow: ((reading: TreeReading | undefined) => void) | undefined;
		const h = session({
			agents: [implementer],
			tree: () => {
				calls++;
				if (calls === 1) return reading(treeOf("d0", "f0"));
				const deferred = Promise.withResolvers<TreeReading | undefined>();
				resolveNow = deferred.resolve;
				return deferred.promise;
			},
		});
		await h.start();
		h.controller.onAgentStart();
		const settled = h.controller.onAgentEnd({}, h.ctx);
		await until(() => resolveNow !== undefined);
		// A new turn starts while the decision waits for the tree.
		h.controller.onAgentStart();
		resolveNow?.(reading(treeOf("d1", "f0")));
		await settled;
		expect(h.sent).toHaveLength(1);
		expect(h.timers.pending()).toBe(0);
		expect(h.controller.directing()).toBe(true);
		expect(h.controller.active()).toMatchObject({ status: "running", turns: 1 });
		await h.controller.finish("shutdown");
	});

	test("a decision that resolves after the run ended is dropped", async () => {
		let calls = 0;
		let resolveNow: ((reading: TreeReading | undefined) => void) | undefined;
		const h = session({
			agents: [implementer],
			tree: () => {
				calls++;
				if (calls === 1) return reading(treeOf("d0", "f0"));
				const deferred = Promise.withResolvers<TreeReading | undefined>();
				resolveNow = deferred.resolve;
				return deferred.promise;
			},
		});
		await h.start();
		h.controller.onAgentStart();
		const settled = h.controller.onAgentEnd({}, h.ctx);
		await until(() => resolveNow !== undefined);
		// The run ends while the decision waits for the tree.
		await h.controller.finish("shutdown");
		resolveNow?.(reading(treeOf("d1", "f0")));
		await settled;
		expect(h.sent).toHaveLength(1);
		expect(h.timers.pending()).toBe(0);
		expect(await lastRun(h.sessionDir)).toMatchObject({ endReason: "shutdown" });
	});

	test("a look that resolves after a turn started is dropped", async () => {
		let calls = 0;
		let resolveNow: ((reading: TreeReading | undefined) => void) | undefined;
		let tree = treeOf("d0", "f0");
		const h = session({
			agents: [implementer],
			tree: () => {
				calls++;
				// The start and the round's decision are read at once; the look after the delay is held open.
				if (calls <= 2) return reading(tree);
				const deferred = Promise.withResolvers<TreeReading | undefined>();
				resolveNow = deferred.resolve;
				return deferred.promise;
			},
		});
		await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => resolveNow !== undefined);
		// A turn starts while the look waits for the tree.
		h.controller.onAgentStart();
		resolveNow?.(reading(treeOf("d2", "f0")));
		await drained();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.pending()).toBe(0);
		expect(h.controller.directing()).toBe(true);
		await h.controller.finish("shutdown");
	});

	test("a look that resolves after the run ended is dropped", async () => {
		let calls = 0;
		let resolveNow: ((reading: TreeReading | undefined) => void) | undefined;
		let tree = treeOf("d0", "f0");
		const h = session({
			agents: [implementer],
			tree: () => {
				calls++;
				if (calls <= 2) return reading(tree);
				const deferred = Promise.withResolvers<TreeReading | undefined>();
				resolveNow = deferred.resolve;
				return deferred.promise;
			},
		});
		await h.start();
		tree = treeOf("d1", "f0");
		await h.turn();
		h.timers.fire();
		await until(() => resolveNow !== undefined);
		await h.controller.finish("shutdown");
		resolveNow?.(reading(treeOf("d2", "f0")));
		await drained();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.pending()).toBe(0);
	});
});

describe("interrupted waits", () => {
	test("Esc during an async wait ends the run interrupted and sends nothing", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start();
		h.controller.onAgentStart();
		// omp pauses the run on the subagents; only their work can resume it.
		await h.controller.onAgentEnd({ willContinue: true, awaitingAsyncWork: true }, h.ctx);
		expect(h.controller.directing()).toBe(true);
		// Esc ends the paused run: no new turn and no assistant message marked aborted names it.
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(h.timers.pending()).toBe(0);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "interrupted", turns: 1 });
	});

	test("an async wait that resumes with a new turn decides as usual", async () => {
		const h = session({ agents: [writer()] });
		await h.start();
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		expect(h.controller.directing()).toBe(true);
	});

	test("a prompt omp dropped because the user interrupted its setup ends interrupted, not no-progress", async () => {
		const h = session({
			agents: [writer()],
			send: async text => {
				if (!text.includes('round="2/4"')) return;
				const error = new Error("Prompt dropped before provider dispatch.");
				error.name = "PromptDroppedError";
				throw error;
			},
		});
		const runId = await h.start();
		await h.turn();
		h.timers.fire();
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "interrupted");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "stopped", endReason: "interrupted", turns: 1 });
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(0);
	});
});

describe("run failures behind a timer", () => {
	/** Leaves the run records unwritable: a `finish` from a timer or a rejected send then throws. */
	const breakRecords = async (session: FakeSession): Promise<void> => {
		await rm(runsDir(session.sessionDir), { recursive: true, force: true });
		await writeFile(runsDir(session.sessionDir), "not a directory");
	};

	test("a look that cannot end the run reports the failure instead of leaving a rejected promise", async () => {
		const agents = [writer()];
		const h = session({ agents, tree: () => treeAt() });
		const runId = await h.start();
		await h.turn();
		agents.push(verdict(T0 + 1, true, F0));
		await breakRecords(h);
		h.timers.fire();
		await until(() => h.notices.some(n => n.level === "error"));
		await until(() => h.leases.released.includes(runId));
		expect(h.controller.directing()).toBe(false);
	});

	test("a rejected round send whose stop fails reports both the warning and the error", async () => {
		const h = session({
			agents: [writer()],
			send: async text => {
				if (text.includes('round="2/4"')) throw new Error("session closed");
			},
		});
		await h.start();
		await h.turn();
		await breakRecords(h);
		h.timers.fire();
		await until(() => h.notices.some(n => n.level === "error"));
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(1);
	});
});

describe("budget", () => {
	const budget = (onExceed: "stop" | "block-spawns"): StormConfig => ({ ...SESSION_TEAM, budget: { perRunUsd: 2, warnAtUsd: 1, onExceed } });

	test("stop: the warning line only warns; the limit aborts the turn once and the run ends with it as budget-exceeded", async () => {
		const h = session({ config: budget("stop") });
		const runId = await h.start();
		h.controller.onAgentStart();
		recordCost(runId, "a/i", 1);
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(1);
		expect(h.aborts()).toBe(0);
		recordCost(runId, "a/i", 1);
		expect(h.aborts()).toBe(1);
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(2);
		// More spend while the aborted turn winds down does not abort again.
		recordCost(runId, "a/i", 1);
		expect(h.aborts()).toBe(1);
		expect(h.controller.directing()).toBe(true);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(false);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget", costUsd: 3 });
		expect(await readRunIndex(h.sessionDir)).toMatchObject([{ runId, status: "budget-exceeded" }]);
	});

	test("block-spawns: nothing is aborted and the run goes on to its own end", async () => {
		const h = session({ config: budget("block-spawns") });
		const runId = await h.start();
		h.controller.onAgentStart();
		recordCost(runId, "a/i", 5);
		expect(h.aborts()).toBe(0);
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(2);
		expect(h.controller.directing()).toBe(true);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "budget-exceeded", endReason: "no-changes" });
	});

	test("a stop during a turn with unverified changes ends budget, not the aborted turn's interruption", async () => {
		const h = session({ config: budget("stop"), agents: [writer()] });
		const runId = await h.start();
		h.controller.onAgentStart();
		recordCost(runId, "a/i", 2);
		expect(h.aborts()).toBe(1);
		// omp marks the aborted turn's last assistant message; without the end decided earlier it would read interrupted.
		await h.controller.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget", turns: 1 });
	});

	test("a stop between turns ends the run at once, before any next turn", async () => {
		const h = session({ config: budget("stop"), agents: [writer()] });
		const runId = await h.start();
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		recordCost(runId, "a/i", 2);
		expect(h.aborts()).toBe(0);
		expect(h.controller.directing()).toBe(false);
		expect(h.timers.pending()).toBe(0);
		await until(async () => (await readRun(h.sessionDir, runId))?.status === "budget-exceeded");
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ endReason: "budget", turns: 1 });
	});

	test("without a budget no spend warns or aborts", async () => {
		const h = session();
		const runId = await h.start();
		recordCost(runId, "a/i", 1_000);
		expect(h.aborts()).toBe(0);
		expect(h.notices.some(n => n.level !== "info")).toBe(false);
		expect((await h.controller.finish("verified"))?.status).toBe("done");
	});
});

describe("run-end cleanup", () => {
	const NOW = Date.parse("2026-11-20T10:00:00.000Z");
	const cleaning: StormConfig = { ...SESSION_TEAM, cleanup: true };
	let agentDir: string;
	let artifacts: string;

	beforeEach(async () => {
		agentDir = path.join(path.dirname(root), `agent-${path.basename(root)}`);
		artifacts = path.join(agentDir, "sessions", "proj", "sess");
		await mkdir(artifacts, { recursive: true });
		await writeFile(`${artifacts}.jsonl`, "");
	});

	const recordOf = (id: string) => path.join(artifacts, `${id}.jsonl`);

	/** Four earlier Storm runs on the trusted list, the oldest with one subagent whose omp record is on disk. */
	async function seedOlderRuns(sessionDir: string, owner: string, id = "Old"): Promise<void> {
		await writeFile(recordOf(id), "transcript");
		await writeFile(path.join(artifacts, `${id}.md`), "output");
		for (let n = 1; n <= 4; n++) {
			await recordTrustedRun(sessionDir, { runId: `run-old-${n}`, artifactsDir: artifacts, process: owner, agents: n === 1 ? [id] : [], endedAt: "t" });
		}
	}

	test("a finished run joins its own session's trusted list; another session's list stays separate", async () => {
		const h = session({ agents: [agent({ id: "A" }), agent({ id: "B" })], artifactsDir: artifacts, agentDir, now: () => NOW });
		const runId = await h.start();
		expect((await readRun(h.sessionDir, runId))?.artifactsDir).toBe(artifacts);
		expect(await readTrustedRuns(h.sessionDir)).toEqual([]);
		await h.turn();
		expect(await readTrustedRuns(h.sessionDir)).toEqual([
			{ runId, artifactsDir: artifacts, process: processKey(), agents: ["A", "B"], endedAt: new Date(NOW).toISOString() },
		]);

		// Reopening the same native session records into the same store; a shutdown records the run too.
		const closing = session({ sessionId: h.sessionId, artifactsDir: artifacts, agentDir });
		const closed = await closing.start();
		await closing.controller.finish("shutdown");
		expect((await readTrustedRuns(h.sessionDir)).map(run => run.runId)).toEqual([runId, closed]);

		// A different native session without an artifacts dir records nothing, and never touches the first list.
		const other = session({ agentDir });
		const unlisted = await other.start();
		expect((await readRun(other.sessionDir, unlisted))?.artifactsDir).toBeUndefined();
		await other.turn();
		expect(await readTrustedRuns(other.sessionDir)).toEqual([]);
		expect((await readTrustedRuns(h.sessionDir)).map(run => run.runId)).toEqual([runId, closed]);
	});

	test("with consent at start and at the end, an older run's parked agent loses its omp record and keeps its output", async () => {
		const h = session({ config: cleaning, artifactsDir: artifacts, agentDir, now: () => NOW });
		await seedOlderRuns(h.sessionDir, DEAD_PROCESS);
		const runId = await h.start();
		await h.turn();
		expect(existsSync(recordOf("Old"))).toBe(false);
		expect(existsSync(path.join(artifacts, "Old.md"))).toBe(true);
		const record = await readRun(h.sessionDir, runId);
		expect(record?.cleanup).toMatchObject({ agents: 1, files: 1, bytes: "transcript".length });
		expect((await readRunIndex(h.sessionDir))[0]).toMatchObject({ runId });
		expect((await readTrustedRuns(h.sessionDir))[0]?.cleaned).toEqual(["Old"]);
	});

	test("the approval in force when the run ends decides: consent withdrawn, or the team unapproved, mid-run deletes nothing", async () => {
		for (const variant of ["team", "cleanup-off", "unapproved", "invalid"] as const) {
			let current: ProjectState;
			const h = session({ config: cleaning, loadState: async () => current, artifactsDir: artifacts, agentDir });
			const owner = { agentDir: h.agentDir, sessionId: h.sessionId };
			const atStart = approvedState(root, cleaning, owner);
			current = atStart;
			const atEnd = (state: ProjectState): ProjectState => {
				if (variant === "team") return approvedState(root, SESSION_TEAM, owner);
				if (variant === "cleanup-off") return approvedState(root, { ...cleaning, cleanup: false }, owner);
				if (variant === "unapproved") return { ...state, approval: undefined };
				return { ...state, config: { status: "invalid", path: "x", errors: ["bad"] } };
			};
			await seedOlderRuns(atStart.sessionDir, DEAD_PROCESS);
			const runId = await h.start();
			current = atEnd(atStart);
			await h.turn();
			expect(existsSync(recordOf("Old"))).toBe(true);
			const record = await readRun(h.sessionDir, runId);
			expect(record?.status).toBe("ended");
			expect(record?.cleanup?.agents ?? 0).toBe(0);
			await rm(atStart.sessionDir, { recursive: true, force: true });
		}
	});

	test("consent given only mid-run deletes nothing either: the run started without it", async () => {
		let current: ProjectState;
		const h = session({ loadState: async () => current, artifactsDir: artifacts, agentDir });
		const owner = { agentDir: h.agentDir, sessionId: h.sessionId };
		const atStart = approvedState(root, SESSION_TEAM, owner);
		current = atStart;
		await seedOlderRuns(atStart.sessionDir, DEAD_PROCESS);
		await h.start();
		current = approvedState(root, cleaning, owner);
		await h.turn();
		expect(existsSync(recordOf("Old"))).toBe(true);
	});

	test("agents of this process are judged by the process ledger: parked ones are cleaned and marked, live ones stay", async () => {
		const h = session({ config: cleaning, artifactsDir: artifacts, agentDir, ledger: () => listAgents({ scope: h.sessionDir }), now: () => NOW });
		noteAgentStart({ id: "Parked", name: "storm-implementer", now: 1, scope: h.sessionDir });
		noteAgentParked("Parked", h.sessionDir);
		noteAgentStart({ id: "Live", name: "storm-implementer", now: 1, scope: h.sessionDir });
		await seedOlderRuns(h.sessionDir, processKey(), "Parked");
		await writeFile(recordOf("Live"), "transcript");
		await recordTrustedRun(h.sessionDir, { runId: "run-old-1", artifactsDir: artifacts, process: processKey(), agents: ["Parked", "Live"], endedAt: "t" });
		await h.start();
		await h.turn();
		expect(existsSync(recordOf("Parked"))).toBe(false);
		expect(existsSync(recordOf("Live"))).toBe(true);
		const ledger = listAgents({ scope: h.sessionDir });
		expect(ledger.find(entry => entry.id === "Parked")?.cleanedAt).toBe(NOW);
		expect(ledger.find(entry => entry.id === "Live")?.cleanedAt).toBeUndefined();
	});

	test("a run end never touches another session's records, trust list, counters or the repo", async () => {
		const h = session();
		const other = session();
		const foreign = runRecord({
			runId: "run-20261119-000000-oth0",
			status: "running",
			process: DEAD_PROCESS,
			startedAt: "2026-11-19T00:00:00.000Z",
		});
		await writeRun(other.sessionDir, foreign);
		await recordTrustedRun(other.sessionDir, {
			runId: foreign.runId,
			artifactsDir: path.join(root, "unused-artifacts"),
			process: DEAD_PROCESS,
			agents: [],
			endedAt: "2026-11-19T01:00:00.000Z",
		});
		await updateTrialState(other.sessionDir, "other-trial", current => ({ ...current, seen: 1 }));

		const runId = await h.start();
		await h.turn();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ status: "ended" });

		// The other session's record is not stopped, its trust list and counters are untouched, and nothing was written
		// into the target work tree (no implicit `.omp/storm`, no `.gitignore`).
		expect(await readRun(other.sessionDir, foreign.runId)).toEqual(foreign);
		expect((await readTrustedRuns(other.sessionDir)).map(run => run.runId)).toEqual([foreign.runId]);
		expect((await readTrialStates(other.sessionDir))["other-trial"]?.seen).toBe(1);
		expect(existsSync(path.join(root, ".omp"))).toBe(false);
		expect(existsSync(path.join(h.sessionDir, ".gitignore"))).toBe(false);
	});

	test("a crashed earlier run of the session is closed as stopped when this one ends", async () => {
		const crashed = runRecord({ runId: "run-20261119-000000-dead", status: "running", process: DEAD_PROCESS, startedAt: "2026-11-19T00:00:00.000Z" });
		const h = session();
		await writeRun(h.sessionDir, crashed);
		await h.start();
		await h.turn();
		expect(await readRun(h.sessionDir, crashed.runId)).toMatchObject({ status: "stopped", endedAt: crashed.startedAt });
	});
});

describe("director counters", () => {
	/** The options of a checkpoint compaction; a preflight's bare instructions string is not one. */
	const checkpointOptions = (options: string | CompactOptions | undefined): CompactOptions => {
		if (typeof options !== "object" || options === null) throw new Error("expected checkpoint options");
		return options;
	};

	test("count only while the run is active and land in the record", async () => {
		const h = session();
		h.controller.noteMainSpend(5);
		h.controller.noteBlockedEdit();
		h.controller.noteBlockedFollowUp();
		h.controller.noteBlockedRead();
		h.controller.noteRead(999, true);
		h.controller.noteMainContext(999_999);
		expect(h.controller.directing()).toBe(false);

		const runId = await h.start();
		h.controller.noteMainSpend(1.5);
		h.controller.noteMainSpend(0.5);
		h.controller.noteBlockedEdit();
		h.controller.noteBlockedFollowUp();
		h.controller.noteBlockedFollowUp();
		h.controller.noteMainContext(80_000);
		h.controller.noteMainContext(120_000);
		h.controller.noteMainContext(90_000);
		recordCost(runId, "a/i", 4);
		const record = await h.controller.finish("no-changes");
		expect(record).toMatchObject({ mainCostUsd: 2, blockedEdits: 1, blockedFollowUps: 2, costUsd: 4, maxMainContext: 120_000 });
		expect(record?.reads).toBeUndefined();
	});

	test("reads: calls, characters returned, the share a subagent had read too, and refusals, in the record and the index", async () => {
		const h = session();
		const runId = await h.start();
		h.controller.noteRead(3_000, false);
		h.controller.noteRead(6_500, true);
		h.controller.noteRead(500, true);
		h.controller.noteBlockedRead();
		const reads = { director: 3, directorChars: 10_000, duplicateChars: 7_000, blocked: 1 };
		expect(h.controller.active()?.reads).toEqual(reads);
		const record = await h.controller.finish("no-changes");
		expect(record?.reads).toEqual(reads);
		expect((await readRunIndex(h.sessionDir)).find(s => s.runId === runId)?.reads).toEqual(reads);
		// The summary carries the share that the 65% baseline is compared with.
		expect(record && summarizeRun(record)).toContain("70%");
	});

	test("a refused read alone still opens the counters", async () => {
		const h = session();
		await h.start();
		h.controller.noteBlockedRead();
		expect((await h.controller.finish("no-changes"))?.reads).toEqual({ director: 0, directorChars: 0, duplicateChars: 0, blocked: 1 });
	});

	test("a heavy run starts one handoff checkpoint; small and in-flight contexts start none and only an applied commit is recorded", async () => {
		const at = Date.parse("2026-11-20T10:00:00.000Z");
		const plan: RunPlan = { lanes: [{ name: "probe", kind: "code", role: "implementer" }], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		const startAuto = async (h: FakeSession): Promise<void> => {
			const started = await h.controller.startWithPlan(h.ctx, ask("probe"), plan, configHash(h.config));
			if (!started.ok) throw new Error(started.reason);
		};
		// Below the director cap nothing is asked of the host.
		const small = session({ usage: usage(199_999, 49), now: () => at });
		const smallCalls: CompactOptions[] = [];
		small.ctx.compact = options => {
			smallCalls.push(checkpointOptions(options));
			return Promise.resolve();
		};
		await startAuto(small);
		expect(small.controller.startCheckpoint()).toBe(false);
		expect(smallCalls).toEqual([]);
		await small.controller.finish("no-changes");

		const heavy = usage(206_512, 51);
		const h = session({ usage: heavy, now: () => at });
		const calls: CompactOptions[] = [];
		const pending: Array<PromiseWithResolvers<void>> = [];
		h.ctx.compact = options => {
			calls.push(checkpointOptions(options));
			const wait = Promise.withResolvers<void>();
			pending.push(wait);
			return wait.promise;
		};
		await startAuto(h);
		expect(h.controller.autoRun()).toBe(true);
		expect(h.controller.startCheckpoint()).toBe(true);
		// The same run inside the host's summary never asks twice.
		expect(h.controller.startCheckpoint()).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ mode: "handoff" });
		expect(calls[0]?.internalGuidance).toContain("Storm 장부");
		expect(calls[0]?.internalGuidance).toContain("probe");
		expect(calls[0]?.signal).toBeDefined();
		// Not awaited: startCheckpoint returned while the host summary is still pending.
		heavy.tokens = 30_000;
		heavy.percent = 7;
		calls[0]?.onComplete?.({} as never);
		pending[0]?.resolve();
		await until(() => h.controller.active()?.checkpoints?.length === 1);
		expect(h.controller.active()?.checkpoints).toEqual([{ at: new Date(at).toISOString(), before: 206_512, after: 30_000 }]);
		// The record and the summary carry the applied compaction only.
		const record = await h.controller.finish("no-changes");
		expect(record?.checkpoints).toHaveLength(1);
		expect(record && summarizeRun(record)).toContain("실행 중 압축 1회");
	});

	test("a rejected or no-op host compaction leaves no mark and holds the retry off for the min gap", async () => {
		let now = T0;
		const plan: RunPlan = { lanes: [{ name: "probe", kind: "code", role: "implementer" }], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		const h = session({ usage: usage(210_000, 55), now: () => now });
		const calls: Array<{ options: CompactOptions; wait: PromiseWithResolvers<void> }> = [];
		h.ctx.compact = options => {
			const wait = Promise.withResolvers<void>();
			calls.push({ options: checkpointOptions(options), wait });
			return wait.promise;
		};
		const started = await h.controller.startWithPlan(h.ctx, ask("probe"), plan, configHash(h.config));
		if (!started.ok) throw new Error(started.reason);
		expect(h.controller.startCheckpoint()).toBe(true);
		// The host refuses: nothing is counted, and the same instant may not ask again.
		calls[0]?.wait.reject(new Error("Compaction already in progress"));
		await until(() => calls.length === 1 && !h.controller.active()?.checkpoints);
		expect(h.controller.startCheckpoint()).toBe(false);
		expect(h.controller.active()?.checkpoints).toBeUndefined();
		now += 10 * 60_000;
		expect(h.controller.startCheckpoint()).toBe(true);
		// A host that resolves without a commit reports a no-op: still not a checkpoint, and still held off.
		calls[1]?.wait.resolve();
		await until(() => calls.length === 2 && !h.controller.active()?.checkpoints);
		expect(h.controller.active()?.checkpoints).toBeUndefined();
		expect(h.controller.startCheckpoint()).toBe(false);
		now += 10 * 60_000;
		expect(h.controller.startCheckpoint()).toBe(true);
		calls[2]?.options.onComplete?.({} as never);
		calls[2]?.wait.resolve();
		await until(() => h.controller.active()?.checkpoints?.length === 1);
		expect(h.controller.active()?.checkpoints).toHaveLength(1);
		await h.controller.finish("no-changes");
	});

	test("a stop cancels the run's checkpoint; its late commit never marks the next run", async () => {
		const at = T0;
		const plan: RunPlan = { lanes: [{ name: "probe", kind: "code", role: "implementer" }], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		const h = session({ usage: usage(220_000, 58), now: () => at });
		const calls: Array<{ options: CompactOptions; wait: PromiseWithResolvers<void> }> = [];
		h.ctx.compact = options => {
			const wait = Promise.withResolvers<void>();
			calls.push({ options: checkpointOptions(options), wait });
			return wait.promise;
		};
		const first = await h.controller.startWithPlan(h.ctx, ask("probe"), plan, configHash(h.config));
		if (!first.ok) throw new Error(first.reason);
		expect(h.controller.startCheckpoint()).toBe(true);
		await h.controller.finish("shutdown");
		// A switch/stop aborts the host summary without interrupting any turn.
		expect(calls[0]?.options.signal?.aborted).toBe(true);

		// A fresh run owns a fresh checkpoint; the old commit resolving after it must not add a mark there.
		const second = await h.controller.startWithPlan(h.ctx, ask("second"), plan, configHash(h.config));
		if (!second.ok) throw new Error(second.reason);
		calls[0]?.options.onComplete?.({} as never);
		calls[0]?.wait.resolve();
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
		expect(h.controller.active()?.checkpoints).toBeUndefined();
		// The old abort is not a host rejection either: the new run may checkpoint immediately.
		expect(h.controller.startCheckpoint()).toBe(true);
		expect(calls).toHaveLength(2);
		calls[1]?.options.onComplete?.({} as never);
		calls[1]?.wait.resolve();
		await until(() => h.controller.active()?.checkpoints?.length === 1);
		expect(h.controller.active()?.checkpoints).toHaveLength(1);
		await h.controller.finish("no-changes");
	});

	test("the sync-wait checkpoint only starts for an automatic run", async () => {
		const h = session();
		await h.start();
		expect(h.controller.autoRun()).toBe(false);
		expect(h.controller.startAutoCheckpoint()).toBe(false);
		await h.controller.finish("no-changes");
	});
});

describe("run summary", () => {
	const base = runRecord({ costUsd: 2, spawns: [spawn] });
	const numbers = (line: string | undefined): number[] => line?.match(/\d+/g)?.map(Number) ?? [];

	test("counts subagents, the reused ones and the follow-ups delivered to them", () => {
		const lines = summarizeRun({ ...base, agents: [agent({ followUps: 3 }), agent({ id: "Review", followUps: 1 }), agent({ id: "Scout" })] }).split("\n");
		// Run, spawns, subagents, reviews: the subagent line is the third.
		expect(lines).toHaveLength(4);
		expect(numbers(lines[2])).toEqual([3, 2, 4]);
	});

	test("blocked spawns are tallied by code, not quoted", () => {
		const blocked = (code: SpawnBlockCode): SpawnRecord => ({ ...spawn, outcome: "blocked", code, reason: "SECRET SENTENCE" });
		const text = summarizeRun({ ...base, spawns: [spawn, blocked("no-plan"), blocked("no-plan"), blocked("role-cap")] });
		expect(text).not.toContain("SECRET SENTENCE");
		// 1 routed, 3 blocked; then 2 of one code and 1 of another.
		expect(numbers(text.split("\n")[1])).toEqual([1, 3, 2, 1]);
	});

	test("stays within five lines when every line is present; the director line carries its numbers", () => {
		const run: RunRecord = {
			...base,
			mainCostUsd: 1,
			blockedEdits: 1,
			blockedFollowUps: 2,
			maxMainContext: 180_000,
			checkpoints: [{ at: "t", before: 1 }],
			reads: { director: 4, directorChars: 8_000, duplicateChars: 2_000, blocked: 3 },
			budget: { perRunUsd: 5, onExceed: "block-spawns" },
			cleanup: { agents: 2, files: 6, bytes: 2048, stormFiles: 1 },
			plan: {
				lanes: [
					{ name: "a", kind: "code", role: "implementer" },
					{ name: "b", kind: "code", role: "implementer" },
					{ name: "c", kind: "review", role: "reviewer" },
				],
				workers: { implementer: 2, reviewer: 1 },
				submittedAt: "2026-11-20T09:00:00.000Z",
			},
			spawns: [spawn, { ...spawn, outcome: "blocked", code: "parallelism", reason: "x" }],
			agents: [
				agent({ review: { reviews: 3, passed: 1, failed: 2, findings: [1, 0, 0, 0] } }),
				agent({ id: "Rev2", review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 2] } }),
			],
		};
		const lines = summarizeRun(run).split("\n");
		expect(lines).toHaveLength(5);
		expect(lines.every(l => l.startsWith("- "))).toBe(true);
		expect(lines[0]).toContain("run-1");
		expect(lines[0]).toContain("$2.00");
		expect(lines[0]).toContain("$5.00");
		// Lanes per role: 3 in all, 2 and 1.
		expect(numbers(lines[0]?.slice(lines[0].lastIndexOf("3")))).toEqual([3, 2, 1]);
		const director = lines[2] ?? "";
		for (const part of ["$1.00", "50%", "25%", "180.0k"]) expect(director).toContain(part);
		// A run without spawns has no review line.
		expect(summarizeRun({ ...run, spawns: [] }).split("\n")).toHaveLength(4);
	});

	test("a record written by 0.9 (call-counted reads, keyword contract) still summarizes", () => {
		const old = { ...base, contract: "workflowz", approvalId: "ap-1", reads: { director: 9, duplicate: 3, blocked: 2 } } as unknown as RunRecord;
		const lines = summarizeRun(old).split("\n");
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(lines.join("\n")).not.toContain("NaN");
	});

	test("turns and the end reason are on the first line; a 0.10 record's reason shows as written", () => {
		const first = (run: RunRecord) => summarizeRun(run).split("\n")[0] ?? "";
		expect(first({ ...base, turns: 7 })).toContain("7");
		expect(first({ ...base, turns: 8 })).toBe(first({ ...base, turns: 7 }).replace("7", "8"));
		// Records of 0.10 may carry a mode and reasons this version no longer has: it renders and shows the raw reason.
		const old = { ...base, status: "stopped", mode: "goal", turns: 7, endReason: "goal-complete", goal: { objective: "t" } } as unknown as RunRecord;
		const lines = summarizeRun(old).split("\n");
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(first(old)).toContain("goal-complete");
		expect(first(old)).toContain("7");
	});

	test("a record with the round bound shows the finished turns over it", () => {
		const first = (run: RunRecord) => summarizeRun(run).split("\n")[0] ?? "";
		expect(first({ ...base, turns: 2, maxRounds: 4 })).toContain("2/4");
		expect(first({ ...base, turns: 2 })).not.toContain("2/4");
	});
});

describe("run plan", () => {
	const plan = { lanes: [{ name: "a", kind: "code" as const, role: "implementer" }], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };

	test("setPlan needs an active run; the plan reaches the ledger, the live record and the final record", async () => {
		const h = session();
		expect(await h.controller.setPlan(h.ctx, plan)).toMatchObject({ ok: false });
		const runId = await h.start();
		expect(activeLedgerRun(h.sessionDir)?.plan).toBeUndefined();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		expect(activeLedgerRun(h.sessionDir)?.plan).toEqual(plan);
		expect(h.controller.active()?.plan).toEqual(plan);
		noteRunSpawn(runId, spawn);
		expect(runSpawns(runId)).toEqual([spawn]);
		const record = await h.controller.finish("no-changes");
		expect(record).toMatchObject({ plan });
		expect(activeLedgerRun(h.sessionDir)).toBeUndefined();
	});

	test("a replan that changes a lane's identity is refused before the plan in force changes", async () => {
		const h = session();
		await h.start();
		const first: RunPlan = {
			lanes: [{ name: "api", kind: "code", role: "implementer", files: ["api.ts"], goal: "Build the API" }],
			workers: { implementer: 1 },
			submittedAt: "2026-11-20T09:00:00.000Z",
		};
		expect(await h.controller.setPlan(h.ctx, first)).toEqual({ ok: true });
		const drift: RunPlan = { ...first, lanes: [{ ...first.lanes[0]!, goal: "Build the web view" }] };
		const refused = await h.controller.setPlan(h.ctx, drift);
		expect(refused.ok).toBe(false);
		expect(refused.ok ? "" : refused.reason).toContain("api");
		expect(activeLedgerRun(h.sessionDir)?.plan).toEqual(first);
		expect(h.controller.active()?.plan).toEqual(first);
		// A status update is not identity: the same lane keeps its evidence and may update progress.
		const progress: RunPlan = { ...first, lanes: [{ ...first.lanes[0]!, progress: "half done" }] };
		expect(await h.controller.setPlan(h.ctx, progress)).toEqual({ ok: true });
		expect(activeLedgerRun(h.sessionDir)?.plan).toEqual(progress);
		expect(await h.controller.finish("no-changes")).toMatchObject({ plan: progress });
	});
});

describe("closeout brief", () => {
	const brief = (over: Partial<CloseoutDraft> = {}): CloseoutDraft => ({
		result: "API를 추가했습니다.",
		verification: "unit 체크를 통과했습니다.",
		remaining: "문서 반영이 남았습니다.",
		next: [
			{ kind: "run", task: "문서 반영을 새 Storm 작업으로 맡기기" },
			{ kind: "run", task: "API 경계를 다시 점검하는 좁은 작업", why: "리뷰가 경계를 보지 않았습니다" },
			{ kind: "user", text: "변경 기록을 직접 확인하기" },
		],
		...over,
	});
	type Recorded = { title: string; markdown: string; style?: CloseoutRecordStyle; released: number };
	/** Captures each transcript record with its presentation style and how many leases were released before it. */
	const capture = (h: FakeSession): Recorded[] => {
		const seen: Recorded[] = [];
		const original = h.ui.ui.record.bind(h.ui.ui);
		h.ui.ui.record = (title, markdown, style) => {
			seen.push({ title, markdown, ...(style === undefined ? {} : { style }), released: h.leases.released.length });
			original(title, markdown, style);
		};
		return seen;
	};

	test("stages on the active run without completing it and persists only the latest valid brief", async () => {
		const h = session({ agents: [writer()] });
		expect(h.controller.submitCloseout(h.ctx, brief())).toMatchObject({ ok: false });
		const runId = await h.start();
		expect(h.controller.submitCloseout(h.ctx, brief())).toEqual({ ok: true });
		const active = h.controller.active();
		expect(active).toMatchObject({ status: "running" });
		expect(active !== undefined && "endReason" in active).toBe(false);
		expect(h.controller.directing()).toBe(true);
		expect(h.summaries()).toBe(0);
		const rejected = brief({ next: [{ kind: "run", task: "같은 방향" }, { kind: "run", task: " 같은 방향 " }] });
		expect(h.controller.submitCloseout(h.ctx, rejected)).toMatchObject({ ok: false });
		// Older three-string drafts are read from stored records only; a new submission must be typed.
		expect(h.controller.submitCloseout(h.ctx, { ...brief(), next: ["a", "b", "c"] } as unknown as CloseoutDraft)).toMatchObject({ ok: false });
		const latest = brief({ result: "최신 결과입니다." });
		expect(h.controller.submitCloseout(h.ctx, latest)).toEqual({ ok: true });
		const record = await h.controller.finish("interrupted", h.ctx);
		expect(record).toMatchObject({ status: "stopped", endReason: "interrupted", closeout: latest });
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ closeout: latest });
		expect(h.summaries()).toBe(1);
		expect(h.ui.records[0]?.markdown).toContain("최신 결과입니다.");
		expect(h.ui.records[0]?.markdown).not.toContain("API를 추가했습니다.");
		// Verification is detail: it stays in the record, never on the card.
		expect(h.ui.records[0]?.markdown).not.toContain("unit 체크를 통과했습니다.");
	});

	test("the record snapshots its own target and team facts at finish", async () => {
		const h = session({ config: { ...SESSION_TEAM, requiredChecks: [{ name: "unit", argv: ["true"] }] } });
		const runId = await h.start();
		await h.controller.finish("no-changes", h.ctx);
		const stored = await readRun(h.sessionDir, runId);
		expect(stored?.closeoutFacts).toEqual({ target: path.basename(h.repo.root), pendingLanes: [], requiredChecks: ["unit"] });
		expect(stored?.closeoutFacts?.target).not.toContain("/");
	});

	test("a card comes after the lease release, carries its style, and a non-interactive host registers no number", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-closeout", agents: [writer()] });
		const runId = await h.start();
		const draft = brief();
		expect(h.controller.submitCloseout(h.ctx, draft)).toEqual({ ok: true });
		const seen = capture(h);
		expect(await h.controller.finish("interrupted", h.ctx)).toMatchObject({ status: "stopped", endReason: "interrupted" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.title).toBe(CLOSEOUT_TITLE);
		expect(seen[0]?.released).toBe(1);
		expect(seen[0]?.style).toMatchObject({ kind: "closeout", runId });
		expect(Array.isArray(seen[0]?.style?.info)).toBe(true);
		const stored = (await readRun(h.sessionDir, runId)) as RunRecord;
		const shown = closeoutBrief(stored, { resumable: true });
		expect(shown.tier).toBe("card");
		expect(seen[0]?.markdown).toBe(renderCloseout(shown, false).markdown);
		expect(seen[0]?.markdown).not.toContain(CLOSEOUT_CHOICE_HINT);
		// The fake host has a UI but is not the interactive TUI: nothing is answerable by number.
		expect(takeCloseoutChoice(h.ctx, "1")).toBeUndefined();
		expect(h.controller.runId()).toBeUndefined();
		await h.controller.finish("verified", h.ctx);
		expect(h.summaries()).toBe(1);
		expect(await readRunIndex(h.sessionDir)).toHaveLength(1);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ closeout: draft });
	});

	test("an interactive TUI card numbers the director's runs, then the exact trusted resume, once and same-session only", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-tui", agents: [writer()] });
		const tui: ExtensionContext = { ...h.ctx, mode: "tui" };
		const runId = await h.start();
		const draft = brief();
		expect(h.controller.submitCloseout(h.ctx, draft)).toEqual({ ok: true });
		expect(await h.controller.finish("interrupted", tui)).toMatchObject({ status: "stopped" });
		const stored = (await readRun(h.sessionDir, runId)) as RunRecord;
		expect(h.ui.records[0]?.markdown).toBe(renderCloseout(closeoutBrief(stored, { resumable: true }), true).markdown);
		// Another session cannot consume this one's settled choice.
		const other = { ...tui, sessionManager: { getSessionId: () => "session-other" } } as unknown as ExtensionContext;
		expect(takeCloseoutChoice(other, "1")).toBeUndefined();
		expect(takeCloseoutChoice(tui, "3")).toEqual({ runId, action: expect.objectContaining({ kind: "resume" }) });
		expect(takeCloseoutChoice(tui, "1")).toBeUndefined();
	});

	test("the first numbered pick is the director's first run direction; user-owned work is never numbered", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-pick", agents: [writer()] });
		const tui: ExtensionContext = { ...h.ctx, mode: "tui" };
		const runId = await h.start();
		expect(h.controller.submitCloseout(h.ctx, brief())).toEqual({ ok: true });
		await h.controller.finish("interrupted", tui);
		expect(takeCloseoutChoice(tui, "1")).toEqual({
			runId,
			action: { kind: "run", label: "문서 반영을 새 Storm 작업으로 맡기기", task: "문서 반영을 새 Storm 작업으로 맡기기" },
		});
		const stored = (await readRun(h.sessionDir, runId)) as RunRecord;
		const shown = closeoutBrief(stored, { resumable: true });
		expect(shown.actions.map(action => action.kind)).toEqual(["run", "run", "resume"]);
		expect(shown.userActions).toEqual(["변경 기록을 직접 확인하기"]);
	});

	test("a draft's resume is dropped when this run is not the session's trusted resume candidate", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-no-pointer", agents: [writer()] });
		const tui: ExtensionContext = { ...h.ctx, mode: "tui" };
		// The pointer cannot be written, so nothing proves this machine may continue the run.
		await mkdir(resumePointerFile(h.sessionDir), { recursive: true });
		const runId = await h.start();
		const draft = brief({ next: [{ kind: "resume" }, { kind: "run", task: "좁게 다시 맡기기" }] });
		expect(h.controller.submitCloseout(h.ctx, draft)).toEqual({ ok: true });
		await h.controller.finish("interrupted", tui);
		expect(takeCloseoutChoice(tui, "1")).toEqual({ runId, action: expect.objectContaining({ kind: "run", task: "좁게 다시 맡기기" }) });
	});

	test("a substantive run without a brief has no director prose and offers only the exact resume", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-nobrief", agents: [writer()] });
		const tui: ExtensionContext = { ...h.ctx, mode: "tui" };
		const runId = await h.start();
		expect(await h.controller.finish("interrupted", tui)).toMatchObject({ status: "stopped", endReason: "interrupted" });
		expect(h.summaries()).toBe(1);
		const stored = (await readRun(h.sessionDir, runId)) as RunRecord;
		const shown = closeoutBrief(stored, { resumable: true });
		expect(shown.tier).toBe("card");
		expect(shown.director).toBeUndefined();
		expect(shown.actions).toHaveLength(1);
		expect(shown.residual.some(text => text.includes("검증되지 않은 변경"))).toBe(true);
		expect(takeCloseoutChoice(tui, "2")).toBeUndefined();
	});

	test("a short clean run leaves one line, no director prose and no numbers, even on the TUI", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-line" });
		const tui: ExtensionContext = { ...h.ctx, mode: "tui" };
		const runId = await h.start();
		expect(h.controller.submitCloseout(h.ctx, brief())).toEqual({ ok: true });
		await h.controller.finish("no-changes", tui);
		expect(h.summaries()).toBe(1);
		const stored = (await readRun(h.sessionDir, runId)) as RunRecord;
		const shown = closeoutBrief(stored);
		expect(shown.tier).toBe("line");
		expect(shown.actions).toEqual([]);
		expect(h.ui.records[0]?.markdown).not.toContain("API를 추가했습니다.");
		expect(takeCloseoutChoice(tui, "1")).toBeUndefined();
	});

	test("a shutdown without a context writes the brief but opens no card", async () => {
		const h = session();
		const runId = await h.start();
		const draft = brief();
		expect(h.controller.submitCloseout(h.ctx, draft)).toEqual({ ok: true });
		expect(await h.controller.finish("shutdown")).toMatchObject({ status: "stopped", endReason: "shutdown" });
		expect(h.summaries()).toBe(0);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ closeout: draft });
	});

	test("a session switch ends as shutdown and opens no card even though a context is available", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start();
		const draft = brief();
		expect(h.controller.submitCloseout(h.ctx, draft)).toEqual({ ok: true });
		expect(await h.controller.finish("shutdown", h.ctx)).toMatchObject({ status: "stopped", endReason: "shutdown" });
		expect(h.summaries()).toBe(0);
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ closeout: draft });
	});

	test("a stable session identity that differs from the directing session publishes no card or choice", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-old" });
		const runId = await h.start();
		const draft = brief();
		expect(h.controller.submitCloseout(h.ctx, draft)).toEqual({ ok: true });
		const other: ExtensionContext = Object.assign({}, h.ctx, {
			mode: "tui",
			sessionManager: { getSessionId: () => "session-new" },
		});
		expect(await h.controller.finish("interrupted", other)).toMatchObject({ status: "stopped", endReason: "interrupted" });
		expect(h.summaries()).toBe(0);
		expect(takeCloseoutChoice(h.ctx, "1")).toBeUndefined();
		expect(takeCloseoutChoice(other, "1")).toBeUndefined();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ closeout: draft });
	});

	test("a session manager changing in place cannot open a closeout in the new conversation", async () => {
		const h = session({ artifactsDir: root, sessionId: "session-original" });
		let active = "session-original";
		Object.assign(h.ctx, { mode: "tui", sessionManager: { ...h.ctx.sessionManager, getSessionId: () => active, getArtifactsDir: () => root } });
		const runId = await h.start();
		const draft = brief();
		expect(h.controller.submitCloseout(h.ctx, draft)).toEqual({ ok: true });
		active = "session-switched";
		await h.controller.finish("interrupted", h.ctx);
		expect(h.summaries()).toBe(0);
		expect(takeCloseoutChoice(h.ctx, "1")).toBeUndefined();
		expect(await readRun(h.sessionDir, runId)).toMatchObject({ closeout: draft });
	});
});

describe("declared results", () => {
	const REPORT = "report.json";
	const REPORT_TEXT = '{\n  "total": 42,\n  "source": "user owns this file"\n}\n';

	/** A report the adapter would accept for this run; tests override only the host facts they exercise. */
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

	const planFor = (lanes: RunPlan["lanes"], workers: Record<string, number>): RunPlan => ({
		lanes,
		workers,
		submittedAt: new Date(T0).toISOString(),
	});

	/** Admits one planned lane the way the extension does, returning the host spawn key. */
	function admit(h: FakeSession, plan: RunPlan, agents: AgentEntry[], laneName: string): string {
		const lane = plan.lanes.find(candidate => candidate.name === laneName);
		if (lane === undefined) throw new Error(`no lane ${laneName}`);
		const lanes = h.controller.runLanes();
		if (lanes === undefined) throw new Error("the run has no lane matcher");
		const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
		const bound = lanes.assign({ name: lane.name, agent }, plan, h.config);
		if (!bound.ok) throw new Error(bound.reason);
		const spawnKey = (bound.input as Record<string, unknown>).name;
		if (typeof spawnKey !== "string") throw new Error("the lane binding has no task name");
		lanes.admit({ spawnKey, agent, outcome: "routed" });
		agents.push(agentEntry({ id: spawnKey, name: agent, role: lane.role, state: "idle", requests: 1, lastActivityAt: T0 + 1 }));
		return spawnKey;
	}

	test("T01a: an existing user file and a no-op worker leave the named change unmet, not a quiet close", async () => {
		await writeFile(path.join(root, REPORT), REPORT_TEXT);
		const agents: AgentEntry[] = [];
		const h = session({ agents });
		const runId = await h.start();
		const plan = planFor(
			[
				{
					name: "report",
					kind: "code",
					role: "implementer",
					files: [REPORT],
					goal: "Create or update report.json",
					results: [{ id: "report-change", kind: "change", criterion: "the worker changed report.json", path: REPORT, contains: '"total": 42' }],
				},
			],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "report");
		expect(await h.controller.prepareAttempt({ runId, lane: "report", spawnKey, parentId: "main", dispatch: "d1", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "report",
			spawnKey,
			parentId: "main",
			dispatch: "d1",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `task:call-1:${spawnKey}` }),
			citations: [],
		});

		const live = h.controller.active();
		const row = live?.results?.find(item => item.id === "report-change");
		expect(row).toMatchObject({ state: "unmet", lane: "report", attemptId: `task:call-1:${spawnKey}` });
		expect(row?.reason).toBeTruthy();
		expect(await Bun.file(path.join(root, REPORT)).text()).toBe(REPORT_TEXT);

		// The first round cannot close quietly; the next round has no progress to report and stops honestly.
		await h.turn();
		expect(h.controller.directing()).toBe(true);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		await h.turn();
		const run = await readRun(h.sessionDir, runId);
		expect(run).toMatchObject({ status: "stopped", endReason: "no-progress" });
		expect(run?.results?.find(item => item.id === "report-change")).toMatchObject({ state: "unmet", attemptId: `task:call-1:${spawnKey}` });
		expect(await Bun.file(path.join(root, REPORT)).text()).toBe(REPORT_TEXT);
	});

	test("T01b: a witnessed answer completes a read-only run on its native attempt without a code review", async () => {
		await writeFile(path.join(root, REPORT), REPORT_TEXT);
		const agents: AgentEntry[] = [];
		const h = session({ agents });
		const runId = await h.start();
		const plan = planFor(
			[
				{
					name: "read-report",
					kind: "explore",
					role: "explorer",
					goal: "Answer report.json's total",
					results: [{ id: "report-answer", kind: "answer", criterion: "states the total and cites report.json", path: REPORT, contains: '"total": 42' }],
				},
			],
			{ explorer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "read-report");
		expect(await h.controller.prepareAttempt({ runId, lane: "read-report", spawnKey, parentId: "main", dispatch: "d2", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "read-report",
			spawnKey,
			parentId: "main",
			dispatch: "d2",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-1:${spawnKey}` }),
			// The typed `"total": 42` statement restated for its key; extra words would leave the answer reviewable.
			reportText: "The total is 42 (report.json:2).",
			citations: [{ path: REPORT, line: 2 }],
		});
		await h.turn();

		const run = await readRun(h.sessionDir, runId);
		expect(run).toMatchObject({ status: "done", endReason: "verified" });
		expect(run?.results?.find(item => item.id === "report-answer")).toMatchObject({ state: "accepted", lane: "read-report", attemptId: `job:job-1:${spawnKey}` });
		expect(run?.agents?.some(item => item.role === "reviewer")).not.toBe(true);
	});

	test("a structured config refusal marks the pending result blocked with its own unblock text", async () => {
		const h = session({ agents: [] });
		const runId = await h.start({ task: "t", rounds: 1 });
		const plan = planFor(
			[
				{
					name: "report",
					kind: "code",
					role: "implementer",
					files: [REPORT],
					results: [{ id: "report-change", kind: "change", criterion: "report.json changed", path: REPORT }],
				},
			],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		noteRunSpawn(runId, {
			...spawn,
			agent: "storm-implementer",
			spawnKey: "report",
			outcome: "blocked",
			code: "no-config",
			reason: "팀 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		});
		const final = await h.controller.finish("no-progress");
		expect(final?.results?.find(item => item.id === "report-change")).toMatchObject({
			state: "pending",
			remedy: "blocked",
			unblock: "팀 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		});
	});

	test("a same-role sibling or a capacity refusal never guesses a blocked result", async () => {
		const h = session({ agents: [] });
		const runId = await h.start({ task: "t", rounds: 1 });
		const plan = planFor(
			[
				{ name: "one", kind: "code", role: "implementer", files: ["one.txt"], results: [{ id: "r1", kind: "change", criterion: "one", path: "one.txt" }] },
				{ name: "two", kind: "code", role: "implementer", files: ["two.txt"], results: [{ id: "r2", kind: "change", criterion: "two", path: "two.txt" }] },
			],
			{ implementer: 2 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		// The host key is not a lane name and two lanes share the role: the refusal cannot be attributed safely.
		noteRunSpawn(runId, {
			...spawn,
			agent: "storm-implementer",
			spawnKey: "generated-lane",
			outcome: "blocked",
			code: "no-config",
			reason: "팀 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		});
		const final = await h.controller.finish("no-progress");
		expect(final?.results?.every(row => row.remedy !== "blocked")).toBe(true);
	});

	test("a wrong-role spawn keyed like a lane does not block the planned role's result", async () => {
		const h = session({ agents: [] });
		const runId = await h.start({ task: "t", rounds: 1 });
		const plan = planFor(
			[
				{
					name: "report",
					kind: "code",
					role: "implementer",
					files: [REPORT],
					results: [{ id: "report-change", kind: "change", criterion: "report.json changed", path: REPORT }],
				},
			],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		// The host key collides with the lane name, but another role owns this refused spawn: its reason cannot
		// explain why the planned implementer requirement is open.
		noteRunSpawn(runId, {
			...spawn,
			agent: "storm-quick",
			role: "quick",
			spawnKey: "report",
			outcome: "blocked",
			code: "no-config",
			reason: "팀 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		});
		const final = await h.controller.finish("no-progress");
		expect(final?.results?.find(item => item.id === "report-change")?.remedy).not.toBe("blocked");
	});

	test("a sole same-role spawn with a host key outside the lane name still attributes its refusal", async () => {
		const h = session({ agents: [] });
		const runId = await h.start({ task: "t", rounds: 1 });
		const plan = planFor(
			[
				{
					name: "report",
					kind: "code",
					role: "implementer",
					files: [REPORT],
					results: [{ id: "report-change", kind: "change", criterion: "report.json changed", path: REPORT }],
				},
			],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		// One lane of this role exists, so the unkeyed refusal is attributable to its pending requirement.
		noteRunSpawn(runId, {
			...spawn,
			agent: "storm-implementer",
			spawnKey: "generated-lane",
			outcome: "blocked",
			code: "no-config",
			reason: "팀 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		});
		const final = await h.controller.finish("no-progress");
		expect(final?.results?.find(item => item.id === "report-change")).toMatchObject({
			state: "pending",
			remedy: "blocked",
			unblock: "팀 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		});
	});

	test("a capacity refusal is not a config blocker and a later admitted spawn clears the earlier one", async () => {
		const h = session({ agents: [] });
		const runId = await h.start({ task: "t", rounds: 1 });
		const plan = planFor(
			[
				{
					name: "report",
					kind: "code",
					role: "implementer",
					files: [REPORT],
					results: [{ id: "report-change", kind: "change", criterion: "report.json changed", path: REPORT }],
				},
			],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		noteRunSpawn(runId, {
			...spawn,
			agent: "storm-implementer",
			spawnKey: "report",
			outcome: "blocked",
			code: "parallelism",
			reason: "동시 상한에 닿았습니다. 하나가 끝나기를 기다리세요.",
		});
		noteRunSpawn(runId, { ...spawn, agent: "storm-implementer", spawnKey: "report", outcome: "routed" });
		const final = await h.controller.finish("no-progress");
		expect(final?.results?.find(item => item.id === "report-change")?.remedy).toBeUndefined();
	});

	test("T06: a qualitative submission is reviewable, not verified, when no reviewer ran", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents });
		const runId = await h.start({ task: "t", rounds: 1 });
		const target = "acceptance-qualitative.md";
		const plan = planFor(
			[
				{
					name: "submit",
					kind: "code",
					role: "implementer",
					files: [target],
					goal: "Submit prose for qualitative review",
					results: [{ id: "qualitative-submission", kind: "change", criterion: "the prose explains why no rewrite is needed" }],
				},
				{ name: "review", kind: "review", role: "reviewer", goal: "Independent verdict" },
			],
			{ implementer: 1, reviewer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "submit");
		const writer = agents.find(item => item.id === spawnKey);
		if (writer === undefined) throw new Error("the lane was not admitted");
		writer.changes = 1;
		writer.lastChangeAt = T0;
		expect(await h.controller.prepareAttempt({ runId, lane: "submit", spawnKey, parentId: "main", dispatch: "d3", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, target), "nothing needs rewriting; the total 42 is already reported.\n");
		await h.controller.settleAttempt({
			runId,
			lane: "submit",
			spawnKey,
			parentId: "main",
			dispatch: "d3",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-3:${spawnKey}` }),
			citations: [],
		});
		await h.turn();

		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		expect(run).toMatchObject({ status: "stopped", endReason: "round-limit" });
		expect(run?.results?.find(item => item.id === "qualitative-submission")).toMatchObject({
			state: "reviewable",
			lane: "submit",
			attemptId: `job:job-3:${spawnKey}`,
		});
	});

	test("T06: an incorrect current-tree verdict leaves the requirement unmet", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents, tree: () => treeAt() });
		const runId = await h.start({ task: "t", rounds: 1 });
		const target = "acceptance-incorrect.txt";
		const plan = planFor(
			[
				{
					name: "write",
					kind: "code",
					role: "implementer",
					files: [target],
					goal: "Submit a change for review",
					results: [{ id: "incorrect-change", kind: "change", criterion: "ready for the reviewer's qualitative verdict" }],
				},
				{ name: "review", kind: "review", role: "reviewer", goal: "Independent verdict" },
			],
			{ implementer: 1, reviewer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "write");
		admit(h, plan, agents, "review");
		const writer = agents.find(item => item.id === spawnKey);
		if (writer === undefined) throw new Error("the lane was not admitted");
		writer.changes = 1;
		writer.lastChangeAt = T0;
		expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "d4", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, target), "change\n");
		await h.controller.settleAttempt({
			runId,
			lane: "write",
			spawnKey,
			parentId: "main",
			dispatch: "d4",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-4:${spawnKey}` }),
			citations: [],
		});
		agents.push(verdict(T0 + 2, false, F0));
		await h.turn();

		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		const row = run?.results?.find(item => item.id === "incorrect-change");
		expect(row).toMatchObject({ state: "unmet", lane: "write", origin: "review", attemptId: `job:job-4:${spawnKey}` });
		expect(row?.reason).toContain("incorrect");
	});

	test("T06: a current correct verdict accepts a reviewable requirement even when the run is not verified", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents, tree: () => treeAt() });
		const runId = await h.start({ task: "t", rounds: 1 });
		const target = "acceptance-accepted.txt";
		const plan = planFor(
			[
				{
					name: "write",
					kind: "code",
					role: "implementer",
					files: [target],
					goal: "Submit a qualitative change",
					results: [{ id: "accepted-change", kind: "change", criterion: "ready for the reviewer's qualitative verdict" }],
				},
				{ name: "review", kind: "review", role: "reviewer", goal: "Independent current-tree verdict" },
			],
			{ implementer: 1, reviewer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "write");
		admit(h, plan, agents, "review");
		const writer = agents.find(item => item.id === spawnKey);
		if (writer === undefined) throw new Error("the lane was not admitted");
		writer.changes = 1;
		writer.lastChangeAt = T0;
		expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "d5", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, target), "change\n");
		await h.controller.settleAttempt({
			runId,
			lane: "write",
			spawnKey,
			parentId: "main",
			dispatch: "d5",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-5:${spawnKey}` }),
			citations: [],
		});
		agents.push(verdict(T0 + 2, true, F0));
		await h.turn();

		const run = await readRun(h.sessionDir, runId);
		expect(run).toMatchObject({ status: "done", endReason: "verified" });
		expect(run?.results?.find(item => item.id === "accepted-change")).toMatchObject({
			state: "accepted",
			lane: "write",
			origin: "review",
			reviewTree: F0,
			attemptId: `job:job-5:${spawnKey}`,
		});
	});

	test("T06: a verdict for an older tree does not accept the current submission", async () => {
		const agents: AgentEntry[] = [];
		let tree = treeOf("c0", "f0");
		const h = session({ agents, tree: () => treeAt(tree) });
		const runId = await h.start({ task: "t", rounds: 1 });
		const target = "acceptance-stale.txt";
		const plan = planFor(
			[
				{
					name: "write",
					kind: "code",
					role: "implementer",
					files: [target],
					goal: "Submit a change for the current tree",
					results: [{ id: "stale-change", kind: "change", criterion: "reviewed on the current tree before acceptance" }],
				},
				{ name: "review", kind: "review", role: "reviewer", goal: "Review the latest tree" },
			],
			{ implementer: 1, reviewer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "write");
		admit(h, plan, agents, "review");
		const writer = agents.find(item => item.id === spawnKey);
		if (writer === undefined) throw new Error("the lane was not admitted");
		writer.changes = 1;
		writer.lastChangeAt = T0;
		expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "d6", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, target), "change\n");
		await h.controller.settleAttempt({
			runId,
			lane: "write",
			spawnKey,
			parentId: "main",
			dispatch: "d6",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-6:${spawnKey}` }),
			citations: [],
		});
		// The verdict certifies the tree the reviewer saw; a later write moves the tree Storm must judge.
		const oldTree = treeFingerprint(tree);
		agents.push(verdict(T0 + 2, true, oldTree));
		tree = treeOf("c1", "f0");
		await h.turn();

		const run = await readRun(h.sessionDir, runId);
		expect(run?.endReason).not.toBe("verified");
		const row = run?.results?.find(item => item.id === "stale-change");
		expect(row?.state).not.toBe("accepted");
		expect(row).toMatchObject({ lane: "write", attemptId: `job:job-6:${spawnKey}` });
	});

	test("a replan cannot change or silently drop a required result", async () => {
		const h = session({ agents: [] });
		await h.start();
		// A lane that started without a contract may be repaired by adding one; the new id starts pending.
		const uncontracted = planFor([{ name: "report", kind: "code", role: "implementer", files: [REPORT] }], { implementer: 1 });
		expect(await h.controller.setPlan(h.ctx, uncontracted)).toEqual({ ok: true });
		expect(h.controller.active()?.results).toBeUndefined();
		const first = planFor(
			[{ name: "report", kind: "code", role: "implementer", files: [REPORT], results: [{ id: "report-change", kind: "change", criterion: "report.json changed", path: REPORT }] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, first)).toEqual({ ok: true });
		expect(h.controller.active()?.results?.find(item => item.id === "report-change")).toMatchObject({ state: "pending", lane: "report" });

		const narrowed = planFor(
			[{ name: "report", kind: "code", role: "implementer", files: [REPORT], results: [{ id: "report-change", kind: "change", criterion: "a weaker statement", path: REPORT }] }],
			{ implementer: 1 },
		);
		const refused = await h.controller.setPlan(h.ctx, narrowed);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toContain("결과 id 'report-change'");
		expect(h.controller.active()?.results?.find(item => item.id === "report-change")).toMatchObject({ state: "pending", lane: "report" });

		const removed = planFor([{ name: "other-review", kind: "review", role: "reviewer", goal: "Review only" }], { reviewer: 1 });
		expect(await h.controller.setPlan(h.ctx, removed)).toEqual({ ok: true });
		const orphan = h.controller.active()?.results?.find(item => item.id === "report-change");
		expect(orphan).toMatchObject({ state: "pending" });
		expect(orphan?.lane).toBeUndefined();
		expect(orphan?.reason).toContain("계획에서 빠진");
	});

	test("a result's approved check runs after the attempt and can accept the requirement", async () => {
		const agents: AgentEntry[] = [];
		const config: StormConfig = { ...SESSION_TEAM, requiredChecks: [{ name: "unit-result", argv: ["/bin/sh", "-c", "true"] }] };
		const h = session({ agents, config, tree: () => treeAt() });
		const runId = await h.start();
		const target = "checked-result.txt";
		const plan = planFor(
			[
				{
					name: "write",
					kind: "code",
					role: "implementer",
					files: [target],
					results: [{ id: "checked-change", kind: "change", criterion: "the checked change is present", check: "unit-result" }],
				},
			],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "write");
		const writer = agents.find(item => item.id === spawnKey);
		if (writer === undefined) throw new Error("the lane was not admitted");
		writer.changes = 1;
		writer.lastChangeAt = T0;
		expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "d8", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, target), "checked\n");
		await h.controller.settleAttempt({
			runId,
			lane: "write",
			spawnKey,
			parentId: "main",
			dispatch: "d8",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-8:${spawnKey}` }),
			citations: [],
		});
		// No approved check report exists yet: the row waits instead of failing or claiming acceptance.
		expect(h.controller.active()?.results?.find(item => item.id === "checked-change")).toMatchObject({ state: "reviewable" });
		await h.turn();
		h.timers.fire();
		await until(() => h.controller.active()?.results?.find(item => item.id === "checked-change")?.state === "accepted");
		const row = h.controller.active()?.results?.find(item => item.id === "checked-change");
		expect(row).toMatchObject({ state: "accepted", lane: "write", attemptId: `job:job-8:${spawnKey}` });
	});

	test("a replan cannot rewrite an obligation under the same id; the refused plan leaves the old contract in force", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents });
		const runId = await h.start();
		const first = planFor(
			[{ name: "report", kind: "code", role: "implementer", files: [REPORT], results: [{ id: "shared-id", kind: "change", criterion: "old obligation", path: REPORT, contains: "old content" }] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, first)).toEqual({ ok: true });
		const spawnKey = admit(h, first, agents, "report");
		expect(await h.controller.prepareAttempt({ runId, lane: "report", spawnKey, parentId: "main", dispatch: "d9", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		const originalIdentity = h.controller.active()?.results?.find(item => item.id === "shared-id")?.identity;
		expect(originalIdentity).toBeTruthy();

		// The same id in a new lane may only carry the exact same contract; a changed criterion is refused before the
		// plan or the requirement ledger is touched.
		const second = planFor(
			[{ name: "rewritten", kind: "code", role: "implementer", files: ["other.json"], results: [{ id: "shared-id", kind: "change", criterion: "new obligation", path: "other.json" }] }],
			{ implementer: 1 },
		);
		const refused = await h.controller.setPlan(h.ctx, second);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toContain("shared-id");
		expect(h.controller.active()?.plan?.lanes.map(lane => lane.name)).toEqual(["report"]);
		expect(h.controller.active()?.results?.find(item => item.id === "shared-id")).toMatchObject({
			state: "pending",
			lane: "report",
			identity: originalIdentity,
		});

		// The pending attempt still belongs to that unchanged obligation, so its honest settlement is evaluated.
		await writeFile(path.join(root, REPORT), "old content\n");
		await h.controller.settleAttempt({
			runId,
			lane: "report",
			spawnKey,
			parentId: "main",
			dispatch: "d9",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-9:${spawnKey}` }),
			citations: [],
		});
		expect(h.controller.active()?.results?.find(item => item.id === "shared-id")).toMatchObject({
			state: "accepted",
			lane: "report",
			attemptId: `job:job-9:${spawnKey}`,
		});
	});

	test("a failed attempt is rejected before any file read, even when the required path exists", async () => {
		const h = session({ agents: [] });
		const runId = await h.start();
		const target = "failed-attempt.txt";
		const plan = planFor(
			[{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "failed-change", kind: "change", criterion: "the file has the marker", path: target, contains: "MARKER" }] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey: "SpawnF", parentId: "main", dispatch: "d10", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		// A directory at the required path: an evaluator read would say it cannot read a regular file. The host
		// settlement must win before that read and keep the attempt id.
		await mkdir(path.join(root, target));
		await h.controller.settleAttempt({
			runId,
			lane: "write",
			spawnKey: "SpawnF",
			parentId: "main",
			dispatch: "d10",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey: "SpawnF", attemptId: "job:job-f:SpawnF", outcome: "failure" }),
			citations: [],
		});
		const row = h.controller.active()?.results?.find(item => item.id === "failed-change");
		expect(row).toMatchObject({ state: "unmet", lane: "write", attemptId: "job:job-f:SpawnF" });
		expect(row?.reason).toContain("실패");
		expect(row?.reason).not.toContain("읽");
	});

	test("a cancelled attempt and an invalid structured result cannot accept a present answer", async () => {
		const h = session({ agents: [] });
		const runId = await h.start();
		const plan = planFor(
			[{ name: "read", kind: "explore", role: "explorer", results: [{ id: "answer", kind: "answer", criterion: "cite the source", path: REPORT, contains: '"total": 42' }] }],
			{ explorer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		await writeFile(path.join(root, REPORT), REPORT_TEXT);
		expect(await h.controller.prepareAttempt({ runId, lane: "read", spawnKey: "SpawnC", parentId: "main", dispatch: "d11", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "read",
			spawnKey: "SpawnC",
			parentId: "main",
			dispatch: "d11",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey: "SpawnC", attemptId: "job:job-c:SpawnC", outcome: "cancel" }),
			reportText: "The total is 42 (report.json:2).",
			citations: [{ path: REPORT, line: 2 }],
		});
		const cancelled = h.controller.active()?.results?.find(item => item.id === "answer");
		expect(cancelled).toMatchObject({ state: "unmet", attemptId: "job:job-c:SpawnC" });
		expect(cancelled?.reason).toContain("취소");

		// The adapter maps an explicitly invalid structured output to outcome failure; the row stays unmet either way.
		expect(await h.controller.prepareAttempt({ runId, lane: "read", spawnKey: "SpawnC", parentId: "main", dispatch: "d12", followUp: true, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "read",
			spawnKey: "SpawnC",
			parentId: "main",
			dispatch: "d12",
			startedAt: T0 + 2,
			observedAt: T0 + 3,
			report: report({ runId, spawnKey: "SpawnC", attemptId: "job:job-c2:SpawnC", outcome: "failure", schemaStatus: "invalid" }),
			reportText: "The total is 42 (report.json:2).",
			citations: [{ path: REPORT, line: 2 }],
		});
		const invalid = h.controller.active()?.results?.find(item => item.id === "answer");
		expect(invalid).toMatchObject({ state: "unmet", attemptId: "job:job-c2:SpawnC" });
		expect(invalid?.reason).toContain("구조화");
	});

	test("a failed follow-up cannot keep an earlier accepted answer as accepted", async () => {
		const h = session({ agents: [] });
		const runId = await h.start();
		const plan = planFor(
			[{ name: "read", kind: "explore", role: "explorer", results: [{ id: "answer", kind: "answer", criterion: "cite the source", path: REPORT, contains: '"total": 42' }] }],
			{ explorer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		await writeFile(path.join(root, REPORT), REPORT_TEXT);
		expect(await h.controller.prepareAttempt({ runId, lane: "read", spawnKey: "SpawnA", parentId: "main", dispatch: "d13", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "read",
			spawnKey: "SpawnA",
			parentId: "main",
			dispatch: "d13",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey: "SpawnA", attemptId: "job:job-a:SpawnA" }),
			reportText: "The total is 42 (report.json:2).",
			citations: [{ path: REPORT, line: 2 }],
		});
		expect(h.controller.active()?.results?.find(item => item.id === "answer")).toMatchObject({ state: "accepted" });

		expect(await h.controller.prepareAttempt({ runId, lane: "read", spawnKey: "SpawnA", parentId: "main", dispatch: "d14", followUp: true, artifactMode: "shared", startedAt: T0 + 2 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "read",
			spawnKey: "SpawnA",
			parentId: "main",
			dispatch: "d14",
			startedAt: T0 + 2,
			observedAt: T0 + 3,
			report: report({ runId, spawnKey: "SpawnA", attemptId: "job:job-a2:SpawnA", outcome: "failure" }),
			reportText: "The total is 42 (report.json:2).",
			citations: [{ path: REPORT, line: 2 }],
		});
		const row = h.controller.active()?.results?.find(item => item.id === "answer");
		expect(row).toMatchObject({ state: "unmet", attemptId: "job:job-a2:SpawnA" });
		expect(row?.reason).toContain("실패");
	});

	test("a verified close cannot race an attempt whose terminal settlement never arrived", async () => {
		const h = session({ agents: [] });
		const runId = await h.start();
		const plan = planFor(
			[{ name: "write", kind: "code", role: "implementer", files: [REPORT], results: [{ id: "report-change", kind: "change", criterion: "report.json changed", path: REPORT, contains: '"total": 42' }] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey: "SpawnP", parentId: "main", dispatch: "d15", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		// The terminal async delivery is still in flight when the run tries to close as verified.
		const final = await h.controller.finish("verified");
		expect(final).toMatchObject({ status: "stopped", endReason: "no-progress" });
		const row = (await readRun(h.sessionDir, runId))?.results?.find(item => item.id === "report-change");
		expect(row).toMatchObject({ state: "unmet", finalized: "unsettled" });
		expect(row?.reason).toContain("확정되기 전에");
		expect(row?.attemptId).toBeUndefined();

		// A late settlement after the record is written changes nothing: the requirement is not resurrected.
		const late = await h.controller.settleAttempt({
			runId,
			lane: "write",
			spawnKey: "SpawnP",
			parentId: "main",
			dispatch: "d15",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey: "SpawnP", attemptId: "job:job-p:SpawnP" }),
			citations: [],
		});
		expect(late).toBeUndefined();
		expect((await readRun(h.sessionDir, runId))?.results?.find(item => item.id === "report-change")).toMatchObject({ state: "unmet" });
	});

	test("a later correct independent review cannot promote a failed attempt", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents, tree: () => treeAt() });
		const runId = await h.start({ task: "t" });
		const target = "failed-review.txt";
		const plan = planFor(
			[
				{ name: "write", kind: "code", role: "implementer", files: [target], results: [{ id: "failed-change", kind: "change", criterion: "ready for review" }] },
				{ name: "review", kind: "review", role: "reviewer", goal: "Independent verdict" },
			],
			{ implementer: 1, reviewer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		const spawnKey = admit(h, plan, agents, "write");
		admit(h, plan, agents, "review");
		const writer = agents.find(item => item.id === spawnKey);
		if (writer === undefined) throw new Error("the lane was not admitted");
		writer.changes = 1;
		writer.lastChangeAt = T0;
		expect(await h.controller.prepareAttempt({ runId, lane: "write", spawnKey, parentId: "main", dispatch: "d16", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		await writeFile(path.join(root, target), "present but not witnessed\n");
		await h.controller.settleAttempt({
			runId,
			lane: "write",
			spawnKey,
			parentId: "main",
			dispatch: "d16",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({ runId, spawnKey, attemptId: `job:job-16:${spawnKey}`, outcome: "failure" }),
			citations: [],
		});
		expect(h.controller.active()?.results?.find(item => item.id === "failed-change")).toMatchObject({ state: "unmet" });

		agents.push(verdict(T0 + 2, true, F0));
		await h.turn();
		const row = h.controller.active()?.results?.find(item => item.id === "failed-change");
		expect(row).toMatchObject({ state: "unmet", origin: "attempt", attemptId: `job:job-16:${spawnKey}` });
		expect(row?.reason).toContain("실패");
	});

	test("a missing host report keeps the requirement unmet without inventing an attempt id", async () => {
		const h = session({ agents: [] });
		const runId = await h.start();
		const plan = planFor(
			[{ name: "report", kind: "code", role: "implementer", files: [REPORT], results: [{ id: "report-change", kind: "change", criterion: "report.json changed", path: REPORT }] }],
			{ implementer: 1 },
		);
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });
		expect(await h.controller.prepareAttempt({ runId, lane: "report", spawnKey: "Spawn0", parentId: "main", dispatch: "d7", followUp: false, artifactMode: "shared", startedAt: T0 })).toEqual({ ok: true });
		const missing = report({ runId, spawnKey: "Spawn0", attemptId: "task:call-1:Spawn0" });
		delete missing.attemptId;
		missing.capture = "missing";
		missing.captureError = "native-result-missing";
		await h.controller.settleAttempt({
			runId,
			lane: "report",
			spawnKey: "Spawn0",
			parentId: "main",
			dispatch: "d7",
			startedAt: T0,
			observedAt: T0 + 1,
			report: missing,
			citations: [],
		});
		const row = h.controller.active()?.results?.find(item => item.id === "report-change");
		expect(row).toMatchObject({ state: "unmet" });
		expect(row?.attemptId).toBeUndefined();
		expect(row?.reason).toContain("native-result-missing");
	});

	test("an isolated artifact prerequisite is usable only while its verified retained source exists", async () => {
		const agents: AgentEntry[] = [];
		const h = session({ agents });
		const runId = await h.start();
		const patchPath = path.join(os.tmpdir(), `storm-retained-${Date.now()}.patch`);
		const patch = [
			"diff --git a/experiment.txt b/experiment.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/experiment.txt",
			"@@ -0,0 +1 @@",
			"+experiment change",
			"",
		].join("\n");
		await writeFile(patchPath, patch);
		const plan = planFor(
			[{
				name: "experiment",
				kind: "run",
				role: "implementer",
				files: ["experiment.txt"],
				isolationReason: "result stays outside the parent",
				results: [{ id: "experiment-patch", kind: "artifact", criterion: "the patch carries experiment change", path: "experiment.txt", contains: "experiment change" }],
			}],
			{ implementer: 1 },
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
		expect(await h.controller.prepareAttempt({ runId, lane: "experiment", spawnKey, parentId: "main", dispatch: "artifact", followUp: false, artifactMode: "isolated", startedAt: T0 })).toEqual({ ok: true });
		await h.controller.settleAttempt({
			runId,
			lane: "experiment",
			spawnKey,
			parentId: "main",
			dispatch: "artifact",
			startedAt: T0,
			observedAt: T0 + 1,
			report: report({
				runId,
				spawnKey,
				attemptId: `job:job-artifact:${spawnKey}`,
				artifacts: [{ kind: "patch", path: patchPath, bytes: Buffer.byteLength(patch), capturedAt: T0 + 1, source: "task-result" }],
			}),
			citations: [],
		});
		const accepted = await h.controller.laneReadiness(plan, new Set(["experiment"]));
		const first = accepted.get("experiment")?.results[0];
		expect(first).toMatchObject({ id: "experiment-patch", state: "accepted" });
		expect(first?.retained?.path).toBe(await realpath(patchPath));
		expect(first?.retained?.ref).toContain("experiment-patch@");
		// Acceptance alone is not enough: the verified source must still exist at admission time.
		await rm(patchPath, { force: true });
		const missing = await h.controller.laneReadiness(plan, new Set(["experiment"]));
		const second = missing.get("experiment")?.results[0];
		expect(second).toMatchObject({ state: "unmet" });
		expect(second?.reason).toContain("보존");
	});
});