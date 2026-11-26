#!/usr/bin/env bun
/**
 * What the parent's job snapshot holds when a follow-up's `write agent://<id>` result fires, real host: the pinned omp,
 * its own parent session (no Storm), the proof plugin's job-row log and the local fake LLM. No paid model calls.
 *
 * Storm binds a follow-up to the job omp registers for the woken worker, and reads the start time of that job to tell
 * the follow-up's turn from the earlier one (`bindFollowUpJobs` in `src/runtime/attempt-collector.ts`). That only works
 * if the job is already in the parent's snapshot at the write's `tool_result`, and the code must also cope with omp
 * handing out the agent id again once the earlier job's row was evicted (30 s after its result was consumed). This
 * exercise fixes what omp 19.2.1 does, per worker state:
 *
 *   idle, row evicted      the follow-up's job is in `running` at the write, under the agent id again
 *   parked, row evicted    the same (the revived session registers its job before the write returns)
 *   parked, row still held the job is in `running` at the write, under `<agent>-2`
 *   running                no new job exists: the message joins the open turn, and the original job (started before
 *                          the write) is the one that completes
 *
 * It also fixes what omp does with a write that reaches a worker as its turn is ending (see `endOfTurnScenarios`): the
 * message joins the open turn (one job), or it runs as a new job under another id that is already running in the
 * snapshot when the write returns, even while the finishing job still reads `running`. omp 19.2.1 never showed the
 * finishing job alone with the message's job appearing later.
 *
 * Usage:
 *   E2E_PORT=18795 E2E_WORK=/tmp/storm-e2e-job-snapshot ./node_modules/.bin/bun scripts/e2e/follow-up-job-snapshot.ts
 *   PROBE_ONLY=end ... runs only the end-of-turn scenarios
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelAll, modelsYml, prepare, PROFILE_CONFIG, readJsonl, Rpc, Suite, startFakeLlm, TEAM_PROVIDERS, until } from "./harness.ts";

interface JobRow {
	id?: string;
	status?: string;
	agentId?: string;
	startTime?: number;
	endTime?: number;
}
interface ProofLine {
	type?: string;
	at?: number;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	agent?: { kind?: string };
	details?: { jobs?: { jobId?: string; agentId?: string }[] };
	jobs?: { running?: JobRow[]; recent?: JobRow[] };
}

const env = prepare("storm-e2e-job-snapshot", 18795);
const suite = new Suite("E2E (follow-up job visibility at the write)", env);
const check = suite.check.bind(suite);
const plugin = join(import.meta.dir, "proof-plugin.ts");
const proofLog = join(env.work, "proof.jsonl");
env.childEnv.PROOF_CHANNEL_LOG = proofLog;
/** More than omp's 30 s eviction of a consumed job row. */
const PAST_EVICTION_MS = 36_000;

const proof = (): ProofLine[] => readJsonl<ProofLine>(proofLog);
const jobsOf = (line: ProofLine | undefined, agent: string): JobRow[] =>
	[...(line?.jobs?.running ?? []), ...(line?.jobs?.recent ?? [])].filter(job => job.agentId === agent);

async function session(idleTtlMs: number, steps: unknown[], waits: number): Promise<ProofLine[]> {
	writeFileSync(proofLog, "");
	writeFileSync(join(env.agentDir, "config.yml"), `${PROFILE_CONFIG}task:\n  batch: true\n  agentIdleTtlMs: ${idleTtlMs}\nasync:\n  enabled: true\n`);
	const rpc = new Rpc(env, cancelAll, { model: "fake/general-b", flags: ["-e", plugin], ephemeral: true });
	try {
		await rpc.ready();
		await rpc.prompt(`E2E-STEPS ${JSON.stringify(steps)}`, 150_000);
		await until(() => (proof().filter(line => line.type === "tool_result" && line.toolName === "wait").length >= waits ? true : undefined), 120_000, "the wait results");
		await Bun.sleep(1_000);
	} finally {
		await rpc.close();
	}
	return proof();
}

/** The follow-up's write result and the job rows it saw, the first delivery's job id, and the wait that returned last. */
function reading(lines: readonly ProofLine[], agent: string) {
	const write = lines.find(line => line.type === "tool_result" && line.toolName === "write");
	const firstDelivery = lines.find(line => line.type === "custom_message" && line.customType === "async-result");
	const firstJob = firstDelivery?.details?.jobs?.find(job => job.agentId === agent)?.jobId;
	const lastWait = lines.filter(line => line.type === "tool_result" && line.toolName === "wait").at(-1);
	return { write, firstJob, atWrite: jobsOf(write, agent), atLastWait: jobsOf(lastWait, agent) };
}

/**
 * What happened to a write that reached a worker as its turn was ending, from the proof log: the write's own result and
 * the job rows it saw, the child's own end-of-turn marks, and the job ids every snapshot of the run held.
 */
