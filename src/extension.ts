/**
 * OMP Storm extension: /storm, the storm tool, spawn-time enforcement of the approved team, and Storm runs (handoff,
 * run-scoped policy, budget, telemetry). The handlers here gather inputs, call the policy, request and runtime modules
 * and apply their results. Storm's only messages to the main session are a run's handoff and the rounds it starts;
 * everything else is decided in dialogs and overlays. Module-level state is shared by every session in the process,
 * because subagent sessions reuse this module.
 */
import { readFileSync, realpathSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, type SessionModeState, type ToolCallEvent, type ToolCallEventResult, type ToolResultEvent, type ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { readAutoDelegation } from "./approval/auto.ts";
import { resolveRepo } from "./approval/repo.ts";
import { isRecord } from "./config/schema.ts";
import { invalidateAnalysis, prepareAnalysis } from "./context.ts";
import { readQuota } from "./discovery/quota.ts";
import { liveIsolationSettings, liveTaskMaxConcurrency, liveToolCallTimeoutMs, readExplicitSettings } from "./discovery/settings.ts";
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
import { directorFileChange, pathOf } from "./policy/director.ts";
import {
	DIRECTOR_CONTROL_REASON,
	DIRECTOR_SERVICE_REASON,
	directorNeedsTree,
	startsService,
	WORKER_SERVICE_REASON,
} from "./policy/director-exec.ts";
import { approvedEntries, checkChildModelAgainst, modelMismatchNotice, probeCredentialsDetailed, selectorOf, teamSelectors, withinDeadline, type ChildCheck } from "./policy/model-check.ts";
import { docPromptFor } from "./policy/docs.ts";
import { agentControlTarget, deliveredFollowUp, deliveryOutcome, deliveryWokeTurn, followUpAgent, followUpFailureNote, followUpProgress, followUpTarget } from "./policy/followup.ts";
import {
	canonicalScope,
	effectiveAgentTools,
	lanePolicy,
	pathWriteTool,
	readOnlyIntent,
	readOnlyTool,
	reviewLane,
	shellReader,
	targetWithinScope,
	toolWriteTargets,
	type LanePolicy,
} from "./policy/capability.ts";
import { directorRead, noteChildRead } from "./policy/reads.ts";
import {
	activeAgents,
	blockedSpawn,
	blockText,
	clearWorkerSlots,
	countedRole,
	deadline,
	decideSpawn,
	followUpBudgetBlock,
	failClosed,
	releaseWorkerSlot,
	reservedWorkers,
	reserveWorkerSlot,
	SPAWN_DECISION_MS,
	usableRole,
	type WorkerSlot,
	workerSlot,
} from "./policy/spawn.ts";
import { supervisorRunToolBlock, supervisorToolBlock, type SupervisorScope, type SupervisorScopeSource } from "./policy/supervisor.ts";
import * as threadPolicy from "./policy/thread.ts";
import { decideDirectorCall } from "./policy/toolcall.ts";
import { PACKAGE_JSON, ROLE_AGENT_PREFIX, ROLES, STORM_VERSION } from "./roles.ts";
import {
	forgetRunAgents,
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
	registryAgentIds,
} from "./runtime/agents.ts";
import {
	DIRECTOR_REWRITTEN,
	DIRECTOR_WRITE_ENDING,
	DIRECTOR_WRITE_MOVED,
	DIRECTOR_WRITE_NO_CALL,
	DIRECTOR_WRITE_NO_TARGET,
	completedAssistantMessage,
	directorCallIds,
	directorTurnClean,
	directorWriteBlock,
	isAssistantMessage,
} from "./runtime/arbiter.ts";
import { checkpointWorkState, workingState } from "./runtime/checkpoint.ts";
import { laneContract } from "./runtime/contract-text.ts";
import { parseAdjustCommand, parseAdjustment } from "./runtime/adjust.ts";
import { AttemptCollector, type AttemptHostJob } from "./runtime/attempt-collector.ts";
import { noteRunNotice, noteRunRan, noteRunSpawn, noteRunStopped, noteRunUserWait, RunController, runSpawns, touchRun } from "./runtime/controller.ts";
import { RefusedCalls, refusedTaskInput, refusedTaskResult } from "./runtime/task-refusal.ts";
import { broadcastBlock, noteLaneAgentEnd, noteLaneAgentStart, onLaneReservationEnd, replanConflict, taskLaneProblem, type LaneReadinessView, type ReservationEnd, type TaskIsolationHost } from "./runtime/lanes.ts";
import { bindLedgerChild, anyLedgerRun, getLedgerRun, ledgerRunForChild, ledgerRunForLineage, ledgerRunForTree, recordCost, type LedgerRun } from "./runtime/ledger.ts";
import { mayMakeSideCalls, settleSideSpend } from "./runtime/side-spend.ts";
import { stopDeadRuns } from "./runtime/janitor.ts";
import { sharedMap } from "./runtime/thread-state.ts";
import { closeoutHandoff, closeoutSessionId, resetCloseoutChoices, takeCloseoutChoice } from "./runtime/closeout.ts";
import { DecisionRequests, decisionAsk } from "./runtime/decisions.ts";
import { credentialNotice, fallbackQuotaMark, quotaNotice } from "./runtime/quota-auto.ts";
import { verdictOf } from "./runtime/review.ts";
import { addQuotaMark, readQuotaMarks, readTrialStates, updateTrialState } from "./runtime/state-files.ts";
import { markTrialStop, noteTrialSpawn, trialCharge } from "./runtime/trials.ts";
import { findResumeCandidate, resumeSpec, trustedResume } from "./runtime/resume.ts";
import { isRunId, readRun } from "./runtime/run.ts";
import { TREE_READ_TIMEOUT_MS, treeAgainst, type TreeReading } from "./runtime/tree.ts";
import { timingsOf, type TimingOverrides } from "./runtime/timings.ts";
import { newerInstalledVersion } from "./runtime/version.ts";
import { type ActionHost, runChange } from "./request/actions.ts";
import { routeRequest } from "./request/route.ts";
import { sessionStoreDir } from "./session-scope.ts";
import { createStateCache, isApproved, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { RunRequestResult, StormToolHost } from "./tool/host.ts";
import { createStormTool } from "./tool/storm-tool.ts";
import type {
	Effort,
	ExplicitSettings,
	Exec,
	InfoTone,
	PlanLane,
	RanModel,
	RepoIdentity,
	RunPlan,
	RunRecord,
	RunSpec,
	ShadowInfo,
	SpawnDecision,
	SpawnBlockCode,
	StormConfig,
	UiPort,
	WorkerStopReason,
} from "./types.ts";
import { createUiPort, registerReportRenderer } from "./ui.ts";
import { isLiveTui, LiveStatus } from "./view/live.ts";
import { idleAppearance, RUN_APPEARANCE, STORM_MARK, type RunPhase } from "./view/appearance.ts";
import { boundedHandoff, runStatusText } from "./view/render.ts";
import { plannedResultLabels } from "./view/results.ts";
import {
	activeWorkerRunInTree,
	admissionKey,
	endWorkerAdmission,
	persistWorkerAdmission,
	readChildBinding,
	readWorkerAdmission,
	readWorkerStops,
	recordWorkerStop,
	resolveWorkerAdmission,
	revokeWorkerAdmissions,
	type ChildBinding,
	type WorkerAdmissionRecord,
	type WorkerStopReading,
} from "./worker-admission.ts";

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
	{ value: "auto", label: "auto", description: "자동 위임 켜기/끄기(이 세션)" },
	{ value: "view", label: "view", description: "레인 뷰 켜기/끄기(이 세션)" },
	{ value: "setup", label: "setup", description: "팀 다시 설정" },
	{ value: "reset", label: "reset", description: "Storm 설정과 기록 초기화" },
] as const;
const SHORTCUT_NAMES: readonly string[] = SHORTCUTS.map(shortcut => shortcut.value);
/** Said when omp ran a `task` call that Storm had refused; the refusal did not hold. */
const REFUSAL_NOT_HELD = "Storm이 거절한 task 호출을 OMP가 실행했습니다. Storm은 그 호출이 끝나기 전까지 워커 스폰을 막았으므로 새 워커는 쓰기 권한을 받지 못했어야 하지만, 결과가 오류가 아니니 레인과 워커 상태를 /storm status로 확인하세요.";

/** A bounded local pause; no host channel is polled. */
async function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** One Storm worker's approved write authority; the root is the shared tree (or its claimed private checkout). */
interface AgentAuthority {
	policy: LanePolicy;
	/** Shared target root, or the claimed private checkout when `checkout` is present. */
	root: string;
	/** Physical private checkout of an isolated lane; path writes must stay inside it. */
	checkout?: string;
	/** Planned lane name for a compact refusal; absent for an unplanned child. */
	lane?: string;
}

/** Workers admitted by this process's Storm runs (same native id across follow-ups), scoped by artifact tree. */
const agentAuthorities = new Map<string, AgentAuthority>();
/** Which spawn decision reserved a worker slot: a late refusal releases only the slot its own decision holds. */
const slotOwners = new WeakMap<WorkerSlot, symbol>();

/** Follow-up tool calls that created the worker's slot; a failed delivery releases only that new slot, never one a
 * work-bearing note to an already running worker reused. */
const followCapacityCalls = new Map<string, { runId: string; agentId: string }>();
/** The follow-up dispatches an admitted `write agent://<id>` opened, by run and call id: dropped if the write never lands. */
const followDispatches = new Map<string, string>();
/** The work messages that went to a worker the agent list showed idle, by run and call id: the turn each wakes is a delivery Storm asked for. */
const followWakeCalls = new Set<string>();
/**
 * What the director reads in the result of a call that started a lane ahead of a prerequisite (see `dependencyStart`),
 * by run and call id: set when the call is admitted, read by that call's own result, dropped if the call fails.
 */
const startNotes = new Map<string, string[]>();
/** What Storm's own generated user messages start with: a round message and an adjustment nudge. Never the user's words. */
const STORM_MESSAGE_TAGS = ["<storm-run ", "<storm-adjust "] as const;

/** OMP agent ids are unique inside one artifact tree, not across profiles or sessions. */
function authorityKey(artifacts: string | undefined, agentId: string): string {
	return `${artifacts ?? ""}\0${agentId}`;
}

/**
 * Children stopped because the model or effort of their own request was not the one approved for their role, by the
 * child's authority key. A stopped child may only report: every tool call but `yield` is refused. Module state, shared by
 * the sessions of this thread.
 */
const stoppedChildren = sharedMap<string, string>("storm.extension.stoppedChildren");

/** The reasoning level a child reports, in the team's own scale; "off" is below every approved effort, unknown levels are unread. */
function observedEffort(level: unknown): string | undefined {
	if (typeof level !== "string") return undefined;
	if (level === "off") return "minimal";
	return level === "inherit" || level === "auto" ? undefined : level;
}

/** Resolve the effective definition's tools and enforce the lane's approved capability; a blocked policy stops a spawn. */
async function authorityFor(input: {
	agent: string;
	lane: PlanLane | undefined;
	shadows: readonly ShadowInfo[];
	config: StormConfig;
	root: string;
	auto: boolean;
}): Promise<{ ok: true; authority: AgentAuthority } | { ok: false; reason: string }> {
	const tools = effectiveAgentTools(input.agent, input.shadows, PLUGIN_AGENTS_DIR);
	const policy = lanePolicy({
		lane: input.lane,
		tools,
		// Team-global isolation and one lane's explicit experiment are both a private checkout; a selective lane must
		// never be persisted as a shared writer just because the team itself is shared.
		isolated: input.config.isolation === "isolated" || input.lane?.isolationReason !== undefined,
		auto: input.auto,
	});
	if (policy.kind === "blocked") return { ok: false, reason: policy.reason };
	if (policy.kind !== "paths") {
		return { ok: true, authority: { policy, root: input.root, ...(input.lane === undefined ? {} : { lane: input.lane.name }) } };
	}
	const canonical = await canonicalScope(input.root, policy.paths);
	if (canonical === undefined) {
		return { ok: false, reason: `'${input.lane?.name ?? input.agent}' 레인의 쓰기 경로를 작업 트리 안에서 확인하지 못했습니다(symlink 또는 경로 이탈).` };
	}
	return {
		ok: true,
		authority: { policy: { ...policy, paths: canonical }, root: input.root, ...(input.lane === undefined ? {} : { lane: input.lane.name }) },
	};
}

async function policiesForPlan(
	plan: RunPlan,
	config: StormConfig,
	shadows: readonly ShadowInfo[],
	root: string,
	auto: boolean,
): Promise<{ ok: true; policies: Map<string, LanePolicy>; canonicalFiles: Map<string, readonly string[]> } | { ok: false; reason: string }> {
	const policies = new Map<string, LanePolicy>();
	const canonicalFiles = new Map<string, readonly string[]>();
	for (const lane of plan.lanes) {
		const agent = config.roles[lane.role]?.agent ?? ROLES.find(role => role.id === lane.role)?.agent;
		if (agent === undefined) return { ok: false, reason: `'${lane.name}' 레인의 역할 '${lane.role}'에 실행할 에이전트가 없습니다.` };
		const authority = await authorityFor({ agent, lane, shadows, config, root, auto });
		if (!authority.ok) return { ok: false, reason: authority.reason };
		policies.set(lane.name, authority.authority.policy);
		if (authority.authority.policy.kind === "paths") canonicalFiles.set(lane.name, authority.authority.policy.paths);
	}
	return { ok: true, policies, canonicalFiles };
}

/** The session's personal automatic-delegation policy, refreshed from the approval store. */
interface AutoStatus {
	/** The consent file said enabled at the last successful read; a later failure keeps this value. */
	enabled: boolean;
	/** Why an automatic run cannot start now: team config/approval or an omp session mode. */
	problem: string | undefined;
}

/**
 * The stable automatic-delegation bootstrap appended to the director's system prompt while auto is on. It keeps only
 * rules no refusal or schema can teach at the point of use: the ordinary-chat contract, what the director may do
 * itself (read and search; messages and notes), how it waits (it ends its turn: omp wakes it when a worker result
 * arrives, and each `wait` call costs a turn), the paid-miss finish/review rule and two decision points the real
 * session showed (a resent refusal, a status question). Live state (run ids, counts, job names, modes) never enters it,
 * so the prompt cache survives mode toggles and replans; refusals carry exact fixes.
 * Budget: AUTO_INSTRUCTION + DECISION_INSTRUCTION ≤ 1,300 UTF-8 bytes (the 0.24.0 pair was 4,209 B); tests enforce it.
 */
const AUTO_INSTRUCTION = `<storm-auto>
This session delegates project work automatically.
- General conversation needs no tools: answer directly.
- Inspection, verification and larger changes belong to the approved team: a storm plan opens this request's run; size it to the request. Use task for work lanes, storm execute for approved jobs. While workers run, end your turn: their results wake you. Do not ask the user whom to spawn.
- Read and search yourself; once the run is open, edit/write files. Shell, eval and MCP are the team's; notes go to local://<name>.md, messages to agent://<id> (?progress for a quiet note).
- Finish every declared result, even without edits. With a reviewer, verification needs the reviewer to accept the current tree.
- A resent refused call is refused again: read its reason. Run questions go to storm status, not a new plan.
</storm-auto>`;

/**
 * The stable native-ask contract shared by every active Storm director: the automatic director and the manual
 * director of a live run. It carries no run id, count or other live state, so appending it once per assembled prompt
 * keeps the prompt cache stable. The per-request decision history lives in the runtime, never in this text.
 */
const DECISION_INSTRUCTION = `<storm-decision>
Routine in-scope setup, checks and fixes need no confirmation.
Only a genuine user decision may use native ask: scope change, irreversible action or user choice. Put data-storm-decision="<stable-key>" and exactly one data-storm-reason (scope-change, irreversible-action, user-choice) on the main <form>; reuse the key across replans. Preselect nothing; a timeout or cancel is not consent. Ask once per request.
</storm-decision>`;

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

/**
 * Whether omp's plan mode is on right now, which is the only time `bash propose <slug>` is omp's plan submission and not a
 * shell command. A host with no mode state (print, RPC) or a state that cannot be read says nothing is on.
 */
function planModeOn(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionModes?.getState().plan.status === "active";
	} catch {
		return false;
	}
}

/** What a blocked direct call tells the model: why the session cannot run it now (if so) and the refusal's own cause. */
function autoRefusal(problem: string | undefined, detail: string | undefined): string {
	return `[storm:auto]${problem === undefined ? "" : ` ${problem}`}${detail === undefined ? "" : ` ${detail}`}`;
}

/**
 * Whether task placement needs host isolation at all. A shared team with no reason-marked lane is settled by the plan
 * alone, so it never pays for a settings read; an isolated team or any selective lane resolves it once per run.
 */
function needsIsolationHost(plan: RunPlan | undefined, config: StormConfig): boolean {
	return config.isolation === "isolated" || (plan?.lanes.some(lane => lane.isolationReason !== undefined) ?? false);
}

/**
 * Whether starting work under `plan` may write the target. An unplanned manual spawn is treated as a writer; a plan
 * whose every lane declares read-only intent (and no files) stays a reader, so concurrent read-only runs stay
 * independent. This mirrors the controller's own upgrade rule; the lease, not this predicate, is the authority.
 */
function planMayWrite(plan: RunPlan | undefined): boolean {
	if (plan === undefined) return true;
	// A review lane may run commands (the approved reviewer carries a shell), so a plan with one takes the write claim.
	return plan.lanes.some(lane => !readOnlyIntent(lane) || reviewLane(lane) || (lane.files?.length ?? 0) > 0);
}

