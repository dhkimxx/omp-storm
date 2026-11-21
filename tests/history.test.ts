import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, readUsage } from "../src/history/stats.ts";
import type { UsageRow } from "../src/types.ts";
import { createStatsDb, insertMessage, type Msg } from "./stats-db.ts";

const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
/** Local time `daysAgo` calendar days before NOW's date, at `hour`. */
const at = (daysAgo: number, hour = 12, minute = 0) => new Date(2026, 10, 20 - daysAgo, hour, minute).getTime();

let tmp: string;
let dbPath: string;
let db: Database | undefined;

const insert = (m: Msg): void => insertMessage(db as Database, m);

function find(rows: UsageRow[], model: string, seat = "main"): UsageRow {
	const r = rows.find((x) => x.model === model && x.seat === seat);
	if (!r) throw new Error(`no row ${model}/${seat}`);
	return r;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "storm-history-"));
	dbPath = join(tmp, "stats.db");
	db = undefined;
});

afterEach(() => {
	db?.close();
	rmSync(tmp, { recursive: true, force: true });
});

describe("readUsage", () => {
	test("excludes purpose rows, splits seats, counts errors and unpriced", () => {
		db = createStatsDb(dbPath);
		insert({ timestamp: at(1), stop_reason: "stop", input_tokens: 10, output_tokens: 5, cost_total: 0.5 });
		insert({ timestamp: at(1), stop_reason: "error", cache_read_tokens: 7, cache_write_tokens: 3 });
		insert({ timestamp: at(1), stop_reason: "aborted", output_tokens: 4, cost_unpriced: 1 });
		insert({ timestamp: at(1), agent_type: null });
		insert({ timestamp: at(1), purpose: "title", output_tokens: 999 });
		insert({ timestamp: at(1), agent_type: "subagent", stop_reason: "error" });
		insert({ timestamp: at(1), agent_type: "subagent" });
		insert({ timestamp: at(1), agent_type: "subagent", purpose: "compaction" });

		const snap = readUsage({ dbPath, windowDays: 30, now: NOW });
		expect(snap.status).toBe("ok");
		expect(snap.windowDays).toBe(30);
		expect(snap.rows).toHaveLength(2);
		expect(find(snap.rows, "claude-a", "main")).toMatchObject({
			requests: 4,
			errors: 1,
			inputTokens: 10,
			outputTokens: 9,
			cacheReadTokens: 7,
			cacheWriteTokens: 3,
			costTotal: 0.5,
			unpricedRequests: 1,
		});
		expect(find(snap.rows, "claude-a", "subagent")).toMatchObject({ requests: 2, errors: 1 });
	});

	test("rows are sorted by requests and keyed by provider, model and seat", () => {
		db = createStatsDb(dbPath);
		insert({ timestamp: at(1), provider: "pb", model: "m" });
		for (let i = 0; i < 3; i++) insert({ timestamp: at(1), provider: "pa", model: "m", agent_type: "subagent" });
		insert({ timestamp: at(1), provider: "pa", model: "m" });
		insert({ timestamp: at(1), provider: "pa", model: "m" });
		expect(readUsage({ dbPath, windowDays: 30, now: NOW }).rows.map((r) => [r.provider, r.seat, r.requests])).toEqual([
			["pa", "subagent", 3],
			["pa", "main", 2],
			["pb", "main", 1],
		]);
	});

	test("ompTps averages per-request rates; decodeTps divides sums over duration minus ttft", () => {
		db = createStatsDb(dbPath);
		insert({ timestamp: at(1), output_tokens: 100, duration: 1000, ttft: 500 });
		insert({ timestamp: at(1), output_tokens: 300, duration: 2000, ttft: 1000 });
		// Excluded from ompTps (no output) but counted by decode (duration > ttft).
		insert({ timestamp: at(1), output_tokens: 0, duration: 1000, ttft: 500 });
		// No ttft: ompTps only.
		insert({ timestamp: at(1), output_tokens: 50, duration: 500, ttft: null });
		// duration <= ttft: neither decode nor (duration 0) ompTps.
		insert({ timestamp: at(1), output_tokens: 10, duration: 0, ttft: 0 });

		const r = find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a");
		expect(r.ompTps).toBeCloseTo((100 + 150 + 100) / 3, 9);
		expect(r.decodeTps).toBeCloseTo((400 * 1000) / 2000, 9);
		expect(r.decodeSamples).toBe(3);
	});

	test("speeds are null without qualifying rows", () => {
		db = createStatsDb(dbPath);
		insert({ timestamp: at(1), output_tokens: 10, duration: null, ttft: null });
		const r = find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a");
		expect([r.ompTps, r.decodeTps, r.decodeSamples, r.ttftP50]).toEqual([null, null, 0, null]);
	});

	test("ttftP50 is the ceil(n/2)-th sorted value and skips NULLs", () => {
		db = createStatsDb(dbPath);
		for (const v of [7, 3, 10, 1, 9, 2, 8, 5, 4, 6]) insert({ timestamp: at(1), ttft: v });
		insert({ timestamp: at(1), ttft: null });
		expect(find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a").ttftP50).toBe(5);
		insert({ timestamp: at(1), ttft: 11 });
		expect(find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a").ttftP50).toBe(6);
	});

	test("daily buckets by local date", () => {
		db = createStatsDb(dbPath);
		insert({ timestamp: at(2, 23, 30) });
		insert({ timestamp: at(1, 0, 30), stop_reason: "error" });
		insert({ timestamp: at(1, 0, 40) });
		const r = find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a");
		expect(r.daily).toEqual({ "2026-11-18": 1, "2026-11-19": 2 });
	});

	test("the window is [now - windowDays, now], inclusive at both ends; dataAsOf is the DB-wide max", () => {
		db = createStatsDb(dbPath);
		const from = NOW - 7 * DAY_MS;
		insert({ timestamp: from - 1 });
		insert({ timestamp: from });
		insert({ timestamp: NOW });
		insert({ timestamp: NOW + 1 });
		insert({ timestamp: NOW + 5, purpose: "title" });
		const snap = readUsage({ dbPath, windowDays: 7, now: NOW });
		expect(find(snap.rows, "claude-a").requests).toBe(2);
		expect(snap.dataAsOf).toBe(NOW + 5);
		// A window ending in the past (a trial's own period) leaves later rows out.
		expect(find(readUsage({ dbPath, windowDays: 1, now: from }).rows, "claude-a").requests).toBe(2);
	});

	test("missing DB and missing column are reported, not thrown", () => {
		expect(readUsage({ dbPath, windowDays: 30, now: NOW })).toEqual({ status: "missing-db", windowDays: 30, dataAsOf: null, rows: [] });
		db = createStatsDb(dbPath, ["ttft"]);
		expect(readUsage({ dbPath, windowDays: 30, now: NOW })).toEqual({
			status: "unsupported-schema",
			detail: "ttft",
			windowDays: 30,
			dataAsOf: null,
			rows: [],
		});
	});

	test("empty DB is ok with null dataAsOf", () => {
		db = createStatsDb(dbPath);
		expect(readUsage({ dbPath, windowDays: 30, now: NOW })).toEqual({ status: "ok", windowDays: 30, dataAsOf: null, rows: [] });
	});
});
