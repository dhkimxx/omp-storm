import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { configHash } from "../src/config/canonical.ts";
import { turnAborted } from "../src/runtime/controller.ts";
import { activeLedgerRun, recordCost, resetLedger } from "../src/runtime/ledger.ts";
import { GOAL_NUDGE, MAX_NUDGES, modeRequest, STALL_MS } from "../src/runtime/modes.ts";
import { buildHandoff, buildLoopBody, readRun, runIds, runsDir } from "../src/runtime/run.ts";
import { readRunIndex } from "../src/runtime/run-index.ts";
import type { RunSpec, StormConfig } from "../src/types.ts";
import { type FakeSession, fakeModes, fakeSession, SESSION_TEAM, type SessionOptions, until } from "./fake-session.ts";

const config = SESSION_TEAM;

let root: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-modes-")));
});

afterEach(async () => {
	resetLedger();
	await rm(root, { recursive: true, force: true });
});

/** A session on the shared team, with a run budget when given. */
function harness({ budget, ...opts }: Omit<SessionOptions, "root" | "config"> & { budget?: StormConfig["budget"] } = {}): FakeSession {
	return fakeSession({ root, ...opts, ...(budget ? { config: { ...config, budget } } : {}) });
}

type Harness = FakeSession;

function start(h: Harness, spec: RunSpec): Promise<string> {
	return h.start(spec);
}

/** A refused start leaves nothing: no run, no ledger entry, no record, no message. */
async function expectRefused(h: Harness, spec: RunSpec): Promise<string> {
	const result = await h.controller.start(h.ctx, spec);
	expect(result.ok).toBe(false);
	expect(h.controller.directing()).toBe(false);
	expect(activeLedgerRun(h.repo.repoId)).toBeUndefined();
	expect(await runIds(root)).toEqual([]);
	expect(h.sent).toEqual([]);
	return result.ok ? "" : result.reason;
}

const GOAL = { mode: "goal", task: "make every test pass", tokenBudget: 500_000 } as const satisfies RunSpec;
const LOOP = { mode: "loop", task: "fix the tests", limit: { kind: "turns", turns: 3 }, condition: { command: "bun test", until: true } } as const satisfies RunSpec;
const HEAVY = { tokens: 200_000, contextWindow: 400_000, percent: 50 };

describe("mode requests", () => {
	test("a loop's count is total turns: omp gets one repeat fewer", () => {
		const prompt = buildLoopBody("run-1", LOOP.task);
		expect(modeRequest(LOOP, "run-1")).toEqual({ mode: "loop", action: "enter", prompt, limit: { kind: "iterations", iterations: 2 }, condition: { command: "bun test", until: true } });
		expect(modeRequest({ mode: "loop", task: LOOP.task, limit: { kind: "duration", durationMs: 600_000 } }, "run-1")).toEqual({ mode: "loop", action: "enter", prompt, limit: { kind: "duration", durationMs: 600_000 } });
		expect(modeRequest({ mode: "loop", task: LOOP.task }, "run-1")).toEqual({ mode: "loop", action: "enter", prompt });
	});

	test("what the loop repeats is the task inside the run's section: no omp keyword notice can attach to it", () => {
		const task = "workflowz: fix the tests\n  then orchestrate the release";
		const body = buildLoopBody("run-20261120-153012-a1b2", task);
		const lines = body.split("\n");
		expect(lines[0]).toBe('<storm-run id="run-20261120-153012-a1b2" repeat="true">');
		expect(lines.at(-1)).toBe("</storm-run>");
		expect(body).toContain(`\n${task}\n`);
		for (const keyword of ["workflowz", "orchestrate"]) {
			expect(containsMagicKeyword(task, keyword)).toBe(true);
			expect(containsMagicKeyword(body, keyword)).toBe(false);
		}
	});

	test("a goal carries its objective and budget; a resume carries nothing", () => {
		expect(modeRequest(GOAL, "run-1")).toEqual({ mode: "goal", action: "enter", objective: GOAL.task, tokenBudget: 500_000 });
		expect(modeRequest({ mode: "goal", task: "t" }, "run-1")).toEqual({ mode: "goal", action: "enter", objective: "t" });
		expect(modeRequest({ mode: "goal", resume: true }, "run-1")).toEqual({ mode: "goal", action: "resume" });
	});

	test("the handoff gains exactly one rule per mode and stays within its size", () => {
		const input = { runId: "run-1", config, hash: configHash(config), task: "t" };
		const lines = (mode?: "vibe" | "goal" | "loop") => buildHandoff({ ...input, ...(mode ? { mode } : {}) }).split("\n");
		expect(lines("vibe")).toEqual(lines());
		for (const mode of ["goal", "loop"] as const) {
			const added = lines(mode).filter(line => !lines().includes(line));
			expect(added).toHaveLength(1);
			expect(lines(mode).join("\n").length).toBeLessThanOrEqual(1400);
		}
		// The goal rule names the agent that checks the objective.
		expect(lines("goal").filter(line => !lines().includes(line))[0]).toContain("storm-reviewer");
	});
});

