import type { LineageVariant, MetricValue, ModelInfo } from "../types.ts";
import type { Priors } from "./priors.ts";

const FAST_ROUTES = new Set(["fast", "ultrafast", "highspeed"]);

/**
 * The quality rule. Ranking and reports both go through `fillInt`, `leadTolerance` and `scoreText`.
 *
 * The catalog publishes `int` per route, and routes of one model disagree by 10–25 points, so a route's own
 * value says little about the model. A lineage therefore has one score: the median of its routes' values.
 * The score is approximate ("≈") for a route without a value of its own and whenever the routes disagree;
 * `spread` (max − min) says by how much.
 *
 * A score leads the ones below it only by more than its tolerance: QUALITY_TOLERANCE, or half its own spread when
 * that is more. Scores within a leader's tolerance are the same quality class. A leader whose routes disagree
 * therefore cannot outrank the models just below it on score alone, while a lower score never gains from being uncertain.
 *
 * Unknown revisions ("@?") are rolling aliases whose routes can be different generations: each keeps its own value.
 */
export const QUALITY_TOLERANCE = 1;

function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Quality score of `route`'s lineage: routes' median → prior → missing. `siblings` are the catalog rows of the same modelKey. */
export function fillInt(route: ModelInfo, siblings: ModelInfo[], priors: Priors, key: string): MetricValue {
	const rolling = key.endsWith("@?");
	const values: number[] = [];
	for (const s of rolling ? [] : siblings) if (s.selector !== route.selector && s.int !== null) values.push(s.int);
	if (route.int !== null) values.push(route.int);
	if (values.length > 0) {
		const spread = Math.max(...values) - Math.min(...values);
		const score: MetricValue = { value: median(values), source: rolling ? "catalog" : "lineage" };
		if (route.int === null || spread > 0) score.approx = true;
		if (spread > 0) score.spread = spread;
		return score;
	}
	const prior = priors.qualityPriors.find((p) => p.key === key && p.metric === "int");
	if (prior) return { value: prior.value, source: `prior:${prior.source}`, approx: true };
	return { value: null, source: "none" };
}

/** How far another score may lie below `best` and still count as the same quality. */
export function leadTolerance(best: MetricValue): number {
	return Math.max(QUALITY_TOLERANCE, (best.spread ?? 0) / 2);
}

/** A quality score for display: "52", "≈52", or "—" when missing. */
export function scoreText(score: MetricValue): string {
	return score.value === null ? "—" : `${score.approx ? "≈" : ""}${Math.round(score.value)}`;
}

/** Value backed by the most distinct providers; ties go to the lower value. */
function modeByProviders(rows: { provider: string; value: number }[]): number | null {
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
	return best && best.value;
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
		return { value: measured.decodeTps, source: "measured" };
	}
	if (route.tps !== null) return { value: route.tps, source: "catalog" };
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
	return mode === null ? { value: null, source: "none" } : { value: mode, source: "catalog:sibling" };
}
