import type { LineageVariant, MetricValue, ModelInfo } from "../types.ts";
import type { Priors } from "./priors.ts";

const FAST_ROUTES = new Set(["fast", "ultrafast", "highspeed"]);

/** Value backed by the most distinct providers; ties go to the lower value. */
function modeByProviders(rows: { provider: string; value: number }[]): { value: number; providers: number; conflict: boolean } | null {
	const byValue = new Map<number, Set<string>>();
	for (const r of rows) {
		let set = byValue.get(r.value);
		if (!set) byValue.set(r.value, (set = new Set()));
		set.add(r.provider);
	}
	let best: { value: number; providers: number } | null = null;
	for (const [value, providers] of byValue) {
		if (!best || providers.size > best.providers || (providers.size === best.providers && value < best.value)) {
			best = { value, providers: providers.size };
		}
	}
	return best && { ...best, conflict: byValue.size > 1 };
}

/** Quality score for a route: self → same-modelKey siblings → prior → missing (p0-q9 Q9-6). */
export function fillInt(route: ModelInfo, siblings: ModelInfo[], priors: Priors, key: string): MetricValue {
	if (route.int !== null) return { value: route.int, source: "catalog", confidence: "high" };
	// Unknown revisions are rolling aliases; borrowing would mix generations.
	if (!key.endsWith("@?")) {
		const mode = modeByProviders(
			siblings
				.filter((s) => s.selector !== route.selector && s.int !== null)
				.map((s) => ({ provider: s.provider, value: s.int as number })),
		);
		if (mode) {
			const v: MetricValue = {
				value: mode.value,
				source: `catalog:sibling(${mode.providers})`,
				confidence: mode.conflict ? "low" : "medium",
			};
			if (mode.conflict) v.conflict = true;
			return v;
		}
	}
	const prior = priors.qualityPriors.find((p) => p.key === key && p.metric === "int");
	if (prior) return { value: prior.value, source: `prior:${prior.source}`, confidence: "low" };
	return { value: null, source: "none", confidence: "low", missingReason: "catalog_no_score" };
}

const MIN_TPS_SAMPLES = 30;

/** Decode speed for a route: measured → own catalog → same-speed-class sibling → missing. */
export function fillTps(
	route: ModelInfo,
	measured: { decodeTps: number | null; samples: number } | undefined,
	siblings: ModelInfo[],
	routeVariant: LineageVariant,
	siblingVariants: Map<string, LineageVariant>,
): MetricValue {
	if (measured && measured.decodeTps !== null && measured.samples >= MIN_TPS_SAMPLES) {
		return { value: measured.decodeTps, source: "measured", confidence: "high", sampleSize: measured.samples };
	}
	if (route.tps !== null) return { value: route.tps, source: "catalog", confidence: "medium" };
	const fast = FAST_ROUTES.has(routeVariant.route ?? "");
	const mode = modeByProviders(
		siblings
			.filter(
				(s) =>
					s.selector !== route.selector &&
					s.tps !== null &&
					FAST_ROUTES.has(siblingVariants.get(s.selector)?.route ?? "") === fast,
			)
			.map((s) => ({ provider: s.provider, value: s.tps as number })),
	);
	if (mode) {
		const v: MetricValue = { value: mode.value, source: `catalog:sibling(${mode.providers})`, confidence: "low" };
		if (mode.conflict) v.conflict = true;
		return v;
	}
	return { value: null, source: "none", confidence: "low", missingReason: "unmeasured" };
}
