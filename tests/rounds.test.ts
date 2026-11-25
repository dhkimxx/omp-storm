import { describe, expect, test } from "bun:test";
import {
	buildRoundMessage,
	decideRound,
	END_STATUS,
	endLabel,
	type CoverageCheck,
	type CoverageInput,
	type CoverageLane,
	type CoverageResult,
	type Gate,
	maxRounds,
	nextRemedy,
	reviewGate,
	STATUS_LABEL,
	treeFingerprint,
} from "../src/runtime/rounds.ts";
import type { ReviewEvidence, ReviewFinding } from "../src/runtime/review.ts";
import type { TreeState } from "../src/runtime/tree.ts";
import type { AgentEntry, ReviewTally, RunStatus, StormConfig } from "../src/types.ts";
import { agentEntry, teamOf, treeOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM = teamOf({ implementer: "a/i", reviewer: "a/r" });
const NO_REVIEWER = teamOf({ implementer: "a/i", reviewer: "a/r" }, { disabledRoles: ["reviewer"] });
const CHECKED = teamOf({ implementer: "a/i", reviewer: "a/r" }, { requiredChecks: [{ name: "test", argv: ["true"] }] });

const CLEAN = treeOf("d0", "f0");
const CHANGED = treeOf("d1", "f0");
/** The fingerprint Storm sees now: `diff:files`. */
const NOW = treeFingerprint(CHANGED);

type EvidenceEntry = AgentEntry & { reviewLog?: ReviewEvidence[]; reviewLogOverflow?: true };

const writer = (over: Partial<AgentEntry> = {}): AgentEntry => agentEntry({ role: "implementer", changes: 1, lastChangeAt: T0, ...over });

const findings = (...priorities: Array<0 | 1 | 2 | 3>): ReviewFinding[] => priorities.map(priority => ({ priority }));

const reviewRecord = (at: number, correct: boolean | undefined, tree?: string, raised: ReviewFinding[] = []): ReviewEvidence => ({
	at,
	findings: raised,
	...(correct !== undefined ? { correct } : {}),
	...(tree !== undefined ? { tree } : {}),
});

interface ReviewerOptions {
	tree?: string;
	findings?: ReviewFinding[];
	log?: ReviewEvidence[];
	id?: string;
	name?: string;
	changes?: number;
	overflow?: boolean;
}

/** An approved reviewer-role entry with the structured review log the ledger now records. */
const reviewer = (at: number, correct: boolean, options: ReviewerOptions = {}): AgentEntry => {
	const tree = options.tree;
	const raised = options.findings ?? [];
	const entry = agentEntry({
		id: options.id ?? "Rev",
		name: options.name ?? "storm-reviewer",
		role: "reviewer",
		...(options.changes !== undefined ? { changes: options.changes, lastChangeAt: at } : {}),
		lastVerdict: { at, correct, ...(tree !== undefined ? { tree } : {}) },
	});
	const evidence = entry as EvidenceEntry;
	const log = options.log ?? [reviewRecord(at, correct, tree, raised)];
	evidence.reviewLog = log;
	if (options.overflow) evidence.reviewLogOverflow = true;
	// The ledger records the tally alongside the evidence; tests build the same shape.
	const review: ReviewTally = { reviews: 0, passed: 0, failed: 0, findings: [0, 0, 0, 0] };
	for (const record of log) {
		if (record.correct !== undefined) {
			review.reviews++;
			if (record.correct) review.passed++;
			else review.failed++;
		}
		for (const finding of record.findings) review.findings[finding.priority]++;
	}
	entry.review = review;
	return entry;
};

/** A verdict from an agent the review gate must never accept, whatever it says. */
const outsider = (at: number, correct: boolean, over: Partial<AgentEntry> = {}): AgentEntry => {
	const entry = agentEntry({
		id: "Out",
		name: "scout",
		lastVerdict: { at, correct, tree: NOW },
		...over,
	});
	if (!("role" in over)) delete entry.role;
	(entry as EvidenceEntry).reviewLog = [reviewRecord(at, correct, NOW)];
	return entry;
};

const check = (over: Partial<CoverageCheck> = {}): CoverageCheck => ({
	name: "test",
	status: "passed",
	tree: NOW,
	at: T0 + 2,
	...over,
});

const coverage = (over: Partial<CoverageInput> = {}): CoverageInput => ({ checks: [check()], lanes: [], ...over });

const passing = (agents: AgentEntry[], over: Partial<CoverageInput> = {}, tree: { start?: TreeState; now?: TreeState } = { start: CLEAN, now: CHANGED }): Gate =>
	reviewGate(agents, TEAM, tree, coverage(over));

type Unverified = Extract<Gate, { state: "unverified" }>;
const unverified = (over: Partial<Unverified> = {}): Unverified => ({
	state: "unverified",
	cause: "no-review",
	changes: 1,
	reviews: 0,
	requests: 0,
	...over,
});

describe("end labels", () => {
	test("only a verified run is done; an unverified end is ended; the rest are stopped", () => {
		const unverified = ["no-changes", "unreviewed", "no-reviewer"];
		const reasons = ["verified", ...unverified, "interrupted", "round-limit", "no-progress", "time-limit", "shutdown", "budget", "start-failed"];
		expect(Object.keys(END_STATUS).sort()).toEqual([...reasons].sort());
		for (const [reason, status] of Object.entries(END_STATUS)) {
			expect(status).toBe(reason === "verified" ? "done" : unverified.includes(reason) ? "ended" : "stopped");
		}
	});

	test("every status has a label", () => {
		const statuses: RunStatus[] = ["running", "done", "ended", "budget-exceeded", "stopped"];
		expect(Object.keys(STATUS_LABEL).sort()).toEqual([...statuses].sort());
		for (const status of statuses) expect(STATUS_LABEL[status]).not.toBe("");
	});

	test("a reason this version does not know is shown as it was written", () => {
		expect(endLabel("goal-complete")).toBe("goal-complete");
		expect(endLabel("loop-paused")).toBe("loop-paused");
		expect(endLabel("settled")).toBe("settled");
	});
});

describe("reviewGate", () => {
	test("no agents and no changed files are nothing to verify", () => {
		expect(reviewGate([], TEAM)).toEqual({ state: "none", why: "no-changes" });
		expect(reviewGate([agentEntry({ role: "implementer", changes: 0 })], TEAM)).toEqual({ state: "none", why: "no-changes" });
		// A finished read-only lane is not a change and needs no independent change review.
		expect(passing([], { lanes: [{ name: "explore", state: "done", writes: false }] }, { start: CLEAN, now: CLEAN })).toEqual({ state: "none", why: "no-changes" });
	});

	test("only a quick agent changed files", () => {
		expect(reviewGate([agentEntry({ role: "quick", changes: 2, lastChangeAt: T0 })], TEAM)).toEqual({ state: "none", why: "quick-only" });
		expect(passing([agentEntry({ role: "quick", changes: 2, lastChangeAt: T0 })], {}, { start: CLEAN, now: CHANGED })).toEqual({ state: "none", why: "quick-only" });
	});

	test("a writer whose team has no usable reviewer role", () => {
		expect(reviewGate([writer()], NO_REVIEWER)).toEqual({ state: "none", why: "no-reviewer" });
	});

	test("a writer without a verdict needs a review", () => {
		expect(reviewGate([writer()], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
	});

	test("a verdict before the last change is stale", () => {
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewer(T0 - 1, true)], TEAM)).toMatchObject({
			state: "unverified",
			cause: "stale-review",
		});
	});

	test("a verdict at exactly the last change's time is stale", () => {
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewer(T0, true)], TEAM)).toMatchObject({
			state: "unverified",
			cause: "stale-review",
		});
	});

	test("the latest verdict decides; a correct unbound verdict is still not proof", () => {
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewer(T0 + 1, false)], TEAM)).toMatchObject({
			state: "unverified",
			cause: "incorrect",
		});
		expect(
			passing([writer({ lastChangeAt: T0 }), reviewer(T0 + 1, false), reviewer(T0 + 2, true, { id: "Later" })]),
		).toMatchObject({ state: "unverified", cause: "unbound" });
	});

	test("a writer, an implementer, a quick agent, a scout or a mismatched reviewer name cannot verify the run", () => {
		// The writer's own verdict, even a correct one after its change, does not count.
		const self = writer({ id: "Self", lastVerdict: { at: T0 + 1, correct: true } });
		expect(reviewGate([writer(), self], TEAM)).toMatchObject({ state: "unverified", cause: "no-review", reviews: 0 });
		// An implementer that changed nothing cannot verify either, and its review tally does not count as progress.
		const implementer = agentEntry({ id: "Coder", role: "implementer", lastVerdict: { at: T0 + 1, correct: true }, review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] } });
		expect(reviewGate([writer(), implementer], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 2 });
		// Neither does a quick agent's.
		expect(reviewGate([writer(), outsider(T0 + 1, true, { role: "quick", name: "storm-quick" })], TEAM)).toMatchObject({ state: "unverified", cause: "no-review" });
		// Nor a scout's or an explorer's, even with a tree-bound verdict and full coverage.
		expect(passing([writer(), outsider(T0 + 2, true)])).toMatchObject({ state: "unverified", cause: "no-review" });
		expect(passing([writer(), outsider(T0 + 2, true, { role: "explorer", name: "storm-explorer" })])).toMatchObject({ state: "unverified", cause: "no-review" });
		// Nor a reviewer-role agent the approved team did not name.
		expect(passing([writer(), reviewer(T0 + 2, true, { name: "reviewer" })])).toMatchObject({ state: "unverified", cause: "no-review" });
		// Nor a reviewer that changed files.
		expect(passing([writer(), reviewer(T0 + 2, true, { changes: 1 })])).toMatchObject({ state: "unverified", cause: "no-review" });
		// The approved reviewer's verdict is the one that counts.
		expect(passing([writer(), self, reviewer(T0 + 2, true, { tree: NOW })])).toEqual({ state: "passed" });
	});

	test("contradictory verdicts at the same millisecond fail closed", () => {
		const good = reviewer(T0 + 2, true, { tree: NOW, id: "Good" });
		const bad = reviewer(T0 + 2, false, { tree: NOW, id: "Bad" });
		expect(passing([writer({ lastChangeAt: T0 }), good, bad])).toMatchObject({ state: "unverified", cause: "incorrect" });
		expect(passing([writer({ lastChangeAt: T0 }), bad, good])).toMatchObject({ state: "unverified", cause: "incorrect" });
	});

	test("a quick agent's later change does not make a bound review stale", () => {
		const gate = passing([
			writer({ lastChangeAt: T0 }),
			reviewer(T0 + 1, true, { tree: NOW }),
			agentEntry({ id: "Q", role: "quick", changes: 3, lastChangeAt: T0 + 5 }),
		]);
		expect(gate).toEqual({ state: "passed" });
	});

	test("an agent without a role that changed files counts as a writer", () => {
		const roleless = agentEntry({ changes: 1, lastChangeAt: T0 });
		delete roleless.role;
		expect(reviewGate([roleless], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
	});

	test("changes and reviews are the sums over all agents", () => {
		const counted = reviewer(T0, true);
		counted.review = { reviews: 2, passed: 2, failed: 0, findings: [0, 0, 0, 0] };
		const gate = reviewGate(
			[
				writer({ id: "A", changes: 2, lastChangeAt: T0 }),
				writer({ id: "B", changes: 1, lastChangeAt: T0 }),
				agentEntry({ id: "Q", role: "quick", changes: 4, lastChangeAt: T0 }),
				counted,
			],
			TEAM,
		);
		expect(gate).toEqual({ state: "unverified", cause: "stale-review", changes: 7, reviews: 2, requests: 4 });
	});
});

