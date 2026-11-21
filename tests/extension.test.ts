/**
 * The extension's own wiring: every hook, the /storm command and the storm tool registered on a fake omp, with real
 * project files below a temp dir. As in omp, the main session and each subagent session load the extension
 * separately and share its module state.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { writeConfig } from "../src/config/store.ts";
import { prepareAnalysis } from "../src/context.ts";
import storm from "../src/extension.ts";
import { approveAndSave } from "../src/flows.ts";
import { docPromptFor } from "../src/policy/docs.ts";
import { listAgents, resetAgents } from "../src/runtime/agents.ts";
import { activeLedgerRun, resetLedger } from "../src/runtime/ledger.ts";
import { ROUND_DELAY_MS } from "../src/runtime/rounds.ts";
import { lastRun } from "../src/runtime/run.ts";
import { readTrialStates } from "../src/runtime/state-files.ts";
import { resetTrialSpawns } from "../src/runtime/trials.ts";
import { loadProjectState } from "../src/state.ts";
import type { StormConfig, TrialConfig } from "../src/types.ts";
import { until } from "./fake-session.ts";
import { makeProject, scriptedUi, TEAM, type TestProject } from "./support.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface Agent {
	kind: "main" | "sub";
	id: string;
	name: string;
	parentId?: string;
}
interface Tool {
	name: string;
	execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ details: { outcome: string } }>;
}

/** One session's omp as the extension sees it. Only `git` really runs; the `omp` CLI fails, as in `makeProject`. */
function fakeOmp(project: TestProject) {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	/** Transcript messages (notices and records outside the TUI); none of them reaches the model. */
	const transcript: unknown[] = [];
	let active = ["read", "write"];
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let tool: Tool | undefined;
	/** Set to make every state load fail, as a broken profile would. */
	const broken = { agentDir: false };
	/** Times a handler waited for the session to go idle. */
	const waits = { idle: 0 };
	const pi = {
		exec: project.env.exec,
		pi: {
			getAgentDir: () => {
				if (broken.agentDir) throw new Error("agent dir unavailable");
				return project.env.agentDir;
			},
		},
		zod,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendUserMessage: async (message: unknown) => {
			sent.push(String(message));
		},
		sendMessage: (message: unknown) => {
			transcript.push(message);
		},
		getActiveTools: () => active,
		setActiveTools: async (tools: string[]) => {
			active = tools;
		},
		registerTool: (definition: Tool) => {
			tool = definition;
		},
		registerCommand: (_name: string, definition: { handler: NonNullable<typeof command> }) => {
			command = definition.handler;
		},
		registerMessageRenderer: () => undefined,
	};
	storm(pi as unknown as ExtensionAPI);
	const ctx = (agent: Agent): ExtensionContext =>
		({
			cwd: project.root,
			hasUI: true,
			mode: "rpc",
			agent,
			isIdle: () => true,
			hasPendingMessages: () => false,
			ui: {
				notify: (text: string, level = "info") => notices.push({ text, level }),
				select: async () => undefined,
				confirm: async () => false,
				input: async () => undefined,
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				getEditorText: () => "",
			},
			getContextUsage: () => undefined,
			compact: async () => undefined,
			abort: () => undefined,
			waitForIdle: async () => {
				waits.idle++;
			},
			modelRegistry: { getAll: () => [], getAvailable: () => [] },
			runEphemeralTurn: async () => ({ replyText: '{"action":"run"}' }),
		}) as unknown as ExtensionContext;
	return {
		sent,
		notices,
		statuses,
		transcript,
		waits,
		broken,
		ctx,
		activeTools: () => active,
		/** Fires an omp event; the first handler result that is not undefined is omp's answer. */
		emit: async (event: string, payload: unknown, on: ExtensionContext): Promise<unknown> => {
			let answer: unknown;
			for (const handler of handlers.get(event) ?? []) answer ??= await handler(payload, on);
			return answer;
		},
		command: (args: string, on: ExtensionContext) => {
			if (!command) throw new Error("the /storm command is not registered");
			return command(args, on);
		},
		tool: async (params: unknown, on: ExtensionContext): Promise<string> => {
			if (!tool) throw new Error("the storm tool is not registered");
			return (await tool.execute("call-1", params, undefined, undefined, on)).details.outcome;
		},
	};
}

