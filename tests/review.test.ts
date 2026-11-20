import { describe, expect, test } from "bun:test";
import { reviewFromYield, reviewLine } from "../src/runtime/review.ts";
import type { AgentEntry, ReviewVerdict } from "../src/types.ts";

describe("reviewFromYield", () => {
	test("counts incremental findings, then takes the final verdict", () => {
		let r = reviewFromYield(undefined, { type: ["findings"], data: { priority: 0, title: "x" } });
		expect(r).toEqual({ findings: [1, 0, 0, 0] });
		r = reviewFromYield(r, { type: ["findings"], data: [{ priority: 2 }, { priority: 2 }] });
		r = reviewFromYield(r, { data: { overall_correctness: "incorrect", confidence: 0.8, findings: [{ priority: 1 }] } });
		expect(r).toEqual({ verdict: "incorrect", confidence: 0.8, findings: [1, 1, 2, 0] });
	});

	test("ignores invalid priorities, bad confidence and non-review payloads", () => {
		const prev: ReviewVerdict = { findings: [0, 1, 0, 0] };
		expect(reviewFromYield(prev, { type: ["findings"], data: [{ priority: 4 }, { priority: 1.5 }, { priority: "0" }, {}] })).toBe(prev);
		expect(reviewFromYield(prev, { error: "boom" })).toBe(prev);
		expect(reviewFromYield(prev, { data: { summary: "done" } })).toBe(prev);
		expect(reviewFromYield(undefined, { data: { overall_correctness: "maybe" } })).toBeUndefined();
		expect(reviewFromYield(prev, { data: { overall_correctness: "correct", confidence: 2 } })).toEqual({ verdict: "correct", findings: [0, 1, 0, 0] });
		// The input is never mutated through prev.
		expect(prev.findings).toEqual([0, 1, 0, 0]);
	});
});

describe("reviewLine", () => {
	const a = (review?: ReviewVerdict): AgentEntry => ({
		id: "x",
		name: "storm-reviewer",
		state: "idle",
		startedAt: 0,
		lastActivityAt: 0,
		contextTokens: 0,
		requests: 0,
		costUsd: 0,
		followUps: 0,
		...(review ? { review } : {}),
	});

	test("sums verdicts and nonzero priorities; findings without a verdict do not count", () => {
		expect(
			reviewLine([
				a({ verdict: "correct", findings: [0, 0, 0, 2] }),
				a({ verdict: "incorrect", findings: [1, 2, 0, 0] }),
				a({ findings: [5, 0, 0, 0] }),
				a(),
			]),
		).toBe("- 리뷰: 통과 1 · 수정 필요 1 (P0 1 · P1 2 · P3 2)");
		expect(reviewLine([a({ verdict: "correct", findings: [0, 0, 0, 0] })])).toBe("- 리뷰: 통과 1 · 수정 필요 0");
		expect(reviewLine([a({ findings: [1, 0, 0, 0] })])).toBe("- 리뷰: 없음");
	});
});
