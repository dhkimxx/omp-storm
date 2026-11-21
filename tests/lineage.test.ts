import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRevision, createLineage, displayLabel } from "../src/lineage/key.ts";
import { fillInt, fillTps, leadTolerance, scoreText } from "../src/lineage/metrics.ts";
import { loadPriors } from "../src/lineage/priors.ts";
import { assignTiers, mixCost, referenceCost, tierOf } from "../src/lineage/price.ts";
import type { LineageVariant, ModelIdentityInfo, ModelInfo } from "../src/types.ts";

const { priors } = loadPriors({ now: Date.parse("2026-11-21") });

function m(selector: string, identity: ModelIdentityInfo, extra: Partial<ModelInfo> = {}): ModelInfo {
	const i = selector.indexOf("/");
	return {
		provider: selector.slice(0, i),
		id: selector.slice(i + 1),
		selector,
		name: "",
		identity,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
		pricingKnown: true,
		contextWindow: null,
		efforts: [],
		supportsTools: true,
		int: null,
		tps: null,
		available: true,
		...extra,
	};
}

const DS = { class: "deepseek", revision: "4.1.0" };
const OPUS = { class: "anthropic", revision: "4.7.0" };
const catalog: ModelInfo[] = [
	m("opencode-go/deepseek-v4.1-flash", DS),
	m("commandcode/deepseek/deepseek-v4.1-flash-fast", DS),
	m("mistral/deepseek-v4-1-flash-1017", DS),
	m("openai-codex/gpt-6.1-terra", { class: "openai", revision: "6.1.0" }),
	m("openai-codex/gpt-6.1-sol", { class: "openai", revision: "6.1.0" }),
	m("openai-codex/gpt-6-luna", { class: "openai", revision: "6.0.0" }),
	m("openai-codex/gpt-6-astra", { class: "openai", revision: "6.0.0" }),
	m("openai-codex/gpt-5.6-terra", { class: "openai", revision: "5.6.0" }),
	m("minimax/MiniMax-M3.1-Flash", { class: "minimax" }),
	m("minimax/MiniMax-M3.1-Flash-Preview", { class: "minimax" }),
	m("mistral/zai-glm-5-3-flash", { class: "glm", revision: "5.3.0" }),
	m("opencode-go/glm-5.3-flash", { class: "glm", revision: "5.3.0" }),
	m("anthropic/claude-haiku-5-5", { class: "anthropic", revision: "5.5.0" }),
	m("opencode-go/claude-haiku-5-5", { class: "unknown" }),
	// Effort variants as one provider lists them, next to model names that end in the same words.
	m("anthropic/claude-opus-4-7", OPUS),
	m("cursor/claude-opus-4-7-high", OPUS),
	m("cursor/claude-opus-4-7-max", OPUS),
	m("cursor/claude-opus-4-7-low-fast", OPUS),
	m("azure/gpt-5.1-codex", { class: "openai", revision: "5.1.0" }),
	m("azure/gpt-5.1-codex-max", { class: "openai", revision: "5.1.0" }),
	m("cursor/gpt-5.1-codex-max-high", { class: "openai", revision: "5.1.0" }),
	m("mistral/mistral-medium", { class: "mistral" }),
	m("mistral/mistral-large", { class: "mistral" }),
];
const lineage = createLineage(catalog, priors);
const key = (sel: string, identity?: ModelIdentityInfo) => {
	const i = sel.indexOf("/");
	return lineage(sel.slice(0, i), sel.slice(i + 1), identity ?? catalog.find((c) => c.selector === sel)?.identity);
};

