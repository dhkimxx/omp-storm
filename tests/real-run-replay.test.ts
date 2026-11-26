/**
 * The acceptance test of the flow-fix wave: the director's real run of 2026-11-26 (14:16 to 15:03, a Gemma QAT trial
 * on a real project), replayed against the real run controller, lane gate, attempt collector and storm tool.
 *
 * The plans, task calls, follow-ups and deliveries are the director's own, in order and with their real gaps in time
 * (the first run's `events.jsonl`, trimmed to what the code reads: lane names, roles, files, edges, result ids, the
 * citation forms of each answer and when each job started and ended). Prose and criteria are shortened; the project
 * is a temporary folder holding only the files the answers cite. What the run showed then, and what is asserted now:
 *
 *   14:16:51 / 14:18:50 / 14:21:38  plan replies were silent about one-at-a-time writers and about isolation being off
 *   14:18:06 / 14:19:35 / 14:20:50  write refusals called a declared file list "not declared"
 *   14:22:17                        isolation refusal advised a setting and a path that did not fit
 *   14:26:51 / 14:30:50 / 14:40:27  results of follow-ups were discarded as replays (omp reuses the agent id as the job id)
 *   14:30:32 and after              the dependency refusal hid the ledger reason, said "running" for a finished worker
 *                                   and told the director to respawn the prerequisite
 *   14:22:17 .. 14:55:15            four messages into the running implementer left four open dispatches
 *   end of run                      every row with an open dispatch was rewritten, delivered answers included
 *
 * Tests assert behaviour: states, codes, which lanes a text names, what the ledger records. Set `REPLAY_TRANSCRIPT=1`
 * to print what Storm says at each moment.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lanePolicy, type LanePolicy, WHY_AUTO_WRITER } from "../src/policy/capability.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { resetAgents } from "../src/runtime/agents.ts";
import { AttemptCollector } from "../src/runtime/attempt-collector.ts";
import { ATTEMPT_REF } from "../src/runtime/attempt-report.ts";
import { resetCloseoutChoices } from "../src/runtime/closeout.ts";
import { resetLedger } from "../src/runtime/ledger.ts";
import { RunLanes } from "../src/runtime/lanes.ts";
import { readRun } from "../src/runtime/run.ts";
import { type StormToolHost } from "../src/tool/host.ts";
import { runStormTool, type StormToolInput } from "../src/tool/storm-tool.ts";
import type { AgentEntry, PlanLane, RunPlan, RunResult } from "../src/types.ts";
import { resultProgress } from "../src/view/results.ts";
import { fakeHost } from "./fake-host.ts";
import { type FakeSession, fakeSession } from "./fake-session.ts";
import { agentEntry, teamOf } from "./fixtures.ts";

/** Wall clock of the real run (Korean time), as milliseconds. */
const KST = (hms: string): number => Date.parse(`2026-11-26T${hms}+09:00`);
const clock = { t: KST("14:16:51") };

const BODY_TOOLS = ["read", "write", "edit", "bash", "eval"];
const READ_TOOLS = ["read", "grep", "find"];

type PlanInput = NonNullable<StormToolInput["plan"]>;
type LaneInput = PlanInput["lanes"][number];

const DIR = (name: string) => `.local-ops/benchmarks/${name}`;
const KNOWLEDGE = "knowledge/genai/k3";
const VLM = `${KNOWLEDGE}/2026-11-17-ennp-gemma4-e2b-native-vlm.md`;
const HYBRID = `${KNOWLEDGE}/2026-10-27-gemma4-e2b-enn-gen8-hybrid-results.md`;
const EXECUTORCH = `${KNOWLEDGE}/2026-11-09-executorch-exynos-enn-project.md`;

const answer = (id: string, criterion: string) => ({ id, kind: "answer" as const, criterion });
const BODY_RESULT = answer("qat-body-device", "a device comparison of the frozen body with its hashes");
const HEAD_RESULT = answer("qat-head-device", "the head candidates with their manifest hashes");
const RAM_RESULT = answer("memory-handoff-device", "the file to memory handoff, measured");
const CLAW_RESULT = answer("claw-producer-provenance", "the producer and QAT revision, or exactly what is missing");
const HEAD_CONTROL = answer("head-control-source", "the existing head candidate's emitter and runner, cited");
const HANDOFF_CONTROL = answer("handoff-control-source", "the C3-F2 manifest's ports and entry points, cited");
const WHOLE_RESULTS = [
	answer("qat-whole-generation", "the whole QAT generation, executed"),
	answer("matched-december-comparison", "the matched December comparison"),
];
const INTEGRATE_FILES = ["knowledge/genai/k0-index.md", VLM];

const lane = (name: string, role: "implementer" | "explorer", extra: Partial<LaneInput> & { results: LaneInput["results"] }): LaneInput => ({
	name,
	kind: role === "explorer" ? "explore" : "code",
	role,
	goal: `deliver ${name}`,
	...extra,
});

