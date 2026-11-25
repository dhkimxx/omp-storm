/**
 * Scoped answer review (S1): a reviewable answer is settled only by the approved reviewer's final verdict that names
 * its id with the exact receipt Storm issued for that submission and the anchor citation it was judged against. A
 * plain change/tree verdict, another answer's entry, a reused or older verdict, a wrong receipt or anchor, or a
 * reviewer that wrote files settles nothing.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { answerReviewAnchor, answerReviewPacket, answerReviewReceipt, answerReviewVerdict, type AnswerReviewSubject } from "../src/runtime/answer-review.ts";
import { listAgents, noteAgentReview, noteAgentStart, resetAgents } from "../src/runtime/agents.ts";
import { reviewEvidenceOf, reviewPart, reviewedResultsIn, REVIEWED_RESULTS_MAX } from "../src/runtime/review.ts";
import type { AgentEntry } from "../src/types.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM = teamOf({ explorer: "a/x", implementer: "a/i", reviewer: "a/r" });
const SCOPE = "/profiles/test/storm/sessions/answer-review";
const VERSION_A = "a".repeat(64);
const VERSION_B = "b".repeat(64);

const subject = (over: Partial<AnswerReviewSubject> = {}): AnswerReviewSubject => ({
	runId: "run-1",
	resultId: "auth",
	attemptId: "job:a1:read-1",
	contentVersion: VERSION_A,
	citation: { path: "auth.md", line: 1 },
	seenAt: T0 + 10,
	...over,
});
const receiptOf = (over: Partial<AnswerReviewSubject> = {}): string => {
	const receipt = answerReviewReceipt(subject(over));
	if (receipt === undefined) throw new Error("no receipt");
	return receipt;
};

/** The approved reviewer's ledger entry with one final verdict record. */
function reviewer(at: number, correct: boolean, results?: unknown[], over: Partial<AgentEntry> = {}): AgentEntry {
	const record = { at, correct, findings: [], tree: "d:f", ...(results === undefined ? {} : { results }) };
	return {
		...agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at, correct, tree: "d:f" }, ...over }),
		reviewLog: [record],
	} as AgentEntry;
}
const scoped = (verdict: "correct" | "incorrect", over: Record<string, unknown> = {}) => ({
	id: "auth",
	receipt: receiptOf(),
	citation: "auth.md:1",
	correct: verdict === "correct",
	...over,
});

describe("receipts", () => {
	test("a receipt names one submission in one run and attempt", () => {
		const receipt = receiptOf();
		expect(receipt).toMatch(/^[0-9a-f]{32}$/u);
		expect(receiptOf()).toBe(receipt);
		expect(receiptOf({ runId: "run-2" })).not.toBe(receipt);
		expect(receiptOf({ attemptId: "job:a2:read-1" })).not.toBe(receipt);
		expect(receiptOf({ contentVersion: VERSION_B })).not.toBe(receipt);
		expect(receiptOf({ resultId: "other" })).not.toBe(receipt);
		expect(answerReviewReceipt(subject({ contentVersion: "not-a-digest" }))).toBeUndefined();
		expect(answerReviewAnchor({ path: "auth.md" })).toBe("auth.md");
		expect(answerReviewAnchor({ path: "auth.md", line: 3 })).toBe("auth.md:3");
	});

	test("the packet quotes the answer verbatim and names the exact entry to return", () => {
		const packet = answerReviewPacket({ resultId: "auth", criterion: "says whether authentication is enabled", answer: "It is off.", receipt: receiptOf(), citation: { path: "auth.md", line: 1 } });
		expect(packet).toContain("It is off.");
		expect(packet).toContain(receiptOf());
		expect(packet).toContain('"citation": "auth.md:1"');
	});
});

