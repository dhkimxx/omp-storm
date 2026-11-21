import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { defaultFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { configHash, shortHash } from "../src/config/canonical.ts";
import { validateConfig } from "../src/config/schema.ts";
import { configPath, serializeConfig } from "../src/config/store.ts";
import { prepareAnalysis } from "../src/context.ts";
import { agentsFlow, approveAndSave, type FlowEnv, hubFlow, setupFlow, statusFlow, statusText } from "../src/flows.ts";
import { recommendedConfig } from "../src/view/setup.ts";
import { isApproved, loadProjectState } from "../src/state.ts";
import type { FormData, StormConfig, TrialConfig } from "../src/types.ts";
import { APPROVE, CANCEL } from "../src/proposals/present.ts";
import { agentEntry } from "./fixtures.ts";
import { makeProject, pick, type ScriptedUi, scriptedUi, TEAM, type TestProject } from "./support.ts";
import { TEAM_08, TEAM_08_HASH, writeStore08 } from "./team-08.ts";

const NOW = Date.parse("2026-11-20T09:30:00Z");
/**
 * Answers by position. Only the approval dialog's two labels are a contract; every other dialog is pinned by how many
 * options it has and where each one leads.
 */
const FIRST = pick(0);
const SECOND = pick(1);
const THIRD = pick(2);
const LAST = pick(-1);

/** An omp catalog row; the real recommender ranks these. */
const row = (provider: string, id: string, input: number, int: number, efforts = ["low", "medium", "high"]) => ({
	provider,
	id,
	name: id,
	kind: "chat",
	cost: { input, output: input * 4, cacheRead: input / 10, cacheWrite: input },
	contextWindow: 200_000,
	thinking: { efforts },
	supportsTools: true,
	int,
	tps: 80,
	identity: { class: id.split("-")[0] },
});
const CATALOG = [row("pa", "alpha-big", 5, 70), row("pb", "beta-mid", 1, 55), row("pc", "gamma-small", 0.2, 40, []), row("pa", "alpha-mini", 0.3, 42)];

let project: TestProject;
let env: FlowEnv;

beforeEach(async () => {
	project = await makeProject(() => NOW);
	env = { ...project.env, registry: { getAll: () => CATALOG, getAvailable: () => CATALOG } };
});
afterEach(() => project.remove());

/** Storm's own recommendation for this project, carrying over `current`. */
async function recommended(current?: StormConfig): Promise<StormConfig> {
	const ctx = await prepareAnalysis(env, scriptedUi().ui);
	return recommendedConfig(ctx.recommend("balanced"), "balanced", current);
}

/** Gives the UI a form surface: each form is answered as it opens, with the next `overrides` entry on top (undefined cancels it). */
function withForms(f: ScriptedUi, overrides: Array<FormData | undefined>): { htmls: string[] } {
	const htmls: string[] = [];
	const queue = [...overrides];
	f.ui.form = async html => {
		htmls.push(html);
		if (!queue.length) throw new Error("no scripted answer for form");
		const over = queue.shift();
		return over && { ...defaultFormData(parseHtmlForm(html)), ...over };
	};
	return { htmls };
}

const load = () => loadProjectState(env);
const approve = async (config: StormConfig) => approveAndSave(await load(), config, { shadowedAgents: [] });
/** A teammate's (or a hand) edit: the file changes, nobody approves it on this machine. */
const editByHand = async (text: string) => {
	await mkdir(path.dirname(configPath(project.root)), { recursive: true });
	await writeFile(configPath(project.root), text);
};
const fileText = () => readFile(configPath(project.root), "utf8");

describe("/storm without an approved team", () => {
	test("no config: the recommended team is offered at once, and cancelling saves nothing", async () => {
		const f = scriptedUi([CANCEL]);
		expect(await hubFlow(env, f.ui)).toBe(false);
		expect(f.selects).toHaveLength(1);
		expect(f.selects[0]?.options).toEqual([APPROVE, CANCEL]);
		const state = await load();
		expect(state.config.status).toBe("missing");
		expect(await state.store.list()).toEqual([]);
	});

	test("invalid config: every error in one dialog, and setup starts only when chosen", async () => {
		await editByHand(JSON.stringify({ ...TEAM, parallelism: 99, isolation: "nope" }));
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		// Setup or nothing: an invalid file cannot be approved.
		expect(f.selects[0]?.options).toHaveLength(2);
		expect(f.selects[0]?.options).not.toContain(APPROVE);
		for (const field of ["parallelism", "isolation"]) expect(f.selects[0]?.markdown).toContain(field);

		const g = scriptedUi([FIRST, APPROVE]);
		await hubFlow(env, g.ui);
		expect(g.selects[1]?.options).toEqual([APPROVE, CANCEL]);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual(await recommended());
		expect(isApproved(state)).toBe(true);
	});

	test("invalid config with an earlier approval: rolling back restores the approved team", async () => {
		await approve(TEAM);
		await editByHand("{ not json");
		const f = scriptedUi([FIRST, FIRST, FIRST]);
		await hubFlow(env, f.ui);
		// The earlier approval adds the way back, ahead of setup and cancel.
		expect(f.selects[0]?.options).toHaveLength(3);
		expect(f.selects[0]?.options).not.toContain(APPROVE);
		const state = await load();
		expect(state.config.status === "ok" && state.config.hash).toBe(configHash(TEAM));
		expect(isApproved(state)).toBe(true);
	});

	test("unapproved config: the dialog shows what the hash covers and offers approval, rollback, setup or cancel", async () => {
		await approve(TEAM);
		const edited = { ...structuredClone(TEAM), parallelism: 9, typo: 1 } as StormConfig;
		edited.roles.reviewer!.models = ["z/teammate"];
		await editByHand(serializeConfig(edited));
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		expect(f.selects[0]?.options).toHaveLength(4);
		expect(f.selects[0]?.options[0]).toBe(APPROVE);
		const md = f.selects[0]!.markdown!;
		// The diff against the last approved team, the unknown field with its value, and a warning per model not usable here.
		for (const part of ["b/r → z/teammate", "4 → 9", "typo=1", "z/teammate: "]) expect(md).toContain(part);
		expect(isApproved(await load())).toBe(false);
		expect(f.selects).toHaveLength(1);
	});

	test("an approved snapshot that no longer validates is not diffed against: the whole team is shown", async () => {
		await approve(TEAM);
		await editByHand(serializeConfig({ ...TEAM, parallelism: 9 }));
		const intact = scriptedUi([LAST]);
		await hubFlow(env, intact.ui);
		const state = await load();
		await writeFile(path.join(state.store.dir, "snapshots", `${configHash(TEAM).split(":")[1]}.json`), JSON.stringify({ ...TEAM, parallelism: "many\n### forged" }));
		const damaged = scriptedUi([LAST]);
		await hubFlow(env, damaged.ui);
		// A diff has the one changed row; the whole team has a row per field, and nothing of the damaged file.
		const rows = (f: ScriptedUi) => f.selects[0]!.markdown!.split("\n").filter(line => line.startsWith("- ")).length;
		expect(rows(damaged)).toBeGreaterThan(rows(intact) + 3);
		expect(damaged.selects[0]?.markdown).not.toContain("forged");
		// Nothing to roll back to either.
		expect(damaged.selects[0]?.options).toHaveLength(intact.selects[0]!.options.length - 1);
	});

	test("approving approves the file as it is, without rewriting it", async () => {
		const text = `${JSON.stringify(TEAM, null, "\t")}\n\n`;
		await editByHand(text);
		const f = scriptedUi([APPROVE]);
		await hubFlow(env, f.ui);
		// No earlier approval: nothing to roll back to.
		expect(f.selects[0]?.options).toHaveLength(3);
		expect(f.selects[0]?.options[0]).toBe(APPROVE);
		expect(isApproved(await load())).toBe(true);
		expect(await fileText()).toBe(text);
	});

	test("the approval is written before the file: when it cannot be, no unapproved config is left behind", async () => {
		const state = await load();
		// The approval store's parent is a file: nothing can be written below it.
		await mkdir(env.agentDir, { recursive: true });
		await writeFile(path.join(env.agentDir, "storm"), "");
		await expect(approveAndSave(state, TEAM, { shadowedAgents: [] })).rejects.toThrow();
		expect((await load()).config.status).toBe("missing");
	});

	test("a file changed while the approval dialog is open is not approved", async () => {
		await editByHand(serializeConfig(TEAM));
		const moved = { ...TEAM, parallelism: 2 };
		const f = scriptedUi([
			async () => {
				await editByHand(serializeConfig(moved));
				return APPROVE;
			},
		]);
		await hubFlow(env, f.ui);
		const state = await load();
		expect(isApproved(state)).toBe(false);
		expect(await state.store.list()).toEqual([]);
	});

	test("rolling back from an unapproved config needs no new approval", async () => {
		await approve(TEAM);
		await editByHand(serializeConfig({ ...TEAM, parallelism: 9 }));
		const f = scriptedUi([SECOND, FIRST, FIRST]);
		await hubFlow(env, f.ui);
		const state = await load();
		expect(state.config.status === "ok" && state.config.hash).toBe(configHash(TEAM));
		expect(isApproved(state)).toBe(true);
		expect((await state.store.list()).map(r => r.configHash)).toEqual([configHash(TEAM)]);
	});

	test("a team approved by 0.8 opens the menu at once", async () => {
		await editByHand(TEAM_08);
		const before = await load();
		await writeStore08(before.store.dir, before.repo.repoId);
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		expect(f.selects[0]?.options).toHaveLength(4);
		expect(f.selects[0]?.options).not.toContain(APPROVE);
		expect(f.selects[0]?.markdown).toContain(shortHash(TEAM_08_HASH));
		expect(await fileText()).toBe(TEAM_08);
	});
});

describe("setup", () => {
	test("first setup, approved: the recommended team is saved and approved through one dialog", async () => {
		const expected = await recommended();
		expect(validateConfig(expected).errors).toEqual([]);
		const f = scriptedUi([APPROVE]);
		await setupFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		// The whole team is in the panel.
		for (const role of Object.values(expected.roles)) expect(f.selects[0]?.markdown).toContain(role.models.join(", "));
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual(expected);
		expect(isApproved(state)).toBe(true);
		expect(f.reports).toEqual([]);
	});

	test("an unanswered dialog saves nothing", async () => {
		await setupFlow(env, scriptedUi([undefined]).ui);
		expect((await load()).config.status).toBe("missing");
	});

	test("picking role by role is offered only where forms can be drawn", async () => {
		const without = scriptedUi([CANCEL]);
		await setupFlow(env, without.ui);
		expect(without.selects[0]?.options).toEqual([APPROVE, CANCEL]);
		expect(without.selects[0]?.markdown).toContain("/storm <");

		const withForm = scriptedUi([CANCEL]);
		withForms(withForm, []);
		await setupFlow(env, withForm.ui);
		expect(withForm.selects[0]?.options).toHaveLength(3);
		expect([withForm.selects[0]?.options.at(0), withForm.selects[0]?.options.at(-1)]).toEqual([APPROVE, CANCEL]);
		expect(withForm.selects[0]?.markdown).not.toContain("/storm <");
	});

	test("re-setup keeps the docs, cleanup, budget and worker choices in the proposed team", async () => {
		const current: StormConfig = {
			...TEAM,
			roles: { ...TEAM.roles, implementer: { agent: "storm-implementer", models: ["a/i"], workers: { min: 2, max: 7 } } },
			docs: false,
			cleanup: true,
			rounds: 2,
			budget: { perRunUsd: 5, warnAtUsd: 3, onExceed: "stop" },
			disabledRoles: ["architect"],
		};
		await approve(current);
		const f = scriptedUi([APPROVE]);
		await setupFlow(env, f.ui);
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(saved).toMatchObject({ docs: false, cleanup: true, rounds: 2, budget: current.budget!, disabledRoles: ["architect"] });
		expect(saved?.roles.implementer?.workers).toEqual({ min: 2, max: 7 });
		expect(saved?.roles.architect).toBeUndefined();
		// The models are the recommendation's, from this catalog.
		expect(saved?.roles.implementer?.models[0]).toStartWith("p");
		expect(isApproved(state)).toBe(true);
	});

	test("a first setup opens on what approval switches on beyond the models; a team that already has it is not told again", async () => {
		const first = scriptedUi([CANCEL]);
		await setupFlow(env, first.ui);
		const lead = first.selects[0]!.markdown!.split("\n")[0]!;
		expect(lead).not.toMatch(/^(#|\*\*|- |$)/);

		await approve({ ...TEAM, cleanup: true });
		const again = scriptedUi([CANCEL]);
		await setupFlow(env, again.ui);
		expect(again.selects[0]?.markdown).not.toContain(lead);

		// Switched off before: a re-setup keeps it off, so there is nothing to tell.
		await approve(TEAM);
		const off = scriptedUi([CANCEL]);
		await setupFlow(env, off.ui);
		expect(off.selects[0]?.markdown).not.toContain(lead);
	});

	test("a recommendation equal to the approved team asks for no approval, and still opens the forms when asked", async () => {
		const team = await recommended();
		await approve(team);
		const plain = scriptedUi();
		await setupFlow(env, plain.ui);
		expect(plain.selects).toEqual([]);

		const f = scriptedUi([FIRST, APPROVE]);
		const forms = withForms(f, [{}, { parallelism: 2 }]);
		await setupFlow(env, f.ui);
		expect(forms.htmls).toHaveLength(2);
		expect(f.selects[0]?.options).not.toContain(APPROVE);
		expect(f.selects[1]?.options).toEqual([APPROVE, CANCEL]);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual({ ...team, parallelism: 2 });
	});

	test("picking role by role: two forms, then the approval dialog saves the picked team", async () => {
		const base = await recommended();
		const f = scriptedUi([SECOND, APPROVE]);
		const forms = withForms(f, [{ primary_reviewer: "none", fallback_implementer: "none" }, { budget_usd: 3, cleanup: "off" }]);
		await setupFlow(env, f.ui);
		expect(forms.htmls).toHaveLength(2);
		expect(parseHtmlForm(forms.htmls[1]!).fields.some(field => field.name === "workers_min_reviewer")).toBe(false);
		expect(f.selects.map(s => s.options.length)).toEqual([3, 2]);
		expect(f.selects[1]?.options).toEqual([APPROVE, CANCEL]);
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(isApproved(state)).toBe(true);
		expect(saved?.disabledRoles).toEqual(["reviewer"]);
		expect(saved?.roles.reviewer).toBeUndefined();
		expect(saved?.roles.implementer?.models).toEqual([base.roles.implementer!.models[0]!]);
		expect(saved?.budget).toEqual({ perRunUsd: 3, onExceed: "block-spawns" });
		expect(saved?.cleanup).toBeUndefined();
		expect(saved?.roles.explorer).toEqual(base.roles.explorer!);
	});

	test("settings that do not validate reopen the form with the errors; a cancelled form or dialog saves nothing", async () => {
		const f = scriptedUi([SECOND, CANCEL]);
		const forms = withForms(f, [{}, { parallelism: 99 }, { parallelism: 3 }]);
		await setupFlow(env, f.ui);
		expect(forms.htmls).toHaveLength(3);
		const reopened = parseHtmlForm(forms.htmls[2]!);
		expect(reopened.sections.some(s => s.blocks.some(b => b.kind === "list"))).toBe(true);
		expect(defaultFormData(reopened).parallelism).toBe(99);
		expect((await load()).config.status).toBe("missing");

		for (const answers of [[undefined], [{}, undefined]]) {
			const g = scriptedUi([SECOND]);
			withForms(g, answers);
			await setupFlow(env, g.ui);
			expect(g.selects).toHaveLength(1);
			expect((await load()).config.status).toBe("missing");
		}
	});

	test("no usable model: nothing is asked and nothing is saved", async () => {
		const f = scriptedUi();
		await setupFlow(project.env, f.ui);
		expect(f.selects).toEqual([]);
		expect(f.notes).toHaveLength(1);
		expect((await load()).config.status).toBe("missing");
	});
});

describe("status and agents", () => {
	const agent = agentEntry({ id: "agent-one", model: "a/i", startedAt: NOW - 600_000, lastActivityAt: NOW - 60_000, costUsd: 0.1 });

	/** A status with something to advise on everywhere: a shadowing definition, an omp setting below the team's, a newer install. */
	async function busyEnv(): Promise<{ env: FlowEnv; calls: { settings: number; omp: number } }> {
		const agents = path.join(project.root, ".omp", "agents");
		await mkdir(agents, { recursive: true });
		await writeFile(path.join(agents, "shadow-file.md"), "---\nname: storm-reviewer\n---\nbody\n");
		const state = await load();
		await approveAndSave(state, TEAM, { shadowedAgents: state.shadows });
		const calls = { settings: 0, omp: 0 };
		return {
			calls,
			env: {
				...env,
				exec: (command, args, options) => {
					if (command === env.ompBin) calls.omp++;
					return env.exec(command, args, options);
				},
				ompSettings: async () => {
					calls.settings++;
					return { modelRoles: {}, maxConcurrency: 1 };
				},
				newerVersion: () => "99.0.0",
			},
		};
	}
	const sections = (md: string) => md.split("\n").filter(line => line.startsWith("### ")).length;

	test("the user's status is what /storm status shows: every section, the commands that fix things, and no repo id or root path", async () => {
		const busy = await busyEnv();
		const text = await statusText(busy.env, { quota: true });
		expect(text).toContain(shortHash(configHash(TEAM)));
		expect(text).not.toContain(project.root);
		expect(text).not.toContain((await load()).repo.repoId);
		for (const part of ["omp config set task.maxConcurrency", "99.0.0", "--max-cost", path.join(".omp", "agents", "shadow-file.md")]) expect(text).toContain(part);
		expect(busy.calls.settings).toBe(1);
		const f = scriptedUi();
		await statusFlow(busy.env, f.ui);
		expect(f.reports[0]?.markdown).toBe(text);
	});

	test("the tool's status is the same facts for the model: no advice to act on, no file paths, no CLI call, and no section whose data was not read", async () => {
		const busy = await busyEnv();
		const text = await statusText(busy.env, { quota: false });
		expect(text).toContain(shortHash(configHash(TEAM)));
		for (const part of ["omp config", "99.0.0", "/restart", "--max-cost", "maxCost", project.tmp, "shadow-file.md", path.sep + ".omp"]) expect(text).not.toContain(part);
		// The shadowing definition is still named: which agent, defined where.
		expect(text.split("\n").filter(line => line.includes("storm-reviewer") && !line.includes("b/r"))).toHaveLength(1);
		expect(busy.calls).toEqual({ settings: 0, omp: 0 });
		// Against the user's report: quota, usage advice and storage sections are gone; the stats DB is absent here, so neither has a usage section.
		const full = await statusText(busy.env, { quota: true });
		expect(sections(text)).toBeLessThan(sections(full));
		expect(full.split("\n").filter(line => line.startsWith("### "))).toEqual(expect.arrayContaining(text.split("\n").filter(line => line.startsWith("### "))));
	});

	test("agentsFlow reports the subagents table and asks nothing", async () => {
		await approve(TEAM);
		const f = scriptedUi();
		await agentsFlow({ ...env, agents: () => [agent] }, f.ui);
		expect(f.reports).toHaveLength(1);
		expect(f.reports[0]?.markdown).toContain("agent-one");
		expect(f.selects).toEqual([]);
	});
});

describe("/storm menu", () => {
	test("an approved team: the status panel and the menu, with rollback only when an earlier approval exists", async () => {
		await approve(TEAM);
		const f = scriptedUi([LAST]);
		expect(await hubFlow(env, f.ui)).toBe(false);
		expect(f.selects[0]?.options).toHaveLength(4);
		expect(f.selects[0]?.markdown).toContain(shortHash(configHash(TEAM)));

		await approve({ ...TEAM, parallelism: 2 });
		const g = scriptedUi([LAST]);
		await hubFlow(env, g.ui);
		expect(g.selects[0]?.options).toHaveLength(5);
		// The subagents table joins the menu while the session has subagents.
		const h = scriptedUi([THIRD]);
		await hubFlow({ ...env, agents: () => [agentEntry()] }, h.ui);
		expect(h.selects[0]?.options).toHaveLength(6);
		expect(h.reports).toHaveLength(1);
	});

	test("rollback from the menu puts the earlier approved team back", async () => {
		await approve(TEAM);
		await approve({ ...TEAM, parallelism: 2 });
		const f = scriptedUi([THIRD, FIRST, FIRST]);
		await hubFlow(env, f.ui);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config.parallelism).toBe(4);
		expect(isApproved(state)).toBe(true);
	});

	test("an earlier approval whose stored copy no longer matches its hash is not offered: it would restore what nobody approved", async () => {
		const hash = await approve(TEAM);
		await approve({ ...TEAM, parallelism: 2 });
		const store = (await load()).store;
		await writeFile(path.join(store.dir, "snapshots", `${hash.slice(hash.indexOf(":") + 1)}.json`), serializeConfig({ ...TEAM, parallelism: 7 }));
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		// The menu without the way back.
		expect(f.selects[0]?.options).toHaveLength(4);
	});

	test("a file changed while the rollback dialogs are open is not overwritten", async () => {
		await approve(TEAM);
		await approve({ ...TEAM, parallelism: 2 });
		const pulled = serializeConfig({ ...TEAM, parallelism: 9 });
		const f = scriptedUi([
			THIRD,
			FIRST,
			async options => {
				await editByHand(pulled);
				return options[0];
			},
		]);
		await hubFlow(env, f.ui);
		expect(await fileText()).toBe(pulled);
	});
});

describe("ended trials", () => {
	const trial: TrialConfig = {
		id: "reviewer-c-j-20261110T000000Z",
		role: "reviewer",
		model: "c/j",
		share: 0.5,
		maxSpawns: 10,
		startsAt: "2026-11-10T00:00:00.000Z",
		endsAt: "2026-11-17T00:00:00.000Z",
		budgetUsd: 5,
	};
	const withTrial: StormConfig = { ...TEAM, trials: [trial] };

	test("keeping the current model removes the trial and saves at once: one dialog, then the menu with the new config", async () => {
		await approve(withTrial);
		const f = scriptedUi([SECOND, LAST]);
		await hubFlow(env, f.ui);
		// Adopt, keep or later; then the menu, where the trial's config is now an earlier approval to go back to.
		expect(f.selects.map(s => s.options.length)).toEqual([3, 5]);
		expect(f.selects[0]?.options).not.toContain(APPROVE);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual(TEAM);
		expect(isApproved(state)).toBe(true);
		expect(f.selects[1]?.markdown).toContain(shortHash(configHash(TEAM)));
	});

	test("adopting the candidate goes through the approval dialog; cancelling there keeps everything", async () => {
		await approve(withTrial);
		const no = scriptedUi([FIRST, CANCEL, LAST]);
		await hubFlow(env, no.ui);
		expect(no.selects[1]?.options).toEqual([APPROVE, CANCEL]);
		expect((await load()).config).toMatchObject({ hash: configHash(withTrial) });

		const yes = scriptedUi([FIRST, APPROVE, LAST]);
		await hubFlow(env, yes.ui);
		expect(yes.selects[1]?.markdown).toContain("b/r → c/j:high, b/r");
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual({ ...TEAM, roles: { ...TEAM.roles, reviewer: { ...TEAM.roles.reviewer!, models: ["c/j:high", "b/r"] } } });
		expect(isApproved(state)).toBe(true);
	});

	test("keeping the current model does not overwrite a file changed while the dialog was open", async () => {
		await approve(withTrial);
		const pulled = serializeConfig({ ...withTrial, parallelism: 9 });
		const f = scriptedUi([
			async options => {
				await editByHand(pulled);
				return options[1];
			},
			LAST,
		]);
		await hubFlow(env, f.ui);
		expect(await fileText()).toBe(pulled);
		expect((await (await load()).store.list()).map(r => r.configHash)).toEqual([configHash(withTrial)]);
	});

	test("deciding later changes nothing and the menu follows", async () => {
		await approve(withTrial);
		const f = scriptedUi([THIRD, LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(2);
		expect((await load()).config).toMatchObject({ hash: configHash(withTrial) });
	});

	test("a running trial is not asked about, and /storm status never asks", async () => {
		await approve({ ...TEAM, trials: [{ ...trial, endsAt: "2026-11-30T00:00:00.000Z" }] });
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);

		await approve(withTrial);
		const s = scriptedUi();
		await statusFlow(env, s.ui);
		expect(s.selects).toEqual([]);
		expect(s.reports).toHaveLength(1);
		expect(s.reports[0]?.markdown).toContain("c/j");
	});
});
