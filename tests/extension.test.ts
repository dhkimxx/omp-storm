/**
 * The extension's own wiring: every hook, the /storm command and the storm tool registered on a fake omp, with real
 * project files below a temp dir. As in omp, the main session and each subagent session load the extension
 * separately and share its module state.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test, vi } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import { AgentRegistry, type CompactOptions, type ExtensionAPI, type ExtensionContext, type ExtensionUiFactory, type ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { readAutoDelegation, writeAutoDelegation } from "../src/approval/auto.ts";
import { writeConfig, configPath } from "../src/config/store.ts";
import { prepareAnalysis } from "../src/context.ts";
import storm, { bindIntegrationRuntime, type IntegrationRuntimePorts } from "../src/extension.ts";
import { approveAndSave } from "../src/flows.ts";
import { WHY_SHELL_READER, WHY_SHELL_REVIEWER } from "../src/policy/capability.ts";
import { DIRECTOR_EDIT_LEAD } from "../src/policy/director.ts";
import { docPromptFor } from "../src/policy/docs.ts";
import { SUPERVISOR_REASONS } from "../src/policy/supervisor.ts";
import * as threadPolicy from "../src/policy/thread.ts";
import { DIRECTOR_EDIT_ENDS, DIRECTOR_EDITING, DIRECTOR_REWRITTEN, DIRECTOR_WRITE_LATE, DIRECTOR_WRITE_LEAD, holderPhrase } from "../src/runtime/arbiter.ts";
import { APPROVE } from "../src/proposals/present.ts";
import { modelMismatchNotice } from "../src/policy/model-check.ts";
import { listAgents, markAgentsCleaned, noteAgentEnd, resetAgents } from "../src/runtime/agents.ts";
import * as closeoutModule from "../src/runtime/closeout.ts";
import { resetCloseoutChoices } from "../src/runtime/closeout.ts";
import { CONTRACT_TAG, ISOLATED_SCOPE } from "../src/runtime/contract-text.ts";
import { CONTINUE_SAME_TURN, lastRunEndAt, RunController, runSpawns } from "../src/runtime/controller.ts";
import * as ledgerModule from "../src/runtime/ledger.ts";
import { activeLedgerRun, bindLedgerChild, getLedgerRun, resetLedger, spendNote } from "../src/runtime/ledger.ts";
import { DISCARDED_TURN_PURPOSE } from "../src/runtime/side-spend.ts";
import { type PaidAttemptDecider, type PaidAttemptPendingView, type PaidAttemptReceiptView, type PaidAttemptsSurface } from "../src/runtime/paid-attempt-adapter.ts";
import { processKey } from "../src/runtime/janitor.ts";
import { LEDGER_READY_LEAD, noteLaneAgentEnd, onLaneReservationEnd, type ReservationEnd, WRITER_FREED_LEAD } from "../src/runtime/lanes.ts";
import { PLANLESS_SAME_TURN } from "../src/runtime/planless.ts";
import { endLabel, ROUND_DELAY_MS } from "../src/runtime/rounds.ts";
import { SPEND_CLOSED_LEAD, SPEND_TAG } from "../src/policy/spend-close.ts";
import { DIRECTOR_EDIT_RULE, lastRun, readRun, writeRun } from "../src/runtime/run.ts";
import { CONTINUATION_HEAD, EARLIER_REQUEST_MARKER, noteResumePointer } from "../src/runtime/resume.ts";
import { readTrialStates } from "../src/runtime/state-files.ts";
import { sharedMap } from "../src/runtime/thread-state.ts";
import { resetTrialSpawns } from "../src/runtime/trials.ts";
import { treeAgainst } from "../src/runtime/tree.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import { loadProjectState } from "../src/state.ts";
import { STORM_MARK } from "../src/view/appearance.ts";
import * as admissionModule from "../src/worker-admission.ts";
import { persistWorkerAdmission, readWorkerAdmission, revokeWorkerAdmissions, workerAdmissionKey } from "../src/worker-admission.ts";
import type { CloseoutAction, RunPlan, RunRecord, RunSpec, StormConfig, TrialConfig } from "../src/types.ts";
import { refusedCodeOf } from "../src/runtime/task-refusal.ts";
import { until } from "./fake-session.ts";
import { TEST_TIMINGS } from "./timings.ts";
import { DEAD_PROCESS, runRecord } from "./fixtures.ts";
import { git, gitRepo, makeProject, scriptedUi, TEAM, TEST_DISCOVERY, type TestProject } from "./support.ts";
import { extensionTheme } from "./tui-host.ts";

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
function fakeOmp(project: TestProject, load: typeof storm = storm, paidAttempts?: (sessionId: string | undefined) => unknown) {
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const sessions = new Map<string, ExtensionContext>();
	const rememberSession = (ctx: ExtensionContext): void => {
		sessions.set(`${ctx.agent.kind}:${ctx.agent.id}`, ctx);
		if (ctx.agent.kind !== "main") return;
		const id = ctx.agent.id;
		const sessionId = ctx.sessionManager.getSessionId();
		const registry = AgentRegistry.global();
		if (!sessionId || registry.get(id)?.session?.sessionManager.getSessionId() === sessionId) return;
		registry.register({
			id, displayName: id, kind: "main", status: "idle", createdAt: Date.now(), lastActivity: Date.now(),
			session: {
				sessionManager: { getSessionId: () => sessionId },
				effectiveExtensionRoots: TEST_DISCOVERY.extensionRoots,
				getSessionAgents: () => TEST_DISCOVERY.sessionAgents,
			} as unknown as AgentSessionHandle,
		});
	};
	/**
	 * The fake host speaks the names it was given: a task item's job, progress and result rows carry the handle the
	 * placement gave the item, never the director's lane name (A1-5). Tests may still write the lane's name.
	 */
	const withPlacedHandles = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(withPlacedHandles);
		if (typeof value !== "object" || value === null) return value;
		const out: Record<string, unknown> = {};
		// A sync result or a progress entry names its agent in `id`; a job row's `id` is the job's own name.
		const agentRow = "exitCode" in value || "output" in value || "structuredOutput" in value || "retryFailure" in value;
		for (const [key, item] of Object.entries(value)) {
			const mapped = (key === "agentId" || key === "agentUrlId" || (key === "id" && agentRow)) && typeof item === "string"
				? placedHandles.get(item) ?? item
				: withPlacedHandles(item);
			out[key] = mapped;
		}
		return out;
	};
	const emit = async (event: string, payload: unknown, on: ExtensionContext): Promise<unknown> => {
		rememberSession(on);
		let answer: unknown;
		const spoken = withPlacedHandles(payload);
		for (const handler of handlers.get(event) ?? []) answer ??= await handler(spoken, on);
		// A placed `task` call was answered with the rewritten input: remember the handle its items got (A1-5).
		if (event === "tool_call" && typeof payload === "object" && payload !== null && "toolName" in payload && payload.toolName === "task" && "input" in payload) {
			rememberPlacedHandles(payload.input, answer);
		}
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
	let completions: ((prefix: string) => Array<{ value: string; label: string; description?: string }> | null) | undefined;
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
	/** The async jobs omp's snapshot shows this session as running (`bash`/`eval` commands, and a subagent's `task` job). */
	const jobs: { running: Array<{ id: string; type: string; status: string; agentId?: string }> } = { running: [] };
	/** Models whose credential no longer resolves ("provider/id"). */
	const credentials: { lost: Set<string> } = { lost: new Set() };
	/** What `getThinkingLevel()` answers for any child of this fake host. */
	const thinking: { level: string | undefined } = { level: undefined };
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
		getThinkingLevel: () => thinking.level,
		setActiveTools: async (tools: string[]) => {
			active = tools;
		},
		registerTool: (definition: Tool) => {
			tool = definition;
		},
		registerCommand: (
			_name: string,
			definition: { handler: NonNullable<typeof command>; getArgumentCompletions?: NonNullable<typeof completions> },
		) => {
			command = definition.handler;
			completions = definition.getArgumentCompletions;
		},
		registerMessageRenderer: () => undefined,
	};
	load(pi as unknown as ExtensionAPI, { timings: TEST_TIMINGS });
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
			modelRegistry: {
				getAll: () => [],
				getAvailable: () => [],
				find: (provider: string, id: string) => ({ provider, id }),
				// Every model has a working credential unless a test lists it as lost (`credentials.lost`, "provider/id").
				getApiKey: async (model: { provider: string; id: string }) => (credentials.lost.has(`${model.provider}/${model.id}`) ? undefined : "key"),
			},
			// The director session's own async job rows, as omp's snapshot shows them; a test sets `jobs.running`.
			getAsyncJobSnapshot: () => ({ running: jobs.running, recent: [], delivery: {} }),
			sessionManager: {
				getArtifactsDir: () => project.root,
				getSessionDir: () => path.join(project.tmp, "sessions"),
				// A child has its own native identity, but Storm never reads it as a session store.
				getSessionId: () => (agent.kind === "main" ? (mainSessionId as string) : `child-${agent.id}`),
			},
			runEphemeralTurn: async () => ({ replyText: '{"action":"run"}' }),
			...(paidAttempts === undefined ? {} : { paidAttempts: paidAttempts(mainSessionId) }),
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
		jobs,
		credentials,
		thinking,
		ctx,
		/** Replaces the native main-session id for a following event, modeling /new, fork, resume or a host without one. */
		setSessionId: (id: string | undefined) => {
			mainSessionId = id;
		},
		sessionId: () => mainSessionId,
		activeTools: () => active,
		emit,
		/** What `/storm ` offers after the typed prefix. */
		completions: (prefix: string) => completions?.(prefix) ?? null,
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

/** The host handle each task item's own name was rewritten to, for this test (A1-5: the lane name is never the child's id). */
const placedHandles = new Map<string, string>();

const MAIN: Agent = { kind: "main", id: "Main", name: "main" };
// The id is read when the fake host uses the context: a worker created before its `task` placement still names the
// handle the placement gave it, because that is the native id the host would have started.
const sub = (id: string, name = "storm-implementer"): Agent => ({
	kind: "sub",
	get id() {
		return placedHandles.get(id) ?? id;
	},
	name,
	parentId: "Main",
});
const spawnOf = (agent: string, spawnKey: string, patterns: string[] = []) => ({
	agent,
	invocationKind: "task",
	patterns,
	spawnKey: placedHandles.get(spawnKey) ?? spawnKey,
});

/** Remembers what each item's name was rewritten to, pairing the call's items with the hook's answer. */
function rememberPlacedHandles(input: unknown, answer: unknown): void {
	if (typeof answer !== "object" || answer === null || !("input" in answer)) return;
	const items = (value: unknown): unknown[] =>
		typeof value === "object" && value !== null && "tasks" in value && Array.isArray(value.tasks) ? value.tasks : [value];
	const before = items(input);
	const after = items(answer.input);
	for (const [index, item] of before.entries()) {
		const next = after[index];
		if (typeof item !== "object" || item === null || !("name" in item) || typeof item.name !== "string") continue;
		if (typeof next !== "object" || next === null || !("name" in next) || typeof next.name !== "string") continue;
		placedHandles.set(item.name, next.name);
	}
}
const assistant = (provider: string, model: string, input: number, usd: number) => ({
	message: { role: "assistant", provider, model, usage: { input, cacheRead: 0, cacheWrite: 0, cost: { total: usd } } },
});

/** A structural Slice Y surface whose receipts the paid-wiring tests settle by hand. */
function fakePaidSurface(owner: string) {
	const authorizeCalls: Array<PaidAttemptDecider | undefined> = [];
	const receipts: PaidAttemptReceiptView[] = [];
	let pending: PaidAttemptPendingView[] = [];
	let decider: PaidAttemptDecider | undefined;
	let observedCost = 0;
	let lastSeq = 0;
	const api: PaidAttemptsSurface = {
		ownerSessionId: owner,
		get managed(): boolean {
			return decider !== undefined;
		},
		authorize(next): void {
			authorizeCalls.push(next);
			decider = next;
		},
		state() {
			return {
				observedCost,
				pending: pending.map(item => ({ ...item })),
				unresolved: receipts.filter(receipt => receipt.costBasis === "unknown"),
				lastSeq,
			};
		},
		receipts() {
			return receipts.map(receipt => ({ ...receipt }));
		},
		onReceipt() {
			return () => undefined;
		},
	};
	return {
		api,
		authorizeCalls,
		add(usd: number): void {
			const seq = ++lastSeq;
			receipts.push({
				attemptId: `a${seq}`,
				seq,
				sessionId: owner,
				actorSessionId: owner,
				purpose: "loop",
				provider: "openai",
				model: "gpt-test",
				attempt: 1,
				startedAt: 1_000,
				settledAt: 2_000,
				gate: "admitted",
				sent: true,
				outcome: "completed",
				costBasis: "observed",
				costTotal: usd,
				append: "flushed",
				receiptEntryId: `entry-${seq}`,
			});
			pending = pending.filter(item => item.attemptId !== `a${seq}`);
			observedCost += usd;
		},
		pend(attemptId: string): void {
			pending = [...pending, { attemptId, model: "gpt-test", purpose: "loop", actorSessionId: owner }];
		},
	};
}
/** The `[storm:<code>]` a hook answered with (a refused `task` call carries its code in its input), "pass" when it let the call through, or the routed models. */
function verdict(answer: unknown): string {
	if (answer === undefined) return "pass";
	if (typeof answer !== "object" || answer === null) return "?";
	if ("block" in answer && "reason" in answer) return /^\[storm:([a-z-]+)\] /.exec(String(answer.reason))?.[1] ?? "block without a code";
	if ("input" in answer) return refusedCodeOf(answer.input) ?? "pass";
	return "model" in answer && Array.isArray(answer.model) ? `route:${answer.model.join(",")}` : "?";
}

/** The host handle a `task` placement gave the call (the rewrite the hook returned), or the caller's own name. */
function placedName(answer: unknown, fallback: string): string {
	if (typeof answer !== "object" || answer === null || !("input" in answer)) return fallback;
	const input = answer.input;
	if (typeof input !== "object" || input === null || !("name" in input)) return fallback;
	return typeof input.name === "string" ? input.name : fallback;
}

let project: TestProject;
let beforeAgentDir: string;
let beforeTmpDir: string | undefined;

beforeEach(async () => {
	placedHandles.clear();
	project = await makeProject();
	beforeAgentDir = getAgentDir();
	setAgentDir(project.agentDir);
	// The real lease keys worktrees by device/inode in the OS temp dir. An incomplete fake turn can
	// keep its claim after shutdown; Linux can recycle the deleted fixture's inode in the next test.
	beforeTmpDir = process.env.TMPDIR;
	process.env.TMPDIR = project.tmp;
});

