import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetAgents } from "../src/runtime/agents.ts";
import { agentRecordFiles, bytesText, formatStorage, formatStorageDetail, storageDetailLines, type JanitorInput, processKey, readStorage, readTrustedRuns, recordTrustedRun, runJanitor } from "../src/runtime/janitor.ts";
import { appendRunIndex, readRunIndex, summarizeForIndex } from "../src/runtime/run-index.ts";
import { pruneRuns, readRun, writeRun } from "../src/runtime/run.ts";
import { pruneTrialStates, readTrialStates, updateTrialState } from "../src/runtime/state-files.ts";
import type { AgentEntry, RunRecord, StormConfig } from "../src/types.ts";
import { agentEntry, DEAD_PROCESS, runRecord, teamOf } from "./fixtures.ts";

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

const config = (extra: Partial<StormConfig> = {}): StormConfig => teamOf({ implementer: "a/i" }, extra);

function agent(id: string, extra: Partial<AgentEntry> = {}): AgentEntry {
	return agentEntry({ id, state: "parked", ...extra });
}

function run(n: number, extra: Partial<RunRecord> = {}): RunRecord {
	return runRecord({
		runId: `run-20261120-0900${String(n).padStart(2, "0")}-abcd`,
		startedAt: `2026-11-20T09:00:${String(n).padStart(2, "0")}.000Z`,
		endedAt: `2026-11-20T09:30:${String(n).padStart(2, "0")}.000Z`,
		task: `task ${n}`,
		costUsd: n,
		...extra,
	});
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
			reads: { director: 5, directorChars: 5000, duplicateChars: 2000, blocked: 1 },
		});
		const s = summarizeForIndex(r);
		expect(s).toMatchObject({
			runId: r.runId,
			maxAgentContext: 70_000,
			agents: 2,
			spawns: { total: 2, blocked: 1 },
			reviews: { reviews: 2, passed: 1, failed: 1, docFindings: 1 },
			checkpoints: 1,
			reads: { director: 5, directorChars: 5000, duplicateChars: 2000, blocked: 1 },
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
	const dead = DEAD_PROCESS;

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

		// Re-recording a run keeps its cleaned ids, and a second pass finds nothing more.
		await recordTrustedRun(storeDir, { runId: run(1).runId, artifactsDir: artifacts, process: dead, agents: ["Old"], endedAt: "t" });
		expect((await readTrustedRuns(storeDir))[0]?.cleaned).toEqual(["Old"]);
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

	test("another omp process that is still alive keeps its agents' records; once it is gone they are cleaned", async () => {
		const other = "4242:1700000000000";
		for (const id of ["Theirs", "Mine"]) await seedAgent(id);
		await trust([
			{ process: other, agents: ["Theirs"] },
			{ process: me, agents: ["Mine"] },
			{ process: other, agents: [] },
			{ process: other, agents: [] },
			{ process: me, agents: [] },
		]);
		const asked: string[] = [];
		const live = await jan({
			alive: key => {
				asked.push(key);
				return true;
			},
		});
		// Only other processes are probed; this process's own old run is judged by the ledger.
		expect(asked).toEqual([other]);
		expect(live.cleaned).toEqual(["Mine"]);
		expect(live.result.agents).toBe(1);
		expect(existsSync(path.join(artifacts, "Theirs.jsonl"))).toBe(true);
		expect((await readTrustedRuns(storeDir))[0]?.cleaned).toBeUndefined();

		const gone = await jan({ alive: () => false });
		expect(gone.result.agents).toBe(1);
		// Cleaned for another process's run: nothing to mark in this process's ledger.
		expect(gone.cleaned).toEqual([]);
		expect(existsSync(path.join(artifacts, "Theirs.jsonl"))).toBe(false);
		expect(existsSync(path.join(artifacts, "Theirs.md"))).toBe(true);
		expect((await readTrustedRuns(storeDir))[0]?.cleaned).toEqual(["Theirs"]);
	});

	test("never follows symlinks out of the artifacts dir and rejects path-like ids", async () => {
		const outside = path.join(tmp, "outside");
		for (const name of ["X.X.jsonl", "X.jsonl", "Y.Z.jsonl"]) await touch(path.join(outside, name));
		await mkdir(path.join(artifacts, "X"), { recursive: true });
		await symlink(outside, path.join(artifacts, "X", "X.link"));
		await symlink(path.join(outside, "X.jsonl"), path.join(artifacts, "X.jsonl"));
		// A nested id whose parent directory is a link out of the artifacts dir.
		await symlink(outside, path.join(artifacts, "Y"));
		// A real record in a subdirectory: an id is a name, never a path to it.
		await touch(path.join(artifacts, "nested", "N.jsonl"));
		expect(await agentRecordFiles(artifacts, "X")).toEqual([]);
		expect(await agentRecordFiles(artifacts, "Y.Z")).toEqual([]);
		expect(await agentRecordFiles(artifacts, "../outside/X")).toEqual([]);
		expect(await agentRecordFiles(artifacts, "nested/N")).toEqual([]);
		await trust([{ process: dead, agents: ["X", "Y.Z", "nested/N"] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: me, agents: [] }]);
		const { result } = await jan({});
		expect(result.agents).toBe(0);
		for (const name of ["X.X.jsonl", "X.jsonl", "Y.Z.jsonl"]) expect(existsSync(path.join(outside, name))).toBe(true);
		expect(existsSync(path.join(artifacts, "nested", "N.jsonl"))).toBe(true);
	});

	test("the run that just ended is never cleaned, even when the list records it as old", async () => {
		await seedAgent("Mine");
		// Run 5 was first recorded long ago (a resumed session re-records in place), with four newer runs after it.
		await recordTrustedRun(storeDir, { runId: run(5).runId, artifactsDir: artifacts, process: dead, agents: ["Mine"], endedAt: "t" });
		await trust([{ process: dead, agents: [] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: dead, agents: [] }]);
		const { result } = await jan({});
		expect(result.agents).toBe(0);
		expect(existsSync(path.join(artifacts, "Mine.jsonl"))).toBe(true);
	});

	test("an agent whose records could not all be removed is not marked cleaned and is retried at the next run end", async () => {
		// A read-only directory refuses the unlink; root ignores directory modes, so the case cannot be staged there.
		if (process.getuid?.() === 0) return;
		await seedAgent("Old");
		await trust([{ process: me, agents: ["Old"] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: dead, agents: [] }, { process: me, agents: [] }]);
		const locked = path.join(artifacts, "Old");
		await chmod(locked, 0o555);
		try {
			const first = await jan({});
			expect(first.result.agents).toBe(0);
			expect(first.cleaned).toEqual([]);
			// What could be removed was, and is counted: every record but the one in the locked directory.
			expect(first.result.files).toBe(4);
			expect(existsSync(path.join(locked, "Old.sub.jsonl"))).toBe(true);
			expect((await readTrustedRuns(storeDir))[0]?.cleaned).toBeUndefined();
		} finally {
			await chmod(locked, 0o755);
		}
		const second = await jan({});
		expect(second.result.agents).toBe(1);
		expect(second.cleaned).toEqual(["Old"]);
		expect(existsSync(path.join(locked, "Old.sub.jsonl"))).toBe(false);
	});

	test("a trusted line with a relative artifacts dir is not trusted", async () => {
		await recordTrustedRun(storeDir, { runId: "run-abs", artifactsDir: artifacts, process: me, agents: [], endedAt: "t" });
		const line = JSON.stringify({ runId: "run-rel", artifactsDir: "sessions/proj/sess", process: me, agents: ["A"], endedAt: "t" });
		await writeFile(path.join(storeDir, "runs.jsonl"), `${line}\n{ torn\n`, { flag: "a" });
		expect((await readTrustedRuns(storeDir)).map(r => r.runId)).toEqual(["run-abs"]);
	});

	test("the trusted list keeps its newest 200 runs", async () => {
		for (let n = 0; n < 205; n++) await recordTrustedRun(storeDir, { runId: `run-${n}`, artifactsDir: artifacts, process: me, agents: [], endedAt: "t" });
		const runs = await readTrustedRuns(storeDir);
		expect(runs.length).toBe(200);
		expect(runs[0]?.runId).toBe("run-5");
	});

	test("storage line counts distinct records, the last cleanup, and labels protection", async () => {
		await seedAgent("Old");
		await trust([{ process: dead, agents: ["Old"] }]);
		await writeRun(root, run(2, { cleanup: { agents: 3, files: 9, bytes: 3 * 1024 * 1024, stormFiles: 2 } }));
		const view = await readStorage(root, storeDir, sessions, { cleanup: true });
		// Old.jsonl + Old/Old.sub.jsonl; the .json and .jsonl.tombstone + Old.sub.x.json are sidecars. ".md"/other are not records.
		expect(view.total).toEqual({ transcripts: { files: 2, bytes: 6 }, sidecars: { files: 3, bytes: 11 } });
		// The only trusted run is among the newest three: all of its records are protected, none is a candidate.
		expect(view.groups.recent).toEqual(view.total);
		expect(view.groups.candidate).toEqual({ transcripts: { files: 0, bytes: 0 }, sidecars: { files: 0, bytes: 0 } });
		expect(view.stormBytes).toBeGreaterThan(0);
		const line = formatStorage(view, false);
		// The numbers are on the line; a team without cleanup consent gets a longer one that says so.
		for (const part of [bytesText(17), "5개", "3MB"]) expect(line).toContain(part);
		expect(formatStorage(view, true).length).toBeLessThan(line.length);
		expect(line.includes("\n")).toBe(false);
		const detail = formatStorageDetail(view, true).join("\n");
		expect(detail).toContain("최근 3개 실행 보호");
		expect(detail).toContain("마지막 정리");
		expect(detail).toContain("3MB");
		expect([bytesText(512), bytesText(512 * 1024), bytesText(38 * 1024 ** 2), bytesText(1.3 * 1024 ** 3)]).toEqual(["512B", "512KB", "38MB", "1.3GB"]);
	});
});

