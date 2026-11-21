import { type CatalogIndex, indexCatalog, measuredFor, mixOf } from "../analysis/analyze.ts";
import { exhaustedLimit } from "../discovery/quota.ts";
import { compareRevision } from "../lineage/key.ts";
import { leadTolerance, QUALITY_TOLERANCE, scoreText } from "../lineage/metrics.ts";
import { mixCost } from "../lineage/price.ts";
import type {
	Analysis,
	Candidate,
	CurrentRank,
	Effort,
	Lineage,
	LineageFn,
	MetricValue,
	ModelInfo,
	NewerVersion,
	PriceTierInfo,
	Priority,
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
	fillInt: (route: ModelInfo, siblings: ModelInfo[], key: string) => MetricValue;
	fillTps: (
		route: ModelInfo,
		measured: { decodeTps: number | null; samples: number } | undefined,
		siblings: ModelInfo[],
	) => MetricValue;
	label: (model: ModelInfo, lineage: Lineage) => string;
	priority: Priority;
	roles: readonly RoleSpec[];
	/** Role id → the role's primary selector now; each named role gets `RoleRecommendation.current`. */
	current?: Readonly<Record<string, string>>;
}

const MAX_CANDIDATES = 5;
/**
 * Validated by use: the user ran the lineage as a subagent at least this often in the window, with at most this
 * error rate. One Storm run reaches 30 requests on a role, so the bar sits well above what a single run feeds back.
 */
const VALIDATED_MIN_REQUESTS = 100;
const VALIDATED_MAX_ERROR_RATE = 0.02;
/**
 * How many points of catalog score real usage is worth under the balanced and cost priorities. Catalog scores of one
 * model differ by 10–25 points between routes, so a small lead of a model the user never ran says less than their
 * own requests do: an unvalidated model outranks a validated one only when it leads by more than this margin, or by
 * more than its own tolerance when that is wider (the two do not add up). Under the quality priority the margin is 0
 * and validation only breaks ties. The rule is applied when quality classes are cut (`qualityClasses`), so it holds
 * between the members of a class and the scores below it, not between every pair of models.
 */
const VALIDATED_MARGIN = 8;
/**
 * Default effort per role; recommendations and proposals start from it. Never below medium: on the cheap models these
 * roles run, low saves little and costs quality. Code changes get high.
 */
export const ROLE_EFFORT: Record<RoleId, Effort> = {
	explorer: "medium",
	implementer: "high",
	reviewer: "high",
	quick: "medium",
	architect: "xhigh",
};
const TIER_LABEL: Record<Tier, string> = { cheap: "저가", general: "일반", premium: "고가" };

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
	/** Requests on this very route, per seat. */
	subagentRequests: number;
	mainRequests: number;
	/** Cost on the user's mix for route tie-breaks. */
	routeCost: number | null;
}

interface Key {
	value: (e: Entry) => number;
	/** Why `e` ranks below `above` on this key. */
	whyNot: (e: Entry, above: Entry) => string;
}

const nullLast = (v: number | null, sign: 1 | -1): number => (v === null ? Number.POSITIVE_INFINITY : sign * v);
const count = (n: number): string => n.toLocaleString("en-US");
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Quality class per scored entry, 0 = best. Inside a group (entries that tie on the earlier keys) scores are walked
 * from the highest down. A class starts with its leader and reaches down by the leader's tolerance; every score that
 * joins narrows it to its own tolerance too (the floor only rises), so a leader whose routes disagree cannot pull in
 * models that an exact member above them clearly beats. A score below the floor opens the next class.
 * Entries without a score get no class.
 *
 * `margin` points are added to a validated entry's score first. For a validated score below an unvalidated member
 * the margin is thereby already in the gap, so only the part of that member's tolerance beyond it still counts:
 * the unvalidated one wins by more than max(margin, tolerance), never by margin + tolerance.
 *
 * The walk order is total (score, then agreement of routes, validated first, selector), so the classes do not
 * depend on catalog order.
 */
