import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { initializeAutoDelegation, readAutoDelegationChoice } from "../src/approval/auto.ts";
import { approveAndSave, type FlowEnv, resetFlow } from "../src/flows.ts";
import { appendRunIndex, readRunIndex } from "../src/runtime/run-index.ts";
import { writeRun } from "../src/runtime/run.ts";
import { loadProjectState, type ProjectState } from "../src/state.ts";
import { runRecord } from "./fixtures.ts";
import { exec, gitRepo, makeProject, pick, scriptedUi, TEAM, type TestProject, withSession } from "./support.ts";

/** The reset dialog's options by position: reset first, cancel last. */
const RESET = pick(0);
const CANCEL = pick(-1);

const summary = (runId: string) => ({
	schema: "storm.run-summary/v1" as const,
	runId,
	startedAt: "2026-11-20T09:00:00.000Z",
	status: "done" as const,
	task: "t",
	costUsd: 1,
	agents: 0,
	spawns: { total: 0, blocked: 0 },
});

let project: TestProject;
let env: FlowEnv;

beforeEach(async () => {
	project = await makeProject();
	env = project.env;
	await gitRepo(project.root);
});

afterEach(async () => {
	await project.remove();
});

/** An approved session with consent, one run and its index; returns the loaded owner. */
async function seed(target: FlowEnv = env): Promise<ProjectState> {
	const state = await loadProjectState(target);
	await approveAndSave(state, TEAM, { shadowedAgents: [] });
	await initializeAutoDelegation(state.sessionDir, true);
	await writeRun(state.sessionDir, runRecord({ runId: "run-20261120-090000-aaaa", status: "done", endReason: "verified" }));
	await appendRunIndex(state.sessionDir, summary("run-20261120-090000-aaaa"));
	return state;
}

async function approvals(target: FlowEnv = env): Promise<number> {
	return (await (await loadProjectState(target)).store.list()).length;
}

