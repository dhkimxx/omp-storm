/**
 * One write table for every way the shared tree is written during a run (G1): a worker's reservation, the director's own
 * command (in the foreground or sent to the background), a job batch, a required check and a fence. Each way that starts a
 * writer reads the table in one synchronous step. These tests drive the table directly and through the run controller.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { uncertainCheckBlock } from "../src/runtime/checks.ts";
import { hostJobRows } from "../src/runtime/host-jobs.ts";
import {
	DIRECTOR_DRAIN_WARNING,
	DIRECTOR_EDIT_ENDS,
	DIRECTOR_EDIT_RETRY,
	DIRECTOR_EDITING,
	DIRECTOR_WRITE_ENDING,
	DIRECTOR_WRITE_LATE,
	DIRECTOR_WRITE_LEAD,
	DIRECTOR_WRITE_NO_TARGET,
	completedAssistantMessage,
	directorCallIds,
	directorTurnClean,
	holderPhrase,
} from "../src/runtime/arbiter.ts";
import { type CommitWriterRequest, type HostJobRow, PENDING_WRITE_MS, RunLanes } from "../src/runtime/lanes.ts";
import { type LanePolicy, pathsOverlap, scopesOverlap, WHY_SHELL_READER, WHY_SHELL_REVIEWER } from "../src/policy/capability.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { readRun } from "../src/runtime/run.ts";
import { treeFingerprint } from "../src/runtime/rounds.ts";
import type { TreeReading, TreeState } from "../src/runtime/tree.ts";
import type { AgentEntry, LiveCheck, RunPlan, StormConfig } from "../src/types.ts";
import { fakeSession, SESSION_TEAM, type SessionOptions, until } from "./fake-session.ts";
import { agentEntry, teamOf, treeOf } from "./fixtures.ts";

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-arbiter-")));
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (opts: Omit<SessionOptions, "root"> = {}) => fakeSession({ root, ...opts });
const T0 = Date.parse("2026-11-20T09:00:00Z");
const treeAt = (state: TreeState): TreeReading => ({ base: "base-0", state });
const writer = (over: Partial<AgentEntry> = {}): AgentEntry => agentEntry({ changes: 1, lastChangeAt: T0, ...over });

/** A table over rows the test controls, as the run's controller builds it from the host's snapshot. */
function table(rows: { current: readonly HostJobRow[] | undefined }): RunLanes {
	return new RunLanes("run-1", () => rows.current);
}
const bg = (id: string): HostJobRow => ({ id, type: "bash", status: "running" });
const exec = (lanes: RunLanes, callId: string) => lanes.commitDirectorExec({ callId, now: T0 });

describe("the director's command in the table", () => {
	test("a command takes the tree for the length of its call and releases it at the call's end", () => {
		const rows = { current: [] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(exec(lanes, "c1")).toEqual({ ok: true });
		// The same actor does not refuse itself.
		expect(exec(lanes, "c2")).toEqual({ ok: true });
		expect(lanes.liveHolders(["director-exec"])).toBe(2);
		lanes.callEnded("c1");
		lanes.callEnded("c2");
		expect(lanes.liveHolders(["director-exec", "director-bg"])).toBe(0);
	});

	test("a command omp moved to the background is a holder for as long as the host's rows show it running", () => {
		const rows = { current: [] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(exec(lanes, "c1")).toEqual({ ok: true });
		rows.current = [bg("job_1")];
		lanes.callEnded("c1");
		expect(lanes.liveHolders(["director-exec"])).toBe(0);
		expect(lanes.liveHolders(["director-bg"])).toBe(1);
		// The job ended in the host's rows: the next look at the table frees the tree, with no event of its own.
		rows.current = [];
		expect(lanes.liveHolders(["director-bg"])).toBe(0);
		expect(lanes.takeWriterFreed([], T0)).toBe(true);
	});

	test("a job that was running before anything was asked is seen; a subagent's task job is not a command", () => {
		const rows = { current: [bg("job_0"), { id: "job_t", type: "task", status: "running", agentId: "W" }] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(lanes.liveHolders(["director-bg"])).toBe(1);
	});

	test("a host that cannot show its jobs admits no command, and keeps the hold of a call it could not look after", () => {
		const rows = { current: [] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(exec(lanes, "c1")).toEqual({ ok: true });
		rows.current = undefined;
		lanes.callEnded("c1");
		// Nothing proves that the call left no background job behind: the hold stays.
		expect(lanes.liveHolders(["director-exec"])).toBe(1);
		expect(exec(lanes, "c2")).toMatchObject({ ok: false });
		rows.current = [];
		lanes.callEnded("c1");
		expect(lanes.liveHolders(["director-exec"])).toBe(0);
	});

	test("a job batch, a required check and a fence refuse the command, and a command refuses them", () => {
		const rows = { current: [] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(lanes.commitHolder({ kind: "job", key: "b1", now: T0 })).toEqual({ ok: true });
		expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("정형 작업") });
		expect(lanes.commitHolder({ kind: "check", key: "k1", now: T0 })).toMatchObject({ ok: false });
		lanes.fenceHolder("job", "b1");
		expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("확인되지 않은") });
		lanes.releaseHolder("fence", "b1");
		expect(exec(lanes, "c1")).toEqual({ ok: true });
		// The command in turn holds the tree against a job batch and a check.
		expect(lanes.commitHolder({ kind: "job", key: "b2", now: T0 })).toMatchObject({ ok: false, reason: expect.stringContaining("감독이 실행 중인 명령") });
		expect(lanes.commitHolder({ kind: "check", key: "k2", now: T0 })).toMatchObject({ ok: false });
	});

	test("a worker's reservation refuses the command; a read-only worker's does not exist", () => {
		const lanes = table({ current: [] });
		const config = SESSION_TEAM;
		const plan: RunPlan = { lanes: [{ name: "A", kind: "code", role: "implementer", files: ["a.txt"] }], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		expect(lanes.place({ agent: "storm-implementer", name: "A", task: "x" }, plan, config, { now: T0 }).ok).toBe(true);
		expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("'A' 레인") });
	});
});

