#!/usr/bin/env bun
/**
 * Deliveries nobody planned, real host: a disposable git checkout, an isolated HOME/profile, the pinned omp and the local
 * fake LLM. No paid model calls.
 *
 * What the user met (the worker-messages probe C): an explorer had answered its lane and was woken again; its second
 * answer reached the director through omp's own `async-result`, and Storm dropped it: the run record showed nothing. Phase 1
 * records such a delivery as unplanned and tells the director once. What omp 19.2.1 really does, seen in this scenario:
 *
 *   A. Deliveries Storm itself asked for are not unplanned: a review lane has no declared result, yet its worker's verdict and
 *      its answer to a follow-up the director sent are expected. The run records none and the director reads no notice.
 *      (The first run of this scenario found the opposite: every reviewer delivery was told as "no result", a refused spawn
 *      too, and the closeout counted them.)
 *   B. Another worker's message wakes a worker, but omp sends its answer back to the worker that wrote (an `irc:incoming`
 *      message in that worker's session, `wakeRelay`), not to the director: the director cannot see it, so Storm cannot
 *      record it and the run keeps no unplanned delivery.
 *   C. The director's own quiet note (`?progress`) or broadcast (`agent://all`) wakes an idle worker the same way: its
 *      answer is delivered to no one the director reads. Nothing is recorded either.
 *   A delivery of kind `woken` therefore has no way to arise from these paths on this host; it is held by the collector's
 *   unit tests (`tests/unplanned-deliveries.test.ts`) and was not reproduced on the real host. If a later omp sends those
 *   answers to the director, B and C fail here and the record has to be looked at again.
 *
 * Usage:
 *   E2E_PORT=18803 E2E_WORK=/tmp/storm-e2e-unplanned ./node_modules/.bin/bun scripts/e2e/unplanned.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../../src/types.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import { cancelAll, LlmCursor, prepare, startFakeLlm, type Step, stormRecords, Suite } from "./harness.ts";
import { installProfile, runRequest, Sessions } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-unplanned", 18803);
seedFact(env.project);
const suite = new Suite("E2E (a worker's second answer is recorded as an unplanned delivery)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const W_FILE = "e2e-woken-writer.txt";
/** The one word the woken explorer answers with. */
const WOKEN = "E2E-WOKEN-ANSWER-7";
const PING = "please-look-again";