/** The same refusal during an active automatic run: the detail names the one cause (edit, command, unknown tool, read that is not plain). */
function autoRunRefusal(detail: string | undefined): string {
	return `[storm:auto]${detail === undefined ? "" : ` ${detail}`}`;
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

/**
 * A subagent's run: the binding its parent recorded before the spawn was admitted, or else the chain of parents the host
 * registry names up to a bound worker or to the director of a live run in this artifact tree (an agent created after
 * the run began). A child of a child counts toward its run; an agent no chain reaches, or one of another session, does not.
 */
function childLedger(ctx: ExtensionContext): LedgerRun | undefined {
	const artifacts = artifactsOf(ctx);
	let registry: ReturnType<typeof AgentRegistry.global>;
	try {
		registry = AgentRegistry.global();
	} catch {
		return ledgerRunForChild(ctx.agent.id, ctx.agent.parentId, artifacts);
	}
	return ledgerRunForLineage(
		ctx.agent.id,
		ctx.agent.parentId,
		artifacts,
		{
			parentOf: id => registry.get(id)?.parentId,
			isMain: id => registry.get(id)?.kind === "main",
			createdAt: id => registry.get(id)?.createdAt,
		},
		() => ledgerRunForTree(artifacts),
	);
}

/**
 * The parent session's own async job rows (running, and the newest settled ones omp still lists), as host facts for
 * the attempt collector: a job's id, agent, status and start time tell one turn of a reused agent from another. An
 * older host without the snapshot gives none.
 */
function hostJobs(ctx: ExtensionContext): readonly AttemptHostJob[] {
	try {
		const snapshot = ctx.getAsyncJobSnapshot?.();
		return snapshot ? [...snapshot.running, ...snapshot.recent] : [];
	} catch {
		return [];
	}
}

/** Count native workers outside Storm only with proof that they belong to this session's task scheduler. */
function otherNativeWorkers(ctx: ExtensionContext, known: ReadonlySet<string>): number {
	const artifacts = artifactsOf(ctx);
	if (artifacts === undefined) return 0;
	const scope = resolvePath(artifacts) + sep;
	try {
		let active = 0;
		for (const ref of AgentRegistry.global().list()) {
			// Main agent ids are shared by several SDK sessions. The direct parent AND artifact scope must match.
			if (ref.kind === "sub" && ref.parentId === ctx.agent.id && ref.status === "running" && ref.session !== null &&
				ref.sessionFile !== null && !known.has(ref.id) && resolvePath(ref.sessionFile).startsWith(scope)) ++active;
		}
		return active;
	} catch {
		return 0;
	}
}

/** The approved reviewer agent of a run's team; a disabled or modelless reviewer is not authority. */
function approvedReviewer(config: StormConfig | undefined): string | undefined {
	return config === undefined ? undefined : usableRole(config, "reviewer")?.agent;
}

/**
 * The approved reviewer's own task items, each with the next batch of Storm's scoped answer review packets not yet
 * handed out (see `RunController.takeAnswerReviewBatch`): the exact answer text, its receipt and anchor reach one
 * reviewer in its per-task context, never a system prompt or another worker, and no answer rides on two items. Other
 * items, and reviewer items once every waiting answer is handed out, are unchanged.
 */
function withAnswerReviewTask(input: Record<string, unknown>, reviewer: string | undefined, nextBatch: () => string | undefined): Record<string, unknown> {
	if (reviewer === undefined) return input;
	const add = (item: unknown): unknown => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
		const entry = item as Record<string, unknown>;
		if (entry.agent !== reviewer || typeof entry.task !== "string" || entry.task.trim() === "") return item;
		const packets = nextBatch();
		return packets === undefined ? item : { ...entry, task: `${entry.task.trimEnd()}\n\n${packets}` };
	};
	if (Array.isArray(input.tasks)) {
		const tasks = input.tasks.map(add);
		return tasks.some((task, index) => task !== (input.tasks as unknown[])[index]) ? { ...input, tasks } : input;
	}
	return add(input) as Record<string, unknown>;
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

/** Reviewer starts per child session, keyed by the artifact root and the id its parent admitted. Shared by this build. */
const reviewerBaselines = sharedMap<string, ReviewerBaseline>("storm.extension.reviewerBaselines");
/** The work tree each subagent session actually runs in, so a reused reviewer's copy cannot pass for the parent. Shared. */
const childWorkTrees = sharedMap<string, string>("storm.extension.childWorkTrees");
/**
 * A snapshot that outlasts this is no snapshot: the proof must not wait on a hung git read. It leaves the tree reader
 * its own full deadline, so a slow but working read of a large repository is still a tree, never a missing one.
 */
const REVIEW_SNAPSHOT_MS = TREE_READ_TIMEOUT_MS + 2_000;

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
	const separate = !sameWorkTree(run.root, reviewerRoot);
	// With a known base both checkouts are read at once, so the two reads share one snapshot deadline inside the
	// host's handler budget instead of adding up; only an unknown base waits for the parent's to read the other.
	const [reading, early] = await Promise.all([
		boundedTree(exec, run.root, run.base),
		separate && run.base !== undefined ? boundedTree(exec, reviewerRoot, run.base) : Promise.resolve(undefined),
	]);
	if (!reading || reading.state.incomplete) {
		reviewerBaselines.delete(key);
		return;
	}
	const tree = fingerprintOf(reading);
	if (separate) {
		const reviewed = early ?? (await boundedTree(exec, reviewerRoot, reading.base));
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
	noteVerdictTree(ctx.agent.id, at, baseline.tree, run.sessionDir);
}

/** Target resolution only: a repository identity is evidence about the worktree, never session or team authority. */
const repoByCwd = new Map<string, Promise<RepoIdentity>>();

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

/** What a host may supply when it creates the extension; production passes nothing, so every product default applies. */
export interface StormOptions {
	/**
	 * The fixed waits of this session. Only tests supply them (they are not a user setting): a check that does not test
	 * a wait passes a short one and leaves the ones that matter alone. See `src/runtime/timings.ts`.
	 */
	timings?: TimingOverrides;
}

export default function storm(pi: ExtensionAPI, options: StormOptions = {}): void {
	const timings = timingsOf(options.timings);
	const exec = execPort(pi);
	/**
	 * The native sessions whose lane view the user turned off with `/storm view`. The view is on by default; like the
	 * automatic-delegation policy this is one session's own setting, dropped at every identity boundary, and unlike it
	 * nothing is stored: it only chooses what the live widget draws.
	 */
	const laneViewOff = new Set<string>();
	const liveStatus = new LiveStatus({
		laneView: ctx => {
			const id = mainSessionId(ctx);
			return id === undefined || !laneViewOff.has(id);
		},
	});
	/**
	 * The run each open ask/tool-approval belongs to, captured when it opened. Its end event closes that run's key,
	 * never one of whichever run this session directs by then.
	 */
	const openWaits = new Map<string, { runId: string; key: string }>();
	/** The decisions this conversation's current user request already asked; keys only, never answers. */
	const decisions = new DecisionRequests();
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
	/**
	 * Bumped whenever this host's native conversation identity changes (start, switch, clear, branch, shutdown). A
	 * delayed callback carries the generation it started under and refuses to act once it is no longer current; the
	 * mutable session manager is never reread later as authority.
	 */
	let sessionGeneration = 0;
	/**
	 * The director's own path edits that hold the run's write table, by the host's tool call id, with what a switch of conversation
	 * needs to know about each call: whether the host started it, whether its result was seen, and whether the `message_end` of the
	 * message that carries the call was handled (`seen`). An entry leaves with its release (`releaseDirectorHolds`); the table's own
	 * entry is the hold, this is only the host's side of the story.
	 */
	const directorHolds = new Map<string, { runId: string; root: string; started: boolean; resulted: boolean; seen: boolean }>();
	/**
	 * The assistant-message call ids whose `message_end` this handler already saw, whether or not a hold existed then. Harmony recovery on
	 * the pinned host can deliver the recovered `message_end` before the pre-dispatch hooks: a hold committed afterwards must count as seen
	 * at once, or an unclean turn could never release it (RF1). Bounded, never silently lossy (RF3-4): on overflow the association is not
	 * trusted any more and every hold of the message counts as seen (the conservative outcome), rather than the oldest id being dropped.
	 */
	const seenDirectorCalls = new Set<string>();
	let seenDirectorCallsOverflowed = false;
	/**
	 * Calls of the director this hook let through as no file change, kept until the host starts them: another extension may rewrite the
	 * arguments in between, and a call that only then becomes a project file write must still get its hold and notice (RF3). Cleared at
	 * the turn end and the conversation's end; bounded per message. A call whose memo was evicted is not lost: at execution start it is
	 * reclassified and, if it is a file change, held on the whole tree and told (RF3-4).
	 */
	const revisableDirectorCalls = new Map<string, { runId: string; root: string; generation: number }>();
	/** Calls whose hold this very hook committed: its answer is final and waits for nothing more (no await after the commit). */
	const committedHere = new Set<string>();
	/**
	 * Director path calls this hook refused. The host still emits a start for a blocked call, and that is not a rewrite:
	 * the call was judged and refused, so the start must neither hold the whole tree nor claim another extension changed it.
	 */
	const refusedDirectorCalls = new Set<string>();
	/**
	 * The digest of the result-contract block (`laneContract`) a worker was last sent, so a work follow-up repeats the block only
	 * when the worker has not been sent the current one. In memory: unknown means send again. `placed` is the digest of the lane's
	 * block at its latest placement (copied to the worker when the host allocates its spawn), `sent` is by run and worker id, and
	 * `pending` holds a follow-up's digest until its call is known to have been delivered.
	 */
	const contractDigests = {
		placed: new Map<string, string>(),
		sent: new Map<string, string>(),
		pending: new Map<string, { key: string; digest: string }>(),
	};
	/** The authoritative native main-session id; a child's own id is never a Storm session. */
	const mainSessionId = (ctx: ExtensionContext): string | undefined =>
		ctx.agent.kind === "main" ? closeoutSessionId(ctx) : undefined;
	const requireSessionId = (ctx: ExtensionContext): string => {
		const id = mainSessionId(ctx);
		if (id === undefined) {
			throw new Error("Storm이 이 세션의 id를 확인하지 못했습니다. 새 대화를 연 뒤 다시 시도하세요. 아무것도 저장하지 않았습니다.");
		}
		return id;
	};
	/** This main session's Storm store; the target root is only the worktree the state describes. */
	const projectEnv = (ctx: ExtensionContext): ProjectEnv => ({
		cwd: ctx.cwd,
		exec,
		agentDir: pi.pi.getAgentDir(),
		pluginAgentsDir: PLUGIN_AGENTS_DIR,
		sessionId: requireSessionId(ctx),
	});
	/** A run's state is read under the session that admitted it, at the target the run was started on. */
	const runEnv = (run: LedgerRun): ProjectEnv => ({
		cwd: run.root,
		exec,
		agentDir: pi.pi.getAgentDir(),
		pluginAgentsDir: PLUGIN_AGENTS_DIR,
		sessionId: run.sessionId,
	});
	/** A snapshot of one session's state, for delayed work that must not read whichever session is live later. */
	const envForSession = (sessionId: string, cwd: string): ProjectEnv => ({
		cwd,
		exec,
		agentDir: pi.pi.getAgentDir(),
		pluginAgentsDir: PLUGIN_AGENTS_DIR,
		sessionId,
	});
	/**
	 * One native session's personal automatic-delegation policy, keyed by its own identity. A refresh that completes
	 * after the conversation changed writes nothing: the entry (and the map) it started on is gone.
	 */
	interface AutoEntry extends AutoStatus {
		task: string | undefined;
		/** When the user's message that is `task` began its turn; set and cleared with it. */
		turnStartedAt?: number;
		/**
		 * The director's loop paused on background work (a `willContinue` end that awaits async work). A prompt that
		 * arrives while paused is a new user message, not a continuation of the paused request.
		 */
		paused?: boolean;
		settling?: Promise<void>;
		epoch: number;
	}
	const autos = new Map<string, AutoEntry>();
	let autoEpoch = 0;
	const autoFor = (sessionId: string): AutoEntry => {
		const hit = autos.get(sessionId);
		if (hit) return hit;
		const entry: AutoEntry = { enabled: false, problem: undefined, task: undefined, epoch: ++autoEpoch };
		autos.set(sessionId, entry);
		return entry;
	};
	const autoOf = (ctx: ExtensionContext): AutoEntry | undefined => {
		const id = mainSessionId(ctx);
		return id === undefined ? undefined : autos.get(id);
	};
	/** What a tool host bound to `sessionId` reports, even after another conversation became live. */
	const autoSnapshot = (sessionId: string): { enabled: boolean; blocked?: string; task?: string; turnStartedAt?: number } => {
		const entry = autos.get(sessionId);
		if (entry === undefined) return { enabled: false };
		return {
			enabled: entry.enabled,
			...(entry.problem !== undefined ? { blocked: entry.problem } : {}),
			...(entry.task !== undefined ? { task: entry.task } : {}),
			...(entry.task !== undefined && entry.turnStartedAt !== undefined ? { turnStartedAt: entry.turnStartedAt } : {}),
		};
	};
	const refreshAuto = async (ctx: ExtensionContext, load?: () => Promise<ProjectState>): Promise<void> => {
		const sessionId = mainSessionId(ctx);
		if (sessionId === undefined) return;
		const entry = autoFor(sessionId);
		const epoch = entry.epoch;
		const current = (): boolean => autos.get(sessionId) === entry && entry.epoch === epoch;
		let state: ProjectState;
		try {
			state = await (load ? load() : loadProjectState(projectEnv(ctx)));
		} catch {
			// A failed load cannot prove consent was withdrawn for the same conversation; on a changed one the entry is
			// already gone and this writes nothing.
			if (current()) {
				if (entry.enabled) entry.problem = "팀 설정을 확인하지 못했습니다. /storm 으로 확인하세요.";
			}
			return;
		}
		if (!current()) return;
		entry.problem = teamProblem(state) ?? modeProblem(ctx);
		try {
			const enabled = await readAutoDelegation(state.sessionDir);
			if (current()) entry.enabled = enabled;
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
	/**
	 * The scope the agents ledger uses to keep one conversation's workers apart. Main: the run's captured store when
	 * one is live, else this session's own store. Child: only the run its parent admitted; undefined never falls back.
	 */
	const agentScope = (ctx: ExtensionContext): string | undefined => {
		if (ctx.agent.kind === "sub") return childLedger(ctx)?.sessionDir;
		const id = mainSessionId(ctx);
		if (id === undefined) return undefined;
		// A run that has not finished draining may still be this controller's, but it is authority only for the
		// session that admitted it. A switched conversation reads its own store, never the old run's scope.
		const run = getLedgerRun(runs.runId());
		if (run !== undefined && run.sessionId === id) return run.sessionDir;
		try {
			return sessionStoreDir(pi.pi.getAgentDir(), id);
		} catch {
			return undefined;
		}
	};
	/**
	 * The session state behind an event: a main session reads its own store, a child only the run its parent admitted.
	 * A bare child has no Storm session; undefined is a fail-closed answer, never a cwd or "most recent session" guess.
	 */
	const stateForEvent = (ctx: ExtensionContext): Promise<ProjectState | undefined> => {
		if (ctx.agent.kind === "main") {
			const id = mainSessionId(ctx);
			return id === undefined ? Promise.resolve(undefined) : stateCache.get(envForSession(id, ctx.cwd));
		}
		const ledger = childLedger(ctx);
		return ledger === undefined ? Promise.resolve(undefined) : stateCache.get(runEnv(ledger));
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

	/** Profile dir for the persisted worker admission bridge; a host failure is a closed failure, not a fallback. */
	const workerAdmissionAgentDir = (): string => pi.pi.getAgentDir();
	const revokeWorkerAdmissionsFor = async (match: { runId?: string; sessionId?: string }): Promise<void> => {
		try {
			await revokeWorkerAdmissions(workerAdmissionAgentDir(), match);
		} catch {
			// Revocation is defensive; the child's next write still fails closed if the store is unreadable.
		}
	};
	const policyFromAdmission = (record: WorkerAdmissionRecord): LanePolicy => {
		switch (record.policy.kind) {
			case "paths":
				return { kind: "paths", paths: [...record.policy.paths], reason: record.policy.reason };
			case "read":
				// An old record has no `shell`: it reads as a plain reader, which refuses the shell (fails safe).
				return { kind: "read", reason: record.policy.reason, ...(record.policy.shell === true ? { shell: true as const } : {}) };
			case "private":
				return { kind: "private", reason: record.policy.reason };
			case "unknown":
				return { kind: "unknown", reason: record.policy.reason };
			case "blocked":
				return { kind: "blocked", reason: record.policy.reason };
		}
	};
	const authorityFromAdmission = (record: WorkerAdmissionRecord, checkout?: string): AgentAuthority => ({
		policy: policyFromAdmission(record),
		root: checkout ?? record.targetRoot,
		...(checkout === undefined ? {} : { checkout }),
		...(record.lane === undefined ? {} : { lane: record.lane }),
	});
	/**
	 * A child's actual authority. The persisted admission is authoritative for every non-read tool, so a rebound
	 * module and a worker-homed child enforce the same policy as the parent; an invalid/revoked record denies, a
	 * genuinely absent one leaves unrelated native work alone.
	 */
	const childWorkerAuthority = async (
		ctx: ExtensionContext,
	): Promise<{ kind: "unmanaged" } | { kind: "authorized"; authority: AgentAuthority } | { kind: "denied"; reason: string }> => {
		const artifacts = artifactsOf(ctx);
		const workerKey = authorityKey(artifacts, ctx.agent.id);
		const inMemory = agentAuthorities.get(workerKey);
		try {
			const resolved = await resolveWorkerAdmission({
				agentDir: workerAdmissionAgentDir(),
				artifactRoot: artifacts,
				parentId: ctx.agent.parentId,
				childId: ctx.agent.id,
				childSessionId: closeoutSessionId(ctx),
				childCwd: ctx.cwd,
			});
			if (resolved.kind === "authorized") {
				const authority = authorityFromAdmission(resolved.record, resolved.checkout);
				agentAuthorities.set(workerKey, authority);
				return { kind: "authorized", authority };
			}
			if (resolved.kind === "denied") return { kind: "denied", reason: resolved.reason };
			// Without the persisted record a private lane has no exact checkout to bind; the in-memory target root is
			// the integrated tree, so using it would permit parent writes. Fail closed instead.
			if (inMemory === undefined) return { kind: "unmanaged" };
			if (inMemory.policy.kind === "private") {
				return { kind: "denied", reason: "격리 워커의 체크아웃 권한 기록을 확인하지 못했습니다" };
			}
			return { kind: "authorized", authority: inMemory };
		} catch {
			return { kind: "denied", reason: "자식 실행 권한을 확인하지 못했습니다" };
		}
	};
	/** The child's own settled turn/switch closes its current attempt; a follow-up admission opens the next one. */
	const closeChildWorkerAdmission = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const read = await readWorkerAdmission({
				agentDir: workerAdmissionAgentDir(),
				artifactRoot: artifactsOf(ctx),
				parentId: ctx.agent.parentId,
				childId: ctx.agent.id,
			});
			if (read.kind !== "record") return;
			await endWorkerAdmission(
				workerAdmissionAgentDir(),
				read.key,
				read.record.attempt,
				closeoutSessionId(ctx),
			);
		} catch {
			// A failed close leaves the record for the parent's run-end revocation.
		}
	};
	/**
	 * The native ask gate for a managed director. It runs before the host opens a form: a marked genuine decision is
	 * left to the host unchanged, while a routine, malformed or repeated question is declined as tool feedback so the
	 * director keeps working. The marker is coordination only; it grants no approval and replaces no host permission.
	 */
	const mainAskGate = (
		ctx: ExtensionContext,
		input: unknown,
		autoOn: boolean,
		runId: string | undefined,
	): { block: true; reason: string } | undefined => {
		const sessionId = mainSessionId(ctx);
		if (sessionId === undefined) return undefined;
		// Auto work is gated before, during and after its run. A manual run is gated only while it is this session's.
		if (!autoOn && (runId === undefined || getLedgerRun(runId)?.sessionId !== sessionId)) return undefined;
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "[storm:ask-no-ui] 이 호스트에는 사용자 폼 UI가 없어 관리 실행의 native ask를 열 수 없습니다. 결정에 의존하지 않는 범위 안 작업을 먼저 끝내고, 막히면 선택지와 진행 상황을 최종 답변이나 감독 보고에 남기세요. native ask를 다시 호출해도 폼은 열리지 않습니다.",
			};
		}
		const checked = decisionAsk(input);
		if (!checked.ok) {
			const tag = checked.code === "default" ? "ask-default" : "ask-contract";
			return {
				block: true,
				reason: `[storm:${tag}] 이번 사용자 요청에서 이미 승인된 범위의 작업은 확인 질문이 필요 없습니다. 네이티브 ask는 실제 사용자 결정에만 쓰고, MAIN <form> 태그에 data-storm-decision="<stable-key>"와 data-storm-reason(scope-change, irreversible-action, user-choice 중 정확히 하나)을 넣으세요. 결정에 의존하지 않는 작업을 먼저 끝내고 같은 결정은 이번 요청에서 한 번만 물으세요. ${checked.detail}`,
			};
		}
		const remembered = decisions.remember(sessionId, sessionGeneration, checked.ask.key, checked.ask.reason);
		if (remembered.status === "recorded") return undefined;
		if (remembered.status === "full") {
			return {
				block: true,
				reason: "[storm:ask-limit] 이번 사용자 요청의 결정 기록 한도에 도달해 새 결정을 더 기록할 수 없습니다. 이미 물은 결정을 다시 요청하지 말고, 범위 안 작업을 계속하거나 선택지와 진행 상황을 감독 보고에 남기세요. 타임아웃·취소는 동의가 아닙니다.",
			};
		}
		return {
			block: true,
			reason: `[storm:ask-repeat] 이번 사용자 요청에서 이미 결정('${checked.ask.key}', ${remembered.reason})을 물었습니다. 같은 승인을 다시 요청하지 말고, 이전 답이나 취소·타임아웃을 그대로 상태로 두고 범위 안 작업을 계속하거나 막힘을 보고하세요. 타임아웃·취소는 동의가 아닙니다.`,
		};
	};

	/** Parent side: write the exact admission before returning from the spawn hook. */
	const persistChildAdmission = async (input: {
		ctx: ExtensionContext;
		run: LedgerRun;
		artifacts: string | undefined;
		childId: string;
		lane?: PlanLane;
		authority: AgentAuthority;
		/** What this worker's role (and trial, when the spawn was routed to one) approves: the snapshot its own check reads on any thread. */
		approved: ReadonlyArray<{ selector: string; effort?: Effort }>;
	}): Promise<void> => {
		// Through the same key a reservation's end revokes under: an older end never interleaves with this newer write.
		await serialized(admissionKey(input.run.runId, input.childId), () =>
			persistWorkerAdmission({
				agentDir: workerAdmissionAgentDir(),
				artifactRoot: input.artifacts,
				parentId: input.ctx.agent.id,
				childId: input.childId,
				runId: input.run.runId,
				sessionId: input.run.sessionId,
				sessionDir: input.run.sessionDir,
				repoId: input.run.repoId,
				targetRoot: input.run.root,
				...(input.lane === undefined ? {} : { lane: input.lane.name }),
				policy: input.authority.policy,
				...(input.approved.length === 0 ? {} : { approved: input.approved }),
			}),
		);
	};
	/**
	 * Parent side: reopen a follow-up with a new attempt whose approved snapshot is the one the decision that admitted this
	 * worker wrote, read from that worker's own admission — never rebuilt from the run's starting configuration (RF3-2).
	 * A worker of this run with no such snapshot, or a foreign/other-build record, is refused rather than guessed. A reused
	 * agent this run never admitted has no earlier decision: this follow-up is its first admission and uses the current
	 * approved entries the caller supplies.
	 */
	const reopenChildAdmission = async (input: {
		ctx: ExtensionContext;
		run: LedgerRun;
		artifacts: string | undefined;
		childId: string;
		lane?: PlanLane;
		authority: AgentAuthority;
		/** What the current approved team names for this agent: used only when this run never admitted the worker. */
		approved: () => ReadonlyArray<{ selector: string; effort?: Effort }>;
	}): Promise<{ ok: true } | { ok: false; reason: string }> => {
		return serialized(admissionKey(input.run.runId, input.childId), async () => {
			const read = await readWorkerAdmission({
				agentDir: workerAdmissionAgentDir(),
				artifactRoot: input.artifacts,
				parentId: input.ctx.agent.id,
				childId: input.childId,
			});
			if (read.kind === "invalid") {
				return { ok: false as const, reason: "이 워커의 실행 기록을 읽지 못해 후속 작업의 모델 승인을 확인할 수 없습니다. 실행 상태를 확인한 뒤 다시 보내세요." };
			}
			const prior = read.kind === "record" && read.record.runId === input.run.runId ? read.record.approved : undefined;
			if (read.kind === "record" && read.record.runId === input.run.runId && (prior === undefined || prior.length === 0)) {
				return { ok: false as const, reason: "이 워커의 승인 모델 기록이 남아 있지 않아 후속 작업을 보내지 않았습니다. 실행을 새로 시작하세요." };
			}
			const approved = prior === undefined
				? input.approved().map(entry => ({ selector: entry.selector, ...(entry.effort === undefined ? {} : { effort: entry.effort }) }))
				: prior.map(entry => ({ selector: entry.selector, ...(entry.effort === undefined ? {} : { effort: entry.effort as Effort }) }));
			if (approved.length === 0) {
				return { ok: false as const, reason: "이 워커의 승인 모델 기록이 남아 있지 않아 후속 작업을 보내지 않았습니다. 실행을 새로 시작하세요." };
			}
			await persistWorkerAdmission({
				agentDir: workerAdmissionAgentDir(),
				artifactRoot: input.artifacts,
				parentId: input.ctx.agent.id,
				childId: input.childId,
				runId: input.run.runId,
				sessionId: input.run.sessionId,
				sessionDir: input.run.sessionDir,
				repoId: input.run.repoId,
				targetRoot: input.run.root,
				...(input.lane === undefined ? {} : { lane: input.lane.name }),
				policy: input.authority.policy,
				approved,
			});
			return { ok: true as const };
		});
	};

	/** The last run shown live; its child admissions close when finalization reports no run. */
	let liveRunId: string | undefined;
	let announcedResultPlan: string | undefined;
	const runs = new RunController({
		pi,
		ui: ctx => createUiPort(pi, ctx),
		loadState: async ctx => loadProjectState(projectEnv(ctx)),
		now: Date.now,
		agents: (runId, sessionDir) => listAgents({ runId, scope: sessionDir }),
		settleEnds: runId => settleEndRevokes(runId),
		tree: (root, base) => treeAgainst(exec, root, base),
		// Cleanup inventory only: the janitor passes the session it is sweeping, never a process-wide view.
		ledger: sessionDir => listAgents({ scope: sessionDir }),
		agentDir: pi.pi.getAgentDir(),
		timings,
		// The approved write authority of each lane, for the line that says which writing lanes the write order now lets start.
		lanePolicies: async (runId, plan) => {
			const ledger = getLedgerRun(runId);
			if (ledger === undefined) return undefined;
			const state = await stateCache.get(runEnv(ledger));
			if (state.config.status !== "ok") return undefined;
			const view = await policiesForPlan(plan, state.config.config, state.shadows, ledger.root, false);
			return view.ok ? view : undefined;
		},
		live: (ctx, run) => {
			if (run) {
				liveRunId = run.runId;
				showRunStatus(ctx, run, runs.phase());
				if (announcedResultPlan !== run.runId && run.plan !== undefined) {
					const labels = plannedResultLabels(run);
					if (labels.length > 0) {
						announcedResultPlan = run.runId;
						const shown = labels.slice(0, 5);
						const rest = labels.length > shown.length ? ` · 외 ${labels.length - shown.length}개` : "";
						createUiPort(pi, ctx).notify(`이번에 만들 결과: ${shown.join(" · ")}${rest}`);
					}
				}
				return;
			}
			const ended = liveRunId;
			liveRunId = undefined;
			announcedResultPlan = undefined;
			if (ended !== undefined) {
				void revokeWorkerAdmissionsFor({ runId: ended });
				for (const key of adoptedStops.keys()) if (key.startsWith(`${ended}\0`)) adoptedStops.delete(key);
				for (const [key, baseline] of reviewerBaselines) if (baseline.runId === ended) reviewerBaselines.delete(key);
				endRevokes.delete(ended);
			}
			liveStatus.clear();
			// Finalization already dropped the controller's keys; the session's records only existed to close them.
			openWaits.clear();
			void syncSession(ctx).catch(() => undefined);
		},
	});

	/**
	 * Host-attested attempt capture for this session. The controller keeps the lane contract, pre-write baseline and
	 * RunRecord.results; the collector only binds native ids and captures exact host-named artifacts. It subscribes to
	 * the process-global AgentRegistry lazily on the first contract-bearing lane and stops with the run.
	 */
	const attempts = new AttemptCollector({
		port: {
			prepare: input => runs.prepareAttempt(input),
			settle: input => runs.settleAttempt(input),
			discard: input => runs.discardAttempt(input),
			// A delivery no dispatch of this run was waiting for (a woken worker, a lane without declared results): kept in the
			// record and told to the director in one line; it is never a result row and never acceptance.
			unplanned: input => runs.noteUnplannedDelivery(input),
		},
		registry: () => AgentRegistry.global(),
	});

	// A worker's write authority ends with the reservation that stood behind it. The run's lane table reports each end
	// (a settled turn, a refused or cancelled spawn, a failed call), and the persisted admission is revoked for exactly that
	// child and only what was written before the end was noticed, so a follow-up that already wrote a newer attempt keeps it.
	// Only the session whose controller owns the run acts; the revoke goes through the child's own persist queue.
	// The revoke runs in the child's persist queue, after the end was noticed. A placement that ended another worker's
	// reservation must not answer before that revoke has landed, or the worker it ended still holds authority beside the
	// writer it just admitted (R-final N4): `settleEndRevokes` is what every placement awaits before it passes.
	const endRevokes = new Map<string, { pending: Set<Promise<void>>; failed: ReservationEnd[] }>();
	const revokeEnd = (end: ReservationEnd): Promise<boolean> =>
		serialized(admissionKey(end.runId, end.agentId), async () => {
			try {
				await revokeWorkerAdmissions(workerAdmissionAgentDir(), { runId: end.runId, childId: end.agentId, createdBefore: end.at });
				return true;
			} catch {
				return false;
			}
		});
	onLaneReservationEnd(end => {
		if (runs.runId() !== end.runId) return;
		let entry = endRevokes.get(end.runId);
		if (entry === undefined) {
			entry = { pending: new Set(), failed: [] };
			endRevokes.set(end.runId, entry);
		}
		const own = entry;
		const task: Promise<void> = revokeEnd(end)
			.then(done => {
				if (!done) own.failed.push(end);
			})
			.finally(() => {
				own.pending.delete(task);
			});
		own.pending.add(task);
	});
	/**
	 * Waits until every revoke the run's lane table asked for has landed, and tries again once for one that failed. Undefined
	 * when no worker holds authority that no reservation stands behind; otherwise the refusal's reason (fail closed: a
	 * writer is not placed beside a worker whose authority could not be withdrawn).
	 */
	const settleEndRevokes = async (runId: string): Promise<string | undefined> => {
		const entry = endRevokes.get(runId);
		if (entry === undefined) return undefined;
		while (entry.pending.size > 0) await Promise.allSettled([...entry.pending]);
		for (const end of entry.failed.splice(0)) if (!(await revokeEnd(end))) entry.failed.push(end);
		if (entry.failed.length === 0) return undefined;
		const who = [...new Set(entry.failed.map(end => end.agentId))].join(", ");
		return `[storm:revoke] 끝난 워커(${who})의 쓰기 권한을 거두지 못해 그 워커가 아직 쓸 수 있을 수 있어, 쓰는 작업을 새로 시작하지 않았습니다. 권한 기록 저장소를 쓸 수 있게 된 뒤 같은 호출을 다시 보내세요. 계속 실패하면 사용자에게 알리세요.`;
	};

	/**
	 * The current facts of every lane some plan edge waits on. Only those lanes are read; an empty set never touches the
	 * ledger. A dependency whose state is missing fails closed in the gate instead of guessing from the plan.
	 */
	const readinessFor = async (plan: RunPlan | undefined): Promise<LaneReadinessView | undefined> => {
		if (plan === undefined) return undefined;
		const needed = new Set<string>();
		for (const lane of plan.lanes) for (const dependency of lane.dependsOn ?? []) needed.add(dependency.lane);
		if (needed.size === 0) return undefined;
		return runs.laneReadiness(plan, needed);
	};

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
		// The host began running a director path edit: only a result or the end of a later message tells that it is over.
		if (ctx.agent.kind === "main") {
			const hold = directorHolds.get(event.toolCallId);
			if (hold !== undefined) {
				hold.started = true;
				widenToWhatRuns(event, ctx, hold.root);
			} else if (!refusedDirectorCalls.delete(event.toolCallId)) {
				// A call Storm itself refused is not a rewrite: the host still reports its start, but it never runs, so it
				// must not hold the tree or claim another extension changed it. Only a call the hook let through is re-read.
				const revisable = revisableDirectorCalls.get(event.toolCallId);
				revisableDirectorCalls.delete(event.toolCallId);
				const runId = runs.runId();
				const run = getLedgerRun(runId);
				const memoValid = revisable !== undefined && revisable.runId === runId && revisable.generation === sessionGeneration;
				if (runId !== undefined && run !== undefined) {
					const root = memoValid ? revisable.root : run.root;
					const real = decideDirectorCall({ toolName: event.toolName, input: event.args, cwd: ctx.cwd, root });
					if (real.kind !== "allow") {
						const lanes = runs.runLanes();
						const paths = memoValid && real.kind === "director-path" && real.paths.length > 0 ? real.paths : ["."];
						if (lanes !== undefined && lanes.runId === runId && lanes.holdDirectorCall(event.toolCallId, paths)) {
							directorHolds.set(event.toolCallId, { runId, root, started: true, resulted: false, seen: seenDirectorCallsOverflowed || seenDirectorCalls.has(event.toolCallId) });
							runs.noteDirector(`[storm:director-edit] ${DIRECTOR_REWRITTEN}`);
						}
					}
				}
			}
		}
		// A synchronous wait is the one mid-run tool call that can outlast the plan: if the context crossed 70% of its window
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
		if (event.toolName === "ask") closeWait(ctx, "ask", event.toolCallId);
		if (event.toolName === "task") refusedCalls.forget(event.toolCallId);
		// The end of the director's call, whatever its result: it is the receipt for a worker that settled inside it (omp has
		// by then cancelled and reaped what the worker left), and the end of a command of the director's own. A command omp
		// moved to the background stays held through the host's job rows.
		if (ctx.agent.kind === "main" && typeof event.toolCallId === "string") runs.runLanes()?.callEnded(event.toolCallId);
		// A call a hook blocked, or one the host cancelled, ends here with isError and no `tool_result`. A regular failed
		// delivery also ends here and then reports its result; the release is exact and idempotent either way.
		if (!event.isError || ctx.agent.kind !== "main") return;
		const runId = runs.runId();
		if (runId !== undefined) releaseFailedCall(runId, event.toolCallId);
	});
	// A tool approval is emitted only when a prompt is required; a no-UI host cannot answer one and claims no wait.
	pi.on("tool_approval_requested", (event, ctx) => {
		if (!ctx.hasUI) return;
		openWait(ctx, "approval", event.toolCallId);
	});
	pi.on("tool_approval_resolved", (event, ctx) => closeWait(ctx, "approval", event.toolCallId));

	const flowEnv = (ctx: ExtensionContext, startRun?: (spec: RunSpec) => Promise<RunRequestResult>): FlowEnv => {
		const env = projectEnv(ctx);
		const generation = sessionGeneration;
		// A dialog can outlive a switch, a fork, or a host move. The closure is evaluated by the flow just before
		// its write: it must still name this session, this generation and this physical target. A mutable "current
		// session" is never consulted.
		const target = ctx.cwd;
		return {
			...env,
			ompBin: ompBinary(),
			registry: ctx.modelRegistry,
			activeTools: pi.getActiveTools(),
			now: Date.now,
			activeRun: () => runs.active(),
			activePhase: () => runs.phase(),
			autoModeProblem: () => modeProblem(ctx),
			autoEnabled: () => autoSnapshot(env.sessionId).enabled,
			agents: () => {
				const scope = agentScope(ctx);
				return scope === undefined ? [] : listAgents({ ancestorId: ctx.agent.id, scope });
			},
			ompSettings,
			newerVersion,
			// The HOST's transcript/artifact store; Storm's own session store is ProjectState.sessionDir.
			ompSessionDir: ompSessionDirOf(ctx),
			stillOwner: () =>
				generation === sessionGeneration && mainSessionId(ctx) === env.sessionId && sameWorkTree(ctx.cwd, target),
			...(startRun ? { startRun } : {}),
		};
	};

	/** The host's own session directory (transcripts, artifacts); empty when the host keeps its sessions in memory. */
	const ompSessionDirOf = (ctx: ExtensionContext): string => {
		try {
			return ctx.sessionManager?.getSessionDir() ?? "";
		} catch {
			return "";
		}
	};

	/**
	 * The approval path's host, and what a team change needs besides. Every read and write is bound to the session
	 * that opened the dialog; if the conversation changes before it is answered, nothing is loaded or saved.
	 */
	const actionHost = (ctx: ExtensionContext, ui: UiPort): ActionHost => {
		const env = projectEnv(ctx);
		const generation = sessionGeneration;
		const stillOwner = (): boolean => generation === sessionGeneration && closeoutSessionId(ctx) === env.sessionId;
		const movedOn = new Error("대화가 바뀌어 이전 세션의 작업을 저장하지 않았습니다. 새 대화에서 다시 시도하세요.");
		return {
			ui,
			now: Date.now,
			loadState: async () => {
				if (!stillOwner()) throw movedOn;
				return loadProjectState(env);
			},
			prepare: () => prepareAnalysis(flowEnv(ctx), ui),
			approveAndSave: async (state, config, scope) => {
				if (!stillOwner()) throw movedOn;
				try {
					return await approveAndSave(state, config, scope, stillOwner);
				} finally {
					stateCache.clear();
				}
			},
			addQuotaMark: async mark => {
				if (!stillOwner()) return;
				await addQuotaMark((await loadProjectState(env)).sessionDir, mark);
			},
			quota: () => readQuota(exec, ompBinary()),
		};
	};

	const toolHost = (ctx: ExtensionContext): StormToolHost => {
		const env = projectEnv(ctx);
		const generation = sessionGeneration;
		const sessionId = env.sessionId;
		/** A tool call that began in one conversation never acts on the one that replaced it. */
		const stillOwner = (): boolean => generation === sessionGeneration && closeoutSessionId(ctx) === sessionId;
		const stale = "대화가 바뀌어 이 호출은 적용하지 않았습니다. 새 대화에서 다시 시도하세요.";
		const flow = flowEnv(ctx);
		const scope = agentScope(ctx);
		/**
		 * The one door of an automatic start, a first plan's and a continuation's alike: this tool call still belongs to the
		 * conversation that made it, omp's public plan mode is not on, and only then does the controller's start run.
		 */
		const startAutomatic = async (start: () => Promise<RunRequestResult>): Promise<RunRequestResult> => {
			if (!stillOwner()) return { ok: false, reason: stale };
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
			const started = await start();
			// The first accepted automatic plan is a live tool boundary: the run's heavy pre-work context was
			// never preflight-compacted (and a sync subagent wait may never pause the agent loop). Start the one
			// background checkpoint now; omp commits it at its next turn/idle boundary. The already-oversized
			// first request cannot be prevented from here — the host classifies prompt size only after the
			// prompt has arrived — so this restores every request after that boundary, not that first one.
			if (started.ok) runs.startAutoCheckpoint();
			return started;
		};
		/** Fresh state under the captured session; a stale call reads nothing and writes nothing. */
		const loadState = async (): Promise<ProjectState> => {
			if (!stillOwner()) throw new Error(stale);
			return loadProjectState(env);
		};
		return {
			now: Date.now,
			loadState,
			statusText: async opts => {
				if (!stillOwner()) throw new Error(stale);
				const text = await statusText(flow, opts);
				if (!stillOwner()) throw new Error(stale);
				const run = runs.active();
				// A resumed run with no plan yet still shows the checkpoint's state; one with a plan shows it through `planView`.
				return run?.resumeOf === undefined || run.plan !== undefined ? text : `${text}\n\n${checkpointWorkState(run).join("\n")}`;
			},
			// The plan in force as submitted, with each result's state: what a replan must keep. Only for the session that owns the run.
			planView: () => {
				if (!stillOwner()) return undefined;
				const run = runs.active();
				return run === undefined ? undefined : { runId: run.runId, plan: run.plan, results: run.results };
			},
			isolationEnabled: () => liveIsolationSettings().isolationEnabled,
			auto: () => autoSnapshot(sessionId),
			runtime: {
				requestRun: spec => (stillOwner() ? runs.request(spec) : { ok: false, reason: stale }),
				replanConflict: plan => (stillOwner() ? replanConflict(getLedgerRun(runs.runId())?.plan, plan) : undefined),
				setRunPlan: plan => (stillOwner() ? runs.setPlan(ctx, plan) : { ok: false, reason: stale }),
				executeJobs: (lanes, signal) => runs.executeJobs(ctx, lanes, stillOwner, signal),
				submitCloseout: draft => (stillOwner() ? runs.submitCloseout(ctx, draft) : { ok: false, reason: stale }),
				runActive: () => stillOwner() && runs.runId() !== undefined,
				startWithPlan: async (spec: RunSpec, plan: RunPlan, validatedHash?: string) =>
					startAutomatic(() => runs.startWithPlan(ctx, spec, plan, validatedHash)),
				continueRun: (said, turnStartedAt) => startAutomatic(() => runs.continueInTurn(ctx, said, turnStartedAt)),
				agents: () => (stillOwner() && scope !== undefined ? listAgents({ ancestorId: ctx.agent.id, scope }) : []),
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
	pi.on("before_subagent_spawn", async (event, ctx) => {
		const generation = sessionGeneration;
		const mainId = mainSessionId(ctx);
		const auto = autoOf(ctx);
		// Automatic delegation never lets the main session spawn its way around the plan: before the first plan
		// opens a run, every spawn is refused. This is checked before any state read, so it also holds when the
		// team config or approval cannot be read; subagent sessions are not fenced by this session's policy.
		if (ctx.agent.kind === "main" && auto?.enabled === true && runs.runId() === undefined) {
			return { block: true, reason: autoRefusal(auto?.problem, AUTO_SPAWN_REASON) };
		}
		// A call Storm refused may still have been run by the host: the spawn event names no call, so while one is
		// unsettled none starts (task-refusal.ts). Nothing is reserved or recorded for it.
		if (ctx.agent.kind === "main") {
			const refused = refusedCalls.unsettled();
			if (refused !== undefined) return { block: true, reason: refused };
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
		// A refusal frees only what this decision's own placement and reservations made. The lanes and the placement
		// identity are read now, before anything awaits: the current run or a newer call may own the same name later.
		const lanesAtEntry = runs.runLanes();
		const capturedLanes = lanesAtEntry !== undefined && lanesAtEntry.runId === capturedRunId ? lanesAtEntry : undefined;
		const placement = event.spawnKey === undefined ? undefined : capturedLanes?.placementOf(event.spawnKey);
		const decisionToken = Symbol("spawn-decision");
		let ownAuthority: AgentAuthority | undefined;
		// A separate native child has no Storm session: only the run its parent admitted can route it. There is no
		// unscoped ledger lookup here, so a same-id worker of another session is never consulted. If its artifact tree
		// still has a live managed run, even a non-Storm name is an unattributed nested spawn and fails closed.
		if (ctx.agent.kind === "sub" && captured === undefined) {
			let managed = false;
			try {
				managed = await activeWorkerRunInTree(pi.pi.getAgentDir(), artifacts);
			} catch {
				managed = event.agent.startsWith(ROLE_AGENT_PREFIX);
			}
			if (!managed && !event.agent.startsWith(ROLE_AGENT_PREFIX)) return undefined;
			return {
				block: true,
				reason: blockText({
					code: "internal",
					reason: managed
						? "관리 실행 중인 트리에서 부모 실행을 특정하지 못한 중첩 스폰은 허용하지 않았습니다. 감독 세션에서 계획된 레인으로 스폰하세요."
						: "이 서브에이전트의 부모 실행을 확인하지 못해 Storm 역할 스폰을 허용하지 않았습니다. 감독 세션에서 다시 스폰하세요.",
				}),
			};
		}
		const closed = (): SpawnDecision => ({
			block: true,
			reason: blockText({ code: "internal", reason: "Storm 실행 원장이 끝났거나 닫혀 이 스폰을 허용하지 않았습니다. 실행 상태를 다시 확인하세요." }),
		});
		const moved = (): SpawnDecision => ({
			block: true,
			reason: blockText({ code: "internal", reason: "대화가 바뀌어 이 스폰을 허용하지 않았습니다. 새 대화에서 다시 시도하세요." }),
		});
		const stillOwn = (): boolean =>
			ctx.agent.kind !== "main" || (generation === sessionGeneration && mainSessionId(ctx) === mainId);
		const autoOn = auto?.enabled === true;
		const ledgerBlock = (reason: string, run: LedgerRun, now: number, code: SpawnBlockCode = "internal"): SpawnDecision => {
			const block = { code, reason };
			if (getLedgerRun(run.runId) === run) noteRunSpawn(run.runId, blockedSpawn(event, block, now));
			return { block: true, reason: blockText(block) };
		};
		// A controller run whose ledger disappeared is a scope we cannot admit into.
		if (ctx.agent.kind === "main" && runs.runId() !== undefined && captured === undefined) return closed();
		const decide = async (): Promise<SpawnDecision> => {
			// Recheck the captured run rather than a repo or cwd match; a close or a new run is not this spawn's owner.
			const run = capturedRunId === undefined ? undefined : getLedgerRun(capturedRunId);
			if (capturedRunId !== undefined && (run === undefined || run.closing)) return closed();
			if (capturedRunId === runs.runId()) {
				const gate = runs.jobGate();
				if (gate !== undefined) return { block: true, reason: gate };
			}
			if (ctx.agent.kind === "main" && auto?.enabled === true && runs.runId() === undefined) {
				return { block: true, reason: autoRefusal(auto?.problem, AUTO_SPAWN_REASON) };
			}
			// Outside a run only storm-* agents are Storm's business.
			if (!event.agent.startsWith(ROLE_AGENT_PREFIX) && capturedRunId === undefined) return undefined;
			// A run carries its originating session; a bare main session must have its own. A child's own id is never used.
			const env = run === undefined ? (ctx.agent.kind === "main" && mainId !== undefined ? envForSession(mainId, ctx.cwd) : undefined) : undefined;
			if (run === undefined && env === undefined) return moved();
			const state = await stateCache.get(run === undefined ? env! : runEnv(run));
			if (timedOut) return closed();
			if (ctx.agent.kind === "main" && (generation !== sessionGeneration || mainSessionId(ctx) !== mainId)) return moved();
			if (run !== undefined && state.repo.root !== run.root) return closed();
			// One decision at a time per session, so parallel spawns never read the same trial counters or live counts;
			// different sessions on the same target stay independent.
			return serialized(`spawn:${state.sessionDir}`, async () => {
				if (timedOut) return closed();
				const now = Date.now();
				const current = capturedRunId === undefined ? undefined : getLedgerRun(capturedRunId);
				if (capturedRunId !== undefined && (current === undefined || current.closing)) return closed();
				const [quotaMarks, trials] = await Promise.all([readQuotaMarks(state.sessionDir, now), readTrialStates(state.sessionDir)]);
				if (!stillOwn()) return moved();
				// One authoritative count for this decision: reservations and running Storm rows dedupe by worker id,
				// then observed direct children that Storm does not own add their native-session occupancy once.
				const nativeLimit = liveTaskMaxConcurrency();
				const reservedSlots = current === undefined ? [] : reservedWorkers(current.runId);
				const stormSpawns = current === undefined ? [] : runSpawns(current.runId);
				const stormAgents = current === undefined ? [] : listAgents({ runId: current.runId, scope: current.sessionDir });
				const stormActive = activeAgents(stormSpawns, stormAgents, now, reservedSlots);
				let nativeOther = 0;
				if (current !== undefined && nativeLimit !== undefined && nativeLimit > 0) {
					const known = new Set(reservedSlots.map(slot => slot.key));
					for (const spawn of stormSpawns) if (spawn.outcome !== "blocked" && spawn.spawnKey !== undefined) known.add(spawn.spawnKey);
					for (const agent of stormAgents) known.add(agent.id);
					nativeOther = otherNativeWorkers(ctx, known);
				}
				// omp swaps a role's models for the parent session's model when none of them can authenticate. The answer is given
				// only over models whose credential resolved just now, through the same registry lookup omp makes.
				const teamConfig = state.config.status === "ok" ? state.config.config : undefined;
				const probed =
					teamConfig === undefined
						? undefined
						: await probeCredentialsDetailed(teamSelectors(teamConfig), async selector => {
								const slash = selector.indexOf("/");
								const model = slash < 0 ? undefined : ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
								// A model the registry does not know cannot be resolved by omp either.
								if (model === undefined) return false;
								return Boolean(await ctx.modelRegistry.getApiKey(model, closeoutSessionId(ctx)));
							});
				if (timedOut) return closed();
				const outcome = decideSpawn(
					event,
					{ config: state.config, approval: state.approval, shadows: state.shadows },
					{
						now,
						quotaMarks,
						trials,
						...(nativeLimit === undefined ? {} : { maxConcurrency: nativeLimit }),
						...(current
							? {
									run: {
										runId: current.runId,
										costUsd: current.costUsd,
										...(current.budget ? { budget: current.budget } : {}),
										...(current.plan ? { plan: current.plan } : {}),
										active: { total: stormActive.total + nativeOther, byRole: stormActive.byRole },
									},
								}
							: {}),
					},
					probed === undefined ? {} : { authenticated: probed.ok, slow: probed.slow },
				);
				const record = outcome.record;
				const allowed = outcome.decision === undefined || !("block" in outcome.decision);
				if (timedOut) return closed();
				if (!allowed) {
					if (record?.trialId) {
						const trialId = record.trialId;
						const routed = record.outcome === "trial" ? 1 : 0;
						if (routed && record.spawnKey) noteTrialSpawn(record.spawnKey, trialId, state.sessionDir);
						const trial = state.config.status === "ok" ? state.config.config.trials?.find(t => t.id === trialId) : undefined;
						// The decision stands even when the counter file cannot be written.
						await updateTrialState(state.sessionDir, trialId, current => markTrialStop(trial, { ...current, seen: current.seen + 1, routed: current.routed + routed }, now)).catch(() => undefined);
					}
					if (record && current) noteRunSpawn(current.runId, record);
					return outcome.decision;
				}
				if (timedOut) return closed();
				if (!stillOwn()) return moved();
				// No placement is predicted here (decision D7): the child's own positive thread check is the rule, and an
				// unlucky spawn costs only that child's start. The director reads the stop reason from its admission.
				// The positive decision reserves its slot before any later admission can await. If a later guard refuses
				// the spawn, the decision's block path releases it; no other spawn sees the window as free.
				if (record?.spawnKey !== undefined && current !== undefined) {
					const role = countedRole(record);
					reserveWorkerSlot({
						runId: current.runId,
						key: record.spawnKey,
						...(role === undefined ? {} : { role }),
						...(record.lane === undefined ? {} : { lane: record.lane }),
						now,
					});
					// Re-reserving a key refreshes the one slot rather than making another, so the latest decision owns it.
					const slot = workerSlot(current.runId, record.spawnKey);
					if (slot !== undefined) slotOwners.set(slot, decisionToken);
				}
				if (current !== undefined) {
					const config = state.config.status === "ok" ? state.config.config : undefined;
					// A managed run without a readable team cannot attest a child's capability; admitting it anyway would
					// be an unverifiable writer on another thread.
					if (config === undefined) {
						return ledgerBlock("실행의 승인된 팀 설정을 확인하지 못해 자식 스폰을 허용하지 않았습니다. 실행 상태를 확인한 뒤 다시 시도하세요.", current, now);
					}
					const plan = current.plan;
					// The director's task call was rewritten to a reserved lane before the host allocated this spawn.
					if (ctx.agent.kind === "main" && plan !== undefined && config !== undefined) {
						if (record === undefined) {
							if (autoOn || plan !== undefined) {
								return ledgerBlock("스폰 기록을 만들지 못해 승인된 레인을 확인할 수 없습니다. 다시 스폰하세요.", current, now);
							}
						} else {
							const admission = runs.runLanes()?.admitChecked(record, autoOn ? undefined : { plan, config });
							if (admission !== undefined && !admission.ok) return ledgerBlock(admission.reason, current, now);
							const lane = admission?.ok ? admission.lane : undefined;
							if (lane !== undefined) record.lane = lane;
							else if (plan !== undefined) {
								return ledgerBlock("승인된 계획의 구체적인 레인에 속하지 않은 자식이라 스폰을 허용하지 않았습니다. 레인 이름과 역할을 맞춰 다시 계획하세요.", current, now);
							}
						}
					}
					// A run with no plan never reaches this point with a spawn: `decideSpawn` refuses every spawn of a planless run
					// (`no-plan`), so there is no unplanned writer whose placement could lapse and be admitted late.
					const spawnKey = event.spawnKey;
					if (spawnKey === undefined) {
						return ledgerBlock("호스트가 스폰 키를 주지 않아 자식 실행을 결속하지 못했습니다. 다시 스폰하세요.", current, now);
					}
					if (!bindLedgerChild(current.runId, spawnKey, ctx.agent.id, artifacts)) {
						return ledgerBlock("자식 실행을 원장에 결속하지 못했습니다. 실행 상태를 확인한 뒤 다시 스폰하세요.", current, now);
					}
					// The lane's approved capability is decided before the child starts: a read-only intent is enforced by
					// restricting tools, and a write-capable intent never becomes a shared writer by role label alone.
					if (config !== undefined) {
						const lane = record?.lane === undefined ? undefined : plan?.lanes.find(candidate => candidate.name === record.lane);
						const authority = await authorityFor({
							agent: event.agent,
							lane,
							shadows: state.shadows,
							config,
							root: current.root,
							auto: autoOn,
						});
						if (!authority.ok) return ledgerBlock(authority.reason, current, now);
						agentAuthorities.set(authorityKey(artifacts, spawnKey), authority.authority);
						ownAuthority = authority.authority;
						// What this exact spawn's role and trial approve travels with its admission: the child's own check reads this
						// snapshot, on the main thread as well as on any other, never the live team file. The decision made for this
						// spawn carries the trial; a historical spawn record is not consulted.
						const trial = record?.trialId === undefined ? undefined : config.trials?.find(item => item.id === record.trialId);
						const approved = approvedEntries(config, event.agent, trial === undefined ? undefined : { model: trial.model, ...(trial.effort === undefined ? {} : { effort: trial.effort }) });
						// Persist before returning: the child's own hooks run in its session, which may be another thread. A failure
						// here blocks the spawn rather than allowing an unverifiable writer.
						try {
							await persistChildAdmission({
								ctx,
								run: current,
								artifacts,
								childId: spawnKey,
								...(lane === undefined ? {} : { lane }),
								authority: authority.authority,
								approved,
							});
						} catch {
							return ledgerBlock("자식 실행 권한을 프로필에 저장하지 못해 스폰을 허용하지 않았습니다. 프로필 경로와 권한을 확인하세요.", current, now);
						}
					}
					// The lane's required results need their pre-write state before the child starts. This runs after every
					// existing refusal and the ledger binding, so a failed baseline is the only new block here.
					if (ctx.agent.kind === "main" && record?.lane !== undefined && plan !== undefined && config !== undefined) {
						const lane = plan.lanes.find(candidate => candidate.name === record.lane);
						if (lane !== undefined) {
							const artifactMode = lane.isolationReason !== undefined || config.isolation === "isolated" ? "isolated" : "shared";
							const admitted = await attempts.admitSpawn({
								runId: current.runId,
								parentId: ctx.agent.id,
								spawnKey,
								lane,
								artifactMode,
								startedAt: Date.now(),
							});
							if (!admitted.ok) return ledgerBlock(admitted.reason, current, Date.now());
							// The worker's assignment carried this lane's contract block when its task call was placed.
							const delivered = contractDigests.placed.get(`${current.runId}\0${lane.name}`);
							if (delivered !== undefined) contractDigests.sent.set(`${current.runId}\0${spawnKey}`, delivered);
						}
					}
				}
				if (timedOut) return closed();
				if (!stillOwn()) return moved();
				if (current !== undefined && current.runId === runs.runId()) {
					const gate = runs.jobGate();
					if (gate !== undefined) return ledgerBlock(gate, current, Date.now());
				}
				if (record?.trialId) {
					const trialId = record.trialId;
					const routed = record.outcome === "trial" ? 1 : 0;
					if (routed && record.spawnKey) noteTrialSpawn(record.spawnKey, trialId, state.sessionDir);
					const trial = state.config.status === "ok" ? state.config.config.trials?.find(t => t.id === trialId) : undefined;
					await updateTrialState(state.sessionDir, trialId, current => markTrialStop(trial, { ...current, seen: current.seen + 1, routed: current.routed + routed }, now)).catch(() => undefined);
				}
				if (record && current) noteRunSpawn(current.runId, record);
				return outcome.decision;
			});
		};
		return failClosed(event.agent, () => capturedRunId !== undefined || autoOn || anyLedgerRun(), decide, {
			expired: limit.expired,
			onBlock: block => {
				// Only the run captured at entry may receive the blocked record: never a fresh run in the same tree.
				const run = getLedgerRun(capturedRunId);
				if (run) noteRunSpawn(run.runId, blockedSpawn(event, block, Date.now()));
			},
		}).finally(limit.cancel).then(async routed => {
			let decision = routed;
			// The spawn is routed only after the authority of any worker whose place it took has really been withdrawn (R-final N4).
			if (decision !== undefined && !("block" in decision) && capturedRunId !== undefined && ctx.agent.kind === "main") {
				const unsettled = await settleEndRevokes(capturedRunId);
				if (unsettled !== undefined) decision = { block: true, reason: unsettled };
			}
			// A refused spawn must not keep its lane/write/capacity reservation or its enforced authority: another
			// worker may start.
			if (decision !== undefined && "block" in decision && event.spawnKey !== undefined) {
				capturedLanes?.cancel(event.spawnKey, placement);
				const run = getLedgerRun(capturedRunId);
				const slot = run === undefined ? undefined : workerSlot(run.runId, event.spawnKey);
				if (run !== undefined && slot !== undefined && slotOwners.get(slot) === decisionToken) releaseWorkerSlot(run.runId, event.spawnKey);
				const authorityId = authorityKey(artifacts, event.spawnKey);
				if (ownAuthority !== undefined && agentAuthorities.get(authorityId) === ownAuthority) agentAuthorities.delete(authorityId);
			}
			return decision;
		});
	});

	/**
	 * Pushed deliveries (`async-result` messages) given to the collector, by what identifies the message. omp tells Storm
	 * of a delivery through `message_end`, which it does not wait for before it builds the director's next request: that
	 * request's `context` hook gives the delivery to the collector too when it comes first. Whichever comes first starts
	 * the one evaluation; the other joins it, so a delivery is evaluated once and the notice it leaves is ready for the
	 * request that carries the delivery.
	 */
	const observedDeliveries = new Map<string, Promise<void>>();
	const OBSERVED_DELIVERIES_MAX = 128;
	// A message without its own timestamp has no identity that tells two identical answers apart (the same worker may
	// answer the same words again): it is never joined to an earlier evaluation, only evaluated when `message_end` says so.
	const deliveryKey = (message: unknown): string | undefined =>
		isRecord(message) && message.customType === "async-result" && typeof message.timestamp === "number"
			? JSON.stringify([message.timestamp, message.content, message.details])
			: undefined;
	const observeDelivery = (ctx: ExtensionContext, runId: string, message: unknown): Promise<void> => {
		const key = deliveryKey(message);
		const known = key === undefined ? undefined : observedDeliveries.get(key);
		if (known !== undefined) return known;
		const observing = attempts.observeMessage({ runId, parentId: ctx.agent.id, message, observedAt: Date.now(), jobs: hostJobs(ctx) });
		if (key !== undefined) {
			observedDeliveries.set(key, observing);
			if (observedDeliveries.size > OBSERVED_DELIVERIES_MAX) observedDeliveries.delete(observedDeliveries.keys().next().value as string);
		}
		return observing;
	};

	// The end of the director's turn is what releases its path edits (decision D2). Positive events only: no timer, never the end
	// of one call (a formatter writes an earlier call's file during a later call of the same message), never `agent_end` (it
	// carries the whole history and can arrive twice), never a prune or the run's end.
	// 1. A clean turn (every edit and write call of the message ended without an error): the calls this event names.
	// 2. An unclean one (any of them was refused, blocked, failed or aborted): kept, because the host may still be committing
	//    what an aborted call wrote. The next completed assistant message of this conversation ends them (below).
	pi.on("turn_end", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		// Every call of this message has executed (or was aborted); nothing of it can still start after its turn end.
		revisableDirectorCalls.clear();
		refusedDirectorCalls.clear();
		const held = [...directorCallIds(event)].filter(id => directorHolds.has(id));
		if (held.length === 0 || !directorTurnClean(event)) return;
		releaseDirectorHolds(held);
	});

	pi.on("message_end", async (event, ctx) => {
		// 3. The backstop for all of it. On the host (19.2.1) the hooks of a message's calls run first, then that message's own
		//    `message_end` comes, then its calls execute: so this event must never free the holds of the message it ends. A
		//    hold is `seen` once the `message_end` of the message carrying its call was handled; a completed assistant message
		//    after that one means the loop made and finished another request, which it does only after the earlier batch is over
		//    (the host hands one extension its events in the order it emitted them). Only such a hold is released here.
		if (ctx.agent.kind === "main" && isAssistantMessage(event.message)) {
			const own = directorCallIds({ message: event.message });
			// Whatever this message's stop reason, its call ids were carried by a `message_end` this handler now saw. A hold that a
			// later hook commits for one of them (the recovered-event order) is born seen and the next completed answer can end it.
			for (const id of own) {
				if (!seenDirectorCallsOverflowed) {
					seenDirectorCalls.add(id);
					if (seenDirectorCalls.size > 256) {
						// The id association is no longer trustworthy. A hold of this message counts as seen, so it is released by
						// the next completed answer instead of being lost (RF3-4); no entry is dropped in silence.
						seenDirectorCallsOverflowed = true;
						for (const hold of directorHolds.values()) hold.seen = true;
					}
				}
			}
			if (completedAssistantMessage(event.message)) {
				const older = [...directorHolds].filter(([id, hold]) => hold.seen && !own.has(id)).map(([id]) => id);
				// A table entry this handler never heard of (a restart of the handler's state) is older than this message too.
				const unknown = (runs.runLanes()?.directorCalls() ?? []).filter(id => !directorHolds.has(id) && !own.has(id));
				releaseDirectorHolds([...older, ...unknown]);
			}
			for (const id of own) {
				const hold = directorHolds.get(id);
				if (hold !== undefined) hold.seen = true;
			}
		}
		// A finished background task is a custom `async-result` message on the parent, not an assistant turn. Observe it
		// before the usage guard, which has no usage to read for that message.
		if (ctx.agent.kind === "main") {
			const runId = runs.runId();
			if (runId !== undefined) await observeDelivery(ctx, runId, event.message);
		}
		const usage = assistantUsage(event.message);
		if (!usage) return;
		const ledger = ctx.agent.kind === "main" ? getLedgerRun(runs.runId()) : childLedger(ctx);
		if (ctx.agent.kind === "sub") {
			// A bare child has no attested Storm owner: its own native session is never substituted. A child on another thread
			// (a pooled worker) never reaches here with a request; it was stopped before its first one.
			if (ledger === undefined) return;
			noteAgentRun(ctx.agent.id, ledger.runId, ledger.sessionDir);
			if (usage.promptTokens > 0) {
				noteAgentUsage({
					id: ctx.agent.id,
					model: usage.selector,
					promptTokens: usage.promptTokens,
					costUsd: usage.usd,
					now: Date.now(),
					scope: ledger.sessionDir,
				});
			}
		} else if (usage.promptTokens > 0) {
			runs.noteMainContext(usage.promptTokens);
		}
		if (usage.usd <= 0) return;
		if (ctx.agent.kind === "main") runs.noteMainSpend(usage.usd);
		const run = ledger === undefined ? undefined : recordCost(ledger.runId, usage.selector, usage.usd);
		if (run) touchRun(run.runId);
		// A trial's budget counts what the subagents routed to its candidate spend on that candidate. Only the run its
		// parent admitted supplies the session store; a bare child's own native session is never a Storm session.
		if (ctx.agent.kind !== "sub" || ledger === undefined) return;
		const state = await stateCache.get(runEnv(ledger));
		const load = state.config;
		const trialId = load.status === "ok" ? trialCharge(ctx.agent.id, usage.selector, load.config, ledger.sessionDir) : undefined;
		if (trialId === undefined) return;
		const trial = load.status === "ok" ? load.config.trials?.find(t => t.id === trialId) : undefined;
		await updateTrialState(state.sessionDir, trialId, current => markTrialStop(trial, { ...current, costUsd: current.costUsd + usage.usd }, Date.now()));
	});

	// Native task/follow-up progress carries the host's retry count before an async delivery names its failure. The
	// collector binds it only to the exact run/parent/tool call it already tracks; no new retry or model parsing.
	pi.on("tool_execution_update", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const runId = runs.runId();
		if (runId === undefined || (event.toolName !== "task" && event.toolName !== "write")) return;
		attempts.observeProgress({
			runId,
			parentId: ctx.agent.id,
			toolCallId: event.toolCallId,
			partialResult: event.partialResult,
			observedAt: Date.now(),
		});
	});

	/**
	 * A child turn is running. The host emits `agent_start` for every turn, but `before_agent_start` only for a fresh
	 * prompt or revive: a settled agent resumed by `write agent://<id>` never gets the latter. Both call this, so the
	 * ledger entry turns running and a follow-up admitted for it stops being a pending start, in the run that owns its
	 * lane. Idempotent; a child without the parent's run binding changes nothing.
	 */
	const noteChildTurnStart = (ctx: ExtensionContext, ledger: LedgerRun | undefined = childLedger(ctx)): void => {
		if (ledger === undefined) return;
		const { id, name, parentId } = ctx.agent;
		noteAgentStart({
			id,
			name,
			...(parentId ? { parentId } : {}),
			...(name.startsWith(ROLE_AGENT_PREFIX) ? { role: name.slice(ROLE_AGENT_PREFIX.length) } : {}),
			runId: ledger.runId,
			scope: ledger.sessionDir,
			now: Date.now(),
		});
		noteLaneAgentStart(ledger.runId, id);
		touchRun(ledger.runId);
	};

	/** `task` calls Storm refused, by the host's call id, until their result is settled; one per session's extension. */
	const refusedCalls = new RefusedCalls();
	/**
	 * Frees exactly what one failed, blocked or cancelled director call reserved, by the host's own call id: its
	 * follow-up reactivation slot, its unspawned lane placements and its unstarted follow-up admission, plus any spawn
	 * handles the call names. Work that already started (a running agent, an admitted worker) is never released, and
	 * running it twice is harmless: the second call finds nothing of this call id left.
	 */
	const taskHandles = (input: unknown): string[] => {
		const echoed = input as { name?: unknown; tasks?: unknown } | undefined;
		const items = Array.isArray(echoed?.tasks) ? echoed.tasks : [echoed];
		return items.flatMap(item =>
			typeof item === "object" && item !== null && "name" in item && typeof item.name === "string" ? [item.name] : [],
		);
	};
	const releaseFailedCall = (runId: string, callId: string, handles: readonly string[] = []): void => {
		const scope = getLedgerRun(runId)?.sessionDir;
		const running = new Set(scope === undefined ? [] : listAgents({ runId, scope }).filter(agent => agent.state === "running").map(agent => agent.id));
		const followKey = `${runId}\0${callId}`;
		const follow = followCapacityCalls.get(followKey);
		followCapacityCalls.delete(followKey);
		startNotes.delete(followKey);
		if (follow !== undefined && follow.runId === runId && !running.has(follow.agentId)) releaseWorkerSlot(runId, follow.agentId);
		const placed = runs.runLanes()?.releaseCall(callId, running) ?? [];
		for (const name of new Set([...placed, ...handles])) {
			if (!running.has(name) && workerSlot(runId, name) !== undefined) releaseWorkerSlot(runId, name);
		}
	};

	// Agent ledger: each subagent session reports its own turns and end; omp offers no parent-side view of them.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind === "main") {
			// Without a native session identity there is no Storm policy to apply; the ordinary conversation is untouched.
			const sessionId = mainSessionId(ctx);
			if (sessionId === undefined) return undefined;
			const generation = sessionGeneration;
			const auto = autoFor(sessionId);
			// Only an ordinary prompt carries a user request. A revive has no prompt, and Storm's own run messages
			// are generated continuations: neither may capture or replace the task a plan opens. Both still get the
			// stable bootstrap below, so the system prompt does not change between an ordinary and a revived turn.
			if (event.reason === "prompt") {
				const prompt = typeof event.prompt === "string" ? event.prompt : "";
				const text = prompt.trimStart();
				// Storm's own messages (a round, an adjustment nudge) are generated: a prompt that starts with their tag is
				// never the user's, whatever the run's state is when the turn begins.
				const runMessage = STORM_MESSAGE_TAGS.some(tag => text.startsWith(tag));
				if (!runMessage) {
					// The host can start a new prompt while its detached terminal agent_end is still closing Storm's run.
					// Wait for that decision and lease release before deciding if this is a new task or run context.
					if (auto.settling !== undefined) {
						await auto.settling.catch(() => undefined);
						if (generation !== sessionGeneration || mainSessionId(ctx) !== sessionId || autos.get(sessionId) !== auto) return undefined;
					}
					// A message the user types while the director is paused on background work is a new request: the paused
					// request ends here instead of being kept in place of the user's words. Background results that wake the
					// director later are not prompts and continue the request they belong to (see `agent_end`).
					const wasPaused = auto.paused === true;
					auto.paused = false;
					if (wasPaused && runs.runId() === undefined) {
						auto.task = undefined;
						delete auto.turnStartedAt;
					}
					if (text === "") {
						// A photo-only or empty prompt cannot become a text run task; a later plan refuses it explicitly.
						if (runs.runId() === undefined) {
							auto.task = undefined;
							delete auto.turnStartedAt;
						}
						return undefined;
					}
					// The first ordinary prompt of a turn is its task. Later synthetic continuations, tool-loop
					// reminders and steers must not replace it; a prompt while this session directs is run context.
					if (runs.runId() === undefined && auto.task === undefined) {
						auto.task = prompt;
						auto.turnStartedAt = Date.now();
						// The first prompt of a user turn starts its request; decisions never inherit from the last one.
						decisions.nextRequest(sessionId, sessionGeneration);
					}
					const env = envForSession(sessionId, ctx.cwd);
					await refreshAuto(ctx, () => stateCache.get(env));
				}
				// A switch during the read must not attach Storm guidance to another conversation's prompt.
				if (generation !== sessionGeneration || mainSessionId(ctx) !== sessionId) return undefined;
			}
			const autoOn = autos.get(sessionId) === auto && auto.enabled;
			const activeRun = getLedgerRun(runs.runId());
			const manualOn = activeRun !== undefined && activeRun.sessionId === sessionId;
			// A block applies only while its mode does. Dropping a block this handler added earlier keeps auto-off and
			// post-run prompts free of Storm text instead of leaving the host's promoted base prompt stale.
			const wanted = new Set<string>();
			if (autoOn || manualOn) wanted.add(DECISION_INSTRUCTION);
			if (autoOn) wanted.add(AUTO_INSTRUCTION);
			const kept = event.systemPrompt.filter(entry => (entry !== AUTO_INSTRUCTION && entry !== DECISION_INSTRUCTION) || wanted.has(entry));
			const additions = [...wanted].filter(block => !kept.includes(block));
			if (additions.length === 0 && kept.length === event.systemPrompt.length) return undefined;
			return { systemPrompt: [...kept, ...additions] };
		}
		// A child has no Storm session of its own: only the run its parent admitted supplies an owner. Without one
		// there is no ledger write, no docs and no reviewer identity — never a fallback to the child's session or cwd. A
		// managed child without its run in memory is not on the director's thread; it stops before its first request (D5).
		const ledger = childLedger(ctx);
		if (ledger === undefined) {
			const binding = await childBindingOf(ctx);
			// A child whose admission names its run is a Storm worker on a thread that does not share the run: stop it now. A
			// child of a live managed tree with no record is left for the request check, which stops it with its own cause.
			if (binding.kind === "bound") stopDetachedChild(ctx, binding);
			return undefined;
		}
		const { id, name } = ctx.agent;
		const artifacts = artifactsOf(ctx);
		childWorkTrees.set(reviewerBaselineKey(artifacts, id), ctx.cwd);
		noteChildTurnStart(ctx, ledger);
		const roleChild = name.startsWith(ROLE_AGENT_PREFIX);
		const state = await stateCache.get(runEnv(ledger));
		const approvedConfig = state.config.status === "ok" && isApproved(state) ? state.config.config : undefined;
		if (name === approvedReviewer(approvedConfig)) {
			// Snapshot before the reviewer's first provider request. On an isolated team this also fingerprints the
			// reviewer's own checkout: its verdict can certify the parent only while both copies still match exactly.
			await recordReviewerBaseline(exec, artifacts, id, ledger, ctx.cwd);
		}
		// Doc rules ride on a Storm role's system prompt (first turn and revive) while the team keeps docs on.
		if (!roleChild) return undefined;
		const section = state.config.status === "ok" ? docPromptFor(name, state.config.config) : undefined;
		return section && !event.systemPrompt.includes(section) ? { systemPrompt: [...event.systemPrompt, section] } : undefined;
	});

	/** The last model a managed child's request was seen on, by the child's authority key: the record is written on a change only. */
	const lastRan = sharedMap<string, string>("storm.extension.lastRan");
	/**
	 * What the hook answered is what Storm asked for, not what runs: a credential that broke after the answer, a later
	 * extension replacing the answer or omp's own retry fallback can end on another model. Every request of a managed child
	 * is checked here against what the team approved for the role the child fills (the model, and the effort at or below the
	 * approved one). A request on anything else stops the child, tells the director why, and writes what ran on the child's
	 * spawn record. A request on an approved model records `verified` once per model and effort.
	 */
	/** The check of a child's request must answer well inside omp's own budget for a handler (30 s): past it omp sends the request unchecked. */
	const CHILD_CHECK_MS = 10_000;
	/**
	 * Stops this director's thread already told, by run, child and admission attempt. Shared by this build's copies on the
	 * thread: a second read of the same attempt (two result hooks of one message, a later request) changes nothing, and the
	 * record itself is never deleted, so reading it is always harmless.
	 */
	const adoptedStops = sharedMap<string, true>("storm.extension.adoptedStops");
	/** Whether this child's own hooks ran without the run in memory: it is not on the director's thread and cannot work (decision D5). */
	const childBindingOf = async (ctx: ExtensionContext): Promise<ChildBinding> => {
		try {
			const binding = await withinDeadline(
				readChildBinding({ agentDir: workerAdmissionAgentDir(), artifactRoot: artifactsOf(ctx), parentId: ctx.agent.parentId, childId: ctx.agent.id }),
				CHILD_CHECK_MS,
			);
			return binding ?? { kind: "unknown", reason: "자식 실행 기록을 제한 시간 안에 읽지 못했습니다" };
		} catch {
			return { kind: "unknown", reason: "자식 실행 기록을 읽지 못했습니다" };
		}
	};
	/**
	 * Stops a worker whose own instance has no run in this thread's shared state. The cause is established positively: off
	 * the host's main thread it is a pooled thread (D5); on the main thread it is another build or lost state (D7). Its
	 * first request never reaches the provider. When its own admission names the run, the reason is written there at the
	 * attempt being withdrawn; the director's thread writes the sentence. The write is started, not awaited, so the
	 * permission path never waits on disk; a lost write leaves the worker stopped all the same (fail closed).
	 */
	const stopDetachedChild = (ctx: ExtensionContext, binding: ChildBinding): void => {
		const key = authorityKey(artifactsOf(ctx), ctx.agent.id);
		if (binding.kind === "bound") {
			const reason: WorkerStopReason = threadPolicy.onHostMainThread() ? "state-not-shared" : "pooled-thread";
			stoppedChildren.set(key, threadPolicy.workerStopNotice(ctx.agent.name, reason));
			void recordWorkerStop(workerAdmissionAgentDir(), { key: binding.key, runId: binding.runId, childId: ctx.agent.id, attempt: binding.attempt, reason });
		} else {
			const reason = binding.kind === "unknown" ? binding.reason : "실행 기록이 없습니다";
			stoppedChildren.set(key, `[storm:model-mismatch] 이 워커가 어느 실행에 속하는지 확인하지 못해 실제 모델을 검사할 수 없었고, 그래서 멈췄습니다(${reason}). 지금까지의 결과를 감독에게 보고하세요.`);
		}
		ctx.abort();
	};
	/**
	 * Reads this run's own admission records for the children it admitted and tells the director, once per worker attempt,
	 * the sentence for the reason each stopped itself. The record's build, run and attempt are checked by its reader; the
	 * record is not deleted, so a repeated read is harmless and the shared seen-attempt set is what makes it once.
	 */
	const adoptChildStops = async (ctx: ExtensionContext, runId: string): Promise<void> => {
		if (getLedgerRun(runId) === undefined) return;
		const spawns = runSpawns(runId).filter(spawn => spawn.outcome !== "blocked" && spawn.spawnKey !== undefined);
		if (spawns.length === 0) return;
		let stops: WorkerStopReading[];
		try {
			stops = await readWorkerStops(workerAdmissionAgentDir(), {
				runId,
				artifactRoot: artifactsOf(ctx),
				parentId: ctx.agent.id,
				childIds: spawns.map(spawn => spawn.spawnKey as string),
			});
		} catch {
			return;
		}
		for (const stop of stops) {
			const key = `${runId}\0${stop.childId}\0${stop.attempt}`;
			if (adoptedStops.has(key)) continue;
			// Claim it before anything else can read the same attempt in this turn.
			adoptedStops.set(key, true);
			const agent = spawns.find(spawn => spawn.spawnKey === stop.childId)?.agent ?? stop.childId;
			noteRunStopped(runId, stop.childId, { attempt: stop.attempt, reason: stop.reason, at: stop.at });
			noteRunNotice(runId, threadPolicy.workerStopNotice(agent, stop.reason));
			touchRun(runId);
		}
	};

	/** Stops a managed child: its later calls are refused, the director is told, its persisted authority ends, and its request is aborted. */
	const stopChild = (ctx: ExtensionContext, ledger: LedgerRun, key: string, notice: string, ran?: RanModel): void => {
		stoppedChildren.set(key, notice);
		if (ran !== undefined) noteRunRan(ledger.runId, ctx.agent.id, ran);
		noteRunNotice(ledger.runId, notice);
		// A child on another thread cannot see this map: its persisted authority is revoked so its next write fails closed.
		void serialized(admissionKey(ledger.runId, ctx.agent.id), async () => {
			try {
				await revokeWorkerAdmissions(workerAdmissionAgentDir(), { runId: ledger.runId, childId: ctx.agent.id });
			} catch {
				// The child's next write fails closed if the store is unreadable.
			}
		});
		ctx.abort();
	};
	pi.on("before_provider_request", async (_event, ctx) => {
		if (ctx.agent.kind !== "sub") return undefined;
		const key = authorityKey(artifactsOf(ctx), ctx.agent.id);
		const model = ctx.model;
		if (stoppedChildren.has(key)) {
			ctx.abort();
			return undefined;
		}
		const ledger = childLedger(ctx);
		if (ledger === undefined) {
			// This thread has no run in memory: the worker is not on the director's thread. On this host that means omp placed it on
			// a pooled thread, where the promises about what runs, what it spends and the record cannot be held. Stop it before its
			// first request; an ordinary native child (no run binding) is not Storm's and is left alone.
			const binding = await childBindingOf(ctx);
			if (binding.kind !== "unmanaged") stopDetachedChild(ctx, binding);
			return undefined;
		}
		if (model === undefined) return undefined;
		const selector = selectorOf(model);
		let level: unknown;
		try {
			level = pi.getThinkingLevel?.();
		} catch {
			level = undefined;
		}
		const effort = observedEffort(level);
		const spawn = runSpawns(ledger.runId).findLast(item => item.spawnKey === ctx.agent.id && item.outcome !== "blocked");
		const agent = spawn?.agent ?? ctx.agent.name;
		// What the host resolves a team selector to: the answer and this check agree on the model, not on its spelling.
		const resolve = (entry: string): string | undefined => {
			const slash = entry.indexOf("/");
			if (slash <= 0) return undefined;
			try {
				const found = ctx.modelRegistry.find(entry.slice(0, slash), entry.slice(slash + 1));
				return found === undefined ? undefined : `${found.provider}/${found.id}`;
			} catch {
				return undefined;
			}
		};
		// One bounded decision over everything the check awaits: the admission written at spawn (the approved snapshot this worker
		// was admitted under, never the live team file) and the comparison. The permission path only decides; it never waits for a
		// report to be written. A check that could not finish is a check that could not be made, and the worker is stopped.
		let check: ChildCheck | undefined;
		let admissionAttempt: string | undefined;
		try {
			check = await withinDeadline(
				(async (): Promise<ChildCheck> => {
					const read = await readWorkerAdmission({ agentDir: workerAdmissionAgentDir(), artifactRoot: artifactsOf(ctx), parentId: ctx.agent.parentId, childId: ctx.agent.id });
					if (read.kind !== "record" || read.record.runId !== ledger.runId || read.record.approved === undefined || read.record.approved.length === 0) {
						return { ok: false, reason: "unchecked", observed: selector, approved: [] };
					}
					admissionAttempt = read.record.attempt;
					return checkChildModelAgainst(
						read.record.approved.map(entry => ({ selector: entry.selector, ...(entry.effort === undefined ? {} : { effort: entry.effort as Effort }) })),
						{ provider: model.provider, id: model.id, resolve, ...(effort === undefined ? {} : { effort }) },
					);
				})(),
				CHILD_CHECK_MS,
			);
		} catch {
			check = undefined;
		}
		const decided = check ?? { ok: false as const, reason: "unchecked" as const, observed: selector, approved: [] };
		const ran = { model: selector, ...(effort === undefined ? {} : { effort }), ...(admissionAttempt === undefined ? {} : { attempt: admissionAttempt }) };
		if (decided.ok) {
			const seen = `${selector}:${effort ?? ""}`;
			if (lastRan.get(key) !== seen) {
				lastRan.set(key, seen);
				noteRunRan(ledger.runId, ctx.agent.id, { ...ran, verdict: "verified" });
			}
			return undefined;
		}
		stopChild(ctx, ledger, key, modelMismatchNotice(agent, decided), decided.reason === "unchecked" ? undefined : { ...ran, verdict: "mismatch" });
		return undefined;
	});

	/**
	 * Whether the turn a message to this worker would start can write the shared tree: it cannot when the worker's
	 * persisted authority ended with its last turn (or was revoked), or when its approved policy never writes there (a
	 * reader without a shell, a private checkout, a blocked lane). A record that is missing, unreadable or still live and
	 * able to write proves nothing, and the caller falls back to the gates a work message meets.
	 */
	const wakeCannotWrite = async (ctx: ExtensionContext, agentId: string): Promise<boolean> => {
		try {
			const read = await readWorkerAdmission({ agentDir: workerAdmissionAgentDir(), artifactRoot: artifactsOf(ctx), parentId: ctx.agent.id, childId: agentId });
			if (read.kind !== "record") return false;
			const { record } = read;
			if (record.revokedAt !== undefined || record.endedAt !== undefined) return true;
			const kind = record.policy.kind;
			return (kind === "read" && record.policy.shell !== true) || kind === "private" || kind === "blocked";
		} catch {
			return false;
		}
	};

	/**
	 * What the director's read gate may open beyond plain reads: the transcripts (`history://<id>`) of this session's own
	 * agents. Read lazily, only for a transcript read, so no other call pays for the listing; omp resolves `history://`
	 * across sessions, so an id this session never ran is refused.
	 */
	const supervisorScope = (ctx: ExtensionContext): SupervisorScopeSource => (): SupervisorScope => {
		const own = agentScope(ctx);
		return {
			agentIds: own === undefined ? [] : listAgents({ ancestorId: ctx.agent.id, scope: own }).map(agent => agent.id),
			// A registry that cannot be read is read as "an agent is named current": the own-branch reading is then not assumed.
			hostAgentIds: registryAgentIds() ?? ["current"],
		};
	};

	// Director mode: blocking the call instead of swapping the tool list keeps the main session's prompt cache intact.
	/**
	 * Another extension, loaded after Storm, may rewrite a call's arguments after Storm's hook answered. When the host starts the call
	 * its arguments are final: if they name files the hold does not cover (or cannot be read at all), the files it really writes are
	 * held from now on (the whole tree when they cannot be named) and the director is told. The call cannot be refused any more, so a
	 * writer that already held those files is not stopped: that is the stated limit (docs/design.md).
	 */
	const widenToWhatRuns = (event: { toolName: string; toolCallId: string; args?: unknown }, ctx: ExtensionContext, root: string): void => {
		const lanes = runs.runLanes();
		const held = lanes?.directorCallPaths(event.toolCallId);
		if (lanes === undefined || held === undefined) return;
		const real = decideDirectorCall({ toolName: event.toolName, input: event.args, cwd: ctx.cwd, root });
		const covered = (path: string): boolean => held.some(scope => scope === "." || path === scope || path.startsWith(`${scope}/`));
		if (real.kind === "director-path" && real.paths.every(covered)) return;
		const extra = real.kind === "director-path" ? real.paths.filter(path => !covered(path)) : ["."];
		if (!lanes.widenDirectorCall(event.toolCallId, extra)) return;
		runs.noteDirector(`[storm:director-edit] ${DIRECTOR_REWRITTEN}`);
	};

	/** Ends the holds of these director calls in the run's write table and forgets them here. Idempotent; an id nobody holds changes nothing. */
	const releaseDirectorHolds = (ids: Iterable<string>): void => {
		const released = [...ids];
		for (const id of released) directorHolds.delete(id);
		if (released.length > 0) runs.runLanes()?.releaseDirectorCalls(released);
	};

	/**
	 * The director's own change of a project file during a run (the main session's hook, a path tool with a plain path). It is one
	 * more writer in the run's write table, and it enters last:
	 * 1. The call is classified and its targets are named from the call itself (`decideDirectorCall`); a call whose files cannot be
	 *    named, or that leaves the work tree, is refused here with its cause. Nothing is held yet.
	 * 2. The write lease is taken, and then the same wait every writer meets for the authority of a worker that ended (it is withdrawn
	 *    before this call may write beside what that worker held). Both are awaits, so the run's liveness is captured before them.
	 * 3. The targets are computed again: a link or a file may have changed during those waits, and the table must hold what the call
	 *    will write now, not what it would have written earlier.
	 * 4. In one synchronous step, `commitWriter` checks that the run is still this session's and not ending, that the host's own limit
	 *    for this hook (`extensionHandlers.toolCallTimeoutMs`, less a margin) is not reached, and that no writer that cannot be
	 *    bounded, and no worker on the same files, holds the tree; then it enters the call. Nothing awaits between that step and the
	 *    answer, so the call that runs is the call that was entered.
	 * The hold ends only by `turn_end`, the next completed assistant message, or the switch rules (see those handlers).
	 */
	const directorPathEdit = async (
		event: ToolCallEvent,
		ctx: ExtensionContext,
		run: { runId: string; root: string; scope: string; generation: number; mainId: string; hookStart: number },
	): Promise<ToolCallEventResult | undefined> => {
		const judge = () =>
			decideDirectorCall({
				toolName: event.toolName,
				input: event.input,
				cwd: ctx.cwd,
				root: run.root,
				...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
			});
		const refused = (block: Parameters<typeof blockText>[0]): ToolCallEventResult => {
			runs.noteBlockedEdit();
			return { block: true, reason: blockText(block) };
		};
		const moved = (): boolean => run.generation !== sessionGeneration || mainSessionId(ctx) !== run.mainId;
		const first = judge();
		if (first.kind === "block") return refused(first.block);
		// A call the caller classified as a file change is never "allowed" unjudged: no names, no hold, no run.
		if (first.kind === "allow") return refused(directorWriteBlock(DIRECTOR_WRITE_NO_TARGET));
		const callId = event.toolCallId;
		if (typeof callId !== "string" || callId === "") return refused(directorWriteBlock(DIRECTOR_WRITE_NO_CALL));
		// What the commit's proof compares against is read before the first await.
		const proof = runs.liveCheck(ctx);
		const lease = await runs.ensureLease(ctx);
		if (!lease.ok) return { block: true, reason: `[storm:lease] ${lease.reason}` };
		if (moved()) return refused(directorWriteBlock(DIRECTOR_WRITE_MOVED));
		// The same wait every writer meets: a worker that ended may still hold authority in the persisted record until its revoke lands.
		const unsettled = await settleEndRevokes(run.runId);
		if (unsettled !== undefined) return { block: true, reason: unsettled };
		if (moved()) return refused(directorWriteBlock(DIRECTOR_WRITE_MOVED));
		const second = judge();
		if (second.kind === "block") return refused(second.block);
		if (second.kind === "allow") return refused(directorWriteBlock(DIRECTOR_WRITE_NO_TARGET));
		const lanes = runs.runLanes();
		if (lanes === undefined || lanes.runId !== run.runId) return refused(directorWriteBlock(DIRECTOR_WRITE_ENDING));
		// From the host's own limit for this hook: its handler is blocked at `timeout`, and what it does after is ignored by the host.
		const timeout = liveToolCallTimeoutMs();
		const now = Date.now();
		const committed = lanes.commitWriter({
			kind: "director-path",
			callId,
			paths: second.paths,
			live: () => (moved() ? { ok: false, reason: DIRECTOR_WRITE_ENDING } : proof()),
			deadline: run.hookStart + timeout - Math.min(2_000, timeout / 2),
			now,
			agents: listAgents({ runId: run.runId, scope: run.scope }),
		});
		if (!committed.ok) return refused(directorWriteBlock(committed.reason));
		directorHolds.set(callId, { runId: run.runId, root: run.root, started: false, resulted: false, seen: seenDirectorCallsOverflowed || seenDirectorCalls.has(callId) });
		committedHere.add(callId);
		return undefined;
	};

	const guardToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		// The host's budget for this hook starts about now (see `directorPathEdit`).
		const hookStart = Date.now();
		if (ctx.agent.kind === "sub") {
			const ledger = childLedger(ctx);
			const boundRunId = ledger?.runId;
			let authority = agentAuthorities.get(authorityKey(artifactsOf(ctx), ctx.agent.id));
			let managed = authority !== undefined || boundRunId !== undefined;
			let denied: string | undefined;
			// A worker whose own request ran on a model or effort the team did not approve was stopped: it only reports.
			if (event.toolName !== "yield" && stoppedChildren.has(authorityKey(artifactsOf(ctx), ctx.agent.id))) {
				return {
					block: true,
					reason: "[storm:model-mismatch] 이 워커는 팀이 승인하지 않은 모델이나 추론 강도로 실행되어 멈췄습니다. 도구를 더 쓰지 말고 지금까지의 결과를 yield로 끝내세요.",
				};
			}
			const asks = event.toolName === "ask";
			// The in-memory map is thread-local. For every non-read tool, the persisted parent admission is the truth,
			// so a worker-homed child after a module rebind enforces the same path/read policy. A managed run with no
			// record for this child is denied instead of silently becoming ordinary. `ask` is read-only to the lane policy
			// but is still resolved here: a managed worker must never put its own form in front of the user.
			if (asks || !readOnlyTool(event.toolName)) {
				const resolved = await childWorkerAuthority(ctx);
				if (resolved.kind === "authorized") {
					authority = resolved.authority;
					managed = true;
				} else if (resolved.kind === "denied") {
					denied = resolved.reason;
					managed = true;
				} else {
					managed = managed || authority !== undefined;
				}
			}
			// A managed worker never owns the user's attention: its question belongs to the director, with the choices
			// and progress it found. An unrelated native child keeps its own ask tool.
			if (asks && managed) {
				const director = ctx.agent.parentId === undefined ? "감독" : `agent://${ctx.agent.parentId}`;
				return {
					block: true,
					reason: `[storm:worker-ask] Storm이 관리하는 워커는 사용자에게 직접 ask할 수 없습니다. 막힌 도구 결과, 확인한 선택지와 진행 상황을 ${director}에게 보고하세요. 사용자의 확인을 추측하거나 새로 만들지 마세요.`,
				};
			}
			// A nested spawn would bypass the director's plan and this worker's authority. The fence is tied to this
			// process's Storm workers/run binding or the persisted admission, so an unrelated concurrent subagent
			// session keeps its own task tool.
			if (event.toolName === "task" && managed) {
				return {
					block: true,
					reason: "[storm:lane-nested] 중첩 task는 실행의 레인 배정과 쓰기 권한을 우회하므로 막았습니다. 감독이 계획한 레인으로 직접 스폰하고, 이 워커는 맡은 결과만 보고하세요.",
				};
			}
			// The model and the effort of a role are the user's team setting, fixed when the worker was routed. omp lets an
			// agent change itself or a direct child through these two paths: a managed worker never does, whatever its
			// lane's authority. Ordinary messages and reads are not control paths and are not touched here.
			if (managed && agentControlTarget(event.toolName, event.input) !== undefined) {
				return {
					block: true,
					reason: "[storm:worker-control] 에이전트의 모델과 추론 강도는 사용자의 팀 설정이라 워커가 바꿀 수 없습니다. 지금 모델로 맡은 결과를 보고하고, 더 나은 모델이 필요하면 감독에게 알리세요.",
				};
			}
			if (denied !== undefined) {
				return { block: true, reason: `[storm:authority] ${denied} 승인된 레인 권한을 확인할 수 없어 쓰기·실행·중첩 호출을 허용하지 않았습니다.` };
			}
			if (authority !== undefined) {
				const { policy, root, lane } = authority;
				const who = lane === undefined ? ctx.agent.id : `'${lane}' 레인(${ctx.agent.id})`;
				// The subject form: a fixed noun stands before the particle whatever the inserted id is.
				const whoTopic = lane === undefined ? `${ctx.agent.id} 에이전트는` : `'${lane}' 레인(${ctx.agent.id})은`;
				// An unplanned worker has no concrete lane: it may read, but it never gains shared write or exec
				// powers merely because it lives in the same tree as an approved writer.
				if (policy.kind === "blocked" || (policy.kind === "unknown" && lane === undefined)) {
					if (!readOnlyTool(event.toolName)) {
						return {
							block: true,
							reason: `[storm:lane] ${whoTopic} 승인된 계획의 구체적인 레인에 속하지 않아 '${event.toolName}' 쓰기·실행 권한을 받지 못했습니다. 감독이 레인을 계획해야 합니다.`,
						};
					}
				}
				// A read lane approved with a shell (a review lane or any other) may also run commands (`bash`) and nothing else
				// beyond reading: no path write, no eval. Its lane is ordered like a shared writer where it is placed, so no other
				// writer runs with it.
				if (policy.kind === "read" && !readOnlyTool(event.toolName) && !(shellReader(policy) && event.toolName === "bash")) {
					return {
						block: true,
						reason: policy.shell === true
							? `[storm:lane-capability] ${whoTopic} 읽기와 셸 실행만 승인되어 '${event.toolName}' 도구를 쓸 수 없습니다. 파일은 고치지 말고, 읽기·검색·검증 명령만 쓰세요.`
							: `[storm:lane-capability] ${whoTopic} 읽기 전용으로 승인되어 '${event.toolName}' 도구를 쓸 수 없습니다. 읽기·검색·검증 도구만 쓰고, 변경이 필요하면 감독에게 쓰기 레인을 요청하세요.`,
					};
				}
				// A service (`bash` with a `name`) lives in omp's daemon: it is no job of this session, the worker's turn does not wait
				// for it, and it keeps writing after the reservation behind this worker is freed. A worker that is ordered against
				// the other writers of the tree (an exec-capable lane, a read lane with a shell) must not start one.
				if (startsService(event.toolName, event.input) && (policy.kind === "unknown" || shellReader(policy))) {
					return { block: true, reason: `[storm:lane-service] ${whoTopic} 서비스를 시작할 수 없습니다. ${WORKER_SERVICE_REASON}` };
				}
				if (policy.kind === "private" && pathWriteTool(event.toolName) && !readOnlyTool(event.toolName)) {
					// A private checkout is not a license to write the parent or an arbitrary cwd: bind path tools to
					// the exact host-attested checkout that this attempt claimed.
					const checkout = authority.checkout ?? authority.root;
					const targets = toolWriteTargets(event.toolName, event.input);
					const outside = targets.filter(target => !targetWithinScope(target, ["."], checkout));
					if (targets.length === 0 || outside.length > 0) {
						return {
							block: true,
							reason: `[storm:lane-scope] ${who}의 격리 체크아웃 밖으로 나가는 쓰기는 허용하지 않았습니다. ${targets.length === 0 ? "대상 경로를 확인할 수 없는 쓰기" : `체크아웃 밖 경로: ${outside.join(", ")}`}`,
						};
					}
				}
				if (policy.kind === "paths") {
					if (!readOnlyTool(event.toolName)) {
						if (!pathWriteTool(event.toolName)) {
							return {
								block: true,
								reason: `[storm:lane-capability] ${whoTopic} 승인된 경로 쓰기 도구만 쓸 수 있고 '${event.toolName}' 도구는 임의 실행/알 수 없는 쓰기입니다. 감독이 실행 권한을 가진 레인으로 다시 배정해야 합니다.`,
							};
						}
						const targets = toolWriteTargets(event.toolName, event.input);
						const outside = targets.filter(target => !targetWithinScope(target, policy.paths, root));
						if (targets.length === 0 || outside.length > 0) {
							return {
								block: true,
								reason: `[storm:lane-scope] ${who}의 쓰기 경로는 ${policy.paths.join(", ")}입니다. ${targets.length === 0 ? "대상 경로를 확인할 수 없는 쓰기는" : `경로 이탈(${outside.join(", ")})은`} 허용하지 않았습니다. 승인된 범위 안에서 쓰거나 감독에게 새 레인을 요청하세요.`,
							};
						}
					}
				}
			}
			// A subagent's reads are indexed under the run its parent admitted; no cwd or repo match is trusted.
			if (event.toolName !== "read") return undefined;
			if (!ledger) return undefined;
			const runId = ledger.runId;
			noteAgentRun(ctx.agent.id, runId, ledger.sessionDir);
			noteChildRead(runId, ctx.agent.id, pathOf(event.input), ctx.cwd);
			return undefined;
		}
		const auto = autoOf(ctx);
		const autoOn = auto?.enabled === true;
		const generation = sessionGeneration;
		const mainId = mainSessionId(ctx);
		const runId = runs.runId();
		if (event.toolName === "ask") {
			const blocked = mainAskGate(ctx, event.input, autoOn, runId);
			if (blocked !== undefined) return blocked;
		}
		if (runId === undefined) {
			// Automatic delegation: the main session may orchestrate and inspect worker results, but every repository
			// tool and every direct spawn is refused until the first plan opens this turn's run.
			if (!autoOn || event.toolName === "storm") return undefined;
			const detail =
				event.toolName === "task" ? AUTO_SPAWN_REASON : supervisorToolBlock(event.toolName, event.input, supervisorScope(ctx), planModeOn(ctx));
			if (detail === undefined) return undefined;
			return { block: true, reason: autoRefusal(auto?.problem, detail) };
		}
		// A live run must name the session that owns it: without that, no direct tool is safe to allow.
		if (mainId === undefined) {
			return { block: true, reason: "[storm:session] 이 세션의 id를 확인하지 못해 Storm 실행 도구를 막았습니다. 새 대화에서 다시 시도하세요." };
		}
		// Automatic delegation keeps the supervisor gate during the run too: it refuses what starts a command, has unknown
		// effects or reads something that is not a plain read, each with its own cause. Reads and searches, task, the typed
		// messages and notes stay open, and so do the path tools that change project files: they go on to the director's
		// own edit rule below, which names the files or refuses. (Before the run the gate above refuses them.)
		if (autoOn) {
			const strict = supervisorRunToolBlock(event.toolName, event.input, supervisorScope(ctx), planModeOn(ctx));
			if (strict !== undefined) return { block: true, reason: autoRunRefusal(strict) };
		}
		// An eval turn can start several children without a native task batch; during a run every worker must come
		// through a planned task lane, so eval's unplanned spawn path is refused before any child starts.
		if (event.toolName === "eval" && runId !== undefined) {
			return { block: true, reason: "[storm:lane] 실행 중에는 eval로 에이전트를 스폰할 수 없습니다. 승인된 계획의 레인을 task로 호출하세요." };
		}
		// A worker's model and effort are the user's approved setting. omp lets a session change another agent's through these
		// control paths, so the director does not touch them while it directs a run.
		if (agentControlTarget(event.toolName, event.input) !== undefined) {
			return { block: true, reason: `[storm:director-control] ${DIRECTOR_CONTROL_REASON}` };
		}
		// A call that only reads or searches acts on no run and changes no tree: another conversation's reads (after /new, a fork or
		// a switch while the old run still drains) are not held back by it. Anything that can write stays refused below.
		const plainRead = (): boolean => readOnlyTool(event.toolName) && supervisorToolBlock(event.toolName, event.input, supervisorScope(ctx), planModeOn(ctx)) === undefined;
		const config = runs.runConfig(ctx);
		if (!config) {
			if (plainRead()) return undefined;
			// A live run whose owning session cannot be proven is not a reason to let direct tools through.
			return { block: true, reason: "[storm:session] 실행의 세션 소유권을 확인하지 못해 이 도구 호출을 막았습니다. 실행 상태를 확인한 뒤 다시 시도하세요." };
		}
		// Every judgment below is the run's own: its ledger names the session whose workers and limits apply.
		const runLedger = getLedgerRun(runId);
		const runScope = runLedger?.sessionDir;
		if (runScope === undefined) {
			if (plainRead()) return undefined;
			return { block: true, reason: "[storm:session] 실행의 세션 저장소를 확인하지 못해 이 도구 호출을 막았습니다. 실행 상태를 확인한 뒤 다시 시도하세요." };
		}
		// Shell, eval and unknown/MCP tools can write without naming a path: under a read lease they must claim the
		// target's write authority first. Path write tools are already bounded by the director rule below. An automatic
		// director never reaches this with such a tool: the supervisor gate above refused every one that edits, runs a
		// command or has unknown effects, so what is left (`lsp`, `propose`) cannot write and needs no lease.
		if (!autoOn && directorNeedsTree(event.toolName, event.input, planModeOn(ctx))) {
			// A service lives in omp's daemon: it is no job of this session, and nothing says when it ends.
			if (startsService(event.toolName, event.input)) return { block: true, reason: `[storm:director-service] ${DIRECTOR_SERVICE_REASON}` };
			const writable = await runs.ensureWrite(ctx);
			if (!writable.ok) return { block: true, reason: `[storm:lease] ${writable.reason}` };
			if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
				return { block: true, reason: "[storm:session] 대화가 바뀌어 이 호출을 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
			}
			// The last authoritative step: the call takes the shared tree in the run's lane table in one synchronous step, so a
			// worker, a job or a check that starts in the same message or later meets this command, and this command meets them.
			const lanes = runs.runLanes();
			if (lanes === undefined || lanes.runId !== runId || typeof event.toolCallId !== "string") {
				return { block: true, reason: "[storm:director-exec] 이 실행의 쓰기 순서를 확인하지 못해 이 호출을 막았습니다. 실행 상태를 확인한 뒤 다시 시도하세요." };
			}
			const taken = lanes.commitDirectorExec({ callId: event.toolCallId, agents: listAgents({ runId, scope: runScope }), now: Date.now() });
			if (!taken.ok) return { block: true, reason: `[storm:director-exec] ${taken.reason}` };
		}
		// The director's own change of a project file: a path tool whose exact targets Storm names and commits to the run's write
		// table as the last step before the call runs, or a refusal with its cause. Every other file change stays refused. A call
		// that is no file change now is remembered until it starts, so a later extension's rewrite into one still gets a hold (RF3).
		if (directorFileChange(event.toolName, event.input) !== undefined) {
			return directorPathEdit(event, ctx, { runId, root: runLedger?.root ?? ctx.cwd, scope: runScope, generation, mainId, hookStart });
		}
		if (typeof event.toolCallId === "string") {
			revisableDirectorCalls.set(event.toolCallId, { runId, root: runLedger?.root ?? ctx.cwd, generation });
			if (revisableDirectorCalls.size > 256) revisableDirectorCalls.delete(revisableDirectorCalls.keys().next().value as string);
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
			const readiness = await readinessFor(plan);
			const ledgerRun = getLedgerRun(runId);
			const planRoot = plan === undefined ? undefined : ledgerRun?.root ?? (await repoFor(ctx)).root;
			const planEnv = planRoot === undefined ? undefined : ledgerRun !== undefined ? runEnv(ledgerRun) : envForSession(mainId, planRoot);
			const planState = planEnv === undefined ? undefined : await stateCache.get(planEnv);
			const policyView = plan !== undefined && planRoot !== undefined && planState !== undefined
				? await policiesForPlan(plan, config, planState.shadows, planRoot, autoOn)
				: undefined;
			if (policyView !== undefined && !policyView.ok) return { block: true, reason: `[storm:lane-capability] ${policyView.reason}` };
			{
				const problem = taskLaneProblem(event.input, plan, config);
				if (problem !== undefined) return { block: true, reason: `[storm:${problem.code}] ${problem.reason}` };
			}
			if (autoOn && plan === undefined) {
				return { block: true, reason: "[storm:auto] 계획을 확인하지 못해 task를 막았습니다. plan을 다시 제출하세요." };
			}
			// The awaits above may have outlived the conversation that asked for this placement.
			if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
				return { block: true, reason: "[storm:session] 대화가 바뀌어 이 task 호출을 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
			}
			// A spawn that may write claims the target's write lease before any name, lane or worker exists. Read-only
			// spawns keep their read lease so concurrent reading runs stay independent.
			if (planMayWrite(plan)) {
				const writable = await runs.ensureWrite(ctx);
				if (!writable.ok) return { block: true, reason: `[storm:lease] ${writable.reason}` };
				if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
					return { block: true, reason: "[storm:session] 대화가 바뀌어 이 task 호출을 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
				}
			}
			const placeOnce = () => {
				const now = {
					...(host === undefined ? {} : { host }),
					...(readiness === undefined ? {} : { readiness }),
					...(policyView === undefined || !policyView.ok ? {} : { policies: policyView.policies, canonicalFiles: policyView.canonicalFiles }),
					// Each item's own lane's result contract: what Storm will judge, and how. Per item, because isolation is.
					decorate: ({ lane, isolated }: { lane: PlanLane | undefined; isolated: boolean }): string | undefined => {
						const contract = lane === undefined ? undefined : laneContract(lane, { isolated });
						if (lane === undefined || contract === undefined) return undefined;
						contractDigests.placed.set(`${runId}\0${lane.name}`, contract.digest);
						return contract.text;
					},
					agents: listAgents({ runId, scope: runScope }),
					...(typeof event.toolCallId === "string" ? { callId: event.toolCallId } : {}),
					now: Date.now(),
					};
				return autoOn && plan !== undefined
					? lanes.assign(event.input, plan, config, now)
					: lanes.place(event.input, plan, config, now);
			};
			let placed = placeOnce();
			const waitUntil = Date.now() + timings.writeWaitMs;
			// A single fresh item waits briefly for a writer that is settling (a native task often returns before its
			// worker starts). A batch never waits: a conflicting batch refuses before any item is reserved or started.
			// A batch-internal overlap never waits because no host event can clear it.
			const oneItem = !Array.isArray(event.input.tasks) || event.input.tasks.length === 1;
			while (oneItem && !placed.ok && placed.retry === true && Date.now() < waitUntil) {
				await pause(timings.writeWaitStepMs);
				placed = placeOnce();
			}
			if (!placed.ok) {
				// A refusal with no code is one of the two isolation settings (omp's `task.isolation`): nothing to do with the mode.
				const tag = placed.code !== undefined ? `[storm:${placed.code}]` : "[storm:isolation]";
				return { block: true, reason: `${tag} ${placed.reason}` };
			}
			// The wait above may have outlived the conversation that asked for this spawn.
			if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
				return { block: true, reason: "[storm:session] 대화가 바뀌어 이 task 호출을 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
			}
			// A lane that started ahead of a prerequisite says so in this call's own result.
			if (placed.notes !== undefined && typeof event.toolCallId === "string") startNotes.set(`${runId}\0${event.toolCallId}`, placed.notes);
			// The approved reviewer gets the exact submissions it must judge with its own task, not only an id or hash.
			const finalInput = withAnswerReviewTask(placed.input, approvedReviewer(config), () => runs.takeAnswerReviewBatch());
			// The exact toolCallId is host-issued; admitted sync children later carry it into their attempt id.
			attempts.observeTaskCall({ runId, parentId: ctx.agent.id, toolCallId: event.toolCallId, input: finalInput, startedAt: Date.now() });
			return finalInput === event.input ? undefined : { input: finalInput };
		}
		// Even a quiet `?progress` write can wake an idle OMP recipient. A read is the no-wake status path.
		const progress = followUpProgress(event.toolName, event.input);
		const followTarget = followUpTarget(event.toolName, event.input);
		if (followTarget?.toLowerCase() === "all") {
			// omp does not count the wakes of a broadcast against its own ceiling, so the ceiling (`task.maxConcurrency`) is
			// the one limit a broadcast meets here: refused only when waking every idle worker would exceed it.
			const nativeLimit = liveTaskMaxConcurrency();
			const everyone = listAgents({ runId, scope: runScope });
			const known = new Set(everyone.map(agent => agent.id));
			for (const slot of reservedWorkers(runId)) known.add(slot.key);
			const refusal = broadcastBlock({
				runId,
				agents: everyone,
				...(nativeLimit === undefined ? {} : { maxConcurrency: nativeLimit, otherActive: otherNativeWorkers(ctx, known) }),
				now: Date.now(),
			});
			if (refusal !== undefined) return { block: true, reason: `[storm:lane-capacity] ${refusal}` };
			// Past the run's budget a broadcast that carries work wakes every idle worker, which is new spending as much as
			// a message to one of them is (R-final N2); workers already running take it as they take any message.
			if (!progress && everyone.some(agent => agent.state !== "running")) {
				const run = getLedgerRun(runId);
				const over = followUpBudgetBlock(run === undefined ? undefined : { budget: run.budget, costUsd: run.costUsd });
				if (over !== undefined) return { block: true, reason: blockText(over) };
			}
			// A broadcast starts turns that no write order sits in front of. That is safe only for workers whose authority
			// cannot write the shared tree now (their last turn ended it): one that is not proven so goes through the
			// gates of a message to that worker alone.
			for (const agent of everyone) {
				if (agent.state === "running" || (await wakeCannotWrite(ctx, agent.id))) continue;
				return {
					block: true,
					reason: `[storm:lane-write] agent://all 은 ${agent.id} 워커를 쓰기 권한이 끝났다고 확인하지 못한 채 깨우게 됩니다. agent://<id>로 워커마다 보내면 쓰기 순서 검사를 거칩니다.`,
				};
			}
		}
		const followAgent = followTarget === undefined ? undefined : followUpAgent(listAgents({ scope: runScope }), followTarget);
		const followLanes = runs.runLanes();
		let followToken: string | undefined;
		let followLane: PlanLane | undefined;
		if (followAgent !== undefined && followLanes !== undefined) {
			// A job batch starts only with no live workers; do not admit a message that can wake one into it.
			const blockedByJob = runs.jobGate();
			if (blockedByJob !== undefined) return { block: true, reason: blockedByJob };
			// Past the run's budget a message that carries work to an idle worker is new spending, like a new spawn (R-G234 M4).
			if (!progress) {
				const run = getLedgerRun(runId);
				const over = followUpBudgetBlock(run === undefined ? undefined : { budget: run.budget, costUsd: run.costUsd });
				if (over !== undefined && !listAgents({ runId, scope: runScope }).some(agent => agent.id === followAgent.id && agent.state === "running")) {
					return { block: true, reason: blockText(over) };
				}
			}
			// A quiet note wakes a turn that can only read and report when the worker's authority is proven ended: the note
			// then re-opens nothing (below) and needs no write lease, write order or slot. Unproven, it meets the gates a
			// work message does, as before. (The two checks that make it safe are this one and the skipped re-admission.)
			const quietWake = progress && (await wakeCannotWrite(ctx, followAgent.id));
			// A work-bearing follow-up starts a new turn that may write: prove the target's write lease first.
			if (!quietWake) {
				const writable = await runs.ensureWrite(ctx);
				if (!writable.ok) return { block: true, reason: `[storm:lease] ${writable.reason}` };
			}
			const run = getLedgerRun(runId);
			if (run === undefined) {
				return { block: true, reason: "[storm:session] 실행 원장을 확인하지 못해 후속 지시를 적용하지 않았습니다. 실행 상태를 확인하세요." };
			}
			const plan = run.plan;
			const laneName = runSpawns(runId).find(spawn => spawn.spawnKey === followAgent.id && spawn.outcome !== "blocked")?.lane;
			// A reused live agent has no spawn row in this run; it may still be bound to the plan only when exactly one
			// lane of its role is authorized. Ambiguous same-role lanes never guess.
			const byRole = plan?.lanes.filter(candidate => candidate.job === undefined && candidate.role === followAgent.role) ?? [];
			const lane = laneName !== undefined ? plan?.lanes.find(candidate => candidate.name === laneName) : byRole.length === 1 ? byRole[0] : undefined;
			// An unplanned non-reviewer worker has no authorized write target for more work. A read-only reviewer in a
			// run with no plan can still deliver a verdict: it gets no write admission, and its tools are read-only.
			if (lane === undefined && followAgent.role !== "reviewer") {
				return { block: true, reason: "[storm:lane] 이 워커는 승인된 계획의 구체적인 레인에 속하지 않아 후속 작업을 보내지 않았습니다. 레인을 다시 계획하세요." };
			}
			followLane = lane;
			let authority: AgentAuthority | undefined;
			if (lane !== undefined) {
				// A reused agent must keep its enforced capability; recompute if this session did not see its spawn.
				const workerKey = authorityKey(artifactsOf(ctx), followAgent.id);
				authority = agentAuthorities.get(workerKey);
				if (authority === undefined) {
					const state = await stateCache.get(runEnv(run));
					const currentConfig = state.config.status === "ok" ? state.config.config : config;
					const computed = await authorityFor({
						agent: followAgent.name,
						lane,
						shadows: state.shadows,
						config: currentConfig,
						root: run.root,
						auto: autoOn,
					});
					if (!computed.ok) return { block: true, reason: `[storm:lane-capability] ${computed.reason}` };
					authority = computed.authority;
					agentAuthorities.set(workerKey, authority);
				}
			}
			const readiness = await readinessFor(plan);
			// A lease upgrade, a state read and a readiness probe are all awaits; the conversation may have changed.
			if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
				return { block: true, reason: "[storm:session] 대화가 바뀌어 이 후속 지시를 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
			}
			const followAgents = listAgents({ runId, scope: runScope });
			const nativeLimit = liveTaskMaxConcurrency();
			let nativeOther = 0;
			if (nativeLimit !== undefined && nativeLimit > 0) {
				const known = new Set(followAgents.map(agent => agent.id));
				for (const slot of reservedWorkers(runId)) known.add(slot.key);
				nativeOther = otherNativeWorkers(ctx, known);
			}
			const authorityPolicy: LanePolicy | undefined = authority?.policy;
			const gate = followLanes.checkFollowUp({
				runId,
				agentId: followAgent.id,
				agent: followAgent.name,
				...(followAgent.role === undefined ? {} : { role: followAgent.role }),
				...(lane === undefined ? {} : { lane }),
				// The enforced authority this worker actually runs under, with its canonical files, and the same auto
				// flag a fresh task placement uses: a reactivation takes exactly the shared-write rule of a first task.
				...(authorityPolicy === undefined ? {} : { policy: authorityPolicy }),
				...(authorityPolicy?.kind === "paths" ? { canonicalFiles: authorityPolicy.paths } : {}),
				auto: autoOn,
				// A quiet progress note meets the same conflict gate for an idle recipient but reserves nothing; a work note holds its lane until the turn starts.
				...(progress ? { progress: true } : {}),
				// The wake is proven read-only (its authority ended and is not re-opened below): no write order applies.
				...(quietWake ? { wakeReadOnly: true } : {}),
				...(typeof event.toolCallId === "string" ? { callId: event.toolCallId } : {}),
				...(plan === undefined ? {} : { plan }),
				config,
				...(nativeLimit === undefined ? {} : { maxConcurrency: nativeLimit }),
				isolated: config.isolation === "isolated",
				...(readiness === undefined ? {} : { readiness }),
				agents: followAgents,
				otherActive: nativeOther,
				now: Date.now(),
			});
			if (!gate.ok) return { block: true, reason: `[storm:${gate.code}] ${gate.reason}` };
			followToken = gate.token;
			if (!progress && typeof event.toolCallId === "string" && followAgents.some(agent => agent.id === followAgent.id && agent.state !== "running")) {
				followWakeCalls.add(`${runId}\0${event.toolCallId}`);
			}
			if (gate.reserved === true) followCapacityCalls.set(`${runId}\0${event.toolCallId}`, { runId, agentId: followAgent.id });
			// A follow-up that starts a lane ahead of a prerequisite says so in its own result.
			if (gate.notes !== undefined && typeof event.toolCallId === "string") startNotes.set(`${runId}\0${event.toolCallId}`, gate.notes);
			// The reused worker's next turn runs in its own module (possibly another thread): refresh the exact
			// admission with a new attempt before the delivery can execute. A quiet note does not: the woken turn keeps the
			// admission its last turn ended, so it can read and yield but never write or run a command.
			if (!quietWake && lane !== undefined && authority !== undefined) {
				// The follow-up carries the approved entries of the decision that admitted this worker, read from its own
				// admission. Rebuilding them from the current team file (or the run-start one) would re-authorize a model the
				// user did not approve at that decision (RF3-2). A worker this run never admitted (a reused leftover) has no
				// earlier decision, so this follow-up is its first admission and uses the current approved entries.
				const original = runSpawns(run.runId).findLast(item => item.spawnKey === followAgent.id && item.outcome !== "blocked");
				const trial = original?.trialId === undefined ? undefined : config.trials?.find(item => item.id === original.trialId);
				const fallback = () => approvedEntries(config, followAgent.name, trial === undefined ? undefined : { model: trial.model, ...(trial.effort === undefined ? {} : { effort: trial.effort }) });
				const reopened = await reopenChildAdmission({ ctx, run, artifacts: artifactsOf(ctx), childId: followAgent.id, lane, authority, approved: fallback }).catch(() => ({
					ok: false as const,
					reason: "후속 작업의 자식 실행 권한을 저장하지 못했습니다. 프로필 경로와 권한을 확인하세요.",
				}));
				if (!reopened.ok) {
					followLanes.finishFollowUp(followToken, false);
					return { block: true, reason: `[storm:authority] ${reopened.reason}` };
				}
			}
		}
		if (followAgent !== undefined && followAgent.name === approvedReviewer(config)) {
			const run = getLedgerRun(runId);
			const key = reviewerBaselineKey(artifactsOf(ctx), followAgent.id);
			const cwd = childWorkTrees.get(key);
			if (run !== undefined && cwd !== undefined) await recordReviewerBaseline(exec, artifactsOf(ctx), followAgent.id, run, cwd);
			else reviewerBaselines.delete(key);
		}
		// A follow-up turn is new work: capture its lane's pre-write baseline before the write executes. A child this
		// run never admitted is left alone; the collector only tracks lanes with declared results.
		if (!progress && followAgent !== undefined && followLane !== undefined) {
			const artifactMode = followLane.isolationReason !== undefined || config.isolation === "isolated" ? "isolated" : "shared";
			const admitted = await attempts.admitFollowUp({
				runId,
				parentId: ctx.agent.id,
				spawnKey: followAgent.id,
				lane: followLane,
				artifactMode,
				toolCallId: event.toolCallId,
				startedAt: Date.now(),
			});
			if (!admitted.ok) {
				if (followToken !== undefined) followLanes?.finishFollowUp(followToken, false);
				return { block: true, reason: blockText({ code: "internal", reason: admitted.reason }) };
			}
			if (typeof event.toolCallId === "string") followDispatches.set(`${runId}\0${event.toolCallId}`, followAgent.id);
		}
		// A block after the admission means the write never lands: its dispatch must not stay open.
		const dropFollowDispatch = (): void => {
			if (typeof event.toolCallId !== "string" || followAgent === undefined) return;
			if (followDispatches.delete(`${runId}\0${event.toolCallId}`)) {
				void attempts.abandonFollowUp({ runId, spawnKey: followAgent.id, toolCallId: event.toolCallId });
			}
		};
		if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
			dropFollowDispatch();
			if (followToken !== undefined) followLanes?.finishFollowUp(followToken, false);
			return { block: true, reason: "[storm:session] 대화가 바뀌어 이 후속 지시를 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
		}
		// The job batch may have started during the authority/readiness awaits. Do not deliver a worker turn into it.
		if (followAgent !== undefined) {
			const blockedByJob = runs.jobGate();
			if (blockedByJob !== undefined) {
				dropFollowDispatch();
				if (followToken !== undefined) followLanes?.finishFollowUp(followToken, false);
				return { block: true, reason: blockedByJob };
			}
		}
		if (followToken !== undefined) followLanes?.finishFollowUp(followToken, true);
		const message = (event.input as { content?: unknown }).content;
		let content = typeof message === "string" && message.trim() !== "" ? message : undefined;
		// A work follow-up is new work under its lane's result contract: it carries the block again when the worker has not been
		// sent the current one (a replan gave the lane results, or Storm restarted and no longer knows what it sent). A progress note
		// is a quiet note and carries nothing.
		if (content !== undefined && !progress && followAgent !== undefined && followLane !== undefined) {
			const contract = laneContract(followLane, { isolated: followLane.isolationReason !== undefined || config.isolation === "isolated" });
			const sentKey = `${runId}\0${followAgent.id}`;
			if (contract !== undefined && contractDigests.sent.get(sentKey) !== contract.digest) {
				content = `${content.trimEnd()}\n\n${contract.text}`;
				// Counted as sent only when the call is known to have been delivered (its result, below).
				if (typeof event.toolCallId === "string") contractDigests.pending.set(`${runId}\0${event.toolCallId}`, { key: sentKey, digest: contract.digest });
			}
		}
		// A work-bearing follow-up that wakes the approved reviewer carries the next unsent batch of answer packets in that
		// one message, so a resumed reviewer session judges exact submissions too. A progress note stays a quiet note.
		if (content !== undefined && !progress && followAgent !== undefined && followAgent.name === approvedReviewer(config)) {
			const packets = runs.takeAnswerReviewBatch();
			if (packets !== undefined) content = `${content.trimEnd()}\n\n${packets}`;
		}
		return content !== undefined && content !== message ? { input: { ...event.input, content } } : undefined;
	};
	// A refused `task` call is not blocked: a block ends the call with `details: {}`, which omp's task view cannot draw
	// (see task-refusal.ts). The call runs into omp's own rejection of a stale field and `tool_result` swaps in Storm's
	// reason. Every other tool keeps the plain block: its view draws that result.
	pi.on("tool_call", async (event, ctx) => {
		let verdict = await guardToolCall(event, ctx);
		// The director's path edit made that wait before its commit (it must be the last step), and nothing may wait after it.
		const committed = ctx.agent.kind === "main" && typeof event.toolCallId === "string" && committedHere.delete(event.toolCallId);
		if (committed) return verdict;
		// A call that may start a writer (everything but a read) answers only after the authority of any worker whose place
		// this call's placement took has really been withdrawn (R-final N4), and fails closed when it could not be.
		if (verdict?.block !== true && ctx.agent.kind === "main" && !readOnlyTool(event.toolName)) {
			const runId = runs.runId();
			const unsettled = runId === undefined ? undefined : await settleEndRevokes(runId);
			if (unsettled !== undefined) verdict = { block: true, reason: unsettled };
		}
		if (verdict?.block === true && ctx.agent.kind === "main" && typeof event.toolCallId === "string") {
			// The host still reports a start for a blocked call. It was judged and refused, not rewritten by another
			// extension, so its start must not hold the whole tree or claim a rewrite.
			refusedDirectorCalls.add(event.toolCallId);
			if (refusedDirectorCalls.size > 256) refusedDirectorCalls.delete(refusedDirectorCalls.values().next().value as string);
		}
		if (verdict?.block !== true || event.toolName !== "task" || typeof event.toolCallId !== "string") return verdict;
		const reason = verdict.reason ?? "";
		refusedCalls.remember(event.toolCallId, reason);
		return { input: refusedTaskInput(event.input, reason) };
	});

	/**
	 * The settled run an active run explicitly named as its continuation or follow-up source, as its bounded handoff.
	 * Only this run's own reference counts, read from the session store that admitted it, and only when this machine's
	 * pointer proves that run started in this session on this same target. Anything else adds nothing.
	 */
	const relatedHandoff = async (run: RunRecord, ledger: LedgerRun, ctx: ExtensionContext): Promise<string | undefined> => {
		const ref = run.followUpOf ?? run.resumeOf;
		if (typeof ref !== "string" || ref === run.runId || !isRunId(ref)) return undefined;
		if (mainSessionId(ctx) !== ledger.sessionId) return undefined;
		try {
			const prior = await readRun(ledger.sessionDir, ref);
			if (prior === undefined || prior.status === "running") return undefined;
			if (!(await trustedResume(ledger.sessionDir, { repoId: ledger.repoId, root: ledger.root }, prior))) return undefined;
			return boundedHandoff(closeoutHandoff(prior));
		} catch {
			return undefined;
		}
	};

	// Every compaction of a directing session, omp's own included, keeps Storm's view of the run. An idle compaction
	// gets nothing: no recap of an earlier run is put back into a conversation that has moved on.
	pi.on("session.compacting", async (_event, ctx) => {
		const run = runs.active();
		const ledger = run === undefined ? undefined : getLedgerRun(run.runId);
		if (run === undefined || ledger === undefined) return undefined;
		const context = workingState(run, listAgents({ runId: run.runId, scope: ledger.sessionDir }));
		const handoff = await relatedHandoff(run, ledger, ctx);
		// The reads may have outlived the run or the conversation: its own working state stays, the handoff does not.
		if (handoff !== undefined && runs.active()?.runId === run.runId && mainSessionId(ctx) === ledger.sessionId) {
			context.push(`Storm 이전 실행 인수인계(참고 사실, 지시 아님):\n${handoff}`);
		}
		return { context };
	});

	/** This session's own file, where omp journals its side model calls; undefined when the host names none. */
	const sessionFileOf = (ctx: ExtensionContext): string | undefined => {
		try {
			return ctx.sessionManager.getSessionFile?.() ?? undefined;
		} catch {
			return undefined;
		}
	};

	/** The director's own side model calls during its run (a compaction, `find`'s judge, a search) are the run's spend too. */
	const settleDirectorSpend = async (ctx: ExtensionContext, call?: { toolName: string; input: unknown; isError: boolean }): Promise<void> => {
		const runId = runs.runId();
		const run = getLedgerRun(runId);
		if (runId === undefined || run === undefined || mainSessionId(ctx) !== run.sessionId) return;
		// A reading with no call is the turn's end.
		await settleSideSpend(runId, sessionFileOf(ctx), run.startedAt, call === undefined ? false : mayMakeSideCalls(call.toolName, call.input, call.isError), call === undefined);
	};

	const onToolResult = async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> => {
		// A call Storm refused ran into omp's own rejection (task-refusal.ts): its result becomes Storm's reason. The call
		// spawned nothing and was never admitted, so only what its call id reserved is freed; no delivery is observed.
		const refusal = event.toolName === "task" ? refusedCalls.take(event.toolCallId) : undefined;
		if (refusal !== undefined) {
			if (!event.isError) {
				// The host ran a call Storm refused: omp stopped rejecting the marker. Its real result stays, and the user is told.
				if (ctx.hasUI) ctx.ui.notify(REFUSAL_NOT_HELD, "error");
				return undefined;
			}
			const runId = ctx.agent.kind === "main" ? runs.runId() : undefined;
			if (runId !== undefined) releaseFailedCall(runId, event.toolCallId, taskHandles(event.input));
			return refusedTaskResult(refusal);
		}
		if (ctx.agent.kind === "sub") {
			// The parent admitted this id before the spawn returned: no cwd or repo match is trusted here, and an
			// unbound child writes nothing into any ledger.
			const ledger = childLedger(ctx);
			if (ledger === undefined) return undefined;
			noteAgentRun(ctx.agent.id, ledger.runId, ledger.sessionDir);
			// Model calls a tool makes outside the session's main loop (an eval cell's `completion()`, `find`'s judge, a search, an
			// edit's repair) reach no hook: omp journals them in this agent's own session file. Read them back into the run's total
			// after every call (only what was appended is parsed); a call that may have made one marks the total a floor until its
			// entry is found, and so does a file that cannot be read.
			await settleSideSpend(ledger.runId, sessionFileOf(ctx), ledger.startedAt, mayMakeSideCalls(event.toolName, event.input, event.isError));
			touchRun(ledger.runId);
			// A reviewer's structured verdict arrives through its `yield`; it lands on the ledger entry and from there in the run record.
			const now = Date.now();
			if (event.toolName === "yield" && !event.isError) {
				noteAgentReview(ctx.agent.id, event.input, now, ledger.sessionDir);
				// Await the bounded snapshot before the turn can settle: the gate never reads a tree this verdict forgot.
				if (verdictOf(event.input) !== undefined) await bindReviewerVerdict(exec, ctx, ledger, now);
			}
			// The review gate reads what the team changed; a file-changing call that failed changed nothing.
			if (!event.isError && directorFileChange(event.toolName, event.input) !== undefined) noteAgentChange(ctx.agent.id, now, ledger.sessionDir);
			return undefined;
		}
		const runId = runs.runId();
		if (!runId) return undefined;
		await settleDirectorSpend(ctx, { toolName: event.toolName, input: event.input, isError: event.isError });
		// A failed delivery frees what its call id reserved (the task's named handles too: the echoed input can lag the
		// placement). A delivered call only forgets its follow-up slot bookkeeping; the reused slot stays with the worker.
		const followDispatch = followDispatches.get(`${runId}\0${event.toolCallId}`);
		followDispatches.delete(`${runId}\0${event.toolCallId}`);
		const wasIdle = followWakeCalls.delete(`${runId}\0${event.toolCallId}`);
		if (event.isError && followDispatch !== undefined) {
			// The write that opened a follow-up dispatch failed: the worker was never asked, so nothing will settle it.
			await attempts.abandonFollowUp({ runId, spawnKey: followDispatch, toolCallId: event.toolCallId });
		}
		if (event.isError) {
			releaseFailedCall(runId, event.toolCallId, event.toolName === "task" ? taskHandles(event.input) : []);
		} else {
			followCapacityCalls.delete(`${runId}\0${event.toolCallId}`);
		}
		// The sync task envelope is read before the isError return: a failed call still carries host results, and a
		// missing item must stay an unmet requirement instead of disappearing.
		if (event.toolName === "task") {
			await attempts.observeTaskResult({
				runId,
				parentId: ctx.agent.id,
				toolCallId: event.toolCallId,
				details: event.details,
				content: event.content,
				observedAt: Date.now(),
			});
		}
		// A native `wait` consumes completed background jobs, so its terminal task rows are deliveries even though no
		// `async-result` message follows. The collector accepts only exact admitted rows with a real deliverable.
		if (event.toolName === "wait") {
			await attempts.observeWaitResult({
				runId,
				parentId: ctx.agent.id,
				details: event.details,
				observedAt: Date.now(),
				jobs: hostJobs(ctx),
			});
		}
		if (event.isError) return undefined;
		if (event.toolName === "read") {
			// What the director's read returned, and whether a subagent of the run had read that file too.
			const read = directorRead({ runId, path: pathOf(event.input), cwd: ctx.cwd });
			const chars = event.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
			if (read) runs.noteRead(chars, read.indexed);
			return undefined;
		}
		// Normal deliveries count as follow-ups. A quiet write can still wake the child, but owes no result.
		const progress = followUpProgress(event.toolName, event.input);
		// A note sent to a worker the list showed running kept that worker's place until this receipt: only a note that woke a
		// turn (or revived the worker) leaves it held for the turn's start (R-final N4). A receipt that cannot be read is read
		// as folded into the open turn, as a note to a running worker always was.
		if (progress) runs.runLanes()?.noteDelivered(event.toolCallId, !deliveryWokeTurn(event.details));
		const target = progress && !event.isError ? followUpTarget(event.toolName, event.input)
			: deliveredFollowUp(event.toolName, event.input, event.isError);
		const targetRun = getLedgerRun(runId);
		const agent =
			target === undefined || targetRun === undefined
				? undefined
				: followUpAgent(listAgents({ scope: targetRun.sessionDir }), target);
		if (!agent || targetRun === undefined) return undefined;
		bindLedgerChild(runId, agent.id, agent.parentId ?? ctx.agent.id, artifactsOf(ctx));
		if (progress) return undefined;
		noteAgentFollowUp(agent.id, targetRun.sessionDir);
		// Only a message that started a turn makes the delivery Storm asked for: the receipt says so, and where it cannot be read the
		// recipient's state when the message went out does (an idle worker is woken; a running one has the message folded in).
		const outcome = deliveryOutcome(event.details);
		if (outcome === undefined ? wasIdle : outcome !== "injected") runs.noteWakingFollowUp(runId, agent.id);
		// The follow-up's next async job is already in this parent session's own snapshot. Its exact id (not a guessed
		// name) is what lets the first delivery bind to this turn instead of looking stale.
		attempts.bindFollowUpJobs({ runId, spawnKey: agent.id, jobs: hostJobs(ctx) });
		return undefined;
	};

	// What a delivery changed in the ledger reaches the director in the place it reads the delivery. A result that
	// comes back from `wait` (or a sync `task`) is read in this call's own result: omp appends `additionalContext` after
	// it as a developer message in the history. A result that is pushed has no call to ride on; it is read through the
	// `context` hook below. The notice is taken once, so whichever of the two comes first carries it and the other
	// finds nothing. Storm starts nothing because of it.
	// The same place carries two more facts about the call itself: a start ahead of a prerequisite (read before the
	// inner handler, whose failure path drops it) and, for a message to a worker whose records Storm has cleaned and that
	// omp failed to deliver, why it failed and where the result still is. omp adds `additionalContext` to any tool's result.
	pi.on("tool_result", async (event, ctx) => {
		// The host's result of a director path edit: after a switch of conversation this is the one sign that the call ended (it
		// comes with an aborted call's error too). Noted before anything awaits.
		if (ctx.agent.kind === "main") {
			const hold = typeof event.toolCallId === "string" ? directorHolds.get(event.toolCallId) : undefined;
			if (hold !== undefined) hold.resulted = true;
		}
		const runId = ctx.agent.kind === "main" ? runs.runId() : undefined;
		// A follow-up that carried a result contract was delivered: its worker has now been sent it.
		if (runId !== undefined && typeof event.toolCallId === "string") {
			const pendingKey = `${runId}\0${event.toolCallId}`;
			const pending = contractDigests.pending.get(pendingKey);
			if (pending !== undefined) {
				contractDigests.pending.delete(pendingKey);
				if (!event.isError) contractDigests.sent.set(pending.key, pending.digest);
			}
		}
		const noteKey = runId !== undefined && typeof event.toolCallId === "string" ? `${runId}\0${event.toolCallId}` : undefined;
		const started = noteKey === undefined ? undefined : startNotes.get(noteKey);
		if (noteKey !== undefined) startNotes.delete(noteKey);
		const result = await onToolResult(event, ctx);
		if (ctx.agent.kind !== "main") return result;
		const parts: string[] = [];
		if (started !== undefined && !event.isError) parts.push(...started);
		if (event.isError && runId !== undefined) {
			const targetRun = getLedgerRun(runId);
			const cleaned = targetRun === undefined ? undefined : followUpFailureNote(event.toolName, event.input, listAgents({ scope: targetRun.sessionDir }));
			if (cleaned !== undefined) parts.push(cleaned);
		}
		if (event.toolName === "wait" || event.toolName === "task") {
			if (runId !== undefined) await adoptChildStops(ctx, runId);
			const notice = await runs.noticesForDirector();
			if (notice !== undefined) parts.push(notice);
		}
		return parts.length === 0 ? result : { ...result, additionalContext: parts.join("\n") };
	});

	pi.on("context", async (event, ctx) => {
		// A pushed delivery is read here, on the director's next request. omp builds that request without waiting for
		// Storm's evaluation of the delivery, so a delivery still being evaluated is waited for, but never for long: a
		// slow evaluation only means the notice comes with the request after. Only the director's requests: a child's
		// request must neither read nor take the director's notice.
		if (ctx.agent.kind !== "main") return undefined;
		const runId = runs.runId();
		if (runId === undefined) return undefined;
		// The deliveries this request carries: the `async-result` messages after the director's last turn.
		const arrived: Promise<void>[] = [];
		for (let at = event.messages.length - 1; at >= 0; at--) {
			const message = event.messages[at];
			if (message === undefined || message.role === "assistant") break;
			if (deliveryKey(message) !== undefined) arrived.push(observeDelivery(ctx, runId, message));
		}
		if (arrived.length > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const limit = new Promise<void>(resolve => {
				timer = setTimeout(resolve, timings.noticeWaitMs);
				timer.unref?.();
			});
			await Promise.race([Promise.allSettled(arrived), limit]);
			clearTimeout(timer);
		}
		await adoptChildStops(ctx, runId);
		const notice = await runs.noticesForDirector();
		if (notice === undefined) return undefined;
		return { messages: [...event.messages, { role: "developer", content: [{ type: "text", text: notice }], attribution: "agent", timestamp: Date.now() }] };
	});

	pi.on("agent_start", (_event, ctx) => {
		// Every child turn, including a settled agent resumed by a follow-up (which has no before_agent_start).
		if (ctx.agent.kind === "sub") noteChildTurnStart(ctx);
		// A loop that starts with no prompt of its own (background results woke the paused director) is the paused
		// request's continuation: it no longer counts as paused, so a steer inside it cannot replace the request.
		else {
			const woken = autoOf(ctx);
			if (woken !== undefined) woken.paused = false;
		}
		runs.onAgentStart();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			const ledger = childLedger(ctx);
			const settled = !(event.willContinue || event.awaitingAsyncWork);
			// An unbound child has no owned run: writing an unscoped ledger entry is refused. Its persisted admission
			// (worker-homed child) is still closed below.
			if (ledger !== undefined) {
				noteAgentRun(ctx.agent.id, ledger.runId, ledger.sessionDir);
				const failed = settled
					? terminalWorkFailed(event.messages) ??
						listAgents({ scope: ledger.sessionDir }).find(agent => agent.id === ctx.agent.id)?.lastWorkFailed
					: undefined;
				noteAgentEnd({
					id: ctx.agent.id,
					now: Date.now(),
					settled,
					...(settled && failed !== undefined ? { failed } : {}),
					scope: ledger.sessionDir,
				});
				// What the turn's side model calls cost (its last tool call's own entry may be the newest line of its file).
				await settleSideSpend(ledger.runId, sessionFileOf(ctx), ledger.startedAt, false, true);
				// After the ledger says settled: the run's phase reads it, so touching the run before the update would
				// leave the last worker or reviewer looking active until another event.
				touchRun(ledger.runId);
			}
			// A settled turn is over: the lane's shared-write reservation ends with it, not when the next spawn asks.
			// The persisted authority is closed for this attempt as well; a follow-up reopens it before delivery.
			if (settled) {
				runs.runLanes()?.releaseAgent(ctx.agent.id);
				// A child session has no RunController of its own: its own lanes hold nothing. The run's lanes, when they are on
				// this thread, hear the settled turn through the run id; on another thread the director side reads the agent list.
				// The place is freed only once the host has also finished what it does for the worker (its parent's call).
				if (ledger !== undefined) noteLaneAgentEnd(ledger.runId, ctx.agent.id);
				// Release the run's shared slot here so a reused worker never keeps its slot after its turn.
				if (ledger !== undefined) releaseWorkerSlot(ledger.runId, ctx.agent.id);
				await closeChildWorkerAdmission(ctx);
			}
			return;
		}
		const eventSessionId = mainSessionId(ctx);
		await settleDirectorSpend(ctx);
		const auto = !event.willContinue && eventSessionId !== undefined ? autos.get(eventSessionId) : undefined;
		// Clear the ending request before yielding; a detached old handler must never clear a newer prompt's task.
		if (auto !== undefined) {
			auto.task = undefined;
			delete auto.turnStartedAt;
			auto.paused = false;
		}
		// Paused on async subagents: the moment to shed context before their results arrive. Both manual and automatic
		// runs use the same background handoff, so the recorded ledger is identical.
		if (event.awaitingAsyncWork) {
			// The user's request stays through the pause: background results wake this same loop, and that is the request's
			// own continuation. A prompt typed meanwhile replaces it (`paused`, above).
			const pausedAuto = eventSessionId !== undefined ? autos.get(eventSessionId) : undefined;
			if (pausedAuto !== undefined) pausedAuto.paused = true;
			runs.startCheckpoint();
		}
		// Ends the run when the session settles; a queued run starts detached from this handler.
		const settlement = runs.onAgentEnd(event, ctx);
		if (auto !== undefined && !event.awaitingAsyncWork) auto.settling = settlement;
		try {
			await settlement;
		} finally {
			if (auto?.settling === settlement) delete auto.settling;
		}
		if (!event.willContinue && !event.awaitingAsyncWork) {
			// A plugin update installed meanwhile shows up on the status line without waiting for /storm.
			await syncSession(ctx).catch(() => undefined);
		}
	});

	// omp itself left a model after provider errors: its provider goes behind the approved fallbacks for a while.
	pi.on("retry_fallback_applied", async (event, ctx) => {
		const state = await stateForEvent(ctx);
		if (state === undefined || state.config.status === "missing") return;
		const mark = fallbackQuotaMark(event.from, Date.now());
		if (mark) await addQuotaMark(state.sessionDir, mark);
		if (ctx.hasUI) ctx.ui.notify(quotaNotice(event.from, event.to, mark?.provider), "warning");
	});

	// One disabled credential need not mean the provider is out (other accounts may remain): notice only.
	pi.on("credential_disabled", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const state = await stateForEvent(ctx);
		if (state === undefined || state.config.status === "missing") return;
		ctx.ui.notify(credentialNotice(event.provider), "warning");
	});

	/** The closure's in-memory view of one conversation is dropped at every identity boundary. */
	const forgetConversation = (ctx: ExtensionContext): void => {
		const id = mainSessionId(ctx);
		if (id !== undefined) {
			autos.delete(id);
			laneViewOff.delete(id);
			decisions.forget(id);
		}
		stateCache.clear();
		attempts.stop();
		followDispatches.clear();
		followWakeCalls.clear();
		startNotes.clear();
		// What a worker of the old conversation was sent is not known to the next: unknown means a follow-up sends it again.
		contractDigests.placed.clear();
		contractDigests.sent.clear();
		contractDigests.pending.clear();
		liveStatus.beginSession();
		openWaits.clear();
		resetCloseoutChoices(ctx);
		refusedCalls.clear();
		seenDirectorCalls.clear();
		seenDirectorCallsOverflowed = false;
		revisableDirectorCalls.clear();
		refusedDirectorCalls.clear();
		adoptedStops.clear();
	};
	/**
	 * Every host transition that replaces the conversation (new, resume, fork, branch, context clear) shares this:
	 * delayed work from the old identity is invalidated first, its run ends, and only then is the new identity read.
	 */
	const conversationChanged = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.agent.kind !== "main") {
			// A child's own session change ends the turn's admitted authority; the next follow-up reopens a new attempt.
			agentAuthorities.delete(authorityKey(artifactsOf(ctx), ctx.agent.id));
			await closeChildWorkerAdmission(ctx);
			return;
		}
		sessionGeneration++;
		// The host reports the switch after it awaited the old loop's abort and delivers nothing more of that loop: no `turn_end`, no
		// `tool_execution_end`. So the director's path edits of the old conversation end here when nothing can still be writing for
		// them: a call that never started (omp aborted the batch before it ran, and a hook still pending never executes) and one
		// whose result was seen (it ended, aborted or not). Any other is kept, failing closed: the run then cannot finish and says
		// which call it waits for (`DIRECTOR_DRAIN_WARNING`). Residual, stated: a commit still in flight when the host reports
		// the old loop aborted (omp gives an extension no receipt for it after an abort).
		releaseDirectorHolds([...directorHolds].filter(([, hold]) => !hold.started || hold.resulted).map(([id]) => id));
		forgetConversation(ctx);
		const active = getLedgerRun(runs.runId());
		if (active !== undefined) await revokeWorkerAdmissionsFor({ runId: active.runId });
		await runs.finish("shutdown", ctx);
		if (active !== undefined) {
			clearWorkerSlots(active.runId);
		}
		await syncSession(ctx).catch(() => undefined);
	};

	pi.on("session_shutdown", async (_event, ctx) => {
		let ended: LedgerRun | undefined;
		// A subagent's session closes when omp parks it (idle TTL), kills it, or exits.
		if (ctx.agent.kind === "sub") {
			const ledger = childLedger(ctx);
			if (ledger !== undefined) {
				await settleSideSpend(ledger.runId, sessionFileOf(ctx), ledger.startedAt, false, true);
				noteAgentParked(ctx.agent.id, ledger.sessionDir);
				releaseWorkerSlot(ledger.runId, ctx.agent.id);
				noteLaneAgentEnd(ledger.runId, ctx.agent.id);
			}
			runs.runLanes()?.releaseAgent(ctx.agent.id);
			agentAuthorities.delete(authorityKey(artifactsOf(ctx), ctx.agent.id));
			stoppedChildren.delete(authorityKey(artifactsOf(ctx), ctx.agent.id));
			lastRan.delete(authorityKey(artifactsOf(ctx), ctx.agent.id));
			const key = reviewerBaselineKey(artifactsOf(ctx), ctx.agent.id);
			reviewerBaselines.delete(key);
			childWorkTrees.delete(key);
			await closeChildWorkerAdmission(ctx);
		} else {
			sessionGeneration++;
			forgetConversation(ctx);
			const active = getLedgerRun(runs.runId());
			if (active !== undefined) {
				ended = active;
				await revokeWorkerAdmissionsFor({ runId: active.runId });
				clearWorkerSlots(active.runId);
			}
		}
		// No status load or widget from before the shutdown may land after it.
		liveStatus.beginSession();
		openWaits.clear();
		await runs.finish("shutdown");
		// The run's record has its agents; the live rows of that process are gone with the session that described them.
		if (ended !== undefined) forgetRunAgents(ended.runId, ended.sessionDir);
	});

	// /new, /resume, a fork or a branch puts another conversation in this session: the run's handoff is not in it.
	pi.on("session_switch", async (_event, ctx) => conversationChanged(ctx));
	pi.on("session_clear", async (_event, ctx) => conversationChanged(ctx));
	pi.on("session_branch", async (_event, ctx) => conversationChanged(ctx));

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
		const result = await runs.start(ctx, spec);
		// A user-started run is a new user request even when the previous run already settled.
		if (result.ok) {
			const sessionId = mainSessionId(ctx);
			if (sessionId !== undefined) decisions.nextRequest(sessionId, sessionGeneration);
		}
		return result;
	};

	/**
	 * A numbered resume continues exactly the run its card named, through the same resume spec /storm uses. Every
	 * fact is read again after the pick: the conversation and its generation are unchanged, the session is idle, the
	 * team is approved, and this machine's trusted candidate for the current target is that very run. A different or
	 * newer candidate is never substituted, and nothing is retargeted.
	 */
	const startCloseoutResume = async (ctx: ExtensionContext, runId: string): Promise<RunRequestResult> => {
		const stale: RunRequestResult = { ok: false, reason: "대화가 바뀌어 이전 카드의 실행을 이어 가지 않았습니다." };
		const sessionId = mainSessionId(ctx);
		if (sessionId === undefined) return stale;
		const generation = sessionGeneration;
		const current = (): boolean => generation === sessionGeneration && mainSessionId(ctx) === sessionId;
		const state = await loadProjectState(projectEnv(ctx));
		if (!current()) return stale;
		if (!isApproved(state)) {
			return { ok: false, reason: "팀 설정이 승인되지 않았거나 승인 뒤에 바뀌어 이어 가지 않았습니다. /storm 에서 확인하세요." };
		}
		const candidate = await findResumeCandidate(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root });
		if (!current()) return stale;
		if (candidate === undefined || candidate.runId !== runId) {
			return { ok: false, reason: "카드의 실행은 지금 이 작업 대상에서 이어 갈 실행이 아닙니다. /storm 에서 현황을 확인하세요." };
		}
		if (!ctx.isIdle()) return { ok: false, reason: "세션이 응답 중이라 이어 가지 않았습니다. 응답이 끝난 뒤 /storm 에서 이어 가세요." };
		const spec = resumeSpec(candidate);
		if (!spec.ok) return { ok: false, reason: spec.error };
		return startUserRun(ctx, spec.spec);
	};

	/**
	 * A closeout action is chosen by the user typing its number, not by a model tool. Only direct interactive text
	 * from this main session's terminal UI can reach it; the runtime accepts an exact number once, while one
	 * just-finished run still offers it, and invalidates the offer on any other real input. Another host's input never
	 * reads, and so never consumes, the offer. The pick starts asynchronously through the same user-authorized path as
	 * /storm: a new direction carries the settled run only as its follow-up context, a resume is the native resume.
	 */
	pi.on("input", (event, ctx) => {
		// A host with no UI never showed the menu; its text is not a choice, even if a stale card was recorded.
		if (event.source !== "interactive" || ctx.agent.kind !== "main" || !ctx.hasUI) return undefined;
		const choice = ctx.mode === "tui" ? takeCloseoutChoice(ctx, event.text) : undefined;
		if (choice === undefined) {
			// A direct scope/retry adjustment is a native action at submission, like the closeout pick above. The input
			// event carries a source but no delivery id, and a later model call is not delivery proof; only this exact
			// interactive submission can apply it. Unmatched instructions, questions, quotes, code and complex turns
			// fall through untouched to OMP's ordinary queue.
			if (event.images?.length) return undefined;
			const adjustment = parseAdjustment(event.text);
			if (adjustment === undefined || runs.active() === undefined) return undefined;
			void runs.adjust(ctx, { ...adjustment, source: "interactive" }).then(
				outcome => {
					if (!ctx.hasUI) return;
					ctx.ui.notify(outcome.ok ? outcome.text : `Storm 실행 조정을 적용하지 않았습니다: ${outcome.reason}`, outcome.ok ? "info" : "warning");
				},
				(error: unknown) => {
					if (ctx.hasUI) ctx.ui.notify(`Storm 실행 조정을 적용하지 않았습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
				},
			);
			return { handled: true };
		}
		// An image or a busy session cannot be a numbered pick: the input keeps its normal path, and the offer is gone.
		if (event.images?.length || !ctx.isIdle()) return undefined;
		const refusal = runs.refusal();
		if (refusal !== undefined) {
			if (ctx.hasUI) ctx.ui.notify(`Storm 실행을 시작하지 못했습니다: ${refusal}`, "warning");
			return { handled: true };
		}
		const { runId, action } = choice;
		const started =
			action.kind === "resume" ? startCloseoutResume(ctx, runId) : startUserRun(ctx, { task: action.task, followUpOf: runId });
		void started.then(
			result => {
				if (!result.ok && ctx.hasUI) ctx.ui.notify(`Storm 실행을 시작하지 못했습니다: ${result.reason}`, "warning");
			},
			(error: unknown) => {
				if (ctx.hasUI) ctx.ui.notify(`Storm 실행을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
			},
		);
		return { handled: true };
	});

	/** Refreshes the status line and turns the storm tool on once this session has a Storm config. */
	const syncSession = async (ctx: ExtensionContext, loaded?: ProjectState): Promise<void> => {
		const sessionId = mainSessionId(ctx);
		if (sessionId === undefined) {
			// The host can no longer say whose state this is: leave no Storm surface from another conversation.
			autos.clear();
			laneViewOff.clear();
			stateCache.clear();
			liveStatus.clear();
			await deactivateTool();
			return;
		}
		const generation = sessionGeneration;
		const epoch = liveStatus.epoch();
		const state = loaded ?? (await loadProjectState(projectEnv(ctx)));
		// The durable consent file is read on every session refresh: a session switch or a command sees an external
		// change at once, and a failed read keeps the last enabled guard instead of unfencing direct tools.
		await refreshAuto(ctx, async () => state);
		if (generation !== sessionGeneration || !liveStatus.isCurrent(epoch)) return;
		const auto = autos.get(sessionId);
		// A missing config needs no tool normally; under automatic delegation the plan must be reachable to report
		// the missing team as an actionable refusal instead of leaving the main session to direct tools. A fresh
		// conversation also loses the tool the previous one activated: the tool's schema is session surface too.
		if (state.config.status !== "missing" || auto?.enabled === true) await activateTool();
		else await deactivateTool();
		if (generation !== sessionGeneration || !liveStatus.isCurrent(epoch)) return;
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
		const resumable =
			isApproved(state) &&
			(await findResumeCandidate(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root })) !== undefined;
		// The await above may have outlasted a switch, or a queued run may have started meanwhile.
		if (generation !== sessionGeneration || !liveStatus.isCurrent(epoch)) return;
		const started = runs.active();
		if (started) {
			showRunStatus(ctx, started, runs.phase());
			return;
		}
		liveStatus.clear();
		const consent = auto ?? { enabled: false, problem: undefined };
		ctx.ui.setStatus("storm", idleStatusText(ctx, state, resumable, consent));
	};

	pi.on("session_start", async (_event, ctx) => {
		// Subagents never manage the team: no tool, no status line.
		if (ctx.agent.kind !== "main") return;
		// A host without a native session id gets no Storm tool or footer: there is nowhere to keep this session's
		// state. The ordinary unconfigured conversation keeps working.
		const sessionId = mainSessionId(ctx);
		if (sessionId === undefined) {
			autos.clear();
			laneViewOff.clear();
			stateCache.clear();
			liveStatus.clear();
			await deactivateTool();
			return;
		}
		sessionGeneration++;
		autos.delete(sessionId);
		laneViewOff.delete(sessionId);
		decisions.forget(sessionId);
		stateCache.clear();
		const generation = sessionGeneration;
		const epoch = liveStatus.beginSession();
		resetCloseoutChoices(ctx);
		try {
			const state = await loadProjectState(projectEnv(ctx));
			if (generation !== sessionGeneration) return;
			// A run whose process died stays `running` until a later run ends; here it becomes the last run and resumable.
			await stopDeadRuns({ sessionDir: state.sessionDir });
			if (generation !== sessionGeneration || !liveStatus.isCurrent(epoch)) return;
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
			const sessionId = mainSessionId(ctx);
			if (sessionId === undefined) {
				ui.notify("Storm은 이 세션의 id를 확인하지 못해 아무것도 저장하지 않습니다. 새 대화를 연 뒤 다시 시도하세요.", "warning");
				return;
			}
			const generation = sessionGeneration;
			/** A command dialog may outlive the conversation that opened it; its write and start paths refuse then. */
			const stillOwner = (): boolean => generation === sessionGeneration && mainSessionId(ctx) === sessionId;
			// What the user runs sees the registry, quota and settings as they are now (a provider login just made);
			// the flows inside this command and the model's tool calls share one analysis.
			invalidateAnalysis(ctx.cwd);
			/** Starts a run in this session, as a request does: refused while one is active, started once the session is idle. */
			const startRun = async (spec: RunSpec): Promise<RunRequestResult> => {
				if (!stillOwner()) return { ok: false, reason: "대화가 바뀌어 이전 세션의 작업을 시작하지 않았습니다. 새 대화에서 다시 시도하세요." };
				// Refused before waiting: during a run the session is busy until that run ends.
				const reason = runs.refusal();
				if (reason !== undefined) return { ok: false, reason };
				await ctx.waitForIdle();
				if (!stillOwner()) return { ok: false, reason: "대화가 바뀌어 이전 세션의 작업을 시작하지 않았습니다. 새 대화에서 다시 시도하세요." };
				return startUserRun(ctx, spec);
			};
			const input = args.trim();
			try {
				// The human fallback is exact and native. It is not offered by the model tool and carries no text grammar;
				// a terminal-only main session is the only caller, and the controller re-checks run ownership.
				if (input === "adjust" || input.startsWith("adjust ")) {
					const request = parseAdjustCommand(input.slice("adjust".length).trim());
					if (request === undefined) {
						ui.notify("사용법: /storm adjust exclude <결과 id> | /storm adjust retry <결과 id>", "warning");
						return;
					}
					if (ctx.mode !== "tui" || !ctx.hasUI || ctx.agent.kind !== "main") {
						ui.notify("실행 조정은 이 세션의 터미널 상호작용에서만 적용됩니다. RPC·출력 모드나 워커 세션에서는 바꾸지 않습니다.", "warning");
						return;
					}
					if (!stillOwner()) {
						ui.notify("대화가 바뀌어 이전 세션의 실행을 조정하지 않았습니다. 새 대화에서 현재 실행 상태를 확인하세요.", "warning");
						return;
					}
					const outcome = await runs.adjust(ctx, { kind: request.kind, target: request.id, exact: true, source: "command" });
					ui.notify(outcome.ok ? outcome.text : `Storm 실행 조정을 적용하지 않았습니다: ${outcome.reason}`, outcome.ok ? "info" : "warning");
					return;
				}
				const env = flowEnv(ctx, startRun);
				/** `/storm view`: this session's lane view on or off; a live run changes its picture at once. */
				const toggleLaneView = (): void => {
					if (!isLiveTui(ctx)) {
						ui.notify("레인 뷰는 터미널 화면에서만 쓸 수 있어 아무것도 바꾸지 않습니다.", "warning");
						return;
					}
					const nowOn = laneViewOff.delete(sessionId);
					if (!nowOn) laneViewOff.add(sessionId);
					const run = runs.active();
					if (run) showRunStatus(ctx, run, runs.phase());
					ui.notify(nowOn ? "레인 뷰를 켰습니다. 이 OMP 세션에서만 적용됩니다." : "레인 뷰를 껐습니다. 한 줄 현황으로 돌아갑니다. 이 OMP 세션에서만 적용됩니다.");
				};
				/** Bare /storm: the hub, or just the status where no dialog can be answered. */
				const menu = async (): Promise<void> => {
					if (!ctx.hasUI) await statusFlow(env, ui);
					else if (await hubFlow(env, ui)) await deactivateTool();
				};
				if (input === "") await menu();
				else if (input === "status") await statusFlow(env, ui);
				else if (input === "models") await modelsFlow(env, ui);
				else if (input === "auto") await autoDelegationFlow(env, ui);
				else if (input === "view") toggleLaneView();
				else if (SHORTCUT_NAMES.includes(input)) {
					if (!ctx.hasUI) ui.notify("승인 창을 띄울 수 없는 모드라 아무것도 바꾸지 않습니다. /storm 으로 현황은 볼 수 있습니다.", "warning");
					else if (input === "setup") await setupFlow(env, ui);
					else if (await resetFlow(env, ui)) {
						// Reset removes this session's store; every persisted worker admission for it must die with it.
						await revokeWorkerAdmissionsFor({ sessionId: env.sessionId });
						await deactivateTool();
					}
				} else {
					// A request: Storm decides what it is off the transcript; only a run reaches the session.
					const side = sideTurn(ctx);
					await routeRequest(input, {
						ui,
						loadState: () => loadProjectState(env),
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
				try {
					await syncSession(ctx);
				} catch {
					// Status refresh is best-effort.
				}
			}
		},
	});
}
