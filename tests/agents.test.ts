import { beforeEach, describe, expect, test } from "bun:test";
import {
	adviseAgents,
	agentProviders,
	cacheWindow,
	COMPACTION_SHARE,
	FRESH_MIN_TOKENS,
	lifecycleWarnings,
	REUSE_MARGIN_MS,
	renderAgents,
	teamProviders,
} from "../src/report/agents.ts";
import { listAgents, noteAgentEnd, noteAgentParked, noteAgentReview, noteAgentStart, noteAgentUsage, resetAgents } from "../src/runtime/agents.ts";
import type { AgentEntry, LifecycleSettings, ModelCost, StormConfig } from "../src/types.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;

describe("agent ledger", () => {
	beforeEach(resetAgents);

	test("start, usage, settle, follow-up by message and by revive", () => {
		noteAgentStart({ id: "A", name: "storm-implementer", parentId: "Main", role: "implementer", runId: "r1", now: T0, revive: false });
		noteAgentUsage({ id: "A", model: "anthropic/sonnet", promptTokens: 10_000, cacheReadTokens: 9_600, costUsd: 0.01, contextWindow: 200_000, now: T0 + 1_000 });
		noteAgentUsage({ id: "A", model: "anthropic/sonnet", promptTokens: 12_000, cacheReadTokens: 11_400, costUsd: 0.02, now: T0 + 2_000 });
		let [a] = listAgents();
		expect(a).toMatchObject({
			id: "A",
			name: "storm-implementer",
			parentId: "Main",
			role: "implementer",
			runId: "r1",
			model: "anthropic/sonnet",
			state: "running",
			startedAt: T0,
			lastActivityAt: T0 + 2_000,
			contextTokens: 12_000,
			contextWindow: 200_000,
			requests: 2,
			followUps: 0,
			lastCacheReadShare: 0.95,
		});
		expect(a!.costUsd).toBeCloseTo(0.03);

		// A turn that does not settle (more turns follow) keeps the agent running.
		noteAgentEnd({ id: "A", now: T0 + 3_000, settled: false });
		expect(listAgents()[0]!.state).toBe("running");
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 + 3_500, revive: false });
		expect(listAgents()[0]!.followUps).toBe(0);

		noteAgentEnd({ id: "A", now: T0 + 4_000, settled: true });
		[a] = listAgents();
		expect(a).toMatchObject({ state: "idle", lastActivityAt: T0 + 4_000 });

		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 + 60_000, revive: false });
		expect(listAgents()[0]).toMatchObject({ state: "running", followUps: 1, runId: "r1", role: "implementer" });
		noteAgentEnd({ id: "A", now: T0 + 70_000, settled: true });

		noteAgentParked("A");
		// Parking keeps the last activity: it dates the cache.
		expect(listAgents()[0]).toMatchObject({ state: "parked", lastActivityAt: T0 + 70_000 });
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 + 600_000, revive: true });
		expect(listAgents()[0]).toMatchObject({ state: "running", followUps: 2 });
	});

	test("unknown ids are ignored; a revive of an unseen agent counts one follow-up", () => {
		noteAgentUsage({ id: "X", model: "a/b", promptTokens: 1, cacheReadTokens: 0, costUsd: 0, now: T0 });
		noteAgentEnd({ id: "X", now: T0, settled: true });
		noteAgentParked("X");
		expect(listAgents()).toEqual([]);
		noteAgentStart({ id: "R", name: "task", now: T0, revive: true });
		expect(listAgents()[0]!.followUps).toBe(1);
	});

	test("listing returns copies", () => {
		noteAgentStart({ id: "A", name: "task", now: T0, revive: false });
		listAgents()[0]!.state = "parked";
		expect(listAgents()[0]!.state).toBe("running");
	});

	test("ancestor filter follows parent links at any depth; run filter matches the run", () => {
		noteAgentStart({ id: "C1", name: "task", parentId: "Main", runId: "r1", now: T0, revive: false });
		noteAgentStart({ id: "G1", name: "task", parentId: "C1", now: T0 + 1, revive: false });
		noteAgentStart({ id: "GG1", name: "task", parentId: "G1", now: T0 + 2, revive: false });
		noteAgentStart({ id: "O1", name: "task", parentId: "Other", runId: "r2", now: T0 + 3, revive: false });
		noteAgentStart({ id: "Loop1", name: "task", parentId: "Loop2", now: T0 + 4, revive: false });
		noteAgentStart({ id: "Loop2", name: "task", parentId: "Loop1", now: T0 + 5, revive: false });
		const ids = (f: Parameters<typeof listAgents>[0]) => listAgents(f).map((e) => e.id);
		expect(ids({ ancestorId: "Main" })).toEqual(["C1", "G1", "GG1"]);
		expect(ids({ ancestorId: "C1" })).toEqual(["G1", "GG1"]);
		expect(ids({ ancestorId: "Nobody" })).toEqual([]);
		expect(ids({ runId: "r1" })).toEqual(["C1"]);
		expect(ids({ runId: "r1", ancestorId: "Other" })).toEqual([]);
		expect(ids(undefined)).toHaveLength(6);
	});

	test("parked entries older than 24 h are dropped when a new agent arrives", () => {
		noteAgentStart({ id: "Old", name: "task", now: T0, revive: false });
		noteAgentEnd({ id: "Old", now: T0, settled: true });
		noteAgentParked("Old");
		noteAgentStart({ id: "IdleOld", name: "task", now: T0, revive: false });
		noteAgentEnd({ id: "IdleOld", now: T0, settled: true });
		noteAgentStart({ id: "Recent", name: "task", now: T0 + 20 * HOUR, revive: false });
		noteAgentEnd({ id: "Recent", now: T0 + 20 * HOUR, settled: true });
		noteAgentParked("Recent");
		noteAgentStart({ id: "New", name: "task", now: T0 + 25 * HOUR, revive: false });
		expect(listAgents().map((e) => e.id)).toEqual(["IdleOld", "Recent", "New"]);
	});
});

