import type { TokenMix } from "../lineage/price.ts";
import type { Analysis, Lineage, LineageFn, LineageUsage, ModelInfo, Seat, UsageRow, UsageSnapshot } from "../types.ts";

export interface AnalyzeInput {
	usage: UsageSnapshot;
	catalog: ModelInfo[];
	lineage: LineageFn;
	now: number;
}

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 7;

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

/** Decode tok/s for a route across the given rows, weighted by the requests that fed it. */
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
		if (row.decodeTps !== null && row.decodeSamples > 0) {
			weighted += row.decodeTps * row.decodeSamples;
			samples += row.decodeSamples;
		}
	}
	if (!found) return undefined;
	return { decodeTps: samples > 0 ? weighted / samples : null, samples };
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

interface Group {
	seat: Seat;
	modelKey: string;
	rows: UsageRow[];
	requests: number;
	errors: number;
	weighted: number;
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

/** What the user ran, per seat and lineage: usage of one model through several providers is merged. */
export function analyze(input: AnalyzeInput): Analysis {
	const { usage, now } = input;
	const idx = indexCatalog(input.catalog, input.lineage);

	const groups = new Map<string, Group>();
	const seatTotals: Record<Seat, { requests: number; weighted: number }> = {
		main: { requests: 0, weighted: 0 },
		subagent: { requests: 0, weighted: 0 },
	};
	for (const row of usage.rows) {
		if (row.requests <= 0) continue;
		const modelKey = idx.lineageOf(row.provider, row.model).modelKey;
		const gk = `${row.seat}\u0000${modelKey}`;
		let g = groups.get(gk);
		if (!g) {
			g = { seat: row.seat, modelKey, rows: [], requests: 0, errors: 0, weighted: 0 };
			groups.set(gk, g);
		}
		const w = weightedRequests(row, now);
		g.rows.push(row);
		g.requests += row.requests;
		g.errors += row.errors;
		g.weighted += w;
		seatTotals[row.seat].requests += row.requests;
		seatTotals[row.seat].weighted += w;
	}

	const preferences: Analysis["preferences"] = { main: [], subagent: [] };
	for (const g of groups.values()) {
		const total = seatTotals[g.seat];
		const lu: LineageUsage = {
			modelKey: g.modelKey,
			requests: g.requests,
			share: total.requests > 0 ? g.requests / total.requests : 0,
			shareRecent: total.weighted > 0 ? g.weighted / total.weighted : 0,
			errorRate: g.errors / g.requests,
			routes: g.rows
				.map(r => ({ selector: `${r.provider}/${r.model}`, requests: r.requests, ttftP50: r.ttftP50 }))
				.sort((a, b) => b.requests - a.requests || a.selector.localeCompare(b.selector)),
		};
		preferences[g.seat].push(lu);
	}
	for (const list of Object.values(preferences)) {
		list.sort((a, b) => b.share - a.share || a.modelKey.localeCompare(b.modelKey));
	}

	const warnings: string[] = [];
	if (usage.status === "missing-db") warnings.push("사용 기록 DB가 없어 사용 기록 없이 추천합니다.");
	else if (usage.status === "unsupported-schema")
		warnings.push(`사용 기록 DB 형식이 달라 사용 기록 없이 추천합니다${usage.detail ? ` (${usage.detail})` : ""}.`);
	else if (usage.status === "error") warnings.push(`사용 기록을 읽지 못했습니다${usage.detail ? `: ${usage.detail}` : ""}.`);
	else if (usage.dataAsOf === null) warnings.push("사용 기록이 비어 있습니다.");

	return { windowDays: usage.windowDays, preferences, warnings };
}