describe("start", () => {
	test("vibe: Storm's own run, omp's modes untouched", async () => {
		const h = harness();
		const runId = await start(h, { mode: "vibe", task: "t" });
		expect(h.modes?.requests).toEqual([]);
		expect(h.events).toEqual(["send"]);
		expect(await readRun(root, runId)).toMatchObject({ mode: "vibe", turns: 0, status: "running" });
		await h.controller.finish("shutdown");
	});

	test("goal: compaction, then omp's goal mode, then the handoff with the objective", async () => {
		const h = harness({ usage: HEAVY });
		const runId = await start(h, GOAL);
		expect(h.events).toEqual(["compact", "set:goal:enter", "send"]);
		expect(h.modes?.requests).toEqual([{ mode: "goal", action: "enter", objective: GOAL.task, tokenBudget: 500_000 }]);
		expect(h.sent[0]).toBe(buildHandoff({ runId, config, hash: configHash(config), task: GOAL.task, mode: "goal" }));
		expect(await readRun(root, runId)).toMatchObject({ mode: "goal", goal: { objective: GOAL.task, tokenBudget: 500_000 } });
		await h.controller.finish("shutdown");
	});

	test("loop: omp's loop mode gets the task in the run's section as its prompt, then the handoff starts the first turn", async () => {
		const h = harness();
		const runId = await start(h, LOOP);
		expect(h.events).toEqual(["set:loop:enter", "send"]);
		expect(h.modes?.requests).toEqual([modeRequest(LOOP, runId)]);
		expect(h.sent[0]).toBe(buildHandoff({ runId, config, hash: configHash(config), task: LOOP.task, mode: "loop" }));
		expect(await readRun(root, runId)).toMatchObject({ mode: "loop", loop: { limit: { kind: "turns", turns: 3 }, condition: { command: "bun test", until: true } } });
		await h.controller.finish("shutdown");
	});

	test("goal without text puts omp's paused or still active goal under a new run", async () => {
		const objective = "prepare the release";
		const h = harness({ modes: fakeModes({ pausedGoal: { objective, tokenBudget: 9000 } }) });
		const runId = await start(h, { mode: "goal", resume: true });
		expect(h.modes?.requests).toEqual([{ mode: "goal", action: "resume" }]);
		expect(h.sent[0]).toContain(objective);
		expect(await readRun(root, runId)).toMatchObject({ mode: "goal", task: objective, goal: { objective, tokenBudget: 9000 } });
		await h.controller.finish("shutdown");
		await rm(path.join(root, ".omp"), { recursive: true, force: true });
		// A goal restored active with the session: omp's resume leaves it as it is.
		const active = harness({ modes: fakeModes({ pausedGoal: { objective } }) });
		active.modes!.state.goal.status = "active";
		const second = await start(active, { mode: "goal", resume: true });
		expect(active.modes?.requests).toEqual([{ mode: "goal", action: "resume" }]);
		expect(await readRun(root, second)).toMatchObject({ mode: "goal", task: objective });
		await active.controller.finish("shutdown");
		await rm(path.join(root, ".omp"), { recursive: true, force: true });
		// No goal at all: nothing to resume, and omp is not asked.
		const none = harness();
		await expectRefused(none, { mode: "goal", resume: true });
		expect(none.modes?.requests).toEqual([]);
	});

	test("a start that fails after omp's mode is on ends as start-failed: mode left, no director state, ledger closed", async () => {
		// The run record cannot be written: a file sits where the runs directory belongs.
		await mkdir(path.dirname(runsDir(root)), { recursive: true });
		await writeFile(runsDir(root), "");
		for (const [spec, left] of [[GOAL, { mode: "goal", action: "pause" }], [LOOP, { mode: "loop", action: "exit" }]] as const) {
			const h = harness();
			await expectRefused(h, spec);
			expect(h.modes?.requests.at(-1)).toEqual(left);
			expect(h.modes?.requests).toHaveLength(2);
			expect(h.controller.refusal()).toBeUndefined();
			expect(h.controller.runId()).toBeUndefined();
		}
	});

	test("a late failure of an earlier run's handoff does not end the run that followed it", async () => {
		const first = Promise.withResolvers<void>();
		let sends = 0;
		const h = harness({ send: () => (++sends === 1 ? first.promise : Promise.resolve()) });
		await start(h, { mode: "vibe", task: "a" });
		await h.controller.finish("shutdown");
		const second = await start(h, GOAL);
		first.reject(new Error("session closed"));
		// The failure is reported and its run ended in the same step: once the notice is in, the outcome is too.
		await until(() => h.notices.some(n => n.level === "error"));
		expect(h.controller.runId()).toBe(second);
		expect(h.modes?.state.goal.status).toBe("active");
		expect(await readRun(root, second)).toMatchObject({ status: "running" });
		await h.controller.finish("shutdown");
	});
});

