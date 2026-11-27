#!/usr/bin/env bun
/**
 * A lane starts before its prerequisite is accepted, real host: a disposable git checkout, an isolated HOME/profile,
 * the pinned omp and the local fake LLM. No paid model calls.
 *
 * What the user met (the run of 2026-11-26, five refusals): the director sent a lane whose prerequisite was not
 * accepted yet and Storm refused the call each time. Phase 1 lets the lane start, because the record, not the refusal,
 * keeps the count honest: the dependant remembers which version of the prerequisite it started from. Here the scripted
 * director:
 *
 *   1. plans a prerequisite lane (a typed answer) and a dependant lane that needs it (`result`),
 *   2. starts the DEPENDANT first, while the prerequisite has not run at all (its result is pending),
 *   3. starts the prerequisite; it is accepted,
 *   4. writes a follow-up to the dependant's worker, which answers again (now after the prerequisite is accepted).
 *
 * The run must show: the call that started the dependant returned and the director's next request carries the note
 * saying that its result will not be accepted until the prerequisite is; the dependant's first answer, though it cites
 * its source correctly, is recorded `unmet` with its input bound as `missing`; it stays unmet after the prerequisite is
 * accepted (checked on the live record, while the follow-up is held); and only the follow-up's answer, run after the
 * prerequisite is accepted, makes it accepted, bound to the prerequisite's real version.
 *
 * Not runnable until `src/extension.ts` carries the start notes in the result of the call (P1-c report, wiring note W1):
 * today the start is allowed by the lane gate but the note is not shown. The checks on the record already hold.
 * Only a prerequisite that has NOT answered starts the dependant: one that answered and was judged unmet still refuses
 * (see the P1x report); this scenario does not cover that case on purpose.
 *
 * Usage:
 *   E2E_PORT=18805 E2E_WORK=/tmp/storm-e2e-early-start ./node_modules/.bin/bun scripts/e2e/early-start.ts
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, RunResult } from "../../src/types.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import { LlmCursor, prepare, startFakeLlm, type Step, Suite, until } from "./harness.ts";
import { installProfile, runRequest, Sessions } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-early-start", 18805);
seedFact(env.project);
const suite = new Suite("E2E (a lane starts before its prerequisite is accepted)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const PIN = "run-20261127-111111-2b3c-lane-1";
const DEP = "run-20261127-111111-2b3c-lane-2";
const CITED = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
const answerFor = (id: string) => requiredResult(id, "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE });
const row = (run: RunRecord, id: string): RunResult | undefined => (run.results ?? []).find(candidate => candidate.id === id);
const explore = (name: string, say: string): Step => ({ tasks: [{ name, agent: "storm-explorer", task: "Report from source", say }] });

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team, automatic delegation off", async () => {
		const { teams } = await sessions.approve("off");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("the dependant starts first and is not accepted until it runs again after the prerequisite is", async () => {
		await sessions.open(() => undefined, async (rpc, files) => {
			const hold = join(env.work, "release-follow-up");
			const steps: Step[] = [
				contractPlan(
					[
						{ name: PIN, kind: "explore", results: [answerFor("pin-answer")] },
						{ name: DEP, kind: "explore", results: [answerFor("dep-answer")], dependsOn: [{ lane: PIN, need: "result" }] },
					],
					{ contract: true, workers: { explorer: 2 } },
				),
				// The dependant first: its prerequisite has not run, so before phase 1 this call was `[storm:lane-dependency]`.
				explore(DEP, CITED),
				// The dependant's first answer is delivered as a pushed message, then the prerequisite is started.
				{ ...explore(PIN, CITED), afterResult: DEP },
				{ wait: true },
				// The follow-up to the dependant is held until the test has read the record between the two answers.
				{ followUp: `agent://${DEP}`, content: `Report again now that the prerequisite is accepted. ${CITED}`, holdUntilFile: hold },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			rpc.send({ type: "prompt", message: runRequest(steps) });

			// Between the two answers of the dependant: the prerequisite is accepted and the dependant is not.
			const between = await until(() => {
				const run = files.runs().find(candidate => !before.has(candidate.runId));
				return run !== undefined && row(run, "pin-answer")?.state === "accepted" && row(run, "dep-answer") !== undefined && row(run, "dep-answer")?.state !== "pending" ? run : undefined;
			}, 120_000, "the prerequisite accepted on the live record while the dependant has answered");
			const early = row(between, "dep-answer");
			check(
				"the dependant answered with a valid citation, yet is not accepted: its input was bound as missing at the start",
				early?.state === "unmet" && early.consumed?.length === 1 && early.consumed[0]?.id === "pin-answer" && early.consumed[0]?.version === "missing",
				JSON.stringify(early),
			);
			check("and the prerequisite's acceptance did not revive it", early?.state === "unmet" && early.contentVersion === undefined, JSON.stringify(early));
			const started = (between.spawns ?? []).filter(spawn => spawn.lane === DEP && spawn.outcome !== "blocked");
			check("the dependant was started once, not refused", started.length === 1, JSON.stringify((between.spawns ?? []).map(spawn => [spawn.lane, spawn.outcome])));
			writeFileSync(hold, "go\n");

			const run = await files.finishedRun(before, 180_000);
			const main = llm.of("main");

			// The call that started the dependant returned; the director read what that start means in its next request.
			const callAt = main.findIndex(entry => entry.decision.tool === "task" && JSON.stringify(entry.decision.args ?? {}).includes(`"name":"${DEP}"`));
			const afterCall = callAt < 0 ? undefined : main[callAt + 1];
			check("the task call for the dependant was not refused", afterCall !== undefined && !afterCall.lastTool.includes("[storm:lane-dependency]"), afterCall?.lastTool.slice(0, 300) ?? "no request after the call");
			// The note names both lanes and says the result will not be accepted; its first words are not a tag (see wiring note W1).
			const told = afterCall?.users.filter(text => text.includes(`'${DEP}' 레인은 선행 '${PIN}' 레인`) && text.includes("수용되지 않습니다")) ?? [];
			check("the director's next request carries the note: the result will not be accepted, send a follow-up after the prerequisite is accepted", told.length >= 1 && told[0]!.includes("write agent://"), JSON.stringify(afterCall?.users.map(text => text.slice(0, 160))));

			const pin = row(run, "pin-answer");
			const dep = row(run, "dep-answer");
			check("the prerequisite is accepted", pin?.state === "accepted" && pin.contentVersion !== undefined, JSON.stringify(pin));
			check(
				"the dependant's follow-up, run after the prerequisite was accepted, is accepted and bound to the prerequisite's real version",
				dep?.state === "accepted" && dep.consumed?.length === 1 && dep.consumed[0]?.id === "pin-answer" && dep.consumed[0]?.version === pin?.contentVersion,
				JSON.stringify({ dep, pin: pin?.contentVersion }),
			);
			check("the dependant's accepted attempt is not its first one", dep?.attemptId !== early?.attemptId && dep?.attemptId !== undefined, JSON.stringify({ first: early?.attemptId, last: dep?.attemptId }));
			check("no row was rewritten as closed before judgment", (run.results ?? []).every(result => result.finalized !== "unsettled"), JSON.stringify((run.results ?? []).map(result => [result.id, result.state, result.finalized])));
			check("the hold file was released by the test, not by a timeout", existsSync(hold));
		});
	}, 360_000);

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
