import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { configHash, shortHash } from "../src/config/canonical.ts";
import { configPath, serializeConfig } from "../src/config/store.ts";
import { approveAndSave } from "../src/flows.ts";
import { orderByQuota } from "../src/policy/spawn.ts";
import { quotaPlan, trialId } from "../src/proposals/build.ts";
import { NEEDS_APPROVAL } from "../src/proposals/decide.ts";
import { APPROVE, CANCEL } from "../src/proposals/present.ts";
import { type ActionHost, type ActionReply, type ChangeAction, parseChange, runChange } from "../src/request/actions.ts";
import { runSpec } from "../src/request/args.ts";
import { buildRoutePrompt, FALLBACK, parseRouteReply, QUOTA_CHOICE, type RouteHandlers, routePrefix, routeRequest, teamBrief } from "../src/request/route.ts";
import { loadProjectState } from "../src/state.ts";
import type { RunRequestResult } from "../src/tool/host.ts";
import type { RunSpec, ShadowInfo, StormConfig, TrialConfig } from "../src/types.ts";
import { type FakeHostOptions, fakeHost, NOW } from "./fake-host.ts";
import { type Answer, makeProject, scriptedUi, TEAM as base } from "./support.ts";

const run = (f: { host: ActionHost }, change: ChangeAction) => runChange(f.host, change);

/** One of every change that proposes a new config. */
const CHANGES: ChangeAction[] = [
	{ action: "priority", priority: "cost" },
	{ action: "workers", role: "implementer", max: 2 },
	{ action: "reselect", role: "implementer", model: "c/j" },
	{ action: "reselect", role: "explorer" },
	{ action: "trial", role: "reviewer", model: "c/cand" },
	{ action: "budget", budgetUsd: 3 },
	{ action: "settings", docs: false },
];

describe("run spec", () => {
	const spec = (...args: Parameters<typeof runSpec>) => {
		const result = runSpec(...args);
		return result.ok ? result.spec : undefined;
	};

	test("a task with no stated limits", () => {
		expect(spec("  fix the login bug ")).toEqual({ task: "fix the login bug" });
		expect(spec("t", { rounds: undefined, minutes: undefined })).toEqual({ task: "t" });
		expect(spec("  ")).toBeUndefined();
		expect(spec("")).toBeUndefined();
	});

	test("the limits the user stated land in the spec", () => {
		expect(spec("t", { rounds: 3 })).toEqual({ task: "t", rounds: 3 });
		expect(spec("t", { minutes: 30 })).toEqual({ task: "t", minutes: 30 });
		expect(spec("t", { rounds: 1, minutes: 0.5 })).toEqual({ task: "t", rounds: 1, minutes: 0.5 });
		expect(spec("t", { rounds: 20, minutes: 1440 })).toEqual({ task: "t", rounds: 20, minutes: 1440 });
	});

	test("a non-empty resumeOf is passed through; an empty one is no resume", () => {
		expect(spec("t", undefined, " run-1 ")).toEqual({ task: "t", resumeOf: "run-1" });
		expect(spec("t", { rounds: 2 }, "run-1")).toEqual({ task: "t", rounds: 2, resumeOf: "run-1" });
		expect(spec("t", undefined, "   ")).toEqual({ task: "t" });
	});

	test("a limit outside what a run accepts is an error", () => {
		for (const rounds of [0, -1, 2.5, 21, Number.NaN]) expect(spec("t", { rounds })).toBeUndefined();
		for (const minutes of [0, -1, 1441, Number.POSITIVE_INFINITY, Number.NaN]) expect(spec("t", { minutes })).toBeUndefined();
	});
});

describe("route: fixed prefixes", () => {
	test("the old mode words mean nothing: such text goes to the classifier", () => {
		for (const text of ["vibe x", "goal x", "loop 3 x", "GOAL green CI --budget 1m", "Vibe"]) expect(routePrefix(text)).toBeUndefined();
	});

	test("old subcommand words alone open the menu; with more text they are a request", () => {
		for (const word of ["run", "rollback", "approve", "review", " Review "]) expect(routePrefix(word)).toEqual({ action: "menu" });
		for (const text of ["review the auth module", "run the tests", "vibecheck", "looping is slow", "fix the bug"]) expect(routePrefix(text)).toBeUndefined();
	});
});

