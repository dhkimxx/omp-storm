import { describe, expect, test } from "bun:test";
import { analyze, type AnalyzeInput } from "../src/analysis/analyze.ts";
import type { Lineage, LineageFn, MetricValue, ModelInfo, PriceTierInfo, QuotaStatus, Tier, UsageRow, UsageSnapshot } from "../src/types.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 20, 12).getTime();

// Fake lineage: wire ids look like "<cls>-<tier>-<rev>[-<route>]".
const lineage: LineageFn = (_provider, wireId, identity) => {
	const [cls = "x", tier = "-", rev, route] = wireId.split("-");
	const revision = rev ?? null;
	const lin: Lineage = {
		modelKey: `${cls}/${tier}@${revision ?? "?"}`,
		lineKey: `${cls}/${tier}`,
		cls,
		tier,
		revision,
		revisionSource: revision === null ? null : identity?.revision ? "identity" : "name",
		classSource: "identity",
		suspect: false,
		variant: route ? { route } : {},
	};
	return lin;
};

function model(provider: string, id: string, opts: Partial<ModelInfo> = {}): ModelInfo {
	const [, , rev] = id.split("-");
	return {
		provider,
		id,
		selector: `${provider}/${id}`,
		name: id,
		identity: rev ? { class: id.split("-")[0] ?? "x", revision: rev } : { class: "x" },
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
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

function row(provider: string, id: string, opts: Partial<UsageRow> = {}): UsageRow {
	const requests = opts.requests ?? 100;
	const lastTs = opts.lastTs ?? NOW - DAY;
	const d = new Date(lastTs);
	const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return {
		provider,
		model: id,
		seat: "subagent",
		requests,
		errors: 0,
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
		firstTs: lastTs - 20 * DAY,
		lastTs,
		daily: { [day]: requests },
		dailyErrors: {},
		...opts,
	};
}

const intOf: AnalyzeInput["fillInt"] = (route, siblings) => {
	const v = route.int ?? siblings.find(s => s.int !== null)?.int ?? null;
	return v === null
		? { value: null, source: "none", confidence: "low", missingReason: "catalog_no_score" }
		: { value: v, source: "catalog", confidence: "high" };
};
const tpsOf: AnalyzeInput["fillTps"] = route =>
	route.tps === null
		? { value: null, source: "none", confidence: "low", missingReason: "unmeasured" }
		: ({ value: route.tps, source: "catalog", confidence: "medium" } satisfies MetricValue);

function tiersFor(catalog: ModelInfo[]): Map<string, PriceTierInfo> {
	const tiers = new Map<string, PriceTierInfo>();
	for (const m of catalog) {
		const key = lineage(m.provider, m.id, m.identity).modelKey;
		const usd = (m.cost.input * 4000 + m.cost.output * 1000 + m.cost.cacheRead * 160_000 + m.cost.cacheWrite * 1000) / 1e6;
		const tier: Tier = usd < 0.01 ? "cheap" : usd < 0.06 ? "general" : "premium";
		const prev = tiers.get(key);
		if (!prev || (prev.referenceUsd ?? Infinity) > usd) tiers.set(key, { tier, referenceUsd: usd, estimated: false, basis: m.selector });
	}
	return tiers;
}

function input(catalog: ModelInfo[], rows: UsageRow[], quota: QuotaStatus[] = []): AnalyzeInput {
	const usage: UsageSnapshot = { status: "ok", dbPath: "/tmp/x.db", windowDays: 30, now: NOW, dataAsOf: NOW - 3600_000, rows };
	return {
		usage,
		catalog,
		quota,
		lineage,
		tiers: tiersFor(catalog),
		fillInt: intOf,
		fillTps: tpsOf,
		label: (m, lin) => m?.name ?? lin.modelKey,
		now: NOW,
	};
}

const CHEAP = { cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 } };
const PREMIUM = { cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 } };

