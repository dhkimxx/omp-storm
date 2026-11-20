import { describe, expect, test } from "bun:test";
import { approvedSelectors, decideSpawn, orderByQuota, stripEffort, withEffort } from "../src/policy/spawn.ts";
import type {
	ApprovalRecord,
	ConfigLoad,
	QuotaMark,
	ShadowInfo,
	SpawnDecision,
	SpawnEvent,
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
const inRun = (over: Partial<SpawnRuntime> = {}): SpawnRuntime => runtime({ run: { runId: "run-1", costUsd: 0 }, ...over });
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
		const expected = "승인되지 않은 Storm 설정입니다(ab12ab12ab12). /storm review 로 승인하세요.";
		expect(reason(decide(ev("storm-reviewer"), state({ approval: undefined })))).toBe(expected);
		expect(reason(decide(ev("storm-reviewer"), state({ approval: approval({ status: "revoked" }) })))).toBe(expected);
		const other = approval({ configHash: `jcs-sha256:${"f".repeat(64)}` });
		expect(reason(decide(ev("storm-reviewer"), state({ approval: other })))).toBe(expected);
	});

	test("blocks a storm agent the config has no role for", () => {
		expect(reason(decide(ev("storm-implementer"), state()))).toBe("Storm 설정에 storm-implementer 역할이 없습니다.");
	});

	test("blocks unapproved shadow definitions of the spawned role only", () => {
		const blocked = "승인되지 않은 역할 정의가 있습니다: /r/.omp/agents/rev.md. /storm review 로 확인하세요.";
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
		expect(out.record?.reason).toBe("승인되지 않은 Storm 설정입니다(ab12ab12ab12). /storm review 로 승인하세요.");
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
		const under = inRun({ run: { runId: "run-1", costUsd: 4.99, budget } });
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
			"승인되지 않은 Storm 설정입니다(ab12ab12ab12). /storm review 로 승인하세요.",
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
