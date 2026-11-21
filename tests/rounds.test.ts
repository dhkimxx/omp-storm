import { describe, expect, test } from "bun:test";
import { buildRoundMessage, decideRound, END_STATUS, endLabel, type Gate, maxRounds, reviewGate } from "../src/runtime/rounds.ts";
import type { AgentEntry, StormConfig } from "../src/types.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

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
	...over,
});

describe("end labels", () => {
	test("only a settled or verified run ends as done", () => {
		const reasons = ["settled", "verified", "interrupted", "round-limit", "no-progress", "time-limit", "shutdown", "budget", "start-failed"];
		expect(Object.keys(END_STATUS).sort()).toEqual([...reasons].sort());
		for (const [reason, status] of Object.entries(END_STATUS)) {
			expect(status).toBe(reason === "settled" || reason === "verified" ? "done" : "stopped");
		}
	});

	test("a reason this version does not know is shown as it was written", () => {
		expect(endLabel("goal-complete")).toBe("goal-complete");
		expect(endLabel("loop-paused")).toBe("loop-paused");
		expect(endLabel("settled")).not.toBe("settled");
	});
});

describe("reviewGate", () => {
	test("no agents and no changed files are nothing to verify", () => {
		expect(reviewGate([], TEAM)).toEqual({ state: "none" });
		expect(reviewGate([agentEntry({ role: "implementer", changes: 0 })], TEAM)).toEqual({ state: "none" });
	});

	test("only a quick agent changed files", () => {
		expect(reviewGate([agentEntry({ role: "quick", changes: 2, lastChangeAt: T0 })], TEAM)).toEqual({ state: "none" });
	});

	test("a writer whose team has no usable reviewer role", () => {
		expect(reviewGate([writer()], NO_REVIEWER)).toEqual({ state: "none" });
	});

	test("a writer without a verdict needs a review", () => {
		expect(reviewGate([writer()], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0 });
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
		expect(reviewGate([writer(), implementer], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0 });
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
		expect(reviewGate([roleless], TEAM)).toEqual({ state: "unverified", cause: "no-review", changes: 1, reviews: 0 });
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
		expect(gate).toEqual({ state: "unverified", cause: "stale-review", changes: 7, reviews: 2 });
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

	test("nothing to verify settles, even past the budget", () => {
		expect(decideRound({ ...base, gate: { state: "none" }, overBudget: true })).toEqual({ action: "end", reason: "settled" });
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

	test("no progress needs both counts unchanged", () => {
		expect(decideRound({ ...base, progressSince: { changes: 1, reviews: 0 } })).toEqual({
			action: "end",
			reason: "no-progress",
		});
		expect(decideRound({ ...base, progressSince: { changes: 1, reviews: 1 } })).toMatchObject({ action: "continue" });
		expect(decideRound({ ...base, progressSince: { changes: 2, reviews: 0 } })).toMatchObject({ action: "continue" });
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
	});

	test("the last-round sentence appears only in the last round", () => {
		expect(message(4, 4).split("\n").length).toBe(message(3, 4).split("\n").length + 1);
	});
});
