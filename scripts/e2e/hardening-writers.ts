#!/usr/bin/env bun
/**
 * Two writers never share a work tree unbounded (0.27.0 hardening, guarantee G1), real host: a disposable git checkout,
 * an isolated HOME/profile, the pinned omp 19.2.1 and the local fake LLM. No paid model calls.
 *
 * Three holes of 0.26.0 that the investigation proved (/tmp/storm-h/V1-report.md claim 2, V2-report.md items 1 and 3):
 *
 *   (c) A writer waited for omp's concurrency permit behind a reader for longer than the 30 seconds its write place was
 *       kept. The place lapsed, the host then started the writer, Storm admitted it without a place, and a second writer
 *       the director placed while the first ran was let through (measured on this host: the first writer started 36.1 s
 *       after it was placed). Now a late start keeps its place until the worker ends.
 *   (d) A job whose command exited zero while a child it had started kept writing was recorded as ended and passed, the
 *       fence on its target was released and the next job for the same resource ran beside the child. Now the end is an
 *       empty process group: the child is stopped, the job is not counted as passed and the next job starts after.
 *   (e) A writing worker could ask omp's `bash` for a named service; omp's daemon kept it running after the worker's turn
 *       ended and its place was free. Now the call is refused to a managed writer, and the worker goes on.
 *
 * Every scenario opens a manual run with a scripted director (`runRequest`), as the phase-1 scenarios do.
 *
 * Not runnable until the wiring pass has put the hardening into `src/extension.ts` and `src/runtime/controller.ts` (the Ha
 * report's wiring notes 1 to 3 for (c), the child's `tool_call` guard for (e)). (d) needs only `src/runtime/checks.ts`.
 *
 * Usage:
 *   E2E_PORT=18812 E2E_WORK=/tmp/storm-e2e-hardening-writers ./node_modules/.bin/bun scripts/e2e/hardening-writers.ts
 *   E2E_ONLY=service ... runs one scenario ("order", "service" or "left-behind"; the team is approved first either way).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import { LEFT_BEHIND_STOPPED_NOTE } from "../../src/runtime/checks.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import { cancelAll, choose, LlmCursor, type LlmEntry, prepare, startFakeLlm, type Step, Suite, until } from "./harness.ts";
import { installProfile, runRequest, Sessions, setOmpSettings } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-hardening-writers", 18812);
seedFact(env.project);
const suite = new Suite("E2E (two writers never share a work tree unbounded)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const CITED = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
const answerFor = (id: string) => requiredResult(id, "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE });
const changeFor = (id: string, path: string) => requiredResult(id, "change", `${path} is the worker's change`, { path, contains: "storm child change" });
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const json = (value: string): string => JSON.stringify(value);

/** What the director got back for its `nth` call of `tool`: the `lastTool` of the request that follows it. */
function resultOf(main: readonly LlmEntry[], tool: string, nth = 0): string | undefined {
	const at = main.flatMap((entry, index) => (entry.decision.tool === tool ? [index] : []))[nth];
	return at === undefined ? undefined : main[at + 1]?.lastToolResult;
}

/** Whether a process answers signal 0: it exists (a zombie of a child we do not wait for counts as gone only once reaped). */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * (c) The place of a writer outlives omp's wait for a permit. `task.maxConcurrency: 1` and a reader that holds the permit
 * for 36 s make the first writer start about 36 s after it was placed (V1, measured), past the 30 s its place used to be kept.
 */
