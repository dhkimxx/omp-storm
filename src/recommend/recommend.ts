import { indexCatalog, measuredFor, mixCost, mixOf, VALIDATED_MAX_ERROR_RATE, VALIDATED_MIN_REQUESTS } from "../analysis/analyze.ts";
import type { AnalyzeInput } from "../analysis/analyze.ts";
import type {
	Analysis,
	Candidate,
	Confidence,
	Effort,
	LineageFn,
	ModelInfo,
	PriceTierInfo,
	Priority,
	QuotaState,
	QuotaStatus,
	RoleId,
	RoleRecommendation,
	RoleSpec,
	Tier,
	UsageSnapshot,
} from "../types.ts";
import { EFFORTS, TIERS } from "../types.ts";

export interface RecommendInput {
	analysis: Analysis;
	catalog: ModelInfo[];
	quota: QuotaStatus[];
	usage: UsageSnapshot;
	lineage: LineageFn;
	/** Keyed by modelKey. */
	tiers: Map<string, PriceTierInfo>;
	fillInt: AnalyzeInput["fillInt"];
	fillTps: AnalyzeInput["fillTps"];
	label: AnalyzeInput["label"];
	priority: Priority;
	roles: readonly RoleSpec[];
}

const MAX_CANDIDATES = 5;
/** Catalog scores come from different sources; gaps this small are noise, so the user's own preference decides instead. */
const QUALITY_TOLERANCE = 1;
/** Default effort per role; recommendations and proposals start from it. */
export const ROLE_EFFORT: Record<RoleId, Effort> = {
	explorer: "low",
	implementer: "medium",
	reviewer: "high",
	quick: "low",
	architect: "xhigh",
};
const TIER_LABEL: Record<Tier, string> = { cheap: "저가", general: "범용", premium: "고성능" };
const CONFIDENCE: readonly Confidence[] = ["high", "medium", "low"];

/** Requested effort if supported, else the nearest supported one (ties go up); null without effort control. */
export function pickEffort(want: Effort, supported: readonly Effort[]): Effort | null {
	if (supported.length === 0) return null;
	if (supported.includes(want)) return want;
	const target = EFFORTS.indexOf(want);
	let best: Effort | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const e of supported) {
		const i = EFFORTS.indexOf(e);
		const dist = Math.abs(i - target);
		if (dist < bestDist || (dist === bestDist && i > target)) {
			best = e;
			bestDist = dist;
		}
	}
	return best;
}

function targetTierIndex(role: RoleSpec, priority: Priority): number {
	const base = TIERS.indexOf(role.preferredTier);
	const shift = priority === "quality" ? 1 : priority === "cost" ? -1 : 0;
	return Math.min(TIERS.length - 1, Math.max(0, base + shift));
}

interface Entry {
	model: ModelInfo;
	cls: string;
	candidate: Candidate;
	tierDistance: number;
	quotaFraction: number | null;
	/** Cost on the user's mix for route tie-breaks. */
	routeCost: number | null;
}

interface Key {
	value: (e: Entry) => number;
	whyNot: (e: Entry, chosen: Entry) => string;
}

const nullLast = (v: number | null, sign: 1 | -1): number => (v === null ? Number.POSITIVE_INFINITY : sign * v);

