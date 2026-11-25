/**
 * A goal's use across a resume chain. Records are pruned, so a resumed run carries what its earlier runs used on its
 * own record instead of the chain being recomputed. Every input is a stored record and therefore untrusted: only
 * finite values count, negatives clamp to zero and counts are integers, so a corrupt parent never yields a negative
 * or NaN total.
 */
import type { CloseoutBrief, RunRecord } from "../types.ts";

export type GoalCarry = NonNullable<RunRecord["goal"]>;
export type GoalTotals = NonNullable<CloseoutBrief["goal"]>;

/** Run ids are short handles; a longer stored label is not one this version wrote. */
const FIRST_RUN_ID_CHARS = 200;

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function time(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const at = Date.parse(value);
	return Number.isFinite(at) ? at : undefined;
}

/** The record's stored carry when it is usable; its numbers are sanitized one by one. */
function carried(run: RunRecord): GoalCarry | undefined {
	const goal: unknown = run.goal;
	if (typeof goal !== "object" || goal === null) return undefined;
	const value = goal as Record<string, unknown>;
	const firstRunId = value.firstRunId;
	if (typeof firstRunId !== "string" || firstRunId === "" || firstRunId.length > FIRST_RUN_ID_CHARS) return undefined;
	return { firstRunId, runs: count(value.runs), usd: amount(value.usd), ms: amount(value.ms), turns: count(value.turns) };
}

/** How long a run was active: up to its end, or for a run whose process died, up to its last live write. */
export function activeMs(run: RunRecord): number {
	const start = time(run.startedAt);
	if (start === undefined) return 0;
	const end = time(run.endedAt) ?? time(run.updatedAt) ?? start;
	return amount(end - start);
}

/** What a resume of `parent` carries: the parent's own carry plus the parent's own use. */
export function carryGoal(parent: RunRecord): GoalCarry {
	const prior = carried(parent);
	return {
		firstRunId: prior?.firstRunId ?? parent.runId,
		runs: count((prior?.runs ?? 0) + 1),
		usd: amount((prior?.usd ?? 0) + amount(parent.costUsd)),
		ms: amount((prior?.ms ?? 0) + activeMs(parent)),
		turns: count((prior?.turns ?? 0) + count(parent.turns)),
	};
}

/**
 * The whole goal's use, this run included; `undefined` for a record that continues nothing. A running record's own
 * time runs to `now`, since its end is not written yet.
 */
export function goalTotals(run: RunRecord, now: number): GoalTotals | undefined {
	const carry = carried(run);
	if (carry === undefined) return undefined;
	const start = time(run.startedAt);
	const own = run.status === "running" ? (start === undefined ? 0 : amount(now - start)) : activeMs(run);
	return {
		runs: count(carry.runs + 1),
		usd: amount(carry.usd + amount(run.costUsd)),
		ms: amount(carry.ms + own),
		turns: count(carry.turns + count(run.turns)),
	};
}
