import { describe, expect, test } from "bun:test";
import { agentRows, HUB_HINT, renderAgentReport, renderAgentRows } from "../src/report/agents.ts";
import { latestModelStop, modelStopLabel, newestModelStop } from "../src/report/model-stop.ts";
import { writeRun } from "../src/runtime/run.ts";
import { MODEL_CHANGE_CAUSES, modelMismatchNotice } from "../src/policy/model-check.ts";
import { userDirectedLine } from "../src/runtime/unplanned.ts";
import {
	admitUserTurn,
	isUserStop,
	registerUserTurnAdmitter,
	USER_INTERRUPT_LABEL,
	USER_TURN_NO_RUN,
	userOriginInputs,
	userStopDirectorNotice,
	userTurnDirectorNotice,
} from "../src/runtime/user-turn.ts";
import type { AgentEntry, InfoLine, SpawnRecord, StormConfig } from "../src/types.ts";
import { makeProject, TEAM } from "./support.ts";
import { runRecord } from "./fixtures.ts";

const assistant = { role: "assistant", content: [], stopReason: "stop", timestamp: 1 };

describe("which new input is the user's (S2)", () => {
	test("a hub prompt (attribution user) counts; a director steer, a peer message, an agent prompt and a synthetic one do not", () => {
		const messages = [
			{ role: "user", content: "old user prompt", attribution: "user", timestamp: 0 },
			assistant,
			{ role: "custom", customType: "irc:incoming", attribution: "agent", timestamp: 2 },
			{ role: "user", content: "steer", attribution: "agent", parentIrc: { from: "Main", body: "steer" }, timestamp: 3 },
			{ role: "user", content: "assignment", attribution: "agent", timestamp: 4 },
			{ role: "user", content: "continue", attribution: "user", synthetic: true, timestamp: 5 },
			{ role: "user", content: "do it this way", attribution: "user", timestamp: 6 },
		];
		// Only input after the worker's last answer is new; an earlier user prompt is history, not this request.
		expect(userOriginInputs(messages)).toEqual([6]);
		expect(userOriginInputs(messages.slice(0, 6))).toEqual([]);
		// A revive replays history and adds no input of its own.
		expect(userOriginInputs([{ role: "user", content: "x", attribution: "user", timestamp: 0 }, assistant])).toEqual([]);
	});
});

describe("asking the run's director", () => {
	test("no live run, or a run this thread does not hold, is read-only with the way on", async () => {
		expect(await admitUserTurn(undefined, { childId: "W", childName: "storm-implementer" })).toEqual({ kind: "read-only", reason: USER_TURN_NO_RUN });
		expect(await admitUserTurn("run-unknown", { childId: "W", childName: "storm-implementer" })).toEqual({ kind: "read-only", reason: USER_TURN_NO_RUN });
		expect(USER_TURN_NO_RUN).toContain("/storm");
		expect(USER_TURN_NO_RUN).toContain("새 워커");
	});

	test("the registered director decides, and a failing one leaves the turn read-only", async () => {
		const admit = async () => ({ kind: "admitted" as const, lane: "fix" });
		registerUserTurnAdmitter("run-a", admit);
		expect(await admitUserTurn("run-a", { childId: "W", childName: "n" })).toEqual({ kind: "admitted", lane: "fix" });
		registerUserTurnAdmitter("run-a", async () => {
			throw new Error("boom");
		});
		expect(await admitUserTurn("run-a", { childId: "W", childName: "n" })).toEqual({ kind: "read-only", reason: USER_TURN_NO_RUN });
	});

	test("the director's line names the lane and the transcript, never the body", () => {
		expect(userTurnDirectorNotice("fix", "W1")).toBe("사용자가 fix의 워커에게 직접 지시함 (history://W1)");
		expect(userTurnDirectorNotice(undefined, "W1")).toContain("계획 밖 워커 W1");
		expect(userStopDirectorNotice("fix", "W1")).toContain("판정 전");
	});
});

describe("a hub stop (S3)", () => {
	const aborted = (errorMessage: string) => [{ role: "user", content: "x", timestamp: 0 }, { role: "assistant", content: [], stopReason: "aborted", errorMessage, timestamp: 1 }];

	test("the user's interrupt counts only when Storm did not stop the worker itself", () => {
		expect(isUserStop(aborted(USER_INTERRUPT_LABEL), false)).toBe(true);
		// Storm's own stop (spend, model check, pooled thread) aborts with the same label.
		expect(isUserStop(aborted(USER_INTERRUPT_LABEL), true)).toBe(false);
		// The host's own budget, time or shutdown aborts carry other labels.
		expect(isUserStop(aborted("Request was aborted"), false)).toBe(false);
		expect(isUserStop([assistant], false)).toBe(false);
		expect(isUserStop([], false)).toBe(false);
	});
});

const entry = (over: Partial<AgentEntry>): AgentEntry => ({
	id: "W1",
	name: "storm-implementer",
	role: "implementer",
	state: "idle",
	startedAt: 0,
	lastActivityAt: 0,
	contextTokens: 0,
	requests: 0,
	costUsd: 0,
	followUps: 1,
	...over,
});