const AUTO: LifecycleSettings = { agentIdleTtlMs: 420_000, cacheRetention: "auto" };
const NOW = T0 + HOUR;
const SONNET: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function entry(over: Partial<AgentEntry> = {}): AgentEntry {
	return {
		id: "A",
		name: "storm-implementer",
		model: "anthropic/sonnet",
		state: "idle",
		startedAt: T0,
		lastActivityAt: NOW - MIN,
		contextTokens: 30_000,
		contextWindow: 200_000,
		requests: 3,
		costUsd: 0.05,
		followUps: 0,
		...over,
	};
}

function advise(e: AgentEntry, settings: LifecycleSettings = AUTO, cost?: (m: string) => ModelCost | undefined) {
	const input: Parameters<typeof adviseAgents>[1] = { now: NOW, settings };
	if (cost) input.cost = cost;
	return adviseAgents([e], input)[0]!;
}

describe("cacheWindow", () => {
	test("encodes provider retention and labels estimates", () => {
		expect(cacheWindow("anthropic", AUTO)).toEqual({
			ms: 5 * MIN,
			estimated: true,
			source: "Anthropic 기본: API 키 5분(추정, OAuth면 1시간일 수 있음)",
		});
		expect(cacheWindow("anthropic", { cacheRetention: "short" }).ms).toBe(5 * MIN);
		expect(cacheWindow("anthropic", { cacheRetention: "long" })).toMatchObject({ ms: HOUR, estimated: false });
		expect(cacheWindow("openai", AUTO)).toMatchObject({ ms: 30 * MIN, estimated: false });
		expect(cacheWindow("openai", { cacheRetention: "long" })).toMatchObject({ ms: 12 * HOUR, estimated: false });
		expect(cacheWindow("openai-codex", { cacheRetention: "long" })).toMatchObject({ ms: 5 * MIN, estimated: true });
		expect(cacheWindow("anthropic", { cacheRetention: "none" })).toMatchObject({ ms: 0, estimated: false });
		expect(cacheWindow("anthropic", {}).source).toContain("auto로 가정");
	});
});

