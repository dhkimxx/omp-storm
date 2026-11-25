/**
 * The extension's own wiring: every hook, the /storm command and the storm tool registered on a fake omp, with real
 * project files below a temp dir. As in omp, the main session and each subagent session load the extension
 * separately and share its module state.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test, vi } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { readAutoDelegation, writeAutoDelegation } from "../src/approval/auto.ts";
import { writeConfig } from "../src/config/store.ts";
import { prepareAnalysis } from "../src/context.ts";
import storm from "../src/extension.ts";
import { approveAndSave } from "../src/flows.ts";
import { docPromptFor } from "../src/policy/docs.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { listAgents, resetAgents } from "../src/runtime/agents.ts";
import * as closeoutModule from "../src/runtime/closeout.ts";
import { resetCloseoutChoices } from "../src/runtime/closeout.ts";
import { RunController } from "../src/runtime/controller.ts";
import { activeLedgerRun, bindLedgerChild, resetLedger } from "../src/runtime/ledger.ts";
import { processKey } from "../src/runtime/janitor.ts";
import { ROUND_DELAY_MS } from "../src/runtime/rounds.ts";
import { lastRun, readRun, writeRun } from "../src/runtime/run.ts";
import { noteResumePointer } from "../src/runtime/resume.ts";
import { readTrialStates } from "../src/runtime/state-files.ts";
import { resetTrialSpawns } from "../src/runtime/trials.ts";
import { treeAgainst } from "../src/runtime/tree.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import { loadProjectState } from "../src/state.ts";
import { STORM_MARK } from "../src/view/appearance.ts";
import { persistWorkerAdmission, readWorkerAdmission, revokeWorkerAdmissions } from "../src/worker-admission.ts";
import type { CloseoutAction, RunRecord, RunSpec, StormConfig, TrialConfig } from "../src/types.ts";
import { until } from "./fake-session.ts";
import { DEAD_PROCESS, runRecord } from "./fixtures.ts";
import { git, gitRepo, makeProject, scriptedUi, TEAM, type TestProject } from "./support.ts";

/** The fresh-plan contract the tool boundary requires; these tests exercise admission, not result evidence. */
const changeFor = (id: string) => [{ id, kind: "change" as const, criterion: "the lane delivered its requested change" }];
const answerFor = (id: string) => [{ id, kind: "answer" as const, criterion: "the lane reports what the tree contains" }];
const fixLane = { name: "fix", kind: "code" as const, results: changeFor("fix-change") };
const coreLane = { name: "core", kind: "code" as const, results: changeFor("core-change") };

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

const fakeSessionShutdowns: Array<(kind: Agent["kind"]) => Promise<void>> = [];

async function shutdownFakeSessions(): Promise<void> {
	const shutdowns = fakeSessionShutdowns.splice(0);
	// A main session keeps its worktree lease while its workers are running, so close children first.
	for (const kind of ["sub", "main"] as const) {
		for (const shutdown of shutdowns) await shutdown(kind);
	}
}

/** One session's omp as the extension sees it. Only `git` really runs; the `omp` CLI fails, as in `makeProject`. */
function fakeOmp(project: TestProject) {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const sessions = new Map<string, ExtensionContext>();
	const rememberSession = (ctx: ExtensionContext): void => {
		sessions.set(`${ctx.agent.kind}:${ctx.agent.id}`, ctx);
	};
	const emit = async (event: string, payload: unknown, on: ExtensionContext): Promise<unknown> => {
		rememberSession(on);
		let answer: unknown;
		for (const handler of handlers.get(event) ?? []) answer ??= await handler(payload, on);
		return answer;
	};
	fakeSessionShutdowns.push(async kind => {
		for (const session of sessions.values()) {
			if (session.agent.kind === kind) await emit("session_shutdown", {}, session);
		}
	});
	const statuses: Array<string | undefined> = [];
	/** Answers to the next dialogs, by position; empty means the user dismissed them. */
	const answers: Array<string | undefined | ((options: string[]) => string | undefined | Promise<string | undefined>)> = [];
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
	/**
	 * This host's native main-session identity. It starts as the project's own fixture session and may change under a
	 * test to model /new, a fork, a reopen of the same id, or a host that exposes none.
	 */
	let mainSessionId: string | undefined = project.sessionId;
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
				// A child has its own native identity, but Storm never reads it as a session store.
				getSessionId: () => (agent.kind === "main" ? (mainSessionId as string) : `child-${agent.id}`),
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
		/** Replaces the native main-session id for a following event, modeling /new, fork, resume or a host without one. */
		setSessionId: (id: string | undefined) => {
			mainSessionId = id;
		},
		sessionId: () => mainSessionId,
		activeTools: () => active,
		emit,
		command: (args: string, on: ExtensionContext) => {
			if (!command) throw new Error("the /storm command is not registered");
			rememberSession(on);
			return command(args, on);
		},
		tool: async (params: unknown, on: ExtensionContext): Promise<string> => {
			if (!tool) throw new Error("the storm tool is not registered");
			rememberSession(on);
			return (await tool.execute("call-1", params, undefined, undefined, on)).details.outcome;
		},
		toolReply: async (params: unknown, on: ExtensionContext): Promise<{ outcome: string; text: string }> => {
			if (!tool) throw new Error("the storm tool is not registered");
			rememberSession(on);
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
	if ("input" in answer) return "pass";
	return "model" in answer && Array.isArray(answer.model) ? `route:${answer.model.join(",")}` : "?";
}

let project: TestProject;

beforeEach(async () => {
	project = await makeProject();
});

afterEach(async () => {
	vi.useRealTimers();
	setSystemTime();
	try {
		// Release real leases while the project still exists. Linux can reuse its directory inode in the next test.
		await shutdownFakeSessions();
	} finally {
		resetLedger();
		resetAgents();
		resetTrialSpawns();
		resetCloseoutChoices();
		await project.remove();
	}
});

const approve = async (config: StormConfig) => approveAndSave(await loadProjectState(project.env), config, { shadowedAgents: [] });
/** Approves the config together with the shadow definitions currently on disk. */
const approveShadows = async (config: StormConfig): Promise<string> => {
	const state = await loadProjectState(project.env);
	return approveAndSave(state, config, { shadowedAgents: state.shadows });
};
/** A project shadow whose effective tools make a lane path-only instead of exec-capable. */
const pathOnlyImplementer = async (): Promise<void> => {
	const dir = path.join(project.root, ".omp", "agents");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "storm-implementer.md"), "---\nname: storm-implementer\ndescription: path-only test\ntools: read, write, edit\n---\nPath-only test worker.\n");
};

/** Writes this profile/repository's durable automatic-delegation opt-in; returns its store dir for later changes. */
const enableAuto = async (): Promise<string> => {
	const dir = (await loadProjectState(project.env)).sessionDir;
	await writeAutoDelegation(dir, true);
	return dir;
};

/**
 * Answers `omp config list --json` from this test, leaving git real. Returns the number of CLI reads so a test can
 * prove a run resolves host capability once instead of once per spawn.
 */
const installOmpSettings = (values: Record<string, boolean>): { calls: () => number } => {
	const previous = project.env.exec;
	const entries = Object.fromEntries(
		Object.entries(values).map(([key, value]) => [key, { value, type: "boolean", description: "" }]),
	);
	let calls = 0;
	project.env.exec = (command, args, options) => {
		if (command === "git") return previous(command, args, options);
		if (command === "omp" && args[0] === "config" && args[1] === "list") {
			calls++;
			return Promise.resolve({ stdout: JSON.stringify(entries), stderr: "", code: 0 });
		}
		return Promise.resolve({ stdout: "", stderr: "", code: 1 });
	};
	return { calls: () => calls };
};

/** Tests drive child sessions directly; bind one exactly as an admitted parent spawn would. */
const admitChild = (runId: string | undefined, id: string): void => {
	if (runId === undefined) throw new Error("test needs an active run");
	expect(bindLedgerChild(runId, id, "Main", project.root)).toBe(true);
};

