import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { renderStatus } from "../src/view/render.ts";
import { ompSettingsAdvice, shellQuote, wantedFallbackChains } from "../src/report/omp-settings.ts";
import { STORM_VERSION } from "../src/roles.ts";
import { credentialNotice, fallbackQuotaMark, quotaNotice } from "../src/runtime/quota-auto.ts";
import { newerInstalledVersion } from "../src/runtime/version.ts";
import type { ExplicitSettings, StatusView, StormConfig } from "../src/types.ts";
import type { PreflightReport } from "../src/report/preflight.ts";
import { teamOf } from "./fixtures.ts";

const config: StormConfig = teamOf({ explorer: ["a/x:low", "b/y:high", "a/x:max"], implementer: "c/z:high" }, { contract: "workflowz", runtime: "omp" });

const known = (extra: Partial<ExplicitSettings> = {}): ExplicitSettings => ({
	modelRoles: {},
	modelFallback: true,
	fallbackChains: { "a/x": ["b/y"] },
	...extra,
});

const keys = (settings: ExplicitSettings, cfg: StormConfig = config): string[] =>
	ompSettingsAdvice(cfg, settings).map((a) => a.key);

describe("ompSettingsAdvice", () => {
	test("settings that fit the team give no advice", () => {
		expect(ompSettingsAdvice(config, known())).toEqual([]);
	});

	test("unknown settings give no advice", () => {
		expect(ompSettingsAdvice(config, { modelRoles: {} })).toEqual([]);
	});

	test("wanted chains drop efforts, dedupe, skip single-model roles and merge shared primaries", () => {
		expect(wantedFallbackChains(config)).toEqual({ "a/x": ["b/y"] });
		const shared: StormConfig = {
			...config,
			roles: {
				...config.roles,
				reviewer: { agent: "storm-reviewer", models: ["a/x:high", "d/w", "b/y"] },
				solo: { agent: "storm-solo", models: ["e/v:low", "e/v:high"] },
			},
		};
		expect(wantedFallbackChains(shared)).toEqual({ "a/x": ["b/y", "d/w"] });
	});

	test("missing or different chains get one merged command that keeps other keys", () => {
		for (const fallbackChains of [{ default: ["q/r"] }, { default: ["q/r"], "a/x": ["c/z"] }]) {
			const [advice] = ompSettingsAdvice(config, known({ fallbackChains }));
			expect(advice?.key).toBe("retry.fallbackChains");
			expect(advice?.command).toBe(`omp config set retry.fallbackChains '{"default":["q/r"],"a/x":["b/y"]}'`);
		}
		expect(keys(known({ fallbackChains: { "a/x": ["b/y", "c/z"] } }))).toEqual(["retry.fallbackChains"]);
		const { fallbackChains: _unknown, ...unknownChains } = known();
		expect(keys(unknownChains)).toEqual([]);
	});

	test("modelFallback off is advised when the team has chains", () => {
		const advice = ompSettingsAdvice(config, known({ modelFallback: false, fallbackChains: {} }));
		expect(advice.map((a) => a.key)).toEqual(["retry.fallbackChains", "retry.modelFallback"]);
		expect(advice[1]?.command).toBe("omp config set retry.modelFallback true");
		expect(keys(known({ modelFallback: false }))).toEqual(["retry.modelFallback"]);
		const single: StormConfig = { ...config, roles: { implementer: { agent: "storm-implementer", models: ["c/z"] } } };
		expect(keys(known({ modelFallback: false }), single)).toEqual([]);
	});

	test("isolation is left to the preflight report", () => {
		const isolated: StormConfig = { ...config, isolation: "isolated" };
		expect(keys(known({ isolationEnabled: false, isolationApply: true }), isolated)).toEqual([]);
	});
});

