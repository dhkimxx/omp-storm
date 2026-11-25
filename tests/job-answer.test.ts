/**
 * Job-backed answers (OMP D3): an answer an approved job lane accepted from observed stdout is proven by the host's
 * own job receipt, not by a citation. Revalidation (consumer readiness, finalization, resume) must keep it while the
 * exact receipt still holds and fail closed when that receipt is missing, mismatched or superseded, without letting
 * a `job:`-shaped attempt id exempt a citation-backed answer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetCloseoutChoices } from "../src/runtime/closeout.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { resultContractIdentity } from "../src/runtime/result-evidence.ts";
import { readRun } from "../src/runtime/run.ts";
import type { PlanLaneResult, RunPlan, StormConfig } from "../src/types.ts";
import { fakeSession, SESSION_TEAM } from "./fake-session.ts";

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-job-answer-")));
});

afterEach(async () => {
	resetCloseoutChoices();
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const RECEIPT: PlanLaneResult = { id: "first-receipt", kind: "answer", criterion: "observed first process exit", contains: "FIRST_READY" };
const NOTE: PlanLaneResult = { id: "note", kind: "answer", criterion: "summarize the observed exit" };

/** A job that counts its own runs in a marker file, so a replay is observable. */
function jobConfig(marker: string): StormConfig {
	return {
		...SESSION_TEAM,
		jobs: [{ name: "first", argv: [process.execPath, "-e",
			`const fs=require("node:fs");const p=${JSON.stringify(marker)};fs.appendFileSync(p,"x");console.log("FIRST_READY");`] }],
	};
}

const plan = (): RunPlan => ({
	submittedAt: "2026-11-25T09:00:00.000Z",
	workers: { explorer: 1 },
	lanes: [
		{ name: "first", kind: "run", role: "quick", job: "first", results: [RECEIPT] },
		{ name: "second", kind: "explore", role: "explorer", goal: "read the observed exit",
			dependsOn: [{ lane: "first", need: "result" }], results: [NOTE] },
	],
});

const runs = (marker: string): number => {
	try {
		return readFileSync(marker, "utf8").length;
	} catch {
		return 0;
	}
};

async function acceptedJob(marker: string) {
	const h = fakeSession({ root, config: jobConfig(marker) });
	const runId = await h.start({ task: "run the first job" });
	expect(await h.controller.setPlan(h.ctx, plan())).toEqual({ ok: true });
	expect(await h.controller.executeJobs(h.ctx, ["first"], () => true)).toMatchObject({ ok: true });
	expect(runs(marker)).toBe(1);
	const live = h.controller.active()!;
	const row = live.results!.find(candidate => candidate.id === RECEIPT.id)!;
	const receipt = live.jobs!.find(job => job.name === "first")!;
	return { h, runId, live, row, receipt };
}

const readiness = async (h: ReturnType<typeof fakeSession>, lane = "first") =>
	(await h.controller.laneReadiness(plan(), new Set([lane]))).get(lane)!.results[0]!;

/** The live ledger row, whose reason says why revalidation reopened it. */
const ledger = (h: ReturnType<typeof fakeSession>, id = RECEIPT.id) => h.controller.active()!.results!.find(row => row.id === id);