/** The five shapes of the director's plan over the first hour, in the order it submitted them. */
const P1: PlanInput = {
	workers: { implementer: 3, explorer: 1 },
	lanes: [
		lane("GemmaQatBody", "implementer", { results: [BODY_RESULT] }),
		lane("GemmaQatHead", "implementer", { results: [HEAD_RESULT] }),
		lane("GemmaMemoryHandoff", "implementer", { results: [RAM_RESULT] }),
		lane("TraceClawQatProducer", "explorer", { results: [CLAW_RESULT] }),
		lane("IntegrateGemmaQat", "implementer", {
			files: INTEGRATE_FILES,
			results: WHOLE_RESULTS,
			dependsOn: [
				{ lane: "GemmaQatBody", need: "result" },
				{ lane: "GemmaQatHead", need: "result" },
				{ lane: "GemmaMemoryHandoff", need: "result" },
			],
		}),
	],
};
const P2: PlanInput = {
	workers: { implementer: 3, explorer: 1 },
	lanes: [
		lane("BuildGemmaBodyQat", "implementer", { files: [DIR("gemma4-body-qat")], results: [BODY_RESULT] }),
		lane("BuildGemmaQatHead", "implementer", { files: [DIR("gemma4-head-qat")], results: [HEAD_RESULT] }),
		lane("TestGemmaRamHandoff", "implementer", { files: [DIR("gemma4-ram-handoff")], results: [RAM_RESULT] }),
		lane("TraceClawQatProducer", "explorer", { results: [CLAW_RESULT] }),
		lane("IntegrateGemmaQat", "implementer", {
			files: INTEGRATE_FILES,
			results: WHOLE_RESULTS,
			dependsOn: [
				{ lane: "BuildGemmaBodyQat", need: "result" },
				{ lane: "BuildGemmaQatHead", need: "result" },
				{ lane: "TestGemmaRamHandoff", need: "result" },
			],
		}),
	],
};
const P3: PlanInput = {
	workers: { implementer: 3, explorer: 1 },
	lanes: [
		lane("BuildGemmaBodyQat", "implementer", { files: [DIR("gemma4-body-qat")], results: [BODY_RESULT] }),
		lane("TrialGemmaQatHead", "implementer", {
			files: [DIR("gemma4-head-qat")],
			isolationReason: "the head trial needs no shared tracked tree",
			results: [HEAD_RESULT],
		}),
		lane("TrialGemmaRamHandoff", "implementer", {
			files: [DIR("gemma4-ram-handoff")],
			isolationReason: "the handoff trial only reads existing models",
			results: [RAM_RESULT],
		}),
		lane("TraceClawQatProducer", "explorer", { results: [CLAW_RESULT] }),
		lane("IntegrateGemmaQat", "implementer", {
			files: INTEGRATE_FILES,
			results: WHOLE_RESULTS,
			dependsOn: [
				{ lane: "BuildGemmaBodyQat", need: "result" },
				{ lane: "TrialGemmaQatHead", need: "result" },
				{ lane: "TrialGemmaRamHandoff", need: "result" },
			],
		}),
	],
};
const P4Lanes = (edge: "result" | "reviewable"): LaneInput[] => [
	lane("BuildGemmaBodyQat", "implementer", { files: [DIR("gemma4-body-qat")], results: [BODY_RESULT] }),
	lane("PinGemmaHeadControl", "explorer", { results: [HEAD_CONTROL] }),
	lane("PinGemmaHandoffControl", "explorer", { results: [HANDOFF_CONTROL] }),
	lane("BuildGemmaQatHeadShared", "implementer", {
		files: [DIR("gemma4-head-qat")],
		results: [HEAD_RESULT],
		dependsOn: [{ lane: "PinGemmaHeadControl", need: edge }],
	}),
	lane("TestGemmaRamHandoffShared", "implementer", {
		files: [DIR("gemma4-ram-handoff")],
		results: [RAM_RESULT],
		dependsOn: [
			{ lane: "PinGemmaHandoffControl", need: edge },
			{ lane: "BuildGemmaQatHeadShared", need: edge },
		],
	}),
	lane("TraceClawQatProducer", "explorer", { results: [CLAW_RESULT] }),
	lane("IntegrateGemmaQat", "implementer", {
		files: INTEGRATE_FILES,
		results: WHOLE_RESULTS,
		dependsOn: [
			{ lane: "BuildGemmaBodyQat", need: "result" },
			{ lane: "BuildGemmaQatHeadShared", need: "result" },
			{ lane: "TestGemmaRamHandoffShared", need: "result" },
		],
	}),
];
/** 14:23:58: the director gives up on isolation and puts a read-only prerequisite before each shared writer. */
const P4: PlanInput = { workers: { implementer: 3, explorer: 3 }, lanes: P4Lanes("result") };
/** 14:45:17: the same edges, relaxed to a reviewable submission. */
const P5: PlanInput = { workers: { implementer: 3, explorer: 3 }, lanes: P4Lanes("reviewable") };
/** 14:53:42: the prerequisite edges of the two writers are dropped. */
const P6: PlanInput = {
	workers: { implementer: 3, explorer: 3 },
	lanes: P4Lanes("result").map(l =>
		l.name === "BuildGemmaQatHeadShared" || l.name === "TestGemmaRamHandoffShared" ? { ...l, dependsOn: undefined } : l,
	),
};

