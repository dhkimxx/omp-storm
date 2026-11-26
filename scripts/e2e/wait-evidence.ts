#!/usr/bin/env bun
/**
 * Native `wait` delivery E2E, real host: a disposable git checkout, an isolated HOME/profile, the pinned omp and the
 * local fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * A wait call consumes completed background jobs, and a host may return as soon as one child settles while another is
 * still running (seen on 19.1.1; the exercise passes on 19.2.1 either way); the other then arrives through the normal `async-result` path. This exercise therefore does
 * not require co-delivery: at least one child must be a genuine wait-consumed, source-citing result that no later
 * async-result re-delivered, and every other answer child must be accounted for by a wait or async delivery on its
 * exact host `job:<jobId>:<spawnKey>`, with both official obligations accepted there.
 *
 * A failed control runs a review lane whose reviewer yields an error. The failing child is dispatched alone so the
 * wait probe's only completion is its real failure; an independent explorer probed afterwards must stay accepted. The
 * official obligation must stay `unmet` with that exact attempt, never become an accepted answer. The deterministic
 * wrong-run, replay and aggregate-override refusals are `tests/attempt-collector.test.ts` ("native wait deliveries").
 *
 * Usage:
 *   E2E_PORT=18786 E2E_WORK=/tmp/storm-e2e-wait ./node_modules/.bin/bun scripts/e2e/wait-evidence.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import type { RunRecord, RunResult } from "../../src/types.ts";
import { contractPlan, requiredResult, type ContractLane } from "./contract-fixture.ts";
import {
	type Answer,
	cancelAll,
	choose,
	customMessage,
	type E2eEnv,
	type Frame,
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
	TRACKED_FILE,
	TRACKED_TEXT,
	until,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, FACT_TEXT, seedFact } from "./typed-fixture.ts";

const AUTO_OFF = "자동 위임 끄기";
const MAIN = "fake/general-b";
/** The typed fixture line's signed value and its citation: accepted mechanically by the official answer evidence. */
const CLAIM = FACT_CLAIM;
const READ = `E2E-CHILD-READ ${FACT_FILE}`;
const FAIL = "E2E-CHILD-YIELD-ERROR E2E wait failure control";

interface WaitJob {
	id?: string;
	type?: string;
	status?: string;
	agentUrlId?: string;
	settledAtMs?: number;
	durationMs?: number;
	resultText?: string;
	errorText?: string;
	structured?: { status?: string; error?: string; data?: unknown };
}

interface WaitFrame {
	details: { op?: string; jobs?: WaitJob[] };
}

// Assigned only when this file runs as the fixture, so the delivery audit below can be replayed against saved frames.
let env: E2eEnv;
let suite: Suite;
let check: (name: string, ok: boolean, detail?: string) => void;
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

const runRequest = (steps: Step[], rounds?: number): string =>
	`/storm E2E-ROUTE ${JSON.stringify({ action: "run", ...(rounds === undefined ? {} : { rounds }) })} E2E-STEPS ${JSON.stringify(steps)}`;
const planFor = (lanes: readonly ContractLane[], workers?: Record<string, number>): Step =>
	contractPlan(lanes, { contract: true, ...(workers === undefined ? {} : { workers }) });