describe("/storm reset", () => {
	test("one confirmation deletes only this session's Storm store; the work tree and old files stay byte-untouched", async () => {
		const before = await seed();
		await mkdir(path.join(project.root, ".omp", "storm"), { recursive: true });
		const oldConfig = path.join(project.root, ".omp", "storm", "config.json");
		await writeFile(oldConfig, "old-team\n");
		await writeFile(path.join(project.root, ".omp", "other.txt"), "keep\n");
		const statusBefore = await exec("git", ["-C", project.root, "status", "--porcelain"]);
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(f.selects.map(s => s.options.length)).toEqual([2]);
		expect(existsSync(before.sessionDir)).toBe(false);
		expect(await readFile(oldConfig, "utf8")).toBe("old-team\n");
		expect(await readFile(path.join(project.root, ".omp", "other.txt"), "utf8")).toBe("keep\n");
		// No checkout write: the target's porcelain status is exactly what it was before the reset.
		expect((await exec("git", ["-C", project.root, "status", "--porcelain"])).stdout).toBe(statusBefore.stdout);
		// No gitignore and no new checkout files: the session store lives in the profile.
		expect(existsSync(path.join(project.root, ".omp", "storm", ".gitignore"))).toBe(false);
		expect(await approvals()).toBe(0);
	});

	test("reset A while session B has an active run removes only A; B keeps its team, approval, consent and history", async () => {
		const a = await seed();
		const bEnv = withSession(project, "session-b-reset");
		const b = await seed(bEnv);
		// The flows receive the run of their own session; B's active run is not A's.
		const bActive: FlowEnv = { ...bEnv, activeRun: () => runRecord({ runId: "run-b-active", status: "running" }) };
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(existsSync(a.sessionDir)).toBe(false);
		expect(existsSync(b.sessionDir)).toBe(true);
		expect(await approvals(bEnv)).toBe(1);
		expect(await readAutoDelegationChoice(b.sessionDir)).toBe("on");
		expect((await readRunIndex(b.sessionDir)).map(s => s.runId)).toEqual(["run-20261120-090000-aaaa"]);
		// B's own reset is refused while its run is active.
		const blocked = scriptedUi();
		expect(await resetFlow(bActive, blocked.ui)).toBe(false);
		expect(blocked.selects).toEqual([]);
		expect(blocked.notes[0]).toContain("run-b-active");
		expect(existsSync(b.sessionDir)).toBe(true);
	});

	test("A→B stale reset cancels and leaves both sessions intact; A→B→A stays cancelled too", async () => {
		const a = await seed();
		const bEnv = withSession(project, "session-b-stale-reset");
		const beforeB = await loadProjectState(bEnv);
		expect(beforeB.config.status).toBe("missing");
		for (const switchTo of ["B", "A again"]) {
			let generation = 0;
			const f = scriptedUi([
				options => {
					// A real switch bumps the host generation on every entry, so even returning to A is a new owner.
					generation = switchTo === "B" ? 1 : 2;
					return options[0];
				},
			]);
			expect(await resetFlow({ ...env, stillOwner: () => generation === 0 }, f.ui)).toBe(false);
			expect(f.selects).toHaveLength(1);
			expect(f.notices.at(-1)?.text).toContain("대화가 바뀌어");
			expect(existsSync(a.sessionDir)).toBe(true);
			expect((await loadProjectState(env)).config.status).toBe("ok");
			expect(await approvals()).toBe(1);
			expect((await loadProjectState(bEnv)).config.status).toBe("missing");
			expect(existsSync(beforeB.sessionDir)).toBe(false);
		}
	});

	test("a switch after the dialog but before the lease or guard completes still deletes nothing", async () => {
		const a = await seed();
		// Calls: entry, after the dialog, after the lease, after the fresh load, after the safety guard.
		// Cutting the predicate off at the post-lease and post-guard checks both must stop before rm.
		for (const allowedThrough of [2, 4]) {
			let calls = 0;
			const f = scriptedUi([options => options[0]]);
			expect(
				await resetFlow(
					{
						...env,
						stillOwner: () => {
							calls++;
							return calls <= allowedThrough;
						},
					},
					f.ui,
				),
			).toBe(false);
			expect(calls).toBeGreaterThan(allowedThrough);
			expect(f.notices.at(-1)?.text).toContain("대화가 바뀌어");
			expect(existsSync(a.sessionDir)).toBe(true);
			expect((await loadProjectState(env)).config.status).toBe("ok");
			expect(await approvals()).toBe(1);
		}
	});

	test("refuses while this session has an active run, before asking anything", async () => {
		const state = await seed();
		const run = runRecord({ runId: "run-x", status: "running" });
		const f = scriptedUi();
		expect(await resetFlow({ ...env, activeRun: () => run }, f.ui)).toBe(false);
		expect(f.selects).toEqual([]);
		expect(f.notes).toHaveLength(1);
		expect(f.notes[0]).toContain("run-x");
		expect(existsSync(state.sessionDir)).toBe(true);
	});

	test("a run that starts while the dialog is open stops the reset before anything is deleted", async () => {
		const state = await seed();
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
		expect(existsSync(state.sessionDir)).toBe(true);
	});

	test("the dialog names what goes and what stays, including other sessions and old workspace files", async () => {
		await seed();
		await mkdir(path.join(project.root, ".omp"), { recursive: true });
		await writeFile(path.join(project.root, ".omp", "keep.txt"), "x");
		const f = scriptedUi([CANCEL]);
		await resetFlow(env, f.ui);
		const markdown = f.selects[0]?.markdown ?? "";
		expect(markdown).toContain("이 OMP 세션만");
		expect(markdown).toContain("다른 OMP 세션");
		expect(markdown).toContain("예전 `.omp/storm/`");
		expect(markdown).toContain("OMP 대화 기록");
		expect(markdown).toContain(project.root);
		expect(markdown).not.toContain("worktree");
	});

	test("nothing is deleted unless the reset option itself is chosen", async () => {
		const state = await seed();
		for (const answer of [undefined, CANCEL, "yes"]) {
			const f = scriptedUi([answer]);
			expect(await resetFlow(env, f.ui)).toBe(false);
			expect(existsSync(path.join(state.sessionDir, "config.json"))).toBe(true);
			expect(await approvals()).toBe(1);
		}
	});

	test("the run summary index is part of this session and goes with it", async () => {
		const state = await seed();
		expect((await readRunIndex(state.sessionDir)).map(s => s.runId)).toEqual(["run-20261120-090000-aaaa"]);
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(existsSync(state.sessionDir)).toBe(false);
		expect(await readRunIndex(state.sessionDir)).toEqual([]);
	});

	test("a session whose config was deleted by hand is still clearable through its approvals", async () => {
		const state = await seed();
		await rm(path.join(state.sessionDir, "config.json"));
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(existsSync(state.sessionDir)).toBe(false);
	});

	test("consent and run state are cleared with the team", async () => {
		const state = await seed();
		expect(await readAutoDelegationChoice(state.sessionDir)).toBe("on");
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(await readAutoDelegationChoice(state.sessionDir)).toBe("unset");
	});

	test("old profile-scope approvals outside the session store are not touched", async () => {
		const state = await seed();
		const legacy = path.join(project.agentDir, "storm", "approvals", state.repo.repoId, "approved", "x.json");
		await mkdir(path.dirname(legacy), { recursive: true });
		await writeFile(legacy, "legacy\n");
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(true);
		expect(await readFile(legacy, "utf8")).toBe("legacy\n");
	});

	test("nothing to reset: says so without asking", async () => {
		const f = scriptedUi([RESET]);
		expect(await resetFlow(env, f.ui)).toBe(false);
		expect(f.selects).toEqual([]);
		expect(f.notes).toHaveLength(1);
	});
});
