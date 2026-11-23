/**
 * OMP Storm extension: /storm, the storm tool, spawn-time enforcement of the approved team, and Storm runs (handoff,
 * run-scoped policy, budget, telemetry). The handlers here gather inputs, call the policy, request and runtime modules
 * and apply their results. Storm's only messages to the main session are a run's handoff and the rounds it starts;
 * everything else is decided in dialogs and overlays. Module-level state is shared by every session in the process,
 * because subagent sessions reuse this module.
 */
import { readFileSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionModeState } from "@oh-my-pi/pi-coding-agent";
import { readAutoDelegation } from "./approval/auto.ts";
import { resolveRepo } from "./approval/repo.ts";
import { loadConfig } from "./config/store.ts";
import { invalidateAnalysis, prepareAnalysis } from "./context.ts";
import { readQuota } from "./discovery/quota.ts";
import { liveIsolationSettings, readExplicitSettings } from "./discovery/settings.ts";
import {
	agentsFlow,
	approveAndSave,
	autoDelegationFlow,
	type FlowEnv,
	hubFlow,
	modelsFlow,
	resetFlow,
	resumeFlow,
	setupFlow,
	statusFlow,
	statusText,
} from "./flows.ts";
import { serialized } from "./fsutil.ts";
import { execPort, ompBinary } from "./omp.ts";
import { changesFiles, pathOf } from "./policy/director.ts";
import { docPromptFor } from "./policy/docs.ts";
import { deliveredFollowUp, followUpAgent } from "./policy/followup.ts";
import { directorRead, noteChildRead } from "./policy/reads.ts";
import { activeAgents, blockedSpawn, blockText, deadline, decideSpawn, failClosed, SPAWN_DECISION_MS, usableRole } from "./policy/spawn.ts";
import { supervisorToolBlock } from "./policy/supervisor.ts";
import { decideToolCall } from "./policy/toolcall.ts";
import { PACKAGE_JSON, ROLE_AGENT_PREFIX, STORM_VERSION } from "./roles.ts";
import {
	listAgents,
	noteAgentChange,
	noteAgentEnd,
	noteAgentFollowUp,
	noteAgentParked,
	noteAgentReview,
	noteAgentRun,
	noteAgentStart,
	noteAgentUsage,
	noteVerdictTree,
} from "./runtime/agents.ts";
import { workingState } from "./runtime/checkpoint.ts";
import { noteRunSpawn, noteRunUserWait, RunController, runSpawns, touchRun } from "./runtime/controller.ts";
import { replanConflict, type TaskIsolationHost } from "./runtime/lanes.ts";
import { bindLedgerChild, anyLedgerRun, getLedgerRun, ledgerRunForChild, recordCost, type LedgerRun } from "./runtime/ledger.ts";
import { stopDeadRuns } from "./runtime/janitor.ts";
import { resetCloseoutChoices, takeCloseoutChoice } from "./runtime/closeout.ts";
import { credentialNotice, fallbackQuotaMark, quotaNotice } from "./runtime/quota-auto.ts";
import { verdictOf } from "./runtime/review.ts";
import { addQuotaMark, readQuotaMarks, readTrialStates, updateTrialState } from "./runtime/state-files.ts";
import { markTrialStop, noteTrialSpawn, trialCharge } from "./runtime/trials.ts";
import { findResumeCandidate } from "./runtime/resume.ts";
import { treeAgainst, type TreeReading } from "./runtime/tree.ts";
import { newerInstalledVersion } from "./runtime/version.ts";
import { type ActionHost, runChange } from "./request/actions.ts";
import { routeRequest } from "./request/route.ts";
import { createStateCache, isApproved, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { RunRequestResult, StormToolHost } from "./tool/host.ts";
import { createStormTool } from "./tool/storm-tool.ts";
import type {
	ConfigLoad,
	ExplicitSettings,
	Exec,
	InfoTone,
	RepoIdentity,
	RunPlan,
	RunRecord,
	RunSpec,
	SpawnDecision,
	StormConfig,
	UiPort,
} from "./types.ts";
import { createUiPort, registerReportRenderer } from "./ui.ts";
import { isLiveTui, LiveStatus } from "./view/live.ts";
import { idleAppearance, RUN_APPEARANCE, STORM_MARK, type RunPhase } from "./view/appearance.ts";
import { runStatusText } from "./view/render.ts";

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
	{ value: "auto", label: "auto", description: "자동 위임 켜기/끄기(이 프로필·저장소)" },
	{ value: "setup", label: "setup", description: "팀 다시 설정" },
	{ value: "reset", label: "reset", description: "Storm 설정과 기록 초기화" },
] as const;
const SHORTCUT_NAMES: readonly string[] = SHORTCUTS.map(shortcut => shortcut.value);
const CONFIG_TTL_MS = 5_000;

/** The session's personal automatic-delegation policy, refreshed from the approval store. */
interface AutoStatus {
	/** The consent file said enabled at the last successful read; a later failure keeps this value. */
	enabled: boolean;
	/** Why an automatic run cannot start now: team config/approval or an omp session mode. */
	problem: string | undefined;
}

/**
 * The stable automatic-delegation instruction appended to the director's system prompt. It carries no live state,
 * so it does not invalidate the prompt cache between turns; refusals carry the exact fix when a call is blocked.
 */
const AUTO_INSTRUCTION = `<storm-auto>
This session delegates project work automatically.
- General conversation needs no tools: answer directly.
- Keep the scope tiny: one lane and one worker for a quick mechanical edit or a read-only lookup. When the request is uncertain, submit an explore-only plan first instead of guessing implementation lanes.
- Any repository inspection, verification, or file change belongs to the approved Storm team. First submit a plan with the \`storm\` tool (action "plan"); it opens a run for this turn's user request. Then spawn the plan's approved workers with \`task\`.
- You own replanning: change the plan only when cross-lane evidence changes an assumption. On a replan keep each existing lane's name, kind, role, files and goal; put status in \`progress\`, and give a real scope change a new lane name. Name each task item after its planned lane so the worker can be matched to it.
- Lanes share this work tree by default. Add \`isolationReason\` to a lane only when its result must stay outside the parent tree as an independent experiment; Storm requires omp isolation to be on and \`task.isolation.apply\` off for that lane. Never add \`isolationReason\` to the final review: its verdict must prove the integrated work, and Storm withholds a review it cannot bind to the tree that reviewer actually saw.
- Do not call read, grep, glob, bash, edit, ast_edit, eval, or any other file, shell, or unknown tool yourself; for \`write\`, only the two forms below are allowed. Do not spawn an agent before the plan opens the run. Storm blocks those calls.
- Direct writes are limited to \`write local://<name>.md\` notes and \`write agent://<id>\` messages; read worker results with \`read agent://<id>\` and bounded line ranges.
- Follow up on the same worker with \`write agent://<id>\`; when Storm blocks it, start a fresh worker that reads \`agent://<id>\`.
- Keep each worker result to about 1500 characters with evidence locations and links; do not paste raw logs. Send those ranges to workers or the reviewer; do not read repository files yourself.
- When you need the user, use the native \`ask\` tool within this turn; never end by pretending no lane was work.
- Spawn only the plan's approved roles and worker counts; Storm refuses anything outside the plan.
- When the team has a reviewer, the run ends verified only after that reviewer accepts the tree as it is after the last change.
- Near the end of a substantial run, after its results and before you end the turn, submit one \`brief\` action with the \`storm\` tool: \`result\`, \`verification\` with evidence locations, optional \`remaining\`, and exactly three concrete \`next\` directions (the first is your recommendation). Restage it if later rounds change the result. A brief only stages the closeout; it neither verifies nor ends the run, and submitting it is no proof. Skip the brief and next directions for a trivial lookup or a quick one-step request.
- Do not repeat the brief's directions as a numbered menu in your prose: Storm shows the menu when the run settles. Never claim work is verified before Storm's final gate says so. Do not make another model call just to write the brief.
- A refusal names the fix (usually /storm). Relay it to the user; never work around it with a direct tool.
- Keep going until the plan's lanes are done or blocked.
</storm-auto>`;