describe("job-backed answers", () => {
	test("a passed job's stdout answer stays accepted through consumer readiness and finalization", async () => {
		const marker = path.join(root, "runs");
		const { h, runId, row, receipt } = await acceptedJob(marker);
		expect(receipt).toMatchObject({ status: "passed", exitCode: 0, lane: "first", attemptId: row.attemptId });
		expect(row).toMatchObject({ state: "accepted", contentVersion: receipt.stdoutSha256 });
		expect(row.attemptId).toStartWith(`job:${runId}:`);

		expect(await readiness(h)).toMatchObject({ id: RECEIPT.id, state: "accepted", version: receipt.stdoutSha256 });
		await h.controller.finish("no-progress");
		const record = await readRun(h.sessionDir, runId);
		const final = record?.results?.find(candidate => candidate.id === RECEIPT.id);
		expect(final).toMatchObject({ state: "accepted", contentVersion: receipt.stdoutSha256 });
		expect(final?.finalized).not.toBe("revoked");
		expect(record?.jobs).toMatchObject([{ name: "first", status: "passed", stdoutSha256: receipt.stdoutSha256 }]);
		expect(runs(marker)).toBe(1);
	});

	test("a receipt whose observed stdout digest no longer matches the accepted version reopens the answer", async () => {
		const { h, receipt } = await acceptedJob(path.join(root, "runs"));
		receipt.stdoutSha256 = "0".repeat(64);
		expect(await readiness(h)).toMatchObject({ state: "unmet" });
		expect(ledger(h)).toMatchObject({ state: "unmet", reason: expect.stringContaining("관측된 출력") });
		expect(ledger(h)?.contentVersion).toBeUndefined();
		await h.controller.finish("no-progress");
	});

	test("a missing receipt fails closed", async () => {
		const { h, live } = await acceptedJob(path.join(root, "runs"));
		live.jobs!.splice(0, live.jobs!.length);
		expect(await readiness(h)).toMatchObject({ state: "unmet" });
		expect(ledger(h)).toMatchObject({ state: "unmet", reason: expect.stringContaining("실행 기록") });
		await h.controller.finish("no-progress");
	});

	test("a receipt for another attempt, a non-passing or fenced receipt, or another approved definition fails closed", async () => {
		const cases: Array<(receipt: Record<string, unknown>) => void> = [
			receipt => { receipt.attemptId = `${String(receipt.attemptId)}9`; },
			receipt => { receipt.status = "unknown"; },
			receipt => { receipt.exitCode = 1; },
			receipt => { receipt.fence = { cause: "lock-unreleased", paths: [] }; },
			receipt => { receipt.jobSha256 = "f".repeat(64); },
			receipt => { receipt.lane = "second"; },
		];
		for (const [index, tamper] of cases.entries()) {
			const marker = path.join(root, `runs-${index}`);
			const { h, receipt } = await acceptedJob(marker);
			tamper(receipt as unknown as Record<string, unknown>);
			expect(await readiness(h)).toMatchObject({ state: "unmet" });
			await h.controller.finish("no-progress");
			resetLedger();
			resetAgents();
		}
	});

	test("an accepted row from another run's attempt is not adopted live", async () => {
		const { h, row, receipt } = await acceptedJob(path.join(root, "runs"));
		const foreign = "job:run-20261101-000000-zzzz:1";
		row.attemptId = foreign;
		receipt.attemptId = foreign;
		expect(await readiness(h)).toMatchObject({ state: "unmet" });
		await h.controller.finish("no-progress");
	});

	test("a job-shaped attempt id does not exempt a citation answer of a non-job lane", async () => {
		const { h, live, row, receipt } = await acceptedJob(path.join(root, "runs"));
		const note = live.results!.find(candidate => candidate.id === NOTE.id)!;
		Object.assign(note, {
			state: "accepted", origin: "attempt", attemptId: row.attemptId, contentVersion: receipt.stdoutSha256,
			identity: resultContractIdentity(NOTE), consumed: [{ id: RECEIPT.id, version: receipt.stdoutSha256! }],
		});
		expect(await readiness(h, "second")).toMatchObject({ id: NOTE.id, state: "unmet" });
		expect(ledger(h, NOTE.id)).toMatchObject({ state: "unmet", reason: expect.stringContaining("출처 기록") });
		expect(await readiness(h)).toMatchObject({ state: "accepted" });
		await h.controller.finish("no-progress");
	});

	test("a resumed run keeps the restored job answer without replaying the job", async () => {
		const marker = path.join(root, "runs");
		const { h, runId, receipt } = await acceptedJob(marker);
		await h.controller.finish("interrupted");

		const next = await h.start({ task: "continue", resumeOf: runId });
		const restored = h.controller.active()!.results!.find(candidate => candidate.id === RECEIPT.id);
		expect(restored).toMatchObject({ state: "accepted", restoredFrom: runId, attemptId: receipt.attemptId, contentVersion: receipt.stdoutSha256 });
		expect(await readiness(h)).toMatchObject({ state: "accepted", version: receipt.stdoutSha256 });
		expect(await h.controller.executeJobs(h.ctx, ["first"], () => true)).toMatchObject({
			ok: true, text: expect.stringContaining("완료된 결과를 유지했습니다"),
		});
		expect(runs(marker)).toBe(1);
		await h.controller.finish("no-progress");
		const record = await readRun(h.sessionDir, next);
		expect(record?.results?.find(candidate => candidate.id === RECEIPT.id)).toMatchObject({ state: "accepted", restoredFrom: runId });
		expect(record?.jobs).toMatchObject([{ name: "first", status: "passed", attemptId: receipt.attemptId }]);
	});

	test("a restored job answer whose carried receipt no longer matches fails closed and is not replayed", async () => {
		const marker = path.join(root, "runs");
		const { h, runId, receipt } = await acceptedJob(marker);
		await h.controller.finish("interrupted");

		await h.start({ task: "continue", resumeOf: runId });
		const live = h.controller.active()!;
		live.jobs!.find(job => job.name === "first")!.stdoutSha256 = "0".repeat(64);
		expect(await readiness(h)).toMatchObject({ state: "unmet" });
		expect(receipt.status).toBe("passed");
		expect(await h.controller.executeJobs(h.ctx, ["first"], () => true)).toMatchObject({ ok: true });
		expect(runs(marker)).toBe(1);
		await h.controller.finish("no-progress");
	});
});
