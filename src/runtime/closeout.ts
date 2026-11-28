/**
 * A settled run's closeout: the code-built brief every surface reads, the director's bounded draft, the bounded
 * historical handoff a later run or compaction may carry, and the one-shot numbered choice of a shown card.
 *
 * Official facts come only from the run record: status, end reason, result rows and the snapshot of facts taken at
 * finish (`closeoutFacts`). The director's draft is presentation data; it never changes a count, a state or a tier.
 * Drafts are validated before they are staged, so a malformed or multi-line value can never forge card lines or
 * choices, and the choice state is keyed by the public session id so a selection made in another session can never
 * resolve this session's card.
 */
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	AgentEntry,
	CloseoutAction,
	CloseoutBrief,
	CloseoutFacts,
	InfoTone,
	LaneResultKind,
	RunRecord,
	RunResult,
	WorkerStopReason,
} from "../types.ts";
import { MAX_RESULT_ID } from "../plan/validate.ts";
import type { CandidateProjection } from "./integration-controller-port.ts";
import { formatUsd } from "../policy/spawn.ts";
import { workerStopNotice } from "../policy/thread.ts";
import type { ResultRow } from "../view/results.ts";
import { CHECKOUT_CLEANUP_NOTE, CHECKOUT_PLACEMENT_NOTE, PLANLESS_PLACEMENT_NOTE } from "./contract-text.ts";
import { goalTotals } from "./goal.ts";
import { integrationHandoffLine, integrationHasObservations, OUT_OF_PLAN_LABEL, resultFacts, workerCountText, type CaptureUnknown, type IntegrationFacts, type ResultFacts, type RetainedFacts, type StormStopFact, type StormStopFacts } from "./result-facts.ts";
import { HANDOFF_RESUME_LABEL } from "./resume.ts";
import { endLabel, NO_PARENT_CHANGE_HANDOFF, STATUS_LABEL } from "./rounds.ts";
import { handoffOutcomes, outOfPlanLine, spendText, unplannedLine, unplannedSplit, userDirectedLine } from "./unplanned.ts";

/** Verification is detail, kept for status; it is never repeated on the card. */
export const CLOSEOUT_TEXT_MAX = 400;
/** Result and remaining are the only director prose a card carries. */
export const CLOSEOUT_RESULT_MAX = 240;
/** One direction's task or user text. */
export const CLOSEOUT_NEXT_MAX = 160;
/** Why a run direction is suggested. */
export const CLOSEOUT_WHY_MAX = 120;
/** At most this many directions; zero is valid. */
export const CLOSEOUT_NEXT_COUNT = 3;
/** A clean run shorter than this leaves one line; at or past it, a durable card. */
export const CLOSEOUT_CARD_MINUTES = 10;
/** The historical handoff is model context: bounded in UTF-8 bytes. */
export const CLOSEOUT_HANDOFF_MAX_BYTES = 1024;

/** Records written before typed directions kept these bounds; they are still read, never re-submitted. */
const LEGACY_TEXT_MAX = 400;
const LEGACY_NEXT_MAX = 240;
const RESIDUAL_MAX = 3;
const USER_ACTION_MAX = 2;
const REQUEST_MAX = 120;
const TARGET_MAX = 60;
const NAME_MAX = 40;
const PROOF_MAX = 120;

/** One direction the director suggests. Only `resume` and `run` can ever become a numbered action. */
export type CloseoutNext =
	| { readonly kind: "resume" }
	| { readonly kind: "run"; readonly task: string; readonly why?: string }
	| { readonly kind: "user"; readonly text: string };

/** The staged summary of one settled run, as the director submitted it. */
export interface CloseoutDraft {
	result: string;
	verification: string;
	remaining?: string;
	/** 0–3 distinct directions, best first. */
	next: readonly CloseoutNext[];
}

/** The title of the one transcript record a settled run leaves. */
export const CLOSEOUT_TITLE = "Storm 실행 결과";

// Control characters would either break the card into arbitrary lines or hide content; line separators count too.
const UNSAFE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const UNSAFE_ALL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

function line(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text === "" || text.length > max || UNSAFE.test(text)) return undefined;
	return text;
}

interface Bounds {
	result: number;
	verification: number;
	next: number;
}
const SUBMITTED: Bounds = { result: CLOSEOUT_RESULT_MAX, verification: CLOSEOUT_TEXT_MAX, next: CLOSEOUT_NEXT_MAX };
const STORED: Bounds = { result: LEGACY_TEXT_MAX, verification: LEGACY_TEXT_MAX, next: LEGACY_NEXT_MAX };

const NEXT_FIELDS: Readonly<Record<CloseoutNext["kind"], readonly string[]>> = {
	resume: [],
	run: ["task", "why"],
	user: ["text"],
};

