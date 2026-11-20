import { describe, expect, test } from "bun:test";
import { collectModels, toModelInfo } from "../src/discovery/models.ts";
import { parseUsageJson, readQuota } from "../src/discovery/quota.ts";
import { parseConfigList, readExplicitSettings } from "../src/discovery/settings.ts";
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
	test("normalizes a chat model", () => {
		const m = toModelInfo(ompModel(), true);
		expect(m?.selector).toBe("anthropic/claude-sonnet-5");
		expect(m?.identity).toEqual({ class: "claude", family: "sonnet", revision: "5.0.0" });
		expect(m?.pricingKnown).toBe(true);
		expect(m?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(m?.supportsTools).toBe(true);
		expect(m?.int).toBe(52.5);
		expect(m?.tps).toBeNull();
		expect(m?.available).toBe(true);
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

function limit(used: number, opts: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "5h",
		label: "5 Hour",
		scope: { provider: "x", accountId: "acct_secret" },
		window: { id: "5h", label: "5 Hour", resetsAt: NOW + 3_600_000 },
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
		const states = Object.fromEntries(parseUsageJson(text, NOW).map(q => [q.provider, q.state]));
		expect(states).toEqual({
			ok: "available",
			busy: "limited",
			done: "exhausted",
			flagged: "exhausted",
			status: "exhausted",
			nolimits: "unknown",
			multi: "available",
			silent: "unknown",
		});
		const busy = parseUsageJson(text, NOW).find(q => q.provider === "busy");
		expect(busy?.usedFraction).toBeCloseTo(0.85);
		expect(busy?.resetsAt).toBe(NOW + 3_600_000);
		expect(parseUsageJson(text, NOW).find(q => q.provider === "multi")?.usedFraction).toBeCloseTo(0.3);
	});

	test("never returns account identifiers", () => {
		const out = JSON.stringify(parseUsageJson(text, NOW));
		for (const secret of ["user@example.com", "acct_secret", "org_secret", "Secret Org", "cred_secret"]) {
			expect(out).not.toContain(secret);
		}
	});

	test("bad output and failed commands give no quota", async () => {
		expect(parseUsageJson("not json", NOW)).toEqual([]);
		const failing: Exec = async () => ({ stdout: "", stderr: "boom", code: 1 });
		expect(await readQuota(failing, "omp", NOW)).toEqual([]);
		const throwing: Exec = async () => {
			throw new Error("spawn failed");
		};
		expect(await readQuota(throwing, "omp", NOW)).toEqual([]);
		let seen: string[] = [];
		const ok: Exec = async (_cmd, args) => {
			seen = args;
			return { stdout: text, stderr: "", code: 0 };
		};
		expect((await readQuota(ok, "omp", NOW)).length).toBe(8);
		expect(seen).toEqual(["usage", "--json"]);
	});
});

describe("parseConfigList", () => {
	const entry = (value: unknown, type = "record") =>
		value === undefined ? { type, description: "" } : { value, type, description: "" };
	const config = {
		"auth.token": entry("sk-secret", "string"),
		modelRoles: entry({ default: "anthropic/claude-sonnet-5", slow: "openai/gpt-6", bad: 3 }),
		"task.agentModelOverrides": entry({ explore: "anthropic/claude-haiku-5", task: ["a/b", "c/d"], junk: 1 }),
		"magicKeywords.enabled": entry(true, "boolean"),
		"magicKeywords.workflow": entry(false, "boolean"),
		"magicKeywords.orchestrate": entry(true, "boolean"),
	};

	test("reads model roles, overrides and keyword toggles", () => {
		const s = parseConfigList(JSON.stringify(config));
		expect(s.defaultModel).toBe("anthropic/claude-sonnet-5");
		expect(s.modelRoles).toEqual({ default: "anthropic/claude-sonnet-5", slow: "openai/gpt-6" });
		expect(s.agentModelOverrides).toEqual({ explore: "anthropic/claude-haiku-5", task: ["a/b", "c/d"] });
		expect(s.magicKeywords).toEqual({ enabled: true, workflowz: false, orchestrate: true });
		expect(JSON.stringify(s)).not.toContain("sk-secret");
	});

	test("unset settings stay empty and unreadable keywords are undefined", () => {
		const s = parseConfigList(JSON.stringify({ modelRoles: entry(undefined), "magicKeywords.enabled": entry(true, "boolean") }));
		expect(s).toEqual({ modelRoles: {}, agentModelOverrides: {} });
	});

	test("command failure gives empty defaults", async () => {
		const failing: Exec = async () => ({ stdout: "", stderr: "", code: 2 });
		expect(await readExplicitSettings(failing, "omp")).toEqual({ modelRoles: {}, agentModelOverrides: {} });
	});
});
