import { describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { ApprovalStore } from "../src/approval/store.ts";
import { configHash } from "../src/config/canonical.ts";
import { ROLES } from "../src/roles.ts";
import type { ProjectState } from "../src/state.ts";
import type { RunRequestResult, StormToolHost } from "../src/tool/host.ts";
import { createStormTool, runStormTool, type StormToolInput } from "../src/tool/storm-tool.ts";
import type {
	AgentEntry,
	Analysis,
	AnalysisContext,
	ApprovalScope,
	Candidate,
	EvidenceRecord,
	LifecycleSettings,
	MetricValue,
	ModelInfo,
	Proposal,
	QuotaMark,
	RepoIdentity,
	RoleRecommendation,
	ShadowInfo,
	StormConfig,
	TrialConfig,
	UiContext,
	UiPort,
	UiSelectItem,
} from "../src/types.ts";

const NOW = Date.parse("2026-11-20T09:00:00Z");
const repo: RepoIdentity = { repoId: "dir-test-000000000000000000000000", kind: "dir", root: "/repo" };

/** An answer, or a hook run when the dialog opens (to change state underneath) that then answers. */
type Answer = string | undefined | (() => string | undefined);

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
function recs(tag = ""): RoleRecommendation[] {
	return [
		{ role: ROLES[0]!, candidates: [cand(`a/x${tag}`, { effort: "low" }), cand(`a/y${tag}`), cand(`b/z${tag}`)], chosenIndex: 0, excluded: [] },
		{ role: ROLES[1]!, candidates: [cand(`a/i${tag}`, { effort: null }), cand(`c/j${tag}`)], chosenIndex: 0, excluded: [] },
		{ role: ROLES[2]!, candidates: [cand(`b/r${tag}`, { effort: "high" })], chosenIndex: 0, excluded: [] },
	];
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
	dataAsOf: null,
	preferences: {
		main: { cheap: [], general: [], premium: [], unknown: [] },
		subagent: { cheap: [], general: [], premium: [], unknown: [] },
	},
	stopped: [],
	newer: [],
	alternatives: {},
	warnings: [],
};

function fakeCtx(): AnalysisContext {
	const selectors = recs().flatMap((r) => r.candidates.map((c) => c.selector));
	const catalog = [
		...[...selectors, ...recs("2").flatMap((r) => r.candidates.map((c) => c.selector))].map((s) => model(s)),
		model("c/cand", { efforts: ["low", "medium"] }),
		model("d/small", { contextWindow: 32_000 }),
		model("e/noeffort", { efforts: [] }),
		model("f/notools", { supportsTools: false }),
	];
	return {
		now: NOW,
		catalog,
		available: catalog,
		quota: [],
		explicit: { modelRoles: {}, agentModelOverrides: {} },
		usage: { status: "ok", dbPath: "", windowDays: 30, now: NOW, dataAsOf: NOW - 3_600_000, rows: [] },
		analysis,
		lineage: (_p, id) => ({
			modelKey: `${id}/-@?`,
			lineKey: `${id}/-`,
			cls: id,
			tier: "-",
			revision: null,
			revisionSource: null,
			classSource: "stem",
			suspect: false,
			variant: {},
		}),
		tiers: new Map(),
		warnings: [],
		recommend: (p) => recs(p === "balanced" ? "" : "2"),
		checkModel: (s) => {
			const m = catalog.find((x) => x.selector === s.trim());
			if (!m) return { ok: false, reason: `${s}: 지금 쓸 수 있는 모델이 아닙니다` };
			if (!m.supportsTools) return { ok: false, reason: `${s}: 도구 호출을 지원하지 않습니다` };
			return { ok: true, label: m.name, efforts: m.efforts };
		},
		detection: () => ({
			providers: [],
			tools: { task: true, eval: true },
			keywords: { workflowz: true, orchestrate: true },
			dataAsOf: null,
			stale: false,
			warnings: [],
		}),
	};
}

const base: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		explorer: { agent: "storm-explorer", models: ["a/x", "b/z"], effort: "low" },
		implementer: { agent: "storm-implementer", models: ["a/i"], workers: 3 },
		reviewer: { agent: "storm-reviewer", models: ["b/r"], effort: "high" },
	},
	parallelism: 4,
	isolation: "shared",
	contract: "workflowz",
	runtime: "omp",
};