/**
 * The delivered answers, with the citation forms the real ones carried. `local://` and `#L` links are not read; a
 * `path:line` under the project is.
 */
const CLAW_FIRST = `The producer receipt is missing for the supplied decoder. Source: ${HYBRID}:13 and what was checked is listed.`;
const CLAW_FOLLOW = `Closed with the official result, cited at ${EXECUTORCH}:93-105 and ${EXECUTORCH}:122-146.`;
const HANDOFF_FIRST = `The ticket's successful baseline is consumer2 (see ${VLM}:603 for the caller).`;
const HANDOFF_FOLLOW = `The source is recorded in local://handoff-control-source.md:3-9 and ${VLM}:603-643 holds the handoff.`;
const HEAD_FIRST = "B reuses the emitter with no code change, but the QAT head weights exist nowhere. Saved as local://head-control-source.md.";
const HEAD_FOLLOW_1 = "**head-control-source** ready: the emitter contract is `emit.py:87-110`, the tie contract `gemma_text.py:113`, per $BQ/source.json:2-7.";
const HEAD_FOLLOW_2 = `- **head-control-source**: [source](local://head-control-source.md:3-9) · [boundary](${VLM}#L281-L304), the softcap is in \`emit.py:380-390\`.`;
/** Not in the real run: the answer Storm's refusal now asks for. */
const HEAD_FOLLOW_3 = `The head's emitter, runner and ports are in ${VLM}:281-304 (softcap, decoder.norm hook, tied master).`;
const BODY_FINAL = "Body frozen and run on the November board: evidence in local://gemma-body-qat-evidence.md:26-66.";

const team = teamOf({ implementer: "fake/dev", explorer: "fake/look", reviewer: "fake/review" });

interface Moment {
	at: string;
	what: string;
	text: string;
}
const transcript: Moment[] = [];
const say = (at: string, what: string, text: string): void => {
	transcript.push({ at, what, text });
};

let root: string;
let h: FakeSession;
let runId: string;
let collector: AttemptCollector;
let lanes: RunLanes;
let current: RunPlan;
/** The run's subagents as omp's ledger reports them. */
const agents: AgentEntry[] = [];
const settlements: string[] = [];
const spawned = new Map<string, { agentId: string; lane: PlanLane }>();
/** omp job rows: the start time of each agent's newest job, as `getAsyncJobSnapshot` would show it. */
const jobStart = new Map<string, number>();

const laneOf = (name: string): PlanLane => current.lanes.find(candidate => candidate.name === name)!;
const rowOf = (id: string): RunResult => h.controller.active()!.results!.find(candidate => candidate.id === id)!;
const agentOf = (name: string): string => spawned.get(name)!.agentId;

function setAgent(agentId: string, role: "implementer" | "explorer", state: "running" | "idle" | "parked"): void {
	const entry = agentEntry({
		id: agentId,
		name: role === "explorer" ? "storm-explorer" : "storm-implementer",
		role,
		state,
		requests: 8,
		lastActivityAt: clock.t,
		startedAt: jobStart.get(agentId) ?? clock.t,
	});
	const at = agents.findIndex(candidate => candidate.id === agentId);
	if (at < 0) agents.push(entry);
	else agents[at] = entry;
}

const policiesOf = (plan: RunPlan): Map<string, LanePolicy> =>
	new Map(
		plan.lanes.map(l => [
			l.name,
			lanePolicy({ lane: l, tools: l.role === "explorer" ? READ_TOOLS : BODY_TOOLS, isolated: l.isolationReason !== undefined, auto: true }),
		]),
	);

const needed = (plan: RunPlan): Set<string> => new Set(plan.lanes.flatMap(l => (l.dependsOn ?? []).map(dependency => dependency.lane)));

/** The tool's reply to a plan, with the host as the extension builds it: automatic delegation on, isolation as given. */
async function planReply(plan: PlanInput, isolation: boolean | undefined): Promise<string> {
	const f = fakeHost({ runActive: true });
	const host: StormToolHost = { ...f.host, auto: () => ({ enabled: true }), isolationEnabled: () => isolation };
	const reply = await runStormTool(host, { action: "plan", plan });
	expect(reply.outcome).toBe("ok");
	return reply.text;
}

