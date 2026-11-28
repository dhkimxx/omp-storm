/**
 * Judgments decided after an awaited evidence read must not overwrite a newer one:
 * - an older attempt whose evaluation finishes after a newer attempt of the same lane settled;
 * - a revocation decided from an accepted row's old location while a newer attempt re-accepted that row.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import * as evidence from "../src/runtime/result-evidence.ts";
import type { AgentEntry, RunPlan, RunResult, StormConfig } from "../src/types.ts";
import { fakeSession, type FakeSession } from "./fake-session.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const TEAM: StormConfig = teamOf({ explorer: "a/x", implementer: "a/i", quick: "a/q", reviewer: "a/r" });
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-claim3-"))); });
afterEach(async () => { resetLedger(); resetAgents(); await rm(root, { recursive: true, force: true }); });
const session = (agents: AgentEntry[]) => fakeSession({ root, agents, config: TEAM });
const planFor = (lanes: RunPlan["lanes"], workers: Record<string, number>): RunPlan => ({ lanes, workers, submittedAt: new Date(T0).toISOString() });
const report = (over: Partial<AttemptReport> & Pick<AttemptReport, "runId" | "spawnKey" | "attemptId">): AttemptReport => ({
	schema: "storm.attempt-report/v1", parentId: "main", outcome: "success", capture: "observed", observedAt: T0 + 1, version: "unknown", artifacts: [], observations: [], ...over,
});
async function admit(h: FakeSession, plan: RunPlan, agents: AgentEntry[], laneName: string): Promise<string> {
	const lane = plan.lanes.find(c => c.name === laneName)!;
	const lanes = h.controller.runLanes()!;
	const agent = h.config.roles[lane.role]?.agent ?? `storm-${lane.role}`;
	const needed = new Set(plan.lanes.flatMap(c => (c.dependsOn ?? []).map(d => d.lane)));
	const readiness = needed.size === 0 ? undefined : await h.controller.laneReadiness(plan, needed);
	// R4/A1-5: a placement gives the host a fresh handle; the lane's name stays the table key.
	const bound = lanes.place({ name: laneName, agent, task: "do the lane" }, plan, h.config, readiness === undefined ? {} : { readiness });
	if (!bound.ok) throw new Error(bound.reason);
	const spawnKey = String(bound.input.name);
	const admission = lanes.admitChecked({ spawnKey, agent, outcome: "routed" }, { plan, config: h.config });
	if (!admission.ok) throw new Error(admission.reason);
	agents.push(agentEntry({ id: spawnKey, name: agent, role: lane.role, state: "idle", requests: 1, lastActivityAt: T0 + 1 }));
	return spawnKey;
}
const row = (h: FakeSession, id: string): RunResult | undefined => h.controller.active()?.results?.find(i => i.id === id);
const prep = (h: FakeSession, runId: string, lane: string, spawnKey: string, dispatch: string) =>
	h.controller.prepareAttempt({ runId, lane, spawnKey, parentId: "main", dispatch, followUp: false, artifactMode: "shared", startedAt: T0 });
const settlement = (runId: string, lane: string, spawnKey: string, dispatch: string): AttemptSettlement => ({
	runId, lane, spawnKey, parentId: "main", dispatch, startedAt: T0, observedAt: T0 + 1,
	report: report({ runId, spawnKey, attemptId: `job:${dispatch}:${spawnKey}` }), citations: [],
});

const plan = (): RunPlan => planFor([{ name: "b-produce", kind: "code", role: "implementer", files: ["b.txt"], goal: "Publish B",
	results: [{ id: "b-result", kind: "change", criterion: "b.txt holds a result", path: "b.txt", contains: "version:" }] }], { implementer: 1 });

describe("a late evaluation", () => {
	test("of an older attempt never overwrites the row a newer attempt settled", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		const laned = plan();
		expect(await h.controller.setPlan(h.ctx, laned)).toEqual({ ok: true });
		const old = await admit(h, laned, agents, "b-produce");
		expect(await prep(h, runId, "b-produce", old, "old")).toEqual({ ok: true });
		// The old attempt's evidence read sees a file with no result yet, then its evaluation stalls.
		await writeFile(path.join(root, "b.txt"), "draft\n");
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const original = evidence.evaluateSettledResults;
		let calls = 0;
		const spy = spyOn(evidence, "evaluateSettledResults").mockImplementation(async input => {
			const mine = ++calls;
			const out = await original(input);
			if (mine === 1) {
				entered.resolve();
				await gate.promise;
			}
			return out;
		});
		try {
			const oldSettle = h.controller.settleAttempt(settlement(runId, "b-produce", old, "old"));
			await entered.promise;
			h.controller.runLanes()?.releaseAgent(old);
			const latest = await admit(h, laned, agents, "b-produce");
			expect(await prep(h, runId, "b-produce", latest, "new")).toEqual({ ok: true });
			await writeFile(path.join(root, "b.txt"), "version: v1\n");
			await h.controller.settleAttempt(settlement(runId, "b-produce", latest, "new"));
			expect(row(h, "b-result")).toMatchObject({ state: "accepted", attemptId: `job:new:${latest}` });
			gate.resolve();
			await oldSettle;
			expect(row(h, "b-result")).toMatchObject({ state: "accepted", attemptId: `job:new:${latest}` });
		} finally {
			spy.mockRestore();
			gate.resolve();
		}
	});

	test("of an accepted row's old location never revokes the row a newer attempt re-accepted meanwhile", async () => {
		const agents: AgentEntry[] = [];
		const h = session(agents);
		const runId = await h.start();
		await writeFile(path.join(root, "report.json"), '{\n  "total": 42,\n  "offset": -42\n}\n');
		const laned = planFor([{ name: "read", kind: "explore", role: "explorer", goal: "Answer the total",
			results: [{ id: "total", kind: "answer", criterion: "states the report total", path: "report.json", contains: '"total": 42' }] }], { explorer: 1 });
		expect(await h.controller.setPlan(h.ctx, laned)).toEqual({ ok: true });
		const answer = async (spawnKey: string, dispatch: string): Promise<void> => {
			expect(await prep(h, runId, "read", spawnKey, dispatch)).toEqual({ ok: true });
			await h.controller.settleAttempt({
				...settlement(runId, "read", spawnKey, dispatch),
				reportText: "The total is 42 (report.json:2).",
				citations: [{ path: "report.json", line: 2 }],
			});
			h.controller.runLanes()?.releaseAgent(spawnKey);
		};
		const first = await admit(h, laned, agents, "read");
		await answer(first, "p1");
		const accepted = row(h, "total");
		expect(accepted).toMatchObject({ state: "accepted", attemptId: `job:p1:${first}` });
		const oldVersion = accepted?.contentVersion;

		// The cited line changes, so the old receipt no longer holds; its re-read stalls before the revoke is applied.
		await writeFile(path.join(root, "report.json"), '{\n  "total": 42, "unit": "kg",\n  "offset": -42\n}\n');
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const original = evidence.verifyAnswerReceipt;
		let stalled = false;
		const spy = spyOn(evidence, "verifyAnswerReceipt").mockImplementation(async input => {
			const out = await original(input);
			if (!stalled && input.expectedVersion === oldVersion) {
				stalled = true;
				entered.resolve();
				await gate.promise;
			}
			return out;
		});
		try {
			const revoking = h.controller.laneReadiness(laned, new Set(["read"]));
			await entered.promise;
			// A newer attempt answers from the current bytes and is accepted while the old re-read is still pending.
			const second = await admit(h, laned, agents, "read");
			await answer(second, "p2");
			expect(row(h, "total")).toMatchObject({ state: "accepted", attemptId: `job:p2:${second}` });
			expect(row(h, "total")?.contentVersion).not.toBe(oldVersion);
			gate.resolve();
			await revoking;
			expect(row(h, "total")).toMatchObject({ state: "accepted", attemptId: `job:p2:${second}` });
		} finally {
			spy.mockRestore();
			gate.resolve();
		}
	});
});
