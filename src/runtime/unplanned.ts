import { formatUsd } from "../policy/spawn.ts";
import type { RunRecord, UnplannedDelivery } from "../types.ts";

/** The most deliveries one run record keeps; the count past it stays in `unplannedCount`. Oldest are dropped first. */
export const UNPLANNED_MAX = 100;

/** An agent id inside a notice or a line is cut here: it is host text and must not widen a request. */
const AGENT_SHOWN_MAX = 40;

const clip = (value: string, max: number): string => {
	// Control characters and line separators become spaces, so one id can never start a second line.
	const plain = Array.from(value, ch => {
		const code = ch.codePointAt(0) ?? 0;
		return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? " " : ch;
	}).join("");
	const text = plain.replace(/\s+/g, " ").trim();
	const points = Array.from(text);
	return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
};

/**
 * The one line the director reads for a delivery that answers no declared result, once per delivery. It says what the
 * delivery is not: it changed no result row and is not counted as accepted. The agent id is host text, shown clipped.
 */
export function unplannedNotice(delivery: Pick<UnplannedDelivery, "agent" | "kind">): string {
	const why = delivery.kind === "woken" ? "이미 답한 워커가 다시 깨어나 답함" : "결과가 걸린 작업이 아님";
	return `[storm] 결과와 무관한 도착 — 워커 ${clip(delivery.agent, AGENT_SHOWN_MAX)}: ${why}. 결과 행은 그대로이고 이행으로 세지 않습니다.`;
}

/** How many deliveries the run received that belong to no declared result (the list may hold fewer once it was cut). */
export function unplannedTotal(run: { readonly unplanned?: RunRecord["unplanned"]; readonly unplannedCount?: RunRecord["unplannedCount"] }): number {
	const kept = Array.isArray(run.unplanned) ? run.unplanned.length : 0;
	const counted = typeof run.unplannedCount === "number" && Number.isFinite(run.unplannedCount) ? Math.max(0, Math.floor(run.unplannedCount)) : 0;
	return Math.max(kept, counted);
}

/** What the delivery views read: the record may hold any of these parts. */
type DeliveryRun = {
	readonly spawns?: RunRecord["spawns"];
	readonly unplanned?: RunRecord["unplanned"];
	readonly unplannedCount?: RunRecord["unplannedCount"];
	readonly unplannedAsked?: RunRecord["unplannedAsked"];
	readonly unplannedUnasked?: RunRecord["unplannedUnasked"];
};

/** What the kept deliveries of one group carried: a completed result, a Storm stop, a host failure, or no verdict. */
export interface DeliveryOutcomes {
	/** Deliveries the record kept for this group (never more than the group's count). */
	readonly kept: number;
	readonly completed: number;
	/** A delivery whose worker this run's spawn record says Storm stopped. */
	readonly stopped: number;
	readonly failed: number;
	/** A delivery whose host status the record does not hold. */
	readonly unknown: number;
}

export interface UnplannedSplit {
	readonly outOfPlan: number;
	readonly unasked: number;
	/** Deliveries the bounded list still holds; the counts above include deliveries it no longer holds. */
	readonly kept: number;
	/** Outcomes of the kept out-of-plan deliveries; never a per-worker list. */
	readonly outOfPlanOutcomes: DeliveryOutcomes;
	/** Outcomes of the kept unasked deliveries. */
	readonly unaskedOutcomes: DeliveryOutcomes;
}

const stoppedByStorm = (run: DeliveryRun): Set<string> => {
	const stopped = new Set<string>();
	for (const spawn of Array.isArray(run.spawns) ? run.spawns : []) {
		if (spawn.stop !== undefined && spawn.spawnKey !== undefined) stopped.add(spawn.spawnKey);
	}
	return stopped;
};

/** One delivery's outcome, as the host's own status and this run's stop fact say. */
function outcomeOf(delivery: UnplannedDelivery, stopped: ReadonlySet<string>): keyof Omit<DeliveryOutcomes, "kept"> {
	// A completed turn delivered a result whatever later happened to the worker.
	if (delivery.status === "completed") return "completed";
	if (stopped.has(delivery.agent)) return "stopped";
	if (delivery.status === "failed" || delivery.status === "cancelled") return "failed";
	return "unknown";
}

/**
 * The two kinds of delivery the record holds. Work the run asked for (a worker it placed without a lane, or a wake it
 * sent) is out-of-plan activity; a delivery nobody asked for is an arrival. A caller marks the first with
 * `kind: "out-of-plan"`; an `unplaced` delivery from a worker this run placed is also asked for, so the views stay
 * honest for records written before that kind existed. One pass over spawns and deliveries, never a cross product.
 * The outcome counts say what the kept deliveries carried: a failed or Storm-stopped delivery is not a result, so the
 * arrival count never reads as if every started worker had answered (fault 4).
 */