describe("route: the side turn's reply", () => {
	const TEXT = "the request, word for word";

	test("a run keeps the user's text as the task, whatever the reply says", () => {
		expect(parseRouteReply('{"action":"run","task":"restated"}', TEXT)).toEqual({ action: "run", spec: { task: TEXT } });
		expect(parseRouteReply('{"action":"run"}', TEXT)).toEqual({ action: "run", spec: { task: TEXT } });
		expect(parseRouteReply('{"action":"run","mode":"loop"}', TEXT)).toEqual({ action: "run", spec: { task: TEXT } });
		expect(parseRouteReply('{"action":"run","until":"make","task":"x"}', TEXT)).toEqual({ action: "run", spec: { task: TEXT } });
	});

	test("stated limits land in the spec; another type or a bad number invalidates the reply", () => {
		expect(parseRouteReply('{"action":"run","rounds":3}', TEXT)).toEqual({ action: "run", spec: { task: TEXT, rounds: 3 } });
		expect(parseRouteReply('{"action":"run","minutes":30}', TEXT)).toEqual({ action: "run", spec: { task: TEXT, minutes: 30 } });
		expect(parseRouteReply('{"action":"run","rounds":3,"minutes":30}', TEXT)).toEqual({ action: "run", spec: { task: TEXT, rounds: 3, minutes: 30 } });
		expect(parseRouteReply('{"action":"run","rounds":null,"minutes":null}', TEXT)).toEqual({ action: "run", spec: { task: TEXT } });
		const invalid = [
			'{"action":"run","rounds":"3"}',
			'{"action":"run","rounds":0}',
			'{"action":"run","rounds":2.5}',
			'{"action":"run","rounds":21}',
			'{"action":"run","minutes":-1}',
			'{"action":"run","minutes":0}',
			'{"action":"run","minutes":1441}',
			'{"action":"run","minutes":"30"}',
		];
		for (const reply of invalid) expect(parseRouteReply(reply, TEXT)).toBeUndefined();
	});

	test("the object is found inside a code fence or a sentence", () => {
		expect(parseRouteReply('```json\n{"action":"status"}\n```', TEXT)).toEqual({ action: "status" });
		expect(parseRouteReply('Sure: {"action":"answer","text":"the reviewer is {b/r}"} done', TEXT)).toEqual({ action: "answer", text: "the reviewer is {b/r}" });
	});

	test("queries, answers and changes", () => {
		for (const action of ["status", "models", "agents", "menu", "resume"]) expect(parseRouteReply(JSON.stringify({ action }), TEXT)).toEqual({ action } as never);
		expect(parseRouteReply('{"action":"workers","role":"implementer","max":4}', TEXT)).toEqual({ action: "change", change: { action: "workers", role: "implementer", max: 4 } });
		expect(parseRouteReply('{"action":"quota","provider":" OpenAI "}', TEXT)).toEqual({ action: "change", change: { action: "quota", provider: "OpenAI" } });
	});

	test("anything else is invalid as a whole", () => {
		const invalid = [
			"",
			"I think this is a task.",
			"{not json}",
			"[1,2]",
			'{"action":"delete-everything"}',
			'{"action":"propose","config":{}}',
			'{"action":"setup"}',
			'{"action":"answer"}',
			'{"action":"answer","text":"  "}',
			'{"action":"workers","role":"implementer"}',
			'{"action":"workers","role":"boss","max":2}',
			'{"action":"workers","role":"implementer","max":"2"}',
			'{"action":"priority","priority":"speed"}',
			'{"action":"reselect"}',
			'{"action":"quota"}',
			'{"action":"trial","role":"reviewer"}',
			'{"action":"budget"}',
			'{"action":"budget","budgetUsd":5,"onExceed":"explode"}',
			'{"action":"settings"}',
			'{"action":"settings","docs":"off"}',
		];
		for (const reply of invalid) expect(parseRouteReply(reply, TEXT)).toBeUndefined();
	});

	test("parseChange keeps only the action's own fields", () => {
		expect(parseChange({ action: "priority", priority: "cost", role: "reviewer" })).toEqual({ action: "priority", priority: "cost" });
		expect(parseChange({ action: "reselect", role: "explorer", model: null })).toEqual({ action: "reselect", role: "explorer" });
		expect(parseChange({ action: "trial", role: "reviewer", model: " c/cand ", share: 0.3, days: 2 })).toEqual({ action: "trial", role: "reviewer", model: "c/cand", share: 0.3, days: 2 });
		expect(parseChange({ action: "budget", budgetUsd: 0 })).toEqual({ action: "budget", budgetUsd: 0 });
		expect(parseChange({ action: "settings", cleanup: true })).toEqual({ action: "settings", cleanup: true });
	});
});

