import { describe, expect, test } from "bun:test";
import { followUpBlock } from "../src/policy/followup.ts";
import { activeAgents, approvedSelectors, decideSpawn, orderByQuota, stripEffort, withEffort } from "../src/policy/spawn.ts";
import type {
	AgentEntry,
	ApprovalRecord,
	ConfigLoad,
	QuotaMark,
	RunPlan,
	ShadowInfo,
	SpawnDecision,
	SpawnEvent,
	SpawnRecord,
	SpawnRuntime,
	SpawnState,
	StormConfig,
	TrialConfig,
	TrialState,
} from "../src/types.ts";

const HASH = `jcs-sha256:${"ab12".repeat(16)}`;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		reviewer: { agent: "storm-reviewer", models: ["openai/gpt-5.2", "anthropic/claude-x:low", "openrouter/qwen/qwen3"], effort: "high" },
		explorer: { agent: "storm-explorer", models: ["google/gemini-flash"] },
	},
	parallelism: 2,
	isolation: "isolated",
	contract: "workflowz",
	runtime: "omp",
};

const ok: Extract<ConfigLoad, { status: "ok" }> = {
	status: "ok",
	path: "/r/.omp/storm/config.json",
	config,
	hash: HASH,
	rawSha256: "0".repeat(64),
	warnings: [],
};

const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/r/.omp/agents/rev.md", scope: "project", sha256: "1".repeat(64) };

function approval(overrides: Partial<ApprovalRecord> = {}, shadowedAgents: ShadowInfo[] = []): ApprovalRecord {
	return {
		schema: "storm.approval/v1",
		approvalId: "apr_01JZ0000000000000000000000",
		status: "active",
		repoId: "git-r-000000000000000000000000",
		configHash: HASH,
		rawSha256: "0".repeat(64),
		approvedAt: "2026-11-20T00:00:00.000Z",
		approvedVia: { mode: "dialog" },
		versions: { omp: "19.0.1", storm: "0.1.0", configSchema: 1 },
		scope: { providers: ["openai"], roles: config.roles, runtime: "omp", shadowedAgents },
		supersedes: null,
		expiresAt: null,
		...overrides,
	};
}

const ev = (agent: string, patterns: string[] = []): SpawnEvent => ({ agent, invocationKind: "task", patterns });
const state = (over: Partial<SpawnState> = {}): SpawnState => ({ config: ok, approval: approval(), shadows: [], ...over });
const runtime = (over: Partial<SpawnRuntime> = {}): SpawnRuntime => ({ now: NOW, quotaMarks: [], trials: {}, ...over });
const PLAN: RunPlan = {
	lanes: [{ name: "lane", kind: "code", role: "reviewer" }],
	workers: { reviewer: 2, explorer: 2, implementer: 2 },
	submittedAt: "2026-11-20T11:00:00.000Z",
};
const inRun = (over: Partial<SpawnRuntime> = {}): SpawnRuntime => runtime({ run: { runId: "run-1", costUsd: 0, plan: PLAN }, ...over });
const decide = (e: SpawnEvent, s: SpawnState, rt: SpawnRuntime = runtime()): SpawnDecision => decideSpawn(e, s, rt).decision;
const reason = (d: SpawnDecision): string | undefined => (d && "block" in d ? d.reason : undefined);
const models = (d: SpawnDecision): string[] | undefined => (d && "model" in d ? d.model : undefined);

/** Config `c` loaded and approved under the same hash. */
function withConfig(c: StormConfig): SpawnState {
	return state({ config: { ...ok, config: c } });
}

