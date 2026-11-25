import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@oh-my-pi/pi-tui";
import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme/theme";
import { agentRows, duration, renderAgentReport, renderAgentRows, tokens } from "../src/report/agents.ts";
import { roleTitle } from "../src/roles.ts";
import { bindLedgerChild, resetLedger, startLedgerRun } from "../src/runtime/ledger.ts";
import { RunLanes } from "../src/runtime/lanes.ts";
import { reviewEvidenceOf } from "../src/runtime/review.ts";
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
	noteRegistryAgent,
	noteVerdictTree,
	resetAgents,
} from "../src/runtime/agents.ts";
import type { AgentEntry, InfoLine, StormConfig } from "../src/types.ts";
import { RichFrame } from "../src/view/info.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

// The rich frame draws with omp's theme.
ensureThemeSync();

const T0 = Date.parse("2026-11-20T09:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;

/** Every write in this file is owned by one attested test session; explicit scopes still win in the sibling test. */
const LEDGER_SCOPE = "/profiles/test/storm/sessions/agents";
type StartInput = Omit<Parameters<typeof noteAgentStart>[0], "scope"> & { scope?: string };
type UsageInput = Omit<Parameters<typeof noteAgentUsage>[0], "scope"> & { scope?: string };
type EndInput = Omit<Parameters<typeof noteAgentEnd>[0], "scope"> & { scope?: string };
type RegistryInput = Omit<Parameters<typeof noteRegistryAgent>[0], "scope"> & { scope?: string };

const start = (input: StartInput): void => noteAgentStart({ ...input, scope: input.scope ?? LEDGER_SCOPE });
const usage = (input: UsageInput): void => noteAgentUsage({ ...input, scope: input.scope ?? LEDGER_SCOPE });
const end = (input: EndInput): void => noteAgentEnd({ ...input, scope: input.scope ?? LEDGER_SCOPE });
const run = (id: string, runId: string, scope = LEDGER_SCOPE): void => noteAgentRun(id, runId, scope);
const followUp = (id: string, scope = LEDGER_SCOPE): void => noteAgentFollowUp(id, scope);
const parked = (id: string, scope = LEDGER_SCOPE): void => noteAgentParked(id, scope);
const review = (id: string, input: unknown, now: number, scope = LEDGER_SCOPE): void => noteAgentReview(id, input, now, scope);
const verdictTree = (id: string, at: number, tree: string, scope = LEDGER_SCOPE): void => noteVerdictTree(id, at, tree, scope);
const change = (id: string, now: number, scope = LEDGER_SCOPE): void => noteAgentChange(id, now, scope);
const registry = (input: RegistryInput): void => noteRegistryAgent({ ...input, scope: input.scope ?? LEDGER_SCOPE });
const cleaned = (ids: readonly string[], now: number, scope = LEDGER_SCOPE): void => markAgentsCleaned(ids, now, scope);

describe("agent ledger", () => {
	beforeEach(resetAgents);

	test("start, usage and settle; later turns keep the entry and do not count as follow-ups", () => {
		start({ id: "A", name: "storm-implementer", parentId: "Main", role: "implementer", runId: "r1", now: T0 });
		usage({ id: "A", model: "anthropic/sonnet", promptTokens: 10_000, costUsd: 0.01, now: T0 + 1_000 });
		usage({ id: "A", model: "anthropic/sonnet", promptTokens: 12_000, costUsd: 0.02, now: T0 + 2_000 });
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
		end({ id: "A", now: T0 + 3_000, settled: false });
		expect(listAgents()[0]!.state).toBe("running");
		end({ id: "A", now: T0 + 4_000, settled: true });
		[a] = listAgents();
		expect(a).toMatchObject({ state: "idle", lastActivityAt: T0 + 4_000 });

		// A wake, a message turn or a revive is a turn, not a counted follow-up: those are the director's delivered writes.
		start({ id: "A", name: "storm-implementer", now: T0 + 60_000 });
		end({ id: "A", now: T0 + 70_000, settled: true });
		parked("A");
		expect(listAgents()[0]).toMatchObject({ state: "parked", lastActivityAt: T0 + 70_000 });
		start({ id: "A", name: "storm-implementer", now: T0 + 600_000 });
		expect(listAgents()[0]).toMatchObject({ state: "running", followUps: 0, role: "implementer", startedAt: T0 });
	});

	test("follow-ups count delivered writes, one each, however many turns the agent takes", () => {
		start({ id: "A", name: "storm-implementer", now: T0 });
		end({ id: "A", now: T0 + 1, settled: true });
		// 14 messages were sent in the 0.8 run and one was reported: every delivery counts.
		for (let i = 0; i < 14; i++) followUp("A");
		start({ id: "A", name: "storm-implementer", now: T0 + 2 });
		expect(listAgents()[0]!.followUps).toBe(14);
		followUp("Nobody");
		expect(listAgents()).toHaveLength(1);
	});

	test("an agent that takes a turn during a later run becomes that run's agent; a turn outside a run keeps its run", () => {
		start({ id: "A", name: "storm-implementer", runId: "r1", now: T0 });
		end({ id: "A", now: T0 + 1, settled: true });
		start({ id: "A", name: "storm-implementer", now: T0 + 2 });
		expect(listAgents({ runId: "r1" }).map(e => e.id)).toEqual(["A"]);
		start({ id: "A", name: "storm-implementer", runId: "r2", now: T0 + 3 });
		expect(listAgents({ runId: "r1" })).toEqual([]);
		expect(listAgents({ runId: "r2" }).map(e => e.id)).toEqual(["A"]);
	});

	test("noteAgentRun moves an entry to a run, starting its run-scoped fields over; the same run is a no-op", () => {
		start({ id: "A", name: "storm-implementer", role: "implementer", parentId: "Main", runId: "r1", now: T0 });
		change("A", T0 + 1_000);
		review("A", { data: { overall_correctness: "correct" } }, T0 + 2_000);
		run("A", "r1");
		expect(listAgents()[0]).toMatchObject({ runId: "r1", changes: 1, lastChangeAt: T0 + 1_000, lastVerdict: { at: T0 + 2_000, correct: true } });
		run("A", "r2");
		expect(listAgents({ runId: "r2" })[0]).toMatchObject({ id: "A", name: "storm-implementer", role: "implementer", parentId: "Main", state: "running" });
		expect(listAgents()[0]?.changes).toBeUndefined();
		expect(listAgents()[0]?.lastChangeAt).toBeUndefined();
		expect(listAgents()[0]?.lastVerdict).toBeUndefined();
		expect(listAgents()[0]?.review).toBeUndefined();
		run("X", "r2");
		expect(listAgents()).toHaveLength(1);
	});

	test("unknown ids are ignored", () => {
		usage({ id: "X", model: "a/b", promptTokens: 1, costUsd: 0, now: T0 });
		end({ id: "X", now: T0, settled: true });
		parked("X");
		expect(listAgents()).toEqual([]);
	});

	test("listing returns copies", () => {
		start({ id: "A", name: "task", now: T0 });
		listAgents()[0]!.state = "parked";
		expect(listAgents()[0]!.state).toBe("running");
	});

	test("ancestor filter follows parent links at any depth; run filter matches the run", () => {
		start({ id: "C1", name: "task", parentId: "Main", runId: "r1", now: T0 });
		start({ id: "G1", name: "task", parentId: "C1", now: T0 + 1 });
		start({ id: "GG1", name: "task", parentId: "G1", now: T0 + 2 });
		start({ id: "O1", name: "task", parentId: "Other", runId: "r2", now: T0 + 3 });
		start({ id: "Loop1", name: "task", parentId: "Loop2", now: T0 + 4 });
		start({ id: "Loop2", name: "task", parentId: "Loop1", now: T0 + 5 });
		const ids = (f: Parameters<typeof listAgents>[0]) => listAgents(f).map(e => e.id);
		expect(ids({ ancestorId: "Main" })).toEqual(["C1", "G1", "GG1"]);
		expect(ids({ ancestorId: "C1" })).toEqual(["G1", "GG1"]);
		expect(ids({ ancestorId: "Nobody" })).toEqual([]);
		expect(ids({ runId: "r1" })).toEqual(["C1"]);
		expect(ids({ runId: "r1", ancestorId: "Other" })).toEqual([]);
		expect(ids(undefined)).toHaveLength(6);
	});

	test("the same bare agent id in two owner sessions keeps separate spend, changes and ancestry", () => {
		const one = "/profiles/a/storm/sessions/one";
		const two = "/profiles/b/storm/sessions/two";
		start({ id: "Impl", name: "storm-implementer", parentId: "Main", scope: one, runId: "run-one", now: T0 });
		start({ id: "Impl", name: "storm-implementer", parentId: "Main", scope: two, runId: "run-two", now: T0 + 1 });
		start({ id: "Child", name: "task", parentId: "Impl", scope: one, now: T0 + 2 });
		start({ id: "Child", name: "task", parentId: "Impl", scope: two, now: T0 + 3 });

		usage({ id: "Impl", model: "a/i", promptTokens: 10, costUsd: 0.1, scope: one, now: T0 + 4 });
		usage({ id: "Impl", model: "b/i", promptTokens: 20, costUsd: 0.2, scope: two, now: T0 + 5 });
		change("Impl", T0 + 6, one);
		review("Impl", { data: { overall_correctness: "correct" } }, T0 + 7, one);

		const scopedOne = listAgents({ scope: one });
		const scopedTwo = listAgents({ scope: two });
		expect(scopedOne.map(entry => entry.id)).toEqual(["Impl", "Child"]);
		expect(scopedTwo.map(entry => entry.id)).toEqual(["Impl", "Child"]);
		expect(scopedOne[0]).toMatchObject({ runId: "run-one", requests: 1, changes: 1, model: "a/i" });
		expect(scopedTwo[0]).toMatchObject({ runId: "run-two", requests: 1, model: "b/i" });
		expect(scopedTwo[0]?.changes).toBeUndefined();
		expect(scopedTwo[0]?.review).toBeUndefined();
		expect(scopedOne[0]?.review?.reviews).toBe(1);
		// Ancestor links resolve inside one scope, never through the other session's same-named parent.
		expect(listAgents({ scope: one, ancestorId: "Impl" }).map(entry => entry.id)).toEqual(["Child"]);
		expect(listAgents({ scope: two, ancestorId: "Main" }).map(entry => entry.id)).toEqual(["Impl", "Child"]);
		expect(listAgents({ runId: "run-one" }).map(entry => entry.id)).toEqual(["Impl"]);
		// A late cleanup for one owner does not mark the other's same-id entry.
		cleaned(["Impl"], T0 + 8, one);
		expect(listAgents({ scope: one }).find(entry => entry.id === "Impl")?.cleanedAt).toBe(T0 + 8);
		expect(listAgents({ scope: two }).find(entry => entry.id === "Impl")?.cleanedAt).toBeUndefined();
	});

	test("a write without an attested scope creates no global unowned entry", () => {
		// @ts-expect-error the production API requires an attested owner session; unowned writes are refused.
		noteAgentStart({ id: "A", name: "task", now: T0 });
		// @ts-expect-error the production API requires an attested owner session; unowned writes are refused.
		noteAgentUsage({ id: "A", model: "a/b", promptTokens: 10, costUsd: 0.1, now: T0 });
		// A blank scope is not an owner either; the runtime guard refuses it even though the type accepts a string.
		noteAgentStart({ id: "A", name: "task", scope: "", now: T0 });
		expect(listAgents()).toEqual([]);
	});

	test("parked entries older than 24 h are dropped when a new agent arrives", () => {
		start({ id: "Old", name: "task", now: T0 });
		end({ id: "Old", now: T0, settled: true });
		parked("Old");
		start({ id: "IdleOld", name: "task", now: T0 });
		end({ id: "IdleOld", now: T0, settled: true });
		start({ id: "Recent", name: "task", now: T0 + 20 * HOUR });
		end({ id: "Recent", now: T0 + 20 * HOUR, settled: true });
		parked("Recent");
		start({ id: "New", name: "task", now: T0 + 25 * HOUR });
		expect(listAgents().map(e => e.id)).toEqual(["IdleOld", "Recent", "New"]);
	});

	test("markAgentsCleaned marks ledger entries", () => {
		start({ id: "A", name: "task", now: T0 });
		cleaned(["A", "Ghost"], T0 + 5);
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

describe("renderAgentReport", () => {
	const joined = (line: InfoLine) => line.spans.map(span => span.text).join("");
	const report = (rows: ReturnType<typeof agentRows>) => {
		const info: InfoLine[] = [];
		const md = renderAgentReport(rows, NOW, info);
		return { md, info, lines: md.split("\n") };
	};

	test("each agent is a stack of short rows, every one annotated with exactly its own text", () => {
		const rows = agentRows(
			[
				entry({ id: "0-Implementer-2", followUps: 3, changes: 4, review: { reviews: 2, passed: 1, failed: 1, findings: [0, 1, 0, 0] }, lastWorkFailed: true }),
				entry({ id: "1-Reviewer", role: "reviewer", state: "running", contextTokens: 151_000 }),
			],
			config,
		);
		const { md, info, lines } = report(rows);
		// No table: three status rows per agent plus one evidence row for the agent that left evidence.
		expect(md).not.toContain("|");
		expect(lines).toHaveLength(7);
		expect(info.map(line => line.index)).toEqual(lines.map((_, index) => index));
		for (const line of info) expect(joined(line)).toBe(lines[line.index]!);
		// Agents start a list item; their details are indented under it.
		expect(lines.filter(line => line.startsWith("- ")).map(line => line.split(" · ")[0])).toEqual(["- 0-Implementer-2", "- 1-Reviewer"]);
		expect(lines.filter(line => !line.startsWith("- ")).every(line => line.startsWith("  "))).toBe(true);
		// Korean role titles, the model and context against its cap, the follow-up verdict.
		expect(lines[0]).toContain(roleTitle("implementer"));
		expect(lines[1]).toContain(`anthropic/sonnet · 컨텍스트 ${tokens(30_000)}/${tokens(150_000)}`);
		expect(lines[2]).toContain("3회");
		expect(lines[4]).toContain(roleTitle("reviewer"));
		// The running agent reads as running; the one past its cap warns on its follow-up row.
		expect(info[4]!.spans.at(-1)?.tone).toBe("success");
		expect(info[6]!.spans.at(-1)?.tone).toBe("warning");
	});

	test("the evidence row names changes, review verdicts and a failed last turn, warning only on what needs attention", () => {
		const evidence = (over: Partial<AgentEntry>) => {
			const { lines, info } = report(agentRows([entry(over)], config));
			return lines.length === 4 ? { text: lines[3]!, spans: info[3]!.spans } : undefined;
		};
		expect(evidence({})).toBeUndefined();
		expect(evidence({ changes: 0, review: { reviews: 0, passed: 0, failed: 0, findings: [0, 0, 0, 0] } })).toBeUndefined();

		const clean = evidence({ changes: 2, review: { reviews: 1, passed: 1, failed: 0, findings: [0, 0, 0, 0] } })!;
		expect(clean.text).toBe("  파일 변경 2건 · 리뷰 1회: 통과 1 · 수정 필요 0");
		expect(clean.spans.some(span => span.tone === "warning")).toBe(false);

		const failing = evidence({ review: { reviews: 3, passed: 1, failed: 2, findings: [1, 0, 0, 0] }, lastWorkFailed: true })!;
		expect(failing.text).toBe("  리뷰 3회: 통과 1 · 수정 필요 2 · 마지막 작업 실패");
		expect(failing.spans.filter(span => span.tone === "warning").map(span => span.text)).toEqual([" · 수정 필요 2", "마지막 작업 실패"]);
	});

	test("at 60 columns long ids and model names wrap inside the frame where the table would not fit", () => {
		const rows = agentRows(
			[
				entry({ id: "0-Implementer-with-a-rather-long-generated-handle", model: "openrouter/anthropic/claude-sonnet-5-5-preview", contextTokens: 148_500 }),
				entry({ id: "1-Explorer", role: "explorer", state: "parked", lastActivityAt: NOW - 2 * HOUR }),
			],
			config,
		);
		expect(renderAgentRows(rows, NOW).split("\n").some(line => visibleWidth(line) > 60)).toBe(true);
		const { md, info } = report(rows);
		const frame = new RichFrame("서브에이전트", md, info).render(60);
		expect(frame.every(row => visibleWidth(row) <= 60)).toBe(true);
		// Read the content back across wrapped rows: no frame border, no padding, no break position assumed.
		const flat = frame.map(row => stripTerminalSequences(row)).join("").replace(/[\s\u2500-\u257f]/g, "");
		for (const shown of [
			"0-Implementer-with-a-rather-long-generated-handle",
			"openrouter/anthropic/claude-sonnet-5-5-preview",
			`${roleTitle("explorer")}·보관·유휴${duration(2 * HOUR)}`,
			`컨텍스트${tokens(148_500)}/${tokens(150_000)}`,
		]) expect(flat).toContain(shown.replace(/\s/g, ""));
	});

	test("control characters in an id or model cannot add rows or shift the annotations", () => {
		const { lines, info } = report(agentRows([entry({ id: "A\nB", model: "x/\u001b[31mred" })], config));
		expect(lines).toHaveLength(3);
		for (const line of info) expect(joined(line)).toBe(lines[line.index]!);
		expect(lines[0]).toContain("A\\u000aB");
		expect(lines.join("\n")).not.toContain("\u001b");
	});

	test("no agents: the same single line as the table, quietly", () => {
		const { md, info } = report([]);
		expect(md).toBe(renderAgentRows([], NOW));
		expect(info).toEqual([{ index: 0, spans: [{ text: md, tone: "muted" }] }]);
	});
});

describe("noteAgentReview", () => {
	beforeEach(() => resetAgents());

	test("accumulates a reviewer's yields on its own entry and ignores non-review yields", () => {
		start({ id: "Rev", name: "storm-reviewer", now: 0 });
		start({ id: "Impl", name: "storm-implementer", now: 0 });
		review("Impl", { data: { done: true } }, T0);
		review("Rev", { type: ["findings"], data: { priority: 0 } }, T0 + 1);
		review("Rev", { error: "x" }, T0 + 2);
		review("Rev", { data: { overall_correctness: "incorrect" } }, T0 + 3);
		review("Rev", { data: { overall_correctness: "correct" } }, T0 + 4);
		review("Ghost", { data: { overall_correctness: "correct" } }, T0 + 5);
		const [rev, impl] = listAgents();
		expect(rev?.review).toEqual({ reviews: 2, passed: 1, failed: 1, findings: [1, 0, 0, 0] });
		expect(impl?.review).toBeUndefined();
		expect(listAgents()).toHaveLength(2);
	});

	test("keeps the latest verdict with the time it was given; a findings section leaves it alone", () => {
		start({ id: "Rev", name: "storm-reviewer", now: T0 });
		review("Rev", { data: { overall_correctness: "incorrect" } }, T0 + 1_000);
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 1_000, correct: false });
		review("Rev", { type: ["findings"], data: { priority: 0 } }, T0 + 2_000);
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 1_000, correct: false });
		review("Rev", { data: { overall_correctness: "correct" } }, T0 + 3_000);
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 3_000, correct: true });
	});

	test("noteVerdictTree sets the matching verdict's tree and ignores an older time", () => {
		start({ id: "Rev", name: "storm-reviewer", now: T0 });
		review("Rev", { data: { overall_correctness: "correct" } }, T0 + 1_000);
		verdictTree("Rev", T0, "tree-0");
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 1_000, correct: true });
		verdictTree("Rev", T0 + 1_000, "tree-1");
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 1_000, correct: true, tree: "tree-1" });
		// A newer verdict is not given the tree of the one it replaced.
		review("Rev", { data: { overall_correctness: "incorrect" } }, T0 + 2_000);
		verdictTree("Rev", T0 + 1_000, "tree-2");
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 2_000, correct: false });
		verdictTree("Ghost", T0 + 2_000, "tree-3");
		expect(listAgents()).toHaveLength(1);
	});
});