/** Said when an automatic session tries to spawn outside the run its plan opens. */
const AUTO_SPAWN_REASON =
	"실행이 없는 동안에는 작업을 직접 스폰할 수 없습니다. 이번 사용자 요청의 계획을 storm plan으로 먼저 내세요.";

/** The team config/approval side of why automatic delegation cannot run now. */
function teamProblem(state: ProjectState): string | undefined {
	if (state.config.status === "missing") return "팀 설정이 없습니다. /storm 으로 팀을 설정하세요.";
	if (state.config.status === "invalid") return "팀 설정에 오류가 있습니다. /storm 으로 확인하고 고치세요.";
	if (!isApproved(state)) return "팀 설정이 승인되지 않았거나 승인 뒤에 바뀌었습니다. /storm 에서 확인하고 승인하세요.";
	return undefined;
}

/** The omp session-mode side of why automatic delegation cannot run now (absent in non-interactive hosts). */
function modeProblem(ctx: ExtensionContext): string | undefined {
	const modes = ctx.sessionModes;
	if (!modes) return undefined;
	let state: SessionModeState;
	try {
		state = modes.getState();
	} catch {
		return "omp 세션 모드를 확인하지 못했습니다. 모드를 확인한 뒤 다시 요청하세요.";
	}
	if (state.goal.status === "active") {
		return "omp 목표 모드가 켜져 있어 자동 실행을 열 수 없습니다. 목표를 끝내거나 일시 정지한 뒤 다시 요청하세요.";
	}
	if (state.loop.status !== "inactive") return "omp 반복 모드가 켜져 있어 자동 실행을 열 수 없습니다. 반복을 끈 뒤 다시 요청하세요.";
	if (state.plan.status === "active") return "omp 계획 모드가 켜져 있어 자동 실행을 열지 않습니다. 계획 모드를 끝낸 뒤 다시 요청하세요.";
	if (state.vibe.status === "active") return "omp vibe 모드에서는 Storm 팀을 쓸 수 없습니다. vibe 모드를 끈 뒤 다시 요청하세요.";
	return undefined;
}

/** What a blocked direct call tells the model: why it is blocked, the one way forward, and the tool's own rule. */
function autoRefusal(problem: string | undefined, detail: string | undefined): string {
	const reason = problem === undefined ? "" : ` ${problem}`;
	const rule = detail === undefined ? "" : ` ${detail}`;
	return `[storm:auto] 자동 위임이 켜져 있어 메인 세션이 프로젝트 도구를 직접 쓰지 않습니다.${reason} 작업은 storm plan으로 이번 사용자 요청의 실행을 연 뒤 승인된 팀에 맡기세요.${rule}`;
}

/**
 * Whether task placement needs host isolation at all. A shared team with no reason-marked lane is settled by the plan
 * alone, so it never pays for a settings read; an isolated team or any selective lane resolves it once per run.
 */
function needsIsolationHost(plan: RunPlan | undefined, config: StormConfig): boolean {
	return config.isolation === "isolated" || (plan?.lanes.some(lane => lane.isolationReason !== undefined) ?? false);
}

/** The same refusal during an active automatic run: the run is already open, so the work belongs to its workers. */
function autoRunRefusal(detail: string | undefined): string {
	const rule = detail === undefined ? "" : ` ${detail}`;
	return `[storm:auto] 자동 위임 실행 중이라 메인 세션은 프로젝트 도구를 직접 쓰지 않습니다. 필요한 작업은 계획 범위의 승인된 팀 워커에 맡기고, 결과는 read agent://<id>로 확인하세요.${rule}`;
}

/**
 * The host's terminal stop reason for a settled child turn: error, abort and output length are failures; stop and
 * tool use are not. No assistant message or no stop reason is unknown, never success.
 */
function terminalWorkFailed(messages: readonly unknown[] | undefined): boolean | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") continue;
		if (!("stopReason" in message) || typeof message.stopReason !== "string") return undefined;
		const reason = message.stopReason;
		return reason === "error" || reason === "aborted" || reason === "length";
	}
	return undefined;
}

/**
 * Only a real ask form is a user wait. The host's only public form-open hook is the ask tool's own execution, so its
 * arguments are checked here too: the current `html` form, the older bare string and `questions` list are the
 * documented shapes. A headless or invalid ask finishes at once and its execution end clears the mark.
 */
function askWaits(args: unknown): boolean {
	if (typeof args === "string") return args.trim() !== "";
	if (typeof args !== "object" || args === null) return false;
	const form = args as { html?: unknown; questions?: unknown };
	if (typeof form.html === "string" && form.html.trim() !== "") return true;
	return Array.isArray(form.questions) && form.questions.length > 0;
}

/** The host artifact root shared by a parent session and its task children, isolated worktrees included. */
function artifactsOf(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getArtifactsDir() ?? undefined;
}

/** A subagent's run, only through the binding its parent recorded before the spawn was admitted. */
function childLedger(ctx: ExtensionContext): LedgerRun | undefined {
	return ledgerRunForChild(ctx.agent.id, ctx.agent.parentId, artifactsOf(ctx));
}

/** The approved reviewer agent of a run's team; a disabled or modelless reviewer is not authority. */
function approvedReviewer(config: StormConfig | undefined): string | undefined {
	return config === undefined ? undefined : usableRole(config, "reviewer")?.agent;
}

interface ReviewerBaseline {
	runId: string;
	/** The run's integrated parent worktree. */
	root: string;
	base: string;
	tree: string;
	/** The checkout the reviewer session actually read; equal to `root` on a shared team, a copy on legacy isolation. */
	reviewerRoot: string;
}

/** Reviewer starts per child session, keyed by the artifact root and the id its parent admitted. */
const reviewerBaselines = new Map<string, ReviewerBaseline>();
/** The work tree each subagent session actually runs in, so a reused reviewer's copy cannot pass for the parent. */
const childWorkTrees = new Map<string, string>();
/** A snapshot that outlasts this is no snapshot: the proof must not wait on a hung git read. */
const REVIEW_SNAPSHOT_MS = 12_000;

function reviewerBaselineKey(artifacts: string | undefined, id: string): string {
	return `${artifacts ?? ""}\0${id}`;
}

function fingerprintOf(reading: TreeReading): string {
	return `${reading.state.diff}:${reading.state.files}`;
}

/** Real path when the host still has it, lexical path otherwise: a deleted isolated workspace is still not the parent. */
function realTreeOf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolvePath(path);
	}
}

