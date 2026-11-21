import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildBudget, buildQuota, buildReselect, buildSettings, buildTrial, buildWorkers, newProposalId, quotaPlan, trialId } from "../src/proposals/build.ts";
import { presentProposal, renderProposal } from "../src/proposals/present.ts";
import { createProposalStore } from "../src/proposals/store.ts";
import { ROLES } from "../src/roles.ts";
import type { Candidate, Effort, EvidenceRecord, Proposal, ShadowInfo, StormConfig, UiContext, UiPort, UiSelectItem } from "../src/types.ts";

const NOW = Date.parse("2026-11-20T09:30:00Z");

const base: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		explorer: { agent: "storm-explorer", models: ["a/x", "b/z"], effort: "low" },
		implementer: { agent: "storm-implementer", models: ["a/i"] },
		reviewer: { agent: "storm-reviewer", models: ["b/r"], effort: "high" },
	},
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
	runtime: "omp",
};

function proposal(id: string, baseHash: string, createdAt: string, config: StormConfig = base): Proposal {
	return { schema: "storm.proposal/v1", id, kind: "workers", createdAt, summary: `s-${id}`, baseHash, config };
}

function fakeUi(answer: string | undefined) {
	const reports: Array<{ title: string; md: string }> = [];
	const selects: Array<{ title: string; options: string[]; context?: UiContext }> = [];
	const ui: UiPort = {
		async select(title: string, options: UiSelectItem[], context?: UiContext) {
			selects.push({ title, options: options.map((o) => (typeof o === "string" ? o : o.label)), ...(context ? { context } : {}) });
			return answer;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify() {},
		async report(title: string, md: string) {
			reports.push({ title, md });
		},
		record(title: string, md: string) {
			reports.push({ title, md });
		},
	};
	return { ui, reports, selects };
}

describe("proposal store", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "storm-proposals-"));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("lists current proposals newest first and deletes stale ones", async () => {
		let hash: string | null = "h1";
		const store = createProposalStore(root, async () => hash);
		expect(await store.list()).toEqual([]);
		await store.save(proposal("p1", "h1", "2026-11-20T01:00:00.000Z"));
		await store.save(proposal("p2", "h1", "2026-11-20T02:00:00.000Z"));
		await store.save(proposal("old", "h0", "2026-11-20T03:00:00.000Z"));
		const dir = path.join(root, ".omp", "storm", "state", "proposals");
		await fs.writeFile(path.join(dir, "broken.json"), "{not json");
		await fs.writeFile(path.join(dir, "other.json"), JSON.stringify({ schema: "x" }));

		expect((await store.list()).map((p) => p.id)).toEqual(["p2", "p1"]);
		const files = (await fs.readdir(dir)).sort();
		expect(files).toEqual(["broken.json", "other.json", "p1.json", "p2.json"]);

		await store.remove("p1");
		expect((await store.list()).map((p) => p.id)).toEqual(["p2"]);

		hash = null;
		expect(await store.list()).toEqual([]);
		expect((await fs.readdir(dir)).sort()).toEqual(["broken.json", "other.json"]);
	});

	test("rejects ids that could escape the directory", async () => {
		const store = createProposalStore(root, async () => "h");
		await expect(store.save(proposal("../x", "h", "2026-11-20T00:00:00.000Z"))).rejects.toThrow();
		await expect(store.remove("a/b")).rejects.toThrow();
	});
});

