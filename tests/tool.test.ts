import { describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { MAX_LANE_TEXT } from "../src/plan/validate.ts";
import { NEEDS_APPROVAL } from "../src/proposals/decide.ts";
import { APPROVE, CANCEL } from "../src/proposals/present.ts";
import { agentRows, renderAgentRows } from "../src/report/agents.ts";
import { CLOSEOUT_NEXT_MAX, CLOSEOUT_TEXT_MAX, type CloseoutDraft } from "../src/runtime/closeout.ts";
import type { RunRequestResult, StormToolHost } from "../src/tool/host.ts";
import { createStormTool, runStormTool, type StormToolInput } from "../src/tool/storm-tool.ts";
import type { AgentEntry, RunPlan, RunSpec } from "../src/types.ts";
import { fakeHost, NOW, STATUS_TEXT } from "./fake-host.ts";
import { agentEntry as ledgerEntry } from "./fixtures.ts";
import { TEAM as base } from "./support.ts";

const run = (f: { host: StormToolHost }, params: StormToolInput) => runStormTool(f.host, params);

const agentEntry = (over: Partial<AgentEntry> = {}): AgentEntry =>
	ledgerEntry({ id: "A1", model: "a/i", startedAt: NOW - 600_000, lastActivityAt: NOW - 60_000, contextTokens: 30_000, requests: 4, costUsd: 0.1, ...over });

describe("tool definition", () => {
	const tool = createStormTool(zod, () => fakeHost().host);

	test("exposes exactly run, plan, brief, status and agents", () => {
		expect(tool).toMatchObject({ name: "storm", label: "Storm", loadMode: "essential", defaultInactive: true });
		for (const action of ["run", "plan", "brief", "status", "agents"]) expect(tool.parameters.safeParse({ action }).success).toBe(true);
		const gone = ["models", "priority", "workers", "reselect", "quota", "trial", "budget", "settings", "propose", "delete-everything"];
		for (const action of gone) expect(tool.parameters.safeParse({ action }).success).toBe(false);
	});

	test("the description fits in 900 characters and names the brief and progress", () => {
		expect(tool.description.length).toBeLessThanOrEqual(900);
		expect(tool.description).toContain("brief");
		expect(tool.description).toContain("progress");
	});

	test("the schema has exactly action, task, plan and brief", () => {
		const draft = { result: "r", verification: "v", next: ["a", "b", "c"] };
		const parsed = tool.parameters.parse({ action: "run", task: "t", plan: { lanes: [] }, brief: draft, mode: "loop", iterations: 3, minutes: 5, tokenBudget: 10 });
		expect(Object.keys(parsed).sort()).toEqual(["action", "brief", "plan", "task"]);
		expect(parsed).not.toHaveProperty("mode");
		expect(parsed).not.toHaveProperty("until");
		expect(parsed).not.toHaveProperty("while");
		expect(tool.parameters.safeParse({ action: "run", task: "t", mode: "forever" }).success).toBe(true);

		// brief.next is exactly three directions; plan lanes carry optional status progress.
		expect(tool.parameters.safeParse({ action: "brief", brief: draft }).success).toBe(true);
		for (const next of [["a", "b"], ["a", "b", "c", "d"]]) {
			expect(tool.parameters.safeParse({ action: "brief", brief: { result: "r", verification: "v", next } }).success).toBe(false);
		}
		expect(tool.parameters.safeParse({ action: "brief", brief: { result: "r", verification: "v" } }).success).toBe(false);
		expect(tool.parameters.safeParse({ action: "plan", plan: { lanes: [{ name: "core", kind: "code", progress: "절반" }] } }).success).toBe(true);
		// The schema caps match the domain parser, so an oversized label or brief fails before the action runs.
		const lane = (field: "goal" | "progress", length: number) => ({
			action: "plan",
			plan: { lanes: [{ name: "core", kind: "code", [field]: "x".repeat(length) }] },
		});
		expect(tool.parameters.safeParse(lane("goal", MAX_LANE_TEXT)).success).toBe(true);
		expect(tool.parameters.safeParse(lane("goal", MAX_LANE_TEXT + 1)).success).toBe(false);
		expect(tool.parameters.safeParse(lane("progress", MAX_LANE_TEXT + 1)).success).toBe(false);
		const longBrief = { result: "x".repeat(CLOSEOUT_TEXT_MAX + 1), verification: "v", next: ["a", "b", "c"] };
		expect(tool.parameters.safeParse({ action: "brief", brief: longBrief }).success).toBe(false);
		const longNext = { result: "r", verification: "v", next: ["a", "b", "x".repeat(CLOSEOUT_NEXT_MAX + 1)] };
		expect(tool.parameters.safeParse({ action: "brief", brief: longNext }).success).toBe(false);
	});

	test("reports are read tier; a run, a plan or a brief is write tier", () => {
		const tier = (args: unknown) => (typeof tool.approval === "function" ? tool.approval(args) : tool.approval);
		expect(tier({ action: "status" })).toBe("read");
		expect(tier({ action: "agents" })).toBe("read");
		expect(tier({ action: "run", task: "x" })).toBe("write");
		expect(tier({ action: "plan" })).toBe("write");
		expect(tier({ action: "brief" })).toBe("write");
		expect(tier(undefined)).toBe("write");
	});
});

describe("read actions", () => {
	test("status is the host's status text without the quota read, with no dialog and no analysis", async () => {
		for (const opts of [{}, { approved: false }, { config: null }]) {
			const f = fakeHost(opts);
			expect(await run(f, { action: "status" })).toEqual({ outcome: "ok", text: STATUS_TEXT });
			expect(f.statusCalls).toEqual([{ quota: false }]);
			expect(f.prepares()).toBe(0);
			expect(f.selects).toEqual([]);
		}
	});

	test("agents returns the subagent table and nothing else", async () => {
		const agents = [agentEntry({ id: "Imp1" }), agentEntry({ id: "Full", contextTokens: 250_000 }), agentEntry({ id: "Gone", cleanedAt: NOW })];
		const f = fakeHost({ agents });
		expect(await run(f, { action: "agents" })).toEqual({ outcome: "ok", text: renderAgentRows(agentRows(agents, base), NOW) });
		expect(f.prepares()).toBe(0);
		expect(f.selects).toEqual([]);
		expect((await run(fakeHost(), { action: "agents" })).outcome).toBe("ok");
		// Without a team the default cap applies.
		expect(await run(fakeHost({ config: null, agents }), { action: "agents" })).toEqual({ outcome: "ok", text: renderAgentRows(agentRows(agents, undefined), NOW) });
	});
});

describe("plan", () => {
	const lanes = [
		{ name: "core", kind: "code" as const, files: ["src/a.ts"] },
		{ name: "scan", kind: "explore" as const },
	];

	test("within bounds applies at once with no dialog", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 2 } } });
		expect(r.outcome).toBe("ok");
		expect(f.selects).toEqual([]);
		expect(f.saved).toEqual([]);
		expect(f.plans).toHaveLength(1);
		expect(f.plans[0]!.workers.implementer).toBe(2);
		expect(f.plans[0]!.lanes.map(l => l.role)).toEqual(["implementer", "explorer"]);
	});

	test("lane progress is status carried through the plan, not a new lane identity", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes: [{ name: "core", kind: "code", goal: "ship it", progress: "절반" }] } });
		expect(r.outcome).toBe("ok");
		expect(f.plans[0]!.lanes[0]).toMatchObject({ name: "core", kind: "code", goal: "ship it", progress: "절반" });
	});

	test("a replan conflict is refused before an out-of-bounds plan can open a proposal", async () => {
		const f = fakeHost({ runActive: true, answers: [APPROVE] });
		const host: StormToolHost = {
			...f.host,
			runtime: {
				...f.host.runtime,
				replanConflict: plan => `계획 레인 '${plan.lanes[0]!.name}'의 goal 항목이 바뀌었습니다.`,
			},
		};
		const r = await run({ host }, { action: "plan", plan: { lanes: [{ name: "core", kind: "code", goal: "new" }], workers: { implementer: 5 } } });
		expect(r).toEqual({ outcome: "rejected", text: "계획을 적용하지 않았습니다. 계획 레인 'core'의 goal 항목이 바뀌었습니다." });
		expect(f.selects).toEqual([]);
		expect(f.saved).toEqual([]);
		expect(f.plans).toEqual([]);
	});

	test("errors and a missing team reject without a dialog", async () => {
		const f = fakeHost({ runActive: true });
		expect((await run(f, { action: "plan", plan: { lanes: [], workers: {} } })).outcome).toBe("rejected");
		expect((await run(f, { action: "plan" })).outcome).toBe("rejected");
		expect(f.plans).toEqual([]);
		expect(f.selects).toEqual([]);
		expect((await run(fakeHost({ config: null }), { action: "plan", plan: { lanes } })).outcome).toBe("rejected");
	});

	test("past the bounds of an unapproved config: refused, nothing asked, nothing saved", async () => {
		const f = fakeHost({ approved: false, runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes: [{ name: "core", kind: "code" }], workers: { implementer: 9 } } });
		expect(r).toEqual({ outcome: "rejected", text: NEEDS_APPROVAL });
		expect(f.selects).toEqual([]);
		expect(f.prepares()).toBe(0);
		expect(f.saved).toEqual([]);
		expect(f.plans).toEqual([]);
	});

	test("workers past max: approving raises the max, then the plan applies", async () => {
		const f = fakeHost({ runActive: true, answers: [APPROVE] });
		const r = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 5 } } });
		expect(r.outcome).toBe("approved");
		expect(f.selects[0]?.options).toEqual([APPROVE, CANCEL]);
		expect(f.selects[0]?.markdown).toContain("core");
		expect(f.saved).toHaveLength(1);
		expect(f.saved[0]!.config.roles.implementer!.workers).toEqual({ min: 1, max: 5 });
		expect(f.prepares()).toBe(0);
		expect(f.plans[0]!.workers.implementer).toBe(5);
	});

	test("a disabled role: approving adds it with recommended models, then the plan applies", async () => {
		const cfg = structuredClone(base);
		delete cfg.roles.reviewer;
		cfg.disabledRoles = ["reviewer"];
		const f = fakeHost({ config: cfg, runActive: true, answers: [APPROVE] });
		const r = await run(f, { action: "plan", plan: { lanes: [...lanes, { name: "check", kind: "review", role: "reviewer" }] } });
		expect(r.outcome).toBe("approved");
		const saved = f.saved[0]!.config;
		expect(saved.disabledRoles).toBeUndefined();
		expect(saved.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["b/r:high"], workers: { min: 1, max: 2 } });
		expect(f.plans[0]!.lanes[2]!.role).toBe("reviewer");
	});

	test("cancelling saves nothing and applies nothing", async () => {
		const f = fakeHost({ runActive: true, answers: [CANCEL] });
		const r = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 5 } } });
		expect(r.outcome).toBe("cancelled");
		expect(f.saved).toEqual([]);
		expect(f.plans).toEqual([]);
	});

	test("no active run: validated, not stored; an approved change still saves", async () => {
		const f = fakeHost({ answers: [APPROVE] });
		const r = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 5 } } });
		expect(r.outcome).toBe("approved");
		expect(f.saved).toHaveLength(1);
		expect(f.plans).toEqual([]);
	});
});

