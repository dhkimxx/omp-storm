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
	requirementConflict,
	resultInputs,
	staleRequirementIdsForPlan,
} from "./requirements.ts";
import { acquireRunLease, type AcquireRunLeaseResult, type RunLease } from "./lease.ts";
import { PLANLESS_DEADLINE, PLANLESS_NO_TURN_TIME, PLANLESS_SAME_TURN, planlessOpen, stoppedInTurn } from "./planless.ts";
import { activeLedgerRun, endLedgerRun, getLedgerRun, type LedgerRun, setLedgerPlan, spendNote, startLedgerRun } from "./ledger.ts";
import type { AttemptUnplannedDelivery } from "./attempt-collector.ts";
import { UNPLANNED_MAX, unplannedNotice } from "./unplanned.ts";
import { reviewLine } from "./review.ts";
import {
	buildRoundMessage,
	decideRound,
	END_STATUS,
	endLabel,
	stopWords,
	lastWriterChangeAt,
	maxRounds,
	reviewGate,
	reviewProof,
	STATUS_LABEL,
	treeFingerprint,
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
import { buildHandoff, newRunId, pruneRuns, readRun, REQUEST_LIMIT, resumableRun, RUN_KEEP, writeRun } from "./run.ts";
import { carryGoal } from "./goal.ts";
import { appendRunIndex, summarizeForIndex } from "./run-index.ts";
import { findResumeCandidate, noteResumePointer, protectedResumeRunIds, resumeSpec, trustedResume, type ResumeTarget } from "./resume.ts";
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
	record.stop = stop;
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
			kinds.set(spawnKey, record.outcome === "blocked" ? "blocked" : record.lane !== undefined ? "lane" : "unplanned");
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
/** Row 8: a proved successful attempt that captured nothing is "no change captured", never a failed host attempt. */
export const EMPTY_CAPTURE_REASON = "성공으로 끝났지만 보존할 변경이 없었습니다";
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
	/** Dispatches whose evaluation was already reported: one attempt is reported once, however many ways it arrives. */
	noticed: Set<string>;
	/** How many deliveries of each worker reached the collector as ones no declared result waits for (see `noteUnplannedDelivery`). */
	deliveries: Map<string, number>;
	/**
	 * How many turns Storm's own work messages woke for each worker (see `noteWakingFollowUp`): each of them delivers once, so
	 * each is a delivery Storm asked for. A message omp folded into a turn that was already open wakes none. Memory only.
	 */
	wakes: Map<string, number>;
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
	/**
	 * The director committed one of its own path edits in this run (R10's gate input): a run with one is never
	 * "quick-only". Memory only, never a record field; the extension raises it through `noteDirectorEdit`.
	 */
	directorEdit?: boolean;
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
	 * `undefined` when the run ends. A failing hook never breaks the run.
	 */
	live?(ctx: ExtensionContext, run: RunRecord | undefined): void;
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
}

/**
 * Which door a start came through. Only the manual one waits for a handoff; the other three open inside a turn that is
 * already running. `planless` is R9's explicit start mode: it is not `#start` with no plan, which is the manual branch.
 */
type StartMode =
	| { kind: "manual" }
	| { kind: "plan"; plan: RunPlan; configHash?: string; turnStartedAt?: number }
	| { kind: "continue"; said: string | undefined; turnStartedAt: number }
	| { kind: "planless"; turnStartedAt: number; deadline: number; lease: "read" | "write" };

