import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { recommend } from "../src/recommend/recommend.ts";
import { renderModelCheck } from "../src/report/models.ts";
import { compareTrial } from "../src/report/trials.ts";
import { roleTitle } from "../src/roles.ts";
import type { AnalysisContext, InfoLine, ModelInfo, StormConfig, TrialConfig, UsageRow, UsageSnapshot } from "../src/types.ts";
import { infoSymbol, RichFrame } from "../src/view/info.ts";
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

// The rich frame draws with omp's theme.
ensureThemeSync();

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

describe("renderModelCheck rich annotations", () => {
	const catalog = [
		model("pa", "a-pro-1", "general", { int: 50 }),
		model("pb", "b-pro-1", "general", { int: 45 }),
		model("pa", "c-pro-1", "general", { int: 40 }),
		model("pa", "e-flash-1", "cheap", { int: 20 }),
		model("pa", "f-flash-1", "cheap", { int: 25, cost: { ...COST.cheap, output: 0.2 } }),
		model("pz", "gone-pro-1", "general", { available: false }),
	];
	const joined = (line: InfoLine) => line.spans.map((span) => span.text).join("");
	/** Annotated lines of the report, each with the Markdown line it stands for. */
	function annotated(ctx: AnalysisContext, config: StormConfig | undefined) {
		const info: InfoLine[] = [];
		const md = renderModelCheck(ctx, config, info);
		const lines = md.split("\n");
		return { md, info, lines, at: (line: InfoLine) => lines[line.index] ?? "" };
	}

	test("annotations leave the Markdown untouched and stand for exactly their own lines", () => {
		for (const [ctx, config] of [
			[ctxOf(catalog), team({ implementer: "pa/a-pro-1", explorer: "pa/e-flash-1" })],
			[ctxOf(catalog), team({ implementer: "pz/gone-pro-1" })],
			[ctxOf(catalog), undefined],
		] as const) {
			const { md, info, at } = annotated(ctx, config);
			expect(md).toBe(renderModelCheck(ctx, config));
			expect(new Set(info.map((line) => line.index)).size).toBe(info.length);
			// A heading drops only its Markdown marker; every other annotated line is the line itself.
			for (const line of info) expect([joined(line), `### ${joined(line)}`]).toContain(at(line));
			expect(info.every((line) => !joined(line).startsWith("#"))).toBe(true);
		}
	});

	test("each role heading and standing carry the role's standing; only the first comparison is singled out", () => {
		const ctx = ctxOf(catalog);
		const primaries = { implementer: "pa/c-pro-1", explorer: "pa/f-flash-1" };
		const { info, lines, at } = annotated(ctx, team({ implementer: "pa/c-pro-1:high", explorer: "pa/f-flash-1" }));
		const heading = (selector: string) => info.find((line) => line.emphasis === "title" && at(line).includes(`(${selector})`))!;
		const standing = (selector: string) => info.find((line) => line.index === heading(selector).index + 1)!;

		// Top-ranked: success on the model name and the "1위" line.
		const top = heading("pa/f-flash-1");
		expect(top.icon).toBe("status.success");
		expect(top.spans.find((span) => span.tone !== undefined && span.tone !== "muted")?.tone).toBe("success");
		expect(top.spans[0]?.text).toBe(`${roleTitle("explorer")} · `);
		expect(standing("pa/f-flash-1").icon).toBe("status.success");
		expect(joined(standing("pa/f-flash-1"))).toStartWith("- 추천 순위 1위");

		// Outranked: a warning, and the one comparison worth acting on is the recommender's first candidate above it.
		const above = ctx.recommend("balanced", primaries).find((r) => r.role.id === "implementer")!.current!.above;
		expect(above.length).toBeGreaterThan(1);
		expect(heading("pa/c-pro-1").icon).toBe("status.warning");
		expect(standing("pa/c-pro-1").icon).toBe("status.warning");
		expect(joined(standing("pa/c-pro-1"))).toStartWith(`- 추천 순위 ${above.length + 1}위`);
		const first = above[0]!.candidate;
		const comparison = info.find((line) => line.index === standing("pa/c-pro-1").index + 1)!;
		expect(at(comparison)).toStartWith("  - ");
		expect(comparison.spans.filter((span) => span.tone === "accent").map((span) => span.text)).toEqual([`${first.label} (${first.selector})`]);

		// The lower-ranked candidates stay plain Markdown lines, still listed in rank order.
		const candidateLines = lines.flatMap((line, index) => (line.startsWith("  - ") ? [index] : []));
		expect(candidateLines.length).toBe(above.length);
		expect(candidateLines.filter((index) => info.some((line) => line.index === index))).toEqual([comparison.index]);
		expect(candidateLines.every((index, i) => lines[index]!.includes(`(${above[i]!.candidate.selector})`))).toBe(true);
		// The closing note is quiet.
		expect(info.at(-1)?.spans.map((span) => span.tone)).toEqual(["muted"]);
	});

	test("a model that is no longer a candidate reads as an error and singles out the first recommended candidate", () => {
		const ctx = ctxOf(catalog);
		const { info, at } = annotated(ctx, team({ implementer: "pz/gone-pro-1" }));
		const heading = info.find((line) => line.emphasis === "title")!;
		expect(heading.icon).toBe("status.error");
		const reason = info.find((line) => line.index === heading.index + 1)!;
		expect(reason.icon).toBe("status.error");
		expect(reason.spans[0]).toEqual({ text: "- 지금은 이 역할의 후보가 아닙니다", tone: "error" });
		const best = ctx.recommend("balanced", { implementer: "pz/gone-pro-1" }).find((r) => r.role.id === "implementer")!.candidates[0]!;
		const lead = info.filter((line) => line.spans.some((span) => span.tone === "accent"));
		expect(lead.map((line) => at(line))).toHaveLength(1);
		expect(lead[0]!.spans.find((span) => span.tone === "accent")?.text).toBe(`${best.label} (${best.selector})`);
	});

	test("no team: the one actionable line is a warning", () => {
		const { info, lines } = annotated(ctxOf(catalog), undefined);
		expect(info[0]).toMatchObject({ index: 0, icon: "status.warning" });
		expect(info[0]?.spans[0]?.tone).toBe("warning");
		expect(lines[0]).toContain("/storm");
	});

	test("at 60 columns the Korean headings and standings wrap inside the frame, with their standing symbols", () => {
		const ctx = ctxOf(catalog);
		const { md, info } = annotated(ctx, team({ implementer: "pa/c-pro-1", explorer: "pa/f-flash-1", reviewer: "pz/gone-pro-1" }));
		const rows = new RichFrame("Storm 모델 점검", md, info).render(60);
		expect(rows.every((row) => visibleWidth(row) <= 60)).toBe(true);
		const plain = rows.map((row) => stripTerminalSequences(row));
		expect(plain.some((row) => row.includes("###"))).toBe(false);
		for (const [role, symbol] of [
			["implementer", "status.warning"],
			["explorer", "status.success"],
		] as const) {
			const row = plain.find((line) => line.includes(`${roleTitle(role)} · `));
			expect(row).toBeDefined();
			// The standing symbol leads the heading row, before the Korean role title.
			const glyph = infoSymbol(symbol);
			if (glyph !== undefined) {
				expect(row!.indexOf(glyph)).toBeGreaterThanOrEqual(0);
				expect(row!.indexOf(glyph)).toBeLessThan(row!.indexOf(roleTitle(role)));
			}
		}
		expect(plain.join("\n")).toContain("추천 순위 1위");
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