function nextItem(value: unknown, bounds: Bounds, legacy: boolean): CloseoutNext | undefined {
	// Records written before typed directions held three plain strings: each was a new Storm task.
	if (typeof value === "string") {
		if (!legacy) return undefined;
		const task = line(value, bounds.next);
		return task === undefined ? undefined : { kind: "run", task };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const item = value as Record<string, unknown>;
	const kind = item.kind;
	if (kind !== "resume" && kind !== "run" && kind !== "user") return undefined;
	const allowed = NEXT_FIELDS[kind];
	// A field of another kind is a malformed direction, not one to reinterpret.
	for (const [key, field] of Object.entries(item)) {
		if (key !== "kind" && field !== undefined && !allowed.includes(key)) return undefined;
	}
	if (kind === "resume") return { kind };
	if (kind === "user") {
		const text = line(item.text, bounds.next);
		return text === undefined ? undefined : { kind, text };
	}
	const task = line(item.task, bounds.next);
	if (task === undefined) return undefined;
	if (item.why === undefined) return { kind, task };
	const why = line(item.why, CLOSEOUT_WHY_MAX);
	return why === undefined ? undefined : { kind, task, why };
}

const sameText = (text: string): string => text.toLocaleLowerCase().replace(/\s+/g, " ");

function parseDraft(value: unknown, bounds: Bounds, legacy: boolean): CloseoutDraft | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const result = line(input.result, bounds.result);
	const verification = line(input.verification, bounds.verification);
	if (result === undefined || verification === undefined) return undefined;
	let remaining: string | undefined;
	if (input.remaining !== undefined) {
		remaining = line(input.remaining, bounds.result);
		if (remaining === undefined) return undefined;
	}
	const raw = input.next === undefined ? [] : input.next;
	if (!Array.isArray(raw) || raw.length > CLOSEOUT_NEXT_COUNT) return undefined;
	const next: CloseoutNext[] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		const item = nextItem(value, bounds, legacy);
		if (item === undefined) return undefined;
		const key = item.kind === "resume" ? "\u0000resume" : sameText(item.kind === "run" ? item.task : item.text);
		if (seen.has(key)) return undefined;
		seen.add(key);
		next.push(item);
	}
	return { result, verification, ...(remaining !== undefined ? { remaining } : {}), next };
}

/**
 * `parseCloseout` accepts only a complete, single-line draft with 0–3 distinct typed directions. It never fills a
 * missing field: no draft is the same as no brief, never a synthetic one. Returns undefined for anything else.
 */
export function parseCloseout(value: unknown): CloseoutDraft | undefined {
	return parseDraft(value, SUBMITTED, false);
}

/**
 * The draft a stored record carries, read as untrusted input. A record written before typed directions keeps its
 * plain-string directions as new-run tasks and its earlier length bounds; anything malformed is no draft at all.
 */
export function storedCloseout(value: unknown): CloseoutDraft | undefined {
	return parseDraft(value, STORED, true);
}

/** Presentation-safe local text: one line, bounded by code points, no control or bidi characters. */
function clean(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(UNSAFE_ALL, " ").replace(/\s+/g, " ").trim();
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

/** A target's display name: its last path component only, never a path. */
export function closeoutTargetName(root: string): string {
	return clean(path.basename(root), TARGET_MAX);
}

/** The facts a record stored at finish, read as untrusted input. */
function storedFacts(value: unknown): CloseoutFacts | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const names = (list: unknown): string[] =>
		Array.isArray(list) ? [...new Set(list.map(item => clean(item, NAME_MAX)).filter(item => item !== ""))].slice(0, 50) : [];
	// A stored target is a display name; anything path-like is dropped rather than shown.
	const target = clean(input.target, TARGET_MAX);
	return {
		target: /[\\/]/.test(target) ? "" : target,
		pendingLanes: names(input.pendingLanes),
		requiredChecks: names(input.requiredChecks),
	};
}

/** The media a declared result was planned in: the row's bounded contract first, then the plan in force. */
function plannedKind(run: RunRecord, result: RunResult): LaneResultKind | undefined {
	if (result.contract !== undefined) return result.contract.kind;
	for (const lane of run.plan?.lanes ?? []) {
		const planned = (lane.results ?? []).find(item => item.id === result.id);
		if (planned !== undefined) return planned.kind;
	}
	return undefined;
}

/** An accepted answer or retained artifact is the run's output; a change still belongs to the review path. */
function acceptedOutput(run: RunRecord, result: RunResult): boolean {
	if (result.state !== "accepted") return false;
	const kind = plannedKind(run, result);
	return kind === "answer" || kind === "artifact";
}

/**
 * The verified reason normally names a code review. A run settled only by accepted answers/artifacts must not claim a
 * review it never had; the official status is still done, and the per-result rows carry the actual evidence. A run
 * with no declared result row says that too: its review verified changes, not a result count.
 */
export const NO_RESULTS_VERDICT = "리뷰 통과(결과 집계 없음)";
/**
 * Row 1: when every accepted result is a retained artifact, the run met its artifact requirements outside the parent
 * tree. The words say only what Storm did with them: it applied nothing. They never claim the tree did not change,
 * because a worker or the director may have changed it (B7). The tone is accent, so no tick is drawn.
 */
export const RETAINED_ONLY_VERDICT = "부모 밖 보존 산출물 충족 · Storm이 대상에 적용한 것 없음";
/** Every declared row is out of the user's scope: there is no fraction and no success to show. */
export const ALL_EXCLUDED_VERDICT = "결과 전부 사용자 제외";
/** Row 2: a recorded stop is a separate fact from the final result evidence, and the card says so. */
export const STOP_SEPARATE_NOTE = "실행 종료 사유는 결과 판정과 별개로 기록되었습니다";
/**
 * §5: a tree-write risk is stated only for a worker whose own accepted parent-tree result places its writes in the
 * shared tree. A worker's change counter alone proves no location.
 */
