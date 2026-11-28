/**
 * 0.32 easier start: the preflight report agrees with the refusals it previews (O1), the last approved team of a target
 * is suggested to a new session and removed by reset (O2), and the install notice shows once per profile (O3).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearLastTeam, lastTeamPath, loadLastTeam, ONBOARDING_NOTICE, onboardOnce, saveLastTeam } from "../src/approval/last-team.ts";
import { configHash } from "../src/config/canonical.ts";
import { approveAndSave, type FlowEnv, hubFlow, LAST_TEAM, resetFlow, statusText } from "../src/flows.ts";
import { decideSpawn } from "../src/policy/spawn.ts";
import { APPROVE, CANCEL } from "../src/proposals/present.ts";
import { type PreflightHost, type PreflightInput, type PreflightReport, preflightReport } from "../src/report/preflight.ts";
import { PLAN_MODE_START_REFUSAL } from "../src/runtime/controller.ts";
import { batchWriteNeed } from "../src/runtime/lanes.ts";
import { isApproved, loadProjectState } from "../src/state.ts";
import type { ConfigLoad, PlanLane, RunPlan, SpawnRuntime, SpawnState, StormConfig } from "../src/types.ts";
import { fakeModes, fakeSession } from "./fake-session.ts";
import { approvalRecord, teamOf } from "./fixtures.ts";
import { makeProject, pick, scriptedUi, TEAM, type TestProject, withSession } from "./support.ts";

const HASH = `jcs-sha256:${"ab12".repeat(16)}`;
const approved = (config: StormConfig): SpawnState => {
	const load: Extract<ConfigLoad, { status: "ok" }> = { status: "ok", path: "/s/config.json", config, hash: HASH, warnings: [] };
	return { config: load, approval: approvalRecord(HASH), shadows: [] };
};
const input = (state: SpawnState, over: Partial<PreflightInput> = {}): PreflightInput => ({ state, isolation: { enabled: true, apply: false }, integration: false, ...over });
const item = (report: PreflightReport, key: string) => report.items.find(entry => entry.key === key);
const blockedKeys = (report: PreflightReport) => report.items.filter(entry => entry.status === "blocked").map(entry => entry.key);

describe("O1: the preflight report and the start refusal answer the same inputs alike", () => {
	const lane: PlanLane = { name: "api", kind: "code", role: "implementer", files: ["api.ts"], goal: "Implement API" };
	const plan: RunPlan = { lanes: [lane], workers: { implementer: 1 }, submittedAt: "2026-11-28T00:00:00Z" };
	const call = { agent: "storm-implementer", name: "api", task: "Implement" };

	test("isolation enabled and apply: an isolated team is refused at placement exactly when the report blocks", () => {
		const isolated = teamOf({ implementer: "a/i" }, { isolation: "isolated" });
		for (const enabled of [true, false, undefined]) {
			for (const apply of [true, false, undefined]) {
				const host = { ...(enabled === undefined ? {} : { enabled }), ...(apply === undefined ? {} : { apply }) };
				const refused = !batchWriteNeed(call, plan, isolated, { host }).ok;
				const report = preflightReport(input(approved(isolated), { isolation: host }));
				const blocked = blockedKeys(report).filter(key => key.startsWith("task.isolation."));
				expect({ enabled, apply, blocked: blocked.length > 0 }).toEqual({ enabled, apply, blocked: refused });
				if (refused) expect(item(report, blocked[0]!)?.command).toMatch(/^omp config set task\.isolation\.(enabled true|apply false)$/);
			}
		}
	});

	test("isolation apply left on: the report names the exact command and a shared team only gets a notice", () => {
		const isolated = teamOf({ implementer: "a/i" }, { isolation: "isolated" });
		const host = { enabled: true, apply: true };
		expect(batchWriteNeed(call, plan, isolated, { host }).ok).toBe(false);
		const report = preflightReport(input(approved(isolated), { isolation: host }));
		expect(item(report, "task.isolation.apply")).toMatchObject({ status: "blocked", command: "omp config set task.isolation.apply false" });
		const shared = teamOf({ implementer: "a/i" });
		expect(batchWriteNeed(call, plan, shared, { host }).ok).toBe(true);
		expect(item(preflightReport(input(approved(shared), { isolation: host })), "task.isolation.apply")?.status).toBe("notice");
	});

	test("auth: a role is reported blocked exactly when its spawn is refused for want of a credential", () => {
		const team = teamOf({ implementer: "a/i", explorer: { models: ["a/x", "b/z"], effort: "low" }, reviewer: "b/r" });
		const runtime: SpawnRuntime = { now: 0, quotaMarks: [], trials: {}, run: { runId: "run-1", costUsd: 0 } };
		const cases: string[][] = [[], ["a/i", "a/x", "b/z", "b/r"], ["a/i", "b/z", "b/r"], ["a/i", "a/x"]];
		for (const logged of cases) {
			const ok = new Set(logged);
			const refusedRoles = Object.values(team.roles).filter(role => {
				const { decision } = decideSpawn({ agent: role.agent, invocationKind: "task", patterns: [], spawnKey: "k" }, approved(team), runtime, { authenticated: ok });
				return decision !== undefined && "block" in decision;
			});
			const auth = item(preflightReport(input(approved(team), { credentials: { ok, slow: new Set() } })), "auth");
			expect({ logged, blocked: auth?.status === "blocked" }).toEqual({ logged, blocked: refusedRoles.length > 0 });
			// A role with one model left still starts: the report says which models are left out, not that it is blocked.
			if (refusedRoles.length === 0 && logged.length < 4) expect(auth?.status).toBe("notice");
		}
		const none = item(preflightReport(input(approved(team), { credentials: { ok: new Set(), slow: new Set() } })), "auth");
		expect(none?.command).toBe("/login a · /login b");
	});

	describe("omp modes", () => {
		let root: string;
		beforeEach(async () => {
			root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-preflight-mode-")));
		});
		afterEach(async () => {
			await rm(root, { recursive: true, force: true });
		});

		for (const mode of ["plan", "goal", "loop", "none"] as const) {
			test(`${mode}: the hand start refuses exactly when the report blocks the mode`, async () => {
				const modes = fakeModes(mode === "goal" ? { goal: "active" } : mode === "loop" ? { loop: "active" } : {});
				if (mode === "plan") modes.state.plan.status = "active";
				const report = preflightReport(input(approved(TEAM), { modes: modes.snapshot() }));
				const h = fakeSession({ root, modes });
				const started = await h.controller.start(h.ctx, { task: "t" });
				expect(item(report, "mode")?.status === "blocked").toBe(!started.ok);
				if (mode === "plan" && !started.ok) {
					expect(started.reason).toBe(PLAN_MODE_START_REFUSAL);
					expect(item(report, "mode")?.command).toBe("/plan");
				}
				if (started.ok) await h.controller.finish("shutdown");
			});
		}

		test("vibe is a notice: the hand start offers to leave it rather than refusing", () => {
			const modes = fakeModes({ vibe: true });
			expect(item(preflightReport(input(approved(TEAM), { modes: modes.snapshot() })), "mode")?.status).toBe("notice");
		});
	});

	test("an unapproved team blocks with /storm; an approval dialog leaves the team item out and judges the proposal", () => {
		const unapproved: SpawnState = { ...approved(TEAM), approval: undefined };
		expect(item(preflightReport(input(unapproved)), "team")).toMatchObject({ status: "blocked", command: "/storm" });
		const missing: SpawnState = { config: { status: "missing", path: "/s/config.json" }, approval: undefined, shadows: [] };
		const dialog = preflightReport(input(missing, { proposed: TEAM }));
		expect(item(dialog, "team")).toBeUndefined();
		expect(item(dialog, "budget")?.status).toBe("notice");
	});

	test("pool threads with a ceiling above eight and an unset budget are notices, never blocks; task.workerThreads 0 settles it", () => {
		const report = preflightReport(input(approved(TEAM), { maxConcurrency: 32, workerThreads: 4 }));
		expect(item(report, "task.workerThreads")).toMatchObject({ status: "notice", command: "omp config set task.workerThreads 0" });
		expect(item(preflightReport(input(approved(TEAM), { maxConcurrency: 0, workerThreads: 4 })), "task.workerThreads")?.status).toBe("notice");
		expect(item(preflightReport(input(approved(TEAM), { maxConcurrency: 4, workerThreads: 4 })), "task.workerThreads")?.status).toBe("ok");
		expect(item(preflightReport(input(approved(TEAM), { maxConcurrency: 32, workerThreads: 0 })), "task.workerThreads")?.status).toBe("ok");
		expect(item(preflightReport(input(approved(TEAM), { maxConcurrency: 32 })), "task.workerThreads")?.status).toBe("notice");
		expect(report.blocked).toBe(0);
	});
});

/** A host where every model logs in unless `missing` names it, and omp's plan mode is `plan`. */
function host(opts: { missing?: readonly string[]; plan?: boolean } = {}): PreflightHost {
	const modes = fakeModes();
	if (opts.plan) modes.state.plan.status = "active";
	return {
		modes: () => modes.snapshot(),
		isolation: async () => ({ enabled: true, apply: false }),
		maxConcurrency: () => 4,
		workerThreads: () => 0,
		credentials: async selectors => ({ ok: new Set(selectors.filter(s => !opts.missing?.includes(s)).map(s => s.toLowerCase())), slow: new Set() }),
		integration: false,
	};
}