describe("start refusals", () => {
	test("no mode control in this host: a goal or loop may start as a vibe run, or not at all", async () => {
		for (const spec of [GOAL, LOOP]) {
			const accepted = harness({ modes: null, answers: [options => options[0]] });
			const runId = await start(accepted, spec);
			expect(accepted.ui.selects).toHaveLength(1);
			expect(accepted.ui.selects[0]?.options).toHaveLength(2);
			expect(await readRun(root, runId)).toMatchObject({ mode: "vibe", task: "task" in spec ? spec.task : "" });
			await accepted.controller.finish("shutdown");
			await rm(path.join(root, ".omp"), { recursive: true, force: true });

			// Declined, or a host that answers no dialog.
			for (const answer of [(options: string[]) => options[1], undefined]) {
				const declined = harness({ modes: null, answers: [answer] });
				await expectRefused(declined, spec);
			}
		}
		// A resume has no task to run freely.
		const resume = harness({ modes: null });
		await expectRefused(resume, { mode: "goal", resume: true });
		expect(resume.ui.selects).toEqual([]);
	});

	test("mode control disabled: the refusal names the setting to turn on", async () => {
		const h = harness({ modes: fakeModes({ fail: () => ({ code: "disabled", message: "Extension mode control is disabled in settings." }) }) });
		const reason = await expectRefused(h, GOAL);
		expect(reason).toContain("omp config set extensionHandlers.modeControl true");
		expect(h.events).toEqual(["set:goal:enter"]);
	});

	test("a conflict is refused with omp's own message", async () => {
		for (const spec of [GOAL, LOOP]) {
			const h = harness({ modes: fakeModes({ fail: () => ({ code: "conflict", message: "Exit plan mode first." }) }) });
			expect(await expectRefused(h, spec)).toBe("Exit plan mode first.");
		}
	});

	test("omp vibe mode active: it is left first when the user agrees, for any run mode", async () => {
		for (const spec of [{ mode: "vibe", task: "t" } as const, GOAL]) {
			const h = harness({ modes: fakeModes({ vibe: true }), answers: [options => options[0]] });
			await start(h, spec);
			expect(h.ui.selects).toHaveLength(1);
			expect(h.events.slice(0, 2)).toEqual(["select", "set:vibe:exit"]);
			expect(h.events.at(-1)).toBe("send");
			expect(h.modes?.state.vibe.status).toBe("inactive");
			await h.controller.finish("shutdown");
			await rm(path.join(root, ".omp"), { recursive: true, force: true });

			for (const answer of [(options: string[]) => options[1], undefined]) {
				const declined = harness({ modes: fakeModes({ vibe: true }), answers: [answer] });
				await expectRefused(declined, spec);
				expect(declined.modes?.requests).toEqual([]);
			}
		}
		// omp refuses the exit: nothing starts.
		const stuck = harness({ modes: fakeModes({ vibe: true, fail: () => ({ code: "busy", message: "busy" }) }), answers: [options => options[0]] });
		expect(await expectRefused(stuck, GOAL)).toBe("busy");
	});

	test("a loop while the user's loop.mode is reset is refused before omp is asked; other values start", async () => {
		const reset = harness({ loopMode: "reset" });
		const reason = await expectRefused(reset, LOOP);
		expect(reason).toContain("loop.mode");
		expect(reset.modes?.requests).toEqual([]);
		// The setting concerns loops only.
		const goal = harness({ loopMode: "reset" });
		await start(goal, GOAL);
		await goal.controller.finish("shutdown");
		await rm(path.join(root, ".omp"), { recursive: true, force: true });
		const compact = harness({ loopMode: "compact" });
		await start(compact, LOOP);
		await compact.controller.finish("shutdown");
	});
});