describe("adviseAgents", () => {
	test("running agents are busy", () => {
		expect(advise(entry({ state: "running", lastActivityAt: T0 })).action).toBe("busy");
	});

	test("reuse within the cache window minus the margin, with the handle and time left", () => {
		const a = advise(entry({ lastActivityAt: NOW - 2 * MIN }));
		expect(a).toMatchObject({ id: "A", action: "reuse", handle: "agent://A" });
		expect(a.reason).toContain("캐시 약 3분 남음(추정)");
		expect(a.reason).toContain("30.0k 토큰(창의 15%)");
		// Parked agents revive with their history; a warm cache still pays off.
		expect(advise(entry({ state: "parked", lastActivityAt: NOW - 2 * MIN })).action).toBe("reuse");
		// Inside the margin the cache counts as gone.
		const edge = advise(entry({ lastActivityAt: NOW - (5 * MIN - REUSE_MARGIN_MS) }));
		expect(edge.action).toBe("fresh");
	});

	test("reuse needs the context at most 40% of the window; unknown windows do not block it", () => {
		expect(advise(entry({ contextTokens: 80_000 })).action).toBe("reuse");
		const big = advise(entry({ contextTokens: 80_001 }));
		expect(big.action).toBe("fresh");
		expect(big.handle).toBeUndefined();
		const { contextWindow: _, ...noWindow } = entry({ contextTokens: 150_000 });
		expect(advise(noWindow).action).toBe("reuse");
	});

	test("near the window it is always fresh: compaction is close", () => {
		const tokens = 200_000 * COMPACTION_SHARE + 1;
		const a = advise(entry({ contextTokens: tokens }));
		expect(a.action).toBe("fresh");
		expect(a.reason).toContain("압축(compaction)이 가깝습니다");
		expect(advise(entry({ contextTokens: tokens, state: "parked", lastActivityAt: T0 })).action).toBe("fresh");
	});

	test("expired cache with a big context: fresh, with the rewrite cost when prices are known", () => {
		const a = advise(entry({ lastActivityAt: NOW - 10 * MIN }), AUTO, () => SONNET);
		expect(a.action).toBe("fresh");
		expect(a.reason).toContain("30.0k 토큰을 캐시에 다시 씁니다(약 $0.1125)");
		expect(a.reason).toContain("요약");
		const unpriced = advise(entry({ lastActivityAt: NOW - 10 * MIN }), AUTO, () => undefined);
		expect(unpriced.action).toBe("fresh");
		expect(unpriced.reason).not.toContain("$");
		expect(advise(entry({ lastActivityAt: NOW - 10 * MIN, contextTokens: FRESH_MIN_TOKENS })).action).toBe("fresh");
	});

	test("expired cache with a small context, or parked and expired: cleanup", () => {
		const small = advise(entry({ lastActivityAt: NOW - 10 * MIN, contextTokens: FRESH_MIN_TOKENS - 1 }));
		expect(small.action).toBe("cleanup");
		expect(small.reason).toContain("잃을 것이 없습니다");
		const parked = advise(entry({ state: "parked", lastActivityAt: NOW - 10 * MIN, contextTokens: 100_000 }));
		expect(parked.action).toBe("cleanup");
		expect(parked.reason).toContain("보관됨");
	});

	test("the window follows the model's provider and retention", () => {
		const openai = entry({ model: "openai/gpt", lastActivityAt: NOW - 20 * MIN });
		expect(advise(openai).action).toBe("reuse");
		expect(advise(openai).reason).not.toContain("추정");
		expect(advise(entry({ lastActivityAt: NOW - 40 * MIN }), { cacheRetention: "long" }).action).toBe("reuse");
		// Unknown provider and model: 5-minute estimate.
		const { model: _, ...noModel } = entry({ lastActivityAt: NOW - 2 * MIN });
		expect(advise(noModel).reason).toContain("(추정)");
		const none = advise(entry({ lastActivityAt: NOW - 1_000 }), { agentIdleTtlMs: 420_000, cacheRetention: "none" }, () => SONNET);
		expect(none.action).toBe("fresh");
		expect(none.reason).toContain("캐시 꺼짐");
		expect(none.reason).toContain("다시 읽습니다(약 $0.0900)");
	});
});

describe("renderAgents", () => {
	test("table rows, idle time, context share and the reuse how-to", () => {
		const rows = [
			{ entry: entry({ id: "Imp", role: "implementer", followUps: 2 }), advice: { id: "Imp", action: "reuse" as const, reason: "a|b", handle: "agent://Imp" } },
			{ entry: entry({ id: "Run", name: "task", state: "running", lastActivityAt: NOW, contextTokens: 900 }), advice: { id: "Run", action: "busy" as const, reason: "작업 중" } },
		];
		const md = renderAgents(rows, NOW);
		const lines = md.split("\n");
		expect(lines[0]).toBe("| 에이전트 | 모델 | 상태 | 유휴 | 컨텍스트 | 후속 | 권장 | 이유 |");
		expect(lines[2]).toBe("| Imp (implementer) | anthropic/sonnet | 유휴 | 1분 | 30.0k (15%) | 2 | 재사용 | a\\|b |");
		expect(lines[3]).toBe("| Run (task) | anthropic/sonnet | 실행 중 | — | 900 (0%) | 0 | 작업 중 | 작업 중 |");
		expect(md).toContain("`write agent://<id>`");
		expect(md).toContain(".send()");
		expect(renderAgents([], NOW)).toContain("서브에이전트가 없습니다");
	});
});

