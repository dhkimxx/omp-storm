import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	CLOSEOUT_NEXT_MAX,
	CLOSEOUT_TEXT_MAX,
	type CloseoutDraft,
	closeoutCard,
	isSubstantiveRun,
	parseCloseout,
	rememberCloseoutReport,
	resetCloseoutChoices,
	takeCloseoutChoice,
} from "../src/runtime/closeout.ts";
import type { RunPlan, RunRecord } from "../src/types.ts";
import { agentEntry, runRecord } from "./fixtures.ts";

const draft = (over: Partial<CloseoutDraft> = {}): CloseoutDraft => ({
	result: "API를 추가했습니다.",
	verification: "unit 체크를 통과했습니다.",
	remaining: "문서 반영이 남았습니다.",
	next: ["문서 반영을 새 Storm 작업으로 맡기기", "API 경계를 다시 점검하는 좁은 작업", "변경 기록만 읽기 전용으로 확인하기"],
	...over,
});

const ctx = (sessionId?: string): ExtensionContext =>
	({
		...(sessionId === undefined ? {} : { sessionManager: { getSessionId: () => sessionId } }),
	}) as unknown as ExtensionContext;

const lane = (name: string, kind: RunPlan["lanes"][number]["kind"] = "code", extra: Partial<RunPlan["lanes"][number]> = {}) => ({
	name,
	kind,
	role: kind === "review" ? "reviewer" : kind === "design" ? "architect" : kind === "explore" ? "explorer" : "implementer",
	...extra,
});

const plan = (...lanes: RunPlan["lanes"]): RunPlan => ({
	lanes,
	workers: { implementer: lanes.length, reviewer: lanes.length, architect: lanes.length, explorer: lanes.length },
	submittedAt: "2026-11-20T09:00:00.000Z",
});

const record = (over: Partial<RunRecord> = {}): RunRecord => runRecord(over);

afterEach(() => resetCloseoutChoices());

