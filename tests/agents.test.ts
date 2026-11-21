import { beforeEach, describe, expect, test } from "bun:test";
import { agentRows, duration, renderAgentRows, tokens } from "../src/report/agents.ts";
import {
	listAgents,
	markAgentsCleaned,
	noteAgentChange,
	noteAgentEnd,
	noteAgentFollowUp,
	noteAgentParked,
	noteAgentReview,
	noteAgentRun,
	noteAgentStart,
	noteAgentUsage,
	resetAgents,
} from "../src/runtime/agents.ts";
import type { AgentEntry, StormConfig } from "../src/types.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

const T0 = Date.parse("2026-11-20T09:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;

describe("agent ledger", () => {
	beforeEach(resetAgents);

	test("start, usage and settle; later turns keep the entry and do not count as follow-ups", () => {
		noteAgentStart({ id: "A", name: "storm-implementer", parentId: "Main", role: "implementer", runId: "r1", now: T0 });
		noteAgentUsage({ id: "A", model: "anthropic/sonnet", promptTokens: 10_000, costUsd: 0.01, now: T0 + 1_000 });
		noteAgentUsage({ id: "A", model: "anthropic/sonnet", promptTokens: 12_000, costUsd: 0.02, now: T0 + 2_000 });
		let [a] = listAgents();
		expect(a).toMatchObject({
			id: "A",
			name: "storm-implementer",
			parentId: "Main",
			role: "implementer",
			runId: "r1",
			model: "anthropic/sonnet",
			state: "running",
			startedAt: T0,
			lastActivityAt: T0 + 2_000,
			contextTokens: 12_000,
			requests: 2,
			followUps: 0,
		});
		expect(a!.costUsd).toBeCloseTo(0.03);

		// A turn that does not settle (more turns follow) keeps the agent running.
		noteAgentEnd({ id: "A", now: T0 + 3_000, settled: false });
		expect(listAgents()[0]!.state).toBe("running");
		noteAgentEnd({ id: "A", now: T0 + 4_000, settled: true });
		[a] = listAgents();
		expect(a).toMatchObject({ state: "idle", lastActivityAt: T0 + 4_000 });

		// A wake, a message turn or a revive is a turn, not a counted follow-up: those are the director's delivered writes.
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 + 60_000 });
		noteAgentEnd({ id: "A", now: T0 + 70_000, settled: true });
		noteAgentParked("A");
		expect(listAgents()[0]).toMatchObject({ state: "parked", lastActivityAt: T0 + 70_000 });
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 + 600_000 });
		expect(listAgents()[0]).toMatchObject({ state: "running", followUps: 0, role: "implementer", startedAt: T0 });
	});

	test("follow-ups count delivered writes, one each, however many turns the agent takes", () => {
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 });
		noteAgentEnd({ id: "A", now: T0 + 1, settled: true });
		// 14 messages were sent in the 0.8 run and one was reported: every delivery counts.
		for (let i = 0; i < 14; i++) noteAgentFollowUp("A");
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 + 2 });
		expect(listAgents()[0]!.followUps).toBe(14);
		noteAgentFollowUp("Nobody");
		expect(listAgents()).toHaveLength(1);
	});

	test("an agent that takes a turn during a later run becomes that run's agent; a turn outside a run keeps its run", () => {
		noteAgentStart({ id: "A", name: "storm-implementer", runId: "r1", now: T0 });
		noteAgentEnd({ id: "A", now: T0 + 1, settled: true });
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 + 2 });
		expect(listAgents({ runId: "r1" }).map(e => e.id)).toEqual(["A"]);
		noteAgentStart({ id: "A", name: "storm-implementer", runId: "r2", now: T0 + 3 });
		expect(listAgents({ runId: "r1" })).toEqual([]);
		expect(listAgents({ runId: "r2" }).map(e => e.id)).toEqual(["A"]);
	});

	test("noteAgentRun moves an entry to a run, starting its run-scoped fields over; the same run is a no-op", () => {
		noteAgentStart({ id: "A", name: "storm-implementer", role: "implementer", parentId: "Main", runId: "r1", now: T0 });
		noteAgentChange("A", T0 + 1_000);
		noteAgentReview("A", { data: { overall_correctness: "correct" } }, T0 + 2_000);
		noteAgentRun("A", "r1");
		expect(listAgents()[0]).toMatchObject({ runId: "r1", changes: 1, lastChangeAt: T0 + 1_000, lastVerdict: { at: T0 + 2_000, correct: true } });
		noteAgentRun("A", "r2");
		expect(listAgents({ runId: "r2" })[0]).toMatchObject({ id: "A", name: "storm-implementer", role: "implementer", parentId: "Main", state: "running" });
		expect(listAgents()[0]?.changes).toBeUndefined();
		expect(listAgents()[0]?.lastChangeAt).toBeUndefined();
		expect(listAgents()[0]?.lastVerdict).toBeUndefined();
		noteAgentRun("X", "r2");
		expect(listAgents()).toHaveLength(1);
	});

	test("unknown ids are ignored", () => {
		noteAgentUsage({ id: "X", model: "a/b", promptTokens: 1, costUsd: 0, now: T0 });
		noteAgentEnd({ id: "X", now: T0, settled: true });
		noteAgentParked("X");
		expect(listAgents()).toEqual([]);
	});

	test("listing returns copies", () => {
		noteAgentStart({ id: "A", name: "task", now: T0 });
		listAgents()[0]!.state = "parked";
		expect(listAgents()[0]!.state).toBe("running");
	});

	test("ancestor filter follows parent links at any depth; run filter matches the run", () => {
		noteAgentStart({ id: "C1", name: "task", parentId: "Main", runId: "r1", now: T0 });
		noteAgentStart({ id: "G1", name: "task", parentId: "C1", now: T0 + 1 });
		noteAgentStart({ id: "GG1", name: "task", parentId: "G1", now: T0 + 2 });
		noteAgentStart({ id: "O1", name: "task", parentId: "Other", runId: "r2", now: T0 + 3 });
		noteAgentStart({ id: "Loop1", name: "task", parentId: "Loop2", now: T0 + 4 });
		noteAgentStart({ id: "Loop2", name: "task", parentId: "Loop1", now: T0 + 5 });
		const ids = (f: Parameters<typeof listAgents>[0]) => listAgents(f).map(e => e.id);
		expect(ids({ ancestorId: "Main" })).toEqual(["C1", "G1", "GG1"]);
		expect(ids({ ancestorId: "C1" })).toEqual(["G1", "GG1"]);
		expect(ids({ ancestorId: "Nobody" })).toEqual([]);
		expect(ids({ runId: "r1" })).toEqual(["C1"]);
		expect(ids({ runId: "r1", ancestorId: "Other" })).toEqual([]);
		expect(ids(undefined)).toHaveLength(6);
	});

	test("parked entries older than 24 h are dropped when a new agent arrives", () => {
		noteAgentStart({ id: "Old", name: "task", now: T0 });
		noteAgentEnd({ id: "Old", now: T0, settled: true });
		noteAgentParked("Old");
		noteAgentStart({ id: "IdleOld", name: "task", now: T0 });
		noteAgentEnd({ id: "IdleOld", now: T0, settled: true });
		noteAgentStart({ id: "Recent", name: "task", now: T0 + 20 * HOUR });
		noteAgentEnd({ id: "Recent", now: T0 + 20 * HOUR, settled: true });
		noteAgentParked("Recent");
		noteAgentStart({ id: "New", name: "task", now: T0 + 25 * HOUR });
		expect(listAgents().map(e => e.id)).toEqual(["IdleOld", "Recent", "New"]);
	});

	test("markAgentsCleaned marks ledger entries", () => {
		noteAgentStart({ id: "A", name: "task", now: T0 });
		markAgentsCleaned(["A", "Ghost"], T0 + 5);
		expect(listAgents()[0]!.cleanedAt).toBe(T0 + 5);
	});
});

