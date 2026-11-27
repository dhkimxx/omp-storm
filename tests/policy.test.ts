import { describe, expect, test } from "bun:test";
import { deliveredFollowUp, followUpAgent, followUpFailureNote, followUpProgress } from "../src/policy/followup.ts";
import {
	activeAgents,
	blockedSpawn,
	APPROVAL_CHECK,
	approvedSelectors,
	BUDGET_CHECK,
	decideSpawn,
	failClosed,
	orderByQuota,
	PENDING_SPAWN_MS,
	stripEffort,
	teamGate,
	withEffort,
} from "../src/policy/spawn.ts";
import type {
	AgentEntry,
	ApprovalRecord,
	ConfigLoad,
	QuotaMark,
	RunPlan,
	ShadowInfo,
	SpawnDecision,
	SpawnEvent,
	SpawnOutcome,
	SpawnRecord,
	SpawnRuntime,
	SpawnState,
	StormConfig,
	TrialConfig,
	TrialState,
} from "../src/types.ts";
import { agentEntry, approvalRecord, spawnRecord, teamOf } from "./fixtures.ts";

const HASH = `jcs-sha256:${"ab12".repeat(16)}`;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

const config: StormConfig = teamOf(
	{ reviewer: { models: ["openai/gpt-5.2", "anthropic/claude-x:low", "openrouter/qwen/qwen3"], effort: "high" }, explorer: "google/gemini-flash" },
	{ isolation: "isolated" },
);

const ok: Extract<ConfigLoad, { status: "ok" }> = {
	status: "ok",
	path: "/r/.omp/storm/config.json",
	config,
	hash: HASH,
	warnings: [],
};

const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/r/.omp/agents/rev.md", scope: "project", sha256: "1".repeat(64) };

const approval = (overrides: Partial<ApprovalRecord> = {}, shadowedAgents: ShadowInfo[] = []): ApprovalRecord =>
	approvalRecord(HASH, { repoId: "git-r-000000000000000000000000", ...overrides }, shadowedAgents);

const ev = (agent: string, patterns: string[] = [], spawnKey?: string): SpawnEvent => ({
	agent,
	invocationKind: "task",
	patterns,
	...(spawnKey ? { spawnKey } : {}),
});
const state = (over: Partial<SpawnState> = {}): SpawnState => ({ config: ok, approval: approval(), shadows: [], ...over });
const runtime = (over: Partial<SpawnRuntime> = {}): SpawnRuntime => ({ now: NOW, quotaMarks: [], trials: {}, ...over });
const PLAN: RunPlan = {
	lanes: [{ name: "lane", kind: "code", role: "reviewer" }],
	workers: { reviewer: 2, explorer: 2, implementer: 2 },
	submittedAt: "2026-11-20T11:00:00.000Z",
};
/** A plan with one lane for each role a built-in maps to, so lane binding has a real owner. */
const FULL_PLAN: RunPlan = {
	lanes: [
		{ name: "lane", kind: "review", role: "reviewer" },
		{ name: "look", kind: "explore", role: "explorer" },
		{ name: "build", kind: "code", role: "implementer" },
	],
	workers: { reviewer: 2, explorer: 2, implementer: 2 },
	submittedAt: "2026-11-20T11:00:00.000Z",
};
type Run = NonNullable<SpawnRuntime["run"]>;
const inRun = (run: Partial<Run> = {}, over: Partial<SpawnRuntime> = {}): SpawnRuntime =>
	runtime({ run: { runId: "run-1", costUsd: 0, plan: PLAN, ...run }, ...over });
const models = (d: SpawnDecision): string[] | undefined => (d && "model" in d ? d.model : undefined);
/** The block code of an outcome, checked on both the record and the text the model sees. */
function code(outcome: SpawnOutcome): string | undefined {
	const decision = outcome.decision;
	if (!decision || !("block" in decision)) return undefined;
	const recorded = outcome.record?.code;
	expect(outcome.record?.outcome).toBe("blocked");
	expect(decision.reason.startsWith(`[storm:${recorded}] `)).toBe(true);
	return recorded;
}
const withConfig = (c: StormConfig): SpawnState => state({ config: { ...ok, config: c } });

const baseTrial: TrialConfig = {
	id: "reviewer-glm",
	role: "reviewer",
	model: "zai/glm-5",
	share: 0.5,
	maxSpawns: 3,
	startsAt: "2026-11-20T00:00:00.000Z",
	endsAt: "2026-11-27T00:00:00.000Z",
	budgetUsd: 1,
};