async function submitPlan(raw: PlanInput, at: string): Promise<string> {
	clock.t = KST(at);
	const reply = await planReply(raw, false);
	const checked = validatePlan(h.config, raw, clock.t);
	expect(checked.errors).toEqual([]);
	const applied = await h.controller.setPlan(h.ctx, checked.plan!);
	expect(applied).toEqual({ ok: true });
	current = checked.plan!;
	lanes = h.controller.runLanes()!;
	return reply;
}

/** A task call as the director sent it: the lanes by name, the worker's agent. */
const taskCall = (...names: string[]) => ({
	tasks: names.map(name => ({ agent: laneOf(name).role === "explorer" ? "storm-explorer" : "storm-implementer", name, task: `do ${name}` })),
});

async function place(at: string, names: string[], isolationEnabled: boolean | undefined = false): Promise<ReturnType<RunLanes["assign"]>> {
	clock.t = KST(at);
	const readiness = needed(current).size === 0 ? undefined : await h.controller.laneReadiness(current, needed(current));
	return lanes.assign(taskCall(...names), current, h.config, {
		host: { enabled: isolationEnabled },
		policies: policiesOf(current),
		...(readiness === undefined ? {} : { readiness }),
		agents,
		callId: `call-${at}`,
		now: clock.t,
	});
}

function refused(binding: ReturnType<RunLanes["assign"]>): { code: string | undefined; reason: string } {
	expect(binding.ok).toBe(false);
	if (binding.ok) throw new Error("expected a refusal");
	return { code: binding.code, reason: binding.reason };
}

/** The accepted call: omp names the workers and the spawns start. */
async function start(at: string, names: string[]): Promise<void> {
	const binding = await place(at, names);
	if (!binding.ok) throw new Error(`${names.join(",")} refused at ${at}: ${binding.reason}`);
	const items = (binding.input as { tasks?: { name: string }[]; name?: string }).tasks ?? [binding.input as { name: string }];
	for (const [index, item] of items.entries()) {
		const target = laneOf(names[index]!);
		lanes.admit({ spawnKey: item.name, agent: target.role === "explorer" ? "storm-explorer" : "storm-implementer", outcome: "routed" });
		await collector.admitSpawn({ runId, parentId: "main", spawnKey: item.name, lane: target, artifactMode: "shared", startedAt: clock.t });
		spawned.set(names[index]!, { agentId: item.name, lane: target });
		jobStart.set(item.name, clock.t);
		setAgent(item.name, target.role === "explorer" ? "explorer" : "implementer", "running");
	}
}

/** A `write agent://<id>` that woke or joined the worker, with the job omp registered for it (when it registers one). */
async function followUp(at: string, name: string, toolCallId: string, job?: { id: string; startTime: number }): Promise<void> {
	clock.t = KST(at);
	const { agentId, lane: target } = spawned.get(name)!;
	await collector.admitFollowUp({ runId, parentId: "main", spawnKey: agentId, lane: target, artifactMode: "shared", toolCallId, startedAt: clock.t });
	if (job !== undefined) {
		collector.bindFollowUpJobs({ runId, spawnKey: agentId, jobs: [{ id: job.id, agentId, startTime: job.startTime, status: "running" }] });
		jobStart.set(agentId, job.startTime);
	}
	setAgent(agentId, target.role === "explorer" ? "explorer" : "implementer", "running");
}

/** The worker's turn ended and `wait` delivered it: the row carries the job's own start (`settledAtMs - durationMs`). */
async function waitDelivery(at: string, name: string, text: string, jobId?: string): Promise<void> {
	clock.t = KST(at);
	const { agentId, lane: target } = spawned.get(name)!;
	const settledAtMs = clock.t - 500;
	await collector.observeWaitResult({
		runId,
		parentId: "main",
		observedAt: clock.t,
		details: {
			op: "wait",
			jobs: [{ id: jobId ?? agentId, type: "task", status: "completed", agentUrlId: agentId, settledAtMs, durationMs: settledAtMs - jobStart.get(agentId)!, resultText: text }],
		},
	});
	setAgent(agentId, target.role === "explorer" ? "explorer" : "implementer", "idle");
}

/** A pushed `async-result` with the parent's job row, which carries the job's start. */
async function pushedDelivery(at: string, name: string, text: string): Promise<void> {
	clock.t = KST(at);
	const { agentId, lane: target } = spawned.get(name)!;
	await collector.observeMessage({
		runId,
		parentId: "main",
		observedAt: clock.t,
		message: { customType: "async-result", content: text, details: { jobs: [{ jobId: agentId, agentId, status: "completed" }] } },
		jobs: [{ id: agentId, agentId, startTime: jobStart.get(agentId)!, status: "completed" }],
	});
	setAgent(agentId, target.role === "explorer" ? "explorer" : "implementer", "idle");
}