describe("decideSpawn (v0.1 cases)", () => {
	test("leaves non-storm agents alone even when nothing is approved", () => {
		expect(decideSpawn(ev("task"), state({ config: { status: "missing", path: "x" }, approval: undefined }), runtime())).toEqual({
			decision: undefined,
		});
	});

	test("blocks when config is missing or invalid", () => {
		expect(reason(decide(ev("storm-reviewer"), state({ config: { status: "missing", path: "x" } })))).toBe(
			"Storm 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		);
		const invalid: ConfigLoad = { status: "invalid", path: "x", errors: ["version: 1이어야 합니다", "b"] };
		expect(reason(decide(ev("storm-reviewer"), state({ config: invalid })))).toBe("Storm 설정 오류: version: 1이어야 합니다");
	});

	test("blocks without an active approval for this exact hash", () => {
		const expected = "승인되지 않은 Storm 설정입니다(ab12ab12ab12). /storm 으로 승인하세요.";
		expect(reason(decide(ev("storm-reviewer"), state({ approval: undefined })))).toBe(expected);
		expect(reason(decide(ev("storm-reviewer"), state({ approval: approval({ status: "revoked" }) })))).toBe(expected);
		const other = approval({ configHash: `jcs-sha256:${"f".repeat(64)}` });
		expect(reason(decide(ev("storm-reviewer"), state({ approval: other })))).toBe(expected);
	});

	test("blocks a storm agent the config has no role for", () => {
		expect(reason(decide(ev("storm-implementer"), state()))).toBe("Storm 설정에 storm-implementer 역할이 없습니다.");
	});

	test("blocks unapproved shadow definitions of the spawned role only", () => {
		const blocked = "승인되지 않은 역할 정의가 있습니다: /r/.omp/agents/rev.md. /storm 으로 확인하세요.";
		expect(reason(decide(ev("storm-reviewer"), state({ shadows: [shadow] })))).toBe(blocked);
		// Same agent approved with different content is still unapproved.
		const stale = approval({}, [{ ...shadow, sha256: "2".repeat(64) }]);
		expect(reason(decide(ev("storm-reviewer"), state({ shadows: [shadow], approval: stale })))).toBe(blocked);
		// A shadow of another role does not block this one.
		expect(reason(decide(ev("storm-explorer"), state({ shadows: [shadow] })))).toBeUndefined();
		// Approved (agent, sha256) pair passes.
		const d = decide(ev("storm-reviewer"), state({ shadows: [shadow], approval: approval({}, [shadow]) }));
		expect(d && "model" in d).toBe(true);
	});

	test("routes to approved models with effort applied only where no suffix exists", () => {
		expect(decide(ev("storm-reviewer"), state())).toEqual({
			model: ["openai/gpt-5.2:high", "anthropic/claude-x:low", "openrouter/qwen/qwen3:high"],
			note: "storm: storm-reviewer → openai/gpt-5.2:high",
		});
		expect(decide(ev("storm-explorer"), state())).toEqual({
			model: ["google/gemini-flash"],
			note: "storm: storm-explorer → google/gemini-flash",
		});
	});

	test("blocks a role with no models", () => {
		const empty: ConfigLoad = { ...ok, config: { ...config, roles: { r: { agent: "storm-reviewer", models: [] } } } };
		expect(reason(decide(ev("storm-reviewer"), state({ config: empty })))).toBeDefined();
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

describe("decideSpawn (v0.2 storm agents)", () => {
	test("records routed spawns with timestamps and requested patterns", () => {
		const out = decideSpawn(ev("storm-explorer", ["pi/smol"]), state(), runtime());
		expect(out.record).toEqual({
			ts: "2026-11-20T12:00:00.000Z",
			agent: "storm-explorer",
			invocationKind: "task",
			requested: ["pi/smol"],
			outcome: "routed",
			models: ["google/gemini-flash"],
			role: "explorer",
		});
	});

	test("the caller's spawn key is kept so the record points at the subagent (agent://<key>)", () => {
		const out = decideSpawn({ ...ev("storm-implementer", ["pi/smol"]), spawnKey: "ResidencyImpl" }, state(), runtime());
		expect(out.record?.spawnKey).toBe("ResidencyImpl");
		const blocked = decideSpawn({ ...ev("storm-reviewer"), spawnKey: "Review" }, state({ approval: undefined }), runtime());
		expect(blocked.record).toMatchObject({ outcome: "blocked", spawnKey: "Review" });
	});

	test("blocked storm spawns carry the reason in the record", () => {
		const out = decideSpawn(ev("storm-reviewer"), state({ approval: undefined }), runtime());
		expect(out.record?.outcome).toBe("blocked");
		expect(out.record?.reason).toBe("승인되지 않은 Storm 설정입니다(ab12ab12ab12). /storm 으로 승인하세요.");
	});

	test("blocks new storm spawns once the run budget is spent", () => {
		const budget = { perRunUsd: 5, onExceed: "block-spawns" as const };
		const over = inRun({ run: { runId: "run-1", costUsd: 5.2, budget } });
		const out = decideSpawn(ev("storm-reviewer"), state(), over);
		expect(reason(out.decision)).toBe("Storm 실행 예산 $5.00을 넘었습니다(누계 $5.20). 새 스폰을 막습니다.");
		expect(out.record).toMatchObject({ outcome: "blocked", role: "reviewer" });
		const small = inRun({ run: { runId: "run-1", costUsd: 0.75, budget: { ...budget, perRunUsd: 0.5 } } });
		expect(reason(decide(ev("storm-explorer"), state(), small))).toBe(
			"Storm 실행 예산 $0.5000을 넘었습니다(누계 $0.7500). 새 스폰을 막습니다.",
		);
		const under = inRun({ run: { runId: "run-1", costUsd: 4.99, budget, plan: PLAN } });
		expect(models(decide(ev("storm-explorer"), state(), under))).toEqual(["google/gemini-flash"]);
	});

	test("quota marks push a role's marked providers back", () => {
		const marks: QuotaMark[] = [{ provider: "openai", source: "user", markedAt: "2026-11-20T00:00:00Z", until: "2026-11-21T00:00:00Z" }];
		const d = decide(ev("storm-reviewer"), state(), runtime({ quotaMarks: marks }));
		expect(d).toEqual({
			model: ["anthropic/claude-x:low", "openrouter/qwen/qwen3:high", "openai/gpt-5.2:high"],
			note: "storm: storm-reviewer → anthropic/claude-x:low",
		});
	});

	test("trial routing follows the share deterministically and tags every spawn", () => {
		const s = withConfig({ ...config, trials: [baseTrial] });
		let counters: TrialState = { id: baseTrial.id, seen: 0, routed: 0, costUsd: 0 };
		const outcomes: string[] = [];
		for (let i = 0; i < 4; i++) {
			const out = decideSpawn(ev("storm-reviewer"), s, runtime({ trials: { [baseTrial.id]: counters } }));
			expect(out.record?.trialId).toBe(baseTrial.id);
			outcomes.push(out.record?.outcome ?? "");
			if (out.record?.outcome === "trial") {
				expect(models(out.decision)).toEqual([
					"zai/glm-5:high",
					"openai/gpt-5.2:high",
					"anthropic/claude-x:low",
					"openrouter/qwen/qwen3:high",
				]);
			}
			counters = { ...counters, seen: counters.seen + 1, routed: counters.routed + (out.record?.outcome === "trial" ? 1 : 0) };
		}
		expect(outcomes).toEqual(["routed", "trial", "routed", "trial"]);
	});

	test("trial candidate keeps its own effort and is not listed twice", () => {
		const trial: TrialConfig = { ...baseTrial, model: "anthropic/claude-x", effort: "medium", share: 1 };
		const d = decide(ev("storm-reviewer"), withConfig({ ...config, trials: [trial] }));
		expect(models(d)).toEqual(["anthropic/claude-x:medium", "openai/gpt-5.2:high", "openrouter/qwen/qwen3:high"]);
	});

	test("trials stop routing at maxSpawns, end time and budget, and wait for start", () => {
		const s = withConfig({ ...config, trials: [{ ...baseTrial, share: 1 }] });
		const at = (over: Partial<TrialState>, now = NOW) =>
			decideSpawn(ev("storm-reviewer"), s, runtime({ now, trials: { [baseTrial.id]: { id: baseTrial.id, seen: 0, routed: 0, costUsd: 0, ...over } } })).record;
		expect(at({})?.outcome).toBe("trial");
		expect(at({ seen: 3, routed: 3 })).toMatchObject({ outcome: "routed" });
		expect(at({ seen: 3, routed: 3 })?.trialId).toBeUndefined();
		expect(at({ costUsd: 1 })?.outcome).toBe("routed");
		expect(at({}, Date.parse("2026-11-27T00:00:00.000Z"))?.outcome).toBe("routed");
		expect(at({}, Date.parse("2026-11-19T23:59:59.000Z"))?.outcome).toBe("routed");
		// Trials of another role never touch this one.
		expect(decideSpawn(ev("storm-explorer"), s, runtime()).record?.trialId).toBeUndefined();
	});
});

describe("decideSpawn (v0.2 non-Storm agents)", () => {
	test("stays out with no record outside a run", () => {
		expect(decideSpawn(ev("task", ["evil/model"]), state(), runtime())).toEqual({ decision: undefined });
		expect(decideSpawn(ev("scout"), state({ approval: undefined }), runtime())).toEqual({ decision: undefined });
	});

	test("allows approved models during a run, ignoring effort suffixes", () => {
		const out = decideSpawn(ev("task", ["openai/gpt-5.2:low"]), state(), inRun());
		expect(out.decision).toBeUndefined();
		expect(out.record).toEqual({
			ts: "2026-11-20T12:00:00.000Z",
			agent: "task",
			invocationKind: "task",
			requested: ["openai/gpt-5.2:low"],
			outcome: "allowed",
		});
	});

	test("allows trial candidates as approved models", () => {
		const out = decideSpawn(ev("scout", ["zai/glm-5"]), withConfig({ ...config, trials: [baseTrial] }), inRun());
		expect(out.record?.outcome).toBe("allowed");
	});

	test("substitutes the fallback role's models for unapproved requests", () => {
		const marks: QuotaMark[] = [{ provider: "openai", source: "usage", markedAt: "2026-11-20T00:00:00Z", until: "2026-11-21T00:00:00Z" }];
		const out = decideSpawn(ev("task", ["evil/model:high"]), withConfig({ ...config, fallbackRole: "reviewer" }), inRun({ quotaMarks: marks }));
		expect(out.decision).toEqual({
			model: ["anthropic/claude-x:low", "openrouter/qwen/qwen3:high", "openai/gpt-5.2:high"],
			note: "storm: task → anthropic/claude-x:low",
		});
		expect(out.record).toMatchObject({
			outcome: "substituted",
			role: "reviewer",
			reason: "승인 밖 모델 evil/model → reviewer 역할 모델",
			requested: ["evil/model:high"],
			models: ["anthropic/claude-x:low", "openrouter/qwen/qwen3:high", "openai/gpt-5.2:high"],
		});
	});

	test("blocks unapproved requests without a usable fallback role", () => {
		const out = decideSpawn(ev("task", ["evil/model"]), state(), inRun());
		expect(reason(out.decision)).toBe("Storm 실행 중에는 승인된 모델만 쓸 수 있습니다(요청: evil/model). /storm 으로 대체 역할을 정하세요.");
		expect(out.record).toMatchObject({ outcome: "blocked", requested: ["evil/model"] });
		const empty = withConfig({ ...config, fallbackRole: "gone" });
		expect(reason(decide(ev("task"), empty, inRun()))).toBe(
			"Storm 실행 중에는 승인된 모델만 쓸 수 있습니다(요청: 없음). /storm 으로 대체 역할을 정하세요.",
		);
	});

	test("blocks during a run when the config is not approved", () => {
		expect(reason(decide(ev("task", ["openai/gpt-5.2"]), state({ approval: undefined }), inRun()))).toBe(
			"승인되지 않은 Storm 설정입니다(ab12ab12ab12). /storm 으로 승인하세요.",
		);
		expect(reason(decide(ev("task"), state({ config: { status: "missing", path: "x" } }), inRun()))).toBe(
			"Storm 설정이 없습니다. /storm 으로 팀을 설정하세요.",
		);
	});

	test("blocks during a run once the budget is spent, even for approved models", () => {
		const over = inRun({ run: { runId: "run-1", costUsd: 12.5, budget: { perRunUsd: 10, onExceed: "stop" } } });
		const out = decideSpawn(ev("task", ["openai/gpt-5.2"]), state(), over);
		expect(reason(out.decision)).toBe("Storm 실행 예산 $10.00을 넘었습니다(누계 $12.50). 새 스폰을 막습니다.");
		expect(out.record?.outcome).toBe("blocked");
	});
});

describe("decideSpawn (v0.7 role states)", () => {
	const team: StormConfig = {
		...config,
		roles: {
			implementer: { agent: "storm-implementer", models: ["openai/gpt-5.2"], effort: "medium" },
			reviewer: config.roles.reviewer!,
		},
	};

	test("a disabled role is blocked and points to its first configured stand-in", () => {
		const out = decideSpawn(ev("storm-explorer"), withConfig({ ...team, disabledRoles: ["explorer"] }), runtime());
		expect(reason(out.decision)).toBe(
			"storm-explorer(탐색)는 이 팀에서 쓰지 않습니다(설정에서 사용 안 함). 대신 storm-implementer 를 쓰세요.",
		);
		const arch = decideSpawn(ev("storm-architect"), withConfig({ ...team, disabledRoles: ["architect"] }), runtime());
		expect(reason(arch.decision)).toContain("대신 storm-reviewer 를 쓰세요.");
	});

	test("a missing role borrows the first configured stand-in, skipping unconfigured ones", () => {
		// explorer → [quick, implementer]: quick is not configured, so implementer's models carry its effort.
		const out = decideSpawn(ev("storm-explorer"), withConfig(team), runtime());
		expect(models(out.decision)).toEqual(["openai/gpt-5.2:medium"]);
		expect(out.record).toMatchObject({ outcome: "substituted", role: "implementer", reason: "설정에 없는 역할 → implementer 역할 모델" });
		// A disabled stand-in is skipped too.
		const withQuick: StormConfig = { ...team, roles: { ...team.roles, quick: { agent: "storm-quick", models: ["google/flash"] } } };
		expect(models(decide(ev("storm-explorer"), withConfig(withQuick)))).toEqual(["google/flash"]);
		const quickOff = { ...team, disabledRoles: ["quick"] };
		expect(models(decide(ev("storm-explorer"), withConfig(quickOff)))).toEqual(["openai/gpt-5.2:medium"]);
	});

	test("stand-in routing never goes to the stand-in's trial", () => {
		const s = withConfig({ ...team, trials: [baseTrial] });
		const counters: TrialState = { id: baseTrial.id, seen: 0, routed: 0, costUsd: 0 };
		const out = decideSpawn(ev("storm-architect"), s, runtime({ trials: { [baseTrial.id]: counters } }));
		expect(out.record?.outcome).toBe("substituted");
		expect(out.record?.trialId).toBeUndefined();
		expect(models(out.decision)?.some(m => m.startsWith("zai/"))).toBe(false);
	});

	test("a missing role with no configured stand-in is blocked", () => {
		const only: StormConfig = { ...config, roles: { reviewer: config.roles.reviewer! } };
		expect(reason(decide(ev("storm-quick"), withConfig(only)))).toBe("Storm 설정에 storm-quick 역할이 없습니다.");
	});

	test("stand-in spawns still honor the budget gate", () => {
		const out = decideSpawn(ev("storm-explorer"), withConfig(team), inRun({ run: { runId: "r", costUsd: 3, budget: { perRunUsd: 2, onExceed: "block-spawns" } } }));
		expect(out.record?.outcome).toBe("blocked");
	});

	test("scout in a run gets explorer's models for an unapproved model; approved models pass", () => {
		const s = withConfig({ ...config, fallbackRole: "reviewer" });
		const out = decideSpawn(ev("scout", ["x/unknown"]), s, inRun());
		expect(models(out.decision)).toEqual(["google/gemini-flash"]);
		expect(out.record).toMatchObject({ outcome: "substituted", role: "explorer" });
		expect(decideSpawn(ev("scout", ["openai/gpt-5.2"]), s, inRun())).toMatchObject({
			decision: undefined,
			record: { outcome: "allowed" },
		});
	});

	test("a built-in mapped to an unconfigured role falls back to fallbackRole", () => {
		const out = decideSpawn(ev("task", ["x/unknown"]), withConfig({ ...config, fallbackRole: "explorer" }), inRun());
		expect(out.record).toMatchObject({ outcome: "substituted", role: "explorer" });
		const blocked = decideSpawn(ev("task", ["x/unknown"]), withConfig(config), inRun());
		expect(blocked.record?.outcome).toBe("blocked");
	});
});

describe("decideSpawn (v0.8 run plan and live caps)", () => {
	const run = (plan: RunPlan | undefined, active: { total: number; byRole: Record<string, number> } = { total: 0, byRole: {} }) =>
		runtime({ run: { runId: "run-1", costUsd: 0, ...(plan ? { plan } : {}), active } });
	const plan = (workers: Record<string, number>): RunPlan => ({ ...PLAN, workers });

	test("during a run every Storm-decided spawn waits for a plan; outside runs nothing changes", () => {
		const storm = decideSpawn(ev("storm-explorer"), state(), run(undefined));
		expect(reason(storm.decision)).toContain("storm 도구의 plan 동작");
		expect(storm.record).toMatchObject({ outcome: "blocked", role: "explorer" });
		expect(reason(decide(ev("task", ["openai/gpt-5.2"]), state(), run(undefined)))).toContain("plan 동작");
		expect(reason(decide(ev("task", ["evil/model"]), state(), run(undefined)))).toContain("plan 동작");
		// Outside a run: no plan, no caps.
		expect(models(decide(ev("storm-explorer"), state(), runtime()))).toEqual(["google/gemini-flash"]);
		expect(decideSpawn(ev("task", ["evil/model"]), state(), runtime())).toEqual({ decision: undefined });
	});

	test("a storm role the plan gives no workers is blocked with a resubmit hint", () => {
		const out = decideSpawn(ev("storm-reviewer"), state(), run(plan({ explorer: 2 })));
		expect(reason(out.decision)).toContain("reviewer 역할 레인이 없어");
		expect(reason(out.decision)).toContain("계획을 다시 내세요");
		expect(reason(decide(ev("storm-reviewer"), state(), run(plan({ reviewer: 0, explorer: 2 }))))).toContain("레인이 없어");
	});

	test("the role cap is the plan's workers for it; the reason names the cap, the count and the role max", () => {
		const full = decideSpawn(ev("storm-explorer"), state(), run(plan({ explorer: 2 }), { total: 2, byRole: { explorer: 2 } }));
		const why = reason(full.decision) ?? "";
		expect(why).toContain("storm-explorer 2개가 실행 중");
		expect(why).toContain("상한 2개");
		expect(why).toContain("재사용");
		expect(why).toContain("최대 4개");
		const roomy = { ...config, parallelism: 8 };
		expect(models(decide(ev("storm-explorer"), withConfig(roomy), run(plan({ explorer: 2 }), { total: 1, byRole: { explorer: 1 } })))).toEqual([
			"google/gemini-flash",
		]);
		// Other roles' agents do not use up this role's cap.
		expect(models(decide(ev("storm-explorer"), withConfig(roomy), run(plan({ explorer: 1 }), { total: 3, byRole: { reviewer: 3 } })))).toEqual([
			"google/gemini-flash",
		]);
		// The max comes from the role's configured range.
		const ranged = withConfig({ ...config, roles: { ...config.roles, explorer: { ...config.roles.explorer!, workers: { min: 1, max: 6 } } } });
		expect(reason(decide(ev("storm-explorer"), ranged, run(plan({ explorer: 1 }), { total: 1, byRole: { explorer: 1 } })))).toContain("최대 6개");
	});

	test("the team's parallelism caps all live agents, storm and other agents alike", () => {
		const busy = run(plan({ explorer: 4 }), { total: 2, byRole: { reviewer: 2 } });
		expect(reason(decide(ev("storm-explorer"), state(), busy))).toContain("팀 동시 상한 2개");
		expect(reason(decide(ev("task", ["openai/gpt-5.2"]), state(), busy))).toContain("팀 동시 상한 2개");
		expect(decideSpawn(ev("task", ["openai/gpt-5.2"]), state(), run(plan({}), { total: 1, byRole: {} })).record?.outcome).toBe("allowed");
	});

	test("a stand-in spawn counts against the role it asked for, not the borrowed one", () => {
		const team = withConfig({
			...config,
			parallelism: 8,
			roles: { implementer: { agent: "storm-implementer", models: ["openai/gpt-5.2"] }, reviewer: config.roles.reviewer! },
		});
		const p = plan({ explorer: 1, implementer: 1 });
		expect(reason(decide(ev("storm-explorer"), team, run(p, { total: 1, byRole: { explorer: 1 } })))).toContain("상한 1개");
		const out = decideSpawn(ev("storm-explorer"), team, run(p, { total: 1, byRole: { implementer: 1 } }));
		expect(out.record).toMatchObject({ outcome: "substituted", role: "implementer" });
		// A plan without the requested role blocks the stand-in even when the borrowed role has room.
		expect(reason(decide(ev("storm-explorer"), team, run(plan({ implementer: 2 }))))).toContain("explorer 역할 레인이 없어");
	});
});

describe("activeAgents", () => {
	const rec = (spawnKey: string | undefined, over: Partial<SpawnRecord> = {}): SpawnRecord => ({
		ts: new Date(NOW - 10_000).toISOString(),
		agent: "storm-explorer",
		invocationKind: "task",
		requested: [],
		outcome: "routed",
		role: "explorer",
		...(spawnKey === undefined ? {} : { spawnKey }),
		...over,
	});
	const agent = (id: string, state: AgentEntry["state"]): AgentEntry => ({
		id,
		name: "storm-explorer",
		state,
		startedAt: NOW - 60_000,
		lastActivityAt: NOW,
		contextTokens: 0,
		requests: 0,
		costUsd: 0,
		followUps: 0,
	});

	test("running and just-decided agents count; settled, stale, blocked and unkeyed ones do not", () => {
		const { role: _role, ...task } = rec("Task", { agent: "task", outcome: "allowed" });
		const spawns = [
			rec("Running"),
			rec("Idle"),
			rec("Parked", { role: "reviewer", agent: "storm-reviewer" }),
			rec("Pending", { role: "reviewer", agent: "storm-reviewer" }),
			rec("Stale", { ts: new Date(NOW - 3 * 60_000).toISOString() }),
			rec("Refused", { outcome: "blocked" }),
			rec(undefined),
			task,
		];
		const agents = [agent("Running", "running"), agent("Idle", "idle"), agent("Parked", "parked"), agent("Task", "running")];
		expect(activeAgents(spawns, agents, NOW)).toEqual({ total: 3, byRole: { explorer: 1, reviewer: 1 } });
	});

	test("a storm stand-in counts under the role it asked for", () => {
		const standIn = rec("Scout", { outcome: "substituted", role: "implementer" });
		const builtin = rec("Task", { agent: "task", outcome: "substituted", role: "implementer" });
		expect(activeAgents([standIn, builtin], [], NOW).byRole).toEqual({ explorer: 1, implementer: 1 });
	});
});

describe("followUpBlock", () => {
	const agent = (over: Partial<AgentEntry> = {}): AgentEntry => ({
		id: "Impl",
		name: "storm-implementer",
		role: "implementer",
		state: "idle",
		startedAt: 0,
		lastActivityAt: 0,
		contextTokens: 230_000,
		contextWindow: 1_000_000,
		requests: 40,
		costUsd: 3,
		followUps: 2,
		...over,
	});
	const write = (path: string) => ({ path, content: "다음 단계" });

	test("a follow-up to an agent at or past its cap is blocked with a fresh-agent instruction", () => {
		const why = followUpBlock("write", write("agent://Impl"), [agent()], config) ?? "";
		expect(why).toContain("Impl(implementer)");
		expect(why).toContain("230.0k 토큰(창의 23%)");
		expect(why).toContain("상한 200.0k 토큰");
		expect(why).toContain("새 storm-implementer");
		expect(why).toContain("agent://Impl 에서 계속 읽을 수 있습니다");
		expect(followUpBlock("write", write("agent://Impl"), [agent({ contextTokens: 200_000 })], config)).toBeDefined();
		// Sub-paths and queries address the same agent.
		expect(followUpBlock("write", write("agent://Impl/result?x=1"), [agent()], config)).toBeDefined();
	});

	test("under the cap, or with a role cap set higher, it passes", () => {
		expect(followUpBlock("write", write("agent://Impl"), [agent({ contextTokens: 199_999 })], config)).toBeUndefined();
		const roomy = { ...config, roles: { ...config.roles, implementer: { agent: "storm-implementer", models: ["a/i"], contextCap: 300_000 } } };
		expect(followUpBlock("write", write("agent://Impl"), [agent()], roomy)).toBeUndefined();
	});

	test("70% of the window beats a higher token cap", () => {
		const high = { ...config, contextCap: 500_000 };
		const why = followUpBlock("write", write("agent://Impl"), [agent({ contextTokens: 150_000, contextWindow: 200_000 })], high) ?? "";
		expect(why).toContain("상한 140.0k 토큰");
		expect(followUpBlock("write", write("agent://Impl"), [agent({ contextTokens: 139_999, contextWindow: 200_000 })], high)).toBeUndefined();
	});

	test("other tools, other paths and unknown agents pass", () => {
		expect(followUpBlock("read", write("agent://Impl"), [agent()], config)).toBeUndefined();
		expect(followUpBlock("write", write("local://notes.md"), [agent()], config)).toBeUndefined();
		expect(followUpBlock("write", write("src/agent://Impl"), [agent()], config)).toBeUndefined();
		expect(followUpBlock("write", write("agent://Other"), [agent()], config)).toBeUndefined();
		expect(followUpBlock("write", { content: "x" }, [agent()], config)).toBeUndefined();
		expect(followUpBlock("write", null, [agent()], config)).toBeUndefined();
	});
});
