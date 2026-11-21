/**
 * OMP Storm extension: /storm, the storm tool, spawn-time enforcement of the approved team, and Storm runs (handoff,
 * run-scoped policy, budget, run modes, telemetry). The handlers here gather inputs, call the policy, request and
 * runtime modules and apply their results. Storm sends one thing to the main session, a run's handoff; everything
 * else is decided in dialogs and overlays. Module-level state is shared by every session in the process, because
 * subagent sessions reuse this module.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRepo } from "./approval/repo.ts";
import { loadConfig } from "./config/store.ts";
import { invalidateAnalysis, prepareAnalysis } from "./context.ts";
import { readQuota } from "./discovery/quota.ts";
import { readExplicitSettings } from "./discovery/settings.ts";
import {
	agentsFlow,
	approveAndSave,
	type FlowEnv,
	hubFlow,
	modelsFlow,
	resetFlow,
	setupFlow,
	statusFlow,
	statusText,
} from "./flows.ts";
import { serialized } from "./fsutil.ts";
import { execPort, ompBinary } from "./omp.ts";
import { pathOf } from "./policy/director.ts";
import { docPromptFor } from "./policy/docs.ts";
import { deliveredFollowUp, followUpAgent } from "./policy/followup.ts";
import { directorRead, noteChildRead } from "./policy/reads.ts";
import { activeAgents, blockedSpawn, blockText, deadline, decideSpawn, failClosed, SPAWN_DECISION_MS } from "./policy/spawn.ts";
import { decideToolCall } from "./policy/toolcall.ts";
import { directorCap, PACKAGE_JSON, ROLE_AGENT_PREFIX, STORM_VERSION } from "./roles.ts";
import {
	listAgents,
	noteAgentEnd,
	noteAgentFollowUp,
	noteAgentParked,
	noteAgentReview,
	noteAgentStart,
	noteAgentUsage,
} from "./runtime/agents.ts";
import { CHECKPOINT_INSTRUCTIONS, shouldCheckpoint, workingState } from "./runtime/checkpoint.ts";
import { noteRunSpawn, RunController, runSpawns, touchRun } from "./runtime/controller.ts";
import { activeLedgerRun, anyLedgerRun, recordCost } from "./runtime/ledger.ts";
import { readLoopMode } from "./runtime/modes.ts";
import { credentialNotice, fallbackQuotaMark, quotaNotice } from "./runtime/quota-auto.ts";
import { addQuotaMark, readQuotaMarks, readTrialStates, updateTrialState } from "./runtime/state-files.ts";
import { markTrialStop, noteTrialSpawn, trialCharge } from "./runtime/trials.ts";
import { newerInstalledVersion } from "./runtime/version.ts";
import { type ActionHost, runChange } from "./request/actions.ts";
import { routeRequest } from "./request/route.ts";
import { createStateCache, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { StormToolHost } from "./tool/host.ts";
import { createStormTool } from "./tool/storm-tool.ts";
import type { ConfigLoad, ExplicitSettings, RepoIdentity, UiPort } from "./types.ts";
import { createUiPort, registerReportRenderer } from "./ui.ts";

const PLUGIN_AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
/**
 * Words that open a flow by themselves, without a model call, so muscle memory never turns into a request. Offered
 * as completions after `/storm ` (only after the space, so `/storm` + Enter still opens the hub); read-only
 * `status` comes first in case Enter takes the top candidate. Approval and rollback have none: `/storm` opens the
 * approval screen by itself, and rollback is a menu item.
 */
const SHORTCUTS = [
	{ value: "status", label: "status", description: "현황만 보기(메뉴 없음)" },
	{ value: "models", label: "models", description: "모델 점검" },
	{ value: "setup", label: "setup", description: "팀 다시 설정" },
	{ value: "reset", label: "reset", description: "Storm 설정과 기록 초기화" },
] as const;
const SHORTCUT_NAMES: readonly string[] = SHORTCUTS.map(shortcut => shortcut.value);
/** Run modes take the rest of the line as their task; the request router parses them. */
const MODE_HINTS = [
	{ value: "vibe ", label: "vibe <작업>", description: "자유 실행: 세션이 멈출 때까지" },
	{ value: "goal ", label: "goal <목표> [--budget N]", description: "목표가 달성될 때까지" },
	{ value: "loop ", label: "loop [횟수|시간] [--until '<명령>'] <프롬프트>", description: "반복하며 개선" },
] as const;
const CONFIG_TTL_MS = 5_000;