describe("O2: the last approved team of a target", () => {
	let project: TestProject;
	let env: FlowEnv;
	beforeEach(async () => {
		project = await makeProject();
		env = project.env;
	});
	afterEach(async () => {
		await project.remove();
	});

	test("an approval saves only the team and its time for the target; a damaged or invalid file is no suggestion", async () => {
		const state = await loadProjectState(env);
		await approveAndSave(state, TEAM, { shadowedAgents: [] });
		const file = lastTeamPath(env.agentDir, state.store.targetKey);
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(Object.keys(raw).sort()).toEqual(["config", "savedAt", "schema"]);
		const saved = await loadLastTeam(env.agentDir, state.store.targetKey);
		expect(saved?.config).toEqual(TEAM);
		expect(Number.isFinite(Date.parse(saved!.savedAt))).toBe(true);
		await writeFile(file, JSON.stringify({ ...raw, config: { ...TEAM, roles: {} } }));
		expect(await loadLastTeam(env.agentDir, state.store.targetKey)).toBeUndefined();
		await writeFile(file, "{");
		expect(await loadLastTeam(env.agentDir, state.store.targetKey)).toBeUndefined();
		expect(await clearLastTeam(env.agentDir, state.store.targetKey)).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	test("a new session approves the last team in one step: the approval dialog itself, with the preflight in view", async () => {
		const first = await loadProjectState(env);
		await approveAndSave(first, TEAM, { shadowedAgents: first.shadows });
		const next: FlowEnv = { ...withSession(project, "session-next"), preflightHost: () => host({ plan: true }) };
		expect((await loadProjectState(next)).config.status).toBe("missing");
		const f = scriptedUi([APPROVE]);
		expect(await hubFlow(next, f.ui)).toBe(false);
		// One dialog: the ordinary approval, with the recommendation as its extra choice and cancel as its own.
		expect(f.selects).toHaveLength(1);
		expect(f.selects[0]?.options).toEqual([APPROVE, LAST_TEAM.recommend, CANCEL]);
		expect(f.selects[0]?.markdown).toContain("저장 시각");
		expect(f.selects[0]?.markdown).toContain("a/x, b/z");
		expect(f.selects[0]?.markdown).toContain(LAST_TEAM.summary);
		// The approval dialog carries the same preflight the start would refuse on.
		expect(f.selects[0]?.markdown).toContain("막힘 1");
		expect(f.selects[0]?.markdown).toContain("/plan");
		const state = await loadProjectState(next);
		expect(isApproved(state)).toBe(true);
		expect(state.config.status === "ok" && state.config.hash).toBe(configHash(TEAM));
	});

	test("cancel in that dialog changes nothing; the saved team stays a suggestion", async () => {
		const targetKey = (await loadProjectState(env)).store.targetKey;
		await saveLastTeam(env.agentDir, targetKey, TEAM);
		const f = scriptedUi([CANCEL]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		expect((await loadProjectState(env)).config.status).toBe("missing");
		expect((await loadLastTeam(env.agentDir, targetKey))?.config).toEqual(TEAM);
	});

	test("models that do not log in now are a warning, and the recommendation is one choice away", async () => {
		await saveLastTeam(env.agentDir, (await loadProjectState(env)).store.targetKey, TEAM);
		const f = scriptedUi([LAST_TEAM.recommend, pick(-1), pick(-1), pick(-1)]);
		await hubFlow({ ...env, preflightHost: () => host({ missing: ["a/x", "b/r"] }) }, f.ui);
		expect(f.selects[0]?.markdown).toContain("지금 인증되지 않는 모델: a/x, b/r");
		expect(f.selects[0]?.options).toContain(LAST_TEAM.recommend);
		// Picking the recommendation leaves the saved team: what follows is the recommendation, never the saved team again.
		expect(f.selects.slice(1).every(s => !s.markdown?.includes("지난번에 승인한 팀"))).toBe(true);
		const state = await loadProjectState(env);
		expect(state.config.status === "ok" && state.config.hash === configHash(TEAM) && isApproved(state)).toBe(false);
	});

	test("reset removes the target's suggestion, even from a session that holds nothing else", async () => {
		const first = await loadProjectState(env);
		// The approval covers the shadowing definitions this machine has, as `/storm` would; otherwise it was never approved.
		await approveAndSave(first, TEAM, { shadowedAgents: first.shadows });
		expect(isApproved(await loadProjectState(env))).toBe(true);
		const other = withSession(project, "session-reset-other");
		const f = scriptedUi([pick(0)]);
		expect(await resetFlow(other, f.ui)).toBe(true);
		expect(f.selects[0]?.markdown).toContain("지난번 팀 추천");
		expect(await loadLastTeam(env.agentDir, first.store.targetKey)).toBeUndefined();
		// The first session's own team and approval are not that reset's.
		expect(isApproved(await loadProjectState(env))).toBe(true);
	});

	test("/storm status shows the preflight section in place of the old omp settings section", async () => {
		const state = await loadProjectState(env);
		await approveAndSave(state, TEAM, { shadowedAgents: state.shadows });
		const text = await statusText({ ...env, preflightHost: () => host({ plan: true }) }, { quota: true });
		expect(text).toContain("시작 전 점검: 통과");
		expect(text).toContain("`/plan`");
		expect(text).not.toContain("omp 설정 점검");
	});
});

describe("O3: the install notice", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-onboard-")));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("shows once per profile, only to a session without a team", async () => {
		const shown: string[] = [];
		expect(await onboardOnce(dir, true, text => shown.push(text))).toBe(false);
		expect(shown).toEqual([]);
		expect(await onboardOnce(dir, false, text => shown.push(text))).toBe(true);
		expect(await onboardOnce(dir, false, text => shown.push(text))).toBe(false);
		expect(shown).toEqual([ONBOARDING_NOTICE]);
	});
});