const running = async (name: string): Promise<boolean> => (await h.controller.laneReadiness(current, new Set([name]))).get(name)!.running;

beforeAll(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-replay-")));
	await mkdir(path.join(root, KNOWLEDGE), { recursive: true });
	const body = (lines: number) => Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n");
	await writeFile(path.join(root, VLM), body(700));
	await writeFile(path.join(root, HYBRID), body(40));
	await writeFile(path.join(root, EXECUTORCH), body(160));
	await writeFile(path.join(root, "knowledge/genai/k0-index.md"), body(10));
	h = fakeSession({ root, config: team, agents, now: () => clock.t });
	clock.t = KST("14:16:51");
	runId = await h.start();
	collector = new AttemptCollector({
		port: {
			prepare: input => h.controller.prepareAttempt({ ...input, runId }),
			settle: async input => {
				settlements.push(`${input.spawnKey}:${input.report.attemptId ?? "none"}`);
				await h.controller.settleAttempt({ ...input, runId });
			},
			discard: input => h.controller.discardAttempt(input),
		},
		registry: () => ({ get: id => ({ id, parentId: "main", session: null }), onChange: () => () => undefined }),
		now: () => clock.t,
	});
});

afterAll(async () => {
	if (process.env.REPLAY_TRANSCRIPT === "1") {
		for (const moment of transcript) console.log(`\n[${moment.at}] ${moment.what}\n${moment.text}`);
	}
	resetCloseoutChoices();
	resetLedger();
	resetAgents();
	await rm(root, { recursive: true, force: true });
});

describe("14:16 to 14:22: the plan step and the first refusals", () => {
	test("14:16:51 the plan reply says the three writers start one at a time and why; 14:18:06 the refusal agrees", async () => {
		const reply = await submitPlan(P1, "14:16:51");
		say("14:16:51", "plan reply", reply);
		const order = reply.split("\n").find(l => l.startsWith("- 쓰기 순서"));
		expect(order).toBeDefined();
		for (const name of ["GemmaQatBody", "GemmaQatHead", "GemmaMemoryHandoff"]) expect(order).toContain(name);
		expect(order).not.toContain("TraceClawQatProducer");
		expect(order).toContain(WHY_AUTO_WRITER);
		expect(reply).not.toContain("격리 불가");

		const call = refused(await place("14:18:06", ["GemmaQatBody", "GemmaQatHead", "GemmaMemoryHandoff", "TraceClawQatProducer"]));
		say("14:18:06", "task call refused", call.reason);
		expect(call.code).toBe("lane-write");
		// What the director was told matches what the plan reply said: the lanes, the cause, one writer per call.
		expect(call.reason).toContain("'GemmaQatBody' 레인");
		expect(call.reason).toContain("'GemmaQatHead' 레인");
		expect(call.reason).toContain(WHY_AUTO_WRITER);
		expect(call.reason).toContain("읽기 전용");
	});

	test("14:18:50 a directory per lane changes nothing, and the plan reply says so before the call is made", async () => {
		const reply = await submitPlan(P2, "14:18:50");
		say("14:18:50", "plan reply", reply);
		const order = reply.split("\n").find(l => l.startsWith("- 쓰기 순서"));
		expect(order).toBeDefined();
		for (const name of ["BuildGemmaBodyQat", "BuildGemmaQatHead", "TestGemmaRamHandoff"]) expect(order).toContain(name);
		expect(order).toContain("파일 목록과 무관");
	});

	test("14:19:35 the refused lane is told it did declare files, not that its scope was undeclared", async () => {
		const call = refused(await place("14:19:35", ["BuildGemmaBodyQat", "BuildGemmaQatHead", "TestGemmaRamHandoff", "TraceClawQatProducer"]));
		say("14:19:35", "task call refused", call.reason);
		expect(call.code).toBe("lane-write");
		expect(call.reason).not.toContain("선언되지 않은");
		expect(call.reason).not.toContain("겹칩니다");
		expect(call.reason).toContain("파일 목록을 선언했지만");
		// The explorer is no party to the refusal, and the next step is one that works: a single writer per call.
		expect(call.reason).not.toContain("TraceClawQatProducer");
		expect(call.reason).toContain("하나만");
	});

	test("14:20:28 one writer starts; 14:20:50 a second is told which lane it waits for and to send the same call again", async () => {
		await start("14:20:28", ["BuildGemmaBodyQat"]);
		const body = agentOf("BuildGemmaBodyQat");
		expect(body).toMatch(/-lane-1$/);
		const head = refused(await place("14:20:50", ["BuildGemmaQatHead"]));
		say("14:20:50", "task call refused", head.reason);
		expect(head.code).toBe("lane-write");
		expect(head.reason).toContain("'BuildGemmaBodyQat' 레인");
		expect(head.reason).toContain("끝난 뒤");
		expect(head.reason).not.toContain("선언되지 않은");
		await start("14:21:07", ["TraceClawQatProducer"]);
		expect(agentOf("TraceClawQatProducer")).toMatch(/-lane-2$/);
	});

	test("14:21:38 isolation off: the plan reply names the two isolated lanes; 14:22:17 the refusal says who turns it on and the way that works now", async () => {
		const reply = await submitPlan(P3, "14:21:38");
		say("14:21:38", "plan reply", reply);
		const off = reply.split("\n").find(l => l.startsWith("- 격리 불가"));
		expect(off).toBeDefined();
		expect(off).toContain("TrialGemmaQatHead");
		expect(off).toContain("TrialGemmaRamHandoff");
		expect(off).not.toContain("BuildGemmaBodyQat");
		expect(off).toContain("task.isolation.enabled");

		const call = refused(await place("14:22:17", ["TrialGemmaQatHead", "TrialGemmaRamHandoff"], false));
		say("14:22:17", "task call refused (isolation off)", call.reason);
		expect(call.code).toBeUndefined();
		expect(call.reason).toContain("task.isolation.enabled");
		expect(call.reason).toContain("isolationReason");
		// It is the user's setting: the text does not tell the director to change the machine.
		expect(call.reason).toContain("사용자");
	});

	test("14:22:17 a message into the running implementer is one more turn of the same job, not a second attempt", async () => {
		const body = agentOf("BuildGemmaBodyQat");
		expect(await running("BuildGemmaBodyQat")).toBe(true);
		await followUp("14:22:17", "BuildGemmaBodyQat", "call-follow-1", { id: body, startTime: KST("14:20:28") });
		expect(await running("BuildGemmaBodyQat")).toBe(true);
	});
});