const repoByCwd = new Map<string, Promise<RepoIdentity>>();
/** Repos already resolved, for code that must not wait (recording a spawn decision that timed out). */
const resolvedRepos = new Map<string, RepoIdentity>();
const configByRoot = new Map<string, { at: number; load: Promise<ConfigLoad> }>();

function cachedConfig(root: string): Promise<ConfigLoad> {
	const hit = configByRoot.get(root);
	if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.load;
	const load = loadConfig(root);
	configByRoot.set(root, { at: Date.now(), load });
	return load;
}

interface AssistantUsage {
	selector: string;
	/** List price; 0 when the model's prices are unknown. */
	usd: number;
	/** Input + cache read + cache write: what the request carried. */
	promptTokens: number;
}

/** Spend and prompt size of a finished assistant message, if any. */
function assistantUsage(message: unknown): AssistantUsage | undefined {
	if (!message || typeof message !== "object") return undefined;
	if (!("role" in message) || message.role !== "assistant") return undefined;
	if (!("provider" in message) || !("model" in message) || !("usage" in message)) return undefined;
	const { provider, model, usage } = message;
	if (typeof provider !== "string" || typeof model !== "string" || !usage || typeof usage !== "object") return undefined;
	const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	const cost = "cost" in usage ? usage.cost : undefined;
	return {
		selector: `${provider}/${model}`,
		usd: count(cost && typeof cost === "object" && "total" in cost ? cost.total : undefined),
		promptTokens:
			count("input" in usage ? usage.input : undefined) +
			count("cacheRead" in usage ? usage.cacheRead : undefined) +
			count("cacheWrite" in usage ? usage.cacheWrite : undefined),
	};
}

/** A newer Storm installed on disk than the one running here; `/restart` loads it. */
function newerVersion(): string | undefined {
	let text: string | undefined;
	try {
		text = readFileSync(PACKAGE_JSON, "utf8");
	} catch {
		text = undefined;
	}
	return newerInstalledVersion(STORM_VERSION, text);
}

function statusLabel(state: ProjectState): string | undefined {
	if (state.config.status === "missing") return undefined;
	const base = state.config.status === "invalid" ? "storm: 설정 오류" : state.approval ? "storm ✓" : "storm: 승인 필요";
	const newer = newerVersion();
	return newer ? `${base} · 새 버전 ${newer} → /restart` : base;
}

