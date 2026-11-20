import type { LineageFn, ModelInfo, PriceTierInfo, Tier } from "../types.ts";
import type { Priors } from "./priors.ts";

/** Routes priced off-list (speed tiers, previews, promos, TEE) never set a lineage's tier. */
const TIER_EXCLUDED_ROUTES = new Set([
	"fast",
	"ultrafast",
	"highspeed",
	"economy",
	"flex",
	"speed",
	"preview",
	"free",
	"contributor",
	"discounted",
	"tee",
]);

type Mix = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Reference request cost in USD: 4 rates × reference token mix. */
export function referenceCost(
	model: Pick<ModelInfo, "cost" | "pricingKnown">,
	priors: Priors,
): { usd: number | null; estimated: boolean } {
	if (!model.pricingKnown) return { usd: null, estimated: false };
	const { cost } = model;
	const estimated = cost.cacheRead === 0 && cost.input > 0;
	const cacheRead = estimated ? cost.input * priors.priceTier.cacheReadFallbackRatio : cost.cacheRead;
	const usd = userMixCost({ pricingKnown: true, cost: { ...cost, cacheRead } }, priors.priceTier.referenceMix);
	return { usd, estimated };
}

export function tierOf(usd: number | null, priors: Priors): Tier | null {
	if (usd === null) return null;
	const { cheapBelow, premiumFrom } = priors.priceTier.boundsUsdPerRequest;
	if (usd < cheapBelow) return "cheap";
	return usd < premiumFrom ? "general" : "premium";
}

/** Tier per modelKey from the cheapest non-variant route, preferring available routes. */
export function assignTiers(models: ModelInfo[], lineage: LineageFn, priors: Priors): Map<string, PriceTierInfo> {
	const groups = new Map<string, { model: ModelInfo; variant: boolean }[]>();
	for (const model of models) {
		const l = lineage(model.provider, model.id, model.identity);
		const route = l.variant.route;
		let g = groups.get(l.modelKey);
		if (!g) groups.set(l.modelKey, (g = []));
		g.push({ model, variant: route !== undefined && TIER_EXCLUDED_ROUTES.has(route) });
	}
	const out = new Map<string, PriceTierInfo>();
	for (const [key, routes] of groups) {
		const plain = routes.filter((r) => !r.variant);
		const candidates = (plain.length > 0 ? plain : routes).map((r) => r.model);
		const avail = candidates.filter((m) => m.available);
		let best: PriceTierInfo = { tier: null, referenceUsd: null, estimated: false, basis: null };
		for (const m of avail.length > 0 ? avail : candidates) {
			const { usd, estimated } = referenceCost(m, priors);
			if (usd === null || (best.referenceUsd !== null && usd >= best.referenceUsd)) continue;
			best = { tier: tierOf(usd, priors), referenceUsd: usd, estimated, basis: m.selector };
		}
		out.set(key, best);
	}
	return out;
}

/** Expected USD per request for a user's mean token mix. */
export function userMixCost(model: Pick<ModelInfo, "cost" | "pricingKnown">, mix: Mix): number | null {
	if (!model.pricingKnown) return null;
	const c = model.cost;
	return (c.input * mix.input + c.output * mix.output + c.cacheRead * mix.cacheRead + c.cacheWrite * mix.cacheWrite) / 1e6;
}
