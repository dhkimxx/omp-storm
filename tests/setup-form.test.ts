import { describe, expect, test } from "bun:test";
import { defaultFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { type ChoiceField, type FormField, type HtmlForm, parseHtmlForm, spansText, type TextField } from "@oh-my-pi/pi-tui/html-form/parse";
import { validateConfig } from "../src/config/schema.ts";
import { recommendedConfig } from "../src/view/setup.ts";
import { FIELD, MODEL_DEFAULT, type ModelPicks, modelsForm, NONE, readModelPicks, recommendationNotes, type SetupFormInput, type SetupResult, settingsForm, setupConfig } from "../src/setup/form.ts";
import type { FormData, StormConfig } from "../src/types.ts";
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

/** Both forms answered as they open, with `over` replacing answers of either. */
function submit(inp: SetupFormInput, over: FormData = {}) {
	const picks = readModelPicks(inp, { ...defaultFormData(parseHtmlForm(modelsForm(inp))), ...over });
	const settings = parseHtmlForm(settingsForm(inp, picks));
	return { picks, settings, built: setupConfig(inp, picks, { ...defaultFormData(settings), ...over }) };
}
function configOf(result: SetupResult): StormConfig {
	if ("errors" in result) throw new Error(result.errors.join("; "));
	return result.config;
}

describe("models form", () => {
	test("first setup: one section per role with candidates, a table, and selects that open on the recommendation", () => {
		const form = parseHtmlForm(modelsForm(input()));
		const sections = form.sections.filter(s => s.fieldset);
		expect(sections).toHaveLength(3);
		for (const section of sections) {
			expect(section.blocks.map(b => b.kind)).toEqual(["text", "table", "field", "field"]);
		}
		const table = sections[0]!.blocks[1]!;
		if (table.kind !== "table") throw new Error("no table");
		expect(table.headerRows).toBe(1);
		expect(table.rows).toHaveLength(4);
		expect(table.rows[0]).toHaveLength(7);
		expect(spansText(table.rows[1]![0]!)).toContain("a/x");

		expect(form.fields.map(f => f.name)).toEqual(["explorer", "implementer", "reviewer"].flatMap(id => [`primary_${id}`, `fallback_${id}`]));
		for (const f of form.fields) expect(f.kind === "choice" && f.select && !f.multi && !f.other).toBe(true);
		expect(values(choiceOf(form, "primary_explorer"))).toEqual(["a/x", "a/y", "b/z", NONE]);
		expect(values(choiceOf(form, "fallback_explorer"))).toEqual([NONE, "a/x", "a/y", "b/z"]);
		// The required role cannot be turned off.
		expect(values(choiceOf(form, "primary_implementer"))).toEqual(["a/i", "c/j"]);
		expect(defaultFormData(form)).toEqual({
			primary_explorer: "a/x",
			fallback_explorer: "b/z",
			primary_implementer: "a/i",
			fallback_implementer: "c/j",
			primary_reviewer: "b/r",
			fallback_reviewer: NONE,
		});
	});

	test("the table carries price tier, cost, speed, score with ≈, own usage and the quota note", () => {
		const exhausted = cand("a/i", { int: { value: 61.4, source: "lineage", approx: true }, tier: "premium", referenceUsd: 0.5, quota: "exhausted", quotaResetsAt: Date.parse("2026-11-21T03:00:00Z") });
		const inp = input(undefined, { recs: [rec("implementer", [exhausted, cand("c/j")])], usage: new Map([["a/i", 0.42]]) });
		const table = parseHtmlForm(modelsForm({ ...inp, proposed: recommendedConfig(inp.recs as never, "balanced") })).sections.find(s => s.fieldset)!.blocks[1]!;
		if (table.kind !== "table") throw new Error("no table");
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
		const form = parseHtmlForm(modelsForm(input(current)));
		expect(values(choiceOf(form, "primary_implementer"))).toEqual(["a/i", "c/j", "old/i"]);
		expect(checked(choiceOf(form, "primary_implementer"))).toEqual(["old/i"]);
		expect(checked(choiceOf(form, "fallback_implementer"))).toEqual(["c/j"]);
		expect(checked(choiceOf(form, "primary_reviewer"))).toEqual([NONE]);
		expect(checked(choiceOf(form, "primary_explorer"))).toEqual(["a/x"]);
	});

	test("a role with nothing to offer has no section", () => {
		const form = parseHtmlForm(modelsForm(input(undefined, { recs: [...recs(), rec("architect", [])] })));
		expect(form.fields.some(f => f.name === FIELD.primary("architect"))).toBe(false);
		expect(form.fields.some(f => f.name === FIELD.primary("quick"))).toBe(false);
	});
});

describe("model picks", () => {
	const inp = input();
	const defaults = defaultFormData(parseHtmlForm(modelsForm(inp)));

	test("the form as it opens gives the recommended models", () => {
		expect(readModelPicks(inp, defaults)).toEqual({
			roles: { explorer: { primary: "a/x", fallback: "b/z" }, implementer: { primary: "a/i", fallback: "c/j" }, reviewer: { primary: "b/r" } },
			disabled: [],
		});
	});

	test("사용 안 함 drops the role and its fallback answer; 폴백 없음 and a fallback equal to the primary give none", () => {
		const picks = readModelPicks(inp, { ...defaults, primary_explorer: NONE, fallback_implementer: NONE, primary_reviewer: "b/r", fallback_reviewer: "b/r" });
		expect(picks).toEqual({ roles: { implementer: { primary: "a/i" }, reviewer: { primary: "b/r" } }, disabled: ["explorer"] });
	});

	test("an answer the form did not offer falls back to what it opened with; the required role cannot be turned off", () => {
		const picks = readModelPicks(inp, { ...defaults, primary_explorer: "x/unknown", fallback_explorer: 7, primary_implementer: NONE });
		expect(picks.roles.explorer).toEqual({ primary: "a/x", fallback: "b/z" });
		expect(picks.roles.implementer?.primary).toBe("a/i");
		expect(picks.disabled).toEqual([]);
	});
});

describe("settings form", () => {
	test("fields per used role, then the run settings, with the defaults of a first setup", () => {
		const inp = input();
		const picks = readModelPicks(inp, { ...defaultFormData(parseHtmlForm(modelsForm(inp))), primary_reviewer: NONE });
		const form = parseHtmlForm(settingsForm(inp, picks));
		expect(form.fields.map(f => f.name)).toEqual([
			...["explorer", "implementer"].flatMap(id => [`effort_${id}`, `workers_min_${id}`, `workers_max_${id}`]),
			"parallelism",
			"context_cap",
			"rounds",
			"budget_usd",
			"budget_warn_usd",
			"budget_exceed",
			"cleanup",
			"docs",
		]);
		expect(defaultFormData(form)).toEqual({
			effort_explorer: "low",
			workers_min_explorer: 2,
			workers_max_explorer: 4,
			// Recommended without an effort: the entry stays bare.
			effort_implementer: MODEL_DEFAULT,
			workers_min_implementer: 1,
			workers_max_implementer: 2,
			parallelism: 4,
			context_cap: 200_000,
			rounds: 3,
			budget_usd: 0,
			budget_warn_usd: 0,
			budget_exceed: "block-spawns",
			cleanup: "on",
			docs: "on",
		});
		const workers = textOf(form, "workers_max_explorer");
		expect([workers.type, workers.min, workers.max, workers.required]).toEqual(["number", 1, 16, true]);
		const rounds = textOf(form, "rounds");
		expect([rounds.type, rounds.min, rounds.max, rounds.required]).toEqual(["number", 0, 10, true]);
		expect(textOf(form, "budget_usd").min).toBe(0);
		expect(values(choiceOf(form, "budget_exceed"))).toEqual(["block-spawns", "stop"]);
	});

	test("the effort select offers only what the chosen primary supports, and none for a model without effort control", () => {
		const inp = input(undefined, { models: [...MODELS, model("e/noeffort", { efforts: [] })] });
		const picks: ModelPicks = { roles: { explorer: { primary: "a/y" }, implementer: { primary: "a/i" }, reviewer: { primary: "e/noeffort" } }, disabled: [] };
		const form = parseHtmlForm(settingsForm(inp, picks));
		expect(values(choiceOf(form, "effort_explorer"))).toEqual([MODEL_DEFAULT, "low", "medium"]);
		expect(form.fields.some(f => f.name === "effort_reviewer")).toBe(false);
		expect(form.fields.some(f => f.name === "workers_min_reviewer")).toBe(true);
	});

	test("re-setup opens on the current settings", () => {
		const current: StormConfig = { ...TEAM, parallelism: 7, contextCap: 150_000, rounds: 2, budget: { perRunUsd: 5, warnAtUsd: 3, onExceed: "stop" }, docs: false };
		const inp = input(current);
		const form = parseHtmlForm(settingsForm(inp, readModelPicks(inp, defaultFormData(parseHtmlForm(modelsForm(inp))))));
		expect(defaultFormData(form)).toMatchObject({
			workers_min_implementer: 1,
			workers_max_implementer: 3,
			effort_reviewer: "high",
			parallelism: 7,
			context_cap: 150_000,
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
		const picks = readModelPicks(inp, defaultFormData(parseHtmlForm(modelsForm(inp))));
		const first = defaultFormData(parseHtmlForm(settingsForm(inp, picks)));
		const answers = { ...first, workers_min_explorer: 9, parallelism: "", effort_explorer: "high", cleanup: "off" };
		const form = parseHtmlForm(settingsForm(inp, picks, { answers, errors: ["error-one", "error-two"] }));
		const list = form.sections[0]!.blocks.find(b => b.kind === "list");
		expect(list?.kind === "list" && list.items.map(spansText)).toEqual(["error-one", "error-two"]);
		expect(defaultFormData(form)).toEqual(answers);
	});
});

describe("answers to config", () => {
	test("both forms unchanged give the recommended team on a first setup", () => {
		const inp = input();
		const { built } = submit(inp);
		expect(built).toEqual({ config: inp.proposed, warnings: [] });
	});

	test("both forms unchanged give the current team back on a re-setup, also one written before per-model efforts", () => {
		for (const current of [TEAM, { ...TEAM, budget: { perRunUsd: 5, onExceed: "stop" }, cleanup: true, docs: false, contextCap: 150_000 } satisfies StormConfig]) {
			expect(configOf(submit(input(current)).built)).toEqual(current);
		}
	});

	test("rounds opens on the value in force and is written only when it differs from the default", () => {
		expect(configOf(submit(input()).built)).not.toHaveProperty("rounds");
		expect(configOf(submit(input(), { rounds: 0 }).built).rounds).toBe(0);
		expect(configOf(submit(input(), { rounds: 10 }).built).rounds).toBe(10);
		// Typing the default over an absent setting says nothing new.
		expect(configOf(submit(input(), { rounds: 3 }).built)).not.toHaveProperty("rounds");
		const current: StormConfig = { ...TEAM, rounds: 5 };
		expect(configOf(submit(input(current)).built)).toEqual(current);
		expect(configOf(submit(input(current), { rounds: 3 }).built).rounds).toBe(3);
	});

	test("rounds outside 0~10 is an error and gives no config", () => {
		for (const rounds of [-1, 11, 2.5, ""]) {
			const { built } = submit(input(), { rounds });
			expect("errors" in built && built.errors).toHaveLength(1);
			expect("config" in built).toBe(false);
		}
	});

	test("사용 안 함 moves the role to disabledRoles and takes its settings out; 폴백 없음 leaves one model", () => {
		const { built, settings } = submit(input(), { primary_reviewer: NONE, fallback_explorer: NONE });
		const config = configOf(built);
		expect(Object.keys(config.roles)).toEqual(["explorer", "implementer"]);
		expect(config.disabledRoles).toEqual(["reviewer"]);
		expect(config.roles.explorer!.models).toEqual(["a/x:low"]);
		expect(settings.fields.some(f => f.name === "workers_min_reviewer")).toBe(false);
		expect(validateConfig(config).errors).toEqual([]);
	});

	test("a role turned back on leaves disabledRoles; settings that named a dropped role go with it, with a warning for the fallback role", () => {
		const trial = { id: "t1", role: "reviewer", model: "c/j", share: 0.5, maxSpawns: 5, startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z", budgetUsd: 1 };
		const current: StormConfig = { ...TEAM, fallbackRole: "reviewer", trials: [trial] };
		const dropped = submit(input(current), { primary_reviewer: NONE }).built;
		const off = configOf(dropped);
		expect(off.disabledRoles).toEqual(["reviewer"]);
		expect(off.fallbackRole).toBeUndefined();
		expect(off.trials).toBeUndefined();
		// Other agents become blocked during runs: the approval dialog says so.
		expect("warnings" in dropped && dropped.warnings).toHaveLength(1);
		expect(submit(input(current)).built).toEqual({ config: current, warnings: [] });

		const on = configOf(submit(input(off), { primary_reviewer: "b/r" }).built);
		expect(on.disabledRoles).toBeUndefined();
		expect(on.roles.reviewer!.models).toEqual(["b/r:high"]);
	});

	test("a trial whose candidate becomes the role's primary is dropped; another role's trial stays", () => {
		const trial = { id: "t1", role: "implementer", model: "c/j", share: 0.5, maxSpawns: 5, startsAt: "2026-11-20T00:00:00.000Z", endsAt: "2026-11-27T00:00:00.000Z", budgetUsd: 1 };
		const other = { ...trial, id: "t2", role: "reviewer", model: "c/cand" };
		const current: StormConfig = { ...TEAM, trials: [trial, other] };
		expect(configOf(submit(input(current), { primary_implementer: "c/j" }).built).trials).toEqual([other]);
		expect(configOf(submit(input(current)).built).trials).toEqual([trial, other]);
	});

	test("a role with more than one fallback keeps the rest behind the picked ones", () => {
		const three: StormConfig = { ...TEAM, roles: { ...TEAM.roles, implementer: { agent: "storm-implementer", models: ["a/i", "c/j:high", "b/z:low"], workers: { min: 1, max: 3 } } } };
		const models = (over: FormData = {}) => configOf(submit(input(three), over).built).roles.implementer!.models;
		expect(configOf(submit(input(three)).built)).toEqual(three);
		expect(models({ workers_max_implementer: 4 })).toEqual(["a/i", "c/j:high", "b/z:low"]);
		expect(models({ primary_implementer: "c/j", fallback_implementer: "a/i" })).toEqual(["c/j:high", "a/i", "b/z:low"]);
		// Picking the third as the fallback does not list it twice; no fallback means none at all.
		expect(models({ fallback_implementer: "b/z" })).toEqual(["a/i", "b/z:low"]);
		expect(models({ fallback_implementer: NONE })).toEqual(["a/i"]);
		// The form says there is more than the one fallback it asks about.
		const blocks = (config: StormConfig) => parseHtmlForm(modelsForm(input(config))).sections.find(s => s.blocks.some(b => b.kind === "field" && b.field.name === FIELD.primary("implementer")))!.blocks.length;
		expect(blocks(three)).toBe(blocks(TEAM) + 1);
	});

	test("the effort is limited to what the chosen model supports", () => {
		// a/y has low and medium only.
		const high = configOf(submit(input(), { primary_explorer: "a/y", effort_explorer: "xhigh" }).built);
		expect(high.roles.explorer!.models[0]).toBe("a/y:medium");
		const junk = configOf(submit(input(), { primary_explorer: "a/y", effort_explorer: "turbo" }).built);
		expect(junk.roles.explorer!.models[0]).toBe("a/y:medium");
		const bare = configOf(submit(input(), { effort_explorer: MODEL_DEFAULT }).built);
		expect(bare.roles.explorer!.models[0]).toBe("a/x");
		// A new fallback gets the recommender's effort for it.
		const swapped = configOf(submit(input(), { primary_implementer: "c/j", fallback_implementer: "a/i", effort_implementer: "low" }).built);
		expect(swapped.roles.implementer!.models).toEqual(["c/j:low", "a/i"]);
	});

	test("a model with no known effort levels keeps the entry it has", () => {
		const current: StormConfig = { ...TEAM, roles: { ...TEAM.roles, implementer: { agent: "storm-implementer", models: ["old/i:xhigh"], workers: { min: 1, max: 3 } } } };
		const config = configOf(submit(input(current), { workers_max_implementer: 5 }).built);
		expect(config.roles.implementer).toEqual({ agent: "storm-implementer", models: ["old/i:xhigh"], workers: { min: 1, max: 5 } });
	});

	test("budget 0 means none; a budget keeps its warn level only above 0", () => {
		const current: StormConfig = { ...TEAM, budget: { perRunUsd: 5, warnAtUsd: 3, onExceed: "stop" } };
		expect(configOf(submit(input(current), { budget_usd: 0 }).built).budget).toBeUndefined();
		expect(configOf(submit(input(), { budget_usd: 2.5, budget_exceed: "stop" }).built).budget).toEqual({ perRunUsd: 2.5, onExceed: "stop" });
		expect(configOf(submit(input(), { budget_usd: 4, budget_warn_usd: 1 }).built).budget).toEqual({ perRunUsd: 4, warnAtUsd: 1, onExceed: "block-spawns" });
	});

	test("run settings and switches map to the config; the default context cap stays unwritten", () => {
		const config = configOf(submit(input(), { parallelism: 8, context_cap: 400_000, cleanup: "off", docs: "off", workers_min_explorer: 1, workers_max_explorer: 6 }).built);
		expect(config).toMatchObject({ parallelism: 8, contextCap: 400_000, docs: false });
		expect(config.cleanup).toBeUndefined();
		expect(config.roles.explorer!.workers).toEqual({ min: 1, max: 6 });
		expect(configOf(submit(input()).built).contextCap).toBeUndefined();
		expect(validateConfig(config).errors).toEqual([]);
	});

	test("numbers that are missing or out of range are errors, not a config: one each, in the form's words, not the schema's paths", () => {
		const mistakes: FormData[] = [
			{ parallelism: "" },
			{ parallelism: 99 },
			{ workers_min_explorer: 5, workers_max_explorer: 2 },
			{ workers_max_reviewer: 2.5 },
			{ budget_usd: 2, budget_warn_usd: 3 },
			{ context_cap: 1.5 },
			{ context_cap: 99_000_000 },
			{ rounds: 11 },
			{ rounds: 2.5 },
			{ budget_usd: -1 },
		];
		for (const over of mistakes) {
			const { built } = submit(input(), over);
			const errors = "errors" in built ? built.errors : [];
			expect(errors).toHaveLength(1);
			expect(errors[0]).not.toMatch(/roles\.|[a-z]+\.[a-z]|contextCap|parallelism|perRunUsd|warnAtUsd|explorer|reviewer/);
		}
		// Every mistake is reported at once.
		const all = submit(input(), Object.assign({}, ...mistakes.slice(1, 5))).built;
		expect("errors" in all && all.errors).toHaveLength(4);
	});

	test("a fallback on the primary's provider is kept with a warning", () => {
		const { built } = submit(input(), { fallback_explorer: "a/y" });
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