describe("route: prompt", () => {
	test("the brief names every role with its models and worker range, the budget and the switches", async () => {
		const config: StormConfig = { ...structuredClone(base), budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "stop" }, disabledRoles: ["quick"], docs: false, rounds: 5 };
		const brief = teamBrief(await fakeHost({ config }).host.loadState());
		for (const part of ["explorer: a/x, b/z; workers", "implementer: a/i; workers 1-3", "reviewer: b/r", "$5.00", "stop", "quick", "docs off", "cleanup off", "rounds 5"]) expect(brief).toContain(part);
		expect(brief).not.toContain("NOT approved");
		expect(teamBrief(await fakeHost({ approved: false }).host.loadState())).toContain("NOT approved");
		expect(teamBrief(await fakeHost().host.loadState())).toContain("rounds 3");
	});

	test("the prompt carries the brief and the request, fenced, and stays compact", async () => {
		const brief = teamBrief(await fakeHost().host.loadState());
		const request = "set reviewer workers to 3";
		const prompt = buildRoutePrompt(request, brief);
		expect(prompt).toContain(brief);
		expect(prompt).toContain(`<storm-request>\n${request}\n</storm-request>`);
		expect(prompt.length - brief.length).toBeLessThanOrEqual(1900);
		expect(prompt).toContain('{"action":"resume"}');
		// The classifier is not told of shell conditions at all.
		expect(prompt).not.toContain('"until"');
		expect(prompt).not.toContain('"while"');
	});
});

/** A router over the fake project: every handler records its call; `sent` is what reached the main session. */
function router(opts: { reply?: string | Error | null; answers?: Answer[]; host?: FakeHostOptions; run?: RunRequestResult; change?: ActionReply } = {}) {
	const f = fakeHost(opts.host ?? {});
	const ui = scriptedUi(opts.answers ?? []);
	const calls: string[] = [];
	const sent: RunSpec[] = [];
	const changes: ChangeAction[] = [];
	const resumes: string[] = [];
	const prompts: string[] = [];
	const note = (name: string) => async () => {
		calls.push(name);
	};
	const handlers: RouteHandlers = {
		run: async spec => {
			calls.push("run");
			const result = opts.run ?? { ok: true, runId: "run-1" };
			// Only a started run sends anything: its handoff.
			if (result.ok) sent.push(spec);
			return result;
		},
		menu: note("menu"),
		status: note("status"),
		models: note("models"),
		agents: note("agents"),
		resume: async text => {
			calls.push("resume");
			resumes.push(text);
		},
		change: async change => {
			calls.push("change");
			changes.push(change);
			return opts.change ?? { outcome: "approved", text: "saved" };
		},
	};
	const reply = opts.reply;
	const route = (text: string) =>
		routeRequest(text, {
			ui: ui.ui,
			handlers,
			loadState: f.host.loadState,
			...(reply === null
				? {}
				: {
						sideTurn: async (prompt: string) => {
							prompts.push(prompt);
							if (reply instanceof Error) throw reply;
							return reply ?? "";
						},
					}),
		});
	return { route, ui, calls, sent, changes, resumes, prompts };
}