describe("lineage key", () => {
	test("DeepSeek routes merge; route words become the variant and dates are dropped", () => {
		const a = key("opencode-go/deepseek-v4.1-flash");
		const b = key("commandcode/deepseek/deepseek-v4.1-flash-fast");
		const c = key("mistral/deepseek-v4-1-flash-1017");
		expect([a.modelKey, b.modelKey, c.modelKey]).toEqual(Array(3).fill("deepseek/flash@4.1.0"));
		expect([a.variant, b.variant, c.variant]).toEqual([{}, { route: "fast" }, {}]);
	});

	test("GPT tiers split even with identical identity", () => {
		const keys = ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"].map((id) => key(`openai-codex/${id}`).modelKey);
		expect(keys).toEqual(["openai/terra@6.1.0", "openai/sol@6.1.0", "openai/luna@6.0.0", "openai/astra@6.0.0"]);
	});

	test("MiniMax revision from name, preview as route", () => {
		const a = key("minimax/MiniMax-M3.1-Flash");
		const b = key("minimax/MiniMax-M3.1-Flash-Preview");
		expect(a.modelKey).toBe("minimax/m-flash@3.1.0");
		expect(b.modelKey).toBe("minimax/m-flash@3.1.0");
		expect(a.revisionSource).toBe("name");
		expect(b.variant.route).toBe("preview");
	});

	test.each([
		["mistral/zai-glm-5-3-flash", "opencode-go/glm-5.3-flash", "glm/flash@5.3.0"],
		// The second row has no class of its own: it is filled from the rows that share its stem.
		["anthropic/claude-haiku-5-5", "opencode-go/claude-haiku-5-5", "anthropic/haiku@5.5.0"],
	])("%s and %s share a key", (x, y, expected) => {
		expect(key(x).modelKey).toBe(expected);
		expect(key(y).modelKey).toBe(expected);
	});

	test.each([
		"cursor/claude-opus-4-7-high",
		"cursor/claude-opus-4-7-max",
		"cursor/claude-opus-4-7-low-fast",
		"nanogpt/anthropic/claude-opus-4.7:thinking:low",
		"nanogpt/anthropic/claude-opus-4.7:high",
	])("%s is an effort variant of the model, like a `:effort` suffix", (selector) => {
		expect(key(selector, OPUS).modelKey).toBe(key("anthropic/claude-opus-4-7").modelKey);
	});

	test("`-max` and `-medium` stay part of the name unless the catalog proves them efforts", () => {
		expect(key("azure/gpt-5.1-codex-max").modelKey).toBe("openai/codex-max@5.1.0");
		expect(key("azure/gpt-5.1-codex").modelKey).toBe("openai/codex@5.1.0");
		// "-high" is never a model name, so it comes off and leaves the real model.
		expect(key("cursor/gpt-5.1-codex-max-high").modelKey).toBe("openai/codex-max@5.1.0");
		expect(key("mistral/mistral-medium").modelKey).not.toBe(key("mistral/mistral-large").modelKey);
	});

	test("only two tails that cannot be names prove a stem, and an id listed with its own effort tail stays a model", () => {
		const codex = { class: "openai", revision: "5.1.0" };
		const keys = (tails: string[]) => {
			const of = createLineage(tails.map((tail) => m(`cursor/gpt-5.1-codex-${tail}`, codex)), priors);
			return Object.fromEntries(tails.map((tail) => [tail, of("cursor", `gpt-5.1-codex-${tail}`, codex).modelKey]));
		};
		// One real effort tail next to "-max" proves nothing about "-max".
		expect(keys(["high", "max"])).toEqual({ high: "openai/codex@5.1.0", max: "openai/codex-max@5.1.0" });
		expect(keys(["high", "low", "max"])).toEqual({ high: "openai/codex@5.1.0", low: "openai/codex@5.1.0", max: "openai/codex@5.1.0" });
		// "codex-max-high" makes "codex-max" a model, whatever the stem proves.
		expect(keys(["high", "low", "max", "max-high"])).toEqual({
			high: "openai/codex@5.1.0",
			low: "openai/codex@5.1.0",
			max: "openai/codex-max@5.1.0",
			"max-high": "openai/codex-max@5.1.0",
		});
	});

	test("a single `-medium` tail is an effort when the catalog lists the bare model itself", () => {
		const oss = { class: "gpt-oss" };
		const mistral = { class: "mistral" };
		const of = createLineage(
			[
				m("cerebras/gpt-oss-120b", oss),
				m("antigravity/gpt-oss-120b-medium", oss),
				m("mistral/devstral-2512", mistral),
				m("ollama/devstral:24b", mistral),
				m("mistral/devstral-medium", mistral),
			],
			priors,
		);
		expect(of("antigravity", "gpt-oss-120b-medium", oss).modelKey).toBe(of("cerebras", "gpt-oss-120b", oss).modelKey);
		// "devstral" is listed only dated or tagged, never bare: Devstral Medium is its own model.
		expect(of("mistral", "devstral-medium", mistral).modelKey).not.toBe(of("mistral", "devstral-2512", mistral).modelKey);
	});

	test.each([
		["moonshot/kimi-k2-thinking", { class: "kimi" }, "moonshot/kimi-k2", { class: "kimi" }],
		["openai/o1", { class: "openai" }, "openai/o3", { class: "openai" }],
	])("%s stays apart from %s", (a, ia, b, ib) => {
		expect(key(a, ia).modelKey).not.toBe(key(b, ib).modelKey);
	});

	test("compressed revision resolves to 5.6 when known, else suspect", () => {
		const id = { class: "openai", revision: "56.0.0" };
		const v = key("venice/openai-gpt-56-terra", id);
		expect(v.modelKey).toBe("openai/terra@5.6.0");
		expect(v.suspect).toBe(false);
		const bare = createLineage([], priors)("venice", "openai-gpt-56-terra", id);
		expect(bare.suspect).toBe(true);
	});

	test("unregistered pair gets an unknown stem key", () => {
		expect(key("exaone/k-exaone_v2.5", { class: "unknown" }).modelKey).toBe("unknown/k-exaone-v2-5");
	});

	test("compareRevision is numeric", () => {
		expect(compareRevision("6.10.0", "6.9.0")).toBeGreaterThan(0);
		expect(compareRevision("4.1.0", "4.1.0")).toBe(0);
	});

	test("displayLabel drops dates and route words", () => {
		const l = key("mistral/deepseek-v4-1-flash-1017");
		expect(displayLabel({ ...catalog[2]!, name: "DeepSeek V4.1 Flash 1017" }, l)).toBe("DeepSeek V4.1 Flash");
		expect(displayLabel(undefined, l)).toBe("Deepseek Flash 4.1");
	});
});