describe("reviewGate with the work tree", () => {
	const implementer = agentEntry({ role: "implementer", changes: 0 });

	test("an unchanged tree with no tool change is nothing to verify", () => {
		expect(reviewGate([implementer], TEAM, { start: CLEAN, now: CLEAN })).toEqual({ state: "none", why: "no-changes" });
	});

	test("a changed tree with no agents is a change nobody of the team is known for", () => {
		expect(reviewGate([], TEAM, { start: CLEAN, now: CHANGED })).toEqual({
			state: "unverified",
			cause: "no-review",
			changes: 0,
			reviews: 0,
			requests: 0,
		});
	});

	test("a changed tree that only quick and read-only agents could have made needs no review", () => {
		const quick = agentEntry({ id: "Q", role: "quick", changes: 1, lastChangeAt: T0 });
		const readOnly = agentEntry({ id: "E", role: "explorer", changes: 0 });
		expect(reviewGate([quick, readOnly], TEAM, { start: CLEAN, now: CHANGED })).toEqual({ state: "none", why: "quick-only" });
	});

	test("a changed tree with an implementer that changed nothing needs a review", () => {
		expect(reviewGate([implementer], TEAM, { start: CLEAN, now: CHANGED })).toMatchObject({
			state: "unverified",
			cause: "no-review",
			changes: 0,
			reviews: 0,
		});
	});

	test("a changed tree with an agent without a role needs a review", () => {
		const roleless = agentEntry({ changes: 0 });
		delete roleless.role;
		expect(reviewGate([roleless], TEAM, { start: CLEAN, now: CHANGED })).toMatchObject({ state: "unverified", cause: "no-review" });
	});

	test("a verdict given against the exact tree now, with coverage, passes", () => {
		expect(passing([implementer, reviewer(T0 + 1, true, { tree: NOW })])).toEqual({ state: "passed" });
	});

	test("a verdict without a tree fingerprint is unbound", () => {
		expect(passing([implementer, reviewer(T0 + 1, true)])).toEqual({ state: "unverified", cause: "unbound", changes: 0, reviews: 1, requests: 2 });
	});

	test("an unreadable current tree is unbound without a verdict and with one", () => {
		expect(reviewGate([implementer], TEAM, { start: CLEAN })).toEqual({
			state: "unverified",
			cause: "no-review",
			changes: 0,
			reviews: 0,
			requests: 1,
			unread: true,
		});
		expect(reviewGate([implementer, reviewer(T0 + 1, true, { tree: NOW })], TEAM, { start: CLEAN })).toEqual({
			state: "unverified",
			cause: "unbound",
			changes: 0,
			reviews: 1,
			requests: 2,
			unread: true,
		});
	});

	test("a metadata-only fingerprint cannot verify a changed tree even if the verdict matches", () => {
		const gate = passing([implementer, reviewer(T0 + 1, true, { tree: NOW })], {}, { start: CLEAN, now: { ...CHANGED, incomplete: true } });
		expect(gate).toMatchObject({ state: "unverified", cause: "unbound", unread: true });
	});

	test("a verdict given against another tree is stale, and says the tree is the reason", () => {
		expect(passing([implementer, reviewer(T0 + 1, true, { tree: "d0:f0" })])).toEqual({
			state: "unverified",
			cause: "stale-review",
			by: "tree",
			changes: 0,
			reviews: 1,
			requests: 2,
		});
	});

	test("a verdict before the last tool change is stale for its time, not for the tree", () => {
		const early = reviewer(T0, true, { tree: NOW });
		const gate = reviewGate([writer({ lastChangeAt: T0 }), early], TEAM, { start: CLEAN, now: CHANGED });
		expect(gate).toMatchObject({ state: "unverified", cause: "stale-review" });
		expect(gate && "by" in gate).toBe(false);
	});

	test("a matching verdict after the one tree re-review passes; a mismatch stops instead of re-reviewing again", () => {
		const matching = reviewer(T0 + 2, true, { tree: NOW });
		expect(passing([implementer, matching], {}, { start: CLEAN, now: CHANGED })).toEqual({ state: "passed" });
		expect(reviewGate([implementer, matching], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 1 }, coverage())).toEqual({ state: "passed" });

		// The one tree-only re-review is already spent: a later verdict on the old tree cannot buy another round.
		const old = reviewer(T0 + 2, true, { tree: "d0:f0" });
		expect(passing([implementer, old], {}, { start: CLEAN, now: CHANGED })).toMatchObject({ state: "unverified", cause: "stale-review", by: "tree" });
		expect(reviewGate([implementer, old], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 1 })).toEqual({
			state: "unverified",
			cause: "stale-review",
			by: "tree",
			exhausted: true,
			changes: 0,
			reviews: 1,
			requests: 2,
		});
	});

	test("the one tree re-review does not excuse a verdict older than the last tool change", () => {
		const gate = reviewGate(
			[writer({ lastChangeAt: T0 }), reviewer(T0, true, { tree: NOW })],
			TEAM,
			{ start: CLEAN, now: CHANGED, rereviewedAt: T0 - 1 },
		);
		expect(gate).toMatchObject({ state: "unverified", cause: "stale-review" });
		expect(gate && "by" in gate).toBe(false);
		expect(gate && "exhausted" in gate).toBe(false);
	});

	test("a known start with an unreadable tree now counts as a change", () => {
		expect(reviewGate([implementer], TEAM, { start: CLEAN })).toMatchObject({ state: "unverified", cause: "no-review", changes: 0 });
		expect(reviewGate([], TEAM, { start: CLEAN })).toMatchObject({ state: "unverified", cause: "no-review" });
		// Without a start tree there is no tree evidence at all: the tool counts decide.
		expect(reviewGate([], TEAM, { now: CHANGED })).toEqual({ state: "none", why: "no-changes" });
	});

	test("a quick agent plus an agent without a role needs a review", () => {
		const quick = agentEntry({ id: "Q", role: "quick", changes: 1, lastChangeAt: T0 });
		const roleless = agentEntry({ id: "R", changes: 0 });
		delete roleless.role;
		expect(reviewGate([quick, roleless], TEAM, { start: CLEAN, now: CHANGED })).toMatchObject({ state: "unverified", cause: "no-review" });
	});

	test("a verdict covers the diff and the files together; a change to either is stale", () => {
		expect(passing([implementer, reviewer(T0 + 1, true, { tree: NOW })], {}, { start: treeOf("d1", "f0"), now: treeOf("d1", "f1") })).toEqual({
			state: "unverified",
			cause: "stale-review",
			by: "tree",
			changes: 0,
			reviews: 1,
			requests: 2,
		});
	});

	test("an incorrect verdict is incorrect, never tree-stale", () => {
		const wrong = reviewer(T0 + 2, false, { tree: "d0:f0" });
		expect(reviewGate([implementer, wrong], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 3 })).toEqual({
			state: "unverified",
			cause: "incorrect",
			changes: 0,
			reviews: 1,
			requests: 2,
		});
	});

	test("another agent active after the verdict makes a tree change team-stale even after the one tree round", () => {
		const rev = reviewer(T0 + 2, true, { tree: "d0:f0" });
		const worker = agentEntry({ id: "Impl", role: "implementer", changes: 0, lastActivityAt: T0 + 3 });
		const gate = reviewGate([worker, rev], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 100 });
		expect(gate).toMatchObject({ state: "unverified", cause: "stale-review" });
		expect(gate && "by" in gate).toBe(false);
	});

	test("the verdict's own activity after it is not team activity", () => {
		const rev = reviewer(T0 + 2, true, { tree: "d0:f0" });
		rev.lastActivityAt = T0 + 5;
		expect(passing([implementer, rev])).toMatchObject({
			state: "unverified",
			cause: "stale-review",
			by: "tree",
		});
	});

	test("a tree that could not be read is marked unread when it is the only reason for the review", () => {
		expect(reviewGate([], TEAM, { start: CLEAN })).toEqual({
			state: "unverified",
			cause: "no-review",
			changes: 0,
			reviews: 0,
			requests: 0,
			unread: true,
		});
		// A tool writer already justifies the review: the unread tree is not what asks for it.
		expect("unread" in (reviewGate([writer()], TEAM, { start: CLEAN }) as object)).toBe(false);
	});

	test("without trees a positive verdict is still unbound", () => {
		expect(reviewGate([writer()], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
		expect(reviewGate([writer()], TEAM, {})).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewer(T0 + 1, true)], TEAM)).toEqual({
			state: "unverified",
			cause: "unbound",
			changes: 1,
			reviews: 1,
			requests: 2,
			unread: true,
		});
	});

	test("a verdict bound to the current tree can pass without a start tree; initial and current are still required", () => {
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewer(T0 + 1, true, { tree: NOW })], TEAM, { now: CHANGED }, coverage())).toEqual({ state: "passed" });
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewer(T0 + 1, true, { tree: NOW })], TEAM, undefined, coverage())).toMatchObject({
			state: "unverified",
			cause: "unbound",
		});
	});
});

