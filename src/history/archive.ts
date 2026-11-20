import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Seat, UsageSnapshot } from "../types.ts";
import {
	type UsageAcc,
	addMessage,
	collectUsage,
	DAY_MS,
	finalizeGroups,
	forEachMessage,
	groupKey,
	localDate,
	localDayStart,
	newAcc,
	nextLocalDate,
	openStatsDb,
	queryDataAsOf,
} from "./stats.ts";

// Daily usage archive so 90-day windows survive `omp gc --apply` pruning stats rows older than 30 days (plan 9.1).

const ARCHIVE_VERSION = 1;
const DEFAULT_KEEP_DAYS = 120;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/** Log-scale buckets: 8 per doubling (~9% wide), so histogram quantiles land within ~5% of exact. */
const BUCKETS_PER_DOUBLING = 8;

function bucketOf(ms: number): number {
	return ms <= 1 ? 0 : Math.ceil(Math.log2(ms) * BUCKETS_PER_DOUBLING);
}

/** Geometric midpoint of bucket `b`, used as the representative value. */
function bucketValue(b: number): number {
	return b <= 0 ? 0 : 2 ** ((b - 0.5) / BUCKETS_PER_DOUBLING);
}

function histogram(values: number[]): Record<string, number> {
	const h: Record<string, number> = {};
	for (const v of values) {
		const b = String(bucketOf(v));
		h[b] = (h[b] ?? 0) + 1;
	}
	return h;
}

interface ArchivedGroup {
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
	firstTs: number;
	lastTs: number;
	/** Bucket index → count; see bucketOf. */
	ttftHist: Record<string, number>;
	durationHist: Record<string, number>;
}

interface ArchiveDay {
	version: number;
	date: string;
	rows: ArchivedGroup[];
}

function toArchived(acc: UsageAcc): ArchivedGroup {
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
		ompTpsSum: acc.ompTpsSum,
		ompTpsCount: acc.ompTpsCount,
		decodeOutputTokens: acc.decodeOutputTokens,
		decodeMs: acc.decodeMs,
		firstTs: acc.firstTs,
		lastTs: acc.lastTs,
		ttftHist: histogram(acc.ttft),
		durationHist: histogram(acc.duration),
	};
}

function writeAtomic(file: string, content: string): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, content);
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

function pruneOld(dir: string, cutoff: string): void {
	for (const name of readdirSync(dir)) {
		const m = FILE_RE.exec(name);
		if (m?.[1] !== undefined && m[1] < cutoff) unlinkSync(join(dir, name));
	}
}

/**
 * Writes `<dir>/<date>.json` for each past local date that has usage and no file yet,
 * skipping today and the dataAsOf day (both may still grow). Existing files are never rewritten.
 * Files older than keepDays are removed. DB problems yield no writes; filesystem errors throw.
 */
export function archiveDays(opts: { dbPath: string; dir: string; now?: number; keepDays?: number }): {
	written: string[];
} {
	const now = opts.now ?? Date.now();
	const keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS;
	const cutoff = localDate(now - keepDays * DAY_MS);
	mkdirSync(opts.dir, { recursive: true });
	pruneOld(opts.dir, cutoff);

	const opened = openStatsDb(opts.dbPath);
	if (!opened.ok) return { written: [] };
	const { db } = opened;
	const byDate = new Map<string, Map<string, UsageAcc>>();
	try {
		db.transaction(() => {
			const dataAsOf = queryDataAsOf(db);
			if (dataAsOf === null) return;
			const today = localDate(now);
			const asOfDay = localDate(dataAsOf);
			const end = asOfDay < today ? asOfDay : today;
			const missing: string[] = [];
			for (let d = cutoff; d < end; d = nextLocalDate(d)) {
				if (!existsSync(join(opts.dir, `${d}.json`))) missing.push(d);
			}
			const first = missing[0];
			const last = missing[missing.length - 1];
			if (first === undefined || last === undefined) return;
			const wanted = new Set(missing);
			forEachMessage(db, localDayStart(first), localDayStart(nextLocalDate(last)) - 1, (row) => {
				const date = localDate(row.timestamp);
				if (!wanted.has(date)) return;
				let groups = byDate.get(date);
				if (!groups) {
					groups = new Map();
					byDate.set(date, groups);
				}
				addMessage(groups, row);
			});
		})();
	} catch {
		return { written: [] };
	} finally {
		db.close();
	}

	const written: string[] = [];
	for (const date of [...byDate.keys()].sort()) {
		const groups = byDate.get(date);
		if (!groups) continue;
		const day: ArchiveDay = { version: ARCHIVE_VERSION, date, rows: [...groups.values()].map(toArchived) };
		const file = join(opts.dir, `${date}.json`);
		if (existsSync(file)) continue;
		writeAtomic(file, `${JSON.stringify(day)}\n`);
		written.push(file);
	}
	return { written };
}

