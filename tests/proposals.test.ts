import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { configHash } from "../src/config/canonical.ts";
import { configPath, serializeConfig } from "../src/config/store.ts";
import { approveAndSave } from "../src/flows.ts";
import {
	buildBudget,
	buildPriority,
	buildQuota,
	buildReselect,
	buildSettings,
	buildTrial,
	buildTrialEnd,
	buildWorkers,
	checkRoleModel,
	missingRole,
	modelWarnings,
	quotaPlan,
	TRIAL_DEFAULTS,
	trialId,
} from "../src/proposals/build.ts";
import { type DecideHost, decideProposal, NEEDS_APPROVAL } from "../src/proposals/decide.ts";
import { APPROVE, CANCEL, presentProposal, renderApproval } from "../src/proposals/present.ts";
import { recommendationNotes } from "../src/setup/form.ts";
import { isApproved, loadProjectState } from "../src/state.ts";
import type { Effort, InfoLine, Proposal, ShadowInfo, StormConfig, UiContext, UiPort } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";
import { type Answer, cand, fakeCtx, makeProject, rec, recs, scriptedUi, type TestProject } from "./support.ts";

const NOW = Date.parse("2026-11-20T09:30:00Z");

const base: StormConfig = teamOf({ explorer: { models: ["a/x", "b/z"], effort: "low" }, implementer: "a/i", reviewer: { models: ["b/r"], effort: "high" } });

const reselected = structuredClone(base);
reselected.roles.implementer!.models = ["c/j", "a/i"];
const change: Proposal = { kind: "reselect", summary: "summary-line", config: reselected };

describe("presentProposal", () => {
	// The one test that spells the labels out: "승인" is the contract, and nothing that merely looks like it approves.
	test("offers exactly 승인 and 취소, and only the exact label approves", async () => {
		expect([APPROVE, CANCEL]).toEqual(["승인", "취소"]);
		const cases: Array<[string | undefined, "approved" | "cancelled"]> = [
			[APPROVE, "approved"],
			[CANCEL, "cancelled"],
			// A host that cannot answer dialogs.
			[undefined, "cancelled"],
			[`${APPROVE} `, "cancelled"],
			["approve", "cancelled"],
			["later", "cancelled"],
		];
		for (const [answer, outcome] of cases) {
			const f = scriptedUi([answer]);
			expect(await presentProposal(f.ui, change, base)).toBe(outcome);
			expect(f.selects).toHaveLength(1);
			expect(f.selects[0]?.options).toEqual([APPROVE, CANCEL]);
			expect(f.selects[0]?.markdown).toBe(renderApproval(change.summary, base, change.config));
		}
	});

	test("the caller's extra options sit between the two and come back as { extra }", async () => {
		const f = scriptedUi(["extra-option", CANCEL, "something else"]);
		const opts = { extraOptions: ["extra-option"] };
		expect(await presentProposal(f.ui, change, base, opts)).toEqual({ extra: "extra-option" });
		expect(f.selects[0]?.options).toEqual([APPROVE, "extra-option", CANCEL]);
		expect(await presentProposal(f.ui, change, base, opts)).toBe("cancelled");
		expect(await presentProposal(f.ui, change, base, opts)).toBe("cancelled");
	});

	test("the dialog carries the summary, the changed values, warnings, shadows and the caller's context", () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project", sha256: "ab" };
		const md = renderApproval(change.summary, base, change.config, { shadows: [shadow], warnings: ["warning-text"], context: "context-text" });
		for (const part of ["summary-line", "a/i → c/j, a/i", "warning-text", shadow.path, "context-text"]) expect(md).toContain(part);
		// Unchanged roles are not listed in a diff.
		expect(md).not.toContain("b/r");
		// Without a current config the whole team is shown.
		const whole = renderApproval(undefined, undefined, change.config);
		for (const model of ["a/x, b/z", "c/j, a/i", "b/r"]) expect(whole).toContain(model);
	});
});