afterEach(async () => {
	vi.useRealTimers();
	setSystemTime();
	try {
		// Let fake children finish before disposing the case's private lease namespace.
		await shutdownFakeSessions();
	} finally {
		resetLedger();
		resetAgents();
		resetTrialSpawns();
		resetCloseoutChoices();
		AgentRegistry.resetGlobalForTests();
		setAgentDir(beforeAgentDir);
		if (beforeTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = beforeTmpDir;
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
		// The worker id is the admission's spawn key; with the plan's lane, manual placement keeps the lane name.
		const impl = child.ctx(sub("fix"));
		const edit = { toolName: "edit", toolCallId: "edit-1", input: { path: "src/a.ts" } };

		// Before a run the main session is an ordinary one.
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		await omp.command("fix the bug", main);
		expect(omp.sent).toHaveLength(1);
		expect(omp.activeTools()).toContain("storm");
		expect(omp.statuses.at(-1)).toBeDefined();
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		expect(runId).toBeDefined();

		// The director edits a file it can name while nothing else writes; a change it cannot name is refused (and counted), notes
		// and control stay open, and a subagent edits freely.
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "write-2", input: { path: "vault://x.md", content: "x" } }, main))).toBe("director-edit");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "local://notes.md" } }, main))).toBe("pass");
		// The run's marker exists from its start, so a child this run never admitted is unknown in a managed tree:
		// it fails closed instead of editing as unrelated native work.
		expect(verdict(await child.emit("tool_call", edit, impl))).toBe("authority");
		// The host's order: the hooks of a message's calls, then that message's own `message_end`, then its calls run. The edit's
		// message is over when the director's NEXT request completes (its refused sibling made the turn unclean).
		const callBlocks = ["edit-1", "write-2"].map(id => ({ type: "toolCall", id, name: "edit", arguments: {} }));
		await omp.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: callBlocks } }, main);
		await omp.emit("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [] } }, main);

		// R4: a spawn whose key is not exactly a pending placement of this run is refused, never guessed; the plan's
		// lane is then placed and followed.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("internal");
		expect(await omp.tool({ action: "plan", plan: { lanes: [fixLane] } }, main)).toBe("ok");
		const placedFix = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "fix", task: "fix it" } }, main)) as { input: { name: string } };
		// A1-5: the lane's name is the table key; the host gets a handle it has never issued.
		expect(placedFix.input.name).toMatch(/^run-.*-lane-\d+$/);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "fix"), main))).toBe("route:a/i");
		// R5: a role the plan has no lane for is placed as an unplanned worker under a handle; a read-only item reserves
		// nothing, so it runs beside the planned writer. Its spawn is keyed by that handle.
		const placedRev = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name: "Rev", task: "look around" } }, main)) as { input: { name: string } };
		expect(placedRev.input.name).not.toBe("Rev");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", placedRev.input.name), main))).toMatch(/^route:/);
		// A spawn decided in a subagent's session sees the same run; the plan's worker count is no limit.
		const implWorker = child.ctx(sub(String(placedFix.input.name)));
		expect(verdict(await child.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl2"), implWorker))).toBe("route:a/i");
		// The worker the run admitted edits freely: the director's own edit rules never apply to a lane's writer.
		expect(verdict(await child.emit("tool_call", { ...edit, toolCallId: "worker-edit-1" }, impl))).toBe("pass");

		// The subagent's first turn registers it under the run and brings its role's doc rules.
		const section = docPromptFor("storm-implementer", TEAM);
		expect(await child.emit("before_agent_start", { systemPrompt: ["base"] }, implWorker)).toEqual({ systemPrompt: ["base", section] });
		expect(await child.emit("before_agent_start", { systemPrompt: ["base", section] }, implWorker)).toBeUndefined();
		expect(listAgents({ runId: runId as string, scope: project.sessionDir }).map(agent => agent.id)).toEqual([placedFix.input.name]);

		// The director's reads are never refused for their size, whether or not a subagent read the file: Storm only
		// counts them (a wide range of a file a subagent read is counted as duplicate, below).
		const wide = { toolName: "read", input: { path: "big.md:1-5000" } };
		expect(verdict(await omp.emit("tool_call", wide, main))).toBe("pass");
		await child.emit("tool_call", { toolName: "read", input: { path: "big.md" } }, impl);
		expect(verdict(await omp.emit("tool_call", wide, main))).toBe("pass");
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
		await followUp("agent://fix");
		await followUp("agent://FIX");
		await followUp("agent://fix?progress");
		await followUp("agent://fix", true);
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
			reads: { director: 2, directorChars: 400, duplicateChars: 100, blocked: 0 },
			plan: { lanes: [{ name: "fix", kind: "code", role: "implementer", results: changeFor("fix-change") }] },
			results: [{ id: "fix-change", lane: "fix", state: "pending" }],
		});
		expect(record?.spawns.map(spawn => spawn.code ?? spawn.outcome)).toEqual(["internal", "routed", "routed", "routed"]);
		// The manual task name was matched to its unique planned lane without a rewrite.
		expect(record?.spawns.find(spawn => spawn.spawnKey === placedFix.input.name && spawn.outcome === "routed")?.lane).toBe("fix");
		expect(record?.agents).toMatchObject([{ id: placedFix.input.name, role: "implementer", state: "idle", followUps: 2, costUsd: 0.5, contextTokens: 30_000, review: { reviews: 1, passed: 1 } }]);

		// With the run closed by the session ending, the main session is ordinary again.
		await omp.emit("session_shutdown", {}, main);
		expect(verdict(await omp.emit("tool_call", edit, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("task", "T", ["x/unapproved"]), main))).toBe("pass");
	});

	test("manual task placement keeps planned handles, flags only planned isolation and places a direct isolated claim as unplanned private", async () => {
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
		expect(probe.input).toMatchObject({ isolated: true });
		expect(String(probe.input.name)).toMatch(/^run-.*-lane-\d+$/);
		const core = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "core", task: "Core", isolated: true } }, main)) as { input: Record<string, unknown> };
		expect(String(core.input.name)).toMatch(/^run-.*-lane-\d+$/);
		expect(core.input).not.toHaveProperty("isolated");
		// D10: an unplanned item that asks for its own checkout is placed private beside other writers when omp's
		// isolation is on and its merge is off; it gets a generated handle, never the caller's name as a lane.
		const stray = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "Stray", task: "Stray", isolated: true } }, main)) as { input: Record<string, unknown> };
		expect(stray.input).toMatchObject({ isolated: true });
		expect(stray.input.name).not.toBe("Stray");
		// Three task calls, one host capability read: the per-run cache holds across shared and selective spawns.
		expect(settings.calls()).toBe(1);
	});

	test("a refused task call is not a block: it runs into omp's own rejection and its result becomes Storm's reason", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		const planned = await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main);
		expect(planned.outcome).toBe("ok");

		// A block ends a call with `details: {}`, which omp 19.2's task view cannot draw; a refused task call carries the field
		// omp's task tool rejects first, keeps everything the director sent, and is told apart by the code in the marker.
		// The same planned lane twice is still a refusal this version keeps; it is the refusal this test exercises.
		const sent = { tasks: [{ agent: "storm-implementer", name: "fix", task: "First" }, { agent: "storm-implementer", name: "fix", task: "Second" }] };
		const answer = await omp.emit("tool_call", { toolName: "task", toolCallId: "refused-1", input: sent }, main);
		expect(answer).not.toHaveProperty("block");
		expect(verdict(answer)).toBe("lane");
		const revised = (answer as { input: Record<string, unknown> }).input;
		expect(revised).toMatchObject(sent);
		expect(refusedCodeOf(revised)).toBe("lane");

		// The host ran the revised call and omp rejected it; Storm's reason replaces the rejection and the record stays drawable.
		const hostResult = { toolName: "task", toolCallId: "refused-1", isError: true, input: revised, content: [{ type: "text", text: "The task tool uses `outputSchema`" }], details: { projectAgentsDir: null, results: [], totalDurationMs: 0 } };
		const settled = (await omp.emit("tool_result", hostResult, main)) as { content: Array<{ text: string }>; details: { results: unknown[] }; isError: boolean };
		expect(settled.isError).toBe(true);
		expect(settled.content[0]?.text).toMatch(/^\[storm:lane\] /);
		expect(Array.isArray(settled.details.results)).toBe(true);
		// The reason is delivered once: a second result for the same call id is the host's own.
		expect(await omp.emit("tool_result", hostResult, main)).toBeUndefined();

		// A refusal of any other tool stays the plain block its view draws.
		const readBlock = await omp.emit("tool_call", { toolName: "write", toolCallId: "refused-2", input: { path: "vault://x.md", content: "x" } }, main);
		expect(readBlock).toMatchObject({ block: true });

		// A call without a host id cannot be matched to its result: it is blocked as before, never half-refused.
		expect(await omp.emit("tool_call", { toolName: "task", input: sent }, main)).toMatchObject({ block: true });

		// If omp ever ran the refused call, its real result stays and the user is told the refusal did not hold.
		await omp.emit("tool_call", { toolName: "task", toolCallId: "refused-3", input: sent }, main);
		const ran = await omp.emit("tool_result", { ...hostResult, toolCallId: "refused-3", isError: false, content: [{ type: "text", text: "started" }] }, main);
		expect(ran).toBeUndefined();
		expect(omp.notices.some(notice => notice.level === "error")).toBe(true);
	});

	test("a refused task call the host runs anyway starts no worker, for a single task, a mixed batch and a nameless item", async () => {
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
							{ name: "E0", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("e0-answer") },
							{ name: "C0", kind: "code", role: "implementer", files: ["c.txt"], results: changeFor("c0-change"), dependsOn: [{ lane: "E0", need: "result" }] },
							{ name: "C1", kind: "code", role: "implementer", files: ["d.txt"], results: changeFor("c1-change"), dependsOn: [{ lane: "E0", need: "result" }] },
						],
						workers: { implementer: 2, explorer: 2 },
					},
				},
				main,
			),
		).toBe("ok");
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		const item = (name: string, agent = "storm-implementer") => ({ agent, name, task: `work ${name}` });
		// One worker of the run is admitted, so the run's marker is live for the child-side check below.
		const placedE0 = await omp.emit("tool_call", { toolName: "task", toolCallId: "ok-1", input: item("E0", "storm-explorer") }, main);
		expect(verdict(placedE0)).toBe("pass");
		const e0 = placedName(placedE0, "E0");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", e0), main))).toMatch(/^route:/);
		await child.emit("before_agent_start", { systemPrompt: [] }, child.ctx(sub(e0, "storm-explorer")));
		const spawnKeys = () => runSpawns(runId).map(spawn => spawn.spawnKey);
		expect(spawnKeys()).toEqual([e0]);

		const refusals: Array<{ call: string; input: Record<string, unknown>; spawns: Array<[string, string]>; code: string }> = [
			// A lane that already has a live attempt: the spawn hook alone would admit it as its planned lane again. (A consumer
			// whose prerequisite is not ready is no longer refused: it starts, and its result says so.)
			{ call: "r-busy", input: item("E0", "storm-explorer"), spawns: [["storm-explorer", "r-busy:0"]], code: "lane-busy" },
			// One bad item refuses the whole batch, the good item with it.
			{ call: "r-batch", input: { context: "c", tasks: [item("C0"), item("C1"), item("stray")] }, spawns: [["storm-implementer", "C0"], ["storm-implementer", "C1"]], code: "lane-write" },
			// No handle: omp names the spawn after the call, and a lane of the agent's role is the only candidate.
			{ call: "r-nameless", input: { agent: "storm-explorer", task: "work" }, spawns: [["storm-explorer", "r-nameless:0"]], code: "lane-busy" },
		];
		for (const refusal of refusals) {
			const answer = await omp.emit("tool_call", { toolName: "task", toolCallId: refusal.call, input: refusal.input }, main);
			expect(answer).not.toHaveProperty("block");
			expect(verdict(answer)).toBe(refusal.code);
			// omp ran the call anyway: every spawn it asks for is refused with Storm's reason, nothing is routed or reserved.
			for (const [agent, key] of refusal.spawns) {
				const spawn = await omp.emit("before_subagent_spawn", spawnOf(agent, key), main);
				expect(spawn).toMatchObject({ block: true });
				expect(verdict(spawn)).toBe(refusal.code);
			}
			// The host's own result for the call (omp reports the blocked spawn) is replaced by the same reason, and the hold ends.
			const settled = (await omp.emit("tool_result", { toolName: "task", toolCallId: refusal.call, isError: true, input: (answer as { input: unknown }).input, content: [], details: {} }, main)) as { content: Array<{ text: string }> };
			expect(settled.content[0]?.text).toMatch(new RegExp(`^\\[storm:${refusal.code}\\] `));
		}
		// Nothing of the refused calls reached the run: no spawn row, no worker, no result moved.
		expect(spawnKeys()).toEqual([e0]);
		const pending = async () => (await readRun(project.sessionDir, runId))?.results?.every(result => result.state === "pending");
		expect(await pending()).toBe(true);
		expect(listAgents({ runId, scope: project.sessionDir }).map(agent => agent.id)).toEqual([e0]);

		// If the host ran the call and a worker started without an admission, the child side still denies it everything
		// but reads: the run's marker is live (E0 was admitted), and a child with no record of its own is not unmanaged then.
		const ghost = child.ctx(sub("C0"));
		await child.emit("before_agent_start", { systemPrompt: [] }, ghost);
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, ghost))).toBe("pass");
		for (const call of [
			{ toolName: "write", input: { path: "c.txt", content: "x" } },
			{ toolName: "edit", input: { path: "c.txt", edits: [] } },
			{ toolName: "bash", input: { command: "touch c.txt" } },
		]) expect(verdict(await child.emit("tool_call", call, ghost))).toBe("authority");
		expect(verdict(await child.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", task: "nested" } }, ghost))).toBe("lane-nested");
		expect(spawnKeys()).toEqual([e0]);
		expect(listAgents({ runId, scope: project.sessionDir }).map(agent => agent.id)).toEqual([e0]);
		expect(await pending()).toBe(true);

		// The hold ended with the refused calls: a spawn is judged by the plan again, not refused for a call that is gone.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "E1"), main))).not.toMatch(/^lane/);
	});

	test("a call refused after its lane was placed leaves a placement the hold keeps from admitting a worker", async () => {
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
							{ name: "W0", kind: "run", role: "implementer", files: ["shared.txt"], goal: "Write the shared file", results: changeFor("w0-change") },
							{ name: "X0", kind: "code", role: "implementer", files: ["shared.txt"], goal: "Conflict with the writer", results: changeFor("x0-change") },
						],
						workers: { implementer: 2 },
					},
				},
				main,
			),
		).toBe("ok");
		const call = (id: string, name: string) => omp.emit("tool_call", { toolName: "task", toolCallId: id, input: { agent: "storm-implementer", name, task: `work ${name}` } }, main);
		expect(verdict(await call("w", "W0"))).toBe("pass");
		// X0 waits for the writer; the writer's call fails and the conversation changes while it waits, after X0 was placed.
		const waiting = call("x", "X0");
		const started = Promise.withResolvers<void>();
		setTimeout(started.resolve, 40);
		await started.promise;
		await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "w", isError: true }, main);
		omp.setSessionId("session-switched");
		expect(verdict(await waiting)).toBe("session");
		omp.setSessionId(project.sessionId);
		// The placement of X0 is still there, and without the hold the host's spawn would be admitted as that lane.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "X0"), main))).toBe("session");
		await omp.emit("tool_result", { toolName: "task", toolCallId: "x", isError: true, input: {}, content: [], details: {} }, main);
		// The failed call's result frees what it placed: the lane can be dispatched again.
		expect(verdict(await call("x2", "X0"))).toBe("pass");
	});

	test("a refused task call that never settles stops holding spawns after its window, and a cancelled one at once", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(await omp.tool({ action: "plan", plan: { lanes: [fixLane] } }, main)).toBe("ok");
		// Two shared writers in one call: this is still a refusal. Nothing of it starts, and while its result is
		// unsettled no other spawn starts either (the refusal is a fail-closed window, task-refusal.ts).
		const refuse = (call: string) => omp.emit("tool_call", {
			toolName: "task",
			toolCallId: call,
			input: { tasks: [{ agent: "storm-implementer", name: "fix", task: "One" }, { agent: "storm-implementer", name: "fix", task: "Two" }] },
		}, main);
		const spawn = async () => verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "fix"), main));
		await refuse("c1");
		expect(await spawn()).toBe("lane");
		// The host cancelled the call: its end clears the hold.
		await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "c1", isError: true }, main);
		// A real placement of the plan's lane now starts.
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "fix", task: "work" } }, main))).toBe("pass");
		expect(await spawn()).toMatch(/^route:/);

		// A call the host never settles holds spawns only for its window.
		setSystemTime(new Date("2030-01-01T00:00:00Z"));
		await refuse("c2");
		expect(await spawn()).toBe("lane");
		setSystemTime(new Date("2030-01-01T00:02:00Z"));
		expect(await spawn()).not.toBe("lane");
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
		// The reviewer definition has bash and the lane has no write intent: it reads and runs commands, nothing else. The
		// shell is part of the persisted admission, which is what a worker thread enforces.
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, reviewer))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "bun test" } }, reviewer))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "x.txt", content: "x" } }, reviewer))).toBe("lane-capability");
		expect(verdict(await child.emit("tool_call", { toolName: "edit", input: { path: "x.txt", edits: [] } }, reviewer))).toBe("lane-capability");
		expect(verdict(await child.emit("tool_call", { toolName: "eval", input: { code: "1" } }, reviewer))).toBe("lane-capability");
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

	for (const mode of ["exclusive writer", "isolated worker"] as const) {
		test(`a managed ${mode} cannot switch its own or a peer's model or effort: the control paths are refused, messages and reads are not`, async () => {
			const isolated = mode === "isolated worker";
			if (isolated) {
				await pathOnlyImplementer();
				await approveShadows(TEAM);
				installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": false });
			} else {
				await approve(TEAM);
			}
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.command("manual task", main);
			const lane = isolated
				? { name: "probe", kind: "run", role: "implementer", isolationReason: "independent experiment", files: ["allowed.txt"], results: changeFor("probe-change") }
				: { name: "probe", kind: "run", role: "implementer", files: ["shared.txt"], results: changeFor("probe-change") };
			expect(await omp.tool({ action: "plan", plan: { lanes: [lane], workers: { implementer: 1 } } }, main)).toBe("ok");
			const placedProbe = await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "probe", task: "Work" } }, main);
			expect(verdict(placedProbe)).not.toBe("internal");
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "probe"), main))).toMatch(/^route:/);
			const worker = child.ctx(sub("probe"));
			await child.emit("before_agent_start", { systemPrompt: [] }, worker);
			const control = ["agent://probe/model", "agent://probe/effort", "agent://parent/model", "agent://Main/effort", "agent://all/model", "agent://probe/Model", "agent://other/effort?x=1", "agent://probe/model/", "agent://probe/./model", "agent://probe/x/../effort", "agent://probe/%2e/model"];
			for (const target of control) {
				expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: target, content: "other-model" } }, worker)), target).toBe("worker-control");
			}
			// Ordinary messages and reads are not control paths: whatever else the gate says, it is not this refusal.
			for (const target of ["agent://parent", "agent://probe", "agent://other?progress"]) {
				const answer = verdict(await child.emit("tool_call", { toolName: "write", input: { path: target, content: "done" } }, worker));
				expect(answer, target).not.toBe("worker-control");
				if (!isolated) expect(answer, target).toBe("pass");
			}
			expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "agent://probe/model" } }, worker))).not.toBe("worker-control");
			// An unmanaged native subagent (no Storm run binding) is not gated.
			const unrelatedArtifacts = path.join(project.tmp, "unrelated-artifacts-control");
			await mkdir(unrelatedArtifacts, { recursive: true });
			const strangerBase = child.ctx(sub("Stranger", "unrelated"));
			const stranger = { ...strangerBase, sessionManager: { ...strangerBase.sessionManager, getArtifactsDir: () => unrelatedArtifacts } } as ExtensionContext;
			expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "agent://Stranger/model", content: "x" } }, stranger))).toBe("pass");
			await omp.emit("session_shutdown", {}, main);
		}, 15_000);
	}

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
		// A work follow-up would wake the idle holder into the writer's scope, so it waits for the writer. A quiet progress
		// note wakes the same holder with the authority its last turn ended, so it can only read and report: it meets no
		// write order (the dedicated test below follows the woken turn). A read starts no turn.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0", content: "work" } }, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0?progress", content: "status" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0?progress=0", content: "status" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://H0", content: "work" } }, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "agent://H0" } }, main))).toBe("pass");
		// A broadcast meets only omp's own ceiling, which is unset here.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://all", content: "resume" } }, main))).toBe("pass");
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
			const placed = await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name, task: "Write" } }, main);
			expect(verdict(placed)).toBe("pass");
			const handle = placedName(placed, name);
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", handle), main))).toBe("route:a/i");
			idle[name] = child.ctx(sub(handle));
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
		const placed = await dispatch();
		expect(verdict(placed)).toBe("pass");
		const r0 = placedName(placed, "R0");
		expect(verdict(await dispatch())).toBe("lane-busy");
		// A1-6: a spawn of another agent under this key is refused and leaves the rightful placement in place. A refusal
		// cleans up only what its own hook call created or bound.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", r0), main))).toBe("internal");
		expect(verdict(await dispatch())).toBe("lane-busy");
		// The rightful worker still correlates to that exact placement.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", r0), main))).toMatch(/^route:/);
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
			const placed = await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name, task: "Read" } }, main);
			expect(verdict(placed)).toBe("pass");
			const handle = placedName(placed, name);
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", handle), main))).toMatch(/^route:/);
			readers[name] = child.ctx(sub(handle, "storm-explorer"));
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
		// A lane's worker has the handle as its native id; the test names the lane.
		const state = (id: string) => listAgents({ scope: project.sessionDir }).find(agent => agent.id === (readers[id]?.agent.id ?? id))?.state;

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

	test("a consumer task starts before its prerequisite holds and says so in its own result", async () => {
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
		// P0 never ran: its result is pending. The consumer used to be refused (`lane-dependency`); it starts, because the
		// record never accepts a result built on an input that did not exist, and the call's own result tells the director.
		const call = { toolName: "task", toolCallId: "c0-call", input: { agent: "storm-explorer", name: "C0", task: "Consume" } };
		expect(verdict(await omp.emit("tool_call", call, main))).toBe("pass");
		const result = (await omp.emit("tool_result", { ...call, isError: false, content: [], details: { results: [] } }, main)) as { additionalContext?: string } | undefined;
		expect(result?.additionalContext).toContain("'C0'");
		expect(result?.additionalContext).toContain("P0");
		// The note is read once, by the call it belongs to: the same call id has none afterwards.
		expect(await omp.emit("tool_result", { ...call, isError: false, content: [], details: { results: [] } }, main)).toBeUndefined();
	});

	test("a legacy isolated team isolates manual work and its approved reviewer too", async () => {
		const isolatedTeam: StormConfig = { ...TEAM, isolation: "isolated" };
		await approve(isolatedTeam);
		// An isolated team needs omp's merge of an isolated worker's changes off: the merge would run after the worker ended.
		installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": false });
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
		expect(work.input).toMatchObject({ isolated: true });
		expect(String(work.input.name)).toMatch(/^run-.*-lane-\d+$/);
		const review = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-reviewer", name: "check", task: "Review" } }, main)) as { input: Record<string, unknown> };
		expect(review.input).toMatchObject({ isolated: true });
		expect(String(review.input.name)).toMatch(/^run-.*-lane-\d+$/);
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

	test("a project with no Storm config and no automatic consent gets no footer at all", async () => {
		const omp = fakeOmp(project);
		await omp.emit("session_start", {}, omp.ctx(MAIN));
		expect(omp.statuses.at(-1)).toBeUndefined();
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
					// LiveStatus installs a widget factory; the fake host only needs to build what it returns.
					(content as ExtensionUiFactory)(
						{ requestRender: () => undefined, size: () => ({ columns: 120, rows: 40 }), suspend: run => run() },
						extensionTheme(currentTheme()),
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
		await writeFile(path.join(project.root, ".omp", "agents", "storm-reviewer.md"), "---\nname: storm-reviewer\ndescription: test reviewer\n---\nbody\n");
		await omp.emit("session_start", {}, main);
		const shadowed = omp.statuses.at(-1);
		expect(shadowed).not.toBe(idle);
		expect(shadowed).toContain("승인 필요");
		expect(shadowed).not.toContain("이어가기 가능");
	});

	test("the idle hint needs an approved team, without its approval", async () => {
		await approve(TEAM);
		await writeConfig(project.sessionDir, { ...TEAM, rounds: 9 });
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
		// The read is indexed under the new run (it only feeds the run's read statistics): the director's wide read of the
		// same file is not refused for its size.
		await child.emit("tool_call", { toolName: "read", input: { path: "big.md" } }, impl);
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "big.md:1-5000" } }, main))).toBe("pass");
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
		await until(async () => (await lastRun(project.sessionDir))?.runId === runId);
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

	test("a planned batch with an unplanned writer beside a planned writer is refused whole before any child starts", async () => {
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
		// R5 places the unassigned item as an unplanned writer; G1 refuses the whole batch because that is a second
		// shared writer beside lane A, before anything is reserved or started.
		expect(verdict(await omp.emit("tool_call", batch, main))).toBe("lane-write");
		// No run spawn record exists for the refused batch, and a fully authorized single item still works.
		expect(activeLedgerRun(project.sessionDir)?.plan?.lanes.map(lane => lane.name)).toEqual(["A", "B", "C"]);
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { name: "A", agent: "storm-implementer", task: "a" } }, main))).toBe("pass");
		// eval cannot bypass the native task lane during a managed run.
		expect(verdict(await omp.emit("tool_call", { toolName: "eval", input: { code: "1" } }, main))).toBe("lane");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a follow-up passes at any worker context size; omp compacts the worker itself", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		// A concrete planned lane so the follow-up resolves to an authorized target.
		await applyRunPlan(omp, main, {
			lanes: [{ name: "Big", kind: "code", role: "implementer", files: ["big.txt"], results: changeFor("big-change") }],
			workers: { implementer: 1 },
		});
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "Big", task: "big" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Big"), main))).toBe("route:a/i");
		const ctx = child.ctx(sub("Big"));
		admitChild(runId, "Big");
		await child.emit("before_agent_start", { systemPrompt: [] }, ctx);
		// Far above the retired 200k cap, and above a 200k model's whole window.
		await child.emit("message_end", assistant("a", "i", 900_000, 0), ctx);
		await child.emit("agent_end", {}, ctx);
		const write = (target: string) => omp.emit("tool_call", { toolName: "write", input: { path: target } }, main);
		expect(verdict(await write("agent://Big"))).toBe("pass");
		expect(verdict(await write("agent://Nobody"))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
		const run = await lastRun(project.sessionDir);
		expect(run).toMatchObject({ status: "stopped", endReason: "shutdown" });
		expect(run?.blockedFollowUps ?? 0).toBe(0);
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
		// Read-only lanes: their placements reserve no shared write, so the native ceiling is what the second spawn meets.
		await applyRunPlan(omp, main, {
			lanes: [
				{ name: "A", kind: "explore", role: "explorer", goal: "Read A", results: answerFor("a-answer") },
				{ name: "B", kind: "explore", role: "explorer", goal: "Read B", results: answerFor("b-answer") },
			],
			workers: { explorer: 2 },
		});
		// R4: each fresh spawn has its exact placement before the hook.
		const placedA = await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name: "A", task: "read a" } }, main);
		expect(verdict(placedA)).toBe("pass");
		const placedB = await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name: "B", task: "read b" } }, main);
		expect(verdict(placedB)).toBe("pass");
		const spawn = (key: string, maxConcurrency: number) =>
			withActiveSettings(Settings.isolated({ "task.maxConcurrency": maxConcurrency }), () =>
				omp.emit("before_subagent_spawn", spawnOf("storm-explorer", key), main));
		expect(verdict(await spawn(placedName(placedA, "A"), 1))).toMatch(/^route:/);
		// A's reservation fills the one live native slot before any host agent row exists. The refused spawn consumes
		// its placement (a blocked spawn never leaves a reservation behind), so the retry needs a new task call.
		expect(verdict(await spawn(placedName(placedB, "B"), 1))).toBe("parallelism");
		const retried = (await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name: "B", task: "read b" } }, main)) as { input: { name: string } };
		// The host named the refused spawn; the lane's retry gets a run-unique handle (R4/HF-2).
		expect(retried.input.name).not.toBe("B");
		// OMP's unlimited value adds no Storm cap of its own.
		expect(verdict(await spawn(retried.input.name, 0))).toMatch(/^route:/);
		await omp.emit("session_shutdown", {}, main);
	});

	test("the plan reply reads the live omp isolation setting: an isolated lane is named only while isolation is off", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("task", main);
		const plan = {
			lanes: [{ name: "probe", kind: "run", isolationReason: "keep the experiment outside the tree", results: changeFor("probe-change") }],
			workers: { implementer: 1 },
		};
		const planWith = (enabled: boolean) =>
			withActiveSettings(Settings.isolated({ "task.isolation.enabled": enabled }), () => omp.toolReply({ action: "plan", plan }, main));
		const off = await planWith(false);
		const line = off.text.split("\n").find(candidate => candidate.startsWith("- 격리 불가"));
		expect(line).toContain("probe");
		expect(line).toContain("task.isolation.enabled");
		const on = await planWith(true);
		expect(on.text).not.toContain("격리 불가");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the approval it checks is at most 2 s old: an edit after approval blocks spawns from then on", async () => {
		setSystemTime(new Date(T0));
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		expect(verdict(await omp.emit("before_subagent_spawn", implementer, main))).toBe("route:a/i");
		await writeConfig(project.sessionDir, { ...TEAM, rounds: 9 });
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
		// A file change the director cannot name is refused only while the run directs the session.
		const change = { toolName: "write", toolCallId: "w-1", input: { path: "vault://x.md", content: "x" } };
		await omp.command("task", main);
		// A subagent's own session switching is not the run's business.
		await child.emit("session_switch", { reason: "new" }, child.ctx(sub("Impl")));
		expect(verdict(await omp.emit("tool_call", change, main))).toBe("director-edit");
		await omp.emit("session_switch", { reason: "new" }, main);
		expect(verdict(await omp.emit("tool_call", change, main))).toBe("pass");
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
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", toolCallId: "legacy-gate", input: { command: "git status" } }, main))).toBe("pass");
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
		// What the text says is true of the hooks: nothing forces a minimum scope, it points a status question at `storm status`,
		// says reads are open (they are: see the gate tests) and tells the director to end its turn rather than call `wait`
		// again (omp wakes it when a worker result arrives; each `wait` call is a turn).
		expect(stormText).not.toMatch(/scope tiny|one lane|one worker|bounded ranges|At capacity wait/i);
		expect(stormText).toContain("storm status");
		expect(stormText).toMatch(/read and search/i);
		expect(stormText).toMatch(/end your turn/i);
		expect(stormText).not.toMatch(/project, shell or unknown tools are blocked/i);
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

		// What edits files or runs a command is refused until the request's run opens, each with its own cause; reads
		// and searches are open (the director may look at the project itself).
		for (const call of [
			{ toolName: "edit", input: { path: "src/a.ts" } },
			{ toolName: "bash", input: { command: "git status" } },
		]) {
			expect(verdict(await omp.emit("tool_call", call, main))).toBe("auto");
		}
		for (const call of [readFile, { toolName: "grep", input: { pattern: "x" } }, { toolName: "glob", input: { pattern: "**/*" } }]) {
			expect(verdict(await omp.emit("tool_call", call, main))).toBe("pass");
		}
		// The refusal says what it is: the cause of this call, and not a rule about "project tools" that reads are not under.
		const shell = (await omp.emit("tool_call", { toolName: "bash", input: { command: "git status" } }, main)) as { reason: string };
		expect(shell.reason).toContain(SUPERVISOR_REASONS.toolRuns);
		expect(shell.reason).not.toContain("프로젝트 도구");
		// The orchestrator and published worker results remain reachable; a handle of an agent this session's runs never started is not
		// (omp resolves `agent://<id>` across every session of the process, R-G234 L1).
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "agent://Impl" } }, main))).toBe("auto");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "local://plan.md", content: "- step" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "storm", input: { action: "plan" } }, main))).toBe("pass");
		// The spawn hook is the fail-closed backstop even when no tool-call guard sees the spawn.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "Impl"), main))).toBe("auto");
		// R9: the first `task` of the request opens this turn's run with no plan; it is no longer refused.
		const opened = await omp.emit("tool_call", { toolName: "task", toolCallId: "open-1", input: { agent: "storm-explorer", name: "look", task: "read the tree" } }, main);
		expect(opened).not.toHaveProperty("block");
		expect(verdict(opened)).toBe("pass");
		expect(activeLedgerRun(project.sessionDir)?.runId).toBeDefined();
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
		// The live record is rewritten atomically on a timer; a read that crosses a rewrite sees no file, so wait for the state.
		let opened: RunRecord | undefined;
		await until(async () => (opened = await readRun(project.sessionDir, runId as string))?.request === "fix the login bug");
		expect(opened).toMatchObject({
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
		// The supervisor gate stays on during the automatic run: no direct edit, shell or eval call (a file read is open).
		for (const call of [
			{ toolName: "bash", input: { command: "git status" } },
			{ toolName: "eval", input: { code: "1" } },
		]) {
			expect(verdict(await omp.emit("tool_call", call, main))).toBe("auto");
		}
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("pass");
		const inRun = (await omp.emit("tool_call", { toolName: "bash", input: { command: "git status" } }, main)) as { reason: string };
		expect(inRun.reason).toContain(SUPERVISOR_REASONS.toolRuns);
		expect(inRun.reason).not.toContain("프로젝트 도구");
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
		expect(verdict(await omp.emit("tool_call", readFile, main))).toBe("pass");
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
		omp.usage.current = { tokens: 286_512, contextWindow: 400_000, percent: 72 };
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
		expect(record?.checkpoints).toEqual([expect.objectContaining({ before: 286_512, after: 30_000 })]);
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
		// Under 70% of the window at plan time: no summary yet.
		expect(omp.compactions).toEqual([]);
		// The run grows while it waits synchronously; the wait tool's start is a real boundary.
		omp.usage.current = { tokens: 285_000, contextWindow: 400_000, percent: 71 };
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
		// The manual run started under half its window; its director now grows past 70% of it.
		omp.usage.current = { tokens: 290_000, contextWindow: 400_000, percent: 73 };
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
		omp.usage.current = { tokens: 290_000, contextWindow: 400_000, percent: 73 };
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
		let record: RunRecord | undefined;
		await until(async () => (record = await readRun(project.sessionDir, runId as string))?.request === "new request");
		expect(record).toMatchObject({ request: "new request" });
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
		let reopened: RunRecord | undefined;
		await until(async () => (reopened = await readRun(project.sessionDir, runId))?.request === "new request");
		expect(reopened).toMatchObject({ request: "new request" });
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
		await writeConfig(project.sessionDir, { ...TEAM, rounds: 9 });
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
		// A shell call tells whether the guard is on: a file read is open either way.
		const shellCall = { toolName: "bash", input: { command: "ls" } };
		await omp.emit("session_start", {}, main);
		expect(verdict(await omp.emit("tool_call", shellCall, main))).toBe("auto");
		await writeAutoDelegation(dir, false);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "hello", systemPrompt: ["base"] }, main);
		expect(verdict(await omp.emit("tool_call", shellCall, main))).toBe("pass");
		await writeAutoDelegation(dir, true);
		await omp.emit("session_switch", {}, main);
		expect(verdict(await omp.emit("tool_call", shellCall, main))).toBe("auto");
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

		const placedFix = await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_1",
			input: { agent: "storm-implementer", name: "fix", task: "Write report.json" },
		}, main);
		expect(verdict(placedFix)).toBe("pass");
		const fix = placedName(placedFix, "fix");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", fix), main))).toBe("route:a/i");

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
			attemptId: `task:call_1:${fix}`,
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

		const placedLook = await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_2",
			input: { agent: "storm-explorer", name: "look", task: "Read notes.md" },
		}, main);
		expect(verdict(placedLook)).toBe("pass");
		const look = placedName(placedLook, "look");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", look), main))).toBe("route:a/x:low,b/z:low");
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
			attemptId: `job:job_1:${look}`,
			origin: "attempt",
		});
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);
	test("a follow-up whose job omp registered under the agent id again reaches the ledger, from the write's and the delivery's job rows", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
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
		if (runId === undefined) throw new Error("no active run");
		// The parent's own job rows, as omp shows them: only what a test sets.
		const rows: { running: unknown[]; recent: unknown[] } = { running: [], recent: [] };
		const parent = { ...main, getAsyncJobSnapshot: () => ({ running: rows.running, recent: rows.recent, delivery: {} }) } as unknown as ExtensionContext;
		const delivery = (text: string) => ({
			message: { customType: "async-result", content: text, details: { jobs: [{ jobId: "look", agentId: "look", status: "completed" }] } },
		});

		const placedLook = await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_5",
			input: { agent: "storm-explorer", name: "look", task: "Read notes.md" },
		}, parent);
		expect(verdict(placedLook)).toBe("pass");
		const look = placedName(placedLook, "look");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", look), parent))).toMatch(/^route:/);
		const worker = child.ctx(sub(look, "storm-explorer"));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		// The first turn's job is `look`; it delivers an answer with no citation.
		const started = Date.now();
		rows.recent = [{ id: "look", type: "task", status: "completed", agentId: "look", startTime: started - 500, endTime: started }];
		await omp.emit("message_end", delivery("I could not find anything to cite."), parent);
		await child.emit("agent_end", {}, worker);
		await until(async () => (await readRun(project.sessionDir, runId))?.results?.some(row => row.id === "total" && row.state === "unmet") === true);
		const first = (await readRun(project.sessionDir, runId))?.results?.find(row => row.id === "total")?.attemptId;
		expect(first).toBe(`job:look:${look}`);

		// Later, omp has evicted that row; the director writes a follow-up and omp wakes the worker under the same id.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "write_1", input: { path: "agent://look", content: "cite notes.md:1" } }, parent))).toBe("pass");
		const woken = Date.now() + 50;
		rows.recent = [];
		rows.running = [{ id: "look", type: "task", status: "running", agentId: "look", startTime: woken }];
		await omp.emit("tool_result", { toolName: "write", toolCallId: "write_1", isError: false, input: { path: "agent://look", content: "cite notes.md:1" }, content: [] }, parent);
		await child.emit("agent_start", {}, worker);
		rows.running = [];
		rows.recent = [{ id: "look", type: "task", status: "completed", agentId: "look", startTime: woken, endTime: woken + 200 }];
		await omp.emit("message_end", delivery("The total is 42 (notes.md:1)"), parent);
		await child.emit("agent_end", {}, worker);

		await until(async () => (await readRun(project.sessionDir, runId))?.results?.some(row => row.id === "total" && row.state === "accepted") === true);
		const row = (await readRun(project.sessionDir, runId))?.results?.find(candidate => candidate.id === "total");
		expect(row).toMatchObject({ state: "accepted", attemptId: `job:look.t${woken}:${look}`, origin: "attempt" });
		// The lane is no longer running: nothing is left open for the end of the run to rewrite.
		await omp.emit("session_shutdown", {}, parent);
		const final = (await readRun(project.sessionDir, runId))?.results?.find(candidate => candidate.id === "total");
		expect(final).toMatchObject({ state: "accepted" });
		expect(final?.finalized).toBeUndefined();
	}, 15_000);

	for (const helperWrite of [false, true]) {
		test(`a lane's own worker answers while a leftover helper of the same role is written to (${helperWrite ? "write to the helper" : "control: no write"}): the lane's cited answer is its result`, async () => {
			await approve(TEAM);
			await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.command("read the total", main);
			expect(await omp.tool({
				action: "plan",
				plan: {
					lanes: [{ name: "again", kind: "explore", role: "explorer", files: ["notes.md"], results: [{ id: "total-again", kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }] }],
					workers: { explorer: 2 },
				},
			}, main)).toBe("ok");
			const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
			if (runId === undefined) throw new Error("no active run");
			// A helper left over from an earlier run: an idle explorer this run never spawned.
			admitChild(runId, "old");
			const helper = child.ctx(sub("old", "storm-explorer"));
			await child.emit("before_agent_start", { systemPrompt: [] }, helper);
			await child.emit("agent_end", {}, helper);
			// The lane's own worker is spawned and working.
			const placedAgain = await omp.emit("tool_call", { toolName: "task", toolCallId: "call_again", input: { agent: "storm-explorer", name: "again", task: "Read notes.md" } }, main);
			expect(verdict(placedAgain)).toBe("pass");
			const again = placedName(placedAgain, "again");
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", again), main))).toMatch(/^route:/);
			const own = child.ctx(sub(again, "storm-explorer"));
			await child.emit("before_agent_start", { systemPrompt: [] }, own);
			if (helperWrite) {
				// The only explorer lane binds the helper by role; omp wakes it.
				expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "write_old", input: { path: "agent://old", content: "help out" } }, main))).toBe("pass");
				await omp.emit("tool_result", { toolName: "write", toolCallId: "write_old", isError: false, input: { path: "agent://old", content: "help out" }, content: [] }, main);
			}
			await omp.emit("message_end", {
				message: { customType: "async-result", content: "The total is 42 (notes.md:1)", details: { jobs: [{ jobId: "again", agentId: "again", status: "completed" }] } },
			}, main);
			await child.emit("agent_end", {}, own);
			await until(async () => (await readRun(project.sessionDir, runId))?.results?.some(row => row.id === "total-again" && row.state === "accepted") === true);
			expect((await readRun(project.sessionDir, runId))?.results?.find(row => row.id === "total-again")).toMatchObject({ state: "accepted", attemptId: `job:again:${again}` });
			await omp.emit("session_shutdown", {}, main);
		}, 15_000);
	}

	test("a follow-up write that fails leaves no open dispatch: the lane that needs the accepted answer is admitted", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("read the total", main);
		expect(await omp.tool({
			action: "plan",
			plan: {
				lanes: [
					{ name: "look", kind: "explore", role: "explorer", files: ["notes.md"], results: [{ id: "total", kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }] },
					{ name: "use", kind: "explore", role: "explorer", goal: "use the total", dependsOn: [{ lane: "look", need: "result" }], results: answerFor("use-answer") },
				],
				workers: { explorer: 2 },
			},
		}, main)).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		if (runId === undefined) throw new Error("no active run");
		expect(verdict(await omp.emit("tool_call", { toolName: "task", toolCallId: "call_6", input: { agent: "storm-explorer", name: "look", task: "Read notes.md" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "look"), main))).toMatch(/^route:/);
		const worker = child.ctx(sub("look", "storm-explorer"));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		await omp.emit("message_end", {
			message: { customType: "async-result", content: "The total is 42 (notes.md:1)", details: { jobs: [{ jobId: "look", agentId: "look", status: "completed" }] } },
		}, main);
		await child.emit("agent_end", {}, worker);
		await until(async () => (await readRun(project.sessionDir, runId))?.results?.some(row => row.id === "total" && row.state === "accepted") === true);

		// The follow-up is admitted, then the host fails the write: the worker was never asked.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "write_f", input: { path: "agent://look", content: "again" } }, main))).toBe("pass");
		await omp.emit("tool_result", { toolName: "write", toolCallId: "write_f", isError: true, input: { path: "agent://look", content: "again" }, content: [] }, main);
		expect(verdict(await omp.emit("tool_call", { toolName: "task", toolCallId: "call_7", input: { agent: "storm-explorer", name: "use", task: "Use it" } }, main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);

	for (const order of [["write_a", "write_b"], ["write_b", "write_a"]] as const) {
		test(`two failing follow-up writes to one worker in one director message (results reported ${order.join(" then ")}) leave no open dispatch`, async () => {
			await approve(TEAM);
			await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.command("read the total", main);
			expect(await omp.tool({
				action: "plan",
				plan: {
					lanes: [
						{ name: "look", kind: "explore", role: "explorer", files: ["notes.md"], results: [{ id: "total", kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }] },
						{ name: "use", kind: "explore", role: "explorer", goal: "use the total", dependsOn: [{ lane: "look", need: "result" }], results: answerFor("use-answer") },
					],
					workers: { explorer: 2 },
				},
			}, main)).toBe("ok");
			const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
			if (runId === undefined) throw new Error("no active run");
			const placedLook = await omp.emit("tool_call", { toolName: "task", toolCallId: "call_6", input: { agent: "storm-explorer", name: "look", task: "Read notes.md" } }, main);
			expect(verdict(placedLook)).toBe("pass");
			const look = placedName(placedLook, "look");
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", look), main))).toMatch(/^route:/);
			const worker = child.ctx(sub(look, "storm-explorer"));
			await child.emit("before_agent_start", { systemPrompt: [] }, worker);
			await omp.emit("message_end", {
				message: { customType: "async-result", content: "The total is 42 (notes.md:1)", details: { jobs: [{ jobId: "look", agentId: "look", status: "completed" }] } },
			}, main);
			await child.emit("agent_end", {}, worker);
			await until(async () => (await readRun(project.sessionDir, runId))?.results?.some(row => row.id === "total" && row.state === "accepted") === true);

			// omp runs every call's tool_call hook before any call executes, so both writes are admitted, then both fail.
			const write = (id: string) => ({ toolName: "write", toolCallId: id, input: { path: "agent://look", content: id } });
			expect(verdict(await omp.emit("tool_call", write("write_a"), main))).toBe("pass");
			expect(verdict(await omp.emit("tool_call", write("write_b"), main))).toBe("pass");
			for (const id of order) await omp.emit("tool_result", { ...write(id), isError: true, content: [] }, main);
			// The dependant is admitted: nothing of the lane is left running.
			expect(verdict(await omp.emit("tool_call", { toolName: "task", toolCallId: "call_7", input: { agent: "storm-explorer", name: "use", task: "Use it" } }, main))).toBe("pass");
			// A later, real follow-up still opens its own dispatch, so its delivery is recorded as the lane's newest attempt.
			const rows: { running: unknown[]; recent: unknown[] } = { running: [], recent: [] };
			const parent = { ...main, getAsyncJobSnapshot: () => ({ running: rows.running, recent: rows.recent, delivery: {} }) } as unknown as ExtensionContext;
			expect(verdict(await omp.emit("tool_call", write("write_c"), parent))).toBe("pass");
			const woken = Date.now() + 50;
			rows.running = [{ id: "look", type: "task", status: "running", agentId: look, startTime: woken }];
			await omp.emit("tool_result", { ...write("write_c"), isError: false, content: [] }, parent);
			rows.running = [];
			rows.recent = [{ id: "look", type: "task", status: "completed", agentId: look, startTime: woken, endTime: woken + 200 }];
			await omp.emit("message_end", {
				message: { customType: "async-result", content: "The total is 42 (notes.md:1)", details: { jobs: [{ jobId: "look", agentId: "look", status: "completed" }] } },
			}, parent);
			await until(async () => (await readRun(project.sessionDir, runId))?.results?.find(row => row.id === "total")?.attemptId === `job:look.t${woken}:${look}`);
			await omp.emit("session_shutdown", {}, parent);
			const final = (await readRun(project.sessionDir, runId))?.results?.find(row => row.id === "total");
			expect(final).toMatchObject({ state: "accepted" });
			expect(final?.finalized).toBeUndefined();
		}, 15_000);
	}

	test("a worker of the earlier run, written to by the next run in the same session, has its answer recorded in that run", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const rows: { running: unknown[]; recent: unknown[] } = { running: [], recent: [] };
		const parent = { ...main, getAsyncJobSnapshot: () => ({ running: rows.running, recent: rows.recent, delivery: {} }) } as unknown as ExtensionContext;
		const delivery = (text: string) => ({
			message: { customType: "async-result", content: text, details: { jobs: [{ jobId: "look", agentId: "look", status: "completed" }] } },
		});
		const lane = (name: string, result: string) => ({ name, kind: "explore", role: "explorer", files: ["notes.md"], results: [{ id: result, kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }] });
		const plan = async (lanes: object[]): Promise<string> => {
			expect(await omp.tool({ action: "plan", plan: { lanes, workers: { explorer: 1 } } }, parent)).toBe("ok");
			const id = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
			if (id === undefined) throw new Error("no active run");
			return id;
		};

		// Run A: the worker `look` answers and the run is over.
		await omp.command("read the total", parent);
		const first = await plan([lane("look", "total")]);
		const placedLook = await omp.emit("tool_call", { toolName: "task", toolCallId: "call_a", input: { agent: "storm-explorer", name: "look", task: "Read notes.md" } }, parent);
		expect(verdict(placedLook)).toBe("pass");
		const handle = placedName(placedLook, "look");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", handle), parent))).toMatch(/^route:/);
		const worker = child.ctx(sub(handle, "storm-explorer"));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		rows.recent = [{ id: "look", type: "task", status: "completed", agentId: handle, startTime: Date.now() - 500, endTime: Date.now() }];
		await omp.emit("message_end", delivery("The total is 42 (notes.md:1)"), parent);
		await child.emit("agent_end", {}, worker);
		await until(async () => (await readRun(project.sessionDir, first))?.results?.some(row => row.id === "total" && row.state === "accepted") === true);
		// The conversation is re-opened (the host's session switch): run A ends, the collector forgets its dispatches.
		await omp.emit("session_switch", { reason: "resume" }, parent);

		// Run B, same session: its director writes to the idle worker of run A, which the plan's one explorer lane covers.
		await omp.command("read the total again", parent);
		const second = await plan([lane("look-again", "total-again")]);
		expect(second).not.toBe(first);
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "write_b", input: { path: `agent://${worker.agent.id}`, content: "cite notes.md:1 again" } }, parent))).toBe("pass");
		const woken = Date.now() + 50;
		rows.recent = [];
		rows.running = [{ id: "look", type: "task", status: "running", agentId: worker.agent.id, startTime: woken }];
		await omp.emit("tool_result", { toolName: "write", toolCallId: "write_b", isError: false, input: { path: `agent://${worker.agent.id}`, content: "cite notes.md:1 again" }, content: [] }, parent);
		rows.running = [];
		rows.recent = [{ id: "look", type: "task", status: "completed", agentId: "look", startTime: woken, endTime: woken + 200 }];
		await omp.emit("message_end", delivery("Again: the total is 42 (notes.md:1)"), parent);
		await child.emit("agent_end", {}, worker);
		await until(async () => (await readRun(project.sessionDir, second))?.results?.find(row => row.id === "total-again")?.attemptId !== undefined);
		const row = (await readRun(project.sessionDir, second))?.results?.find(candidate => candidate.id === "total-again");
		expect(row).toMatchObject({ origin: "attempt" });
		expect(row?.attemptId).toMatch(/^job:look/);
		await omp.emit("session_shutdown", {}, parent);
	}, 20_000);

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

		// The explorer's own task is never given a packet: it gets its lane's result contract and nothing about a submission.
		const explorerTask = ((await omp.emit("tool_call", {
			toolName: "task",
			toolCallId: "call_3",
			input: { agent: "storm-explorer", name: "look", task: "Read notes.md" },
		}, main)) as { input: { task: string } }).input.task;
		expect(explorerTask.startsWith("Read notes.md\n\n[storm:계약]")).toBe(true);
		expect(explorerTask).not.toContain("[storm:answer-review]");
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
		const impl = child.ctx(sub("fix"));
		await omp.emit("session_start", {}, main);
		await omp.command("task", main);
		await applyRunPlan(omp, main, { lanes: [{ ...fixLane, files: ["allowed.txt"] }] });
		// R4: the spawn key is exactly the lane's pending placement (manual planned items keep the lane name).
		const placedFix = await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "fix", task: "edit" } }, main);
		expect(verdict(placedFix)).toBe("pass");
		const fix = placedName(placedFix, "fix");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", fix), main))).toBe("route:a/i");
		const record = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: fix });
		expect(record).toMatchObject({ kind: "record", record: { lane: "fix", policy: { kind: "paths", paths: ["allowed.txt"] } } });

		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "allowed.txt", content: "x" } }, impl))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "outside.txt", content: "x" } }, impl))).toBe("lane-scope");

		// A different child of the same active managed tree has no admission: writes fail closed, reads stay ordinary.
		const stray = child.ctx(sub("Stray", "unrelated"));
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "stray.txt", content: "x" } }, stray))).toBe("authority");
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "allowed.txt" } }, stray))).toBe("pass");

		await omp.emit("session_shutdown", {}, main);
		expect(await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: fix })).toMatchObject({
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
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "fix", task: "edit" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "fix"), main))).toBe("route:a/i");
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
		const base = child.ctx(sub("probe"));
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
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "probe", task: "probe" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "probe"), main))).toBe("route:a/i");

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
		expect(manualPrompt.join("\n")).toContain("Routine in-scope setup");
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

