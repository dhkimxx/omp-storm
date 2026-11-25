import { expect, test } from "bun:test";
import { PENDING_WRITE_MS, replanConflict, RunLanes } from "../src/runtime/lanes.ts";
import type { LanePolicy } from "../src/policy/capability.ts";
import { reservedWorkers } from "../src/policy/spawn.ts";
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
	// The batch placement holds 'probe' until its spawn is correlated; the host never started it here.
	work.cancel("probe");
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
	// The first placement never became a worker; release its write scope before placing the same lane again.
	work.cancel("api");

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

test("a planned batch requires one concrete lane per item before any reservation, including team isolation", () => {
	const work = new RunLanes("run-atomic");
	const p = plan(lane("A", "Implement A"), lane("B", "Implement B"), lane("C", "Implement C"));
	// A whole-team-isolated request is not an exemption: the unassigned second item fails before item A reserves.
	const isolated = teamOf({ implementer: "fake/dev" }, { isolation: "isolated" });
	const mixed = work.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "A", task: "A" },
				{ agent: "storm-implementer", task: "Missing" },
			],
		},
		p,
		isolated,
		{ host: { enabled: true, apply: true } },
	);
	expect(mixed.ok).toBe(false);
	// The refused batch left A free: the same approved batch can run as a whole and puts both items in isolation.
	const good = work.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "A", task: "A" },
				{ agent: "storm-implementer", name: "B", task: "B" },
				{ agent: "storm-implementer", name: "C", task: "C" },
			],
		},
		p,
		isolated,
		{ host: { enabled: true, apply: true } },
	);
	expect(good.ok).toBe(true);
	if (good.ok) {
		const tasks = good.input.tasks as Array<Record<string, unknown>>;
		expect(tasks[0]).toMatchObject({ isolated: true });
		expect(tasks[1]).toMatchObject({ isolated: true });
		expect(tasks[2]).toMatchObject({ isolated: true });
	}

	// A planned isolated item must name the lane its claim belongs to. Unplanned, duplicate and wrong-role items all
	// fail before the earlier valid item can reserve its write scope.
	const selected = plan(
		{ ...lane("probe", "Run experiment"), kind: "run", isolationReason: "independent result" },
		lane("api", "Implement API"),
		lane("extra", "Implement Extra"),
	);
	const shared = new RunLanes("run-atomic-shared");
	const unplanned = shared.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "api", task: "API" },
				{ agent: "storm-implementer", task: "Stray", isolated: true },
			],
		},
		selected,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(unplanned.ok).toBe(false);
	if (!unplanned.ok) expect(unplanned.reason).toContain("계획에 없는");
	const duplicate = shared.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "probe", task: "Probe", isolated: true },
				{ agent: "storm-implementer", name: "probe", task: "Probe", isolated: true },
			],
		},
		selected,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(duplicate.ok).toBe(false);
	if (!duplicate.ok) expect(duplicate.reason).toContain("이미 사용");
	const wrongRole = shared.place(
		{ tasks: [{ agent: "storm-explorer", name: "probe", task: "Probe", isolated: true }] },
		selected,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(wrongRole.ok).toBe(false);
	if (!wrongRole.ok) expect(wrongRole.reason).toContain("역할");
	// The same batch is accepted after the atomic refusals: probe reserves its isolated lane and api its shared one.
	const approved = shared.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "probe", task: "Probe" },
				{ agent: "storm-implementer", name: "api", task: "API" },
			],
		},
		selected,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(approved.ok).toBe(true);
	if (approved.ok) {
		const tasks = approved.input.tasks as Array<Record<string, unknown>>;
		expect(tasks[0]).toMatchObject({ isolated: true });
		expect(tasks[1]).not.toHaveProperty("isolated");
	}
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
	// A prerequisite edge is plan input, not evidence identity: T04 replans rewrite the review's edges under its name.
	expect(replanConflict(base, plan({ ...lane("api", "Implement API"), files: ["b.ts", "a.ts"], dependsOn: [{ lane: "view", need: "reviewable" }] }))).toBeUndefined();
	expect(replanConflict(base, plan({ ...lane("api", "Other work"), kind: "run" }))).toContain("goal, kind");
});

/** A prerequisite lane's ledger facts as the controller would hand them to admission. */
function readinessOf(state: "pending" | "unmet" | "reviewable" | "accepted", integrated = false, running = false) {
	return new Map([
		[
			"producer",
			{
				results: [{ id: "r1", state, integrated, version: "0123456789abcdef", path: "out.txt" }],
				settled: state !== "pending",
				integrated,
				running,
			},
		],
	]);
}