export function recommend(input: RecommendInput): RoleRecommendation[] {
	const idx = indexCatalog(input.catalog, input.lineage);
	const quotaBy = new Map(input.quota.map(q => [q.provider, q]));
	const subagentRows = input.usage.rows.filter(r => r.seat === "subagent");
	const userMix = mixOf(subagentRows);
	const routeRequests = new Map<string, number>();
	for (const r of subagentRows) {
		const selector = `${r.provider}/${r.model}`;
		routeRequests.set(selector, (routeRequests.get(selector) ?? 0) + r.requests);
	}

	// Lineages the user has validated as subagents (many requests, few errors) and how much they lean on each.
	const validated = new Map<string, { requests: number; errorRate: number }>();
	const usageShare = new Map<string, { recent: number; window: number }>();
	for (const list of Object.values(input.analysis.preferences.subagent)) {
		for (const lu of list) {
			usageShare.set(lu.modelKey, { recent: lu.shareRecent, window: lu.share });
			if (lu.requests >= VALIDATED_MIN_REQUESTS && lu.errorRate <= VALIDATED_MAX_ERROR_RATE) {
				validated.set(lu.modelKey, { requests: lu.requests, errorRate: lu.errorRate });
			}
		}
	}

	const results = new Map<RoleId, RoleRecommendation>();
	const chosenCls = new Map<RoleId, string>();
	const visiting = new Set<RoleId>();

	const run = (role: RoleSpec): RoleRecommendation => {
		const done = results.get(role.id);
		if (done) return done;
		visiting.add(role.id);
		let avoidCls: string | undefined;
		if (role.diversityFrom && !visiting.has(role.diversityFrom)) {
			const other = input.roles.find(r => r.id === role.diversityFrom);
			if (other) {
				run(other);
				avoidCls = chosenCls.get(other.id);
			}
		}
		const rec = recommendRole(role, avoidCls);
		const chosen = rec.candidates[rec.chosenIndex];
		if (chosen) {
			const m = idx.bySelector.get(chosen.selector);
			if (m) chosenCls.set(role.id, idx.lineageOf(m.provider, m.id).cls);
		}
		results.set(role.id, rec);
		visiting.delete(role.id);
		return rec;
	};

	const recommendRole = (role: RoleSpec, avoidCls: string | undefined): RoleRecommendation => {
		const excluded: RoleRecommendation["excluded"] = [];
		const target = targetTierIndex(role, input.priority);
		const entries: Entry[] = [];

		for (const model of idx.bySelector.values()) {
			// Routes without credentials are not candidates; listing them would bury the real exclusions.
			if (!model.available) continue;
			const lineage = idx.lineageOf(model.provider, model.id);
			if (!model.supportsTools) {
				excluded.push({ selector: model.selector, reason: "도구 호출 미지원" });
				continue;
			}
			if (model.contextWindow !== null && model.contextWindow < role.minContext) {
				excluded.push({
					selector: model.selector,
					reason: `컨텍스트 ${model.contextWindow.toLocaleString("en-US")} < 필요 ${role.minContext.toLocaleString("en-US")}`,
				});
				continue;
			}
			const quota = quotaBy.get(model.provider);
			const quotaState: QuotaState = quota?.state ?? "unknown";
			if (quotaState === "exhausted" || quotaState === "unavailable") {
				excluded.push({ selector: model.selector, reason: quotaState === "exhausted" ? "쿼터 소진" : "Provider 사용 불가" });
				continue;
			}
			const key = lineage.modelKey;
			const siblings = idx.byKey.get(key) ?? [model];
			const tierInfo = input.tiers.get(key);
			const tier = tierInfo?.tier ?? null;
			const int = input.fillInt(model, siblings, key);
			const speed = input.fillTps(model, measuredFor(input.usage.rows, model.provider, model.id), siblings);
			const userMixUsd = userMix ? mixCost(model, userMix) : null;
			const v = validated.get(key);
			const why: string[] = [];
			if (v) {
				why.push(
					`최근 ${input.analysis.windowDays}일 subagent에서 ${v.requests.toLocaleString("en-US")}건, 오류 ${(v.errorRate * 100).toFixed(1)}%`,
				);
				const own = routeRequests.get(model.selector) ?? 0;
				if (own < v.requests) why.push(`이 경로는 ${own.toLocaleString("en-US")}건, 나머지는 같은 계열의 다른 경로`);
			}
			if (int.value === null) why.push("지능 점수 없음 — 비교 불가");
			if (quotaState === "limited") why.push("쿼터 여유 적음");
			let conf = 0;
			if (int.value === null && !v) conf++;
			if (model.contextWindow === null) conf++;
			if (tier === null) conf++;
			entries.push({
				model,
				cls: lineage.cls,
				tierDistance: tier === null ? TIERS.length : Math.abs(TIERS.indexOf(tier) - target),
				quotaFraction: quota?.usedFraction ?? null,
				routeCost: userMixUsd,
				candidate: {
					selector: model.selector,
					modelKey: key,
					label: input.label(model, lineage),
					effort: pickEffort(ROLE_EFFORT[role.id], model.efforts),
					tier,
					int,
					speed,
					referenceUsd: tierInfo?.referenceUsd ?? null,
					userMixUsd,
					quota: quotaState,
					confidence: CONFIDENCE[Math.min(conf, CONFIDENCE.length - 1)] ?? "low",
					validated: v !== undefined,
					why,
					whyNot: [],
				},
			});
		}

		const fmtInt = (e: Entry): string => (e.candidate.int.value === null ? "없음" : e.candidate.int.value.toFixed(1));
		// Scores within QUALITY_TOLERANCE of the best entry that ties on the earlier keys count as equal.
		const groupOf = (e: Entry): string =>
			`${e.tierDistance}|${avoidCls !== undefined && e.cls === avoidCls ? 1 : 0}|${e.candidate.validated ? 1 : 0}`;
		const groupTop = new Map<string, number>();
		for (const e of entries) {
			const v = e.candidate.int.value;
			if (v !== null) groupTop.set(groupOf(e), Math.max(groupTop.get(groupOf(e)) ?? v, v));
		}
		const qualityGap = (e: Entry): number => {
			const v = e.candidate.int.value;
			if (v === null) return Number.POSITIVE_INFINITY;
			const gap = (groupTop.get(groupOf(e)) ?? v) - v;
			return gap <= QUALITY_TOLERANCE ? 0 : gap;
		};
		const share = (e: Entry) => usageShare.get(e.candidate.modelKey) ?? { recent: 0, window: 0 };
		const pct = (x: number): string => `${Math.round(x * 100)}%`;
		const keys: Key[] = [
			{
				value: e => e.tierDistance,
				whyNot: e => (e.candidate.tier === null ? "가격 미상" : `목표 계층(${TIER_LABEL[TIERS[target] ?? "general"]})에서 멀다`),
			},
		];
		if (avoidCls !== undefined) {
			keys.push({ value: e => (e.cls === avoidCls ? 1 : 0), whyNot: () => "구현 역할과 같은 모델 계열" });
		}
		keys.push(
			{ value: e => (e.candidate.validated ? 0 : 1), whyNot: () => "사용자 검증 이력 없음" },
			{
				value: qualityGap,
				whyNot: (e, c) =>
					e.candidate.int.value === null ? "지능 점수 없음 — 비교 불가" : `지능 점수 낮음 (${fmtInt(e)} < ${fmtInt(c)})`,
			},
		);
		// An explicit priority outranks habit; balanced and quality fall straight through to the user's preference.
		if (input.priority === "speed") {
			keys.push({
				value: e => nullLast(e.candidate.speed.value, -1),
				whyNot: e => (e.candidate.speed.value === null ? "속도 미측정" : "더 느리다"),
			});
		} else if (input.priority === "cost") {
			keys.push({ value: e => nullLast(e.candidate.referenceUsd, 1), whyNot: () => "기준 비용이 더 높다" });
		} else if (input.priority === "quota") {
			keys.push({
				value: e => nullLast(e.quotaFraction, 1),
				whyNot: e => (e.quotaFraction === null ? "쿼터 사용률 미상" : "Provider 쿼터 사용률이 더 높다"),
			});
		}
		const preferenceKeys: Key[] = [
			{
				value: e => -share(e).recent,
				whyNot: (e, c) => `최근 subagent 사용 비중이 더 낮다 (${pct(share(e).recent)} < ${pct(share(c).recent)})`,
			},
			{
				value: e => -share(e).window,
				whyNot: (e, c) =>
					`최근 ${input.analysis.windowDays}일 subagent 사용 비중이 더 낮다 (${pct(share(e).window)} < ${pct(share(c).window)})`,
			},
		];
		keys.push(
			...preferenceKeys,
			{ value: e => nullLast(e.candidate.referenceUsd, 1), whyNot: () => "기준 비용이 더 높다" },
			// Route tie-breaks within one lineage.
			{ value: e => nullLast(e.routeCost, 1), whyNot: () => "같은 계열의 더 싼 경로가 있다" },
			{ value: e => nullLast(e.candidate.speed.value, -1), whyNot: () => "같은 계열의 더 빠른 경로가 있다" },
		);
		const compare = (a: Entry, b: Entry): number => {
			for (const k of keys) {
				const d = k.value(a) - k.value(b);
				if (d !== 0 && !Number.isNaN(d)) return d;
			}
			return a.model.selector < b.model.selector ? -1 : a.model.selector > b.model.selector ? 1 : 0;
		};
		entries.sort(compare);

		const best: Entry[] = [];
		const seenKeys = new Set<string>();
		for (const e of entries) {
			if (seenKeys.has(e.candidate.modelKey)) {
				excluded.push({ selector: e.model.selector, reason: "같은 계열의 다른 경로" });
				continue;
			}
			seenKeys.add(e.candidate.modelKey);
			best.push(e);
		}
		const top = best.slice(0, MAX_CANDIDATES);
		const chosen = top[0];
		if (chosen) {
			const sameTier = top.filter(e => e.candidate.tier === chosen.candidate.tier && e.candidate.int.value !== null);
			const topInt = Math.max(...sameTier.map(e => e.candidate.int.value ?? Number.NEGATIVE_INFINITY));
			if (chosen.candidate.int.value !== null && sameTier.length > 1 && chosen.candidate.int.value >= topInt) {
				chosen.candidate.why.push("같은 비용대에서 지능 점수 최고");
			}
			if (chosen.tierDistance > 0 && chosen.candidate.tier !== null) {
				chosen.candidate.why.push(`목표 계층에 후보가 없어 ${TIER_LABEL[chosen.candidate.tier]} 계층에서 골랐다`);
			}
			if (avoidCls !== undefined && chosen.cls !== avoidCls) chosen.candidate.why.push("구현 역할과 다른 모델 계열");
			let preferenceDecided = false;
			for (const e of top.slice(1)) {
				for (const k of keys) {
					if (k.value(e) !== k.value(chosen)) {
						e.candidate.whyNot.push(k.whyNot(e, chosen));
						if (preferenceKeys.includes(k)) preferenceDecided = true;
						break;
					}
				}
			}
			if (preferenceDecided) chosen.candidate.why.push("지능 점수가 비슷한 후보 중 최근 subagent로 가장 많이 쓴 모델");
		}
		return { role, candidates: top.map(e => e.candidate), chosenIndex: chosen ? 0 : -1, excluded };
	};

	return input.roles.map(role => run(role));
}