describe("reviewGate planned lanes and early proof", () => {
	const quick = agentEntry({ role: "quick", changes: 2, lastChangeAt: T0 });
	const lane = (state: CoverageLane["state"], writes = false): CoverageLane => ({ name: "explore", state, writes });

	test("an unchanged tree with an unfinished planned lane continues the lane instead of ending no-changes", () => {
		for (const state of ["pending", "running", "failed"] as const) {
			expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [lane(state)] })).toEqual({
				state: "unverified",
				cause: "lanes",
				changes: 0,
				reviews: 0,
				requests: 0,
				lane: "explore",
			});
		}
	});

	test("a missing or done read-only lane may still end no-changes, without a reviewer", () => {
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [] })).toEqual({ state: "none", why: "no-changes" });
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [] })).toEqual({ state: "none", why: "no-changes" });
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [lane("done")] })).toEqual({ state: "none", why: "no-changes" });
		// No change review is implied for read-only work, so no reviewer role is needed either.
		expect(reviewGate([], NO_REVIEWER, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [lane("done")] })).toEqual({
			state: "none",
			why: "no-changes",
		});
	});

	test("an unfinished lane needs no approved reviewer role", () => {
		expect(reviewGate([], NO_REVIEWER, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [lane("pending")] })).toMatchObject({
			state: "unverified",
			cause: "lanes",
			lane: "explore",
		});
	});

	test("the lane reason is a continuation, not an end", () => {
		const gate = reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [lane("pending")] });
		expect(decideRound({ gate, turns: 1, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 })).toMatchObject({
			action: "continue",
			round: 2,
		});
	});

	test("quick-only stays unreviewed when its checks pass or none are configured", () => {
		expect(reviewGate([quick], CHECKED, { start: CLEAN, now: CHANGED }, coverage())).toEqual({ state: "none", why: "quick-only" });
		expect(reviewGate([quick], TEAM, { start: CLEAN, now: CHANGED })).toEqual({ state: "none", why: "quick-only" });
		expect(reviewGate([quick], TEAM, { start: CLEAN, now: CHANGED }, { checks: [], lanes: [] })).toEqual({ state: "none", why: "quick-only" });
	});

	test("quick-only cannot hide a failed, missing or mismatched configured check", () => {
		expect(reviewGate([quick], CHECKED, { start: CLEAN, now: CHANGED }, { checks: [check({ status: "failed" })], lanes: [] })).toMatchObject({
			state: "unverified",
			cause: "coverage",
			evidence: "failed",
		});
		expect(reviewGate([quick], CHECKED, { start: CLEAN, now: CHANGED }, { checks: [], lanes: [] })).toMatchObject({
			state: "unverified",
			cause: "coverage",
			evidence: "missing",
		});
		expect(reviewGate([quick], CHECKED, { start: CLEAN, now: CHANGED })).toEqual({
			state: "unverified",
			cause: "no-proof",
			changes: 2,
			reviews: 0,
			requests: 1,
		});
		expect(reviewGate([quick], CHECKED, { start: CLEAN, now: CHANGED }, { checks: [check({ tree: "d0:f0" })], lanes: [] })).toMatchObject({
			state: "unverified",
			cause: "coverage",
			evidence: "mismatched",
		});
	});

	test("an unfinished lane is the reason before a quick-only state", () => {
		expect(reviewGate([quick], TEAM, { start: CLEAN, now: CHANGED }, { checks: [check()], lanes: [lane("pending")] })).toMatchObject({
			state: "unverified",
			cause: "lanes",
			lane: "explore",
		});
	});
});

