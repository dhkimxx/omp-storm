import { describe, expect, test } from "bun:test";
import { renderModelCheck } from "../src/report/models.ts";
import { compareTrial } from "../src/report/trials.ts";
import type {
	Analysis,
	AnalysisContext,
	Lineage,
	MetricValue,
	ModelInfo,
	StormConfig,
	TrialConfig,
	UsageRow,
	UsageSnapshot,
} from "../src/types.ts";

const NOW = Date.parse("2026-11-20T00:00:00Z");

function model(selector: string, over: Partial<ModelInfo> = {}): ModelInfo {
	const i = selector.indexOf("/");
	return {
		provider: selector.slice(0, i),
		id: selector.slice(i + 1),
		selector,
		name: selector.slice(i + 1).toUpperCase(),
		identity: { class: "x" },
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
		pricingKnown: true,
		contextWindow: 200_000,
		maxTokens: 32_000,
		reasoning: true,
		efforts: ["low", "medium", "high"],
		supportsTools: true,
		int: 50,
		tps: 100,
		available: true,
		...over,
	};
}

/** "<line>-<rev>" ids: lineKey "<line>/-", revision "<rev>". */
function lineage(_provider: string, id: string): Lineage {
	const dash = id.lastIndexOf("-");
	const line = dash < 0 ? id : id.slice(0, dash);
	const revision = dash < 0 ? null : id.slice(dash + 1);
	const lineKey = `${line}/-`;
	return {
		modelKey: `${lineKey}@${revision ?? "?"}`,
		lineKey,
		cls: line,
		tier: "-",
		revision,
		revisionSource: revision ? "name" : null,
		classSource: "stem",
		suspect: false,
		variant: {},
	};
}

const mv = (value: number | null, source = "catalog"): MetricValue => ({ value, source, confidence: "medium" });

function analysis(over: Partial<Analysis> = {}): Analysis {
	return {
		status: "ok",
		windowDays: 30,
		dataAsOf: null,
		preferences: {
			main: { cheap: [], general: [], premium: [], unknown: [] },
			subagent: { cheap: [], general: [], premium: [], unknown: [] },
		},
		newer: [],
		alternatives: {},
		warnings: [],
		...over,
	};
}

function ctxOf(catalog: ModelInfo[], a: Analysis): AnalysisContext {
	return {
		now: NOW,
		catalog,
		available: catalog.filter((m) => m.available),
		quota: [],
		explicit: { modelRoles: {}, agentModelOverrides: {} },
		usage: { status: "ok", dbPath: "", windowDays: 30, now: NOW, dataAsOf: null, rows: [] },
		analysis: a,
		lineage,
		tiers: new Map(),
		warnings: [],
		recommend: () => [],
		checkModel: () => ({ ok: false, reason: "n/a" }),
		detection: () => ({
			providers: [],
			tools: { task: true, eval: true },
			keywords: { workflowz: true, orchestrate: true },
			dataAsOf: null,
			stale: false,
			warnings: [],
		}),
	};
}

const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		implementer: { agent: "storm-implementer", models: ["a/coder-1.0"] },
		reviewer: { agent: "storm-reviewer", models: ["b/judge-2.0"] },
	},
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
	runtime: "omp",
};

