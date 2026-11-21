/** Reviewer yields from omp's `yield` tool args counted as reviews, and the one line the summary and status show. */
import type { AgentEntry, ReviewTally } from "../types.ts";

/** The parts of omp's `yield` args Storm reads; every field is checked before use. */
interface YieldArgs {
	data?: unknown;
	type?: unknown;
}
interface FinalPayload {
	overall_correctness?: unknown;
	confidence?: unknown;
	findings?: unknown;
}
interface Finding {
	priority?: unknown;
}

/** Counts findings with an integer priority 0..3 into `findings`; returns how many counted. */
function countFindings(findings: ReviewTally["findings"], list: unknown): number {
	let counted = 0;
	for (const f of Array.isArray(list) ? list : [list]) {
		if (typeof f !== "object" || f === null) continue;
		const p = (f as Finding).priority;
		if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 3) continue;
		findings[p as 0 | 1 | 2 | 3]++;
		counted++;
	}
	return counted;
}

const EMPTY: ReviewTally = { reviews: 0, passed: 0, failed: 0, findings: [0, 0, 0, 0] };

/**
 * Folds one `yield` call (`{ data?, type?, error? }`) into the tally: a findings section adds its findings, a final
 * payload with `overall_correctness` is one more review (plus its findings). Unrelated input returns `prev`.
 */
export function tallyFromYield(prev: ReviewTally | undefined, input: unknown): ReviewTally | undefined {
	if (typeof input !== "object" || input === null) return prev;
	const base = prev ?? EMPTY;
	const findings: ReviewTally["findings"] = [...base.findings];
	const { data, type } = input as YieldArgs;
	if (Array.isArray(type) && type.includes("findings")) {
		if (countFindings(findings, data) === 0) return prev;
		return { ...base, findings };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return prev;
	const final = data as FinalPayload;
	const verdict = final.overall_correctness;
	if (verdict !== "correct" && verdict !== "incorrect") return prev;
	if (Array.isArray(final.findings)) countFindings(findings, final.findings);
	const next: ReviewTally = {
		...base,
		reviews: base.reviews + 1,
		passed: base.passed + (verdict === "correct" ? 1 : 0),
		failed: base.failed + (verdict === "incorrect" ? 1 : 0),
		findings,
	};
	const confidence = final.confidence;
	if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) next.lastConfidence = confidence;
	return next;
}

/** `- 리뷰 N회: 통과 a · 수정 필요 b (P0 x · P1 y)` summed over agents, or `- 리뷰: 없음` before any verdict. */
export function reviewLine(agents: readonly AgentEntry[]): string {
	let passed = 0;
	let failed = 0;
	const totals = [0, 0, 0, 0];
	for (const agent of agents) {
		const review = agent.review;
		if (!review || review.reviews === 0) continue;
		passed += review.passed;
		failed += review.failed;
		review.findings.forEach((n, i) => {
			totals[i] = (totals[i] ?? 0) + n;
		});
	}
	const reviews = passed + failed;
	if (reviews === 0) return "- 리뷰: 없음";
	const ps = totals.flatMap((n, i) => (n > 0 ? [`P${i} ${n}`] : []));
	return `- 리뷰 ${reviews}회: 통과 ${passed} · 수정 필요 ${failed}${ps.length ? ` (${ps.join(" · ")})` : ""}`;
}
