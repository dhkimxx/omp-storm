/**
 * A run's closeout brief: the director's own last word on what it delivered, with the three next directions the user
 * may pick from the settled run's transcript card. Briefs are validated before they are staged so a malformed or
 * multi-line value can never forge card lines or choices, and the choice state is keyed by the public session id so a
 * selection made in another session can never resolve this session's card.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentEntry, LaneResultKind, RunJob, RunRecord, RunResult } from "../types.ts";
import { resultProgress, resultRowText, RESULT_LANE_MAX, type ResultRow } from "../view/results.ts";
import { endLabel, STATUS_LABEL } from "./rounds.ts";

/** Bounded fields: a brief is a card, not a report. */
export const CLOSEOUT_TEXT_MAX = 400;
export const CLOSEOUT_NEXT_MAX = 240;
/** How many required-result rows one card line names before the rest become a count. */
export const CLOSEOUT_RESULT_ENTRY_MAX = 3;
/** How many host job receipts one card line names before the rest become a count. */
export const CLOSEOUT_JOB_ENTRY_MAX = 3;
const JOB_NAME_MAX = 40;
const JOB_STATUS_MAX = 20;

/** The staged summary of one settled run, as the director submitted it. */
export interface CloseoutDraft {
	result: string;
	verification: string;
	remaining?: string;
	next: readonly [string, string, string];
}

/** The title of the one transcript record a settled substantive run leaves. */
export const CLOSEOUT_TITLE = "Storm 실행 결과";
/** Shown only where a typed choice can actually be taken; never as a false affordance on other hosts. */
export const CLOSEOUT_CHOICE_HINT = "1~3 또는 원하는 방향을 입력하세요";

// Control characters would either break the card into arbitrary lines or hide content; line separators count too.
const UNSAFE = /[\u0000-\u001f\u007f\u2028\u2029]/;
const UNSAFE_ALL = /[\u0000-\u001f\u007f\u2028\u2029]/g;

function line(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text === "" || text.length > max || UNSAFE.test(text)) return undefined;
	return text;
}

/**
 * `parseCloseout` accepts only a complete, single-line brief with three distinct directions. It never fills a missing
 * field: no draft is the same as no verified brief, never a synthetic one. Returns undefined for anything else.
 */
export function parseCloseout(value: unknown): CloseoutDraft | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const result = line(input.result, CLOSEOUT_TEXT_MAX);
	const verification = line(input.verification, CLOSEOUT_TEXT_MAX);
	if (result === undefined || verification === undefined) return undefined;
	let remaining: string | undefined;
	if (input.remaining !== undefined) {
		remaining = line(input.remaining, CLOSEOUT_TEXT_MAX);
		if (remaining === undefined) return undefined;
	}
	const raw = input.next;
	if (!Array.isArray(raw) || raw.length !== 3) return undefined;
	const next = raw.map(item => line(item, CLOSEOUT_NEXT_MAX));
	if (next.some(item => item === undefined)) return undefined;
	const options = next as [string, string, string];
	if (new Set(options.map(item => item.toLocaleLowerCase().replace(/\s+/g, " "))).size !== options.length) return undefined;
	return { result, verification, ...(remaining !== undefined ? { remaining } : {}), next: options };
}

