/**
 * FC: the faults the real-host measurement at 8 to 100 workers found, and the review's F2/F3. One test per behaviour;
 * constants are imported where a word is the contract. The probes under /tmp/storm-p3/FC show each of these failing on
 * the found tree and passing here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	closeoutBrief,
	STORM_STOP_LABEL,
	stormStopLine,
} from "../src/runtime/closeout.ts";
import { noteRunSpawn, noteRunStopped, type PlanlessStart } from "../src/runtime/controller.ts";
import { LANE_ADDRESS_HINT, PLAN_LANE_NAMES_SHOWN, PLAN_WORKER_COUNT_NOTE } from "../src/runtime/contract-text.ts";
import { recordCost } from "../src/runtime/ledger.ts";
import { resultFacts } from "../src/runtime/result-facts.ts";
import { decideRound, END_LABEL, END_STATUS, NO_DECLARED_END_LABEL, NO_DECLARED_END_REASON, NO_PROGRESS_ROUNDS } from "../src/runtime/rounds.ts";
import { readRun } from "../src/runtime/run.ts";
import { UNPLANNED_MAX, outOfPlanLine, unplannedLine, unplannedSplit } from "../src/runtime/unplanned.ts";
import { renderPlanView } from "../src/tool/plan-view.ts";
import { runStormTool } from "../src/tool/storm-tool.ts";
import { workerStopNotice } from "../src/policy/thread.ts";
import type { PlanRequest, RunRecord, SpawnRecord, UnplannedDelivery } from "../src/types.ts";
import { renderCloseout } from "../src/view/closeout.ts";
import { agentEntry, runRecord, spawnRecord, treeOf } from "./fixtures.ts";
import { fakeSession, SESSION_TEAM, until } from "./fake-session.ts";
import { fakeHost } from "./fake-host.ts";

let root = "";
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

const stop = { attempt: "a1", reason: "pooled-thread" as const, at: Date.parse("2026-11-28T00:00:00Z") };
const delivery = (n: number, status: string, kind: UnplannedDelivery["kind"] = "out-of-plan"): UnplannedDelivery => ({
	id: `job:j${n}:W${n}`,
	kind,
	agent: `W${n}`,
	endedAt: Date.parse("2026-11-28T00:01:00Z") + n,
	status,
});

describe("fault 3: a plan-less run whose workers finished is not a stall", () => {
	test("worker change counters with no parent-tree change end as no declared results in one round", async () => {
		root = mkdtempSync(path.join(tmpdir(), "fc-stall-"));
		const agents = [agentEntry({ id: "W1", role: "implementer", state: "idle", changes: 1, lastChangeAt: 1, requests: 2 })];
		const h = fakeSession({ root, agents });
		const opened = await h.controller.startPlanless(h.ctx, { task: "task" }, { turnStartedAt: Date.now() - 1_000, deadline: Date.now() + 60_000, lease: "write" } satisfies PlanlessStart);
		if (!opened.ok) throw new Error(opened.reason);
		await h.turn();
		const final = await readRun(h.sessionDir, opened.runId);
		expect(final?.status).toBe(END_STATUS[NO_DECLARED_END_REASON]);
		expect(final?.endReason).toBe(NO_DECLARED_END_REASON);
		expect(final?.turns).toBe(1);
		expect(END_LABEL[NO_DECLARED_END_REASON]).toBe(NO_DECLARED_END_LABEL);
		await h.controller.finish("shutdown");
	});

	test("a passed gate never verifies a run that declared no result row", () => {
		const decision = decideRound({
			gate: { state: "passed" },
			turns: 1,
			aborted: false,
			overBudget: false,
			elapsedMs: 0,
			noDeclaredResults: true,
		});
		expect(decision).toEqual({ action: "end", reason: NO_DECLARED_END_REASON });
	});

	test("a plan-less run whose parent tree moved keeps its review rounds and ends as unreviewed, not no-progress", async () => {
		root = mkdtempSync(path.join(tmpdir(), "fc-stall-tree-"));
		const agents = [agentEntry({ id: "W1", role: "implementer", state: "idle", changes: 1, lastChangeAt: 1, requests: 2 })];
		let tree = treeOf("d0", "f0");
		const h = fakeSession({ root, agents, tree: () => ({ base: "base-0", state: tree }) });
		const opened = await h.controller.startPlanless(h.ctx, { task: "task" }, { turnStartedAt: Date.now() - 1_000, deadline: Date.now() + 60_000, lease: "write" } satisfies PlanlessStart);
		if (!opened.ok) throw new Error(opened.reason);
		tree = treeOf("d1", "f0");
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 1);
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		await h.turn();
		const final = await readRun(h.sessionDir, opened.runId);
		expect(final?.endReason).toBe("unreviewed");
		expect(final?.status).toBe(END_STATUS.unreviewed);
		expect(final?.turns).toBe(1 + NO_PROGRESS_ROUNDS);
		await h.controller.finish("shutdown");
	});

	test("a run that really does not move still ends no-progress", () => {
		const gate = {
			state: "unverified" as const,
			cause: "coverage" as const,
			evidence: "missing" as const,
			changes: 0,
			reviews: 0,
			requests: 0,
		};
		const decision = decideRound({
			gate,
			turns: 3,
			aborted: false,
			overBudget: false,
			elapsedMs: 0,
			noDeclaredResults: true,
			progressSince: { changes: 0, reviews: 0, requests: 0 },
			stalled: NO_PROGRESS_ROUNDS - 1,
		});
		expect(decision).toEqual({ action: "end", reason: "no-progress" });
	});
});

describe("fault 2: a Storm stop is named where the director reads results", () => {
	test("the notice queue carries the real stop sentence, once, for a hundred stopped workers", async () => {
		root = mkdtempSync(path.join(tmpdir(), "fc-stop-"));
		const h = fakeSession({ root, agents: [agentEntry({ id: "W0", role: "explorer", state: "idle" })] });
		const runId = await h.start();
		const total = 73;
		for (let i = 0; i < total; i += 1) {
			noteRunSpawn(runId, spawnRecord({ agent: "storm-explorer", spawnKey: `W${i}` }));
			noteRunStopped(runId, `W${i}`, stop);
		}
		const notice = h.controller.takeNotices() ?? "";
		expect(notice.split("\n")).toHaveLength(1);
		expect(notice).toContain("Storm이 중단한 워커 73개");
		expect(notice).toContain(workerStopNotice("W0", "pooled-thread"));
		// The journal does not repeat a sentence per worker.
		expect(notice).not.toContain(workerStopNotice("W72", "pooled-thread"));
		expect(notice.length).toBeLessThan(900);
		expect(h.controller.takeNotices()).toBeUndefined();
		await h.controller.finish("shutdown");
	});

	test("the card quotes the real sentence and the facts count stops by cause", () => {
		const spawns: SpawnRecord[] = Array.from({ length: 8 }, (_, i) =>
			spawnRecord({ agent: "storm-explorer", spawnKey: `W${i}`, stop }),
		);
		const run: RunRecord = runRecord({
			status: "stopped",
			endReason: "no-progress",
			endedAt: "2026-11-28T00:02:00Z",
			task: "read",
			turns: 3,
			spawns,
			agents: spawns.map(spawn => agentEntry({ id: spawn.spawnKey ?? "", name: "storm-explorer", role: "explorer", state: "idle" })),
			unplanned: Array.from({ length: 8 }, (_, i) => delivery(i, "failed", "unplaced")),
			unplannedCount: 8,
		});
		const facts = resultFacts(run);
		expect(facts.stormStops?.count).toBe(8);
		expect(facts.stormStops?.reasons).toEqual([{ reason: "pooled-thread", count: 8, first: "W0" }]);
		expect(stormStopLine({ reason: "pooled-thread", count: 8, first: "W0" })).toContain(workerStopNotice("W0", "pooled-thread"));
		const brief = closeoutBrief(run);
		expect(brief.tier).toBe("card");
		expect(brief.stormStops?.count).toBe(8);
		const card = renderCloseout(brief, false).markdown;
		expect(card).toContain(STORM_STOP_LABEL);
		expect(card).toContain(workerStopNotice("W0", "pooled-thread"));
		// The card is one line per cause plus the fixed card lines, never one line per stopped worker.
		expect(card.split("\n").length).toBeLessThan(20);
	});
});

describe("fault 4 and F2: deliveries are counted by what they carried", () => {
	test("completed and Storm-stopped deliveries are counted apart, from the kept list's own statuses", () => {
		const spawns: SpawnRecord[] = Array.from({ length: 16 }, (_, i) =>
			spawnRecord({ spawnKey: `W${i}`, ...(i >= 8 ? { stop } : {}) }),
		);
		const deliveries = Array.from({ length: 16 }, (_, i) => delivery(i, i < 8 ? "completed" : "failed"));
		const line = outOfPlanLine({ spawns, unplanned: deliveries, unplannedCount: deliveries.length }) ?? "";
		expect(line).toContain("계획 밖 활동 16건");
		expect(line).toContain("완료 8");
		expect(line).toContain("Storm 중단 8");
		expect(line).toContain("결과 행은 바뀌지 않음");
	});

	test("asked-for deliveries past the bounded list stay asked-for, not unasked arrivals", async () => {
		root = mkdtempSync(path.join(tmpdir(), "fc-count-"));
		const h = fakeSession({ root, agents: [] });
		const runId = await h.start();
		const total = UNPLANNED_MAX + 1;
		for (let i = 0; i < total; i += 1) noteRunSpawn(runId, spawnRecord({ agent: "storm-explorer", spawnKey: `W${i}` }));
		for (let i = 0; i < total; i += 1) {
			h.controller.noteUnplannedDelivery({ runId, id: `job:j${i}:W${i}`, kind: "unplaced", agent: `W${i}`, receiverId: "main", endedAt: Date.now() + i });
		}
		const final = await h.controller.finish("shutdown");
		expect(final?.unplannedCount).toBe(total);
		expect(final?.unplannedAsked).toBe(total);
		expect(final?.unplanned?.length).toBe(UNPLANNED_MAX);
		expect(unplannedSplit(final!)).toMatchObject({ outOfPlan: total, unasked: 0, kept: UNPLANNED_MAX });
		expect(unplannedLine(final!)).toBeUndefined();
		expect(outOfPlanLine(final!)).toContain(`계획 밖 활동 ${total}건`);
	});
});

describe("F3: the notice at the limit says what happens now", () => {
	test("block-spawns: no message of any kind; a running turn finishes", async () => {
		root = mkdtempSync(path.join(tmpdir(), "fc-budget-"));
		const h = fakeSession({ root, config: { ...SESSION_TEAM, budget: { perRunUsd: 1, warnAtUsd: 0.5, onExceed: "block-spawns" } } });
		const runId = await h.start();
		recordCost(runId, "m/i", 2);
		const notice = h.notices.map(entry => entry.text).join("\n");
		expect(notice).toContain("어떤 agent:// 메시지도 보내지 않습니다");
		expect(notice).not.toContain("진행 메모는 보낼 수 있습니다");
		expect(notice).toContain("지금 턴은 끝까지 진행");
		await h.controller.finish("shutdown");
	});

	test("stop: the next request of a running worker is not sent", async () => {
		root = mkdtempSync(path.join(tmpdir(), "fc-budget-"));
		const h = fakeSession({ root, config: { ...SESSION_TEAM, budget: { perRunUsd: 1, warnAtUsd: 0.5, onExceed: "stop" } } });
		const runId = await h.start();
		recordCost(runId, "m/i", 2);
		const notice = h.notices.map(entry => entry.text).join("\n");
		expect(notice).toContain("어떤 agent:// 메시지도 보내지 않습니다");
		expect(notice).toContain("다음 요청도 보내지 않습니다");
		expect(notice).not.toContain("진행 메모는 보낼 수 있습니다");
		await h.controller.finish("shutdown");
	});
});

describe("faults 6 and 7: the plan reply's names and worker number", () => {
	test("lane names are the address the director can use; the worker number is not a limit", async () => {
		const lanes = Array.from({ length: 10 }, (_, i) => ({
			name: `L${i}`,
			kind: "explore" as const,
			role: "explorer" as const,
			goal: `read ${i}`,
			results: [{ id: `r${i}`, kind: "answer" as const, criterion: `report ${i}` }],
		}));
		const plan: PlanRequest = { lanes, workers: { explorer: 4 } };
		const f = fakeHost({ runActive: true });
		const reply = await runStormTool(f.host, { action: "plan", plan });
		const text = reply.outcome === "ok" ? reply.text : "";
		expect(text).toContain(LANE_ADDRESS_HINT);
		expect(text).toContain(PLAN_WORKER_COUNT_NOTE);
		expect(text).not.toContain("개/최대");
		const roleLine = text.split("\n").find(line => line.startsWith("- 탐색")) ?? "";
		expect(roleLine).toContain(`외 ${10 - PLAN_LANE_NAMES_SHOWN}개`);
		expect(roleLine).toContain("L0");
		expect(roleLine).not.toContain("L9");
	});

	test("the status plan view carries the same worker-number note", () => {
		const plan = {
			lanes: [{ name: "L0", kind: "code" as const, role: "implementer" }],
			workers: { implementer: 1 },
			submittedAt: "2026-11-28T00:00:00.000Z",
		};
		const view = renderPlanView({ runId: "r", plan }) ?? "";
		expect(view).toContain(PLAN_WORKER_COUNT_NOTE);
		expect(view).toContain(LANE_ADDRESS_HINT);
	});
});
