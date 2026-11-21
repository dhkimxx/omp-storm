import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import type { Seat, UsageRow, UsageSnapshot } from "../types.ts";

const REQUIRED_COLUMNS = [
	"provider",
	"model",
	"agent_type",
	"purpose",
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

/** Local calendar date "YYYY-MM-DD" of a ms timestamp. */
function localDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Short, data-free description of a failure (sqlite messages can carry paths). */
function errorDetail(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string" && code) return `sqlite: ${code}`;
	return err instanceof Error ? `read failed: ${err.name}` : "read failed";
}

interface MessageRow {
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

interface UsageAcc {
	row: UsageRow;
	ompTpsSum: number;
	ompTpsCount: number;
	decodeOutputTokens: number;
	decodeMs: number;
	ttft: number[];
}

function addMessage(groups: Map<string, UsageAcc>, msg: MessageRow): void {
	const seat: Seat = msg.agent_type === "subagent" ? "subagent" : "main";
	const key = `${msg.provider}\u0000${msg.model}\u0000${seat}`;
	let acc = groups.get(key);
	if (!acc) {
		acc = {
			row: {
				provider: msg.provider,
				model: msg.model,
				seat,
				requests: 0,
				errors: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costTotal: 0,
				unpricedRequests: 0,
				ompTps: null,
				decodeTps: null,
				decodeSamples: 0,
				ttftP50: null,
				daily: {},
			},
			ompTpsSum: 0,
			ompTpsCount: 0,
			decodeOutputTokens: 0,
			decodeMs: 0,
			ttft: [],
		};
		groups.set(key, acc);
	}
	const { row } = acc;
	const output = msg.output_tokens ?? 0;
	const tokens = (msg.input_tokens ?? 0) + output + (msg.cache_read_tokens ?? 0) + (msg.cache_write_tokens ?? 0);
	const cost = msg.cost_total ?? 0;
	row.requests++;
	if (msg.stop_reason === "error") row.errors++;
	row.inputTokens += msg.input_tokens ?? 0;
	row.outputTokens += output;
	row.cacheReadTokens += msg.cache_read_tokens ?? 0;
	row.cacheWriteTokens += msg.cache_write_tokens ?? 0;
	row.costTotal += cost;
	// Mirrors omp's unpricedRequestSql (total_tokens approximated by the four token columns).
	if (tokens > 0 && cost === 0 && (msg.provider === "xai-oauth" || msg.cost_unpriced === 1)) row.unpricedRequests++;
	const { duration, ttft } = msg;
	if (duration !== null && duration > 0 && output > 0) {
		acc.ompTpsSum += (output * 1000) / duration;
		acc.ompTpsCount++;
	}
	if (duration !== null && ttft !== null && duration > ttft) {
		acc.decodeOutputTokens += output;
		acc.decodeMs += duration - ttft;
		row.decodeSamples++;
	}
	if (ttft !== null) acc.ttft.push(ttft);
	const date = localDate(msg.timestamp);
	row.daily[date] = (row.daily[date] ?? 0) + 1;
}

/** The ceil(n/2)-th sorted value; null when empty. */
function p50(values: number[]): number | null {
	if (values.length === 0) return null;
	values.sort((a, b) => a - b);
	return values[Math.ceil(values.length / 2) - 1] ?? null;
}

function finalize(groups: Map<string, UsageAcc>): UsageRow[] {
	const rows: UsageRow[] = [];
	for (const acc of groups.values()) {
		const { row } = acc;
		row.ompTps = acc.ompTpsCount > 0 ? acc.ompTpsSum / acc.ompTpsCount : null;
		row.decodeTps = acc.decodeMs > 0 ? (acc.decodeOutputTokens * 1000) / acc.decodeMs : null;
		row.ttftP50 = p50(acc.ttft);
		rows.push(row);
	}
	rows.sort(
		(a, b) =>
			b.requests - a.requests ||
			a.provider.localeCompare(b.provider) ||
			a.model.localeCompare(b.model) ||
			a.seat.localeCompare(b.seat),
	);
	return rows;
}

/**
 * Per (provider, model, seat) usage over [now - windowDays, now] (both inclusive), excluding `purpose` side calls.
 * Read straight from omp's stats DB, opened read-only without `immutable` so WAL content is seen.
 */
export function readUsage(opts: { dbPath: string; windowDays: number; now?: number }): UsageSnapshot {
	const now = opts.now ?? Date.now();
	const base = { windowDays: opts.windowDays, dataAsOf: null, rows: [] };
	if (!existsSync(opts.dbPath)) return { ...base, status: "missing-db" };
	let db: Database | undefined;
	try {
		db = new Database(opts.dbPath, { readonly: true });
		db.run("PRAGMA busy_timeout=5000");
		const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name));
		const missing = REQUIRED_COLUMNS.filter((c) => !cols.has(c));
		if (missing.length > 0) return { ...base, status: "unsupported-schema", detail: missing.join(", ") };
		const opened = db;
		const groups = new Map<string, UsageAcc>();
		// One deferred read transaction so dataAsOf and rows come from the same snapshot.
		const dataAsOf = opened.transaction(() => {
			const stmt = opened.query<MessageRow, [number, number]>(
				`SELECT provider, model, agent_type, timestamp, duration, ttft, stop_reason,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, cost_unpriced
				FROM messages
				WHERE purpose IS NULL AND timestamp >= ? AND timestamp <= ?`,
			);
			try {
				for (const row of stmt.iterate(now - opts.windowDays * DAY_MS, now)) addMessage(groups, row);
			} finally {
				stmt.finalize();
			}
			return opened.query<{ t: number | null }, []>("SELECT MAX(timestamp) AS t FROM messages").get()?.t ?? null;
		})();
		return { ...base, status: "ok", dataAsOf, rows: finalize(groups) };
	} catch (err) {
		return { ...base, status: "error", detail: errorDetail(err) };
	} finally {
		db?.close();
	}
}