interface Saved {
	config: StormConfig;
	scope: ApprovalScope;
	evidence: EvidenceRecord | undefined;
	baseHash: string | null;
}

function fakeHost(
	opts: {
		config?: StormConfig | null;
		answers?: Answer[];
		shadows?: ShadowInfo[];
		run?: RunRequestResult;
		agents?: AgentEntry[];
		lifecycle?: LifecycleSettings;
	} = {},
) {
	let config: StormConfig | null = opts.config === undefined ? structuredClone(base) : opts.config;
	let shadows = opts.shadows ?? [];
	const queue = [...(opts.answers ?? [])];
	const reports: Array<{ title: string; md: string }> = [];
	const selects: Array<{ title: string; options: string[]; context?: UiContext }> = [];
	const saved: Saved[] = [];
	const proposals: Proposal[] = [];
	const marks: QuotaMark[] = [];
	const runs: string[] = [];
	let prepares = 0;
	const ui: UiPort = {
		async select(title: string, options: UiSelectItem[], context?: UiContext) {
			selects.push({ title, options: options.map((o) => (typeof o === "string" ? o : o.label)), ...(context ? { context } : {}) });
			if (!queue.length) throw new Error(`no answer for select: ${title}`);
			const a = queue.shift();
			return typeof a === "function" ? a() : a;
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
	const state = (): ProjectState => ({
		repo,
		config: config
			? { status: "ok", path: "/repo/.omp/storm/config.json", config: structuredClone(config), hash: configHash(config), rawSha256: "r", warnings: [] }
			: { status: "missing", path: "/repo/.omp/storm/config.json" },
		approval: undefined,
		shadows: [...shadows],
		store: new ApprovalStore("/nonexistent", repo),
	});
	const host: StormToolHost = {
		ui,
		now: () => NOW,
		loadState: async () => state(),
		prepare: async () => {
			prepares++;
			return fakeCtx();
		},
		approveAndSave: async (st, next, scope, evidence) => {
			saved.push({ config: next, scope, evidence, baseHash: st.config.status === "ok" ? st.config.hash : null });
			config = structuredClone(next);
			return configHash(next);
		},
		runtime: {
			activeRun: () => undefined,
			lastRun: async () => undefined,
			trials: async () => [],
			quotaMarks: async () => [...marks],
			addQuotaMark: async (m) => {
				marks.push(m);
			},
			requestRun: (task) => {
				runs.push(task);
				return opts.run ?? { ok: true, runId: "run-1" };
			},
			agents: () => structuredClone(opts.agents ?? []),
		},
		lifecycleSettings: async () => opts.lifecycle ?? { agentIdleTtlMs: 420_000, cacheRetention: "auto" },
		modelCost: (s) => (s === "a/i" ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } : undefined),
		proposals: {
			list: async () => proposals.filter((p) => config !== null && p.baseHash === configHash(config)),
			save: async (p) => {
				proposals.push(p);
			},
			remove: async (id) => {
				const i = proposals.findIndex((p) => p.id === id);
				if (i >= 0) proposals.splice(i, 1);
			},
		},
	};
	return {
		host,
		reports,
		selects,
		saved,
		proposals,
		marks,
		runs,
		prepares: () => prepares,
		left: () => queue.length,
		config: () => config,
		setConfig: (c: StormConfig) => {
			config = c;
		},
		setShadows: (s: ShadowInfo[]) => {
			shadows = s;
		},
	};
}

const run = (f: { host: StormToolHost }, params: StormToolInput) => runStormTool(f.host, params);

describe("tool definition", () => {
	test("settings and schema", () => {
		const tool = createStormTool(zod, () => fakeHost().host);
		expect(tool).toMatchObject({ name: "storm", label: "Storm", loadMode: "essential", approval: "write" });
		expect(tool.description).toContain("run {task}");
		expect(tool.parameters.parse({ action: "trial", role: "reviewer", model: "c/cand", share: 0.5 })).toMatchObject({
			action: "trial",
			share: 0.5,
		});
		expect(tool.parameters.safeParse({ action: "delete-everything" }).success).toBe(false);
		expect(tool.parameters.parse({ action: "propose", config: { version: 1 }, rationale: "왜" })).toMatchObject({ action: "propose", config: { version: 1 } });
		expect(tool.parameters.safeParse({ action: "propose", config: "x" }).success).toBe(false);
		expect(tool.description).toContain("<storm-setup>");
		expect(tool.description).toContain("/storm");
	});
});

describe("read actions", () => {
	test("status renders without UI and without prepare", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "status" });
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("### 저장소");
		expect(r.text).toContain("implementer: a/i");
		expect(f.prepares()).toBe(0);
		expect(f.selects).toEqual([]);
	});

	test("status works without a config", async () => {
		const r = await run(fakeHost({ config: null }), { action: "status" });
		expect(r.outcome).toBe("ok");
	});

	test("models renders the model check", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "models" });
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("웹에서 찾아볼 수 있습니다");
		expect(f.prepares()).toBe(1);
	});

	test("status lists subagents with advice when there are any", async () => {
		const r = await run(fakeHost({ agents: [agentEntry({ id: "Imp1", role: "implementer", state: "idle" })] }), { action: "status" });
		expect(r.text).toContain("### 서브에이전트");
		expect(r.text).toContain("Imp1 (implementer)");
		expect(r.text).toContain("### 수명 관리");
	});
});

