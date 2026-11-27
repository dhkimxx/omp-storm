/**
 * R9's ordered checks, on their own: which fact refuses a plan-less automatic open first, and the same-turn predicate
 * every automatic start uses. The controller and the tool-call handler call this module, so its order is the contract
 * the tests pin without a session, a clock or a file.
 */
import { describe, expect, test } from "bun:test";
import {
	PLANLESS_AUTO_OFF,
	PLANLESS_NO_TURN,
	PLANLESS_NO_TURN_TIME,
	PLANLESS_RUN_ACTIVE,
	PLANLESS_SAME_TURN,
	type PlanlessFacts,
	planlessOpen,
	stoppedInTurn,
} from "../src/runtime/planless.ts";

const facts = (over: Partial<PlanlessFacts> = {}): PlanlessFacts => ({
	automatic: true,
	runActive: false,
	task: "고쳐 줘",
	turnStartedAt: 1_000,
	lastEndAt: undefined,
	blocked: undefined,
	...over,
});

describe("R9: the ordered checks of a plan-less automatic open", () => {
	test("automatic delegation off refuses first, whatever else would", () => {
		expect(planlessOpen(facts({ automatic: false, runActive: true, task: undefined, blocked: "팀 설정 문제" }))).toEqual({
			ok: false,
			code: "auto-off",
			reason: PLANLESS_AUTO_OFF,
		});
	});

	test("an active run refuses before the turn, the same-turn fact and the team", () => {
		expect(planlessOpen(facts({ runActive: true, task: "", turnStartedAt: undefined, lastEndAt: 9_000, blocked: "팀 설정 문제" }))).toEqual({
			ok: false,
			code: "run-active",
			reason: PLANLESS_RUN_ACTIVE,
		});
	});

	test("this turn's own user prompt is required; an empty or absent one refuses before any later fact", () => {
		for (const task of [undefined, "", "   ", "\n\t"]) {
			expect(planlessOpen(facts({ task, turnStartedAt: undefined, lastEndAt: 9_000, blocked: "팀 설정 문제" }))).toEqual({
				ok: false,
				code: "no-turn",
				reason: PLANLESS_NO_TURN,
			});
		}
	});

	test("a prompt with no usable time refuses: the same-turn rule cannot be established", () => {
		expect(planlessOpen(facts({ turnStartedAt: undefined }))).toEqual({ ok: false, code: "no-turn-time", reason: PLANLESS_NO_TURN_TIME });
		expect(planlessOpen(facts({ turnStartedAt: Number.NaN }))).toEqual({ ok: false, code: "no-turn-time", reason: PLANLESS_NO_TURN_TIME });
		expect(planlessOpen(facts({ turnStartedAt: Number.POSITIVE_INFINITY }))).toEqual({ ok: false, code: "no-turn-time", reason: PLANLESS_NO_TURN_TIME });
	});

	test("a run ended or stopped at or after this prompt refuses, and does so before the team check", () => {
		for (const lastEndAt of [1_000, 1_001, 9_000]) {
			expect(planlessOpen(facts({ lastEndAt, blocked: "팀 설정 문제" }))).toEqual({
				ok: false,
				code: "same-turn",
				reason: PLANLESS_SAME_TURN,
			});
		}
	});

	test("a stop before the prompt, or none in this process, passes that check", () => {
		expect(planlessOpen(facts({ lastEndAt: 999 }))).toEqual({ ok: true, task: "고쳐 줘", turnStartedAt: 1_000 });
		expect(planlessOpen(facts())).toEqual({ ok: true, task: "고쳐 줘", turnStartedAt: 1_000 });
	});

	test("the team and mode refusal is last and keeps the caller's own sentence", () => {
		const blocked = "omp 계획 모드가 켜져 있어 자동 실행을 열지 않았습니다.";
		expect(planlessOpen(facts({ blocked }))).toEqual({ ok: false, code: "blocked", reason: blocked });
		// Blank is not a cause.
		expect(planlessOpen(facts({ blocked: "  " })).ok).toBe(true);
	});

	test("the opened task is the user's prompt as given, not its trimmed copy", () => {
		const opened = planlessOpen(facts({ task: "  고쳐 줘\n" }));
		expect(opened).toEqual({ ok: true, task: "  고쳐 줘\n", turnStartedAt: 1_000 });
	});
});

describe("R9's same-turn predicate", () => {
	test("at or after the prompt is in the same turn; before it, or no recorded end, is not", () => {
		expect(stoppedInTurn(1_000, undefined)).toBe(false);
		expect(stoppedInTurn(1_000, 999)).toBe(false);
		expect(stoppedInTurn(1_000, 1_000)).toBe(true);
		expect(stoppedInTurn(1_000, 1_001)).toBe(true);
	});
});
