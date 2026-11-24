import { describe, expect, test } from "bun:test";
import { collectModels, toModelInfo } from "../src/discovery/models.ts";
import { exhaustedLimit, parseUsageJson, readQuota } from "../src/discovery/quota.ts";
import { parseConfigList, readExplicitSettings, liveTaskMaxConcurrency, taskMaxConcurrencyOf } from "../src/discovery/settings.ts";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Exec } from "../src/types.ts";

const NOW = 1_800_000_000_000;

function ompModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://example.invalid",
		identity: { class: "claude", family: "sonnet", revision: "5.0.0" },
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] },
		int: 52.5,
		tps: Number.NaN,
		...overrides,
	};
}

describe("toModelInfo", () => {
	test("normalizes a chat model to the fields Storm reads", () => {
		expect(toModelInfo(ompModel(), true)).toEqual({
			provider: "anthropic",
			id: "claude-sonnet-5",
			selector: "anthropic/claude-sonnet-5",
			name: "Claude Sonnet 5",
			identity: { class: "claude", revision: "5.0.0" },
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			pricingKnown: true,
			contextWindow: 1_000_000,
			efforts: ["low", "medium", "high", "xhigh", "max"],
			supportsTools: true,
			int: 52.5,
			tps: null,
			available: true,
		});
	});

	test("zero or missing rates mean unknown pricing, not free", () => {
		const m = toModelInfo(ompModel({ cost: { input: 0, output: 0 } }), false);
		expect(m?.pricingKnown).toBe(false);
		expect(m?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(toModelInfo(ompModel({ cost: { input: 0, output: 0, cacheRead: 0.1 } }), false)?.pricingKnown).toBe(true);
	});

	test("skips non-chat kinds and drops unknown efforts", () => {
		expect(toModelInfo(ompModel({ kind: "image" }), true)).toBeUndefined();
		expect(toModelInfo(ompModel({ kind: "chat" }), true)).toBeDefined();
		const m = toModelInfo(ompModel({ thinking: { efforts: ["high", "turbo", "low"] }, supportsTools: false }), true);
		expect(m?.efforts).toEqual(["low", "high"]);
		expect(m?.supportsTools).toBe(false);
		expect(toModelInfo(ompModel({ thinking: undefined }), true)?.efforts).toEqual([]);
	});

	test("collectModels marks availability and dedupes selectors", () => {
		const a = ompModel();
		const b = ompModel({ id: "claude-haiku-5", provider: "anthropic" });
		const c = ompModel({ provider: "bedrock" });
		const registry = {
			getAll: (kind?: string) => (kind === "chat" ? [a, b, c, a] : []),
			getAvailable: (kind?: string) => (kind === "chat" ? [a, a] : []),
		};
		const { catalog, available } = collectModels(registry);
		expect(available.map(m => m.selector)).toEqual(["anthropic/claude-sonnet-5"]);
		expect(catalog.map(m => [m.selector, m.available])).toEqual([
			["anthropic/claude-sonnet-5", true],
			["anthropic/claude-haiku-5", false],
			["bedrock/claude-sonnet-5", false],
		]);
	});
});

const SECRET_META = {
	email: "user@example.com",
	accountId: "acct_secret",
	orgId: "org_secret",
	orgName: "Secret Org",
	credentialId: "cred_secret",
	planType: "pro",
};
const RESET = NOW + 3_600_000;

function limit(used: number, opts: Record<string, unknown> = {}, scope: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "5h",
		label: "5 Hour",
		scope: { provider: "x", accountId: "acct_secret", ...scope },
		window: { id: "5h", label: "5 Hour", resetsAt: RESET },
		amount: { used, limit: 100, unit: "percent", usedFraction: used / 100 },
		...opts,
	};
}