const NOW = T0 + HOUR;

const entry = (over: Partial<AgentEntry> = {}): AgentEntry =>
	agentEntry({ id: "A", model: "anthropic/sonnet", startedAt: T0, lastActivityAt: NOW - MIN, contextTokens: 30_000, requests: 3, costUsd: 0.05, ...over });

const config: StormConfig = teamOf({ implementer: "anthropic/sonnet", quick: { models: ["mistral/small"], contextCap: 40_000 } }, { contextCap: 150_000 });

describe("agentRows", () => {
	test("the cap is the role's, else the team's, else the default; without a team the default", () => {
		const caps = (c: StormConfig | undefined) => agentRows([entry(), entry({ role: "quick" }), entry({ role: "ghost" })], c).map(r => r.cap);
		expect(caps(config)).toEqual([150_000, 40_000, 150_000]);
		const { contextCap: _cap, ...noTeamCap } = config;
		expect(caps(noTeamCap)).toEqual([200_000, 40_000, 200_000]);
		expect(caps(undefined)).toEqual([200_000, 200_000, 200_000]);
	});

	test("follow-up state is what enforcement uses: ok below the cap, cap from it on, cleaned whatever the context", () => {
		const states = agentRows(
			[
				entry({ contextTokens: 149_999 }),
				entry({ contextTokens: 150_000 }),
				entry({ contextTokens: 10, cleanedAt: NOW }),
				entry({ contextTokens: 900_000, cleanedAt: NOW }),
				entry({ role: "quick", contextTokens: 40_000 }),
				entry({ state: "running", contextTokens: 1 }),
			],
			config,
		).map(r => r.followUp);
		expect(states).toEqual(["ok", "cap", "cleaned", "cleaned", "cap", "ok"]);
	});

	test("rows keep the entries and their order", () => {
		const entries = [entry({ id: "B" }), entry({ id: "A" })];
		const rows = agentRows(entries, config);
		expect(rows.map(r => r.entry)).toEqual(entries);
	});
});

