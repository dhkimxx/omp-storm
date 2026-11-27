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
import { type HostJobRow, RunLanes } from "../src/runtime/lanes.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { readRun } from "../src/runtime/run.ts";
import { treeFingerprint } from "../src/runtime/rounds.ts";
import type { TreeReading, TreeState } from "../src/runtime/tree.ts";
import type { AgentEntry, RunPlan, StormConfig } from "../src/types.ts";
import { fakeSession, SESSION_TEAM, type SessionOptions, until } from "./fake-session.ts";
import { agentEntry, treeOf } from "./fixtures.ts";

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
});