describe("route: execution", () => {
	test("a hub word alone opens the menu without a side turn", async () => {
		const r = router({ reply: '{"action":"status"}' });
		await r.route("review");
		expect(r.prompts).toEqual([]);
		expect(r.calls).toEqual(["menu"]);
		expect(r.sent).toEqual([]);
	});

	test("each classified action runs through its own handler, and only a run sends anything", async () => {
		const cases: Array<[reply: string, call: string]> = [
			['{"action":"status"}', "status"],
			['{"action":"models"}', "models"],
			['{"action":"agents"}', "agents"],
			['{"action":"menu"}', "menu"],
			['{"action":"resume"}', "resume"],
			['{"action":"budget","budgetUsd":5}', "change"],
			['{"action":"settings","docs":false}', "change"],
		];
		for (const [reply, call] of cases) {
			const r = router({ reply });
			await r.route("do something");
			expect(r.calls).toEqual([call]);
			expect(r.sent).toEqual([]);
			expect(r.prompts).toHaveLength(1);
			expect(r.ui.selects).toEqual([]);
		}
	});

	test("a change reaches its handler as parsed, and its result is shown", async () => {
		const r = router({ reply: '{"action":"workers","role":"reviewer","max":3}', change: { outcome: "rejected", text: "no" } });
		await r.route("reviewer workers 3");
		expect(r.changes).toEqual([{ action: "workers", role: "reviewer", max: 3 }]);
		expect(r.ui.notes).toEqual(["no"]);
	});

	test("an answer is shown in an overlay and touches nothing", async () => {
		const answer = "The reviewer runs b/r.";
		const r = router({ reply: JSON.stringify({ action: "answer", text: answer }) });
		await r.route("which model reviews?");
		expect(r.calls).toEqual([]);
		expect(r.sent).toEqual([]);
		expect(r.ui.reports.map(report => report.markdown)).toEqual([answer]);
	});

	test("work becomes a run with the user's text verbatim, with no dialog", async () => {
		const text = "fix the login bug\n  and add a test — 테스트도";
		const r = router({ reply: '{"action":"run","rounds":3,"task":"Fix login bug"}' });
		await r.route(text);
		expect(r.sent).toEqual([{ task: text, rounds: 3 }]);
		expect(r.ui.selects).toHaveLength(0);
		expect(r.prompts[0]).toContain(text);
	});

	test("a run with stated minutes lands the limit in the spec, still with no dialog", async () => {
		const r = router({ reply: '{"action":"run","minutes":30}' });
		await r.route("t");
		expect(r.sent).toEqual([{ task: "t", minutes: 30 }]);
		expect(r.ui.selects).toEqual([]);
	});

	test("a resume reaches its handler with the user's text, with no dialog", async () => {
		const text = "이어서 하되 X는 빼고";
		const r = router({ reply: '{"action":"resume"}' });
		await r.route(text);
		expect(r.calls).toEqual(["resume"]);
		expect(r.resumes).toEqual([text]);
		expect(r.sent).toEqual([]);
		expect(r.ui.selects).toEqual([]);
	});

	test("a quota mark the classifier proposed is confirmed before anything is written", async () => {
		const reply = '{"action":"quota","provider":"a"}';
		const marked = router({ reply, answers: [QUOTA_CHOICE.mark] });
		await marked.route("provider a ran out");
		expect(marked.ui.selects.map(s => s.options)).toEqual([[QUOTA_CHOICE.mark, QUOTA_CHOICE.cancel]]);
		expect(marked.changes).toEqual([{ action: "quota", provider: "a" }]);
		for (const answer of [QUOTA_CHOICE.cancel, undefined]) {
			const declined = router({ reply, answers: [answer] });
			await declined.route("provider a ran out");
			expect(declined.calls).toEqual([]);
			expect(declined.changes).toEqual([]);
		}
	});

	test("a refused run is reported, not retried", async () => {
		const r = router({ reply: '{"action":"run"}', run: { ok: false, reason: "run-active" } });
		await r.route("fix it");
		expect(r.calls).toEqual(["run"]);
		expect(r.sent).toEqual([]);
		expect(r.ui.notes).toHaveLength(1);
		expect(r.ui.notes[0]).toContain("run-active");
	});

	test("no side turn, a failed one or an invalid reply: one select with three options", async () => {
		for (const reply of [null, new Error("provider down"), "I would say this is a task.", '{"action":"propose"}']) {
			const cancelled = router({ reply, answers: [FALLBACK.cancel] });
			await cancelled.route("fix the bug");
			expect(cancelled.ui.selects.map(s => s.options)).toEqual([[FALLBACK.run, FALLBACK.menu, FALLBACK.cancel]]);
			expect(cancelled.calls).toEqual([]);
			expect(cancelled.sent).toEqual([]);

			const asTask = router({ reply, answers: [FALLBACK.run] });
			await asTask.route("fix the bug");
			expect(asTask.sent).toEqual([{ task: "fix the bug" }]);

			const menu = router({ reply, answers: [FALLBACK.menu] });
			await menu.route("fix the bug");
			expect(menu.calls).toEqual(["menu"]);

			// A host that cannot answer dialogs: nothing happens.
			const silent = router({ reply, answers: [undefined] });
			await silent.route("fix the bug");
			expect(silent.calls).toEqual([]);
		}
	});

	test("a provider token-limit rejection points to a new session without showing the request dump path", async () => {
		const r = router({
			reply: new Error('400 {"error":{"message":"prompt is too long: 7503601 tokens > 1000000"}} raw-http-request=/private/request.json'),
			answers: [FALLBACK.cancel],
		});
		await r.route("fix the bug");
		expect(r.ui.selects[0]?.title).toContain("/new");
		expect(r.ui.selects[0]?.title).not.toContain("raw-http-request");
		expect(r.calls).toEqual([]);
	});

	test("without a valid team the menu opens and no model is asked", async () => {
		const r = router({ reply: '{"action":"run"}', host: { config: null } });
		await r.route("fix the bug");
		expect(r.calls).toEqual(["menu"]);
		expect(r.prompts).toEqual([]);
	});
});

