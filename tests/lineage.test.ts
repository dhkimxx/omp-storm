import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRevision, createLineage, displayLabel } from "../src/lineage/key.ts";
import { fillInt, fillTps } from "../src/lineage/metrics.ts";
import { loadPriors } from "../src/lineage/priors.ts";
import { assignTiers, referenceCost, tierOf, userMixCost } from "../src/lineage/price.ts";
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
		maxTokens: null,
		reasoning: false,
		efforts: [],
		supportsTools: true,
		int: null,
		tps: null,
		available: true,
		...extra,
	};
}

const DS = { class: "deepseek", family: "flash", revision: "4.1.0" };
const catalog: ModelInfo[] = [
	m("opencode-go/deepseek-v4.1-flash", DS),
	m("commandcode/deepseek/deepseek-v4.1-flash-fast", DS),
	m("mistral/deepseek-v4-1-flash-1017", DS),
	m("openai-codex/gpt-6.1-terra", { class: "openai", family: "gpt", revision: "6.1.0" }),
	m("openai-codex/gpt-6.1-sol", { class: "openai", family: "gpt", revision: "6.1.0" }),
	m("openai-codex/gpt-6-luna", { class: "openai", family: "gpt", revision: "6.0.0" }),
	m("openai-codex/gpt-6-astra", { class: "openai", family: "gpt", revision: "6.0.0" }),
	m("openai-codex/gpt-5.6-terra", { class: "openai", family: "gpt", revision: "5.6.0" }),
	m("minimax/MiniMax-M3.1-Flash", { class: "minimax", family: "m3" }),
	m("minimax/MiniMax-M3.1-Flash-Preview", { class: "minimax", family: "m3" }),
	m("mistral/zai-glm-5-3-flash", { class: "glm", revision: "5.3.0" }),
	m("opencode-go/glm-5.3-flash", { class: "glm", family: "glm", revision: "5.3.0" }),
	m("anthropic/claude-haiku-5-5", { class: "anthropic", family: "haiku", revision: "5.5.0" }),
	m("opencode-go/claude-haiku-5-5", { class: "unknown" }),
];
const lineage = createLineage(catalog, priors);
const key = (sel: string, identity?: ModelIdentityInfo) => {
	const i = sel.indexOf("/");
	return lineage(sel.slice(0, i), sel.slice(i + 1), identity ?? catalog.find((c) => c.selector === sel)?.identity);
};