describe("presentProposal", () => {
	const next = structuredClone(base);
	next.roles.implementer!.models = ["c/j", "a/i"];
	const evidence: EvidenceRecord = {
		schema: "storm.evidence/v1",
		createdAt: new Date(NOW).toISOString(),
		source: "reselect",
		priority: "balanced",
		dataAsOf: null,
		roles: {
			implementer: {
				chosen: "c/j",
				candidates: [
					{ selector: "c/j", label: "J", validated: true, int: 60, speed: null, referenceUsd: 0.01, why: ["많이 씀"], whyNot: [] },
					{ selector: "a/i", label: "I", validated: false, int: null, speed: 90, referenceUsd: null, why: [], whyNot: ["느림"] },
				],
			},
			reviewer: { chosen: "b/r", candidates: [{ selector: "b/r", label: "R", validated: false, int: 1, speed: 1, referenceUsd: 1, why: ["리뷰 근거"], whyNot: [] }] },
		},
	};
	const p: Proposal = { ...proposal("p", "h", "2026-11-20T00:00:00.000Z", next), summary: "구현 모델 교체", evidence };

	test("renders summary, diff and evidence of changed roles only", () => {
		const md = renderProposal(p, base);
		expect(md).toContain("**구현 모델 교체**");
		expect(md).toContain("implementer 모델: a/i → c/j, a/i");
		expect(md).toContain("- 구현: 선택 c/j");
		expect(md).toContain("J (c/j) · 지능 60 · — tok/s · $0.0100");
		expect(md).toContain("근거: 많이 씀");
		expect(md).toContain("제외 이유: 느림");
		expect(md).not.toContain("리뷰 근거");
	});

	test("only the exact approval label approves; the proposal is the select's context", async () => {
		const cases: Array<[string | undefined, "approved" | "deferred" | "cancelled"]> = [
			["승인", "approved"],
			["취소", "cancelled"],
			["나중에", "deferred"],
			[undefined, "deferred"],
			["승인 ", "deferred"],
			["approve", "deferred"],
		];
		for (const [answer, outcome] of cases) {
			const f = fakeUi(answer);
			expect(await presentProposal(f.ui, p, base)).toBe(outcome);
			expect(f.reports).toEqual([]);
			expect(f.selects).toEqual([
				{ title: "이 변경을 승인할까요?", options: ["승인", "나중에", "취소"], context: { title: "Storm 변경 제안", markdown: renderProposal(p, base) } },
			]);
		}
	});

	test("shadows and warnings join the context", async () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project", sha256: "ab" };
		const f = fakeUi("승인");
		await presentProposal(f.ui, p, base, { shadows: [shadow], warnings: ["z/z: 지금 쓸 수 있는 모델 목록에 없습니다"] });
		const md = f.selects[0]!.context!.markdown;
		expect(md).toContain("### 경고\n- z/z: 지금 쓸 수 있는 모델 목록에 없습니다");
		expect(md).toContain("### 경고: 가림 정의");
		expect(md).toContain(shadow.path);
	});

	test("a setup proposal shows the whole team and the rationale, and offers no deferral", async () => {
		const setup: Proposal = { ...p, kind: "setup", summary: "Storm 팀 설정 제안", evidence: { ...evidence, source: "setup", rationale: "빠른 탐색, 꼼꼼한 리뷰" } };
		const md = renderProposal(setup, undefined);
		expect(md).toContain("### 팀 구성\n새 설정");
		expect(md).toContain("- explorer 모델: a/x");
		expect(md).toContain("### 근거\n빠른 탐색, 꼼꼼한 리뷰");
		// Without a current config every role counts as changed.
		expect(md).toContain("리뷰 근거");
		for (const [answer, outcome] of [["승인", "approved"], ["나중에", "cancelled"], [undefined, "cancelled"]] as const) {
			const f = fakeUi(answer);
			expect(await presentProposal(f.ui, setup, undefined)).toBe(outcome);
			expect(f.selects[0]).toMatchObject({ options: ["승인", "취소"], context: { title: "Storm 팀 제안" } });
		}
	});
});