describe("approval rich lines", () => {
	/** A port that records the dialog context and answers with one label. */
	const capture = (answer: string | undefined): { ui: UiPort; contexts: UiContext[] } => {
		const contexts: UiContext[] = [];
		const ui: UiPort = {
			async select(_title, _options, context) {
				if (context) contexts.push(context);
				return answer;
			},
			notify() {},
			async report() {},
			record() {},
		};
		return { ui, contexts };
	};

	test("warnings, the diff and notes land on their own lines despite multi-line context", () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/repo/.agents/storm-reviewer.md", scope: "project", sha256: "ab" };
		const notesInfo: InfoLine[] = [];
		const notes = recommendationNotes([rec("implementer", [cand("c/j", { label: "J", why: ["measured faster"] })])], change.config, notesInfo);
		const info: InfoLine[] = [];
		const context = "첫 줄\n둘째 줄\n\n넷째 줄";
		const md = renderApproval(change.summary, base, change.config, { context, shadows: [shadow], warnings: ["warning-one", "warning-two"], notes, notesInfo }, info);
		const lines = md.split("\n");

		// A collector replaces lines the renderer can style, never the same line twice, always inside the Markdown.
		expect(new Set(info.map(line => line.index)).size).toBe(info.length);
		for (const line of info) {
			expect(line.index).toBeGreaterThanOrEqual(0);
			expect(line.index).toBeLessThan(lines.length);
			expect(line.spans.map(span => span.text).join("")).not.toBe("");
		}

		// Four context lines shift every later offset; each section still points at the line it annotates.
		const shadowsAt = lines.findIndex(line => line.startsWith("### 경고: 가림 정의"));
		expect(shadowsAt).toBeGreaterThan(context.split("\n").length);
		expect(info.find(line => line.index === shadowsAt)?.spans[0]?.tone).toBe("warning");
		expect(info.find(line => line.index === shadowsAt)?.spans[0]?.text).toBe(lines[shadowsAt]!.replace(/^#{1,6} /, ""));
		const warningsAt = lines.indexOf("### 경고");
		expect(info.find(line => line.index === warningsAt)?.spans).toEqual([{ text: "경고", tone: "warning" }]);
		for (const warning of ["- warning-one", "- warning-two"]) {
			const at = lines.indexOf(warning);
			expect(at).toBeGreaterThan(warningsAt);
			expect(info.find(line => line.index === at)?.spans[0]?.tone).toBe("warning");
		}

		// Diff lines are annotated between their heading and the notes, not on either boundary.
		const notesAt = lines.indexOf("### 추천 근거");
		const diff = info.filter(line => line.index > lines.indexOf("### 변경") && line.index < notesAt);
		expect(diff.length).toBeGreaterThan(0);
		for (const line of diff) expect(lines[line.index]).toMatch(/^- /);

		// The note's Markdown stays authoritative; its rich line adds only the recommendation badge.
		const annotated = info.filter(line => line.index > notesAt);
		expect(annotated).toHaveLength(1);
		const rich = annotated[0]!.spans.map(span => span.text).join("");
		expect(annotated[0]!.spans.some(span => span.text.includes("★ 추천"))).toBe(true);
		expect(rich.replace("★ 추천 ", "").replace(/^[•-] /, "")).toBe(lines[annotated[0]!.index]!.replace(/^[•-] /, ""));
		expect(lines[annotated[0]!.index]).toContain("J");
	});

	test("rich lines change neither the Markdown nor what approval accepts", async () => {
		const notesInfo: InfoLine[] = [];
		const notes = recommendationNotes(recs(), change.config, notesInfo);
		const view = { context: "context\nsecond line", warnings: ["warning-text"], notes, notesInfo };
		const plain = renderApproval(change.summary, base, change.config, view);
		const collected: InfoLine[] = [];
		expect(renderApproval(change.summary, base, change.config, view, collected)).toBe(plain);
		expect(collected.length).toBeGreaterThan(0);

		const approved = capture(APPROVE);
		expect(await presentProposal(approved.ui, change, base, view)).toBe("approved");
		expect(approved.contexts).toHaveLength(1);
		expect(approved.contexts[0]?.markdown).toBe(plain);
		expect(approved.contexts[0]?.info).toEqual(collected);
		expect(approved.contexts[0]?.consent).toEqual([APPROVE]);

		const cancelled = capture(CANCEL);
		expect(await presentProposal(cancelled.ui, change, base, view)).toBe("cancelled");
		const unanswered = capture(undefined);
		expect(await presentProposal(unanswered.ui, change, base, view)).toBe("cancelled");
	});
});

describe("decideProposal", () => {
	let project: TestProject;
	beforeEach(async () => {
		project = await makeProject();
	});
	afterEach(() => project.remove());

	const host = (answers: Answer[]) => {
		const f = scriptedUi(answers);
		const h: DecideHost = { ui: f.ui, loadState: () => loadProjectState(project.env), approveAndSave };
		return { ...f, host: h };
	};
	/** Saves and approves `config` as the project's team. */
	const approve = async (config: StormConfig): Promise<void> => {
		await approveAndSave(await loadProjectState(project.env), config, { shadowedAgents: [] });
	};
	/** A teammate's (or a hand) edit: the file changes, nobody approves it here. */
	const editByHand = (config: StormConfig) => writeFile(configPath(project.root), serializeConfig(config));
	const onDisk = async () => configHash(JSON.parse(await readFile(configPath(project.root), "utf8")));

	test("승인 on a change to an approved config saves it approved", async () => {
		await approve(base);
		const f = host(["승인"]);
		const decision = await decideProposal(f.host, await loadProjectState(project.env), change);
		expect(decision).toEqual({ outcome: "approved", hash: configHash(reselected) });
		expect(await onDisk()).toBe(configHash(reselected));
		expect(isApproved(await loadProjectState(project.env))).toBe(true);
	});

	test("a change is refused while the current config is unapproved: no dialog, nothing approved, file untouched", async () => {
		await approve(base);
		const edited = structuredClone(base);
		edited.roles.reviewer!.models = ["z/unseen"];
		edited.parallelism = 9;
		await editByHand(edited);
		const state = await loadProjectState(project.env);
		const workers = buildWorkers(edited, "explorer", 1, 3);
		if ("error" in workers) throw new Error(workers.error);
		for (const kind of ["workers", "reselect", "priority", "quota", "trial", "budget", "settings", "plan"] as const) {
			const f = host([]);
			const decision = await decideProposal(f.host, state, { kind, summary: workers.summary, config: workers.config });
			expect(decision).toEqual({ outcome: "rejected", reason: NEEDS_APPROVAL });
			expect(f.selects).toEqual([]);
		}
		const after = await loadProjectState(project.env);
		expect(await onDisk()).toBe(configHash(edited));
		expect(after.approval).toBeUndefined();
		expect((await after.store.list()).map(r => r.configHash)).toEqual([configHash(base)]);
		expect(await after.store.active(configHash(workers.config))).toBeUndefined();
	});

	test("a setup over an unapproved config shows the whole team, not a diff against the unseen file", async () => {
		await approve(base);
		const edited = structuredClone(base);
		edited.roles.reviewer!.models = ["z/unseen"];
		await editByHand(edited);
		const next = structuredClone(edited);
		next.parallelism = 2;
		const f = host(["승인"]);
		const decision = await decideProposal(f.host, await loadProjectState(project.env), { kind: "setup", summary: "s", config: next });
		expect(decision.outcome).toBe("approved");
		// The model the teammate changed is in view although the proposal did not touch it.
		expect(f.selects[0]?.markdown).toContain("z/unseen");
		expect(f.selects[0]?.markdown).toBe(renderApproval("s", undefined, next));
	});

	test("a first setup needs no current config", async () => {
		const f = host(["승인"]);
		const decision = await decideProposal(f.host, await loadProjectState(project.env), { kind: "setup", summary: "s", config: base });
		expect(decision).toEqual({ outcome: "approved", hash: configHash(base) });
		expect(isApproved(await loadProjectState(project.env))).toBe(true);
	});

	test("cancel, an unanswerable host and an extra option write nothing", async () => {
		await approve(base);
		const state = await loadProjectState(project.env);
		expect(await decideProposal(host([CANCEL]).host, state, change)).toEqual({ outcome: "cancelled" });
		expect(await decideProposal(host([undefined]).host, state, change)).toEqual({ outcome: "cancelled" });
		expect(await decideProposal(host(["x"]).host, state, change, { extraOptions: ["x"] })).toEqual({ outcome: "extra", extra: "x" });
		expect(await onDisk()).toBe(configHash(base));
		expect((await state.store.list()).map(r => r.configHash)).toEqual([configHash(base)]);
	});

	test("the approved current config proposed again asks nothing; an invalid proposal is rejected unasked", async () => {
		await approve(base);
		const state = await loadProjectState(project.env);
		const f = host([]);
		expect(await decideProposal(f.host, state, { kind: "settings", summary: "s", config: structuredClone(base) })).toEqual({ outcome: "unchanged" });
		const broken = { ...base, parallelism: 99 };
		expect((await decideProposal(f.host, state, { kind: "settings", summary: "s", config: broken })).outcome).toBe("rejected");
		expect(f.selects).toEqual([]);
	});

	test("a config changed while the dialog was open blocks the save", async () => {
		await approve(base);
		const moved = { ...base, parallelism: 2 };
		const f = host([
			async () => {
				await editByHand(moved);
				return "승인";
			},
		]);
		const decision = await decideProposal(f.host, await loadProjectState(project.env), change);
		expect(decision.outcome).toBe("rejected");
		expect(await onDisk()).toBe(configHash(moved));
		expect(await (await loadProjectState(project.env)).store.active(configHash(reselected))).toBeUndefined();
	});

	test("a file that appears or changes while still invalid during a setup dialog is not overwritten", async () => {
		const file = configPath(project.root);
		const writeRaw = async (text: string) => {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, text);
		};
		const setup: Proposal = { kind: "setup", summary: "s", config: base };
		// missing → invalid
		const appeared = host([
			async () => {
				await writeRaw("{ teammate is typing");
				return "승인";
			},
		]);
		expect((await decideProposal(appeared.host, await loadProjectState(project.env), setup)).outcome).toBe("rejected");
		expect(await readFile(file, "utf8")).toBe("{ teammate is typing");
		// invalid → another invalid
		const edited = host([
			async () => {
				await writeRaw('{ "version": 2 }');
				return "승인";
			},
		]);
		expect((await decideProposal(edited.host, await loadProjectState(project.env), setup)).outcome).toBe("rejected");
		expect(await readFile(file, "utf8")).toBe('{ "version": 2 }');
		expect(await (await loadProjectState(project.env)).store.list()).toEqual([]);
		// An invalid file that stays as it was is what the user saw: the setup replaces it.
		const same = host(["승인"]);
		expect((await decideProposal(same.host, await loadProjectState(project.env), setup)).outcome).toBe("approved");
		expect(await onDisk()).toBe(configHash(base));
	});

	test("validation warnings of the proposed config and the caller's warnings are both in the dialog", async () => {
		await approve(base);
		const odd = { ...reselected, typo: 1 } as StormConfig;
		const f = host(["취소"]);
		await decideProposal(f.host, await loadProjectState(project.env), { kind: "reselect", summary: "s", config: odd }, { warnings: ["caller-warning"] });
		expect(f.selects[0]?.markdown).toContain("caller-warning");
		expect(f.selects[0]?.markdown).toContain("typo");
	});
});