describe("changes: approval gate", () => {
	test("changes need a config", async () => {
		const f = fakeHost({ config: null });
		for (const change of CHANGES) expect((await run(f, change)).outcome).toBe("rejected");
		expect(f.saved).toEqual([]);
		expect(f.selects).toEqual([]);
	});

	test("every change is refused while the config is unapproved: no dialog, no analysis, nothing saved", async () => {
		const edited = structuredClone(base);
		edited.roles.reviewer!.models = ["z/unseen"];
		for (const f of [fakeHost({ approved: false }), fakeHost()]) {
			// The second host starts approved and is then edited by hand.
			f.setConfig(edited);
			for (const change of CHANGES) expect(await run(f, change)).toEqual({ outcome: "rejected", text: NEEDS_APPROVAL });
			expect(f.selects).toEqual([]);
			expect(f.prepares()).toBe(0);
			expect(f.saved).toEqual([]);
			expect(f.config()).toEqual(edited);
		}
	});

	test("an unapproved shadowing definition blocks changes like an unapproved config", async () => {
		const f = fakeHost();
		f.setShadows([{ agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project", sha256: "ab" }]);
		expect(await run(f, { action: "workers", role: "implementer", max: 2 })).toEqual({ outcome: "rejected", text: NEEDS_APPROVAL });
		expect(f.saved).toEqual([]);
	});

	test("with a real approval store: a workers change on a hand-edited config is rejected and nothing gets approved", async () => {
		const project = await makeProject();
		try {
			const load = () => loadProjectState(project.env);
			await approveAndSave(await load(), base, { shadowedAgents: [] });
			// A teammate's edit: another implementer model and parallelism, never approved here.
			const edited = structuredClone(base);
			edited.roles.implementer!.models = ["z/teammate"];
			edited.parallelism = 9;
			await writeFile(configPath(project.root), serializeConfig(edited));
			const f = scriptedUi([]);
			const host: ActionHost = { ...fakeHost().host, ui: f.ui, loadState: load, approveAndSave };
			const reply = await runChange(host, { action: "workers", role: "explorer", max: 3 });
			expect(reply).toEqual({ outcome: "rejected", text: NEEDS_APPROVAL });
			expect(f.selects).toEqual([]);
			const after = await load();
			expect(after.approval).toBeUndefined();
			expect((await after.store.list()).map(r => r.configHash)).toEqual([configHash(base)]);
			expect(await readFile(configPath(project.root), "utf8")).toBe(serializeConfig(edited));

			// Once the user has approved the file through /storm, the same change goes through.
			await after.store.approve({ configHash: configHash(edited), config: edited, scope: { shadowedAgents: [] } });
			const g = scriptedUi(["승인"]);
			const approved = await runChange({ ...host, ui: g.ui }, { action: "workers", role: "explorer", max: 3 });
			expect(approved.outcome).toBe("approved");
			expect(g.selects[0]?.markdown).not.toContain("z/teammate");
			const final = await load();
			expect(final.approval).toBeDefined();
			expect(final.config.status === "ok" && final.config.config.roles.explorer!.workers).toEqual({ min: 2, max: 3 });
		} finally {
			await project.remove();
		}
	});

	test("only the exact label approves; anything else, a host without dialogs included, changes nothing", async () => {
		for (const answer of [undefined, CANCEL, "later", `${APPROVE} `, "approve", `${APPROVE} and save`]) {
			const f = fakeHost({ answers: [answer] });
			const r = await run(f, { action: "workers", role: "implementer", max: 2 });
			expect(r.outcome).toBe("cancelled");
			expect(f.selects[0]?.options).toEqual([APPROVE, CANCEL]);
			expect(f.saved).toEqual([]);
			expect(f.config()).toEqual(base);
		}
	});

	test("approval saves through approveAndSave with the shadows seen, and reports the new short hash", async () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/repo/.omp/agents/storm-reviewer.md", scope: "project", sha256: "ab" };
		const f = fakeHost({ shadows: [shadow], answers: ["승인"] });
		const r = await run(f, { action: "workers", role: "reviewer", max: 4 });
		expect(r.outcome).toBe("approved");
		expect(r.text).toContain(shortHash(configHash(f.config())));
		expect(f.saved).toHaveLength(1);
		expect(f.saved[0]!.config.roles.reviewer!.workers).toEqual({ min: 1, max: 4 });
		expect(f.saved[0]!.baseHash).toBe(configHash(base));
		expect(f.saved[0]!.scope).toEqual({ shadowedAgents: [shadow] });
		expect(f.selects[0]?.markdown).toContain(shadow.path);
	});

	test("a config or shadow change during the dialog blocks the write", async () => {
		const g = fakeHost({
			answers: [
				() => {
					g.setConfig({ ...base, parallelism: 8 });
					return "승인";
				},
			],
		});
		expect((await run(g, { action: "workers", role: "implementer", max: 2 })).outcome).toBe("rejected");
		expect(g.saved).toEqual([]);
		const h = fakeHost({
			answers: [
				() => {
					h.setShadows([{ agent: "storm-reviewer", path: "/p", scope: "project", sha256: "cd" }]);
					return "승인";
				},
			],
		});
		expect((await run(h, { action: "workers", role: "implementer", max: 2 })).outcome).toBe("rejected");
		expect(h.saved).toEqual([]);
	});

	test("no-op change asks nothing", async () => {
		const f = fakeHost();
		const r = await run(f, { action: "workers", role: "implementer", max: 3 });
		expect(r.outcome).toBe("ok");
		expect(f.selects).toEqual([]);
		expect(f.saved).toEqual([]);
	});
});

describe("changes: priority and workers", () => {
	test("priority re-picks each role's models from the recommendation and keeps everything else", async () => {
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, { action: "priority", priority: "quality" });
		expect(r.outcome).toBe("approved");
		expect(f.saved[0]!.config).toEqual({
			...base,
			priority: "quality",
			roles: {
				explorer: { agent: "storm-explorer", models: ["a/x2:low", "b/z2:medium"] },
				implementer: { agent: "storm-implementer", models: ["a/i2", "c/j2:medium"], workers: { min: 1, max: 3 } },
				reviewer: { agent: "storm-reviewer", models: ["b/r2:high"] },
			},
		});
	});

	test("worker bounds and a role that is not configured", async () => {
		for (const [min, max] of [[0, 2], [1, 17], [2.5, 3], [3, 2]] as const) {
			expect((await run(fakeHost(), { action: "workers", role: "implementer", min, max })).outcome).toBe("rejected");
		}
		const cfg = structuredClone(base);
		delete cfg.roles.reviewer;
		const f = fakeHost({ config: cfg });
		expect((await run(f, { action: "workers", role: "reviewer", max: 2 })).outcome).toBe("rejected");
		expect(f.selects).toEqual([]);
	});

	test("a disabled role is refused with its own reason", async () => {
		const cfg = structuredClone(base);
		delete cfg.roles.reviewer;
		const missing = await run(fakeHost({ config: cfg }), { action: "workers", role: "reviewer", max: 2 });
		const disabled = await run(fakeHost({ config: { ...cfg, disabledRoles: ["reviewer"] } }), { action: "workers", role: "reviewer", max: 2 });
		expect(disabled.outcome).toBe("rejected");
		expect(disabled.text).not.toBe(missing.text);
	});

	test("one bound keeps the other, widening it when needed, and writes the range form", async () => {
		const f = fakeHost({ answers: ["승인", "승인"] });
		await run(f, { action: "workers", role: "reviewer", max: 3 });
		expect(f.config()!.roles.reviewer!.workers).toEqual({ min: 1, max: 3 });
		await run(f, { action: "workers", role: "reviewer", min: 5 });
		expect(f.config()!.roles.reviewer!.workers).toEqual({ min: 5, max: 5 });
	});
});

describe("changes: reselect", () => {
	test("named model goes first with the old primary's effort, else the role default it supports", async () => {
		const cfg = structuredClone(base);
		cfg.roles.implementer!.models = ["a/i:high"];
		const f = fakeHost({ config: cfg, answers: ["승인"] });
		const r = await run(f, { action: "reselect", role: "implementer", model: "c/j" });
		expect(r.outcome).toBe("approved");
		expect(f.saved[0]!.config.roles.implementer!.models).toEqual(["c/j:high", "a/i:high"]);

		const g = fakeHost({ answers: ["승인"] });
		await run(g, { action: "reselect", role: "reviewer", model: "c/cand" });
		expect(g.saved[0]!.config.roles.reviewer).toEqual({ agent: "storm-reviewer", models: ["c/cand:medium", "b/r:high"] });

		// Kept models carry the role effort they ran with as their own suffix, so dropping the role default changes nothing for them.
		const h = fakeHost({ answers: ["승인"] });
		await run(h, { action: "reselect", role: "explorer", model: "e/noeffort" });
		expect(h.saved[0]!.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["e/noeffort", "a/x:low", "b/z:low"] });

		// The old primary's own suffix wins over the role default; the moved model is matched by selector.
		const own = structuredClone(base);
		own.roles.explorer = { agent: "storm-explorer", models: ["a/x:high", "b/z:max"], effort: "low" };
		const k = fakeHost({ config: own, answers: ["승인"] });
		await run(k, { action: "reselect", role: "explorer", model: "b/z" });
		expect(k.saved[0]!.config.roles.explorer).toEqual({ agent: "storm-explorer", models: ["b/z:high", "a/x:high"] });
	});

	test("unusable and tool-less models are rejected unasked; a small context window is a warning in the dialog", async () => {
		for (const model of ["zz/none", "f/notools"]) {
			const f = fakeHost();
			expect((await run(f, { action: "reselect", role: "implementer", model })).outcome).toBe("rejected");
			expect(f.selects).toEqual([]);
		}
		const f = fakeHost({ answers: ["승인"] });
		expect((await run(f, { action: "reselect", role: "implementer", model: "d/small" })).outcome).toBe("approved");
		expect(f.selects[0]?.markdown).toContain("32,000");
		// A change that keeps every model within its role's floor carries no warning.
		const g = fakeHost({ answers: ["취소"] });
		await run(g, { action: "reselect", role: "implementer", model: "c/j" });
		expect(g.selects[0]?.markdown).not.toContain("32,000");
	});

	test("without a model the user picks; cancel or no UI changes nothing", async () => {
		for (const answer of ["취소", undefined]) {
			const f = fakeHost({ answers: [answer] });
			expect((await run(f, { action: "reselect", role: "explorer" })).outcome).toBe("cancelled");
			expect(f.saved).toEqual([]);
		}
		const f = fakeHost({ answers: [options => options[2], "승인"] });
		const r = await run(f, { action: "reselect", role: "explorer" });
		expect(f.selects[0]?.options).toHaveLength(4);
		expect(f.selects[0]?.options.filter(o => o.includes("a/x") || o.includes("a/y") || o.includes("b/z"))).toHaveLength(3);
		expect(r.outcome).toBe("approved");
		expect(f.saved[0]!.config.roles.explorer!.models).toEqual(["b/z:low", "a/x:low"]);
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
		expect(f.saved[0]!.config.trials?.map(t => t.id)).toEqual(["impl"]);
	});
});