describe("reviewGate proof coverage", () => {
	const implementer = agentEntry({ role: "implementer", changes: 0 });
	const bound = (at = T0 + 2): AgentEntry => reviewer(at, true, { tree: NOW });

	test("without coverage a bound correct review is still no proof", () => {
		expect(reviewGate([implementer, bound()], TEAM, { start: CLEAN, now: CHANGED })).toEqual({
			state: "unverified",
			cause: "no-proof",
			changes: 0,
			reviews: 1,
			requests: 2,
		});
	});

	test("a failed, skipped, missing or mismatched check blocks verified", () => {
		const agents = [implementer, bound()];
		expect(passing(agents, { checks: [check({ status: "failed" })] })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "failed" });
		expect(passing(agents, { checks: [check({ status: "skipped" })] })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "failed" });
		expect(passing(agents, { requiredChecks: ["typecheck"], checks: [] })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "missing" });
		expect(passing(agents, { checks: [{ name: "test", status: "passed", tree: NOW }] })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "missing" });
		expect(passing(agents, { checks: [check({ tree: "d0:f0" })] })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "mismatched" });
		expect(passing(agents, { complete: false })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "missing" });
		expect(passing(agents, { aborted: true })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "missing" });
	});

	test("a check runner report binds all checks by its fingerprint and finishedAt without raw output", () => {
		const agents = [implementer, bound()];
		const finishedAt = new Date(T0 + 2).toISOString();
		expect(passing(agents, { fingerprint: NOW, checks: [{ name: "test", status: "passed", finishedAt }] })).toEqual({ state: "passed" });
		expect(passing(agents, { fingerprint: "d0:f0", checks: [{ name: "test", status: "passed", finishedAt }] })).toMatchObject({
			state: "unverified",
			cause: "coverage",
			evidence: "mismatched",
		});
		expect(passing(agents, { fingerprint: NOW, checks: [{ name: "test", status: "passed", finishedAt: null }] })).toMatchObject({
			state: "unverified",
			cause: "coverage",
			evidence: "missing",
		});
		expect(
			passing([writer({ lastChangeAt: T0 }), reviewer(T0 + 2, true, { tree: NOW })], {
				fingerprint: NOW,
				checks: [{ name: "test", status: "passed", finishedAt: new Date(T0).toISOString() }],
			}),
		).toMatchObject({ state: "unverified", cause: "coverage", evidence: "stale" });
	});

	test("a check older than the last file change is stale even when its tree matches", () => {
		const agents = [writer({ lastChangeAt: T0 }), reviewer(T0 + 2, true, { tree: NOW })];
		expect(passing(agents, { checks: [check({ at: T0 })] })).toMatchObject({ state: "unverified", cause: "coverage", evidence: "stale" });
		expect(passing(agents, { checks: [check({ at: T0 + 1 })] })).toEqual({ state: "passed" });
	});

	test("a passing check on the current tree after the change is proof", () => {
		expect(passing([implementer, bound()])).toEqual({ state: "passed" });
	});

	test("one correct review but a remaining lane cannot pass; all lanes done does", () => {
		const agents = [implementer, bound()];
		expect(passing(agents, { lanes: [{ name: "docs", state: "running" }] })).toMatchObject({ state: "unverified", cause: "lanes", lane: "docs" });
		expect(passing(agents, { lanes: [{ name: "docs", state: "failed" }] })).toMatchObject({ state: "unverified", cause: "lanes", lane: "docs" });
		expect(passing(agents, { lanes: [{ name: "docs", state: "pending" }] })).toMatchObject({ state: "unverified", cause: "lanes" });
		expect(passing(agents, { lanes: [{ name: "docs", state: "done", writes: true }] })).toEqual({ state: "passed" });
		expect(passing(agents, { lanes: [] })).toEqual({ state: "passed" });
	});

	test("a configured check with no report blocks a bound review", () => {
		expect(reviewGate([implementer, bound()], CHECKED, { start: CLEAN, now: CHANGED }, { checks: [], lanes: [] })).toMatchObject({
			state: "unverified",
			cause: "coverage",
			evidence: "missing",
		});
	});

	test("empty coverage means no required checks and no lanes", () => {
		expect(reviewGate([implementer, bound()], TEAM, { start: CLEAN, now: CHANGED }, { checks: [], lanes: [] })).toEqual({ state: "passed" });
		// The controller's shape for a run with no plan and no configured checks: the tree, nothing else.
		expect(reviewGate([implementer, bound()], TEAM, { start: CLEAN, now: CHANGED }, { fingerprint: NOW })).toEqual({ state: "passed" });
	});
});

describe("reviewGate P0 evidence", () => {
	const implementer = agentEntry({ role: "implementer", changes: 0 });

	test("a correct verdict that still carries a P0 cannot pass", () => {
		expect(passing([implementer, reviewer(T0 + 2, true, { tree: NOW, findings: findings(0) })])).toMatchObject({
			state: "unverified",
			cause: "p0",
		});
	});

	test("a P0 needs a later independent review of the exact current tree", () => {
		const first = reviewer(T0 + 1, false, { tree: NOW, findings: findings(0), id: "RevA" });
		const second = reviewer(T0 + 2, true, { tree: NOW, id: "RevB" });
		expect(passing([implementer, first, second])).toEqual({ state: "passed" });
	});

	test("the same reviewer on the same tree cannot clear its own P0", () => {
		const log = [reviewRecord(T0 + 1, false, NOW, findings(0)), reviewRecord(T0 + 2, true, NOW)];
		expect(passing([implementer, reviewer(T0 + 2, true, { tree: NOW, log, id: "RevA" })])).toMatchObject({
			state: "unverified",
			cause: "p0",
		});
	});

	test("the same reviewer on the replacement diff clears a P0", () => {
		const log = [reviewRecord(T0 + 1, false, "d0:f0", findings(0)), reviewRecord(T0 + 2, true, NOW)];
		expect(passing([implementer, reviewer(T0 + 2, true, { tree: NOW, log, id: "RevA" })])).toEqual({ state: "passed" });
	});

	test("a newer review of an unrelated tree clears nothing", () => {
		const first = reviewer(T0 + 1, false, { tree: NOW, findings: findings(0), id: "RevA" });
		const unrelated = reviewer(T0 + 2, true, { tree: "d9:f9", id: "RevB" });
		expect(passing([implementer, first, unrelated])).toMatchObject({ state: "unverified", cause: "stale-review" });
	});

	test("a cleared P0 passes while the review tally keeps its P0 count", () => {
		const first = reviewer(T0 + 1, false, { tree: NOW, findings: findings(0), id: "RevA" });
		const second = reviewer(T0 + 2, true, { tree: NOW, id: "RevB" });
		const tally: ReviewTally = { reviews: 1, passed: 0, failed: 1, findings: [1, 0, 0, 0] };
		first.review = tally;
		expect(passing([implementer, first, second])).toEqual({ state: "passed" });
		expect(first.review).toEqual(tally);
	});

	test("an incomplete review log cannot rule out a P0", () => {
		expect(passing([implementer, reviewer(T0 + 2, true, { tree: NOW, overflow: true })])).toMatchObject({
			state: "unverified",
			cause: "no-proof",
		});
	});

	test("a legacy verdict without structured review evidence is not current pass authority", () => {
		const legacy = agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 2, correct: true, tree: NOW } });
		expect(passing([writer({ lastChangeAt: T0 }), legacy])).toMatchObject({ state: "unverified", cause: "no-proof" });
	});

	test("a legacy P0 tally without structured evidence cannot be cleared by a newer review", () => {
		const legacy = reviewer(T0 + 1, false, { tree: NOW, id: "Legacy" });
		legacy.review = { reviews: 1, passed: 0, failed: 1, findings: [1, 0, 0, 0] };
		delete (legacy as AgentEntry & { reviewLog?: ReviewEvidence[] }).reviewLog;
		const fresh = reviewer(T0 + 2, true, { tree: NOW, id: "Fresh" });
		expect(passing([implementer, legacy, fresh])).toMatchObject({ state: "unverified", cause: "p0" });
	});
});

