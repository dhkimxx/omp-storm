import { describe, expect, test } from "bun:test";
import { ROLES } from "../src/roles.ts";
import type {
	Analysis,
	Candidate,
	Effort,
	InterviewInput,
	MetricValue,
	Priority,
	Proposal,
	RoleRecommendation,
	RollbackOption,
	RunRecord,
	ShadowInfo,
	StatusView,
	StormConfig,
	TrialConfig,
	UiPort,
	UiSelectItem,
} from "../src/types.ts";
import { type RolePick, renderAnalysis, renderConfigDiff, renderEvidence, renderStatus, renderTeam } from "../src/interview/render.ts";
import { runReview, runRollback } from "../src/interview/review.ts";
import { buildConfig, deriveScope, runSetupInterview } from "../src/interview/setup.ts";

type Answer = string | undefined;
function fakeUi(answers: Answer[]) {
	const queue = [...answers];
	const reports: Array<{ title: string; md: string }> = [];
	const notes: string[] = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const ui: UiPort = {
		async select(title: string, options: UiSelectItem[]) {
			selects.push({ title, options: options.map((o) => (typeof o === "string" ? o : o.label)) });
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
		report(title: string, md: string) {
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
const checkModel: InterviewInput["checkModel"] = (s) => {
	const efforts = MODEL_EFFORTS[s] ?? MODEL_EFFORTS[s.replace(/2$/, "")];
	return efforts ? { ok: true, label: s === "e/good" ? "Good" : s.split("/")[1]!, efforts } : { ok: false, reason: "카탈로그에 없음" };
};
/** Chapter 1/2 option label for one of the fixture candidates. */
const opt = (selector: string, mark: { rec?: boolean; cur?: boolean } = {}) =>
	`${mark.rec ? "★ 추천 " : ""}${selector.split("/")[1]} (${selector}) · 지능 50 · ≈100 tok/s · $0.0200${mark.cur ? " (현재)" : ""}`;

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

function makeInput(over: Partial<InterviewInput> = {}): InterviewInput & { calls: Priority[] } {
	const calls: Priority[] = [];
	return {
		calls,
		detection: { providers: [{ provider: "a", models: 3, quota: "available" }], tools: { task: true, eval: true }, keywords: { workflowz: true, orchestrate: true }, dataAsOf: null, stale: false, warnings: [] },
		analysis,
		recommendations: recs(),
		shadows: [],
		rerecommend: (p) => {
			calls.push(p);
			return recs("2");
		},
		checkModel,
		defaults: { parallelism: 4, isolation: "isolated", contract: "workflowz" },
		priority: "balanced",
		...over,
	};
}
const ACCEPT = ["계속", "균형", "전체 수락", "승인 후 저장"];
const STEPWISE = ["계속", "균형", "단계별로 고르기"];
const CH1_REC = [opt("a/x", { rec: true, cur: true }), opt("a/i", { rec: true, cur: true }), opt("b/r", { rec: true, cur: true })];
const CH2_REC = [opt("b/z", { rec: true, cur: true }), opt("c/j", { rec: true, cur: true }), "폴백 없음"];
/** Chapter 3 with every recommendation: explorer x and z, implementer fallback j, reviewer r (implementer i has no efforts). */
const CH3_REC = ["low (추천)", "low (추천)", "medium (추천)", "high (추천)"];
const TO_SETTINGS = [...STEPWISE, ...CH1_REC, ...CH2_REC, ...CH3_REC];
const SETTINGS = ["다음", "병렬도: 4", "워커 수: 탐색 2 · 구현 1 · 리뷰 1", "실행 중 다른 에이전트: 구현 역할 모델로 대체", "실행 계약: workflowz", "예산: 없음", "뒤로"];
const RECOMMENDED_ROLES = {
	explorer: { agent: "storm-explorer", models: ["a/x:low", "b/z:low"], workers: 2 },
	implementer: { agent: "storm-implementer", models: ["a/i", "c/j:medium"], workers: 1 },
	reviewer: { agent: "storm-reviewer", models: ["b/r:high"], workers: 1 },
};

describe("runSetupInterview", () => {
	test("accept all writes the recommended models with per-model effort and no role effort", async () => {
		const f = fakeUi(ACCEPT);
		const r = await runSetupInterview(f.ui, makeInput());
		expect(r.status).toBe("approved");
		if (r.status !== "approved") return;
		expect(r.config).toEqual({
			version: 1,
			priority: "balanced",
			roles: RECOMMENDED_ROLES,
			parallelism: 4,
			isolation: "isolated",
			contract: "workflowz",
			runtime: "omp",
			fallbackRole: "implementer",
		});
		expect(r.scope.fallbackRole).toBe("implementer");
		expect(r.scope.providers).toEqual(["a", "b", "c"]);
		expect(f.options("추천 구성을 어떻게 할까요?")).toEqual(["단계별로 고르기", "전체 수락", "근거 보기", "뒤로", "취소"]);
		expect(f.options("이 구성을 승인하고 저장할까요?")).toEqual(["승인 후 저장", "뒤로", "취소"]);
		const team = f.reports.find((x) => x.title === "추천 팀 구성")!.md;
		expect(team).toContain("| 역할 | 모델 | effort | 계층 | 근거 | 폴백 | 폴백 effort | 워커 |");
		expect(team).toContain("| 탐색 | x (a/x) | low | 일반 | 좋음 | b/z | low | 2 |");
		expect(team).toContain("| 구현 | i (a/i) | — | 일반 | 좋음 | c/j | medium | 1 |");
		expect(team).toContain("| 리뷰 | r (b/r) | high | 일반 | 좋음 | — | — | 1 |");
		expect(team).toContain("- 실행 중 다른 에이전트: 구현 역할 모델로 대체");
		const saved = f.reports.find((x) => x.title === "저장할 설정")!.md;
		expect(saved).toContain("- explorer 모델: a/x:low, b/z:low");
		expect(saved).not.toContain("effort:");
		expect(f.left()).toBe(0);
	});

	test("chapters ask in order with exact titles and options; non-recommended picks are saved as chosen", async () => {
		const f = fakeUi([
			...STEPWISE,
			opt("a/y"),
			opt("c/j"),
			"근거 보기",
			opt("b/r", { rec: true, cur: true }),
			opt("a/x"),
			"폴백 없음",
			"직접 입력",
			"b/r",
			"e/bad",
			"e/good",
			"high",
			"low (추천)",
			"low",
			"xhigh",
			"medium",
			"다음",
			"승인 후 저장",
		]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles).toEqual({
			explorer: { agent: "storm-explorer", models: ["a/y:high", "a/x:low"], workers: 2 },
			implementer: { agent: "storm-implementer", models: ["c/j:low"], workers: 1 },
			reviewer: { agent: "storm-reviewer", models: ["b/r:xhigh", "e/good:medium"], workers: 1 },
		});
		expect(f.selects.map((s) => s.title)).toEqual([
			"Storm 팀 설정을 시작할까요?",
			"최적화 우선순위 (현재: 균형)",
			"추천 구성을 어떻게 할까요?",
			"1/4 작업별 모델 · 탐색",
			"1/4 작업별 모델 · 구현",
			"1/4 작업별 모델 · 리뷰",
			"1/4 작업별 모델 · 리뷰",
			"2/4 폴백 모델 · 탐색 (주 모델: y)",
			"2/4 폴백 모델 · 구현 (주 모델: j)",
			"2/4 폴백 모델 · 리뷰 (주 모델: r)",
			"3/4 effort · 탐색 · y (주 모델)",
			"3/4 effort · 탐색 · x (폴백)",
			"3/4 effort · 구현 · j (주 모델)",
			"3/4 effort · 리뷰 · r (주 모델)",
			"3/4 effort · 리뷰 · Good (폴백)",
			"4/4 실행 설정",
			"이 구성을 승인하고 저장할까요?",
		]);
		expect(f.options("1/4 작업별 모델 · 탐색")).toEqual([
			opt("a/x", { rec: true, cur: true }),
			opt("a/y"),
			opt("b/z"),
			"직접 입력",
			"근거 보기",
			"뒤로",
		]);
		expect(f.options("1/4 작업별 모델 · 구현")).toEqual([opt("a/i", { rec: true, cur: true }), opt("c/j"), "직접 입력", "근거 보기", "뒤로"]);
		expect(f.options("2/4 폴백 모델 · 탐색 (주 모델: y)")).toEqual([opt("b/z", { rec: true, cur: true }), opt("a/x"), "폴백 없음", "직접 입력", "뒤로"]);
		expect(f.options("2/4 폴백 모델 · 구현 (주 모델: j)")).toEqual([opt("a/i", { rec: true, cur: true }), "폴백 없음", "직접 입력", "뒤로"]);
		expect(f.options("2/4 폴백 모델 · 리뷰 (주 모델: r)")).toEqual(["폴백 없음", "직접 입력", "뒤로"]);
		expect(f.options("3/4 effort · 탐색 · y (주 모델)")).toEqual(["low (추천)", "medium", "high", "뒤로"]);
		expect(f.options("3/4 effort · 리뷰 · r (주 모델)")).toEqual(["medium", "high (추천)", "xhigh", "뒤로"]);
		expect(f.options("3/4 effort · 리뷰 · Good (폴백)")).toEqual(["low", "medium", "high (추천)", "뒤로"]);
		expect(f.options("4/4 실행 설정")).toEqual(SETTINGS);
		expect(f.reports.find((x) => x.title === "추천 근거 · 리뷰")!.md).toContain("### 리뷰");
		const intro = f.reports.find((x) => x.title === "3/4 effort")!.md;
		expect(intro).toContain("지원하는 effort만");
		expect(intro).toContain("토큰당 가격은");
		expect(f.notes).toEqual(["주 모델과 다른 모델을 입력하세요.", "사용할 수 없는 모델: 카탈로그에 없음"]);
	});

	test("a fallback on another provider gets its own effort (DeepSeek max, Haiku low)", async () => {
		const deepseek = cand("deepseek/deepseek-v4.1-flash", { label: "DeepSeek V4.1 Flash" });
		const haiku = cand("anthropic/claude-haiku-5-5", { label: "Claude Haiku 5.5" });
		const sonnet = cand("anthropic/claude-sonnet-5-5", { label: "Claude Sonnet 5.5" });
		const gpt = cand("openai/gpt-6", { label: "GPT-6", validated: true, speed: { value: 80, source: "measured", confidence: "high" } });
		const story: RoleRecommendation[] = [
			{ role: ROLES[0]!, candidates: [haiku, deepseek], chosenIndex: 0, excluded: [] },
			{ role: ROLES[1]!, candidates: [sonnet], chosenIndex: 0, excluded: [] },
			{ role: ROLES[2]!, candidates: [gpt, deepseek], chosenIndex: 0, excluded: [] },
		];
		const efforts: Record<string, Effort[]> = {
			[deepseek.selector]: ["high", "max"],
			[haiku.selector]: ["low", "medium", "high"],
			[sonnet.selector]: ["low", "medium", "high"],
			[gpt.selector]: ["low", "medium", "high", "xhigh"],
		};
		const storyCheck: InterviewInput["checkModel"] = (s) => {
			const c = [deepseek, haiku, sonnet, gpt].find((x) => x.selector === s);
			return c ? { ok: true, label: c.label, efforts: efforts[s]! } : { ok: false, reason: "없음" };
		};
		const label = (c: Candidate, mark: { rec?: boolean; cur?: boolean } = {}) =>
			`${mark.rec ? "★ 추천 " : ""}${c.label} (${c.selector}) · 지능 50 · ${c === gpt ? "80" : "≈100"} tok/s · $0.0200${c.validated ? " · 사용 검증" : ""}${mark.cur ? " (현재)" : ""}`;
		const f = fakeUi([
			...STEPWISE,
			label(deepseek),
			label(sonnet, { rec: true, cur: true }),
			label(gpt, { rec: true, cur: true }),
			label(haiku, { rec: true, cur: true }),
			"폴백 없음",
			label(deepseek, { rec: true, cur: true }),
			"max",
			"low (추천)",
			"medium (추천)",
			"high (추천)",
			"max",
			"다음",
			"뒤로",
			"전체 수락",
			"승인 후 저장",
		]);
		const r = await runSetupInterview(f.ui, makeInput({ recommendations: story, checkModel: storyCheck }));
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles).toEqual({
			explorer: { agent: "storm-explorer", models: ["deepseek/deepseek-v4.1-flash:max", "anthropic/claude-haiku-5-5:low"], workers: 2 },
			implementer: { agent: "storm-implementer", models: ["anthropic/claude-sonnet-5-5:medium"], workers: 1 },
			reviewer: { agent: "storm-reviewer", models: ["openai/gpt-6:high", "deepseek/deepseek-v4.1-flash:max"], workers: 1 },
		});
		expect(f.options("1/4 작업별 모델 · 탐색")).toEqual([label(haiku, { rec: true, cur: true }), label(deepseek), "직접 입력", "근거 보기", "뒤로"]);
		expect(f.options("2/4 폴백 모델 · 탐색 (주 모델: DeepSeek V4.1 Flash)")).toEqual([label(haiku, { rec: true, cur: true }), "폴백 없음", "직접 입력", "뒤로"]);
		expect(f.options("2/4 폴백 모델 · 리뷰 (주 모델: GPT-6)")).toEqual([label(deepseek, { rec: true, cur: true }), "폴백 없음", "직접 입력", "뒤로"]);
		expect(f.options("3/4 effort · 탐색 · DeepSeek V4.1 Flash (주 모델)")).toEqual(["high (추천)", "max", "뒤로"]);
		expect(f.options("3/4 effort · 탐색 · Claude Haiku 5.5 (폴백)")).toEqual(["low (추천)", "medium", "high", "뒤로"]);
		expect(f.options("3/4 effort · 리뷰 · DeepSeek V4.1 Flash (폴백)")).toEqual(["high (추천)", "max", "뒤로"]);
		// Back from the final screen shows the team with the per-model picks; accept-all then keeps them.
		const team = f.reports.filter((x) => x.title === "추천 팀 구성").at(-1)!.md;
		expect(team).toContain("| 탐색 | DeepSeek V4.1 Flash (deepseek/deepseek-v4.1-flash) | max | 일반 | 좋음 | anthropic/claude-haiku-5-5 | low | 2 |");
		expect(team).toContain("| 리뷰 | GPT-6 (openai/gpt-6) | high | 일반 | 좋음 | deepseek/deepseek-v4.1-flash | max | 1 |");
		expect(f.reports.find((x) => x.title === "저장할 설정")!.md).toContain(
			"- explorer 모델: deepseek/deepseek-v4.1-flash:max, anthropic/claude-haiku-5-5:low",
		);
	});

	test("direct input takes a typed effort when supported and asks for it in chapter 3", async () => {
		const f = fakeUi([
			...STEPWISE,
			"직접 입력",
			"e/bad",
			"e/good:medium",
			opt("a/i", { rec: true, cur: true }),
			opt("b/r", { rec: true, cur: true }),
			opt("a/x", { rec: true, cur: true }),
			opt("c/j", { rec: true, cur: true }),
			"폴백 없음",
			"high",
			"low (추천)",
			"medium (추천)",
			"high (추천)",
			"다음",
			"승인 후 저장",
		]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["e/good:high", "a/x:low"], workers: 2 });
		expect(f.notes).toEqual(["사용할 수 없는 모델: 카탈로그에 없음"]);
		expect(f.options("2/4 폴백 모델 · 탐색 (주 모델: Good)")).toEqual([
			opt("a/x", { rec: true, cur: true }),
			opt("a/y"),
			opt("b/z"),
			"폴백 없음",
			"직접 입력",
			"뒤로",
		]);
		expect(f.options("3/4 effort · 탐색 · Good (주 모델)")).toEqual(["low (추천)", "medium (현재)", "high", "뒤로"]);
		expect(f.reports.find((x) => x.title === "추천 팀 구성")!.md).toContain("| 탐색 | x (a/x) | low |");
	});

	test("back crosses chapter boundaries; models without efforts are skipped", async () => {
		const f = fakeUi([
			...STEPWISE,
			"뒤로",
			"단계별로 고르기",
			CH1_REC[0]!,
			"뒤로",
			CH1_REC[0]!,
			CH1_REC[1]!,
			CH1_REC[2]!,
			"뒤로",
			CH1_REC[2]!,
			...CH2_REC,
			"뒤로",
			"폴백 없음",
			"medium",
			"뒤로",
			"medium (현재)",
			"low (추천)",
			"medium (추천)",
			"high (추천)",
			"뒤로",
			"xhigh",
			"다음",
			"뒤로",
			"전체 수락",
			"승인 후 저장",
		]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles).toEqual({
			explorer: { agent: "storm-explorer", models: ["a/x:medium", "b/z:low"], workers: 2 },
			implementer: { agent: "storm-implementer", models: ["a/i", "c/j:medium"], workers: 1 },
			reviewer: { agent: "storm-reviewer", models: ["b/r:xhigh"], workers: 1 },
		});
		expect(f.selects.map((s) => s.title).slice(2)).toEqual([
			"추천 구성을 어떻게 할까요?",
			"1/4 작업별 모델 · 탐색",
			"추천 구성을 어떻게 할까요?",
			"1/4 작업별 모델 · 탐색",
			"1/4 작업별 모델 · 구현",
			"1/4 작업별 모델 · 탐색",
			"1/4 작업별 모델 · 구현",
			"1/4 작업별 모델 · 리뷰",
			"2/4 폴백 모델 · 탐색 (주 모델: x)",
			"1/4 작업별 모델 · 리뷰",
			"2/4 폴백 모델 · 탐색 (주 모델: x)",
			"2/4 폴백 모델 · 구현 (주 모델: i)",
			"2/4 폴백 모델 · 리뷰 (주 모델: r)",
			"3/4 effort · 탐색 · x (주 모델)",
			"2/4 폴백 모델 · 리뷰 (주 모델: r)",
			"3/4 effort · 탐색 · x (주 모델)",
			"3/4 effort · 탐색 · z (폴백)",
			"3/4 effort · 탐색 · x (주 모델)",
			"3/4 effort · 탐색 · z (폴백)",
			"3/4 effort · 구현 · j (폴백)",
			"3/4 effort · 리뷰 · r (주 모델)",
			"4/4 실행 설정",
			"3/4 effort · 리뷰 · r (주 모델)",
			"4/4 실행 설정",
			"이 구성을 승인하고 저장할까요?",
			"추천 구성을 어떻게 할까요?",
			"이 구성을 승인하고 저장할까요?",
		]);
		expect(f.selects.filter((s) => s.title === "3/4 effort · 탐색 · x (주 모델)").map((s) => s.options)).toEqual([
			["low (추천)", "medium", "high", "뒤로"],
			["low (추천)", "medium", "high", "뒤로"],
			["low (추천)", "medium (현재)", "high", "뒤로"],
		]);
		expect(f.reports.filter((x) => x.title === "3/4 effort").length).toBe(2);
	});

	test("with no efforts anywhere chapter 3 asks nothing and back from chapter 4 returns to chapter 2", async () => {
		const flat: InterviewInput["checkModel"] = (s) => ({ ok: true, label: s, efforts: [] });
		const f = fakeUi([...STEPWISE, ...CH1_REC, ...CH2_REC, "뒤로", "폴백 없음", "다음", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput({ checkModel: flat }));
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles).toEqual({
			explorer: { agent: "storm-explorer", models: ["a/x", "b/z"], workers: 2 },
			implementer: { agent: "storm-implementer", models: ["a/i", "c/j"], workers: 1 },
			reviewer: { agent: "storm-reviewer", models: ["b/r"], workers: 1 },
		});
		expect(f.selects.some((s) => s.title.startsWith("3/4"))).toBe(false);
		expect(f.selects.at(-3)!.title).toBe("2/4 폴백 모델 · 리뷰 (주 모델: r)");
	});

	test("cancel or undefined at each chapter saves nothing and reports the step", async () => {
		const cases: Array<[Answer[], string]> = [
			[["취소"], "summary"],
			[[undefined], "summary"],
			[["계속", undefined], "priority"],
			[["계속", "균형", "취소"], "overview"],
			[["계속", "균형", undefined], "overview"],
			[[...STEPWISE, undefined], "models"],
			[[...STEPWISE, "직접 입력", undefined], "models"],
			[[...STEPWISE, ...CH1_REC, undefined], "fallbacks"],
			[[...STEPWISE, ...CH1_REC, "직접 입력", undefined], "fallbacks"],
			[[...STEPWISE, ...CH1_REC, ...CH2_REC, undefined], "efforts"],
			[[...TO_SETTINGS, undefined], "settings"],
			[[...TO_SETTINGS, "병렬도: 4", undefined], "settings"],
			[[...TO_SETTINGS, "워커 수: 탐색 2 · 구현 1 · 리뷰 1", undefined], "settings"],
			[[...TO_SETTINGS, "워커 수: 탐색 2 · 구현 1 · 리뷰 1", "탐색", undefined], "settings"],
			[[...TO_SETTINGS, "워커 수: 탐색 2 · 구현 1 · 리뷰 1", "탐색", "직접 입력", undefined], "settings"],
			[[...TO_SETTINGS, "실행 중 다른 에이전트: 구현 역할 모델로 대체", undefined], "settings"],
			[[...TO_SETTINGS, "실행 계약: workflowz", undefined], "settings"],
			[[...TO_SETTINGS, "예산: 없음", undefined], "settings"],
			[["계속", "균형", "전체 수락", "취소"], "final"],
			[["계속", "균형", "전체 수락", "승인"], "final"],
			[["계속", "균형", "전체 수락", undefined], "final"],
		];
		for (const [answers, at] of cases) {
			const f = fakeUi(answers);
			expect(await runSetupInterview(f.ui, makeInput())).toEqual({ status: "cancelled", at });
			expect(f.left()).toBe(0);
		}
	});

	test("back from summary and priority, and evidence from the overview", async () => {
		const f = fakeUi(["계속", "뒤로", "계속", "균형", "뒤로", "균형", "근거 보기", "전체 수락", "뒤로", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput());
		expect(r.status).toBe("approved");
		expect(f.reports.filter((x) => x.title === "Storm 탐지 요약").length).toBe(2);
		expect(f.reports.find((x) => x.title === "추천 근거")!.md).toContain("### 탐색");
	});

	test("priority change rerecommends and resets picks", async () => {
		const input = makeInput();
		const f = fakeUi(["계속", "비용 우선", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, input);
		expect(input.calls).toEqual(["cost"]);
		if (r.status !== "approved") throw new Error(r.status);
		expect(r.config.priority).toBe("cost");
		expect(r.config.roles.explorer!.models).toEqual(["a/x2:low", "b/z2:low"]);
	});

	test("chapter 4 edits parallelism, budget and contract, then returns to its menu", async () => {
		const f = fakeUi([...TO_SETTINGS, "병렬도: 4", "17", "8", "예산: 없음", "2", "실행 계약: workflowz", "orchestrate", "다음", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.parallelism).toBe(8);
		expect(r.config.contract).toBe("orchestrate");
		expect(r.config.budget).toEqual({ perRunUsd: 2, warnAtUsd: 1.6, onExceed: "block-spawns" });
		expect(f.notes).toEqual(["1에서 16 사이 정수를 입력하세요."]);
		expect(f.selects.filter((s) => s.title === "4/4 실행 설정").at(-1)!.options).toEqual([
			"다음",
			"병렬도: 8",
			"워커 수: 탐색 2 · 구현 1 · 리뷰 1",
			"실행 중 다른 에이전트: 구현 역할 모델로 대체",
			"실행 계약: orchestrate",
			"예산: 실행당 $2 (경고 $1.6), 초과 시 block-spawns",
			"뒤로",
		]);
	});

	test("role without candidates blocks accept-all until a model is typed in chapter 1", async () => {
		const rs = recs();
		rs[2] = { ...rs[2]!, candidates: [], chosenIndex: -1 };
		const f = fakeUi([
			"계속",
			"균형",
			"전체 수락",
			"단계별로 고르기",
			CH1_REC[0]!,
			CH1_REC[1]!,
			"직접 입력",
			"e/good",
			...CH2_REC,
			...CH3_REC.slice(0, 3),
			"high (추천)",
			"다음",
			"승인 후 저장",
		]);
		const r = await runSetupInterview(f.ui, makeInput({ recommendations: rs }));
		expect(f.reports.find((x) => x.title === "추천 팀 구성")!.md).toContain("| 리뷰 | 후보 없음 |");
		expect(f.notes.length).toBe(1);
		expect(f.options("1/4 작업별 모델 · 리뷰")).toEqual(["직접 입력", "근거 보기", "뒤로"]);
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles.reviewer!.models).toEqual(["e/good:high"]);
	});

	test("shadows are shown and recorded in scope", async () => {
		const f = fakeUi(ACCEPT);
		const r = await runSetupInterview(f.ui, makeInput({ shadows: [shadow] }));
		expect(f.reports.find((x) => x.title === "저장할 설정")!.md).toContain(shadow.path);
		if (r.status !== "approved") throw new Error(r.status);
		expect(r.scope.shadowedAgents).toEqual([shadow]);
	});

	test("workers: preset, custom input with re-ask, and back", async () => {
		const W = "워커 수: 탐색 2 · 구현 1 · 리뷰 1";
		const f = fakeUi([
			...TO_SETTINGS,
			W, "구현", "3",
			"워커 수: 탐색 2 · 구현 3 · 리뷰 1", "리뷰", "직접 입력", "0", "5",
			"워커 수: 탐색 2 · 구현 3 · 리뷰 5", "탐색", "뒤로",
			"워커 수: 탐색 2 · 구현 3 · 리뷰 5", "뒤로",
			"다음", "뒤로", "전체 수락", "승인 후 저장",
		]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(Object.fromEntries(Object.entries(r.config.roles).map(([id, x]) => [id, x.workers]))).toEqual({ explorer: 2, implementer: 3, reviewer: 5 });
		expect(r.scope.roles.reviewer!.workers).toBe(5);
		expect(f.notes).toEqual(["1에서 16 사이 정수를 입력하세요."]);
		expect(f.options("구현 워커 수 (현재: 1)")).toEqual(["1", "2", "3", "4", "직접 입력", "뒤로"]);
		expect(f.options("워커 수를 바꿀 역할")).toEqual(["탐색", "구현", "리뷰", "뒤로"]);
		const team = f.reports.filter((x) => x.title === "추천 팀 구성").at(-1)!.md;
		expect(team).toMatch(/\| 구현 \|.*\| 3 \|$/m);
		expect(team).toMatch(/\| 리뷰 \|.*\| 5 \|$/m);
	});

	test("other agents: substitute with another role, or block", async () => {
		const OTHER = "실행 중 다른 에이전트: 구현 역할 모델로 대체";
		const sub = fakeUi([...TO_SETTINGS, OTHER, "리뷰 역할 모델로 바꾸기", "다음", "승인 후 저장"]);
		const r1 = await runSetupInterview(sub.ui, makeInput());
		if (r1.status !== "approved") throw new Error(JSON.stringify(r1));
		expect(r1.config.fallbackRole).toBe("reviewer");
		expect(r1.scope.fallbackRole).toBe("reviewer");
		expect(sub.options("실행 중 다른 에이전트 처리 (현재: 구현 역할 모델)")).toEqual([
			"탐색 역할 모델로 바꾸기",
			"구현 역할 모델로 바꾸기",
			"리뷰 역할 모델로 바꾸기",
			"차단",
			"뒤로",
		]);

		const block = fakeUi([...TO_SETTINGS, OTHER, "차단", "실행 중 다른 에이전트: 차단", "뒤로", "다음", "승인 후 저장"]);
		const r2 = await runSetupInterview(block.ui, makeInput());
		if (r2.status !== "approved") throw new Error(JSON.stringify(r2));
		expect(r2.config.fallbackRole).toBeUndefined();
		expect("fallbackRole" in r2.scope).toBe(false);
		expect(block.selects.some((s) => s.title === "실행 중 다른 에이전트 처리 (현재: 차단)")).toBe(true);
		expect(block.reports.find((x) => x.title === "저장할 설정")!.md).toContain("- 실행 중 다른 에이전트: 차단");
	});

	test("re-running setup keeps workers, a deliberate block and trials from the current config", async () => {
		const current: StormConfig = {
			...cfg("a/x"),
			roles: { explorer: { agent: "storm-explorer", models: ["a/x"], effort: "low", workers: 4 }, reviewer: { agent: "storm-reviewer", models: ["b/r"], workers: 1 } },
			trials: [trialCfg],
		};
		const f = fakeUi(ACCEPT);
		const r = await runSetupInterview(f.ui, makeInput({ current: { config: current, hash: "h", approved: true } }));
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/x:low", "b/z:low"], workers: 4 });
		expect(r.config.fallbackRole).toBeUndefined();
		expect(r.config.trials).toEqual([trialCfg]);
		expect(r.scope.trials).toEqual([trialCfg]);
		expect(f.reports.find((x) => x.title === "추천 팀 구성")!.md).toContain("- 시험:\n  - 리뷰 · c/cand:high · 비율 25% · 최대 10회");
		// The old role-level effort is shown going away; the new models carry it per entry.
		expect(f.reports.find((x) => x.title === "저장할 설정")!.md).toContain("- explorer effort: low → —");
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
		expect(c.roles.explorer).toEqual({ agent: "storm-explorer", models: ["b/custom:thinking:max", "a/x:low"], workers: 2 });
		expect(c.roles.implementer).toEqual({ agent: "storm-implementer", models: ["c/j"], workers: 1 });
		expect(c.roles.reviewer).toBeUndefined();
		expect(deriveScope(c, []).providers).toEqual(["a", "b", "c"]);
	});

	test("defaults: explorer 2 workers, others 1, fallback implementer only when that role exists", () => {
		const full = buildConfig(recs(), all, opts);
		expect(full.fallbackRole).toBe("implementer");
		expect(Object.values(full.roles).map((r) => r.workers)).toEqual([2, 1, 1]);
		const noImpl = buildConfig(recs(), { explorer: all.explorer, reviewer: all.reviewer }, opts);
		expect("fallbackRole" in noImpl).toBe(false);
		const blocked = buildConfig(recs(), { explorer: all.explorer, implementer: all.implementer }, { ...opts, fallbackRole: null, workers: { explorer: 6 } });
		expect("fallbackRole" in blocked).toBe(false);
		expect(blocked.roles.explorer!.workers).toBe(6);
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
		expect(f.reports[0]!.md).toContain("a/y → a/x");
		expect(f.reports[0]!.md).toContain(shadow.path);
	});

	test("runRollback branches", async () => {
		const opt: RollbackOption = { hash: "jcs-sha256:0123456789abcdef", approvedAt: "2026-01-02T03:04:05Z", config: cfg("a/old") };
		const probe = fakeUi(["취소"]);
		expect(await runRollback(probe.ui, { options: [opt] })).toEqual({ status: "cancelled" });
		const label = probe.selects[0]!.options[0]!;
		expect(label).toContain("0123456789ab ·");
		expect(label).toContain("explorer=a/old");
		expect(await runRollback(fakeUi([label, "승인 후 되돌리기"]).ui, { options: [opt], current: cfg("a/x") })).toEqual({ status: "approved", option: opt });
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
		expect(md).toContain("/storm review");
		expect(md).toContain("omp --max-cost 3");
		expect(md).toContain("사용 —");
		expect(md).toContain(shadow.path);
	});

	test("v0.1 status view renders none of the v0.2 sections", () => {
		const md = renderStatus(statusBase(), 0);
		for (const h of ["### 실행 중", "### 마지막 실행", "### 시험", "### 쿼터 소진 표시", "### 승인 대기", "다른 에이전트", "워커"]) {
			expect(md).not.toContain(h);
		}
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
		expect(md).toContain("### 승인 대기 제안 (2건)\n- 워커 수 변경: 구현 1 → 3\n- 우선순위 변경: 균형 → 비용 우선\n- /storm review 로 승인하세요");
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
		expect(diff).toContain("- explorer 워커: 1 → 3");
		expect(diff).toContain("- 실행 중 다른 에이전트: 차단 → 탐색 역할 모델로 대체");
		expect(diff).toContain("- 예산: 없음 → 실행당 $2, 초과 시 stop");
		expect(diff).toMatch(/- 시험 reviewer-c: .*비율 25% .* → .*비율 50%/);
		expect(diff).toContain("- 시험 gone: 삭제");
		expect(diff).toMatch(/- 시험 new: 추가 · 리뷰 · c\/cand:high · 비율 25% · 최대 10회 · .* ~ .* · 예산 \$5/);
		expect(renderConfigDiff(next, structuredClone(next))).toBe("변경 없음");
		expect(renderConfigDiff(cfg("a/x"), { ...cfg("a/x"), roles: { explorer: { agent: "storm-explorer", models: ["a/x"], workers: 1 } } })).toBe("변경 없음");
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

describe("render per-model effort", () => {
	test("status lists entries as written and the role effort only when set", () => {
		const view = (roles: StormConfig["roles"]): StatusView => ({
			...statusBase(),
			config: { status: "ok", path: "/r/c", config: { ...cfg("a/x"), roles }, hash: "jcs-sha256:abcdef0123456789", rawSha256: "x", warnings: [] },
		});
		const md = renderStatus(view({ explorer: { agent: "storm-explorer", models: ["mistral/x:max", "anthropic/y:low"] } }), 0);
		expect(md).toContain("- explorer: mistral/x:max → anthropic/y:low\n");
		const legacy = renderStatus(view({ explorer: { agent: "storm-explorer", models: ["a/x", "b/y:max"], effort: "low" } }), 0);
		expect(legacy).toContain("- explorer: a/x → b/y:max · low\n");
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