describe("parseUsageJson", () => {
	const payload = {
		generatedAt: NOW,
		reports: [
			{ provider: "ok", fetchedAt: NOW, limits: [limit(20)], metadata: SECRET_META },
			{ provider: "busy", fetchedAt: NOW, limits: [limit(85), limit(10)], metadata: SECRET_META },
			{ provider: "done", fetchedAt: NOW, limits: [limit(100)], metadata: SECRET_META },
			{ provider: "flagged", fetchedAt: NOW, limits: [limit(40)], metadata: { ...SECRET_META, limitReached: true } },
			{ provider: "status", fetchedAt: NOW, limits: [limit(10, { status: "exhausted" })], metadata: SECRET_META },
			{ provider: "nolimits", fetchedAt: NOW, limits: [], metadata: SECRET_META },
			// Two accounts: one exhausted, one free → the provider is usable.
			{ provider: "multi", fetchedAt: NOW, limits: [limit(100)], metadata: SECRET_META },
			{ provider: "multi", fetchedAt: NOW, limits: [limit(30)], metadata: SECRET_META },
		],
		accountsWithoutUsage: [{ provider: "silent", email: "user@example.com", accountId: "acct_secret" }],
		disabledCredentials: [],
		capacity: {},
	};
	const text = JSON.stringify(payload);

	test("classifies provider quota states", () => {
		const quota = parseUsageJson(text);
		expect(Object.fromEntries(quota.map(q => [q.provider, q.state]))).toEqual({
			ok: "available",
			busy: "limited",
			done: "exhausted",
			flagged: "exhausted",
			status: "exhausted",
			nolimits: "unknown",
			multi: "available",
			silent: "unknown",
		});
		const busy = quota.find(q => q.provider === "busy");
		expect(busy?.usedFraction).toBeCloseTo(0.85);
		expect(busy?.resetsAt).toBe(RESET);
		expect(quota.find(q => q.provider === "multi")?.usedFraction).toBeCloseTo(0.3);
		expect(quota.every(q => q.exhaustedModels === undefined)).toBe(true);
	});

	test("an exhausted limit scoped to a model tier or one model stops only those models", () => {
		const scoped = JSON.stringify({
			reports: [
				// Anthropic's shape: account-wide windows are `shared`, the weekly Opus counter names a tier.
				{ provider: "anthropic", limits: [limit(30, {}, { shared: true }), limit(100, {}, { tier: "opus" })] },
				// A meter that names its model, next to the account's own window.
				{ provider: "codex", limits: [limit(50, {}, { shared: true }), limit(100, { window: { id: "w" } }, { shared: true, modelId: "GPT-Spark" })] },
				// Per-model buckets only.
				{ provider: "gemini", limits: [limit(100, {}, { modelId: "gemini-3-pro" }), limit(10, {}, { modelId: "gemini-3-flash" })] },
			],
		});
		const quota = Object.fromEntries(parseUsageJson(scoped).map(q => [q.provider, q]));
		expect(quota.anthropic).toEqual({ provider: "anthropic", state: "available", usedFraction: 0.3, resetsAt: null, exhaustedTiers: { opus: RESET } });
		expect(quota.codex).toEqual({ provider: "codex", state: "available", usedFraction: 0.5, resetsAt: null, exhaustedModels: { "gpt-spark": null } });
		expect(quota.gemini).toEqual({ provider: "gemini", state: "available", usedFraction: null, resetsAt: null, exhaustedModels: { "gemini-3-pro": RESET } });

		expect(exhaustedLimit(quota.anthropic, "claude-opus-4-8", "opus")).toEqual({ resetsAt: RESET });
		expect(exhaustedLimit(quota.anthropic, "claude-sonnet-5-5", "sonnet")).toBeUndefined();
		expect(exhaustedLimit(quota.gemini, "Gemini-3-Pro", "pro")).toEqual({ resetsAt: RESET });
		expect(exhaustedLimit(quota.gemini, "gemini-3-flash", "flash")).toBeUndefined();
		expect(exhaustedLimit(quota.codex, "gpt-5.3-codex-spark", "codex-spark")).toBeUndefined();
		expect(exhaustedLimit(undefined, "any", "-")).toBeUndefined();
	});

	test("a scope tier that is a plan name does not match a word of a model id", () => {
		// Plan names ("pro", "max") travel in `scope.tier` too.
		const quota = parseUsageJson(JSON.stringify({ reports: [{ provider: "p", limits: [limit(30, {}, { shared: true }), limit(100, {}, { tier: "Pro" })] }] }))[0];
		expect(quota?.exhaustedTiers).toEqual({ pro: RESET });
		expect(exhaustedLimit(quota, "gpt-6-pro-preview", "terra")).toBeUndefined();
		expect(exhaustedLimit(quota, "claude-opus-5", "opus")).toBeUndefined();
		expect(exhaustedLimit(quota, "gemini-3-pro", "pro")).toEqual({ resetsAt: RESET });
	});

	test("a provider-wide exhausted limit stops every model, with its reset time", () => {
		const done = parseUsageJson(text).find(q => q.provider === "done");
		expect(exhaustedLimit(done, "anything", "-")).toEqual({ resetsAt: RESET });
	});

	test("a tier-scoped limit of a provider that marks no account-wide window still counts provider-wide", () => {
		const quota = parseUsageJson(JSON.stringify({ reports: [{ provider: "p", limits: [limit(100, {}, { tier: "pro" })] }] }));
		expect(quota).toEqual([{ provider: "p", state: "exhausted", usedFraction: 1, resetsAt: RESET }]);
	});

	test("never returns account identifiers", () => {
		const out = JSON.stringify(parseUsageJson(text));
		for (const secret of ["user@example.com", "acct_secret", "org_secret", "Secret Org", "cred_secret"]) {
			expect(out).not.toContain(secret);
		}
	});

	test("bad output and failed commands give no quota", async () => {
		expect(parseUsageJson("not json")).toEqual([]);
		const failing: Exec = async () => ({ stdout: "", stderr: "boom", code: 1 });
		expect(await readQuota(failing, "omp")).toEqual([]);
		const throwing: Exec = async () => {
			throw new Error("spawn failed");
		};
		expect(await readQuota(throwing, "omp")).toEqual([]);
		let seen: string[] = [];
		const ok: Exec = async (_cmd, args) => {
			seen = args;
			return { stdout: text, stderr: "", code: 0 };
		};
		expect((await readQuota(ok, "omp")).length).toBe(8);
		expect(seen).toEqual(["usage", "--json"]);
	});
});

