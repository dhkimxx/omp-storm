import { describe, expect, test } from "bun:test";
import { analyze, type AnalyzeInput } from "../src/analysis/analyze.ts";
import { pickEffort, recommend, type RecommendInput } from "../src/recommend/recommend.ts";
import { ROLES } from "../src/roles.ts";
import type { Lineage, LineageFn, ModelInfo, PriceTierInfo, Priority, QuotaStatus, RoleRecommendation, Tier, UsageRow, UsageSnapshot } from "../src/types.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 20, 12).getTime();

// Fake lineage: wire ids look like "<cls>-<tier>-<rev>".
const lineage: LineageFn = (_provider, wireId) => {
	const [cls = "x", tier = "-", rev] = wireId.split("-");
	const lin: Lineage = {
		modelKey: `${cls}/${tier}@${rev ?? "?"}`,
		lineKey: `${cls}/${tier}`,
		cls,
		tier,
		revision: rev ?? null,
		revisionSource: rev ? "identity" : null,
		classSource: "identity",
		suspect: false,
		variant: {},
	};
	return lin;
};

const COST: Record<Tier, ModelInfo["cost"]> = {
	cheap: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
	general: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
	premium: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 },
};

function model(provider: string, id: string, tier: Tier, opts: Partial<ModelInfo> = {}): ModelInfo {
	return {
		provider,
		id,
		selector: `${provider}/${id}`,
		name: id,
		identity: { class: id.split("-")[0] ?? "x" },
		cost: COST[tier],
		pricingKnown: true,
		contextWindow: 200_000,
		maxTokens: 32_000,
		reasoning: true,
		efforts: ["low", "medium", "high"],
		supportsTools: true,
		int: null,
		tps: null,
		available: true,
		...opts,
	};
}

function row(provider: string, id: string, requests: number, errors = 0, daysAgo = 1): UsageRow {
	const d = new Date(NOW - daysAgo * DAY);
	const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return {
		provider,
		model: id,
		seat: "subagent",
		requests,
		errors,
		aborted: 0,
		inputTokens: 4000 * requests,
		outputTokens: 1000 * requests,
		cacheReadTokens: 50_000 * requests,
		cacheWriteTokens: 1000 * requests,
		costTotal: requests * 0.01,
		unpricedRequests: 0,
		ompTps: null,
		decodeTps: null,
		ttftP50: null,
		ttftP90: null,
		ttftSamples: 0,
		durationP50: null,
		durationP90: null,
		durationSamples: 0,
		firstTs: NOW - Math.max(20, daysAgo) * DAY,
		lastTs: NOW - daysAgo * DAY,
		daily: { [day]: requests },
		dailyErrors: {},
	};
}

const fillInt: AnalyzeInput["fillInt"] = route =>
	route.int === null
		? { value: null, source: "none", confidence: "low", missingReason: "catalog_no_score" }
		: { value: route.int, source: "catalog", confidence: "high" };
const fillTps: AnalyzeInput["fillTps"] = route =>
	route.tps === null
		? { value: null, source: "none", confidence: "low", missingReason: "unmeasured" }
		: { value: route.tps, source: "catalog", confidence: "medium" };

function setup(catalog: ModelInfo[], opts: { rows?: UsageRow[]; quota?: QuotaStatus[]; priority?: Priority } = {}): RecommendInput {
	const tiers = new Map<string, PriceTierInfo>();
	for (const m of catalog) {
		const usd = (m.cost.input * 4000 + m.cost.output * 1000 + m.cost.cacheRead * 160_000 + m.cost.cacheWrite * 1000) / 1e6;
		const tier: Tier = usd < 0.01 ? "cheap" : usd < 0.06 ? "general" : "premium";
		tiers.set(lineage(m.provider, m.id, m.identity).modelKey, { tier, referenceUsd: usd, estimated: false, basis: m.selector });
	}
	const usage: UsageSnapshot = { status: "ok", dbPath: "/tmp/x.db", windowDays: 30, now: NOW, dataAsOf: NOW, rows: opts.rows ?? [] };
	const quota = opts.quota ?? [];
	const label: AnalyzeInput["label"] = (m, lin) => m?.name ?? lin.modelKey;
	const analysis = analyze({ usage, catalog, quota, lineage, tiers, fillInt, fillTps, label, now: NOW });
	return { analysis, catalog, quota, usage, lineage, tiers, fillInt, fillTps, label, priority: opts.priority ?? "balanced", roles: ROLES };
}

const pick = (recs: RoleRecommendation[], id: string): string | undefined => {
	const r = recs.find(x => x.role.id === id);
	return r?.candidates[r.chosenIndex]?.selector;
};

