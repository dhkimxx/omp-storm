import { describe, expect, test } from "bun:test";
import { recommend } from "../src/recommend/recommend.ts";
import { renderModelCheck } from "../src/report/models.ts";
import { compareTrial } from "../src/report/trials.ts";
import type { AnalysisContext, ModelInfo, StormConfig, TrialConfig, UsageRow, UsageSnapshot } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";
import { COST, model, NOW, row as usageRow, setup, type SetupOptions } from "./rank-fixture.ts";

/** A context whose `recommend` is the real ranker over the fixture catalog. */
function ctxOf(catalog: ModelInfo[], opts: SetupOptions = {}): AnalysisContext {
	const base = setup(catalog, opts);
	return {
		now: NOW,
		catalog,
		available: catalog.filter((m) => m.available),
		explicit: { modelRoles: {} },
		usage: base.usage,
		analysis: base.analysis,
		recommend: (priority, current) => recommend({ ...base, priority, ...(current ? { current } : {}) }),
		checkModel: () => ({ ok: false, reason: "n/a" }),
		detection: () => ({ providers: [], tools: { task: true, eval: true }, warnings: [] }),
	};
}

const team = (roles: Record<string, string>, priority: StormConfig["priority"] = "balanced"): StormConfig => teamOf(roles, { priority });

/** The report's section for the role whose primary is `selector`, and the selectors it lists as "  - Label (selector)" items. */
function section(text: string, selector: string): { body: string; listed: string[] } {
	const body = text.split("### ").find((part) => part.split("\n")[0]?.includes(`(${selector})`));
	if (body === undefined) throw new Error(`no section for ${selector}`);
	const listed = [...body.matchAll(/^ {2}- .*?\(([a-z]+\/[a-z0-9.-]+)\)/gm)].map((match) => match[1] ?? "");
	return { body, listed };
}