describe("parseConfigList", () => {
	const entry = (value: unknown, type = "record") =>
		value === undefined ? { type, description: "" } : { value, type, description: "" };

	test("reads model roles and nothing it has no use for", () => {
		const s = parseConfigList(
			JSON.stringify({
				"auth.token": entry("sk-secret", "string"),
				modelRoles: entry({ default: "anthropic/claude-sonnet-5", slow: "openai/gpt-6", bad: 3 }),
				"task.agentModelOverrides": entry({ explore: "anthropic/claude-haiku-5" }),
				"magicKeywords.enabled": entry(true, "boolean"),
				"task.agentIdleTtlMs": entry(420_000, "number"),
				"providers.cacheRetention": entry("long", "enum"),
				"task.showResolvedModelBadge": entry(false, "boolean"),
			}),
		);
		expect(s).toEqual({ defaultModel: "anthropic/claude-sonnet-5", modelRoles: { default: "anthropic/claude-sonnet-5", slow: "openai/gpt-6" } });
	});

	test("unset settings stay empty", () => {
		expect(parseConfigList(JSON.stringify({ modelRoles: entry(undefined) }))).toEqual({ modelRoles: {} });
		expect(parseConfigList("not json")).toEqual({ modelRoles: {} });
	});

	test("reads isolation and retry fallback; concurrency stays a live host setting", () => {
		const s = parseConfigList(
			JSON.stringify({
				"task.isolation.enabled": entry(true, "boolean"),
				"task.isolation.apply": entry(false, "boolean"),
				"task.maxConcurrency": entry(4, "number"),
				"retry.modelFallback": entry(true, "boolean"),
				"retry.fallbackChains": entry({
					"a/x": ["b/y", "c/z"],
					default: [],
					mixed: ["b/y", 3],
					blank: [""],
					single: "b/y",
				}),
			}),
		);
		expect(s).toEqual({
			modelRoles: {},
			isolationEnabled: true,
			isolationApply: false,
			modelFallback: true,
			fallbackChains: { "a/x": ["b/y", "c/z"], default: [] },
		});
	});

	test("wrong types are ignored", () => {
		const s = parseConfigList(
			JSON.stringify({
				"task.isolation.enabled": entry("true", "boolean"),
				"task.isolation.apply": entry("false", "boolean"),
				"retry.modelFallback": entry(null, "boolean"),
				"retry.fallbackChains": entry(["a/x"]),
			}),
		);
		expect(s).toEqual({ modelRoles: {} });
	});

	test("the native ceiling is the live effective setting, with 0 preserved and no Storm default", () => {
		const live = (overrides: Record<string, unknown>): number | undefined =>
			withActiveSettings(Settings.isolated(overrides), liveTaskMaxConcurrency);
		expect(live({ "task.maxConcurrency": 0 })).toBe(0);
		expect(live({ "task.maxConcurrency": 2 })).toBe(2);
		// A real host has its registered effective default; Storm neither changes nor duplicates it.
		expect(live({})).toBe(32);
		// No settings instance is unknown, never a Storm-invented number.
		expect(taskMaxConcurrencyOf(undefined)).toBeUndefined();
	});

	test("command failure gives empty defaults", async () => {
		const failing: Exec = async () => ({ stdout: "", stderr: "", code: 2 });
		expect(await readExplicitSettings(failing, "omp")).toEqual({ modelRoles: {} });
	});
});
