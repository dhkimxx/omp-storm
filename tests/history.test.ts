import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDays, readUsageWithArchive } from "../src/history/archive.ts";
import { DAY_MS, localDate, readUsage, REQUIRED_COLUMNS } from "../src/history/stats.ts";
import type { UsageRow } from "../src/types.ts";

const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();
/** Local time `daysAgo` calendar days before NOW's date, at `hour`. */
const at = (daysAgo: number, hour = 12, minute = 0) => new Date(2026, 10, 20 - daysAgo, hour, minute).getTime();

interface Msg {
	provider?: string;
	model?: string;
	agent_type?: string | null;
	purpose?: string | null;
	timestamp: number;
	duration?: number | null;
	ttft?: number | null;
	stop_reason?: string;
	input_tokens?: number;
	output_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	cost_total?: number;
	cost_unpriced?: number;
}

let tmp: string;
let dbPath: string;
let db: Database;
let seq = 0;

function createDb(omit: string[] = []): Database {
	const cols = [
		"id INTEGER PRIMARY KEY AUTOINCREMENT",
		"session_file TEXT NOT NULL",
		"entry_id TEXT NOT NULL",
		"api TEXT NOT NULL DEFAULT 'x'",
		...REQUIRED_COLUMNS.filter((c) => !omit.includes(c)).map((c) =>
			["provider", "model", "agent_type", "purpose", "folder", "stop_reason"].includes(c) ? `${c} TEXT` : `${c} REAL`,
		),
	];
	const d = new Database(dbPath, { create: true });
	d.run(`CREATE TABLE messages (${cols.join(", ")})`);
	return d;
}