describe("a worker that settled keeps its place until the host has finished with it", () => {
	const plan: RunPlan = {
		lanes: [
			{ name: "A", kind: "code", role: "implementer", files: ["a.txt"] },
			{ name: "B", kind: "code", role: "implementer", files: ["b.txt"] },
		],
		workers: { implementer: 2 },
		submittedAt: "2026-11-20T09:00:00.000Z",
	};
	const settled = (id: string): AgentEntry => agentEntry({ id, name: "storm-implementer", role: "implementer", state: "idle", requests: 2, lastActivityAt: T0 + 5 });
	const running = (id: string): AgentEntry => agentEntry({ id, name: "storm-implementer", role: "implementer", state: "running", requests: 2, lastActivityAt: T0 + 5 });
	const policies = new Map([
		["A", { kind: "unknown" as const, reason: "x" }],
		["B", { kind: "unknown" as const, reason: "x" }],
	]);
	const config: StormConfig = SESSION_TEAM;

	test("its parent's call is the receipt: the place is free at the call's end, not at the settled turn", () => {
		const lanes = table({ current: [] });
		expect(lanes.place({ agent: "storm-implementer", name: "A", task: "x" }, plan, config, { policies, callId: "sync-1", now: T0 }).ok).toBe(true);
		lanes.admit({ spawnKey: "A", agent: "storm-implementer", outcome: "routed" }, { plan, config });
		lanes.agentStarted("A");
		lanes.releaseAgent("A");
		const again = lanes.place({ agent: "storm-implementer", name: "B", task: "x" }, plan, config, { policies, agents: [settled("A")], callId: "b-1", now: T0 + 10 });
		expect(again).toMatchObject({ ok: false, code: "lane-write" });
		lanes.callEnded("sync-1");
		expect(lanes.place({ agent: "storm-implementer", name: "B", task: "x" }, plan, config, { policies, agents: [settled("A")], callId: "b-2", now: T0 + 20 }).ok).toBe(true);
	});

	test("the host's task job for the worker is the receipt of an async call: the place is free once the job is gone", () => {
		const rows = { current: [{ id: "job_a", type: "task", status: "running", agentId: "A" }] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(lanes.place({ agent: "storm-implementer", name: "A", task: "x" }, plan, config, { policies, callId: "async-1", now: T0 }).ok).toBe(true);
		lanes.admit({ spawnKey: "A", agent: "storm-implementer", outcome: "routed" }, { plan, config });
		lanes.callEnded("async-1");
		lanes.agentStarted("A");
		lanes.releaseAgent("A");
		const listed = [settled("A")];
		expect(lanes.place({ agent: "storm-implementer", name: "B", task: "x" }, plan, config, { policies, agents: listed, now: T0 + 10 })).toMatchObject({ ok: false, code: "lane-write" });
		rows.current = [];
		expect(lanes.place({ agent: "storm-implementer", name: "B", task: "x" }, plan, config, { policies, agents: listed, now: T0 + 20 }).ok).toBe(true);
	});

	test("a worker that is still running is never freed by a receipt", () => {
		const lanes = table({ current: [] });
		expect(lanes.place({ agent: "storm-implementer", name: "A", task: "x" }, plan, config, { policies, callId: "c-1", now: T0 }).ok).toBe(true);
		lanes.admit({ spawnKey: "A", agent: "storm-implementer", outcome: "routed" }, { plan, config });
		lanes.agentStarted("A");
		lanes.callEnded("c-1");
		expect(lanes.place({ agent: "storm-implementer", name: "B", task: "x" }, plan, config, { policies, agents: [running("A")], now: T0 + 10 })).toMatchObject({ ok: false, code: "lane-write" });
	});
});

describe("the host's job rows", () => {
	test("the rows are read from omp's snapshot: running jobs only, with an unreadable type taken as a command", () => {
		const snapshot = { running: [{ id: "j1", type: "bash", status: "running" }, { id: "j2", status: "running" }, { type: "bash" }], recent: [], delivery: {} } as unknown as AsyncJobSnapshot;
		expect(hostJobRows({ getAsyncJobSnapshot: () => snapshot })).toEqual([
			{ id: "j1", type: "bash", status: "running" },
			{ id: "j2", type: "bash", status: "running" },
		]);
		expect(hostJobRows({ getAsyncJobSnapshot: () => null })).toBeUndefined();
		expect(hostJobRows({ getAsyncJobSnapshot: () => { throw new Error("gone"); } })).toBeUndefined();
		expect(hostJobRows({} as never)).toBeUndefined();
	});
});

describe("through the run controller", () => {
	const jobs: { running: HostJobRow[] } = { running: [] };
	const snapshot = (): AsyncJobSnapshot => ({ running: jobs.running, recent: [], delivery: {} }) as unknown as AsyncJobSnapshot;
	beforeEach(() => {
		jobs.running = [];
	});

	const jobTeam = (ms: number): StormConfig => ({
		...SESSION_TEAM,
		jobs: [{ name: "experiment", argv: [process.execPath, "-e", `setTimeout(() => console.log("OK"), ${ms})`] }],
	});
	const jobPlan: RunPlan = {
		submittedAt: "2026-11-20T09:00:00.000Z",
		workers: {},
		lanes: [{ name: "experiment", kind: "run", role: "quick", job: "experiment", results: [{ id: "experiment-outcome", kind: "answer", criterion: "record observed outcome", contains: "OK" }] }],
	};

	test("a job batch takes the tree in the table for as long as it runs, and a director command cannot start beside it", async () => {
		const h = session({ config: jobTeam(400), asyncJobs: snapshot });
		await h.start({ task: "run the experiment" });
		expect(await h.controller.setPlan(h.ctx, jobPlan)).toEqual({ ok: true });
		const lanes = h.controller.runLanes()!;
		const done = h.controller.executeJobs(h.ctx, ["experiment"], () => true);
		await until(() => lanes.liveHolders(["job"]) === 1);
		expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("정형 작업") });
		expect(await done).toMatchObject({ ok: true });
		expect(lanes.liveHolders(["job", "fence"])).toBe(0);
		expect(exec(lanes, "c2")).toEqual({ ok: true });
		await h.controller.finish("no-changes");
	});

	test("a job batch does not start while the director has a command running, in the foreground or the background", async () => {
		const h = session({ config: jobTeam(10), asyncJobs: snapshot });
		await h.start({ task: "run the experiment" });
		expect(await h.controller.setPlan(h.ctx, jobPlan)).toEqual({ ok: true });
		const lanes = h.controller.runLanes()!;
		expect(exec(lanes, "c1")).toEqual({ ok: true });
		expect(await h.controller.executeJobs(h.ctx, ["experiment"], () => true)).toMatchObject({ ok: false, reason: expect.stringContaining("[storm:job-wait]") });
		jobs.running = [bg("job_9")];
		lanes.callEnded("c1");
		expect(await h.controller.executeJobs(h.ctx, ["experiment"], () => true)).toMatchObject({ ok: false, reason: expect.stringContaining("감독이 백그라운드로 돌린 명령") });
		jobs.running = [];
		expect(await h.controller.executeJobs(h.ctx, ["experiment"], () => true)).toMatchObject({ ok: true });
		await h.controller.finish("no-changes");
	});

	/** A required check that leaves a member of its process group behind, with the OS made to say the group is never empty. */
	function stuckGroup() {
		const real = process.kill.bind(process);
		let stuck = true;
		const spy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			if (stuck && pid < 0 && signal === 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			return real(pid, signal as NodeJS.Signals | number);
		}) as typeof process.kill);
		return { release: (): void => void (stuck = false), restore: (): void => spy.mockRestore() };
	}

	test("a required check takes the tree while it runs; a command of the director waits for it", async () => {
		const config: StormConfig = { ...SESSION_TEAM, requiredChecks: [{ name: "unit", argv: [process.execPath, "-e", "setTimeout(() => {}, 400)"] }] };
		const agents: AgentEntry[] = [writer()];
		let tree = treeOf("d0", "f0");
		const h = session({ config, agents, tree: () => treeAt(tree), asyncJobs: snapshot });
		const runId = await h.start();
		const lanes = h.controller.runLanes()!;
		tree = treeOf("d1", "f0");
		await h.turn();
		agents.push({ ...agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 1, correct: true, tree: treeFingerprint(tree) } }), reviewLog: [{ at: T0 + 1, correct: true, findings: [], tree: treeFingerprint(tree) }] } as AgentEntry);
		h.timers.fire();
		await until(() => lanes.liveHolders(["check"]) === 1);
		expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("필수 검사") });
		await until(async () => (await readRun(h.sessionDir, runId))?.endReason === "verified");
		expect(lanes.liveHolders(["check", "fence"])).toBe(0);
	}, 15_000);

	test("a required check whose processes are not proven gone is a fence: no command, no new run on the target, and its result is no evidence; the proven end lifts it", async () => {
		const stuck = stuckGroup();
		try {
			const config: StormConfig = {
				...SESSION_TEAM,
				requiredChecks: [{ name: "unit", argv: ["/bin/sh", "-c", "sleep 30 >/dev/null 2>&1 & exit 0"] }],
			};
			const agents: AgentEntry[] = [writer()];
			let tree = treeOf("d0", "f0");
			const h = session({ config, agents, tree: () => treeAt(tree), asyncJobs: snapshot });
			const runId = await h.start();
			const lanes = h.controller.runLanes()!;
			tree = treeOf("d1", "f0");
			await h.turn();
			agents.push({ ...agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 1, correct: true, tree: treeFingerprint(tree) } }), reviewLog: [{ at: T0 + 1, correct: true, findings: [], tree: treeFingerprint(tree) }] } as AgentEntry);
			h.timers.fire();
			// The runner stops what the check left behind and gives up after its hard limit: the end stays unproven.
			await until(() => lanes.liveHolders(["fence"]) === 1);
			expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("확인되지 않은") });
			expect(uncertainCheckBlock(root)).toContain("[storm:check-fence]");
			// Nothing the unproven check said is evidence: no check result is on the run, and the live record names no pass.
			expect(h.controller.active()?.checks).toBeUndefined();
			expect((await readRun(h.sessionDir, runId))?.endReason).not.toBe("verified");
			// A new run on the same target is refused until the processes are seen gone.
			await h.controller.finish("interrupted");
			const next = session({ config: SESSION_TEAM });
			expect(await next.controller.start(next.ctx, { task: "another" })).toMatchObject({ ok: false, reason: expect.stringContaining("[storm:check-fence]") });
			stuck.release();
			await until(() => lanes.liveHolders(["fence"]) === 0 && uncertainCheckBlock(root) === undefined);
			expect(exec(lanes, "c2")).toEqual({ ok: true });
		} finally {
			stuck.restore();
		}
	}, 30_000);

	test("a job whose processes are not proven gone fences the run's tree; the proven end lifts the fence, as a check's does (R-G1 over-eager 2)", async () => {
		const stuck = stuckGroup();
		try {
			const h = session({
				config: { ...SESSION_TEAM, jobs: [{ name: "experiment", argv: ["/bin/sh", "-c", "sleep 30 >/dev/null 2>&1 & echo OK; exit 0"] }] },
				asyncJobs: snapshot,
			});
			await h.start({ task: "run the experiment" });
			expect(await h.controller.setPlan(h.ctx, jobPlan)).toEqual({ ok: true });
			const lanes = h.controller.runLanes()!;
			expect(await h.controller.executeJobs(h.ctx, ["experiment"], () => true)).toMatchObject({ ok: true });
			// The end was not proven: the fence stays, a command and another batch are refused.
			expect(lanes.liveHolders(["fence"])).toBe(1);
			expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining("확인되지 않은") });
			expect(await h.controller.executeJobs(h.ctx, ["experiment"], () => true)).toMatchObject({ ok: false, reason: expect.stringContaining("[storm:job-fence]") });
			// The OS shows the group empty: the run's fence ends with it, and the tree is free again within the run.
			stuck.release();
			await until(() => lanes.liveHolders(["fence"]) === 0);
			expect(exec(lanes, "c2")).toEqual({ ok: true });
			await h.controller.finish("no-changes");
		} finally {
			stuck.restore();
		}
	}, 30_000);

	test("a director command that runs when a required check is due holds the check back: it runs after, never beside it", async () => {
		const config: StormConfig = { ...SESSION_TEAM, requiredChecks: [{ name: "unit", argv: ["/bin/sh", "-c", "echo x >> check-count"] }] };
		const agents: AgentEntry[] = [writer()];
		let tree = treeOf("d0", "f0");
		const h = session({ config, agents, tree: () => treeAt(tree), asyncJobs: snapshot });
		const runId = await h.start();
		const lanes = h.controller.runLanes()!;
		expect(exec(lanes, "c1")).toEqual({ ok: true });
		tree = treeOf("d1", "f0");
		await h.turn();
		agents.push({ ...agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 1, correct: true, tree: treeFingerprint(tree) } }), reviewLog: [{ at: T0 + 1, correct: true, findings: [], tree: treeFingerprint(tree) }] } as AgentEntry);
		h.timers.fire();
		// The look ran no check while the command held the tree.
		await Bun.sleep(300);
		expect(await Bun.file(path.join(root, "check-count")).exists()).toBe(false);
		lanes.callEnded("c1");
		await h.controller.finish("no-changes");
		expect(runId).toBeDefined();
	}, 15_000);

	test("a job batch that runs refuses a director edit; the edit that came first refuses the batch; a fence keeps refusing the edit until its proven end", async () => {
		const stuck = stuckGroup();
		try {
			const h = session({
				config: { ...SESSION_TEAM, jobs: [{ name: "experiment", argv: ["/bin/sh", "-c", "sleep 30 >/dev/null 2>&1 & echo OK; exit 0"] }] },
				asyncJobs: snapshot,
			});
			await h.start({ task: "run the experiment" });
			expect(await h.controller.setPlan(h.ctx, jobPlan)).toEqual({ ok: true });
			const lanes = h.controller.runLanes()!;
			const edit = (callId: string) => lanes.commitWriter({ kind: "director-path", callId, paths: ["src/a.ts"], live: h.controller.liveCheck(h.ctx), now: T0 });
			// The edit first: the batch is not started, nothing is left in the table, and the director is told whose files hold it.
			expect(edit("e1")).toEqual({ ok: true });
			const early = await h.controller.executeJobs(h.ctx, ["experiment"], () => true);
			expect(early.ok).toBe(false);
			if (!early.ok) expect(early.reason).toContain("[storm:job-wait]");
			expect(lanes.liveHolders(["job", "fence"])).toBe(0);
			lanes.releaseDirectorCalls(["e1"]);
			// The batch first: its processes are not proven gone, so it fences the tree, and the edit meets the fence.
			expect(await h.controller.executeJobs(h.ctx, ["experiment"], () => true)).toMatchObject({ ok: true });
			expect(lanes.liveHolders(["fence"])).toBe(1);
			const fenced = edit("e2");
			expect(fenced).toMatchObject({ ok: false, code: "lane-write", holder: { kind: "fence" } });
			if (!fenced.ok) expect(fenced.reason).toContain(holderPhrase({ kind: "fence" }));
			stuck.release();
			await until(() => lanes.liveHolders(["fence"]) === 0);
			expect(edit("e2")).toEqual({ ok: true });
			lanes.releaseDirectorCalls(["e2"]);
			await h.controller.finish("no-changes");
		} finally {
			stuck.restore();
		}
	}, 30_000);

	test("a required check that is running refuses a director edit, and its fence refuses it until the proven end", async () => {
		const stuck = stuckGroup();
		try {
			const config: StormConfig = { ...SESSION_TEAM, requiredChecks: [{ name: "unit", argv: ["/bin/sh", "-c", "sleep 30 >/dev/null 2>&1 & exit 0"] }] };
			const agents: AgentEntry[] = [writer()];
			let tree = treeOf("d0", "f0");
			const h = session({ config, agents, tree: () => treeAt(tree), asyncJobs: snapshot });
			await h.start();
			const lanes = h.controller.runLanes()!;
			const edit = (callId: string) => lanes.commitWriter({ kind: "director-path", callId, paths: ["src/a.ts"], live: h.controller.liveCheck(h.ctx), now: T0 });
			tree = treeOf("d1", "f0");
			await h.turn();
			agents.push({ ...agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 1, correct: true, tree: treeFingerprint(tree) } }), reviewLog: [{ at: T0 + 1, correct: true, findings: [], tree: treeFingerprint(tree) }] } as AgentEntry);
			h.timers.fire();
			await until(() => lanes.liveHolders(["check", "fence"]) === 1);
			expect(edit("e1")).toMatchObject({ ok: false, code: "lane-write" });
			await until(() => lanes.liveHolders(["fence"]) === 1);
			expect(edit("e1")).toMatchObject({ ok: false, holder: { kind: "fence" } });
			stuck.release();
			await until(() => lanes.liveHolders(["fence"]) === 0);
			expect(edit("e1")).toEqual({ ok: true });
			lanes.releaseDirectorCalls(["e1"]);
			await h.controller.finish("interrupted");
		} finally {
			stuck.restore();
		}
	}, 30_000);
});

