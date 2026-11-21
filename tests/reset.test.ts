import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { approveAndSave, type FlowEnv, resetFlow } from "../src/flows.ts";
import { loadProjectState } from "../src/state.ts";
import { appendRunIndex, readRunIndex } from "../src/runtime/run-index.ts";
import type { RunSummary } from "../src/types.ts";
import { runRecord } from "./fixtures.ts";
import { SESSION_TEAM as config } from "./fake-session.ts";
import { exec, git, pick, type ScriptedUi, scriptedUi } from "./support.ts";

/** The reset dialog's options by position: reset first, cancel last, and "reset and drop the run index" between them when there is an index. */
const RESET = pick(0);
const RESET_WITH_INDEX = pick(1);
const CANCEL = pick(-1);

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
	await approveAndSave(state, config, { shadowedAgents: [] });
	await writeFile(path.join(project, ".omp", "other.txt"), "keep\n");
	return state.store.dir;
}

async function approvals(): Promise<number> {
	return (await (await loadProjectState(env)).store.list()).length;
}

describe("/storm reset", () => {
	test("one confirmation deletes .omp/storm and this repo's approvals; other repos and other .omp files stay", async () => {
		const dir = await seed();
		const other = path.join(path.dirname(dir), "git-other-000000000000000000000000");
		await mkdir(path.join(other, "approved"), { recursive: true });
		await writeFile(path.join(other, "approved", "x.json"), "{}");
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(f.selects.map(s => s.options.length)).toEqual([2]);
		expect(existsSync(stormDir())).toBe(false);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(path.join(other, "approved", "x.json"))).toBe(true);
		expect(existsSync(path.join(project, ".omp", "other.txt"))).toBe(true);
		expect(await approvals()).toBe(0);
	});

	test("the list of Storm runs beside the approvals survives, and the dialog names it", async () => {
		const dir = await seed();
		const runs = `${JSON.stringify({ runId: "run-a", artifactsDir: "/s/x", agents: ["a1"] })}\n`;
		await writeFile(path.join(dir, "runs.jsonl"), runs);
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(f.selects[0]?.markdown).toContain("runs.jsonl");
		expect(await readFile(path.join(dir, "runs.jsonl"), "utf8")).toBe(runs);
		expect(existsSync(path.join(dir, "approved"))).toBe(false);
		expect(existsSync(path.join(dir, "snapshots"))).toBe(false);
		// Only the run list is left: a second reset has nothing to do.
		const again = scriptedUi([RESET]);
		expect(await resetFlow(env, again.ui)).toBe(false);
		expect(again.selects).toEqual([]);
	});

	test("nothing is deleted unless the reset option itself is chosen", async () => {
		await seed();
		for (const answer of [undefined, CANCEL, "yes"]) {
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
		const keep = scriptedUi([RESET]);
		expect(await resetFlow(env, keep.ui)).toBe(true);
		expect(keep.selects[0]?.options).toHaveLength(3);
		expect(existsSync(path.join(stormDir(), "config.json"))).toBe(false);
		expect((await readRunIndex(project)).map(s => s.runId)).toEqual(["run-a"]);
		expect(await readFile(path.join(stormDir(), ".gitignore"), "utf8")).toBe("/state/\n");

		await seed();
		const drop = scriptedUi([RESET_WITH_INDEX]);
		expect(await resetFlow(env, drop.ui)).toBe(true);
		expect(existsSync(stormDir())).toBe(false);
		expect(await readRunIndex(project)).toEqual([]);
	});

	test("approval records left after .omp/storm was deleted by hand are still cleared", async () => {
		const dir = await seed();
		await rm(stormDir(), { recursive: true });
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	test("refuses while a run is active, before asking anything", async () => {
		await seed();
		const run = runRecord({ runId: "run-x", status: "running" });
		const f = scriptedUi([RESET]);
		expect(await resetFlow({ ...env, activeRun: () => run }, f.ui)).toBe(false);
		expect(f.selects).toEqual([]);
		expect(f.notes).toHaveLength(1);
		expect(f.notes[0]).toContain("run-x");
		expect(existsSync(stormDir())).toBe(true);
		expect(await approvals()).toBe(1);
	});

	test("a run that starts while the dialog is open stops the reset before anything is deleted", async () => {
		await seed();
		const run = runRecord({ runId: "run-late", status: "running" });
		let started = false;
		const f = scriptedUi([
			options => {
				started = true;
				return options[0];
			},
		]);
		expect(await resetFlow({ ...env, activeRun: () => (started ? run : undefined) }, f.ui)).toBe(false);
		expect(f.selects).toHaveLength(1);
		expect(f.notes).toHaveLength(1);
		expect(f.notes[0]).toContain("run-late");
		expect(existsSync(stormDir())).toBe(true);
		expect(await approvals()).toBe(1);
	});

	test("calls out a committed config and other worktrees that share the approvals", async () => {
		await seed();
		const plain = scriptedUi([CANCEL]);
		await resetFlow(env, plain.ui);
		await git(project, "add", ".omp/storm/config.json");
		await git(project, "commit", "-qm", "storm");
		await git(project, "worktree", "add", path.join(tmp, "wt"));
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		const lines = (s: ScriptedUi) => s.selects[0]?.markdown?.split("\n") ?? [];
		// Two more lines than a project with nothing committed and no other worktree: one names the tracked file.
		expect(lines(f)).toHaveLength(lines(plain).length + 2);
		expect(lines(f).some(line => line.includes(".omp/storm/config.json"))).toBe(true);
	});

	test("nothing to reset: says so without asking", async () => {
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(false);
		expect(f.selects).toEqual([]);
		expect(f.notes).toHaveLength(1);
	});
});
