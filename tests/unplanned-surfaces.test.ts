/**
 * What the user and the director read about work outside the declared results (P1-a), and the one unrelated rule that
 * rides with it: a run started by hand does not open while omp's plan mode is on, as an automatic start already did.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { approveAndSave, type FlowEnv, statusText } from "../src/flows.ts";
import { closeoutBrief } from "../src/runtime/closeout.ts";
import { PLAN_MODE_START_REFUSAL } from "../src/runtime/controller.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { readRun, writeRun } from "../src/runtime/run.ts";
import { unplannedLine } from "../src/runtime/unplanned.ts";
import { loadProjectState } from "../src/state.ts";
import type { RunRecord, UnplannedDelivery } from "../src/types.ts";
import { renderCloseout } from "../src/view/closeout.ts";
import { fakeModes, fakeSession } from "./fake-session.ts";
import { runRecord } from "./fixtures.ts";
import { makeProject, TEAM, type TestProject } from "./support.ts";

const delivery = (n: number): UnplannedDelivery => ({ id: `job:j${n}:peer`, kind: "woken", agent: "peer", endedAt: 10_000 + n });
const finished = (over: Partial<RunRecord> = {}): RunRecord =>
	runRecord({ status: "done", endReason: "verified", startedAt: "2026-11-26T08:00:00.000Z", endedAt: "2026-11-26T08:02:00.000Z", ...over });

afterEach(() => {
	resetLedger();
	resetAgents();
});

describe("the closeout card", () => {
	test("names how many deliveries were tied to no result and what the run spent, without moving the tier or the tone", () => {
		const plain = closeoutBrief(finished({ costUsd: 2.5 }));
		const withWork = closeoutBrief(finished({ costUsd: 2.5, unplanned: [delivery(1), delivery(2), delivery(3)], unplannedCount: 3 }));
		expect(plain.residual).toEqual([]);
		expect(withWork.residual).toHaveLength(1);
		expect(withWork.residual[0]).toContain("3건");
		// The clean run stays a clean run: only the line is new.
		expect(withWork.tier).toBe(plain.tier);
		expect(withWork.official.tone).toBe(plain.official.tone);
		// The one-row record of a short clean run does not carry the figure (with it the row is 68 columns and wraps at 60: it
		// is in `/storm status`); the card does.
		expect(withWork.official.label).not.toContain("비용");
		const card = closeoutBrief(finished({ costUsd: 2.5, unplanned: [delivery(1)], endedAt: "2026-11-26T08:30:00.000Z" }));
		expect(card.tier).toBe("card");
		expect(card.official.label).toContain("$2.50");
		expect(renderCloseout(card, false).markdown).toContain(unplannedLine({ unplanned: [delivery(1)] })!);
	});

	test("it takes the place of the lowest risk, never a place beyond the three the card shows", () => {
		const risky = finished({ status: "stopped", endReason: "budget", unplanned: [delivery(1)], jobs: [{ lane: "a", name: "x", status: "started", exitCode: null, startedAt: null, finishedAt: null }] });
		const brief = closeoutBrief({ ...risky, closeoutFacts: { target: "t", pendingLanes: ["a", "b", "c"], requiredChecks: [] } });
		expect(brief.residual.length).toBeLessThanOrEqual(3);
		expect(brief.residual.at(-1)).toContain("1건");
	});

	test("a record written before this field existed reads as it always did", () => {
		const old = finished({ costUsd: 0 });
		expect("unplanned" in old).toBe(false);
		expect(closeoutBrief(old).residual).toEqual([]);
		expect(unplannedLine(old)).toBeUndefined();
	});
});

describe("the status", () => {
	let project: TestProject;
	let env: FlowEnv;
	beforeEach(async () => {
		project = await makeProject(() => Date.parse("2026-11-26T09:00:00Z"));
		env = project.env;
		await approveAndSave(await loadProjectState(env), TEAM, { shadowedAgents: [] });
	});
	afterEach(async () => {
		await project.remove();
	});

	test("the last run's line says how many deliveries answered no result, and how much it spent as a floor when it is one", async () => {
		const state = await loadProjectState(env);
		const run = finished({ costUsd: 1.25, unplanned: [delivery(1), delivery(2)], unplannedCount: 2, spend: { lowerBound: true, evalUnread: 1 } });
		await writeRun(state.sessionDir, run);
		for (const auto of [true, false]) {
			const text = await statusText({ ...env, autoEnabled: () => auto }, { quota: false });
			expect(text).toContain(unplannedLine(run)!);
			expect(text).toContain("$1.2500(하한)");
		}
		// The record on disk is the record read: the new fields survive a write and a read.
		const back = await readRun(state.sessionDir, run.runId);
		expect(back?.unplanned).toHaveLength(2);
		expect(back?.spend).toEqual({ lowerBound: true, evalUnread: 1 });
	});

	test("a run without any says nothing about them", async () => {
		const state = await loadProjectState(env);
		await writeRun(state.sessionDir, finished({ costUsd: 0.5 }));
		const text = await statusText({ ...env, autoEnabled: () => true }, { quota: false });
		expect(text).not.toContain("결과와 무관한 도착");
		expect(text).not.toContain("하한");
	});
});

describe("omp's plan mode and a run started by hand", () => {
	let root: string;
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-plan-mode-")));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("no run opens while plan mode is on, the user is told why, and nothing is sent", async () => {
		const modes = fakeModes();
		modes.state.plan.status = "active";
		const h = fakeSession({ root, modes });
		const refused = await h.controller.start(h.ctx, { task: "t" });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.reason).toBe(PLAN_MODE_START_REFUSAL);
		expect(h.sent).toEqual([]);
		expect(h.ui.selects).toEqual([]);
		expect(h.controller.active()).toBeUndefined();
	});

	test("plan mode is checked with vibe: the user is not offered to leave vibe only to be refused after", async () => {
		const modes = fakeModes({ vibe: true });
		modes.state.plan.status = "active";
		const h = fakeSession({ root, modes, answers: [options => options[0]] });
		expect((await h.controller.start(h.ctx, { task: "t" })).ok).toBe(false);
		expect(h.ui.selects).toEqual([]);
		expect(modes.state.vibe.status).toBe("active");
	});

	test("with plan mode off the same start goes through", async () => {
		const h = fakeSession({ root, modes: fakeModes() });
		const runId = await h.start({ task: "t" });
		expect(h.controller.active()?.runId).toBe(runId);
		await h.controller.finish("shutdown");
	});
});