describe("structured review evidence", () => {
	beforeEach(() => resetAgents());

	test("an incremental findings cycle and its verdict become one review, without body or log text", () => {
		start({ id: "Rev", name: "storm-reviewer", role: "reviewer", now: T0 });
		review("Rev", { type: ["findings"], data: { priority: 0, title: "x", body: "raw output" } }, T0 + 1_000);
		review("Rev", { data: { overall_correctness: "incorrect", findings: [{ priority: 1, kind: "code" }] } }, T0 + 2_000);
		const [rev] = listAgents();
		expect(reviewEvidenceOf(rev!)).toEqual({
			complete: true,
			records: [{ at: T0 + 2_000, correct: false, findings: [{ priority: 0 }, { priority: 1, kind: "code" }] }],
		});
	});

	test("a verdict's tree binds the review, and a later verdict keeps its own tree", () => {
		start({ id: "Rev", name: "storm-reviewer", role: "reviewer", now: T0 });
		review("Rev", { data: { overall_correctness: "correct" } }, T0 + 1_000);
		verdictTree("Rev", T0 + 1_000, "d1:f1");
		expect(reviewEvidenceOf(listAgents()[0]!)).toMatchObject({
			records: [{ at: T0 + 1_000, correct: true, tree: "d1:f1" }],
		});
		review("Rev", { data: { overall_correctness: "incorrect" } }, T0 + 2_000);
		verdictTree("Rev", T0 + 2_000, "d2:f2");
		expect(reviewEvidenceOf(listAgents()[0]!).records.map(record => record.tree)).toEqual(["d1:f1", "d2:f2"]);
		// An older time does not take the new verdict's tree.
		verdictTree("Rev", T0 + 1_000, "d3:f3");
		expect(listAgents()[0]?.lastVerdict).toEqual({ at: T0 + 2_000, correct: false, tree: "d2:f2" });
	});

	test("a new run clears the review evidence with the run-scoped fields", () => {
		start({ id: "Rev", name: "storm-reviewer", role: "reviewer", runId: "r1", now: T0 });
		review("Rev", { data: { overall_correctness: "correct" } }, T0 + 1_000);
		verdictTree("Rev", T0 + 1_000, "d1:f1");
		expect(reviewEvidenceOf(listAgents()[0]!).records).toHaveLength(1);
		run("Rev", "r2");
		expect(reviewEvidenceOf(listAgents()[0]!)).toEqual({ records: [], complete: true });
	});

	test("a bounded log drops no P0 silently: overflow makes the evidence incomplete", () => {
		start({ id: "Rev", name: "storm-reviewer", role: "reviewer", now: T0 });
		for (let i = 0; i < 70; i++) {
			review("Rev", { data: { overall_correctness: "incorrect", findings: [{ priority: 0 }] } }, T0 + i);
		}
		const ledger = reviewEvidenceOf(listAgents()[0]!);
		expect(ledger.records.length).toBeLessThanOrEqual(64);
		expect(ledger.complete).toBe(false);
	});
});