function qualityClasses(
	entries: readonly Entry[],
	groupOf: (e: Entry) => string,
	tolerance: (score: MetricValue) => number,
	margin: number,
): Map<Entry, number> {
	const scored: Array<{ entry: Entry; value: number }> = [];
	for (const entry of entries) {
		const { value } = entry.candidate.int;
		if (value !== null) scored.push({ entry, value: entry.candidate.validated ? value + margin : value });
	}
	scored.sort(
		(a, b) =>
			b.value - a.value ||
			(a.entry.candidate.int.spread ?? 0) - (b.entry.candidate.int.spread ?? 0) ||
			Number(b.entry.candidate.validated) - Number(a.entry.candidate.validated) ||
			(a.entry.model.selector < b.entry.model.selector ? -1 : a.entry.model.selector > b.entry.model.selector ? 1 : 0),
	);
	const classes = new Map<Entry, number>();
	// Per group, the open class: its index and the lowest score that still joins it, for an unvalidated and a validated entry.
	const open = new Map<string, { index: number; floor: number; floorValidated: number }>();
	for (const { entry, value } of scored) {
		const { validated } = entry.candidate;
		const own = tolerance(entry.candidate.int);
		const reach = value - own;
		const reachValidated = validated ? reach : value - Math.max(0, own - margin);
		const group = groupOf(entry);
		let cls = open.get(group);
		if (!cls) {
			cls = { index: 0, floor: reach, floorValidated: reachValidated };
			open.set(group, cls);
		} else if (value < (validated ? cls.floorValidated : cls.floor)) {
			cls.index++;
			cls.floor = reach;
			cls.floorValidated = reachValidated;
		} else {
			cls.floor = Math.max(cls.floor, reach);
			cls.floorValidated = Math.max(cls.floorValidated, reachValidated);
		}
		classes.set(entry, cls.index);
	}
	return classes;
}

/**
 * Ranks the usable models per role. Key order, first difference decides:
 * 1. distance from the role's price tier (shifted one step by the quality / cost priority),
 * 2. a different model class than the role it should be independent of (reviewer vs implementer),
 * 3. quality class: one score per lineage, classes cut by their members' tolerances (src/lineage/metrics.ts). Under
 *    balanced and cost a validated lineage counts VALIDATED_MARGIN points higher here, so real usage outranks a
 *    small catalog lead and loses to a large one; under quality the scores stand as they are,
 * 4. validated by the user's own subagent runs (VALIDATED_MIN_REQUESTS or more): the only usage that decides inside a class,
 * 5. reference cost, only under the cost priority,
 * 6. quality class again, on the plain scores and tolerance: models the earlier cut could not separate keep their score order,
 * 7. the user's subagent usage share, recent then whole window: a tie-break, since a single request also has a share,
 * 8. quota: a candidate whose limit is exhausted now goes after equal ones that can run, also the used route of a
 *    model after a route of it that runs,
 * 9. requests on this very route (subagent, then main): the route the user ran beats one never used,
 * 10. reference cost, then the route's cost on the user's token mix, then speed.
 */
