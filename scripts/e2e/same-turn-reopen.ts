#!/usr/bin/env bun
/**
 * The same-turn rule on the real host (R9, F1, Q8): a run stops on the user's budget in mid-turn; from then nothing
 * new opens until the user speaks again, and a new prompt opens a run.
 *
 * Host fact seen here (reported): the budget stop aborts the director's turn, and omp does not wake that aborted turn
 * when its two background workers settle — they end as failed jobs ("Interrupted by user") and no director request
 * follows. So the scenario's earlier shape (a late delivery wakes the director, whose `task` and `storm plan` are
 * refused in the same turn) is not observable on 19.2.1; the same-turn refusal itself is held by the controller's Q8
 * tests and the hook test. What this scenario shows is the rule's effect: no run opens until the user speaks, and the
 * user's next prompt opens one.
 *
 * Usage:
 *   E2E_PORT=18902 E2E_WORK=/tmp/storm-e2e-same-turn ./node_modules/.bin/bun scripts/e2e/same-turn-reopen.ts
 */
import { APPROVE } from "../../src/proposals/present.ts";
import { choose, closeoutOf, LlmCursor, prepare, startFakeLlm, Suite, type Frame, type Step, until } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-same-turn", 18902);
seedFact(env.project);
const suite = new Suite("E2E (same-turn reopen)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const text = (frame: Frame): string => {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	return Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};
const route = (reply: Record<string, unknown>, rest = "please"): string => `/storm E2E-ROUTE ${JSON.stringify(reply)} ${rest}`;

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team with automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("a budget stop aborts the turn; the two woken starts are refused until the user speaks again", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(choose(APPROVE), async (rpc, files) => {
			// A limit one request below two director requests, so the stop lands after the workers are placed.
			await rpc.prompt(route({ action: "budget", budgetUsd: 0.0004, onExceed: "stop" }, "cap this run"));
			check("the budget is set through its approval dialog", files.config().budget?.onExceed === "stop" && files.config().budget?.perRunUsd === 0.0004, JSON.stringify(files.config().budget));
			const before = files.runIds();
			const steps: Step[] = [
				{
					tasks: [
						{ agent: "storm-explorer", task: "Wake one", say: `E2E-CHILD-DELAY 5000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM first-worker-done` },
						{ agent: "storm-explorer", task: "Wake two", say: `E2E-CHILD-DELAY 8000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM second-worker-done` },
					],
				},
				// This request pushes observed spend past the limit; the controller aborts the turn here. The pause lets
				// omp run both spawn hooks first, so the two workers are live when the stop lands.
				{ read: FACT_FILE, pauseMs: 1500 },
				// These would be the woken turn's starts; the host does not wake the aborted turn, so they must never run.
				{ tasks: [{ agent: "storm-implementer", task: "Start again", say: "E2E-CHILD-CLAIM woken-task" }] },
				{ storm: { action: "plan", plan: { lanes: [{ name: "reopen", kind: "explore", results: [{ id: "reopen-answer", kind: "answer", criterion: "the fixture line", path: FACT_FILE, contains: "tracked_delta" }] }] } } },
			];
			const from = rpc.frames.length;
			await rpc.prompt(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const stopped = await files.finishedRun(before, 60_000);
			check("the run stopped on the budget at the end of the aborted turn", stopped.status === "budget-exceeded" && stopped.endReason === "budget", `${stopped.status}/${stopped.endReason ?? "?"}`);
			// Both workers settle after the stop; their jobs end failed because the turn was aborted. No director request
			// follows them: the aborted turn is not woken, and no woken task or plan call is ever made.
			// The two workers' held replies are 5 s and 8 s; let both jobs settle before judging the turn.
			await Bun.sleep(10_000);
			const afterStop = llm.of("main").filter(entry => entry.ts > Date.parse(stopped.endedAt ?? ""));
			check("the aborted turn is not woken by its workers' late jobs: no director request follows the stop", afterStop.length === 0, `afterStop=${afterStop.length} results=${rpc.frames.slice(from).filter(frame => frame.type === "tool_execution_end").map(text).filter(text => text.includes("실행")).map(text => text.slice(0, 100)).join(" | ")}`);
			check("no new run opened in the same user turn", files.runIds().size === 1, `runs=${files.runIds().size}`);
			check("the scripted woken starts never ran", !llm.of("child").some(entry => entry.lastUser.includes("E2E-CHILD-CLAIM woken-task")), `children=${llm.of("child").length}`);
			const closeout = await until(() => closeoutOf(rpc.frames, stopped.runId), 10_000, "the stopped closeout").catch(() => undefined);
			check("the closeout names the budget stop", closeout !== undefined && (closeout.text.includes("예산") || closeout.text.includes("중단")), closeout?.text.slice(-300) ?? "no closeout");

			// The user speaks again: drop the cap and open a run with one read task.
			await rpc.prompt(route({ action: "budget", budgetUsd: 0 }, "drop the cap"));
			check("the cap is removed", files.config().budget === undefined, JSON.stringify(files.config().budget));
			const beforeNew = files.runIds();
			const next: Step[] = [
				{ tasks: [{ agent: "storm-explorer", task: "Read after the user spoke", say: `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM after-user` }] },
				{ wait: true },
			];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(next)}`, 180_000);
			const opened = await files.finishedRun(beforeNew, 120_000);
			check("a new user prompt opens a new run", files.runIds().size === 2 && opened.runId !== stopped.runId && opened.plan === undefined, `runs=${files.runIds().size} new=${opened.runId} plan=${JSON.stringify(opened.plan ?? null)}`);
			const children = llm.of("child").filter(entry => entry.lastUser.includes("E2E-CHILD-CLAIM after-user")).length;
			check("its worker ran", children > 0, `children=${children}`);
		});
	}, 500_000);

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
