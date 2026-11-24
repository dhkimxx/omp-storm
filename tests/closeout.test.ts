import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	CLOSEOUT_JOB_ENTRY_MAX,
	CLOSEOUT_NEXT_MAX,
	CLOSEOUT_RESULT_ENTRY_MAX,
	CLOSEOUT_TEXT_MAX,
	type CloseoutDraft,
	closeoutCard,
	isSubstantiveRun,
	parseCloseout,
	rememberCloseoutReport,
	resetCloseoutChoices,
	takeCloseoutChoice,
} from "../src/runtime/closeout.ts";
import type { RunJob, RunPlan, RunRecord, RunResult } from "../src/types.ts";
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

	test("one accepted answer is substantive; a read without a result stays quiet", () => {
		const read = plan(
			lane("read-report", "explore", {
				results: [{ id: "report-answer", kind: "answer", criterion: "states the total", path: "report.json" }],
			}),
		);
		expect(
			isSubstantiveRun(
				record({
					plan: read,
					results: [{ id: "report-answer", lane: "read-report", state: "accepted" }],
				}),
			),
		).toBe(true);
		// The same lane with no declared or observed result is a casual read, not a delivered output.
		expect(isSubstantiveRun(record({ plan: read }))).toBe(false);
		expect(isSubstantiveRun(record({ plan: plan(lane("read-report", "explore")) }))).toBe(false);
	});

	test("an accepted artifact is substantive even when its plan is gone", () => {
		expect(
			isSubstantiveRun(
				record({
					results: [
						{
							id: "experiment-output",
							state: "accepted",
							contract: { id: "experiment-output", kind: "artifact", criterion: "retained output" },
						},
					],
				}),
			),
		).toBe(true);
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
		expect(card.text).not.toContain("- 잡 영수증");
		expect(card.text).not.toContain("- 미완료 레인:");
	});
});