const MAIN: Agent = { kind: "main", id: "Main", name: "main" };
const sub = (id: string, name = "storm-implementer"): Agent => ({ kind: "sub", id, name, parentId: "Main" });
const spawnOf = (agent: string, spawnKey: string, patterns: string[] = []) => ({ agent, invocationKind: "task", patterns, spawnKey });
const assistant = (provider: string, model: string, input: number, usd: number) => ({
	message: { role: "assistant", provider, model, usage: { input, cacheRead: 0, cacheWrite: 0, cost: { total: usd } } },
});
/** The `[storm:<code>]` a hook answered with, "pass" when it let the call through, or the routed models. */
function verdict(answer: unknown): string {
	if (answer === undefined) return "pass";
	if (typeof answer !== "object" || answer === null) return "?";
	if ("block" in answer && "reason" in answer) return /^\[storm:([a-z-]+)\] /.exec(String(answer.reason))?.[1] ?? "block without a code";
	return "model" in answer && Array.isArray(answer.model) ? `route:${answer.model.join(",")}` : "?";
}

let project: TestProject;

beforeEach(async () => {
	project = await makeProject();
});

afterEach(async () => {
	vi.useRealTimers();
	setSystemTime();
	resetLedger();
	resetAgents();
	resetTrialSpawns();
	await project.remove();
});

const approve = async (config: StormConfig) => approveAndSave(await loadProjectState(project.env), config, { shadowedAgents: [] });

