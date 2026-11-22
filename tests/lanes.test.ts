import { expect, test } from "bun:test";
import { RunLanes } from "../src/runtime/lanes.ts";
import type { PlanLane, RunPlan } from "../src/types.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const team = teamOf({ implementer: "fake/dev", explorer: "fake/look" });
const lane = (name: string, goal: string): PlanLane => ({ name, kind: "code", role: "implementer", files: [`${name}.ts`], goal });
const plan = (...lanes: PlanLane[]): RunPlan => ({ lanes, workers: { implementer: lanes.length }, submittedAt: "2026-01-01T00:00:00Z" });

function assigned(work: RunLanes, p: RunPlan, name: string): string {
	const value = work.assign({ agent: "storm-implementer", task: "Implement", name }, p, team);
	if (!value.ok || typeof value.input.name !== "string") throw new Error("test task not assigned");
	return value.input.name;
}

test("two same-role lanes require actual distinct assignments and a spawned worker cannot cover another lane", () => {
	const work = new RunLanes("run-example");
	const p = plan(lane("api", "Implement API"), lane("view", "Render output"));
	expect(work.assign({ agent: "storm-implementer", task: "Implement" }, p, team).ok).toBe(false);
	expect(work.assign({ tasks: [{ agent: "storm-implementer", name: "api" }, { agent: "storm-implementer", name: "api" }] }, p, team).ok).toBe(false);
	const id = assigned(work, p, "api");
	expect(work.admit({ spawnKey: id, agent: "storm-explorer", outcome: "routed" })).toBeUndefined();
	expect(work.admit({ spawnKey: id, agent: "storm-implementer", outcome: "routed" })).toBe("api");
	expect(work.remaining(p, [agentEntry({ id, requests: 1, state: "idle" })], new Set())).toEqual(["view"]);
});

test("failed or never-run workers cannot finish a lane, and a materially revised lane drops old coverage", () => {
	const work = new RunLanes("run-example");
	const old = plan(lane("api", "Implement API"));
	const denied = assigned(work, old, "api");
	work.admit({ spawnKey: denied, agent: "storm-implementer", outcome: "blocked" });
	expect(work.remaining(old, [agentEntry({ id: denied, requests: 1, state: "idle" })], new Set())).toEqual(["api"]);
	const id = assigned(work, old, "api");
	work.admit({ spawnKey: id, agent: "storm-implementer", outcome: "routed" });
	expect(work.remaining(old, [agentEntry({ id, requests: 0, state: "idle" })], new Set())).toEqual(["api"]);
	const agent = agentEntry({ id, requests: 1, state: "idle" });
	expect(work.remaining(old, [agent], new Set([id]))).toEqual(["api"]);
	expect(work.remaining(old, [{ ...agent, lastWorkFailed: true }], new Set())).toEqual(["api"]);
	expect(work.remaining({ ...old, submittedAt: "2026-01-02T00:00:00Z" }, [agent], new Set())).toEqual([]);
	expect(work.remaining(plan(lane("api", "Replace API")), [agent], new Set())).toEqual(["api"]);
});