describe("the lane view switch (command)", () => {
	test("/storm view is offered next to auto, described in Korean, and nothing else changed", () => {
		const omp = fakeOmp(project);
		const all = omp.completions("") ?? [];
		const names = all.map(entry => entry.value);
		expect(names).toContain("view");
		expect(names).toContain("auto");
		const view = all.find(entry => entry.value === "view");
		expect(view?.description).toMatch(/[가-힣]/);
		expect(omp.completions("vi")?.map(entry => entry.value)).toEqual(["view"]);
	});
});

describe("the lane view switch", () => {
	/** A TUI host whose widget slot is kept, so a test can render what the run draws below the editor. */
	function liveTui(main: ExtensionContext, terminalRows = 40) {
		const widgets = new Map<string, { render(width: number): readonly string[]; dispose?(): void }>();
		const host: ExtensionUiHost = { requestRender: () => undefined, size: () => ({ columns: 120, rows: terminalRows }), suspend: run => run() };
		const ctx = {
			...main,
			mode: "tui",
			ui: {
				...(main.ui as unknown as Record<string, unknown>),
				theme: extensionTheme(currentTheme()),
				setWidget: (key: string, content: unknown) => {
					if (content === undefined) {
						widgets.get(key)?.dispose?.();
						widgets.delete(key);
						return;
					}
					const rows = (content as ExtensionUiFactory)(host, extensionTheme(currentTheme()));
					widgets.set(key, rows as { render(width: number): readonly string[]; dispose?(): void });
				},
			},
		} as unknown as ExtensionContext;
		return { ctx, draw: (columns = 100) => (widgets.get("storm-live")?.render(columns) ?? []).map(row => Bun.stripANSI(row)) };
	}
	const RADAR = /\[[\u2801-\u28ff]{18}\]$/;
	const noticesAbout = (omp: ReturnType<typeof fakeOmp>) => omp.notices.map(notice => notice.level);

	test("the lane view is on by default; /storm view turns it off and on again during a run, each drawing exactly as tall as it is", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const host = liveTui(omp.ctx(MAIN));
		await omp.emit("session_start", {}, host.ctx);
		await omp.command("fix it", host.ctx);
		const lane = host.draw();
		// Nothing is padded: a run without a plan yet draws the status row and the trunk, no more.
		expect(lane).toHaveLength(2);
		expect(lane[0]).toStartWith(STORM_MARK);
		expect(lane[0]).not.toMatch(RADAR);
		expect(lane[1]!.trim()).not.toBe("");

		await omp.command("view", host.ctx);
		const line = host.draw();
		// The single line again: its own two rows, none blank.
		expect(line).toHaveLength(2);
		expect(line[0]).toMatch(RADAR);
		expect(line.every(row => row.trim() !== "")).toBe(true);
		expect(omp.notices.at(-1)?.level).toBe("info");

		await omp.command("view", host.ctx);
		const back = host.draw();
		expect(back).toHaveLength(2);
		expect(back[0]).not.toMatch(RADAR);
		expect(back[1]!.trim()).not.toBe("");
		expect(noticesAbout(omp).includes("error")).toBe(false);
		await omp.emit("agent_start", {}, host.ctx);
		await omp.emit("agent_end", {}, host.ctx);
	});

	test("a view turned off before the run starts keeps the single line; turning it on mid-run shows the picture", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const host = liveTui(omp.ctx(MAIN));
		await omp.emit("session_start", {}, host.ctx);
		await omp.command("view", host.ctx);
		await omp.command("fix it", host.ctx);
		const line = host.draw();
		expect(line.length).toBeLessThanOrEqual(2);
		expect(line[0]).toMatch(RADAR);

		await omp.command("view", host.ctx);
		const lane = host.draw();
		expect(lane[0]).not.toMatch(RADAR);
		expect(lane.every(row => row.trim() !== "")).toBe(true);
		await omp.emit("agent_start", {}, host.ctx);
		await omp.emit("agent_end", {}, host.ctx);
	});

	test("the switch is one session's own and is dropped at a conversation boundary: the view is on again", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const host = liveTui(omp.ctx(MAIN));
		await omp.emit("session_start", {}, host.ctx);
		await omp.command("view", host.ctx);
		await omp.emit("session_switch", {}, host.ctx);
		await omp.emit("session_start", {}, host.ctx);
		await omp.command("fix it", host.ctx);
		expect(host.draw()[0]).not.toMatch(RADAR);
		await omp.emit("agent_start", {}, host.ctx);
		await omp.emit("agent_end", {}, host.ctx);
	});

	test("a host without the terminal screen changes nothing and says so", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		const before = omp.notices.length + omp.transcript.length;
		await omp.command("view", main);
		// Said somewhere the user can read it (the notice or the transcript), once.
		expect(omp.notices.length + omp.transcript.length).toBe(before + 1);
		// The refused command left the switch alone: a TUI of the same session still has the view.
		const host = liveTui(main);
		await omp.command("fix it", host.ctx);
		expect(host.draw()[0]).not.toMatch(RADAR);
		await omp.emit("agent_start", {}, host.ctx);
		await omp.emit("agent_end", {}, host.ctx);
	});
});

describe("the director reads what a delivery changed, in the place it reads the delivery", () => {
	const lookLane = { name: "look", kind: "explore", role: "explorer", files: ["notes.md"], results: [{ id: "total", kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }] };
	const useLane = { name: "use", kind: "explore", role: "explorer", goal: "use the total", dependsOn: [{ lane: "look", need: "result" }], results: answerFor("use-answer") };
	const CITED_ANSWER = "The total is 42 (notes.md:1)";
	const UNCITED_ANSWER = "I looked at the note and found the total.";
	type ContextAnswer = { messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> };

	/** A run with the explorer lane `look` admitted and spawned, and `use` waiting on it. */
	async function lookRun(lanes: object[] = [lookLane, useLane]) {
		await approve(TEAM);
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("read the total", main);
		expect(await omp.tool({ action: "plan", plan: { lanes, workers: { explorer: 2 } } }, main)).toBe("ok");
		const runId = activeLedgerRun((await loadProjectState(project.env)).sessionDir)?.runId;
		if (runId === undefined) throw new Error("no active run");
		const placedLook = await omp.emit("tool_call", { toolName: "task", toolCallId: "call_n1", input: { agent: "storm-explorer", name: "look", task: "Read notes.md" } }, main);
		expect(verdict(placedLook)).toBe("pass");
		const look = placedName(placedLook, "look");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", look), main))).toMatch(/^route:/);
		const worker = child.ctx(sub(look, "storm-explorer"));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		const diskRow = async () => (await readRun(project.sessionDir, runId))?.results?.find(row => row.id === "total");
		/** The record is flushed after the settlement: wait until it shows the state, then read the row. */
		const rowOf = async (state?: string) => {
			if (state !== undefined) await until(async () => (await diskRow())?.state === state);
			return diskRow();
		};
		const pushed = async (text: string) => {
			await omp.emit("message_end", { message: { customType: "async-result", content: text, details: { jobs: [{ jobId: look, agentId: look, status: "completed" }] } } }, main);
		};
		const waited = async (text: string) => {
			// The job completes after the worker's turn ended; `wait` then hands its result over.
			await child.emit("agent_end", {}, worker);
			const settledAtMs = Date.now() + 100;
			return omp.emit("tool_result", {
				toolName: "wait",
				toolCallId: "call_wait",
				isError: false,
				input: {},
				content: [],
				details: { op: "wait", jobs: [{ id: look, type: "task", status: "completed", agentUrlId: look, settledAtMs, durationMs: 50, resultText: text }] },
			}, main);
		};
		/** The next provider request's context: what the director would read beyond its history. */
		const request = (on: ExtensionContext = main) => omp.emit("context", { messages: [{ role: "user", content: "go on", timestamp: 1 }] }, on) as Promise<ContextAnswer | undefined>;
		/** Waits for the notice a pushed delivery left, taking it the way the next request does. */
		const pushedNotice = async (): Promise<ContextAnswer> => {
			let out: ContextAnswer | undefined;
			await until(async () => {
				out = await request();
				return out !== undefined;
			});
			return out as ContextAnswer;
		};
		/** The host's typed task acknowledgement for the call that placed `look`, with its exact execution proof. */
		const acknowledged = (look: string, token: string) => omp.emit("tool_result", {
			toolName: "task",
			toolCallId: "call_n1",
			isError: false,
			input: {},
			content: [],
			details: {
				async: {
					state: "running",
					jobId: look,
					type: "task",
					executions: [{
						revision: 1,
						jobId: look,
						type: "task",
						executionToken: token,
						itemIndex: 0,
						agentId: look,
						ownerSessionId: project.sessionId,
					}],
				},
			},
		}, main);
		return { omp, child, main, worker, runId, rowOf, pushed, waited, request, pushedNotice, acknowledged };
	}
	const textOf = (answer: ContextAnswer): string => answer.messages.at(-1)?.content.map(part => part.text).join("") ?? "";

	test("candidate lookup uses each conversation's own bound store across a switch", async () => {
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const secondId = `${project.sessionId}-other`;
		const secondDir = sessionStoreDir(project.agentDir, secondId);
		const reader = (label: string): IntegrationRuntimePorts => ({
			controller: { project: async () => ({ kind: "not-recorded" }) },
			view: { formatIntegrationCandidates: () => label },
		}) as unknown as IntegrationRuntimePorts;
		bindIntegrationRuntime(project.sessionDir, reader("first-conversation-queue"));
		bindIntegrationRuntime(secondDir, reader("other-conversation-queue"));
		try {
			expect(await omp.toolReply({ action: "candidates" }, main)).toMatchObject({
				outcome: "ok", text: "first-conversation-queue",
			});
			omp.setSessionId(secondId);
			expect(await omp.toolReply({ action: "candidates" }, main)).toMatchObject({
				outcome: "ok", text: "other-conversation-queue",
			});
			bindIntegrationRuntime(project.sessionDir, undefined);
			expect(await omp.toolReply({ action: "candidates" }, main)).toMatchObject({
				outcome: "ok", text: "other-conversation-queue",
			});
		} finally {
			bindIntegrationRuntime(project.sessionDir, undefined);
			bindIntegrationRuntime(secondDir, undefined);
		}
	});

	test("a pushed delivery Storm did not accept is on the director's next request: result, state, reason and the citation form", async () => {
		const run = await lookRun();
		const sentBefore = run.omp.sent.length;
		await run.pushed(UNCITED_ANSWER);
		await run.child.emit("agent_end", {}, run.worker);
		const answer = await run.pushedNotice();
		// The request's own messages are kept and the notice follows them, as a developer message.
		expect(answer.messages).toHaveLength(2);
		expect(answer.messages.at(-1)?.role).toBe("developer");
		const text = textOf(answer);
		expect(text).toContain("look");
		expect(text).toContain("total");
		expect(text).toContain("미충족");
		expect(text).toContain((await run.rowOf("unmet"))!.reason!.replace(/[.。]+$/u, ""));
		expect(text).toContain("path:line");
		expect(text).not.toContain(LEDGER_READY_LEAD);
		// Once: the following request carries nothing more, and nothing was started because of it.
		expect(await run.request()).toBeUndefined();
		expect(run.omp.sent).toHaveLength(sentBefore);
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("a delivery returned by wait carries the notice on that call's result, and is not read twice", async () => {
		const run = await lookRun();
		const result = (await run.waited(CITED_ANSWER)) as { additionalContext?: string } | undefined;
		expect(result?.additionalContext).toContain("use");
		expect(result?.additionalContext).toContain(LEDGER_READY_LEAD);
		expect(result?.additionalContext).not.toContain("수용하지 않았습니다");
		expect((await run.rowOf("accepted"))?.state).toBe("accepted");
		// Taken: the next request has nothing left to add.
		expect(await run.request()).toBeUndefined();
		// And no worker was started for the lane it names.
		expect(listAgents({ runId: run.runId, scope: project.sessionDir }).map(agent => agent.name)).not.toContain("use");
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("a refused delivery by wait names the state and the citation form", async () => {
		const run = await lookRun();
		const result = (await run.waited(UNCITED_ANSWER)) as { additionalContext?: string } | undefined;
		expect(result?.additionalContext).toContain("미충족");
		expect(result?.additionalContext).toContain("path:line");
		expect(result?.additionalContext).not.toContain(LEDGER_READY_LEAD);
		expect(await run.request()).toBeUndefined();
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("accepted with nothing waiting on it adds nothing, by either way", async () => {
		const run = await lookRun([lookLane]);
		const result = (await run.waited(CITED_ANSWER)) as { additionalContext?: string } | undefined;
		expect(result?.additionalContext).toBeUndefined();
		expect((await run.rowOf("accepted"))?.state).toBe("accepted");
		expect(await run.request()).toBeUndefined();
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("an exact typed ack makes the pushed delivery one bounded model-only summary", async () => {
		const run = await lookRun([lookLane]);
		const look = run.worker.agent.id;
		await run.acknowledged(look, "exec-look-1");
		const user = { role: "user", content: "go on", timestamp: 1 };
		const delivery = {
			role: "custom",
			customType: "async-result",
			content: CITED_ANSWER,
			timestamp: 10,
			details: {
				jobs: [{
					jobId: look,
					agentId: look,
					status: "completed",
					execution: {
						revision: 1,
						jobId: look,
						type: "task",
						executionToken: "exec-look-1",
						itemIndex: 0,
						agentId: look,
						ownerSessionId: project.sessionId,
					},
				}],
			},
		};
		// The request itself carries the delivery: the hook observes it first, then projects the original array.
		const answer = (await run.omp.emit("context", { messages: [user, delivery] }, run.main)) as ContextAnswer | undefined;
		expect(answer).toBeDefined();
		expect(answer!.messages).toHaveLength(2);
		expect(answer!.messages[0]?.role).toBe("user");
		expect(JSON.stringify(answer!.messages[0])).toContain("go on");
		expect(answer!.messages.at(-1)?.role).toBe("developer");
		const summary = textOf(answer!);
		expect(summary).toContain("비동기 배달 요약");
		expect(summary).toContain(`job:${look}:${look}`);
		expect(summary).toContain("미해결 0개");
		expect(summary).not.toContain(CITED_ANSWER);
		expect((await run.rowOf("accepted"))?.state).toBe("accepted");
		// Taken once, and nothing was started because of it.
		expect(await run.request()).toBeUndefined();
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("a proof with no exact typed ack leaves the original request byte-identical", async () => {
		const run = await lookRun([lookLane]);
		const look = run.worker.agent.id;
		const user = { role: "user", content: "go on", timestamp: 1 };
		const delivery = {
			role: "custom",
			customType: "async-result",
			content: CITED_ANSWER,
			timestamp: 10,
			details: {
				jobs: [{
					jobId: look,
					agentId: look,
					status: "completed",
					execution: {
						revision: 1,
						jobId: look,
						type: "task",
						executionToken: "exec-unacked",
						itemIndex: 0,
						agentId: look,
						ownerSessionId: project.sessionId,
					},
				}],
			},
		};
		const before = JSON.stringify([user, delivery]);
		// The delivery is still evaluated (its row settles), but no summary replaces it in the provider request.
		expect(await run.omp.emit("context", { messages: [user, delivery] }, run.main)).toBeUndefined();
		expect(JSON.stringify([user, delivery])).toBe(before);
		expect((await run.rowOf("accepted"))?.state).toBe("accepted");
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("a mixed message is kept byte-identical while an owned sibling collapses", async () => {
		const run = await lookRun([lookLane]);
		const look = run.worker.agent.id;
		await run.acknowledged(look, "exec-look-1");
		const execution = {
			revision: 1,
			jobId: look,
			type: "task",
			executionToken: "exec-look-1",
			itemIndex: 0,
			agentId: look,
			ownerSessionId: project.sessionId,
		};
		const user = { role: "user", content: "go on", timestamp: 1 };
		const owned = {
			role: "custom",
			customType: "async-result",
			content: CITED_ANSWER,
			timestamp: 10,
			details: { jobs: [{ jobId: look, agentId: look, status: "completed", execution }] },
		};
		// No agentId on either row: the collector skips this test-only mixed frame, while the projection still sees the
		// first row's exact proof and the missing proof on its sibling.
		const mixed = {
			role: "custom",
			customType: "async-result",
			content: "MIXED BODY",
			timestamp: 11,
			details: { jobs: [{ jobId: look, status: "completed", execution }, { jobId: "foreign-row", status: "completed" }] },
		};
		const mixedBefore = JSON.stringify(mixed);
		const answer = (await run.omp.emit("context", { messages: [user, owned, mixed] }, run.main)) as ContextAnswer | undefined;
		expect(answer).toBeDefined();
		expect(answer!.messages).toHaveLength(3);
		expect(answer!.messages[0]?.role).toBe("user");
		expect(JSON.stringify(answer!.messages[0])).toContain("go on");
		expect(answer!.messages[1]?.role).toBe("custom");
		expect(JSON.stringify(answer!.messages[1])).toBe(mixedBefore);
		expect(JSON.stringify(mixed)).toBe(mixedBefore);
		const summary = textOf(answer!);
		expect(summary).toContain("원문을 그대로 둔 배달 1건");
		expect(summary).toContain(`job:${look}:${look}`);
		expect(summary).not.toContain("MIXED BODY");
		expect(summary).not.toContain(CITED_ANSWER);
		expect((await run.rowOf("accepted"))?.state).toBe("accepted");
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("a request that carries a delivery Storm was not yet told of evaluates it first, once, so the notice is on that request", async () => {
		const run = await lookRun();
		await run.child.emit("agent_end", {}, run.worker);
		const delivery = { role: "custom", customType: "async-result", content: UNCITED_ANSWER, details: { jobs: [{ jobId: "look", agentId: "look", status: "completed" }] }, timestamp: 5 };
		// omp built the request before it told Storm of the message: the request's own hook gives it to the collector.
		const answer = (await run.omp.emit("context", { messages: [{ role: "user", content: "go on", timestamp: 1 }, delivery] }, run.main)) as ContextAnswer | undefined;
		expect(answer).toBeDefined();
		expect(textOf(answer as ContextAnswer)).toContain("미충족");
		expect(textOf(answer as ContextAnswer)).toContain("path:line");
		// Then the host tells Storm of the same message: it is the same evaluation, not a second one.
		await run.omp.emit("message_end", { message: delivery }, run.main);
		expect(await run.request()).toBeUndefined();
		await until(async () => (await run.rowOf())?.state === "unmet");
		expect(await run.request()).toBeUndefined();
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);

	test("a child's own request neither reads nor takes the director's notice", async () => {
		const run = await lookRun();
		await run.pushed(UNCITED_ANSWER);
		await run.child.emit("agent_end", {}, run.worker);
		await until(async () => (await run.rowOf())?.state === "unmet");
		// Poll until the notice is queued, always from the child's side: it never sees it.
		for (let i = 0; i < 20; i++) expect(await run.request(run.worker)).toBeUndefined();
		expect(textOf(await run.pushedNotice())).toContain("미충족");
		await run.omp.emit("session_shutdown", {}, run.main);
	}, 15_000);
});

describe("the director continues an interrupted run through the hooks", () => {
	const lane = { name: "look", kind: "explore" as const, role: "explorer" as const, files: ["notes.md"], results: [{ id: "total", kind: "answer" as const, criterion: "what the note holds", path: "notes.md", contains: "42" }] };
	const planOf = (): RunPlan => ({ submittedAt: new Date().toISOString(), workers: { explorer: 1 }, lanes: [lane] });

	/** What the run of 2026-11-26 left: a run of this session and target the host cut off, with its plan and a request that is only a question. */
	const cutOff = async (over: Partial<RunRecord> = {}): Promise<RunRecord> => {
		const state = await loadProjectState(project.env);
		const run = runRecord({
			runId: "run-20261126-073428-48cc",
			startedAt: "2026-11-26T07:34:28.000Z",
			endedAt: "2026-11-26T08:28:31.000Z",
			status: "stopped",
			endReason: "host-ended",
			task: "작업현황",
			request: "작업현황",
			plan: planOf(),
			results: [{ id: "total", state: "pending", lane: "look", origin: "plan", identity: "x" } as never],
			...over,
		});
		await writeRun(state.sessionDir, run);
		await noteResumePointer(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }, run);
		return run;
	};
	const opened = async (prompt = "이어서 해줘") => {
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		if (prompt !== "") await omp.emit("before_agent_start", { reason: "prompt", prompt, systemPrompt: [] }, main);
		return { omp, main };
	};
	const startedRuns = async (): Promise<string[]> => {
		const dir = (await loadProjectState(project.env)).sessionDir;
		const id = activeLedgerRun(dir)?.runId;
		return id === undefined ? [] : [id];
	};

	test("under automatic delegation, in the user's turn, it opens a run that continues the interrupted one", async () => {
		await approve(TEAM);
		await enableAuto();
		const run = await cutOff();
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		const { omp, main } = await opened("재개");
		// The director can learn it: the status says a run can be continued, and by whom.
		const status = await omp.toolReply({ action: "status" }, main);
		expect(status.text).toContain(run.runId);
		expect(status.text).toContain("storm continue");
		const reply = await omp.toolReply({ action: "continue" }, main);
		expect(reply.outcome).toBe("ok");
		expect(reply.text).toContain(run.runId);
		expect(reply.text).toContain("look");
		const nextId = (await startedRuns())[0];
		expect(nextId).toBeDefined();
		expect(nextId).not.toBe(run.runId);
		const next = await readRun(project.sessionDir, nextId as string);
		expect(next).toMatchObject({ status: "running", resumeOf: run.runId, plan: { lanes: [{ name: "look" }] } });
		expect(next?.goal).toMatchObject({ runs: 1 });
		// The task is the interrupted run's work, not the question it was opened with.
		expect(next?.request).toContain("look");
		expect(next?.request?.startsWith(CONTINUATION_HEAD)).toBe(true);
		expect(next?.request?.split(`\n${EARLIER_REQUEST_MARKER}\n`)[0]).not.toContain("작업현황");
		// Inside the turn that is running: no handoff message and no dialog.
		expect(omp.sent).toEqual([]);
		expect(omp.selects).toEqual([]);
		// A second continue in the same turn is refused: a run is active.
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("rejected");
		expect(await startedRuns()).toEqual([nextId as string]);
		await omp.emit("session_shutdown", {}, main);
	});

	test("a run that stopped at or after this turn began is not continued in it; once the user speaks again it is, and the stop is named", async () => {
		await approve(TEAM);
		await enableAuto();
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		// A limit the user set stopped it after this turn's message began (a stop inside the turn); the user has not spoken since.
		const stoppedAt = Date.now() + 10 * 60_000;
		const run = await cutOff({ endReason: "budget", endedAt: new Date(stoppedAt).toISOString() });
		const { omp, main } = await opened("이어서 해줘");
		const status = await omp.toolReply({ action: "status" }, main);
		expect(status.text).toContain(endLabel("budget"));
		const refused = await omp.toolReply({ action: "continue" }, main);
		expect(refused).toEqual({ outcome: "rejected", text: CONTINUE_SAME_TURN });
		expect(await startedRuns()).toEqual([]);
		// The turn ends. The user's next message came later than the stop: now the same run continues.
		await omp.emit("agent_end", { messages: [] }, main);
		setSystemTime(new Date(stoppedAt + 60_000));
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "한도는 알지만 이어서 해줘", systemPrompt: [] }, main);
		const reply = await omp.toolReply({ action: "continue" }, main);
		expect(reply.outcome).toBe("ok");
		expect(reply.text).toContain(run.runId);
		expect(reply.text).toContain(endLabel("budget"));
		expect(await startedRuns()).toHaveLength(1);
		await omp.emit("session_shutdown", {}, main);
	});

	test("Storm's own adjustment nudge is not the user's turn, even when it starts a turn with no run active", async () => {
		await approve(TEAM);
		await enableAuto();
		await cutOff();
		const { omp, main } = await opened("");
		const nudge = '<storm-adjust run="run-x" action="retry" result="total" lane="look">Retry once.</storm-adjust>';
		await omp.emit("before_agent_start", { reason: "prompt", prompt: nudge, systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("rejected");
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).text).not.toContain("자동 위임 실행");
		expect(await startedRuns()).toEqual([]);
		await omp.emit("agent_end", { messages: [] }, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "이어서 해줘", systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("ok");
		await omp.emit("session_shutdown", {}, main);
	});

	describe("what the user's turn is across a pause on background work", () => {
		const paused = { messages: [], willContinue: true, awaitingAsyncWork: true };
		const requestOf = async (): Promise<string | undefined> => {
			const id = (await startedRuns())[0];
			return id === undefined ? undefined : (await readRun(project.sessionDir, id))?.request;
		};

		test("results that wake the paused director continue the request they belong to", async () => {
			await approve(TEAM);
			await enableAuto();
			const { omp, main } = await opened("첫 요청");
			await omp.emit("agent_end", paused, main);
			// The wake is no prompt: the request stays, and the director's plan opens the run for it.
			await omp.emit("agent_start", {}, main);
			expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).text).toContain("자동 위임 실행");
			expect(await requestOf()).toBe("첫 요청");
			await omp.emit("session_shutdown", {}, main);
		});

		test("a message the user types while it is paused is the new request, not the paused one", async () => {
			await approve(TEAM);
			await enableAuto();
			const { omp, main } = await opened("첫 요청");
			await omp.emit("agent_end", paused, main);
			await omp.emit("before_agent_start", { reason: "prompt", prompt: "두 번째 요청", systemPrompt: [] }, main);
			await omp.emit("agent_start", {}, main);
			expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).text).toContain("자동 위임 실행");
			expect(await requestOf()).toBe("두 번째 요청");
			await omp.emit("session_shutdown", {}, main);
		});

		test("without a pause a later prompt in the same turn does not replace the request", async () => {
			await approve(TEAM);
			await enableAuto();
			const { omp, main } = await opened("첫 요청");
			await omp.emit("before_agent_start", { reason: "prompt", prompt: "끼어든 말", systemPrompt: [] }, main);
			expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).text).toContain("자동 위임 실행");
			expect(await requestOf()).toBe("첫 요청");
			await omp.emit("session_shutdown", {}, main);
		});

		test("the time of the turn moves with the new message: a stop between the two messages can be continued by the second", async () => {
			await approve(TEAM);
			await enableAuto();
			await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
			const first = Date.now();
			// Stopped after the first message and before the second (a limit hit while the director was paused).
			await cutOff({ endReason: "time-limit", endedAt: new Date(first + 5 * 60_000).toISOString() });
			const { omp, main } = await opened("첫 요청");
			await omp.emit("agent_end", paused, main);
			expect((await omp.toolReply({ action: "continue" }, main)).text).toContain(CONTINUE_SAME_TURN);
			setSystemTime(new Date(first + 10 * 60_000));
			await omp.emit("before_agent_start", { reason: "prompt", prompt: "그래도 이어서 해줘", systemPrompt: [] }, main);
			expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("ok");
			await omp.emit("session_shutdown", {}, main);
		});
	});

	test("with delegation set to manual it starts nothing and says where the user can", async () => {
		await approve(TEAM);
		const run = await cutOff();
		const { omp, main } = await opened("재개");
		const status = await omp.toolReply({ action: "status" }, main);
		expect(status.text).toContain(run.runId);
		expect(status.text).not.toContain("storm continue");
		const reply = await omp.toolReply({ action: "continue" }, main);
		expect(reply.outcome).toBe("rejected");
		expect(reply.text).toContain("/storm");
		expect(await startedRuns()).toEqual([]);
		await omp.emit("session_shutdown", {}, main);
	});

	test("a turn the user's own message did not begin (a revive, an empty prompt) starts nothing", async () => {
		await approve(TEAM);
		await enableAuto();
		await cutOff();
		const { omp, main } = await opened("");
		await omp.emit("before_agent_start", { reason: "revive", prompt: "revived context", systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("rejected");
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "   ", systemPrompt: [] }, main);
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("rejected");
		expect(await startedRuns()).toEqual([]);
		await omp.emit("session_shutdown", {}, main);
	});

	test("with no interrupted run, or only a finished one, it starts nothing and the director may plan instead", async () => {
		await approve(TEAM);
		await enableAuto();
		const { omp, main } = await opened();
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("rejected");
		await cutOff({ status: "done", endReason: "verified" });
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("rejected");
		expect(await startedRuns()).toEqual([]);
		// The ordinary way in still works in this very turn.
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).text).toContain("자동 위임 실행");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a run of another session or another project is not continued", async () => {
		await approve(TEAM);
		await enableAuto();
		const state = await loadProjectState(project.env);
		// Written to this store but never recorded as started here: no pointer, so it is nobody's to continue.
		await writeRun(state.sessionDir, runRecord({ runId: "run-20261126-010000-aaaa", status: "stopped", endReason: "host-ended", request: "x", plan: planOf() }));
		// A pointer recorded for another worktree of this session.
		const elsewhere = runRecord({ runId: "run-20261126-020000-bbbb", status: "stopped", endReason: "host-ended", request: "y", plan: planOf() });
		await writeRun(state.sessionDir, elsewhere);
		await noteResumePointer(state.sessionDir, { repoId: state.repo.repoId, root: path.join(project.tmp, "another-tree") }, elsewhere);
		const { omp, main } = await opened();
		expect((await omp.toolReply({ action: "continue" }, main)).outcome).toBe("rejected");
		expect(await startedRuns()).toEqual([]);
		await omp.emit("session_shutdown", {}, main);
	});

	test("while omp's plan mode is on, it starts nothing", async () => {
		await approve(TEAM);
		await enableAuto();
		await cutOff();
		const { omp, main } = await opened();
		const planning = { ...main, sessionModes: { getState: () => ({ plan: { status: "active" }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } }) } } as unknown as ExtensionContext;
		const reply = await omp.toolReply({ action: "continue" }, planning);
		expect(reply.outcome).toBe("rejected");
		expect(await startedRuns()).toEqual([]);
		await omp.emit("session_shutdown", {}, main);
	});

	test("a plan the approved team no longer allows starts nothing", async () => {
		await approve(TEAM);
		await enableAuto();
		const run = await cutOff();
		// The approved team loses its explorer role (a valid team without it): the old plan's lane names a role that no plan
		// could use today, so it is outside the bounds a submitted plan is held to.
		await approve({ ...TEAM, roles: Object.fromEntries(Object.entries(TEAM.roles).filter(([id]) => id !== "explorer")) } as StormConfig);
		await enableAuto();
		const { omp, main } = await opened();
		const reply = await omp.toolReply({ action: "continue" }, main);
		expect(reply.outcome).toBe("rejected");
		expect(reply.text).toContain("/storm");
		expect(await startedRuns()).toEqual([]);
		// The interrupted run is still the candidate for the user's own menu.
		expect((await readRun(project.sessionDir, run.runId))?.status).toBe("stopped");
		await omp.emit("session_shutdown", {}, main);
	});
});

describe("phase 1: what the slices changed, proven through the hooks", () => {
	afterEach(() => AgentRegistry.resetGlobalForTests());

	/** Opens a manual run with this plan and returns its id. */
	const openRun = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, plan: object): Promise<string> => {
		await omp.command("manual task", main);
		expect(await omp.tool({ action: "plan", plan }, main)).toBe("ok");
		return activeLedgerRun(project.sessionDir)?.runId as string;
	};
	/** One director `task` call for a planned lane, its spawn and the worker's first turn: the worker's context. */
	const startWorker = async (omp: ReturnType<typeof fakeOmp>, child: ReturnType<typeof fakeOmp>, main: ExtensionContext, name: string, agent = "storm-implementer"): Promise<ExtensionContext> => {
		const placed = await omp.emit("tool_call", { toolName: "task", input: { agent, name, task: `work ${name}` } }, main);
		expect(verdict(placed)).toBe("pass");
		const handle = placedName(placed, name);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf(agent, handle), main))).toMatch(/^route:/);
		const worker = child.ctx(sub(handle, agent));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		return worker;
	};
	const register = (id: string, parentId: string, at: number): void => {
		AgentRegistry.global().register({ id, displayName: "x", kind: "sub", parentId, session: null, status: "running", createdAt: at, lastActivity: at });
	};
	const withSessionFile = (ctx: ExtensionContext, file: string | undefined): ExtensionContext =>
		({ ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => file } }) as unknown as ExtensionContext;
	const writerLane = (name: string, file: string) => ({ name, kind: "code" as const, role: "implementer", files: [file], goal: `Write ${file}`, results: changeFor(`${name}-change`) });
	const settingsWith = <T>(values: Record<string, number>, run: () => Promise<T>): Promise<T> => withActiveSettings(Settings.isolated(values), run);

	test("a worker a peer woke after its answer was accepted: the new delivery is a recorded fact, told to the director once, and no row moves", async () => {
		await approve(TEAM);
		await writeFile(path.join(project.root, "notes.md"), "total: 42\n");
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, {
			lanes: [{ name: "look", kind: "explore", files: ["notes.md"], results: [{ id: "total", kind: "answer", criterion: "what the note holds", path: "notes.md", contains: "42" }] }],
			workers: { explorer: 1 },
		});
		const placedLook = await omp.emit("tool_call", { toolName: "task", toolCallId: "c1", input: { agent: "storm-explorer", name: "look", task: "Read notes.md" } }, main);
		expect(verdict(placedLook)).toBe("pass");
		const look = placedName(placedLook, "look");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", look), main))).toMatch(/^route:/);
		await omp.emit("message_end", {
			message: {
				customType: "async-result",
				content: "The total is 42 (notes.md:1)",
				details: { jobs: [{ jobId: "job_1", agentId: "look", status: "completed", schema: { status: "valid", data: { citations: [{ path: "notes.md", line: 1, quote: "total: 42" }] } } }] },
			},
		}, main);
		await until(async () => (await readRun(project.sessionDir, runId))?.results?.some(row => row.id === "total" && row.state === "accepted") === true);

		// A peer messages the worker: omp starts a new turn for it and its answer is delivered to the director again.
		const later = Date.now() + 5_000;
		const woken = { ...main, getAsyncJobSnapshot: () => ({ running: [], recent: [{ id: "job_2", agentId: "look", status: "completed", startTime: later }] }) } as unknown as ExtensionContext;
		const delivery = { role: "user", customType: "async-result", timestamp: later, content: "One more detail (notes.md:1)", details: { jobs: [{ jobId: "job_2", agentId: "look", status: "completed" }] } };
		const request = (await omp.emit("context", { messages: [delivery] }, woken)) as { messages: Array<{ role: string; content: Array<{ text: string }> }> } | undefined;
		const told = request?.messages.at(-1);
		expect(told?.role).toBe("developer");
		expect(told?.content[0]?.text).toContain(look);
		// Told once: the next request carries nothing.
		expect(await omp.emit("context", { messages: [delivery] }, woken)).toBeUndefined();
		await until(async () => ((await readRun(project.sessionDir, runId))?.unplanned?.length ?? 0) === 1);
		const record = await readRun(project.sessionDir, runId);
		expect(record?.unplanned?.[0]).toMatchObject({ kind: "woken", agent: look, lane: "look" });
		// The first settlement stands: the answer row is the one the lane's own dispatch got.
		expect(record?.results?.find(row => row.id === "total")).toMatchObject({ state: "accepted", attemptId: `job:job_1:${look}` });
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);

	// R-final N9: only a message that started a turn makes the delivery of that turn one Storm asked for.
	// The wiring is what is under test here (the allowance itself is in tests/unplanned-deliveries.test.ts): the extension tells the
	// controller about a work message only when it started a turn.
	const cases = [
		{ name: "its receipt says injected", receipt: "injected", idle: false, counted: false },
		{ name: "its receipt says woken", receipt: "woken", idle: false, counted: true },
		{ name: "its receipt says revived", receipt: "revived", idle: true, counted: true },
		{ name: "it has no readable receipt and the worker was idle", receipt: undefined, idle: true, counted: true },
		{ name: "it has no readable receipt and the worker was running", receipt: undefined, idle: false, counted: false },
	] as const;
	for (const { name, receipt, idle, counted } of cases) {
		test(`a work message to a lane worker ${counted ? "makes" : "does not make"} the next delivery one Storm asked for when ${name}`, async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "review", role: "reviewer", goal: "Review the current tree" }], workers: { reviewer: 1 } });
			const placed = await omp.emit("tool_call", { toolName: "task", toolCallId: "c1", input: { agent: "storm-reviewer", name: "look", task: "Review the tree" } }, main);
			expect(verdict(placed)).toBe("pass");
			const handle = placedName(placed, "look");
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-reviewer", handle), main))).toMatch(/^route:/);
			const worker = child.ctx(sub(handle, "storm-reviewer"));
			await child.emit("before_agent_start", { systemPrompt: [] }, worker);
			if (idle) await child.emit("agent_end", {}, worker);
			const woke = spyOn(RunController.prototype, "noteWakingFollowUp");
			try {
				// The director sends it a work message; omp answers with the receipt.
				const message = { toolName: "write", toolCallId: "m-1", input: { path: "agent://look", content: "now look at the tests" } };
				expect(verdict(await omp.emit("tool_call", message, main))).toBe("pass");
				const details = receipt === undefined ? undefined : { message: { op: "send", receipts: [{ to: "look", outcome: receipt }] } };
				await omp.emit("tool_result", { ...message, isError: false, content: [], details }, main);
				// An idle recipient's expectation is recorded when the message is sent (provisional); a running one's
				// only when its receipt says a turn started. The worker is named by its handle, never its lane.
				const expected: Array<[string, string, boolean?]> = counted ? [idle ? [runId, handle, true] : [runId, handle]] : [];
				expect(woke.mock.calls).toEqual(expected);
			} finally {
				woke.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		}, 15_000);
	}

	test("the spend of a worker's own child counts toward the run and its budget; an agent no chain of parents reaches counts nothing", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 1, onExceed: "block-spawns" } });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
		const worker = await startWorker(omp, child, main, "A");
		const created = Date.now() + 1_000;
		register(worker.agent.id, "Main", created);
		register("GA", worker.agent.id, created + 1);
		register("Stray", "Elsewhere", created + 2);
		await child.emit("message_end", assistant("a", "i", 1_000, 0.6), worker);
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.6);
		// A child of the worker was never bound by a spawn hook; the host registry names its chain. It counted nothing before.
		await child.emit("message_end", assistant("a", "i", 1_000, 0.5), child.ctx({ kind: "sub", id: "GA", name: "task", parentId: worker.agent.id }));
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(1.1);
		// An agent whose chain ends outside the run is not this run's spend, whatever tree it shares.
		await child.emit("message_end", assistant("a", "i", 1_000, 5), child.ctx({ kind: "sub", id: "Stray", name: "task", parentId: "Elsewhere" }));
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(1.1);
		// The limit holds at the number the user set: the next spawn is refused for the budget.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "B"), main))).toBe("budget");
		await omp.emit("session_shutdown", {}, main);
	});

	test("an eval cell's model helper calls are read back into the run's spend; with no readable session file the total says it is a floor", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		admitChild(runId, "E1");
		admitChild(runId, "E2");
		const file = path.join(project.tmp, "e1-session.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "model_usage", purpose: "completion", timestamp: new Date(Date.now() + 1_000).toISOString(), usage: { cost: { total: 0.2 } } })}\n`);
		const cell = { toolName: "eval", input: { code: "r = await completion('hi')" }, isError: false, content: [] };
		await child.emit("tool_result", cell, withSessionFile(child.ctx(sub("E1")), file));
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.2);
		await until(async () => (await readRun(project.sessionDir, runId))?.spend?.evalUsd === 0.2);
		expect((await readRun(project.sessionDir, runId))?.spend).toEqual({ evalUsd: 0.2 });
		// A cell that used the helpers in a session whose file cannot be read: the figure is unknown, so the total is a floor.
		await child.emit("tool_result", cell, withSessionFile(child.ctx(sub("E2")), undefined));
		await until(async () => (await readRun(project.sessionDir, runId))?.spend?.lowerBound === true);
		expect((await readRun(project.sessionDir, runId))?.spend).toMatchObject({ lowerBound: true, evalUnread: 1, evalUsd: 0.2 });
		// An eval cell that never asks a model adds nothing and marks nothing.
		await child.emit("tool_result", { ...cell, input: { code: "1 + 1" } }, withSessionFile(child.ctx(sub("E1")), file));
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.2);
		await omp.emit("session_shutdown", {}, main);
	});

	test("storm status returns the plan in force with each result's state, and the state follows an accepted result", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, {
			lanes: [{ name: "fix", kind: "code", role: "implementer", files: ["report.json"], goal: "Write the report", results: [{ id: "report", kind: "change", criterion: "report.json holds the total", path: "report.json", contains: '"total": 42' }] }],
			workers: { implementer: 1 },
		});
		const before = await omp.toolReply({ action: "status" }, main);
		expect(before.text).toContain("fix");
		expect(before.text).toContain("Write the report");
		expect(before.text).toContain("report.json holds the total");
		expect(before.text).not.toContain("수용");
		await startWorker(omp, child, main, "fix");
		await writeFile(path.join(project.root, "report.json"), '{\n  "total": 42\n}\n');
		await omp.emit("tool_result", {
			toolName: "task",
			toolCallId: "t1",
			isError: false,
			input: { agent: "storm-implementer", name: "fix", task: "work fix" },
			content: [{ type: "text", text: "wrote report.json" }],
			details: { results: [{ id: "fix", exitCode: 0, output: "wrote report.json", structuredOutput: { status: "valid" } }] },
		}, main);
		await until(async () => (await readRun(project.sessionDir, runId))?.results?.some(row => row.id === "report" && row.state === "accepted") === true);
		const after = await omp.toolReply({ action: "status" }, main);
		expect(after.text).toContain("report.json holds the total");
		expect(after.text).toContain("수용");
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);

	test("a write to a worker whose records Storm cleaned is let through; when omp fails it the result says why and where the answer is", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("fix", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "fix");
		await child.emit("agent_end", {}, worker);
		markAgentsCleaned([worker.agent.id], Date.now(), project.sessionDir);
		const call = { toolName: "write", toolCallId: "w1", input: { path: `agent://${worker.agent.id}`, content: "go on" } };
		expect(verdict(await omp.emit("tool_call", call, main))).toBe("pass");
		// omp fails the delivery on its own; Storm adds the cause and the way on to that result.
		const failed = (await omp.emit("tool_result", { ...call, isError: true, content: [{ type: "text", text: "Failed: fix is not running." }] }, main)) as { additionalContext?: string } | undefined;
		expect(failed?.additionalContext).toContain(`agent://${worker.agent.id}`);
		// A delivered write adds nothing.
		expect(await omp.emit("tool_result", { ...call, toolCallId: "w2", isError: false, content: [] }, main)).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("an isolation setting that is off refuses a task with the isolation code, under automatic delegation too", async () => {
		await approve(TEAM);
		await enableAuto();
		installOmpSettings({ "task.isolation.enabled": false, "task.isolation.apply": false });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "try it", systemPrompt: [] }, main);
		const lane = { name: "probe", kind: "run", role: "implementer", isolationReason: "independent experiment", files: ["a.txt"], results: changeFor("probe-change") };
		expect((await omp.toolReply({ action: "plan", plan: { lanes: [lane], workers: { implementer: 1 } } }, main)).outcome).toBe("ok");
		const answer = await omp.emit("tool_call", { toolName: "task", toolCallId: "iso", input: { agent: "storm-implementer", name: "probe", task: "x" } }, main);
		expect(verdict(answer)).toBe("isolation");
		await omp.emit("session_shutdown", {}, main);
	});

	test("an automatic director's lsp and read of this session's own transcripts pass without a write lease; another agent's transcript and the bare index are refused", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "look at the code", systemPrompt: [] }, main);
		const plan = { lanes: [{ name: "look", kind: "explore", role: "explorer", results: answerFor("look-answer") }], workers: { explorer: 1 } };
		expect((await omp.toolReply({ action: "plan", plan }, main)).outcome).toBe("ok");
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		admitChild(runId, "Impl");
		await child.emit("before_agent_start", { systemPrompt: [] }, child.ctx(sub("Impl")));
		const claim = spyOn(RunController.prototype, "ensureWrite");
		try {
			// A language-server question cannot write: no write lease is asked for.
			expect(verdict(await omp.emit("tool_call", { toolName: "lsp", input: { action: "hover", file: "src/a.ts", line: 1, column: 1 } }, main))).toBe("pass");
			expect(claim).not.toHaveBeenCalled();
		} finally {
			claim.mockRestore();
		}
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "history://Impl" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "history://Other" } }, main))).toBe("auto");
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "history://" } }, main))).toBe("auto");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a broadcast meets only omp's own ceiling, and never wakes a worker whose write authority is not proven ended", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt"), writerLane("C", "c.txt")], workers: { implementer: 3 } });
		const handles = new Map<string, string>();
		for (const name of ["A", "B", "C"]) {
			const worker = await startWorker(omp, child, main, name);
			handles.set(name, worker.agent.id);
			await child.emit("agent_end", {}, worker);
		}
		const all = { toolName: "write", input: { path: "agent://all", content: "resume" } };
		// Three idle workers would run at once: over a ceiling of one, within a ceiling of three or none.
		expect(verdict(await settingsWith({ "task.maxConcurrency": 1 }, () => omp.emit("tool_call", all, main)))).toBe("lane-capacity");
		expect(verdict(await settingsWith({ "task.maxConcurrency": 3 }, () => omp.emit("tool_call", all, main)))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", all, main))).toBe("pass");
		const registry = AgentRegistry.global();
		const earlier = registry.register({ id: "earlier-run-worker", displayName: "earlier-run-worker", kind: "sub", parentId: main.agent.id, session: null, status: "idle", createdAt: Date.now(), lastActivity: Date.now() });
		try {
			const visible = spyOn(registry, "listVisibleTo").mockReturnValue([earlier]);
			try {
				expect(verdict(await omp.emit("tool_call", all, main))).toBe("lane");
			} finally {
				visible.mockRestore();
			}
		} finally {
			registry.unregister(earlier.id, earlier);
		}
		// A worker whose persisted authority is still live and able to write is not woken without a write order: the
		// broadcast is refused and names it. (Its authority ended with its turn; this is what a failed close would leave.)
		await persistWorkerAdmission({
			agentDir: project.agentDir,
			artifactRoot: project.root,
			parentId: "Main",
			childId: handles.get("B")!,
			runId,
			sessionId: project.sessionId,
			sessionDir: project.sessionDir,
			repoId: "dir-project-test",
			targetRoot: project.root,
			lane: "B",
			policy: { kind: "unknown", reason: "임의 실행 도구가 있음" },
		});
		expect(verdict(await omp.emit("tool_call", all, main))).toBe("lane-write");
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);

	test("a quiet progress note wakes a worker that can only read and report; it never gives its write authority back, and an unproven wake keeps the write gates", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A0", "a.txt"), writerLane("B0", "b.txt")], workers: { implementer: 2 } });
		// B0 writes once and settles: its authority ends with the turn. A0 is the writer now running.
		const idle = await startWorker(omp, child, main, "B0");
		await child.emit("agent_end", {}, idle);
		const running = await startWorker(omp, child, main, "A0");
		const admission = () => readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: main.agent.id, childId: running.agent.id });
		const before = await admission();
		expect(before).toMatchObject({ kind: "record", record: { hold: expect.any(String) } });
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://A0?progress", content: "status" } }, main))).toBe("pass");
		expect(await admission()).toEqual(before);
		const note = { toolName: "write", input: { path: "agent://B0?progress", content: "status please" } };
		const work = { toolName: "write", input: { path: "agent://B0", content: "write more" } };
		// A work message would run a second writer beside A0: refused. The note starts a turn that cannot write: let through.
		expect(verdict(await omp.emit("tool_call", work, main))).toBe("lane-write");
		expect(verdict(await omp.emit("tool_call", note, main))).toBe("pass");
		// The woken turn reads and reports; its ended admission is not re-opened by the note, so a command or a write is refused.
		await child.emit("agent_start", {}, idle);
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, idle))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "touch x" } }, idle))).toBe("authority");
		expect(verdict(await child.emit("tool_call", { toolName: "write", input: { path: "b.txt", content: "x" } }, idle))).toBe("authority");
		await child.emit("agent_end", {}, idle);
		// An idle worker whose authority is still live and able to write is not proven read-only: its note meets the gates a
		// work message does (what a failed close of its admission would leave).
		await persistWorkerAdmission({
			agentDir: project.agentDir,
			artifactRoot: project.root,
			parentId: "Main",
			childId: idle.agent.id,
			runId,
			sessionId: project.sessionId,
			sessionDir: project.sessionDir,
			repoId: "dir-project-test",
			targetRoot: project.root,
			lane: "B0",
			policy: { kind: "unknown", reason: "임의 실행 도구가 있음" },
		});
		expect(verdict(await omp.emit("tool_call", note, main))).toBe("lane-write");
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);

	test("a reviewer with a shell is ordered like a writer in both directions, an explorer runs beside it, and an old admission record gives no shell", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, {
			lanes: [
				writerLane("W0", "a.txt"),
				{ name: "R0", kind: "review", role: "reviewer", goal: "Review the tree" },
				writerLane("X0", "b.txt"),
				{ name: "E0", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("e0-answer") },
			],
			workers: { implementer: 2, reviewer: 1, explorer: 1 },
		});
		const writer = await startWorker(omp, child, main, "W0");
		const task = (name: string, agent: string) => omp.emit("tool_call", { toolName: "task", input: { agent, name, task: `work ${name}` } }, main);
		// A live writer holds the reviewer back: its shell could change what the writer is changing.
		expect(verdict(await task("R0", "storm-reviewer"))).toBe("lane-write");
		await child.emit("agent_end", {}, writer);
		const reviewer = await startWorker(omp, child, main, "R0", "storm-reviewer");
		// The reviewer reads and runs commands only. A writer is held back while it runs; an explorer is not.
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "bun test" } }, reviewer))).toBe("pass");
		expect(verdict(await task("X0", "storm-implementer"))).toBe("lane-write");
		expect(verdict(await task("E0", "storm-explorer"))).toBe("pass");
		// A record written before the shell existed has no `shell`: it reads as a plain reader and the command is refused.
		await persistWorkerAdmission({
			agentDir: project.agentDir,
			artifactRoot: project.root,
			parentId: "Main",
			childId: "OldRev",
			runId,
			sessionId: project.sessionId,
			sessionDir: project.sessionDir,
			repoId: "dir-project-test",
			targetRoot: project.root,
			lane: "R0",
			policy: { kind: "read", reason: "test read lane" },
		});
		const old = child.ctx(sub("OldRev", "storm-reviewer"));
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "bun test" } }, old))).toBe("lane-capability");
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);

	test("a plan with a review lane takes the write claim before its worker starts, because the reviewer may run commands", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [{ name: "R0", kind: "review", role: "reviewer", goal: "Review the tree" }], workers: { reviewer: 1 } });
		const claim = spyOn(RunController.prototype, "ensureWrite");
		try {
			expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-reviewer", name: "R0", task: "Review" } }, main))).toBe("pass");
			expect(claim).toHaveBeenCalled();
		} finally {
			claim.mockRestore();
		}
		await omp.emit("session_shutdown", {}, main);
	});

	test("when the worker that held the write order ends, the director reads one line naming the writing lanes the gate would now start, once, and nothing is started", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, {
			lanes: [
				writerLane("W0", "a.txt"),
				writerLane("X0", "b.txt"),
				writerLane("X1", "c.txt"),
				{ name: "Y0", kind: "code", role: "implementer", files: ["d.txt"], goal: "Needs W0", results: changeFor("y0-change"), dependsOn: [{ lane: "W0", need: "result" }] },
				{ name: "E0", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("e0-answer") },
			],
			workers: { implementer: 3, explorer: 1 },
		});
		const writer = await startWorker(omp, child, main, "W0");
		const sentBefore = omp.sent.length;
		const notice = async (): Promise<string | undefined> => {
			const answer = (await omp.emit("context", { messages: [] }, main)) as { messages: Array<{ role: string; content: Array<{ text: string }> }> } | undefined;
			return answer?.messages.at(-1)?.content[0]?.text;
		};
		// While the writer runs there is nothing to say: the order is not free.
		expect(await notice()).toBeUndefined();
		await child.emit("agent_end", {}, writer);
		const told = await notice();
		expect(told).toContain(WRITER_FREED_LEAD);
		// X0 can start. X1 would be refused beside X0 (both are shell writers); Y0 waits for W0's result; E0 does not write.
		const line = told?.split("\n").find(row => row.includes(WRITER_FREED_LEAD)) ?? "";
		expect(line).toContain("X0");
		for (const other of ["X1", "Y0", "E0", "W0"]) expect(line).not.toContain(other);
		// The line is true: the gate lets X0 start, and nothing was started to say it.
		expect(runSpawns(runId).map(spawn => spawn.spawnKey)).toEqual([writer.agent.id]);
		expect(omp.sent).toHaveLength(sentBefore);
		// Once: the same freed place is not announced again.
		expect(await notice()).toBeUndefined();
		expect(verdict(await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-implementer", name: "X0", task: "work X0" } }, main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	}, 15_000);
});