/** Applies a run plan once the controller has an active run; the tool reports a non-applied plan as plain "ok". */
const applyRunPlan = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, plan: object): Promise<void> => {
	await until(async () => {
		const reply = await omp.toolReply({ action: "plan", plan }, main);
		return reply.text.includes("실행 계획을 적용했습니다");
	});
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
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		expect(runId).toBeDefined();

		// The director does not edit, notes and control stay open, and a subagent edits freely.
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("director-edit");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "local://notes.md" } }, main))).toBe("pass");
		expect(verdict(await child.emit("tool_call", edit, impl))).toBe("pass");

		// Spawns wait for a plan, then follow it.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("no-plan");
		expect(await omp.tool({ action: "plan", plan: { lanes: [fixLane] } }, main)).toBe("ok");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("route:a/i");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-reviewer", "Rev"), main))).toBe("role-not-in-plan");
		// A spawn decided in a subagent's session sees the same run: the plan's one implementer slot is taken.
		expect(verdict(await child.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl2"), impl))).toBe("role-cap");

		// The subagent's first turn registers it under the run and brings its role's doc rules.
		const section = docPromptFor("storm-implementer", TEAM);
		expect(await child.emit("before_agent_start", { systemPrompt: ["base"] }, impl)).toEqual({ systemPrompt: ["base", section] });
		expect(await child.emit("before_agent_start", { systemPrompt: ["base", section] }, impl)).toBeUndefined();
		expect(listAgents({ runId: runId as string, scope: project.sessionDir }).map(agent => agent.id)).toEqual(["Impl"]);

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
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeDefined();
		// A subagent's result resumes the paused run with a new turn. The declared change result was never observed,
		// so the run stays open and the next round names it instead of closing no-changes.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeDefined();

		await until(async () => (await readRun(project.sessionDir, runId as string))?.costUsd === 0.75);
		const record = await readRun(project.sessionDir, runId as string);
		expect(record).toMatchObject({
			runId: runId as string,
			status: "running",
			costUsd: 0.75,
			mainCostUsd: 0.25,
			maxMainContext: 50_000,
			blockedEdits: 1,
			reads: { director: 2, directorChars: 400, duplicateChars: 100, blocked: 1 },
			plan: { lanes: [{ name: "fix", kind: "code", role: "implementer", results: changeFor("fix-change") }] },
			results: [{ id: "fix-change", lane: "fix", state: "pending" }],
		});
		expect(record?.spawns.map(spawn => spawn.code ?? spawn.outcome)).toEqual(["no-plan", "routed", "role-not-in-plan", "role-cap"]);
		// The manual task name was matched to its unique planned lane without a rewrite.
		expect(record?.spawns.find(spawn => spawn.spawnKey === "Impl" && spawn.outcome === "routed")?.lane).toBe("fix");
		expect(record?.agents).toMatchObject([{ id: "Impl", role: "implementer", state: "idle", followUps: 2, costUsd: 0.5, contextTokens: 30_000, review: { reviews: 1, passed: 1 } }]);

		// With the run closed by the session ending, the main session is ordinary again.
		await omp.emit("session_shutdown", {}, main);
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["x/unapproved"]), main))).toBe("pass");
	});

	test("manual task placement keeps handles, flags only planned isolation and refuses a direct isolated claim", async () => {
		await approve(TEAM);
		const settings = installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": false });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		const planned = await omp.toolReply(
			{
				action: "plan",
				plan: {
					lanes: [
						coreLane,
						{ name: "probe", kind: "run", isolationReason: "keep the experimental result outside the tree", results: changeFor("probe-change") },
					],
					workers: { implementer: 2 },
				},
			},
			main,
		);
		expect(planned.outcome).toBe("ok");

		const probe = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "probe", task: "Probe" } }, main)) as { input: Record<string, unknown> };
		expect(probe.input).toMatchObject({ name: "probe", isolated: true });
		const core = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "core", task: "Core", isolated: true } }, main)) as { input: Record<string, unknown> };
		expect(core.input).toMatchObject({ name: "core" });
		expect(core.input).not.toHaveProperty("isolated");
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", task: "Stray", isolated: true } }, main))).toBe("isolation");
		// Three task calls, one host capability read: the per-run cache holds across shared and selective spawns.
		expect(settings.calls()).toBe(1);
	});

	test("closing the fake host releases its real lease even with an unfinished child session", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("fix it", main);
		const plan = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
		expect(plan.text).toContain("실행 계획을 적용했습니다");
		const runId = activeLedgerRun(project.sessionDir)?.runId;
		admitChild(runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, child.ctx(sub("Impl")));
		expect(listAgents({ scope: project.sessionDir })).toMatchObject([{ id: "Impl", state: "running" }]);

		await shutdownFakeSessions();
		expect(await readRun(project.sessionDir, runId as string)).toMatchObject({ status: "stopped", endReason: "shutdown" });
		const reopened = fakeOmp(project);
		await reopened.command("fix it again", reopened.ctx(MAIN));
		expect(reopened.sent, JSON.stringify(reopened.transcript)).toHaveLength(1);
	});

	test("worker capability is enforced from the effective tools, and nested fencing is run-scoped", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("review task", main);
		expect(omp.sent, JSON.stringify(omp.transcript)).toHaveLength(1);
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: {
						lanes: [{ name: "review", kind: "review", role: "reviewer", goal: "Review the current tree" }],
						workers: { reviewer: 1 },
					},
				},
				main,
			),
		).toBe("ok");
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-reviewer", name: "review", task: "Review" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-reviewer", "review"), main))).toBe("route:b/r:high");
		const reviewer = child.ctx(sub("review", "storm-reviewer"));
		await child.emit("before_agent_start", { systemPrompt: [] }, reviewer);
		// The reviewer definition has bash, but the lane has no write intent: only the enforced read tools pass.
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, reviewer))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "touch x" } }, reviewer))).toBe("lane-capability");
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "x.txt", content: "x" } }, reviewer))).toBe("lane-capability");
		expect(verdict(await child.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", task: "nested" } }, reviewer))).toBe("lane-nested");
		// An unrelated concurrent subagent session has its own artifact tree, no Storm run binding and keeps its own
		// task tool; the managed run's marker is not in that tree.
		const unrelatedArtifacts = path.join(project.tmp, "unrelated-artifacts");
		await mkdir(unrelatedArtifacts, { recursive: true });
		const strangerBase = child.ctx(sub("Stranger", "unrelated"));
		const stranger = {
			...strangerBase,
			sessionManager: { ...strangerBase.sessionManager, getArtifactsDir: () => unrelatedArtifacts },
		} as ExtensionContext;
		expect(verdict(await child.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", task: "own work" } }, stranger))).toBe("pass");
	});

	test("an overlapping shared-write batch is refused whole, and a work follow-up waits for the writer", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: {
						lanes: [
							{ name: "H0", kind: "code", role: "implementer", files: ["shared.txt"], goal: "Hold and accept a follow-up", results: changeFor("h0-change") },
							{ name: "W0", kind: "run", role: "implementer", files: ["shared.txt"], goal: "Write the shared file", results: changeFor("w0-change") },
							{ name: "X0", kind: "code", role: "implementer", files: ["shared.txt"], goal: "Conflict with the writer", results: changeFor("x0-change") },
							{ name: "X1", kind: "code", role: "implementer", files: ["other.txt"], goal: "Independent batch item", results: changeFor("x1-change") },
						],
						workers: { implementer: 3 },
					},
				},
				main,
			),
		).toBe("ok");

		// The holder runs once and settles; its reservation must not outlive its turn.
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "H0", task: "Hold" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "H0"), main))).toBe("route:a/i");
		const holder = child.ctx(sub("H0"));
		await child.emit("before_agent_start", { systemPrompt: [] }, holder);
		await child.emit("agent_end", {}, holder);

		// The writer starts and holds the shared file while its worker is live.
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "W0", task: "Write" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "W0"), main))).toBe("route:a/i");
		const writer = child.ctx(sub("W0"));
		await child.emit("before_agent_start", { systemPrompt: [] }, writer);

		// One overlapping item refuses the whole native batch before any reservation or spawn.
		expect(
			verdict(
				await omp.emit(
					"tool_call",
					{
						toolName: "task",
						input: {
							tasks: [
								{ agent: "storm-implementer", name: "X0", task: "Conflict" },
								{ agent: "storm-implementer", name: "X1", task: "Independent" },
							],
						},
					},
					main,
				),
			),
		).toBe("lane-write");
		// A work follow-up would wake the idle holder into the writer's scope. A quiet progress note wakes the same idle
		// holder, so it meets the same conflict check; refused notes reserve nothing. A read starts no turn.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0", content: "work" } }, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0?progress", content: "status" } }, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0?progress=0", content: "status" } }, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0", content: "work" } }, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "agent://H0" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://all", content: "resume" } }, main))).toBe("lane-capacity");
		// The writer's turn ends: its reservation is released with it.
		await child.emit("agent_end", {}, writer);
		// With the writer gone the holder's work follow-up is admitted; its own turn releases the shared scope.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0", content: "now ok" } }, main))).toBe("pass");
		// A settled agent resumed by agent:// emits agent_start but no before_agent_start; a settled turn alone never ends
		// an admission still awaiting that start.
		await child.emit("agent_start", {}, holder);
		await child.emit("agent_end", {}, holder);
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "X1", task: "Independent" } }, main))).toBe("pass");
		await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "X1"), main);
		const x1 = child.ctx(sub("X1"));
		await child.emit("before_agent_start", { systemPrompt: [] }, x1);
		await child.emit("agent_end", {}, x1);
		// The refused batch left no reservation behind: X0 is admitted once the writer, holder and X1 are gone.
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "X0", task: "Conflict" } }, main))).toBe("pass");
	});

	test("a work follow-up to an idle agent takes the first task's actual authority, so two bash writers never overlap", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: {
						lanes: [
							{ name: "A0", kind: "code", role: "implementer", files: ["a.txt"], goal: "Write a.txt", results: changeFor("a0-change") },
							{ name: "B0", kind: "code", role: "implementer", files: ["b.txt"], goal: "Write b.txt", results: changeFor("b0-change") },
						],
						workers: { implementer: 2 },
					},
				},
				main,
			),
		).toBe("ok");
		// The implementer definition has bash: its declared files cannot bound it, so each first task is one unknown writer.
		const idle: Record<string, ExtensionContext> = {};
		for (const name of ["A0", "B0"]) {
			expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name, task: "Write" } }, main))).toBe("pass");
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", name), main))).toBe("route:a/i");
			idle[name] = child.ctx(sub(name));
			await child.emit("before_agent_start", { systemPrompt: [] }, idle[name]!);
			await child.emit("agent_end", {}, idle[name]!);
		}
		// Reactivating the first idle agent is legal; its turn is the one live writer.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://A0", content: "more work" } }, main))).toBe("pass");
		// Even before the host starts that turn (the agent still looks idle) the admitted write holds its scope.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://B0", content: "more work" } }, main))).toBe("lane-write");
		await child.emit("agent_start", {}, idle.A0!);
		// The second idle agent's disjoint declaration is not authority: bash could touch anything, as for a first task.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://B0", content: "more work" } }, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "agent://B0" } }, main))).toBe("pass");
		await child.emit("agent_end", {}, idle.A0!);
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://B0", content: "more work" } }, main))).toBe("pass");
	});

	test("a read-only lane that is reserved or running refuses a second independent dispatch, and retries cleanly once settled", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: {
						lanes: [
							{ name: "R0", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("r0-answer") },
							{ name: "R1", kind: "explore", role: "explorer", goal: "Read the docs", results: answerFor("r1-answer") },
						],
						workers: { explorer: 2 },
					},
				},
				main,
			),
		).toBe("ok");
		const dispatch = (name: string) => omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name, task: "Read" } }, main);
		// Separate tool call before the host correlates the first spawn: the first attempt is already reserved.
		expect(verdict(await dispatch("R0"))).toBe("pass");
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");
		// A denied native batch accepts nothing: R1 stays free because the batch holding it was refused whole.
		const batch = { toolName: "task", input: { tasks: [{ agent: "storm-explorer", name: "R0", task: "Read" }, { agent: "storm-explorer", name: "R1", task: "Read" }] } };
		expect(verdict(await omp.emit("tool_call", batch, main))).toBe("lane-busy");
		expect(verdict(await dispatch("R1"))).toBe("pass");
		// Correlated and running: still one live attempt.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "R0"), main))).toMatch(/^route:/);
		const reader = child.ctx(sub("R0", "storm-explorer"));
		await child.emit("before_agent_start", { systemPrompt: [] }, reader);
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");
		// Terminal work frees the lane: the clean retry is a fresh dispatch, not a displacement.
		await child.emit("agent_end", {}, reader);
		expect(verdict(await dispatch("R0"))).toBe("pass");
	});

	test("a refused first spawn frees its lane, so the next dispatch of that lane starts instead of reporting busy", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: { lanes: [{ name: "R0", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("r0-answer") }], workers: { explorer: 1 } },
				},
				main,
			),
		).toBe("ok");
		const dispatch = () => omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name: "R0", task: "Read" } }, main);
		expect(verdict(await dispatch())).toBe("pass");
		expect(verdict(await dispatch())).toBe("lane-busy");
		// The host's spawn for that placement is refused: its role is not in the plan.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "R0"), main))).not.toMatch(/^route:|^pass$/);
		expect(verdict(await dispatch())).toBe("pass");
	});

	/** Two spawned, settled explorer lanes: the idle read-only agents a work follow-up can reactivate. */
	async function idleReaders(omp: ReturnType<typeof fakeOmp>, child: ReturnType<typeof fakeOmp>, main: ExtensionContext, names: string[], spawn: string[] = names) {
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: {
						lanes: names.map(name => ({ name, kind: "explore" as const, role: "explorer", goal: `Read ${name}`, results: answerFor(`${name}-answer`) })),
						workers: { explorer: 2 },
					},
				},
				main,
			),
		).toBe("ok");
		const readers: Record<string, ExtensionContext> = {};
		for (const name of spawn) {
			expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name, task: "Read" } }, main))).toBe("pass");
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", name), main))).toMatch(/^route:/);
			readers[name] = child.ctx(sub(name, "storm-explorer"));
			await child.emit("before_agent_start", { systemPrompt: [] }, readers[name]!);
			await child.emit("agent_end", {}, readers[name]!);
		}
		return readers;
	}

	test("a work follow-up holds its read-only lane until the reactivated turn runs; a progress note holds nothing", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		const readers = await idleReaders(omp, child, main, ["R0", "R1"]);
		const dispatch = (name: string) => omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name, task: "Read" } }, main);
		// A quiet note may wake the agent but is not work: the lane stays free for an independent dispatch.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "p1", input: { path: "agent://R1?progress", content: "status" } }, main))).toBe("pass");
		expect(verdict(await dispatch("R1"))).toBe("pass");
		// A work note to the idle agent is admitted; the host has not started the turn yet, so the agent still looks idle.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "f1", input: { path: "agent://R0", content: "look again" } }, main))).toBe("pass");
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");
		// Neither the previous turn's late settle nor an unrelated call's failure releases the newer admission.
		await child.emit("agent_end", {}, readers.R0!);
		await omp.emit("tool_result", { toolName: "write", toolCallId: "other-call", isError: true, input: { path: "agent://R1", content: "x" }, content: [] }, main);
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");
		// The turn starts: the running agent is the reservation; its terminal success frees the lane for a clean retry.
		await child.emit("agent_start", {}, readers.R0!);
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");
		await child.emit("agent_end", {}, readers.R0!);
		expect(verdict(await dispatch("R0"))).toBe("pass");
	});

	test("a failed or cancelled follow-up or task call releases only its own reservation, not by a guessed name", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		await idleReaders(omp, child, main, ["R0", "R2"], ["R0"]);
		const dispatch = (name: string, toolCallId?: string) =>
			omp.emit("tool_call", { toolName: "task", ...(toolCallId === undefined ? {} : { toolCallId }), input: { agent: "storm-explorer", name, task: "Read" } }, main);
		// The host fails the follow-up delivery: the admission window closes with it, and the retry is allowed.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "f2", input: { path: "agent://R0", content: "look again" } }, main))).toBe("pass");
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");
		await omp.emit("tool_result", { toolName: "write", toolCallId: "f2", isError: true, input: { path: "agent://R0", content: "look again" }, content: [] }, main);
		expect(verdict(await dispatch("R0"))).toBe("pass");
		// A failed native task call frees its own placement by its call id even when its echoed input names nothing.
		expect(verdict(await dispatch("R2", "t3"))).toBe("pass");
		expect(verdict(await dispatch("R2", "t4"))).toBe("lane-busy");
		await omp.emit("tool_result", { toolName: "task", toolCallId: "t3", isError: true, input: {}, content: [], details: { results: [] } }, main);
		expect(verdict(await dispatch("R2", "t5"))).toBe("pass");
	});

	test("a resumed agent is observed by its own agent_start, and a blocked call releases exactly its own reservations", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		const readers = await idleReaders(omp, child, main, ["R0", "R1", "R2", "R3"], ["R0", "R1", "R3"]);
		const dispatch = (name: string, toolCallId?: string) =>
			omp.emit("tool_call", { toolName: "task", ...(toolCallId === undefined ? {} : { toolCallId }), input: { agent: "storm-explorer", name, task: "Read" } }, main);
		const follow = (target: string, toolCallId: string) =>
			omp.emit("tool_call", { toolName: "write", toolCallId, input: { path: `agent://${target}`, content: "again" } }, main);
		// A call a hook blocked or the host cancelled ends with isError and no tool_result.
		const ended = (toolCallId: string, toolName: string) => omp.emit("tool_execution_end", { toolCallId, toolName, result: {}, isError: true }, main);
		const state = (id: string) => listAgents({ scope: project.sessionDir }).find(agent => agent.id === id)?.state;

		// A blocked follow-up delivery frees its own hold; the retry places a newer one that late earlier events cannot touch.
		expect(verdict(await follow("R0", "f9"))).toBe("pass");
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");
		await ended("f9", "write");
		expect(verdict(await dispatch("R0", "t-new"))).toBe("pass");
		await ended("f9", "write");
		await omp.emit("tool_result", { toolName: "write", toolCallId: "f9", isError: true, input: { path: "agent://R0", content: "again" }, content: [] }, main);
		expect(verdict(await dispatch("R0"))).toBe("lane-busy");

		// A real resumption: only agent_start fires. A turn that starts and settles before anyone looks still frees its lane.
		expect(verdict(await follow("R3", "f11"))).toBe("pass");
		await child.emit("agent_start", {}, readers.R3!);
		expect(state("R3")).toBe("running");
		await child.emit("agent_end", {}, readers.R3!);
		expect(verdict(await dispatch("R3"))).toBe("pass");

		// Running work is never released by a late failure report of the call that woke it.
		expect(verdict(await follow("R1", "f10"))).toBe("pass");
		await child.emit("agent_start", {}, readers.R1!);
		await ended("f10", "write");
		expect(verdict(await dispatch("R1"))).toBe("lane-busy");
		await child.emit("agent_end", {}, readers.R1!);
		expect(verdict(await dispatch("R1"))).toBe("pass");

		// A task call blocked after placement releases its own placement by call id.
		expect(verdict(await dispatch("R2", "t7"))).toBe("pass");
		expect(verdict(await dispatch("R2", "t8"))).toBe("lane-busy");
		await ended("t7", "task");
		expect(verdict(await dispatch("R2", "t9"))).toBe("pass");
	});

	test("a consumer task fails closed when no prerequisite facts are available", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: {
						lanes: [
							{
								name: "P0",
								kind: "code",
								role: "implementer",
								files: ["out.txt"],
								results: [{ id: "out", kind: "change", criterion: "out.txt holds the result", path: "out.txt", contains: "ok" }],
							},
							{
								name: "C0",
								kind: "explore",
								role: "explorer",
								goal: "Consume the result",
								results: answerFor("c0-answer"),
								dependsOn: [{ lane: "P0", need: "result" }],
							},
						],
						workers: { implementer: 1, explorer: 1 },
					},
				},
				main,
			),
		).toBe("ok");
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name: "C0", task: "Consume" } }, main))).toBe("lane-dependency");
	});

	test("a legacy isolated team isolates manual work and its approved reviewer too", async () => {
		const isolatedTeam: StormConfig = { ...TEAM, isolation: "isolated" };
		await approve(isolatedTeam);
		installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": true });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(
			await omp.tool(
				{
					action: "plan",
					plan: {
						lanes: [
							{ name: "api", kind: "code", results: changeFor("api-change") },
							{ name: "check", kind: "review", role: "reviewer" },
						],
						workers: { implementer: 1, reviewer: 1 },
					},
				},
				main,
			),
		).toBe("ok");
		const work = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "api", task: "Implement" } }, main)) as { input: Record<string, unknown> };
		expect(work.input).toMatchObject({ name: "api", isolated: true });
		const review = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-reviewer", name: "check", task: "Review" } }, main)) as { input: Record<string, unknown> };
		expect(review.input).toMatchObject({ name: "check", isolated: true });
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
		// The default team has no rounds limit, so the live round shows no maximum.
		expect(live).not.toMatch(/\d+\/\d+/);

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
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
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
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
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
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();

		await omp.command("resume me", main);
		const first = activeLedgerRun(project.sessionDir)?.runId;
		expect(first).toBeDefined();
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ runId: first as string, status: "stopped", endReason: "interrupted" });
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();

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
		const second = activeLedgerRun(project.sessionDir)?.runId;
		expect(second).toBeDefined();
		expect(await readRun(project.sessionDir, second as string)).toMatchObject({ status: "running", resumeOf: first, request: "resume me" });
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
		expect(await readRun(project.sessionDir, second as string)).toMatchObject({ status: "done", endReason: "verified" });
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
		await writeRun(project.sessionDir, run);
		await omp.emit("session_start", {}, main);
		// A record in the repository is not a run this machine started.
		expect(omp.statuses.at(-1)).toBe(idle);
		await noteResumePointer((await loadProjectState(project.env)).sessionDir, { repoId: (await loadProjectState(project.env)).repo.repoId, root: project.root }, { ...run, runId: "run-20261120-000000-othr" });
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toBe(idle);
		await noteResumePointer((await loadProjectState(project.env)).sessionDir, { repoId: (await loadProjectState(project.env)).repo.repoId, root: project.root }, run);
		await omp.emit("session_start", {}, main);
		const hinted = omp.statuses.at(-1);
		expect(hinted).not.toBe(idle);
		// The pointer covers the request: an edited one no longer matches.
		await writeRun(project.sessionDir, { ...run, request: "edited-request" });
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
		await writeRun(project.sessionDir, run);
		await noteResumePointer((await loadProjectState(project.env)).sessionDir, { repoId: (await loadProjectState(project.env)).repo.repoId, root: project.root }, run);
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
		await writeConfig(project.sessionDir, { ...TEAM, contextCap: 200_000 });
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
		await writeRun(project.sessionDir, run);
		await noteResumePointer((await loadProjectState(project.env)).sessionDir, { repoId: (await loadProjectState(project.env)).repo.repoId, root: project.root }, run);
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toBe(idle);
	});

	test("session_start closes a dead run and offers it; a live run is left running", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const idle = omp.statuses.at(-1);
		expect(idle).toBeDefined();
		const store = (await loadProjectState(project.env)).sessionDir;
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
		await writeRun(project.sessionDir, dead);
		await noteResumePointer(store, { repoId: (await loadProjectState(project.env)).repo.repoId, root: project.root }, dead);
		await writeRun(project.sessionDir, live);
		await omp.emit("session_start", {}, main);
		expect(await readRun(project.sessionDir, dead.runId)).toMatchObject({ status: "stopped", endedAt: dead.updatedAt });
		expect(await readRun(project.sessionDir, live.runId)).toMatchObject({ status: "running" });
		expect(omp.statuses.at(-1)).not.toBe(idle);

		omp.answers.push(options => options[0]);
		await omp.command("", main);
		expect(omp.sent).toHaveLength(1);
		const resumed = activeLedgerRun(project.sessionDir)?.runId;
		expect(resumed).toBeDefined();
		expect(await readRun(project.sessionDir, resumed as string)).toMatchObject({ resumeOf: dead.runId, request: "dead-request" });
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
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
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
		expect(omp.sent[1]?.split("\n")[0]).toMatch(/ round="2">$/);
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeDefined();

		// The reviewer starts after the change, so its baseline is the tree it is asked to verify.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		setSystemTime(new Date(changedAt + 1_000));
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		const reading = await treeAgainst(project.env.exec, project.root);
		expect(reading).toBeDefined();
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${reading?.state.diff}:${reading?.state.files}`);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeUndefined();
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
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
		const firstRun = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
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
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "done", endReason: "verified", turns: 1 });
		const firstReading = await treeAgainst(project.env.exec, project.root);
		expect(firstReading).toBeDefined();
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${firstReading?.state.diff}:${firstReading?.state.files}`);
		await git(project.root, "add", ".keep");
		await git(project.root, "commit", "-m", "first run verified");

		// Second run, same session: omp emits no before_agent_start for these live agents.
		vi.useFakeTimers();
		const second = first + 60_000;
		setSystemTime(new Date(second));
		await omp.command("second task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		expect(runId).toBeDefined();
		// A reused reviewer has no new spawn in this run; its read-only follow-up needs no write admission or plan.
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
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeDefined();
		// The reused reviewer's verdict resumes the same round and counts in the new run.
		setSystemTime(new Date(second + 1_000));
		await child.emit("tool_result", yielded, rev);
		await child.emit("agent_end", {}, rev);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ runId: runId as string, status: "done", endReason: "verified", turns: 1 });
		const secondReading = await treeAgainst(project.env.exec, project.root);
		expect(secondReading).toBeDefined();
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${secondReading?.state.diff}:${secondReading?.state.files}`);
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
		// A child outside any admitted run has no scope to write a verdict into.
		expect(listAgents({ scope: project.sessionDir })).toHaveLength(0);

		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		admitChild(runId, "Rev");
		await writeFile(path.join(project.root, ".keep"), "changed\n");
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await yieldReview("incorrect");
		await child.emit("agent_end", {}, rev);
		const expected = await treeAgainst(project.env.exec, project.root);
		expect(expected).toBeDefined();
		const pair = `${expected?.state.diff}:${expected?.state.files}`;
		await until(() => listAgents({ scope: project.sessionDir })[0]?.lastVerdict?.tree === pair);
		expect(listAgents({ scope: project.sessionDir })[0]?.lastVerdict).toMatchObject({ correct: false, tree: pair });
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
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		admitChild(runId, "Rev");
		// The reviewer starts against a clean tree, then the tree changes before its verdict.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await writeFile(path.join(project.root, ".keep"), "changed after review start\n");
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict).toMatchObject({ correct: true });
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBeUndefined();
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
		const base = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.base;
		admitChild(activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId, "Rev");

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
		expect(omp.sent[1]?.split("\n")[0]).toMatch(/ round="2">$/);

		// The reviewer starts after the change, so its baseline includes the committed work.
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		// A verdict against that change verifies it; the commit after the run's start did not hide it.
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		await until(() => listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree !== undefined);
		const reading = await treeAgainst(project.env.exec, project.root, base);
		expect(reading).toBeDefined();
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${reading?.state.diff}:${reading?.state.files}`);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("a commit after a passing verdict costs no extra round", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const rev = child.ctx(sub("Rev", "storm-reviewer"));
		await omp.command("task", main);
		const base = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.base;
		admitChild(activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId, "Rev");

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
		await until(() => listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree !== undefined);
		const reading = await treeAgainst(project.env.exec, project.root, base);
		expect(reading).toBeDefined();
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBe(`${reading?.state.diff}:${reading?.state.files}`);
		await git(project.root, "add", ".keep");
		await git(project.root, "commit", "-m", "commit after the verdict");
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("a reviewer in another work tree cannot stamp the run's main tree it never saw", async () => {
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
		const ledger = activeLedgerRun((await loadProjectState(project.env)).sessionDir);
		expect(ledger?.base).toBeDefined();
		admitChild(ledger?.runId, "Rev");

		await writeFile(path.join(project.root, ".keep"), "changed in the main tree\n");
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		const expected = await treeAgainst(project.env.exec, project.root, ledger?.base);
		expect(expected).toBeDefined();
		await until(() => listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict !== undefined);
		// The verdict is real but carries no tree: a reviewer that worked in a copy cannot prove the integrated parent.
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict).toMatchObject({ correct: true });
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Rev")?.lastVerdict?.tree).toBeUndefined();
		// The side work tree is clean: a verdict read from there would not match the run's tree.
		expect((await treeAgainst(project.env.exec, side, ledger?.base))?.state.diff).not.toBe(expected?.state.diff);
		await omp.emit("session_shutdown", {}, main);
	});

	test("an isolated reviewer certifies the integrated tree only while its checkout stays identical", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const side = path.join(project.tmp, "review-copy");
		await git(project.root, "worktree", "add", side, "-b", "review-copy");
		await omp.command("task", main);
		const ledger = activeLedgerRun((await loadProjectState(project.env)).sessionDir);
		admitChild(ledger?.runId, "RevA");
		const rev = { ...child.ctx(sub("RevA", "storm-reviewer")), cwd: side } as ExtensionContext;
		// The isolated copy carries exactly the integrated parent's uncommitted change at review start.
		await writeFile(path.join(project.root, ".keep"), "same uncommitted change\n");
		await writeFile(path.join(side, ".keep"), "same uncommitted change\n");
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		await until(() => listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevA")?.lastVerdict?.tree !== undefined);
		const reading = await treeAgainst(project.env.exec, project.root, ledger?.base);
		expect(reading).toBeDefined();
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevA")?.lastVerdict?.tree).toBe(`${reading?.state.diff}:${reading?.state.files}`);
		// The matching copy is accepted as proof of this exact integrated tree, not just recorded as a verdict.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "done", endReason: "verified" });
	});

	test("a reviewer checkout that changes during review withholds the integrated-tree verdict", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const side = path.join(project.tmp, "review-copy-drift");
		await git(project.root, "worktree", "add", side, "-b", "review-copy-drift");
		await omp.command("task", main);
		admitChild(activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId, "RevB");
		const rev = { ...child.ctx(sub("RevB", "storm-reviewer")), cwd: side } as ExtensionContext;
		await writeFile(path.join(project.root, ".keep"), "reviewed change\n");
		await writeFile(path.join(side, ".keep"), "reviewed change\n");
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await writeFile(path.join(side, ".keep"), "changed in the reviewer copy\n");
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		await until(() => listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevB")?.lastVerdict !== undefined);
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevB")?.lastVerdict).toMatchObject({ correct: true });
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevB")?.lastVerdict?.tree).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("an incomplete reviewer checkout cannot certify even when its content matches", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const side = path.join(project.tmp, "review-copy-incomplete");
		await git(project.root, "worktree", "add", side, "-b", "review-copy-incomplete");
		await omp.command("task", main);
		admitChild(activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId, "RevC");
		const rev = { ...child.ctx(sub("RevC", "storm-reviewer")), cwd: side } as ExtensionContext;
		// A file past the tree reader's content-hash limit makes both fingerprints incomplete, never proof.
		const huge = "x".repeat(2 * 1024 * 1024 + 1);
		await writeFile(path.join(project.root, "huge.bin"), huge);
		await writeFile(path.join(side, "huge.bin"), huge);
		await child.emit("before_agent_start", { systemPrompt: [] }, rev);
		await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
		await child.emit("agent_end", {}, rev);
		await until(() => listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevC")?.lastVerdict !== undefined);
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevC")?.lastVerdict).toMatchObject({ correct: true });
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "RevC")?.lastVerdict?.tree).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("a pending round wait does not send after a session switch", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.command("task", main);
		admitChild(activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		vi.useFakeTimers();
		await writeFile(path.join(project.root, ".keep"), "switch change\n");
		await child.emit("tool_result", { toolName: "edit", input: { path: ".keep" }, isError: false, content: [] }, impl);
		await child.emit("agent_end", {}, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.sent).toHaveLength(1);
		await omp.emit("session_switch", {}, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "stopped", endReason: "shutdown" });
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
		admitChild(activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId, "Impl");
		for (const stopReason of ["error", "aborted", "length"] as const) {
			await child.emit("before_agent_start", { systemPrompt: [] }, impl);
			await child.emit("agent_end", { messages: [{ role: "assistant", stopReason }] }, impl);
			expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Impl")).toMatchObject({ lastWorkFailed: true });
		}
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, impl);
		expect(listAgents({ scope: project.sessionDir }).find(agent => agent.id === "Impl")?.lastWorkFailed).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("the same run without a file change ends no-changes after one round", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		const impl = child.ctx(sub("Impl"));
		admitChild(runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("message_end", assistant("m", "i", 1_000, 0), impl);
		await child.emit("agent_end", {}, impl);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(omp.sent).toHaveLength(1);
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "ended", endReason: "no-changes", turns: 1 });
	});

	test("a planned batch with an unassigned item is refused whole before any child starts", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		await applyRunPlan(omp, main, {
			lanes: [
				{ name: "A", kind: "code", role: "implementer", files: ["a.txt"], results: changeFor("a-change") },
				{ name: "B", kind: "code", role: "implementer", files: ["b.txt"], results: changeFor("b-change") },
				{ name: "C", kind: "code", role: "implementer", files: ["c.txt"], results: changeFor("c-change") },
			],
			workers: { implementer: 3 },
		});
		const batch = {
			toolName: "task",
			input: { tasks: [{ name: "A", agent: "storm-implementer", task: "a" }, { agent: "storm-implementer", task: "unassigned" }] },
		};
		expect(verdict(await omp.emit("tool_call", batch, main))).toBe("lane");
		// No run spawn record exists for the refused batch, and a fully authorized single item still works.
		expect(activeLedgerRun(project.sessionDir)?.plan?.lanes.map(lane => lane.name)).toEqual(["A", "B", "C"]);
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { name: "A", agent: "storm-implementer", task: "a" } }, main))).toBe("pass");
		// eval cannot bypass the native task lane during a managed run.
		expect(verdict(await omp.emit("tool_call", { toolName: "eval", input: { code: "1" } }, main))).toBe("lane");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a follow-up to an agent past its cap is refused and counted; one below it passes", async () => {
		await approve({ ...TEAM, contextCap: 20_000 });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		// Both workers are concrete planned lanes so their follow-ups can resolve to an authorized target.
		await applyRunPlan(omp, main, {
			lanes: [
				{ name: "Big", kind: "code", role: "implementer", files: ["big.txt"], results: changeFor("big-change") },
				{ name: "Small", kind: "code", role: "implementer", files: ["small.txt"], results: changeFor("small-change") },
			],
			workers: { implementer: 2 },
		});
		for (const [id, tokens] of [["Big", 20_000], ["Small", 19_999]] as const) {
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", id), main))).toBe("route:a/i");
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
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "stopped", endReason: "shutdown", blockedFollowUps: 1 });
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

		admitChild(activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		await child.emit("agent_end", {}, impl);
		await child.emit("session_shutdown", {}, impl);
		expect(listAgents({ scope: project.sessionDir })[0]).toMatchObject({ id: "Impl", state: "parked" });
		expect(await lastRun(project.sessionDir)).toBeUndefined();
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeDefined();
		await omp.emit("session_shutdown", {}, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "stopped", endReason: "shutdown" });
	});

	test("a subagent session gets no storm tool, no status line and no tool action", async () => {
		await approve(TEAM);
		const child = fakeOmp(project);
		const impl = child.ctx(sub("Impl"));
		await child.emit("session_start", {}, impl);
		expect(child.activeTools()).not.toContain("storm");
		expect(child.statuses).toEqual([]);
		const refused = await child.toolReply({ action: "status" }, impl);
		expect(refused.outcome).toBe("rejected");
		expect(refused.text).toContain("메인 세션");
	});
});

