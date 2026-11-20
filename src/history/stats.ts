import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import type { Seat, UsageRow, UsageSnapshot } from "../types.ts";

export const REQUIRED_COLUMNS = [
	"provider",
	"model",
	"agent_type",
	"purpose",
	"folder",
	"timestamp",
	"duration",
	"ttft",
	"stop_reason",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cost_total",
	"cost_unpriced",
] as const;

export const DAY_MS = 86_400_000;

/** omp's stats DB path; follows the active profile when resolved inside the omp host. */
export function statsDbPath(): string {
	return getStatsDbPath();
}

// ── Local dates ──────────────────────────────────────────────────────────────────────────────

/** Local calendar date "YYYY-MM-DD" of a ms timestamp. */
export function localDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** ms timestamp of local midnight starting `date` ("YYYY-MM-DD"). */
export function localDayStart(date: string): number {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(y, m - 1, d).getTime();
}

/** The local date after `date`; goes through Date so DST days stay correct. */
export function nextLocalDate(date: string): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return localDate(new Date(y, m - 1, d + 1).getTime());
}

// ── DB access ────────────────────────────────────────────────────────────────────────────────

export type StatsDbOpen =
	| { ok: true; db: Database }
	| { ok: false; status: "missing-db" | "unsupported-schema" | "error"; detail?: string };

/** Short, data-free description of a failure (sqlite messages can carry paths). */
export function errorDetail(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string" && code) return `sqlite: ${code}`;
	return err instanceof Error ? `read failed: ${err.name}` : "read failed";
}

/** Opens read-only (no `immutable`, so WAL content is seen) and checks the schema. Caller closes. */
export function openStatsDb(dbPath: string): StatsDbOpen {
	if (!existsSync(dbPath)) return { ok: false, status: "missing-db" };
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		db.run("PRAGMA busy_timeout=5000");
		const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name));
		const missing = REQUIRED_COLUMNS.filter((c) => !cols.has(c));
		if (missing.length > 0) {
			db.close();
			return { ok: false, status: "unsupported-schema", detail: missing.join(", ") };
		}
		return { ok: true, db };
	} catch (err) {
		db?.close();
		return { ok: false, status: "error", detail: errorDetail(err) };
	}
}

export function queryDataAsOf(db: Database): number | null {
	const row = db.query<{ t: number | null }, []>("SELECT MAX(timestamp) AS t FROM messages").get();
	return row?.t ?? null;
}

export interface MessageRow {
	provider: string;
	model: string;
	agent_type: string | null;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stop_reason: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost_total: number;
	cost_unpriced: number;
}

/** Visits `purpose IS NULL` rows with from ≤ timestamp ≤ to (inclusive). */
export function forEachMessage(db: Database, from: number, to: number, fn: (row: MessageRow) => void): void {
	const stmt = db.query<MessageRow, [number, number]>(
		`SELECT provider, model, agent_type, timestamp, duration, ttft, stop_reason,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, cost_unpriced
		FROM messages
		WHERE purpose IS NULL AND timestamp >= ? AND timestamp <= ?`,
	);
	try {
		for (const row of stmt.iterate(from, to)) fn(row);
	} finally {
		stmt.finalize();
	}
}

export function groupKey(provider: string, model: string, seat: Seat): string {
	return `${provider}\u0000${model}\u0000${seat}`;
}

// ── Aggregation ──────────────────────────────────────────────────────────────────────────────

/** [value, count]; used for histogram-approximated samples from archived days. */
export type WeightedSample = [number, number];

export interface UsageAcc {
	provider: string;
	model: string;
	seat: Seat;
	requests: number;
	errors: number;
	aborted: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costTotal: number;
	unpricedRequests: number;
	ompTpsSum: number;
	ompTpsCount: number;
	decodeOutputTokens: number;
	decodeMs: number;
	ttft: number[];
	duration: number[];
	ttftWeighted: WeightedSample[];
	durationWeighted: WeightedSample[];
	firstTs: number;
	lastTs: number;
	daily: Record<string, number>;
	dailyErrors: Record<string, number>;
}