describe("builders", () => {
	test("quotaPlan finds roles whose primary is on the provider", () => {
		expect(quotaPlan(base, "a")).toEqual([
			{ role: "explorer", from: "a/x", alternative: "b/z" },
			{ role: "implementer", from: "a/i", alternative: null },
		]);
		expect(quotaPlan(base, "b")).toEqual([{ role: "reviewer", from: "b/r", alternative: null }]);
		expect(quotaPlan(base, "zzz")).toEqual([]);
	});

	test("buildQuota adds the best candidate off the provider, also when only the role's fallback is", () => {
		expect(buildQuota(base, "a", ["implementer"], [rec("implementer", [])])).toHaveProperty("error");
		const beyond = buildQuota(base, "a", ["implementer"], [rec("implementer", [cand("a/i"), cand("a/k")], cand("c/j", { effort: "high" }))]);
		if ("error" in beyond) throw new Error(beyond.error);
		expect(beyond.config.roles.implementer!.models).toEqual(["a/i", "c/j:high"]);
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
		const quota = buildQuota({ ...suffixed, roles: { explorer: { agent: "storm-explorer", models: ["a/x:max", "b/z:low"] } } }, "a", ["explorer"], [rec("explorer", [cand("b/z")])]);
		if ("error" in quota) throw new Error(quota.error);
		expect(quota.config.roles.explorer!.models).toEqual(["a/x:max", "b/z:medium"]);
	});

	test("priority re-picks each role from its recommendation: chosen candidate, then the fallback, at their own efforts", () => {
		const built = buildPriority({ ...base, trials: [] }, "cost", [...recs("2").slice(0, 2), rec("reviewer", [])]);
		if ("error" in built) throw new Error(built.error);
		expect(built.config.priority).toBe("cost");
		expect(built.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["a/x2:low", "b/z2:medium"] });
		expect(built.config.roles.implementer!.models).toEqual(["a/i2", "c/j2:medium"]);
		// No candidate: the role keeps its models and its effort.
		expect(built.config.roles.reviewer).toEqual(base.roles.reviewer!);
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

	test("trial bounds and defaults", () => {
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
		expect(buildTrial(base, { ...input, efforts: [], share: 1, maxSpawns: 1000, days: 30, budgetUsd: 0.01 })).not.toHaveProperty("error");
		const plain = buildTrial(base, { ...input, efforts: [] });
		if ("error" in plain) throw new Error(plain.error);
		expect(TRIAL_DEFAULTS.share).toBe(0.5);
		expect(plain.config.trials).toEqual([
			{
				id: trialId("reviewer", "c/j", NOW),
				role: "reviewer",
				model: "c/j",
				share: 0.5,
				maxSpawns: 20,
				startsAt: "2026-11-20T09:30:00.000Z",
				endsAt: "2026-11-27T09:30:00.000Z",
				budgetUsd: 2,
			},
		]);
	});

	test("a trial restarted the same day gets a new id, so it does not inherit the ended one's counters", () => {
		const first = trialId("reviewer", "openrouter/Anthropic/Claude-5.5:high", NOW);
		expect(first).toMatch(/^reviewer-openrouter-anthropic-claude-5-5-high-20261120T093000Z$/);
		expect(trialId("reviewer", "openrouter/Anthropic/Claude-5.5:high", NOW + 60_000)).not.toBe(first);
	});

	test("ending a trial: keeping drops only the trial; adopting puts the candidate first with the trial's effort", () => {
		const other = { id: "t-other", role: "explorer", model: "c/k", share: 0.5, maxSpawns: 1, startsAt: "2026-11-20T00:00:00Z", endsAt: "2026-11-21T00:00:00Z", budgetUsd: 1 };
		const trial = { ...other, id: "t-rev", role: "reviewer", model: "c/j", effort: "low" as const };
		const current: StormConfig = { ...base, trials: [other, trial] };
		const kept = buildTrialEnd(current, trial, false);
		if ("error" in kept) throw new Error(kept.error);
		expect(kept.config).toEqual({ ...base, trials: [other] });
		const adopted = buildTrialEnd(current, trial, true);
		if ("error" in adopted) throw new Error(adopted.error);
		expect(adopted.config.roles.reviewer!.models).toEqual(["c/j:low", "b/r"]);
		expect(adopted.config.trials).toEqual([other]);
		const last = buildTrialEnd({ ...base, trials: [trial] }, trial, false);
		if ("error" in last) throw new Error(last.error);
		expect(last.config).toEqual(base);
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

	test("a role that is not in roles: every builder refuses, and a disabled role gets its own reason", () => {
		const disabled: StormConfig = { ...base, disabledRoles: ["architect"] };
		const off = missingRole(disabled, "architect");
		expect(off).not.toBe(missingRole(base, "architect"));
		expect(buildWorkers(disabled, "architect", 2, 2)).toEqual({ error: off });
		expect(buildReselect(disabled, "architect", "a/new", ["high"])).toEqual({ error: off });
		expect(buildTrial(disabled, { role: "architect", model: "a/new", efforts: ["high"], now: 0 })).toEqual({ error: off });
		expect(buildWorkers(disabled, "quick", 2, 2)).toEqual({ error: missingRole(disabled, "quick") });
	});
});

describe("model checks", () => {
	const ctx = fakeCtx();

	test("unusable and tool-less models are rejected; a small context window only warns", () => {
		expect(checkRoleModel("implementer", "z/none", ctx).ok).toBe(false);
		expect(checkRoleModel("implementer", "f/notools", ctx).ok).toBe(false);
		const small = checkRoleModel("implementer", "d/small", ctx);
		expect(small.ok && small.warning).toContain("32,000");
		const fine = checkRoleModel("implementer", "a/i", ctx);
		expect(fine).toEqual({ ok: true, label: "a/i", efforts: ["low", "medium", "high"] });
	});

	test("the dialog warnings cover every model of the config, trials included, once each", () => {
		expect(modelWarnings(base, ctx)).toEqual([]);
		const config: StormConfig = {
			...base,
			roles: {
				...base.roles,
				explorer: { agent: "storm-explorer", models: ["z/none:low", "d/small"] },
				reviewer: { agent: "storm-reviewer", models: ["z/none"] },
			},
			trials: [{ id: "t", role: "implementer", model: "f/notools", share: 0.5, maxSpawns: 1, startsAt: "2026-11-20T00:00:00Z", endsAt: "2026-11-21T00:00:00Z", budgetUsd: 1 }],
		};
		const warnings = modelWarnings(config, ctx);
		expect(warnings).toHaveLength(3);
		expect(warnings.map(w => w.slice(0, w.indexOf(":")))).toEqual(["z/none", "d/small", "f/notools"]);
	});
});