describe("a subagent's tool results on the ledger", () => {
	test("successful file changes count; failed changes, reads, notes and the main session do not", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.command("task", main);
		admitChild(activeLedgerRun(project.sessionDir)?.runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		const result = (toolName: string, input: unknown, isError = false) =>
			child.emit("tool_result", { toolName, input, isError, content: [] }, impl);

		await result("edit", { path: "src/a.ts" });
		await result("write", { path: "src/b.ts" });
		await result("edit", { path: "src/c.ts" }, true);
		await result("read", { path: "src/a.ts" });
		await result("write", { path: "local://x.md" });
		await omp.emit("tool_result", { toolName: "edit", input: { path: "src/d.ts" }, isError: false, content: [] }, main);

		expect(listAgents({ scope: project.sessionDir })).toHaveLength(1);
		expect(listAgents({ scope: project.sessionDir })[0]).toMatchObject({ id: "Impl", changes: 2 });
		expect(listAgents({ scope: project.sessionDir })[0]?.lastChangeAt).toBeGreaterThan(0);
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

	test("the live native task ceiling bounds a fresh start once, and OMP 0 means unlimited", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		await applyRunPlan(omp, main, {
			lanes: [
				{ name: "A", kind: "code", role: "implementer", files: ["a.txt"], results: changeFor("a-change") },
				{ name: "B", kind: "code", role: "implementer", files: ["b.txt"], results: changeFor("b-change") },
			],
			workers: { implementer: 2 },
		});
		const spawn = (name: string, maxConcurrency: number) =>
			withActiveSettings(Settings.isolated({ "task.maxConcurrency": maxConcurrency }), () =>
				omp.emit("before_subagent_spawn", spawnOf("storm-implementer", name), main));
		expect(verdict(await spawn("A", 1))).toBe("route:a/i");
		// A's reservation fills the one live native slot before any host agent row exists.
		expect(verdict(await spawn("B", 1))).toBe("parallelism");
		// OMP's unlimited value adds no Storm cap of its own.
		expect(verdict(await spawn("B", 0))).toBe("route:a/i");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the approval it checks is at most 2 s old: an edit after approval blocks spawns from then on", async () => {
		setSystemTime(new Date(T0));
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("route:a/i");
		await writeConfig(project.sessionDir, { ...TEAM, contextCap: 150_000 });
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
		expect((await readTrialStates(project.sessionDir)).t1).toMatchObject({ seen: 4, routed: 2, costUsd: 0 });

		// A trial charge needs an attested session: only a worker the run admitted is charged.
		await omp.command("task", main);
		admitChild(activeLedgerRun(project.sessionDir)?.runId, "B");
		await child.emit("message_end", assistant("c", "cand", 1000, 0.4), child.ctx(sub("B")));
		// Not charged: a subagent that was not routed to the trial, the routed one on the role's own model, the main session.
		await child.emit("message_end", assistant("c", "cand", 1000, 9), child.ctx(sub("A")));
		await child.emit("message_end", assistant("a", "i", 1000, 9), child.ctx(sub("B")));
		await omp.emit("message_end", assistant("c", "cand", 1000, 9), main);
		expect((await readTrialStates(project.sessionDir)).t1).toMatchObject({ seen: 4, routed: 2, costUsd: 0.4 });
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
		expect((await lastRun(project.sessionDir))?.spawns).toMatchObject([
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
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeUndefined();
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
		await until(() => activeLedgerRun(project.sessionDir)?.costUsd === 0.2);
		// Only the run's handoff ever reached the session.
		expect(omp.sent).toHaveLength(1);
		await omp.emit("session_shutdown", {}, main);
		expect(await lastRun(project.sessionDir)).toMatchObject({ costUsd: 0.2, mainCostUsd: 0.2 });
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
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeUndefined();
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "stopped", endReason: "shutdown" });
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
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeDefined();
		// Opted out, an active run keeps the legacy director gate: a shell call is not supervisor-blocked.
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "git status" } }, main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the fixed bootstrap is small and catalog-free, adds no message, and auto off leaves no Storm text", async () => {
		await approve({ ...TEAM, jobs: [{ name: "unit-job", argv: ["bun", "test"] }] });
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const started = (await omp.emit(
			"before_agent_start",
			{ reason: "prompt", prompt: "fix the login bug", systemPrompt: ["base"] },
			main,
		)) as { systemPrompt: string[]; message?: unknown };
		// One system block only: believing otherwise would be a paid extra request or a synthetic user turn.
		expect(Object.keys(started)).toEqual(["systemPrompt"]);
		expect(omp.sent).toEqual([]);
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();
		const stormText = started.systemPrompt.slice(1).join("\n");
		// The review baseline was 4,209 B for the two fixed blocks; the budget is 1,300 B.
		expect(Buffer.byteLength(stormText, "utf8")).toBeLessThanOrEqual(1_300);
		expect(stormText).toContain("<storm-auto>");
		expect(stormText).toContain("<storm-decision>");
		// The approved job catalog is live state: it belongs to `storm status`, never to the cached system prompt.
		expect(stormText).not.toContain("unit-job");
		expect(stormText).not.toContain("approved project job names");
		// The same bytes on the next plain turn and on a revived main session.
		expect(await omp.emit("before_agent_start", { reason: "prompt", prompt: "more", systemPrompt: started.systemPrompt }, main)).toBeUndefined();
		const revived = (await omp.emit("before_agent_start", { reason: "revive", prompt: "revived context", systemPrompt: ["base"] }, main)) as {
			systemPrompt: string[];
		};
		expect(revived.systemPrompt.join("\n")).toBe(started.systemPrompt.join("\n"));
		// Auto off and no run: remove the blocks a previous turn added, so the prompt carries no Storm text.
		await writeAutoDelegation((await loadProjectState(project.env)).sessionDir, false);
		expect(await omp.emit("before_agent_start", { reason: "prompt", prompt: "plain chat", systemPrompt: started.systemPrompt }, main)).toEqual({
			systemPrompt: ["base"],
		});
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
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
		expect(reply.outcome).toBe("ok");
		expect(reply.text).toContain("자동 위임 실행");
		const runId = activeLedgerRun(project.sessionDir)?.runId;
		expect(runId).toBeDefined();
		expect(await readRun(project.sessionDir, runId as string)).toMatchObject({
			status: "running",
			request: "fix the login bug",
			plan: { lanes: [{ name: "fix", kind: "code", role: "implementer", results: changeFor("fix-change") }] },
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
		// The declared change result was never observed, so the settled turn stays open and the next round names it.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		expect(activeLedgerRun(project.sessionDir)).toBeDefined();
		await until(async () => {
			const current = await readRun(project.sessionDir, runId as string);
			return current?.results?.some(row => row.id === "fix-change" && row.state === "pending") === true && (current.spawns?.length ?? 0) === 2;
		});
		const record = await readRun(project.sessionDir, runId as string);
		expect(record?.results).toMatchObject([{ id: "fix-change", lane: "fix", state: "pending" }]);
		expect(record?.spawns).toMatchObject([
			{ spawnKey: "fix", agent: "storm-implementer", outcome: "blocked", code: "internal" },
			{ spawnKey: assigned.input.name, agent: "storm-implementer", outcome: "routed", lane: "fix" },
		]);
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("auto");
	});

	test("auto placement reads host isolation only when a plan asks for it, then obeys the planned lane", async () => {
		await approve(TEAM);
		await enableAuto();
		const settings = installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": false });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix it", systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [coreLane] } }, main)).outcome).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId as string;
		const shared = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "core", task: "Core" } }, main)) as { input: { name: string } };
		expect(shared.input.name).toBe(`${runId}-lane-1`);
		// A shared plan is settled by the plan alone: no `omp config list` subprocess and no isolation flag.
		expect(settings.calls()).toBe(0);
		expect(shared.input).not.toHaveProperty("isolated");
		expect(
			(
				await omp.toolReply(
					{
						action: "plan",
						plan: {
							lanes: [
								coreLane,
								{ name: "probe", kind: "run", isolationReason: "keep the experiment isolated", results: changeFor("probe-change") },
							],
							workers: { implementer: 2 },
						},
					},
					main,
				)
			).outcome,
		).toBe("ok");
		const selective = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "probe", task: "Probe", isolated: false } }, main)) as { input: Record<string, unknown> };
		expect(selective.input).toMatchObject({ name: `${runId}-lane-2`, isolated: true });
		expect(settings.calls()).toBe(1);
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
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
		expect(reply.outcome).toBe("ok");
		const runId = activeLedgerRun(project.sessionDir)?.runId;
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
		expect((await readRun(project.sessionDir, runId as string))?.checkpoints).toBeUndefined();
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
		const record = await lastRun(project.sessionDir);
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
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [{ name: "one", kind: "code", results: changeFor("one-change") }] } }, main);
		expect(reply.outcome).toBe("ok");
		expect(omp.compactions).toEqual([]);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		await omp.emit("session_shutdown", {}, main);
		expect((await lastRun(project.sessionDir))?.checkpoints).toBeUndefined();
	});

	test("a wait in a live automatic run starts the checkpoint the plan did not need", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.usage.current = { tokens: 150_000, contextWindow: 400_000, percent: 37 };
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).outcome).toBe("ok");
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
		const record = await lastRun(project.sessionDir);
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
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
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
		expect((await lastRun(project.sessionDir))?.checkpoints).toHaveLength(1);
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
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).outcome).toBe("ok");
		const checkpoint = omp.compactions[0];
		expect(checkpoint).toBeDefined();
		await omp.emit("session_switch", {}, main);
		expect(checkpoint?.options.signal?.aborted).toBe(true);
		checkpoint?.complete();
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
		const record = await lastRun(project.sessionDir);
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
		await omp.emit("before_agent_start", { reason: "revive", prompt: "revived context", systemPrompt: [] }, main);
		await omp.emit("before_agent_start", {
			reason: "prompt",
			prompt: '<storm-run id="old" round="2/2">continue</storm-run>',
			systemPrompt: [],
		}, main);
		const missing = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
		expect(missing.outcome).toBe("rejected");
		expect(missing.text).toContain("사용자 요청을 찾지 못했습니다");
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "new request", systemPrompt: [] }, main);
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
		expect(reply.outcome).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		expect(await readRun(project.sessionDir, runId as string)).toMatchObject({ request: "new request" });
		await omp.emit("session_shutdown", {}, main);
	});

	test("a new user prompt can overlap detached Storm closeout without losing its task", async () => {
		await approve(TEAM);
		await enableAuto();
		const finalizing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const exec = project.env.exec;
		let holdCloseout = false;
		project.env.exec = async (command, args, options) => {
			if (holdCloseout && command === "git" && args.includes("--show-toplevel")) {
				holdCloseout = false;
				finalizing.resolve();
				await release.promise;
			}
			return exec(command, args, options);
		};
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const plan = { action: "plan", plan: { lanes: [fixLane] } };
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "old request", systemPrompt: [] }, main);
		expect((await omp.toolReply(plan, main)).text).toContain("자동 위임 실행");
		await omp.emit("agent_start", {}, main);
		// Hold the old run's cleanup, after it drops the active ledger but before its terminal handler returns.
		holdCloseout = true;
		const ending = omp.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, main);
		await finalizing.promise;
		const next = omp.emit("before_agent_start", { reason: "prompt", prompt: "new request", systemPrompt: [] }, main);
		release.resolve();
		await Promise.all([ending, next]);

		expect((await lastRun(project.sessionDir))?.request).toBe("old request");
		expect((await omp.toolReply(plan, main)).text).toContain("자동 위임 실행");
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		expect(await readRun(project.sessionDir, runId)).toMatchObject({ request: "new request" });
		expect(omp.sent).toEqual([]);
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
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
		expect(reply.outcome).toBe("rejected");
		expect(reply.text).toContain("계획 모드");
		expect(activeLedgerRun((await loadProjectState(project.env)).sessionDir)).toBeUndefined();
	});

	test("broken approval keeps the fence and refuses plans; /storm auto still opts off and unfences", async () => {
		await approve(TEAM);
		const dir = await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "first", systemPrompt: [] }, main);
		await writeConfig(project.sessionDir, { ...TEAM, contextCap: 200_000 });
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "second", systemPrompt: [] }, main);
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, main))).toBe("auto");
		const plan = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
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

