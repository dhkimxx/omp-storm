#!/usr/bin/env bun
/**
 * Follow-up results reach the result ledger, real host: a disposable git checkout, an isolated HOME/profile, the pinned
 * omp and the local fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * omp registers the turn of a woken worker as a job under the agent id, and hands that id out again once the earlier
 * job's row has been evicted (30 s after its result was consumed). Storm used to build the attempt id from the job id,
 * so a follow-up sent after the eviction looked like a replay of the first answer and was dropped: the row kept its
 * first judgment, the lane read as running for the rest of the run, the lane that depended on it never read as ready, and the
 * end of the run rewrote the delivered row. The scripted director therefore:
 *
 *   1. plans a prerequisite lane (a typed answer) and a lane that needs it,
 *   2. runs the prerequisite; its first answer cites nothing, so the row is `unmet` (the dependant is not called yet),
 *   3. waits out omp's eviction (the fake model sleeps before the follow-up's call), then writes a follow-up to the
 *      idle worker asking for the cited answer,
 *   4. receives the follow-up's result (by `wait` in one case, as a pushed `async-result` in the other),
 *   5. starts the dependant lane.
 *
 * The run must end with the row accepted on the follow-up's own attempt, the dependant admitted and run, and no row
 * rewritten as closed before judgment. The precondition is asserted too: the follow-up's job really carried the agent
 * id again (otherwise this exercise would only repeat the fast `<agent>-2` case the unit tests already hold).
 * Lane and agent names have the shape of a real run's workers (`run-20261126-051651-7850-lane-3`), so the attempt ids
 * are the 67 (and, for a reused job, 82) characters the real host produces.
 *
 * Usage:
 *   E2E_PORT=18797 E2E_WORK=/tmp/storm-e2e-follow-up ./node_modules/.bin/bun scripts/e2e/follow-up-ledger.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { ATTEMPT_REF } from "../../src/runtime/attempt-report.ts";
import { LEDGER_NOTICE_TAG, LEDGER_READY_LEAD } from "../../src/runtime/lanes.ts";
import type { RunRecord, RunResult } from "../../src/types.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import {
	type Answer,
	cancelAll,
	choose,
	customMessage,
	type Frame,
	LlmCursor,
	linkPlugin,
	modelsYml,
	prepare,
	PROFILE_CONFIG,
	Rpc,
	type Step,
	StormFiles,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	until,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const AUTO_OFF = "자동 위임 끄기";
const MAIN = "fake/general-b";
/** Worker names of the shape a real run gives them; also the host's agent and (first) job ids. One pair per case. */
interface Names {
	pin: string;
	dep: string;
}
const NAMES: Record<"wait" | "pushed", Names> = {
	wait: { pin: "run-20261126-051651-7850-lane-3", dep: "run-20261126-051651-7850-lane-5" },
	pushed: { pin: "run-20261126-051651-7850-lane-4", dep: "run-20261126-051651-7850-lane-6" },
};
/** More than omp's 30 s eviction of a consumed job row; the fake model sleeps this long before the follow-up's call. */
const EVICTION_WAIT_MS = 34_000;
const UNCITED = "E2E-CHILD-CLAIM I looked at the head control but found nothing I can cite";

const env = prepare("storm-e2e-follow-up", 18797);
seedFact(env.project);
const suite = new Suite("E2E (follow-up results reach the ledger)", env);
const check = suite.check.bind(suite);
let owned: { id: string; dir: string } | undefined;
const exitCodes: number[] = [];

async function session<T>(answer: Answer, body: (rpc: Rpc, files: StormFiles) => Promise<T>): Promise<T> {
	const rpc = new Rpc(env, answer, { model: MAIN, ...(owned === undefined ? {} : { resume: owned.id, sessionDir: owned.dir }) });
	try {
		await rpc.ready();
		return await body(rpc, new StormFiles(env, rpc.sessionId));
	} finally {
		exitCodes.push(await rpc.close());
		if (owned === undefined) owned = { id: rpc.sessionId, dir: rpc.sessionDir };
	}
}

const runRequest = (steps: Step[]): string => `/storm E2E-ROUTE ${JSON.stringify({ action: "run", rounds: 1 })} E2E-STEPS ${JSON.stringify(steps)}`;
const row = (run: RunRecord, id: string): RunResult | undefined => (run.results ?? []).find(candidate => candidate.id === id);

