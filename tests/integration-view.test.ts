/**
 * D: one set of facts on every surface for isolated integration.
 *
 * The projection is C's typed read of the durable journal. These tests use injected projections only: no journal, no
 * filesystem, no writer. They pin the distinctions a user must be able to make — captured versus not, Storm-written
 * versus bytes that merely match, once-written versus still current, late recovery versus a successful outcome — and
 * the bounds of the queue reply at one hundred candidates.
 */
import { describe, expect, test } from "bun:test";
import { configHash } from "../src/config/canonical.ts";
import { renderPlanView } from "../src/tool/plan-view.ts";
import { closeoutBrief, closeoutHandoff } from "../src/runtime/closeout.ts";
import {
	INTEGRATION_AWAITING_NATIVE,
	INTEGRATION_CANDIDATES,
	INTEGRATION_CAPTURE_UNKNOWN,
	INTEGRATION_CHANGED,
	INTEGRATION_CONFIRMED_EMPTY,
	INTEGRATION_CONFLICT,
	INTEGRATION_KEPT_ONLY,
	INTEGRATION_LAST_SEEN,
	INTEGRATION_NOT_RECORDED,
	INTEGRATION_NOT_RECORDED_NOTE,
	INTEGRATION_NOT_WRITTEN,
	INTEGRATION_ORIGIN_UNPROVED,
	INTEGRATION_PRESENCE_UNKNOWN,
	INTEGRATION_PRESENT,
	INTEGRATION_READINESS_UNKNOWN,
	INTEGRATION_READY,
	INTEGRATION_RECOVERY_REQUIRED,
	INTEGRATION_STALE,
	INTEGRATION_UNKNOWN,
	INTEGRATION_WRITE_NOT_RECORDED,
	INTEGRATION_WRITTEN,
	INTEGRATION_WRITTEN_COUNT,
	integrationFacts,
	integrationLine,
	resultFacts,
} from "../src/runtime/result-facts.ts";
import { ISOLATED_CHANGE_RULE } from "../src/runtime/contract-text.ts";
import type { IntegrationCandidateId, IntegrationProblem, IntegrationRead } from "../src/runtime/integration-admission.ts";
import type {
	CandidateDetail,
	CandidateLine,
	CandidateProjection,
	IntegrationSelectionReply,
	QueueOverview,
	QueueReadiness,
	QueueWrite,
} from "../src/runtime/integration-controller-port.ts";
import type { WriteStepRecord } from "../src/runtime/integration-record.ts";
import { formatIntegrationCandidates, formatIntegrationSelection } from "../src/runtime/views.ts";
import { renderCloseout } from "../src/view/closeout.ts";
import { LaneTimeline } from "../src/view/lane/timeline.ts";
import { liveMetricFacts } from "../src/view/live-metrics.ts";
import { renderStatus } from "../src/view/render.ts";
import { approvalRecord, runRecord } from "./fixtures.ts";
import { TEAM } from "./support.ts";
import type { StatusView } from "../src/types.ts";

const NOW = Date.parse("2026-11-28T09:00:00.000Z");
const RUN = "run-1";
const DISPATCH = "dispatch-1";

const cid = (n: number): IntegrationCandidateId => `c1_${n.toString(16).padStart(64, "0")}` as IntegrationCandidateId;
const problem = (code: string, reason: string): IntegrationProblem => ({ code, reason });
const known = <T>(value: T): IntegrationRead<T> => ({ kind: "known", value });
const unknown = (code: string, reason: string): IntegrationRead<never> => ({ kind: "unknown", problem: problem(code, reason) });

const readiness = (over: Partial<Record<QueueReadiness["kind"], number>> = {}): Readonly<Record<QueueReadiness["kind"], number>> => ({
	"awaiting-native": 0,
	ready: 0,
	"confirmed-empty": 0,
	"kept-only": 0,
	unknown: 0,
	conflict: 0,
	stale: 0,
	...over,
});
const writes = (over: Partial<Record<QueueWrite["kind"], number>> = {}): Readonly<Record<QueueWrite["kind"], number>> => ({
	"not-written": 0,
	"not-recorded": 0,
	"present-unattributed": 0,
	"no-effect": 0,
	"recovery-required": 0,
	written: 0,
	...over,
});

