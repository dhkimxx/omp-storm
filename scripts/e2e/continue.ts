#!/usr/bin/env bun
/**
 * The director continues an interrupted run, real host: a disposable git checkout, an isolated HOME/profile, the pinned
 * omp and the local fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * What the user met (the runs of 2026-11-26): omp died in the middle of a Storm run; the user reopened the session and
 * said, in their own words, that the work should go on; the director could only plan, so it opened a new run that
 * carried none of the earlier run's accepted results, goal totals or lineage. Here:
 *
 *   1. automatic delegation is on; the user's message is a status question ("작업현황"); the director opens a run on
 *      it, runs one job lane (accepted), and the host process is killed with a second lane still to do;
 *   2. the session is opened again. The run that was going is found dead and says the host ended;
 *   3. the user says, in ordinary words, to go on. The scripted director reads `storm status` (it must say the run can be
 *      continued by `storm continue`), calls `storm continue`, then runs the lane that was left;
 *   4. the new run carries the accepted result (proven again, not re-run), the goal totals and the lineage, was opened
 *      inside the user's turn (no handoff, no dialog), and its task is the work, not the status question.
 *
 * Usage:
 *   E2E_PORT=18801 E2E_WORK=/tmp/storm-e2e-continue ./node_modules/.bin/bun scripts/e2e/continue.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import { CONTINUATION_HEAD, EARLIER_REQUEST_MARKER } from "../../src/runtime/resume.ts";
import { endLabel } from "../../src/runtime/rounds.ts";
import {
	cancelAll,
	choose,
	type Frame,
	LlmCursor,
	linkPlugin,
	modelsYml,
	prepare,
	PROFILE_CONFIG,
	Rpc,
	type Step,
	StormFiles,
	stormRecords,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	until,
} from "./harness.ts";

const env = prepare("storm-e2e-continue", 18801);
const suite = new Suite("E2E (the director continues an interrupted run)", env);
const check = suite.check.bind(suite);
const provider = await startFakeLlm(env);
const MAIN = "fake/general-b";

const events = join(env.work, "job-events.log");
const eventsArg = JSON.stringify(events);
const starts = (): string[] => (existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : []);
const jobOf = (name: string, marker: string) => ({
	name,
	argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${eventsArg},${JSON.stringify(`${name}\n`)}); console.log(${JSON.stringify(marker)});`],
});
const lanes = [
	{ name: "first", kind: "run", job: "first", goal: "run the first job", results: [{ id: "first-receipt", kind: "answer", criterion: "observed first process exit", contains: "FIRST_READY" }] },
	{
		name: "later",
		kind: "run",
		job: "later",
		goal: "run the job that needs the first",
		dependsOn: [{ lane: "first", need: "result" }],
		results: [{ id: "later-receipt", kind: "answer", criterion: "observed second process exit", contains: "LATER_READY" }],
	},
];
const scripted = (...steps: Step[]): string => `E2E-STEPS ${JSON.stringify(steps)}`;
/** What the host handed back for the storm tool calls whose result mentions `part`. */
const stormResults = (frames: readonly Frame[], part: string): string[] =>
	frames
		.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm")
		.map(frame => JSON.stringify(frame.result))
		.filter(text => text.includes(part));