/**
 * The hardening wiring: each fix the slices made inside their own modules holds through the hooks. A test here fails on the
 * extension as it was before the wiring (the hook that should act was not there, or did not pass what the module needs).
 */
describe("hardening through the hooks: write order (G1)", () => {
	const openRun = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, plan: object): Promise<string> => {
		await omp.command("manual task", main);
		expect(await omp.tool({ action: "plan", plan }, main)).toBe("ok");
		return activeLedgerRun(project.sessionDir)?.runId as string;
	};
	const writerLane = (name: string, file: string) => ({ name, kind: "code" as const, role: "implementer", files: [file], goal: `Write ${file}`, results: changeFor(`${name}-change`) });
	const taskCall = (name: string, callId: string, agent = "storm-implementer") => ({ toolName: "task", toolCallId: callId, input: { agent, name, task: `work ${name}` } });
	/** One director `task` call for a planned lane, its spawn and the worker's first turn: the worker's context. */
	const startWorker = async (omp: ReturnType<typeof fakeOmp>, child: ReturnType<typeof fakeOmp>, main: ExtensionContext, name: string, callId?: string, agent = "storm-implementer"): Promise<ExtensionContext> => {
		const call = taskCall(name, callId ?? `call-${name}`, agent);
		const placed = await omp.emit("tool_call", callId === undefined ? { toolName: "task", input: call.input } : call, main);
		expect(verdict(placed)).toBe("pass");
		const handle = placedName(placed, name);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf(agent, handle), main))).toMatch(/^route:/);
		const worker = child.ctx(sub(handle, agent));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		return worker;
	};
	const bash = (callId: string, input: Record<string, unknown> = { command: "git status" }) => ({ toolName: "bash", toolCallId: callId, input });
	const ended = (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, toolName: string, callId: string) =>
		omp.emit("tool_execution_end", { toolName, toolCallId: callId, isError: false }, main);
	/** The reason a refused `task` call carries: it reaches the director as that call's own result. */
	const reasonOf = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, call: { toolName: string; toolCallId: string; input: unknown }): Promise<string> => {
		const result = (await omp.emit("tool_result", { ...call, isError: true, content: [] }, main)) as { content?: Array<{ text?: string }> } | undefined;
		return result?.content?.[0]?.text ?? "";
	};

	test("a worker's settled turn, told by the child's own session, ends its reservation and revokes its persisted authority", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
		const worker = await startWorker(omp, child, main, "A");
		const read = async () =>
			readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
		const before = await read();
		expect(before.kind === "record" && before.record.revokedAt === undefined && before.record.endedAt === undefined).toBe(true);
		// B would write beside A (both run shell commands): refused while A holds the order.
		expect(verdict(await omp.emit("tool_call", taskCall("B", "b-1"), main))).toBe("lane-write");
		const ends: ReservationEnd[] = [];
		const off = onLaneReservationEnd(end => ends.push(end));
		try {
			// The end is told by the run's lane table at once, from the child's own settled turn: no list was read to learn it.
			await child.emit("agent_end", {}, worker);
			expect(ends.filter(end => end.runId === runId).map(end => [end.agentId, end.reason])).toEqual([[worker.agent.id, "settled"]]);
		} finally {
			off();
		}
		expect(verdict(await omp.emit("tool_call", taskCall("B", "b-2"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("an end the lane table reports revokes the child's persisted write authority: no authority stays open behind a freed place", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		const read = async () => readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
		const open = await read();
		expect(open.kind === "record" && open.record.revokedAt === undefined).toBe(true);
		// The end is noticed where the child cannot revoke for itself (another thread: only the director side sees it).
		noteLaneAgentEnd(runId, worker.agent.id);
		await until(async () => {
			const now = await read();
			return now.kind === "record" && now.record.revokedAt !== undefined;
		});
		await omp.emit("session_shutdown", {}, main);
	});

	test("a writer whose placement lapsed while the host waited for a permit is reserved again at its admission, so a second writer is refused", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, {
			lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt"), { name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }],
			workers: { implementer: 2, explorer: 1 },
		});
		const t0 = Date.now();
		try {
			setSystemTime(new Date(t0));
			expect(verdict(await omp.emit("tool_call", taskCall("A", "a-1"), main))).toBe("pass");
			// omp waited for a permit longer than the pending window; only then did it allocate the spawn.
			setSystemTime(new Date(t0 + 31_000));
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "A"), main))).toMatch(/^route:/);
			// A batch never waits for the writer to settle, so the refusal is immediate.
			const second = { toolName: "task", toolCallId: "b-1", input: { tasks: [{ agent: "storm-implementer", name: "B", task: "b" }, { agent: "storm-explorer", name: "look", task: "r" }] } };
			expect(verdict(await omp.emit("tool_call", second, main))).toBe("lane-write");
		} finally {
			setSystemTime();
		}
		await omp.emit("session_shutdown", {}, main);
	});

	test("a run with no plan places a writer under a generated handle; only its live hold lets it write", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		const placed = (await omp.emit("tool_call", taskCall("PA", "pa-1"), main)) as { input: Record<string, unknown> };
		const handle = String(placed.input.name);
		expect(handle).not.toBe("PA");
		// The caller's name is nobody's spawn key: R4 refuses it instead of guessing the placement it might mean.
		expect(verdict(await omp.emit("before_subagent_spawn", { agent: "storm-implementer", invocationKind: "task", patterns: [], spawnKey: "PA" }, main))).toBe("internal");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", handle), main))).toMatch(/^route:/);
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		const record = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: handle });
		expect(record.kind).toBe("record");
		if (record.kind === "record") expect(record.record.hold).toBe(`spawn:${handle}`);
		const worker = child.ctx(sub(handle));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		expect(verdict(await child.emit("tool_call", { toolName: "write", toolCallId: "w-1", input: { path: "pa.txt", content: "x" } }, worker))).toBe("pass");
		// The place ends: the admission is revoked, and the same write no longer has a reservation behind it.
		await revokeWorkerAdmissions(project.agentDir, { runId, childId: handle });
		expect(verdict(await child.emit("tool_call", { toolName: "write", toolCallId: "w-2", input: { path: "pa.txt", content: "x" } }, worker))).toBe("authority");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a team set to isolated needs omp's merge of an isolated worker's changes off: with it on the call is refused with the setting that fixes it", async () => {
		await approve({ ...TEAM, isolation: "isolated" });
		installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": true });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [{ name: "api", kind: "code", results: changeFor("api-change") }], workers: { implementer: 1 } });
		const call = taskCall("api", "api-1");
		expect(verdict(await omp.emit("tool_call", call, main))).toBe("isolation");
		expect(await reasonOf(omp, main, call)).toContain("omp config set task.isolation.apply false");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the director's shell is refused while a worker that cannot be bounded runs, and passes once it settled", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		const refused = (await omp.emit("tool_call", bash("d-1"), main)) as { reason: string };
		expect(verdict(refused)).toBe("director-exec");
		expect(refused.reason).toContain("'A' 레인");
		await child.emit("agent_end", {}, worker);
		expect(verdict(await omp.emit("tool_call", bash("d-2"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("no writer starts while a director command runs; both orders in one message, and the end of the call frees the place", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
		// [bash, task A]: the command takes the tree first, so the writer is refused and starts nothing.
		expect(verdict(await omp.emit("tool_call", bash("d-1"), main))).toBe("pass");
		const waiting = taskCall("A", "a-1");
		expect(verdict(await omp.emit("tool_call", waiting, main))).toBe("lane-write");
		expect(await reasonOf(omp, main, waiting)).toContain("감독이 실행 중인 명령");
		await ended(omp, main, "bash", "d-1");
		// [task B, bash]: the writer takes the tree first, so the command is refused.
		expect(verdict(await omp.emit("tool_call", taskCall("B", "b-1"), main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", bash("d-2"), main))).toBe("director-exec");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a command omp sent to the background keeps holding the tree after its call ended, until the host's job rows no longer show it", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		expect(verdict(await omp.emit("tool_call", bash("d-1", { command: "npm run build", async: true }), main))).toBe("pass");
		// omp returned at once and the command runs on: the call ended, the job did not.
		omp.jobs.running.push({ id: "job_1", type: "bash", status: "running" });
		await ended(omp, main, "bash", "d-1");
		const refused = taskCall("A", "a-1");
		expect(verdict(await omp.emit("tool_call", refused, main))).toBe("lane-write");
		expect(await reasonOf(omp, main, refused)).toContain("감독이 백그라운드로 돌린 명령");
		// The director's own next command is the same actor: it is not refused by its own background job.
		expect(verdict(await omp.emit("tool_call", bash("d-2"), main))).toBe("pass");
		await ended(omp, main, "bash", "d-2");
		omp.jobs.running.length = 0;
		expect(verdict(await omp.emit("tool_call", taskCall("A", "a-2"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a command that was already running in the background when the run began holds the tree too; a subagent's task job does not", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		omp.jobs.running.push({ id: "job_0", type: "bash", status: "running" }, { id: "job_t", type: "task", status: "running", agentId: "Elsewhere" });
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		expect(verdict(await omp.emit("tool_call", taskCall("A", "a-1"), main))).toBe("lane-write");
		omp.jobs.running.splice(0, 1);
		expect(verdict(await omp.emit("tool_call", taskCall("A", "a-2"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the director's other calls that can write without naming a path meet the same order; reads and the lsp queries do not", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		await startWorker(omp, child, main, "A");
		const rename = { toolName: "lsp", toolCallId: "l-1", input: { action: "rename", file: "src/a.ts", line: 1, column: 1, new_name: "b" } };
		const hover = { toolName: "lsp", toolCallId: "l-2", input: { action: "hover", file: "src/a.ts", line: 1, column: 1 } };
		const mcp = { toolName: "mcp__server__write_note", toolCallId: "m-1", input: {} };
		const checkpoint = { toolName: "checkpoint", toolCallId: "k-1", input: {} };
		expect(verdict(await omp.emit("tool_call", rename, main))).toBe("director-exec");
		expect(verdict(await omp.emit("tool_call", mcp, main))).toBe("director-exec");
		expect(verdict(await omp.emit("tool_call", checkpoint, main))).toBe("director-exec");
		expect(verdict(await omp.emit("tool_call", hover, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "read", toolCallId: "r-1", input: { path: "a.txt" } }, main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the director starts no service during a run: bash with a name is refused, a blank name is no service", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const refused = (await omp.emit("tool_call", bash("s-1", { command: "npm run dev", name: "dev", ready: { port: 3000 } }), main)) as { reason: string };
		expect(verdict(refused)).toBe("director-service");
		expect(refused.reason).toContain("name 없이");
		expect(verdict(await omp.emit("tool_call", bash("s-2", { command: "git status", name: "  " }), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a director whose host shows no background jobs cannot have its shell admitted: it could not be known to have ended", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const blind = { ...main, getAsyncJobSnapshot: undefined } as unknown as ExtensionContext;
		await omp.command("manual task", blind);
		expect(await omp.tool({ action: "plan", plan: { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } } }, blind)).toBe("ok");
		const refused = (await omp.emit("tool_call", bash("b-1"), blind)) as { reason: string };
		expect(verdict(refused)).toBe("director-exec");
		expect(refused.reason).toContain("백그라운드 작업 목록");
		await omp.emit("session_shutdown", {}, main);
	});

	// R-final N5: omp's conflict scheme splices into a tracked file, so it is a file change like any other write path.
	test("the director cannot rewrite a tracked file through conflict:// or vault://, whatever the case; settings, notes and messages stay open", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		await startWorker(omp, child, main, "A");
		const write = (path: string, callId: string) => ({ toolName: "write", toolCallId: callId, input: { path, content: "x" } });
		for (const [at, path] of ["conflict://1", "conflict://*", "Conflict://1", "vault://notes/x.md"].entries()) {
			expect(verdict(await omp.emit("tool_call", write(path, `f-${at}`), main)), path).toBe("director-edit");
		}
		// A project path is a file the table can order: while the lane's worker (a shell writer) runs, it is refused by the table.
		expect(verdict(await omp.emit("tool_call", write("a.txt", "f-a"), main))).toBe("director-write");
		for (const [at, path] of ["local://notes.md", "cfg://settings/task.maxConcurrency"].entries()) {
			expect(verdict(await omp.emit("tool_call", write(path, `o-${at}`), main)), path).not.toBe("director-edit");
		}
		await omp.emit("session_shutdown", {}, main);
	});

	// R-final N8: `bash propose <slug>` is omp's plan submission only while plan mode is on.
	test("the plan-submission shape is let through only while omp's plan mode is on; otherwise it is a shell command in the lane table", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		await startWorker(omp, child, main, "A");
		const modes = (plan: "active" | "inactive") => ({ ...main, sessionModes: { getState: () => ({ plan: { status: plan }, vibe: { status: "inactive" }, goal: { status: "inactive" }, loop: { status: "inactive" } }) } }) as unknown as ExtensionContext;
		expect(verdict(await omp.emit("tool_call", bash("p-0", { command: "git status" }), main))).toBe("director-exec");
		for (const [at, ctx] of [main, modes("inactive")].entries()) {
			expect(verdict(await omp.emit("tool_call", bash(`p-${at + 1}`, { command: "propose my-plan" }), ctx))).toBe("director-exec");
		}
		// A host whose mode state cannot be read does not say it is on.
		const broken = { ...main, sessionModes: { getState: () => { throw new Error("no state"); } } } as unknown as ExtensionContext;
		expect(verdict(await omp.emit("tool_call", bash("p-3", { command: "propose my-plan" }), broken))).toBe("director-exec");
		expect(verdict(await omp.emit("tool_call", bash("p-4", { command: "propose my-plan" }), modes("active")))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the director cannot change a worker's model or effort through its control paths during a run; a message to the worker is not one", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		await startWorker(omp, child, main, "A");
		const write = (path: string, callId: string) => ({ toolName: "write", toolCallId: callId, input: { path, content: "x" } });
		expect(verdict(await omp.emit("tool_call", write("agent://A/model", "w-1"), main))).toBe("director-control");
		expect(verdict(await omp.emit("tool_call", write("agent://A/effort", "w-2"), main))).toBe("director-control");
		expect(verdict(await omp.emit("tool_call", write("agent://a/Model?x=1", "w-3"), main))).toBe("director-control");
		// A progress note is a message, not a control path: it meets the follow-up gates (the worker runs, so it passes).
		expect(verdict(await omp.emit("tool_call", write("agent://A?progress", "w-4"), main))).not.toBe("director-control");
		await omp.emit("session_shutdown", {}, main);
	});

	// R-G234 H2: omp reads the scheme without case and decodes every segment, so these are the same control writes.
	test("the control writes are refused under every spelling omp accepts, and a work message under another spelling meets the follow-up gates", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
		const idle = await startWorker(omp, child, main, "B");
		await child.emit("agent_end", {}, idle);
		await startWorker(omp, child, main, "A");
		const write = (path: string, callId: string) => ({ toolName: "write", toolCallId: callId, input: { path, content: "x" } });
		// R-final N1: omp resolves dot segments (also `%2e`) before it reads the path, so these are control writes as well.
		const dots = ["agent://A/./model", "agent://A/x/../model", "agent://A/%2e/effort", "agent://A/%2E%2e/model", "agent://A/./x/../effort"];
		for (const [at, path] of ["Agent://A/model", "AGENT://A/effort", "agent://A/%6Dodel", "agent://A/%65ffort", "agent://%41/model", "[agent://A/model#ABCD]", "agent:/A/model", ...dots].entries()) {
			expect(verdict(await omp.emit("tool_call", write(path, `w-${at}`), main))).toBe("director-control");
		}
		// A work message to the idle writer B while A runs is ordered, however the address is spelled.
		for (const [at, path] of ["agent://B", "Agent://B", "AGENT://%42"].entries()) {
			expect(verdict(await omp.emit("tool_call", write(path, `m-${at}`), main))).toBe("lane-write");
		}
		await omp.emit("session_shutdown", {}, main);
	});

	test("a worker that settled inside its parent's call keeps its place until that call ends; then, and only then, a second writer is placed", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
		const worker = await startWorker(omp, child, main, "A", "sync-1");
		// omp is still cancelling and reaping what the worker left, inside the director's `task` call.
		await child.emit("agent_end", {}, worker);
		expect(verdict(await omp.emit("tool_call", taskCall("B", "b-1"), main))).toBe("lane-write");
		await omp.emit("tool_result", { ...taskCall("A", "sync-1"), isError: false, content: [], details: { results: [{ id: "A", exitCode: 0 }] } }, main);
		await ended(omp, main, "task", "sync-1");
		expect(verdict(await omp.emit("tool_call", taskCall("B", "b-2"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	// R-final N4: the revoke of the worker a placement displaced is awaited before the placement answers.
	describe("the authority of a displaced worker is withdrawn before the writer that took its place is placed", () => {
		const admissionOf = async (childId: string) => {
			const read = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId });
			return read.kind === "record" ? { revoked: read.record.revokedAt !== undefined } : read.kind;
		};
		const settleA = async (omp: ReturnType<typeof fakeOmp>, child: ReturnType<typeof fakeOmp>, main: ExtensionContext) => {
			const worker = await startWorker(omp, child, main, "A", "sync-1");
			await child.emit("agent_end", {}, worker);
			await omp.emit("tool_result", { ...taskCall("A", "sync-1"), isError: false, content: [], details: { results: [{ id: "A", exitCode: 0 }] } }, main);
			await ended(omp, main, "task", "sync-1");
			return worker;
		};

		test("a slow revoke holds the answer back: the second writer passes only once the first worker's record is revoked", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
			const real = revokeWorkerAdmissions;
			const slow = spyOn(admissionModule, "revokeWorkerAdmissions").mockImplementation(async (...args: Parameters<typeof real>) => {
				await new Promise(resolve => setTimeout(resolve, 150));
				return real(...args);
			});
			try {
				const worker = await settleA(omp, child, main);
				expect(verdict(await omp.emit("tool_call", taskCall("B", "b-1"), main))).toBe("pass");
				expect(await admissionOf(worker.agent.id)).toEqual({ revoked: true });
			} finally {
				slow.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		});

		test("a revoke that fails fails the placement closed; the next call tries again and places the writer once it lands", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
			const failing = spyOn(admissionModule, "revokeWorkerAdmissions").mockRejectedValue(new Error("store unreadable"));
			let workerId = "";
			try {
				const worker = await settleA(omp, child, main);
				workerId = worker.agent.id;
				const call = taskCall("B", "b-1");
				const refused = (await omp.emit("tool_call", call, main)) as { block?: boolean; input?: unknown } | undefined;
				// A refused `task` call runs into omp's own rejection and Storm's reason is its result (task-refusal.ts).
				expect(refused?.block).not.toBe(true);
				expect(await reasonOf(omp, main, call)).toContain("[storm:revoke]");
				// The director's shell is a placement too.
				expect(verdict(await omp.emit("tool_call", bash("sh-1"), main))).toBe("revoke");
				await omp.emit("tool_result", { ...bash("sh-1"), isError: true, content: [] }, main);
				await ended(omp, main, "bash", "sh-1");
			} finally {
				failing.mockRestore();
			}
			expect(verdict(await omp.emit("tool_call", taskCall("B", "b-2"), main))).toBe("pass");
			expect(await admissionOf(workerId)).toEqual({ revoked: true });
			await omp.emit("session_shutdown", {}, main);
		});
	});

	// R-final N4: a note to a worker the agent list shows running cannot be known to join the open turn.
	test("a note sent while the list shows the worker running keeps its place until the receipt says it joined the open turn", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A0", "a.txt"), writerLane("B0", "b.txt")], workers: { implementer: 2 } });
		const b0 = await startWorker(omp, child, main, "B0", "b0-call");
		await child.emit("agent_start", {}, b0);
		await ended(omp, main, "task", "b0-call");
		const note = (callId: string) => ({ toolName: "write", toolCallId: callId, input: { path: "agent://B0?progress", content: "status please" } });
		// The list shows B0 running; the note may have woken a turn the director side has not seen: a second writer is not placed
		// once the list shows B0 settled, and B0's own turn keeps the authority it holds.
		expect(verdict(await omp.emit("tool_call", note("note-1"), main))).toBe("pass");
		await ended(omp, main, "write", "note-1");
		noteAgentEnd({ id: b0.agent.id, scope: project.sessionDir, now: Date.now(), settled: true });
		expect(verdict(await omp.emit("tool_call", taskCall("A0", "a0-1"), main))).toBe("lane-write");
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "touch b.txt" } }, b0))).toBe("pass");
		// The receipt says the note woke a turn: the place is held until that turn's start is seen, and then its end frees it.
		await omp.emit("tool_result", { ...note("note-1"), isError: false, content: [], details: { message: { op: "send", receipts: [{ to: "B0", outcome: "woken" }] } } }, main);
		expect(verdict(await omp.emit("tool_call", taskCall("A0", "a0-2"), main))).toBe("lane-write");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a note whose receipt says it joined the open turn takes no place: the worker's turn ends and frees it as before", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A0", "a.txt"), writerLane("B0", "b.txt")], workers: { implementer: 2 } });
		const b0 = await startWorker(omp, child, main, "B0", "b0-call");
		await child.emit("agent_start", {}, b0);
		await ended(omp, main, "task", "b0-call");
		const note = { toolName: "write", toolCallId: "note-1", input: { path: "agent://B0?progress", content: "status please" } };
		expect(verdict(await omp.emit("tool_call", note, main))).toBe("pass");
		await omp.emit("tool_result", { ...note, isError: false, content: [], details: { message: { op: "send", receipts: [{ to: "B0", outcome: "injected" }] } } }, main);
		await ended(omp, main, "write", "note-1");
		await child.emit("agent_end", {}, b0);
		noteAgentEnd({ id: b0.agent.id, scope: project.sessionDir, now: Date.now(), settled: true });
		expect(verdict(await omp.emit("tool_call", taskCall("A0", "a0-1"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("an async worker keeps its place while the host's task job for it runs, though its call returned long before", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
		const worker = await startWorker(omp, child, main, "A", "async-1");
		omp.jobs.running.push({ id: "job_a", type: "task", status: "running", agentId: worker.agent.id });
		// The task call returned its acknowledgment at once; the job is what still runs, reaping after the worker's last turn.
		await ended(omp, main, "task", "async-1");
		await child.emit("agent_end", {}, worker);
		expect(verdict(await omp.emit("tool_call", taskCall("B", "b-1"), main))).toBe("lane-write");
		omp.jobs.running.length = 0;
		expect(verdict(await omp.emit("tool_call", taskCall("B", "b-2"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a worker ordered like a writer cannot start a service: bash with a name is refused for an exec lane and a shell reviewer, the foreground command is not", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, {
			lanes: [writerLane("A", "a.txt"), { name: "review", kind: "review", role: "reviewer", goal: "Review the current tree" }],
			workers: { implementer: 1, reviewer: 1 },
		});
		const impl = await startWorker(omp, child, main, "A");
		const service = { toolName: "bash", input: { command: "npm run dev", name: "dev", ready: { port: 3000 } } };
		const refused = (await child.emit("tool_call", service, impl)) as { reason: string };
		expect(verdict(refused)).toBe("lane-service");
		expect(refused.reason).toContain("name 없이");
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "npm run dev" } }, impl))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "ls", name: "" } }, impl))).toBe("pass");
		// The reviewer with a shell is ordered like a writer too. Its own spawn waits for A (both shell writers), so A settles first.
		await child.emit("agent_end", {}, impl);
		const reviewer = await startWorker(omp, child, main, "review", undefined, "storm-reviewer");
		expect(verdict(await child.emit("tool_call", service, reviewer))).toBe("lane-service");
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "bun test" } }, reviewer))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	// R-G1 finding 1: a worker on another thread whose last turn only read never claimed its admission, so its record stays live
	// and able to write. A quiet note to it is then not proven read-only; the woken turn may write and must hold a place.
	test("a progress note that is not proven read-only holds the woken writer's place: the second writer is refused, in both orders", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A0", "a.txt"), writerLane("B0", "b.txt")], workers: { implementer: 2 } });
		const b0 = await startWorker(omp, child, main, "B0");
		await child.emit("agent_start", {}, b0);
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, b0))).toBe("pass");
		// The turn settled on another thread: only the registry mirror says so, and the record was never closed (no claim was made).
		noteAgentEnd({ id: b0.agent.id, scope: project.sessionDir, now: Date.now(), settled: true });
		const note = { toolName: "write", toolCallId: "note-1", input: { path: "agent://B0?progress", content: "status please" } };
		// Note first: it passes (nothing else holds the tree) and takes B0's place, so A0 is refused while B0's turn may write.
		expect(verdict(await omp.emit("tool_call", note, main))).toBe("pass");
		await omp.emit("tool_execution_end", { toolName: "write", toolCallId: "note-1", isError: false }, main);
		expect(verdict(await omp.emit("tool_call", taskCall("A0", "a0-1"), main))).toBe("lane-write");
		// The woken turn runs under the authority the note's admission gave it.
		await child.emit("agent_start", {}, b0);
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "touch b.txt" } }, b0))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", taskCall("A0", "a0-2"), main))).toBe("lane-write");
		// Once B0's turn settles, its place is free again.
		await child.emit("agent_end", {}, b0);
		expect(verdict(await omp.emit("tool_call", taskCall("A0", "a0-3"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);

	// R-G1 over-eager 1: after /new while the old run still drains, the new conversation's reads are not acting on the run.
	test("after a new conversation starts while the old run drains, a read goes through and a shell is still refused", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		await child.emit("agent_start", {}, worker);
		omp.setSessionId("session-new");
		await omp.emit("session_switch", {}, main);
		expect(verdict(await omp.emit("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "README.md" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "grep", toolCallId: "g1", input: { pattern: "x" } }, main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", { toolName: "bash", toolCallId: "b1", input: { command: "touch a.txt" } }, main))).toBe("session");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "a.txt", content: "x" } }, main))).toBe("session");
		await child.emit("agent_end", {}, worker);
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);

	test("the other order (the second writer is placed first, then the note): the settled worker's authority ended with its place, so the note wakes a turn that cannot write", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A0", "a.txt"), writerLane("B0", "b.txt")], workers: { implementer: 2 } });
		const b0 = await startWorker(omp, child, main, "B0");
		await child.emit("agent_start", {}, b0);
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, b0))).toBe("pass");
		noteAgentEnd({ id: b0.agent.id, scope: project.sessionDir, now: Date.now(), settled: true });
		// Placing A0 reads the agent list: B0's settled turn ends its place, and with it the persisted authority.
		await startWorker(omp, child, main, "A0", "a0-1");
		const note = { toolName: "write", toolCallId: "note-2", input: { path: "agent://B0?progress", content: "status please" } };
		expect(verdict(await omp.emit("tool_call", note, main))).toBe("pass");
		await child.emit("agent_start", {}, b0);
		expect(verdict(await child.emit("tool_call", { toolName: "bash", input: { command: "touch b.txt" } }, b0))).toBe("authority");
		// A work message to B0 is still refused beside A0.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", input: { path: "agent://B0", content: "write more" } }, main))).toBe("lane-write");
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);
});