describe("closeout action input", () => {
	/** The runtime's one-shot offer, modeled: an exact "1" takes it once; any other input consumes it. */
	let offered: { runId: string; action: CloseoutAction } | undefined;
	let take: ReturnType<typeof spyOn>;
	let start: ReturnType<typeof spyOn>;
	let handoff: ReturnType<typeof spyOn>;
	beforeEach(() => {
		offered = undefined;
		take = spyOn(closeoutModule, "takeCloseoutChoice").mockImplementation((_ctx: ExtensionContext, text: string) => {
			const pick = offered;
			offered = undefined;
			return pick !== undefined && text.trim() === "1" ? pick : undefined;
		});
		start = spyOn(RunController.prototype, "start");
		handoff = spyOn(closeoutModule, "closeoutHandoff").mockImplementation(
			(run: RunRecord) => `${run.runId} 결과: 문서 수정 · 근거 /Users/someone/repo/src/api.ts`,
		);
	});
	afterEach(() => {
		take.mockRestore();
		start.mockRestore();
		handoff.mockRestore();
	});

	const tui = (omp: ReturnType<typeof fakeOmp>): ExtensionContext => ({ ...omp.ctx(MAIN), mode: "tui" }) as ExtensionContext;
	const one = { type: "input", text: "1", source: "interactive" };
	/** A settled run this machine started in this session on the current target, as the runtime's pointer records it. */
	const settledRun = async (runId: string, over: Partial<RunRecord> = {}): Promise<RunRecord> => {
		const state = await loadProjectState(project.env);
		const run = runRecord({
			runId,
			startedAt: "2026-11-20T00:00:00.000Z",
			endedAt: "2026-11-20T00:05:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			task: `${runId} request`,
			request: `${runId} request`,
			...over,
		});
		await writeRun(state.sessionDir, run);
		await noteResumePointer(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }, run);
		return run;
	};
	const specOf = (call = 0): RunSpec | undefined => start.mock.calls[call]?.[1] as RunSpec | undefined;

	test("a numbered new direction starts the user run with the settled run only as its follow-up source", async () => {
		await approve(TEAM);
		const prior = await settledRun("run-20261120-000000-prev", { status: "ended", endReason: "round-limit" });
		const omp = fakeOmp(project);
		const main = tui(omp);
		offered = { runId: prior.runId, action: { kind: "run", label: "응답 계약", task: "응답 계약만 다시 맞추기" } };
		expect(await omp.emit("input", one, main)).toEqual({ handled: true });
		await until(() => omp.sent.length === 1);
		expect(specOf()).toEqual({ task: "응답 계약만 다시 맞추기", followUpOf: prior.runId });
		expect(specOf()?.resumeOf).toBeUndefined();
		expect(omp.sent[0]).toContain("응답 계약만 다시 맞추기");
		expect(omp.activeTools()).toContain("storm");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a numbered resume starts the native resume of exactly the card's run", async () => {
		await approve(TEAM);
		const prior = await settledRun("run-20261120-000000-prev");
		const omp = fakeOmp(project);
		const main = tui(omp);
		offered = { runId: prior.runId, action: { kind: "resume", label: "이어 가기" } };
		expect(await omp.emit("input", one, main)).toEqual({ handled: true });
		await until(() => omp.sent.length === 1);
		expect(specOf()).toMatchObject({ resumeOf: prior.runId });
		expect(specOf()?.followUpOf).toBeUndefined();
		const resumed = activeLedgerRun(project.sessionDir)?.runId;
		expect(await readRun(project.sessionDir, resumed as string)).toMatchObject({ resumeOf: prior.runId, request: prior.request });
		await omp.emit("session_shutdown", {}, main);
	});

	test("a resume whose run is no longer this target's exact candidate starts nothing and never falls back", async () => {
		await approve(TEAM);
		const offeredRun = await settledRun("run-20261120-000000-oldr");
		// A newer unfinished run became the candidate after the card was shown: it is not a substitute.
		await settledRun("run-20261120-010000-newr", { startedAt: "2026-11-20T01:00:00.000Z" });
		// A run with no pointer for this target was never this session's to continue.
		const state = await loadProjectState(project.env);
		const foreign = runRecord({ runId: "run-20261120-020000-frgn", startedAt: "2026-11-20T02:00:00.000Z", status: "stopped", endReason: "interrupted", request: "foreign" });
		await writeRun(state.sessionDir, foreign);
		const omp = fakeOmp(project);
		const main = tui(omp);
		for (const runId of [offeredRun.runId, foreign.runId]) {
			const before = omp.notices.length;
			offered = { runId, action: { kind: "resume", label: "이어 가기" } };
			expect(await omp.emit("input", one, main)).toEqual({ handled: true });
			await until(() => omp.notices.length > before);
			expect(omp.notices.at(-1)).toMatchObject({ level: "warning" });
			expect(omp.notices.at(-1)?.text).toContain("이어 갈 실행이 아닙니다");
		}
		expect(start).not.toHaveBeenCalled();
		expect(omp.sent).toHaveLength(0);
	});

	test("a resume needs an approved team and a conversation that did not change while it was checked", async () => {
		const prior = await settledRun("run-20261120-000000-prev");
		const omp = fakeOmp(project);
		const main = tui(omp);
		offered = { runId: prior.runId, action: { kind: "resume", label: "이어 가기" } };
		expect(await omp.emit("input", one, main)).toEqual({ handled: true });
		await until(() => omp.notices.length === 1);
		expect(omp.notices[0]?.text).toContain("승인");

		await approve(TEAM);
		offered = { runId: prior.runId, action: { kind: "resume", label: "이어 가기" } };
		expect(await omp.emit("input", one, main)).toEqual({ handled: true });
		// The conversation changes before the candidate is read back: the pick belongs to the old one.
		await omp.emit("session_switch", { reason: "new" }, main);
		await until(() => omp.notices.some(notice => notice.text.includes("대화가 바뀌어")));
		expect(start).not.toHaveBeenCalled();
		expect(omp.sent).toHaveLength(0);
	});

	test("only direct TUI input of this main session reads the offer; images and a busy turn consume it unstarted", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = tui(omp);
		const action: CloseoutAction = { kind: "run", label: "다음", task: "다음 작업" };
		offered = { runId: "run-20261120-000000-prev", action };
		// Another host's ordinary input, extension text, a subagent and a host without UI never read it at all.
		expect(await omp.emit("input", one, omp.ctx(MAIN))).toBeUndefined();
		expect(await omp.emit("input", { ...one, source: "extension" }, main)).toBeUndefined();
		expect(await omp.emit("input", one, { ...omp.ctx(sub("Other")), mode: "tui" } as ExtensionContext)).toBeUndefined();
		expect(await omp.emit("input", one, { ...main, hasUI: false } as ExtensionContext)).toBeUndefined();
		expect(take).not.toHaveBeenCalled();
		expect(offered).toBeDefined();

		// An image is not a pick: the offer is consumed and nothing starts.
		const image = { ...one, images: [{ type: "image", data: "AA==", mimeType: "image/png" }] };
		expect(await omp.emit("input", image, main)).toBeUndefined();
		expect(offered).toBeUndefined();
		// A busy session also consumes without starting.
		offered = { runId: "run-20261120-000000-prev", action };
		omp.idle.value = false;
		expect(await omp.emit("input", one, main)).toBeUndefined();
		omp.idle.value = true;
		// Any other real input consumes it too, and the next number misses.
		offered = { runId: "run-20261120-000000-prev", action };
		expect(await omp.emit("input", { ...one, text: "hello" }, main)).toBeUndefined();
		expect(await omp.emit("input", one, main)).toBeUndefined();
		expect(start).not.toHaveBeenCalled();
		expect(omp.sent).toHaveLength(0);
	});

	test("a pick while a run is active is refused, not queued", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = tui(omp);
		await omp.command("first work", omp.ctx(MAIN));
		expect(omp.sent).toHaveLength(1);
		offered = { runId: "run-20261120-000000-prev", action: { kind: "run", label: "다음", task: "다음 작업" } };
		const before = omp.notices.length;
		expect(await omp.emit("input", one, main)).toEqual({ handled: true });
		expect(omp.sent).toHaveLength(1);
		expect(omp.notices.length).toBe(before + 1);
		expect(omp.notices.at(-1)?.text).toContain("이미 Storm 실행");
		await omp.emit("session_shutdown", {}, main);
	});

	test("compaction restores the bounded handoff only for the active run's own trusted follow-up source", async () => {
		await approve(TEAM);
		const prior = await settledRun("run-20261120-000000-prev", { status: "ended", endReason: "round-limit" });
		const omp = fakeOmp(project);
		const main = tui(omp);
		// Idle: no run, no recap of the settled one.
		expect(await omp.emit("session.compacting", { type: "session.compacting", sessionId: project.sessionId, messages: [] }, main)).toBeUndefined();
		expect(handoff).not.toHaveBeenCalled();

		offered = { runId: prior.runId, action: { kind: "run", label: "다음", task: "응답 계약만 다시 맞추기" } };
		expect(await omp.emit("input", one, main)).toEqual({ handled: true });
		await until(() => omp.sent.length === 1);
		const compacted = (await omp.emit("session.compacting", { type: "session.compacting", sessionId: project.sessionId, messages: [] }, main)) as { context: string[] };
		const text = compacted.context.join("\n");
		expect(text).toContain("Storm 실행");
		expect(text.match(/Storm 이전 실행 인수인계/g)).toHaveLength(1);
		expect(text).toContain(`${prior.runId} 결과: 문서 수정`);
		expect(text).not.toContain("/Users/someone");

		// A source record that no longer matches its pointer is not trusted: the working state stays, the handoff does not.
		await writeRun(project.sessionDir, { ...prior, request: "rewritten elsewhere" });
		const untrusted = (await omp.emit("session.compacting", { type: "session.compacting", sessionId: project.sessionId, messages: [] }, main)) as { context: string[] };
		expect(untrusted.context.join("\n")).toContain("Storm 실행");
		expect(untrusted.context.join("\n")).not.toContain("인수인계");
		await omp.emit("session_shutdown", {}, main);
	});

	test("an unrelated run's compaction carries no earlier run's handoff", async () => {
		await approve(TEAM);
		await settledRun("run-20261120-000000-prev", { status: "ended", endReason: "round-limit" });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("unrelated work", main);
		const compacted = (await omp.emit("session.compacting", { type: "session.compacting", sessionId: project.sessionId, messages: [] }, main)) as { context: string[] };
		expect(compacted.context.join("\n")).toContain("unrelated work");
		expect(compacted.context.join("\n")).not.toContain("인수인계");
		expect(handoff).not.toHaveBeenCalled();
		await omp.emit("session_shutdown", {}, main);
	});
});