describe("team gate", () => {
	test("missing and invalid configs are no-config; another hash or no approval is unapproved", () => {
		const gateCode = (s: SpawnState) => {
			const gate = teamGate(s);
			return gate.ok ? "ok" : gate.block.code;
		};
		expect(gateCode(state({ config: { status: "missing", path: "x" } }))).toBe("no-config");
		expect(gateCode(state({ config: { status: "invalid", path: "x", errors: ["a", "b"] } }))).toBe("no-config");
		expect(gateCode(state({ approval: undefined }))).toBe("unapproved");
		expect(gateCode(state({ approval: approval({ configHash: `jcs-sha256:${"f".repeat(64)}` }) }))).toBe("unapproved");
		expect(gateCode(state())).toBe("ok");
	});

	test("an approval record written by 0.8 (extra fields, approvalId) still passes", () => {
		const old = {
			...approval(),
			approvalId: "apr_01JZ0000000000000000000000",
			rawSha256: "0".repeat(64),
			approvedVia: { mode: "dialog" },
			versions: { omp: "19.0.1", storm: "0.8.0", configSchema: 1 },
			supersedes: null,
			expiresAt: null,
		};
		expect(teamGate(state({ approval: old })).ok).toBe(true);
	});
});

describe("decideSpawn: storm agents", () => {
	test("non-storm agents outside a run are left alone, with no record", () => {
		expect(decideSpawn(ev("task"), state({ config: { status: "missing", path: "x" }, approval: undefined }), runtime())).toEqual({
			decision: undefined,
		});
	});

	test("gate failures block with their code", () => {
		expect(code(decideSpawn(ev("storm-reviewer"), state({ config: { status: "missing", path: "x" } }), runtime()))).toBe("no-config");
		expect(code(decideSpawn(ev("storm-reviewer"), state({ approval: undefined }), runtime()))).toBe("unapproved");
	});

	test("a storm agent without a role or stand-in in the config, and a role without models, are no-config", () => {
		expect(code(decideSpawn(ev("storm-implementer"), state(), runtime()))).toBe("no-config");
		expect(code(decideSpawn(ev("storm-unknown"), state(), runtime()))).toBe("no-config");
		const empty = withConfig({ ...config, roles: { ...config.roles, explorer: { agent: "storm-explorer", models: [] } } });
		expect(code(decideSpawn(ev("storm-explorer"), empty, runtime()))).toBe("no-config");
	});

	test("an unapproved shadow definition blocks the spawned role only", () => {
		expect(code(decideSpawn(ev("storm-reviewer"), state({ shadows: [shadow] }), runtime()))).toBe("shadow");
		// Same agent approved with different content is still unapproved.
		const stale = approval({}, [{ ...shadow, sha256: "2".repeat(64) }]);
		expect(code(decideSpawn(ev("storm-reviewer"), state({ shadows: [shadow], approval: stale }), runtime()))).toBe("shadow");
		expect(code(decideSpawn(ev("storm-explorer"), state({ shadows: [shadow] }), runtime()))).toBeUndefined();
		const seen = state({ shadows: [shadow], approval: approval({}, [shadow]) });
		expect(decideSpawn(ev("storm-reviewer"), seen, runtime()).record?.outcome).toBe("routed");
	});

	test("routes to the approved models, effort applied only where no suffix exists; the record keeps key and request", () => {
		const out = decideSpawn(ev("storm-reviewer", ["x/y"], "Rev1"), state(), runtime());
		expect(models(out.decision)).toEqual(["openai/gpt-5.2:high", "anthropic/claude-x:low", "openrouter/qwen/qwen3:high"]);
		expect(out.record).toMatchObject({
			ts: "2026-11-20T12:00:00.000Z",
			agent: "storm-reviewer",
			requested: ["x/y"],
			outcome: "routed",
			role: "reviewer",
			spawnKey: "Rev1",
		});
		expect(out.record?.code).toBeUndefined();
	});

	test("quota marks push a role's marked providers back", () => {
		const marks: QuotaMark[] = [{ provider: "openai", source: "user", markedAt: "2026-11-20T00:00:00Z", until: "2026-11-21T00:00:00Z" }];
		const out = decideSpawn(ev("storm-reviewer"), state(), runtime({ quotaMarks: marks }));
		expect(models(out.decision)).toEqual(["anthropic/claude-x:low", "openrouter/qwen/qwen3:high", "openai/gpt-5.2:high"]);
	});

	test("a spent run budget blocks storm and other agents alike, approved model or not", () => {
		const spent = { costUsd: 5, budget: { perRunUsd: 5, onExceed: "block-spawns" as const } };
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), state(), inRun(spent)))).toBe("budget");
		expect(code(decideSpawn(ev("task", ["openai/gpt-5.2"], "T"), state(), inRun(spent)))).toBe("budget");
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), state(), inRun({ ...spent, costUsd: 4.99 })))).toBeUndefined();
	});
});

