import { describe, expect, test } from "bun:test";
import { ROLES, STORM_VERSION } from "../src/roles.ts";
import type {
	AgentEntry,
	Analysis,
	Candidate,
	Effort,
	MetricValue,
	Proposal,
	RoleRecommendation,
	RollbackOption,
	RunRecord,
	ShadowInfo,
	StatusView,
	StormConfig,
	TrialConfig,
	UiContext,
	UiPort,
	UiSelectItem,
} from "../src/types.ts";
import {
	type RolePick,
	renderAnalysis,
	renderConfigDiff,
	renderEvidence,
	renderStatus,
	renderStatusBrief,
	renderTeam,
} from "../src/interview/render.ts";
import { runReview, runRollback } from "../src/interview/review.ts";
import { buildConfig, deriveScope, recommendedConfig } from "../src/interview/setup.ts";

type Answer = string | undefined;
function fakeUi(answers: Answer[]) {
	const queue = [...answers];
	const reports: Array<{ title: string; md: string }> = [];
	const notes: string[] = [];
	const selects: Array<{ title: string; options: string[]; context?: UiContext }> = [];
	const ui: UiPort = {
		async select(title: string, options: UiSelectItem[], context?: UiContext) {
			selects.push({ title, options: options.map((o) => (typeof o === "string" ? o : o.label)), ...(context ? { context } : {}) });
			if (!queue.length) throw new Error(`no answer for select: ${title}`);
			return queue.shift();
		},
		async confirm() {
			return false;
		},
		async input(title: string) {
			if (!queue.length) throw new Error(`no answer for input: ${title}`);
			return queue.shift();
		},
		notify(m: string) {
			notes.push(m);
		},
		async report(title: string, md: string) {
			reports.push({ title, md });
		},
		record(title: string, md: string) {
			reports.push({ title, md });
		},
	};
	const options = (title: string) => {
		const s = selects.find((x) => x.title === title);
		if (!s) throw new Error(`no select titled ${title}; saw ${selects.map((x) => x.title).join(" | ")}`);
		return s.options;
	};
	return { ui, reports, notes, selects, options, left: () => queue.length };
}

