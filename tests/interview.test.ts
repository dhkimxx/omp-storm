import { describe, expect, test } from "bun:test";
import { ROLES } from "../src/roles.ts";
import type {
	Analysis,
	Candidate,
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
import { renderAnalysis, renderConfigDiff, renderEvidence, renderStatus, renderTeam } from "../src/interview/render.ts";
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
	return { ui, reports, notes, selects, left: () => queue.length };
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
		checkModel: (s) => (s === "e/good" ? { ok: true, label: "Good", efforts: ["low", "medium", "high"] } : { ok: false, reason: "카탈로그에 없음" }),
		defaults: { parallelism: 4, isolation: "isolated", contract: "workflowz" },
		priority: "balanced",
		...over,
	};
}
const ACCEPT = ["계속", "균형", "전체 수락", "승인 후 저장"];

describe("runSetupInterview", () => {
	test("accept all builds models with cross-provider fallback and efforts", async () => {
		const f = fakeUi(ACCEPT);
		const r = await runSetupInterview(f.ui, makeInput());
		expect(r.status).toBe("approved");
		if (r.status !== "approved") return;
		expect(r.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/x", "b/z"], effort: "low", workers: 2 });
		expect(r.config.roles.implementer).toEqual({ agent: "storm-implementer", models: ["a/i", "c/j"], workers: 1 });
		expect(r.config.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["b/r"], effort: "high", workers: 1 });
		expect(r.config).toMatchObject({ version: 1, runtime: "omp", parallelism: 4, priority: "balanced", fallbackRole: "implementer" });
		expect(r.scope.fallbackRole).toBe("implementer");
		expect(f.reports.find((x) => x.title === "추천 팀 구성")!.md).toContain("- 실행 중 다른 에이전트: 구현 역할 모델로 대체");
		expect(r.scope.providers).toEqual(["a", "b", "c"]);
		expect(f.left()).toBe(0);
	});

	test("cancel or undefined at each step reports that step", async () => {
		const cases: Array<[Answer[], string]> = [
			[["취소"], "summary"],
			[[undefined], "summary"],
			[["계속", undefined], "priority"],
			[["계속", "균형", "취소"], "review"],
			[["계속", "균형", "항목 수정", undefined], "edit"],
			[["계속", "균형", "항목 수정", "역할: 탐색", undefined], "edit"],
			[["계속", "균형", "전체 수락", "취소"], "final"],
			[["계속", "균형", "전체 수락", "승인"], "final"],
			[["계속", "균형", "전체 수락", undefined], "final"],
		];
		for (const [answers, at] of cases) {
			const r = await runSetupInterview(fakeUi(answers).ui, makeInput());
			expect(r).toEqual({ status: "cancelled", at });
		}
	});

	test("back navigates to previous steps", async () => {
		const f = fakeUi(["계속", "뒤로", "계속", "균형", "뒤로", "균형", "전체 수락", "뒤로", "항목 수정", "뒤로", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput());
		expect(r.status).toBe("approved");
		expect(f.reports.filter((x) => x.title === "Storm 탐지 요약").length).toBe(2);
	});

	test("priority change rerecommends and resets picks", async () => {
		const input = makeInput();
		const f = fakeUi(["계속", "비용 우선", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, input);
		expect(input.calls).toEqual(["cost"]);
		if (r.status !== "approved") throw new Error(r.status);
		expect(r.config.priority).toBe("cost");
		expect(r.config.roles.explorer!.models[0]).toBe("a/x2");
	});

	test("changing a role candidate and parallelism/budget", async () => {
		const label = "y · 일반 · 지능 50 · 100 tok/s · $0.0200";
		const f = fakeUi(["계속", "균형", "항목 수정", "역할: 탐색", label, "병렬도", "17", "8", "예산", "2", "뒤로", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/y", "b/z"], effort: "medium", workers: 2 });
		expect(r.config.parallelism).toBe(8);
		expect(r.config.budget).toEqual({ perRunUsd: 2, warnAtUsd: 1.6, onExceed: "block-spawns" });
		expect(f.notes.length).toBe(1);
	});

	test("custom input failure notifies and re-asks", async () => {
		const f = fakeUi(["계속", "균형", "항목 수정", "역할: 리뷰", "직접 입력", "e/bad", "e/good", "뒤로", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(f.notes.some((n) => n.includes("카탈로그에 없음"))).toBe(true);
		expect(r.config.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["e/good", "b/r"], effort: "medium", workers: 1 });
	});

	test("role without candidates blocks final until custom input", async () => {
		const rs = recs();
		rs[2] = { ...rs[2]!, candidates: [], chosenIndex: -1 };
		const f = fakeUi(["계속", "균형", "전체 수락", "항목 수정", "역할: 리뷰", "직접 입력", "e/good", "뒤로", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput({ recommendations: rs }));
		expect(f.reports.find((x) => x.title === "추천 팀 구성")!.md).toContain("후보 없음");
		expect(f.notes.length).toBe(1);
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles.reviewer!.models).toEqual(["e/good"]);
	});

	test("shadows are shown and recorded in scope", async () => {
		const f = fakeUi(ACCEPT);
		const r = await runSetupInterview(f.ui, makeInput({ shadows: [shadow] }));
		expect(f.reports.find((x) => x.title === "저장할 설정")!.md).toContain(shadow.path);
		if (r.status !== "approved") throw new Error(r.status);
		expect(r.scope.shadowedAgents).toEqual([shadow]);
	});

	test("edit menu keeps v0.1 labels and adds workers and other-agent items", async () => {
		const f = fakeUi(["계속", "균형", "항목 수정", undefined]);
		await runSetupInterview(f.ui, makeInput());
		expect(f.selects.find((s) => s.title === "수정할 항목")!.options).toEqual([
			"역할: 탐색",
			"역할: 구현",
			"역할: 리뷰",
			"병렬도",
			"실행 계약",
			"예산",
			"워커 수",
			"다른 에이전트 처리",
			"뒤로",
		]);
	});

	test("workers: preset, custom input with re-ask, and back", async () => {
		const f = fakeUi([
			"계속", "균형", "항목 수정",
			"워커 수", "구현", "3",
			"워커 수", "리뷰", "직접 입력", "0", "5",
			"워커 수", "탐색", "뒤로",
			"워커 수", "뒤로",
			"뒤로", "전체 수락", "승인 후 저장",
		]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(Object.fromEntries(Object.entries(r.config.roles).map(([id, x]) => [id, x.workers]))).toEqual({ explorer: 2, implementer: 3, reviewer: 5 });
		expect(r.scope.roles.reviewer!.workers).toBe(5);
		expect(f.notes).toEqual(["1에서 16 사이 정수를 입력하세요."]);
		expect(f.selects.find((s) => s.title === "구현 워커 수 (현재: 1)")!.options).toEqual(["1", "2", "3", "4", "직접 입력", "뒤로"]);
		expect(f.selects.find((s) => s.title === "워커 수를 바꿀 역할")!.options).toEqual(["탐색", "구현", "리뷰", "뒤로"]);
		const team = f.reports.filter((x) => x.title === "추천 팀 구성").at(-1)!.md;
		expect(team).toContain("| 워커 |");
		expect(team).toMatch(/\| 구현 \|.*\| 3 \|$/m);
		expect(team).toMatch(/\| 리뷰 \|.*\| 5 \|$/m);
	});

	test("other agents: substitute with another role, or block", async () => {
		const sub = fakeUi(["계속", "균형", "항목 수정", "다른 에이전트 처리", "리뷰 역할 모델로 바꾸기", "뒤로", "전체 수락", "승인 후 저장"]);
		const r1 = await runSetupInterview(sub.ui, makeInput());
		if (r1.status !== "approved") throw new Error(JSON.stringify(r1));
		expect(r1.config.fallbackRole).toBe("reviewer");
		expect(r1.scope.fallbackRole).toBe("reviewer");
		expect(sub.selects.find((s) => s.title.startsWith("실행 중 다른 에이전트 처리"))).toEqual({
			title: "실행 중 다른 에이전트 처리 (현재: 구현 역할 모델)",
			options: ["탐색 역할 모델로 바꾸기", "구현 역할 모델로 바꾸기", "리뷰 역할 모델로 바꾸기", "차단", "뒤로"],
		});

		const block = fakeUi(["계속", "균형", "항목 수정", "다른 에이전트 처리", "차단", "다른 에이전트 처리", "뒤로", "뒤로", "전체 수락", "승인 후 저장"]);
		const r2 = await runSetupInterview(block.ui, makeInput());
		if (r2.status !== "approved") throw new Error(JSON.stringify(r2));
		expect(r2.config.fallbackRole).toBeUndefined();
		expect("fallbackRole" in r2.scope).toBe(false);
		expect(block.selects.filter((s) => s.title.startsWith("실행 중 다른 에이전트 처리")).at(-1)!.title).toBe("실행 중 다른 에이전트 처리 (현재: 차단)");
		expect(block.reports.find((x) => x.title === "저장할 설정")!.md).toContain("- 실행 중 다른 에이전트: 차단");
	});

	test("cancelling the new dialogs reports the edit step", async () => {
		const cases: Answer[][] = [
			["계속", "균형", "항목 수정", "워커 수", undefined],
			["계속", "균형", "항목 수정", "워커 수", "탐색", undefined],
			["계속", "균형", "항목 수정", "워커 수", "탐색", "직접 입력", undefined],
			["계속", "균형", "항목 수정", "다른 에이전트 처리", undefined],
		];
		for (const answers of cases) expect(await runSetupInterview(fakeUi(answers).ui, makeInput())).toEqual({ status: "cancelled", at: "edit" });
	});

	test("re-running setup keeps workers, a deliberate block and trials from the current config", async () => {
		const current: StormConfig = {
			...cfg("a/x"),
			roles: { explorer: { agent: "storm-explorer", models: ["a/x"], workers: 4 }, reviewer: { agent: "storm-reviewer", models: ["b/r"], workers: 1 } },
			trials: [trialCfg],
		};
		const f = fakeUi(ACCEPT);
		const r = await runSetupInterview(f.ui, makeInput({ current: { config: current, hash: "h", approved: true } }));
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(r.config.roles.explorer!.workers).toBe(4);
		expect(r.config.fallbackRole).toBeUndefined();
		expect(r.config.trials).toEqual([trialCfg]);
		expect(r.scope.trials).toEqual([trialCfg]);
		expect(f.reports.find((x) => x.title === "추천 팀 구성")!.md).toContain("- 시험:\n  - 리뷰 · c/cand:high · 비율 25% · 최대 10회");
	});
});

describe("buildConfig / deriveScope", () => {
	const opts = { priority: "speed", parallelism: 2, isolation: "shared", contract: "orchestrate" } as const;

	test("custom pick takes explicit effort and omits null", () => {
		const c = buildConfig(recs(), { explorer: "b/custom", implementer: 1 }, { ...opts, efforts: { explorer: null } });
		expect(c.roles.explorer).toEqual({ agent: "storm-explorer", models: ["b/custom", "a/x"], workers: 2 });
		expect(c.roles.implementer).toEqual({ agent: "storm-implementer", models: ["c/j", "a/i"], effort: "medium", workers: 1 });
		expect(c.roles.reviewer).toBeUndefined();
		expect(deriveScope(c, []).providers).toEqual(["a", "b", "c"]);
	});

	test("defaults: explorer 2 workers, others 1, fallback implementer only when that role exists", () => {
		const all = buildConfig(recs(), { explorer: 0, implementer: 0, reviewer: 0 }, opts);
		expect(all.fallbackRole).toBe("implementer");
		expect(Object.values(all.roles).map((r) => r.workers)).toEqual([2, 1, 1]);
		const noImpl = buildConfig(recs(), { explorer: 0, reviewer: 0 }, opts);
		expect("fallbackRole" in noImpl).toBe(false);
		const blocked = buildConfig(recs(), { explorer: 0, implementer: 0 }, { ...opts, fallbackRole: null, workers: { explorer: 6 } });
		expect("fallbackRole" in blocked).toBe(false);
		expect(blocked.roles.explorer!.workers).toBe(6);
		expect(buildConfig(recs(), { reviewer: 0 }, { ...opts, fallbackRole: "toString" }).fallbackRole).toBeUndefined();
	});

	test("trials are kept only for roles in the config", () => {
		const orphan = { ...trialCfg, id: "x", role: "implementer" };
		const c = buildConfig(recs(), { reviewer: 0 }, { ...opts, trials: [trialCfg, orphan] });
		expect(c.trials).toEqual([trialCfg]);
		expect("trials" in buildConfig(recs(), { explorer: 0 }, { ...opts, trials: [trialCfg] })).toBe(false);
	});

	test("deriveScope copies fallbackRole and trials only when present", () => {
		const c: StormConfig = { ...cfg("a/x"), fallbackRole: "explorer", trials: [trialCfg] };
		const scope = deriveScope(c, []);
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
		expect(renderTeam(rs, { explorer: 0 }, { parallelism: 1, isolation: "isolated", contract: "workflowz" })).toContain("| 탐색 | x (a/x) | medium | — |");
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