export function newAcc(provider: string, model: string, seat: Seat): UsageAcc {
	return {
		provider,
		model,
		seat,
		requests: 0,
		errors: 0,
		aborted: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costTotal: 0,
		unpricedRequests: 0,
		ompTpsSum: 0,
		ompTpsCount: 0,
		decodeOutputTokens: 0,
		decodeMs: 0,
		ttft: [],
		duration: [],
		ttftWeighted: [],
		durationWeighted: [],
		firstTs: Number.POSITIVE_INFINITY,
		lastTs: Number.NEGATIVE_INFINITY,
		daily: {},
		dailyErrors: {},
	};
}

/** Adds `row` to the (provider, model, seat) accumulator in `groups`, creating it on first use. */
export function addMessage(groups: Map<string, UsageAcc>, row: MessageRow): void {
	const seat: Seat = row.agent_type === "subagent" ? "subagent" : "main";
	const key = groupKey(row.provider, row.model, seat);
	let acc = groups.get(key);
	if (!acc) {
		acc = newAcc(row.provider, row.model, seat);
		groups.set(key, acc);
	}
	const output = row.output_tokens ?? 0;
	const tokens = (row.input_tokens ?? 0) + output + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0);
	const cost = row.cost_total ?? 0;
	acc.requests++;
	if (row.stop_reason === "error") acc.errors++;
	if (row.stop_reason === "aborted") acc.aborted++;
	acc.inputTokens += row.input_tokens ?? 0;
	acc.outputTokens += output;
	acc.cacheReadTokens += row.cache_read_tokens ?? 0;
	acc.cacheWriteTokens += row.cache_write_tokens ?? 0;
	acc.costTotal += cost;
	// Mirrors omp's unpricedRequestSql (total_tokens approximated by the four token columns).
	if (tokens > 0 && cost === 0 && (row.provider === "xai-oauth" || row.cost_unpriced === 1)) acc.unpricedRequests++;
	const { duration, ttft } = row;
	if (duration !== null && duration > 0 && output > 0) {
		acc.ompTpsSum += (output * 1000) / duration;
		acc.ompTpsCount++;
	}
	if (duration !== null && ttft !== null && duration > ttft) {
		acc.decodeOutputTokens += output;
		acc.decodeMs += duration - ttft;
	}
	if (ttft !== null) acc.ttft.push(ttft);
	if (duration !== null) acc.duration.push(duration);
	if (row.timestamp < acc.firstTs) acc.firstTs = row.timestamp;
	if (row.timestamp > acc.lastTs) acc.lastTs = row.timestamp;
	const date = localDate(row.timestamp);
	acc.daily[date] = (acc.daily[date] ?? 0) + 1;
	if (row.stop_reason === "error") acc.dailyErrors[date] = (acc.dailyErrors[date] ?? 0) + 1;
}

/** Rank index (0-based) of the q-quantile among n sorted samples: the ceil(q*n)-th value. */
function rankIndex(q: number, n: number): number {
	// Epsilon keeps 0.9*n products like 9.000000000000002 from rounding up a rank.
	return Math.min(n, Math.max(1, Math.ceil(q * n - 1e-9))) - 1;
}

/** Quantile over exact samples plus weighted (approximate) samples; null when empty. */
export function quantile(exact: number[], weighted: WeightedSample[], q: number): number | null {
	if (weighted.length === 0) {
		if (exact.length === 0) return null;
		const sorted = exact.slice().sort((a, b) => a - b);
		return sorted[rankIndex(q, sorted.length)] ?? null;
	}
	const all: WeightedSample[] = weighted.slice();
	for (const v of exact) all.push([v, 1]);
	all.sort((a, b) => a[0] - b[0]);
	let n = 0;
	for (const [, c] of all) n += c;
	if (n === 0) return null;
	const target = rankIndex(q, n) + 1;
	let seen = 0;
	for (const [v, c] of all) {
		seen += c;
		if (seen >= target) return v;
	}
	return null;
}