// ── The director's path edit as one more entry in the table ──────────────────────────────────────────────────────────────

const TEAM = teamOf({ quick: "fake/quick", implementer: "fake/dev", explorer: "fake/look", reviewer: "fake/rev" });
const PLAN: RunPlan = {
	lanes: [
		{ name: "X", kind: "code", role: "implementer", goal: "exec writer" },
		{ name: "A", kind: "code", role: "implementer", files: ["src/a.ts"], goal: "a" },
		{ name: "B", kind: "code", role: "quick", files: ["src/b.ts"], goal: "b" },
		{ name: "S", kind: "explore", role: "explorer", goal: "reads and runs commands" },
		{ name: "R", kind: "explore", role: "explorer", goal: "only reads" },
	],
	workers: { implementer: 2, quick: 1, explorer: 2 },
	submittedAt: "2026-11-20T09:00:00.000Z",
};
const POLICIES = new Map<string, LanePolicy>([
	["X", { kind: "unknown", reason: "임의 실행 도구가 있음" }],
	["A", { kind: "paths", paths: ["src/a.ts"], reason: "paths" }],
	["B", { kind: "paths", paths: ["src/b.ts"], reason: "paths" }],
	["S", { kind: "read", reason: "읽기와 셸 실행만 하는 읽기 레인", shell: true }],
	["R", { kind: "read", reason: "읽기 전용" }],
]);
const AGENT_OF: Record<string, string> = { X: "storm-implementer", A: "storm-implementer", B: "storm-quick", S: "storm-explorer", R: "storm-explorer" };
const LIVE: () => LiveCheck = () => ({ ok: true });

