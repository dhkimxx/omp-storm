/**
 * What the run spent in all (P1-a). Spend was counted only for children Storm bound at spawn: a child of a child, an
 * agent an eval cell started, and the model calls `completion()` and `judge()` make never reached the total, so the
 * budget was compared with a smaller number. Now every agent whose parent chain reaches the run counts, an agent that
 * only shares the run's session tree counts apart, eval helper calls are read back from the session file, and what
 * still cannot be read makes the total a floor, said so.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeoutBrief } from "../src/runtime/closeout.ts";
import {
	bindLedgerChild,
	getLedgerRun,
	ledgerRunForChild,
	ledgerRunForLineage,
	ledgerRunForTree,
	recordCost,
	recordTreeCost,
	resetLedger,
	spendNote,
	startLedgerRun,
} from "../src/runtime/ledger.ts";
import { DISCARDED_TURN_PURPOSE, mayMakeSideCalls, readSideSpend, resetSideSpendCursors, settleSideSpend, usesModelHelpers } from "../src/runtime/side-spend.ts";
import { spendText } from "../src/runtime/unplanned.ts";
import { runRecord } from "./fixtures.ts";
import { runStatusCounters } from "../src/view/render.ts";

afterEach(() => resetLedger());

const RUN_STARTED = 1_000;
const start = (budget?: { perRunUsd: number }) =>
	startLedgerRun({
		runId: "run-1",
		sessionId: "s1",
		sessionDir: "/store/s1",
		repoId: "r",
		root: "/repo",
		artifactsDir: "/art/s1",
		startedAt: RUN_STARTED,
		...(budget === undefined ? {} : { budget: { ...budget, onExceed: "stop" as const } }),
	});

/** A registry with a three-deep chain: main → w1 → w2 → w3, and one agent whose chain ends outside any run. */
const parents: Record<string, string | undefined> = { w1: "Main", w2: "w1", w3: "w2", stray: "Elsewhere", Elsewhere: undefined, old: "Main" };
/** Every agent was created after the run began except `old`, which an earlier run left behind. */
const created: Record<string, number> = { old: RUN_STARTED - 1 };
const host = {
	parentOf: (id: string) => parents[id],
	isMain: (id: string) => id === "Main",
	createdAt: (id: string) => created[id] ?? RUN_STARTED + 10,
};
const mainRun = (id: string) => (id === "Main" ? getLedgerRun("run-1") : undefined);

describe("an agent whose chain of parents reaches the run counts toward it", () => {
	test("a child bound at spawn is found at once; its child and grandchild are found through the chain", () => {
		start();
		bindLedgerChild("run-1", "w1", "Main", "/art/s1");
		expect(ledgerRunForChild("w2", "w1", "/art/s1")).toBeUndefined();
		expect(ledgerRunForLineage("w2", "w1", "/art/s1", host, mainRun)?.runId).toBe("run-1");
		// The grandchild's parent was bound by the walk above, but the walk also works from a cold start.
		expect(ledgerRunForLineage("w3", "w2", "/art/s1", host, mainRun)?.runId).toBe("run-1");
		expect(ledgerRunForChild("w3", "w2", "/art/s1")?.runId).toBe("run-1");
	});

	test("a child nobody bound is reached through the main session when the registry names it", () => {
		start();
		expect(ledgerRunForLineage("w3", "w2", "/art/s1", host, mainRun)?.runId).toBe("run-1");
		expect(ledgerRunForChild("w1", "Main", "/art/s1")?.runId).toBe("run-1");
	});

	test("a chain that ends elsewhere binds nothing", () => {
		start();
		expect(ledgerRunForLineage("stray", "Elsewhere", "/art/s1", host, mainRun)).toBeUndefined();
		expect(ledgerRunForChild("stray", "Elsewhere", "/art/s1")).toBeUndefined();
	});

	test("an agent an earlier run left behind is not this run's, though its parent chain reaches the director", () => {
		start();
		expect(ledgerRunForLineage("old", "Main", "/art/s1", host, mainRun)).toBeUndefined();
		expect(ledgerRunForChild("old", "Main", "/art/s1")).toBeUndefined();
	});

	test("the director of a run in another artifact tree does not own the agent, nor does a child id another session reuses", () => {
		start();
		// The same chain in a different session's artifact tree: that run is not this tree's.
		expect(ledgerRunForLineage("w2", "w1", "/art/other", host, mainRun)).toBeUndefined();
		// `w1` is bound in the run's own tree only; the same id as a parent in another tree finds nothing there.
		bindLedgerChild("run-1", "w1", "Main", "/art/s1");
		expect(ledgerRunForLineage("w2", "w1", "/art/other", host, mainRun)).toBeUndefined();
		expect(ledgerRunForChild("w2", "w1", "/art/other")).toBeUndefined();
	});

	test("the budget sees the descendant's spend: the limit stops at the number the user set", () => {
		const run = start({ perRunUsd: 1 });
		const fired: string[] = [];
		run.onThreshold = kind => void fired.push(kind);
		const reached = ledgerRunForLineage("w3", "w2", "/art/s1", host, mainRun);
		recordCost(reached!.runId, "a/m", 0.6);
		expect(fired).toEqual([]);
		recordCost(reached!.runId, "a/m", 0.5);
		expect(getLedgerRun("run-1")?.costUsd).toBeCloseTo(1.1);
		expect(fired).toEqual(["limit"]);
	});
});