function line(over: Partial<CandidateLine> = {}): CandidateLine {
	return {
		candidateId: cid(1),
		childHandle: "Impl-1",
		subject: { kind: "planned", lane: "api" },
		readiness: { kind: "ready" },
		write: { kind: "not-written" },
		presence: { kind: "unknown", problem: problem("not-read", "아직 읽지 않음") },
		...over,
	};
}

function overview(over: Partial<QueueOverview> = {}): QueueOverview {
	return {
		runId: RUN,
		observedAt: NOW,
		readiness: readiness({ ready: 2 }),
		writes: writes({ "not-written": 2 }),
		present: 0,
		changed: 0,
		unknownPresence: 2,
		examples: [line(), line({ candidateId: cid(2), childHandle: "Impl-2", subject: { kind: "unplanned" } })],
		page: [cid(1), cid(2)],
		nextAfter: null,
		...over,
	};
}

function detail(over: Partial<CandidateDetail> = {}): CandidateDetail {
	return {
		line: line(),
		revision: null,
		provenance: {
			key: { schema: "storm.integration-admission/v1", runId: RUN, dispatch: DISPATCH },
			placementOrdinal: 1,
			carrier: known("sync"),
			checkoutClaim: known({ reference: "slot/1", checkedAt: NOW }),
		},
		outcome: known("success"),
		stopCause: unknown("not-stopped", "정지 기록 없음"),
		cancelRequested: false,
		bundle: "root-only",
		recovery: {
			stormCopy: known({ reference: "object/c1", bytes: 42, sha256: "a".repeat(64) }),
			nativePatch: unknown("not-captured", "네이티브 패치 기록 없음"),
			nativeBranch: unknown("not-captured", "네이티브 브랜치 기록 없음"),
			nestedCount: known(0),
			nestedExamples: [],
			checkout: { kind: "unknown", problem: problem("not-checked", "체크아웃을 확인하지 않음") },
			nativeLink: known("agent://Impl-1"),
		},
		dirtyPaths: known({ total: 0, examples: [], dirtyDeletes: [] }),
		resultStates: [{ id: "r1", state: "unmet" }],
		...over,
	};
}

describe("candidate projection: older record, unknown and a recorded queue are different facts", () => {
	test("a record without integration says so and never reads as zero captured work", () => {
		const text = formatIntegrationCandidates({ kind: "not-recorded" });
		expect(text).toContain(INTEGRATION_NOT_RECORDED);
		expect(text).toContain(INTEGRATION_NOT_RECORDED_NOTE);
		expect(text).not.toContain(`${INTEGRATION_CANDIDATES} 0`);
		expect(integrationFacts({ kind: "not-recorded" })).toEqual({ kind: "not-recorded" });
	});

	test("an unreadable record is a positive unknown with a safe next action, not an empty queue", () => {
		const text = formatIntegrationCandidates({ kind: "unknown", problem: problem("journal-unreadable", "저널을 읽지 못했습니다") });
		expect(text).toContain(INTEGRATION_UNKNOWN);
		expect(text).toContain("journal-unreadable");
		expect(text).toContain("저널을 읽지 못했습니다");
		expect(text).toContain("다시 조회");
		expect(text).not.toContain(`${INTEGRATION_CANDIDATES} 0`);
		expect(text).not.toMatch(/지우|삭제|정리/u);
	});
});

