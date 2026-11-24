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
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, type SessionModeState } from "@oh-my-pi/pi-coding-agent";
import { readAutoDelegation } from "./approval/auto.ts";
import { resolveRepo } from "./approval/repo.ts";
import { invalidateAnalysis, prepareAnalysis } from "./context.ts";
import { readQuota } from "./discovery/quota.ts";
import { liveIsolationSettings, readExplicitSettings } from "./discovery/settings.ts";
import {
	agentsFlow,
	approveAndSave,
	autoDelegationFlow,
	exportFlow,
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
import {
	canonicalScope,
	effectiveAgentTools,
	lanePolicy,
	pathWriteTool,
	readOnlyIntent,
	readOnlyTool,
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
	failClosed,
	releaseWorkerSlot,
	reservedWorkers,
	reserveWorkerSlot,
	SPAWN_DECISION_MS,
	usableRole,
	workerSlot,
} from "./policy/spawn.ts";
import { supervisorToolBlock } from "./policy/supervisor.ts";
import { decideToolCall } from "./policy/toolcall.ts";
import { PACKAGE_JSON, ROLE_AGENT_PREFIX, ROLES, STORM_VERSION } from "./roles.ts";
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
import { AttemptCollector } from "./runtime/attempt-collector.ts";
import { noteRunSpawn, noteRunUserWait, RunController, runSpawns, touchRun } from "./runtime/controller.ts";
import { replanConflict, taskLaneProblem, type LaneReadinessView, type TaskIsolationHost } from "./runtime/lanes.ts";
import { bindLedgerChild, anyLedgerRun, getLedgerRun, ledgerRunForChild, recordCost, type LedgerRun } from "./runtime/ledger.ts";
import { stopDeadRuns } from "./runtime/janitor.ts";
import { closeoutSessionId, resetCloseoutChoices, takeCloseoutChoice } from "./runtime/closeout.ts";
import { DecisionRequests, decisionAsk } from "./runtime/decisions.ts";
import { credentialNotice, fallbackQuotaMark, quotaNotice } from "./runtime/quota-auto.ts";
import { verdictOf } from "./runtime/review.ts";
import { addQuotaMark, readQuotaMarks, readTrialStates, updateTrialState } from "./runtime/state-files.ts";
import { markTrialStop, noteTrialSpawn, trialCharge } from "./runtime/trials.ts";
import { findResumeCandidate } from "./runtime/resume.ts";
import { treeAgainst, type TreeReading } from "./runtime/tree.ts";
import { newerInstalledVersion } from "./runtime/version.ts";
import { type ActionHost, runChange } from "./request/actions.ts";
import { routeRequest } from "./request/route.ts";
import { sessionStoreDir } from "./session-scope.ts";
import { createStateCache, isApproved, loadProjectState, type ProjectEnv, type ProjectState } from "./state.ts";
import type { RunRequestResult, StormToolHost } from "./tool/host.ts";
import { createStormTool } from "./tool/storm-tool.ts";
import type {
	ExplicitSettings,
	Exec,
	InfoTone,
	PlanLane,
	RepoIdentity,
	RunPlan,
	RunRecord,
	RunSpec,
	ShadowInfo,
	SpawnDecision,
	StormConfig,
	UiPort,
} from "./types.ts";
import { createUiPort, registerReportRenderer } from "./ui.ts";
import { isLiveTui, LiveStatus } from "./view/live.ts";
import { idleAppearance, RUN_APPEARANCE, STORM_MARK, type RunPhase } from "./view/appearance.ts";
import { runStatusText } from "./view/render.ts";
import {
	activeWorkerRunInTree,
	endWorkerAdmission,
	persistWorkerAdmission,
	readWorkerAdmission,
	resolveWorkerAdmission,
	revokeWorkerAdmissions,
	type WorkerAdmissionRecord,
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
	{ value: "export", label: "export", description: "팀 옵션을 복사용으로 내보내기(사람만)" },
	{ value: "setup", label: "setup", description: "팀 다시 설정" },
	{ value: "reset", label: "reset", description: "Storm 설정과 기록 초기화" },
] as const;
const SHORTCUT_NAMES: readonly string[] = SHORTCUTS.map(shortcut => shortcut.value);
/**
 * How long a single fresh task/follow-up may wait for a conflicting shared writer to settle before the admission is
 * refused. It is a wait, not a queue: a long-running writer still leaves the call blocked, and no reservation leaks.
 */
const WRITE_WAIT_MS = 1_500;
const WRITE_WAIT_STEP_MS = 50;

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

/** Follow-up tool calls that created the worker's slot; a failed delivery releases only that new slot, never one a
 * work-bearing note to an already running worker reused. */
const followCapacityCalls = new Map<string, { runId: string; agentId: string }>();

/** OMP agent ids are unique inside one artifact tree, not across profiles or sessions. */
function authorityKey(artifacts: string | undefined, agentId: string): string {
	return `${artifacts ?? ""}\0${agentId}`;
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
 * The stable automatic-delegation instruction appended to the director's system prompt. It carries no live state,
 * so it does not invalidate the prompt cache between turns; refusals carry the exact fix when a call is blocked.
 */
const AUTO_INSTRUCTION = `<storm-auto>
This session delegates project work automatically.
- General conversation needs no tools: answer directly.
- Keep the scope tiny: one lane and one worker for a quick mechanical edit or a read-only lookup. When the request is uncertain, submit an explore-only plan first instead of guessing implementation lanes.
- Inspection, verification, or file changes belong to the approved team. Submit a storm plan; it opens the run for this request. Use task for independent judgment/work lanes, or storm execute for announced project jobs with fixed commands. Do not open a domain mode or ask users to pick workers.
- Replan only when evidence changes an assumption. Keep existing lane name, kind, role, job, files, and goal; progress is status only. Match each task item to its planned lane. At capacity, wait for admitted work; do not change the team.
- Lanes share this work tree by default. Add \`isolationReason\` to a lane only when its result must stay outside the parent tree as an independent experiment; Storm requires omp isolation to be on and \`task.isolation.apply\` off for that lane. Never add \`isolationReason\` to the final review: its verdict must prove the integrated work, and Storm withholds a review it cannot bind to the tree that reviewer actually saw.
- Do not call read, grep, glob, bash, edit, ast_edit, eval, or any other file, shell, or unknown tool yourself; for \`write\`, only the two forms below are allowed. Do not spawn an agent before the plan opens the run. Storm blocks those calls.
- Direct writes are limited to \`write local://<name>.md\` notes and \`write agent://<id>\` messages; read worker results with \`read agent://<id>\` and bounded line ranges.
- Follow up on the same worker with \`write agent://<id>\`. At capacity, wait; only a closed or context-limited worker needs a replacement that reads \`agent://<id>\`.
- Keep each worker result to about 1500 characters with evidence locations and links; do not paste raw logs. Send those ranges to workers or the reviewer; do not read repository files yourself.
- When you need the user, use the native \`ask\` tool within this turn; never end by pretending no lane was work.
- Spawn only the plan's approved roles and worker counts; Storm refuses anything outside the plan.
- Finish against the requested results, even without edits. When code changes and the team has a reviewer, verification still needs the reviewer to accept the current tree.
- Near the end of a substantial run, after its results and before you end the turn, submit one \`brief\` action with the \`storm\` tool: \`result\`, \`verification\` with evidence locations, optional \`remaining\`, and exactly three concrete \`next\` directions (the first is your recommendation). Restage it if later rounds change the result. A brief only stages the closeout; it neither verifies nor ends the run, and submitting it is no proof. Skip the brief and next directions for a trivial lookup or a quick one-step request.
- Do not repeat the brief's directions as a numbered menu in your prose: Storm shows the menu when the run settles. Never claim work is verified before Storm's final gate says so. Do not make another model call just to write the brief.
- Continue permitted work while capacity or resources are busy. Report a blocker the user can resolve; never work around it with direct tools.
- Keep going until the plan's lanes are done or blocked.
</storm-auto>`;

/**
 * The stable native-ask contract shared by every active Storm director: the automatic director and the manual
 * director of a live run. It carries no run id, count or other live state, so appending it once per assembled prompt
 * keeps the prompt cache stable. The per-request decision history lives in the runtime, never in this text.
 */
const DECISION_INSTRUCTION = `<storm-decision>
Routine in-scope setup, checks, retries and fixes the user already requested need no confirmation: do the work that is ready first.
Only a genuine user decision may use the native \`ask\` tool: a scope change, an irreversible action, or a choice that belongs to the user. Replan within the approved bounds instead of asking to widen them.
Put \`data-storm-decision="<stable-key>"\` and exactly one \`data-storm-reason\` (\`scope-change\`, \`irreversible-action\`, \`user-choice\`) on the main \`<form>\` tag; keep the same key across replans and rounds of this request.
For a scope change or irreversible action, preselect nothing: a timeout or cancel is not consent and must never submit an approval.
Ask once per request, consolidate related questions, and never repeat an authorization.
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

/**
 * Whether starting work under `plan` may write the target. An unplanned manual spawn is treated as a writer; a plan
 * whose every lane declares read-only intent (and no files) stays a reader, so concurrent read-only runs stay
 * independent. This mirrors the controller's own upgrade rule; the lease, not this predicate, is the authority.
 */
function planMayWrite(plan: RunPlan | undefined): boolean {
	if (plan === undefined) return true;
	return plan.lanes.some(lane => !readOnlyIntent(lane) || (lane.files?.length ?? 0) > 0);
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

export default function storm(pi: ExtensionAPI): void {
	const exec = execPort(pi);
	const liveStatus = new LiveStatus();
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
		settling?: Promise<void>;
		jobNames?: readonly string[];
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
	const autoSnapshot = (sessionId: string): { enabled: boolean; blocked?: string; task?: string } => {
		const entry = autos.get(sessionId);
		if (entry === undefined) return { enabled: false };
		return {
			enabled: entry.enabled,
			...(entry.problem !== undefined ? { blocked: entry.problem } : {}),
			...(entry.task !== undefined ? { task: entry.task } : {}),
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
				delete entry.jobNames;
				if (entry.enabled) entry.problem = "팀 설정을 확인하지 못했습니다. /storm 으로 확인하세요.";
			}
			return;
		}
		if (!current()) return;
		entry.problem = teamProblem(state) ?? modeProblem(ctx);
		const jobNames = state.config.status === "ok" && entry.problem === undefined ? state.config.config.jobs?.map(job => job.name) : undefined;
		if (jobNames?.length) entry.jobNames = jobNames;
		else delete entry.jobNames;
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
				return { kind: "read", reason: record.policy.reason };
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
			reason: `[storm:ask-repeat] 이번 사용자 요청에서 이미 결정 '${checked.ask.key}'(${remembered.reason})을 물었습니다. 같은 승인을 다시 요청하지 말고, 이전 답이나 취소·타임아웃을 그대로 상태로 두고 범위 안 작업을 계속하거나 막힘을 보고하세요. 타임아웃·취소는 동의가 아닙니다.`,
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
	}): Promise<void> => {
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
		});
	};

	/** The last run shown live; its child admissions close when finalization reports no run. */
	let liveRunId: string | undefined;
	const runs = new RunController({
		pi,
		ui: ctx => createUiPort(pi, ctx),
		loadState: async ctx => loadProjectState(projectEnv(ctx)),
		now: Date.now,
		agents: (runId, sessionDir) => listAgents({ runId, scope: sessionDir }),
		tree: (root, base) => treeAgainst(exec, root, base),
		// Cleanup inventory only: the janitor passes the session it is sweeping, never a process-wide view.
		ledger: sessionDir => listAgents({ scope: sessionDir }),
		agentDir: pi.pi.getAgentDir(),
		live: (ctx, run) => {
			if (run) {
				liveRunId = run.runId;
				showRunStatus(ctx, run, runs.phase());
				return;
			}
			const ended = liveRunId;
			liveRunId = undefined;
			if (ended !== undefined) void revokeWorkerAdmissionsFor({ runId: ended });
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
		},
		registry: () => AgentRegistry.global(),
	});

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
		/** Fresh state under the captured session; a stale call reads nothing and writes nothing. */
		const loadState = async (): Promise<ProjectState> => {
			if (!stillOwner()) throw new Error(stale);
			return loadProjectState(env);
		};
		return {
			now: Date.now,
			loadState,
			statusText: opts => {
				if (!stillOwner()) throw new Error(stale);
				return statusText(flow, opts);
			},
			auto: () => autoSnapshot(sessionId),
			runtime: {
				requestRun: spec => (stillOwner() ? runs.request(spec) : { ok: false, reason: stale }),
				replanConflict: plan => (stillOwner() ? replanConflict(getLedgerRun(runs.runId())?.plan, plan) : undefined),
				setRunPlan: plan => (stillOwner() ? runs.setPlan(ctx, plan) : { ok: false, reason: stale }),
				executeJobs: (lanes, signal) => runs.executeJobs(ctx, lanes, stillOwner, signal),
				submitCloseout: draft => (stillOwner() ? runs.submitCloseout(ctx, draft) : { ok: false, reason: stale }),
				runActive: () => stillOwner() && runs.runId() !== undefined,
				startWithPlan: async (spec: RunSpec, plan: RunPlan, validatedHash?: string) => {
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
					const started = await runs.startWithPlan(ctx, spec, plan, validatedHash);
					// The first accepted automatic plan is a live tool boundary: the run's heavy pre-work context was
					// never preflight-compacted (and a sync subagent wait may never pause the agent loop). Start the one
					// background checkpoint now; omp commits it at its next turn/idle boundary. The already-oversized
					// first request cannot be prevented from here — the host classifies prompt size only after the
					// prompt has arrived — so this restores every request after that boundary, not that first one.
					if (started.ok) runs.startAutoCheckpoint();
					return started;
				},
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
		const limit = deadline(SPAWN_DECISION_MS);
		let timedOut = false;
		void limit.expired.catch(() => {
			timedOut = true;
		});
		const artifacts = artifactsOf(ctx);
		// The admitted run is fixed for this spawn: a later start in the same tree must not receive its record.
		const captured = ctx.agent.kind === "main" ? getLedgerRun(runs.runId()) : childLedger(ctx);
		const capturedRunId = captured?.runId;
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
			if (capturedRunId === runs.runId() && runs.jobsRunning()) {
				return { block: true, reason: "[storm:job-wait] 정형 작업이 끝날 때까지 워커 시작을 기다리세요." };
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
										active: activeAgents(
											runSpawns(current.runId),
											listAgents({ runId: current.runId, scope: current.sessionDir }),
											now,
											reservedWorkers(current.runId),
										),
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
						// Persist before returning: a pooled/rebound child has no access to this thread's map. A failure
						// here blocks the spawn rather than allowing an unverifiable writer.
						try {
							await persistChildAdmission({
								ctx,
								run: current,
								artifacts,
								childId: spawnKey,
								...(lane === undefined ? {} : { lane }),
								authority: authority.authority,
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
						}
					}
				}
				if (timedOut) return closed();
				if (!stillOwn()) return moved();
				if (current !== undefined && current.runId === runs.runId() && runs.jobsRunning()) {
					return ledgerBlock("정형 작업이 끝날 때까지 워커 시작을 기다리세요.", current, Date.now());
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
		}).finally(limit.cancel).then(decision => {
			// A refused spawn must not keep its lane/write/capacity reservation or its enforced authority: another
			// worker may start.
			if (decision !== undefined && "block" in decision && event.spawnKey !== undefined) {
				runs.runLanes()?.cancel(event.spawnKey);
				const run = getLedgerRun(capturedRunId);
				if (run !== undefined) releaseWorkerSlot(run.runId, event.spawnKey);
				agentAuthorities.delete(authorityKey(artifacts, event.spawnKey));
			}
			return decision;
		});
	});

	pi.on("message_end", async (event, ctx) => {
		// A finished background task is a custom `async-result` message on the parent, not an assistant turn. Observe it
		// before the usage guard, which has no usage to read for that message.
		if (ctx.agent.kind === "main") {
			const runId = runs.runId();
			if (runId !== undefined) {
				await attempts.observeMessage({ runId, parentId: ctx.agent.id, message: event.message, observedAt: Date.now() });
			}
		}
		const usage = assistantUsage(event.message);
		if (!usage) return;
		const ledger = ctx.agent.kind === "main" ? getLedgerRun(runs.runId()) : childLedger(ctx);
		if (ctx.agent.kind === "sub") {
			// A bare child has no attested Storm owner: its own native session is never substituted.
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

	// Agent ledger: each subagent session reports its own turns and end; omp offers no parent-side view of them.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind === "main") {
			// Without a native session identity there is no Storm policy to apply; the ordinary conversation is untouched.
			const sessionId = mainSessionId(ctx);
			if (sessionId === undefined) return undefined;
			const generation = sessionGeneration;
			const auto = autoFor(sessionId);
			// Only an ordinary prompt carries a user request. A revive has no prompt, and Storm's own run messages
			// are generated continuations: neither may capture or replace the task a plan opens.
			if (event.reason !== "prompt") return undefined;
			const prompt = typeof event.prompt === "string" ? event.prompt : "";
			const text = prompt.trimStart();
			const runMessage = text.startsWith("<storm-run ");
			if (!runMessage) {
				// The host can start a new prompt while its detached terminal agent_end is still closing Storm's run.
				// Wait for that decision and lease release before deciding if this is a new task or run context.
				if (auto.settling !== undefined) {
					await auto.settling.catch(() => undefined);
					if (generation !== sessionGeneration || mainSessionId(ctx) !== sessionId || autos.get(sessionId) !== auto) return undefined;
				}
				if (text === "") {
					// A photo-only or empty prompt cannot become a text run task; a later plan refuses it explicitly.
					if (runs.runId() === undefined) auto.task = undefined;
					return undefined;
				}
				// The first ordinary prompt of a turn is its task. Later synthetic continuations, tool-loop
				// reminders and steers must not replace it; a prompt while this session directs is run context.
				if (runs.runId() === undefined && auto.task === undefined) {
					auto.task = prompt;
					// The first prompt of a user turn starts its request; decisions never inherit from the last one.
					decisions.nextRequest(sessionId, sessionGeneration);
				}
				const env = envForSession(sessionId, ctx.cwd);
				await refreshAuto(ctx, () => stateCache.get(env));
			}
			// A switch during the read must not attach Storm guidance to another conversation's prompt.
			if (generation !== sessionGeneration || mainSessionId(ctx) !== sessionId) return undefined;
			const autoOn = autos.get(sessionId) === auto && auto.enabled;
			const activeRun = getLedgerRun(runs.runId());
			const manualOn = activeRun !== undefined && activeRun.sessionId === sessionId;
			if (!autoOn && !manualOn) return undefined;
			const additions: string[] = [];
			if (!event.systemPrompt.includes(DECISION_INSTRUCTION)) additions.push(DECISION_INSTRUCTION);
			if (autoOn && !event.systemPrompt.includes(AUTO_INSTRUCTION)) additions.push(AUTO_INSTRUCTION);
			if (autoOn && auto.jobNames?.length) additions.push(`Storm approved project job names: ${JSON.stringify(auto.jobNames)}.`);
			if (additions.length === 0) return undefined;
			// Append only: the prompt itself is the host's, and these blocks are stable between turns.
			return { systemPrompt: [...event.systemPrompt, ...additions] };
		}
		const ledger = childLedger(ctx);
		// A child has no Storm session of its own: only the run its parent admitted supplies an owner. Without one
		// there is no ledger write, no docs and no reviewer identity — never a fallback to the child's session or cwd.
		if (ledger === undefined) return undefined;
		const { id, name, parentId } = ctx.agent;
		const artifacts = artifactsOf(ctx);
		childWorkTrees.set(reviewerBaselineKey(artifacts, id), ctx.cwd);
		const runId = ledger.runId;
		noteAgentStart({
			id,
			name,
			...(parentId ? { parentId } : {}),
			...(name.startsWith(ROLE_AGENT_PREFIX) ? { role: name.slice(ROLE_AGENT_PREFIX.length) } : {}),
			runId,
			scope: ledger.sessionDir,
			now: Date.now(),
		});
		touchRun(runId);
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

	// Director mode: blocking the call instead of swapping the tool list keeps the main session's prompt cache intact.
	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			const ledger = childLedger(ctx);
			const boundRunId = ledger?.runId;
			let authority = agentAuthorities.get(authorityKey(artifactsOf(ctx), ctx.agent.id));
			let managed = authority !== undefined || boundRunId !== undefined;
			let denied: string | undefined;
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
			if (denied !== undefined) {
				return { block: true, reason: `[storm:authority] ${denied} 승인된 레인 권한을 확인할 수 없어 쓰기·실행·중첩 호출을 허용하지 않았습니다.` };
			}
			if (authority !== undefined) {
				const { policy, root, lane } = authority;
				const who = lane === undefined ? ctx.agent.id : `'${lane}' 레인(${ctx.agent.id})`;
				// An unplanned worker has no concrete lane: it may read, but it never gains shared write or exec
				// powers merely because it lives in the same tree as an approved writer.
				if (policy.kind === "blocked" || (policy.kind === "unknown" && lane === undefined)) {
					if (!readOnlyTool(event.toolName)) {
						return {
							block: true,
							reason: `[storm:lane] ${who}은 승인된 계획의 구체적인 레인에 속하지 않아 '${event.toolName}' 쓰기·실행 권한을 받지 못했습니다. 감독이 레인을 계획해야 합니다.`,
						};
					}
				}
				if (policy.kind === "read" && !readOnlyTool(event.toolName)) {
					return {
						block: true,
						reason: `[storm:lane-capability] ${who}은 읽기 전용으로 승인되어 '${event.toolName}' 도구를 쓸 수 없습니다. 읽기·검색·검증 도구만 쓰고, 변경이 필요하면 감독에게 쓰기 레인을 요청하세요.`,
					};
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
								reason: `[storm:lane-capability] ${who}은 승인된 경로 쓰기 도구만 쓸 수 있고 '${event.toolName}'은 임의 실행/알 수 없는 쓰기입니다. 감독이 실행 권한을 가진 레인으로 다시 배정해야 합니다.`,
							};
						}
						const targets = toolWriteTargets(event.toolName, event.input);
						const outside = targets.filter(target => !targetWithinScope(target, policy.paths, root));
						if (targets.length === 0 || outside.length > 0) {
							return {
								block: true,
								reason: `[storm:lane-scope] ${who}의 쓰기 경로는 ${policy.paths.join(", ")}입니다. ${targets.length === 0 ? "대상 경로를 확인할 수 없는 쓰기" : `경로 이탈: ${outside.join(", ")}`}는 허용하지 않았습니다. 승인된 범위 안에서 쓰거나 감독에게 새 레인을 요청하세요.`,
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
				event.toolName === "task" ? AUTO_SPAWN_REASON : supervisorToolBlock(event.toolName, event.input);
			if (detail === undefined) return undefined;
			return { block: true, reason: autoRefusal(auto?.problem, detail) };
		}
		// A live run must name the session that owns it: without that, no direct tool is safe to allow.
		if (mainId === undefined) {
			return { block: true, reason: "[storm:session] 이 세션의 id를 확인하지 못해 Storm 실행 도구를 막았습니다. 새 대화에서 다시 시도하세요." };
		}
		// Automatic delegation keeps the strict supervisor gate during the run too: bash, eval, unknown tools and
		// every repository file read stay refused, while task and published worker results remain reachable. The
		// legacy director checks (follow-up caps, wide re-reads, edits) still run after this narrower gate.
		if (autoOn) {
			const strict = supervisorToolBlock(event.toolName, event.input);
			if (strict !== undefined) return { block: true, reason: autoRunRefusal(strict) };
		}
		// An eval turn can start several children without a native task batch; during a run every worker must come
		// through a planned task lane, so eval's unplanned spawn path is refused before any child starts.
		if (event.toolName === "eval" && runId !== undefined) {
			return { block: true, reason: "[storm:lane] 실행 중에는 eval로 에이전트를 스폰할 수 없습니다. 승인된 계획의 레인을 task로 호출하세요." };
		}
		const config = runs.runConfig(ctx);
		if (!config) {
			// A live run whose owning session cannot be proven is not a reason to let direct tools through.
			return { block: true, reason: "[storm:session] 실행의 세션 소유권을 확인하지 못해 이 도구 호출을 막았습니다. 실행 상태를 확인한 뒤 다시 시도하세요." };
		}
		// Every judgment below is the run's own: its ledger names the session whose workers and limits apply.
		const runLedger = getLedgerRun(runId);
		const runScope = runLedger?.sessionDir;
		if (runScope === undefined) {
			return { block: true, reason: "[storm:session] 실행의 세션 저장소를 확인하지 못해 이 도구 호출을 막았습니다. 실행 상태를 확인한 뒤 다시 시도하세요." };
		}
		// Shell, eval and unknown/MCP tools can write without naming a path: under a read lease they must claim the
		// target's write authority first. Path write tools are already bounded by the director rule below.
		if (
			!readOnlyTool(event.toolName) &&
			!pathWriteTool(event.toolName) &&
			event.toolName !== "task" &&
			event.toolName !== "ask" &&
			event.toolName !== "wait" &&
			event.toolName !== "storm"
		) {
			const writable = await runs.ensureWrite(ctx);
			if (!writable.ok) return { block: true, reason: `[storm:lease] ${writable.reason}` };
		}
		const block = decideToolCall({ toolName: event.toolName, input: event.input, cwd: ctx.cwd, runId, config, agents: listAgents({ scope: runScope }) });
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
					agents: listAgents({ runId, scope: runScope }),
					now: Date.now(),
				};
				return autoOn && plan !== undefined
					? lanes.assign(event.input, plan, config, now)
					: lanes.place(event.input, plan, config, now);
			};
			let placed = placeOnce();
			const waitUntil = Date.now() + WRITE_WAIT_MS;
			// A single fresh item waits briefly for a writer that is settling (a native task often returns before its
			// worker starts). A batch never waits: a conflicting batch refuses before any item is reserved or started.
			// A batch-internal overlap never waits because no host event can clear it.
			const oneItem = !Array.isArray(event.input.tasks) || event.input.tasks.length === 1;
			while (oneItem && !placed.ok && placed.retry === true && Date.now() < waitUntil) {
				await pause(WRITE_WAIT_STEP_MS);
				placed = placeOnce();
			}
			if (!placed.ok) {
				const tag = placed.code !== undefined ? `[storm:${placed.code}]` : autoOn ? "[storm:auto]" : "[storm:isolation]";
				return { block: true, reason: `${tag} ${placed.reason}` };
			}
			// The wait above may have outlived the conversation that asked for this spawn.
			if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
				return { block: true, reason: "[storm:session] 대화가 바뀌어 이 task 호출을 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
			}
			// The exact toolCallId is host-issued; admitted sync children later carry it into their attempt id.
			attempts.observeTaskCall({ runId, parentId: ctx.agent.id, toolCallId: event.toolCallId, input: placed.input, startedAt: Date.now() });
			return placed.input === event.input ? undefined : { input: placed.input };
		}
		// A work-bearing follow-up is not a new spawn, but it starts a new turn that may write: it passes the same
		// prerequisite and shared-write gate as a task. A `?progress` note never reaches here (`deliveredFollowUp`
		// excludes it), so a status note reserves nothing and waits for no lane.
		const followTarget = deliveredFollowUp(event.toolName, event.input, false);
		const followAgent = followTarget === undefined ? undefined : followUpAgent(listAgents({ scope: runScope }), followTarget);
		const followLanes = runs.runLanes();
		let followToken: string | undefined;
		let followLane: PlanLane | undefined;
		if (followAgent !== undefined && followLanes !== undefined) {
			// A job batch owns the run while it executes and starts only with no live workers. A genuine work-bearing
			// note would make a worker live, so it waits for the batch; a `?progress` note never reaches this block.
			if (runs.jobsRunning()) {
				return { block: true, reason: "[storm:job-wait] 정형 작업이 끝날 때까지 워커 후속 작업을 보내지 마세요. wait 도구나 완료 알림 뒤 다시 보내세요." };
			}
			// A work-bearing follow-up starts a new turn that may write: prove the target's write lease first.
			const writable = await runs.ensureWrite(ctx);
			if (!writable.ok) return { block: true, reason: `[storm:lease] ${writable.reason}` };
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
			const gate = followLanes.checkFollowUp({
				runId,
				agentId: followAgent.id,
				agent: followAgent.name,
				...(followAgent.role === undefined ? {} : { role: followAgent.role }),
				...(lane === undefined ? {} : { lane }),
				...(plan === undefined ? {} : { plan }),
				config,
				isolated: config.isolation === "isolated",
				...(readiness === undefined ? {} : { readiness }),
				agents: listAgents({ runId, scope: runScope }),
				now: Date.now(),
			});
			if (!gate.ok) return { block: true, reason: `[storm:${gate.code}] ${gate.reason}` };
			followToken = gate.token;
			if (gate.reserved === true) followCapacityCalls.set(`${runId}\0${event.toolCallId}`, { runId, agentId: followAgent.id });
			// The reused worker's next turn runs in its own module (possibly another thread): refresh the exact
			// admission with a new attempt before the delivery can execute.
			if (lane !== undefined && authority !== undefined) {
				try {
					await persistChildAdmission({ ctx, run, artifacts: artifactsOf(ctx), childId: followAgent.id, lane, authority });
				} catch {
					followLanes.finishFollowUp(followToken, false);
					return { block: true, reason: "[storm:authority] 후속 작업의 자식 실행 권한을 저장하지 못해 전달하지 않았습니다. 프로필 경로와 권한을 확인하세요." };
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
		if (followAgent !== undefined && followLane !== undefined) {
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
		}
		if (generation !== sessionGeneration || mainSessionId(ctx) !== mainId) {
			if (followToken !== undefined) followLanes?.finishFollowUp(followToken, false);
			return { block: true, reason: "[storm:session] 대화가 바뀌어 이 후속 지시를 적용하지 않았습니다. 새 대화에서 다시 시도하세요." };
		}
		// The job batch may have started during the authority/readiness awaits. Do not deliver a worker turn into it.
		if (followAgent !== undefined && runs.jobsRunning()) {
			if (followToken !== undefined) followLanes?.finishFollowUp(followToken, false);
			return { block: true, reason: "[storm:job-wait] 정형 작업이 시작되어 이 후속 작업을 전달하지 않았습니다. 작업이 끝난 뒤 다시 보내세요." };
		}
		if (followToken !== undefined) followLanes?.finishFollowUp(followToken, true);
		return undefined;
	});

	// Every compaction of a directing session, omp's own included, keeps Storm's view of the run.
	pi.on("session.compacting", () => {
		const run = runs.active();
		const scope = run === undefined ? undefined : getLedgerRun(run.runId)?.sessionDir;
		return run !== undefined && scope !== undefined ? { context: workingState(run, listAgents({ runId: run.runId, scope })) } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.agent.kind === "sub") {
			// The parent admitted this id before the spawn returned: no cwd or repo match is trusted here, and an
			// unbound child writes nothing into any ledger.
			const ledger = childLedger(ctx);
			if (ledger === undefined) return undefined;
			noteAgentRun(ctx.agent.id, ledger.runId, ledger.sessionDir);
			// A reviewer's structured verdict arrives through its `yield`; it lands on the ledger entry and from there in the run record.
			const now = Date.now();
			if (event.toolName === "yield" && !event.isError) {
				noteAgentReview(ctx.agent.id, event.input, now, ledger.sessionDir);
				// Await the bounded snapshot before the turn can settle: the gate never reads a tree this verdict forgot.
				if (verdictOf(event.input) !== undefined) await bindReviewerVerdict(exec, ctx, ledger, now);
			}
			// The review gate reads what the team changed; a file-changing call that failed changed nothing.
			if (!event.isError && changesFiles(event.toolName, event.input)) noteAgentChange(ctx.agent.id, now, ledger.sessionDir);
			return undefined;
		}
		const runId = runs.runId();
		if (!runId) return undefined;
		// A preflight that created a reactivation slot releases it only when the delivery actually failed. A reused
		// slot on a running worker was not created by this call and stays with that worker.
		const followKey = `${runId}\0${event.toolCallId}`;
		const followCapacity = followCapacityCalls.get(followKey);
		if (followCapacity !== undefined) {
			followCapacityCalls.delete(followKey);
			if (event.isError && followCapacity.runId === runId) releaseWorkerSlot(runId, followCapacity.agentId);
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
			// A failed native task call is an observed start failure, not a reason to wait out a timer. Release only
			// reserved starts that never became a running worker; a running sibling keeps its slot until it settles.
			if (event.isError) {
				const input = event.input as { name?: unknown; tasks?: unknown } | undefined;
				const items = Array.isArray(input?.tasks) ? input.tasks : [input];
				const scope = getLedgerRun(runId)?.sessionDir;
				if (scope === undefined) return undefined;
				const running = new Set(listAgents({ runId, scope }).filter(agent => agent.state === "running").map(agent => agent.id));
				for (const item of items) {
					const name = typeof item === "object" && item !== null && "name" in item && typeof item.name === "string" ? item.name : undefined;
					if (name !== undefined && workerSlot(runId, name) !== undefined && !running.has(name)) releaseWorkerSlot(runId, name);
				}
			}
		}
		// A native `wait` consumes completed background jobs, so its terminal task rows are deliveries even though no
		// `async-result` message follows. The collector accepts only exact admitted rows with a real deliverable.
		if (event.toolName === "wait") {
			await attempts.observeWaitResult({
				runId,
				parentId: ctx.agent.id,
				details: event.details,
				observedAt: Date.now(),
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
		// A follow-up counts when its write was delivered, for the agent omp resolved it to. That delivery also admits
		// a reused live agent into this run, and gives a reused reviewer a fresh baseline before its next turn.
		const target = deliveredFollowUp(event.toolName, event.input, event.isError);
		const targetRun = getLedgerRun(runId);
		const agent =
			target === undefined || targetRun === undefined
				? undefined
				: followUpAgent(listAgents({ scope: targetRun.sessionDir }), target);
		if (!agent || targetRun === undefined) return undefined;
		noteAgentFollowUp(agent.id, targetRun.sessionDir);
		bindLedgerChild(runId, agent.id, agent.parentId ?? ctx.agent.id, artifactsOf(ctx));
		// The follow-up's next async job is already in this parent session's own snapshot. Its exact id (not a guessed
		// name) is what lets the first delivery bind to this turn instead of looking stale.
		const snapshot = ctx.getAsyncJobSnapshot?.();
		if (snapshot) attempts.bindFollowUpJobs({ runId, spawnKey: agent.id, jobs: [...snapshot.running, ...snapshot.recent] });
		return undefined;
	});

	pi.on("agent_start", () => {
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
				// After the ledger says settled: the run's phase reads it, so touching the run before the update would
				// leave the last worker or reviewer looking active until another event.
				touchRun(ledger.runId);
			}
			// A settled turn is over: the lane's shared-write reservation ends with it, not when the next spawn asks.
			// The persisted authority is closed for this attempt as well; a follow-up reopens it before delivery.
			if (settled) {
				runs.runLanes()?.releaseAgent(ctx.agent.id);
				// A child session has no RunController of its own; release the run's shared slot here so a reused worker
				// never keeps its slot after its turn.
				if (ledger !== undefined) releaseWorkerSlot(ledger.runId, ctx.agent.id);
				await closeChildWorkerAdmission(ctx);
			}
			return;
		}
		const eventSessionId = mainSessionId(ctx);
		const auto = !event.willContinue && eventSessionId !== undefined ? autos.get(eventSessionId) : undefined;
		// Clear the ending request before yielding; a detached old handler must never clear a newer prompt's task.
		if (auto !== undefined) auto.task = undefined;
		// Paused on async subagents: the moment to shed context before their results arrive. Both manual and automatic
		// runs use the same background handoff, so the recorded ledger is identical.
		if (event.awaitingAsyncWork) runs.startCheckpoint();
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
			decisions.forget(id);
		}
		stateCache.clear();
		attempts.stop();
		liveStatus.beginSession();
		openWaits.clear();
		resetCloseoutChoices(ctx);
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
		forgetConversation(ctx);
		const active = getLedgerRun(runs.runId());
		if (active !== undefined) await revokeWorkerAdmissionsFor({ runId: active.runId });
		await runs.finish("shutdown", ctx);
		if (active !== undefined) clearWorkerSlots(active.runId);
		await syncSession(ctx).catch(() => undefined);
	};

	pi.on("session_shutdown", async (_event, ctx) => {
		// A subagent's session closes when omp parks it (idle TTL), kills it, or exits.
		if (ctx.agent.kind === "sub") {
			const ledger = childLedger(ctx);
			if (ledger !== undefined) {
				noteAgentParked(ctx.agent.id, ledger.sessionDir);
				releaseWorkerSlot(ledger.runId, ctx.agent.id);
			}
			runs.runLanes()?.releaseAgent(ctx.agent.id);
			agentAuthorities.delete(authorityKey(artifactsOf(ctx), ctx.agent.id));
			const key = reviewerBaselineKey(artifactsOf(ctx), ctx.agent.id);
			reviewerBaselines.delete(key);
			childWorkTrees.delete(key);
			await closeChildWorkerAdmission(ctx);
		} else {
			sessionGeneration++;
			forgetConversation(ctx);
			const active = getLedgerRun(runs.runId());
			if (active !== undefined) {
				await revokeWorkerAdmissionsFor({ runId: active.runId });
				clearWorkerSlots(active.runId);
			}
		}
		// No status load or widget from before the shutdown may land after it.
		liveStatus.beginSession();
		openWaits.clear();
		await runs.finish("shutdown");
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

	/** Refreshes the status line and turns the storm tool on once this session has a Storm config. */
	const syncSession = async (ctx: ExtensionContext, loaded?: ProjectState): Promise<void> => {
		const sessionId = mainSessionId(ctx);
		if (sessionId === undefined) {
			// The host can no longer say whose state this is: leave no Storm surface from another conversation.
			autos.clear();
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
			stateCache.clear();
			liveStatus.clear();
			await deactivateTool();
			return;
		}
		sessionGeneration++;
		autos.delete(sessionId);
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
				const env = flowEnv(ctx, startRun);
				/** Bare /storm: the hub, or just the status where no dialog can be answered. */
				const menu = async (): Promise<void> => {
					if (!ctx.hasUI) await statusFlow(env, ui);
					else if (await hubFlow(env, ui)) await deactivateTool();
				};
				if (input === "") await menu();
				else if (input === "status") await statusFlow(env, ui);
				else if (input === "models") await modelsFlow(env, ui);
				else if (input === "auto") await autoDelegationFlow(env, ui);
				else if (input === "export") await exportFlow(env, ui);
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