describe("noteAgentChange", () => {
	beforeEach(() => resetAgents());

	test("counts and dates changes on a known entry and ignores an unknown id", () => {
		start({ id: "A", name: "storm-implementer", now: T0 });
		change("A", T0 + 1_000);
		change("A", T0 + 2_000);
		change("Ghost", T0 + 3_000);
		expect(listAgents()).toHaveLength(1);
		expect(listAgents()[0]).toMatchObject({ changes: 2, lastChangeAt: T0 + 2_000, lastActivityAt: T0 + 2_000 });
	});

	test("another run starts the run-scoped fields over; the same run keeps them", () => {
		start({ id: "A", name: "storm-implementer", role: "implementer", runId: "r1", now: T0 });
		change("A", T0 + 1_000);
		review("A", { data: { overall_correctness: "correct" } }, T0 + 2_000);
		start({ id: "A", name: "storm-implementer", runId: "r1", now: T0 + 3_000 });
		expect(listAgents()[0]).toMatchObject({
			changes: 1,
			lastChangeAt: T0 + 1_000,
			lastVerdict: { at: T0 + 2_000, correct: true },
		});
		start({ id: "A", name: "storm-implementer", runId: "r2", now: T0 + 4_000 });
		const [a] = listAgents();
		expect(a?.runId).toBe("r2");
		expect(a?.changes).toBeUndefined();
		expect(a?.lastChangeAt).toBeUndefined();
		expect(a?.lastVerdict).toBeUndefined();
	});
});