describe("changes: quota", () => {
	const FIVE_HOURS = 5 * 3_600_000;
	const withFallbacks = (): StormConfig => {
		const cfg = structuredClone(base);
		cfg.roles.implementer!.models = ["a/i", "c/j"];
		return cfg;
	};

	test("all affected roles have approved fallbacks: mark only, no approval, also on an unapproved config", async () => {
		for (const approved of [true, false]) {
			const f = fakeHost({ config: withFallbacks(), approved });
			const r = await run(f, { action: "quota", provider: "a" });
			expect(r.outcome).toBe("ok");
			for (const part of ["a/x → b/z", "a/i → c/j"]) expect(r.text).toContain(part);
			// omp's quota view is unreadable here: the mark lasts five hours.
			expect(f.marks).toEqual([{ provider: "a", source: "user", markedAt: new Date(NOW).toISOString(), until: new Date(NOW + FIVE_HOURS).toISOString() }]);
			expect(f.selects).toEqual([]);
			expect(f.prepares()).toBe(0);
			expect(f.saved).toEqual([]);
		}
	});

	test("the mark lasts until omp's reset time when that is known and ahead", async () => {
		const until = async (quota: FakeHostOptions["quota"]) => {
			const f = fakeHost({ config: withFallbacks(), ...(quota ? { quota } : {}) });
			await run(f, { action: "quota", provider: "a" });
			return Date.parse(f.marks[0]!.until) - NOW;
		};
		const status = { state: "exhausted", usedFraction: 1 } as const;
		expect(await until([{ provider: "a", ...status, resetsAt: NOW + 90 * 60_000 }])).toBe(90 * 60_000);
		expect(await until([{ provider: "a", ...status, resetsAt: NOW + 30 * 3_600_000 }])).toBe(30 * 3_600_000);
		// Unknown, past, or another provider's reset: five hours.
		expect(await until([{ provider: "a", ...status, resetsAt: null }])).toBe(FIVE_HOURS);
		expect(await until([{ provider: "a", ...status, resetsAt: NOW - 1 }])).toBe(FIVE_HOURS);
		expect(await until([{ provider: "b", ...status, resetsAt: NOW + 60_000 }])).toBe(FIVE_HOURS);
		expect(await until([])).toBe(FIVE_HOURS);
	});

	test("the provider is matched without case, in the team, in omp's quota view and when ordering models", async () => {
		const cfg = withFallbacks();
		cfg.roles.explorer!.models = ["OpenAI/x", "b/z"];
		cfg.roles.implementer!.models = ["OpenAI/i", "c/j"];
		const f = fakeHost({ config: cfg, quota: [{ provider: "openai", state: "exhausted", usedFraction: 1, resetsAt: NOW + 60_000 }] });
		const r = await run(f, { action: "quota", provider: "OPENAI" });
		expect(r.outcome).toBe("ok");
		// Stored as the team spells it.
		expect(f.marks).toEqual([{ provider: "OpenAI", source: "user", markedAt: new Date(NOW).toISOString(), until: new Date(NOW + 60_000).toISOString() }]);
		expect(quotaPlan(cfg, "openai").map(p => [p.role, p.alternative])).toEqual([
			["explorer", "b/z"],
			["implementer", "c/j"],
		]);
		expect(orderByQuota(["OpenAI/x", "b/z"], [{ ...f.marks[0]!, provider: "openAI" }])).toEqual(["b/z", "OpenAI/x"]);
	});

	test("roles without a fallback get a proposal adding one off the provider", async () => {
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, { action: "quota", provider: "A" });
		expect(r.outcome).toBe("approved");
		expect(f.marks).toHaveLength(1);
		expect(f.saved[0]!.config.roles.implementer!.models).toEqual(["a/i", "c/j:medium"]);
		expect(f.saved[0]!.config.roles.explorer).toEqual(base.roles.explorer!);

		const g = fakeHost({ answers: [undefined] });
		expect((await run(g, { action: "quota", provider: "a" })).outcome).toBe("cancelled");
		expect(g.saved).toEqual([]);

		// On an unapproved config the mark stands but the fallback proposal is refused.
		const h = fakeHost({ approved: false });
		expect((await run(h, { action: "quota", provider: "a" })).outcome).toBe("rejected");
		expect(h.marks).toHaveLength(1);
		expect(h.selects).toEqual([]);
		expect(h.saved).toEqual([]);
	});

	test("no candidate off the provider is rejected; unused provider is a no-op", async () => {
		const f = fakeHost();
		expect((await run(f, { action: "quota", provider: "b" })).outcome).toBe("rejected");
		expect(f.saved).toEqual([]);
		const g = fakeHost();
		expect((await run(g, { action: "quota", provider: "zzz" })).outcome).toBe("ok");
		expect(g.marks).toEqual([]);
	});
});

