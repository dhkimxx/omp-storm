/**
 * The stop that reaches running workers when observed spend reaches the user's limit (G3, R15).
 *
 * The director's instance of Storm is not the only one that must feel the limit: a worker's own tool guard and its own
 * request check run in another session, often on another host thread with no shared memory (D8, HF-4). The director
 * therefore writes one small marker field, `spendClosedAt`, beside the run marker on disk, and every worker reads it
 * through `readWorkerSpendClose` in `worker-admission.ts`. This module holds the two decisions and the texts that are
 * pure, so both can be tested without a host: what a worker may call after the close, and whether its next request may
 * be sent. The user's own `budget.onExceed` decides the strength of the stop; a marker without the field is open.
 */
import { followUpProgress, followUpTarget } from "./followup.ts";
import type { BudgetConfig } from "../types.ts";

/** What the user chose for the moment observed spend reaches the limit (`budget.onExceed`). */
export type SpendCloseOption = BudgetConfig["onExceed"];

/** The value of a run marker's `spendClosedAt`: when the director saw the limit, and what the user chose there. */
export interface SpendClose {
	/** Milliseconds since the epoch the director's instance observed spend reach the limit. */
	at: number;
	/** The user's choice at the limit. */
	onExceed: SpendCloseOption;
}

/** Whether an already parsed value is a close this version wrote; absent is open, anything else is unreadable. */
export function isSpendClose(value: unknown): value is SpendClose {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const close = value as { at?: unknown; onExceed?: unknown };
	return (
		typeof close.at === "number" &&
		Number.isFinite(close.at) &&
		close.at >= 0 &&
		(close.onExceed === "block-spawns" || close.onExceed === "stop")
	);
}

/**
 * What a worker read from disk. `open` is a run not past its limit (and a marker written before this field existed);
 * `closed` carries the user's choice; `unknown` is a marker that exists but cannot be read as one Storm wrote. Unknown
 * fails closed for new work only: Storm cannot tell whether the limit was reached, so nothing new may start, but it
 * does not cut a running turn that the user may not have asked to stop.
 */
export type SpendCloseRead =
	| { kind: "open" }
	| { kind: "closed"; close: SpendClose }
	| { kind: "unknown"; reason: string };

/** The refusal tag every worker guard reason carries, as the rest of Storm's guard reasons do. */
export const SPEND_TAG = "[storm:spend]";
/** The tag of a refusal that rests on a marker Storm could not read, so the cause is named as unknown. */
export const SPEND_UNKNOWN_TAG = "[storm:spend-unknown]";

/** The fact every refusal and notice here leads with; exported because the words are part of the contract. */
export const SPEND_CLOSED_LEAD = "관측된 지출이 사용자가 정한 실행 한도에 닿았습니다";
/** Why a stopped worker's delivery is not the user's own interruption (omp labels the aborted turn "Interrupted by user"). */
export const SPEND_USER_STOP_WORD = "사용자가 직접 중단한 것이 아니라 예산 한도에서 온 정지입니다";
/** Said when the marker exists but its close cannot be read: new work is refused with the unknown cause named. */
export const SPEND_UNKNOWN_LEAD = "실행 표시에서 예산 한도 상태를 읽지 못했습니다";

/** A work message to another agent starts a new turn there: refused after the close unless it is a quiet progress note. */
export const SPEND_SEND_REASON = `${SPEND_CLOSED_LEAD}. 일이 담긴 agent:// 메시지는 받는 쪽의 새 턴을 시작하므로 보내지 않았습니다. 진행 상황만 알리려면 주소에 ?progress를 붙인 진행 메모를 보내고, 맡은 결과는 지금 하던 일을 마쳐 yield로 보고하세요.`;
/** A nested `task` starts a new worker: refused after the close. */
export const SPEND_SPAWN_REASON = `${SPEND_CLOSED_LEAD}. 새 워커를 스폰하는 중첩 task는 한도 뒤의 새 작업이라 막았습니다. 지금 하던 일을 마쳐 yield로 보고하고, 더 필요한 작업은 감독에게 알리세요.`;
/** The same refusals when the marker could not be read: the cause is named, and nothing new starts. */
export const SPEND_UNKNOWN_REASON = `${SPEND_UNKNOWN_LEAD}. 예산 한도에 닿았는지 확인할 수 없어 새 작업을 시작하는 호출을 막았습니다. 사용자에게 /storm 상태와 예산 설정을 확인해 달라고 알리세요.`;

