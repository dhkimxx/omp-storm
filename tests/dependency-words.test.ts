/**
 * The words of a refused start for a prerequisite (the run of 2026-11-26 14:30-14:53): the state of each missing
 * result with the ledger's reason, and advice that fits the state. A finished prerequisite is never told to run again.
 */
import { describe, expect, test } from "bun:test";
import { dependencyBlock, type LaneReadiness, type LaneReadinessView, type LaneResultReadiness } from "../src/runtime/lanes.ts";
import type { LaneNeed, PlanLane } from "../src/types.ts";

const PRODUCER = "PinGemmaHeadControl";
const CONSUMER = "BuildGemmaQatHeadShared";
const HANDLE = "run-20261126-051651-7850-lane-3";

const consumer = (need: LaneNeed = "result", lane = PRODUCER): PlanLane => ({
	name: CONSUMER,
	kind: "code",
	role: "implementer",
	dependsOn: [{ lane, need }],
});
const answer = (over: Partial<LaneResultReadiness> = {}): LaneResultReadiness => ({
	id: "head-control-source",
	kind: "answer",
	state: "unmet",
	integrated: false,
	...over,
});
const view = (over: Partial<LaneReadiness> & { results: readonly LaneResultReadiness[] }, lane = PRODUCER): LaneReadinessView =>
	new Map([[lane, { settled: true, integrated: false, running: false, handle: HANDLE, ...over }]]);

function block(need: LaneNeed, readiness: LaneReadinessView, lane = PRODUCER): string {
	const text = dependencyBlock(consumer(need, lane), readiness);
	if (text === undefined) throw new Error("expected a refusal");
	return text;
}

/** The sentence that forbids running the prerequisite in its place or claiming its result. */
const FORBID = "선행을 대신 실행하거나 같은 이름으로 결과를 주장하지 마세요";

describe("a prerequisite that finished but is not met", () => {
	test("14:30:32 judged unmet: the reason is shown and the advice is about citations, not respawning", () => {
		const text = block("result", view({ results: [answer({ reason: "검증 가능한 출처를 인용하지 않았습니다." })] }));
		expect(text).toContain("head-control-source");
		expect(text).toContain("미충족");
		expect(text).toContain("검증 가능한 출처를 인용하지 않았습니다");
		// Which citation forms count, and which do not.
		expect(text).toContain("path:line");
		expect(text).toContain("local://");
		expect(text).toContain("#L");
		// The follow-up goes to the lane's own worker.
		expect(text).toContain(`agent://${HANDLE}`);
		expect(text).not.toContain("다시 스폰");
		expect(text).not.toContain("끝난 뒤 다시");
		expect(text).toContain(FORBID);
	});

	test("an unmet change or artifact is not told to cite", () => {
		const text = block("result", view({ results: [answer({ kind: "change", reason: "파일이 비어 있습니다." })] }));
		expect(text).toContain("파일이 비어 있습니다");
		expect(text).not.toContain("path:line");
		expect(text).not.toContain("다시 스폰");
	});

	test("14:52:53 reviewable on a result edge: a reviewer's verdict, or the edge can ask for reviewable", () => {
		const text = block("result", view({ results: [answer({ state: "reviewable" })] }));
		expect(text).toContain("검토 가능");
		expect(text).toContain("리뷰어");
		expect(text).toContain("reviewable");
		expect(text).not.toContain("다시 스폰");
		expect(text).toContain(FORBID);
	});

	test("a reviewable row on an integrated edge needs the reviewer, and the edge change is not offered", () => {
		const text = block("integrated", view({ results: [answer({ state: "reviewable" })] }));
		expect(text).toContain("리뷰어");
		expect(text).not.toContain("need를 reviewable");
	});

	test("a pending row is a wait for the verdict, not a respawn", () => {
		const text = block("result", view({ results: [answer({ state: "pending" })] }));
		expect(text).toContain("대기");
		expect(text).not.toContain("다시 스폰");
	});
});

describe("a prerequisite still running", () => {
	test("14:31:40: wait for it, then send the same call again", () => {
		const text = block("result", view({ running: true, results: [answer({ state: "pending" })] }));
		expect(text).toContain("실행 중");
		expect(text).toContain("끝난 뒤 같은 호출을 다시 보내세요");
		expect(text).not.toContain("path:line");
		expect(text).toContain(FORBID);
	});
});

describe("what is not said", () => {
	test("a met prerequisite does not block", () => {
		expect(dependencyBlock(consumer(), view({ results: [answer({ state: "accepted", integrated: true })] }))).toBeUndefined();
	});

	test("a missing readiness row keeps its own refusal", () => {
		const text = dependencyBlock(consumer(), new Map());
		expect(text).toBeDefined();
		expect(text).not.toContain("path:line");
	});

	test("the reason is shown at most once and without a double full stop", () => {
		const text = block("result", view({ results: [answer({ reason: "검증 가능한 출처를 인용하지 않았습니다." })] }));
		expect(text).not.toContain(".).");
		expect(text.match(/검증 가능한 출처를 인용하지 않았습니다/gu)).toHaveLength(1);
	});

	test("each refusal stays short enough to read on every refusal", () => {
		const unmet = block("result", view({ results: [answer({ reason: "검증 가능한 출처를 인용하지 않았습니다." })] }));
		const reviewable = block("result", view({ results: [answer({ state: "reviewable" })] }));
		expect(unmet.length).toBeLessThan(300);
		expect(reviewable.length).toBeLessThan(260);
	});
});

describe("grammar around inserted names", () => {
	// The particle after each inserted name follows a fixed noun (레인, 조건), whatever the name ends in.
	for (const name of ["Alpha", "Beta", "작업1", "구현", "lane7"]) {
		for (const need of ["result", "integrated", "reviewable"] as const) {
			test(`'${name}' on a ${need} edge`, () => {
				const text = block(need, view({ results: [answer({ state: need === "reviewable" ? "unmet" : "reviewable" })] }, name), name);
				expect(text).toContain(`'${CONSUMER}' 레인은`);
				expect(text).toContain(`선행 '${name}' 레인의`);
				expect(text).toMatch(/ 조건이 충족되지 않았습니다/u);
				expect(text).not.toMatch(/이\(가\)|은\(는\)|을\(를\)|과\(와\)/u);
			});
		}
	}
});