describe("decideSpawn: trials", () => {
	test("routing follows the share deterministically and tags every spawn of the role", () => {
		const s = withConfig({ ...config, trials: [baseTrial] });
		let counters: TrialState = { id: baseTrial.id, seen: 0, routed: 0, costUsd: 0 };
		const outcomes: string[] = [];
		for (let i = 0; i < 4; i++) {
			const out = decideSpawn(ev("storm-reviewer"), s, runtime({ trials: { [baseTrial.id]: counters } }));
			expect(out.record?.trialId).toBe(baseTrial.id);
			outcomes.push(out.record?.outcome ?? "");
			if (out.record?.outcome === "trial") expect(models(out.decision)?.[0]).toBe("zai/glm-5:high");
			counters = { ...counters, seen: counters.seen + 1, routed: counters.routed + (out.record?.outcome === "trial" ? 1 : 0) };
		}
		expect(outcomes).toEqual(["routed", "trial", "routed", "trial"]);
	});

	test("the candidate keeps its own effort and is not listed twice", () => {
		const trial: TrialConfig = { ...baseTrial, model: "anthropic/claude-x", effort: "medium", share: 1 };
		const out = decideSpawn(ev("storm-reviewer"), withConfig({ ...config, trials: [trial] }), runtime());
		expect(models(out.decision)).toEqual(["anthropic/claude-x:medium", "openai/gpt-5.2:high", "openrouter/qwen/qwen3:high"]);
	});

	test("trials stop routing at maxSpawns, end time and budget, and wait for start", () => {
		const s = withConfig({ ...config, trials: [{ ...baseTrial, share: 1 }] });
		const at = (over: Partial<TrialState>, now = NOW) =>
			decideSpawn(ev("storm-reviewer"), s, runtime({ now, trials: { [baseTrial.id]: { id: baseTrial.id, seen: 0, routed: 0, costUsd: 0, ...over } } })).record;
		expect(at({})?.outcome).toBe("trial");
		expect(at({ seen: 3, routed: 3 })?.outcome).toBe("routed");
		expect(at({ seen: 3, routed: 3 })?.trialId).toBeUndefined();
		expect(at({ costUsd: 1 })?.outcome).toBe("routed");
		expect(at({}, Date.parse("2026-11-27T00:00:00.000Z"))?.outcome).toBe("routed");
		expect(at({}, Date.parse("2026-11-19T23:59:59.000Z"))?.outcome).toBe("routed");
		expect(decideSpawn(ev("storm-explorer"), s, runtime()).record?.trialId).toBeUndefined();
	});
});