describe("hardening through the hooks: approved models and cost (G2, G3)", () => {
	const openRun = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, plan: object): Promise<string> => {
		await omp.command("manual task", main);
		expect(await omp.tool({ action: "plan", plan }, main)).toBe("ok");
		return activeLedgerRun(project.sessionDir)?.runId as string;
	};
	const writerLane = (name: string, file: string) => ({ name, kind: "code" as const, role: "implementer", files: [file], goal: `Write ${file}`, results: changeFor(`${name}-change`) });
	const startWorker = async (omp: ReturnType<typeof fakeOmp>, child: ReturnType<typeof fakeOmp>, main: ExtensionContext, name: string, agent = "storm-implementer"): Promise<ExtensionContext> => {
		const placed = await omp.emit("tool_call", { toolName: "task", input: { agent, name, task: `work ${name}` } }, main);
		expect(verdict(placed)).toBe("pass");
		const handle = placedName(placed, name);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf(agent, handle), main))).toMatch(/^route:/);
		const worker = child.ctx(sub(handle, agent));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		return worker;
	};
	/** A child context with the model its next provider request would use, and a counter of how often it was aborted. */
	const asking = (ctx: ExtensionContext, provider: string, id: string): { ctx: ExtensionContext; aborted: () => number } => {
		let aborted = 0;
		return { ctx: { ...ctx, model: { provider, id }, abort: () => void aborted++ } as unknown as ExtensionContext, aborted: () => aborted };
	};

	test("a spawn is answered only with the approved models whose credential resolves, and refused when none does", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "E1"), main))).toBe("route:a/x:low,b/z:low");
		omp.credentials.lost.add("a/x");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "E2"), main))).toBe("route:b/z:low");
		omp.credentials.lost.add("b/z");
		// Without any, omp would run the worker on the parent session's model: Storm refuses instead.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", "E3"), main))).toBe("unapproved");
	});

	test("a worker whose own request runs on a model or effort the team did not approve is stopped, recorded, and told to the director", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		const ranOf = () => runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran;
		// An approved model at the approved effort, and below it, runs on: the record says it was read, once.
		child.thinking.level = "low";
		const fine = asking(worker, "a", "x");
		await child.emit("before_provider_request", { payload: {} }, fine.ctx);
		child.thinking.level = "off";
		await child.emit("before_provider_request", { payload: {} }, fine.ctx);
		expect(fine.aborted()).toBe(0);
		expect(ranOf()).toMatchObject({ model: "a/x", effort: "minimal", verdict: "verified" });
		// A higher effort than approved: stopped.
		child.thinking.level = "xhigh";
		const high = asking(worker, "a", "x");
		await child.emit("before_provider_request", { payload: {} }, high.ctx);
		expect(high.aborted()).toBe(1);
		expect(ranOf()).toMatchObject({ model: "a/x", effort: "xhigh", verdict: "mismatch" });
		const told = (await omp.emit("context", { messages: [] }, main)) as { messages: Array<{ content: Array<{ text: string }> }> } | undefined;
		expect(told?.messages.at(-1)?.content[0]?.text).toContain("storm-explorer 워커를 멈췄습니다");
		// The stopped worker only reports.
		expect(verdict(await child.emit("tool_call", { toolName: "read", input: { path: "a.txt" } }, worker))).toBe("model-mismatch");
		expect(verdict(await child.emit("tool_call", { toolName: "yield", input: {} }, worker))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("the parent session's model on a worker's request (what omp falls back to without credentials) is stopped", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		child.thinking.level = "high";
		const outsider = asking(worker, "fake9", "outsider-z");
		await child.emit("before_provider_request", { payload: {} }, outsider.ctx);
		expect(outsider.aborted()).toBe(1);
		expect(runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran).toMatchObject({ model: "fake9/outsider-z", verdict: "mismatch" });
		await omp.emit("session_shutdown", {}, main);
	});

	// RF3-2/D7: a follow-up wakes a worker into a new attempt. Its approved models are the ones the decision that admitted
	// the worker wrote, read from that worker's admission; they are never rebuilt from the run-start team.
	test("RF3-2: a follow-up keeps the approved snapshot the admitting decision wrote, even after the team is reapproved", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		// The user reapproves the team while this run is live; a spawn now routes the new model.
		await approve({ ...TEAM, roles: { ...TEAM.roles, explorer: { ...TEAM.roles.explorer, models: ["a/new-approved"] } } });
		setSystemTime(new Date(Date.now() + 3_000));
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		const admitted = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
		expect(admitted.kind === "record" && admitted.record.approved?.map(entry => entry.selector)).toEqual(["a/new-approved"]);
		child.thinking.level = "low";
		const first = asking(worker, "a", "new-approved");
		await child.emit("before_provider_request", { payload: {} }, first.ctx);
		expect(first.aborted()).toBe(0);
		expect(runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran).toMatchObject({ model: "a/new-approved", verdict: "verified" });
		await child.emit("agent_end", {}, worker);
		await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "call-look", isError: false }, main);
		// A work follow-up opens a new attempt. Its snapshot must still be the admitting decision's, not the run-start one.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-look", input: { path: "agent://look", content: "read more" } }, main))).toBe("pass");
		const reopened = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
		expect(reopened.kind === "record" && reopened.record.approved?.map(entry => entry.selector)).toEqual(["a/new-approved"]);
		const second = asking(worker, "a", "new-approved");
		await child.emit("before_provider_request", { payload: {} }, second.ctx);
		expect(second.aborted()).toBe(0);
		await omp.emit("session_shutdown", {}, main);
	});

	// RF4-1: a worker this run admitted whose record is gone is not admitted again under another model list. The record
	// of a live run is not pruned, so the only way it goes is that it was lost; the follow-up is refused with that cause.
	test("RF4-1: a follow-up whose admitted record was lost is refused, and nothing is rebuilt for it", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		await child.emit("agent_end", {}, worker);
		await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "call-look", isError: false }, main);
		await rm(path.join(project.env.agentDir, "storm", "admissions", `${workerAdmissionKey(project.root, "Main", worker.agent.id)}.json`));
		const refused = await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-look", input: { path: `agent://${worker.agent.id}`, content: "read more" } }, main);
		expect(verdict(refused)).toBe("authority");
		expect((await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id })).kind).toBe("missing");
		await omp.emit("session_shutdown", {}, main);
	});

	// RF4-1: a worker of an earlier run that this run takes over is a first admission for this run, so it gets the
	// approval the user's team names now — as a new spawn would — never the run's frozen starting list.
	test("RF4-1: a takeover of a prior-run worker uses the current approval, not the run-start list", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const firstRun = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		await child.emit("agent_end", {}, worker);
		await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "call-look", isError: false }, main);
		await omp.emit("session_switch", { reason: "resume" }, main);
		expect(getLedgerRun(firstRun)).toBeUndefined();
		const explorer = (models: string[]) => ({ ...TEAM, roles: { ...TEAM.roles, explorer: { ...TEAM.roles.explorer, models } } });
		await approve(explorer(["a/run-start"]));
		setSystemTime(new Date(Date.now() + 3_000));
		const secondRun = await openRun(omp, main, { lanes: [{ name: "New", kind: "explore", role: "explorer", goal: "Read more", results: answerFor("new-answer") }], workers: { explorer: 1 } });
		await approve(explorer(["a/now-approved"]));
		setSystemTime(new Date(Date.now() + 3_000));
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-look", input: { path: `agent://${worker.agent.id}`, content: "read more" } }, main))).toBe("pass");
		const admitted = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
		expect(admitted.kind === "record" && admitted.record.runId).toBe(secondRun);
		expect(admitted.kind === "record" && admitted.record.approved).toEqual([{ selector: "a/now-approved", effort: "low" }]);
		await omp.emit("session_shutdown", {}, main);
	});

	// RF4-4: the children this run admitted are its own records, not its spawn rows: a worker taken over by a
	// follow-up has no row, and a stop it records is still the director's to tell.
	test("RF4-4: a stop on a reused worker admitted by a follow-up is read by the director", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const firstRun = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		await child.emit("agent_end", {}, worker);
		await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "call-look", isError: false }, main);
		await omp.emit("session_switch", { reason: "resume" }, main);
		expect(getLedgerRun(firstRun)).toBeUndefined();
		const secondRun = await openRun(omp, main, { lanes: [{ name: "New", kind: "explore", role: "explorer", goal: "Read more", results: answerFor("new-answer") }], workers: { explorer: 1 } });
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-look", input: { path: `agent://${worker.agent.id}`, content: "read more" } }, main))).toBe("pass");
		expect(runSpawns(secondRun).some(spawn => spawn.spawnKey === worker.agent.id)).toBe(false);
		const admitted = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
		if (admitted.kind !== "record") throw new Error(JSON.stringify(admitted));
		expect(await admissionModule.recordWorkerStop(project.env.agentDir, { key: admitted.key, runId: secondRun, childId: worker.agent.id, attempt: admitted.record.attempt, reason: "pooled-thread" })).toBe(true);
		const told = await omp.emit("context", { messages: [] }, main);
		expect(JSON.stringify(told ?? "")).toContain(threadPolicy.workerStopNotice(worker.agent.id, "pooled-thread").slice(0, 30));
		expect(await omp.emit("context", { messages: [] }, main)).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	// RF4-7: the memory of delivered stop sentences belongs to the run that closes. A shutdown of another main session
	// never forgets it, so the same attempt is not told twice.
	test("RF4-7: an unrelated session's shutdown does not repeat a delivered stop sentence", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		// R4: a main-session spawn is admitted against its exact pending placement, so the director's task call comes first.
		const placedLook = await omp.emit("tool_call", { toolName: "task", toolCallId: "place-look", input: { agent: "storm-explorer", name: "look", task: "work look" } }, main);
		expect(verdict(placedLook)).toBe("pass");
		const look = placedName(placedLook, "look");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", look), main))).toMatch(/^route:/);
		const admitted = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: look });
		if (admitted.kind !== "record") throw new Error(JSON.stringify(admitted));
		expect(await admissionModule.recordWorkerStop(project.env.agentDir, { key: admitted.key, runId, childId: look, attempt: admitted.record.attempt, reason: "pooled-thread" })).toBe(true);
		const stopLine = closeoutModule.stormStopLine({ count: 1, first: look, reason: "pooled-thread" });
		expect(JSON.stringify(await omp.emit("context", { messages: [] }, main) ?? "")).toContain(stopLine);
		expect(await omp.emit("context", { messages: [] }, main)).toBeUndefined();
		const unrelated = fakeOmp(project);
		await unrelated.emit("session_shutdown", {}, unrelated.ctx({ ...MAIN, id: `unrelated-${randomUUID()}` }));
		expect(JSON.stringify(await omp.emit("context", { messages: [] }, main) ?? "")).not.toContain(stopLine);
		await omp.emit("session_shutdown", {}, main);
	});

	// RF4-10: a conversation switch keeps worker rows so a later run can follow a worker up; the session's real shutdown
	// clears every row of the closing session store, including rows of a run that already finished.
	test("RF4-10: a finished run's worker rows leave at the real shutdown, with no run active", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		await child.emit("agent_end", {}, worker);
		await child.emit("session_shutdown", {}, worker);
		await omp.emit("session_switch", { reason: "resume" }, main);
		expect(getLedgerRun(runId)).toBeUndefined();
		const hasRow = () => listAgents({ scope: project.sessionDir, runId }).some(agent => agent.id === worker.agent.id);
		expect(hasRow()).toBe(true);
		await omp.emit("session_shutdown", {}, main);
		expect(hasRow()).toBe(false);
	});


	test("RF3-7: a finished run's live-lanes key and agent rows leave the shared state", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		expect(sharedMap("storm.lanes.liveLanes").has(runId)).toBe(true);
		child.thinking.level = "low";
		const checked = asking(worker, "a", "x");
		await child.emit("before_provider_request", { payload: {} }, checked.ctx);
		expect(checked.aborted()).toBe(0);
		expect(listAgents({ runId, scope: project.sessionDir }).some(agent => agent.id === worker.agent.id)).toBe(true);
		await child.emit("agent_end", {}, worker);
		await omp.emit("session_shutdown", {}, main);
		// The run's record has already been built from these rows; the live state that described it must not outlive it.
		await until(() => getLedgerRun(runId) === undefined);
		expect(sharedMap("storm.lanes.liveLanes").has(runId)).toBe(false);
		expect(listAgents({ runId, scope: project.sessionDir })).toEqual([]);
	});

	test("RF3-10: a reviewer loaded from a separate copy of the same build keeps its tree proof across a warm follow-up", async () => {
		await gitRepo(project.root);
		await approve(TEAM);
		// A query-suffixed import is the only way to load a second instance of this module in one process; a static import is cached.
		const copy = (await import(`../src/extension.ts?copy=${randomUUID()}`)).default as typeof storm;
		const omp = fakeOmp(project);
		const child = fakeOmp(project, copy);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "Rev", kind: "review", role: "reviewer", goal: "Review the tree", results: answerFor("review-answer") }], workers: { reviewer: 1 } });
		const worker = await startWorker(omp, child, main, "Rev", "storm-reviewer");
		const verdictOf = () => listAgents({ scope: project.sessionDir, runId }).find(agent => agent.id === worker.agent.id);
		const yielded = (id: string) => ({ toolName: "yield", toolCallId: id, input: { data: { overall_correctness: "correct" } }, isError: false, content: [] });
		await child.emit("tool_result", yielded("first-Rev"), worker);
		expect(verdictOf()?.lastVerdict?.tree).toBeTruthy();
		await child.emit("agent_end", {}, worker);
		await writeFile(path.join(project.root, "rev-change.txt"), "changed before follow-up\n");
		// The host's warm route skips `before_agent_start`; the parent must still find the reviewer's own work tree.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-Rev", input: { path: "agent://Rev", content: "review current tree" } }, main))).toBe("pass");
		await child.emit("agent_start", {}, worker);
		await child.emit("tool_result", yielded("second-Rev"), worker);
		expect(verdictOf()?.lastVerdict?.tree).toBeTruthy();
		await child.emit("agent_end", {}, worker);
		await omp.emit("session_shutdown", {}, main);
	});


	// pooled threads, each with its own module state. The detection is positive (the host says which thread it is); a worker
	// the host put there stops before its first request and writes the reason on its own admission. Nothing is predicted or
	// refused at the spawn hook, and no stop file exists.
	describe("a worker off the director's thread: stopped before its first request (D5, D7)", () => {
		/** The child's lookups of its run find nothing (its thread shares no maps); its persisted admission is what remains. */
		const noRunInMemory = () => [
			spyOn(ledgerModule, "ledgerRunForLineage").mockImplementation(() => undefined),
			spyOn(ledgerModule, "ledgerRunForChild").mockImplementation(() => undefined),
			spyOn(ledgerModule, "ledgerRunForTree").mockImplementation(() => undefined),
		];
		/** A pooled thread: no run in memory and the runtime says this is not the main thread. */
		const pooled = () => [...noRunInMemory(), spyOn(threadPolicy, "onHostMainThread").mockReturnValue(false)];
		const noticesIn = (answers: unknown[]): number =>
			answers.filter(answer => JSON.stringify(answer ?? "").includes("풀 스레드")).length;
		const admissionOf = async (childId: string) => {
			const read = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId });
			if (read.kind !== "record") throw new Error(JSON.stringify(read));
			return read.record;
		};

		test("a worker on a pooled thread stops before its first request, its stop is validated and told once, and no spend or verdict is invented", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const worker = await startWorker(omp, child, main, "look", "storm-explorer");
			const spies = pooled();
			try {
				child.thinking.level = "low";
				const request = asking(worker, "a", "x");
				await child.emit("before_provider_request", { payload: {} }, request.ctx);
				expect(request.aborted()).toBe(1);
				await until(async () => (await admissionOf(worker.agent.id)).stop?.reason === "pooled-thread");
				const record = await admissionOf(worker.agent.id);
				expect(record.stop?.reason).toBe("pooled-thread");
				expect(record.revokedAt).toBeNumber();
				// The record carries the reason and nothing else the old stop file did; no second file or directory exists.
				expect(record.stop).toEqual({ reason: "pooled-thread", at: expect.any(Number) });
				expect(existsSync(path.join(project.env.agentDir, "storm", "admissions", "stops"))).toBe(false);
				expect("readChildStops" in admissionModule).toBe(false);
				expect("writeChildStop" in admissionModule).toBe(false);
				// The stop carries no cost and no verdict, and the spawn record does not invent one.
				expect(runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran).toBeUndefined();
				// A request that somehow follows (no such request is sent) adds no spend: the pooled channel carries none.
				await child.emit("message_end", assistant("a", "x", 1_000, 0.25), worker);
				// Two result hooks and a later request all read the same record: the director is told exactly once.
				const answers = await Promise.all([
					omp.emit("context", { messages: [] }, main),
					omp.emit("context", { messages: [] }, main),
				]);
				answers.push(await omp.emit("context", { messages: [] }, main));
				const told = answers.find(answer => answer !== undefined) as { messages: Array<{ content: Array<{ text: string }> }> } | undefined;
				expect(told?.messages.at(-1)?.content[0]?.text).toBe(`[storm] ${closeoutModule.stormStopLine({ count: 1, first: worker.agent.id, reason: "pooled-thread" })}`);
				expect(noticesIn(answers)).toBe(1);
				expect(getLedgerRun(runId)?.costUsd).toBe(0);
				// The reason stays readable on the record: reading twice is harmless, and a run's old record is not deleted by a read.
				expect((await admissionOf(worker.agent.id)).stop?.reason).toBe("pooled-thread");
				expect(runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.stop).toMatchObject({ attempt: record.attempt, reason: "pooled-thread", at: expect.any(Number) });
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		});

		test("a stop is adopted only for the exact run and attempt; another attempt is refused, and a second read is inert", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const worker = await startWorker(omp, child, main, "look", "storm-explorer");
			const record = await admissionOf(worker.agent.id);
			const read = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
			if (read.kind !== "record") throw new Error(JSON.stringify(read));
			// A stop of another attempt writes nothing at all: the writer checks the record's current attempt.
			expect(await admissionModule.recordWorkerStop(project.env.agentDir, { key: read.key, runId, childId: worker.agent.id, attempt: "00000000-0000-4000-8000-000000000000", reason: "pooled-thread" })).toBe(false);
			expect(await omp.emit("context", { messages: [] }, main)).toBeUndefined();
			// The same child's real attempt is adopted once, and reading the same record again changes nothing.
			expect(await admissionModule.recordWorkerStop(project.env.agentDir, { key: read.key, runId, childId: worker.agent.id, attempt: record.attempt, reason: "pooled-thread" })).toBe(true);
			const first = await omp.emit("context", { messages: [] }, main);
			expect(JSON.stringify(first)).toContain("풀 스레드");
			expect(await omp.emit("context", { messages: [] }, main)).toBeUndefined();
			expect((await admissionOf(worker.agent.id)).stop?.reason).toBe("pooled-thread");
			await omp.emit("session_shutdown", {}, main);
		});

		test("an ordinary native child on another thread is left alone outside a run and stopped once the tree has a managed run", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project), child = fakeOmp(project), main = omp.ctx(MAIN);
			const spies = pooled();
			try {
				const native = asking(child.ctx(sub("native", "unrelated")), "a", "i");
				await child.emit("before_provider_request", { payload: {} }, native.ctx);
				expect(native.aborted()).toBe(0);
				// The run writes its marker at its start, so from then on the same unrecorded child is unknown in a
				// managed tree, never unmanaged: it is stopped before its first request.
				await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
				await child.emit("before_provider_request", { payload: {} }, native.ctx);
				expect(native.aborted()).toBe(1);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF7: the request check reads the admission snapshot, so a team file edited after admission cannot authorize a main-thread worker", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const worker = await startWorker(omp, child, main, "look", "storm-explorer");
			child.thinking.level = "low";
			const before = asking(worker, "a", "x");
			await child.emit("before_provider_request", { payload: {} }, before.ctx);
			expect(before.aborted()).toBe(0);
			await writeConfig(project.sessionDir, { ...TEAM, roles: { ...TEAM.roles, explorer: { ...TEAM.roles.explorer, models: ["a/not-approved"] } } });
			setSystemTime(new Date(Date.now() + 3_000));
			const after = asking(worker, "a", "not-approved");
			await child.emit("before_provider_request", { payload: {} }, after.ctx);
			expect(after.aborted()).toBe(1);
			expect(runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran).toMatchObject({ model: "a/not-approved", verdict: "mismatch" });
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF4: a trial-routed spawn writes its candidate into the admission snapshot, so the main-thread check accepts it", async () => {
			const trial = { id: "probe", role: "explorer", model: "trial/candidate", effort: "low" as const, share: 1, maxSpawns: 10, budgetUsd: 0.1, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString() };
			await approve({ ...TEAM, trials: [trial] });
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const worker = await startWorker(omp, child, main, "look", "storm-explorer");
			expect(runSpawns(activeLedgerRun(project.sessionDir)?.runId as string).find(spawn => spawn.spawnKey === worker.agent.id)?.outcome).toBe("trial");
			const record = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
			expect(record.kind === "record" && record.record.approved?.some(entry => entry.selector === "trial/candidate")).toBe(true);
			child.thinking.level = "low";
			const candidate = asking(worker, "trial", "candidate");
			await child.emit("before_provider_request", { payload: {} }, candidate.ctx);
			expect(candidate.aborted()).toBe(0);
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF3-5: a 257-model role is approved and spawns on the main thread with its whole snapshot, not refused for size", async () => {
			const models = Array.from({ length: 257 }, (_, index) => `a/model${index}`);
			await approve({ ...TEAM, roles: { ...TEAM.roles, explorer: { ...TEAM.roles.explorer, models } } });
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const placed = await omp.emit("tool_call", { toolName: "task", input: { agent: "storm-explorer", name: "look", task: "work look" } }, main);
			expect(verdict(placed)).toBe("pass");
			const look = placedName(placed, "look");
			const routed = await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", look), main);
			expect(verdict(routed)).toMatch(/^route:a\/model0/);
			const record = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: look });
			expect(record.kind === "record" && record.record.approved?.length).toBe(257);
			expect(record.kind === "record" && record.record.approved?.at(-1)?.selector).toBe("a/model256");
			await omp.emit("session_shutdown", {}, main);
		});


		test("D7/RF3-3: a ninth spawn is never refused for a predicted placement, whatever task.workerThreads says", async () => {
			await approve(TEAM);
			// The prediction read the live main-thread workers and `task.workerThreads`; both are gone, so a ninth worker the
			// host might pool still gets its route under either setting. Each setting gets its own run and its own eight live
			// workers, which is the placement the removed prediction used to refuse.
			for (const workerThreads of [4, 0] as const) {
				const omp = fakeOmp(project);
				const child = fakeOmp(project);
				const main = omp.ctx(MAIN);
				const names = Array.from({ length: 9 }, (_, index) => `E${index}`);
				const lanes = names.map(name => ({ name, kind: "explore" as const, role: "explorer", goal: "Read the tree", results: answerFor(`${name}-answer`) }));
				await openRun(omp, main, { lanes, workers: { explorer: 4 } });
				for (const name of names.slice(0, 8)) {
					const worker = await startWorker(omp, child, main, name, "storm-explorer");
					child.thinking.level = "low";
					const checked = asking(worker, "a", "x");
					await child.emit("before_provider_request", { payload: {} }, checked.ctx);
					expect(checked.aborted()).toBe(0);
				}
				// The ninth worker's own director call places its lane: R4 matches a spawn to its placement exactly, so a spawn
				// emitted with no placement is refused for that reason and this test would prove the wrong rule.
				const ninthCall = { toolName: "task", input: { agent: "storm-explorer", name: names[8], task: `work ${names[8]}` } };
				expect(verdict(await omp.emit("tool_call", ninthCall, main))).toBe("pass");
				const ninth = spawnOf("storm-explorer", names[8]);
				// The host may put this one on a pooled thread; the courtesy prediction is gone, so the spawn passes and the
				// child's own positive check is what stops it (covered above). No `placementWouldPool` exists to call.
				expect("placementWouldPool" in threadPolicy).toBe(false);
				expect("HOST_MAIN_THREAD_RUNS" in threadPolicy).toBe(false);
				const routed = await withActiveSettings(Settings.isolated({ "task.workerThreads": workerThreads }), () => omp.emit("before_subagent_spawn", ninth, main));
				expect(verdict(routed)).toMatch(/^route:/);
				await omp.emit("session_shutdown", {}, main);
			}
		}, 30_000);

		test("D7/RF3-1/RF3-7: on the main thread with no shared run the cause is state, never the pooled sentence", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const worker = await startWorker(omp, child, main, "look", "storm-explorer");
			const spies = noRunInMemory();
			try {
				child.thinking.level = "low";
				const request = asking(worker, "a", "x");
				await child.emit("before_provider_request", { payload: {} }, request.ctx);
				expect(request.aborted()).toBe(1);
				await until(async () => (await admissionOf(worker.agent.id)).stop?.reason === "state-not-shared");
				expect((await admissionOf(worker.agent.id)).stop?.reason).toBe("state-not-shared");
				const answer = await omp.emit("context", { messages: [] }, main);
				const text = JSON.stringify(answer ?? "");
				expect(text).toContain(closeoutModule.stormStopLine({ count: 1, first: worker.agent.id, reason: "state-not-shared" }));
				expect(text).not.toContain("풀 스레드");
				expect(getLedgerRun(runId)?.costUsd).toBe(0);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		});

		test("D7: a worker of a finished run, woken on the main thread, is not stopped: its revoked admission is not lost state", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const worker = await startWorker(omp, child, main, "look", "storm-explorer");
			// The run ended and withdrew the worker's authority; what remains on disk is a record naming that run.
			await revokeWorkerAdmissions(project.env.agentDir, { runId, childId: worker.agent.id });
			const spies = noRunInMemory();
			try {
				child.thinking.level = "low";
				const woke = asking(worker, "a", "x");
				await child.emit("before_agent_start", { systemPrompt: [] }, woke.ctx);
				expect(woke.aborted()).toBe(0);
				const request = asking(worker, "a", "x");
				await child.emit("before_provider_request", { payload: {} }, request.ctx);
				expect(request.aborted()).toBe(0);
				// No sentence is owed and no stop is written: this worker's authority ended, it did not lose its state.
				expect((await admissionOf(worker.agent.id)).stop).toBeUndefined();
				const told = await omp.emit("context", { messages: [] }, main);
				expect(JSON.stringify(told ?? "")).not.toContain(threadPolicy.workerStopNotice("storm-explorer", "state-not-shared"));
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF3-11: a verified request of an earlier attempt stays historical, and a later attempt's stop names its own attempt", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
			const worker = await startWorker(omp, child, main, "look", "storm-explorer");
			child.thinking.level = "low";
			const first = asking(worker, "a", "x");
			await child.emit("before_provider_request", { payload: {} }, first.ctx);
			expect(first.aborted()).toBe(0);
			const verified = runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran;
			expect(verified).toMatchObject({ model: "a/x", verdict: "verified" });
			expect(verified?.attempt).toBeString();
			await child.emit("agent_end", {}, worker);
			await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "call-look", isError: false }, main);
			// A work follow-up opens a new attempt; its approval comes from the admission, and the admission's attempt changes.
			expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-look", input: { path: "agent://look", content: "read more" } }, main))).toBe("pass");
			const afterFollow = await admissionOf(worker.agent.id);
			expect(afterFollow.attempt).not.toBe(verified?.attempt);
			const spies = pooled();
			try {
				const second = asking(worker, "a", "x");
				await child.emit("before_provider_request", { payload: {} }, second.ctx);
				expect(second.aborted()).toBe(1);
				await until(async () => (await admissionOf(worker.agent.id)).stop?.reason === "pooled-thread");
				const told = await omp.emit("context", { messages: [] }, main);
				expect(JSON.stringify(told ?? "")).toContain("풀 스레드");
				const spawn = runSpawns(runId).find(item => item.spawnKey === worker.agent.id);
				expect(spawn?.ran).toEqual(verified);
				expect(spawn?.stop?.attempt).toBe(afterFollow.attempt);
				expect(spawn?.stop?.attempt).not.toBe(spawn?.ran?.attempt);
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		});
	});

	test("an unmanaged in-memory subagent can send its first request and read", async () => {
		const omp = fakeOmp(project);
		const native = omp.ctx(sub("no-storage", "task"));
		const manager = { ...native.sessionManager, getArtifactsDir: () => null };
		const checked = asking({ ...native, sessionManager: manager } as unknown as ExtensionContext, "a", "x");
		await omp.emit("before_provider_request", { payload: {} }, checked.ctx);
		expect(checked.aborted()).toBe(0);
		expect(verdict(await omp.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, checked.ctx))).toBe("pass");
	});

	// R-G234 H1 (decision): the promise about approved models is about the model and effort a worker's own loop runs on. A tool
	// that makes a model request of its own on one of omp's auxiliary roles (`magic` edit, `find`'s judge, a search, a repair) is
	// the user's own omp configuration: not refused, and its spend is counted (tests/run-spend.test.ts).
	test("a worker's edit passes in every edit mode, `magic` included: the model call an edit makes on omp's own role is counted, not refused", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		const edit = { toolName: "edit", input: { path: "a.txt", edits: [] } };
		const inMode = (mode: string) => withActiveSettings(Settings.isolated({ "edit.mode": mode }), () => child.emit("tool_call", edit, worker));
		for (const mode of ["magic", "hashline", "replace", "patch", "apply_patch"]) expect(verdict(await inMode(mode))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a worker whose host reports no thinking level is stopped when its role has an approved effort (the level is not established), and a mismatch stays recorded", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		const ranOf = () => runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran;
		child.thinking.level = undefined;
		const unread = asking(worker, "a", "x");
		await child.emit("before_provider_request", { payload: {} }, unread.ctx);
		expect(unread.aborted()).toBe(1);
		expect(ranOf()).toMatchObject({ model: "a/x", verdict: "mismatch" });
		const told = (await omp.emit("context", { messages: [] }, main)) as { messages: Array<{ content: Array<{ text: string }> }> } | undefined;
		expect(told?.messages.at(-1)?.content[0]?.text).toContain("추론 강도를 알려 주지 않아");
		// R-G234 L2: a later reading of an approved model (a woken worker) never replaces the mismatch in the record.
		await child.emit("session_shutdown", {}, worker);
		child.thinking.level = "low";
		await child.emit("before_provider_request", { payload: {} }, asking(worker, "a", "x").ctx);
		expect(ranOf()).toMatchObject({ model: "a/x", verdict: "mismatch" });
		await omp.emit("session_shutdown", {}, main);
	});

	// R-final N6 + RF7: the request check reads the admission snapshot, so a live team file that cannot be read does not
	// decide the request; an admission that cannot be read is the check that cannot be made, and stops the worker with that cause.
	test("a worker's request is checked against its admission, not the live team file: a broken team file passes, a broken admission stops with that cause", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [{ name: "look", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("look-answer") }], workers: { explorer: 1 } });
		const worker = await startWorker(omp, child, main, "look", "storm-explorer");
		await writeFile(configPath(project.sessionDir), "{ not json");
		// The state cache holds what it read for two seconds; advancing the clock makes any old read stale. (The check itself no
		// longer reads state: the admission is its input.)
		setSystemTime(new Date(Date.now() + 2_500));
		child.thinking.level = "low";
		const admitted = asking(worker, "a", "x");
		await child.emit("before_provider_request", { payload: {} }, admitted.ctx);
		expect(admitted.aborted()).toBe(0);
		expect(runSpawns(runId).find(spawn => spawn.spawnKey === worker.agent.id)?.ran).toMatchObject({ model: "a/x", verdict: "verified" });
		// The same worker with its admission unreadable: nothing trustworthy says what it may run, so it is stopped with the real cause.
		const read = await readWorkerAdmission({ agentDir: project.env.agentDir, artifactRoot: project.root, parentId: "Main", childId: worker.agent.id });
		if (read.kind !== "record") throw new Error(JSON.stringify(read));
		await writeFile(path.join(project.env.agentDir, "storm", "admissions", `${workerAdmissionKey(project.root, "Main", worker.agent.id)}.json`), "{ not json");
		const asked = asking(worker, "a", "x");
		await child.emit("before_provider_request", { payload: {} }, asked.ctx);
		expect(asked.aborted()).toBe(1);
		const told = (await omp.emit("context", { messages: [] }, main)) as { messages: Array<{ content: Array<{ text: string }> }> } | undefined;
		const text = told?.messages.at(-1)?.content[0]?.text ?? "";
		expect(text).toContain("storm-explorer 워커를 멈췄습니다");
		expect(text).toContain(modelMismatchNotice("storm-explorer", { ok: false, reason: "unchecked", observed: "a/x", approved: [] }));
		expect(text).not.toContain(modelMismatchNotice("storm-explorer", { ok: false, reason: "no-role", observed: "a/x", approved: [] }));
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);

	test("eval helper spend read back from the worker's session counts toward the budget: the next spawn is refused once it reaches the limit", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 0.1, onExceed: "block-spawns" } });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt"), writerLane("B", "b.txt")], workers: { implementer: 2 } });
		const worker = await startWorker(omp, child, main, "A");
		const file = path.join(project.tmp, "a-session.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "model_usage", purpose: "completion", timestamp: new Date(Date.now() + 1_000).toISOString(), usage: { cost: { total: 0.25 } } })}\n`);
		const withFile = { ...worker, sessionManager: { ...worker.sessionManager, getSessionFile: () => file } } as unknown as ExtensionContext;
		await child.emit("tool_result", { toolName: "eval", input: { code: "r = await completion('hi')" }, isError: false, content: [] }, withFile);
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.25);
		expect(getLedgerRun(runId)?.exceeded).toBe(true);
		await child.emit("agent_end", {}, worker);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "B"), main))).toBe("budget");
		// B3: past the close no message reaches a worker, a quiet note included; the cause is the budget close.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "m-1", input: { path: "agent://A", content: "write more" } }, main))).toBe("spend");
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "m-2", input: { path: "Agent://A?progress", content: "status" } }, main))).toBe("spend");
		// A broadcast is a message too, under every spelling.
		for (const [at, target] of ["agent://all", "AGENT://ALL", "agent://%61ll"].entries()) {
			expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: `b-${at}`, input: { path: target, content: "write more" } }, main)), target).toBe("spend");
		}
		await omp.emit("session_shutdown", {}, main);
	});

	// R-G234 H1 (G3 half): every purpose omp journals counts, for every tool, not only eval's helpers.
	test("a side model call of any tool (`find`) is read back from the worker's session file after the call; an unreadable file is a floor", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 5, onExceed: "block-spawns" } });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		const file = path.join(project.tmp, "a-find-session.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "model_usage", purpose: "find", timestamp: new Date(Date.now() + 1_000).toISOString(), usage: { cost: { total: 0.4 } } })}\n`);
		const withFile = { ...worker, sessionManager: { ...worker.sessionManager, getSessionFile: () => file } } as unknown as ExtensionContext;
		await child.emit("tool_result", { toolName: "find", input: { pattern: "*.ts" }, isError: false, content: [] }, withFile);
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.4);
		// A later turn's own `compaction` entry is counted when the turn ends, with no tool call to ride on.
		await appendFile(file, `${JSON.stringify({ type: "model_usage", purpose: "compaction:auto", timestamp: new Date(Date.now() + 2_000).toISOString(), usage: { cost: { total: 0.1 } } })}\n`);
		await child.emit("agent_end", {}, withFile);
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.5);
		// A call that may have made a side call whose file cannot be read: the total is a floor.
		const unreadable = { ...worker, sessionManager: { ...worker.sessionManager, getSessionFile: () => path.join(project.tmp, "gone.jsonl") } } as unknown as ExtensionContext;
		await child.emit("tool_result", { toolName: "find", input: { pattern: "x" }, isError: false, content: [] }, unreadable);
		expect(getLedgerRun(runId)?.evalUnread.size).toBeGreaterThan(0);
		await omp.emit("session_shutdown", {}, main);
	});

	// R-final N3: omp re-journals a turn it drops as `discarded-turn`; Storm counted that turn when it ended.
	test("a turn omp dropped and re-journaled is counted once: at its message_end, not again from the journal", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 5, onExceed: "block-spawns" } });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		const file = path.join(project.tmp, "a-discard.jsonl");
		const at = new Date(Date.now() + 1_000).toISOString();
		const withFile = { ...worker, sessionManager: { ...worker.sessionManager, getSessionFile: () => file } } as unknown as ExtensionContext;
		await child.emit("message_end", assistant("a", "x", 10_000, 0.3), withFile);
		await writeFile(file, `${JSON.stringify({ type: "model_usage", id: "u1", purpose: DISCARDED_TURN_PURPOSE, timestamp: at, usage: { cost: { total: 0.3 } } })}\n`);
		await child.emit("tool_result", { toolName: "read", input: { path: "a.txt" }, isError: false, content: [] }, withFile);
		await child.emit("agent_end", {}, withFile);
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.3);
		// A side call of the same file that is not a dropped turn still counts.
		await appendFile(file, `${JSON.stringify({ type: "model_usage", id: "u2", purpose: "find", timestamp: at, usage: { cost: { total: 0.2 } } })}\n`);
		await child.emit("agent_end", {}, withFile);
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.5);
		await omp.emit("session_shutdown", {}, main);
	});

	// R-final N7: a call that made no model request must not leave the total a floor for good.
	test("a find or search that made no model call leaves no floor once the turn ends; a failed one never sets it", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 5, onExceed: "block-spawns" } });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		const runId = await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		const worker = await startWorker(omp, child, main, "A");
		const file = path.join(project.tmp, "a-nofind.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "message", id: "m1", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } })}\n`);
		const withFile = { ...worker, sessionManager: { ...worker.sessionManager, getSessionFile: () => file } } as unknown as ExtensionContext;
		await child.emit("tool_result", { toolName: "find", input: { pattern: "*.ts" }, isError: false, content: [] }, withFile);
		await child.emit("tool_result", { toolName: "web_search", input: { query: "x" }, isError: false, content: [] }, withFile);
		// While the turn runs the floor stands: the entry may still be on its way.
		expect(getLedgerRun(runId)?.evalUnread.size).toBe(1);
		await child.emit("agent_end", {}, withFile);
		expect(getLedgerRun(runId)?.evalUnread.size).toBe(0);
		expect(spendNote(getLedgerRun(runId))).toBeUndefined();
		await child.emit("tool_result", { toolName: "find", input: { pattern: "x" }, isError: true, content: [] }, withFile);
		expect(getLedgerRun(runId)?.evalUnread.size).toBe(0);
		await child.emit("session_shutdown", {}, withFile);
		expect(getLedgerRun(runId)?.evalUnread.size).toBe(0);
		await omp.emit("session_shutdown", {}, main);
	});
});