describe("renderModelCheck", () => {
	const catalog = [
		model("a/coder-1.0"),
		model("a/coder-1.1", { int: null }),
		model("z/coder-2.0", { available: false, name: "Coder 2" }),
		model("y/coder-2.0", { available: false, name: "Coder 2" }),
		model("z/coder-0.9", { available: false }),
		// Newer revision available on one provider, also sold elsewhere behind a login: not a login item.
		model("a/coder-1.5"),
		model("q/coder-1.5", { available: false }),
		model("b/judge-2.0"),
	];
	const a = analysis({
		newer: [{ from: "coder/-@1.0", to: "coder/-@1.1", selectors: ["a/coder-1.1"], needsCheck: true, int: mv(null) }],
		alternatives: {
			"coder/-@1.0": [
				{ selector: "c/fast", modelKey: "fast/-@?", label: "Fast", tier: "general", kind: "faster", int: mv(null), speed: mv(300, "prior:x"), costRatio: null, why: "" },
				{ selector: "c/cheap", modelKey: "cheap/-@?", label: "Cheap", tier: "cheap", kind: "cheaper", int: mv(51), speed: mv(80, "measured"), costRatio: 0.4, why: "" },
			],
		},
	});
	const text = renderModelCheck(ctxOf(catalog, a), config);

	test("lists newer versions from the analysis and the catalog without duplicates", () => {
		expect(text).toContain("coder/-@1.1 (확인 필요) · 지능 —");
		expect(text).toContain("coder/-@1.5 · 지능 50 · a/coder-1.5");
		expect(text.match(/coder\/-@1\.1/g)?.length).toBe(1);
	});

	test("marks estimated speeds and missing metrics", () => {
		expect(text).toContain("Fast (c/fast) · 더 빠름 · 지능 — · ≈300 tok/s · 비용 —");
		expect(text).toContain("Cheap (c/cheap) · 더 쌈 · 지능 51 · 80 tok/s · 비용 ×0.40");
	});

	test("login-needed upgrades: unavailable, same line, higher revision only", () => {
		expect(text).toContain("Coder 2 · 지능 50 · 로그인 필요: y, z");
		expect(text).not.toContain("q/coder");
		expect(text).not.toContain("로그인 필요: q");
		expect(text).not.toContain("0.9");
	});

	test("roles with nothing better say so, and the report ends with the web-research note", () => {
		const reviewer = text.slice(text.indexOf("### 리뷰"));
		expect(reviewer).toContain("지금 모델보다 나은 선택지를 찾지 못했습니다.");
		expect(text.trimEnd().split("\n").at(-1)).toContain("웹에서 찾아볼 수 있습니다");
	});

	test("without a config it still renders the note", () => {
		const t = renderModelCheck(ctxOf(catalog, a), undefined);
		expect(t).toContain("Storm 설정이 없어");
		expect(t).toContain("웹에서 찾아볼 수 있습니다");
	});
});

function row(provider: string, model: string, over: Partial<UsageRow> = {}): UsageRow {
	return {
		provider,
		model,
		seat: "subagent",
		requests: 10,
		errors: 0,
		aborted: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costTotal: 1,
		unpricedRequests: 0,
		ompTps: null,
		decodeTps: null,
		ttftP50: null,
		ttftP90: null,
		ttftSamples: 0,
		durationP50: null,
		durationP90: null,
		durationSamples: 0,
		firstTs: 0,
		lastTs: 0,
		daily: {},
		dailyErrors: {},
		...over,
	};
}

describe("compareTrial", () => {
	const trial: TrialConfig = {
		id: "t",
		role: "implementer",
		model: "c/cand",
		share: 0.25,
		maxSpawns: 10,
		startsAt: "2026-11-13T00:00:00.000Z",
		endsAt: "2026-11-20T00:00:00.000Z",
		budgetUsd: 2,
	};
	const usage: UsageSnapshot = {
		status: "ok",
		dbPath: "",
		windowDays: 7,
		now: NOW,
		dataAsOf: NOW - 1000,
		rows: [
			row("c", "cand", { requests: 10, errors: 1, ompTps: 100, decodeTps: 120, ttftP50: 500, costTotal: 1 }),
			row("c", "cand", { requests: 30, errors: 1, ompTps: 200, decodeTps: null, ttftP50: 900, costTotal: 2 }),
			row("c", "cand", { seat: "main", requests: 1000, errors: 500, ompTps: 1 }),
			row("a", "prim", { requests: 5, unpricedRequests: 5, costTotal: 0 }),
		],
	};

	test("merges subagent rows by request weight and ignores the main seat", () => {
		const c = compareTrial(trial, "a/prim", usage);
		expect(c.dataAsOf).toBe(NOW - 1000);
		expect(c.candidate).toEqual({
			selector: "c/cand",
			requests: 40,
			errorRate: 2 / 40,
			ompTps: (100 * 10 + 200 * 30) / 40,
			decodeTps: 120,
			ttftP50: (500 * 10 + 900 * 30) / 40,
			costPerRequest: 3 / 40,
		});
	});

	test("null metrics when absent or unpriced; empty side has no rates", () => {
		const c = compareTrial(trial, "a/prim", usage);
		expect(c.current).toEqual({
			selector: "a/prim",
			requests: 5,
			errorRate: 0,
			ompTps: null,
			decodeTps: null,
			ttftP50: null,
			costPerRequest: null,
		});
		const none = compareTrial(trial, "x/none", usage).current;
		expect(none.requests).toBe(0);
		expect(none.errorRate).toBeNull();
		expect(none.costPerRequest).toBeNull();
	});
});