describe("decideSpawn: other agents during a run", () => {
	test("a mapped built-in is answered explicitly: exactly an approved entry is honoured, anything else gets the role's list; an unmapped native agent is refused", () => {
		const scout = decideSpawn(ev("scout", ["google/gemini-flash"], "look"), state(), inRun({ plan: FULL_PLAN }));
		// The answer is never "no opinion": omp's own patterns do not run.
		expect(models(scout.decision)).toEqual(["google/gemini-flash"]);
		expect(scout.record).toMatchObject({ outcome: "allowed", role: "explorer", models: ["google/gemini-flash"] });
		// An approved model with an effort the team did not approve is not the approved entry.
		const reviewer = decideSpawn(ev("reviewer", ["anthropic/claude-x:max"], "lane"), state(), inRun({ plan: FULL_PLAN }));
		expect(models(reviewer.decision)).toEqual(["openai/gpt-5.2:high", "anthropic/claude-x:low", "openrouter/qwen/qwen3:high"]);
		expect(reviewer.record?.outcome).toBe("substituted");
		// No role mapping means no lane, cap or capability decision: never an ordinary spawn during a run.
		for (const agent of ["custom", "sonic"]) {
			expect(code(decideSpawn(ev(agent, ["anthropic/claude-x:max"]), state(), inRun({ plan: FULL_PLAN })))).toBe("unmapped-agent");
		}
	});

	test("an unapproved model on a mapped built-in gets the fallback role's models; an unmapped agent stays refused", () => {
		const fallback = withConfig({ ...config, fallbackRole: "explorer" });
		const out = decideSpawn(ev("scout", ["x/unknown"], "look"), fallback, inRun({ plan: FULL_PLAN }));
		expect(models(out.decision)).toEqual(["google/gemini-flash"]);
		expect(out.record).toMatchObject({ outcome: "substituted", role: "explorer" });
		// `task` maps to implementer, which this team does not have; the fallback still speaks for that role.
		const task = decideSpawn(ev("task", ["x/unknown"], "build"), withConfig({ ...config, fallbackRole: "reviewer" }), inRun({ plan: FULL_PLAN }));
		expect(task.record).toMatchObject({ outcome: "substituted", role: "reviewer" });
		// A custom agent cannot borrow the fallback: it has no lane to attribute the substituted work to.
		expect(code(decideSpawn(ev("custom", ["x/unknown"]), fallback, inRun({ plan: FULL_PLAN })))).toBe("unmapped-agent");
		// A mapped built-in with no usable role and no fallback is unapproved.
		expect(code(decideSpawn(ev("task", ["x/unknown"], "build"), state(), inRun({ plan: FULL_PLAN })))).toBe("unapproved");
	});

	test("an unapproved config blocks every agent during a run", () => {
		expect(code(decideSpawn(ev("custom", ["openai/gpt-5.2"]), state({ approval: undefined }), inRun()))).toBe("unapproved");
	});

	test("a built-in agent gets its mapped role's models; unmapped roles fall back", () => {
		const scout = decideSpawn(ev("scout", ["x/unknown"], "look"), state(), inRun({ plan: FULL_PLAN }));
		expect(models(scout.decision)).toEqual(["google/gemini-flash"]);
		expect(scout.record).toMatchObject({ outcome: "substituted", role: "explorer" });
		// `task` maps to implementer, which this team does not have.
		const task = decideSpawn(ev("task", ["x/unknown"], "build"), withConfig({ ...config, fallbackRole: "reviewer" }), inRun({ plan: FULL_PLAN }));
		expect(task.record).toMatchObject({ outcome: "substituted", role: "reviewer" });
	});

	test("a read-only explore plan cannot admit an unmapped native agent; mapping alone does not supply a team role", () => {
		const readPlan: RunPlan = {
			lanes: [{ name: "look", kind: "explore", role: "explorer" }],
			workers: { explorer: 1 },
			submittedAt: "2026-11-20T11:00:00.000Z",
		};
		const readRun = inRun({ plan: readPlan });
		for (const agent of ["sonic", "custom"]) {
			expect(code(decideSpawn(ev(agent, ["google/gemini-flash"]), state(), readRun))).toBe("unmapped-agent");
		}
		// eval() spawns go through the same decision; an unmapped writer is refused there too.
		expect(code(decideSpawn({ agent: "sonic", invocationKind: "eval", patterns: ["google/gemini-flash"] }, state(), readRun))).toBe("unmapped-agent");
		// `task` maps implementer. A role the plan has no lane for is no longer refused: the child is placed unplanned,
		// so only a keyless spawn is refused here. This team has no implementer, so the model approval still refuses.
		expect(code(decideSpawn(ev("task", ["openai/gpt-5.2"]), state(), readRun))).toBe("unassigned-lane");
		expect(code(decideSpawn(ev("task", ["openai/gpt-5.2"], "build"), state(), readRun))).toBe("unapproved");
		// `scout` maps explorer and the plan has its lane; extension must still bind it to that lane and its read tools.
		expect(decideSpawn(ev("scout", ["google/gemini-flash"], "look"), state(), readRun).record).toMatchObject({ outcome: "allowed", role: "explorer" });
		// Native unrelated work outside Storm is unaffected, even with an unreadable/unapproved team.
		const outside = runtime();
		for (const agent of ["sonic", "custom", "task", "scout"]) {
			const unevaluated = decideSpawn(ev(agent, ["x/anything"], "own"), state({ approval: undefined }), outside);
			expect(unevaluated.decision).toBeUndefined();
			expect(unevaluated.record).toBeUndefined();
		}
	});

	test("a role spawn needs only a host key; a plan with no lane for its role places it unplanned", () => {
		const c = withConfig({
			...config,
			roles: { ...config.roles, implementer: { agent: "storm-implementer", models: ["a/i"] } },
		});
		const plan: RunPlan = {
			lanes: [
				{ name: "api", kind: "code", role: "implementer" },
				{ name: "web", kind: "code", role: "implementer" },
			],
			workers: { implementer: 2 },
			submittedAt: "2026-11-20T11:00:00.000Z",
		};
		const rt = inRun({ plan });
		// The host key is the one correlation fact the spawn decision needs; placement matched it exactly (R4).
		expect(code(decideSpawn(ev("storm-implementer", [], "api"), c, rt))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-implementer", [], "run-1-lane-2"), c, rt))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-implementer"), c, rt))).toBe("unassigned-lane");
		// A plan with no lane for the role no longer refuses the child: it is placed unplanned (R5), keyed by the host.
		const laneLess = inRun({ plan: { ...plan, lanes: [] } });
		expect(code(decideSpawn(ev("storm-implementer", [], "api"), c, laneLess))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-implementer"), c, laneLess))).toBe("unassigned-lane");
	});

	test("an approved shadow role definition spawns through its approved lane", () => {
		const approved = state({
			shadows: [shadow],
			approval: approval({}, [shadow]),
		});
		const out = decideSpawn(ev("storm-reviewer", [], "lane"), approved, inRun({ plan: FULL_PLAN }));
		expect(models(out.decision)).toEqual(["openai/gpt-5.2:high", "anthropic/claude-x:low", "openrouter/qwen/qwen3:high"]);
		expect(out.record).toMatchObject({ outcome: "routed", role: "reviewer" });
		// The same shadow without its approval remains blocked before any lane/cap decision.
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), state({ shadows: [shadow] }), inRun({ plan: FULL_PLAN })))).toBe("shadow");
	});

	test("a built-in agent mapped to a role takes that role's slot and meets omp's ceiling, whatever model it asked for", () => {
		const capPlan = { ...FULL_PLAN, workers: { explorer: 1, reviewer: 2 } };
		// The plan's one explorer is live: the plan's count no longer refuses a second, omp's ceiling does.
		const full = inRun({ plan: capPlan, active: { total: 1, byRole: { explorer: 1 } } }, { maxConcurrency: 1 });
		expect(code(decideSpawn(ev("scout", ["x/unknown"], "look"), state(), full))).toBe("parallelism");
		expect(code(decideSpawn(ev("scout", ["google/gemini-flash"], "look"), state(), full))).toBe("parallelism");
		expect(code(decideSpawn(ev("scout", ["google/gemini-flash"], "look"), state(), inRun({ plan: capPlan, active: { total: 1, byRole: { explorer: 1 } } })))).toBeUndefined();
		// With a slot free it runs, and its record names the role so it takes the slot.
		const free = inRun({ plan: capPlan, active: { total: 0, byRole: {} } });
		expect(decideSpawn(ev("scout", ["google/gemini-flash"], "look"), state(), free).record).toMatchObject({ outcome: "allowed", role: "explorer" });
		// A role the plan has no lane for still spawns through its built-in when the host gives the key; only a keyless
		// spawn is refused, because it cannot be correlated to a placement.
		const noLane = inRun({ plan: { ...PLAN, workers: { reviewer: 2 } } });
		expect(code(decideSpawn(ev("scout", ["x/unknown"], "look"), state(), noLane))).toBeUndefined();
		expect(code(decideSpawn(ev("scout", ["x/unknown"]), state(), noLane))).toBe("unassigned-lane");
	});
});