export const SHARED_CHANGE_RISK = "검증되지 않은 변경이 공유 작업 트리에 남아 있을 수 있습니다";
/** The same risk when the record does not establish where the changed worker wrote. */
export const UNKNOWN_CHANGE_RISK = "작업 위치를 기록으로 확인하지 못했습니다";
/** A stopped or failed worker's retained patch or branch is not bound to this record; the native record is the pointer. */
export const CAPTURE_UNKNOWN_LABEL = "보존 캡처 미상";
/** The same fact in the English handoff. */
export const CAPTURE_UNKNOWN_HANDOFF = "capture unknown";
/** The head of the one line that names what Storm did to a stopped worker, never the host's failure text (fault 2). */
export const STORM_STOP_LABEL = "Storm이 중단한 워커";
/** The short cause word the status and the card use; the full sentence is `stormStopLine`. */
export const WORKER_STOP_LABEL: Readonly<Record<WorkerStopReason, string>> = {
	"pooled-thread": "omp가 풀 스레드에 배치",
	"state-not-shared": "실행 상태를 공유하지 않음",
};
/** The same fact in the English handoff: the host failure text is not the cause. */
export const STORM_STOP_HANDOFF = "Storm stopped these workers; the host failure text is not the cause";

/**
 * The real sentence a stopped worker's own admission carries, for one cause, with the count before it. The sentence is
 * the contract (`policy/thread.ts`), so it is quoted, never paraphrased; one line per cause keeps the size fixed at
 * any team size. The first native handle is the worker the sentence names; the rest share its cause.
 */
export function stormStopLine(stop: StormStopFact): string {
	return `${STORM_STOP_LABEL} ${stop.count}개 — ${workerStopNotice(stop.first ?? "이번 실행의", stop.reason)}`;
}

/**
 * The bounded notice the director reads with the results: the largest stop cause in full, and only a count for the
 * others. Two causes at most, so this never grows with the number of workers.
 */
export function stormStopNotice(stops: StormStopFacts): string {
	const [main, ...rest] = stops.reasons;
	if (main === undefined) return "";
	const other = rest.reduce((sum, stop) => sum + stop.count, 0);
	return `[storm] ${stormStopLine(main)}${other > 0 ? ` 그 밖에 ${other}개도 Storm이 중단했습니다.` : ""}`;
}

/** Row 1/§5 in the handoff: the judged source is outside the parent, and what that does not prove. */
export const RETAINED_OUTSIDE_HANDOFF = "judged outside the parent tree";
/** The same count word for the handoff's result line, so a kept-only run never reads as tree work there either. */
export const RETAINED_OUTSIDE_COUNT = "retained outside the parent";
export const RETAINED_ABSENCE_HANDOFF = "that proves neither their bytes absent from the parent nor an unchanged tree";
/** A delivery's change flag is a worker record, not a scan of the parent tree. */
export const HANDOFF_CHANGE_RECORD_NOTE = "file-change records, not parent-tree proof";

function runReasonLabel(run: RunRecord, facts: ResultFacts): string {
	const reason = run.endReason;
	if (reason === undefined) return "";
	if (reason !== "verified") return endLabel(reason);
	if (!facts.hasDeclared) return NO_RESULTS_VERDICT;
	if (facts.allExcluded) return ALL_EXCLUDED_VERDICT;
	// All accepted evidence is kept outside the target: the verdict says that instead of "required results met", which
	// reads as if the tree held the candidates.
	if (facts.retained.count > 0 && facts.retained.count === facts.progress.counts.accepted) return RETAINED_ONLY_VERDICT;
	const results = run.results ?? [];
	const reviewed = (run.agents ?? []).some(agent => (agent.review?.passed ?? 0) > 0);
	const changed = (run.agents ?? []).some(agent => (agent.changes ?? 0) > 0);
	if (reviewed || changed || results.length === 0 || !results.every(result => acceptedOutput(run, result))) return endLabel(reason);
	return "필수 결과 이행";
}

function statusLine(run: RunRecord, card: boolean, facts: ResultFacts): string {
	const status = STATUS_LABEL[run.status] ?? clean(run.status, NAME_MAX);
	const label = clean(runReasonLabel(run, facts), NAME_MAX);
	const reason = label === "" ? "" : ` · ${label}`;
	const rounds =
		typeof run.turns !== "number"
			? ""
			: typeof run.maxRounds === "number"
				? ` · ${run.turns}/${run.maxRounds}라운드`
				: ` · ${run.turns}라운드`;
	// What the run spent in all, with a floor marked as one. A run that spent nothing says nothing. The one-row record of a
	// short clean run carries the figure only when it is a floor (a bare number there would read as exact): with it that row is
	// 68 columns wide and wraps on a 60 column terminal, which the TUI scenario "a short clean automatic run" pins. The card
	// has room, and `/storm status` always has the figure.
	const spent = Number.isFinite(run.costUsd) && run.costUsd > 0;
	const spend = spent && (card || run.spend?.lowerBound === true) ? ` · 비용 ${spendText(run)}` : "";
	// A run with no declared rows states the work it did instead of a result fraction it does not have.
	const workers = !facts.hasDeclared && facts.activity.placed > 0 ? ` · ${workerCountText(facts.activity)}` : "";
	const mixed = facts.outOfPlan > 0 ? ` · ${OUT_OF_PLAN_LABEL} ${facts.outOfPlan}` : "";
	return `${status}${reason}${rounds}${spend}${workers}${mixed}`;
}

type OpenKind = keyof CloseoutBrief["official"]["open"];

/**
 * Why an in-scope row is still open, exactly one cause each: finalization closed its attempt before a judgment, or
 * revoked evidence it had; a known structured block; an exhausted host retry; a submission awaiting judgment; no
 * judgment recorded yet; or judged and not met. The finalization marker classifies; it is never evidence.
 */
function openKind(row: ResultRow, finalized: RunResult["finalized"] | undefined): OpenKind {
	if (finalized === "unsettled") return "unsettled";
	if (finalized === "revoked") return "revoked";
	if (row.remedy === "blocked") return "blocked";
	if (row.remedy === "retry") return "retry";
	if (row.state === "reviewable") return "reviewable";
	if (row.state === "pending") return "pending";
	return "unmet";
}

