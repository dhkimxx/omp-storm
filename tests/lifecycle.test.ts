import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalStore } from "../src/approval/store.ts";
import { createProposalStore, pruneProposals } from "../src/proposals/store.ts";
import { listAgents, markAgentsCleaned, noteAgentParked, noteAgentStart, resetAgents } from "../src/runtime/agents.ts";
import { agentRecordFiles, bytesText, formatStorage, type JanitorInput, processKey, readStorage, readTrustedRuns, recordTrustedRun, runJanitor } from "../src/runtime/janitor.ts";
import { appendRunIndex, readRunIndex, summarizeForIndex } from "../src/runtime/run-index.ts";
import { pruneRuns, readRun, writeRun } from "../src/runtime/run.ts";
import { pruneTrialStates, readTrialStates, updateTrialState } from "../src/runtime/state-files.ts";
import type { AgentEntry, RunRecord, StormConfig } from "../src/types.ts";

let tmp: string;
let root: string;
let sessions: string;
let artifacts: string;
let storeDir: string;

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-life-")));
	root = path.join(tmp, "project");
	sessions = path.join(tmp, "agent", "sessions");
	artifacts = path.join(sessions, "proj", "sess");
	storeDir = path.join(tmp, "agent", "storm", "approvals", "git-x");
	await mkdir(root);
	await mkdir(artifacts, { recursive: true });
	await writeFile(`${artifacts}.jsonl`, "");
	resetAgents();
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
	resetAgents();
});

const config = (extra: Partial<StormConfig> = {}): StormConfig => ({
	version: 1,
	priority: "balanced",
	roles: { implementer: { agent: "storm-implementer", models: ["a/i"] } },
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
	runtime: "omp",
	...extra,
});

function agent(id: string, extra: Partial<AgentEntry> = {}): AgentEntry {
	return { id, name: "storm-implementer", state: "parked", startedAt: 1, lastActivityAt: 1, contextTokens: 10, requests: 1, costUsd: 0, followUps: 0, ...extra };
}

function run(n: number, extra: Partial<RunRecord> = {}): RunRecord {
	return {
		schema: "storm.run/v1",
		runId: `run-20261120-0900${String(n).padStart(2, "0")}-abcd`,
		configHash: "h",
		approvalId: "ap",
		startedAt: `2026-11-20T09:00:${String(n).padStart(2, "0")}.000Z`,
		endedAt: `2026-11-20T09:30:${String(n).padStart(2, "0")}.000Z`,
		status: "done",
		contract: "workflowz",
		task: `task ${n}`,
		costUsd: n,
		costByModel: {},
		spawns: [],
		...extra,
	};
}

/** The janitor at the end of run 5 in this process, cleanup approved in both configs, unless overridden. */
function jan(over: Partial<JanitorInput>) {
	return runJanitor({
		root,
		storeDir,
		sessionsRoot: sessions,
		config: config({ cleanup: true }),
		startConfig: config({ cleanup: true }),
		configHash: null,
		runId: run(5).runId,
		process: processKey(),
		now: Date.now(),
		ledger: [],
		...over,
	});
}

async function touch(file: string, text = "x"): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, text);
}

describe("run index", () => {
	test("summarizes a run, appends, keeps the newest lines and survives pruneRuns", async () => {
		const r = run(1, {
			mainCostUsd: 0.5,
			maxMainContext: 90_000,
			agents: [
				agent("A", { contextTokens: 40_000, review: { reviews: 2, passed: 1, failed: 1, findings: [1, 0, 0, 0], docFindings: 1 } }),
				agent("B", { contextTokens: 70_000 }),
			],
			spawns: [
				{ ts: "t", agent: "storm-implementer", invocationKind: "task", requested: [], outcome: "routed" },
				{ ts: "t", agent: "storm-implementer", invocationKind: "task", requested: [], outcome: "blocked" },
			],
			checkpoints: [{ at: "t", before: 1 }],
			reads: { director: 5, duplicate: 2, blocked: 1 },
		});
		const s = summarizeForIndex(r);
		expect(s).toMatchObject({
			runId: r.runId,
			maxAgentContext: 70_000,
			agents: 2,
			spawns: { total: 2, blocked: 1 },
			reviews: { reviews: 2, passed: 1, failed: 1, docFindings: 1 },
			checkpoints: 1,
			reads: { director: 5, duplicate: 2, blocked: 1 },
		});
		for (let i = 1; i <= 5; i++) {
			await writeRun(root, run(i));
			await appendRunIndex(root, summarizeForIndex(run(i)), 3);
		}
		expect((await readRunIndex(root)).map(x => x.task)).toEqual(["task 3", "task 4", "task 5"]);
		await pruneRuns(root, 1);
		expect(await readRun(root, run(1).runId)).toBeUndefined();
		expect((await readRunIndex(root)).length).toBe(3);
	});

	test("missing index reads empty", async () => {
		expect(await readRunIndex(root)).toEqual([]);
	});
});

