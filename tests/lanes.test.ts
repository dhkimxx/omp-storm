import { expect, test } from "bun:test";
import { broadcastBlock, dependencyBlock, dependencyStart, PENDING_WRITE_MS, replanConflict, RunLanes, UNPLANNED_NOTE_TAG } from "../src/runtime/lanes.ts";
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
	// An item with no name and two usable lanes names nothing to match, so it is unplanned (R5), never guessed.
	const stray = new RunLanes("run-stray");
	const unmatched = stray.assign({ agent: "storm-implementer", task: "Implement" }, p, team);
	expect(unmatched.ok).toBe(true);
	if (unmatched.ok) expect(unmatched.input.name).toMatch(/^storm-implementer-run-.+-\d+$/);
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
	work.cancel("probe", work.placementOf("probe"));
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
	work.cancel("api", work.placementOf("api"));

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
		{ host: { enabled: true, apply: false } },
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

test("a team whose configuration says isolated needs omp's apply setting off, like a lane with an isolation reason", () => {
	const isolatedTeam = teamOf({ implementer: "fake/dev" }, { isolation: "isolated" });
	const p = plan(lane("api", "Implement API"));
	const input = { agent: "storm-implementer", name: "api", task: "Implement" };
	// omp merges an isolated worker's changes back into the parent tree after the worker ended, when nothing is reserved:
	// on (omp's default) or unproven is refused, for the manual and the automatic path alike.
	for (const apply of [true, undefined] as const) {
		const host = { enabled: true, ...(apply === undefined ? {} : { apply }) };
		const work = new RunLanes(`team-apply-${apply}`);
		for (const placed of [work.place(input, p, isolatedTeam, { host }), work.assign(input, p, isolatedTeam, { host })]) {
			expect(placed.ok).toBe(false);
			if (placed.ok) continue;
			expect(placed.reason).toContain("omp config set task.isolation.apply false");
			expect(placed.reason).toContain("task.isolation.apply");
			// The refusal is an isolation refusal (no lane code), like the lane form's, and it names the team setting as the other way out.
			expect(placed.code).toBeUndefined();
			expect(placed.reason).toContain("isolation");
		}
		// Nothing was reserved by the refused calls: the same lane is placed once the setting is off.
		expect(work.place(input, p, isolatedTeam, { host: { enabled: true, apply: false } }).ok).toBe(true);
	}
	// The same call is refused whatever the lane's own isolation marker: the team path no longer skips the check.
	const marked = plan({ ...lane("api", "Implement API"), kind: "run", isolationReason: "independent result" });
	expect(new RunLanes("team-apply-marked").place(input, marked, isolatedTeam, { host: { enabled: true, apply: true } }).ok).toBe(false);
	// A shared team's ordinary lane never needed the setting.
	expect(new RunLanes("shared-apply").place(input, p, team, { host: { enabled: true, apply: true } }).ok).toBe(true);
});

test("a planned batch resolves names to lanes and places everything else unplanned; isolation runs them together", () => {
	const p = plan(lane("A", "Implement A"), lane("B", "Implement B"), lane("C", "Implement C"));
	// A team that isolates every worker makes a planned and an unplanned item alike private; private items do not wait
	// on the shared write order (D10). The unnamed item is unplanned (R5), never given the planned item's lane.
	const isolated = teamOf({ implementer: "fake/dev" }, { isolation: "isolated" });
	const atomic = new RunLanes("run-atomic");
	const mixed = atomic.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "A", task: "A" },
				{ agent: "storm-implementer", task: "Missing" },
			],
		},
		p,
		isolated,
		{ host: { enabled: true, apply: false } },
	);
	expect(mixed.ok).toBe(true);
	if (mixed.ok) {
		const tasks = mixed.input.tasks as Array<Record<string, unknown>>;
		expect(tasks[0]).toMatchObject({ name: "A", isolated: true });
		expect(tasks[1]).toMatchObject({ isolated: true });
		expect(tasks[1]!.name).toMatch(/^storm-implementer-run-.+-\d+$/);
	}
	// A manual planned item keeps its lane name and its isolation placement.
	const good = new RunLanes("run-atomic-good");
	const approved = good.place(
		{
			tasks: [
				{ agent: "storm-implementer", name: "A", task: "A" },
				{ agent: "storm-implementer", name: "B", task: "B" },
				{ agent: "storm-implementer", name: "C", task: "C" },
			],
		},
		p,
		isolated,
		{ host: { enabled: true, apply: false } },
	);
	expect(approved.ok).toBe(true);
	if (approved.ok) {
		const tasks = approved.input.tasks as Array<Record<string, unknown>>;
		expect(tasks[0]).toMatchObject({ name: "A", isolated: true });
		expect(tasks[1]).toMatchObject({ name: "B", isolated: true });
		expect(tasks[2]).toMatchObject({ name: "C", isolated: true });
	}

	const selected = plan(
		{ ...lane("probe", "Run experiment"), kind: "run", isolationReason: "independent result" },
		lane("api", "Implement API"),
		lane("extra", "Implement Extra"),
	);
	// The same lane twice is still refused, before anything is reserved.
	const duplicate = new RunLanes("run-dup").place(
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
	// A name that matches another role's lane is placed unplanned under a new handle, with one line in the result.
	const wrongRole = new RunLanes("run-wrong-role").place(
		{ tasks: [{ agent: "storm-explorer", name: "probe", task: "Probe", isolated: true }] },
		selected,
		team,
		{ host: { enabled: true, apply: false } },
	);
	expect(wrongRole.ok).toBe(true);
	if (wrongRole.ok) {
		const tasks = wrongRole.input.tasks as Array<Record<string, unknown>>;
		expect(tasks[0]!.name).toMatch(/^storm-explorer-run-.+-\d+$/);
		expect(tasks[0]).toMatchObject({ isolated: true });
		expect(wrongRole.notes?.some(note => note.includes(UNPLANNED_NOTE_TAG) && note.includes("역할"))).toBe(true);
	}
	// An isolated unplanned item runs beside a planned shared writer: it is private, not another shared writer.
	const beside = new RunLanes("run-mixed").place(
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
	expect(beside.ok).toBe(true);
	// With no declared files an unplanned item is never `paths`: two of them are two exclusive writers.
	const writers = new RunLanes("run-writers").place(
		{
			tasks: [
				{ agent: "storm-implementer", task: "One" },
				{ agent: "storm-implementer", task: "Two" },
			],
		},
		selected,
		team,
	);
	expect(writers.ok).toBe(false);
	if (!writers.ok) expect(writers.code).toBe("lane-write");
});