describe("lineage key", () => {
	test("DeepSeek routes merge with route/snapshot variants", () => {
		const a = key("opencode-go/deepseek-v4.1-flash");
		const b = key("commandcode/deepseek/deepseek-v4.1-flash-fast");
		const c = key("mistral/deepseek-v4-1-flash-1017");
		expect([a.modelKey, b.modelKey, c.modelKey]).toEqual(Array(3).fill("deepseek/flash@4.1.0"));
		expect(b.variant.route).toBe("fast");
		expect(c.variant.snapshot).toBe("1017");
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
		["anthropic/claude-haiku-5-5", "opencode-go/claude-haiku-5-5", "anthropic/haiku@5.5.0"],
	])("%s and %s share a key", (x, y, expected) => {
		expect(key(x).modelKey).toBe(expected);
		expect(key(y).modelKey).toBe(expected);
	});

	test("unknown class filled from stem", () => {
		expect(key("opencode-go/claude-haiku-5-5").classSource).toBe("stem");
	});

	test.each([
		["moonshot/kimi-k2-thinking", { class: "kimi", family: "k2" }, "moonshot/kimi-k2", { class: "kimi", family: "k2" }],
		["mistral/mistral-medium", { class: "mistral", effort: "medium", logicalId: "mistral" }, "mistral/mistral", { class: "mistral" }],
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
	test("reference cost uses 4 rates and estimates missing cacheRead", () => {
		const opus = { pricingKnown: true, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } };
		expect(referenceCost(opus, priors).usd).toBeCloseTo(0.073, 6);
		const noCache = referenceCost({ pricingKnown: true, cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, priors);
		expect(noCache).toEqual({ usd: (4000 + 16000) / 1e6, estimated: true });
		expect(referenceCost({ ...opus, pricingKnown: false }, priors).usd).toBeNull();
		expect(userMixCost({ ...opus, pricingKnown: false }, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBeNull();
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

	test("assignTiers ignores preview and fast routes", () => {
		const cheap = { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0 };
		const dear = { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 };
		const models = [
			m("minimax/MiniMax-M3.1-Flash", { class: "minimax" }, { cost: dear }),
			m("minimax/MiniMax-M3.1-Flash-Preview", { class: "minimax" }, { cost: cheap }),
			m("opencode-go/deepseek-v4.1-flash", DS, { cost: dear }),
			m("commandcode/deepseek/deepseek-v4.1-flash-fast", DS, { cost: cheap }),
			m("x/deepseek-v4.1-flash", DS, { cost: { ...cheap, output: 0.7 }, available: false }),
		];
		const tiers = assignTiers(models, lineage, priors);
		expect(tiers.get("minimax/m-flash@3.1.0")?.basis).toBe("minimax/MiniMax-M3.1-Flash");
		expect(tiers.get("deepseek/flash@4.1.0")).toMatchObject({ basis: "opencode-go/deepseek-v4.1-flash", tier: "premium" });
	});
});

describe("metric fill", () => {
	const K = "deepseek/flash@4.1.0";
	const self = m("a/x", DS);
	test("int: self, mode by providers, tie lower, conflict, missing", () => {
		expect(fillInt({ ...self, int: 40 }, [], priors, K)).toMatchObject({ value: 40, source: "catalog" });
		const sib = [
			m("p1/x", DS, { int: 32.6 }),
			m("p2/x", DS, { int: 32.6 }),
			m("p2/y", DS, { int: 39.5 }),
			m("p3/x", DS, { int: 39.5 }),
			m("p3/y", DS, { int: 39.5 }),
			m("p4/x", DS, { int: 32.6 }),
		];
		expect(fillInt(self, sib, priors, K)).toMatchObject({ value: 32.6, source: "catalog:sibling(3)", conflict: true });
		expect(fillInt(self, sib.slice(0, 5), priors, K)).toMatchObject({ value: 32.6, conflict: true });
		expect(fillInt(self, sib.slice(0, 2), priors, K).conflict).toBeUndefined();
		const withPrior = { ...priors, qualityPriors: [{ key: K, metric: "int", value: 30, source: "bench" }] };
		expect(fillInt(self, [], withPrior, K)).toMatchObject({ value: 30, confidence: "low" });
		expect(fillInt(self, [], priors, K)).toMatchObject({ value: null, missingReason: "catalog_no_score" });
		expect(fillInt(self, sib, priors, "deepseek/flash@?").value).toBeNull();
	});

	test("tps: measured, catalog, same-speed sibling, missing", () => {
		const plain: LineageVariant = {};
		const fast: LineageVariant = { route: "fast" };
		const sib = [m("f/x", DS, { tps: 500 }), m("b/x", DS, { tps: 80 })];
		const vars = new Map([["f/x", fast], ["b/x", plain]]);
		expect(fillTps(self, { decodeTps: 99, samples: 30 }, sib, plain, vars)).toMatchObject({ value: 99, source: "measured" });
		expect(fillTps({ ...self, tps: 70 }, { decodeTps: 99, samples: 29 }, sib, plain, vars).value).toBe(70);
		expect(fillTps(self, undefined, sib, plain, vars)).toMatchObject({ value: 80, confidence: "low" });
		expect(fillTps(self, undefined, sib, fast, vars).value).toBe(500);
		expect(fillTps(self, undefined, sib.slice(0, 1), plain, vars)).toMatchObject({ value: null, missingReason: "unmeasured" });
	});
});

describe("loadPriors", () => {
	const dir = mkdtempSync(join(tmpdir(), "storm-priors-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("user file merges maps and replaces arrays; stale warns", () => {
		const p = join(dir, "ok.yml");
		writeFileSync(p, "updated: 2026-01-01\nlineage:\n  route_tokens: [turbo]\nprice_tier:\n  bounds_usd_per_request: {cheap_below: 0.02}\n");
		const { priors: u, warnings } = loadPriors({ userPath: p, now: Date.parse("2026-11-20") });
		expect(u.lineage.routeTokens).toEqual(["turbo"]);
		expect(u.priceTier.boundsUsdPerRequest).toEqual({ cheapBelow: 0.02, premiumFrom: 0.06 });
		expect(u.lineage.genericBrand.openai).toContain("gpt");
		expect(warnings).toEqual(["사전값이 오래됐습니다(2026-01-01)"]);
	});

	test("malformed user file falls back to defaults", () => {
		const p = join(dir, "bad.yml");
		writeFileSync(p, "price_tier:\n  reference_mix: nope\n");
		const { priors: u, warnings } = loadPriors({ userPath: p, now: Date.parse("2026-11-20") });
		expect(u.priceTier.referenceMix.cacheRead).toBe(160000);
		expect(warnings).toHaveLength(1);
	});
});
