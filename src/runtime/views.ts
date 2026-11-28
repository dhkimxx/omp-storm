import { loadUsageBetween, type StatsEnv } from "../context.ts";
import { compareTrial } from "../report/trials.ts";
import { parseModelEntry } from "../selector.ts";
import type { StormConfig, TrialView } from "../types.ts";
import { RESULT_STATE_LABEL } from "../view/results.ts";
import type { IntegrationRead } from "./integration-admission.ts";
import type {
	CandidateDetail,
	CandidateLine,
	CandidateProjection,
	IntegrationSelectionReply,
	QueueReadiness,
	QueueWrite,
} from "./integration-controller-port.ts";
import type { WriteStepRecord } from "./integration-record.ts";
import {
	INTEGRATION_AWAITING_NATIVE,
	INTEGRATION_CANDIDATES,
	INTEGRATION_CAPTURE_UNKNOWN,
	INTEGRATION_CHANGED,
	INTEGRATION_CONFIRMED_EMPTY,
	INTEGRATION_CONFLICT,
	INTEGRATION_KEPT_ONLY,
	INTEGRATION_LAST_SEEN,
	INTEGRATION_NOT_RECORDED,
	INTEGRATION_NOT_RECORDED_NOTE,
	INTEGRATION_NOT_WRITTEN,
	INTEGRATION_NO_EFFECT,
	INTEGRATION_ORIGIN_UNPROVED,
	INTEGRATION_PRESENCE_UNKNOWN,
	INTEGRATION_PRESENT,
	INTEGRATION_PRESENT_UNATTRIBUTED,
	INTEGRATION_READINESS_UNKNOWN,
	INTEGRATION_READY,
	INTEGRATION_RECOVERY_REQUIRED,
	INTEGRATION_STALE,
	INTEGRATION_UNKNOWN,
	INTEGRATION_WRITE_NOT_RECORDED,
	INTEGRATION_WRITTEN,
	INTEGRATION_WRITTEN_COUNT,
	integrationProblemText,
} from "./result-facts.ts";
import { readTrialStates } from "./state-files.ts";
import { trialPhase } from "./trials.ts";

/**
 * Trials of the config with counters and phase. An ended trial gets the measured comparison over its own period:
 * start to scheduled end, or to the moment it reached its spawn cap or budget (to now for counters that recorded no
 * such moment), so both sides cover the same requests; omp's stats DB is synced first when it ends before that
 * period does. Counters come only from this native session's store.
 */
export async function trialViews(env: StatsEnv, sessionDir: string, config: StormConfig, now: number): Promise<TrialView[]> {
	const trials = config.trials ?? [];
	if (trials.length === 0) return [];
	const states = await readTrialStates(sessionDir);
	const views: TrialView[] = [];
	for (const trial of trials) {
		const state = states[trial.id];
		const { phase, endReason } = trialPhase(trial, state, now);
		const view: TrialView = { trial, state, phase, ...(endReason ? { endReason } : {}) };
		views.push(view);
		const primary = config.roles[trial.role]?.models[0];
		const from = Date.parse(trial.startsAt);
		const stopped = state?.stoppedAt === undefined ? Number.NaN : Date.parse(state.stoppedAt);
		const to = Math.min(Date.parse(trial.endsAt), Number.isFinite(stopped) ? stopped : now);
		if (phase !== "ended" || primary === undefined || !(to > from)) continue;
		const usage = await loadUsageBetween(env, from, to);
		if (usage.status === "ok") view.comparison = compareTrial(trial, parseModelEntry(primary).selector, usage);
	}
	return views;
}

// ── Integration queue and selection replies (D) ─────────────────────────────────────────────────
//
// C owns the projection and the journal; these functions are pure. They never read the filesystem, never re-derive a
// write from matching paths, and never print a backing `chosen`/`ordered` array: a selection reply shows counts, a few
// actual step examples and the first unstarted exact ID.

const CANDIDATE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
/** A candidate text bound: the full ID (67 chars) still fits, and every other field is deliberately shorter. */
const CANDIDATE_FIELD_MAX = 120;