describe("replan preflight", () => {
	test("a reused lane's changed identity is refused before any out-of-bounds team proposal opens", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("fix it", main);
		const first = await omp.toolReply({ action: "plan", plan: { lanes: [{ ...fixLane, goal: "ship it" }] } }, main);
		expect(first.outcome).toBe("ok");
		omp.answers.push(APPROVE);
		const again = await omp.toolReply(
			{ action: "plan", plan: { lanes: [{ ...fixLane, goal: "other scope" }], workers: { implementer: 5 } } },
			main,
		);
		expect(again.outcome).toBe("rejected");
		expect(again.text).toContain("fix");
		expect(again.text).toContain("progress");
		expect(omp.selects).toEqual([]);
		expect(omp.answers).toHaveLength(1);
		await omp.emit("session_shutdown", {}, main);
	});

	test("a fresh mixed plan that omits one lane's results never replaces the run plan", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("fix it", main);
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [coreLane] } }, main)).outcome).toBe("ok");
		const mixed = await omp.toolReply(
			{ action: "plan", plan: { lanes: [coreLane, { name: "writer", kind: "run", goal: "Write the second file" }] } },
			main,
		);
		expect(mixed.outcome).toBe("rejected");
		expect(mixed.text).toContain("'writer'");
		expect(omp.selects).toEqual([]);
		const ledger = activeLedgerRun(project.sessionDir);
		const runId = ledger?.runId;
		expect(runId).toBeDefined();
		expect(ledger?.plan?.lanes.map(lane => lane.name)).toEqual(["core"]);
		await until(async () => (await readRun(project.sessionDir, runId as string))?.plan?.lanes.length === 1);
		const record = await readRun(project.sessionDir, runId as string);
		expect(record?.plan?.lanes.map(lane => lane.name)).toEqual(["core"]);
		expect((record?.results ?? []).some(row => row.lane === "writer")).toBe(false);
		await omp.emit("session_shutdown", {}, main);
	});
});