const producer: PlanLane = {
	name: "producer",
	kind: "code",
	role: "implementer",
	files: ["out.txt"],
	results: [{ id: "r1", kind: "change", criterion: "out.txt holds ok", path: "out.txt", contains: "ok" }],
};

function consumer(need: "result" | "integrated" | "reviewable"): PlanLane {
	return {
		name: "consumer",
		kind: "explore",
		role: "explorer",
		results: [{ id: "c1", kind: "answer", criterion: "report the producer result" }],
		dependsOn: [{ lane: "producer", need }],
	};
}

test("a consumer is refused until its declared prerequisite state holds, and missing facts fail closed", () => {
	const work = new RunLanes("run-dep");
	const consumerPlan = plan(producer, consumer("result"));
	const place = () => work.place({ agent: "storm-explorer", name: "consumer", task: "Compare" }, consumerPlan, team, { readiness: readinessOf("accepted") });
	const missing = work.place({ agent: "storm-explorer", name: "consumer", task: "Compare" }, consumerPlan, team);
	expect(missing.ok).toBe(false);
	if (!missing.ok) expect(missing.code).toBe("lane-dependency");
	expect(work.place({ agent: "storm-explorer", name: "consumer", task: "Compare" }, consumerPlan, team, { readiness: readinessOf("pending") }).ok).toBe(false);
	expect(work.place({ agent: "storm-explorer", name: "consumer", task: "Compare" }, consumerPlan, team, { readiness: readinessOf("reviewable") }).ok).toBe(false);
	const accepted = place();
	expect(accepted.ok).toBe(true);
	// The accepted placement holds its lane until its spawn is correlated; the host never started it here.
	work.cancel("consumer");
	// A producer that is running again may still change the result: an accepted old row is not final input.
	expect(work.place({ agent: "storm-explorer", name: "consumer", task: "Compare" }, consumerPlan, team, { readiness: readinessOf("accepted", false, true) }).ok).toBe(false);
	// The accepted reference is short, versioned and path-bearing; a host path or model prose never appears.
	if (accepted.ok) expect(String(accepted.input.task)).toContain("r1=accepted@01234567 out.txt");
	// An `integrated` edge additionally needs the current parent, not just an accepted artifact.
	const integratedPlan = plan(producer, consumer("integrated"));
	expect(work.place({ agent: "storm-explorer", name: "consumer", task: "Build" }, integratedPlan, team, { readiness: readinessOf("accepted", false) }).ok).toBe(false);
	const ok = work.place({ agent: "storm-explorer", name: "consumer", task: "Build" }, integratedPlan, team, { readiness: readinessOf("accepted", true) });
	expect(ok.ok).toBe(true);
	if (ok.ok) expect(String(ok.input.task)).toContain("r1=accepted·통합@01234567 out.txt");
	work.cancel("consumer");
	// `reviewable` admits a submission to judge, including one whose result is only reviewable.
	expect(work.place({ agent: "storm-explorer", name: "consumer", task: "Review" }, plan(producer, consumer("reviewable")), team, { readiness: readinessOf("reviewable") }).ok).toBe(true);
});

test("a shared-write batch is all-or-nothing and a settled worker frees its scope", () => {
	const shared = plan(
		{ name: "W0", kind: "run", role: "quick", files: ["shared.txt"] },
		{ name: "X0", kind: "code", role: "quick", files: ["shared.txt"] },
		{ name: "X1", kind: "code", role: "quick", files: ["other.txt"] },
	);
	const work = new RunLanes("run-write");
	expect(work.place({ agent: "storm-quick", name: "W0", task: "Write" }, shared, team).ok).toBe(true);
	work.admit({ spawnKey: "W0", agent: "storm-quick", outcome: "routed" }, { plan: shared, config: team });
	const running = [agentEntry({ id: "W0", name: "storm-quick", role: "quick", state: "running" })];
	const refused = work.place(
		{
			tasks: [
				{ agent: "storm-quick", name: "X0", task: "Conflict" },
				{ agent: "storm-quick", name: "X1", task: "Independent" },
			],
		},
		shared,
		team,
		{ agents: running },
	);
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.code).toBe("lane-write");
	// No reservation leaked from the refused batch: the disjoint item alone is admitted, even while W0 writes.
	expect(work.place({ agent: "storm-quick", name: "X1", task: "Independent" }, shared, team, { agents: running }).ok).toBe(true);
	// The writer's own scope is still held; settling it frees the conflicting item.
	expect(work.place({ agent: "storm-quick", name: "X0", task: "Conflict" }, shared, team, { agents: running }).ok).toBe(false);
	work.releaseAgent("W0");
	expect(work.place({ agent: "storm-quick", name: "X0", task: "Conflict" }, shared, team, { agents: running }).ok).toBe(true);
});

