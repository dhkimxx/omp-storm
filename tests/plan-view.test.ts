import { describe, expect, test } from "bun:test";
import { MAX_PLAN_VIEW_CHARS, renderPlanView } from "../src/tool/plan-view.ts";
import type { PlanLane, RunPlan, RunResult } from "../src/types.ts";

const lane = (name: string, over: Partial<PlanLane> = {}): PlanLane => ({ name, kind: "code", role: "implementer", ...over });
const plan = (lanes: PlanLane[], over: Partial<RunPlan> = {}): RunPlan => ({ lanes, workers: { implementer: 1 }, submittedAt: "2026-11-27T01:00:00.000Z", ...over });

describe("renderPlanView", () => {
	test("a run with no plan, or a plan with no lanes, has no view", () => {
		expect(renderPlanView({ runId: "r" })).toBeUndefined();
		expect(renderPlanView({ runId: "r", plan: plan([]) })).toBeUndefined();
	});

	test("every field the director submitted comes back as it was, so a replan can keep it exactly", () => {
		const text = renderPlanView({
			runId: "r1",
			plan: plan(
				[
					lane("core", {
						goal: "Goal with  spaces and \"quotes\"",
						files: ["src/a.ts", "src/b.ts"],
						isolationReason: "compare backends",
						progress: "status line",
						job: "unit",
						dependsOn: [{ lane: "scan", need: "integrated" }],
						results: [{ id: "c1", kind: "change", criterion: "visible line", path: "src/a.ts", contains: "  exact  literal", check: "typecheck" }],
					}),
				],
				{ note: "decide later", workers: { implementer: 2, reviewer: 1 } },
			),
		}) ?? "";
		for (const piece of ["r1", "core", "Goal with  spaces and \"quotes\"", "src/a.ts, src/b.ts", "compare backends", "status line", "unit", "scan(integrated)", "c1", "visible line", "\"  exact  literal\"", "typecheck", "decide later", "2026-11-27T01:00:00.000Z"]) {
			expect(text).toContain(piece);
		}
	});

	test("each result carries the state the run record holds, a missing row says so, an excluded one says it was removed", () => {
		const results: RunResult[] = [
			{ id: "a", lane: "x", state: "accepted" },
			{ id: "b", lane: "x", state: "unmet", reason: "literal missing" },
			{ id: "d", lane: "x", state: "pending", scope: "excluded-by-user" },
		];
		const text = renderPlanView({
			runId: "r",
			plan: plan([lane("x", { results: ["a", "b", "c", "d"].map(id => ({ id, kind: "artifact" as const, criterion: `crit-${id}` })) })]),
			results,
		}) ?? "";
		const line = (id: string) => text.split("\n").find(row => row.includes(`crit-${id}`)) ?? "";
		expect(line("a")).toContain("수용");
		expect(line("b")).toContain("미충족");
		expect(line("b")).toContain("literal missing");
		expect(line("c")).toContain("기록 없음");
		expect(line("d")).toContain("범위에서 뺌");
	});

	test("results an earlier plan left in the record are listed after the lanes", () => {
		const text = renderPlanView({
			runId: "r",
			plan: plan([lane("x", { results: [{ id: "kept", kind: "answer", criterion: "c" }] })]),
			results: [{ id: "kept", lane: "x", state: "accepted" }, { id: "old-one", lane: "gone", state: "accepted" }, { id: "old-two", state: "pending" }],
		}) ?? "";
		const tail = text.slice(text.indexOf("이전 계획"));
		expect(tail).toContain("old-one");
		expect(tail).toContain("old-two");
		expect(tail).not.toContain("kept");
	});

	test("a plan too long for one view is cut at a lane and says how many were left out", () => {
		const lanes = Array.from({ length: 20 }, (_, i) => lane(`lane-${i}`, { goal: "g".repeat(3_000) }));
		const text = renderPlanView({ runId: "r", plan: plan(lanes) }) ?? "";
		expect(text.length).toBeLessThanOrEqual(MAX_PLAN_VIEW_CHARS + 500);
		expect(text).toContain("lane-0");
		expect(text).not.toContain("lane-19");
		expect(text).toMatch(/외 \d+개 레인/);
		// The first lane is always shown, however long.
		const one = renderPlanView({ runId: "r", plan: plan([lane("only", { goal: "g".repeat(MAX_PLAN_VIEW_CHARS * 2) })]) }) ?? "";
		expect(one).toContain("only");
	});
});
