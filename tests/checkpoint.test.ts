import { describe, expect, test } from "bun:test";
import { CHECKPOINT_INSTRUCTIONS, shouldCheckpoint, workingState } from "../src/runtime/checkpoint.ts";
import type { AgentEntry, RunRecord } from "../src/types.ts";

const MIN = 60_000;

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
	schema: "storm.run/v1",
	runId: "r1",
	configHash: "h",
	approvalId: "a",
	startedAt: "2026-11-21T00:00:00.000Z",
	status: "running",
	contract: "orchestrate",
	task: "결제 모듈 리팩터",
	costUsd: 0,
	costByModel: {},
	spawns: [],
	...over,
});

const agent = (over: Partial<AgentEntry> = {}): AgentEntry => ({
	id: "Impl",
	name: "storm-implementer",
	role: "implementer",
	runId: "r1",
	state: "idle",
	startedAt: 0,
	lastActivityAt: 10,
	contextTokens: 45_000,
	requests: 3,
	costUsd: 1,
	followUps: 0,
	...over,
});

describe("shouldCheckpoint", () => {
	test("fires at or past the cap, never below it", () => {
		expect(shouldCheckpoint({ tokens: 99_999, cap: 100_000, now: 0 })).toBe(false);
		expect(shouldCheckpoint({ tokens: 100_000, cap: 100_000, now: 0 })).toBe(true);
	});

	test("waits the gap (default 10 minutes) after the last checkpoint", () => {
		const now = 100 * MIN;
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, lastAt: now - 9 * MIN, now })).toBe(false);
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, lastAt: now - 10 * MIN, now })).toBe(true);
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, lastAt: now - 2 * MIN, now, minGapMs: MIN })).toBe(true);
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, lastAt: now, now, minGapMs: MIN })).toBe(false);
	});
});

test("checkpoint instructions keep decisions and evidence locations and drop raw contents", () => {
	for (const s of ["결정", "이유", "바뀐 파일", "근거 위치", "남은 문제", "다음 행동", "원문"]) {
		expect(CHECKPOINT_INSTRUCTIONS).toContain(s);
	}
});

describe("workingState", () => {
	test("lists lanes, the run's agents with handles, reviews and blocked counts", () => {
		const lines = workingState(
			run({
				plan: {
					lanes: [
						{ name: "결제 API 탐색", kind: "explore", role: "explorer" },
						{ name: "환불 경로 수정", kind: "code", role: "implementer" },
					],
					workers: {},
					submittedAt: "2026-11-21T00:00:00.000Z",
				},
				blockedEdits: 2,
				blockedFollowUps: 1,
				reads: { director: 9, duplicate: 3, blocked: 4 },
			}),
			[
				agent({ cleanedAt: 5 }),
				agent({
					id: "Rev",
					name: "storm-reviewer",
					role: "reviewer",
					state: "running",
					contextTokens: 12_300,
					review: { reviews: 2, passed: 1, failed: 1, findings: [0, 2, 1, 0], docFindings: 1 },
				}),
				agent({ id: "Elsewhere", runId: "r0" }),
			],
		);
		const text = lines.join("\n");
		expect(text).toContain("결제 모듈 리팩터");
		expect(text).toContain("- 결제 API 탐색 (explore, explorer)");
		expect(text).toContain("- 환불 경로 수정 (code, implementer)");
		expect(text).toContain("에이전트 2개");
		// Running agents come first.
		expect(lines.findIndex(l => l.includes("agent://Rev"))).toBeLessThan(lines.findIndex(l => l.includes("agent://Impl")));
		expect(text).toContain("agent://Rev — reviewer, 실행 중, 컨텍스트 12.3k 토큰");
		expect(text).toMatch(/agent:\/\/Impl — implementer, 유휴, 컨텍스트 45\.0k 토큰, 기록 정리됨/);
		expect(text).not.toContain("Elsewhere");
		expect(text).toContain("리뷰 2회: 통과 1, 실패 1; 지적 P0 0 · P1 2 · P2 1 · P3 0, 문서 지적 1");
		expect(text).toContain("파일 수정 2, 후속 지시 1, 읽기 4");
	});

	test("without a plan, agents or reviews it says so and still reports blocks", () => {
		const text = workingState(run(), []).join("\n");
		expect(text).toContain("계획: 아직 없음");
		expect(text).toContain("에이전트: 없음");
		expect(text).not.toContain("리뷰");
		expect(text).toContain("파일 수정 0, 후속 지시 0, 읽기 0");
	});

	test("stays bounded for many lanes and agents", () => {
		const lanes = Array.from({ length: 50 }, (_, i) => ({ name: `레인 ${i} ${"x".repeat(200)}`, kind: "code" as const, role: "implementer" }));
		const agents = Array.from({ length: 200 }, (_, i) => agent({ id: `A${i}`, lastActivityAt: i, state: i % 2 ? "parked" : "idle" }));
		const lines = workingState(run({ plan: { lanes, workers: {}, submittedAt: "x" } }), agents);
		expect(lines.length).toBeLessThan(60);
		expect(lines.every(l => l.length < 300)).toBe(true);
		const text = lines.join("\n");
		expect(text).toContain("에이전트 200개");
		expect(text).toContain("agent://A199"); // most recent first
		expect(text).not.toContain("agent://A0 ");
		expect(text).toContain("- 외 30개");
		expect(text).toMatch(/- 외 176개 \(유휴 \d+, 보관됨 \d+\)/);
	});
});