describe("goal run", () => {
	test("survives terminal agent_ends and ends exactly once when omp reports the goal complete", async () => {
		const h = harness();
		const runId = await start(h, GOAL);
		// The settle that started it, then three turns omp continues by itself.
		await h.controller.onAgentEnd({}, h.ctx);
		for (let i = 0; i < 3; i++) {
			await h.turn();
			expect(h.controller.directing()).toBe(true);
			await h.controller.onGoalUpdated({ status: "active", tokensUsed: 1000 * (i + 1) }, h.ctx);
		}
		// The fourth turn calls goal complete: the run ends with that turn, not in the middle of it.
		h.controller.onAgentStart();
		await h.controller.onGoalUpdated({ status: "complete", tokensUsed: 4200 }, h.ctx);
		expect(h.controller.directing()).toBe(true);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.controller.directing()).toBe(false);
		// omp's teardown afterwards changes nothing.
		if (h.modes) h.modes.state.goal.status = "inactive";
		await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
		await h.controller.onGoalUpdated(null, h.ctx);
		await h.controller.onAgentEnd({}, h.ctx);

		expect(await readRun(root, runId)).toMatchObject({ status: "done", mode: "goal", endReason: "goal-complete", turns: 4, goal: { tokensUsed: 4200 } });
		expect(await readRunIndex(root)).toMatchObject([{ runId, mode: "goal", turns: 4, endReason: "goal-complete" }]);
		expect(h.sent).toHaveLength(1);
		// Storm did not touch a goal omp ended itself.
		expect(h.modes?.requests).toHaveLength(1);
	});

	test("between turns the end is immediate: paused, budget-limited and dropped each end the run with their reason", async () => {
		const cases = [
			["paused", "goal-paused", "stopped"],
			["budget-limited", "goal-budget", "stopped"],
			["dropped", "goal-dropped", "stopped"],
		] as const;
		for (const [status, endReason, runStatus] of cases) {
			const h = harness();
			const runId = await start(h, GOAL);
			await h.turn();
			await h.controller.onGoalUpdated({ status, tokensUsed: 10 }, h.ctx);
			expect(h.controller.directing()).toBe(false);
			expect(await readRun(root, runId)).toMatchObject({ status: runStatus, endReason, turns: 1 });
			await rm(path.join(root, ".omp"), { recursive: true, force: true });
		}
	});

	test("the first reason given stands: omp's teardown after a completed goal does not turn it into a dropped one", async () => {
		const h = harness();
		const runId = await start(h, GOAL);
		h.controller.onAgentStart();
		await h.controller.onGoalUpdated({ status: "complete" }, h.ctx);
		// Still inside the turn, omp clears the goal and reports the mode change.
		h.modes!.state.goal.status = "inactive";
		await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
		await h.controller.onGoalUpdated(null, h.ctx);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", endReason: "goal-complete" });
	});

	test("a mode change alone ends it too: the goal paused or gone", async () => {
		for (const [goalStatus, endReason] of [["paused", "goal-paused"], ["inactive", "goal-dropped"]] as const) {
			const h = harness();
			const runId = await start(h, GOAL);
			await h.turn();
			h.modes!.state.goal.status = goalStatus;
			await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
			expect(await readRun(root, runId)).toMatchObject({ endReason });
			await rm(path.join(root, ".omp"), { recursive: true, force: true });
		}
		// A change that leaves the goal active ends nothing.
		const h = harness();
		await start(h, GOAL);
		await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
		expect(h.controller.directing()).toBe(true);
		await h.controller.finish("shutdown");
	});

	test("events of a goal do not end a vibe run", async () => {
		const h = harness();
		await start(h, { mode: "vibe", task: "t" });
		await h.controller.onGoalUpdated({ status: "complete" }, h.ctx);
		await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
		expect(h.controller.directing()).toBe(true);
		await h.controller.finish("shutdown");
	});

	test("session shutdown ends it as stopped and leaves omp's goal alone", async () => {
		const h = harness();
		const runId = await start(h, GOAL);
		await h.turn();
		await h.controller.finish("shutdown");
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "shutdown" });
		expect(h.modes?.state.goal.status).toBe("active");
	});

	test("a budget stop aborts the turn, pauses the goal and ends the run when that turn ends", async () => {
		const h = harness({ budget: { perRunUsd: 1, onExceed: "stop" } });
		const runId = await start(h, GOAL);
		h.controller.onAgentStart();
		recordCost(h.repo.repoId, "a/i", 2);
		expect(h.aborts()).toBe(1);
		expect(h.controller.directing()).toBe(true);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.modes?.requests.at(-1)).toEqual({ mode: "goal", action: "pause" });
		expect(await readRun(root, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget" });
	});

	test("a budget stop decided between turns ends the run at once: there is no turn to abort or wait for", async () => {
		const h = harness({ budget: { perRunUsd: 1, onExceed: "stop" } });
		const runId = await start(h, GOAL);
		await h.turn();
		// A late subagent message or a router side turn crosses the limit while the session is idle.
		recordCost(h.repo.repoId, "a/i", 2);
		await until(() => h.summaries() === 1);
		expect(h.aborts()).toBe(0);
		expect(h.controller.directing()).toBe(false);
		expect(h.clock.pending).toEqual([]);
		expect(h.modes?.requests.at(-1)).toEqual({ mode: "goal", action: "pause" });
		expect(await readRun(root, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget", turns: 1 });
	});

	test("omp refusing the pause is reported: the run ends, and the user knows the goal may go on", async () => {
		const refusal = "busy tearing the goal down";
		const modes = fakeModes({ fail: request => (request.mode === "goal" && request.action === "pause" ? { code: "busy", message: refusal } : undefined) });
		const h = harness({ modes, budget: { perRunUsd: 1, onExceed: "stop" } });
		const runId = await start(h, GOAL);
		h.controller.onAgentStart();
		recordCost(h.repo.repoId, "a/i", 2);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.notices.filter(n => n.level === "warning" && n.text.includes(refusal))).toHaveLength(1);
		expect(modes.state.goal.status).toBe("active");
		expect(await readRun(root, runId)).toMatchObject({ endReason: "budget" });
	});
});

