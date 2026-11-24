import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContextEnv, invalidateAnalysis, loadUsageBetween, prepareAnalysis } from "../src/context.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import { updateTrialState } from "../src/runtime/state-files.ts";
import { trialViews } from "../src/runtime/views.ts";
import type { StormConfig, TrialConfig, UiPort } from "../src/types.ts";
import { createStatsDb, insertMessage } from "./stats-db.ts";
import { type ScriptedUi, scriptedUi } from "./support.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const START = new Date(2026, 10, 20, 12).getTime();

let tmp: string;
/** A valid session store for the trial counters these tests read and write. */
const trialSession = (): string => sessionStoreDir(join(tmp, "agent"), "trial");
let db: Database;
/** The injected clock. */
let now: number;
/** `omp` invocations by their arguments. */
let calls: string[][];
let notices: ScriptedUi["notices"];
/** What the fake `omp stats --summary` does: its exit code, after an optional side effect on the DB. */
let stats: { code: number; sync?: () => void };

let ui: UiPort;

function env(cwd = tmp): ContextEnv {
	return {
		cwd,
		agentDir: join(tmp, "agent"),
		ompBin: "omp",
		registry: { getAll: () => [], getAvailable: () => [] },
		now: () => now,
		statsDb: join(tmp, "stats.db"),
		exec: async (_command, args) => {
			calls.push(args);
			if (args[0] !== "stats") return { stdout: "{}", stderr: "", code: 0 };
			stats.sync?.();
			return { stdout: "", stderr: "", code: stats.code };
		},
	};
}

const statsRuns = (): number => calls.filter((args) => args[0] === "stats").length;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "storm-context-"));
	db = createStatsDb(join(tmp, "stats.db"));
	now = START;
	calls = [];
	({ ui, notices } = scriptedUi());
	stats = { code: 0 };
});

afterEach(() => {
	db.close();
	rmSync(tmp, { recursive: true, force: true });
});

describe("prepareAnalysis stats sync", () => {
	test("a recent newest row needs no sync", async () => {
		insertMessage(db, { timestamp: START - HOUR });
		const ctx = await prepareAnalysis(env(), ui);
		expect(statsRuns()).toBe(0);
		expect(ctx.usage.rows.map((r) => r.requests)).toEqual([1]);
	});

	test("an old newest row syncs once, re-reads, and is not synced again within 10 minutes", async () => {
		insertMessage(db, { timestamp: START - 7 * HOUR });
		stats.sync = () => insertMessage(db, { timestamp: START - 7 * HOUR + 1 });
		const first = await prepareAnalysis(env(join(tmp, "a")), ui);
		expect(statsRuns()).toBe(1);
		expect(calls.find((args) => args[0] === "stats")).toEqual(["stats", "--summary"]);
		expect(first.usage.rows.map((r) => r.requests)).toEqual([2]);

		// Still "old" (nobody used omp since), asked again from other projects so the context cache does not answer.
		now = START + 9 * MINUTE;
		await prepareAnalysis(env(join(tmp, "b")), ui);
		expect(statsRuns()).toBe(1);
		now = START + 10 * MINUTE;
		await prepareAnalysis(env(join(tmp, "c")), ui);
		expect(statsRuns()).toBe(2);
	});

	test("a failed sync keeps the old usage and warns; it is retried after 30 seconds, not before", async () => {
		insertMessage(db, { timestamp: START - 7 * HOUR });
		stats.code = 1;
		const ctx = await prepareAnalysis(env(join(tmp, "a")), ui);
		expect(ctx.usage.rows.map((r) => r.requests)).toEqual([1]);
		expect(notices.filter((n) => n.level === "warning")).toHaveLength(1);
		now = START + 29_000;
		await prepareAnalysis(env(join(tmp, "b")), ui);
		expect(statsRuns()).toBe(1);
		// The next read after that tries again, and a success is used at once.
		now = START + 30_000;
		stats = { code: 0, sync: () => insertMessage(db, { timestamp: START - HOUR }) };
		const later = await prepareAnalysis(env(join(tmp, "c")), ui);
		expect(statsRuns()).toBe(2);
		expect(later.usage.rows.map((r) => r.requests)).toEqual([2]);
	});

	test("an empty or missing history is not synced", async () => {
		await prepareAnalysis(env(join(tmp, "a")), ui);
		await prepareAnalysis({ ...env(join(tmp, "b")), statsDb: join(tmp, "absent.db") }, ui);
		expect(statsRuns()).toBe(0);
	});
});