/** Whether two paths name one physical worktree; an isolated copy is a different tree even when its content matches. */
function sameWorkTree(a: string, b: string): boolean {
	return realTreeOf(a) === realTreeOf(b);
}

/** A tree read bounded by a timer, so a reviewer's first turn or verdict cannot hang on git. */
async function boundedTree(exec: Exec, root: string, base?: string): Promise<TreeReading | undefined> {
	const timeout = Promise.withResolvers<undefined>();
	const handle = setTimeout(() => timeout.resolve(undefined), REVIEW_SNAPSHOT_MS);
	handle.unref?.();
	try {
		const reading = await Promise.race([treeAgainst(exec, root, base), timeout.promise]);
		return reading;
	} catch {
		return undefined;
	} finally {
		clearTimeout(handle);
	}
}

/**
 * Records the tree reviewer work starts from. A reviewer in another checkout may review only when its complete
 * fingerprint, against the run's base, equals the integrated parent's; otherwise there is no baseline and no proof.
 * An unreadable or incomplete tree removes any older baseline.
 */
async function recordReviewerBaseline(
	exec: Exec,
	artifacts: string | undefined,
	id: string,
	run: LedgerRun,
	reviewerRoot: string,
): Promise<void> {
	const key = reviewerBaselineKey(artifacts, id);
	if (getLedgerRun(run.runId) !== run || run.closing) {
		reviewerBaselines.delete(key);
		return;
	}
	const reading = await boundedTree(exec, run.root, run.base);
	if (!reading || reading.state.incomplete) {
		reviewerBaselines.delete(key);
		return;
	}
	const tree = fingerprintOf(reading);
	if (!sameWorkTree(run.root, reviewerRoot)) {
		const reviewed = await boundedTree(exec, reviewerRoot, reading.base);
		if (!reviewed || reviewed.state.incomplete || fingerprintOf(reviewed) !== tree) {
			reviewerBaselines.delete(key);
			return;
		}
	}
	reviewerBaselines.set(key, { runId: run.runId, root: run.root, base: reading.base, tree, reviewerRoot });
}

/**
 * Binds a reviewer verdict only when the run is still the admitted one and both the integrated parent and the
 * reviewer's own checkout still carry the complete fingerprint recorded before reviewer work started. A mismatch,
 * a disappeared run, an unreadable tree or any later mutation consumes the baseline without proof, so the gate
 * cannot accept work the reviewer did not see.
 */
async function bindReviewerVerdict(exec: Exec, ctx: ExtensionContext, run: LedgerRun, at: number): Promise<void> {
	const key = reviewerBaselineKey(artifactsOf(ctx), ctx.agent.id);
	const baseline = reviewerBaselines.get(key);
	if (!baseline || baseline.runId !== run.runId) return;
	reviewerBaselines.delete(key);
	const current = getLedgerRun(baseline.runId);
	if (!current || current.closing || current.root !== baseline.root) return;
	const shared = sameWorkTree(baseline.root, baseline.reviewerRoot);
	const [fresh, reviewed] = await Promise.all([
		boundedTree(exec, baseline.root, baseline.base),
		shared ? Promise.resolve(undefined) : boundedTree(exec, baseline.reviewerRoot, baseline.base),
	]);
	if (!fresh || fresh.state.incomplete || fingerprintOf(fresh) !== baseline.tree) return;
	if (!shared && (!reviewed || reviewed.state.incomplete || fingerprintOf(reviewed) !== baseline.tree)) return;
	noteVerdictTree(ctx.agent.id, at, baseline.tree);
}

const repoByCwd = new Map<string, Promise<RepoIdentity>>();
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

/**
 * The idle footer/status line. It speaks for an existing team only: a missing config with no automatic consent gets
 * nothing. On a real TUI each part carries a semantic theme tone; RPC and print hosts get the same words with no
 * ANSI. A live run replaces it with the editor widget, so the idle line never duplicates the live one.
 */
function idleStatusText(
	ctx: ExtensionContext,
	state: ProjectState,
	resumable: boolean,
	auto: AutoStatus,
): string | undefined {
	const team =
		state.config.status === "missing"
			? "missing"
			: state.config.status === "invalid"
				? "invalid"
				: isApproved(state)
					? "approved"
					: "unapproved";
	if (team === "missing" && !auto.enabled) return undefined;
	const look = idleAppearance({
		team,
		auto: auto.enabled ? (auto.problem === undefined ? "on" : "blocked") : "off",
		resume: resumable && team === "approved",
	});
	const paint = (text: string, tone: InfoTone): string => (isLiveTui(ctx) ? ctx.ui.theme.fg(tone, text) : text);
	const parts = [`${paint(STORM_MARK, "accent")} · ${paint(look.label, look.tone)}`];
	if (look.action !== undefined) parts.push(paint(look.action.replaceAll("`", ""), "muted"));
	if (auto.enabled) {
		const line = auto.problem?.split(/\r?\n/, 1)[0]?.trim() ?? "";
		const blocked = line.length > 160 ? `${line.slice(0, 159)}…` : line;
		if (blocked === "") parts.push(paint("자동 위임 켜짐", "accent"));
		else if (look.label === "자동 위임 막힘") parts.push(paint(blocked, "warning"));
		else parts.push(paint(`자동 위임 막힘: ${blocked}`, "warning"));
	}
	// Another status outranks resume in the shared idle label; the hint still belongs on the line.
	if (resumable && team === "approved" && look.label !== "이어가기 가능") parts.push(paint("이어가기 가능", "warning"));
	const newer = newerVersion();
	if (newer !== undefined) parts.push(paint(`새 버전 ${newer} → /restart`, "accent"));
	return parts.join(" · ");
}

