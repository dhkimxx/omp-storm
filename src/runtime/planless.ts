/**
 * R9: when an automatic run may open with no plan. The checks are pure and ordered — every fact comes from the caller,
 * in the order the rule asks for them — so the tool-call handler, the controller and the tests decide the same way.
 * Nothing here reads the clock, a file, a run or a session. G4: work starts only under a live ask of the user.
 */

/** Why a plan-less open was refused. The order of the codes is the order the checks run in. */
export type PlanlessRefusal = "auto-off" | "run-active" | "no-turn" | "no-turn-time" | "same-turn" | "blocked";

/** Automatic delegation is off: no `task` opens a run. */
export const PLANLESS_AUTO_OFF =
	"자동 위임이 꺼져 있어 task로 실행을 열지 않았습니다. 사용자가 /storm에서 자동 위임을 켜거나, 실행을 직접 시작해야 합니다.";
/** A run of this session and target already runs, waits for its turn or is starting. */
export const PLANLESS_RUN_ACTIVE =
	"이 세션과 작업 트리에 이미 실행이 진행 중이라 새 실행을 열지 않았습니다. 진행 중인 실행 안에서 task를 보내거나, 그 실행이 끝난 뒤 사용자에게 물어보세요.";
/** The host reported no ordinary user prompt for this turn. */
export const PLANLESS_NO_TURN =
	"이번 사용자 요청을 찾지 못해 실행을 열지 않았습니다. 실행은 사용자가 새로 요청할 때만 열립니다.";
/** The host reported a prompt but no time for it, so the same-turn rule cannot be established. */
export const PLANLESS_NO_TURN_TIME =
	"이번 사용자 요청의 시각을 호스트에서 확인하지 못해 실행을 열지 않았습니다. 사용자가 새로 요청하면 다시 시도하세요.";
/**
 * A run of this session and target ended or stopped at or after this turn's prompt: the user has not spoken since, so a
 * limit or a stop of theirs (or a finished run of this ask) stands. F1 closed.
 */
export const PLANLESS_SAME_TURN =
	"이번 사용자 요청과 같은 턴이거나 그 뒤에 끝난 실행이 있어 새 실행을 열지 않았습니다. 사용자에게 끝난 이유를 알리고, 사용자가 다시 말한 뒤에 시작하세요.";
/**
 * The open outlived the host's budget for the `tool_call` handler: the host has already refused the call, so the run
 * was finished at once as stopped instead of holding the lease with no work.
 */
export const PLANLESS_DEADLINE =
	"task 호출의 처리 제한 시간이 지나 호스트가 이 호출을 이미 거절해, 연 실행을 곧바로 중단으로 마쳤습니다. 큰 저장소에서는 계획을 storm plan으로 제출해 실행을 여세요.";

/** Everything R9's checks read, gathered by the caller that is about to open a plan-less run. */
export interface PlanlessFacts {
	/** The session's automatic-delegation consent is on. */
	automatic: boolean;
	/** A run of this session and target is active, queued or starting. */
	runActive: boolean;
	/** The ordinary user prompt of this turn; `undefined` when the host reported none (a wake, an empty prompt, a settled turn). */
	task: string | undefined;
	/** When that prompt arrived (ms since epoch), as the host recorded it; `undefined` when the host gave no time. */
	turnStartedAt: number | undefined;
	/** When this session and target last ended or stopped a run; `undefined` when this process saw none. */
	lastEndAt: number | undefined;
	/** Why the approved team or omp's session modes refuse a start now; `undefined` when nothing refuses. */
	blocked: string | undefined;
}

export type PlanlessVerdict =
	| { ok: true; task: string; turnStartedAt: number }
	| { ok: false; code: PlanlessRefusal; reason: string };

/**
 * Whether a run of this session and target ended or stopped at or after the prompt of this turn. At or after: no turn
 * begins and runs a run to its stop within one millisecond, and the same millisecond is the one ambiguous case, which
 * fails closed.
 */
export function stoppedInTurn(turnStartedAt: number, lastEndAt: number | undefined): boolean {
	return lastEndAt !== undefined && turnStartedAt <= lastEndAt;
}

/**
 * R9's checks in order. The first fact that refuses decides, so a later check never hides the real cause:
 * 1. automatic delegation is on, and no run is active;
 * 2. this turn has its own user prompt, with a time the same-turn rule can use;
 * 3. no run of this session and target ended or stopped at or after that prompt;
 * 4. the approved team and omp's session modes allow a start (the caller's `blocked`, its own sentence).
 */
export function planlessOpen(facts: PlanlessFacts): PlanlessVerdict {
	if (!facts.automatic) return { ok: false, code: "auto-off", reason: PLANLESS_AUTO_OFF };
	if (facts.runActive) return { ok: false, code: "run-active", reason: PLANLESS_RUN_ACTIVE };
	const task = facts.task ?? "";
	if (task.trim() === "") return { ok: false, code: "no-turn", reason: PLANLESS_NO_TURN };
	const turnStartedAt = facts.turnStartedAt;
	if (turnStartedAt === undefined || !Number.isFinite(turnStartedAt)) {
		return { ok: false, code: "no-turn-time", reason: PLANLESS_NO_TURN_TIME };
	}
	if (stoppedInTurn(turnStartedAt, facts.lastEndAt)) return { ok: false, code: "same-turn", reason: PLANLESS_SAME_TURN };
	const blocked = facts.blocked?.trim() ?? "";
	if (blocked !== "") return { ok: false, code: "blocked", reason: blocked };
	return { ok: true, task, turnStartedAt };
}