describe("spend of an agent only the session tree reaches", () => {
	test("it counts toward the total and the budget, and is told apart", () => {
		const run = start({ perRunUsd: 1 });
		expect(ledgerRunForTree("/art/s1")?.runId).toBe("run-1");
		expect(ledgerRunForTree("/art/other")).toBeUndefined();
		recordTreeCost("run-1", "a/m", 1.2);
		expect(run.costUsd).toBeCloseTo(1.2);
		expect(run.exceeded).toBe(true);
		expect(spendNote(run)).toEqual({ treeUsd: 1.2 });
	});
});

describe("model calls outside a session's main loop", () => {
	beforeEach(() => resetSideSpendCursors());

	test("code that asks a model through the helpers is recognised; a name that only ends alike is not; find and web_search may call one", () => {
		expect(usesModelHelpers("x = await completion('hi')")).toBe(true);
		expect(usesModelHelpers("const r = await judge({state, questions})")).toBe(true);
		expect(usesModelHelpers("r = judge_batch(states, questions)")).toBe(true);
		expect(usesModelHelpers("const b = await judgeBatch(states, qs)")).toBe(true);
		expect(usesModelHelpers("print(autocompletion(1))")).toBe(false);
		expect(usesModelHelpers("obj.judge(1)")).toBe(false);
		expect(usesModelHelpers(undefined)).toBe(false);
		expect(mayMakeSideCalls("find", { pattern: "x" })).toBe(true);
		expect(mayMakeSideCalls("web_search", { query: "x" })).toBe(true);
		expect(mayMakeSideCalls("eval", { code: "await completion('x')" })).toBe(true);
		expect(mayMakeSideCalls("eval", { code: "1 + 1" })).toBe(false);
		expect(mayMakeSideCalls("read", { path: "x" })).toBe(false);
	});

	test("every journaled purpose counts, by what was appended; reading again counts nothing twice; an unreadable file is a floor", async () => {
		const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-spend-")));
		try {
			const file = path.join(dir, "session.jsonl");
			const entry = (purpose: string, total: number, at: string) =>
				JSON.stringify({ type: "model_usage", purpose, timestamp: at, usage: { cost: { total } } });
			const classes = ["completion", "judge:review", "judge_batch", "find", "web-search", "edit-repair", "auto-thinking", "compaction:auto", "job-caption"];
			await writeFile(file, [...classes.map(purpose => entry(purpose, 1, "2026-11-20T09:10:00Z")), entry("completion", 50, "2026-11-20T09:00:00Z"), JSON.stringify({ type: "message", usage: { cost: { total: 7 } } }), "not json {", ""].join("\n"));
			const since = Date.parse("2026-11-20T09:05:00Z");
			// Every purpose counts (before the run's start, a message entry and a broken line do not).
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(classes.length), calls: classes.length });
			// Appended later: only the new line is parsed and added.
			await appendFile(file, `${entry("find", 0.5, "2026-11-20T09:20:00Z")}\n`);
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(classes.length + 0.5), calls: classes.length + 1 });
			// A line still being written (no newline yet) is left for the next reading.
			await appendFile(file, entry("find", 0.25, "2026-11-20T09:21:00Z"));
			expect((await readSideSpend(file, since))?.calls).toBe(classes.length + 1);
			await appendFile(file, "\n");
			expect((await readSideSpend(file, since))?.calls).toBe(classes.length + 2);
			expect(await readSideSpend(path.join(dir, "missing.jsonl"), since)).toBeUndefined();

			const run = start();
			await settleSideSpend("run-1", file, since);
			expect(run.costUsd).toBeCloseTo(classes.length + 0.75);
			expect(spendNote(run)).toEqual({ evalUsd: expect.closeTo(classes.length + 0.75) });
			await settleSideSpend("run-1", file, since);
			expect(run.costUsd).toBeCloseTo(classes.length + 0.75);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// R-final N3: omp rewrites a session file in place (a rewrite that keeps or grows its size) and re-journals a dropped turn.
	test("a dropped turn's re-journaled usage is not counted again; a file omp rewrote is read once more without counting an entry twice or skipping one", async () => {
		const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-spend-")));
		try {
			const file = path.join(dir, "session.jsonl");
			const since = Date.parse("2026-01-01T00:00:00Z");
			const message = (pad: number) => JSON.stringify({ type: "message", id: "m1", timestamp: "2026-11-27T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(pad) }] } });
			const usage = (id: string, purpose: string, total: number) => JSON.stringify({ type: "model_usage", id, purpose, timestamp: "2026-11-27T00:00:01Z", usage: { cost: { total } } });
			await writeFile(file, `${message(10)}\n${usage("u1", "find", 0.25)}\n${usage("d1", DISCARDED_TURN_PURPOSE, 9)}\n`);
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(0.25), calls: 1 });
			// An earlier line grows, the same entries shift right, and a new one follows: only the new one is added.
			await writeFile(file, `${message(10 + 400)}\n${usage("u1", "find", 0.25)}\n${usage("d1", DISCARDED_TURN_PURPOSE, 9)}\n${usage("u2", "web-search", 0.5)}\n`);
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(0.75), calls: 2 });
			// An atomic rewrite (a new file under the name) that drops an old line and shifts the rest.
			await rm(file);
			await writeFile(file, `${usage("u1", "find", 0.25)}\n${message(900)}\n${usage("u2", "web-search", 0.5)}\n${usage("u3", "judge", 0.125)}\n`);
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(0.875), calls: 3 });
			// Appending still reads only what was appended.
			await appendFile(file, `${usage("u4", "completion", 1)}\n`);
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(1.875), calls: 4 });
			// An unchanged file is not read twice.
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(1.875), calls: 4 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("entries without an id are counted by their line, so a rewrite that moves them does not count them twice", async () => {
		const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-spend-")));
		try {
			const file = path.join(dir, "session.jsonl");
			const since = Date.parse("2026-01-01T00:00:00Z");
			const entry = (total: number) => JSON.stringify({ type: "model_usage", purpose: "find", timestamp: "2026-11-27T00:00:01Z", usage: { cost: { total } } });
			const pad = (n: number) => JSON.stringify({ type: "message", message: { role: "user", content: "p".repeat(n) } });
			// Two equal lines are two calls.
			await writeFile(file, `${entry(0.25)}\n${entry(0.25)}\n`);
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(0.5), calls: 2 });
			await writeFile(file, `${pad(300)}\n${entry(0.25)}\n${entry(0.25)}\n${entry(0.25)}\n`);
			expect(await readSideSpend(file, since)).toEqual({ usd: expect.closeTo(0.75), calls: 3 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a call that may have made a side call keeps the total a floor until its entry is found, or the turn ends with nothing found", async () => {
		const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-spend-")));
		try {
			const file = path.join(dir, "session.jsonl");
			await writeFile(file, "");
			const run = start();
			await settleSideSpend("run-1", file, 0, true);
			expect(spendNote(run)).toEqual({ lowerBound: true, evalUnread: 1 });
			// R-final N7: no entry came (a cached judgment, a search that asks no model): a reading in the turn's course keeps
			// the floor, the one at its end lifts it. An unreadable file at that point does not.
			await settleSideSpend("run-1", file, 0);
			expect(spendNote(run)).toEqual({ lowerBound: true, evalUnread: 1 });
			await settleSideSpend("run-1", path.join(dir, "gone.jsonl"), 0, false, true);
			expect(spendNote(run)).toEqual({ lowerBound: true, evalUnread: 2 });
			await settleSideSpend("run-1", file, 0, false, true);
			expect(spendNote(run)).toEqual({ lowerBound: true, evalUnread: 1 });
			await settleSideSpend("run-1", path.join(dir, "gone.jsonl"), 0, false, true);
			expect(mayMakeSideCalls("find", { pattern: "x" }, true)).toBe(false);
			expect(mayMakeSideCalls("eval", { code: "await completion('x')" }, true)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a call that may have made a side call keeps the total a floor until its entry is found; reading it lifts the floor", async () => {
		const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-spend-")));
		try {
			const file = path.join(dir, "session.jsonl");
			await writeFile(file, "");
			const run = start();
			await settleSideSpend("run-1", file, 0, true);
			expect(spendNote(run)).toEqual({ lowerBound: true, evalUnread: 1 });
			await appendFile(file, `${JSON.stringify({ type: "model_usage", purpose: "find", timestamp: "2026-11-20T09:10:00Z", usage: { cost: { total: 0.2 } } })}\n`);
			await settleSideSpend("run-1", file, 0, true);
			expect(run.costUsd).toBeCloseTo(0.2);
			expect(spendNote(run)).toEqual({ evalUsd: expect.closeTo(0.2) });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an unreadable session file leaves the total a floor; a call that cannot call a model and has no file says nothing", async () => {
		const run = start();
		await settleSideSpend("run-1", undefined, 0);
		expect(spendNote(run)).toBeUndefined();
		await settleSideSpend("run-1", "/nonexistent/session.jsonl", 0);
		expect(spendNote(run)).toEqual({ lowerBound: true, evalUnread: 1 });
		await settleSideSpend("run-1", undefined, 0, true);
		expect(spendNote(run)).toEqual({ lowerBound: true, evalUnread: 2 });
	});
});

describe("the surfaces say a floor is a floor", () => {
	test("the status counters, the closeout label and the spend phrase carry the mark only when it applies", () => {
		const whole = runRecord({ costUsd: 1.5 });
		const floor = runRecord({ costUsd: 1.5, spend: { lowerBound: true, evalUnread: 1 } });
		expect(runStatusCounters(whole, 0)).not.toContain("하한");
		expect(runStatusCounters(floor, 0)).toContain("하한");
		expect(spendText(whole)).not.toContain("하한");
		expect(spendText(floor)).toContain("하한");
		const brief = (run: ReturnType<typeof runRecord>) => closeoutBrief({ ...run, status: "done", endReason: "verified", endedAt: run.startedAt });
		// The one-row record of a short clean run names the spend only when it is a floor (it stays one row at 60 columns; the exact
		// figure is in `/storm status`); a card always does (tests/closeout.test.ts).
		expect(brief(whole).official.label).not.toContain("비용");
		expect(brief(floor).official.label).toContain("$1.50");
		expect(brief(floor).official.label).toContain("하한");
		// A run that spent nothing says nothing, and an old record has no note at all.
		expect(brief(runRecord({ costUsd: 0 })).official.label).not.toContain("비용");
	});
});