function endOfTurn(lines: readonly ProofLine[], agent: string) {
	const write = lines.find(line => line.type === "tool_result" && line.toolName === "write");
	const lastWait = lines.filter(line => line.type === "tool_result" && line.toolName === "wait").at(-1);
	const ids = new Set<string>();
	for (const line of lines) for (const job of jobsOf(line, agent)) if (job.id !== undefined) ids.add(job.id);
	return {
		write,
		at: write?.at ?? 0,
		rowsAtWrite: jobsOf(write, agent),
		atLastWait: jobsOf(lastWait, agent),
		ids: [...ids],
		childEnds: lines.filter(line => line.type === "agent_end" && line.agent?.kind === "sub").map(line => line.at ?? 0),
		waits: lines.filter(line => line.type === "tool_result" && line.toolName === "wait") as (ProofLine & { content?: string })[],
	};
}

/**
 * A `write agent://<id>` sent to a worker whose turn is ending (finding 2 of the ledger review). Three moments, each
 * widened from the worker's side so the director's write lands in it: the worker's final model request is held (the
 * turn is still open), an extension's end-of-turn handler is held (the model is done), and a very large final answer
 * (omp finalizes the job's result after the turn's end; the job row still reads `running` meanwhile).
 */
async function endOfTurnScenarios(): Promise<void> {
	const run = async (label: string, agent: string, hook: { delayMs?: number }, say: (marker: string) => string, attempts = 1) => {
		let seen = endOfTurn([], agent);
		for (let attempt = 1; attempt <= attempts; attempt++) {
			const marker = join(env.work, `marker-${agent}-${attempt}`);
			rmSync(marker, { force: true });
			if (hook.delayMs === undefined) delete env.childEnv.PROOF_CHILD_END_DELAY_MS;
			else {
				env.childEnv.PROOF_CHILD_END_DELAY_MS = String(hook.delayMs);
				env.childEnv.PROOF_CHILD_END_MARKER = marker;
			}
			const lines = await session(
				0,
				[
					{ tasks: [{ name: agent, agent: "task", task: "first", say: say(marker) }] },
					{ edit: `agent://${agent}`, content: "second turn E2E-CHILD-CLAIM second", holdUntilFile: marker },
					{ wait: true },
					{ wait: true },
				],
				2,
			);
			seen = endOfTurn(lines, agent);
			// The window is open when the finishing job still read `running` as the write returned.
			if (seen.rowsAtWrite.some(job => job.id === agent && job.status === "running")) break;
		}
		delete env.childEnv.PROOF_CHILD_END_DELAY_MS;
		delete env.childEnv.PROOF_CHILD_END_MARKER;
		console.log(`${label}: rows at the write ${JSON.stringify(seen.rowsAtWrite)}; ids seen ${JSON.stringify(seen.ids)}; at the last wait ${JSON.stringify(seen.atLastWait)}`);
		return seen;
	};

	await suite.step("write while the worker's final model request is pending", async () => {
		const agent = "ProbeFinal";
		const seen = await run("final request pending", agent, {}, marker => `E2E-CHILD-FINAL-PAUSE 4000 ${marker} E2E-CHILD-CLAIM first`);
		const again = seen.waits.some(wait => (wait.content ?? "").includes("second"));
		check("final request pending: the write succeeded", seen.write !== undefined && seen.write.isError !== true, JSON.stringify(seen.write?.isError));
		check(
			"final request pending: no new job; the original, still running, started before the write, took the message into its open turn",
			seen.rowsAtWrite.length === 1 && seen.rowsAtWrite[0]?.id === agent && seen.rowsAtWrite[0].status === "running" && seen.ids.length === 1,
			JSON.stringify({ rows: seen.rowsAtWrite, ids: seen.ids }),
		);
		check("final request pending: that one job delivered the answer to the message", again, JSON.stringify(seen.waits.map(wait => wait.content?.slice(0, 160))));
	}, 120_000);

	/**
	 * Wherever the write lands relative to the finishing job's own completion (a few ms either side of it), omp either
	 * joined it to the open turn or ran it as a new job under another id; and that job was already running in the parent's
	 * snapshot when the write returned. There is no moment where only the finishing job shows and a job for the message
	 * appears later, which is what a binding to the running job would mistake for the message's own turn.
	 */
	const lateWindow = (label: string, agent: string, seen: ReturnType<typeof endOfTurn>) => {
		const finishing = seen.rowsAtWrite.find(job => job.id === agent);
		const woken = seen.rowsAtWrite.filter(job => job.id !== agent);
		check(`${label}: the write succeeded`, seen.write !== undefined && seen.write.isError !== true, JSON.stringify(seen.write?.isError));
		check(
			`${label}: the message ran as a new job under another id, and that job was already in the snapshot at the write (running, started at or before its result, after the finishing job's start)`,
			woken.length === 1 && woken[0]?.id === `${agent}-2` && (woken[0].startTime ?? Infinity) <= seen.at && (woken[0].startTime ?? 0) > (finishing?.startTime ?? Infinity) &&
				seen.ids.length === 2,
			JSON.stringify({ rows: seen.rowsAtWrite, ids: seen.ids }),
		);
		check(
			`${label}: both jobs completed and were delivered`,
			seen.ids.every(id => seen.atLastWait.some(job => job.id === id && job.status === "completed")),
			JSON.stringify(seen.atLastWait),
		);
		check(
			`${label}: the finishing job read ${finishing?.status ?? "absent"} at the write (information: the window is only a few ms wide, so either is fine)`,
			finishing !== undefined && (finishing.status === "running" || finishing.status === "completed"),
			JSON.stringify(finishing),
		);
	};

	await suite.step("write while an extension holds the worker's end of turn", async () => {
		const agent = "ProbeHook";
		const seen = await run("end-of-turn handler held 4 s", agent, { delayMs: 4_000 }, () => "E2E-CHILD-CLAIM first", 3);
		lateWindow("end-of-turn handler held", agent, seen);
	}, 180_000);

	await suite.step("write while omp finalizes the worker's large answer", async () => {
		const agent = "ProbeBig";
		const seen = await run("large final answer", agent, { delayMs: 1 }, () => "E2E-CHILD-BIG 3000000", 4);
		lateWindow("large final answer", agent, seen);
	}, 240_000);
}

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, { fake: TEAM_PROVIDERS.fake }));
	if (process.env.PROBE_ONLY === "end") {
		await endOfTurnScenarios();
		return;
	}

	const woken = (agent: string, ttl: number, pauseMs: number) =>
		session(
			ttl,
			[
				{ tasks: [{ name: agent, agent: "task", task: "first", say: "E2E-CHILD-CLAIM first" }] },
				{ followUp: `agent://${agent}`, content: "second turn E2E-CHILD-CLAIM second", pauseMs },
				{ wait: true },
			],
			1,
		);

	for (const [label, ttl, pause, reused] of [
		["idle worker, job row evicted", 0, PAST_EVICTION_MS, true],
		["parked worker, job row evicted", 2_000, PAST_EVICTION_MS, true],
		["parked worker, job row still held", 2_000, 6_000, false],
	] as const) {
		await suite.step(label, async () => {
			const agent = `Probe${label.split(",")[0]?.split(" ")[0]}${reused ? "E" : "H"}`;
			const lines = await woken(agent, ttl, pause);
			const seen = reading(lines, agent);
			const running = (seen.write?.jobs?.running ?? []).filter(job => job.agentId === agent);
			const at = seen.write?.at ?? 0;
			check(`${label}: the first answer was delivered as the job named by the agent id`, seen.firstJob === agent, `${seen.firstJob}`);
			check(`${label}: the write succeeded`, seen.write !== undefined && seen.write.isError !== true, JSON.stringify(seen.write?.isError));
			check(
				`${label}: the follow-up's job is already running in the parent's snapshot at the write's tool_result`,
				running.length === 1 && running[0]?.status === "running" && typeof running[0].startTime === "number" && running[0].startTime <= at && at - running[0].startTime < 2_000,
				JSON.stringify({ at, running }),
			);
			check(
				reused ? `${label}: its job id is the agent id again` : `${label}: its job id is a new one (<agent>-2)`,
				reused ? running[0]?.id === agent : running[0]?.id === `${agent}-2`,
				JSON.stringify(running.map(job => job.id)),
			);
			check(
				`${label}: the wait delivered that job, started after the first delivery`,
				seen.atLastWait.some(job => job.id === running[0]?.id && job.status === "completed" && (job.startTime ?? 0) >= (running[0]?.startTime ?? 1)),
				JSON.stringify(seen.atLastWait),
			);
		}, 180_000);
	}

	await suite.step("running worker", async () => {
		const agent = "ProbeRunning";
		const lines = await session(
			0,
			[
				{ tasks: [{ name: agent, agent: "task", task: "first", say: "E2E-CHILD-DELAY 12000 E2E-CHILD-CLAIM first" }] },
				{ edit: `agent://${agent}` },
				{ wait: true },
				{ wait: true },
			],
			2,
		);
		const seen = reading(lines, agent);
		const at = seen.write?.at ?? 0;
		const rows = jobsOf(seen.write, agent);
		check("running worker: the write succeeded", seen.write !== undefined && seen.write.isError !== true, JSON.stringify(seen.write?.isError));
		check(
			"running worker: no new job at the write; the only one is the original, still running, started before the write",
			rows.length === 1 && rows[0]?.id === agent && rows[0].status === "running" && (rows[0].startTime ?? at) < at,
			JSON.stringify({ at, rows }),
		);
		check(
			"running worker: that original job is the one that completes",
			seen.atLastWait.length === 1 && seen.atLastWait[0]?.id === agent && seen.atLastWait[0].status === "completed" && seen.atLastWait[0].startTime === rows[0]?.startTime,
			JSON.stringify(seen.atLastWait),
		);
	}, 180_000);

	await endOfTurnScenarios();
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
process.exit(code);