function insert(m: Msg): void {
	seq++;
	const row = {
		session_file: "s.jsonl",
		entry_id: `e${seq}`,
		provider: "anthropic",
		model: "claude-a",
		agent_type: "main",
		purpose: null,
		folder: "/f",
		duration: null,
		ttft: null,
		stop_reason: "stop",
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		cost_total: 0,
		cost_unpriced: 0,
		...m,
	};
	const keys = Object.keys(row);
	db.query(`INSERT INTO messages (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
		...(Object.values(row) as (string | number | null)[]),
	);
}

function find(rows: UsageRow[], model: string, seat = "main"): UsageRow {
	const r = rows.find((x) => x.model === model && x.seat === seat);
	if (!r) throw new Error(`no row ${model}/${seat}`);
	return r;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "storm-history-"));
	dbPath = join(tmp, "stats.db");
	seq = 0;
});

afterEach(() => {
	db?.close();
	rmSync(tmp, { recursive: true, force: true });
});

describe("readUsage", () => {
	test("excludes purpose rows, splits seats, counts errors, aborts and unpriced", () => {
		db = createDb();
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
		expect(snap.rows).toHaveLength(2);
		const main = find(snap.rows, "claude-a", "main");
		expect(main).toMatchObject({
			requests: 4,
			errors: 1,
			aborted: 1,
			inputTokens: 10,
			outputTokens: 9,
			cacheReadTokens: 7,
			cacheWriteTokens: 3,
			costTotal: 0.5,
			unpricedRequests: 1,
		});
		expect(find(snap.rows, "claude-a", "subagent")).toMatchObject({ requests: 2, errors: 1, aborted: 0 });
	});

	test("ompTps averages per-request rates; decodeTps divides sums over duration minus ttft", () => {
		db = createDb();
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
	});

	test("tps are null without qualifying rows", () => {
		db = createDb();
		insert({ timestamp: at(1), output_tokens: 10, duration: null, ttft: null });
		const r = find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a");
		expect(r.ompTps).toBeNull();
		expect(r.decodeTps).toBeNull();
		expect(r.ttftP50).toBeNull();
		expect(r.durationSamples).toBe(0);
	});

	test("p50/p90 use the ceil(q*n)-th sorted value and skip NULLs", () => {
		db = createDb();
		for (const v of [7, 3, 10, 1, 9, 2, 8, 5, 4, 6]) insert({ timestamp: at(1), ttft: v, duration: null });
		for (const v of [300, 100, 200]) insert({ timestamp: at(1), ttft: null, duration: v });
		const r = find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a");
		expect([r.ttftP50, r.ttftP90, r.ttftSamples]).toEqual([5, 9, 10]);
		expect([r.durationP50, r.durationP90, r.durationSamples]).toEqual([200, 300, 3]);
	});

	test("daily buckets by local date", () => {
		db = createDb();
		insert({ timestamp: at(2, 23, 30) });
		insert({ timestamp: at(1, 0, 30), stop_reason: "error" });
		insert({ timestamp: at(1, 0, 40) });
		const r = find(readUsage({ dbPath, windowDays: 30, now: NOW }).rows, "claude-a");
		expect(r.daily).toEqual({ [localDate(at(2))]: 1, [localDate(at(1))]: 2 });
		expect(r.dailyErrors).toEqual({ [localDate(at(1))]: 1 });
	});

	test("window is inclusive at both ends; dataAsOf is the DB-wide max", () => {
		db = createDb();
		const from = NOW - 7 * DAY_MS;
		insert({ timestamp: from - 1 });
		insert({ timestamp: from });
		insert({ timestamp: NOW });
		insert({ timestamp: NOW + 1 });
		insert({ timestamp: NOW + 5, purpose: "title" });
		const snap = readUsage({ dbPath, windowDays: 7, now: NOW });
		const r = find(snap.rows, "claude-a");
		expect(r.requests).toBe(2);
		expect([r.firstTs, r.lastTs]).toEqual([from, NOW]);
		expect(snap.dataAsOf).toBe(NOW + 5);
	});

	test("missing DB and missing column are reported, not thrown", () => {
		expect(readUsage({ dbPath, windowDays: 30, now: NOW })).toMatchObject({ status: "missing-db", rows: [] });
		db = createDb(["ttft"]);
		const snap = readUsage({ dbPath, windowDays: 30, now: NOW });
		expect(snap.status).toBe("unsupported-schema");
		expect(snap.detail).toBe("ttft");
		expect(snap.rows).toEqual([]);
	});

	test("empty DB is ok with null dataAsOf", () => {
		db = createDb();
		expect(readUsage({ dbPath, windowDays: 30, now: NOW })).toMatchObject({ status: "ok", dataAsOf: null, rows: [] });
	});
});

describe("archive", () => {
	const dir = () => join(tmp, "usage");
	const file = (daysAgo: number) => join(dir(), `${localDate(at(daysAgo))}.json`);

	test("writes past days once, skipping today and the dataAsOf day", () => {
		db = createDb();
		insert({ timestamp: at(3) });
		insert({ timestamp: at(2) });
		insert({ timestamp: at(1) });

		expect(archiveDays({ dbPath, dir: dir(), now: NOW }).written).toEqual([file(3), file(2)]);
		const before = readFileSync(file(2), "utf8");

		insert({ timestamp: at(2) });
		insert({ timestamp: at(0) });
		// Day 1 is complete now that dataAsOf moved to today; day 2 stays as first written.
		expect(archiveDays({ dbPath, dir: dir(), now: NOW }).written).toEqual([file(1)]);
		expect(readFileSync(file(2), "utf8")).toBe(before);
		expect(existsSync(file(0))).toBe(false);
	});

	test("prunes files older than keepDays and never writes them", () => {
		db = createDb();
		insert({ timestamp: at(200) });
		insert({ timestamp: at(50) });
		insert({ timestamp: at(1) });
		mkdirSync(dir(), { recursive: true });
		writeFileSync(file(130), "{}");
		writeFileSync(file(119), "{}");

		expect(archiveDays({ dbPath, dir: dir(), now: NOW, keepDays: 120 }).written).toEqual([file(50)]);
		expect(existsSync(file(130))).toBe(false);
		expect(existsSync(file(119))).toBe(true);
		expect(existsSync(file(200))).toBe(false);
	});

	test("fills days pruned from the DB; partially pruned days keep DB values", () => {
		db = createDb();
		const ttfts = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200];
		ttfts.forEach((t, i) =>
			insert({
				timestamp: at(40, 10, i),
				ttft: t,
				duration: t * 2,
				output_tokens: 100,
				input_tokens: 5,
				cost_total: 0.25,
				stop_reason: i === 0 ? "error" : "stop",
			}),
		);
		insert({ timestamp: at(40), agent_type: "subagent", model: "claude-b", output_tokens: 10, duration: 100, ttft: 50 });
		insert({ timestamp: at(35, 9) });
		insert({ timestamp: at(35, 10) });
		insert({ timestamp: at(1) });
		const full = readUsage({ dbPath, windowDays: 90, now: NOW });
		archiveDays({ dbPath, dir: dir(), now: NOW });

		// Simulate `omp gc --apply`: day 40 fully gone, day 35 partly gone.
		db.run("DELETE FROM messages WHERE timestamp < ?", [at(39)]);
		db.run("DELETE FROM messages WHERE timestamp = ?", [at(35, 10)]);

		const merged = readUsageWithArchive({ dbPath, dir: dir(), windowDays: 90, now: NOW });
		expect(merged.status).toBe("ok");
		expect(merged.detail).toBe("archived days: 1");
		const a = find(merged.rows, "claude-a");
		const fa = find(full.rows, "claude-a");
		expect(a.requests).toBe(fa.requests - 1);
		expect(a.daily).toEqual({ ...fa.daily, [localDate(at(35))]: 1 });
		expect(a.dailyErrors).toEqual(fa.dailyErrors);
		expect([a.errors, a.inputTokens, a.outputTokens, a.firstTs]).toEqual([
			fa.errors,
			fa.inputTokens,
			fa.outputTokens,
			fa.firstTs,
		]);
		expect(a.costTotal).toBeCloseTo(fa.costTotal, 9);
		expect(a.ompTps).toBeCloseTo(fa.ompTps ?? Number.NaN, 9);
		expect(a.decodeTps).toBeCloseTo(fa.decodeTps ?? Number.NaN, 9);
		expect(a.ttftSamples).toBe(fa.ttftSamples);
		for (const [got, exact] of [
			[a.ttftP50, fa.ttftP50],
			[a.ttftP90, fa.ttftP90],
			[a.durationP90, fa.durationP90],
		] as const) {
			expect(Math.abs((got ?? 0) / (exact ?? 1) - 1)).toBeLessThan(0.06);
		}
		expect(find(merged.rows, "claude-b", "subagent")).toMatchObject({ requests: 1, decodeTps: 200 });

		const short = readUsageWithArchive({ dbPath, dir: dir(), windowDays: 30, now: NOW });
		expect(short.detail).toBeUndefined();
		expect(short.rows.find((r) => r.model === "claude-b")).toBeUndefined();
	});
});
