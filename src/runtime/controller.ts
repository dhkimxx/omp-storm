/**
 * Storm run lifecycle for one main session. A run starts from `/storm` at once, or from the storm tool once the turn
 * that queued it settles: team gate, omp's session modes, compaction of a heavy context, then the handoff. An automatic
 * probe opens from the storm tool's first plan inside the running turn, with no handoff or dialog; that accepted plan
 * starts one background checkpoint when the context is already heavy. At the end of every round the round rules decide
 * whether the run is over; when it is not, Storm sends the next round itself, waiting out the hold while the session is
 * busy. Spawn decisions arrive from any session in the process (children included), so they are collected per run in
 * module scope.
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalStore } from "../approval/store.ts";
import { docsEnabled } from "../policy/docs.ts";
import { clearRunReads, openRunReads } from "../policy/reads.ts";
import { formatUsd, shadowBlock, teamGate, usableRole } from "../policy/spawn.ts";
import { tokens } from "../report/agents.ts";
import { directorCap, PREFLIGHT_SHARE, PREFLIGHT_TOKENS, roleTitle } from "../roles.ts";
import { isApproved, type ProjectState } from "../state.ts";
import { assertSessionStoreSafe } from "../session-scope.ts";
import type { RunRequestResult } from "../tool/host.ts";
import type {
	AgentEntry,
	PlanLaneResult,
	ResultInputVersion,
	RunCheckpoint,
	RunCheckEvidence,
	RunEndReason,
	RunPlan,
	RunRecord,
	RunResult,
	RunSpec,
	SpawnBlockCode,
	SpawnRecord,
	StormConfig,
	UiPort,
} from "../types.ts";
import { attemptUsable, type AttemptReport } from "./attempt-report.ts";
import type { AttemptAdmission, AttemptArtifactMode, AttemptPreparation, AttemptSettlement } from "./attempt-bridge.ts";
import { markAgentsCleaned } from "./agents.ts";
import { bytesText, processKey, recordTrustedRun, runJanitor } from "./janitor.ts";
import { runRequiredChecks, type CheckReport, type RequiredChecksResult } from "./checks.ts";
import {
	CLOSEOUT_CHOICE_HINT,
	CLOSEOUT_TITLE,
	closeoutCard,
	type CloseoutDraft,
	closeoutSessionId,
	isSubstantiveRun,
	parseCloseout,
	rememberCloseoutReport,
	resetCloseoutChoices,
} from "./closeout.ts";
import { checkpointGuidance, shouldCheckpoint } from "./checkpoint.ts";
import { laneRouteFingerprint, replanConflict, RunLanes, type LaneReadiness, type LaneResultReadiness } from "./lanes.ts";
import { hasStaleInputs, inputSnapshot, requirementConflict, staleRequirementIds, currentInputVersion } from "./requirements.ts";
import { acquireRunLease, type AcquireRunLeaseResult, type RunLease } from "./lease.ts";
import { activeLedgerRun, endLedgerRun, getLedgerRun, type LedgerRun, setLedgerPlan, startLedgerRun } from "./ledger.ts";
import { reviewLine } from "./review.ts";
import {
	buildRoundMessage,
	decideRound,
	END_STATUS,
	endLabel,
	HOLD_MS,
	lastWriterChangeAt,
	maxRounds,
	reviewGate,
	reviewProof,
	ROUND_DELAY_MS,
	STATUS_LABEL,
	treeFingerprint,
	type CoverageCheck,
	type CoverageInput,
	type CoverageLane,
	type CoverageResult,
	type Gate,
	type RoundDecision,
} from "./rounds.ts";
import { captureSharedBaseline, evaluateSettledResults, resultContractIdentity, type AnswerCitation, type ApprovedCheckEvidence, type ArtifactEvidenceSource, type ResultBaseline, type ResultEvidenceItem } from "./result-evidence.ts";
import { locateResult, projectAcceptedResult } from "./result-location.ts";
import { buildHandoff, newRunId, pruneRuns, readRun, REQUEST_LIMIT, RUN_KEEP, writeRun } from "./run.ts";
import { appendRunIndex, summarizeForIndex } from "./run-index.ts";
import { noteResumePointer, protectedResumeRunIds, trustedResume, type ResumeTarget } from "./resume.ts";
import type { TreeReading, TreeState } from "./tree.ts";
import type { RunPhase } from "../view/appearance.ts";

const spawnsByRun = new Map<string, SpawnRecord[]>();

/** Debounced writers of the runs owned by sessions in this process, keyed by run id. */
const liveWriters = new Map<string, () => void>();
/**
 * Immediate phase listeners of the controlling session, keyed by run id. A child session reports its start, settle
 * and approvals through these: the main session draws, the child never does. View-only, like the phases themselves.
 */
const phaseWatchers = new Map<string, () => void>();
/**
 * View-only keys of the host dialogs this process's live run is waiting on. A key exists only while its run has a
 * phase watcher, so an event that outlives its run cannot mark the next one as waiting.
 */
const userWaits = new Map<string, Set<string>>();
/**
 * How often an active run's record is rewritten at most. The live record is what remains of a run whose process
 * dies: the next run's janitor marks it stopped and it shows up as the last run with what it had spent and spawned.
 */
const LIVE_FLUSH_MS = 2_000;
/** How often a stopping run asks whether work it still owns has settled. */
const DRAIN_POLL_MS = 1_000;
/** How long a stopping run keeps its scope, lease and accounting while owned work settles. */
const DRAIN_MAX_MS = 30_000;
/**
 * How long a consumer's admission may wait for an already-started settlement of its prerequisite. A native delivery
 * often lands just before the next tool call: without this barrier the consumer would read the previous pending row
 * and be refused for a result that is being written in the same tick.
 */
const ADMISSION_SETTLE_WAIT_MS = 1_000;

/** Asks the owning session to rewrite the run's record soon (spawns, spend) and to re-check its live phase at once. */
export function touchRun(runId: string): void {
	liveWriters.get(runId)?.();
	phaseWatchers.get(runId)?.();
}

/**
 * Records or clears one host dialog (`ask`, a tool approval, a Storm tool prompt) the run is waiting on and asks its
 * controller for an immediate live update. `runId` names the run-bound session that saw the event; without a live
 * controller for that exact run this is a no-op, so a late event from a settled, switched or finished run never
 * marks another run as waiting. The keys and the phases are presentation-only and never reach a record.
 */
export function noteRunUserWait(runId: string | undefined, key: string, waiting: boolean): void {
	if (runId === undefined) return;
	const watcher = phaseWatchers.get(runId);
	if (watcher === undefined) return;
	let keys = userWaits.get(runId);
	if (waiting) {
		if (keys === undefined) {
			keys = new Set();
			userWaits.set(runId, keys);
		} else if (keys.has(key)) {
			return;
		}
		keys.add(key);
	} else {
		if (keys?.delete(key) !== true) return;
		if (keys.size === 0) userWaits.delete(runId);
	}
	watcher();
}

/** The spawns decided so far in a run, from whichever session decided them (a copy). */
export function runSpawns(runId: string): SpawnRecord[] {
	return [...(spawnsByRun.get(runId) ?? [])];
}

/** What compaction before a run must keep: the director works from it for the whole run. */
const PREFLIGHT_INSTRUCTIONS =
	"곧 Storm 실행을 시작합니다. 작업 계획, 내린 결정과 그 이유, 남은 문제, 관련 파일 경로는 빠짐없이 남기고 나머지는 짧게 줄이세요.";

/** Called by the spawn hook of whichever session decided the spawn. A finished run takes no more spawns. */
export function noteRunSpawn(runId: string, record: SpawnRecord): void {
	const list = spawnsByRun.get(runId);
	if (!list) return;
	list.push(record);
	touchRun(runId);
}

/** How much of the request a run record keeps. */
const TASK_CHARS = 200;

/** Whether a turn ended because it was interrupted: omp closes it with an assistant message marked aborted. */
export function turnAborted(messages: readonly unknown[] | undefined): boolean {
	for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
		const message = messages?.[i];
		if (typeof message === "object" && message !== null && "role" in message && message.role === "assistant") {
			return "stopReason" in message && message.stopReason === "aborted";
		}
	}
	return false;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** omp refuses a prompt whose setup the user interrupted with this error (`PromptDroppedError`, named in its class). */
const promptDropped = (error: unknown): boolean => error instanceof Error && error.name === "PromptDroppedError";

function withoutDocFindings(agent: AgentEntry): AgentEntry {
	if (agent.review?.docFindings === undefined) return agent;
	const review = { ...agent.review };
	delete review.docFindings;
	return { ...agent, review };
}

function withoutCleanup(config: StormConfig): StormConfig {
	const copy = { ...config };
	delete copy.cleanup;
	return copy;
}

/** Where the main session keeps its subagents' records: the run-end janitor finds them there later. */
function artifactsOf(ctx: ExtensionContext): { artifactsDir?: string } {
	// In-memory sessions (and bare test contexts) have no artifacts dir: their runs keep no cleanable records.
	const dir = ctx.sessionManager?.getArtifactsDir();
	return typeof dir === "string" && dir !== "" ? { artifactsDir: dir } : {};
}

/** One prepared dispatch: the lane contract snapshot and its pre-attempt baseline, keyed by the bridge handle. */
interface PreparedAttempt {
	lane: string;
	spawnKey: string;
	parentId: string;
	dispatch: string;
	startedAt: number;
	/** Monotonic per-run attempt order; a newer attempt for the same lane supersedes an older settlement. */
	epoch: number;
	/** Fingerprint of the lane route this attempt ran under; a same-route respawn needs a new plan route. */
	route: string;
	artifactMode: AttemptArtifactMode;
	results: readonly PlanLaneResult[];
	laneFiles?: readonly string[];
	/** Producer result versions this attempt started from; absent when the lane declared no prerequisites. */
	consumed?: readonly ResultInputVersion[];
	/** Captured immediately before the attempt; absent for a legacy lane with no declared results. */
	baseline?: ResultBaseline;
}

/** The last settled attempt of a lane, kept bounded for a later re-evaluation whose check evidence was not ready yet. */
interface SettledAttempt {
	prepared: PreparedAttempt;
	attemptId: string;
	reportText?: string;
	citations: readonly AnswerCitation[];
	artifact?: ArtifactEvidenceSource;
	/** The lane declared a check and no approved report existed at settlement; one re-evaluation is owed. */
	checkDeferred?: boolean;
}

/** One result reason is one compact record and closeout line: no newlines, no unbounded model or host text. */
function compactResultReason(text: string): string {
	const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
	return line.slice(0, 100);
}

/**
 * Whether acting on this plan can change the target or run commands there. A safe reader stays a reader; every other
 * lane kind, declared file or non-answer result must hold the worktree write claim before the plan is bound.
 */
function planNeedsWrite(plan: RunPlan): boolean {
	return plan.lanes.some(
		lane =>
			(lane.kind !== "explore" && lane.kind !== "review") ||
			(lane.files?.length ?? 0) > 0 ||
			(lane.results ?? []).some(result => result.kind !== "answer"),
	);
}

/** The bounded contract a run row keeps after its lane leaves: only fields that identify what must still be shown. */
function persistedResultContract(result: PlanLaneResult): PlanLaneResult {
	return {
		id: result.id,
		kind: result.kind,
		criterion: result.criterion,
		...(result.path === undefined ? {} : { path: result.path }),
		...(result.contains === undefined ? {} : { contains: result.contains }),
		...(result.check === undefined ? {} : { check: result.check }),
	};
}
/** A requirement whose lane left the plan is still owed: only an explicit scope change or acceptance clears it. */
const ORPHAN_RESULT_REASON = "계획에서 빠진 필수 결과입니다. 다시 배정하거나 사용자가 범위를 바꿔야 합니다.";
const RESULT_FALLBACK_REASON: Record<"unmet" | "reviewable", string> = {
	unmet: "요구 결과가 충족되지 않았습니다.",
	reviewable: "제출물이 있어 자연어 판단이 필요합니다.",
};
/** A host attempt reference is a short token, never a path or model text; an unsafe one is omitted. */
const ATTEMPT_REF = /^[A-Za-z0-9:._-]{1,64}$/u;
/** Structured spawn refusals the user must resolve in team setup; capacity and plan errors are not included. */
const CONFIG_REFUSAL_CODES: Readonly<Partial<Record<SpawnBlockCode, true>>> = {
	"no-config": true,
	unapproved: true,
	shadow: true,
};