function agentEntry(over: Partial<AgentEntry> = {}): AgentEntry {
	return {
		id: "A1",
		name: "storm-implementer",
		model: "a/i",
		state: "idle",
		startedAt: NOW - 600_000,
		lastActivityAt: NOW - 60_000,
		contextTokens: 30_000,
		contextWindow: 200_000,
		requests: 4,
		costUsd: 0.1,
		followUps: 0,
		...over,
	};
}

describe("agents", () => {
	test("schema accepts the action and the description carries the reuse rule", () => {
		const tool = createStormTool(zod, () => fakeHost().host);
		expect(tool.parameters.safeParse({ action: "agents" }).success).toBe(true);
		expect(tool.description).toContain("agent://<id>");
	});

	test("no subagents yet: says so, still warns about lifecycle, never asks or prepares", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "agents" });
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("아직 실행된 서브에이전트가 없습니다");
		// Team providers a and b are unknown → 5 min estimate, shorter than the 7 min idle TTL; same window, one line.
		expect(r.text).toContain("### 수명 관리");
		expect(r.text).toContain("a·b: 유휴 TTL 7분");
		expect(f.prepares()).toBe(0);
		expect(f.selects).toEqual([]);
	});

	test("advice table with reuse and fresh, priced from the host", async () => {
		const f = fakeHost({
			agents: [
				agentEntry({ id: "Warm", lastActivityAt: NOW - 60_000 }),
				agentEntry({ id: "Cold", lastActivityAt: NOW - 3_600_000 }),
				agentEntry({ id: "Busy", state: "running" }),
			],
		});
		const r = await run(f, { action: "agents" });
		expect(r.text).toContain("| Warm (storm-implementer) |");
		expect(r.text).toMatch(/\| Warm .*\| 재사용 \|/);
		expect(r.text).toMatch(/\| Cold .*\| 새 에이전트 \|.*\$0\.1125/);
		expect(r.text).toMatch(/\| Busy .*\| 작업 중 \|/);
		expect(r.text).toContain("write agent://<id>");
	});

	test("without a config the agents' providers drive the warnings", async () => {
		const f = fakeHost({
			config: null,
			agents: [agentEntry({ model: "openai/gpt" })],
			lifecycle: { agentIdleTtlMs: 420_000, cacheRetention: "long" },
		});
		const r = await run(f, { action: "agents" });
		expect(r.text).toContain("openai: 캐시 유지 12시간");
		expect(r.text).not.toMatch(/^- [ab]: /m);
	});
});