describe("janitor omp records", () => {
	const me = processKey();
	const dead = "999999:1";

	/** Records of `id` as omp lays them out, plus outputs and an unrelated file inside its dir. */
	async function seedAgent(id: string): Promise<void> {
		const parts = id.split(".");
		const dir = path.join(artifacts, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(".")));
		for (const suffix of [".jsonl", ".json", ".jsonl.tombstone", ".md"]) await touch(path.join(dir, `${id}${suffix}`), "12345");
		await touch(path.join(dir, id, `${id}.sub.jsonl`));
		await touch(path.join(dir, id, `${id}.sub`, `${id}.sub.x.json`));
		await touch(path.join(dir, id, `${id}.sub`, `${id}.sub.x.md`));
		await touch(path.join(dir, id, "other.jsonl"));
	}

	async function filesUnder(dir: string): Promise<string[]> {
		const out: string[] = [];
		for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
			if (e.isFile()) out.push(path.relative(artifacts, path.join(e.parentPath, e.name)));
		}
		return out.sort();
	}

	/** Trusted runs 1..n in order; run n is the one that just ended. */
	async function trust(runs: Array<{ process: string; agents: string[]; artifactsDir?: string }>): Promise<void> {
		for (const [i, r] of runs.entries()) {
			await recordTrustedRun(storeDir, { runId: run(i + 1).runId, artifactsDir: r.artifactsDir ?? artifacts, process: r.process, agents: r.agents, endedAt: "t" });
		}
	}

	test("keeps the newest 3 runs, skips live agents, cleans parked and other-process agents, keeps .md", async () => {
		for (const id of ["Old", "P", "P.Q", "Live", "Recent", "Gone", "Anna", "Nest"]) await seedAgent(id);
		await seedAgent("Nest.Kid");
		// Run 1: dead process. Run 2: this process. Runs 3-5 are recent.
		await trust([
			{ process: dead, agents: ["Old", "Anna", "Nest", "local", "Missing"] },
			{ process: me, agents: ["P", "Live", "Gone"] },
			{ process: dead, agents: ["Recent"] },
			{ process: dead, agents: [] },
			{ process: me, agents: [] },
		]);
		await writeRun(root, run(1, { agents: [agent("Old")] }));
		await touch(path.join(artifacts, "local", "local.jsonl"));
		// Anna (from a dead-process run) is live here now; Nest has a live child.
		const ledger = [agent("P"), agent("Live", { state: "idle" }), agent("Anna", { state: "idle" }), agent("Nest.Kid", { state: "running" })];
		const { result, cleaned } = await jan({ ledger, now: 42 });
		// Gone is absent from the ledger: parked long ago. Only this process's ids come back for the ledger.
		expect(cleaned.sort()).toEqual(["Gone", "P"]);
		expect(result.agents).toBe(3);
		const left = await filesUnder(artifacts);
		for (const id of ["Old", "P", "Live", "Recent", "Gone"]) expect(left).toContain(`${id}.md`);
		expect(left).toContain(path.join("P", "P.Q.md"));
		expect(left).toContain(path.join("Old", "Old.sub", "Old.sub.x.md"));
		expect(left).toContain(path.join("Old", "other.jsonl"));
		for (const gone of ["Old.jsonl", "Old.json", "Old.jsonl.tombstone", path.join("Old", "Old.sub.jsonl"), path.join("Old", "Old.sub", "Old.sub.x.json"), path.join("P", "P.Q.jsonl")]) {
			expect(left).not.toContain(gone);
		}
		for (const kept of ["Live.jsonl", "Recent.jsonl", "Anna.jsonl", "Nest.jsonl", path.join("local", "local.jsonl")]) expect(left).toContain(kept);
		expect(result.bytes).toBeGreaterThan(0);
		const trusted = await readTrustedRuns(storeDir);
		expect(trusted[0]?.cleaned).toEqual(["Old"]);
		expect(trusted[1]?.cleaned?.sort()).toEqual(["Gone", "P"]);
		expect((await readRun(root, run(1).runId))?.agents?.[0]?.cleanedAt).toBe(42);

		// A second pass finds nothing more; re-recording a run keeps its cleaned ids.
		await recordTrustedRun(storeDir, { runId: run(1).runId, artifactsDir: artifacts, process: dead, agents: ["Old"], endedAt: "t" });
		const again = await jan({ ledger, now: 50 });
		expect(again.cleaned).toEqual([]);
		expect(again.result.agents).toBe(0);
	});

	test("deletion paths come only from the trusted list, never from repo run records", async () => {
		const victim = path.join(tmp, "repo-files");
		await touch(path.join(victim, "package.json"));
		for (let n = 1; n <= 5; n++) await writeRun(root, run(n, { artifactsDir: victim, process: dead, agents: [agent("package")] }));
		const { result } = await jan({});
		expect(result.agents).toBe(0);
		expect(existsSync(path.join(victim, "package.json"))).toBe(true);
	});

	test("an artifacts dir outside sessionsRoot or without its session transcript is refused", async () => {
		const outside = path.join(tmp, "elsewhere");
		await touch(path.join(outside, "A.jsonl"));
		await touch(`${outside}.jsonl`);
		const bare = path.join(sessions, "bare");
		await touch(path.join(bare, "B.jsonl"));
		await trust([
			{ process: dead, agents: ["A"], artifactsDir: outside },
			{ process: dead, agents: ["B"], artifactsDir: bare },
			{ process: dead, agents: [] },
			{ process: dead, agents: [] },
			{ process: me, agents: [] },
		]);
		const { result } = await jan({});
		expect(result.agents).toBe(0);
		expect(existsSync(path.join(outside, "A.jsonl"))).toBe(true);
		expect(existsSync(path.join(bare, "B.jsonl"))).toBe(true);
	});

	test("omp records go only when both the start config and the config in force have cleanup on", async () => {
		await seedAgent("Old");
		await trust([{ process: dead, agents: ["Old"] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: me, agents: [] }]);
		for (const [cfg, start] of [
			[config(), config()],
			[config({ cleanup: false }), config({ cleanup: true })],
			[config({ cleanup: true }), config()],
		] as const) {
			const { cleaned, result } = await jan({ config: cfg, startConfig: start });
			expect(cleaned).toEqual([]);
			expect(result.files).toBe(0);
		}
		expect(existsSync(path.join(artifacts, "Old.jsonl"))).toBe(true);
	});

	test("never follows symlinks out of the artifacts dir and rejects path-like ids", async () => {
		const outside = path.join(tmp, "outside");
		await touch(path.join(outside, "X.X.jsonl"));
		await touch(path.join(outside, "X.jsonl"));
		await mkdir(path.join(artifacts, "X"), { recursive: true });
		await symlink(outside, path.join(artifacts, "X", "X.link"));
		await symlink(path.join(outside, "X.jsonl"), path.join(artifacts, "X.jsonl"));
		await symlink(outside, path.join(artifacts, "Y"));
		expect(await agentRecordFiles(artifacts, "X")).toEqual([]);
		expect(await agentRecordFiles(artifacts, "Y.Z")).toEqual([]);
		expect(await agentRecordFiles(artifacts, "../outside/X")).toEqual([]);
		await trust([{ process: dead, agents: ["X", "Y.Z"] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: me, agents: [] }]);
		const { result } = await jan({});
		expect(result.agents).toBe(0);
		expect(existsSync(path.join(outside, "X.X.jsonl"))).toBe(true);
		expect(existsSync(path.join(outside, "X.jsonl"))).toBe(true);
	});

	test("the trusted list keeps its newest 200 runs", async () => {
		for (let n = 0; n < 205; n++) await recordTrustedRun(storeDir, { runId: `run-${n}`, artifactsDir: artifacts, process: me, agents: [], endedAt: "t" });
		const runs = await readTrustedRuns(storeDir);
		expect(runs.length).toBe(200);
		expect(runs[0]?.runId).toBe("run-5");
	});

	test("storage line counts remaining records and the last cleanup", async () => {
		await seedAgent("Old");
		await trust([{ process: dead, agents: ["Old"] }]);
		await writeRun(root, run(2, { cleanup: { agents: 3, files: 9, bytes: 3 * 1024 * 1024, stormFiles: 2 } }));
		const view = await readStorage(root, storeDir, sessions);
		expect(view.ompFiles).toBe(5);
		expect(view.ompBytes).toBe(3 * 5 + 1 + 1);
		expect(view.stormBytes).toBeGreaterThan(0);
		const line = formatStorage(view, false);
		expect(line).toContain("파일 5개, 자동 정리 꺼짐");
		expect(line).toContain("에이전트 3개 3MB");
		expect(line.includes("\n")).toBe(false);
		expect([bytesText(512), bytesText(512 * 1024), bytesText(38 * 1024 ** 2), bytesText(1.3 * 1024 ** 3)]).toEqual(["512B", "512KB", "38MB", "1.3GB"]);
	});

	test("markAgentsCleaned marks ledger entries", () => {
		noteAgentStart({ id: "A", name: "storm-quick", now: 1, revive: false });
		noteAgentParked("A");
		markAgentsCleaned(["A", "missing"], 7);
		expect(listAgents()[0]?.cleanedAt).toBe(7);
	});
});

