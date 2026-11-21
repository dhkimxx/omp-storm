import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configHash } from "../src/config/canonical.ts";
import { tokens } from "../src/report/agents.ts";
import { directorRead, noteChildRead } from "../src/policy/reads.ts";
import { listAgents, noteAgentParked, noteAgentStart, resetAgents } from "../src/runtime/agents.ts";
import { noteRunSpawn, runSpawns, summarizeRun, touchRun } from "../src/runtime/controller.ts";
import { processKey, readTrustedRuns, recordTrustedRun } from "../src/runtime/janitor.ts";
import { activeLedgerRun, recordCost, resetLedger } from "../src/runtime/ledger.ts";
import { HOLD_MS, ROUND_DELAY_MS } from "../src/runtime/rounds.ts";
import { lastRun, readRun, runIds, runsDir, writeRun } from "../src/runtime/run.ts";
import { readRunIndex } from "../src/runtime/run-index.ts";
import type { ProjectState } from "../src/state.ts";
import type { AgentEntry, RunRecord, RunSpec, ShadowInfo, SpawnBlockCode, SpawnRecord, StormConfig } from "../src/types.ts";
import { fakeModes, fakeSession, SESSION_TEAM, type SessionOptions, until } from "./fake-session.ts";
import { agentEntry, approvedState, DEAD_PROCESS, runRecord, spawnRecord } from "./fixtures.ts";

const spawn = spawnRecord();
const agent = agentEntry;

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-controller-")));
});