const trackedAnswer = (id: string) =>
	requiredResult(id, "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE });

async function runOf(rpc: Rpc, files: StormFiles, message: string): Promise<RunRecord> {
	const before = files.runIds();
	await rpc.prompt(message);
	const run = await files.finishedRun(before);
	const reported = (): true | undefined => {
		const lastTurn = rpc.frames.findLastIndex(frame => frame.type === "agent_end");
		return rpc.frames.slice(lastTurn + 1).some(frame => customMessage(frame) === "storm-report") ? true : undefined;
	};
	await until(reported, 60_000, `the report of ${run.runId}`);
	return run;
}

/** Tool results of native `wait` calls, in order; only a `details.op:"wait"` frame is read. */
function waits(frames: readonly Frame[]): WaitFrame[] {
	const out: WaitFrame[] = [];
	for (const frame of frames) {
		if (frame.type !== "tool_execution_end" || frame.toolName !== "wait") continue;
		const result = frame.result;
		if (result === null || typeof result !== "object" || !("details" in result)) continue;
		const details = result.details;
		if (details === null || typeof details !== "object" || !("op" in details) || details.op !== "wait") continue;
		const jobs = "jobs" in details && Array.isArray(details.jobs) ? (details.jobs as WaitJob[]) : [];
		out.push({ details: { op: "wait", jobs } });
	}
	return out;
}

/** The host-owned `job:<jobId>:<spawnKey>` behind an attempt id; a role or a model label never matches. */
export function jobAttempt(attemptId: string | undefined): { jobId: string; spawnKey: string } | undefined {
	if (attemptId === undefined) return undefined;
	const parts = attemptId.split(":");
	return parts.length === 3 && parts[0] === "job" && parts[1] !== "" && parts[2] !== "" ? { jobId: parts[1], spawnKey: parts[2] } : undefined;
}

/** One terminal child job the host actually delivered: a wait row with its own result, or an async-result job. */
export interface NativeDelivery {
	channel: "wait" | "async";
	jobId: string;
	agentId: string;
	status: "completed" | "failed";
	/** The wait row's own result/error text; an async message's prose is never read. */
	text?: string;
	/** A completed wait row whose own result text carries the tracked-file claim. */
	cited: boolean;
}

/** One lane's answer child, as this run admitted it and the session actually delivered it. */
export interface ChildDelivery {
	lane: string;
	spawnKey?: string;
	result?: RunResult;
	deliveries: NativeDelivery[];
	waitDeliveries: NativeDelivery[];
	asyncDeliveries: NativeDelivery[];
	/** The official attempt id is `job:<the one observed jobId>:<spawnKey>`. */
	attemptExact: boolean;
	acceptedJobId?: string;
}

/** A wait row delivers only when the host still held a result for it; an aggregate snapshot does not. */
function rowDeliverable(job: WaitJob): boolean {
	if (typeof job.resultText === "string" && job.resultText !== "") return true;
	if (typeof job.errorText === "string" && job.errorText !== "") return true;
	const structured = job.structured;
	return structured !== null && typeof structured === "object" && (structured.status !== undefined || structured.data !== undefined || structured.error !== undefined);
}

function waitDeliveries(frames: readonly WaitFrame[]): NativeDelivery[] {
	const out: NativeDelivery[] = [];
	for (const frame of frames) {
		for (const job of frame.details.jobs ?? []) {
			if (job.type !== "task") continue;
			const jobId = typeof job.id === "string" && job.id !== "" ? job.id : undefined;
			const agentId = typeof job.agentUrlId === "string" && job.agentUrlId !== "" ? job.agentUrlId : undefined;
			const status = job.status;
			if (jobId === undefined || agentId === undefined || (status !== "completed" && status !== "failed") || !rowDeliverable(job)) continue;
			const text = status === "completed" ? job.resultText : job.errorText;
			out.push({
				channel: "wait",
				jobId,
				agentId,
				status,
				...(typeof text === "string" && text !== "" ? { text } : {}),
				cited: status === "completed" && (job.resultText ?? "").includes(CLAIM),
			});
		}
	}
	return out;
}

/** Only the structured `details.jobs[]` of an async-result message is read; its content prose is not. */
function asyncDeliveries(frames: readonly Frame[]): NativeDelivery[] {
	const out: NativeDelivery[] = [];
	for (const frame of frames) {
		if (customMessage(frame) !== "async-result") continue;
		const message = frame.message;
		if (message === null || typeof message !== "object") continue;
		const details = message.details;
		if (details === null || typeof details !== "object" || !("jobs" in details)) continue;
		const jobs = details.jobs;
		if (!Array.isArray(jobs)) continue;
		for (const job of jobs) {
			if (job === null || typeof job !== "object") continue;
			const row = job as Record<string, unknown>;
			const jobId = typeof row.jobId === "string" && row.jobId !== "" ? row.jobId : undefined;
			const agentId = typeof row.agentId === "string" && row.agentId !== "" ? row.agentId : undefined;
			const status = row.status;
			if (jobId === undefined || agentId === undefined || (status !== "completed" && status !== "failed")) continue;
			out.push({ channel: "async", jobId, agentId, status, cited: false });
		}
	}
	return out;
}

function uniqueDeliveries(deliveries: readonly NativeDelivery[]): NativeDelivery[] {
	const seen = new Set<string>();
	return deliveries.filter(delivery => {
		const key = `${delivery.channel}\0${delivery.jobId}\0${delivery.agentId}\0${delivery.status}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * The lane's one admitted spawn, its official result, and every native delivery this session saw for it. `attemptExact`
 * is true only when the official attempt names the single observed job, with this run's exact spawn key, and every
 * delivery names that same job. No text, role, label or model name is parsed for an id.
 */
export function childDelivery(run: RunRecord, frames: readonly Frame[], lane: string): ChildDelivery {
	const result = (run.results ?? []).find(candidate => candidate.lane === lane);
	const keys = run.spawns
		.filter(spawn => spawn.lane === lane && spawn.outcome !== "blocked" && typeof spawn.spawnKey === "string" && spawn.spawnKey !== "")
		.map(spawn => spawn.spawnKey as string);
	const spawnKey = keys.length === 1 ? keys[0] : undefined;
	const observed = [...waitDeliveries(waits(frames)), ...asyncDeliveries(frames)].filter(delivery => delivery.agentId === spawnKey);
	const deliveries = uniqueDeliveries(observed);
	const attempt = jobAttempt(result?.attemptId);
	const attemptExact =
		spawnKey !== undefined &&
		attempt !== undefined &&
		attempt.spawnKey === spawnKey &&
		deliveries.length > 0 &&
		deliveries.every(delivery => delivery.jobId === attempt.jobId);
	return {
		lane,
		...(spawnKey === undefined ? {} : { spawnKey }),
		...(result === undefined ? {} : { result }),
		deliveries,
		waitDeliveries: deliveries.filter(delivery => delivery.channel === "wait"),
		asyncDeliveries: deliveries.filter(delivery => delivery.channel === "async"),
		attemptExact,
		...(attempt === undefined ? {} : { acceptedJobId: attempt.jobId }),
	};
}

/** Deliveries a wait after the first still claims: a consumed job must show no fresh result here. */
export function laterWaitDeliveries(frames: readonly Frame[]): NativeDelivery[] {
	return waitDeliveries(waits(frames).slice(1));
}

/** A completed wait delivery that carried the tracked-file claim and no async-result re-delivered the same job. */
export function waitConsumedCited(child: ChildDelivery): NativeDelivery | undefined {
	return child.waitDeliveries.find(
		delivery =>
			delivery.status === "completed" &&
			delivery.cited &&
			!child.asyncDeliveries.some(other => other.jobId === delivery.jobId && other.agentId === delivery.agentId),
	);
}

/** Job ids that both a wait and an async-result delivered for the same child. */
export function redeliveredJobs(child: ChildDelivery): string[] {
	const consumed = new Set(child.waitDeliveries.map(delivery => `${delivery.jobId}\0${delivery.agentId}`));
	return child.asyncDeliveries.filter(delivery => consumed.has(`${delivery.jobId}\0${delivery.agentId}`)).map(delivery => `${delivery.jobId}:${delivery.agentId}`);
}

/** The detail a failed check needs: ids and channels only, never a result's prose. */
export function deliveryDetail(child: ChildDelivery): Record<string, unknown> {
	return {
		lane: child.lane,
		spawnKey: child.spawnKey,
		resultId: child.result?.id,
		state: child.result?.state,
		attemptId: child.result?.attemptId,
		acceptedJobId: child.acceptedJobId,
		attemptExact: child.attemptExact,
		deliveries: child.deliveries.map(delivery => ({
			channel: delivery.channel,
			jobId: delivery.jobId,
			agentId: delivery.agentId,
			status: delivery.status,
			cited: delivery.cited,
		})),
	};
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

	await suite.step("wait consumes two native answer jobs; both are accepted in the official ledger", async () => {
		await session(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				planFor([
					{ name: "impl", kind: "code", results: [trackedAnswer("routing-impl-answer")] },
					{ name: "scope", kind: "explore", results: [trackedAnswer("routing-scope-answer")] },
				], { implementer: 2 }),
				{ task: ["storm-implementer", "storm-explorer"], as: "W", say: `${READ} E2E-CHILD-CLAIM ${CLAIM}` },
				{ wait: true },
				// A second wait only sees consumed rows (no resultText); it must not replace the accepted attempts.
				{ wait: true },
			];
			const run = await runOf(rpc, files, runRequest(steps));
			const frames = waits(rpc.frames);
			const impl = childDelivery(run, rpc.frames, "impl");
			const scope = childDelivery(run, rpc.frames, "scope");
			const children = [impl, scope];
			const genuine = children.flatMap(child => {
				const delivery = waitConsumedCited(child);
				return delivery === undefined ? [] : [{ child, delivery }];
			});
			const redelivered = children.flatMap(redeliveredJobs);
			const later = laterWaitDeliveries(rpc.frames);
			// Every answer child is accounted for on the one native job the host actually delivered, and accepted there.
			const accounted = children.every(
				child =>
					child.spawnKey !== undefined &&
					child.result?.state === "accepted" &&
					child.attemptExact &&
					new Set(child.deliveries.map(delivery => delivery.jobId)).size === 1,
			);
			check(
				"the run carried both planned answer ids",
				impl.result?.id === "routing-impl-answer" && scope.result?.id === "routing-scope-answer",
				JSON.stringify(children.map(deliveryDetail)),
			);
			check(
				"at least one wait consumed a completed, source-citing child job that no async-result re-delivered",
				genuine.length >= 1 && genuine.every(({ child }) => child.result?.state === "accepted" && child.attemptExact),
				JSON.stringify({ genuine: genuine.map(({ child, delivery }) => ({ lane: child.lane, delivery, result: deliveryDetail(child) })) }),
			);
			check(
				"no wait-consumed job was re-delivered by async-result",
				redelivered.length === 0,
				JSON.stringify({ redelivered, waits: frames.map(frame => frame.details) }),
			);
			check(
				"the official ledger accepted the implementer's answer on its exact native job",
				impl.result?.state === "accepted" && impl.result.lane === "impl" && impl.attemptExact,
				JSON.stringify(deliveryDetail(impl)),
			);
			check(
				"the official ledger accepted the explorer's answer on its exact native job",
				scope.result?.state === "accepted" && scope.result.lane === "scope" && scope.attemptExact,
				JSON.stringify(deliveryDetail(scope)),
			);
			check(
				"every answer child is accounted for on one native job, by wait or async-result, and accepted there",
				accounted,
				JSON.stringify(children.map(deliveryDetail)),
			);
			check(
				"the second wait delivered no fresh result and no accepted attempt moved off its exact native job",
				frames.length === 2 && later.length === 0 && impl.attemptExact && scope.attemptExact,
				JSON.stringify({ waits: frames.map(frame => frame.details), later, impl: deliveryDetail(impl), scope: deliveryDetail(scope) }),
			);
		});
	}, 180_000);

	await suite.step("a failed reviewer wait row stays an unmet obligation, never an answer", async () => {
		await session(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				planFor([
					{ name: "scope-ok", kind: "explore", results: [trackedAnswer("scope-ok-answer")] },
					{ name: "review-fail", kind: "review", results: [trackedAnswer("review-answer")] },
				]),
				// The failing child alone: this wait's only possible completion is its real failure, not a sibling's success.
				{ tasks: [{ name: "F1", agent: "storm-reviewer", task: "Reply with OK", say: `${READ} E2E-CHILD-CLAIM ${CLAIM} ${FAIL}` }] },
				{ wait: true },
				// An independent accepted child, probed only after the failure has already settled.
				{ tasks: [{ name: "F0", agent: "storm-explorer", task: "Reply with OK", say: `${READ} E2E-CHILD-CLAIM ${CLAIM}` }] },
				{ wait: true },
			];
			const run = await runOf(rpc, files, runRequest(steps, 1));
			const frames = waits(rpc.frames);
			const review = childDelivery(run, rpc.frames, "review-fail");
			const control = childDelivery(run, rpc.frames, "scope-ok");
			const failed = review.waitDeliveries.find(delivery => delivery.status === "failed" && delivery.text !== undefined);
			const cited = waitConsumedCited(control);
			const controlDelivery = cited ?? control.asyncDeliveries.find(delivery => delivery.status === "completed");
			const later = laterWaitDeliveries(rpc.frames);
			const attempt = jobAttempt(review.result?.attemptId);
			const failedJobId = failed?.jobId;
			const failedAgentId = failed?.agentId;
			const noLaterFailure = failedJobId === undefined || failedAgentId === undefined || !later.some(delivery => delivery.jobId === failedJobId && delivery.agentId === failedAgentId);
			check(
				"the failing child's own wait probe observed its real failed job, with no async-result re-delivery",
				failed !== undefined && review.waitDeliveries.length === 1 && review.asyncDeliveries.length === 0 && review.spawnKey !== undefined && noLaterFailure,
				JSON.stringify({ review: deliveryDetail(review), failed, waits: frames.map(frame => frame.details) }),
			);
			check(
				"the failed review obligation is unmet with that exact attempt, never accepted",
				review.result?.state === "unmet" &&
					review.result.lane === "review-fail" &&
					review.attemptExact &&
					attempt !== undefined &&
					failed !== undefined &&
					attempt.jobId === failed.jobId &&
					attempt.spawnKey === review.spawnKey &&
					(review.result.reason ?? "").trim() !== "",
				JSON.stringify({ review: deliveryDetail(review), failed }),
			);
			check(
				"the independent positive control is accounted for by a completed wait or async delivery",
				controlDelivery !== undefined && control.deliveries.length > 0,
				JSON.stringify({ control: deliveryDetail(control), cited }),
			);
			check(
				"the independent positive control stayed accepted on its exact native job",
				control.result?.state === "accepted" && control.result.lane === "scope-ok" && control.attemptExact,
				JSON.stringify({ control: deliveryDetail(control) }),
			);
		});
	}, 180_000);

	await suite.step("every OMP session exited cleanly", async () => {
		check("no session exited non-zero", exitCodes.length > 0 && exitCodes.every(code => code === 0), `exit=${exitCodes.join(",")}`);
		// The project's tracked fixture is read-only in this exercise; no wait path changed it.
		check("the tracked fixture stayed byte-identical", readFileSync(join(env.project, TRACKED_FILE), "utf8") === TRACKED_TEXT, `bytes=${readFileSync(join(env.project, TRACKED_FILE)).length}`);
		check("the typed answer fixture stayed byte-identical", readFileSync(join(env.project, FACT_FILE), "utf8") === FACT_TEXT, `bytes=${readFileSync(join(env.project, FACT_FILE)).length}`);
	});
}

if (import.meta.main) {
	env = prepare("storm-e2e-wait", 18786);
	seedFact(env.project);
	suite = new Suite("E2E (native wait delivery)", env);
	check = suite.check.bind(suite);
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
}