export default function storm(pi: ExtensionAPI): void {
	const exec = execPort(pi);
	const liveStatus = new LiveStatus();
	/**
	 * The run each open ask/tool-approval belongs to, captured when it opened. Its end event closes that run's key,
	 * never one of whichever run this session directs by then.
	 */
	const openWaits = new Map<string, { runId: string; key: string }>();
	/**
	 * One live run: the editor widget in a true TUI, the plain status line everywhere else. The phase is view-only
	 * evidence from the controller; `working` is the safe default for a host that cannot say.
	 */
	const showRunStatus = (ctx: ExtensionContext, run: RunRecord, phase: RunPhase = "working"): void => {
		if (liveStatus.show(ctx, run, phase)) return;
		if (!ctx.hasUI) return;
		const look = RUN_APPEARANCE[phase];
		const label = isLiveTui(ctx) ? ctx.ui.theme.fg(look.tone, look.label) : look.label;
		ctx.ui.setStatus("storm", `${runStatusText(run, Date.now())} · ${label}`);
	};
	const stateCache = createStateCache();
	const projectEnv = (ctx: ExtensionContext): ProjectEnv => ({
		cwd: ctx.cwd,
		exec,
		agentDir: pi.pi.getAgentDir(),
		pluginAgentsDir: PLUGIN_AGENTS_DIR,
	});
	/** A subagent in an isolated worktree still runs under the main worktree's approved config. */
	const runEnv = (ctx: ExtensionContext, root: string): ProjectEnv => ({ ...projectEnv(ctx), cwd: root });
	/**
	 * This session's personal automatic-delegation policy. Consent is loaded at session start and refreshed on a
	 * user turn, a session switch and every command; a failed refresh keeps the last enabled guard rather than
	 * unfencing direct tools. The request text is the host's already-normalized prompt for this turn.
	 */
	const auto: AutoStatus & { task: string | undefined } = { enabled: false, problem: undefined, task: undefined };
	const refreshAuto = async (ctx: ExtensionContext, load?: () => Promise<ProjectState>): Promise<void> => {
		let state: ProjectState;
		try {
			state = await (load ? load() : loadProjectState(projectEnv(ctx)));
		} catch {
			// A failed load cannot prove the user withdrew consent: keep the last enabled guard.
			if (auto.enabled) auto.problem = "팀 설정을 확인하지 못했습니다. /storm 으로 확인하세요.";
			return;
		}
		auto.problem = teamProblem(state) ?? modeProblem(ctx);
		try {
			auto.enabled = await readAutoDelegation(state.store.dir);
		} catch {
			// An unreadable consent file is not an opt-out. Keep the last enabled guard.
		}
	};
	const repoFor = (ctx: ExtensionContext): Promise<RepoIdentity> => {
		const hit = repoByCwd.get(ctx.cwd);
		if (hit) return hit;
		const repo = resolveRepo(ctx.cwd, exec);
		repoByCwd.set(ctx.cwd, repo);
		repo.catch(() => repoByCwd.delete(ctx.cwd));
		return repo;
	};

	/** Read on every use: these settings may change during a session, and only status and setup ask. */
	const ompSettings = (): Promise<ExplicitSettings> => readExplicitSettings(exec, ompBinary());
	/**
	 * The live host's task-isolation capability. A running omp exposes effective settings directly, so ordinary
	 * spawns pay nothing; a host that cannot expose them falls back to one cached `omp config list` read per run,
	 * never one subprocess per spawn. Unknown fields stay absent: they are not proof that isolation is off.
	 */
	let isolationHostCache: { runId: string; load: Promise<TaskIsolationHost> } | undefined;
	const isolationHost = (runId: string): Promise<TaskIsolationHost> => {
		const live = liveIsolationSettings();
		if (live.isolationEnabled !== undefined) {
			return Promise.resolve({
				enabled: live.isolationEnabled,
				...(live.isolationApply !== undefined ? { apply: live.isolationApply } : {}),
			});
		}
		if (isolationHostCache?.runId === runId) return isolationHostCache.load;
		const load = readExplicitSettings(exec, ompBinary()).then(settings => ({
			...(settings.isolationEnabled !== undefined ? { enabled: settings.isolationEnabled } : {}),
			...(settings.isolationApply !== undefined ? { apply: settings.isolationApply } : {}),
		}));
		isolationHostCache = { runId, load };
		return load;
	};

	const runs = new RunController({
		pi,
		ui: ctx => createUiPort(pi, ctx),
		loadState: async ctx => loadProjectState(projectEnv(ctx)),
		now: Date.now,
		agents: runId => listAgents({ runId }),
		tree: (root, base) => treeAgainst(exec, root, base),
		ledger: () => listAgents(),
		agentDir: pi.pi.getAgentDir(),
		live: (ctx, run) => {
			if (run) {
				showRunStatus(ctx, run, runs.phase());
				return;
			}
			liveStatus.clear();
			// Finalization already dropped the controller's keys; the session's records only existed to close them.
			openWaits.clear();
			void syncSession(ctx).catch(() => undefined);
		},
	});

	/**
	 * The run a session's dialog blocks. A main-session dialog belongs to the run it directs; a child's belongs to the
	 * run its parent admitted it into. An unbound dialog is no run's wait.
	 */
	const waitRun = (ctx: ExtensionContext): string | undefined =>
		ctx.agent.kind === "main" ? runs.runId() : childLedger(ctx)?.runId;
	/**
	 * One session's tool call is one wait. Parallel children can carry the same provider tool-call id, so the key is
	 * the agent's kind and id plus the call id; an end can then never close a sibling's wait.
	 */
	const waitKey = (ctx: ExtensionContext, kind: "ask" | "approval", toolCallId: string): string =>
		`${ctx.agent.kind}:${ctx.agent.id}\0${kind}:${toolCallId}`;
	const openWait = (ctx: ExtensionContext, kind: "ask" | "approval", toolCallId: string): void => {
		const runId = waitRun(ctx);
		if (runId === undefined) return;
		const key = waitKey(ctx, kind, toolCallId);
		openWaits.set(key, { runId, key });
		noteRunUserWait(runId, key, true);
	};
	const closeWait = (ctx: ExtensionContext, kind: "ask" | "approval", toolCallId: string): void => {
		const key = waitKey(ctx, kind, toolCallId);
		const held = openWaits.get(key);
		if (held === undefined) return;
		openWaits.delete(key);
		noteRunUserWait(held.runId, held.key, false);
	};

	// The host's ask tool is the one real form-open signal a host emits: execution starts before the form waits and
	// ends when it is answered, cancelled or fails. A host with no UI cannot show the form, so it claims no wait.
	pi.on("tool_execution_start", (event, ctx) => {
		// A synchronous wait is the one mid-run tool call that can outlast the plan: if the context crossed the cap
		// since then, this boundary starts the automatic run's next background checkpoint. A manual run's wait tool
		// adds nothing; its async wait uses the same handoff directly.
		if (event.toolName === "wait") {
			if (ctx.agent.kind === "main") runs.startAutoCheckpoint();
			return;
		}
		if (!ctx.hasUI || event.toolName !== "ask" || !askWaits(event.args)) return;
		openWait(ctx, "ask", event.toolCallId);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "ask") return;
		closeWait(ctx, "ask", event.toolCallId);
	});
	// A tool approval is emitted only when a prompt is required; a no-UI host cannot answer one and claims no wait.
	pi.on("tool_approval_requested", (event, ctx) => {
		if (!ctx.hasUI) return;
		openWait(ctx, "approval", event.toolCallId);
	});
	pi.on("tool_approval_resolved", (event, ctx) => closeWait(ctx, "approval", event.toolCallId));

	const flowEnv = (ctx: ExtensionContext, startRun?: (spec: RunSpec) => Promise<RunRequestResult>): FlowEnv => ({
		...projectEnv(ctx),
		ompBin: ompBinary(),
		registry: ctx.modelRegistry,
		activeTools: pi.getActiveTools(),
		now: Date.now,
		activeRun: () => runs.active(),
		activePhase: () => runs.phase(),
		autoModeProblem: () => modeProblem(ctx),
		agents: () => listAgents({ ancestorId: ctx.agent.id }),
		ompSettings,
		newerVersion,
		// This conversation's own session directory, from the public session manager; empty where the host has none.
		sessionDir: sessionDirOf(ctx),
		...(startRun ? { startRun } : {}),
	});

	/** The session's own directory from the public session manager; empty when a host keeps its sessions in memory. */
	const sessionDirOf = (ctx: ExtensionContext): string => {
		try {
			return ctx.sessionManager?.getSessionDir() ?? "";
		} catch {
			return "";
		}
	};

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

	/** One counter for Storm's own tool dialogs; the key only has to differ while a dialog waits. */
	let toolDialogs = 0;
	/**
	 * Storm's `storm` tool can open its own approval dialogs mid-run. This observes that port only: every call is the
	 * original one, and a call made during a run marks a user wait until it settles. It never answers or replaces a
	 * prompt; the host's ask and tool-approval events are tracked separately.
	 */
	const observingUi = (ctx: ExtensionContext, ui: UiPort): UiPort => {
		const around = <T>(call: () => Promise<T>): Promise<T> => {
			const runId = runs.runId();
			if (!ctx.hasUI || runId === undefined) return call();
			const key = `storm-ui:${++toolDialogs}`;
			noteRunUserWait(runId, key, true);
			try {
				return Promise.resolve(call()).finally(() => noteRunUserWait(runId, key, false));
			} catch (error) {
				noteRunUserWait(runId, key, false);
				throw error;
			}
		};
		const form = ui.form;
		const pickModel = ui.pickModel;
		return {
			...ui,
			select: (title, options, context) => around(() => ui.select(title, options, context)),
			...(form === undefined ? {} : { form: (html: string) => around(() => form(html)) }),
			...(pickModel === undefined ? {} : { pickModel: (title: string, current?: Parameters<NonNullable<UiPort["pickModel"]>>[1]) => around(() => pickModel(title, current)) }),
		};
	};

	const toolHost = (ctx: ExtensionContext): StormToolHost => {
		const { ui, now, loadState, prepare, approveAndSave: save } = actionHost(ctx, observingUi(ctx, createUiPort(pi, ctx)));
		return {
			ui,
			now,
			loadState,
			prepare,
			approveAndSave: save,
			statusText: opts => statusText(flowEnv(ctx), opts),
			auto: () => ({
				enabled: auto.enabled,
				...(auto.problem !== undefined ? { blocked: auto.problem } : {}),
				...(auto.task !== undefined ? { task: auto.task } : {}),
			}),
			runtime: {
				requestRun: spec => runs.request(spec),
				replanConflict: plan => replanConflict(getLedgerRun(runs.runId())?.plan, plan),
				setRunPlan: plan => runs.setPlan(plan),
				submitCloseout: draft => runs.submitCloseout(draft),
				runActive: () => runs.runId() !== undefined,
				startWithPlan: async (spec: RunSpec, plan: RunPlan, validatedHash?: string) => {
					// Public plan mode means the user is still planning; an automatic run may not start there.
					const modes = ctx.sessionModes;
					if (modes !== undefined) {
						try {
							if (modes.getState().plan.status === "active") {
								return { ok: false, reason: "omp 계획 모드가 켜져 있어 자동 실행을 열지 않았습니다. 계획 모드를 끝낸 뒤 다시 요청하세요." };
							}
						} catch {
							return { ok: false, reason: "omp 계획 모드를 확인하지 못해 자동 실행을 열지 않았습니다. 다시 요청하세요." };
						}
					}
					const started = await runs.startWithPlan(ctx, spec, plan, validatedHash);
					// The first accepted automatic plan is a live tool boundary: the run's heavy pre-work context was
					// never preflight-compacted (and a sync subagent wait may never pause the agent loop). Start the one
					// background checkpoint now; omp commits it at its next turn/idle boundary. The already-oversized
					// first request cannot be prevented from here — the host classifies prompt size only after the
					// prompt has arrived — so this restores every request after that boundary, not that first one.
					if (started.ok) runs.startAutoCheckpoint();
					return started;
				},
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
			const runId = runs.runId();
			const result = await turn.call(ctx, {
				promptText,
				// The side turn bypasses run preflight and replays the live context. Bound the input before inference,
				// even when omp's last token estimate is stale. Its byte count also includes the host tool catalog.
				maxContextBytes: 4 * 1024 * 1024,
				// `tools: false` throws on some transports and drops the prompt cache: tool calls are discarded anyway.
				dedupeReply: false,
				minimizeEffort: true,
				purpose: "storm",
				...(runId === undefined
					? {}
					: {
							onUsage: message => {
								const usage = assistantUsage(message);
								if (!usage || usage.usd <= 0) return;
								if (runs.runId() === runId) runs.noteMainSpend(usage.usd);
								const run = recordCost(runId, usage.selector, usage.usd);
								if (run) touchRun(run.runId);
							},
						}),
			});
			return result.replyText;
		};
	};

	// A decision that fails or outlasts omp's handler budget blocks storm-* agents and any agent during a run: omp
	// would otherwise run the spawn on its own model, unrecorded and uncounted.
	pi.on("before_subagent_spawn", (event, ctx) => {
		// Automatic delegation never lets the main session spawn its way around the plan: before the first plan
		// opens a run, every spawn is refused. This is checked before any state read, so it also holds when the
		// team config or approval cannot be read; subagent sessions are not fenced by this session's policy.
		if (ctx.agent.kind === "main" && auto.enabled && runs.runId() === undefined) {
			return { block: true, reason: autoRefusal(auto.problem, AUTO_SPAWN_REASON) };
		}
		const limit = deadline(SPAWN_DECISION_MS);
		let timedOut = false;
		void limit.expired.catch(() => {
			timedOut = true;
		});
		const artifacts = artifactsOf(ctx);
		// The admitted run is fixed for this spawn: a later start in the same tree must not receive its record.
		const captured = ctx.agent.kind === "main" ? getLedgerRun(runs.runId()) : childLedger(ctx);
		const capturedRunId = captured?.runId;
		// A child that once worked in a run but has no current binding is scope-uncertain: its nested spawn must not
		// attach to whatever run happens to be active in the same tree.
		if (ctx.agent.kind === "sub" && captured === undefined && listAgents().some(agent => agent.id === ctx.agent.id && agent.runId !== undefined)) {
			return {
				block: true,
				reason: blockText({ code: "internal", reason: "이 서브에이전트의 실행 소속을 확인하지 못해 새 스폰을 막았습니다. 실행 상태를 확인한 뒤 다시 시도하세요." }),
			};
		}
		const closed = (): SpawnDecision => ({
			block: true,
			reason: blockText({ code: "internal", reason: "Storm 실행 원장이 끝났거나 닫혀 이 스폰을 허용하지 않았습니다. 실행 상태를 다시 확인하세요." }),
		});
		const ledgerBlock = (reason: string, run: LedgerRun, now: number): SpawnDecision => {
			const block = { code: "internal" as const, reason };
			if (getLedgerRun(run.runId) === run) noteRunSpawn(run.runId, blockedSpawn(event, block, now));
			return { block: true, reason: blockText(block) };
		};
		// A controller run whose ledger disappeared is a scope we cannot admit into.
		if (ctx.agent.kind === "main" && runs.runId() !== undefined && captured === undefined) return closed();
		const decide = async (): Promise<SpawnDecision> => {
			// Recheck the captured run rather than a repo or cwd match; a close or a new run is not this spawn's owner.
			const run = capturedRunId === undefined ? undefined : getLedgerRun(capturedRunId);
			if (capturedRunId !== undefined && (run === undefined || run.closing)) return closed();
			if (ctx.agent.kind === "main" && auto.enabled && runs.runId() === undefined) {
				return { block: true, reason: autoRefusal(auto.problem, AUTO_SPAWN_REASON) };
			}
			// Outside a run only storm-* agents are Storm's business.
			if (!event.agent.startsWith(ROLE_AGENT_PREFIX) && capturedRunId === undefined) return undefined;
			// An isolated child still routes by the main worktree's approved team.
			const state = await stateCache.get(run ? runEnv(ctx, run.root) : projectEnv(ctx));
			if (timedOut) return closed();
			if (run !== undefined && state.repo.root !== run.root) return closed();
			const root = state.repo.root;
			// One decision at a time per project, so parallel spawns never read the same trial counters or live counts.
			return serialized(`spawn:${root}`, async () => {
				if (timedOut) return closed();
				const now = Date.now();
				const current = capturedRunId === undefined ? undefined : getLedgerRun(capturedRunId);
				if (capturedRunId !== undefined && (current === undefined || current.closing)) return closed();
				const [quotaMarks, trials] = await Promise.all([readQuotaMarks(root, now), readTrialStates(root)]);
				const outcome = decideSpawn(
					event,
					{ config: state.config, approval: state.approval, shadows: state.shadows },
					{
						now,
						quotaMarks,
						trials,
						...(current
							? {
									run: {
										runId: current.runId,
										costUsd: current.costUsd,
										...(current.budget ? { budget: current.budget } : {}),
										...(current.plan ? { plan: current.plan } : {}),
										active: activeAgents(runSpawns(current.runId), listAgents({ runId: current.runId }), now),
									},
								}
							: {}),
					},
				);
				const record = outcome.record;
				const allowed = outcome.decision === undefined || !("block" in outcome.decision);
				if (timedOut) return closed();
				if (!allowed) {
					if (record?.trialId) {
						const trialId = record.trialId;
						const routed = record.outcome === "trial" ? 1 : 0;
						if (routed && record.spawnKey) noteTrialSpawn(record.spawnKey, trialId);
						const trial = state.config.status === "ok" ? state.config.config.trials?.find(t => t.id === trialId) : undefined;
						// The decision stands even when the counter file cannot be written.
						await updateTrialState(root, trialId, current => markTrialStop(trial, { ...current, seen: current.seen + 1, routed: current.routed + routed }, now)).catch(() => undefined);
					}
					if (record && current) noteRunSpawn(current.runId, record);
					return outcome.decision;
				}
				if (timedOut) return closed();
				if (current !== undefined) {
					const config = state.config.status === "ok" ? state.config.config : undefined;
					const plan = current.plan;
					// The director's task call was rewritten to a reserved lane before the host allocated this spawn.
					if (ctx.agent.kind === "main" && plan !== undefined && config !== undefined) {
						if (record === undefined) {
							if (auto.enabled) return ledgerBlock("스폰 기록을 만들지 못해 자동 위임 레인을 확인할 수 없습니다. 다시 스폰하세요.", current, now);
						} else {
							const lane = runs.runLanes()?.admit(record, auto.enabled ? undefined : { plan, config });
							if (lane !== undefined) record.lane = lane;
							else if (auto.enabled) return ledgerBlock("자동 위임에서 레인 배정을 확인하지 못해 스폰을 막았습니다. plan을 다시 제출하고 레인의 역할과 이름을 맞추세요.", current, now);
						}
					}
					const spawnKey = event.spawnKey;
					if (spawnKey === undefined) {
						return ledgerBlock("호스트가 스폰 키를 주지 않아 자식 실행을 결속하지 못했습니다. 다시 스폰하세요.", current, now);
					}
					if (!bindLedgerChild(current.runId, spawnKey, ctx.agent.id, artifacts)) {
						return ledgerBlock("자식 실행을 원장에 결속하지 못했습니다. 실행 상태를 확인한 뒤 다시 스폰하세요.", current, now);
					}
				}
				if (timedOut) return closed();
				if (record?.trialId) {
					const trialId = record.trialId;
					const routed = record.outcome === "trial" ? 1 : 0;
					if (routed && record.spawnKey) noteTrialSpawn(record.spawnKey, trialId);
					const trial = state.config.status === "ok" ? state.config.config.trials?.find(t => t.id === trialId) : undefined;
					await updateTrialState(root, trialId, current => markTrialStop(trial, { ...current, seen: current.seen + 1, routed: current.routed + routed }, now)).catch(() => undefined);
				}
				if (record && current) noteRunSpawn(current.runId, record);
				return outcome.decision;
			});
		};
		return failClosed(event.agent, () => capturedRunId !== undefined || auto.enabled || anyLedgerRun(), decide, {
			expired: limit.expired,
			onBlock: block => {
				// Only the run captured at entry may receive the blocked record: never a fresh run in the same tree.
				const run = getLedgerRun(capturedRunId);
				if (run) noteRunSpawn(run.runId, blockedSpawn(event, block, Date.now()));
			},
		}).finally(limit.cancel);
	});

	pi.on("message_end", async (event, ctx) => {
		const usage = assistantUsage(event.message);
		if (!usage) return;
		const ledger = ctx.agent.kind === "main" ? getLedgerRun(runs.runId()) : childLedger(ctx);
		if (ctx.agent.kind === "sub" && ledger) noteAgentRun(ctx.agent.id, ledger.runId);
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
		const run = ledger === undefined ? undefined : recordCost(ledger.runId, usage.selector, usage.usd);
		if (run) touchRun(run.runId);
		// A trial's budget counts what the subagents routed to its candidate spend on that candidate.
		if (ctx.agent.kind !== "sub") return;
		const repo = await repoFor(ctx);
		const root = ledger?.root ?? repo.root;
		const load = await cachedConfig(root);
		const trialId = load.status === "ok" ? trialCharge(ctx.agent.id, usage.selector, load.config) : undefined;
		if (trialId === undefined) return;
		const trial = load.status === "ok" ? load.config.trials?.find(t => t.id === trialId) : undefined;
		await updateTrialState(root, trialId, current => markTrialStop(trial, { ...current, costUsd: current.costUsd + usage.usd }, Date.now()));
	});

	// Agent ledger: each subagent session reports its own turns and end; omp offers no parent-side view of them.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind === "main") {
			// Only an ordinary prompt carries a user request. A revive has no prompt, and Storm's own run messages
			// are generated continuations: neither may capture or replace the task a plan opens.
			if (event.reason !== "prompt") return undefined;
			const prompt = typeof event.prompt === "string" ? event.prompt : "";
			if (prompt.trim() === "") {
				// A photo-only or empty prompt cannot become a text run task; a later plan refuses it explicitly.
				if (runs.runId() === undefined) auto.task = undefined;
				return undefined;
			}
			const runMessage = prompt.trimStart().startsWith("<storm-run ");
			if (!runMessage) {
				// The first ordinary prompt of a turn is its task. Later synthetic continuations, tool-loop
				// reminders and steers must not replace it; a prompt while this session directs is run context.
				if (runs.runId() === undefined && auto.task === undefined) auto.task = prompt;
				await refreshAuto(ctx, () => stateCache.get(projectEnv(ctx)));
			}
			if (!auto.enabled || event.systemPrompt.includes(AUTO_INSTRUCTION)) return undefined;
			// Append only: the prompt itself is the host's, and this block is stable between turns.
			return { systemPrompt: [...event.systemPrompt, AUTO_INSTRUCTION] };
		}
		const { id, name, parentId } = ctx.agent;
		const artifacts = artifactsOf(ctx);
		childWorkTrees.set(reviewerBaselineKey(artifacts, id), ctx.cwd);
		const ledger = childLedger(ctx);
		const runId = ledger?.runId;
		noteAgentStart({
			id,
			name,
			...(parentId ? { parentId } : {}),
			...(name.startsWith(ROLE_AGENT_PREFIX) ? { role: name.slice(ROLE_AGENT_PREFIX.length) } : {}),
			...(runId ? { runId } : {}),
			now: Date.now(),
		});
		if (runId) touchRun(runId);
		const roleChild = name.startsWith(ROLE_AGENT_PREFIX);
		// Outside a run, only Storm roles need the team (docs); a child in a run may also be the approved reviewer.
		if (!ledger && !roleChild) return undefined;
		// An isolated child still reads the main worktree's approved team for docs and reviewer identity.
		const state = await stateCache.get(ledger ? runEnv(ctx, ledger.root) : projectEnv(ctx));
		const approvedConfig = state.config.status === "ok" && isApproved(state) ? state.config.config : undefined;
		if (ledger && name === approvedReviewer(approvedConfig)) {
			// Snapshot before the reviewer's first provider request. On an isolated team this also fingerprints the
			// reviewer's own checkout: its verdict can certify the parent only while both copies still match exactly.
			await recordReviewerBaseline(exec, artifacts, id, ledger, ctx.cwd);
		}
		// Doc rules ride on a Storm role's system prompt (first turn and revive) while the team keeps docs on.
		if (!roleChild) return undefined;
		const section = state.config.status === "ok" ? docPromptFor(name, state.config.config) : undefined;
		return section && !event.systemPrompt.includes(section) ? { systemPrompt: [...event.systemPrompt, section] } : undefined;
	});

	// Director mode: blocking the call instead of swapping the tool list keeps the main session's prompt cache intact.
	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			// A subagent's reads are indexed under the run its parent admitted; no cwd or repo match is trusted.
			if (event.toolName !== "read") return undefined;
			const ledger = childLedger(ctx);
			if (!ledger) return undefined;
			const runId = ledger.runId;
			noteAgentRun(ctx.agent.id, runId);
			noteChildRead(runId, ctx.agent.id, pathOf(event.input), ctx.cwd);
			return undefined;
		}
		const runId = runs.runId();
		if (runId === undefined) {
			// Automatic delegation: the main session may orchestrate and inspect worker results, but every repository
			// tool and every direct spawn is refused until the first plan opens this turn's run.
			if (!auto.enabled || event.toolName === "storm") return undefined;
			const detail =
				event.toolName === "task" ? AUTO_SPAWN_REASON : supervisorToolBlock(event.toolName, event.input);
			if (detail === undefined) return undefined;
			return { block: true, reason: autoRefusal(auto.problem, detail) };
		}
		// Automatic delegation keeps the strict supervisor gate during the run too: bash, eval, unknown tools and
		// every repository file read stay refused, while task and published worker results remain reachable. The
		// legacy director checks (follow-up caps, wide re-reads, edits) still run after this narrower gate.
		if (auto.enabled) {
			const strict = supervisorToolBlock(event.toolName, event.input);
			if (strict !== undefined) return { block: true, reason: autoRunRefusal(strict) };
		}
		const config = runs.runConfig();
		if (!config) return undefined;
		const block = decideToolCall({ toolName: event.toolName, input: event.input, cwd: ctx.cwd, runId, config, agents: listAgents() });
		if (block) {
			if (block.code === "director-edit") runs.noteBlockedEdit();
			else if (block.code === "read-large") runs.noteBlockedRead();
			else runs.noteBlockedFollowUp();
			return { block: true, reason: blockText(block) };
		}
		// Every native task call is placed before omp allocates its spawn id: auto direction also reserves a lane name,
		// manual direction keeps the caller's handle. The plan decides isolation for both; a direct isolated claim
		// without a planned exception is refused, never guessed.
		if (event.toolName === "task") {
			const plan = getLedgerRun(runId)?.plan ?? runs.active()?.plan;
			const lanes = runs.runLanes();
			if (lanes === undefined) {
				return { block: true, reason: "[storm:isolation] 이 실행의 레인 배정을 확인하지 못해 task를 막았습니다. 실행 상태를 확인한 뒤 다시 스폰하세요." };
			}
			const host = needsIsolationHost(plan, config) ? await isolationHost(runId) : undefined;
			const options = host === undefined ? {} : { host };
			if (auto.enabled && plan === undefined) {
				return { block: true, reason: "[storm:auto] 계획을 확인하지 못해 task를 막았습니다. plan을 다시 제출하세요." };
			}
			const placed =
				auto.enabled && plan !== undefined
					? lanes.assign(event.input, plan, config, options)
					: lanes.place(event.input, plan, config, options);
			if (!placed.ok) return { block: true, reason: `${auto.enabled ? "[storm:auto]" : "[storm:isolation]"} ${placed.reason}` };
			return placed.input === event.input ? undefined : { input: placed.input };
		}
		// A follow-up to a reused reviewer starts new work: take both tree baselines before the write executes. A
		// reused isolated reviewer is certified only when its checkout matches the parent at that same moment.
		const followTarget = deliveredFollowUp(event.toolName, event.input, false);
		const followAgent = followTarget === undefined ? undefined : followUpAgent(listAgents(), followTarget);
		if (followAgent !== undefined && followAgent.name === approvedReviewer(config)) {
			const run = getLedgerRun(runId);
			const key = reviewerBaselineKey(artifactsOf(ctx), followAgent.id);
			const cwd = childWorkTrees.get(key);
			if (run !== undefined && cwd !== undefined) await recordReviewerBaseline(exec, artifactsOf(ctx), followAgent.id, run, cwd);
			else reviewerBaselines.delete(key);
		}
		return undefined;
	});

	// Every compaction of a directing session, omp's own included, keeps Storm's view of the run.
	pi.on("session.compacting", () => {
		const run = runs.active();
		return run ? { context: workingState(run, listAgents()) } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			// The parent admitted this id before the spawn returned: no cwd or repo match is trusted here.
			const ledger = childLedger(ctx);
			if (ledger) noteAgentRun(ctx.agent.id, ledger.runId);
			// A reviewer's structured verdict arrives through its `yield`; it lands on the ledger entry and from there in the run record.
			const now = Date.now();
			if (event.toolName === "yield" && !event.isError) {
				noteAgentReview(ctx.agent.id, event.input, now);
				// Await the bounded snapshot before the turn can settle: the gate never reads a tree this verdict forgot.
				if (ledger !== undefined && verdictOf(event.input) !== undefined) await bindReviewerVerdict(exec, ctx, ledger, now);
			}
			// The review gate reads what the team changed; a file-changing call that failed changed nothing.
			if (!event.isError && changesFiles(event.toolName, event.input)) noteAgentChange(ctx.agent.id, now);
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
		// A follow-up counts when its write was delivered, for the agent omp resolved it to. That delivery also admits
		// a reused live agent into this run, and gives a reused reviewer a fresh baseline before its next turn.
		const target = deliveredFollowUp(event.toolName, event.input, event.isError);
		const agent = target === undefined ? undefined : followUpAgent(listAgents(), target);
		if (!agent) return undefined;
		noteAgentFollowUp(agent.id);
		bindLedgerChild(runId, agent.id, agent.parentId ?? ctx.agent.id, artifactsOf(ctx));
		return undefined;
	});

	pi.on("agent_start", () => {
		runs.onAgentStart();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			const ledger = childLedger(ctx);
			if (ledger) noteAgentRun(ctx.agent.id, ledger.runId);
			const settled = !(event.willContinue || event.awaitingAsyncWork);
			const failed = settled ? terminalWorkFailed(event.messages) ?? listAgents().find(agent => agent.id === ctx.agent.id)?.lastWorkFailed : undefined;
			noteAgentEnd({
				id: ctx.agent.id,
				now: Date.now(),
				settled,
				...(settled && failed !== undefined ? { failed } : {}),
			});
			// After the ledger says settled: the run's phase reads it, so touching the run before the update would
			// leave the last worker or reviewer looking active until another event.
			if (ledger) touchRun(ledger.runId);
			return;
		}
		// Paused on async subagents: the moment to shed context before their results arrive. Both manual and automatic
		// runs use the same background handoff, so the recorded ledger is identical.
		if (event.awaitingAsyncWork) runs.startCheckpoint();
		// Ends the run when the session settles; a queued run starts detached from this handler.
		await runs.onAgentEnd(event, ctx);
		if (!event.willContinue) {
			// The user turn is over, including a paused async wait: the next prompt must supply its own task.
			auto.task = undefined;
		}
		if (!event.willContinue && !event.awaitingAsyncWork) {
			// A plugin update installed meanwhile shows up on the status line without waiting for /storm.
			await syncSession(ctx).catch(() => undefined);
		}
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
		if (ctx.agent.kind === "sub") {
			noteAgentParked(ctx.agent.id);
			const key = reviewerBaselineKey(artifactsOf(ctx), ctx.agent.id);
			reviewerBaselines.delete(key);
			childWorkTrees.delete(key);
		} else {
			resetCloseoutChoices(ctx);
		}
		// No status load or widget from before the shutdown may land after it.
		liveStatus.beginSession();
		openWaits.clear();
		await runs.finish("shutdown");
	});

	// /new, /resume or a fork puts another conversation in this session: the run's handoff is not in it.
	pi.on("session_switch", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		liveStatus.beginSession();
		openWaits.clear();
		resetCloseoutChoices(ctx);
		auto.task = undefined;
		await runs.finish("shutdown", ctx);
		// The same profile and repository keep the policy, but a fresh conversation gets the durable consent file.
		await syncSession(ctx).catch(() => undefined);
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
	/**
	 * The user-authorized way into a manual run, shared by /storm <request> and a closeout direction pick. It reads
	 * no automatic-delegation consent and never touches supervisor tools: a pick starts the same run /storm would.
	 */
	const startUserRun = async (ctx: ExtensionContext, spec: RunSpec): Promise<RunRequestResult> => {
		const reason = runs.refusal();
		if (reason !== undefined) return { ok: false, reason };
		await activateTool();
		return runs.start(ctx, spec);
	};

	/**
	 * A closeout direction is chosen by the user typing its number, not by a model tool. Only direct interactive
	 * text from this main session can reach it; the controller accepts an exact 1-3 while one just-finished run
	 * still offers them and invalidates the offer on any other real input. The pick starts asynchronously through
	 * the same user-authorized path as /storm, so no streaming turn is awaited and no input is generated here.
	 */
	pi.on("input", (event, ctx) => {
		// A host with no UI never showed the menu; its text is not a choice, even if a stale card was recorded.
		if (event.source !== "interactive" || ctx.agent.kind !== "main" || !ctx.hasUI) return undefined;
		const direction = takeCloseoutChoice(ctx, event.text);
		if (direction === undefined) return undefined;
		// An image or a busy session cannot be a numbered pick: the input keeps its normal path, and the offer is gone.
		if (event.images?.length || !ctx.isIdle()) return undefined;
		const refusal = runs.refusal();
		if (refusal !== undefined) {
			if (ctx.hasUI) ctx.ui.notify(`Storm 실행을 시작하지 못했습니다: ${refusal}`, "warning");
			return { handled: true };
		}
		void startUserRun(ctx, { task: direction }).then(
			result => {
				if (!result.ok && ctx.hasUI) ctx.ui.notify(`Storm 실행을 시작하지 못했습니다: ${result.reason}`, "warning");
			},
			(error: unknown) => {
				if (ctx.hasUI) ctx.ui.notify(`Storm 실행을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
			},
		);
		return { handled: true };
	});

	/** Refreshes the status line and turns the storm tool on once the project has a Storm config. */
	const syncSession = async (ctx: ExtensionContext, loaded?: ProjectState): Promise<void> => {
		const epoch = liveStatus.epoch();
		const state = loaded ?? (await loadProjectState(projectEnv(ctx)));
		// The durable consent file is read on every session refresh: a session switch or a command sees an external
		// change at once, and a failed read keeps the last enabled guard instead of unfencing direct tools.
		await refreshAuto(ctx, async () => state);
		if (!liveStatus.isCurrent(epoch)) return;
		// A missing config needs no tool normally; under automatic delegation the plan must be reachable to report
		// the missing team as an actionable refusal instead of leaving the main session to direct tools.
		if (state.config.status !== "missing" || auto.enabled) await activateTool();
		if (!liveStatus.isCurrent(epoch)) return;
		if (!ctx.hasUI) {
			liveStatus.clear();
			return;
		}
		// A status refresh during a run must not put the idle label over the live one.
		const run = runs.active();
		if (run) {
			showRunStatus(ctx, run, runs.phase());
			return;
		}
		const resumable = isApproved(state) && (await findResumeCandidate(state.store.dir, state.repo.root)) !== undefined;
		// The await above may have outlasted a switch, or a queued run may have started meanwhile.
		if (!liveStatus.isCurrent(epoch)) return;
		const started = runs.active();
		if (started) {
			showRunStatus(ctx, started, runs.phase());
			return;
		}
		liveStatus.clear();
		ctx.ui.setStatus("storm", idleStatusText(ctx, state, resumable, auto));
	};

	pi.on("session_start", async (_event, ctx) => {
		// Subagents never manage the team: no tool, no status line.
		if (ctx.agent.kind !== "main") return;
		const epoch = liveStatus.beginSession();
		resetCloseoutChoices(ctx);
		try {
			const state = await loadProjectState(projectEnv(ctx));
			// A run whose process died stays `running` until a later run ends; here it becomes the last run and resumable.
			await stopDeadRuns({ root: state.repo.root });
			if (!liveStatus.isCurrent(epoch)) return;
			await syncSession(ctx, state);
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
			const matches = SHORTCUTS.filter(hint => hint.value.startsWith(typed));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const ui = createUiPort(pi, ctx);
			// What the user runs sees the registry, quota and settings as they are now (a provider login just made);
			// the flows inside this command and the model's tool calls share one analysis.
			invalidateAnalysis(ctx.cwd);
			/** Starts a run in this session, as a request does: refused while one is active, started once the session is idle. */
			const startRun = async (spec: RunSpec): Promise<RunRequestResult> => {
				// Refused before waiting: during a run the session is busy until that run ends.
				const reason = runs.refusal();
				if (reason !== undefined) return { ok: false, reason };
				await ctx.waitForIdle();
				return startUserRun(ctx, spec);
			};
			const env = flowEnv(ctx, startRun);
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
				else if (input === "auto") await autoDelegationFlow(env, ui);
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
							run: spec => startRun(spec),
							menu,
							status: () => statusFlow(env, ui),
							models: () => modelsFlow(env, ui),
							agents: () => agentsFlow(env, ui),
							resume: text => resumeFlow(env, ui, text),
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