describe("worker-homed agents", () => {
	beforeEach(() => {
		resetAgents();
		resetLedger();
		AgentRegistry.resetGlobalForTests();
	});
	afterEach(() => {
		resetAgents();
		resetLedger();
		AgentRegistry.resetGlobalForTests();
	});

	test("a launch with no requests cannot finish its lane; real session usage from the process registry can", () => {
		const run = startLedgerRun({
			runId: "run-homed",
			sessionId: "native-homed",
			sessionDir: "/profile/storm/sessions/homed",
			repoId: "repo",
			root: "/repo",
		});
		const team = teamOf({ quick: { models: ["a/q"], workers: { min: 1, max: 1 } } });
		const plan = {
			lanes: [{ name: "experiment", kind: "run" as const, role: "quick", files: ["experiment.txt"], isolationReason: "independent result" }],
			workers: { quick: 1 },
			submittedAt: "2026-01-01T00:00:00Z",
		};
		const work = new RunLanes(run.runId);
		const placed = work.assign({ agent: "storm-quick", task: "Run the experiment" }, plan, team, { host: { enabled: true, apply: false } });
		if (!placed.ok) throw new Error(placed.reason);
		const id = String(placed.input.name);
		expect(bindLedgerChild(run.runId, id, "Main", undefined)).toBe(true);
		expect(work.admit({ spawnKey: id, agent: "storm-quick", outcome: "routed" })).toBe("experiment");

		AgentRegistry.global().register({
			id,
			displayName: "storm-quick",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
			createdAt: T0,
			lastActivity: T0 + 1,
		});
		let [entry] = listAgents({ runId: run.runId });
		expect(entry).toMatchObject({ id, name: "storm-quick", role: "quick", runId: run.runId, state: "running", requests: 0, costUsd: 0 });
		expect(entry?.changes).toBeUndefined();
		// A launch is not completion: the lane stays pending with zero requests.
		expect(work.remaining(plan, listAgents({ runId: run.runId }), new Set())).toEqual(["experiment"]);

		AgentRegistry.global().setHistory(id, {
			agent: "storm-quick",
			metrics: { tokens: 220, requests: 2, tools: 1, cost: 0.01, durationMs: 500, durationKind: "active", contextTokens: 100 },
		});
		AgentRegistry.global().setStatus(id, "idle");
		[entry] = listAgents({ runId: run.runId });
		expect(entry).toMatchObject({ state: "idle", requests: 2, costUsd: 0.01, contextTokens: 100 });
		// The isolated change stays in the registry's patch artifact, never in the integrated-change ledger.
		expect(entry?.changes).toBeUndefined();
		expect(work.remaining(plan, listAgents({ runId: run.runId }), new Set())).toEqual([]);

		// An aborted host never settles the lane, even though its session had made requests.
		AgentRegistry.global().setStatus(id, "aborted");
		[entry] = listAgents({ runId: run.runId });
		expect(entry).toMatchObject({ state: "parked", lastWorkFailed: true });
		expect(work.remaining(plan, listAgents({ runId: run.runId }), new Set())).toEqual(["experiment"]);
	});

	test("child-session events outrank the registry; an aborted registry child never counts as settled work", () => {
		start({ id: "A", name: "storm-implementer", role: "implementer", runId: "r1", now: T0 });
		usage({ id: "A", model: "a/i", promptTokens: 10, costUsd: 0.01, now: T0 + 1 });
		registry({ id: "A", runId: "r1", name: "storm-implementer", status: "idle", startedAt: T0, lastActivityAt: T0 + 2, requests: 9, costUsd: 1 });
		expect(listAgents({ runId: "r1" })[0]).toMatchObject({ state: "running", requests: 1, costUsd: 0.01 });

		registry({ id: "B", runId: "r1", name: "storm-quick", status: "aborted", startedAt: T0, lastActivityAt: T0 + 3, requests: 2, costUsd: 0.02 });
		expect(listAgents({ runId: "r1" }).find(agent => agent.id === "B")).toMatchObject({ state: "parked", lastWorkFailed: true, requests: 2 });
	});
});