describe("goal stall watchdog", () => {
	test("a turn that starts in time disarms it", async () => {
		const h = harness();
		await start(h, GOAL);
		await h.turn();
		expect(h.clock.pending.map(timer => timer.ms)).toEqual([STALL_MS]);
		h.controller.onAgentStart();
		expect(h.clock.pending).toEqual([]);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.clock.pending).toHaveLength(1);
		await h.controller.finish("shutdown");
		expect(h.clock.pending).toEqual([]);
	});

	test("no new turn: nudges up to the limit, then the goal is paused and the run ends as goal-stalled", async () => {
		const h = harness();
		const runId = await start(h, GOAL);
		await h.turn();
		for (let nudge = 1; nudge <= MAX_NUDGES; nudge++) {
			await h.clock.fire(() => h.sent.length === 1 + nudge);
			expect(h.sent).toHaveLength(1 + nudge);
			expect(h.sent.at(-1)).toBe(GOAL_NUDGE);
			expect(h.controller.directing()).toBe(true);
			// The nudge starts a turn that again ends without continuing.
			await h.turn();
		}
		await h.clock.fire(() => h.summaries() === 1);
		expect(h.sent).toHaveLength(1 + MAX_NUDGES);
		expect(h.modes?.requests.at(-1)).toEqual({ mode: "goal", action: "pause" });
		expect(h.controller.directing()).toBe(false);
		expect(h.notices.filter(n => n.level === "warning")).toHaveLength(1);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "goal-stalled", turns: 1 + MAX_NUDGES });
		expect(await readRunIndex(root)).toHaveLength(1);
		expect(h.clock.pending).toEqual([]);
	});

	test("a nudge that starts no turn is followed by the next one, not by silence", async () => {
		const h = harness();
		await start(h, GOAL);
		await h.turn();
		for (let i = 1; i <= MAX_NUDGES; i++) await h.clock.fire(() => h.sent.length === 1 + i);
		await h.clock.fire(() => h.summaries() === 1);
		expect(h.controller.directing()).toBe(false);
	});

	test("omp holding the continuation on purpose is no stall: nothing is sent or counted while it holds", async () => {
		const holds: Array<(h: Harness, on: boolean) => void> = [
			(h, on) => {
				h.hold.editor = on ? "the user is typing" : "";
			},
			(h, on) => {
				h.hold.busy = on;
			},
			(h, on) => {
				h.hold.pending = on;
			},
			(h, on) => {
				h.modes!.state.plan.status = on ? "active" : "inactive";
			},
		];
		for (const hold of holds) {
			const h = harness();
			await start(h, GOAL);
			await h.turn();
			hold(h, true);
			// More holds than the nudge limit: none of them counts.
			for (let i = 0; i <= MAX_NUDGES; i++) await h.clock.fire(() => h.clock.pending.length === 1);
			expect(h.sent).toHaveLength(1);
			expect(h.controller.directing()).toBe(true);
			hold(h, false);
			await h.clock.fire(() => h.sent.length === 2);
			expect(h.sent.at(-1)).toBe(GOAL_NUDGE);
			await h.controller.finish("shutdown");
			await rm(path.join(root, ".omp"), { recursive: true, force: true });
		}
	});

	test("a turn the goal starts by itself resets the nudge count", async () => {
		const h = harness();
		await start(h, GOAL);
		await h.turn();
		for (let nudge = 1; nudge <= MAX_NUDGES; nudge++) {
			await h.clock.fire(() => h.sent.length === 1 + nudge);
			await h.turn();
		}
		// omp continues the goal on its own once, then it stops again: that is a new stall, not the fourth nudge.
		await h.turn();
		await h.clock.fire(() => h.sent.length === 2 + MAX_NUDGES);
		expect(h.controller.directing()).toBe(true);
		expect(h.notices.filter(n => n.level === "warning")).toEqual([]);
		await h.controller.finish("shutdown");
	});

	test("it watches only an active goal after a settled turn", async () => {
		// Before the handoff turn began, and for vibe and loop runs, nothing is armed.
		const before = harness();
		await start(before, GOAL);
		await before.controller.onAgentEnd({}, before.ctx);
		expect(before.clock.pending).toEqual([]);
		await before.controller.finish("shutdown");
		await rm(path.join(root, ".omp"), { recursive: true, force: true });
		const loop = harness();
		await start(loop, LOOP);
		await loop.turn();
		expect(loop.clock.pending).toEqual([]);
		await loop.controller.finish("shutdown");
		await rm(path.join(root, ".omp"), { recursive: true, force: true });
		// A goal the user paused meanwhile is not nudged.
		const paused = harness();
		await start(paused, GOAL);
		await paused.turn();
		paused.modes!.state.goal.status = "paused";
		// Nothing is awaited on this path: the check returns before the timer callback does.
		await paused.clock.fire(() => true);
		expect(paused.clock.pending).toEqual([]);
		expect(paused.sent).toHaveLength(1);
		await paused.controller.finish("shutdown");
	});
});