describe("14:23 to 14:31: results of follow-ups reach the ledger, and the dependency refusal says why", () => {
	test("14:23:58 the readers start together beside the running writer", async () => {
		const reply = await submitPlan(P4, "14:23:58");
		say("14:23:58", "plan reply", reply);
		// Body and the head writer are unordered writers: the reply names them now, before the 14:54:04 refusal meets them.
		const order = reply.split("\n").find(l => l.startsWith("- 쓰기 순서"));
		expect(order).toContain("BuildGemmaBodyQat");
		expect(order).toContain("BuildGemmaQatHeadShared");
		expect(reply).not.toContain("격리 불가");
		await start("14:24:18", ["PinGemmaHeadControl", "PinGemmaHandoffControl"]);
		expect(agentOf("PinGemmaHeadControl")).toMatch(/-lane-3$/);
		expect(agentOf("PinGemmaHandoffControl")).toMatch(/-lane-4$/);
	});

	test("14:25:09 a second message into the running implementer joins the same turn", async () => {
		await followUp("14:25:09", "BuildGemmaBodyQat", "call-follow-2", { id: agentOf("BuildGemmaBodyQat"), startTime: KST("14:20:28") });
		expect(await running("BuildGemmaBodyQat")).toBe(true);
	});

	test("14:25:55 the explorer's answer is delivered; 14:26:51 the follow-up to it is delivered at 14:27:06 and is recorded", async () => {
		const claw = agentOf("TraceClawQatProducer");
		await waitDelivery("14:25:55", "TraceClawQatProducer", CLAW_FIRST);
		const first = { ...rowOf("claw-producer-provenance") };
		expect(first.state).toBe("reviewable");
		expect(first.attemptId).toBe(`job:${claw}:${claw}`);
		expect(first.attemptId).toHaveLength(67);
		// 56 s after the delivery omp has dropped the job row, so the follow-up's job takes the agent id again.
		await followUp("14:26:51", "TraceClawQatProducer", "call-follow-claw", { id: claw, startTime: KST("14:26:51") + 300 });
		expect(await running("TraceClawQatProducer")).toBe(true);
		await waitDelivery("14:27:06", "TraceClawQatProducer", CLAW_FOLLOW);
		const second = rowOf("claw-producer-provenance");
		// Before: the delivery was refused as a replay, the dispatch stayed open and the row kept the first judgment.
		expect(second.attemptId).not.toBe(first.attemptId);
		expect(ATTEMPT_REF.test(second.attemptId!)).toBe(true);
		expect(second.contentVersion).not.toBe(first.contentVersion);
		expect(await running("TraceClawQatProducer")).toBe(false);
		say("14:27:06", "follow-up result recorded", `${second.state} ${second.attemptId}`);
	});

	test("14:29:23 and 14:29:48 the two prerequisites deliver: one reviewable, one unmet with its reason", async () => {
		await waitDelivery("14:29:23", "PinGemmaHandoffControl", HANDOFF_FIRST);
		expect(rowOf("handoff-control-source").state).toBe("reviewable");
		await pushedDelivery("14:29:48", "PinGemmaHeadControl", HEAD_FIRST);
		const head = rowOf("head-control-source");
		expect(head.state).toBe("unmet");
		expect(head.reason).toBeDefined();
	});

	test("14:30:32 the dependency refusal carries the ledger's reason and what an answer must cite, and does not say to respawn", async () => {
		const call = refused(await place("14:30:32", ["BuildGemmaQatHeadShared"]));
		say("14:30:32", "task call refused", call.reason);
		expect(call.code).toBe("lane-dependency");
		expect(call.reason).toContain("'BuildGemmaQatHeadShared' 레인");
		expect(call.reason).toContain("'PinGemmaHeadControl' 레인");
		// The reason the ledger gave, which the old text dropped.
		expect(call.reason).toContain(rowOf("head-control-source").reason!.replace(/[.。]+$/u, ""));
		// The citation form that works, and the way to ask for it.
		expect(call.reason).toContain("path:line");
		expect(call.reason).toContain("write agent://");
		expect(call.reason).not.toContain("다시 스폰");
		// The old text spliced a name into a particle: `필수 결과을`.
		expect(call.reason).not.toContain("결과을");
		expect(call.reason).not.toContain("이(가)");
	});

	test("14:30:50 follow-ups to both prerequisites; 14:31:06 and 14:31:16 their answers are recorded and neither lane reads as running", async () => {
		const handoff = agentOf("PinGemmaHandoffControl");
		const head = agentOf("PinGemmaHeadControl");
		const handoffBefore = rowOf("handoff-control-source").attemptId;
		const headBefore = rowOf("head-control-source").attemptId;
		await followUp("14:30:50", "PinGemmaHeadControl", "call-follow-head-1", { id: head, startTime: KST("14:30:50") + 300 });
		await followUp("14:30:50", "PinGemmaHandoffControl", "call-follow-handoff-1", { id: handoff, startTime: KST("14:30:50") + 400 });
		await waitDelivery("14:31:06", "PinGemmaHandoffControl", HANDOFF_FOLLOW);
		await waitDelivery("14:31:16", "PinGemmaHeadControl", HEAD_FOLLOW_1);
		expect(rowOf("handoff-control-source").attemptId).not.toBe(handoffBefore);
		expect(rowOf("head-control-source").attemptId).not.toBe(headBefore);
		expect(await running("PinGemmaHeadControl")).toBe(false);
		expect(await running("PinGemmaHandoffControl")).toBe(false);
	});

	test("14:31:39 the refusal now speaks of the answer, not of a worker that is still running", async () => {
		const call = refused(await place("14:31:39", ["BuildGemmaQatHeadShared"]));
		say("14:31:39", "task call refused", call.reason);
		expect(call.code).toBe("lane-dependency");
		expect(call.reason).not.toContain("아직 실행 중");
		expect(call.reason).toContain(rowOf("head-control-source").reason!.replace(/[.。]+$/u, ""));
	});
});