describe("reviewer yield parsing", () => {
	const final = (results: unknown) => ({ data: { overall_correctness: "correct", explanation: "ok", confidence: 0.9, results } });

	test("scoped results are read from a final verdict only, exactly once per id", () => {
		const receipt = receiptOf();
		const part = reviewPart(final([{ id: "auth", receipt, citation: "auth.md:1", verdict: "incorrect" }]));
		expect(part).toEqual({ kind: "verdict", findings: [], correct: true, results: [{ id: "auth", receipt, citation: "auth.md:1", correct: false }] });
		// A plain change verdict scopes nothing.
		expect(reviewPart({ data: { overall_correctness: "correct" } })).toEqual({ kind: "verdict", findings: [], correct: true });
		// A findings section never carries result verdicts.
		expect(reviewPart({ type: ["findings"], data: { priority: 1, results: [{ id: "auth", receipt, citation: "auth.md:1", verdict: "correct" }] } })).toEqual({
			kind: "findings",
			findings: [{ priority: 1 }],
		});
	});

	test("malformed, ambiguous or oversized result lists scope nothing", () => {
		const receipt = receiptOf();
		const good = { id: "auth", receipt, citation: "auth.md:1", verdict: "correct" };
		expect(reviewedResultsIn([{ ...good, receipt: receipt.toUpperCase() }])).toEqual([]);
		expect(reviewedResultsIn([{ ...good, verdict: "maybe" }])).toEqual([]);
		expect(reviewedResultsIn([{ ...good, id: "../auth" }])).toEqual([]);
		expect(reviewedResultsIn([{ ...good, citation: " auth.md:1" }])).toEqual([]);
		expect(reviewedResultsIn([good, { ...good, verdict: "incorrect" }])).toEqual([]);
		expect(reviewedResultsIn(Array.from({ length: REVIEWED_RESULTS_MAX + 1 }, (_, index) => ({ ...good, id: `r${index}` })))).toEqual([]);
		expect(reviewedResultsIn([good, { ...good, id: "other" }]).map(entry => entry.id)).toEqual(["auth", "other"]);
	});

	test("the ledger keeps scoped results on their own verdict record and rejects a tampered one", () => {
		resetAgents();
		noteAgentStart({ id: "Rev", name: "storm-reviewer", role: "reviewer", runId: "run-1", scope: SCOPE, now: T0 });
		const receipt = receiptOf();
		noteAgentReview("Rev", final([{ id: "auth", receipt, citation: "auth.md:1", verdict: "correct" }]), T0 + 20, SCOPE);
		noteAgentReview("Rev", { data: { overall_correctness: "correct" } }, T0 + 30, SCOPE);
		const [entry] = listAgents({ scope: SCOPE });
		if (entry === undefined) throw new Error("no ledger entry");
		const ledger = reviewEvidenceOf(entry);
		expect(ledger.complete).toBe(true);
		expect(ledger.records.map(record => record.results)).toEqual([[{ id: "auth", receipt, citation: "auth.md:1", correct: true }], undefined]);

		const tampered = { ...entry, reviewLog: [{ at: T0 + 20, correct: true, findings: [], results: [{ id: "auth", receipt: "x", citation: "auth.md:1", correct: true }] }] } as AgentEntry;
		expect(reviewEvidenceOf(tampered).complete).toBe(false);
		const onFindings = { ...entry, reviewLog: [{ at: T0 + 20, findings: [], results: [{ id: "auth", receipt, citation: "auth.md:1", correct: true }] }] } as AgentEntry;
		expect(reviewEvidenceOf(onFindings).complete).toBe(false);
	});
});

