/**
 * Storm run lifecycle for one main session. A run starts from `/storm` at once, or from the storm tool once the turn
 * that queued it settles: team gate, omp's session modes, compaction of a heavy context, then the handoff. An automatic
 * probe opens from the storm tool's first plan inside the running turn, with no handoff or dialog; that accepted plan
 * starts one background checkpoint when the context is already heavy. At the end of every round the round rules decide
 * whether the run is over; when it is not, Storm sends the next round itself, waiting out the hold while the session is
 * busy. Spawn decisions arrive from any session in the process (children included), so they are collected per run in
 * module scope.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ApprovalStore } from "../approval/store.ts";
import { MAX_CHECK_NAME_LENGTH } from "../config/schema.ts";
import { docsEnabled } from "../policy/docs.ts";
import { clearRunReads, openRunReads } from "../policy/reads.ts";
import { ompModeBlock } from "../policy/omp-mode.ts";
import { clearWorkerSlots, formatUsd, reservedWorkers, shadowBlock, teamGate, usableRole } from "../policy/spawn.ts";
import { tokens } from "../report/agents.ts";
import { MID_RUN_WINDOW_SHARE, RUN_START_WINDOW_SHARE, roleTitle, windowThreshold, workerRange } from "../roles.ts";
import { isApproved, type ProjectState } from "../state.ts";
import { assertSessionStoreSafe } from "../session-scope.ts";
import type { ContinuedRun, RunRequestResult } from "../tool/host.ts";
import type {
	AgentEntry,
	BudgetConfig,
	CloseoutFacts,
	LiveCheck,
	PlanLane,
	PlanLaneResult,
	RanModel,
	ResultInputVersion,
	RunCheckpoint,
	RunCheckEvidence,
	RunJob,
	RunEndReason,
	RunPlan,
	RunRecord,
	RunResult,
	RunSpec,
	RunAdjustment,
	SpawnBlockCode,
	SpawnRecord,
	SpawnStop,
	StormConfig,
	UnplannedDelivery,
	UiPort,
	WorkerStopReason,
} from "../types.ts";
import { DIRECTOR_DRAIN_WARNING, DIRECTOR_WRITE_ENDING, directorEditWait } from "./arbiter.ts";
import { ATTEMPT_REF, attemptUsable, type AttemptReport } from "./attempt-report.ts";
import {
	excludeProblem,
	excludedPlanConflict,
	exclusionNudgeText,
	resolveAdjustTarget,
	retryAdjustmentKey,
	retryNudgeText,
	retryProblem,
	sameInputs,
	stripExcludedPlan,
	type AdjustOutcome,
	type AdjustRequest,
	type AdjustTarget,
	type RetryGrant,
} from "./adjust.ts";
import type { AttemptAdmission, AttemptArtifactMode, AttemptPreparation, AttemptSettlement } from "./attempt-bridge.ts";
import { markAgentsCleaned } from "./agents.ts";
import { bytesText, processKey, recordTrustedRun, runJanitor } from "./janitor.ts";
import { runRequiredChecks, trackUnprovenCheck, uncertainCheckBlock, type CheckReport, type RequiredChecksResult } from "./checks.ts";
import { forgetTrialSpawns } from "./trials.ts";
import { runConfiguredJob, targetJobBlock } from "./job-executor.ts";
import {
	CLOSEOUT_TITLE,
	closeoutBrief,
	type CloseoutDraft,
	closeoutHandoff,
	closeoutSessionId,
	closeoutTargetName,
	isSubstantiveRun,
	parseCloseout,
	rememberCloseoutReport,
	resetCloseoutChoices,
	stormStopNotice,
	WORKER_STOP_LABEL,
} from "./closeout.ts";
import { renderCloseout } from "../view/closeout.ts";
import { checkpointGuidance, shouldCheckpoint } from "./checkpoint.ts";
import {
	captureCheckpointProof,
	normalizeCheckpointContract,
	normalizeCheckpointPlan,
	revalidateCheckpointProof,
} from "./checkpoint-import.ts";
import { hostJobRows } from "./host-jobs.ts";
import { dependencyBlock, forgetRunLanes, laneRouteFingerprint, ledgerNotice, type LedgerNoticeRow, replanConflict, RunLanes, writerFreedNotice, type LaneReadiness, type LaneResultReadiness } from "./lanes.ts";
import { reviewLane, type LanePolicy } from "../policy/capability.ts";
import {
	attemptInputsCurrent,
	changedInputRequirements,
	currentInputVersion,
	declaredInputs,
	type DeclaredInput,
	hasStaleInputs,
	type InputSatisfaction,
	inputSnapshot,
	ledgerInputSatisfaction,
	MISSING_INPUT,
	requirementConflict,
	resultInputs,
	staleRequirementIdsForPlan,
} from "./requirements.ts";
import { acquireRunLease, type AcquireRunLeaseResult, type RunLease } from "./lease.ts";
import { PLANLESS_DEADLINE, PLANLESS_NO_TURN_TIME, PLANLESS_SAME_TURN, planlessOpen, stoppedInTurn } from "./planless.ts";
import { activeLedgerRun, attachPaidAccounting, endLedgerRun, getLedgerRun, type LedgerPaidAccounting, type LedgerRun, noteRetiredPaidAttemptIds, recordPaidCost, retiredPaidAttemptIds, setLedgerPlan, spendNote, startLedgerRun, updatePaidAccounting } from "./ledger.ts";
import { bindPaidAttemptAdapter, PAID_ATTEMPT_REFUSAL_TAG, PAID_ATTEMPT_UNKNOWN_MODEL, type PaidAttemptAdapter, type PaidAttemptBindOptions, type PaidAttemptBindResult, type PaidAttemptDelta, type PaidAttemptMetadata } from "./paid-attempt-adapter.ts";
import type { AttemptUnplannedDelivery } from "./attempt-collector.ts";
import { UNPLANNED_MAX, unplannedNotice } from "./unplanned.ts";
import { reviewLine } from "./review.ts";
import {
	buildRoundMessage,
	decideRound,
	END_STATUS,
	endLabel,
	NO_DECLARED_END_REASON,
	stopWords,
	lastWriterChangeAt,
	maxRounds,
	reviewGate,
	reviewProof,
	STATUS_LABEL,
	treeFingerprint,
	treeMoved,
	type CoverageCheck,
	type CoverageInput,
	type CoverageLane,
	type CoverageResult,
	type Gate,
	type RoundDecision,
	type RoundProgress,
} from "./rounds.ts";
import { answerReviewAnchor, answerReviewPacket, answerReviewReceipt, answerReviewVerdict, type AnswerReviewSubject } from "./answer-review.ts";
import { captureSharedBaseline, evaluateSettledResults, ISOLATED_CHANGE_REASON, resultContractIdentity, verifyAnswerReceipt, type AnswerCitation, type ApprovedCheckEvidence, type ArtifactEvidenceSource, type ResultBaseline, type ResultEvidenceItem } from "./result-evidence.ts";
import { locateResult, projectAcceptedResult } from "./result-location.ts";
import type {
	AdmissionKey, AdmissionSubject, ConsumedInput, FrozenIntegrationAdmission, IntegrationCandidateId, IntegrationCheck,
	IntegrationProblem, IntegrationRead, LocatedInputPath, PathImage, ReceiptRef,
} from "./integration-admission.ts";
import type { CaptureUpdate, LateRecoveryObservation, SealedCaptureManifest } from "./integration-capture.ts";
import type { ByteWindow, IntegrationDeltaPort, Presence } from "./integration-delta.ts";
import type {
	CandidateRevision, CandidateWriteResult, FenceResolution, FenceResolutionRequest, IntegrationJournalPort,
	IntegrationLiveGrant, IntegrationWriterPort, SelectionSnapshot, StoredCandidate, WriteReceipt,
	WriteStepRecord,
} from "./integration-record.ts";
import type {
	AttemptWriteWitness, CandidateDetail, CandidateLine, CandidateProjection, CandidateQuery, IntegratedInput,
	IntegrationAttemptPort, IntegrationControllerPort, IntegrationSelectionReply, QueueReadiness, QueueWrite,
} from "./integration-controller-port.ts";
import { buildHandoff, discardStartRecord, newRunId, pruneRuns, publishRun, readRun, REQUEST_LIMIT, resumableRun, RUN_KEEP, writeRun } from "./run.ts";
import { carryGoal } from "./goal.ts";
import { appendRunIndex, summarizeForIndex } from "./run-index.ts";
import { discardStartPointer, findResumeCandidate, handoffSpec, noteResumePointer, protectedResumeRunIds, resumeSpec, trustedResume, type ResumeTarget } from "./resume.ts";
import type { TreeReading, TreeState } from "./tree.ts";
import { sharedMap } from "./thread-state.ts";
import { DEFAULT_TIMINGS, type StormTimings } from "./timings.ts";
import type { RunPhase } from "../view/appearance.ts";

const spawnsByRun = sharedMap<string, SpawnRecord[]>("storm.controller.spawnsByRun");
/**
 * Each run's last admitted spawn by its key, and each key's delivery kind, both keyed for a lookup by key: with many
 * workers a request or a delivery must not scan the run's whole spawn list (D11). Every record reaches these through
 * `noteRunSpawn`, which is the one writer of `spawnsByRun` after a run's start; a later record of a key wins.
 */
const lastSpawnByKey = sharedMap<string, Map<string, SpawnRecord>>("storm.controller.lastSpawnByKey");
const deliveryKindsByRun = sharedMap<string, Map<string, "lane" | "blocked" | "unplanned">>("storm.controller.deliveryKindsByRun");
/**
 * Workers this run's own admission stopped, by cause, for the bounded notice the director reads with the results. Keyed
 * by cause and by the worker's spawn key: two causes and this run's own stopped workers, never a sentence per worker in
 * the director's context (fault 2, D11). The first safe handle is the worker the cause sentence names.
 */
interface StopTally {
	keys: Set<string>;
	first?: string;
}
const stormStopsByRun = sharedMap<string, Map<WorkerStopReason, StopTally>>("storm.controller.stormStopsByRun");
const NATIVE_AGENT_ID = /^[A-Za-z0-9._-]{1,120}$/u;

/** One delivery this run asked a worker for: its admission, or a work message that wakes a turn. */
interface ExpectedDelivery {
	kind: "admission" | "wake";
	/** A wake Storm sent to a worker the list showed idle; the receipt may still say it joined an open turn. */
	provisional?: true;
}

/**
 * The deliveries each run has asked for and not received, per worker, in the order they were asked for (B8). A count
 * would let a late receipt hide the next unrequested arrival; this queue is consumed one answer at a time.
 */
const expectedByRun = sharedMap<string, Map<string, ExpectedDelivery[]>>("storm.controller.expectedByRun");
/** Bound per worker: a worker that never answers must not grow its queue without limit (D11; no scan of other workers). */
const EXPECTED_PER_WORKER = 64;

function noteExpected(runId: string, agentId: string, delivery: ExpectedDelivery): void {
	let workers = expectedByRun.get(runId);
	if (workers === undefined) {
		workers = new Map();
		expectedByRun.set(runId, workers);
	}
	let queue = workers.get(agentId);
	if (queue === undefined) {
		queue = [];
		workers.set(agentId, queue);
	}
	queue.push(delivery);
	if (queue.length > EXPECTED_PER_WORKER) queue.shift();
}

/**
 * When a run of one session and target last ended or stopped in this process, keyed by the session's own store and the
 * target it ran on. R9's same-turn rule reads it: a stop at or after this turn's prompt means the user has not spoken
 * since. In memory, like the spawn records: a run another process stopped is read from disk by the continuation path,
 * which has the older run's own end time.
 */
const lastRunEnds = new Map<string, number>();

/** When this session and target last ended or stopped a run in this process; absent when none did here. */
export function lastRunEndAt(sessionDir: string, root: string): number | undefined {
	return lastRunEnds.get(`${sessionDir}\u0000${root}`);
}

function noteRunEnd(sessionDir: string, root: string, at: number): void {
	const key = `${sessionDir}\u0000${root}`;
	const seen = lastRunEnds.get(key);
	if (seen === undefined || at > seen) lastRunEnds.set(key, at);
}

/** Which of R12's two continuations happened: the old plan and rows carried, or a handoff with nothing re-proved. */
export type ContinuedMode = "carry" | "handoff";

/** What a continuation carried, with the one in-memory fact its caller acts on (R12). Until `host.ts` names it, this is
 * the richer shape a caller reads; it is assignable wherever `RunRequestResult` is expected. */
export interface ContinuedRunOutcome extends ContinuedRun {
	mode: ContinuedMode;
}

/** A start's answer, richer than `RunRequestResult` only in the continuation's `mode`. */
export type RunStartResult =
	| { ok: true; runId: string; continued?: ContinuedRunOutcome }
	| { ok: false; reason: string };

/**
 * What a plan-less automatic open needs from its caller, which has already classified and gated the batch. The
 * controller then applies R9's ordered checks itself and opens the run through the same admission every start uses.
 */
export interface PlanlessStart {
	/** When the message that began this turn arrived (ms since epoch), as the host recorded it. */
	turnStartedAt: number;
	/** The host's deadline for the `tool_call` handler: `hookStart + timeout - min(2 000, timeout/2)`. */
	deadline: number;
	/** What the gated batch needs of the target: a batch of safe readers must not take the write lease (R9). */
	lease: "read" | "write";
	/** The owning hook's grant. A refusal is evaluated again at each controller boundary. */
	authorize?: (() => string | undefined) | undefined;
}

/** Debounced writers of the runs owned by sessions in this process, keyed by run id. */
const liveWriters = sharedMap<string, () => void>("storm.controller.liveWriters");
/**
 * Immediate phase listeners of the controlling session, keyed by run id. A child session reports its start, settle
 * and approvals through these: the main session draws, the child never does. View-only, like the phases themselves.
 */
const phaseWatchers = sharedMap<string, () => void>("storm.controller.phaseWatchers");
/**
 * View-only keys of the host dialogs this process's live run is waiting on. A key exists only while its run has a
 * phase watcher, so an event that outlives its run cannot mark the next one as waiting.
 */
const userWaits = sharedMap<string, Set<string>>("storm.controller.userWaits");
/** How long a stopping run keeps its scope, lease and accounting while owned work settles. */
const DRAIN_MAX_MS = 30_000;
/** What the director reads about the ledger in one request: a few lines, never a dump. */
const NOTICE_MAX_CHARS = 900;

/** Why a run does not open while omp's plan mode is on; the same rule as the automatic start's. */
export const PLAN_MODE_START_REFUSAL = "omp 계획 모드가 켜져 있어 시작하지 않았습니다. 계획 모드를 끝낸 뒤 다시 하세요.";

/**
 * The fence a lane goes back to when a prepared dispatch is dropped: the newest attempt that is still real, whether it
 * is open or already settled (in any outcome). A dropped dispatch never ran, so it must not lower the fence below an
 * attempt that did.
 */
export function fenceAfterDiscard(settledEpoch: number | undefined, openEpochs: readonly number[]): number {
	return Math.max(0, settledEpoch ?? 0, ...openEpochs);
}

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

/** Where a fact about a worker reaches the director of a run, by run id; set while this process's controller owns the run. */
const noticeSinks = sharedMap<string, (text: string) => void>("storm.controller.noticeSinks");

/**
 * A fact the director must read that only a child's session can see (a worker stopped because it ran on a model the team
 * did not approve). It reaches the director on its next request. Only a run this thread's controller owns takes it.
 */
export function noteRunNotice(runId: string, text: string): boolean {
	const sink = noticeSinks.get(runId);
	if (sink === undefined) return false;
	sink(text);
	return true;
}

/** What a child's check read of the model its spawn ran on, set on the spawn's record. No spawn of that key, no change. */
export function noteRunRan(runId: string, spawnKey: string, ran: RanModel): void {
	const record = lastSpawnByKey.get(runId)?.get(spawnKey);
	if (record === undefined) return;
	// A worker that ran on what the team did not approve stays recorded as such: a later reading of an approved model (it was
	// woken again) never replaces it.
	if (record.ran?.verdict === "mismatch" && ran.verdict !== "mismatch") return;
	record.ran = ran;
	touchRun(runId);
}

/** The stop the worker's own instance recorded for one attempt; a later attempt's verified reading stays its own. */
export function noteRunStopped(runId: string, spawnKey: string, stop: SpawnStop): void {
	const record = spawnsByRun.get(runId)?.findLast(spawn => spawn.spawnKey === spawnKey && spawn.outcome !== "blocked");
	if (record === undefined) return;
	// The same attempt read twice is one stop; a later attempt's stop is its own fact.
	if (record.stop?.attempt === stop.attempt) return;
	record.stop = stop;
	// The bounded notice's own tally, keyed by cause and worker: a worker stopped twice is counted once, under its
	// latest cause, so the count matches the spawn records the card and status read.
	let stops = stormStopsByRun.get(runId);
	if (stops === undefined) {
		stops = new Map();
		stormStopsByRun.set(runId, stops);
	}
	for (const [reason, tally] of [...stops]) {
		if (reason !== stop.reason && tally.keys.delete(spawnKey) && tally.keys.size === 0) stops.delete(reason);
	}
	const tally = stops.get(stop.reason) ?? { keys: new Set<string>() };
	tally.keys.add(spawnKey);
	if (tally.first === undefined && NATIVE_AGENT_ID.test(spawnKey)) tally.first = spawnKey;
	stops.set(stop.reason, tally);
	touchRun(runId);
}

/** What compaction before a run must keep: the director works from it for the whole run. */
const PREFLIGHT_INSTRUCTIONS =
	"곧 Storm 실행을 시작합니다. 작업 계획, 내린 결정과 그 이유, 남은 문제, 관련 파일 경로는 빠짐없이 남기고 나머지는 짧게 줄이세요.";

/** Called by the spawn hook of whichever session decided the spawn. A finished run takes no more spawns. */
export function noteRunSpawn(runId: string, record: SpawnRecord): void {
	const list = spawnsByRun.get(runId);
	if (!list) return;
	list.push(record);
	// One keyed write per spawn, so a delivery or a model report never walks the run's spawn list (D11).
	const spawnKey = record.spawnKey;
	if (spawnKey !== undefined && spawnKey !== "") {
		const last = lastSpawnByKey.get(runId);
		const kinds = deliveryKindsByRun.get(runId);
		if (last !== undefined && record.outcome !== "blocked") last.set(spawnKey, record);
		if (kinds !== undefined) {
			if (record.outcome === "blocked") {
				// B8: a refusal under a key never replaces the live admission's kind. The admitted worker's first answer
				// is still the work this run asked for.
				if (!kinds.has(spawnKey)) kinds.set(spawnKey, "blocked");
			} else {
				kinds.set(spawnKey, record.lane !== undefined ? "lane" : "unplanned");
				// The admission is the first delivery this run asked this worker for; a refusal adds no expectation.
				noteExpected(runId, spawnKey, { kind: "admission" });
			}
		}
	}
	touchRun(runId);
}

/** How much of the request a run record keeps. */
const TASK_CHARS = 200;
/** A follow-up reference that is not this session's own finished run on this target; nothing of it was read in. */
const FOLLOW_UP_DECLINED =
	"이전 실행을 이 세션과 이 작업 트리의 끝난 실행으로 확인하지 못해 후속 작업으로 시작하지 않았습니다. 요청을 새로 입력해 시작하세요.";

/** Refusals of a director's continuation; each says what the user can do, since the director cannot. */
const NO_CONTINUABLE_RUN =
	"이어 갈 중단된 실행이 없습니다. 이 세션과 이 작업 트리에서 시작해 끝나지 않은 실행만 이어 갑니다. 새 작업이면 계획을 plan으로 제출하세요.";
const CONTINUE_PLAN_REFUSED =
	"중단된 실행의 계획이 지금 승인된 팀 범위에 맞지 않아 이어 가지 않았습니다. 사용자가 /storm 의 이어 가기를 고르면 결과는 이어받고 계획은 새로 세웁니다. 팀 범위 변경도 사용자가 /storm 에서 합니다.";
/** A continued run whose place in the lineage could not be written starts nothing, so two runs never claim one parent. */
export const RESUME_POINTER_FAILED =
	"이어 가는 실행의 계보를 기록하지 못해 시작하지 않았습니다. 세션 저장소의 쓰기 권한과 여유 공간을 확인한 뒤 다시 이어 가세요.";
/** The run stopped at or after this turn began: the user has not spoken since, so a limit or a stop of theirs stands. */
export const CONTINUE_SAME_TURN =
	"중단된 실행이 이번 사용자 요청과 같은 턴이거나 그 뒤에 멈춘 것이라 이어 가지 않았습니다. 멈춘 뒤에 사용자가 이어 가라고 말해야 이어 갑니다. 사용자에게 멈춘 이유를 알리고 어떻게 할지 물어 보세요.";

/**
 * R9's same-turn rule for an automatic plan start: a run of this session and target that ended or stopped at or after
 * this turn's prompt refuses it. An old caller that supplies no prompt time keeps 0.28.0's behaviour; the wiring always
 * passes the turn's own time. A continuation has the candidate's recorded stop time instead (see `#begin`).
 */
function sameTurnRefusal(turnStartedAt: number | undefined, sessionDir: string, root: string): string | undefined {
	if (turnStartedAt === undefined) return undefined;
	if (!Number.isFinite(turnStartedAt)) return PLANLESS_NO_TURN_TIME;
	return stoppedInTurn(turnStartedAt, lastRunEndAt(sessionDir, root)) ? PLANLESS_SAME_TURN : undefined;
}

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
	/**
	 * The lane runs in its own checkout (an isolation reason, or a team that isolates every worker). Derived once at
	 * preparation from the plan in force; memory only, never a record field. An isolated `change` is never judged
	 * against the parent tree in 0.29.0: Storm does not bring isolated work into the tree in this version.
	 */
	isolated?: true;
	/** Producer result versions this attempt started from; absent when the lane declared no prerequisites. */
	consumed?: readonly ResultInputVersion[];
	/**
	 * The logical inputs (producer result id + edge level) the plan declared for this lane when the attempt started.
	 * A replan that swaps, adds, removes or re-levels an input supersedes the attempt even while every recorded producer
	 * version is unchanged; a pure lane rename keeps it, because result ids locate the lane.
	 */
	declaredInputs: readonly DeclaredInput[];
	/** Captured immediately before the attempt; absent for a legacy lane with no declared results. */
	baseline?: ResultBaseline;
	/** The user's one-shot retry this attempt consumed, so an attempt that never ran can give it back. */
	retryTaken?: RetryTaken;
}

/** What taking a retry grant changed, enough to undo it: the grant, the row's earlier reason and the stamped entry. */
interface RetryTaken {
	grant: RetryGrant;
	reason?: string;
	entry?: RunAdjustment;
}

/** The last settled attempt of a lane, kept bounded for a later re-evaluation whose check evidence was not ready yet. */
interface SettledAttempt {
	prepared: PreparedAttempt;
	attemptId: string;
	/** The host agent that produced it; its `agent://` output is where a reviewer reads an answer too long to quote. */
	spawnKey: string;
	reportText?: string;
	/** `reportText` is only the part of the output the host delivered; see `AttemptSettlement.reportPartial`. */
	reportPartial?: true;
	citations: readonly AnswerCitation[];
	artifact?: ArtifactEvidenceSource;
	/** The lane declared a check and no approved report existed at settlement; one re-evaluation is owed. */
	checkDeferred?: boolean;
	/** Current integration receipts this attempt's change rows were re-evaluated from; absent until a write. */
	integrated?: {
		readonly receipt: ReceiptRef;
		readonly candidateId: IntegrationCandidateId;
		readonly witnesses: ReadonlyMap<string, AttemptWriteWitness>;
		readonly evaluatedAt: number;
	};
}

/** One exact receipt-backed result location, kept only for this process's run. */
interface IntegrationResultState {
	readonly receipt: ReceiptRef;
	readonly attemptId: string;
	readonly candidateId: IntegrationCandidateId;
	readonly manifestDigest: string;
	readonly attributable: readonly LocatedInputPath[];
	readonly observedAt: number;
}

/** A resultless producer's whole-footprint receipt version, never a fake result row. */
interface IntegrationFootprintState {
	readonly lane: string;
	readonly receipt: ReceiptRef;
	readonly version: string;
	readonly paths: readonly LocatedInputPath[];
	readonly observedAt: number;
}

/** One admission's in-memory integration state; the durable seal/receipt stays in B's journal. */
interface IntegrationAdmissionState {
	admission: FrozenIntegrationAdmission;
	status: "prepared" | "committed" | "discarded";
	seal?: SealedCaptureManifest;
	sealSequence?: number;
	recovery: LateRecoveryObservation[];
	/** The exact native attempt this seal names; binding evidence only, never a second settlement. */
	boundAttemptId?: string;
	/** Integration-only epoch for resultless/unplanned admissions (planned resultful epochs live in the subject). */
	epoch?: number;
	lastWrite?: CandidateWriteResult;
	lastWriteAt?: number;
	/** A fail-closed active-run diagnostic or a bound contradiction; never a grant. */
	problem?: IntegrationProblem;
	observedAt: number;
	/** The one synchronous final check published by revalidate, consumed by `checkCandidate`. */
	liveCheck?: { revision: CandidateRevision; problem?: IntegrationProblem };
}

interface IntegrationRunState {
	readonly admissions: Map<string, IntegrationAdmissionState>;
	readonly candidates: Map<string, IntegrationAdmissionState>;
	readonly receipts: Map<string, IntegrationResultState>;
	readonly footprints: Map<string, IntegrationFootprintState>;
	/** Latest integration-only epoch per planned resultless lane and per unplanned item. */
	readonly laneEpoch: Map<string, number>;
	readonly itemEpoch: Map<string, number>;
	/** Rows awaiting an explicit selection for one exact candidate. */
	readonly awaiting: Map<string, IntegrationCandidateId>;
	replayDone: boolean;
	lastSequence?: number;
}

function emptyIntegrationState(): IntegrationRunState {
	return {
		admissions: new Map(),
		candidates: new Map(),
		receipts: new Map(),
		footprints: new Map(),
		laneEpoch: new Map(),
		itemEpoch: new Map(),
		awaiting: new Map(),
		replayDone: false,
	};
}

const INTEGRATION_KEY_SCHEMA = "storm.integration-admission/v1";
const INTEGRATION_CANDIDATE_RE = /^c1_[0-9a-f]{64}$/u;
const INTEGRATION_DIGEST_RE = /^[0-9a-f]{64}$/u;
const INTEGRATION_CANDIDATES_MAX = 128;
const INTEGRATION_LIST_BYTES_MAX = 16 * 1024;
const INTEGRATION_WINDOW_BYTES = 64 * 1024 * 1024;
const INTEGRATION_WINDOW_MS = 120_000;
const INTEGRATION_EXAMPLES = 3;
const INTEGRATION_PAGE = 20;
const INTEGRATION_RECOVERY_MAX = 8;
const READINESS_KINDS: readonly QueueReadiness["kind"][] = [
	"awaiting-native", "ready", "confirmed-empty", "kept-only", "unknown", "conflict", "stale",
];
const WRITE_KINDS: readonly QueueWrite["kind"][] = [
	"not-written", "not-recorded", "present-unattributed", "no-effect", "recovery-required", "written",
];

/** A bounded machine problem; wording is D's, this is only the fail-closed fact. */
function integrationProblem(code: string, reason: string, file?: string): IntegrationProblem {
	return { code, reason: compactResultReason(reason), ...(file === undefined ? {} : { path: file }) };
}

function integrationUnknown<T>(code: string, reason: string): IntegrationRead<T> {
	return { kind: "unknown", problem: integrationProblem(code, reason) };
}

function integrationKnown<T>(value: T): IntegrationRead<T> {
	return { kind: "known", value };
}

function integrationOk(): IntegrationCheck {
	return { ok: true };
}

function integrationFail(code: string, reason: string): IntegrationCheck {
	return { ok: false, problem: integrationProblem(code, reason) };
}

/** The one runtime spelling of an admission's candidate id: `c1_` plus SHA-256 of the versioned key. */
function candidateIdFor(key: AdmissionKey): IntegrationCandidateId {
	const digest = createHash("sha256").update(JSON.stringify([key.schema, key.runId, key.dispatch]), "utf8").digest("hex");
	return `c1_${digest}` as IntegrationCandidateId;
}

function isCandidateId(value: unknown): value is IntegrationCandidateId {
	return typeof value === "string" && INTEGRATION_CANDIDATE_RE.test(value);
}

function sameKey(left: AdmissionKey, right: AdmissionKey): boolean {
	return left.schema === right.schema && left.runId === right.runId && left.dispatch === right.dispatch;
}

function sameReceipt(left: ReceiptRef, right: ReceiptRef): boolean {
	return sameKey(left.key, right.key) && left.candidateId === right.candidateId &&
		left.manifestDigest === right.manifestDigest && left.intentSequence === right.intentSequence &&
		left.receiptSequence === right.receiptSequence;
}

function itemIdentity(item: { readonly toolCallId: string; readonly itemIndex: number; readonly handle: string }): string {
	return `${item.toolCallId}\u0000${item.itemIndex}\u0000${item.handle}`;
}

/** Whether two path images describe the same exact content, mode and absence. */
function sameImage(left: PathImage, right: PathImage): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "absent" || right.kind === "absent") return true;
	return left.mode === right.mode && left.bytes === right.bytes && left.sha256 === right.sha256;
}

/** A content change; a mode-only difference is deliberately not credit. */
function contentChanged(before: PathImage, after: PathImage): boolean {
	if (before.kind !== after.kind) return true;
	if (before.kind === "absent" || after.kind === "absent") return false;
	return before.bytes !== after.bytes || before.sha256 !== after.sha256;
}

/** The exact result contract digest an admission freezes; lane and epoch are separate fields. */
function contractDigestOf(results: readonly PlanLaneResult[]): string {
	const canonical = results
		.map(result => persistedResultContract(result))
		.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** The content changes one receipt made inside a result's original evaluation scope. */
function attributablePaths(
	receipt: WriteReceipt,
	result: PlanLaneResult,
	laneFiles: readonly string[] | undefined,
): LocatedInputPath[] {
	const scope = result.path === undefined ? (laneFiles ?? []) : [result.path];
	if (scope.length === 0) return [];
	const allowed = new Set(scope);
	const paths: LocatedInputPath[] = [];
	for (const intent of receipt.intent.paths) {
		if (!allowed.has(intent.path)) continue;
		if (!contentChanged(intent.before, intent.after)) continue;
		paths.push({ path: intent.path, image: intent.after });
	}
	return paths;
}

/** Every content change a receipt made; a resultless producer exports this whole footprint. */
function receiptPaths(receipt: WriteReceipt): LocatedInputPath[] {
	return receipt.intent.paths
		.filter(intent => contentChanged(intent.before, intent.after))
		.map(intent => ({ path: intent.path, image: intent.after }));
}

function emptyReadinessCounts(): Record<QueueReadiness["kind"], number> {
	return Object.fromEntries(READINESS_KINDS.map(kind => [kind, 0])) as Record<QueueReadiness["kind"], number>;
}

function emptyWriteCounts(): Record<QueueWrite["kind"], number> {
	return Object.fromEntries(WRITE_KINDS.map(kind => [kind, 0])) as Record<QueueWrite["kind"], number>;
}

/**
 * The exact answer submission S1 judged for one row: its evidence item (answer text digest, anchor citation path and
 * byte digest, content version), the verbatim answer text whose digest S1 judged, and when this run first held it. A
 * reviewer verdict can settle a reviewable answer only when it scopes this exact submission's receipt and anchor, was
 * given after `seenAt`, and the anchor bytes still match. It lives only for this run and is never restored: the answer
 * text is not persisted, so a resumed run cannot hand the same submission to a reviewer and reopens it to its producer.
 */
interface AnswerSubject {
	attemptId: string;
	item: ResultEvidenceItem;
	seenAt: number;
	/** The submitted answer, kept only when its sha256 is exactly the digest S1 judged; the review packet quotes it. */
	answer?: string;
	/** The producer's output handle (`agent://<id>`): a reviewer reads an answer too long to quote whole there. */
	output?: string;
	/** `answer` is only the host's part of the output; the reviewer must judge the whole at `output`. */
	partial?: true;
}

/**
 * Model-facing size of the answer packets one reviewer task or follow-up carries. It splits the work, it never limits
 * it: every reviewable answer gets a packet in the round, over as many reviewer turns as this budget needs.
 */
const ANSWER_BATCH_CHARS = 24_000;
/** Head quoted for an answer whose whole packet would not fit one batch; the reviewer reads the rest at its producer. */
const ANSWER_EXCERPT_CHARS = 4_000;
const ANSWER_BATCH_HEAD = "[storm:answer-review] Storm's scoped answer review input (not a verdict). Judge every answer below and add one results entry for each.";

/** One reviewable answer's packet with the receipt that marks it handed out. */
interface AnswerPacket {
	receipt: string;
	packet: string;
}

/**
 * Splits packets in row order into reviewer batches: a batch closes before a packet would pass the budget, and a
 * packet alone always forms a batch, so nothing is dropped and the split is the same for a count and a hand-out.
 */
function answerBatches(packets: readonly AnswerPacket[]): AnswerPacket[][] {
	const batches: AnswerPacket[][] = [];
	let current: AnswerPacket[] = [];
	let chars = 0;
	for (const packet of packets) {
		if (current.length > 0 && chars + packet.packet.length > ANSWER_BATCH_CHARS) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(packet);
		chars += packet.packet.length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** One result reason is one compact record and closeout line: no newlines, no unbounded model or host text. */
function compactResultReason(text: string): string {
	const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
	return line.slice(0, 100);
}

/**
 * Row 2 of the 0.29.0 table, the one pure rule every evaluation path shares: an isolated lane's `change` result is
 * never accepted and never made reviewable in this version, whatever the parent tree holds. Another writer may have
 * written those bytes (ISO P7-B), and a reviewer on the parent tree cannot see the candidate. The reason names the
 * missing managed integration, never "the worker changed nothing". Every other result kind is returned untouched, and
 * an item that already failed keeps its own reason: only a judgeable state is replaced.
 */
export function isolatedChangeItems(items: readonly ResultEvidenceItem[], isolated: boolean): ResultEvidenceItem[] {
	if (!isolated) return items as ResultEvidenceItem[];
	return items.map(item => {
		if (item.kind !== "change" || (item.state !== "accepted" && item.state !== "reviewable")) return item;
		const copy = { ...item };
		delete copy.checkDeferred;
		return { ...copy, state: "unmet" as const, reason: ISOLATED_CHANGE_REASON };
	});
}

/**
 * Whether acting on this plan can change the target or run commands there. A safe reader stays a reader; every other
 * lane kind, declared file or non-answer result must hold the worktree write claim before the plan is bound.
 */
function planNeedsWrite(plan: RunPlan): boolean {
	return plan.lanes.some(
		lane =>
			// A review lane may run commands (the approved reviewer carries a shell), so it needs the claim like a writer.
			lane.kind !== "explore" ||
			reviewLane(lane) ||
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
/** A user exclusion is not an orphan: it keeps its binding and reason, and no later plan may recreate it. */
const EXCLUDED_RESULT_REASON = "사용자가 이 결과를 실행 범위에서 제외했습니다.";

/**
 * Row 2 of the 0.29.0 table: a `change` result of an isolated lane is never accepted or made reviewable in this
 * version. The reason lives in the evaluator (`result-evidence.ts`) and is re-exported here for the controller, views
 * and tests; it names the missing capability, never the worker.
 */
export { ISOLATED_CHANGE_REASON };
/**
 * Row 5: an `integrated` prerequisite on an isolated producer cannot be met in 0.29.0 because no integration exists.
 * Exported so the controller and its test share the one sentence.
 */
export const ISOLATED_INTEGRATED_REASON = "이 버전은 격리 작업을 부모 트리에 통합하지 않으므로 통합 반영 조건은 충족될 수 없습니다";
/** Row 3: a successful isolated attempt with no captured patch may be a branch, which this version cannot read. */
export const ISOLATED_BRANCH_UNREAD = "브랜치 결과는 이 버전이 읽지 못합니다";
/** Row 3: the full capture reason; the native delivery is the only place the rest of the outcome is recorded. */
export const ISOLATED_CAPTURE_UNREAD = `보존 패치를 받지 못했습니다. ${ISOLATED_BRANCH_UNREAD}`;
/** Row 8: a proved successful attempt the host reported as an empty root and companion capture: no delta to keep. */
export const EMPTY_CAPTURE_REASON = "호스트가 루트와 중첩 모두 빈 캡처로 보고했습니다(보존할 델타 없음)";
/** A zero-byte root patch whose companions were declared: the capture is not empty, this version reads no root delta. */
export const NESTED_ONLY_REASON = "루트 패치가 비어 있지만 중첩 저장소에 보존 변경이 있습니다(이 버전은 중첩 캡처를 결과로 읽지 않음)";
/** A zero-byte root patch with no complete companion list: emptiness is unknown, never empty. */
export const EMPTY_UNKNOWN_REASON = "루트 패치가 비어 있지만 함께 캡처된 목록이 없어 캡처 여부를 알 수 없습니다";
/** Row 8: a native cancel whose identity Storm could not bind says the cause is unconfirmed, not that the worker did nothing. */
export const CANCEL_IDENTITY_UNKNOWN = "취소로 끝났지만 이 시도의 신원을 확인하지 못했습니다";
/** The audit list is bounded like every other record list; the newest actions win. */
const ADJUSTMENTS_MAX = 50;
/** A repeated ordinary directive within this window is a duplicate delivery, not a second attempt. */
const ADJUST_REPLAY_MS = 120_000;
const RESULT_FALLBACK_REASON: Record<"unmet" | "reviewable", string> = {
	unmet: "요구 결과가 충족되지 않았습니다.",
	reviewable: "제출물이 있어 자연어 판단이 필요합니다.",
};
const PROOF_DIGEST = /^[a-f0-9]{64}$/u;

function jobDigest(job: NonNullable<StormConfig["jobs"]>[number]): string {
	return createHash("sha256").update(JSON.stringify([job.argv, [...(job.resources ?? [])].sort(), job.timeoutMs ?? null])).digest("hex");
}

function setJobReceipt(run: RunRecord, receipt: RunJob): void {
	const jobs = (run.jobs ??= []);
	const index = jobs.findIndex(job => job.name === receipt.name);
	if (index === -1) jobs.push(receipt);
	else jobs[index] = receipt;
}

const UNCERTAIN_JOB = "이전 호출의 효과를 확인할 수 없습니다. 외부 상태와 산출물을 먼저 확인하세요. 이 이어가기에서는 재실행하지 않습니다.";

function blockedJobRow(row: RunResult, reason: string): void {
	row.state = "unmet";
	row.reason = compactResultReason(reason);
	row.remedy = "blocked";
	row.unblock = "실행 기록과 작업 대상의 상태를 확인한 뒤, 필요하면 새 실행을 명시적으로 시작하세요.";
	delete row.contentVersion;
	delete row.proof;
	delete row.restoredFrom;
}

function historicalJob(run: RunRecord | undefined, name: string): RunJob | undefined {
	return Array.isArray(run?.jobs) ? run.jobs.find(job => job !== null && typeof job === "object" && job.name === name) : undefined;
}

function unsafeToReplay(job: RunJob | undefined, currentHash: string): boolean {
	if (job === undefined) return false;
	if (job.fence?.cause === "process-unproven" || job.status === "started" || job.status === "unknown") return true;
	if (job.status === "passed") return job.jobSha256 === undefined || job.jobSha256 === currentHash;
	return !["failed", "timed-out", "cancelled", "spawn-error", "unrun"].includes(job.status);
}

/** Carry the no-replay decision even if the lane disappears from this continuation's plan. */
function checkpointReceipts(run: RunRecord): RunJob[] {
	const receipts = new Map<string, RunJob>();
	for (const old of Array.isArray(run.jobs) ? run.jobs : []) {
		if (old === null || typeof old !== "object" || typeof old.name !== "string" || old.name.trim() !== old.name ||
			old.name.length === 0 || old.name.length > MAX_CHECK_NAME_LENGTH || !unsafeToReplay(old, old.jobSha256 ?? "")) continue;
		const unique = !receipts.has(old.name);
		const digest = old.jobSha256;
		const passed = unique && old.status === "passed" && old.exitCode === 0 && old.fence === undefined &&
			typeof digest === "string" && PROOF_DIGEST.test(digest);
		receipts.set(old.name, {
			name: old.name,
			lane: typeof old.lane === "string" && old.lane.length <= 200 ? old.lane : old.name,
			status: passed ? "passed" : "unknown",
			exitCode: passed ? 0 : null,
			startedAt: typeof old.startedAt === "string" && Number.isFinite(Date.parse(old.startedAt)) ? old.startedAt : null,
			finishedAt: typeof old.finishedAt === "string" && Number.isFinite(Date.parse(old.finishedAt)) ? old.finishedAt : null,
			...(passed ? { jobSha256: digest } : { detail: UNCERTAIN_JOB }),
			...(unique && typeof old.attemptId === "string" && ATTEMPT_REF.test(old.attemptId) ? { attemptId: old.attemptId } : {}),
			...(passed && typeof old.stdoutSha256 === "string" && PROOF_DIGEST.test(old.stdoutSha256) ? { stdoutSha256: old.stdoutSha256 } : {}),
		});
	}
	return [...receipts.values()];
}
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

/** A decision to send another round, as `decideRound` hands it over. */
type RoundContinue = Extract<RoundDecision, { action: "continue" }>;

/**
 * Producer result ids that some requirement declared below `integrated` in `previous` and at `integrated` in `next`:
 * the only strengthening whose satisfaction needs a tree read rather than a row state.
 */
function integratedStrengthening(previous: RunPlan, next: RunPlan): Set<string> {
	const ids = new Set<string>();
	for (const lane of next.lanes) {
		for (const result of lane.results ?? []) {
			const before = new Map((resultInputs(previous, result.id) ?? []).map(input => [input.id, input.need]));
			for (const input of resultInputs(next, result.id) ?? []) {
				const old = before.get(input.id);
				if (input.need === "integrated" && old !== undefined && old !== "integrated") ids.add(input.id);
			}
		}
	}
	return ids;
}

/**
 * What one row's current judgment stands on: its state, origin, attempt and content version. A decision read from an
 * awaited location check applies only while this is unchanged.
 */
function rowWitness(row: RunResult): string {
	return JSON.stringify([row.state, row.origin ?? null, row.attemptId ?? null, row.contentVersion ?? null]);
}

/** One accepted row's usable location: a retained isolated artifact, the current parent, or an answer's own proof. */
type AcceptedLocation =
	| { ok: true; integrated: boolean; retained?: LaneResultReadiness["retained"] }
	| { ok: false; reason: string };

/** The installed native paid-attempt authority of one run; valid only while the owning controller finalizes it. */
interface PaidAttemptBinding {
	readonly adapter: PaidAttemptAdapter;
	readonly metadata: PaidAttemptMetadata;
}

type PaidAttemptBindOutcome =
	| { readonly ok: true; readonly binding?: PaidAttemptBinding }
	| { readonly ok: false; readonly reason: string };

interface OwnRun {
	record: RunRecord;
	/** The exact native paid-attempt owner this run bound before its first covered provider send. */
	paid?: PaidAttemptBinding;
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
	/** Bumped whenever the effective plan is replaced or a lane is removed by a user exclusion. */
	planRevision: number;
	/** The one user-requested retry still waiting for its next matching lane attempt; never restored on resume. */
	retry?: RetryGrant;
	/** One-shot keys already granted; a redelivered request with the same settled attempt is not a second grant. */
	retryAcks: Set<string>;
	/** The last ordinary retry directive, for duplicate-delivery detection only (bounded text, no authority). */
	lastRetry?: { text: string; lane: string; result: string; at: number };
	/** Exclusion nudges deferred while a turn or host hold owns the session; sent once with the next round. */
	adjustNotes?: string[];
	/** Latest prepared attempt epoch per lane, so a late success/failure cannot overwrite newer evidence. */
	laneAttempt: Map<string, number>;
	/** The latest settled attempt per lane, for a bounded re-evaluation once approved check evidence exists. */
	settled: Map<string, SettledAttempt>;
	/**
	 * The highest attempt epoch of each lane that settled in any outcome. `settled` keeps only the last success, so a
	 * newer attempt that failed, was cancelled or went stale is visible here alone; the lane's fence never drops
	 * below it, or the older success's evidence would count as current again.
	 */
	settledEpoch: Map<string, number>;
	/**
	 * What the director has not yet been told about the ledger (see `ledgerNotice`), oldest first; taken once by
	 * `takeNotices`. Memory only: a notice is a reading aid for the next director request, never state to restore.
	 */
	notices: string[];
	/** The stop summary already delivered for this run; a later stop changes it so the director reads the new count. */
	stopNoticeShown?: string;
	/** The initiating hook has not handed this automatic start back to omp. */
	provisional?: true;
	/** Dispatches whose evaluation was already reported: one attempt is reported once, however many ways it arrives. */
	noticed: Set<string>;
	/** Waiting lanes the director was told can start and that have not started or stopped being startable since. */
	startableTold: Set<string>;
	/** Writing lanes the director was told the write order lets start, until they start or the order holds them again. */
	writersTold: Set<string>;
	/** Revalidated lanes owe no new worker attempt unless their results are reopened. */
	restoredLanes: Set<string>;
	/** The answer submission each answer row currently stands on; see `AnswerSubject`. */
	answerSubjects?: Map<string, AnswerSubject>;
	/**
	 * Review receipts already handed to a reviewer task or follow-up, so no answer goes to two reviewers. A round that
	 * starts with no reviewer running releases them: a reviewer that ended without judging its batch does not keep it.
	 */
	answerHandout?: Set<string>;
	/** Lanes whose settlement is being evaluated now; a consumer admission waits for these before reading rows. */
	settling: Set<string>;
	/** Aborts checks and other bounded work as soon as the run starts stopping. */
	abort: AbortController;
	/** Required-check reports by tree fingerprint; "skipped" means the tree was decided ineligible. */
	checks: Map<string, CheckReport | "skipped">;
	/** The tree a required-check run is currently evaluating; no second run starts for it. */
	checking?: string;
	/** Jobs may overlap inside a batch by declared resource, never with unchecked worktree writers. */
	jobBatch?: true;
	jobFence?: string;
	/** Jobs whose end is not proven yet and that the OS may still prove (`open`), and whether one can never be (`hard`). */
	jobUnproven?: { open: number; hard: boolean };
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
	/** Opened by R9's plan-less automatic door (`startPlanless`), not the manual branch that also has no plan. */
	planless?: boolean;
	/** Why the run is over, decided while a turn was still running: that turn's end finishes it, its last message counted. */
	ending?: RunEndReason;
	/** Most rounds the run may take, fixed at start: a team edited mid-run must not move the goal posts. Absent: no cap. */
	maxRounds?: number;
	/** The user's wall-time limit in minutes, when the request stated one. */
	minutes?: number;
	/** The work tree when the run started: the gate compares it with the tree at each round. */
	tree?: TreeState;
	/** The commit the start tree was read against: every later read compares with it, so a commit does not hide a change. */
	base?: string;
	/** The team's activity when Storm sent its last round message: what the next round is expected to move. */
	progress?: RoundProgress;
	/** Rounds in a row that moved nothing, as of the last round sent; memory only, a resumed run starts at 0. */
	stalled?: number;
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
	/** The director committed one of its own path edits in this run (R10's gate input): a run with one is never
	 * "quick-only". Memory only, never a record field; the extension raises it through `noteDirectorEdit`.
	 */
	directorEdit?: boolean;
	/** Isolated-integration candidates/receipts for this run; absent until an admission is prepared. */
	integration?: IntegrationRunState;
	/** The final record is being built; no new settlement, capture update or selection may mutate the run. */
	finalizing?: true;
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
	/**
	 * Waits until the write authority of every worker whose place the run's lane table took has been withdrawn; the refusal's
	 * reason when one could not be. A job or a check starts only after it (R-final N4). Absent: nothing is pending.
	 */
	settleEnds?(runId: string): Promise<string | undefined>;
	/** The work tree's state against `base` (HEAD when absent); absent in hosts and tests that have no git. */
	tree?(root: string, base?: string): Promise<TreeReading | undefined>;
	/** Every subagent this process has seen in this session (any run): the janitor only cleans those omp has parked. */
	ledger?(sessionDir: string): AgentEntry[];
	/** omp's agent dir: the janitor deletes omp records only below its `sessions/`. Absent → no omp record cleanup. */
	agentDir?: string;
	/** The runtime's fixed waits (live flush, drain poll, round delay, admission settlement); the product's when absent. */
	timings?: StormTimings;
	/** The look timer's clock; real timers when absent. */
	timers?: RunTimers;
	/** Acquires the session's execution lease; the real hard-link lease when absent. */
	lease?(
		input: Parameters<typeof acquireRunLease>[0],
		deps?: Parameters<typeof acquireRunLease>[1],
	): Promise<AcquireRunLeaseResult>;
	/**
	 * The live status record: the run after it was first written, on every live rewrite and when a round is sent;
	 * `undefined` when the run ends. `integration` is C's last exact candidate projection for that run, never a
	 * fresh journal/fs read from the view side. A failing hook never breaks the run.
	 */
	live?(ctx: ExtensionContext, run: RunRecord | undefined, integration?: CandidateProjection): void;
	/**
	 * The approved write authority of each lane of `plan` (`lanePolicy` over the effective agent tools), for the one line
	 * that says which writing lanes the write order now lets start. Absent, or `undefined` when the team cannot be read:
	 * the run then says nothing about writers rather than guess.
	 */
	lanePolicies?(runId: string, plan: RunPlan): Promise<{ policies: ReadonlyMap<string, LanePolicy>; canonicalFiles: ReadonlyMap<string, readonly string[]> } | undefined>;
	/**
	 * R15: observed spend reached the run's limit, so the spend is closed for the workers already running. The
	 * director's instance calls this once, at the limit, with the run's own `onExceed`; the implementation writes the
	 * marker a worker on another thread reads from disk (P3-guard's `spend-close.ts`). Absent in hosts and tests that
	 * have no marker.
	 */
	closeSpend?(runId: string, onExceed: BudgetConfig["onExceed"]): void | Promise<void>;
	/** Live owner decision over each scoped worker's exact request, including transport's final wire route. */
	authorizeWorkerTurn?: PaidAttemptBindOptions["authorizeWorkerTurn"];
	/**
	 * Isolated-integration ports (journal, exact delta, exclusive writer). Absent until the host boundary is proved:
	 * every existing attempt/evaluation path then keeps its 0.29.0 behavior. The run's captured session owns the ports.
	 */
	integration?(sessionDir: string): IntegrationPorts | undefined;
}

/** The three external seams C consumes; A/B/E own their implementations. */
export interface IntegrationPorts {
	readonly journal: IntegrationJournalPort;
	readonly delta: IntegrationDeltaPort;
	readonly writer: IntegrationWriterPort;
	/** Bound read-side join for capture work already scheduled by this native conversation. */
	readonly settleCapture?: (runId: string, window: ByteWindow) => Promise<void>;
}

/**
 * Which door a start came through. Only the manual one waits for a handoff; the other three open inside a turn that is
 * already running. `planless` is R9's explicit start mode: it is not `#start` with no plan, which is the manual branch.
 */
type StartMode = (
	| { kind: "manual" }
	| { kind: "plan"; plan: RunPlan; configHash?: string; turnStartedAt?: number }
	| { kind: "continue"; said: string | undefined; turnStartedAt: number }
	| (Pick<PlanlessStart, "turnStartedAt" | "deadline" | "lease"> & { kind: "planless" })
) & { authorize?: (() => string | undefined) | undefined };

export class RunController implements IntegrationAttemptPort, IntegrationControllerPort {
	#pending: { runId: string; spec: RunSpec } | undefined;
	/** A start is between its checks and its handoff (it may be asking, compacting, or recording the run). */
	#starting = false;
	#own: OwnRun | undefined;
	/** Names the entries a job batch or a required check makes in the lane table. */
	#holderSerial = 0;
	#flushTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped when the run lifecycle ends (shutdown, session switch): a start in flight must not continue into the next session. */
	#generation = 0;
	/** The last live write; the final record waits for it so a late live write never lands on top. */
	#liveWrite: Promise<unknown> = Promise.resolve();
	/** One finalization per run: a second stop during drain joins it instead of writing a second record. */
	#finishing: Promise<RunRecord | undefined> | undefined;
	readonly #timings: StormTimings;
	/** Read-only projection of the run that just closed in this process, so its candidates remain inspectable. */
	#recentIntegration: { sessionDir: string; runId: string; state: IntegrationRunState; rows?: readonly RunResult[] } | undefined;
	/** The last exact projection C computed for the live run; views never read the journal themselves. */
	#lastProjection: { runId: string; projection: CandidateProjection } | undefined;

	constructor(private readonly deps: RunControllerDeps) {
		this.#timings = deps.timings ?? DEFAULT_TIMINGS;
	}

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

	/**
	 * Exact persisted delivery facts for the director's provider projection: the live run's result rows and recorded
	 * deliveries that answer no declared result, by reference. No agents, spend, tree or I/O; the caller must not
	 * mutate them, and the projection's synchronous confirmation runs before anything can.
	 */
	directorDeliveryEvidence(): {
		readonly results: readonly RunResult[];
		readonly unplanned: readonly UnplannedDelivery[];
	} | undefined {
		const own = this.#own;
		return own === undefined
			? undefined
			: { results: own.record.results ?? [], unplanned: own.record.unplanned ?? [] };
	}

	/** This session's run with live spend from the ledger. */
	active(): RunRecord | undefined {
		const own = this.#own;
		if (!own) return undefined;
		if (own.paid !== undefined) this.#ingestPaid(own);
		const live = getLedgerRun(own.record.runId);
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const record: RunRecord = {
			...own.record,
			costUsd: live?.costUsd ?? own.record.costUsd,
			costByModel: { ...(live?.costByModel ?? own.record.costByModel) },
			spawns: [...(spawnsByRun.get(own.record.runId) ?? [])],
			...(agents.length ? { agents } : {}),
		};
		const spend = spendNote(live);
		if (spend !== undefined) record.spend = spend;
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
	 * View-only evidence like `phase`: the director's own path edit holds this run's write table right now (from its
	 * commit to the end of its turn). Never persisted; nothing about the run reads it.
	 */
	directorEditing(): boolean {
		const own = this.#own;
		return own !== undefined && own.lanes.liveHolders(["director-path"]) > 0;
	}

	/**
	 * Checks the approved team and omp's session modes, compacts a heavy main context, records the run and sends the
	 * handoff. The session must be idle. It can take as long as a dialog or a compaction: callers inside an omp event
	 * handler use `launch`.
	 */
	async start(ctx: ExtensionContext, spec: RunSpec, runId = newRunId(this.deps.now())): Promise<RunRequestResult> {
		return this.#start(ctx, spec, runId, { kind: "manual" });
	}

	/**
	 * Starts an automatic probe inside the main turn that is already running, under a caller-validated plan. It sends
	 * no handoff (the turn continues), does not wait for idle or compact, and asks no dialog; the in-flight turn is the
	 * run's first round. The plan is bound before this returns, so the first spawn sees it. When the caller passes the
	 * team hash it validated the plan against, a different approved team refuses the start. `turnStartedAt` is the
	 * message that began this turn: R9's same-turn rule refuses a start after a run of this session and target ended or
	 * stopped at or after it. The wiring passes it for every automatic plan; callers that do not keep 0.28.0's checks.
	 */
	async startWithPlan(ctx: ExtensionContext, spec: RunSpec, plan: RunPlan, configHash?: string, turnStartedAt?: number, authorize?: () => string | undefined): Promise<RunRequestResult> {
		return this.#start(ctx, spec, newRunId(this.deps.now()), {
			kind: "plan",
			authorize,
			plan,
			...(configHash !== undefined ? { configHash } : {}),
			...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
		});
	}

	/**
	 * Opens an automatic run with no plan at the director's first `task` call of a user turn (R9). The caller has
	 * already classified the batch (R6) and gated it against an empty table; this start applies R9's ordered checks
	 * again, opens the run inside the running turn, binds no plan and sends no handoff, and leaves the batch's normal
	 * `task` placement to that same handler. The lease is what the gated batch needs: a batch of safe readers takes the
	 * read claim, a batch with a shared writer or a shell reader takes the write claim. An open that outlives the host's
	 * handler deadline is finished at once as stopped, so it cannot hold the lease with no work.
	 */
	async startPlanless(ctx: ExtensionContext, spec: RunSpec, input: PlanlessStart): Promise<RunRequestResult> {
		return this.#start(ctx, spec, newRunId(this.deps.now()), {
			kind: "planless",
			turnStartedAt: input.turnStartedAt,
			deadline: input.deadline,
			authorize: input.authorize,
			lease: input.lease,
		});
	}

	/**
	 * Continues the interrupted run the `/storm` menu would resume, inside the turn that is already running, the way
	 * `startWithPlan` opens an automatic run: no handoff, no dialog, the in-flight turn is the first round. It is the
	 * same start with the same checks: the candidate is `findResumeCandidate`'s, the pointer must still vouch for it,
	 * the checkpoint is proven again before an accepted result is carried, the goal is carried and `resumeOf` records
	 * the lineage. Its plan is the old one re-validated against the approved team (`normalizeCheckpointPlan`, the
	 * `validatePlan` the `plan` action uses): a plan outside those bounds starts nothing. A run with nothing to carry —
	 * no result rows, or no lane left in force — opens a new run with no plan instead (R12); `continued.mode` says
	 * which of the two happened. The caller has already decided that this is the user's turn and that delegation is
	 * automatic.
	 */
	async continueInTurn(ctx: ExtensionContext, said: string | undefined, turnStartedAt: number, authorize?: () => string | undefined): Promise<RunStartResult> {
		return this.#start(ctx, { task: "" }, newRunId(this.deps.now()), { kind: "continue", said, turnStartedAt, authorize });
	}

	async #start(ctx: ExtensionContext, spec: RunSpec, runId: string, mode: StartMode): Promise<RunStartResult> {
		// A queued run is not in the way of its own start: `onAgentEnd` takes it off the queue first.
		const reason = this.refusal();
		if (reason !== undefined) return refuse(reason);
		const generation = this.#generation;
		this.#starting = true;
		try {
			return await this.#begin(ctx, spec, runId, mode, generation);
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
		asked: RunSpec,
		runId: string,
		mode: StartMode,
		generation: number,
	): Promise<RunStartResult> {
		// Only a manual start waits for its handoff; every other door opens inside the turn that is already running — a
		// first plan, a continuation the director asked for, or a plan-less batch at the turn's first task call.
		const auto = mode.kind !== "manual";
		const continuing = mode.kind === "continue" ? { said: mode.said, turnStartedAt: mode.turnStartedAt } : undefined;
		const planless = mode.kind === "planless" ? mode : undefined;
		let plan: RunPlan | undefined = mode.kind === "plan" ? mode.plan : undefined;
		const configHash = mode.kind === "plan" ? mode.configHash : undefined;
		let requested = asked;
		const denied = (): string | undefined =>
			mode.authorize?.() ?? (planless !== undefined && this.deps.now() >= planless.deadline ? PLANLESS_DEADLINE : undefined);
		const gone = (): Refusal => refuse(denied() ?? "세션이 바뀌어 Storm 실행을 시작하지 않았습니다.");
		const initial = denied();
		if (initial !== undefined) return refuse(initial);
		const state = await this.deps.loadState(ctx);
		if (this.#generation !== generation || denied() !== undefined) return gone();
		// Pure reads, decided in R9's order below: the plan-less gate needs the team's and the shadow's refusals last.
		const gate = teamGate(state);
		const shadow = shadowBlock(state);
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
		// R9: a run of this session and target that ended or stopped at or after this turn's prompt refuses a plan and a
		// plan-less open alike. The plan-less gate runs the rule's checks in its own order: automatic consent, this
		// turn's prompt and its time, the same-turn fact, then the team and mode refusals as its last step.
		if (planless !== undefined) {
			const opened = planlessOpen({
				automatic: true,
				// `#start` refused an active, queued or starting run, and the ledger check above is this store's own.
				runActive: false,
				task: requested.task,
				turnStartedAt: planless.turnStartedAt,
				lastEndAt: lastRunEndAt(sessionDir, root),
				blocked: !gate.ok ? gate.block.reason : shadow?.reason,
			});
			if (!opened.ok) return refuse(opened.reason);
		} else if (mode.kind === "plan") {
			const sameTurn = sameTurnRefusal(mode.turnStartedAt, sessionDir, root);
			if (sameTurn !== undefined) return refuse(sameTurn);
		}
		// R9's step 4 last: the approved team, the team hash the plan was checked against, then a shadowed definition.
		if (!gate.ok) return refuse(gate.block.reason);
		if (configHash !== undefined && gate.hash !== configHash) {
			return refuse("계획을 검증한 팀 설정과 지금 승인된 팀 설정이 다릅니다. 계획을 다시 내세요.");
		}
		if (shadow) return refuse(shadow.reason);
		let continuingFrom: (RunRecord & { request: string }) | undefined;
		if (continuing !== undefined) {
			// The candidate is the menu's own: the newest trusted unfinished run of this session and target.
			const candidate = await findResumeCandidate(sessionDir, target).catch(() => undefined);
			if (this.#generation !== generation || denied() !== undefined) return gone();
			if (candidate === undefined) return refuse(NO_CONTINUABLE_RUN);
			// The user must have spoken after the run stopped. Both times are recorded facts: the run's own end (a run found
			// dead has the time of its last sign of life) and the moment the user's message began this turn. The same
			// millisecond counts as after: no turn begins and runs a run to its stop within one. A record that gives no time
			// cannot be shown to precede the turn.
			const stoppedAt = Date.parse(candidate.endedAt ?? candidate.updatedAt ?? candidate.startedAt);
			if (!Number.isFinite(stoppedAt) || stoppedInTurn(continuing.turnStartedAt, stoppedAt)) return refuse(CONTINUE_SAME_TURN);
			// R9 says every run of this session and target, not only the candidate: a later run that ended after the
			// prompt stands for the same rule, and the candidate's own recorded end is the same fact on disk.
			if (stoppedInTurn(continuing.turnStartedAt, lastRunEndAt(sessionDir, root))) return refuse(CONTINUE_SAME_TURN);
			// A2-5/A2-6: the mode decides first. The stored record is read below; only then is this a carry (a plan
			// with rows to keep) or a handoff (no rows, no plan applied), and only then is the request built.
			continuingFrom = candidate;
			requested = { ...requested, resumeOf: candidate.runId };
		}
		// The host may mutate its session manager in place instead of emitting a switch: every await below must also
		// prove that the context still names this same native session.
		const stale = (): boolean => this.#generation !== generation || closeoutSessionId(ctx) !== sessionId || denied() !== undefined;
		const ui = this.deps.ui(ctx);
		const ready = await this.#ready(ctx, ui, !auto);
		if (stale()) return gone();
		if (!ready.ok) return ready;
		// The run's own preflight compaction is a paid send: bind the exact owner and its zero baseline before it.
		let pendingPaid: PaidAttemptBinding | undefined;
		const boundPaid = this.#bindPaidAttempts(ctx, runId, sessionId, gate.config);
		if (!boundPaid.ok) return refuse(boundPaid.reason);
		pendingPaid = boundPaid.binding;
		const discardPaid = (): void => {
			pendingPaid?.adapter.dispose();
			pendingPaid = undefined;
		};
		if (!auto) await this.#compactFirst(ctx, ui);
		if (stale()) {
			discardPaid();
			return gone();
		}
		// The dialog and the compaction awaited: a run of this session may have started meanwhile.
		if (activeLedgerRun(sessionDir)) {
			discardPaid();
			return busy;
		}

		// The last step before the baseline snapshot: take this session's slot and the target claim the start needs. A
		// safe reader may run beside another session's reader; a writer of any session conflicts. A plan-less batch
		// takes the claim its classification needs before anything of it is placed (R9), so a writer never passes a
		// reader's lease on the way to its reservation. A failed acquisition is a refusal, and everything below releases
		// the lease unless the run takes ownership.
		const writeFirst = planless?.lease === "write";
		let acquired: AcquireRunLeaseResult;
		try {
			acquired = await (this.deps.lease ?? acquireRunLease)({
				sessionDir,
				sessionId,
				root,
				runId,
				mode: writeFirst ? "write" : "read",
				...(writeFirst ? { scope: { kind: "unbounded" as const } } : {}),
			});
		} catch (error) {
			discardPaid();
			return refuse(`실행 잠금을 확인하지 못해 시작하지 않았습니다: ${errorText(error)}`);
		}
		if (stale()) {
			discardPaid();
			if (acquired.ok) await this.#releaseLease(acquired.lease, ctx);
			return gone();
		}
		if (!acquired.ok) {
			discardPaid();
			return refuse(acquired.reason);
		}
		let lease: RunLease | undefined = acquired.lease;
		try {
			const targetBlock = await targetJobBlock(root);
			if (stale()) return gone();
			if (targetBlock !== undefined) return refuse(targetBlock);
			// A required check of an earlier run whose processes were not proven gone still holds this target.
			const checkBlock = uncertainCheckBlock(root);
			if (checkBlock !== undefined) return refuse(checkBlock);
			// A plan that may change the target must hold the write claim before any handoff or spawn can act on it.
			if (plan !== undefined && planNeedsWrite(plan)) {
				const upgraded = await lease.upgrade({ scope: { kind: "unbounded" } });
				if (stale()) return gone();
				if (!upgraded.ok) return refuse(upgraded.reason);
			}
			const startTree = await this.#treeAt(root);
			if (stale()) return gone();
			// A resumed run starts a new record; what it continues is an old record of this same session and target.
			// An automatic probe has no handoff to put it in, so it does not read the old record; only a continuation does.
			const continued = (!auto || continuing !== undefined) && requested.resumeOf !== undefined ? await readRun(sessionDir, requested.resumeOf) : undefined;
			if (stale()) return gone();
			if (requested.resumeOf !== undefined && continued === undefined) return refuse("이전 실행을 읽을 수 없어 안전하게 이어갈 수 없습니다.");
			if (continued !== undefined && !(await trustedResume(sessionDir, target, continued))) {
				return refuse("이 세션과 이 작업 트리에서 시작한 실행만 이어갈 수 있습니다.");
			}
			if (continuing !== undefined && !resumableRun(continued)) return refuse(NO_CONTINUABLE_RUN);
			// A fresh direction picked from a settled card may name its source for background only. The source must be a
			// finished record of this session's own store that this machine started on this same target; a stale or
			// foreign reference is declined rather than read into the handoff. Nothing of it is restored: no plan, row,
			// receipt or exclusion. An automatic probe or a resume never carries one.
			let followUp: RunRecord | undefined;
			if (requested.followUpOf !== undefined) {
				if (auto || requested.resumeOf !== undefined) return refuse(FOLLOW_UP_DECLINED);
				const source = await readRun(sessionDir, requested.followUpOf).catch(() => undefined);
				if (stale()) return gone();
				if (source === undefined || source.status === "running") return refuse(FOLLOW_UP_DECLINED);
				const trusted = await trustedResume(sessionDir, target, source).catch(() => false);
				if (stale()) return gone();
				if (!trusted) return refuse(FOLLOW_UP_DECLINED);
				followUp = source;
			}
			const restoredPlan = continued?.plan === undefined ? undefined : normalizeCheckpointPlan(gate.config, continued.plan);
			// A continuation with rows needs a plan the approved team could be given today (the same bounds a submitted
			// plan is held to); with nothing to carry there is no plan to hold, and the open becomes a handoff below.
			const carriedRows = Array.isArray(continued?.results) ? continued.results.length : 0;
			if (continuing !== undefined && carriedRows > 0 && restoredPlan === undefined) return refuse(CONTINUE_PLAN_REFUSED);
			// A continuation keeps the user's exclusions: only a stored row whose shape and contract still validate may
			// remove a lane from the effective plan. The record is untrusted input; an arbitrary scope marker cannot
			// hide a planned lane.
			const priorExcluded = (continued?.results ?? []).filter(row => {
				if (row?.scope !== "excluded-by-user" || typeof row.id !== "string" || row.contract === undefined) return false;
				const contract = normalizeCheckpointContract(row.contract);
				return contract !== undefined && contract.id === row.id && row.identity === resultContractIdentity(contract);
			});
			if (plan !== undefined) plan = stripExcludedPlan(plan, priorExcluded);
			else if (restoredPlan !== undefined) plan = stripExcludedPlan(restoredPlan, priorExcluded);
			// R12: a continuation with nothing to carry — no result rows at all, or no lane left to carry them under — is
			// a handoff: a new run, no plan applied, nothing re-proved. Where 0.28.0 refused with CONTINUE_NO_LANES, the
			// caller now gets `continued.mode: "handoff"` and says 인계.
			const handoffContinuation = continuing !== undefined && (carriedRows === 0 || plan === undefined);
			if (handoffContinuation) plan = undefined;
			// A2-5/A2-6: the request follows the mode. A carry keeps the old plan's scope instruction; a handoff stores
			// the user's fresh instruction with the earlier material as bounded, labelled background. Only a carry of
			// rows takes the write claim its restored plan needs; a handoff is a reader until it asks to write.
			if (continuing !== undefined && continuingFrom !== undefined) {
				const built = handoffContinuation
					? handoffSpec(continuingFrom, continuing.said)
					: resumeSpec(continuingFrom, continuing.said);
				if (!built.ok) return refuse(built.error);
				requested = built.spec;
				if (!handoffContinuation && plan !== undefined && planNeedsWrite(plan)) {
					const upgraded = await lease.upgrade({ scope: { kind: "unbounded" } });
					if (stale()) return gone();
					if (!upgraded.ok) return refuse(upgraded.reason);
				}
			}
			// A resume continues its parent's goal; a follow-up and a fresh run start their own. Fixed here, never updated.
			const goal = continued === undefined ? undefined : carryGoal(continued);
			const resume =
				continued === undefined
					? undefined
					: {
							runId: continued.runId,
							...(continued.endReason !== undefined ? { endReason: continued.endReason } : {}),
							...(continued.turns !== undefined ? { turns: continued.turns } : {}),
							...(continued.request !== undefined ? { requestLength: continued.request.length } : {}),
							...(requested.resumeNote !== undefined ? { said: requested.resumeNote } : {}),
							...(goal !== undefined ? { goal } : {}),
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
				...(goal !== undefined ? { goal } : {}),
				...(followUp !== undefined ? { followUpOf: followUp.runId } : {}),
				costUsd: 0,
				costByModel: {},
				...(config.budget ? { budget: config.budget } : {}),
				spawns: [],
				...artifactsOf(ctx),
				process: processKey(),
				turns: 0,
				...(roundLimit === undefined ? {} : { maxRounds: roundLimit }),
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
				// The run reads the director session's own background jobs through the lane table: a command the director sent to
				// the background is a holder there, and a worker's task job that still runs keeps its reservation.
				lanes: new RunLanes(runId, () => hostJobRows(ctx)),
				attempts: new Map(),
				attemptSerial: 0,
				planRevision: 0,
				retryAcks: new Set(),
				laneAttempt: new Map(),
				settled: new Map(),
				settledEpoch: new Map(),
				notices: [],
				noticed: new Set(),
				startableTold: new Set(),
				writersTold: new Set(),
				restoredLanes: new Set(),
				settling: new Set(),
				abort: new AbortController(),
				checks: new Map(),
				// An automatic probe starts inside a turn whose `agent_start` already happened: it is round one, not a run
				// waiting for a handoff turn that will never begin.
				turnStarted: auto,
				inTurn: auto,
				...(auto ? { auto, roundInFlight: 1 } : {}),
				...(mode.kind === "planless" ? { planless: true } : {}),
				...(roundLimit === undefined ? {} : { maxRounds: roundLimit }),
				awaitingAsync: false,
				...(startTree !== undefined ? { tree: startTree.state, base: startTree.base } : {}),
				...(requested.minutes !== undefined ? { minutes: requested.minutes } : {}),
			};
			if (continued !== undefined && !handoffContinuation) {
				const receipts = checkpointReceipts(continued);
				if (receipts.length > 400) return refuse("이전 정형 작업 기록이 너무 많아 중복 실행 없이 이어갈 수 없습니다.");
				if (receipts.length > 0) record.jobs = receipts;
			}
			if (continued !== undefined && !handoffContinuation) {
				await this.#restoreCheckpoint(own, continued, plan);
				const current = await this.deps.loadState(ctx).catch(() => undefined);
				if (stale()) return gone();
				if (current === undefined || current.sessionDir !== sessionDir || current.repo.root !== root ||
					current.repo.repoId !== target.repoId || current.config.status !== "ok" ||
					current.config.hash !== hash || !isApproved(current)) return refuse("승인 또는 작업 대상이 바뀌어 체크포인트를 적용하지 않았습니다.");
			}
			if (stale()) return gone();
			// A stored record is untrusted input: build the message before anything of this run exists, so a bad plan or
			// reason refuses the start instead of leaving a current run without a handoff.
			let handoff: string | undefined;
			if (!auto) {
				try {
					const rows = own.record.results ?? [];
					const kept = rows.filter(row => row.restoredFrom !== undefined && row.state === "accepted").length;
					const blocked = rows.filter(row => row.remedy === "blocked").length;
					const checkpoint = continued === undefined || (restoredPlan === undefined && rows.length === 0 && !record.jobs?.length)
						? undefined
						: {
								kept, reopened: rows.length - kept - blocked, blocked,
								laneNames: plan?.lanes.filter(lane => !own.restoredLanes.has(lane.name)).map(lane => lane.name) ?? [],
								...(plan === undefined ? { planUnavailable: true as const } : {}),
							};
					// The earlier run's final facts are history for an explicit resume or a chosen follow-up only; an
					// unrelated task carries none.
					const earlier = continued ?? followUp;
					const earlierProjection = earlier === undefined || this.deps.integration?.(own.sessionDir) === undefined
						? undefined
						: await this.project({ kind: "overview", runId: earlier.runId }, this.#readWindow(), own.sessionDir).catch(() => undefined);
					const history = earlier === undefined
						? undefined
						: (closeoutHandoff as unknown as (run: RunRecord, integration?: CandidateProjection) => string)(
								earlier,
								earlierProjection?.kind === "not-recorded" || earlierProjection === undefined ? undefined : earlierProjection,
							);
					handoff = buildHandoff({ runId, config, hash, task, ...(roundLimit === undefined ? {} : { maxRounds: roundLimit }),
						...(resume === undefined ? {} : { resume: { ...resume, ...(checkpoint === undefined ? {} : { checkpoint }) } }),
						...(history === undefined || history === "" ? {} : { history: { text: history, ...(followUp !== undefined ? { followUp: true } : {}) } }) });
				} catch (error) {
					return refuse(`실행 계약을 만들지 못해 시작하지 않았습니다: ${errorText(error)}`);
				}
			}
			// Seed the record while no live writer can observe it or schedule a flush.
			this.#syncResults(own);
			let written = false;
			let pointed = false;
			const assertLive = (): void => {
				if (stale()) throw new Error(gone().reason);
			};
			const rollback = async (): Promise<void> => {
				if (pointed) await discardStartPointer(sessionDir, target, record);
				if (written) await discardStartRecord(sessionDir, record);
			};
			try {
				await publishRun(sessionDir, record, assertLive);
				written = true;
				try {
					await noteResumePointer(sessionDir, target, record, assertLive);
					pointed = true;
				} catch (error) {
					assertLive();
					if (record.resumeOf !== undefined) {
						await rollback();
						return stale() ? gone() : refuse(RESUME_POINTER_FAILED);
					}
				}
				assertLive();
			} catch (error) {
				await rollback();
				return stale() ? gone() : refuse(`실행을 기록하지 못해 시작하지 않았습니다: ${errorText(error)}`);
			}
			// No wait between the last authorization check and the live run that takes the lease.
			own.lease = lease;
			lease = undefined;
			if (mode.authorize !== undefined) own.provisional = true;
			this.#own = own;
			userWaits.delete(runId);
			phaseWatchers.set(runId, () => this.#emitPhase(own));
			try {
				startLedgerRun({
					runId,
					sessionId,
					directorId: ctx.agent.id,
					sessionDir,
					repoId: own.repoId,
					root: own.root,
					...artifactsOf(ctx),
					...(own.base !== undefined ? { base: own.base } : {}),
					...(config.budget ? { budget: config.budget } : {}),
					onThreshold: (kind, run) => this.#threshold(ctx, kind, run),
				});
				if (pendingPaid !== undefined) {
					this.#adoptPaidAttempts(own, pendingPaid);
					pendingPaid = undefined;
				}
				// Bound before anything below awaits: a spawn decided the moment this returns must see the first plan.
				if (plan !== undefined) setLedgerPlan(runId, plan);
				spawnsByRun.set(runId, []);
				lastSpawnByKey.set(runId, new Map());
				deliveryKindsByRun.set(runId, new Map());
				expectedByRun.set(runId, new Map());
				noticeSinks.set(runId, text => {
					if (this.#own === own) own.notices.push(text);
				});
				openRunReads(runId);
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
			if (continuing !== undefined && continued !== undefined) {
				if (handoffContinuation) {
					// A handoff: the old run's request opens the new run, nothing of its plan or rows is applied.
					return {
						ok: true,
						runId,
						continued: { mode: "handoff", from: continued.runId, ended: stopWords(continued.endReason), kept: 0, reopened: 0, blocked: 0, open: [], ...(carriedRows > 0 && priorExcluded.length === carriedRows ? { allExcluded: true } : {}) },
					};
				}
				const rows = own.record.results ?? [];
				const kept = rows.filter(row => row.restoredFrom !== undefined && row.state === "accepted").length;
				const blocked = rows.filter(row => row.remedy === "blocked").length;
				const open = (plan?.lanes ?? []).filter(lane => !own.restoredLanes.has(lane.name)).map(lane => lane.name);
				return {
					ok: true,
					runId,
					continued: { mode: "carry", from: continued.runId, ended: stopWords(continued.endReason), kept, reopened: rows.length - kept - blocked, blocked, open: open.slice(0, 12) },
				};
			}
			return { ok: true, runId };
		} finally {
			if (pendingPaid !== undefined) pendingPaid.adapter.dispose();
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
		const blocked = ompModeBlock(state);
		if (blocked === "goal") {
			return refuse("omp 목표 모드가 켜져 있어 시작하지 않았습니다. 목표를 끝내거나 일시 정지한 뒤 다시 하세요.");
		}
		if (blocked === "loop") return refuse("omp 반복 모드가 켜져 있어 시작하지 않았습니다. 반복을 끈 뒤 다시 하세요.");
		// Plan mode holds the session to planning. The automatic start already refuses in it; a hand start follows suit.
		if (blocked === "plan") return refuse(PLAN_MODE_START_REFUSAL);
		if (blocked !== "vibe") return { ok: true };
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
		// Only a share of the model's own window: with no known window Storm starts no compaction.
		const threshold = windowThreshold(RUN_START_WINDOW_SHARE, usage?.contextWindow);
		if (!usage || threshold === undefined || usage.tokens < threshold) return;
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
	 * Captures the run (and the session asking) before a caller's awaits and returns the proof its synchronous commit step runs
	 * after them (`RunLanes.commitWriter`'s `live`): the run object is still this controller's, it is not ending, its signal is not
	 * aborted, no start or finish has happened since, and the session is still the one that owns the run. With no run to capture
	 * the proof is a refusal. The check reads live state each time it is called and never yields.
	 */
	liveCheck(ctx?: ExtensionContext): () => LiveCheck {
		const own = this.#own;
		const generation = this.#generation;
		return () => {
			if (own === undefined || this.#own !== own || this.#generation !== generation) return { ok: false, reason: DIRECTOR_WRITE_ENDING };
			if (own.ending !== undefined || own.abort.signal.aborted) return { ok: false, reason: DIRECTOR_WRITE_ENDING };
			if (ctx !== undefined && closeoutSessionId(ctx) !== own.sessionId) return { ok: false, reason: DIRECTOR_WRITE_ENDING };
			return { ok: true };
		};
	}

	/**
	 * Current facts for the prerequisite edges of a task/follow-up admission. It reads the run's own result ledger and
	 * re-locates every accepted result at its current source: an isolated artifact only from its verified retained
	 * source, shared content only from the current parent. A director's "applied" claim is never proof, and only the
	 * lanes a plan's edges name are inspected.
	 */
	async laneReadiness(plan: RunPlan, needed: ReadonlySet<string>): Promise<Map<string, LaneReadiness>> {
		const own = this.#own;
		if (own === undefined) return new Map<string, LaneReadiness>();
		// A native delivery can land just before the consumer's call. Wait only for the prerequisites this admission
		// actually reads, and never past a bounded window: a running producer still blocks.
		await this.#awaitSettlements(own, needed, this.#timings.settleWaitMs);
		return this.#readLaneReadiness(own, plan, needed);
	}

	/** The same read as `laneReadiness` without waiting for settlements: what the ledger holds at this moment. */
	async #readLaneReadiness(own: OwnRun, plan: RunPlan, needed: ReadonlySet<string>): Promise<Map<string, LaneReadiness>> {
		const view = new Map<string, LaneReadiness>();
		this.#syncResults(own);
		// A consumer reads answers only at their recorded cited bytes: an edited or deleted source reopens that answer
		// (and, transitively, what already consumed it) in the record before any readiness is reported.
		await this.#revokeUnlocatedAccepted(own, true);
		if (this.#own !== own) return view;
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
				if (state === "accepted" || (state === "reviewable" && row?.restoredFrom !== undefined && result.kind === "change")) {
					// An accepted result is usable only from the location S1 can still prove now: a retained source for an
					// isolated artifact, the current parent for shared content. A revert or a vanished patch blocks consumers.
					const location = await this.#acceptedLocation(own, result, isolated, row);
					if (!location.ok) {
						state = "unmet";
						retainedReason = location.reason;
					} else {
						integrated = location.integrated;
						retained = location.retained;
						// An isolated producer's retained artifact has no integrated location; an integrated change does, and
						// then this reason is absent. The reason is carried beside the result for the consumer's refusal.
						if (isolated && !integrated && result.kind !== "answer" &&
							!(result.kind === "change" && own.integration?.receipts.get(result.id) !== undefined)) {
							retainedReason = ISOLATED_INTEGRATED_REASON;
						}
					}
				} else if (result.kind === "answer" && state === "reviewable" && row !== undefined) {
					// A consumer that may start from a reviewable answer still starts only from the cited bytes S1 read.
					const problem = await this.#answerReceiptProblem(own, row);
					if (problem !== undefined) {
						state = "unmet";
						retainedReason = problem;
					}
				} else if (isolated && result.kind === "artifact" && state === "reviewable") {
					// A reviewable isolated artifact is not a usable source: its submission has no accepted digest to read.
					const evidence = row?.proof;
					state = "unmet";
					retainedReason = evidence === undefined || row?.attemptId === undefined || row.identity === undefined
						? "보존된 산출물의 시도 근거를 확인하지 못했습니다."
						: "보존된 산출물의 근거가 현재 계약과 다릅니다.";
				}
				// The record's row still stands accepted or reviewable (it carries the version a consumer would bind) although
				// the location check above found it unusable now. A row that never stood (answered, judged unmet) is not this.
				const standing = state === "unmet" && (row?.state === "accepted" || row?.state === "reviewable");
				const citation = (row?.proof?.item ?? (row !== undefined && result.kind === "answer" ? this.#answerReceipt(own, row) : undefined))?.citation;
				// The ledger's own reason travels with a result that is not usable (unmet, reviewable): a consumer's refusal
				// can then say why, instead of only naming the state. A reason found while re-locating wins.
				const reason = retainedReason ?? (state === "unmet" || state === "reviewable" ? row?.reason : undefined);
				results.push({
					id: result.id,
					kind: result.kind,
					state,
					integrated,
					...(row?.contentVersion === undefined ? {} : { version: row.contentVersion }),
					...(standing ? { standingVersion: true as const } : {}),
					...(result.path === undefined ? {} : { path: result.path }),
					...(citation === undefined ? {} : { citation: { path: citation.path, ...(citation.line === undefined ? {} : { line: citation.line }) } }),
					...(retained === undefined ? {} : { retained }),
					...(reason === undefined ? {} : { reason }),
					...(isolated ? { isolated: true as const } : {}),
				});
			}
			const settled = coverage.get(name) === true;
			const handle = own.lanes.agentForLane(name);
			const running =
				own.settling.has(name) ||
				[...own.attempts.values()].some(prepared => prepared.lane === name) ||
				(handle !== undefined && agents.some(agent => agent.id === handle && agent.state === "running"));
			const resultlessIntegrated = sharedTeam && lane.isolationReason === undefined
				? settled
				: this.deps.integration?.(own.sessionDir) !== undefined && isolated
					? (await this.#currentFootprint(own, name, this.#readWindow())) !== undefined
					: false;
			view.set(name, {
				results,
				settled,
				running,
				// A legacy/resultless lane is integrated by the shared tree, or by a current receipt of its whole footprint.
				integrated: results.length === 0 ? resultlessIntegrated : results.every(result => result.integrated),
				...(handle === undefined ? {} : { handle }),
			});
		}
		return view;
	}

	/**
	 * One accepted result's current, usable location, re-read from S1 evidence rather than a status claim: an isolated
	 * artifact only from its verified retained source, shared content from the current parent, and an answer from its
	 * recorded anchor citation, whose bytes must still match what S1 judged (also for a review-accepted answer). A review-accepted row has no attempt digest to
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
		const restoredSubmission = row?.restoredFrom !== undefined && row.proof !== undefined &&
			result.kind === "change" && (row.state === "reviewable" || row.origin === "review");
		if (row === undefined || (row.state !== "accepted" && !restoredSubmission) || row.attemptId === undefined) {
			return { ok: false, reason: "수용된 결과가 없습니다." };
		}
		// An accepted row whose recorded producer versions changed is no longer proof, even before a later pass writes
		// the invalidation reason: a consumer must not start from it.
		if (hasStaleInputs(row, own.record.results ?? [])) {
			return { ok: false, reason: "선행 결과가 바뀌어 이전 근거를 다시 확인해야 합니다." };
		}
		// An isolated change is judged only from the exact current integration receipt. With integration disabled the
		// 0.29.0 refusal stands; with it enabled, a missing or drifted receipt is a named location failure, never credit
		// from whatever bytes happen to be in the parent (ISO P7-B).
		let receiptVerified = false;
		if (result.kind === "change") {
			const recorded = own.integration?.receipts.get(row.id);
			if (this.deps.integration?.(own.sessionDir) === undefined) {
				if (isolated === true) return { ok: false, reason: ISOLATED_CHANGE_REASON };
			} else if (isolated === true || recorded !== undefined) {
				if (recorded === undefined || recorded.attemptId !== row.attemptId) {
					return { ok: false, reason: "이 격리 변경에는 현재 통합 영수증이 없습니다. 통합을 선택해야 수용 근거가 됩니다." };
				}
				const verified = await this.#verifyReceiptState(own, result, row, recorded, this.#readWindow());
				if (!verified.ok) {
					return { ok: false, reason: `통합 영수증을 현재 확인하지 못했습니다(${verified.problem.code}).` };
				}
				receiptVerified = true;
			}
		}
		if (restoredSubmission) {
			const source = await revalidateCheckpointProof({ row, result, root: own.root, forReview: true });
			if (!source.ok) return source;
			if (row.state === "reviewable") return { ok: true, integrated: true };
		}
		if (result.kind === "answer") {
			// An answer has no tree location, but it does have the exact cited bytes S1 judged. A live, restored or
			// review-accepted answer is usable only while that anchor still reads the same; a deleted or edited source
			// is no longer proof for a consumer or for the final label.
			if (row.restoredFrom !== undefined && row.proof !== undefined && row.origin !== "review") {
				const source = await revalidateCheckpointProof({ row, result, root: own.root, isolated: false });
				if (!source.ok) return source;
			}
			const problem = await this.#answerReceiptProblem(own, row);
			if (problem !== undefined) return { ok: false, reason: problem };
			return { ok: true, integrated: false };
		}
		if (row.origin === "review" && !receiptVerified) return { ok: true, integrated: false };
		const evidence = row.proof;
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
		if (own.ending !== undefined || own.abort.signal.aborted || own.finalizing === true) {
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
		// A lane removed by a user exclusion (or any replan) is no longer authority for a prepared dispatch. A caller
		// that captured the old plan must not spawn under it; a plan-less legacy lane keeps its old behavior.
		if (own.record.plan !== undefined && lane === undefined) {
			return { ok: false, reason: "이 레인은 현재 계획에 없습니다(사용자 제외 포함). 다시 계획하거나 스폰하지 말고 남은 계획을 진행하세요." };
		}
		// A stale plan that still names a user-excluded result must not spawn its lane. The exclusion is authoritative in
		// the ledger even when a restored or replayed plan disagrees.
		if (lane?.results?.some(result => own.record.results?.some(row => row.id === result.id && row.scope === "excluded-by-user"))) {
			return { ok: false, reason: "사용자가 범위에서 제외한 결과의 레인입니다. 다시 계획하거나 스폰하지 말고 남은 계획을 진행하세요." };
		}
		if (lane?.results === undefined || lane.results.length === 0) return { ok: true };
		if (own.restoredLanes.has(lane.name)) {
			await this.#revokeUnlocatedAccepted(own, true);
			if (this.#own !== own || own.record.plan?.lanes.find(candidate => candidate.name === input.lane) !== lane) {
				return { ok: false, reason: "체크포인트 확인 중 실행 또는 계획이 바뀌었습니다." };
			}
			if (lane.results.every(result => own.record.results?.some(row => row.id === result.id &&
				(row.state === "accepted" || (row.state === "reviewable" && row.restoredFrom !== undefined))))) {
				return { ok: false, reason: "[storm:checkpoint-kept] 결과를 현재 근거로 복원했습니다. 남은 레인 또는 새 리뷰를 진행하세요." };
			}
		}
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
		// The baseline read awaits: a plan change or a user exclusion may have removed or replaced this exact lane.
		// Never bind the captured before state to an obsolete plan, owner or stopping run.
		if (this.#own !== own || own.ending !== undefined || own.abort.signal.aborted) {
			return { ok: false, reason: "기준선을 만드는 동안 실행이 바뀌어 작업을 시작하지 않았습니다." };
		}
		if (own.record.plan?.lanes.find(candidate => candidate.name === input.lane) !== lane) {
			return { ok: false, reason: "기준선을 만드는 동안 계획이 바뀌어 작업을 시작하지 않았습니다. 새 계획 아래에서 다시 스폰하세요." };
		}
		const retry = own.retry;
		let retryTaken: RetryTaken | undefined;
		if (retry !== undefined && retry.lane === lane.name) {
			if (this.#retryMatches(own, retry)) {
				delete own.retry;
				retryTaken = this.#markRetryTaken(own, retry);
				this.#scheduleFlush(own);
			} else {
				delete own.retry;
				own.retryAcks.delete(retry.key);
				this.deps.ui(own.ctx).notify("계획이나 입력이 바뀌어 예약한 재시도를 적용하지 않았습니다. 현재 계획의 정상 시도로만 진행합니다.", "warning");
			}
		}
		// Snapshot the producer versions now, before the child runs: this attempt's evidence may only be used against
		// these versions. A newer attempt of the same lane fences this one even if its settlement arrives later.
		const epoch = ++own.attemptSerial;
		own.laneAttempt.set(lane.name, epoch);
		const consumed = inputSnapshot(own.record.plan, lane, own.record.results);
		const declared = declaredInputs(own.record.plan, lane);
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
			...(lane.isolationReason !== undefined || own.config.isolation === "isolated" ? { isolated: true as const } : {}),
			...(consumed.length === 0 ? {} : { consumed }),
			declaredInputs: declared,
			...(lane.files === undefined ? {} : { laneFiles: lane.files }),
			baseline: capture.baseline,
			...(retryTaken === undefined ? {} : { retryTaken }),
		});
		return { ok: true };
	}

	/**
	 * Drops one prepared dispatch whose follow-up write never reached the worker, so nothing will ever settle it. The
	 * lane stops reading as running for it, and the fence it raised goes back to the newest attempt that is still real:
	 * an earlier open dispatch settles normally, and an earlier settled one is not made stale by a turn that never ran.
	 * A dispatch that is unknown, already settled or from another run is ignored.
	 */
	async discardAttempt(input: { runId: string; dispatch: string }): Promise<void> {
		const own = this.#own;
		if (own === undefined || own.record.runId !== input.runId || own.finalizing === true) return;
		const prepared = own.attempts.get(input.dispatch);
		if (prepared === undefined) return;
		own.attempts.delete(input.dispatch);
		// A write that never reached the worker did not use the user's retry. The grant goes first, before the fence
		// decision below can return: several writes of one director message each open a dispatch and the grant sits on
		// the first, which need not be the newest, so a failed write that is not the lane's newest still holds it. If a
		// newer dispatch of the lane remains, that is the attempt which will run (or be discarded next), and it carries the
		// grant on; otherwise nothing will run for it and it is owed to the user again, with the row no longer claiming
		// a retry is running.
		if (prepared.retryTaken !== undefined) {
			const later = [...own.attempts.values()]
				.filter(other => other.lane === prepared.lane && other.epoch > prepared.epoch)
				.sort((a, b) => b.epoch - a.epoch)[0];
			if (later !== undefined && later.retryTaken === undefined) later.retryTaken = prepared.retryTaken;
			else this.#giveRetryBack(own, prepared.retryTaken);
		}
		if (own.laneAttempt.get(prepared.lane) !== prepared.epoch) return;
		const open = [...own.attempts.values()].filter(other => other.lane === prepared.lane).map(other => other.epoch);
		const newest = fenceAfterDiscard(own.settledEpoch.get(prepared.lane), open);
		if (newest === 0) own.laneAttempt.delete(prepared.lane);
		else own.laneAttempt.set(prepared.lane, newest);
	}

	/**
	 * Settles exactly one prepared dispatch. Only an exact, usable host report may bind `attemptId`; a missing,
	 * stale or mismatched report leaves the requirement unresolved with a compact reason, and a late settlement for
	 * a run that is no longer this session's is ignored. Evaluation never trusts model text as a path or a verdict.
	 */
	async settleAttempt(input: AttemptSettlement): Promise<void> {
		const own = this.#own;
		if (own === undefined || own.record.runId !== input.runId || own.finalizing === true) return;
		const prepared = own.attempts.get(input.dispatch);
		if (prepared === undefined) return;
		own.attempts.delete(input.dispatch);
		// A lane's dispatches settle newest-last: every older open dispatch of the lane (a follow-up joined an open turn,
		// or a retry replaced an agent that never delivered) can only be a superseded one. Its settlement would be
		// ignored below; left open it would keep the lane reading as running and, at the end of the run, rewrite rows
		// that this newer attempt already judged.
		for (const [key, older] of own.attempts) {
			if (older.lane === prepared.lane && older.epoch < prepared.epoch) own.attempts.delete(key);
		}
		own.settling.add(prepared.lane);
		// Set once this delivery passed both fences: only then did it decide anything the director could be told.
		let decided = false;
		try {
			// A newer attempt of this lane already started: its settlement governs the requirement. The older attempt
			// must not reinstate a success (or a failure) even when the host delivers it late.
			if (prepared.epoch < (own.laneAttempt.get(prepared.lane) ?? 0)) return;
			const satisfied = await this.#settledInputSatisfaction(own, prepared);
			// The integration read awaited: a newer attempt or another owner may have taken over meanwhile.
			if (this.#own !== own || prepared.epoch < (own.laneAttempt.get(prepared.lane) ?? 0)) return;
			own.settledEpoch.set(prepared.lane, Math.max(own.settledEpoch.get(prepared.lane) ?? 0, prepared.epoch));
			decided = true;
			const report = input.report;
			// The collector refused this delivery as the earlier turn's repeat and only closes the dispatch: the rows keep the
			// verdict, the attempt id and the reason the earlier turn gave, whatever state they are in.
			if (report.captureError === "attempt-replayed" && report.attemptId === undefined) return;
			const exact =
				attemptUsable(report) &&
				report.runId === input.runId &&
				report.parentId === input.parentId &&
				report.spawnKey === input.spawnKey;
			// The plan replaced this attempt's logical inputs after it started (B@1 → C@1, an added/removed input or a
			// level strengthened beyond what the producer satisfies). Whatever the host says about it, its output answers
			// the old contract: it can neither settle the new one nor leave an exhausted-route remedy that would block the
			// rerun the replan asked for.
			if (!this.#declaredInputsCurrent(own, prepared, satisfied)) {
				this.#applySupersededAttempt(own, prepared, exact ? report.attemptId : undefined);
				return;
			}
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
			if (this.#staleInputs(own, prepared, satisfied)) {
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
				spawnKey: input.spawnKey,
				...(input.reportText === undefined ? {} : { reportText: input.reportText }),
				...(input.reportPartial === true ? { reportPartial: true as const } : {}),
				citations: [...input.citations],
				...(artifact === undefined ? {} : { artifact }),
			};
			own.settled.set(prepared.lane, settled);
			await this.#evaluateAttempt(own, settled);
			this.#scheduleFlush(own);
		} finally {
			own.settling.delete(prepared.lane);
			// Queued before the settlement is reported done, so whoever awaited it (a `wait` result, a pushed delivery)
			// finds the notice when it comes to deliver it. Never lets a failed read hide or break the settlement.
			if (decided) await this.#noteLedgerChange(own, prepared, input.dispatch).catch(() => undefined);
			this.#wakeSettlementWaiters();
		}
	}

	/**
	 * Queues what the director should read about one evaluated delivery, once per attempt: the results Storm did not
	 * accept (state, the ledger's reason; `ledgerNotice` adds the answer citation form) and the waiting lanes whose
	 * prerequisites now all hold. An accepted delivery nothing waits on adds nothing. The readiness it reads is the
	 * ledger as it stands, with no waiting for other settlements; it changes no plan, spawns nothing and admits nothing,
	 * and the spawn guard decides again at the spawn.
	 */
	async #noteLedgerChange(own: OwnRun, prepared: PreparedAttempt, dispatch: string): Promise<void> {
		if (this.#own !== own || own.noticed.has(dispatch)) return;
		own.noticed.add(dispatch);
		// A newer attempt of the lane governs its results now; this one decided nothing the director still needs.
		if (prepared.epoch < (own.laneAttempt.get(prepared.lane) ?? 0)) return;
		const startable = await this.#startableAfter(own, prepared.lane);
		if (this.#own !== own) return;
		const rows = own.record.results ?? [];
		const open = prepared.results.flatMap((result): LedgerNoticeRow[] => {
			const row = rows.find(candidate => candidate.id === result.id);
			if (row === undefined || row.state === "accepted") return [];
			return [{ id: result.id, kind: result.kind, state: row.state, ...(row.reason === undefined ? {} : { reason: row.reason }) }];
		});
		const text = ledgerNotice({ lane: prepared.lane, open, startable });
		if (text !== undefined) own.notices.push(text);
	}

	/** Lanes of the plan nothing has started: no worker, no open or settled attempt, no job, and a result still owed. */
	#unstartedLanes(own: OwnRun, plan: RunPlan): PlanLane[] {
		const rows = own.record.results ?? [];
		return plan.lanes.filter(candidate => {
			if (own.restoredLanes.has(candidate.name) || own.lanes.agentForLane(candidate.name) !== undefined) return false;
			if ([...own.attempts.values()].some(prepared => prepared.lane === candidate.name) || own.settled.has(candidate.name)) return false;
			if (candidate.job !== undefined && own.record.jobs?.some(job => job.lane === candidate.name)) return false;
			const results = candidate.results ?? [];
			return results.length === 0 || results.some(result => rows.find(row => row.id === result.id)?.state !== "accepted");
		});
	}

	/**
	 * When the worker that held the shared write order ended, the unstarted writing lanes the placement gate would now let
	 * start, as one line, once per lane until it starts or the order holds it again. Nothing is started: the director
	 * reads it where it reads a delivery. A run that cannot read the team's authority, or with no plan, says nothing.
	 */
	async #writersFreed(own: OwnRun): Promise<string | undefined> {
		const plan = own.record.plan;
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		if (!own.lanes.takeWriterFreed(agents, Date.now()) || plan === undefined || this.deps.lanePolicies === undefined) return undefined;
		const candidates = this.#unstartedLanes(own, plan).filter(lane => lane.job === undefined);
		if (candidates.length === 0) return undefined;
		const view = await this.deps.lanePolicies(own.record.runId, plan);
		if (view === undefined || this.#own !== own) return undefined;
		const needed = new Set(candidates.flatMap(lane => (lane.dependsOn ?? []).map(edge => edge.lane)));
		const readiness = needed.size === 0 ? undefined : await this.#readLaneReadiness(own, plan, needed);
		if (this.#own !== own) return undefined;
		const startable = own.lanes.startableWriters(candidates, own.config, {
			policies: view.policies,
			canonicalFiles: view.canonicalFiles,
			...(readiness === undefined ? {} : { readiness }),
			agents: this.deps.agents?.(own.record.runId, own.sessionDir) ?? [],
			now: Date.now(),
		});
		for (const name of [...own.writersTold]) if (!startable.includes(name)) own.writersTold.delete(name);
		const fresh = startable.filter(name => !own.writersTold.has(name));
		for (const name of fresh) own.writersTold.add(name);
		return writerFreedNotice(fresh);
	}

	/**
	 * What the director reads at its next request: the ledger lines queued by evaluated deliveries and unplanned
	 * deliveries, then the one line about a freed write place. Taking empties both, so each is read once.
	 */
	async noticesForDirector(): Promise<string | undefined> {
		const own = this.#own;
		if (own !== undefined) {
			const line = await this.#writersFreed(own).catch(() => undefined);
			if (line !== undefined && this.#own === own) own.notices.push(line);
		}
		return this.takeNotices();
	}

	/**
	 * Waiting lanes that name `lane` as a prerequisite and whose every prerequisite now holds, by the same
	 * `dependencyBlock` the spawn guard asks. A lane already started, restored or fully accepted does not wait. A lane is
	 * named once until it stops being startable or starts.
	 */
	async #startableAfter(own: OwnRun, lane: string): Promise<string[]> {
		const plan = own.record.plan;
		if (plan === undefined) return [];
		const waiting = this.#unstartedLanes(own, plan).filter(candidate => (candidate.dependsOn ?? []).some(edge => edge.lane === lane));
		if (waiting.length === 0) return [];
		const needed = new Set(waiting.flatMap(candidate => (candidate.dependsOn ?? []).map(edge => edge.lane)));
		const view = await this.#readLaneReadiness(own, plan, needed);
		if (this.#own !== own) return [];
		const startable: string[] = [];
		for (const candidate of waiting) {
			if (dependencyBlock(candidate, view) !== undefined) {
				own.startableTold.delete(candidate.name);
			} else if (!own.startableTold.has(candidate.name)) {
				own.startableTold.add(candidate.name);
				startable.push(candidate.name);
			}
		}
		return startable;
	}

	/**
	 * A work message of the director asked this worker for a delivery. When the worker was idle at send time the caller
	 * marks the expectation provisional: the receipt can still say omp folded the message into an open turn. Each wake
	 * is its own token, in send order, so a late receipt never credits a later arrival (B8).
	 */
	noteWakingFollowUp(runId: string, agentId: string, provisional = false): void {
		const own = this.#own;
		if (own === undefined || own.record.runId !== runId) return;
		noteExpected(runId, agentId, { kind: "wake", ...(provisional ? { provisional: true as const } : {}) });
	}

	/**
	 * A provisional wake's receipt said omp joined the message to a turn that was already open. An expectation an
	 * answer already took stays consumed: that answer was still work the director sent. The unused token is removed so
	 * it cannot hide the next arrival nobody asked for.
	 */
	discardWakingFollowUp(runId: string, agentId: string): void {
		const own = this.#own;
		if (own === undefined || own.record.runId !== runId) return;
		const workers = expectedByRun.get(runId);
		const queue = workers?.get(agentId);
		if (workers === undefined || queue === undefined) return;
		for (let i = queue.length - 1; i >= 0; i--) {
			if (queue[i]?.provisional === true) {
				queue.splice(i, 1);
				break;
			}
		}
		if (queue.length === 0) workers.delete(agentId);
	}

	/**
	 * A delivery the run received that answers no declared result (see `AttemptUnplannedDelivery`). It is kept in the
	 * record as the host showed it: whose child, when, what the worker cost so far, and whether it changed files when
	 * the agent ledger knew. It never touches a result row, a lane or an attempt, and it is not acceptance. The
	 * director reads one line for it, in the notice path an evaluated delivery uses, except for the expected answers of
	 * a worker this run placed without a lane (R11a): those are recorded for the views and not told as a delivery
	 * nobody asked for.
	 */
	noteUnplannedDelivery(input: AttemptUnplannedDelivery): void {
		const own = this.#own;
		if (own === undefined || own.record.runId !== input.runId) return;
		const list = own.record.unplanned ?? [];
		if (list.some(entry => entry.id === input.id)) return;
		// A delivery Storm itself asked for is not one nobody planned: a refused spawn delivers its refusal and a lane
		// worker's results reach their own rows or a lane with no declared results, so neither is recorded or told here.
		// An unplanned placement's answer is expected work too, but the views count it: it is recorded without a notice.
		// Only deliveries beyond those (someone else woke it) are recorded and told; a worker Storm never placed always is.
		let expected = false;
		if (input.kind === "unplaced") {
			const placed = deliveryKindsByRun.get(input.runId)?.get(input.agent);
			// A refused spawn's only delivery is the refusal the director was already promised: never re-labelled here.
			if (placed === "blocked") return;
			// One token per admission and per wake this run asked for, consumed in send order. A lane worker's answer on
			// its own token reaches its row and is not an unplanned delivery; one with no token left is unsolicited.
			const workers = expectedByRun.get(input.runId);
			const queue = workers?.get(input.agent);
			if (workers !== undefined && queue !== undefined && queue.length > 0) {
				queue.shift();
				expected = true;
				if (queue.length === 0) workers.delete(input.agent);
				if (placed === "lane") return;
			}
		}
		const agent = this.deps.agents?.(own.record.runId, own.sessionDir).find(entry => entry.id === input.agent);
		const changed =
			agent === undefined || input.startedAt === undefined
				? undefined
				: agent.lastChangeAt !== undefined && agent.lastChangeAt >= input.startedAt;
		const entry: UnplannedDelivery = {
			id: input.id,
			// B8: an answer this run asked for is out-of-plan activity; an arrival nobody asked for stays unplaced/woken.
			kind: expected ? "out-of-plan" : input.kind,
			agent: input.agent,
			endedAt: input.endedAt,
			...(input.parentId !== undefined ? { parentId: input.parentId } : { parentId: input.receiverId }),
			...(input.lane !== undefined ? { lane: input.lane } : {}),
			...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
			...(input.status !== undefined ? { status: input.status } : {}),
			...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
			...(agent !== undefined && agent.costUsd > 0 ? { agentCostUsd: agent.costUsd } : {}),
			...(changed !== undefined ? { changed } : {}),
		};
		list.push(entry);
		// Bounded: the oldest go first, and the count keeps what the list no longer holds.
		while (list.length > UNPLANNED_MAX) list.shift();
		own.record.unplanned = list;
		own.record.unplannedCount = (own.record.unplannedCount ?? 0) + 1;
		// F2: counted here, when the delivery is recorded, so cutting the list never turns an asked-for delivery into an
		// unasked arrival.
		if (expected) own.record.unplannedAsked = (own.record.unplannedAsked ?? 0) + 1;
		else own.record.unplannedUnasked = (own.record.unplannedUnasked ?? 0) + 1;
		if (!expected) own.notices.push(unplannedNotice(entry));
		this.#scheduleFlush(own);
	}

	/** Something the director should read at its next request (the one place a hook that already answered can still tell it something). */
	noteDirector(text: string): void {
		this.#own?.notices.push(text);
	}

	/**
	 * The director's own path edit was committed in this run (R10's gate input). The extension raises it right after
	 * `RunLanes.commitWriter` returned; `runId` keeps a late commit of a finished run from marking the next one.
	 * Memory only: the gate reads it through `directorEdited`, and no record field carries it.
	 */
	noteDirectorEdit(runId?: string): void {
		const own = this.#own;
		if (own === undefined || (runId !== undefined && own.record.runId !== runId)) return;
		own.directorEdit = true;
	}

	/** Whether the director committed one of its own path edits in this run; the review gate's input (R10). */
	directorEdited(): boolean {
		return this.#own?.directorEdit === true;
	}

	/**
	 * The one bounded line about workers this run's own admissions stopped, from the keyed tally. It goes before the
	 * queued notices so a hundred per-worker sentences or delivery lines can never truncate the cause away; a new stop
	 * changes the signature, so the director reads the new count once. Two causes at most (fault 2, D11).
	 */
	#stopNotice(own: OwnRun): string | undefined {
		const tally = stormStopsByRun.get(own.record.runId);
		if (tally === undefined || tally.size === 0) return undefined;
		const reasons = [...tally.entries()]
			.map(([reason, entry]) => ({ reason, count: entry.keys.size, ...(entry.first === undefined ? {} : { first: entry.first }) }))
			.filter(stop => stop.count > 0)
			.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
		if (reasons.length === 0) return undefined;
		const signature = reasons.map(stop => `${stop.reason}:${stop.count}`).join(",");
		if (own.stopNoticeShown === signature) return undefined;
		own.stopNoticeShown = signature;
		return stormStopNotice({ count: reasons.reduce((sum, stop) => sum + stop.count, 0), reasons });
	}

	/**
	 * The notices queued since the last call, as one bounded text for the director's next request, or nothing. Taking
	 * them empties the queue, so a notice is read once however it is delivered.
	 */
	takeNotices(): string | undefined {
		const own = this.#own;
		if (own === undefined) return undefined;
		const stop = this.#stopNotice(own);
		if (own.notices.length === 0 && stop === undefined) return undefined;
		const taken = stop === undefined ? own.notices.splice(0, own.notices.length) : [stop, ...own.notices.splice(0, own.notices.length)];
		const text = taken.join("\n");
		return text.length > NOTICE_MAX_CHARS ? `${text.slice(0, NOTICE_MAX_CHARS - 1)}…` : text;
	}

	/** Rehydrate one validated plan; a prior record locates claims, only current evidence accepts them. */
	async #restoreCheckpoint(own: OwnRun, previous: RunRecord, plan: RunPlan | undefined): Promise<void> {
		this.#syncResults(own);
		// The record that held these rows was read within RUN_RECORD_MAX_BYTES, which bounds them; a count cap here would
		// drop unmet requirements unseen. A repeated id is one requirement: its first row is the one imported.
		const oldRows = new Map<string, RunResult>();
		if (Array.isArray(previous.results)) {
			for (const old of previous.results) {
				if (old !== null && typeof old === "object" && typeof old.id === "string" && !oldRows.has(old.id)) {
					oldRows.set(old.id, old);
				}
			}
		}
		const rows = new Map(own.record.results?.map(row => [row.id, row]));
		for (const old of oldRows.values()) {
			if (old.scope === "excluded-by-user") {
				const existing = rows.get(old.id);
				if (existing !== undefined) {
					if (existing.scope !== "excluded-by-user") {
						existing.scope = "excluded-by-user";
						existing.state = "pending";
						existing.reason = EXCLUDED_RESULT_REASON;
					}
					continue;
				}
				const contract = normalizeCheckpointContract(old.contract);
				if (contract === undefined || old.id !== contract.id || old.identity !== resultContractIdentity(contract)) continue;
				const lane = typeof old.lane === "string" && old.lane.trim() !== "" && old.lane.length <= 200 ? old.lane : undefined;
				const row: RunResult = {
					id: contract.id,
					identity: old.identity,
					contract,
					state: "pending",
					scope: "excluded-by-user",
					origin: "plan",
					reason: EXCLUDED_RESULT_REASON,
					...(lane === undefined ? {} : { lane }),
				};
				(own.record.results ??= []).push(row);
				rows.set(row.id, row);
				continue;
			}
			if (rows.has(old.id)) continue;
			const contract = normalizeCheckpointContract(old.contract);
			if (contract === undefined || old.id !== contract.id || old.identity !== resultContractIdentity(contract)) continue;
			// The old row's unmet reason is why the requirement is still open; it stays next to the orphan reason.
			const prior = typeof old.reason === "string" && old.state !== "accepted"
				? compactResultReason(old.reason.startsWith(ORPHAN_RESULT_REASON) ? old.reason.slice(ORPHAN_RESULT_REASON.length) : old.reason)
				: "";
			const row: RunResult = {
				id: contract.id, identity: old.identity, contract, state: "pending", origin: "plan",
				reason: prior === "" ? ORPHAN_RESULT_REASON : compactResultReason(`${ORPHAN_RESULT_REASON} ${prior}`),
			};
			(own.record.results ??= []).push(row);
			rows.set(row.id, row);
		}
		if (plan === undefined) return;
		const artifactsDir = own.record.artifactsDir === previous.artifactsDir ? own.record.artifactsDir : undefined;
		const keptJobs = new Set<string>();
		for (const lane of plan.lanes) {
			const job = lane.job === undefined ? undefined : own.config.jobs?.find(item => item.name === lane.job);
			const pastJob = job === undefined ? undefined : historicalJob(own.record, job.name);
			const jobHash = job === undefined ? undefined : jobDigest(job);
			const expected = new Set(inputSnapshot(plan, lane, []).map(input => input.id));
			const previousInputs = (old: RunResult): RunResult["consumed"] | false => {
				if (old.consumed === undefined) return expected.size === 0 ? undefined : false;
				if (!Array.isArray(old.consumed) || old.consumed.length !== expected.size) return false;
				const seen = new Set<string>();
				for (const input of old.consumed) {
					if (!input || !expected.has(input.id) || seen.has(input.id) ||
						typeof input.version !== "string" || !PROOF_DIGEST.test(input.version)) return false;
					seen.add(input.id);
				}
				return old.consumed.map(({ id, version }) => ({ id, version }));
			};
			for (const result of lane.results ?? []) {
				const row = rows.get(result.id)!;
				const old = oldRows.get(result.id);
				const identical = old != null && old.lane === lane.name && old.identity === row.identity;
				const consumed = identical ? previousInputs(old) : false;
				const forReview = result.kind === "change" && (old?.state === "reviewable" || old?.origin === "review");
				// A reviewable or review-accepted answer cannot be rebound here: its verdict scoped a receipt of the previous
				// run, and the verbatim answer a new review would need was never persisted. It reopens to its producer
				// (the lane stays outside `restoredLanes` and reruns) instead of waiting on a review nobody can bind.
				const answerReview = identical && result.kind === "answer" && (old.state === "reviewable" || old.origin === "review");
				if (answerReview) row.reason = compactResultReason("이전 실행의 답변 리뷰 근거는 이어받지 않습니다. 생산 레인이 답변을 다시 제출해야 합니다.");
				if (!answerReview && identical && (old.state === "accepted" || (forReview && old.state === "reviewable")) && consumed !== false &&
					typeof old.attemptId === "string" && ATTEMPT_REF.test(old.attemptId) &&
					typeof old.contentVersion === "string" && PROOF_DIGEST.test(old.contentVersion)) {
					const valid = job === undefined
						? await revalidateCheckpointProof({ row: old, result, root: own.root,
							...(artifactsDir === undefined ? {} : { artifactsDir }),
							...(forReview ? { forReview: true as const } : {}),
							isolated: lane.isolationReason !== undefined || own.config.isolation === "isolated" })
						: { ok: pastJob?.status === "passed" && pastJob.exitCode === 0 && pastJob.fence === undefined &&
							pastJob.jobSha256 === jobHash && pastJob.lane === lane.name &&
							pastJob.attemptId === old.attemptId && pastJob.stdoutSha256 === old.contentVersion,
							reason: "이전 실행을 승인된 명령 및 관측 결과와 대조할 수 없습니다." };
					if (valid.ok) {
						row.state = forReview ? "reviewable" : "accepted";
						if (forReview) row.reason = "현재 내용은 확인했습니다. 새 리뷰가 필요합니다.";
						row.origin = "attempt";
						row.attemptId = old.attemptId;
						row.contentVersion = old.contentVersion;
						row.restoredFrom = previous.runId;
						if (consumed?.length) row.consumed = consumed;
						if (job === undefined && old.proof !== undefined) {
							const proof = captureCheckpointProof(old.proof.item, old.proof.artifact);
							if (proof !== undefined) row.proof = proof;
						}
						continue;
					}
					if ("reason" in valid && typeof valid.reason === "string") row.reason = compactResultReason(valid.reason);
				}
				if (jobHash !== undefined && unsafeToReplay(pastJob, jobHash)) blockedJobRow(row, UNCERTAIN_JOB);
			}
			if (pastJob !== undefined && job !== undefined && jobHash !== undefined && unsafeToReplay(pastJob, jobHash)) {
				const all = lane.results?.every(result => rows.get(result.id)?.state === "accepted") === true;
				if (all) keptJobs.add(job.name);
				setJobReceipt(own.record, {
					lane: lane.name, name: job.name, status: all ? "passed" : "unknown", exitCode: all ? 0 : null,
					startedAt: typeof pastJob.startedAt === "string" && Number.isFinite(Date.parse(pastJob.startedAt)) ? pastJob.startedAt : null,
					finishedAt: typeof pastJob.finishedAt === "string" && Number.isFinite(Date.parse(pastJob.finishedAt)) ? pastJob.finishedAt : null,
					...(all && pastJob.stdoutSha256 !== undefined ? { jobSha256: jobHash, stdoutSha256: pastJob.stdoutSha256 } : {}),
					...(typeof pastJob.attemptId === "string" && ATTEMPT_REF.test(pastJob.attemptId) ? { attemptId: pastJob.attemptId } : {}),
					...(!all ? { detail: UNCERTAIN_JOB } : {}),
				});
			}
		}
		// The recorded producer ids already reject an added, removed or swapped input above; only the stored plan can
		// reveal a level that got stronger under the same ids. It is untrusted input, so it seeds the transition only once it
		// normalizes; otherwise the current declaration alone is checked.
		let storedPlan: RunPlan | undefined;
		try {
			storedPlan = previous.plan === undefined ? undefined : normalizeCheckpointPlan(own.config, previous.plan);
		} catch {
			storedPlan = undefined;
		}
		this.#invalidateConsumers(own, storedPlan);
		for (const lane of plan.lanes) {
			const results = lane.results ?? [];
			if (results.length > 0 && results.every(result => {
				const current = rows.get(result.id);
				return current?.state === "accepted" || (current?.state === "reviewable" && current.restoredFrom !== undefined);
			})) own.restoredLanes.add(lane.name);
			else if (lane.job !== undefined && keptJobs.has(lane.job)) {
				const receipt = historicalJob(own.record, lane.job)!;
				setJobReceipt(own.record, { ...receipt, status: "unknown", detail: UNCERTAIN_JOB });
				for (const result of results) blockedJobRow(rows.get(result.id)!, UNCERTAIN_JOB);
			}
		}
	}

	/**
	 * Re-derives the ledger from the current plan without inventing requirements: a new id starts pending, an existing
	 * id keeps its state across reassignment, and a removed lane keeps every non-accepted obligation (with no lane).
	 * The bounded contract is persisted per id so an accepted row can still be re-located after its lane leaves; it is
	 * never rewritten while the identity matches. A changed contract under the same id is a new requirement: its old
	 * contract, attempt evidence and accepted proof are dropped, never inherited.
	 */
	#syncResults(own: OwnRun, previousPlan?: RunPlan, satisfied?: InputSatisfaction): boolean {
		const rows = own.record.results ?? [];
		const byId = new Map(rows.map(row => [row.id, row]));
		const assigned = new Set<string>();
		let changed = false;
		for (const lane of own.record.plan?.lanes ?? []) {
			for (const result of lane.results ?? []) {
				const identity = resultContractIdentity(result);
				assigned.add(result.id);
				const row = byId.get(result.id);
				// A user exclusion is never reassigned or reset by a later plan. The plan gate and continuation filter
				// refuse reintroduction; this is the ledger's last defense against a stale or replayed plan.
				if (row !== undefined && row.scope === "excluded-by-user") continue;
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
					delete row.proof;
					delete row.restoredFrom;
					changed = true;
				}
			}
		}
		for (const row of rows) {
			if (assigned.has(row.id)) continue;
			// An exclusion is not a removed/orphan requirement: it keeps its last lane binding for display and a
			// stable reason, and no coverage or proof obligation reads it.
			if (row.scope === "excluded-by-user") {
				if (row.reason !== EXCLUDED_RESULT_REASON) {
					row.reason = EXCLUDED_RESULT_REASON;
					changed = true;
				}
				continue;
			}
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
		// A plan change can leave an already-invalid consumer in the ledger (a legacy row, a removed producer, or an
		// input the replan swapped, added or removed, or strengthened beyond the producer's current facts). The rows are
		// re-read after the plan edit, never assumed fresh, and the plan just replaced (when given) seeds the transition
		// before any downstream is judged.
		if (this.#invalidateConsumers(own, previousPlan, satisfied)) changed = true;
		return changed;
	}

	/** The current plan's declaration for one result id, wherever its lane now is. */
	/**
	 * The answer evidence a row currently stands on: the persisted accepted proof for exactly this content version, or
	 * this run's recorded submission for the same attempt and version. Nothing is reconstructed from model text.
	 */
	#answerReceipt(own: OwnRun, row: RunResult): ResultEvidenceItem | undefined {
		if (row.contentVersion === undefined || row.attemptId === undefined) return undefined;
		const proof = row.proof?.item;
		if (proof !== undefined && proof.kind === "answer" && proof.id === row.id && proof.attemptId === row.attemptId &&
			proof.contentVersion === row.contentVersion) return proof;
		const subject = own.answerSubjects?.get(row.id);
		if (subject !== undefined && subject.attemptId === row.attemptId && subject.item.contentVersion === row.contentVersion) {
			return subject.item;
		}
		return undefined;
	}

	/**
	 * The exact review subject of a reviewable answer, or undefined when this run cannot hand that submission to a
	 * reviewer: no recorded submission for this attempt and content version, no anchor citation, no verbatim answer text
	 * or no issuable receipt. Without it no verdict can be bound, so the row goes back to its producer (`work`) instead
	 * of a review that could never settle it.
	 */
	#answerReviewSubject(own: OwnRun, row: RunResult): (AnswerReviewSubject & { receipt: string; answer: string; output?: string; partial?: true }) | undefined {
		if (row.state !== "reviewable" || row.attemptId === undefined || row.contentVersion === undefined) return undefined;
		if ((this.#plannedResult(own, row.id) ?? row.contract)?.kind !== "answer") return undefined;
		const subject = own.answerSubjects?.get(row.id);
		if (subject === undefined || subject.item.state !== "reviewable" || subject.attemptId !== row.attemptId ||
			subject.item.contentVersion !== row.contentVersion || subject.answer === undefined) return undefined;
		const citation = subject.item.citation;
		if (citation === undefined || citation.digest === undefined) return undefined;
		const scoped: AnswerReviewSubject = {
			runId: own.record.runId,
			resultId: row.id,
			attemptId: subject.attemptId,
			contentVersion: row.contentVersion,
			citation: { path: citation.path, ...(citation.line === undefined ? {} : { line: citation.line }) },
			seenAt: subject.seenAt,
		};
		const receipt = answerReviewReceipt(scoped);
		return receipt === undefined
			? undefined
			: {
					...scoped,
					receipt,
					answer: subject.answer,
					...(subject.output === undefined ? {} : { output: subject.output }),
					...(subject.partial === true ? { partial: true as const } : {}),
				};
	}

	/**
	 * The packets of every reviewable answer this run can bind a verdict to and has not handed out yet, in row order.
	 * Each quotes the answer exactly as submitted and names its receipt and anchor; an answer whose whole packet would
	 * not fit one batch is quoted as its head with its producer's output handle, under the receipt of the whole text.
	 */
	#pendingAnswerPackets(own: OwnRun): AnswerPacket[] {
		const rows = own.record.results ?? [];
		const packets: AnswerPacket[] = [];
		for (const row of rows) {
			if (row.scope === "excluded-by-user" || hasStaleInputs(row, rows)) continue;
			const subject = this.#answerReviewSubject(own, row);
			if (subject === undefined || own.answerHandout?.has(subject.receipt) === true) continue;
			const criterion = (this.#plannedResult(own, row.id) ?? row.contract)?.criterion ?? row.id;
			const input = { resultId: row.id, criterion, answer: subject.answer, receipt: subject.receipt, citation: subject.citation };
			// A host part always names the handle: the reviewer judges the whole output, never the part alone.
			const whole = subject.partial === true && subject.output !== undefined
				? answerReviewPacket({ ...input, output: subject.output, partial: true })
				: answerReviewPacket(input);
			const packet = whole.length <= ANSWER_BATCH_CHARS || subject.output === undefined
				? whole
				: answerReviewPacket({ ...input, output: subject.output, quoteChars: ANSWER_EXCERPT_CHARS, ...(subject.partial === true ? { partial: true } : {}) });
			packets.push({ receipt: subject.receipt, packet });
		}
		return packets;
	}

	/** How many reviewable answers still wait for a reviewer and how many reviewer tasks or follow-ups they need. */
	#answerReviewLoad(own: OwnRun): { answers: number; batches: number } {
		const packets = this.#pendingAnswerPackets(own);
		return { answers: packets.length, batches: answerBatches(packets).length };
	}

	/**
	 * Hands the next batch of answer review packets not yet handed out to one approved reviewer task or follow-up, and
	 * marks it handed out so no other reviewer turn gets the same answer. It rides only on the reviewer's own task or
	 * follow-up (per-task context, never a system prompt), is Storm's input rather than a verdict, and proves nothing:
	 * only the reviewer's final yield entry for a receipt, re-checked against the cited bytes, settles that answer.
	 */
	takeAnswerReviewBatch(): string | undefined {
		const own = this.#own;
		if (own === undefined) return undefined;
		const batch = answerBatches(this.#pendingAnswerPackets(own))[0];
		if (batch === undefined) return undefined;
		const handed = (own.answerHandout ??= new Set<string>());
		for (const packet of batch) handed.add(packet.receipt);
		return [ANSWER_BATCH_HEAD, ...batch.map(packet => packet.packet)].join("\n\n");
	}

	/** Why an answer row's recorded anchor no longer holds now, or undefined when its cited bytes still match. */
	async #answerReceiptProblem(own: OwnRun, row: RunResult): Promise<string | undefined> {
		// A result declared by an approved job lane is proven by the host's native job receipt, never by a citation; it
		// is judged only there (fail closed) and never falls through to the citation path, nor the other way around.
		const jobProblem = this.#jobAnswerProblem(own, row);
		if (jobProblem !== false) return jobProblem;
		const receipt = this.#answerReceipt(own, row);
		if (receipt === undefined) return "답변이 근거로 삼은 출처 기록이 없어 현재 근거로 다시 확인할 수 없습니다.";
		const check = await verifyAnswerReceipt({ root: own.root, receipt, expectedVersion: row.contentVersion });
		return check.ok ? undefined : check.reason;
	}

	/**
	 * For an answer declared by an approved job lane of the current plan: why its acceptance is no longer backed by the
	 * host's own job receipt, or undefined when it still is. `false` means the row is not a job answer (its proof is a
	 * citation). The row must map to exactly the run's current receipt for that lane and job: the same attempt (issued by
	 * this run's `executeJobs`, or carried by a validated checkpoint import), the current approved definition, a clean
	 * passed exit with no fence, and an observed stdout digest equal to the row's content version under the current
	 * contract. A missing, mismatched, superseded or uncertain receipt reopens the row; nothing is re-run here.
	 */
	#jobAnswerProblem(own: OwnRun, row: RunResult): string | undefined | false {
		const lane = own.record.plan?.lanes.find(candidate => candidate.results?.some(result => result.id === row.id));
		if (lane?.job === undefined) return false;
		const result = lane.results?.find(candidate => candidate.id === row.id);
		const missing = "정형 작업의 실행 기록과 결과를 대조할 수 없어 현재 근거로 다시 확인할 수 없습니다.";
		if (result === undefined || result.kind !== "answer" || result.contains === undefined ||
			row.identity !== resultContractIdentity(result) || row.attemptId === undefined || !ATTEMPT_REF.test(row.attemptId) ||
			row.contentVersion === undefined || !PROOF_DIGEST.test(row.contentVersion)) return missing;
		// A live row was bound by this run's own executeJobs; only a row a checkpoint import validated may carry an
		// attempt issued by an earlier run.
		if (row.restoredFrom === undefined && !row.attemptId.startsWith(`job:${own.record.runId}:`)) return missing;
		const job = own.config.jobs?.find(candidate => candidate.name === lane.job);
		const receipt = historicalJob(own.record, lane.job);
		if (job === undefined || receipt === undefined) return missing;
		if (receipt.lane !== lane.name || (row.lane !== undefined && row.lane !== lane.name) || receipt.attemptId !== row.attemptId ||
			receipt.jobSha256 !== jobDigest(job)) return missing;
		if (receipt.status !== "passed" || receipt.exitCode !== 0 || receipt.fence !== undefined) {
			return "정형 작업의 현재 실행 기록이 성공 종료를 보여주지 않습니다.";
		}
		if (receipt.stdoutSha256 !== row.contentVersion) return "정형 작업의 관측된 출력이 수용된 결과와 다릅니다.";
		return undefined;
	}

	#plannedResult(own: OwnRun, id: string): PlanLaneResult | undefined {
		for (const lane of own.record.plan?.lanes ?? []) {
			const found = lane.results?.find(result => result.id === id);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	/**
	 * Whether the result's lane in the plan in force is isolated. A lane that left the plan has no isolation fact left
	 * to read; only a team that isolates every worker still answers for it. Used by the review refresh, so an older
	 * reviewable change of an isolated lane cannot become accepted on parent-tree bytes (row 2).
	 */
	#rowIsolated(own: OwnRun, row: RunResult): boolean {
		if (own.config.isolation === "isolated") return true;
		const lanes = own.record.plan?.lanes ?? [];
		const lane = lanes.find(candidate => candidate.name === row.lane) ?? lanes.find(candidate => (candidate.results ?? []).some(result => result.id === row.id));
		return lane?.isolationReason !== undefined;
	}

	/**
	 * Whether the plan still declares, for every result this attempt can produce, exactly the logical inputs it started
	 * under. Result ids locate the owning lane, so a pure rename of the producer or consumer lane keeps the attempt.
	 */
	#declaredInputsCurrent(own: OwnRun, prepared: PreparedAttempt, satisfied?: InputSatisfaction): boolean {
		return attemptInputsCurrent(own.record.plan, prepared.results.map(result => result.id), prepared.declaredInputs, satisfied);
	}

	/**
	 * Whether a prepared attempt's declared inputs or producer versions changed after it started. Without `satisfied`
	 * a strengthened level counts as a change, which fails closed.
	 */
	#staleInputs(own: OwnRun, prepared: PreparedAttempt, satisfied?: InputSatisfaction): boolean {
		if (!this.#declaredInputsCurrent(own, prepared, satisfied)) return true;
		if ((prepared.consumed ?? []).length === 0) return false;
		const byId = new Map((own.record.results ?? []).map(row => [row.id, row]));
		return (prepared.consumed ?? []).some(input => currentInputVersion(byId.get(input.id)) !== input.version);
	}

	/**
	 * What the producers of this attempt's results satisfy now. Row state answers `reviewable` and `result`; only the
	 * ids whose declared level the current plan made `integrated` after the attempt captured a weaker one need a tree
	 * read. `laneReadiness` is not used: it waits for settlements, and this attempt is one of them.
	 */
	async #settledInputSatisfaction(own: OwnRun, prepared: PreparedAttempt): Promise<InputSatisfaction> {
		const captured = new Map((prepared.declaredInputs ?? []).map(input => [input.id, input.need]));
		const needed = new Set<string>();
		for (const id of prepared.results.map(result => result.id)) {
			for (const input of resultInputs(own.record.plan, id) ?? []) {
				if (input.need === "integrated" && captured.get(input.id) !== "integrated") needed.add(input.id);
			}
		}
		const integrated = new Set<string>();
		for (const id of needed) {
			const result = this.#plannedResult(own, id);
			const row = own.record.results?.find(candidate => candidate.id === id);
			if (result === undefined || row?.state !== "accepted") continue;
			const lane = own.record.plan?.lanes.find(candidate => candidate.results?.some(item => item.id === id));
			const isolated = lane === undefined ? undefined : lane.isolationReason !== undefined || own.config.isolation === "isolated";
			const location = await this.#acceptedLocation(own, result, isolated, row);
			if (location.ok && location.integrated) integrated.add(id);
		}
		return ledgerInputSatisfaction(own.record.results, id => integrated.has(id));
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
		this.#recordUnusableInputs(own, prepared, attemptId, "선행 결과가 시도 시작 뒤에 바뀌어 이 시도의 결과를 수용하지 않았습니다.", false);
	}

	/**
	 * A settlement of an attempt whose declared inputs the plan has since replaced. The requirement now consumes other
	 * inputs, so this output is recorded as unmet (an exact host attempt id is still a fact worth showing) and never
	 * evaluated, accepted, or turned into a retry remedy.
	 */
	#applySupersededAttempt(own: OwnRun, prepared: PreparedAttempt, attemptId: string | undefined): void {
		// Without an exact host attempt there is no fact to record: the replan already reopened any evidence that stood
		// on the old declaration, and a pending or unmet row keeps what it says.
		if (attemptId === undefined) {
			if (this.#invalidateConsumers(own)) this.#scheduleFlush(own);
			return;
		}
		this.#recordUnusableInputs(own, prepared, attemptId, "계획의 선행 입력이 시도 시작 뒤에 바뀌어 이 시도의 결과를 수용하지 않았습니다.", true);
	}

	#recordUnusableInputs(
		own: OwnRun,
		prepared: PreparedAttempt,
		attemptId: string,
		why: string,
		superseded: boolean,
	): void {
		const rows = own.record.results ?? [];
		let changed = false;
		for (const result of prepared.results) {
			const row = rows.find(candidate => candidate.id === result.id);
			if (row === undefined) continue;
			const identity = resultContractIdentity(result);
			if (row.identity !== undefined && row.identity !== identity) continue;
			// Evidence another attempt earned under the new declaration (for example under a renamed lane that the
			// per-lane epoch cannot fence) is judged by its own recorded inputs; a superseded attempt never downgrades it.
			if (superseded && (row.state === "accepted" || row.state === "reviewable") && row.attemptId !== undefined &&
				row.attemptId !== attemptId) continue;
			row.state = "unmet";
			row.reason = compactResultReason(why);
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			row.identity = identity;
			row.origin = "attempt";
			row.attemptId = attemptId;
			this.#bindConsumed(row, prepared);
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.proof;
			delete row.restoredFrom;
			changed = true;
		}
		if (this.#invalidateConsumers(own)) changed = true;
		if (changed) this.#scheduleFlush(own);
	}

	/**
	 * Reopens rows whose evidence no longer stands on what the plan and ledger say now: a recorded producer version that
	 * changed, a recorded producer set that differs from the logical inputs the current plan declares for the
	 * requirement (by result id, so a pure lane rename keeps it), a declared level the producer no longer meets, and —
	 * when `previousPlan` is the plan just replaced — an input set change, or a level strengthened beyond what
	 * `satisfied` confirms the producer meets now, in that transition. Only
	 * accepted/reviewable evidence is touched: a pending row invents nothing and an already-unmet row stays as it is.
	 * The pass is transitive because a reopened row is no longer a usable input.
	 */
	#invalidateConsumers(own: OwnRun, previousPlan?: RunPlan, satisfied?: InputSatisfaction): boolean {
		const rows = own.record.results ?? [];
		if (rows.length === 0) return false;
		const stale = staleRequirementIdsForPlan(rows, own.record.plan, previousPlan, satisfied);
		if (stale.size === 0) return false;
		const replanned = own.record.plan === undefined || previousPlan === undefined
			? new Set<string>()
			: changedInputRequirements(previousPlan, own.record.plan, satisfied);
		let changed = false;
		for (const row of rows) {
			if (!stale.has(row.id)) continue;
			// An exhausted native retry was a fact about the old inputs: the route fingerprint has no inputs in it, so
			// left in place it would refuse the very rerun a changed input declaration owes.
			if (replanned.has(row.id) && row.state === "unmet" && row.remedy === "retry") {
				delete row.remedy;
				delete row.retryRoute;
				row.reason = compactResultReason("계획에서 이 결과의 선행 입력이 바뀌어 새 입력으로 다시 수행해야 합니다.");
				changed = true;
				continue;
			}
			if (row.state !== "accepted" && row.state !== "reviewable") continue;
			row.state = "unmet";
			row.origin = "plan";
			row.reason = compactResultReason(replanned.has(row.id)
				? "계획에서 이 결과의 선행 입력이 바뀌어 새 입력으로 다시 수행해야 합니다."
				: "입력으로 쓴 선행 결과가 바뀌어 이전 근거를 다시 확인해야 합니다.");
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			// The attempt is a real host fact and remains useful for the round/closeout; its evidence is what is invalid.
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.proof;
			delete row.restoredFrom;
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
		// A failed or cancelled attempt can still leave a positive, digest-bound patch. The record has no typed reference
		// for it (the closeout says capture unknown), but the row can truthfully say a patch exists.
		const captured = report.artifacts.find(artifact => artifact.kind === "patch" && artifact.path !== "" && (artifact.bytes ?? 0) > 0);
		const recovery = captured === undefined ? "" : ` 보존 패치를 호스트가 캡처했습니다(시도: ${report.attemptId}).`;
		const reason = compactResultReason(`${why} 필수 결과를 수용하지 않았습니다.${recovery}`);
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
			delete row.proof;
			delete row.restoredFrom;
		}
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
	}

	/** A report that cannot bind leaves every non-accepted requirement unresolved without an attempt id. */
	#applyUnusableAttempt(own: OwnRun, prepared: PreparedAttempt, report: AttemptReport): void {
		const code = report.captureError ?? (report.attemptId === undefined ? "native-result-missing" : "spawn-mismatch");
		// Row 8: keep the native outcome separate from the capture proof. A cancel whose identity could not be bound
		// says the cause is unconfirmed; a proved success with an empty patch says no change was captured (not a failed
		// attempt). Row 3: an isolated success with no patch may be a branch, which this version cannot read; the
		// native delivery is named instead of inventing a branch or a failure.
		const reason = compactResultReason(
			report.outcome === "cancel"
				? `${CANCEL_IDENTITY_UNKNOWN}(${code}). 네이티브 기록과 호스트의 취소 기록을 확인하세요.`
				: report.outcome === "success" && code === "patch-artifact-empty"
					? `${EMPTY_CAPTURE_REASON}(${code}).`
					: code === "patch-artifact-nested-only"
						? `${NESTED_ONLY_REASON}(${code}). 네이티브 기록: agent://${prepared.spawnKey}`
						: code === "patch-artifact-empty-unknown"
							? `${EMPTY_UNKNOWN_REASON}(${code}). 네이티브 기록: agent://${prepared.spawnKey}`
							: report.outcome === "success" && prepared.isolated === true && prepared.results.some(result => result.kind === "artifact")
								? `${ISOLATED_CAPTURE_UNREAD}(${code}). 네이티브 결과: agent://${prepared.spawnKey}`
								: `호스트 시도를 확인하지 못했습니다(${code}).`,
		);
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
			delete row.proof;
			delete row.restoredFrom;
		}
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
	}

	/**
	 * The exact capture disposition for an isolated attempt's change rows: awaiting capture, awaiting selection, or one
	 * named unsupported/conflict/stale reason. It never evaluates parent bytes, adds a row, or accepts on its own.
	 */
	#applyIntegrationChanges(
		own: OwnRun,
		prepared: PreparedAttempt,
		attemptId: string,
		changes: readonly PlanLaneResult[],
	): void {
		const admitted = own.integration?.admissions.get(prepared.dispatch);
		const rows = own.record.results ?? [];
		let changed = false;
		for (const result of changes) {
			const row = rows.find(candidate => candidate.id === result.id);
			if (row === undefined) continue;
			const identity = resultContractIdentity(result);
			if (row.identity !== undefined && row.identity !== identity) continue;
			if (row.state === "accepted" || row.state === "reviewable") continue;
			let state: RunResult["state"] = "pending";
			let reason: string;
			const readiness: QueueReadiness = admitted === undefined
				? { kind: "unknown", problem: integrationProblem("admission-missing", "이 시도에는 통합 수락이 준비되지 않았습니다.") }
				: this.#sealBaseReadiness(own, admitted);
			if (admitted !== undefined && admitted.boundAttemptId !== undefined && admitted.boundAttemptId !== attemptId) {
				state = "unmet";
				reason = "같은 수락에 다른 네이티브 시도가 결속되어 있어 이 캡처를 이 시도에 쓸 수 없습니다.";
			} else if (readiness.kind === "ready") {
				reason = `통합 선택을 기다립니다(후보 ${admitted?.admission.candidateId ?? "unknown"}).`;
				own.integration?.awaiting.set(result.id, admitted!.admission.candidateId);
			} else if (readiness.kind === "awaiting-native") {
				reason = "네이티브 캡처를 기다립니다.";
			} else if (readiness.kind === "confirmed-empty") {
				state = "unmet";
				reason = EMPTY_CAPTURE_REASON;
				own.integration?.awaiting.delete(result.id);
			} else {
				state = "unmet";
				reason = "problem" in readiness ? readiness.problem.reason : "통합 후보를 사용할 수 없습니다.";
				own.integration?.awaiting.delete(result.id);
			}
			row.state = state;
			row.reason = compactResultReason(reason);
			row.identity = identity;
			row.origin = "attempt";
			row.attemptId = attemptId;
			this.#bindConsumed(row, prepared);
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.proof;
			delete row.restoredFrom;
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			changed = true;
		}
		if (changed) {
			this.#invalidateConsumers(own);
			this.#scheduleFlush(own);
		}
	}

	/** Evaluates one settled attempt against its stored before state and writes the run-scoped rows. */
	async #evaluateAttempt(own: OwnRun, settled: SettledAttempt): Promise<void> {
		const prepared = settled.prepared;
		const integrationChanges = this.deps.integration?.(own.sessionDir) !== undefined && prepared.isolated === true
			? prepared.results.filter(result => result.kind === "change")
			: [];
		const judgeable = integrationChanges.length === 0 ? prepared.results : prepared.results.filter(result => result.kind !== "change");
		const checkedResults = settled.integrated === undefined ? judgeable : [...judgeable, ...integrationChanges];
		const checkNames = checkedResults.filter(result => result.check !== undefined).map(result => result.id);
		const checks = checkNames.length === 0 ? undefined : await this.#approvedCheckEvidence(own);
		const deferred = new Set(checkNames.length > 0 && checks === undefined ? checkNames : []);
		if (integrationChanges.length === 0) {
			// An isolated change is judged on the retained candidate, never on the parent tree in this version: it never
			// becomes accepted or reviewable, and a declared check cannot turn it into a deferred review.
			if (prepared.isolated === true) {
				for (const result of prepared.results) if (result.kind === "change") deferred.delete(result.id);
			}
		} else if (settled.integrated === undefined) {
			for (const result of integrationChanges) deferred.delete(result.id);
		}
		settled.checkDeferred = deferred.size > 0;
		const wantsAnswer = judgeable.some(result => result.kind === "answer");
		const evaluation = judgeable.length === 0
			? { ok: true as const, report: { results: [] as ResultEvidenceItem[] } }
			: await evaluateSettledResults({
				lane: prepared.lane,
				attemptId: settled.attemptId,
				results: judgeable,
				shared: { root: own.root, ...(prepared.baseline === undefined ? {} : { baseline: prepared.baseline }) },
				artifactMode: prepared.artifactMode,
				config: own.config,
				...(prepared.laneFiles === undefined ? {} : { laneFiles: prepared.laneFiles }),
				...(checks === undefined ? {} : { checks }),
				...(settled.artifact === undefined ? {} : { artifact: settled.artifact }),
				...(wantsAnswer
					? { answer: { text: settled.reportText ?? "", citations: [...settled.citations], ...(settled.reportPartial === true ? { partial: true } : {}) } }
					: {}),
			});
		// What the producers satisfy now is read after the evidence, so no await separates it from the fences below.
		const satisfied = this.#own === own ? await this.#settledInputSatisfaction(own, prepared) : undefined;
		// The run was finalized while the evidence was being read: this settlement is detached and must not mutate the
		// record already written (or the object a caller still holds).
		if (this.#own !== own) return;
		// The evidence read awaited: a newer attempt of this lane, or a producer or plan change since this attempt began,
		// may have decided the requirement meanwhile. The fences checked before the read hold again here, so a late
		// evaluation never overwrites the newer judgment.
		if (prepared.epoch < (own.laneAttempt.get(prepared.lane) ?? 0)) return;
		if (!this.#declaredInputsCurrent(own, prepared, satisfied)) {
			if (own.settled.get(prepared.lane) === settled) own.settled.delete(prepared.lane);
			this.#applySupersededAttempt(own, prepared, settled.attemptId);
			return;
		}
		if (this.#staleInputs(own, prepared, satisfied)) {
			if (own.settled.get(prepared.lane) === settled) own.settled.delete(prepared.lane);
			this.#applyStaleInput(own, prepared, settled.attemptId);
			return;
		}
		if (!evaluation.ok) {
			const rows = own.record.results ?? [];
			for (const result of judgeable) {
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
				delete row.proof;
				delete row.restoredFrom;
			}
			if (integrationChanges.length > 0) this.#applyIntegrationChanges(own, prepared, settled.attemptId, integrationChanges);
			this.#invalidateConsumers(own);
			return;
		}
		const items = integrationChanges.length === 0
			? isolatedChangeItems(evaluation.report.results, prepared.isolated === true)
			: evaluation.report.results;
		this.#applyEvaluated(own, prepared, settled.attemptId, items, deferred);
		for (const item of items) {
			const row = own.record.results?.find(candidate => candidate.id === item.id);
			if (row?.attemptId !== settled.attemptId) continue;
			const proof = (item.state === "accepted" || (item.kind === "change" && item.state === "reviewable")) && row.state === item.state
				? captureCheckpointProof(item, item.kind === "artifact" ? settled.artifact : undefined)
				: undefined;
			if (proof !== undefined) row.proof = proof;
			else delete row.proof;
			delete row.restoredFrom;
			if (item.kind === "answer") this.#noteAnswerSubject(own, row, item, settled);
		}
		if (integrationChanges.length > 0) this.#applyIntegrationChanges(own, prepared, settled.attemptId, integrationChanges);
	}

	/**
	 * Records the exact answer submission a row now stands on, or forgets it when the row holds no usable submission.
	 * A reviewable answer is told what the reviewer must see: the answer as submitted and its anchor citation, judged
	 * against the current bytes. No acceptance is granted here.
	 */
	#noteAnswerSubject(own: OwnRun, row: RunResult, item: ResultEvidenceItem, settled: SettledAttempt): void {
		const answer = settled.reportText;
		const subjects = (own.answerSubjects ??= new Map<string, AnswerSubject>());
		const usable = (item.state === "accepted" || item.state === "reviewable") && row.state === item.state &&
			row.attemptId !== undefined && item.contentVersion !== undefined && row.contentVersion === item.contentVersion &&
			item.citation?.digest !== undefined;
		if (!usable) {
			subjects.delete(row.id);
			return;
		}
		// The packet quotes exactly the text S1 judged; any other text (or none) leaves the submission unreviewable.
		const verbatim = typeof answer === "string" && item.digest !== undefined &&
			createHash("sha256").update(answer).digest("hex") === item.digest ? answer : undefined;
		subjects.set(row.id, {
			attemptId: row.attemptId as string,
			item,
			seenAt: this.deps.now(),
			...(verbatim === undefined ? {} : { answer: verbatim }),
			output: `agent://${settled.spawnKey}`,
			...(settled.reportPartial === true ? { partial: true as const } : {}),
		});
		const citation = item.citation;
		if (row.state === "reviewable" && citation !== undefined) {
			const anchor = `${citation.path}${citation.line === undefined ? "" : `:${citation.line}`}`;
			row.reason = compactResultReason(`답변 원문과 ${anchor} 출처를 리뷰어에게 그대로 전달해 판정받으세요.`);
		}
	}

	/**
	 * Whether a settled lane is still waiting for approved check evidence it declared. This is synchronous, so only row
	 * state answers a strengthened level; a level made `integrated` stays unconfirmed here and fails closed.
	 */
	#hasDeferredCheck(own: OwnRun): boolean {
		const satisfied = ledgerInputSatisfaction(own.record.results, () => false);
		return [...own.settled.values()].some(
			settled =>
				settled.checkDeferred === true &&
				settled.prepared.epoch >= (own.laneAttempt.get(settled.prepared.lane) ?? 0) &&
				!this.#staleInputs(own, settled.prepared, satisfied),
		);
	}

	/** Re-runs a check-bearing lane once the approved check report for the current tree exists. */
	async #refreshCheckedResults(own: OwnRun): Promise<void> {
		for (const [lane, settled] of [...own.settled]) {
			if (settled.checkDeferred !== true) continue;
			const satisfied = await this.#settledInputSatisfaction(own, settled.prepared);
			if (this.#own !== own) return;
			if (own.settled.get(lane) !== settled) continue;
			// A newer attempt or a changed producer makes this settlement's evidence unusable; re-evaluating it would
			// revive a result the run already reopened, and keeping it would ask for checks nobody can use.
			if (settled.prepared.epoch < (own.laneAttempt.get(settled.prepared.lane) ?? 0) || this.#staleInputs(own, settled.prepared, satisfied)) {
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
			if (settled.integrated !== undefined) {
				await this.#refreshIntegrated(own, settled, this.#readWindow());
				if (this.#own !== own) return;
			}
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
			const planned = this.#plannedResult(own, row.id);
			// An answer is never bound to, settled by or reopened from a tree: its verdict scopes its exact submission
			// (`#refreshAnswerReviews`) and its cited bytes are re-read by `#revokeUnlocatedAccepted`.
			if ((planned ?? row.contract)?.kind === "answer") continue;
			// Row 2: an isolated change never becomes review-accepted on parent-tree bytes. Once its exact write has a
			// current receipt it is in the parent for the reviewer, and `#acceptedLocation` rechecks that receipt.
			if ((planned ?? row.contract)?.kind === "change" && this.#rowIsolated(own, row) &&
				own.integration?.receipts.get(row.id) === undefined) continue;
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
			// A tree verdict judges only what the reviewer can actually see in the integrated tree. An isolated
			// artifact's content is not in it, so that row never borrows it here.
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

	/**
	 * Settles a reviewable answer only with the approved reviewer's final verdict that explicitly scopes it: an entry
	 * naming this result id with the receipt Storm issued for this exact run, attempt and content version (answer digest
	 * plus anchor path, line and bytes) and this anchor, given after this run first held the submission
	 * (`answerReviewVerdict`). A generic change/tree verdict, another answer's entry, an outdated receipt or an older
	 * verdict settles nothing. The anchor bytes are re-read immediately before a verdict applies; a moved source is the
	 * revocation pass's to reopen. No `reviewTree` is recorded: a later tree move does not reopen an answer, a changed
	 * cited source does.
	 */
	async #refreshAnswerReviews(own: OwnRun, agents: readonly AgentEntry[]): Promise<boolean> {
		const rows = own.record.results ?? [];
		const subjects = own.answerSubjects;
		if (rows.length === 0 || subjects === undefined || subjects.size === 0) return false;
		let changed = false;
		for (const row of rows) {
			if (row.state !== "reviewable" || row.scope === "excluded-by-user") continue;
			if (hasStaleInputs(row, rows)) continue;
			const subject = this.#answerReviewSubject(own, row);
			if (subject === undefined) continue;
			const verdict = answerReviewVerdict(agents, own.config, subject);
			if (verdict.state === "none") continue;
			const item = subjects.get(row.id)?.item;
			if (item === undefined) continue;
			const check = await verifyAnswerReceipt({ root: own.root, receipt: item, expectedVersion: subject.contentVersion });
			if (this.#own !== own) return changed;
			// The row may have moved during the read; a moved anchor is the revocation pass's to reopen, never judged here.
			if (!check.ok || row.state !== "reviewable" || row.attemptId !== subject.attemptId || row.contentVersion !== subject.contentVersion) continue;
			row.origin = "review";
			delete row.reviewTree;
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			if (verdict.state === "correct") {
				row.state = "accepted";
				delete row.reason;
			} else {
				row.state = "unmet";
				row.reason = compactResultReason("독립 리뷰가 이 답변을 incorrect로 판정했습니다.");
			}
			changed = true;
		}
		if (!changed) return false;
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
		return true;
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

	/** A follow-up to a cleaned agent that Storm sent back to a fresh agent. */
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
	 * Starts one background director checkpoint when this run's context is at 70% of its window and none is in flight.
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
		const cap = windowThreshold(MID_RUN_WINDOW_SHARE, usage.contextWindow);
		if (cap === undefined) return false;
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
		const blocker = this.jobGate();
		if (blocker !== undefined) return { ok: false, reason: blocker };
		return this.#upgradeLease(own);
	}

	/**
	 * Only the target's write lease, for a caller whose own step then asks the run's write table (`RunLanes.commitWriter`): a job
	 * batch or a fence is an entry of that table and refuses there, by name, instead of by the generic gate of `ensureWrite`.
	 */
	async ensureLease(ctx?: ExtensionContext): Promise<{ ok: true } | { ok: false; reason: string }> {
		const own = this.#own;
		if (own === undefined) return { ok: false, reason: "진행 중인 Storm 실행이 없어 쓰기 권한을 확인하지 못했습니다." };
		if (ctx !== undefined && closeoutSessionId(ctx) !== own.sessionId) {
			return { ok: false, reason: "다른 세션이 시작한 실행의 쓰기 권한은 빌려올 수 없습니다." };
		}
		return this.#upgradeLease(own);
	}

	jobGate(): string | undefined {
		return this.#own?.jobFence ?? (this.#own?.jobBatch === true
			? "[storm:job-wait] 정형 작업이 끝난 다음 실행하세요." : undefined);
	}

	/** Executes only jobs in this run's plan and current approval. Tool input never supplies argv or lock keys. */
	async executeJobs(
		ctx: ExtensionContext,
		names: readonly string[],
		stillOwner: () => boolean,
		signal?: AbortSignal,
	): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
		const own = this.#own;
		const plan = own?.record.plan;
		if (own === undefined || plan === undefined || !stillOwner() || closeoutSessionId(ctx) !== own.sessionId || own.ending !== undefined) {
			return { ok: false, reason: "현재 대화의 실행 계획에서만 정형 작업을 시작할 수 있습니다." };
		}
		if (own.jobFence !== undefined) return { ok: false, reason: own.jobFence };
		// The director's own path edit holds its files until its message's calls are over; the refusal says so instead of naming a worker.
		if (own.lanes.liveHolders(["director-path"]) > 0) return { ok: false, reason: `[storm:job-wait] ${directorEditWait("정형 작업")}` };
		if (reservedWorkers(own.record.runId).length > 0 || this.#hasLiveWork(own)) {
			return { ok: false, reason: "[storm:job-wait] 실행 중인 워커·검사·정형 작업이 끝난 뒤 호출하세요. 팀 변경은 필요하지 않습니다." };
		}
		const pending = [];
		for (const name of names) {
			const lane = plan.lanes.find(candidate => candidate.name === name);
			const job = own.config.jobs?.find(candidate => candidate.name === lane?.job);
			if (lane === undefined || job === undefined) return { ok: false, reason: `${name}: 이 계획에 승인된 정형 작업 레인이 아닙니다.` };
			pending.push({ lane, job });
		}
		const jobSignal = signal === undefined ? own.abort.signal : AbortSignal.any([own.abort.signal, signal]);
		const owner = (): boolean =>
			this.#own === own && own.record.plan === plan && own.ending === undefined && own.jobFence === undefined &&
			!jobSignal.aborted && stillOwner() && closeoutSessionId(ctx) === own.sessionId;
		const approved = async (): Promise<boolean> => {
			if (!owner()) return false;
			const state = await this.deps.loadState(ctx).catch(() => undefined);
			return owner() && state !== undefined && state.sessionDir === own.sessionDir && state.repo.root === own.root &&
				state.repo.repoId === own.repoId && state.config.status === "ok" &&
				state.config.hash === own.record.configHash && isApproved(state);
		};
		// The batch takes the tree in the lane table in this same synchronous step: a command of the director that is running
		// (in the foreground or in the background) refuses it, and from here a worker or a director command meets the batch.
		const holderKey = `batch-${++this.#holderSerial}`;
		const holder = own.lanes.commitHolder({ kind: "job", key: holderKey, now: this.deps.now(), agents: this.deps.agents?.(own.record.runId, own.sessionDir) });
		if (!holder.ok) return { ok: false, reason: `[storm:job-wait] ${holder.reason}` };
		own.jobBatch = true;
		try {
			// A worker the batch's place was taken from has no authority left to write beside it (R-final N4).
			const unsettled = await this.deps.settleEnds?.(own.record.runId);
			if (unsettled !== undefined) return { ok: false, reason: unsettled };
			if (!(await approved())) return { ok: false, reason: "현재 팀 승인과 작업 대상을 확인하지 못해 시작하지 않았습니다." };
			const lease = await this.#upgradeLease(own);
			if (!lease.ok) return lease;
			const lines: string[] = [];
			this.#syncResults(own);
			while (pending.length > 0 && owner()) {
				const ready: typeof pending = [];
				const deferred: typeof pending = [];
				const waiting = new Map<string, string>();
				const resources = new Set<string>();
				const prerequisites = new Set(pending.flatMap(({ lane }) => (lane.dependsOn ?? []).map(edge => edge.lane)));
				const view = await this.laneReadiness(plan, prerequisites);
				if (!owner()) break;
				for (const entry of pending) {
					const { lane, job } = entry;
					const digest = jobDigest(job);
					const previous = historicalJob(own.record, job.name);
					if (previous?.lane === lane.name && previous.status === "passed" && previous.jobSha256 === digest &&
						(own.restoredLanes.has(lane.name) || previous.attemptId?.startsWith(`job:${own.record.runId}:`)) &&
						(lane.results ?? []).every(result => own.record.results?.some(row => row.id === result.id && row.state === "accepted"))) {
						lines.push(`${lane.name}: 완료된 결과를 유지했습니다.`);
						continue;
					}
					if (unsafeToReplay(previous, digest)) {
						const previousAttempt = previous?.attemptId;
						setJobReceipt(own.record, { lane: lane.name, name: job.name, status: "unknown", exitCode: null,
							startedAt: null, finishedAt: null, jobSha256: digest, detail: UNCERTAIN_JOB,
							...(typeof previousAttempt === "string" && ATTEMPT_REF.test(previousAttempt) ? { attemptId: previousAttempt } : {}) });
						for (const row of own.record.results ?? []) if (row.lane === lane.name) blockedJobRow(row, UNCERTAIN_JOB);
						lines.push(`${lane.name}: 차단 · ${UNCERTAIN_JOB}`);
						continue;
					}
					const reason = dependencyBlock(lane, view);
					const keys = job.resources ?? [];
					if (reason !== undefined) waiting.set(lane.name, reason);
					if (reason !== undefined || ready.length >= 4 ||
						(ready.length > 0 && (keys.length === 0 || resources.size === 0)) || keys.some(key => resources.has(key))) {
						deferred.push(entry);
						continue;
					}
					ready.push(entry);
					for (const key of keys) resources.add(key);
				}
				if (ready.length === 0) {
					this.#invalidateConsumers(own);
					this.#scheduleFlush(own);
					for (const [name, reason] of waiting) lines.push(`${name}: 대기 · ${reason}`);
					break;
				}
				lines.push(...await Promise.all(ready.map(async ({ lane, job }) => {
					const inputs = inputSnapshot(plan, lane, own.record.results);
					const attempt = `job:${own.record.runId}:${++own.attemptSerial}`;
					const jobSha256 = jobDigest(job);
					const receipt = await runConfiguredJob({
						job,
						cwd: own.root,
						resourceKeys: job.resources?.length
							? job.resources.map(key => `resource:${createHash("sha256").update(key).digest("hex")}`)
							: [`target:${createHash("sha256").update(own.root).digest("hex")}`],
						signal: jobSignal,
						targetFence: true,
						timings: this.#timings,
						canStart: async () => {
							if (!(await approved())) return false;
							setJobReceipt(own.record, { lane: lane.name, name: job.name, status: "started", exitCode: null,
								startedAt: iso(this.deps.now()), finishedAt: null, attemptId: attempt, jobSha256 });
							await this.#writeLiveSnapshot(own);
							return approved();
						},
					});
					const { name, status, exitCode, startedAt, finishedAt, detail, fence, unrunCause } = receipt;
					const inconclusive = fence?.cause === "process-unproven";
					const ambiguous = fence !== undefined || unrunCause === "owner-dead" || unrunCause === "owner-unknown" || unrunCause === "record-invalid";
					if (inconclusive) {
						own.jobFence = "[storm:job-fence] 정형 작업의 프로세스 종료를 확인할 수 없어 이 작업 대상을 계속 보호합니다. 실행 기록의 잠금 위치를 확인하세요.";
						// The fence ends when the OS later shows every unproven group empty (as a check's fence does); a child that cannot be probed keeps it.
						const unproven = (own.jobUnproven ??= { open: 0, hard: false });
						if (receipt.ended === undefined) unproven.hard = true;
						else {
							unproven.open += 1;
							void receipt.ended.then(() => {
								unproven.open -= 1;
								if (unproven.open > 0 || unproven.hard || own.jobUnproven !== unproven) return;
								delete own.jobFence;
								delete own.jobUnproven;
								own.lanes.releaseHolder("fence", holderKey);
								this.#scheduleFlush(own);
							});
						}
					}
					const version = createHash("sha256").update(receipt.stdout.tail).digest("hex");
					setJobReceipt(own.record, { lane: lane.name, name, status: inconclusive ? "unknown" : status,
						exitCode, startedAt, finishedAt, attemptId: attempt, jobSha256,
						...(status === "passed" ? { stdoutSha256: version } : {}),
						...(detail === undefined ? {} : { detail }),
						...(fence === undefined ? {} : { fence }),
					});
					if (ambiguous && stillOwner() && detail !== undefined) this.deps.ui(ctx).notify(detail, "warning");
					for (const result of lane.results ?? []) {
						const row = own.record.results?.find(candidate => candidate.id === result.id && candidate.lane === lane.name);
						if (!row || row.identity !== resultContractIdentity(result)) continue;
						const matches = !ambiguous && status === "passed" && exitCode === 0 && result.contains !== undefined && receipt.stdout.tail.includes(result.contains);
						row.state = matches ? "accepted" : "unmet";
						row.origin = "attempt";
						row.attemptId = attempt;
						delete row.remedy;
						delete row.unblock;
						delete row.retryRoute;
						delete row.reviewTree;
						delete row.proof;
						delete row.restoredFrom;
						if (inputs.length > 0) row.consumed = inputs;
						else delete row.consumed;
						if (matches) {
							row.contentVersion = version;
							delete row.reason;
						} else if (ambiguous) {
							blockedJobRow(row, "정형 작업의 종료 또는 자원 소유권을 확인하지 못했습니다.");
						} else {
							delete row.contentVersion;
							row.reason = status === "passed" ? "기대한 stdout 근거를 확인하지 못했습니다." :
								compactResultReason(detail ?? `실행 ${status}${exitCode === null ? "" : ` (exit ${exitCode})`}`);
						}
					}
					await this.#writeLiveSnapshot(own).catch(() => undefined);
					return `${lane.name} (${name}): ${status}${exitCode === null ? "" : ` · exit ${exitCode}`}${detail === undefined ? "" : ` · ${detail}`}`;
				})));
				this.#invalidateConsumers(own);
				this.#scheduleFlush(own);
				pending.splice(0, pending.length, ...deferred);
			}
			return { ok: true, text: lines.join("\n") || "정형 작업을 시작하기 전에 실행이 중단되었습니다." };
		} finally {
			delete own.jobBatch;
			// A fence stays for the run (the processes' end was not proven); otherwise the batch's end proved every group empty.
			if (own.jobFence !== undefined) own.lanes.fenceHolder("job", holderKey);
			else own.lanes.releaseHolder("job", holderKey);
			if (this.#own === own) this.#emitPhase(own);
		}
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
		const blocker = this.jobGate();
		if (blocker !== undefined) return { ok: false, reason: blocker };
		for (const receipt of own.record.jobs ?? []) {
			const lane = plan.lanes.find(candidate => candidate.job === receipt.name);
			if (lane !== undefined && lane.name !== receipt.lane) {
				return { ok: false, reason: `${receipt.name}: 이미 확인된 정형 작업 레인 ${receipt.lane}의 이름을 유지하세요.` };
			}
		}
		// An acknowledged user exclusion is not a relaxable obligation: the same id and the excluded lane name may not
		// be reintroduced by a later plan, even one that would otherwise be a valid replan.
		const excluded = excludedPlanConflict(own.record.results, plan);
		if (excluded !== undefined) return { ok: false, reason: excluded };
		// A lane keeps the identity its evidence is bound to: goal, kind, role and files. A status update belongs in
		// progress; renaming a changed lane is the only way to start its evidence over. Reject before touching the plan
		// in force or the record, so a refused replan leaves both exactly as they were. The run's own row identities are
		// checked too: a requirement that has moved or lost its lane cannot be rewritten by a later plan reusing its id.
		const weakened = requirementConflict(own.record.results, plan);
		if (weakened !== undefined) return { ok: false, reason: weakened };
		const conflict = replanConflict(own.record.plan, plan);
		if (conflict !== undefined) return { ok: false, reason: conflict };
		const revision = own.planRevision;
		const previousPlan = own.record.plan;
		if (own.integration !== undefined && this.deps.integration?.(own.sessionDir) !== undefined) {
			await this.#revokeStaleIntegratedReceipts(own);
			if (this.#own !== own || own.record.plan !== previousPlan) {
				return { ok: false, reason: "실행이나 계획이 바뀌어 계획을 적용하지 않았습니다." };
			}
		}
		if (planNeedsWrite(plan)) {
			const upgraded = await this.#upgradeLease(own);
			if (!upgraded.ok) return upgraded;
			if (this.#own !== own) return { ok: false, reason: "실행이 바뀌어 계획을 적용하지 않았습니다." };
			// A user exclusion may have removed a lane while the lease upgrade awaited; applying this plan now would
			// reintroduce it and race the persisted adjustment.
			if (own.planRevision !== revision) return { ok: false, reason: "계획이 동시에 바뀌어 계획을 적용하지 않았습니다. 현재 계획을 확인한 뒤 다시 제출하세요." };
		}
		// A level made `integrated` is kept only when the producer's accepted result is integrated now; that is a tree
		// fact, read through the same readiness check a consumer admission uses, and only for those producers.
		const strengthened = previousPlan === undefined ? new Set<string>() : integratedStrengthening(previousPlan, plan);
		const producers = new Set(plan.lanes.filter(lane => lane.results?.some(result => strengthened.has(result.id))).map(lane => lane.name));
		const readiness = producers.size === 0 ? undefined : await this.laneReadiness(plan, producers);
		if (this.#own !== own || own.planRevision !== revision || own.record.plan !== previousPlan) {
			return { ok: false, reason: "계획이 동시에 바뀌어 계획을 적용하지 않았습니다. 현재 계획을 확인한 뒤 다시 제출하세요." };
		}
		const integrated = new Set(
			[...(readiness?.values() ?? [])].flatMap(lane => lane.results.filter(result => result.integrated).map(result => result.id)),
		);
		const satisfied = ledgerInputSatisfaction(own.record.results, id => integrated.has(id));
		// A stopping run blocks new spawns; its plan is no longer authority for them.
		if (!setLedgerPlan(own.record.runId, plan)) {
			return { ok: false, reason: "실행이 끝나는 중이라 계획을 적용하지 않았습니다." };
		}
		own.record.plan = plan;
		own.planRevision += 1;
		// Required results are obligations, not plan text: adding a lane seeds pending rows, and a removed lane keeps
		// every requirement it still owed. A requirement whose logical inputs changed (B@1 → C@1, an added/removed
		// input, or a level stronger than the producer meets now) reopens with everything that consumed it; a weaker
		// level or a pure lane rename reopens nothing.
		this.#syncResults(own, previousPlan, satisfied);
		for (const lane of plan.lanes) {
			if (lane.job === undefined || historicalJob(own.record, lane.job)?.status !== "unknown") continue;
			for (const row of own.record.results ?? []) if (row.lane === lane.name) blockedJobRow(row, UNCERTAIN_JOB);
		}
		// A pending retry is valid only against the contract, route and inputs it was granted for.
		this.#revalidateRetry(own, ctx);
		this.#scheduleFlush(own);
		return { ok: true };
	}

	/**
	 * Applies one direct user steering action to this session's active run. Only the interactive input hook and the
	 * explicit `/storm adjust` fallback call it: there is no model tool, no queued authority, and no new run. The
	 * resolved target, the run owner and every admission fact are read from the host's current state here, not from
	 * the text at a later turn.
	 */
	async adjust(ctx: ExtensionContext, request: AdjustRequest): Promise<AdjustOutcome> {
		const own = this.#own;
		if (own === undefined) return { ok: false, reason: "진행 중인 Storm 실행이 없습니다. 조정은 이 세션의 실행 중에만 적용됩니다." };
		if (closeoutSessionId(ctx) !== own.sessionId) return { ok: false, reason: "다른 세션이 시작한 실행은 조정할 수 없습니다." };
		if (own.ending !== undefined || own.abort.signal.aborted) {
			return { ok: false, reason: "실행이 끝나는 중이라 범위나 재시도를 바꾸지 않았습니다." };
		}
		const resolved = resolveAdjustTarget(own.record.plan, own.record.results, request.kind, request.target, request.exact === true);
		if (!resolved.ok) return { ok: false, reason: resolved.reason };
		return request.kind === "exclude"
			? this.#excludeResult(own, resolved.target, ctx)
			: this.#retryResult(own, resolved.target, request, ctx);
	}

	/** Removes one untouched lane from the effective plan and records the operator's exclusion. */
	async #excludeResult(own: OwnRun, target: AdjustTarget, ctx: ExtensionContext): Promise<AdjustOutcome> {
		const plan = own.record.plan;
		if (plan === undefined) return { ok: false, reason: "이 실행에는 적용 중인 계획이 없어 결과를 제외할 수 없습니다." };
		const row = own.record.results?.find(candidate => candidate.id === target.resultId);
		if (row === undefined) return { ok: false, reason: `결과 '${target.resultId}'의 기록을 찾지 못해 제외하지 않았습니다.` };
		if (row.scope === "excluded-by-user") {
			return { ok: true, already: true, text: `'${target.label}' 결과(${target.resultId})는 이미 범위에서 제외되어 있습니다.` };
		}
		const lane = plan.lanes.find(candidate => candidate.name === target.laneName);
		if (lane === undefined) return { ok: false, reason: "대상 레인이 현재 계획에 없어 결과를 제외할 수 없습니다." };
		const touched = (spawnsByRun.get(own.record.runId) ?? []).some(spawn => spawn.lane === lane.name && spawn.outcome !== "blocked");
		const problem = excludeProblem({
			plan,
			rows: own.record.results ?? [],
			lane,
			resultId: target.resultId,
			laneBusy: this.#laneBusy(own, lane.name),
			laneTouched: touched,
		});
		if (problem !== undefined) return { ok: false, reason: problem };
		const nextPlan: RunPlan = { ...plan, lanes: plan.lanes.filter(candidate => candidate.name !== lane.name) };
		// Validation had no await, so this is the same plan the guards read. Keep the check anyway: a host callback can
		// run between two statements only through an await, and this method must never apply on an obsolete owner.
		if (this.#own !== own || own.record.plan !== plan) return { ok: false, reason: "실행이나 계획이 바뀌어 결과를 제외하지 않았습니다." };
		if (!setLedgerPlan(own.record.runId, nextPlan)) return { ok: false, reason: "실행이 끝나는 중이라 계획에서 레인을 제외하지 않았습니다." };
		own.record.plan = nextPlan;
		own.planRevision += 1;
		row.scope = "excluded-by-user";
		row.reason = EXCLUDED_RESULT_REASON;
		// A user intervention is a new external fact for the round witness: clear only the progress baseline, never a
		// round counter, role, budget or approval. It does not reset the run or authorize any new scope.
		delete own.progress;
		this.#syncResults(own, plan);
		this.#recordAdjustment(own, "exclude", target);
		this.#scheduleFlush(own);
		try {
			await this.#writeLiveSnapshot(own);
		} catch {
			return { ok: false, reason: "결과 제외는 적용했지만 실행 기록을 저장하지 못했습니다. 기록 상태를 확인하세요." };
		}
		if (this.#own === own) this.#sendAdjustNudge(own, ctx, exclusionNudgeText(own.record.runId, target), "exclude");
		return {
			ok: true,
			text: `'${target.label}' 결과(${target.resultId})를 이 실행의 범위에서 제외했습니다. 레인은 계획에서 빠졌고 다른 결과의 증거는 그대로입니다.`,
		};
	}

	/** Grants exactly one retry of a host-settled, unmet, read-only single-result lane on its unchanged route. */
	async #retryResult(own: OwnRun, target: AdjustTarget, request: AdjustRequest, ctx: ExtensionContext): Promise<AdjustOutcome> {
		const plan = own.record.plan;
		if (plan === undefined) return { ok: false, reason: "이 실행에는 적용 중인 계획이 없어 재시도를 예약할 수 없습니다." };
		const lane = plan.lanes.find(candidate => candidate.name === target.laneName);
		if (lane === undefined) return { ok: false, reason: "대상 레인이 현재 계획에 없어 재시도할 수 없습니다." };
		const row = own.record.results?.find(candidate => candidate.id === target.resultId);
		if (row?.scope === "excluded-by-user") return { ok: false, reason: `'${target.label}' 결과는 사용자가 범위에서 제외해 재시도하지 않습니다.` };
		const now = this.deps.now();
		const normalized = request.target.normalize("NFC").trim();
		const last = own.lastRetry;
		if (request.source === "interactive" && last !== undefined && last.text === normalized && last.lane === lane.name &&
			last.result === target.resultId && now - last.at < ADJUST_REPLAY_MS) {
			return { ok: true, already: true, text: `방금 같은 재시도 요청을 접수했습니다. 결과 '${target.label}'(${target.resultId})에 중복 시도를 만들지 않습니다.` };
		}
		if (own.retry !== undefined) {
			if (own.retry.lane === lane.name && own.retry.result === target.resultId) {
				return { ok: true, already: true, text: `결과 '${target.label}'(${target.resultId})의 재시도가 이미 한 번 예약되어 있습니다.` };
			}
			return { ok: false, reason: "이미 다른 결과의 재시도가 예약되어 있습니다. 그 시도가 시작된 뒤 다시 요청하세요." };
		}
		const inputs = inputSnapshot(plan, lane, own.record.results);
		const problem = retryProblem({
			plan,
			rows: own.record.results ?? [],
			lane,
			resultId: target.resultId,
			laneBusy: this.#laneBusy(own, lane.name),
			inputsMatch: sameInputs(inputs, row?.consumed),
			inputsAvailable: !(row?.consumed ?? []).some(input => input.version === "missing"),
		});
		if (problem !== undefined) return { ok: false, reason: problem };
		const baseAttempt = row?.attemptId;
		if (baseAttempt === undefined) return { ok: false, reason: `'${target.label}' 결과는 호스트가 확정한 시도가 없어 재시도할 수 없습니다.` };
		const key = retryAdjustmentKey(lane.name, target.resultId, baseAttempt);
		if (own.retryAcks.has(key)) {
			return { ok: true, already: true, text: `결과 '${target.label}'(${target.resultId})의 같은 시도에 대한 재시도는 이미 접수했습니다.` };
		}
		const result = lane.results?.[0];
		if (result === undefined) return { ok: false, reason: "대상 레인에 결과가 없어 재시도할 수 없습니다." };
		const agentId = own.lanes.agentForLane(lane.name);
		const grant: RetryGrant = {
			key,
			lane: lane.name,
			result: target.resultId,
			label: target.label,
			...(agentId === undefined ? {} : { agentId }),
			dependencies: JSON.stringify(lane.dependsOn ?? []),
			route: laneRouteFingerprint(lane),
			identity: resultContractIdentity(result),
			inputs,
			baseAttempt,
			at: now,
		};
		const previousProgress = own.progress;
		own.retry = grant;
		own.retryAcks.add(key);
		own.lastRetry = { text: normalized, lane: lane.name, result: target.resultId, at: now };
		delete own.progress;
		this.#recordAdjustment(own, "retry", target);
		this.#scheduleFlush(own);
		try {
			await this.#writeLiveSnapshot(own);
		} catch {
			if (own.retry === grant) delete own.retry;
			own.retryAcks.delete(key);
			delete own.lastRetry;
			if (previousProgress !== undefined) own.progress = previousProgress;
			this.#removeAdjustment(own, "retry", target);
			return { ok: false, reason: "재시도 예약을 실행 기록에 저장하지 못해 적용하지 않았습니다." };
		}
		if (this.#own !== own) return { ok: false, reason: "실행이 바뀌어 재시도를 예약하지 않았습니다." };
		if (own.ending !== undefined || own.abort.signal.aborted) return { ok: false, reason: "실행이 끝나는 중이라 재시도를 예약하지 않았습니다." };
		if (own.retry !== grant) return { ok: false, reason: "계획이나 입력이 바뀌어 예약한 재시도를 적용하지 않았습니다. 현재 계획의 정상 흐름으로만 진행합니다." };
		this.#sendAdjustNudge(own, ctx, retryNudgeText(own.record.runId, grant), "retry");
		return {
			ok: true,
			text: `결과 '${target.label}'(${target.resultId})의 재시도를 한 번 예약했습니다. 같은 계약·경로·입력 버전의 다음 정상 시도 한 번에만 적용되고, 계획이 바뀌면 취소됩니다.`,
		};
	}

	/** A lane is busy only from live work or an admission already in flight; an idle settled worker is not. */
	#laneBusy(own: OwnRun, laneName: string): boolean {
		for (const prepared of own.attempts.values()) if (prepared.lane === laneName) return true;
		if (own.settling.has(laneName)) return true;
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		return own.lanes.laneBusy(laneName, agents, this.deps.now());
	}

	/** Whether the pending grant still names the same run contract, route, settled attempt and input versions. */
	#retryMatches(own: OwnRun, grant: RetryGrant): boolean {
		const plan = own.record.plan;
		const lane = plan?.lanes.find(candidate => candidate.name === grant.lane);
		const result = lane?.results?.[0];
		if (plan === undefined || lane === undefined || result === undefined || (lane.results?.length ?? 0) !== 1) return false;
		if (result.id !== grant.result || resultContractIdentity(result) !== grant.identity || laneRouteFingerprint(lane) !== grant.route) return false;
		if (JSON.stringify(lane.dependsOn ?? []) !== grant.dependencies || own.lanes.agentForLane(lane.name) !== grant.agentId) return false;
		const row = own.record.results?.find(candidate => candidate.id === grant.result);
		if (row === undefined || row.scope === "excluded-by-user" || row.state !== "unmet" || row.attemptId !== grant.baseAttempt) return false;
		return sameInputs(inputSnapshot(plan, lane, own.record.results), grant.inputs);
	}

	/** Drops a pending grant whose plan, row or inputs moved; the user is told instead of a stale retry being replayed. */
	#revalidateRetry(own: OwnRun, ctx?: ExtensionContext): void {
		const grant = own.retry;
		if (grant === undefined || this.#retryMatches(own, grant)) return;
		delete own.retry;
		own.retryAcks.delete(grant.key);
		delete own.lastRetry;
		if (ctx !== undefined) this.deps.ui(ctx).notify("계획이나 입력이 바뀌어 예약한 재시도를 적용하지 않았습니다. 현재 계획의 정상 흐름으로만 진행합니다.", "warning");
	}

	/** Marks the one-shot grant as consumed by a prepared attempt and stamps the durable acknowledgement. */
	#markRetryTaken(own: OwnRun, grant: RetryGrant): RetryTaken {
		const taken: RetryTaken = { grant };
		const row = own.record.results?.find(candidate => candidate.id === grant.result);
		if (row !== undefined) {
			if (row.reason !== undefined) taken.reason = row.reason;
			row.reason = compactResultReason("사용자 요청으로 같은 계약을 한 번 더 시도합니다.");
		}
		const list = own.record.adjustments;
		if (list === undefined) return taken;
		for (let index = list.length - 1; index >= 0; index -= 1) {
			const entry = list[index];
			if (entry?.kind !== "retry" || entry.id !== grant.result || entry.lane !== grant.lane || entry.takenAt !== undefined) continue;
			entry.takenAt = iso(this.deps.now());
			taken.entry = entry;
			break;
		}
		return taken;
	}

	/**
	 * Undoes `#markRetryTaken` for an attempt that never ran. The grant comes back only while it still names the same
	 * row, contract and inputs and no other retry was asked for meanwhile; otherwise it stays spent, as a plan change
	 * would have made it.
	 */
	#giveRetryBack(own: OwnRun, taken: RetryTaken): void {
		const grant = taken.grant;
		if (own.retry !== undefined || own.ending !== undefined || !this.#retryMatches(own, grant)) return;
		const row = own.record.results?.find(candidate => candidate.id === grant.result);
		if (row !== undefined) {
			if (taken.reason === undefined) delete row.reason;
			else row.reason = taken.reason;
		}
		if (taken.entry !== undefined && own.record.adjustments?.includes(taken.entry) === true) delete taken.entry.takenAt;
		own.retry = grant;
		this.#scheduleFlush(own);
	}

	/** Appends one bounded audit entry; this is an acknowledgement, never authority a later run can replay. */
	#recordAdjustment(own: OwnRun, kind: RunAdjustment["kind"], target: AdjustTarget): void {
		const list = (own.record.adjustments ??= []);
		list.push({
			kind,
			id: target.resultId,
			...(target.laneName === "" ? {} : { lane: target.laneName }),
			at: iso(this.deps.now()),
		});
		if (list.length > ADJUSTMENTS_MAX) list.splice(0, list.length - ADJUSTMENTS_MAX);
	}

	/** Rolls back an acknowledgement entry when its live write failed before the action was confirmed. */
	#removeAdjustment(own: OwnRun, kind: RunAdjustment["kind"], target: AdjustTarget): void {
		const list = own.record.adjustments;
		if (list === undefined) return;
		for (let index = list.length - 1; index >= 0; index -= 1) {
			const entry = list[index];
			if (entry?.kind !== kind || entry.id !== target.resultId || entry.takenAt !== undefined) continue;
			list.splice(index, 1);
			break;
		}
		if (list.length === 0) delete own.record.adjustments;
	}

	/**
	 * Sends the bounded adjustment nudge only when the session is not in a turn or held; a retry stays for the next
	 * normal round message, and an exclusion note is appended there. This is a message to the same main supervisor,
	 * never a new run, spawn or task.
	 */
	#sendAdjustNudge(own: OwnRun, ctx: ExtensionContext, message: string, kind: RunAdjustment["kind"]): void {
		if (this.#own !== own || own.ending !== undefined || own.abort.signal.aborted) return;
		// A scheduled look, a turn, a running check or held async work already owns the next normal round. Deliver the
		// hint with that round instead of injecting an extra user turn ahead of it.
		const deferred =
			own.inTurn || own.awaitingRound !== undefined || own.hold !== undefined || own.awaitingAsync ||
			own.checking !== undefined || own.checksRunning === true || own.jobBatch === true || this.#held(ctx);
		if (kind === "retry") {
			const grant = own.retry;
			if (grant === undefined || deferred) return;
			grant.nudged = true;
			this.deps.pi.sendUserMessage(message).catch(() => {
				if (this.#own !== own || own.retry !== grant) return;
				delete grant.nudged;
			});
			return;
		}
		if (deferred) {
			(own.adjustNotes ??= []).push(message);
			if (own.adjustNotes.length > 4) own.adjustNotes.shift();
			return;
		}
		this.deps.pi.sendUserMessage(message).catch(() => {
			if (this.#own !== own) return;
			(own.adjustNotes ??= []).push(message);
			if (own.adjustNotes.length > 4) own.adjustNotes.shift();
		});
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
				reason: "결과 브리프가 올바르지 않습니다. 결과·검증은 비어 있지 않은 한 줄, next는 서로 다른 0~3개 방향(resume, run, user)이어야 합니다.",
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
		if (own.jobFence !== undefined) return this.#stop(own, aborted ? "interrupted" : "no-progress", ctx);
		const turns = own.record.turns ?? 0;
		// The turn settled: the live line moves to the round decision before any tree read or check starts.
		this.#emitPhase(own);
		const { decision, tree } = await this.#roundDecision(own, aborted, false);
		// The tree read may have outlasted the round: a new turn or an end decided meanwhile owns the run now.
		if (!this.#live(own, turns)) return;
		if (decision.action === "end") {
			// A ready required check is verification, not another model round. Give it one timer look before a budget
			// end, so a last-round review can still be proven or honestly fail.
			if ((decision.reason === "round-limit" || decision.reason === "no-progress") && this.#hasPendingCheck(own, tree)) {
				if (!this.#live(own, turns)) return;
				own.checksOnlyEnd = decision.reason;
				this.#arm(own, ctx, this.#timings.roundDelayMs);
				return;
			}
			return this.#stop(own, decision.reason, ctx);
		}
		this.#arm(own, ctx, this.#timings.roundDelayMs);
	}

	/**
	 * Whether a required check is ready to run for this tree and could still change the gate. It is not a review,
	 * another model round, or a reason to replay a check already attempted for this tree.
	 */
	#hasPendingCheck(own: OwnRun, now: TreeReading | undefined): boolean {
		if ((own.config.requiredChecks?.length ?? 0) === 0) return false;
		if (own.ending !== undefined || own.abort.signal.aborted) return false;
		// The decision's own reading: a second read in the same host handler could double a slow repository's wait.
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
			},
			this.#coverage(own, undefined, planLanes),
			{ directorEdit: own.directorEdit === true },
		);
		return gate.state === "unverified" && gate.cause === "coverage";
	}

	/** Whether `own` is still what the decision was taken from: this session's run, the same round, and not already ending. */
	#live(own: OwnRun, turns: number): boolean {
		return this.#own === own && !own.inTurn && own.ending === undefined && (own.record.turns ?? 0) === turns;
	}

	/** The round's decision from the tree now and the gate as the ledger has it after that. */
	async #roundDecision(own: OwnRun, aborted: boolean, allowChecks: boolean): Promise<{ decision: RoundDecision; tree: TreeReading | undefined }> {
		await this.#revokeUnlocatedAccepted(own, true);
		let now = await this.#treeAt(own.root, own.base);
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const planLanes = this.#planLanes(own, agents);
		const tree = {
			...(own.tree !== undefined ? { start: own.tree } : {}),
			...(now !== undefined ? { now: now.state } : {}),
		};
		// The pure gate already knows empty coverage (no checks, no lanes) from the start. Checks run only from the
		// look timer, never inside omp's agent_end handler: they may take far longer than its budget.
		const initial = this.#coverage(own, undefined, planLanes);
		initial.checks = [];
		const baseGate = reviewGate(agents, own.config, tree, initial, { directorEdit: own.directorEdit === true });
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
		await this.#refreshAnswerReviews(own, agents);
		const currentTree = {
			...(tree.start !== undefined ? { start: tree.start } : {}),
			...(now !== undefined ? { now: now.state } : {}),
		};
		const coverage = this.#coverage(own, now?.state, planLanes);
		const gate = reviewGate(agents, own.config, currentTree, coverage, { directorEdit: own.directorEdit === true });
		const decision = decideRound({
			gate,
			turns: own.record.turns ?? 0,
			...(own.maxRounds === undefined ? {} : { maxRounds: own.maxRounds }),
			aborted,
			overBudget: getLedgerRun(own.record.runId)?.exceeded ?? false,
			elapsedMs: this.deps.now() - Date.parse(own.record.startedAt),
			...(own.minutes !== undefined ? { minutes: own.minutes } : {}),
			...(own.progress ? { progressSince: own.progress } : {}),
			...(own.stalled === undefined ? {} : { stalled: own.stalled }),
			// Only R9's plan-less door takes the zero-row end: a manual or planned run may still verify through its
			// required checks, so its gate keeps its existing meaning there (the coordinator's regression).
			noDeclaredResults: own.planless === true && (own.record.results?.length ?? 0) === 0,
			parentChanged: treeMoved(currentTree, coverage),
			directorEdit: own.directorEdit === true,
		});
		return { decision, tree: now };
	}

	/** Plan lanes as coverage evidence: a settled worker is not done while a declared row is pending or unmet. */
	#planLanes(own: OwnRun, agents: readonly AgentEntry[]): CoverageLane[] | undefined {
		const plan = own.record.plan;
		if (plan === undefined) return undefined;
		const remaining = new Set(own.lanes.remaining(plan, agents, this.#failedIds(own, agents)));
		for (const lane of plan.lanes) {
			if (lane.job !== undefined && own.record.jobs?.some(job => job.name === lane.job && job.lane === lane.name && job.status === "passed" &&
				(own.restoredLanes.has(lane.name) || job.attemptId?.startsWith(`job:${own.record.runId}:`)))) remaining.delete(lane.name);
			if (own.restoredLanes.has(lane.name) && lane.results?.length &&
				lane.results.every(result => own.record.results?.some(row => row.id === result.id &&
					(row.state === "accepted" || (row.state === "reviewable" && row.restoredFrom !== undefined))))) remaining.delete(lane.name);
		}
		for (const row of own.record.results ?? []) {
			if (row.scope === "excluded-by-user") continue;
			if (row.lane !== undefined && (row.state === "pending" || row.state === "unmet")) remaining.add(row.lane);
		}
		const excludedIds = new Set((own.record.results ?? []).filter(row => row.scope === "excluded-by-user").map(row => row.id));
		return plan.lanes
			.filter(lane => {
				const results = lane.results ?? [];
				return results.length === 0 || !results.every(result => excludedIds.has(result.id));
			})
			.map(lane => ({ name: lane.name, state: remaining.has(lane.name) ? "pending" : "done" }));
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
			if (row.scope === "excluded-by-user" || row.state !== "pending" || row.lane === undefined) continue;
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
			// An acknowledged user exclusion is not a proof obligation or a gate blocker. Its row remains in the record
			// for display and is never accepted; finalization separately refuses a verified label with no in-scope proof.
			if (row.scope === "excluded-by-user") continue;
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
			// A reviewable answer names the receipt and anchor of its exact submission. Without them no verdict can be
			// bound, and the round sends it back to its producer instead of to a review that could never settle it.
			const answerReview = row.state === "reviewable" && !orphan && result?.kind === "answer" ? this.#answerReviewSubject(own, row) : undefined;
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
				...(row.state === "reviewable" && (orphan || (result !== undefined && result.kind !== "change" && result.kind !== "answer"))
					? { judgeable: false }
					: {}),
				...(answerReview === undefined ? {} : { review: { receipt: answerReview.receipt, citation: answerReviewAnchor(answerReview.citation) } }),
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
		if (own.record.results?.some(row => row.restoredFrom !== undefined && row.contract?.kind === "change" &&
			(row.state === "accepted" || row.state === "reviewable"))) coverage.restoredChange = true;
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
		// The check takes the tree in the lane table in this same synchronous step. A command of the director that is running
		// (even one omp moved to the background), a job or a fence holds it: this look runs no check and a later look asks again.
		const holderKey = `check-${++this.#holderSerial}`;
		if (!own.lanes.commitHolder({ kind: "check", key: holderKey, now: this.deps.now(), agents: this.deps.agents?.(own.record.runId, own.sessionDir) }).ok) return now;
		own.checking = fingerprint;
		// A check whose process end is not proven turns its entry into a fence that only that end releases.
		let fenced = false;
		try {
			// A worker the check's place was taken from has no authority left to write beside it; a failed withdrawal runs no check now (R-final N4).
			if ((await this.deps.settleEnds?.(own.record.runId)) !== undefined) return now;
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
					timings: this.#timings,
					onEndUnproven: ({ ended }) => {
						fenced = true;
						own.lanes.fenceHolder("check", holderKey);
						// The tree stays held until the group is later seen empty, and no new run may take this target before it.
						const release = trackUnprovenCheck(own.root, ended);
						void ended.then(() => {
							own.lanes.releaseHolder("fence", holderKey);
							release();
						});
					},
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
			if (report.endUnproven !== undefined) {
				// The check's processes may still be writing: the tree is not quiet, so nothing this report says is evidence.
				own.checks.set(fingerprint, "skipped");
				this.deps.ui(own.ctx).notify(
					`필수 검사 ${report.endUnproven.check}의 프로세스가 끝났는지 확인하지 못해 이 검사 결과는 근거로 쓰지 않습니다. 끝났다고 확인될 때까지 이 작업 트리를 쓰는 새 작업을 시작하지 않습니다.`,
					"warning",
				);
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
			if (!fenced) own.lanes.releaseHolder("check", holderKey);
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
		if (this.#held(ctx)) return this.#arm(own, ctx, this.#timings.holdMs);
		const turns = own.record.turns ?? 0;
		const checkOnly = own.checksOnlyEnd;
		const { decision } = await this.#roundDecision(own, false, true);
		if (!this.#live(own, turns)) return;
		if (checkOnly !== undefined) {
			delete own.checksOnlyEnd;
			// Verification-only: the check outcome may end verified, or the original budget end stands. Never send a
			// model round from here, and never schedule a second look for the same tree.
			if (decision.action === "end") return this.#stop(own, decision.reason, ctx);
			return this.#stop(own, checkOnly, ctx);
		}
		if (decision.action === "end") return this.#stop(own, decision.reason, ctx);
		this.#sendRound(own, ctx, decision);
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
	#sendRound(own: OwnRun, ctx: ExtensionContext, decision: RoundContinue): void {
		if (own.ending !== undefined || this.#own !== own) return;
		// Exact native receipts settled since the last event decide whether this round may still be sent.
		this.#ingestPaid(own);
		if (own.ending !== undefined || this.#own !== own) return;
		const ui = this.deps.ui(ctx);
		const { gate, round, stalled } = decision;
		// A plain/review round may intervene between two result gates. Keep the last witness so the next result gate does
		// not look like a brand-new obligation forever; a genuinely changed witness still counts once.
		const witness = gate.resultProgress ?? own.progress?.result;
		own.progress = {
			changes: gate.changes,
			reviews: gate.reviews,
			requests: gate.requests,
			...(witness === undefined ? {} : { result: witness }),
			...(gate.by === "tree" ? { tree: true as const } : {}),
		};
		own.stalled = stalled;
		// Only a review repair needs a reviewer name; a lane or check repair round has no review to request.
		const reviewer = usableRole(own.config, "reviewer")?.agent;
		ui.notify(
			own.maxRounds === undefined
				? `검증되지 않은 변경이 있어 ${round}라운드를 시작합니다.`
				: `검증되지 않은 변경이 있어 ${round}라운드를 시작합니다(최대 ${own.maxRounds}라운드).`,
		);
		this.#liveStatus(ctx, this.active());
		own.awaitingRound = round;
		this.#emitPhase(own);
		const notes = own.adjustNotes ?? [];
		if (notes.length > 0) delete own.adjustNotes;
		let retryNote: string | undefined;
		if (own.retry !== undefined) {
			if (this.#retryMatches(own, own.retry)) {
				if (own.retry.nudged !== true) {
					retryNote = retryNudgeText(own.record.runId, own.retry);
					own.retry.nudged = true;
				}
			} else {
				own.retryAcks.delete(own.retry.key);
				delete own.retry;
				delete own.lastRetry;
			}
		}
		// A round re-offers every answer still waiting for a verdict. While an approved reviewer still runs or holds a
		// slot, its batch stays its own, so no answer goes to two reviewers; the next round re-offers it otherwise.
		const reviewing =
			(this.deps.agents?.(own.record.runId, own.sessionDir) ?? []).some(agent => agent.role === "reviewer" && agent.state === "running") ||
			reservedWorkers(own.record.runId).some(slot => slot.role === "reviewer");
		if (!reviewing) delete own.answerHandout;
		const load = this.#answerReviewLoad(own);
		const base = buildRoundMessage({
			runId: own.record.runId,
			round,
			...(own.maxRounds === undefined ? {} : { maxRounds: own.maxRounds }),
			gate,
			...(reviewer !== undefined ? { reviewer } : {}),
			stalled,
			...(reviewer !== undefined && load.answers > 0 ? { answerReviews: { ...load, slots: this.#reviewerSlots(own) } } : {}),
		});
		const extra = [...notes, ...(retryNote === undefined ? [] : [retryNote])].join("\n\n");
		this.deps.pi.sendUserMessage(extra === "" ? base : `${base}\n\n${extra}`).catch((error: unknown) => {
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

	/**
	 * Reviewers that may run at once in this run: the plan's reviewer workers, or the role's approved maximum when the
	 * plan gives it none. Spawn admission enforces the same ceiling; more review batches than this queue.
	 */
	#reviewerSlots(own: OwnRun): number {
		const planned = own.record.plan?.workers.reviewer ?? 0;
		return Math.max(1, planned > 0 ? planned : workerRange("reviewer", own.config.roles.reviewer).max);
	}

	/** Ends `own` for `reason` unless an earlier reason stands; a run that is no longer this session's is left alone. */
	async #stop(own: OwnRun, reason: RunEndReason, ctx: ExtensionContext): Promise<void> {
		if (this.#own !== own) return;
		own.ending ??= reason;
		await this.finish(own.ending, ctx);
	}

	/** An automatic start becomes ordinary work only at its own tool's accepted reply. */
	completeOpening(runId: string): boolean {
		const own = this.#own;
		if (own?.record.runId !== runId || own.ending !== undefined || own.provisional !== true) return false;
		delete own.provisional;
		return true;
	}

	async rollbackOpening(runId: string, ctx: ExtensionContext): Promise<void> {
		if (this.#own?.record.runId !== runId || this.#own.provisional !== true) return;
		await this.finish("start-failed", ctx);
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
		// R9's same-turn fact: the run is stopped from now on, even while owned work drains and the final record waits.
		if (own.provisional !== true) noteRunEnd(own.sessionDir, own.root, this.deps.now());
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
			// What each row held before the drain recheck re-reads anything: a result that recheck reopens (an edited
			// answer source, a reverted change) is still marked revoked in the final record.
			const held = this.#heldStates(own);
			if (finalReason === "verified" && own.drained === true) finalReason = await this.#recheckVerified(own);
			return this.#finalize(own, finalReason, own.finishCtx, held);
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
		if (!own.drainWarned && polls * this.#timings.drainPollMs > DRAIN_MAX_MS) {
			own.drainWarned = true;
			const ctx = own.finishCtx;
			if (ctx) {
				// The director's own edit has no other end than the message that follows it: say that call is what is waited for.
				this.deps.ui(ctx).notify(
					own.lanes.liveHolders(["director-path"]) > 0
						? DIRECTOR_DRAIN_WARNING
						: "Storm 실행이 소유한 작업이 제한 시간 안에 끝나지 않습니다. 실행 범위·잠금·회계를 유지한 채 작업이 끝날 때까지 기다립니다.",
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
		}, this.#timings.drainPollMs);
	}

	/** Finalizes a drained run once its owned work has settled; shares the one-finalization guard. */
	async #finishDeferred(own: OwnRun): Promise<RunRecord | undefined> {
		const running = this.#finishing;
		if (running !== undefined) return running;
		if (this.#own !== own) return undefined;
		const task = (async () => {
			let finalReason = own.ending ?? "no-progress";
			const held = this.#heldStates(own);
			if (finalReason === "verified" && own.drained === true) finalReason = await this.#recheckVerified(own);
			return this.#finalize(own, finalReason, own.finishCtx, held);
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
		await this.#revokeUnlocatedAccepted(own, true);
		const now = await this.#treeAt(own.root, own.base);
		const agents = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		const planLanes = this.#planLanes(own, agents);
		await this.#refreshCheckedResults(own);
		this.#refreshResultReviews(own, agents, now?.state);
		await this.#refreshAnswerReviews(own, agents);
		const coverage = this.#coverage(own, now?.state, planLanes);
		const gate = reviewGate(
			agents,
			own.config,
			{
				...(own.tree !== undefined ? { start: own.tree } : {}),
				...(now !== undefined ? { now: now.state } : {}),
			},
			coverage,
			{ directorEdit: own.directorEdit === true },
		);
		if (gate.state === "passed") return own.planless === true && (own.record.results?.length ?? 0) === 0 ? NO_DECLARED_END_REASON : "verified";
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
		if (own.jobBatch === true) return true;
		if (own.checking !== undefined) return true;
		// A director path edit is released only by the end of its turn, never by the run ending: the run keeps its lease, scope and
		// table until then, so the edit still meets every writer that starts in between.
		if (own.lanes.liveHolders(["director-path"]) > 0) return true;
		// A settlement already inside `settleAttempt` has left `attempts` for `settling`; the record it will write is
		// current evidence, so finalization must wait for it instead of judging the previous accepted row.
		if (own.settling.size > 0) return true;
		if ((this.deps.agents?.(own.record.runId, own.sessionDir) ?? []).some(agent => agent.state === "running")) return true;
		return this.#boundAsyncRunning(own);
	}

	/**
	 * Rechecks every receipt-backed result before a replan or a later evidence read. A vanished receipt, drifted target
	 * bytes or changed consumed inputs reopen that row and, transitively, its consumers; an unrelated proof stays.
	 */
	async #revokeStaleIntegratedReceipts(own: OwnRun): Promise<boolean> {
		const receipts = own.integration?.receipts;
		if (receipts === undefined || receipts.size === 0) return false;
		const window = this.#readWindow();
		let changed = false;
		for (const [id, recorded] of [...receipts]) {
			const row = own.record.results?.find(candidate => candidate.id === id);
			if (row === undefined || (row.state !== "accepted" && row.state !== "reviewable")) {
				receipts.delete(id);
				continue;
			}
			const result = this.#plannedResult(own, id) ?? row.contract;
			if (result === undefined) {
				receipts.delete(id);
				continue;
			}
			const verified = await this.#verifyReceiptState(own, result, row, recorded, window);
			if (verified.ok) continue;
			if (row.attemptId !== recorded.attemptId) {
				receipts.delete(id);
				continue;
			}
			row.state = "unmet";
			row.origin = "attempt";
			row.reason = compactResultReason(`통합 영수증을 현재 확인하지 못했습니다(${verified.problem.code}).`);
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.proof;
			delete row.restoredFrom;
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			receipts.delete(id);
			changed = true;
		}
		if (!changed) return false;
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
		return true;
	}

	/**
	 * Re-reads every accepted row at its current source before the final record is written. A reverted shared change or
	 * a vanished retained artifact reopens that row and, transitively, the rows that consumed its version; an
	 * independent accepted row stays. The contract comes from the plan in force, else from the bounded copy the row
	 * persisted, so a lane removed after acceptance cannot hide its proof. An answer (accepted, review-accepted or a
	 * reviewable submission with a recorded anchor) is re-read at its cited bytes on every pass, live or restored. A
	 * review-accepted change's digest is its bound tree: a current tree that no longer matches reopens the submission for
	 * judgement instead of carrying the old verdict into the record.
	 */
	async #revokeUnlocatedAccepted(own: OwnRun, restoredOnly = false): Promise<void> {
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
			if (row.state !== "accepted" && row.state !== "reviewable") continue;
			const planned = this.#plannedResult(own, row.id) ?? row.contract;
			// An answer's receipt is always re-read (live, restored or review-accepted): its only location is the cited
			// bytes, and a source edited or deleted after acceptance must reopen it and what consumed its version.
			const answer = planned?.kind === "answer";
			if (restoredOnly && row.restoredFrom === undefined && !answer) continue;
			if (row.state !== "accepted" && !(row.state === "reviewable" && (row.restoredFrom !== undefined || answer))) continue;
			// A legacy row that never recorded its contract is not reconstructed from plan text; there is no safe
			// historical source to re-locate it against and no new evidence is invented here.
			if (planned === undefined) continue;
			// A review-accepted answer is bound to its submission and cited bytes, never to a tree: it goes straight to
			// the receipt re-read below.
			if (row.origin === "review" && !answer) {
				const reviewed = rowWitness(row);
				const tree = await currentTree();
				// A settlement or review during the read may have replaced what this row stood on; that newer judgment
				// is not demoted by a decision taken from the old row.
				if (rowWitness(row) !== reviewed) continue;
				// Without a current reading the gate cannot have an honest verified label; leave the row to it rather
				// than guessing that an unread tree matches.
				const moved = tree !== undefined && row.reviewTree !== tree;
				if (moved) {
					row.state = "reviewable";
					row.origin = "attempt";
					row.reason = compactResultReason("리뷰 이후 트리가 바뀌어 새 판단이 필요합니다.");
					delete row.reviewTree;
					delete row.remedy;
					delete row.retryRoute;
					delete row.unblock;
					changed = true;
				}
				if (!moved || row.restoredFrom === undefined) continue;
			}
			let location: AcceptedLocation;
			const located = rowWitness(row);
			if (answer && row.state === "reviewable") {
				// A submission with no recorded anchor was never judgeable; it stays as it is. One whose anchor moved is
				// no longer the submission a reviewer would judge.
				if (this.#answerReceipt(own, row) === undefined) continue;
				const problem = await this.#answerReceiptProblem(own, row);
				location = problem === undefined ? { ok: true, integrated: false } : { ok: false, reason: problem };
			} else {
				const lane = own.record.plan?.lanes.find(candidate => candidate.results?.some(result => result.id === row.id));
				const isolated = lane === undefined ? undefined : lane.isolationReason !== undefined || own.config.isolation === "isolated";
				location = await this.#acceptedLocation(own, planned, isolated, row);
			}
			if (location.ok) continue;
			// The location read awaited: a newer attempt may have settled this row meanwhile. Its judgment stands; only
			// the row this read actually checked can be revoked.
			if (rowWitness(row) !== located) continue;
			const held = row.state === "accepted" ? "수용된 결과가 현재 위치에서 확인되지 않았습니다" : "제출된 결과의 근거가 현재와 다릅니다";
			row.state = "unmet";
			row.origin = "attempt";
			row.reason = compactResultReason(`${held}: ${location.reason}`);
			own.answerSubjects?.delete(row.id);
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			delete row.proof;
			delete row.restoredFrom;
			changed = true;
		}
		if (!changed) return;
		this.#invalidateConsumers(own);
		this.#scheduleFlush(own);
	}

	/**
	 * A sealed candidate the director never selected cannot land after the run closes: its exact rows become unmet with
	 * a finalization marker, so a late capture or delivery cannot make them reviewable. Durable records stay readable.
	 */
	#closeUnintegrated(own: OwnRun): boolean {
		const awaiting = own.integration?.awaiting;
		const rows = own.record.results ?? [];
		let changed = false;
		if (awaiting !== undefined && awaiting.size > 0) {
			for (const [id] of [...awaiting]) {
				const row = rows.find(candidate => candidate.id === id);
				awaiting.delete(id);
				if (row === undefined || row.state !== "pending") continue;
				row.state = "unmet";
				row.reason = compactResultReason("실행이 끝날 때까지 통합 후보를 선택하지 않아 결과를 수용하지 않았습니다.");
				row.origin = "attempt";
				row.finalized = "unsettled";
				delete row.contentVersion;
				delete row.reviewTree;
				delete row.proof;
				delete row.restoredFrom;
				changed = true;
			}
		}
		for (const row of rows) {
			if (row.state !== "pending" || row.attemptId === undefined) continue;
			row.state = "unmet";
			row.reason = compactResultReason("실행이 끝날 때까지 네이티브 캡처를 받지 못해 결과를 수용하지 않았습니다.");
			row.origin = "attempt";
			row.finalized = "unsettled";
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.proof;
			delete row.restoredFrom;
			changed = true;
		}
		if (changed) this.#invalidateConsumers(own);
		return changed;
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
				// Finalization, not a judgment, closed this attempt: the closeout tells it apart from a judged miss.
				row.finalized = "unsettled";
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

	/** Each result row's state now, the baseline finalization compares against to mark a reopened result revoked. */
	#heldStates(own: OwnRun): Map<RunResult, RunResult["state"]> {
		return new Map((own.record.results ?? []).map(row => [row, row.state] as const));
	}

	/**
	 * Writes the final record and releases the lease; only runs after owned work has settled. `heldBefore` is the row
	 * baseline taken before a drain recheck, so a result that recheck already reopened is still marked revoked.
	 */
	async #finalize(
		own: OwnRun,
		reason: RunEndReason,
		ctx: ExtensionContext | undefined,
		heldBefore?: ReadonlyMap<RunResult, RunResult["state"]>,
	): Promise<RunRecord | undefined> {
		if (this.#own !== own) return undefined;
		// A settlement that entered `settleAttempt` after the caller's live-work check is still current evidence. Keep the
		// run stopping and let the drain timer retry; the final record never lands on top of a record still being written.
		if (own.settling.size > 0 || own.lanes.liveHolders(["director-path"]) > 0) {
			this.#deferFinalize(own);
			return undefined;
		}
		let integrationProjection: CandidateProjection | undefined;
		if (own.integration !== undefined && this.deps.integration?.(own.sessionDir) !== undefined) {
			own.finalizing = true;
			integrationProjection = await this.project({ kind: "overview" }, this.#readWindow(), own.sessionDir).catch(() => undefined);
		}
		const integrationState = own.integration;
		this.#own = undefined;
		clearWorkerSlots(own.record.runId);
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
		this.#retirePaid(own);
		const ledger = endLedgerRun(own.record.runId);
		if (own.provisional === true && (spawnsByRun.get(own.record.runId)?.length ?? 0) === 0 && !own.directorEdit) {
			const { runId } = own.record;
			spawnsByRun.delete(runId);
			lastSpawnByKey.delete(runId);
			deliveryKindsByRun.delete(runId);
			expectedByRun.delete(runId);
			stormStopsByRun.delete(runId);
			noticeSinks.delete(runId);
			clearRunReads(runId);
			forgetRunLanes(runId);
			try {
				await this.#liveWrite;
				await discardStartPointer(own.sessionDir, { repoId: own.repoId, root: own.root }, own.record);
				await discardStartRecord(own.sessionDir, own.record);
				if (ctx !== undefined) this.#liveStatus(ctx, undefined);
			} finally {
				if (own.lease !== undefined) await this.#releaseLease(own.lease, ctx);
			}
			return undefined;
		}
		// What each row held before finalization touched it: a held result this step reopens is marked revoked. The
		// marker classifies the closeout only; it is never evidence and is never carried into a continuation.
		const held = new Map(this.#heldStates(own));
		// A row the drain recheck already reopened keeps the state it held before that recheck.
		for (const [row, state] of heldBefore ?? []) if (held.has(row)) held.set(row, state);
		// No verified close can race an attempt whose terminal metadata never arrived: the row is unmet, and the run
		// records the honest no-progress end instead of a stale verification label.
		this.#closePendingAttempts(own);
		this.#closeUnintegrated(own);
		this.#syncConfigRefusals(own);
		this.#syncResults(own);
		// Every final record carries current evidence, not the row's last accepted state: a later write may have
		// reverted a shared change or removed the retained patch, even when the producing lane is no longer planned.
		// Vanished evidence reopens the row and what consumed its version; a verified label additionally requires every
		// row to still be accepted after that re-read.
		await this.#revokeUnlocatedAccepted(own);
		for (const row of own.record.results ?? []) {
			const before = held.get(row);
			if (row.finalized !== undefined || row.scope === "excluded-by-user" || before === undefined) continue;
			// A judged miss (a scoped `incorrect` verdict applied during the recheck) is a verdict, not a revocation.
			if (row.state === "unmet" && row.origin === "review") continue;
			if ((before === "accepted" || before === "reviewable") && row.state !== before && row.state !== "accepted") {
				row.finalized = "revoked";
			}
		}
		const finalRows = own.record.results ?? [];
		const inScopeRows = finalRows.filter(row => row.scope !== "excluded-by-user");
		// Excluded rows are not proof obligations, but they are never proof either: when every declared result was
		// excluded, a gate with no in-scope result evidence must not turn into `verified`.
		const onlyExcluded = finalRows.length > 0 && inScopeRows.length === 0;
		let finalReason: RunEndReason =
			reason === "verified" && (onlyExcluded || inScopeRows.some(row => row.state !== "accepted")) ? "no-progress" : reason;
		const spawns = spawnsByRun.get(own.record.runId) ?? [];
		forgetTrialSpawns(own.sessionDir, spawns.flatMap(spawn => (spawn.spawnKey === undefined ? [] : [spawn.spawnKey])));
		const seen = this.deps.agents?.(own.record.runId, own.sessionDir) ?? [];
		// A team with doc consistency off asked for no doc findings, so none are counted.
		const agents = docsEnabled(own.config) ? seen : seen.map(withoutDocFindings);
		// Read while the run's spawn map still binds its failed ids: a lane is pending only from authoritative state.
		// A settled worker is not a finished requirement: an open result row keeps its lane, including a consumer whose
		// producer changed after the last attempt (T05).
		const pendingNames = new Set(this.#planLanes(own, agents)?.filter(lane => lane.state === "pending").map(lane => lane.name) ?? []);
		for (const row of own.record.results ?? []) {
			if (row.scope === "excluded-by-user") continue;
			if (row.lane !== undefined && (row.state === "pending" || row.state === "unmet")) pendingNames.add(row.lane);
		}
		const pendingLanes = (own.record.plan?.lanes ?? []).filter(lane => pendingNames.has(lane.name)).map(lane => lane.name);
		spawnsByRun.delete(own.record.runId);
		lastSpawnByKey.delete(own.record.runId);
		deliveryKindsByRun.delete(own.record.runId);
		expectedByRun.delete(own.record.runId);
		stormStopsByRun.delete(own.record.runId);
		noticeSinks.delete(own.record.runId);
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
			// The run's own target and team snapshot: a later status or closeout must not read today's settings.
			closeoutFacts: {
				target: closeoutTargetName(own.root),
				pendingLanes,
				requiredChecks: own.config.requiredChecks?.map(check => check.name) ?? [],
			} satisfies CloseoutFacts,
		};
		if (own.checkEvidence?.length) record.checks = own.checkEvidence;
		const spend = spendNote(ledger);
		if (spend !== undefined) record.spend = spend;
		// An automatic probe stays out of the main transcript while it is routine; a blocked spawn is not routine, and
		// the live status line already carried the rest.
		const quietAuto =
			!isSubstantiveRun(record) &&
			own.auto === true &&
			(record.endReason === "no-changes" || record.endReason === "verified") &&
			!record.spawns.some(spawn => spawn.outcome === "blocked");
		let resumable = false;
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
			// A resume is offered only for the exact run the session's own trusted candidate search returns now, with
			// the same ordering the resume path validates against. Read while the record and pointers are settled.
			if (ctx !== undefined && !quietAuto && finalReason !== "shutdown" && resumableRun(record)) {
				const candidate = await findResumeCandidate(own.sessionDir, { repoId: own.repoId, root: own.root }).catch(() => undefined);
				resumable = candidate?.runId === record.runId;
			}
		} finally {
			if (own.lease !== undefined) await this.#releaseLease(own.lease, ctx);
		}
		// The transcript record is the last word of a settled run: the record is on disk and no lease is held. A shutdown
		// (or a switch, which ends as one) opens no new UI: the transcript it belonged to is already gone. A stable
		// identity that differs from the one that directed the run is the same case even when the reason was not shutdown.
		const showingSession = ctx === undefined ? undefined : closeoutSessionId(ctx);
		const sameSession = own.sessionId === showingSession;
		if (ctx !== undefined && finalReason !== "shutdown" && sameSession && !quietAuto) {
			const brief = closeoutBrief(record, {
				resumable,
				...(integrationProjection === undefined || integrationProjection.kind === "not-recorded"
					? {}
					: { integration: integrationProjection }),
			} as unknown as Parameters<typeof closeoutBrief>[1]);
			if (brief.tier !== "none") {
				// Numbers are offered only where this host can actually take a typed pick from this session's owner.
				const interactive = ctx.mode === "tui" && ctx.hasUI;
				const registered = interactive && brief.actions.length > 0 && rememberCloseoutReport(ctx, record.runId, brief.actions);
				// A newer record without numbers must not leave an older card's numbers answerable.
				if (!registered) resetCloseoutChoices(ctx);
				try {
					const view = renderCloseout(brief, registered);
					this.deps.ui(ctx).record(CLOSEOUT_TITLE, view.markdown, { kind: "closeout", runId: record.runId, info: view.info });
				} catch (error) {
					if (registered) resetCloseoutChoices(ctx);
					throw error;
				}
			}
		}
		// What the run's shared entries described has ended with its record: they must not outlive it in a long-lived host.
		// Agent rows are process state a later run may still write to, so only the session shutdown removes them.
		if (this.deps.integration?.(own.sessionDir) !== undefined && integrationState !== undefined) {
			this.#recentIntegration = {
				sessionDir: own.sessionDir,
				runId: record.runId,
				state: integrationState,
				...(record.results === undefined ? {} : { rows: record.results }),
			};
		}
		forgetRunLanes(own.record.runId);
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
		if (own.jobFence !== undefined) return { ok: false, reason: own.jobFence };
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
			const integration = run === undefined || this.#lastProjection?.runId !== run.runId
				? undefined
				: this.#lastProjection.projection;
			this.deps.live?.(ctx, run, integration);
		} catch {
			// A convenience of the screen: no run decision reads what it shows.
		}
	}

	#scheduleFlush(own: OwnRun): void {
		// Any record mutation can change what a candidate projection means; the view hook never reuses a stale one.
		this.#lastProjection = undefined;
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
			void this.#writeLiveSnapshot(own).catch(() => undefined);
		}, this.#timings.liveFlushMs);
		this.#flushTimer.unref?.();
	}

	/** The before-spawn receipt must land before any command can run, and writes never overtake it. */
	#writeLiveSnapshot(own: OwnRun): Promise<void> {
		const write = this.#liveWrite.catch(() => undefined).then(async () => {
			const live = this.active();
			if (live !== undefined && this.#own === own) await writeRun(own.sessionDir, { ...live, updatedAt: iso(this.deps.now()) });
		});
		this.#liveWrite = write.catch(() => undefined);
		return write;
	}

	/** Pull new exact native receipts into this run's ledger; a safe no-op for a stock host or another run. */
	ingestPaidSpend(): void {
		const own = this.#own;
		if (own === undefined || own.paid === undefined) return;
		this.#ingestPaid(own);
	}

	/**
	 * Binds the host's paid-attempt owner to this exact run before its first covered provider send. Stock 19.2.1 has no
	 * surface and keeps the legacy accounting; any present but unusable/unproven patched surface refuses the start rather
	 * than silently falling back to carriers the host is already charging.
	 */
	#bindPaidAttempts(
		ctx: ExtensionContext,
		runId: string,
		sessionId: string,
		config: StormConfig,
	): PaidAttemptBindOutcome {
		let result: PaidAttemptBindResult;
		const excludeAttemptIds = retiredPaidAttemptIds(sessionId);
		try {
			result = bindPaidAttemptAdapter({
				ctx,
				runId,
				ownerSessionId: sessionId,
				spentUsd: 0,
				...(this.deps.authorizeWorkerTurn === undefined ? {} : { authorizeWorkerTurn: this.deps.authorizeWorkerTurn }),
				...(excludeAttemptIds.length === 0 ? {} : { excludeAttemptIds }),
				// block-spawns lets the leader's own continuation and an exactly-granted worker continuation finish;
				// its spawn and message gates refuse new work. Only a stop owns the provider-layer next-send refusal.
				...(config.budget === undefined
					? {}
					: {
							limitUsd: config.budget.perRunUsd,
							continuationPolicy:
								config.budget.onExceed === "block-spawns" ? ("leader-and-exact-worker" as const) : ("refuse" as const),
						}),
			});
		} catch (error) {
			return { ok: false, reason: `${PAID_ATTEMPT_REFUSAL_TAG} host-invalid: ${errorText(error)}` };
		}
		if (result.status === "unavailable") {
			if (result.code === "host-absent") return { ok: true };
			return { ok: false, reason: `${PAID_ATTEMPT_REFUSAL_TAG} ${result.code}: ${result.detail}` };
		}
		if (result.metadata.nativeAccounting !== "effective") {
			let detail = "native paid-attempt proof is not effective";
			try {
				const observed = result.adapter.observe();
				detail = observed.fault === undefined ? detail : `${observed.fault.code}: ${observed.fault.detail}`;
			} catch {
				// The installed authority still refuses; the start refusal below stays the outcome.
			}
			result.adapter.dispose();
			return { ok: false, reason: `${PAID_ATTEMPT_REFUSAL_TAG} host-invalid: ${detail}` };
		}
		return { ok: true, binding: { adapter: result.adapter, metadata: result.metadata } };
	}

	/** Makes the bound authority and its zero baseline part of the run that owns it. */
	#adoptPaidAttempts(own: OwnRun, paid: PaidAttemptBinding): void {
		const { metadata } = paid;
		if (metadata.bindingToken === undefined || metadata.startSeq === undefined || metadata.nativeAccounting === "unavailable") {
			throw new Error("paid-attempt binding metadata is incomplete");
		}
		const attached = attachPaidAccounting(own.record.runId, {
			ownerSessionId: metadata.expectedOwnerSessionId,
			bindingToken: metadata.bindingToken,
			startSeq: metadata.startSeq,
			...(metadata.limit.mode === "finite" ? { limitUsd: metadata.limit.usd } : {}),
			startCostUsd: metadata.startCostUsd,
			receiptsUsd: 0,
			receipts: 0,
			lastSeq: metadata.startSeq,
			pending: 0,
			unresolved: 0,
			accounting: metadata.nativeAccounting,
		});
		if (attached === undefined) throw new Error("the run ledger could not take the paid-attempt binding");
		own.paid = paid;
	}

	/** Adds one adapter delta exactly once, models and total together, then persists the new live view. */
	#ingestPaid(own: OwnRun): void {
		const paid = own.paid;
		if (paid === undefined) return;
		let delta: PaidAttemptDelta;
		try {
			delta = paid.adapter.takeDelta();
		} catch {
			// The adapter's own gate stays installed and refuses; no unproven delta is guessed into the total.
			return;
		}
		const current = getLedgerRun(own.record.runId)?.paid;
		if (current === undefined) return;
		const next: LedgerPaidAccounting = {
			...current,
			receiptsUsd: current.receiptsUsd + delta.usd,
			receipts: current.receipts + delta.settledReceipts,
			lastSeq: delta.toSeq,
			pending: delta.pendingCount,
			unresolved: delta.inScopeUnresolvedCount,
		};
		updatePaidAccounting(own.record.runId, next);
		if (delta.usd > 0) recordPaidCost(own.record.runId, delta.byModel, delta.usd, PAID_ATTEMPT_UNKNOWN_MODEL);
		if (
			delta.usd > 0 ||
			delta.settledReceipts > 0 ||
			delta.pendingCount !== current.pending ||
			delta.inScopeUnresolvedCount !== current.unresolved
		) {
			this.#scheduleFlush(own);
		}
	}

	/** Final exact read, then retires the exact run's authority; durable late receipts never reach the next run. */
	#retirePaid(own: OwnRun): void {
		const paid = own.paid;
		if (paid === undefined) return;
		try {
			this.#ingestPaid(own);
			const observed = paid.adapter.observe();
			noteRetiredPaidAttemptIds(
				paid.metadata.expectedOwnerSessionId,
				observed.pending.map(item => item.attemptId),
			);
			const current = getLedgerRun(own.record.runId)?.paid;
			if (current !== undefined) {
				const cumulative = Math.max(0, observed.knownCostUsd - observed.startCostUsd);
				const next: LedgerPaidAccounting = {
					...current,
					receiptsUsd: Math.max(current.receiptsUsd, cumulative),
					receipts: Math.max(current.receipts, observed.settledReceipts),
					lastSeq: Math.max(current.lastSeq, observed.lastSeq),
					pending: observed.pendingCount,
					unresolved: observed.unresolved.filter(fact => fact.inScope).length,
					accounting: observed.accounting,
				};
				updatePaidAccounting(own.record.runId, next);
				const missing = next.receiptsUsd - current.receiptsUsd;
				if (observed.accounting === "effective" && missing > 1e-9) {
					recordPaidCost(own.record.runId, {}, missing, PAID_ATTEMPT_UNKNOWN_MODEL);
				}
			}
		} catch {
			// A failed final read leaves the amount already ingested and any pending receipt explicit in the note.
		} finally {
			paid.adapter.dispose();
			delete own.paid;
		}
	}

	#threshold(ctx: ExtensionContext, kind: "warn" | "limit", run: LedgerRun): void {
		const ui = this.deps.ui(ctx);
		const budget = run.budget;
		if (kind === "warn") {
			ui.notify(`Storm 실행 비용이 경고선 ${formatUsd(budget?.warnAtUsd ?? 0)}에 닿았습니다(누계 ${formatUsd(run.costUsd)}).`, "warning");
			return;
		}
		const stop = budget?.onExceed === "stop";
		// R15: the workers already running read the close from the marker on disk, so the director's instance writes it
		// here, once, at the limit and before anything else this limit does. A failing close is reported and does not
		// keep the stop itself from happening.
		try {
			const closing = this.deps.closeSpend?.(run.runId, stop ? "stop" : "block-spawns");
			if (closing !== undefined) {
				void Promise.resolve(closing).catch((error: unknown) =>
					ui.notify(`사용량 마감을 워커에게 알리지 못했습니다: ${errorText(error)}`, "error"));
			}
		} catch (error) {
			ui.notify(`사용량 마감을 워커에게 알리지 못했습니다: ${errorText(error)}`, "error");
		}
		ui.notify(
			// F3: say what happens now. After the limit no message of any kind reaches a worker (B3 refuses even a progress
			// note); a turn already running finishes under `block-spawns`, while under `stop` its next request is not sent.
			`Storm 실행 예산(${formatUsd(budget?.perRunUsd ?? 0)})에 관측된 지출이 닿았습니다(누계 ${formatUsd(run.costUsd)}). 이제 워커에게 어떤 agent:// 메시지도 보내지 않습니다(진행 메모 포함). 새 스폰도 막습니다.${stop ? " 감독의 응답을 중단하고, 이미 도는 워커의 다음 요청도 보내지 않습니다." : " 이미 도는 워커의 지금 턴은 끝까지 진행하며, 그 지출은 이후에 더해집니다."}`,
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

	// ── Isolated integration: C's admission freeze, queue, selection and receipt evaluation ─────────────────────

	#integrationStateFor(own: OwnRun): IntegrationRunState {
		return (own.integration ??= emptyIntegrationState());
	}

	#windowFor(signal: AbortSignal, deadline = this.deps.now() + INTEGRATION_WINDOW_MS): ByteWindow {
		return { maxBytes: INTEGRATION_WINDOW_BYTES, deadline: Math.min(deadline, this.deps.now() + INTEGRATION_WINDOW_MS), signal };
	}

	/** Read-only checks use their own never-aborted signal; a stopping run still records what its bytes prove. */
	#readWindow(): ByteWindow {
		return this.#windowFor(new AbortController().signal);
	}

	#producerLaneForResult(own: OwnRun, id: string): string | undefined {
		return own.record.plan?.lanes.find(lane => (lane.results ?? []).some(result => result.id === id))?.name;
	}

	/**
	 * The exact producer versions the attempt started from, with a current same-run receipt only when it still proves
	 * the same version and location. A missing version stays missing: selecting its producer later cannot repair it.
	 */
	async #freezeConsumed(own: OwnRun, prepared: PreparedAttempt): Promise<IntegrationRead<ConsumedInput[]>> {
		const started = new Map((prepared.consumed ?? []).map(input => [input.id, input.version]));
		const consumed: ConsumedInput[] = [];
		for (const input of prepared.declaredInputs) {
			const producerLane = this.#producerLaneForResult(own, input.id);
			if (producerLane === undefined) {
				return integrationUnknown("producer-lane-unknown", `선행 결과 '${input.id}'의 레인을 현재 계획에서 확인하지 못했습니다.`);
			}
			const version = started.get(input.id) ?? MISSING_INPUT;
			const subject = { kind: "result" as const, id: input.id };
			if (version === MISSING_INPUT) {
				consumed.push({ producerLane, need: input.need, subject, state: "missing" });
				continue;
			}
			if (input.need === "integrated") {
				const current = await this.#currentIntegratedResult(own, input.id, this.#readWindow());
				if (current !== undefined && current.version === version) {
					consumed.push({
						producerLane, need: input.need, subject, state: "integrated",
						version, receipt: current.receipt, paths: current.paths,
					});
					continue;
				}
			}
			consumed.push({ producerLane, need: input.need, subject, state: "version", version });
		}
		return integrationKnown(consumed);
	}

	/** One accepted result's current receipt-backed integration, or nothing; a tree guess is never a receipt. */
	async #currentIntegratedResult(
		own: OwnRun,
		id: string,
		window: ByteWindow,
	): Promise<{ readonly version: string; readonly receipt: ReceiptRef; readonly paths: readonly LocatedInputPath[] } | undefined> {
		const row = own.record.results?.find(candidate => candidate.id === id);
		if (row === undefined || row.state !== "accepted" || row.contentVersion === undefined) return undefined;
		const result = this.#plannedResult(own, id) ?? row.contract;
		if (result === undefined) return undefined;
		const state = own.integration?.receipts.get(id);
		if (state === undefined || state.attemptId !== row.attemptId) return undefined;
		const verified = await this.#verifyReceiptState(own, result, row, state, window);
		if (!verified.ok) return undefined;
		return { version: row.contentVersion, receipt: state.receipt, paths: state.attributable };
	}

	/**
	 * E calls this before A persists its prepared admission. The frozen subject names the exact planned attempt epoch,
	 * result contract and consumed versions, or the explicit unplanned identity; the original evaluator baseline stays
	 * in the prepared attempt, never in a second copy. A planned lane with declared results must already have passed
	 * `prepareAttempt`, so the frozen epoch is the one its settlement will carry.
	 */
	async prepareAdmission(input: {
		readonly admission: Omit<FrozenIntegrationAdmission, "subject">;
		readonly placement: { readonly kind: "planned"; readonly lane: string } | { readonly kind: "unplanned" };
	}): Promise<IntegrationRead<FrozenIntegrationAdmission>> {
		const own = this.#own;
		if (own === undefined) return integrationUnknown("run-not-active", "진행 중인 실행이 없어 통합 수락을 준비하지 못했습니다.");
		const ports = this.deps.integration?.(own.sessionDir);
		if (ports === undefined) return integrationUnknown("integration-disabled", "이 호스트 경계에서는 격리 통합이 아직 켜지지 않았습니다.");
		const { admission } = input;
		const key = admission.key;
		if (key === null || typeof key !== "object" || key.schema !== INTEGRATION_KEY_SCHEMA ||
			key.runId !== own.record.runId || typeof key.dispatch !== "string" || key.dispatch.length === 0 || key.dispatch.length > 512) {
			return integrationUnknown("admission-key-invalid", "통합 수락 키가 이 실행의 형식과 다릅니다.");
		}
		if (!isCandidateId(admission.candidateId) || admission.candidateId !== candidateIdFor(key)) {
			return integrationUnknown("candidate-id-invalid", "통합 후보 id가 정확한 키에서 계산된 값과 다릅니다.");
		}
		if (admission.director.sessionId !== own.sessionId || admission.director.sessionDir !== own.sessionDir ||
			admission.director.sessionInstance.trim() === "" ||
			typeof admission.director.parentId !== "string" || admission.director.parentId.length > 512) {
			return integrationUnknown("director-mismatch", "통합 수락의 소유 세션·인스턴스가 이 실행과 다릅니다.");
		}
		const target = admission.target;
		const canonicalRoot = own.lease?.root ?? own.root;
		if (path.resolve(target.authorizedRoot.canonicalPath) !== path.resolve(canonicalRoot) ||
			own.lease === undefined || target.leaseKey !== own.lease.record.key) {
			return integrationUnknown("target-mismatch", "통합 대상이 이 실행의 실제 쓰기 잠금 대상과 다릅니다.");
		}
		if (target.gitRoot.canonicalPath === "" || target.gitDir.canonicalPath === "" ||
			target.sourceOdb.commonDir.canonicalPath === "" || target.sourceOdb.objects.canonicalPath === "" ||
			(target.sourceOdb.objectFormat !== "sha1" && target.sourceOdb.objectFormat !== "sha256")) {
			return integrationUnknown("target-identity-invalid", "통합 대상의 Git 객체 저장소 신원이 올바르지 않습니다.");
		}
		if (admission.artifactRoot.canonicalPath === "" || admission.item.handle === "" ||
			admission.item.toolCallId === "" || !Number.isSafeInteger(admission.item.itemIndex) || admission.item.itemIndex < 0 ||
			!Number.isSafeInteger(admission.placementOrdinal) || admission.placementOrdinal < 0 ||
			!Number.isFinite(admission.startedAt)) {
			return integrationUnknown("placement-invalid", "통합 수락의 배치·항목·시각이 올바르지 않습니다.");
		}
		if (admission.workerAdmission.key === "" || admission.workerAdmission.attempt === "") {
			return integrationUnknown("worker-admission-invalid", "통합 수락의 워커 수락 기록이 없습니다.");
		}
		if (admission.policy.enabled !== true || admission.policy.apply !== false || admission.policy.merge !== "patch" ||
			admission.policy.id === "" || admission.policy.toolCallId !== admission.item.toolCallId) {
			return integrationUnknown("policy-proof-invalid", "통합 수락의 적용 끔 증명이 이 호출과 맞지 않습니다.");
		}
		if (!sameKey(admission.slot.key, key) || admission.slot.ownerToken === "" || admission.slot.slotPath === "") {
			return integrationUnknown("slot-invalid", "통합 수락의 네이티브 슬롯 소유가 이 키와 다릅니다.");
		}
		if (own.ending !== undefined || own.abort.signal.aborted || own.finalizing === true) {
			return integrationUnknown("run-stopping", "실행이 끝나는 중이라 통합 수락을 준비하지 않았습니다.");
		}

		const state = this.#integrationStateFor(own);
		const existing = state.admissions.get(key.dispatch);
		if (existing !== undefined) {
			if (existing.admission.candidateId === admission.candidateId && existing.status !== "discarded") return integrationKnown(existing.admission);
			return integrationUnknown("admission-duplicate", "같은 디스패치에 다른 통합 수락이 이미 있습니다.");
		}
		const prior = state.candidates.get(admission.candidateId);
		if (prior !== undefined) return integrationUnknown("candidate-duplicate", "같은 통합 후보 id가 이미 다른 수락에 쓰였습니다.");

		let subject: AdmissionSubject;
		let integrationEpoch: number | undefined;
		if (input.placement.kind === "planned") {
			const placementLane = input.placement.lane;
			const lane = own.record.plan?.lanes.find(candidate => candidate.name === placementLane);
			if (lane === undefined) return integrationUnknown("lane-not-planned", "이 레인은 현재 계획에 없어 통합 수락을 준비하지 못했습니다.");
			const declared = lane.results ?? [];
			if (declared.length === 0) {
				const epoch = ++own.attemptSerial;
				state.laneEpoch.set(lane.name, epoch);
				subject = { kind: "planned", lane: lane.name, epoch, contractDigest: contractDigestOf([]), results: [], consumed: [] };
			} else {
				const prepared = own.attempts.get(key.dispatch);
				if (prepared === undefined) {
					return integrationUnknown("attempt-not-prepared", "시도 기준선이 준비되기 전에는 통합 수락을 고정하지 않았습니다.");
				}
				if (prepared.lane !== lane.name || prepared.epoch !== (own.laneAttempt.get(lane.name) ?? 0)) {
					return integrationUnknown("attempt-superseded", "이 시도는 이미 최신 시도가 아니어서 통합 수락을 고정하지 않았습니다.");
				}
				const consumed = await this.#freezeConsumed(own, prepared);
				if (consumed.kind !== "known") return consumed;
				subject = {
					kind: "planned", lane: lane.name, epoch: prepared.epoch,
					contractDigest: contractDigestOf(prepared.results),
					results: prepared.results.map(result => persistedResultContract(result)),
					consumed: consumed.value,
				};
			}
		} else {
			const epoch = ++own.attemptSerial;
			state.itemEpoch.set(itemIdentity(admission.item), epoch);
			subject = { kind: "unplanned" };
			integrationEpoch = epoch;
		}

		const frozen: FrozenIntegrationAdmission = { ...admission, subject };
		const admitted: IntegrationAdmissionState = {
			admission: frozen,
			status: "prepared",
			recovery: [],
			observedAt: this.deps.now(),
			...(integrationEpoch === undefined ? {} : { epoch: integrationEpoch }),
		};
		state.admissions.set(key.dispatch, admitted);
		state.candidates.set(frozen.candidateId, admitted);
		return integrationKnown(frozen);
	}

	/** Whether this admission's frozen attempt is still the one that will run/settle; synchronous by contract. */
	#admissionCurrent(own: OwnRun, state: IntegrationAdmissionState): boolean {
		const subject = state.admission.subject;
		if (subject.kind === "unplanned") {
			return state.epoch !== undefined && this.#integrationStateFor(own).itemEpoch.get(itemIdentity(state.admission.item)) === state.epoch;
		}
		const lane = own.record.plan?.lanes.find(candidate => candidate.name === subject.lane);
		if (lane === undefined) return false;
		if (subject.results.length === 0) return this.#integrationStateFor(own).laneEpoch.get(subject.lane) === subject.epoch;
		const prepared = own.attempts.get(state.admission.key.dispatch);
		return prepared !== undefined && prepared.epoch === subject.epoch &&
			(own.laneAttempt.get(subject.lane) ?? 0) === subject.epoch;
	}

	/** E's final synchronous step: only a committed admission may appear in the candidate queue. */
	commitAdmission(key: AdmissionKey): IntegrationCheck {
		const own = this.#own;
		if (own === undefined || key.runId !== own.record.runId) return integrationFail("run-not-active", "이 실행의 통합 수락이 아닙니다.");
		if (this.deps.integration?.(own.sessionDir) === undefined) return integrationFail("integration-disabled", "이 호스트에서는 격리 통합이 켜지지 않았습니다.");
		const state = own.integration?.admissions.get(key.dispatch);
		if (state === undefined || state.admission.candidateId !== candidateIdFor(key)) {
			return integrationFail("admission-not-prepared", "준비되지 않은 통합 수락은 게시할 수 없습니다.");
		}
		if (state.status === "discarded") return integrationFail("admission-discarded", "폐기된 통합 수락은 게시할 수 없습니다.");
		if (state.status === "committed") return integrationOk();
		if (own.ending !== undefined || own.abort.signal.aborted || own.finalizing === true) {
			return integrationFail("run-stopping", "실행이 끝나는 중이라 통합 수락을 게시하지 않았습니다.");
		}
		if (!this.#admissionCurrent(own, state)) return integrationFail("admission-superseded", "이 시도가 더 이상 현재 시도가 아니어서 통합 수락을 게시하지 않았습니다.");
		state.status = "committed";
		state.observedAt = this.deps.now();
		return integrationOk();
	}

	/** Revokes only the exact prepared admission; a durable seal already observed is never deleted by this. */
	discardAdmission(key: AdmissionKey): void {
		const own = this.#own;
		if (own === undefined || key.runId !== own.record.runId) return;
		const state = this.#integrationStateFor(own);
		const admitted = state.admissions.get(key.dispatch);
		if (admitted === undefined) return;
		if (admitted.seal !== undefined) {
			admitted.status = "discarded";
			return;
		}
		state.admissions.delete(key.dispatch);
		if (state.candidates.get(admitted.admission.candidateId) === admitted) state.candidates.delete(admitted.admission.candidateId);
		const subject = admitted.admission.subject;
		if (subject.kind === "planned") {
			if (state.laneEpoch.get(subject.lane) === subject.epoch) state.laneEpoch.delete(subject.lane);
		} else if (admitted.epoch !== undefined) {
			if (state.itemEpoch.get(itemIdentity(admitted.admission.item)) === admitted.epoch) {
				state.itemEpoch.delete(itemIdentity(admitted.admission.item));
			}
		}
	}

	/** Durable stored state from B's journal, merged into one admission without overwriting a first seal. */
	#mergeStored(state: IntegrationRunState, stored: StoredCandidate): IntegrationProblem | undefined {
		const manifest = stored.manifest;
		const key = manifest.admission.key;
		if (manifest.schema !== "storm.integration-capture/v1" || key.schema !== INTEGRATION_KEY_SCHEMA ||
			!INTEGRATION_DIGEST_RE.test(manifest.digest) || !isCandidateId(manifest.admission.candidateId) ||
			manifest.admission.candidateId !== candidateIdFor(key)) {
			return integrationProblem("manifest-invalid", "저장된 통합 캡처의 스키마·키·후보 id가 올바르지 않습니다.");
		}
		const existing = state.candidates.get(manifest.admission.candidateId);
		if (existing !== undefined) {
			if (existing.seal !== undefined && existing.seal.digest !== manifest.digest) {
				existing.problem ??= integrationProblem("manifest-contradiction", "같은 수락에 다른 캡처 매니페스트가 저장되어 있습니다.");
				return existing.problem;
			}
			existing.seal ??= manifest;
			if (existing.status !== "discarded") existing.status = "committed";
			if (stored.lastWrite !== null) {
				existing.lastWrite = stored.lastWrite;
				existing.lastWriteAt = this.deps.now();
			}
			for (const recovery of stored.recovery) {
				if (!existing.recovery.some(seen => seen.observationKey === recovery.observationKey)) existing.recovery.push(recovery);
			}
			if (existing.recovery.length > INTEGRATION_RECOVERY_MAX) existing.recovery.splice(0, existing.recovery.length - INTEGRATION_RECOVERY_MAX);
			return undefined;
		}
		const other = state.admissions.get(key.dispatch);
		if (other !== undefined && other.admission.candidateId !== manifest.admission.candidateId) {
			other.problem ??= integrationProblem("dispatch-contradiction", "같은 디스패치에 다른 통합 후보가 저장되어 있습니다.");
			return other.problem;
		}
		const admitted: IntegrationAdmissionState = {
			admission: manifest.admission,
			status: "committed",
			seal: manifest,
			recovery: [...stored.recovery].slice(-INTEGRATION_RECOVERY_MAX),
			observedAt: this.deps.now(),
			...(stored.lastWrite === null ? {} : { lastWrite: stored.lastWrite, lastWriteAt: this.deps.now() }),
		};
		state.admissions.set(key.dispatch, admitted);
		state.candidates.set(manifest.admission.candidateId, admitted);
		return undefined;
	}

	/** The bounded readiness this admission's own facts prove, before a target-fence lookup. */
	#sealBaseReadiness(own: OwnRun | undefined, state: IntegrationAdmissionState): QueueReadiness {
		if (state.status !== "committed") {
			return { kind: "unknown", problem: integrationProblem("admission-not-committed", "게시되지 않은 통합 수락은 후보가 아닙니다.") };
		}
		const seal = state.seal;
		if (seal === undefined) {
			return state.problem === undefined
				? { kind: "awaiting-native" }
				: { kind: "unknown", problem: state.problem };
		}
		const bundle = seal.bundle;
		if (bundle.kind === "kept-only") return { kind: "kept-only", problem: bundle.problem };
		if (bundle.kind === "unknown") return { kind: "unknown", problem: bundle.problem };
		if (bundle.kind === "confirmed-empty") return { kind: "confirmed-empty" };
		if (!sameKey(bundle.root.key, seal.admission.key) ||
			!INTEGRATION_DIGEST_RE.test(bundle.root.sha256) || !Number.isSafeInteger(bundle.root.bytes) || bundle.root.bytes < 0) {
			return { kind: "unknown", problem: integrationProblem("root-part-invalid", "루트 패치 참조가 이 수락과 맞지 않습니다.") };
		}
		if (seal.terminal.kind !== "known") return { kind: "unknown", problem: seal.terminal.problem };
		const terminal = seal.terminal.value;
		if (terminal.outcome.kind !== "known") return { kind: "unknown", problem: terminal.outcome.problem };
		if (terminal.outcome.value !== "success" || terminal.cancelRequested) {
			return {
				kind: "kept-only",
				problem: integrationProblem(
					terminal.outcome.value === "cancel" ? "attempt-cancelled" : "attempt-failed",
					terminal.outcome.value === "cancel"
						? "취소로 끝난 시도의 캡처는 복구용이며 통합 후보가 아닙니다."
						: "실패로 끝난 시도의 캡처는 복구용이며 통합 후보가 아닙니다.",
				),
			};
		}
		if (terminal.stopCause.kind === "known") {
			return {
				kind: "kept-only",
				problem: integrationProblem("attempt-stopped", `시도가 ${terminal.stopCause.value} 사유로 끝나 캡처는 복구용입니다.`),
			};
		}
		if (seal.childClaim.kind !== "known") {
			// Every carrier needs the bound child-entry claim: the terminal identifies the item, not the claimed
			// checkout with its verified input images. An unknown claim is recovery/awaiting proof, never selectable,
			// and a later observation cannot retroactively promote an immutable seal.
			return { kind: "unknown", problem: seal.childClaim.problem };
		}
		const claim = seal.childClaim.value;
		if (claim.key.dispatch !== seal.admission.key.dispatch || claim.candidateId !== seal.admission.candidateId ||
			claim.childHandle !== seal.admission.item.handle) {
			return { kind: "unknown", problem: integrationProblem("child-claim-mismatch", "자식 진입 증명이 이 수락과 맞지 않습니다.") };
		}
		if (seal.delta.kind !== "known") return { kind: "unknown", problem: seal.delta.problem };
		const delta = seal.delta.value;
		if (delta.schema !== "storm.integration-delta/v1" || !sameKey(delta.key, seal.admission.key) ||
			delta.candidateId !== seal.admission.candidateId || !INTEGRATION_DIGEST_RE.test(delta.digest) ||
			delta.root.objectKey !== bundle.root.objectKey || delta.root.sha256 !== bundle.root.sha256) {
			return { kind: "unknown", problem: integrationProblem("delta-invalid", "정확 델타 증명이 캡처와 맞지 않습니다.") };
		}
		const conflict = this.#sealConflict(state);
		if (conflict !== undefined) return { kind: "conflict", problem: conflict };
		if (own !== undefined && this.#sealStale(own, state)) {
			return { kind: "stale", problem: integrationProblem("candidate-stale", "이 후보는 최신 시도나 현재 계약이 아니어서 선택할 수 없습니다.") };
		}
		return { kind: "ready" };
	}

	/** A proven target fence or a bound contradiction revokes unused readiness; it never rewrites the manifest. */
	#sealConflict(state: IntegrationAdmissionState): IntegrationProblem | undefined {
		if (state.problem !== undefined) return state.problem;
		const write = state.lastWrite;
		if (write?.kind === "recovery-required" || write?.kind === "present-unattributed") return write.problem;
		return undefined;
	}

	/** Whether a newer attempt, plan contract or consumed version replaced this admission's frozen subject. */
	#sealStale(own: OwnRun, state: IntegrationAdmissionState): boolean {
		const subject = state.admission.subject;
		if (subject.kind === "unplanned") {
			if (state.epoch === undefined) return false;
			const latest = own.integration?.itemEpoch.get(itemIdentity(state.admission.item));
			return latest !== undefined && latest !== state.epoch;
		}
		const lane = own.record.plan?.lanes.find(candidate => candidate.name === subject.lane);
		if (lane === undefined) return true;
		if (subject.results.length === 0) return own.integration?.laneEpoch.get(subject.lane) !== subject.epoch;
		const newest = Math.max(own.laneAttempt.get(subject.lane) ?? 0, own.settledEpoch.get(subject.lane) ?? 0);
		if (newest > subject.epoch) return true;
		for (const frozen of subject.results) {
			const current = this.#plannedResult(own, frozen.id);
			if (current === undefined || resultContractIdentity(current) !== resultContractIdentity(frozen)) return true;
		}
		const rows = own.record.results ?? [];
		for (const consumed of subject.consumed) {
			if (consumed.subject.kind !== "result") continue;
			const resultId = consumed.subject.id;
			const row = rows.find(candidate => candidate.id === resultId);
			const expected = consumed.state === "missing" ? MISSING_INPUT : consumed.version;
			if (currentInputVersion(row) !== expected) return true;
		}
		return false;
	}

	/** Records a seal's exact disposition on the change rows it can satisfy, without a second settlement or a new row. */
	#noteSealOnRows(own: OwnRun, state: IntegrationAdmissionState): void {
		const subject = state.admission.subject;
		if (subject.kind !== "planned" || subject.results.length === 0 || state.boundAttemptId === undefined) return;
		const readiness = this.#sealBaseReadiness(own, state);
		const rows = own.record.results ?? [];
		let changed = false;
		for (const frozen of subject.results) {
			if (frozen.kind !== "change") continue;
			const row = rows.find(candidate => candidate.id === frozen.id);
			if (row === undefined || row.attemptId !== state.boundAttemptId) continue;
			if (row.identity !== undefined && row.identity !== resultContractIdentity(frozen)) continue;
			if (row.state === "accepted" || row.state === "reviewable") continue;
			if (readiness.kind === "ready") {
				row.state = "pending";
				row.reason = compactResultReason(`통합 선택을 기다립니다(후보 ${state.admission.candidateId}).`);
				this.#integrationStateFor(own).awaiting.set(row.id, state.admission.candidateId);
				changed = true;
				continue;
			}
			if (readiness.kind === "awaiting-native") continue;
			const reason = readiness.kind === "confirmed-empty"
				? EMPTY_CAPTURE_REASON
				: "problem" in readiness
					? readiness.problem.reason
					: "통합 후보를 사용할 수 없습니다.";
			row.state = "unmet";
			row.reason = compactResultReason(reason);
			row.origin = "attempt";
			row.identity = resultContractIdentity(frozen);
			this.#integrationStateFor(own).awaiting.delete(row.id);
			delete row.contentVersion;
			delete row.reviewTree;
			delete row.proof;
			delete row.restoredFrom;
			delete row.remedy;
			delete row.retryRoute;
			delete row.unblock;
			changed = true;
		}
		if (changed) {
			this.#invalidateConsumers(own);
			this.#scheduleFlush(own);
		}
	}

	/**
	 * A's durable update. A seal, a late recovery fact and a fail-closed diagnostic are separate observations; none
	 * starts work, adds a result row, writes the target or issues a receipt. Replays are idempotent by admission key.
	 */
	async observe(update: CaptureUpdate): Promise<void> {
		const own = this.#own;
		if (own === undefined || this.deps.integration?.(own.sessionDir) === undefined) return;
		this.#lastProjection = undefined;
		const state = this.#integrationStateFor(own);
		if (update.kind === "sealed") {
			const manifest = update.manifest;
			const key = manifest.admission.key;
			if (key.runId !== own.record.runId || key.schema !== INTEGRATION_KEY_SCHEMA) return;
			if (!Number.isSafeInteger(update.journalSequence) || update.journalSequence <= 0) return;
			const admitted = state.admissions.get(key.dispatch);
			if (admitted !== undefined && admitted.seal !== undefined) {
				if (admitted.seal.digest !== manifest.digest) {
					admitted.problem ??= integrationProblem("manifest-contradiction", "같은 수락에 다른 캡처가 관측되었습니다.");
					return;
				}
				// A re-delivers the same durable seal with the existing attempt settlement: equal sequence is not a
				// replay when it carries the binding C has not seen. An older sequence is always stale.
				if ((admitted.sealSequence ?? 0) > update.journalSequence) return;
				if ((admitted.sealSequence ?? 0) === update.journalSequence && update.settlement === undefined &&
					admitted.boundAttemptId !== undefined) return;
			}
			const problem = this.#mergeStored(state, {
				manifest,
				recovery: [],
				lastWrite: admitted?.lastWrite ?? null,
			});
			const merged = state.candidates.get(manifest.admission.candidateId);
			if (merged === undefined) return;
			if (problem !== undefined) merged.problem ??= problem;
			merged.sealSequence = Math.max(merged.sealSequence ?? 0, update.journalSequence);
			if (update.settlement !== undefined) {
				const settlement = update.settlement;
				const attemptId = settlement.report.attemptId;
				const subject = merged.admission.subject;
				const prepared = own.attempts.get(key.dispatch) ??
					[...own.settled.values()].find(candidate => candidate.prepared.dispatch === key.dispatch)?.prepared;
				const exact =
					settlement.runId === own.record.runId && settlement.dispatch === key.dispatch &&
					(prepared === undefined || settlement.parentId === prepared.parentId) &&
					settlement.spawnKey === merged.admission.item.handle &&
					(subject.kind === "unplanned" || settlement.lane === subject.lane) &&
					attemptId !== undefined;
				if (!exact) {
					merged.problem ??= integrationProblem("settlement-binding-mismatch", "캡처의 정산 결속이 이 수락과 다릅니다.");
				} else if (merged.boundAttemptId !== undefined && merged.boundAttemptId !== attemptId) {
					merged.problem ??= integrationProblem("settlement-contradiction", "같은 수락에 다른 네이티브 시도가 결속되었습니다.");
				} else {
					merged.boundAttemptId = attemptId;
				}
			}
			this.#noteSealOnRows(own, merged);
			return;
		}
		if (update.kind === "recovery") {
			const observation = update.observation;
			if (observation.schema !== "storm.integration-recovery/v1" || observation.key.runId !== own.record.runId) return;
			const admitted = state.candidates.get(observation.candidateId) ?? state.admissions.get(observation.key.dispatch);
			if (admitted === undefined) return;
			if (admitted.recovery.some(seen => seen.observationKey === observation.observationKey)) return;
			admitted.recovery.push(observation);
			if (admitted.recovery.length > INTEGRATION_RECOVERY_MAX) {
				admitted.recovery.splice(0, admitted.recovery.length - INTEGRATION_RECOVERY_MAX);
			}
			if (observation.contradiction.kind === "known") {
				admitted.problem ??= observation.contradiction.value;
				this.#noteSealOnRows(own, admitted);
			}
			return;
		}
		const admitted = state.candidates.get(update.candidateId) ?? state.admissions.get(update.key.dispatch);
		if (admitted === undefined || admitted.seal !== undefined) return;
		admitted.problem ??= update.problem;
		this.#noteSealOnRows(own, admitted);
	}

	/** One bounded keyed replay per run; null is the journal's own "no record", never an empty candidate list. */
	async #replayIntegration(ports: IntegrationPorts, state: IntegrationRunState, runId: string): Promise<IntegrationRead<{ readonly lastSequence: number } | null>> {
		if (state.replayDone) {
			return integrationKnown(state.lastSequence === undefined ? null : { lastSequence: state.lastSequence });
		}
		const replay = await ports.journal.replay(runId, entry => {
			this.#mergeStored(state, entry);
		});
		if (replay.kind !== "known") return replay;
		state.replayDone = true;
		if (replay.value !== null) state.lastSequence = replay.value.lastSequence;
		return replay;
	}

	/** Stored candidate from B, merged into the active projection; unknown store content is never an empty record. */
	async #storedCandidate(own: OwnRun | undefined, state: IntegrationRunState, admitted: IntegrationAdmissionState): Promise<IntegrationRead<StoredCandidate>> {
		const ports = this.deps.integration?.(admitted.admission.director.sessionDir);
		if (ports === undefined) return integrationUnknown("integration-disabled", "이 호스트에서는 격리 통합 기록을 읽지 않습니다.");
		const runId = own?.record.runId ?? admitted.admission.key.runId;
		const read = await ports.journal.readCandidate(runId, admitted.admission.candidateId);
		if (read.kind !== "known") return read;
		if (read.value === null) {
			return admitted.seal === undefined
				? integrationUnknown("candidate-missing", "저장된 통합 후보를 찾지 못했습니다.")
				: integrationKnown({ manifest: admitted.seal, recovery: admitted.recovery, lastWrite: admitted.lastWrite ?? null });
		}
		const problem = this.#mergeStored(state, read.value);
		if (problem !== undefined && admitted.seal === undefined) return integrationUnknown(problem.code, problem.reason);
		return integrationKnown(read.value);
	}

	async #writeFor(own: OwnRun | undefined, state: IntegrationRunState, admitted: IntegrationAdmissionState): Promise<QueueWrite> {
		const stored = await this.#storedCandidate(own, state, admitted);
		const write = admitted.lastWrite ?? (stored.kind === "known" ? stored.value.lastWrite : null);
		if (write === null || write === undefined) return { kind: "not-written" };
		switch (write.kind) {
			case "written":
			case "already-written":
				return { kind: "written", receipt: write.receipt.ref, at: write.receipt.readBackAt };
			case "conflict":
			case "refused":
				return { kind: "not-recorded", problem: write.problem };
			case "no-effect":
				return { kind: "no-effect", problem: write.problem };
			case "present-unattributed":
				return { kind: "present-unattributed", problem: write.problem };
			case "recovery-required":
				return { kind: "recovery-required", problem: write.problem };
		}
	}

	/** The one candidate's postimage presence; exact paths only, never a worktree scan. */
	async #presenceFor(admitted: IntegrationAdmissionState, window: ByteWindow): Promise<Presence> {
		const ports = this.deps.integration?.(admitted.admission.director.sessionDir);
		if (ports === undefined) return { kind: "unknown", problem: integrationProblem("integration-disabled", "이 호스트에서는 격리 통합을 확인하지 않습니다.") };
		const seal = admitted.seal;
		if (seal === undefined) return { kind: "unknown", problem: integrationProblem("awaiting-native", "네이티브 캡처를 기다립니다.") };
		if (seal.delta.kind !== "known") return { kind: "unknown", problem: seal.delta.problem };
		const paths = seal.delta.value.entries.map(entry => ({ path: entry.targetPath, image: entry.after.state }));
		if (paths.length === 0) return { kind: "unknown", problem: integrationProblem("empty-proof", "정확 델타에 경로가 없습니다.") };
		return ports.delta.observePresence(seal.admission.target, paths, window);
	}

	async #readinessFor(own: OwnRun | undefined, state: IntegrationRunState, admitted: IntegrationAdmissionState, window: ByteWindow): Promise<QueueReadiness> {
		const base = this.#sealBaseReadiness(own, admitted);
		if (base.kind !== "ready") return base;
		const ports = this.deps.integration?.(admitted.admission.director.sessionDir);
		if (ports === undefined) return { kind: "unknown", problem: integrationProblem("integration-disabled", "이 호스트에서는 격리 통합을 선택하지 않습니다.") };
		if (own !== undefined) {
			const consumed = await this.#consumedProblem(own, admitted, window);
			if (consumed !== undefined) return { kind: "stale", problem: consumed };
		}
		const stored = await this.#storedCandidate(own, state, admitted);
		if (stored.kind !== "known") return { kind: "unknown", problem: stored.problem };
		const write = admitted.lastWrite ?? stored.value.lastWrite;
		if (write?.kind === "recovery-required" || write?.kind === "present-unattributed") {
			return { kind: "conflict", problem: write.problem };
		}
		const target = admitted.admission.target;
		const fence = await ports.journal.findFence({ canonicalRoot: target.authorizedRoot.canonicalPath, leaseKey: target.leaseKey });
		if (fence.kind === "fenced") {
			return { kind: "conflict", problem: integrationProblem("target-fenced", "대상에 해결되지 않은 통합 펜스가 있습니다.") };
		}
		if (fence.kind === "unknown") return { kind: "unknown", problem: fence.problem };
		return { kind: "ready" };
	}

	async #lineFor(own: OwnRun | undefined, state: IntegrationRunState, admitted: IntegrationAdmissionState, window: ByteWindow): Promise<CandidateLine> {
		const readiness = await this.#readinessFor(own, state, admitted, window);
		const write = await this.#writeFor(own, state, admitted);
		const presence = await this.#presenceFor(admitted, window);
		return {
			candidateId: admitted.admission.candidateId,
			childHandle: admitted.admission.item.handle,
			subject: admitted.admission.subject.kind === "planned"
				? { kind: "planned", lane: admitted.admission.subject.lane }
				: { kind: "unplanned" },
			readiness,
			write,
			presence,
		};
	}

	#orderedCandidates(state: IntegrationRunState): IntegrationAdmissionState[] {
		return [...state.candidates.values()]
			.filter(candidate => candidate.status === "committed" && candidate.seal !== undefined)
			.sort((left, right) => {
				const ordinal = left.admission.placementOrdinal - right.admission.placementOrdinal;
				if (ordinal !== 0) return ordinal;
				return left.admission.candidateId < right.admission.candidateId ? -1 : left.admission.candidateId > right.admission.candidateId ? 1 : 0;
			});
	}

	/** Read-only candidate projection; it never starts a target effect, wake, check or reviewer. */
	async project(query: CandidateQuery, window: ByteWindow, sessionDir = this.#own?.sessionDir ?? this.#recentIntegration?.sessionDir): Promise<CandidateProjection> {
		if (query.kind !== "overview" && query.kind !== "detail") {
			return { kind: "unknown", problem: integrationProblem("query-invalid", "후보 조회의 종류가 올바르지 않습니다.") };
		}
		const ports = sessionDir === undefined ? undefined : this.deps.integration?.(sessionDir);
		if (ports === undefined) return { kind: "not-recorded" };
		let own: OwnRun | undefined;
		let state: IntegrationRunState;
		let rows: readonly RunResult[] = [];
		let runId: string | undefined;
		const active = this.#own;
		if (active !== undefined && active.sessionDir === sessionDir && (query.runId === undefined || query.runId === active.record.runId)) {
			own = active;
			state = this.#integrationStateFor(active);
			rows = active.record.results ?? [];
			runId = active.record.runId;
		} else if (this.#recentIntegration !== undefined && this.#recentIntegration.sessionDir === sessionDir &&
			(query.runId === undefined || query.runId === this.#recentIntegration.runId)) {
			state = this.#recentIntegration.state;
			rows = this.#recentIntegration.rows ?? [];
			// After close, late durable seals/recovery no longer publish to the live run.
			state.replayDone = false;
			runId = this.#recentIntegration.runId;
		} else if (query.runId !== undefined) {
			state = emptyIntegrationState();
			own = undefined;
			runId = query.runId;
		} else {
			return { kind: "not-recorded" };
		}
		if (runId === undefined) return { kind: "not-recorded" };
		await ports.settleCapture?.(runId, window);
		const replay = await this.#replayIntegration(ports, state, runId);
		if (replay.kind !== "known") return { kind: "unknown", problem: replay.problem };
		if (replay.value === null && state.candidates.size === 0) return { kind: "not-recorded" };

		if (query.kind === "detail") {
			if (!isCandidateId(query.candidateId)) {
				return { kind: "unknown", problem: integrationProblem("candidate-id-invalid", "후보 id의 형식이 올바르지 않습니다.") };
			}
			const admitted = state.candidates.get(query.candidateId);
			if (admitted === undefined) {
				return { kind: "unknown", problem: integrationProblem("candidate-unknown", "이 실행의 통합 후보가 아닙니다.") };
			}
			if (admitted.status !== "committed" && admitted.seal === undefined) {
				return { kind: "unknown", problem: integrationProblem("candidate-unknown", "게시되지 않은 통합 수락은 조회할 수 없습니다.") };
			}
			const line = await this.#lineFor(own, state, admitted, window);
			const seal = admitted.seal;
			const revision: CandidateRevision | null = seal === undefined
				? null
				: { key: seal.admission.key, candidateId: seal.admission.candidateId, manifestDigest: seal.digest };
			const terminal = seal?.terminal;
			const child = seal?.childClaim;
			const carrier: IntegrationRead<"sync" | "wait" | "push"> = terminal?.kind === "known"
				? integrationKnown(terminal.value.carrier)
				: integrationUnknown("terminal-unknown", terminal !== undefined && terminal.kind === "unknown" ? terminal.problem.reason : "네이티브 종결을 확인하지 못했습니다.");
			const checkoutClaim: IntegrationRead<{ readonly reference: string; readonly checkedAt: number }> = child?.kind === "known"
				? integrationKnown({ reference: child.value.checkout.canonicalPath, checkedAt: child.value.checkedAt })
				: integrationUnknown("claim-unknown", child !== undefined && child.kind === "unknown" ? child.problem.reason : "자식 진입 증명이 없습니다.");
			const outcome: IntegrationRead<"success" | "failure" | "cancel"> = terminal?.kind === "known" && terminal.value.outcome.kind === "known"
				? integrationKnown(terminal.value.outcome.value)
				: integrationUnknown("outcome-unknown", "네이티브 결과를 확인하지 못했습니다.");
			const stopCause: IntegrationRead<string> = terminal?.kind === "known"
				? terminal.value.stopCause.kind === "known"
					? integrationKnown(terminal.value.stopCause.value)
					: integrationUnknown("stop-unknown", "중단 사유를 확인하지 못했습니다.")
				: integrationUnknown("stop-unknown", "네이티브 종결을 확인하지 못했습니다.");
			const recovery = seal?.recovery;
			const latestRecovery = admitted.recovery.at(-1)?.facts;
			const root = recovery?.root.kind === "known" ? recovery.root : latestRecovery?.root;
			const copy = root?.kind === "known" ? root.value.copy : undefined;
			const stormCopy: IntegrationRead<{ readonly reference: string; readonly bytes: number; readonly sha256: string }> =
				copy?.kind === "known"
					? integrationKnown({ reference: copy.value.objectKey, bytes: copy.value.bytes, sha256: copy.value.sha256 })
					: integrationUnknown("copy-unknown", "Storm이 보존한 바이트를 확인하지 못했습니다.");
			const branch = recovery?.branch.kind === "known" ? recovery.branch : latestRecovery?.branch;
			const nativeBranch: IntegrationRead<{ readonly ref: string; readonly base: IntegrationRead<string>; readonly tip: IntegrationRead<string> }> =
				branch?.kind === "known"
					? integrationKnown({ ref: branch.value.ref, base: branch.value.typedBaseOid, tip: branch.value.observedTipOid })
					: integrationUnknown("branch-unknown", "네이티브 브랜치를 확인하지 못했습니다.");
			const nested = recovery?.nested.kind === "known" ? recovery.nested : latestRecovery?.nested;
			const nativeLink = recovery?.nativeLink.kind === "known" ? recovery.nativeLink : latestRecovery?.nativeLink;
			const checkout = latestRecovery !== undefined && latestRecovery.checkout.kind !== "unknown"
				? latestRecovery.checkout
				: recovery?.checkout;
			const dirtyPaths: IntegrationRead<{ readonly total: number; readonly examples: readonly string[]; readonly dirtyDeletes: readonly string[] }> =
				seal?.delta.kind === "known"
					? await ports.delta.observeDirtyPaths(seal.delta.value, window)
					: integrationUnknown("delta-unknown", "정확 델타 증명이 없습니다.");
			const detail: CandidateDetail = {
				line,
				revision,
				provenance: {
					key: admitted.admission.key,
					placementOrdinal: admitted.admission.placementOrdinal,
					carrier,
					checkoutClaim,
				},
				outcome,
				stopCause,
				cancelRequested: terminal?.kind === "known" ? terminal.value.cancelRequested : false,
				bundle: seal?.bundle.kind ?? "unknown",
				recovery: {
					stormCopy,
					nativePatch: root?.kind === "known" ? integrationKnown(root.value.nativePath) : integrationUnknown("patch-unknown", "네이티브 패치 경로를 확인하지 못했습니다."),
					nativeBranch,
					nestedCount: nested?.kind === "known" ? integrationKnown(nested.value.length) : integrationUnknown("nested-unknown", "중첩 캡처 목록을 확인하지 못했습니다."),
					nestedExamples: nested?.kind === "known"
						? nested.value.slice(0, INTEGRATION_EXAMPLES).map(part => ({ reference: part.nativePath, relativeRepo: part.relativeRepo }))
						: [],
					checkout: checkout ?? { kind: "unknown", problem: integrationProblem("checkout-unknown", "정확 체크아웃을 확인하지 못했습니다.") },
					nativeLink: nativeLink ?? integrationUnknown("link-unknown", "네이티브 기록 링크가 없습니다."),
				},
				dirtyPaths,
				resultStates: admitted.admission.subject.kind === "planned"
					? admitted.admission.subject.results.map(result => ({
							id: result.id,
							state: rows.find(row => row.id === result.id)?.state ?? "pending",
						}))
					: [],
			};
			const projection: CandidateProjection = { kind: "detail", value: detail };
			if (own !== undefined && this.#own === own) this.#lastProjection = { runId, projection };
			return projection;
		}

		if (query.after !== undefined && !isCandidateId(query.after)) {
			return { kind: "unknown", problem: integrationProblem("candidate-cursor-invalid", "후보 커서의 형식이 올바르지 않습니다.") };
		}
		const ordered = this.#orderedCandidates(state);
		let start = 0;
		if (query.after !== undefined) {
			const at = ordered.findIndex(candidate => candidate.admission.candidateId === query.after);
			if (at < 0) return { kind: "unknown", problem: integrationProblem("candidate-cursor-unknown", "커서가 이 실행의 후보가 아닙니다.") };
			start = at + 1;
		}
		const readiness = emptyReadinessCounts();
		const writes = emptyWriteCounts();
		const lines: CandidateLine[] = [];
		let present = 0;
		let changed = 0;
		let unknownPresence = 0;
		for (const admitted of ordered) {
			const line = await this.#lineFor(own, state, admitted, window);
			readiness[line.readiness.kind] += 1;
			writes[line.write.kind] += 1;
			if (line.presence.kind === "present") present += 1;
			else if (line.presence.kind === "changed") changed += 1;
			else unknownPresence += 1;
			lines.push(line);
		}
		const page = lines.slice(start, start + INTEGRATION_PAGE);
		const nextAfter = start + page.length < lines.length ? page[page.length - 1]!.candidateId : null;
		const projection: CandidateProjection = {
			kind: "overview",
			value: {
				runId,
				observedAt: this.deps.now(),
				readiness,
				writes,
				present,
				changed,
				unknownPresence,
				examples: page.slice(0, INTEGRATION_EXAMPLES),
				page: page.map(line => line.candidateId),
				nextAfter,
			},
		};
		if (own !== undefined && this.#own === own) this.#lastProjection = { runId, projection };
		return projection;
	}

	#laneFilesFor(own: OwnRun, admitted: IntegrationAdmissionState): readonly string[] | undefined {
		const dispatch = admitted.admission.key.dispatch;
		for (const settled of own.settled.values()) if (settled.prepared.dispatch === dispatch) return settled.prepared.laneFiles;
		const prepared = own.attempts.get(dispatch);
		if (prepared !== undefined) return prepared.laneFiles;
		const subject = admitted.admission.subject;
		if (subject.kind !== "planned") return undefined;
		return own.record.plan?.lanes.find(lane => lane.name === subject.lane)?.files;
	}

	#targetProblem(own: OwnRun, admitted: IntegrationAdmissionState): IntegrationProblem | undefined {
		if (own.lease === undefined) return integrationProblem("lease-missing", "실행 쓰기 잠금이 없어 통합 대상을 확인하지 못했습니다.");
		const target = admitted.admission.target;
		if (target.leaseKey !== own.lease.record.key ||
			path.resolve(target.authorizedRoot.canonicalPath) !== path.resolve(own.lease.root)) {
			return integrationProblem("target-mismatch", "통합 대상이 이 실행의 현재 쓰기 잠금 대상과 다릅니다.");
		}
		return undefined;
	}

	/** The current plan contract for the exact result ids the admission froze. */
	#contractProblem(own: OwnRun, admitted: IntegrationAdmissionState): IntegrationProblem | undefined {
		const subject = admitted.admission.subject;
		if (subject.kind === "unplanned") return undefined;
		if (own.record.plan?.lanes.some(lane => lane.name === subject.lane) !== true) {
			return integrationProblem("lane-not-planned", "이 후보의 레인이 현재 계획에 없습니다.");
		}
		if (subject.results.length === 0) {
			return own.integration?.laneEpoch.get(subject.lane) === subject.epoch
				? undefined
				: integrationProblem("candidate-stale", "더 새로운 결과 없는 후보가 이 레인에 있습니다.");
		}
		for (const frozen of subject.results) {
			const current = this.#plannedResult(own, frozen.id);
			if (current === undefined || resultContractIdentity(current) !== resultContractIdentity(frozen)) {
				return integrationProblem("contract-changed", "이 후보가 고정한 결과 계약이 현재 계획과 다릅니다.");
			}
		}
		return undefined;
	}

	/** Rechecks the exact producer versions and locations a frozen subject consumed. */
	async #consumedProblem(
		own: OwnRun,
		admitted: IntegrationAdmissionState,
		window: ByteWindow,
	): Promise<IntegrationProblem | undefined> {
		const subject = admitted.admission.subject;
		if (subject.kind === "unplanned") return undefined;
		const rows = own.record.results ?? [];
		for (const consumed of subject.consumed) {
			const label = consumed.subject.kind === "result" ? consumed.subject.id : `${consumed.subject.lane} 전체`;
			if (consumed.subject.kind === "resultless-footprint") {
				const footprint = await this.#currentFootprint(own, consumed.subject.lane, window);
				if (consumed.state === "missing" || footprint === undefined) {
					return integrationProblem("consumed-footprint-missing", `선행 '${label}'의 현재 통합 영수증이 없습니다.`);
				}
				if (footprint.version !== consumed.version ||
					(consumed.state === "integrated" && !sameReceipt(footprint.receipt, consumed.receipt))) {
					return integrationProblem("consumed-footprint-changed", `선행 '${label}'의 통합 영수증이 이 시도가 시작한 것과 다릅니다.`);
				}
				continue;
			}
			const resultId = consumed.subject.id;
			const row = rows.find(candidate => candidate.id === resultId);
			if (consumed.state === "missing") {
				return integrationProblem("consumed-missing", `선행 결과 '${label}' 없이 시작한 시도는 나중에 보완할 수 없습니다.`);
			}
			if (currentInputVersion(row) !== consumed.version) {
				return integrationProblem("consumed-changed", `선행 결과 '${label}'의 현재 버전이 이 시도가 시작한 버전과 다릅니다.`);
			}
			if (consumed.state === "integrated") {
				const current = await this.#currentIntegratedResult(own, resultId, window);
				if (current === undefined || current.version !== consumed.version || !sameReceipt(current.receipt, consumed.receipt)) {
					return integrationProblem("consumed-receipt-changed", `선행 결과 '${label}'의 통합 영수증이 더 이상 현재 것이 아닙니다.`);
				}
				if (current.paths.length !== consumed.paths.length ||
					current.paths.some((path, index) => path.path !== consumed.paths[index]?.path ||
						consumed.paths[index] === undefined || !sameImage(path.image, consumed.paths[index]!.image))) {
					return integrationProblem("consumed-location-changed", `선행 결과 '${label}'의 통합 위치가 이 시도가 시작한 위치와 다릅니다.`);
				}
				continue;
			}
			if (consumed.need === "result" && row?.state !== "accepted") {
				return integrationProblem("consumed-result-missing", `선행 결과 '${label}': 더 이상 수용 상태가 아닙니다.`);
			}
			if (consumed.need === "reviewable" && row?.state !== "accepted" && row?.state !== "reviewable") {
				return integrationProblem("consumed-reviewable-missing", `선행 결과 '${label}': 더 이상 검토 가능 상태가 아닙니다.`);
			}
			if (consumed.need === "integrated" && row !== undefined) {
				const result = this.#plannedResult(own, resultId) ?? row.contract;
				if (result === undefined) return integrationProblem("consumed-contract-missing", `선행 결과 '${label}'의 현재 계약이 없습니다.`);
				const lane = own.record.plan?.lanes.find(candidate => (candidate.results ?? []).some(item => item.id === resultId));
				const isolated = lane !== undefined && (lane.isolationReason !== undefined || own.config.isolation === "isolated");
				const location = await this.#acceptedLocation(own, result, isolated, row);
				if (!location.ok) {
					return integrationProblem("consumed-not-integrated", `선행 결과 '${label}': 현재 부모에 통합되어 있지 않습니다.`);
				}
				if (!location.integrated) {
					return integrationProblem("consumed-not-integrated", `선행 결과 '${label}'의 통합 위치를 현재 확인하지 못했습니다.`);
				}
			}
		}
		return undefined;
	}

	/** B's durable receipt for one candidate, only in the written/already-written states. */
	async #latestReceipt(own: OwnRun | undefined, state: IntegrationRunState, admitted: IntegrationAdmissionState): Promise<IntegrationRead<WriteReceipt>> {
		const stored = await this.#storedCandidate(own, state, admitted);
		if (stored.kind !== "known") return stored;
		const write = admitted.lastWrite ?? stored.value.lastWrite;
		if (write === undefined || write === null) return integrationUnknown("receipt-missing", "아직 이 후보의 통합 영수증이 없습니다.");
		if (write.kind === "written" || write.kind === "already-written") return integrationKnown(write.receipt);
		return integrationUnknown(`write-${write.kind}`, write.problem.reason);
	}

	/** Freshly proves one recorded result state against its current receipt, target presence and consumed inputs. */
	async #verifyReceiptState(
		own: OwnRun,
		result: PlanLaneResult,
		row: RunResult,
		recorded: IntegrationResultState,
		window: ByteWindow,
	): Promise<IntegrationCheck> {
		const ports = this.deps.integration?.(own.sessionDir);
		if (ports === undefined) return integrationFail("integration-disabled", "이 호스트에서는 격리 통합 영수증을 확인하지 않습니다.");
		const admitted = own.integration?.candidates.get(recorded.candidateId);
		if (admitted === undefined || admitted.seal === undefined) {
			return integrationFail("receipt-candidate-missing", "이 영수증의 후보 기록을 찾지 못했습니다.");
		}
		if (admitted.status !== "committed" || admitted.seal.digest !== recorded.manifestDigest) {
			return integrationFail("receipt-candidate-stale", "영수증의 후보가 현재 게시 상태가 아닙니다.");
		}
		const receipt = await this.#latestReceipt(own, this.#integrationStateFor(own), admitted);
		if (receipt.kind !== "known") return integrationFail(receipt.problem.code, receipt.problem.reason);
		if (!sameReceipt(receipt.value.ref, recorded.receipt) || receipt.value.ref.manifestDigest !== admitted.seal.digest) {
			return integrationFail("receipt-mismatch", "현재 저장된 영수증이 이 결과가 근거로 삼은 영수증과 다릅니다.");
		}
		if (row.attemptId !== recorded.attemptId) return integrationFail("receipt-attempt-mismatch", "영수증의 시도가 행의 시도와 다릅니다.");
		const seal = admitted.seal;
		if (admitted.problem !== undefined) return integrationFail(admitted.problem.code, admitted.problem.reason);
		if (seal.bundle.kind !== "root-only") {
			return integrationFail("candidate-not-written", "영수증은 루트 전용 캡처의 정확 쓰기에서만 나옵니다.");
		}
		if (seal.terminal.kind !== "known" || seal.terminal.value.outcome.kind !== "known" ||
			seal.terminal.value.outcome.value !== "success" || seal.terminal.value.cancelRequested ||
			seal.terminal.value.stopCause.kind === "known") {
			return integrationFail("candidate-not-success", "성공으로 끝난 시도의 영수증이 아닙니다.");
		}
		if (seal.childClaim.kind !== "known") {
			return integrationFail("candidate-unproved", "영수증의 자식 진입·정확 델타 증명이 없습니다.");
		}
		const claim = seal.childClaim.value;
		if (claim.key.dispatch !== seal.admission.key.dispatch || claim.candidateId !== seal.admission.candidateId ||
			claim.childHandle !== seal.admission.item.handle) {
			return integrationFail("child-claim-mismatch", "영수증의 자식 진입 증명이 이 수락과 맞지 않습니다.");
		}
		if (seal.delta.kind !== "known") {
			return integrationFail("candidate-unproved", "영수증의 자식 진입·정확 델타 증명이 없습니다.");
		}
		if (!sameKey(seal.delta.value.key, seal.admission.key) ||
			seal.delta.value.candidateId !== seal.admission.candidateId) {
			return integrationFail("delta-mismatch", "영수증의 정확 델타가 이 수락과 맞지 않습니다.");
		}
		const targetProblem = this.#targetProblem(own, admitted);
		if (targetProblem !== undefined) return integrationFail(targetProblem.code, targetProblem.reason);
		const fence = await ports.journal.findFence({
			canonicalRoot: admitted.admission.target.authorizedRoot.canonicalPath,
			leaseKey: admitted.admission.target.leaseKey,
		});
		if (fence.kind === "fenced") return integrationFail("target-fenced", "대상에 해결되지 않은 통합 펜스가 있습니다.");
		if (fence.kind === "unknown") return integrationFail(fence.problem.code, fence.problem.reason);
		const contractProblem = this.#contractProblem(own, admitted);
		if (contractProblem !== undefined) return integrationFail(contractProblem.code, contractProblem.reason);
		const consumedProblem = await this.#consumedProblem(own, admitted, window);
		if (consumedProblem !== undefined) return integrationFail(consumedProblem.code, consumedProblem.reason);
		const expected = attributablePaths(receipt.value, result, this.#laneFilesFor(own, admitted));
		if (expected.length === 0 || expected.length !== recorded.attributable.length ||
			expected.some((path, index) => path.path !== recorded.attributable[index]?.path ||
				recorded.attributable[index] === undefined || !sameImage(path.image, recorded.attributable[index]!.image))) {
			return integrationFail("attribution-mismatch", "영수증의 내용 변경과 결과 범위의 교집합이 기록과 다릅니다.");
		}
		const presence = await ports.delta.observePresence(
			admitted.admission.target,
			recorded.attributable,
			window,
		);
		if (presence.kind === "unknown") return integrationFail("presence-unknown", presence.problem.reason);
		if (presence.kind !== "present") {
			return integrationFail("presence-changed", `통합 이후 대상 바이트가 영수증과 다릅니다(${presence.firstPath}).`);
		}
		return integrationOk();
	}

	async #witnessFromReceipt(
		admitted: IntegrationAdmissionState,
		receipt: WriteReceipt,
		prepared: PreparedAttempt,
		result: PlanLaneResult,
		attemptId: string,
		window: ByteWindow,
	): Promise<IntegrationRead<AttemptWriteWitness>> {
		const ports = this.deps.integration?.(admitted.admission.director.sessionDir);
		if (ports === undefined) return integrationUnknown("integration-disabled", "이 호스트에서는 격리 통합 근거를 읽지 않습니다.");
		if (admitted.status !== "committed" || admitted.problem !== undefined) {
			return integrationUnknown("candidate-not-current", "현재 게시 상태가 아닌 후보는 통합 근거가 되지 않습니다.");
		}
		const subject = admitted.admission.subject;
		if (subject.kind !== "planned") return integrationUnknown("unplanned", "계획 없는 후보는 결과 근거가 없습니다.");
		if (result.kind !== "change") return integrationUnknown("not-change", "통합 영수증은 change 결과에만 근거가 됩니다.");
		const deltaDigest = admitted.seal?.delta.kind === "known" ? admitted.seal.delta.value.digest : undefined;
		if (!sameKey(receipt.ref.key, admitted.admission.key) || receipt.ref.candidateId !== admitted.admission.candidateId ||
			admitted.seal === undefined || receipt.ref.manifestDigest !== admitted.seal.digest ||
			receipt.intent.candidate.candidateId !== admitted.admission.candidateId ||
			deltaDigest === undefined || receipt.intent.deltaDigest !== deltaDigest) {
			return integrationUnknown("receipt-binding-mismatch", "영수증이 이 후보·매니페스트·델타에 결속되지 않았습니다.");
		}
		if (receipt.end.basis !== "installer-exit-proved") {
			return integrationUnknown("effect-end-unproved", "설치 효과의 끝이 증명되지 않아 영수증을 근거로 쓰지 않습니다.");
		}
		const attributable = attributablePaths(receipt, result, prepared.laneFiles);
		if (attributable.length === 0) {
			return integrationUnknown("outside-scope", "영수증의 내용 변경이 이 결과의 원래 평가 범위에 없습니다.");
		}
		const presence = await ports.delta.observePresence(
			admitted.admission.target,
			attributable,
			window,
		);
		if (presence.kind === "unknown") return integrationUnknown("presence-unknown", presence.problem.reason);
		if (presence.kind !== "present") {
			return integrationUnknown("presence-changed", `통합 이후 대상 바이트가 영수증과 다릅니다(${presence.firstPath}).`);
		}
		return integrationKnown({
			attemptId: attemptId as AttemptWriteWitness["attemptId"],
			dispatch: admitted.admission.key.dispatch,
			lane: subject.lane,
			epoch: subject.epoch,
			contractDigest: subject.contractDigest,
			consumed: subject.consumed,
			receipt: receipt.ref,
			attributable,
			observedAt: this.deps.now(),
		});
	}

	/** Internal C adapter to the original evaluator; unknown/stale/outside-scope bytes yield no witness. */
	async readWitness(settlement: AttemptSettlement, resultId: string, window: ByteWindow): Promise<IntegrationRead<AttemptWriteWitness>> {
		const own = this.#own;
		if (own === undefined || settlement.runId !== own.record.runId) return integrationUnknown("run-not-active", "이 실행의 정산이 아닙니다.");
		if (this.deps.integration?.(own.sessionDir) === undefined) return integrationUnknown("integration-disabled", "이 호스트에서는 격리 통합 근거를 읽지 않습니다.");
		const admitted = own.integration?.admissions.get(settlement.dispatch);
		if (admitted === undefined || admitted.status !== "committed" || admitted.seal === undefined) {
			return integrationUnknown("candidate-missing", "이 시도에 결속된 통합 후보가 없습니다.");
		}
		const subject = admitted.admission.subject;
		if (subject.kind !== "planned" || settlement.lane !== subject.lane ||
			settlement.spawnKey !== admitted.admission.item.handle ||
			settlement.report.attemptId === undefined) {
			return integrationUnknown("settlement-mismatch", "정산이 이 통합 수락의 시도와 맞지 않습니다.");
		}
		if (admitted.boundAttemptId !== undefined && admitted.boundAttemptId !== settlement.report.attemptId) {
			return integrationUnknown("settlement-contradiction", "캡처와 정산의 네이티브 시도가 다릅니다.");
		}
		const result = subject.results.find(candidate => candidate.id === resultId);
		if (result === undefined) return integrationUnknown("result-not-declared", "이 결과는 이 시도의 계약에 없습니다.");
		const settled = [...own.settled.values()].find(candidate => candidate.prepared.dispatch === settlement.dispatch);
		if (settled === undefined) return integrationUnknown("attempt-not-settled", "이 시도의 정산 근거를 아직 읽지 못했습니다.");
		if (settled.attemptId !== settlement.report.attemptId || settled.prepared.parentId !== settlement.parentId) {
			return integrationUnknown("attempt-mismatch", "정산의 시도 id·부모가 저장된 정산과 다릅니다.");
		}
		const receipt = await this.#latestReceipt(own, this.#integrationStateFor(own), admitted);
		if (receipt.kind !== "known") return receipt;
		return this.#witnessFromReceipt(admitted, receipt.value, settled.prepared, result, settled.attemptId, window);
	}

	/** Re-enters only the exact attempt's change rows, for receipt-attributed bytes on the parent tree. */
	async #evaluateIntegrated(
		own: OwnRun,
		settled: SettledAttempt,
		witnesses: ReadonlyMap<string, AttemptWriteWitness>,
		window: ByteWindow,
	): Promise<void> {
		const prepared = settled.prepared;
		const changes = prepared.results.filter(result => result.kind === "change" && witnesses.has(result.id));
		if (changes.length === 0) return;
		const checkNames = changes.filter(result => result.check !== undefined).map(result => result.id);
		const checks = checkNames.length === 0 ? undefined : await this.#approvedCheckEvidence(own);
		const deferred = new Set(checkNames.length > 0 && checks === undefined ? checkNames : []);
		const integratedChange: Record<string, readonly string[]> = {};
		for (const result of changes) integratedChange[result.id] = witnesses.get(result.id)!.attributable.map(path => path.path);
		const evaluation = await evaluateSettledResults({
			lane: prepared.lane,
			attemptId: settled.attemptId,
			results: changes,
			shared: { root: own.root, ...(prepared.baseline === undefined ? {} : { baseline: prepared.baseline }) },
			artifactMode: "isolated",
			config: own.config,
			...(prepared.laneFiles === undefined ? {} : { laneFiles: prepared.laneFiles }),
			...(checks === undefined ? {} : { checks }),
			integratedChange,
			signal: window.signal,
		});
		if (this.#own !== own || own.settled.get(prepared.lane) !== settled ||
			prepared.epoch < (own.laneAttempt.get(prepared.lane) ?? 0)) return;
		if (!evaluation.ok) {
			for (const result of changes) {
				const row = own.record.results?.find(candidate => candidate.id === result.id);
				if (row === undefined || row.attemptId !== settled.attemptId) continue;
				row.state = "unmet";
				row.reason = compactResultReason(`통합된 결과를 다시 평가하지 못했습니다: ${evaluation.reason}`);
				row.origin = "attempt";
				delete row.contentVersion;
				delete row.proof;
				delete row.remedy;
				delete row.retryRoute;
				delete row.unblock;
				own.integration?.awaiting.delete(row.id);
			}
			this.#invalidateConsumers(own);
			this.#scheduleFlush(own);
			return;
		}
		this.#bindConsumedForRows(own, prepared, settled.attemptId);
		this.#applyEvaluated(own, prepared, settled.attemptId, evaluation.report.results, deferred);
		for (const item of evaluation.report.results) {
			const row = own.record.results?.find(candidate => candidate.id === item.id);
			if (row === undefined || row.attemptId !== settled.attemptId) continue;
			if (row.state === "accepted" || row.state === "reviewable") {
				// The row's state carries the check/review gate; the persisted item describes the content this exact receipt
				// proved. A deferred check or a pending reviewer still needs a locatable content proof at acceptance.
				const proofItem = item.state === "accepted" ? item : { ...item, state: "accepted" as const };
				const proof = captureCheckpointProof(proofItem);
				if (proof !== undefined) row.proof = proof;
				own.integration?.awaiting.delete(row.id);
			} else {
				delete row.proof;
				own.integration?.awaiting.delete(row.id);
			}
			delete row.restoredFrom;
			const witness = witnesses.get(item.id);
			if (witness !== undefined) {
				this.#integrationStateFor(own).receipts.set(item.id, {
					receipt: witness.receipt,
					attemptId: settled.attemptId,
					candidateId: witness.receipt.candidateId,
					manifestDigest: witness.receipt.manifestDigest,
					attributable: witness.attributable,
					observedAt: witness.observedAt,
				});
			}
		}
		settled.integrated = {
			receipt: [...witnesses.values()][0]!.receipt,
			candidateId: [...witnesses.values()][0]!.receipt.candidateId,
			witnesses,
			evaluatedAt: this.deps.now(),
		};
		settled.checkDeferred = deferred.size > 0;
		this.#scheduleFlush(own);
	}

	/** Bind every row of the attempt to the producer versions the attempt started from. */
	#bindConsumedForRows(own: OwnRun, prepared: PreparedAttempt, attemptId: string): void {
		for (const row of own.record.results ?? []) {
			if (row.attemptId === attemptId && prepared.results.some(result => result.id === row.id)) this.#bindConsumed(row, prepared);
		}
	}

	/** B's durable receipt re-enters the evaluator once, only for the exact attempt and attributable paths. */
	async #onIntegrationReceipt(receipt: WriteReceipt): Promise<void> {
		const own = this.#own;
		if (own === undefined || receipt.ref.key.runId !== own.record.runId) return;
		const ports = this.deps.integration?.(own.sessionDir);
		if (ports === undefined) return;
		const admitted = own.integration?.candidates.get(receipt.ref.candidateId);
		if (admitted === undefined || admitted.seal === undefined) return;
		if (receipt.ref.manifestDigest !== admitted.seal.digest || !sameKey(receipt.ref.key, admitted.admission.key)) return;
		admitted.lastWrite = { kind: "written", receipt };
		admitted.lastWriteAt = this.deps.now();
		const subject = admitted.admission.subject;
		if (subject.kind === "unplanned") return;
		const window = this.#readWindow();
		if (subject.results.length === 0) {
			const presence = await ports.delta.observePresence(admitted.admission.target, receiptPaths(receipt), window);
			if (presence.kind === "present") {
				this.#integrationStateFor(own).footprints.set(subject.lane, {
					lane: subject.lane,
					receipt: receipt.ref,
					version: receipt.ref.manifestDigest,
					paths: receiptPaths(receipt),
					observedAt: this.deps.now(),
				});
			}
			return;
		}
		const settled = own.settled.get(subject.lane);
		if (settled === undefined || settled.prepared.epoch !== subject.epoch ||
			(admitted.boundAttemptId !== undefined && admitted.boundAttemptId !== settled.attemptId)) return;
		const witnesses = new Map<string, AttemptWriteWitness>();
		for (const result of subject.results) {
			if (result.kind !== "change") continue;
			const witness = await this.#witnessFromReceipt(admitted, receipt, settled.prepared, result, settled.attemptId, window);
			if (witness.kind === "known") witnesses.set(result.id, witness.value);
		}
		await this.#evaluateIntegrated(own, settled, witnesses, window);
	}

	/** Re-runs the same receipt-backed change evaluation once approved check evidence exists. */
	async #refreshIntegrated(own: OwnRun, settled: SettledAttempt, window: ByteWindow): Promise<void> {
		const integrated = settled.integrated;
		if (integrated === undefined) return;
		const admitted = own.integration?.candidates.get(integrated.candidateId);
		if (admitted === undefined || admitted.seal === undefined) return;
		const receipt = await this.#latestReceipt(own, this.#integrationStateFor(own), admitted);
		if (receipt.kind !== "known") return;
		const witnesses = new Map<string, AttemptWriteWitness>();
		for (const result of settled.prepared.results) {
			if (result.kind !== "change") continue;
			const witness = await this.#witnessFromReceipt(admitted, receipt.value, settled.prepared, result, settled.attemptId, window);
			if (witness.kind === "known") witnesses.set(result.id, witness.value);
		}
		await this.#evaluateIntegrated(own, settled, witnesses, window);
	}

	/** The synchronous revalidation B's segment publishes before an effect. */
	async #revalidateCandidate(own: OwnRun, revision: CandidateRevision, window: ByteWindow): Promise<LiveCheck> {
		const ports = this.deps.integration?.(own.sessionDir);
		if (ports === undefined) return { ok: false, reason: "이 호스트에서는 격리 통합을 적용하지 않습니다." };
		const admitted = own.integration?.candidates.get(revision.candidateId);
		if (admitted === undefined || admitted.seal === undefined || admitted.status !== "committed") {
			return { ok: false, reason: "게시된 통합 후보가 아닙니다." };
		}
		if (!sameKey(revision.key, admitted.admission.key) || admitted.seal.digest !== revision.manifestDigest) {
			return { ok: false, reason: "후보 개정이 저장된 매니페스트와 다릅니다." };
		}
		const fail = (problem: IntegrationProblem): LiveCheck => {
			admitted.liveCheck = { revision, problem };
			return { ok: false, reason: problem.reason };
		};
		if (own.ending !== undefined || own.abort.signal.aborted || window.signal.aborted) {
			return fail(integrationProblem("authority-lost", "실행 권한이 끝나 통합을 시작하지 않습니다."));
		}
		const readiness = this.#sealBaseReadiness(own, admitted);
		if (readiness.kind !== "ready") {
			return fail(readiness.kind === "confirmed-empty"
				? integrationProblem("candidate-empty", "빈 캡처는 통합할 수 없습니다.")
				: "problem" in readiness ? readiness.problem : integrationProblem("candidate-not-ready", "통합 후보가 준비 상태가 아닙니다."));
		}
		const targetProblem = this.#targetProblem(own, admitted);
		if (targetProblem !== undefined) return fail(targetProblem);
		const contractProblem = this.#contractProblem(own, admitted);
		if (contractProblem !== undefined) return fail(contractProblem);
		const consumedProblem = await this.#consumedProblem(own, admitted, window);
		if (consumedProblem !== undefined) return fail(consumedProblem);
		const fence = await ports.journal.findFence({
			canonicalRoot: admitted.admission.target.authorizedRoot.canonicalPath,
			leaseKey: admitted.admission.target.leaseKey,
		});
		if (fence.kind === "fenced") return fail(integrationProblem("target-fenced", "대상에 해결되지 않은 통합 펜스가 있습니다."));
		if (fence.kind === "unknown") return fail(fence.problem);
		const stored = await this.#storedCandidate(own, this.#integrationStateFor(own), admitted);
		if (stored.kind !== "known") return fail(stored.problem);
		const write = admitted.lastWrite ?? stored.value.lastWrite;
		if (write?.kind === "recovery-required" || write?.kind === "present-unattributed") return fail(write.problem);
		if (this.#own !== own || own.ending !== undefined || own.abort.signal.aborted || window.signal.aborted) {
			return fail(integrationProblem("authority-lost", "대기 중 실행 권한이 끝났습니다."));
		}
		admitted.liveCheck = { revision };
		return { ok: true };
	}

	/** The final synchronous check after refreshed file/image preflight; never permission to start a check. */
	#checkCandidate(own: OwnRun, revision: CandidateRevision): LiveCheck {
		const admitted = own.integration?.candidates.get(revision.candidateId);
		if (admitted === undefined) return { ok: false, reason: "통합 후보가 사라졌습니다." };
		const checked = admitted.liveCheck;
		if (checked === undefined || checked.revision.manifestDigest !== revision.manifestDigest ||
			!sameKey(checked.revision.key, revision.key)) {
			return { ok: false, reason: "재검증 없이 통합 후보를 쓰지 않습니다." };
		}
		if (checked.problem !== undefined) return { ok: false, reason: checked.problem.reason };
		return own.ending === undefined && !own.abort.signal.aborted ? { ok: true } : { ok: false, reason: "실행 권한이 끝났습니다." };
	}

	/**
	 * The director's explicit selection under the live owning ask. The whole list is validated before any write, then
	 * ordered by consumed receipt, placement ordinal and id. No selection is resumed automatically.
	 */
	async select(input: {
		readonly candidateIds: readonly string[];
		readonly live: Omit<IntegrationLiveGrant, "revalidateCandidate" | "checkCandidate">;
	}): Promise<IntegrationSelectionReply> {
		const own = this.#own;
		const ports = own === undefined ? undefined : this.deps.integration?.(own.sessionDir);
		const refused = (problem: IntegrationProblem): IntegrationSelectionReply => ({ kind: "refused", problem });
		if (ports === undefined) return refused(integrationProblem("integration-disabled", "이 호스트에서는 격리 통합을 선택하지 않습니다."));
		if (own === undefined) return refused(integrationProblem("run-not-active", "진행 중인 실행이 없어 통합을 선택하지 않았습니다."));
		if (own.ending !== undefined || own.abort.signal.aborted || own.finalizing === true) {
			return refused(integrationProblem("run-stopping", "실행이 끝나는 중이라 통합을 선택하지 않았습니다."));
		}
		const ids = input.candidateIds;
		if (!Array.isArray(ids) || ids.length < 1 || ids.length > INTEGRATION_CANDIDATES_MAX ||
			Buffer.byteLength(JSON.stringify(ids), "utf8") > INTEGRATION_LIST_BYTES_MAX) {
			return refused(integrationProblem("candidate-list-invalid", "통합 후보 목록은 1~128개의 정확한 id여야 합니다."));
		}
		const requested: IntegrationCandidateId[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			if (!isCandidateId(id) || seen.has(id)) return refused(integrationProblem("candidate-id-invalid", "통합 후보 id가 형식과 다르거나 중복되었습니다."));
			seen.add(id);
			requested.push(id);
		}
		const audit = input.live.audit;
		if (audit.director.sessionId !== own.sessionId || audit.director.sessionDir !== own.sessionDir ||
			audit.director.sessionInstance.trim() === "" || typeof audit.director.parentId !== "string" ||
			audit.director.parentId.length > 512 || audit.conversationId.trim() === "" || audit.askId.trim() === "" ||
			!Number.isFinite(audit.deadline) || audit.deadline <= this.deps.now() ||
			audit.selection.runId !== own.record.runId || audit.selection.callId.trim() === "" ||
			audit.selection.callId.length > 512) {
			return refused(integrationProblem("authority-invalid", "통합을 선택한 소유 ask·대화·기한을 확인하지 못했습니다."));
		}
		const liveNow = input.live.check();
		if (!liveNow.ok) return refused(integrationProblem("authority-live", liveNow.reason));
		if (input.live.signal.aborted) return refused(integrationProblem("authority-signal", "선택 권한이 취소되었습니다."));
		this.#lastProjection = undefined;

		const state = this.#integrationStateFor(own);
		const replay = await this.#replayIntegration(ports, state, own.record.runId);
		if (replay.kind !== "known") return refused(replay.problem);
		const selectionSignal = AbortSignal.any([own.abort.signal, input.live.signal]);
		const window = this.#windowFor(selectionSignal, audit.deadline);
		const steps = new Map<string, WriteStepRecord>();
		const ready: IntegrationAdmissionState[] = [];
		let skipped = 0;
		for (const id of requested) {
			const admitted = state.candidates.get(id);
			if (admitted === undefined || admitted.status !== "committed" || admitted.admission.key.runId !== own.record.runId) {
				return refused(integrationProblem("candidate-foreign", "이 실행의 게시된 통합 후보가 아닌 id가 있습니다."));
			}
			const readiness = await this.#readinessFor(own, state, admitted, window);
			if (readiness.kind !== "ready") {
				steps.set(id, {
					candidateId: id,
					state: "not-ready",
					problem: readiness.kind === "confirmed-empty"
						? integrationProblem("candidate-empty", "빈 캡처는 통합할 수 없습니다.")
						: "problem" in readiness ? readiness.problem : integrationProblem("candidate-not-ready", "후보가 준비 상태가 아닙니다."),
				});
				skipped += 1;
				continue;
			}
			const consumed = await this.#consumedProblem(own, admitted, window);
			if (consumed !== undefined) {
				steps.set(id, { candidateId: id, state: "not-ready", problem: consumed });
				skipped += 1;
				continue;
			}
			ready.push(admitted);
		}

		// Prerequisite order: only a selected producer's receipt that the consumer actually consumed is an edge.
		const edges = new Map<string, Set<string>>();
		const indegree = new Map<string, number>();
		for (const candidate of ready) {
			edges.set(candidate.admission.candidateId, new Set());
			indegree.set(candidate.admission.candidateId, 0);
		}
		const byCandidate = new Map<string, IntegrationAdmissionState>();
		for (const candidate of ready) byCandidate.set(candidate.admission.candidateId, candidate);
		for (const consumer of ready) {
			const subject = consumer.admission.subject;
			if (subject.kind !== "planned") continue;
			for (const consumed of subject.consumed) {
				if (consumed.state !== "integrated") continue;
				const consumedResultId = consumed.subject.kind === "result" ? consumed.subject.id : undefined;
				// The consumed receipt names the exact producer write. Selecting a different/newer candidate for the
				// same result is not that write and creates no edge; a missing producer in this list is not repaired.
				const producer = byCandidate.get(consumed.receipt.candidateId);
				if (producer === undefined || producer === consumer) continue;
				const producerSubject = producer.admission.subject;
				if (producerSubject.kind !== "planned") continue;
				if (consumedResultId === undefined) {
					if (producerSubject.results.length !== 0 || producerSubject.lane !== consumed.producerLane) continue;
				} else if (!producerSubject.results.some(result => result.id === consumedResultId)) {
					continue;
				}
				const out = edges.get(producer.admission.candidateId);
				if (out === undefined || out.has(consumer.admission.candidateId)) continue;
				out.add(consumer.admission.candidateId);
				indegree.set(consumer.admission.candidateId, (indegree.get(consumer.admission.candidateId) ?? 0) + 1);
			}
		}
		const ordered: IntegrationAdmissionState[] = [];
		const pending = [...ready];
		while (pending.length > 0) {
			let best = -1;
			for (let index = 0; index < pending.length; index += 1) {
				const candidate = pending[index]!;
				if ((indegree.get(candidate.admission.candidateId) ?? 0) !== 0) continue;
				if (best < 0) {
					best = index;
					continue;
				}
				const incumbent = pending[best]!;
				const ordinal = candidate.admission.placementOrdinal - incumbent.admission.placementOrdinal;
				if (ordinal < 0 || (ordinal === 0 && candidate.admission.candidateId < incumbent.admission.candidateId)) best = index;
			}
			if (best < 0) return refused(integrationProblem("prerequisite-cycle", "선택한 후보들의 선행 관계가 순환합니다."));
			const [next] = pending.splice(best, 1);
			if (next === undefined) break;
			ordered.push(next);
			for (const dependent of edges.get(next.admission.candidateId) ?? []) {
				indegree.set(dependent, (indegree.get(dependent) ?? 1) - 1);
			}
		}

		const callId = audit.selection.callId;
		const orderedIds = ordered.map(candidate => candidate.admission.candidateId);
		const orderedSet = new Set<string>(orderedIds);
		const chosen = requested.filter(id => orderedSet.has(id));
		const selection: SelectionSnapshot = { key: { runId: own.record.runId, callId }, chosen, ordered: orderedIds };
		if (ordered.length === 0) {
			return {
				kind: "selection", selection, started: 0, written: 0, skipped, notStarted: 0,
				examples: requested.map(id => steps.get(id)).filter((step): step is WriteStepRecord => step !== undefined).slice(0, INTEGRATION_EXAMPLES),
				firstNotStarted: null, stop: null,
			};
		}
		const begun = await ports.journal.beginSelection(selection);
		if (!begun.ok) return refused(begun.problem);
		for (const id of requested) {
			const step = steps.get(id);
			if (step === undefined) continue;
			const recorded = await ports.journal.recordStep(selection.key, step);
			if (!recorded.ok) return refused(recorded.problem);
		}
		const upgraded = await this.#upgradeLease(own);
		if (!upgraded.ok) return refused(integrationProblem("lease-unavailable", upgraded.reason));
		if (this.#own !== own || own.lease === undefined) return refused(integrationProblem("authority-lost", "통합 쓰기 권한이 준비 중에 끝났습니다."));
		const target = ordered[0]!.admission.target;
		for (const candidate of ordered) {
			const other = candidate.admission.target;
			if (other.leaseKey !== target.leaseKey ||
				path.resolve(other.authorizedRoot.canonicalPath) !== path.resolve(target.authorizedRoot.canonicalPath) ||
				other.gitRoot.canonicalPath !== target.gitRoot.canonicalPath ||
				other.gitDir.canonicalPath !== target.gitDir.canonicalPath ||
				other.targetPrefix !== target.targetPrefix) {
				return refused(integrationProblem("mixed-targets", "선택한 후보들이 같은 통합 대상을 쓰지 않습니다."));
			}
		}
		if (target.leaseKey !== own.lease.record.key) return refused(integrationProblem("target-mismatch", "통합 대상이 현재 쓰기 잠금과 다릅니다."));
		const grant: IntegrationLiveGrant = {
			audit,
			signal: input.live.signal,
			check: input.live.check,
			revalidateCandidate: (revision, effectWindow) => this.#revalidateCandidate(own, revision, effectWindow),
			checkCandidate: revision => this.#checkCandidate(own, revision),
		};
		const reserved = await ports.writer.reserveSegment({ lease: own.lease, target, selection, live: grant, window });
		if (reserved.kind !== "known") return refused(reserved.problem);
		const holder = reserved.value;
		let stop: IntegrationProblem | null = null;
		let started = 0;
		let written = 0;
		let notStarted = 0;
		try {
			for (let index = 0; index < ordered.length; index += 1) {
				const admitted = ordered[index]!;
				const id = admitted.admission.candidateId;
				if (stop !== null) {
					steps.set(id, { candidateId: id, state: "not-started" });
					notStarted += 1;
					continue;
				}
				const authority = input.live.check();
				if (!authority.ok) {
					stop = integrationProblem("authority-live", authority.reason);
					steps.set(id, { candidateId: id, state: "not-started" });
					notStarted += 1;
					continue;
				}
				if (this.#own !== own || own.ending !== undefined || own.abort.signal.aborted || input.live.signal.aborted) {
					stop = integrationProblem("authority-lost", "통합 중 실행 권한이 끝났습니다.");
					steps.set(id, { candidateId: id, state: "not-started" });
					notStarted += 1;
					continue;
				}
				const revision: CandidateRevision = {
					key: admitted.admission.key,
					candidateId: id,
					manifestDigest: admitted.seal?.digest ?? "",
				};
				const effectWindow = this.#windowFor(selectionSignal, audit.deadline);
				const revalidated = await this.#revalidateCandidate(own, revision, effectWindow);
				if (!revalidated.ok) {
					const problem = admitted.liveCheck?.problem ?? integrationProblem("revalidate-failed", revalidated.reason);
					steps.set(id, { candidateId: id, state: "not-ready", problem });
					skipped += 1;
					if (problem.code === "target-fenced" || problem.code === "authority-lost" ||
						problem.code === "target-mismatch" || problem.code === "lease-missing") {
						stop = problem;
					}
					continue;
				}
				const finalCheck = this.#checkCandidate(own, revision);
				if (!finalCheck.ok) {
					const problem = admitted.liveCheck?.problem ?? integrationProblem("final-check-failed", finalCheck.reason);
					steps.set(id, { candidateId: id, state: "not-ready", problem });
					skipped += 1;
					if (own.ending !== undefined || own.abort.signal.aborted || input.live.signal.aborted ||
						problem.code === "target-fenced" || problem.code === "authority-lost") {
						stop = problem;
					}
					continue;
				}
				const seal = admitted.seal;
				if (seal === undefined || seal.delta.kind !== "known") {
					steps.set(id, { candidateId: id, state: "not-ready", problem: integrationProblem("delta-missing", "정확 델타 증명이 없습니다.") });
					skipped += 1;
					continue;
				}
				started += 1;
				let result: CandidateWriteResult;
				try {
					result = await ports.writer.applyCandidate({
						holder,
						candidate: revision,
						proof: seal.delta.value,
						window: effectWindow,
					});
				} catch (error) {
					const problem = integrationProblem("writer-error", errorText(error));
					await ports.journal.recordStep(selection.key, { candidateId: id, state: "recovery-required", problem }).catch(() => undefined);
					stop = problem;
					skipped += 1;
					continue;
				}
				let step: WriteStepRecord;
				switch (result.kind) {
					case "written":
					case "already-written":
						step = { candidateId: id, state: result.kind };
						written += 1;
						break;
					case "conflict":
					case "refused":
					case "no-effect":
						step = { candidateId: id, state: result.kind, problem: result.problem };
						skipped += 1;
						break;
					case "present-unattributed":
					case "recovery-required":
						step = { candidateId: id, state: result.kind, problem: result.problem };
						stop = result.problem;
						skipped += 1;
						break;
				}
				steps.set(id, step);
				const recorded = await ports.journal.recordStep(selection.key, step);
				if (!recorded.ok) {
					stop ??= integrationProblem("step-record-failed", recorded.problem.reason);
					continue;
				}
				if (result.kind === "written" || result.kind === "already-written") {
					delete admitted.liveCheck;
					await this.#onIntegrationReceipt(result.receipt).catch(() => undefined);
				}
			}
		} finally {
			const finished = await ports.writer.finishSegment(holder).catch((error: unknown) => integrationFail("segment-finish-failed", errorText(error)));
			if (!finished.ok) stop ??= finished.problem;
		}
		// Record outcomes that happened after an authority loss too; a journal write is not a target effect.
		for (const id of orderedIds) {
			const step = steps.get(id);
			if (step === undefined) continue;
			const recorded = await ports.journal.recordStep(selection.key, step).catch((error: unknown) =>
				integrationFail("step-record-failed", errorText(error)));
			if (!recorded.ok) stop ??= integrationProblem("step-record-failed", recorded.problem.reason);
		}
		const firstNotStarted = ordered.find(candidate => steps.get(candidate.admission.candidateId)?.state === "not-started")?.admission.candidateId ?? null;
		const examples = requested
			.map(id => steps.get(id))
			.filter((step): step is WriteStepRecord => step !== undefined)
			.slice(0, INTEGRATION_EXAMPLES);
		return {
			kind: "selection",
			selection,
			started,
			written,
			skipped,
			notStarted,
			examples,
			firstNotStarted,
			stop,
		};
	}

	/** Operator fence reconciliation; only the directly confirmed user flow reaches this, never the model tool. */
	async reconcile(input: FenceResolutionRequest, window: ByteWindow): Promise<FenceResolution> {
		const own = this.#own;
		const ports = own === undefined ? undefined : this.deps.integration?.(own.sessionDir);
		if (ports === undefined || own === undefined) {
			return { kind: "kept", problem: integrationProblem("integration-disabled", "이 호스트에서는 통합 펜스를 해결하지 않습니다.") };
		}
		if (input.audit.sessionId !== own.sessionId || input.audit.userActionId.trim() === "" ||
			!Number.isFinite(input.audit.acknowledgedAt) ||
			path.resolve(input.fence.root) !== path.resolve(own.lease?.root ?? own.root) ||
			input.fence.runId !== own.record.runId ||
			(own.lease !== undefined && input.fence.leaseKey !== own.lease.record.key)) {
			return { kind: "kept", problem: integrationProblem("fence-foreign", "이 세션·대상의 통합 펜스가 아닙니다.") };
		}
		let confirmed: LiveCheck;
		try {
			confirmed = input.checkOperator();
		} catch {
			confirmed = { ok: false, reason: "운영자 확인을 읽지 못했습니다." };
		}
		if (!confirmed.ok) return { kind: "kept", problem: integrationProblem("operator-not-confirmed", confirmed.reason) };
		try {
			return await ports.journal.resolveFence(input, window);
		} catch (error) {
			return { kind: "kept", problem: integrationProblem("fence-unresolved", errorText(error)) };
		}
	}

	/** Same-run integrated inputs for B's dependency gate; only a current receipt and located verdict count. */
	readIntegratedProducer(query: { readonly runId: string; readonly lane: string }): IntegrationRead<readonly IntegratedInput[]> {
		const own = this.#own;
		if (own === undefined || query.runId !== own.record.runId) return integrationUnknown("run-not-active", "이 실행의 통합 의존성이 아닙니다.");
		if (this.deps.integration?.(own.sessionDir) === undefined) return integrationUnknown("integration-disabled", "이 호스트에서는 격리 통합 의존성을 읽지 않습니다.");
		const state = own.integration;
		if (state === undefined) return integrationUnknown("producer-not-integrated", "이 실행에는 아직 통합 기록이 없습니다.");
		const lane = own.record.plan?.lanes.find(candidate => candidate.name === query.lane);
		const results = lane?.results ?? [];
		if (results.length === 0) {
			const footprint = state.footprints.get(query.lane);
			if (footprint === undefined) return integrationUnknown("producer-not-integrated", "이 결과 없는 레인의 통합 영수증이 없습니다.");
			return integrationKnown([{
				producerLane: query.lane,
				need: "integrated",
				subject: { kind: "resultless-footprint", lane: query.lane },
				state: "integrated",
				version: footprint.version,
				receipt: footprint.receipt,
				paths: footprint.paths,
			}]);
		}
		const integrated: IntegratedInput[] = [];
		for (const result of results) {
			const row = own.record.results?.find(candidate => candidate.id === result.id);
			const recorded = state.receipts.get(result.id);
			if (row === undefined || row.state !== "accepted" || row.contentVersion === undefined ||
				recorded === undefined || recorded.attemptId !== row.attemptId ||
				recorded.manifestDigest !== own.integration?.candidates.get(recorded.candidateId)?.seal?.digest) {
				return integrationUnknown("producer-not-integrated", `선행 결과 '${result.id}': 현재 통합 영수증과 함께 수용되어 있지 않습니다.`);
			}
			integrated.push({
				producerLane: query.lane,
				need: "integrated",
				subject: { kind: "result", id: result.id },
				state: "integrated",
				version: row.contentVersion,
				receipt: recorded.receipt,
				paths: recorded.attributable,
			});
		}
		return integrationKnown(integrated);
	}

	/** Async refresh for a caller that can read the target now; the sync port returns only the last verified cache. */
	async readIntegratedProducerNow(query: { readonly runId: string; readonly lane: string }, window: ByteWindow): Promise<IntegrationRead<readonly IntegratedInput[]>> {
		const own = this.#own;
		if (own === undefined || query.runId !== own.record.runId) return integrationUnknown("run-not-active", "이 실행의 통합 의존성이 아닙니다.");
		const state = own.integration;
		if (state === undefined) return integrationUnknown("producer-not-integrated", "이 실행에는 아직 통합 기록이 없습니다.");
		const lane = own.record.plan?.lanes.find(candidate => candidate.name === query.lane);
		const results = lane?.results ?? [];
		if (results.length === 0) {
			const footprint = await this.#currentFootprint(own, query.lane, window);
			if (footprint === undefined) return integrationUnknown("producer-not-integrated", "이 결과 없는 레인의 현재 통합 영수증이 없습니다.");
			return integrationKnown([{
				producerLane: query.lane,
				need: "integrated",
				subject: { kind: "resultless-footprint", lane: query.lane },
				state: "integrated",
				version: footprint.version,
				receipt: footprint.receipt,
				paths: footprint.paths,
			}]);
		}
		const integrated: IntegratedInput[] = [];
		for (const result of results) {
			const row = own.record.results?.find(candidate => candidate.id === result.id);
			if (row === undefined || row.state !== "accepted") {
				return integrationUnknown("producer-not-integrated", `선행 결과 '${result.id}': 수용 상태가 아닙니다.`);
			}
			const current = await this.#currentIntegratedResult(own, result.id, window);
			if (current === undefined) {
				return integrationUnknown("producer-not-integrated", `선행 결과 '${result.id}'의 현재 통합 영수증을 확인하지 못했습니다.`);
			}
			integrated.push({
				producerLane: query.lane,
				need: "integrated",
				subject: { kind: "result", id: result.id },
				state: "integrated",
				version: current.version,
				receipt: current.receipt,
				paths: current.paths,
			});
		}
		return integrationKnown(integrated);
	}

	async #currentFootprint(own: OwnRun, lane: string, window: ByteWindow): Promise<IntegrationFootprintState | undefined> {
		const state = own.integration;
		const ports = this.deps.integration?.(own.sessionDir);
		if (state === undefined || ports === undefined) return undefined;
		const candidates = [...state.candidates.values()].filter(candidate =>
			candidate.status === "committed" &&
			candidate.admission.subject.kind === "planned" &&
			candidate.admission.subject.lane === lane &&
			candidate.admission.subject.results.length === 0);
		candidates.sort((left, right) =>
			right.admission.startedAt - left.admission.startedAt ||
			right.admission.placementOrdinal - left.admission.placementOrdinal);
		for (const candidate of candidates) {
			const receipt = await this.#latestReceipt(own, state, candidate);
			if (receipt.kind !== "known") continue;
			const paths = receiptPaths(receipt.value);
			if (paths.length === 0) continue;
			const presence = await ports.delta.observePresence(candidate.admission.target, paths, window);
			if (presence.kind !== "present") continue;
			const footprint: IntegrationFootprintState = {
				lane,
				receipt: receipt.value.ref,
				version: receipt.value.ref.manifestDigest,
				paths,
				observedAt: this.deps.now(),
			};
			state.footprints.set(lane, footprint);
			return footprint;
		}
		return undefined;
	}
}

const OUTCOME_LABEL: Record<SpawnRecord["outcome"], string> = {
	// The answer given to omp, not a statement of what ran (see `SpawnRecord.ran`).
	routed: "승인 모델로 배정",
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
	// Legacy: removed 0.28.0 spawn prediction; kept only so a record an earlier tree wrote still has a label.
	"pooled-thread": "풀 스레드 배치",
	budget: "예산 초과",
	internal: "내부 오류",
};

function tally<K extends string>(keys: readonly K[], label: (key: K) => string): string {
	const counts = new Map<K, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	return [...counts].map(([key, n]) => `${label(key)} ${n}`).join(" · ");
}

/**
 * A run's ledger in at most five lines: spend, spawns, director economy and subagents. Detail for status and
 * diagnostics; the transcript keeps the closeout record instead.
 */
export function summarizeRun(run: RunRecord): string {
	const blockCodes = run.spawns.flatMap(spawn => (spawn.outcome === "blocked" && spawn.code ? [spawn.code] : []));
	const spawnLine = run.spawns.length
		? tally(
				run.spawns.map(spawn => spawn.outcome),
				outcome => OUTCOME_LABEL[outcome] ?? outcome,
			)
		: "없음";
	const blockLine = blockCodes.length ? ` · 차단 사유: ${tally(blockCodes, code => BLOCK_LABEL[code] ?? code)}` : "";
	// What a spawn was answered with is not what ran: only a child's own request says that, and only where one was read.
	// Each `ran` is one attempt's observation, so the line names the attempts rather than current status (RF4-8).
	const verified = run.spawns.filter(spawn => spawn.ran?.verdict === "verified").length;
	const mismatched = run.spawns.filter(spawn => spawn.ran?.verdict === "mismatch").length;
	const ranLine = verified + mismatched === 0 ? "" : ` · 시도별 실행 모델 관측 ${verified}${mismatched > 0 ? `, 승인 밖 ${mismatched}(멈춤)` : ""}`;
	const stoppedReasons = run.spawns.flatMap(spawn => (spawn.stop === undefined ? [] : [spawn.stop.reason]));
	const stopLine =
		stoppedReasons.length === 0
			? ""
			: `- Storm 중단: ${stoppedReasons.length}개 · ${tally(stoppedReasons, reason => WORKER_STOP_LABEL[reason] ?? reason)}`;
	const end = run.endReason ? ` · ${endLabel(run.endReason)}` : "";
	// Records of 0.10 and earlier counted no rounds; `maxRounds` is absent from those written before it was kept and
	// from every uncapped run.
	const rounds =
		run.turns === undefined
			? ""
			: run.maxRounds !== undefined
				? ` · ${run.turns}/${run.maxRounds}라운드`
				: ` · ${run.turns}라운드`;
	const lines = [
		`- 실행: ${run.runId} (${STATUS_LABEL[run.status]}${end})${rounds} · 비용(정가 환산) ${formatUsd(run.costUsd)}${run.budget ? ` / 예산 ${formatUsd(run.budget.perRunUsd)}` : ""}${run.plan ? ` · ${planText(run.plan)}` : ""}`,
		`- 스폰: ${spawnLine}${blockLine}${ranLine}`,
		...(stopLine === "" ? [] : [stopLine]),
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
		// Turns the user started in the hub, and stops made there, are counted apart from the director's follow-ups.
		const userTurns = agents.reduce((sum, agent) => sum + (agent.userTurns ?? 0), 0);
		const userStops = agents.reduce((sum, agent) => sum + (agent.userStops ?? 0), 0);
		const user = [...(userTurns > 0 ? [`사용자 지시 ${userTurns}회`] : []), ...(userStops > 0 ? [`사용자 정지 ${userStops}회`] : [])];
		lines.push(`- 서브에이전트: ${agents.length}개 · 재사용 ${reused}개(후속 지시 ${followUps}회)${user.length ? ` · ${user.join(" · ")}` : ""}${cleanup ? ` · ${cleanup}` : ""}`);
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