describe("shellQuote", () => {
	test("single quotes survive a POSIX shell round trip", () => {
		const text = `{"a'b":["c/d","it's $HOME \`x\`"]}`;
		expect(shellQuote(text)).toBe(`'{"a'\\''b":["c/d","it'\\''s $HOME \`x\`"]}'`);
		expect(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(text)}`], { encoding: "utf8" })).toBe(text);
	});
});

describe("renderStatus omp sections", () => {
	const base: StatusView = {
		config: { status: "ok", path: "/r/c", config, hash: "jcs-sha256:abcdef0123456789", warnings: [] },
		approval: undefined,
		shadows: [],
		quota: [],
		dataAsOf: null,
	};

	const report: PreflightReport = {
		items: [
			{ key: "team", status: "ok", label: "팀 승인", detail: "승인됨" },
			{ key: "task.isolation.apply", status: "blocked", label: "LABEL-ONE", detail: "ADVICE-ONE", command: "omp config set task.isolation.apply false" },
			{ key: "budget", status: "notice", label: "LABEL-TWO", detail: "ADVICE-TWO" },
		],
		blocked: 1,
	};

	test("the preflight section shows the summary, each open item and its command, but not passed items", () => {
		const md = renderStatus({ ...base, preflight: report }, 0, "user");
		const command = "omp config set task.isolation.apply false";
		expect(md).toContain("통과 1 · 막힘 1 · 알림 1");
		expect(md.indexOf("ADVICE-ONE")).toBeGreaterThan(-1);
		expect(md.indexOf(`\`${command}\``)).toBeGreaterThan(md.indexOf("ADVICE-ONE"));
		expect(md.indexOf("ADVICE-TWO")).toBeGreaterThan(md.indexOf(command));
		expect(md).not.toContain("승인됨");
		expect(md).not.toContain("omp 설정 점검");
	});

	test("the model's status carries no preflight commands", () => {
		expect(renderStatus({ ...base, preflight: report }, 0, "model")).not.toContain("omp config set");
	});

	test("no report adds nothing to the status", () => {
		const plain = renderStatus(base, 0);
		expect(plain.split("\n")[0]).toContain(STORM_VERSION);
		expect(plain).not.toContain("omp config set");
		expect(plain).not.toContain("시작 전 점검");
	});

	test("a newer installed version shows on the first line", () => {
		const first = renderStatus({ ...base, newerVersion: "9.9.9" }, 0).split("\n")[0];
		expect(first).toContain(STORM_VERSION);
		expect(first).toContain("9.9.9");
		expect(renderStatus(base, 0).split("\n")[0]).not.toContain("9.9.9");
	});
});

describe("fallbackQuotaMark", () => {
	const now = Date.parse("2026-11-20T10:00:00.000Z");

	test("marks the from model's provider for 5 hours", () => {
		expect(fallbackQuotaMark("anthropic/claude-sonnet-5:high", now)).toEqual({
			provider: "anthropic",
			source: "fallback",
			markedAt: "2026-11-20T10:00:00.000Z",
			until: "2026-11-20T15:00:00.000Z",
		});
	});

	test("no provider, no mark", () => {
		expect(fallbackQuotaMark("default", now)).toBeUndefined();
		expect(fallbackQuotaMark("/x", now)).toBeUndefined();
	});

	test("notices name the models and the provider", () => {
		const marked = quotaNotice("a/x", "b/y", "a");
		expect(marked).toContain("a/x");
		expect(marked).toContain("b/y");
		// Without a provider there is no mark to mention.
		expect(quotaNotice("x", "b/y")).not.toBe(quotaNotice("x", "b/y", "a"));
		expect(credentialNotice("openai")).toContain("openai");
	});
});

describe("newerInstalledVersion", () => {
	const pkg = (version: unknown): string => JSON.stringify({ name: "omp-storm", version });

	test("returns the installed version only when newer", () => {
		expect(newerInstalledVersion("0.5.0", pkg("0.5.1"))).toBe("0.5.1");
		expect(newerInstalledVersion("0.5.9", pkg("0.10.0"))).toBe("0.10.0");
		expect(newerInstalledVersion("0.5.0", pkg("1.0.0"))).toBe("1.0.0");
		expect(newerInstalledVersion("0.5.0", pkg("0.5.0"))).toBeUndefined();
		expect(newerInstalledVersion("0.5.0", pkg("0.4.9"))).toBeUndefined();
		expect(newerInstalledVersion("0.10.0", pkg("0.9.0"))).toBeUndefined();
	});

	test("malformed input gives undefined", () => {
		expect(newerInstalledVersion("0.5.0", undefined)).toBeUndefined();
		expect(newerInstalledVersion("0.5.0", "{not json")).toBeUndefined();
		expect(newerInstalledVersion("0.5.0", "null")).toBeUndefined();
		expect(newerInstalledVersion("0.5.0", pkg(6))).toBeUndefined();
		expect(newerInstalledVersion("0.5.0", pkg("v1"))).toBeUndefined();
		expect(newerInstalledVersion("bad", pkg("1.0.0"))).toBeUndefined();
	});
});