describe("decideSpawn: role states", () => {
	const team: StormConfig = {
		...config,
		roles: {
			implementer: { agent: "storm-implementer", models: ["a/impl"] },
			reviewer: { agent: "storm-reviewer", models: ["a/rev"] },
		},
		disabledRoles: ["architect"],
	};

	test("a disabled role is blocked as disabled-role and recorded under its own id", () => {
		const out = decideSpawn(ev("storm-architect"), withConfig(team), runtime());
		expect(code(out)).toBe("disabled-role");
		expect(out.record?.role).toBe("architect");
	});

	test("a missing role borrows its nearest configured stand-in, never that role's trial", () => {
		const out = decideSpawn(ev("storm-quick"), withConfig(team), runtime());
		expect(models(out.decision)).toEqual(["a/impl"]);
		expect(out.record).toMatchObject({ outcome: "substituted", role: "implementer" });
		const trial: TrialConfig = { ...baseTrial, role: "implementer", share: 1 };
		const borrowed = decideSpawn(ev("storm-quick"), withConfig({ ...team, trials: [trial] }), runtime());
		expect(borrowed.record?.outcome).toBe("substituted");
		expect(borrowed.record?.trialId).toBeUndefined();
	});

	test("a stand-in spawn counts against the role it asked for, under omp's ceiling", () => {
		const plan: RunPlan = {
			...PLAN,
			lanes: [
				{ name: "quick", kind: "run", role: "quick" },
				{ name: "impl", kind: "code", role: "implementer" },
			],
			workers: { quick: 1, implementer: 2 },
		};
		const busy = inRun({ plan, active: { total: 1, byRole: { quick: 1 } } });
		expect(code(decideSpawn(ev("storm-quick", [], "quick"), withConfig(team), busy))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-implementer", [], "impl"), withConfig(team), busy))).toBeUndefined();
		const record = decideSpawn(ev("storm-quick", [], "quick"), withConfig(team), busy).record;
		expect(record).toMatchObject({ outcome: "substituted" });
	});
});

describe("decideSpawn: run plan and live caps", () => {
	test("order of the run checks: budget, then the native ceiling, then the host key", () => {
		const spent = { costUsd: 9, budget: { perRunUsd: 5, onExceed: "block-spawns" as const } };
		const { plan: _plan, ...noPlan } = inRun().run as Run;
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), state(), runtime({ run: { ...noPlan, ...spent } })))).toBe("budget");
		// A plan-less run is no refusal: only a spawn the host gave no key cannot be correlated.
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), state(), runtime({ run: noPlan })))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-reviewer"), state(), runtime({ run: noPlan })))).toBe("unassigned-lane");
		// An unmapped native agent is refused before the key check (and before the native ceiling).
		expect(code(decideSpawn(ev("custom", ["openai/gpt-5.2"], "own"), state(), runtime({ run: noPlan })))).toBe("unmapped-agent");
		const full = { total: 2, byRole: { reviewer: 2 } };
		// The plan's worker count for the role is no limit: two live reviewers against a plan of one never blocked by role.
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), state(), inRun({ active: full }, { maxConcurrency: 8 })))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), state(), inRun({ active: full }, { maxConcurrency: 2 })))).toBe("parallelism");
		expect(code(decideSpawn(ev("storm-explorer"), state(), inRun({ plan: FULL_PLAN, active: full }, { maxConcurrency: 2 })))).toBe("parallelism");
		// An unmapped native agent is refused before the native ceiling check.
		expect(code(decideSpawn(ev("custom", ["openai/gpt-5.2"]), state(), inRun({ plan: FULL_PLAN, active: full }, { maxConcurrency: 2 })))).toBe("unmapped-agent");
		expect(code(decideSpawn(ev("task", ["openai/gpt-5.2"], "build"), state(), inRun({ plan: FULL_PLAN, active: full }, { maxConcurrency: 2 })))).toBe("parallelism");
	});

	test("the native ceiling is enforced as read, and absent or 0 never invents a Storm cap", () => {
		const full = { total: 2, byRole: { reviewer: 0, explorer: 0, implementer: 0 } };
		const spawn = (runtime: SpawnRuntime) => code(decideSpawn(ev("storm-explorer", [], "look"), state(), runtime));
		// Undefined host settings leave the run-wide decision to the host semaphore, not a Storm default.
		expect(spawn(inRun({ plan: FULL_PLAN, active: full }))).toBeUndefined();
		// OMP's 0 is unlimited.
		expect(spawn(inRun({ plan: FULL_PLAN, active: full }, { maxConcurrency: 0 }))).toBeUndefined();
		// 2 live < 3 passes; 2 live >= 2 blocks with the parallelism code.
		expect(spawn(inRun({ plan: FULL_PLAN, active: full }, { maxConcurrency: 3 }))).toBeUndefined();
		const blocked = decideSpawn(ev("storm-explorer", [], "look"), state(), inRun({ plan: FULL_PLAN, active: full }, { maxConcurrency: 2 }));
		expect(code(blocked)).toBe("parallelism");
		expect(blocked.decision && "block" in blocked.decision ? blocked.decision.reason : "").toContain("task.maxConcurrency 2");
	});

	test("a role absent from the plan still spawns with the host's key; outside a run no key is needed", () => {
		const plan: RunPlan = { ...PLAN, workers: { reviewer: 1 } };
		expect(code(decideSpawn(ev("storm-explorer", [], "look"), state(), inRun({ plan })))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-explorer"), state(), inRun({ plan })))).toBe("unassigned-lane");
		expect(code(decideSpawn(ev("storm-explorer"), state(), runtime()))).toBeUndefined();
	});

	test("the plan's workers for a role are a planning figure: a live worker of the role never blocks another; omp's ceiling does", () => {
		const plan: RunPlan = { ...PLAN, workers: { reviewer: 1, explorer: 1 } };
		const wide = withConfig(config);
		const live = { total: 1, byRole: { reviewer: 1 } };
		// One reviewer is live against a plan of one: this was `role-cap`.
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), wide, inRun({ plan, active: live }, { maxConcurrency: 8 })))).toBeUndefined();
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), wide, inRun({ plan, active: live }, { maxConcurrency: 1 })))).toBe("parallelism");
		expect(code(decideSpawn(ev("storm-reviewer", [], "lane"), wide, inRun({ plan, active: { total: 1, byRole: { explorer: 1 } } }, { maxConcurrency: 8 })))).toBeUndefined();
		// A mapped built-in agent takes the same rule as its role's storm-* agent.
		expect(code(decideSpawn(ev("reviewer", ["openai/gpt-5.2"], "lane"), wide, inRun({ plan, active: live }, { maxConcurrency: 8 })))).toBeUndefined();
	});

	test("a refusal over the approval or the budget tells the director not to send the call again", () => {
		const text = (outcome: SpawnOutcome): string => (outcome.decision !== undefined && "block" in outcome.decision ? outcome.decision.reason : "");
		expect(text(decideSpawn(ev("storm-reviewer"), { config: { status: "missing", path: "/r/.omp/storm/config.json" }, approval: undefined, shadows: [] }, runtime()))).toContain(APPROVAL_CHECK);
		const spent = { costUsd: 9, budget: { perRunUsd: 5, onExceed: "block-spawns" as const } };
		const { plan: _plan, ...noPlan } = inRun().run as Run;
		expect(text(decideSpawn(ev("storm-reviewer"), state(), runtime({ run: { ...noPlan, ...spent } })))).toContain(BUDGET_CHECK);
	});
});

