/** Reviewer verdicts read from omp's `yield` tool args, and the one line the summary and status show. */
import type { AgentEntry, ReviewVerdict } from "../types.ts";

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

/** Counts findings with an integer priority 0..3 into a copy of `findings`; returns how many counted. */
function countFindings(findings: ReviewVerdict["findings"], list: unknown): number {
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

/** Folds one `yield` call (`{ data?, type?, error? }`) into the verdict; unrelated input returns `prev`. */
export function reviewFromYield(prev: ReviewVerdict | undefined, input: unknown): ReviewVerdict | undefined {
	if (typeof input !== "object" || input === null) return prev;
	const findings: ReviewVerdict["findings"] = prev ? [...prev.findings] : [0, 0, 0, 0];
	const { data, type } = input as YieldArgs;
	if (Array.isArray(type) && type.includes("findings")) {
		if (countFindings(findings, data) === 0) return prev;
		return { ...prev, findings };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return prev;
	const final = data as FinalPayload;
	const verdict = final.overall_correctness;
	if (verdict !== "correct" && verdict !== "incorrect") return prev;
	const next: ReviewVerdict = { ...prev, verdict, findings };
	const confidence = final.confidence;
	if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) next.confidence = confidence;
	if (Array.isArray(final.findings)) countFindings(findings, final.findings);
	return next;
}

/** `- 리뷰: 통과 N · 수정 필요 M (P0 a · P1 b)`, or `- 리뷰: 없음` when no agent has a verdict. */
export function reviewLine(agents: readonly AgentEntry[]): string {
	let pass = 0;
	let fail = 0;
	const totals = [0, 0, 0, 0];
	for (const agent of agents) {
		const review = agent.review;
		if (!review?.verdict) continue;
		if (review.verdict === "correct") pass++;
		else fail++;
		review.findings.forEach((n, i) => {
			totals[i] = (totals[i] ?? 0) + n;
		});
	}
	if (pass + fail === 0) return "- 리뷰: 없음";
	const ps = totals.flatMap((n, i) => (n > 0 ? [`P${i} ${n}`] : []));
	return `- 리뷰: 통과 ${pass} · 수정 필요 ${fail}${ps.length ? ` (${ps.join(" · ")})` : ""}`;
}
