import { describe, expect, test } from "bun:test";
import { buildRoundMessage, decideRound, END_STATUS, endLabel, type Gate, maxRounds, reviewGate, STATUS_LABEL } from "../src/runtime/rounds.ts";
import type { AgentEntry, RunStatus, StormConfig } from "../src/types.ts";
import { agentEntry, teamOf, treeOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM = teamOf({ implementer: "a/i", reviewer: "a/r" });
const NO_REVIEWER = teamOf({ implementer: "a/i", reviewer: "a/r" }, { disabledRoles: ["reviewer"] });

const writer = (over: Partial<AgentEntry> = {}): AgentEntry =>
	agentEntry({ role: "implementer", changes: 1, lastChangeAt: T0, ...over });

const reviewed = (at: number, correct: boolean): AgentEntry =>
	agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at, correct } });

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
	});

	test("only a quick agent changed files", () => {
		expect(reviewGate([agentEntry({ role: "quick", changes: 2, lastChangeAt: T0 })], TEAM)).toEqual({ state: "none", why: "quick-only" });
	});

	test("a writer whose team has no usable reviewer role", () => {
		expect(reviewGate([writer()], NO_REVIEWER)).toEqual({ state: "none", why: "no-reviewer" });
	});

	test("a writer without a verdict needs a review", () => {
		expect(reviewGate([writer()], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
	});

	test("a verdict before the last change is stale", () => {
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewed(T0 - 1, true)], TEAM)).toMatchObject({
			state: "unverified",
			cause: "stale-review",
		});
	});

	test("a verdict at exactly the last change's time is stale", () => {
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewed(T0, true)], TEAM)).toMatchObject({
			state: "unverified",
			cause: "stale-review",
		});
	});

	test("the latest verdict decided the gate", () => {
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewed(T0 + 1, false)], TEAM)).toMatchObject({
			state: "unverified",
			cause: "incorrect",
		});
		expect(
			reviewGate(
				[
					writer({ lastChangeAt: T0 }),
					reviewed(T0 + 1, false),
					agentEntry({ id: "Later", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 2, correct: true } }),
				],
				TEAM,
			),
		).toEqual({ state: "passed" });
	});

	test("a writer, an implementer or a quick agent cannot verify the run", () => {
		// The writer's own verdict, even a correct one after its change, does not count.
		const self = writer({ id: "Self", lastVerdict: { at: T0 + 1, correct: true } });
		expect(reviewGate([writer(), self], TEAM)).toMatchObject({ state: "unverified", cause: "no-review", reviews: 0 });
		// An implementer that changed nothing cannot verify either, and its review tally does not count as progress.
		const implementer = agentEntry({ id: "Coder", role: "implementer", lastVerdict: { at: T0 + 1, correct: true }, review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] } });
		expect(reviewGate([writer(), implementer], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 2 });
		// Neither does a quick agent's.
		const quick = agentEntry({ id: "Q", role: "quick", lastVerdict: { at: T0 + 1, correct: true } });
		expect(reviewGate([writer(), quick], TEAM)).toMatchObject({ state: "unverified", cause: "no-review" });
		// The reviewer's verdict is the one that counts.
		expect(reviewGate([writer(), self, reviewed(T0 + 2, true)], TEAM)).toEqual({ state: "passed" });
	});

	test("a quick agent's later change does not make a passed review stale", () => {
		const gate = reviewGate([writer({ lastChangeAt: T0 }), reviewed(T0 + 1, true), agentEntry({ id: "Q", role: "quick", changes: 3, lastChangeAt: T0 + 5 })], TEAM);
		expect(gate).toEqual({ state: "passed" });
	});

	test("an agent without a role that changed files counts as a writer", () => {
		const roleless = agentEntry({ changes: 1, lastChangeAt: T0 });
		delete roleless.role;
		expect(reviewGate([roleless], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
	});

	test("changes and reviews are the sums over all agents", () => {
		const gate = reviewGate(
			[
				writer({ id: "A", changes: 2, lastChangeAt: T0 }),
				writer({ id: "B", changes: 1, lastChangeAt: T0 }),
				agentEntry({ id: "Q", role: "quick", changes: 4, lastChangeAt: T0 }),
				agentEntry({
					id: "Rev",
					name: "storm-reviewer",
					role: "reviewer",
					lastVerdict: { at: T0, correct: true },
					review: { reviews: 2, passed: 2, failed: 0, findings: [0, 0, 0, 0] },
				}),
			],
			TEAM,
		);
		expect(gate).toEqual({ state: "unverified", cause: "stale-review", changes: 7, reviews: 2, requests: 4 });
	});
});

