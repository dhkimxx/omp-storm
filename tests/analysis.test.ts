import { describe, expect, test } from "bun:test";
import { analyze, measuredFor, mixOf } from "../src/analysis/analyze.ts";
import type { Lineage, LineageFn, ModelInfo, Seat, UsageRow, UsageSnapshot } from "../src/types.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 20, 12).getTime();

// Fake lineage: wire ids look like "<cls>-<tier>-<rev>[-<route>]".
const lineage: LineageFn = (_provider, wireId) => {
	const [cls = "x", tier = "-", rev, route] = wireId.split("-");
	const lin: Lineage = {
		modelKey: `${cls}/${tier}@${rev ?? "?"}`,
		lineKey: `${cls}/${tier}`,
		cls,
		tier,
		revision: rev ?? null,
		revisionSource: rev ? "identity" : null,
		suspect: false,
		variant: route ? { route } : {},
	};
	return lin;
};

function model(provider: string, id: string): ModelInfo {
	return {
		provider,
		id,
		selector: `${provider}/${id}`,
		name: id,
		identity: { class: id.split("-")[0] ?? "x" },
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
		pricingKnown: true,
		contextWindow: 200_000,
		efforts: ["low", "medium", "high"],
		supportsTools: true,
		int: null,
		tps: null,
		available: true,
	};
}

function row(provider: string, id: string, opts: Partial<UsageRow> & { daysAgo?: number } = {}): UsageRow {
	const { daysAgo = 1, ...rest } = opts;
	const requests = rest.requests ?? 100;
	const d = new Date(NOW - daysAgo * DAY);
	const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	return {
		provider,
		model: id,
		seat: "subagent",
		requests,
		errors: 0,
		inputTokens: 4000 * requests,
		outputTokens: 1000 * requests,
		cacheReadTokens: 50_000 * requests,
		cacheWriteTokens: 1000 * requests,
		costTotal: requests * 0.01,
		unpricedRequests: 0,
		ompTps: null,
		decodeTps: null,
		decodeSamples: 0,
		ttftP50: null,
		daily: { [day]: requests },
		...rest,
	};
}

function run(catalog: ModelInfo[], rows: UsageRow[], usage: Partial<UsageSnapshot> = {}) {
	return analyze({ usage: { status: "ok", windowDays: 30, dataAsOf: NOW - 3600_000, rows, ...usage }, catalog, lineage, now: NOW });
}

describe("analyze preferences", () => {
	test("merges one lineage used through several providers and keeps each route's own count", () => {
		const catalog = [model("pa", "deep-flash-4.1"), model("pb", "deep-flash-4.1"), model("pc", "deep-flash-4.1-fast")];
		const rows = [
			row("pb", "deep-flash-4.1", { requests: 30, errors: 3, ttftP50: 800 }),
			row("pa", "deep-flash-4.1", { requests: 60 }),
			row("pc", "deep-flash-4.1-fast", { requests: 10 }),
		];
		const a = run(catalog, rows);
		expect(a.windowDays).toBe(30);
		expect(a.preferences.subagent).toEqual([
			{
				modelKey: "deep/flash@4.1",
				requests: 100,
				share: 1,
				shareRecent: 1,
				errorRate: 0.03,
				routes: [
					{ selector: "pa/deep-flash-4.1", requests: 60, ttftP50: null },
					{ selector: "pb/deep-flash-4.1", requests: 30, ttftP50: 800 },
					{ selector: "pc/deep-flash-4.1-fast", requests: 10, ttftP50: null },
				],
			},
		]);
		expect(a.preferences.main).toEqual([]);
	});

	test("seats are counted apart and lists are sorted by share", () => {
		const seat = (s: Seat) => ({ seat: s });
		const rows = [
			row("pa", "big-opus-5", { requests: 1000, ...seat("main") }),
			row("pa", "deep-flash-4.1", { requests: 200 }),
			row("pa", "big-opus-5", { requests: 600 }),
		];
		const a = run([model("pa", "big-opus-5"), model("pa", "deep-flash-4.1")], rows);
		expect(a.preferences.subagent.map(l => [l.modelKey, l.share])).toEqual([
			["big/opus@5", 0.75],
			["deep/flash@4.1", 0.25],
		]);
		expect(a.preferences.main.map(l => [l.modelKey, l.share])).toEqual([["big/opus@5", 1]]);
	});

	test("recent share decays old usage", () => {
		const rows = [row("pa", "old-mini-1", { daysAgo: 21 }), row("pa", "new-mini-1", { daysAgo: 1 })];
		const byKey = Object.fromEntries(run([model("pa", "old-mini-1"), model("pa", "new-mini-1")], rows).preferences.subagent.map(l => [l.modelKey, l]));
		expect(byKey["old/mini@1"]?.share).toBeCloseTo(0.5);
		expect(byKey["new/mini@1"]?.shareRecent ?? 0).toBeGreaterThan(0.8);
	});

	test("usage of a model the catalog does not list still counts", () => {
		expect(run([], [row("px", "ghost-mini-2")]).preferences.subagent.map(l => l.modelKey)).toEqual(["ghost/mini@2"]);
	});
});

describe("analyze warnings", () => {
	test("only an unreadable or empty history warns; old data alone does not", () => {
		expect(run([], [], { dataAsOf: NOW - 30 * DAY }).warnings).toEqual([]);
		expect(run([], [], { dataAsOf: null }).warnings.length).toBe(1);
		for (const status of ["missing-db", "unsupported-schema", "error"] as const) {
			expect(run([], [], { status, dataAsOf: null }).warnings.length).toBe(1);
		}
	});
});

describe("usage helpers", () => {
	test("mixOf averages tokens per request; undefined without requests", () => {
		expect(mixOf([row("pa", "a-b-1", { requests: 10 }), row("pb", "a-b-1", { requests: 30, inputTokens: 0 })])).toEqual({
			input: 1000,
			output: 1000,
			cacheRead: 50_000,
			cacheWrite: 1000,
		});
		expect(mixOf([])).toBeUndefined();
	});

	test("measuredFor weights a route's speed by the requests that fed it, across seats", () => {
		const rows = [
			row("pa", "a-b-1", { decodeTps: 100, decodeSamples: 30 }),
			row("pa", "a-b-1", { seat: "main", decodeTps: 40, decodeSamples: 10 }),
			row("pb", "a-b-1", { decodeTps: 999, decodeSamples: 50 }),
		];
		expect(measuredFor(rows, "pa", "a-b-1")).toEqual({ decodeTps: 85, samples: 40 });
		expect(measuredFor([row("pa", "a-b-1")], "pa", "a-b-1")).toEqual({ decodeTps: null, samples: 0 });
		expect(measuredFor(rows, "pz", "a-b-1")).toBeUndefined();
	});
});