describe("renderAgentRows", () => {
	test("one table row per agent with its id, context and cap; no advice text after the table", () => {
		const rows = agentRows([entry({ id: "Impl|1", followUps: 3 }), entry({ id: "Rev", state: "running", contextTokens: 151_000 })], config);
		const lines = renderAgentRows(rows, NOW).split("\n");
		// Header, separator, one line per agent, nothing else.
		expect(lines).toHaveLength(4);
		expect(lines.every(l => l.startsWith("|") && l.endsWith("|"))).toBe(true);
		const columns = (line: string) => line.split(/(?<!\\)\|/).length;
		expect(new Set(lines.map(columns)).size).toBe(1);
		// A pipe in an id cannot break the table.
		expect(lines[2]).toContain("Impl\\|1");
		expect(lines[2]).toContain(`${tokens(30_000)}/${tokens(150_000)}`);
		expect(lines[2]).toContain(duration(MIN));
		expect(lines[3]).toContain(`${tokens(151_000)}/${tokens(150_000)}`);
		// The two rows differ in their follow-up verdict.
		expect(lines[2]!.split("|").at(-2)).not.toBe(lines[3]!.split("|").at(-2));
	});

	test("no agents: a single line, not a table", () => {
		const text = renderAgentRows([], NOW);
		expect(text.split("\n")).toHaveLength(1);
		expect(text).not.toContain("|");
	});

	test("tokens and duration formats", () => {
		expect([tokens(999), tokens(1_000), tokens(12_345)]).toEqual(["999", "1.0k", "12.3k"]);
		// Seconds, minutes and hours: the number is rounded per unit and each unit reads differently.
		const texts = [duration(30_000), duration(5 * MIN), duration(2 * HOUR), duration(1.5 * HOUR)];
		expect(texts.map(Number.parseFloat)).toEqual([30, 5, 2, 1.5]);
		expect(new Set(texts.map(text => text.replace(/[\d.]/g, ""))).size).toBe(3);
	});
});

describe("noteAgentReview", () => {
	beforeEach(() => resetAgents());

	test("accumulates a reviewer's yields on its own entry and ignores non-review yields", () => {
		noteAgentStart({ id: "Rev", name: "storm-reviewer", now: 0 });
		noteAgentStart({ id: "Impl", name: "storm-implementer", now: 0 });
		noteAgentReview("Impl", { data: { done: true } }, T0);
		noteAgentReview("Rev", { type: ["findings"], data: { priority: 0 } }, T0 + 1);
		noteAgentReview("Rev", { error: "x" }, T0 + 2);
		noteAgentReview("Rev", { data: { overall_correctness: "incorrect" } }, T0 + 3);
		noteAgentReview("Rev", { data: { overall_correctness: "correct" } }, T0 + 4);
		noteAgentReview("Ghost", { data: { overall_correctness: "correct" } }, T0 + 5);
		const [rev, impl] = listAgents();
		expect(rev?.review).toEqual({ reviews: 2, passed: 1, failed: 1, findings: [1, 0, 0, 0] });
		expect(impl?.review).toBeUndefined();
		expect(listAgents()).toHaveLength(2);
	});

	test("keeps the latest verdict with the time it was given; a findings section leaves it alone", () => {
		noteAgentStart({ id: "Rev", name: "storm-reviewer", now: T0 });
		noteAgentReview("Rev", { data: { overall_correctness: "incorrect" } }, T0 + 1_000);
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 1_000, correct: false });
		noteAgentReview("Rev", { type: ["findings"], data: { priority: 0 } }, T0 + 2_000);
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 1_000, correct: false });
		noteAgentReview("Rev", { data: { overall_correctness: "correct" } }, T0 + 3_000);
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 3_000, correct: true });
	});
});

describe("noteAgentChange", () => {
	beforeEach(() => resetAgents());

	test("counts and dates changes on a known entry and ignores an unknown id", () => {
		noteAgentStart({ id: "A", name: "storm-implementer", now: T0 });
		noteAgentChange("A", T0 + 1_000);
		noteAgentChange("A", T0 + 2_000);
		noteAgentChange("Ghost", T0 + 3_000);
		expect(listAgents()).toHaveLength(1);
		expect(listAgents()[0]).toMatchObject({ changes: 2, lastChangeAt: T0 + 2_000, lastActivityAt: T0 + 2_000 });
	});

	test("another run starts the run-scoped fields over; the same run keeps them", () => {
		noteAgentStart({ id: "A", name: "storm-implementer", role: "implementer", runId: "r1", now: T0 });
		noteAgentChange("A", T0 + 1_000);
		noteAgentReview("A", { data: { overall_correctness: "correct" } }, T0 + 2_000);
		noteAgentStart({ id: "A", name: "storm-implementer", runId: "r1", now: T0 + 3_000 });
		expect(listAgents()[0]).toMatchObject({
			changes: 1,
			lastChangeAt: T0 + 1_000,
			lastVerdict: { at: T0 + 2_000, correct: true },
		});
		noteAgentStart({ id: "A", name: "storm-implementer", runId: "r2", now: T0 + 4_000 });
		const [a] = listAgents();
		expect(a?.runId).toBe("r2");
		expect(a?.changes).toBeUndefined();
		expect(a?.lastChangeAt).toBeUndefined();
		expect(a?.lastVerdict).toBeUndefined();
	});
});
