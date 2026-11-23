/**
 * The extension's own wiring: every hook, the /storm command and the storm tool registered on a fake omp, with real
 * project files below a temp dir. As in omp, the main session and each subagent session load the extension
 * separately and share its module state.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readAutoDelegation, writeAutoDelegation } from "../src/approval/auto.ts";
import { writeConfig } from "../src/config/store.ts";
import { prepareAnalysis } from "../src/context.ts";
import storm from "../src/extension.ts";
import { approveAndSave } from "../src/flows.ts";
import { docPromptFor } from "../src/policy/docs.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { listAgents, resetAgents } from "../src/runtime/agents.ts";
import { rememberCloseoutReport, resetCloseoutChoices } from "../src/runtime/closeout.ts";
import { activeLedgerRun, bindLedgerChild, resetLedger } from "../src/runtime/ledger.ts";
import { processKey } from "../src/runtime/janitor.ts";
import { ROUND_DELAY_MS } from "../src/runtime/rounds.ts";
import { lastRun, readRun, writeRun } from "../src/runtime/run.ts";
import { noteResumePointer } from "../src/runtime/resume.ts";
import { readTrialStates } from "../src/runtime/state-files.ts";
import { resetTrialSpawns } from "../src/runtime/trials.ts";
import { treeAgainst } from "../src/runtime/tree.ts";
import { loadProjectState } from "../src/state.ts";
import { STORM_MARK } from "../src/view/appearance.ts";
import type { StormConfig, TrialConfig } from "../src/types.ts";
import { until } from "./fake-session.ts";
import { DEAD_PROCESS, runRecord } from "./fixtures.ts";
import { git, gitRepo, makeProject, scriptedUi, TEAM, type TestProject } from "./support.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface Agent {
	kind: "main" | "sub";
	id: string;
	name: string;
	parentId?: string;
}
interface Tool {
	name: string;
	execute(
		id: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{ details: { outcome: string }; content?: Array<{ type: string; text?: string }> }>;
}

/** One session's omp as the extension sees it. Only `git` really runs; the `omp` CLI fails, as in `makeProject`. */
function fakeOmp(project: TestProject) {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	/** Answers to the next dialogs, by position; empty means the user dismissed them. */
	const answers: Array<string | undefined | ((options: string[]) => string | undefined)> = [];
	/** Every select dialog this session opened, so a guard can prove nothing was asked. */
	const selects: Array<{ title: string; options: string[] }> = [];
	/** Transcript messages (notices and records outside the TUI); none of them reaches the model. */
	const transcript: unknown[] = [];
	let active = ["read", "write"];
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let tool: Tool | undefined;
	/** What this fake session reports as context usage; tests set it before a turn. */
	const usage: { current?: { tokens: number; contextWindow: number; percent: number } } = {};
	/** Background checkpoints the extension asked for; held when `holdCompactions.value` is set. */
	const compactions: Array<{ options: CompactOptions; complete(): void; fail(error?: Error): void }> = [];
	const holdCompactions = { value: false };
	/** Set to make every state load fail, as a broken profile would. */
	const broken = { agentDir: false };
	/** Times a handler waited for the session to go idle. */
	const waits = { idle: 0 };
	/** Whether this fake session reports itself idle; input guards read it. */
	const idle = { value: true };
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
			isIdle: () => idle.value,
			hasPendingMessages: () => false,
			ui: {
				notify: (text: string, level = "info") => notices.push({ text, level }),
				select: async (title: string, options: string[]) => {
					selects.push({ title, options });
					const answer = answers.shift();
					return typeof answer === "function" ? answer(options) : answer;
				},
				confirm: async () => false,
				input: async () => undefined,
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				getEditorText: () => "",
			},
			getContextUsage: () => usage.current,
			compact: (optionsOrInstructions: string | CompactOptions | undefined) => {
				// A bare string is the run preflight's foreground compaction; only checkpoint options are captured.
				if (typeof optionsOrInstructions !== "object") return Promise.resolve();
				const options = optionsOrInstructions;
				const wait = Promise.withResolvers<void>();
				const call = {
					options,
					complete: (): void => {
						options.onComplete?.({} as never);
						wait.resolve();
					},
					fail: (error?: Error): void => {
						const failure = error ?? new Error("compaction failed");
						options.onError?.(failure);
						wait.reject(failure);
					},
				};
				compactions.push(call);
				if (!holdCompactions.value) call.complete();
				return wait.promise;
			},
			abort: () => undefined,
			waitForIdle: async () => {
				waits.idle++;
			},
			modelRegistry: { getAll: () => [], getAvailable: () => [] },
			sessionManager: {
				getArtifactsDir: () => project.root,
				getSessionDir: () => path.join(project.tmp, "sessions"),
				getSessionId: () => `session-${agent.id}`,
			},
			runEphemeralTurn: async () => ({ replyText: '{"action":"run"}' }),
		}) as unknown as ExtensionContext;
	return {
		sent,
		notices,
		statuses,
		answers,
		selects,
		transcript,
		waits,
		idle,
		broken,
		usage,
		compactions,
		holdCompactions,
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
		toolReply: async (params: unknown, on: ExtensionContext): Promise<{ outcome: string; text: string }> => {
			if (!tool) throw new Error("the storm tool is not registered");
			const reply = await tool.execute("call-1", params, undefined, undefined, on);
			return { outcome: reply.details.outcome, text: reply.content?.find(part => part.type === "text")?.text ?? "" };
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
	resetCloseoutChoices();
	await project.remove();
});

const approve = async (config: StormConfig) => approveAndSave(await loadProjectState(project.env), config, { shadowedAgents: [] });

/** Writes this profile/repository's durable automatic-delegation opt-in; returns its store dir for later changes. */
const enableAuto = async (): Promise<string> => {
	const dir = (await loadProjectState(project.env)).store.dir;
	await writeAutoDelegation(dir, true);
	return dir;
};

