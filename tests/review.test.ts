import { describe, expect, test } from "bun:test";
import { reviewLine, reviewTotals, tallyFromYield } from "../src/runtime/review.ts";
import type { AgentEntry, ReviewTally } from "../src/types.ts";
import { agentEntry } from "./fixtures.ts";

describe("tallyFromYield", () => {
	test("counts incremental findings, then the final verdict as one review", () => {
		let r = tallyFromYield(undefined, { type: ["findings"], data: { priority: 0, title: "x" } });
		expect(r).toEqual({ reviews: 0, passed: 0, failed: 0, findings: [1, 0, 0, 0] });
		r = tallyFromYield(r, { type: ["findings"], data: [{ priority: 2 }, { priority: 2 }] });
		r = tallyFromYield(r, { data: { overall_correctness: "incorrect", confidence: 0.8, findings: [{ priority: 1 }] } });
		expect(r).toEqual({ reviews: 1, passed: 0, failed: 1, findings: [1, 1, 2, 0] });
	});

	test("two verdicts from one agent are two reviews; findings add up", () => {
		let r = tallyFromYield(undefined, { data: { overall_correctness: "incorrect", confidence: 0.6, findings: [{ priority: 0 }] } });
		r = tallyFromYield(r, { data: { overall_correctness: "correct", confidence: 0.9, findings: [{ priority: 3 }] } });
		expect(r).toEqual({ reviews: 2, passed: 1, failed: 1, findings: [1, 0, 0, 1] });
	});

	test("ignores invalid priorities and non-review payloads", () => {
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
describe("doc findings", () => {
	test("doc kinds count in findings and in docFindings; code and unknown kinds only in findings", () => {
		let r = tallyFromYield(undefined, { type: ["findings"], data: { priority: 1, kind: "doc_conflict" } });
		expect(r).toEqual({ reviews: 0, passed: 0, failed: 0, findings: [0, 1, 0, 0], docFindings: 1 });
		r = tallyFromYield(r, { type: ["findings"], data: [{ priority: 2, kind: "code" }, { priority: 3, kind: "other" }] });
		expect(r?.docFindings).toBe(1);
		r = tallyFromYield(r, { data: { overall_correctness: "incorrect", confidence: 0.7, findings: [{ priority: 2, kind: "doc_copy" }] } });
		expect(r).toEqual({ reviews: 1, passed: 0, failed: 1, findings: [0, 1, 2, 1], docFindings: 2 });
		// An invalid priority is not a finding, whatever its kind.
		expect(tallyFromYield(r, { type: ["findings"], data: { priority: 9, kind: "doc_copy" } })).toBe(r);
	});

	test("a tally without doc findings has no docFindings field", () => {
		const r = tallyFromYield(undefined, { data: { overall_correctness: "correct", confidence: 1, findings: [{ priority: 0, kind: "code" }] } });
		expect(r && "docFindings" in r).toBe(false);
	});
});


describe("review totals", () => {
	const a = (review?: ReviewTally): AgentEntry => agentEntry({ name: "storm-reviewer", role: "reviewer", ...(review ? { review } : {}) });
	/** The numbers on the run summary's review line, in order. */
	const numbers = (agents: AgentEntry[]): number[] => reviewLine(agents).match(/\d+/g)?.map(Number) ?? [];

	test("sums reviews, verdicts and findings per priority across agents", () => {
		const agents = [a({ reviews: 3, passed: 1, failed: 2, findings: [1, 2, 0, 0] }), a({ reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 2], docFindings: 2 }), a()];
		expect(reviewTotals(agents)).toEqual({ reviews: 4, passed: 2, failed: 2, findings: [1, 2, 0, 2], docFindings: 2 });
		expect(reviewTotals([])).toEqual({ reviews: 0, passed: 0, failed: 0, findings: [0, 0, 0, 0], docFindings: 0 });
	});

	test("the line shows reviews, passed, failed, then each nonzero priority with its count; findings without a verdict do not count", () => {
		expect(
			numbers([
				a({ reviews: 3, passed: 1, failed: 2, findings: [1, 2, 0, 0] }),
				a({ reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 2] }),
				a({ reviews: 0, passed: 0, failed: 0, findings: [5, 0, 0, 0] }),
				a(),
			]),
		).toEqual([4, 2, 2, 0, 1, 1, 2, 3, 2]);
		expect(numbers([a({ reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] })])).toEqual([1, 1, 0]);
		// No verdict yet: one line still, without numbers.
		const none = reviewLine([a({ reviews: 0, passed: 0, failed: 0, findings: [1, 0, 0, 0] })]);
		expect(none.match(/\d/)).toBeNull();
		expect(none.startsWith("- ")).toBe(true);
		expect(none.includes("\n")).toBe(false);
	});

	test("doc findings add a doc count only when above zero", () => {
		const withDocs = numbers([
			a({ reviews: 1, passed: 0, failed: 1, findings: [0, 2, 0, 0], docFindings: 1 }),
			a({ reviews: 1, passed: 1, failed: 0, findings: [0, 0, 1, 0], docFindings: 2 }),
		]);
		expect(withDocs).toEqual([2, 1, 1, 1, 2, 2, 1, 3]);
		expect(numbers([a({ reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0], docFindings: 0 })])).toEqual([1, 1, 0]);
	});
});
