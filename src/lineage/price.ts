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

/** Tokens per request. */
export interface TokenMix {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** USD per request for the mix at the model's rates (rates are per 1M tokens); null without pricing. */
export function mixCost(model: Pick<ModelInfo, "cost" | "pricingKnown">, mix: TokenMix): number | null {
	if (!model.pricingKnown) return null;
	const c = model.cost;
	return (c.input * mix.input + c.output * mix.output + c.cacheRead * mix.cacheRead + c.cacheWrite * mix.cacheWrite) / 1e6;
}

/** Reference request cost in USD: 4 rates × reference token mix. A missing cacheRead price is estimated from the input price. */
export function referenceCost(model: Pick<ModelInfo, "cost" | "pricingKnown">, priors: Priors): number | null {
	if (!model.pricingKnown) return null;
	const { cost } = model;
	const cacheRead = cost.cacheRead === 0 && cost.input > 0 ? cost.input * priors.priceTier.cacheReadFallbackRatio : cost.cacheRead;
	return mixCost({ pricingKnown: true, cost: { ...cost, cacheRead } }, priors.priceTier.referenceMix);
}

export function tierOf(usd: number | null, priors: Priors): Tier | null {
	if (usd === null) return null;
	const { cheapBelow, premiumFrom } = priors.priceTier.boundsUsdPerRequest;
	if (usd < cheapBelow) return "cheap";
	return usd < premiumFrom ? "general" : "premium";
}

function cheapestReference(models: ModelInfo[], priors: Priors): number | null {
	let best: number | null = null;
	for (const m of models) {
		const usd = referenceCost(m, priors);
		if (usd !== null && (best === null || usd < best)) best = usd;
	}
	return best;
}

/**
 * Tier per modelKey from the cheapest non-variant route. Available routes decide; when none of them is priced
 * (a subscription at cost 0), the lineage's other routes do, so a usable model is not left without a tier.
 */
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
		const referenceUsd = cheapestReference(candidates.filter((m) => m.available), priors) ?? cheapestReference(candidates, priors);
		out.set(key, { tier: tierOf(referenceUsd, priors), referenceUsd });
	}
	return out;
}