/**
 * Phase 2 (0.28.0) through the hooks: the director's own path edits in the run's write table, read lanes that carry a shell, and the
 * result contract in each worker's assignment. Each refusal here fails on the extension as it was before the wiring (which refused
 * every director edit as `director-edit` and had none of the rest).
 */
describe("phase 2 through the hooks: the director's path edits", () => {
	const openRun = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, plan: object): Promise<string> => {
		await omp.command("manual task", main);
		const run = activeLedgerRun(project.sessionDir);
		if (run === undefined) throw new Error(`The director's run did not open: ${JSON.stringify(omp.transcript)}`);
		expect(await omp.tool({ action: "plan", plan }, main)).toBe("ok");
		return run.runId;
	};
	const writerLane = (name: string, file: string) => ({ name, kind: "code" as const, role: "implementer", files: [file], goal: `Write ${file}`, results: changeFor(`${name}-change`) });
	const taskCall = (name: string, callId: string, agent = "storm-implementer") => ({ toolName: "task", toolCallId: callId, input: { agent, name, task: `work ${name}` } });
	const startWorker = async (omp: ReturnType<typeof fakeOmp>, child: ReturnType<typeof fakeOmp>, main: ExtensionContext, name: string, callId?: string, agent = "storm-implementer"): Promise<ExtensionContext> => {
		const call = taskCall(name, callId ?? `call-${name}`, agent);
		const placed = await omp.emit("tool_call", call, main);
		expect(verdict(placed)).toBe("pass");
		const handle = placedName(placed, name);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf(agent, handle), main))).toMatch(/^route:/);
		const worker = child.ctx(sub(handle, agent));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		return worker;
	};
	const bash = (callId: string, input: Record<string, unknown> = { command: "git status" }) => ({ toolName: "bash", toolCallId: callId, input });
	const ended = (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, toolName: string, callId: string) =>
		omp.emit("tool_execution_end", { toolName, toolCallId: callId, isError: false }, main);
	const reasonOf = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, call: { toolName: string; toolCallId: string; input: unknown }): Promise<string> => {
		const result = (await omp.emit("tool_result", { ...call, isError: true, content: [] }, main)) as { content?: Array<{ text?: string }> } | undefined;
		return result?.content?.[0]?.text ?? "";
	};
	const edit = (callId: string, file = "d.txt") => ({ toolName: "edit", toolCallId: callId, input: { path: file, old_string: "a", new_string: "b" } });
	/** The text of a refused director call (a plain block). */
	const refusal = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, call: object): Promise<{ code: string; reason: string }> => {
		const answer = (await omp.emit("tool_call", call, main)) as { block?: boolean; reason?: string } | undefined;
		expect(answer?.block).toBe(true);
		return { code: verdict(answer), reason: answer?.reason ?? "" };
	};
	/** What the host sends when a message's tool batch is over: its calls and each call's result. */
	const turnEndOf = (calls: Array<{ id: string; name?: string; error?: boolean }>) => ({
		message: { role: "assistant", stopReason: "toolUse", content: calls.map(entry => ({ type: "toolCall", id: entry.id, name: entry.name ?? "edit", arguments: {} })) },
		toolResults: calls.map(entry => ({ role: "toolResult", toolCallId: entry.id, toolName: entry.name ?? "edit", isError: entry.error === true, content: [] })),
	});
	/**
	 * An assistant message's own `message_end`. The host emits it AFTER the `tool_call` hooks of the message's calls and BEFORE any of them
	 * executes (omp 19.2.1, pi-agent-core agent-loop `prepareToolCallDispatch` then `message_end`; the V log of fact 1): `ids` are
	 * those calls. A test that emits it with no ids stands for the NEXT request's message, which carries other calls or none.
	 */
	const assistantEnd = (stopReason?: string, ids: readonly string[] = []) => ({
		message: {
			role: "assistant",
			content: ids.map(id => ({ type: "toolCall", id, name: "edit", arguments: {} })),
			...(stopReason === undefined ? {} : { stopReason }),
		},
	});
	let probes = 0;
	/** Whether a director path edit holds the table now: the director's own command is refused beside it, and only beside it. */
	const holds = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext): Promise<boolean> => {
		const id = `probe-${++probes}`;
		const answer = verdict(await omp.emit("tool_call", bash(id), main));
		if (answer === "pass") {
			await ended(omp, main, "bash", id);
			return false;
		}
		expect(answer).toBe("director-exec");
		return true;
	};

	test("an edit beside nothing passes and holds its entry: no writer that cannot be bounded starts beside it until its turn ends", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		expect(await holds(omp, main)).toBe(false);
		expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
		expect(await holds(omp, main)).toBe(true);
		// A worker that may run commands is refused the tree, and told the director is editing; no worker is named.
		const placement = taskCall("A", "a-1");
		expect(verdict(await omp.emit("tool_call", placement, main))).toBe("lane-write");
		const reason = await reasonOf(omp, main, placement);
		expect(reason).toContain(DIRECTOR_EDITING);
		// The call and its result are not the end: omp can still be writing this call's file during a later call of the message.
		await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "e-1" }, main);
		await omp.emit("tool_result", { ...edit("e-1"), isError: false, content: [] }, main);
		await ended(omp, main, "edit", "e-1");
		expect(await holds(omp, main)).toBe(true);
		// The turn's end, with every call of the message done without an error, is.
		await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
		expect(await holds(omp, main)).toBe(false);
		expect(verdict(await omp.emit("tool_call", taskCall("A", "a-2"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a call the extension cannot bound is refused with its cause, and holds nothing", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		for (const [callId, call] of [
			["x-1", edit("x-1", "../outside.txt")],
			["x-2", edit("x-2", ".git/config")],
			["x-3", { toolName: "write", toolCallId: "x-3", input: { path: "vault://notes/x.md", content: "x" } }],
			["x-4", { toolName: "edit", toolCallId: "x-4", input: { input: "nothing a parser reads" } }],
			["x-5", { ...edit("x-5"), parentToolCallId: "eval-call" }],
		] as const) {
			const refused = await refusal(omp, main, call);
			expect(refused.code, callId).toBe("director-edit");
			expect(refused.reason, callId).toContain(DIRECTOR_EDIT_LEAD);
		}
		// A host that gave the call no id cannot have it released: the edit is refused rather than held for ever.
		expect((await refusal(omp, main, { toolName: "edit", input: edit("x").input })).code).toBe("director-write");
		expect(await holds(omp, main)).toBe(false);
		await omp.emit("session_shutdown", {}, main);
	});

	test("beside a placed writer, a running one and one whose follow-up is admitted and not yet started, the edit is refused naming the holder", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, {
			lanes: [writerLane("A", "a.txt"), writerLane("H0", "h.txt")],
			workers: { implementer: 2 },
		});
		// Placed: its task call passed, its spawn has not been allocated.
		expect(verdict(await omp.emit("tool_call", taskCall("A", "a-1"), main))).toBe("pass");
		const placed = await refusal(omp, main, edit("e-1"));
		expect(placed.code).toBe("director-write");
		expect(placed.reason).toContain(DIRECTOR_WRITE_LEAD);
		expect(placed.reason).toContain(holderPhrase({ lane: "A" }));
		// Running: its worker started.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "A"), main))).toMatch(/^route:/);
		const worker = child.ctx(sub("A"));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		const running = await refusal(omp, main, edit("e-2"));
		expect(running.code).toBe("director-write");
		expect(running.reason).toContain(holderPhrase({ lane: "A", agentId: "A" }));
		// The worker settles; its sibling H0 runs and settles, then a work follow-up is admitted and its turn has not started.
		await child.emit("agent_end", {}, worker);
		await ended(omp, main, "task", "a-1");
		const holder = await startWorker(omp, child, main, "H0");
		await child.emit("agent_end", {}, holder);
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "f-1", input: { path: "agent://H0", content: "more work" } }, main))).toBe("pass");
		const awaiting = await refusal(omp, main, edit("e-3"));
		expect(awaiting.code).toBe("director-write");
		expect(awaiting.reason).toContain(holderPhrase({ lane: "H0", agentId: "H0", awaiting: true }));
		// Its turn starts and ends: the tree is free and the refusals left nothing behind.
		await child.emit("agent_start", {}, holder);
		await child.emit("agent_end", {}, holder);
		await ended(omp, main, "task", "call-H0");
		await ended(omp, main, "write", "f-1");
		expect(verdict(await omp.emit("tool_call", edit("e-4"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);

	for (const order of ["edit then task", "task then edit"] as const) {
		test(`in one message [${order.replace(" then ", ", ")}] the two calls give opposite winners`, async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			if (order === "edit then task") {
				// The hooks of one message run in call order and before any call executes: the edit holds the table first.
				expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
				const placement = taskCall("A", "a-1");
				expect(verdict(await omp.emit("tool_call", placement, main))).toBe("lane-write");
				expect(await reasonOf(omp, main, placement)).toContain(DIRECTOR_EDITING);
			} else {
				expect(verdict(await omp.emit("tool_call", taskCall("A", "a-1"), main))).toBe("pass");
				const refused = await refusal(omp, main, edit("e-1"));
				expect(refused.code).toBe("director-write");
				expect(refused.reason).toContain(holderPhrase({ lane: "A" }));
			}
			await omp.emit("session_shutdown", {}, main);
		});
	}

	test("a path-only worker on other files does not refuse the edit, and one on the same file or its directory does", async () => {
		await pathOnlyImplementer();
		await approveShadows(TEAM);
		await mkdir(path.join(project.root, "held"), { recursive: true });
		await mkdir(path.join(project.root, "free"), { recursive: true });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, {
			lanes: [
				{ name: "P", kind: "code", role: "implementer", files: ["held/e.txt"], goal: "Write one file", results: changeFor("p-change") },
				{ name: "D", kind: "code", role: "implementer", files: ["held/dir"], goal: "Write a directory", results: changeFor("d-change") },
			],
			workers: { implementer: 2 },
		});
		await startWorker(omp, child, main, "P");
		// Both are bounded: the director's edit of another file runs beside the worker, and is held like any other.
		expect(verdict(await omp.emit("tool_call", edit("e-1", "free/f.txt"), main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", edit("e-2", "held/other.txt"), main))).toBe("pass");
		// The same file is the worker's.
		const same = await refusal(omp, main, edit("e-3", "held/e.txt"));
		expect(same.code).toBe("director-write");
		expect(same.reason).toContain(holderPhrase({ lane: "P", agentId: "P" }));
		// A directory the worker holds covers what is under it.
		await omp.emit("turn_end", turnEndOf([{ id: "e-1" }, { id: "e-2" }]), main);
		await startWorker(omp, child, main, "D");
		const below = await refusal(omp, main, edit("e-4", "held/dir/deep/x.txt"));
		expect(below.code).toBe("director-write");
		expect(below.reason).toContain(holderPhrase({ lane: "D", agentId: "D" }));
		// And the other way: a path-only worker whose files are under the director's own held file is refused its place.
		expect(verdict(await omp.emit("tool_call", edit("e-5", "free/f.txt"), main))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);

	test("a read lane without a shell runs beside the edit, and one with a shell does not (it is ordered like a writer)", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, {
			lanes: [
				{ name: "E0", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("e0-answer") },
				{ name: "R0", kind: "review", role: "reviewer", goal: "Review the tree" },
			],
			workers: { explorer: 1, reviewer: 1 },
		});
		expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
		expect(verdict(await omp.emit("tool_call", taskCall("E0", "t-1", "storm-explorer"), main))).toBe("pass");
		// The shipped reviewer carries a shell: it cannot start while the director edits.
		const review = taskCall("R0", "t-2", "storm-reviewer");
		expect(verdict(await omp.emit("tool_call", review, main))).toBe("lane-write");
		expect(await reasonOf(omp, main, review)).toContain(DIRECTOR_EDITING);
		await omp.emit("session_shutdown", {}, main);
	});

	/** A run with one writer lane, and the director's edit `e-1` passed and held. */
	const heldEdit = async (): Promise<{ omp: ReturnType<typeof fakeOmp>; main: ExtensionContext }> => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
		expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
		expect(await holds(omp, main)).toBe(true);
		return { omp, main };
	};

	describe("release (decision D2)", () => {
		test("nothing but the end of a turn releases it: not a call's end, a result, an old loop's agent end, another turn's ids, a prune or the run's end", async () => {
			const { omp, main } = await heldEdit();
			await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "e-1" }, main);
			await omp.emit("tool_result", { ...edit("e-1"), isError: false, content: [] }, main);
			await omp.emit("tool_execution_end", { toolName: "edit", toolCallId: "e-1", isError: false }, main);
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("tool_execution_end", { toolName: "edit", toolCallId: "e-1", isError: true }, main);
			expect(await holds(omp, main)).toBe(true);
			// An agent end carries the whole history, this call's id included: it is no proof (it can arrive twice per prompt).
			await omp.emit("agent_end", { willContinue: true, messages: [turnEndOf([{ id: "e-1" }]).message] }, main);
			expect(await holds(omp, main)).toBe(true);
			// A turn that names other calls releases those and nothing of this one.
			await omp.emit("turn_end", turnEndOf([{ id: "other-call" }]), main);
			expect(await holds(omp, main)).toBe(true);
			// A turn of a subagent is not the director's.
			const child = fakeOmp(project);
			await child.emit("turn_end", turnEndOf([{ id: "e-1" }]), child.ctx(sub("Impl")));
			expect(await holds(omp, main)).toBe(true);
			// No time passes it: the table is never pruned of this kind of entry (thirty minutes on).
			setSystemTime(new Date(Date.now() + 30 * 60_000));
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("the host's order: the hook, then the SAME message's own message_end, then the call runs: the hold survives that message_end and every writer is refused while the call runs", async () => {
			const { omp, main } = await heldEdit();
			// The message that carries the call ends (a completed one: toolUse) before any of its calls executes.
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1"]), main);
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "e-1" }, main);
			// While the call runs: a writer that may run commands is refused the tree, naming the director's edit, and so is the director's command.
			const placement = taskCall("A", "a-1");
			expect(verdict(await omp.emit("tool_call", placement, main))).toBe("lane-write");
			expect(await reasonOf(omp, main, placement)).toContain(DIRECTOR_EDITING);
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("tool_result", { ...edit("e-1"), isError: false, content: [] }, main);
			await ended(omp, main, "edit", "e-1");
			expect(await holds(omp, main)).toBe(true);
			// Only the turn's end, clean, frees it.
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			expect(await holds(omp, main)).toBe(false);
			expect(verdict(await omp.emit("tool_call", taskCall("A", "a-2"), main))).toBe("pass");
			await omp.emit("session_shutdown", {}, main);
		});

		test("an extension that rewrote the call after Storm's hook: when the call starts with other files than were held, those are held too, the whole tree when they cannot be named, and the director is told (reviewer question 1)", async () => {
			const { omp, main } = await heldEdit();
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1"]), main);
			// The files the call really writes (its final arguments at the start of execution) are other files than the held one.
			await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "e-1", args: { path: "a.txt", old_string: "a", new_string: "b" } }, main);
			// A worker whose lane declares a.txt is refused beside the call now (before, only d.txt was held).
			const placement = taskCall("A", "a-1");
			expect(verdict(await omp.emit("tool_call", placement, main))).toBe("lane-write");
			// The director reads it at its next request.
			const next = (await omp.emit("context", { messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }, main)) as { messages?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
			expect(JSON.stringify(next?.messages ?? [])).toContain(DIRECTOR_REWRITTEN.slice(0, 20));
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			expect(await holds(omp, main)).toBe(false);
			// A call whose final arguments cannot be named holds the whole tree.
			expect(verdict(await omp.emit("tool_call", edit("e-2", "d2.txt"), main))).toBe("pass");
			await omp.emit("message_end", assistantEnd("toolUse", ["e-2"]), main);
			await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "e-2", args: { path: "../outside.txt", old_string: "a", new_string: "b" } }, main);
			expect(verdict(await omp.emit("tool_call", taskCall("A", "a-2"), main))).toBe("lane-write");
			await omp.emit("turn_end", turnEndOf([{ id: "e-2" }]), main);
			await omp.emit("session_shutdown", {}, main);
		});

		test("the host's order, an unclean turn: the message's own end frees nothing, the turn's end keeps it, and the next completed message (other calls) ends it", async () => {
			const { omp, main } = await heldEdit();
			const refused = await refusal(omp, main, { toolName: "write", toolCallId: "e-2", input: { path: "vault://x.md", content: "x" } });
			expect(refused.code).toBe("director-edit");
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1", "e-2"]), main);
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "e-1" }, main);
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }, { id: "e-2", name: "write", error: true }]), main);
			expect(await holds(omp, main)).toBe(true);
			// The next request's message carries calls of its own: its hooks ran first, so its own hold (e-3) must survive its own end.
			expect(verdict(await omp.emit("tool_call", edit("e-3", "d3.txt"), main))).toBe("pass");
			await omp.emit("message_end", assistantEnd("toolUse", ["e-3"]), main);
			// e-1 is older than that message: gone. e-3 is that message's own: held.
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("turn_end", turnEndOf([{ id: "e-3" }]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF1: a recovered message_end arrives before this call's hook, an unclean turn keeps the hold seen, and the next completed answer ends it", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			// The host's Harmony recovery: the message that carries the call ends before the call's own pre-dispatch hook.
			await omp.emit("message_end", assistantEnd("toolUse", ["recovered"]), main);
			expect(verdict(await omp.emit("tool_call", edit("recovered", "e.txt"), main))).toBe("pass");
			await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "recovered", args: { path: "e.txt" } }, main);
			await omp.emit("tool_result", { ...edit("recovered"), isError: true, content: [] }, main);
			await omp.emit("turn_end", turnEndOf([{ id: "recovered", error: true }]), main);
			// The unclean turn keeps it; the next completed assistant answer ends it although its own hook came first.
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("message_end", assistantEnd("toolUse", ["next"]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF4-5: a 257-id message too wide to remember leaves its hold unseen; only a clean turn end naming it releases it", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			const ids = Array.from({ length: 257 }, (_, index) => `wide-${index}`);
			await omp.emit("message_end", assistantEnd("toolUse", ids), main);
			expect(verdict(await omp.emit("tool_call", edit(ids[0]!, "wide.txt"), main))).toBe("pass");
			await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: ids[0] }, main);
			await omp.emit("tool_result", { ...edit(ids[0]!), isError: true, content: [] }, main);
			await omp.emit("turn_end", turnEndOf([{ id: ids[0]!, error: true }]), main);
			expect(await holds(omp, main)).toBe(true);
			// RF4-5 corrects D7: a message too wide to remember whole records no ids, so this hold's own message end cannot
			// be matched and it is not treated as seen. An unrelated completed answer must not release it.
			await omp.emit("message_end", assistantEnd("stop"), main);
			expect(await holds(omp, main)).toBe(true);
			// The clean turn end that names the call is what releases it.
			await omp.emit("turn_end", turnEndOf([{ id: ids[0]! }]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF4-5: many small messages never overflow; a hold whose own message end was not delivered is not released by an unrelated end", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			// 257 completed messages, one call each, and none of them wide: the memory is scoped to a message and dropped at
			// its turn end, so nothing accumulates and no fallback is ever reached.
			for (let index = 0; index < 257; index++) await omp.emit("message_end", assistantEnd("toolUse", [`small-${index}`]), main);
			expect(verdict(await omp.emit("tool_call", edit("unseen"), main))).toBe("pass");
			expect(await holds(omp, main)).toBe(true);
			// The message that carried this call never had its `message_end` delivered, so an unrelated completed answer is
			// no evidence that the call's batch is over. The hold stays until a clean turn end names it.
			await omp.emit("message_end", assistantEnd("stop", ["not-the-edit"]), main);
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("turn_end", turnEndOf([{ id: "unseen" }]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF3-4: a call whose local memo was evicted is held on the whole tree and told when it starts as a project write", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			for (let index = 0; index < 257; index++) {
				expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: `local-${index}`, input: { path: "local://note", content: "test" } }, main))).toBe("pass");
			}
			// The first memo was evicted by the bound; the host's final arguments are a project write.
			await omp.emit("tool_execution_start", { toolName: "write", toolCallId: "local-0", args: { path: "a.txt", content: "test" } }, main);
			expect(verdict(await omp.emit("tool_call", taskCall("A", "after-rewrite"), main))).toBe("lane-write");
			const notice = await omp.emit("context", { messages: [] }, main);
			expect(JSON.stringify(notice)).toContain(DIRECTOR_REWRITTEN.slice(0, 20));
			await omp.emit("turn_end", turnEndOf([{ id: "local-0" }]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("RF4-6: 257 refused writes keep their refusal; the first blocked start makes no tree hold and no rewrite notice", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			const ids = Array.from({ length: 257 }, (_, index) => `refused-${index}`);
			const sshWrite = (toolCallId: string) => ({ toolName: "write", toolCallId, input: { path: "ssh://host/file", content: "x" } });
			for (const toolCallId of ids) expect(verdict(await omp.emit("tool_call", sshWrite(toolCallId), main))).toBe("director-edit");
			await omp.emit("message_end", assistantEnd("toolUse", ids), main);
			// The host reports a start for a call it blocked after Storm's hook: it was judged and refused, never rewritten,
			// so it neither holds the tree nor claims another extension changed it. A refusal is never evicted into that state.
			await omp.emit("tool_execution_start", { toolName: "write", toolCallId: ids[0], args: { path: "ssh://host/file", content: "x" } }, main);
			await omp.emit("turn_end", turnEndOf(ids.map(id => ({ id, name: "write", error: true }))), main);
			expect(await holds(omp, main)).toBe(false);
			expect(JSON.stringify(await omp.emit("context", { messages: [] }, main) ?? "")).not.toContain(DIRECTOR_REWRITTEN.slice(0, 20));
			await omp.emit("session_shutdown", {}, main);
		});


		test("RF3: a director write that is no file change is rewritten into a project path before it starts; it gets a hold and a notice at execution start", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "scratch", input: { path: "local://note", content: "text" } }, main))).toBe("pass");
			await omp.emit("message_end", assistantEnd("toolUse", ["scratch"]), main);
			// A later extension rewrote the same call into a write of a project file; the host's final arguments say so.
			await omp.emit("tool_execution_start", { toolName: "write", toolCallId: "scratch", args: { path: "a.txt", content: "text" } }, main);
			expect(verdict(await omp.emit("tool_call", taskCall("A", "unheld"), main))).toBe("lane-write");
			const notice = await omp.emit("context", { messages: [] }, main);
			expect(JSON.stringify(notice)).toContain(DIRECTOR_REWRITTEN.slice(0, 20));
			await omp.emit("turn_end", turnEndOf([{ id: "scratch" }]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("a job asked for by a later call of the same message, after the message's own message_end, still meets the hold", async () => {
			await approve({ ...TEAM, jobs: [{ name: "experiment", argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(path.join(project.tmp, "job-host-order"))}, "1")`] }] });
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [{ name: "experiment", kind: "run" as const, job: "experiment", results: [{ id: "experiment-outcome", kind: "answer" as const, criterion: "record the observed outcome", contains: "OK" }] }] });
			expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1", "j-1"]), main);
			const refused = await omp.toolReply({ action: "execute", lanes: ["experiment"] }, main);
			expect(refused.text).toContain("[storm:job-wait]");
			expect(existsSync(path.join(project.tmp, "job-host-order"))).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("a clean turn releases the holders whose ids it carries: two edits of one message end together, an edit of a later message does not", async () => {
			const { omp, main } = await heldEdit();
			expect(verdict(await omp.emit("tool_call", edit("e-2", "d2.txt"), main))).toBe("pass");
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			// e-2 belongs to another turn: still held.
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("turn_end", turnEndOf([{ id: "e-2" }]), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("an unclean turn keeps its holders until the next completed assistant message; an aborted or failed one does not release", async () => {
			const { omp, main } = await heldEdit();
			// A second edit of the message was refused: the turn is not clean (omp may still be committing what an aborted call wrote).
			const refused = await refusal(omp, main, { toolName: "write", toolCallId: "e-2", input: { path: "vault://x.md", content: "x" } });
			expect(refused.code).toBe("director-edit");
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1", "e-2"]), main);
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }, { id: "e-2", name: "write", error: true }]), main);
			expect(await holds(omp, main)).toBe(true);
			// Other messages and requests that did not complete prove nothing.
			await omp.emit("message_end", { message: { role: "user", content: [] } }, main);
			await omp.emit("message_end", { message: { role: "toolResult", toolCallId: "e-1", content: [] } }, main);
			await omp.emit("message_end", assistantEnd("aborted"), main);
			expect(await holds(omp, main)).toBe(true);
			await omp.emit("message_end", assistantEnd("error"), main);
			expect(await holds(omp, main)).toBe(true);
			// A completed request: the loop made it after the tool batch was over.
			await omp.emit("message_end", assistantEnd("toolUse"), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("each failed call of a message makes the turn unclean: an error result of the edit itself, or a call the host never ran", async () => {
			for (const failed of [{ id: "e-1", error: true }, { id: "e-1", missing: true }]) {
				const { omp, main } = await heldEdit();
				await omp.emit("message_end", assistantEnd("toolUse", ["e-1"]), main);
				const event = failed.missing === true ? { ...turnEndOf([{ id: "e-1" }]), toolResults: [] } : turnEndOf([failed]);
				await omp.emit("turn_end", event, main);
				expect(await holds(omp, main), JSON.stringify(failed)).toBe(true);
				await omp.emit("message_end", assistantEnd(), main);
				expect(await holds(omp, main), JSON.stringify(failed)).toBe(false);
				await omp.emit("session_shutdown", {}, main);
				await shutdownFakeSessions();
			}
		});

		test("the backstop: a completed assistant message releases every hold committed before it, whatever happened to the turn's own end", async () => {
			const { omp, main } = await heldEdit();
			expect(verdict(await omp.emit("tool_call", edit("e-2", "d2.txt"), main))).toBe("pass");
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1", "e-2"]), main);
			// The message's own end freed nothing: its calls are about to run.
			expect(await holds(omp, main)).toBe(true);
			// No `turn_end` ever came. The next request of the director ends in a message with no stop reason named: completed.
			await omp.emit("message_end", assistantEnd(), main);
			expect(await holds(omp, main)).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		/** An edit that the host started (or not) and whose result it did (or did not) report, then the conversation switches. */
		const switched = async (seen: { started: boolean; resulted: boolean }) => {
			const { omp, main } = await heldEdit();
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1"]), main);
			if (seen.started) await omp.emit("tool_execution_start", { toolName: "edit", toolCallId: "e-1" }, main);
			if (seen.resulted) await omp.emit("tool_result", { ...edit("e-1"), isError: true, content: [] }, main);
			const sessionDir = project.sessionDir;
			omp.setSessionId("session-after-the-switch");
			await omp.emit("session_switch", { reason: "new" }, main);
			return { omp, main, finalized: async () => (await lastRun(sessionDir))?.status === "stopped" && activeLedgerRun(sessionDir) === undefined };
		};

		test("a switch releases the hold of a call that never started: omp aborted the batch before it ran, so the run ends", async () => {
			const { omp, main, finalized } = await switched({ started: false, resulted: false });
			expect(await finalized()).toBe(true);
			await omp.emit("session_shutdown", {}, main);
		});

		test("a switch releases the hold of a call whose result was seen, aborted or not: it ended", async () => {
			const { omp, main, finalized } = await switched({ started: true, resulted: true });
			expect(await finalized()).toBe(true);
			await omp.emit("session_shutdown", {}, main);
		});

		test("a switch keeps the hold of a call that started and has no result: the run cannot finish, and the next completed message ends the wait", async () => {
			const { omp, main, finalized } = await switched({ started: true, resulted: false });
			// Fail closed: the host may still be committing what that call writes, and nothing else tells that it is not.
			// Twenty of the test host's drain looks pass while the hold stands; only the real clock can show it stayed.
			await Bun.sleep(100);
			expect(await finalized()).toBe(false);
			expect(activeLedgerRun(project.sessionDir)).toBeDefined();
			// The director's next completed answer (the loop made another request) ends the wait, and the run finishes at its next look.
			await omp.emit("message_end", assistantEnd("stop"), main);
			await until(finalized);
			expect(await lastRun(project.sessionDir)).toMatchObject({ status: "stopped", endReason: "shutdown" });
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);
	});

	describe("the hook's own time and what it computes", () => {
		/** A run with a worker that just settled and whose revoke the test holds back: any writer's hook waits for it. */
		const slowRevoke = async (lanes: object[], settle = "A") => {
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes, workers: { implementer: lanes.length } });
			const workers = new Map<string, ExtensionContext>();
			for (const lane of lanes as Array<{ name: string }>) workers.set(lane.name, await startWorker(omp, child, main, lane.name));
			const gate = Promise.withResolvers<void>();
			const real = revokeWorkerAdmissions;
			const slow = spyOn(admissionModule, "revokeWorkerAdmissions").mockImplementation(async (...args: Parameters<typeof real>) => {
				await gate.promise;
				return real(...args);
			});
			await child.emit("agent_end", {}, workers.get(settle) as ExtensionContext);
			await ended(omp, main, "task", `call-${settle}`);
			return { omp, main, gate, slow };
		};

		test("a commit that comes after the host's own limit for the hook is refused, and holds nothing", async () => {
			await approve(TEAM);
			const { omp, main, gate, slow } = await slowRevoke([writerLane("A", "a.txt")]);
			try {
				const t0 = Date.now();
				setSystemTime(new Date(t0));
				const waiting = omp.emit("tool_call", edit("e-1"), main);
				await Bun.sleep(50);
				// The host blocks a handler after 30 s; Storm's commit leaves a margin for its own answer.
				setSystemTime(new Date(t0 + 29_000));
				gate.resolve();
				const answer = (await waiting) as { block?: boolean; reason?: string };
				expect(verdict(answer)).toBe("director-write");
				expect(answer.reason).toContain(DIRECTOR_WRITE_LATE);
				expect(await holds(omp, main)).toBe(false);
				// The same edit sent again, in time, passes.
				expect(verdict(await omp.emit("tool_call", edit("e-2"), main))).toBe("pass");
			} finally {
				slow.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		});

		// The same four seconds of waiting: inside omp's default thirty, and past a configured five (less its margin).
		for (const [timeoutMs, expected] of [[undefined, "pass"], [5_000, "director-write"]] as const) {
			test(`the limit is the host's setting (${timeoutMs ?? "default 30000"} ms): a delay of four seconds is ${expected === "pass" ? "in time" : "too late"}`, async () => {
				await approve(TEAM);
				const { omp, main, gate, slow } = await slowRevoke([writerLane("A", "a.txt")]);
				try {
					const run = async (): Promise<string> => {
						const t0 = Date.now();
						setSystemTime(new Date(t0));
						const waiting = omp.emit("tool_call", edit("e-1"), main);
						await Bun.sleep(50);
						setSystemTime(new Date(t0 + 4_000));
						gate.resolve();
						return verdict(await waiting);
					};
					expect(await (timeoutMs === undefined ? run() : withActiveSettings(Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": timeoutMs }), run))).toBe(expected);
				} finally {
					slow.mockRestore();
				}
				await omp.emit("session_shutdown", {}, main);
			}, 20_000);
		}

		test("targets that changed during the lease wait are computed again: a link swapped to point outside the tree is refused, and holds nothing", async () => {
			await approve(TEAM);
			await mkdir(path.join(project.root, "inner"), { recursive: true });
			const outside = path.join(project.tmp, "outside-dir");
			await mkdir(outside, { recursive: true });
			await symlink("inner", path.join(project.root, "link"));
			const { omp, main, gate, slow } = await slowRevoke([writerLane("A", "a.txt")]);
			try {
				const waiting = omp.emit("tool_call", edit("e-1", "link/x.txt"), main);
				await Bun.sleep(50);
				await rm(path.join(project.root, "link"));
				await symlink(outside, path.join(project.root, "link"));
				gate.resolve();
				const answer = (await waiting) as { block?: boolean; reason?: string };
				expect(verdict(answer)).toBe("director-edit");
				expect(answer.reason).toContain(DIRECTOR_EDIT_LEAD);
				expect(await holds(omp, main)).toBe(false);
			} finally {
				slow.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("a link swapped to a name another worker holds meets that worker: the table holds what the call writes now", async () => {
			await pathOnlyImplementer();
			await approveShadows(TEAM);
			for (const dir of ["free", "held"]) await mkdir(path.join(project.root, dir), { recursive: true });
			await symlink("free", path.join(project.root, "link"));
			const lane = (name: string, file: string) => ({ name, kind: "code" as const, role: "implementer", files: [file], goal: `Write ${file}`, results: changeFor(`${name}-change`) });
			const { omp, main, gate, slow } = await slowRevoke([lane("A", "a.txt"), lane("B", "held")]);
			try {
				const waiting = omp.emit("tool_call", edit("e-1", "link/f.txt"), main);
				await Bun.sleep(50);
				await rm(path.join(project.root, "link"));
				await symlink("held", path.join(project.root, "link"));
				gate.resolve();
				const answer = (await waiting) as { block?: boolean; reason?: string };
				expect(verdict(answer)).toBe("director-write");
				expect(answer.reason).toContain(holderPhrase({ lane: "B", agentId: "B" }));
			} finally {
				slow.mockRestore();
			}
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		// Not observable from outside: a wait between the commit and the answer would let another writer start in the gap and the call
		// run beside it. The two places that could add one are read here, so a later edit that does fails this test.
		test("nothing awaits between the commit and the answer: the commit ends the director's branch and its wrapper makes no second wait", async () => {
			const source = await Bun.file(path.join(import.meta.dir, "..", "src", "extension.ts")).text();
			const branchAt = source.indexOf("const directorPathEdit = async");
			expect(branchAt).toBeGreaterThan(0);
			const branch = source.slice(branchAt, source.indexOf("const guardToolCall = async", branchAt));
			const commitAt = branch.indexOf("lanes.commitWriter(");
			expect(commitAt).toBeGreaterThan(0);
			expect(branch.slice(commitAt)).not.toMatch(/\bawait\b/);
			// Before it, in this order: the lease, the wait for withdrawn authority, and the targets computed again.
			const before = branch.slice(0, commitAt);
			const order = ["runs.ensureLease(", "settleEndRevokes(", "judge()"].map(step => before.lastIndexOf(step));
			expect(order.every(at => at > 0)).toBe(true);
			expect([...order].sort((a, b) => a - b)).toEqual(order);
			// The wrapper answers a committed call before its own wait for revokes.
			const wrapperAt = source.indexOf('pi.on("tool_call", async (event, ctx) => {');
			const wrapper = source.slice(wrapperAt, wrapperAt + 1_500);
			expect(wrapper.indexOf("committedHere.delete(")).toBeGreaterThan(0);
			expect(wrapper.indexOf("committedHere.delete(")).toBeLessThan(wrapper.indexOf("settleEndRevokes("));
		});

		test("a revoke that cannot land refuses the edit: a writer is not entered beside a worker whose authority could not be withdrawn", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [writerLane("A", "a.txt")], workers: { implementer: 1 } });
			const worker = await startWorker(omp, child, main, "A");
			const failing = spyOn(admissionModule, "revokeWorkerAdmissions").mockRejectedValue(new Error("store unreadable"));
			try {
				await child.emit("agent_end", {}, worker);
				await ended(omp, main, "task", "call-A");
				expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("revoke");
			} finally {
				failing.mockRestore();
			}
			// Nothing was held by the refused edit; once the record store answers, the next edit is entered.
			expect(await holds(omp, main)).toBe(false);
			expect(verdict(await omp.emit("tool_call", edit("e-2"), main))).toBe("pass");
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);
	});

	describe("the host processes Storm runs: a job and a required check, in both orders", () => {
		// Markers go outside the tree: a file the check wrote into it would move the very tree the verdict was bound to.
		const marker = (name: string): string => path.join(project.tmp, name);
		const started = async (name: string): Promise<boolean> => existsSync(marker(name));
		/** Polls with real sleeps: a tight loop of `setImmediate` starves the timers a check's runner waits on. */
		const eventually = async (done: () => Promise<boolean>): Promise<void> => {
			for (let tries = 0; tries < 400; tries++) {
				if (await done()) return;
				await Bun.sleep(25);
			}
			throw new Error("the condition never held");
		};
		/** A job that says it started, stays for `ms`, and answers its marker. */
		const slowJob = (ms: number) => ({ name: "experiment", argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker("job-started"))}, "1"); setTimeout(() => console.log("OK"), ${ms})`] });
		const jobPlan = {
			lanes: [{ name: "experiment", kind: "run" as const, job: "experiment", results: [{ id: "experiment-outcome", kind: "answer" as const, criterion: "record the observed outcome", contains: "OK" }] }],
		};

		test("an edit during a job is refused naming the job, and passes once the job ends", async () => {
			await approve({ ...TEAM, jobs: [slowJob(500)] });
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, jobPlan);
			const running = omp.toolReply({ action: "execute", lanes: ["experiment"] }, main);
			await until(() => started("job-started"));
			const refused = await refusal(omp, main, edit("e-1"));
			expect(refused.code).toBe("director-write");
			expect(refused.reason).toContain(holderPhrase({ kind: "job" }));
			expect((await running).outcome).toBe("ok");
			expect(verdict(await omp.emit("tool_call", edit("e-2"), main))).toBe("pass");
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("a job asked for while the director's edit is held does not start, and says the edit is what it waits for; it starts once the turn is over", async () => {
			await approve({ ...TEAM, jobs: [slowJob(100)] });
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, jobPlan);
			expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
			const refused = await omp.toolReply({ action: "execute", lanes: ["experiment"] }, main);
			expect(refused.text).toContain("[storm:job-wait]");
			expect(refused.text).toContain(DIRECTOR_EDIT_ENDS);
			expect(await started("job-started")).toBe(false);
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			expect((await omp.toolReply({ action: "execute", lanes: ["experiment"] }, main)).outcome).toBe("ok");
			expect(await started("job-started")).toBe(true);
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		/** A run whose next look runs the required check: a worker changed the tree and the reviewer's verdict on it is in. */
		const dueCheck = async (check: { name: string; argv: string[] }) => {
			await gitRepo(project.root);
			await approve({ ...TEAM, requiredChecks: [check] });
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.command("fix the file", main);
			const runId = activeLedgerRun(project.sessionDir)?.runId;
			admitChild(runId, "Impl");
			admitChild(runId, "Rev");
			const impl = child.ctx(sub("Impl"));
			const rev = child.ctx(sub("Rev", "storm-reviewer"));
			const at = Date.now();
			setSystemTime(new Date(at));
			await child.emit("before_agent_start", { systemPrompt: [] }, impl);
			await writeFile(path.join(project.root, ".keep"), "a change\n");
			await child.emit("tool_result", { toolName: "edit", input: { path: ".keep" }, isError: false, content: [] }, impl);
			await child.emit("before_agent_start", { systemPrompt: [] }, rev);
			setSystemTime(new Date(at + 1_000));
			await child.emit("tool_result", { toolName: "yield", input: { data: { overall_correctness: "correct" } }, isError: false, content: [] }, rev);
			await child.emit("agent_end", {}, rev);
			await child.emit("agent_end", {}, impl);
			return { omp, main, runId: runId as string };
		};
		const check = (ms: number) => ({ name: "unit", argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker("check-started"))}, "1"); setTimeout(() => {}, ${ms})`] });

		test("an edit while the required check runs is refused naming the check, and passes once it has ended", async () => {
			const { omp, main, runId } = await dueCheck(check(400));
			await omp.emit("agent_start", {}, main);
			const look = omp.emit("agent_end", {}, main);
			await eventually(() => started("check-started"));
			const refused = await refusal(omp, main, edit("e-1"));
			expect(refused.code).toBe("director-write");
			expect(refused.reason).toContain(holderPhrase({ kind: "check" }));
			await look;
			await eventually(async () => (await readRun(project.sessionDir, runId))?.endReason === "verified");
			expect(verdict(await omp.emit("tool_call", edit("e-2"), main))).toBe("pass");
			await omp.emit("session_shutdown", {}, main);
		}, 30_000);

		test("a look that finds the edit held runs no check and records nothing; the check runs at a look after the edit's turn", async () => {
			const { omp, main, runId } = await dueCheck(check(50));
			// The run's session is the one that edits: this edit is held until its message ends.
			expect(verdict(await omp.emit("tool_call", edit("e-1", "notes.txt"), main))).toBe("pass");
			await omp.emit("agent_start", {}, main);
			await omp.emit("agent_end", { willContinue: false }, main);
			// Several round looks (the test host's 10 ms delay) pass with the edit held; none may start the check.
			await Bun.sleep(100);
			expect(await started("check-started")).toBe(false);
			// The turn that made the edit ended: the next look asks again, and nothing was remembered as already looked at.
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			await omp.emit("agent_start", {}, main);
			await omp.emit("agent_end", {}, main);
			await eventually(() => started("check-started"));
			await eventually(async () => (await readRun(project.sessionDir, runId))?.endReason === "verified");
			await omp.emit("session_shutdown", {}, main);
		}, 30_000);

		test("a later look is guaranteed: the run's own round timer asks again, so the release of the edit's hold, the last host event, still ends in the skipped check (reviewer question 4)", async () => {
			const { omp, main, runId } = await dueCheck(check(50));
			expect(verdict(await omp.emit("tool_call", edit("e-1", "notes.txt"), main))).toBe("pass");
			await omp.emit("message_end", assistantEnd("toolUse", ["e-1"]), main);
			await omp.emit("agent_start", {}, main);
			await omp.emit("agent_end", { willContinue: false }, main);
			// Several round looks (the test host's 10 ms delay) pass with the edit held; none may start the check.
			await Bun.sleep(100);
			expect(await started("check-started")).toBe(false);
			// The last event of the idle run is the release: no `agent_start` or `agent_end` follows it.
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			await eventually(() => started("check-started"));
			await eventually(async () => (await readRun(project.sessionDir, runId))?.endReason === "verified");
			await omp.emit("session_shutdown", {}, main);
		}, 30_000);
	});

	describe("under automatic delegation", () => {
		test("a plan opens the director's own edits: refused before it as before, passed and ordered by the table during the run", async () => {
			await approve(TEAM);
			await enableAuto();
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.emit("session_start", {}, main);
			await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: [] }, main);
			// Before a plan nothing changes: no file is edited yet, with the supervisor's own cause.
			const before = await refusal(omp, main, edit("e-0"));
			expect(before.code).toBe("auto");
			expect(before.reason).toContain(SUPERVISOR_REASONS.toolEdits);
			expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "w-0", input: { path: "src/a.ts", content: "x" } }, main))).toBe("auto");
			expect((await omp.toolReply({ action: "plan", plan: { lanes: [fixLane] } }, main)).outcome).toBe("ok");
			// During the run: a command is still the team's; an edit is the director's to make when the table is free.
			expect(verdict(await omp.emit("tool_call", bash("b-1"), main))).toBe("auto");
			expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
			// It holds the tree: the lane's worker (a shell writer) is refused the place, with the director named.
			const task = { toolName: "task", toolCallId: "t-1", input: { agent: "storm-implementer", task: "fix" } };
			expect(verdict(await omp.emit("tool_call", task, main))).toBe("lane-write");
			expect(await reasonOf(omp, main, task)).toContain(DIRECTOR_EDITING);
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			const assigned = (await omp.emit("tool_call", { ...task, toolCallId: "t-2" }, main)) as { input: { name: string } };
			expect(assigned.input.name).toContain("-lane-1");
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", assigned.input.name), main))).toMatch(/^route:/);
			await child.emit("before_agent_start", { systemPrompt: [] }, child.ctx(sub(assigned.input.name)));
			// And now the worker holds it: the edit is refused naming the lane, not the director's own hold.
			const during = await refusal(omp, main, edit("e-2"));
			expect(during.code).toBe("director-write");
			expect(during.reason).toContain(`'${fixLane.name}' 레인`);
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("what the director is told: the instruction no longer says edits are the team's, the run contract names the edit rule", async () => {
			await approve({ ...TEAM, roles: { ...TEAM.roles, quick: { agent: "storm-quick", models: ["a/q"], workers: { min: 1, max: 1 } } } });
			await enableAuto();
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.emit("session_start", {}, main);
			const started = (await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: ["base"] }, main)) as { systemPrompt: string[] };
			const text = started.systemPrompt.slice(1).join("\n");
			expect(text).toContain("<storm-auto>");
			expect(text).not.toMatch(/Edits[^.]*are the team's/);
			expect(text).not.toMatch(/file changes belong/i);
			expect(text).toContain("edit/write");
			// What stays the team's is said: a command, eval and an MCP tool.
			expect(text).toMatch(/Shell, eval and MCP are the team's/);
			// The manual director's run contract carries the same rule as one constant, and not the old refusal.
			await omp.command("fix the file", main);
			const handoff = omp.sent.at(-1) ?? "";
			expect(handoff).toContain(DIRECTOR_EDIT_RULE);
			expect(handoff).not.toContain("your own file edits are blocked");
			await omp.emit("session_shutdown", {}, main);
		});
	});

	describe("the result contract in the assignment", () => {
		const resultLane = (name: string, over: Record<string, unknown> = {}) => ({
			name,
			kind: "code" as const,
			role: "implementer",
			files: [`${name}.txt`],
			goal: `Write ${name}.txt`,
			results: [{ id: `${name}-change`, kind: "change" as const, criterion: `${name}.txt holds the new text`, contains: "new text" }],
			...over,
		});

		test("a task item of a lane with declared results carries the lane's block after its own text; a lane with none carries nothing", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, {
				lanes: [resultLane("A"), { name: "R0", kind: "review", role: "reviewer", goal: "Review the tree" }],
				workers: { implementer: 1, reviewer: 1 },
			});
			const placed = (await omp.emit("tool_call", taskCall("A", "a-1"), main)) as { input: { task: string; name: string } };
			expect(placed.input.task.startsWith("work A\n\n")).toBe(true);
			expect(placed.input.task).toContain(CONTRACT_TAG);
			expect(placed.input.task).toContain("A-change");
			expect(placed.input.task).toContain("A.txt");
			// The text the worker's result is judged by is the lane's own: nothing of another lane's.
			expect(placed.input.task).not.toContain("R0");
			await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "a-1", isError: true }, main);
			// A review lane declares no results: its task goes out as the director wrote it.
			const review = await omp.emit("tool_call", taskCall("R0", "r-1", "storm-reviewer"), main);
			expect(review === undefined || !String((review as { input?: { task?: unknown } }).input?.task ?? "").includes(CONTRACT_TAG)).toBe(true);
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("an item with steps carries the block on its first step, where omp sends it to the worker, and no task text is invented", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes: [resultLane("A")], workers: { implementer: 1 } });
			const answer = (await omp.emit("tool_call", { toolName: "task", toolCallId: "a-1", input: { agent: "storm-implementer", name: "A", steps: ["first step", "second step"] } }, main)) as { input: { steps: string[]; task?: string } };
			expect(answer.input.steps[0]?.startsWith("first step\n\n")).toBe(true);
			expect(answer.input.steps[0]).toContain(CONTRACT_TAG);
			expect(answer.input.steps[1]).toBe("second step");
			expect(answer.input).not.toHaveProperty("task");
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("each item of a mixed batch carries its own lane's block: the shared item's files, the isolated item's own checkout", async () => {
			await approve(TEAM);
			installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": false });
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, {
				lanes: [resultLane("core"), resultLane("probe", { files: undefined, isolationReason: "keep the experimental result outside the tree" }), { name: "look", kind: "explore", role: "explorer", goal: "Read", results: answerFor("look-answer") }],
				workers: { implementer: 2, explorer: 1 },
			});
			const batch = (await omp.emit("tool_call", {
				toolName: "task",
				toolCallId: "batch-1",
				input: {
					tasks: [
						{ agent: "storm-implementer", name: "core", task: "work core" },
						{ agent: "storm-implementer", name: "probe", task: "work probe" },
						{ agent: "storm-explorer", name: "look", task: "look around" },
					],
				},
			}, main)) as { input: { tasks: Array<{ name: string; task: string }> } };
			const [core, probe, look] = batch.input.tasks;
			expect(core?.task).toContain("core-change");
			expect(core?.task).toContain("core.txt");
			expect(core?.task).not.toContain(ISOLATED_SCOPE);
			expect(probe?.task).toContain("probe-change");
			expect(probe?.task).toContain(ISOLATED_SCOPE);
			// The third item's block is its own: an answer, with no write scope of a writer in it.
			expect(look?.task).toContain("look-answer");
			expect(look?.task).not.toContain("core-change");
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("a work follow-up carries the block again only when the worker has not been sent the current one", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			// A review lane declares no results, so its worker is sent no contract with its assignment.
			const lane = { name: "R0", kind: "review" as const, role: "reviewer", goal: "Review the tree" };
			await openRun(omp, main, { lanes: [lane], workers: { reviewer: 1 } });
			const worker = await startWorker(omp, child, main, "R0", "call-R0", "storm-reviewer");
			await child.emit("agent_end", {}, worker);
			await ended(omp, main, "task", "call-R0");
			const followUp = async (callId: string, over: { isError?: boolean; progress?: boolean } = {}): Promise<string> => {
				const call = { toolName: "write", toolCallId: callId, input: { path: `agent://R0${over.progress === true ? "?progress" : ""}`, content: "more work" } };
				const answer = (await omp.emit("tool_call", call, main)) as { input?: { content?: string }; block?: boolean; reason?: string } | undefined;
				expect(answer?.block, answer?.reason).not.toBe(true);
				const content = answer?.input?.content ?? "more work";
				const sent = { ...call, input: { ...call.input, content } };
				await omp.emit("tool_result", { ...sent, isError: over.isError === true, content: [] }, main);
				if (over.progress !== true) {
					await child.emit("agent_start", {}, worker);
					await child.emit("agent_end", {}, worker);
				}
				await ended(omp, main, "write", callId);
				return content;
			};
			// No contract, nothing to repeat.
			expect(await followUp("f-1")).toBe("more work");
			// A replan gives the lane its first results: the worker has not been sent them.
			expect(await omp.tool({ action: "plan", plan: { lanes: [{ ...lane, results: answerFor("r0-answer") }], workers: { reviewer: 1 } } }, main)).toBe("ok");
			// A quiet progress note is no work: it carries nothing.
			expect(await followUp("f-quiet", { progress: true })).toBe("more work");
			// The first work follow-up after it carries the block; a delivery that failed does not count as sent.
			const carried = await followUp("f-2", { isError: true });
			expect(carried.startsWith("more work\n\n")).toBe(true);
			expect(carried).toContain(CONTRACT_TAG);
			expect(carried).toContain("r0-answer");
			expect(await followUp("f-3")).toContain(CONTRACT_TAG);
			// Delivered: the next one repeats nothing.
			expect(await followUp("f-4")).toBe("more work");
			await omp.emit("session_shutdown", {}, main);
		}, 30_000);
	});

	describe("the follow-up of a worker that was sent its contract", () => {
		test("a work follow-up to a worker that got the block with its assignment repeats nothing", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			const lane = { name: "A", kind: "code" as const, role: "implementer", files: ["a.txt"], goal: "Write a.txt", results: changeFor("A-change") };
			await openRun(omp, main, { lanes: [lane], workers: { implementer: 1 } });
			const placed = (await omp.emit("tool_call", taskCall("A", "a-1"), main)) as { input: { task: string; name: string } };
			expect(placed.input.task).toContain(CONTRACT_TAG);
			expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", "A"), main))).toMatch(/^route:/);
			const worker = child.ctx(sub("A"));
			await child.emit("before_agent_start", { systemPrompt: [] }, worker);
			await child.emit("agent_end", {}, worker);
			await ended(omp, main, "task", "a-1");
			// Sent with the assignment: the content is passed on as the director wrote it; only the lane's address is
			// rewritten to the exact host handle this run placed (A1-5).
			const follow = (await omp.emit("tool_call", { toolName: "write", toolCallId: "f-1", input: { path: "agent://A", content: "also fix the header" } }, main)) as { input?: { path?: string; content?: string } } | undefined;
			expect(follow?.input?.path).toBe(`agent://${placed.input.name}`);
			expect(follow?.input?.content).toBe("also fix the header");
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);
	});

	describe("read lanes with a shell", () => {
		/** An approved project definition of the explorer whose tools list a shell: the only way a read lane gets one. */
		const shellExplorer = async (): Promise<void> => {
			const dir = path.join(project.root, ".omp", "agents");
			await mkdir(dir, { recursive: true });
			await writeFile(path.join(dir, "storm-explorer.md"), "---\nname: storm-explorer\ndescription: reads and runs commands\ntools: read, grep, find, bash\n---\nRead the project and run read commands.\n");
			await approveShadows(TEAM);
		};
		const lanes = [
			{ name: "E0", kind: "explore", role: "explorer", goal: "Read the tree", results: answerFor("e0-answer") },
			writerLane("W0", "a.txt"),
		];

		test("the plan reply says any read lane with a shell runs with the writers, in words that are not the reviewer's", async () => {
			await shellExplorer();
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.command("manual task", main);
			const reply = await omp.toolReply({ action: "plan", plan: { lanes, workers: { explorer: 1, implementer: 1 } } }, main);
			expect(reply.outcome).toBe("ok");
			const order = reply.text.split("\n").find(line => line.startsWith("- 쓰기 순서"));
			expect(order).toBeDefined();
			expect(order).toContain("E0");
			expect(order).toContain(WHY_SHELL_READER);
			expect(order).not.toContain(WHY_SHELL_REVIEWER);
			await omp.emit("session_shutdown", {}, main);
		});

		test("without the shell in its definition the same lane is a plain reader: no order line, and it runs beside a writer", async () => {
			await approve(TEAM);
			const omp = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await omp.command("manual task", main);
			const reply = await omp.toolReply({ action: "plan", plan: { lanes, workers: { explorer: 1, implementer: 1 } } }, main);
			expect(reply.text.split("\n").some(line => line.includes("E0") && line.startsWith("- 쓰기 순서"))).toBe(false);
			await omp.emit("session_shutdown", {}, main);
		});

		test("its shell passes; starting a named service and every path write are refused as for the reviewer; the reason names a read lane", async () => {
			await shellExplorer();
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes, workers: { explorer: 1, implementer: 1 } });
			const worker = await startWorker(omp, child, main, "E0", "call-E0", "storm-explorer");
			const run = (toolName: string, input: unknown) => child.emit("tool_call", { toolName, toolCallId: `w-${++probes}`, input }, worker);
			expect(verdict(await run("bash", { command: "git log -1" }))).toBe("pass");
			expect(verdict(await run("read", { path: "a.txt" }))).toBe("pass");
			// A service lives in omp's daemon, beyond this worker's turn: refused as for any worker ordered like a writer.
			expect(verdict(await run("bash", { command: "npm run dev", name: "dev" }))).toBe("lane-service");
			// A path write, an eval cell and a nested task are not what a read lane may do.
			for (const [tool, input] of [["edit", { path: "a.txt", old_string: "a", new_string: "b" }], ["write", { path: "a.txt", content: "x" }], ["eval", { code: "1" }], ["task", { agent: "storm-implementer", task: "x" }]] as const) {
				expect(verdict(await run(tool, input)), tool).toMatch(/^lane-(capability|nested)$/);
			}
			const refused = (await run("write", { path: "a.txt", content: "x" })) as { reason: string };
			expect(refused.reason).toContain("읽기와 셸 실행만");
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);

		test("it is ordered like a writer in both directions: a writer is refused while it runs, and it is refused while a writer or the director's edit holds the tree", async () => {
			await shellExplorer();
			const omp = fakeOmp(project);
			const child = fakeOmp(project);
			const main = omp.ctx(MAIN);
			await openRun(omp, main, { lanes, workers: { explorer: 1, implementer: 1 } });
			// The director's edit holds the tree: the shell reader is refused, naming the edit.
			expect(verdict(await omp.emit("tool_call", edit("e-1"), main))).toBe("pass");
			const blocked = taskCall("E0", "t-1", "storm-explorer");
			expect(verdict(await omp.emit("tool_call", blocked, main))).toBe("lane-write");
			expect(await reasonOf(omp, main, blocked)).toContain(DIRECTOR_EDITING);
			await omp.emit("turn_end", turnEndOf([{ id: "e-1" }]), main);
			// It runs; the writer lane is refused, naming the reader and why.
			await startWorker(omp, child, main, "E0", "call-E0", "storm-explorer");
			const writer = taskCall("W0", "t-2");
			expect(verdict(await omp.emit("tool_call", writer, main))).toBe("lane-write");
			expect(await reasonOf(omp, main, writer)).toContain("'E0' 레인");
			// And the director's own edit is refused beside it.
			const refused = await refusal(omp, main, edit("e-2"));
			expect(refused.code).toBe("director-write");
			expect(refused.reason).toContain(holderPhrase({ lane: "E0", agentId: "E0" }));
			await omp.emit("session_shutdown", {}, main);
		}, 20_000);
	});
});