describe("prepareAnalysis context cache", () => {
	test("the same project gets the same context for 2 minutes without running omp again", async () => {
		insertMessage(db, { timestamp: START - HOUR });
		const first = await prepareAnalysis(env(), ui);
		const ran = calls.length;
		expect(ran).toBeGreaterThan(0);
		now = START + 2 * MINUTE - 1;
		expect(await prepareAnalysis(env(), ui)).toBe(first);
		expect(calls.length).toBe(ran);

		now = START + 2 * MINUTE;
		const rebuilt = await prepareAnalysis(env(), ui);
		expect(rebuilt).not.toBe(first);
		expect(rebuilt.now).toBe(START + 2 * MINUTE);
		expect(calls.length).toBe(2 * ran);
	});

	test("two calls in flight share one build; another project builds its own", async () => {
		const [a, b] = await Promise.all([prepareAnalysis(env(), ui), prepareAnalysis(env(), ui)]);
		expect(a).toBe(b);
		const ran = calls.length;
		expect(await prepareAnalysis(env(join(tmp, "other")), ui)).not.toBe(a);
		expect(calls.length).toBe(2 * ran);
	});

	test("invalidateAnalysis drops one project's context, or all of them", async () => {
		const other = join(tmp, "other");
		const [a, b] = [await prepareAnalysis(env(), ui), await prepareAnalysis(env(other), ui)];
		invalidateAnalysis(tmp);
		expect(await prepareAnalysis(env(), ui)).not.toBe(a);
		expect(await prepareAnalysis(env(other), ui)).toBe(b);
		invalidateAnalysis();
		expect(await prepareAnalysis(env(other), ui)).not.toBe(b);
	});

	test("the same target in another profile does not share the cached context", async () => {
		insertMessage(db, { timestamp: START - HOUR });
		const first = await prepareAnalysis(env(), ui);
		const other: ContextEnv = { ...env(), agentDir: join(tmp, "other-agent") };
		const second = await prepareAnalysis(other, ui);
		expect(second).not.toBe(first);
		// Each profile keeps its own entry until a target-wide invalidation names the folder.
		expect(await prepareAnalysis(env(), ui)).toBe(first);
		invalidateAnalysis(tmp);
		expect(await prepareAnalysis(env(), ui)).not.toBe(first);
		expect(await prepareAnalysis(other, ui)).not.toBe(second);
	});

	test("a failed build is not cached", async () => {
		const broken: ContextEnv = { ...env(), registry: { getAll: () => { throw new Error("registry down"); }, getAvailable: () => [] } };
		await expect(prepareAnalysis(broken, ui)).rejects.toThrow("registry down");
		expect((await prepareAnalysis(env(), ui)).catalog).toEqual([]);
	});
});