describe("maxRounds", () => {
	const config = (rounds?: number): StormConfig => teamOf({}, rounds === undefined ? {} : { rounds });

	test("the first round plus the default extra rounds", () => {
		expect(maxRounds({}, config())).toBe(4);
	});

	test("config extra rounds count on top of the first round", () => {
		expect(maxRounds({}, config(0))).toBe(1);
		expect(maxRounds({}, config(5))).toBe(6);
	});

	test("the request's rounds limit wins over the config", () => {
		expect(maxRounds({ rounds: 2 }, config(5))).toBe(2);
	});

	test("a config value that is not an integer in 0..10 is absent", () => {
		for (const bad of [-1, 1.5, 99]) expect(maxRounds({}, config(bad))).toBe(4);
	});
});

describe("decideRound", () => {
	const base = {
		gate: unverified(),
		turns: 1,
		maxRounds: 4,
		aborted: false,
		overBudget: false,
		elapsedMs: 0,
	};

	test("an interrupted turn ends the run before anything else", () => {
		expect(decideRound({ ...base, gate: { state: "passed" }, aborted: true, overBudget: true })).toEqual({
			action: "end",
			reason: "interrupted",
		});
	});

	test("a none gate ends with the reason it names, even past the budget", () => {
		expect(decideRound({ ...base, gate: { state: "none", why: "no-changes" }, overBudget: true })).toEqual({ action: "end", reason: "no-changes" });
		expect(decideRound({ ...base, gate: { state: "none", why: "quick-only" }, overBudget: true })).toEqual({ action: "end", reason: "unreviewed" });
		expect(decideRound({ ...base, gate: { state: "none", why: "no-reviewer" }, overBudget: true })).toEqual({ action: "end", reason: "no-reviewer" });
	});

	test("a passed gate verifies, even past the budget", () => {
		expect(decideRound({ ...base, gate: { state: "passed" }, overBudget: true })).toEqual({ action: "end", reason: "verified" });
	});

	test("an over-budget unverified run ends on the budget before its limits", () => {
		expect(decideRound({ ...base, turns: 4, overBudget: true, minutes: 1, elapsedMs: 60_000 })).toEqual({
			action: "end",
			reason: "budget",
		});
	});

	test("an exhausted tree re-review stops honestly instead of sending another round", () => {
		const gate = unverified({ cause: "stale-review", by: "tree", exhausted: true });
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 1, requests: 1 } })).toEqual({
			action: "end",
			reason: "no-progress",
		});
		expect(decideRound({ ...base, gate, overBudget: true })).toEqual({ action: "end", reason: "budget" });
	});

	test("no rounds left ends on the round limit before the time limit", () => {
		expect(decideRound({ ...base, turns: 4, minutes: 1, elapsedMs: 60_000 })).toEqual({
			action: "end",
			reason: "round-limit",
		});
	});

	test("the user's time limit is checked between rounds", () => {
		expect(decideRound({ ...base, minutes: 1, elapsedMs: 59_999 })).toMatchObject({ action: "continue" });
		expect(decideRound({ ...base, minutes: 1, elapsedMs: 60_000 })).toEqual({ action: "end", reason: "time-limit" });
	});

	test("no progress needs changes, reviews and requests unchanged", () => {
		expect(decideRound({ ...base, progressSince: { changes: 1, reviews: 0, requests: 0 } })).toEqual({
			action: "end",
			reason: "no-progress",
		});
		expect(decideRound({ ...base, progressSince: { changes: 1, reviews: 1, requests: 0 } })).toMatchObject({ action: "continue" });
		expect(decideRound({ ...base, progressSince: { changes: 2, reviews: 0, requests: 0 } })).toMatchObject({ action: "continue" });
	});

	test("an agent request alone is progress, and three unchanged counts are none", () => {
		const gate = unverified({ changes: 0, reviews: 0, requests: 2 });
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 1 } })).toMatchObject({ action: "continue" });
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 2 } })).toEqual({
			action: "end",
			reason: "no-progress",
		});
	});

	test("otherwise the next round is the one after the turn that ended", () => {
		const gate = unverified({ cause: "incorrect" });
		expect(decideRound({ ...base, gate })).toEqual({ action: "continue", gate, round: 2, maxRounds: 4 });
	});
});

describe("buildRoundMessage", () => {
	const message = (round: number, max: number, gate: Unverified = unverified(), reviewer = "storm-reviewer"): string =>
		buildRoundMessage({ runId: "run-7", round, maxRounds: max, gate, reviewer });

	test("one storm-run section naming the reviewer it was given", () => {
		const text = message(2, 4, unverified(), "custom-reviewer");
		expect(text.startsWith('<storm-run id="run-7" round="2/4">')).toBe(true);
		expect(text.endsWith("</storm-run>")).toBe(true);
		expect(text).toContain("custom-reviewer");
		expect(text).not.toContain("storm-reviewer");
		expect(text.length).toBeLessThan(600);
	});

	test("every cause reads differently", () => {
		const causes: Unverified["cause"][] = ["no-review", "stale-review", "incorrect", "unbound", "no-proof", "p0", "coverage", "lanes"];
		const texts = causes.map(cause => message(2, 4, unverified({ cause })));
		expect(new Set(texts).size).toBe(causes.length);
		// Changes may be the user's or a shell command's: the message must not put them on the team.
		for (const text of texts) expect(text).not.toContain("The team changed files");
	});

	test("check evidence and remaining lanes are named without raw logs", () => {
		const stale = message(2, 4, unverified({ cause: "coverage", evidence: "stale" }));
		expect(stale).toContain("before the last file change");
		const lane = message(2, 4, unverified({ cause: "lanes", lane: "docs" }));
		expect(lane).toContain("docs");
		expect(lane).toContain("Unfinished lane");
		// A lane that never ran is the team's work to finish, not the reviewer's to explain.
		expect(lane).toContain("lane's own role");
		expect(lane).not.toContain("verify the current tree");
	});

	test("an unread tree gets its own cause sentence", () => {
		const gate = (unread: boolean): Unverified => unverified({ changes: 0, cause: "no-review", ...(unread ? { unread: true as const } : {}) });
		const plain = buildRoundMessage({ runId: "run-7", round: 2, maxRounds: 4, gate: gate(false), reviewer: "storm-reviewer" });
		const unread = buildRoundMessage({ runId: "run-7", round: 2, maxRounds: 4, gate: gate(true), reviewer: "storm-reviewer" });
		expect(unread).not.toBe(plain);
		expect(unread).toContain("could not be read");
		expect(plain).not.toContain("could not be read");
	});

	test("the exhausted tree re-review is stated", () => {
		expect(message(2, 4, unverified({ cause: "stale-review", by: "tree", exhausted: true }))).toContain("one tree-only re-review was already used");
	});

	test("the last-round sentence appears only in the last round", () => {
		expect(message(4, 4).split("\n").length).toBe(message(3, 4).split("\n").length + 1);
	});
});

