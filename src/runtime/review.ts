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
	kind?: unknown;
}

/** Findings and doc findings counted from one yield. */
interface Counts {
	findings: ReviewTally["findings"];
	docs: number;
}

/**
 * Counts findings with an integer priority 0..3 into `counts.findings`, and those of kind `doc_conflict` or
 * `doc_copy` also into `counts.docs`; returns how many counted.
 */
function countFindings(counts: Counts, list: unknown): number {
	let counted = 0;
	for (const f of Array.isArray(list) ? list : [list]) {
		if (typeof f !== "object" || f === null) continue;
		const { priority: p, kind } = f as Finding;
		if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 3) continue;
		counts.findings[p as 0 | 1 | 2 | 3]++;
		if (kind === "doc_conflict" || kind === "doc_copy") counts.docs++;
		counted++;
	}
	return counted;
}

const EMPTY: ReviewTally = { reviews: 0, passed: 0, failed: 0, findings: [0, 0, 0, 0] };

/** `base` with new finding counts; `docFindings` appears once a doc finding was counted. */
function withCounts(base: ReviewTally, counts: Counts): ReviewTally {
	const next: ReviewTally = { ...base, findings: counts.findings };
	if (counts.docs > 0) next.docFindings = counts.docs;
	return next;
}

/**
 * Folds one `yield` call (`{ data?, type?, error? }`) into the tally: a findings section adds its findings, a final
 * payload with `overall_correctness` is one more review (plus its findings). Doc findings count in `findings` and in
 * `docFindings`. Unrelated input returns `prev`.
 */
export function tallyFromYield(prev: ReviewTally | undefined, input: unknown): ReviewTally | undefined {
	if (typeof input !== "object" || input === null) return prev;
	const base = prev ?? EMPTY;
	const counts: Counts = { findings: [...base.findings], docs: base.docFindings ?? 0 };
	const { data, type } = input as YieldArgs;
	if (Array.isArray(type) && type.includes("findings")) {
		if (countFindings(counts, data) === 0) return prev;
		return withCounts(base, counts);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return prev;
	const final = data as FinalPayload;
	const verdict = final.overall_correctness;
	if (verdict !== "correct" && verdict !== "incorrect") return prev;
	if (Array.isArray(final.findings)) countFindings(counts, final.findings);
	const next = withCounts(
		{
			...base,
			reviews: base.reviews + 1,
			passed: base.passed + (verdict === "correct" ? 1 : 0),
			failed: base.failed + (verdict === "incorrect" ? 1 : 0),
		},
		counts,
	);
	const confidence = final.confidence;
	if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) next.lastConfidence = confidence;
	return next;
}

/**
 * `- 리뷰 N회: 통과 a · 수정 필요 b (P0 x · P1 y) · 문서 상충 d건` summed over agents (the doc part only when above
 * zero), or `- 리뷰: 없음` before any verdict.
 */
export function reviewLine(agents: readonly AgentEntry[]): string {
	let passed = 0;
	let failed = 0;
	let docs = 0;
	const totals = [0, 0, 0, 0];
	for (const agent of agents) {
		const review = agent.review;
		if (!review || review.reviews === 0) continue;
		passed += review.passed;
		failed += review.failed;
		docs += review.docFindings ?? 0;
		review.findings.forEach((n, i) => {
			totals[i] = (totals[i] ?? 0) + n;
		});
	}
	const reviews = passed + failed;
	if (reviews === 0) return "- 리뷰: 없음";
	const ps = totals.flatMap((n, i) => (n > 0 ? [`P${i} ${n}`] : []));
	return `- 리뷰 ${reviews}회: 통과 ${passed} · 수정 필요 ${failed}${ps.length ? ` (${ps.join(" · ")})` : ""}${docs > 0 ? ` · 문서 상충 ${docs}건` : ""}`;
}