/** Presentation-safe local text: one line, bounded, no control characters. */
function clean(value: string, max: number): string {
	const text = value.replace(UNSAFE_ALL, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
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
 * review it never had; the official status is still done, and the per-result rows carry the actual evidence.
 */
function runReasonLabel(run: RunRecord): string {
	const reason = run.endReason;
	if (reason === undefined) return "";
	if (reason !== "verified") return endLabel(reason);
	const results = run.results ?? [];
	const reviewed = (run.agents ?? []).some(agent => (agent.review?.passed ?? 0) > 0);
	const changed = (run.agents ?? []).some(agent => (agent.changes ?? 0) > 0);
	if (reviewed || changed || results.length === 0 || !results.every(result => acceptedOutput(run, result))) return endLabel(reason);
	return "필수 결과 이행";
}

function statusLine(run: RunRecord): string {
	const status = STATUS_LABEL[run.status] ?? run.status;
	const label = runReasonLabel(run);
	const reason = label === "" ? "" : ` · ${label}`;
	const rounds =
		run.turns === undefined ? "" : run.maxRounds !== undefined ? ` · ${run.turns}/${run.maxRounds}라운드` : ` · ${run.turns}라운드`;
	return `${status}${reason}${rounds}`;
}

function checksLine(run: RunRecord, required: readonly string[]): string | undefined {
	const evidence = new Map((run.checks ?? []).map(check => [check.name, check]));
	const names = [...new Set([...required, ...evidence.keys()])];
	if (names.length === 0) return undefined;
	const parts = names.map(name => {
		const check = evidence.get(name);
		if (check === undefined) return `${clean(name, 40)} 기록 없음`;
		const exit = check.exitCode !== null && check.exitCode !== undefined ? `(${check.exitCode})` : "";
		return `${clean(check.name, 40)} ${clean(check.status, 40)}${exit}`;
	});
	return `- 체크(공식): ${parts.join(" · ")}`;
}

function lanesLine(pending: readonly string[]): string | undefined {
	if (pending.length === 0) return undefined;
	return `- 미완료 레인: ${pending.map(name => clean(name, 40)).join(", ")}`;
}

/**
 * Host-observed named-job receipts: an exit status and code, never a conclusion. They follow the result rows because
 * an accepted result is the completion signal; a passing job by itself does not prove any requirement or claim.
 */
function jobsLine(jobs: readonly RunJob[] | undefined): string | undefined {
	if (jobs === undefined || jobs.length === 0) return undefined;
	const shown = jobs.slice(0, CLOSEOUT_JOB_ENTRY_MAX);
	const parts = shown.map(job => {
		const name = clean(job.name, JOB_NAME_MAX) || "(이름 없음)";
		const lane = clean(job.lane, RESULT_LANE_MAX);
		const where = lane === "" ? "" : ` [${lane}]`;
		const exit = typeof job.exitCode === "number" ? `(${job.exitCode})` : "";
		return `${name}${where} ${clean(job.status, JOB_STATUS_MAX)}${exit}`;
	});
	const omitted = jobs.length - shown.length;
	if (omitted > 0) parts.push(`외 ${omitted}건`);
	return `- 잡 영수증(호스트): ${parts.join(" · ")}`;
}

function resultLine(
	header: string,
	entries: readonly ResultRow[],
	shownLanes: Set<string>,
	includeState: boolean,
): string | undefined {
	if (entries.length === 0) return undefined;
	const shown = entries.slice(0, CLOSEOUT_RESULT_ENTRY_MAX);
	for (const result of shown) {
		if (result.lane !== undefined) shownLanes.add(result.lane);
	}
	const parts = shown.map(result => resultRowText(result, { includeState }));
	const omitted = entries.length - shown.length;
	if (omitted > 0) parts.push(`외 ${omitted}건`);
	return `${header}${parts.join(" · ")}`;
}

interface ResultBrief {
	lines: string[];
	/** Lanes already named on a result line: the pending-lane line must not repeat them. */
	lanes: ReadonlySet<string>;
}

/**
 * The official ledger's requirements by state, read from the shared result projection. Unmet/pending obligations keep
 * their criterion and runtime reason; reviewable submissions stay on their own line and are never called verified;
 * accepted outputs show their state and, when the host recorded one, a bounded attempt/source reference. An operator
 * excluded row is visibly listed last and never counted as an in-scope obligation. No row claims the run is done.
 */
function resultBrief(run: RunRecord): ResultBrief {
	const progress = resultProgress(run);
	const inScope = progress.rows.filter(row => !row.excluded);
	const unresolved = inScope.filter(row => row.state !== "accepted" && row.state !== "reviewable");
	const reviewable = inScope.filter(row => row.state === "reviewable");
	const accepted = inScope.filter(row => row.state === "accepted");
	const excluded = progress.rows.filter(row => row.excluded);
	const lanes = new Set<string>();
	const lines: string[] = [];
	const unmet = resultLine("- 미해결 필수 결과(공식): ", unresolved, lanes, true);
	if (unmet !== undefined) lines.push(unmet);
	const pending = resultLine("- 검토 가능 필수 결과(공식): ", reviewable, lanes, false);
	if (pending !== undefined) lines.push(pending);
	// Accepted and excluded lanes are not unfinished; a throwaway set keeps them from hiding a pending lane.
	const settled = resultLine("- 이행 필수 결과(공식): ", accepted, new Set<string>(), true);
	if (settled !== undefined) lines.push(settled);
	const scoped = resultLine("- 사용자 제외 필수 결과(공식): ", excluded, new Set<string>(), false);
	if (scoped !== undefined) lines.push(scoped);
	return { lines, lanes };
}

/** Three distinct conservative directions that never presume a resume or claim work Storm did not verify. */
function fallbackNext(run: RunRecord, pending: readonly string[]): readonly [string, string, string] {
	const label = runReasonLabel(run);
	const reason = label === "" ? (STATUS_LABEL[run.status] ?? run.status) : label;
	const task = clean(run.task, 80);
	const request = task === "" ? "원래 요청" : `원래 요청 "${task}"`;
	const lane = pending[0] === undefined ? undefined : clean(pending[0], 40);
	const inspect = `기록·검증 근거를 먼저 확인하고(종료 사유: ${clean(reason, 40)}) 다음 범위를 정하는 읽기 전용 새 Storm 작업`;
	const scoped =
		lane !== undefined
			? `미완료 레인 "${lane}"만 새 Storm 작업으로 좁게 다시 맡기기`
			: `${request}의 남은 부분 중 한 가지를 골라 좁게 다시 맡기는 새 Storm 작업`;
	const closeNote = `추가 실행과 검증을 반복하지 않고 지금까지의 상태·보류 사유·남은 범위를 기록으로 남기는 마무리 새 Storm 작업`;
	return [inspect, scoped, closeNote];
}

export interface CloseoutCard {
	text: string;
	options: readonly [string, string, string];
}

/** Whether a settled run left work worth a closeout card: a submitted brief, an accepted output, several lanes, or real non-quick work. */
export function isSubstantiveRun(run: RunRecord): boolean {
	if (run.closeout !== undefined) return true;
	const results = run.results ?? [];
	// An open requirement is worth the card even when its lane changed nothing and the run ended quietly (T01).
	if (results.some(result => result.state !== "accepted")) return true;
	// An accepted requirement is delivered output: one real investigation is a card, a casual read with no result is not.
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

/** The one transcript card of a settled substantive run; the draft's own directions when one was submitted. */
export function closeoutCard(
	run: RunRecord,
	pending: readonly string[] = [],
	requiredChecks: readonly string[] = [],
): CloseoutCard {
	const draft = run.closeout;
	const options = draft?.next ?? fallbackNext(run, pending);
	const lines = [`- 상태(공식): ${statusLine(run)}`];
	const results = resultBrief(run);
	const report =
		draft !== undefined
			? [
					`- 결과(감독 보고): ${draft.result}`,
					`- 검증(감독 보고): ${draft.verification}`,
					`- 남은 일(감독 보고): ${draft.remaining ?? "미기재 — 남은 작업이 없다는 증거는 아닙니다."}`,
				]
			: ["- 결과: 검증된 결과 브리프가 제출되지 않았습니다."];
	if (results.lines.length > 0) {
		// The official disposition leads; the director's report cannot precede or stand in for it.
		lines.push(...results.lines);
		const checks = checksLine(run, requiredChecks);
		if (checks !== undefined) lines.push(checks);
		lines.push(...report);
	} else {
		// Legacy record with no observed result ledger: the established order and text stay intact.
		lines.push(...report);
		const checks = checksLine(run, requiredChecks);
		if (checks !== undefined) lines.push(checks);
	}
	// Receipts are host facts about process exit, not evidence for a result or a scientific conclusion.
	const receipts = jobsLine(run.jobs);
	if (receipts !== undefined) lines.push(receipts);
	// A lane already named by an open requirement is the same obligation; print it once, on the result row.
	const unfinished = lanesLine(pending.filter(name => !results.lanes.has(name)));
	if (unfinished !== undefined) lines.push(unfinished);
	lines.push("", "다음으로 무엇을 할까요?", `1. 추천 — ${options[0]}`, `2. ${options[1]}`, `3. ${options[2]}`);
	return { text: lines.join("\n"), options };
}

interface ShownCloseout {
	runId: string;
	options: readonly [string, string, string];
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
 * Makes a shown card answerable in exactly the session that saw it. Returns false when the host exposes no public
 * session identity: the card is still useful, but a number from any session must not be resolved as its choice.
 */
export function rememberCloseoutReport(
	ctx: ExtensionContext,
	runId: string,
	options: readonly [string, string, string],
): boolean {
	const id = closeoutSessionId(ctx);
	if (id === undefined) return false;
	shownBySession.set(id, { runId, options });
	return true;
}

/**
 * Resolves a freshly submitted `1`, `2` or `3` against the most recent same-session settled card, once. Any other
 * input, any later use, and every approach from another session consume or miss the choice instead of acting on it.
 * Returning undefined never means "choose nothing": the caller must continue with its normal input handling.
 */
export function takeCloseoutChoice(ctx: ExtensionContext, text: string): string | undefined {
	const id = closeoutSessionId(ctx);
	if (id === undefined) return undefined;
	const pending = shownBySession.get(id);
	if (pending === undefined) return undefined;
	shownBySession.delete(id);
	const picked = text.trim();
	if (picked !== "1" && picked !== "2" && picked !== "3") return undefined;
	return pending.options[Number(picked) - 1];
}

/** Drops pending choices at a session lifecycle boundary; without a usable identity, every session is cleared. */
export function resetCloseoutChoices(ctx?: ExtensionContext): void {
	const id = ctx === undefined ? undefined : closeoutSessionId(ctx);
	if (id === undefined) shownBySession.clear();
	else shownBySession.delete(id);
}