export function unplannedSplit(run: DeliveryRun): UnplannedSplit {
	const placed = new Set<string>();
	for (const spawn of Array.isArray(run.spawns) ? run.spawns : []) {
		if (spawn.outcome !== "blocked" && spawn.lane === undefined && spawn.spawnKey !== undefined) placed.add(spawn.spawnKey);
	}
	const stopped = stoppedByStorm(run);
	let listAsked = 0;
	const outOfPlanOutcomes = { kept: 0, completed: 0, stopped: 0, failed: 0, unknown: 0 };
	const unaskedOutcomes = { kept: 0, completed: 0, stopped: 0, failed: 0, unknown: 0 };
	const deliveries = Array.isArray(run.unplanned) ? run.unplanned : [];
	for (const delivery of deliveries) {
		const asked = (delivery.kind as string) === "out-of-plan" || (delivery.kind === "unplaced" && placed.has(delivery.agent));
		const bucket = asked ? outOfPlanOutcomes : unaskedOutcomes;
		bucket.kept += 1;
		bucket[outcomeOf(delivery, stopped)] += 1;
		if (asked) listAsked += 1;
	}
	const total = unplannedTotal(run);
	// F2: the two numbers are counted when each delivery is recorded. They must not be read from the kept list: past
	// its bound every dropped asked-for delivery would become an unasked arrival. An old record has no counts, so it
	// falls back to the list it kept.
	const recordedAsked =
		typeof run.unplannedAsked === "number" && Number.isFinite(run.unplannedAsked) ? Math.max(0, Math.floor(run.unplannedAsked)) : undefined;
	const recordedUnasked =
		typeof run.unplannedUnasked === "number" && Number.isFinite(run.unplannedUnasked) ? Math.max(0, Math.floor(run.unplannedUnasked)) : undefined;
	let outOfPlan: number;
	let unasked: number;
	if (recordedAsked === undefined && recordedUnasked === undefined) {
		outOfPlan = Math.min(listAsked, total);
		unasked = Math.max(0, total - outOfPlan);
	} else if (recordedAsked !== undefined) {
		// Every delivery increments the total and exactly one of the two counts, so the recorded asked count is the
		// asked number; the remainder is unasked. A partial record still names every delivery exactly once.
		outOfPlan = Math.min(recordedAsked, total);
		unasked = Math.max(0, total - outOfPlan);
	} else {
		unasked = Math.min(recordedUnasked ?? 0, total);
		outOfPlan = Math.max(0, total - unasked);
	}
	return {
		outOfPlan,
		unasked,
		kept: deliveries.length,
		outOfPlanOutcomes,
		unaskedOutcomes,
	};
}

/** `완료 8 · Storm 중단 8 · 실패 1`: what the kept deliveries carried. Empty when there is nothing to say. */
function outcomesText(outcomes: DeliveryOutcomes): string | undefined {
	const parts: string[] = [];
	if (outcomes.completed > 0) parts.push(`완료 ${outcomes.completed}`);
	if (outcomes.stopped > 0) parts.push(`Storm 중단 ${outcomes.stopped}`);
	if (outcomes.failed > 0) parts.push(`실패 ${outcomes.failed}`);
	if (outcomes.unknown > 0) parts.push(`결과 미상 ${outcomes.unknown}`);
	return parts.length === 0 ? undefined : parts.join(" · ");
}

/** The same counts inside the bounded line; `basis` says when the split covers only the kept deliveries. */
function outcomeClause(outcomes: DeliveryOutcomes, total: number, kept: number): string {
	const text = outcomesText(outcomes);
	const basis = total > kept ? `보관한 ${kept}건 기준` : undefined;
	const parts = [text, basis].filter((part): part is string => part !== undefined);
	return parts.length === 0 ? "" : `(${parts.join("; ")}; 결과 행은 바뀌지 않음)`;
}

/** The same fact in the English handoff: counts only, no per-worker text. */
export function handoffOutcomes(outcomes: DeliveryOutcomes): string | undefined {
	const parts: string[] = [];
	if (outcomes.completed > 0) parts.push(`completed ${outcomes.completed}`);
	if (outcomes.stopped > 0) parts.push(`Storm-stopped ${outcomes.stopped}`);
	if (outcomes.failed > 0) parts.push(`failed ${outcomes.failed}`);
	if (outcomes.unknown > 0) parts.push(`outcome unknown ${outcomes.unknown}`);
	return parts.length === 0 ? undefined : parts.join(", ");
}

/** `계획 밖 활동 3건`: deliveries of work this run asked for, counted apart from unsolicited arrivals. */
export function outOfPlanLine(run: DeliveryRun): string | undefined {
	const split = unplannedSplit(run);
	if (split.outOfPlan === 0) return undefined;
	return `계획 밖 활동 ${split.outOfPlan}건${outcomeClause(split.outOfPlanOutcomes, split.outOfPlan, split.outOfPlanOutcomes.kept)}`;
}

/** `결과와 무관한 도착 3건`, or undefined when nobody delivered unasked. */
export function unplannedLine(run: DeliveryRun): string | undefined {
	const split = unplannedSplit(run);
	if (split.unasked === 0) return undefined;
	return `결과와 무관한 도착 ${split.unasked}건${outcomeClause(split.unaskedOutcomes, split.unasked, split.unaskedOutcomes.kept)}`;
}

/**
 * `사용자 직접 지시 2회 · 사용자 정지 1회`: turns the user started or stopped from omp's hub, counted apart from the
 * director's work. Undefined when the user did neither.
 */
export function userDirectedLine(run: Pick<RunRecord, "agents">): string | undefined {
	let turns = 0;
	let stops = 0;
	for (const agent of run.agents ?? []) {
		turns += agent.userTurns ?? 0;
		stops += agent.userStops ?? 0;
	}
	const parts = [...(turns > 0 ? [`사용자 직접 지시 ${turns}회`] : []), ...(stops > 0 ? [`사용자 정지 ${stops}회(판정 전 종료)`] : [])];
	return parts.length === 0 ? undefined : parts.join(" · ");
}

/**
 * The run's total spend as one phrase. A floor says so: Storm saw model calls it could not read back. A record from
 * before 0.27 has no note and reads as it always did.
 */
export function spendText(run: Pick<RunRecord, "costUsd" | "spend" | "budget">): string {
	const total = formatUsd(Number.isFinite(run.costUsd) ? run.costUsd : 0);
	const budget = run.budget === undefined ? "" : `/${formatUsd(run.budget.perRunUsd)}`;
	const floor = run.spend?.lowerBound === true ? "(하한: 읽지 못한 모델 호출 있음)" : "";
	return `${total}${budget}${floor}`;
}