describe("failClosed", () => {
	const boom = async (): Promise<SpawnDecision> => {
		throw new Error("state file unreadable");
	};
	const blockCode = (d: SpawnDecision) => (d && "block" in d ? /^\[storm:([a-z-]+)\] /.exec(d.reason)?.[1] : undefined);

	test("a failure while deciding blocks storm-* agents, in a run or not", async () => {
		expect(blockCode(await failClosed("storm-implementer", () => false, boom))).toBe("internal");
		expect(blockCode(await failClosed("storm-implementer", () => true, boom))).toBe("internal");
	});

	test("it blocks any agent during a run and leaves other agents alone outside one", async () => {
		expect(blockCode(await failClosed("task", () => true, boom))).toBe("internal");
		expect(await failClosed("task", () => false, boom)).toBeUndefined();
	});

	test("not knowing whether a run is active counts as a run", async () => {
		const unknown = () => {
			throw new Error("no ledger");
		};
		expect(blockCode(await failClosed("task", unknown, boom))).toBe("internal");
	});

	test("a decision that succeeds is returned as is", async () => {
		const decision: SpawnDecision = { model: ["a/b"], note: "n" };
		expect(await failClosed("storm-implementer", () => true, async () => decision)).toBe(decision);
		expect(await failClosed("task", () => true, async () => undefined)).toBeUndefined();
	});

	test("a decision that outlasts its deadline is blocked like a failed one, and the block is reported once", async () => {
		// A hung git call or state read: the decision never settles.
		const hung = () => Promise.withResolvers<SpawnDecision>().promise;
		const expired = Promise.reject<never>(new Error("deadline"));
		const blocks: string[] = [];
		const decision = await failClosed("storm-implementer", () => true, hung, { expired, onBlock: block => blocks.push(block.code) });
		expect(blockCode(decision)).toBe("internal");
		expect(blocks).toEqual(["internal"]);
		// Outside a run another agent stays omp's business, and nothing is reported.
		expect(await failClosed("task", () => false, hung, { expired, onBlock: block => blocks.push(block.code) })).toBeUndefined();
		expect(blocks).toHaveLength(1);
	});

	test("a decision in time wins over the deadline; a throwing report does not lift the block", async () => {
		const pending = Promise.withResolvers<never>();
		const decision: SpawnDecision = { model: ["a/b"], note: "n" };
		expect(await failClosed("storm-implementer", () => true, async () => decision, { expired: pending.promise })).toBe(decision);
		const failing = () => {
			throw new Error("ledger gone");
		};
		expect(blockCode(await failClosed("storm-implementer", () => true, boom, { onBlock: failing }))).toBe("internal");
	});

	test("an internal block makes a spawn record with its code, like any other block", async () => {
		const event: SpawnEvent = { agent: "storm-implementer", invocationKind: "task", patterns: ["a/b:high"], spawnKey: "Impl" };
		const records: SpawnRecord[] = [];
		await failClosed("storm-implementer", () => true, boom, { onBlock: block => records.push(blockedSpawn(event, block, NOW)) });
		expect(records).toMatchObject([
			{ ts: new Date(NOW).toISOString(), agent: "storm-implementer", invocationKind: "task", requested: ["a/b:high"], outcome: "blocked", code: "internal", spawnKey: "Impl" },
		]);
		expect(records[0]?.reason).toContain("state file unreadable");
	});
});