describe("closeout brief validation", () => {
	test("trims the fields and requires exactly three distinct one-line directions", () => {
		expect(
			parseCloseout({
				result: "  결과  ",
				verification: " 검증 ",
				remaining: " 남음 ",
				next: [" 하나 ", "둘", "셋"],
			}),
		).toEqual({ result: "결과", verification: "검증", remaining: "남음", next: ["하나", "둘", "셋"] });
		expect(parseCloseout({ result: "결과", verification: "검증", next: ["하나", "둘", "셋"] })).toEqual({
			result: "결과",
			verification: "검증",
			next: ["하나", "둘", "셋"],
		});
	});

	test("never synthesizes a missing or empty result or verification", () => {
		expect(parseCloseout({ verification: "검증", next: ["a", "b", "c"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", next: ["a", "b", "c"] })).toBeUndefined();
		expect(parseCloseout({ result: " ", verification: "검증", next: ["a", "b", "c"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "", next: ["a", "b", "c"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "검증", remaining: "", next: ["a", "b", "c"] })).toBeUndefined();
	});

	test("rejects wrong shapes, excess length, duplicates and multi-line or control content", () => {
		expect(parseCloseout(undefined)).toBeUndefined();
		expect(parseCloseout(null)).toBeUndefined();
		expect(parseCloseout("brief")).toBeUndefined();
		expect(parseCloseout([1, 2, 3])).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "검증", next: ["a", "b"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "검증", next: ["a", "b", "c", "d"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "검증", next: ["a", "a", "b"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "검증", next: ["a", " A ", "b"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과".repeat(CLOSEOUT_TEXT_MAX), verification: "검증", next: ["a", "b", "c"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "검증".repeat(CLOSEOUT_TEXT_MAX), next: ["a", "b", "c"] })).toBeUndefined();
		expect(parseCloseout({ result: "결과", verification: "검증", next: ["a".repeat(CLOSEOUT_NEXT_MAX + 1), "b", "c"] })).toBeUndefined();
		for (const unsafe of ["첫 줄\n둘째 줄", "첫 줄\r둘째 줄", "탭\t문자", "구분\u2028문자", "\u0007벨"]) {
			expect(parseCloseout({ result: unsafe, verification: "검증", next: ["a", "b", "c"] })).toBeUndefined();
			expect(parseCloseout({ result: "결과", verification: unsafe, next: ["a", "b", "c"] })).toBeUndefined();
			expect(parseCloseout({ result: "결과", verification: "검증", next: [unsafe, "b", "c"] })).toBeUndefined();
		}
	});
});

describe("substantive run detection", () => {
	test("a submitted brief always makes the run substantive", () => {
		expect(isSubstantiveRun(record({ closeout: draft() }))).toBe(true);
	});

	test("multiple lanes are substantive, while one explore or an unproductive code probe stays routine", () => {
		expect(isSubstantiveRun(record({ plan: plan(lane("one", "explore"), lane("two", "explore")) }))).toBe(true);
		expect(isSubstantiveRun(record({ plan: plan(lane("probe", "explore")) }))).toBe(false);
		expect(isSubstantiveRun(record({ plan: plan(lane("probe", "code")), agents: [agentEntry({ changes: 0 })] }))).toBe(false);
		expect(isSubstantiveRun(record({ plan: plan(lane("probe", "code")), agents: [agentEntry({ changes: 1 })] }))).toBe(true);
	});

	test("run, design and review lanes need real worker activity; checks count as meaningful work", () => {
		expect(isSubstantiveRun(record({ plan: plan(lane("review", "review")), agents: [agentEntry({ role: "reviewer" })] }))).toBe(true);
		expect(isSubstantiveRun(record({ plan: plan(lane("design", "design")), agents: [agentEntry({ role: "architect" })] }))).toBe(true);
		expect(isSubstantiveRun(record({ plan: plan(lane("build", "run")), agents: [agentEntry({ role: "quick" })] }))).toBe(true);
		expect(isSubstantiveRun(record({ checks: [{ name: "unit", status: "passed", exitCode: 0, tree: "t" }] }))).toBe(true);
	});

	test("a manual run is judged from its own ledger, not from spawn records alone", () => {
		expect(isSubstantiveRun(record({ agents: [agentEntry({ changes: 0 })] }))).toBe(false);
		expect(isSubstantiveRun(record({ agents: [agentEntry({ changes: 2 })] }))).toBe(true);
		expect(
			isSubstantiveRun(record({ agents: [agentEntry({ changes: 0, review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] } })] })),
		).toBe(true);
	});
});

describe("closeout card", () => {
	test("uses Storm's real status and the staged brief, then the brief's ordered directions", () => {
		const brief = draft();
		const card = closeoutCard(
			record({
				status: "done",
				endReason: "verified",
				turns: 1,
				maxRounds: 2,
				closeout: brief,
				checks: [{ name: "unit", status: "passed", exitCode: 0, tree: "t" }],
			}),
			["docs"],
		);
		expect(card.options).toBe(brief.next);
		expect(card.text).toContain("- 상태(공식): 완료 · 리뷰 통과 · 1/2라운드");
		expect(card.text).toContain(`- 결과(감독 보고): ${brief.result}`);
		expect(card.text).toContain(`- 검증(감독 보고): ${brief.verification}`);
		expect(card.text).toContain(`- 남은 일(감독 보고): ${brief.remaining}`);
		expect(card.text).toContain("- 체크(공식): unit passed(0)");
		expect(card.text).toContain("- 미완료 레인: docs");
		expect(card.text).toContain("다음으로 무엇을 할까요?");
		expect(card.text).toContain(`1. 추천 — ${brief.next[0]}`);
		expect(card.text).toContain(`2. ${brief.next[1]}`);
		expect(card.text).toContain(`3. ${brief.next[2]}`);
		expect(card.text).not.toContain("검증된 결과 브리프가 제출되지 않았습니다");
	});

	test("a substantive run without a brief says so and offers three conservative distinct directions", () => {
		const card = closeoutCard(
			record({
				status: "stopped",
				endReason: "interrupted",
				turns: 1,
				maxRounds: 4,
				task: "fix the parser",
				checks: [{ name: "unit", status: "failed", exitCode: 1, tree: "t" }],
			}),
			["view"],
		);
		expect(card.text).toContain("- 상태(공식): 중단 · 사용자가 중단 · 1/4라운드");
		expect(card.text).toContain("- 결과: 검증된 결과 브리프가 제출되지 않았습니다.");
		expect(card.text).toContain("- 체크(공식): unit failed(1)");
		expect(card.text).toContain("- 미완료 레인: view");
		expect(card.text).toContain("다음으로 무엇을 할까요?");
		expect(card.text).toContain("1. 추천 —");
		expect(card.text.match(/^[1-3]\. /gm)).toHaveLength(3);
		expect(new Set(card.options).size).toBe(3);
		expect(card.options[1]).toContain("view");
		expect(card.options[2]).toContain("기록으로 남기는 마무리");
		expect(card.options[2]).not.toContain("검증까지 포함");
		expect(card.text).not.toContain("리뷰 통과");
	});

	test("shows required checks even without evidence and with a draft, and never calls a missing remaining field empty", () => {
		const card = closeoutCard(
			record({
				status: "ended",
				endReason: "unreviewed",
				closeout: { result: "r", verification: "v", next: ["a", "b", "c"] },
			}),
			[],
			["unit", "lint"],
		);
		expect(card.text).toContain("- 체크(공식): unit 기록 없음 · lint 기록 없음");
		expect(card.text).toContain("남은 일(감독 보고): 미기재 — 남은 작업이 없다는 증거는 아닙니다.");
	});

	test("omits a checks line when no check evidence or required check name exists", () => {
		const card = closeoutCard(record({ status: "stopped", endReason: "no-progress", closeout: draft() }), []);
		expect(card.text).not.toContain("- 체크");
		expect(card.text).not.toContain("- 미완료 레인:");
	});
});

describe("closeout choice resolution", () => {
	test("resolves 1..3 for the most recently shown same-session card exactly once", () => {
		const session = ctx("session-a");
		rememberCloseoutReport(session, "run-1", ["first", "second", "third"]);
		expect(takeCloseoutChoice(session, "1")).toBe("first");
		expect(takeCloseoutChoice(session, "2")).toBeUndefined();

		rememberCloseoutReport(session, "run-2", ["new-first", "new-second", "new-third"]);
		expect(takeCloseoutChoice(session, "3")).toBe("new-third");
		expect(takeCloseoutChoice(session, "1")).toBeUndefined();
	});

	test("the newest card replaces the previous one and any non-choice input consumes it", () => {
		const session = ctx("session-a");
		rememberCloseoutReport(session, "run-1", ["old", "older", "oldest"]);
		rememberCloseoutReport(session, "run-2", ["first", "second", "third"]);
		expect(takeCloseoutChoice(session, "1")).toBe("first");
		rememberCloseoutReport(session, "run-3", ["newest", "later", "last"]);
		expect(takeCloseoutChoice(session, "other input")).toBeUndefined();
		expect(takeCloseoutChoice(session, "1")).toBeUndefined();
	});

	test("another session never resolves, consumes, or reports this session's card", () => {
		const session = ctx("session-a");
		rememberCloseoutReport(session, "run-1", ["first", "second", "third"]);
		expect(takeCloseoutChoice(ctx("session-b"), "1")).toBeUndefined();
		expect(takeCloseoutChoice(ctx(), "1")).toBeUndefined();
		expect(takeCloseoutChoice(session, "2")).toBe("second");
	});

	test("a host without a public session identity can show the card but never resolve a choice", () => {
		expect(rememberCloseoutReport(ctx(), "run-1", ["first", "second", "third"])).toBe(false);
		expect(takeCloseoutChoice(ctx(), "1")).toBeUndefined();
	});

	test("a lifecycle reset drops the pending choice for that session", () => {
		const session = ctx("session-a");
		rememberCloseoutReport(session, "run-1", ["first", "second", "third"]);
		resetCloseoutChoices(session);
		expect(takeCloseoutChoice(session, "1")).toBeUndefined();
	});
});
