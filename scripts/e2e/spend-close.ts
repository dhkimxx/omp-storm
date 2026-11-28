#!/usr/bin/env bun
/**
 * The budget stop written to disk and read by workers (R15), real host. Two runs set a limit with each of the user's
 * two choices:
 *
 * - `block-spawns`: the limit is reached while two workers run; the run's close receipt carries that choice; every
 *   `agent://` message is refused with `[storm:budget]`, a quiet `?progress` note included, and so is a new `task`.
 * - `stop`: the receipt carries `stop`, and the director's own turn is aborted at the limit. omp then ends the jobs of
 *   that aborted turn, so no later request of theirs is sent: the worker guard's request abort is held by the unit
 *   tests and the hook tests; what this host shows is the marker and the ended turn.
 *
 * Usage:
 *   E2E_PORT=18906 E2E_WORK=/tmp/storm-e2e-spend-close ./node_modules/.bin/bun scripts/e2e/spend-close.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import { SPEND_TAG, SPEND_USER_STOP_WORD } from "../../src/policy/spend-close.ts";
import { choose, LlmCursor, prepare, startFakeLlm, Suite, type Frame, type Step, until } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-spend-close", 18906);
seedFact(env.project);
const suite = new Suite("E2E (the budget stop reaches workers)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const route = (reply: Record<string, unknown>, rest = "please"): string => `/storm E2E-ROUTE ${JSON.stringify(reply)} ${rest}`;

const text = (frame: Frame): string => {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	return Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};

/** The one close receipt of this run on disk: written once, keyed by the run id, never in the run marker. */
function closeOf(runId: string): { schema?: string; at?: number; onExceed?: string } | undefined {
	const dir = join(env.agentDir, "storm", "admissions", "closes");
	if (!existsSync(dir)) return undefined;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (typeof value !== "object" || value === null || !("runId" in value) || value.runId !== runId) continue;
			if (!("close" in value) || typeof value.close !== "object" || value.close === null) return {};
			const close = value.close;
			return {
				...( "schema" in value && typeof value.schema === "string" ? { schema: value.schema } : {}),
				...( "at" in close && typeof close.at === "number" ? { at: close.at } : {}),
				...( "onExceed" in close && typeof close.onExceed === "string" ? { onExceed: close.onExceed } : {}),
			};
		} catch {
			// A receipt another run is writing, or a foreign file: not this run's fact.
		}
	}
	return undefined;
}
const taskResults = (frames: readonly Frame[]): string => frames.filter(frame => frame.type === "tool_execution_end" && (frame.toolName === "task" || frame.toolName === "write")).map(text).join("\n");

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team with automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("block-spawns: the marker is set; a quiet note passes and work is refused", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(choose(APPROVE), async (rpc, files) => {
			await rpc.prompt(route({ action: "budget", budgetUsd: 0.0004, onExceed: "block-spawns" }, "cap this run"));
			check("the block-spawns limit is approved", files.config().budget?.onExceed === "block-spawns" && files.config().budget?.perRunUsd === 0.0004, JSON.stringify(files.config().budget));
			const before = files.runIds();
			const steps: Step[] = [
				{
					tasks: [
						{ agent: "storm-explorer", task: "One", say: `E2E-CHILD-DELAY 2000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM first` },
						{ agent: "storm-explorer", task: "Two", say: `E2E-CHILD-DELAY 2500 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM second` },
					],
				},
				// Let both hooks run, then cross the limit with another director request.
				{ read: FACT_FILE, pauseMs: 1200 },
				{ wait: true },
				// A quiet progress note is not new work: it passes and wakes the idle worker read-only.
				// The pause lets the workers settle in the host's registry: the next calls must meet an idle worker.
				{ edit: "agent://@storm-explorer?progress", content: "quiet-note", pauseMs: 2000 },
				// Work-bearing messages and a new spawn are new work: both refused after the close.
				// The quiet wake turns the worker read-only; let it finish so the work message meets an idle worker.
				{ followUp: "agent://@storm-explorer", content: "wake-and-work", pauseMs: 3000 },
				{ tasks: [{ agent: "storm-explorer", task: "New worker", say: "E2E-CHILD-CLAIM new-worker" }] },
			];
			const from = rpc.frames.length;
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 120_000);
			const frames = rpc.frames.slice(from);
			const close = await until(() => closeOf(run.runId), 10_000, "the run's close receipt").catch(() => undefined);
			check("the run's close receipt carries the user's block choice", close?.schema === "storm.worker-spend-close/v1" && close.onExceed === "block-spawns", JSON.stringify(close ?? null));
			const results = taskResults(frames);
			// B3: after the close no message reaches a worker, a quiet progress note included.
			const progressRefused = frames
				.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "write")
				.map(text)
				.some(value => value.includes("[storm:budget]") || value.includes(SPEND_TAG));
			check("the quiet progress note is refused too", progressRefused, results.slice(-400));
			const refusedWork = frames
				.filter(frame => frame.type === "tool_execution_end" && (frame.toolName === "write" || frame.toolName === "task"))
				.map(text)
				.filter(value => value.includes("[storm:budget]") || value.includes(SPEND_TAG));
			const budgetSpawn = (run.spawns ?? []).some(spawn => spawn.outcome === "blocked" && spawn.code === "budget");
			check("the work-bearing message and the new task are refused at the limit", refusedWork.length >= 1 && budgetSpawn, JSON.stringify({ refusals: refusedWork.map(value => value.slice(0, 120)), spawns: run.spawns.map(spawn => [spawn.spawnKey, spawn.outcome, spawn.code]) }));
			check("the woken worker did not run new work", !llm.of("child").some(entry => entry.lastUser.includes("wake-and-work") || entry.lastUser.includes("E2E-CHILD-CLAIM new-worker")), `children=${llm.of("child").length}`);
			// block-spawns does not cut the current turn: the note, the work send and the new task all ran after the close.
			const afterClose = llm.of("main").filter(entry => entry.ts > (close?.at ?? 0)).length;
			check("the current turn kept going after the close; only new work was refused", afterClose >= 3, `afterClose=${afterClose} status=${run.status}/${run.endReason ?? "?"}`);
		});
	}, 400_000);

	await suite.step("stop: the marker carries stop and the director's turn is aborted at the limit", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(choose(APPROVE), async (rpc, files) => {
			await rpc.prompt(route({ action: "budget", budgetUsd: 0.0004, onExceed: "stop" }, "stop this run at the limit"));
			check("the stop choice is approved", files.config().budget?.onExceed === "stop", JSON.stringify(files.config().budget));
			const before = files.runIds();
			const steps: Step[] = [
				{ tasks: [{ agent: "storm-explorer", task: "One", say: `E2E-CHILD-DELAY 4000 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM stopped-worker` }] },
				{ read: FACT_FILE, pauseMs: 1200 },
			];
			await rpc.prompt(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 120_000);
			const close = await until(() => closeOf(run.runId), 10_000, "the run's close receipt").catch(() => undefined);
			check("the run ended on the budget", run.status === "budget-exceeded" && run.endReason === "budget", `${run.status}/${run.endReason ?? "?"}`);
			check("the close receipt carries the user's stop choice", close?.onExceed === "stop", JSON.stringify(close ?? null));
			// The host aborts the turn's own jobs, so the worker is cancelled with the turn and never sends a request Storm
			// could abort: the D9 notice is held by the unit and hook tests, not observable here (reported).
			check("the stopped turn left no delivery claiming the user interrupted it by hand", !rpc.frames.some(frame => JSON.stringify(frame).includes(SPEND_USER_STOP_WORD)), "");
			// The aborted turn's worker job settles; whatever the host does with its later request, it never answers the run.
			await Bun.sleep(6_000);
			const agent = (run.agents ?? [])[0];
			check("the running worker's job ended and no new child work started", (run.agents ?? []).length <= 1 && (agent?.requests ?? 0) <= 2, JSON.stringify(run.agents?.map(row => [row.id, row.requests, row.lastWorkFailed])));
			check("no child request after the close came from the stopped turn's worker", !llm.of("child").some(entry => entry.ts > Date.parse(run.endedAt ?? "") && entry.lastUser.includes("stopped-worker")), `children=${llm.of("child").length}`);
			await rpc.prompt(route({ action: "budget", budgetUsd: 0 }, "drop the cap"));
			check("the cap is removed for later runs", files.config().budget === undefined, JSON.stringify(files.config().budget));
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