describe("recommend constraints", () => {
	test("drops models that cannot run the role and says why", () => {
		const catalog = [
			model("pa", "ok-flash-1", "cheap", { int: 30 }),
			model("pa", "notool-flash-1", "cheap", { int: 60, supportsTools: false }),
			model("pa", "small-flash-1", "cheap", { int: 60, contextWindow: 32_000 }),
			model("pq", "dry-flash-1", "cheap", { int: 60 }),
			model("pz", "gone-flash-1", "cheap", { int: 60, available: false }),
		];
		const quota: QuotaStatus[] = [{ provider: "pq", state: "exhausted", usedFraction: 1, resetsAt: null, observedAt: NOW }];
		const input = setup(catalog, { quota, rows: [row("pz", "gone-flash-1", 50)] });
		const explorer = recommend(input).find(r => r.role.id === "explorer");
		expect(explorer?.candidates.map(c => c.selector)).toEqual(["pa/ok-flash-1"]);
		const reasons = Object.fromEntries(explorer?.excluded.map(e => [e.selector, e.reason]) ?? []);
		expect(reasons["pa/notool-flash-1"]).toBe("도구 호출 미지원");
		expect(reasons["pa/small-flash-1"]).toContain("컨텍스트");
		expect(reasons["pq/dry-flash-1"]).toBe("쿼터 소진");
		expect(reasons["pz/gone-flash-1"]).toBeUndefined();
	});

	test("an unknown context window passes with lower confidence", () => {
		const recs = recommend(setup([model("pa", "a-flash-1", "cheap", { int: 30, contextWindow: null })]));
		const c = recs.find(r => r.role.id === "explorer")?.candidates[0];
		expect(c?.selector).toBe("pa/a-flash-1");
		expect(c?.confidence).not.toBe("high");
	});

	test("nothing usable gives an empty list and chosenIndex -1", () => {
		const recs = recommend(setup([model("pa", "a-flash-1", "cheap", { supportsTools: false })]));
		for (const r of recs) {
			expect(r.candidates).toEqual([]);
			expect(r.chosenIndex).toBe(-1);
		}
	});

	test("keeps only the best route of one lineage", () => {
		const catalog = [model("pa", "a-pro-1", "general", { int: 40 }), model("pb", "a-pro-1", "general", { int: 40, cost: { ...COST.general, output: 8 } })];
		const impl = recommend(setup(catalog, { rows: [row("pa", "a-pro-1", 10)] })).find(r => r.role.id === "implementer");
		expect(impl?.candidates.map(c => c.selector)).toEqual(["pa/a-pro-1"]);
		expect(impl?.excluded).toContainEqual({ selector: "pb/a-pro-1", reason: "같은 계열의 다른 경로" });
	});
});

describe("recommend priority", () => {
	const catalog = [
		model("pa", "c-flash-1", "cheap", { int: 30 }),
		model("pa", "g-pro-1", "general", { int: 40 }),
		model("pa", "p-max-1", "premium", { int: 50 }),
	];
	test("balanced uses each role's tier; quality and cost shift one step", () => {
		const balanced = recommend(setup(catalog));
		expect(pick(balanced, "explorer")).toBe("pa/c-flash-1");
		expect(pick(balanced, "implementer")).toBe("pa/g-pro-1");
		const quality = recommend(setup(catalog, { priority: "quality" }));
		expect(pick(quality, "explorer")).toBe("pa/g-pro-1");
		expect(pick(quality, "implementer")).toBe("pa/p-max-1");
		const cost = recommend(setup(catalog, { priority: "cost" }));
		expect(pick(cost, "explorer")).toBe("pa/c-flash-1");
		expect(pick(cost, "implementer")).toBe("pa/c-flash-1");
	});

	test("falls back to the nearest tier and puts unpriced models last", () => {
		// Implementer targets general; only premium and an unpriced (tier null) model exist.
		const input = setup([model("pa", "free-x-1", "cheap", { int: 90 }), model("pa", "p-max-1", "premium", { int: 50 })]);
		input.tiers.set("free/x@1", { tier: null, referenceUsd: null, estimated: false, basis: null });
		const impl = recommend(input).find(r => r.role.id === "implementer");
		expect(impl?.candidates.map(c => c.selector)).toEqual(["pa/p-max-1", "pa/free-x-1"]);
		expect(impl?.candidates[1]?.whyNot).toEqual(["가격 미상"]);
	});

	test("speed priority breaks quality ties by speed", () => {
		const recs = recommend(
			setup([model("pa", "slow-pro-1", "general", { int: 40, tps: 50 }), model("pa", "fast-pro-1", "general", { int: 40, tps: 200 })], {
				priority: "speed",
			}),
		);
		expect(pick(recs, "implementer")).toBe("pa/fast-pro-1");
	});
});