describe("analyze preferences", () => {
	test("merges one lineage used through several providers", () => {
		const catalog = [model("pa", "deep-flash-4.1", CHEAP), model("pb", "deep-flash-4.1", CHEAP), model("pc", "deep-flash-4.1-fast", CHEAP)];
		const rows = [row("pa", "deep-flash-4.1", { requests: 60 }), row("pb", "deep-flash-4.1", { requests: 30 }), row("pc", "deep-flash-4.1-fast", { requests: 10 })];
		const a = analyze(input(catalog, rows));
		const cheap = a.preferences.subagent.cheap;
		expect(cheap).toHaveLength(1);
		expect(cheap[0]?.requests).toBe(100);
		expect(cheap[0]?.share).toBe(1);
		expect(cheap[0]?.routes.map(r => r.selector)).toEqual(["pa/deep-flash-4.1", "pb/deep-flash-4.1", "pc/deep-flash-4.1-fast"]);
	});

	test("cheap-tier preference is listed on its own instead of buried under premium volume", () => {
		const catalog = [model("pa", "big-opus-5", PREMIUM), model("pb", "deep-flash-4.1", CHEAP)];
		const rows = [row("pa", "big-opus-5", { requests: 1000 }), row("pb", "deep-flash-4.1", { requests: 200 })];
		const a = analyze(input(catalog, rows));
		expect(a.preferences.subagent.cheap.map(l => l.modelKey)).toEqual(["deep/flash@4.1"]);
		expect(a.preferences.subagent.cheap[0]?.share).toBeCloseTo(200 / 1200);
		expect(a.preferences.subagent.premium.map(l => l.modelKey)).toEqual(["big/opus@5"]);
	});

	test("recent share decays old usage", () => {
		const catalog = [model("pa", "old-mini-1", CHEAP), model("pa", "new-mini-1", CHEAP)];
		const rows = [row("pa", "old-mini-1", { requests: 100, lastTs: NOW - 21 * DAY }), row("pa", "new-mini-1", { requests: 100, lastTs: NOW - DAY })];
		const a = analyze(input(catalog, rows));
		const byKey = Object.fromEntries(a.preferences.subagent.cheap.map(l => [l.modelKey, l]));
		expect(byKey["old/mini@1"]?.share).toBeCloseTo(0.5);
		expect(byKey["new/mini@1"]?.shareRecent ?? 0).toBeGreaterThan(0.8);
	});
});

describe("analyze stopped lineages", () => {
	test("reports unavailable routes and the route usable now", () => {
		const catalog = [
			model("pa", "deep-flash-4.1", { ...CHEAP, available: false }),
			model("pb", "deep-flash-4.1", { ...CHEAP, available: false }),
			model("pc", "deep-flash-4.1", CHEAP),
			model("pd", "big-opus-5", PREMIUM),
		];
		const rows = [
			row("pa", "deep-flash-4.1", { requests: 300, lastTs: NOW - 9 * DAY }),
			row("pb", "deep-flash-4.1", { requests: 100, lastTs: NOW - 12 * DAY }),
			row("pd", "big-opus-5", { requests: 1000 }),
		];
		const quota: QuotaStatus[] = [{ provider: "pb", state: "exhausted", usedFraction: 1, resetsAt: null, observedAt: NOW }];
		const a = analyze(input(catalog, rows, quota));
		expect(a.stopped).toHaveLength(1);
		const s = a.stopped[0];
		expect(s?.modelKey).toBe("deep/flash@4.1");
		expect(s?.reasons).toEqual(["route-unavailable:pa/deep-flash-4.1", "route-unavailable:pb/deep-flash-4.1", "quota-exhausted:pb"]);
		expect(s?.currentRoutes).toEqual(["pc/deep-flash-4.1"]);
	});

	test("small or recently used lineages are not reported as stopped", () => {
		const catalog = [model("pa", "tiny-mini-1", CHEAP), model("pa", "big-opus-5", PREMIUM)];
		const rows = [row("pa", "tiny-mini-1", { requests: 20, lastTs: NOW - 10 * DAY }), row("pa", "big-opus-5", { requests: 1000, lastTs: NOW - 3 * DAY })];
		expect(analyze(input(catalog, rows)).stopped).toEqual([]);
	});

	test("idle time counts from the end of the data, so a late stats sync stops nothing", () => {
		const catalog = [model("pa", "big-opus-5", PREMIUM)];
		const late = input(catalog, [row("pa", "big-opus-5", { requests: 1000, lastTs: NOW - 6 * DAY })]);
		late.usage = { ...late.usage, dataAsOf: NOW - 5 * DAY };
		expect(analyze(late).stopped).toEqual([]);
	});
});