describe("approval gate", () => {
	test("write actions need an ok config", async () => {
		const f = fakeHost({ config: null });
		for (const params of [
			{ action: "priority", priority: "cost" },
			{ action: "workers", role: "implementer", workers: 2 },
			{ action: "budget", budgetUsd: 3 },
		] satisfies StormToolInput[]) {
			const r = await run(f, params);
			expect(r).toEqual({ outcome: "rejected", text: "Storm 설정이 없습니다(또는 오류). /storm 으로 먼저 팀을 설정하세요." });
		}
		expect(f.saved).toEqual([]);
	});

	test("only the exact label approves; everything else defers and saves the proposal", async () => {
		for (const answer of [undefined, "나중에", "승인 ", "approve", "승인 후 저장"]) {
			const f = fakeHost({ answers: [answer] });
			const r = await run(f, { action: "workers", role: "implementer", workers: 2 });
			expect(r.outcome).toBe("deferred");
			expect(r.text).toContain("보류했습니다. /storm 메뉴에서 승인할 수 있습니다.");
			expect(f.saved).toEqual([]);
			expect(f.config()).toEqual(base);
			expect(f.proposals).toHaveLength(1);
			expect(f.proposals[0]).toMatchObject({ schema: "storm.proposal/v1", kind: "workers", baseHash: configHash(base) });
			expect(f.proposals[0]!.config.roles.implementer!.workers).toBe(2);
		}
	});

	test("cancel saves nothing", async () => {
		const f = fakeHost({ answers: ["취소"] });
		const r = await run(f, { action: "workers", role: "implementer", workers: 2 });
		expect(r).toEqual({ outcome: "cancelled", text: "바꾸지 않았습니다." });
		expect(f.saved).toEqual([]);
		expect(f.proposals).toEqual([]);
	});

	test("approval saves through approveAndSave with scope, then the deferred proposal is stale", async () => {
		const f = fakeHost({ answers: [undefined, "승인"] });
		await run(f, { action: "workers", role: "implementer", workers: 2 });
		const r = await run(f, { action: "workers", role: "reviewer", workers: 4 });
		expect(r.outcome).toBe("approved");
		expect(r.text).toContain(configHash(f.config()).slice("jcs-sha256:".length, "jcs-sha256:".length + 12));
		expect(f.saved).toHaveLength(1);
		expect(f.saved[0]!.config.roles.reviewer!.workers).toBe(4);
		expect(f.saved[0]!.baseHash).toBe(configHash(base));
		expect(f.saved[0]!.scope.providers).toEqual(["a", "b"]);
		expect(await f.host.proposals.list()).toEqual([]);
	});

	test("a config change during the dialog blocks the write", async () => {
		const other = structuredClone(base);
		other.parallelism = 8;
		const g = fakeHost({
			answers: [
				() => {
					g.setConfig(other);
					return "승인";
				},
			],
		});
		const r = await run(g, { action: "workers", role: "implementer", workers: 2 });
		expect(r.outcome).toBe("rejected");
		expect(g.saved).toEqual([]);
	});

	test("shadowing definitions are shown in the approval dialog, and a new one blocks the write", async () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project", sha256: "ab" };
		const f = fakeHost({ shadows: [shadow], answers: ["승인"] });
		expect((await run(f, { action: "workers", role: "implementer", workers: 2 })).outcome).toBe("approved");
		expect(f.reports).toEqual([]);
		expect(f.selects[0]!.context).toMatchObject({ title: "Storm 변경 제안" });
		expect(f.selects[0]!.context!.markdown).toContain(shadow.path);
		expect(f.saved[0]!.scope.shadowedAgents).toEqual([shadow]);

		const g = fakeHost({
			answers: [
				() => {
					g.setShadows([{ ...shadow, sha256: "cd" }]);
					return "승인";
				},
			],
		});
		expect((await run(g, { action: "workers", role: "implementer", workers: 2 })).outcome).toBe("rejected");
		expect(g.saved).toEqual([]);
	});

	test("no-op change asks nothing", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "workers", role: "explorer", workers: 1 });
		expect(r.outcome).toBe("ok");
		expect(f.selects).toEqual([]);
	});
});

