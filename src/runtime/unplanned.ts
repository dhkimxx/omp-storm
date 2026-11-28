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
};

/**
 * The two kinds of delivery the record holds. Work the run asked for (a worker it placed without a lane, or a wake it
 * sent) is out-of-plan activity; a delivery nobody asked for is an arrival. A caller marks the first with
 * `kind: "out-of-plan"`; an `unplaced` delivery from a worker this run placed is also asked for, so the views stay
 * honest for records written before that kind existed. One pass over spawns and deliveries, never a cross product.
 */
export function unplannedSplit(run: DeliveryRun): { outOfPlan: number; unasked: number } {
	const placed = new Set<string>();
	for (const spawn of Array.isArray(run.spawns) ? run.spawns : []) {
		if (spawn.outcome !== "blocked" && spawn.lane === undefined && spawn.spawnKey !== undefined) placed.add(spawn.spawnKey);
	}
	let outOfPlan = 0;
	for (const delivery of Array.isArray(run.unplanned) ? run.unplanned : []) {
		if ((delivery.kind as string) === "out-of-plan" || (delivery.kind === "unplaced" && placed.has(delivery.agent))) outOfPlan++;
	}
	const total = unplannedTotal(run);
	return { outOfPlan: Math.min(outOfPlan, total), unasked: Math.max(0, total - outOfPlan) };
}

/** `계획 밖 활동 3건`: deliveries of work this run asked for, counted apart from unsolicited arrivals. */
export function outOfPlanLine(run: DeliveryRun): string | undefined {
	const { outOfPlan } = unplannedSplit(run);
	return outOfPlan > 0 ? `계획 밖 활동 ${outOfPlan}건(결과 행은 바뀌지 않음)` : undefined;
}

/** `결과와 무관한 도착 3건`, or undefined when nobody delivered unasked. */
export function unplannedLine(run: DeliveryRun): string | undefined {
	const { unasked } = unplannedSplit(run);
	return unasked > 0 ? `결과와 무관한 도착 ${unasked}건(결과 행은 바뀌지 않음)` : undefined;
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
