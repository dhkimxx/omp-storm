/** O4: `storm plan` while omp's plan mode is on previews what Storm would run and starts nothing. */
import { describe, expect, test } from "bun:test";
import { validatePlan } from "../src/plan/validate.ts";
import type { PreflightReport } from "../src/report/preflight.ts";
import type { AutoDelegationState, StormToolHost } from "../src/tool/host.ts";
import { PLAN_PREVIEW_HEAD, PLAN_PREVIEW_TOGETHER, runStormTool } from "../src/tool/storm-tool.ts";
import type { PlanRequest, RunPlan } from "../src/types.ts";
import { fakeHost, NOW } from "./fake-host.ts";
import { TEAM } from "./support.ts";

const plan: PlanRequest = {
	lanes: [
		{ name: "core", kind: "code", files: ["src/a.ts"], results: [{ id: "core-change", kind: "change", criterion: "src/a.ts exports the parser", path: "src/a.ts" }] },
		{ name: "scan", kind: "explore", results: [{ id: "scan-answer", kind: "answer", criterion: "the scan reports what the tree contains" }] },
	],
};

/** A host with automatic delegation on and a live user turn: outside plan mode a plan here opens a run. */
function autoHost(planMode: boolean | undefined) {
	const f = fakeHost();
	const starts: RunPlan[] = [];
	const host: StormToolHost = {
		...f.host,
		auto: () => ({ enabled: true, task: "parse the files", turnStartedAt: NOW }) as AutoDelegationState,
		runtime: {
			...f.host.runtime,
			runActive: () => false,
			startWithPlan: async (_spec, started) => {
				starts.push(started);
				return { ok: true, runId: "run-auto" };
			},
		},
		...(planMode === undefined ? {} : { planMode: () => planMode }),
	};
	return { f, host, starts };
}

describe("plan preview in omp plan mode", () => {
	test("opens no run, puts no plan in force and queues nothing, even under automatic delegation", async () => {
		const { f, host, starts } = autoHost(true);
		const reply = await runStormTool(host, { action: "plan", plan });
		expect(reply.outcome).toBe("ok");
		expect(reply.text.split("\n")[0]).toBe(PLAN_PREVIEW_HEAD);
		expect(starts).toEqual([]);
		expect(f.plans).toEqual([]);
		expect(f.runs).toEqual([]);
		expect(f.saved).toEqual([]);
	});

	test("with a run active it does not replace the plan in force", async () => {
		const f = fakeHost({ runActive: true });
		const reply = await runStormTool({ ...f.host, planMode: () => true }, { action: "plan", plan });
		expect(reply.text).toContain(PLAN_PREVIEW_HEAD);
		expect(f.plans).toEqual([]);
	});

	test("lists exactly the lanes and results the validator accepted, with the role models", async () => {
		const { host } = autoHost(true);
		const accepted = validatePlan(structuredClone(TEAM), plan, NOW).plan!;
		const text = (await runStormTool(host, { action: "plan", plan })).text;
		for (const lane of accepted.lanes) {
			expect(text).toContain(`- ${lane.name} (${lane.kind}`);
			for (const result of lane.results ?? []) expect(text).toContain(`${result.id} (${result.kind})`);
			for (const model of TEAM.roles[lane.role]?.models ?? []) expect(text).toContain(model);
		}
		// A preview has no record yet: no result claims a state.
		expect(text).not.toContain("아직 기록 없음");
		expect(text).toContain(PLAN_PREVIEW_TOGETHER);
	});

	test("a plan the validator refuses is refused the same way, not previewed", async () => {
		const { host } = autoHost(true);
		const bad = { lanes: [{ name: "writer", kind: "run" as const }] };
		const reply = await runStormTool(host, { action: "plan", plan: bad });
		expect(reply.outcome).toBe("rejected");
		expect(reply.text).not.toContain(PLAN_PREVIEW_HEAD);
	});

	test("shows the start checks' blockers with their commands and only those", async () => {
		const { host } = autoHost(true);
		const report: PreflightReport = {
			blocked: 2,
			items: [
				{ key: "approval", status: "blocked", label: "팀 승인 필요", command: "/storm" },
				{ key: "credentials", status: "ok", label: "모델 인증 확인됨" },
				// The mode the preview runs in: the reason nothing starts, never a blocker it lists.
				{ key: "mode", status: "blocked", label: "omp 모드", detail: "계획 모드가 켜져 있음", mode: "plan" },
			],
		};
		const text = (await runStormTool({ ...host, preflight: () => report }, { action: "plan", plan })).text;
		expect(text).toContain("- 막힘: 팀 승인 필요 (/storm)");
		expect(text).not.toContain("모델 인증 확인됨");
		expect(text).not.toContain("omp 모드");
	});
});

describe("plan outside plan mode is unchanged", () => {
	for (const planMode of [false, undefined]) {
		test(`planMode ${String(planMode)}: automatic delegation opens the run with the plan`, async () => {
			const { host, starts } = autoHost(planMode);
			const reply = await runStormTool(host, { action: "plan", plan });
			expect(reply.outcome).toBe("ok");
			expect(reply.text).not.toContain(PLAN_PREVIEW_HEAD);
			expect(starts).toHaveLength(1);
			expect(starts[0]!.lanes.map(lane => lane.name)).toEqual(["core", "scan"]);
		});
	}

	test("a manual session with a run active puts the plan in force", async () => {
		const f = fakeHost({ runActive: true });
		const reply = await runStormTool({ ...f.host, planMode: () => false }, { action: "plan", plan });
		expect(reply.text).toContain("실행 계획을 적용했습니다");
		expect(f.plans).toHaveLength(1);
	});
});