test("an unplanned isolated item needs omp isolation on and apply off; a rejected batch reserves nothing", () => {
	const work = new RunLanes("run-reserve");
	// With no host facts the isolation cannot be proven, so the item is refused before anything is reserved.
	const direct = work.place({ agent: "storm-implementer", task: "Probe", isolated: true }, undefined, team);
	expect(direct.ok).toBe(false);
	if (!direct.ok) expect(direct.reason).toContain("격리");
	// With both facts the same item runs private (D10), whatever its tools, under a new handle.
	const isolated = work.place({ agent: "storm-implementer", task: "Probe", isolated: true }, undefined, team, { host: { enabled: true, apply: false } });
	expect(isolated.ok).toBe(true);
	if (isolated.ok) {
		expect(isolated.input).toMatchObject({ isolated: true });
		expect(isolated.input.name).toMatch(/^storm-implementer-run-.+-\d+$/);
	}
	// Two shared writers in one batch are refused before either reserves; no placement serial advanced.
	const rejected = work.place(
		{ tasks: [{ agent: "storm-implementer", name: "one", task: "One" }, { agent: "storm-implementer", name: "two", task: "Two" }] },
		undefined,
		team,
	);
	expect(rejected.ok).toBe(false);
	if (!rejected.ok) expect(rejected.code).toBe("lane-write");
	const p = plan({ ...lane("probe", "Run experiment"), kind: "run", isolationReason: "independent result" });
	const assigned = work.assign({ agent: "storm-implementer", name: "probe", task: "Probe" }, p, team, { host: { enabled: true, apply: false } });
	expect(assigned.ok).toBe(true);
	if (assigned.ok) expect(assigned.input.name).toBe("run-reserve-lane-1");
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

/**
 * A prerequisite lane's ledger facts as the controller would hand them to admission: a content version exists only for
 * a row that is accepted or reviewable (an unmet or pending row had its version deleted), and `kind` is absent for the
 * hand-built legacy view the older tests use.
 */
function readinessOf(
	state: "pending" | "unmet" | "reviewable" | "accepted",
	integrated = false,
	running = false,
	kind?: "change" | "answer",
) {
	return new Map([
		[
			"producer",
			{
				results: [
					{
						id: "r1",
						state,
						integrated,
						...(state === "accepted" || state === "reviewable" ? { version: "0123456789abcdef" } : {}),
						...(kind === undefined ? {} : { kind }),
						path: "out.txt",
					},
				],
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

test("a consumer starts before its prerequisite holds and is told so; only facts the record cannot tie keep the refusal", () => {
	const work = new RunLanes("run-dep");
	const consumerPlan = plan(producer, consumer("result"));
	const consumerCall = { agent: "storm-explorer", name: "consumer", task: "Compare" };
	const place = (readiness?: ReturnType<typeof readinessOf>, p = consumerPlan) => {
		const placed = work.place(consumerCall, p, team, readiness === undefined ? {} : { readiness });
		// A started placement holds its lane until the host correlates it; none is started here.
		work.cancel("consumer", work.placementOf("consumer"));
		return placed;
	};
	// No readiness view of the prerequisite: nothing is known, so the start is refused (fails closed).
	const missing = place();
	expect(missing.ok).toBe(false);
	if (!missing.ok) expect(missing.code).toBe("lane-dependency");
	// A lane that declared no results has no row to bind or reopen: refused, as before.
	const legacy = new Map([["producer", { results: [], settled: false, integrated: false, running: true }]]);
	expect(place(legacy as ReturnType<typeof readinessOf>).ok).toBe(false);
	// A prerequisite that is pending, unmet or only reviewable no longer refuses the start. The record binds it as
	// `missing` (or reopens the consumer at once), so the consumer's result cannot be accepted on it; the call says so.
	for (const state of ["pending", "unmet", "reviewable"] as const) {
		const started = place(readinessOf(state));
		expect(started.ok).toBe(true);
		if (!started.ok) continue;
		expect(started.notes).toHaveLength(1);
		expect(started.notes![0]).toContain("'consumer' 레인은 선행 'producer' 레인의");
		expect(started.notes![0]).toContain("수용되지 않습니다");
		expect(started.notes![0]).toContain("후속 지시");
	}
	// The accepted reference is short, versioned and path-bearing; a host path or model prose never appears.
	const accepted = place(readinessOf("accepted"));
	expect(accepted.ok).toBe(true);
	if (accepted.ok) {
		expect(accepted.notes).toBeUndefined();
		expect(String(accepted.input.task)).toContain("r1=accepted@01234567 out.txt");
	}
	// A producer that is running again starts the consumer from the accepted row it has; the call says a change reopens it.
	const rerunning = place(readinessOf("accepted", false, true));
	expect(rerunning.ok).toBe(true);
	if (rerunning.ok) {
		expect(rerunning.notes).toHaveLength(1);
		expect(rerunning.notes![0]).toContain("아직 실행 중");
		expect(rerunning.notes![0]).toContain("다시 열립니다");
	}
	// An `integrated` edge on an accepted result the parent does not carry keeps the refusal: the consumer would bind that
	// real version and nothing reopens it when the result is integrated later (the record does not carry integration).
	const integratedPlan = plan(producer, consumer("integrated"));
	for (const kind of [undefined, "change"] as const) {
		const refused = place(readinessOf("accepted", false, false, kind), integratedPlan);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.code).toBe("lane-dependency");
	}
	// The same refusal holds for an accepted result that is not at a usable location on a `result` edge (a vanished patch).
	expect(place(readinessOf("accepted", false, false, "change")).ok).toBe(false);
	const ok = place(readinessOf("accepted", true), integratedPlan);
	expect(ok.ok).toBe(true);
	if (ok.ok) expect(String(ok.input.task)).toContain("r1=accepted·통합@01234567 out.txt");
	// `reviewable` admits a submission to judge, including one whose result is only reviewable.
	expect(place(readinessOf("reviewable"), plan(producer, consumer("reviewable"))).ok).toBe(true);
});

test("the start check reports each unmet prerequisite and never refuses a state the record already ties", () => {
	const lane = consumer("result");
	// pending / unmet / reviewable (not accepted) and a running accepted producer all start.
	for (const state of ["pending", "unmet", "reviewable"] as const) expect(dependencyStart(lane, readinessOf(state)).ok).toBe(true);
	expect(dependencyStart(lane, readinessOf("accepted", false, true)).ok).toBe(true);
	// Met: nothing to say. Unknown: refused with the old text.
	expect(dependencyStart(lane, readinessOf("accepted"))).toEqual({ ok: true, notes: [] });
	const unknown = dependencyStart(lane, undefined);
	expect(unknown.ok).toBe(false);
	if (!unknown.ok) expect(unknown.reason).toBe(String(dependencyBlock(lane, undefined)));
	// An answer that was judged unmet carries a version too, but the row never stood accepted: the record binds `missing`, so it starts.
	const judgedUnmet = new Map([["producer", { results: [{ id: "r1", kind: "answer" as const, state: "unmet" as const, integrated: false, version: "ab12" }], settled: true, integrated: false, running: false }]]);
	expect(dependencyStart(lane, judgedUnmet).ok).toBe(true);
	// A row that still stands accepted whose location no longer holds (a vanished source) maps to unmet but would bind its real version: refused.
	const vanished = new Map([["producer", { results: [{ id: "r1", kind: "answer" as const, state: "unmet" as const, integrated: false, version: "ab12", standingVersion: true as const }], settled: true, integrated: false, running: false }]]);
	expect(dependencyStart(lane, vanished).ok).toBe(false);
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
	work.cancel("W0", work.placementOf("W0"));
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
	work.cancel("R1", work.placementOf("R1"));
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
	work.cancel("R0", work.placementOf("R0"));
	expect(work.laneBusy("R0", [], 2)).toBe(false);
	expect(work.place({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { now: 3 }).ok).toBe(true);
	expect(work.place({ agent: "storm-explorer", name: "R0", task: "Read" }, reads, team, { now: PENDING_WRITE_MS + 4 }).ok).toBe(true);
});

test("a work follow-up applies the actual policy and canonical files exactly as a first task, in either mode", () => {
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
	// Automatic delegation orders nothing the manual rules do not: disjoint path writers run together, a bash writer does not.
	const auto = new RunLanes("run-follow-auto");
	expect(follow(auto, "A0", manual.lanes[0]!, { policy: paths("a"), canonicalFiles: ["a"], auto: true }).ok).toBe(true);
	expect(follow(auto, "B0", manual.lanes[1]!, { policy: paths("b"), canonicalFiles: ["b"], auto: true }).ok).toBe(true);
	const autoBash = new RunLanes("run-follow-auto-bash");
	expect(follow(autoBash, "A0", manual.lanes[0]!, { policy: bash, auto: true }).ok).toBe(true);
	expect(follow(autoBash, "B0", manual.lanes[1]!, { policy: paths("b"), canonicalFiles: ["b"], auto: true }).ok).toBe(false);
	// A read authority takes no write scope at all.
	expect(follow(autoBash, "R0", manual.lanes[1]!, { policy: { kind: "read", reason: "read" } }).ok).toBe(true);
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

test("a progress-only note proven read-only meets no write-order gate and reserves nothing; a work message to the same writer keeps its gate", () => {
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
	// Not proven read-only (the call site may have re-opened the worker's admission for the note): it keeps today's gate,
	// because the woken turn could write beside W0. A refused note reserves nothing.
	const unproven = follow(writing, shared.lanes[0]!, { runId, agents: runningW0, progress: true, callId: "progress-0" });
	expect(unproven.ok).toBe(false);
	if (!unproven.ok) expect(unproven.code).toBe("lane-write");
	// Proven read-only (the admission stays closed, so the turn can only read and report): a note is not a write. It
	// passes beside the live writer and reserves nothing.
	const note = follow(writing, shared.lanes[0]!, { runId, agents: runningW0, progress: true, wakeReadOnly: true, callId: "progress-1" });
	expect(note.ok).toBe(true);
	expect(reservedWorkers(runId)).toEqual([]);
	expect(writing.laneBusy("H0", [agentEntry({ id: "H0", state: "idle" })])).toBe(false);
	// A note to a recipient that is already running adds no writer: it passes without a lease, slot or lane hold.
	const runningBoth = [...runningW0, agentEntry({ id: "H0", state: "running" })];
	const live = follow(writing, shared.lanes[0]!, { runId, agents: runningBoth, progress: true, callId: "progress-2" });
	expect(live.ok).toBe(true);
	if (live.ok) {
		expect(live.reserved).toBeUndefined();
		writing.finishFollowUp(live.token, true);
	}
	expect(reservedWorkers(runId)).toEqual([]);
	// It leaves W0's ownership alone: the same work message is still refused after the note.
	const after = follow(writing, shared.lanes[0]!, { runId, agents: runningW0 });
	expect(after.ok).toBe(false);
	if (!after.ok) expect(after.code).toBe("lane-write");

	// A pending placement of the same logical lane holds it: the work message is lane-busy.
	const pending = new RunLanes("run-progress-pending");
	expect(pending.place({ agent: "storm-implementer", name: "H0", task: "Write" }, shared, teamWithQuick, { policies: new Map([["H0", bash]]) }).ok).toBe(true);
	const idleH0 = [agentEntry({ id: "H0", state: "idle" })];
	const pendingWork = follow(pending, shared.lanes[0]!, { agents: idleH0 });
	expect(pendingWork.ok).toBe(false);
	if (!pendingWork.ok) expect(pendingWork.code).toBe("lane-busy");
	// The pending placement holds the lane: a note not proven read-only meets what a work message meets (lane busy), a proven one passes.
	const pendingNote = follow(pending, shared.lanes[0]!, { agents: idleH0, progress: true });
	expect(pendingNote.ok).toBe(false);
	if (!pendingNote.ok) expect(pendingNote.code).toBe("lane-busy");
	expect(follow(pending, shared.lanes[0]!, { agents: idleH0, progress: true, wakeReadOnly: true }).ok).toBe(true);
	// It neither released nor inherited the pending work: the duplicate logical lane is still busy.
	const duplicate = pending.place({ agent: "storm-implementer", name: "H0", task: "Write" }, shared, teamWithQuick, { policies: new Map([["H0", bash]]) });
	expect(duplicate.ok).toBe(false);
	if (!duplicate.ok) expect(duplicate.code).toBe("lane-busy");
	pending.cancel("H0", pending.placementOf("H0"));
	expect(pending.laneBusy("H0")).toBe(false);
});

test("a read-only progress note meets no capacity gate and takes no slot; any other message at omp's ceiling is refused", () => {
	const reads = plan({ name: "R0", kind: "explore", role: "explorer", goal: "Read" });
	const runId = "run-progress-slot";
	const work = new RunLanes(runId);
	const idle = [agentEntry({ id: "R0", state: "idle" })];
	const busy = [agentEntry({ id: "W0", state: "running", role: "quick" })];
	const follow = (extra: Partial<Parameters<RunLanes["checkFollowUp"]>[0]>) =>
		work.checkFollowUp({ runId, agentId: "R0", agent: "storm-explorer", role: "explorer", lane: reads.lanes[0]!, isolated: false, plan: reads, config: team, ...extra });
	// With room to spare and at the native ceiling alike, a note proven read-only is admitted without a slot or lane hold.
	for (const maxConcurrency of [2, 1]) {
		const note = follow({ agents: [...idle, ...busy], maxConcurrency, progress: true, wakeReadOnly: true });
		expect(note.ok).toBe(true);
		if (note.ok) {
			expect(note.reserved).toBeUndefined();
			work.finishFollowUp(note.token, true);
		}
		expect(reservedWorkers(runId)).toEqual([]);
		expect(work.laneBusy("R0", idle)).toBe(false);
	}
	// A note that is not proven read-only starts a turn that may write: at the ceiling it is refused, as before.
	const unproven = follow({ agents: [...idle, ...busy], maxConcurrency: 1, progress: true });
	expect(unproven.ok).toBe(false);
	if (!unproven.ok) expect(unproven.code).toBe("lane-capacity");
	// A message that starts work counts the reactivated worker against omp's ceiling, the one limit.
	const ceiling = follow({ agents: [...idle, ...busy], maxConcurrency: 1 });
	expect(ceiling.ok).toBe(false);
	if (!ceiling.ok) {
		expect(ceiling.code).toBe("lane-capacity");
		expect(ceiling.retry).toBe(true);
	}
	expect(reservedWorkers(runId)).toEqual([]);
	expect(follow({ agents: idle, maxConcurrency: 1 }).ok).toBe(true);
});

test("a progress-only note still meets the capability and job refusals, but not the prerequisite check", () => {
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
		wakeReadOnly: true,
		agent: "storm-explorer",
		role: "explorer",
		lane: consumerLane,
		plan: consumerPlan,
		readiness: readinessOf("pending"),
	});
	// A note starts no work, so an unmet prerequisite does not refuse it; a work message starts, and is told the state.
	expect(dependent.ok).toBe(true);
	const work2 = work.checkFollowUp({ ...base, progress: false, agent: "storm-explorer", role: "explorer", lane: consumerLane, plan: consumerPlan, readiness: readinessOf("pending") });
	expect(work2.ok).toBe(true);
	if (work2.ok) expect(work2.notes?.[0]).toContain("수용되지 않습니다");
});

test("capability policies allow disjoint paths in either mode, serialize overlapping paths and every exec writer", () => {
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

	// Automatic delegation scopes a lane exactly as manual direction does: disjoint path writers start together.
	const autoWork = new RunLanes("run-auto-paths");
	expect(autoWork.assign({ agent: "storm-quick", name: "A", task: "A" }, shared, team, { policies: disjoint }).ok).toBe(true);
	expect(autoWork.assign({ agent: "storm-quick", name: "B", task: "B" }, shared, team, { policies: disjoint }).ok).toBe(true);
	// A worker with a shell stays one unbounded writer under automatic delegation, whatever files it declared (G1).
	const bash: LanePolicy = { kind: "unknown", reason: "임의 실행 도구" };
	const execs = new Map([
		["A", bash],
		["B", bash],
	]);
	const autoExec = new RunLanes("run-auto-exec");
	expect(autoExec.assign({ agent: "storm-quick", name: "A", task: "A" }, shared, team, { policies: execs }).ok).toBe(true);
	const serialised = autoExec.assign({ agent: "storm-quick", name: "B", task: "B" }, shared, team, { policies: execs });
	expect(serialised.ok).toBe(false);
	if (!serialised.ok) expect(serialised.code).toBe("lane-write");
	const mixed = new RunLanes("run-auto-mixed");
	expect(mixed.assign({ agent: "storm-quick", name: "A", task: "A" }, shared, team, { policies: new Map([["A", bash], ["B", paths("b")]]) }).ok).toBe(true);
	expect(mixed.assign({ agent: "storm-quick", name: "B", task: "B" }, shared, team, { policies: new Map([["A", bash], ["B", paths("b")]]) }).ok).toBe(false);
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

test("the late recheck keeps the scope the lane was placed with: a shell writer that declared disjoint files is still unbounded", () => {
	const shared = plan(
		{ name: "E0", kind: "code", role: "quick", files: ["a.txt"] },
		{ name: "P0", kind: "code", role: "quick", files: ["b.txt"] },
	);
	const bash: LanePolicy = { kind: "unknown", reason: "임의 실행 도구" };
	const policies = new Map<string, LanePolicy>([
		["E0", bash],
		["P0", { kind: "paths", paths: ["b.txt"], reason: "path-only writer" }],
	]);
	for (const auto of [false, true]) {
		const work = new RunLanes(`run-late-scope-${auto}`);
		const at = 1_000_000;
		const place = (name: string, now: number) =>
			auto
				? work.assign({ agent: "storm-quick", name, task: "Write" }, shared, team, { policies, now })
				: work.place({ agent: "storm-quick", name, task: "Write" }, shared, team, { policies, now });
		const first = place("E0", at);
		expect(first.ok).toBe(true);
		// E0's pending window runs out before the host allocates its spawn key; a path-only writer takes its turn meanwhile.
		expect(place("P0", at + 31_000).ok).toBe(true);
		const key = auto && first.ok ? String(first.input.name) : "E0";
		// Recomputed from declared files alone E0 would look like a disjoint path writer and slip in. It was placed as an
		// unbounded writer (it has a shell), and the recheck keeps that.
		const late = work.admitChecked({ spawnKey: key, agent: "storm-quick", outcome: "routed" }, { plan: shared, config: team });
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.code).toBe("lane-write");
	}
});

test("a work follow-up meets the same start check as a task: it starts and is told, or keeps the refusal for the same cases", () => {
	const work = new RunLanes("run-follow-dep");
	const consumerLane = consumer("result");
	const consumerPlan = plan(producer, consumerLane);
	const follow = (agentId: string, readiness?: ReturnType<typeof readinessOf>) =>
		work.checkFollowUp({
			agentId,
			agent: "storm-explorer",
			role: "explorer",
			lane: consumerLane,
			plan: consumerPlan,
			isolated: false,
			...(readiness === undefined ? {} : { readiness }),
		});
	const pending = follow("C0", readinessOf("pending"));
	expect(pending.ok).toBe(true);
	if (pending.ok) {
		expect(pending.notes).toHaveLength(1);
		expect(pending.notes![0]).toContain("수용되지 않습니다");
		work.finishFollowUp(pending.token, false);
	}
	const unknown = follow("C1");
	expect(unknown.ok).toBe(false);
	if (!unknown.ok) expect(unknown.code).toBe("lane-dependency");
	const ready = follow("C2", readinessOf("accepted"));
	expect(ready.ok).toBe(true);
	if (ready.ok) expect(ready.notes).toBeUndefined();
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
test("a late cancel of an older spawn leaves a newer call's placement of the same name in place", () => {
	const api = lane("api", "Implement API");
	const view: PlanLane = { ...lane("view", "Render output"), files: ["api.ts"] };
	const p = plan(api, view);
	const work = new RunLanes("run-late-cancel");
	const place = (now: number) => work.place({ agent: "storm-implementer", name: "api", task: "Implement" }, p, team, { now });
	expect(place(0).ok).toBe(true);
	const older = work.placementOf("api");
	expect(older).toBeDefined();
	// The older call never reached a worker and its pending window expired, so the same name is placed again.
	const later = PENDING_WRITE_MS + 1;
	expect(place(later).ok).toBe(true);
	const newer = work.placementOf("api");
	expect(newer).not.toBe(older);
	// The older spawn's refusal lands now: the newer hold and its write reservation must both survive.
	work.cancel("api", older);
	expect(work.laneBusy("api", [], later + 1)).toBe(true);
	const conflict = work.place({ agent: "storm-implementer", name: "view", task: "Render" }, p, team, { now: later + 2 });
	expect(conflict.ok).toBe(false);
	if (!conflict.ok) expect(conflict.code).toBe("lane-write");
	// The newer call's own refusal releases everything it placed.
	work.cancel("api", newer);
	expect(work.laneBusy("api", [], later + 3)).toBe(false);
	expect(work.place({ agent: "storm-implementer", name: "view", task: "Render" }, p, team, { now: later + 4 }).ok).toBe(true);
});

test("a cancel stamped with another placement keeps a pending assignment, and its own stamp releases it", () => {
	const p = plan(lane("api", "Implement API"));
	const work = new RunLanes("run-assignment");
	const first = assigned(work, p, "api");
	const stale = work.placementOf(first);
	work.cancel(first, stale);
	const second = assigned(work, p, "api");
	expect(second).not.toBe(first);
	work.cancel(second, stale);
	expect(work.admit({ spawnKey: second, agent: "storm-implementer", outcome: "routed" })).toBe("api");
});

test("a refused spawn releases the write reservation its admission bound, so the lane's writer slot is free for the next one", () => {
	const api = lane("api", "Implement API");
	const view: PlanLane = { ...lane("view", "Render output"), files: ["api.ts"] };
	const p = plan(api, view);
	const work = new RunLanes("run-bound-cancel");
	expect(work.place({ agent: "storm-implementer", name: "api", task: "Implement" }, p, team).ok).toBe(true);
	// Read before the decision awaits; admission later binds the spawn id to the reservation.
	const stamp = work.placementOf("api");
	expect(work.admitChecked({ spawnKey: "api", agent: "storm-implementer", outcome: "routed" }, { plan: p, config: team }).ok).toBe(true);
	work.cancel("api", stamp);
	expect(work.place({ agent: "storm-implementer", name: "view", task: "Render" }, p, team).ok).toBe(true);
});

test("a cancel for one run's lanes never touches the placement of another run's lanes", () => {
	const p = plan(lane("api", "Implement API"));
	const older = new RunLanes("run-older");
	const current = new RunLanes("run-current");
	expect(older.place({ agent: "storm-implementer", name: "api", task: "Implement" }, p, team).ok).toBe(true);
	expect(current.place({ agent: "storm-implementer", name: "api", task: "Implement" }, p, team).ok).toBe(true);
	older.cancel("api", older.placementOf("api"));
	expect(older.laneBusy("api")).toBe(false);
	expect(current.laneBusy("api")).toBe(true);
});

test("agent://all is refused only when waking every idle worker would pass omp's ceiling, never for roles or the plan", () => {
	const runId = "run-broadcast";
	const idle = (id: string, role = "implementer") => agentEntry({ id, state: "idle", role });
	const agents = [idle("A"), idle("B"), idle("C"), agentEntry({ id: "D", state: "running", role: "explorer" })];
	// No ceiling or an unlimited one: nothing counts workers. This was the blanket `lane-capacity` refusal.
	expect(broadcastBlock({ runId, agents })).toBeUndefined();
	expect(broadcastBlock({ runId, agents, maxConcurrency: 0 })).toBeUndefined();
	// One running and three idle: four after the wake. At a ceiling of 4 it goes, at 3 it does not.
	expect(broadcastBlock({ runId, agents, maxConcurrency: 4 })).toBeUndefined();
	const refused = broadcastBlock({ runId, agents, maxConcurrency: 3 });
	expect(refused).toContain("task.maxConcurrency 3");
	// A worker outside this plan counts against the same ceiling.
	expect(broadcastBlock({ runId, agents, maxConcurrency: 4, otherActive: 1 })).toContain("task.maxConcurrency 4");
	// Nobody to wake: the running worker alone is within any ceiling it already fits.
	expect(broadcastBlock({ runId, agents: [agents[3]!], maxConcurrency: 1 })).toBeUndefined();
});

// ── Per-item text at placement (`decorate`) ──────────────────────────────────────────────────────────────────────────────

type DecorateEntry = Parameters<NonNullable<NonNullable<Parameters<RunLanes["place"]>[3]>["decorate"]>>[0];
const decorateWith = (text: (entry: DecorateEntry) => string | undefined) => {
	const seen: DecorateEntry[] = [];
	return { seen, decorate: (entry: DecorateEntry) => (seen.push(entry), text(entry)) };
};
const stepped = (item: Record<string, unknown>): string[] => item.steps as string[];

test("decorate: each item of an accepted call gets its own text, from its own lane, after the dependency note", () => {
	const consumerPlan = plan(producer, consumer("result"), { name: "other", kind: "explore", role: "explorer", results: [{ id: "o1", kind: "answer", criterion: "report" }] });
	for (const rewriteNames of [false, true]) {
		const work = new RunLanes(`run-decorate-${rewriteNames}`);
		const { seen, decorate } = decorateWith(({ lane }) => `[contract:${lane?.name}]`);
		const placed = work.place(
			{ tasks: [{ agent: "storm-explorer", name: "consumer", task: "Compare" }, { agent: "storm-explorer", name: "other", task: "Report" }] },
			consumerPlan,
			team,
			{ readiness: readinessOf("accepted"), decorate, rewriteNames },
		);
		expect(placed.ok).toBe(true);
		if (!placed.ok) continue;
		const [first, second] = placed.input.tasks as Record<string, unknown>[];
		// The dependency note keeps its place and the contract follows it.
		expect(String(first!.task)).toMatch(/^Compare\n\n\[storm:dep\] .*r1=accepted@01234567 out\.txt\n\n\[contract:consumer\]$/s);
		expect(String(second!.task)).toBe("Report\n\n[contract:other]");
		expect(seen.map(entry => entry.lane?.name)).toEqual(["consumer", "other"]);
		expect(seen.every(entry => entry.isolated === false)).toBe(true);
	}
});

test("decorate: an item with steps gets the text on its first step, and the dependency note goes the same way", () => {
	const work = new RunLanes("run-steps");
	const consumerPlan = plan(producer, consumer("result"));
	const { decorate } = decorateWith(() => "CONTRACT");
	const placed = work.place({ agent: "storm-explorer", name: "consumer", steps: ["first stage", "second stage"] }, consumerPlan, team, { readiness: readinessOf("accepted"), decorate });
	expect(placed.ok).toBe(true);
	if (!placed.ok) return;
	expect(placed.input.task).toBeUndefined();
	const steps = stepped(placed.input);
	expect(steps).toHaveLength(2);
	expect(steps[0]).toMatch(/^first stage\n\n\[storm:dep\] .*\n\nCONTRACT$/s);
	expect(steps[1]).toBe("second stage");
	// Without a dependency note the text alone is delivered, still on the first step.
	const plain = new RunLanes("run-steps-2").place({ agent: "storm-explorer", name: "other", steps: ["only stage"] }, plan({ name: "other", kind: "explore", role: "explorer" }), team, { decorate });
	expect(plain.ok && stepped(plain.input)).toEqual(["only stage\n\nCONTRACT"]);
});

test("decorate: the input the caller sent is not changed", () => {
	const work = new RunLanes("run-pure");
	const call = { agent: "storm-explorer", name: "other", task: "Report" };
	const placed = work.place(call, plan({ name: "other", kind: "explore", role: "explorer" }), team, { decorate: () => "CONTRACT" });
	expect(placed.ok && placed.input.task).toBe("Report\n\nCONTRACT");
	expect(call.task).toBe("Report");
});

test("decorate: it learns whether the item is placed in an isolated checkout, and an unplanned item has no lane", () => {
	const isolatedTeam = { ...team, isolation: "isolated" as const };
	const p = plan({ name: "lab", kind: "code", role: "implementer", files: ["lab.ts"] });
	const { seen, decorate } = decorateWith(({ isolated }) => (isolated ? "ISOLATED" : "SHARED"));
	const placed = new RunLanes("run-iso").place({ agent: "storm-implementer", name: "lab", task: "Try" }, p, isolatedTeam, { host: { enabled: true, apply: false }, decorate });
	expect(placed.ok && placed.input.task).toBe("Try\n\nISOLATED");
	expect(seen).toEqual([{ lane: p.lanes[0], isolated: true }]);
	const shared = new RunLanes("run-shared").place({ agent: "storm-implementer", name: "lab", task: "Try" }, p, team, { decorate });
	expect(shared.ok && shared.input.task).toBe("Try\n\nSHARED");
	// A direct task that matches no lane still asks, with no lane, and may answer nothing.
	const unplanned = decorateWith(({ lane }) => (lane === undefined ? undefined : "NEVER"));
	const direct = new RunLanes("run-direct").place({ agent: "storm-implementer", task: "Do it" }, undefined, team, { decorate: unplanned.decorate });
	expect(direct.ok && direct.input.task).toBe("Do it");
	expect(unplanned.seen).toEqual([{ lane: undefined, isolated: false }]);
});

test("decorate: a refused call is asked about nothing and none of its items is touched", () => {
	const p = plan({ name: "api", kind: "code", role: "implementer", files: ["shared.ts"] }, { name: "view", kind: "code", role: "implementer", files: ["shared.ts"] });
	const { seen, decorate } = decorateWith(() => "CONTRACT");
	const input = { tasks: [{ agent: "storm-implementer", name: "api", task: "A" }, { agent: "storm-implementer", name: "view", task: "B" }] };
	const refused = new RunLanes("run-refused").place(input, p, team, { decorate });
	expect(refused).toMatchObject({ ok: false, code: "lane-write" });
	expect(seen).toEqual([]);
	expect(input.tasks.map(item => item.task)).toEqual(["A", "B"]);
	// A call refused for a prerequisite or a busy lane is the same.
	const busy = new RunLanes("run-busy");
	expect(busy.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { decorate }).ok).toBe(true);
	// The accepted call is asked once; only the refused ones are not.
	expect(seen).toHaveLength(1);
	seen.length = 0;
	expect(busy.place({ agent: "storm-implementer", name: "api", task: "A" }, p, team, { decorate })).toMatchObject({ ok: false, code: "lane-busy" });
	expect(seen).toEqual([]);
});

test("decorate: nothing, an empty text, an item with nothing to append to, or a hook that fails leaves the item as it was and still places it", () => {
	const p = plan({ name: "other", kind: "explore", role: "explorer" });
	const place = (decorate: () => string | undefined, item: Record<string, unknown> = { agent: "storm-explorer", name: "other", task: "Report" }) =>
		new RunLanes(`run-quiet-${Math.random()}`).place(item, p, team, { decorate });
	expect(place(() => undefined).ok && (place(() => undefined) as { input: Record<string, unknown> }).input.task).toBe("Report");
	expect((place(() => "   ") as { input: Record<string, unknown> }).input.task).toBe("Report");
	expect((place(() => { throw new Error("boom"); }) as { input: Record<string, unknown> }).input.task).toBe("Report");
	// No `task` and no `steps`: omp refuses the item itself; there is nothing to append to and nothing is invented.
	const bare = place(() => "CONTRACT", { agent: "storm-explorer", name: "other" });
	expect(bare.ok && Object.hasOwn(bare.input, "task")).toBe(false);
});