/** A config refusal reason is one bounded row line; a host path is not carried into the run record. */
function configRefusalReason(text: string): string {
	const redacted = text.replace(/(^|[\s("'=])(?:~\/[^\s)"']*|[A-Za-z]:[\\/][^\s)"']*|\/(?:[^\s/)"']+\/)[^\s)"']*)/gu, "$1<path>");
	return compactResultReason(redacted);
}

/** The unverified gate a round message is built from, as `decideRound` hands it over. */
type RoundGate = Extract<RoundDecision, { action: "continue" }>["gate"];

/** One accepted row's usable location: a retained isolated artifact, the current parent, or an answer's own proof. */
type AcceptedLocation =
	| { ok: true; integrated: boolean; retained?: LaneResultReadiness["retained"] }
	| { ok: false; reason: string };

interface OwnRun {
	record: RunRecord;
	/** The actual target worktree: tree snapshots, checks, evidence and reviewer proofs read here. */
	root: string;
	repoId: string;
	/** This native session's Storm store, captured at admission: every persistence write of this run goes here. */
	sessionDir: string;
	/** The session that directs the run: live record writes happen without a ctx of their own. */
	ctx: ExtensionContext;
	/** Snapshot at admission: the host may mutate the session manager when it switches conversations. */
	readonly sessionId: string;
	/** The approved config the run started under. */
	config: StormConfig;
	/** Approval records of this session's target: the run-end janitor keeps them within their limits. */
	store: ApprovalStore;
	/** The worktree execution slot, held through drain and released only at finalization. */
	lease?: RunLease;
	/** One lane matcher for this run; retained across replans so reservations do not collide. */
	lanes: RunLanes;
	/** Prepared dispatches by bridge handle; a settlement consumes exactly its own entry. */
	attempts: Map<string, PreparedAttempt>;
	/** Monotonic attempt order; a newer attempt of a lane fences every older settlement. */
	attemptSerial: number;
	/** Latest prepared attempt epoch per lane, so a late success/failure cannot overwrite newer evidence. */
	laneAttempt: Map<string, number>;
	/** The latest settled attempt per lane, for a bounded re-evaluation once approved check evidence exists. */
	settled: Map<string, SettledAttempt>;
	/** Accepted S1 evidence by result id, with its host-bound retained source; the location check needs these facts. */
	evidence: Map<string, { item: ResultEvidenceItem; artifact?: ArtifactEvidenceSource }>;
	/** Lanes whose settlement is being evaluated now; a consumer admission waits for these before reading rows. */
	settling: Set<string>;
	/** Aborts checks and other bounded work as soon as the run starts stopping. */
	abort: AbortController;
	/** Required-check reports by tree fingerprint; "skipped" means the tree was decided ineligible. */
	checks: Map<string, CheckReport | "skipped">;
	/** The tree a required-check run is currently evaluating; no second run starts for it. */
	checking?: string;
	/** The compact evidence of the latest check report, written with every live and final record. */
	checkEvidence?: RunCheckEvidence[];
	/** The last valid closeout brief submitted for this run; the final record only, never a status change. */
	closeout?: CloseoutDraft;
	/** The context of the first stop, reused when the run finalizes after a deferred drain. */
	finishCtx?: ExtensionContext;
	/** A stopping run's detached recheck timer; it never blocks a shutdown or an agent_end handler. */
	drainTimer?: unknown;
	/** Polls spent waiting for owned work; after the timeout the deferral is reported once. */
	drainPolls?: number;
	drainWarned?: boolean;
	/** A verified run that had to wait for owned work rechecks its proof before it may keep that label. */
	drained?: boolean;
	/** The end a round-limit/no-progress decision would take if the one pending check-only look cannot verify. */
	checksOnlyEnd?: RunEndReason;
	/** The handoff turn has begun; settles before it do not count. */
	turnStarted: boolean;
	/** A main turn is running: between an `agent_start` and the terminal `agent_end` after it. */
	inTurn: boolean;
	/** The Storm-scheduled round number this turn belongs to; undefined for a user clarification/activity turn. */
	roundInFlight?: number;
	/** A Storm round (or the initial handoff) was sent and its turn has not started yet. */
	awaitingRound?: number;
	/** Started inside a running turn as an automatic probe: it sends no handoff and keeps routine ends out of the transcript. */
	auto?: boolean;
	/** Why the run is over, decided while a turn was still running: that turn's end finishes it, its last message counted. */
	ending?: RunEndReason;
	/** Most rounds the run may take, fixed at start: a team edited mid-run must not move the goal posts. */
	maxRounds: number;
	/** The user's wall-time limit in minutes, when the request stated one. */
	minutes?: number;
	/** The work tree when the run started: the gate compares it with the tree at each round. */
	tree?: TreeState;
	/** The commit the start tree was read against: every later read compares with it, so a commit does not hide a change. */
	base?: string;
	/** When Storm first sent a round for a tree-only stale review: a verdict after it is not stale because of the tree. */
	rereviewedAt?: number;
	/** The team's activity when Storm sent its last round message: what the next round is expected to move. */
	progress?: { changes: number; reviews: number; requests: number; result?: string };
	/** The pending look timer: the round delay, or the wait while the session is held. */
	hold?: unknown;
	/** The last `agent_end` paused the run on async work: a terminal end without a new turn means the user stopped that wait. */
	awaitingAsync: boolean;
	/** A background director checkpoint of this run is in flight; its abort dies with the run. */
	checkpoint?: { controller: AbortController; applied: boolean };
	/** When the host last rejected a checkpoint (memory only): holds off the next try for the min gap. */
	checkpointRejectedAt?: number;
	/** View-only: the phase last handed to the live callback. Never written to the record or read by a decision. */
	shownPhase?: RunPhase;
	/** View-only: a required-check runner is inside `runRequiredChecks` now, not merely being prepared. */
	checksRunning?: boolean;
}

type Refusal = Extract<RunRequestResult, { ok: false }>;
const refuse = (reason: string): Refusal => ({ ok: false, reason });

const START = { vibeOff: "omp vibe 끄고 시작", cancel: "취소" } as const;

export interface RunTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const REAL_TIMERS: RunTimers = {
	set: (run, ms) => {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return timer;
	},
	clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

export interface RunControllerDeps {
	pi: Pick<ExtensionAPI, "sendUserMessage">;
	ui(ctx: ExtensionContext): UiPort;
	loadState(ctx: ExtensionContext): Promise<ProjectState>;
	now(): number;
	/** Subagents whose latest turn was during the run, from the agent ledger, scoped to this session's store. */
	agents?(runId: string, sessionDir: string): AgentEntry[];
	/** The work tree's state against `base` (HEAD when absent); absent in hosts and tests that have no git. */
	tree?(root: string, base?: string): Promise<TreeReading | undefined>;
	/** Every subagent this process has seen in this session (any run): the janitor only cleans those omp has parked. */
	ledger?(sessionDir: string): AgentEntry[];
	/** omp's agent dir: the janitor deletes omp records only below its `sessions/`. Absent → no omp record cleanup. */
	agentDir?: string;
	/** How long a live rewrite of the run record waits to batch changes; defaults to LIVE_FLUSH_MS. */
	flushMs?: number;
	/** The look timer's clock; real timers when absent. */
	timers?: RunTimers;
	/** Acquires the session's execution lease; the real hard-link lease when absent. */
	lease?(
		input: Parameters<typeof acquireRunLease>[0],
		deps?: Parameters<typeof acquireRunLease>[1],
	): Promise<AcquireRunLeaseResult>;
	/**
	 * The live status record: the run after it was first written, on every live rewrite and when a round is sent;
	 * `undefined` when the run ends. A failing hook never breaks the run.
	 */
	live?(ctx: ExtensionContext, run: RunRecord | undefined): void;
}

export class RunController {
	#pending: { runId: string; spec: RunSpec } | undefined;
	/** A start is between its checks and its handoff (it may be asking, compacting, or recording the run). */
	#starting = false;
	#own: OwnRun | undefined;
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped when the run lifecycle ends (shutdown, session switch): a start in flight must not continue into the next session. */
	#generation = 0;
	/** The last live write; the final record waits for it so a late live write never lands on top. */
	#liveWrite: Promise<unknown> = Promise.resolve();
	/** One finalization per run: a second stop during drain joins it instead of writing a second record. */
	#finishing: Promise<RunRecord | undefined> | undefined;

	constructor(private readonly deps: RunControllerDeps) {}

	/** Wake one consumer admission when a prerequisite's settlement finishes or times out. */
	readonly #settleWaiters = new Set<() => void>();

	#wakeSettlementWaiters(): void {
		const waiters = [...this.#settleWaiters];
		this.#settleWaiters.clear();
		for (const wake of waiters) wake();
	}

	/** Wait, bounded, while a prerequisite has an attempt in flight or its result row is being written. */
	async #awaitSettlements(own: OwnRun, lanes: ReadonlySet<string>, ms: number): Promise<void> {
		if (lanes.size === 0) return;
		const deadline = Date.now() + ms;
		while (this.#hasOpenSettlement(own, lanes)) {
			const left = deadline - Date.now();
			if (left <= 0) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			let timer: ReturnType<typeof setTimeout>;
			const wake = () => {
				clearTimeout(timer);
				this.#settleWaiters.delete(wake);
				resolve();
			};
			timer = setTimeout(wake, left);
			this.#settleWaiters.add(wake);
			await promise;
		}
	}

	#hasOpenSettlement(own: OwnRun, lanes: ReadonlySet<string>): boolean {
		for (const prepared of own.attempts.values()) if (lanes.has(prepared.lane)) return true;
		for (const lane of own.settling) if (lanes.has(lane)) return true;
		return false;
	}

	/** Why no run can be queued or started now: one run per session, running, queued or starting. */
	refusal(): string | undefined {
		if (this.#own) return `이미 Storm 실행(${this.#own.record.runId})이 진행 중입니다.`;
		if (this.#pending) return `이미 예약된 Storm 실행(${this.#pending.runId})이 있습니다.`;
		if (this.#starting) return "이미 Storm 실행을 시작하는 중입니다.";
		return undefined;
	}

	/**
	 * From the storm tool: the run starts once the current turn settles. A tool call cannot hand the session a
	 * message of its own, so every tool-requested run waits for the terminal `agent_end`.
	 */
	request(spec: RunSpec): RunRequestResult {
		const reason = this.refusal();
		if (reason !== undefined) return refuse(reason);
		const runId = newRunId(this.deps.now());
		this.#pending = { runId, spec };
		return { ok: true, runId };
	}

	/** This session's run with live spend from the ledger. */
	active(): RunRecord | undefined {
		const own = this.#own;
		if (!own) return undefined;
		const live = getLedgerRun(own.record.runId);
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const record: RunRecord = {
			...own.record,
			costUsd: live?.costUsd ?? own.record.costUsd,
			costByModel: { ...(live?.costByModel ?? own.record.costByModel) },
			spawns: [...(spawnsByRun.get(own.record.runId) ?? [])],
			...(agents.length ? { agents } : {}),
		};
		if (own.checkEvidence?.length) record.checks = own.checkEvidence;
		return record;
	}

	/**
	 * The live, view-only phase of this session's run, for the status widget and status views; `undefined` when this
	 * session directs no run. It is derived from the run's own turn/agent/check state and the dialogs its sessions
	 * are waiting on, never from the plan: no persisted field and no round, budget or tool decision reads it.
	 */
	phase(): RunPhase | undefined {
		const own = this.#own;
		return own === undefined ? undefined : this.#phaseOf(own);
	}

	/**
	 * Checks the approved team and omp's session modes, compacts a heavy main context, records the run and sends the
	 * handoff. The session must be idle. It can take as long as a dialog or a compaction: callers inside an omp event
	 * handler use `launch`.
	 */
	async start(ctx: ExtensionContext, spec: RunSpec, runId = newRunId(this.deps.now())): Promise<RunRequestResult> {
		return this.#start(ctx, spec, runId);
	}

	/**
	 * Starts an automatic probe inside the main turn that is already running, under a caller-validated plan. It sends
	 * no handoff (the turn continues), does not wait for idle or compact, and asks no dialog; the in-flight turn is the
	 * run's first round. The plan is bound before this returns, so the first spawn sees it. When the caller passes the
	 * team hash it validated the plan against, a different approved team refuses the start.
	 */
	async startWithPlan(ctx: ExtensionContext, spec: RunSpec, plan: RunPlan, configHash?: string): Promise<RunRequestResult> {
		return this.#start(ctx, spec, newRunId(this.deps.now()), plan, configHash);
	}

	async #start(
		ctx: ExtensionContext,
		spec: RunSpec,
		runId: string,
		plan?: RunPlan,
		configHash?: string,
	): Promise<RunRequestResult> {
		// A queued run is not in the way of its own start: `onAgentEnd` takes it off the queue first.
		const reason = this.refusal();
		if (reason !== undefined) return refuse(reason);
		const generation = this.#generation;
		this.#starting = true;
		try {
			return await this.#begin(ctx, spec, runId, plan, configHash, generation);
		} finally {
			this.#starting = false;
		}
	}

	/**
	 * Starts a run without making the caller wait for it. omp gives an `agent_end` handler 30 s and a compaction of a
	 * heavy context takes longer, so the handler returns at once and a refused or failed start is reported by notice.
	 */
	launch(ctx: ExtensionContext, spec: RunSpec, runId?: string): void {
		const ui = this.deps.ui(ctx);
		this.start(ctx, spec, runId).then(
			result => {
				if (!result.ok) ui.notify(`Storm 실행을 시작하지 못했습니다: ${result.reason}`, "warning");
			},
			(error: unknown) => ui.notify(`Storm 실행을 시작하지 못했습니다: ${errorText(error)}`, "error"),
		);
	}

	async #begin(
		ctx: ExtensionContext,
		requested: RunSpec,
		runId: string,
		plan: RunPlan | undefined,
		configHash: string | undefined,
		generation: number,
	): Promise<RunRequestResult> {
		// Only an automatic probe starts inside a turn that is already running; a manual start waits for its handoff.
		const auto = plan !== undefined;
		const gone = (): Refusal => refuse("세션이 바뀌어 Storm 실행을 시작하지 않았습니다.");
		const state = await this.deps.loadState(ctx);
		if (this.#generation !== generation) return gone();
		const gate = teamGate(state);
		if (!gate.ok) return refuse(gate.block.reason);
		if (configHash !== undefined && gate.hash !== configHash) {
			return refuse("계획을 검증한 팀 설정과 지금 승인된 팀 설정이 다릅니다. 계획을 다시 내세요.");
		}
		const shadow = shadowBlock(state);
		if (shadow) return refuse(shadow.reason);
		// The session's own store is the only persistence base; without a host-attested identity there is no safe one.
		// Never substitute cwd, a run id or a literal "main" for a missing session id.
		const sessionId = closeoutSessionId(ctx);
		if (sessionId === undefined) return refuse("세션 ID를 확인하지 못해 Storm 실행을 시작하지 않았습니다.");
		if (state.sessionDir === "") return refuse("세션 저장소를 확인하지 못해 Storm 실행을 시작하지 않았습니다.");
		const sessionDir = state.sessionDir;
		const root = state.repo.root;
		const target: ResumeTarget = { repoId: state.repo.repoId, root };
		const busy = refuse("이 세션에서 다른 Storm 실행이 진행 중입니다.");
		if (activeLedgerRun(sessionDir)) return busy;
		// The host may mutate its session manager in place instead of emitting a switch: every await below must also
		// prove that the context still names this same native session.
		const stale = (): boolean => this.#generation !== generation || closeoutSessionId(ctx) !== sessionId;
		const ui = this.deps.ui(ctx);
		const ready = await this.#ready(ctx, ui, !auto);
		if (stale()) return gone();
		if (!ready.ok) return ready;
		if (!auto) await this.#compactFirst(ctx, ui);
		if (stale()) return gone();
		// The dialog and the compaction awaited: a run of this session may have started meanwhile.
		if (activeLedgerRun(sessionDir)) return busy;

		// The last step before the baseline snapshot: take this session's slot and a read claim on the target. A safe
		// reader may run beside another session's reader; a writer of any session conflicts. A failed acquisition is a
		// refusal, and everything below releases the lease unless the run takes ownership.
		let acquired: AcquireRunLeaseResult;
		try {
			acquired = await (this.deps.lease ?? acquireRunLease)({ sessionDir, sessionId, root, runId, mode: "read" });
		} catch (error) {
			return refuse(`실행 잠금을 확인하지 못해 시작하지 않았습니다: ${errorText(error)}`);
		}
		if (stale()) {
			if (acquired.ok) await this.#releaseLease(acquired.lease, ctx);
			return gone();
		}
		if (!acquired.ok) return refuse(acquired.reason);
		let lease: RunLease | undefined = acquired.lease;
		try {
			// A plan that may change the target must hold the write claim before any handoff or spawn can act on it.
			if (plan !== undefined && planNeedsWrite(plan)) {
				const upgraded = await lease.upgrade({ scope: { kind: "unbounded" } });
				if (stale()) return gone();
				if (!upgraded.ok) return refuse(upgraded.reason);
			}
			const startTree = await this.#treeAt(root);
			if (stale()) return gone();
			// A resumed run starts a new record; what it continues is an old record of this same session and target.
			// An automatic probe has no handoff to put it in, so it does not read the old record.
			const continued = !auto && requested.resumeOf !== undefined ? await readRun(sessionDir, requested.resumeOf) : undefined;
			if (stale()) return gone();
			if (continued !== undefined && !(await trustedResume(sessionDir, target, continued))) {
				return refuse("이 세션과 이 작업 트리에서 시작한 실행만 이어갈 수 있습니다.");
			}
			const resume =
				continued === undefined
					? undefined
					: {
							runId: continued.runId,
							...(continued.endReason !== undefined ? { endReason: continued.endReason } : {}),
							...(continued.turns !== undefined ? { turns: continued.turns } : {}),
							...(continued.plan !== undefined ? { plan: continued.plan } : {}),
							...(continued.request !== undefined ? { requestLength: continued.request.length } : {}),
							...(requested.resumeNote !== undefined ? { said: requested.resumeNote } : {}),
						};

			if (auto) {
				// The caller validated the plan against this session's loaded team. The awaits above may have outlived
				// that authority: re-read it and refuse rather than run the old plan under a fresh approval nobody checked.
				let current: ProjectState;
				try {
					current = await this.deps.loadState(ctx);
				} catch (error) {
					return refuse(`팀 설정을 다시 확인하지 못해 시작하지 않았습니다: ${errorText(error)}`);
				}
				if (stale()) return gone();
				const currentGate = teamGate(current);
				if (!currentGate.ok) return refuse(currentGate.block.reason);
				const currentShadow = shadowBlock(current);
				if (currentShadow) return refuse(currentShadow.reason);
				if (current.repo.repoId !== state.repo.repoId || current.repo.root !== root || current.sessionDir !== sessionDir) {
					return refuse("다른 프로젝트나 세션의 팀 설정으로 바뀌어 실행을 시작하지 않았습니다.");
				}
				if (currentGate.hash !== gate.hash || (configHash !== undefined && currentGate.hash !== configHash)) {
					return refuse("시작하는 동안 팀 설정이 바뀌어 실행 계획을 다시 확인해야 합니다. 다시 시도하세요.");
				}
			}
			if (activeLedgerRun(sessionDir)) return busy;

			const { config, hash } = gate;
			const { task } = requested;
			const roundLimit = maxRounds(requested, config);
			const limits =
				requested.rounds !== undefined || requested.minutes !== undefined
					? {
							...(requested.rounds !== undefined ? { rounds: requested.rounds } : {}),
							...(requested.minutes !== undefined ? { minutes: requested.minutes } : {}),
						}
					: undefined;
			const record: RunRecord = {
				schema: "storm.run/v1",
				runId,
				configHash: hash,
				startedAt: iso(this.deps.now()),
				status: "running",
				task: task.slice(0, TASK_CHARS),
				request: task.slice(0, REQUEST_LIMIT),
				...(requested.resumeOf !== undefined ? { resumeOf: requested.resumeOf } : {}),
				costUsd: 0,
				costByModel: {},
				...(config.budget ? { budget: config.budget } : {}),
				spawns: [],
				...artifactsOf(ctx),
				process: processKey(),
				turns: 0,
				maxRounds: roundLimit,
				...(plan !== undefined ? { plan } : {}),
				...(limits ? { limits } : {}),
			};
			const own: OwnRun = {
				record,
				root,
				repoId: state.repo.repoId,
				sessionDir,
				ctx,
				sessionId,
				config,
				store: state.store,
				lanes: new RunLanes(runId),
				attempts: new Map(),
				attemptSerial: 0,
				laneAttempt: new Map(),
				settled: new Map(),
				evidence: new Map(),
				settling: new Set(),
				abort: new AbortController(),
				checks: new Map(),
				// An automatic probe starts inside a turn whose `agent_start` already happened: it is round one, not a run
				// waiting for a handoff turn that will never begin.
				turnStarted: auto,
				inTurn: auto,
				...(auto ? { auto, roundInFlight: 1 } : {}),
				maxRounds: roundLimit,
				awaitingAsync: false,
				...(startTree !== undefined ? { tree: startTree.state, base: startTree.base } : {}),
				...(requested.minutes !== undefined ? { minutes: requested.minutes } : {}),
			};
			// A stored record is untrusted input: build the message before anything of this run exists, so a bad plan or
			// reason refuses the start instead of leaving a current run without a handoff.
			let handoff: string | undefined;
			if (!auto) {
				try {
					handoff = buildHandoff({ runId, config, hash, task, maxRounds: roundLimit, ...(resume ? { resume } : {}) });
				} catch (error) {
					return refuse(`실행 계약을 만들지 못해 시작하지 않았습니다: ${errorText(error)}`);
				}
			}
			// The run takes the lease from here; a failed start finalizes and releases it through `#stop`.
			own.lease = lease;
			lease = undefined;
			this.#own = own;
			// An automatic plan is bound before its first spawn: seed its requirements into the record now.
			this.#syncResults(own);
			// From here a child's start, settle or approval can refresh the phase immediately; finalization removes it.
			userWaits.delete(runId);
			phaseWatchers.set(runId, () => this.#emitPhase(own));
			try {
				startLedgerRun({
					runId,
					sessionId,
					sessionDir,
					repoId: own.repoId,
					root: own.root,
					...(own.base !== undefined ? { base: own.base } : {}),
					...(config.budget ? { budget: config.budget } : {}),
					onThreshold: (kind, run) => this.#threshold(ctx, kind, run),
				});
				// Bound before anything below awaits: a spawn decided the moment this returns must see the first plan.
				if (plan !== undefined) setLedgerPlan(runId, plan);
				spawnsByRun.set(runId, []);
				openRunReads(runId);
				const startingWrite = writeRun(own.sessionDir, record);
				// The final record waits for the start write, so a shutdown that lands during admission cannot overwrite it.
				this.#liveWrite = startingWrite.catch(() => undefined);
				await startingWrite;
				if (stale() || this.#own !== own) {
					await this.#stop(own, "start-failed", ctx).catch(() => undefined);
					return gone();
				}
				// In this session's own profile store, keyed by its native id and bound to the exact target.
				await noteResumePointer(own.sessionDir, target, record).catch(() => undefined);
				if (stale() || this.#own !== own) {
					await this.#stop(own, "start-failed", ctx).catch(() => undefined);
					return gone();
				}
			} catch (error) {
				// This session directs and the ledger is open, but nothing was handed off: close both rather than leave a run nobody started.
				await this.#stop(own, "start-failed", ctx).catch(() => undefined);
				return refuse(`실행을 기록하지 못해 시작하지 않았습니다: ${errorText(error)}`);
			}
			liveWriters.set(runId, () => this.#scheduleFlush(own));
			own.shownPhase = this.#phaseOf(own);
			this.#liveStatus(own.ctx, this.active());
			if (handoff !== undefined) {
				ui.notify(`Storm 실행을 시작합니다(${runId}).`);
				own.awaitingRound = 1;
				this.deps.pi.sendUserMessage(handoff).catch((error: unknown) => {
					delete own.awaitingRound;
					ui.notify(`실행 계약을 보내지 못했습니다: ${errorText(error)}`, "error");
					this.#stopSoon(own, "start-failed", ctx);
				});
			}
			return { ok: true, runId };
		} finally {
			if (lease !== undefined) await this.#releaseLease(lease, ctx);
		}
	}

	/**
	 * What must hold before a run starts, decided while nothing has started. omp's goal and loop modes would move the
	 * session outside Storm's run, which decides on its own when another round follows, so they are checked first: no
	 * dialog offers to leave vibe only to be refused after it. omp's vibe mode replaces the director's tools, so the
	 * team cannot run inside it either.
	 */
	async #ready(ctx: ExtensionContext, ui: UiPort, allowDialog: boolean): Promise<{ ok: true } | Refusal> {
		const modes = ctx.sessionModes;
		if (!modes) return { ok: true };
		const state = modes.getState();
		if (state.goal.status === "active") {
			return refuse("omp 목표 모드가 켜져 있어 시작하지 않았습니다. 목표를 끝내거나 일시 정지한 뒤 다시 하세요.");
		}
		if (state.loop.status !== "inactive") return refuse("omp 반복 모드가 켜져 있어 시작하지 않았습니다. 반복을 끈 뒤 다시 하세요.");
		if (state.vibe.status !== "active") return { ok: true };
		// A tool call cannot ask the user to change modes: an automatic start refuses and leaves the session as it is.
		if (!allowDialog) return refuse("omp vibe 모드가 켜져 있어 자동 실행을 시작하지 않았습니다. vibe 모드를 끈 뒤 다시 하세요.");
		const choice = await ui.select("omp vibe 모드에서는 Storm 팀을 쓸 수 없습니다. vibe 모드를 끄고 시작할까요?", [START.vibeOff, START.cancel]);
		if (choice !== START.vibeOff) return refuse("omp vibe 모드가 켜져 있어 시작하지 않았습니다.");
		const left = await modes.set({ mode: "vibe", action: "exit" });
		if (!left.ok) {
			const setting = left.code === "disabled" ? " 확장의 모드 제어가 꺼져 있으면 `omp config set extensionHandlers.modeControl true` 로 켜세요." : "";
			return refuse(`${left.message}${setting}`);
		}
		return { ok: true };
	}

	/**
	 * A heavy main context is re-sent on every director request, so it is compacted before the handoff. Never asks
	 * and never stops the start: a failed compaction is reported and the run starts on the context as it is.
	 */
	async #compactFirst(ctx: ExtensionContext, ui: UiPort): Promise<void> {
		const usage = ctx.getContextUsage();
		if (!usage || !(usage.tokens >= PREFLIGHT_TOKENS || usage.percent >= PREFLIGHT_SHARE * 100)) return;
		ui.notify(`감독 컨텍스트가 ${tokens(usage.tokens)} 토큰(창의 ${Math.round(usage.percent)}%)이라 실행 전에 먼저 압축합니다.`);
		try {
			await ctx.compact(PREFLIGHT_INSTRUCTIONS);
		} catch (error) {
			ui.notify(`컨텍스트를 압축하지 못해 그대로 시작합니다: ${errorText(error)}`, "warning");
		}
	}

	onAgentStart(): void {
		const own = this.#own;
		if (!own) return;
		this.#disarm(own);
		own.awaitingAsync = false;
		delete own.checksOnlyEnd;
		if (own.awaitingRound !== undefined) {
			own.roundInFlight = own.awaitingRound;
			delete own.awaitingRound;
		} else if (!own.turnStarted && (own.record.turns ?? 0) === 0) {
			// The handoff turn when the send did not record a round first: the run's first round still counts once.
			own.roundInFlight = 1;
		}
		own.turnStarted = true;
		own.inTurn = true;
		this.#emitPhase(own);
	}

	/** True while this session runs Storm: the main session directs and does not change files itself. */
	directing(): boolean {
		return this.#own !== undefined;
	}

	/** This session's run id while it directs, without building the live record. */
	runId(): string | undefined {
		return this.#own?.record.runId;
	}

	/** The lane matcher of this session's run: the extension assigns director task names and admits successful spawns. */
	runLanes(): RunLanes | undefined {
		return this.#own?.lanes;
	}

	/**
	 * Current facts for the prerequisite edges of a task/follow-up admission. It reads the run's own result ledger and
	 * re-locates every accepted result at its current source: an isolated artifact only from its verified retained
	 * source, shared content only from the current parent. A director's "applied" claim is never proof, and only the
	 * lanes a plan's edges name are inspected.
	 */
	async laneReadiness(plan: RunPlan, needed: ReadonlySet<string>): Promise<Map<string, LaneReadiness>> {
		const view = new Map<string, LaneReadiness>();
		const own = this.#own;
		if (own === undefined) return view;
		// A native delivery can land just before the consumer's call. Wait only for the prerequisites this admission
		// actually reads, and never past a bounded window: a running producer still blocks.
		await this.#awaitSettlements(own, needed, ADMISSION_SETTLE_WAIT_MS);
		this.#syncResults(own);
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const coverage = new Map((this.#planLanes(own, agents) ?? []).map(lane => [lane.name, lane.state === "done"]));
		const sharedTeam = own.config.isolation !== "isolated";
		for (const name of needed) {
			const lane = plan.lanes.find(candidate => candidate.name === name);
			if (lane === undefined) continue;
			const isolated = lane.isolationReason !== undefined || own.config.isolation === "isolated";
			const results: LaneResultReadiness[] = [];
			for (const result of lane.results ?? []) {
				const row = own.record.results?.find(candidate => candidate.id === result.id);
				let state = row?.state ?? "pending";
				let retained: LaneResultReadiness["retained"];
				let retainedReason: string | undefined;
				let integrated = false;
				if (state === "accepted") {
					// An accepted result is usable only from the location S1 can still prove now: a retained source for an
					// isolated artifact, the current parent for shared content. A revert or a vanished patch blocks consumers.
					const location = await this.#acceptedLocation(own, result, isolated, row);
					if (!location.ok) {
						state = "unmet";
						retainedReason = location.reason;
					} else {
						integrated = location.integrated;
						retained = location.retained;
					}
				} else if (isolated && result.kind === "artifact" && state === "reviewable") {
					// A reviewable isolated artifact is not a usable source: its submission has no accepted digest to read.
					const evidence = own.evidence.get(result.id);
					state = "unmet";
					retainedReason = evidence === undefined || row?.attemptId === undefined || row.identity === undefined
						? "보존된 산출물의 시도 근거를 확인하지 못했습니다."
						: "보존된 산출물의 근거가 현재 계약과 다릅니다.";
				}
				const citation = own.evidence.get(result.id)?.item.citation;
				results.push({
					id: result.id,
					kind: result.kind,
					state,
					integrated,
					...(row?.contentVersion === undefined ? {} : { version: row.contentVersion }),
					...(result.path === undefined ? {} : { path: result.path }),
					...(citation === undefined ? {} : { citation: { path: citation.path, ...(citation.line === undefined ? {} : { line: citation.line }) } }),
					...(retained === undefined ? {} : { retained }),
					...(retainedReason === undefined ? {} : { reason: retainedReason }),
				});
			}
			const settled = coverage.get(name) === true;
			const handle = own.lanes.agentForLane(name);
			const running =
				own.settling.has(name) ||
				[...own.attempts.values()].some(prepared => prepared.lane === name) ||
				(handle !== undefined && agents.some(agent => agent.id === handle && agent.state === "running"));
			view.set(name, {
				results,
				settled,
				running,
				// A legacy lane with no declared results has only the shared tree itself as integration proof.
				integrated: sharedTeam && lane.isolationReason === undefined && (results.length === 0 ? settled : results.every(result => result.integrated)),
				...(handle === undefined ? {} : { handle }),
			});
		}
		return view;
	}

	/**
	 * One accepted result's current, usable location, re-read from S1 evidence rather than a status claim: an isolated
	 * artifact only from its verified retained source, shared content from the current parent, and an answer from its
	 * own recorded proof (which has no file location to lose). A review-accepted row has no attempt digest to
	 * re-locate; its bound current-tree verdict is the authority and `#refreshResultReviews` reopens it when the tree
	 * moves. `isolated` is the planned lane's mode; a row whose lane left the plan infers it from the artifact evidence
	 * S1 bound to the accepted attempt, never from a path or a claim.
	 */
	async #acceptedLocation(
		own: OwnRun,
		result: PlanLaneResult,
		isolated: boolean | undefined,
		row: RunResult | undefined,
	): Promise<AcceptedLocation> {
		if (row === undefined || row.state !== "accepted" || row.attemptId === undefined) {
			return { ok: false, reason: "수용된 결과가 없습니다." };
		}
		if (row.origin === "review") return { ok: true, integrated: false };
		if (result.kind === "answer") return { ok: true, integrated: false };
		// An accepted row whose recorded producer versions changed is no longer proof, even before a later pass writes
		// the invalidation reason: a consumer must not start from it.
		if (hasStaleInputs(row, own.record.results ?? [])) {
			return { ok: false, reason: "선행 결과가 바뀌어 이전 근거를 다시 확인해야 합니다." };
		}
		const evidence = own.evidence.get(result.id);
		if (evidence === undefined || evidence.item.identity !== row.identity || evidence.item.attemptId !== row.attemptId) {
			return { ok: false, reason: "수용 당시의 시도 근거를 확인하지 못했습니다." };
		}
		const projection = projectAcceptedResult({
			row: { id: row.id, state: row.state, attemptId: row.attemptId, identity: row.identity, contentVersion: row.contentVersion ?? "" },
			result,
			item: evidence.item,
			...(evidence.artifact === undefined ? {} : { artifact: evidence.artifact }),
		});
		if (!projection.ok) return { ok: false, reason: "수용된 결과의 근거가 현재 계약과 다릅니다." };
		if (result.kind === "artifact" && (isolated ?? evidence.artifact !== undefined)) {
			const location = await locateResult({
				mode: "retained",
				parentRoot: own.root,
				accepted: projection.accepted,
				expectedAttemptId: row.attemptId,
			});
			if (!location.ok) return { ok: false, reason: `보존된 산출물을 확인하지 못했습니다(${location.code}).` };
			return {
				ok: true,
				integrated: false,
				retained: {
					ref: location.location.ref,
					path: location.location.path,
					...(location.location.digest === undefined ? {} : { digest: location.location.digest }),
					kind: location.location.kind,
				},
			};
		}
		const location = await locateResult({
			mode: "integrated",
			parentRoot: own.root,
			accepted: projection.accepted,
			expectedAttemptId: row.attemptId,
		});
		if (!location.ok) return { ok: false, reason: `현재 트리에서 수용된 결과를 확인하지 못했습니다(${location.code}).` };
		return { ok: true, integrated: true };
	}

	/**
	 * Prepares one accepted dispatch: binds the lane's declared results and captures the shared before state. The
	 * extension calls this after every existing spawn/follow-up refusal and before the child runs, so a failed
	 * capture can still stop the work. A legacy lane (no `results`) stores nothing and never gains a requirement.
	 */
	async prepareAttempt(input: AttemptPreparation): Promise<AttemptAdmission> {
		const own = this.#own;
		if (own === undefined || own.record.runId !== input.runId) {
			return { ok: false, reason: "이 실행은 더 이상 진행 중이 아닙니다." };
		}
		if (own.ending !== undefined || own.abort.signal.aborted) {
			return { ok: false, reason: "실행이 끝나는 중이라 새 작업의 기준선을 만들지 않았습니다." };
		}
		// No write-capable attempt starts under a read claim: a plan that can change the target is upgraded before its
		// first spawn, and a failure here refuses the work rather than letting it write beside another owner.
		if (own.record.plan !== undefined && planNeedsWrite(own.record.plan)) {
			const upgraded = await this.#upgradeLease(own);
			if (!upgraded.ok) return { ok: false, reason: upgraded.reason };
			if (this.#own !== own) return { ok: false, reason: "실행이 바뀌어 작업을 시작하지 않았습니다." };
		}
		this.#syncResults(own);
		const lane = own.record.plan?.lanes.find(candidate => candidate.name === input.lane);
		if (lane?.results === undefined || lane.results.length === 0) return { ok: true };
		// The same dispatch is prepared once; a repeated call keeps the first, honest before state.
		if (own.attempts.has(input.dispatch)) return { ok: true };
		const route = laneRouteFingerprint(lane);
		// A native retry already exhausted this exact route. A renamed lane with the same role, goal, files and isolation
		// is the same route, not a fresh allowance; the director must reassign the id to a genuinely different route.
		const exhausted = lane.results.some(result => {
			const row = own.record.results?.find(candidate => candidate.id === result.id);
			return row !== undefined && row.state !== "accepted" && row.remedy === "retry" && row.retryRoute === route;
		});
		if (exhausted) {
			return { ok: false, reason: "호스트 재시도·대체 경로가 소진된 같은 레인/경로입니다. 이 레인을 다시 스폰하지 말고, 필수 결과를 다른 승인된 역할·파일·목표의 레인으로 이관하거나 조건을 바꾼 뒤 계획을 다시 내세요." };
		}
		const capture = await captureSharedBaseline({
			lane: lane.name,
			results: lane.results,
			root: own.root,
			config: own.config,
			...(lane.files === undefined ? {} : { laneFiles: lane.files }),
			artifactMode: input.artifactMode,
		});
		if (!capture.ok) {
			return { ok: false, reason: `필수 결과의 사전 기준선을 만들지 못해 작업을 시작하지 않았습니다: ${capture.reason}` };
		}
		// Snapshot the producer versions now, before the child runs: this attempt's evidence may only be used against
		// these versions. A newer attempt of the same lane fences this one even if its settlement arrives later.
		const epoch = ++own.attemptSerial;
		own.laneAttempt.set(lane.name, epoch);
		const consumed = inputSnapshot(own.record.plan, lane, own.record.results);
		own.attempts.set(input.dispatch, {
			lane: lane.name,
			spawnKey: input.spawnKey,
			parentId: input.parentId,
			dispatch: input.dispatch,
			startedAt: input.startedAt,
			epoch,
			route,
			artifactMode: input.artifactMode,
			results: lane.results,
			...(consumed.length === 0 ? {} : { consumed }),
			...(lane.files === undefined ? {} : { laneFiles: lane.files }),
			baseline: capture.baseline,
		});
		return { ok: true };
	}

	/**
	 * Settles exactly one prepared dispatch. Only an exact, usable host report may bind `attemptId`; a missing,
	 * stale or mismatched report leaves the requirement unresolved with a compact reason, and a late settlement for
	 * a run that is no longer this session's is ignored. Evaluation never trusts model text as a path or a verdict.
	 */
	async settleAttempt(input: AttemptSettlement): Promise<void> {
		const own = this.#own;
		if (own === undefined || own.record.runId !== input.runId) return;
		const prepared = own.attempts.get(input.dispatch);
		if (prepared === undefined) return;
		own.attempts.delete(input.dispatch);
		own.settling.add(prepared.lane);
		try {
			// A newer attempt of this lane already started: its settlement governs the requirement. The older attempt
			// must not reinstate a success (or a failure) even when the host delivers it late.
			if (prepared.epoch < (own.laneAttempt.get(prepared.lane) ?? 0)) return;
			const report = input.report;
			const exact =
				attemptUsable(report) &&
				report.runId === input.runId &&
				report.parentId === input.parentId &&
				report.spawnKey === input.spawnKey;
			if (!exact || report.attemptId === undefined) {
				this.#applyUnusableAttempt(own, prepared, report);
				return;
			}
			// The host's settlement authority is checked before any file or answer read: a failed, cancelled or
			// schema-invalid attempt can witness its own failure, never make a physically present file or prior answer an
			// accepted result. The exact attempt id stays bound so the record says which native job failed.
			if (report.outcome !== "success" || report.schemaStatus === "invalid") {
				this.#applyBlockedAttempt(own, prepared, report);
				return;
			}
			// A success against a producer version that has since changed is not evidence for the requirement now: the
			// attempt is recorded honestly as unmet rather than reviving the old input's proof.
			if (this.#staleInputs(own, prepared)) {
				this.#applyStaleInput(own, prepared, report.attemptId);
				return;
			}
			const artifacts = report.artifacts.filter(artifact => artifact.kind === "patch" && artifact.path !== "");
			const patch = artifacts.find(artifact => (artifact.bytes ?? 0) > 0);
			const artifact: ArtifactEvidenceSource | undefined =
				patch === undefined
					? undefined
					: {
							attemptId: report.attemptId,
							path: patch.path,
							form: "patch",
							...(patch.digest === undefined ? {} : { expectedDigest: patch.digest }),
						};
			const settled: SettledAttempt = {
				prepared,
				attemptId: report.attemptId,
				...(input.reportText === undefined ? {} : { reportText: input.reportText }),
				citations: [...input.citations],
				...(artifact === undefined ? {} : { artifact }),
			};
			own.settled.set(prepared.lane, settled);
			await this.#evaluateAttempt(own, settled);
			this.#scheduleFlush(own);
		} finally {
			own.settling.delete(prepared.lane);
			this.#wakeSettlementWaiters();
		}
	}

	/**
	 * Re-derives the ledger from the current plan without inventing requirements: a new id starts pending, an existing
	 * id keeps its state across reassignment, and a removed lane keeps every non-accepted obligation (with no lane).
	 * The bounded contract is persisted per id so an accepted row can still be re-located after its lane leaves; it is
	 * never rewritten while the identity matches. A changed contract under the same id is a new requirement: its old
	 * contract, attempt evidence and accepted proof are dropped, never inherited.
	 */
	#syncResults(own: OwnRun): boolean {
		const rows = own.record.results ?? [];
		const byId = new Map(rows.map(row => [row.id, row]));
		const assigned = new Set<string>();
		let changed = false;
		for (const lane of own.record.plan?.lanes ?? []) {
			for (const result of lane.results ?? []) {
				const identity = resultContractIdentity(result);
				assigned.add(result.id);
				const row = byId.get(result.id);
				if (row === undefined) {
					rows.push({
						id: result.id,
						lane: lane.name,
						state: "pending",
						identity,
						contract: persistedResultContract(result),
						origin: "plan",
					});
					byId.set(result.id, rows[rows.length - 1]!);
					changed = true;
					continue;
				}
				if (row.lane !== lane.name) {
					row.lane = lane.name;
					// A reassigned requirement is no longer the orphan its old row said it was; keep the failure reason.
					if (row.reason?.startsWith(ORPHAN_RESULT_REASON)) {
						const prior = row.reason.slice(ORPHAN_RESULT_REASON.length).trim();
						if (prior === "") delete row.reason;
						else row.reason = prior;
					}
					// A genuinely different route may reassign the same requirement once; a rename with the same route
					// keeps the retry remedy and the prepareAttempt guard blocks the identical respawn.
					if (row.remedy === "retry" && row.retryRoute !== undefined && row.retryRoute !== laneRouteFingerprint(lane)) {
						delete row.remedy;
						delete row.retryRoute;
						delete row.unblock;
					}
					changed = true;
				}
				if (row.identity === undefined) {
					row.identity = identity;
					if (row.contract === undefined) row.contract = persistedResultContract(result);
					changed = true;
				} else if (row.identity !== identity) {
					row.state = "pending";
					row.identity = identity;
					row.contract = persistedResultContract(result);
					row.origin = "plan";
					delete row.reason;
					delete row.attemptId;
					delete row.remedy;
			delete row.retryRoute;
					delete row.unblock;
					delete row.contentVersion;
					delete row.consumed;
					delete row.reviewTree;
					own.evidence.delete(row.id);
					changed = true;
				}
			}
		}
		for (const row of rows) {
			if (assigned.has(row.id)) continue;
			if (row.lane !== undefined) {
				delete row.lane;
				changed = true;
			}
			if (row.state !== "accepted" && !(row.reason ?? "").startsWith(ORPHAN_RESULT_REASON)) {
				row.reason = row.reason === undefined || row.reason === ""
					? ORPHAN_RESULT_REASON
					: compactResultReason(`${ORPHAN_RESULT_REASON} ${row.reason}`);
				changed = true;
			}
		}
		if (changed) {
			if (rows.length > 0) own.record.results = rows;
			else delete own.record.results;
			this.#scheduleFlush(own);
		}
		// A plan change can leave an already-invalid consumer in the ledger (a legacy row, a removed producer). The
		// rows are re-read after the plan edit, never assumed fresh.
		if (this.#invalidateConsumers(own)) changed = true;
		return changed;
	}

	/** The current plan's declaration for one result id, wherever its lane now is. */
	#plannedResult(own: OwnRun, id: string): PlanLaneResult | undefined {
		for (const lane of own.record.plan?.lanes ?? []) {
			const found = lane.results?.find(result => result.id === id);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	/** Whether a prepared attempt's declared producer versions changed after it started. */
	#staleInputs(own: OwnRun, prepared: PreparedAttempt): boolean {
		if ((prepared.consumed ?? []).length === 0) return false;
		const byId = new Map((own.record.results ?? []).map(row => [row.id, row]));
		return (prepared.consumed ?? []).some(input => currentInputVersion(byId.get(input.id)) !== input.version);
	}

	/** Bind a row to the producer versions this attempt started from; the attempt's outcome never rewrites that fact. */
	#bindConsumed(row: RunResult, prepared: PreparedAttempt): void {
		if ((prepared.consumed ?? []).length === 0) {
			delete row.consumed;
			return;
		}
		row.consumed = [...(prepared.consumed ?? [])];
	}

	/**
	 * A success whose producer versions changed is no longer evidence. The attempt is still host-observed, so its id is
	 * recorded, but the row is unmet and every consumer of it is reopened transitively.
	 */
	#applyStaleInput(own: OwnRun, prepared: PreparedAttempt, attemptId: string): void {
		const rows = own.record.results ?? [];
		let changed = false;
		for (const result of prepared.results) {
			const row = rows.find(candidate => candidate.id === result.id);
			if (row === undefined) continue;
			const identity = resultContractIdentity(result);
			if (row.identity !== undefined && row.identity !== identity) continue;
			row.state = "unmet";
			row.reason = compactResultReason("선행 결과가 시도 시작 뒤에 바뀌어 이 시도의 결과를 수용하지 않았습니다.");
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			row.identity = identity;
			row.origin = "attempt";
			row.attemptId = attemptId;
			this.#bindConsumed(row, prepared);
			delete row.contentVersion;
			delete row.reviewTree;
			own.evidence.delete(row.id);
			changed = true;
		}
		if (this.#invalidateConsumers(own)) changed = true;
		if (changed) this.#scheduleFlush(own);
	}

	/**
	 * Reopens rows whose recorded producer versions no longer describe the ledger. Only accepted/reviewable evidence is
	 * touched: a pending row invents nothing and an already-unmet row stays as it is. The pass is transitive because a
	 * reopened row is no longer a usable input.
	 */
	#invalidateConsumers(own: OwnRun): boolean {
		const rows = own.record.results ?? [];
		if (rows.length === 0) return false;
		const stale = staleRequirementIds(rows);
		if (stale.size === 0) return false;
		let changed = false;
		for (const row of rows) {
			if (!stale.has(row.id)) continue;
			if (row.state !== "accepted" && row.state !== "reviewable") continue;
			row.state = "unmet";
			row.origin = "plan";
			row.reason = compactResultReason("입력으로 쓴 선행 결과가 바뀌어 이전 근거를 다시 확인해야 합니다.");
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			// The attempt is a real host fact and remains useful for the round/closeout; its evidence is what is invalid.
			delete row.contentVersion;
			delete row.reviewTree;
			own.evidence.delete(row.id);
			changed = true;
		}
		if (changed) this.#scheduleFlush(own);
		return changed;
	}

	/** Approved check evidence for the exact tree Storm reads now; absent is missing proof, never a pass. */
	async #approvedCheckEvidence(own: OwnRun): Promise<ApprovedCheckEvidence | undefined> {
		const now = await this.#treeAt(own.root, own.base);
		if (now === undefined) return undefined;
		const fingerprint = treeFingerprint(now.state);
		const report = own.checks.get(fingerprint);
		if (report === undefined || report === "skipped") return undefined;
		let approval;
		try {
			approval = (await this.deps.loadState(own.ctx)).approval;
		} catch {
			return undefined;
		}
		return {
			config: { status: "ok", path: "", config: own.config, hash: own.record.configHash, warnings: [] },
			approval,
			report,
			treeFingerprint: fingerprint,
		};
	}

	/** Applies one evaluator report to the rows it was run for, preserving a prior accepted row for unchanged content. */
	#applyEvaluated(
		own: OwnRun,
		prepared: PreparedAttempt,
		attemptId: string,
		items: readonly ResultEvidenceItem[],
		deferred: ReadonlySet<string>,
	): void {
		const rows = own.record.results ?? [];
		for (const item of items) {
			const row = rows.find(candidate => candidate.id === item.id);
			if (row === undefined) continue;
			// A late settlement of the previous contract must not overwrite a requirement whose id now means something
			// else; the replan reset it to pending and this attempt cannot resurrect the old obligation.
			if (row.identity !== undefined && row.identity !== item.identity) continue;
			// A follow-up that changed nothing is not a regression of evidence an earlier attempt already proved. A
			// failing declared check is not a no-op even when the bytes are unchanged, so it always updates the row.
			// A reviewable submission is evidence too: unrelated edits in the same lane must not turn it back into
			// "nothing changed" and force the producer to submit again (T05 control).
			const unchanged =
				item.state === "unmet" &&
				item.check === undefined &&
				item.digest !== undefined &&
				item.digest === item.previousDigest;
			const preserved =
				unchanged &&
				(row.state === "accepted" || row.state === "reviewable") &&
				row.identity === item.identity &&
				row.contentVersion === item.contentVersion;
			if (preserved) {
				// The result is still the same content, but its dependency snapshot is the newer attempt's: keep the
				// proof and bind it to the versions this attempt really started from.
				this.#bindConsumed(row, prepared);
				continue;
			}
			if (deferred.has(item.id) && item.state !== "accepted") {
				// A required check with no approved evidence yet defers only that check. When the content itself is
				// still the earlier reviewable submission, keep its attempt and version instead of asking for a new
				// submission; when the content is no submission at all, keep it unmet: an unavailable check never
				// turns absent or failing content into something a reviewer could judge.
				if (item.checkDeferred === true) {
					row.state = "reviewable";
					row.reason = compactResultReason("승인된 필수 검사 근거를 기다립니다.");
				} else {
					row.state = item.state;
					row.reason = compactResultReason(item.reason ?? RESULT_FALLBACK_REASON[item.state]);
				}
				row.attemptId = attemptId;
				row.identity = item.identity;
				row.origin = "attempt";
				this.#bindConsumed(row, prepared);
				delete row.remedy;
				delete row.retryRoute;
				delete row.unblock;
				delete row.reviewTree;
				if (item.contentVersion === undefined) delete row.contentVersion;
				else row.contentVersion = item.contentVersion;
				continue;
			}
			row.state = item.state;
			row.attemptId = attemptId;
			row.identity = item.identity;
			row.origin = "attempt";
			this.#bindConsumed(row, prepared);
			delete row.reviewTree;
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			if (item.contentVersion === undefined) delete row.contentVersion;
			else row.contentVersion = item.contentVersion;
			if (item.state === "accepted") delete row.reason;
			else row.reason = compactResultReason(item.reason ?? RESULT_FALLBACK_REASON[item.state]);
		}
		// A producer row that changed content reopens only the evidence that consumed it, transitively.
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
	}

	/**
	 * A usable envelope whose host settlement is failure/cancel, or whose structured output is invalid, leaves every
	 * requirement unmet without reading the tree or an answer. The attempt id is still the host's fact, so it stays.
	 */
	#applyBlockedAttempt(own: OwnRun, prepared: PreparedAttempt, report: AttemptReport): void {
		// A native retry count is a host fact: the existing retry/fallback path is exhausted, so Storm must not start
		// another retry outside its configured limits. A generic failure without that fact stays ordinary work.
		const exhausted = report.outcome === "failure" && report.schemaStatus !== "invalid" && report.retry !== undefined;
		const why =
			report.schemaStatus === "invalid"
				? "구조화 결과가 유효하지 않아"
				: report.outcome === "cancel"
					? "시도가 취소되어"
					: exhausted
						? `호스트 재시도·대체 경로가 소진되어(재시도 ${report.retry!.attempt})`
						: "시도가 실패로 끝나";
		const reason = compactResultReason(`${why} 필수 결과를 수용하지 않았습니다.`);
		const rows = own.record.results ?? [];
		for (const result of prepared.results) {
			const row = rows.find(candidate => candidate.id === result.id);
			if (row === undefined) continue;
			const identity = resultContractIdentity(result);
			if (row.identity !== undefined && row.identity !== identity) continue;
			row.state = "unmet";
			row.reason = reason;
			row.identity = identity;
			row.origin = "attempt";
			if (exhausted) {
				row.remedy = "retry";
				row.retryRoute = prepared.route;
				delete row.unblock;
			} else {
				delete row.remedy;
				delete row.retryRoute;
				delete row.unblock;
			}
			if (report.attemptId !== undefined) row.attemptId = report.attemptId;
			else delete row.attemptId;
			this.#bindConsumed(row, prepared);
			delete row.contentVersion;
			delete row.reviewTree;
		}
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
	}

	/** A report that cannot bind leaves every non-accepted requirement unresolved without an attempt id. */
	#applyUnusableAttempt(own: OwnRun, prepared: PreparedAttempt, report: AttemptReport): void {
		const code = report.captureError ?? (report.attemptId === undefined ? "native-result-missing" : "spawn-mismatch");
		const reason = compactResultReason(`호스트 시도를 확인하지 못했습니다(${code}).`);
		const rows = own.record.results ?? [];
		for (const result of prepared.results) {
			const row = rows.find(candidate => candidate.id === result.id);
			if (row === undefined) continue;
			const identity = resultContractIdentity(result);
			if (row.identity !== undefined && row.identity !== identity) continue;
			// An earlier accepted attempt still stands; only a new unresolved attempt replaces an unresolved row.
			if (row.state === "accepted" && row.identity === identity) continue;
			row.state = "unmet";
			row.reason = reason;
			row.identity = identity;
			row.origin = "attempt";
			delete row.attemptId;
			this.#bindConsumed(row, prepared);
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			delete row.contentVersion;
			delete row.reviewTree;
		}
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
	}

	/** Evaluates one settled attempt against its stored before state and writes the run-scoped rows. */
	async #evaluateAttempt(own: OwnRun, settled: SettledAttempt): Promise<void> {
		const prepared = settled.prepared;
		const checkNames = prepared.results.filter(result => result.check !== undefined).map(result => result.id);
		const checks = checkNames.length === 0 ? undefined : await this.#approvedCheckEvidence(own);
		const deferred = new Set(checkNames.length > 0 && checks === undefined ? checkNames : []);
		settled.checkDeferred = deferred.size > 0;
		const wantsAnswer = prepared.results.some(result => result.kind === "answer");
		const evaluation = await evaluateSettledResults({
			lane: prepared.lane,
			attemptId: settled.attemptId,
			results: prepared.results,
			shared: { root: own.root, ...(prepared.baseline === undefined ? {} : { baseline: prepared.baseline }) },
			artifactMode: prepared.artifactMode,
			config: own.config,
			...(prepared.laneFiles === undefined ? {} : { laneFiles: prepared.laneFiles }),
			...(checks === undefined ? {} : { checks }),
			...(settled.artifact === undefined ? {} : { artifact: settled.artifact }),
			...(wantsAnswer ? { answer: { text: settled.reportText ?? "", citations: [...settled.citations] } } : {}),
		});
		// The run was finalized while the evidence was being read: this settlement is detached and must not mutate the
		// record already written (or the object a caller still holds).
		if (this.#own !== own) return;
		if (!evaluation.ok) {
			const rows = own.record.results ?? [];
			for (const result of prepared.results) {
				const row = rows.find(candidate => candidate.id === result.id);
				if (row === undefined) continue;
				const identity = resultContractIdentity(result);
				if (row.identity !== undefined && row.identity !== identity) continue;
				if (row.state === "accepted" && row.identity === identity) continue;
				row.state = "unmet";
				row.reason = compactResultReason(`결과 근거를 평가하지 못했습니다: ${evaluation.reason}`);
				row.attemptId = settled.attemptId;
				row.identity = identity;
				row.origin = "attempt";
				this.#bindConsumed(row, prepared);
				delete row.remedy;
			delete row.retryRoute;
				delete row.unblock;
				delete row.contentVersion;
				delete row.reviewTree;
			}
			this.#invalidateConsumers(own);
			return;
		}
		this.#applyEvaluated(own, prepared, settled.attemptId, evaluation.report.results, deferred);
		// The location check needs the accepted item's observed digest/paths and the host-bound retained source; a
		// row alone cannot prove that the current parent carries the accepted content.
		for (const item of evaluation.report.results) {
			if (item.state !== "accepted") continue;
			own.evidence.set(item.id, { item, ...(settled.artifact === undefined ? {} : { artifact: settled.artifact }) });
		}
	}

	/** Whether a settled lane is still waiting for approved check evidence it declared. */
	#hasDeferredCheck(own: OwnRun): boolean {
		return [...own.settled.values()].some(
			settled =>
				settled.checkDeferred === true &&
				settled.prepared.epoch >= (own.laneAttempt.get(settled.prepared.lane) ?? 0) &&
				!this.#staleInputs(own, settled.prepared),
		);
	}

	/** Re-runs a check-bearing lane once the approved check report for the current tree exists. */
	async #refreshCheckedResults(own: OwnRun): Promise<void> {
		for (const [lane, settled] of [...own.settled]) {
			if (settled.checkDeferred !== true) continue;
			// A newer attempt or a changed producer makes this settlement's evidence unusable; re-evaluating it would
			// revive a result the run already reopened, and keeping it would ask for checks nobody can use.
			if (settled.prepared.epoch < (own.laneAttempt.get(settled.prepared.lane) ?? 0) || this.#staleInputs(own, settled.prepared)) {
				own.settled.delete(lane);
				continue;
			}
			const rows = own.record.results ?? [];
			const open = settled.prepared.results.some(result => {
				const row = rows.find(candidate => candidate.id === result.id);
				return row !== undefined && row.state !== "accepted";
			});
			if (!open) continue;
			if ((await this.#approvedCheckEvidence(own)) === undefined) continue;
			await this.#evaluateAttempt(own, settled);
		}
	}

	/**
	 * Binds submitted qualitative rows to the approved reviewer's current-tree verdict. An incorrect verdict on this
	 * exact content leaves the row unmet; a stale/unbound verdict leaves it reviewable; a correct current-tree verdict
	 * accepts it even when another run-level check keeps the whole run unverified. Machine-accepted rows are untouched.
	 */
	#refreshResultReviews(own: OwnRun, agents: readonly AgentEntry[], now: TreeState | undefined): boolean {
		this.#syncResults(own);
		const rows = own.record.results ?? [];
		if (rows.length === 0) return false;
		const treeNow = now === undefined || now.incomplete ? undefined : treeFingerprint(now);
		const proof = reviewProof(agents, own.config, treeNow, lastWriterChangeAt(agents));
		let changed = false;
		for (const row of rows) {
			if (row.state === "pending") continue;
			if (row.state === "unmet" && row.origin !== "review") continue;
			if (row.state === "accepted" && row.origin !== "review") continue;
			// A reviewer on the current tree is not proof that a result built from replaced inputs is still correct.
			if (hasStaleInputs(row, rows)) continue;
			// A review state was bound to an older tree: the submission itself is still there, so reopen it for judgement.
			if (row.origin === "review" && row.reviewTree !== treeNow) {
				row.state = "reviewable";
				row.origin = "attempt";
				row.reason = compactResultReason("리뷰 이후 트리가 바뀌어 새 판단이 필요합니다.");
				delete row.remedy;
			delete row.retryRoute;
				delete row.unblock;
				delete row.reviewTree;
				changed = true;
			}
			if (treeNow === undefined) continue;
			// A tree verdict judges only what the reviewer can actually see in the integrated tree. An answer's wording
			// and an isolated artifact's content are not in it, so those rows stay reviewable instead of borrowing proof.
			const planned = this.#plannedResult(own, row.id);
			if (planned?.kind !== "change") continue;
			if (proof.state === "current") {
				if (row.state !== "accepted" || row.origin !== "review" || row.reviewTree !== treeNow) {
					row.state = "accepted";
					row.origin = "review";
					row.reviewTree = treeNow;
					delete row.reason;
					delete row.remedy;
			delete row.retryRoute;
					delete row.unblock;
					changed = true;
				}
			} else if (proof.state === "incorrect" && proof.tree === treeNow && row.state === "reviewable") {
				row.state = "unmet";
				row.origin = "review";
				row.reviewTree = treeNow;
				row.reason = compactResultReason("독립 리뷰가 이 결과를 incorrect로 판정했습니다.");
				delete row.remedy;
			delete row.retryRoute;
				delete row.unblock;
				changed = true;
			}
		}
		if (this.#invalidateConsumers(own)) changed = true;
		if (changed) this.#scheduleFlush(own);
		return changed;
	}

	/** Changes this session's run record and schedules its live rewrite; a no-op without a run. */
	#update(change: (record: RunRecord) => void): void {
		const own = this.#own;
		if (!own) return;
		change(own.record);
		this.#scheduleFlush(own);
	}

	/** Spend of this (main) session while its run is active: what directing costs. */
	noteMainSpend(usd: number): void {
		this.#update(record => {
			record.mainCostUsd = (record.mainCostUsd ?? 0) + usd;
		});
	}

	/** A file change the main session tried itself; director mode sent it back to delegation. */
	noteBlockedEdit(): void {
		this.#update(record => {
			record.blockedEdits = (record.blockedEdits ?? 0) + 1;
		});
	}

	/** A follow-up to an agent past its context cap, or cleaned, that Storm sent back to a fresh agent. */
	noteBlockedFollowUp(): void {
		this.#update(record => {
			record.blockedFollowUps = (record.blockedFollowUps ?? 0) + 1;
		});
	}

	#reads(record: RunRecord): NonNullable<RunRecord["reads"]> {
		record.reads ??= { director: 0, directorChars: 0, duplicateChars: 0, blocked: 0 };
		return record.reads;
	}

	/** A director `read` of a working file returned `chars` characters; `duplicate` when a subagent of the run read that file too. */
	noteRead(chars: number, duplicate: boolean): void {
		this.#update(record => {
			const reads = this.#reads(record);
			reads.director += 1;
			reads.directorChars += chars;
			if (duplicate) reads.duplicateChars += chars;
		});
	}

	/** A director `read` Storm refused. */
	noteBlockedRead(): void {
		this.#update(record => {
			this.#reads(record).blocked += 1;
		});
	}

	/** Prompt size of a director request; the run keeps the largest. */
	noteMainContext(promptTokens: number): void {
		if (promptTokens <= (this.#own?.record.maxMainContext ?? 0)) return;
		this.#update(record => {
			record.maxMainContext = promptTokens;
		});
	}

	/** Whether this session's run is the automatic probe opened inside its live turn. */
	autoRun(): boolean {
		return this.#own?.auto === true;
	}

	/**
	 * Starts one background director checkpoint only for an automatic run. Manual runs reach the same handoff path
	 * at their async wait, so a wait tool during manual direction changes nothing.
	 */
	startAutoCheckpoint(): boolean {
		return this.autoRun() ? this.startCheckpoint() : false;
	}

	/**
	 * Starts one background director checkpoint when this run's context is at its cap and none is in flight.
	 * omp prepares a handoff summary without interrupting the live turn and commits it at the next natural
	 * boundary (a continuing tool loop's turn end, or idle); this returns at once and never awaits that commit,
	 * so a caller inside a tool call or an event handler cannot deadlock. Only a commit that reported completion
	 * is recorded; a host rejection is remembered in memory and holds off the next try for the same min gap.
	 * A request already oversized when the prompt arrived has been sent by then: this restores later requests only.
	 */
	startCheckpoint(): boolean {
		const own = this.#own;
		// A stopping run starts no new summary while its owned work drains.
		if (own === undefined || own.ending !== undefined || own.abort.signal.aborted) return false;
		const usage = own.ctx.getContextUsage();
		if (usage === undefined) return false;
		const now = this.deps.now();
		const before = usage.tokens;
		const last = own.record.checkpoints?.at(-1);
		const lastAt = last === undefined ? undefined : Date.parse(last.at);
		const cap = directorCap(own.config, usage.contextWindow);
		if (
			!shouldCheckpoint({
				tokens: usage.tokens,
				cap,
				now,
				...(lastAt !== undefined && Number.isFinite(lastAt) ? { lastAt } : {}),
				...(own.checkpointRejectedAt !== undefined ? { lastRejectedAt: own.checkpointRejectedAt } : {}),
				...(own.checkpoint !== undefined ? { inFlight: true } : {}),
			})
		) {
			return false;
		}
		const attempt = { controller: new AbortController(), applied: false };
		own.checkpoint = attempt;
		// Capture the ledger now: it is what the handoff summary must keep, not the context it replaces.
		const guidance = checkpointGuidance(own.record, this.deps.agents?.(own.record.runId, own.sessionDir) ?? []);
		const settle = (completed: boolean): void => {
			// A stopped, switched or replaced run owns nothing: its late result must not mark the next run.
			if (this.#own !== own || own.checkpoint !== attempt) return;
			delete own.checkpoint;
			// A cancel is not a host rejection: it says nothing about the next run's host.
			if (attempt.controller.signal.aborted) return;
			if (!completed || !attempt.applied) {
				own.checkpointRejectedAt = this.deps.now();
				return;
			}
			delete own.checkpointRejectedAt;
			const after = own.ctx.getContextUsage()?.tokens;
			const checkpoint: RunCheckpoint = {
				at: iso(this.deps.now()),
				before,
				...(after !== undefined ? { after } : {}),
			};
			own.record.checkpoints = [...(own.record.checkpoints ?? []), checkpoint];
			this.#scheduleFlush(own);
		};
		try {
			void Promise.resolve(
				own.ctx.compact({
					mode: "handoff",
					internalGuidance: guidance,
					signal: attempt.controller.signal,
					onComplete: () => {
						attempt.applied = true;
					},
				}),
			).then(
				() => settle(true),
				() => settle(false),
			);
		} catch {
			settle(false);
			return false;
		}
		return true;
	}

	/** The approved config this session's run started under. */
	runConfig(ctx?: ExtensionContext): StormConfig | undefined {
		const own = this.#own;
		if (own === undefined) return undefined;
		if (ctx !== undefined && closeoutSessionId(ctx) !== own.sessionId) return undefined;
		return own.config;
	}

	/**
	 * Proves this session's run may write the target before an effect the controller does not perform itself (a
	 * follow-up that can write, a shell-capable spawn). The caller must not perform the effect when this refuses.
	 */
	async ensureWrite(ctx?: ExtensionContext): Promise<{ ok: true } | { ok: false; reason: string }> {
		const own = this.#own;
		if (own === undefined) return { ok: false, reason: "진행 중인 Storm 실행이 없어 쓰기 권한을 확인하지 못했습니다." };
		if (ctx !== undefined && closeoutSessionId(ctx) !== own.sessionId) {
			return { ok: false, reason: "다른 세션이 시작한 실행의 쓰기 권한은 빌려올 수 없습니다." };
		}
		return this.#upgradeLease(own);
	}

	/**
	 * From the storm tool's plan action: the plan this session's run spawns under, visible to every session. The
	 * caller's native session must be the one directing the run, and a write-capable plan upgrades the target claim
	 * before it becomes authority for any spawn.
	 */
	async setPlan(ctx: ExtensionContext, plan: RunPlan): Promise<{ ok: true } | { ok: false; reason: string }> {
		const own = this.#own;
		if (!own) return { ok: false, reason: "진행 중인 Storm 실행이 없어 계획을 저장하지 않았습니다." };
		if (closeoutSessionId(ctx) !== own.sessionId) {
			return { ok: false, reason: "다른 세션이 시작한 실행에는 계획을 적용할 수 없습니다." };
		}
		// A lane keeps the identity its evidence is bound to: goal, kind, role and files. A status update belongs in
		// progress; renaming a changed lane is the only way to start its evidence over. Reject before touching the plan
		// in force or the record, so a refused replan leaves both exactly as they were. The run's own row identities are
		// checked too: a requirement that has moved or lost its lane cannot be rewritten by a later plan reusing its id.
		const weakened = requirementConflict(own.record.results, plan);
		if (weakened !== undefined) return { ok: false, reason: weakened };
		const conflict = replanConflict(own.record.plan, plan);
		if (conflict !== undefined) return { ok: false, reason: conflict };
		if (planNeedsWrite(plan)) {
			const upgraded = await this.#upgradeLease(own);
			if (!upgraded.ok) return upgraded;
			if (this.#own !== own) return { ok: false, reason: "실행이 바뀌어 계획을 적용하지 않았습니다." };
		}
		// A stopping run blocks new spawns; its plan is no longer authority for them.
		if (!setLedgerPlan(own.record.runId, plan)) {
			return { ok: false, reason: "실행이 끝나는 중이라 계획을 적용하지 않았습니다." };
		}
		own.record.plan = plan;
		// Required results are obligations, not plan text: adding a lane seeds pending rows, and a removed lane keeps
		// every requirement it still owed.
		this.#syncResults(own);
		this.#scheduleFlush(own);
		return { ok: true };
	}

	/**
	 * Stages the director's closeout brief for this session's run. It is presentation data only: no status, review,
	 * stop or start is touched and no transcript record is written here. A later valid submission replaces it; the
	 * final record keeps exactly the last one.
	 */
	submitCloseout(ctx: ExtensionContext, draft: CloseoutDraft): { ok: true } | { ok: false; reason: string } {
		const own = this.#own;
		if (!own) return { ok: false, reason: "진행 중인 Storm 실행이 없어 결과 브리프를 저장하지 않았습니다." };
		if (closeoutSessionId(ctx) !== own.sessionId) {
			return { ok: false, reason: "다른 세션이 시작한 실행에는 결과 브리프를 저장할 수 없습니다." };
		}
		const parsed = parseCloseout(draft);
		if (parsed === undefined) {
			return {
				ok: false,
				reason: "결과 브리프가 올바르지 않습니다. 결과·검증은 비어 있지 않은 한 줄, next는 서로 다른 세 방향이어야 합니다.",
			};
		}
		own.closeout = parsed;
		return { ok: true };
	}

	/**
	 * The main session's agent loop ended. A `willContinue` end is no round: omp itself resumes the loop, and a paused
	 * run that only async work resumes waits for one. When it settled (no automatic continuation, no background work
	 * that will resume it) a round of the run is over and the round rules decide what follows; and a queued run
	 * starts, detached from this handler, unless the user interrupted the turn that queued it.
	 */
	async onAgentEnd(
		event: { willContinue?: boolean; awaitingAsyncWork?: boolean; messages?: readonly unknown[] },
		ctx: ExtensionContext,
	): Promise<void> {
		const own = this.#own;
		if (event.awaitingAsyncWork) {
			// Only a new turn resumes this run, so a terminal end with no turn in between stopped the wait.
			if (own) {
				own.awaitingAsync = true;
				this.#emitPhase(own);
			}
			return;
		}
		if (event.willContinue) return;
		// Esc while paused on async work ends the run without an aborted message and without a new agent_start.
		const stoppedWait = own?.awaitingAsync === true;
		if (own) {
			own.awaitingAsync = false;
			// A settled turn cannot still be waiting on one of that turn's dialogs.
			this.#clearUserWaits(own);
		}
		if (own?.turnStarted) await this.#turnSettled(own, ctx, stoppedWait || turnAborted(event.messages));
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		if (turnAborted(event.messages)) {
			this.deps.ui(ctx).notify(`응답을 중단해서 예약한 Storm 실행(${pending.runId})을 시작하지 않았습니다.`);
			return;
		}
		this.launch(ctx, pending.spec, pending.runId);
	}

	/**
	 * A turn of the run settled: the reason decided during the turn stands, otherwise the round rules decide whether
	 * another round follows.
	 */
	async #turnSettled(own: OwnRun, ctx: ExtensionContext, aborted: boolean): Promise<void> {
		if (own.inTurn) {
			own.inTurn = false;
			// A user clarification/activity turn is a turn but not another verification round: only a round Storm
			// scheduled (or the initial handoff) consumes the budget.
			if (own.roundInFlight !== undefined) {
				own.record.turns = Math.max(own.record.turns ?? 0, own.roundInFlight);
				delete own.roundInFlight;
				this.#scheduleFlush(own);
			}
		}
		if (own.awaitingRound !== undefined) delete own.awaitingRound;
		if (own.ending !== undefined) return this.#stop(own, own.ending, ctx);
		await this.#decide(own, ctx, aborted);
	}

	/**
	 * The decision after a settled round: the run ends here, or the next round waits out the delay. Inside this
	 * handler omp is still closing the turn, so nothing is sent from it.
	 */
	async #decide(own: OwnRun, ctx: ExtensionContext, aborted: boolean): Promise<void> {
		const turns = own.record.turns ?? 0;
		// The turn settled: the live line moves to the round decision before any tree read or check starts.
		this.#emitPhase(own);
		const decision = await this.#roundDecision(own, aborted, false);
		// The tree read may have outlasted the round: a new turn or an end decided meanwhile owns the run now.
		if (!this.#live(own, turns)) return;
		if (decision.action === "end") {
			// A ready required check is verification, not another model round. Give it one timer look before a budget
			// end, so a last-round review can still be proven or honestly fail.
			if ((decision.reason === "round-limit" || decision.reason === "no-progress") && (await this.#hasPendingCheck(own))) {
				if (!this.#live(own, turns)) return;
				own.checksOnlyEnd = decision.reason;
				this.#arm(own, ctx, ROUND_DELAY_MS);
				return;
			}
			return this.#stop(own, decision.reason, ctx);
		}
		this.#arm(own, ctx, ROUND_DELAY_MS);
	}

	/**
	 * Whether a required check is ready to run for this tree and could still change the gate. It is not a review,
	 * another model round, or a reason to replay a check already attempted for this tree.
	 */
	async #hasPendingCheck(own: OwnRun): Promise<boolean> {
		if ((own.config.requiredChecks?.length ?? 0) === 0) return false;
		if (own.ending !== undefined || own.abort.signal.aborted) return false;
		const now = await this.#treeAt(own.root, own.base);
		if (now === undefined) return false;
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const planLanes = this.#planLanes(own, agents);
		if (planLanes?.some(lane => lane.state !== "done")) return false;
		const fingerprint = treeFingerprint(now.state);
		if (own.checking !== undefined || own.checks.has(fingerprint)) return false;
		const gate = reviewGate(
			agents,
			own.config,
			{
				...(own.tree !== undefined ? { start: own.tree } : {}),
				now: now.state,
				...(own.rereviewedAt !== undefined ? { rereviewedAt: own.rereviewedAt } : {}),
			},
			this.#coverage(own, undefined, planLanes),
		);
		return gate.state === "unverified" && gate.cause === "coverage";
	}

	/** Whether `own` is still what the decision was taken from: this session's run, the same round, and not already ending. */
	#live(own: OwnRun, turns: number): boolean {
		return this.#own === own && !own.inTurn && own.ending === undefined && (own.record.turns ?? 0) === turns;
	}

	/** The round's decision from the tree now and the gate as the ledger has it after that. */
	async #roundDecision(own: OwnRun, aborted: boolean, allowChecks: boolean): Promise<RoundDecision> {
		let now = await this.#treeAt(own.root, own.base);
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const planLanes = this.#planLanes(own, agents);
		const tree = {
			...(own.tree !== undefined ? { start: own.tree } : {}),
			...(now !== undefined ? { now: now.state } : {}),
			...(own.rereviewedAt !== undefined ? { rereviewedAt: own.rereviewedAt } : {}),
		};
		// The pure gate already knows empty coverage (no checks, no lanes) from the start. Checks run only from the
		// look timer, never inside omp's agent_end handler: they may take far longer than its budget.
		const initial = this.#coverage(own, undefined, planLanes);
		initial.checks = [];
		const baseGate = reviewGate(agents, own.config, tree, initial);
		// A required result that names an approved check may need that check to decide it. The check runner normally
		// starts only when the gate is otherwise check-ready; a deferred row is exactly that case, and leaving it as
		// `results` would stop the runner from ever supplying the evidence the row waits for.
		const checkable =
			this.#hasDeferredCheck(own) && baseGate.state === "unverified" && baseGate.cause !== "lanes"
				? ({ ...baseGate, cause: "coverage" } as Gate)
				: baseGate;
		if (allowChecks && !aborted) now = await this.#maybeRunChecks(own, checkable, now, planLanes);
		// Bind any check evidence that arrived after settlement, then the reviewer's current-tree proof, before the gate
		// reads rows: a reviewable submission becomes accepted here, never by the round rules guessing.
		await this.#refreshCheckedResults(own);
		this.#refreshResultReviews(own, agents, now?.state);
		const currentTree = {
			...(tree.start !== undefined ? { start: tree.start } : {}),
			...(now !== undefined ? { now: now.state } : {}),
			...(tree.rereviewedAt !== undefined ? { rereviewedAt: tree.rereviewedAt } : {}),
		};
		const coverage = this.#coverage(own, now?.state, planLanes);
		const gate = reviewGate(agents, own.config, currentTree, coverage);
		return decideRound({
			gate,
			turns: own.record.turns ?? 0,
			maxRounds: own.maxRounds,
			aborted,
			overBudget: getLedgerRun(own.record.runId)?.exceeded ?? false,
			elapsedMs: this.deps.now() - Date.parse(own.record.startedAt),
			...(own.minutes !== undefined ? { minutes: own.minutes } : {}),
			...(own.progress ? { progressSince: own.progress } : {}),
		});
	}

	/** Plan lanes as coverage evidence: a settled worker is not done while a declared row is pending or unmet. */
	#planLanes(own: OwnRun, agents: readonly AgentEntry[]): CoverageLane[] | undefined {
		const plan = own.record.plan;
		if (plan === undefined) return undefined;
		const remaining = new Set(own.lanes.remaining(plan, agents, this.#failedIds(own, agents)));
		for (const row of own.record.results ?? []) {
			if (row.lane !== undefined && (row.state === "pending" || row.state === "unmet")) remaining.add(row.lane);
		}
		return plan.lanes.map(lane => ({ name: lane.name, state: remaining.has(lane.name) ? "pending" : "done" }));
	}

	/** The latest native task outcome also catches admission and merge failures outside a child's agent loop. */
	#failedIds(own: OwnRun, agents: readonly AgentEntry[]): ReadonlySet<string> {
		const failed = new Set<string>();
		const snapshot = this.#asyncSnapshot(own.ctx);
		if (!snapshot) return failed;
		const bound = new Set(agents.map(agent => agent.id));
		for (const spawn of spawnsByRun.get(own.record.runId) ?? []) if (spawn.spawnKey !== undefined) bound.add(spawn.spawnKey);
		const latest = new Map<string, (typeof snapshot.recent)[number]>();
		for (const job of snapshot.recent) {
			if (job.agentId === undefined || !bound.has(job.agentId)) continue;
			const other = latest.get(job.agentId);
			if (other === undefined || (job.endTime ?? job.startTime) > (other.endTime ?? other.startTime)) latest.set(job.agentId, job);
		}
		for (const [id, job] of latest) {
			if (job.status === "failed" || job.status === "cancelled") failed.add(id);
		}
		return failed;
	}

	#asyncSnapshot(ctx: ExtensionContext) {
		try {
			return ctx.getAsyncJobSnapshot?.();
		} catch {
			return undefined;
		}
	}

	/**
	 * The latest spawn event for one lane: an exact lane/spawnKey match by the lane's configured agent, or that agent's
	 * sole same-role lane when the host key names no lane. A spawn owned by another role leaves it undefined even when
	 * its key equals the lane name, and a same-role sibling leaves it undefined rather than guessing which requirement
	 * the refusal belongs to.
	 */
	#configRefusal(own: OwnRun, laneName: string): { reason?: string } | undefined {
		const plan = own.record.plan;
		const lane = plan?.lanes.find(candidate => candidate.name === laneName);
		if (plan === undefined || lane === undefined || (lane.results?.length ?? 0) === 0) return undefined;
		const agent = own.config.roles[lane.role]?.agent;
		const siblings = plan.lanes.filter(candidate => candidate.role === lane.role);
		const spawns = spawnsByRun.get(own.record.runId) ?? [];
		let latest: SpawnRecord | undefined;
		for (const spawn of spawns) {
			// A host key can collide with a lane name while another role owns the spawn. Only the lane's configured
			// agent attributes a role-specific refusal; without one, the spawn's own role must match.
			const mine = agent === undefined ? spawn.role === lane.role : spawn.agent === agent;
			if (!mine) continue;
			const exact = spawn.lane === laneName || spawn.spawnKey === laneName;
			const bySoleRole = !exact && spawn.lane === undefined && siblings.length === 1;
			if (exact || bySoleRole) latest = spawn;
		}
		if (latest?.outcome !== "blocked" || latest.code === undefined || CONFIG_REFUSAL_CODES[latest.code] !== true) return undefined;
		const reason = typeof latest.reason === "string" ? configRefusalReason(latest.reason) : "";
		return reason === "" ? {} : { reason };
	}

	/**
	 * A pending result whose lane could not start for team-config/auth reasons says so with the refusal's own unblock
	 * text. The state is derived from the latest spawn event, so a later admitted spawn clears it; no path is guessed.
	 */
	#syncConfigRefusals(own: OwnRun): boolean {
		this.#syncResults(own);
		const rows = own.record.results ?? [];
		let changed = false;
		for (const row of rows) {
			if (row.state !== "pending" || row.lane === undefined) continue;
			const refusal = this.#configRefusal(own, row.lane);
			if (refusal === undefined) {
				if (row.remedy === "blocked") {
					delete row.remedy;
					delete row.unblock;
					changed = true;
				}
				continue;
			}
			if (row.remedy !== undefined && row.remedy !== "blocked") continue;
			if (row.remedy === "blocked" && row.unblock === refusal.reason) continue;
			row.remedy = "blocked";
			if (refusal.reason === undefined) delete row.unblock;
			else row.unblock = refusal.reason;
			changed = true;
		}
		if (changed) this.#scheduleFlush(own);
		return changed;
	}

	/**
	 * The official rows as coverage facts. Plan text is never proof: kind and the producer edge come from the plan,
	 * while state, attempt, content version and the consumed producer versions come only from the run ledger. A
	 * consumer whose producer is not current names that producer; once the new version is accepted, the direction is
	 * the consumer's own re-check, so `blockedBy` is absent. The witness carries both the consumed and current producer
	 * versions: replacing B while A still consumed v1 is real progress, not an identical failure to stop on.
	 */
	#coverageResults(own: OwnRun): CoverageResult[] {
		this.#syncConfigRefusals(own);
		const rows = own.record.results ?? [];
		if (rows.length === 0) return [];
		const byId = new Map(rows.map(row => [row.id, row]));
		const lanes = own.record.plan?.lanes ?? [];
		const laneByName = new Map(lanes.map(lane => [lane.name, lane]));
		const planned = new Map<string, PlanLaneResult>();
		const resultLane = new Map<string, string>();
		const needsAccepted = new Map<string, boolean>();
		for (const lane of lanes) {
			for (const result of lane.results ?? []) {
				planned.set(result.id, result);
				resultLane.set(result.id, lane.name);
			}
		}
		for (const lane of lanes) {
			for (const dependency of lane.dependsOn ?? []) {
				for (const result of laneByName.get(dependency.lane)?.results ?? []) {
					needsAccepted.set(result.id, (needsAccepted.get(result.id) ?? false) || dependency.need !== "reviewable");
				}
			}
		}
		const out: CoverageResult[] = [];
		for (const row of rows) {
			const result = planned.get(row.id);
			const candidates: { id: string; accepted: boolean }[] = [];
			if ((row.consumed ?? []).length > 0) {
				for (const input of row.consumed ?? []) candidates.push({ id: input.id, accepted: needsAccepted.get(input.id) ?? true });
			} else if (row.lane !== undefined) {
				for (const dependency of laneByName.get(row.lane)?.dependsOn ?? []) {
					for (const required of laneByName.get(dependency.lane)?.results ?? []) {
						candidates.push({ id: required.id, accepted: dependency.need !== "reviewable" });
					}
				}
			}
			let blockedBy: string | undefined;
			if (row.state !== "accepted") {
				for (const candidate of candidates) {
					const producer = byId.get(candidate.id);
					const current = producer !== undefined &&
						(producer.state === "accepted" || (!candidate.accepted && producer.state === "reviewable"));
					if (current) continue;
					blockedBy = resultLane.get(candidate.id);
					if (blockedBy !== undefined) break;
				}
			}
			const consumedRefs = (row.consumed ?? []).map(input => `${input.id}@${input.version.slice(0, 8)}`);
			const currentRefs = [...new Set(candidates.map(candidate => `${candidate.id}@${currentInputVersion(byId.get(candidate.id)).slice(0, 8)}`))];
			const baseEvidence = consumedRefs.length > 0
				? `${consumedRefs.join(",")}>${currentRefs.join(",")}`
				: currentRefs.length > 0
					? currentRefs.join(",")
					: row.contentVersion?.slice(0, 12);
			const route = row.remedy === "retry" && row.retryRoute !== undefined ? `retry:${row.retryRoute}` : undefined;
			const evidence = route === undefined
				? baseEvidence
				: baseEvidence === undefined || baseEvidence === "" ? route : `${route}|${baseEvidence}`;
			// A requirement whose lane left the plan is still owed, but nothing in the team can run or review it. Name
			// the one action that can clear it instead of the old lane's work or a review the planned tree cannot bind.
			const orphan = row.state !== "accepted" && row.lane === undefined && result === undefined;
			out.push({
				id: row.id,
				state: row.state,
				...(row.lane === undefined ? {} : { lane: row.lane }),
				...(row.reason === undefined ? {} : { reason: row.reason }),
				...(result === undefined ? {} : { kind: result.kind }),
				...(row.attemptId === undefined || !ATTEMPT_REF.test(row.attemptId) ? {} : { attempt: row.attemptId }),
				...(blockedBy === undefined ? {} : { blockedBy }),
				...(orphan
					? { remedy: "replan" as const }
					: row.remedy === undefined
						? blockedBy === undefined ? {} : { remedy: "producer" as const }
						: { remedy: row.remedy }),
				...(row.unblock === undefined ? {} : { unblock: row.unblock }),
				...(row.state === "reviewable" && (orphan || (result !== undefined && result.kind !== "change")) ? { judgeable: false } : {}),
				...(evidence === undefined || evidence === "" ? {} : { evidence }),
			});
		}
		return out;
	}

	/** The evidence the gate may use for this exact tree; a missing or stale report stays missing, never a pass. */
	#coverage(own: OwnRun, tree: TreeState | undefined, planLanes: CoverageLane[] | undefined): CoverageInput {
		const coverage: CoverageInput = { checks: [], lanes: planLanes ?? [] };
		const results = this.#coverageResults(own);
		if (results.length > 0) coverage.results = results;
		// A reviewable row without an approved reviewer is a blocker, not an endless round.
		coverage.reviewer = usableRole(own.config, "reviewer") !== undefined;
		const required = own.config.requiredChecks?.map(check => check.name) ?? [];
		if (required.length) coverage.requiredChecks = required;
		if (tree === undefined) return coverage;
		const fingerprint = treeFingerprint(tree);
		coverage.fingerprint = fingerprint;
		const cached = own.checks.get(fingerprint);
		const report = cached === "skipped" ? undefined : cached;
		if (report !== undefined && report.configHash === own.record.configHash) {
			const checks: CoverageCheck[] = report.checks.map(check => ({
				name: check.name,
				status: check.status,
				tree: report.fingerprint,
				...(check.finishedAt !== null ? { finishedAt: check.finishedAt } : {}),
			}));
			coverage.checks = checks;
			coverage.complete = report.complete;
			coverage.aborted = report.aborted;
		} else if (required.length) {
			coverage.checks = [];
			coverage.complete = false;
		}
		return coverage;
	}

	/**
	 * Runs the approved required checks once for this tree when a passing gate is otherwise possible. It never runs
	 * for no-change/readonly work, an unapproved or changed config, or a run already stopping. A tree that moves while
	 * checks run is reported as lacking evidence now and evaluated once on the next look.
	 */
	async #maybeRunChecks(
		own: OwnRun,
		base: Gate,
		now: TreeReading | undefined,
		planLanes: CoverageLane[] | undefined,
	): Promise<TreeReading | undefined> {
		if (now === undefined || (own.config.requiredChecks?.length ?? 0) === 0) return now;
		// A check-ready state is not only no-proof: a quick-only change or a review whose check evidence is still
		// missing also needs the runner before it can be a pass or a quick-only end.
		if (base.state !== "unverified") return now;
		if (base.cause !== "no-proof" && base.cause !== "coverage") return now;
		if (own.ending !== undefined || own.abort.signal.aborted) return now;
		if (planLanes?.some(lane => lane.state !== "done")) return now;
		const fingerprint = treeFingerprint(now.state);
		if (own.checking !== undefined || own.checks.has(fingerprint)) return now;
		own.checking = fingerprint;
		try {
			const state = await this.deps.loadState(own.ctx).catch(() => undefined);
			if (this.#own !== own || own.ending !== undefined || own.abort.signal.aborted) return now;
			// A changed hash or a withdrawal of approval is not permission to run the run's old checks. Neither is a
			// session manager that now names another session or target: the captured owner alone authorizes commands.
			if (
				state === undefined ||
				state.config.status !== "ok" ||
				state.sessionDir !== own.sessionDir ||
				state.repo.repoId !== own.repoId ||
				state.repo.root !== own.root ||
				closeoutSessionId(own.ctx) !== own.sessionId
			) {
				own.checks.set(fingerprint, "skipped");
				return now;
			}
			const currentGate = teamGate(state);
			if (!currentGate.ok || currentGate.hash !== own.record.configHash || !isApproved(state)) {
				own.checks.set(fingerprint, "skipped");
				return now;
			}
			// Checks run commands in the target: the write claim must already be held before the first one starts.
			const upgraded = await this.#upgradeLease(own);
			if (!upgraded.ok) {
				own.checks.set(fingerprint, "skipped");
				this.#stopSoon(own, "interrupted", own.ctx);
				return now;
			}
			if (this.#own !== own) return now;
			// Verification begins only with the actual runner: preparing or loading state is not "verifying".
			own.checksRunning = true;
			this.#emitPhase(own);
			let report: RequiredChecksResult;
			try {
				report = await runRequiredChecks({
					config: state.config,
					approval: currentGate.approval,
					cwd: own.root,
					fingerprint,
					signal: own.abort.signal,
				});
			} finally {
				delete own.checksRunning;
				this.#emitPhase(own);
			}
			if (this.#own !== own) return now;
			if (report.status === "skipped") {
				own.checks.set(fingerprint, "skipped");
				return now;
			}
			own.checks.set(fingerprint, report);
			own.checkEvidence = report.checks.map(check => ({
				name: check.name,
				status: check.status,
				exitCode: check.exitCode,
				tree: report.fingerprint,
			}));
			this.#scheduleFlush(own);
			if (report.aborted) return now;
			// The tree may have moved while checks ran. Return the fresh read, including undefined when it cannot be
			// read: binding this report to an unknown tree is never allowed.
			return await this.#treeAt(own.root, own.base);
		} finally {
			if (own.checking === fingerprint) delete own.checking;
		}
	}

	/** The work tree at `root` against `base`, or no tree when the host has none or the read fails. */
	async #treeAt(root: string, base?: string): Promise<TreeReading | undefined> {
		try {
			return await this.deps.tree?.(root, base);
		} catch {
			return undefined;
		}
	}

	/**
	 * The look after a wait, taken from fresh gate data: ends the run, waits out a held session, or sends the next
	 * round. The only place a round message is sent from.
	 */
	async #look(own: OwnRun, ctx: ExtensionContext): Promise<void> {
		// A held session is no round, and a tree read is two git processes: wait out the hold before deciding.
		if (this.#held(ctx)) return this.#arm(own, ctx, HOLD_MS);
		const turns = own.record.turns ?? 0;
		const checkOnly = own.checksOnlyEnd;
		const decision = await this.#roundDecision(own, false, true);
		if (!this.#live(own, turns)) return;
		if (checkOnly !== undefined) {
			delete own.checksOnlyEnd;
			// Verification-only: the check outcome may end verified, or the original budget end stands. Never send a
			// model round from here, and never schedule a second look for the same tree.
			if (decision.action === "end") return this.#stop(own, decision.reason, ctx);
			return this.#stop(own, checkOnly, ctx);
		}
		if (decision.action === "end") return this.#stop(own, decision.reason, ctx);
		this.#sendRound(own, ctx, decision.gate, decision.round);
	}

	/**
	 * Whether omp is holding the next turn on purpose: the session is streaming, has a submission queued, plan mode is
	 * on, or the user has a draft in the editor. `isIdle` only means "not streaming", so a send during a compaction
	 * would also wait inside omp's `prompt()`. A held round is not a round.
	 */
	#held(ctx: ExtensionContext): boolean {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
		if (ctx.sessionModes?.getState().plan.status === "active") return true;
		return ctx.hasUI && ctx.ui.getEditorText().trim() !== "";
	}

	/** Looks again after `ms`, as long as the run, the session state and the end decided so far still allow it. */
	#arm(own: OwnRun, ctx: ExtensionContext, ms: number): void {
		this.#disarm(own);
		own.hold = (this.deps.timers ?? REAL_TIMERS).set(() => {
			delete own.hold;
			if (this.#own !== own || own.inTurn || own.ending !== undefined) return;
			void this.#look(own, ctx).catch((error: unknown) =>
				this.deps.ui(ctx).notify(`Storm 실행을 이어가지 못했습니다: ${errorText(error)}`, "error"),
			);
		}, ms);
		// A scheduled look is a round wait, not a question to the user.
		this.#emitPhase(own);
	}

	#disarm(own: OwnRun): void {
		if (own.hold === undefined) return;
		(this.deps.timers ?? REAL_TIMERS).clear(own.hold);
		delete own.hold;
	}

	/** Ends the run from a timer or a rejected send: a failure to record it is reported, not left unhandled. */
	#stopSoon(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext): void {
		void this.#stop(own, reason, ctx).catch((error: unknown) =>
			this.deps.ui(ctx).notify(`Storm 실행을 끝내지 못했습니다: ${errorText(error)}`, "error"),
		);
	}

	/**
	 * Starts round `round`: remembers what the gate saw, says so, and hands the main session the round's message.
	 * omp resolves `sendUserMessage` only when the turn it starts is over, so nothing here waits on it.
	 */
	#sendRound(own: OwnRun, ctx: ExtensionContext, gate: RoundGate, round: number): void {
		if (own.ending !== undefined || this.#own !== own) return;
		const ui = this.deps.ui(ctx);
		// A plain/review round may intervene between two result gates. Keep the last witness so the next result gate does
		// not look like a brand-new obligation forever; a genuinely changed witness still counts once.
		const witness = gate.resultProgress ?? own.progress?.result;
		own.progress = {
			changes: gate.changes,
			reviews: gate.reviews,
			requests: gate.requests,
			...(witness === undefined ? {} : { result: witness }),
		};
		// Only a review repair needs a reviewer name; a lane or check repair round has no review to request.
		const reviewer = usableRole(own.config, "reviewer")?.agent;
		// Tree-only staleness is asked about once: a verdict given from now on is honoured whatever the tree does.
		if (gate.by === "tree" && own.rereviewedAt === undefined) own.rereviewedAt = this.deps.now();
		ui.notify(`검증되지 않은 변경이 있어 ${round}라운드를 시작합니다(최대 ${own.maxRounds}라운드).`);
		this.#liveStatus(ctx, this.active());
		own.awaitingRound = round;
		this.#emitPhase(own);
		this.deps.pi.sendUserMessage(
			buildRoundMessage({ runId: own.record.runId, round, maxRounds: own.maxRounds, gate, ...(reviewer !== undefined ? { reviewer } : {}) }),
		).catch((error: unknown) => {
			// No turn started from this message: a later user turn must not be mistaken for the scheduled round.
			if (own.awaitingRound === round) delete own.awaitingRound;
			// The user interrupted the prompt's setup: no round started, so nothing about it is unverified progress.
			if (promptDropped(error)) {
				this.#stopSoon(own, "interrupted", ctx);
				return;
			}
			ui.notify(`라운드 메시지를 보내지 못했습니다: ${errorText(error)}`, "warning");
			this.#stopSoon(own, "no-progress", ctx);
		});
	}

	/** Ends `own` for `reason` unless an earlier reason stands; a run that is no longer this session's is left alone. */
	async #stop(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext): Promise<void> {
		if (this.#own !== own) return;
		own.ending ??= reason;
		await this.finish(own.ending, ctx);
	}

	/** Ends this session's run (if any), writes its record and reports the summary. */
	async finish(reason: RunEndReason, ctx?: ExtensionContext): Promise<RunRecord | undefined> {
		// A queued run belongs to the session that shut down or switched; the next one starts clean.
		if (reason === "shutdown") this.#pending = undefined;
		const running = this.#finishing;
		if (running !== undefined) return running;
		// A start still awaiting must not continue in the session this run belonged to.
		this.#generation += 1;
		const own = this.#own;
		if (!own) return undefined;
		own.ending ??= reason;
		if (ctx !== undefined) own.finishCtx ??= ctx;
		own.abort.abort();
		// A background checkpoint belongs to this run: cancel it before the run leaves; a late commit cannot mark another.
		own.checkpoint?.controller.abort();
		delete own.checkpoint;
		this.#disarm(own);
		// A stopping run is no longer waiting on a dialog: the host either answered it or dropped it.
		this.#clearUserWaits(own);
		this.#emitPhase(own);
		const ledger = getLedgerRun(own.record.runId);
		if (ledger) ledger.closing = true;
		// Never throw away scope, lease or accounting while owned work is alive. The stopped run keeps them and a
		// detached timer rechecks; a shutdown handler therefore returns without waiting for the work.
		if (this.#hasLiveWork(own)) {
			this.#deferFinalize(own);
			return undefined;
		}
		const task = (async () => {
			let finalReason = own.ending ?? reason;
			if (finalReason === "verified" && own.drained === true) finalReason = await this.#recheckVerified(own);
			return this.#finalize(own, finalReason, own.finishCtx);
		})();
		this.#finishing = task;
		try {
			return await task;
		} finally {
			if (this.#finishing === task) this.#finishing = undefined;
		}
	}

	/** Schedules the next look at this stopping run's owned work; the timer never holds the caller. */
	#deferFinalize(own: OwnRun): void {
		if (own.drainTimer !== undefined) return;
		own.drained = true;
		const polls = (own.drainPolls ?? 0) + 1;
		own.drainPolls = polls;
		if (!own.drainWarned && polls * DRAIN_POLL_MS > DRAIN_MAX_MS) {
			own.drainWarned = true;
			const ctx = own.finishCtx;
			if (ctx) {
				this.deps.ui(ctx).notify(
					"Storm 실행이 소유한 작업이 제한 시간 안에 끝나지 않습니다. 실행 범위·잠금·회계를 유지한 채 작업이 끝날 때까지 기다립니다.",
					"warning",
				);
			}
		}
		const timers = this.deps.timers ?? REAL_TIMERS;
		own.drainTimer = timers.set(() => {
			delete own.drainTimer;
			if (this.#own !== own) return;
			if (this.#hasLiveWork(own)) {
				this.#deferFinalize(own);
				return;
			}
			void this.#finishDeferred(own).catch((error: unknown) => {
				const ctx = own.finishCtx;
				if (ctx) this.deps.ui(ctx).notify(`Storm 실행을 끝내지 못했습니다: ${errorText(error)}`, "error");
			});
		}, DRAIN_POLL_MS);
	}

	/** Finalizes a drained run once its owned work has settled; shares the one-finalization guard. */
	async #finishDeferred(own: OwnRun): Promise<RunRecord | undefined> {
		const running = this.#finishing;
		if (running !== undefined) return running;
		if (this.#own !== own) return undefined;
		const task = (async () => {
			let finalReason = own.ending ?? "no-progress";
			if (finalReason === "verified" && own.drained === true) finalReason = await this.#recheckVerified(own);
			return this.#finalize(own, finalReason, own.finishCtx);
		})();
		this.#finishing = task;
		try {
			return await task;
		} finally {
			if (this.#finishing === task) this.#finishing = undefined;
		}
	}

	/**
	 * A would-be verified run that drained rechecks the current tree and proof before keeping that label. A verdict or
	 * check bound to the pre-drain tree is not replayed as authority for the tree that remains.
	 */
	async #recheckVerified(own: OwnRun): Promise<RunEndReason> {
		const now = await this.#treeAt(own.root, own.base);
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const planLanes = this.#planLanes(own, agents);
		await this.#refreshCheckedResults(own);
		this.#refreshResultReviews(own, agents, now?.state);
		const coverage = this.#coverage(own, now?.state, planLanes);
		const gate = reviewGate(
			agents,
			own.config,
			{
				...(own.tree !== undefined ? { start: own.tree } : {}),
				...(now !== undefined ? { now: now.state } : {}),
				...(own.rereviewedAt !== undefined ? { rereviewedAt: own.rereviewedAt } : {}),
			},
			coverage,
		);
		if (gate.state === "passed") return "verified";
		if (gate.state === "none") {
			if (gate.why === "no-changes") return "no-changes";
			if (gate.why === "quick-only") return "unreviewed";
			return "no-reviewer";
		}
		return "no-progress";
	}

	/** Forgets every dialog key of `own`: a settled, aborted, switched or finished run must not keep claiming a wait. */
	#clearUserWaits(own: OwnRun): void {
		userWaits.delete(own.record.runId);
	}

	/** A host-owned async job bound to this run's agents or admitted spawns: not any other session's global job. */
	#boundAsyncRunning(own: OwnRun): boolean {
		const snapshot = this.#asyncSnapshot(own.ctx);
		if (!snapshot) return false;
		const bound = new Set((this.deps.agents?.(own.record.runId, own.sessionDir) ?? []).map(agent => agent.id));
		for (const spawn of spawnsByRun.get(own.record.runId) ?? []) if (spawn.spawnKey !== undefined) bound.add(spawn.spawnKey);
		return [...snapshot.running].some(
			job =>
				(job.agentId !== undefined && bound.has(job.agentId)) ||
				(job.ownerId !== undefined && bound.has(job.ownerId)),
		);
	}

	/**
	 * The phase a reader should see now. Stopping outranks everything; a real dialog is next; verification needs an
	 * actual check runner or the approved reviewer running; workers come from the run's own agents or bound async
	 * jobs. A turn or a round waiting for its host is work; a settled turn waiting for the next look is between
	 * rounds, never "waiting for the user" (async waiting included).
	 */
	#phaseOf(own: OwnRun): RunPhase {
		if (own.ending !== undefined || own.abort.signal.aborted) return "stopping";
		if ((userWaits.get(own.record.runId)?.size ?? 0) > 0) return "waiting-user";
		if (own.checksRunning === true) return "verifying";
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const reviewer = usableRole(own.config, "reviewer")?.agent;
		if (reviewer !== undefined && agents.some(agent => agent.state === "running" && agent.name === reviewer)) return "verifying";
		if (agents.some(agent => agent.state === "running")) return "workers";
		if (this.#boundAsyncRunning(own)) return "workers";
		if (own.awaitingAsync) return "between-rounds";
		if (own.inTurn || own.awaitingRound !== undefined || !own.turnStarted) return "working";
		return "between-rounds";
	}

	/** Hands the live callback a new record only when the view-only phase actually changed; never writes a record. */
	#emitPhase(own: OwnRun): void {
		if (this.#own !== own) return;
		const phase = this.#phaseOf(own);
		if (own.shownPhase === phase) return;
		own.shownPhase = phase;
		this.#liveStatus(own.ctx, this.active());
	}

	/** Whether this run still owns live work: a running agent, a running check, a settlement being evaluated, or a bound job. */
	#hasLiveWork(own: OwnRun): boolean {
		if (own.checking !== undefined) return true;
		// A settlement already inside `settleAttempt` has left `attempts` for `settling`; the record it will write is
		// current evidence, so finalization must wait for it instead of judging the previous accepted row.
		if (own.settling.size > 0) return true;
		if ((this.deps.agents?.(own.record.runId, own.sessionDir) ?? []).some(agent => agent.state === "running")) return true;
		return this.#boundAsyncRunning(own);
	}

	/**
	 * Re-reads every accepted row at its current source before the final record is written. A reverted shared change or
	 * a vanished retained artifact reopens that row and, transitively, the rows that consumed its version; an
	 * independent accepted row stays. The contract comes from the plan in force, else from the bounded copy the row
	 * persisted, so a lane removed after acceptance cannot hide its proof. An answer has no patch to miss. A
	 * review-accepted row's digest is its bound tree: a current tree that no longer matches reopens the submission for
	 * judgement instead of carrying the old verdict into the record.
	 */
	async #revokeUnlocatedAccepted(own: OwnRun): Promise<void> {
		let changed = false;
		let treeNow: string | undefined;
		let readTree = false;
		const currentTree = async (): Promise<string | undefined> => {
			if (readTree) return treeNow;
			readTree = true;
			const now = await this.#treeAt(own.root, own.base);
			treeNow = now === undefined || now.state.incomplete ? undefined : treeFingerprint(now.state);
			return treeNow;
		};
		for (const row of own.record.results ?? []) {
			if (row.state !== "accepted") continue;
			const planned = this.#plannedResult(own, row.id) ?? row.contract;
			// A legacy row that never recorded its contract is not reconstructed from plan text; there is no safe
			// historical source to re-locate it against and no new evidence is invented here.
			if (planned === undefined) continue;
			if (row.origin === "review") {
				const tree = await currentTree();
				// Without a current reading the gate cannot have an honest verified label; leave the row to it rather
				// than guessing that an unread tree matches.
				if (tree === undefined || row.reviewTree === tree) continue;
				row.state = "reviewable";
				row.origin = "attempt";
				row.reason = compactResultReason("리뷰 이후 트리가 바뀌어 새 판단이 필요합니다.");
				delete row.reviewTree;
				delete row.remedy;
				delete row.retryRoute;
				delete row.unblock;
				changed = true;
				continue;
			}
			if (planned.kind === "answer") continue;
			const lane = own.record.plan?.lanes.find(candidate => candidate.results?.some(result => result.id === row.id));
			const isolated = lane === undefined ? undefined : lane.isolationReason !== undefined || own.config.isolation === "isolated";
			const location = await this.#acceptedLocation(own, planned, isolated, row);
			if (location.ok) continue;
			row.state = "unmet";
			row.origin = "attempt";
			row.reason = compactResultReason(`수용된 결과가 현재 위치에서 확인되지 않았습니다: ${location.reason}`);
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			own.evidence.delete(row.id);
			changed = true;
		}
		if (!changed) return;
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
	}

	/**
	 * A run may close between a dispatch's admission and its terminal settlement. That attempt's requirement is not
	 * accepted: the row becomes unmet with a compact reason, so a late async delivery cannot resurrect it after the
	 * final record was written. No file or answer is read here.
	 */
	#closePendingAttempts(own: OwnRun): boolean {
		if (own.attempts.size === 0) return false;
		const rows = own.record.results ?? [];
		let changed = false;
		for (const prepared of own.attempts.values()) {
			for (const result of prepared.results) {
				const row = rows.find(candidate => candidate.id === result.id);
				if (row === undefined) continue;
				const identity = resultContractIdentity(result);
				if (row.identity !== undefined && row.identity !== identity) continue;
				row.state = "unmet";
				row.reason = compactResultReason("결과가 확정되기 전에 실행이 종료되었습니다.");
				row.identity = identity;
				row.origin = "attempt";
				delete row.attemptId;
				this.#bindConsumed(row, prepared);
				delete row.remedy;
			delete row.retryRoute;
				delete row.unblock;
				delete row.contentVersion;
				delete row.reviewTree;
				changed = true;
			}
		}
		own.attempts.clear();
		if (this.#invalidateConsumers(own)) changed = true;
		return changed;
	}

	/** Writes the final record and releases the lease; only runs after owned work has settled. */
	async #finalize(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext | undefined): Promise<RunRecord | undefined> {
		if (this.#own !== own) return undefined;
		// A settlement that entered `settleAttempt` after the caller's live-work check is still current evidence. Keep the
		// run stopping and let the drain timer retry; the final record never lands on top of a record still being written.
		if (own.settling.size > 0) {
			this.#deferFinalize(own);
			return undefined;
		}
		this.#own = undefined;
		// A late child event or dialog answer now finds no watcher for this run, so it cannot mark the next one.
		phaseWatchers.delete(own.record.runId);
		this.#clearUserWaits(own);
		delete own.awaitingRound;
		delete own.roundInFlight;
		delete own.checksOnlyEnd;
		this.#disarm(own);
		if (own.drainTimer !== undefined) {
			(this.deps.timers ?? REAL_TIMERS).clear(own.drainTimer);
			delete own.drainTimer;
		}
		clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		liveWriters.delete(own.record.runId);
		const ledger = endLedgerRun(own.record.runId);
		// No verified close can race an attempt whose terminal metadata never arrived: the row is unmet, and the run
		// records the honest no-progress end instead of a stale verification label.
		this.#closePendingAttempts(own);
		this.#syncConfigRefusals(own);
		this.#syncResults(own);
		// Every final record carries current evidence, not the row's last accepted state: a later write may have
		// reverted a shared change or removed the retained patch, even when the producing lane is no longer planned.
		// Vanished evidence reopens the row and what consumed its version; a verified label additionally requires every
		// row to still be accepted after that re-read.
		await this.#revokeUnlocatedAccepted(own);
		let finalReason: RunEndReason =
			reason === "verified" && (own.record.results ?? []).some(row => row.state !== "accepted") ? "no-progress" : reason;
		const spawns = spawnsByRun.get(own.record.runId) ?? [];
		const seen = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		// A team with doc consistency off asked for no doc findings, so none are counted.
		const agents = docsEnabled(own.config) ? seen : seen.map(withoutDocFindings);
		// Read while the run's spawn map still binds its failed ids: a lane is pending only from authoritative state.
		// A settled worker is not a finished requirement: an open result row keeps its lane, including a consumer whose
		// producer changed after the last attempt (T05).
		const pendingNames = new Set(
			own.record.plan === undefined ? [] : own.lanes.remaining(own.record.plan, agents, this.#failedIds(own, agents)),
		);
		for (const row of own.record.results ?? []) {
			if (row.lane !== undefined && (row.state === "pending" || row.state === "unmet")) pendingNames.add(row.lane);
		}
		const pendingLanes = (own.record.plan?.lanes ?? []).filter(lane => pendingNames.has(lane.name)).map(lane => lane.name);
		spawnsByRun.delete(own.record.runId);
		clearRunReads(own.record.runId);
		const record: RunRecord = {
			...own.record,
			endedAt: iso(this.deps.now()),
			status: ledger?.exceeded ? "budget-exceeded" : END_STATUS[finalReason],
			endReason: finalReason,
			costUsd: ledger?.costUsd ?? own.record.costUsd,
			costByModel: { ...(ledger?.costByModel ?? own.record.costByModel) },
			spawns,
			...(agents.length ? { agents } : {}),
			...(own.closeout !== undefined ? { closeout: own.closeout } : {}),
		};
		if (own.checkEvidence?.length) record.checks = own.checkEvidence;
		// A routine probe keeps the existing quiet/summary behavior. Real work gets one card, and only that card: the
		// routine summary below is skipped for it so the transcript never carries both.
		const requiredChecks = own.config.requiredChecks?.map(check => check.name) ?? [];
		const card = isSubstantiveRun(record) ? closeoutCard(record, pendingLanes, requiredChecks) : undefined;
		try {
			await this.#liveWrite;
			// Only runs this session recorded are ever cleaned later: its own store is not another session's.
			if (record.artifactsDir && record.process) {
				await recordTrustedRun(own.sessionDir, {
					runId: record.runId,
					artifactsDir: record.artifactsDir,
					process: record.process,
					agents: agents.map(agent => agent.id),
					endedAt: record.endedAt ?? iso(this.deps.now()),
				}).catch(() => undefined);
			}
			// A shutdown (no ctx) must not wait on file cleanup; the next run's end catches up.
			const cleaned = ctx ? await this.#cleanUp(own, record, agents, ctx) : [];
			await writeRun(own.sessionDir, record);
			await appendRunIndex(own.sessionDir, summarizeForIndex(record)).catch(() => undefined);
			// The idle status line reads the last run from disk: report only once the final record is there.
			if (ctx) this.#liveStatus(ctx, undefined);
			const protect = await protectedResumeRunIds(own.sessionDir).catch(() => []);
			await pruneRuns(own.sessionDir, RUN_KEEP, protect);
			if (cleaned.length) markAgentsCleaned(cleaned, this.deps.now(), own.sessionDir);
			// An automatic probe stays out of the main transcript while it is routine; a blocked spawn is not routine, and
			// the live status line already carried the rest. The substantive card waits for the lease release below.
			const quietAuto =
				card === undefined &&
				own.auto === true &&
				(record.endReason === "no-changes" || record.endReason === "verified") &&
				!record.spawns.some(spawn => spawn.outcome === "blocked");
			if (ctx && card === undefined && !quietAuto) this.deps.ui(ctx).record(CLOSEOUT_TITLE, summarizeRun(record));
		} finally {
			if (own.lease !== undefined) await this.#releaseLease(own.lease, ctx);
		}
		// The transcript card is the last word of a settled run: the record is on disk and no lease is held. A shutdown
		// (or a switch, which ends as one) opens no new UI: the transcript it belonged to is already gone. A stable
		// identity that differs from the one that directed the run is the same case even when the reason was not shutdown.
		const showingSession = ctx === undefined ? undefined : closeoutSessionId(ctx);
		const sameSession = own.sessionId === showingSession;
		if (ctx !== undefined && finalReason !== "shutdown" && sameSession && card !== undefined) {
			const registered = rememberCloseoutReport(ctx, record.runId, card.options);
			const hint = ctx.mode === "tui" && registered ? `\n\n${CLOSEOUT_CHOICE_HINT}` : "";
			try {
				this.deps.ui(ctx).record(CLOSEOUT_TITLE, `${card.text}${hint}`);
			} catch (error) {
				if (registered) resetCloseoutChoices(ctx);
				throw error;
			}
		}
		return record;
	}

	/** Releases the execution slot, surfacing a failed release instead of silently leaving it to a later owner. */
	async #releaseLease(lease: RunLease, ctx?: ExtensionContext): Promise<void> {
		try {
			await lease.release();
		} catch (error) {
			if (ctx) this.deps.ui(ctx).notify(`Storm 실행 잠금을 해제하지 못했습니다: ${errorText(error)}`, "error");
		}
	}

	/**
	 * Upgrades this run's target claim from a safe reader to an unbounded writer. The caller must stop the run on
	 * failure, because a read lease that cannot write must not let a write-capable effect proceed.
	 */
	async #upgradeLease(own: OwnRun): Promise<{ ok: true } | { ok: false; reason: string }> {
		const lease = own.lease;
		if (lease === undefined) return { ok: false, reason: "실행 잠금이 없어 쓰기 권한을 확인하지 못했습니다." };
		if (lease.mode === "write") return { ok: true };
		try {
			return await lease.upgrade({ scope: { kind: "unbounded" } });
		} catch (error) {
			return { ok: false, reason: `쓰기 권한을 확인하지 못했습니다: ${errorText(error)}` };
		}
	}

	/** Storm's limits and, when the team allows it, omp records of older runs' parked agents; best-effort. */
	async #cleanUp(own: OwnRun, record: RunRecord, agents: AgentEntry[], ctx: ExtensionContext): Promise<string[]> {
		try {
			// A switched context no longer speaks for this run's owner. Only the same native session, the same captured
			// store and the same target may supply the current cleanup consent; otherwise the start slate is used with
			// cleanup disabled. Never reload another session's approval to authorize destructive work on this one.
			const liveCtx = closeoutSessionId(ctx) === own.sessionId ? ctx : undefined;
			const state = liveCtx === undefined ? undefined : await this.deps.loadState(liveCtx).catch(() => undefined);
			const sameOwner =
				state !== undefined &&
				state.sessionDir === own.sessionDir &&
				state.repo.repoId === own.repoId &&
				state.repo.root === own.root;
			const gate = sameOwner ? teamGate(state) : undefined;
			const agentDir = this.deps.agentDir;
			const consent = gate?.ok === true && agentDir !== undefined;
			// The captured store must still resolve to this profile/session before a cleanup walks or writes it. A
			// redirected or legacy path skips destructive cleanup entirely.
			try {
				await assertSessionStoreSafe(own.sessionDir);
			} catch {
				return [];
			}
			const { result, cleaned } = await runJanitor({
				sessionDir: own.sessionDir,
				// Without a known agent dir nothing of omp's is deleted: the config below then carries no consent.
				sessionsRoot: agentDir ? path.join(agentDir, "sessions") : "",
				config: consent && gate.ok ? gate.config : withoutCleanup(own.config),
				startConfig: own.config,
				configHash: gate?.ok ? gate.hash : own.record.configHash,
				runId: own.record.runId,
				process: own.record.process ?? processKey(),
				now: this.deps.now(),
				ledger: this.deps.ledger?.(own.sessionDir) ?? agents,
				...(consent ? { approvals: own.store } : {}),
			});
			if (result.agents || result.stormFiles) record.cleanup = result;
			return cleaned;
		} catch {
			// The run's own record and summary come first; whatever was left is retried at the next run end.
			return [];
		}
	}

	/** The status line's live record; a hook that throws must not keep the run from ending. */
	#liveStatus(ctx: ExtensionContext, run: RunRecord | undefined): void {
		try {
			this.deps.live?.(ctx, run);
		} catch {
			// A convenience of the screen: no run decision reads what it shows.
		}
	}

	#scheduleFlush(own: OwnRun): void {
		// A finalized run owns no live record: the final write already happened (or is happening) and no late mutation
		// may schedule a rewrite on top of it.
		if (this.#own !== own) return;
		if (this.#flushTimer) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			const live = this.active();
			// A run that finished meanwhile has already written its final record.
			if (!live || this.#own !== own) return;
			this.#liveStatus(own.ctx, live);
			this.#liveWrite = writeRun(own.sessionDir, { ...live, updatedAt: iso(this.deps.now()) }).catch(() => undefined);
		}, this.deps.flushMs ?? LIVE_FLUSH_MS);
		this.#flushTimer.unref?.();
	}

	#threshold(ctx: ExtensionContext, kind: "warn" | "limit", run: LedgerRun): void {
		const ui = this.deps.ui(ctx);
		const budget = run.budget;
		if (kind === "warn") {
			ui.notify(`Storm 실행 비용이 경고선 ${formatUsd(budget?.warnAtUsd ?? 0)}에 닿았습니다(누계 ${formatUsd(run.costUsd)}).`, "warning");
			return;
		}
		const stop = budget?.onExceed === "stop";
		ui.notify(
			`Storm 실행 예산 ${formatUsd(budget?.perRunUsd ?? 0)}을 넘었습니다(누계 ${formatUsd(run.costUsd)}). ${stop ? "실행을 중단합니다." : "새 스폰을 차단합니다."}`,
			"warning",
		);
		if (!stop) return;
		const own = this.#own?.record.runId === run.runId ? this.#own : undefined;
		if (own) {
			own.ending ??= "budget";
			this.#clearUserWaits(own);
			this.#emitPhase(own);
		}
		if (own && !own.inTurn) {
			// Between turns there is nothing to abort, and no turn's end to wait for: omp would run one more.
			void this.#stop(own, "budget", ctx).catch((error: unknown) => ui.notify(`Storm 실행을 끝내지 못했습니다: ${errorText(error)}`, "error"));
			return;
		}
		// The aborted turn's end finishes the run.
		ctx.abort();
	}
}

