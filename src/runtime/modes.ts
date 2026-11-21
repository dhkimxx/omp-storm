/**
 * Run modes over omp's session modes. A Storm run always uses the approved team under director rules; the mode
 * decides how long it lasts: `vibe` until the session settles (Storm's own run; omp's vibe mode would replace the
 * director's tools and is never entered), `goal` until omp's goal mode ends, `loop` while omp's loop mode repeats
 * the task. This module holds what does not need the run: omp's request for a spec, how an omp state maps to an
 * end reason, the labels, and the one omp setting a loop depends on.
 */
import type { SessionModeRequest, SessionModeResult, SessionModeState } from "@oh-my-pi/pi-coding-agent";
import { tokens } from "../report/agents.ts";
import type { Exec, LoopCondition, LoopLimit, RunEndReason, RunMode, RunRecord, RunSpec, RunStatus } from "../types.ts";
import { buildLoopBody } from "./run.ts";

export type ModeFailure = Extract<SessionModeResult, { ok: false }>;

/** omp continues a goal 0.8 s after a turn; a goal still active this long after one with no new turn has stalled. */
export const STALL_MS = 5_000;
/** Nudges per run before Storm pauses a stalled goal and ends the run. */
export const MAX_NUDGES = 3;

/** Visible on purpose: the user sees why the session moved again. */
export const GOAL_NUDGE =
	"The goal is still active but the last turn stopped without continuing. Continue the work now. If the objective is already met, have it verified against the current state and call the `goal` tool with op `complete`.";

export const MODE_LABEL: Readonly<Record<RunMode, string>> = { vibe: "자유 실행", goal: "목표", loop: "반복" };
/** Shown for a goal without a token budget or a loop without a bound. */
export const NO_LIMIT = "제한 없음";

export const END_LABEL: Readonly<Record<RunEndReason, string>> = {
	settled: "세션이 멈춤",
	"goal-complete": "목표 달성",
	"goal-dropped": "목표를 내려놓음",
	"goal-paused": "목표 일시 정지",
	"goal-budget": "목표 토큰 예산 소진",
	"goal-stalled": "목표가 진행되지 않음",
	"loop-ended": "반복 종료",
	"loop-paused": "반복 일시 정지",
	shutdown: "세션 종료",
	budget: "실행 예산 초과",
	"start-failed": "실행 계약 전송 실패",
};

/** A run that reached its natural end is done; one cut short or abandoned is stopped. A run past its budget overrides both. */
export const END_STATUS: Readonly<Record<RunEndReason, RunStatus>> = {
	settled: "done",
	"goal-complete": "done",
	"goal-dropped": "stopped",
	"goal-paused": "stopped",
	"goal-budget": "stopped",
	"goal-stalled": "stopped",
	"loop-ended": "done",
	"loop-paused": "stopped",
	shutdown: "stopped",
	budget: "stopped",
	"start-failed": "stopped",
};

/** What omp's `goal_updated` status means for the run; an active goal ends nothing. */
export function goalEnd(status: string): RunEndReason | undefined {
	switch (status) {
		case "complete":
			return "goal-complete";
		case "dropped":
			return "goal-dropped";
		case "paused":
			return "goal-paused";
		case "budget-limited":
			return "goal-budget";
		default:
			return undefined;
	}
}

/** Whether omp's mode of a goal or loop run is over, from a mode snapshot. */
export function modeEnd(mode: RunMode | undefined, state: SessionModeState): RunEndReason | undefined {
	if (mode === "goal" && state.goal.status !== "active") return state.goal.status === "paused" ? "goal-paused" : "goal-dropped";
	if (mode === "loop" && state.loop.status !== "active") return state.loop.status === "paused" ? "loop-paused" : "loop-ended";
	return undefined;
}

/**
 * The omp mode transition a goal or loop run starts with. omp's loop limit counts repeats, Storm's counts turns. The
 * loop's prompt is the task inside the run's own section (`buildLoopBody`), not the bare task: omp submits it again
 * as a user message on every repeat.
 */
export function modeRequest(spec: Exclude<RunSpec, { mode: "vibe" }>, runId: string): SessionModeRequest {
	if (spec.mode === "goal") {
		if ("resume" in spec) return { mode: "goal", action: "resume" };
		return { mode: "goal", action: "enter", objective: spec.task, ...(spec.tokenBudget !== undefined ? { tokenBudget: spec.tokenBudget } : {}) };
	}
	const limit = spec.limit;
	return {
		mode: "loop",
		action: "enter",
		prompt: buildLoopBody(runId, spec.task),
		...(limit ? { limit: limit.kind === "turns" ? { kind: "iterations", iterations: Math.max(1, limit.turns - 1) } : limit } : {}),
		...(spec.condition ? { condition: spec.condition } : {}),
	};
}

/** Why a mode transition failed, for the user: omp's own message, plus the setting to change when one gates it. */
export function modeFailureText(failure: ModeFailure): string {
	if (failure.code !== "disabled") return failure.message;
	return `${failure.message} 확장의 모드 제어가 꺼져 있으면 \`omp config set extensionHandlers.modeControl true\` 로 켜세요.`;
}

/** What bounds a goal or a loop, one phrase each: `토큰 예산 500k`, `최대 5턴`, `until \`bun test\``. Empty when nothing does. */
export function limitTexts(bounds: { tokenBudget?: number | undefined; limit?: LoopLimit | undefined; condition?: LoopCondition | undefined }): string[] {
	const out: string[] = [];
	if (bounds.tokenBudget !== undefined) out.push(`토큰 예산 ${tokens(bounds.tokenBudget)}`);
	const { limit, condition } = bounds;
	if (limit) out.push(limit.kind === "turns" ? `최대 ${limit.turns}턴` : `최대 ${Math.round(limit.durationMs / 60_000)}분`);
	if (condition) out.push(`${condition.until ? "until" : "while"} \`${condition.command}\``);
	return out;
}

/** `목표(토큰 예산 500k)`, `반복(최대 5턴, until \`bun test\`)`: the mode with what it was started with. */
export function modeText(run: Pick<RunRecord, "mode" | "goal" | "loop">): string {
	const detail = limitTexts({ tokenBudget: run.goal?.tokenBudget, ...run.loop });
	const label = MODE_LABEL[run.mode ?? "vibe"];
	return detail.length ? `${label}(${detail.join(", ")})` : label;
}

/** The user's `loop.mode`: with `reset` omp starts a new session for each repeat, which a run cannot follow. */
export async function readLoopMode(exec: Exec, ompBin: string): Promise<string | undefined> {
	try {
		const result = await exec(ompBin, ["config", "get", "loop.mode"], { timeout: 10_000 });
		return result.code === 0 && !result.killed ? result.stdout.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}
