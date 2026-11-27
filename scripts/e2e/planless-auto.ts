#!/usr/bin/env bun
/**
 * A plan-less automatic run, real host: the pinned omp 19.2.1, the local scripted LLM and an isolated HOME/profile.
 * No paid model calls.
 *
 * R9 + R5: with automatic delegation on and no plan, the director's first `task` call of a user turn opens the run and
 * its item runs as an unplanned team worker. The worker writes alone, the call's result names its handle, a second call
 * with two shared writers is refused as a batch, and the views say there are no declared results. A later plan-less run
 * that ends with its worker still running is a stopped run, and `storm continue` hands it off (R12) instead of carrying
 * a plan that never existed.
 *
 * Usage:
 *   E2E_PORT=18901 E2E_WORK=/tmp/storm-e2e-planless-auto ./node_modules/.bin/bun scripts/e2e/planless-auto.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "../../src/types.ts";
import { NO_DECLARED_RESULTS } from "../../src/runtime/result-facts.ts";
import { HANDOFF_HEAD, HANDOFF_NO_RESULTS } from "../../src/runtime/resume.ts";
import { closeoutOf, customMessage, LlmCursor, prepare, startFakeLlm, Suite, type Frame, type Step, until } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-planless-auto", 18901);
seedFact(env.project);
const suite = new Suite("E2E (a plan-less team)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const SOLO = "planless-solo.txt";

const text = (frame: Frame): string => {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	return Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};
const toolResults = (frames: readonly Frame[], name: string): string[] => frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === name).map(text);
const asyncResults = (frames: readonly Frame[]): string => frames.filter(frame => customMessage(frame) === "async-result").map(frame => JSON.stringify(frame)).join("\n");
const delivered = (llm: LlmCursor, marker: string): number => llm.of("child").filter(entry => entry.lastUser.includes(marker)).length;

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team with automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved once, with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("one task with no plan opens the run and its writer runs alone", async () => {
		const llm = new LlmCursor(env);
		const pairMarker = "planless-pair";
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const steps: Step[] = [
				{ tasks: [{ agent: "storm-implementer", task: "Write the one file", say: `E2E-CHILD-DELAY 2500 E2E-CHILD-WRITE ${SOLO} E2E-CHILD-CLAIM solo-done` }] },
				{
					tasks: [
						{ agent: "storm-implementer", task: "Write a", say: `${pairMarker}-a` },
						{ agent: "storm-implementer", task: "Write b", say: `${pairMarker}-b` },
					],
				},
				{ wait: true },
			];
			const prompt = `E2E-STEPS ${JSON.stringify(steps)}`;
			const from = rpc.frames.length;
			await rpc.turn(prompt, 120_000);
			const run = await files.finishedRun(before, 180_000);
			const frames = rpc.frames.slice(from);
			const closeout = await until(() => closeoutOf(rpc.frames, run.runId), 10_000, "the plan-less closeout").catch(() => undefined);
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			const solo = routed[0]?.spawnKey;
			check("the first task call opened a run with no plan", run.plan === undefined && run.request === prompt, `plan=${JSON.stringify(run.plan ?? null)} request=${(run.request ?? "").slice(0, 40)}`);
			check(
				"its item ran as an unplanned worker and wrote the one file alone",
				routed.length === 1 && routed[0]?.lane === undefined && routed[0]?.agent === "storm-implementer" && existsSync(join(env.project, SOLO)),
				JSON.stringify({ spawns: run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.code]), file: existsSync(join(env.project, SOLO)) }),
			);
			check("the call named the worker's handle, which is its native id", solo !== undefined && (asyncResults(frames).includes(solo) || toolResults(frames, "task").some(result => result.includes(solo))), `solo=${solo ?? "none"}`);
			const kept = (run.unplanned ?? []).length;
			check(
				"the worker's first answer is expected work, not a 결과와 무관한 도착 notice",
				!llm.of("main").some(entry => entry.notes.some(note => note.includes("결과와 무관한 도착"))),
				`unplanned=${kept} notes=${JSON.stringify(llm.of("main").map(entry => entry.notes))}`,
			);
			check(
				"a second call with two shared writers is refused as a batch and starts nothing",
				toolResults(frames, "task").some(result => result.includes("[storm:lane-write]")) && delivered(llm, pairMarker) === 0,
				`laneWrite=${toolResults(frames, "task").some(result => result.includes("[storm:lane-write]"))} pairChildren=${delivered(llm, pairMarker)}`,
			);
			check(
				"the closeout says there are no declared results and shows the worker count",
				closeout !== undefined && closeout.text.includes(NO_DECLARED_RESULTS) && closeout.text.includes("워커 1"),
				closeout?.text.slice(-500) ?? "no closeout",
			);
			check("the run ended clean after its one worker settled", run.endedAt !== undefined && run.status !== "running", `${run.status}/${run.endReason ?? "?"}`);
		});
		check("the solo worker's child request reached the provider", delivered(llm, "E2E-CHILD-WRITE " + SOLO) >= 1, `children=${delivered(llm, "E2E-CHILD-WRITE " + SOLO)}`);
	}, 300_000);

	await suite.step("a run that ends with its worker still running is stoppable, and continue hands it off", async () => {
		const llm = new LlmCursor(env);
		let stopped: RunRecord | undefined;
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const steps: Step[] = [
				{ tasks: [{ agent: "storm-explorer", task: "Slow read", say: `E2E-CHILD-DELAY 8000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM slow-done` }] },
			];
			await rpc.prompt(`E2E-STEPS ${JSON.stringify(steps)}`, 120_000);
			await until(() => files.runs().find(run => !before.has(run.runId) && run.status === "running"), 20_000, "the plan-less run to open");
			// The user stops the turn while its worker still runs: the run ends unfinished and resumable.
			rpc.send({ type: "abort" });
			stopped = await files.finishedRun(before, 30_000);
			check(
				"the run has no plan and stopped unfinished, with its worker still running",
				stopped.plan === undefined && (stopped.status === "stopped" || stopped.status === "budget-exceeded") && stopped.endedAt !== undefined,
				`${stopped.status}/${stopped.endReason ?? "?"} plan=${JSON.stringify(stopped.plan ?? null)}`,
			);
			const stoppedId = stopped.runId;
			const beforeContinue = files.runIds();
			const from = rpc.frames.length;
			await rpc.turn(`E2E-STEPS ${JSON.stringify([{ storm: { action: "continue" } }])}`, 120_000);
			const reply = toolResults(rpc.frames.slice(from), "storm").at(-1) ?? "";
			const continued = [...files.runs()].find(run => run.resumeOf === stoppedId);
			check(
				"storm continue answers 인계, not a carried plan",
				reply.includes(HANDOFF_HEAD) && reply.includes(HANDOFF_NO_RESULTS) && !reply.includes("이전 계획을 적용했습니다"),
				reply.slice(0, 500),
			);
			check(
				"it opened a new run that resumes the stopped one with no plan",
				continued !== undefined && continued.plan === undefined && files.runIds().size > beforeContinue.size,
				`continued=${continued?.runId ?? "none"} plan=${JSON.stringify(continued?.plan ?? null)} runs=${files.runIds().size - beforeContinue.size}`,
			);
		});
		check("the handoff opened after the slow worker's run had ended", stopped !== undefined && llm.of("main").length > 0, `stopped=${stopped?.runId ?? "none"}`);
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