test("unknown writable scopes serialize while read-only and private outputs run in parallel", () => {
	const unknown = plan(
		{ name: "U0", kind: "code", role: "implementer", goal: "Undeclared scope" },
		{ name: "U1", kind: "code", role: "implementer", files: ["other.txt"], goal: "Other" },
	);
	const work = new RunLanes("run-unknown");
	expect(work.place({ agent: "storm-implementer", name: "U0", task: "Work" }, unknown, team).ok).toBe(true);
	expect(work.place({ agent: "storm-implementer", name: "U1", task: "Work" }, unknown, team).ok).toBe(false);

	const read = plan(
		{ name: "R0", kind: "explore", role: "explorer", goal: "Read" },
		{ name: "R1", kind: "explore", role: "explorer", goal: "Read" },
	);
	expect(
		work.place({ tasks: [{ agent: "storm-explorer", name: "R0", task: "Read" }, { agent: "storm-explorer", name: "R1", task: "Read" }] }, read, team).ok,
	).toBe(true);

	const isolated = plan(
		{ name: "AB0", kind: "run", role: "quick", files: ["parallel.txt"], isolationReason: "independent A" },
		{ name: "AB1", kind: "run", role: "quick", files: ["parallel.txt"], isolationReason: "independent B" },
	);
	expect(
		work.place(
			{ tasks: [{ agent: "storm-quick", name: "AB0", task: "A" }, { agent: "storm-quick", name: "AB1", task: "B" }] },
			isolated,
			team,
			{ host: { enabled: true, apply: false } },
		).ok,
	).toBe(true);
});

test("a cancelled placement releases its write and a work follow-up passes the same gate", () => {
	const shared = plan(
		{ name: "H0", kind: "code", role: "implementer", files: ["shared.txt"] },
		{ name: "W0", kind: "run", role: "quick", files: ["shared.txt"] },
		{ name: "R0", kind: "explore", role: "explorer", goal: "Read" },
	);
	const work = new RunLanes("run-follow");
	expect(work.place({ agent: "storm-quick", name: "W0", task: "Write" }, shared, team).ok).toBe(true);
	work.cancel("W0");
	expect(work.place({ agent: "storm-implementer", name: "H0", task: "Write" }, shared, team).ok).toBe(true);
	work.admit({ spawnKey: "H0", agent: "storm-implementer", outcome: "routed" }, { plan: shared, config: team });
	const running = [agentEntry({ id: "H0", state: "running" })];
	expect(work.checkFollowUp({ agentId: "X0", agent: "storm-implementer", role: "implementer", lane: shared.lanes[0]!, isolated: false, agents: running }).ok).toBe(false);
	expect(work.checkFollowUp({ agentId: "R0", agent: "storm-explorer", role: "explorer", lane: shared.lanes[2]!, isolated: false, agents: running }).ok).toBe(true);
	const own = work.checkFollowUp({ agentId: "H0", agent: "storm-implementer", role: "implementer", lane: shared.lanes[0]!, isolated: false, agents: running });
	expect(own.ok).toBe(true);
	if (own.ok) work.finishFollowUp(own.token, true);
	work.releaseAgent("H0");
	expect(work.checkFollowUp({ agentId: "X0", agent: "storm-implementer", role: "implementer", lane: shared.lanes[0]!, isolated: false, agents: [] }).ok).toBe(true);
});