describe("overview stays usable and bounded", () => {
	test("counts, at most three examples and twenty exact IDs are all present", () => {
		const page = Array.from({ length: 20 }, (_, index) => cid(index + 1));
		const examples = [line({ candidateId: cid(1) }), line({ candidateId: cid(2) }), line({ candidateId: cid(3) }), line({ candidateId: cid(4) })];
		const text = formatIntegrationCandidates({
			kind: "overview",
			value: overview({
				readiness: readiness({ ready: 18, "awaiting-native": 2 }),
				writes: writes({ "not-written": 18, written: 2 }),
				present: 1,
				changed: 1,
				unknownPresence: 2,
				examples,
				page,
				nextAfter: cid(20),
			}),
		});
		for (const part of [INTEGRATION_CANDIDATES, "18", INTEGRATION_READY, INTEGRATION_AWAITING_NATIVE, INTEGRATION_WRITTEN_COUNT, INTEGRATION_PRESENT, INTEGRATION_CHANGED, INTEGRATION_PRESENCE_UNKNOWN]) {
			expect(text).toContain(part);
		}
		// Every exact ID in the page is reachable; the example list is capped at three even if the producer supplied more.
		for (const id of page) expect(text).toContain(id);
		expect(text).toContain(cid(1));
		expect(text).toContain(cid(2));
		expect(text).toContain(cid(3));
		expect(text).toContain(cid(4)); // only in the page, not a fourth example
		expect(text.split(cid(1)).length - 1).toBeGreaterThanOrEqual(1);
		expect(text.split(cid(4)).length - 1).toBe(1);
		expect(text).toContain(`candidateAfter=${cid(20)}`);
		// A page of twenty, three examples and fixed counts stays far below the tool reply bound.
		expect(text.length).toBeLessThan(4_096);
	});

	test("a hundred candidates are reachable by cursor and the hundredth has an exact detail", () => {
		const page = Array.from({ length: 20 }, (_, index) => cid(97 + index));
		const text = formatIntegrationCandidates({
			kind: "overview",
			value: overview({ page, nextAfter: null, examples: [line({ candidateId: cid(100) })] }),
		});
		expect(text).toContain(cid(100));
		expect(text.length).toBeLessThan(4_096);
		const hundredth = formatIntegrationCandidates({ kind: "detail", value: detail({ line: line({ candidateId: cid(100), childHandle: "Impl-100" }) }) });
		expect(hundredth).toContain(cid(100));
		expect(hundredth).toContain("Impl-100");
	});

	test("an empty recorded queue is a real zero, unlike an older record", () => {
		const text = formatIntegrationCandidates({ kind: "overview", value: overview({ readiness: readiness(), writes: writes(), examples: [], page: [], nextAfter: null }) });
		expect(text).toContain(`${INTEGRATION_CANDIDATES} 0`);
		expect(text).toContain("후보 없음");
		expect(text).not.toContain(INTEGRATION_NOT_RECORDED);
	});
});