describe("selector helpers", () => {
	test("stripEffort drops only known effort suffixes", () => {
		expect(stripEffort("openai/gpt-5.2:high")).toBe("openai/gpt-5.2");
		expect(stripEffort("anthropic/claude-x:thinking")).toBe("anthropic/claude-x:thinking");
		expect(stripEffort("openrouter/qwen/qwen3")).toBe("openrouter/qwen/qwen3");
		expect(stripEffort("")).toBe("");
	});

	test("withEffort skips ids that already carry a suffix", () => {
		expect(withEffort("openai/gpt-5.2", "low")).toBe("openai/gpt-5.2:low");
		expect(withEffort("anthropic/claude-x:max", "low")).toBe("anthropic/claude-x:max");
		expect(withEffort("openai/gpt-5.2", undefined)).toBe("openai/gpt-5.2");
	});

	test("approvedSelectors covers role and trial models without effort", () => {
		const trial: TrialConfig = { ...baseTrial, model: "zai/glm-5:low" };
		expect([...approvedSelectors({ ...config, trials: [trial] })].sort()).toEqual([
			"anthropic/claude-x",
			"google/gemini-flash",
			"openai/gpt-5.2",
			"openrouter/qwen/qwen3",
			"zai/glm-5",
		]);
	});

	test("orderByQuota moves marked providers last, stably, unless all or none are marked", () => {
		const mark = (provider: string): QuotaMark => ({ provider, source: "user", markedAt: "2026-11-20T00:00:00Z", until: "2026-11-21T00:00:00Z" });
		const list = ["anthropic/a", "openai/b", "anthropic/c", "google/d"];
		expect(orderByQuota(list, [mark("anthropic")])).toEqual(["openai/b", "google/d", "anthropic/a", "anthropic/c"]);
		expect(orderByQuota(list, [])).toEqual(list);
		expect(orderByQuota(["anthropic/a", "anthropic/c"], [mark("anthropic")])).toEqual(["anthropic/a", "anthropic/c"]);
		expect(orderByQuota(list, [mark("openrouter")])).toEqual(list);
	});
});

const ledgerAgent = (over: Partial<AgentEntry> = {}): AgentEntry =>
	agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", runId: "run-1", startedAt: NOW - 60_000, lastActivityAt: NOW, contextTokens: 10_000, ...over });

