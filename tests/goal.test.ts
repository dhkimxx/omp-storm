import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { activeMs, carryGoal, goalTotals } from "../src/runtime/goal.ts";
import { stopDeadRuns } from "../src/runtime/janitor.ts";
import { readRun, resumableRun, writeRun } from "../src/runtime/run.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import type { RunRecord } from "../src/types.ts";
import { DEAD_PROCESS, runRecord } from "./fixtures.ts";

type Goal = NonNullable<RunRecord["goal"]>;

const MIN = 60_000;
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const parent = (over: Partial<RunRecord> = {}): RunRecord =>
	runRecord({
		runId: "run-20261120-100000-goal",
		startedAt: at(0),
		endedAt: at(30 * MIN),
		status: "stopped",
		endReason: "interrupted",
		request: "the goal",
		costUsd: 1.5,
		turns: 3,
		...over,
	});

/** The record without the named fields, as a record that never wrote them. */
function without(run: RunRecord, ...keys: Array<keyof RunRecord>): RunRecord {
	const copy: Partial<RunRecord> = { ...run };
	for (const key of keys) delete copy[key];
	return copy as RunRecord;
}

/** Every number of a carry or a total is finite and never negative; counts are integers. */
function sane(value: { runs: number; usd: number; ms: number; turns: number }): void {
	for (const n of [value.runs, value.usd, value.ms, value.turns]) {
		expect(Number.isFinite(n)).toBe(true);
		expect(n).toBeGreaterThanOrEqual(0);
	}
	expect(Number.isInteger(value.runs)).toBe(true);
	expect(Number.isInteger(value.turns)).toBe(true);
}

describe("carryGoal", () => {
	test("the first resume carries the parent's own cost, active time and rounds, and names the parent as the first run", () => {
		expect(carryGoal(parent())).toEqual({ firstRunId: "run-20261120-100000-goal", runs: 1, usd: 1.5, ms: 30 * MIN, turns: 3 });
	});

	test("a resume of a resume adds the parent's own use to what the parent carried and keeps the first run id", () => {
		const middle = parent({
			runId: "run-20261120-110000-mid0",
			startedAt: at(60 * MIN),
			endedAt: at(70 * MIN),
			costUsd: 0.5,
			turns: 2,
			goal: { firstRunId: "run-20261120-100000-goal", runs: 1, usd: 1.5, ms: 30 * MIN, turns: 3 },
		});
		expect(carryGoal(middle)).toEqual({ firstRunId: "run-20261120-100000-goal", runs: 2, usd: 2, ms: 40 * MIN, turns: 5 });
	});

	test("NaN, negative, infinite or missing parent values never give a negative or NaN carry", () => {
		const corrupt = [
			parent({ costUsd: Number.NaN, turns: -3 }),
			parent({ costUsd: -4, turns: Number.POSITIVE_INFINITY, endedAt: at(-10 * MIN) }),
			parent({ startedAt: "not a time", endedAt: "also not" }),
			parent({ goal: { firstRunId: "run-20261120-090000-root", runs: -2, usd: Number.NaN, ms: -50, turns: Number.NEGATIVE_INFINITY } }),
			parent({ goal: { firstRunId: "run-20261120-090000-root" } as unknown as Goal }),
			without(parent(), "turns", "costUsd", "endedAt"),
		];
		for (const run of corrupt) sane(carryGoal(run));
		expect(carryGoal(corrupt[0]!)).toMatchObject({ usd: 0, turns: 0, ms: 30 * MIN });
		// An end before the start is no time, not negative time.
		expect(carryGoal(corrupt[1]!)).toMatchObject({ usd: 0, turns: 0, ms: 0 });
		expect(carryGoal(corrupt[3]!)).toEqual({ firstRunId: "run-20261120-090000-root", runs: 1, usd: 1.5, ms: 30 * MIN, turns: 3 });
		expect(carryGoal(corrupt[4]!)).toEqual({ firstRunId: "run-20261120-090000-root", runs: 1, usd: 1.5, ms: 30 * MIN, turns: 3 });
	});

	test("a malformed stored goal is treated as absent: the parent starts the goal", () => {
		for (const goal of ["x", null, { firstRunId: "" }, { firstRunId: 7 }, { firstRunId: "r".repeat(201) }]) {
			const run = parent({ goal: goal as unknown as Goal });
			expect(carryGoal(run)).toEqual({ firstRunId: run.runId, runs: 1, usd: 1.5, ms: 30 * MIN, turns: 3 });
		}
	});
});

describe("activeMs", () => {
	test("an ended run counts to its end, a run without an end to its last live write, a bare one to nothing", () => {
		expect(activeMs(parent())).toBe(30 * MIN);
		expect(activeMs(without(parent({ updatedAt: at(12 * MIN) }), "endedAt"))).toBe(12 * MIN);
		expect(activeMs(without(parent(), "endedAt", "updatedAt"))).toBe(0);
		expect(activeMs(parent({ endedAt: at(-MIN) }))).toBe(0);
	});
});

describe("goalTotals", () => {
	test("a record that continues nothing has no goal totals", () => {
		expect(goalTotals(parent(), T0 + 90 * MIN)).toBeUndefined();
		expect(goalTotals(parent({ goal: "x" as unknown as Goal }), T0 + 90 * MIN)).toBeUndefined();
	});

	test("a running record counts itself up to now; a finished one up to its end", () => {
		const goal = { firstRunId: "run-20261120-090000-root", runs: 2, usd: 3, ms: 20 * MIN, turns: 6 };
		const running = without(parent({ status: "running", updatedAt: at(MIN), costUsd: 0.25, turns: 1, goal }), "endedAt", "endReason");
		expect(goalTotals(running, T0 + 5 * MIN)).toEqual({ runs: 3, usd: 3.25, ms: 25 * MIN, turns: 7 });
		// A clock behind the start adds no time rather than taking some away.
		expect(goalTotals(running, T0 - MIN)).toEqual({ runs: 3, usd: 3.25, ms: 20 * MIN, turns: 7 });
		const ended = parent({ goal });
		expect(goalTotals(ended, T0 + 999 * MIN)).toEqual({ runs: 3, usd: 4.5, ms: 50 * MIN, turns: 9 });
		sane(goalTotals(parent({ costUsd: Number.NaN, turns: -1, goal: { ...goal, usd: -1 } }), Number.NaN)!);
	});
});

describe("a dead parent", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-goal-")));
	});
	afterEach(() => rm(tmp, { recursive: true, force: true }));

	test("closed by the session-start sweep at its last live write, it carries its last flushed cost and rounds", async () => {
		const sessionDir = sessionStoreDir(path.join(tmp, "profile"), "owner");
		const dead = without(
			parent({ status: "running", process: DEAD_PROCESS, updatedAt: at(12 * MIN), costUsd: 0.75, turns: 4 }),
			"endReason",
			"endedAt",
		);
		await writeRun(sessionDir, dead);
		await stopDeadRuns({ sessionDir, alive: () => false });
		const closed = await readRun(sessionDir, dead.runId);
		expect(closed).toMatchObject({ status: "stopped", endedAt: dead.updatedAt });
		expect(resumableRun(closed)).toBe(true);
		expect(carryGoal(closed!)).toEqual({ firstRunId: dead.runId, runs: 1, usd: 0.75, ms: 12 * MIN, turns: 4 });
	});
});
