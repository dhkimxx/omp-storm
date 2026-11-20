import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { renderStatus } from "../src/interview/render.ts";
import { ompSettingsAdvice, shellQuote, wantedFallbackChains } from "../src/report/omp-settings.ts";
import { STORM_VERSION } from "../src/roles.ts";
import { credentialNotice, fallbackQuotaMark, quotaNotice } from "../src/runtime/quota-auto.ts";
import { newerInstalledVersion } from "../src/runtime/version.ts";
import type { ExplicitSettings, StatusView, StormConfig } from "../src/types.ts";

const config: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		explorer: { agent: "storm-explorer", models: ["a/x:low", "b/y:high", "a/x:max"] },
		implementer: { agent: "storm-implementer", models: ["c/z:high"] },
	},
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
	runtime: "omp",
};

const known = (extra: Partial<ExplicitSettings> = {}): ExplicitSettings => ({
	modelRoles: {},
	agentModelOverrides: {},
	maxConcurrency: 8,
	showResolvedModelBadge: true,
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
		expect(ompSettingsAdvice(config, { modelRoles: {}, agentModelOverrides: {} })).toEqual([]);
	});

	test("maxConcurrency below parallelism asks to raise it", () => {
		const [advice] = ompSettingsAdvice(config, known({ maxConcurrency: 2 }));
		expect(advice?.key).toBe("task.maxConcurrency");
		expect(advice?.command).toBe("omp config set task.maxConcurrency 4");
		expect(advice?.message).toContain("(2)");
		expect(keys(known({ maxConcurrency: 4 }))).toEqual([]);
	});

	test("a hidden model badge asks to turn it on", () => {
		const [advice] = ompSettingsAdvice(config, known({ showResolvedModelBadge: false }));
		expect(advice?.command).toBe("omp config set task.showResolvedModelBadge true");
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

	test("isolated config warns until omp isolation is on, unknown counting as off", () => {
		const isolated: StormConfig = { ...config, isolation: "isolated" };
		const { isolationEnabled: _unset, ...unset } = known();
		for (const settings of [known({ isolationEnabled: false }), unset]) {
			const [advice] = ompSettingsAdvice(isolated, settings);
			expect(advice?.key).toBe("task.isolation.enabled");
			expect(advice?.command).toBe("omp config set task.isolation.enabled true");
			expect(advice?.message).toContain("같은 작업 트리");
		}
		expect(keys(known({ isolationEnabled: true }), isolated)).toEqual([]);
		expect(keys(known({ isolationEnabled: false }))).toEqual([]);
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
		repo: { repoId: "git-r-1", kind: "dir", root: "/r" },
		config: { status: "ok", path: "/r/c", config, hash: "jcs-sha256:abcdef0123456789", rawSha256: "x", warnings: [] },
		approval: undefined,
		shadows: [],
		quota: [],
		dataAsOf: null,
	};

	test("advice renders messages, commands and the no-change note", () => {
		const md = renderStatus(
			{
				...base,
				ompAdvice: [
					{ key: "task.maxConcurrency", message: "올리세요.", command: "omp config set task.maxConcurrency 4" },
					{ key: "x", message: "명령 없음." },
				],
			},
			0,
		);
		expect(md).toContain(
			"### omp 설정 점검\n- 올리세요.\n  - `omp config set task.maxConcurrency 4`\n- 명령 없음.\n- Storm 은 omp 설정을 바꾸지 않습니다.",
		);
	});

	test("no advice, no section; the first line stays plain without a newer version", () => {
		for (const view of [base, { ...base, ompAdvice: [] }]) {
			const md = renderStatus(view, 0);
			expect(md).not.toContain("### omp 설정 점검");
			expect(md.split("\n")[0]).toBe(`- Storm ${STORM_VERSION}`);
		}
	});

	test("a newer installed version shows on the first line", () => {
		const md = renderStatus({ ...base, newerVersion: "9.9.9" }, 0);
		expect(md.split("\n")[0]).toBe(`- Storm ${STORM_VERSION} · 새 버전 9.9.9 설치됨 → /restart 로 적용`);
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
		expect(quotaNotice("a/x", "b/y", "a")).toContain("a 를 5시간 동안 쿼터 소진으로 표시");
		expect(quotaNotice("x", "b/y")).not.toContain("5시간");
		expect(credentialNotice("openai")).toContain("openai 인증 정보");
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