describe("14:35 to 14:56: the stuck lane no longer blocks, and the running implementer settles once", () => {
	test("14:40:27 a second follow-up to the parked explorer, delivered at 14:40:37, is recorded again", async () => {
		const head = agentOf("PinGemmaHeadControl");
		const before = rowOf("head-control-source").attemptId;
		await followUp("14:40:27", "PinGemmaHeadControl", "call-follow-head-2", { id: `${head}-2`, startTime: KST("14:40:27") + 500 });
		await waitDelivery("14:40:37", "PinGemmaHeadControl", HEAD_FOLLOW_2, `${head}-2`);
		expect(rowOf("head-control-source").attemptId).not.toBe(before);
		expect(await running("PinGemmaHeadControl")).toBe(false);
		// The answer still cites only a `local://` file and a `#L` link: both are not read, so it stays unmet, with the reason.
		expect(rowOf("head-control-source").state).toBe("unmet");
	});

	test("14:44:33 the refusal is the same honest sentence: the lane is not running, the answer is what is missing", async () => {
		const call = refused(await place("14:44:33", ["BuildGemmaQatHeadShared"]));
		say("14:44:33", "task call refused", call.reason);
		expect(call.reason).not.toContain("아직 실행 중");
		expect(call.reason).toContain("path:line");
	});

	test("14:45:17 the edge is relaxed to a reviewable submission; 14:52:53 the refusal still names the answer, not a running worker", async () => {
		const reply = await submitPlan(P5, "14:45:17");
		say("14:45:17", "plan reply", reply);
		await followUp("14:48:02", "BuildGemmaBodyQat", "call-follow-3", { id: agentOf("BuildGemmaBodyQat"), startTime: KST("14:20:28") });
		const call = refused(await place("14:52:53", ["BuildGemmaQatHeadShared"]));
		say("14:52:53", "task call refused", call.reason);
		expect(call.code).toBe("lane-dependency");
		expect(call.reason).not.toContain("아직 실행 중");
		expect(call.reason).toContain("검토 가능 제출");
	});

	test("(not in the real run) the answer the refusal asks for is accepted for review and the writer is then held only by the running writer", async () => {
		const head = agentOf("PinGemmaHeadControl");
		await followUp("14:53:10", "PinGemmaHeadControl", "call-follow-head-3", { id: head, startTime: KST("14:53:10") + 400 });
		await waitDelivery("14:53:30", "PinGemmaHeadControl", HEAD_FOLLOW_3);
		expect(rowOf("head-control-source").state).toBe("reviewable");
		const call = refused(await place("14:53:35", ["BuildGemmaQatHeadShared"]));
		say("14:53:35", "task call refused", call.reason);
		expect(call.code).toBe("lane-write");
		expect(call.reason).toContain("'BuildGemmaBodyQat' 레인");
	});

	test("14:53:42 the prerequisite edge is dropped; 14:54:04 the call meets the running Body as a write refusal, once", async () => {
		await submitPlan(P6, "14:53:42");
		await followUp("14:55:15", "BuildGemmaBodyQat", "call-follow-4", { id: agentOf("BuildGemmaBodyQat"), startTime: KST("14:20:28") });
		const call = refused(await place("14:54:04", ["BuildGemmaQatHeadShared"]));
		say("14:54:04", "task call refused", call.reason);
		expect(call.code).toBe("lane-write");
		expect(call.reason).toContain("'BuildGemmaBodyQat' 레인");
	});

	test("14:55:41 Body delivers after four messages into one turn: one attempt is recorded and the lane stops running", async () => {
		const body = agentOf("BuildGemmaBodyQat");
		await waitDelivery("14:55:41", "BuildGemmaBodyQat", BODY_FINAL);
		const row = rowOf("qat-body-device");
		expect(row.attemptId).toBe(`job:${body}:${body}`);
		// Its answer cites only a `local://` file, so the ledger says unmet with a reason; it is judged, not pending.
		expect(row.state).toBe("unmet");
		expect(row.reason).toBeDefined();
		expect(await running("BuildGemmaBodyQat")).toBe(false);
		expect(settlements.filter(entry => entry.startsWith(`${body}:`))).toHaveLength(1);
	});

	test("14:56:06 the next writer starts: the one-at-a-time guard released with the worker", async () => {
		await start("14:56:06", ["BuildGemmaQatHeadShared"]);
		expect(agentOf("BuildGemmaQatHeadShared")).toMatch(/-lane-5$/);
		// The guard is still closed: a second shared writer beside the new one is refused.
		const second = refused(await place("14:56:20", ["TestGemmaRamHandoffShared"]));
		expect(second.code === "lane-write" || second.code === "lane-dependency").toBe(true);
	});
});

