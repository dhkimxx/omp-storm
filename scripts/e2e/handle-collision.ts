#!/usr/bin/env bun
/**
 * Two plan-less items with the same name, a reader and a writer, real host. Placement gives each its own run-unique
 * handle (R4/D6), so omp's own `<name>-2` dedupe never decides which spawn is which and a reader can never take the
 * writer's place. The reader's hook binds only its own read placement; the writer is still admitted; and a second
 * writer placed while the real one runs is refused for the whole call.
 *
 * Usage:
 *   E2E_PORT=18905 E2E_WORK=/tmp/storm-e2e-handle-collision ./node_modules/.bin/bun scripts/e2e/handle-collision.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LlmCursor, prepare, startFakeLlm, Suite, type Frame, type Step } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-handle-collision", 18905);
seedFact(env.project);
const suite = new Suite("E2E (two items, one name)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const TARGET = "collision.txt";

const text = (frame: Frame): string => {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	return Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team with automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("a reader and a writer with one name get separate handles, and the writer keeps its place", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const steps: Step[] = [
				{
					tasks: [
						{ name: "Same", agent: "storm-explorer", task: "Read the fixture", say: `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM reader-same` },
						{ name: "Same", agent: "storm-implementer", task: "Write the file", say: `E2E-CHILD-DELAY 5000 E2E-CHILD-WRITE ${TARGET} E2E-CHILD-CLAIM writer-same` },
					],
				},
				{ tasks: [{ agent: "storm-implementer", task: "Write a second file", say: "E2E-CHILD-CLAIM second-writer" }] },
				{ wait: true },
			];
			const from = rpc.frames.length;
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 180_000);
			const run = await files.finishedRun(before, 180_000);
			const frames = rpc.frames.slice(from);
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			const reader = routed.find(spawn => spawn.agent === "storm-explorer");
			const writer = routed.find(spawn => spawn.agent === "storm-implementer");
			const taskResults = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task").map(text).join("\n");
			check(
				"both items were routed under distinct handles, the reader first",
				routed.length === 2 && reader !== undefined && writer !== undefined && reader.spawnKey !== writer.spawnKey && routed[0]?.agent === "storm-explorer" && routed[1]?.agent === "storm-implementer",
				JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.agent, spawn.outcome])),
			);
			check(
				"neither was refused: the reader did not take the writer's place",
				run.spawns.every(spawn => spawn.outcome !== "blocked"),
				JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.agent, spawn.outcome, spawn.code])),
			);
			check("the writer's file is in the tree", existsSync(join(env.project, TARGET)) && readFileSync(join(env.project, TARGET), "utf8").includes("storm child change"), `exists=${existsSync(join(env.project, TARGET))}`);
			check(
				"the second writer call was refused for the whole call while the real writer ran",
				taskResults.includes("[storm:lane-write]") && taskResults.includes(writer?.spawnKey ?? "no-writer") && !llm.of("child").some(entry => entry.lastUser.includes("E2E-CHILD-CLAIM second-writer")),
				`laneWrite=${taskResults.includes("[storm:lane-write]")} writer=${writer?.spawnKey ?? "none"} ${taskResults.slice(-400)}`,
			);
			check("the reader and the writer each ran once", routed.length === 2 && (run.agents ?? []).length === 2, `agents=${run.agents?.length ?? 0}`);
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