/** The first stored row per id, as the projection dedupes them; only a known finalization marker is read. */
function finalizedById(run: RunRecord): Map<string, RunResult["finalized"]> {
	const out = new Map<string, RunResult["finalized"]>();
	for (const value of Array.isArray(run.results) ? run.results : []) {
		if (typeof value !== "object" || value === null || typeof value.id !== "string") continue;
		const id = clean(value.id, MAX_RESULT_ID);
		if (out.has(id)) continue;
		const marker = value.finalized;
		out.set(id, marker === "unsettled" || marker === "revoked" ? marker : undefined);
	}
	return out;
}

function namesText(names: readonly string[], shown = 2): string {
	const head = names.slice(0, shown).join(", ");
	return names.length > shown ? `${head} 외 ${names.length - shown}개` : head;
}

/**
 * Risks the record itself supports, never an inference about external state: writes positively placed in the shared tree
 * that no verification covered, host jobs whose end was never observed, planned lanes no open row already names, and a
 * budget stop. A worker's own change counter is not a tree claim: a plan-less placement, a team-isolated run and a
 * worker without a bound parent-tree result are reported as unknown instead (Run P §§4, 7).
 */
function residualOf(run: RunRecord, facts: CloseoutFacts | undefined, openLanes: ReadonlySet<string>, result: ResultFacts): string[] {
	const out: string[] = [];
	const retained = result.retained;
	// §5/rows 9 and 11: an isolated run's closeout carries what a checkout is and is not, and that its cleanup is not
	// Storm's claim. A plan-less placement may have been isolated without a stored fact, so it carries the same
	// qualification. Fixed size, one line, whether one lane or a hundred.
	const isolatedLanes = (Array.isArray(run.plan?.lanes) ? run.plan.lanes : []).filter(
		lane => typeof lane.isolationReason === "string" && lane.isolationReason.trim() !== "",
	).length;
	const planless = result.activity.unplannedPlaced;
	if (retained.count > 0 || isolatedLanes > 0 || planless > 0) {
		const planlessNote = planless > 0 ? ` ${PLANLESS_PLACEMENT_NOTE}` : "";
		out.push(`${CHECKOUT_PLACEMENT_NOTE}${planlessNote} ${CHECKOUT_CLEANUP_NOTE}`);
	}
	// Row 2 (P7-B): the record's stop and its final evidence are separate facts; the card must not imply one judged the other.
	if (run.status === "stopped" && (run.results ?? []).some(row => row.state === "accepted")) {
		out.push(`${STOP_SEPARATE_NOTE}.`);
	}
	// §5: only a positively attributed parent-tree write may be called a shared-tree change. Anything the record cannot
	// place says unknown and points at the native record; a private worker's changes are never a parent-tree warning.
	const changes = result.changes;
	if (run.endReason !== "verified" && changes.shared > 0) {
		const unknownPart = changes.unknown > 0 ? `, 작업 위치 미상 ${changes.unknown}개` : "";
		out.push(`${SHARED_CHANGE_RISK}(공유 트리에 쓴 워커 ${changes.shared}개${unknownPart}).`);
	} else if (run.endReason !== "verified" && changes.unknown > 0) {
		out.push(`변경을 기록한 워커 ${changes.unknown}개: ${UNKNOWN_CHANGE_RISK}. 부모 작업 트리 변경 여부는 알 수 없습니다. 네이티브 기록에서 확인하세요.`);
	}
	const jobs = (Array.isArray(run.jobs) ? run.jobs : []).filter(job => job?.status === "started" || job?.status === "unknown");
	if (jobs.length > 0) {
		const names = jobs.map(job => clean(job.name, NAME_MAX) || "(이름 없음)");
		out.push(`끝났는지 확인하지 못한 정형 작업 ${jobs.length}건: ${namesText(names)}(외부 상태는 확인하지 않았습니다).`);
	}
	const lanes = (facts?.pendingLanes ?? []).filter(name => !openLanes.has(name));
	if (lanes.length > 0) out.push(`끝내지 못한 레인 ${lanes.length}개: ${namesText(lanes)}.`);
	if (run.status === "budget-exceeded" || run.endReason === "budget") out.push("실행 예산 한도에서 끝났습니다.");
	return out.slice(0, RESIDUAL_MAX);
}

/** Ends that settle without anything left to judge; every other end leaves a durable card. */
const CLEAN_ENDS: Readonly<Record<string, true | undefined>> = { verified: true, "no-changes": true, unreviewed: true, "no-declared-results": true };
function minutesOf(run: RunRecord): number | undefined {
	const start = Date.parse(run.startedAt);
	const end = typeof run.endedAt === "string" ? Date.parse(run.endedAt) : Number.NaN;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
	return (end - start) / 60_000;
}

function toneOf(run: RunRecord, facts: ResultFacts, open: number, residual: number): InfoTone {
	if (run.status === "running") return "muted";
	if (run.status === "stopped" || run.status === "budget-exceeded") return "warning";
	if (open > 0) return "warning";
	// Row 1: kept artifacts are not verified tree work, so the card gets no success mark or tick. The checkout
	// qualification is a caveat, not an open risk, so it does not turn this into a warning.
	if (run.endReason === "verified" && facts.retained.count > 0 && facts.retained.count === facts.progress.counts.accepted) return "accent";
	if (residual > 0) return "warning";
	// A pass over changes is not a pass over declared results: no success mark when the record holds no result row.
	if (!facts.hasDeclared) return "accent";
	// All rows excluded: nothing was in scope, so nothing succeeded either.
	if (facts.allExcluded) return "accent";
	return run.status === "done" ? "success" : "accent";
}

