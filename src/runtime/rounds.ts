/**
 * Round rules: whether a run's latest round left anything to verify, when the run is over, and what Storm sends the
 * main session when it is not. Pure: no clock, no I/O, no controller state, so every rule is testable on its own.
 */
import { usableRole } from "../policy/spawn.ts";
import type { AgentEntry, RunEndReason, RunStatus, StormConfig } from "../types.ts";

export const DEFAULT_EXTRA_ROUNDS = 3;
export const MAX_EXTRA_ROUNDS = 10;
/** How long Storm waits before looking again while the session is held. */
export const HOLD_MS = 5_000;
/** How long after a round ends Storm looks whether to send the next: the session is still closing the turn before that; omp's own continuations wait as long. */
export const ROUND_DELAY_MS = 800;

/** Korean labels for the reasons a run can end with. */
export const END_LABEL: Readonly<Record<RunEndReason, string>> = {
	settled: "세션이 멈춤",
	verified: "리뷰 통과",
	interrupted: "사용자가 중단",
	"round-limit": "라운드 한도",
	"no-progress": "진전 없음",
	"time-limit": "시간 한도",
	shutdown: "세션 종료",
	budget: "실행 예산 초과",
	"start-failed": "실행 계약 전송 실패",
};

/** A run that reached its natural end is done; one cut short or abandoned is stopped. A run past its budget overrides both. */
export const END_STATUS: Readonly<Record<RunEndReason, RunStatus>> = {
	settled: "done",
	verified: "done",
	interrupted: "stopped",
	"round-limit": "stopped",
	"no-progress": "stopped",
	"time-limit": "stopped",
	shutdown: "stopped",
	budget: "stopped",
	"start-failed": "stopped",
};

/** The label of a reason; records written by 0.10 carry reasons that no longer exist, shown as they are. */
export function endLabel(reason: string): string {
	return (END_LABEL as Readonly<Record<string, string | undefined>>)[reason] ?? reason;
}

export type Gate =
	| { state: "none" }
	| { state: "passed" }
	| { state: "unverified"; cause: "no-review" | "stale-review" | "incorrect"; changes: number; reviews: number };

/** The gate's unverified shape, the only one a round message is built from. */
type Unverified = Extract<Gate, { state: "unverified" }>;
type UnverifiedCause = Unverified["cause"];

/** What the run's file changes and review verdicts amount to: nothing to verify, verified, or unverified with why. */
export function reviewGate(agents: readonly AgentEntry[], config: StormConfig): Gate {
	const writers = agents.filter(agent => (agent.changes ?? 0) > 0 && agent.role !== "quick");
	const changes = agents.reduce((sum, agent) => sum + (agent.changes ?? 0), 0);
	// Only a verdict from an agent that did not change files and does not implement counts: a writer must not verify itself.
	const verdicts = agents.filter(agent => (agent.changes ?? 0) === 0 && agent.role !== "implementer" && agent.role !== "quick");
	const reviews = verdicts.reduce((sum, agent) => sum + (agent.review?.reviews ?? 0), 0);
	if (writers.length === 0) return { state: "none" };
	if (!usableRole(config, "reviewer")) return { state: "none" };
	let latest: AgentEntry["lastVerdict"];
	for (const agent of verdicts) {
		const verdict = agent.lastVerdict;
		if (verdict && (latest === undefined || verdict.at > latest.at)) latest = verdict;
	}
	if (latest === undefined) return { state: "unverified", cause: "no-review", changes, reviews };
	const lastChangeAt = Math.max(...writers.map(agent => agent.lastChangeAt ?? 0));
	if (latest.at <= lastChangeAt) return { state: "unverified", cause: "stale-review", changes, reviews };
	if (!latest.correct) return { state: "unverified", cause: "incorrect", changes, reviews };
	return { state: "passed" };
}

/** Most rounds the run may take: the user's limit when stated, else the config's extra rounds on top of the first. */
export function maxRounds(spec: { rounds?: number }, config: StormConfig): number {
	const asked = spec.rounds;
	if (typeof asked === "number" && Number.isInteger(asked)) return Math.max(1, asked);
	const extra = config.rounds;
	const valid = typeof extra === "number" && Number.isInteger(extra) && extra >= 0 && extra <= MAX_EXTRA_ROUNDS;
	return 1 + (valid ? extra : DEFAULT_EXTRA_ROUNDS);
}

export type RoundDecision =
	| { action: "end"; reason: RunEndReason }
	| { action: "continue"; gate: Unverified; round: number; maxRounds: number };

/** The one decision after a round, in the order the contract fixes: interruption first, then the gate, then limits. */
export function decideRound(input: {
	gate: Gate;
	/** Rounds finished so far, the one that just ended included. */
	turns: number;
	maxRounds: number;
	aborted: boolean;
	/** The run has passed its team budget. */
	overBudget: boolean;
	elapsedMs: number;
	minutes?: number;
	/** The counts when Storm sent its last round message; absent before the first one. */
	progressSince?: { changes: number; reviews: number };
}): RoundDecision {
	if (input.aborted) return { action: "end", reason: "interrupted" };
	const gate = input.gate;
	if (gate.state === "none") return { action: "end", reason: "settled" };
	if (gate.state === "passed") return { action: "end", reason: "verified" };
	if (input.overBudget) return { action: "end", reason: "budget" };
	if (input.turns >= input.maxRounds) return { action: "end", reason: "round-limit" };
	if (input.minutes !== undefined && input.elapsedMs >= input.minutes * 60_000) return { action: "end", reason: "time-limit" };
	const since = input.progressSince;
	if (since && since.changes === gate.changes && since.reviews === gate.reviews) return { action: "end", reason: "no-progress" };
	return { action: "continue", gate, round: input.turns + 1, maxRounds: input.maxRounds };
}

/** The cause sentence of each unverified gate; the instruction depends on the cause in `buildRoundMessage`. */
const CAUSE: Record<UnverifiedCause, string> = {
	"no-review": "The team changed files and no review verdict was given.",
	"stale-review": "The team changed files after the last review verdict.",
	incorrect: "The last review verdict was `incorrect`.",
};

/** The model-facing section that starts a round: why Storm sent it, what to do, and whether another round follows. */
export function buildRoundMessage(input: {
	runId: string;
	/** The round this message starts (2 for the first one Storm sends). */
	round: number;
	maxRounds: number;
	gate: Unverified;
	/** The reviewer agent's name, e.g. `storm-reviewer`. */
	reviewer: string;
}): string {
	const instruction =
		input.gate.cause === "incorrect"
			? `Fix its findings through the team, then have \`${input.reviewer}\` verify again; stop only after a \`correct\` verdict.`
			: `Have \`${input.reviewer}\` verify the current state against the task, fix what it finds through the team, and stop only after a \`correct\` verdict.`;
	const lines = [
		`<storm-run id="${input.runId}" round="${input.round}/${input.maxRounds}">`,
		`Storm checked the run when you stopped: it is not done. ${CAUSE[input.gate.cause]}`,
		instruction,
	];
	if (input.round === input.maxRounds) lines.push("This is the last round.");
	lines.push("</storm-run>");
	return lines.join("\n");
}