describe("phase 3 through the hooks: the plan-less team", () => {
	const call = (id: string, input: Record<string, unknown>) => ({ toolName: "task", toolCallId: id, input });
	const recordOf = (value: unknown): Record<string, unknown> => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
		return value as Record<string, unknown>;
	};
	/** The host's final input of a placed `task` call. */
	const placedInput = (answer: unknown): Record<string, unknown> => {
		if (typeof answer !== "object" || answer === null || !("input" in answer)) throw new Error("the task call was not placed");
		return recordOf(answer.input);
	};
	const handleOf = (answer: unknown): string => {
		const handle = placedInput(answer).name;
		if (typeof handle !== "string" || handle === "") throw new Error("the placement carried no handle");
		return handle;
	};
	const enterAutoTurn = async (omp: ReturnType<typeof fakeOmp>, main: ExtensionContext, prompt = "fix the login bug"): Promise<void> => {
		await omp.emit("session_start", {}, main);
		await omp.emit("before_agent_start", { reason: "prompt", prompt, systemPrompt: [] }, main);
	};

	test("a follow-up addressed to a lane is sent to the exact handle this run placed (A1-5)", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("fix the bug", main);
		await applyRunPlan(omp, main, { lanes: [{ ...fixLane }] });
		const placed = (await omp.emit("tool_call", { toolName: "task", toolCallId: "task-1", input: { agent: "storm-implementer", name: "fix", task: "fix it" } }, main)) as { input: { name: string } };
		const handle = placed.input.name;
		expect(handle).not.toBe("fix");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", handle), main))).toMatch(/^route:/);
		await child.emit("before_agent_start", { systemPrompt: [] }, child.ctx(sub(handle)));
		const follow = (await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-1", input: { path: "agent://fix?progress", content: "status" } }, main)) as { input?: { path?: string } } | undefined;
		expect(follow?.input?.path).toBe(`agent://${handle}?progress`);
		// A direct handle is left exactly as the director typed it.
		const direct = await omp.emit("tool_call", { toolName: "write", toolCallId: "follow-2", input: { path: `agent://${handle}`, content: "more" } }, main);
		expect(direct).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("a reader cannot take a writer's place: a foreign key is refused and its placement stays pending", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await enterAutoTurn(omp, main);
		// One plan-less batch, the caller's two items share a name: R4 gives each its own generated handle.
		const answer = await omp.emit("tool_call", call("open", {
			tasks: [
				{ agent: "storm-explorer", name: "same", task: "read" },
				{ agent: "storm-implementer", name: "same", task: "write" },
			],
		}), main);
		const items = placedInput(answer).tasks;
		if (!Array.isArray(items) || items.length !== 2) throw new Error("the batch was not placed");
		const readerKey = String(recordOf(items[0]).name);
		const writerKey = String(recordOf(items[1]).name);
		expect(readerKey).not.toBe(writerKey);
		// The reader's spawn under the writer's key would bind the writer's place. R4 refuses it, and the writer's
		// placement is still there for its own spawn.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", writerKey), main))).toBe("internal");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", writerKey), main))).toMatch(/^route:/);
		// The reader still starts under its own key; a repeated key is nobody's pending placement any more.
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", readerKey), main))).toMatch(/^route:/);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-explorer", readerKey), main))).toBe("internal");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a spawn key of an earlier run is refused in the next run", async () => {
		await approve(TEAM);
		const first = fakeOmp(project);
		const main = first.ctx(MAIN);
		await first.command("first request", main);
		await applyRunPlan(first, main, { lanes: [{ ...fixLane, name: "old" }], workers: { implementer: 1 } });
		const oldRun = activeLedgerRun(project.sessionDir)?.runId;
		expect(oldRun).toBeDefined();
		await first.emit("session_shutdown", {}, main);
		await until(async () => (await lastRun(project.sessionDir))?.runId === oldRun);

		const second = fakeOmp(project);
		const main2 = second.ctx(MAIN);
		await second.command("second request", main2);
		// No plan in the next run: the earlier run's key is nobody's placement, so R4 refuses it instead of routing it.
		const newRun = activeLedgerRun(project.sessionDir)?.runId;
		expect(newRun).not.toBe(oldRun);
		expect((await readRun(project.sessionDir, newRun as string))?.plan).toBeUndefined();
		expect(verdict(await second.emit("before_subagent_spawn", spawnOf("storm-implementer", "old"), main2))).toBe("internal");
		// The next run's own placed item is admitted under its generated handle.
		const placed = (await second.emit("tool_call", call("new-1", { agent: "storm-implementer", name: "new", task: "work" }), main2)) as { input: Record<string, unknown> };
		const handle = String(placed.input.name);
		expect(handle).not.toBe("new");
		expect(verdict(await second.emit("before_subagent_spawn", spawnOf("storm-implementer", handle), main2))).toMatch(/^route:/);
		await second.emit("session_shutdown", {}, main2);
	});

	test("a follow-up to an earlier run's unplanned handle is refused before the host can wake it (B2)", async () => {
		await approve(TEAM);
		await enableAuto();
		const first = fakeOmp(project);
		const main = first.ctx(MAIN);
		await enterAutoTurn(first, main);
		const placedOld = await first.emit("tool_call", call("old-task", { agent: "storm-explorer", name: "old", task: "read" }), main);
		if (verdict(placedOld) !== "pass") {
			const shown = await first.emit("tool_result", { ...call("old-task", {}), input: placedInput(placedOld), isError: true, content: [], details: {} }, main);
			throw new Error(JSON.stringify(shown));
		}
		const old = placedName(placedOld, "old");
		expect(verdict(await first.emit("before_subagent_spawn", spawnOf("storm-explorer", old), main))).toMatch(/^route:/);
		const admission = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: MAIN.id, childId: old });
		expect(admission.kind).toBe("record");
		await first.emit("session_shutdown", {}, main);
		await until(async () => (await lastRun(project.sessionDir))?.endedAt !== undefined);
		const next = fakeOmp(project);
		const mainNext = next.ctx(MAIN);
		await enterAutoTurn(next, mainNext);
		expect(verdict(await next.emit("tool_call", call("new-task", { agent: "storm-explorer", name: "new", task: "read" }), mainNext))).not.toBe("block");
		const follow = await next.emit("tool_call", { toolName: "write", toolCallId: "follow", input: { path: `agent://${old}`, content: "read again" } }, mainNext);
		expect(verdict(follow)).toBe("lane");
		expect(String((follow as { reason?: string }).reason)).toContain("이전 실행에서 계획 없이");
		const after = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: MAIN.id, childId: old });
		expect(after.kind).toBe("record");
		if (after.kind === "record") expect(after.record.runId).not.toBe(activeLedgerRun(project.sessionDir)?.runId);
		await next.emit("session_shutdown", {}, mainNext);
	});

	test("a refused plan-less batch opens no run, no lease and no marker; one safe item then opens it", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await enterAutoTurn(omp, main);
		const refused = await omp.emit("tool_call", call("bad", {
			tasks: [
				{ agent: "storm-implementer", name: "a", task: "write a" },
				{ agent: "storm-implementer", name: "b", task: "write b" },
			],
		}), main);
		// A refused task call is carried into omp's own rejection (task-refusal.ts), never a plain block.
		expect(verdict(refused)).toBe("lane-write");
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();
		expect(await lastRun(project.sessionDir)).toBeUndefined();
		// The same turn's next call is a safe reader batch: the run opens with the read lease and the batch is placed.
		const opened = await omp.emit("tool_call", call("good", { agent: "storm-explorer", name: "look", task: "read" }), main);
		expect(opened).not.toHaveProperty("block");
		expect(activeLedgerRun(project.sessionDir)?.runId).toBeDefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("a plan-less opening whose user turn ended while the handler waited commits nothing (A2-2)", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await enterAutoTurn(omp, main);
		const pending = omp.emit("tool_call", call("late", { agent: "storm-implementer", name: "fix", task: "fix the bug" }), main);
		// The user's turn ends while the call is between its first check and its commit.
		await omp.emit("agent_end", {}, main);
		const answer = await pending;
		const refused = (answer as { input?: Record<string, unknown> } | undefined)?.input;
		expect(refused?.schema).toBe("storm-refused:refused");
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();
		expect(await lastRun(project.sessionDir)).toBeUndefined();
		expect(omp.sent).toEqual([]);
		const shown = (await omp.emit("tool_result", { ...call("late", {}), isError: true, input: refused ?? {}, content: [], details: {} }, main)) as { content?: Array<{ text?: string }> };
		expect(shown?.content?.[0]?.text ?? "").toContain("사용자 요청이 끝난 뒤");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a plan-less run opens at the first task call; after a stop at or after the prompt the same turn opens nothing, a new prompt does", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 0.1, onExceed: "stop" } });
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.emit("session_start", {}, main);
		// A run of this session and target stops on the user's budget limit.
		await omp.command("first request", main);
		await omp.emit("agent_start", {}, main);
		await omp.emit("message_end", assistant("m", "main", 1_000, 0.25), main);
		await omp.emit("agent_end", {}, main);
		await until(async () => (await lastRun(project.sessionDir)) !== undefined);
		const sentBefore = omp.sent.length;
		const stoppedAt = lastRunEndAt((await loadProjectState(project.env)).sessionDir, project.root);
		if (stoppedAt === undefined) throw new Error("the stopped run left no end time");
		expect(stoppedAt).toBeGreaterThan(0);
		// R9: a prompt whose turn began at or before that stop cannot open a run, whatever the model sends next.
		setSystemTime(new Date(stoppedAt - 1_000));
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "try again", systemPrompt: [] }, main);
		const refused = await omp.emit("tool_call", call("t2", { agent: "storm-explorer", name: "look", task: "look" }), main);
		expect(verdict(refused)).toBe("auto");
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();
		// The refusal's words reach the director as that call's own result.
		const shown = (await omp.emit("tool_result", { ...call("t2", {}), isError: true, input: placedInput(refused), content: [], details: {} }, main)) as { content?: Array<{ text?: string }> };
		expect(shown?.content?.[0]?.text ?? "").toContain(PLANLESS_SAME_TURN);
		// The refused turn ends; the user speaks again after the stop and the plan-less run opens at its first task call.
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		setSystemTime(new Date(stoppedAt + 1_000));
		await omp.emit("before_agent_start", { reason: "prompt", prompt: "fix the login bug", systemPrompt: [] }, main);
		const opened = await omp.emit("tool_call", call("t3", { agent: "storm-implementer", name: "fix", task: "fix the bug" }), main);
		const handle = handleOf(opened);
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		expect(runId).toBeDefined();
		expect(await readRun(project.sessionDir, runId)).toMatchObject({ status: "running", request: "fix the login bug" });
		expect((await readRun(project.sessionDir, runId))?.plan).toBeUndefined();
		// The in-flight turn is the run's first round: no handoff was sent.
		expect(omp.sent).toHaveLength(sentBefore);
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", handle), main))).toMatch(/^route:/);
		await omp.emit("session_shutdown", {}, main);
	});

	test("an unplanned writer may write only while its admission carries a hold; a follow-up gets a fresh one", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await enterAutoTurn(omp, main);
		const handle = handleOf(await omp.emit("tool_call", call("t1", { agent: "storm-implementer", name: "fix", task: "fix" }), main));
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", handle), main))).toMatch(/^route:/);
		const worker = child.ctx(sub(handle));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		expect(verdict(await child.emit("tool_call", { toolName: "write", toolCallId: "w-1", input: { path: "one.txt", content: "1" } }, worker))).toBe("pass");
		await child.emit("agent_end", {}, worker);
		// Its turn ended: the admission is closed, and the same write has no place behind it.
		expect(verdict(await child.emit("tool_call", { toolName: "write", toolCallId: "w-2", input: { path: "one.txt", content: "2" } }, worker))).toBe("authority");
		// R7: a work follow-up re-admits the worker with a new hold; the woken turn writes again.
		expect(verdict(await omp.emit("tool_call", { toolName: "write", toolCallId: "f-1", input: { path: `agent://${handle}`, content: "write again" } }, main))).toBe("pass");
		const read = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: handle });
		expect(read.kind).toBe("record");
		if (read.kind === "record") expect(read.record.hold).toBe(`spawn:${handle}`);
		await child.emit("agent_start", {}, worker);
		expect(verdict(await child.emit("tool_call", { toolName: "write", toolCallId: "w-3", input: { path: "one.txt", content: "3" } }, worker))).toBe("pass");
		await omp.emit("session_shutdown", {}, main);
	});

	test("an unplanned isolated worker runs beside another writer, shell included, inside its own checkout", async () => {
		await approve(TEAM);
		installOmpSettings({ "task.isolation.enabled": true, "task.isolation.apply": false });
		await enableAuto();
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await enterAutoTurn(omp, main);
		const writer = handleOf(await omp.emit("tool_call", call("t1", { agent: "storm-implementer", name: "shared", task: "write" }), main));
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", writer), main))).toMatch(/^route:/);
		await child.emit("before_agent_start", { systemPrompt: [] }, child.ctx(sub(writer)));
		// D10: while that writer holds the tree, an isolated implementer (a shell among its tools) is placed private.
		const isolated = handleOf(await omp.emit("tool_call", call("t2", { agent: "storm-implementer", name: "experiment", task: "try", isolated: true }), main));
		expect(isolated).not.toBe("experiment");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", isolated), main))).toMatch(/^route:/);
		const checkout = path.join(project.tmp, "p3-checkout");
		await mkdir(checkout, { recursive: true });
		const base = child.ctx(sub(isolated));
		const worker = { ...base, cwd: checkout } as ExtensionContext;
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		expect(verdict(await child.emit("tool_call", { toolName: "bash", toolCallId: "b-1", input: { command: "git status" } }, worker))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "write", toolCallId: "w-1", input: { path: "inside.txt", content: "x" } }, worker))).toBe("pass");
		expect(verdict(await child.emit("tool_call", { toolName: "write", toolCallId: "w-2", input: { path: path.join(project.root, "outside.txt"), content: "x" } }, worker))).toBe("lane-scope");
		await omp.emit("session_shutdown", {}, main);
	});

	test("an isolated item that carries eval-defined tools of its own is refused before any run opens", async () => {
		await approve(TEAM);
		await enableAuto();
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await enterAutoTurn(omp, main);
		const refused = await omp.emit("tool_call", call("tools", {
			agent: "storm-implementer",
			name: "experiment",
			task: "try",
			isolated: true,
			tools: ["my_tool"],
		}), main);
		expect(verdict(refused)).toBe("isolation");
		expect(activeLedgerRun(project.sessionDir)).toBeUndefined();
		await omp.emit("session_shutdown", {}, main);
	});

	test("the spend stop reaches a running worker's waking message and its next request, and says it was not the user", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 0.1, onExceed: "stop" } });
		await enableAuto();
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await enterAutoTurn(omp, main);
		const handle = handleOf(await omp.emit("tool_call", call("t1", { agent: "storm-implementer", name: "fix", task: "fix" }), main));
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-implementer", handle), main))).toMatch(/^route:/);
		const worker = child.ctx(sub(handle));
		await child.emit("before_agent_start", { systemPrompt: [] }, worker);
		// The worker's spend crosses the user's stop limit while its turn runs.
		await child.emit("message_end", assistant("a", "i", 1_000, 0.25), worker);
		// The stopped turn ends: the run stops on budget and the close stays on disk.
		await child.emit("agent_end", {}, worker);
		await omp.emit("agent_end", {}, main);
		await until(async () => (await lastRun(project.sessionDir)) !== undefined);
		// R15: the guard reads the close from disk. A waking send is refused; even a read would be under `stop`.
		const send = await child.emit("tool_call", { toolName: "write", toolCallId: "send-1", input: { path: "agent://peer", content: "more" } }, worker);
		expect(verdict(send)).toBe("spend");
		expect(String(recordOf(send).reason)).toContain(SPEND_TAG);
		expect(String(recordOf(send).reason)).toContain(SPEND_CLOSED_LEAD);
		// The next request is not sent: the hook aborts the child's turn.
		let aborts = 0;
		const aborting = { ...worker, abort: () => { aborts += 1; } } as ExtensionContext;
		await child.emit("before_provider_request", {}, aborting);
		expect(aborts).toBe(1);
		await omp.emit("session_shutdown", {}, main);
	});

	test("no quick-only verdict after a director edit: the quick change is not credited to the cheap role", async () => {
		await approve({ ...TEAM, roles: { ...TEAM.roles, quick: { agent: "storm-quick", models: ["a/q"], workers: { min: 1, max: 1 } } } });
		const omp = fakeOmp(project);
		const child = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("quick change", main);
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		const sentBefore = omp.sent.length;
		// A review lane with no declared results is the only plan lane; the quick worker that changes the tree is an
		// admitted team worker outside the plan, so no implementer is on the run.
		await applyRunPlan(omp, main, { lanes: [{ name: "check", kind: "review", role: "reviewer" }], workers: { reviewer: 1 } });
		expect(verdict(await omp.emit("tool_call", call("r-1", { agent: "storm-reviewer", name: "check", task: "check" }), main))).toBe("pass");
		expect(verdict(await omp.emit("before_subagent_spawn", spawnOf("storm-reviewer", "check"), main))).toMatch(/^route:/);
		const reviewer = child.ctx(sub("check", "storm-reviewer"));
		await child.emit("before_agent_start", { systemPrompt: [] }, reviewer);
		// One request makes the lane's agent count as work, not as a launch that never started.
		await child.emit("message_end", assistant("b", "r", 1_000, 0), reviewer);
		await child.emit("agent_end", {}, reviewer);
		await omp.emit("tool_execution_end", { toolName: "task", toolCallId: "r-1", isError: false }, main);
		// The quick worker's change is observed on its own turn; it was not spawned through the plan.
		admitChild(runId, "Q");
		const quick = child.ctx(sub("Q", "storm-quick"));
		await child.emit("before_agent_start", { systemPrompt: [] }, quick);
		await child.emit("tool_result", { toolName: "write", input: { path: "q.txt" }, isError: false, content: [] }, quick);
		await child.emit("agent_end", {}, quick);
		// The director also edits a project file. R10 says the quick role may not take the credit for that change.
		expect(verdict(await omp.emit("tool_call", { toolName: "edit", toolCallId: "d-1", input: { path: "d.txt" } }, main))).toBe("pass");
		await omp.emit("turn_end", {
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "d-1", name: "edit", arguments: {} }] },
			toolResults: [{ role: "toolResult", toolCallId: "d-1", toolName: "edit", isError: false, content: [] }],
		}, main);
		await omp.emit("agent_start", {}, main);
		await omp.emit("agent_end", {}, main);
		// Before the controller passes the fact to the gate the run ends `unreviewed` (quick-only). After it, the run
		// either asks for the integrated review (a new round message) or ends for that reason; neither is `unreviewed`.
		await until(async () => (await lastRun(project.sessionDir)) !== undefined || omp.sent.length > sentBefore);
		expect((await lastRun(project.sessionDir))?.endReason).not.toBe("unreviewed");
		await omp.emit("session_shutdown", {}, main);
	}, 20_000);
});