describe("recommend user validation and diversity", () => {
	test("a lineage the user ran heavily with few errors outranks a higher catalog score", () => {
		const catalog = [model("pa", "scored-pro-1", "general", { int: 45 }), model("pa", "used-pro-1", "general")];
		const recs = recommend(setup(catalog, { rows: [row("pa", "used-pro-1", 4870, 34)] }));
		const impl = recs.find(r => r.role.id === "implementer");
		expect(impl?.candidates[0]?.selector).toBe("pa/used-pro-1");
		expect(impl?.candidates[0]?.validated).toBe(true);
		expect(impl?.candidates[0]?.why[0]).toBe("최근 30일 subagent에서 4,870건, 오류 0.7%");
		expect(impl?.candidates[1]?.whyNot).toEqual(["사용자 검증 이력 없음"]);
	});

	test("a high error rate does not count as validated", () => {
		const catalog = [model("pa", "scored-pro-1", "general", { int: 45 }), model("pa", "used-pro-1", "general")];
		const recs = recommend(setup(catalog, { rows: [row("pa", "used-pro-1", 100, 10)] }));
		expect(pick(recs, "implementer")).toBe("pa/scored-pro-1");
	});

	test("near-equal scores tie and the user's recent preference decides", () => {
		const catalog = [model("pa", "old-pro-1", "general", { int: 54.6 }), model("pb", "new-pro-1", "general", { int: 54.5 })];
		const rows = [row("pa", "old-pro-1", 400, 0, 20), row("pb", "new-pro-1", 400, 0, 1)];
		const impl = recommend(setup(catalog, { rows })).find(r => r.role.id === "implementer");
		expect(impl?.candidates[0]?.selector).toBe("pb/new-pro-1");
		expect(impl?.candidates[0]?.why).toContain("지능 점수가 비슷한 후보 중 최근 subagent로 가장 많이 쓴 모델");
		expect(impl?.candidates[1]?.whyNot[0]).toStartWith("최근 subagent 사용 비중이 더 낮다");
	});

	test("a clear score gap still beats the recent preference", () => {
		const catalog = [model("pa", "old-pro-1", "general", { int: 57 }), model("pb", "new-pro-1", "general", { int: 54.5 })];
		const rows = [row("pa", "old-pro-1", 400, 0, 20), row("pb", "new-pro-1", 400, 0, 1)];
		expect(pick(recommend(setup(catalog, { rows })), "implementer")).toBe("pa/old-pro-1");
	});

	test("reviewer prefers a different model class than the implementer", () => {
		const catalog = [model("pa", "alpha-pro-1", "general", { int: 50 }), model("pa", "alpha-pro-2", "general", { int: 48 }), model("pb", "beta-pro-1", "general", { int: 40 })];
		const recs = recommend(setup(catalog));
		expect(pick(recs, "implementer")).toBe("pa/alpha-pro-1");
		expect(pick(recs, "reviewer")).toBe("pb/beta-pro-1");
	});
});

describe("recommend effort", () => {
	test("uses the role effort, else the nearest supported one", () => {
		const catalog = [model("pa", "g-pro-1", "general", { int: 40, efforts: ["minimal", "medium", "xhigh"] }), model("pa", "c-flash-1", "cheap", { int: 20, efforts: [] })];
		const recs = recommend(setup(catalog));
		expect(recs.find(r => r.role.id === "implementer")?.candidates[0]?.effort).toBe("medium");
		expect(recs.find(r => r.role.id === "reviewer")?.candidates[0]?.effort).toBe("xhigh");
		expect(recs.find(r => r.role.id === "explorer")?.candidates[0]?.effort).toBeNull();
		expect(pickEffort("low", ["minimal", "medium"])).toBe("medium");
		expect(pickEffort("high", ["low"])).toBe("low");
	});
});

describe("recommend user mix", () => {
	test("userMixUsd follows the user's subagent token mix and is null without history", () => {
		const catalog = [model("pa", "g-pro-1", "general", { int: 40 })];
		const none = recommend(setup(catalog)).find(r => r.role.id === "implementer");
		expect(none?.candidates[0]?.userMixUsd).toBeNull();
		const used = recommend(setup(catalog, { rows: [row("pa", "g-pro-1", 10)] })).find(r => r.role.id === "implementer");
		// 4000×1 + 1000×4 + 50000×0.1 + 1000×1 per 1M tokens.
		expect(used?.candidates[0]?.userMixUsd).toBeCloseTo(0.014);
	});
});