describe("the end of the run", () => {
	test("rows with a delivered answer keep it; a row closed before any judgment is counted as that, not as unmet", async () => {
		clock.t = KST("15:03:28");
		// The host died with the head writer mid-turn (its worker parked, nothing delivered): the run closes with its dispatch open.
		setAgent(agentOf("BuildGemmaQatHeadShared"), "implementer", "parked");
		await h.controller.finish("no-progress");
		const record = await readRun(h.sessionDir, runId);
		const rows = new Map((record?.results ?? []).map(row => [row.id, row]));
		// Delivered and judged before the end: untouched by finalization.
		for (const id of ["claw-producer-provenance", "handoff-control-source", "head-control-source", "qat-body-device"]) {
			expect(rows.get(id)?.finalized, id).toBeUndefined();
		}
		expect(rows.get("head-control-source")?.state).toBe("reviewable");
		expect(rows.get("claw-producer-provenance")?.state).toBe("reviewable");
		// The new head writer was still running with no answer: closed unsettled, and the count says so.
		expect(rows.get("qat-head-device")?.finalized).toBe("unsettled");
		const progress = resultProgress(record!);
		expect(progress.counts.unjudged).toBeGreaterThan(0);
		expect(progress.parts.some(part => part.startsWith("판정 전 종료"))).toBe(true);
		// Body was judged unmet before the end: its count is the ordinary one.
		expect(progress.counts.unmet).toBeGreaterThan(0);
		say("15:03:28", "status counts", progress.headline);
	});

	test("every recorded attempt id of this run is a real-length id the views and the resume can carry", async () => {
		const record = await readRun(h.sessionDir, runId);
		const ids = (record?.results ?? []).flatMap(row => (row.attemptId === undefined ? [] : [row.attemptId]));
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(ATTEMPT_REF.test(id), id).toBe(true);
		expect(ids.some(id => id.length >= 67)).toBe(true);
		const view = resultProgress(record!);
		for (const row of view.rows) if (row.attempt !== undefined) expect(ids).toContain(row.attempt);
		expect(view.rows.filter(row => row.attempt !== undefined).length).toBe(ids.length);
	});
});
