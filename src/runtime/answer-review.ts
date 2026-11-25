/**
 * Review binding for qualitative answers (S1). A reviewable answer is never settled by a general change verdict or a
 * tree fingerprint: answer correctness is independent of whether files changed. It is settled only by the approved
 * reviewer's final verdict that explicitly scopes it:
 *
 *   results: [{ id, receipt, citation, verdict: "correct" | "incorrect" }]
 *
 * - `receipt` is issued here from the run, the result id, the host attempt and the S1 content version (which itself
 *   binds the answer text digest and the anchor citation's path, line and byte digest). It is unguessable without the
 *   review packet, differs for every run and attempt, and therefore cannot be carried over from another submission,
 *   another run or a reused reviewer's older verdict.
 * - `citation` must name exactly the anchor S1 judged (`path` or `path:line`).
 * - The verdict must be newer than the moment this run started holding the submission.
 *
 * Anything else (no `results`, another id, a wrong or missing receipt, another anchor, an id named twice, a reviewer
 * that wrote files or is not the approved one, an incomplete review log) is no verdict for this answer: it stays
 * reviewable. The caller still re-reads the cited bytes (`verifyAnswerReceipt`) immediately before applying a verdict;
 * this module reads no file, calls no model and decides nothing beyond which recorded verdict applies.
 */
import { createHash } from "node:crypto";
import { usableRole } from "../policy/spawn.ts";
import type { AgentEntry, StormConfig } from "../types.ts";
import { reviewEvidenceOf } from "./review.ts";

export const ANSWER_REVIEW_SCHEMA = "storm.answer-review/v1";
const DIGEST = /^[0-9a-f]{64}$/u;

/** The exact pending submission a review must scope. Built by the run controller from its own S1 evidence only. */
export interface AnswerReviewSubject {
	runId: string;
	resultId: string;
	/** Host attempt that produced the submission. */
	attemptId: string;
	/** S1 content version: answer text digest plus the anchor citation's path, line and bytes. */
	contentVersion: string;
	/** The anchor citation S1 judged. */
	citation: { path: string; line?: number };
	/** ms since epoch when this run started holding the submission; an older verdict cannot have judged it. */
	seenAt: number;
}

export type AnswerReviewVerdict =
	| { state: "none" }
	| { state: "correct" | "incorrect"; at: number; author: string };

/** `path` or `path:line`: the one spelling the packet names and the reviewer must return. */
export function answerReviewAnchor(citation: { path: string; line?: number }): string {
	return citation.line === undefined ? citation.path : `${citation.path}:${citation.line}`;
}

/**
 * The receipt for one exact submission in one run: 32 lowercase hex characters, or undefined when the subject is not a
 * complete S1 submission (no content version or attempt), in which case nothing can be reviewed.
 */
export function answerReviewReceipt(subject: Pick<AnswerReviewSubject, "runId" | "resultId" | "attemptId" | "contentVersion">): string | undefined {
	if (subject.runId === "" || subject.resultId === "" || subject.attemptId === "") return undefined;
	if (!DIGEST.test(subject.contentVersion)) return undefined;
	return createHash("sha256")
		.update(JSON.stringify([ANSWER_REVIEW_SCHEMA, subject.runId, subject.resultId, subject.attemptId, subject.contentVersion]))
		.digest("hex")
		.slice(0, 32);
}

/**
 * The approved reviewer's verdict that explicitly scopes this exact submission, or `none`. Only a final verdict from
 * the configured reviewer agent that changed no files, belongs to this run (when the ledger says), has a complete
 * review log, is newer than `seenAt` and names this id with this receipt and this anchor counts. The newest such
 * verdict wins; at the same time an `incorrect` wins.
 */
export function answerReviewVerdict(agents: readonly AgentEntry[], config: StormConfig, subject: AnswerReviewSubject): AnswerReviewVerdict {
	const receipt = answerReviewReceipt(subject);
	if (receipt === undefined || !Number.isFinite(subject.seenAt)) return { state: "none" };
	const reviewer = usableRole(config, "reviewer");
	if (reviewer === undefined) return { state: "none" };
	const anchor = answerReviewAnchor(subject.citation);
	let best: { at: number; correct: boolean; author: string } | undefined;
	for (const agent of agents) {
		if (agent.role !== "reviewer" || agent.name !== reviewer.agent || (agent.changes ?? 0) !== 0) continue;
		if (agent.runId !== undefined && agent.runId !== subject.runId) continue;
		const ledger = reviewEvidenceOf(agent);
		if (!ledger.complete) continue;
		for (const record of ledger.records) {
			if (record.correct === undefined || record.at <= subject.seenAt) continue;
			const scoped = record.results?.find(entry => entry.id === subject.resultId);
			if (scoped === undefined || scoped.receipt !== receipt || scoped.citation !== anchor) continue;
			if (best === undefined || record.at > best.at || (record.at === best.at && !scoped.correct && best.correct)) {
				best = { at: record.at, correct: scoped.correct, author: agent.id };
			}
		}
	}
	if (best === undefined) return { state: "none" };
	return { state: best.correct ? "correct" : "incorrect", at: best.at, author: best.author };
}

/** The bounded packet text a reviewer needs; the answer is quoted verbatim, never summarized by Storm. */
export function answerReviewPacket(input: {
	resultId: string;
	criterion: string;
	answer: string;
	receipt: string;
	citation: { path: string; line?: number };
	/** Defaults to S1's own answer bound (8192), so an answer S1 accepted for judgement is never cut. */
	maxAnswerChars?: number;
}): string {
	const max = Math.max(1, Math.min(input.maxAnswerChars ?? 8_192, 8_192));
	const answer = input.answer.length > max ? `${input.answer.slice(0, max)}\n[... answer cut at ${max} chars ...]` : input.answer;
	const anchor = answerReviewAnchor(input.citation);
	return [
		`Answer review for result \`${input.resultId}\` (receipt ${input.receipt}).`,
		`Criterion: ${input.criterion}`,
		`Cited source: ${anchor}. Read it yourself and judge the answer only against the current content there.`,
		"Answer as submitted:",
		"<<<",
		answer,
		">>>",
		`In your final yield add results: [{ "id": "${input.resultId}", "receipt": "${input.receipt}", "citation": "${anchor}", "verdict": "correct" | "incorrect" }].`,
	].join("\n");
}