describe("priority", () => {
	test("re-picks each role with a fallback, keeps workers, records evidence", async () => {
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, { action: "priority", priority: "quality" });
		expect(r.outcome).toBe("approved");
		const s = f.saved[0]!;
		expect(s.config.priority).toBe("quality");
		// Per-model effort: the primary keeps the candidate's effort, the fallback gets the role default it supports.
		expect(s.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/x2:low", "b/z2:low"] });
		expect(s.config.roles.implementer).toEqual({ agent: "storm-implementer", models: ["a/i2", "c/j2:medium"], workers: 3 });
		expect(s.config.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["b/r2:high"] });
		expect(s.evidence).toMatchObject({ source: "priority", priority: "quality", dataAsOf: NOW - 3_600_000 });
		expect(s.evidence!.roles.implementer!.chosen).toBe("a/i2");
		expect(f.selects.at(-1)!.context!.markdown).toContain("근거");
	});

	test("missing priority is rejected", async () => {
		expect((await run(fakeHost(), { action: "priority" })).outcome).toBe("rejected");
	});
});

describe("workers", () => {
	test("bounds and unknown role", async () => {
		for (const workers of [0, 17, 2.5, Number.NaN]) {
			expect((await run(fakeHost(), { action: "workers", role: "implementer", workers })).outcome).toBe("rejected");
		}
		const cfg = structuredClone(base);
		delete cfg.roles.reviewer;
		expect((await run(fakeHost({ config: cfg }), { action: "workers", role: "reviewer", workers: 2 })).outcome).toBe("rejected");
		expect((await run(fakeHost(), { action: "workers", role: "reviewer" })).outcome).toBe("rejected");
	});
});

describe("reselect", () => {
	test("named model goes first with the old primary's effort, else the role default it supports", async () => {
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, { action: "reselect", role: "implementer", model: "c/j" });
		expect(r.outcome).toBe("approved");
		expect(f.saved[0]!.config.roles.implementer).toEqual({ agent: "storm-implementer", models: ["c/j:medium", "a/i"], workers: 3 });
		expect(f.saved[0]!.evidence?.source).toBe("reselect");

		const g = fakeHost({ answers: ["승인"] });
		await run(g, { action: "reselect", role: "reviewer", model: "c/cand" });
		expect(g.saved[0]!.config.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["c/cand:medium", "b/r:high"] });

		// Kept models carry the role effort they ran with as their own suffix, so dropping the role default changes nothing for them.
		const h = fakeHost({ answers: ["승인"] });
		await run(h, { action: "reselect", role: "explorer", model: "e/noeffort" });
		expect(h.saved[0]!.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["e/noeffort", "a/x:low", "b/z:low"] });

		// The old primary's own suffix wins over the role default; the moved model is matched by selector.
		const cfg = structuredClone(base);
		cfg.roles.explorer = { agent: "storm-explorer", models: ["a/x:high", "b/z:max"], effort: "low" };
		const k = fakeHost({ config: cfg, answers: ["승인"] });
		await run(k, { action: "reselect", role: "explorer", model: "b/z" });
		expect(k.saved[0]!.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["b/z:high", "a/x:high"] });
	});

	test("rejects unusable models and too-small context", async () => {
		for (const model of ["zz/none", "f/notools", "d/small"]) {
			const f = fakeHost();
			const r = await run(f, { action: "reselect", role: "implementer", model });
			expect(r.outcome).toBe("rejected");
			expect(f.selects).toEqual([]);
		}
		expect((await run(fakeHost(), { action: "reselect", role: "implementer", model: "d/small" })).text).toContain("컨텍스트");
	});

	test("without a model the user picks; cancel or no UI changes nothing", async () => {
		for (const answer of ["취소", undefined]) {
			const f = fakeHost({ answers: [answer] });
			const r = await run(f, { action: "reselect", role: "explorer" });
			expect(r.outcome).toBe("cancelled");
			expect(f.selects[0]!.title).toBe("탐색 역할 모델 선택");
			expect(f.proposals).toEqual([]);
			expect(f.saved).toEqual([]);
		}
		const f = fakeHost({ answers: ["Z (b/z)", "승인"] });
		const r = await run(f, { action: "reselect", role: "explorer" });
		expect(f.selects[0]!.options).toEqual(["X (a/x) · 현재", "Y (a/y)", "Z (b/z)", "취소"]);
		expect(r.outcome).toBe("approved");
		expect(f.saved[0]!.config.roles.explorer!.models).toEqual(["b/z:low", "a/x:low"]);

		const cfg = structuredClone(base);
		cfg.roles.explorer!.models = ["a/x:max", "b/z"];
		const g = fakeHost({ config: cfg, answers: ["취소"] });
		await run(g, { action: "reselect", role: "explorer" });
		expect(g.selects[0]!.options[0]).toBe("X (a/x) · 현재");
	});

	test("adopting a trial's model drops that trial", async () => {
		const cfg = structuredClone(base);
		const trial: TrialConfig = {
			id: "reviewer-c-cand-20261120",
			role: "reviewer",
			model: "c/cand",
			share: 0.25,
			maxSpawns: 20,
			startsAt: "2026-11-20T00:00:00.000Z",
			endsAt: "2026-11-27T00:00:00.000Z",
			budgetUsd: 2,
		};
		cfg.trials = [trial, { ...trial, id: "impl", role: "implementer", model: "c/j" }];
		const f = fakeHost({ config: cfg, answers: ["승인"] });
		await run(f, { action: "reselect", role: "reviewer", model: "c/cand" });
		expect(f.saved[0]!.config.trials?.map((t) => t.id)).toEqual(["impl"]);
	});
});

