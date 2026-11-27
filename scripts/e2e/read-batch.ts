#!/usr/bin/env bun
/**
 * A read pool with no plan, real host: six explorers in one `task` call with omp's ceiling at three
 * (`task.maxConcurrency: 3`). Every one is placed, runs, and settles; none reserves the tree and none is refused for
 * the batch. The run records them as placed workers with no declared results (`선언된 결과 없음 · 워커 6`), counts what
 * they spent, and tells the director no `결과와 무관한 도착`: Storm placed all of them.
 *
 * R6 read classification, R9 plan-less open, R11 views.
 *
 * Usage:
 *   E2E_PORT=18903 E2E_WORK=/tmp/storm-e2e-read-batch ./node_modules/.bin/bun scripts/e2e/read-batch.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NO_DECLARED_RESULTS } from "../../src/runtime/result-facts.ts";
import { closeoutOf, customMessage, LlmCursor, prepare, PROFILE_CONFIG, startFakeLlm, Suite, type Frame, type Step, until } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-read-batch", 18903);
seedFact(env.project);
const suite = new Suite("E2E (a plan-less read pool)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const COUNT = 6;

const text = (frame: Frame): string => {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	return Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};

async function main(): Promise<void> {
	installProfile(env);
	// omp's own ceiling, not Storm's: three run, three wait for a permit.
	writeFileSync(join(env.agentDir, "config.yml"), `${PROFILE_CONFIG}task:\n  maxConcurrency: 3\n`);
	await suite.step("approved team with automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("six independent explorers run in one plan-less batch, none refused, none reserving", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const tasks = Array.from({ length: COUNT }, (_, index) => ({
				agent: "storm-explorer",
				task: `Read the fixture, worker ${index}`,
				say: `E2E-CHILD-DELAY 2000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM batch-${index}`,
			}));
			const steps: Step[] = [{ tasks }, { wait: true }];
			const prompt = `E2E-STEPS ${JSON.stringify(steps)}`;
			const from = rpc.frames.length;
			await rpc.turn(prompt, 180_000);
			const run = await files.finishedRun(before, 180_000);
			const frames = rpc.frames.slice(from);
			const closeout = await until(() => closeoutOf(rpc.frames, run.runId), 10_000, "the closeout").catch(() => undefined);
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			const taskResults = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task").map(text).join("\n");
			const children = llm.of("child");
			const markers = Array.from({ length: COUNT }, (_, index) => `E2E-CHILD-CLAIM batch-${index}`);
			const seen = markers.filter(marker => children.some(entry => entry.lastUser.includes(marker))).length;
			check("the plan-less open placed six unplanned readers", run.plan === undefined && routed.length === COUNT && routed.every(spawn => spawn.lane === undefined && spawn.agent === "storm-explorer"), JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.code])));
			check("omp admitted all six: no batch refusal and no writer-order refusal", !taskResults.includes("[storm:lane-write]") && !taskResults.includes("[storm:lane-capacity]") && !taskResults.includes("[storm:parallelism]"), taskResults.slice(0, 400));
			check("all six reached the provider and read the source", seen === COUNT, `markers=${seen}/${COUNT}`);
			check("the run records six agents and their spend", (run.agents ?? []).length === COUNT && (run.costUsd ?? 0) > 0, `agents=${run.agents?.length ?? 0} cost=${run.costUsd}`);
			check("the run's own record holds no plan and no result rows", run.plan === undefined && (run.results ?? []).length === 0, JSON.stringify(run.results ?? null));
			check(
				"the views say there are no declared results and name the six workers",
				closeout !== undefined && closeout.text.includes(NO_DECLARED_RESULTS) && closeout.text.includes("워커 6"),
				closeout?.text.slice(-500) ?? "no closeout",
			);
			const noticed = llm.of("main").some(entry => entry.notes.some(note => note.includes("결과와 무관한 도착"))) || frames.some(frame => customMessage(frame) === "async-result" && JSON.stringify(frame).includes("결과와 무관한 도착"));
			check("no delivery is told as 결과와 무관한 도착: Storm placed every one of them", !noticed, "");
			// omp's ceiling is three concurrent requests; the fake provider holds each first reply two seconds.
			const starts = markers
				.flatMap(marker => {
					const first = children.filter(entry => entry.lastUser.includes(marker)).map(entry => entry.ts).sort((left, right) => left - right)[0];
					return first === undefined ? [] : [first];
				})
				.sort((a, b) => a - b);
			const peak = starts.reduce((most, at) => Math.max(most, starts.filter(other => other <= at && other + 2_000 > at).length), 0);
			check("omp's ceiling held at three, and Storm did not add a refusal on top", starts.length === COUNT && peak <= 3, `starts=${starts.length} peak=${peak}`);
		});
	}, 300_000);

	await suite.step("every omp session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	}, 60_000, { always: true });
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
