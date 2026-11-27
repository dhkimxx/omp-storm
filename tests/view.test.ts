import { describe, expect, test } from "bun:test";
import { configHash, shortHash } from "../src/config/canonical.ts";
import { validateConfig } from "../src/config/schema.ts";
import { renderApproval } from "../src/proposals/present.ts";
import { changedFields, ISOLATION_ROUTED_STATE, renderConfigDiff, renderStatus, renderStatusBrief, renderTrial, resumeRunLine, runStatusText } from "../src/view/render.ts";
import { rollbackLabels, runRollback } from "../src/view/review.ts";
import { recommendedConfig } from "../src/view/setup.ts";
import { agentRows, renderAgentRows } from "../src/report/agents.ts";
import { DEFAULT_WORKERS, roleTitle } from "../src/roles.ts";
import type { InfoLine, RollbackOption, RunPlan, RunRecord, RunStatus, StatusView, StormConfig, TrialConfig, TrialView } from "../src/types.ts";
import { agentEntry, approvalRecord, runRecord, spawnRecord } from "./fixtures.ts";
import { cand, pick, rec, recs, scriptedUi, TEAM } from "./support.ts";
import { TEAM_08 } from "./team-08.ts";

const NOW = Date.parse("2026-11-20T09:30:00Z");
const ISO_UTC = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const trial: TrialConfig = {
	id: "reviewer-c-j-20261120T000000Z",
	role: "reviewer",
	model: "c/j",
	share: 0.5,
	maxSpawns: 10,
	startsAt: "2026-11-20T00:00:00.000Z",
	endsAt: "2026-11-27T00:00:00.000Z",
	budgetUsd: 5,
};

describe("recommendedConfig", () => {
	test("first setup: chosen candidate plus the recommendation's fallback at their own efforts, defaults, cleanup on", () => {
		const config = recommendedConfig(recs(), "balanced");
		expect(config).toEqual({
			version: 1,
			priority: "balanced",
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x:low", "b/z:medium"], workers: DEFAULT_WORKERS.explorer },
				implementer: { agent: "storm-implementer", models: ["a/i", "c/j:medium"], workers: DEFAULT_WORKERS.implementer },
				reviewer: { agent: "storm-reviewer", models: ["b/r:high"], workers: DEFAULT_WORKERS.reviewer },
			},
			isolation: "shared",
			cleanup: true,
			fallbackRole: "implementer",
		});
		const checked = validateConfig(config);
		expect(checked.errors).toEqual([]);
		expect(checked.warnings).toEqual([]);
		// A fresh team recommends a 1~4 implementer range and persists no team-wide cap.
		expect(config.roles.implementer!.workers).toEqual({ min: 1, max: 4 });
		expect(config).not.toHaveProperty("parallelism");
	});

	test("the fallback is the recommendation's, also when it lies beyond the listed candidates", () => {
		const config = recommendedConfig([rec("implementer", [cand("a/i"), cand("a/k")], cand("q/far", { effort: "xhigh" }))], "quality");
		expect(config.roles.implementer!.models).toEqual(["a/i:medium", "q/far:xhigh"]);
		expect(recommendedConfig([rec("implementer", [cand("a/i")])], "quality").roles.implementer!.models).toEqual(["a/i:medium"]);
	});

	test("re-setup keeps what the user chose: switches, budget, worker ranges, disabled roles, run settings, trials", () => {
		const current: StormConfig = {
			version: 1,
			priority: "balanced",
			roles: {
				explorer: { agent: "storm-explorer", models: ["old/x"], workers: { min: 1, max: 7 } },
				implementer: { agent: "storm-implementer", models: ["old/i"], workers: 3 },
			},
			isolation: "isolated",
			budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "stop" },
			docs: false,
			disabledRoles: ["reviewer"],
			trials: [{ ...trial, role: "explorer" }, trial],
		};
		const next = recommendedConfig(recs("2"), "cost", current);
		expect(next).toEqual({
			version: 1,
			priority: "cost",
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x2:low", "b/z2:medium"], workers: { min: 1, max: 7 } },
				implementer: { agent: "storm-implementer", models: ["a/i2", "c/j2:medium"], workers: { min: 3, max: 3 } },
			},
			isolation: "isolated",
			budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "stop" },
			docs: false,
			disabledRoles: ["reviewer"],
			// The reviewer's trial went with the role; other agents stay blocked because the current team blocked them.
			trials: [{ ...trial, role: "explorer" }],
		});
		expect(validateConfig(next).errors).toEqual([]);
		expect(next).not.toHaveProperty("parallelism");
	});

	test("cleanup is recommended only on a first setup; a current team's choice stands either way", () => {
		expect(recommendedConfig(recs(), "balanced", TEAM).cleanup).toBeUndefined();
		expect(recommendedConfig(recs(), "balanced", { ...TEAM, cleanup: true }).cleanup).toBe(true);
	});

	test("the 0.8 team re-set up: nothing deprecated is written back", () => {
		const next = recommendedConfig(recs(), "balanced", JSON.parse(TEAM_08));
		expect(next).not.toHaveProperty("contract");
		expect(next).not.toHaveProperty("runtime");
		expect(next).not.toHaveProperty("parallelism");
		expect(next).not.toHaveProperty("contextCap");
		expect(next.roles.explorer!.workers).toEqual({ min: 1, max: 2 });
		expect(next.fallbackRole).toBe("implementer");
	});

	test("roles without candidates are left out", () => {
		const config = recommendedConfig([...recs().slice(0, 2), rec("reviewer", [])], "balanced");
		expect(Object.keys(config.roles)).toEqual(["explorer", "implementer"]);
	});
});