test("a reserved or running lane refuses a second independent dispatch even when it only reads, and settling frees it", () => {
	const reads = plan(
		{ name: "R0", kind: "explore", role: "explorer", goal: "Read" },
		{ name: "R1", kind: "explore", role: "explorer", goal: "Read more" },
	);
	const work = new RunLanes("run-busy");
	const read = (name: string, agents?: ReturnType<typeof agentEntry>[]) =>
		work.place({ agent: "storm-explorer", name, task: "Read" }, reads, team, agents === undefined ? {} : { agents });
	expect(read("R0").ok).toBe(true);
	// Before any spawn correlation a read-only lane has no write reservation, yet the first attempt is already reserved.
	const second = read("R0");
	expect(second.ok).toBe(false);
	if (!second.ok) expect(second.code).toBe("lane-busy");
	// A batch with one busy lane refuses whole and leaves nothing held for its other item.
	const batch = work.place({ tasks: [{ agent: "storm-explorer", name: "R0", task: "Read" }, { agent: "storm-explorer", name: "R1", task: "Read" }] }, reads, team);
	expect(batch.ok).toBe(false);
	expect(read("R1").ok).toBe(true);
	work.cancel("R1");
	work.admit({ spawnKey: "R0", agent: "storm-explorer", outcome: "routed" }, { plan: reads, config: team });
	// Admitted: the agent's own state decides, including the moment before the host list shows it.
	expect(read("R0", []).ok).toBe(false);
	expect(read("R0", [agentEntry({ id: "R0", state: "running" })]).ok).toBe(false);
	expect(read("R0", [agentEntry({ id: "R0", state: "idle" })]).ok).toBe(true);
});