const put = (lanes: RunLanes, name: string, over: { now?: number; callId?: string; agents?: AgentEntry[] } = {}) =>
	lanes.place({ agent: AGENT_OF[name]!, name, task: `do ${name}` }, PLAN, TEAM, { policies: POLICIES, now: over.now ?? T0, ...(over.callId === undefined ? {} : { callId: over.callId }), ...(over.agents === undefined ? {} : { agents: over.agents }) });
const auto = (lanes: RunLanes, name: string) =>
	lanes.assign({ agent: AGENT_OF[name]!, name, task: `do ${name}` }, PLAN, TEAM, { policies: POLICIES, now: T0 });
const admit = (lanes: RunLanes, name: string) => lanes.admitChecked({ spawnKey: name, agent: AGENT_OF[name]!, outcome: "routed" }, { plan: PLAN, config: TEAM });
const runningAgent = (id: string): AgentEntry => agentEntry({ id, name: AGENT_OF[id]!, state: "running", requests: 2, lastActivityAt: T0 + 5 });
const idleAgent = (id: string): AgentEntry => agentEntry({ id, name: AGENT_OF[id]!, state: "idle", requests: 2, lastActivityAt: T0 + 5 });
const edit = (lanes: RunLanes, callId: string, paths: string[], over: Partial<CommitWriterRequest> = {}) =>
	lanes.commitWriter({ kind: "director-path", callId, paths, live: LIVE, now: T0, ...over });
const followUp = (lanes: RunLanes, name: string, over: Partial<Parameters<RunLanes["checkFollowUp"]>[0]> = {}) =>
	lanes.checkFollowUp({
		agentId: name,
		agent: AGENT_OF[name]!,
		role: PLAN.lanes.find(lane => lane.name === name)!.role,
		lane: PLAN.lanes.find(lane => lane.name === name)!,
		policy: POLICIES.get(name)!,
		isolated: false,
		agents: [idleAgent(name)],
		now: T0,
		...over,
	});
const refusal = (placed: ReturnType<RunLanes["place"]>): string => (placed.ok ? "" : placed.reason);

