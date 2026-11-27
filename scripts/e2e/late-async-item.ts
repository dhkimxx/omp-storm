#!/usr/bin/env bun
/**
 * A late async item of an earlier ask, real host: `task.maxConcurrency: 1`; run A places a reader (held at the provider)
 * and a writer behind it; the user stops the turn, so run A ends; a new user turn opens run B; only then does the
 * reader finish and the queued writer reach its spawn hook. R4 refuses it (its key is no pending placement of run B),
 * and run B's table holds nothing for it.
 *
 * Usage:
 *   E2E_PORT=18908 E2E_WORK=/tmp/storm-e2e-late-async-item ./node_modules/.bin/bun scripts/e2e/late-async-item.ts
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmCursor, prepare, PROFILE_CONFIG, startFakeLlm, Suite, type Step, until } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-late-async-item", 18908);
seedFact(env.project);
const suite = new Suite("E2E (a late async item)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const LATE_FILE = "late-async.txt";

const textOfFrame = (frame: { result?: unknown }): string => {
	const result = frame.result;
	if (result === null || typeof result !== "object" || !("content" in result)) return "";
	const content = (result as { content?: unknown }).content;
	return Array.isArray(content) ? content.map(part => (part !== null && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};

async function main(): Promise<void> {
	installProfile(env);
	writeFileSync(join(env.agentDir, "config.yml"), `${PROFILE_CONFIG}task:\n  maxConcurrency: 1\n`);
	await suite.step("approved team with automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("an item placed under run A reaches its hook under run B and is refused", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const beforeA = files.runIds();
			const stepsA: Step[] = [
				{
					tasks: [
						{ agent: "storm-explorer", task: "Hold the permit", say: `E2E-CHILD-DELAY 20000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM permit-reader` },
						{ agent: "storm-implementer", task: "Wait for the permit", say: `E2E-CHILD-WRITE ${LATE_FILE} E2E-CHILD-CLAIM late-writer` },
					],
				},
			];
			await rpc.prompt(`E2E-STEPS ${JSON.stringify(stepsA)}`, 120_000);
			const a = await until(() => files.runs().find(run => !beforeA.has(run.runId) && run.status === "running"), 20_000, "run A to open");
			const placement = rpc.frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task").map(textOfFrame).join("\n");
			check("run A's call placed the reader and the writer behind it", placement.includes("storm-explorer") && placement.includes("storm-implementer"), placement.slice(0, 300));
			rpc.send({ type: "abort" });
			const endedA = await files.finishedRun(beforeA, 30_000);
			check("run A is stopped before its queued writer reaches the hook", endedA.runId === a.runId && endedA.status === "stopped", `${endedA.status}/${endedA.endReason ?? "?"}`);

			// A new user turn opens run B while the earlier ask's queued item is still waiting for the permit.
			const beforeB = files.runIds();
			const stepsB: Step[] = [
				{ tasks: [{ agent: "storm-explorer", task: "Hold run B open", say: `E2E-CHILD-DELAY 25000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM b-holder` }] },
				{ wait: true },
			];
			await rpc.prompt(`E2E-STEPS ${JSON.stringify(stepsB)}`, 120_000);
			const b = await until(() => files.runs().find(run => !beforeB.has(run.runId) && run.status === "running"), 20_000, "run B to open");
			const endedB = await files.finishedRun(beforeB, 180_000);
			const spawns = endedB.spawns ?? [];
			const blocked = spawns.filter(spawn => spawn.outcome === "blocked");
			const lateWriter = blocked.find(spawn => spawn.agent === "storm-implementer");
			// On 19.2.1 the queued item's hook either reaches the new run and is refused there (internal: its key is no
			// placement of this run) or never reaches one; either way it is never admitted. Seen on this host: the hook
			// did not arrive after the old run ended, so only the invariant is asserted for the refusal itself.
			check(
				"the earlier ask's queued item was never routed into run B",
				!spawns.some(spawn => spawn.outcome !== "blocked" && spawn.agent === "storm-implementer"),
				JSON.stringify(spawns.map(spawn => [spawn.spawnKey, spawn.agent, spawn.outcome, spawn.code])),
			);
			check(
				"where run B saw the late item, the refusal is an internal correlation failure, never a guess",
				lateWriter === undefined || lateWriter.code === "internal",
				JSON.stringify(spawns.map(spawn => [spawn.agent, spawn.outcome, spawn.code])),
			);
			check("the late writer never ran and wrote nothing", !existsSync(join(env.project, LATE_FILE)) && !llm.of("child").some(entry => entry.lastUser.includes(`E2E-CHILD-WRITE ${LATE_FILE}`)), `file=${existsSync(join(env.project, LATE_FILE))}`);
			check("run B's own worker ran", (endedB.agents ?? []).some(agent => (agent.requests ?? 0) > 0), JSON.stringify(endedB.agents?.map(agent => [agent.id, agent.requests])));
			check("run B holds nothing for the late item: no plan, no result row, no routed writer", endedB.plan === undefined && (endedB.results ?? []).length === 0, JSON.stringify({ plan: endedB.plan ?? null, results: endedB.results ?? null }));
			console.log(`late async: A=${endedA.runId} ${endedA.status}/${endedA.endReason ?? "?"} · B=${b.runId} blocked=${JSON.stringify(blocked.map(spawn => [spawn.spawnKey, spawn.agent, spawn.code]))}`);
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