const OUTCOME_LABEL: Record<SpawnRecord["outcome"], string> = {
	routed: "승인 모델",
	trial: "시험 사용",
	allowed: "그대로 허용",
	substituted: "대체 역할로 교체",
	blocked: "차단",
};

const BLOCK_LABEL: Record<SpawnBlockCode, string> = {
	"no-config": "팀 설정 문제",
	unapproved: "미승인",
	shadow: "미승인 역할 정의",
	"disabled-role": "쓰지 않는 역할",
	"no-plan": "계획 없음",
	"role-not-in-plan": "계획에 없는 역할",
	"unmapped-agent": "계획에 매핑되지 않은 에이전트",
	"unassigned-lane": "계획 레인 미배정",
	"role-cap": "역할 워커 상한",
	parallelism: "동시 상한",
	budget: "예산 초과",
	internal: "내부 오류",
};

function tally<K extends string>(keys: readonly K[], label: (key: K) => string): string {
	const counts = new Map<K, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	return [...counts].map(([key, n]) => `${label(key)} ${n}`).join(" · ");
}

/** The run's record in the transcript: at most five lines, the one Storm output that stays there. */
export function summarizeRun(run: RunRecord): string {
	const blockCodes = run.spawns.flatMap(spawn => (spawn.outcome === "blocked" && spawn.code ? [spawn.code] : []));
	const spawnLine = run.spawns.length
		? tally(
				run.spawns.map(spawn => spawn.outcome),
				outcome => OUTCOME_LABEL[outcome] ?? outcome,
			)
		: "없음";
	const blockLine = blockCodes.length ? ` · 차단 사유: ${tally(blockCodes, code => BLOCK_LABEL[code] ?? code)}` : "";
	const end = run.endReason ? ` · ${endLabel(run.endReason)}` : "";
	// Records of 0.10 and earlier counted no rounds; `maxRounds` is absent from those written before it was kept.
	const rounds =
		run.turns === undefined
			? ""
			: run.maxRounds !== undefined
				? ` · ${run.turns}/${run.maxRounds}라운드`
				: ` · ${run.turns}라운드`;
	const lines = [
		`- 실행: ${run.runId} (${STATUS_LABEL[run.status]}${end})${rounds} · 비용(정가 환산) ${formatUsd(run.costUsd)}${run.budget ? ` / 예산 ${formatUsd(run.budget.perRunUsd)}` : ""}${run.plan ? ` · ${planText(run.plan)}` : ""}`,
		`- 스폰: ${spawnLine}${blockLine}`,
	];
	const main: string[] = [];
	if (run.mainCostUsd !== undefined && run.costUsd > 0) {
		main.push(`비용 ${formatUsd(run.mainCostUsd)}(전체의 ${Math.round((run.mainCostUsd / run.costUsd) * 100)}%)`);
	}
	if (run.blockedEdits) main.push(`직접 수정 ${run.blockedEdits}회를 위임으로 돌림`);
	if (run.blockedFollowUps) main.push(`후속 지시 ${run.blockedFollowUps}회를 새 서브에이전트로 돌림`);
	const reads = run.reads;
	// Records of 0.9 counted calls, not characters: they have no share to show.
	if (reads?.directorChars) {
		main.push(`읽기 ${tokens(reads.directorChars)}자(서브에이전트와 겹침 ${Math.round((reads.duplicateChars / reads.directorChars) * 100)}%)`);
	}
	if (reads?.blocked) main.push(`큰 읽기 ${reads.blocked}회를 막음`);
	if (run.maxMainContext) main.push(`최대 컨텍스트 ${tokens(run.maxMainContext)}`);
	if (run.checkpoints?.length) main.push(`실행 중 압축 ${run.checkpoints.length}회`);
	if (main.length) lines.push(`- 감독: ${main.join(" · ")}`);
	const agents = run.agents ?? [];
	const cleanup = run.cleanup?.agents ? `정리: 이전 실행 서브에이전트 기록 ${run.cleanup.agents}개(${bytesText(run.cleanup.bytes)})` : "";
	if (agents.length) {
		const followUps = agents.reduce((sum, agent) => sum + agent.followUps, 0);
		const reused = agents.filter(agent => agent.followUps > 0).length;
		lines.push(`- 서브에이전트: ${agents.length}개 · 재사용 ${reused}개(후속 지시 ${followUps}회)${cleanup ? ` · ${cleanup}` : ""}`);
	} else if (cleanup) {
		lines.push(`- ${cleanup}`);
	}
	if (run.spawns.length) lines.push(reviewLine(agents));
	return lines.join("\n");
}

/** `계획 레인 3(구현 2 · 리뷰 1)`: the plan's lanes counted per role, in lane order. */
function planText(plan: RunPlan): string {
	const roles = tally(
		plan.lanes.map(lane => lane.role),
		roleTitle,
	);
	return `계획 레인 ${plan.lanes.length}${roles ? `(${roles})` : ""}`;
}
