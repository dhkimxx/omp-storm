import { describe, expect, test } from "bun:test";
import { MID_RUN_WINDOW_SHARE, RUN_START_WINDOW_SHARE, windowThreshold } from "../src/roles.ts";
import { CHECKPOINT_INSTRUCTIONS, checkpointGuidance, checkpointWorkState, shouldCheckpoint, workingState } from "../src/runtime/checkpoint.ts";
import type { AgentEntry, RunRecord, RunResult } from "../src/types.ts";
import { agentEntry, runRecord } from "./fixtures.ts";

const MIN = 60_000;
const TASK = "refactor the payment module";

const run = (over: Partial<RunRecord> = {}): RunRecord => runRecord({ runId: "r1", status: "running", task: TASK, ...over });
const agent = (over: Partial<AgentEntry> = {}): AgentEntry => agentEntry({ runId: "r1", lastActivityAt: 10, contextTokens: 45_000, ...over });

describe("windowThreshold", () => {
	test("run start compacts at half the window, mid-run at 70%, whatever the window size", () => {
		const at = (window: number) => [windowThreshold(RUN_START_WINDOW_SHARE, window), windowThreshold(MID_RUN_WINDOW_SHARE, window)];
		expect(at(200_000)).toEqual([100_000, 140_000]);
		expect(at(1_000_000)).toEqual([500_000, 700_000]);
	});

	test("an unknown window gives no threshold, so Storm starts no compaction", () => {
		for (const window of [undefined, 0]) {
			expect(windowThreshold(RUN_START_WINDOW_SHARE, window)).toBeUndefined();
			expect(windowThreshold(MID_RUN_WINDOW_SHARE, window)).toBeUndefined();
		}
	});
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

	test("an in-flight checkpoint excludes another; a host rejection waits the same gap", () => {
		const now = 100 * MIN;
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, now, inFlight: true })).toBe(false);
		// Below the cap, in flight or not, nothing is due.
		expect(shouldCheckpoint({ tokens: 1, cap: 100_000, now, lastRejectedAt: now })).toBe(false);
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, now, lastRejectedAt: now - 9 * MIN })).toBe(false);
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, now, lastRejectedAt: now - 10 * MIN })).toBe(true);
		expect(shouldCheckpoint({ tokens: 200_000, cap: 100_000, now, lastRejectedAt: now - 2 * MIN, minGapMs: MIN })).toBe(true);
	});
});

test("handoff checkpoint guidance carries Storm's ledger, not only the summarizer instructions", () => {
	const text = checkpointGuidance(
		run({
			task: "refactor billing",
			request: "refactor billing\nCONSTRAINT: do not touch refunds",
			plan: {
				lanes: [{ name: "move the invoice service", kind: "code", role: "implementer" }],
				workers: { implementer: 1 },
				submittedAt: "x",
			},
		}),
		[agent({ id: "Impl", name: "storm-implementer", role: "implementer", state: "running" })],
	);
	expect(text).toContain(CHECKPOINT_INSTRUCTIONS);
	expect(text).toContain("CONSTRAINT: do not touch refunds");
	expect(text).toContain("move the invoice service");
	expect(text).toContain("agent://Impl");
	// The ledger follows the focus, so the summarizer reads its instructions first.
	expect(text.indexOf("Storm 장부")).toBeGreaterThan(text.indexOf("다음 행동"));
});

test("the checkpoint instructions stay small: they ride on every mid-run compaction", () => {
	expect(CHECKPOINT_INSTRUCTIONS.length).toBeLessThan(400);
});