const mv = (value: number | null): MetricValue => ({ value, source: value == null ? "none" : "catalog", confidence: "medium" });
function cand(selector: string, over: Partial<Candidate> = {}): Candidate {
	return {
		selector,
		modelKey: selector,
		label: selector.split("/")[1]!,
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
function recs(tag = ""): RoleRecommendation[] {
	return [
		{ role: ROLES[0]!, candidates: [cand(`a/x${tag}`, { effort: "low" }), cand(`a/y${tag}`), cand(`b/z${tag}`)], chosenIndex: 0, excluded: [] },
		{ role: ROLES[1]!, candidates: [cand(`a/i${tag}`, { effort: null }), cand(`c/j${tag}`)], chosenIndex: 0, excluded: [] },
		{ role: ROLES[2]!, candidates: [cand(`b/r${tag}`, { effort: "high" })], chosenIndex: 0, excluded: [{ selector: "d/q", reason: "컨텍스트 부족" }] },
	];
}
/** Supported efforts per model; recs("2") selectors share their base model's levels. */
const MODEL_EFFORTS: Record<string, Effort[]> = {
	"a/x": ["low", "medium", "high"],
	"a/y": ["low", "medium", "high"],
	"b/z": ["low", "medium", "high", "max"],
	"a/i": [],
	"c/j": ["low", "medium", "high"],
	"b/r": ["medium", "high", "xhigh"],
	"e/good": ["low", "medium", "high"],
};
const efforts = (s: string): Effort[] => MODEL_EFFORTS[s] ?? MODEL_EFFORTS[s.replace(/2$/, "")] ?? [];

const analysis: Analysis = {
	status: "ok",
	windowDays: 30,
	dataAsOf: null,
	preferences: {
		main: { cheap: [], general: [], premium: [], unknown: [] },
		subagent: {
			cheap: [],
			general: [
				{
					modelKey: "k",
					lineKey: "l",
					label: "Fake Flash",
					tier: "general",
					seat: "subagent",
					requests: 10,
					share: 0.5,
					shareRecent: 0.25,
					errorRate: 0,
					lastTs: 0,
					routes: [
						{ selector: "a/x", provider: "a", id: "x", requests: 10, errors: 0, lastTs: 0, ompTps: null, decodeTps: 42.4, ttftP50: null, ttftP90: null, costPerRequest: null, available: true, variant: {} },
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
	warnings: [],
};
const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project", sha256: "ab" };
const trialCfg: TrialConfig = {
	id: "reviewer-c",
	role: "reviewer",
	model: "c/cand",
	effort: "high",
	share: 0.25,
	maxSpawns: 10,
	startsAt: "2026-11-20T00:00:00.000Z",
	endsAt: "2026-11-27T00:00:00.000Z",
	budgetUsd: 5,
};

describe("recommendedConfig", () => {
	test("chosen candidate plus a fallback on another provider, each at the role effort it supports", () => {
		expect(recommendedConfig(recs(), efforts, "balanced")).toEqual({
			version: 1,
			priority: "balanced",
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x:low", "b/z:low"], workers: { min: 2, max: 4 } },
				implementer: { agent: "storm-implementer", models: ["a/i", "c/j:medium"], workers: { min: 1, max: 2 } },
				reviewer: { agent: "storm-reviewer", models: ["b/r:high"], workers: { min: 1, max: 2 } },
			},
			parallelism: 4,
			isolation: "shared",
			contract: "workflowz",
			runtime: "omp",
			fallbackRole: "implementer",
		});
	});

	test("a fallback gets its own effort nearest the role default (DeepSeek high for an explorer)", () => {
		const deepseek = cand("deepseek/flash");
		const haiku = cand("anthropic/haiku");
		const story: RoleRecommendation[] = [{ role: ROLES[0]!, candidates: [haiku, deepseek], chosenIndex: 0, excluded: [] }];
		const levels: Record<string, Effort[]> = { [deepseek.selector]: ["high", "max"], [haiku.selector]: ["low", "medium"] };
		const c = recommendedConfig(story, (s) => levels[s] ?? [], "speed");
		expect(c.roles.explorer!.models).toEqual(["anthropic/haiku:low", "deepseek/flash:high"]);
		expect(c.priority).toBe("speed");
	});

	test("re-setup keeps run settings, workers, a deliberate block, budget and trials from the current config", () => {
		const current: StormConfig = {
			...cfg("a/x"),
			parallelism: 7,
			contract: "orchestrate",
			budget: { perRunUsd: 2, onExceed: "stop" },
			contextCap: 100_000,
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x"], effort: "low", workers: 4, contextCap: 50_000 },
				reviewer: { agent: "storm-reviewer", models: ["b/r"], workers: { min: 1, max: 3 } },
			},
			trials: [trialCfg],
		};
		const c = recommendedConfig(recs(), efforts, "balanced", current);
		// A legacy count carries over as n~n; ranges and caps carry over as they are.
		expect(c.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/x:low", "b/z:low"], workers: { min: 4, max: 4 }, contextCap: 50_000 });
		expect(c.roles.reviewer!.workers).toEqual({ min: 1, max: 3 });
		expect(c.roles.implementer!.workers).toEqual({ min: 1, max: 2 });
		expect(c).toMatchObject({ parallelism: 7, isolation: "isolated", contract: "orchestrate", contextCap: 100_000, budget: { perRunUsd: 2, onExceed: "stop" }, trials: [trialCfg] });
		expect(c.fallbackRole).toBeUndefined();
	});

	test("roles without candidates are left out", () => {
		const rs = recs();
		rs[2] = { ...rs[2]!, candidates: [], chosenIndex: -1 };
		expect(Object.keys(recommendedConfig(rs, efforts, "balanced").roles)).toEqual(["explorer", "implementer"]);
	});
});

describe("buildConfig / deriveScope", () => {
	const opts = { priority: "speed", parallelism: 2, isolation: "shared", contract: "orchestrate" } as const;
	const pick = (selector: string, effort?: Effort, fallback?: [string, Effort?]): RolePick => {
		const primary = effort ? { selector, label: selector, effort } : { selector, label: selector };
		if (!fallback) return { primary };
		const [fs, fe] = fallback;
		return { primary, fallback: fe ? { selector: fs, label: fs, effort: fe } : { selector: fs, label: fs } };
	};
	const all = { explorer: pick("a/x", "max", ["b/z", "low"]), implementer: pick("a/i", undefined, ["c/j"]), reviewer: pick("b/r", "high") };

	test("models are written with per-model effort suffixes and no role effort", () => {
		const c = buildConfig(recs(), { explorer: pick("b/custom:thinking", "max", ["a/x", "low"]), implementer: pick("c/j") }, opts);
		expect(c.roles.explorer).toEqual({ agent: "storm-explorer", models: ["b/custom:thinking:max", "a/x:low"], workers: { min: 2, max: 4 } });
		expect(c.roles.implementer).toEqual({ agent: "storm-implementer", models: ["c/j"], workers: { min: 1, max: 2 } });
		expect(c.roles.reviewer).toBeUndefined();
		expect(deriveScope(c, []).providers).toEqual(["a", "b", "c"]);
	});

	test("defaults: DEFAULT_WORKERS ranges, fallback implementer only when that role exists", () => {
		const full = buildConfig(recs(), all, opts);
		expect(full.fallbackRole).toBe("implementer");
		expect(Object.values(full.roles).map((r) => r.workers)).toEqual([{ min: 2, max: 4 }, { min: 1, max: 2 }, { min: 1, max: 2 }]);
		const noImpl = buildConfig(recs(), { explorer: all.explorer, reviewer: all.reviewer }, opts);
		expect("fallbackRole" in noImpl).toBe(false);
		const blocked = buildConfig(recs(), { explorer: all.explorer, implementer: all.implementer }, { ...opts, fallbackRole: null, workers: { explorer: { min: 3, max: 6 } } });
		expect("fallbackRole" in blocked).toBe(false);
		expect(blocked.roles.explorer!.workers).toEqual({ min: 3, max: 6 });
		expect(buildConfig(recs(), { reviewer: all.reviewer }, { ...opts, fallbackRole: "toString" }).fallbackRole).toBeUndefined();
	});

	test("trials are kept only for roles in the config", () => {
		const orphan = { ...trialCfg, id: "x", role: "implementer" };
		const c = buildConfig(recs(), { reviewer: all.reviewer }, { ...opts, trials: [trialCfg, orphan] });
		expect(c.trials).toEqual([trialCfg]);
		expect("trials" in buildConfig(recs(), { explorer: all.explorer }, { ...opts, trials: [trialCfg] })).toBe(false);
	});

	test("deriveScope copies fallbackRole and trials only when present; providers ignore effort suffixes", () => {
		const c: StormConfig = { ...cfg("a/x:high"), fallbackRole: "explorer", trials: [trialCfg] };
		const scope = deriveScope(c, []);
		expect(scope.providers).toEqual(["a"]);
		expect(scope.fallbackRole).toBe("explorer");
		expect(scope.trials).toEqual([trialCfg]);
		expect(scope.trials).not.toBe(c.trials);
		const plain = deriveScope(cfg("a/x"), []);
		expect("fallbackRole" in plain || "trials" in plain).toBe(false);
	});
});


const cfg = (model: string): StormConfig => ({
	version: 1,
	priority: "balanced",
	roles: { explorer: { agent: "storm-explorer", models: [model] } },
	parallelism: 4,
	isolation: "isolated",
	contract: "workflowz",
	runtime: "omp",
});

describe("review / rollback", () => {
	test("runReview approves only on exact label", async () => {
		expect(await runReview(fakeUi(["승인"]).ui, { config: cfg("a/x"), hash: "h", shadows: [] })).toBe("approved");
		expect(await runReview(fakeUi(["승인 후 저장"]).ui, { config: cfg("a/x"), hash: "h", shadows: [] })).toBe("cancelled");
		const f = fakeUi([undefined]);
		expect(await runReview(f.ui, { config: cfg("a/x"), previous: cfg("a/y"), hash: "h", shadows: [shadow] })).toBe("cancelled");
		expect(f.reports).toEqual([]);
		expect(f.selects[0]).toMatchObject({ title: "이 설정을 승인할까요?", options: ["승인", "취소"] });
		expect(f.selects[0]!.context?.markdown).toContain("a/y → a/x");
		expect(f.selects[0]!.context?.markdown).toContain(shadow.path);
	});

	test("runRollback branches", async () => {
		const opt: RollbackOption = { hash: "jcs-sha256:0123456789abcdef", approvedAt: "2026-01-02T03:04:05Z", config: cfg("a/old") };
		const probe = fakeUi(["취소"]);
		expect(await runRollback(probe.ui, { options: [opt] })).toEqual({ status: "cancelled" });
		const label = probe.selects[0]!.options[0]!;
		expect(label).toContain("0123456789ab ·");
		expect(label).toContain("explorer=a/old");
		const go = fakeUi([label, "승인 후 되돌리기"]);
		expect(await runRollback(go.ui, { options: [opt], current: cfg("a/x") })).toEqual({ status: "approved", option: opt });
		expect(go.selects[1]!.context?.markdown).toContain("a/x → a/old");
		expect(await runRollback(fakeUi([label, "승인"]).ui, { options: [opt] })).toEqual({ status: "cancelled" });
	});
});


describe("render", () => {
	test("null metrics render as dash, not zero", () => {
		const a = renderAnalysis(analysis, 0);
		expect(a).toMatch(/omp — tok\/s · 생성 42 tok\/s · TTFT p50 —(?!ms)/);
		expect(a).toContain("30일 50% · 최근 25%");
		const rs = recs();
		rs[0]!.candidates[0] = cand("a/x", { int: mv(null), speed: mv(null), referenceUsd: null, tier: null });
		const ev = renderEvidence(rs);
		expect(ev).toContain("지능 — · — tok/s · —");
		const picks = { explorer: { primary: { selector: "a/x", label: "x", effort: "medium" as const } } };
		expect(renderTeam(rs, picks, { parallelism: 1, isolation: "isolated", contract: "workflowz" })).toContain("| 탐색 | x (a/x) | medium | — |");
	});

	test("status shows hash prefix, unapproved next step and max-cost advice", () => {
		const md = renderStatus(
			{
				repo: { repoId: "git-r-1", kind: "dir", root: "/r" },
				config: { status: "ok", path: "/r/c", config: { ...cfg("a/x"), budget: { perRunUsd: 3, onExceed: "block-spawns" } }, hash: "jcs-sha256:abcdef0123456789", rawSha256: "x", warnings: [] },
				approval: undefined,
				shadows: [shadow],
				quota: [{ provider: "a", state: "unknown", usedFraction: null, resetsAt: null, observedAt: 0 }],
				dataAsOf: null,
			},
			0,
		);
		expect(md).toContain("abcdef012345");
		expect(md).not.toContain("abcdef0123456");
		expect(md).toContain("미승인 — /storm 으로 승인하세요");
		expect(md).toContain("omp --max-cost 3");
		expect(md).toContain("사용 —");
		expect(md).toContain(shadow.path);
	});

	test("v0.1 status view renders none of the v0.2 sections", () => {
		const md = renderStatus(statusBase(), 0);
		expect(md.split("\n")[0]).toBe(`- Storm ${STORM_VERSION}`);
		for (const h of ["### 실행 중", "### 마지막 실행", "### 시험", "### 쿼터 소진 표시", "### 승인 대기", "다른 에이전트", "### 서브에이전트", "### 수명 관리"]) {
			expect(md).not.toContain(h);
		}
	});

	test("status renders subagents and lifecycle warnings, skipping the section when there are none", () => {
		const entry: AgentEntry = {
			id: "Imp1",
			name: "storm-implementer",
			role: "implementer",
			model: "a/x",
			state: "idle",
			startedAt: 0,
			lastActivityAt: 1_000,
			contextTokens: 5_000,
			requests: 2,
			costUsd: 0.01,
			followUps: 1,
		};
		const md = renderStatus(
			{
				...statusBase(),
				agents: [{ entry, advice: { id: "Imp1", action: "reuse", reason: "캐시 남음", handle: "agent://Imp1" } }],
				lifecycle: { agentIdleTtlMs: 420_000, cacheRetention: "auto" },
			},
			61_000,
		);
		expect(md).toContain("### 서브에이전트");
		expect(md).toMatch(/\| Imp1 \(implementer\) \| a\/x \| 유휴 \| 1분 \| 5\.0k \| 1 \| 재사용 \| 캐시 남음 \|/);
		expect(md).toContain("### 수명 관리\n- a: 유휴 TTL 7분");
		const quiet = renderStatus(
			{
				...statusBase(),
				config: {
					status: "ok",
					path: "/r/c",
					config: { ...cfg("a/x"), roles: { explorer: { agent: "storm-explorer", models: ["anthropic/y"] } } },
					hash: "jcs-sha256:abcdef0123456789",
					rawSha256: "x",
					warnings: [],
				},
				lifecycle: { agentIdleTtlMs: 3_600_000, cacheRetention: "long" },
			},
			0,
		);
		expect(quiet).not.toContain("### 수명 관리");
		expect(quiet).not.toContain("### 서브에이전트");
	});

	test("status renders run, last run, trials with comparison, quota marks and pending proposals", () => {
		const base = statusBase();
		const config: StormConfig = { ...cfg("a/x"), roles: { explorer: { agent: "storm-explorer", models: ["a/x"], workers: 2 } }, fallbackRole: "explorer" };
		const run: RunRecord = {
			schema: "storm.run/v1",
			runId: "run_A",
			configHash: "h",
			approvalId: "apr_1",
			startedAt: "2026-11-20T01:00:00.000Z",
			status: "running",
			contract: "workflowz",
			task: "t",
			costUsd: 0.5,
			costByModel: {},
			budget: { perRunUsd: 3, onExceed: "block-spawns" },
			spawns: [],
		};
		const spawn = (outcome: RunRecord["spawns"][number]["outcome"], reason?: string) => ({
			ts: "2026-11-20T00:00:00.000Z",
			agent: outcome === "blocked" ? "task" : "storm-explorer",
			invocationKind: "task" as const,
			requested: [],
			outcome,
			...(reason ? { reason } : {}),
		});
		const lastRun: RunRecord = {
			...run,
			runId: "run_B",
			status: "budget-exceeded",
			costUsd: 3.2,
			spawns: [spawn("routed"), spawn("routed"), spawn("trial"), spawn("blocked", "예산 초과"), spawn("blocked", "두 번째")],
		};
		const md = renderStatus(
			{
				...base,
				config: { status: "ok", path: "/r/c", config, hash: "jcs-sha256:abcdef0123456789", rawSha256: "x", warnings: [] },
				run,
				lastRun,
				trials: [
					{
						trial: trialCfg,
						state: { id: trialCfg.id, seen: 8, routed: 3, costUsd: 0.25, endedAt: "2026-11-21T00:00:00.000Z", endReason: "spawns" },
						phase: "ended",
						comparison: {
							candidate: { selector: "c/cand", requests: 3, errorRate: null, ompTps: 55.4, decodeTps: null, ttftP50: null, costPerRequest: 0.01 },
							current: { selector: "b/r", requests: 0, errorRate: 0, ompTps: null, decodeTps: 80, ttftP50: 420, costPerRequest: null },
							dataAsOf: null,
						},
					},
					{ trial: { ...trialCfg, id: "t2" }, state: undefined, phase: "pending" },
				],
				quotaMarks: [{ provider: "openai", source: "user", markedAt: "2026-11-20T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" }],
				pending: [proposal("워커 수 변경: 구현 1 → 3"), proposal("우선순위 변경: 균형 → 비용 우선")],
			},
			0,
		);
		expect(md).toContain("- explorer: a/x · 워커 2");
		expect(md).toContain("- 실행 중 다른 에이전트: 탐색 역할 모델로 대체");
		expect(md).toMatch(/### 실행 중\n- run_A · 시작 \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 지출 \$0\.5000 \/ 예산 \$3/);
		expect(md).toContain("- run_B · 예산 초과 · 지출 $3.2000 / 예산 $3");
		expect(md).toContain("- 스폰: 배정 2, 시험 1, 차단 2");
		expect(md).toContain("- 첫 차단: task · 예산 초과");
		expect(md).not.toContain("두 번째");
		expect(md).toMatch(/- reviewer-c \(리뷰 · c\/cand\): 종료 · 배정 3\/10 · 지출 \$0\.2500 \/ \$5 · 종료 .* \(횟수 소진\)/);
		expect(md).toContain("| 모델 | c/cand | b/r |");
		expect(md).toContain("| 요청 | 3 | 0 |");
		expect(md).toContain("| 오류율 | — | 0% |");
		expect(md).toContain("| omp tok/s | 55 | — |");
		expect(md).toContain("| 생성 tok/s | — | 80 |");
		expect(md).toContain("| TTFT p50 | — | 420ms |");
		expect(md).toContain("| 요청당 비용 | $0.0100 | — |");
		expect(md).toMatch(/- t2 \(리뷰 · c\/cand\): 시작 전 · 배정 0\/10 · 지출 \$0\.0000 \/ \$5 · 종료 예정 /);
		expect(md).toMatch(/### 쿼터 소진 표시\n- openai: .*까지 다른 provider 우선/);
		expect(md).toContain("### 승인 대기 제안 (2건)\n- 워커 수 변경: 구현 1 → 3\n- 우선순위 변경: 균형 → 비용 우선\n- /storm 메뉴에서 승인하세요");
	});

	test("config diff shows workers, other-agent handling and trial add/remove/change", () => {
		const prev: StormConfig = { ...cfg("a/x"), trials: [trialCfg, { ...trialCfg, id: "gone" }] };
		const next: StormConfig = {
			...cfg("a/x"),
			roles: { explorer: { agent: "storm-explorer", models: ["a/x"], workers: 3 } },
			fallbackRole: "explorer",
			trials: [{ ...trialCfg, share: 0.5 }, { ...trialCfg, id: "new" }],
			budget: { perRunUsd: 2, onExceed: "stop" },
		};
		const diff = renderConfigDiff(prev, next);
		expect(diff).toContain("- explorer 워커: 2~4 → 3");
		expect(diff).toContain("- 실행 중 다른 에이전트: 차단 → 탐색 역할 모델로 대체");
		expect(diff).toContain("- 예산: 없음 → 실행당 $2, 초과 시 stop");
		expect(diff).toMatch(/- 시험 reviewer-c: .*비율 25% .* → .*비율 50%/);
		expect(diff).toContain("- 시험 gone: 삭제");
		expect(diff).toMatch(/- 시험 new: 추가 · 리뷰 · c\/cand:high · 비율 25% · 최대 10회 · .* ~ .* · 예산 \$5/);
		expect(renderConfigDiff(next, structuredClone(next))).toBe("변경 없음");
		expect(renderConfigDiff(cfg("a/x"), { ...cfg("a/x"), roles: { explorer: { agent: "storm-explorer", models: ["a/x"], workers: { min: 2, max: 4 } } } })).toBe("변경 없음");
		const capped = renderConfigDiff(cfg("a/x"), { ...cfg("a/x"), contextCap: 100_000, roles: { explorer: { agent: "storm-explorer", models: ["a/x"], contextCap: 80_000 } } });
		expect(capped).toContain("- explorer 컨텍스트 상한: 기본(");
		expect(capped).toMatch(/- 컨텍스트 상한: 기본\(.*\) → 100/);
		const fresh = renderConfigDiff(undefined, next);
		expect(fresh).toContain("- explorer 워커: 3");
		expect(fresh).toMatch(/- 시험 new: 리뷰 · c\/cand/);
	});
});

function statusBase(): StatusView {
	return {
		repo: { repoId: "git-r-1", kind: "dir", root: "/r" },
		config: { status: "ok", path: "/r/c", config: cfg("a/x"), hash: "jcs-sha256:abcdef0123456789", rawSha256: "x", warnings: [] },
		approval: undefined,
		shadows: [],
		quota: [],
		dataAsOf: null,
	};
}

function proposal(summary: string): Proposal {
	return { schema: "storm.proposal/v1", id: summary, kind: "workers", createdAt: "x", summary, baseHash: "h", config: cfg("a/x") };
}

describe("brief status above the /storm menu", () => {
	test("keeps approval, role models, what needs a look and the way to the full status in a few lines", () => {
		const view: StatusView = {
			...statusBase(),
			newerVersion: "9.9.9",
			pending: [proposal("리뷰 워커 3")],
			quotaMarks: [{ provider: "anthropic", source: "fallback", markedAt: "x", until: "2026-11-21T05:00:00.000Z" }],
			ompAdvice: [
				{ key: "task.showResolvedModelBadge", message: "m", command: "omp config set task.showResolvedModelBadge true" },
				{ key: "task.maxConcurrency", message: "m" },
			],
		};
		const brief = renderStatusBrief(view, 0);
		expect(brief).toContain(`- Storm ${STORM_VERSION} · 새 버전 9.9.9 설치됨 → /restart 로 적용`);
		expect(brief).toContain("- 설정 abcdef012345 · 미승인");
		expect(brief).toContain("- explorer: a/x");
		expect(brief).toContain("- 확인할 것: 쿼터 소진 표시 anthropic · 승인 대기 제안 1건 · omp 설정 점검 2건");
		expect(brief).toContain("/storm status");
		expect(brief.split("\n").length).toBeLessThan(renderStatus(view, 0).split("\n").length / 2);
	});
});

describe("render per-model effort", () => {
	test("status lists entries as written and the role effort only when set", () => {
		const view = (roles: StormConfig["roles"]): StatusView => ({
			...statusBase(),
			config: { status: "ok", path: "/r/c", config: { ...cfg("a/x"), roles }, hash: "jcs-sha256:abcdef0123456789", rawSha256: "x", warnings: [] },
		});
		const md = renderStatus(view({ explorer: { agent: "storm-explorer", models: ["mistral/x:max", "anthropic/y:low"] } }), 0);
		expect(md).toContain("- explorer: mistral/x:max → anthropic/y:low · 워커 2~4\n");
		const legacy = renderStatus(view({ explorer: { agent: "storm-explorer", models: ["a/x", "b/y:max"], effort: "low" } }), 0);
		expect(legacy).toContain("- explorer: a/x → b/y:max · low · 워커 2~4\n");
		const capped = renderStatus(view({ implementer: { agent: "storm-implementer", models: ["a/x"], workers: 3, contextCap: 90_000 } }), 0);
		expect(capped).toMatch(/- implementer: a\/x · 워커 3 · 컨텍스트 상한 90/);
	});

	test("config diff prints the role effort line only when either side sets it", () => {
		const roles = (models: string[], effort?: "low") => ({
			...cfg("a/x"),
			roles: { explorer: { agent: "storm-explorer", models, ...(effort ? { effort } : {}) } },
		});
		const fresh = renderConfigDiff(undefined, roles(["a/x:max", "b/y:low"]));
		expect(fresh).toContain("- explorer 모델: a/x:max, b/y:low");
		expect(fresh).not.toContain("effort");
		const changed = renderConfigDiff(roles(["a/x"]), roles(["a/x:max"]));
		expect(changed).toContain("- explorer 모델: a/x → a/x:max");
		expect(changed).not.toContain("effort");
		expect(renderConfigDiff(roles(["a/x"], "low"), roles(["a/x:low"]))).toContain("- explorer effort: low → —");
		expect(renderConfigDiff(undefined, roles(["a/x"], "low"))).toContain("- explorer effort: low");
	});
});

describe("v0.7 roles", () => {
	const all = (): RoleRecommendation[] => ROLES.map((role, i) => ({ role, candidates: [cand(`a/m${i}`), cand(`b/m${i}`)], chosenIndex: 0, excluded: [] }));
	test("recommendedConfig builds every role, quick with 2 workers, and skips roles the current config disabled", () => {
		const c = recommendedConfig(all(), efforts, "balanced");
		expect(Object.keys(c.roles)).toEqual(ROLES.map((r) => r.id));
		expect(c.roles.quick).toMatchObject({ agent: "storm-quick", workers: { min: 1, max: 3 } });
		expect(c.roles.architect).toMatchObject({ agent: "storm-architect", workers: { min: 1, max: 1 } });
		expect(c.disabledRoles).toBeUndefined();
		const current: StormConfig = { ...c, disabledRoles: ["reviewer", "architect"] };
		delete current.roles.reviewer;
		delete current.roles.architect;
		const again = recommendedConfig(all(), efforts, "balanced", current);
		expect(Object.keys(again.roles)).toEqual(["explorer", "implementer", "quick"]);
		expect(again.disabledRoles).toEqual(["reviewer", "architect"]);
		expect(deriveScope(again, []).disabledRoles).toEqual(["reviewer", "architect"]);
	});
	test("config diff shows disabled roles by title, and changes to them", () => {
		const prev = cfg("a/x");
		const next: StormConfig = { ...prev, disabledRoles: ["reviewer", "architect"] };
		expect(renderConfigDiff(undefined, next)).toContain("- 사용 안 함: 리뷰, 설계·자문");
		expect(renderConfigDiff(prev, next)).toBe("- 사용 안 함: 없음 → 리뷰, 설계·자문");
		expect(renderConfigDiff(next, { ...prev, disabledRoles: ["architect"] })).toBe("- 사용 안 함: 리뷰, 설계·자문 → 설계·자문");
		expect(renderConfigDiff(undefined, prev)).not.toContain("사용 안 함");
	});
});