describe("Storm limits", () => {
	const hash = (n: number): string => `jcs-sha256:${n.toString(16).padStart(64, "0")}`;

	test("approvals keep the current hash plus the newest 20; the log keeps its newest 2000 lines", async () => {
		const store = new ApprovalStore(path.join(tmp, "base"), { repoId: "git-x", kind: "git-common-dir" } as ConstructorParameters<typeof ApprovalStore>[1]);
		for (let n = 1; n <= 23; n++) {
			await store.approve({ configHash: hash(n), rawSha256: "r", config: config(), scope: { shadowedAgents: [] } as never, via: "test", ompVersion: "1", supersedes: null });
		}
		const logFile = path.join(store.dir, "log.jsonl");
		const extra = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ ts: "t", event: "x", n: i })).join("\n");
		await writeFile(logFile, `${await readFile(logFile, "utf8")}${extra}\n`);
		const { result } = await jan({ configHash: hash(1), approvals: store });
		// 23 hashes, keep 1 (current, oldest) + newest 20 → hashes 2 and 3 go, each with approved record and snapshot.
		expect(result.stormFiles).toBe(4);
		expect(await store.snapshot(hash(1))).toBeDefined();
		expect(await store.snapshot(hash(2))).toBeUndefined();
		expect(await store.snapshot(hash(3))).toBeUndefined();
		expect(await store.snapshot(hash(4))).toBeDefined();
		const log = await store.log();
		expect(log.length).toBe(2000);
		expect(log.at(-1)).toMatchObject({ n: 2099 });
	});

	test("prune of a repo without approvals creates nothing", async () => {
		const store = new ApprovalStore(path.join(tmp, "base"), { repoId: "git-y", kind: "git-common-dir" } as ConstructorParameters<typeof ApprovalStore>[1]);
		expect(await store.prune(null)).toBe(0);
		expect(existsSync(store.dir)).toBe(false);
	});

	test("trial counters outside config.trials and proposals older than 30 days are removed", async () => {
		await updateTrialState(root, "keep", s => ({ ...s, seen: 1 }));
		await updateTrialState(root, "gone", s => ({ ...s, seen: 1 }));
		const now = Date.parse("2026-11-21T00:00:00.000Z");
		const proposals = createProposalStore(root, async () => "h");
		const proposal = (id: string, days: number) => ({
			schema: "storm.proposal/v1" as const,
			id,
			kind: "trial" as const,
			createdAt: new Date(now - days * 86_400_000).toISOString(),
			summary: id,
			baseHash: "h",
			config: config(),
		});
		await proposals.save(proposal("old", 31));
		await proposals.save(proposal("new", 29));
		// Counters of trials in either the start config or the config in force stay.
		const trial = (id: string) => ({ id, role: "implementer", model: "a/x" }) as unknown as NonNullable<StormConfig["trials"]>[number];
		await updateTrialState(root, "start", s => ({ ...s, seen: 1 }));
		const { result } = await jan({ config: config({ trials: [trial("keep")] }), startConfig: config({ trials: [trial("start")] }), now });
		expect(result.stormFiles).toBe(2);
		expect(Object.keys(await readTrialStates(root)).sort()).toEqual(["keep", "start"]);
		expect((await proposals.list()).map(p => p.id)).toEqual(["new"]);
		expect(await pruneTrialStates(root, ["keep", "start"])).toBe(0);
		expect(await pruneProposals(root, now)).toBe(0);
	});
});