/** Tests drive child sessions directly; bind one exactly as an admitted parent spawn would. */
const admitChild = (runId: string | undefined, id: string): void => {
	if (runId === undefined) throw new Error("test needs an active run");
	expect(bindLedgerChild(runId, id, "Main", project.root)).toBe(true);
};

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
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
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
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeDefined();
		// A subagent's result resumes the paused run with a new turn.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeUndefined();

		const record = await lastRun(project.root);
		expect(record).toMatchObject({
			runId: runId as string,
			status: "ended",
			endReason: "no-changes",
			turns: 1,
			costUsd: 0.75,
			mainCostUsd: 0.25,
			maxMainContext: 50_000,
			blockedEdits: 1,
			reads: { director: 2, directorChars: 400, duplicateChars: 100, blocked: 1 },
			plan: { lanes: [{ name: "fix", kind: "code", role: "implementer" }] },
		});
		expect(record?.spawns.map(spawn => spawn.code ?? spawn.outcome)).toEqual(["no-plan", "routed", "role-not-in-plan", "role-cap"]);
		// The manual task name was matched to its unique planned lane without a rewrite.
		expect(record?.spawns.find(spawn => spawn.spawnKey === "Impl" && spawn.outcome === "routed")?.lane).toBe("fix");
		expect(record?.agents).toMatchObject([{ id: "Impl", role: "implementer", state: "idle", followUps: 2, costUsd: 0.5, contextTokens: 30_000, review: { reviews: 1, passed: 1 } }]);

		// Afterwards the main session is ordinary again.
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["x/unapproved"]), main))).toBe("pass");
	});

	test("the status line shows the live run, then the idle label again when it ends", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();

		await omp.command("fix it", main);
		const live = omp.statuses.at(-1);
		expect(live?.startsWith("storm ▶")).toBe(true);
		expect(live).not.toBe(idle);
		expect(live).toContain("1/4");

		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		await until(() => omp.statuses.at(-1) === idle);
		expect(omp.statuses.at(-1)).toBe(idle);
	});

	test("an idle TUI footer carries the shared mark and theme tones; RPC stays plain, and a live widget is not duplicated", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const plain = omp.statuses.at(-1);
		expect(plain?.startsWith(STORM_MARK)).toBe(true);
		expect(plain).toContain("대기");
		expect(plain).not.toContain("\x1b[");

		const themed: Array<string | undefined> = [];
		const widgetKeys: string[] = [];
		const tui = {
			...main,
			mode: "tui",
			ui: {
				...(main.ui as unknown as Record<string, unknown>),
				theme: { fg: (_tone: string, text: string) => `\x1b[1;35m${text}\x1b[0m` },
				setStatus: (_key: string, text: string | undefined) => themed.push(text),
				setWidget: (key: string, content: unknown) => {
					if (content === undefined) return;
					widgetKeys.push(key);
					// LiveStatus installs a component factory; the fake host only needs to build the component.
					(content as (tui: unknown, theme: unknown) => unknown)(
						{ requestComponentRender: () => undefined, requestRender: () => undefined },
						{ fg: (_tone: string, text: string) => text },
					);
				},
			},
		} as unknown as ExtensionContext;
		await omp.emit("session_start", {}, tui);
		const framed = themed.at(-1) ?? "";
		expect(framed).toContain("\x1b[");
		expect(framed).toContain(STORM_MARK);
		expect(framed).toContain("대기");

		// During a run the editor widget owns the live line: the themed footer is cleared, not duplicated beside it.
		await omp.command("fix it", tui);
		expect(widgetKeys).toContain("storm-live");
		expect(themed.at(-1)).toBeUndefined();
		await omp.emit("agent_start", {}, tui);
		await omp.emit("agent_end", {}, tui);
		await until(() => themed.at(-1)?.startsWith("\x1b[") === true);
	});

	test("a project with no Storm config and no automatic consent gets no footer at all", async () => {
		const omp = fakeOmp(project);
		await omp.emit("session_start", {}, omp.ctx(MAIN));
		expect(omp.statuses.at(-1)).toBeUndefined();
	});

	test("a session switch drops a pending ask wait with the run it belonged to", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("fix it", main);
		await omp.emit("tool_execution_start", { toolCallId: "switch-ask", toolName: "ask", args: { html: "<form>" } }, main);
		expect(omp.statuses.at(-1)).toContain("응답 대기");
		await omp.emit("session_switch", {}, main);
		await until(() => omp.statuses.at(-1)?.startsWith(STORM_MARK) === true);
		expect(omp.statuses.at(-1)).not.toContain("응답 대기");
		// The old run's late execution end finds no live run and changes nothing.
		await omp.emit("tool_execution_end", { toolCallId: "switch-ask", toolName: "ask", result: {}, isError: false }, main);
		expect(omp.statuses.at(-1)).not.toContain("응답 대기");
	});

	test("two parallel children may carry the same provider tool-call id without closing each other's wait", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const first = child.ctx(sub("Impl"));
		const second = child.ctx(sub("Impl2"));
		await omp.emit("session_start", {}, main);
		await omp.command("fix it", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		admitChild(runId, "Impl");
		admitChild(runId, "Impl2");
		const question = { toolCallId: "same-call", toolName: "ask", args: { html: "<form><input name=\"x\"></form>" } };
		await child.emit("tool_execution_start", question, first);
		expect(omp.statuses.at(-1)).toContain("응답 대기");
		await child.emit("tool_execution_start", question, second);
		expect(omp.statuses.at(-1)).toContain("응답 대기");
		const end = { toolCallId: "same-call", toolName: "ask", result: {}, isError: false };
		await child.emit("tool_execution_end", end, first);
		// The second child is still waiting even though its sibling closed the same provider call id.
		expect(omp.statuses.at(-1)).toContain("응답 대기");
		await child.emit("tool_execution_end", end, second);
		expect(omp.statuses.at(-1)).not.toContain("응답 대기");
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
	});

	test("a no-UI host's ask or approval event claims no user wait", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("fix it", main);
		const noUi = { ...main, hasUI: false } as ExtensionContext;
		const before = omp.statuses.at(-1);
		await omp.emit("tool_execution_start", { toolCallId: "headless-ask", toolName: "ask", args: { html: "<form>" } }, noUi);
		await omp.emit(
			"tool_approval_requested",
			{ sessionId: "s", toolCallId: "headless-approval", toolName: "bash", approvalMode: "always-ask" },
			noUi,
		);
		expect(omp.statuses.at(-1)).toBe(before);
		expect(omp.statuses.at(-1)).not.toContain("응답 대기");
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
	});

	test("the status line follows real asks, approvals and child phases; a late dialog cannot mark the idle line", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		await omp.emit("session_start", {}, main);
		await omp.command("fix it", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		admitChild(runId, "Impl");
		admitChild(runId, "Rev");
		const seen = () => omp.statuses.at(-1) ?? "";
		expect(seen()).toContain("진행 중");

		// Only a real ask form is a wait; its execution end clears it.
		await omp.emit(
			"tool_execution_start",
			{ toolCallId: "ask-1", toolName: "ask", args: { html: "<form><input name=\"x\"></form>" } },
			main,
		);
		expect(seen()).toContain("응답 대기");
		await omp.emit("tool_execution_end", { toolCallId: "ask-1", toolName: "ask", result: {}, isError: false }, main);
		expect(seen()).toContain("진행 중");
		await omp.emit("tool_execution_start", { toolCallId: "ask-2", toolName: "ask", args: {} }, main);
		expect(seen()).not.toContain("응답 대기");
		await omp.emit("tool_execution_end", { toolCallId: "ask-2", toolName: "ask", result: {}, isError: true }, main);

		// A tool approval is requested only when it truly blocks; resolving it returns to work.
		await omp.emit(
			"tool_approval_requested",
			{ sessionId: "s", toolCallId: "appr-1", toolName: "bash", approvalMode: "always-ask" },
			main,
		);
		expect(seen()).toContain("응답 대기");
		await omp.emit(
			"tool_approval_resolved",
			{ sessionId: "s", toolCallId: "appr-1", toolName: "bash", approved: true },
			main,
		);
		expect(seen()).toContain("진행 중");

		// A run-bound child's own start/approval/settle keeps the same phase signal accurate.
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		expect(seen()).toContain("워커 작업 중");
		await child.emit(
			"tool_approval_requested",
			{ sessionId: "s", toolCallId: "appr-child", toolName: "edit", approvalMode: "always-ask" },
			impl,
		);
		expect(seen()).toContain("응답 대기");
		await child.emit(
			"tool_approval_resolved",
			{ sessionId: "s", toolCallId: "appr-child", toolName: "edit", approved: true },
			impl,
		);
		expect(seen()).toContain("워커 작업 중");
		await child.emit("agent_end", {}, impl);
		expect(seen()).toContain("진행 중");

		// An active reviewer is verifying; settling it is not.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		expect(seen()).toContain("검증 중");
		await child.emit("agent_end", {}, rev);
		expect(seen()).toContain("진행 중");

		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		await until(() => omp.statuses.at(-1)?.startsWith(STORM_MARK) === true);
		const idle = omp.statuses.at(-1);
		// An ask or approval that outlives its run does not put a wait on the idle line.
		await omp.emit("tool_execution_start", { toolCallId: "late", toolName: "ask", args: { html: "<form>" } }, main);
		await omp.emit(
			"tool_approval_requested",
			{ sessionId: "s", toolCallId: "late", toolName: "bash", approvalMode: "always-ask" },
			main,
		);
		expect(omp.statuses.at(-1)).toBe(idle);
	});

	test("an interrupted run leaves a resume hint; the menu's first option resumes it; a verified end clears the hint", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		const root = (await loadProjectState(project.env)).repo.root;
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();

		await omp.command("resume me", main);
		const first = activeLedgerRun(root)?.runId;
		expect(first).toBeDefined();
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, main);
		expect(await lastRun(project.root)).toMatchObject({ runId: first as string, status: "stopped", endReason: "interrupted" });
		expect(activeLedgerRun(root)).toBeUndefined();

		// The idle label now says a run can be continued; it said nothing of the sort before.
		const hinted = omp.statuses.at(-1);
		expect(hinted).not.toBe(idle);
		expect(hinted?.startsWith(STORM_MARK)).toBe(true);
		expect(hinted).toContain("이어가기 가능");

		// The menu's first option resumes the old request under a new run record.
		omp.answers.push(options => options[0]);
		await omp.command("", main);
		expect(omp.sent).toHaveLength(2);
		expect(omp.sent[1]).toContain(first as string);
		expect(omp.sent[1]).toContain("resume me");
		const second = activeLedgerRun(root)?.runId;
		expect(second).toBeDefined();
		expect(await readRun(project.root, second as string)).toMatchObject({ status: "running", resumeOf: first, request: "resume me" });
		admitChild(second, "Impl");
		admitChild(second, "Rev");

		// A change and a verdict after it verify the resumed run in its first round.
		vi.useFakeTimers();
		const at = Date.now();
		setSystemTime(new Date(at));
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await writeFile(path.join(project.root, ".keep"), "resumed change\n");
		await child.emit("tool_result", { toolName: "edit", input: { path: ".keep" }, isError: false, content: [] }, impl);
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		setSystemTime(new Date(at + 1_000));
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		await child.emit("agent_end", {}, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		await until(() => omp.statuses.at(-1) === idle);
		expect(await readRun(project.root, second as string)).toMatchObject({ status: "done", endReason: "verified" });
	});

	test("the idle hint needs this machine's pointer and the request it recorded", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();
		const run = runRecord({
			runId: "run-20261120-000000-abcd",
			startedAt: "2026-11-20T00:00:00.000Z",
			endedAt: "2026-11-20T00:05:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			turns: 1,
			maxRounds: 4,
			task: "planted-request",
			request: "planted-request",
		});
		await writeRun(project.root, run);
		await omp.emit("session_start", {}, main);
		// A record in the repository is not a run this machine started.
		expect(omp.statuses.at(-1)).toBe(idle);
		await noteResumePointer((await loadProjectState(project.env)).store.dir, project.root, { ...run, runId: "run-20261120-000000-othr" });
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toBe(idle);
		await noteResumePointer((await loadProjectState(project.env)).store.dir, project.root, run);
		await omp.emit("session_start", {}, main);
		const hinted = omp.statuses.at(-1);
		expect(hinted).not.toBe(idle);
		// The pointer covers the request: an edited one no longer matches.
		await writeRun(project.root, { ...run, request: "edited-request" });
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toBe(idle);
	});

	test("the idle hint needs an approved team, without an unapproved shadow", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();
		const run = runRecord({
			runId: "run-20261120-000000-shad",
			startedAt: "2026-11-20T00:00:00.000Z",
			endedAt: "2026-11-20T00:05:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			task: "shadow-request",
			request: "shadow-request",
		});
		await writeRun(project.root, run);
		await noteResumePointer((await loadProjectState(project.env)).store.dir, project.root, run);
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).not.toBe(idle);
		// The approval is still there, but it does not cover this definition: the team is not approved, so the
		// resume hint is not offered and the status says what the user must do.
		await mkdir(path.join(project.root, ".omp", "agents"), { recursive: true });
		await writeFile(path.join(project.root, ".omp", "agents", "storm-reviewer.md"), "---\nname: storm-reviewer\n---\nbody\n");
		await omp.emit("session_start", {}, main);
		const shadowed = omp.statuses.at(-1);
		expect(shadowed).not.toBe(idle);
		expect(shadowed).toContain("승인 필요");
		expect(shadowed).not.toContain("이어가기 가능");
	});

	test("the idle hint needs an approved team, without its approval", async () => {
		await approve(TEAM);
		await writeConfig(project.root, { ...TEAM, parallelism: 2 });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();
		const run = runRecord({
			runId: "run-20261120-000000-napr",
			startedAt: "2026-11-20T00:00:00.000Z",
			endedAt: "2026-11-20T00:05:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			task: "unapproved-request",
			request: "unapproved-request",
		});
		await writeRun(project.root, run);
		await noteResumePointer((await loadProjectState(project.env)).store.dir, project.root, run);
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toBe(idle);
	});

	test("session_start closes a dead run and offers it; a live run is left running", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const root = (await loadProjectState(project.env)).repo.root;
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();
		const store = (await loadProjectState(project.env)).store.dir;
		const dead = runRecord({
			runId: "run-20261120-000000-dead",
			startedAt: "2026-11-20T00:00:00.000Z",
			updatedAt: "2026-11-20T00:05:00.000Z",
			status: "running",
			process: DEAD_PROCESS,
			task: "dead-request",
			request: "dead-request",
		});
		const live = runRecord({
			runId: "run-20261120-010000-live",
			startedAt: "2026-11-20T01:00:00.000Z",
			status: "running",
			process: processKey(),
			task: "live-request",
			request: "live-request",
		});
		await writeRun(project.root, dead);
		await noteResumePointer(store, project.root, dead);
		await writeRun(project.root, live);
		await omp.emit("session_start", {}, main);
		expect(await readRun(project.root, dead.runId)).toMatchObject({ status: "stopped", endedAt: dead.updatedAt });
		expect(await readRun(project.root, live.runId)).toMatchObject({ status: "running" });
		expect(omp.statuses.at(-1)).not.toBe(idle);

		omp.answers.push(options => options[0]);
		await omp.command("", main);
		expect(omp.sent).toHaveLength(1);
		const resumed = activeLedgerRun(root)?.runId;
		expect(resumed).toBeDefined();
		expect(await readRun(project.root, resumed as string)).toMatchObject({ resumeOf: dead.runId, request: "dead-request" });
		await omp.emit("session_shutdown", {}, main);
	});

	test("a subagent's change brings a round from Storm; a correct verdict after it ends the run verified", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		await omp.command("task", main);
		expect(omp.sent).toHaveLength(1);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		admitChild(runId, "Impl");
		admitChild(runId, "Rev");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);

		vi.useFakeTimers();
		const changedAt = Date.now();
		setSystemTime(new Date(changedAt));
		await writeFile(path.join(project.root, ".keep"), "worker change\n");
		await child.emit("tool_result", { toolName: "edit", input: { path: ".keep" }, isError: false, content: [] }, impl);
		await child.emit("message_end", assistant("m", "i", 1_000, 0), impl);
		await child.emit("agent_end", {}, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		// The handler returns without sending: the round waits out the delay.
		expect(omp.sent).toHaveLength(1);
		vi.advanceTimersByTime(ROUND_DELAY_MS);
		await until(() => omp.sent.length === 2);
		expect(omp.sent[1]?.split("\n")[0]).toContain('round="2/4"');
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeDefined();

		// The reviewer starts after the change, so its baseline is the tree it is asked to verify.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		setSystemTime(new Date(changedAt + 1_000));
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		const reading = await treeAgainst(project.env.exec, project.root);
		expect(reading).toBeDefined();
		expect(listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${reading?.state.diff}:${reading?.state.files}`);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeUndefined();
		expect(await lastRun(project.root)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("a reused live agent belongs to the next run: its read, its edit and the reviewer's verdict all count", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		await writeFile(path.join(project.root, "big.md"), "line\n".repeat(10_000));
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		const edit = { toolName: "edit", input: { path: ".keep" }, isError: false, content: [] };
		const yielded = { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] };

		// First run: the agents register through before_agent_start, as a spawn does.
		await omp.command("first task", main);
		const firstRun = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		admitChild(firstRun, "Impl");
		admitChild(firstRun, "Rev");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await writeFile(path.join(project.root, ".keep"), "first run change\n");
		await child.emit("tool_result", edit, impl);
		await child.emit("message_end", assistant("m", "i", 1_000, 0), impl);
		await child.emit("agent_end", {}, impl);
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		const first = Date.now();
		setSystemTime(new Date(first + 1_000));
		await child.emit("tool_result", yielded, rev);
		await child.emit("agent_end", {}, rev);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "done", endReason: "verified", turns: 1 });
		const firstReading = await treeAgainst(project.env.exec, project.root);
		expect(firstReading).toBeDefined();
		expect(listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${firstReading?.state.diff}:${firstReading?.state.files}`);
		await git(project.root, "add", ".keep");
		await git(project.root, "commit", "-m", "first run verified");

		// Second run, same session: omp emits no before_agent_start for these live agents.
		vi.useFakeTimers();
		const second = first + 60_000;
		setSystemTime(new Date(second));
		await omp.command("second task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		expect(runId).toBeDefined();
		admitChild(runId, "Impl");
		// The read is indexed under the new run: the director's wide read of the same file is blocked.
		await child.emit("tool_call", { toolName: "read", input: { path: "big.md" } }, impl);
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "big.md:1-5000" } }, main))).toBe("read-large");
		// The edit lands in the new run's gate, so the first round stays open for a verdict.
		await writeFile(path.join(project.root, ".keep"), "second run change\n");
		await child.emit("tool_result", edit, impl);
		await child.emit("message_end", assistant("m", "i", 1_000, 0), impl);
		await child.emit("agent_end", {}, impl);
		const follow = { toolName: "write", input: { path: "agent://Rev", content: "review the current tree" }, isError: false, content: [] };
		// The follow-up admits the reused reviewer into this run and takes its tree baseline.
		await omp.emit("tool_call", follow, main);
		await omp.emit("tool_result", follow, main);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", { awaitingAsyncWork: true }, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeDefined();
		// The reused reviewer's verdict resumes the same round and counts in the new run.
		setSystemTime(new Date(second + 1_000));
		await child.emit("tool_result", yielded, rev);
		await child.emit("agent_end", {}, rev);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ runId: runId as string, status: "done", endReason: "verified", turns: 1 });
		const secondReading = await treeAgainst(project.env.exec, project.root);
		expect(secondReading).toBeDefined();
		expect(listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${secondReading?.state.diff}:${secondReading?.state.files}`);
	});

	test("a same-tree child without an admitted binding never attaches to the run", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "big.md"), "line\n".repeat(10_000));
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const stray = child.ctx(sub("Stray", "impl"));
		await omp.command("task", main);
		// No parent admitted this id into the run: its read must not be indexed against the run.
		await child.emit("before_agent_start", { systemPrompt: [] }, stray);
		await child.emit("tool_call", { toolName: "read", input: { path: "big.md" } }, stray);
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "big.md:1-5000" } }, main))).toBe("pass");
		await child.emit("message_end", assistant("a", "i", 30_000, 0.5), stray);
		await child.emit("agent_end", {}, stray);
		await omp.emit("session_shutdown", {}, main);
	});

	test("a reviewer's verdict carries the run's tree, and none outside a run", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		const yieldReview = (correctness: "correct" | "incorrect") =>
			child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: correctness } }, isError: false, content: [] }, rev);

		// Outside a run there is no main work tree to tie the verdict to.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await yieldReview("correct");
		await child.emit("agent_end", {}, rev);
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: expect.any(Number), correct: true });

		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		admitChild(runId, "Rev");
		await writeFile(path.join(project.root, ".keep"), "changed\n");
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await yieldReview("incorrect");
		await child.emit("agent_end", {}, rev);
		const expected = await treeAgainst(project.env.exec, project.root);
		expect(expected).toBeDefined();
		const pair = `${expected?.state.diff}:${expected?.state.files}`;
		await until(() => listAgents()[0]?.lastVerdict?.tree === pair);
		expect(listAgents()[0]?.lastVerdict).toMatchObject({ correct: false, tree: pair });
		await omp.emit("session_shutdown", {}, main);
	});

	test("a verdict cannot inherit a tree changed after the reviewer started", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		admitChild(runId, "Rev");
		// The reviewer starts against a clean tree, then the tree changes before its verdict.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await writeFile(path.join(project.root, ".keep"), "changed after review start\n");
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		expect(listAgents().find(agent => agent.id === "Rev")?.lastVerdict).toMatchObject({ correct: true });
		expect(listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("a change committed after the run starts still needs a review", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		await omp.command("task", main);
		const base = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.base;
		admitChild(activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId, "Rev");

		// A shell change the team commits: HEAD moves, so the tree looks clean against it.
		await writeFile(path.join(project.root, ".keep"), "committed change\n");
		await git(project.root, "add", ".keep");
		await git(project.root, "commit", "-m", "team change");
		vi.useFakeTimers();
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		// The run's start commit still sees the change: something needs review, so a round follows.
		expect(omp.sent).toHaveLength(1);
		vi.advanceTimersByTime(ROUND_DELAY_MS);
		await until(() => omp.sent.length === 2);
		expect(omp.sent[1]?.split("\n")[0]).toContain('round="2/4"');

		// The reviewer starts after the change, so its baseline includes the committed work.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		// A verdict against that change verifies it; the commit after the run's start did not hide it.
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		await until(() => listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree !== undefined);
		const reading = await treeAgainst(project.env.exec, project.root, base);
		expect(reading).toBeDefined();
		expect(listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${reading?.state.diff}:${reading?.state.files}`);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("a commit after a passing verdict costs no extra round", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		await omp.command("task", main);
		const base = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.base;
		admitChild(activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId, "Rev");

		// The change is in the tree when the verdict is given, then the team commits it: HEAD moves, the content does not.
		await writeFile(path.join(project.root, ".keep"), "uncommitted change\n");
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		vi.useFakeTimers();
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.sent).toHaveLength(1);
		vi.advanceTimersByTime(ROUND_DELAY_MS);
		await until(() => omp.sent.length === 2);

		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		await until(() => listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree !== undefined);
		const reading = await treeAgainst(project.env.exec, project.root, base);
		expect(reading).toBeDefined();
		expect(listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${reading?.state.diff}:${reading?.state.files}`);
		await git(project.root, "add", ".keep");
		await git(project.root, "commit", "-m", "commit after the verdict");
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("a verdict reads the run's main tree against its base, not the subagent's cwd", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const side = path.join(project.tmp, "side");
		await git(project.root, "worktree", "add", side, "-b", "review-side");
		// The reviewer runs in another work tree of the same repository, as an isolated agent does.
		const rev = { ...child.ctx(sub("Rev", "storm-reviewer")), cwd: side } as ExtensionContext;
		await omp.command("task", main);
		const ledger = activeLedgerRun((await loadProjectState(project.env)).repo.root);
		expect(ledger?.base).toBeDefined();
		admitChild(ledger?.runId, "Rev");

		await writeFile(path.join(project.root, ".keep"), "changed in the main tree\n");
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		const expected = await treeAgainst(project.env.exec, project.root, ledger?.base);
		expect(expected).toBeDefined();
		const pair = `${expected?.state.diff}:${expected?.state.files}`;
		await until(() => listAgents().find(agent => agent.id === "Rev")?.lastVerdict?.tree === pair);
		// The side work tree is clean: a verdict read from there would not match the run's tree.
		expect((await treeAgainst(project.env.exec, side, ledger?.base))?.state.diff).not.toBe(expected?.state.diff);
		await omp.emit("session_shutdown", {}, main);
	});

	test("a pending round wait does not send after a session switch", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.command("task", main);
		admitChild(activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		vi.useFakeTimers();
		await writeFile(path.join(project.root, ".keep"), "switch change\n");
		await child.emit("tool_result", { toolName: "edit", input: { path: ".keep" }, isError: false, content: [] }, impl);
		await child.emit("agent_end", {}, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.sent).toHaveLength(1);
		await omp.emit("session_switch", {}, main);
		expect(await lastRun(project.root)).toMatchObject({ status: "stopped", endReason: "shutdown" });
		vi.advanceTimersByTime(ROUND_DELAY_MS * 2);
		expect(omp.sent).toHaveLength(1);
	});

	test("a settled child turn records error, abort and length evidence, and success clears it", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.command("task", main);
		admitChild(activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId, "Impl");
		for (const stopReason of ["error", "aborted", "length"] as const) {
			await child.emit("before_agent_start", { systemPrompt: [] }, impl);
			await child.emit("agent_end", { messages: [{ role: "assistant", stopReason }] }, impl);
			expect(listAgents().find(agent => agent.id === "Impl")).toMatchObject({ lastWorkFailed: true });
		}
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, impl);
		expect(listAgents().find(agent => agent.id === "Impl")?.lastWorkFailed).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("the same run without a file change ends no-changes after one round", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		const impl = child.ctx(sub("Impl"));
		admitChild(runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("message_end", assistant("m", "i", 1_000, 0), impl);
		await child.emit("agent_end", {}, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.sent).toHaveLength(1);
		expect(await lastRun(project.root)).toMatchObject({ status: "ended", endReason: "no-changes", turns: 1 });
	});

	test("a follow-up to an agent past its cap is refused and counted; one below it passes", async () => {
		await approve({ ...TEAM, contextCap: 20_000 });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		for (const [id, tokens] of [["Big", 20_000], ["Small", 19_999]] as const) {
			const ctx = child.ctx(sub(id));
			admitChild(runId, id);
			await child.emit("before_agent_start", { systemPrompt: [] }, ctx);
			await child.emit("message_end", assistant("a", "i", tokens, 0), ctx);
			await child.emit("agent_end", {}, ctx);
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

		admitChild(activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("agent_end", {}, impl);
		await child.emit("session_shutdown", {}, impl);
		expect(listAgents()[0]).toMatchObject({ id: "Impl", state: "parked" });
		expect(await lastRun(project.root)).toBeUndefined();
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeDefined();
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
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeUndefined();
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
		const root = (await loadProjectState(project.env)).repo.root;

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
		await until(() => activeLedgerRun(root)?.costUsd === 0.2);
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
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeUndefined();
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

describe("automatic delegation", () => {
	const readFile = { toolName: "read", input: { path: "src/a.ts" } };

	test("off by default: ordinary prompts, direct tools and /storm <text> stay as before", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		expect(await omp.emit("before_agent_start", { reason: "prompt", prompt: "hello", systemPrompt: ["base"] }, main)).toBeUndefined();
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["x/any"]), main))).toBe("pass");
		await omp.command("fix it", main);
		expect(omp.sent).toHaveLength(1);
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeDefined();
		// Opted out, an active run keeps the legacy director gate: a shell call is not supervisor-blocked.
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "git status" } }, main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("before a run it blocks direct project tools, reads and spawns, while plan and worker results stay open", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const started = (await omp.emit(
			"before_agent_start",
			{ reason: "prompt", prompt: "fix the login bug", systemPrompt: ["base"] },
			main,
		)) as { systemPrompt: string[] };
		expect(started.systemPrompt.at(-1)).toContain("<storm-auto>");
		expect(started.systemPrompt.at(-1)).toContain("plan");
		expect(omp.statuses.at(-1)).toContain("자동 위임");

		for (const call of [
			readFile,
			{ toolName: "edit", input: { path: "src/a.ts" } },
			{ toolName: "bash", input: { command: "git status" } },
			{ toolName: "grep", input: { pattern: "x" } },
			{ toolName: "glob", input: { pattern: "**/*" } },
			{ toolName: "task", input: { agent: "storm-implementer", task: "fix" } },
		]) {
			expect(verdict(await omp.emit("tool_call", call, main))).toBe("auto");
		}
		// The orchestrator and published worker results remain reachable.
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "agent://Impl" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "local://plan.md", content: "- step" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "storm", input: { action: "plan" } }, main))).toBe("pass");
		// The spawn hook is the fail-closed backstop even when no tool-call guard sees the spawn.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("auto");
		// The stable instruction is appended once, not again on the next turn.
		expect(await omp.emit("before_agent_start", { reason: "prompt", prompt: "more", systemPrompt: started.systemPrompt }, main)).toBeUndefined();
	});

	test("the first plan opens this turn's run, then its approved worker is permitted", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: [] }, main);
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main);
		expect(reply.outcome).toBe("ok");
		expect(reply.text).toContain("자동 위임 실행");
		const root = (await loadProjectState(project.env)).repo.root;
		const runId = activeLedgerRun(root)?.runId;
		expect(runId).toBeDefined();
		expect(await readRun(project.root, runId as string)).toMatchObject({
			status: "running",
			request: "fix the login bug",
			plan: { lanes: [{ name: "fix", kind: "code", role: "implementer" }] },
		});
		// The in-flight turn is round one: no handoff was sent.
		expect(omp.sent).toEqual([]);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "fix"), main))).toBe("internal");
		// The auto task is rewritten to a reserved lane name before the host allocates the spawn.
		const assigned = (await omp.emit(
			"tool_call",
			{ toolName: "task", input: { agent: "storm-implementer", task: "fix" } },
			main,
		)) as { input: { name: string } };
		expect(assigned.input.name).toContain(`${runId as string}-lane-1`);
		const impl = child.ctx(sub(assigned.input.name));
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", assigned.input.name), main))).toBe("route:a/i");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		// The strict supervisor gate stays on during the automatic run: no direct file, shell or eval calls.
		for (const call of [
			readFile,
			{ toolName: "bash", input: { command: "git status" } },
			{ toolName: "eval", input: { code: "1" } },
		]) {
			expect(verdict(await omp.emit("tool_call", call, main))).toBe("auto");
		}
		// Delegation and published worker results remain open; the legacy follow-up gate still applies behind them.
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: `agent://${assigned.input.name}` } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: `agent://${assigned.input.name}`, content: "report" } }, main))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } }, impl))).toBe("pass");
		await child.emit("message_end", assistant("m", "i", 1_000, 0.1), impl);
		await child.emit("agent_end", {}, impl);
		// The settled turn ends the run; direct tools are fenced again.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun(root)).toBeUndefined();
		expect((await lastRun(project.root))?.spawns).toMatchObject([
			{ spawnKey: "fix", agent: "storm-implementer", outcome: "blocked", code: "internal" },
			{ spawnKey: assigned.input.name, agent: "storm-implementer", outcome: "routed", lane: "fix" },
		]);
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("auto");
	});

	test("the first accepted automatic plan starts one background handoff checkpoint for a heavy context", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.usage.current = { tokens: 206_512, contextWindow: 400_000, percent: 52 };
		omp.holdCompactions.value = true;
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: [] }, main);
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main);
		expect(reply.outcome).toBe("ok");
		const root = (await loadProjectState(project.env)).repo.root;
		const runId = activeLedgerRun(root)?.runId;
		expect(runId).toBeDefined();
		// A tool turn is a real boundary: no user turn, handoff or synthetic round is added.
		expect(omp.sent).toEqual([]);
		expect(omp.compactions).toHaveLength(1);
		const checkpoint = omp.compactions[0];
		expect(checkpoint?.options).toMatchObject({ mode: "handoff" });
		expect(checkpoint?.options.signal).toBeDefined();
		expect(checkpoint?.options.internalGuidance).toContain("fix the login bug");
		expect(checkpoint?.options.internalGuidance).toContain(`Storm 실행 ${runId as string}`);
		expect(checkpoint?.options.internalGuidance).toContain("계획 레인 1개");
		expect(checkpoint?.options.internalGuidance).toContain("- fix (code,");
		expect(checkpoint?.options.internalGuidance).toContain("Storm 장부");
		// Not committed yet: nothing claims a checkpoint.
		expect((await readRun(project.root, runId as string))?.checkpoints).toBeUndefined();
		// The host applies the summary at its next boundary; the run records only that applied commit.
		omp.usage.current = { tokens: 30_000, contextWindow: 400_000, percent: 8 };
		checkpoint?.complete();
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
		// A paused async wait now cannot start a second one.
		await omp.emit("agent_end", { awaitingAsyncWork: true }, main);
		expect(omp.compactions).toHaveLength(1);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		// Storm's next round is a delayed timer, never an immediate synthetic turn from the checkpoint.
		expect(omp.sent).toEqual([]);
		await omp.emit("session_shutdown", {}, main);
		const record = await lastRun(project.root);
		expect(record).toMatchObject({ runId: runId as string, turns: 1, endReason: "shutdown" });
		expect(record?.checkpoints).toEqual([expect.objectContaining({ before: 206_512, after: 30_000 })]);
		expect(omp.sent).toEqual([]);
	});

	test("a heavy ordinary prompt and a small automatic plan never start a checkpoint", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.usage.current = { tokens: 300_000, contextWindow: 400_000, percent: 75 };
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "just chatting", systemPrompt: [] }, main);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.compactions).toEqual([]);
		// Small accepted automatic work keeps its old path: no compaction.
		omp.usage.current = { tokens: 80_000, contextWindow: 400_000, percent: 20 };
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "quick fix", systemPrompt: [] }, main);
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "one", kind: "code" }] } }, main);
		expect(reply.outcome).toBe("ok");
		expect(omp.compactions).toEqual([]);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		await omp.emit("session_shutdown", {}, main);
		expect((await lastRun(project.root))?.checkpoints).toBeUndefined();
	});

	test("a wait in a live automatic run starts the checkpoint the plan did not need", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.usage.current = { tokens: 150_000, contextWindow: 400_000, percent: 37 };
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main)).outcome).toBe("ok");
		// Under the cap at plan time: no summary yet.
		expect(omp.compactions).toEqual([]);
		// The run grows while it waits synchronously; the wait tool's start is a real boundary.
		omp.usage.current = { tokens: 205_000, contextWindow: 400_000, percent: 51 };
		// A subagent session shares this extension instance but never owns the run: its wait changes nothing.
		await omp.emit("tool_execution_start", { toolName: "wait", toolCallId: "w0", args: {} }, omp.ctx(sub("Worker")));
		expect(omp.compactions).toEqual([]);
		await omp.emit("tool_execution_start", { toolName: "wait", toolCallId: "w1", args: {} }, main);
		expect(omp.compactions).toHaveLength(1);
		expect(omp.compactions[0]?.options).toMatchObject({ mode: "handoff" });
		expect(omp.compactions[0]?.options.internalGuidance).toContain("fix the login bug");
		// A second wait inside the min gap asks nothing more.
		await omp.emit("tool_execution_start", { toolName: "wait", toolCallId: "w2", args: {} }, main);
		expect(omp.compactions).toHaveLength(1);
		const settled = Promise.withResolvers<void>();
		setImmediate(settled.resolve);
		await settled.promise;
		await omp.emit("session_shutdown", {}, main);
		const record = await lastRun(project.root);
		expect(record?.checkpoints).toHaveLength(1);
		expect(omp.sent).toEqual([]);
	});

	test("a manual run's async wait uses the same handoff checkpoint; wait tools add nothing", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.usage.current = { tokens: 80_000, contextWindow: 400_000, percent: 20 };
		await omp.emit("session_start", {}, main);
		await omp.command("manual task", main);
		expect(omp.sent).toHaveLength(1);
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		expect(runId).toBeDefined();
		// The manual run was under both preflight thresholds; its director now grows past the cap.
		omp.usage.current = { tokens: 210_000, contextWindow: 400_000, percent: 53 };
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", { awaitingAsyncWork: true }, main);
		// Public manual behavior is unchanged: one recorded checkpoint, with the run ledger in the summary focus.
		expect(omp.compactions).toHaveLength(1);
		expect(omp.compactions[0]?.options).toMatchObject({ mode: "handoff" });
		expect(omp.compactions[0]?.options.internalGuidance).toContain(`Storm 실행 ${runId as string}`);
		// The automatic-only wait hook does not apply to manual direction.
		await omp.emit("tool_execution_start", { toolName: "wait", toolCallId: "w1", args: {} }, main);
		expect(omp.compactions).toHaveLength(1);
		const settled = Promise.withResolvers<void>();
		setImmediate(settled.resolve);
		await settled.promise;
		await omp.emit("session_shutdown", {}, main);
		expect((await lastRun(project.root))?.checkpoints).toHaveLength(1);
	});

	test("a session switch cancels the automatic checkpoint; a late commit never lands", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.usage.current = { tokens: 210_000, contextWindow: 400_000, percent: 53 };
		omp.holdCompactions.value = true;
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main)).outcome).toBe("ok");
		const checkpoint = omp.compactions[0];
		expect(checkpoint).toBeDefined();
		await omp.emit("session_switch", {}, main);
		expect(checkpoint?.options.signal?.aborted).toBe(true);
		checkpoint?.complete();
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
		const record = await lastRun(project.root);
		expect(record).toMatchObject({ status: "stopped", endReason: "shutdown" });
		expect(record?.checkpoints).toBeUndefined();
	});

	test("a new user turn supplies a fresh task, not the previous turn's text", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "old request", systemPrompt: [] }, main);
		await omp.emit("agent_end", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "new request", systemPrompt: [] }, main);
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main);
		expect(reply.outcome).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).repo.root)?.runId;
		expect(await readRun(project.root, runId as string)).toMatchObject({ request: "new request" });
		await omp.emit("session_shutdown", {}, main);
	});

	test("public plan mode cannot auto-start a run", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const modes = {
			getState: () => ({
				plan: { status: "active" as const },
				vibe: { status: "inactive" as const },
				goal: { status: "inactive" as const },
				loop: { status: "inactive" as const },
			}),
			set: async () => ({ ok: false as const, code: "conflict" as const, message: "busy", state: modes.getState() }),
		};
		const main = { ...omp.ctx(MAIN), sessionModes: modes } as ExtensionContext;
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toContain("자동 위임 막힘");
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix it", systemPrompt: [] }, main);
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main);
		expect(reply.outcome).toBe("rejected");
		expect(reply.text).toContain("계획 모드");
		expect(activeLedgerRun((await loadProjectState(project.env)).repo.root)).toBeUndefined();
	});

	test("broken approval keeps the fence and refuses plans; /storm auto still opts off and unfences", async () => {
		await approve(TEAM);
		const dir = await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "first", systemPrompt: [] }, main);
		await writeConfig(project.root, { ...TEAM, parallelism: 2 });
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "second", systemPrompt: [] }, main);
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, main))).toBe("auto");
		const plan = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code" }] } }, main);
		expect(plan.outcome).toBe("rejected");
		expect(plan.text).toContain("승인");
		expect(plan.text).toContain("/storm");
		await omp.emit("agent_end", {}, main);
		expect(omp.statuses.at(-1)).toContain("자동 위임 막힘");

		// The explicit switch works without current team approval, and only it turns the guard off.
		omp.answers.push(options => options[0]);
		await omp.command("auto", main);
		expect(await readAutoDelegation(dir)).toBe(false);
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("pass");
		expect(omp.statuses.at(-1)).not.toContain("자동 위임");
	});

	test("a user turn and a session switch pick up an external consent change", async () => {
		await approve(TEAM);
		const dir = await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("auto");
		await writeAutoDelegation(dir, false);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "hello", systemPrompt: ["base"] }, main);
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("pass");
		await writeAutoDelegation(dir, true);
		await omp.emit("session_switch", {}, main);
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("auto");
		expect(omp.statuses.at(-1)).toContain("자동 위임");
	});
});