/** Under `stop` every tool but the worker's own result is refused; the tool is named so the worker knows what it may not do. */
export function spendStopToolReason(toolName: string): string {
	return `${SPEND_CLOSED_LEAD}. 사용자가 한도에서 실행 중단(stop)을 골랐으므로 '${toolName}' 도구를 막았습니다. 지금까지의 결과만 yield로 끝내세요.`;
}

/**
 * The notice the director reads when a worker's request was aborted for the closed spend. omp's own delivery says
 * "Interrupted by user" (HF-5); this says which stop it really was (D9), so the director does not report a user
 * interruption or restart the work while the limit still holds.
 */
export function spendStopNotice(agentId: string): string {
	return `${agentId} 워커를 멈췄습니다. ${SPEND_CLOSED_LEAD}. 사용자가 한도에서 실행 중단(stop)을 골라 다음 요청을 보내지 않았습니다. 호스트가 보이는 "Interrupted by user"는 ${SPEND_USER_STOP_WORD}. 사용자가 예산을 늘리거나 설정을 바꾸기 전에는 이 워커를 다시 깨우거나 같은 작업을 새로 스폰하지 마세요.`;
}

/** One tool call a worker's guard is judging. */
export interface SpendToolCall {
	toolName: string;
	input?: unknown;
}

/** A refusal the guard answers with, before its policy checks: nothing it allows can start work after the close. */
export interface SpendRefusal {
	code: "spend" | "spend-unknown";
	reason: string;
}

/**
 * What a worker may call after the limit. Before the close every call is left to the lane policy; under
 * `block-spawns` only the two calls that start work elsewhere are refused (a non-progress `write agent://…` and a
 * nested `task`), while the running turn's reads and its own tools continue; under `stop` every call but `yield` is
 * refused. A marker that cannot be read refuses the two work-starting calls and nothing else: Storm cannot tell
 * whether the limit was reached, so it fails closed on new work without cutting a turn the user did not stop.
 */
export function spendToolRefusal(read: SpendCloseRead, call: SpendToolCall): SpendRefusal | undefined {
	if (read.kind === "open") return undefined;
	if (read.kind === "closed" && read.close.onExceed === "stop") {
		if (call.toolName === "yield") return undefined;
		return { code: "spend", reason: `${SPEND_TAG} ${spendStopToolReason(call.toolName)}` };
	}
	const unknown = read.kind === "unknown";
	const tag = unknown ? SPEND_UNKNOWN_TAG : SPEND_TAG;
	const code = unknown ? "spend-unknown" : "spend";
	if (followUpTarget(call.toolName, call.input) !== undefined && !followUpProgress(call.toolName, call.input)) {
		return { code, reason: `${tag} ${unknown ? SPEND_UNKNOWN_REASON : SPEND_SEND_REASON}` };
	}
	if (call.toolName === "task") {
		return { code, reason: `${tag} ${unknown ? SPEND_UNKNOWN_REASON : SPEND_SPAWN_REASON}` };
	}
	return undefined;
}

/** What the check before a worker's next provider request must do. */
export type SpendRequestDecision = { stop: false } | { stop: true; notice: string };

/**
 * Whether this request may be sent. Only the user's `stop` aborts a request (R15): under `block-spawns` a turn that is
 * already running finishes, and only new work is refused. The returned notice is what the director is told (D9).
 */
export function spendRequestStop(read: SpendCloseRead, agentId: string): SpendRequestDecision {
	if (read.kind !== "closed" || read.close.onExceed !== "stop") return { stop: false };
	return { stop: true, notice: spendStopNotice(agentId) };
}