/** One bounded, single-line value from C's projection; a control character never reaches a terminal row. */
function clean(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(CANDIDATE_UNSAFE, " ").replace(/\s+/g, " ").trim();
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, Math.max(1, max - 1)).join("")}…` : text;
}

const whole = (value: number | undefined): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

function timeText(at: number): string {
	return Number.isFinite(at) ? new Date(at).toISOString() : "시각 미상";
}

/** A typed read as text: a known value is rendered, an unknown one keeps its bounded cause instead of inventing one. */
function readText<T>(read: IntegrationRead<T>, render: (value: T) => string): string {
	return read.kind === "known" ? render(read.value) : `미상 — ${integrationProblemText(read.problem)}`;
}

const READINESS_WORD: Readonly<Record<QueueReadiness["kind"], string>> = {
	"awaiting-native": INTEGRATION_AWAITING_NATIVE,
	ready: INTEGRATION_READY,
	"confirmed-empty": INTEGRATION_CONFIRMED_EMPTY,
	"kept-only": INTEGRATION_KEPT_ONLY,
	unknown: INTEGRATION_READINESS_UNKNOWN,
	conflict: INTEGRATION_CONFLICT,
	stale: INTEGRATION_STALE,
};

const WRITE_WORD: Readonly<Record<QueueWrite["kind"], string>> = {
	"not-written": INTEGRATION_NOT_WRITTEN,
	"not-recorded": INTEGRATION_WRITE_NOT_RECORDED,
	"present-unattributed": INTEGRATION_PRESENT_UNATTRIBUTED,
	"no-effect": INTEGRATION_NO_EFFECT,
	"recovery-required": INTEGRATION_RECOVERY_REQUIRED,
	written: INTEGRATION_WRITTEN,
};

const WRITE_COUNT_WORD: Readonly<Record<QueueWrite["kind"], string>> = {
	"not-written": "적용 안 함",
	"not-recorded": INTEGRATION_WRITE_NOT_RECORDED,
	"present-unattributed": "출처 미증명",
	"no-effect": INTEGRATION_NO_EFFECT,
	"recovery-required": INTEGRATION_RECOVERY_REQUIRED,
	written: INTEGRATION_WRITTEN_COUNT,
};

const STEP_WORD: Readonly<Record<WriteStepRecord["state"], string>> = {
	written: INTEGRATION_WRITTEN,
	"already-written": "이미 적용 기록 있음",
	conflict: INTEGRATION_CONFLICT,
	refused: "거부",
	"no-effect": INTEGRATION_NO_EFFECT,
	"present-unattributed": INTEGRATION_PRESENT_UNATTRIBUTED,
	"recovery-required": INTEGRATION_RECOVERY_REQUIRED,
	"not-ready": "준비 안 됨",
	"not-started": "시작 안 함",
};

const BUNDLE_WORD: Readonly<Record<CandidateDetail["bundle"], string>> = {
	"root-only": "루트 전용",
	"confirmed-empty": INTEGRATION_CONFIRMED_EMPTY,
	"kept-only": INTEGRATION_KEPT_ONLY,
	unknown: INTEGRATION_CAPTURE_UNKNOWN,
};

const OUTCOME_WORD = { success: "성공", failure: "실패", cancel: "취소" } as const;

function readinessText(readiness: QueueReadiness): string {
	const base = READINESS_WORD[readiness.kind];
	return "problem" in readiness ? `${base} — ${integrationProblemText(readiness.problem)}` : base;
}

/** The last bounded observation of the postimage. It says what was read, never that the bytes are still there now. */
function presenceText(presence: CandidateLine["presence"]): string {
	if (presence.kind === "present") return `${INTEGRATION_PRESENT} (${timeText(presence.observedAt)})`;
	if (presence.kind === "changed") return `${INTEGRATION_CHANGED} (${timeText(presence.observedAt)}) · 첫 경로: ${clean(presence.firstPath, 80)}`;
	return `${INTEGRATION_PRESENCE_UNKNOWN} — ${integrationProblemText(presence.problem)}`;
}

/**
 * A write state joins the receipt kind to the independent presence observation. A receipt and matching bytes are two
 * facts: written-and-current, written-then-changed, present-without-origin and unreadable stay distinguishable.
 */
function writeText(write: QueueWrite, presence: CandidateLine["presence"]): string {
	if (write.kind === "written") return `${INTEGRATION_WRITTEN} — 기록 시각 ${timeText(write.at)} · ${presenceText(presence)}`;
	if (write.kind === "not-written") {
		const observed = presence.kind === "present" ? `${INTEGRATION_PRESENT} · ${INTEGRATION_ORIGIN_UNPROVED}` : presenceText(presence);
		return `${INTEGRATION_NOT_WRITTEN} · ${observed}`;
	}
	if (write.kind === "present-unattributed") {
		const at = presence.kind === "unknown" ? "" : ` (${timeText(presence.observedAt)})`;
		return `${INTEGRATION_PRESENT_UNATTRIBUTED}${at} — ${integrationProblemText(write.problem)}`;
	}
	if (write.kind === "no-effect") return `${INTEGRATION_NO_EFFECT} — ${integrationProblemText(write.problem)}`;
	if (write.kind === "recovery-required") return `${INTEGRATION_RECOVERY_REQUIRED} — ${integrationProblemText(write.problem)}`;
	const observed = presence.kind === "present" ? `${INTEGRATION_PRESENT} · ${INTEGRATION_ORIGIN_UNPROVED}` : presenceText(presence);
	return `${INTEGRATION_WRITE_NOT_RECORDED} · ${observed}`;
}

function lineWords(line: CandidateLine): string {
	const subject = line.subject.kind === "planned" ? `레인 ${clean(line.subject.lane, 32)}` : "계획 밖";
	return `${line.candidateId} · ${subject} · ${readinessText(line.readiness)} · ${WRITE_WORD[line.write.kind]}`;
}

/**
 * The safe next action for one candidate. Selection is always an explicit live-ask action with an exact ID; a matching
 * postimage is not permission to write, and recovery-required is never "retry blindly". No cleanup is suggested.
 */
function nextAction(value: CandidateDetail): string {
	const line = value.line;
	if (line.write.kind === "recovery-required") return "복구 필요 상태입니다. 효과 종료를 확인하기 전에는 선택하지 마세요.";
	if (line.write.kind === "written") return "적용 기록은 수용 판정과 별개입니다. 결과 판정은 기존 평가 기록을 따릅니다.";
	if (line.write.kind === "present-unattributed" || line.write.kind === "not-written" && line.presence.kind === "present") {
		return "바이트가 같아도 출처가 증명되지 않았습니다. 덮어쓰거나 지우지 말고 네이티브 기록과 마지막 확인 시각을 비교하세요.";
	}
	if (line.readiness.kind === "ready" || line.readiness.kind === "confirmed-empty") {
		return `부모에 반영하려면 이 실행의 live 요청에서 integrate { candidateIds: ["${line.candidateId}"] }처럼 정확한 후보 ID를 지정하세요. 자동 적용은 없습니다.`;
	}
	if (line.readiness.kind === "awaiting-native") return "네이티브 종료와 캡처가 기록될 때까지 기다리세요.";
	if (line.readiness.kind === "kept-only") return "보존 전용 후보입니다. 부모 반영 대상이 아닙니다.";
	if (line.readiness.kind === "conflict") return "충돌 경로를 확인한 뒤 새 시도로 다시 캡처하세요.";
	if (line.readiness.kind === "stale") return "낡은 후보입니다. 새 실행에서 다시 캡처하세요.";
	return "이 상태에서는 선택할 수 없습니다. 기록을 다시 조회하거나 네이티브 기록을 확인하세요.";
}

function overviewText(value: CandidateProjection & { readonly kind: "overview" }): string {
	const overview = value.value;
	const readiness = (Object.entries(READINESS_WORD) as Array<[QueueReadiness["kind"], string]>)
		.map(([kind, word]) => `${word} ${whole(overview.readiness[kind])}`)
		.join(" · ");
	const writes = (Object.entries(WRITE_COUNT_WORD) as Array<[QueueWrite["kind"], string]>)
		.map(([kind, word]) => `${word} ${whole(overview.writes[kind])}`)
		.join(" · ");
	const total = Object.values(overview.readiness).reduce((sum, count) => sum + whole(count), 0);
	const out = [
		`통합 후보 — 실행 ${clean(overview.runId, 80)} · ${INTEGRATION_LAST_SEEN} ${timeText(overview.observedAt)}`,
		`- ${INTEGRATION_CANDIDATES} ${total}개 · ${readiness}`,
		`- 쓰기: ${writes}`,
		`- ${INTEGRATION_LAST_SEEN} 바이트: ${INTEGRATION_PRESENT} ${whole(overview.present)} · ${INTEGRATION_CHANGED} ${whole(overview.changed)} · ${INTEGRATION_PRESENCE_UNKNOWN} ${whole(overview.unknownPresence)}`,
	];
	for (const example of overview.examples.slice(0, 3)) out.push(`  · ${lineWords(example)}`);
	if (overview.examples.length > 3) out.push(`  · 외 ${overview.examples.length - 3}개 예시는 표시하지 않았습니다.`);
	const page = overview.page.slice(0, 20);
	if (page.length > 0) out.push(`- 페이지(${page.length}): ${page.map(id => clean(id, 80)).join(", ")}`);
	if (overview.nextAfter !== null) out.push(`- 다음 페이지: candidateAfter=${clean(overview.nextAfter, 80)}`);
	if (total === 0) out.push("- 후보 없음: 이 실행에서 캡처된 후보가 없습니다.");
	out.push('- 선택: 부모에 반영할 후보는 live 요청에서 integrate { candidateIds: ["<정확한 후보 ID>"] }처럼 지정하세요. 자동 적용은 없습니다.');
	return out.join("\n");
}

function detailText(value: CandidateProjection & { readonly kind: "detail" }): string {
	const detail = value.value;
	const line = detail.line;
	const subject = line.subject.kind === "planned" ? `레인 ${clean(line.subject.lane, 32)}` : "계획 밖";
	const provenance = detail.provenance;
	const checkoutClaim =
		provenance.checkoutClaim.kind === "known"
			? `${clean(provenance.checkoutClaim.value.reference, 80)} (${timeText(provenance.checkoutClaim.value.checkedAt)})`
			: `미상 — ${integrationProblemText(provenance.checkoutClaim.problem)}`;
	const carrier = readText(provenance.carrier, carrier => clean(carrier, 16));
	const outcome = readText(detail.outcome, outcome => OUTCOME_WORD[outcome] ?? clean(outcome, 20));
	const stop = readText(detail.stopCause, cause => clean(cause, 80));
	const recovery = detail.recovery;
	const copy = readText(recovery.stormCopy, copy => `${clean(copy.reference, 80)} (${whole(copy.bytes)}B, sha256:${clean(copy.sha256, 16)})`);
	const patch = readText(recovery.nativePatch, patch => clean(patch, CANDIDATE_FIELD_MAX));
	const branch = readText(
		recovery.nativeBranch,
		branch => `${clean(branch.ref, 80)} · base ${readText(branch.base, base => clean(base, 40))} · tip ${readText(branch.tip, tip => clean(tip, 40))}`,
	);
	const nested = readText(recovery.nestedCount, count => `${whole(count)}개`);
	const nestedExamples = recovery.nestedExamples
		.slice(0, 3)
		.map(example => `${clean(example.reference, 80)} (${readText(example.relativeRepo, repo => clean(repo, 60))})`);
	const checkout =
		recovery.checkout.kind === "unknown"
			? `체크아웃 미상 — ${integrationProblemText(recovery.checkout.problem)}`
			: `${recovery.checkout.kind === "present" ? "체크아웃 확인됨" : "체크아웃 마지막 확인에서 없음"} (${timeText(recovery.checkout.checkedAt)})`;
	const dirty =
		detail.dirtyPaths.kind === "known"
			? detail.dirtyPaths.value.total === 0
				? "없음 (마지막 읽기)"
				: `총 ${whole(detail.dirtyPaths.value.total)}개 · 예: ${detail.dirtyPaths.value.examples.slice(0, 3).map(path => clean(path, 80)).join(", ") || "없음"}${detail.dirtyPaths.value.dirtyDeletes.length === 0 ? "" : ` · 삭제 후보: ${detail.dirtyPaths.value.dirtyDeletes.slice(0, 3).map(path => clean(path, 80)).join(", ")}`}`
			: `미상 — ${integrationProblemText(detail.dirtyPaths.problem)}`;
	const states = detail.resultStates.slice(0, 5).map(state => `${clean(state.id, 40)}: ${RESULT_STATE_LABEL[state.state] ?? clean(state.state, 20)}`).join(" · ");
	const rest = detail.resultStates.length > 5 ? ` · 외 ${detail.resultStates.length - 5}개` : "";
	const native = readText(recovery.nativeLink, link => clean(link, CANDIDATE_FIELD_MAX));
	const out = [
		`통합 후보 ${clean(line.candidateId, 80)}`,
		`- 실행: ${clean(provenance.key.runId, 80)} · 시도 ${clean(provenance.key.dispatch, 80)} · 배치 #${whole(provenance.placementOrdinal)} · ${subject} · 호스트 항목 ${clean(line.childHandle, 80)}`,
		`- 준비: ${readinessText(line.readiness)}`,
		`- 쓰기: ${writeText(line.write, line.presence)}`,
		`- 캐리어: ${carrier}`,
		`- 체크아웃 확보 기록: ${checkoutClaim}`,
		`- 캡처 번들: ${BUNDLE_WORD[detail.bundle]} · 결과: ${outcome}${detail.cancelRequested ? " · 취소 요청 있음" : ""}`,
		`- 정지 사유: ${stop}`,
		`- 결과 상태: ${states === "" ? "없음" : states}${rest}`,
		`- 복구: Storm 사본 ${copy} · 네이티브 패치 ${patch} · 브랜치 ${branch} · 중첩 ${nested}`,
		`- 복구 위치: ${checkout} · 네이티브 기록 ${native}`,
	];
	if (nestedExamples.length > 0) out.push(`- 중첩 예: ${nestedExamples.join(" · ")}`);
	out.push(`- 충돌 경로: ${dirty}`);
	out.push(`- 다음: ${nextAction(detail)}`);
	return out.join("\n");
}