describe("brief", () => {
	function briefHost(result: { ok: true } | { ok: false; reason: string } = { ok: true }) {
		const f = fakeHost();
		const staged: CloseoutDraft[] = [];
		const host: StormToolHost = {
			...f.host,
			runtime: {
				...f.host.runtime,
				submitCloseout: draft => {
					staged.push(draft);
					return result;
				},
			},
		};
		return { f, host, staged };
	}
	const draft = { result: " 결과 ", verification: " 검증 ", remaining: " 남음 ", next: ["첫째", "둘째", "셋째"] as const };

	test("a valid brief is parsed and staged once, with no run, plan or approval", async () => {
		const { f, host, staged } = briefHost();
		const r = await run({ host }, { action: "brief", brief: draft });
		expect(r.outcome).toBe("ok");
		expect(staged).toEqual([{ result: "결과", verification: "검증", remaining: "남음", next: ["첫째", "둘째", "셋째"] }]);
		expect(f.runs).toEqual([]);
		expect(f.plans).toEqual([]);
		expect(f.saved).toEqual([]);
		// The reply stages only: Storm shows the menu, and the model must not claim verification or duplicate it.
		expect(r.text).not.toContain("1.");
		expect(r.text).toContain("게이트");
		expect(r.text).toContain("번호 목록");
	});

	test("a malformed brief is rejected before the host sees it", async () => {
		const { host, staged } = briefHost();
		const shortNext = { action: "brief", brief: { result: "결과", verification: "검증", next: ["a", "b"] } } as unknown as StormToolInput;
		const bad: StormToolInput[] = [
			{ action: "brief" },
			shortNext,
			{ action: "brief", brief: { result: " ", verification: "검증", next: ["a", "b", "c"] } },
			{ action: "brief", brief: { result: "결과", verification: "검증", next: ["a", "a", "b"] } },
			{ action: "brief", brief: { result: "결과\n둘째 줄", verification: "검증", next: ["a", "b", "c"] } },
		];
		for (const params of bad) expect((await run({ host }, params)).outcome).toBe("rejected");
		expect(staged).toEqual([]);
	});

	test("an absent closeout runtime or a controller refusal is reported, never a synthetic success", async () => {
		const absent = await run(fakeHost(), { action: "brief", brief: draft });
		expect(absent.outcome).toBe("rejected");
		expect(absent.text).toContain("호스트");

		const { host } = briefHost({ ok: false, reason: "진행 중인 Storm 실행이 없습니다." });
		expect(await run({ host }, { action: "brief", brief: draft })).toEqual({
			outcome: "rejected",
			text: "진행 중인 Storm 실행이 없습니다.",
		});
	});

	test("automatic delegation has no brief shortcut into a run", async () => {
		const f = fakeHost();
		const staged: CloseoutDraft[] = [];
		const host: StormToolHost = {
			...f.host,
			auto: () => ({ enabled: true, task: "fix it" }),
			runtime: {
				...f.host.runtime,
				submitCloseout: draft => {
					staged.push(draft);
					return { ok: true };
				},
			},
		};
		const r = await run({ host }, { action: "brief", brief: draft });
		expect(r.outcome).toBe("ok");
		expect(f.runs).toEqual([]);
		expect(f.plans).toEqual([]);
		expect(staged).toHaveLength(1);
	});
});

