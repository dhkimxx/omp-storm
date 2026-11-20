import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config/schema.ts";
import { ROLES } from "../src/roles.ts";
import { buildSetupRequest, type SetupRequestInput } from "../src/setup/request.ts";
import type { Analysis, AnalysisContext, Candidate, MetricValue, ModelInfo, RoleRecommendation, StormConfig } from "../src/types.ts";

const NOW = Date.parse("2026-11-20T09:00:00Z");

const mv = (value: number | null): MetricValue => ({ value, source: value == null ? "none" : "catalog", confidence: "medium" });
function cand(selector: string, over: Partial<Candidate> = {}): Candidate {
	return {
		selector,
		modelKey: selector,
		label: selector.split("/")[1]!.toUpperCase(),
		effort: "medium",
		tier: "general",
		int: mv(50),
		speed: mv(100),
		referenceUsd: 0.02,
		userMixUsd: null,
		quota: "available",
		confidence: "medium",
		validated: false,
		why: ["좋음"],
		whyNot: [],
		...over,
	};
}
function model(selector: string, over: Partial<ModelInfo> = {}): ModelInfo {
	const i = selector.indexOf("/");
	return {
		provider: selector.slice(0, i),
		id: selector.slice(i + 1),
		selector,
		name: selector,
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

const analysis: Analysis = {
	status: "ok",
	windowDays: 30,
	dataAsOf: NOW - 3_600_000,
	preferences: {
		main: { cheap: [], general: [], premium: [], unknown: [] },
		subagent: {
			cheap: [],
			general: [
				{
					modelKey: "a/x",
					lineKey: "x",
					label: "X",
					tier: "general",
					seat: "subagent",
					requests: 40,
					share: 0.5,
					shareRecent: 0.42,
					errorRate: 0,
					lastTs: NOW,
					routes: [
						{ selector: "a/x", provider: "a", id: "x", requests: 40, errors: 0, lastTs: NOW, ompTps: null, decodeTps: 90, ttftP50: 812.4, ttftP90: null, costPerRequest: null, available: true, variant: {} },
					],
				},
			],
			premium: [],
			unknown: [],
		},
	},
	stopped: [],
	newer: [],
	alternatives: {},
	warnings: ["분석 경고"],
};

function recs(): RoleRecommendation[] {
	return [
		{ role: ROLES[0]!, candidates: [cand("a/x", { effort: "low", validated: true }), cand("a/y"), cand("b/z", { whyNot: ["느림"] })], chosenIndex: 0, excluded: [{ selector: "d/q", reason: "컨텍스트 부족" }] },
		{ role: ROLES[1]!, candidates: [cand("a/i", { effort: null }), cand("c/j")], chosenIndex: 0, excluded: [] },
		{ role: ROLES[2]!, candidates: [cand("b/r", { effort: "high" })], chosenIndex: 0, excluded: [] },
	];
}

function fakeCtx(recommend: () => RoleRecommendation[] = recs, catalog: ModelInfo[] = []): AnalysisContext {
	const all = [
		...["a/x", "a/y", "b/z", "c/j", "b/r"].map((s) => model(s)),
		model("a/i", { efforts: [] }),
		model("f/notools", { supportsTools: false }),
		...catalog,
	];
	return {
		now: NOW,
		catalog: all,
		available: all,
		quota: [],
		explicit: { modelRoles: { smol: "a/y" }, agentModelOverrides: {}, isolationEnabled: false },
		usage: { status: "ok", dbPath: "", windowDays: 30, now: NOW, dataAsOf: NOW - 3_600_000, rows: [] },
		analysis,
		lineage: () => {
			throw new Error("unused");
		},
		tiers: new Map(),
		warnings: [],
		recommend,
		checkModel: (s) => {
			const m = all.find((x) => x.selector === s);
			return m ? { ok: true, label: m.name, efforts: m.efforts } : { ok: false, reason: "없음" };
		},
		detection: (_tools, extra = []) => {
			const providers = [...new Set(all.map((m) => m.provider))].sort();
			return {
				providers: providers.map((provider) => ({ provider, models: all.filter((m) => m.provider === provider).length, quota: "available" as const })),
				tools: { task: true, eval: false },
				keywords: { workflowz: false, orchestrate: true },
				dataAsOf: NOW - 3_600_000,
				stale: false,
				warnings: ["사전 지식 경고", ...extra],
			};
		},
	};
}

const input = (over: Partial<SetupRequestInput> = {}): SetupRequestInput => ({
	ctx: fakeCtx(),
	priority: "balanced",
	shadows: [],
	activeTools: ["task"],
	warnings: [],
	...over,
});

function recommendedOf(text: string): unknown {
	const m = text.match(/<storm-recommended-config>\n([\s\S]*?)\n<\/storm-recommended-config>/);
	if (!m) throw new Error("no recommended config");
	return JSON.parse(m[1]!);
}

describe("buildSetupRequest", () => {
	test("facts block carries a valid recommended config and the candidates' facts", () => {
		const text = buildSetupRequest(input({ warnings: ["설정 파일 오류"] }));
		expect(text.startsWith("<storm-setup>\n")).toBe(true);
		const facts = text.slice(0, text.indexOf("</storm-setup>"));
		const config = recommendedOf(text);
		const checked = validateConfig(config);
		expect(checked.errors).toEqual([]);
		expect(config).toEqual({
			version: 1,
			priority: "balanced",
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x:low", "b/z:low"], workers: 2 },
				implementer: { agent: "storm-implementer", models: ["a/i", "c/j:medium"], workers: 1 },
				reviewer: { agent: "storm-reviewer", models: ["b/r:high"], workers: 1 },
			},
			parallelism: 4,
			isolation: "shared",
			contract: "workflowz",
			runtime: "omp",
			fallbackRole: "implementer",
		});
		expect(facts).toContain("Storm 팀 처음 설정");
		expect(facts).toContain("- a (쿼터 여유, 모델 3개): i, x, y");
		expect(facts).not.toContain("notools");
		expect(facts).toContain("task.isolation.enabled=off");
		expect(facts).toContain("## explorer (탐색, storm-explorer)");
		expect(facts).toContain(
			"- ★ X (a/x) · 계층 일반 · 참조 비용 $0.0200 · 속도 ≈100 tok/s · TTFT 812ms · 지능 50 · 최근 사용 비중 서브 42% · 메인 — · effort low/medium/high · 쿼터 여유 · 컨텍스트 200,000 · 사용 검증",
		);
		expect(facts).toContain("  제외 이유: 느림");
		expect(facts).toContain("- 제외된 모델 1개: d/q (컨텍스트 부족)");
		expect(facts).toContain("effort 없음");
		expect(facts).not.toContain("<current-config");
		expect(facts).toContain("<warnings>\n- 사전 지식 경고\n- 설정 파일 오류\n- 분석 경고\n</warnings>");
	});

	test("instructions: ask with (추천) labels, never the recommended field, first question, then propose", () => {
		const text = buildSetupRequest(input());
		const after = text.slice(text.indexOf("</storm-setup>"));
		expect(after).toContain("`ask` 도구");
		expect(after).toContain('" (추천)"');
		expect(after).toContain("`recommended` 필드는 쓰지 마세요");
		expect(after).toContain('"Storm 추천안 그대로 (추천)", "역할별로 고르기", "취소"');
		expect(after).toContain('action "propose"');
		expect(after).toContain("`rationale`");
		expect(after).toContain("저장했다고 먼저 말하지 마세요");
	});

	test("stays bounded with many candidates, reasons and models", () => {
		const long = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} 이유 ${i} `.repeat(4));
		const many = (): RoleRecommendation[] =>
			ROLES.map((role) => ({
				role,
				candidates: Array.from({ length: 20 }, (_, i) => cand(`p${i % 4}/m-${role.id}-${i}`, { why: long(10, "근거"), whyNot: long(10, "제외") })),
				chosenIndex: 0,
				excluded: Array.from({ length: 30 }, (_, i) => ({ selector: `z/ex-${i}`, reason: "작음" })),
			}));
		const catalog = Array.from({ length: 400 }, (_, i) => model(`p${i % 4}/extra-model-${i}`, { int: i }));
		const text = buildSetupRequest(input({ ctx: fakeCtx(many, catalog) }));
		for (const role of ROLES) {
			const section = text.split(`## ${role.id} `)[1]!.split(/\n## |\n<\/roles>/)[0]!;
			expect(section.split("\n").filter((l) => l.startsWith("- ") && !l.startsWith("- 제외된")).length).toBe(5);
		}
		expect(text).toContain("외 88개");
		expect(text).not.toContain("근거 이유 3");
		expect(text.length).toBeLessThan(16_000);
	});

	test("re-setup includes the current config and approval, keeps its run settings, and lists shadows", () => {
		const current: StormConfig = {
			version: 1,
			priority: "cost",
			roles: { explorer: { agent: "storm-explorer", models: ["a/y:low"], workers: 3 } },
			parallelism: 6,
			isolation: "isolated",
			contract: "orchestrate",
			runtime: "omp",
		};
		const shadow = { agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project" as const, sha256: "ab" };
		const text = buildSetupRequest(input({ priority: "cost", current: { config: current, hash: "jcs-sha256:abc", approved: false }, shadows: [shadow] }));
		expect(text).toContain("Storm 팀 다시 설정");
		expect(text).toContain(`<current-config approved="false" hash="jcs-sha256:abc">\n${JSON.stringify(current, null, 2)}\n</current-config>`);
		expect(text).toContain(`<shadows>\n### 경고: 가림 정의`);
		expect(text).toContain(shadow.path);
		const config = recommendedOf(text) as StormConfig;
		expect(validateConfig(config).errors).toEqual([]);
		expect(config).toMatchObject({ priority: "cost", parallelism: 6, isolation: "isolated", contract: "orchestrate" });
		expect(config.roles.explorer!.workers).toBe(3);
		// A v0.2 config with workers but no fallbackRole blocked other agents on purpose; that carries over.
		expect(config.fallbackRole).toBeUndefined();
	});
});
