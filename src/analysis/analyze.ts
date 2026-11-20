import type {
	Alternative,
	Analysis,
	Lineage,
	LineageFn,
	LineageUsage,
	MetricValue,
	ModelCost,
	ModelInfo,
	NewerVersion,
	PriceTierInfo,
	QuotaStatus,
	RouteStats,
	Seat,
	StoppedLineage,
	Tier,
	UsageRow,
	UsageSnapshot,
} from "../types.ts";

export interface AnalyzeInput {
	usage: UsageSnapshot;
	catalog: ModelInfo[];
	quota: QuotaStatus[];
	lineage: LineageFn;
	/** Keyed by modelKey. */
	tiers: Map<string, PriceTierInfo>;
	fillInt: (route: ModelInfo, siblings: ModelInfo[], key: string) => MetricValue;
	fillTps: (
		route: ModelInfo,
		measured: { decodeTps: number | null; samples: number } | undefined,
		siblings: ModelInfo[],
	) => MetricValue;
	label: (model: ModelInfo | undefined, lineage: Lineage) => string;
	now: number;
}

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 7;
const STOP_MIN_SHARE = 0.03;
const STOP_IDLE_MS = 4 * DAY_MS;
const ERROR_WINDOW_DAYS = 7;
const ERROR_MIN_SAMPLES = 20;
const STALE_MS = 6 * 3_600_000;
const ALT_TOP = 5;
const ALT_PER_KIND = 2;
export const VALIDATED_MIN_REQUESTS = 30;
export const VALIDATED_MAX_ERROR_RATE = 0.02;

/** Average tokens per request. */
export interface TokenMix {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Average token mix per request over the given rows; undefined without requests. */
export function mixOf(rows: readonly UsageRow[]): TokenMix | undefined {
	let requests = 0;
	const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const row of rows) {
		requests += row.requests;
		sum.input += row.inputTokens;
		sum.output += row.outputTokens;
		sum.cacheRead += row.cacheReadTokens;
		sum.cacheWrite += row.cacheWriteTokens;
	}
	if (requests <= 0) return undefined;
	return {
		input: sum.input / requests,
		output: sum.output / requests,
		cacheRead: sum.cacheRead / requests,
		cacheWrite: sum.cacheWrite / requests,
	};
}

/** USD per request for the mix at the model's rates (rates are per 1M tokens); null without pricing. */
export function mixCost(model: { cost: ModelCost; pricingKnown: boolean }, mix: TokenMix): number | null {
	if (!model.pricingKnown) return null;
	const c = model.cost;
	return (c.input * mix.input + c.output * mix.output + c.cacheRead * mix.cacheRead + c.cacheWrite * mix.cacheWrite) / 1e6;
}

/** Decode tok/s for a route across the given rows, weighted by duration samples. */
export function measuredFor(
	rows: readonly UsageRow[],
	provider: string,
	id: string,
): { decodeTps: number | null; samples: number } | undefined {
	let weighted = 0;
	let samples = 0;
	let found = false;
	for (const row of rows) {
		if (row.provider !== provider || row.model !== id) continue;
		found = true;
		if (row.decodeTps !== null && row.durationSamples > 0) {
			weighted += row.decodeTps * row.durationSamples;
			samples += row.durationSamples;
		}
	}
	if (!found) return undefined;
	return { decodeTps: samples > 0 ? weighted / samples : null, samples };
}