describe("detail separates capture, bundles, checkout and recovery", () => {
	const texts = (over: Partial<CandidateDetail>) => formatIntegrationCandidates({ kind: "detail", value: detail(over) });

	test("a root-only candidate with a branch and nested parts is distinguishable from confirmed empty and kept-only", () => {
		const root = texts({});
		expect(root).toContain("루트 전용");
		expect(root).toContain("object/c1");
		const branch = texts({
			bundle: "confirmed-empty",
			recovery: {
				...detail().recovery,
				nativeBranch: known({ ref: "refs/heads/storm/w1", base: known("b".repeat(40)), tip: known("c".repeat(40)) }),
				nestedCount: known(2),
				nestedExamples: [{ reference: "nested/1", relativeRepo: known("packages/a") }],
			},
		});
		expect(branch).toContain(INTEGRATION_CONFIRMED_EMPTY);
		expect(branch).toContain("refs/heads/storm/w1");
		expect(branch).toContain("packages/a");
		expect(branch).not.toBe(root);
		const kept = texts({ bundle: "kept-only" });
		expect(kept).toContain(INTEGRATION_KEPT_ONLY);
		expect(kept).not.toContain(INTEGRATION_CONFIRMED_EMPTY);
		const unknownBundle = texts({ bundle: "unknown" });
		expect(unknownBundle).toContain(INTEGRATION_CAPTURE_UNKNOWN);
	});

	test("checkout present, not found and unknown are last observations, never cleanup receipts", () => {
		const present = texts({ recovery: { ...detail().recovery, checkout: { kind: "present", checkedAt: NOW } } });
		expect(present).toContain("체크아웃 확인됨");
		expect(present).not.toMatch(/정리됨|재사용|삭제됨/u);
		const missing = texts({ recovery: { ...detail().recovery, checkout: { kind: "not-found", checkedAt: NOW } } });
		expect(missing).toContain("체크아웃 마지막 확인에서 없음");
		expect(missing).not.toMatch(/정리됨|재사용|삭제됨|Storm이 지움/u);
		const unknownCheckout = texts({ recovery: { ...detail().recovery, checkout: { kind: "unknown", problem: problem("no-check", "확인 기록 없음") } } });
		expect(unknownCheckout).toContain("체크아웃 미상");
		expect(unknownCheckout).toContain("확인 기록 없음");
	});

	test("an unreadable readiness is a positive unknown with the native history link", () => {
		const text = texts({
			line: line({ readiness: { kind: "unknown", problem: problem("readiness-unread", "준비 상태를 읽지 못했습니다") }, write: { kind: "not-recorded", problem: problem("write-unread", "쓰기 기록 없음") } }),
			recovery: { ...detail().recovery, nativeLink: known("agent://Impl-9") },
		});
		expect(text).toContain(INTEGRATION_READINESS_UNKNOWN);
		expect(text).toContain("readiness-unread");
		expect(text).toContain("agent://Impl-9");
		expect(text).toContain("이 상태에서는 선택할 수 없습니다");
		expect(text).not.toContain(INTEGRATION_WRITTEN);
	});

	test("a cancelled attempt with a real patch keeps it as recovery; a history-only capture says unknown", () => {
		const nativePatch = `/tmp/${"session-segment/".repeat(12)}w1.patch`;
		const cancelled = texts({
			outcome: known("cancel"),
			cancelRequested: true,
			recovery: { ...detail().recovery, nativePatch: known(nativePatch), nativeBranch: known({ ref: "refs/heads/storm/w1", base: known("b".repeat(40)), tip: known("c".repeat(40)) }) },
		});
		expect(cancelled).toContain("취소");
		expect(cancelled).toContain(nativePatch);
		expect(cancelled).toContain("refs/heads/storm/w1");
		expect(cancelled).not.toContain("결과: 성공");
		const historyOnly = texts({ outcome: known("failure"), recovery: { ...detail().recovery, stormCopy: unknown("no-copy", "사본 없음"), nativePatch: unknown("no-patch", "패치 없음") } });
		expect(historyOnly).toContain("실패");
		expect(historyOnly).toContain("no-copy");
		expect(historyOnly).not.toContain("object/c1");
	});

	test("a ready candidate names the exact live selection action", () => {
		const ready = texts({});
		expect(ready).toContain(`integrate { candidateIds: ["${cid(1)}"] }`);
		expect(ready).toContain("자동 적용은 없습니다");
	});

	test("a dirty path and a refusal are shown from typed fields, without inventing a location", () => {
		const dirty = texts({ dirtyPaths: known({ total: 2, examples: ["src/a.ts", "src/b.ts"], dirtyDeletes: ["src/c.ts"] }) });
		expect(dirty).toContain("src/a.ts");
		expect(dirty).toContain("src/c.ts");
		expect(dirty).toContain("2");
		const refused = texts({ line: line({ readiness: { kind: "conflict", problem: problem("path-drift", "대상 경로가 바뀌었습니다") } }) });
		expect(refused).toContain(INTEGRATION_CONFLICT);
		expect(refused).toContain("path-drift");
		expect(refused).toContain("대상 경로가 바뀌었습니다");
		const unknownDirty = texts({ dirtyPaths: unknown("dirty-unread", "읽지 못함") });
		expect(unknownDirty).toContain("충돌 경로");
		expect(unknownDirty).toContain("dirty-unread");
		const stale = texts({ line: line({ readiness: { kind: "stale", problem: problem("old-run", "이전 실행의 후보") } }) });
		expect(stale).toContain(INTEGRATION_STALE);
		expect(stale).toContain("old-run");
	});
});

