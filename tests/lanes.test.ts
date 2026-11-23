import { expect, test } from "bun:test";
import { replanConflict, RunLanes } from "../src/runtime/lanes.ts";
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

test("a progress update keeps settled evidence, a new or failed lane never inherits it", () => {
	const work = new RunLanes("run-example");
	const initial = plan(lane("probe", "Run experiment A"));
	const id = assigned(work, initial, "probe");
	work.admit({ spawnKey: id, agent: "storm-implementer", outcome: "routed" });
	const agent = agentEntry({ id, requests: 1, state: "idle" });
	// The supervisor's status goes to progress; the new experiment is a new lane with no evidence yet.
	const next = plan(
		{ ...lane("probe", "Run experiment A"), progress: "(완료) A16 figure 3.2" },
		lane("probe-2", "Run experiment B"),
	);
	expect(replanConflict(initial, next)).toBeUndefined();
	expect(work.remaining(next, [agent], new Set())).toEqual(["probe-2"]);
	// Self-reported completion cannot keep a failed worker's lane done.
	expect(work.remaining(next, [{ ...agent, lastWorkFailed: true }], new Set())).toEqual(["probe", "probe-2"]);
	// A new name never inherits the settled evidence of the lane it replaces.
	const renamed = plan({ ...lane("probe-b", "Run experiment A"), progress: "완료" });
	expect(replanConflict(initial, renamed)).toBeUndefined();
	expect(work.remaining(renamed, [agent], new Set())).toEqual(["probe-b"]);
	// A never-run lane stays pending whatever its progress says.
	expect(work.remaining(plan({ ...lane("ghost", "New work"), progress: "완료 (probe-2)" }), [agent], new Set())).toEqual(["ghost"]);
	// Scope compares as a normalized set, agreeing with replanConflict.
	const other = new RunLanes("run-files");
	const files = plan({ ...lane("probe", "Run experiment A"), files: ["b.ts", "a.ts"] });
	const filesId = assigned(other, files, "probe");
	other.admit({ spawnKey: filesId, agent: "storm-implementer", outcome: "routed" });
	const reordered = plan({ ...lane("probe", "Run experiment A"), files: ["a.ts", "b.ts", "a.ts"] });
	expect(replanConflict(files, reordered)).toBeUndefined();
	expect(other.remaining(reordered, [agentEntry({ id: filesId, requests: 1, state: "idle" })], new Set())).toEqual([]);
});

test("replanConflict rejects changing a lane's stable identity under the same name", () => {
	const base = plan({ ...lane("api", "Implement API"), files: ["b.ts", "a.ts"] });
	expect(replanConflict(undefined, base)).toBeUndefined();
	const same = plan(
		{ ...lane("api", "  Implement API  "), files: ["a.ts", "b.ts", "a.ts"] },
		lane("view", "Render output"),
	);
	expect(replanConflict(base, same)).toBeUndefined();
	// Removing a lane is allowed; a new name starts with no evidence.
	expect(replanConflict(same, plan({ ...lane("api", "Implement API"), files: ["b.ts", "a.ts"] }))).toBeUndefined();
	const goal = replanConflict(base, plan({ ...lane("api", "Implement API v2"), files: ["b.ts", "a.ts"] }));
	expect(goal).toContain("'api'");
	expect(goal).toContain("goal");
	expect(goal).toContain("progress");
	expect(goal).toContain("새 레인 이름");
	expect(goal).toContain("증거");
	expect(replanConflict(base, plan({ ...lane("api", "Implement API"), kind: "run" }))).toContain("kind");
	expect(replanConflict(base, plan({ ...lane("api", "Implement API"), role: "reviewer" }))).toContain("role");
	expect(replanConflict(base, plan({ ...lane("api", "Implement API"), files: ["a.ts"] }))).toContain("files");
	expect(replanConflict(base, plan({ ...lane("api", "Other work"), kind: "run" }))).toContain("goal, kind");
});
