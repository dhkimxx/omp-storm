/** Shared test doubles: a real `git`, a temp project, a UI that answers from a script, and a small model catalog. */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FlowEnv } from "../src/flows.ts";
import { ROLES } from "../src/roles.ts";
import type { AnalysisContext, Candidate, Exec, MetricValue, ModelInfo, Priority, RoleId, RoleRecommendation, StormConfig, UiPort } from "../src/types.ts";

export const exec: Exec = async (command, args, options) => {
	const p = Bun.spawn([command, ...args], {
		...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { stdout, stderr, code };
};

export async function git(cwd: string, ...args: string[]): Promise<void> {
	const res = await exec("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
	if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
}

export interface TestProject {
	tmp: string;
	/** The project directory (not a git repo unless the test makes it one). */
	root: string;
	env: FlowEnv;
	remove(): Promise<void>;
}

/**
 * A temp project with its own omp agent dir and an absent stats DB. Only `git` really runs; every other command
 * (the `omp` CLI) fails, so nothing outside `tmp` is read or written and no model is "available".
 */
export async function makeProject(now: () => number = Date.now): Promise<TestProject> {
	const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-test-")));
	const root = path.join(tmp, "project");
	await Bun.write(path.join(root, ".keep"), "");
	const env: FlowEnv = {
		cwd: root,
		exec: (command, args, options) => (command === "git" ? exec(command, args, options) : Promise.resolve({ stdout: "", stderr: "", code: 1 })),
		agentDir: path.join(tmp, "agent"),
		pluginAgentsDir: path.join(tmp, "plugin-agents"),
		ompBin: "omp",
		statsDb: path.join(tmp, "no-stats.db"),
		registry: { getAll: () => [], getAvailable: () => [] },
		activeTools: [],
		now,
	};
	return { tmp, root, env, remove: () => rm(tmp, { recursive: true, force: true }) };
}

/** An answer, or a hook run when the dialog opens (to change state underneath) that then answers. */
export type Answer = string | undefined | ((options: string[]) => string | undefined | Promise<string | undefined>);

/** Answers with the option at a position (negative counts from the end), whatever it is called: order is structure, wording is not. */
export const pick =
	(index: number): Answer =>
	options =>
		options.at(index);

export interface ScriptedUi {
	ui: UiPort;
	selects: Array<{ title: string; options: string[]; markdown?: string }>;
	/** Every notice's text, in order. */
	notes: string[];
	/** Every notice with its level ("info" when none was given). */
	notices: Array<{ text: string; level: "info" | "warning" | "error" }>;
	reports: Array<{ title: string; markdown: string }>;
	/** Transcript records (a run's summary). */
	records: Array<{ title: string; markdown: string }>;
	/** What the UI was asked to do, in order: "select", "notify:<level>", "report", "record". Callers may add their own marks. */
	events: string[];
	/** Scripted answers not asked for yet. */
	left(): number;
}

/** Answers selects in order and records every dialog, notice, report and record. A select past the script fails the test. */
export function scriptedUi(answers: Answer[] = []): ScriptedUi {
	const queue = [...answers];
	const selects: ScriptedUi["selects"] = [];
	const notes: string[] = [];
	const notices: ScriptedUi["notices"] = [];
	const reports: ScriptedUi["reports"] = [];
	const records: ScriptedUi["records"] = [];
	const events: string[] = [];
	const ui: UiPort = {
		async select(title, options, context) {
			selects.push({ title, options: [...options], ...(context ? { markdown: context.markdown } : {}) });
			events.push("select");
			if (!queue.length) throw new Error(`no scripted answer for select: ${title}`);
			const answer = queue.shift();
			return typeof answer === "function" ? answer(options) : answer;
		},
		notify(message, level = "info") {
			notes.push(message);
			notices.push({ text: message, level });
			events.push(`notify:${level}`);
		},
		async report(title, markdown) {
			reports.push({ title, markdown });
			events.push("report");
		},
		record(title, markdown) {
			records.push({ title, markdown });
			events.push("record");
		},
	};
	return { ui, selects, notes, notices, reports, records, events, left: () => queue.length };
}

const metric = (value: number | null): MetricValue => ({ value, source: value === null ? "none" : "catalog" });

export function cand(selector: string, over: Partial<Candidate> = {}): Candidate {
	return {
		selector,
		modelKey: selector,
		label: selector.split("/")[1]!.toUpperCase(),
		effort: "medium",
		tier: "general",
		int: metric(50),
		speed: metric(100),
		referenceUsd: 0.02,
		quota: "available",
		validated: false,
		why: [],
		whyNot: [],
		...over,
	};
}

export function rec(role: RoleId, candidates: Candidate[], fallback?: Candidate): RoleRecommendation {
	return {
		role: ROLES.find(r => r.id === role)!,
		candidates,
		chosenIndex: candidates.length ? 0 : -1,
		excluded: [],
		...(fallback ? { fallback } : {}),
	};
}

export function model(selector: string, over: Partial<ModelInfo> = {}): ModelInfo {
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
		efforts: ["low", "medium", "high"],
		supportsTools: true,
		int: 50,
		tps: 100,
		available: true,
		...over,
	};
}

/**
 * Recommendations of the fake catalog: explorer a/x (fallback b/z), implementer a/i without effort control
 * (fallback c/j), reviewer b/r with no fallback. `tag` renames every model, as another priority would.
 */
export function recs(tag = ""): RoleRecommendation[] {
	return [
		rec("explorer", [cand(`a/x${tag}`, { effort: "low" }), cand(`a/y${tag}`), cand(`b/z${tag}`)], cand(`b/z${tag}`)),
		rec("implementer", [cand(`a/i${tag}`, { effort: null }), cand(`c/j${tag}`)], cand(`c/j${tag}`)),
		rec("reviewer", [cand(`b/r${tag}`, { effort: "high" })]),
	];
}

/**
 * The parts of an analysis context the approval paths read: the available catalog, the model check and the
 * recommender ("balanced" → `recs()`, any other priority → `recs("2")`). Besides the recommended models the catalog
 * has c/cand (no "high" effort), d/small (32k window), e/noeffort and f/notools.
 */
export function fakeCtx(now = 0): AnalysisContext {
	const selectors = [...recs(), ...recs("2")].flatMap(r => r.candidates.map(c => c.selector));
	const catalog = [
		...[...new Set(selectors)].map(s => model(s)),
		model("c/cand", { efforts: ["low", "medium"] }),
		model("d/small", { contextWindow: 32_000 }),
		model("e/noeffort", { efforts: [] }),
		model("f/notools", { supportsTools: false }),
	];
	const ctx: Pick<AnalysisContext, "now" | "catalog" | "available" | "recommend" | "checkModel"> = {
		now,
		catalog,
		available: catalog,
		recommend: (priority: Priority) => recs(priority === "balanced" ? "" : "2"),
		checkModel: selector => {
			const m = catalog.find(x => x.selector === selector.trim());
			if (!m) return { ok: false, reason: `${selector}: unavailable` };
			if (!m.supportsTools) return { ok: false, reason: `${selector}: no tools` };
			return { ok: true, label: m.name, efforts: m.efforts };
		},
	};
	// The rest of the context (usage, lineage, tiers) belongs to the recommender and is not read on these paths.
	return ctx as AnalysisContext;
}

/** A three-role team on the fake catalog. */
export const TEAM: StormConfig = {
	version: 1,
	priority: "balanced",
	roles: {
		explorer: { agent: "storm-explorer", models: ["a/x", "b/z"], effort: "low" },
		implementer: { agent: "storm-implementer", models: ["a/i"], workers: { min: 1, max: 3 } },
		reviewer: { agent: "storm-reviewer", models: ["b/r"], effort: "high" },
	},
	parallelism: 4,
	isolation: "shared",
};