describe("changes: trial, budget and settings", () => {
	test("builds a bounded trial with defaults and replaces the role's previous one", async () => {
		const f = fakeHost({ answers: ["승인"] });
		const r = await run(f, { action: "trial", role: "reviewer", model: "c/cand" });
		expect(r.outcome).toBe("approved");
		expect(f.saved[0]!.config.trials).toEqual([
			{
				id: trialId("reviewer", "c/cand", NOW),
				role: "reviewer",
				model: "c/cand",
				effort: "medium",
				share: 0.5,
				maxSpawns: 20,
				startsAt: new Date(NOW).toISOString(),
				endsAt: new Date(NOW + 7 * 86_400_000).toISOString(),
				budgetUsd: 2,
			},
		]);

		const g = fakeHost({ config: f.config(), answers: ["승인"] });
		await run(g, { action: "trial", role: "reviewer", model: "c/j", share: 0.25, maxSpawns: 5, days: 3, budgetUsd: 1 });
		expect(g.saved[0]!.config.trials!.map(x => [x.model, x.share, x.maxSpawns, x.budgetUsd, x.effort])).toEqual([["c/j", 0.25, 5, 1, "high"]]);
	});

	test("trial bounds and model checks", async () => {
		const trial = { action: "trial", role: "reviewer", model: "c/cand" } as const;
		const bad: ChangeAction[] = [
			{ ...trial, share: 0 },
			{ ...trial, share: 1.5 },
			{ ...trial, maxSpawns: 0 },
			{ ...trial, maxSpawns: 1001 },
			{ ...trial, days: 0 },
			{ ...trial, days: 31 },
			{ ...trial, budgetUsd: 0 },
			{ ...trial, model: "b/r" },
			{ ...trial, model: "f/notools" },
			{ ...trial, model: "zz/none" },
		];
		for (const change of bad) {
			const f = fakeHost();
			expect((await run(f, change)).outcome).toBe("rejected");
			expect(f.selects).toEqual([]);
		}
	});

	test("budget: set with default warning, remove, and reject a bad warning", async () => {
		const f = fakeHost({ answers: ["승인", "승인"] });
		expect((await run(f, { action: "budget", budgetUsd: 5, onExceed: "stop" })).outcome).toBe("approved");
		expect(f.config()!.budget).toEqual({ perRunUsd: 5, warnAtUsd: 4, onExceed: "stop" });
		expect((await run(f, { action: "budget", budgetUsd: 0 })).outcome).toBe("approved");
		expect(f.config()!.budget).toBeUndefined();
		expect((await run(f, { action: "budget", budgetUsd: 5, warnAtUsd: 6 })).outcome).toBe("rejected");
		expect((await run(f, { action: "budget", budgetUsd: 0 })).outcome).toBe("rejected");
	});

	test("switches are saved only when they leave their default", async () => {
		const f = fakeHost({ answers: ["승인", "승인"] });
		expect((await run(f, { action: "settings", cleanup: true, docs: false })).outcome).toBe("approved");
		expect(f.config()).toEqual({ ...base, cleanup: true, docs: false });
		expect((await run(f, { action: "settings", cleanup: false, docs: true })).outcome).toBe("approved");
		expect(f.config()).toEqual(base);
	});
});
