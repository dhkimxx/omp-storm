import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { defaultFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { type HtmlForm, parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import { configHash, shortHash } from "../src/config/canonical.ts";
import { validateConfig } from "../src/config/schema.ts";
import { configPath, serializeConfig } from "../src/config/store.ts";
import { prepareAnalysis } from "../src/context.ts";
import { agentsFlow, approveAndSave, autoDelegationFlow, type FlowEnv, exportFlow, hubFlow, resetFlow, resumeFlow, setupFlow, statusFlow, statusText } from "../src/flows.ts";
import { initializeAutoDelegation, readAutoDelegationChoice, writeAutoDelegation } from "../src/approval/auto.ts";
import { ROLES, roleTitle } from "../src/roles.ts";
import { writeRun } from "../src/runtime/run.ts";
import { noteResumePointer, resumeCandidate, resumePointerFile } from "../src/runtime/resume.ts";
import { RUN_APPEARANCE, STORM_MARK } from "../src/view/appearance.ts";
import { parseModelEntry } from "../src/selector.ts";
import { BROWSE, FIELD, NONE } from "../src/setup/form.ts";
import { recommendedConfig } from "../src/view/setup.ts";
import { isApproved, loadProjectState } from "../src/state.ts";
import type { RunRequestResult } from "../src/tool/host.ts";
import type { FormData, RunRecord, RunSpec, StormConfig, TrialConfig, UiChoiceRow, UiPort } from "../src/types.ts";
import { APPROVE, CANCEL } from "../src/proposals/present.ts";
import { agentEntry, runRecord } from "./fixtures.ts";
import { type Answer, git, gitRepo, makeProject, model, pick, type ScriptedUi, scriptedUi, TEAM, type TestProject, withSession } from "./support.ts";
import { TEAM_08, TEAM_08_HASH, writeStore08 } from "./team-08.ts";

const NOW = Date.parse("2026-11-20T09:30:00Z");
/**
 * Answers by position. Only the approval dialog's two labels are a contract; every other dialog is pinned by how many
 * options it has and where each one leads.
 */
const FIRST = pick(0);
const SECOND = pick(1);
const THIRD = pick(2);
const FOURTH = pick(3);
const LAST = pick(-1);
const PICK_BY_ROLE = "역할별로 고르기";
const EDIT_MODELS = "모델·effort 수정";
const KEEP_EDITING = "계속 수정";
const PRIMARY = "주 모델";
const FALLBACK = "폴백";
/** The old toggle labels are still the explicit-switch contract; the first approval default is separate. */
const AUTO = { enable: "자동 위임 켜기", disable: "자동 위임 끄기" } as const;
/** The hub's action label; its state is the row's description, never part of the action. */
const AUTO_ROW = "자동 위임";
const AUTO_DISCLOSURE = "승인하면 이 세션의 자동 위임이 켜집니다";

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

/** A scripted UI that also answers through the hub's keyed rows and keeps each dialog's real rows. */
interface RowsUi extends ScriptedUi {
	rows: UiChoiceRow[][];
}

function rowsUi(answers: Answer[] = []): RowsUi {
	const f = scriptedUi(answers);
	const rows: UiChoiceRow[][] = [];
	const ui: UiPort = {
		...f.ui,
		async selectRows(title, offered, context) {
			rows.push([...offered]);
			const answer = await f.ui.select(title, offered.map(row => row.label), context);
			return offered.find(row => row.label === answer)?.value;
		},
	};
	return { ...f, ui, rows };
}

/** Storm's own recommendation for this project, carrying over `current`. */
async function recommended(current?: StormConfig): Promise<StormConfig> {
	const ctx = await prepareAnalysis(env, scriptedUi().ui);
	return recommendedConfig(ctx.recommend("balanced"), "balanced", current);
}

/** Answer each page by its fields or legend; unspecified answers keep the controls' defaults. */
function withForms(f: ScriptedUi, answer: (form: HtmlForm) => FormData | undefined = () => ({})): HtmlForm[] {
	const forms: HtmlForm[] = [];
	f.ui.form = async html => {
		const form = parseHtmlForm(html);
		forms.push(form);
		const over = answer(form);
		return over && { ...defaultFormData(form), ...over };
	};
	return forms;
}

const hasField = (form: HtmlForm, name: string) => form.fields.some(field => field.name === name);
const legend = (form: HtmlForm) => form.sections.map(section => spansText(section.title)).filter(Boolean).join(" ");

function choice(form: HtmlForm, name: string) {
	const field = form.fields.find(field => field.name === name);
	if (field?.kind !== "choice") throw new Error(`missing choice field: ${name}`);
	return field;
}

/** Identify a page without depending on the number of effort pages that came before it. */
function page(form: HtmlForm): string {
	if (hasField(form, FIELD.rounds)) return "settings";
	if (hasField(form, FIELD.effort)) {
		const title = legend(form);
		const model = CATALOG.find(row => title.includes(`${row.provider}/${row.id}`));
		const slot = title.includes(PRIMARY) ? PRIMARY : title.includes(FALLBACK) ? FALLBACK : undefined;
		if (model && slot) return `${slot} ${model.provider}/${model.id}`;
	}
	const roles = ROLES.filter(role => hasField(form, FIELD.primary(role.id)));
	if (roles.length === 1) return roles[0]!.id;
	throw new Error(`unrecognized interview page: ${legend(form)}`);
}

function defaultPages(team: StormConfig): string[] {
	return [...ROLES.flatMap(({ id }) => {
		const entries = team.roles[id]?.models.slice(0, 2) ?? [];
		return [id, ...entries.flatMap((entry, index) => {
			const { selector } = parseModelEntry(entry);
			const row = CATALOG.find(row => `${row.provider}/${row.id}` === selector);
			return row?.thinking.efforts.length ? [`${index === 0 ? PRIMARY : FALLBACK} ${selector}`] : [];
		})];
	}), "settings"];
}

const load = () => loadProjectState(env);
const approve = async (config: StormConfig) => approveAndSave(await load(), config, { shadowedAgents: [] });
/** The saved choice as the rest of Storm reads it, from this profile's store for this repository. */
const autoChoice = async () => readAutoDelegationChoice((await load()).sessionDir);
/** Seed a decided choice for tests about later flows; only an absent path can be initialized. */
const settleAuto = async (enabled: boolean): Promise<void> => {
	const state = await load();
	expect(await initializeAutoDelegation(state.sessionDir, enabled)).toBe(true);
};
/** A teammate's (or a hand) edit: the file changes, nobody approves it on this machine. */
const editByHand = async (text: string) => {
	await mkdir(path.dirname(configPath(project.sessionDir)), { recursive: true });
	await writeFile(configPath(project.sessionDir), text);
};
const fileText = () => readFile(configPath(project.sessionDir), "utf8");
async function expectEmptySetup(): Promise<void> {
	const state = await load();
	expect(state.config.status).toBe("missing");
	expect(await state.store.list()).toEqual([]);
}

describe("/storm without an approved team", () => {
	test("no config: the recommended team is offered at once, and cancelling saves nothing", async () => {
		const f = scriptedUi([CANCEL]);
		expect(await hubFlow(env, f.ui)).toBe(false);
		expect(f.selects).toHaveLength(1);
		expect(f.selects[0]?.options).toEqual([APPROVE, CANCEL]);
		const state = await load();
		expect(state.config.status).toBe("missing");
		expect(await state.store.list()).toEqual([]);
		expect(await autoChoice()).toBe("unset");
	});

	test("invalid config: every error in one dialog, and setup starts only when chosen", async () => {
		await editByHand(JSON.stringify({ ...TEAM, rounds: 99, isolation: "nope" }));
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		// Setup or nothing: an invalid file cannot be approved.
		expect(f.selects[0]?.options).toHaveLength(2);
		expect(f.selects[0]?.options).not.toContain(APPROVE);
		for (const field of ["rounds", "isolation"]) expect(f.selects[0]?.markdown).toContain(field);

		const g = scriptedUi([FIRST, APPROVE]);
		await hubFlow(env, g.ui);
		expect(g.selects[1]?.options).toEqual([APPROVE, CANCEL]);
		expect(g.selects).toHaveLength(2);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual(await recommended());
		expect(isApproved(state)).toBe(true);
		expect(await autoChoice()).toBe("on");
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
		const edited = { ...structuredClone(TEAM), rounds: 9, typo: 1 } as StormConfig;
		edited.roles.reviewer!.models = ["z/teammate"];
		await editByHand(serializeConfig(edited));
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		expect(f.selects[0]?.options).toHaveLength(4);
		expect(f.selects[0]?.options[0]).toBe(APPROVE);
		const md = f.selects[0]!.markdown!;
		// The diff against the last approved team, the unknown field with its value, and a warning per model not usable here.
		for (const part of ["b/r → z/teammate", "기본(3) → 9", "typo=1", "z/teammate: "]) expect(md).toContain(part);
		expect(isApproved(await load())).toBe(false);
		expect(f.selects).toHaveLength(1);
	});

	test("an approved snapshot that no longer validates is not diffed against: the whole team is shown", async () => {
		await approve(TEAM);
		await editByHand(serializeConfig({ ...TEAM, rounds: 9 }));
		const intact = scriptedUi([LAST]);
		await hubFlow(env, intact.ui);
		const state = await load();
		await writeFile(path.join(state.store.dir, "snapshots", `${configHash(TEAM).split(":")[1]}.json`), JSON.stringify({ ...TEAM, rounds: "many\n### forged" }));
		const damaged = scriptedUi([LAST]);
		await hubFlow(env, damaged.ui);
		// A diff has the one changed row; the whole team has a row per field, and nothing of the damaged file.
		const rows = (f: ScriptedUi) => f.selects[0]!.markdown!.split("\n").filter(line => line.startsWith("- ")).length;
		expect(rows(damaged)).toBeGreaterThan(rows(intact) + 3);
		expect(damaged.selects[0]?.markdown).not.toContain("forged");
		// Nothing to roll back to either.
		expect(damaged.selects[0]?.options).toHaveLength(intact.selects[0]!.options.length - 1);
	});

	test("approving an imported valid config approves the file as it is and is a first approval for auto", async () => {
		const text = `${JSON.stringify(TEAM, null, "\t")}\n\n`;
		await editByHand(text);
		const f = scriptedUi([APPROVE]);
		await hubFlow(env, f.ui);
		// No earlier approval: nothing to roll back to, and the first-approval disclosure opens the panel.
		expect(f.selects[0]?.options).toHaveLength(3);
		expect(f.selects[0]?.options[0]).toBe(APPROVE);
		expect(f.selects[0]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		expect(f.selects[0]?.markdown).toContain("/storm auto");
		expect(isApproved(await load())).toBe(true);
		expect(await autoChoice()).toBe("on");
		expect(await fileText()).toBe(text);
	});

	test("the approval is written before the file: when it cannot be, no unapproved config is left behind", async () => {
		const state = await load();
		// The approval store's parent is a file: nothing can be written below it.
		await mkdir(env.agentDir, { recursive: true });
		await writeFile(path.join(env.agentDir, "storm"), "");
		await expect(approveAndSave(state, TEAM, { shadowedAgents: [] })).rejects.toThrow();
		// The unusable store is refused as a whole (never redirected elsewhere), and no config was written.
		await expect(loadProjectState(env)).rejects.toThrow();
		await expect(readFile(configPath(state.sessionDir), "utf8")).rejects.toThrow();
	});

	test("a file changed while the approval dialog is open is not approved", async () => {
		await editByHand(serializeConfig(TEAM));
		const moved = { ...TEAM, rounds: 2 };
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
		expect(await autoChoice()).toBe("unset");
	});

	test("rolling back from an unapproved config needs no new approval", async () => {
		await approve(TEAM);
		await editByHand(serializeConfig({ ...TEAM, rounds: 9 }));
		const f = scriptedUi([SECOND, FIRST, FIRST]);
		await hubFlow(env, f.ui);
		const state = await load();
		expect(state.config.status === "ok" && state.config.hash).toBe(configHash(TEAM));
		expect(isApproved(state)).toBe(true);
		expect((await state.store.list()).map(r => r.configHash)).toEqual([configHash(TEAM)]);
	});

	test("old workspace and profile-scope Storm files are neither read nor imported, and stay byte-untouched", async () => {
		const oldStorm = path.join(project.root, ".omp", "storm");
		await mkdir(oldStorm, { recursive: true });
		const oldConfig = path.join(oldStorm, "config.json");
		await writeFile(oldConfig, TEAM_08);
		const before = await load();
		const oldApprovals = path.join(project.agentDir, "storm", "approvals", before.repo.repoId);
		await writeStore08(oldApprovals, before.repo.repoId);
		const oldRecord = path.join(oldApprovals, "approved", `${TEAM_08_HASH.slice("jcs-sha256:".length)}.json`);
		const oldBytes = await readFile(oldRecord, "utf8");

		// A fresh session sees no team: the old config and approval are not a fallback.
		expect(before.config.status).toBe("missing");
		expect(isApproved(before)).toBe(false);
		const f = scriptedUi([CANCEL]);
		await hubFlow(env, f.ui);
		const after = await load();
		expect(after.sessionDir).not.toBe(oldApprovals);
		expect(after.config.status).toBe("missing");
		expect(isApproved(after)).toBe(false);
		// Nothing was migrated, deleted or rewritten.
		expect(await readFile(oldConfig, "utf8")).toBe(TEAM_08);
		expect(await readFile(oldRecord, "utf8")).toBe(oldBytes);
	});
});

describe("model slot edit", () => {
	test("one approved-team slot changes alone, without opening a form", async () => {
		await approve(TEAM);
		const forms: string[] = [];
		const calls: Array<{ title: string; current?: { selector: string; effort?: string } }> = [];
		const f = scriptedUi([EDIT_MODELS, "구현 · 주 모델", APPROVE]);
		f.ui.form = async (html) => {
			forms.push(html);
			return undefined;
		};
		f.ui.pickModel = async (title, current) => {
			calls.push({ title, ...(current ? { current } : {}) });
			return { model: model("c/j"), effort: "high" };
		};
		await hubFlow(env, f.ui);
		expect(forms).toEqual([]);
		expect(calls).toEqual([{ title: "구현 · 주 모델", current: { selector: "a/i" } }]);
		expect(f.selects[0]?.options).toContain(EDIT_MODELS);
		expect(f.selects[1]?.options).toEqual(["탐색 · 주 모델", "탐색 · 폴백", "구현 · 주 모델", "리뷰 · 주 모델", CANCEL]);
		expect(f.selects[2]?.options).toEqual([APPROVE, KEEP_EDITING, CANCEL]);
		// The diff names only the changed slot; no other role or policy row appears.
		expect(f.selects[2]?.markdown).toContain("구현 모델");
		expect(f.selects[2]?.markdown).toContain("a/i → c/j:high");
		expect(f.selects[2]?.markdown).not.toContain("탐색 모델");
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual({
			...TEAM,
			roles: { ...TEAM.roles, implementer: { agent: "storm-implementer", models: ["c/j:high"], workers: { min: 1, max: 3 } } },
		});
		expect(isApproved(state)).toBe(true);
	});

	test("every configured fallback is a slot, numbered only when the role has several", async () => {
		const multi: StormConfig = {
			...TEAM,
			roles: {
				...TEAM.roles,
				explorer: { agent: "storm-explorer", models: ["a/x", "b/z", "c/k"], effort: "low" },
			},
		};
		await approve(multi);
		const f = scriptedUi([EDIT_MODELS, "탐색 · 폴백 2", APPROVE]);
		f.ui.pickModel = async (title, current) => {
			expect(title).toBe("탐색 · 폴백 2");
			expect(current).toEqual({ selector: "c/k", effort: "low" });
			return { model: model("d/m"), effort: "high" };
		};
		await hubFlow(env, f.ui);
		expect(f.selects[1]?.options).toEqual([
			"탐색 · 주 모델", "탐색 · 폴백 1", "탐색 · 폴백 2", "구현 · 주 모델", "리뷰 · 주 모델", CANCEL,
		]);
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		// The other fallbacks keep their order and the role-level effort; only the picked slot gets a suffix.
		expect(saved?.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/x", "b/z", "d/m:high"], effort: "low" });
	});

	test("reverting a staged slot to the approved value keeps the draft honest", async () => {
		await approve(TEAM);
		const f = scriptedUi([EDIT_MODELS, "구현 · 주 모델", KEEP_EDITING, "구현 · 주 모델", "리뷰 · 주 모델", APPROVE]);
		const picks = [model("c/j"), model("a/i"), model("d/k")];
		const titles: string[] = [];
		f.ui.pickModel = async (title) => {
			titles.push(title);
			return { model: picks.shift()! };
		};
		await hubFlow(env, f.ui);
		expect(titles).toEqual(["구현 · 주 모델", "구현 · 주 모델", "리뷰 · 주 모델"]);
		// The final proposal is the reverted implementer plus the reviewer edit, never the earlier c/j.
		expect(f.selects[5]?.markdown).not.toContain("c/j");
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(saved?.roles.implementer?.models).toEqual(["a/i"]);
		expect(saved?.roles.reviewer?.models).toEqual(["d/k"]);
	});

	test("the same model keeps its place and only the effort changes", async () => {
		await approve(TEAM);
		const f = scriptedUi([EDIT_MODELS, "구현 · 주 모델", APPROVE]);
		f.ui.pickModel = async () => ({ model: model("a/i"), effort: "high" });
		await hubFlow(env, f.ui);
		expect(f.selects[2]?.markdown).toContain("a/i → a/i:high");
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(saved?.roles.implementer?.models).toEqual(["a/i:high"]);
		expect(saved?.roles.explorer).toEqual(TEAM.roles.explorer!);
		expect(saved?.roles.reviewer).toEqual(TEAM.roles.reviewer!);
	});

	test("cancelling the picker returns to the slot list, and leaving either dialog writes nothing", async () => {
		await approve(TEAM);
		const before = await fileText();
		const beforeRecords = await (await load()).store.list();
		const cancelled = scriptedUi([EDIT_MODELS, "구현 · 주 모델", CANCEL]);
		cancelled.ui.pickModel = async () => undefined;
		await hubFlow(env, cancelled.ui);
		// Hub, slot list, and the slot list after the picker was cancelled; no approval was asked.
		expect(cancelled.selects).toHaveLength(3);
		expect(cancelled.selects[2]?.options).toEqual(cancelled.selects[1]?.options);
		expect(await fileText()).toBe(before);
		expect(await (await load()).store.list()).toHaveLength(beforeRecords.length);

		const review = scriptedUi([EDIT_MODELS, "구현 · 주 모델", CANCEL]);
		review.ui.pickModel = async () => ({ model: model("c/j") });
		await hubFlow(env, review.ui);
		expect(review.selects[2]?.options).toEqual([APPROVE, KEEP_EDITING, CANCEL]);
		expect(await fileText()).toBe(before);
		expect(await (await load()).store.list()).toHaveLength(beforeRecords.length);
	});

	test("continuing the review keeps the draft and allows another slot edit", async () => {
		await approve(TEAM);
		const f = scriptedUi([EDIT_MODELS, "구현 · 주 모델", KEEP_EDITING, "탐색 · 폴백", APPROVE]);
		const picks = [model("c/j"), model("d/k")];
		f.ui.pickModel = async () => ({ model: picks.shift()! });
		await hubFlow(env, f.ui);
		expect(f.selects.map((select) => select.options)).toEqual([
			expect.arrayContaining([EDIT_MODELS]),
			["탐색 · 주 모델", "탐색 · 폴백", "구현 · 주 모델", "리뷰 · 주 모델", CANCEL],
			[APPROVE, KEEP_EDITING, CANCEL],
			["탐색 · 주 모델", "탐색 · 폴백", "구현 · 주 모델", "리뷰 · 주 모델", CANCEL],
			[APPROVE, KEEP_EDITING, CANCEL],
		]);
		// The final diff carries both edits made through the same draft.
		expect(f.selects[4]?.markdown).toContain("c/j");
		expect(f.selects[4]?.markdown).toContain("d/k");
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(saved?.roles.implementer?.models).toEqual(["c/j"]);
		expect(saved?.roles.explorer?.models).toEqual(["a/x:low", "d/k"]);
		expect(saved?.roles.explorer?.effort).toBeUndefined();
	});

	test("a model already in another slot of the role is rejected with an explanation and no save", async () => {
		await approve(TEAM);
		const before = await fileText();
		const f = scriptedUi([EDIT_MODELS, "탐색 · 주 모델", CANCEL]);
		f.ui.pickModel = async () => ({ model: model("b/z") });
		await hubFlow(env, f.ui);
		// Back at the slot list after the rejection; no approval dialog.
		expect(f.selects).toHaveLength(3);
		expect(f.notices.some((notice) => notice.level === "warning" && notice.text.includes("이미"))).toBe(true);
		expect(await fileText()).toBe(before);
	});

	test("an unavailable or non-tool model and an unsupported effort are explained, not substituted", async () => {
		await approve(TEAM);
		const before = await fileText();
		for (const picked of [
			{ model: model("d/k", { available: false }) },
			{ model: model("d/k", { supportsTools: false }) },
			{ model: model("d/k", { efforts: ["low"] }), effort: "high" as const },
		]) {
			const f = scriptedUi([EDIT_MODELS, "구현 · 주 모델", CANCEL]);
			f.ui.pickModel = async () => picked;
			await hubFlow(env, f.ui);
			expect(f.notices.some((notice) => notice.level === "warning")).toBe(true);
			// The rejection keeps the slot list open and no approval dialog is offered.
			expect(f.selects).toHaveLength(3);
			expect(await fileText()).toBe(before);
		}
	});

	test("editing one slot preserves a legacy role-level effort for the untouched fallback", async () => {
		await approve(TEAM);
		const f = scriptedUi([EDIT_MODELS, "탐색 · 주 모델", APPROVE]);
		f.ui.pickModel = async () => ({ model: model("c/j"), effort: "high" });
		await hubFlow(env, f.ui);
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		// The explicit pick carries its own effort; the untouched fallback keeps inheriting the role-level effort.
		expect(saved?.roles.explorer).toEqual({ agent: "storm-explorer", models: ["c/j:high", "b/z"], effort: "low" });
		// The role that was not edited keeps its legacy setting byte-for-byte.
		expect(saved?.roles.reviewer).toEqual(TEAM.roles.reviewer!);
	});

	test("the first recommendation's direct edit keeps the disclosure and the ordinary final approval", async () => {
		const proposed = await recommended();
		const f = scriptedUi([EDIT_MODELS, "구현 · 주 모델", APPROVE]);
		f.ui.pickModel = async () => ({ model: model("pz/native", { efforts: ["minimal"] }), effort: "minimal" });
		await setupFlow(env, f.ui);
		expect(f.selects[0]?.options).toEqual([APPROVE, EDIT_MODELS, CANCEL]);
		expect(f.selects[2]?.options).toEqual([APPROVE, KEEP_EDITING, CANCEL]);
		expect(f.selects[2]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(saved?.roles.implementer?.models[0]).toBe("pz/native:minimal");
		expect(saved?.roles.implementer?.models.slice(1)).toEqual(proposed.roles.implementer?.models.slice(1));
		expect(isApproved(state)).toBe(true);
		expect(await autoChoice()).toBe("on");
	});

	test("an unchanged recommendation still exposes the direct edit", async () => {
		const team = await recommended();
		await approve(team);
		const f = scriptedUi([EDIT_MODELS, "구현 · 주 모델", APPROVE]);
		f.ui.pickModel = async () => ({ model: model("pz/native") });
		await setupFlow(env, f.ui);
		expect(f.selects[0]?.options).toEqual([EDIT_MODELS, "닫기"]);
		expect(f.selects[2]?.options).toEqual([APPROVE, KEEP_EDITING, CANCEL]);
		expect(f.selects[2]?.markdown).not.toContain(AUTO_DISCLOSURE);
		const state = await load();
		const saved = state.config.status === "ok" ? state.config.config : undefined;
		expect(saved?.roles.implementer?.models[0]).toBe("pz/native");
		expect(saved?.roles.explorer).toEqual(team.roles.explorer!);
		expect(await autoChoice()).toBe("unset");
	});

	test("without a native picker neither the hub nor the recommendation offers the edit", async () => {
		await approve(TEAM);
		const hub = scriptedUi(["닫기"]);
		await hubFlow(env, hub.ui);
		expect(hub.selects[0]?.options).not.toContain(EDIT_MODELS);

		const setup = scriptedUi([CANCEL]);
		await setupFlow(env, setup.ui);
		expect(setup.selects.every((select) => !select.options.includes(EDIT_MODELS))).toBe(true);
	});
});

describe("setup", () => {
	test("first setup, approved: the recommended team is saved and automatic delegation is on by default", async () => {
		const expected = await recommended();
		expect(validateConfig(expected).errors).toEqual([]);
		const f = scriptedUi([APPROVE]);
		await setupFlow(env, f.ui);
		// No separate consent screen: one approval dialog, with the disclosure before the ordinary content.
		expect(f.selects).toHaveLength(1);
		for (const role of Object.values(expected.roles)) expect(f.selects[0]?.markdown).toContain(role.models.join(", "));
		expect(f.selects[0]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		// One brand heading, after the first-approval disclosure, replaces the summary row rather than pushing it down.
		expect(f.selects[0]?.markdown?.split(STORM_MARK)).toHaveLength(2);
		expect(f.selects[0]!.markdown!.indexOf(STORM_MARK)).toBeGreaterThan(f.selects[0]!.markdown!.indexOf(AUTO_DISCLOSURE));
		for (const part of ["이 OMP 세션에만", "프로젝트 도구를 직접 쓰지 않", "작은 수정도", "일반 대화", "/storm auto"]) {
			expect(f.selects[0]?.markdown).toContain(part);
		}
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual(expected);
		expect(isApproved(state)).toBe(true);
		expect(await autoChoice()).toBe("on");
		expect(f.reports).toEqual([]);
	});

	test("an unanswered dialog saves nothing", async () => {
		await setupFlow(env, scriptedUi([undefined]).ui);
		expect((await load()).config.status).toBe("missing");
		expect(await autoChoice()).toBe("unset");
	});

	test("picking role by role is offered only where forms can be drawn", async () => {
		const without = scriptedUi([CANCEL]);
		await setupFlow(env, without.ui);
		expect(without.selects[0]?.options).toEqual([APPROVE, CANCEL]);
		expect(without.selects[0]?.markdown).toContain("/storm <");

		const withForm = scriptedUi([CANCEL]);
		const forms = withForms(withForm);
		await setupFlow(env, withForm.ui);
		expect(withForm.selects[0]?.options).toHaveLength(3);
		expect([withForm.selects[0]?.options.at(0), withForm.selects[0]?.options.at(-1)]).toEqual([APPROVE, CANCEL]);
		expect(withForm.selects[0]?.markdown).not.toContain("/storm <");
		expect(forms).toEqual([]);
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
		// An approval already existed, so this is not a first approval: no disclosure and no choice.
		expect(f.selects.some(s => s.markdown?.includes(AUTO_DISCLOSURE))).toBe(false);
		expect(await autoChoice()).toBe("unset");
	});

	test("a first setup opens on what approval switches on beyond the models; a team that already has it is not told again", async () => {
		const first = scriptedUi([CANCEL]);
		await setupFlow(env, first.ui);
		const markdown = first.selects[0]!.markdown!;
		expect(markdown.startsWith(AUTO_DISCLOSURE)).toBe(true);
		const lead = markdown.split("\n").find(line => line.includes("실행이 끝나면 정리"))!;
		expect(lead).toBeDefined();
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

		const f = scriptedUi([PICK_BY_ROLE, APPROVE]);
		const forms = withForms(f, form => hasField(form, FIELD.rounds) ? { [FIELD.rounds]: 7 } : {});
		await setupFlow(env, f.ui);
		expect(forms.map(page)).toEqual(defaultPages(team));
		expect(f.selects[0]?.options).not.toContain(APPROVE);
		expect(f.selects[1]?.options).toEqual([APPROVE, CANCEL]);
		expect(f.selects[1]?.markdown).not.toContain(AUTO_DISCLOSURE);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual({ ...team, rounds: 7 });
		expect(await autoChoice()).toBe("unset");
	});

	test("picking role by role groups the controls and then asks about settings and approval", async () => {
		const base = await recommended();
		const f = scriptedUi([PICK_BY_ROLE, APPROVE]);
		const forms = withForms(f, form => {
			if (hasField(form, FIELD.primary("reviewer"))) return { [FIELD.primary("reviewer")]: NONE };
			if (hasField(form, FIELD.fallback("implementer"))) return { [FIELD.fallback("implementer")]: NONE };
			if (hasField(form, FIELD.rounds)) return { [FIELD.budget]: 3, [FIELD.cleanup]: "off" };
			return {};
		});
		await setupFlow(env, f.ui);
		const picked = structuredClone(base);
		picked.roles.implementer!.models.length = 1;
		delete picked.roles.reviewer;
		expect(forms.map(page)).toEqual(defaultPages(picked));
		for (const { id } of ROLES) {
			const role = forms.find(form => hasField(form, FIELD.primary(id)))!;
			expect(role.fields.map(field => field.name).sort()).toEqual(
				[FIELD.primary(id), FIELD.fallback(id), FIELD.workersMin(id), FIELD.workersMax(id)].sort(),
			);
			for (const name of [FIELD.primary(id), FIELD.fallback(id)]) {
				expect(choice(role, name).options.some(option => option.value === BROWSE)).toBe(false);
			}
		}
		expect(f.selects.map(s => s.options)).toEqual([[APPROVE, PICK_BY_ROLE, CANCEL], [APPROVE, CANCEL]]);
		expect(f.selects[1]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		// The role-by-role first approval turns automatic delegation on after the team is saved.
		expect(await autoChoice()).toBe("on");
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

	test("a native pick supplies model and effort together, with no second effort page", async () => {
		const primary = model("pd/outside-primary", { efforts: ["minimal", "low"], contextWindow: 64_000 });
		const fallback = model("pe/outside-fallback", { efforts: ["high", "xhigh"], contextWindow: 64_000 });
		const catalog = [...CATALOG, ...[primary, fallback].map(m => ({
			...row(m.provider, m.id, 1, 50, m.efforts),
			contextWindow: m.contextWindow,
		}))];
		const withOutsideModels = { ...env, registry: { getAll: () => catalog, getAvailable: () => catalog } };
		const f = scriptedUi([PICK_BY_ROLE, async () => {
			await expectEmptySetup();
			return APPROVE;
		}]);
		const roleId = "explorer";
		const title = roleTitle(roleId);
		const steps: string[] = [];
		f.ui.pickModel = async (slotTitle, current) => {
			steps.push(`picker ${slotTitle}`);
			expect(current).toBeUndefined();
			return slotTitle.endsWith(FALLBACK) ? { model: fallback, effort: "xhigh" } : { model: primary, effort: "minimal" };
		};
		withForms(f, form => {
			if (hasField(form, FIELD.primary(roleId))) {
				steps.push(roleId);
				for (const name of [FIELD.primary(roleId), FIELD.fallback(roleId)]) {
					const options = choice(form, name).options;
					expect(options.some(option => option.value === BROWSE && spansText(option.label) === "OMP에서 다른 모델 선택")).toBe(true);
					expect(options.map(option => option.value)).not.toContain(primary.selector);
					expect(options.map(option => option.value)).not.toContain(fallback.selector);
				}
				return {
					[FIELD.primary(roleId)]: BROWSE,
					[FIELD.fallback(roleId)]: BROWSE,
					[FIELD.workersMin(roleId)]: 2,
					[FIELD.workersMax(roleId)]: 3,
				};
			}
			steps.push(page(form));
			return {};
		});
		await setupFlow(withOutsideModels, f.ui);
		const expected = defaultPages(await recommended());
		const nextRole = expected.indexOf("implementer");
		expect(steps).toEqual([
			roleId,
			`picker ${title} · ${PRIMARY}`,
			`picker ${title} · ${FALLBACK}`,
			...expected.slice(nextRole),
		]);
		expect(f.selects.map(s => s.options)).toEqual([[APPROVE, EDIT_MODELS, PICK_BY_ROLE, CANCEL], [APPROVE, CANCEL]]);
		expect(f.selects[1]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config.roles[roleId]).toMatchObject({
			models: [`${primary.selector}:minimal`, `${fallback.selector}:xhigh`],
			workers: { min: 2, max: 3 },
		});
		expect(isApproved(state)).toBe(true);
	});

	test("Esc from the model picker returns to the same role without saving anything", async () => {
		const f = scriptedUi([PICK_BY_ROLE]);
		let picks = 0;
		f.ui.pickModel = async () => {
			picks++;
			await expectEmptySetup();
			return undefined;
		};
		const basePages = defaultPages(await recommended());
		let visits = 0;
		const forms = withForms(f, form => {
			if (!hasField(form, FIELD.primary("implementer"))) return {};
			if (++visits > 1) return undefined;
			return { [FIELD.primary("implementer")]: BROWSE };
		});
		await setupFlow(env, f.ui);
		expect(forms.map(page)).toEqual([...basePages.slice(0, basePages.indexOf("implementer")), "implementer", "implementer"]);
		expect(picks).toBe(1);
		expect(f.selects).toHaveLength(1);
		await expectEmptySetup();
	});

	test("only invalid settings reopen with the errors; cancelling a page or approval saves nothing", async () => {
		const f = scriptedUi([PICK_BY_ROLE, CANCEL]);
		let attempts = 0;
		const forms = withForms(f, form => hasField(form, FIELD.rounds) ? { [FIELD.rounds]: ++attempts === 1 ? 99 : 3 } : {});
		await setupFlow(env, f.ui);
		const expected = defaultPages(await recommended());
		expect(forms.map(page)).toEqual([...expected, "settings"]);
		const reopened = forms.at(-1)!;
		expect(reopened.sections.some(s => s.blocks.some(b => b.kind === "list"))).toBe(true);
		expect(defaultFormData(reopened)[FIELD.rounds]).toBe(99);
		expect(f.selects.at(-1)?.options).toEqual([APPROVE, CANCEL]);
		await expectEmptySetup();

		for (const toCancel of ["explorer", expected.find(p => p.startsWith(PRIMARY) || p.startsWith(FALLBACK))!, "settings"]) {
			const g = scriptedUi([PICK_BY_ROLE]);
			const pages = withForms(g, form => page(form) === toCancel ? undefined : {});
			await setupFlow(env, g.ui);
			expect(pages.map(page)).toEqual(expected.slice(0, expected.indexOf(toCancel) + 1));
			expect(g.selects).toHaveLength(1);
			await expectEmptySetup();
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

describe("automatic delegation", () => {
	test("a first approval initializes it only after the team is saved, with the disclosure first", async () => {
		const f = scriptedUi([APPROVE]);
		await setupFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		expect(f.selects[0]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		// The ordinary approval notice comes before the activation notice, which is the proof of the order.
		expect(f.notices.map(n => n.text)).toEqual([
			expect.stringContaining("팀 설정을 승인하고 저장했습니다"),
			expect.stringContaining("자동 위임을 켰습니다"),
		]);
		expect(await autoChoice()).toBe("on");
		expect(isApproved(await load())).toBe(true);
	});

	test("cancelled or unanswered approvals save nothing and leave the choice unset", async () => {
		for (const answer of [CANCEL, undefined]) {
			const f = scriptedUi([answer]);
			await setupFlow(env, f.ui);
			expect(await autoChoice()).toBe("unset");
			expect((await load()).config.status).toBe("missing");
		}
		// An imported valid config: cancelling its approval is not an approval either.
		await editByHand(serializeConfig(TEAM));
		const g = scriptedUi([CANCEL]);
		await hubFlow(env, g.ui);
		expect(g.selects[0]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		expect(await autoChoice()).toBe("unset");
		expect(isApproved(await load())).toBe(false);
	});

	test("the role interview's final approval is a first approval", async () => {
		const f = scriptedUi([PICK_BY_ROLE, APPROVE]);
		const forms = withForms(f);
		await setupFlow(env, f.ui);
		expect(forms.length).toBeGreaterThan(1);
		expect(f.selects.map(s => s.options)).toEqual([[APPROVE, PICK_BY_ROLE, CANCEL], [APPROVE, CANCEL]]);
		expect(f.selects[1]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		expect(await autoChoice()).toBe("on");
	});

	test("no recommended team can be built, so the fresh interview's final approval still defaults on", async () => {
		// No candidate clears the roles' context floor, so there is no recommended team to approve: only the interview.
		const small = { ...row("pz", "tiny", 0.1, 30), contextWindow: 64_000 };
		const tiny = { ...env, registry: { getAll: () => [small], getAvailable: () => [small] } };
		const g = scriptedUi([PICK_BY_ROLE, APPROVE]);
		withForms(g);
		g.ui.pickModel = async () => ({ model: model("pz/tiny", { contextWindow: 64_000 }) });
		await setupFlow(tiny, g.ui);
		expect(g.selects[0]?.options).toEqual([PICK_BY_ROLE, CANCEL]);
		expect(g.selects[1]?.options).toEqual([APPROVE, CANCEL]);
		expect(g.selects[1]?.markdown?.startsWith(AUTO_DISCLOSURE)).toBe(true);
		expect(await autoChoice()).toBe("on");
		expect(isApproved(await load())).toBe(true);
	});

	test("an activation write failure keeps the approved team and says auto is not confirmed", async () => {
		const state = await load();
		const base = scriptedUi([APPROVE]);
		let denied = false;
		const ui: typeof base.ui = {
			...base.ui,
			notify(message, level) {
				base.ui.notify(message, level);
				if (!denied && message.includes("승인하고 저장했습니다")) {
					denied = true;
					chmodSync(state.sessionDir, 0o500);
				}
			},
		};
		try {
			await setupFlow(env, ui);
		} finally {
			chmodSync(state.sessionDir, 0o700);
		}
		expect(denied).toBe(true);
		expect(isApproved(await load())).toBe(true);
		expect(await autoChoice()).toBe("unset");
		expect(base.notices.at(-1)?.level).toBe("warning");
		expect(base.notices.at(-1)?.text).toContain("팀 설정은 저장했지만");
		expect(base.notices.at(-1)?.text).toContain("자동 위임");
	});

	test("an explicit off survives re-setup, reapproval and a deleted config", async () => {
		await setupFlow(env, scriptedUi([APPROVE]).ui);
		expect(await autoChoice()).toBe("on");
		await autoDelegationFlow(env, scriptedUi([AUTO.disable]).ui);
		expect(await autoChoice()).toBe("off");

		const again = scriptedUi([APPROVE]);
		await setupFlow(env, again.ui);
		expect(again.selects.some(s => s.markdown?.includes(AUTO_DISCLOSURE))).toBe(false);
		expect(await autoChoice()).toBe("off");

		await editByHand(serializeConfig({ ...TEAM, rounds: 9 }));
		const reapproved = scriptedUi([APPROVE]);
		await hubFlow(env, reapproved.ui);
		expect(reapproved.selects.some(s => s.markdown?.includes(AUTO_DISCLOSURE))).toBe(false);
		expect(await autoChoice()).toBe("off");

		await rm(configPath(project.sessionDir), { force: true });
		const recreated = scriptedUi([APPROVE]);
		await setupFlow(env, recreated.ui);
		expect(recreated.selects.some(s => s.markdown?.includes(AUTO_DISCLOSURE))).toBe(false);
		expect(await autoChoice()).toBe("off");
		expect(isApproved(await load())).toBe(true);
	});

	test("an on choice survives re-setup, reapproval and a deleted config", async () => {
		await setupFlow(env, scriptedUi([APPROVE]).ui);
		expect(await autoChoice()).toBe("on");
		const again = scriptedUi([APPROVE]);
		await setupFlow(env, again.ui);
		expect(again.selects.some(s => s.markdown?.includes(AUTO_DISCLOSURE))).toBe(false);
		expect(await autoChoice()).toBe("on");

		await editByHand(serializeConfig({ ...TEAM, rounds: 9 }));
		const reapproved = scriptedUi([APPROVE]);
		await hubFlow(env, reapproved.ui);
		expect(reapproved.selects.some(s => s.markdown?.includes(AUTO_DISCLOSURE))).toBe(false);
		expect(await autoChoice()).toBe("on");

		await rm(configPath(project.sessionDir), { force: true });
		const recreated = scriptedUi([APPROVE]);
		await setupFlow(env, recreated.ui);
		expect(recreated.selects.some(s => s.markdown?.includes(AUTO_DISCLOSURE))).toBe(false);
		expect(await autoChoice()).toBe("on");
		expect(isApproved(await load())).toBe(true);
	});

	test("a team approved outside setup has no saved auto choice; the hub offers the ordinary switch, not a migration", async () => {
		await approve(TEAM);
		const f = rowsUi(["닫기"]);
		await hubFlow(env, f.ui);
		expect(await autoChoice()).toBe("unset");
		const options = f.selects[0]!.options;
		expect(options).toEqual(expect.arrayContaining(["팀 다시 설정", "모델 점검", AUTO_ROW, "닫기"]));
		expect(options).not.toContain("자동 위임으로 전환");
		expect(f.rows[0]?.find(row => row.label === AUTO_ROW)?.description).toBe("꺼짐");
		expect(f.selects[0]?.markdown).not.toContain("결정하면 다시 묻지 않습니다");
		// The status still says off; an absent choice is never turned into a yes by reading it.
		const status = scriptedUi();
		await statusFlow(env, status.ui);
		expect(status.selects).toEqual([]);
		expect(status.reports[0]?.markdown).toContain("자동 위임: 꺼짐");
		expect(await autoChoice()).toBe("unset");
	});

	test("an invalid saved auto file is untouched by setup; explicit /storm auto repairs it", async () => {
		const state = await load();
		await mkdir(state.sessionDir, { recursive: true });
		const file = path.join(state.sessionDir, "auto-delegation.json");
		const invalid = "{ not json";
		await writeFile(file, invalid);

		const setup = scriptedUi([APPROVE]);
		await setupFlow(env, setup.ui);
		expect(setup.selects[0]?.markdown).not.toContain(AUTO_DISCLOSURE);
		expect(await readFile(file, "utf8")).toBe(invalid);
		expect(await autoChoice()).toBe("invalid");

		const hub = scriptedUi(["닫기"]);
		await hubFlow(env, hub.ui);
		expect(await readFile(file, "utf8")).toBe(invalid);

		const repair = scriptedUi([AUTO.enable]);
		await autoDelegationFlow(env, repair.ui);
		expect(await autoChoice()).toBe("on");
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ enabled: true });
	});

	test("the old toggle labels still work and enable rechecks an approved team", async () => {
		await approve(TEAM);
		const f = scriptedUi([AUTO.enable]);
		await autoDelegationFlow(env, f.ui);
		expect(f.selects[0]?.options).toEqual([AUTO.enable, CANCEL]);
		expect(await autoChoice()).toBe("on");
		// The team approval is unchanged: the choice is a separate record, not a new config approval.
		expect((await load()).approval?.configHash).toBe(configHash(TEAM));

		const off = scriptedUi([AUTO.disable]);
		await autoDelegationFlow(env, off.ui);
		expect(off.selects[0]?.options).toEqual([AUTO.disable, CANCEL]);
		expect(await autoChoice()).toBe("off");

		await rm(path.join((await load()).sessionDir, "auto-delegation.json"), { force: true });
		const stale = scriptedUi([async () => {
			await editByHand(serializeConfig({ ...TEAM, rounds: 9 }));
			return AUTO.enable;
		}]);
		await autoDelegationFlow(env, stale.ui);
		expect(await autoChoice()).toBe("unset");
		expect(stale.notices.at(-1)?.level).toBe("warning");
		expect(stale.notices.at(-1)?.text).toContain("바뀌어");
	});

	test("a stale team cannot enable it, but an existing on choice can always be turned off", async () => {
		await approve(TEAM);
		await editByHand(serializeConfig({ ...TEAM, rounds: 9 }));
		const no = scriptedUi();
		await autoDelegationFlow(env, no.ui);
		expect(no.selects).toEqual([]);
		expect(no.reports).toHaveLength(1);
		expect(no.notices.at(-1)?.level).toBe("warning");
		expect(await autoChoice()).toBe("unset");

		for (const stale of [serializeConfig({ ...TEAM, rounds: 9 }), "{ not json"]) {
			await approve(TEAM);
			await autoDelegationFlow(env, scriptedUi([AUTO.enable]).ui);
			expect(await autoChoice()).toBe("on");
			await editByHand(stale);
			const off = scriptedUi([AUTO.disable]);
			await autoDelegationFlow(env, off.ui);
			expect(off.selects[0]?.options).toEqual([AUTO.disable, CANCEL]);
			expect(await autoChoice()).toBe("off");
		}
	});

	test("the hub entry carries the state on its row and opens the same consent", async () => {
		await approve(TEAM);
		await settleAuto(false);
		const f = rowsUi([THIRD, AUTO.enable]);
		await hubFlow(env, f.ui);
		expect(f.selects[0]?.options).toContain(AUTO_ROW);
		expect(f.rows[0]?.find(row => row.label === AUTO_ROW)?.description).toBe("꺼짐");
		expect(f.selects[1]?.options).toEqual([AUTO.enable, CANCEL]);
		expect(await autoChoice()).toBe("on");

		const g = rowsUi([THIRD, AUTO.disable]);
		await hubFlow(env, g.ui);
		expect(g.selects[0]?.options).toContain(AUTO_ROW);
		expect(g.rows[0]?.find(row => row.label === AUTO_ROW)?.description).toBe("켜짐");
		expect(g.selects[1]?.options).toEqual([AUTO.disable, CANCEL]);
		expect(await autoChoice()).toBe("off");
	});

	test("the same session keeps its team across a worktree switch but needs a new target approval; auto stays session-owned", async () => {
		await gitRepo(project.root);
		const other = path.join(project.tmp, "other-worktree");
		await git(project.root, "worktree", "add", "-b", "other", other);
		const otherEnv: FlowEnv = { ...env, cwd: other };
		await approve(TEAM);
		const f = scriptedUi([AUTO.enable]);
		await autoDelegationFlow(env, f.ui);
		const [before, otherState] = await Promise.all([load(), loadProjectState(otherEnv)]);
		// One native session: the team and the consent belong to it, wherever it works.
		expect(otherState.sessionDir).toBe(before.sessionDir);
		expect(otherState.config.status).toBe("ok");
		expect(await readAutoDelegationChoice(otherState.sessionDir)).toBe("on");
		// But the approval is bound to the target: the switch needs an explicit approval of the same team.
		expect(otherState.store.dir).not.toBe(before.store.dir);
		expect(isApproved(otherState)).toBe(false);
		expect(isApproved(before)).toBe(true);
		const approveHere = scriptedUi([APPROVE]);
		await hubFlow(otherEnv, approveHere.ui);
		expect(isApproved(await loadProjectState(otherEnv))).toBe(true);
		// The old target's approval was not revoked or inherited by the new one.
		expect(isApproved(await load())).toBe(true);
		const off = scriptedUi([AUTO.disable]);
		await autoDelegationFlow(otherEnv, off.ui);
		expect(await autoChoice()).toBe("off");
	});

	test("another native session in the same profile and worktree starts with no team, approval or consent", async () => {
		await approve(TEAM);
		const sibling = await loadProjectState(withSession(project, "session-sibling"));
		expect(sibling.sessionDir).not.toBe((await load()).sessionDir);
		expect(sibling.config.status).toBe("missing");
		expect(isApproved(sibling)).toBe(false);
		expect(await readAutoDelegationChoice(sibling.sessionDir)).toBe("unset");
	});
});

describe("status and agents", () => {
	const agent = agentEntry({ id: "agent-one", model: "a/i", startedAt: NOW - 600_000, lastActivityAt: NOW - 60_000, costUsd: 0.1 });

	/** A status with something to advise on everywhere: a shadowing definition, missing omp fallback chains, a newer install. */
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
					return { modelRoles: {}, fallbackChains: {} };
				},
				newerVersion: () => "99.0.0",
			},
		};
	}
	const sections = (md: string) => md.split("\n").filter(line => line.startsWith("### ")).length;

	test("the user's status is what /storm status shows: every section, the commands that fix things, and the one target it covers", async () => {
		const busy = await busyEnv();
		const text = await statusText(busy.env, { quota: true });
		expect(text).toContain(shortHash(configHash(TEAM)));
		expect(text).toContain("### 적용 범위");
		expect(text).toContain(project.root);
		expect(text).not.toContain((await load()).repo.repoId);
		for (const part of ["omp config set retry.fallbackChains", "99.0.0", "--max-cost", path.join(".omp", "agents", "shadow-file.md")]) expect(text).toContain(part);
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

	test("the user's storage inventory scans the named project session dir and the model receives none of it", async () => {
		await approve(TEAM);
		const projectDir = path.join(env.agentDir, "sessions", "proj");
		const artifactsDir = path.join(projectDir, "sess");
		await mkdir(artifactsDir, { recursive: true });
		await writeFile(`${artifactsDir}.jsonl`, "parent");
		await writeFile(path.join(artifactsDir, "Legacy.jsonl"), "legacy");
		const scoped: FlowEnv = { ...env, ompSessionDir: projectDir };
		const full = await statusText(scoped, { quota: true });
		expect(full).toContain("소유 미상");
		expect(full).toContain("자동 삭제하지 않음");
		expect(full).not.toContain(projectDir);
		// No storage section enters the model's context.
		const model = await statusText(scoped, { quota: false });
		expect(model).not.toContain("저장 공간");
		expect(model).not.toContain("소유 미상");
	});

	test("the user status puts the active run's state and details before the team, and claims no phase that was not given", async () => {
		const run = runRecord({
			status: "running",
			turns: 1,
			maxRounds: 4,
			costUsd: 1.25,
			budget: { perRunUsd: 5, onExceed: "stop" },
			agents: [agentEntry({ state: "running", review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] } })],
		});
		const text = await statusText({ ...env, activeRun: () => run }, { quota: true });
		const lines = text.split("\n");
		expect(lines[0]).toStartWith(STORM_MARK);
		expect(lines[0]).toContain("실행 중");
		expect(text.split(STORM_MARK)).toHaveLength(2);
		expect(text.indexOf("### 실행 중")).toBeLessThan(text.indexOf("### 팀 설정"));
		expect(text).toContain("2/4라운드");
		expect(text).toContain("지출 $1.2500 / 예산 $5");
		expect(text).toContain("리뷰 1회");
		// Without the controller's live phase no phase name is invented.
		expect(text).not.toContain(RUN_APPEARANCE.verifying.label);
		expect(text).not.toContain(RUN_APPEARANCE.workers.label);

		const phased = await statusText({ ...env, activeRun: () => run, activePhase: () => "verifying" }, { quota: true });
		expect(phased.split("\n")[0]).toContain(RUN_APPEARANCE.verifying.label);

		// A planned review lane is not evidence of a review, and a plan never becomes a check result.
		const planned = {
			...run,
			agents: [],
			plan: { lanes: [{ name: "review", kind: "review" as const, role: "reviewer" }], workers: { reviewer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" },
		};
		const unproven = await statusText({ ...env, activeRun: () => planned }, { quota: true });
		expect(unproven).not.toContain("- 리뷰: 없음");
		expect(unproven).not.toContain("리뷰 1회");
		expect(unproven).not.toContain("검사 결과");
	});

	test("a current OMP mode explains why an approved team's automatic delegation is blocked", async () => {
		await approve(TEAM);
		await writeAutoDelegation((await load()).sessionDir, true);
		const reason = "omp 계획 모드가 켜져 있습니다. 계획 모드를 끝낸 뒤 다시 요청하세요.";
		const blocked = { ...env, autoModeProblem: () => reason };
		const full = await statusText(blocked, { quota: true });
		expect(full.split("\n").slice(0, 2)).toEqual([
			expect.stringContaining("자동 위임 막힘"),
			`- 다음: ${reason}`,
		]);
		expect(full).toContain("켜짐 · 실행 차단");
		const model = await statusText(blocked, { quota: false });
		expect(model).not.toContain(reason);
		const hub = rowsUi(["닫기"]);
		await hubFlow(blocked, hub.ui);
		expect(hub.selects[0]?.markdown).toContain(`- 다음: ${reason}`);
		expect(hub.rows[0]?.find(row => row.label === AUTO_ROW)?.description).toBe("켜짐 · 실행 차단");
	});

	test("an idle status puts the present state and its real next action before the team sections", async () => {
		const text = await statusText(env, { quota: true });
		const lines = text.split("\n");
		expect(lines[0]).toStartWith(STORM_MARK);
		expect(lines[0]).toContain("설정 없음");
		expect(text.split(STORM_MARK)).toHaveLength(2);
		expect(lines[1]).toBe("- 다음: `/storm`에서 팀 설정");
		expect(text.indexOf("- 다음:")).toBeLessThan(text.indexOf("### 팀 설정"));
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
		await settleAuto(false);
		const f = rowsUi([LAST]);
		expect(await hubFlow(env, f.ui)).toBe(false);
		expect(f.selects[0]?.options).toHaveLength(6);
		expect(f.selects[0]?.markdown).toContain(shortHash(configHash(TEAM)));
		expect(f.rows[0]?.find(row => row.label === AUTO_ROW)?.description).toBe("꺼짐");
		expect(f.rows[0]?.find(row => row.label === "전체 현황")?.description).toBe("/storm status");
		// Storage belongs to /storm status, not this panel: the hub neither shows nor scans it.
		expect(f.selects[0]?.markdown).not.toContain("저장:");
		expect(f.selects[0]?.markdown).not.toContain("b/r");
		// No resume pointer: the hub does not claim a resumable run.
		expect(f.selects[0]?.markdown?.split("\n")[0]).toStartWith(STORM_MARK);
		expect(f.selects[0]?.markdown).not.toContain("이어가기 가능");

		await approve({ ...TEAM, rounds: 2 });
		const g = scriptedUi([LAST]);
		await hubFlow(env, g.ui);
		expect(g.selects[0]?.options).toHaveLength(7);
		// The subagents table joins the menu while the session has subagents.
		const h = scriptedUi([THIRD]);
		await hubFlow({ ...env, agents: () => [agentEntry()] }, h.ui);
		expect(h.selects[0]?.options).toHaveLength(8);
		expect(h.reports).toHaveLength(1);
	});

	test("전체 현황 opens the full read-only status without deciding automatic delegation", async () => {
		await approve(TEAM);
		const f = rowsUi(["전체 현황"]);
		await hubFlow(env, f.ui);
		expect(f.selects).toHaveLength(1);
		expect(f.rows[0]?.find(row => row.label === "전체 현황")?.description).toBe("/storm status");
		expect(f.reports).toHaveLength(1);
		expect(f.reports[0]?.markdown).toContain("### 역할별 모델");
		expect(f.reports[0]?.markdown).toContain("### 저장 공간");
		expect(await autoChoice()).toBe("unset");
	});

	test("rollback from the menu puts the earlier approved team back", async () => {
		await approve(TEAM);
		await settleAuto(false);
		await approve({ ...TEAM, rounds: 2 });
		const f = scriptedUi([FOURTH, FIRST, FIRST]);
		await hubFlow(env, f.ui);
		const state = await load();
		expect(state.config.status === "ok" && state.config.config).toEqual(TEAM);
		expect(isApproved(state)).toBe(true);
	});

	test("an earlier approval whose stored copy no longer matches its hash is not offered: it would restore what nobody approved", async () => {
		const hash = await approve(TEAM);
		await settleAuto(false);
		await approve({ ...TEAM, rounds: 2 });
		const store = (await load()).store;
		await writeFile(path.join(store.dir, "snapshots", `${hash.slice(hash.indexOf(":") + 1)}.json`), serializeConfig({ ...TEAM, rounds: 7 }));
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		// The menu without the way back.
		expect(f.selects[0]?.options).toHaveLength(6);
	});

	test("a file changed while the rollback dialogs are open is not overwritten", async () => {
		await approve(TEAM);
		await settleAuto(false);
		await approve({ ...TEAM, rounds: 2 });
		const pulled = serializeConfig({ ...TEAM, rounds: 9 });
		const f = scriptedUi([
			FOURTH,
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
		await settleAuto(false);
		const f = scriptedUi([SECOND, LAST]);
		await hubFlow(env, f.ui);
		// Adopt, keep or later; then the menu, where the trial's config is now an earlier approval to go back to.
		expect(f.selects).toHaveLength(2);
		expect(f.selects[1]?.options).toContain("이전 승인으로 되돌리기");
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
		const pulled = serializeConfig({ ...withTrial, rounds: 9 });
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

describe("stale dialog owner", () => {
	test("a setup approval after a switch writes no config, approval or auto consent", async () => {
		await approve(TEAM);
		let live = true;
		const f = scriptedUi([
			options => {
				live = false;
				return options[0]!;
			},
		]);
		await setupFlow({ ...env, stillOwner: () => live }, f.ui);
		const after = await load();
		expect(after.config.status === "ok" && after.config.hash).toBe(configHash(TEAM));
		expect((await after.store.list()).map(record => record.configHash)).toEqual([configHash(TEAM)]);
		expect(isApproved(after)).toBe(true);
		expect(await autoChoice()).toBe("unset");
		expect(f.notices.at(-1)?.text).toContain("대화가 바뀌어");
	});

	test("an unapproved team's approval dialog after a switch approves nothing", async () => {
		await approve(TEAM);
		const edited = { ...TEAM, rounds: 9 };
		await editByHand(serializeConfig(edited));
		let live = true;
		const f = scriptedUi([
			options => {
				live = false;
				return options[0]!;
			},
		]);
		await hubFlow({ ...env, stillOwner: () => live }, f.ui);
		const after = await load();
		expect(after.config.status === "ok" && after.config.hash).toBe(configHash(edited));
		expect(after.approval).toBeUndefined();
		expect((await after.store.list()).map(record => record.configHash)).toEqual([configHash(TEAM)]);
		expect(f.notices.at(-1)?.text).toContain("대화가 바뀌어");
	});

	test("an auto consent dialog after a switch writes no choice", async () => {
		await approve(TEAM);
		let live = true;
		const f = scriptedUi([
			() => {
				live = false;
				return AUTO.enable;
			},
		]);
		await autoDelegationFlow({ ...env, stillOwner: () => live }, f.ui);
		expect(await autoChoice()).toBe("unset");
		expect(f.notices.at(-1)?.text).toContain("대화가 바뀌어");
	});

	test("a rollback confirmed after a switch restores nothing", async () => {
		await approve(TEAM);
		const newer = { ...TEAM, rounds: 2 };
		await approve(newer);
		let live = true;
		const f = scriptedUi([
			"이전 승인으로 되돌리기",
			FIRST,
			options => {
				live = false;
				return options[0]!;
			},
		]);
		await hubFlow({ ...env, stillOwner: () => live }, f.ui);
		const after = await load();
		expect(after.config.status === "ok" && after.config.hash).toBe(configHash(newer));
		expect((await after.store.list()).length).toBe(2);
		expect(f.notices.at(-1)?.text).toContain("대화가 바뀌어");
	});
});

describe("team export", () => {
	/** Every regular file below `dir` and its bytes, so "writes nothing" is checked on the whole tree. */
	async function snapshot(dir: string): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const walk = async (current: string): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await readdir(current, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const file = path.join(current, entry.name);
				if (entry.isDirectory()) await walk(file);
				else if (entry.isFile()) out.set(path.relative(dir, file), await readFile(file, "utf8"));
			}
		};
		await walk(dir);
		return out;
	}

	test("renders only shareable team options, writes nothing, and leaves approval, hashes, checks and paths out", async () => {
		const secret = {
			...TEAM,
			requiredChecks: [{ name: "private-check /Users/dhkim", argv: ["/Users/dhkim/bin/secret", "TOKEN=abcdef"] }],
			trials: [
				{
					id: "trial-export",
					role: "implementer",
					model: "pa/alpha-big",
					share: 0.5,
					maxSpawns: 3,
					startsAt: "2026-11-20T09:00:00.000Z",
					endsAt: "2026-11-30T09:00:00.000Z",
					budgetUsd: 1,
				},
			],
			unknownCredential: "SECRET-VALUE",
			parallelism: 9,
		} as unknown as StormConfig;
		await approve(secret);
		const before = await snapshot(project.tmp);
		const f = scriptedUi();
		await exportFlow(env, f.ui);
		expect(f.selects).toEqual([]);
		expect(f.reports).toHaveLength(1);
		expect(f.reports[0]?.title).toBe("Storm 팀 템플릿");
		const markdown = f.reports[0]!.markdown;
		expect(markdown).toContain('"version": 1');
		expect(markdown).toContain('"implementer"');
		expect(markdown).toContain('"models"');
		expect(markdown).not.toContain("parallelism");
		expect(markdown).not.toContain("병렬도");
		expect(markdown).not.toContain("requiredChecks");
		expect(markdown).not.toContain("argv");
		expect(markdown).not.toContain("private-check");
		expect(markdown).not.toContain("TOKEN=abcdef");
		expect(markdown).not.toContain("trials");
		expect(markdown).not.toContain("trial-export");
		expect(markdown).not.toContain("unknownCredential");
		expect(markdown).not.toContain("SECRET-VALUE");
		expect(markdown).not.toContain("jcs-sha256");
		expect(markdown).not.toContain(project.root);
		expect(markdown).not.toContain(env.agentDir);
		// A report, never a file: every byte under the temp profile and target is unchanged.
		expect(await snapshot(project.tmp)).toEqual(before);
	});

	test("without a valid team it says so and still writes nothing", async () => {
		const before = await snapshot(project.tmp);
		const f = scriptedUi();
		await exportFlow(env, f.ui);
		expect(f.reports).toEqual([]);
		expect(f.notices.at(-1)?.level).toBe("warning");
		expect(f.notices.at(-1)?.text).toContain("내보낼 승인된 팀 설정");
		expect(await snapshot(project.tmp)).toEqual(before);
	});
});

describe("resuming the last run", () => {
	const resumable = (over: Partial<RunRecord> = {}): RunRecord =>
		runRecord({
			runId: "run-20261119-090000-aaaa",
			startedAt: "2026-11-19T09:00:00.000Z",
			endedAt: "2026-11-19T09:30:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			turns: 2,
			maxRounds: 4,
			task: "resume-unique-request",
			request: "resume-unique-request",
			...over,
		});
	/** The representative target of this project: approval and resume authority, never a storage key. */
	const target = async () => {
		const state = await load();
		return { repoId: state.repo.repoId, root: state.repo.root };
	};
	/** The record and this session's target entry for it: what a real start leaves behind. */
	const plant = async (run: RunRecord): Promise<void> => {
		const state = await load();
		await writeRun(state.sessionDir, run);
		await noteResumePointer(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }, run);
	};
	/** A start that records its spec and answers with `result`. */
	const starter = (started: RunSpec[], result: RunRequestResult = { ok: true, runId: "run-new" }) => {
		return async (spec: RunSpec): Promise<RunRequestResult> => {
			started.push(spec);
			return result;
		};
	};

	test("a resumable last run is the menu's first option, described once on its row", async () => {
		await approve(TEAM);
		await settleAuto(false);
		const run = resumable();
		await plant(run);
		const started: RunSpec[] = [];
		const f = rowsUi([FIRST]);
		await hubFlow({ ...env, startRun: starter(started) }, f.ui);
		// One option more than the menu without a resumable run, and it comes first.
		expect(f.selects[0]?.options).toHaveLength(7);
		expect(started).toEqual([{ task: run.request!, resumeOf: run.runId }]);
		const resumeRow = f.rows[0]?.find(row => row.label === "끝나지 않은 실행 이어 가기");
		expect(resumeRow?.description).toContain("resume-unique-request");
		expect(resumeRow?.description).toContain("사용자가 중단");
		// The same run is the latest finished one, so it is not repeated above the menu as last-run data.
		expect(f.selects[0]?.markdown).not.toContain("resume-unique-request");
		expect(f.selects[0]?.markdown).not.toContain(run.runId);
		// The trusted resume candidate is the hub's present state; no second lookup invents it.
		expect(f.selects[0]?.markdown?.split("\n")[0]).toStartWith(STORM_MARK);
		expect(f.selects[0]?.markdown).toContain("이어가기 가능");
		expect(f.notices).toEqual([]);
	});

	test("a newer finished run stays visible when an older one is the resume candidate", async () => {
		await approve(TEAM);
		await settleAuto(false);
		const older = resumable();
		await plant(older);
		const newer = runRecord({
			runId: "run-20261119-120000-bbbb",
			startedAt: "2026-11-19T12:00:00.000Z",
			endedAt: "2026-11-19T12:30:00.000Z",
			status: "done",
			endReason: "verified",
			turns: 3,
			maxRounds: 4,
			task: "newer-done",
			request: "newer-done",
		});
		await writeRun((await load()).sessionDir, newer);
		const f = rowsUi([LAST]);
		await hubFlow({ ...env, startRun: starter([]) }, f.ui);
		expect(f.selects[0]?.options).toHaveLength(7);
		// The most recent finished run is shown, even though an older run is the one to continue.
		expect(f.selects[0]?.markdown).toContain(newer.runId);
		const resumeRow = f.rows[0]?.find(row => row.label === "끝나지 않은 실행 이어 가기");
		expect(resumeRow?.description).toContain("resume-unique-request");
		expect(resumeRow?.description).toContain("사용자가 중단");
	});

	test("a resume chosen or requested after a switch is not started", async () => {
		await approve(TEAM);
		await settleAuto(false);
		await plant(resumable());
		const started: RunSpec[] = [];
		let live = true;
		const f = scriptedUi([
			options => {
				live = false;
				return options[0]!;
			},
		]);
		await hubFlow({ ...env, startRun: starter(started), stillOwner: () => live }, f.ui);
		expect(started).toEqual([]);
		expect(f.notices.at(-1)?.text).toContain("대화가 바뀌어");

		const g = scriptedUi();
		await resumeFlow({ ...env, startRun: starter(started), stillOwner: () => false }, g.ui);
		expect(started).toEqual([]);
		expect(g.notices.at(-1)?.text).toContain("대화가 바뀌어");
	});

	test("a start refusal from the menu is a warning", async () => {
		await approve(TEAM);
		await settleAuto(false);
		await plant(resumable());
		const f = scriptedUi([FIRST]);
		await hubFlow({ ...env, startRun: starter([], { ok: false, reason: "run-active" }) }, f.ui);
		expect(f.notices).toHaveLength(1);
		expect(f.notices[0]?.level).toBe("warning");
		expect(f.notices[0]?.text).toContain("run-active");
	});

	test("a last run that ended, or no way to start one, leaves the menu as it was", async () => {
		await approve(TEAM);
		await settleAuto(false);
		for (const [runId, over] of [
			["run-20261119-100000-aaaa", { status: "done", endReason: "verified" }],
			["run-20261119-100001-aaaa", { status: "ended", endReason: "no-changes" }],
		] as const) {
			await writeRun((await load()).sessionDir, resumable({ runId, ...over }));
			const started: RunSpec[] = [];
			const f = scriptedUi([LAST]);
			await hubFlow({ ...env, startRun: starter(started) }, f.ui);
			expect(f.selects[0]?.options).toHaveLength(6);
			expect(started).toEqual([]);
		}
		// A resumable run, but this caller cannot start one.
		await writeRun((await load()).sessionDir, resumable({ runId: "run-20261119-110000-aaaa" }));
		const f = scriptedUi([LAST]);
		await hubFlow(env, f.ui);
		expect(f.selects[0]?.options).toHaveLength(6);
	});

	test("a planted record without a pointer, a pointer for another run, or an edited request is not offered", async () => {
		await approve(TEAM);
		await settleAuto(false);
		const run = resumable();
		await writeRun((await load()).sessionDir, run);
		/** Neither the menu nor the classifier path starts anything. */
		const notOffered = async (): Promise<void> => {
			const started: RunSpec[] = [];
			const f = scriptedUi([LAST]);
			await hubFlow({ ...env, startRun: starter(started) }, f.ui);
			expect(f.selects[0]?.options).toHaveLength(6);
			expect(started).toEqual([]);
			const g = scriptedUi();
			await resumeFlow({ ...env, startRun: starter(started) }, g.ui);
			expect(started).toEqual([]);
			expect(g.notices).toHaveLength(1);
		};
		await notOffered();
		// The pointer names a different run.
		await noteResumePointer((await load()).sessionDir, await target(), resumable({ runId: "run-20261119-095000-bbbb" }));
		await notOffered();
		// The pointer is right but the request was rewritten after the run.
		await noteResumePointer((await load()).sessionDir, await target(), run);
		await writeRun((await load()).sessionDir, resumable({ request: "edited-request", task: "edited-request" }));
		await notOffered();
	});

	test("the old run's limits are carried into the resume spec", async () => {
		await approve(TEAM);
		const run = resumable({ limits: { rounds: 3, minutes: 20 } });
		await plant(run);
		const started: RunSpec[] = [];
		const f = scriptedUi([FIRST]);
		await hubFlow({ ...env, startRun: starter(started) }, f.ui);
		expect(started).toEqual([{ task: run.request!, resumeOf: run.runId, rounds: 3, minutes: 20 }]);
	});

	test("resumeFlow starts the last resumable run; without one it starts nothing and notifies once", async () => {
		await approve(TEAM);
		const started: RunSpec[] = [];
		const none = scriptedUi();
		await resumeFlow({ ...env, startRun: starter(started) }, none.ui);
		expect(started).toEqual([]);
		expect(none.selects).toEqual([]);
		expect(none.notices).toHaveLength(1);

		const run = resumable();
		await plant(run);
		const f = scriptedUi();
		await resumeFlow({ ...env, startRun: starter(started) }, f.ui);
		expect(started).toEqual([{ task: run.request!, resumeOf: run.runId }]);
		expect(f.selects).toEqual([]);
		expect(f.notices).toEqual([]);
	});

	test("what the user typed when asking to resume becomes the note", async () => {
		await approve(TEAM);
		const run = resumable();
		await plant(run);
		const started: RunSpec[] = [];
		const f = scriptedUi();
		const said = "이어서 하되\nX는 빼고";
		await resumeFlow({ ...env, startRun: starter(started) }, f.ui, said);
		expect(started).toEqual([{ task: run.request!, resumeOf: run.runId, resumeNote: said }]);
		expect(f.selects).toEqual([]);
		expect(f.notices).toEqual([]);
	});

	test("/storm reset removes this session's resume pointer; the approval prune keeps it", async () => {
		await approve(TEAM);
		const state = await load();
		const run = resumable();
		await noteResumePointer(state.sessionDir, await target(), run);
		await state.store.prune(configHash(TEAM));
		expect(await readFile(resumePointerFile(state.sessionDir), "utf8")).toContain(run.runId);
		const f = scriptedUi([FIRST]);
		await resetFlow(env, f.ui);
		await expect(readFile(resumePointerFile(state.sessionDir), "utf8")).rejects.toThrow();
	});

	test("resume entries are per target and per session: reset removes only this session's store", async () => {
		await approve(TEAM);
		const state = await load();
		const run = resumable();
		const otherRoot = path.join(project.tmp, "other-worktree");
		const other = resumable({ runId: "run-20261119-095500-bbbb" });
		await noteResumePointer(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }, run);
		await noteResumePointer(state.sessionDir, { repoId: "git-other-000000000000000000000000", root: otherRoot }, other);
		// One session store, but a run is offered only to the target that started it.
		expect((await resumeCandidate(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }, run))?.runId).toBe(run.runId);
		expect(await resumeCandidate(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }, other)).toBeUndefined();
		// A sibling session has its own pointer and is not touched by this session's reset.
		const sibling = await loadProjectState(withSession(project, "session-sibling-resume"));
		await noteResumePointer(sibling.sessionDir, { repoId: sibling.repo.repoId, root: sibling.repo.root }, other);

		const f = scriptedUi([FIRST]);
		await resetFlow(env, f.ui);
		await expect(readFile(resumePointerFile(state.sessionDir), "utf8")).rejects.toThrow();
		expect(await readFile(resumePointerFile(sibling.sessionDir), "utf8")).toContain(other.runId);
	});
});