describe("two spellings of one file are one file for the table", () => {
	test("a new file spelled with another case or another Unicode form is ordered against the worker that holds it, and the director's edit against it", () => {
		const lanes = table({ current: [] });
		// The path-only lane A holds src/a.ts; the director spells it with capitals: on the default macOS volume it is the same file.
		expect(put(lanes, "A")).toMatchObject({ ok: true });
		expect(edit(lanes, "e1", ["src/A.TS"])).toMatchObject({ ok: false, code: "lane-write" });
		expect(edit(lanes, "e2", ["src/c.ts"])).toEqual({ ok: true });
		// And the other way: a lane placed beside the director's edit of a file it spells differently is refused.
		lanes.releaseDirectorCalls(["e2"]);
		const second = table({ current: [] });
		expect(edit(second, "e3", ["SRC/B.TS"])).toEqual({ ok: true });
		expect(put(second, "B")).toMatchObject({ ok: false, code: "lane-write" });
	});

	test("the guard of a worker's own scope stays exact: folding is the table's, not the scope's", () => {
		expect(pathsOverlap("src/a.ts", "src/A.TS")).toBe(false);
		expect(scopesOverlap(["src/a.ts"], ["src/A.TS"])).toBe(true);
		expect(scopesOverlap(["résumé.md"], ["résumé.md"])).toBe(true);
		expect(scopesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
	});
});

describe("a director path edit and the writers of the table", () => {
	test("an edit refuses a placement that cannot be bounded and one whose files overlap, and lets a path worker on other files start", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		const execWriter = put(lanes, "X");
		expect(execWriter).toMatchObject({ ok: false, code: "lane-write", retry: true });
		expect(refusal(execWriter)).toContain(DIRECTOR_EDITING);
		expect(refusal(execWriter)).toContain(DIRECTOR_EDIT_ENDS);
		const overlapping = put(lanes, "A");
		expect(overlapping).toMatchObject({ ok: false, code: "lane-write" });
		expect(refusal(overlapping)).toContain(DIRECTOR_EDITING);
		// A shell reader is a writer for ordering.
		expect(put(lanes, "S")).toMatchObject({ ok: false, code: "lane-write" });
		// Other files, and a lane that only reads, are not in its way.
		expect(put(lanes, "B").ok).toBe(true);
		expect(put(lanes, "R").ok).toBe(true);
		// Nothing of a refused call was reserved: when the edit is over the lane places.
		expect(lanes.releaseDirectorCalls(["e1"])).toBe(1);
		expect(put(lanes, "A").ok).toBe(true);
	});

	test("an edit on a directory conflicts with a worker on a file inside it, and the other way round", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src"])).toEqual({ ok: true });
		expect(put(lanes, "A")).toMatchObject({ ok: false, code: "lane-write" });
		expect(put(lanes, "B")).toMatchObject({ ok: false, code: "lane-write" });
		lanes.releaseDirectorCalls(["e1"]);
		expect(put(lanes, "A").ok).toBe(true);
		expect(edit(lanes, "e2", ["src/nested/deep.ts"])).toEqual({ ok: true });
		expect(edit(lanes, "e3", ["src"])).toMatchObject({ ok: false, code: "lane-write" });
	});

	describe("each state of a worker refuses the edit", () => {
		const states: { state: string; arrange: (lanes: RunLanes, name: string) => AgentEntry[]; phrase: string }[] = [
			{ state: "placed, not yet a spawn", arrange: (lanes, name) => (put(lanes, name), []), phrase: "배치(시작 전)" },
			{ state: "admitted, not yet seen running", arrange: (lanes, name) => (put(lanes, name), admit(lanes, name), []), phrase: "레인 워커" },
			{
				state: "running",
				arrange: (lanes, name) => (put(lanes, name), admit(lanes, name), lanes.agentStarted(name), [runningAgent(name)]),
				phrase: "레인 워커",
			},
			{
				state: "a follow-up admitted whose turn has not started",
				arrange: (lanes, name) => {
					put(lanes, name);
					admit(lanes, name);
					lanes.agentStarted(name);
					lanes.releaseAgent(name);
					expect(followUp(lanes, name).ok).toBe(true);
					return [idleAgent(name)];
				},
				phrase: "후속 작업(시작 전)",
			},
		];
		for (const { state, arrange, phrase } of states) {
			test(`${state}: an exec worker and a shell reader refuse every edit`, () => {
				for (const name of ["X", "S"]) {
					const lanes = table({ current: [] });
					const agents = arrange(lanes, name);
					const refused = edit(lanes, "e1", ["docs/other.md"], { agents });
					expect(refused).toMatchObject({ ok: false, code: "lane-write", holder: { lane: name } });
					if (!refused.ok) expect(refused.reason).toContain(DIRECTOR_WRITE_LEAD);
					if (!refused.ok) expect(refused.reason).toContain(phrase);
					expect(lanes.liveHolders(["director-path"])).toBe(0);
				}
			});
			test(`${state}: a path worker refuses an edit of its files and lets one on other files through`, () => {
				const lanes = table({ current: [] });
				const agents = arrange(lanes, "A");
				expect(edit(lanes, "e1", ["src/a.ts"], { agents })).toMatchObject({ ok: false, code: "lane-write", holder: { lane: "A" } });
				expect(edit(lanes, "e2", ["src/other.ts"], { agents })).toEqual({ ok: true });
			});
		}
	});

	test("a worker whose turn settled and was reaped no longer holds the tree", () => {
		const lanes = table({ current: [] });
		put(lanes, "X");
		admit(lanes, "X");
		lanes.agentStarted("X");
		expect(edit(lanes, "e1", ["a.ts"], { agents: [runningAgent("X")] })).toMatchObject({ ok: false });
		lanes.releaseAgent("X");
		expect(edit(lanes, "e1", ["a.ts"], { agents: [idleAgent("X")] })).toEqual({ ok: true });
	});

	test("[edit, task] and [task, edit] have opposite winners", () => {
		const first = table({ current: [] });
		expect(edit(first, "e1", ["src/a.ts"])).toEqual({ ok: true });
		expect(put(first, "A")).toMatchObject({ ok: false, code: "lane-write" });
		const second = table({ current: [] });
		expect(put(second, "A").ok).toBe(true);
		const refused = edit(second, "e1", ["src/a.ts"]);
		expect(refused).toMatchObject({ ok: false, code: "lane-write", holder: { lane: "A" } });
		// The same through automatic delegation.
		const viaAuto = table({ current: [] });
		expect(edit(viaAuto, "e1", ["src/a.ts"])).toEqual({ ok: true });
		expect(auto(viaAuto, "A")).toMatchObject({ ok: false, code: "lane-write" });
		const autoFirst = table({ current: [] });
		expect(auto(autoFirst, "X").ok).toBe(true);
		expect(edit(autoFirst, "e1", ["anything.md"])).toMatchObject({ ok: false, code: "lane-write", holder: { lane: "X" } });
	});

	test("a batch with one conflicting item is refused whole and reserves nothing", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		const batch = lanes.place({ tasks: [{ agent: "storm-quick", name: "B", task: "b" }, { agent: "storm-implementer", name: "A", task: "a" }] }, PLAN, TEAM, { policies: POLICIES, now: T0 });
		expect(batch).toMatchObject({ ok: false, code: "lane-write" });
		lanes.releaseDirectorCalls(["e1"]);
		expect(put(lanes, "B").ok).toBe(true);
	});

	test("a placement made before the edit still admits; one that lapsed meets the edit at its late admission and is refused", () => {
		const lanes = table({ current: [] });
		const placed = put(lanes, "A");
		expect(placed.ok).toBe(true);
		// The edit is on other files, so both are bounded and both run.
		expect(edit(lanes, "e1", ["src/other.ts"])).toEqual({ ok: true });
		expect(admit(lanes, "A")).toMatchObject({ ok: true, lane: "A" });

		// A placement whose pending window ran out (nothing wrote behind it) lapses; the director may then take its file.
		const late = table({ current: [] });
		expect(put(late, "A").ok).toBe(true);
		const far = T0 + PENDING_WRITE_MS + 1_000;
		expect(edit(late, "e1", ["src/a.ts"], { now: far })).toEqual({ ok: true });
		const admitted = admit(late, "A");
		expect(admitted).toMatchObject({ ok: false, code: "lane-write" });
		if (!admitted.ok) expect(admitted.reason).toContain(DIRECTOR_EDITING);
		// The edit is still held, and the refused spawn left nothing behind.
		expect(late.liveHolders(["director-path"])).toBe(1);
		late.releaseDirectorCalls(["e1"]);
		expect(put(late, "A").ok).toBe(true);
	});

	test("a late admission of an exec worker that is not planned is refused by an edit as well", () => {
		const lanes = table({ current: [] });
		expect(put(lanes, "X").ok).toBe(true);
		const far = T0 + PENDING_WRITE_MS + 1_000;
		expect(edit(lanes, "e1", ["src/a.ts"], { now: far })).toEqual({ ok: true });
		expect(admit(lanes, "X")).toMatchObject({ ok: false, code: "lane-write" });
	});

	test("a work follow-up and a progress note that may wake a worker are refused by an edit, and each refuses the edit when it came first", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		const work = followUp(lanes, "X");
		expect(work).toMatchObject({ ok: false, code: "lane-write" });
		if (!work.ok) expect(work.reason).toContain(DIRECTOR_EDITING);
		const note = followUp(lanes, "A", { progress: true });
		expect(note).toMatchObject({ ok: false, code: "lane-write" });
		// A path worker on other files is let through.
		expect(followUp(lanes, "B").ok).toBe(true);

		const other = table({ current: [] });
		expect(followUp(other, "A").ok).toBe(true);
		expect(edit(other, "e1", ["src/a.ts"], { agents: [idleAgent("A")] })).toMatchObject({ ok: false, holder: { lane: "A", awaiting: true } });
		// A note to a worker that is running joins its open turn: the worker's own entry keeps refusing the edit.
		const running = table({ current: [] });
		put(running, "X");
		admit(running, "X");
		running.agentStarted("X");
		expect(followUp(running, "X", { progress: true, agents: [runningAgent("X")] }).ok).toBe(true);
		expect(edit(running, "e1", ["a.md"], { agents: [runningAgent("X")] })).toMatchObject({ ok: false, holder: { lane: "X" } });
	});

	test("a follow-up that failed its preflight leaves no hold behind for the edit to meet", () => {
		const lanes = table({ current: [] });
		const gate = followUp(lanes, "X");
		if (!gate.ok) throw new Error("not admitted");
		expect(edit(lanes, "e1", ["a.md"], { agents: [idleAgent("X")] })).toMatchObject({ ok: false });
		lanes.finishFollowUp(gate.token, false);
		expect(edit(lanes, "e1", ["a.md"], { agents: [idleAgent("X")] })).toEqual({ ok: true });
	});

	test("a reservation placed by a call that failed is gone, and does not keep refusing the edit", () => {
		const lanes = table({ current: [] });
		expect(put(lanes, "X", { callId: "t1" }).ok).toBe(true);
		expect(edit(lanes, "e1", ["a.md"])).toMatchObject({ ok: false });
		lanes.releaseCall("t1");
		expect(edit(lanes, "e1", ["a.md"])).toEqual({ ok: true });
	});

	test("two edits of the director never refuse each other, overlapping or not", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		expect(edit(lanes, "e2", ["src/a.ts"])).toEqual({ ok: true });
		expect(edit(lanes, "e3", ["src"])).toEqual({ ok: true });
		expect(lanes.liveHolders(["director-path"])).toBe(3);
	});

	test("committing the same call twice keeps one entry that holds both lists of paths", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		expect(edit(lanes, "e1", ["src/b.ts"])).toEqual({ ok: true });
		expect(lanes.liveHolders(["director-path"])).toBe(1);
		expect(put(lanes, "A")).toMatchObject({ ok: false });
		expect(put(lanes, "B")).toMatchObject({ ok: false });
	});

	test("an edit that names no path is refused: nothing can be bounded", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", [])).toMatchObject({ ok: false, code: "no-target", reason: DIRECTOR_WRITE_NO_TARGET });
		expect(edit(lanes, "e1", [""])).toMatchObject({ ok: false, code: "no-target" });
		expect(lanes.liveHolders(["director-path"])).toBe(0);
	});
});

