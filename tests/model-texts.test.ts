import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseToolsFrontmatter } from "../src/policy/capability.ts";
import { ROLES } from "../src/roles.ts";
import { buildHandoff, DECIDE_BEFORE_STOP } from "../src/runtime/run.ts";
import {
	buildRoundMessage,
	type Gate,
	ROUND_RESULTS_CHECK,
	ROUND_STALLED,
	ROUND_STOP_CHECK,
	type ResultRemedy,
} from "../src/runtime/rounds.ts";
import type { RoleConfig, StormConfig } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";

const agentText = (name: string): string => readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8");
const body = (text: string): string => text.slice(text.indexOf("\n---", 3) + 4);

describe("agent definitions", () => {
	test("the tool lists: only the reviewer's changed, and it gained a shell and nothing that writes", () => {
		expect(parseToolsFrontmatter(agentText("storm-reviewer"))).toEqual(["read", "find", "grep", "glob", "ast_grep", "bash"]);
		for (const name of ["storm-explorer", "storm-architect"]) {
			expect(parseToolsFrontmatter(agentText(name))).toEqual(["read", "find", "grep", "glob", "ast_grep", "web_search"]);
		}
		expect(parseToolsFrontmatter(agentText("storm-implementer"))).toContain("bash");
		expect(parseToolsFrontmatter(agentText("storm-quick"))).not.toContain("eval");
	});

	test("the reviewer keeps the verdict contract Storm binds", () => {
		const text = agentText("storm-reviewer");
		expect(text).toContain("structured: true");
		for (const key of ["overall_correctness", "explanation", "confidence", "findings", "results", "receipt", "citation"]) {
			expect(text).toContain(key);
		}
		// A reviewer that changed files cannot verify: still said, and the shell is not offered as a way to change them.
		expect(body(text)).toMatch(/changed no files/);
	});

	test("the implementer and the quick worker may commit or push when the assignment says so, and no sentence forbids it outright", () => {
		for (const name of ["storm-implementer", "storm-quick"]) {
			const text = body(agentText(name));
			expect(text).not.toMatch(/\b(never|do not|don't)\s+(commit|push)/iu);
			const rule = text.split("\n").find(line => /commit/iu.test(line)) ?? "";
			expect(rule).toMatch(/push/u);
			expect(rule).toMatch(/assignment/u);
			// What stays bound is acting outside the assignment on one's own.
			expect(rule).toMatch(/on your own/u);
		}
	});

	test("the explorer, architect and quick definitions are no longer than before this change", () => {
		// Sizes before this change: explorer 1,024 B, architect 1,275 B, quick 1,270 B.
		expect(Buffer.byteLength(agentText("storm-explorer"))).toBeLessThanOrEqual(1_024);
		expect(Buffer.byteLength(agentText("storm-architect"))).toBeLessThanOrEqual(1_275);
		expect(Buffer.byteLength(agentText("storm-quick"))).toBeLessThanOrEqual(1_270);
	});
});

type Unverified = Extract<Gate, { state: "unverified" }>;
const unverified = (over: Partial<Unverified> = {}): Unverified => ({ state: "unverified", cause: "no-review", changes: 1, reviews: 0, requests: 0, ...over });
const round = (gate: Unverified, extra: { stalled?: number; max?: number } = {}): string =>
	buildRoundMessage({ runId: "run-7", round: 2, maxRounds: extra.max ?? 4, gate, reviewer: "storm-reviewer", ...(extra.stalled === undefined ? {} : { stalled: extra.stalled }) });

describe("round message decision points", () => {
	const causes: Unverified["cause"][] = ["no-review", "stale-review", "incorrect", "unbound", "no-proof", "p0", "coverage", "lanes"];

	test("every cause but an open result asks for the evidence behind the next stop, once, after the action", () => {
		for (const cause of causes) {
			const text = round(unverified({ cause }));
			expect(text.split(ROUND_STOP_CHECK)).toHaveLength(2);
			expect(text).not.toContain(ROUND_RESULTS_CHECK);
			expect(text.indexOf(ROUND_STOP_CHECK)).toBeGreaterThan(text.indexOf("Storm checked the run"));
		}
	});

	test("a round that begins with a result open asks for the cause to be read first, for every remedy", () => {
		const remedies: ResultRemedy[] = ["work", "replan", "review", "producer", "retry", "blocked"];
		for (const resultRemedy of remedies) {
			const text = round(unverified({ cause: "results", result: "r1", resultLane: "L1", resultState: "unmet", resultKind: "change", resultRemedy, resultBlockedBy: "P1" }));
			expect(text.split(ROUND_RESULTS_CHECK)).toHaveLength(2);
			expect(text).not.toContain(ROUND_STOP_CHECK);
			// The result and its lane are still named: the check is added to the action, it does not replace it.
			expect(text).toContain("`r1`");
		}
	});

	test("a stalled round names what to compare; it is added only after a round without progress", () => {
		const plain = round(unverified(), { stalled: 0 });
		const stalled = round(unverified(), { stalled: 1 });
		expect(plain).not.toContain(ROUND_STALLED);
		expect(stalled).toContain(ROUND_STALLED);
		expect(stalled.indexOf(ROUND_STALLED)).toBeGreaterThan(stalled.indexOf(ROUND_STOP_CHECK));
		expect(stalled.endsWith("</storm-run>")).toBe(true);
	});

	test("no round message forbids a rerun or a respawn that Storm itself would not refuse", () => {
		for (const cause of causes) expect(round(unverified({ cause }))).not.toMatch(/do not rerun|do not respawn|stop retrying|never (send|rerun)/iu);
		for (const resultRemedy of ["work", "replan", "review", "producer", "retry", "blocked"] as const) {
			const text = round(unverified({ cause: "results", result: "r1", resultLane: "L1", resultState: "unmet", resultKind: "change", resultRemedy, resultBlockedBy: "P1" }));
			expect(text).not.toMatch(/do not rerun|do not respawn|stop retrying|never (send|rerun)/iu);
		}
	});

	test("a round message with a decision point stays within its size bound", () => {
		for (const cause of causes) expect(round(unverified({ cause })).length).toBeLessThanOrEqual(480);
		expect(round(unverified({ cause: "no-review" }), { stalled: 1, max: 2 }).length).toBeLessThanOrEqual(600);
	});
});

describe("run contract", () => {
	const five: StormConfig = {
		...teamOf({}),
		isolation: "shared",
		roles: Object.fromEntries(ROLES.map((role): [string, RoleConfig] => [role.id, { agent: role.agent, models: [`p/${role.id}`] }])),
	};
	const base = { runId: "run-20261120-153012-a1b2", hash: `jcs-sha256:${"ab12".repeat(16)}`, task: "T", maxRounds: 4 };

	test("it carries the stop decision point and no rule about how to size or order the work", () => {
		for (const isolation of ["shared", "isolated"] as const) {
			const text = buildHandoff({ ...base, config: { ...five, isolation, budget: { perRunUsd: 5, onExceed: "block-spawns" } } });
			expect(text).toContain(DECIDE_BEFORE_STOP);
			expect(text).not.toMatch(/scope tiny|one lane|sequence|narrow/iu);
			expect(text.length).toBeLessThanOrEqual(1_400);
		}
	});

	test("the budget rule says what happens at the limit and no more: nothing new starts, and with stop the director's turn is aborted; no worker is said to be stopped", () => {
		const rule = (onExceed: "stop" | "block-spawns"): string =>
			buildHandoff({ ...base, config: { ...five, budget: { perRunUsd: 5, onExceed } } }).split("\n").find(line => line.includes("Budget:")) ?? "";
		expect(rule("block-spawns")).toContain("no new work starts");
		expect(rule("block-spawns")).not.toContain("aborted");
		expect(rule("stop")).toContain("no new work starts and your turn is aborted");
		for (const onExceed of ["stop", "block-spawns"] as const) {
			expect(rule(onExceed)).toContain("observed spend");
			expect(rule(onExceed)).not.toMatch(/the run stops|workers? (are|is) stopped|stops? (all|every|the workers)/iu);
		}
	});

	test("a resumed run is pointed at the run's status before it plans anything", () => {
		const text = buildHandoff({
			...base,
			config: five,
			resume: { runId: "run-20261119-090000-0ld0", endReason: "interrupted", turns: 2, checkpoint: { kept: 1, reopened: 1, blocked: 0 } },
		});
		expect(text).toContain("`storm status`");
		expect(text).not.toContain("Finish every open lane");
	});
});
