import type { SessionModeState } from "@oh-my-pi/pi-coding-agent";

/** An omp session mode a Storm run does not start under. */
export type OmpModeBlock = "goal" | "loop" | "plan" | "vibe";

/**
 * The omp mode that keeps a run from starting, in the order the start checks them: goal and loop would move the session
 * outside Storm's run, plan mode holds the session to planning, and vibe replaces the director's tools. Undefined when
 * none is on. The run start (`RunController`) and the preflight report both read this one answer.
 */
export function ompModeBlock(state: Pick<SessionModeState, "goal" | "loop" | "plan" | "vibe">): OmpModeBlock | undefined {
	if (state.goal.status === "active") return "goal";
	if (state.loop.status !== "inactive") return "loop";
	if (state.plan.status === "active") return "plan";
	if (state.vibe.status === "active") return "vibe";
	return undefined;
}