describe("lifecycleWarnings", () => {
	test("idle TTL longer than the cache window: reuse in between rewrites the cache", () => {
		const ws = lifecycleWarnings(AUTO, ["anthropic", "anthropic"]);
		expect(ws).toEqual(["anthropic: 유휴 TTL 7분이 캐시 유지 5분(추정)보다 깁니다. 그 사이에 재사용하면 컨텍스트 전체를 캐시에 다시 씁니다."]);
	});

	test("a much longer cache window suggests raising the omp TTL, which Storm never changes", () => {
		const ws = lifecycleWarnings({ agentIdleTtlMs: 420_000, cacheRetention: "long" }, ["anthropic"]);
		expect(ws).toHaveLength(1);
		expect(ws[0]).toContain("캐시 유지 1시간이 유휴 TTL 7분보다 훨씬 깁니다");
		expect(ws[0]).toContain("task.agentIdleTtlMs");
		expect(ws[0]).toContain("Storm 은 omp 설정을 바꾸지 않습니다");
		// Matching windows say nothing.
		expect(lifecycleWarnings({ agentIdleTtlMs: HOUR, cacheRetention: "long" }, ["anthropic"])).toEqual([]);
		expect(lifecycleWarnings({ agentIdleTtlMs: 30 * MIN, cacheRetention: "auto" }, ["openai"])).toEqual([]);
	});

	test("TTL 0 never parks, so it outlives every cache", () => {
		expect(lifecycleWarnings({ agentIdleTtlMs: 0, cacheRetention: "long" }, ["openai"])[0]).toContain("무제한");
	});

	test("retention none and unreadable settings", () => {
		const none = lifecycleWarnings({ agentIdleTtlMs: 420_000, cacheRetention: "none" }, ["anthropic"]);
		expect(none).toHaveLength(1);
		expect(none[0]).toContain("캐시 절감은 없습니다");
		const unread = lifecycleWarnings({}, ["anthropic"]);
		expect(unread[0]).toBe("omp 설정을 읽지 못해 기본값(task.agentIdleTtlMs 7분, providers.cacheRetention auto)으로 가정합니다.");
		expect(unread[1]).toContain("anthropic: 유휴 TTL 7분");
		expect(lifecycleWarnings({ cacheRetention: "auto" }, [])).toEqual([
			"omp 설정을 읽지 못해 기본값(task.agentIdleTtlMs 7분)으로 가정합니다.",
		]);
	});

	test("providers of the team and of the agents", () => {
		const config = {
			roles: {
				explorer: { agent: "storm-explorer", models: ["openai/a:low", "anthropic/b"] },
				reviewer: { agent: "storm-reviewer", models: ["openai/c"] },
			},
		} as unknown as StormConfig;
		expect(teamProviders(config)).toEqual(["openai", "anthropic"]);
		const { model: _, ...noModel } = entry();
		expect(agentProviders([entry(), entry({ model: "openai/x" }), noModel])).toEqual(["anthropic", "openai"]);
	});
});

describe("noteAgentReview", () => {
	beforeEach(() => resetAgents());

	test("accumulates a reviewer's yields on its own entry and ignores non-review yields", () => {
		noteAgentStart({ id: "Rev", name: "storm-reviewer", now: 0, revive: false });
		noteAgentStart({ id: "Impl", name: "storm-implementer", now: 0, revive: false });
		noteAgentReview("Impl", { data: { done: true } });
		noteAgentReview("Rev", { type: ["findings"], data: { priority: 0 } });
		noteAgentReview("Rev", { error: "x" });
		noteAgentReview("Rev", { data: { overall_correctness: "incorrect" } });
		noteAgentReview("Ghost", { data: { overall_correctness: "correct" } });
		const [rev, impl] = listAgents();
		expect(rev?.review).toEqual({ verdict: "incorrect", findings: [1, 0, 0, 0] });
		expect(impl?.review).toBeUndefined();
		expect(listAgents()).toHaveLength(2);
	});
});