export function recommend(input: RecommendInput): RoleRecommendation[] {
	const idx = indexCatalog(input.catalog, input.lineage);
	const quotaBy = new Map(input.quota.map(q => [q.provider, q]));
	const subagentRows = input.usage.rows.filter(r => r.seat === "subagent");
	const userMix = mixOf(subagentRows);

	// Per lineage: how much the user leans on it as a subagent and whether those runs validate it. Per route: its own requests.
	const validated = new Map<string, { requests: number; errorRate: number }>();
	const usageShare = new Map<string, { recent: number; window: number }>();
	const routeRequests = { subagent: new Map<string, number>(), main: new Map<string, number>() };
	for (const lu of input.analysis.preferences.subagent) {
		usageShare.set(lu.modelKey, { recent: lu.shareRecent, window: lu.share });
		if (lu.requests >= VALIDATED_MIN_REQUESTS && lu.errorRate <= VALIDATED_MAX_ERROR_RATE) {
			validated.set(lu.modelKey, { requests: lu.requests, errorRate: lu.errorRate });
		}
	}
	for (const seat of ["subagent", "main"] as const) {
		for (const lu of input.analysis.preferences[seat]) {
			for (const route of lu.routes) routeRequests[seat].set(route.selector, route.requests);
		}
	}

	const results = new Map<RoleId, RoleRecommendation>();
	const chosenCls = new Map<RoleId, string>();
	const visiting = new Set<RoleId>();
	/** Model class of a configured selector; undefined when none is given or the class is unknown. */
	const classOf = (selector: string | undefined): string | undefined => {
		if (selector === undefined) return undefined;
		const slash = selector.indexOf("/");
		const cls = idx.lineageOf(selector.slice(0, slash), selector.slice(slash + 1)).cls;
		return cls === "unknown" ? undefined : cls;
	};

	const run = (role: RoleSpec): RoleRecommendation => {
		const done = results.get(role.id);
		if (done) return done;
		visiting.add(role.id);
		// The reviewer must differ from the implementer the team has; without a team, from the one recommended here.
		let avoidCls = role.diversityFrom === undefined ? undefined : classOf(input.current?.[role.diversityFrom]);
		if (avoidCls === undefined && role.diversityFrom && !visiting.has(role.diversityFrom)) {
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
					reason: `컨텍스트 ${count(model.contextWindow)} < 필요 ${count(role.minContext)}`,
				});
				continue;
			}
			const quota = quotaBy.get(model.provider);
			// Quota is transient and the team is not: an exhausted limit never drops a candidate.
			const stopped = exhaustedLimit(quota, model.id, lineage.tier);
			const key = lineage.modelKey;
			const siblings = idx.byKey.get(key) ?? [model];
			const tierInfo = input.tiers.get(key);
			const tier = tierInfo?.tier ?? null;
			const int = input.fillInt(model, siblings, key);
			const subagentRequests = routeRequests.subagent.get(model.selector) ?? 0;
			const v = validated.get(key);
			const why: string[] = [];
			if (v) {
				why.push(`최근 ${input.analysis.windowDays}일 서브에이전트에서 ${count(v.requests)}건, 오류 ${(v.errorRate * 100).toFixed(1)}%`);
				if (subagentRequests < v.requests) why.push(`이 경로는 ${count(subagentRequests)}건, 나머지는 같은 계열의 다른 경로`);
			}
			if (int.value === null) why.push("지능 점수 없음 — 비교 불가");
			if (stopped) why.push("지금 쿼터 소진");
			else if (quota?.state === "limited") why.push("쿼터 여유 적음");
			const candidate: Candidate = {
				selector: model.selector,
				modelKey: key,
				label: input.label(model, lineage),
				effort: pickEffort(ROLE_EFFORT[role.id], model.efforts),
				tier,
				int,
				speed: input.fillTps(model, measuredFor(input.usage.rows, model.provider, model.id), siblings),
				referenceUsd: tierInfo?.referenceUsd ?? null,
				quota: stopped ? "exhausted" : (quota?.state ?? "unknown"),
				validated: v !== undefined,
				why,
				whyNot: [],
			};
			if (stopped && stopped.resetsAt !== null) candidate.quotaResetsAt = stopped.resetsAt;
			entries.push({
				model,
				cls: lineage.cls,
				candidate,
				tierDistance: tier === null ? TIERS.length : Math.abs(TIERS.indexOf(tier) - target),
				subagentRequests,
				mainRequests: routeRequests.main.get(model.selector) ?? 0,
				routeCost: userMix ? mixCost(model, userMix) : null,
			});
		}

		// Quality classes among entries that tie on the earlier keys: first with each leader's own tolerance and the
		// validation margin, later on the plain scores with the plain tolerance.
		const groupOf = (e: Entry): string => `${e.tierDistance}|${avoidCls !== undefined && e.cls === avoidCls ? 1 : 0}`;
		const margin = input.priority === "quality" ? 0 : VALIDATED_MARGIN;
		const lead = qualityClasses(entries, groupOf, leadTolerance, margin);
		const plain = qualityClasses(entries, groupOf, () => QUALITY_TOLERANCE, 0);
		const lowerScore: Key["whyNot"] = (e, above) => {
			const own = e.candidate.int.value;
			const other = above.candidate.int.value;
			if (own === null) return "지능 점수 없음 — 비교 불가";
			// Only the validation margin puts a higher or equal score below.
			if (other !== null && own >= other) {
				return `써서 검증한 기록 없음 — 점수 우위가 ${margin}점 이하 (${scoreText(e.candidate.int)} vs ${scoreText(above.candidate.int)})`;
			}
			return `지능 점수 낮음 (${scoreText(e.candidate.int)} < ${scoreText(above.candidate.int)})`;
		};
		const share = (e: Entry) => usageShare.get(e.candidate.modelKey) ?? { recent: 0, window: 0 };
		const costKey: Key = { value: e => nullLast(e.candidate.referenceUsd, 1), whyNot: () => "참조 비용이 더 높음" };
		const lessUsed: Key["whyNot"] = (e, above) =>
			e.candidate.modelKey === above.candidate.modelKey ? "같은 계열에서 더 많이 쓴 경로가 있음" : "직접 쓴 기록이 더 적음";
		const keys: Key[] = [
			{
				value: e => e.tierDistance,
				whyNot: e => (e.candidate.tier === null ? "가격 미상" : `목표 가격대(${TIER_LABEL[TIERS[target] ?? "general"]})에서 벗어남`),
			},
		];
		if (avoidCls !== undefined) {
			keys.push({ value: e => (e.cls === avoidCls ? 1 : 0), whyNot: () => "구현 역할과 같은 모델 계열" });
		}
		keys.push(
			{ value: e => lead.get(e) ?? Number.POSITIVE_INFINITY, whyNot: lowerScore },
			{ value: e => (e.candidate.validated ? 0 : 1), whyNot: () => "써서 검증한 기록 없음" },
		);
		if (input.priority === "cost") keys.push(costKey);
		const preferenceKeys: Key[] = [
			{
				value: e => -share(e).recent,
				whyNot: (e, above) => `최근 서브에이전트 사용 비중이 더 낮음 (${pct(share(e).recent)} < ${pct(share(above).recent)})`,
			},
			{
				value: e => -share(e).window,
				whyNot: (e, above) =>
					`최근 ${input.analysis.windowDays}일 서브에이전트 사용 비중이 더 낮음 (${pct(share(e).window)} < ${pct(share(above).window)})`,
			},
		];
		keys.push(
			{ value: e => plain.get(e) ?? Number.POSITIVE_INFINITY, whyNot: lowerScore },
			...preferenceKeys,
			{ value: e => (e.candidate.quota === "exhausted" ? 1 : 0), whyNot: () => "지금 쿼터 소진" },
			{ value: e => -e.subagentRequests, whyNot: lessUsed },
			{ value: e => -e.mainRequests, whyNot: lessUsed },
			costKey,
			{ value: e => nullLast(e.routeCost, 1), whyNot: () => "같은 계열의 더 싼 경로가 있음" },
			{ value: e => nullLast(e.candidate.speed.value, -1), whyNot: () => "같은 계열의 더 빠른 경로가 있음" },
		);
		/** The first key on which the two differ. */
		const decidingKey = (a: Entry, b: Entry): Key | undefined => {
			for (const k of keys) {
				const d = k.value(a) - k.value(b);
				if (d !== 0 && !Number.isNaN(d)) return k;
			}
			return undefined;
		};
		entries.sort((a, b) => {
			const k = decidingKey(a, b);
			if (k) return k.value(a) - k.value(b);
			return a.model.selector < b.model.selector ? -1 : a.model.selector > b.model.selector ? 1 : 0;
		});

		// One candidate per lineage: its best route.
		const ranked: Entry[] = [];
		const seenKeys = new Set<string>();
		for (const e of entries) {
			if (seenKeys.has(e.candidate.modelKey)) continue;
			seenKeys.add(e.candidate.modelKey);
			ranked.push(e);
		}
		const top = ranked.slice(0, MAX_CANDIDATES);
		const chosen = ranked[0];
		const rec: RoleRecommendation = { role, candidates: top.map(e => e.candidate), chosenIndex: chosen ? 0 : -1, excluded };
		if (chosen) {
			const sameTier = top.filter(e => e.candidate.tier === chosen.candidate.tier && e.candidate.int.value !== null);
			const topInt = Math.max(...sameTier.map(e => e.candidate.int.value ?? Number.NEGATIVE_INFINITY));
			if (chosen.candidate.int.value !== null && sameTier.length > 1 && chosen.candidate.int.value >= topInt) {
				chosen.candidate.why.push("같은 가격대에서 지능 점수 최고");
			}
			if (chosen.tierDistance > 0 && chosen.candidate.tier !== null) {
				chosen.candidate.why.push(`목표 가격대에 후보가 없어 ${TIER_LABEL[chosen.candidate.tier]} 가격대에서 고름`);
			}
			if (avoidCls !== undefined && chosen.cls !== avoidCls) chosen.candidate.why.push("구현 역할과 다른 모델 계열");
			// The fallback has to work when the chosen model fails, so among the routes of other lineages on other
			// providers that can run now it is the best-ranked one the user ran on a validated lineage, else the
			// best-ranked one with requests of its own, else the best-ranked one. Only when none can run does an
			// exhausted route stand in: quota is transient and a role with one model is not.
			const elsewhere = entries.filter(
				e => e.model.provider !== chosen.model.provider && e.candidate.modelKey !== chosen.candidate.modelKey,
			);
			const runnable = elsewhere.filter(e => e.candidate.quota !== "exhausted");
			const ran = (e: Entry): boolean => e.subagentRequests + e.mainRequests > 0;
			const fallback = runnable.find(e => e.candidate.validated && ran(e)) ?? runnable.find(ran) ?? runnable[0] ?? elsewhere[0];
			let preferenceDecided = false;
			for (const e of fallback && !top.includes(fallback) ? [...top.slice(1), fallback] : top.slice(1)) {
				const k = decidingKey(e, chosen);
				if (!k) continue;
				e.candidate.whyNot.push(k.whyNot(e, chosen));
				if (preferenceKeys.includes(k)) preferenceDecided = true;
			}
			if (preferenceDecided) chosen.candidate.why.push("지능 점수가 비슷한 후보 중 최근 서브에이전트로 가장 많이 쓴 모델");
			if (fallback) rec.fallback = fallback.candidate;
		}

		const currentSelector = input.current?.[role.id];
		if (currentSelector !== undefined) {
			const current: CurrentRank = { above: [], newer: newerVersions(idx, input, currentSelector) };
			const own = entries.find(e => e.model.selector === currentSelector);
			if (own) {
				const lineageBest = new Set(ranked);
				for (const e of entries) {
					if (e === own) break;
					if (lineageBest.has(e)) current.above.push({ candidate: e.candidate, reason: decidingKey(own, e)?.whyNot(own, e) ?? "" });
				}
			} else {
				current.excluded =
					excluded.find(x => x.selector === currentSelector)?.reason ??
					(idx.bySelector.has(currentSelector) ? "지금 쓸 수 없는 모델 (Provider 로그인 필요)" : "카탈로그에 없는 모델");
			}
			rec.current = current;
		}
		return rec;
	};

	return input.roles.map(role => run(role));
}