export class RunController {
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
	async startWithPlan(ctx: ExtensionContext, spec: RunSpec, plan: RunPlan, configHash?: string, turnStartedAt?: number): Promise<RunRequestResult> {
		return this.#start(ctx, spec, newRunId(this.deps.now()), {
			kind: "plan",
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
	async continueInTurn(ctx: ExtensionContext, said: string | undefined, turnStartedAt: number): Promise<RunStartResult> {
		return this.#start(ctx, { task: "" }, newRunId(this.deps.now()), { kind: "continue", said, turnStartedAt });
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
		const gone = (): Refusal => refuse("세션이 바뀌어 Storm 실행을 시작하지 않았습니다.");
		const state = await this.deps.loadState(ctx);
		if (this.#generation !== generation) return gone();
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
		if (continuing !== undefined) {
			// The candidate is the menu's own: the newest trusted unfinished run of this session and target.
			const candidate = await findResumeCandidate(sessionDir, target).catch(() => undefined);
			if (this.#generation !== generation) return gone();
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
			const built = resumeSpec(candidate, continuing.said);
			if (!built.ok) return refuse(built.error);
			requested = built.spec;
		}
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
			return refuse(`실행 잠금을 확인하지 못해 시작하지 않았습니다: ${errorText(error)}`);
		}
		if (stale()) {
			if (acquired.ok) await this.#releaseLease(acquired.lease, ctx);
			return gone();
		}
		if (!acquired.ok) return refuse(acquired.reason);
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
			if (restoredPlan !== undefined && planNeedsWrite(restoredPlan)) {
				const upgraded = await lease.upgrade({ scope: { kind: "unbounded" } });
				if (!upgraded.ok) return refuse(upgraded.reason);
				if (stale()) return gone();
			}
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
				lanes: new RunLanes(runId, () => hostJobRows(ctx), continued !== undefined),
				attempts: new Map(),
				attemptSerial: 0,
				planRevision: 0,
				retryAcks: new Set(),
				laneAttempt: new Map(),
				settled: new Map(),
				settledEpoch: new Map(),
				notices: [],
				noticed: new Set(),
				deliveries: new Map(),
				wakes: new Map(),
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
					const history = earlier === undefined ? undefined : closeoutHandoff(earlier);
					handoff = buildHandoff({ runId, config, hash, task, ...(roundLimit === undefined ? {} : { maxRounds: roundLimit }),
						...(resume === undefined ? {} : { resume: { ...resume, ...(checkpoint === undefined ? {} : { checkpoint }) } }),
						...(history === undefined || history === "" ? {} : { history: { text: history, ...(followUp !== undefined ? { followUp: true } : {}) } }) });
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
					...artifactsOf(ctx),
					...(own.base !== undefined ? { base: own.base } : {}),
					...(config.budget ? { budget: config.budget } : {}),
					onThreshold: (kind, run) => this.#threshold(ctx, kind, run),
				});
				// Bound before anything below awaits: a spawn decided the moment this returns must see the first plan.
				if (plan !== undefined) setLedgerPlan(runId, plan);
				spawnsByRun.set(runId, []);
				lastSpawnByKey.set(runId, new Map());
				deliveryKindsByRun.set(runId, new Map());
				noticeSinks.set(runId, text => {
					if (this.#own === own) own.notices.push(text);
				});
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
				// A run that continues another is recorded as its successor here, and only this entry stops the next
				// continuation from taking the same parent again. Without it the lineage forks (two runs claim one parent, the
				// spend and accepted results of this one fall out of the goal), so a continued run that cannot be recorded
				// does not go on. A fresh run only loses its own resumability, which was always best effort.
				const pointed = await noteResumePointer(own.sessionDir, target, record).then(() => true, () => false);
				if (!pointed && record.resumeOf !== undefined) {
					await this.#stop(own, "start-failed", ctx).catch(() => undefined);
					return refuse(RESUME_POINTER_FAILED);
				}
				if (stale() || this.#own !== own) {
					await this.#stop(own, "start-failed", ctx).catch(() => undefined);
					return gone();
				}
				// R9's deadline: the host has blocked this `tool_call` handler after its budget and ignores what this
				// continuation does. A run opened now can never place the batch, so it is finished at once as stopped
				// instead of holding the lease with no work. The caller is refused with the real cause.
				if (planless !== undefined && this.deps.now() >= planless.deadline) {
					await this.#stop(own, "start-failed", ctx).catch(() => undefined);
					return refuse(PLANLESS_DEADLINE);
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
			if (continuing !== undefined && continued !== undefined) {
				if (handoffContinuation) {
					// A handoff: the old run's request opens the new run, nothing of its plan or rows is applied.
					return {
						ok: true,
						runId,
						continued: { mode: "handoff", from: continued.runId, ended: stopWords(continued.endReason), kept: 0, reopened: 0, blocked: 0, open: [] },
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
		// Plan mode holds the session to planning. The automatic start already refuses in it; a hand start follows suit.
		if (state.plan.status === "active") return refuse(PLAN_MODE_START_REFUSAL);
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
						// Row 5: an isolated producer's result has no integrated location in this version. The reason is
						// carried beside the result so the prerequisite refusal says why the condition cannot be met.
						if (isolated && !integrated && result.kind !== "answer") retainedReason = ISOLATED_INTEGRATED_REASON;
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
		// Row 2: an isolated change has no parent-tree location this version can judge. Even when someone else wrote
		// the declared bytes, they are not this attempt's work (ISO P7-B); a restored or review-accepted row is reopened.
		if (isolated === true && result.kind === "change") return { ok: false, reason: ISOLATED_CHANGE_REASON };
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
		if (row.origin === "review") return { ok: true, integrated: false };
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
		if (own === undefined || own.record.runId !== input.runId) return;
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
		if (own === undefined || own.record.runId !== input.runId) return;
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
	 * A work message of the director started a turn of this worker (the receipt says `woken` or `revived`, or the worker was
	 * idle when it went out): the delivery that turn makes is one Storm asked for. A message omp folded into the open turn
	 * is not counted, or each one would hide a delivery that someone else's wake made (R-final N9).
	 */
	noteWakingFollowUp(runId: string, agentId: string): void {
		const own = this.#own;
		if (own === undefined || own.record.runId !== runId) return;
		own.wakes.set(agentId, (own.wakes.get(agentId) ?? 0) + 1);
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
			const seen = (own.deliveries.get(input.agent) ?? 0) + 1;
			own.deliveries.set(input.agent, seen);
			const placed = deliveryKindsByRun.get(input.runId)?.get(input.agent);
			if (placed !== undefined && seen <= 1 + (own.wakes.get(input.agent) ?? 0)) {
				if (placed !== "unplanned") return;
				expected = true;
			}
		}
		const agent = this.deps.agents?.(own.record.runId, own.sessionDir).find(entry => entry.id === input.agent);
		const changed =
			agent === undefined || input.startedAt === undefined
				? undefined
				: agent.lastChangeAt !== undefined && agent.lastChangeAt >= input.startedAt;
		const entry: UnplannedDelivery = {
			id: input.id,
			kind: input.kind,
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
	 * The notices queued since the last call, as one bounded text for the director's next request, or nothing. Taking
	 * them empties the queue, so a notice is read once however it is delivered.
	 */
	takeNotices(): string | undefined {
		const own = this.#own;
		if (own === undefined || own.notices.length === 0) return undefined;
		const taken = own.notices.splice(0, own.notices.length);
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

	/** Evaluates one settled attempt against its stored before state and writes the run-scoped rows. */
	async #evaluateAttempt(own: OwnRun, settled: SettledAttempt): Promise<void> {
		const prepared = settled.prepared;
		const checkNames = prepared.results.filter(result => result.check !== undefined).map(result => result.id);
		const checks = checkNames.length === 0 ? undefined : await this.#approvedCheckEvidence(own);
		const deferred = new Set(checkNames.length > 0 && checks === undefined ? checkNames : []);
		// An isolated change is judged on the retained candidate, never on the parent tree in this version: it never
		// becomes accepted or reviewable, and a declared check cannot turn it into a deferred review.
		if (prepared.isolated === true) {
			for (const result of prepared.results) if (result.kind === "change") deferred.delete(result.id);
		}
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
				delete row.proof;
				delete row.restoredFrom;
			}
			this.#invalidateConsumers(own);
			return;
		}
		const items = isolatedChangeItems(evaluation.report.results, prepared.isolated === true);
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
			// Row 2: an isolated change never becomes review-accepted on parent-tree bytes, including an older record's
			// reviewable row; no check or review refresh may credit it.
			if ((planned ?? row.contract)?.kind === "change" && this.#rowIsolated(own, row)) continue;
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
		noteRunEnd(own.sessionDir, own.root, this.deps.now());
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
		const ledger = endLedgerRun(own.record.runId);
		// What each row held before finalization touched it: a held result this step reopens is marked revoked. The
		// marker classifies the closeout only; it is never evidence and is never carried into a continuation.
		const held = new Map(this.#heldStates(own));
		// A row the drain recheck already reopened keeps the state it held before that recheck.
		for (const [row, state] of heldBefore ?? []) if (held.has(row)) held.set(row, state);
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
			const brief = closeoutBrief(record, { resumable });
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
			// The figure is the spend Storm has seen: no new spawn and no work message to an idle worker from here, and with `stop` the director's turn is aborted,
			// but what workers already run still finishes (and its spend lands after this notice).
			`Storm 실행 예산(${formatUsd(budget?.perRunUsd ?? 0)})에 관측된 지출이 닿았습니다(누계 ${formatUsd(run.costUsd)}). 새 스폰과 쉬는 워커에게 보내는 일 메시지를 막습니다(진행 메모는 보낼 수 있습니다).${stop ? " 감독의 응답을 중단합니다." : ""} 이미 도는 워커는 끝까지 진행하며, 그 지출은 이후에 더해집니다.`,
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