describe("a run through the hooks", () => {
	test("/storm <text> starts it; director rules, spawn policy and the counters hold until the session settles", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "big.md"), "line\n".repeat(10_000));
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		const edit = { toolName: "edit", input: { path: "src/a.ts" } };

		// Before a run the main session is an ordinary one.
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		await omp.command("fix the bug", main);
		expect(omp.sent).toHaveLength(1);
		expect(omp.activeTools()).toContain("storm");
		expect(omp.statuses.at(-1)).toBeDefined();
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.repoId)?.runId;
		expect(runId).toBeDefined();

		// The director does not edit, notes and control stay open, and a subagent edits freely.
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("director-edit");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "local://notes.md" } }, main))).toBe("pass");
		expect(verdict(await child.emit("tool_call", edit, impl))).toBe("pass");

		// Spawns wait for a plan, then follow it.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("no-plan");
		expect(await omp.tool({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main)).toBe("ok");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("route:a/i");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-reviewer", "Rev"), main))).toBe("role-not-in-plan");
		// A spawn decided in a subagent's session sees the same run: the plan's one implementer slot is taken.
		expect(verdict(await child.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl2"), impl))).toBe("role-cap");

		// The subagent's first turn registers it under the run and brings its role's doc rules.
		const section = docPromptFor("storm-implementer", TEAM);
		expect(await child.emit("before_agent_start", { systemPrompt: ["base"] }, impl)).toEqual({ systemPrompt: ["base", section] });
		expect(await child.emit("before_agent_start", { systemPrompt: ["base", section] }, impl)).toBeUndefined();
		expect(listAgents({ runId: runId as string }).map(agent => agent.id)).toEqual(["Impl"]);

		// A wide range of a big file the subagent read is not read again by the director; a small range of it is.
		const wide = { toolName: "read", input: { path: "big.md:1-5000" } };
		expect(verdict(await omp.emit("tool_call", wide, main))).toBe("pass");
		await child.emit("tool_call", { toolName: "read", input: { path: "big.md" } }, impl);
		expect(verdict(await omp.emit("tool_call", wide, main))).toBe("read-large");
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "big.md:1-20" } }, main))).toBe("pass");
		await omp.emit("tool_result", { toolName: "read", input: { path: "big.md:1-20" }, isError: false, content: [{ type: "text", text: "x".repeat(100) }] }, main);
		await omp.emit("tool_result", { toolName: "read", input: { path: "README.md" }, isError: false, content: [{ type: "text", text: "x".repeat(300) }] }, main);
		await omp.emit("tool_result", { toolName: "read", input: { path: "gone.md" }, isError: true, content: [{ type: "text", text: "x".repeat(999) }] }, main);

		// Spend: the subagent's and the director's both count toward the run; only the director's is the main cost.
		await child.emit("message_end", assistant("a", "i", 30_000, 0.5), impl);
		await omp.emit("message_end", assistant("m", "main", 50_000, 0.25), main);
		await omp.emit("message_end", { message: { role: "user" } }, main);

		// Follow-ups count when delivered; progress notes and failed writes do not.
		const followUp = (target: string, isError = false) => omp.emit("tool_result", { toolName: "write", input: { path: target }, isError, content: [] }, main);
		await followUp("agent://Impl");
		await followUp("agent://impl");
		await followUp("agent://Impl?progress");
		await followUp("agent://Impl", true);
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, impl);
		await child.emit("agent_end", {}, impl);

		// The run ends when the main session settles after its handoff turn, not while it waits on subagents.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", { awaitingAsyncWork: true }, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeDefined();
		// A subagent's result resumes the paused run with a new turn.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeUndefined();

		const record = await lastRun(project.root);
		expect(record).toMatchObject({
			runId: runId as string,
			status: "done",
			endReason: "settled",
			turns: 1,
			costUsd: 0.75,
			mainCostUsd: 0.25,
			maxMainContext: 50_000,
			blockedEdits: 1,
			reads: { director: 2, directorChars: 400, duplicateChars: 100, blocked: 1 },
			plan: { lanes: [{ name: "fix", kind: "code", role: "implementer" }] },
		});
		expect(record?.spawns.map(spawn => spawn.code ?? spawn.outcome)).toEqual(["no-plan", "routed", "role-not-in-plan", "role-cap"]);
		expect(record?.agents).toMatchObject([{ id: "Impl", role: "implementer", state: "idle", followUps: 2, costUsd: 0.5, contextTokens: 30_000, review: { reviews: 1, passed: 1 } }]);

		// Afterwards the main session is ordinary again.
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["x/unapproved"]), main))).toBe("pass");
	});

	test("a subagent's change brings a round from Storm; a correct verdict after it ends the run verified", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		await omp.command("task", main);
		expect(omp.sent).toHaveLength(1);
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);

		vi.useFakeTimers();
		const changedAt = Date.now();
		setSystemTime(new Date(changedAt));
		await child.emit("tool_result", { toolName: "edit", input: { path: "src/a.ts" }, isError: false, content: [] }, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		// The handler returns without sending: the round waits out the delay.
		expect(omp.sent).toHaveLength(1);
		vi.advanceTimersByTime(ROUND_DELAY_MS);
		await until(() => omp.sent.length === 2);
		expect(omp.sent[1]?.split("\n")[0]).toContain('round="2/4"');
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeDefined();

		setSystemTime(new Date(changedAt + 1_000));
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeUndefined();
		expect(await lastRun(project.root)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("a reused live agent belongs to the next run: its read, its edit and the reviewer's verdict all count", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "big.md"), "line\n".repeat(10_000));
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		const edit = { toolName: "edit", input: { path: "src/a.ts" }, isError: false, content: [] };
		const yielded = { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] };

		// First run: the agents register through before_agent_start, as a spawn does.
		await omp.command("first task", main);
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		const first = Date.now();
		setSystemTime(new Date(first));
		await child.emit("tool_result", edit, impl);
		setSystemTime(new Date(first + 1_000));
		await child.emit("tool_result", yielded, rev);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "done", endReason: "verified", turns: 1 });

		// Second run, same session: omp emits no before_agent_start for these live agents.
		vi.useFakeTimers();
		const second = first + 60_000;
		setSystemTime(new Date(second));
		await omp.command("second task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.repoId)?.runId;
		expect(runId).toBeDefined();
		// The read is indexed under the new run: the director's wide read of the same file is blocked.
		await child.emit("tool_call", { toolName: "read", input: { path: "big.md" } }, impl);
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "big.md:1-5000" } }, main))).toBe("read-large");
		// The edit lands in the new run's gate, so the first round stays open for a verdict.
		await child.emit("tool_result", edit, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeDefined();
		// The reused reviewer's verdict counts in the new run too.
		setSystemTime(new Date(second + 1_000));
		await child.emit("tool_result", yielded, rev);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ runId: runId as string, status: "done", endReason: "verified", turns: 2 });
	});

	test("a pending round wait does not send after a session switch", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.command("task", main);
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		vi.useFakeTimers();
		await child.emit("tool_result", { toolName: "edit", input: { path: "src/a.ts" }, isError: false, content: [] }, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.sent).toHaveLength(1);
		await omp.emit("session_switch", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "stopped", endReason: "shutdown" });
		vi.advanceTimersByTime(ROUND_DELAY_MS * 2);
		expect(omp.sent).toHaveLength(1);
	});

	test("the same run without a file change settles after one round", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		await child.emit("before_agent_start", { systemPrompt: [] }, child.ctx(sub("Impl")));
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.sent).toHaveLength(1);
		expect(await lastRun(project.root)).toMatchObject({ status: "done", endReason: "settled", turns: 1 });
	});

	test("a follow-up to an agent past its cap is refused and counted; one below it passes", async () => {
		await approve({ ...TEAM, contextCap: 20_000 });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		for (const [id, tokens] of [["Big", 20_000], ["Small", 19_999]] as const) {
			const ctx = child.ctx(sub(id));
			await child.emit("before_agent_start", { systemPrompt: [] }, ctx);
			await child.emit("message_end", assistant("a", "i", tokens, 0), ctx);
		}
		const write = (target: string) => omp.emit("tool_call", { toolName: "write", input: { path: target } }, main);
		expect(verdict(await write("agent://Big"))).toBe("followup-cap");
		expect(verdict(await write("agent://Small"))).toBe("pass");
		expect(verdict(await write("agent://Nobody"))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "stopped", endReason: "shutdown", blockedFollowUps: 1 });
	});

	test("a run the tool queues starts only when the turn settles; a subagent session closing does not end it", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.emit("session_start", {}, main);
		expect(omp.activeTools()).toContain("storm");
		expect(await omp.tool({ action: "run", task: "do it" }, main)).toBe("queued");
		expect(await omp.tool({ action: "run", task: "again" }, main)).toBe("rejected");
		await omp.emit("agent_end", { willContinue: true }, main);
		expect(omp.sent).toEqual([]);
		await omp.emit("agent_end", {}, main);
		await until(() => omp.sent.length > 0);
		expect(omp.sent).toHaveLength(1);

		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("session_shutdown", {}, impl);
		expect(listAgents()[0]).toMatchObject({ id: "Impl", state: "parked" });
		expect(await lastRun(project.root)).toBeUndefined();
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeDefined();
		await omp.emit("session_shutdown", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "stopped", endReason: "shutdown" });
	});

	test("a subagent session gets no storm tool and no status line", async () => {
		await approve(TEAM);
		const child = fakeOmp(project);
		await child.emit("session_start", {}, child.ctx(sub("Impl")));
		expect(child.activeTools()).not.toContain("storm");
		expect(child.statuses).toEqual([]);
	});
});

