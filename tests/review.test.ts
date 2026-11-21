import { describe, expect, test } from "bun:test";
import { reviewLine, tallyFromYield } from "../src/runtime/review.ts";
import type { AgentEntry, ReviewTally } from "../src/types.ts";

describe("tallyFromYield", () => {
	test("counts incremental findings, then the final verdict as one review", () => {
		let r = tallyFromYield(undefined, { type: ["findings"], data: { priority: 0, title: "x" } });
		expect(r).toEqual({ reviews: 0, passed: 0, failed: 0, findings: [1, 0, 0, 0] });
		r = tallyFromYield(r, { type: ["findings"], data: [{ priority: 2 }, { priority: 2 }] });
		r = tallyFromYield(r, { data: { overall_correctness: "incorrect", confidence: 0.8, findings: [{ priority: 1 }] } });
		expect(r).toEqual({ reviews: 1, passed: 0, failed: 1, findings: [1, 1, 2, 0], lastConfidence: 0.8 });
	});

	test("two verdicts from one agent are two reviews; findings add up", () => {
		let r = tallyFromYield(undefined, { data: { overall_correctness: "incorrect", confidence: 0.6, findings: [{ priority: 0 }] } });
		r = tallyFromYield(r, { data: { overall_correctness: "correct", confidence: 0.9, findings: [{ priority: 3 }] } });
		expect(r).toEqual({ reviews: 2, passed: 1, failed: 1, findings: [1, 0, 0, 1], lastConfidence: 0.9 });
	});

	test("ignores invalid priorities, bad confidence and non-review payloads", () => {
		const prev: ReviewTally = { reviews: 0, passed: 0, failed: 0, findings: [0, 1, 0, 0] };
		expect(tallyFromYield(prev, { type: ["findings"], data: [{ priority: 4 }, { priority: 1.5 }, { priority: "0" }, {}] })).toBe(prev);
		expect(tallyFromYield(prev, { error: "boom" })).toBe(prev);
		expect(tallyFromYield(prev, { data: { summary: "done" } })).toBe(prev);
		expect(tallyFromYield(undefined, { data: { overall_correctness: "maybe" } })).toBeUndefined();
		expect(tallyFromYield(prev, { data: { overall_correctness: "correct", confidence: 2 } })).toEqual({
			reviews: 1,
			passed: 1,
			failed: 0,
			findings: [0, 1, 0, 0],
		});
		// The input is never mutated through prev.
		expect(prev).toEqual({ reviews: 0, passed: 0, failed: 0, findings: [0, 1, 0, 0] });
	});
});

describe("reviewLine", () => {
	const a = (review?: ReviewTally): AgentEntry => ({
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

	test("sums reviews and nonzero priorities across agents; findings without a verdict do not count", () => {
		expect(
			reviewLine([
				a({ reviews: 3, passed: 1, failed: 2, findings: [1, 2, 0, 0] }),
				a({ reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 2] }),
				a({ reviews: 0, passed: 0, failed: 0, findings: [5, 0, 0, 0] }),
				a(),
			]),
		).toBe("- 리뷰 4회: 통과 2 · 수정 필요 2 (P0 1 · P1 2 · P3 2)");
		expect(reviewLine([a({ reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] })])).toBe("- 리뷰 1회: 통과 1 · 수정 필요 0");
		expect(reviewLine([a({ reviews: 0, passed: 0, failed: 0, findings: [1, 0, 0, 0] })])).toBe("- 리뷰: 없음");
	});
});
