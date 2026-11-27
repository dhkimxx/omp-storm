#!/usr/bin/env bun
/**
 * The director reads and searches under automatic delegation, real host: a disposable git checkout, an isolated
 * HOME/profile, the pinned omp and the local fake LLM. No paid model calls.
 *
 * What the user met (the run of 2026-11-26): under automatic delegation the director could not read its own plan or
 * any project file, so it asked workers to read for it; and every refusal named "project tools" whatever it had asked
 * for. Phase 1 lets the director read and search (`read`, `grep`, `find`, ...), before a run and during one, and keeps
 * three things refused, each with its own cause: a file edit, a command, and a tool whose effect cannot be told to be
 * read-only. Here the scripted director, in the same session twice:
 *
 *   1. before any run: reads a project file, searches it, then tries to write a project file and to run a command;
 *   2. in a run it opened (plan, one explorer, then the same four calls while the run is open).
 *
 * The reads and the search return their content. Before a run the file write is refused naming the cause "a file written by the
 * director belongs to no lane"; during a run it passes (0.28.0: the director's own path edits are one more writer in the write
 * table, and no worker holds the tree once the explorer's result is in). The command is refused in both, naming "it runs a
 * command", and its file never exists. The run still finishes with its result accepted.
 *
 * Not fully runnable until `src/extension.ts` passes the supervisor scope and the new wrapper texts (P1-b report,
 * wiring notes 1 and 2): today a read is admitted by the director gate, but the refusal still opens with the old
 * "the main session does not use project tools" sentence, and the check that it does not fails.
 *
 * Usage:
 *   E2E_PORT=18807 E2E_WORK=/tmp/storm-e2e-director-reads ./node_modules/.bin/bun scripts/e2e/director-reads.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SUPERVISOR_REASONS } from "../../src/policy/supervisor.ts";
import { cancelAll, LlmCursor, type LlmEntry, prepare, startFakeLlm, type Step, Suite } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-director-reads", 18807);
seedFact(env.project);
const suite = new Suite("E2E (the director reads under automatic delegation)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const scripted = (...steps: Step[]): string => `E2E-STEPS ${JSON.stringify(steps)}`;
const plan = {
	storm: {
		action: "plan",
		plan: { lanes: [{ name: "Probe0", kind: "explore", results: [{ id: "probe-answer", kind: "answer", criterion: "report the tracked fixture from source", path: FACT_FILE, contains: FACT_LINE }] }] },
	},
} as const;
const probe: Step = { task: ["storm-explorer"], as: "Probe", say: `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}` };

const READ: Step = { read: FACT_FILE };
const SEARCH: Step = { call: "grep", args: { pattern: "tracked_delta", path: FACT_FILE } };
const EDIT: Step = { edit: "direct-edit.txt" };
const SHELL: Step = { bash: "printf nope > direct-shell.txt" };

/** What the director got back for its first call of `tool`: the `lastTool` of the request that follows it, from the `nth` such call. */
function resultOf(main: readonly LlmEntry[], tool: string, nth = 0): string | undefined {
	const calls = main.flatMap((entry, at) => (entry.decision.tool === tool ? [at] : []));
	const at = calls[nth];
	return at === undefined ? undefined : main[at + 1]?.lastTool;
}

/** The four calls and what the host answered: contents for the read and the search, a named cause for the two refusals. */
function checkFour(label: string, main: readonly LlmEntry[], offset: { read: number; grep: number; write: number; bash: number }, editOpen: boolean): void {
	const read = resultOf(main, "read", offset.read);
	const found = resultOf(main, "grep", offset.grep);
	const edit = resultOf(main, "write", offset.write);
	const shell = resultOf(main, "bash", offset.bash);
	check(`${label}: the read of a project file returns its content and is not refused`, read !== undefined && read.includes(FACT_LINE) && !read.includes("[storm:auto]"), read ?? "no result");
	check(`${label}: the search returns the match and is not refused`, found !== undefined && found.includes("tracked_delta") && !found.includes("[storm:auto]"), found ?? "no result");
	if (editOpen) {
		check(`${label}: writing a project file passes (a run is open and no writer holds the tree)`, edit !== undefined && !edit.includes("[storm:"), edit ?? "no result");
	} else {
		check(`${label}: writing a project file is refused, and the text says why: the director's file belongs to no lane`, edit !== undefined && edit.includes("[storm:auto]") && edit.includes(SUPERVISOR_REASONS.writeFiles), edit ?? "no result");
	}
	check(`${label}: running a command is refused, and the text says why: it runs a command`, shell !== undefined && shell.includes("[storm:auto]") && shell.includes(SUPERVISOR_REASONS.toolRuns), shell ?? "no result");
	check(`${label}: neither refusal calls the file write or the command a "project tool" (the old sentence is gone)`, ![edit, shell].some(text => text?.includes("프로젝트 도구")), JSON.stringify({ edit, shell }));
}

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team, automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("before a run: the director reads and searches, and is refused a file write and a command with their causes", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const before = files.runIds();
			const llm = new LlmCursor(env);
			await rpc.turn(scripted(READ, SEARCH, EDIT, SHELL));
			checkFour("before a run", llm.of("main"), { read: 0, grep: 0, write: 0, bash: 0 }, false);
			check("neither file was written", !existsSync(join(env.project, "direct-edit.txt")) && !existsSync(join(env.project, "direct-shell.txt")));
			check("none of this opened a run", files.runIds().size === before.size);
		});
	}, 180_000);

	await suite.step("during a run: the same four calls get the same answers, and the run still finishes with its result accepted", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const before = files.runIds();
			const llm = new LlmCursor(env);
			await rpc.turn(scripted(plan, probe, READ, SEARCH, { wait: true }, EDIT, SHELL), 180_000);
			const run = await files.finishedRun(before, 60_000);
			checkFour("in a run", llm.of("main"), { read: 0, grep: 0, write: 0, bash: 0 }, true);
			check("the director's write made its file and the command made none", existsSync(join(env.project, "direct-edit.txt")) && !existsSync(join(env.project, "direct-shell.txt")));
			check(
				"the run opened by the plan finished and its answer was accepted: the director's reads changed nothing in the record",
				run.results?.some(row => row.id === "probe-answer" && row.state === "accepted") === true && run.spawns.filter(spawn => spawn.outcome !== "blocked").length === 1,
				JSON.stringify(run.results),
			);
		});
	}, 240_000);

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