/** The code-written resume label: what the existing resume path does, never a selective acceptance. */
function resumeLabel(facts: ResultFacts): string {
	if (!facts.hasDeclared || facts.allExcluded) return HANDOFF_RESUME_LABEL;
	return `이어 가기 — 수용 ${facts.progress.counts.accepted}건은 현재 증거로 다시 확인하고 나머지 ${facts.progress.counts.inScope - facts.progress.counts.accepted}건을 다시 엽니다`;
}

function runLabel(item: Extract<CloseoutNext, { kind: "run" }>): string {
	const task = clean(item.task, CLOSEOUT_NEXT_MAX);
	return item.why === undefined ? task : `${task} — ${clean(item.why, CLOSEOUT_WHY_MAX)}`;
}

export interface CloseoutRetainedBrief extends CloseoutBrief {
	/** Row 1: accepted retained artifacts kept outside the target, with one safe reference. */
	readonly retained?: RetainedFacts;
	/** Row 2: workers this run's own record says Storm stopped, by cause. Absent when Storm stopped none. */
	readonly stormStops?: StormStopFacts;
	/**
	 * Row 8/§5: a stopped or failed worker's retained patch or branch is not bound to this record. When no bound retained
	 * reference exists, the native delivery is the only pointer; the card says capture unknown rather than implying the
	 * worker left nothing.
	 */
	readonly captureUnknown?: CaptureUnknown;
	/** The owning run's integration queue, from C's one projection; absent when the caller read no journal. */
	readonly integration?: IntegrationFacts;
}

/**
 * The brief of a settled run, from its record alone. `resumable` is the caller's proof that this exact run is the
 * session's trusted resume candidate; without it no resume action is offered, whatever the draft says.
 *
 * - `none`: the record is not settled.
 * - `line`: a clean end (verified, no changes, or quick-only), nothing open or excluded, no residual, under ten
 *   minutes. One factual line; no prose, no menu.
 * - `card`: everything else. The director's result and remaining appear only here, marked stale when finalization
 *   changed a row after the draft could have been written.
 */
export function closeoutBrief(run: RunRecord, options: { resumable?: boolean; integration?: CandidateProjection } = {}): CloseoutRetainedBrief {
	const fact = resultFacts(run, options.integration === undefined ? {} : { integration: options.integration });
	const progress = fact.progress;
	const markers = finalizedById(run);
	const stored = storedFacts(run.closeoutFacts);
	const open: Record<OpenKind, number> = { unsettled: 0, revoked: 0, blocked: 0, retry: 0, reviewable: 0, pending: 0, unmet: 0 };
	const openLanes = new Set<string>();
	let stale = false;
	for (const row of progress.rows) {
		const marker = markers.get(row.id);
		if (marker !== undefined) stale = true;
		if (row.excluded || row.state === "accepted") continue;
		open[openKind(row, marker)]++;
		if (row.lane !== undefined) openLanes.add(row.lane);
	}
	const openTotal = Object.values(open).reduce((sum, n) => sum + n, 0);
	const residual = residualOf(run, stored, openLanes, fact);
	// Work that happened outside the declared results is a fact the card names, not a risk: it shapes neither the tier
	// nor the tone, and it takes a place on the card only from the lowest-ranked risk. Asked-for work and unsolicited
	// arrivals are two different facts and are never merged into one count (B8).
	const unplannedLines = [outOfPlanLine(run), unplannedLine(run), userDirectedLine(run)].filter((line): line is string => line !== undefined);
	const shownResidual = [...residual.slice(0, Math.max(0, RESIDUAL_MAX - unplannedLines.length)), ...unplannedLines];
	const minutes = minutesOf(run);
	const settled =
		run.status !== "budget-exceeded" &&
		run.endReason !== undefined &&
		CLEAN_ENDS[run.endReason] === true &&
		openTotal === 0 &&
		progress.counts.excluded === 0 &&
		// A retained acceptance must show its patch reference; a one-line closeout would hide where the bytes are.
		fact.retained.count === 0 &&
		// A stopped or failed worker's unbound capture is named on the card; a one-line closeout would hide it.
		fact.captureUnknown === undefined &&
		// The stop sentence and its count are named on the card; a one-line closeout would hide why workers ended.
		fact.stormStops === undefined &&
		// A recorded or unreadable integration state is named on the card; an older record or an empty queue is not.
		!integrationHasObservations(fact.integration) &&
		residual.length === 0;
	const tier: CloseoutBrief["tier"] =
		run.status === "running" ? "none" : settled && (minutes === undefined || minutes < CLOSEOUT_CARD_MINUTES) ? "line" : "card";
	const draft = storedCloseout(run.closeout);
	const delivered = progress.delivered;
	const proof =
		delivered?.source === undefined
			? undefined
			: clean(`${delivered.label}${delivered.labelIsId ? "" : ` [${delivered.id}]`} · ${delivered.source}`, PROOF_MAX);
	const card = tier === "card";
	const userActions: string[] = [];
	const actions: CloseoutAction[] = [];
	if (card) {
		const seen = new Set<string>();
		const addUser = (text: string): void => {
			const key = sameText(text);
			if (text === "" || seen.has(key) || userActions.length >= USER_ACTION_MAX) return;
			seen.add(key);
			userActions.push(text);
		};
		// A known blocker's condition is code-owned and comes before anything the director wrote.
		for (const row of progress.rows) {
			if (!row.excluded && row.state !== "accepted" && row.remedy === "blocked" && row.unblock !== undefined) addUser(row.unblock);
		}
		for (const item of draft?.next ?? []) if (item.kind === "user") addUser(clean(item.text, CLOSEOUT_NEXT_MAX));
		const resume: CloseoutAction | undefined =
			options.resumable === true ? { kind: "resume", label: resumeLabel(fact) } : undefined;
		let resumed = false;
		for (const item of draft?.next ?? []) {
			if (item.kind === "resume") {
				if (resume !== undefined && !resumed) {
					actions.push(resume);
					resumed = true;
				}
			} else if (item.kind === "run") {
				actions.push({ kind: "run", label: runLabel(item), task: item.task });
			}
		}
		if (resume !== undefined && !resumed && actions.length < CLOSEOUT_NEXT_COUNT) actions.push(resume);
	}
	const target = stored?.target;
	const goal = goalTotals(run, Date.now());
	return {
		runId: run.runId,
		tier,
		retained: fact.retained,
		...(fact.stormStops === undefined ? {} : { stormStops: fact.stormStops }),
		...(fact.captureUnknown === undefined ? {} : { captureUnknown: fact.captureUnknown }),
		...(fact.integration === undefined ? {} : { integration: fact.integration }),
		request: clean(run.task, REQUEST_MAX),
		...(target ? { target } : {}),
		startedAt: run.startedAt,
		...(typeof run.endedAt === "string" ? { endedAt: run.endedAt } : {}),
		official: {
			label: statusLine(run, tier === "card", fact),
			tone: toneOf(run, fact, openTotal, residual.length),
			hasResults: fact.hasDeclared,
			accepted: progress.counts.accepted,
			inScope: progress.counts.inScope,
			excluded: progress.counts.excluded,
			open,
		},
		residual: shownResidual,
		...(proof ? { proof } : {}),
		...(goal !== undefined ? { goal } : {}),
		...(card && draft !== undefined
			? {
					director: {
						result: clean(draft.result, CLOSEOUT_RESULT_MAX),
						...(draft.remaining !== undefined ? { remaining: clean(draft.remaining, CLOSEOUT_RESULT_MAX) } : {}),
						stale,
					},
				}
			: {}),
		userActions,
		actions: actions.slice(0, CLOSEOUT_NEXT_COUNT),
	};
}