describe("a subagent's tool results on the ledger", () => {
	test("successful file changes count; failed changes, reads, notes and the main session do not", async () => {
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		const result = (toolName: string, input: unknown, isError = false) =>
			child.emit("tool_result", { toolName, input, isError, content: [] }, impl);

		await result("edit", { path: "src/a.ts" });
		await result("write", { path: "src/b.ts" });
		await result("edit", { path: "src/c.ts" }, true);
		await result("read", { path: "src/a.ts" });
		await result("write", { path: "local://x.md" });
		await omp.emit("tool_result", { toolName: "edit", input: { path: "src/d.ts" }, isError: false, content: [] }, main);

		expect(listAgents()).toHaveLength(1);
		expect(listAgents()[0]).toMatchObject({ id: "Impl", changes: 2 });
		expect(listAgents()[0]?.lastChangeAt).toBeGreaterThan(0);
	});
});

describe("the spawn hook", () => {
	const T0 = Date.parse("2026-11-20T09:00:00Z");
	const implementer = spawnOf("storm-implementer", "Impl");

	test("outside a run it decides storm-* agents only, by the team on disk", async () => {
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["x/any"]), main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("no-config");
	});

	test("the approval it checks is at most 2 s old: an edit after approval blocks spawns from then on", async () => {
		setSystemTime(new Date(T0));
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("route:a/i");
		await writeConfig(project.root, { ...TEAM, parallelism: 9 });
		setSystemTime(new Date(T0 + 1_999));
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("route:a/i");
		setSystemTime(new Date(T0 + 2_000));
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("unapproved");
	});

	test("/storm <work> during a run is refused at once, without waiting for a session that stays busy until the run ends", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("first work", main);
		expect(omp.waits.idle).toBe(1);
		const before = omp.transcript.length + omp.notices.length;
		await omp.command("second work", main);
		expect(omp.waits.idle).toBe(1);
		expect(omp.sent).toHaveLength(1);
		// The user is told once, wherever this host shows notices.
		expect(omp.transcript.length + omp.notices.length).toBe(before + 1);
		await omp.emit("session_shutdown", {}, main);
	});

	test("a failure while deciding blocks storm-* agents, and every agent during a run", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		omp.broken.agentDir = true;
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("internal");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["a/i"]), main))).toBe("internal");
		omp.broken.agentDir = false;
		await omp.emit("session_shutdown", {}, main);
		// Outside a run other agents stay omp's business even then.
		omp.broken.agentDir = true;
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("internal");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["a/i"]), main))).toBe("pass");
	});

	test("a trial is counted per spawn of its role, and charged only for the routed subagent on the candidate model", async () => {
		setSystemTime(new Date(T0));
		const trial: TrialConfig = { id: "t1", role: "implementer", model: "c/cand", share: 0.5, maxSpawns: 5, startsAt: new Date(T0 - 1000).toISOString(), endsAt: new Date(T0 + 86_400_000).toISOString(), budgetUsd: 5 };
		await approve({ ...TEAM, trials: [trial] });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		// Half of the role's spawns go to the candidate, the role's own models behind it.
		const routes = [];
		for (const key of ["A", "B", "C", "D"]) routes.push(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", key), main)));
		expect(routes).toEqual(["route:a/i", "route:c/cand,a/i", "route:a/i", "route:c/cand,a/i"]);
		await omp.emit("before_subagent_spawn", spawnOf("storm-reviewer", "R"), main);
		expect((await readTrialStates(project.root)).t1).toMatchObject({ seen: 4, routed: 2, costUsd: 0 });

		await child.emit("message_end", assistant("c", "cand", 1000, 0.4), child.ctx(sub("B")));
		// Not charged: a subagent that was not routed to the trial, the routed one on the role's own model, the main session.
		await child.emit("message_end", assistant("c", "cand", 1000, 9), child.ctx(sub("A")));
		await child.emit("message_end", assistant("a", "i", 1000, 9), child.ctx(sub("B")));
		await omp.emit("message_end", assistant("c", "cand", 1000, 9), main);
		expect((await readTrialStates(project.root)).t1).toMatchObject({ seen: 4, routed: 2, costUsd: 0.4 });
	});
});