test("a placement that never reached a spawn stops holding its lane when cancelled or after the pending window", () => {
	const reads = plan({ name: "R0", kind: "explore", role: "explorer", goal: "Read" });
	const work = new RunLanes("run-stale");
	expect(work.place({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { now: 0 }).ok).toBe(true);
	expect(work.laneBusy("R0", [], 1)).toBe(true);
	work.cancel("R0");
	expect(work.laneBusy("R0", [], 2)).toBe(false);
	expect(work.place({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { now: 3 }).ok).toBe(true);
	expect(work.place({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { now: PENDING_WRITE_MS + 4 }).ok).toBe(true);
});

test("a work follow-up applies the actual policy, canonical files and auto flag exactly as a first task", () => {
	const manual = plan(
		{ name: "A", kind: "code", role: "quick", files: ["a"] },
		{ name: "B", kind: "code", role: "quick", files: ["b"] },
	);
	const bash: LanePolicy = { kind: "unknown", reason: "임의 실행 도구" };
	const paths = (value: string): LanePolicy => ({ kind: "paths", paths: [value], reason: "path-only manual writer" });
	const follow = (work: RunLanes, id: string, lane: PlanLane, extra: Partial<Parameters<RunLanes["checkFollowUp"]>[0]>) =>
		work.checkFollowUp({ agentId: id, agent: "storm-quick", role: "quick", lane, isolated: false, agents: [agentEntry({ id: "A0", state: "running" })], ...extra });
	// Declared files alone would look disjoint; the bash-capable authority is one unknown writer.
	const serial = new RunLanes("run-follow-bash");
	const first = follow(serial, "A0", manual.lanes[0]!, { policy: bash });
	expect(first.ok).toBe(true);
	const denied = follow(serial, "B0", manual.lanes[1]!, { policy: bash });
	expect(denied.ok).toBe(false);
	if (!denied.ok) expect(denied.code).toBe("lane-write");
	// A path-only authority with disjoint canonical files may still run beside it; overlapping canonical files may not.
	const disjoint = new RunLanes("run-follow-paths");
	expect(follow(disjoint, "A0", manual.lanes[0]!, { policy: paths("a"), canonicalFiles: ["a"] }).ok).toBe(true);
	expect(follow(disjoint, "B0", manual.lanes[1]!, { policy: paths("b"), canonicalFiles: ["b"] }).ok).toBe(true);
	const overlap = new RunLanes("run-follow-overlap");
	expect(follow(overlap, "A0", manual.lanes[0]!, { policy: paths("a"), canonicalFiles: ["shared"] }).ok).toBe(true);
	expect(follow(overlap, "B0", manual.lanes[1]!, { policy: paths("b"), canonicalFiles: ["shared/inner"] }).ok).toBe(false);
	// Automatic delegation serializes every shared writer even with disjoint paths.
	const auto = new RunLanes("run-follow-auto");
	expect(follow(auto, "A0", manual.lanes[0]!, { policy: paths("a"), canonicalFiles: ["a"], auto: true }).ok).toBe(true);
	expect(follow(auto, "B0", manual.lanes[1]!, { policy: paths("b"), canonicalFiles: ["b"], auto: true }).ok).toBe(false);
	// A read authority takes no write scope at all.
	expect(follow(auto, "R0", manual.lanes[1]!, { policy: { kind: "read", reason: "read" } }).ok).toBe(true);
});

test("a work follow-up holds its lane from admission to the started turn; a progress note holds nothing", () => {
	const reads = plan({ name: "R0", kind: "explore", role: "explorer", goal: "Read" });
	const lane = reads.lanes[0]!;
	const idle = [agentEntry({ id: "R0", state: "idle" })];
	const follow = (work: RunLanes, extra: { progress?: boolean; callId?: string } = {}) =>
		work.checkFollowUp({ agentId: "R0", agent: "storm-explorer", role: "explorer", lane, isolated: false, agents: idle, ...extra });
	const place = (work: RunLanes, agents = idle) => work.place({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { agents });
	// A quiet note reserves nothing.
	const quiet = new RunLanes("run-quiet");
	const note = follow(quiet, { progress: true });
	expect(note.ok).toBe(true);
	if (note.ok) quiet.finishFollowUp(note.token, true);
	expect(place(quiet).ok).toBe(true);
	// A work note holds the lane although the agent still looks idle; a stale settle of the previous turn does not end it.
	const work = new RunLanes("run-window");
	const admitted = follow(work);
	expect(admitted.ok).toBe(true);
	if (admitted.ok) work.finishFollowUp(admitted.token, true);
	const refused = place(work);
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.code).toBe("lane-busy");
	work.releaseAgent("R0");
	expect(place(work).ok).toBe(false);
	// A second independent reactivation of the same lane by another agent is refused too.
	const other = work.checkFollowUp({ agentId: "R9", agent: "storm-explorer", role: "explorer", lane, isolated: false, agents: [...idle, agentEntry({ id: "R9", state: "idle" })] });
	expect(other.ok).toBe(false);
	// The turn starts: the running state is the reservation, and the settled turn frees the lane.
	work.agentStarted("R0");
	expect(place(work, [agentEntry({ id: "R0", state: "running" })]).ok).toBe(false);
	expect(place(work, idle).ok).toBe(true);
});

test("a failed follow-up or task call releases only its own reservation by call id, never a newer one", () => {
	const reads = plan({ name: "R0", kind: "explore", role: "explorer", goal: "Read" });
	const lane = reads.lanes[0]!;
	const idle = [agentEntry({ id: "R0", state: "idle" })];
	const follow = (work: RunLanes, callId: string) =>
		work.checkFollowUp({ agentId: "R0", agent: "storm-explorer", role: "explorer", lane, isolated: false, agents: idle, callId });
	const work = new RunLanes("run-call");
	const first = follow(work, "c1");
	expect(first.ok).toBe(true);
	if (first.ok) work.finishFollowUp(first.token, true);
	// A preflight that refused its own turn releases the hold it created, by identity.
	const second = follow(work, "c1");
	expect(second.ok).toBe(true);
	if (second.ok) work.finishFollowUp(second.token, false);
	expect(work.laneBusy("R0", idle)).toBe(true);
	// An unrelated call's failure releases nothing; the follow-up's own failure closes its window.
	expect(work.releaseCall("c-other")).toEqual([]);
	expect(work.laneBusy("R0", idle)).toBe(true);
	work.releaseCall("c1");
	expect(work.laneBusy("R0", idle)).toBe(false);
	// A started turn is running work: a late failure report for its call cannot release it.
	const third = follow(work, "c3");
	if (third.ok) work.finishFollowUp(third.token, true);
	work.agentStarted("R0");
	work.releaseCall("c3");
	expect(work.laneBusy("R0", [agentEntry({ id: "R0", state: "running" })])).toBe(true);
	// An auto-rewritten placement is found by its call id, with the rewritten handle returned for slot cleanup.
	const auto = new RunLanes("run-auto-call");
	const placed = auto.assign({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { callId: "t1" });
	expect(placed.ok).toBe(true);
	const rewritten = placed.ok ? String(placed.input.name) : "";
	expect(rewritten).toContain("run-auto-call-lane-");
	expect(auto.releaseCall("t0")).toEqual([]);
	expect(auto.laneBusy("R0")).toBe(true);
	expect(auto.releaseCall("t1")).toEqual([rewritten]);
	expect(auto.laneBusy("R0")).toBe(false);
	expect(auto.assign({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { callId: "t2" }).ok).toBe(true);
});

test("a progress-only note passes the writer and pending-lane guards without reserving what the same work cannot", () => {
	const bash: LanePolicy = { kind: "unknown", reason: "임의 실행 도구" };
	const shared = plan(
		{ name: "H0", kind: "code", role: "implementer", files: ["tracked.txt"] },
		{ name: "W0", kind: "run", role: "quick", files: ["tracked.txt"] },
	);
	const teamWithQuick = teamOf({ implementer: "fake/dev", quick: "fake/quick" });
	const follow = (work: RunLanes, lane: PlanLane, extra: Partial<Parameters<RunLanes["checkFollowUp"]>[0]>) =>
		work.checkFollowUp({
			agentId: "H0",
			agent: "storm-implementer",
			role: "implementer",
			lane,
			policy: bash,
			isolated: false,
			plan: shared,
			config: teamWithQuick,
			maxConcurrency: 2,
			...extra,
		});

	// A real bash-capable authority is one unknown shared scope: W0 owns the tree, so the work message collides.
	const runId = "run-progress-writer";
	const writing = new RunLanes(runId);
	expect(writing.place({ agent: "storm-quick", name: "W0", task: "Write" }, shared, teamWithQuick, { policies: new Map([["W0", bash]]) }).ok).toBe(true);
	writing.admit({ spawnKey: "W0", agent: "storm-quick", outcome: "routed" }, { plan: shared, config: teamWithQuick });
	const runningW0 = [agentEntry({ id: "W0", state: "running" })];
	const denied = follow(writing, shared.lanes[0]!, { runId, agents: runningW0 });
	expect(denied.ok).toBe(false);
	if (!denied.ok) expect(denied.code).toBe("lane-write");
	// The identical progress note is not work: it is admitted without a write lease, slot or lane hold.
	const note = follow(writing, shared.lanes[0]!, { runId, agents: runningW0, progress: true, callId: "progress-1" });
	expect(note.ok).toBe(true);
	if (note.ok) {
		expect(note.reserved).toBeUndefined();
		writing.finishFollowUp(note.token, true);
	}
	expect(reservedWorkers(runId)).toEqual([]);
	expect(writing.laneBusy("H0", [agentEntry({ id: "H0", state: "idle" })])).toBe(false);
	// It leaves W0's ownership alone: the same work message is still refused after the note.
	const after = follow(writing, shared.lanes[0]!, { runId, agents: runningW0 });
	expect(after.ok).toBe(false);
	if (!after.ok) expect(after.code).toBe("lane-write");

	// A pending placement of the same logical lane holds it: the work message is lane-busy, the note is not.
	const pending = new RunLanes("run-progress-pending");
	expect(pending.place({ agent: "storm-implementer", name: "H0", task: "Write" }, shared, teamWithQuick, { policies: new Map([["H0", bash]]) }).ok).toBe(true);
	const idleH0 = [agentEntry({ id: "H0", state: "idle" })];
	const pendingWork = follow(pending, shared.lanes[0]!, { agents: idleH0 });
	expect(pendingWork.ok).toBe(false);
	if (!pendingWork.ok) expect(pendingWork.code).toBe("lane-busy");
	const pendingNote = follow(pending, shared.lanes[0]!, { agents: idleH0, progress: true });
	expect(pendingNote.ok).toBe(true);
	if (pendingNote.ok) pending.finishFollowUp(pendingNote.token, true);
	// It neither released nor inherited the pending work: the duplicate logical lane is still busy.
	const duplicate = pending.place({ agent: "storm-implementer", name: "H0", task: "Write" }, shared, teamWithQuick, { policies: new Map([["H0", bash]]) });
	expect(duplicate.ok).toBe(false);
	if (!duplicate.ok) expect(duplicate.code).toBe("lane-busy");
	pending.cancel("H0");
	expect(pending.laneBusy("H0")).toBe(false);
});

test("an idle progress note passes available capacity, refuses at the ceiling, and takes no worker slot", () => {
	const reads = plan({ name: "R0", kind: "explore", role: "explorer", goal: "Read" });
	const runId = "run-progress-slot";
	const work = new RunLanes(runId);
	const idle = [agentEntry({ id: "R0", state: "idle" })];
	const busy = [agentEntry({ id: "W0", state: "running", role: "quick" })];
	const follow = (extra: Partial<Parameters<RunLanes["checkFollowUp"]>[0]>) =>
		work.checkFollowUp({ runId, agentId: "R0", agent: "storm-explorer", role: "explorer", lane: reads.lanes[0]!, isolated: false, plan: reads, config: team, ...extra });
	// Available capacity: the native wake turn fits, so the note is admitted without taking a slot or lane hold.
	const available = follow({ agents: [...idle, ...busy], maxConcurrency: 2, progress: true });
	expect(available.ok).toBe(true);
	if (available.ok) {
		expect(available.reserved).toBeUndefined();
		work.finishFollowUp(available.token, true);
	}
	expect(reservedWorkers(runId)).toEqual([]);
	expect(work.laneBusy("R0", idle)).toBe(false);
	// At the native ceiling the idle note would start one more worker, so it is refused with the capacity retry.
	const ceiling = follow({ agents: [...idle, ...busy], maxConcurrency: 1, progress: true });
	expect(ceiling.ok).toBe(false);
	if (!ceiling.ok) {
		expect(ceiling.code).toBe("lane-capacity");
		expect(ceiling.retry).toBe(true);
	}
	// The refusal changed no accounting and left no hold: the same note still refuses, then passes once capacity frees.
	expect(reservedWorkers(runId)).toEqual([]);
	expect(work.laneBusy("R0", idle)).toBe(false);
	expect(follow({ agents: [...idle, ...busy], maxConcurrency: 1, progress: true }).ok).toBe(false);
	expect(follow({ agents: idle, maxConcurrency: 1, progress: true }).ok).toBe(true);
	// A recipient already running is not a new worker: it receives the note even at the ceiling.
	const running = follow({ agents: [agentEntry({ id: "R0", state: "running", role: "explorer" }), ...busy], maxConcurrency: 1, progress: true });
	expect(running.ok).toBe(true);
	expect(reservedWorkers(runId)).toEqual([]);
});

test("a progress-only note still passes capability, job and dependency gates", () => {
	const reads = plan({ name: "H0", kind: "code", role: "implementer", files: ["a.txt"] });
	const base = { agentId: "H0", agent: "storm-implementer", role: "implementer", lane: reads.lanes[0]!, isolated: false, progress: true };
	const work = new RunLanes("run-progress-gates");
	const blocked = work.checkFollowUp({ ...base, policy: { kind: "blocked", reason: "write tool unavailable" } });
	expect(blocked.ok).toBe(false);
	if (!blocked.ok) expect(blocked.code).toBe("lane-capability");
	const job = work.checkFollowUp({ ...base, lane: { ...reads.lanes[0]!, job: "report" } });
	expect(job.ok).toBe(false);
	if (!job.ok) expect(job.code).toBe("lane-job");
	const consumerLane = consumer("result");
	const consumerPlan = plan(producer, consumerLane);
	const dependent = work.checkFollowUp({
		...base,
		agent: "storm-explorer",
		role: "explorer",
		lane: consumerLane,
		plan: consumerPlan,
		readiness: readinessOf("pending"),
	});
	expect(dependent.ok).toBe(false);
	if (!dependent.ok) expect(dependent.code).toBe("lane-dependency");
});

test("capability policies allow disjoint manual paths but serialize overlapping paths and every auto writer", () => {
	const paths = (value: string): LanePolicy => ({ kind: "paths", paths: [value], reason: "path-only manual writer" });
	const shared = plan(
		{ name: "A", kind: "code", role: "quick", files: ["a"] },
		{ name: "B", kind: "code", role: "quick", files: ["b"] },
	);
	const disjoint = new Map([
		["A", paths("a")],
		["B", paths("b")],
	]);
	const manual = new RunLanes("run-canonical");
	expect(manual.place({ agent: "storm-quick", name: "A", task: "A" }, shared, team, { policies: disjoint }).ok).toBe(true);
	expect(manual.place({ agent: "storm-quick", name: "B", task: "B" }, shared, team, { policies: disjoint }).ok).toBe(true);

	const nested = plan(
		{ name: "A", kind: "code", role: "quick", files: ["src"] },
		{ name: "B", kind: "code", role: "quick", files: ["src/a.ts"] },
	);
	const overlapping = new Map([
		["A", paths("src")],
		["B", paths("src/a.ts")],
	]);
	const nestedWork = new RunLanes("run-nested");
	expect(nestedWork.place({ agent: "storm-quick", name: "A", task: "A" }, nested, team, { policies: overlapping }).ok).toBe(true);
	expect(nestedWork.place({ agent: "storm-quick", name: "B", task: "B" }, nested, team, { policies: overlapping }).ok).toBe(false);

	const autoWork = new RunLanes("run-auto-paths");
	expect(autoWork.assign({ agent: "storm-quick", name: "A", task: "A" }, shared, team, { policies: disjoint }).ok).toBe(true);
	expect(autoWork.assign({ agent: "storm-quick", name: "B", task: "B" }, shared, team, { policies: disjoint }).ok).toBe(false);
});

test("a delayed host start cannot bypass a writer that reserved the expired scope", () => {
	const shared = plan(
		{ name: "W0", kind: "run", role: "quick", files: ["shared.txt"] },
		{ name: "X0", kind: "code", role: "quick", files: ["shared.txt"] },
	);
	const work = new RunLanes("run-late");
	const at = 1_000_000;
	expect(work.place({ agent: "storm-quick", name: "W0", task: "Write" }, shared, team, { now: at }).ok).toBe(true);
	// The pending window expires and a new writer takes the same scope.
	expect(work.place({ agent: "storm-quick", name: "X0", task: "Write" }, shared, team, { now: at + 31_000 }).ok).toBe(true);
	const late = work.admitChecked({ spawnKey: "W0", agent: "storm-quick", outcome: "routed" }, { plan: shared, config: team });
	expect(late.ok).toBe(false);
	if (!late.ok) expect(late.code).toBe("lane-write");
});

test("a work follow-up passes the same prerequisite gate as a task", () => {
	const work = new RunLanes("run-follow-dep");
	const consumerLane = consumer("result");
	const consumerPlan = plan(producer, consumerLane);
	const blocked = work.checkFollowUp({
		agentId: "C0",
		agent: "storm-explorer",
		role: "explorer",
		lane: consumerLane,
		plan: consumerPlan,
		isolated: false,
		readiness: readinessOf("pending"),
	});
	expect(blocked.ok).toBe(false);
	if (!blocked.ok) expect(blocked.code).toBe("lane-dependency");
	const ready = work.checkFollowUp({
		agentId: "C0",
		agent: "storm-explorer",
		role: "explorer",
		lane: consumerLane,
		plan: consumerPlan,
		isolated: false,
		readiness: readinessOf("accepted"),
	});
	expect(ready.ok).toBe(true);
});

test("approved capability policies drive read-only, path and blocked scopes; a late spawn cannot bypass a new writer", () => {
	const work = new RunLanes("run-policy");
	const readLane: PlanLane = { name: "review", kind: "review", role: "reviewer", goal: "Judge only" };
	const writerLane: PlanLane = { name: "write", kind: "code", role: "implementer", files: ["a.ts"] };
	const both = plan(readLane, writerLane);
	const policies = new Map([
		["review", { kind: "read" as const, tools: ["read"], reason: "approved read-only tools" }],
		["write", { kind: "paths" as const, paths: ["a.ts"], reason: "approved path-only writer" }],
	]);
	// A read-only reviewer reserves nothing, so it may sit in the same batch as the shared writer.
	const batch = work.place(
		{
			tasks: [
				{ agent: "storm-reviewer", name: "review", task: "Judge" },
				{ agent: "storm-implementer", name: "write", task: "Write" },
			],
		},
		both,
		team,
		{ policies, canonicalFiles: new Map([["write", ["a.ts"]]]) },
	);
	expect(batch.ok).toBe(true);
	// A policy that blocks the lane refuses the whole call before any reservation.
	const blocked = work.place({ agent: "storm-implementer", name: "write", task: "Write" }, both, team, {
		policies: new Map([["write", { kind: "blocked" as const, reason: "write tool unavailable" }]]),
	});
	expect(blocked.ok).toBe(false);
	if (!blocked.ok) expect(blocked.code).toBe("lane-capability");

	// An unbound reservation expires; a later writer now owns the path. The late spawn must not slip past it.
	const scheduling = teamOf({ implementer: "fake/dev", quick: "fake/quick" });
	const lateLane: PlanLane = { name: "late", kind: "code", role: "implementer", files: ["shared.ts"] };
	const nextLane: PlanLane = { name: "next", kind: "code", role: "quick", files: ["shared.ts"] };
	const paths = plan(lateLane, nextLane);
	const late = work.place({ agent: "storm-implementer", name: "late", task: "Late" }, paths, scheduling, { now: 0 });
	expect(late.ok).toBe(true);
	const next = work.place({ agent: "storm-quick", name: "next", task: "Next" }, paths, scheduling, { now: PENDING_WRITE_MS + 1 });
	expect(next.ok).toBe(true);
	const nextAdmit = work.admitChecked({ spawnKey: "next", agent: "storm-quick", outcome: "routed" }, { plan: paths, config: scheduling });
	expect(nextAdmit).toEqual({ ok: true, lane: "next" });
	const lateAdmit = work.admitChecked({ spawnKey: "late", agent: "storm-implementer", outcome: "routed" }, { plan: paths, config: scheduling });
	expect(lateAdmit.ok).toBe(false);
	if (!lateAdmit.ok) expect(lateAdmit.code).toBe("lane-write");
});