describe("workingState", () => {
	test("lists lanes, the run's agents with handles, reviews and blocked counts", () => {
		const lines = workingState(
			run({
				plan: {
					lanes: [
						{ name: "explore the payment API", kind: "explore", role: "explorer" },
						{ name: "fix the refund path", kind: "code", role: "implementer" },
					],
					workers: {},
					submittedAt: "2026-11-21T00:00:00.000Z",
				},
				blockedEdits: 2,
				blockedFollowUps: 1,
				reads: { director: 9, directorChars: 9000, duplicateChars: 3000, blocked: 4 },
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
		expect(text).toContain(TASK);
		// One line per lane, naming it.
		expect(lines.filter(l => l.includes("explore the payment API") || l.includes("fix the refund path"))).toHaveLength(2);
		// Only this run's agents, each with its handle; running agents come first.
		const handles = lines.flatMap(l => /agent:\/\/(\w+) /.exec(l)?.[1] ?? []);
		expect(handles).toEqual(["Rev", "Impl"]);
		expect(text).not.toContain("Elsewhere");
		expect(lines.find(l => l.includes("agent://Rev"))).toContain("12.3k");
		// The cleaned agent's line says more than a live one's: it cannot take follow-ups.
		const implLine = lines.find(l => l.includes("agent://Impl")) ?? "";
		expect(implLine.split(", ").length).toBeGreaterThan((lines.find(l => l.includes("agent://Rev")) ?? "").split(", ").length);
		// Review totals and block counts appear as numbers.
		expect(lines.some(l => /2.*1.*1.*P0 0 · P1 2 · P2 1 · P3 0.*1/.test(l))).toBe(true);
		expect(lines.at(-1)).toMatch(/2\D+1\D+4$/);
	});

	test("carries requirement ids, states and plan dependency edges after compaction", () => {
		const lines = workingState(
			run({
				plan: {
					lanes: [
						{
							name: "write",
							kind: "code",
							role: "implementer",
							results: [{ id: "a-change", kind: "change", criterion: "a is GOOD", path: "a.txt" }],
						},
						{
							name: "compare",
							kind: "code",
							role: "implementer",
							dependsOn: [{ lane: "write", need: "result" }],
						},
						{
							name: "build",
							kind: "code",
							role: "implementer",
							dependsOn: [{ lane: "compare", need: "integrated" }],
						},
					],
					workers: {},
					submittedAt: "x",
				},
				results: [
					{ id: "a-change", lane: "write", state: "accepted", attemptId: "job:1:Impl" },
					{ id: "b-change", lane: "compare", state: "unmet", reason: `${"x".repeat(180)}TAIL` },
					{ id: "c-answer", state: "pending" },
				],
			}),
			[],
		);
		const text = lines.join("\n");
		expect(text).toContain("필수 결과 3개");
		expect(text).toContain("a-change = 수용 · 레인 write · 시도 job:1:Impl");
		expect(text).toContain("b-change = 미충족 · 레인 compare");
		expect(text).toContain("c-answer = 대기 · 미배정");
		// The requirement-ledger line is bounded; the tail of a long reason is not replayed.
		expect(text).not.toContain("TAIL");
		expect(text).not.toContain("x".repeat(101));
		// Dependency edges stay plan facts with stable lane names, not a second copy of their goals.
		expect(text).toContain("계획 선행 의존 2개");
		expect(text).toContain("compare→write(결과)");
		expect(text).toContain("build→compare(통합)");
	});

	test("a long contract field is cut in the ledger; short ones and the other fields stay whole", () => {
		const long = "y".repeat(2_000);
		const results: RunResult[] = [
			{ id: "r-change", state: "pending", contract: { id: "r-change", kind: "change", criterion: long, path: "src/a.ts", contains: `${long}\nTAIL`, check: "unit" } },
		];
		const text = checkpointWorkState(run({ results })).join("\n");
		expect(text).toContain("계약: ");
		expect(text).toContain('"path":"src/a.ts"');
		expect(text).toContain('"check":"unit"');
		expect(text).not.toContain("y".repeat(200));
		expect(text).not.toContain("TAIL");
		expect(text.length).toBeLessThanOrEqual(6_000);
	});

	test("counts requirement rows and dependency edges past their ledger caps", () => {
		const results: RunResult[] = Array.from({ length: 30 }, (_, i) => ({
			id: `r${i}-change`,
			lane: `lane-${i}`,
			state: "unmet",
			reason: "s".repeat(150),
		}));
		const lanes = Array.from({ length: 20 }, (_, i) => ({
			name: `lane-${i}`,
			kind: "code" as const,
			role: "implementer",
			...(i === 0 ? {} : { dependsOn: [{ lane: `lane-${i - 1}`, need: "result" as const }] }),
		}));
		const lines = workingState(run({ results, plan: { lanes, workers: {}, submittedAt: "x" } }), []);
		const text = lines.join("\n");
		expect(text).toContain("필수 결과 30개");
		expect(text).toContain("외 18개 (실행 기록 참조)");
		expect(text).toContain("계획 선행 의존 19개");
		expect(text).toContain("외 11개");
		expect(text).not.toContain("r29-change");
		expect(text.length).toBeLessThanOrEqual(6_000);
	});

	test("without a plan, agents or reviews it still reports the blocks, as zeros", () => {
		const lines = workingState(run(), []);
		expect(lines).toHaveLength(4);
		expect(lines.join("\n")).not.toContain("agent://");
		expect(lines.at(-1)).toMatch(/0\D+0\D+0$/);
	});

	test("stays bounded for many lanes and agents", () => {
		const lanes = Array.from({ length: 50 }, (_, i) => ({ name: `lane ${i} ${"x".repeat(200)}`, kind: "code" as const, role: "implementer" }));
		const agents = Array.from({ length: 200 }, (_, i) => agent({ id: `A${i}`, lastActivityAt: i, state: i % 2 ? "parked" : "idle" }));
		const lines = workingState(run({ plan: { lanes, workers: {}, submittedAt: "x" } }), agents);
		expect(lines.length).toBeLessThan(60);
		expect(lines.every(l => l.length < 300)).toBe(true);
		const text = lines.join("\n");
		expect(text).toContain("agent://A199"); // most recent first
		expect(text).not.toContain("agent://A0 ");
		// The cut lanes and agents are counted: 50 − 20 lanes, 200 − 24 agents.
		expect(lines.some(l => /\b30\D/.test(l) && !l.includes("agent://"))).toBe(true);
		expect(lines.some(l => /\b176\D/.test(l) && !l.includes("agent://"))).toBe(true);
	});

	test("keeps constraints past the 200-character banner, lane goals and remaining decisions", () => {
		const banner = "b".repeat(200);
		const request = `${banner}\nCONSTRAINT: do not touch billing\n${"x".repeat(3_000)}\nFINAL: keep the public API stable`;
		const id = "run-20261120-100000-abcd";
		const lines = workingState(
			run({
				runId: id,
				task: banner,
				request,
				plan: {
					lanes: [{ name: "login", kind: "code", role: "implementer", goal: "only the login form" }],
					workers: { implementer: 1 },
					submittedAt: "x",
					note: "남은 결정: 세션 저장소를 유지한다",
				},
			}),
			[],
		);
		const text = lines.join("\n");
		expect(text).toContain("CONSTRAINT: do not touch billing");
		expect(text).toContain("FINAL: keep the public API stable");
		expect(text).toContain("only the login form");
		expect(text).toContain("남은 결정: 세션 저장소를 유지한다");
		// A cut request points at the stable run record instead of replaying the whole request.
		expect(text).toContain("state/runs/run-20261120-100000-abcd.json");
		expect(text.length).toBeLessThanOrEqual(6_000);
	});

	test("hard-caps a pathological request and plan instead of replaying context", () => {
		const request = `START ${"Z".repeat(19_000)}`;
		const lanes = Array.from({ length: 50 }, (_, i) => ({
			name: `lane ${i}`,
			kind: "code" as const,
			role: "implementer",
			goal: "g".repeat(500),
		}));
		const agents = Array.from({ length: 200 }, (_, i) => agent({ id: `A${i}`, lastActivityAt: i, cleanedAt: 1 }));
		const lines = workingState(
			run({
				runId: "run-20261120-120000-abcd",
				task: request.slice(0, 200),
				request,
				plan: { lanes, workers: {}, submittedAt: "x" },
			}),
			agents,
		);
		const text = lines.join("\n");
		expect(text.length).toBeLessThan(6_500);
		expect(text).toContain("START");
		expect(text).toContain("압축 한도");
		expect(text).not.toContain("Z".repeat(3_000));
		expect(text).not.toContain("g".repeat(500));
	});
});
