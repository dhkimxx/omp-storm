/** A small catalog, usage rows and a ready RecommendInput for tests of the ranking and of what renders it. */
import { analyze } from "../src/analysis/analyze.ts";
import { fillInt } from "../src/lineage/metrics.ts";
import { loadPriors } from "../src/lineage/priors.ts";
import type { RecommendInput } from "../src/recommend/recommend.ts";
import { ROLES } from "../src/roles.ts";
import type { Lineage, LineageFn, ModelInfo, PriceTierInfo, Priority, QuotaStatus, Seat, Tier, UsageRow, UsageSnapshot } from "../src/types.ts";

const DAY = 86_400_000;
export const NOW = new Date(2026, 10, 20, 12).getTime();
const { priors } = loadPriors({ now: NOW });

// Fake lineage: wire ids look like "<cls>-<tier>-<rev>".
export const lineage: LineageFn = (_provider, wireId) => {
	const [cls = "x", tier = "-", rev] = wireId.split("-");
	const lin: Lineage = {
		modelKey: `${cls}/${tier}@${rev ?? "?"}`,
		lineKey: `${cls}/${tier}`,
		cls,
		tier,
		revision: rev ?? null,
		revisionSource: rev ? "identity" : null,
		suspect: false,
		variant: {},
	};
	return lin;
};

export const COST: Record<Tier, ModelInfo["cost"]> = {
	cheap: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
	general: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
	premium: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 },
};

export function model(provider: string, id: string, tier: Tier, opts: Partial<ModelInfo> = {}): ModelInfo {
	return {
		provider,
		id,
		selector: `${provider}/${id}`,
		name: id,
		identity: { class: id.split("-")[0] ?? "x" },
		cost: COST[tier],
		pricingKnown: true,
		contextWindow: 200_000,
		efforts: ["low", "medium", "high"],
		supportsTools: true,
		int: null,
		tps: null,
		available: true,
		...opts,
	};
}

export function row(provider: string, id: string, requests: number, errors = 0, daysAgo = 1, seat: Seat = "subagent"): UsageRow {
	const d = new Date(NOW - daysAgo * DAY);
	const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return {
		provider,
		model: id,
		seat,
		requests,
		errors,
		inputTokens: 4000 * requests,
		outputTokens: 1000 * requests,
		cacheReadTokens: 50_000 * requests,
		cacheWriteTokens: 1000 * requests,
		costTotal: requests * 0.01,
		unpricedRequests: 0,
		ompTps: null,
		decodeTps: null,
		decodeSamples: 0,
		ttftP50: null,
		daily: { [day]: requests },
	};
}

export interface SetupOptions {
	rows?: UsageRow[];
	quota?: QuotaStatus[];
	priority?: Priority;
	current?: Record<string, string>;
}

export function setup(catalog: ModelInfo[], opts: SetupOptions = {}): RecommendInput {
	const tiers = new Map<string, PriceTierInfo>();
	for (const m of catalog) {
		const usd = (m.cost.input * 4000 + m.cost.output * 1000 + m.cost.cacheRead * 160_000 + m.cost.cacheWrite * 1000) / 1e6;
		const tier: Tier = usd < 0.01 ? "cheap" : usd < 0.06 ? "general" : "premium";
		tiers.set(lineage(m.provider, m.id, m.identity).modelKey, { tier, referenceUsd: usd });
	}
	const usage: UsageSnapshot = { status: "ok", windowDays: 30, dataAsOf: NOW, rows: opts.rows ?? [] };
	return {
		analysis: analyze({ usage, catalog, lineage, now: NOW }),
		catalog,
		quota: opts.quota ?? [],
		usage,
		lineage,
		tiers,
		// The real quality rule: one score per lineage.
		fillInt: (route, siblings, key) => fillInt(route, siblings, priors, key),
		fillTps: route => (route.tps === null ? { value: null, source: "none" } : { value: route.tps, source: "catalog" }),
		label: m => m.name,
		priority: opts.priority ?? "balanced",
		roles: ROLES,
		...(opts.current ? { current: opts.current } : {}),
	};
}
