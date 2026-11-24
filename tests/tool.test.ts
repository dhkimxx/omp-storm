import { describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { MAX_LANE_DEPENDENCIES, MAX_LANE_RESULTS, MAX_LANE_TEXT, MAX_RESULT_CRITERION, MAX_RESULT_ID } from "../src/plan/validate.ts";
import { NEEDS_APPROVAL } from "../src/proposals/decide.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { runChange } from "../src/request/actions.ts";
import { agentRows, renderAgentRows } from "../src/report/agents.ts";
import { CLOSEOUT_NEXT_MAX, CLOSEOUT_TEXT_MAX, type CloseoutDraft } from "../src/runtime/closeout.ts";
import type { ProjectState } from "../src/state.ts";
import type { RunRequestResult, StormToolHost } from "../src/tool/host.ts";
import { createStormTool, runStormTool, type StormToolInput } from "../src/tool/storm-tool.ts";
import type { AgentEntry, RunPlan, RunSpec, StormConfig } from "../src/types.ts";
import { fakeHost, NOW, STATUS_TEXT } from "./fake-host.ts";
import { agentEntry as ledgerEntry } from "./fixtures.ts";
import { TEAM as base } from "./support.ts";

const run = (f: { host: StormToolHost }, params: StormToolInput) => runStormTool(f.host, params);

/** The tool-facing part of the fake host plus its no-mutation/UI probes. */
interface ToolHostFixture {
	host: StormToolHost;
	config(): StormConfig | null;
	selects: readonly unknown[];
	saved: readonly unknown[];
	plans: readonly RunPlan[];
	runs: readonly RunSpec[];
	prepares(): number;
}

/** Everything a refused plan must leave alone: config bytes, approval, dialogs, saves, spawns and the plan in force. */
interface PlanSnapshot {
	state: ProjectState;
	bytes: string;
	plans: RunPlan[];
	runs: RunSpec[];
}

async function expectNoPlanMutation(f: ToolHostFixture, before: PlanSnapshot) {
	const after = await f.host.loadState();
	expect(JSON.stringify(f.config())).toBe(before.bytes);
	expect(after.config).toEqual(before.state.config);
	expect(after.approval).toEqual(before.state.approval);
	expect(f.selects).toEqual([]);
	expect(f.saved).toEqual([]);
	expect(f.prepares()).toBe(0);
	expect(f.plans).toEqual(before.plans);
	expect(f.runs).toEqual(before.runs);
}

/** The fresh-plan contract the tool boundary requires for a change or answer lane. */
const coreLane = {
	name: "core",
	kind: "code" as const,
	files: ["src/a.ts"],
	results: [{ id: "core-change", kind: "change" as const, criterion: "src/a.ts carries the change", path: "src/a.ts" }],
};
const scanLane = {
	name: "scan",
	kind: "explore" as const,
	results: [{ id: "scan-answer", kind: "answer" as const, criterion: "the scan reports what the tree contains" }],
};
const probeLane = {
	name: "probe",
	kind: "run" as const,
	isolationReason: "compare parser backends",
	results: [{ id: "probe-artifact", kind: "artifact" as const, criterion: "the retained experiment patch exists" }],
};

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

	test("the description fits in 900 characters and names the brief, progress and dependencies", () => {
		expect(tool.description.length).toBeLessThanOrEqual(900);
		expect(tool.description).toContain("brief");
		expect(tool.description).toContain("progress");
		expect(tool.description).toContain("dependsOn");
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
		const lane = (field: "goal" | "progress" | "isolationReason", length: number) => ({
			action: "plan",
			plan: { lanes: [{ name: "core", kind: "code", [field]: "x".repeat(length) }] },
		});
		expect(tool.parameters.safeParse(lane("goal", MAX_LANE_TEXT)).success).toBe(true);
		expect(tool.parameters.safeParse(lane("goal", MAX_LANE_TEXT + 1)).success).toBe(false);
		expect(tool.parameters.safeParse(lane("progress", MAX_LANE_TEXT + 1)).success).toBe(false);
		expect(tool.parameters.safeParse(lane("isolationReason", MAX_LANE_TEXT)).success).toBe(true);
		expect(tool.parameters.safeParse(lane("isolationReason", MAX_LANE_TEXT + 1)).success).toBe(false);
		const isolated = tool.parameters.parse({ action: "plan", plan: { lanes: [{ name: "probe", kind: "run", isolationReason: "compare parser backends" }] } });
		expect(isolated.plan?.lanes[0]?.isolationReason).toBe("compare parser backends");
		// Required results are bounded and strict: an unknown field never degrades into a weaker result.
		const result = { id: "report", kind: "change", criterion: "report changes", path: "out/report.json", contains: "ok", check: "test" };
		const withResults = (results: unknown) => ({ action: "plan", plan: { lanes: [{ name: "core", kind: "code", results }] } });
		expect(tool.parameters.safeParse(withResults([result])).success).toBe(true);
		expect(tool.parameters.safeParse(withResults([{ ...result, contians: "typo" }])).success).toBe(false);
		expect(tool.parameters.safeParse(withResults([])).success).toBe(false);
		expect(tool.parameters.safeParse(withResults(Array.from({ length: MAX_LANE_RESULTS + 1 }, (_, i) => ({ ...result, id: `r${i}` })))).success).toBe(false);
		expect(tool.parameters.safeParse(withResults([{ ...result, id: "x".repeat(MAX_RESULT_ID + 1) }])).success).toBe(false);
		expect(tool.parameters.safeParse(withResults([{ ...result, id: "has space" }])).success).toBe(false);
		expect(tool.parameters.safeParse(withResults([{ ...result, criterion: "x".repeat(MAX_RESULT_CRITERION + 1) }])).success).toBe(false);
		// Dependencies are strict too: a typo, an empty list or an unknown need never degrades into no prerequisite.
		const withDeps = (dependsOn: unknown) => ({ action: "plan", plan: { lanes: [{ name: "consume", kind: "explore", dependsOn }] } });
		expect(tool.parameters.safeParse(withDeps([{ lane: "produce", need: "result" }])).success).toBe(true);
		expect(tool.parameters.safeParse(withDeps([{ lane: " produce ", need: "integrated" }])).success).toBe(true);
		expect(tool.parameters.safeParse(withDeps([])).success).toBe(false);
		expect(tool.parameters.safeParse(withDeps([{ lane: "produce", need: "done" }])).success).toBe(false);
		expect(tool.parameters.safeParse(withDeps([{ lane: "produce", need: true }])).success).toBe(false);
		expect(tool.parameters.safeParse(withDeps([{ lane: "produce", need: "result", optional: true }])).success).toBe(false);
		expect(tool.parameters.safeParse(withDeps([{ lane: "", need: "result" }])).success).toBe(false);
		expect(tool.parameters.safeParse(withDeps([{ lane: "x".repeat(MAX_LANE_TEXT + 1), need: "result" }])).success).toBe(false);
		const many = Array.from({ length: MAX_LANE_DEPENDENCIES + 1 }, (_, i) => ({ lane: `p${i}`, need: "reviewable" }));
		expect(tool.parameters.safeParse(withDeps(many)).success).toBe(false);
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
	const lanes = [coreLane, scanLane];

	test("within bounds applies at once with no dialog", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 2 } } });
		expect(r.outcome).toBe("ok");
		expect(f.selects).toEqual([]);
		expect(f.saved).toEqual([]);
		expect(f.prepares()).toBe(0);
		expect(f.plans).toHaveLength(1);
		expect(f.plans[0]!.workers.implementer).toBe(2);
		expect(f.plans[0]!.lanes.map(l => l.role)).toEqual(["implementer", "explorer"]);
	});

	test("an asynchronous plan application is awaited before the reply claims it applied", async () => {
		const f = fakeHost({ runActive: true });
		let applied = false;
		f.host.runtime.setRunPlan = async plan => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			f.plans.push(plan);
			applied = true;
			return { ok: true };
		};
		const r = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 2 } } });
		expect(applied).toBe(true);
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("실행 계획을 적용했습니다");
	});

	test("a fresh plan that omits one lane's results is refused with that lane id before saving", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes: [coreLane, { name: "writer", kind: "run" }] } });
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("'writer'");
		expect(r.text).toContain("results");
		expect(f.plans).toEqual([]);
		expect(f.saved).toEqual([]);
		expect(f.selects).toEqual([]);
	});

	test("a review-only plan is a gate, not a deliverable, and needs no results", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes: [{ name: "gate", kind: "review" }] } });
		expect(r.outcome).toBe("ok");
		expect(f.plans).toHaveLength(1);
		expect(f.plans[0]!.lanes[0]).not.toHaveProperty("results");
	});

	test("lane progress is status carried through the plan, not a new lane identity", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes: [{ ...coreLane, goal: "ship it", progress: "절반" }] } });
		expect(r.outcome).toBe("ok");
		expect(f.plans[0]!.lanes[0]).toMatchObject({ name: "core", kind: "code", goal: "ship it", progress: "절반" });
	});

	test("required results are carried and normalized; the plan alone proves none of them", async () => {
		const f = fakeHost({ runActive: true });
		const results = [
			{ id: "report-json", kind: "change" as const, criterion: "  report.json changes  ", path: "out/report.json", contains: "  ok  " },
			{ id: "probe", kind: "artifact" as const, criterion: "patch exists", path: "patches/a.patch" },
		];
		const r = await run(f, { action: "plan", plan: { lanes: [{ name: "core", kind: "code", results }] } });
		expect(r.outcome).toBe("ok");
		expect(f.plans[0]!.lanes[0]!.results).toEqual([
			{ id: "report-json", kind: "change", criterion: "report.json changes", path: "out/report.json", contains: "  ok  " },
			{ id: "probe", kind: "artifact", criterion: "patch exists", path: "patches/a.patch" },
		]);
	});

	test("a results contract that cannot be observed is refused before the plan applies", async () => {
		const f = fakeHost({ runActive: true });
		const bad = async (results: unknown) => run(f, { action: "plan", plan: { lanes: [{ name: "core", kind: "code", results } as never] } });
		expect((await bad([{ id: "x", kind: "change", criterion: "changed", path: "../escape.ts" }])).outcome).toBe("rejected");
		expect((await bad([{ id: "x", kind: "answer", criterion: "answered", contains: "yes", check: "test" }])).outcome).toBe("rejected");
		expect((await bad([{ id: "x", kind: "change", criterion: "changed", path: "a.ts", check: "bun test" }])).outcome).toBe("rejected");
		expect(f.plans).toEqual([]);
		expect(f.selects).toEqual([]);
		// A pathless change is allowed as a qualitative obligation, not as an automatic pass.
		expect((await bad([{ id: "x", kind: "change", criterion: "changed" }])).outcome).toBe("ok");
		expect(f.plans[0]!.lanes[0]!.results).toEqual([{ id: "x", kind: "change", criterion: "changed" }]);
		const checked = { ...structuredClone(base), requiredChecks: [{ name: "test", argv: ["bun", "test"] }] };
		const g = fakeHost({ config: checked, runActive: true });
		const ok = await run(g, { action: "plan", plan: { lanes: [{ name: "core", kind: "code", results: [{ id: "x", kind: "change", criterion: "changed", path: "a.ts", check: "test" }] }] } });
		expect(ok.outcome).toBe("ok");
		expect(g.plans[0]!.lanes[0]!.results![0]!.check).toBe("test");
	});

	test("selective isolation persists on its lane and adds one display line only for that exception", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, {
			action: "plan",
			plan: {
				lanes: [coreLane, probeLane],
			},
		});
		expect(r.outcome).toBe("ok");
		expect(f.plans[0]!.lanes[0]).not.toHaveProperty("isolationReason");
		expect(f.plans[0]!.lanes[1]!.isolationReason).toBe("compare parser backends");
		const lines = r.text.split("\n").filter((line) => line.startsWith("- 격리("));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("probe");
		expect(lines[0]).toContain("compare parser backends");

		const shared = fakeHost({ runActive: true });
		const plain = await run(shared, { action: "plan", plan: { lanes } });
		expect(plain.text).not.toContain("- 격리(");
		expect(shared.plans[0]!.lanes.every((lane) => lane.isolationReason === undefined)).toBe(true);
	});

	test("a checked-only plan still shows the isolation exception once", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "plan", plan: { lanes: [probeLane] } });
		expect(r.outcome).toBe("ok");
		expect(f.plans).toEqual([]);
		expect(r.text).toContain("검증만 했습니다");
		expect(r.text.split("\n").filter((line) => line.startsWith("- 격리("))).toHaveLength(1);
	});

	test("a final review lane cannot request selective isolation", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, { action: "plan", plan: { lanes: [{ name: "check", kind: "review", isolationReason: "independent experiment" }] } });
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("통합 트리");
		expect(f.plans).toEqual([]);
		expect(f.selects).toEqual([]);
	});

	test("a plan with dependencies applies them and shows every edge to the director", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, {
			action: "plan",
			plan: {
				lanes: [
					{ name: "produce", kind: "code", results: [{ id: "p", kind: "change", criterion: "a.ts changes", path: "a.ts" }] },
					{ ...scanLane, name: "consume", dependsOn: [{ lane: "produce", need: "result" }] },
				],
			},
		});
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("- 선행: consume ← produce(result)");
		expect(f.plans[0]!.lanes[1]!.dependsOn).toEqual([{ lane: "produce", need: "result" }]);
	});

	test("an invalid dependency rejects before any dialog, save or applied plan", async () => {
		const f = fakeHost({ runActive: true });
		const r = await run(f, {
			action: "plan",
			plan: { lanes: [{ ...coreLane, dependsOn: [{ lane: "gone", need: "result" }] }], workers: { implementer: 5 } },
		});
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("없는 레인");
		expect(f.selects).toEqual([]);
		expect(f.plans).toEqual([]);
		expect(f.saved).toEqual([]);
	});

	test("a replan conflict is refused before the bounds check or any dialog", async () => {
		const f = fakeHost({ runActive: true });
		const host: StormToolHost = {
			...f.host,
			runtime: {
				...f.host.runtime,
				replanConflict: plan => `계획 레인 '${plan.lanes[0]!.name}'의 goal 항목이 바뀌었습니다.`,
			},
		};
		const r = await run({ host }, { action: "plan", plan: { lanes: [{ ...coreLane, goal: "new" }], workers: { implementer: 5 } } });
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

	test("an unapproved config still refuses an out-of-bounds plan on its merits, with nothing asked or saved", async () => {
		const f = fakeHost({ approved: false, runActive: true });
		const before = { state: await f.host.loadState(), bytes: JSON.stringify(f.config()), plans: structuredClone(f.plans), runs: structuredClone(f.runs) };
		const r = await run(f, { action: "plan", plan: { lanes: [coreLane], workers: { implementer: 9 } } });
		expect(r.outcome).toBe("rejected");
		expect(r.text).not.toBe(NEEDS_APPROVAL);
		expect(r.text).toContain("워커 9개 사용");
		expect(r.text).toContain("승인된 최대 3개");
		await expectNoPlanMutation(f, before);
	});

	test("workers past max: refused with the exact role, used count and approved max; a valid follow-on still applies", async () => {
		const f = fakeHost({ runActive: true });
		const before = { state: await f.host.loadState(), bytes: JSON.stringify(f.config()), plans: structuredClone(f.plans), runs: structuredClone(f.runs) };
		const asked = { action: "plan" as const, plan: { lanes, workers: { implementer: 5 } } };
		const r = await run(f, asked);
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("구현(implementer)");
		expect(r.text).toContain("워커 5개 사용");
		expect(r.text).toContain("승인된 최대 3개");
		expect(r.text).toContain("순차 실행");
		expect(r.text).toContain("/storm");
		await expectNoPlanMutation(f, before);

		// The same rejected call stays noninteractive and changes nothing.
		expect(await run(f, asked)).toEqual(r);
		await expectNoPlanMutation(f, before);

		// A plan that fits the approved team continues normally.
		const ok = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 3 } } });
		expect(ok.outcome).toBe("ok");
		expect(f.plans).toHaveLength(1);
		expect(f.plans[0]!.workers.implementer).toBe(3);
	});

	test("a disabled role: refused without adding or remapping it; a plan with approved roles continues", async () => {
		const cfg = structuredClone(base);
		delete cfg.roles.reviewer;
		cfg.disabledRoles = ["reviewer"];
		const f = fakeHost({ config: cfg, runActive: true });
		const before = { state: await f.host.loadState(), bytes: JSON.stringify(f.config()), plans: structuredClone(f.plans), runs: structuredClone(f.runs) };
		const r = await run(f, { action: "plan", plan: { lanes: [...lanes, { name: "check", kind: "review", role: "reviewer" }] } });
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("리뷰(reviewer)");
		expect(r.text).toContain("사용 안 함으로 설정된 역할");
		expect(r.text).toContain("/storm");
		await expectNoPlanMutation(f, before);
		expect(f.config()?.disabledRoles).toEqual(["reviewer"]);

		const ok = await run(f, { action: "plan", plan: { lanes } });
		expect(ok.outcome).toBe("ok");
		expect(f.plans[0]!.lanes.map(l => l.role)).toEqual(["implementer", "explorer"]);
	});

	test("a rejected replan leaves the plan in force; the next fitting plan still applies", async () => {
		const f = fakeHost({ runActive: true });
		expect((await run(f, { action: "plan", plan: { lanes: [coreLane] } })).outcome).toBe("ok");
		const before = { state: await f.host.loadState(), bytes: JSON.stringify(f.config()), plans: structuredClone(f.plans), runs: structuredClone(f.runs) };
		const r = await run(f, { action: "plan", plan: { lanes: [{ ...coreLane, progress: "절반" }], workers: { implementer: 5 } } });
		expect(r.outcome).toBe("rejected");
		await expectNoPlanMutation(f, before);
		expect(f.plans[0]!.lanes[0]).not.toHaveProperty("progress");

		const ok = await run(f, { action: "plan", plan: { lanes: [{ ...coreLane, progress: "절반" }] } });
		expect(ok.outcome).toBe("ok");
		expect(f.plans).toHaveLength(2);
		expect(f.plans[1]!.lanes[0]!.progress).toBe("절반");
	});

	test("no active run: an out-of-bounds plan is refused and a fitting plan is checked, not stored or saved", async () => {
		const f = fakeHost();
		const before = { state: await f.host.loadState(), bytes: JSON.stringify(f.config()), plans: structuredClone(f.plans), runs: structuredClone(f.runs) };
		expect((await run(f, { action: "plan", plan: { lanes, workers: { implementer: 5 } } })).outcome).toBe("rejected");
		await expectNoPlanMutation(f, before);

		const checked = await run(f, { action: "plan", plan: { lanes } });
		expect(checked.outcome).toBe("ok");
		expect(checked.text).toContain("검증만 했습니다");
		expect(f.plans).toEqual([]);
		expect(f.saved).toEqual([]);
		expect(f.selects).toEqual([]);
	});

	test("explicit /storm settings still approves and saves after a plan refusal", async () => {
		const f = fakeHost({ runActive: true, answers: [APPROVE] });
		const refused = await run(f, { action: "plan", plan: { lanes, workers: { implementer: 5 } } });
		expect(refused.outcome).toBe("rejected");
		const changed = await runChange(f.host, { action: "settings", docs: false });
		expect(changed.outcome).toBe("approved");
		expect(f.saved).toHaveLength(1);
		expect(f.saved[0]!.config.docs).toBe(false);
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
		const r = await run({ host }, { action: "plan", plan: { lanes: [coreLane] } });
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("run-auto");
		expect(starts).toHaveLength(1);
		expect(starts[0]!.spec).toEqual({ task: "fix the login bug" });
		expect(starts[0]!.hash).toMatch(/^jcs-sha256:/);
		expect(starts[0]!.plan).toMatchObject({ lanes: [{ name: "core", kind: "code", role: "implementer" }], workers: { implementer: 1 } });
		expect(f.plans).toEqual([]);
	});

	test("an out-of-bounds first plan is refused before startWithPlan; a fitting plan then starts", async () => {
		const { f, host, starts } = autoHost({ task: "fix it" });
		const before = { state: await f.host.loadState(), bytes: JSON.stringify(f.config()), plans: structuredClone(f.plans), runs: structuredClone(f.runs) };
		const r = await run({ host }, { action: "plan", plan: { lanes: [coreLane], workers: { implementer: 5 } } });
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("구현(implementer)");
		expect(r.text).toContain("워커 5개 사용");
		expect(r.text).toContain("승인된 최대 3개");
		expect(starts).toEqual([]);
		await expectNoPlanMutation(f, before);

		const ok = await run({ host }, { action: "plan", plan: { lanes: [coreLane] } });
		expect(ok.outcome).toBe("ok");
		expect(starts).toHaveLength(1);
		expect(starts[0]!.plan.workers.implementer).toBe(1);
	});

	test("without a captured user request it refuses instead of writing a plan", async () => {
		const { f, host, starts } = autoHost();
		const r = await run({ host }, { action: "plan", plan: { lanes: [coreLane] } });
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("사용자 요청");
		expect(starts).toEqual([]);
		expect(f.plans).toEqual([]);
	});

	test("an automatic start refusal is passed back unchanged", async () => {
		const { host, starts } = autoHost({ task: "fix it", start: { ok: false, reason: "team approval is stale" } });
		const r = await run({ host }, { action: "plan", plan: { lanes: [coreLane] } });
		expect(r).toEqual({ outcome: "rejected", text: "team approval is stale" });
		expect(starts).toHaveLength(1);
	});

	test("an active run keeps the existing setRunPlan path, not a second start", async () => {
		const { f, host, starts } = autoHost({ task: "fix it", active: true });
		const r = await run({ host }, { action: "plan", plan: { lanes: [coreLane] } });
		expect(r.outcome).toBe("ok");
		expect(f.plans).toHaveLength(1);
		expect(starts).toEqual([]);
	});
});