describe("a director path edit and the host's own writers", () => {
	test("a job, a check, a fence and the director's command each refuse the edit, in words the director can act on", () => {
		const rows = { current: [] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(lanes.commitHolder({ kind: "job", key: "b1", now: T0 })).toEqual({ ok: true });
		const job = edit(lanes, "e1", ["src/a.ts"]);
		expect(job).toMatchObject({ ok: false, code: "lane-write", holder: { kind: "job" } });
		if (!job.ok) expect(job.reason).toContain(holderPhrase({ kind: "job" }));
		if (!job.ok) expect(job.reason).toContain(DIRECTOR_WRITE_LEAD);
		lanes.fenceHolder("job", "b1");
		const fenced = edit(lanes, "e1", ["src/a.ts"]);
		expect(fenced).toMatchObject({ ok: false, holder: { kind: "fence" } });
		if (!fenced.ok) expect(fenced.reason).toContain(holderPhrase({ kind: "fence" }));
		lanes.releaseHolder("fence", "b1");

		expect(lanes.commitHolder({ kind: "check", key: "k1", now: T0 })).toEqual({ ok: true });
		const check = edit(lanes, "e1", ["src/a.ts"]);
		expect(check).toMatchObject({ ok: false, holder: { kind: "check" } });
		if (!check.ok) expect(check.reason).toContain(holderPhrase({ kind: "check" }));
		lanes.releaseHolder("check", "k1");

		expect(exec(lanes, "c1")).toEqual({ ok: true });
		const command = edit(lanes, "e1", ["src/a.ts"]);
		expect(command).toMatchObject({ ok: false, holder: { kind: "director-exec" } });
		if (!command.ok) expect(command.reason).toContain(holderPhrase({ kind: "director-exec" }));
		// ...and the command sent to the background is the same refusal for as long as the host shows it running.
		rows.current = [bg("job_1")];
		lanes.callEnded("c1");
		expect(edit(lanes, "e1", ["src/a.ts"])).toMatchObject({ ok: false, holder: { kind: "director-bg" } });
		rows.current = [];
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
	});

	test("a director command that cannot be seen to have ended keeps refusing the edit: the host's rows are the receipt", () => {
		const rows = { current: [] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(exec(lanes, "c1")).toEqual({ ok: true });
		rows.current = undefined;
		lanes.callEnded("c1");
		expect(edit(lanes, "e1", ["a.md"])).toMatchObject({ ok: false, holder: { kind: "director-exec" } });
	});

	test("an edit refuses a job batch, a check and a command of the director, each saying the director is editing files itself", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		const job = lanes.commitHolder({ kind: "job", key: "b1", now: T0 });
		expect(job).toMatchObject({ ok: false, reason: expect.stringContaining(DIRECTOR_EDIT_ENDS) });
		expect(lanes.commitHolder({ kind: "check", key: "k1", now: T0 })).toMatchObject({ ok: false, reason: expect.stringContaining(DIRECTOR_EDIT_ENDS) });
		expect(exec(lanes, "c1")).toMatchObject({ ok: false, reason: expect.stringContaining(DIRECTOR_EDIT_ENDS) });
		expect(lanes.liveHolders(["job", "check", "director-exec"])).toBe(0);
		lanes.releaseDirectorCalls(["e1"]);
		expect(lanes.commitHolder({ kind: "job", key: "b1", now: T0 })).toEqual({ ok: true });
	});

	test("the other order: a job, a check or a command that came first holds the tree, and the edit is refused", () => {
		for (const start of [
			(lanes: RunLanes) => lanes.commitHolder({ kind: "job", key: "b1", now: T0 }),
			(lanes: RunLanes) => lanes.commitHolder({ kind: "check", key: "k1", now: T0 }),
			(lanes: RunLanes) => exec(lanes, "c1"),
		]) {
			const lanes = table({ current: [] });
			expect(start(lanes)).toEqual({ ok: true });
			expect(edit(lanes, "e1", ["docs/readme.md"])).toMatchObject({ ok: false, code: "lane-write" });
		}
	});
});

describe("the release of a director path edit", () => {
	const callOf = (id: string) => ({ type: "toolCall", id, name: "edit", arguments: {} });
	const assistant = (...ids: string[]) => ({ role: "assistant", content: [{ type: "text", text: "ok" }, ...ids.map(callOf)] });
	const turnEnd = (...ids: string[]) => ({ type: "turn_end", message: assistant(...ids), toolResults: ids.map(toolCallId => ({ role: "toolResult", toolCallId, content: [] })) });
	const agentEnd = (...turns: string[][]) => ({
		type: "agent_end",
		messages: turns.flatMap(ids => [assistant(...ids), ...ids.map(toolCallId => ({ role: "toolResult", toolCallId, content: [] }))]),
	});

	test("the ids of a turn's end and of an agent's end are the calls their own payload contains", () => {
		expect([...directorCallIds(turnEnd("a", "b"))].sort()).toEqual(["a", "b"]);
		expect([...directorCallIds(agentEnd(["a"], ["b", "c"]))].sort()).toEqual(["a", "b", "c"]);
		// A payload that cannot be read names nothing, so nothing is released by it.
		for (const payload of [undefined, null, 3, "turn_end", {}, { message: "x" }, { messages: [null, 4, { role: "assistant", content: "text" }] }, { message: { content: [{ type: "toolCall" }] } }]) {
			expect(directorCallIds(payload).size).toBe(0);
		}
	});

	test("only the ids the payload contains are released: another turn's end leaves the entry, and two turns release independently", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		expect(edit(lanes, "e2", ["src/b.ts"])).toEqual({ ok: true });
		// An old loop's late agent_end names calls of its own turns only.
		expect(lanes.releaseDirectorCalls(directorCallIds(agentEnd(["old-1"], ["old-2"])))).toBe(0);
		expect(lanes.liveHolders(["director-path"])).toBe(2);
		expect(lanes.releaseDirectorCalls(directorCallIds(turnEnd("e1")))).toBe(1);
		expect(lanes.liveHolders(["director-path"])).toBe(1);
		expect(put(lanes, "A").ok).toBe(true);
		expect(put(lanes, "B")).toMatchObject({ ok: false });
		expect(lanes.releaseDirectorCalls(directorCallIds(agentEnd(["e2"])))).toBe(1);
		expect(lanes.liveHolders(["director-path"])).toBe(0);
		// Releasing twice, or an id that never had an entry, does nothing.
		expect(lanes.releaseDirectorCalls(["e1", "e2", "nobody"])).toBe(0);
	});

	test("nothing but the release ends the entry: not the call's end, a failed call, a settled worker, a prune at any time, a host row or a freed-place read", () => {
		const rows = { current: [] as readonly HostJobRow[] | undefined };
		const lanes = table(rows);
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		lanes.callEnded("e1");
		lanes.releaseCall("e1");
		lanes.releaseCall("e1", new Set(["e1"]));
		lanes.cancel("e1", undefined);
		lanes.releaseAgent("e1");
		rows.current = [bg("job_1")];
		rows.current = [];
		expect(lanes.takeWriterFreed([], T0 + 10 * 365 * 24 * 3_600_000)).toBe(false);
		expect(lanes.laneBusy("A", [], T0 + 10 * 365 * 24 * 3_600_000)).toBe(false);
		expect(lanes.liveHolders(["director-path"])).toBe(1);
		expect(put(lanes, "A", { now: T0 + 10 * 365 * 24 * 3_600_000 })).toMatchObject({ ok: false, code: "lane-write" });
		expect(lanes.releaseDirectorCalls(["e1"])).toBe(1);
	});

	test("an unplanned spawn's admission and its settling never adopt or release a director edit or a job", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		expect(lanes.commitHolder({ kind: "job", key: "b1", now: T0 })).toMatchObject({ ok: false });
		// A spawn the plan never placed (a worker named by nobody) is admitted and then settles.
		expect(lanes.admitChecked({ spawnKey: "stray", agent: "storm-implementer", outcome: "routed" })).toMatchObject({ ok: true });
		lanes.agentStarted("stray");
		lanes.releaseAgent("stray");
		lanes.cancel("stray", undefined);
		expect(lanes.liveHolders(["director-path"])).toBe(1);
		lanes.releaseDirectorCalls(["e1"]);
		expect(lanes.commitHolder({ kind: "job", key: "b1", now: T0 })).toEqual({ ok: true });
		lanes.admitChecked({ spawnKey: "stray-2", agent: "storm-implementer", outcome: "routed" });
		lanes.releaseAgent("stray-2");
		expect(lanes.liveHolders(["job"])).toBe(1);
	});
});