/** Catalog lineages on the same line ("class/tier") as `selector` with a higher revision, usable now or after a login. */
function newerVersions(idx: CatalogIndex, input: RecommendInput, selector: string): NewerVersion[] {
	const slash = selector.indexOf("/");
	const from = idx.lineageOf(selector.slice(0, slash), selector.slice(slash + 1));
	if (from.revision === null) return [];
	const found: Array<{ modelKey: string; revision: string; version: NewerVersion }> = [];
	for (const [modelKey, models] of idx.byKey) {
		const first = models[0];
		if (!first) continue;
		const to = idx.lineageOf(first.provider, first.id);
		if (to.lineKey !== from.lineKey || to.suspect || to.revision === null) continue;
		if (compareRevision(to.revision, from.revision) <= 0) continue;
		const usable = models.filter(m => m.available);
		const shown = usable[0] ?? first;
		found.push({
			modelKey,
			revision: to.revision,
			version: {
				label: input.label(shown, to),
				int: input.fillInt(shown, models, modelKey),
				selectors: usable.map(m => m.selector).sort(),
				loginProviders: usable.length > 0 ? [] : [...new Set(models.map(m => m.provider))].sort(),
				needsCheck:
					to.revisionSource === "name" ||
					from.revisionSource === "name" ||
					models.every(m => idx.lineageOf(m.provider, m.id).variant.route === "preview"),
			},
		});
	}
	return found
		.sort((a, b) => compareRevision(b.revision, a.revision) || a.modelKey.localeCompare(b.modelKey))
		.map(f => f.version);
}