describe("analyze newer versions", () => {
	test("finds higher revisions numerically and flags name-only or preview-only ones", () => {
		const catalog = [
			model("pa", "gem-pro-1.2"),
			model("pa", "gem-pro-1.3"),
			model("pa", "gem-pro-1.10-preview"),
			model("pa", "gem-pro-1.1"),
			// Revision only from the name: no identity revision.
			{ ...model("pb", "gem-pro-1.5"), identity: { class: "gem" } },
			model("pa", "gem-pro-2.0", { available: false }),
		];
		const a = analyze(input(catalog, [row("pa", "gem-pro-1.2")]));
		const byTo = Object.fromEntries(a.newer.map(n => [n.to, n]));
		expect(a.newer.map(n => n.to)).toEqual(["gem/pro@1.10", "gem/pro@1.5", "gem/pro@1.3"]);
		expect(byTo["gem/pro@1.3"]?.needsCheck).toBe(false);
		expect(byTo["gem/pro@1.3"]?.selectors).toEqual(["pa/gem-pro-1.3"]);
		expect(byTo["gem/pro@1.10"]?.needsCheck).toBe(true);
		expect(byTo["gem/pro@1.5"]?.needsCheck).toBe(true);
	});
});

describe("analyze alternatives", () => {
	test("a 19x pricier smarter model is an upgrade, not better", () => {
		const base = model("pa", "deep-flash-4.1", { ...CHEAP, int: 30 });
		const pricey = model("pb", "big-opus-5", { cost: { input: 1.9, output: 7.6, cacheRead: 0.19, cacheWrite: 1.9 }, int: 50 });
		const smart = model("pc", "fox-flash-2", { ...CHEAP, int: 36 });
		const a = analyze(input([base, pricey, smart], [row("pa", "deep-flash-4.1")]));
		const alts = a.alternatives["deep/flash@4.1"] ?? [];
		expect(alts.find(x => x.selector === "pb/big-opus-5")?.kind).toBe("upgrade");
		expect(alts.find(x => x.selector === "pb/big-opus-5")?.costRatio).toBeCloseTo(19);
		expect(alts.find(x => x.selector === "pc/fox-flash-2")?.kind).toBe("better");
	});

	test("cost ratio uses the base lineage's own token mix", () => {
		// Output-heavy mix: a model with cheap input but pricey output must not look cheaper.
		const base = model("pa", "deep-flash-4.1", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, int: 30 });
		const cand = model("pb", "eel-flash-1", { cost: { input: 0.1, output: 1.2, cacheRead: 0, cacheWrite: 0 }, int: 30 });
		const rows = [row("pa", "deep-flash-4.1", { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 })];
		const alts = analyze(input([base, cand], rows)).alternatives["deep/flash@4.1"] ?? [];
		expect(alts.find(x => x.selector === "pb/eel-flash-1")).toBeUndefined();
	});

	test("models without an intelligence score are not compared", () => {
		const base = model("pa", "deep-flash-4.1", { ...CHEAP, int: null });
		const cheaper = model("pb", "eel-flash-1", { cost: { input: 0.01, output: 0.04, cacheRead: 0.001, cacheWrite: 0.01 }, int: 40 });
		const a1 = analyze(input([base, cheaper], [row("pa", "deep-flash-4.1")]));
		expect(a1.alternatives["deep/flash@4.1"]).toBeUndefined();

		const scored = model("pa", "deep-flash-4.1", { ...CHEAP, int: 30 });
		const unscored = model("pb", "eel-flash-1", { cost: { input: 0.01, output: 0.04, cacheRead: 0.001, cacheWrite: 0.01 }, int: null });
		const a2 = analyze(input([scored, unscored], [row("pa", "deep-flash-4.1")]));
		expect(a2.alternatives["deep/flash@4.1"]).toBeUndefined();
	});

	test("a heavily used low-error lineage without a score is offered as validated", () => {
		const base = model("pa", "deep-flash-4.1", { ...CHEAP, int: 30 });
		const used = model("pb", "eel-flash-1", { ...CHEAP, int: null });
		const rows = [row("pa", "deep-flash-4.1", { requests: 500 }), row("pb", "eel-flash-1", { requests: 40, errors: 0 })];
		const alts = analyze(input([base, used], rows)).alternatives["deep/flash@4.1"] ?? [];
		expect(alts.map(x => [x.selector, x.kind])).toEqual([["pb/eel-flash-1", "validated"]]);
	});
});

describe("analyze warnings", () => {
	test("stale data and unreadable history are reported", () => {
		const stale = input([], []);
		stale.usage = { ...stale.usage, dataAsOf: NOW - 8 * 3600_000 };
		expect(analyze(stale).warnings).toEqual(["사용 이력이 8시간 전 기준이다."]);
		const missing = input([], []);
		missing.usage = { ...missing.usage, status: "missing-db", dataAsOf: null };
		expect(analyze(missing).warnings).toHaveLength(1);
	});
});
