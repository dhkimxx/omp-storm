import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { approveAndSave, type FlowEnv, resetFlow } from "../src/flows.ts";
import { deriveScope } from "../src/interview/setup.ts";
import { loadProjectState } from "../src/state.ts";
import { appendRunIndex, readRunIndex } from "../src/runtime/run-index.ts";
import type { Exec, RunRecord, RunSummary, StormConfig, UiPort } from "../src/types.ts";

const exec: Exec = async (command, args, options) => {
	const p = Bun.spawn([command, ...args], {
		...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { stdout, stderr, code };
};

async function git(cwd: string, ...args: string[]): Promise<void> {
	const res = await exec("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
	if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

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

let tmp: string;
let project: string;
let env: FlowEnv;

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-reset-")));
	project = path.join(tmp, "project");
	await mkdir(project);
	await git(project, "init", "-q");
	env = {
		cwd: project,
		exec,
		agentDir: path.join(tmp, "agent"),
		pluginAgentsDir: path.join(tmp, "plugin-agents"),
		ompBin: "omp",
		ompVersion: "19.0.1",
		mode: "test",
		registry: { getAll: () => [], getAvailable: () => [] },
		activeTools: [],
		now: Date.now,
	};
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

const stormDir = () => path.join(project, ".omp", "storm");

/** An approved team plus an unrelated file under .omp/; returns this repo's approval directory. */
async function seed(): Promise<string> {
	const state = await loadProjectState(env);
	await approveAndSave(env, state, config, deriveScope(config, []));
	await writeFile(path.join(project, ".omp", "other.txt"), "keep\n");
	return state.store.dir;
}

async function approvals(): Promise<number> {
	return (await (await loadProjectState(env)).store.list()).length;
}

function scriptedUi(answers: Array<string | undefined>) {
	const selects: Array<{ title: string; options: string[] }> = [];
	const notes: string[] = [];
	const contexts: string[] = [];
	const ui: UiPort = {
		async select(title, options, context) {
			selects.push({ title, options: options.map(o => (typeof o === "string" ? o : o.label)) });
			if (context) contexts.push(context.markdown);
			return answers.shift();
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify(message) {
			notes.push(message);
		},
		async report() {},
		record() {},
	};
	return { ui, selects, notes, contexts };
}

describe("/storm reset", () => {
	test("one confirmation deletes .omp/storm and this repo's approvals; other repos and other .omp files stay", async () => {
		const dir = await seed();
		const other = path.join(path.dirname(dir), "git-other-000000000000000000000000");
		await mkdir(other, { recursive: true });
		await writeFile(path.join(other, "log.jsonl"), "");
		const f = scriptedUi(["초기화"]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(f.selects.map(s => s.options)).toEqual([["초기화", "취소"]]);
		expect(existsSync(stormDir())).toBe(false);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(path.join(other, "log.jsonl"))).toBe(true);
		expect(existsSync(path.join(project, ".omp", "other.txt"))).toBe(true);
		expect(f.notes.at(-1)).toContain("승인 1건");
	});

	test("nothing is deleted unless 초기화 is chosen", async () => {
		await seed();
		for (const answer of [undefined, "취소", "네"]) {
			const f = scriptedUi([answer]);
			expect(await resetFlow(env, f.ui)).toBe(false);
			expect(existsSync(path.join(stormDir(), "config.json"))).toBe(true);
			expect(await approvals()).toBe(1);
		}
	});

	test("the run summary index stays by default; only the exact delete option removes it", async () => {
		const summary = (runId: string): RunSummary => ({
			schema: "storm.run-summary/v1",
			runId,
			startedAt: "2026-11-20T09:00:00.000Z",
			status: "done",
			task: "t",
			costUsd: 1,
			agents: 0,
			spawns: { total: 0, blocked: 0 },
		});
		await seed();
		await appendRunIndex(project, summary("run-a"));
		const keep = scriptedUi(["초기화"]);
		expect(await resetFlow(env, keep.ui)).toBe(true);
		expect(keep.selects[0]?.options).toEqual(["초기화", "초기화하고 실행 요약 색인도 지우기", "취소"]);
		expect(existsSync(path.join(stormDir(), "config.json"))).toBe(false);
		expect((await readRunIndex(project)).map(s => s.runId)).toEqual(["run-a"]);
		expect(await readFile(path.join(stormDir(), ".gitignore"), "utf8")).toBe("/state/\n");

		await seed();
		const drop = scriptedUi(["초기화하고 실행 요약 색인도 지우기"]);
		expect(await resetFlow(env, drop.ui)).toBe(true);
		expect(existsSync(stormDir())).toBe(false);
		expect(await readRunIndex(project)).toEqual([]);
	});

	test("approval records left after .omp/storm was deleted by hand are still cleared", async () => {
		const dir = await seed();
		await rm(stormDir(), { recursive: true });
		const f = scriptedUi(["초기화"]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	test("refuses while a run is active, before asking anything", async () => {
		await seed();
		const run: RunRecord = {
			schema: "storm.run/v1",
			runId: "run-x",
			configHash: "h",
			approvalId: "ap",
			startedAt: "2026-11-20T09:00:00.000Z",
			status: "running",
			contract: "workflowz",
			task: "t",
			costUsd: 0,
			costByModel: {},
			spawns: [],
		};
		const f = scriptedUi(["초기화"]);
		expect(await resetFlow({ ...env, activeRun: () => run }, f.ui)).toBe(false);
		expect(f.selects).toEqual([]);
		expect(f.notes[0]).toContain("run-x");
		expect(existsSync(stormDir())).toBe(true);
	});

	test("calls out a committed config and other worktrees that share the approvals", async () => {
		await seed();
		await git(project, "add", ".omp/storm/config.json");
		await git(project, "commit", "-qm", "storm");
		await git(project, "worktree", "add", path.join(tmp, "wt"));
		const f = scriptedUi(["초기화"]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(f.contexts[0]).toContain("git에 커밋된 파일 1개(.omp/storm/config.json)");
		expect(f.contexts[0]).toContain("다른 worktree 1개");
		expect(f.notes.at(-1)).toContain("직접 커밋");
	});

	test("nothing to reset: says so without asking", async () => {
		const f = scriptedUi(["초기화"]);
		expect(await resetFlow(env, f.ui)).toBe(false);
		expect(f.selects).toEqual([]);
		expect(f.notes).toEqual(["초기화할 Storm 설정이나 기록이 없습니다."]);
	});
});