/**
 * The per-session decision section: the recount of who is running, the decision, the reservation of a place and the
 * record of a refusal stay strictly one at a time, while the admission write (which is not a decision) must not hold
 * the next spawn. These tests park admission writes on a barrier, never on a sleep, and read what the hooks decided
 * while they were parked. A section that still holds the write makes a wait below never settle: the test then fails
 * on the runner's own bound rather than on a clock the test guessed.
 */
describe("the spawn decision section: the last place is taken once, and nothing else waits behind it", () => {
	const N = 6;
	const readerLanes = Array.from({ length: N }, (_, index) => ({
		name: `R${index}`,
		kind: "explore" as const,
		role: "explorer" as const,
		goal: `Read ${index}`,
		results: answerFor(`r${index}-answer`),
	}));

	/**
	 * Parks every admission write until `release`; `arrived` settles when the `target`-th write enters, so a test can
	 * wait for the last admission without polling. A call that enters after the release is not parked.
	 */
	const parkAdmissions = (target: number): { entered: string[]; arrived: Promise<void>; release: () => void; restore: () => void } => {
		const real = admissionModule.persistWorkerAdmission;
		const entered: string[] = [];
		const open: Array<() => void> = [];
		const arrived = Promise.withResolvers<void>();
		let released = false;
		const spy = spyOn(admissionModule, "persistWorkerAdmission").mockImplementation(async (...args: Parameters<typeof real>) => {
			entered.push(args[0].childId);
			if (entered.length === target) arrived.resolve();
			if (!released) {
				const gate = Promise.withResolvers<void>();
				open.push(() => gate.resolve());
				await gate.promise;
			}
			return real(...args);
		});
		return {
			entered,
			arrived: arrived.promise,
			release: () => {
				released = true;
				for (const resume of open.splice(0)) resume();
			},
			restore: () => spy.mockRestore(),
		};
	};

	test("a decision and its reservation do not wait for another spawn's admission write, and the last native place is taken once", async () => {
		await approve(TEAM);
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		// The plan's per-role number is the director's target, not a concurrency gate: six lanes with a target of four
		// must all be placeable (the native ceiling is what decides one place at a time).
		expect(await omp.tool({ action: "plan", plan: { lanes: readerLanes, workers: { explorer: 4 } } }, main)).toBe("ok");
		const handles: string[] = [];
		for (const lane of readerLanes) {
			const placed = await omp.emit("tool_call", { toolName: "task", toolCallId: `place-${lane.name}`, input: { agent: "storm-explorer", name: lane.name, task: `read ${lane.name}` } }, main);
			expect(verdict(placed)).toBe("pass");
			handles.push(placedName(placed, lane.name));
		}
		const parked = parkAdmissions(1);
		// The host's one native place. The admission of the one routed spawn is parked, so the other five decisions
		// must answer while it is parked.
		const hooks = withActiveSettings(Settings.isolated({ "task.maxConcurrency": 1 }), () =>
			handles.map(handle => omp.emit("before_subagent_spawn", spawnOf("storm-explorer", handle), main)),
		);
		const settled = Promise.withResolvers<void>();
		let finished = 0;
		const watched = hooks.map(hook =>
			hook.then(result => {
				finished++;
				if (finished === N - 1) settled.resolve();
				return result;
			}),
		);
		let results: unknown[] = [];
		try {
			// Every refusal is a decision that did not wait for the parked admission write; the routed one still waits.
			await settled.promise;
			expect(parked.entered).toHaveLength(1);
		} finally {
			parked.release();
			results = await Promise.all(watched);
			parked.restore();
		}
		expect(results.map(verdict).filter(value => value.startsWith("route:"))).toHaveLength(1);
		expect(results.map(verdict).filter(value => value === "parallelism")).toHaveLength(N - 1);
		// The one admitted worker's record is there for its child on another thread, before the hook returned.
		const admitted = handles.find((_, index) => verdict(results[index]).startsWith("route:"));
		expect(admitted).toBeDefined();
		const read = await readWorkerAdmission({ agentDir: project.agentDir, artifactRoot: project.root, parentId: "Main", childId: admitted as string });
		expect(read.kind).toBe("record");
		await omp.emit("session_shutdown", {}, main);
	});

	test("a trial with room for one gets one worker when every decision runs at once and the admission writes are parked", async () => {
		const now = Date.now();
		const trial: TrialConfig = {
			id: "t1",
			role: "explorer",
			model: "c/cand",
			share: 1,
			maxSpawns: 1,
			startsAt: new Date(now - 60_000).toISOString(),
			endsAt: new Date(now + 3_600_000).toISOString(),
			budgetUsd: 5,
		};
		await approve({ ...TEAM, trials: [trial] });
		const omp = fakeOmp(project);
		const main = omp.ctx(MAIN);
		await omp.command("manual task", main);
		expect(await omp.tool({ action: "plan", plan: { lanes: readerLanes, workers: { explorer: 4 } } }, main)).toBe("ok");
		const handles: string[] = [];
		for (const lane of readerLanes) {
			const placed = await omp.emit("tool_call", { toolName: "task", toolCallId: `place-${lane.name}`, input: { agent: "storm-explorer", name: lane.name, task: `read ${lane.name}` } }, main);
			expect(verdict(placed)).toBe("pass");
			handles.push(placedName(placed, lane.name));
		}
		const parked = parkAdmissions(N);
		const hooks = withActiveSettings(Settings.isolated({ "task.maxConcurrency": N }), () =>
			handles.map(handle => omp.emit("before_subagent_spawn", spawnOf("storm-explorer", handle), main)),
		);
		let results: unknown[] = [];
		try {
			// Every routed spawn's write is parked, so each decision's trial counters must already be visible to the
			// next decision; otherwise all N would be routed to a trial that has room for one.
			await parked.arrived;
			expect(parked.entered).toHaveLength(N);
		} finally {
			parked.release();
			results = await Promise.all(hooks);
			parked.restore();
		}
		expect(results.map(verdict).filter(value => value.includes("c/cand"))).toHaveLength(1);
		// The first spawn takes the trial's only place; the trial then has no room, so the later spawns are not its
		// spawns and are not counted as seen.
		expect((await readTrialStates(project.sessionDir)).t1).toMatchObject({ seen: 1, routed: 1, costUsd: 0 });
		await omp.emit("session_shutdown", {}, main);
	});
});

describe("native paid attempts through the hooks", () => {
	test("a bound run takes spend from exact receipts once; assistant usage is not added twice; shutdown retires the run", async () => {
		await approve({ ...TEAM, budget: { perRunUsd: 1, onExceed: "block-spawns" } });
		const paid = fakePaidSurface(project.sessionId);
		const omp = fakeOmp(project, storm, () => paid.api);
		const main = omp.ctx(MAIN);
		await omp.command("manual paid task", main);
		expect(await omp.tool({ action: "plan", plan: { lanes: [fixLane] } }, main)).toBe("ok");
		const runId = activeLedgerRun(project.sessionDir)?.runId as string;
		expect(getLedgerRun(runId)?.paid).toMatchObject({
			ownerSessionId: project.sessionId,
			startSeq: 0,
			startCostUsd: 0,
			limitUsd: 1,
		});

		await omp.emit("message_end", assistant("openai", "gpt-test", 1_000, 0.5), main);
		expect(getLedgerRun(runId)?.costUsd).toBe(0);
		paid.add(0.2);
		await omp.emit("message_end", assistant("openai", "gpt-test", 1_000, 0.5), main);
		expect(getLedgerRun(runId)?.costUsd).toBeCloseTo(0.2);

		await omp.emit("session_shutdown", {}, main);
		expect(paid.authorizeCalls.at(-1)).toBeUndefined();
		expect(getLedgerRun(runId)).toBeUndefined();
	});
});