describe("which verdict settles an answer", () => {
	beforeEach(resetAgents);

	test("only an explicitly scoped verdict for this exact submission settles it", () => {
		expect(answerReviewVerdict([reviewer(T0 + 20, true, [scoped("correct")])], TEAM, subject())).toEqual({ state: "correct", at: T0 + 20, author: "Rev" });
		expect(answerReviewVerdict([reviewer(T0 + 20, true, [scoped("incorrect")])], TEAM, subject())).toMatchObject({ state: "incorrect" });
		// Answer correctness is independent of the change verdict in the same payload.
		expect(answerReviewVerdict([reviewer(T0 + 20, false, [scoped("correct")])], TEAM, subject())).toMatchObject({ state: "correct" });
	});

	test("a generic, other-answer, wrong-receipt or wrong-anchor verdict leaves the answer reviewable", () => {
		const none = { state: "none" } as const;
		// A plain correct tree/change verdict.
		expect(answerReviewVerdict([reviewer(T0 + 20, true)], TEAM, subject())).toEqual(none);
		// Another answer's entry, even with this answer's receipt.
		expect(answerReviewVerdict([reviewer(T0 + 20, true, [scoped("correct", { id: "other" })])], TEAM, subject())).toEqual(none);
		// A receipt for another submission, attempt or run.
		for (const receipt of [receiptOf({ contentVersion: VERSION_B }), receiptOf({ attemptId: "job:a0:read-1" }), receiptOf({ runId: "run-0" })]) {
			expect(answerReviewVerdict([reviewer(T0 + 20, true, [scoped("correct", { receipt })])], TEAM, subject())).toEqual(none);
		}
		// Another anchor than the one S1 judged.
		for (const citation of ["auth.md", "auth.md:2", "other.md:1"]) {
			expect(answerReviewVerdict([reviewer(T0 + 20, true, [scoped("correct", { citation })])], TEAM, subject())).toEqual(none);
		}
	});

	test("an older, reused, writing or unapproved reviewer verdict settles nothing", () => {
		const none = { state: "none" } as const;
		const entry = [scoped("correct")];
		// Given before this run held the submission (or at the same instant).
		expect(answerReviewVerdict([reviewer(T0 + 5, true, entry)], TEAM, subject())).toEqual(none);
		expect(answerReviewVerdict([reviewer(T0 + 10, true, entry)], TEAM, subject())).toEqual(none);
		// A reviewer that changed files, one from another run, or not the approved reviewer agent.
		expect(answerReviewVerdict([reviewer(T0 + 20, true, entry, { changes: 1 })], TEAM, subject())).toEqual(none);
		expect(answerReviewVerdict([reviewer(T0 + 20, true, entry, { runId: "run-0" })], TEAM, subject())).toEqual(none);
		expect(answerReviewVerdict([reviewer(T0 + 20, true, entry, { name: "storm-explorer", role: "explorer" })], TEAM, subject())).toEqual(none);
		expect(answerReviewVerdict([reviewer(T0 + 20, true, entry)], teamOf({ explorer: "a/x" }), subject())).toEqual(none);
		// A log that cannot be trusted proves nothing.
		expect(answerReviewVerdict([{ ...reviewer(T0 + 20, true, entry), reviewLogOverflow: true } as AgentEntry], TEAM, subject())).toEqual(none);
	});

	test("one review may settle several answers only when each is scoped; the newest verdict wins and a tie fails closed", () => {
		const other = subject({ resultId: "port", contentVersion: VERSION_B, citation: { path: "config.yaml", line: 4 } });
		const both = reviewer(T0 + 20, true, [
			scoped("correct"),
			{ id: "port", receipt: answerReviewReceipt(other), citation: "config.yaml:4", correct: false },
		]);
		expect(answerReviewVerdict([both], TEAM, subject())).toMatchObject({ state: "correct" });
		expect(answerReviewVerdict([both], TEAM, other)).toMatchObject({ state: "incorrect" });
		// A third answer the review did not scope stays open.
		expect(answerReviewVerdict([both], TEAM, subject({ resultId: "mode" }))).toEqual({ state: "none" });

		const newer = { ...reviewer(T0 + 20, true, [scoped("incorrect")]) } as AgentEntry & { reviewLog: unknown[] };
		newer.reviewLog = [
			{ at: T0 + 20, correct: true, findings: [], results: [scoped("incorrect")] },
			{ at: T0 + 30, correct: true, findings: [], results: [scoped("correct")] },
		];
		expect(answerReviewVerdict([newer], TEAM, subject())).toMatchObject({ state: "correct", at: T0 + 30 });
		const tie = [reviewer(T0 + 20, true, [scoped("correct")]), reviewer(T0 + 20, true, [scoped("incorrect")], { id: "Rev2" })];
		expect(answerReviewVerdict(tie, TEAM, subject())).toMatchObject({ state: "incorrect" });
	});
});