const row = (rows: readonly RunResult[] | undefined, id: string): RunResult | undefined => (rows ?? []).find(candidate => candidate.id === id);
const lookResult = requiredResult("look-answer", "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE });
const lookTaskFor = (lane: string) => ({ name: lane, agent: "storm-explorer", task: "Report from source", say: `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}\nE2E-WAKE-CLAIM ${WOKEN}` });

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team, automatic delegation off", async () => {
		const { teams } = await sessions.approve("off");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("A: a review lane's verdict and its answer to a follow-up are expected deliveries: nothing is recorded as unplanned, no notice", async () => {
		// A lane name is used once in this native session; each scenario names its own lanes.
		const look = "look-a";
		const review = "review-a";
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan(
					[
						{ name: look, kind: "explore", results: [lookResult] },
						{ name: review, kind: "review" },
					],
					{ contract: true, workers: { explorer: 1, reviewer: 1 } },
				),
				{ tasks: [lookTaskFor(look)] },
				{ wait: true },
				{ tasks: [{ name: review, agent: "storm-reviewer", task: "Review", say: "E2E-CHILD-VERDICT correct" }] },
				{ wait: true },
				// The director asks the reviewer again: its second answer is the follow-up's, expected as well.
				{ edit: `agent://${review}`, content: "review once more" },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps, 1), 240_000);
			const run = await files.finishedRun(before);
			const main = llm.of("main");
			check("no delivery is recorded as unplanned (a review lane has no declared result; its deliveries were asked for)", (run.unplanned ?? []).length === 0 && run.unplannedCount === undefined, JSON.stringify({ unplanned: run.unplanned ?? null, count: run.unplannedCount }));
			check("the director read no notice about an unplanned delivery", !main.some(entry => entry.notes.some(text => text.includes("결과와 무관한 도착"))), JSON.stringify(main.map(entry => entry.notes)));
			const lookKey = run.spawns.find(entry => entry.lane === look && entry.outcome !== "blocked")?.spawnKey;
			check("the explorer's result row is accepted on its first attempt", row(run.results, "look-answer")?.state === "accepted" && lookKey !== undefined && row(run.results, "look-answer")?.attemptId === `job:${lookKey}:${lookKey}`, JSON.stringify({ row: row(run.results, "look-answer") ?? null, spawnKey: lookKey ?? null }));
			const from = rpc.frames.length;
			await rpc.prompt("/storm status");
			const text = stormRecords(rpc.frames, from).at(-1)?.text ?? "";
			check("the status says nothing about deliveries tied to no result", !text.includes("결과와 무관한 도착"), text.slice(0, 300));
		});
	}, 300_000);

	await suite.step("B: another worker's message wakes it: the answer goes back to that worker, the director is not told", async () => {
		const look = "look-b";
		const writer = "writer-b";
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan(
					[
						{ name: look, kind: "explore", results: [lookResult] },
						{ name: writer, kind: "code", files: [W_FILE], results: [requiredResult("writer-change", "change", `the implementer wrote ${W_FILE}`, { path: W_FILE, contains: "storm child change" })] },
					],
					{ contract: true, workers: { explorer: 1, implementer: 1 } },
				),
				{ tasks: [lookTaskFor(look)] },
				{ wait: true },
				// The implementer messages the idle explorer before it writes its own file; omp wakes the explorer.
				{ tasks: [{ name: writer, agent: "storm-implementer", task: "Change one file", say: `E2E-CHILD-SEND @storm-explorer ${PING} E2E-CHILD-WRITE ${W_FILE}` }] },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps, 1), 240_000);
			const run = await files.finishedRun(before);
			const writerKey = run.spawns.find(entry => entry.lane === writer && entry.outcome !== "blocked")?.spawnKey;
			await Bun.sleep(3_000);
			const writerLog = writerKey === undefined ? undefined : [...new Bun.Glob(`**/${writerKey}.jsonl`).scanSync({ cwd: join(env.work, "sessions"), absolute: true })].at(-1);
			const relayed = writerLog === undefined ? "" : readFileSync(writerLog, "utf8");
			check(
				"the explorer's second answer came back to the implementer that woke it, as an irc message",
				relayed.includes("irc:incoming") && relayed.includes(WOKEN),
				writerLog === undefined ? "no implementer session file" : `file=${writerLog.slice(-60)} irc=${relayed.includes("irc:incoming")} word=${relayed.includes(WOKEN)}`,
			);
			check("the director never received it, so the run records no unplanned delivery", (run.unplanned ?? []).length === 0 && !llm.of("main").some(entry => entry.lastUser.startsWith("<system-notice>") && entry.lastUser.includes(WOKEN)), JSON.stringify(run.unplanned ?? null));
			check("both planned results were accepted as they came", row(run.results, "look-answer")?.state === "accepted" && row(run.results, "writer-change")?.state === "accepted", JSON.stringify((run.results ?? []).map(result => [result.id, result.state])));
		});
	}, 300_000);

	await suite.step("C: the director's quiet note and its broadcast wake an answered explorer: its answer reaches the director nowhere, nothing is recorded", async () => {
		const look = "look-c";
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan([{ name: look, kind: "explore", results: [lookResult] }], { contract: true, workers: { explorer: 1 } }),
				{ tasks: [lookTaskFor(look)] },
				{ wait: true },
				{ edit: "agent://@storm-explorer?progress", content: PING },
				{ edit: "agent://all", content: PING },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps, 1), 240_000);
			const run = await files.finishedRun(before);
			await Bun.sleep(3_000);
			const woken = llm.of("child").filter(entry => entry.decision.text === WOKEN).length;
			check("the explorer was woken and answered (the fake model saw it)", woken >= 1, `answers=${woken}`);
			check("the answer reached the director in no message of its own", !llm.of("main").some(entry => entry.lastUser.startsWith("<system-notice>") && entry.lastUser.includes(WOKEN)), JSON.stringify(llm.of("main").map(entry => entry.lastUser.slice(0, 50))));
			check("so the run records no unplanned delivery", (run.unplanned ?? []).length === 0, JSON.stringify(run.unplanned ?? null));
		});
	}, 300_000);

	await suite.step("every OMP session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
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
process.exit(code);