describe("native attempt evidence through the extension hooks", () => {
	test("a sync task result is evaluated against the lane contract and held on the run record", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("write the report", main);
		expect(await omp.tool({
			action: "plan",
			plan: {
				lanes: [{
					name: "fix",
					kind: "code",
					files: ["report.json"],
					results: [{ id: "report", kind: "change", criterion: "report.json holds the total", path: "report.json", contains: '"total": 42' }],
				}],
				workers: { implementer: 1 },
			},
		}, main)).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		expect(runId).toBeDefined();
		if (runId === undefined) return;

		expect(verdict(await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_1",
			input: { agent: "storm-implementer", name: "fix", task: "Write report.json" },
		}, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "fix"), main))).toBe("route:a/i");

		// The host child actually wrote the declared path; the report's own success claim is not the verdict.
		await writeFile(path.join(project.root, "report.json"), '{\n  "total": 42\n}\n');
		await omp.emit("tool_result", {
			toolName: "task",
			toolCallId: "call_1",
			isError: false,
			content: [{ type: "text", text: "wrote report.json" }],
			details: {
				results: [{
					id: "fix",
					exitCode: 0,
					output: "wrote report.json",
					structuredOutput: { status: "valid" },
				}],
			},
		}, main);

		await until(async () => {
			const record = await readRun(project.sessionDir, runId);
			return record?.results?.some(row => row.id === "report" && row.state === "accepted") === true;
		});
		const record = await readRun(project.sessionDir, runId);
		expect(record?.results?.find(row => row.id === "report")).toMatchObject({
			lane: "fix",
			state: "accepted",
			attemptId: "task:call_1:fix",
			origin: "attempt",
		});
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);

	test("an async result is read from its delivery, cites a real source and holds on the run", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("read the total", main);
		expect(await omp.tool({
			action: "plan",
			plan: {
				lanes: [{
					name: "look",
					kind: "explore",
					files: ["notes.md"],
					results: [{ id: "total", kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }],
				}],
				workers: { explorer: 1 },
			},
		}, main)).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		expect(runId).toBeDefined();
		if (runId === undefined) return;

		expect(verdict(await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_2",
			input: { agent: "storm-explorer", name: "look", task: "Read notes.md" },
		}, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "look"), main))).toBe("route:a/x:low,b/z:low");
		// The native progress frame is bound to this exact tool call; a success after a retry must remain accepted.
		await omp.emit("tool_execution_update", {
			toolName: "task",
			toolCallId: "call_2",
			partialResult: { details: { progress: [{ id: "look", status: "running", retryFailure: { attempt: 1 } }] } },
		}, main);
		await omp.emit("message_end", {
			message: {
				customType: "async-result",
				content: "The total is 42 (notes.md:1)",
				details: {
					jobs: [{
						jobId: "job_1",
						agentId: "look",
						status: "completed",
						schema: { status: "valid", data: { citations: [{ path: "notes.md", line: 1, quote: "total: 42" }] } },
					}],
				},
			},
		}, main);

		await until(async () => {
			const record = await readRun(project.sessionDir, runId);
			return record?.results?.some(row => row.id === "total" && row.state === "accepted") === true;
		});
		const record = await readRun(project.sessionDir, runId);
		expect(record?.results?.find(row => row.id === "total")).toMatchObject({
			lane: "look",
			state: "accepted",
			attemptId: "job:job_1:look",
			origin: "attempt",
		});
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);
	test("a reviewable answer reaches only the approved reviewer's task as its scoped packet", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "notes.md"), "the total is 42\n");
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("read and review the total", main);
		expect(await omp.tool({
			action: "plan",
			plan: {
				lanes: [
					{
						name: "look",
						kind: "explore",
						files: ["notes.md"],
						results: [{ id: "total", kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }],
					},
					{ name: "check", kind: "review", role: "reviewer", goal: "Judge the answer" },
				],
				workers: { explorer: 1, reviewer: 1 },
			},
		}, main)).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		expect(runId).toBeDefined();
		if (runId === undefined) return;

		// The explorer's own task is never given a packet.
		expect(await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_3",
			input: { agent: "storm-explorer", name: "look", task: "Read notes.md" },
		}, main)).toBeUndefined();
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "look"), main))).toBe("route:a/x:low,b/z:low");
		// Prose that repeats the cited number is a reviewable submission, not a machine acceptance.
		const answer = "the total is 42, see notes.md:1";
		await omp.emit("message_end", {
			message: {
				customType: "async-result",
				content: answer,
				details: {
					jobs: [{
						jobId: "job_3",
						agentId: "look",
						status: "completed",
						schema: { status: "valid", data: { citations: [{ path: "notes.md", line: 1, quote: "42" }] } },
					}],
				},
			},
		}, main);
		await until(async () => {
			const record = await readRun(project.sessionDir, runId);
			return record?.results?.some(row => row.id === "total" && row.state === "reviewable") === true;
		});

		const review = await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_4",
			input: { agent: "storm-reviewer", name: "check", task: "Review the answer" },
		}, main) as { input?: Record<string, unknown> } | undefined;
		const task = String(review?.input?.task ?? "");
		expect(task.startsWith("Review the answer\n\n[storm:answer-review]")).toBe(true);
		expect(task).toContain(answer);
		expect(task).toContain('"id": "total"');
		expect(task).toMatch(/"receipt": "[0-9a-f]{32}"/);
		expect(task).toContain('"citation": "notes.md:1"');
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);
});