describe("run", () => {
	test("a run is queued with only the task by default", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "run", task: "  fix the login bug " });
		expect(r.outcome).toBe("queued");
		expect(r.text).toContain("run-1");
		expect(f.runs).toEqual([{ task: "fix the login bug" }]);
	});

	test("an empty task is rejected, and a refused run passes its reason back", async () => {
		const f = fakeHost();
		const bad: StormToolInput[] = [
			{ action: "run", task: "   " },
			{ action: "run" },
		];
		for (const params of bad) expect((await run(f, params)).outcome).toBe("rejected");
		expect(f.runs).toEqual([]);
		const g = fakeHost({ run: { ok: false, reason: "refusal-reason" } });
		expect(await run(g, { action: "run", task: "x" })).toEqual({ outcome: "rejected", text: "refusal-reason" });
	});
});

describe("automatic delegation", () => {
	interface AutoStart {
		spec: RunSpec;
		plan: RunPlan;
		hash: string | undefined;
	}

	function autoHost(opts: { task?: string; active?: boolean; start?: RunRequestResult } = {}) {
		const f = fakeHost({ ...(opts.active !== undefined ? { runActive: opts.active } : {}) });
		const starts: AutoStart[] = [];
		const host: StormToolHost = {
			...f.host,
			auto: () => ({ enabled: true, ...(opts.task !== undefined ? { task: opts.task } : {}) }),
			runtime: {
				...f.host.runtime,
				runActive: () => opts.active ?? false,
				startWithPlan: async (spec: RunSpec, plan: RunPlan, hash?: string) => {
					starts.push({ spec, plan, hash });
					return opts.start ?? { ok: true, runId: "run-auto" };
				},
			},
		};
		return { f, host, starts };
	}

	test("run is refused: the first plan is the only way into a run", async () => {
		const { f, host, starts } = autoHost({ task: "fix it" });
		const r = await run({ host }, { action: "run", task: "fix it" });
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("plan");
		expect(f.runs).toEqual([]);
		expect(starts).toEqual([]);
	});

	test("a plan opens the run with this turn's request and the validated plan already bound", async () => {
		const { f, host, starts } = autoHost({ task: "  fix the login bug " });
		const r = await run({ host }, { action: "plan", plan: { lanes: [{ name: "core", kind: "code" }] } });
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("run-auto");
		expect(starts).toHaveLength(1);
		expect(starts[0]!.spec).toEqual({ task: "fix the login bug" });
		expect(starts[0]!.hash).toMatch(/^jcs-sha256:/);
		expect(starts[0]!.plan).toMatchObject({ lanes: [{ name: "core", kind: "code", role: "implementer" }], workers: { implementer: 1 } });
		expect(f.plans).toEqual([]);
	});

	test("without a captured user request it refuses instead of writing a plan", async () => {
		const { f, host, starts } = autoHost();
		const r = await run({ host }, { action: "plan", plan: { lanes: [{ name: "core", kind: "code" }] } });
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("사용자 요청");
		expect(starts).toEqual([]);
		expect(f.plans).toEqual([]);
	});

	test("an automatic start refusal is passed back unchanged", async () => {
		const { host, starts } = autoHost({ task: "fix it", start: { ok: false, reason: "team approval is stale" } });
		const r = await run({ host }, { action: "plan", plan: { lanes: [{ name: "core", kind: "code" }] } });
		expect(r).toEqual({ outcome: "rejected", text: "team approval is stale" });
		expect(starts).toHaveLength(1);
	});

	test("an active run keeps the existing setRunPlan path, not a second start", async () => {
		const { f, host, starts } = autoHost({ task: "fix it", active: true });
		const r = await run({ host }, { action: "plan", plan: { lanes: [{ name: "core", kind: "code" }] } });
		expect(r.outcome).toBe("ok");
		expect(f.plans).toHaveLength(1);
		expect(starts).toEqual([]);
	});
});