describe("required-result closeout rows", () => {
	test("T01: an unmet requirement keeps its id, lane and runtime reason while the official status stays unchanged", () => {
		const accepted: RunResult = {
			id: "report-answer",
			lane: "read-report",
			state: "accepted",
			reason: "기존 내용을 출처와 함께 확인했습니다.",
		};
		const run = record({
			status: "ended",
			endReason: "no-changes",
			task: "report.json 갱신",
			plan: plan(
				lane("report", "code", {
					results: [{ id: "report-change", kind: "change", criterion: "report.json을 갱신", path: "report.json" }],
				}),
			),
			agents: [agentEntry({ changes: 0 })],
			results: [
				{ id: "report-change", lane: "report", state: "unmet", reason: "사전 기준선 이후 바뀐 내용이 없습니다." },
				accepted,
			],
		});
		expect(isSubstantiveRun(run)).toBe(true);
		// The accepted answer alone is delivered output now, even without a file edit or a submitted brief.
		expect(isSubstantiveRun({ ...run, results: [accepted] })).toBe(true);
		const card = closeoutCard(run, ["report"]);
		expect(card.text).toContain("- 상태(공식): 끝남 · 변경 없음");
		expect(card.text).toContain(
			"- 미해결 필수 결과(공식): report-change [report] 미충족 — 사전 기준선 이후 바뀐 내용이 없습니다.",
		);
		expect(card.text).toContain(
			"- 이행 필수 결과(공식): report-answer [read-report] 이행 — 기존 내용을 출처와 함께 확인했습니다.",
		);
		expect(card.text).not.toContain("- 미완료 레인:");
	});

	test("T01c: one accepted answer is one substantive card with its status, host reference and conservative directions", () => {
		const run = record({
			status: "done",
			endReason: "verified",
			task: "report.json의 total 값 확인",
			plan: plan(
				lane("read-report", "explore", {
					results: [{ id: "report-answer", kind: "answer", criterion: "states the total", path: "report.json" }],
				}),
			),
			agents: [agentEntry({ name: "storm-explorer", role: "explorer", changes: 0 })],
			results: [
				{
					id: "report-answer",
					lane: "read-report",
					state: "accepted",
					reason: "report.json:2에서 42를 확인했습니다.",
					attemptId: "job:job-1:read-report",
				},
			],
		});
		expect(isSubstantiveRun(run)).toBe(true);
		const card = closeoutCard(run);
		// The verified web reason normally says a code review passed; an output-only run must not claim that.
		expect(card.text).toContain("- 상태(공식): 완료 · 필수 결과 이행");
		expect(card.text).not.toContain("리뷰 통과");
		expect(card.text).toContain(
			"- 이행 필수 결과(공식): report-answer [read-report] 이행 · 시도: job:job-1:read-report — report.json:2에서 42를 확인했습니다.",
		);
		// No director draft is synthesized: the card says so and still recommends exactly the first of three choices.
		expect(card.text).toContain("- 결과: 검증된 결과 브리프가 제출되지 않았습니다.");
		expect(card.text).toContain(`1. 추천 — ${card.options[0]}`);
		expect(card.text.match(/^[1-3]\. /gm)).toHaveLength(3);
		expect(new Set(card.options).size).toBe(3);
		expect(card.options[0]).toContain("필수 결과 이행");
	});

	test("T01d: an unaccepted required answer stays on the unresolved line", () => {
		const run = record({
			status: "stopped",
			endReason: "no-progress",
			plan: plan(
				lane("read-report", "explore", {
					results: [{ id: "report-answer", kind: "answer", criterion: "states the total", path: "report.json" }],
				}),
			),
			results: [
				{
					id: "report-answer",
					lane: "read-report",
					state: "unmet",
					reason: "인용한 출처가 답과 일치하지 않습니다.",
				},
			],
		});
		expect(isSubstantiveRun(run)).toBe(true);
		const card = closeoutCard(run, ["read-report"]);
		expect(card.text).toContain(
			"- 미해결 필수 결과(공식): report-answer [read-report] 미충족 — 인용한 출처가 답과 일치하지 않습니다.",
		);
		expect(card.text).not.toContain("- 이행 필수 결과");
		expect(card.text).not.toContain("리뷰 통과");
	});

	test("an accepted row without a reason or a safe reference shows only its state", () => {
		const card = closeoutCard(
			record({
				results: [{ id: "answer", state: "accepted", attemptId: "/tmp/storm/attempt" }],
			}),
		);
		expect(card.text).toContain("- 이행 필수 결과(공식): answer 이행");
		expect(card.text).not.toContain("answer 이행 —");
		expect(card.text).not.toContain("/tmp/");
	});

	test("T01e: host job receipts follow result rows and never stand in for an accepted output", () => {
		const job = (
			lane: string,
			name: string,
			status: "passed" | "failed" | "timed-out",
			exitCode: number | null,
		): RunJob => ({ lane, name, status, exitCode, startedAt: null, finishedAt: null });
		const card = closeoutCard(
			record({
				status: "done",
				endReason: "verified",
				results: [
					{
						id: "answer",
						lane: "bench",
						state: "accepted",
						contract: { id: "answer", kind: "answer", criterion: "state the benchmark outcome" },
						reason: "bench 결과를 출처와 함께 확인했습니다.",
					},
				],
				jobs: [
					job("bench", "bench", "passed", 0),
					job("train", "train", "timed-out", null),
					job("probe", "probe", "failed", 1),
					job("extra", "extra", "passed", 0),
				],
			}),
		);
		const resultAt = card.text.indexOf("- 이행 필수 결과");
		const receiptAt = card.text.indexOf("- 잡 영수증(호스트):");
		expect(resultAt).toBeGreaterThanOrEqual(0);
		expect(receiptAt).toBeGreaterThan(resultAt);
		expect(card.text).toContain(
			`- 잡 영수증(호스트): bench [bench] passed(0) · train [train] timed-out · probe [probe] failed(1) · 외 ${4 - CLOSEOUT_JOB_ENTRY_MAX}건`,
		);
		// An exit receipt is not a review or a scientific conclusion.
		expect(card.text).not.toContain("리뷰 통과");
	});

	test("T06: a reviewable qualitative submission is visible with its reason, without becoming unmet or verified", () => {
		const run = record({
			status: "ended",
			endReason: "unreviewed",
			results: [
				{
					id: "qualitative-submission",
					lane: "review",
					state: "reviewable",
					reason: "출처를 확인했습니다. 답변의 자연어 판단이 필요합니다.",
				},
			],
		});
		const card = closeoutCard(run, ["review"]);
		expect(card.text).toContain("- 상태(공식): 끝남 · 리뷰 없이 끝남");
		expect(card.text).toContain(
			"- 검토 가능 필수 결과(공식): qualitative-submission [review] — 출처를 확인했습니다. 답변의 자연어 판단이 필요합니다.",
		);
		expect(card.text).not.toContain("- 미해결 필수 결과");
		expect(card.text).not.toContain("- 미완료 레인:");
	});

	test("a pending obligation is reported without rewriting the runtime's final status", () => {
		const card = closeoutCard(
			record({
				status: "done",
				endReason: "verified",
				results: [
					{ id: "final-review", lane: "review", state: "pending", reason: "자연어 판단이 아직 기록되지 않았습니다." },
				],
			}),
		);
		expect(card.text).toContain("- 상태(공식): 완료 · 리뷰 통과");
		expect(card.text).toContain("final-review [review] 대기 — 자연어 판단이 아직 기록되지 않았습니다.");
	});

	test("a missing reason falls back to the state's plain meaning, never an invented cause", () => {
		const card = closeoutCard(
			record({
				status: "ended",
				endReason: "no-changes",
				results: [
					{ id: "change", state: "unmet" },
					{ id: "later", lane: "build", state: "pending" },
				],
			}),
		);
		expect(card.text).toContain("change 미충족 — 미충족 사유가 기록되지 않았습니다.");
		expect(card.text).toContain("later [build] 대기 — 아직 판정 근거가 기록되지 않았습니다.");
	});

	test("bounds a line's rows and sanitizes control characters instead of dumping raw text", () => {
		const results: RunResult[] = Array.from({ length: CLOSEOUT_RESULT_ENTRY_MAX + 2 }, (_, index) => ({
			id: index === 0 ? "req\u20280" : `req-${index}`,
			lane: "work",
			state: "unmet",
			reason: index === 0 ? "reason\u0000 with\nlines" : `reason ${index}`,
		}));
		const card = closeoutCard(record({ status: "stopped", endReason: "no-progress", results }));
		const rows = card.text.split("\n").find(text => text.startsWith("- 미해결 필수 결과(공식):"));
		expect(rows).toBeDefined();
		expect(rows).toContain("req 0 [work] 미충족 — reason with lines");
		expect(rows).toContain(`req-${CLOSEOUT_RESULT_ENTRY_MAX - 1}`);
		expect(rows).not.toContain(`req-${CLOSEOUT_RESULT_ENTRY_MAX}`);
		expect(rows).toContain("외 2건");
		expect(rows).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
	});

	test("legacy records without a results ledger keep the previous card text", () => {
		const run = record({
			status: "stopped",
			endReason: "interrupted",
			turns: 1,
			maxRounds: 4,
			task: "fix the parser",
			checks: [{ name: "unit", status: "failed", exitCode: 1, tree: "t" }],
		});
		const legacy = closeoutCard(run, ["view"]);
		expect(closeoutCard({ ...run, results: [] }, ["view"]).text).toBe(legacy.text);
		expect(legacy.text).not.toContain("필수 결과");
		expect(legacy.text).toContain("- 미완료 레인: view");
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

describe("closeout result remedies", () => {
	test("a host retry exhaustion and a structured blocker keep their bounded cause and unblock", () => {
		const card = closeoutCard(
			record({
				status: "stopped",
				endReason: "no-progress",
				results: [
					{
						id: "retry-result",
						lane: "b-repair",
						state: "unmet",
						remedy: "retry",
						reason: "호스트 자동 재시도가 소진되었습니다(시도 1).",
					},
					{
						id: "blocked-result",
						lane: "write",
						state: "unmet",
						remedy: "blocked",
						unblock: "omp task.isolation.enabled를 켜고 팀을 다시 승인하세요.",
						reason: "격리 설정이 꺼져 있어 레인을 시작하지 못했습니다.",
					},
					{
						id: "review-blocked",
						lane: "review",
						state: "reviewable",
						remedy: "blocked",
						unblock: "승인된 리뷰어 역할을 켜세요.",
						reason: "제출물을 판단할 리뷰어가 없습니다.",
					},
				],
			}),
		);
		expect(card.text).toContain("retry-result [b-repair] 미충족 · 재시도 소진 — 호스트 자동 재시도가 소진되었습니다(시도 1).");
		expect(card.text).toContain(
			"blocked-result [write] 미충족 · 차단 — 격리 설정이 꺼져 있어 레인을 시작하지 못했습니다. · 해소: omp task.isolation.enabled를 켜고 팀을 다시 승인하세요.",
		);
		expect(card.text).toContain("review-blocked [review] · 차단 — 제출물을 판단할 리뷰어가 없습니다. · 해소: 승인된 리뷰어 역할을 켜세요.");
	});

	test("an accepted row never claims a stale remedy and an overlong unblock is bounded and sanitized", () => {
		const card = closeoutCard(
			record({
				status: "done",
				endReason: "verified",
				results: [
					{ id: "accepted", state: "accepted", remedy: "retry", unblock: "stale" },
					{ id: "blocked", state: "unmet", remedy: "blocked", unblock: `${"x".repeat(200)}\nnext`, reason: "차단" },
				],
			}),
		);
		expect(card.text).not.toContain("accepted ·");
		expect(card.text).not.toContain("stale");
		const line = card.text.split("\n").find(text => text.includes("blocked 미충족")) ?? "";
		expect(line).toContain("· 해소: ");
		expect(line).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
		expect(line.length).toBeLessThan(300);
	});
});