describe("declared results", () => {
	const result = (state: "pending" | "unmet" | "reviewable" | "accepted", over: { id?: string; reason?: string } = {}) => ({
		id: over.id ?? "r1",
		state,
		lane: "work",
		...(over.reason === undefined ? {} : { reason: over.reason }),
	});

	test("an open requirement overrides every ordinary close", () => {
		for (const state of ["pending", "unmet", "reviewable"] as const) {
			const gate = reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { lanes: [{ name: "work", state: "done" }], results: [result(state, { reason: "아직" })] });
			const remedy = state === "reviewable" ? "review" : "work";
			expect(gate).toEqual({
				state: "unverified",
				cause: "results",
				changes: 0,
				reviews: 0,
				requests: 0,
				result: "r1",
				resultState: state,
				resultLane: "work",
				resultRemedy: remedy,
				resultProgress: `r1|${state}|${remedy}||`,
				resultReason: "아직",
			});
		}
		// A run with nothing to review closes only when no requirement is open.
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { lanes: [], results: [result("accepted")] })).toEqual({ state: "none", why: "no-changes" });
	});

	test("an open result displaces an ordinary review cause so the round names the repair", () => {
		const known = reviewGate([writer()], TEAM, undefined, { lanes: [], results: [result("unmet")] });
		expect(known).toMatchObject({ state: "unverified", cause: "results", result: "r1" });
	});

	test("a P0 review or an exhausted tree re-review stays first", () => {
		const p0 = passing([writer({ lastChangeAt: T0 }), reviewer(T0 + 2, true, { tree: NOW, findings: findings(0) })], { results: [result("unmet")] });
		expect(p0).toMatchObject({ cause: "p0" });
		const old = reviewer(T0 + 2, true, { tree: "d0:f0" });
		const exhausted = reviewGate([writer({ lastChangeAt: T0 }), old], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 1 }, { checks: [check()], lanes: [], results: [result("unmet")] });
		expect(exhausted).toMatchObject({ cause: "stale-review", by: "tree", exhausted: true });
	});

	test("an open result outranks a waiting lane it may unblock", () => {
		const gate = reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { lanes: [{ name: "review", state: "pending" }], results: [result("unmet")] });
		expect(gate).toMatchObject({ state: "unverified", cause: "results", result: "r1", resultLane: "work" });
	});

	test("a quiet end cannot hide an open requirement", () => {
		// Quick-only work and a team without a reviewer are ordinary close candidates too.
		const quick = reviewGate([agentEntry({ role: "quick", changes: 1, lastChangeAt: T0 })], TEAM, undefined, { lanes: [], results: [result("unmet")] });
		expect(quick).toMatchObject({ state: "unverified", cause: "results" });
		const unreviewed = reviewGate([writer()], NO_REVIEWER, undefined, { lanes: [], results: [result("unmet")] });
		expect(unreviewed).toMatchObject({ state: "unverified", cause: "results" });
	});

	test("a passed gate cannot pass over an unaccepted requirement", () => {
		const agents = [writer({ lastChangeAt: T0 }), reviewer(T0 + 2, true, { tree: NOW })];
		expect(passing(agents, { results: [result("accepted")] })).toEqual({ state: "passed" });
		expect(passing(agents, { results: [result("unmet")] })).toMatchObject({ state: "unverified", cause: "results", result: "r1" });
		expect(passing(agents, { results: [result("reviewable")] })).toMatchObject({ state: "unverified", cause: "results", result: "r1" });
	});

	test("the round message names the open id, lane, state and bounded reason", () => {
		const gate = reviewGate([], TEAM, undefined, { lanes: [], results: [result("unmet", { reason: "바뀐 내용이 없습니다." })] });
		if (gate.state !== "unverified") throw new Error("expected an unverified gate");
		const message = buildRoundMessage({ runId: "run-1", round: 2, maxRounds: 4, gate });
		expect(message).toContain("`r1` (unmet, lane `work`): 바뀐 내용이 없습니다.");
		expect(message.match(/Next:/g) ?? []).toHaveLength(1);
		expect(message).not.toContain("verified");
	});
});

describe("non-code output settlement", () => {
	const output = (over: Partial<CoverageResult> = {}): CoverageResult => ({ id: "answer", lane: "read", state: "accepted", kind: "answer", ...over });
	const artifact = (over: Partial<CoverageResult> = {}): CoverageResult => output({ id: "artifact", lane: "experiment", kind: "artifact", ...over });

	test("all accepted answers/artifacts with done coverage return the existing verified gate", () => {
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [output()] })).toEqual({ state: "passed" });
		expect(
			reviewGate(
				[],
				TEAM,
				{ start: CLEAN, now: CLEAN },
				{ checks: [], lanes: [{ name: "read", state: "done" }, { name: "experiment", state: "done", writes: false }], results: [output(), artifact()] },
			),
		).toEqual({ state: "passed" });
		// Absent lanes mean no plan coverage remains, exactly as the ordinary no-changes gate reads it.
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], results: [output()] })).toEqual({ state: "passed" });
		const gate = reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [output()] });
		expect(decideRound({ gate, turns: 1, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 })).toEqual({
			action: "end",
			reason: "verified",
		});
	});

	test("an open required result stays the results cause instead of passing", () => {
		const negative = output({ state: "unmet", reason: "인용한 출처가 답과 일치하지 않습니다." });
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [negative] })).toMatchObject({
			state: "unverified",
			cause: "results",
			result: "answer",
			resultState: "unmet",
			resultReason: "인용한 출처가 답과 일치하지 않습니다.",
		});
		// One accepted output never hides a second requirement that was not accepted.
		expect(
			reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [output(), output({ id: "negative", state: "reviewable" })] }),
		).toMatchObject({ state: "unverified", cause: "results", result: "negative", resultState: "reviewable" });
	});

	test("a change row, a legacy row without a media, or an open dependency keeps the ordinary gate", () => {
		expect(reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [output({ kind: "change" })] })).toEqual({
			state: "none",
			why: "no-changes",
		});
		expect(
			reviewGate(
				[],
				TEAM,
				{ start: CLEAN, now: CLEAN },
				{ checks: [], lanes: [], results: [{ id: "answer", lane: "read", state: "accepted" }] },
			),
		).toEqual({
			state: "none",
			why: "no-changes",
		});
		expect(
			reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [output({ blockedBy: "producer" })] }),
		).toEqual({ state: "none", why: "no-changes" });
	});

	test("an unfinished lane, missing required check, or open P0 never becomes verified", () => {
		expect(
			reviewGate([], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [{ name: "read", state: "pending" }], results: [output()] }),
		).toMatchObject({ state: "unverified", cause: "lanes", lane: "read" });
		const checked = teamOf({ implementer: "a/i", reviewer: "a/r" }, { requiredChecks: [{ name: "test", argv: ["true"] }] });
		expect(reviewGate([], checked, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [output()] })).toEqual({
			state: "none",
			why: "no-changes",
		});
		// A real passing check on the unchanged tree is the evidence the verified gate may use.
		expect(
			reviewGate(
				[],
				checked,
				{ start: CLEAN, now: CLEAN },
				{ checks: [check({ tree: treeFingerprint(CLEAN) })], lanes: [], requiredChecks: ["test"], results: [output()] },
			),
		).toEqual({ state: "passed" });
		const p0 = reviewer(T0 + 1, true, { tree: treeFingerprint(CLEAN), findings: findings(0) });
		expect(reviewGate([p0], TEAM, { start: CLEAN, now: CLEAN }, { checks: [], lanes: [], results: [output()] })).toEqual({
			state: "none",
			why: "no-changes",
		});
	});

	test("a code change still follows the review path rather than the output settlement", () => {
		expect(
			reviewGate([writer()], TEAM, { start: CLEAN, now: CHANGED }, { checks: [], lanes: [], results: [output()] }),
		).toMatchObject({ state: "unverified", cause: "no-review", changes: 1 });
	});
});