describe("write state is never inferred from matching bytes", () => {
	const textOf = (write: QueueWrite, presence: CandidateLine["presence"]) =>
		formatIntegrationCandidates({ kind: "detail", value: detail({ line: line({ write, presence }) }) });
	const written = (at: number): QueueWrite => ({
		kind: "written",
		receipt: { key: { schema: "storm.integration-admission/v1", runId: RUN, dispatch: DISPATCH }, candidateId: cid(1), manifestDigest: "d".repeat(64), intentSequence: 1, receiptSequence: 2 },
		at,
	});

	test("once-written with current bytes, changed since, and unknown presence read differently", () => {
		const current = textOf(written(NOW - 60_000), { kind: "present", observedAt: NOW });
		expect(current).toContain(INTEGRATION_WRITTEN);
		expect(current).toContain(INTEGRATION_PRESENT);
		expect(current).not.toContain(INTEGRATION_CHANGED);
		const changed = textOf(written(NOW - 60_000), { kind: "changed", observedAt: NOW, firstPath: "src/a.ts" });
		expect(changed).toContain(INTEGRATION_CHANGED);
		expect(changed).toContain("src/a.ts");
		expect(changed).not.toContain(INTEGRATION_PRESENT);
		const unread = textOf(written(NOW - 60_000), { kind: "unknown", problem: problem("presence-unread", "현재 바이트를 읽지 못했습니다") });
		expect(unread).toContain(INTEGRATION_PRESENCE_UNKNOWN);
		expect(unread).toContain("presence-unread");
	});

	test("a matching postimage without a Storm receipt is present with an unproved origin", () => {
		const manual = textOf({ kind: "not-written" }, { kind: "present", observedAt: NOW });
		expect(manual).toContain(INTEGRATION_NOT_WRITTEN);
		expect(manual).toContain(INTEGRATION_ORIGIN_UNPROVED);
		expect(manual).not.toContain(INTEGRATION_WRITTEN);
		const unattributed = textOf({ kind: "present-unattributed", problem: problem("origin-unproved", "수동 쓰기와 구분되지 않습니다") }, { kind: "present", observedAt: NOW });
		expect(unattributed).toContain(INTEGRATION_ORIGIN_UNPROVED);
		expect(unattributed).not.toContain(INTEGRATION_WRITTEN);
	});

	test("a record without a write fact says so; it is not a write and not a missing candidate", () => {
		const legacy = textOf({ kind: "not-recorded", problem: problem("pre-integration", "쓰기 기록 이전 형식") }, { kind: "unknown", problem: problem("no-read", "모름") });
		expect(legacy).toContain(INTEGRATION_WRITE_NOT_RECORDED);
		expect(legacy).not.toContain(INTEGRATION_WRITTEN);
	});

	test("recovery-required and no-effect are not a write", () => {
		const recovery = textOf({ kind: "recovery-required", problem: problem("fence", "미완료 효과를 확인해야 합니다") }, { kind: "unknown", problem: problem("no-read", "모름") });
		expect(recovery).toContain(INTEGRATION_RECOVERY_REQUIRED);
		expect(recovery).toContain("fence");
		expect(recovery).not.toContain(INTEGRATION_WRITTEN);
		const none = textOf({ kind: "no-effect", problem: problem("stopped", "디스패치 전에 중단") }, { kind: "unknown", problem: problem("no-read", "모름") });
		expect(none).toContain("효과 없음");
		expect(none).not.toContain(INTEGRATION_WRITTEN);
	});
});

