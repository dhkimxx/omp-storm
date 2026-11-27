#!/usr/bin/env bun
/**
 * A queued unplanned writer that starts after its placement's 30 s window, real host: `task.maxConcurrency: 1`, a
 * reader holds the only permit for 35 s and a writer waits behind it. When the reader ends, the writer's placement has
 * lapsed; its hook checks it again and reserves the tree, and the writer runs. A second writer placed while it runs is
 * refused for the whole call. This is V1's late-permit property, now on an unplanned writer (R5/R6, D10's neighbours).
 *
 * Usage:
 *   E2E_PORT=18904 E2E_WORK=/tmp/storm-e2e-late-permit ./node_modules/.bin/bun scripts/e2e/late-permit-unplanned.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmCursor, prepare, PROFILE_CONFIG, startFakeLlm, Suite, type Frame, type Step } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-late-permit", 18904);
seedFact(env.project);
const suite = new Suite("E2E (a late permit for an unplanned writer)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const TARGET = "late-permit.txt";
const SECOND = "late-second.txt";

const text = (frame: Frame): string => {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	return Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};

async function main(): Promise<void> {
	installProfile(env);
	writeFileSync(join(env.agentDir, "config.yml"), `${PROFILE_CONFIG}task:\n  maxConcurrency: 1\n`);
	await suite.step("approved team with automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("the queued writer starts after 30 s under its own reservation, and a second writer is refused beside it", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const started = Date.now();
			const steps: Step[] = [
				{
					tasks: [
						{ name: "permit-read", agent: "storm-explorer", task: "Hold the only permit", say: `E2E-CHILD-DELAY 35000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM permit-reader` },
						{ name: "permit-write", agent: "storm-implementer", task: "Wait behind the permit", say: `E2E-CHILD-GATE permit-a E2E-CHILD-WRITE ${TARGET} E2E-CHILD-CLAIM permit-writer` },
					],
				},
				// The fake model holds this call until the writer is at its provider gate; the writer's hook has run by then.
				{ tasks: [{ agent: "storm-implementer", task: "Try beside the writer", say: `E2E-CHILD-WRITE ${SECOND} E2E-CHILD-CLAIM second-writer` }], awaitChildren: ["permit-a"] },
				{ wait: true, releaseChildren: ["permit-a"] },
			];
			await rpc.prompt(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 240_000);
			const frames = rpc.frames;
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			const writer = routed.find(spawn => spawn.agent === "storm-implementer");
			const reader = routed.find(spawn => spawn.agent === "storm-explorer");
			const child = llm.of("child").filter(entry => entry.lastUser.includes(`E2E-CHILD-WRITE ${TARGET}`)).length > 0;
			const second = llm.of("child").filter(entry => entry.lastUser.includes(SECOND)).length;
			const taskText = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task").map(text).join("\n");
			check(
				"both placed items were routed: the reader and the late writer",
				reader !== undefined && writer !== undefined && !run.spawns.some(spawn => spawn.agent === "storm-implementer" && spawn.outcome === "blocked" && spawn.spawnKey === writer?.spawnKey),
				JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.agent, spawn.lane, spawn.outcome])),
			);
			const writerAt = writer === undefined ? undefined : Date.parse(writer.ts) - started;
			check(
				"the writer started only after its placement's 30 s window: its hook checked it again and reserved it",
				writerAt !== undefined && writerAt >= 30_000 && child,
				`writerAt=${writerAt ?? "missing"}ms childRequest=${child}`,
			);
			check("the writer's file is in the tree", existsSync(join(env.project, TARGET)) && readFileSync(join(env.project, TARGET), "utf8").includes("storm child change"), `exists=${existsSync(join(env.project, TARGET))}`);
			check(
				"the second writer's whole call was refused beside the running late writer",
				taskText.includes("[storm:lane-write]") && second === 0,
				`laneWrite=${taskText.includes("[storm:lane-write]")} secondChildren=${second} ${taskText.slice(-300)}`,
			);
		});
	}, 400_000);

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