describe("closeout direction input", () => {
	const directions = ["첫 방향 작업", "둘째 방향 작업", "셋째 방향 작업"] as const;
	const brief = { result: "결과", verification: "검증", next: [...directions] };

	test("a brief on a settled run renders one card, and an exact number starts that direction as a normal user run", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("fix it", main);
		expect((await omp.toolReply({ action: "brief", brief }, main)).outcome).toBe("ok");
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);

		const card = omp.transcript
			.flatMap(message =>
				message !== null && typeof message === "object" && "content" in message && typeof message.content === "string"
					? [message.content]
					: [],
			)
			.find(content => content.includes("1. 추천 —"));
		expect(card).toContain(`1. 추천 — ${directions[0]}`);
		expect(card).toContain(`3. ${directions[2]}`);
		expect(omp.sent).toHaveLength(1);

		expect(await omp.emit("input", { type: "input", text: "1", source: "interactive" }, main)).toEqual({ handled: true });
		await until(() => omp.sent.length === 2);
		expect(omp.sent[1]).toContain(directions[0]);
		expect(omp.activeTools()).toContain("storm");
		await omp.emit("session_shutdown", {}, main);
	});

	test("extension text, images, another session, and a busy turn are never a numbered pick", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);

		rememberCloseoutReport(main, "run-old", directions);
		// An extension-authored submission is not direct user input, and leaves the card answerable.
		expect(await omp.emit("input", { type: "input", text: "1", source: "extension" }, main)).toBeUndefined();
		// A subagent session has no card of its own; the main session's offer is untouched.
		expect(await omp.emit("input", { type: "input", text: "1", source: "interactive" }, omp.ctx(sub("Other")))).toBeUndefined();
		// A host with no UI never showed the menu, so its text is not a choice and does not consume one.
		const noUi = { ...main, hasUI: false } as ExtensionContext;
		expect(await omp.emit("input", { type: "input", text: "1", source: "interactive" }, noUi)).toBeUndefined();
		// An image is not a numbered pick; it consumes the offer instead of starting a run from it.
		expect(
			await omp.emit(
				"input",
				{ type: "input", text: "1", source: "interactive", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
				main,
			),
		).toBeUndefined();
		expect(await omp.emit("input", { type: "input", text: "1", source: "interactive" }, main)).toBeUndefined();
		expect(omp.sent).toHaveLength(0);

		// A busy session also consumes without starting; the next number misses rather than reviving it.
		rememberCloseoutReport(main, "run-busy", directions);
		omp.idle.value = false;
		expect(await omp.emit("input", { type: "input", text: "2", source: "interactive" }, main)).toBeUndefined();
		omp.idle.value = true;
		expect(await omp.emit("input", { type: "input", text: "2", source: "interactive" }, main)).toBeUndefined();
		expect(omp.sent).toHaveLength(0);
	});

	test("any other real input invalidates the offer, and a stale pick cannot start a second run", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		rememberCloseoutReport(main, "run-old", directions);
		expect(await omp.emit("input", { type: "input", text: "hello", source: "interactive" }, main)).toBeUndefined();
		expect(await omp.emit("input", { type: "input", text: "1", source: "interactive" }, main)).toBeUndefined();
		expect(omp.sent).toHaveLength(0);

		await omp.command("first work", main);
		rememberCloseoutReport(main, "run-old", directions);
		const before = omp.notices.length;
		expect(await omp.emit("input", { type: "input", text: "3", source: "interactive" }, main)).toEqual({ handled: true });
		expect(omp.sent).toHaveLength(1);
		expect(omp.notices.length).toBe(before + 1);
		expect(omp.notices.at(-1)?.text).toContain("이미 Storm 실행");
		await omp.emit("session_shutdown", {}, main);
	});
});

describe("replan preflight", () => {
	test("a reused lane's changed identity is refused before any out-of-bounds team proposal opens", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("fix it", main);
		const first = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "fix", kind: "code", goal: "ship it" }] } }, main);
		expect(first.outcome).toBe("ok");
		omp.answers.push(APPROVE);
		const again = await omp.toolReply(
			{ action: "plan", plan: { lanes: [{ name: "fix", kind: "code", goal: "other scope" }], workers: { implementer: 5 } } },
			main,
		);
		expect(again.outcome).toBe("rejected");
		expect(again.text).toContain("fix");
		expect(again.text).toContain("progress");
		expect(omp.selects).toEqual([]);
		expect(omp.answers).toHaveLength(1);
		await omp.emit("session_shutdown", {}, main);
	});
});