describe("renderModelCheck", () => {
	const catalog = [
		model("pa", "a-pro-1", "general", { int: 50 }),
		model("pb", "b-pro-1", "general", { int: 45 }),
		model("pa", "c-pro-1", "general", { int: 40 }),
		model("pa", "d-pro-1", "general", { int: 30 }),
		model("pa", "e-flash-1", "cheap", { int: 20 }),
		model("pa", "f-flash-1", "cheap", { int: 25, cost: { ...COST.cheap, output: 0.2 } }),
	];

	test("each role lists exactly the candidates the recommender ranks above its current model, in rank order", () => {
		const ctx = ctxOf(catalog);
		const config = team({ implementer: "pa/c-pro-1:high", explorer: "pa/e-flash-1" });
		const text = renderModelCheck(ctx, config);
		const recs = ctx.recommend("balanced", { implementer: "pa/c-pro-1", explorer: "pa/e-flash-1" });
		for (const [roleId, selector] of [["implementer", "pa/c-pro-1"], ["explorer", "pa/e-flash-1"]] as const) {
			const above = recs.find((r) => r.role.id === roleId)?.current?.above.map((a) => a.candidate.selector) ?? [];
			expect(above.length).toBeGreaterThan(0);
			expect(section(text, selector).listed).toEqual(above);
		}
		// The first one listed is what a fresh recommendation would choose.
		expect(section(text, "pa/c-pro-1").listed[0]).toBe(ctx.recommend("balanced").find((r) => r.role.id === "implementer")?.candidates[0]?.selector ?? "");
		expect(section(text, "pa/c-pro-1").body).not.toContain("pa/d-pro-1");
	});

	test("a role already on the top-ranked model lists no candidate", () => {
		expect(section(renderModelCheck(ctxOf(catalog), team({ implementer: "pa/a-pro-1" })), "pa/a-pro-1").listed).toEqual([]);
	});

	test("the team's priority decides the ranking shown; a stored speed or quota reads as balanced", () => {
		const ctx = ctxOf(catalog);
		const listed = (priority: StormConfig["priority"]) => section(renderModelCheck(ctx, team({ explorer: "pa/e-flash-1" }, priority)), "pa/e-flash-1").listed;
		expect(listed("balanced")).toEqual(["pa/f-flash-1"]);
		// Quality shifts the explorer to the general tier: every general model outranks a cheap one.
		expect(listed("quality").slice(0, 2)).toEqual(["pa/a-pro-1", "pb/b-pro-1"]);
		expect(listed("speed")).toEqual(listed("balanced"));
		expect(listed("quota")).toEqual(listed("balanced"));
	});

	test("at most five higher-ranked candidates are listed", () => {
		const many = ["a", "b", "c", "d", "e", "f", "g"].map((cls, i) => model("pa", `${cls}-pro-1`, "general", { int: 80 - i * 5 }));
		expect(section(renderModelCheck(ctxOf(many), team({ implementer: "pa/g-pro-1" })), "pa/g-pro-1").listed).toEqual([
			"pa/a-pro-1",
			"pa/b-pro-1",
			"pa/c-pro-1",
			"pa/d-pro-1",
			"pa/e-pro-1",
		]);
	});

	test("a current model that is not a candidate gets the recommended candidates instead", () => {
		const withGone = [...catalog, model("pz", "gone-pro-1", "general", { available: false })];
		expect(section(renderModelCheck(ctxOf(withGone), team({ implementer: "pz/gone-pro-1" })), "pz/gone-pro-1").listed.slice(0, 3)).toEqual([
			"pa/a-pro-1",
			"pb/b-pro-1",
			"pa/c-pro-1",
		]);
	});

	test("newer versions name their usable routes, or the providers to log in to", () => {
		const versions = [
			model("pa", "a-pro-1", "general", { int: 50 }),
			model("pa", "a-pro-2", "general", { int: 30 }),
			model("pz", "a-pro-3", "general", { int: 30, available: false }),
			model("pz", "a-pro-0", "general", { int: 30, available: false }),
		];
		const { body } = section(renderModelCheck(ctxOf(versions), team({ implementer: "pa/a-pro-1" })), "pa/a-pro-1");
		const lines = body.split("\n").filter((line) => line.startsWith("  - "));
		expect(lines.map((line) => line.includes("a-pro-2") || line.includes("a-pro-3"))).toEqual([true, true]);
		expect(lines.find((line) => line.includes("a-pro-2"))).toContain("pa/a-pro-2");
		expect(lines.find((line) => line.includes("a-pro-3"))).toContain("pz");
		expect(body).not.toContain("a-pro-0");
	});

	test("without a config there is no role section", () => {
		expect(renderModelCheck(ctxOf(catalog), undefined)).not.toContain("### ");
	});
});

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
	const measured = (provider: string, id: string, over: Partial<UsageRow>): UsageRow => ({ ...usageRow(provider, id, 10), ...over });
	const usage: UsageSnapshot = {
		status: "ok",
		windowDays: 7,
		dataAsOf: NOW - 1000,
		rows: [
			measured("c", "cand", { requests: 40, errors: 2, ompTps: 100, decodeTps: 120, ttftP50: 500, costTotal: 3 }),
			measured("c", "cand", { seat: "main", requests: 1000, errors: 500, ompTps: 1 }),
			measured("a", "prim", { requests: 5, unpricedRequests: 5, costTotal: 0 }),
		],
	};

	test("each side is the selector's subagent usage; the main seat is ignored", () => {
		const c = compareTrial(trial, "a/prim", usage);
		expect(c.dataAsOf).toBe(NOW - 1000);
		expect(c.candidate).toEqual({
			selector: "c/cand",
			requests: 40,
			errorRate: 2 / 40,
			ompTps: 100,
			decodeTps: 120,
			ttftP50: 500,
			costPerRequest: 3 / 40,
		});
	});

	test("null metrics when absent or unpriced; an unused side has no rates", () => {
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
		expect(compareTrial(trial, "x/none", usage).current).toEqual({
			selector: "x/none",
			requests: 0,
			errorRate: null,
			ompTps: null,
			decodeTps: null,
			ttftP50: null,
			costPerRequest: null,
		});
	});
});