describe("S3 directed result feedback", () => {
	const openRow = (over: Partial<CoverageResult> = {}): CoverageResult => ({ id: "r1", lane: "work", state: "unmet", ...over });
	const gateOf = (rows: readonly CoverageResult[], over: Partial<CoverageInput> = {}): Unverified => {
		const gate = reviewGate([], TEAM, undefined, { lanes: [], ...over, results: rows });
		if (gate.state !== "unverified") throw new Error("expected an unverified gate");
		return gate;
	};
	const messageOf = (gate: Unverified, reviewer?: string): string =>
		buildRoundMessage({ runId: "run-3", round: 2, maxRounds: 4, gate, ...(reviewer === undefined ? {} : { reviewer }) });

	test("the next action follows evidence, not a habit", () => {
		expect(nextRemedy(openRow())).toBe("work");
		expect(nextRemedy(openRow({ state: "reviewable" }))).toBe("review");
		expect(nextRemedy(openRow({ state: "reviewable" }), false)).toBe("blocked");
		expect(nextRemedy(openRow({ state: "pending", blockedBy: "producer" }))).toBe("producer");
		expect(nextRemedy(openRow({ remedy: "retry" }))).toBe("retry");
		expect(nextRemedy(openRow({ remedy: "blocked", unblock: "credentials" }))).toBe("blocked");
	});

	test("a gate carries the requirement's lane, attempt, media and stable witness", () => {
		const gate = gateOf(
			[openRow({ kind: "change", attempt: "job:A0:A0", reason: "사전 기준선 이후 바뀐 내용이 없습니다.", evidence: "v1" })],
			{ reviewer: true },
		);
		expect(gate).toMatchObject({
			cause: "results",
			result: "r1",
			resultState: "unmet",
			resultLane: "work",
			resultKind: "change",
			resultAttempt: "job:A0:A0",
			resultRemedy: "work",
			resultProgress: "r1|unmet|work||v1",
		});
	});

	test("an actionable row is addressed before a blocked one", () => {
		const gate = gateOf([
			openRow({ id: "blocked", remedy: "blocked", unblock: "provider login" }),
			openRow({ id: "fixable" }),
		]);
		expect(gate.result).toBe("fixable");
		expect(gateOf([openRow({ id: "blocked", remedy: "blocked" })]).resultRemedy).toBe("blocked");
	});

	test("work names only the requirement, its lane, attempt and media", () => {
		const gate = gateOf([openRow({ kind: "change", attempt: "job:A0:A0", reason: "바뀐 내용이 없습니다 /tmp/storm/secret/report.json" })]);
		const message = messageOf(gate, "storm-reviewer");
		expect(message).toContain("`r1` (unmet, lane `work`, attempt `job:A0:A0`)");
		expect(message).not.toContain("stop retrying");
		expect(message).not.toContain("/tmp/");
		expect(message).toContain("<path>");
		expect(message.match(/Next:/g) ?? []).toHaveLength(1);
		expect(message).not.toContain("verified");
	});

	test("missing input names the producer, not the consumer or the reviewer", () => {
		const gate = gateOf([openRow({ state: "pending", blockedBy: "build", reason: "선행 결과가 아직 없습니다" })]);
		const message = messageOf(gate, "storm-reviewer");
		expect(message).toContain("`build`");
		expect(message).toContain("`r1`");
		expect(message).not.toContain("fix or rerun");
		expect(message).not.toContain("judge the submitted");
	});

	test("a reviewable submission asks the approved reviewer and never reruns its lane", () => {
		const receipt = "0123456789abcdef0123456789abcdef";
		const gate = gateOf([openRow({ state: "reviewable", kind: "answer", attempt: "job:Submit0:Submit0", review: { receipt, citation: "report.json:2" } })], { reviewer: true });
		expect(gate.resultRemedy).toBe("review");
		const message = messageOf(gate, "storm-reviewer");
		expect(message).toContain("storm-reviewer");
		expect(message).toContain("`r1`");
		expect(message).not.toContain("fix or rerun");
		// An answer is judged by a scoped result verdict, never by a tree verdict.
		expect(message).toContain(receipt);
		expect(message).toContain("report.json:2");
		expect(message).toContain("results:");
		expect(message).not.toContain("on the current tree");
	});

	test("a reviewable answer without a scoped review receipt goes back to its producer, not to a reviewer", () => {
		const row = openRow({ state: "reviewable", kind: "answer" });
		expect(nextRemedy(row, true)).toBe("work");
		const gate = gateOf([row], { reviewer: true });
		expect(gate.resultRemedy).toBe("work");
		expect(messageOf(gate, "storm-reviewer")).not.toContain("judge the submitted");
		// A malformed receipt is no receipt for the message either.
		const forged = gateOf([openRow({ state: "reviewable", kind: "answer", review: { receipt: "not-a-receipt", citation: "report.json:2" } })], { reviewer: true });
		expect(forged.resultRemedy).toBe("work");
		expect(messageOf(forged, "storm-reviewer")).not.toContain("results:");
		// A change submission keeps the ordinary current-tree review.
		expect(nextRemedy(openRow({ state: "reviewable", kind: "change" }), true)).toBe("review");
	});

	test("a reviewable row without an approved reviewer is a blocker, not a round loop", () => {
		const gate = gateOf([openRow({ state: "reviewable" })], { reviewer: false });
		expect(gate.resultRemedy).toBe("blocked");
		expect(gate.resultUnblock).toBeUndefined();
		const message = messageOf(gate);
		expect(message).not.toContain("have `storm-reviewer`");
		expect(message).not.toContain("fix or rerun");
		expect(decideRound({ turns: 1, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0, gate })).toEqual({
			action: "end",
			reason: "no-progress",
		});
	});

	test("an external blocker and a host retry are rendered as no team action", () => {
		const blockedGate = gateOf([openRow({ remedy: "blocked", unblock: "credentials in /home/dev/.config", reason: "인증이 없습니다" })]);
		expect(blockedGate.resultRemedy).toBe("blocked");
		expect(blockedGate.resultUnblock).toBe("credentials in /home/dev/.config");
		const blocked = messageOf(blockedGate);
		expect(blocked).toContain("credentials in <path>");
		expect(blocked).not.toContain("/home/dev");
		expect(blocked).not.toContain("fix or rerun");
		const retryGate = gateOf([openRow({ remedy: "retry", attempt: "job:A0:A0" })]);
		expect(retryGate.resultRemedy).toBe("retry");
		expect(retryGate.resultAttempt).toBe("job:A0:A0");
		const retry = messageOf(retryGate);
		expect(retry).toContain("job:A0:A0");
		expect(retry).not.toContain("fix or rerun");
		expect(retry).not.toContain("judge the submitted");
	});

	test("an attempt that is not a short token is omitted rather than shown as a path", () => {
		const gate = gateOf([openRow({ attempt: "/tmp/storm/attempt" })]);
		expect(gate.resultAttempt).toBe("/tmp/storm/attempt");
		const message = messageOf(gate);
		expect(message).not.toContain("/tmp/");
		expect(message).not.toContain("attempt `");
	});

	test("a blocked requirement ends; retry exhaustion gets one directed route-repair round", () => {
		const base = { turns: 1, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 };
		expect(decideRound({ ...base, gate: gateOf([openRow({ remedy: "blocked" })]), progressSince: { changes: 1, reviews: 1, requests: 1 } })).toEqual({
			action: "end",
			reason: "no-progress",
		});
		const retry = gateOf([openRow({ remedy: "retry", attempt: "job:A0:A0" })]);
		expect(decideRound({ ...base, gate: retry })).toMatchObject({ action: "continue" });
		expect(
			decideRound({ ...base, gate: retry, progressSince: { changes: 0, reviews: 0, requests: 1, result: retry.resultProgress ?? "" } }),
		).toEqual({ action: "end", reason: "no-progress" });
	});

	test("an unmet requirement with an attempt is work, never a review", () => {
		const gate = gateOf([openRow({ attempt: "job:A0:A0", reason: "시도가 실패로 끝나 필수 결과를 수용하지 않았습니다." })]);
		expect(gate.resultRemedy).toBe("work");
		expect(messageOf(gate, "storm-reviewer")).not.toContain("judge the submitted");
	});

	test("a repeated identical result is no progress even when requests grew; changed evidence is", () => {
		const base = { turns: 1, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 };
		const gate = gateOf([openRow({ attempt: "job:A1:A1" })]);
		const current = "r1|unmet|work||";
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 1, result: "r1|unmet|work||v2" } })).toMatchObject({ action: "continue" });
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 9, result: current } })).toEqual({ action: "end", reason: "no-progress" });
		expect(
			decideRound({ ...base, gate: gateOf([openRow({ state: "reviewable", attempt: "job:A2:A2" })]), progressSince: { changes: 0, reviews: 0, requests: 1, result: current } }),
		).toMatchObject({ action: "continue" });
	});

	test("a contracted result never treats request count alone as progress", () => {
		const base = { turns: 1, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 };
		const gate = gateOf([openRow()]);
		const witness = "r1|unmet|work||";
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 0, result: witness } })).toEqual({ action: "end", reason: "no-progress" });
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 4, result: witness } })).toEqual({ action: "end", reason: "no-progress" });
		// Real activity and a changed requirement still continue.
		expect(decideRound({ ...base, gate, progressSince: { changes: 1, reviews: 0, requests: 0, result: witness } })).toMatchObject({ action: "continue" });
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 1, requests: 0, result: witness } })).toMatchObject({ action: "continue" });
	});

	test("a result first seen after a round without a result witness gets its action round", () => {
		const base = { turns: 3, maxRounds: 5, aborted: false, overBudget: false, elapsedMs: 0 };
		const gate = gateOf([openRow({ state: "unmet", evidence: "b-result@v1" })]);
		// Round 3 ended with a plain review cause, so no requirement witness was stored; round 4 must be able to act
		// on the producer content change that invalidated A instead of stopping on counts alone.
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 2 } })).toMatchObject({ action: "continue", round: 4 });
	});

	test("a reached round limit is reported before a later blocker", () => {
		const base = { turns: 4, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 };
		expect(decideRound({ ...base, gate: gateOf([openRow({ remedy: "blocked" })]) })).toEqual({ action: "end", reason: "round-limit" });
	});

	test("a submitted row the tree cannot show is blocked, not sent to a reviewer", () => {
		const gate = gateOf([openRow({ state: "reviewable", kind: "answer", judgeable: false })], { reviewer: true });
		expect(gate.resultRemedy).toBe("blocked");
		const message = messageOf(gate, "storm-reviewer");
		expect(message).not.toContain("judge the submitted");
		expect(message).toContain("Report the blocker");
		expect(nextRemedy(openRow({ state: "reviewable", judgeable: false }), true)).toBe("blocked");
		expect(nextRemedy(openRow({ remedy: "review", judgeable: false }), true)).toBe("blocked");
		expect(decideRound({ turns: 1, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0, gate })).toEqual({
			action: "end",
			reason: "no-progress",
		});
	});

	test("accepted requirements never bypass a stale final review or a check from another tree", () => {
		const accepted = openRow({ state: "accepted" });
		const staleReview = [writer({ lastChangeAt: T0 }), reviewer(T0 + 2, true, { tree: "d0:f0" })];
		expect(reviewGate(staleReview, TEAM, { start: CLEAN, now: CHANGED }, { checks: [check({ tree: "d0:f0" })], lanes: [], results: [accepted] })).toMatchObject({
			state: "unverified",
			cause: "stale-review",
		});
		const currentReview = [writer({ lastChangeAt: T0 }), reviewer(T0 + 2, true, { tree: NOW })];
		expect(reviewGate(currentReview, TEAM, { start: CLEAN, now: CHANGED }, { checks: [check({ tree: "d0:f0" })], lanes: [], results: [accepted] })).toMatchObject({
			state: "unverified",
			cause: "coverage",
			evidence: "mismatched",
		});
	});
});