describe("selection reply", () => {
	const step = (id: number, state: WriteStepRecord["state"], why?: IntegrationProblem): WriteStepRecord => ({
		candidateId: cid(id),
		state,
		...(why === undefined ? {} : { problem: why }),
	});

	test("counts, bounded examples and the first unstarted ID; not the controller's backing arrays", () => {
		const reply: IntegrationSelectionReply = {
			kind: "selection",
			selection: { key: { runId: RUN, callId: "call-1" }, chosen: Array.from({ length: 100 }, (_, index) => cid(index + 1)), ordered: Array.from({ length: 100 }, (_, index) => cid(100 - index)) },
			started: 3,
			written: 2,
			skipped: 1,
			notStarted: 97,
			examples: [step(1, "written"), step(2, "conflict", problem("same-file", "같은 파일의 다른 변경")), step(3, "refused", problem("stale", "현재 준비 아님"))],
			firstNotStarted: cid(4),
			stop: problem("authority", "live 요청이 끝났습니다"),
		};
		const text = formatIntegrationSelection(reply);
		expect(text).toContain("요청 100");
		expect(text).toContain("시작 3");
		expect(text).toContain("적용 기록 2");
		expect(text).toContain("건너뜀 1");
		expect(text).toContain("시작 안 함 97");
		for (const id of [cid(1), cid(2), cid(3)]) expect(text).toContain(id);
		expect(text).toContain(`첫 시작 안 함: ${cid(4)}`);
		expect(text).toContain("authority");
		// The backing order is not a reply: only the bounded examples and the first unstarted id are named.
		expect(text).not.toContain(cid(100));
		expect(text.length).toBeLessThan(2_048);
	});

	test("a refused request says nothing was written", () => {
		const text = formatIntegrationSelection({ kind: "refused", problem: problem("bad-id", "c1_ 형식이 아닙니다") });
		expect(text).toContain("거부");
		expect(text).toContain("bad-id");
		expect(text).toContain("하나도 쓰이지 않았습니다");
		expect(text).not.toContain(INTEGRATION_WRITTEN);
	});
});

