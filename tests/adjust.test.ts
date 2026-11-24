/**
 * Direct runtime steering: the bounded natural grammar, one native plan exclusion, one host-settled read-only retry,
 * and the admission/continuation edges that must not replay either action.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { parseAdjustment, retryProblem, type AdjustRequest } from "../src/runtime/adjust.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { noteResumePointer } from "../src/runtime/resume.ts";
import { resultContractIdentity } from "../src/runtime/result-evidence.ts";
import { readRun, writeRun } from "../src/runtime/run.ts";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import type { RunPlan, RunResult, StormConfig } from "../src/types.ts";
import { fakeSession, until, type FakeSession } from "./fake-session.ts";
import { runRecord, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", quick: "a/q", reviewer: "a/r" });

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-adjust-")));
});
afterEach(async () => {
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (): FakeSession => fakeSession({ root, agents: [], config: TEAM });

const planFor = (): RunPlan => ({
	lanes: [
		{
			name: "ui-preview", kind: "explore", role: "explorer", goal: "UI 미리보기 경로 확인",
			results: [{ id: "ui-preview", kind: "answer", criterion: "UI 미리보기 결과를 요약한다" }],
		},
		{
			name: "api-verify", kind: "explore", role: "explorer", goal: "API 검증 수행",
			results: [{ id: "api-verify", kind: "answer", criterion: "API 검증 결과를 보고한다" }],
		},
		{
			name: "api-docs", kind: "explore", role: "explorer", goal: "API 문서 정리",
			results: [{ id: "api-docs", kind: "answer", criterion: "API 문서를 정리한다" }],
		},
	],
	workers: { explorer: 3 },
	submittedAt: new Date(T0).toISOString(),
});

const singleLanePlan = (): RunPlan => ({
	lanes: [planFor().lanes[0]!],
	workers: { explorer: 1 },
	submittedAt: new Date(T0).toISOString(),
});

const report = (over: Partial<AttemptReport> & Pick<AttemptReport, "runId" | "spawnKey" | "attemptId">): AttemptReport => ({
	schema: "storm.attempt-report/v1",
	parentId: "main",
	outcome: "success",
	capture: "observed",
	observedAt: T0 + 1,
	version: "unknown",
	artifacts: [],
	observations: [],
	...over,
});

const prepare = (h: FakeSession, runId: string, lane: string, dispatch: string) =>
	h.controller.prepareAttempt({
		runId,
		lane,
		spawnKey: `${lane}-${dispatch}`,
		parentId: "main",
		dispatch,
		followUp: false,
		artifactMode: "shared",
		startedAt: T0,
	});

async function settleFailure(h: FakeSession, runId: string, lane: string, dispatch: string): Promise<void> {
	const spawnKey = `${lane}-${dispatch}`;
	const settlement: AttemptSettlement = {
		runId,
		lane,
		spawnKey,
		parentId: "main",
		dispatch,
		startedAt: T0,
		observedAt: T0 + 1,
		report: report({ runId, spawnKey, attemptId: `job:${dispatch}:${spawnKey}`, outcome: "failure" }),
		citations: [],
	};
	await h.controller.settleAttempt(settlement);
}

const result = (h: FakeSession, id: string): RunResult | undefined =>
	h.controller.active()?.results?.find(candidate => candidate.id === id);

describe("bounded direct-adjustment grammar", () => {
	test("the four ordinary forms parse to exactly one action and target", () => {
		expect(parseAdjustment("UI는 빼고 API만 계속해")).toEqual({ kind: "exclude", target: "UI" });
		expect(parseAdjustment("실패한 API 검증만 다시 해")).toEqual({ kind: "retry", target: "API 검증" });
		expect(parseAdjustment("Drop UI and continue with API")).toEqual({ kind: "exclude", target: "UI" });
		expect(parseAdjustment("retry API check only")).toEqual({ kind: "retry", target: "API check" });
	});

	test("quotes, code, questions, negations, conditionals and two actions stay ordinary input", () => {
		for (const text of [
			"\"UI는 빼고 API만 계속해\"",
			"`UI는 빼고 API만 계속해`",
			"UI는 빼지 말고 API만 계속해",
			"UI를 빼면 API만 계속해",
			"UI는 빼고 API만 계속할까?",
			"두고 보자: UI는 빼고 API만 계속해",
			"if you drop UI, retry API check",
			"UI는 빼고 API만 다시 해",
			"drop UI and retry API check",
			"drop UI and deploy production",
			"UI는 빼고 프로덕션에 배포해",
			"UI는 빼고 문서도 빼줘",
			"실패한 API 검증만 다시 해 그리고 배포해",
			"const x = 1; drop UI",
			"UI를 두고 API만 빼",
		]) {
			expect(parseAdjustment(text)).toBeUndefined();
		}
	});
});

describe("native exclusion and retry", () => {
	test("an exclusion wins a stale baseline admission and no later plan recreates it", async () => {
		const h = session();
		const runId = await h.start();
		const plan = planFor();
		expect(await h.controller.setPlan(h.ctx, plan)).toEqual({ ok: true });

		// The dispatch passed the old plan and is inside its baseline read when the user excludes the lane.
		const pending = prepare(h, runId, "ui-preview", "stale-ui");
		const outcome = await h.controller.adjust(h.ctx, { kind: "exclude", target: "UI", source: "interactive" });
		expect(outcome.ok).toBe(true);
		expect(await pending).toMatchObject({ ok: false });
		expect(h.controller.active()?.plan?.lanes.map(lane => lane.name)).toEqual(["api-verify", "api-docs"]);
		expect(result(h, "ui-preview")).toMatchObject({
			scope: "excluded-by-user",
			state: "pending",
			lane: "ui-preview",
		});
		expect(h.controller.active()?.adjustments?.at(-1)).toMatchObject({ kind: "exclude", id: "ui-preview", lane: "ui-preview" });

		// Reintroducing the same result id or reusing the excluded lane name is refused before the plan changes.
		expect(await h.controller.setPlan(h.ctx, plan)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("제외"),
		});
		await h.controller.finish("interrupted");
	});

	test("one retry grant is consumed once, and a repeated delivery cannot start a second attempt", async () => {
		const h = session();
		const runId = await h.start();
		expect(await h.controller.setPlan(h.ctx, planFor())).toEqual({ ok: true });
		expect(await prepare(h, runId, "api-verify", "api-1")).toEqual({ ok: true });
		await settleFailure(h, runId, "api-verify", "api-1");
		expect(result(h, "api-verify")).toMatchObject({ state: "unmet", attemptId: "job:api-1:api-verify-api-1" });

		const request: AdjustRequest = { kind: "retry", target: "API 검증", source: "interactive" };
		expect(await h.controller.adjust(h.ctx, request)).toMatchObject({ ok: true });
		expect(h.controller.active()?.adjustments?.at(-1)).toMatchObject({ kind: "retry", id: "api-verify", lane: "api-verify" });
		expect(h.controller.active()?.adjustments?.at(-1)?.takenAt).toBeUndefined();
		// The initial handoff has not started in this fake, so the hint is deferred, not injected ahead of the round.
		expect(h.sent.some(message => message.includes('<storm-adjust'))).toBe(false);
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.some(message => message.includes('<storm-adjust')));
		expect(h.sent.some(message => message.includes('<storm-adjust') && message.includes('action="retry"'))).toBe(true);

		// The same ordinary text is a duplicate delivery, not a second user action.
		expect(await h.controller.adjust(h.ctx, request)).toMatchObject({ ok: true, already: true });

		// The next matching admission consumes the grant; the row stays unmet until the host settles this attempt.
		expect(await prepare(h, runId, "api-verify", "api-2")).toEqual({ ok: true });
		expect(typeof h.controller.active()?.adjustments?.at(-1)?.takenAt).toBe("string");
		expect(result(h, "api-verify")).toMatchObject({ state: "unmet", reason: expect.stringContaining("사용자 요청") });
		const whileRunning = await h.controller.adjust(h.ctx, { kind: "retry", target: "api-verify", exact: true, source: "command" });
		expect(whileRunning).toMatchObject({ ok: false, reason: expect.stringContaining("진행 중") });

		await settleFailure(h, runId, "api-verify", "api-2");
		await h.controller.finish("no-progress");
	});

	test("the only lane and a write lane are refused with explicit reasons", async () => {
		const only = session();
		await only.start();
		expect(await only.controller.setPlan(only.ctx, singleLanePlan())).toEqual({ ok: true });
		expect(await only.controller.adjust(only.ctx, { kind: "exclude", target: "UI", source: "interactive" })).toMatchObject({
			ok: false,
			reason: expect.stringContaining("유일한 레인"),
		});
		await only.controller.finish("interrupted");

		const writer = retryProblem({
			plan: planFor(),
			rows: [{ id: "api-verify", state: "unmet", attemptId: "a" }],
			lane: {
				name: "api-verify", kind: "review", role: "reviewer", files: ["out.txt"],
				results: [{ id: "api-verify", kind: "answer", criterion: "API 검증" }],
			},
			resultId: "api-verify",
			laneBusy: false,
			inputsMatch: true,
			inputsAvailable: true,
		});
		expect(writer).toContain("쓰기 레인");
	});
});

describe("checkpoint continuation", () => {
	test("an excluded row and its lane stay out of the resumed plan and cannot be recreated", async () => {
		const excludedContract = { id: "ui-preview", kind: "answer" as const, criterion: "UI 미리보기 결과를 요약한다" };
		const apiContract = { id: "api-verify", kind: "answer" as const, criterion: "API 검증 결과를 보고한다" };
		const old = runRecord({
			runId: "run-20261119-090000-ad00",
			status: "stopped",
			endReason: "interrupted",
			startedAt: "2026-11-19T09:00:00.000Z",
			request: "continue the API verification",
			task: "continue the API verification",
			plan: {
				lanes: [{ name: "api-verify", kind: "explore", role: "explorer", goal: "API 검증 수행", results: [apiContract] }],
				workers: { explorer: 1 },
				submittedAt: "2026-11-19T09:00:00.000Z",
			},
			results: [
				{
					id: "ui-preview", lane: "ui-preview", state: "pending", scope: "excluded-by-user",
					identity: resultContractIdentity(excludedContract), contract: excludedContract,
					reason: "사용자가 이 결과를 실행 범위에서 제외했습니다.",
				},
				{
					id: "api-verify", lane: "api-verify", state: "pending",
					identity: resultContractIdentity(apiContract), contract: apiContract,
				},
			],
		});
		const h = session();
		await writeRun(h.sessionDir, old);
		await noteResumePointer(h.sessionDir, { repoId: h.repo.repoId, root: h.repo.root }, old);
		const runId = await h.start({ task: "continue", resumeOf: old.runId });
		const stored = await readRun(h.sessionDir, runId);
		expect(stored?.plan?.lanes.map(lane => lane.name)).toEqual(["api-verify"]);
		expect(stored?.results?.map(row => [row.id, row.scope ?? "", row.lane ?? ""])).toEqual([
			["api-verify", "", "api-verify"],
			["ui-preview", "excluded-by-user", "ui-preview"],
		]);
		// A record that carries no retry grant restores none.
		expect(stored?.adjustments).toBeUndefined();
		expect(await h.controller.setPlan(h.ctx, planFor())).toMatchObject({
			ok: false,
			reason: expect.stringContaining("제외"),
		});
		await h.controller.finish("interrupted");
	});
});
