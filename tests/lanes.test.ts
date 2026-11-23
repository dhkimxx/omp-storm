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

test("shared placement flags only planned isolation lanes and strips an unplanned claim", () => {
	const work = new RunLanes("run-placement");
	const p = plan(lane("api", "Implement API"), { ...lane("probe", "Run experiment"), kind: "run", isolationReason: "independent result" });
	const placed = work.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "api", task: "Implement", isolated: true },
				{ agent: "storm-implementer", name: "probe", task: "Probe" },
			],
		},
		p,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const tasks = placed.input.tasks as Array<Record<string, unknown>>;
	expect(tasks[0]).not.toHaveProperty("isolated");
	expect(tasks[1]).toMatchObject({ name: "probe", isolated: true });
	// The manual handle is kept: only a selected lane's placement changes.
	const flat = work.place({ agent: "storm-implementer", name: "probe", task: "Probe" }, p, team, { host: { enabled: true, apply: false } });
	expect(flat.ok && flat.input).toMatchObject({ name: "probe", isolated: true });
});

test("a batch-wide isolated shorthand cannot leak into shared items", () => {
	const work = new RunLanes("run-batch");
	const sharedOnly = plan(lane("api", "Implement API"));
	const plain = work.place(
		{ isolated: true, tasks: [{ agent: "storm-implementer", name: "api", task: "Implement" }] },
		sharedOnly,
		team,
	);
	expect(plain.ok).toBe(true);
	if (!plain.ok) return;
	expect(plain.input).not.toHaveProperty("isolated");
	expect((plain.input.tasks as Array<Record<string, unknown>>)[0]).not.toHaveProperty("isolated");

	const selected = plan(lane("api", "Implement API"), { ...lane("probe", "Run experiment"), kind: "run", isolationReason: "independent" });
	const placed = work.place(
		{
			isolated: true,
			tasks: [
				{ agent: "storm-implementer", name: "api", task: "Implement" },
				{ agent: "storm-implementer", name: "probe", task: "Probe" },
			],
		},
		selected,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	expect(placed.input).not.toHaveProperty("isolated");
	const tasks = placed.input.tasks as Array<Record<string, unknown>>;
	expect(tasks[0]).not.toHaveProperty("isolated");
	expect(tasks[1]).toMatchObject({ isolated: true });
});

test("isolation placement fails closed on unknown, disabled or auto-applying host capability", () => {
	const work = new RunLanes("run-capability");
	const p = plan({ ...lane("probe", "Run experiment"), kind: "run", isolationReason: "independent result" });
	const input = { agent: "storm-implementer", name: "probe", task: "Probe" };
	const unknown = work.place(input, p, team);
	expect(unknown.ok).toBe(false);
	if (!unknown.ok) {
		expect(unknown.reason).toContain("task.isolation.enabled");
		expect(unknown.reason).toContain("omp config set task.isolation.enabled true");
	}
	const disabled = work.place(input, p, team, { host: { enabled: false, apply: false } });
	expect(disabled.ok).toBe(false);
	if (!disabled.ok) expect(disabled.reason).toContain("task.isolation.enabled=false");
	const applying = work.place(input, p, team, { host: { enabled: true, apply: true } });
	expect(applying.ok).toBe(false);
	if (!applying.ok) {
		expect(applying.reason).toContain("omp config set task.isolation.apply false");
		expect(applying.reason).toContain("patch/branch");
		expect(applying.reason).toContain("공유 레인");
	}
});

test("a legacy isolated team isolates every lane including the final reviewer, and requires host isolation", () => {
	const reviewTeam = teamOf({ implementer: "fake/dev", reviewer: "fake/rev" }, { isolation: "isolated" });
	const work = new RunLanes("run-legacy");
	const p: RunPlan = {
		lanes: [
			{ name: "api", kind: "code", role: "implementer", goal: "Implement" },
			{ name: "check", kind: "review", role: "reviewer", goal: "Review" },
		],
		workers: { implementer: 1, reviewer: 1 },
		submittedAt: "2026-01-01T00:00:00Z",
	};
	const placed = work.place(
		{ tasks: [{ agent: "storm-implementer", name: "api", task: "Implement" }, { agent: "storm-reviewer", name: "check", task: "Review" }] },
		p,
		reviewTeam,
		{ host: { enabled: true, apply: true } },
	);
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	const tasks = placed.input.tasks as Array<Record<string, unknown>>;
	expect(tasks[0]).toMatchObject({ isolated: true });
	// The operator's isolation commitment includes the final reviewer; omp's apply semantics stay untouched.
	expect(tasks[1]).toMatchObject({ isolated: true });
	const blocked = work.place({ agent: "storm-implementer", name: "api", task: "Implement" }, p, reviewTeam);
	expect(blocked.ok).toBe(false);
});

test("an unbound direct task cannot claim an isolated lane, and a rejected batch reserves nothing", () => {
	const work = new RunLanes("run-reserve");
	const p = plan({ ...lane("probe", "Run experiment"), kind: "run", isolationReason: "independent result" });
	const direct = work.place({ agent: "storm-implementer", task: "Probe", isolated: true }, undefined, team);
	expect(direct.ok).toBe(false);
	if (!direct.ok) expect(direct.reason).toContain("계획에 없는");
	expect(work.place({ agent: "storm-implementer", task: "Probe" }, undefined, team).ok).toBe(true);
	const rejected = work.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "probe", task: "Probe" },
				{ agent: "storm-implementer", task: "Stray", isolated: true },
			],
		},
		p,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(rejected.ok).toBe(false);
	// The rejected batch did not advance the reservation serial or leave a lane behind.
	const assigned = work.assign({ agent: "storm-implementer", name: "probe", task: "Probe" }, p, team, { host: { enabled: true, apply: false } });
	expect(assigned.ok).toBe(true);
	if (assigned.ok) expect(assigned.input.name).toContain("run-reserve-lane-1");
});

test("isolation presence is lane identity while its wording is not, and shared evidence keeps covering", () => {
	const work = new RunLanes("run-identity");
	const shared = plan(lane("probe", "Run experiment"));
	const id = assigned(work, shared, "probe");
	work.admit({ spawnKey: id, agent: "storm-implementer", outcome: "routed" });
	const agent = agentEntry({ id, requests: 1, state: "idle" });
	const first = plan({ ...lane("probe", "Run experiment"), isolationReason: "first reason" });
	const second = plan({ ...lane("probe", "Run experiment"), isolationReason: "rewritten reason" });
	expect(replanConflict(shared, first)).toContain("isolation");
	// A new placement does not inherit the old shared worker's evidence.
	expect(work.remaining(first, [agent], new Set())).toEqual(["probe"]);
	expect(replanConflict(first, second)).toBeUndefined();
	expect(work.remaining(second, [agent], new Set())).toEqual(["probe"]);
	const isolatedWork = new RunLanes("run-identity-isolated");
	const placed = isolatedWork.assign({ agent: "storm-implementer", name: "probe", task: "Probe" }, first, team, { host: { enabled: true, apply: false } });
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	isolatedWork.admit({ spawnKey: placed.input.name as string, agent: "storm-implementer", outcome: "routed" });
	const isolatedAgent = agentEntry({ id: placed.input.name as string, requests: 1, state: "idle" });
	// Changing only the reason's wording keeps the already admitted evidence.
	expect(isolatedWork.remaining(second, [isolatedAgent], new Set())).toEqual([]);
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