describe("loop run", () => {
	test("survives each repeat's terminal agent_end and ends when omp's loop becomes inactive", async () => {
		const h = harness();
		const runId = await start(h, LOOP);
		await h.controller.onAgentEnd({}, h.ctx);
		for (let i = 0; i < 3; i++) await h.turn();
		expect(h.controller.directing()).toBe(true);
		h.modes!.state.loop.status = "inactive";
		await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
		expect(h.controller.directing()).toBe(false);
		await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
		expect(await readRun(root, runId)).toMatchObject({ status: "done", mode: "loop", endReason: "loop-ended", turns: 3 });
		expect(await readRunIndex(root)).toHaveLength(1);
		// Only the handoff was sent: omp repeats the prompt itself.
		expect(h.sent).toHaveLength(1);
	});

	test("a pause during a turn (Esc, a provider error) ends it as loop-paused once the turn is over, and exits omp's loop", async () => {
		const h = harness();
		const runId = await start(h, LOOP);
		h.controller.onAgentStart();
		h.modes!.state.loop.status = "paused";
		await h.controller.onModeChanged(h.modes!.snapshot(), h.ctx);
		expect(h.controller.directing()).toBe(true);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(await readRun(root, runId)).toMatchObject({ status: "stopped", endReason: "loop-paused", turns: 1 });
		// A paused loop would take the user's next message as its body and repeat it outside the run.
		expect(h.modes?.requests.at(-1)).toEqual({ mode: "loop", action: "exit" });
		expect(h.modes?.snapshot().loop.status).toBe("inactive");
	});

	test("a pause between turns exits omp's loop too; a loop that ended by itself is left alone", async () => {
		const paused = harness();
		await start(paused, LOOP);
		await paused.turn();
		paused.modes!.state.loop.status = "paused";
		await paused.controller.onModeChanged(paused.modes!.snapshot(), paused.ctx);
		expect(paused.controller.directing()).toBe(false);
		expect(paused.modes?.requests.at(-1)).toEqual({ mode: "loop", action: "exit" });
		await rm(path.join(root, ".omp"), { recursive: true, force: true });
		const ended = harness();
		await start(ended, LOOP);
		await ended.turn();
		ended.modes!.state.loop.status = "inactive";
		await ended.controller.onModeChanged(ended.modes!.snapshot(), ended.ctx);
		expect(ended.modes?.requests).toHaveLength(1);
	});

	test("a budget stop leaves omp's loop so nothing repeats after the run", async () => {
		const h = harness({ budget: { perRunUsd: 1, onExceed: "stop" } });
		const runId = await start(h, LOOP);
		h.controller.onAgentStart();
		recordCost(h.repo.repoId, "a/i", 2);
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.modes?.requests.at(-1)).toEqual({ mode: "loop", action: "exit" });
		expect(await readRun(root, runId)).toMatchObject({ status: "budget-exceeded", endReason: "budget" });
	});
});