async function writePlaceOutlivesTheWait(): Promise<void> {
	const releaseB = join(env.work, "release-second-writer");
	await suite.step("order: a writer started after a long wait for a permit still holds its place; a second writer is refused for write order", async () => {
		setOmpSettings(env, "task:\n  maxConcurrency: 1\n");
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan(
					[
						{ name: "R", kind: "explore", role: "explorer", goal: "read", results: [answerFor("r-answer")] },
						{ name: "A", kind: "code", role: "implementer", files: ["a.txt"], goal: "write a.txt", results: [changeFor("a-change", "a.txt")] },
						{ name: "B", kind: "code", role: "implementer", files: ["b.txt"], goal: "write b.txt", results: [changeFor("b-change", "b.txt")] },
					],
					{ contract: true, workers: { explorer: 1, implementer: 2 } },
				),
				// The reader takes the only permit for 36 s; the first writer is placed at once and waits behind it.
				{ tasks: [{ name: "R", agent: "storm-explorer", task: "Read", say: `E2E-CHILD-DELAY 36000 ${CITED}` }] },
				{ tasks: [{ name: "A", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-DELAY 12000 E2E-CHILD-WRITE a.txt" }] },
				// The second writer is placed only when the test has seen the first one started (the file is the test's signal).
				{ tasks: [{ name: "B", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE b.txt" }], holdUntilFile: releaseB },
				{ wait: true },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			rpc.send({ type: "prompt", message: runRequest(steps) });

			const started = await until(() => {
				const run = files.runs().find(candidate => !before.has(candidate.runId));
				const spawn = run?.spawns.find(row => row.lane === "A" && row.outcome !== "blocked");
				return spawn === undefined ? undefined : { run, spawn };
			}, 150_000, "the first writer's spawn decision on the live record");
			const placedAt = llm.of("main").find(entry => entry.decision.tool === "task" && JSON.stringify(entry.decision.args ?? {}).includes('"name":"A"'))?.ts;
			const waited = placedAt === undefined ? undefined : Date.parse(started.spawn.ts) - placedAt;
			// Without this the scenario would only repeat the fast case the unit tests hold: the place really did age out.
			check("the first writer started more than 30 s after the call that placed it (the wait for the permit was real)", waited !== undefined && waited > 30_000, `placed at ${placedAt}, decided at ${started.spawn.ts}, waited ${waited} ms`);
			await Bun.write(releaseB, "go\n");

			const run = await files.finishedRun(before, 240_000);
			const main = llm.of("main");
			const second = resultOf(main, "task", 2);
			check("the second writer's call was refused for write order while the first ran", second?.includes("[storm:lane-write]") === true, second?.slice(0, 400) ?? "no result");
			check("no spawn was admitted for the second writer and its file does not exist", !run.spawns.some(spawn => spawn.lane === "B" && spawn.outcome !== "blocked") && !existsSync(join(env.project, "b.txt")), JSON.stringify(run.spawns.map(spawn => [spawn.lane, spawn.outcome, spawn.code])));
			check("the first writer ran to the end and its change was accepted", existsSync(join(env.project, "a.txt")) && run.results?.some(row => row.id === "a-change" && row.state === "accepted") === true, JSON.stringify(run.results?.map(row => [row.id, row.state])));
			check("the reader finished too: the permit was handed on, nothing was lost", run.results?.some(row => row.id === "r-answer" && row.state === "accepted") === true, JSON.stringify(run.results?.map(row => [row.id, row.state])));
		});
	}, 420_000);
}

/** (e) A named service is not something a managed writer may start: the call is refused and the worker goes on. */
async function namedServiceIsRefused(): Promise<void> {
	const started = join(env.work, "service-started");
	const foreground = join(env.work, "foreground-ran");
	await suite.step("service: a writing worker's named service is refused and the worker goes on", async () => {
		setOmpSettings(env, "");
		await sessions.open(cancelAll, async (rpc, files) => {
			// The service would write its marker as soon as omp's daemon ran it, then print the line it is ready on and stay up.
			const service = `printf started > ${json(started)}; echo ready; sleep 30`;
			const steps: Step[] = [
				contractPlan([{ name: "S", kind: "code", role: "implementer", files: ["s-out.txt"], goal: "write s-out.txt", results: [changeFor("s-change", "s-out.txt")] }], { contract: true, workers: { implementer: 1 } }),
				{ tasks: [{ name: "S", agent: "storm-implementer", task: "Write", say: `E2E-CHILD-SERVICE ${base64(service)} E2E-CHILD-SH ${base64(`printf ok > ${json(foreground)}`)} E2E-CHILD-WRITE s-out.txt` }] },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before);
			const kids = llm.of("child");

			const bashAt = kids.flatMap((entry, index) => (entry.decision.tool === "bash" ? [index] : []));
			const answer = bashAt[0] === undefined ? undefined : kids[bashAt[0] + 1]?.lastTool;
			check("the worker did ask for the service (the first bash call of the worker carries a name)", bashAt.length >= 1 && JSON.stringify(kids[bashAt[0]!]?.decision.args ?? {}).includes('"name":"e2e-service"'), JSON.stringify(kids[bashAt[0] ?? 0]?.decision));
			check("Storm refused that call and said so to the worker", answer?.includes("[storm:") === true, answer?.slice(0, 400) ?? "no result");
			check("the service never started: its marker does not exist", !existsSync(started), started);
			check("the worker went on after the refusal: its next calls ran, a plain foreground command included", existsSync(foreground) && existsSync(join(env.project, "s-out.txt")), JSON.stringify(kids.map(entry => entry.decision.tool)));
			check("the refusal did not end the worker's lane: spawn routed, change accepted", run.spawns.some(spawn => spawn.lane === "S" && spawn.outcome === "routed") && run.results?.some(row => row.id === "s-change" && row.state === "accepted") === true, JSON.stringify({ spawns: run.spawns.map(spawn => [spawn.lane, spawn.outcome, spawn.code]), results: run.results?.map(row => [row.id, row.state]) }));
			// A service omp's daemon had started would outlive the turn; give it the time a late start would need before saying it never did.
			await Bun.sleep(1_500);
			check("and still no service marker after the run ended", !existsSync(started), started);
		});
	}, 300_000);
}

/** (d) A job that exits zero and leaves a child writing: stopped, not passed, and the next job for the resource starts after it. */
async function leftBehindChildIsStopped(): Promise<void> {
	const pidFile = join(env.work, "left-behind.pid");
	const lateFile = join(env.work, "left-behind.late");
	const events = join(env.work, "left-behind.events");
	const resource = `e2e-left-behind:${new Bun.CryptoHasher("sha256").update(env.work).digest("hex").slice(0, 12)}`;
	// The child stays in the job's process group with its output ignored, so it holds no pipe the runner waits on. It records its
	// pid, writes `late` 2.5 s after it started, and otherwise idles; a plain SIGTERM ends it.
	const child = `const fs=require("node:fs");fs.writeFileSync(${json(pidFile)},String(process.pid));setTimeout(()=>fs.writeFileSync(${json(lateFile)},"late"),2500);setInterval(()=>{},1000);`;
	// The job exits zero as soon as its child has started: the exit code is a lie about the work the child still does.
	const firstJob = [
		'const fs=require("node:fs"),{spawn}=require("node:child_process");',
		`spawn(process.execPath,["-e",${json(child)}],{stdio:"ignore"}).unref();`,
		`(async()=>{const limit=Date.now()+5000;while(!fs.existsSync(${json(pidFile)})&&Date.now()<limit)await new Promise(r=>setTimeout(r,10));`,
		`fs.appendFileSync(${json(events)},"one:end\\n");console.log("JOB-ONE-DONE");})();`,
	].join("");
	// The next job for the same resource reports whether the first job's child is still running when it starts.
	const secondJob = [
		'const fs=require("node:fs");let alive=false;',
		`try{process.kill(Number(fs.readFileSync(${json(pidFile)},"utf8")),0);alive=true}catch{}`,
		`fs.appendFileSync(${json(events)},"two:start alive="+alive+"\\n");console.log("JOB-TWO-CHILD-ALIVE:"+alive);`,
	].join("");
	await suite.step("left-behind: a job that exits zero and leaves a child writing is stopped, not passed, and does not overlap the next job", async () => {
		setOmpSettings(env, "");
		await sessions.open(choose(APPROVE), async (rpc, files) => {
			files.editConfig(config => {
				config.jobs = [
					{ name: "left-one", argv: [process.execPath, "-e", firstJob], resources: [resource] },
					{ name: "left-two", argv: [process.execPath, "-e", secondJob], resources: [resource] },
				];
			});
			const dialogs = rpc.dialogs.length;
			await rpc.prompt("/storm");
			check("the job definitions were approved through the real dialog", rpc.dialogs.slice(dialogs).some(dialog => dialog.answer === APPROVE), JSON.stringify(rpc.dialogs.slice(dialogs)));
			rpc.answer = cancelAll;

			const lanes = [
				{ name: "left-one", kind: "run", job: "left-one", results: [{ id: "one-receipt", kind: "answer", criterion: "the first job's own output", contains: "JOB-ONE-DONE" }] },
				{ name: "left-two", kind: "run", job: "left-two", results: [{ id: "two-receipt", kind: "answer", criterion: "the second job saw no child of the first", contains: "JOB-TWO-CHILD-ALIVE:false" }] },
			];
			const steps: Step[] = [{ storm: { action: "plan", plan: { lanes } } }, { storm: { action: "execute", lanes: ["left-one", "left-two"] } }];
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 120_000);
			const run = await files.finishedRun(before, 60_000);
			const one = run.jobs?.find(job => job.name === "left-one");
			const two = run.jobs?.find(job => job.name === "left-two");

			check("the first job is recorded failed, its exit code kept as observed (0), with the reason", one?.status === "failed" && one.exitCode === 0 && one.detail?.includes(LEFT_BEHIND_STOPPED_NOTE) === true, JSON.stringify(one));
			check("its result is not accepted although the job printed what the result asks for", run.results?.find(row => row.id === "one-receipt")?.state === "unmet", JSON.stringify(run.results?.map(row => [row.id, row.state])));
			const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : Number.NaN;
			check("the child had really started (its pid is recorded) and is gone now", Number.isInteger(pid) && !alive(pid), `pid=${pid}`);
			check("the second job started after the first one's end and found no child of it", two?.status === "passed" && one?.finishedAt != null && two.startedAt != null && two.startedAt >= one.finishedAt && existsSync(events) && readFileSync(events, "utf8").includes("two:start alive=false"), `${JSON.stringify(two)} events=${existsSync(events) ? readFileSync(events, "utf8") : "none"}`);
			check("so the second job's result is accepted: nothing overlapped it", run.results?.find(row => row.id === "two-receipt")?.state === "accepted", JSON.stringify(run.results?.map(row => [row.id, row.state])));
			// The child would have written `late` 2.5 s after it started; wait past that before saying it never did.
			await Bun.sleep(3_000);
			check("the child never wrote after Storm recorded the end", !existsSync(lateFile), lateFile);
		});
	}, 300_000);
}

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team, automatic delegation off", async () => {
		const { teams } = await sessions.approve("off");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await writePlaceOutlivesTheWait();
	await namedServiceIsRefused();
	await leftBehindChildIsStopped();

	await suite.step("every OMP session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	}, 120_000, { always: true });
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