describe("one projection reaches the surfaces", () => {
	const run = runRecord({
		status: "done",
		endReason: "verified",
		results: [{ id: "r1", lane: "api", state: "unmet", reason: "아직 미충족" }],
	});
	const projection: CandidateProjection = {
		kind: "overview",
		value: overview({
			readiness: readiness({ ready: 1 }),
			writes: writes({ written: 1 }),
			present: 1,
			unknownPresence: 0,
			examples: [line({ candidateId: cid(1), write: { kind: "written", receipt: { key: { schema: "storm.integration-admission/v1", runId: RUN, dispatch: DISPATCH }, candidateId: cid(1), manifestDigest: "d".repeat(64), intentSequence: 1, receiptSequence: 2 }, at: NOW - 60_000 }, presence: { kind: "present", observedAt: NOW } })],
			page: [cid(1)],
			nextAfter: null,
		}),
	};

	test("result facts carry the same counts and a stable key", () => {
		const facts = resultFacts(run, { integration: projection });
		expect(facts.integration?.kind).toBe("recorded");
		expect(facts.integration?.candidates).toBe(1);
		expect(facts.integration?.written).toBe(1);
		expect(facts.integration?.present).toBe(1);
		expect(integrationFacts(projection)).toEqual(facts.integration);
		expect(resultFacts(run).integration).toBeUndefined();
		expect(resultFacts(run, { integration: projection }).key).not.toBe(resultFacts(run).key);
	});

	test("status, card and handoff show the same integration fact without changing the result count", () => {
		const facts = resultFacts(run, { integration: projection });
		const line = integrationLine(facts.integration);
		expect(line).toContain(`${INTEGRATION_CANDIDATES} 1`);
		expect(line).toContain(INTEGRATION_WRITTEN_COUNT);
		expect(line).toContain(INTEGRATION_LAST_SEEN);
		expect(line).not.toMatch(/수용 \d+\/\d+/u);

		const hash = configHash(TEAM);
		const view: StatusView = {
			config: { status: "ok", path: "/repo/.omp/storm/config.json", config: TEAM, hash, warnings: [] },
			approval: approvalRecord(hash, { repoId: "r", approvedAt: "2026-11-20T05:12:44.512Z", approvalId: "apr_OLD" }),
			shadows: [],
			run,
		};
		const status = renderStatus(view, NOW, "user", undefined, projection);
		expect(status).toContain(line as string);

		const brief = closeoutBrief(run, { integration: projection });
		expect(brief.integration?.candidates).toBe(1);
		expect(brief.tier).toBe("card");
		const card = renderCloseout(brief, false).markdown;
		expect(card).toContain(INTEGRATION_CANDIDATES);
		expect(card).toContain(INTEGRATION_WRITTEN_COUNT);

		const handoff = closeoutHandoff(run, projection);
		expect(handoff).toContain("- Integration:");
		expect(handoff).toContain("1 candidate");
		expect(handoff).toContain(cid(1));
		expect(handoff.length).toBeLessThanOrEqual(1024);
	});

	test("an empty recorded queue does not turn a clean run into a card", () => {
		const empty: CandidateProjection = { kind: "overview", value: overview({ readiness: readiness(), writes: writes(), present: 0, changed: 0, unknownPresence: 0, examples: [], page: [], nextAfter: null }) };
		const clean = runRecord({ status: "done", endReason: "verified", results: [{ id: "r1", lane: "api", state: "accepted" }] });
		const brief = closeoutBrief(clean, { integration: empty });
		expect(brief.integration?.kind).toBe("recorded");
		expect(brief.tier).toBe("line");
		expect(closeoutHandoff(clean, empty)).toContain("- Integration: 0 candidates");
	});

	test("the live result chip adds the candidate count only when the projection exists", () => {
		const withProjection = liveMetricFacts(run, "working", NOW, { integration: projection }).chips.find(chip => chip.key === "results");
		const without = liveMetricFacts(run, "working", NOW).chips.find(chip => chip.key === "results");
		expect(withProjection?.forms[0]?.value ?? "").toBe(without?.forms[0]?.value ?? "");
		expect(withProjection?.forms[0]?.suffix ?? "").toContain(`${INTEGRATION_CANDIDATES} 1`);
		expect((without?.forms[0]?.suffix ?? "").includes(INTEGRATION_CANDIDATES)).toBe(false);
	});

	test("the lane timeline's snapshot carries the same fact and updates with a new read", () => {
		const timeline = new LaneTimeline();
		timeline.observe(run, "working", NOW, projection);
		const first = timeline.snapshot(NOW);
		expect(first.integration?.kind).toBe("recorded");
		expect(first.integration?.candidates).toBe(1);
		const next: CandidateProjection = {
			kind: "overview",
			value: overview({ readiness: readiness({ ready: 2 }), writes: writes(), examples: [], page: [cid(1), cid(2)], nextAfter: null }),
		};
		timeline.observe(run, "working", NOW + 1_000, next);
		const second = timeline.snapshot(NOW + 1_000);
		expect(second.integration?.candidates).toBe(2);
		expect(second.integration).not.toEqual(first.integration);
	});
});

describe("plan copy teaches the exact selection path", () => {
	test("an isolated change names explicit selection after integration, never an artifact workaround", () => {
		expect(ISOLATED_CHANGE_RULE).toContain("공유 레인");
		expect(ISOLATED_CHANGE_RULE).toContain("정확한");
		expect(ISOLATED_CHANGE_RULE).not.toContain("결과는 artifact로 선언하세요");
		const text = renderPlanView({
			runId: RUN,
			plan: {
				lanes: [
					{ name: "P", kind: "code", role: "implementer", isolationReason: "independent", results: [{ id: "p0", kind: "change", criterion: "p0", path: "a.ts" }] },
					{ name: "C", kind: "code", role: "implementer", dependsOn: [{ lane: "P", need: "integrated" }], results: [{ id: "c0", kind: "change", criterion: "c0", path: "b.ts" }] },
				],
				workers: { implementer: 2 },
				submittedAt: "2026-11-28T09:00:00.000Z",
			},
		}) as string;
		expect(text).toContain("명시 선택");
		expect(text).not.toContain("이 버전에서 충족 불가");
	});
});