describe("storage inventory", () => {
	const me = processKey();
	const dead = DEAD_PROCESS;

	async function writeRecord(relative: string, text: string): Promise<void> {
		const file = path.join(artifacts, ...relative.split("/"));
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, text);
	}

	async function trustRuns(runs: Array<{ process: string; agents: string[]; artifactsDir?: string }>): Promise<void> {
		for (const [i, r] of runs.entries()) {
			await recordTrustedRun(storeDir, { runId: run(i + 1).runId, artifactsDir: r.artifactsDir ?? artifacts, process: r.process, agents: r.agents, endedAt: "t" });
		}
	}

	test("counts each physical record once and separates recent, candidates, unknown, parent and spill", async () => {
		await writeFile(`${artifacts}.jsonl`, "P".repeat(101));
		// A parent transcript with no artifact folder is still parent storage, never a child record.
		await writeFile(path.join(sessions, "proj", "lonely.jsonl"), "L".repeat(11));
		await writeRecord("Old.jsonl", "o".repeat(100));
		await writeRecord("Old.json", "a".repeat(10));
		await writeRecord("Old/Old.sub.jsonl", "n".repeat(50));
		// Not the cumulative id directory its name implies: not an omp child record, so not inventory.
		await writeRecord("Old/other.jsonl", "ignored");
		await writeRecord("Mid.jsonl", "m".repeat(30));
		await writeRecord("Recent.jsonl", "r".repeat(20));
		await writeRecord("Recent.json", "s".repeat(5));
		await writeRecord("Legacy.jsonl", "l".repeat(7));
		await writeRecord("Legacy.jsonl.tombstone", "t".repeat(3));
		await writeRecord("Orphan/Orphan.child.jsonl", "c".repeat(9));
		await writeRecord("local/7.log", "S".repeat(40));
		await writeRecord("local/notes.md", "not a record");
		await trustRuns([
			// Reused and nested ids: the same physical Old.sub record must be counted once.
			{ process: dead, agents: ["Old", "Old.sub", "Old"] },
			{ process: dead, agents: ["Old", "Mid"] },
			{ process: dead, agents: [] },
			{ process: dead, agents: ["Recent"] },
			{ process: dead, agents: ["Recent"] },
			{ process: dead, agents: ["Recent"] },
		]);
		const view = await readStorage(root, storeDir, sessions, { cleanup: true, sessionDir: path.join(sessions, "proj"), alive: () => false });
		expect(view.total).toEqual({ transcripts: { files: 6, bytes: 216 }, sidecars: { files: 3, bytes: 18 } });
		expect(view.groups.recent).toEqual({ transcripts: { files: 1, bytes: 20 }, sidecars: { files: 1, bytes: 5 } });
		expect(view.groups.candidate).toEqual({ transcripts: { files: 3, bytes: 180 }, sidecars: { files: 1, bytes: 10 } });
		expect(view.groups.unknown).toEqual({ transcripts: { files: 2, bytes: 16 }, sidecars: { files: 1, bytes: 3 } });
		expect(view.groups.live).toEqual({ transcripts: { files: 0, bytes: 0 }, sidecars: { files: 0, bytes: 0 } });
		// Parent transcripts and local spill are measured apart and never enter a candidate's bytes.
		expect(view.parent).toEqual({ files: 2, bytes: 112 });
		expect(view.spill).toEqual({ files: 1, bytes: 40 });
		expect(view.gaps).toEqual({ sessionsRoot: false, project: true, staleSessions: 0, trustRoots: 0, roots: 0, entries: 0, symlinks: 0, scanned: 1 });
		const detail = formatStorageDetail(view, true).join("\n");
		for (const part of ["최근 3개 실행 보호", "정리 후보", "소유 미상", "자동 삭제하지 않음", "상위 세션 전사", "세션 spill", "정리 대상 아님"]) expect(detail).toContain(part);
		expect(detail).not.toContain(tmp);
		const tags = storageDetailLines(view, true);
		expect(tags.find(line => line.text.startsWith("소유 미상"))?.warning).toBe(true);
		expect(tags.find(line => line.text.startsWith("정리 후보"))?.warning).toBeUndefined();
		expect(tags.find(line => line.text.startsWith("최근 3개 실행 보호"))?.warning).toBeUndefined();
		const line = formatStorage(view, true);
		for (const part of ["정리 후보 4개 190B", "소유 미상 3개 19B", "omp 자식 기록 9개 234B"]) expect(line).toContain(part);
	});

	test("live and same-process records are protected or unclassified, never candidates", async () => {
		await writeRecord("Live.jsonl", "l".repeat(10));
		await writeRecord("Mine.jsonl", "m".repeat(20));
		await writeRecord("Old.jsonl", "o".repeat(30));
		const live = "8888:1";
		await trustRuns([
			{ process: live, agents: ["Live"] },
			{ process: me, agents: ["Mine"] },
			{ process: dead, agents: ["Old"] },
			{ process: dead, agents: [] },
			{ process: dead, agents: [] },
			{ process: dead, agents: [] },
		]);
		const on = await readStorage(root, storeDir, sessions, { cleanup: true, sessionDir: path.join(sessions, "proj"), alive: key => key === live });
		expect(on.groups.live.transcripts).toEqual({ files: 1, bytes: 10 });
		expect(on.groups.unclassified.transcripts).toEqual({ files: 1, bytes: 20 });
		expect(on.groups.candidate.transcripts).toEqual({ files: 1, bytes: 30 });
		expect(on.unclassifiedReasons).toEqual({ sameProcess: 1, cleaned: 0, other: 0 });
		// The two live/same-process protections remain; with cleanup off the older dead run is unclassified too.
		const off = await readStorage(root, storeDir, sessions, { cleanup: false, sessionDir: path.join(sessions, "proj"), alive: key => key === live });
		expect(off.groups.live.transcripts.files).toBe(1);
		expect(off.groups.candidate.transcripts.files).toBe(0);
		expect(off.groups.unclassified.transcripts.files).toBe(2);
		expect(formatStorageDetail(off, false).join("\n")).toContain("자동 정리가 꺼져 있음");
	});

	test("cleanup off alone is never a storage warning; an unknown owner is", async () => {
		await writeRecord("Old.jsonl", "o".repeat(10));
		await writeRecord("Orphan/Orphan.child.jsonl", "x".repeat(5));
		await trustRuns([
			{ process: dead, agents: ["Old"] },
			{ process: dead, agents: [] },
			{ process: dead, agents: [] },
			{ process: dead, agents: [] },
		]);
		const view = await readStorage(root, storeDir, sessions, { cleanup: false, sessionDir: path.join(sessions, "proj") });
		const tags = storageDetailLines(view, false);
		const pending = tags.find(entry => entry.text.startsWith("판단 보류"))!;
		expect(pending.text).toContain("정리 꺼짐");
		expect(pending.warning).toBeUndefined();
		expect(tags.find(entry => entry.text.startsWith("정리 후보: 없음"))?.warning).toBeUndefined();
		expect(tags.find(entry => entry.text.startsWith("소유 미상"))?.warning).toBe(true);
	});

	test("stale, missing and outside roots are gaps, never measured zeros", async () => {
		const missing = path.join(sessions, "proj", "gone");
		const outside = path.join(tmp, "outside", "sess");
		await mkdir(outside, { recursive: true });
		await writeFile(`${outside}.jsonl`, "");
		await trustRuns([
			{ process: dead, agents: [], artifactsDir: missing },
			{ process: dead, agents: [], artifactsDir: outside },
		]);
		const stale = await readStorage(root, storeDir, sessions, { cleanup: true });
		expect(stale.gaps.trustRoots).toBe(2);
		expect(stale.gaps.currentSession).toBe("unnamed");
		expect(stale.gaps.scanned).toBe(0);
		const line = formatStorage(stale, true);
		expect(line).toContain("측정 불가");
		expect(line).not.toContain("omp 자식 기록 0");
		const detail = formatStorageDetail(stale, true).join("\n");
		expect(detail).toContain("실행 목록의 세션 폴더 2곳 사용 불가");
		expect(detail).toContain("현재 세션 폴더 미지정");
		expect(detail).toContain("마지막 정리 없음");
		const tags = storageDetailLines(stale, true);
		expect(tags.find(entry => entry.text.startsWith("omp 자식 기록: 측정 불가"))?.warning).toBe(true);
		expect(tags.find(entry => entry.text.startsWith("마지막 정리 없음"))?.warning).toBeUndefined();

		const noRoot = await readStorage(root, storeDir, path.join(tmp, "agent", "absent"), { cleanup: true });
		expect(noRoot.gaps.sessionsRoot).toBe(true);
		expect(formatStorage(noRoot, true)).toContain("측정 불가");
	});

	test("a session folder without its regular parent transcript is excluded and marked", async () => {
		await rm(`${artifacts}.jsonl`);
		await writeRecord("Old.jsonl", "x");
		await trustRuns([{ process: dead, agents: ["Old"] }]);
		const view = await readStorage(root, storeDir, sessions, { cleanup: true, sessionDir: path.join(sessions, "proj") });
		expect(view.gaps.trustRoots).toBe(1);
		expect(view.gaps.staleSessions).toBe(1);
		expect(view.gaps.currentSession).toBeUndefined();
		expect(view.total.transcripts.files).toBe(0);
		expect(formatStorage(view, true)).toContain("일부 누락");
		expect(formatStorageDetail(view, true).join("\n")).toContain("상위 세션 기록이 없는 폴더 1곳 제외");
		const tags = storageDetailLines(view, true);
		expect(tags.find(entry => entry.text.startsWith("집계 누락"))?.warning).toBe(true);
		expect(tags.find(entry => entry.text.startsWith("상위 세션 전사"))?.warning).toBeUndefined();
	});

	test("symlinks are never followed and unreadable directories are counted as gaps", async () => {
		await writeRecord("Visible.jsonl", "v".repeat(4));
		const outside = path.join(tmp, "outside.jsonl");
		await writeFile(outside, "x".repeat(50));
		await symlink(outside, path.join(artifacts, "Link.jsonl"));
		const linkedRoot = path.join(sessions, "otherproj", "link-sess");
		await mkdir(path.dirname(linkedRoot), { recursive: true });
		await symlink(artifacts, linkedRoot);
		await writeFile(`${linkedRoot}.jsonl`, "");
		await trustRuns([{ process: dead, agents: [], artifactsDir: linkedRoot }]);
		await writeRecord("Blocked/Blocked.child.jsonl", "b".repeat(8));
		await chmod(path.join(artifacts, "Blocked"), 0o000);
		try {
			const view = await readStorage(root, storeDir, sessions, { cleanup: true, sessionDir: path.join(sessions, "proj") });
			expect(view.total.transcripts).toEqual({ files: 1, bytes: 4 });
			expect(view.gaps.trustRoots).toBe(1);
			expect(view.gaps.entries).toBe(1);
			expect(view.gaps.symlinks).toBe(1);
			const detail = formatStorageDetail(view, true).join("\n");
			expect(detail).toContain("심볼릭 링크 1개 건너뜀");
			expect(detail).toContain("하위 항목 1곳 읽기 실패");
		} finally {
			await chmod(path.join(artifacts, "Blocked"), 0o755);
		}
	});
});

