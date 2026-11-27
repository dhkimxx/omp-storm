#!/usr/bin/env bun
/**
 * What the real host does at the edges the first promise leans on (0.27.0 integration), seen with the pinned omp 19.2.1, a
 * disposable git checkout, an isolated HOME/profile and the local fake LLM. No paid model calls.
 *
 *   A. A worker starts a background command that ignores termination and writes late, then writes its file and yields.
 *      The place of a worker is held until omp reaped what it left; this asks what omp does with that command at the end
 *      of the worker's turn, and whether a second writer could start before the late write (the guarantee is that it
 *      cannot: either the command is gone, or the second writer is refused until it has written).
 *   B. A worker's foreground `bash` that leaves a background child behind and exits: does the child survive the call and
 *      the worker's end?
 *   C. The same for the director's own `bash` in a manual run.
 *   D. A worker woken by a quiet note after its authority ended: it can read and report, not write.
 *   E. The director's background command: is it a row the lane table sees, so a writer waits for it; is a tool call id on every
 *      director call (the guard refuses a call without one).
 *   F. A synchronous `task` call (`async.enabled: false`) returns after omp reaped the worker's jobs.
 *   G. omp writes the usage of eval's model helpers to the session file before the cell returns.
 *
 * Each step prints what it saw (`HOST-FACT ...`); the checks pin it, so a different omp shows up here first.
 *
 * Usage:
 *   E2E_PORT=18813 E2E_WORK=/tmp/storm-e2e-host-facts ./node_modules/.bin/bun scripts/e2e/host-facts.ts
 *   E2E_ONLY=A runs one step (the team is approved first either way).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import { cancelAll, LlmCursor, prepare, startFakeLlm, type Step, Suite } from "./harness.ts";
import { installProfile, runRequest, Sessions, setOmpSettings } from "./phase1-kit.ts";
import { FACT_FILE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-host-facts", 18813);
seedFact(env.project);
const suite = new Suite("E2E (what the host does at the edges of the first promise)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const changeFor = (id: string, path: string) => requiredResult(id, "change", `${path} is the worker's change`, { path, contains: "storm child change" });
const fact = (name: string, value: unknown): void => console.log(`HOST-FACT ${name}: ${JSON.stringify(value)}`);
const mtime = (path: string): number | undefined => (existsSync(path) ? statSync(path).mtimeMs : undefined);
const GRACE_MS = 10_000;

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team, automatic delegation off", async () => {
		const { teams } = await sessions.approve("off");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("A: a worker's background command that ignores termination, then a second writer", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const late = join(env.project, "late.txt");
			const command = `trap '' TERM; sleep 26; echo late > ${late}`;
			const steps: Step[] = [
				contractPlan(
					[
						{ name: "A", kind: "code", role: "implementer", files: ["a.txt"], goal: "write a.txt", results: [changeFor("a-change", "a.txt")] },
						{ name: "B", kind: "code", role: "implementer", files: ["b.txt"], goal: "write b.txt", results: [changeFor("b-change", "b.txt")] },
					],
					{ contract: true, workers: { implementer: 2 } },
				),
				{ tasks: [{ name: "A", agent: "storm-implementer", task: "Write", say: `E2E-CHILD-BG ${base64(command)} E2E-CHILD-WRITE a.txt` }] },
				{ wait: true },
				// Straight after the first writer's result a second writer is tried, and again 12 s and 24 s later (a refused call leaves
				// nothing behind, so the same lane can be tried again): the command writes at about 26 s after it started.
				{ tasks: [{ name: "B", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE b.txt" }] },
				{ tasks: [{ name: "B", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE b.txt" }], pauseMs: 12_000 },
				{ tasks: [{ name: "B", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE b.txt" }], pauseMs: 12_000 },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before, 120_000);
			const main = llm.of("main");
			const callsAt = main.flatMap((entry, index) => (entry.decision.tool === "task" ? [index] : [])).slice(1);
			// For each attempt on B: when it was made and what the director was told.
			const attempts = callsAt.map(at => ({ at: main[at]!.ts, answeredAt: main[at + 1]?.ts ?? main[at]!.ts, told: (main[at + 1]?.lastToolResult ?? "").slice(0, 60) }));
			const bSpawns = run.spawns.filter(spawn => spawn.lane === "B" || (spawn.spawnKey ?? "").startsWith("B"));
			const admitted = bSpawns.filter(spawn => spawn.outcome !== "blocked");
			await Bun.sleep(GRACE_MS + 16_000);
			const lateAt = mtime(late);
			const bAt = mtime(join(env.project, "b.txt"));
			fact("A", { lateAt, bAt, spawns: bSpawns.map(spawn => [spawn.spawnKey, spawn.ts, spawn.outcome, spawn.code]), attempts, runEnd: run.endReason });
			// omp gives up its own wait for a worker's jobs after 10 s (`TASK_ABORT_CLEANUP_GRACE_MS`) and defers the rest. What this host
			// does with a command that ignores termination: the worker's task job stayed `running` until the command ended, so the
			// place was still held well past those 10 s (a second writer was refused after them, and admitted only after the write).
			const first = attempts[0]?.answeredAt ?? 0;
			const heldPastGrace = attempts.some(attempt => attempt.told.includes("[storm:lane-write]") && attempt.answeredAt - first > GRACE_MS);
			check(
				"the first writer's place was still held after omp's 10 s grace for its jobs: a second writer was refused then, and the command did write late",
				heldPastGrace && lateAt !== undefined,
				JSON.stringify({ first, attempts, lateAt }),
			);
			// The guarantee: a second writer never runs beside the first worker's command. Either the command did not survive its
			// worker (no late write at all), or no second writer was admitted before it had written.
			check(
				"no second writer was admitted before the first worker's background command had written (or that command never wrote)",
				lateAt === undefined || admitted.every(spawn => Date.parse(spawn.ts) >= lateAt),
				JSON.stringify({ lateAt, bAt, spawns: bSpawns.map(spawn => [spawn.spawnKey, spawn.ts, spawn.outcome, spawn.code]), attempts }),
			);
		});
	}, 300_000);

	await suite.step("B: a worker's foreground command that leaves a child behind and exits", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const marker = join(env.project, "left-by-worker.txt");
			const command = `(sleep 6; echo left > ${marker}) >/dev/null 2>&1 &`;
			const steps: Step[] = [
				contractPlan([{ name: "A", kind: "code", role: "implementer", files: ["a.txt"], goal: "write a.txt", results: [changeFor("a-change", "a.txt")] }], { contract: true, workers: { implementer: 1 } }),
				{ tasks: [{ name: "A", agent: "storm-implementer", task: "Write", say: `E2E-CHILD-SH ${base64(command)} E2E-CHILD-WRITE a.txt` }] },
				{ wait: true },
			];
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			await files.finishedRun(before, 120_000);
			const endedAt = Date.now();
			await Bun.sleep(9_000);
			const markerAt = mtime(marker);
			fact("B", { survived: markerAt !== undefined, writtenAfterRunEndMs: markerAt === undefined ? undefined : Math.round(markerAt - endedAt) });
			check("what a worker's foreground command left in the background is stated by this fact (see the HOST-FACT line)", true, JSON.stringify({ survived: markerAt !== undefined }));
		});
	}, 300_000);

	await suite.step("C: the director's own foreground command that leaves a child behind and exits", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const marker = join(env.project, "left-by-director.txt");
			const steps: Step[] = [
				contractPlan([{ name: "A", kind: "code", role: "implementer", files: ["a.txt"], goal: "write a.txt", results: [changeFor("a-change", "a.txt")] }], { contract: true, workers: { implementer: 1 } }),
				{ bash: `(sleep 6; echo left > ${marker}) >/dev/null 2>&1 &` },
				{ tasks: [{ name: "A", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE a.txt" }] },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before, 120_000);
			const main = llm.of("main");
			const bash = main.findIndex(entry => entry.decision.tool === "bash");
			fact("C-call", { result: main[bash + 1]?.lastToolResult.slice(0, 200), spawns: run.spawns.map(spawn => [spawn.lane, spawn.outcome, spawn.code]) });
			await Bun.sleep(9_000);
			const markerAt = mtime(marker);
			fact("C", { survived: markerAt !== undefined });
			check("what the director's foreground command left in the background is stated by this fact (see the HOST-FACT line)", true, JSON.stringify({ survived: markerAt !== undefined }));
		});
	}, 300_000);

	await suite.step("D: a quiet note wakes a worker whose authority ended: it cannot write", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const woke = join(env.project, "woke.txt");
			const steps: Step[] = [
				contractPlan([{ name: "DA", kind: "code", role: "implementer", files: ["d-a.txt"], goal: "write d-a.txt", results: [changeFor("d-change", "d-a.txt")] }], { contract: true, workers: { implementer: 1 } }),
				{ tasks: [{ name: "DA", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE d-a.txt" }] },
				{ wait: true },
				// The worker is idle and its authority ended with its turn. The note asks it to run a command.
				{ edit: "agent://DA?progress", content: `E2E-CHILD-SH ${base64(`touch ${woke}`)}` },
				{ read: FACT_FILE, pauseMs: 8_000 },
			];
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const finished = await files.finishedRun(before, 120_000);
			const key = finished.spawns.find(spawn => spawn.outcome !== "blocked")?.spawnKey ?? "DA";
			const log = [...new Bun.Glob(`**/${key}.jsonl`).scanSync({ cwd: join(env.work, "sessions"), absolute: true })].at(-1);
			const text = log === undefined ? "" : readFileSync(log, "utf8");
			const woken = text.includes("touch ") && text.includes("woke.txt");
			const refused = text.includes("[storm:authority]");
			fact("D", { woken, refused, wrote: existsSync(woke) });
			check("the woken worker did try to run the command (the note reached it)", woken, log === undefined ? "no worker log" : `log=${log.slice(-40)}`);
			check("and was refused with the authority reason: it can read and report but not write", refused && !existsSync(woke), JSON.stringify({ refused, wrote: existsSync(woke) }));
		});
	}, 300_000);

	await suite.step("E: the director's background command is a row the lane table sees; a writer waits for it", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan([{ name: "EB", kind: "code", role: "implementer", files: ["e-b.txt"], goal: "write e-b.txt", results: [changeFor("e-change", "e-b.txt")] }], { contract: true, workers: { implementer: 1 } }),
				{ bash: "sleep 9; echo background-done", async: true },
				{ tasks: [{ name: "EB", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE e-b.txt" }] },
				{ tasks: [{ name: "EB", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE e-b.txt" }], pauseMs: 11_000 },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before, 120_000);
			const main = llm.of("main");
			const results = main.flatMap((entry, at) => (entry.decision.tool === "task" ? [main[at + 1]?.lastToolResult ?? ""] : []));
			const bashAt = main.findIndex(entry => entry.decision.tool === "bash");
			const bashResult = main[bashAt + 1]?.lastToolResult ?? "";
			fact("E", { bash: bashResult.slice(0, 120), tasks: results.map(text => text.slice(0, 90)) });
			check("the director's background command was admitted: omp gave a tool call id and the job rows were readable", !bashResult.includes("[storm:director-exec]") && !bashResult.includes("[storm:director-service]") && bashResult !== "", bashResult.slice(0, 200));
			check("a writer placed while that command ran was refused for it", results[0]?.includes("백그라운드로 돌린 명령") === true || results[0]?.includes("[storm:lane-write]") === true, results[0]?.slice(0, 200) ?? "no result");
			check("after the command ended the same writer was placed and ran", results[1]?.includes("Spawned agent `EB`") === true && run.results?.some(row => row.id === "e-change" && row.state === "accepted") === true, JSON.stringify({ second: results[1]?.slice(0, 120), results: run.results?.map(row => [row.id, row.state]) }));
		});
	}, 300_000);

	await suite.step("F: a synchronous task call returns after omp reaped the worker's jobs", async () => {
		setOmpSettings(env, "async:\n  enabled: false\n");
		try {
			await sessions.open(cancelAll, async (rpc, files) => {
				const late = join(env.project, "late-sync.txt");
				const command = `trap '' TERM; sleep 16; echo late > ${late}`;
				const steps: Step[] = [
					contractPlan(
						[
							{ name: "FA", kind: "code", role: "implementer", files: ["f-a.txt"], goal: "write f-a.txt", results: [changeFor("f-a-change", "f-a.txt")] },
							{ name: "FB", kind: "code", role: "implementer", files: ["f-b.txt"], goal: "write f-b.txt", results: [changeFor("f-b-change", "f-b.txt")] },
						],
						{ contract: true, workers: { implementer: 2 } },
					),
					{ tasks: [{ name: "FA", agent: "storm-implementer", task: "Write", say: `E2E-CHILD-BG ${base64(command)} E2E-CHILD-WRITE f-a.txt` }] },
					{ tasks: [{ name: "FB", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE f-b.txt" }] },
					{ tasks: [{ name: "FB", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE f-b.txt" }], pauseMs: 8_000 },
				];
				const llm = new LlmCursor(env);
				const before = files.runIds();
				await rpc.prompt(runRequest(steps), 180_000);
				const run = await files.finishedRun(before, 120_000);
				const main = llm.of("main");
				const calls = main.flatMap((entry, at) => (entry.decision.tool === "task" ? [at] : []));
				const returnedAt = main[calls[0]! + 1]?.ts;
				for (let waited = 0; waited < 30_000 && mtime(late) === undefined; waited += 500) await Bun.sleep(500);
				const lateAt = mtime(late);
				const admitted = run.spawns.filter(spawn => spawn.lane === "FB" && spawn.outcome !== "blocked");
				fact("F", { callMs: returnedAt === undefined ? undefined : returnedAt - main[calls[0]!]!.ts, wrote: lateAt !== undefined, returnedAfterLateWrite: returnedAt !== undefined && lateAt !== undefined ? returnedAt >= lateAt : undefined, lateAt, returnedAt, told: calls.slice(1).map(at => (main[at + 1]?.lastToolResult ?? "").slice(0, 70)), admitted: admitted.map(spawn => spawn.ts) });
				check(
					"no second writer was admitted before the first worker's command wrote, though the call was synchronous",
					lateAt === undefined || admitted.every(spawn => Date.parse(spawn.ts) >= lateAt),
					JSON.stringify({ lateAt, returnedAt, admitted: admitted.map(spawn => spawn.ts) }),
				);
			});
		} finally {
			setOmpSettings(env, "");
		}
	}, 300_000);

	await suite.step("G: omp writes the usage of eval's model helpers to the session file before the cell returns", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan([{ name: "GA", kind: "code", role: "implementer", files: ["g-a.txt"], goal: "write g-a.txt", results: [changeFor("g-change", "g-a.txt")] }], { contract: true, workers: { implementer: 1 } }),
				{ tasks: [{ name: "GA", agent: "storm-implementer", task: "Write", say: `E2E-CHILD-EVAL ${base64("const r = await completion('say hi'); r")} E2E-CHILD-WRITE g-a.txt` }] },
				{ wait: true },
			];
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before, 120_000);
			const key = run.spawns.find(spawn => spawn.outcome !== "blocked")?.spawnKey ?? "GA";
			const log = [...new Bun.Glob(`**/${key}.jsonl`).scanSync({ cwd: join(env.work, "sessions"), absolute: true })].at(-1);
			const rows = (log === undefined ? "" : readFileSync(log, "utf8")).split("\n").filter(line => line.trim() !== "").map(line => {
				try {
					return JSON.parse(line) as { type?: string; purpose?: string; timestamp?: string; message?: { role?: string; toolName?: string } };
				} catch {
					return {};
				}
			});
			const usage = rows.find(row => row.type === "model_usage" && /^completion/.test(row.purpose ?? ""));
			const cell = rows.find(row => row.type === "message" && row.message?.role === "toolResult" && row.message.toolName === "eval");
			const usageAt = usage?.timestamp === undefined ? undefined : Date.parse(usage.timestamp);
			const cellAt = cell?.timestamp === undefined ? undefined : Date.parse(cell.timestamp);
			fact("G", { usage: usage?.purpose, usageAt, cellAt, evalUsd: run.spend?.evalUsd, lowerBound: run.spend?.lowerBound });
			check("the eval cell ran and its helper call was journaled as a completion entry", usage !== undefined && cell !== undefined, JSON.stringify({ usage: usage?.purpose, cell: cell !== undefined, rows: rows.map(row => row.type).slice(-12) }));
			check("the entry is written no later than the cell's result", usageAt !== undefined && cellAt !== undefined && usageAt <= cellAt, JSON.stringify({ usageAt, cellAt }));
			check("the run counted it, and the total is not marked a floor", (run.spend?.evalUsd ?? 0) > 0 && run.spend?.lowerBound !== true, JSON.stringify(run.spend ?? null));
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