describe("reviewGate with the work tree", () => {
	const CLEAN = treeOf("d0", "f0");
	const CHANGED = treeOf("d1", "f0");
	const implementer = agentEntry({ role: "implementer", changes: 0 });
	const reviewer = (tree?: string): AgentEntry =>
		agentEntry({
			id: "Rev",
			name: "storm-reviewer",
			role: "reviewer",
			lastVerdict: { at: T0 + 1, correct: true, ...(tree !== undefined ? { tree } : {}) },
		});

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

	test("a verdict given against the tree now passes", () => {
		expect(reviewGate([implementer, reviewer("d1:f0")], TEAM, { start: CLEAN, now: CHANGED })).toEqual({ state: "passed" });
	});

	test("a verdict given against another tree is stale, and says the tree is the reason", () => {
		expect(reviewGate([implementer, reviewer("d0:f0")], TEAM, { start: CLEAN, now: CHANGED })).toEqual({
			state: "unverified",
			cause: "stale-review",
			by: "tree",
			changes: 0,
			reviews: 0,
			requests: 2,
		});
	});

	test("a verdict before the last tool change is stale for its time, not for the tree", () => {
		const early = agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0, correct: true, tree: "d1:f0" } });
		const gate = reviewGate([writer({ lastChangeAt: T0 }), early], TEAM, { start: CLEAN, now: CHANGED });
		expect(gate).toMatchObject({ state: "unverified", cause: "stale-review" });
		expect(gate && "by" in gate).toBe(false);
	});

	test("a verdict given after the one tree re-review is not stale because of the tree", () => {
		const late = agentEntry({
			id: "Rev",
			name: "storm-reviewer",
			role: "reviewer",
			lastVerdict: { at: T0 + 2, correct: true, tree: "d0:f0" },
		});
		expect(reviewGate([implementer, late], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 1 })).toEqual({ state: "passed" });
		// The same verdict before that time still asks for the re-review.
		expect(reviewGate([implementer, late], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 3 })).toMatchObject({
			state: "unverified",
			cause: "stale-review",
			by: "tree",
		});
	});

	test("the one tree re-review does not excuse a verdict older than the last tool change", () => {
		const gate = reviewGate([writer({ lastChangeAt: T0 }), agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0, correct: true } })], TEAM, {
			start: CLEAN,
			now: CHANGED,
			rereviewedAt: T0 - 1,
		});
		expect(gate).toMatchObject({ state: "unverified", cause: "stale-review" });
		expect(gate && "by" in gate).toBe(false);
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
		expect(reviewGate([implementer, reviewer("d1:f0")], TEAM, { start: treeOf("d1", "f0"), now: treeOf("d1", "f1") })).toEqual({
			state: "unverified",
			cause: "stale-review",
			by: "tree",
			changes: 0,
			reviews: 0,
			requests: 2,
		});
	});

	test("an incorrect verdict is incorrect, never tree-stale", () => {
		const wrong = agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 2, correct: false, tree: "d0:f0" } });
		// The one tree round is not available at this verdict's time: the old order would call this stale by tree.
		expect(reviewGate([implementer, wrong], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 3 })).toEqual({
			state: "unverified",
			cause: "incorrect",
			changes: 0,
			reviews: 0,
			requests: 2,
		});
	});

	test("another agent active after the verdict makes a tree change team-stale even after the one tree round", () => {
		const rev = agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at: T0 + 2, correct: true, tree: "d0:f0" } });
		const worker = agentEntry({ id: "Impl", role: "implementer", changes: 0, lastActivityAt: T0 + 3 });
		const gate = reviewGate([worker, rev], TEAM, { start: CLEAN, now: CHANGED, rereviewedAt: T0 + 100 });
		expect(gate).toMatchObject({ state: "unverified", cause: "stale-review" });
		expect(gate && "by" in gate).toBe(false);
	});

	test("the verdict's own activity after it is not team activity", () => {
		const rev = agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastActivityAt: T0 + 5, lastVerdict: { at: T0 + 2, correct: true, tree: "d0:f0" } });
		expect(reviewGate([implementer, rev], TEAM, { start: CLEAN, now: CHANGED })).toMatchObject({
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

	test("without trees the gate is the tool-count gate of 0.11", () => {
		expect(reviewGate([writer()], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
		expect(reviewGate([writer()], TEAM, {})).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 1 });
		expect(reviewGate([writer({ lastChangeAt: T0 }), reviewed(T0 + 1, true)], TEAM)).toEqual({ state: "passed" });
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
	const message = (round: number, max: number, cause: Unverified["cause"] = "no-review", reviewer = "storm-reviewer"): string =>
		buildRoundMessage({ runId: "run-7", round, maxRounds: max, gate: unverified({ cause }), reviewer });

	test("one storm-run section naming the reviewer it was given", () => {
		const text = message(2, 4, "no-review", "custom-reviewer");
		expect(text.startsWith('<storm-run id="run-7" round="2/4">')).toBe(true);
		expect(text.endsWith("</storm-run>")).toBe(true);
		expect(text).toContain("custom-reviewer");
		expect(text).not.toContain("storm-reviewer");
		expect(text.length).toBeLessThan(600);
	});

	test("the three causes read differently", () => {
		const texts = (["no-review", "stale-review", "incorrect"] as const).map(cause => message(2, 4, cause));
		expect(new Set(texts).size).toBe(3);
		// Changes may be the user's or a shell command's: the message must not put them on the team.
		for (const text of texts) expect(text).not.toContain("The team changed files");
	});

	test("an unread tree gets its own cause sentence", () => {
		const gate = (unread: boolean): Unverified => unverified({ changes: 0, cause: "no-review", ...(unread ? { unread: true as const } : {}) });
		const plain = buildRoundMessage({ runId: "run-7", round: 2, maxRounds: 4, gate: gate(false), reviewer: "storm-reviewer" });
		const unread = buildRoundMessage({ runId: "run-7", round: 2, maxRounds: 4, gate: gate(true), reviewer: "storm-reviewer" });
		expect(unread).not.toBe(plain);
		expect(unread).toContain("could not be read");
		expect(plain).not.toContain("could not be read");
	});

	test("the last-round sentence appears only in the last round", () => {
		expect(message(4, 4).split("\n").length).toBe(message(3, 4).split("\n").length + 1);
	});
});