try {
	linkPlugin(env);
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	await suite.step("a run is cut off by killing the host, the session is reopened and the user says to go on", async () => {
		const hold = join(env.work, "never-created");
		const original = new Rpc(env, choose(APPROVE), { model: MAIN });
		const killed = await (async () => {
			await original.ready();
			await original.prompt("/storm");
			const files = new StormFiles(env, original.sessionId);
			files.editConfig(config => {
				config.jobs = [jobOf("first", "FIRST_READY"), jobOf("later", "LATER_READY")];
			});
			const approval = original.dialogs.length;
			await original.prompt("/storm");
			if (!original.dialogs.slice(approval).some(dialog => dialog.answer === APPROVE)) throw new Error("job definitions were not approved");
			const before = files.runIds();
			// The user's message is only a status question; the director opens a run on it, runs one lane and waits.
			// The last step is held at the provider, so the turn is still open when the host is killed: send, do not await it.
			original.send({
				type: "prompt",
				message: `작업현황 알려줘 ${scripted(
					{ storm: { action: "plan", plan: { lanes } } },
					{ storm: { action: "execute", lanes: ["first"] } },
					{ storm: { action: "status" }, holdUntilFile: hold },
				)}`,
			});
			const running = await until(() => {
				const run = files.runs().find(candidate => !before.has(candidate.runId));
				return run?.results?.some(row => row.id === "first-receipt" && row.state === "accepted") === true ? run : undefined;
			}, 60_000, "the first lane accepted on the live record");
			check("the run was opened by the director on a status question and has one accepted result", running.status === "running" && running.request?.includes("작업현황") === true,
				`${running.status} ${JSON.stringify(running.request?.slice(0, 40))}`);
			await original.stop();
			return { id: original.sessionId, dir: original.sessionDir, runId: running.runId, firstAttempt: running.results?.find(row => row.id === "first-receipt")?.attemptId };
		})();
		check("the host was killed while the run was going: its record still says running", new StormFiles(env, killed.id).run(killed.runId)?.status === "running");

		const cursor = new LlmCursor(env);
		const resumed = new Rpc(env, cancelAll, { model: MAIN, resume: killed.id, sessionDir: killed.dir });
		try {
			await resumed.ready();
			const files = new StormFiles(env, resumed.sessionId);
			const crashed = await until(() => {
				const run = files.run(killed.runId);
				return run?.status === "stopped" ? run : undefined;
			}, 30_000, "the dead run swept at the start");
			check("the dead run says the host ended while it was going, not that the user stopped it",
				crashed.endReason === "host-ended" && crashed.endReason !== ("interrupted" as string), `${crashed.status}/${crashed.endReason}`);
			const statusFrom = resumed.frames.length;
			await resumed.prompt("/storm status");
			const userStatus = stormRecords(resumed.frames, statusFrom).at(-1)?.text ?? "";
			check("the user's status names the run and says the host ended", userStatus.includes(killed.runId) && userStatus.includes(endLabel("host-ended")), userStatus.slice(0, 600));

			const before = files.runIds();
			const events0 = starts().join(",");
			// The user's own words; only the script marker is the fake model's.
			await resumed.turn(
				`아까 하던 작업 이어서 계속 진행해줘 ${scripted(
					{ storm: { action: "status" } },
					{ storm: { action: "continue" } },
					{ storm: { action: "execute", lanes: ["later"] } },
				)}`,
				120_000,
			);
			const second = await files.finishedRun(before, 60_000);
			const statusSeen = stormResults(resumed.frames, "이어 가기");
			check("the director's status says the interrupted run can be continued by the director", statusSeen.some(text => text.includes(killed.runId) && text.includes("storm continue")), statusSeen.join("\n").slice(0, 600));
			const continued = stormResults(resumed.frames, "이어받은 결과");
			check("the answer to continue says what was carried and what is left", continued.length === 1 && continued[0]!.includes(killed.runId) && continued[0]!.includes("later") && continued[0]!.includes("이어받은 결과 1개"), continued.join("\n").slice(0, 600));
			check("the new run continues the interrupted one: lineage, goal totals", second.resumeOf === killed.runId && second.goal?.runs === 1 && second.goal.firstRunId === killed.runId,
				JSON.stringify({ resumeOf: second.resumeOf, goal: second.goal }));
			const kept = second.results?.find(row => row.id === "first-receipt");
			check("the accepted result is carried on its own attempt, proven again, and its job was not run again",
				kept?.state === "accepted" && kept.restoredFrom === killed.runId && kept.attemptId === killed.firstAttempt && starts().slice(events0 === "" ? 0 : events0.split(",").length).join(",") === "later" && starts().join(",") === "first,later",
				`${JSON.stringify(kept)} starts=${starts().join(",")}`);
			check("the lane that was left ran and was accepted", second.results?.some(row => row.id === "later-receipt" && row.state === "accepted") === true, JSON.stringify(second.results?.map(row => [row.id, row.state])));
			const work = second.request?.split(`\n${EARLIER_REQUEST_MARKER}\n`)[0] ?? "";
			check("the new run's task leads with the work (the plan's lanes), and the status question is only the marked earlier request",
				second.request?.startsWith(CONTINUATION_HEAD) === true && work.includes("first") && work.includes("later") && !work.includes("작업현황") && second.request.includes("작업현황"),
				JSON.stringify(second.request?.slice(0, 200)));
			check("it was opened inside the user's turn: no handoff message, no dialog", resumed.dialogs.length === 0 && cursor.of("main").every(entry => !entry.users.some(text => text.includes("<storm-run "))),
				JSON.stringify(resumed.dialogs));
			check("the interrupted run's record is unchanged by the continuation", files.run(killed.runId)?.endReason === "host-ended" && files.run(killed.runId)?.status === "stopped");
			check("no AI worker was needed", cursor.of("child").length === 0);
		} finally {
			const code = await resumed.close();
			check("the reopened session exits cleanly", code === 0, `exit=${code}`);
		}
	}, 240_000);
} finally {
	provider.kill();
	await provider.exited;
}
process.exitCode = suite.finish();