describe("native session ownership", () => {
	test("a fresh native session starts clean, a foreign one never sees the team, and reopening the exact id returns it", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toContain("대기");
		expect(omp.activeTools()).toContain("storm");

		omp.setSessionId("session-foreign");
		await omp.emit("session_switch", { reason: "new" }, main);
		expect(omp.statuses.at(-1)).toBeUndefined();
		expect(omp.activeTools()).not.toContain("storm");

		// A resume of the exact same native id opens that id's own store again.
		omp.setSessionId(project.sessionId);
		await omp.emit("session_switch", { reason: "resume" }, main);
		expect(omp.statuses.at(-1)).toContain("대기");
		expect(omp.activeTools()).toContain("storm");
	});

	test("automatic consent and its task are read from each session, not carried by a switch", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const prompt = () => omp.emit("before_agent_start", { reason: "prompt", prompt: "list the files", systemPrompt: [] }, main);
		const injected = async (): Promise<boolean> => {
			const answer = (await prompt()) as { systemPrompt?: string[] } | undefined;
			return answer?.systemPrompt?.some(section => section.includes("<storm-auto>")) === true;
		};
		expect(await injected()).toBe(true);
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, main))).toBe("auto");

		omp.setSessionId("session-other");
		await omp.emit("session_switch", { reason: "new" }, main);
		expect(await injected()).toBe(false);
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, main))).toBe("pass");

		omp.setSessionId(project.sessionId);
		await omp.emit("session_switch", { reason: "resume" }, main);
		expect(await injected()).toBe(true);
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, main))).toBe("auto");
	});

	test("a context clear and a branch end the run the same way a switch does", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("first task", main);
		expect(activeLedgerRun(project.sessionDir)).toBeDefined();
		await omp.emit("session_clear", {}, main);
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "stopped", endReason: "shutdown" });

		await omp.command("second task", main);
		expect(activeLedgerRun(project.sessionDir)).toBeDefined();
		await omp.emit("session_branch", { reason: "fork" }, main);
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();
		expect(await lastRun(project.sessionDir)).toMatchObject({ status: "stopped", endReason: "shutdown" });
	});

	test("a host without a session id leaves an ordinary conversation alone and fails Storm closed", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.setSessionId(undefined);
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toBeUndefined();
		expect(omp.activeTools()).not.toContain("storm");
		expect(await omp.emit("before_agent_start", { reason: "prompt", prompt: "hello", systemPrompt: [] }, main)).toBeUndefined();
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, main))).toBe("pass");

		const tool = await omp.toolReply({ action: "status" }, main);
		expect(tool.outcome).toBe("rejected");
		expect(tool.text).toContain("세션");
		await omp.command("status", main);
		expect(JSON.stringify(omp.transcript.at(-1))).toContain("세션");
	});

	test("moving one session to another target does not carry its approval", async () => {
		await approve(TEAM);
		const other = path.join(project.tmp, "other-target");
		await mkdir(other, { recursive: true });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		expect(omp.statuses.at(-1)).toContain("대기");

		await omp.emit("session_switch", { reason: "new" }, { ...main, cwd: other } as ExtensionContext);
		expect(omp.statuses.at(-1)).toContain("승인 필요");
		// The session's own team survived, but the other work tree was never approved.
		expect((await loadProjectState({ ...project.env, cwd: other })).config.status).toBe("ok");

		await omp.emit("session_switch", { reason: "resume" }, main);
		expect(omp.statuses.at(-1)).toContain("대기");
	});

	test("an out-of-bounds plan opens no dialog and writes neither the old nor a new session", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const reply = await omp.toolReply({ action: "plan", plan: { lanes: [coreLane], workers: { implementer: 5 } } }, main);
		expect(reply.outcome).toBe("rejected");
		expect(reply.text).toContain("승인된");
		expect(omp.selects).toHaveLength(0);
		expect((await loadProjectState({ ...project.env, sessionId: "session-next" })).config.status).toBe("missing");
		const original = await loadProjectState(project.env);
		expect(original.config.status).toBe("ok");
		expect(await original.store.list()).toHaveLength(1);
	});

	test("the agent list is the run's session only; a sibling session never sees its worker", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.emit("session_start", {}, main);
		await omp.command("task", main);
		const runId = activeLedgerRun(project.sessionDir)?.runId;
		admitChild(runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		expect((await omp.toolReply({ action: "agents" }, main)).text).toContain("Impl");

		omp.setSessionId("session-sibling");
		await omp.emit("session_switch", { reason: "new" }, main);
		expect((await omp.toolReply({ action: "agents" }, main)).text).not.toContain("Impl");
		await omp.emit("session_shutdown", {}, main);
	});
});

describe("persisted worker authority across module boundaries", () => {
	const admit = (over: { childId: string; runId: string; policy: Parameters<typeof persistWorkerAdmission>[0]["policy"]; lane?: string }) =>
		persistWorkerAdmission({
			agentDir: project.agentDir,
			artifactRoot: project.root,
			parentId: "Main",
			childId: over.childId,
			runId: over.runId,
			sessionId: project.sessionId,
			sessionDir: project.sessionDir,
			repoId: "dir-project-test",
			targetRoot: project.root,
			...(over.lane === undefined ? {} : { lane: over.lane }),
			policy: over.policy,
		});

	test("a rebound child enforces path scope from the parent admission with no in-process map", async () => {
		await approve(TEAM);
		const runId = "run-admission-test";
		await admit({ childId: "Impl", runId, lane: "fix", policy: { kind: "paths", paths: ["allowed.txt"], reason: "test lane" } });
		const child = fakeOmp(project);
		const impl = child.ctx(sub("Impl"));
		const write = (path: string) => child.emit("tool_call", { toolName: "write", input: { path, content: "x" } }, impl);
		expect(verdict(await write("allowed.txt"))).toBe("pass");
		expect(verdict(await write("outside.txt"))).toBe("lane-scope");
		expect(verdict(await child.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", task: "nested" } }, impl))).toBe("lane-nested");
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "allowed.txt" } }, impl))).toBe("pass");

		await revokeWorkerAdmissions(project.agentDir, { runId });
		expect(verdict(await write("allowed.txt"))).toBe("authority");
	});

	test("the parent persists an approved lane before spawn and revokes it when the run ends", async () => {
		await pathOnlyImplementer();
		await approveShadows(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const impl = child.ctx(sub("Impl"));
		await omp.emit("session_start", {}, main);
		await omp.command("task", main);
		await applyRunPlan(omp, main, { lanes: [{ ...fixLane, files: ["allowed.txt"] }] });
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("route:a/i");
		const record = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: "Impl" });
		expect(record).toMatchObject({ kind: "record", record: { lane: "fix", policy: { kind: "paths", paths: ["allowed.txt"] } } });

		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "allowed.txt", content: "x" } }, impl))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "outside.txt", content: "x" } }, impl))).toBe("lane-scope");

		// A different child of the same active managed tree has no admission: writes fail closed, reads stay ordinary.
		const stray = child.ctx(sub("Stray", "unrelated"));
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "stray.txt", content: "x" } }, stray))).toBe("authority");
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "allowed.txt" } }, stray))).toBe("pass");

		await omp.emit("session_shutdown", {}, main);
		expect(await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: "Impl" })).toMatchObject({
			kind: "record",
			record: { revokedAt: expect.any(Number) },
		});
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "allowed.txt", content: "x" } }, impl))).toBe("authority");
	});

	test("a pooled or unattributed child cannot spawn into an active managed tree, while another tree stays ordinary", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("task", main);
		await applyRunPlan(omp, main, { lanes: [fixLane] });
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("route:a/i");
		const pooled = child.ctx(sub("Pooled", "unrelated"));
		const nested = { agent: "custom-worker", invocationKind: "task" as const, patterns: [], spawnKey: "Nested" };
		expect(verdict(await child.emit("before_subagent_spawn", nested, pooled))).toBe("internal");

		const otherArtifacts = path.join(project.tmp, "other-artifacts");
		await mkdir(otherArtifacts, { recursive: true });
		const strangerBase = child.ctx(sub("Stranger", "unrelated"));
		const stranger = {
			...strangerBase,
			sessionManager: { ...strangerBase.sessionManager, getArtifactsDir: () => otherArtifacts },
		} as ExtensionContext;
		expect(verdict(await child.emit("before_subagent_spawn", nested, stranger))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a selective isolated lane is bound to its exact checkout and cannot write the parent", async () => {
		await pathOnlyImplementer();
		await approveShadows(TEAM);
		installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": false });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const base = child.ctx(sub("Probe"));
		const privateDir = path.join(project.tmp, "private-checkout");
		const movedDir = path.join(project.tmp, "moved-checkout");
		await mkdir(privateDir, { recursive: true });
		await mkdir(movedDir, { recursive: true });
		const probe = { ...base, cwd: privateDir } as ExtensionContext;
		const moved = { ...base, cwd: movedDir } as ExtensionContext;
		await omp.emit("session_start", {}, main);
		await omp.command("task", main);
		await applyRunPlan(omp, main, {
			lanes: [{ name: "probe", kind: "run", role: "implementer", isolationReason: "independent experiment", files: ["allowed.txt"], results: changeFor("probe-change") }],
		});
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Probe"), main))).toBe("route:a/i");

		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "allowed.txt", content: "x" } }, probe))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: path.join(project.root, "outside.txt"), content: "x" } }, probe))).toBe("lane-scope");
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "../outside.txt", content: "x" } }, probe))).toBe("lane-scope");
		// The attempt is bound to the first claimed checkout; a different cwd cannot inherit it.
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "allowed.txt", content: "x" } }, moved))).toBe("authority");
		await omp.emit("session_shutdown", {}, main);
	});
});

