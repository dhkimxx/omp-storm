import { describe, expect, test } from "bun:test";
import { configHash, shortHash } from "../src/config/canonical.ts";
import { validateConfig } from "../src/config/schema.ts";
import { renderApproval } from "../src/proposals/present.ts";
import { changedFields, renderConfigDiff, renderStatus, renderStatusBrief, renderTrial } from "../src/view/render.ts";
import { rollbackLabels, runRollback } from "../src/view/review.ts";
import { recommendedConfig } from "../src/view/setup.ts";
import { agentRows, renderAgentRows } from "../src/report/agents.ts";
import { DEFAULT_WORKERS, roleTitle } from "../src/roles.ts";
import type { RollbackOption, StatusView, StormConfig, TrialConfig, TrialView } from "../src/types.ts";
import { agentEntry, approvalRecord, runRecord } from "./fixtures.ts";
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
			parallelism: 4,
			isolation: "shared",
			cleanup: true,
			fallbackRole: "implementer",
		});
		const checked = validateConfig(config);
		expect(checked.errors).toEqual([]);
		expect(checked.warnings).toEqual([]);
	});

	test("the fallback is the recommendation's, also when it lies beyond the listed candidates", () => {
		const config = recommendedConfig([rec("implementer", [cand("a/i"), cand("a/k")], cand("q/far", { effort: "xhigh" }))], "quality");
		expect(config.roles.implementer!.models).toEqual(["a/i:medium", "q/far:xhigh"]);
		expect(recommendedConfig([rec("implementer", [cand("a/i")])], "quality").roles.implementer!.models).toEqual(["a/i:medium"]);
	});

	test("re-setup keeps what the user chose: switches, budget, caps, worker ranges, disabled roles, run settings, trials", () => {
		const current: StormConfig = {
			version: 1,
			priority: "balanced",
			roles: {
				explorer: { agent: "storm-explorer", models: ["old/x"], workers: { min: 1, max: 7 }, contextCap: 90_000 },
				implementer: { agent: "storm-implementer", models: ["old/i"], workers: 3 },
			},
			parallelism: 9,
			isolation: "isolated",
			budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "stop" },
			contextCap: 150_000,
			docs: false,
			disabledRoles: ["reviewer"],
			trials: [{ ...trial, role: "explorer" }, trial],
		};
		const next = recommendedConfig(recs("2"), "cost", current);
		expect(next).toEqual({
			version: 1,
			priority: "cost",
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x2:low", "b/z2:medium"], workers: { min: 1, max: 7 }, contextCap: 90_000 },
				implementer: { agent: "storm-implementer", models: ["a/i2", "c/j2:medium"], workers: { min: 3, max: 3 } },
			},
			parallelism: 9,
			isolation: "isolated",
			budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "stop" },
			contextCap: 150_000,
			docs: false,
			disabledRoles: ["reviewer"],
			// The reviewer's trial went with the role; other agents stay blocked because the current team blocked them.
			trials: [{ ...trial, role: "explorer" }],
		});
		expect(validateConfig(next).errors).toEqual([]);
	});

	test("cleanup is recommended only on a first setup; a current team's choice stands either way", () => {
		expect(recommendedConfig(recs(), "balanced", TEAM).cleanup).toBeUndefined();
		expect(recommendedConfig(recs(), "balanced", { ...TEAM, cleanup: true }).cleanup).toBe(true);
	});

	test("the 0.8 team re-set up: nothing deprecated is written back", () => {
		const next = recommendedConfig(recs(), "balanced", JSON.parse(TEAM_08));
		expect(next).not.toHaveProperty("contract");
		expect(next).not.toHaveProperty("runtime");
		expect(next.contextCap).toBe(200_000);
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
			c => (c.parallelism = 5),
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

	test("a role's own agent definition is not listed", () => {
		expect(renderConfigDiff(undefined, TEAM)).not.toContain("storm-reviewer");
	});

	test("extra rounds are shown in force, and a change is one row with both numbers", () => {
		const next = changed(c => (c.rounds = 7));
		const md = renderConfigDiff(TEAM, next);
		expect(md).toContain("기본(3) → 7");
		expect(changedFields(TEAM, next)).toHaveLength(1);
		expect(changedFields(next, TEAM)).toHaveLength(1);
	});

	test("an explicit default is a change, because the hash sees it: absent rounds read 기본(3)", () => {
		const explicit = changed(c => (c.rounds = 3));
		expect(configHash(explicit)).not.toBe(configHash(TEAM));
		expect(renderConfigDiff(TEAM, explicit)).toContain("기본(3) → 3");
		expect(renderConfigDiff(explicit, TEAM)).toContain("3 → 기본(3)");
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

	test("quota and usage sections exist only when they were read", () => {
		const bare = renderStatus(view(), NOW);
		const read = renderStatus(view({ quota: [{ provider: "prov-q", state: "limited", usedFraction: 0.42, resetsAt: null }], dataAsOf: NOW - 3_600_000 }), NOW);
		expect(read).toContain("prov-q");
		expect(read).toContain("42%");
		expect(read.split("\n").length).toBeGreaterThan(bare.split("\n").length + 3);
		expect(bare).not.toContain("—");
	});

	test("subagents are the shared table; the section is absent without any", () => {
		const table = renderAgentRows(agentRows([agent], TEAM), NOW);
		expect(renderStatus(view({ agents: [agent] }), NOW)).toContain(table);
		expect(renderStatus(view(), NOW)).not.toContain("a1");
	});

	test("missing and invalid configs: every error is shown, never where the project is", () => {
		const missing = renderStatus(view({ config: { status: "missing", path: "/repo/c.json" }, approval: undefined }), NOW);
		const invalid = renderStatus(view({ config: { status: "invalid", path: "/repo/c.json", errors: ["error-one", "error-two"] }, approval: undefined }), NOW);
		for (const part of ["error-one", "error-two"]) expect(invalid).toContain(part);
		for (const text of [missing, invalid, renderStatus(view(), NOW)]) expect(text).not.toContain("/repo");
	});

	test("the whole team setting is in the full status: every switch and run setting changes it", () => {
		const of = (over: Partial<StormConfig>) => renderStatus(view({ config: { status: "ok", path: "/repo/c.json", config: { ...TEAM, ...over }, hash, warnings: [] } }), NOW);
		const base = of({});
		for (const over of [{ priority: "quality" }, { parallelism: 9 }, { isolation: "isolated" }, { cleanup: true }, { docs: false }, { contextCap: 123_456 }, { fallbackRole: "implementer" }, { budget: { perRunUsd: 7.5, onExceed: "stop" } }] as Array<Partial<StormConfig>>) {
			expect(of(over)).not.toBe(base);
		}
		expect(of({ contextCap: 123_456 })).toContain("123,456");
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
		expect(removed[0]).toContain("3");
		expect(added[0]).toContain("7");
		expect(set.indexOf(added[0]!)).toBe(base.indexOf(removed[0]!));
	});

	test("for the model: no commands, no cost flags and no paths, with the shadowing definition still named", () => {
		const busy = view({
			shadows: [{ agent: "storm-reviewer", path: "/home/u/.omp/agent/agents/x.md", scope: "user", sha256: "s" }],
			ompAdvice: [{ key: "task.maxConcurrency", message: "advice-text", command: "omp config set task.maxConcurrency 4" }],
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

	test("the brief keeps hash, models and what needs a look in a few lines", () => {
		const full = view({ run, trials: [{ trial, state: undefined, phase: "active" }], dataAsOf: NOW, quota: [{ provider: "prov-q", state: "limited", usedFraction: 0.42, resetsAt: null }] });
		const brief = renderStatusBrief(full, NOW);
		expect(brief).toContain(shortHash(hash));
		for (const part of ["a/x → b/z", "run-1", "/storm status"]) expect(brief).toContain(part);
		expect(brief).not.toContain("prov-q");
		expect(brief.split("\n").length).toBeLessThan(renderStatus(full, NOW).split("\n").length / 2);
		expect(brief).not.toMatch(ISO_UTC);
	});
});