describe("S3 native failure categories", () => {
	const base = { turns: 2, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 };
	const openRow = (over: Partial<CoverageResult> = {}): CoverageResult => ({ id: "r1", lane: "work", state: "unmet", ...over });
	const gateOf = (row: CoverageResult): Unverified => {
		const gate = reviewGate([], TEAM, undefined, { lanes: [], reviewer: true, results: [row] });
		if (gate.state !== "unverified") throw new Error("expected an unverified gate");
		return gate;
	};
	const messageOf = (gate: Unverified): string => buildRoundMessage({ runId: "run-f", round: 2, maxRounds: 4, gate, reviewer: "storm-reviewer" });

	test("exhausted host retry is no new Storm retry and names the exhausted attempt", () => {
		const gate = gateOf(openRow({ remedy: "retry", attempt: "job:T4DB0:T4DB0", reason: "호스트 자동 재시도가 소진되었습니다." }));
		expect(gate.resultRemedy).toBe("retry");
		expect(gate.resultAttempt).toBe("job:T4DB0:T4DB0");
		const message = messageOf(gate);
		expect(message).toContain("`r1`");
		expect(message).toContain("job:T4DB0:T4DB0");
		expect(message).not.toContain("fix or rerun");
		expect(message).not.toContain("judge the submitted");
		expect(decideRound({ ...base, gate })).toMatchObject({ action: "continue" });
		expect(
			decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 0, result: gate.resultProgress ?? "" } }),
		).toEqual({ action: "end", reason: "no-progress" });
	});

	test("a structured config/auth blocker carries its truthful unblock condition", () => {
		const unblock = "omp task.isolation.enabled를 켜고 팀을 다시 승인한 뒤 새 실행으로 맡기세요.";
		const gate = gateOf(
			openRow({
				remedy: "blocked",
				unblock,
				reason: "격리 설정이 꺼져 있어 레인을 시작하지 못했습니다(isolation).",
			}),
		);
		expect(gate.resultRemedy).toBe("blocked");
		expect(gate.resultUnblock).toBe(unblock);
		const message = messageOf(gate);
		expect(message).toContain("omp task.isolation.enabled");
		expect(message).not.toContain("fix or rerun");
		expect(decideRound({ ...base, gate })).toEqual({ action: "end", reason: "no-progress" });
	});

	test("a missing retained artifact is ordinary work, bounded by repeated-evidence stopping", () => {
		const gate = gateOf(
			openRow({ remedy: "work", kind: "artifact", attempt: "job:T4TRepair0:T4TRepair0", reason: "보존 산출물을 찾을 수 없습니다(patch-artifact-missing)." }),
		);
		expect(gate.resultRemedy).toBe("work");
		const message = messageOf(gate);
		expect(message).toContain("`r1`");
		expect(message).toContain("job:T4TRepair0:T4TRepair0");
		expect(message).toContain("patch-artifact-missing");
		expect(message).not.toContain("stop retrying");
		// First appearance after a non-result round may act once.
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 3 } })).toMatchObject({ action: "continue" });
		// The same open row and witness again is a repeated failure, not unlimited retry.
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 3, result: "r1|unmet|work||" } })).toEqual({
			action: "end",
			reason: "no-progress",
		});
	});

	test("a cancelled attempt or an unavailable schema stays ordinary work, not a guessed provider blocker", () => {
		for (const reason of ["시도가 취소되어 필수 결과를 수용하지 않았습니다.", "구조화 결과가 유효하지 않아 필수 결과를 수용하지 않았습니다."]) {
			const gate = gateOf(openRow({ reason }));
			expect(gate.resultRemedy).toBe("work");
			const message = messageOf(gate);
			expect(message).not.toContain("stop retrying");
			expect(message).not.toContain("retry/fallback is exhausted");
		}
	});
});

describe("S3 retry route witness", () => {
	const openRow = (over: Partial<CoverageResult> = {}): CoverageResult => ({ id: "r1", lane: "b-repair", state: "unmet", ...over });
	const gateOf = (row: CoverageResult): Unverified => {
		const gate = reviewGate([], TEAM, undefined, { lanes: [], reviewer: true, results: [row] });
		if (gate.state !== "unverified") throw new Error("expected an unverified gate");
		return gate;
	};
	const base = { turns: 2, maxRounds: 4, aborted: false, overBudget: false, elapsedMs: 0 };

	test("the same exhausted route cannot buy a second allowance; a genuinely different route can", () => {
		const gate = gateOf(openRow({ remedy: "retry", attempt: "job:T4DB0:T4DB0", evidence: "retry:5774345db23d" }));
		const same = gate.resultProgress ?? "";
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 1, result: same } })).toEqual({
			action: "end",
			reason: "no-progress",
		});
		const moved = "r1|unmet|retry||retry:0123456789ab";
		expect(decideRound({ ...base, gate, progressSince: { changes: 0, reviews: 0, requests: 1, result: moved } })).toMatchObject({ action: "continue" });
	});
});
