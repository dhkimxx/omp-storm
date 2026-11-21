/**
 * OMP Storm extension: /storm, the storm tool, spawn-time enforcement of the approved team, and Storm
 * runs (keyword handoff, run-scoped policy, budget, telemetry). Module-level state is shared by every
 * session in the process, because subagent sessions reuse this module.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRepo } from "./approval/repo.ts";
import { loadConfig } from "./config/store.ts";
import { prepareAnalysis } from "./context.ts";
import { toModelInfo } from "./discovery/models.ts";
import { readExplicitSettings } from "./discovery/settings.ts";
import {
	approveAndSave,
	type FlowEnv,
	hubFlow,
	modelsFlow,
	resetFlow,
	setupFlow,
	statusFlow,
} from "./flows.ts";
import { execPort, ompBinary } from "./omp.ts";
import { DIRECTOR_BLOCK_REASON, directorBlocks } from "./policy/director.ts";
import { followUpBlock } from "./policy/followup.ts";
import { activeAgents, decideSpawn, stripEffort } from "./policy/spawn.ts";
import { createProposalStore } from "./proposals/store.ts";
import { ROLE_AGENT_PREFIX, STORM_VERSION } from "./roles.ts";
import { listAgents, noteAgentEnd, noteAgentParked, noteAgentReview, noteAgentStart, noteAgentUsage } from "./runtime/agents.ts";
import { buildStormRequest, noteRunSpawn, RunController, runSpawns, touchRun } from "./runtime/controller.ts";
import { activeLedgerRun, recordCost } from "./runtime/ledger.ts";
import { lastRun } from "./runtime/run.ts";
import { credentialNotice, fallbackQuotaMark, quotaNotice } from "./runtime/quota-auto.ts";
import { addQuotaMark, readQuotaMarks, readTrialStates, updateTrialState } from "./runtime/state-files.ts";
import { trialPhase } from "./runtime/trials.ts";
import { trialViews } from "./runtime/views.ts";
import { newerInstalledVersion } from "./runtime/version.ts";
import { createStateCache, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { StormToolHost } from "./tool/host.ts";
import { createStormTool } from "./tool/storm-tool.ts";
import type { ConfigLoad, ExplicitSettings, LifecycleSettings, ModelInfo, RepoIdentity, TrialConfig } from "./types.ts";
import { createUiPort, registerReportRenderer } from "./ui.ts";

const PLUGIN_AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
/**
 * Shortcuts kept from the old subcommands: exactly one of them opens that flow without the LLM, so muscle memory
 * never turns into a request. Offered as completions after `/storm ` (only after the space, so `/storm` + Enter
 * still opens the hub); read-only `status` comes first in case Enter takes the top candidate.
 * Approval and rollback have none: `/storm` opens the approval screen by itself, and rollback is a menu item.
 */
const SHORTCUTS = [
	{ value: "status", label: "status", description: "현황만 보기(메뉴 없음)" },
	{ value: "models", label: "models", description: "모델 점검" },
	{ value: "setup", label: "setup", description: "팀 다시 설정" },
	{ value: "reset", label: "reset", description: "Storm 설정과 기록 초기화" },
] as const;
const SHORTCUT_NAMES: readonly string[] = SHORTCUTS.map(shortcut => shortcut.value);
const CONFIG_TTL_MS = 5_000;

const repoByCwd = new Map<string, Promise<RepoIdentity>>();
const configByRoot = new Map<string, { at: number; load: Promise<ConfigLoad> }>();
const spawnQueues = new Map<string, Promise<unknown>>();
/** Catalog rows by "provider/id"; misses are not cached so a refreshed catalog is picked up. */
const modelInfos = new Map<string, ModelInfo>();

/** Spawn decisions of one project run one at a time, so parallel spawns never read the same trial counters. */
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
	const next = (spawnQueues.get(key) ?? Promise.resolve()).then(task, task);
	spawnQueues.set(
		key,
		next.catch(() => undefined),
	);
	return next;
}

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
	cacheReadTokens: number;
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
	const cacheRead = count("cacheRead" in usage ? usage.cacheRead : undefined);
	return {
		selector: `${provider}/${model}`,
		usd: count(cost && typeof cost === "object" && "total" in cost ? cost.total : undefined),
		promptTokens: count("input" in usage ? usage.input : undefined) + cacheRead + count("cacheWrite" in usage ? usage.cacheWrite : undefined),
		cacheReadTokens: cacheRead,
	};
}

function lookupModel(ctx: ExtensionContext, selector: string): ModelInfo | undefined {
	const wanted = stripEffort(selector);
	const hit = modelInfos.get(wanted);
	if (hit) return hit;
	for (const model of ctx.modelRegistry.getAll()) {
		const info = toModelInfo(model, true);
		if (info?.selector !== wanted) continue;
		modelInfos.set(wanted, info);
		return info;
	}
	return undefined;
}