const answerFor = (id: string) => requiredResult(id, "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE });
const planStep = ({ pin, dep }: Names): Step =>
	contractPlan(
		[
			{ name: pin, kind: "explore", results: [answerFor("pin-answer")] },
			{ name: dep, kind: "explore", results: [answerFor("dep-answer")], dependsOn: [{ lane: pin, need: "result" }] },
		],
		{ contract: true, workers: { explorer: 2 } },
	);
const task = (name: string, say: string): Step => ({ tasks: [{ name, agent: "storm-explorer", task: "Report from source", say }] });

interface JobFact {
	channel: "wait" | "async";
	jobId: string;
	agentId: string;
	at: number;
}

/** Terminal task jobs of `agent` the host delivered, in order: a wait row with a result, or an async-result job. */
function deliveries(frames: readonly Frame[], agent: string): JobFact[] {
	const out: JobFact[] = [];
	frames.forEach((frame, at) => {
		if (frame.type === "tool_execution_end" && frame.toolName === "wait") {
			const result = frame.result as unknown as { details?: { op?: string; jobs?: Record<string, unknown>[] } } | undefined;
			for (const job of result?.details?.op === "wait" ? (result.details.jobs ?? []) : []) {
				if (job.type !== "task" || job.agentUrlId !== agent || typeof job.id !== "string") continue;
				const text = typeof job.resultText === "string" && job.resultText !== "" ? job.resultText : job.errorText;
				if (typeof text === "string" && text !== "") out.push({ channel: "wait", jobId: job.id, agentId: agent, at });
			}
		}
		if (customMessage(frame) === "async-result" && typeof frame.message === "object") {
			const jobs = (frame.message.details as { jobs?: Record<string, unknown>[] } | undefined)?.jobs ?? [];
			for (const job of jobs) if (job.agentId === agent && typeof job.jobId === "string") out.push({ channel: "async", jobId: job.jobId, agentId: agent, at });
		}
	});
	return out;
}

/** The stamped attempt id of a reused job: `job:<agent>.t<start>:<agent>`. */
const stamped = (attempt: string | undefined, agent: string): boolean => attempt !== undefined && new RegExp(`^job:${agent}\\.t\\d{12,}:${agent}$`).test(attempt);

async function scenario(label: string, how: "wait" | "pushed"): Promise<void> {
	const names = NAMES[how];
	const PIN = names.pin;
	const DEP = names.dep;
	await session(cancelAll, async (rpc, files) => {
		const cited = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
		const steps: Step[] = [
			planStep(names),
			task(PIN, UNCITED),
			// The first answer is delivered as a pushed async-result and is not accepted (uncited). The dependant is not called yet:
			// a lane may start before its prerequisite is accepted, but then its own result is never accepted (see early-start.ts),
			// and this scenario is about the follow-up's answer becoming the row that lets the dependant be accepted.
			// The fake model sleeps past omp's eviction of the consumed job row, then wakes the idle worker.
			{ followUp: `agent://${PIN}`, content: `Cite the source this time. ${cited}`, pauseMs: EVICTION_WAIT_MS },
			// The cited answer arrives by a wait, or as a pushed message that only the follow-up's answer can carry.
			...(how === "wait" ? ([{ wait: true }] as Step[]) : ([{ read: FACT_FILE, afterResult: "tracked_delta is -7" }] as Step[])),
			task(DEP, cited),
			{ wait: true },
		];
		const llm = new LlmCursor(env);
		const before = files.runIds();
		await rpc.prompt(runRequest(steps), 240_000);
		const run = await files.finishedRun(before);
		// A1-5: the lane name is the director's key; the host's agent and job id is the handle this run placed.
		const pinNative = (run.spawns ?? []).find(spawn => spawn.lane === PIN && spawn.outcome !== "blocked")?.spawnKey;
		const mine = pinNative === undefined ? [] : deliveries(rpc.frames, pinNative);
		const jobIds = mine.map(delivery => delivery.jobId);
		const pin = row(run, "pin-answer");
		const dep = row(run, "dep-answer");
		const spawns = (run.spawns ?? []).filter(spawn => spawn.lane === DEP && spawn.outcome !== "blocked");

		// The precondition: the host really reused the agent id for the follow-up's job.
		check(
			`${label}: omp delivered the first answer and the follow-up under the same job id (the agent id)`,
			pinNative !== undefined && mine.length === 2 && jobIds.every(id => id === pinNative) && mine[0]?.channel === "async" && mine[1]?.channel === (how === "wait" ? "wait" : "async"),
			JSON.stringify({ pinNative, mine }),
		);
		// What the director read about the ledger, in its own requests: a developer message after the delivery.
		// The session is resumed between cases, so an earlier case's notices stay in its history: only this case's lanes count.
		const told = [...new Set(llm.of("main").flatMap(entry => entry.notes).filter(text => text.includes(LEDGER_NOTICE_TAG) && (text.includes(PIN) || text.includes(DEP))))];
		const unmetNotice = told.filter(text => text.includes(PIN) && text.includes("미충족") && text.includes("path:line"));
		const readyNotice = told.filter(text => text.includes(LEDGER_READY_LEAD) && text.includes(DEP));
		check(
			`${label}: the first answer, refused, left the director one line: result, state, reason and the citation form`,
			unmetNotice.length === 1 && unmetNotice[0]!.includes("pin-answer") && unmetNotice[0]!.length < 420 && !unmetNotice[0]!.includes(LEDGER_READY_LEAD),
			JSON.stringify(told),
		);
		check(
			`${label}: the follow-up's accepted answer told the director the dependant lane can start (and started nothing itself)`,
			readyNotice.length === 1 && readyNotice[0]!.length < 420,
			JSON.stringify(told),
		);
		check(`${label}: nothing but the two notices was added`, told.length === 2, JSON.stringify(told));
		// "The next request": the first director request that carries the pushed first answer already carries its notice,
		// and the request that starts the dependant carries the notice that it could.
		const mainRequests = llm.of("main");
		const afterFirstAnswer = mainRequests.find(entry => entry.users.some(text => pinNative !== undefined && text.includes(`Background job ${pinNative} has completed`)));
		check(
			`${label}: the director's very next request after the pushed first answer carries the notice`,
			afterFirstAnswer !== undefined && afterFirstAnswer.notes.some(text => text.includes(LEDGER_NOTICE_TAG) && text.includes("미충족")),
			JSON.stringify(afterFirstAnswer?.notes ?? null),
		);
		// A notice delivered with a `wait` result stays in the history; a pushed delivery's rides on the one request that
		// follows it. Either way the director reads it before the request that starts the lane.
		const readyAt = mainRequests.findIndex(entry => entry.notes.some(text => text.includes(LEDGER_READY_LEAD) && text.includes(`레인: ${DEP}`)));
		const startAt = mainRequests.findLastIndex(entry => entry.decision && "tool" in entry.decision && entry.decision.tool === "task" && JSON.stringify(entry.decision.args).includes(`"name":"${DEP}"`));
		const writeAt = mainRequests.findIndex(entry => entry.decision && "tool" in entry.decision && entry.decision.tool === "write");
		check(
			`${label}: the follow-up's accepted answer reaches the director's request that follows it, before the dependant is started`,
			writeAt >= 0 && readyAt > writeAt && startAt >= readyAt,
			JSON.stringify({ writeAt, readyAt, startAt }),
		);
		check(
			`${label}: the follow-up's answer is the row's newest attempt: accepted, on its own stamped attempt id`,
			pin?.state === "accepted" && pinNative !== undefined && stamped(pin.attemptId, pinNative) && pin.attemptId !== `job:${pinNative}:${pinNative}`,
			JSON.stringify({ state: pin?.state, attemptId: pin?.attemptId, reason: pin?.reason }),
		);
		check(
			`${label}: the attempt id is of the real length and a valid reference`,
			pin?.attemptId !== undefined && pin.attemptId.length > 64 && ATTEMPT_REF.test(pin.attemptId),
			`${pin?.attemptId?.length}`,
		);
		check(
			`${label}: the dependant lane was admitted after the follow-up and its answer accepted`,
			spawns.length === 1 && dep?.state === "accepted",
			JSON.stringify({ spawns: (run.spawns ?? []).map(spawn => [spawn.lane, spawn.outcome]), dep: dep?.state }),
		);
		check(
			`${label}: no row was rewritten as closed before judgment at the end of the run`,
			(run.results ?? []).every(result => result.finalized !== "unsettled"),
			JSON.stringify((run.results ?? []).map(result => [result.id, result.state, result.finalized])),
		);
		const pinAgent = (run.agents ?? []).find(agent => agent.id === pinNative);
		check(`${label}: the worker ends idle with its follow-up counted`, pinAgent?.state === "idle" && (pinAgent.followUps ?? 0) >= 1, JSON.stringify(pinAgent));
	});
}

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	linkPlugin(env);

	await suite.step("approved team and automatic delegation off", async () => {
		await session(choose(APPROVE), async (rpc, files) => {
			await rpc.prompt("/storm");
			check("the isolated profile has one approved team", files.approvals().length === 1, `approvals=${files.approvals().length}`);
			rpc.answer = choose(AUTO_OFF);
			await rpc.prompt("/storm auto");
			const choice = await readAutoDelegationChoice(files.sessionDir);
			check("automatic delegation is explicitly off", choice === "off", choice);
			// A real turn materializes the native transcript so later cases can resume this exact session.
			await rpc.turn("hello");
		});
	}, 120_000, { always: true });

	await suite.step("a follow-up after omp evicted the job row: its answer, delivered by wait, becomes the row's attempt", () => scenario("wait", "wait"), 300_000);
	await suite.step("the same, delivered as a pushed async-result", () => scenario("pushed", "pushed"), 300_000);

	await suite.step("every OMP session exited cleanly", async () => {
		check("no session exited non-zero", exitCodes.length > 0 && exitCodes.every(code => code === 0), `exit=${exitCodes.join(",")}`);
	});
}

let code = 1;
const server = await startFakeLlm(env);
try {
	await main();
} catch (error) {
	suite.check("harness", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	server.kill();
	await server.exited;
	code = suite.finish();
}
void until;
process.exit(code);