describe("quota", () => {
	test("all affected roles have approved fallbacks: mark only, no approval", async () => {
		const cfg = structuredClone(base);
		cfg.roles.implementer!.models = ["a/i", "c/j"];
		const f = fakeHost({ config: cfg });
		const r = await run(f, { action: "quota", provider: "a" });
		expect(r.outcome).toBe("ok");
		expect(r.text).toContain("5시간 뒤 만료");
		expect(r.text).toContain("- 탐색: a/x → b/z");
		expect(r.text).toContain("- 구현: a/i → c/j");
		expect(f.marks).toEqual([
			{ provider: "a", source: "user", markedAt: new Date(NOW).toISOString(), until: new Date(NOW + 5 * 3_600_000).toISOString() },
		]);
		expect(f.selects).toEqual([]);
		expect(f.prepares()).toBe(0);
		expect(f.saved).toEqual([]);
	});

	test("roles without a fallback get a proposal adding one off the provider", async () => {
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, { action: "quota", provider: "a" });
		expect(r.outcome).toBe("approved");
		expect(f.marks).toHaveLength(1);
		expect(f.saved[0]!.config.roles.implementer!.models).toEqual(["a/i", "c/j:medium"]);
		expect(f.saved[0]!.config.roles.explorer).toEqual(base.roles.explorer!);
		expect(f.saved[0]!.evidence?.source).toBe("quota");

		const g = fakeHost({ answers: [undefined] });
		expect((await run(g, { action: "quota", provider: "a" })).outcome).toBe("deferred");
		expect(g.saved).toEqual([]);
		expect(g.proposals[0]!.kind).toBe("quota");
	});

	test("no candidate off the provider is rejected; unused provider is a no-op", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "quota", provider: "b" });
		expect(r.outcome).toBe("rejected");
		expect(f.saved).toEqual([]);
		const g = fakeHost();
		const n = await run(g, { action: "quota", provider: "zzz" });
		expect(n.outcome).toBe("ok");
		expect(g.marks).toEqual([]);
		expect((await run(g, { action: "quota" })).outcome).toBe("rejected");
	});
});