describe("the one commit step", () => {
	test("the caller's proof is asked first: a run that is no longer the live one commits nothing, whatever else is true", () => {
		const lanes = table({ current: [] });
		const asked: string[] = [];
		const gone = (): LiveCheck => (asked.push("live"), { ok: false, reason: DIRECTOR_WRITE_ENDING });
		const refused = edit(lanes, "e1", ["a.ts"], { live: gone, deadline: T0 - 1 });
		expect(refused).toEqual({ ok: false, code: "run-ending", reason: DIRECTOR_WRITE_ENDING });
		expect(asked).toEqual(["live"]);
		expect(lanes.liveHolders(["director-path"])).toBe(0);
		// A conflicting writer does not change which refusal comes first.
		put(lanes, "X");
		expect(edit(lanes, "e2", ["a.ts"], { live: gone })).toMatchObject({ ok: false, code: "run-ending" });
		// A proof that throws is a proof that failed.
		const thrown = edit(lanes, "e3", ["a.ts"], { live: () => { throw new Error("ctx is stale"); } });
		expect(thrown).toMatchObject({ ok: false, code: "run-ending" });
		expect(lanes.liveHolders(["director-path"])).toBe(0);
	});

	test("the proof is read inside the step, at the moment of the commit, not when the caller built it", () => {
		const lanes = table({ current: [] });
		const state = { ending: false };
		const live = (): LiveCheck => (state.ending ? { ok: false, reason: DIRECTOR_WRITE_ENDING } : { ok: true });
		expect(edit(lanes, "e1", ["a.ts"], { live })).toEqual({ ok: true });
		state.ending = true;
		expect(edit(lanes, "e2", ["b.ts"], { live })).toMatchObject({ ok: false, code: "run-ending" });
		expect(lanes.liveHolders(["director-path"])).toBe(1);
	});

	test("a deadline at or before now commits nothing; one still ahead does, and a conflict comes after the deadline", () => {
		const lanes = table({ current: [] });
		expect(edit(lanes, "e1", ["a.ts"], { deadline: T0 })).toEqual({ ok: false, code: "deadline", reason: DIRECTOR_WRITE_LATE });
		expect(edit(lanes, "e1", ["a.ts"], { deadline: T0 - 5 })).toMatchObject({ ok: false, code: "deadline" });
		expect(lanes.liveHolders(["director-path"])).toBe(0);
		put(lanes, "X");
		expect(edit(lanes, "e2", ["a.ts"], { deadline: T0 })).toMatchObject({ ok: false, code: "deadline" });
		expect(edit(lanes, "e2", ["a.ts"], { deadline: T0 + 1 })).toMatchObject({ ok: false, code: "lane-write" });
		const free = table({ current: [] });
		expect(edit(free, "e1", ["a.ts"], { deadline: T0 + 1 })).toEqual({ ok: true });
	});

	test("the step does not yield: nothing between the proof and the entry can run, so two edits and a worker see each other in either order", () => {
		const lanes = table({ current: [] });
		const order: string[] = [];
		// The proof itself places a worker; whatever it did is seen by the conflict loop that follows in the same step.
		const live = (): LiveCheck => {
			order.push(put(lanes, "A").ok ? "placed" : "refused");
			return { ok: true };
		};
		expect(edit(lanes, "e1", ["src/a.ts"], { live })).toMatchObject({ ok: false, code: "lane-write" });
		expect(order).toEqual(["placed"]);
	});

	test("an unreadable agent list does not free a worker: the entry of an admitted worker holds until an event", () => {
		const lanes = table({ current: [] });
		put(lanes, "X");
		admit(lanes, "X");
		expect(edit(lanes, "e1", ["a.md"])).toMatchObject({ ok: false });
		expect(edit(lanes, "e1", ["a.md"], { agents: [] })).toMatchObject({ ok: false });
	});
});