describe("stale run records", () => {
	const other = "4242:1700000000000";
	const running = (n: number, extra: Partial<RunRecord>): RunRecord => {
		const { endedAt: _endedAt, ...record } = run(n, { status: "running", ...extra });
		return record;
	};

	test("a running record whose process is gone becomes stopped, ended at its last live write; live ones stay", async () => {
		await writeRun(root, running(1, { process: other, updatedAt: "2026-11-20T09:10:00.000Z", costUsd: 1.5 }));
		await writeRun(root, running(2, { process: "4343:1" }));
		await writeRun(root, running(3, { process: "4444:1" }));
		// The run that is ending now is still `running` on disk: the janitor leaves it to its controller.
		await writeRun(root, running(5, { process: processKey() }));
		await jan({ config: config(), startConfig: config(), alive: key => key === "4444:1" });
		expect(await readRun(root, run(1).runId)).toMatchObject({ status: "stopped", endedAt: "2026-11-20T09:10:00.000Z", costUsd: 1.5 });
		// Never rewritten live: it ended, as far as anyone knows, when it started.
		expect(await readRun(root, run(2).runId)).toMatchObject({ status: "stopped", endedAt: run(2).startedAt });
		expect((await readRun(root, run(3).runId))?.status).toBe("running");
		expect((await readRun(root, run(5).runId))?.status).toBe("running");
	});

	test("an older running record of this very process, or one without a process, is stale too; finished records are untouched", async () => {
		const { process: _process, ...unowned } = running(2, {});
		await writeRun(root, running(1, { process: processKey() }));
		await writeRun(root, unowned);
		await writeRun(root, run(3, { process: other }));
		await jan({ config: config(), startConfig: config(), alive: () => true });
		expect((await readRun(root, run(1).runId))?.status).toBe("stopped");
		expect((await readRun(root, run(2).runId))?.status).toBe("stopped");
		expect(await readRun(root, run(3).runId)).toEqual(run(3, { process: other }));
	});
});