describe("trial comparison", () => {
	const DAY = 24 * HOUR;
	const trial = (id: string, model: string, startsAt: number, endsAt: number): TrialConfig => ({
		id,
		role: "implementer",
		model,
		share: 0.5,
		maxSpawns: 5,
		startsAt: new Date(startsAt).toISOString(),
		endsAt: new Date(endsAt).toISOString(),
		budgetUsd: 1,
	});
	const config = (trials: TrialConfig[]): StormConfig => ({
		version: 1,
		priority: "balanced",
		roles: { implementer: { agent: "storm-implementer", models: ["anthropic/claude-a:high"] } },
		isolation: "shared",
		trials,
	});
	const subagent = (timestamp: number, model = "claude-a") => insertMessage(db, { timestamp, model, agent_type: "subagent" });

	test("each ended trial is measured over its own period", async () => {
		// Primary: one request before any trial, two in the first trial's week, three in the second's, one after both.
		for (const day of [-10, -6, -5, -2, -2, -1, 0.5]) subagent(START + day * DAY);
		subagent(START - 6 * DAY, "cand-1");
		subagent(START - 2 * DAY, "cand-2");
		// The newest row is later than both periods, so the DB needs no sync.
		now = START + DAY;
		const views = await trialViews(
			env(),
			trialSession(),
			config([
				trial("first", "anthropic/cand-1", START - 7 * DAY, START - 4 * DAY),
				trial("second", "anthropic/cand-2", START - 3 * DAY, START),
				trial("running", "anthropic/cand-3", START, START + 7 * DAY),
			]),
			now,
		);
		expect(views.map((v) => [v.trial.id, v.phase, v.endReason, v.comparison?.current.requests, v.comparison?.candidate.requests])).toEqual([
			["first", "ended", "time", 2, 1],
			["second", "ended", "time", 3, 1],
			["running", "active", undefined, undefined, undefined],
		]);
		expect(statsRuns()).toBe(0);
	});

	test("a trial that just ended syncs omp's stats first, so its last requests are counted", async () => {
		subagent(START - 2 * DAY);
		stats.sync = () => subagent(START - HOUR, "cand-1");
		const views = await trialViews(env(), trialSession(), config([trial("t", "anthropic/cand-1", START - 3 * DAY, START)]), now);
		expect(statsRuns()).toBe(1);
		expect(views[0]?.comparison?.candidate.requests).toBe(1);
		expect(views[0]?.comparison?.current.requests).toBe(1);
	});

	test("a trial that stopped early is measured up to the moment it stopped, not up to now", async () => {
		// The trial reached its spawn cap a day ago; the primary kept working afterwards.
		subagent(START - 2 * DAY);
		subagent(START - 2 * DAY, "cand-1");
		subagent(START - 2 * HOUR);
		subagent(START - HOUR);
		const early = config([trial("t", "anthropic/cand-1", START - 3 * DAY, START + 4 * DAY)]);
		const requests = async () => {
			const [view] = await trialViews(env(), trialSession(), early, now);
			return [view?.phase, view?.endReason, view?.comparison?.current.requests, view?.comparison?.candidate.requests];
		};
		await updateTrialState(trialSession(), "t", current => ({ ...current, seen: 10, routed: 5 }));
		// Counters that recorded no stop time (written before 0.10): the window runs to now.
		expect(await requests()).toEqual(["ended", "spawns", 3, 1]);
		await updateTrialState(trialSession(), "t", current => ({ ...current, stoppedAt: new Date(START - DAY).toISOString() }));
		expect(await requests()).toEqual(["ended", "spawns", 1, 1]);
	});

	test("loadUsageBetween reads [from, to] and syncs only when the DB ends before `to`", async () => {
		subagent(START - 3 * HOUR);
		subagent(START - HOUR);
		const inside = await loadUsageBetween(env(), START - 4 * HOUR, START - 2 * HOUR);
		expect(inside.rows.map((r) => r.requests)).toEqual([1]);
		expect(statsRuns()).toBe(0);
		await loadUsageBetween(env(), START - 4 * HOUR, START);
		await loadUsageBetween(env(), START - 4 * HOUR, START);
		expect(statsRuns()).toBe(1);
	});

	test("a sync from before a trial ended does not answer for it, however recent", async () => {
		// /storm synced at START; the trial ends 5 minutes later and the hub opens a minute after that.
		insertMessage(db, { timestamp: START - 7 * HOUR });
		await prepareAnalysis(env(), ui);
		expect(statsRuns()).toBe(1);
		const end = START + 5 * MINUTE;
		now = START + 6 * MINUTE;
		stats.sync = () => subagent(end - MINUTE, "cand-1");
		const views = await trialViews(env(), trialSession(), config([trial("t", "anthropic/cand-1", START - HOUR, end)]), now);
		expect(statsRuns()).toBe(2);
		expect(views[0]?.comparison?.candidate.requests).toBe(1);
		// That sync ran after the trial's end, so it keeps answering for it.
		await trialViews(env(), trialSession(), config([trial("t", "anthropic/cand-1", START - HOUR, end)]), now + HOUR);
		expect(statsRuns()).toBe(2);
	});
});