afterEach(async () => {
	vi.useRealTimers();
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

const session = (opts: Omit<SessionOptions, "root"> = {}) => fakeSession({ root, ...opts });
const ask = (task: string): RunSpec => ({ task });
const usage = (tokens: number, percent: number, contextWindow = 400_000) => ({ tokens, contextWindow, percent });
const T0 = Date.parse("2026-11-20T09:00:00Z");
const writer = (over: Partial<AgentEntry> = {}): AgentEntry => agentEntry({ changes: 1, lastChangeAt: T0, ...over });
const verdict = (at: number, correct: boolean): AgentEntry =>
	agentEntry({ id: "Rev", name: "storm-reviewer", role: "reviewer", lastVerdict: { at, correct } });

describe("live run record", () => {
	// The live rewrite is debounced on a real timer: these two drive it with fake timers and wait only for the file.
	test("a running run is rewritten after spawns and spend: the record a crash leaves behind", async () => {
		const h = session({ agents: [agent()] });
		const runId = await h.start();
		expect((await readRun(root, runId))?.spawns).toEqual([]);

		vi.useFakeTimers();
		noteRunSpawn(runId, spawn);
		recordCost(h.repo.repoId, "a/i", 1.25);
		touchRun(runId);
		vi.runAllTimers();
		await until(async () => (await readRun(root, runId))?.updatedAt !== undefined);

		const live = await readRun(root, runId);
		expect(live).toMatchObject({ status: "running", costUsd: 1.25, spawns: [{ spawnKey: "Impl" }], agents: [{ id: "Impl" }] });
		await h.controller.finish("settled");
	});

	test("the final record is not overwritten by a pending live write, and a finished run takes no more of them", async () => {
		const h = session({ agents: [agent({ followUps: 2 })] });
		const runId = await h.start();
		vi.useFakeTimers();
		noteRunSpawn(runId, spawn);
		const final = await h.controller.finish("settled");
		touchRun(runId);
		vi.runAllTimers();

		const stored = await readRun(root, runId);
		expect(stored).toMatchObject({ status: "done", spawns: [{ spawnKey: "Impl" }], agents: [{ id: "Impl", followUps: 2 }] });
		expect(stored?.endedAt).toBe(final?.endedAt);
		expect(stored?.updatedAt).toBeUndefined();
		// The run's spawn list ended with it.
		expect(runSpawns(runId)).toEqual([]);
	});
});

describe("run start", () => {
	test("starts without asking: record written, ledger opened, one handoff carrying the task and the run id", async () => {
		const task = "fix the login bug";
		const h = session();
		const result = await h.controller.start(h.ctx, ask(task));
		if (!result.ok) throw new Error(result.reason);
		expect(h.controller.directing()).toBe(true);
		expect(h.controller.runId()).toBe(result.runId);
		expect(activeLedgerRun(h.repo.repoId)?.runId).toBe(result.runId);
		const record = await readRun(root, result.runId);
		expect(record).toMatchObject({ status: "running", configHash: configHash(SESSION_TEAM), task, process: processKey(), turns: 0 });
		expect(record?.limits).toBeUndefined();
		// Nothing of the retired keyword contract is written any more.
		expect(record && "contract" in record).toBe(false);
		expect(record && "approvalId" in record).toBe(false);
		expect(h.ui.selects).toEqual([]);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain(task);
		expect(h.sent[0]).toContain(result.runId);
		await h.controller.finish("settled");
	});

	test("the record keeps the limits the user stated with the request", async () => {
		const h = session();
		const runId = await h.start({ task: "t", rounds: 5, minutes: 30 });
		expect(await readRun(root, runId)).toMatchObject({ turns: 0, limits: { rounds: 5, minutes: 30 } });
		await h.controller.finish("settled");
		const one = session();
		const only = await one.start({ task: "t", minutes: 1 });
		expect((await readRun(root, only))?.limits).toEqual({ minutes: 1 });
		await one.controller.finish("settled");
	});

	test("a start is refused while omp's goal is active or its loop is on", async () => {
		for (const modes of [fakeModes({ goal: "active" }), fakeModes({ loop: "active" }), fakeModes({ loop: "paused" })]) {
			const h = session({ modes });
			const result = await h.controller.start(h.ctx, ask("t"));
			expect(result.ok).toBe(false);
			expect(h.sent).toEqual([]);
			expect(h.controller.directing()).toBe(false);
			expect(await runIds(root)).toEqual([]);
		}
	});

	test("a paused goal and a host without mode control still start", async () => {
		for (const modes of [fakeModes({ goal: "paused" }), null]) {
			const h = session({ modes });
			const runId = await h.start(ask("t"));
			expect((await readRun(root, runId))?.status).toBe("running");
			await h.controller.finish("shutdown");
		}
	});

	test("an active goal or loop refuses before asking to leave vibe", async () => {
		for (const modes of [fakeModes({ vibe: true, goal: "active" }), fakeModes({ vibe: true, loop: "active" })]) {
			const h = session({ modes, answers: [options => options[0]] });
			expect((await h.controller.start(h.ctx, ask("t"))).ok).toBe(false);
			expect(h.ui.selects).toEqual([]);
			expect(h.modes?.state.vibe.status).toBe("active");
			expect(h.sent).toEqual([]);
		}
	});

	test("omp vibe mode is left first when the user agrees; declining starts nothing", async () => {
		const h = session({ modes: fakeModes({ vibe: true }), answers: [options => options[0]] });
		await h.start(ask("t"));
		expect(h.ui.selects).toHaveLength(1);
		expect(h.events.slice(0, 2)).toEqual(["select", "set:vibe:exit"]);
		expect(h.modes?.state.vibe.status).toBe("inactive");
		await h.controller.finish("shutdown");
		for (const answer of [(options: string[]) => options[1], undefined]) {
			const declined = session({ modes: fakeModes({ vibe: true }), answers: [answer] });
			expect((await declined.controller.start(declined.ctx, ask("t"))).ok).toBe(false);
			expect(declined.sent).toEqual([]);
		}
	});

	test("the record keeps the first 200 characters of a long request; the handoff carries all of it", async () => {
		const task = "x".repeat(450);
		const h = session();
		const runId = await h.start(ask(task));
		expect((await readRun(root, runId))?.task).toHaveLength(200);
		expect(h.sent[0]).toContain(task);
		await h.controller.finish("settled");
	});

	test("a team that may not run starts nothing: no config, invalid, unapproved, another hash, an unapproved shadow", async () => {
		const shadow: ShadowInfo = { agent: "storm-reviewer", path: "/r/.omp/agents/rev.md", scope: "project", sha256: "1".repeat(64) };
		const broken: Array<(state: ProjectState) => ProjectState> = [
			s => ({ ...s, config: { status: "missing", path: "x" } }),
			s => ({ ...s, config: { status: "invalid", path: "x", errors: ["bad"] } }),
			s => ({ ...s, approval: undefined }),
			s => ({ ...s, approval: s.approval && { ...s.approval, configHash: `jcs-sha256:${"f".repeat(64)}` } }),
			s => ({ ...s, shadows: [shadow] }),
		];
		const reasons = new Set<string>();
		for (const state of broken) {
			const h = session({ state });
			const result = await h.controller.start(h.ctx, ask("task"));
			expect(result.ok).toBe(false);
			if (!result.ok) reasons.add(result.reason);
			expect(h.controller.directing()).toBe(false);
			expect(activeLedgerRun(h.repo.repoId)).toBeUndefined();
			expect(h.sent).toEqual([]);
			// The refusal is not sticky: nothing is left starting or queued.
			expect(h.controller.refusal()).toBeUndefined();
		}
		expect(await lastRun(root)).toBeUndefined();
		// Missing, invalid, unapproved (either way) and shadowed each say something different.
		expect(reasons.size).toBe(4);
	});

	test("one run per session and per project", async () => {
		const first = session();
		await first.start();
		expect((await first.controller.start(first.ctx, ask("again"))).ok).toBe(false);
		expect(first.controller.request(ask("again")).ok).toBe(false);
		const second = session();
		expect((await second.controller.start(second.ctx, ask("other session"))).ok).toBe(false);
		expect(second.sent).toEqual([]);
		expect(await runIds(root)).toHaveLength(1);
		await first.controller.finish("settled");
		expect((await second.controller.start(second.ctx, ask("other session"))).ok).toBe(true);
		await second.controller.finish("settled");
	});

	test("another session's run that starts while this one compacts wins: this start is refused and leaves nothing", async () => {
		const other = session();
		const h = session({ usage: usage(200_000, 50), compact: async () => void (await other.start()) });
		const result = await h.controller.start(h.ctx, ask("late"));
		expect(result.ok).toBe(false);
		expect(h.sent).toEqual([]);
		expect(h.controller.directing()).toBe(false);
		expect(await runIds(root)).toEqual([other.controller.runId() ?? ""]);
		await other.controller.finish("settled");
	});

	test("below both thresholds nothing is compacted; 150k tokens or half the window is heavy", async () => {
		const compactions = async (tokens: number, percent: number): Promise<number> => {
			const h = session({ usage: usage(tokens, percent) });
			await h.start();
			expect(h.sent).toHaveLength(1);
			await h.controller.finish("settled");
			return h.events.filter(event => event === "compact").length;
		};
		expect(await compactions(149_999, 49)).toBe(0);
		expect(await compactions(150_000, 10)).toBe(1);
		expect(await compactions(60_000, 50)).toBe(1);
		// No usage known (a fresh session): nothing to compact.
		const blind = session();
		await blind.start();
		expect(blind.events).toEqual(["send"]);
		await blind.controller.finish("settled");
	});

	test("a heavy context is compacted first: the size is announced, then the compaction, then the handoff", async () => {
		const seen: Array<{ notices: number; sent: number; directing: boolean; instructions: number }> = [];
		const h = session({
			usage: usage(160_000, 40),
			compact: async instructions => {
				seen.push({ notices: h.notices.length, sent: h.sent.length, directing: h.controller.directing(), instructions: instructions.length });
			},
		});
		await h.start();
		// One notice before the compaction, naming the size being compacted; nothing of the run exists yet.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ notices: 1, sent: 0, directing: false });
		expect(seen[0]?.instructions).toBeGreaterThan(0);
		expect(h.notices[0]?.text).toContain(tokens(160_000));
		expect(h.events).toEqual(["compact", "send"]);
		await h.controller.finish("settled");
	});

	test("a failed compaction is reported and the run starts anyway", async () => {
		const h = session({
			usage: usage(300_000, 75),
			compact: async () => {
				throw new Error("already compacting");
			},
		});
		const runId = await h.start();
		const warnings = h.notices.filter(n => n.level === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.text).toContain("already compacting");
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "running" });
		await h.controller.finish("settled");
	});

	test("a queued run starts detached from the agent_end handler: a slow compaction does not hold the handler", async () => {
		const compaction = Promise.withResolvers<void>();
		const task = "after the slow compaction";
		const h = session({ usage: usage(200_000, 50), compact: () => compaction.promise });
		const queued = h.controller.request(ask(task));
		if (!queued.ok) throw new Error(queued.reason);

		// omp gives the handler 30 s; it returns while the compaction is still running.
		await h.controller.onAgentEnd({}, h.ctx);
		await until(() => h.events.includes("compact"));
		expect(h.sent).toEqual([]);
		expect(h.controller.directing()).toBe(false);
		// The session settles again meanwhile (the compaction itself ends a loop): nothing starts twice, nothing ends.
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.request(ask("second")).ok).toBe(false);
		expect((await h.controller.start(h.ctx, ask("second"))).ok).toBe(false);

		compaction.resolve();
		await until(() => h.sent.length > 0);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]).toContain(task);
		expect(h.controller.runId()).toBe(queued.runId);
		expect(h.notices.some(n => n.level !== "info")).toBe(false);
		await h.controller.finish("settled");
	});

	test("a queued run waits for a terminal agent_end and starts exactly once", async () => {
		const h = session();
		const queued = h.controller.request(ask("queued"));
		if (!queued.ok) throw new Error(queued.reason);
		// Queued: a second request and a direct start are refused, and nothing has started.
		expect(h.controller.request(ask("second")).ok).toBe(false);
		expect((await h.controller.start(h.ctx, ask("second"))).ok).toBe(false);
		await h.controller.onAgentEnd({ willContinue: true }, h.ctx);
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		expect(h.sent).toEqual([]);
		expect(await runIds(root)).toEqual([]);

		await h.controller.onAgentEnd({}, h.ctx);
		await until(() => h.sent.length > 0);
		expect(h.controller.runId()).toBe(queued.runId);
		// Later settles before the handoff turn begins start nothing more and end nothing.
		await h.controller.onAgentEnd({}, h.ctx);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await runIds(root)).toEqual([queued.runId]);
		expect(h.notices.some(n => n.level !== "info")).toBe(false);
		expect(h.controller.directing()).toBe(true);
		await h.controller.finish("settled");
	});

	test("a detached start that is refused or throws ends in a notice, never in a silent nothing", async () => {
		const refused = session({ state: s => ({ ...s, approval: undefined }) });
		refused.controller.request(ask("task"));
		await refused.controller.onAgentEnd({}, refused.ctx);
		await until(() => refused.notices.length > 0);
		expect(refused.notices).toHaveLength(1);
		expect(refused.notices[0]?.level).toBe("warning");

		const failing = session({
			loadState: async () => {
				throw new Error("git is gone");
			},
		});
		failing.controller.request(ask("task"));
		await failing.controller.onAgentEnd({}, failing.ctx);
		await until(() => failing.notices.length > 0);
		expect(failing.notices[0]).toMatchObject({ level: "error" });
		expect(failing.notices[0]?.text).toContain("git is gone");
		// The failed start left nothing behind: the next request is accepted.
		expect(failing.controller.request(ask("again")).ok).toBe(true);
	});

	test("launch starts at once and reports a refusal the same way", async () => {
		const h = session();
		h.controller.launch(h.ctx, ask("direct"));
		await until(() => h.sent.length > 0);
		expect(h.controller.directing()).toBe(true);
		h.controller.launch(h.ctx, ask("second"));
		await until(() => h.notices.some(n => n.level === "warning"));
		expect(h.sent).toHaveLength(1);
		await h.controller.finish("settled");
	});

	test("a handoff that cannot be sent stops the run", async () => {
		const h = session({
			send: async () => {
				throw new Error("session closed");
			},
		});
		const runId = await h.start();
		await until(() => h.notices.some(n => n.level === "error"));
		await until(async () => (await readRun(root, runId))?.endReason === "start-failed");
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", turns: 0 });
		expect(h.controller.directing()).toBe(false);
		expect(activeLedgerRun(h.repo.repoId)).toBeUndefined();
		// The detached stop also appends the index line and prunes: let it finish before the directory goes.
		await until(async () => (await readRunIndex(root)).length === 1);
	});
});