describe("a read lane that can run a shell, in the table", () => {
	test("its reason names a read lane, or a review lane, and it is ordered like an exec writer against a director edit", () => {
		const lanes = table({ current: [] });
		expect(put(lanes, "S").ok).toBe(true);
		expect(edit(lanes, "e1", ["anything.md"])).toMatchObject({ ok: false, holder: { lane: "S" } });
		const other = table({ current: [] });
		expect(put(other, "X").ok).toBe(true);
		const refused = put(other, "S");
		expect(refused).toMatchObject({ ok: false, code: "lane-write" });
		expect(refusal(refused)).toContain(WHY_SHELL_READER);
		expect(refusal(refused)).not.toContain(WHY_SHELL_REVIEWER);
		const review: RunPlan = { ...PLAN, lanes: [...PLAN.lanes, { name: "Rv", kind: "review", role: "reviewer", goal: "review" }] };
		const reviewed = other.place({ agent: "storm-reviewer", name: "Rv", task: "review" }, review, TEAM, {
			policies: new Map([...POLICIES, ["Rv", { kind: "read" as const, reason: "x", shell: true as const }]]),
			now: T0,
		});
		expect(refusal(reviewed)).toContain(WHY_SHELL_REVIEWER);
		// A read lane without a shell reserves nothing and is never refused.
		expect(put(other, "R").ok).toBe(true);
	});
});

describe("when a turn is clean, when a request completed, and which calls the table holds (decision D2)", () => {
	const message = (...calls: Array<{ id: string; name?: string }>) => ({
		role: "assistant",
		stopReason: "toolUse",
		content: [{ type: "text", text: "go" }, ...calls.map(call => ({ type: "toolCall", id: call.id, name: call.name ?? "edit", arguments: {} }))],
	});
	const result = (toolCallId: string, isError: unknown) => ({ role: "toolResult", toolCallId, toolName: "edit", isError, content: [] });

	test("a turn is clean only when every file-writing call of its message has a result that is plainly not an error", () => {
		expect(directorTurnClean({ message: message({ id: "a" }, { id: "b", name: "write" }), toolResults: [result("a", false), result("b", false)] })).toBe(true);
		// An error, a missing result, an unreadable flag: each is unclean (omp may still be committing what an aborted call wrote).
		expect(directorTurnClean({ message: message({ id: "a" }, { id: "b" }), toolResults: [result("a", false), result("b", true)] })).toBe(false);
		expect(directorTurnClean({ message: message({ id: "a" }), toolResults: [] })).toBe(false);
		expect(directorTurnClean({ message: message({ id: "a" }), toolResults: [result("a", undefined)] })).toBe(false);
		expect(directorTurnClean({ message: message({ id: "a" }), toolResults: [{ role: "toolResult", content: [] }] })).toBe(false);
		// A call that is no file write does not make the turn unclean: a failed `bash` or `read` is not what this holds for.
		expect(directorTurnClean({ message: message({ id: "a" }, { id: "r", name: "read" }, { id: "s", name: "bash" }), toolResults: [result("a", false), result("r", true), result("s", true)] })).toBe(true);
		// A payload that cannot be read is never clean.
		for (const payload of [undefined, null, 3, {}, { message: "x" }, { message: { content: "x" } }]) expect(directorTurnClean(payload)).toBe(false);
	});

	test("a request completed unless its stop reason says aborted or error; only an assistant message can be one", () => {
		for (const stopReason of [undefined, "stop", "toolUse", "length"]) expect(completedAssistantMessage({ role: "assistant", ...(stopReason === undefined ? {} : { stopReason }) }), String(stopReason)).toBe(true);
		for (const stopReason of ["aborted", "error"]) expect(completedAssistantMessage({ role: "assistant", stopReason }), stopReason).toBe(false);
		for (const other of [{ role: "user" }, { role: "toolResult" }, { role: "custom", customType: "async-result" }, null, undefined, "assistant", 3]) expect(completedAssistantMessage(other)).toBe(false);
	});

	test("the table lists the calls of the director edits it holds, and only those", () => {
		const lanes = table({ current: [] });
		expect(lanes.directorCalls()).toEqual([]);
		expect(edit(lanes, "e1", ["src/a.ts"])).toEqual({ ok: true });
		expect(edit(lanes, "e2", ["src/b.ts"])).toEqual({ ok: true });
		expect(put(lanes, "A")).toMatchObject({ ok: false });
		expect(lanes.directorCalls().sort()).toEqual(["e1", "e2"]);
		lanes.releaseDirectorCalls(["e1"]);
		expect(lanes.directorCalls()).toEqual(["e2"]);
	});

	test("RF9: the retry advice waits for the next answer to finish, and the explanation names failed calls too", () => {
		expect(DIRECTOR_EDIT_RETRY).toContain("다음 답변이 끝난 뒤");
		expect(DIRECTOR_EDIT_RETRY).not.toContain("다음 메시지에서 같은 호출");
		expect(DIRECTOR_EDIT_ENDS).toContain("실패");
		expect(DIRECTOR_DRAIN_WARNING).toContain("실패");
	});
});