describe("native ask decisions", () => {
	const form = (key: string, reason: string, body = '<label><input type="radio" name="choice" value="go"> Go</label>') =>
		({ html: `<form data-storm-decision="${key}" data-storm-reason="${reason}">${body}</form>` });
	const askCall = (input: unknown) => ({ toolName: "ask", input });
	const ask = (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, input: unknown) => omp.emit("tool_call", askCall(input), main);

	test("a manual run admits one marked decision, preserves the native wait and cancel, and never reads silence as consent", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		// Before a run this is an ordinary session: its ask stays the host's and no Storm decision section appears.
		expect(verdict(await ask(omp, main, { html: "<form><p>ordinary</p></form>" }))).toBe("pass");
		expect(await omp.emit("before_agent_start", { reason: "prompt", prompt: "ordinary prompt", systemPrompt: ["base"] }, main)).toBeUndefined();

		await omp.command("manual task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId as string;
		expect(runId).toBeDefined();
		// The manual director gets the shared contract as a stable system section, not in the brief handoff.
		const manual = (await omp.emit("before_agent_start", { reason: "prompt", prompt: "manual task", systemPrompt: ["base"] }, main)) as
			| { systemPrompt?: string[] }
			| undefined;
		const manualPrompt = manual?.systemPrompt ?? [];
		expect(manualPrompt.at(-1)).toContain("<storm-decision>");
		expect(manualPrompt.join("\n")).toContain("data-storm-decision");
		expect(manualPrompt.join("\n")).toContain("irreversible");
		expect(manualPrompt.join("\n")).toContain("work that is ready first");
		expect(await omp.emit("before_agent_start", { reason: "prompt", prompt: "manual task", systemPrompt: manualPrompt }, main)).toBeUndefined();

		// Routine confirmation without the marker, a literal reason list, and a bare string are declined as feedback.
		expect(verdict(await ask(omp, main, { html: "<form><p>Run the tests?</p></form>" }))).toBe("ask-contract");
		expect(verdict(await ask(omp, main, { html: '<form data-storm-decision="tests" data-storm-reason="scope-change|user-choice">' }))).toBe("ask-contract");
		expect(verdict(await ask(omp, main, { html: '<form data-storm-decision="has space" data-storm-reason="user-choice">' }))).toBe("ask-contract");
		expect(verdict(await ask(omp, main, "one question"))).toBe("ask-contract");
		expect(verdict(await ask(omp, main, { questions: [{ id: "q", question: "Proceed?" }] }))).toBe("ask-contract");

		// A genuine user choice is left to the host: the form opens a real wait, and cancel closes it.
		const choice = form("pick-store", "user-choice", '<label><input type="radio" name="store" value="sqlite" checked> SQLite</label>');
		const before = await readRun(project.sessionDir, runId);
		expect(verdict(await ask(omp, main, choice))).toBe("pass");
		await omp.emit("tool_execution_start", { toolCallId: "pick-store-1", toolName: "ask", args: choice }, main);
		expect(omp.statuses.at(-1)).toContain("응답 대기");
		await omp.emit("tool_execution_end", { toolCallId: "pick-store-1", toolName: "ask", result: { details: { timedOut: true } }, isError: true }, main);
		expect(omp.statuses.at(-1)).toContain("진행 중");
		// A timeout or cancel leaves the run untouched and does not turn into an approval.
		const after = await readRun(project.sessionDir, runId);
		expect(after?.status).toBe("running");
		expect(after?.results).toEqual(before?.results);
		expect(after?.closeout).toBeUndefined();

		// A timeout with no answer is also not consent, and the run stays exactly as it was.
		const timeout = form("pick-timeout", "user-choice");
		expect(verdict(await ask(omp, main, timeout))).toBe("pass");
		await omp.emit("tool_execution_start", { toolCallId: "pick-timeout-1", toolName: "ask", args: timeout }, main);
		await omp.emit("tool_execution_end", { toolCallId: "pick-timeout-1", toolName: "ask", result: { details: { answers: [], timedOut: true } }, isError: false }, main);
		const afterTimeout = await readRun(project.sessionDir, runId);
		expect(afterTimeout?.status).toBe("running");
		expect(afterTimeout?.results).toEqual(before?.results);
		expect(afterTimeout?.closeout).toBeUndefined();
		expect(verdict(await ask(omp, main, timeout))).toBe("ask-repeat");

		// The same decision after cancellation/settlement is not asked again; a different one is still reachable.
		expect(verdict(await ask(omp, main, choice))).toBe("ask-repeat");
		expect(verdict(await ask(omp, main, form("pick-reviewer", "user-choice")))).toBe("pass");

		// A high-risk form with a default that silence could submit is refused; a safe form for the same key is allowed.
		const riskyDefault = form("delete-branch", "irreversible-action", '<label><input type="radio" name="go" value="yes" checked> Delete</label>');
		expect(verdict(await ask(omp, main, riskyDefault))).toBe("ask-default");
		expect(verdict(await ask(omp, main, form("delete-branch", "irreversible-action")))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("auto work gates one decision per user request across rounds, while another session or generation starts clean", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const prompt = (text: string) => omp.emit("before_agent_start", { reason: "prompt", prompt: text, systemPrompt: [] }, main);
		const started = (await prompt("fix the login bug")) as { systemPrompt: string[] };
		const assembled = started.systemPrompt.join("\n");
		expect(assembled).toContain("<storm-auto>");
		expect(assembled).toContain("<storm-decision>");
		expect(assembled).toContain("data-storm-decision");
		expect(assembled).toContain("timeout or cancel is not consent");

		const decision = form("deploy-window", "user-choice");
		expect(verdict(await ask(omp, main, decision))).toBe("pass");
		expect(verdict(await ask(omp, main, decision))).toBe("ask-repeat");

		// The first plan opens the run inside the same user request; the repeat stays refused.
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).outcome).toBe("ok");
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		expect(verdict(await ask(omp, main, decision))).toBe("ask-repeat");

		// A Storm round is the same request.
		await omp.emit("before_agent_start", { reason: "prompt", prompt: `<storm-run id="${runId}" round="2/2">continue</storm-run>`, systemPrompt: [] }, main);
		expect(verdict(await ask(omp, main, decision))).toBe("ask-repeat");

		// Another native session has its own request and does not inherit this key.
		await writeAutoDelegation(sessionStoreDir(project.agentDir, "session-other"), true);
		omp.setSessionId("session-other");
		await omp.emit("session_switch", { reason: "new" }, main);
		await prompt("other task");
		expect(verdict(await ask(omp, main, decision))).toBe("pass");

		// A new prompt in the original session is a new request too, not the old generation.
		omp.setSessionId(project.sessionId);
		await omp.emit("session_switch", { reason: "resume" }, main);
		await prompt("resume task");
		expect(verdict(await ask(omp, main, decision))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a managed worker cannot ask; persisted and closed admissions still prove management while an unrelated child stays ordinary", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("manual task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId as string;
		admitChild(runId, "Impl");
		const decision = form("worker-choice", "user-choice");

		// The in-memory run binding is enough, before the tool can open a form.
		const impl = child.ctx(sub("Impl"));
		await child.emit("before_agent_start", { systemPrompt: [] }, impl);
		expect(verdict(await child.emit("tool_call", askCall(decision), impl))).toBe("worker-ask");

		// A persisted admission from another host thread is the same management.
		await persistWorkerAdmission({
			agentDir: project.agentDir,
			artifactRoot: project.root,
			parentId: "Main",
			childId: "Pooled",
			runId,
			sessionId: project.sessionId,
			sessionDir: project.sessionDir,
			repoId: "dir-project-test",
			targetRoot: project.root,
			policy: { kind: "read", reason: "test read lane" },
		});
		const pooled = child.ctx(sub("Pooled"));
		expect(verdict(await child.emit("tool_call", askCall(decision), pooled))).toBe("worker-ask");

		// A closed record still proves management; it does not reopen the worker's ask tool.
		await revokeWorkerAdmissions(project.agentDir, { runId });
		expect(verdict(await child.emit("tool_call", askCall(decision), pooled))).toBe("worker-ask");

		// An unrelated native child outside this run's parent is ordinary.
		const free = child.ctx({ kind: "sub", id: "Free", name: "free", parentId: "OtherParent" });
		expect(verdict(await child.emit("tool_call", askCall(decision), free))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the main form scan is quote-aware, ignores comments and attribute text, and a corrected form keeps its key", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("manual task", main);

		// A quoted > is part of the attribute, not the end of the control tag: a benign placeholder is accepted...
		const placeholder = form(
			"quoted-placeholder",
			"irreversible-action",
			'<label>Scope <input type="text" name="scope" placeholder="2 > 1"></label>',
		);
		expect(verdict(await ask(omp, main, placeholder))).toBe("pass");
		// ...while a real non-empty default after that > is still found and refused.
		const defaultValue = form(
			"quoted-value",
			"irreversible-action",
			'<label>Scope <input type="text" name="scope" value="2 > 1"></label>',
		);
		expect(verdict(await ask(omp, main, defaultValue))).toBe("ask-default");

		// A commented-out form/default and a <form string inside an attribute are not the main form or a control.
		const commented = {
			html:
				'<!-- <form data-storm-decision="ghost" data-storm-reason="scope-change"><input type="radio" name="x" checked></form> -->' +
				'<form data-storm-decision="real-form" data-storm-reason="irreversible-action">' +
				'<p title="<form is text>">Preview</p><!-- <input type="radio" name="x" checked> -->' +
				'<label><input type="radio" name="x" value="no"> No</label></form>',
		};
		expect(verdict(await ask(omp, main, commented))).toBe("pass");

		// A form with no answerable field, then a malformed control, must not consume the stable key before the host
		// has a chance to show the corrected form.
		expect(
			verdict(await ask(omp, main, { html: '<form data-storm-decision="retry-decision" data-storm-reason="user-choice"><p>No field</p></form>' })),
		).toBe("ask-contract");
		expect(
			verdict(await ask(omp, main, { html: '<form data-storm-decision="retry-decision" data-storm-reason="user-choice"><input type="text" name="scope" value="unterminated></form>' })),
		).toBe("ask-contract");
		expect(verdict(await ask(omp, main, form("retry-decision", "user-choice")))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a managed headless ask is refused before the form and does not consume the decision key", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("manual task", main);
		const decision = form("headless-choice", "user-choice");
		const headless = { ...main, hasUI: false } as ExtensionContext;
		expect(verdict(await ask(omp, headless, decision))).toBe("ask-no-ui");
		// The refusal is feedback, not a recorded question: a host with a form can still ask it once.
		expect(verdict(await ask(omp, main, decision))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the bounded decision log keeps old keys at the cap instead of reopening a repeat", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.command("manual task", main);
		for (let index = 0; index < 64; index++) {
			expect(verdict(await ask(omp, main, form(`cap-${index}`, "user-choice")))).toBe("pass");
		}
		expect(verdict(await ask(omp, main, form("cap-new", "user-choice")))).toBe("ask-limit");
		// The oldest key is still present, so it is a repeat rather than a new authorization.
		expect(verdict(await ask(omp, main, form("cap-0", "user-choice")))).toBe("ask-repeat");
		await omp.emit("session_shutdown", {}, main);
	});
});