describe("run end", () => {
	test("the run ends when the session settles after its handoff turn began, not before and not while work continues", async () => {
		const h = session();
		const runId = await h.start();
		// The settle that started the run: the handoff turn has not begun.
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(true);
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({ willContinue: true }, h.ctx);
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		expect(h.controller.directing()).toBe(true);
		// omp resumes a paused run with a new turn; its end is the round.
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(false);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", turns: 1, endReason: "settled" });
		expect(await readRunIndex(root)).toMatchObject([{ runId, turns: 1, endReason: "settled" }]);
	});

	test("a run ends once: one summary, one index line, the ledger closed, and later events change nothing", async () => {
		const h = session();
		const runId = await h.start();
		noteRunSpawn(runId, spawn);
		await h.turn();
		expect(h.summaries()).toBe(1);
		expect(h.ui.records[0]?.markdown).toBe(summarizeRun((await readRun(root, runId)) as RunRecord));
		expect(activeLedgerRun(h.repo.repoId)).toBeUndefined();
		const ended = (await readRun(root, runId))?.endedAt;

		await h.turn();
		await h.controller.onAgentEnd({}, h.ctx);
		expect(await h.controller.finish("shutdown")).toBeUndefined();
		expect(h.summaries()).toBe(1);
		expect(await readRunIndex(root)).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "settled", endedAt: ended as string });
		// The session is free again: the next request is taken.
		expect(h.controller.request(ask("next")).ok).toBe(true);
	});

	test("the read index lives as long as the run: a subagent's read counts during it and is forgotten after", async () => {
		const h = session();
		const runId = await h.start();
		const indexed = () => {
			noteChildRead(runId, "Impl", "notes.md", root);
			return directorRead({ runId, path: "notes.md", cwd: root })?.indexed;
		};
		expect(indexed()).toBe(true);
		await h.controller.finish("settled");
		expect(indexed()).toBe(false);
	});

	test("ending a run keeps the project's newest 50 run records", async () => {
		for (let n = 0; n < 55; n++) await writeRun(root, runRecord({ runId: `run-20261101-0000${String(n).padStart(2, "0")}-old0` }));
		const h = session();
		const runId = await h.start();
		await h.turn();
		const ids = await runIds(root);
		expect(ids).toHaveLength(50);
		expect(ids).toContain(runId);
		expect(ids).not.toContain("run-20261101-000000-old0");
	});

	test("a session shutdown ends the run as stopped, without a summary and without cleaning anything", async () => {
		let loads = 0;
		const state = approvedState(root, SESSION_TEAM);
		const h = session({
			loadState: async () => {
				loads++;
				return state;
			},
		});
		const runId = await h.start();
		expect(loads).toBe(1);
		await h.controller.finish("shutdown");
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "shutdown" });
		expect(h.summaries()).toBe(0);
		// The janitor needs the state in force; a shutdown does not wait for it.
		expect(loads).toBe(1);
	});

	test("a run past its budget ends as budget-exceeded, whatever ended it", async () => {
		const h = session({ config: { ...SESSION_TEAM, budget: { perRunUsd: 1, onExceed: "block-spawns" } } });
		const runId = await h.start();
		expect((await readRun(root, runId))?.budget).toEqual({ perRunUsd: 1, onExceed: "block-spawns" });
		recordCost(h.repo.repoId, "a/i", 0.5);
		expect(activeLedgerRun(h.repo.repoId)?.exceeded).toBe(false);
		recordCost(h.repo.repoId, "a/i", 0.5);
		expect(activeLedgerRun(h.repo.repoId)?.exceeded).toBe(true);
		expect(await h.controller.finish("settled")).toMatchObject({ status: "budget-exceeded", endReason: "settled", costUsd: 1 });
	});

	test("a team with doc consistency off records no doc findings", async () => {
		const review = { reviews: 1, passed: 0, failed: 1, findings: [0, 1, 0, 0] as [number, number, number, number], docFindings: 2 };
		const on = session({ agents: [agent({ review })] });
		await on.start();
		expect((await on.controller.finish("settled"))?.agents?.[0]?.review?.docFindings).toBe(2);
		const off = session({ config: { ...SESSION_TEAM, docs: false }, agents: [agent({ review })] });
		await off.start();
		const record = await off.controller.finish("settled");
		expect(record?.agents?.[0]?.review).toEqual({ reviews: 1, passed: 0, failed: 1, findings: [0, 1, 0, 0] });
	});
});

