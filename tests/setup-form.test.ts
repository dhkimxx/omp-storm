import { describe, expect, test } from "bun:test";
import { defaultFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { type ChoiceField, type FormField, type HtmlForm, parseHtmlForm, spansText, type TextField } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { validateConfig } from "../src/config/schema.ts";
import { recommendedConfig } from "../src/view/setup.ts";
import { BROWSE, commonSettingsForm, effortForm, FIELD, interviewRoles, MODEL_DEFAULT, NONE, pickedEntry, readRoleChoices, recommendationNotes, type RoleAnswers, roleForm, type SetupFormInput, type SetupResult, setupConfig } from "../src/setup/form.ts";
import type { FormData, RoleId, StormConfig } from "../src/types.ts";
import { cand, fakeCtx, model, rec, recs, TEAM } from "./support.ts";

const MODELS = [...fakeCtx().available, model("a/y", { efforts: ["low", "medium"] })].filter((m, i, all) => all.findLastIndex(x => x.selector === m.selector) === i);

function input(current?: StormConfig, over: Partial<SetupFormInput> = {}): SetupFormInput {
	return { recs: recs(), proposed: recommendedConfig(recs(), "balanced", current), ...(current ? { current } : {}), models: MODELS, ...over };
}

function field(form: HtmlForm, name: string): FormField {
	const found = form.fields.find(f => f.name === name);
	if (!found) throw new Error(`no field ${name}`);
	return found;
}
function choiceOf(form: HtmlForm, name: string): ChoiceField {
	const f = field(form, name);
	if (f.kind !== "choice") throw new Error(`${name} is not a choice`);
	return f;
}
function textOf(form: HtmlForm, name: string): TextField {
	const f = field(form, name);
	if (f.kind !== "text") throw new Error(`${name} is not a text field`);
	return f;
}
const values = (f: ChoiceField) => f.options.map(o => o.value);
const checked = (f: ChoiceField) => f.options.filter(o => o.checked).map(o => o.value);

function page(inp: SetupFormInput, id: RoleId, browse = false) {
	const roles = interviewRoles(inp, browse);
	return parseHtmlForm(roleForm(inp, id, browse, roles.indexOf(id) + 1, roles.length));
}

/** Default interview answers, with selected role/slot or common answers overridden. */
function submit(inp: SetupFormInput, over: FormData = {}, efforts: Partial<Record<RoleId, { primary?: string; fallback?: string }>> = {}): SetupResult {
	const choices: RoleAnswers = {};
	for (const id of interviewRoles(inp, false)) {
		const pick = readRoleChoices(inp, id, false, { ...defaultFormData(page(inp, id)), ...over });
		if ("errors" in pick) return pick;
		if ("disabled" in pick) choices[id] = pick;
		else choices[id] = {
			primary: pickedEntry(inp, id, pick.primary, efforts[id]?.primary),
			...(pick.fallback ? { fallback: pickedEntry(inp, id, pick.fallback, efforts[id]?.fallback) } : {}),
			workers: pick.workers,
		};
	}
	return setupConfig(inp, choices, { ...defaultFormData(parseHtmlForm(commonSettingsForm(inp))), ...over });
}
function configOf(result: SetupResult): StormConfig {
	if ("errors" in result) throw new Error(result.errors.join("; "));
	return result.config;
}

describe("role form", () => {
	test("only one role's fields are shown, with table, step count and defaults", () => {
		const inp = input();
		const form = page(inp, "explorer");
		const section = form.sections.find(s => s.fieldset)!;
		const table = section.blocks.find(b => b.kind === "table")!;
		expect(roleForm(inp, "explorer", false, 1, 3)).toContain("(1/3) · storm-explorer");
		expect(table.headerRows).toBe(1);
		expect(table.rows).toHaveLength(4);
		expect(table.rows[0]).toHaveLength(7);
		expect(spansText(table.rows[1]![0]!)).toContain("a/x");
		expect(form.fields.map(f => f.name)).toEqual(["primary_explorer", "fallback_explorer", "workers_min_explorer", "workers_max_explorer"]);
		expect(values(choiceOf(form, "primary_explorer"))).toEqual(["a/x", "a/y", "b/z", NONE]);
		expect(values(choiceOf(form, "fallback_explorer"))).toEqual([NONE, "a/x", "a/y", "b/z"]);
		expect(values(choiceOf(page(inp, "implementer"), "primary_implementer"))).toEqual(["a/i", "c/j"]);
		expect(defaultFormData(form)).toEqual({
			primary_explorer: "a/x", fallback_explorer: "b/z", workers_min_explorer: 1, workers_max_explorer: 4,
		});
		const workers = textOf(form, "workers_max_explorer");
		expect([workers.type, workers.min, workers.max, workers.required]).toEqual(["number", 1, 16, true]);
	});

	test("the table carries price tier, cost, speed, score with ≈, own usage and the quota note", () => {
		const exhausted = cand("a/i", { int: { value: 61.4, source: "lineage", approx: true }, tier: "premium", referenceUsd: 0.5, quota: "exhausted", quotaResetsAt: Date.parse("2026-11-21T03:00:00Z") });
		const inp = input(undefined, { recs: [rec("implementer", [exhausted, cand("c/j")])], usage: new Map([["a/i", 0.42]]) });
		const table = page(inp, "implementer").sections.find(s => s.fieldset)!.blocks.find(b => b.kind === "table")!;
		const row = table.rows[1]!.map(cell => spansText(cell));
		expect(row[2]).toContain("0.5");
		expect(row[4]).toBe("≈61");
		expect(row[5]).toBe("42%");
		expect(row[6]).toContain("2026-11-21");
		expect(row[1]).not.toBe(spansText(table.rows[2]![1]!));
	});

	test("re-setup opens on the current team: its models are offered even when they are not candidates, and a disabled role stays off", () => {
		const current: StormConfig = {
			...TEAM,
			roles: { implementer: { agent: "storm-implementer", models: ["old/i:high", "c/j"] }, explorer: TEAM.roles.explorer! },
			disabledRoles: ["reviewer"],
		};
		const inp = input(current);
		const form = page(inp, "implementer");
		expect(values(choiceOf(form, "primary_implementer"))).toEqual(["a/i", "c/j", "old/i"]);
		expect(checked(choiceOf(form, "primary_implementer"))).toEqual(["old/i"]);
		expect(checked(choiceOf(form, "fallback_implementer"))).toEqual(["c/j"]);
		expect(checked(choiceOf(page(inp, "reviewer"), "primary_reviewer"))).toEqual([NONE]);
		expect(checked(choiceOf(page(inp, "explorer"), "primary_explorer"))).toEqual(["a/x"]);
	});

	test("the native picker opens choices for roles without recommendations in both slots", () => {
		const inp = input(undefined, { recs: [...recs(), rec("architect", [])] });
		expect(interviewRoles(inp, false)).not.toContain("architect");
		expect(interviewRoles(inp, true)).toContain("architect");
		const form = page(inp, "architect", true);
		expect(values(choiceOf(form, "primary_architect"))).toEqual([BROWSE, NONE]);
		expect(values(choiceOf(form, "fallback_architect"))).toEqual([NONE, BROWSE]);
		expect(readRoleChoices(inp, "architect", true, defaultFormData(form))).toEqual({ disabled: false });
		const missing = input(undefined, { recs: [], proposed: recommendedConfig([], "balanced") });
		expect(checked(choiceOf(page(missing, "implementer", true), "primary_implementer"))).toEqual([BROWSE]);
	});
});

describe("role answers", () => {
	const inp = input();
	const read = (id: RoleId, over: FormData) => readRoleChoices(inp, id, false, { ...defaultFormData(page(inp, id)), ...over });

	test("disabled roles ignore fallback and worker answers; identical fallback is omitted", () => {
		expect(read("explorer", { primary_explorer: NONE, workers_min_explorer: "" })).toEqual({ disabled: true });
		expect(read("reviewer", { fallback_reviewer: "b/r" })).toEqual({ primary: "b/r", workers: expect.any(Object) });
	});

	test("unoffered answers fall back to defaults; the required role cannot be turned off", () => {
		expect(read("explorer", { primary_explorer: "x/unknown", fallback_explorer: 7 })).toEqual({
			primary: "a/x", fallback: "b/z", workers: { min: 1, max: 4 },
		});
		expect(read("implementer", { primary_implementer: NONE })).toMatchObject({ primary: "a/i" });
	});

	test("retry shows errors and preserves role fields, including native selections", () => {
		const answers = { primary_explorer: BROWSE, fallback_explorer: "a/y", workers_min_explorer: 5, workers_max_explorer: 4 };
		const parsed = readRoleChoices(inp, "explorer", true, answers);
		if (!("errors" in parsed)) throw new Error("expected invalid workers");
		expect(parsed.errors).toHaveLength(1);
		const form = parseHtmlForm(roleForm(inp, "explorer", true, 1, 6, { answers, errors: parsed.errors }));
		expect(defaultFormData(form)).toEqual(answers);
		const list = form.sections[0]!.blocks.find(b => b.kind === "list");
		expect(list?.kind === "list" && list.items.map(spansText)).toEqual(parsed.errors);
	});
});

describe("common settings form", () => {
	test("only common fields, with the defaults of first setup", () => {
		const form = parseHtmlForm(commonSettingsForm(input()));
		expect(defaultFormData(form)).toEqual({
			rounds: "",
			budget_usd: 0,
			budget_warn_usd: 0,
			budget_exceed: "block-spawns",
			cleanup: "on",
			docs: "on",
		});
		expect(form.fields.map(f => f.name)).toEqual(["rounds", "budget_usd", "budget_warn_usd", "budget_exceed", "cleanup", "docs"]);
		const rounds = textOf(form, "rounds");
		expect([rounds.type, rounds.min, rounds.max, rounds.required]).toEqual(["number", 0, 10, false]);
		expect(textOf(form, "budget_usd").min).toBe(0);
		expect(values(choiceOf(form, "budget_exceed"))).toEqual(["block-spawns", "stop"]);
	});

	test("each slot offers only its own model's efforts; native models need not be in recommendations", () => {
		const inp = input();
		const native = model("other/native", { efforts: ["minimal", "xhigh"] });
		const fallback = effortForm(inp, "explorer", "폴백", native.selector, native)!;
		expect(fallback).toContain("폴백 · other/native");
		expect(values(choiceOf(parseHtmlForm(fallback), FIELD.effort))).toEqual([MODEL_DEFAULT, "minimal", "xhigh"]);
		const primary = parseHtmlForm(effortForm(inp, "explorer", "주 모델", "a/y")!);
		expect(values(choiceOf(primary, FIELD.effort))).toEqual([MODEL_DEFAULT, "low", "medium"]);
		expect(effortForm(inp, "reviewer", "폴백", "other/noeffort", model("other/noeffort", { efforts: [] }))).toBeUndefined();
		expect(effortForm(inp, "reviewer", "주 모델", "old/unavailable")).toBeUndefined();
	});

	test("re-setup opens on the current settings", () => {
		const current: StormConfig = { ...TEAM, rounds: 2, budget: { perRunUsd: 5, warnAtUsd: 3, onExceed: "stop" }, docs: false };
		const inp = input(current);
		const form = parseHtmlForm(commonSettingsForm(inp));
		expect(defaultFormData(page(inp, "implementer"))).toMatchObject({ workers_min_implementer: 1, workers_max_implementer: 3 });
		expect(defaultFormData(parseHtmlForm(effortForm(inp, "reviewer", "주 모델", "b/r")!))).toEqual({ effort: "high" });
		expect(defaultFormData(form)).toMatchObject({
			rounds: 2,
			budget_usd: 5,
			budget_warn_usd: 3,
			budget_exceed: "stop",
			cleanup: "off",
			docs: "off",
		});
	});

	test("reopened with errors: they are listed and the typed answers are kept", () => {
		const inp = input();
		const first = defaultFormData(parseHtmlForm(commonSettingsForm(inp)));
		const answers = { ...first, rounds: 5, cleanup: "off" };
		const form = parseHtmlForm(commonSettingsForm(inp, { answers, errors: ["error-one", "error-two"] }));
		const list = form.sections[0]!.blocks.find(b => b.kind === "list");
		expect(list?.kind === "list" && list.items.map(spansText)).toEqual(["error-one", "error-two"]);
		expect(defaultFormData(form)).toEqual(answers);
	});
});

describe("answers to config", () => {
	test("the default interview gives the recommended team on a first setup", () => {
		const inp = input();
		const built = submit(inp);
		expect(built).toEqual({ config: inp.proposed, warnings: [] });
		// A fresh team recommends implementation at 1~4 workers and writes no team-wide cap.
		const config = configOf(built);
		expect(config.roles.implementer!.workers).toEqual({ min: 1, max: 4 });
		expect(config).not.toHaveProperty("parallelism");
	});

	test("the default interview preserves the current team, including legacy role effort", () => {
		for (const current of [TEAM, { ...TEAM, budget: { perRunUsd: 5, onExceed: "stop" }, cleanup: true, docs: false } satisfies StormConfig]) {
			expect(configOf(submit(input(current)))).toEqual(current);
		}
	});

	test("requiredChecks survives a recommended or manual model change, in order", () => {
		const requiredChecks = [
			{ name: "unit", argv: ["bun", "test"] },
			{ name: "types", argv: ["bunx", "tsc", "--noEmit"] },
		];
		const current: StormConfig = { ...TEAM, requiredChecks };
		expect(recommendedConfig(recs(), "balanced", current).requiredChecks).toEqual(requiredChecks);
		const built = configOf(submit(input(current), { primary_explorer: "a/y" }));
		expect(built.requiredChecks).toEqual(requiredChecks);
		expect(validateConfig(built).warnings).toEqual([]);
	});

	test("rounds is written only when a number was typed; blank means no limit", () => {
		// A blank field submits as an empty string, which is how the form parser hands back an untouched number input.
		expect(configOf(submit(input()))).not.toHaveProperty("rounds");
		expect(configOf(submit(input(), { rounds: "" }))).not.toHaveProperty("rounds");
		expect(configOf(submit(input(), { rounds: 0 })).rounds).toBe(0);
		expect(configOf(submit(input(), { rounds: 3 })).rounds).toBe(3);
		expect(configOf(submit(input(), { rounds: 10 })).rounds).toBe(10);
		const current: StormConfig = { ...TEAM, rounds: 5 };
		// An existing value is shown and kept; blanking it removes the limit.
		expect(defaultFormData(parseHtmlForm(commonSettingsForm(input(current)))).rounds).toBe(5);
		expect(configOf(submit(input(current)))).toEqual(current);
		expect(configOf(submit(input(current), { rounds: "" }))).not.toHaveProperty("rounds");
		expect(configOf(submit(input(current), { rounds: 3 })).rounds).toBe(3);
	});

	test("a retry after another field's error keeps the rounds field blank", () => {
		const inp = input();
		const answers: FormData = { ...defaultFormData(parseHtmlForm(commonSettingsForm(inp))), budget_usd: -1 };
		expect(answers.rounds).toBe("");
		const built = submit(inp, { budget_usd: -1 });
		expect("errors" in built && built.errors.length).toBeGreaterThan(0);
		const reopened = parseHtmlForm(commonSettingsForm(inp, { answers, errors: ["error-one"] }));
		expect(defaultFormData(reopened).rounds).toBe("");
		expect(textOf(reopened, "rounds").required).toBe(false);
	});

	test("rounds outside 0~10 is an error and gives no config", () => {
		for (const rounds of [-1, 11, 2.5]) {
			const built = submit(input(), { rounds });
			expect("errors" in built && built.errors).toHaveLength(1);
			expect("config" in built).toBe(false);
		}
	});

	test("사용 안 함 moves the role to disabledRoles and takes its settings out; 폴백 없음 leaves one model", () => {
		const built = submit(input(), { primary_reviewer: NONE, fallback_explorer: NONE });
		const config = configOf(built);
		expect(Object.keys(config.roles)).toEqual(["explorer", "implementer"]);
		expect(config.disabledRoles).toEqual(["reviewer"]);
		expect(config.roles.explorer!.models).toEqual(["a/x:low"]);
		expect(validateConfig(config).errors).toEqual([]);
	});

	test("a role turned back on leaves disabledRoles; settings that named a dropped role go with it, with a warning for the fallback role", () => {
		const trial = { id: "t1", role: "reviewer", model: "c/j", share: 0.5, maxSpawns: 5, startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z", budgetUsd: 1 };
		const current: StormConfig = { ...TEAM, fallbackRole: "reviewer", trials: [trial] };
		const dropped = submit(input(current), { primary_reviewer: NONE });
		const off = configOf(dropped);
		expect(off.disabledRoles).toEqual(["reviewer"]);
		expect(off.fallbackRole).toBeUndefined();
		expect(off.trials).toBeUndefined();
		// Other agents become blocked during runs: the approval dialog says so.
		expect("warnings" in dropped && dropped.warnings).toHaveLength(1);
		expect(submit(input(current))).toEqual({ config: current, warnings: [] });

		const on = configOf(submit(input(off), { primary_reviewer: "b/r" }));
		expect(on.disabledRoles).toBeUndefined();
		expect(on.roles.reviewer!.models).toEqual(["b/r:high"]);
	});

	test("a trial whose candidate becomes the role's primary is dropped; another role's trial stays", () => {
		const trial = { id: "t1", role: "implementer", model: "c/j", share: 0.5, maxSpawns: 5, startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z", budgetUsd: 1 };
		const other = { ...trial, id: "t2", role: "reviewer", model: "c/cand" };
		const current: StormConfig = { ...TEAM, trials: [trial, other] };
		expect(configOf(submit(input(current), { primary_implementer: "c/j" })).trials).toEqual([other]);
		expect(configOf(submit(input(current))).trials).toEqual([trial, other]);
	});

	test("a role with more than one fallback keeps the rest behind the picked ones", () => {
		const three: StormConfig = { ...TEAM, roles: { ...TEAM.roles, implementer: { agent: "storm-implementer", models: ["a/i", "c/j:high", "b/z:low"], workers: { min: 1, max: 3 } } } };
		const models = (over: FormData = {}) => configOf(submit(input(three), over)).roles.implementer!.models;
		expect(configOf(submit(input(three)))).toEqual(three);
		expect(models({ workers_max_implementer: 4 })).toEqual(["a/i", "c/j:high", "b/z:low"]);
		expect(models({ primary_implementer: "c/j", fallback_implementer: "a/i" })).toEqual(["c/j:high", "a/i", "b/z:low"]);
		// Picking the third as the fallback does not list it twice; no fallback means none at all.
		expect(models({ fallback_implementer: "b/z" })).toEqual(["a/i", "b/z:low"]);
		expect(models({ fallback_implementer: NONE })).toEqual(["a/i"]);
		// The form says there is more than the one fallback it asks about.
		expect(roleForm(input(three), "implementer", false, 2, 3)).toContain("폴백이 1개 더 있습니다(b/z)");
	});

	test("primary and fallback have independent effort answers, clamped to the respective ladder", () => {
		const high = configOf(submit(input(), { primary_explorer: "a/y" }, { explorer: { primary: "xhigh" } }));
		expect(high.roles.explorer!.models[0]).toBe("a/y:medium");
		const junk = configOf(submit(input(), { primary_explorer: "a/y" }, { explorer: { primary: "turbo" } }));
		expect(junk.roles.explorer!.models[0]).toBe("a/y:medium");
		const bare = configOf(submit(input(), {}, { explorer: { primary: MODEL_DEFAULT } }));
		expect(bare.roles.explorer!.models[0]).toBe("a/x");
		const distinct = configOf(submit(input(), { fallback_explorer: "a/y" }, { explorer: { primary: "high", fallback: "low" } }));
		expect(distinct.roles.explorer!.models).toEqual(["a/x:high", "a/y:low"]);
	});

	test("a model with no known effort levels keeps the entry it has", () => {
		const current: StormConfig = { ...TEAM, roles: { ...TEAM.roles, implementer: { agent: "storm-implementer", models: ["old/i:xhigh"], workers: { min: 1, max: 3 } } } };
		const config = configOf(submit(input(current), { workers_max_implementer: 5 }));
		expect(config.roles.implementer).toEqual({ agent: "storm-implementer", models: ["old/i:xhigh"], workers: { min: 1, max: 5 } });
	});

	test("budget 0 means none; a budget keeps its warn level only above 0", () => {
		const current: StormConfig = { ...TEAM, budget: { perRunUsd: 5, warnAtUsd: 3, onExceed: "stop" } };
		expect(configOf(submit(input(current), { budget_usd: 0 })).budget).toBeUndefined();
		expect(configOf(submit(input(), { budget_usd: 2.5, budget_exceed: "stop" })).budget).toEqual({ perRunUsd: 2.5, onExceed: "stop" });
		expect(configOf(submit(input(), { budget_usd: 4, budget_warn_usd: 1 })).budget).toEqual({ perRunUsd: 4, warnAtUsd: 1, onExceed: "block-spawns" });
	});

	test("run settings and switches map to the config", () => {
		const config = configOf(submit(input(), { rounds: 7, cleanup: "off", docs: "off", workers_min_explorer: 1, workers_max_explorer: 6 }));
		expect(config).toMatchObject({ rounds: 7, docs: false });
		expect(config.cleanup).toBeUndefined();
		expect(config.roles.explorer!.workers).toEqual({ min: 1, max: 6 });
		expect(validateConfig(config).errors).toEqual([]);
	});

	test("numbers that are missing or out of range are errors, not a config: one each, in the form's words, not the schema's paths", () => {
		const mistakes: FormData[] = [
			{ workers_min_explorer: 5, workers_max_explorer: 2 },
			{ workers_max_reviewer: 2.5 },
			{ budget_usd: 2, budget_warn_usd: 3 },
			{ rounds: 11 },
			{ rounds: 2.5 },
			{ budget_usd: -1 },
		];
		for (const over of mistakes) {
			const built = submit(input(), over);
			const errors = "errors" in built ? built.errors : [];
			expect(errors).toHaveLength(1);
			expect(errors[0]).not.toMatch(/roles\.|[a-z]+\.[a-z]|perRunUsd|warnAtUsd|explorer|reviewer/);
		}
		const common = submit(input(), { rounds: 11, budget_usd: 2, budget_warn_usd: 3 });
		expect("errors" in common && common.errors).toHaveLength(2);
	});

	test("a fallback on the primary's provider is kept with a warning", () => {
		const built = submit(input(), { fallback_explorer: "a/y" });
		expect(configOf(built).roles.explorer!.models).toEqual(["a/x:low", "a/y:medium"]);
		expect("warnings" in built && built.warnings).toHaveLength(1);
	});
});

describe("recommendation notes", () => {
	test("one line per role of the proposed team", () => {
		const proposed = recommendedConfig(recs(), "balanced", { ...TEAM, disabledRoles: ["reviewer"], roles: { implementer: TEAM.roles.implementer!, explorer: TEAM.roles.explorer! } });
		const lines = recommendationNotes(recs(), proposed).split("\n").filter(line => line.startsWith("- "));
		expect(lines).toHaveLength(2);
		expect(recommendationNotes([], proposed)).toBe("");
	});
});