function sampleCount(exact: number[], weighted: WeightedSample[]): number {
	let n = exact.length;
	for (const [, c] of weighted) n += c;
	return n;
}

export function finalizeAcc(acc: UsageAcc): UsageRow {
	return {
		provider: acc.provider,
		model: acc.model,
		seat: acc.seat,
		requests: acc.requests,
		errors: acc.errors,
		aborted: acc.aborted,
		inputTokens: acc.inputTokens,
		outputTokens: acc.outputTokens,
		cacheReadTokens: acc.cacheReadTokens,
		cacheWriteTokens: acc.cacheWriteTokens,
		costTotal: acc.costTotal,
		unpricedRequests: acc.unpricedRequests,
		ompTps: acc.ompTpsCount > 0 ? acc.ompTpsSum / acc.ompTpsCount : null,
		decodeTps: acc.decodeMs > 0 ? (acc.decodeOutputTokens * 1000) / acc.decodeMs : null,
		ttftP50: quantile(acc.ttft, acc.ttftWeighted, 0.5),
		ttftP90: quantile(acc.ttft, acc.ttftWeighted, 0.9),
		ttftSamples: sampleCount(acc.ttft, acc.ttftWeighted),
		durationP50: quantile(acc.duration, acc.durationWeighted, 0.5),
		durationP90: quantile(acc.duration, acc.durationWeighted, 0.9),
		durationSamples: sampleCount(acc.duration, acc.durationWeighted),
		firstTs: acc.firstTs,
		lastTs: acc.lastTs,
		daily: acc.daily,
		dailyErrors: acc.dailyErrors,
	};
}

export function finalizeGroups(groups: Map<string, UsageAcc>): UsageRow[] {
	const rows: UsageRow[] = [];
	for (const acc of groups.values()) if (acc.requests > 0) rows.push(finalizeAcc(acc));
	rows.sort(
		(a, b) =>
			b.requests - a.requests ||
			a.provider.localeCompare(b.provider) ||
			a.model.localeCompare(b.model) ||
			a.seat.localeCompare(b.seat),
	);
	return rows;
}

// ── Public reads ─────────────────────────────────────────────────────────────────────────────

export interface UsageCollect {
	snapshot: UsageSnapshot;
	groups: Map<string, UsageAcc>;
}

/** Raw accumulators for the window; `snapshot.rows` is left empty. */
export function collectUsage(opts: { dbPath: string; windowDays: number; now?: number }): UsageCollect {
	const now = opts.now ?? Date.now();
	const base = { dbPath: opts.dbPath, windowDays: opts.windowDays, now, dataAsOf: null, rows: [] };
	const groups = new Map<string, UsageAcc>();
	const opened = openStatsDb(opts.dbPath);
	if (!opened.ok) {
		const snapshot: UsageSnapshot = { ...base, status: opened.status };
		if (opened.detail !== undefined) snapshot.detail = opened.detail;
		return { snapshot, groups };
	}
	const { db } = opened;
	try {
		const from = now - opts.windowDays * DAY_MS;
		// One deferred read transaction so dataAsOf and rows come from the same snapshot.
		const dataAsOf = db.transaction(() => {
			forEachMessage(db, from, now, (row) => addMessage(groups, row));
			return queryDataAsOf(db);
		})();
		return { snapshot: { ...base, status: "ok", dataAsOf }, groups };
	} catch (err) {
		groups.clear();
		return { snapshot: { ...base, status: "error", detail: errorDetail(err) }, groups };
	} finally {
		db.close();
	}
}

/** Per (provider, model, seat) usage over [now - windowDays, now], excluding `purpose` side calls. */
export function readUsage(opts: { dbPath: string; windowDays: number; now?: number }): UsageSnapshot {
	const { snapshot, groups } = collectUsage(opts);
	return { ...snapshot, rows: finalizeGroups(groups) };
}
