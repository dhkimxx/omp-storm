/**
 * A turn the user started by typing to a worker focused in omp's Agent Hub, and a hub stop of a worker.
 *
 * What the host shows (omp 19.2.1): a focused submit calls the worker session's own `prompt()` with no attribution, so
 * its user message carries `attribution: "user"`; omp's own task executor reads exactly that as "the operator is driving
 * this agent". A director follow-up (`write agent://<id>`) and a peer message reach the worker as `irc:incoming` with
 * `attribution: "agent"` (a parent steer also carries `parentIrc`); the assignment and the host's step prompts are
 * `attribution: "agent"`; a revive starts no turn of its own. So a user turn is one whose new input holds a user message
 * attributed to the user. An extension inside the worker that sends an unattributed user message reads the same way;
 * it still meets every gate below, so nothing it starts escapes the run's admission.
 *
 * The child session holds no run. The director's own session registers an admitter for its live run here, on the same
 * thread; a worker of a run this thread does not hold finds none and stays read-only.
 */
import { withJosa } from "../josa.ts";
import { sharedMap } from "./thread-state.ts";

/** What the director's admission decided for one user turn. */
export type UserTurnAdmission =
	/** A new attempt was opened under the worker's approval record, with its write reservation. */
	| { readonly kind: "admitted"; readonly lane?: string }
	/** The worker's current attempt is still open (the user wrote into a running turn): it keeps that authority. */
	| { readonly kind: "joined"; readonly lane?: string }
	/** The turn goes on, read-only; `reason` is said by the first refused write. */
	| { readonly kind: "read-only"; readonly reason: string; readonly lane?: string }
	/** The run's spend is closed: the request is not sent (the ordinary close stops it). */
	| { readonly kind: "closed"; readonly reason: string };

export interface UserTurnRequest {
	/** The worker's native id (`ctx.agent.id`). */
	readonly childId: string;
	/** Its agent definition name. */
	readonly childName: string;
}

type Admitter = (request: UserTurnRequest) => Promise<UserTurnAdmission>;

const admitters = sharedMap<string, Admitter>("storm.userTurn.admitters");

/** Tag every user-turn notice starts with, so a reader can tell it from the authority refusal it is put in front of. */
export const USER_TURN_TAG = "[storm:user-turn]";

/** No live run of this session holds the worker. */
export const USER_TURN_NO_RUN =
	`${USER_TURN_TAG} 이 워커가 속한 Storm 실행이 지금 이 세션에서 진행 중이 아니어서 직접 지시는 읽기 전용으로 진행합니다. 파일을 바꾸게 하려면 /storm 에서 이어 가기를 고르거나 새 워커를 시작하세요.`;

/** The live run has no approval record for this worker. */
export const USER_TURN_NOT_APPROVED =
	`${USER_TURN_TAG} 지금 실행이 이 워커를 승인한 기록이 없어 직접 지시는 읽기 전용으로 진행합니다. 파일을 바꾸게 하려면 /storm 에서 이어 가기를 고르거나 새 워커를 시작하세요.`;

/** The write reservation was refused; `holder` is the gate's own sentence, which names who holds the place. */
export function userTurnReadOnly(holder: string): string {
	return `${USER_TURN_TAG} 직접 지시는 읽기 전용으로 진행합니다. ${holder}`;
}

/** Who the director's line names: the lane, or the worker itself when it has none. */
function workerOf(lane: string | undefined, childId: string): string {
	return lane === undefined ? `계획 밖 워커 ${childId}` : `${lane}의 워커`;
}

/** The director's one line about a user turn: no body, only the transcript reference. */
export function userTurnDirectorNotice(lane: string | undefined, childId: string): string {
	return `사용자가 ${workerOf(lane, childId)}에게 직접 지시함 (history://${childId})`;
}

/** The director's one line about a hub stop. */
export function userStopDirectorNotice(lane: string | undefined, childId: string): string {
	return `사용자가 허브에서 ${withJosa(workerOf(lane, childId), "을/를")} 멈춤. 그 시도는 판정 전에 끝났습니다 (history://${childId})`;
}

/** The director's session offers admission for its live run. Replaces an earlier admitter of the same run. */
export function registerUserTurnAdmitter(runId: string, admit: Admitter): void {
	admitters.set(runId, admit);
}

/** Asks the run's director to admit a user turn. No run, no admitter or a failed admission is read-only. */
export async function admitUserTurn(runId: string | undefined, request: UserTurnRequest): Promise<UserTurnAdmission> {
	const admit = runId === undefined ? undefined : admitters.get(runId);
	if (admit === undefined) return { kind: "read-only", reason: USER_TURN_NO_RUN };
	try {
		return await admit(request);
	} catch {
		return { kind: "read-only", reason: USER_TURN_NO_RUN };
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Timestamps of the user-attributed messages this request carries as new input: those after the worker's last assistant
 * message. A parent steer (`parentIrc`), a synthetic prompt and any agent-attributed message are not the user's.
 */
export function userOriginInputs(messages: readonly unknown[]): number[] {
	const stamps: number[] = [];
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = record(messages[at]);
		if (message === undefined) continue;
		if (message.role === "assistant") break;
		if (message.role !== "user" || message.attribution !== "user" || message.synthetic === true || message.parentIrc !== undefined) continue;
		if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) stamps.push(message.timestamp);
	}
	return stamps;
}

/** omp's label for an interrupt the user asked for: Esc in the focused view, and the hub's stop. */
export const USER_INTERRUPT_LABEL = "Interrupted by user";

/**
 * Whether a settled turn ended on the user's interrupt. The label is necessary, not sufficient: Storm's own stop
 * (`ctx.abort()`) carries it too, so `stormStopped` (Storm's own record of stopping this worker) rules those out. The
 * host's own budget, time and shutdown aborts carry other labels.
 */
export function isUserStop(messages: readonly unknown[], stormStopped: boolean): boolean {
	if (stormStopped) return false;
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = record(messages[at]);
		if (message?.role !== "assistant") continue;
		return message.stopReason === "aborted" && message.errorMessage === USER_INTERRUPT_LABEL;
	}
	return false;
}