// ── Historical handoff ───────────────────────────────────────────────────────────────────────────

/** A token that names an absolute or home-relative location; the handoff never carries one. */
const ABSOLUTE_TOKEN = /(^|[\s"'`(\[{=,;])(?:~[\\/]|[A-Za-z]:[\\/]|[\\/][^\s"'`()\[\]{},;\\/]+[\\/])[^\s"'`()\[\]{},;]*/g;

/** Model-context text: one line, bounded, no markup that could close a surrounding block, no absolute path. */
function scrub(value: unknown, max: number): string {
	const text = clean(value, 10_000)
		.replace(ABSOLUTE_TOKEN, (_match, lead: string) => `${lead}‹경로›`)
		.replace(/</g, "‹")
		.replace(/>/g, "›");
	return clean(text, max);
}

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

function clipBytes(text: string, max: number): string {
	if (bytesOf(text) <= max) return text;
	let out = "";
	let used = bytesOf("…");
	for (const point of Array.from(text)) {
		const size = bytesOf(point);
		if (used + size > max) break;
		out += point;
		used += size;
	}
	return `${out}…`;
}

const OPEN_WORDS: Readonly<Record<OpenKind, string>> = {
	unsettled: "closed before judgment",
	revoked: "evidence revoked at finish",
	blocked: "blocked",
	retry: "retry exhausted",
	reviewable: "awaiting review",
	pending: "pending",
	unmet: "unmet",
};

/**
 * The bounded final facts of a settled run, for model context: an explicit resume or a chosen follow-up handoff, a
 * compaction, or a status read. Deterministic and about 1 KiB. Data, not instructions: no absolute path, no raw log,
 * no markup. Official counts lead; the director's own words follow as unverified and, when finalization changed a row
 * after they were written, as superseded by those counts.
 */
export function closeoutHandoff(run: RunRecord, integration?: CandidateProjection): string {
	const brief = closeoutBrief(run, integration === undefined ? {} : { integration });
	const official = brief.official;
	const draft = storedCloseout(run.closeout);
	const runRef = /^run-[0-9A-Za-z-]+$/.test(run.runId) ? run.runId : "(unknown)";
	const minutes = minutesOf(run);
	const rounds = typeof run.turns === "number" ? `, ${run.turns}${typeof run.maxRounds === "number" ? `/${run.maxRounds}` : ""} rounds` : "";
	// §5: the stored code `no-changes` is not repeated as if nothing changed; the label names Storm's own before/after
	// read of the parent tree.
	const reason =
		typeof run.endReason !== "string"
			? ""
			: run.endReason === "no-changes"
				? ` (${NO_PARENT_CHANGE_HANDOFF})`
				: ` (${scrub(run.endReason, NAME_MAX)})`;
	const duration = minutes === undefined ? "" : `, ${Math.max(1, Math.round(minutes))} min`;
	const openParts = (Object.keys(OPEN_WORDS) as OpenKind[])
		.filter(kind => official.open[kind] > 0)
		.map(kind => `${OPEN_WORDS[kind]} ${official.open[kind]}`);
	const kept = brief.retained;
	// A kept-only run's count says where its source is; the retained line below adds what that does not prove.
	const keptAll = kept !== undefined && kept.count > 0 && kept.count === official.accepted;
	const acceptedCount = keptAll ? `${official.accepted}/${official.inScope} ${RETAINED_OUTSIDE_COUNT}` : `accepted ${official.accepted}/${official.inScope}`;
	const results =
		official.inScope > 0
			? `- Results: ${acceptedCount}${official.excluded > 0 ? `, excluded by user ${official.excluded}` : ""}${openParts.length > 0 ? `; open: ${openParts.join(", ")}` : ""}`
			: official.hasResults
				? `- Results: none in scope, excluded by user ${official.excluded}`
				: "- Results: none declared";
	// Row 1: retained artifact acceptance is not tree work. One bounded line names the count and the first safe patch
	// reference; the judged source is outside the parent, and that proves neither absence there nor an unchanged tree.
	const retainedLine =
		kept === undefined || kept.count === 0
			? undefined
			: `- Retained: ${kept.count} accepted artifact${kept.count === 1 ? "" : "s"} ${RETAINED_OUTSIDE_HANDOFF}${kept.capture === undefined ? "" : ` (${scrub(kept.capture, PROOF_MAX)}${kept.attempt === undefined ? "" : `, ${scrub(kept.attempt, NAME_MAX)}`})`}; Storm applied nothing to the target; ${RETAINED_ABSENCE_HANDOFF}`;
	// Row 8/§5: a stopped or failed worker's patch or branch is not bound to this record. The native delivery is named
	// instead of implying the worker left nothing or inventing a capture.
	const unknownCapture = brief.captureUnknown;
	const recoveryLine =
		unknownCapture === undefined
			? undefined
			: `- Recovery: ${CAPTURE_UNKNOWN_HANDOFF} for ${unknownCapture.count} stopped or failed worker${unknownCapture.count === 1 ? "" : "s"}; the record holds no bound patch or branch${unknownCapture.native === undefined ? "" : `, native delivery ${unknownCapture.native}`}`;
	// Row 2: a worker Storm stopped is not a host crash, even though the host's own result text says so. The cause and
	// count are stated; the run record's card carries the worker's full sentence.
	const stoppedLine =
		brief.stormStops === undefined
			? undefined
			: `- Storm stops: ${brief.stormStops.count} worker${brief.stormStops.count === 1 ? "" : "s"} (${brief.stormStops.reasons.map(stop => `${stop.reason} ${stop.count}`).join(", ")}); ${STORM_STOP_HANDOFF}`;
	// Work that answers no declared result is part of the record a handoff carries: who delivered, whether it changed
	// files and what it cost. Asked-for out-of-plan work is stated apart from arrivals nobody asked for (B8). The list
	// is bounded like every other handoff line.
	const deliveries = Array.isArray(run.unplanned) ? run.unplanned : [];
	const split = unplannedSplit(run);
	const total = split.outOfPlan + split.unasked;
	const shownDeliveries = deliveries.slice(0, 3).map(delivery => {
		// A worker's change flag records its own tool results; it is not a scan of the parent tree and is labelled so.
		const changed = delivery.changed === true ? "changed files" : delivery.changed === false ? "no file change recorded" : "file change unknown";
		const cost = typeof delivery.costUsd === "number" && Number.isFinite(delivery.costUsd) ? formatUsd(delivery.costUsd) : "cost unknown";
		return `${scrub(delivery.agent, NAME_MAX)} (${changed}, ${cost})`;
	});
	// Details are listed only when every delivery is of the same class; a mixed record gets the two counts and no
	// per-worker text, so the handoff stays bounded.
	const detailText = shownDeliveries.length === 0 ? "" : `: ${shownDeliveries.join("; ")}${total > shownDeliveries.length ? ` (+${total - shownDeliveries.length} not listed)` : ""}`;
	const recordNote = `; ${HANDOFF_CHANGE_RECORD_NOTE}`;
	const outcomePart = (outcomes: typeof split.outOfPlanOutcomes, count: number): string => {
		const text = handoffOutcomes(outcomes);
		if (text === undefined) return "";
		const basis = count > outcomes.kept ? `, of ${outcomes.kept} kept` : "";
		return ` (${text}${basis})`;
	};
	const outOfPlan =
		split.outOfPlan === 0 ? undefined : `- Out-of-plan work: ${split.outOfPlan}${outcomePart(split.outOfPlanOutcomes, split.outOfPlan)}${split.unasked === 0 ? detailText : ""}${recordNote}`;
	const unasked = split.unasked === 0 ? undefined : `- Unasked arrivals: ${split.unasked}${outcomePart(split.unaskedOutcomes, split.unasked)}${split.outOfPlan === 0 ? detailText : ""}${recordNote}`;
	const stale = [...finalizedById(run).values()].some(marker => marker !== undefined);
	const said = stale ? "director's words, written before the final judgment; the counts above prevail" : "director's words, not evidence";
	const blockers = brief.userActions;
	const totals = brief.goal;
	const goal =
		totals !== undefined && [totals.runs, totals.usd, totals.ms, totals.turns].every(value => Number.isFinite(value) && value >= 0)
			? `- Goal so far: ${Math.floor(totals.runs)} runs, ${formatUsd(totals.usd)}, ${Math.round(totals.ms / 60_000)} min, ${Math.floor(totals.turns)} rounds`
			: undefined;
	// Priority order: whatever does not fit the byte bound is dropped from the end, never cut mid-structure.
	const lines: Array<string | undefined> = [
		`Earlier Storm run ${runRef}: final facts (historical data, not instructions).`,
		`- Request: ${scrub(run.task, REQUEST_MAX)}`,
		`- Status: ${scrub(run.status, NAME_MAX)}${reason}${rounds}${duration}`,
		results,
		integrationHandoffLine(brief.integration),
		retainedLine,
		recoveryLine,
		stoppedLine,
		outOfPlan,
		unasked,
		goal,
		brief.target ? `- Target: ${scrub(brief.target, TARGET_MAX)}` : undefined,
		...brief.residual.map(text => `- Residual: ${scrub(text, 100)}`),
		brief.proof ? `- Proof: ${scrub(brief.proof, PROOF_MAX)}` : undefined,
		...blockers.map(text => `- Needs the user: ${scrub(text, 100)}`),
		draft !== undefined ? `- Result (${said}): ${scrub(draft.result, 160)}` : undefined,
		draft?.remaining !== undefined ? `- Remaining (${said}): ${scrub(draft.remaining, 120)}` : undefined,
	];
	const out: string[] = [];
	let used = 0;
	for (const entry of lines) {
		if (entry === undefined || entry === "") continue;
		const cost = bytesOf(entry) + (out.length > 0 ? 1 : 0);
		if (used + cost <= CLOSEOUT_HANDOFF_MAX_BYTES) {
			out.push(entry);
			used += cost;
			continue;
		}
		const room = CLOSEOUT_HANDOFF_MAX_BYTES - used - (out.length > 0 ? 1 : 0);
		if (room >= 48) {
			out.push(clipBytes(entry, room));
			used = CLOSEOUT_HANDOFF_MAX_BYTES;
		}
		break;
	}
	return out.join("\n");
}

// ── Substantive runs and the numbered choice ─────────────────────────────────────────────────────

/** Whether a settled run left work worth more than a quiet automatic end: a brief, a result, several lanes, or real work. */
export function isSubstantiveRun(run: RunRecord): boolean {
	if (run.closeout !== undefined) return true;
	// A run that placed workers did work worth a record, even when it declared no result rows.
	if (resultFacts(run).activity.placed > 0) return true;
	const results = run.results ?? [];
	// An open requirement is worth reporting even when its lane changed nothing and the run ended quietly (T01).
	if (results.some(result => result.state !== "accepted")) return true;
	// An accepted requirement is delivered output: one real investigation counts, a casual read with no result does not.
	if (results.some(result => result.state === "accepted")) return true;
	const agents = run.agents ?? [];
	const lanes = run.plan?.lanes ?? [];
	if (lanes.length > 1) return true;
	const meaningful = (agent: AgentEntry): boolean => (agent.changes ?? 0) > 0 || (agent.review?.reviews ?? 0) > 0;
	if (lanes.length === 1) {
		const kind = lanes[0]!.kind;
		if (kind === "explore") return false;
		if (kind === "code") return agents.some(meaningful) || (run.checks?.length ?? 0) > 0;
		// A run/build, design or review lane is meaningful once its worker actually did that work.
		return agents.some(agent => agent.requests > 0 || meaningful(agent));
	}
	// A manual run without a plan has only its own ledger to say whether it did more than a quick read.
	return (
		agents.some(meaningful) ||
		(run.checks?.length ?? 0) > 0 ||
		agents.some(agent => (agent.role === "reviewer" || agent.role === "architect") && agent.requests > 0)
	);
}

interface ShownCloseout {
	runId: string;
	actions: readonly CloseoutAction[];
}

/** The newest shown closeout per public session id; never keyed by cwd or a process-wide "current" run. */
const shownBySession = new Map<string, ShownCloseout>();

/** The public session identity a shown card is bound to; undefined when the host exposes none. */
export function closeoutSessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager?.getSessionId();
		return typeof id === "string" && id.trim() !== "" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Makes a shown card's numbered actions answerable in exactly the session that saw it. Returns false when there is
 * nothing to number or the host exposes no public session identity: the card is still useful, but a number from any
 * session must not be resolved as its choice. The caller registers only on an interactive host it actually drew on.
 */
export function rememberCloseoutReport(ctx: ExtensionContext, runId: string, actions: readonly CloseoutAction[]): boolean {
	const id = closeoutSessionId(ctx);
	if (id === undefined) return false;
	const valid = actions
		.slice(0, CLOSEOUT_NEXT_COUNT)
		.filter(action => action.kind === "resume" || (action.kind === "run" && typeof action.task === "string" && action.task !== ""));
	if (valid.length === 0) {
		shownBySession.delete(id);
		return false;
	}
	shownBySession.set(id, { runId, actions: valid.map(action => ({ ...action })) });
	return true;
}

/**
 * Resolves a freshly submitted number against the most recent same-session card, once. Any other input, any later
 * use, and every approach from another session consume or miss the choice instead of acting on it. Returning
 * undefined never means "choose nothing": the caller must continue with its normal input handling. A `resume` pick
 * still has to pass the caller's exact resume validation for `runId`; a `run` pick is a new task.
 */
export function takeCloseoutChoice(ctx: ExtensionContext, text: string): { runId: string; action: CloseoutAction } | undefined {
	const id = closeoutSessionId(ctx);
	if (id === undefined) return undefined;
	const pending = shownBySession.get(id);
	if (pending === undefined) return undefined;
	shownBySession.delete(id);
	const picked = text.trim();
	if (!/^[1-9]$/.test(picked)) return undefined;
	const action = pending.actions[Number(picked) - 1];
	return action === undefined ? undefined : { runId: pending.runId, action };
}

/** Drops pending choices at a session lifecycle boundary; without a usable identity, every session is cleared. */
export function resetCloseoutChoices(ctx?: ExtensionContext): void {
	const id = ctx === undefined ? undefined : closeoutSessionId(ctx);
	if (id === undefined) shownBySession.clear();
	else shownBySession.delete(id);
}