/** Numeric dotted-revision compare: "1.10" > "1.9". */
export function compareRevision(a: string, b: string): number {
	const pa = a.split(".").map(p => Number.parseInt(p, 10) || 0);
	const pb = b.split(".").map(p => Number.parseInt(p, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

function localDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Recency weight of a local "YYYY-MM-DD" day (noon) relative to now. */
function dayWeight(day: string, now: number): number {
	const [y, m, d] = day.split("-").map(Number);
	if (!y || !m || !d) return 0;
	const age = Math.max(0, (now - new Date(y, m - 1, d, 12).getTime()) / DAY_MS);
	return 0.5 ** (age / HALF_LIFE_DAYS);
}

function weightedRequests(row: UsageRow, now: number): number {
	let w = 0;
	for (const [day, n] of Object.entries(row.daily)) w += n * dayWeight(day, now);
	return w;
}

const fmtPct = (x: number): string => `${(x * 100).toFixed(1)}%`;

interface Group {
	seat: Seat;
	lineage: Lineage;
	rows: UsageRow[];
	requests: number;
	errors: number;
	weighted: number;
	lastTs: number;
}

/** Shared per-catalog lookups used by analyze and recommend. */
export interface CatalogIndex {
	bySelector: Map<string, ModelInfo>;
	lineageOf: (provider: string, id: string) => Lineage;
	/** Catalog models per modelKey. */
	byKey: Map<string, ModelInfo[]>;
}

export function indexCatalog(catalog: readonly ModelInfo[], lineage: LineageFn): CatalogIndex {
	const bySelector = new Map<string, ModelInfo>();
	for (const m of catalog) if (!bySelector.has(m.selector)) bySelector.set(m.selector, m);
	const cache = new Map<string, Lineage>();
	const lineageOf = (provider: string, id: string): Lineage => {
		const sel = `${provider}/${id}`;
		let lin = cache.get(sel);
		if (!lin) {
			lin = lineage(provider, id, bySelector.get(sel)?.identity);
			cache.set(sel, lin);
		}
		return lin;
	};
	const byKey = new Map<string, ModelInfo[]>();
	for (const m of bySelector.values()) {
		const key = lineageOf(m.provider, m.id).modelKey;
		const list = byKey.get(key);
		if (list) list.push(m);
		else byKey.set(key, [m]);
	}
	return { bySelector, lineageOf, byKey };
}

function emptyTiers(): Record<Tier | "unknown", LineageUsage[]> {
	return { cheap: [], general: [], premium: [], unknown: [] };
}

export function analyze(input: AnalyzeInput): Analysis {
	const { usage, now } = input;
	const idx = indexCatalog(input.catalog, input.lineage);
	const quotaBy = new Map(input.quota.map(q => [q.provider, q]));

	// Group rows by seat and lineage.
	const groups = new Map<string, Group>();
	const seatTotals: Record<Seat, { requests: number; weighted: number }> = {
		main: { requests: 0, weighted: 0 },
		subagent: { requests: 0, weighted: 0 },
	};
	for (const row of usage.rows) {
		if (row.requests <= 0) continue;
		const lineage = idx.lineageOf(row.provider, row.model);
		const gk = `${row.seat}\u0000${lineage.modelKey}`;
		let g = groups.get(gk);
		if (!g) {
			g = { seat: row.seat, lineage, rows: [], requests: 0, errors: 0, weighted: 0, lastTs: 0 };
			groups.set(gk, g);
		}
		const w = weightedRequests(row, now);
		g.rows.push(row);
		g.requests += row.requests;
		g.errors += row.errors;
		g.weighted += w;
		g.lastTs = Math.max(g.lastTs, row.lastTs);
		seatTotals[row.seat].requests += row.requests;
		seatTotals[row.seat].weighted += w;
	}

	const topModel = (g: Group): ModelInfo | undefined => {
		const sorted = [...g.rows].sort((a, b) => b.requests - a.requests);
		for (const r of sorted) {
			const m = idx.bySelector.get(`${r.provider}/${r.model}`);
			if (m) return m;
		}
		return undefined;
	};

	const preferences: Analysis["preferences"] = { main: emptyTiers(), subagent: emptyTiers() };
	const usages = new Map<Group, LineageUsage>();
	for (const g of groups.values()) {
		const total = seatTotals[g.seat];
		const routes: RouteStats[] = g.rows
			.map(r => {
				const selector = `${r.provider}/${r.model}`;
				return {
					selector,
					provider: r.provider,
					id: r.model,
					requests: r.requests,
					errors: r.errors,
					lastTs: r.lastTs,
					ompTps: r.ompTps,
					decodeTps: r.decodeTps,
					ttftP50: r.ttftP50,
					ttftP90: r.ttftP90,
					costPerRequest: r.requests > r.unpricedRequests ? r.costTotal / r.requests : null,
					available: idx.bySelector.get(selector)?.available === true,
					variant: idx.lineageOf(r.provider, r.model).variant,
				};
			})
			.sort((a, b) => b.requests - a.requests || a.selector.localeCompare(b.selector));
		const tier = input.tiers.get(g.lineage.modelKey)?.tier ?? null;
		const lu: LineageUsage = {
			modelKey: g.lineage.modelKey,
			lineKey: g.lineage.lineKey,
			label: input.label(topModel(g), g.lineage),
			tier,
			seat: g.seat,
			requests: g.requests,
			share: total.requests > 0 ? g.requests / total.requests : 0,
			shareRecent: total.weighted > 0 ? g.weighted / total.weighted : 0,
			errorRate: g.errors / g.requests,
			lastTs: g.lastTs,
			routes,
		};
		usages.set(g, lu);
		preferences[g.seat][tier ?? "unknown"].push(lu);
	}
	for (const seat of ["main", "subagent"] as const) {
		for (const list of Object.values(preferences[seat])) {
			list.sort((a, b) => b.share - a.share || a.modelKey.localeCompare(b.modelKey));
		}
	}

	const availableSelectors = (key: string): string[] =>
		(idx.byKey.get(key) ?? [])
			.filter(m => m.available)
			.map(m => m.selector)
			.sort();

	// Stopped lineages. Idle time counts from the end of the data, so a late stats sync does not make everything look stopped.
	const asOf = usage.dataAsOf ?? now;
	const stopped: StoppedLineage[] = [];
	for (const g of groups.values()) {
		const lu = usages.get(g);
		if (!lu || lu.share < STOP_MIN_SHARE || g.lastTs >= asOf - STOP_IDLE_MS) continue;
		const reasons: string[] = [];
		for (const route of lu.routes) {
			if (!route.available) reasons.push(`route-unavailable:${route.selector}`);
		}
		const providers = [...new Set(lu.routes.map(r => r.provider))].sort();
		for (const p of providers) {
			if (quotaBy.get(p)?.state === "exhausted") reasons.push(`quota-exhausted:${p}`);
		}
		if (errorRateRose(g.rows, g.lastTs)) reasons.push("error-rate-up");
		stopped.push({
			modelKey: lu.modelKey,
			label: lu.label,
			seat: g.seat,
			requests: g.requests,
			lastTs: g.lastTs,
			reasons,
			currentRoutes: availableSelectors(lu.modelKey),
		});
	}
	stopped.sort((a, b) => b.requests - a.requests || a.modelKey.localeCompare(b.modelKey));

	// Newer versions on the same line.
	const newer: NewerVersion[] = [];
	const usedKeys = new Map<string, Lineage>();
	for (const g of groups.values()) usedKeys.set(g.lineage.modelKey, g.lineage);
	for (const from of [...usedKeys.values()].sort((a, b) => a.modelKey.localeCompare(b.modelKey))) {
		if (from.revision === null) continue;
		const fromRevision = from.revision;
		const found = new Map<string, { lineage: Lineage; models: ModelInfo[] }>();
		for (const [key, models] of idx.byKey) {
			if (key === from.modelKey || usedKeys.has(key)) continue;
			const avail = models.filter(m => m.available);
			if (avail.length === 0) continue;
			const first = avail[0];
			if (!first) continue;
			const lin = idx.lineageOf(first.provider, first.id);
			if (lin.lineKey !== from.lineKey || lin.revision === null) continue;
			if (compareRevision(lin.revision, fromRevision) <= 0) continue;
			found.set(key, { lineage: lin, models: avail });
		}
		const sorted = [...found.values()].sort(
			(a, b) => compareRevision(b.lineage.revision ?? "0", a.lineage.revision ?? "0") || a.lineage.modelKey.localeCompare(b.lineage.modelKey),
		);
		for (const { lineage: to, models } of sorted) {
			const routeLineages = models.map(m => idx.lineageOf(m.provider, m.id));
			const allPreview = routeLineages.every(l => l.variant.route === "preview");
			const siblings = idx.byKey.get(to.modelKey) ?? models;
			const ints = [...models].sort((a, b) => a.selector.localeCompare(b.selector)).map(m => input.fillInt(m, siblings, to.modelKey));
			newer.push({
				from: from.modelKey,
				to: to.modelKey,
				selectors: models.map(m => m.selector).sort(),
				needsCheck:
					to.revisionSource === "name" || from.revisionSource === "name" || to.suspect || from.suspect || allPreview,
				int: ints.find(v => v.value !== null) ?? ints[0] ?? { value: null, source: "none", confidence: "low", missingReason: "catalog_no_score" },
			});
		}
	}

	// Alternatives for the most used lineages per seat.
	const alternatives: Record<string, Alternative[]> = {};
	for (const seat of ["subagent", "main"] as const) {
		const seatGroups = [...groups.values()]
			.filter(g => g.seat === seat)
			.sort((a, b) => b.requests - a.requests || a.lineage.modelKey.localeCompare(b.lineage.modelKey))
			.slice(0, ALT_TOP);
		for (const g of seatGroups) {
			const alts = alternativesFor(g, groups, idx, input);
			if (alts.length === 0) continue;
			const existing = alternatives[g.lineage.modelKey] ?? [];
			for (const alt of alts) {
				if (!existing.some(e => e.selector === alt.selector && e.kind === alt.kind)) existing.push(alt);
			}
			alternatives[g.lineage.modelKey] = existing;
		}
	}

	const warnings: string[] = [];
	if (usage.status === "missing-db") warnings.push("사용 이력 DB가 없어 이력 분석을 건너뛰었다.");
	else if (usage.status === "unsupported-schema")
		warnings.push(`사용 이력 DB 형식이 달라 분석을 껐다${usage.detail ? ` (${usage.detail})` : ""}.`);
	else if (usage.status === "error") warnings.push(`사용 이력을 읽지 못했다${usage.detail ? `: ${usage.detail}` : ""}.`);
	else if (usage.dataAsOf === null) warnings.push("사용 이력이 비어 있다.");
	else if (now - usage.dataAsOf > STALE_MS)
		warnings.push(`사용 이력이 ${Math.floor((now - usage.dataAsOf) / 3_600_000)}시간 전 기준이다.`);

	return {
		status: usage.status,
		windowDays: usage.windowDays,
		dataAsOf: usage.dataAsOf,
		preferences,
		stopped,
		newer,
		alternatives,
		warnings,
	};
}

/** Error rate of the last 7 days of use at least doubled versus before, with ≥20 samples on each side. */
function errorRateRose(rows: readonly UsageRow[], lastTs: number): boolean {
	const cutoff = localDate(lastTs - (ERROR_WINDOW_DAYS - 1) * DAY_MS);
	let recentReq = 0;
	let recentErr = 0;
	let priorReq = 0;
	let priorErr = 0;
	for (const row of rows) {
		for (const [day, n] of Object.entries(row.daily)) {
			const e = row.dailyErrors[day] ?? 0;
			if (day >= cutoff) {
				recentReq += n;
				recentErr += e;
			} else {
				priorReq += n;
				priorErr += e;
			}
		}
	}
	if (recentReq < ERROR_MIN_SAMPLES || priorReq < ERROR_MIN_SAMPLES) return false;
	const recentRate = recentErr / recentReq;
	return recentRate > 0 && recentRate >= 2 * (priorErr / priorReq);
}

interface Scored {
	model: ModelInfo;
	lineage: Lineage;
	int: MetricValue;
	speed: MetricValue;
	cost: number | null;
}

function alternativesFor(base: Group, groups: Map<string, Group>, idx: CatalogIndex, input: AnalyzeInput): Alternative[] {
	const mix = mixOf(base.rows);
	const baseKey = base.lineage.modelKey;
	const baseSiblings = idx.byKey.get(baseKey) ?? [];
	const byRequests = [...base.rows].sort((a, b) => b.requests - a.requests);
	let baseModel: ModelInfo | undefined;
	for (const r of byRequests) {
		baseModel = idx.bySelector.get(`${r.provider}/${r.model}`);
		if (baseModel) break;
	}
	let baseInt: number | null = null;
	let baseSpeed: number | null = null;
	let baseCost: number | null = null;
	if (baseModel) {
		baseInt = input.fillInt(baseModel, baseSiblings, baseKey).value;
		baseSpeed = input.fillTps(baseModel, measuredFor(base.rows, baseModel.provider, baseModel.id), baseSiblings).value;
		if (mix) {
			baseCost = mixCost(baseModel, mix);
			if (baseCost === null) {
				// Fall back to the cheapest priced route of the same lineage.
				const priced = baseSiblings.map(m => mixCost(m, mix)).filter((c): c is number => c !== null);
				baseCost = priced.length > 0 ? Math.min(...priced) : null;
			}
		}
	}
	if (baseCost !== null && baseCost <= 0) baseCost = null;

	const seatRows: UsageRow[] = [];
	for (const g of groups.values()) if (g.seat === base.seat) seatRows.push(...g.rows);

	const scored: Scored[] = [];
	for (const [key, models] of idx.byKey) {
		if (key === baseKey) continue;
		for (const model of models) {
			if (!model.available) continue;
			const siblings = models;
			const lin = idx.lineageOf(model.provider, model.id);
			scored.push({
				model,
				lineage: lin,
				int: input.fillInt(model, siblings, key),
				speed: input.fillTps(model, measuredFor(seatRows, model.provider, model.id), siblings),
				cost: mix ? mixCost(model, mix) : null,
			});
		}
	}

	const picks: Record<Alternative["kind"], Array<{ s: Scored; ratio: number | null; why: string; sort: number }>> = {
		better: [],
		cheaper: [],
		faster: [],
		validated: [],
		upgrade: [],
	};
	for (const s of scored) {
		const ratio = baseCost !== null && s.cost !== null ? s.cost / baseCost : null;
		const dq = baseInt !== null && s.int.value !== null ? s.int.value - baseInt : null;
		const speedRatio = baseSpeed !== null && baseSpeed > 0 && s.speed.value !== null ? s.speed.value / baseSpeed : null;
		const fmtQ = (d: number): string => `${d >= 0 ? "+" : ""}${d.toFixed(1)}`;
		if (dq !== null && ratio !== null) {
			if (dq >= 2 && ratio <= 1.5) {
				picks.better.push({ s, ratio, why: `지능 ${fmtQ(dq)}, 비용 ${ratio.toFixed(2)}배`, sort: -dq });
				continue;
			}
			if (dq >= -3 && ratio <= 0.6) {
				picks.cheaper.push({ s, ratio, why: `지능 ${fmtQ(dq)}, 비용 ${ratio.toFixed(2)}배`, sort: ratio });
				continue;
			}
			if (speedRatio !== null && dq >= -1 && ratio <= 1.2 && speedRatio >= 1.5) {
				picks.faster.push({ s, ratio, why: `속도 ${speedRatio.toFixed(1)}배, 비용 ${ratio.toFixed(2)}배`, sort: -speedRatio });
				continue;
			}
			if (dq >= 2 && ratio > 1.5) {
				picks.upgrade.push({ s, ratio, why: `지능 ${fmtQ(dq)}, 비용 ${ratio.toFixed(1)}배`, sort: -dq });
				continue;
			}
		}
		if (s.int.value === null) {
			const used = groups.get(`${base.seat}\u0000${s.lineage.modelKey}`);
			if (used && used.requests >= VALIDATED_MIN_REQUESTS && used.errors / used.requests <= VALIDATED_MAX_ERROR_RATE) {
				const why = `${base.seat}에서 ${used.requests.toLocaleString("en-US")}건, 오류 ${fmtPct(used.errors / used.requests)} — 지능 점수 없음`;
				picks.validated.push({ s, ratio, why, sort: -used.requests });
			}
		}
	}

	const out: Alternative[] = [];
	for (const kind of ["better", "cheaper", "faster", "validated", "upgrade"] as const) {
		const seen = new Set<string>();
		const list = picks[kind].sort((a, b) => a.sort - b.sort || a.s.model.selector.localeCompare(b.s.model.selector));
		for (const p of list) {
			// One route per lineage; the list is already best-first.
			if (seen.has(p.s.lineage.modelKey)) continue;
			seen.add(p.s.lineage.modelKey);
			out.push({
				selector: p.s.model.selector,
				modelKey: p.s.lineage.modelKey,
				label: input.label(p.s.model, p.s.lineage),
				tier: input.tiers.get(p.s.lineage.modelKey)?.tier ?? null,
				kind,
				int: p.s.int,
				speed: p.s.speed,
				costRatio: p.ratio,
				why: p.why,
			});
			if (seen.size >= ALT_PER_KIND) break;
		}
	}
	return out;
}
