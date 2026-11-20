import { describe, expect, test } from "bun:test";
import { ROLES } from "../src/roles.ts";
import type {
	Analysis,
	Candidate,
	InterviewInput,
	MetricValue,
	Priority,
	RoleRecommendation,
	RollbackOption,
	ShadowInfo,
	StormConfig,
	UiPort,
	UiSelectItem,
} from "../src/types.ts";
import { renderAnalysis, renderEvidence, renderStatus, renderTeam } from "../src/interview/render.ts";
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
		expect(r.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/x", "b/z"], effort: "low" });
		expect(r.config.roles.implementer).toEqual({ agent: "storm-implementer", models: ["a/i", "c/j"] });
		expect(r.config.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["b/r"], effort: "high" });
		expect(r.config).toMatchObject({ version: 1, runtime: "omp", parallelism: 4, priority: "balanced" });
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
		expect(r.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/y", "b/z"], effort: "medium" });
		expect(r.config.parallelism).toBe(8);
		expect(r.config.budget).toEqual({ perRunUsd: 2, warnAtUsd: 1.6, onExceed: "block-spawns" });
		expect(f.notes.length).toBe(1);
	});

	test("custom input failure notifies and re-asks", async () => {
		const f = fakeUi(["계속", "균형", "항목 수정", "역할: 리뷰", "직접 입력", "e/bad", "e/good", "뒤로", "전체 수락", "승인 후 저장"]);
		const r = await runSetupInterview(f.ui, makeInput());
		if (r.status !== "approved") throw new Error(JSON.stringify(r));
		expect(f.notes.some((n) => n.includes("카탈로그에 없음"))).toBe(true);
		expect(r.config.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["e/good", "b/r"], effort: "medium" });
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
});

describe("buildConfig / deriveScope", () => {
	test("custom pick takes explicit effort and omits null", () => {
		const c = buildConfig(recs(), { explorer: "b/custom", implementer: 1 }, { priority: "speed", parallelism: 2, isolation: "shared", contract: "orchestrate", efforts: { explorer: null } });
		expect(c.roles.explorer).toEqual({ agent: "storm-explorer", models: ["b/custom", "a/x"] });
		expect(c.roles.implementer).toEqual({ agent: "storm-implementer", models: ["c/j", "a/i"], effort: "medium" });
		expect(c.roles.reviewer).toBeUndefined();
		expect(deriveScope(c, []).providers).toEqual(["a", "b", "c"]);
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
});