describe("round loop", () => {
	test("no writer: one round, settled, nothing sent besides the handoff", async () => {
		const h = session();
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "settled", turns: 1 });
	});

	test("a writer with no verdict gets round 2; a correct verdict after the change then verifies it", async () => {
		const agents = [writer()];
		const h = session({ agents });
		const runId = await h.start();
		await h.turn();
		expect(h.controller.directing()).toBe(true);
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="2/4">`);

		agents.push(verdict(T0 + 1, true));
		await h.turn();
		expect(h.sent).toHaveLength(2);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("an incorrect verdict and a round that changes and reviews nothing ends no-progress", async () => {
		const h = session({ agents: [writer(), verdict(T0 + 1, false)] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toContain('round="2/4"');
		await h.turn();
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "no-progress", turns: 2 });
	});

	test("config extra rounds: progress every round but no verdict ends on the round limit after two rounds", async () => {
		const agents = [writer()];
		const h = session({ config: { ...SESSION_TEAM, rounds: 1 }, agents });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toContain('round="2/2"');
		agents.push(writer({ id: "Impl2", lastChangeAt: T0 + 2 }));
		await h.turn();
		expect(h.sent).toHaveLength(2);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "round-limit", turns: 2 });
	});

	test("the request's own rounds limit of 1 ends the unverified first round at once", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start({ task: "t", rounds: 1 });
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "round-limit", turns: 1 });
	});

	test("the request's minutes limit is checked when a round ends", async () => {
		let clock = T0;
		const h = session({ now: () => clock, agents: [writer()] });
		const runId = await h.start({ task: "t", minutes: 10 });
		clock += 11 * 60_000;
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "time-limit", turns: 1 });
	});

	test("an aborted turn with unverified changes ends interrupted and sends nothing", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start();
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "interrupted", turns: 1 });
	});

	test("a held session waits: the delay look arms HOLD_MS until the draft is gone, and a turn clears the wait", async () => {
		const agents = [writer()];
		const h = session({ agents });
		await h.start();
		h.hold.editor = "draft";
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		// The first look is held: it arms the hold wait instead of sending.
		h.timers.fire();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([HOLD_MS]);
		// Still held: firing only arms the next look.
		h.timers.fire();
		expect(h.timers.delays()).toEqual([HOLD_MS]);
		expect(h.sent).toHaveLength(1);
		// The draft is gone: the same timer sends the round.
		h.hold.editor = "";
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.timers.pending()).toBe(0);
		expect(h.sent[1]?.split("\n")[0]).toContain('round="2/4"');

		// The next round's delay is pending; the turn that starts clears it.
		agents.push(writer({ id: "Impl2", lastChangeAt: T0 + 3 }));
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.controller.onAgentStart();
		expect(h.timers.pending()).toBe(0);
		await h.controller.finish("shutdown");
	});

	test("an unverified round waits out the delay: nothing is sent until the timer fires", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.timers.fire();
		await until(() => h.sent.length === 2);
		expect(h.sent[1]?.split("\n")[0]).toBe(`<storm-run id="${runId}" round="2/4">`);
		await h.controller.finish("shutdown");
	});

	test("a verdict that arrives before the timer fires is used: the run verifies, nothing is sent", async () => {
		const agents = [writer()];
		const h = session({ agents });
		const runId = await h.start();
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		agents.push(verdict(T0 + 1, true));
		h.timers.fire();
		await until(async () => (await readRun(root, runId))?.endReason === "verified");
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 1 });
	});

	test("a turn that starts before the timer fires clears it, and its end decides again", async () => {
		const agents = [writer()];
		const h = session({ agents });
		const runId = await h.start();
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		h.controller.onAgentStart();
		expect(h.timers.pending()).toBe(0);
		// The user's own turn ends: a round, decided from fresh evidence.
		agents.push(verdict(T0 + 1, true));
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
	});

	test("a round message that cannot be sent ends the run no-progress with a warning", async () => {
		const h = session({
			agents: [writer()],
			send: async text => {
				if (text.includes('round="2/4"')) throw new Error("session closed");
			},
		});
		const runId = await h.start();
		await h.turn();
		// The agent_end handler has returned; the rejection arrives from the send the timer started.
		h.timers.fire();
		await until(async () => (await readRun(root, runId))?.endReason === "no-progress");
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "no-progress", turns: 1 });
	});

	test("a round send that rejects after the run ended leaves the record alone", async () => {
		const send = Promise.withResolvers<void>();
		const h = session({
			agents: [writer()],
			send: async text => {
				if (text.includes('round="2/4"')) await send.promise;
			},
		});
		const runId = await h.start();
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		await h.controller.finish("shutdown");
		const ended = await readRun(root, runId);
		const summaries = h.summaries();
		const warnings = h.notices.filter(n => n.level === "warning").length;

		send.reject(new Error("session closed"));
		await until(() => h.notices.filter(n => n.level === "warning").length === warnings + 1);
		expect(h.summaries()).toBe(summaries);
		expect(await readRun(root, runId)).toEqual(ended);
	});

	test("a send that never settles does not hold the round or the next turn", async () => {
		const pending = Promise.withResolvers<void>();
		const agents = [writer()];
		const h = session({
			agents,
			send: async text => {
				if (text.includes('round="2/4"')) await pending.promise;
			},
		});
		const runId = await h.start();
		await h.turn();
		h.timers.fire();
		await until(() => h.sent.length === 2);
		// The next turn starts and settles while that send is still pending.
		agents.push(verdict(T0 + 1, true));
		await h.turn();
		await until(async () => (await readRun(root, runId))?.endReason === "verified");
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "verified", turns: 2 });
		pending.resolve();
	});

	test("a team whose reviewer role is disabled settles a writer's changes", async () => {
		const h = session({ config: { ...SESSION_TEAM, disabledRoles: ["reviewer"] }, agents: [writer()] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "settled", turns: 1 });
	});

	test("a run past a block-spawns budget with unverified changes ends budget and sends nothing", async () => {
		const h = session({
			config: { ...SESSION_TEAM, budget: { perRunUsd: 1, onExceed: "block-spawns" } },
			agents: [writer()],
		});
		const runId = await h.start();
		recordCost(h.repo.repoId, "a/i", 2);
		expect(activeLedgerRun(h.repo.repoId)?.exceeded).toBe(true);
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget", turns: 1 });
	});

	test("a quick agent's changes alone are nothing to verify", async () => {
		const h = session({ agents: [agentEntry({ role: "quick", changes: 2, lastChangeAt: T0 })] });
		const runId = await h.start();
		await h.turn();
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "settled", turns: 1 });
	});

	test("a streaming session, queued messages and plan mode each hold the round", async () => {
		for (const hold of [{ idle: false }, { pending: true }] as const) {
			const h = session({ agents: [writer()], hold });
			await h.start();
			await h.turn();
			h.timers.fire();
			expect(h.sent).toHaveLength(1);
			expect(h.timers.delays()).toEqual([HOLD_MS]);
			await h.controller.finish("shutdown");
		}
		const modes = fakeModes();
		modes.state.plan.status = "active";
		const planning = session({ agents: [writer()], modes });
		await planning.start();
		await planning.turn();
		planning.timers.fire();
		expect(planning.sent).toHaveLength(1);
		expect(planning.timers.delays()).toEqual([HOLD_MS]);
		await planning.controller.finish("shutdown");
	});

	test("a pending round wait dies with the run: shutdown and a budget stop between turns send nothing", async () => {
		for (const end of ["shutdown", "budget"] as const) {
			const h =
				end === "budget"
					? session({ config: { ...SESSION_TEAM, budget: { perRunUsd: 1, onExceed: "stop" } }, agents: [writer()] })
					: session({ agents: [writer()] });
			const runId = await h.start();
			await h.turn();
			expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
			if (end === "budget") recordCost(h.repo.repoId, "a/i", 2);
			else await h.controller.finish("shutdown");
			expect(h.controller.directing()).toBe(false);
			expect(h.timers.pending()).toBe(0);
			await until(async () => (await readRun(root, runId))?.status !== "running");
			expect(await readRun(root, runId)).toMatchObject({ status: end === "budget" ? "budget-exceeded" : "stopped", endReason: end });
			h.timers.fire();
			expect(h.sent).toHaveLength(1);
		}
	});
});

describe("interrupted waits", () => {
	test("Esc during an async wait ends the run interrupted and sends nothing", async () => {
		const h = session({ agents: [writer()] });
		const runId = await h.start();
		h.controller.onAgentStart();
		// omp pauses the run on the subagents; only their work can resume it.
		await h.controller.onAgentEnd({ willContinue: true, awaitingAsyncWork: true }, h.ctx);
		expect(h.controller.directing()).toBe(true);
		// Esc ends the paused run: no new turn and no assistant message marked aborted names it.
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(h.timers.pending()).toBe(0);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "interrupted", turns: 1 });
	});

	test("an async wait that resumes with a new turn decides as usual", async () => {
		const h = session({ agents: [writer()] });
		await h.start();
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		h.controller.onAgentStart();
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		expect(h.controller.directing()).toBe(true);
	});

	test("a prompt omp dropped because the user interrupted its setup ends interrupted, not no-progress", async () => {
		const h = session({
			agents: [writer()],
			send: async text => {
				if (!text.includes('round="2/4"')) return;
				const error = new Error("Prompt dropped before provider dispatch.");
				error.name = "PromptDroppedError";
				throw error;
			},
		});
		const runId = await h.start();
		await h.turn();
		h.timers.fire();
		await until(async () => (await readRun(root, runId))?.endReason === "interrupted");
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "interrupted", turns: 1 });
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(0);
	});
});

describe("run failures behind a timer", () => {
	/** Leaves the run records unwritable: a `finish` from a timer or a rejected send then throws. */
	const breakRecords = async (): Promise<void> => {
		await rm(runsDir(root), { recursive: true, force: true });
		await writeFile(runsDir(root), "not a directory");
	};

	test("a look that cannot end the run reports the failure instead of leaving a rejected promise", async () => {
		const agents = [writer()];
		const h = session({ agents });
		await h.start();
		await h.turn();
		agents.push(verdict(T0 + 1, true));
		await breakRecords();
		h.timers.fire();
		await until(() => h.notices.some(n => n.level === "error"));
		expect(h.controller.directing()).toBe(false);
	});

	test("a rejected round send whose stop fails reports both the warning and the error", async () => {
		const h = session({
			agents: [writer()],
			send: async text => {
				if (text.includes('round="2/4"')) throw new Error("session closed");
			},
		});
		await h.start();
		await h.turn();
		await breakRecords();
		h.timers.fire();
		await until(() => h.notices.some(n => n.level === "error"));
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(1);
	});
});

describe("budget", () => {
	const budget = (onExceed: "stop" | "block-spawns"): StormConfig => ({ ...SESSION_TEAM, budget: { perRunUsd: 2, warnAtUsd: 1, onExceed } });

	test("stop: the warning line only warns; the limit aborts the turn once and the run ends with it as budget-exceeded", async () => {
		const h = session({ config: budget("stop") });
		const runId = await h.start();
		h.controller.onAgentStart();
		recordCost(h.repo.repoId, "a/i", 1);
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(1);
		expect(h.aborts()).toBe(0);
		recordCost(h.repo.repoId, "a/i", 1);
		expect(h.aborts()).toBe(1);
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(2);
		// More spend while the aborted turn winds down does not abort again.
		recordCost(h.repo.repoId, "a/i", 1);
		expect(h.aborts()).toBe(1);
		expect(h.controller.directing()).toBe(true);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(false);
		expect(await readRun(root, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget", costUsd: 3 });
		expect(await readRunIndex(root)).toMatchObject([{ runId, status: "budget-exceeded" }]);
	});

	test("block-spawns: nothing is aborted and the run goes on to its own end", async () => {
		const h = session({ config: budget("block-spawns") });
		const runId = await h.start();
		h.controller.onAgentStart();
		recordCost(h.repo.repoId, "a/i", 5);
		expect(h.aborts()).toBe(0);
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(2);
		expect(h.controller.directing()).toBe(true);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(await readRun(root, runId)).toMatchObject({ status: "budget-exceeded", endReason: "settled" });
	});

	test("a stop during a turn with unverified changes ends budget, not the aborted turn's interruption", async () => {
		const h = session({ config: budget("stop"), agents: [writer()] });
		const runId = await h.start();
		h.controller.onAgentStart();
		recordCost(h.repo.repoId, "a/i", 2);
		expect(h.aborts()).toBe(1);
		// omp marks the aborted turn's last assistant message; without the end decided earlier it would read interrupted.
		await h.controller.onAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget", turns: 1 });
	});

	test("a stop between turns ends the run at once, before any next turn", async () => {
		const h = session({ config: budget("stop"), agents: [writer()] });
		const runId = await h.start();
		await h.turn();
		expect(h.timers.delays()).toEqual([ROUND_DELAY_MS]);
		recordCost(h.repo.repoId, "a/i", 2);
		expect(h.aborts()).toBe(0);
		expect(h.controller.directing()).toBe(false);
		expect(h.timers.pending()).toBe(0);
		await until(async () => (await readRun(root, runId))?.status === "budget-exceeded");
		expect(await readRun(root, runId)).toMatchObject({ endReason: "budget", turns: 1 });
	});

	test("without a budget no spend warns or aborts", async () => {
		const h = session();
		await h.start();
		recordCost(h.repo.repoId, "a/i", 1_000);
		expect(h.aborts()).toBe(0);
		expect(h.notices.some(n => n.level !== "info")).toBe(false);
		expect((await h.controller.finish("settled"))?.status).toBe("done");
	});
});

describe("run-end cleanup", () => {
	const NOW = Date.parse("2026-11-20T10:00:00.000Z");
	const cleaning: StormConfig = { ...SESSION_TEAM, cleanup: true };
	let agentDir: string;
	let artifacts: string;

	beforeEach(async () => {
		agentDir = path.join(root, "agent");
		artifacts = path.join(agentDir, "sessions", "proj", "sess");
		await mkdir(artifacts, { recursive: true });
		await writeFile(`${artifacts}.jsonl`, "");
	});

	const recordOf = (id: string) => path.join(artifacts, `${id}.jsonl`);

	/** Four earlier Storm runs on the trusted list, the oldest with one subagent whose omp record is on disk. */
	async function seedOlderRuns(storeDir: string, owner: string, id = "Old"): Promise<void> {
		await writeFile(recordOf(id), "transcript");
		await writeFile(path.join(artifacts, `${id}.md`), "output");
		for (let n = 1; n <= 4; n++) {
			await recordTrustedRun(storeDir, { runId: `run-old-${n}`, artifactsDir: artifacts, process: owner, agents: n === 1 ? [id] : [], endedAt: "t" });
		}
	}

	test("a finished run joins the trusted list with its artifacts dir, process and agents; a session without artifacts does not", async () => {
		const h = session({ agents: [agent({ id: "A" }), agent({ id: "B" })], artifactsDir: artifacts, agentDir, now: () => NOW });
		const runId = await h.start();
		expect((await readRun(root, runId))?.artifactsDir).toBe(artifacts);
		expect(await readTrustedRuns(h.state.store.dir)).toEqual([]);
		await h.turn();
		expect(await readTrustedRuns(h.state.store.dir)).toEqual([
			{ runId, artifactsDir: artifacts, process: processKey(), agents: ["A", "B"], endedAt: new Date(NOW).toISOString() },
		]);

		// A shutdown records the run too: its agents' records must be cleanable later.
		const closing = session({ artifactsDir: artifacts, agentDir });
		const closed = await closing.start();
		await closing.controller.finish("shutdown");
		expect((await readTrustedRuns(h.state.store.dir)).map(run => run.runId)).toEqual([runId, closed]);

		const bare = session({ agentDir });
		const unlisted = await bare.start();
		expect((await readRun(root, unlisted))?.artifactsDir).toBeUndefined();
		await bare.turn();
		expect((await readTrustedRuns(h.state.store.dir)).map(run => run.runId)).toEqual([runId, closed]);
	});

	test("with consent at start and at the end, an older run's parked agent loses its omp record and keeps its output", async () => {
		const h = session({ config: cleaning, artifactsDir: artifacts, agentDir, now: () => NOW });
		await seedOlderRuns(h.state.store.dir, DEAD_PROCESS);
		const runId = await h.start();
		await h.turn();
		expect(existsSync(recordOf("Old"))).toBe(false);
		expect(existsSync(path.join(artifacts, "Old.md"))).toBe(true);
		const record = await readRun(root, runId);
		expect(record?.cleanup).toMatchObject({ agents: 1, files: 1, bytes: "transcript".length });
		expect((await readRunIndex(root))[0]).toMatchObject({ runId });
		expect((await readTrustedRuns(h.state.store.dir))[0]?.cleaned).toEqual(["Old"]);
	});

	test("the approval in force when the run ends decides: consent withdrawn, or the team unapproved, mid-run deletes nothing", async () => {
		const withdrawn: Array<(state: ProjectState) => ProjectState> = [
			() => approvedState(root, SESSION_TEAM),
			() => approvedState(root, { ...cleaning, cleanup: false }),
			state => ({ ...state, approval: undefined }),
			state => ({ ...state, config: { status: "invalid", path: "x", errors: ["bad"] } }),
		];
		for (const atEnd of withdrawn) {
			const atStart = approvedState(root, cleaning);
			let current = atStart;
			const h = session({ config: cleaning, loadState: async () => current, artifactsDir: artifacts, agentDir });
			await seedOlderRuns(atStart.store.dir, DEAD_PROCESS);
			const runId = await h.start();
			current = atEnd(atStart);
			await h.turn();
			expect(existsSync(recordOf("Old"))).toBe(true);
			const record = await readRun(root, runId);
			expect(record?.status).toBe("done");
			expect(record?.cleanup?.agents ?? 0).toBe(0);
			await rm(atStart.store.dir, { recursive: true, force: true });
			await rm(path.join(root, ".omp"), { recursive: true, force: true });
		}
	});

	test("consent given only mid-run deletes nothing either: the run started without it", async () => {
		const atStart = approvedState(root, SESSION_TEAM);
		let current = atStart;
		const h = session({ loadState: async () => current, artifactsDir: artifacts, agentDir });
		await seedOlderRuns(atStart.store.dir, DEAD_PROCESS);
		await h.start();
		current = approvedState(root, cleaning);
		await h.turn();
		expect(existsSync(recordOf("Old"))).toBe(true);
	});

	test("without a known omp agent dir nothing of omp's is deleted", async () => {
		const h = session({ config: cleaning, artifactsDir: artifacts });
		await seedOlderRuns(h.state.store.dir, DEAD_PROCESS);
		await h.start();
		await h.turn();
		expect(existsSync(recordOf("Old"))).toBe(true);
	});

	test("agents of this process are judged by the process ledger: parked ones are cleaned and marked, live ones stay", async () => {
		noteAgentStart({ id: "Parked", name: "storm-implementer", now: 1 });
		noteAgentParked("Parked");
		noteAgentStart({ id: "Live", name: "storm-implementer", now: 1 });
		const h = session({ config: cleaning, artifactsDir: artifacts, agentDir, ledger: () => listAgents(), now: () => NOW });
		await seedOlderRuns(h.state.store.dir, processKey(), "Parked");
		await writeFile(recordOf("Live"), "transcript");
		await recordTrustedRun(h.state.store.dir, { runId: "run-old-1", artifactsDir: artifacts, process: processKey(), agents: ["Parked", "Live"], endedAt: "t" });
		await h.start();
		await h.turn();
		expect(existsSync(recordOf("Parked"))).toBe(false);
		expect(existsSync(recordOf("Live"))).toBe(true);
		const ledger = listAgents();
		expect(ledger.find(entry => entry.id === "Parked")?.cleanedAt).toBe(NOW);
		expect(ledger.find(entry => entry.id === "Live")?.cleanedAt).toBeUndefined();
	});

	test("a crashed earlier run of the project is closed as stopped when this one ends", async () => {
		const crashed = runRecord({ runId: "run-20261119-000000-dead", status: "running", process: DEAD_PROCESS, startedAt: "2026-11-19T00:00:00.000Z" });
		await writeRun(root, crashed);
		const h = session();
		await h.start();
		await h.turn();
		expect(await readRun(root, crashed.runId)).toMatchObject({ status: "stopped", endedAt: crashed.startedAt });
	});
});

describe("director counters", () => {
	test("count only while the run is active and land in the record", async () => {
		const h = session();
		h.controller.noteMainSpend(5);
		h.controller.noteBlockedEdit();
		h.controller.noteBlockedFollowUp();
		h.controller.noteBlockedRead();
		h.controller.noteRead(999, true);
		h.controller.noteMainContext(999_999);
		expect(h.controller.directing()).toBe(false);

		await h.start();
		h.controller.noteMainSpend(1.5);
		h.controller.noteMainSpend(0.5);
		h.controller.noteBlockedEdit();
		h.controller.noteBlockedFollowUp();
		h.controller.noteBlockedFollowUp();
		h.controller.noteMainContext(80_000);
		h.controller.noteMainContext(120_000);
		h.controller.noteMainContext(90_000);
		recordCost(h.repo.repoId, "a/i", 4);
		const record = await h.controller.finish("settled");
		expect(record).toMatchObject({ mainCostUsd: 2, blockedEdits: 1, blockedFollowUps: 2, costUsd: 4, maxMainContext: 120_000 });
		expect(record?.reads).toBeUndefined();
	});

	test("reads: calls, characters returned, the share a subagent had read too, and refusals, in the record and the index", async () => {
		const h = session();
		const runId = await h.start();
		h.controller.noteRead(3_000, false);
		h.controller.noteRead(6_500, true);
		h.controller.noteRead(500, true);
		h.controller.noteBlockedRead();
		const reads = { director: 3, directorChars: 10_000, duplicateChars: 7_000, blocked: 1 };
		expect(h.controller.active()?.reads).toEqual(reads);
		const record = await h.controller.finish("settled");
		expect(record?.reads).toEqual(reads);
		expect((await readRunIndex(root)).find(s => s.runId === runId)?.reads).toEqual(reads);
		// The summary carries the share that the 65% baseline is compared with.
		expect(record && summarizeRun(record)).toContain("70%");
	});

	test("a refused read alone still opens the counters", async () => {
		const h = session();
		await h.start();
		h.controller.noteBlockedRead();
		expect((await h.controller.finish("settled"))?.reads).toEqual({ director: 0, directorChars: 0, duplicateChars: 0, blocked: 1 });
	});

	test("a mid-run compaction is counted with its sizes; one omp refused leaves no trace and does not hold off the next", async () => {
		const at = Date.parse("2026-11-20T10:00:00.000Z");
		const h = session({ now: () => at });
		expect(h.controller.lastCheckpointAt()).toBeUndefined();
		// Without a run nothing is noted.
		h.controller.noteCheckpoint(1).done(1);
		await h.start();
		const refused = h.controller.noteCheckpoint(180_000);
		expect(h.controller.lastCheckpointAt()).toBe(at);
		refused.failed();
		expect(h.controller.lastCheckpointAt()).toBeUndefined();
		h.controller.noteCheckpoint(190_000).done(40_000);
		h.controller.noteCheckpoint(200_000).done(undefined);
		const record = await h.controller.finish("settled");
		expect(record?.checkpoints).toEqual([
			{ at: new Date(at).toISOString(), before: 190_000, after: 40_000 },
			{ at: new Date(at).toISOString(), before: 200_000 },
		]);
	});
});

describe("run summary", () => {
	const base = runRecord({ costUsd: 2, spawns: [spawn] });
	const numbers = (line: string | undefined): number[] => line?.match(/\d+/g)?.map(Number) ?? [];

	test("counts subagents, the reused ones and the follow-ups delivered to them", () => {
		const lines = summarizeRun({ ...base, agents: [agent({ followUps: 3 }), agent({ id: "Review", followUps: 1 }), agent({ id: "Scout" })] }).split("\n");
		// Run, spawns, subagents, reviews: the subagent line is the third.
		expect(lines).toHaveLength(4);
		expect(numbers(lines[2])).toEqual([3, 2, 4]);
	});

	test("blocked spawns are tallied by code, not quoted", () => {
		const blocked = (code: SpawnBlockCode): SpawnRecord => ({ ...spawn, outcome: "blocked", code, reason: "SECRET SENTENCE" });
		const text = summarizeRun({ ...base, spawns: [spawn, blocked("no-plan"), blocked("no-plan"), blocked("role-cap")] });
		expect(text).not.toContain("SECRET SENTENCE");
		// 1 routed, 3 blocked; then 2 of one code and 1 of another.
		expect(numbers(text.split("\n")[1])).toEqual([1, 3, 2, 1]);
	});

	test("stays within five lines when every line is present; the director line carries its numbers", () => {
		const run: RunRecord = {
			...base,
			mainCostUsd: 1,
			blockedEdits: 1,
			blockedFollowUps: 2,
			maxMainContext: 180_000,
			checkpoints: [{ at: "t", before: 1 }],
			reads: { director: 4, directorChars: 8_000, duplicateChars: 2_000, blocked: 3 },
			budget: { perRunUsd: 5, onExceed: "block-spawns" },
			cleanup: { agents: 2, files: 6, bytes: 2048, stormFiles: 1 },
			plan: {
				lanes: [
					{ name: "a", kind: "code", role: "implementer" },
					{ name: "b", kind: "code", role: "implementer" },
					{ name: "c", kind: "review", role: "reviewer" },
				],
				workers: { implementer: 2, reviewer: 1 },
				submittedAt: "2026-11-20T09:00:00.000Z",
			},
			spawns: [spawn, { ...spawn, outcome: "blocked", code: "parallelism", reason: "x" }],
			agents: [
				agent({ review: { reviews: 3, passed: 1, failed: 2, findings: [1, 0, 0, 0] } }),
				agent({ id: "Rev2", review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 2] } }),
			],
		};
		const lines = summarizeRun(run).split("\n");
		expect(lines).toHaveLength(5);
		expect(lines.every(l => l.startsWith("- "))).toBe(true);
		expect(lines[0]).toContain("run-1");
		expect(lines[0]).toContain("$2.00");
		expect(lines[0]).toContain("$5.00");
		// Lanes per role: 3 in all, 2 and 1.
		expect(numbers(lines[0]?.slice(lines[0].lastIndexOf("3")))).toEqual([3, 2, 1]);
		const director = lines[2] ?? "";
		for (const part of ["$1.00", "50%", "25%", "180.0k"]) expect(director).toContain(part);
		// A run without spawns has no review line.
		expect(summarizeRun({ ...run, spawns: [] }).split("\n")).toHaveLength(4);
	});

	test("a record written by 0.9 (call-counted reads, keyword contract) still summarizes", () => {
		const old = { ...base, contract: "workflowz", approvalId: "ap-1", reads: { director: 9, duplicate: 3, blocked: 2 } } as unknown as RunRecord;
		const lines = summarizeRun(old).split("\n");
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(lines.join("\n")).not.toContain("NaN");
	});

	test("turns and the end reason are on the first line; a 0.10 record's reason shows as written", () => {
		const first = (run: RunRecord) => summarizeRun(run).split("\n")[0] ?? "";
		expect(first({ ...base, turns: 7 })).toContain("7");
		expect(first({ ...base, turns: 8 })).toBe(first({ ...base, turns: 7 }).replace("7", "8"));
		// Records of 0.10 may carry a mode and reasons this version no longer has: it renders and shows the raw reason.
		const old = { ...base, status: "stopped", mode: "goal", turns: 7, endReason: "goal-complete", goal: { objective: "t" } } as unknown as RunRecord;
		const lines = summarizeRun(old).split("\n");
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(first(old)).toContain("goal-complete");
		expect(first(old)).toContain("7");
	});
});

describe("run plan", () => {
	const plan = { lanes: [{ name: "a", kind: "code" as const, role: "implementer" }], workers: { implementer: 1 }, submittedAt: "2026-11-20T09:00:00.000Z" };

	test("setPlan needs an active run; the plan reaches the ledger, the live record and the final record", async () => {
		const h = session();
		expect(h.controller.setPlan(plan)).toMatchObject({ ok: false });
		const runId = await h.start();
		expect(activeLedgerRun(h.repo.repoId)?.plan).toBeUndefined();
		expect(h.controller.setPlan(plan)).toEqual({ ok: true });
		expect(activeLedgerRun(h.repo.repoId)?.plan).toEqual(plan);
		expect(h.controller.active()?.plan).toEqual(plan);
		noteRunSpawn(runId, spawn);
		expect(runSpawns(runId)).toEqual([spawn]);
		const record = await h.controller.finish("settled");
		expect(record).toMatchObject({ plan });
		expect(activeLedgerRun(h.repo.repoId)).toBeUndefined();
	});
});
