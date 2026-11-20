import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ApprovalStore } from "../src/approval/store.ts";
import { configHash } from "../src/config/canonical.ts";
import { configPath } from "../src/config/store.ts";
import { noteRunSpawn, RunController, summarizeRun, touchRun } from "../src/runtime/controller.ts";
import { recordCost, resetLedger } from "../src/runtime/ledger.ts";
import { readRun } from "../src/runtime/run.ts";
import type { ProjectState } from "../src/state.ts";
import type { AgentEntry, RepoIdentity, RunRecord, SpawnRecord, StormConfig, UiPort } from "../src/types.ts";

const FLUSH_MS = 20;

const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		explorer: { agent: "storm-explorer", models: ["a/x"] },
		implementer: { agent: "storm-implementer", models: ["a/i"] },
		reviewer: { agent: "storm-reviewer", models: ["a/r"] },
	},
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
	runtime: "omp",
};

const spawn: SpawnRecord = {
	ts: "2026-11-20T09:00:00.000Z",
	agent: "storm-implementer",
	invocationKind: "task",
	requested: [],
	outcome: "routed",
	spawnKey: "Impl",
};

function agent(over: Partial<AgentEntry> = {}): AgentEntry {
	return {
		id: "Impl",
		name: "storm-implementer",
		role: "implementer",
		state: "idle",
		startedAt: 0,
		lastActivityAt: 0,
		contextTokens: 1000,
		requests: 3,
		costUsd: 0.1,
		followUps: 0,
		...over,
	};
}

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-controller-")));
});

afterEach(async () => {
	resetLedger();
	await rm(root, { recursive: true, force: true });
});

function harness(agents: AgentEntry[]) {
	const repo: RepoIdentity = { repoId: "git-test-000000000000000000000000", kind: "git-common-dir", root };
	const hash = configHash(config);
	const state: ProjectState = {
		repo,
		config: { status: "ok", path: configPath(root), config, hash, rawSha256: "c".repeat(64), warnings: [] },
		approval: {
			schema: "storm.approval/v1",
			approvalId: "ap-1",
			status: "active",
			repoId: repo.repoId,
			configHash: hash,
			rawSha256: "c".repeat(64),
			approvedAt: "2026-11-20T00:00:00.000Z",
			approvedVia: { mode: "test" },
			versions: { omp: "19.0.1", storm: "test", configSchema: 1 },
			scope: { providers: ["a"], roles: config.roles, runtime: "omp", shadowedAgents: [] },
			supersedes: null,
			expiresAt: null,
		},
		shadows: [],
		store: new ApprovalStore(path.join(root, "agent"), repo),
	};
	const ui: UiPort = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => undefined,
		report: async () => undefined,
		record: () => undefined,
	};
	const controller = new RunController({
		pi: { sendUserMessage: async () => undefined },
		ui: () => ui,
		loadState: async () => state,
		usableKeywords: async () => ({ workflowz: true, orchestrate: true }),
		now: Date.now,
		agents: () => agents,
		flushMs: FLUSH_MS,
	});
	// The controller only hands ctx to its own deps here.
	return { controller, repo, ctx: {} as ExtensionContext };
}

async function startRun(h: ReturnType<typeof harness>): Promise<string> {
	const started = await h.controller.start(h.ctx, "task");
	if (!started.ok) throw new Error(started.reason);
	return started.runId;
}

describe("live run record", () => {
	test("a running run is rewritten after spawns and spend, so other terminals can follow it", async () => {
		const h = harness([agent()]);
		const runId = await startRun(h);
		expect((await readRun(root, runId))?.spawns).toEqual([]);

		noteRunSpawn(runId, spawn);
		recordCost(h.repo.repoId, "a/i", 1.25);
		touchRun(runId);
		await Bun.sleep(FLUSH_MS * 5);

		const live = await readRun(root, runId);
		expect(live).toMatchObject({ status: "running", costUsd: 1.25, spawns: [{ spawnKey: "Impl" }], agents: [{ id: "Impl" }] });
		expect(typeof live?.updatedAt).toBe("string");
		await h.controller.finish("done");
	});

	test("the final record is not overwritten by a pending live write", async () => {
		const h = harness([agent({ followUps: 2 })]);
		const runId = await startRun(h);
		noteRunSpawn(runId, spawn);
		const final = await h.controller.finish("done");
		await Bun.sleep(FLUSH_MS * 5);

		const stored = await readRun(root, runId);
		expect(stored).toMatchObject({ status: "done", spawns: [{ spawnKey: "Impl" }], agents: [{ id: "Impl", followUps: 2 }] });
		expect(stored?.endedAt).toBe(final?.endedAt);
	});
});

describe("director mode", () => {
	test("directs only while its run is active; main spend and blocked edits land in the record and summary", async () => {
		const h = harness([]);
		h.controller.noteMainSpend(5);
		h.controller.noteBlockedEdit();
		expect(h.controller.directing()).toBe(false);

		await startRun(h);
		expect(h.controller.directing()).toBe(true);
		h.controller.noteMainSpend(1.5);
		h.controller.noteMainSpend(0.5);
		h.controller.noteBlockedEdit();
		recordCost(h.repo.repoId, "a/i", 4);
		const record = await h.controller.finish("done");

		expect(h.controller.directing()).toBe(false);
		expect(record).toMatchObject({ mainCostUsd: 2, blockedEdits: 1, costUsd: 4 });
		if (!record) throw new Error("no record");
		const summary = summarizeRun(record);
		expect(summary).toContain("- 메인(감독): 비용 $2.00(전체의 50%) · 직접 수정 1회를 위임으로 돌림");
		expect(summary.split("\n").length).toBeLessThanOrEqual(5);
	});
});

describe("run summary", () => {
	test("reports subagent reuse", () => {
		const run: RunRecord = {
			schema: "storm.run/v1",
			runId: "run-1",
			configHash: "h",
			approvalId: "ap-1",
			startedAt: "2026-11-20T09:00:00.000Z",
			status: "done",
			contract: "workflowz",
			task: "t",
			costUsd: 1,
			costByModel: {},
			spawns: [spawn],
			agents: [agent({ followUps: 3 }), agent({ id: "Review", followUps: 1 }), agent({ id: "Scout" })],
		};
		expect(summarizeRun(run)).toContain("- 서브에이전트: 3개 · 재사용 2개(후속 지시 4회)");
	});

	test("adds the review line and stays within five lines when every line is present", () => {
		const run: RunRecord = {
			schema: "storm.run/v1",
			runId: "run-1",
			configHash: "h",
			approvalId: "ap-1",
			startedAt: "2026-11-20T09:00:00.000Z",
			status: "done",
			contract: "workflowz",
			task: "t",
			costUsd: 2,
			mainCostUsd: 1,
			blockedEdits: 1,
			costByModel: {},
			spawns: [spawn, { ...spawn, outcome: "blocked", reason: "x" }],
			agents: [agent({ review: { verdict: "incorrect", findings: [1, 0, 0, 0] } })],
		};
		const lines = summarizeRun(run).split("\n");
		expect(lines).toContain("- 리뷰: 통과 0 · 수정 필요 1 (P0 1)");
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(summarizeRun({ ...run, spawns: [] })).not.toContain("리뷰");
	});
});