describe("price tier", () => {
	test("reference cost uses 4 rates and estimates a missing cacheRead from the input price", () => {
		const opus = { pricingKnown: true, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } };
		expect(referenceCost(opus, priors)).toBeCloseTo(0.073, 6);
		expect(referenceCost({ pricingKnown: true, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, priors)).toBe((4000 + 16000) / 1e6);
		expect(referenceCost({ ...opus, pricingKnown: false }, priors)).toBeNull();
		expect(mixCost(opus, { input: 1e6, output: 0, cacheRead: 1e6, cacheWrite: 0 })).toBeCloseTo(4.2);
		expect(mixCost({ ...opus, pricingKnown: false }, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBeNull();
	});

	test.each([
		[0.0099, "cheap"],
		[0.01, "general"],
		[0.0599, "general"],
		[0.06, "premium"],
		[null, null],
	] as const)("tierOf(%p) = %p", (usd, tier) => {
		expect(tierOf(usd, priors)).toBe(tier);
	});

	const cheap = { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0 };
	const dear = { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 };

	test("assignTiers ignores preview and fast routes, and unavailable routes while an available one is priced", () => {
		const models = [
			m("minimax/MiniMax-M3.1-Flash", { class: "minimax" }, { cost: dear }),
			m("minimax/MiniMax-M3.1-Flash-Preview", { class: "minimax" }, { cost: cheap }),
			m("opencode-go/deepseek-v4.1-flash", DS, { cost: dear }),
			m("commandcode/deepseek/deepseek-v4.1-flash-fast", DS, { cost: cheap }),
			m("x/deepseek-v4.1-flash", DS, { cost: { ...cheap, output: 0.7 }, available: false }),
		];
		const tiers = assignTiers(models, lineage, priors);
		const dearUsd = referenceCost({ pricingKnown: true, cost: dear }, priors);
		expect(tiers.get("minimax/m-flash@3.1.0")).toEqual({ tier: "premium", referenceUsd: dearUsd });
		expect(tiers.get("deepseek/flash@4.1.0")).toEqual({ tier: "premium", referenceUsd: dearUsd });
	});

	test("a lineage whose available routes are all unpriced takes its tier from a priced route elsewhere", () => {
		const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const subscription = m("opencode-go/deepseek-v4.1-flash", DS, { cost: free, pricingKnown: false });
		const listed = m("x/deepseek-v4.1-flash", DS, { cost: cheap, available: false });
		expect(assignTiers([subscription, listed], lineage, priors).get("deepseek/flash@4.1.0")).toEqual({
			tier: "cheap",
			referenceUsd: referenceCost({ pricingKnown: true, cost: cheap }, priors),
		});
		expect(assignTiers([subscription], lineage, priors).get("deepseek/flash@4.1.0")).toEqual({ tier: null, referenceUsd: null });
	});
});

describe("metric fill", () => {
	const K = "deepseek/flash@4.1.0";
	const self = m("a/x", DS);

	test("int: routes that agree give an exact score, approximate only for a route without its own", () => {
		expect(fillInt({ ...self, int: 40 }, [], priors, K)).toEqual({ value: 40, source: "lineage" });
		const agreeing = [m("p1/x", DS, { int: 40 }), m("p2/x", DS, { int: 40 })];
		expect(fillInt(agreeing[0]!, agreeing, priors, K)).toEqual({ value: 40, source: "lineage" });
		expect(fillInt(self, agreeing, priors, K)).toEqual({ value: 40, source: "lineage", approx: true });
	});

	test("int: routes that disagree give every route the same median, marked approximate with the spread", () => {
		// The bundled catalog's DeepSeek V4 Flash: 34.3 on five providers, 51.8 on six.
		const routes = [
			...["a", "b", "c", "d", "e"].map((p) => m(`${p}/x`, DS, { int: 34.3 })),
			...["f", "g", "h", "i", "j", "k"].map((p) => m(`${p}/x`, DS, { int: 51.8 })),
		];
		const scores = [routes[0]!, routes[10]!, self].map((route) => fillInt(route, routes, priors, K));
		for (const score of scores) {
			expect(score.value).toBe(51.8);
			expect(score.approx).toBe(true);
			expect(score.spread).toBeCloseTo(17.5);
		}
		// An even split takes the middle.
		expect(fillInt(routes[0]!, [routes[0]!, routes[10]!], priors, K).value).toBeCloseTo(43.05);
	});

	test("int: a prior fills a lineage without scores; an unknown revision never borrows from other routes", () => {
		const withPrior = { ...priors, qualityPriors: [{ key: K, metric: "int", value: 30, source: "bench" }] };
		expect(fillInt(self, [], withPrior, K)).toEqual({ value: 30, source: "prior:bench", approx: true });
		expect(fillInt(self, [], priors, K)).toEqual({ value: null, source: "none" });
		const rolling = [m("p1/x", DS, { int: 32 }), m("p2/x", DS, { int: 60 })];
		expect(fillInt(self, rolling, priors, "deepseek/flash@?").value).toBeNull();
		expect(fillInt(rolling[0]!, rolling, priors, "deepseek/flash@?")).toEqual({ value: 32, source: "catalog" });
	});

	test("a score leads by more than 1 point, or more than half its own spread; scores print with ≈ when approximate", () => {
		expect(leadTolerance({ value: 58, source: "lineage" })).toBe(1);
		expect(leadTolerance({ value: 58, source: "lineage", approx: true, spread: 20 })).toBe(10);
		expect(leadTolerance({ value: 58, source: "lineage", approx: true, spread: 1.2 })).toBe(1);
		expect([{ value: 51.8, source: "lineage" }, { value: 51.8, source: "lineage", approx: true }, { value: null, source: "none" }].map(scoreText)).toEqual(["52", "≈52", "—"]);
	});

	test("tps: measured, catalog, same-speed sibling, missing", () => {
		const plain: LineageVariant = {};
		const fast: LineageVariant = { route: "fast" };
		const sib = [m("f/x", DS, { tps: 500 }), m("b/x", DS, { tps: 80 })];
		const vars = new Map([["f/x", fast], ["b/x", plain]]);
		expect(fillTps(self, { decodeTps: 99, samples: 30 }, sib, plain, vars)).toEqual({ value: 99, source: "measured" });
		expect(fillTps({ ...self, tps: 70 }, { decodeTps: 99, samples: 29 }, sib, plain, vars)).toEqual({ value: 70, source: "catalog" });
		expect(fillTps(self, undefined, sib, plain, vars)).toEqual({ value: 80, source: "catalog:sibling" });
		expect(fillTps(self, undefined, sib, fast, vars).value).toBe(500);
		expect(fillTps(self, undefined, sib.slice(0, 1), plain, vars)).toEqual({ value: null, source: "none" });
	});
});

describe("loadPriors", () => {
	const dir = mkdtempSync(join(tmpdir(), "storm-priors-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("user file merges maps and replaces arrays; its age is no warning", () => {
		const p = join(dir, "ok.yml");
		writeFileSync(p, "updated: 2020-01-01\nlineage:\n  route_tokens: [turbo]\nprice_tier:\n  bounds_usd_per_request: {cheap_below: 0.02}\n");
		const { priors: u, warnings } = loadPriors({ userPath: p, now: Date.parse("2026-11-20") });
		expect(u.lineage.routeTokens).toEqual(["turbo"]);
		expect(u.priceTier.boundsUsdPerRequest).toEqual({ cheapBelow: 0.02, premiumFrom: 0.06 });
		expect(u.lineage.genericBrand.openai).toContain("gpt");
		expect(warnings).toEqual([]);
	});

	test("an expired alias is dropped with one warning", () => {
		const live = loadPriors({ now: Date.parse("2026-11-20") });
		expect(live.priors.lineage.aliases.length).toBeGreaterThan(0);
		expect(live.warnings).toEqual([]);
		const later = loadPriors({ now: Date.parse("2030-01-01") });
		expect(later.priors.lineage.aliases).toEqual([]);
		expect(later.warnings).toHaveLength(1);
	});

	test("malformed user file falls back to defaults", () => {
		const p = join(dir, "bad.yml");
		writeFileSync(p, "price_tier:\n  reference_mix: nope\n");
		const { priors: u, warnings } = loadPriors({ userPath: p, now: Date.parse("2026-11-20") });
		expect(u.priceTier.referenceMix.cacheRead).toBe(160000);
		expect(warnings).toHaveLength(1);
	});
});