describe("activeAgents", () => {
	const rec = (spawnKey: string | undefined, over: Partial<SpawnRecord> = {}): SpawnRecord => {
		const { spawnKey: _default, ...record } = spawnRecord({ ts: new Date(NOW - 10_000).toISOString(), agent: "storm-explorer", role: "explorer", ...over });
		return spawnKey === undefined ? record : { ...record, spawnKey };
	};
	const live = (id: string, s: AgentEntry["state"]): AgentEntry => ledgerAgent({ id, name: "storm-explorer", role: "explorer", state: s });

	test("running and just-decided agents count; settled, blocked and unkeyed ones do not", () => {
		const { role: _role, ...task } = rec("Task", { agent: "task", outcome: "allowed" });
		const spawns = [
			rec("Running"),
			rec("Idle"),
			rec("Parked", { role: "reviewer", agent: "storm-reviewer" }),
			rec("Pending", { role: "reviewer", agent: "storm-reviewer" }),
			rec("Refused", { outcome: "blocked" }),
			rec(undefined),
			task,
		];
		const agents = [live("Running", "running"), live("Idle", "idle"), live("Parked", "parked"), live("Task", "running")];
		expect(activeAgents(spawns, agents, NOW)).toEqual({ total: 3, byRole: { explorer: 1, reviewer: 1 } });
	});

	test("a spawn that never reported holds its slot for the pending window only", () => {
		expect(PENDING_SPAWN_MS).toBe(30_000);
		const at = (age: number) => activeAgents([rec("Ghost", { ts: new Date(NOW - age).toISOString() })], [], NOW).total;
		expect(at(PENDING_SPAWN_MS - 1)).toBe(1);
		expect(at(PENDING_SPAWN_MS)).toBe(0);
	});

	test("a storm stand-in counts under the role it asked for; a built-in under the role it got", () => {
		const standIn = rec("Scout", { outcome: "substituted", role: "implementer" });
		const builtin = rec("Task", { agent: "task", outcome: "substituted", role: "implementer" });
		expect(activeAgents([standIn, builtin], [], NOW).byRole).toEqual({ explorer: 1, implementer: 1 });
	});
});

describe("follow-ups", () => {
	const write = (id: string) => ({ path: `agent://${id}`, content: "fix the findings" });
	// Storm no longer refuses any follow-up; after omp fails to deliver one, this is the cause it adds.
	const noteOf = (agents: AgentEntry[], id = "Rev") => followUpFailureNote("write", write(id), agents);

	test("context size, run and state never explain a failure: only a cleanup does", () => {
		expect(noteOf([ledgerAgent({ contextTokens: 199_999 })])).toBeUndefined();
		expect(noteOf([ledgerAgent({ contextTokens: 900_000 })])).toBeUndefined();
		expect(noteOf([ledgerAgent({ contextTokens: 95_000, model: "mistral/small-100k" })])).toBeUndefined();
		expect(noteOf([ledgerAgent({ runId: "run-0", contextTokens: 400_000 })])).toBeUndefined();
		const { runId: _runId, ...noRun } = ledgerAgent({ contextTokens: 400_000 });
		expect(noteOf([noRun])).toBeUndefined();
	});

	test("a cleaned agent's failure is explained, whatever its context or run", () => {
		expect(noteOf([ledgerAgent({ contextTokens: 10, cleanedAt: NOW })])).toBeDefined();
		expect(noteOf([ledgerAgent({ contextTokens: 900_000, cleanedAt: NOW })])).toBeDefined();
		expect(noteOf([ledgerAgent({ runId: "run-0", cleanedAt: NOW })])).toBeDefined();
	});

	test("the note names the cause and the handle a fresh agent reads", () => {
		const note = noteOf([ledgerAgent({ cleanedAt: NOW })]);
		expect(note).toContain("agent://Rev");
		expect(note).toContain("storm-reviewer");
		expect(note).toContain("정리");
	});

	test("other tools, other paths and unknown agents have no note; ids match as omp resolves them", () => {
		const cleaned = [ledgerAgent({ cleanedAt: NOW })];
		expect(followUpFailureNote("read", write("Rev"), cleaned)).toBeUndefined();
		expect(followUpFailureNote("write", { path: "local://notes.md", content: "x" }, cleaned)).toBeUndefined();
		expect(noteOf(cleaned, "Nobody")).toBeUndefined();
		expect(noteOf(cleaned, "rev")).toBeDefined();
		expect(followUpFailureNote("write", { path: "agent://Rev?progress", content: "x" }, cleaned)).toBeDefined();
		expect(followUpAgent([ledgerAgent({ id: "rev" }), ledgerAgent({ id: "Rev" })], "Rev")?.id).toBe("Rev");
	});

	test("a delivered write names its target; failed writes, progress notes and other calls do not count", () => {
		expect(deliveredFollowUp("write", write("Rev"), false)).toBe("Rev");
		expect(deliveredFollowUp("write", { path: "agent://Rev/", content: "x" }, false)).toBe("Rev");
		expect(deliveredFollowUp("write", write("Rev"), true)).toBeUndefined();
		expect(deliveredFollowUp("write", { path: "agent://Rev?progress", content: "x" }, false)).toBeUndefined();
		expect(deliveredFollowUp("write", { path: "src/a.ts", content: "x" }, false)).toBeUndefined();
		expect(deliveredFollowUp("read", { path: "agent://Rev" }, false)).toBeUndefined();
		// The native progress form is identifiable on its own, so the scheduler can keep it out of the work gate.
		expect(followUpProgress("write", { path: "agent://Rev?progress", content: "x" })).toBe(true);
		expect(followUpProgress("write", { path: "agent://Rev?x=1&progress", content: "x" })).toBe(true);
		expect(followUpProgress("write", write("Rev"))).toBe(false);
		expect(followUpProgress("read", { path: "agent://Rev?progress" })).toBe(false);
		expect(followUpProgress("write", { path: "src/a.ts?progress", content: "x" })).toBe(false);
	});
});