describe("builders", () => {
	test("newProposalId is time-ordered and filename-safe", () => {
		const a = newProposalId(NOW);
		expect(a).toMatch(/^20261120T093000Z-[0-9a-f]{8}$/);
		expect(newProposalId(NOW + 1000) > a).toBe(true);
	});

	test("quotaPlan finds roles whose primary is on the provider", () => {
		expect(quotaPlan(base, "a")).toEqual([
			{ role: "explorer", from: "a/x", alternative: "b/z" },
			{ role: "implementer", from: "a/i", alternative: null },
		]);
		expect(quotaPlan(base, "b")).toEqual([{ role: "reviewer", from: "b/r", alternative: null }]);
		expect(quotaPlan(base, "zzz")).toEqual([]);
	});

	test("buildQuota appends the best off-provider candidate as a fallback", () => {
		const recs = [
			{ role: ROLES[1]!, candidates: [], chosenIndex: -1, excluded: [] },
		];
		expect("error" in buildQuota(base, "a", ["implementer"], recs)).toBe(true);
	});

	test("per-model entries are matched by selector, not by their effort suffix", () => {
		const suffixed: StormConfig = {
			...base,
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x:max", "b/z:low"] },
				reviewer: { agent: "storm-reviewer", models: ["c/j:high"], effort: "low" },
			},
		};
		expect(quotaPlan(suffixed, "a")).toEqual([{ role: "explorer", from: "a/x:max", alternative: "b/z:low" }]);
		const input = { role: "reviewer", model: "c/j", efforts: ["low", "high"] as Effort[], now: NOW };
		expect(buildTrial(suffixed, input)).toHaveProperty("error");
		// The trial starts from the primary's own effort, not the role default.
		const trial = buildTrial({ ...suffixed, roles: { ...suffixed.roles, reviewer: { agent: "storm-reviewer", models: ["b/r:high"], effort: "low" } } }, input);
		if ("error" in trial) throw new Error(trial.error);
		expect(trial.config.trials![0]!.effort).toBe("high");
		const metric = { value: 50, source: "catalog", confidence: "medium" } as const;
		const z: Candidate = {
			selector: "b/z",
			modelKey: "b/z",
			label: "z",
			effort: "medium",
			tier: "general",
			int: metric,
			speed: metric,
			referenceUsd: null,
			userMixUsd: null,
			quota: "available",
			confidence: "medium",
			validated: false,
			why: [],
			whyNot: [],
		};
		const recs = [{ role: ROLES[0]!, candidates: [z], chosenIndex: 0, excluded: [] }];
		const quota = buildQuota({ ...suffixed, roles: { explorer: { agent: "storm-explorer", models: ["a/x:max", "b/z:low"] } } }, "a", ["explorer"], recs);
		if ("error" in quota) throw new Error(quota.error);
		expect(quota.config.roles.explorer!.models).toEqual(["a/x:max", "b/z:medium"]);
	});

	test("workers bounds and range form", () => {
		expect(buildWorkers(base, "implementer", 0, 2)).toHaveProperty("error");
		expect(buildWorkers(base, "implementer", undefined, 17)).toHaveProperty("error");
		expect(buildWorkers(base, "implementer", 1.5, undefined)).toHaveProperty("error");
		expect(buildWorkers(base, "implementer", 3, 2)).toHaveProperty("error");
		expect(buildWorkers(base, "implementer", undefined, undefined)).toHaveProperty("error");
		expect(buildWorkers(base, "nope", 2, 2)).toHaveProperty("error");
		// implementer unset → default 1~2; raising max keeps min.
		const wide = buildWorkers(base, "implementer", undefined, 4);
		if ("error" in wide) throw new Error(wide.error);
		expect(wide.config.roles.implementer!.workers).toEqual({ min: 1, max: 4 });
		// A legacy number reads as n~n; a min above it lifts max along.
		const legacy = buildWorkers({ ...base, roles: { ...base.roles, implementer: { ...base.roles.implementer!, workers: 2 } } }, "implementer", 3, undefined);
		if ("error" in legacy) throw new Error(legacy.error);
		expect(legacy.config.roles.implementer!.workers).toEqual({ min: 3, max: 3 });
		expect(base.roles.implementer!.workers).toBeUndefined();
	});

	test("trial bounds", () => {
		const input = { role: "reviewer", model: "c/j", efforts: ["low", "high"] as const, now: NOW };
		const bad: Array<Record<string, number>> = [
			{ share: 0 },
			{ share: 1.01 },
			{ share: Number.NaN },
			{ maxSpawns: 0 },
			{ maxSpawns: 1001 },
			{ maxSpawns: 2.5 },
			{ days: 0.5 },
			{ days: 31 },
			{ budgetUsd: 0 },
			{ budgetUsd: -1 },
		];
		for (const b of bad) expect(buildTrial(base, { ...input, efforts: [...input.efforts], ...b })).toHaveProperty("error");
		expect(buildTrial(base, { ...input, efforts: [], model: "b/r" })).toHaveProperty("error");
		const edge = buildTrial(base, { ...input, efforts: [], share: 1, maxSpawns: 1000, days: 30, budgetUsd: 0.01 });
		expect(edge).not.toHaveProperty("error");
	});

	test("trial ids are slugged and dated", () => {
		expect(trialId("reviewer", "openrouter/Anthropic/Claude-5.5:high", NOW)).toBe("reviewer-openrouter-anthropic-claude-5-5-high-20261120");
	});

	test("budget set, default warning, removal and bad warning", () => {
		const set = buildBudget(base, 5, undefined, undefined);
		if ("error" in set) throw new Error(set.error);
		expect(set.config.budget).toEqual({ perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" });
		expect(buildBudget(base, 5, 5, undefined)).toHaveProperty("error");
		expect(buildBudget(base, 5, 0, undefined)).toHaveProperty("error");
		expect(buildBudget(base, -1, undefined, undefined)).toHaveProperty("error");
		expect(buildBudget(base, 0, undefined, undefined)).toHaveProperty("error");
		const off = buildBudget(set.config, 0, undefined, undefined);
		if ("error" in off) throw new Error(off.error);
		expect(off.config.budget).toBeUndefined();
	});

	test("settings keep only non-default switches, so turning one back restores the original config", () => {
		expect(buildSettings(base, undefined, undefined)).toHaveProperty("error");
		const on = buildSettings(base, true, false);
		if ("error" in on) throw new Error(on.error);
		expect(on.config.cleanup).toBe(true);
		expect(on.config.docs).toBe(false);
		const back = buildSettings(on.config, false, true);
		if ("error" in back) throw new Error(back.error);
		expect(back.config).toEqual(base);
	});
});

describe("role-targeted proposals for a role not in roles", () => {
	const disabled: StormConfig = { ...base, disabledRoles: ["architect"] };
	test("a disabled role points to team re-setup; a missing one says it is not configured", () => {
		const off = "설계·자문(architect): 사용 안 함으로 설정된 역할입니다. 다시 쓰려면 /storm 에서 팀 다시 설정을 고르세요";
		expect(buildWorkers(disabled, "architect", 2, 2)).toEqual({ error: off });
		expect(buildReselect(disabled, "architect", "a/new", ["high"])).toEqual({ error: off });
		expect(buildTrial(disabled, { role: "architect", model: "a/new", efforts: ["high"], now: 0 })).toEqual({ error: off });
		expect(buildWorkers(disabled, "quick", 2, 2)).toEqual({ error: "quick: 설정에 없는 역할입니다" });
	});
});