describe("config diff", () => {
	/** `mutate` applied to a copy of TEAM; the diff must show the change the hash sees. */
	const changed = (mutate: (c: Record<string, any>) => void): StormConfig => {
		const next = structuredClone(TEAM) as Record<string, any>;
		mutate(next);
		return next as StormConfig;
	};

	test("equal configs have no rows; a new config lists every role's models", () => {
		expect(changedFields(TEAM, structuredClone(TEAM))).toEqual([]);
		const whole = renderConfigDiff(undefined, TEAM);
		for (const model of ["a/x, b/z", "a/i", "b/r"]) expect(whole).toContain(model);
	});

	test("everything the hash covers shows up: no change the user approves is invisible", () => {
		const mutations: Array<(c: Record<string, any>) => void> = [
			c => (c.priority = "quality"),
			c => (c.priority = "speed"),
			c => (c.roles.reviewer.models = ["b/r", "c/j"]),
			c => (c.roles.reviewer.agent = "storm-explorer"),
			c => (c.roles.reviewer.effort = "low"),
			c => (c.roles.reviewer.workers = { min: 1, max: 5 }),
			c => (c.roles.reviewer.contextCap = 50_000),
			c => delete c.roles.reviewer,
			c => (c.disabledRoles = ["quick"]),
			c => (c.rounds = 7),
			c => (c.contextCap = 100_000),
			c => (c.isolation = "isolated"),
			c => (c.budget = { perRunUsd: 3, onExceed: "stop" }),
			c => (c.fallbackRole = "implementer"),
			c => (c.cleanup = true),
			c => (c.docs = false),
			c => (c.trials = [trial]),
			c => (c.contract = "orchestrate"),
			c => (c.runtime = "omp"),
			c => (c.contextcap = 1),
			c => (c.roles.reviewer.note = "x"),
			c => (c.budget = { perRunUsd: 3, onExceed: "stop", extra: true }),
		];
		for (const mutate of mutations) {
			const next = changed(mutate);
			expect(configHash(next)).not.toBe(configHash(TEAM));
			expect(changedFields(TEAM, next).length).toBeGreaterThan(0);
			expect(changedFields(next, TEAM).length).toBeGreaterThan(0);
		}
	});

	test("rows carry the old and new values, with role titles instead of role ids", () => {
		const next = changed(c => {
			c.roles.reviewer.models = ["c/j:high", "b/r"];
			c.roles.implementer.workers = { min: 1, max: 5 };
			c.contextcap = 1;
			c.roles.explorer.agent = "storm-custom";
		});
		const md = renderConfigDiff(TEAM, next);
		for (const part of ["b/r → c/j:high, b/r", "1~3 → 1~5", "contextcap=1", "storm-explorer → storm-custom"]) expect(md).toContain(part);
		// One name per changed thing, in diff order: three role fields under their role's title, then the unknown field.
		const fields = changedFields(TEAM, next);
		expect(fields).toHaveLength(4);
		expect(new Set(fields).size).toBe(4);
		for (const [i, id] of ["explorer", "implementer", "reviewer"].entries()) expect(fields[i]).toStartWith(roleTitle(id));
		for (const id of ["reviewer", "implementer"]) expect(md).not.toContain(id);
	});

	test("a check's own time limit shows in the diff, alone or with the rest of the check", () => {
		const check = { name: "unit", argv: ["bun", "test"] };
		const withTimeout = (timeoutMs?: number): StormConfig => ({ ...TEAM, requiredChecks: [timeoutMs === undefined ? check : { ...check, timeoutMs }] });
		expect(configHash(withTimeout(600_000))).not.toBe(configHash(withTimeout()));
		expect(renderConfigDiff(undefined, withTimeout(600_000))).toContain("600");
		expect(renderConfigDiff(undefined, withTimeout())).not.toContain("600");
		// Only the time limit differs: the approval must still show a changed row.
		expect(changedFields(withTimeout(), withTimeout(600_000))).toEqual(["필수 검사 unit"]);
		expect(changedFields(withTimeout(600_000), withTimeout(900_000))).toEqual(["필수 검사 unit"]);
		expect(renderConfigDiff(withTimeout(600_000), withTimeout(900_000))).toMatch(/600.*→.*900/);
	});

	test("an edit that only changes a stored contextCap still shows in the approval diff, team level and per role", () => {
		const team = changed(c => (c.contextCap = 100_000));
		const role = changed(c => (c.roles.reviewer.contextCap = 50_000));
		expect(configHash(team)).not.toBe(configHash(TEAM));
		expect(changedFields(TEAM, team)).toEqual(["contextCap(더는 쓰지 않는 필드)"]);
		expect(renderConfigDiff(TEAM, team)).toMatch(/없음.*→.*100000/);
		expect(changedFields(TEAM, role)).toEqual([`${roleTitle("reviewer")} contextCap(더는 쓰지 않는 필드)`]);
		expect(renderConfigDiff(TEAM, role)).toMatch(/없음.*→.*50000/);
		// The same stored value on both sides shows nothing.
		expect(changedFields(team, structuredClone(team))).toEqual([]);
		expect(renderConfigDiff(team, changed(c => (c.contextCap = 250_000)))).toMatch(/100000.*→.*250000/);
	});

	test("rich model rows mark old values, the new primary and fallbacks without changing the diff", () => {
		const next = changed(c => (c.roles.explorer.models = ["c/j", "d/k"]));
		const plain = renderConfigDiff(TEAM, next);
		const info: InfoLine[] = [];
		expect(renderConfigDiff(TEAM, next, info)).toBe(plain);
		const lines = plain.split("\n");
		const row = info.find(entry => lines[entry.index]!.startsWith("- 탐색 모델:"))!;
		expect(row).toBeDefined();
		expect(row.spans.map(span => span.text).join("")).toBe(lines[row.index]);
		expect(lines[row.index]).toContain("a/x, b/z → c/j, d/k");
		const tone = (text: string) => row.spans.filter(span => span.text === text).map(span => span.tone);
		for (const old of ["a/x", "b/z"]) expect(tone(old)).toEqual(["muted"]);
		expect(tone("c/j")).toEqual(["accent"]);
		expect(tone("d/k")).toEqual(["muted"]);

		// A whole-team diff keeps its "새 설정" title and indexes local to its own Markdown.
		const whole: InfoLine[] = [];
		const wholeMd = renderConfigDiff(undefined, TEAM, whole);
		const wholeLines = wholeMd.split("\n");
		expect(wholeLines[0]).toBe("새 설정");
		expect(whole[0]).toEqual({ index: 0, spans: [{ text: "새 설정", tone: "accent" }] });
		const explorer = whole.find(entry => wholeLines[entry.index]!.startsWith("- 탐색 모델:"))!;
		expect(explorer.index).toBe(2);
		expect(explorer.spans.map(span => span.text).join("")).toBe(wholeLines[2]);
		expect(explorer.spans.filter(span => span.text === "a/x").map(span => span.tone)).toEqual(["accent"]);
		expect(explorer.spans.filter(span => span.text === "b/z").map(span => span.tone)).toEqual(["muted"]);
	});

	test("a role's own agent definition is not listed", () => {
		expect(renderConfigDiff(undefined, TEAM)).not.toContain("storm-reviewer");
	});

	test("extra rounds are shown in force, and a change is one row with both numbers", () => {
		const next = changed(c => (c.rounds = 7));
		const md = renderConfigDiff(TEAM, next);
		expect(md).toContain("제한 없음 → 7");
		expect(changedFields(TEAM, next)).toHaveLength(1);
		expect(changedFields(next, TEAM)).toHaveLength(1);
	});

	test("absent rounds read as no limit, and typing a number over it is a change", () => {
		const explicit = changed(c => (c.rounds = 3));
		expect(configHash(explicit)).not.toBe(configHash(TEAM));
		expect(renderConfigDiff(TEAM, explicit)).toContain("제한 없음 → 3");
		expect(renderConfigDiff(explicit, TEAM)).toContain("3 → 제한 없음");
		expect(changedFields(TEAM, explicit)).toHaveLength(1);
		// The rendered values differ, but two explicit settings of the same number have no row.
		expect(changedFields(explicit, structuredClone(explicit))).toEqual([]);
	});

	test("isolation and the budget action are shown in words, not as raw values", () => {
		const md = renderConfigDiff(TEAM, changed(c => {
			c.isolation = "isolated";
			c.budget = { perRunUsd: 3, onExceed: "block-spawns" };
		}));
		for (const raw of ["isolated", "shared", "block-spawns"]) expect(md).not.toContain(raw);
	});

	test("trials are added, removed and changed by content", () => {
		const withTrial = changed(c => (c.trials = [trial]));
		expect(renderConfigDiff(TEAM, withTrial)).toContain("c/j");
		const removed = changedFields(withTrial, TEAM);
		expect(removed).toHaveLength(1);
		expect(removed[0]).toStartWith(roleTitle("reviewer"));
		expect(changedFields(withTrial, changed(c => (c.trials = [{ ...trial, maxSpawns: 99 }])))).toEqual(removed);
		expect(changedFields(TEAM, withTrial)).toEqual(removed);
	});

	test("a hostile config cannot forge or hide rows: each string stays on its own row, control and bidi characters spelled out", () => {
		const ESC = "\u001b";
		const reviewer = TEAM.roles.reviewer!;
		// The same change twice: once with strings that try to start lines, clear the screen, conceal and reorder text.
		const hostile = {
			...structuredClone(TEAM),
			contract: "x\n\n### 변경\n변경 없음",
			[`key\n- forged-row: 1`]: `v${ESC}[8m\u2028`,
			roles: { ...TEAM.roles, reviewer: { ...reviewer, agent: "storm-x\rspoof", models: [`b/q${ESC}[2J\u202e`] } },
			disabledRoles: ["quick\n- forged-role"],
			trials: [{ ...trial, model: "c/j\n- forged-trial" }],
		} as StormConfig;
		const plain = {
			...structuredClone(TEAM),
			contract: "x",
			key: "v",
			roles: { ...TEAM.roles, reviewer: { ...reviewer, agent: "storm-x", models: ["b/q"] } },
			disabledRoles: ["quick"],
			trials: [{ ...trial, model: "c/j" }],
		} as StormConfig;
		const unsafe = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
		const approval = (config: StormConfig) =>
			renderApproval(undefined, TEAM, config, {
				warnings: config === hostile ? ["w\n### 팀 설정\n- forged"] : ["w"],
				shadows: [{ agent: config === hostile ? "storm-a\n- forged" : "storm-a", path: config === hostile ? `/p${ESC}[1A\n- forged` : "/p", scope: "project", sha256: "s" }],
			});
		for (const render of [(c: StormConfig) => renderConfigDiff(TEAM, c), (c: StormConfig) => renderConfigDiff(undefined, c), approval]) {
			const text = render(hostile);
			expect(text).not.toMatch(unsafe);
			// No line more than the harmless spelling has, and no heading more.
			expect(text.split("\n")).toHaveLength(render(plain).split("\n").length);
			expect(text.split("\n").filter(line => line.startsWith("#"))).toEqual(render(plain).split("\n").filter(line => line.startsWith("#")));
		}
		for (const field of changedFields(TEAM, hostile)) expect(field).not.toMatch(/\n/);
		expect(changedFields(TEAM, hostile)).toHaveLength(changedFields(TEAM, plain).length);
	});

	test("the approval panel leads with what needs consent: context, shadows and warnings before the diff, notes after it", () => {
		const md = renderApproval("SUMMARY", undefined, TEAM, {
			context: "CONTEXT",
			notes: "NOTES",
			warnings: ["WARNING"],
			shadows: [{ agent: "storm-reviewer", path: "/s/SHADOW.md", scope: "user", sha256: "s" }],
		});
		const order = ["CONTEXT", "SHADOW.md", "WARNING", "SUMMARY", "a/x", "NOTES"].map(part => md.indexOf(part));
		expect(order[0]).toBe(0);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});

describe("rollback", () => {
	const option = (config: StormConfig, minute: number): RollbackOption => ({
		hash: configHash(config),
		approvedAt: new Date(Date.UTC(2026, 10, 20, 3, minute)).toISOString(),
		config,
	});
	const workers = { ...TEAM, roles: { ...TEAM.roles, implementer: { ...TEAM.roles.implementer!, workers: { min: 1, max: 5 } } } };
	const budget: StormConfig = { ...TEAM, budget: { perRunUsd: 3, onExceed: "stop" } };

	test("labels say what going back changes: options that differ only in workers or budget read differently", () => {
		const labels = rollbackLabels([option(workers, 1), option(budget, 2)], TEAM);
		const [workersField] = changedFields(TEAM, workers);
		const [budgetField] = changedFields(TEAM, budget);
		expect(labels[0]).toContain(workersField as string);
		expect(labels[0]).not.toContain(budgetField as string);
		expect(labels[1]).toContain(budgetField as string);
		for (const label of labels) {
			expect(label).not.toMatch(ISO_UTC);
			expect(label).not.toContain(shortHash(configHash(workers)));
		}
	});

	test("labels stay distinct when two approvals look the same, and work without a readable current config", () => {
		// Two approvals in the same minute that change the same field would read the same; the short hash tells them apart.
		const first = option(workers, 1);
		const labels = rollbackLabels([first, { ...first, hash: `jcs-sha256:${"1".repeat(64)}` }], TEAM);
		expect(new Set(labels).size).toBe(2);
		const blind = rollbackLabels([option(TEAM, 1)], undefined);
		expect(blind[0]).toContain("a/x");
	});

	test("picking and confirming returns the option; backing out at either step returns nothing", async () => {
		const options = [option(workers, 1), option(budget, 2)];
		const labels = rollbackLabels(options, TEAM);
		const yes = scriptedUi([labels[1], pick(0)]);
		expect(await runRollback(yes.ui, { options, current: TEAM })).toBe(options[1]);
		// Every earlier approval plus one way out; then a confirmation with exactly two choices and the full diff in view.
		expect(yes.selects[0]?.options.slice(0, -1)).toEqual(labels);
		expect(yes.selects[0]?.options).toHaveLength(labels.length + 1);
		expect(yes.selects[1]?.options).toHaveLength(2);
		expect(yes.selects[1]?.markdown).toBe(renderConfigDiff(TEAM, budget));
		for (const answers of [[undefined], [pick(-1)], [labels[0], pick(-1)], [labels[0], undefined], [labels[0], "something else"]]) {
			expect(await runRollback(scriptedUi(answers).ui, { options, current: TEAM })).toBeUndefined();
		}
	});
});

describe("status", () => {
	const hash = configHash(TEAM);
	const view = (over: Partial<StatusView> = {}): StatusView => ({
		config: { status: "ok", path: "/repo/.omp/storm/config.json", config: TEAM, hash, warnings: [] },
		approval: approvalRecord(hash, { repoId: "r", approvedAt: "2026-11-20T05:12:44.512Z", approvalId: "apr_OLD" }),
		shadows: [],
		...over,
	});
	const run = runRecord({ configHash: hash, status: "running", costUsd: 1.25 });
	const agent = agentEntry({ id: "a1", model: "a/i", startedAt: NOW - 600_000, lastActivityAt: NOW - 60_000, contextTokens: 250_000, requests: 4, costUsd: 0.5, followUps: 1 });

	test("shows the short hash and every model, in local time only and without record ids", () => {
		const md = renderStatus(view({ run, lastRun: { ...run, runId: "run-0", status: "done" }, quotaMarks: [{ provider: "a", source: "user", markedAt: "2026-11-20T09:00:00.000Z", until: "2026-11-20T14:00:00.000Z" }] }), NOW);
		expect(md).toContain(shortHash(hash));
		for (const model of ["a/x → b/z", "a/i", "b/r", "run-1", "run-0", "$1.2500"]) expect(md).toContain(model);
		expect(md).not.toMatch(ISO_UTC);
		expect(md).not.toContain("apr_OLD");
		expect(md).not.toContain("dir-test-");
	});

	describe("goal totals", () => {
		const goal = { firstRunId: "run-0", runs: 2, usd: 7.25, ms: 30 * 60_000, turns: 37 };
		const lines = (md: string): string[] => md.split("\n");
		/** The lines the report gained when the record(s) gained a goal. */
		const gained = (plain: StatusView, carried: StatusView): string[] => {
			const before = lines(renderStatus(plain, NOW));
			const after = lines(renderStatus(carried, NOW));
			expect(after).toHaveLength(before.length + 1);
			return after.filter(line => !before.includes(line));
		};
		const running = runRecord({ configHash: hash, status: "running", costUsd: 1.25, turns: 3, startedAt: "2026-11-20T09:18:00Z" });
		const settled = runRecord({ configHash: hash, status: "done", costUsd: 0.5, turns: 2, endedAt: "2026-11-20T09:10:00Z" });

		test("the running run shows what the whole goal has used, counting this run and its time so far", () => {
			const [line] = gained(view({ run: running }), view({ run: { ...running, goal } }));
			// 3 runs, $7.25 + $1.25, 30 + 12 minutes, 37 + 3 rounds.
			for (const figure of ["3", "$8.50", "42분", "40"]) expect(line).toContain(figure);
		});

		test("the last run shows its goal totals with its own recorded time", () => {
			const [line] = gained(view({ lastRun: settled }), view({ lastRun: { ...settled, goal } }));
			// 3 runs, $7.25 + $0.50, 30 + 10 minutes, 37 + 2 rounds.
			for (const figure of ["3", "$7.75", "40분", "39"]) expect(line).toContain(figure);
		});

		test("the rich status keeps every style index inside the report", () => {
			const info: InfoLine[] = [];
			const md = renderStatus(view({ run: { ...running, goal }, lastRun: { ...settled, goal } }), NOW, "user", info);
			for (const entry of info) expect(entry.index).toBeLessThan(lines(md).length);
		});

		test("a record without a goal, and the model's report, show no goal line", () => {
			const plain = view({ run: running, lastRun: settled });
			expect(lines(renderStatus(plain, NOW)).some(line => line.includes("$7.25") || line.includes("$8.50"))).toBe(false);
			const carried = view({ run: { ...running, goal }, lastRun: { ...settled, goal } });
			expect(renderStatus(carried, NOW, "model")).toBe(renderStatus(plain, NOW, "model"));
		});
	});

	test("quota and usage sections exist only when they were read", () => {
		const bare = renderStatus(view(), NOW);
		const read = renderStatus(view({ quota: [{ provider: "prov-q", state: "limited", usedFraction: 0.42, resetsAt: null }], dataAsOf: NOW - 3_600_000 }), NOW);
		expect(read).toContain("prov-q");
		expect(read).toContain("42%");
		expect(read.split("\n").length).toBeGreaterThan(bare.split("\n").length + 3);
		expect(bare).not.toContain("—");
	});

	test("a stored contextCap adds no setting row to a new config or the team panel", () => {
		const old = { ...structuredClone(TEAM), contextCap: 123_456, roles: { ...TEAM.roles, reviewer: { ...TEAM.roles.reviewer!, contextCap: 50_000 } } } as StormConfig;
		const diff = renderConfigDiff(undefined, old);
		expect(diff).not.toContain("123,456");
		expect(diff).not.toContain("50,000");
		expect(diff).not.toContain("컨텍스트");
		expect(renderStatus(view({ config: { status: "ok", path: "/repo/c.json", config: old, hash, warnings: [] } }), NOW)).not.toContain("컨텍스트");
	});

	test("user status stacks worker details while the model retains the compact table", () => {
		const withAgent = view({ agents: [agent] });
		const user = renderStatus(withAgent, NOW);
		expect(user).toContain("- a1 · 구현 · 유휴 1분");
		// A 250k-token worker past the retired 200k cap still takes follow-ups; no cap is shown beside its context.
		expect(user).toContain("250.0k");
		expect(user).not.toContain("200.0k");
		expect(agentRows([agent]).map(row => row.followUp)).toEqual(["ok"]);
		expect(renderStatus(withAgent, NOW, "model")).toContain(renderAgentRows(agentRows([agent]), NOW));
		expect(renderStatus(view(), NOW)).not.toContain("### 서브에이전트");
	});

	test("missing and invalid configs: every error is shown, never where the project is", () => {
		const missing = renderStatus(view({ config: { status: "missing", path: "/repo/c.json" }, approval: undefined }), NOW);
		const invalid = renderStatus(view({ config: { status: "invalid", path: "/repo/c.json", errors: ["error-one", "error-two"] }, approval: undefined }), NOW);
		for (const part of ["error-one", "error-two"]) expect(invalid).toContain(part);
		for (const text of [missing, invalid, renderStatus(view(), NOW)]) expect(text).not.toContain("/repo");
	});

	test("the full status renders the storage inventory line by line, never duplicating the hub's short line", () => {
		const full = view({ storage: "brief-storage", storageDetail: [{ text: "detail-one" }, { text: "detail-two" }] });
		const info: InfoLine[] = [];
		const md = renderStatus(full, NOW, "user", info);
		for (const part of ["detail-one", "detail-two"]) expect(md).toContain(part);
		expect(md).not.toContain("brief-storage");
		const lines = md.split("\n");
		for (const entry of info) expect(lines[entry.index]).toContain(entry.spans.map(span => span.text).join(""));
	});

	test("storage rows make actual gaps and unknown owners amber, while policy and candidates stay muted", () => {
		const info: InfoLine[] = [];
		const md = renderStatus(
			view({
				storageDetail: [
					{ text: "집계 누락: 예", warning: true },
					{ text: "소유 미상: 1개 2B", warning: true },
					{ text: "정리 후보: 없음 — 자동 정리가 꺼져 있음" },
				],
			}),
			NOW,
			"user",
			info,
		);
		const row = (text: string) => info.find(line => line.spans.some(span => span.text.includes(text)))!;
		const gap = row("집계 누락");
		expect(gap.icon).toBe("status.warning");
		expect(gap.spans.find(span => span.text.includes("집계 누락"))?.tone).toBe("warning");
		const policy = row("자동 정리가 꺼져");
		expect(policy.icon).toBeUndefined();
		expect(policy.spans.find(span => span.text.includes("자동 정리가 꺼져"))?.tone).toBe("muted");
		const unknown = row("소유 미상");
		expect(unknown.icon).toBe("status.warning");
		expect(unknown.spans.find(span => span.text.includes("소유 미상"))?.tone).toBe("warning");
		expect(md.split("\n")[gap.index]).toContain("집계 누락: 예");
	});

	test("required checks are elevated only when the team actually has them", () => {
		const info: InfoLine[] = [];
		const withChecks = renderStatus(view({ config: { status: "ok", path: "/repo/c.json", config: { ...TEAM, requiredChecks: [{ name: "test", argv: ["bun", "test"] }] }, hash, warnings: [] } }), NOW, "user", info);
		const present = info.find(line => line.spans[0]?.text === "- 필수 검사: ")!;
		expect(present.icon).toBe("status.info");
		expect(present.spans.find(span => span.text.startsWith("test: "))?.tone).toBe("accent");
		expect(withChecks.split("\n")[present.index]).toContain("test:");

		const plainInfo: InfoLine[] = [];
		renderStatus(view(), NOW, "user", plainInfo);
		const absent = plainInfo.find(line => line.spans[0]?.text === "- 필수 검사: ")!;
		expect(absent.icon).toBeUndefined();
		expect(absent.spans.find(span => span.text === "없음")?.tone).toBe("muted");
	});

	test("a required check's own time limit shows in the team panel only when set", () => {
		const panel = (check: { name: string; argv: string[]; timeoutMs?: number }) =>
			renderStatus(view({ config: { status: "ok", path: "/repo/c.json", config: { ...TEAM, requiredChecks: [check] }, hash, warnings: [] } }), NOW);
		expect(panel({ name: "test", argv: ["bun", "test"], timeoutMs: 600_000 })).toContain("600");
		expect(panel({ name: "test", argv: ["bun", "test"] })).not.toContain("600");
	});

	test("the whole team setting is in the full status: every switch and run setting changes it", () => {
		const of = (over: Partial<StormConfig>) => renderStatus(view({ config: { status: "ok", path: "/repo/c.json", config: { ...TEAM, ...over }, hash, warnings: [] } }), NOW);
		const base = of({});
		for (const over of [{ priority: "quality" }, { isolation: "isolated" }, { cleanup: true }, { docs: false }, { fallbackRole: "implementer" }, { budget: { perRunUsd: 7.5, onExceed: "stop" } }] as Array<Partial<StormConfig>>) {
			expect(of(over)).not.toBe(base);
		}
		expect(base).not.toContain("병렬도");
		expect(of({})).toContain("공유 작업 트리");
		expect(of({ isolation: "isolated" })).toContain("팀 격리(리뷰 포함)");
		expect(renderStatus(view({ storage: "storage-line" }), NOW)).toContain("storage-line");
	});

	test("the run settings show the extra rounds in force, on the row that follows the setting", () => {
		const of = (rounds?: number) => {
			const config = rounds === undefined ? TEAM : { ...TEAM, rounds };
			return renderStatus(view({ config: { status: "ok", path: "/repo/c.json", config, hash, warnings: [] } }), NOW).split("\n");
		};
		const base = of();
		const set = of(7);
		const removed = base.filter(line => !set.includes(line));
		const added = set.filter(line => !base.includes(line));
		expect(removed).toHaveLength(1);
		expect(added).toHaveLength(1);
		expect(removed[0]).toContain("제한 없음");
		expect(removed[0]).not.toMatch(/\d/);
		expect(added[0]).toContain("7");
		expect(set.indexOf(added[0]!)).toBe(base.indexOf(removed[0]!));
	});

	test("for the model: no commands, no cost flags and no paths, with the shadowing definition still named", () => {
		const busy = view({
			shadows: [{ agent: "storm-reviewer", path: "/home/u/.omp/agent/agents/x.md", scope: "user", sha256: "s" }],
			ompAdvice: [{ key: "retry.fallbackChains", message: "advice-text", command: "omp config set retry.fallbackChains '{}'" }],
			newerVersion: "99.0.0",
		});
		const user = renderStatus(busy, NOW);
		const model = renderStatus(busy, NOW, "model");
		for (const part of ["/home/u", "--max-cost", "omp config set", "99.0.0"]) {
			expect(user).toContain(part);
			expect(model).not.toContain(part);
		}
		expect(model).toContain("storm-reviewer");
	});

	test("an ended trial shows its measured comparison", () => {
		const side = { selector: "c/j", requests: 12, errorRate: 0.25, ompTps: 80, decodeTps: 90, ttftP50: 700, costPerRequest: 0.0123 };
		const ended: TrialView = {
			trial,
			state: { id: trial.id, seen: 20, routed: 10, costUsd: 0.5 },
			phase: "ended",
			endReason: "spawns",
			comparison: { candidate: side, current: { ...side, selector: "b/r", requests: 30, errorRate: 0 }, dataAsOf: NOW },
		};
		const md = renderTrial(ended);
		for (const part of ["c/j", "b/r", "10/10", "| 12 | 30 |", "| 25% | 0% |", "$0.0123"]) expect(md).toContain(part);
		expect(md).not.toMatch(ISO_UTC);
		expect(renderStatus(view({ trials: [ended] }), NOW)).toContain(md);
		const active = renderTrial({ trial, state: undefined, phase: "active" });
		expect(active).toContain("0/10");
		expect(active).not.toMatch(ISO_UTC);
	});

	test("a last run of each status renders, briefly too", () => {
		const statuses: RunStatus[] = ["running", "done", "ended", "budget-exceeded", "stopped"];
		for (const status of statuses) {
			const lastRun = runRecord({ runId: `run-${status}`, status });
			expect(() => renderStatus(view({ lastRun }), NOW)).not.toThrow();
			expect(renderStatus(view({ lastRun }), NOW)).toContain(lastRun.runId);
			expect(() => renderStatusBrief(view({ lastRun }), NOW)).not.toThrow();
			expect(renderStatusBrief(view({ lastRun }), NOW)).toContain(lastRun.runId);
		}
	});

	test("an uncapped run reads N라운드 and a capped one N/M라운드, in the status and the hub", () => {
		const open = { ...run, turns: 2 };
		const capped = { ...run, turns: 2, maxRounds: 5 };
		for (const render of [(r: typeof run) => renderStatus(view({ run: r }), NOW), (r: typeof run) => renderStatusBrief(view({ run: r }), NOW, [])]) {
			expect(render(open)).toContain("3라운드");
			expect(render(open)).not.toMatch(/\d\/\d라운드/);
			expect(render(capped)).toContain("3/5라운드");
		}
	});

	test("the hub shows current and last runs together, without the team's detailed model list", () => {
		const full = view({ run, lastRun: runRecord({ runId: "run-0", status: "done" }), autoDelegation: "on", trials: [{ trial, state: undefined, phase: "active" }], dataAsOf: NOW, quota: [{ provider: "prov-q", state: "limited", usedFraction: 0.42, resetsAt: null }] });
		const info: InfoLine[] = [];
		const brief = renderStatusBrief(full, NOW, info);
		expect(brief).toContain(shortHash(hash));
		for (const part of ["실행 중: run-1", "마지막 실행: run-0", "승인됨", "시험 사용 1건"]) expect(brief).toContain(part);
		for (const part of ["a/x → b/z", "prov-q"]) expect(brief).not.toContain(part);
		// The menu's auto row and its "전체 현황" action carry these; the panel keeps only the independent hash/approval.
		expect(brief).not.toContain("자동 위임");
		expect(brief).not.toContain("/storm status");
		expect(brief).not.toContain("사용 데이터 기준");
		expect(info[0]).toMatchObject({ index: 0, emphasis: "title" });
		expect(info.every(line => line.section === undefined)).toBe(true);
		expect(brief.split("\n").length).toBeLessThan(renderStatus(full, NOW).split("\n").length / 2);
		expect(brief).not.toMatch(ISO_UTC);
	});

	test("the hub leaves auto state to its menu row and does not point back at itself for resume", () => {
		const info: InfoLine[] = [];
		const resume = renderStatusBrief(view({ autoDelegation: "off", dataAsOf: NOW - 60_000 }), NOW, info, true);
		expect(resume).toContain("이어가기 가능");
		expect(resume).not.toContain("- 다음:");
		expect(info.some(line => line.emphasis === "action")).toBe(false);
		// The menu already has the auto row and the full-status action; the panel repeats neither.
		expect(resume).not.toContain("자동 위임");
		expect(resume).not.toContain("사용 데이터 기준");
		expect(resume).not.toContain("전체 현황은 /storm status");

		// A blocked auto state is not the resume action, so its real reason survives; without a separate reason the
		// status link stays as the actionable warning, never as a footer.
		const blocked = renderStatusBrief(view({ autoDelegation: "blocked", autoModeProblem: "자동 위임을 막는 설정" }), NOW, undefined, true);
		expect(blocked).toContain("- 다음: 자동 위임을 막는 설정");
		expect(renderStatusBrief(view({ autoDelegation: "blocked" }), NOW, undefined, true)).toContain("- 다음: `/storm status`에서 이유 확인");
		const unapproved = renderStatusBrief(view({ approval: undefined }), NOW, undefined, true);
		expect(unapproved).toContain("- 다음: `/storm`에서 팀 승인");
	});

	test("a detailed result section states each criterion and id once; its summary above is only the aggregate", () => {
		const results: NonNullable<RunRecord["results"]> = [
			{ id: "api-check", lane: "api", state: "unmet", reason: "응답 계약이 다릅니다", contract: { id: "api-check", kind: "answer", criterion: "API 검증" } },
			{ id: "docs", lane: "api", state: "accepted", contract: { id: "docs", kind: "answer", criterion: "API 문서" } },
		];
		const active = runRecord({ status: "running", results });
		const settled = { ...active, runId: "run-0", status: "done" as const };
		const info: InfoLine[] = [];
		const md = renderStatus(view({ run: active }), NOW, "user", info);
		expect(md).toContain("- 결과(공식): 이행 1/2 · 미충족 1");
		expect(md).toContain("- API 검증 [api-check] [api] 미충족 — 응답 계약이 다릅니다");
		expect(md).toContain("- API 문서 [docs] [api] 이행");
		const summary = info.find(line => line.spans.some(span => span.text.includes("결과(공식)")))!;
		expect(md.split("\n")[summary.index]).toBe(summary.spans.map(span => span.text).join(""));
		expect(md.split("\n")[summary.index]).toBe("- 결과(공식): 이행 1/2 · 미충족 1");

		const both = renderStatus(view({ run: active, lastRun: settled }), NOW);
		// Once in the active row, once in the settled row; neither summary repeats the focus.
		const activeSection = both.slice(both.indexOf("### 실행 중"), both.indexOf("### 마지막 실행"));
		const settledSection = both.slice(both.indexOf("### 마지막 실행"));
		for (const section of [activeSection, settledSection]) {
			expect(section).toContain("- 결과(공식): 이행 1/2 · 미충족 1\n");
		}
		expect(activeSection.match(/API 검증/g)).toHaveLength(1);
		expect(settledSection.match(/API 검증/g)).toHaveLength(1);
		expect(both.match(/api-check/g)).toHaveLength(2);

		// No rows follow in the model view, the brief or the plain widget, so each keeps the focus name once.
		const model = renderStatus(view({ run: active, lastRun: settled }), NOW, "model");
		expect(model.match(/API 검증 \(api-check\)/g)).toHaveLength(2);
		expect(model).not.toContain("응답 계약이 다릅니다");
		const brief = renderStatusBrief(view({ run: active, lastRun: settled }), NOW);
		expect(brief).toContain("- 결과(공식): API 검증 (api-check) · 이행 1/2 · 미충족 1");
		expect(brief).toContain("- 마지막 결과(공식): API 검증 (api-check) · 이행 1/2 · 미충족 1");
		expect(brief).not.toContain("응답 계약이 다릅니다");
		expect(runStatusText(active, NOW)).toContain("결과 API 검증 (api-check) · 이행 1/2 · 미충족 1");
	});

	describe("settled run detail and handoff", () => {
		const results: NonNullable<RunRecord["results"]> = [
			{ id: "api-check", lane: "api", state: "unmet", reason: "응답 계약이 다릅니다", contract: { id: "api-check", kind: "answer", criterion: "API 검증" }, finalized: "revoked" },
			{ id: "docs", lane: "docs", state: "accepted", contract: { id: "docs", kind: "artifact", criterion: "API 문서" } },
		];
		const jobs: NonNullable<RunRecord["jobs"]> = [
			{ lane: "bench", name: "bench-run", status: "passed", exitCode: 0, startedAt: null, finishedAt: null },
			{ lane: "bench", name: "bench-gpu", status: "unknown", exitCode: null, startedAt: null, finishedAt: null },
		];
		const draft = {
			result: "API 문서를 고쳤습니다",
			verification: "문서 링크를 직접 열어 확인했습니다",
			remaining: "API 검증 레인 재시도",
			next: [{ kind: "resume" }, { kind: "run", task: "응답 계약만 다시 맞추기" }, { kind: "user", text: "벤치 장비 전원 확인" }],
		} satisfies NonNullable<RunRecord["closeout"]>;
		const settled = runRecord({
			runId: "run-9",
			status: "ended",
			endReason: "round-limit",
			results,
			jobs,
			checks: [{ name: "unit", status: "passed", exitCode: 0, tree: "test-tree" }],
			closeout: draft,
			closeoutFacts: { target: "repo", pendingLanes: ["api", "bench"], requiredChecks: ["unit", "e2e"] },
		});

		test("the user's last run carries the former card-only facts after the official lines, without repeating rows", () => {
			const md = renderStatus(view({ lastRun: settled }), NOW);
			const section = md.slice(md.indexOf("### 마지막 실행"), md.indexOf("### 팀 설정"));
			// Detailed official rows keep their ids, reasons and states.
			expect(section).toContain("- API 검증 [api-check] [api] 미충족 — 응답 계약이 다릅니다");
			expect(section).toContain("API 문서 [docs] [docs] 이행");
			expect(section).toContain("- 검사 결과: unit: 통과 (exit 0)");
			expect(section).toContain("- 필수 검사 기록 없음: e2e");
			expect(section).not.toContain("unit 기록 없음");
			expect(section).toContain("- 잡 영수증(호스트): bench-run [bench] passed(0) · bench-gpu [bench] unknown");
			// "api" is already named by its open result row; only the lane no row covers is listed.
			expect(section).toContain("- 미완료 레인: bench\n");
			expect(section.match(/\[api\]/g)).toHaveLength(1);
			// The director's whole draft follows the official state, marked because finalization changed a row after it.
			const official = section.indexOf("- 결과(공식)");
			const report = section.indexOf("- 결과(감독 보고, 최종 판정 전 작성): API 문서를 고쳤습니다");
			expect(official).toBeGreaterThan(-1);
			expect(report).toBeGreaterThan(official);
			expect(report).toBeGreaterThan(section.indexOf("- 미완료 레인"));
			expect(section).toContain("- 검증(감독 보고, 최종 판정 전 작성): 문서 링크를 직접 열어 확인했습니다");
			expect(section).toContain("- 남은 일(감독 보고, 최종 판정 전 작성): API 검증 레인 재시도");
			expect(section).toContain("- 제안한 다음 행동(감독 보고, 최종 판정 전 작성): 이어 가기 · 응답 계약만 다시 맞추기 · 직접: 벤치 장비 전원 확인");
		});

		test("a legacy draft with plain directions and no finish facts still renders, unmarked", () => {
			const legacy = runRecord({
				runId: "run-8",
				status: "done",
				closeout: { result: "결과", verification: "검증", next: ["첫 방향", "둘째 방향", "셋째 방향"] } as unknown as NonNullable<RunRecord["closeout"]>,
			});
			const md = renderStatus(view({ lastRun: legacy }), NOW);
			expect(md).toContain("- 결과(감독 보고): 결과");
			expect(md).toContain("- 검증(감독 보고): 검증");
			expect(md).not.toContain("- 남은 일(");
			expect(md).toContain("- 제안한 다음 행동(감독 보고): 첫 방향 · 둘째 방향 · 셋째 방향");
			expect(md).not.toContain("필수 검사 기록 없음");
			expect(md).not.toContain("미완료 레인");
			expect(md).not.toContain("잡 영수증");
		});

		test("the model reads no draft, receipts or lanes, and no handoff the caller did not prove", () => {
			const model = renderStatus(view({ lastRun: settled }), NOW, "model");
			expect(model).toContain("- run-9 · ");
			expect(model).toContain("- 결과(공식)");
			for (const hidden of ["감독 보고", "잡 영수증", "미완료 레인", "필수 검사 기록 없음", "종료 인수인계", "API 문서를 고쳤습니다"]) {
				expect(model).not.toContain(hidden);
			}
		});

		test("a proven handoff is the model's bounded synopsis, once, with paths removed and repeated lines dropped", () => {
			const plain = renderStatus(view({ lastRun: settled }), NOW, "model");
			const resultLine = plain.split("\n").find(line => line.startsWith("- 결과(공식)"))!;
			const handoff = `${resultLine.slice(2)}\n남은 일: /Users/me/repo/src/api.ts 의 응답 계약\n다음: /storm status`;
			const model = renderStatus(view({ lastRun: settled, lastHandoff: handoff } as Partial<StatusView>), NOW, "model");
			expect(model.match(/종료 인수인계/g)).toHaveLength(1);
			// The official result line is already in the handoff: the model reads it once.
			expect(model.split(resultLine.slice(2))).toHaveLength(2);
			expect(model).not.toContain("/Users/me");
			expect(model).toContain("(경로 생략)");
			expect(model).toContain("/storm status");
			expect(model).not.toContain("감독 보고");

			const huge = renderStatus(view({ lastRun: settled, lastHandoff: Array.from({ length: 40 }, (_, i) => `${i}:${"가".repeat(200)}`).join("\n") } as Partial<StatusView>), NOW, "model");
			const block = huge.slice(huge.indexOf("종료 인수인계"));
			expect(block.length).toBeLessThan(1400);
			expect(block).not.toContain("39:");

			// A running record has no settled handoff, and the user's view never prints the model synopsis.
			const running = renderStatus(view({ lastRun: { ...settled, status: "running" }, lastHandoff: handoff } as Partial<StatusView>), NOW, "model");
			expect(running).not.toContain("종료 인수인계");
			expect(renderStatus(view({ lastRun: settled, lastHandoff: handoff } as Partial<StatusView>), NOW)).not.toContain("종료 인수인계");
		});
	});

	test("a settled run drops a repeated refusal only when an exception lane row reports the same spawn", () => {
		const lane = { name: "격리 실험", kind: "code" as const, role: "implementer", goal: "compare", isolationReason: "별도 체크아웃에서만 비교" };
		const plan: RunPlan = { lanes: [lane], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		const covered = spawnRecord({ lane: lane.name, agent: "storm-implementer", outcome: "blocked", reason: "omp 격리가 꺼져 있습니다" });
		const other = spawnRecord({ lane: "본선", agent: "storm-reviewer", outcome: "blocked", reason: "예산 상한을 넘었습니다" });
		const md = renderStatus(view({ lastRun: runRecord({ status: "done", plan, spawns: [covered, other] }) }), NOW);
		expect(md).toContain("- 격리 레인: 격리 실험 — 별도 체크아웃에서만 비교 · 시작하지 못함: omp 격리가 꺼져 있습니다");
		expect(md.match(/omp 격리가 꺼져 있습니다/g)).toHaveLength(1);
		expect(md).toContain("- 첫 차단: storm-reviewer · 예산 상한을 넘었습니다");
		expect(md).toContain("- 스폰: 차단 2");

		const only = renderStatus(view({ lastRun: runRecord({ status: "done", plan, spawns: [covered] }) }), NOW);
		expect(only).not.toContain("첫 차단");
		// A lane without its own isolation reason has no row to carry the refusal, so the block row stays.
		const sharedLane = { name: lane.name, kind: lane.kind, role: lane.role, goal: lane.goal };
		const shared = renderStatus(
			view({ lastRun: runRecord({ status: "done", plan: { ...plan, lanes: [sharedLane] }, spawns: [covered] }) }),
			NOW,
		);
		expect(shared).toContain("- 첫 차단: storm-implementer · omp 격리가 꺼져 있습니다");
	});

	test("the hub greens approval only when it exists and marks a real warning in the notes", () => {
		const unapproved: InfoLine[] = [];
		const brief = renderStatusBrief(
			view({
				approval: undefined,
				quotaMarks: [{ provider: "prov-m", source: "user", markedAt: new Date(NOW).toISOString(), until: new Date(NOW + 3_600_000).toISOString() }],
			}),
			NOW,
			unapproved,
		);
		const team = unapproved.find(line => line.spans[0]?.text.startsWith("- 팀 설정"))!;
		expect(team.icon).toBe("status.warning");
		expect(team.spans.find(span => span.text === "미승인")?.tone).toBe("warning");
		const notes = unapproved.find(line => line.spans[0]?.text === "- 확인할 것: ")!;
		expect(notes.icon).toBe("status.warning");
		expect(notes.spans.find(span => span.text.includes("쿼터 소진 표시"))?.tone).toBe("warning");
		expect(brief.split("\n")[notes.index]).toContain("쿼터 소진 표시 prov-m");

		const approved: InfoLine[] = [];
		renderStatusBrief(view({ autoDelegation: "on" }), NOW, approved);
		const teamApproved = approved.find(line => line.spans[0]?.text.startsWith("- 팀 설정"))!;
		expect(teamApproved.icon).toBe("status.success");
		expect(teamApproved.spans.find(span => span.text === "승인됨")?.tone).toBe("success");
	});

	test("an ordinary shared plan adds no workspace line, in the full status or the hub", () => {
		const plan: RunPlan = {
			lanes: [{ name: "login", kind: "code", role: "implementer", goal: "fix login" }],
			workers: { implementer: 1 },
			submittedAt: "2026-11-20T09:00:00.000Z",
		};
		const shared = runRecord({ status: "running", plan });
		for (const md of [
			renderStatus(view({ run: shared }), NOW),
			renderStatus(view({ lastRun: shared }), NOW),
			renderStatusBrief(view({ run: shared }), NOW),
		]) {
			expect(md).not.toContain("격리 레인");
			expect(md).not.toContain("분리 체크아웃");
		}
	});

	test("a very long isolation reason is cut on screen in every view that prints the lane", () => {
		const reason = `${"긴".repeat(2_000)}끝`;
		const lane = { name: "러너 비교", kind: "run" as const, role: "implementer", goal: "compare runners", isolationReason: reason };
		const plan: RunPlan = { lanes: [lane], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		for (const md of [
			renderStatus(view({ run: runRecord({ status: "running", plan }) }), NOW),
			renderStatus(view({ lastRun: runRecord({ status: "done", plan }) }), NOW),
		]) {
			const row = md.split("\n").find(line => line.startsWith("- 격리 레인:"))!;
			expect(row).toBeDefined();
			expect(row).toContain("러너 비교");
			expect(row).toContain("…");
			expect(row).not.toContain("끝");
			expect(row.length).toBeLessThan(300);
		}
		// The stored plan keeps the whole text.
		expect(plan.lanes[0]!.isolationReason).toBe(reason);
	});

	test("an exceptional lane is named with its Korean reason and is never shown as started by the plan alone", () => {
		const lane = { name: "러너 비교", kind: "run" as const, role: "implementer", goal: "compare runners", isolationReason: "새 러너가 기존 캐시를 지워 별도 체크아웃에서만 비교" };
		const plan: RunPlan = { lanes: [lane], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		const active = runRecord({ status: "running", plan });
		const info: InfoLine[] = [];
		const md = renderStatus(view({ run: active }), NOW, "user", info);
		expect(md).toContain("- 격리 레인: 러너 비교 — 새 러너가 기존 캐시를 지워 별도 체크아웃에서만 비교 · 아직 시작 전");
		expect(md).toContain("git 브랜치와 별개의 분리 체크아웃이며, 성공해도 그 변경은 이 작업 트리로 자동 반영되지 않습니다");
		expect(md).not.toContain(ISOLATION_ROUTED_STATE);
		const line = info.find(entry => entry.spans.some(span => span.text.includes("격리 레인")))!;
		expect(line.icon).toBe("status.warning");
		expect(md.split("\n")[line.index]).toContain("러너 비교");
		expect(renderStatusBrief(view({ run: active }), NOW)).toContain("- 격리 레인: 러너 비교 —");
	});

	test("a refused isolated lane is shown as refused, not as a shared run; an admitted one as started", () => {
		const lane = { name: "마이그레이션 실험", kind: "code" as const, role: "implementer", isolationReason: "기존 DB를 건드리지 않는 별도 실험" };
		const plan: RunPlan = { lanes: [lane], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };
		const refused = runRecord({
			status: "running",
			plan,
			spawns: [spawnRecord({ lane: lane.name, agent: "storm-implementer", outcome: "blocked", reason: "omp 격리가 꺼져 있습니다" })],
		});
		const denied = renderStatus(view({ run: refused }), NOW);
		expect(denied).toContain("시작하지 못함: omp 격리가 꺼져 있습니다");
		expect(denied).not.toContain("아직 시작 전");
		expect(denied).not.toContain(ISOLATION_ROUTED_STATE);
		const started = runRecord({ status: "running", plan, spawns: [spawnRecord({ lane: lane.name, agent: "storm-implementer", outcome: "routed" })] });
		expect(renderStatus(view({ run: started }), NOW)).toContain(ISOLATION_ROUTED_STATE);
		expect(renderStatus(view({ lastRun: started }), NOW)).toContain(`- 격리 레인: 마이그레이션 실험 — 기존 DB를 건드리지 않는 별도 실험 · ${ISOLATION_ROUTED_STATE}`);
	});

	test("read-only status keeps the action at the top and returns to Runtime after storage", () => {
		const info: InfoLine[] = [];
		const markdown = renderStatus(view({
			approval: undefined,
			trials: [{ trial, state: undefined, phase: "active" }],
			storage: "storage-line",
		}), NOW, "user", info);
		const lines = markdown.split("\n");
		expect(info.filter(line => line.section).map(line => [line.section, lines[line.index]])).toEqual([
			["team", "### 팀 설정"],
			["runtime", "### 시험 사용"],
			["storage", "### 저장 공간"],
			["runtime", "### 하드 예산 상한"],
		]);
		expect(info[0]).toMatchObject({ index: 0, emphasis: "title" });
		expect(info[1]).toMatchObject({ index: 1, emphasis: "action", icon: "status.warning" });
		const headings = info.filter(line => lines[line.index]?.startsWith("### "));
		expect(headings.every(line => line.emphasis === "title" && line.icon !== undefined)).toBe(true);
		expect(headings.map(line => [lines[line.index], line.icon])).toEqual([
			["### 팀 설정", "status.enabled"],
			["### 승인", "status.warning"],
			["### 역할별 모델", "status.enabled"],
			["### 실행 설정", "status.enabled"],
			["### 시험 사용", "status.pending"],
			["### 저장 공간", "context.content"],
			["### 하드 예산 상한", "status.info"],
		]);
		expect(lines.slice(0, info.find(line => line.section === "team")!.index).join("\n")).not.toContain("a/x → b/z");
	});

	test("rich info marks approval and only a verified run as success", () => {
		const rich = (over: Partial<StatusView> = {}) => {
			const info: InfoLine[] = [];
			const md = renderStatus(view(over), NOW, "user", info);
			return { md, info };
		};
		const tones = (info: InfoLine[], text: string) =>
			info.flatMap(entry => entry.spans).filter(span => span.text === text).map(span => span.tone);

		const unapproved = rich({ approval: undefined });
		expect(tones(unapproved.info, "- 미승인")).toEqual(["warning"]);
		expect(tones(rich().info, "- 승인됨")).toEqual(["success"]);

		for (const endReason of [undefined, "verified"] as const) {
			const verified = rich({ approval: undefined, lastRun: runRecord({ status: "done", ...(endReason ? { endReason } : {}) }) });
			expect(tones(verified.info, "완료")).toEqual(["success"]);
		}
		for (const endReason of ["no-changes", "unreviewed", "no-reviewer"] as const) {
			const ended = rich({ approval: undefined, lastRun: runRecord({ status: "ended", endReason }) });
			expect(tones(ended.info, "끝남")).toEqual(["muted"]);
			expect(ended.info.flatMap(entry => entry.spans).some(span => span.tone === "success")).toBe(false);
		}
		expect(tones(rich({ approval: undefined, lastRun: runRecord({ status: "budget-exceeded" }) }).info, "예산 초과")).toEqual(["error"]);
	});

	test("only a recorded positive budget gets a clamped meter that marks warn and overage", () => {
		const meterOf = (costUsd: number, budget?: RunRecord["budget"]) => {
			const info: InfoLine[] = [];
			renderStatus(view({ lastRun: runRecord({ status: "running", costUsd, ...(budget ? { budget } : {}) }) }), NOW, "user", info);
			return info.find(entry => entry.meter);
		};
		expect(meterOf(1.25, { perRunUsd: 5, warnAtUsd: 1, onExceed: "stop" })?.meter).toEqual({ fraction: 0.25, tone: "warning" });
		expect(meterOf(1, { perRunUsd: 4, onExceed: "stop" })?.meter).toEqual({ fraction: 0.25, tone: "accent" });
		expect(meterOf(6, { perRunUsd: 5, onExceed: "stop" })?.meter).toEqual({ fraction: 1, tone: "error" });
		for (const budget of [undefined, { perRunUsd: 0, onExceed: "stop" as const }]) expect(meterOf(1, budget)).toBeUndefined();
		expect(meterOf(Number.NaN, { perRunUsd: 5, onExceed: "stop" })).toBeUndefined();

		const info: InfoLine[] = [];
		const md = renderStatus(view({ lastRun: runRecord({ status: "running", costUsd: 6, budget: { perRunUsd: 5, onExceed: "stop" } }) }), NOW, "user", info);
		const entry = info.find(line => line.meter)!;
		expect(entry.spans.map(span => span.text).join("")).toBe(md.split("\n")[entry.index]);
		expect(entry.spans.some(span => span.text.includes("$6.0000") && span.tone === "error")).toBe(true);
		expect(md.split("\n")[entry.index]).toContain("지출 $6.0000 / 예산 $5");
	});

	test("rich status spans replace exactly their Markdown line and keep every value", () => {
		const full = view({
			run: { ...run, budget: { perRunUsd: 5, onExceed: "stop" } },
			lastRun: runRecord({ runId: "run-0", status: "done", endReason: "verified", costUsd: 6, budget: { perRunUsd: 5, onExceed: "stop", warnAtUsd: 4 } }),
			quota: [
				{ provider: "prov-q", state: "exhausted", usedFraction: 0.99, resetsAt: NOW },
				{ provider: "prov-l", state: "limited", usedFraction: 0.42, resetsAt: null },
			],
			quotaMarks: [{ provider: "prov-m", source: "user", markedAt: new Date(NOW).toISOString(), until: new Date(NOW + 3_600_000).toISOString() }],
			dataAsOf: NOW,
			storage: "storage-line",
		});
		const plain = renderStatus(full, NOW);
		expect(renderStatus(full, NOW, "model")).toBe(renderStatus(full, NOW, "model", []));
		const info: InfoLine[] = [];
		expect(renderStatus(full, NOW, "user", info)).toBe(plain);
		const lines = plain.split("\n");
		for (const entry of info) {
			expect(entry.index).toBeGreaterThanOrEqual(0);
			expect(entry.index).toBeLessThan(lines.length);
			expect(lines[entry.index]).toContain(entry.spans.map(span => span.text).join(""));
		}
		const spend = info.find(entry => entry.spans.some(span => span.text.includes("$1.2500")))!;
		expect(lines[spend.index]).toContain("지출 $1.2500 / 예산 $5");
		const quota = info.find(entry => entry.spans.some(span => span.text === "소진"))!;
		expect(lines[quota.index]).toContain("prov-q");
		expect(lines[quota.index]).toContain("99%");
		expect(quota.spans.find(span => span.text === "소진")?.tone).toBe("error");
		const limited = info.find(entry => entry.spans.some(span => span.text === "제한"))!;
		expect(limited.spans.find(span => span.text === "제한")?.tone).toBe("warning");
	});
});

describe("runStatusText", () => {
	const numbers = (part: string | undefined): number[] => part?.match(/\d+/g)?.map(Number) ?? [];
	const parts = (run: RunRecord, now = NOW): string[] => runStatusText(run, now).replace(/^storm ▶ /, "").split(" · ");
	const at = (run: RunRecord, now = NOW): RunRecord & { startedAt: string } => ({ ...run, startedAt: new Date(now).toISOString() });

	test("the round in progress starts at one and never passes the bound", () => {
		const run = at(runRecord({ turns: 0, maxRounds: 4 }));
		expect(parts(run)[0]).toStartWith("1/4");
		expect(parts({ ...run, turns: 1 })[0]).toStartWith("2/4");
		expect(parts({ ...run, turns: 4 })[0]).toStartWith("4/4");
		expect(parts({ ...run, turns: 9 })[0]).toStartWith("4/4");
		expect(numbers(parts(runRecord({ turns: 1 }))[0])).toEqual([2]);
	});

	test("the agents part is absent without agents and counts the running ones", () => {
		const run = at(runRecord({ turns: 0, maxRounds: 4 }));
		expect(parts(run)).toHaveLength(3);
		const agents = [agentEntry({ id: "a", state: "running" }), agentEntry({ id: "b", state: "idle" }), agentEntry({ id: "c", state: "running" })];
		const withAgents = parts({ ...run, agents });
		expect(withAgents).toHaveLength(4);
		expect(numbers(withAgents[1])).toEqual([3, 2]);
		expect(numbers(parts({ ...run, agents: [agentEntry({ state: "idle" })] })[1])).toEqual([1]);
	});

	test("spend shows the budget only when the run has one", () => {
		const run = at({ ...runRecord({ turns: 0, maxRounds: 4 }), costUsd: 1.25 });
		expect(parts(run)[1]).toBe("$1.25");
		expect(parts({ ...run, budget: { perRunUsd: 5, onExceed: "stop" } })[1]).toBe("$1.25/$5.00");
	});

	test("whole minutes come from the given now", () => {
		const run = at(runRecord({ turns: 0, maxRounds: 4 }));
		expect(numbers(parts(run, NOW + 59_999).at(-1))).toEqual([0]);
		expect(numbers(parts(run, NOW + 12 * 60_000 + 59_000).at(-1))).toEqual([12]);
		expect(numbers(parts(run, NOW + 60 * 60_000).at(-1))).toEqual([60]);
	});
});

describe("resumeRunLine", () => {
	test("one line with the request head, the rounds and the end time", () => {
		const long = "t".repeat(200);
		const run = runRecord({ task: "task-head-only", request: long, status: "stopped", endReason: "interrupted", turns: 2, maxRounds: 4, endedAt: "2026-11-20T09:30:00.000Z" });
		const line = resumeRunLine(run);
		expect(line.startsWith("- ")).toBe(true);
		expect(line).not.toContain("\n");
		expect(line).toContain("t".repeat(80));
		expect(line).not.toContain("t".repeat(81));
		// The line shows what resuming will send, never the 200-character head the record also keeps.
		expect(line).not.toContain("task-head-only");
		expect(line).toContain("2/4");
		expect(line).not.toMatch(ISO_UTC);
		// Without a round bound only the rounds taken are shown.
		const unbounded = resumeRunLine(runRecord({ task: "short", request: "short", status: "stopped", endReason: "time-limit", turns: 3 }));
		expect(unbounded).toContain("3라운드");
		expect(unbounded).not.toContain("3/");
		expect(line).toContain("2/4라운드");
	});

	test("control characters in the stored request are made visible", () => {
		const line = resumeRunLine(runRecord({ request: "before\u0007after", status: "stopped", endReason: "interrupted" }));
		expect(line).toContain("\\u0007");
		expect(line).not.toContain("\u0007");
	});
});