describe("a run the tool queued", () => {
	test("with a mode it starts only at a terminal agent_end: no mode change inside the tool call or mid-turn", async () => {
		const h = harness();
		const queued = h.controller.request(GOAL);
		if (!queued.ok) throw new Error(queued.reason);
		expect(h.controller.refusal()).toBeDefined();
		await h.controller.onAgentEnd({ willContinue: true }, h.ctx);
		await h.controller.onAgentEnd({ awaitingAsyncWork: true }, h.ctx);
		expect(h.events).toEqual([]);
		expect(h.controller.directing()).toBe(false);

		await h.controller.onAgentEnd({}, h.ctx);
		await until(() => h.sent.length > 0);
		expect(h.events).toEqual(["set:goal:enter", "send"]);
		expect(h.controller.runId()).toBe(queued.runId);
		expect(await readRun(root, queued.runId)).toMatchObject({ mode: "goal", status: "running" });
		// During the run another request is refused.
		expect(h.controller.request({ mode: "vibe", task: "more" }).ok).toBe(false);
		await h.controller.finish("shutdown");
	});

	test("a queued start that omp refuses ends in a notice and nothing else", async () => {
		const h = harness({ modes: fakeModes({ fail: () => ({ code: "conflict", message: "Exit plan mode first." }) }) });
		h.controller.request(LOOP);
		await h.controller.onAgentEnd({}, h.ctx);
		await until(() => h.notices.length > 0);
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]?.level).toBe("warning");
		expect(h.notices[0]?.text).toContain("Exit plan mode first.");
		expect(h.sent).toEqual([]);
		expect(h.controller.refusal()).toBeUndefined();
	});

	test("the user interrupting the turn that queued it drops the run", async () => {
		const aborted = [{ role: "user" }, { role: "assistant", stopReason: "toolUse" }, { role: "toolResult" }, { role: "assistant", stopReason: "aborted" }];
		const h = harness();
		h.controller.request(GOAL);
		await h.controller.onAgentEnd({ messages: aborted }, h.ctx);
		expect(h.controller.refusal()).toBeUndefined();
		expect(h.notices).toHaveLength(1);
		// Nothing was left to start later.
		await h.controller.onAgentEnd({}, h.ctx);
		expect(h.events).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(h.controller.directing()).toBe(false);
	});

	test("only the turn's last assistant message says whether it was interrupted", () => {
		expect(turnAborted([{ role: "assistant", stopReason: "aborted" }])).toBe(true);
		expect(turnAborted([{ role: "assistant", stopReason: "aborted" }, { role: "user" }, { role: "assistant", stopReason: "stop" }])).toBe(false);
		expect(turnAborted([{ role: "assistant", stopReason: "stop" }, { role: "toolResult" }])).toBe(false);
		expect(turnAborted([{ role: "assistant", stopReason: "error" }])).toBe(false);
		expect(turnAborted([])).toBe(false);
		expect(turnAborted(undefined)).toBe(false);
		expect(turnAborted([null, "text", 7])).toBe(false);
	});
});