function readDay(file: string, date: string): ArchiveDay | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ArchiveDay> | null;
		if (parsed?.version !== ARCHIVE_VERSION || parsed.date !== date || !Array.isArray(parsed.rows)) return undefined;
		return parsed as ArchiveDay;
	} catch {
		// A corrupt or half-written file is ignored rather than failing the whole read.
		return undefined;
	}
}

function mergeArchived(groups: Map<string, UsageAcc>, date: string, g: ArchivedGroup): void {
	const key = groupKey(g.provider, g.model, g.seat);
	let acc = groups.get(key);
	if (!acc) {
		acc = newAcc(g.provider, g.model, g.seat);
		groups.set(key, acc);
	}
	acc.requests += g.requests;
	acc.errors += g.errors;
	acc.aborted += g.aborted;
	acc.inputTokens += g.inputTokens;
	acc.outputTokens += g.outputTokens;
	acc.cacheReadTokens += g.cacheReadTokens;
	acc.cacheWriteTokens += g.cacheWriteTokens;
	acc.costTotal += g.costTotal;
	acc.unpricedRequests += g.unpricedRequests;
	acc.ompTpsSum += g.ompTpsSum;
	acc.ompTpsCount += g.ompTpsCount;
	acc.decodeOutputTokens += g.decodeOutputTokens;
	acc.decodeMs += g.decodeMs;
	for (const [b, c] of Object.entries(g.ttftHist)) acc.ttftWeighted.push([bucketValue(Number(b)), c]);
	for (const [b, c] of Object.entries(g.durationHist)) acc.durationWeighted.push([bucketValue(Number(b)), c]);
	if (g.firstTs < acc.firstTs) acc.firstTs = g.firstTs;
	if (g.lastTs > acc.lastTs) acc.lastTs = g.lastTs;
	if (g.requests > 0) acc.daily[date] = (acc.daily[date] ?? 0) + g.requests;
	if (g.errors > 0) acc.dailyErrors[date] = (acc.dailyErrors[date] ?? 0) + g.errors;
}

/**
 * readUsage plus archived days inside the window that have no DB rows left (pruned by gc).
 * A date with any remaining DB row uses DB values only. Archived days are taken whole, so the
 * window's first (partial) local day counts fully when it comes from the archive.
 */
export function readUsageWithArchive(opts: {
	dbPath: string;
	dir: string;
	windowDays: number;
	now?: number;
}): UsageSnapshot {
	const { snapshot, groups } = collectUsage(opts);
	if (snapshot.status !== "ok") return { ...snapshot, rows: finalizeGroups(groups) };
	const dbDates = new Set<string>();
	for (const acc of groups.values()) for (const d of Object.keys(acc.daily)) dbDates.add(d);

	let archived = 0;
	if (existsSync(opts.dir)) {
		const first = localDate(snapshot.now - opts.windowDays * DAY_MS);
		const last = localDate(snapshot.now);
		for (const name of readdirSync(opts.dir).sort()) {
			const date = FILE_RE.exec(name)?.[1];
			if (date === undefined || date < first || date > last || dbDates.has(date)) continue;
			const day = readDay(join(opts.dir, name), date);
			if (!day) continue;
			for (const g of day.rows) mergeArchived(groups, date, g);
			archived++;
		}
	}
	const result: UsageSnapshot = { ...snapshot, rows: finalizeGroups(groups) };
	if (archived > 0) result.detail = `archived days: ${archived}`;
	return result;
}