/**
 * Tool overview or exact detail. `not-recorded` is an older record, not zero captured work; `unknown` is an unreadable
 * journal with a safe read action. The overview names at most three examples and the page's exact IDs; detail is one
 * exact ID, with claim, carrier, bundle, recovery, presence and a safe next action.
 */
export function formatIntegrationCandidates(projection: CandidateProjection): string {
	if (projection.kind === "not-recorded") {
		return [
			`${INTEGRATION_NOT_RECORDED} — ${INTEGRATION_NOT_RECORDED_NOTE}.`,
			"다음: /storm status에서 실행 기록을 확인하고, 필요하면 새 실행에서 다시 캡처하세요.",
		].join("\n");
	}
	if (projection.kind === "unknown") {
		return [
			`${INTEGRATION_UNKNOWN} — ${integrationProblemText(projection.problem)}.`,
			"다음: 통합 후보를 다시 조회하세요. 이 상태에서는 선택할 수 없습니다.",
		].join("\n");
	}
	if (projection.kind === "overview") return overviewText(projection);
	return detailText(projection);
}

/**
 * The bounded reply to one explicit selection. It reports what the controller actually did with counts and a few step
 * records; it never dumps the requested order and never turns a write receipt into an acceptance.
 */
export function formatIntegrationSelection(reply: IntegrationSelectionReply): string {
	if (reply.kind === "refused") {
		return [
			`통합 선택 거부 — ${integrationProblemText(reply.problem)}.`,
			"선택한 후보는 하나도 쓰이지 않았습니다. 정확한 후보 ID와 현재 준비 상태를 확인한 뒤 다시 요청하세요.",
		].join("\n");
	}
	const out = [
		`통합 선택 — 요청 ${whole(reply.selection.chosen.length)}개 · 시작 ${whole(reply.started)} · 적용 기록 ${whole(reply.written)} · 건너뜀 ${whole(reply.skipped)} · 시작 안 함 ${whole(reply.notStarted)}`,
	];
	for (const example of reply.examples.slice(0, 3)) {
		const why = example.problem === undefined ? "" : ` — ${integrationProblemText(example.problem)}`;
		out.push(`  · ${example.candidateId} · ${STEP_WORD[example.state]}${why}`);
	}
	if (reply.examples.length > 3) out.push(`  · 외 ${reply.examples.length - 3}개는 표시하지 않았습니다.`);
	if (reply.written > 0) out.push("- 적용 기록은 수용 판정과 별개입니다.");
	if (reply.firstNotStarted !== null) out.push(`- 첫 시작 안 함: ${reply.firstNotStarted}`);
	if (reply.stop !== null) out.push(`- 중단: ${integrationProblemText(reply.stop)}`);
	return out.join("\n");
}