describe("trial", () => {
	test("builds a bounded trial with defaults and replaces the role's previous one", async () => {
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, { action: "trial", role: "reviewer", model: "c/cand" });
		expect(r.outcome).toBe("approved");
		expect(r.text).toContain("25%");
		expect(r.text).toContain("최대 20회");
		expect(r.text).toContain("7일");
		expect(r.text).toContain("$2");
		const t = f.saved[0]!.config.trials!;
		expect(t).toEqual([
			{
				id: "reviewer-c-cand-20261120",
				role: "reviewer",
				model: "c/cand",
				effort: "medium",
				share: 0.25,
				maxSpawns: 20,
				startsAt: new Date(NOW).toISOString(),
				endsAt: new Date(NOW + 7 * 86_400_000).toISOString(),
				budgetUsd: 2,
			},
		]);

		const g = fakeHost({ config: f.config(), answers: ["승인"] });
		await run(g, { action: "trial", role: "reviewer", model: "c/j", share: 0.5, maxSpawns: 5, days: 3, budgetUsd: 1 });
		expect(g.saved[0]!.config.trials!.map((x) => [x.model, x.share, x.maxSpawns, x.budgetUsd, x.effort])).toEqual([["c/j", 0.5, 5, 1, "high"]]);
	});

	test("bounds and model checks", async () => {
		const bad: StormToolInput[] = [
			{ action: "trial", role: "reviewer", model: "c/cand", share: 0 },
			{ action: "trial", role: "reviewer", model: "c/cand", share: 1.5 },
			{ action: "trial", role: "reviewer", model: "c/cand", maxSpawns: 0 },
			{ action: "trial", role: "reviewer", model: "c/cand", maxSpawns: 1001 },
			{ action: "trial", role: "reviewer", model: "c/cand", days: 0 },
			{ action: "trial", role: "reviewer", model: "c/cand", days: 31 },
			{ action: "trial", role: "reviewer", model: "c/cand", budgetUsd: 0 },
			{ action: "trial", role: "reviewer", model: "b/r" },
			{ action: "trial", role: "reviewer", model: "d/small" },
			{ action: "trial", role: "reviewer", model: "zz/none" },
			{ action: "trial", role: "reviewer" },
		];
		for (const p of bad) {
			const f = fakeHost();
			expect((await run(f, p)).outcome).toBe("rejected");
			expect(f.selects).toEqual([]);
		}
	});
});

describe("budget", () => {
	test("set with default warning, remove, and reject a bad warning", async () => {
		const f = fakeHost({ answers: ["승인", "승인"] });
		expect((await run(f, { action: "budget", budgetUsd: 5, onExceed: "stop" })).outcome).toBe("approved");
		expect(f.config()!.budget).toEqual({ perRunUsd: 5, warnAtUsd: 4, onExceed: "stop" });
		expect((await run(f, { action: "budget", budgetUsd: 0 })).outcome).toBe("approved");
		expect(f.config()!.budget).toBeUndefined();
		expect((await run(f, { action: "budget", budgetUsd: 5, warnAtUsd: 6 })).outcome).toBe("rejected");
		expect((await run(f, { action: "budget" })).outcome).toBe("rejected");
		expect((await run(f, { action: "budget", budgetUsd: 0 })).outcome).toBe("rejected");
	});
});

describe("run", () => {
	test("queues the task and tells the model to stop", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "run", task: "  로그인 버그 고쳐줘 " });
		expect(r.outcome).toBe("queued");
		expect(r.text).toContain("응답을 바로 마치세요");
		expect(f.runs).toEqual(["로그인 버그 고쳐줘"]);
	});

	test("empty task and refused runs are rejected", async () => {
		const f = fakeHost();
		expect((await run(f, { action: "run", task: "   " })).outcome).toBe("rejected");
		expect((await run(f, { action: "run" })).outcome).toBe("rejected");
		expect(f.runs).toEqual([]);
		const g = fakeHost({ run: { ok: false, reason: "승인된 설정이 없습니다" } });
		expect(await run(g, { action: "run", task: "x" })).toEqual({ outcome: "rejected", text: "승인된 설정이 없습니다" });
	});
});