describe("what the wiring adds around a run", () => {
	test("a spawn decision that failed during a run is in the run's spawn records, with its code", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		omp.broken.agentDir = true;
		await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl", ["a/i"]), main);
		omp.broken.agentDir = false;
		await omp.emit("session_shutdown", {}, main);
		expect((await lastRun(project.root))?.spawns).toMatchObject([
			{ agent: "storm-implementer", invocationKind: "task", requested: ["a/i"], outcome: "blocked", code: "internal", spawnKey: "Impl" },
		]);
	});

	test("a run the tool queued is dropped when the user interrupts that turn", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		expect(await omp.tool({ action: "run", task: "do it" }, main)).toBe("queued");
		await omp.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, main);
		await omp.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, main);
		expect(omp.sent).toEqual([]);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeUndefined();
		// The queue is free again.
		expect(await omp.tool({ action: "run", task: "again" }, main)).toBe("queued");
	});

	test("the router's side turn: omp journals it outside a run, the run's ledger takes it inside one", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		interface SideTurn {
			purpose?: string;
			tools?: unknown;
			onUsage?: (message: unknown) => void;
		}
		const turns: SideTurn[] = [];
		const replies = ['{"action":"answer","text":"ok"}', '{"action":"run"}', '{"action":"answer","text":"ok"}'];
		const main = {
			...omp.ctx(MAIN),
			runEphemeralTurn: async (options: SideTurn) => {
				turns.push(options);
				return { replyText: replies[turns.length - 1] ?? '{"action":"answer","text":"ok"}' };
			},
		} as unknown as ExtensionContext;
		const repoId = (await loadProjectState(project.env)).repo.repoId;

		await omp.command("which model reviews?", main);
		expect(turns).toHaveLength(1);
		// omp writes the journal entry itself only when the caller takes no usage callback.
		expect(turns[0]).toMatchObject({ purpose: "storm" });
		expect(turns[0]?.onUsage).toBeUndefined();
		expect(turns[0] && "tools" in turns[0]).toBe(false);
		expect(omp.sent).toEqual([]);

		await omp.command("do the work", main);
		await omp.command("which model reviews?", main);
		expect(turns).toHaveLength(3);
		turns[2]?.onUsage?.(assistant("m", "main", 40_000, 0.2).message);
		await until(() => activeLedgerRun(repoId)?.costUsd === 0.2);
		// Only the run's handoff ever reached the session.
		expect(omp.sent).toHaveLength(1);
		await omp.emit("session_shutdown", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ costUsd: 0.2, mainCostUsd: 0.2 });
	});

	test("/new, /resume or a fork during a run ends it: the handoff is not in the conversation that follows", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const edit = { toolName: "edit", input: { path: "src/a.ts" } };
		await omp.command("task", main);
		// A subagent's own session switching is not the run's business.
		await child.emit("session_switch", { reason: "new" }, child.ctx(sub("Impl")));
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("director-edit");
		await omp.emit("session_switch", { reason: "new" }, main);
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.repoId)).toBeUndefined();
		expect(await lastRun(project.root)).toMatchObject({ status: "stopped", endReason: "shutdown" });
	});

	test("every /storm command the user types starts on a fresh analysis", async () => {
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const before = prepareAnalysis(project.env, scriptedUi().ui);
		expect(prepareAnalysis(project.env, scriptedUi().ui)).toBe(before);
		await omp.command("status", main);
		expect(prepareAnalysis(project.env, scriptedUi().ui)).not.toBe(before);
	});
});