describe("Storm limits", () => {
	test("the approval store prunes around the hash in force and its count joins the result", async () => {
		const asked: Array<string | null> = [];
		const approvals = {
			prune: async (keepHash: string | null) => {
				asked.push(keepHash);
				return 4;
			},
		};
		expect((await jan({ configHash: "jcs-sha256:abc", approvals })).result.stormFiles).toBe(4);
		expect((await jan({ approvals })).result.stormFiles).toBe(4);
		expect(asked).toEqual(["jcs-sha256:abc", null]);
	});

	test("trial counters outside both configs' trials are removed", async () => {
		for (const id of ["keep", "gone", "start"]) await updateTrialState(root, id, s => ({ ...s, seen: 1 }));
		// Counters of trials in either the start config or the config in force stay.
		const trial = (id: string) => ({ id, role: "implementer", model: "a/x" }) as unknown as NonNullable<StormConfig["trials"]>[number];
		const { result } = await jan({ config: config({ trials: [trial("keep")] }), startConfig: config({ trials: [trial("start")] }) });
		expect(result.stormFiles).toBe(1);
		expect(Object.keys(await readTrialStates(root)).sort()).toEqual(["keep", "start"]);
		expect(await pruneTrialStates(root, ["keep", "start"])).toBe(0);
	});

	test("directories of retired features are removed: deferred proposals and the usage archive", async () => {
		const agentDir = path.join(tmp, "agent");
		const proposals = path.join(root, ".omp", "storm", "state", "proposals");
		const usage = path.join(agentDir, "storm", "usage");
		await touch(path.join(proposals, "p1.json"));
		await touch(path.join(usage, "2026-10.jsonl"));
		await touch(path.join(agentDir, "storm", "approvals", "git-x", "runs.jsonl"), "");
		// Without the agent dir only the project's own leftovers go.
		expect((await jan({})).result.stormFiles).toBe(1);
		expect(existsSync(proposals)).toBe(false);
		expect(existsSync(usage)).toBe(true);
		expect((await jan({ agentDir })).result.stormFiles).toBe(1);
		expect(existsSync(usage)).toBe(false);
		expect(existsSync(path.join(agentDir, "storm", "approvals", "git-x", "runs.jsonl"))).toBe(true);
		// Nothing left: nothing counted, nothing created.
		expect((await jan({ agentDir })).result.stormFiles).toBe(0);
		expect(existsSync(proposals)).toBe(false);
	});
});