describe("propose", () => {
	const team = (): StormConfig => {
		const c = structuredClone(base);
		c.roles.explorer = { agent: "storm-explorer", models: ["b/z:low", "a/x:low"], workers: 2 };
		c.fallbackRole = "implementer";
		return c;
	};
	const params = (config: unknown = team()): StormToolInput => ({ action: "propose", config, rationale: "  탐색은 빠른 모델, 리뷰는 다른 Provider  " });

	test("an invalid or missing config is rejected with the errors, asking nothing", async () => {
		const f = fakeHost({ config: null });
		const r = await run(f, params({ ...team(), version: 2, parallelism: 0 }));
		expect(r.outcome).toBe("rejected");
		expect(r.text).toContain("version");
		expect(r.text).toContain("parallelism");
		expect((await run(f, { action: "propose" })).outcome).toBe("rejected");
		expect(f.selects).toEqual([]);
		expect(f.saved).toEqual([]);
	});

	test("only the exact label saves; anything else cancels without a pending proposal", async () => {
		for (const answer of ["취소", undefined, "나중에", "승인 ", "승인 후 저장"]) {
			const f = fakeHost({ answers: [answer] });
			const r = await run(f, params());
			expect(r).toEqual({ outcome: "cancelled", text: "저장하지 않았습니다. 바뀐 것은 없습니다." });
			expect(f.selects[0]!.options).toEqual(["승인", "취소"]);
			expect(f.saved).toEqual([]);
			expect(f.proposals).toEqual([]);
			expect(f.config()).toEqual(base);
		}
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, params());
		expect(r.outcome).toBe("approved");
		expect(r.text).toContain("Storm 팀 재설정 제안 (균형)");
		expect(f.saved).toHaveLength(1);
		const s = f.saved[0]!;
		expect(s.config).toEqual(team());
		expect(s.baseHash).toBe(configHash(base));
		expect(s.scope.providers).toEqual(["a", "b"]);
		expect(s.evidence).toMatchObject({ source: "setup", priority: "balanced", rationale: "탐색은 빠른 모델, 리뷰는 다른 Provider" });
		expect(s.evidence!.roles.explorer!.chosen).toBe("b/z");
		const md = f.selects[0]!.context!.markdown;
		expect(md).toContain("explorer 모델: a/x, b/z → b/z:low, a/x:low");
		expect(md).toContain("탐색은 빠른 모델");
	});

	test("a new project gets the whole team, shadows included, and saves on approval", async () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project", sha256: "ab" };
		const f = fakeHost({ config: null, shadows: [shadow], answers: ["승인"] });
		const r = await run(f, params());
		expect(r.outcome).toBe("approved");
		expect(r.text).toContain("Storm 팀 설정 제안");
		expect(f.selects[0]!.context).toMatchObject({ title: "Storm 팀 제안" });
		const md = f.selects[0]!.context!.markdown;
		expect(md).toContain("### 팀 구성\n새 설정");
		expect(md).toContain(shadow.path);
		expect(f.saved[0]!.baseHash).toBeNull();
		expect(f.saved[0]!.scope.shadowedAgents).toEqual([shadow]);
		expect(f.config()).toEqual(team());
	});

	test("models missing from the available list are warned about in the dialog", async () => {
		const c = team();
		c.roles.reviewer!.models = ["zz/none:high", "b/r:high"];
		const f = fakeHost({ answers: ["취소"] });
		await run(f, params(c));
		const md = f.selects[0]!.context!.markdown;
		expect(md).toContain("### 경고");
		expect(md).toContain("zz/none: 지금 쓸 수 있는 모델 목록에 없습니다");
		expect(md).not.toContain("b/r: 지금");
	});

	test("a config written underneath during the dialog blocks the save", async () => {
		const g = fakeHost({
			config: null,
			answers: [
				() => {
					g.setConfig(base);
					return "승인";
				},
			],
		});
		expect((await run(g, params())).outcome).toBe("rejected");
		expect(g.saved).toEqual([]);
	});
});