export default function storm(pi: ExtensionAPI): void {
	const exec = execPort(pi);
	const stateCache = createStateCache();
	const projectEnv = (ctx: ExtensionContext): ProjectEnv => ({
		cwd: ctx.cwd,
		exec,
		agentDir: pi.pi.getAgentDir(),
		pluginAgentsDir: PLUGIN_AGENTS_DIR,
	});
	const repoFor = (ctx: ExtensionContext): Promise<RepoIdentity> => {
		const hit = repoByCwd.get(ctx.cwd);
		if (hit) return hit;
		const repo = resolveRepo(ctx.cwd, exec);
		repoByCwd.set(ctx.cwd, repo);
		repo.then(
			identity => resolvedRepos.set(ctx.cwd, identity),
			() => repoByCwd.delete(ctx.cwd),
		);
		return repo;
	};

	/** Read on every use: these settings may change during a session, and only status and setup ask. */
	const ompSettings = (): Promise<ExplicitSettings> => readExplicitSettings(exec, ompBinary());
	/** Rewrites the project's active run record soon: the live record is what survives a crash. */
	const touchActiveRun = async (ctx: ExtensionContext): Promise<void> => {
		const run = activeLedgerRun((await repoFor(ctx)).repoId);
		if (run) touchRun(run.runId);
	};

	const runs = new RunController({
		pi,
		ui: ctx => createUiPort(pi, ctx),
		loadState: async ctx => {
			const state = await loadProjectState(projectEnv(ctx));
			// Every run starts through here, so a session that directs one has its repo known without waiting.
			resolvedRepos.set(ctx.cwd, state.repo);
			return state;
		},
		now: Date.now,
		agents: runId => listAgents({ runId }),
		ledger: () => listAgents(),
		agentDir: pi.pi.getAgentDir(),
		loopMode: () => readLoopMode(exec, ompBinary()),
	});

	/** Compacts the director while it waits on subagents, once its context reaches the director cap. */
	const checkpointDirector = (ctx: ExtensionContext): void => {
		const config = runs.runConfig();
		const usage = ctx.getContextUsage();
		if (!config || !usage) return;
		const lastAt = runs.lastCheckpointAt();
		const cap = directorCap(config, usage.contextWindow);
		if (!shouldCheckpoint({ tokens: usage.tokens, cap, now: Date.now(), ...(lastAt !== undefined ? { lastAt } : {}) })) return;
		const checkpoint = runs.noteCheckpoint(usage.tokens);
		// Not awaited: agent_end handlers time out after 30s and a summary can take longer; async subagents keep running.
		ctx.compact(CHECKPOINT_INSTRUCTIONS).then(
			() => checkpoint.done(ctx.getContextUsage()?.tokens),
			() => checkpoint.failed(),
		);
	};

	const flowEnv = (ctx: ExtensionContext): FlowEnv => ({
		...projectEnv(ctx),
		ompBin: ompBinary(),
		registry: ctx.modelRegistry,
		activeTools: pi.getActiveTools(),
		now: Date.now,
		activeRun: () => runs.active(),
		agents: () => listAgents({ ancestorId: ctx.agent.id }),
		ompSettings,
		newerVersion,
	});

	/** The approval path's host, and what a team change needs besides. Saving drops the caches the spawn hook reads. */
	const actionHost = (ctx: ExtensionContext, ui: UiPort): ActionHost => ({
		ui,
		now: Date.now,
		loadState: () => loadProjectState(projectEnv(ctx)),
		prepare: () => prepareAnalysis(flowEnv(ctx), ui),
		approveAndSave: async (state, config, scope) => {
			try {
				return await approveAndSave(state, config, scope);
			} finally {
				stateCache.clear();
				configByRoot.clear();
			}
		},
		addQuotaMark: async mark => addQuotaMark((await repoFor(ctx)).root, mark),
		quota: () => readQuota(exec, ompBinary()),
	});

	const toolHost = (ctx: ExtensionContext): StormToolHost => {
		const { ui, now, loadState, prepare, approveAndSave: save } = actionHost(ctx, createUiPort(pi, ctx));
		return {
			ui,
			now,
			loadState,
			prepare,
			approveAndSave: save,
			statusText: opts => statusText(flowEnv(ctx), opts),
			runtime: {
				requestRun: spec => runs.request(spec),
				setRunPlan: plan => runs.setPlan(plan),
				agents: () => listAgents({ ancestorId: ctx.agent.id }),
			},
		};
	};

	/**
	 * One side turn on the session model for the request router: it reads the conversation, appends nothing to it and
	 * runs no tool (omp emits no `message_end` for it). During a run its spend counts toward the run like any
	 * director request; outside one, `purpose` makes omp journal it in the session's usage. omp does only one of the
	 * two: a caller's `onUsage` replaces its journal entry.
	 */
	const sideTurn = (ctx: ExtensionContext): ((prompt: string) => Promise<string>) | undefined => {
		const turn = ctx.runEphemeralTurn;
		if (!turn) return undefined;
		return async promptText => {
			const result = await turn.call(ctx, {
				promptText,
				// `tools: false` throws on some transports and drops the prompt cache: tool calls are discarded anyway.
				dedupeReply: false,
				minimizeEffort: true,
				purpose: "storm",
				...(runs.runId() === undefined
					? {}
					: {
							onUsage: message => {
								const usage = assistantUsage(message);
								if (!usage || usage.usd <= 0) return;
								runs.noteMainSpend(usage.usd);
								void repoFor(ctx).then(
									repo => {
										const run = recordCost(repo.repoId, usage.selector, usage.usd);
										if (run) touchRun(run.runId);
									},
									() => undefined,
								);
							},
						}),
			});
			return result.replyText;
		};
	};

	// A decision that fails or outlasts omp's handler budget blocks storm-* agents and any agent during a run: omp
	// would otherwise run the spawn on its own model, unrecorded and uncounted.
	pi.on("before_subagent_spawn", (event, ctx) => {
		const limit = deadline(SPAWN_DECISION_MS);
		const decide = async () => {
			// Outside a Storm run only storm-* agents are Storm's business.
			if (!event.agent.startsWith(ROLE_AGENT_PREFIX) && !activeLedgerRun((await repoFor(ctx)).repoId)) return undefined;
			const state = await stateCache.get(projectEnv(ctx));
			const root = state.repo.root;
			// One decision at a time per project, so parallel spawns never read the same trial counters or live counts.
			return serialized(`spawn:${root}`, async () => {
				const now = Date.now();
				const run = activeLedgerRun(state.repo.repoId);
				const [quotaMarks, trials] = await Promise.all([readQuotaMarks(root, now), readTrialStates(root)]);
				const outcome = decideSpawn(
					event,
					{ config: state.config, approval: state.approval, shadows: state.shadows },
					{
						now,
						quotaMarks,
						trials,
						// The plan and live counts come from the process-wide ledger, so nested sessions see the same run.
						...(run
							? {
									run: {
										runId: run.runId,
										costUsd: run.costUsd,
										...(run.budget ? { budget: run.budget } : {}),
										...(run.plan ? { plan: run.plan } : {}),
										active: activeAgents(runSpawns(run.runId), listAgents({ runId: run.runId }), now),
									},
								}
							: {}),
					},
				);
				const record = outcome.record;
				if (record?.trialId) {
					const trialId = record.trialId;
					const routed = record.outcome === "trial" ? 1 : 0;
					if (routed && record.spawnKey) noteTrialSpawn(record.spawnKey, trialId);
					const trial = state.config.status === "ok" ? state.config.config.trials?.find(t => t.id === trialId) : undefined;
					// The decision stands even when the counter file cannot be written.
					await updateTrialState(root, trialId, current =>
						markTrialStop(trial, { ...current, seen: current.seen + 1, routed: current.routed + routed }, now),
					).catch(() => undefined);
				}
				if (record && run) noteRunSpawn(run.runId, record);
				return outcome.decision;
			});
		};
		return failClosed(event.agent, anyLedgerRun, decide, {
			expired: limit.expired,
			onBlock: block => {
				// Nothing is awaited here: the repo lookup may be what hung.
				const repo = resolvedRepos.get(ctx.cwd);
				const run = repo && activeLedgerRun(repo.repoId);
				if (run) noteRunSpawn(run.runId, blockedSpawn(event, block, Date.now()));
			},
		}).finally(limit.cancel);
	});

	pi.on("message_end", async (event, ctx) => {
		const usage = assistantUsage(event.message);
		if (!usage) return;
		if (ctx.agent.kind === "main" && usage.promptTokens > 0) runs.noteMainContext(usage.promptTokens);
		if (ctx.agent.kind === "sub" && usage.promptTokens > 0) {
			noteAgentUsage({
				id: ctx.agent.id,
				model: usage.selector,
				promptTokens: usage.promptTokens,
				costUsd: usage.usd,
				now: Date.now(),
			});
		}
		if (usage.usd <= 0) return;
		if (ctx.agent.kind === "main") runs.noteMainSpend(usage.usd);
		const repo = await repoFor(ctx);
		const run = recordCost(repo.repoId, usage.selector, usage.usd);
		if (run) touchRun(run.runId);
		// A trial's budget counts what the subagents routed to its candidate spend on that candidate.
		if (ctx.agent.kind !== "sub") return;
		const load = await cachedConfig(repo.root);
		const trialId = load.status === "ok" ? trialCharge(ctx.agent.id, usage.selector, load.config) : undefined;
		if (trialId === undefined) return;
		const trial = load.status === "ok" ? load.config.trials?.find(t => t.id === trialId) : undefined;
		await updateTrialState(repo.root, trialId, current => markTrialStop(trial, { ...current, costUsd: current.costUsd + usage.usd }, Date.now()));
	});

	// Agent ledger: each subagent session reports its own turns and end; omp offers no parent-side view of them.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind !== "sub") return undefined;
		const { id, name, parentId } = ctx.agent;
		const runId = activeLedgerRun((await repoFor(ctx)).repoId)?.runId;
		noteAgentStart({
			id,
			name,
			...(parentId ? { parentId } : {}),
			...(name.startsWith(ROLE_AGENT_PREFIX) ? { role: name.slice(ROLE_AGENT_PREFIX.length) } : {}),
			...(runId ? { runId } : {}),
			now: Date.now(),
		});
		if (runId) touchRun(runId);
		// Doc rules ride on a Storm role's system prompt (first turn and revive) while the team keeps docs on.
		if (!name.startsWith(ROLE_AGENT_PREFIX)) return undefined;
		const state = await stateCache.get(projectEnv(ctx));
		const section = state.config.status === "ok" ? docPromptFor(name, state.config.config) : undefined;
		return section && !event.systemPrompt.includes(section) ? { systemPrompt: [...event.systemPrompt, section] } : undefined;
	});

	// Director mode: blocking the call instead of swapping the tool list keeps the main session's prompt cache intact.
	pi.on("tool_call", (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			// A subagent's reads are indexed under the run of its latest turn.
			if (event.toolName !== "read") return undefined;
			const runId = listAgents().find(agent => agent.id === ctx.agent.id)?.runId;
			if (runId) noteChildRead(runId, ctx.agent.id, pathOf(event.input), ctx.cwd);
			return undefined;
		}
		const runId = runs.runId();
		const config = runs.runConfig();
		if (!runId || !config) return undefined;
		const block = decideToolCall({ toolName: event.toolName, input: event.input, cwd: ctx.cwd, runId, config, agents: listAgents() });
		if (!block) return undefined;
		if (block.code === "director-edit") runs.noteBlockedEdit();
		else if (block.code === "read-large") runs.noteBlockedRead();
		else runs.noteBlockedFollowUp();
		return { block: true, reason: blockText(block) };
	});

	// Every compaction of a directing session, omp's own included, keeps Storm's view of the run.
	pi.on("session.compacting", () => {
		const run = runs.active();
		return run ? { context: workingState(run, listAgents()) } : undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			// A reviewer's structured verdict arrives through its `yield`; it lands on the ledger entry and from there in the run record.
			if (event.toolName === "yield" && !event.isError) noteAgentReview(ctx.agent.id, event.input);
			return undefined;
		}
		const runId = runs.runId();
		if (!runId || event.isError) return undefined;
		if (event.toolName === "read") {
			// What the director's read returned, and whether a subagent of the run had read that file too.
			const read = directorRead({ runId, path: pathOf(event.input), cwd: ctx.cwd });
			const chars = event.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
			if (read) runs.noteRead(chars, read.indexed);
			return undefined;
		}
		// A follow-up counts when its write was delivered, for the agent omp resolved it to.
		const target = deliveredFollowUp(event.toolName, event.input, event.isError);
		const agent = target === undefined ? undefined : followUpAgent(listAgents(), target);
		if (agent) noteAgentFollowUp(agent.id);
		return undefined;
	});

	pi.on("agent_start", () => {
		runs.onAgentStart();
	});

	// omp's goal and loop modes decide when a goal or loop run is over.
	pi.on("goal_updated", async (event, ctx) => {
		if (ctx.agent.kind === "main") await runs.onGoalUpdated(event.goal, ctx);
	});
	pi.on("mode_changed", async (event, ctx) => {
		if (ctx.agent.kind === "main") await runs.onModeChanged(event.state, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			noteAgentEnd({ id: ctx.agent.id, now: Date.now(), settled: !(event.willContinue || event.awaitingAsyncWork) });
			await touchActiveRun(ctx);
			return;
		}
		// Paused on async subagents: the moment to shed context before their results arrive.
		if (event.awaitingAsyncWork) checkpointDirector(ctx);
		// Ends a settled vibe run, counts a goal or loop run's turn; a queued run starts detached from this handler.
		await runs.onAgentEnd(event, ctx);
		// A plugin update installed meanwhile shows up on the status line without waiting for /storm.
		if (!event.willContinue && !event.awaitingAsyncWork) await syncSession(ctx).catch(() => undefined);
	});

	// omp itself left a model after provider errors: its provider goes behind the approved fallbacks for a while.
	pi.on("retry_fallback_applied", async (event, ctx) => {
		const repo = await repoFor(ctx);
		if ((await cachedConfig(repo.root)).status === "missing") return;
		const mark = fallbackQuotaMark(event.from, Date.now());
		if (mark) await addQuotaMark(repo.root, mark);
		if (ctx.hasUI) ctx.ui.notify(quotaNotice(event.from, event.to, mark?.provider), "warning");
	});

	// One disabled credential need not mean the provider is out (other accounts may remain): notice only.
	pi.on("credential_disabled", async (event, ctx) => {
		if (!ctx.hasUI || (await cachedConfig((await repoFor(ctx)).root)).status === "missing") return;
		ctx.ui.notify(credentialNotice(event.provider), "warning");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// A subagent's session closes when omp parks it (idle TTL), kills it, or exits.
		if (ctx.agent.kind === "sub") noteAgentParked(ctx.agent.id);
		await runs.finish("shutdown");
	});

	// /new, /resume or a fork puts another conversation in this session: the run's handoff is not in it.
	pi.on("session_switch", async (_event, ctx) => {
		if (ctx.agent.kind === "main") await runs.finish("shutdown", ctx);
	});

	const tool = createStormTool(pi.zod, ctx => toolHost(ctx));
	const activateTool = async (): Promise<void> => {
		const active = pi.getActiveTools();
		if (!active.includes(tool.name)) await pi.setActiveTools([...active, tool.name]);
	};
	const deactivateTool = async (): Promise<void> => {
		const active = pi.getActiveTools();
		if (active.includes(tool.name)) await pi.setActiveTools(active.filter(name => name !== tool.name));
	};
	/** Refreshes the status line and turns the storm tool on once the project has a Storm config. */
	const syncSession = async (ctx: ExtensionContext): Promise<void> => {
		const state = await loadProjectState(projectEnv(ctx));
		if (state.config.status !== "missing") await activateTool();
		if (ctx.hasUI) ctx.ui.setStatus("storm", statusLabel(state));
	};

	pi.on("session_start", async (_event, ctx) => {
		// Subagents never manage the team: no tool, no status line.
		if (ctx.agent.kind !== "main") return;
		try {
			await syncSession(ctx);
		} catch {
			// The status line and the tool are conveniences; /storm reports the actual error.
		}
	});

	pi.registerTool(tool);
	registerReportRenderer(pi);

	pi.registerCommand("storm", {
		description: "Storm 멀티에이전트 팀 (/storm: 현황과 메뉴 · /storm <요청>: 작업 맡기기, 팀 변경, 질문 · /storm vibe|goal|loop <작업>)",
		getArgumentCompletions: prefix => {
			const typed = prefix.trim();
			const matches = [...SHORTCUTS, ...MODE_HINTS].filter(hint => hint.value.startsWith(typed));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const ui = createUiPort(pi, ctx);
			// What the user runs sees the registry, quota and settings as they are now (a provider login just made);
			// the flows inside this command and the model's tool calls share one analysis.
			invalidateAnalysis(ctx.cwd);
			const env = flowEnv(ctx);
			const input = args.trim();
			/** Bare /storm: the hub, or just the status where no dialog can be answered. */
			const menu = async (): Promise<void> => {
				if (!ctx.hasUI) await statusFlow(env, ui);
				else if (await hubFlow(env, ui)) await deactivateTool();
			};
			try {
				if (input === "") await menu();
				else if (input === "status") await statusFlow(env, ui);
				else if (input === "models") await modelsFlow(env, ui);
				else if (SHORTCUT_NAMES.includes(input)) {
					if (!ctx.hasUI) ui.notify("승인 창을 띄울 수 없는 모드라 아무것도 바꾸지 않습니다. /storm 으로 현황은 볼 수 있습니다.", "warning");
					else if (input === "setup") await setupFlow(env, ui);
					else if (await resetFlow(env, ui)) await deactivateTool();
				} else {
					// A request: Storm decides what it is off the transcript; only a run reaches the session.
					const side = sideTurn(ctx);
					await routeRequest(input, {
						ui,
						loadState: () => loadProjectState(projectEnv(ctx)),
						...(side ? { sideTurn: side } : {}),
						handlers: {
							run: async spec => {
								// Refused before waiting: during a run the session is busy until that run ends.
								const reason = runs.refusal();
								if (reason !== undefined) return { ok: false, reason };
								await ctx.waitForIdle();
								await activateTool();
								return runs.start(ctx, spec);
							},
							menu,
							status: () => statusFlow(env, ui),
							models: () => modelsFlow(env, ui),
							agents: () => agentsFlow(env, ui),
							change: change => runChange(actionHost(ctx, ui), change),
						},
					});
				}
			} catch (error) {
				ui.notify(`Storm 오류: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				stateCache.clear();
				configByRoot.clear();
				try {
					await syncSession(ctx);
				} catch {
					// Status refresh is best-effort.
				}
			}
		},
	});
}