describe("what status, /storm agents and the closeout show", () => {
	test("/storm agents points every live row to the hub and counts the user's turns apart", () => {
		const info: InfoLine[] = [];
		const text = renderAgentReport(agentRows([entry({ userTurns: 2, userStops: 1 }), entry({ id: "W2", cleanedAt: 5 })]), 1_000, info);
		const lines = text.split("\n");
		expect(lines.filter(line => line.includes(HUB_HINT))).toHaveLength(1);
		expect(text).toContain("후속 지시 1회 · 사용자 지시 2회 · 사용자 정지 1회");
		// A cleaned worker has nothing left to focus in the hub.
		expect(lines.find(line => line.includes("정리됨"))).not.toContain(HUB_HINT);
		expect(renderAgentRows(agentRows([entry({ userTurns: 2 })]), 1_000)).toContain("| 1 · 사용자 지시 2회 |");
		expect(renderAgentRows(agentRows([entry({})]), 1_000)).not.toContain("사용자");
	});

	test("the closeout line sums user turns and stops, and says nothing when there were none", () => {
		expect(userDirectedLine({ agents: [entry({ userTurns: 1 }), entry({ id: "W2", userTurns: 2, userStops: 1 })] })).toBe("사용자 직접 지시 3회 · 사용자 정지 1회(판정 전 종료)");
		expect(userDirectedLine({ agents: [entry({})] })).toBeUndefined();
		expect(userDirectedLine({})).toBeUndefined();
	});
});

describe("a worker stopped for a model changed in the hub (I3)", () => {
	const spawn = (over: Partial<SpawnRecord>): SpawnRecord => ({ ts: "2026-11-28T00:00:00Z", agent: "storm-implementer", invocationKind: "task", requested: [], outcome: "routed", role: "implementer", ...over });
	const team: StormConfig = structuredClone(TEAM);

	test("the newest stop on what the role does not approve becomes the menu item; an approved or verified one does not", () => {
		const run = {
			spawns: [
				spawn({ ran: { model: "zz/old", verdict: "mismatch" } }),
				spawn({ ran: { model: "zz/new", effort: "high", verdict: "mismatch" } }),
				spawn({ ran: { model: "a/i", verdict: "verified" } }),
			],
		};
		const stop = latestModelStop(run, team);
		expect(stop).toEqual({ roleId: "implementer", model: "zz/new", effort: "high" });
		expect(modelStopLabel(stop!)).toContain("zz/new (high) 승인");
		expect(modelStopLabel(stop!).startsWith("역할 ")).toBe(true);
		// Approved since: the item is gone.
		const approved: StormConfig = structuredClone(team);
		approved.roles.implementer!.models = [...approved.roles.implementer!.models, "zz/new:high", "zz/old"];
		expect(latestModelStop(run, approved)).toBeUndefined();
		expect(latestModelStop(undefined, team)).toBeUndefined();
		const { role: _role, ...roleless } = spawn({ ran: { model: "zz/new", verdict: "mismatch" } });
		expect(latestModelStop({ spawns: [roleless] }, team)).toBeUndefined();
	});

	test("the stop notice names both changes (hub, later extension) and the menu step", () => {
		const text = modelMismatchNotice("storm-implementer", { ok: false, reason: "model", observed: "zz/new:high", approved: ["a/i"] }, "implementer");
		expect(text).toContain(MODEL_CHANGE_CAUSES);
		expect(MODEL_CHANGE_CAUSES).toContain("/model");
		expect(MODEL_CHANGE_CAUSES).toContain("/effort");
		expect(MODEL_CHANGE_CAUSES).toContain("나중에 불러온 확장");
		expect(text).toContain("/storm 메뉴의 '역할");
		expect(text).toContain("승인 창");
	});
});

describe("the /storm menu reads the stop from the newest run, live or finished (I3)", () => {
	test("a stop in a run that is still going is offered; an older finished run's stop does not stand in for it", async () => {
		const project = await makeProject();
		try {
			const ran = (model: string) => ({ ts: "2026-11-28T00:00:00Z", agent: "storm-implementer", invocationKind: "task" as const, requested: [], outcome: "routed" as const, role: "implementer", ran: { model, verdict: "mismatch" as const } });
			await writeRun(project.sessionDir, runRecord({ runId: "run-20261128-100000-aaaa", status: "done", spawns: [ran("zz/old")] }));
			// The live run (status running) is what the hub change happened in.
			await writeRun(project.sessionDir, runRecord({ runId: "run-20261128-110000-bbbb", status: "running", spawns: [ran("zz/live")] }));
			expect(await newestModelStop(project.sessionDir, TEAM)).toEqual({ roleId: "implementer", model: "zz/live" });
			const empty = await makeProject();
			try {
				expect(await newestModelStop(empty.sessionDir, TEAM)).toBeUndefined();
			} finally {
				await empty.remove();
			}
		} finally {
			await project.remove();
		}
	});
});