/** This plugin's own package.json: after `omp plugin install` it holds a newer version than the one this process loaded. */
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

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
		repo.catch(() => repoByCwd.delete(ctx.cwd));
		return repo;
	};

	let keywordSettings: Promise<ExplicitSettings["magicKeywords"]> | undefined;
	const usableKeywords = async (): Promise<{ workflowz: boolean; orchestrate: boolean }> => {
		keywordSettings ??= readExplicitSettings(exec, ompBinary()).then(
			settings => settings.magicKeywords,
			() => undefined,
		);
		// omp enables both keywords by default; unreadable settings keep that default.
		const keywords = (await keywordSettings) ?? { enabled: true, workflowz: true, orchestrate: true };
		const tools = pi.getActiveTools();
		return {
			workflowz: tools.includes("task") && tools.includes("eval") && keywords.enabled && keywords.workflowz,
			orchestrate: tools.includes("task") && keywords.enabled && keywords.orchestrate,
		};
	};

	/** Read on every use: these settings may change during a session, and only status, the agents action and setup ask. */
	const ompSettings = (): Promise<ExplicitSettings> => readExplicitSettings(exec, ompBinary());
	const lifecycleSettings = async (): Promise<LifecycleSettings> => {
		const settings = await ompSettings();
		return {
			...(settings.agentIdleTtlMs !== undefined ? { agentIdleTtlMs: settings.agentIdleTtlMs } : {}),
			...(settings.cacheRetention !== undefined ? { cacheRetention: settings.cacheRetention } : {}),
		};
	};
	const modelCost = (ctx: ExtensionContext, selector: string) => {
		const info = lookupModel(ctx, selector);
		return info?.pricingKnown ? info.cost : undefined;
	};
	/** Rewrites the project's active run record soon, so other terminals can follow it. */
	const touchActiveRun = async (ctx: ExtensionContext): Promise<void> => {
		const run = activeLedgerRun((await repoFor(ctx)).repoId);
		if (run) touchRun(run.runId);
	};

	const runs = new RunController({
		pi,
		ui: ctx => createUiPort(pi, ctx),
		loadState: ctx => loadProjectState(projectEnv(ctx)),
		usableKeywords: () => usableKeywords(),
		now: Date.now,
		agents: runId => listAgents({ runId }),
	});

	const flowEnv = (ctx: ExtensionContext): FlowEnv => ({
		...projectEnv(ctx),
		ompBin: ompBinary(),
		ompVersion: pi.pi.VERSION,
		mode: ctx.mode,
		registry: ctx.modelRegistry,
		activeTools: pi.getActiveTools(),
		now: Date.now,
		activeRun: () => runs.active(),
		agents: () => listAgents({ ancestorId: ctx.agent.id }),
		ompSettings,
		newerVersion,
		modelCost: selector => modelCost(ctx, selector),
	});

	const toolHost = (ctx: ExtensionContext): StormToolHost => {
		const ui = createUiPort(pi, ctx);
		const root = async () => (await repoFor(ctx)).root;
		const proposals = async () => {
			const dir = await root();
			return createProposalStore(dir, async () => {
				const load = await loadConfig(dir);
				return load.status === "ok" ? load.hash : null;
			});
		};
		return {
			ui,
			now: Date.now,
			loadState: () => loadProjectState(projectEnv(ctx)),
			prepare: () => prepareAnalysis(flowEnv(ctx), ui),
			approveAndSave: async (state, config, scope, evidence) => {
				try {
					return await approveAndSave(flowEnv(ctx), state, config, scope, evidence);
				} finally {
					stateCache.clear();
					configByRoot.clear();
				}
			},
			runtime: {
				activeRun: () => runs.active(),
				lastRun: async () => lastRun(await root()),
				trials: async () => {
					const dir = await root();
					const load = await loadConfig(dir);
					return load.status === "ok" ? trialViews(dir, load.config, Date.now()) : [];
				},
				quotaMarks: async () => readQuotaMarks(await root(), Date.now()),
				addQuotaMark: async mark => addQuotaMark(await root(), mark),
				requestRun: task => runs.request(task),
				setRunPlan: plan => runs.setPlan(plan),
				agents: () => listAgents({ ancestorId: ctx.agent.id }),
			},
			lifecycleSettings,
			modelCost: selector => modelCost(ctx, selector),
			proposals: {
				list: async () => (await proposals()).list(),
				save: async proposal => (await proposals()).save(proposal),
				remove: async id => (await proposals()).remove(id),
			},
		};
	};

	pi.on("before_subagent_spawn", async (event, ctx) => {
		// Outside a Storm run only storm-* agents are Storm's business (v0.1 behavior).
		if (!event.agent.startsWith(ROLE_AGENT_PREFIX) && !activeLedgerRun((await repoFor(ctx)).repoId)) return undefined;
		const state = await stateCache.get(projectEnv(ctx));
		const root = state.repo.root;
		return serialize(root, async () => {
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
				const routed = record.outcome === "trial" ? 1 : 0;
				await updateTrialState(root, record.trialId, current => ({ ...current, seen: current.seen + 1, routed: current.routed + routed }));
			}
			if (record && run) noteRunSpawn(run.runId, record);
			return outcome.decision;
		});
	});

	pi.on("message_end", async (event, ctx) => {
		const usage = assistantUsage(event.message);
		if (!usage) return;
		if (ctx.agent.kind === "sub" && usage.promptTokens > 0) {
			const contextWindow = lookupModel(ctx, usage.selector)?.contextWindow;
			noteAgentUsage({
				id: ctx.agent.id,
				model: usage.selector,
				promptTokens: usage.promptTokens,
				cacheReadTokens: usage.cacheReadTokens,
				costUsd: usage.usd,
				...(contextWindow ? { contextWindow } : {}),
				now: Date.now(),
			});
		}
		if (usage.usd <= 0) return;
		if (ctx.agent.kind === "main") runs.noteMainSpend(usage.usd);
		const repo = await repoFor(ctx);
		const run = recordCost(repo.repoId, usage.selector, usage.usd);
		if (run) touchRun(run.runId);
		// A trial's budget caps the candidate's spend while the trial runs (all of it, not only trial spawns: the safe side).
		const load = await cachedConfig(repo.root);
		const candidates: TrialConfig[] =
			load.status === "ok" ? (load.config.trials ?? []).filter(trial => stripEffort(trial.model) === usage.selector) : [];
		if (candidates.length === 0) return;
		const states = await readTrialStates(repo.root);
		const now = Date.now();
		for (const trial of candidates) {
			if (trialPhase(trial, states[trial.id], now).phase !== "active") continue;
			await updateTrialState(repo.root, trial.id, current => ({ ...current, costUsd: current.costUsd + usage.usd }));
		}
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
			revive: event.reason === "revive",
		});
		if (runId) touchRun(runId);
		return undefined;
	});

	// Director mode: while this session runs Storm, file changes go to storm-implementer. Blocking the call instead of
	// swapping the tool list keeps the main session's prompt cache intact.
	pi.on("tool_call", async (event, ctx) => {
		if (!runs.directing()) return undefined;
		if (directorBlocks(event.toolName, event.input)) {
			runs.noteBlockedEdit();
			return { block: true, reason: DIRECTOR_BLOCK_REASON };
		}
		// A follow-up to an agent past its context cap costs its whole context again on every turn: start a fresh one instead.
		const path = event.toolName === "write" ? (event.input as { path?: unknown }).path : undefined;
		if (typeof path !== "string" || !path.startsWith("agent://")) return undefined;
		const runId = runs.active()?.runId;
		if (!runId) return undefined;
		const state = await stateCache.get(projectEnv(ctx));
		if (state.config.status !== "ok") return undefined;
		const reason = followUpBlock(event.toolName, event.input, listAgents({ runId }), state.config.config);
		if (!reason) return undefined;
		runs.noteBlockedFollowUp();
		return { block: true, reason };
	});

	// A reviewer's structured verdict arrives through its `yield`; it lands on the ledger entry and from there in the run record.
	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind === "sub" && event.toolName === "yield" && !event.isError) noteAgentReview(ctx.agent.id, event.input);
		return undefined;
	});

	pi.on("agent_start", () => {
		runs.onAgentStart();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			noteAgentEnd({ id: ctx.agent.id, now: Date.now(), settled: !(event.willContinue || event.awaitingAsyncWork) });
			await touchActiveRun(ctx);
			return;
		}
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
		await runs.finish("stopped");
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
		description: "Storm 멀티에이전트 팀 (/storm: 현황과 메뉴 · /storm <요청>: 작업 맡기기, 팀 변경, 질문)",
		getArgumentCompletions: prefix => {
			const typed = prefix.trim();
			const matches = SHORTCUTS.filter(shortcut => shortcut.value.startsWith(typed));
			return matches.length ? [...matches] : null;
		},
		handler: async (args, ctx) => {
			const ui = createUiPort(pi, ctx);
			const env: FlowEnv = {
				...flowEnv(ctx),
				// Setup is led by the session LLM; the storm tool must be on for it to propose the team.
				requestSetup: async message => {
					await ctx.waitForIdle();
					await activateTool();
					pi.sendUserMessage(message).catch((error: unknown) => {
						ui.notify(`설정 요청을 보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
					});
				},
			};
			const input = args.trim();
			try {
				if (input !== "" && !SHORTCUT_NAMES.includes(input)) {
					// A request: the main LLM starts a run for work or answers through the storm tool; changes still need the approval dialog.
					await ctx.waitForIdle();
					await activateTool();
					pi.sendUserMessage(buildStormRequest(input)).catch((error: unknown) => {
						ui.notify(`요청을 보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
					});
					return;
				}
				if (input === "status") {
					await statusFlow(env, ui);
					return;
				}
				if (input === "models") {
					await modelsFlow(env, ui);
					return;
				}
				if (!ctx.hasUI) {
					// Nothing can be approved without dialogs; plain /storm still shows the status.
					if (input === "") await statusFlow(env, ui);
					else ui.notify("승인 창을 띄울 수 없는 모드라 아무것도 바꾸지 않습니다. /storm 으로 현황은 볼 수 있습니다.", "warning");
					return;
				}
				let reset = false;
				if (input === "setup") await setupFlow(env, ui);
				else if (input === "reset") reset = await resetFlow(env, ui);
				else reset = await hubFlow(env, ui);
				if (reset) await deactivateTool();
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
