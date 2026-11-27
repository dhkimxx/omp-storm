#!/usr/bin/env bun
/**
 * A read lane whose agent has a shell (0.28.0), real host: a disposable git checkout, an isolated HOME/profile, the pinned omp 19.2.1
 * and the local fake LLM. No paid model calls.
 *
 * A read-intent lane (explore, design, answer-only) whose agent definition already lists `bash` may run commands. Storm cannot bound
 * what a command writes, so such a lane is ordered like a writer: it never runs beside another writer, and no writer starts beside
 * it. No bundled role gains a tool: the shell here comes from an approved project definition of `storm-explorer` (`read, grep, find,
 * bash`), which is covered by the team's approval. The bundled `storm-architect` has no shell and stays a plain reader.
 *
 *   1. The plan's reply says the shell lane is ordered with the writers, and why.
 *   2. The explorer runs a command (`git log -1`, its output to a file outside the tree) and answers citing a file: accepted.
 *   3. While it runs, an implementer's placement is refused for write order, naming the lane and the reason; after it, it is placed.
 *   4. Its own path writes and a named service are refused (`lane-capability`, `lane-service`); its file is not written.
 *   5. Two bundled architect lanes (no shell) run together: the second is not refused beside the first.
 *
 * Usage:
 *   E2E_PORT=18831 E2E_WORK=/tmp/storm-e2e-read-shell ./node_modules/.bin/bun scripts/e2e/read-shell.ts
 *   E2E_ONLY=bundled runs one scenario (the team is approved first either way).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WHY_SHELL_READER } from "../../src/policy/capability.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { cancelAll, choose, LlmCursor, type LlmEntry, prepare, startFakeLlm, type Step, Suite } from "./harness.ts";
import { installProfile, runRequest, Sessions } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-read-shell", 18831);
seedFact(env.project);
const suite = new Suite("E2E (a read lane with a shell is ordered like a writer)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const CITED = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
const answer = (id: string) => requiredResult(id, "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE });
const change = (id: string, path: string) => requiredResult(id, "change", `${path} is the worker's change`, { path, contains: "storm child change" });
const shellLane = { name: "S", kind: "explore" as const, role: "explorer", goal: "read the history with a command and cite a file", results: [answer("s-answer")] };
const writer = { name: "W", kind: "code" as const, role: "implementer", files: ["w.txt"], goal: "write w.txt", results: [change("w-change", "w.txt")] };
const designLane = (name: string) => ({ name, kind: "design" as const, role: "architect", goal: "read and cite", results: [answer(`${name.toLowerCase()}-answer`)] });

/** The call a director request made (by a word in its arguments) and the answer its next request carried. */
function resultFor(main: readonly LlmEntry[], needle: string): string {
	const at = main.findIndex(entry => entry.decision.tool === "task" && JSON.stringify(entry.decision.args ?? {}).includes(needle));
	return at < 0 ? "" : (main[at + 1]?.trailingResults[0] ?? "");
}

function installShellExplorer(): void {
	const dir = join(env.project, ".omp", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "storm-explorer.md"), "---\nname: storm-explorer\ndescription: explorer that may also run commands\ntools: read, grep, find, bash\n---\nReport what you find, citing path:line.\n");
}

async function main(): Promise<void> {
	installShellExplorer();
	installProfile(env);
	await suite.step("approved team (the project's explorer has a shell), automatic delegation off", async () => {
		const { teams } = await sessions.approve("off");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("shell: the plan says it is ordered with the writers; the command runs; a writer's placement is refused beside it and placed after it", async () => {
		const ran = join(env.work, "read-shell-ran.txt");
		await sessions.open(cancelAll, async (rpc, files) => {
			const command = `git log -1 --format=%H > ${JSON.stringify(ran)}`;
			const steps: Step[] = [
				contractPlan([shellLane, writer], { contract: true, workers: { explorer: 1, implementer: 1 } }),
				{ tasks: [{ name: "S", agent: "storm-explorer", task: "Read", say: `E2E-CHILD-DELAY 6000 E2E-CHILD-SH ${base64(command)} ${CITED}` }] },
				{ tasks: [{ name: "W", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE w.txt" }] },
				{ wait: true },
				{ tasks: [{ name: "W", agent: "storm-implementer", task: "Write", say: "E2E-CHILD-WRITE w.txt" }] },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 150_000);
			const run = await files.finishedRun(before, 150_000);
			const main = llm.of("main");
			// The whole reply as the host delivered it (the fake provider's log cuts a result at 1,000 characters).
			const planReply = JSON.stringify(rpc.frames.find(frame => frame.type === "tool_execution_end" && frame.toolName === "storm")?.result ?? "");
			check("the plan's reply orders the shell lane with the writers and names the reason", planReply.includes("쓰기 순서: S, W 레인") && planReply.includes(WHY_SHELL_READER), planReply.slice(0, 500));
			check("the explorer's command ran (its output file holds the commit id) ", existsSync(ran) && readFileSync(ran, "utf8").trim().length >= 40, existsSync(ran) ? readFileSync(ran, "utf8") : "missing");
			const refused = main.flatMap((entry, at) => (entry.decision.tool === "task" && JSON.stringify(entry.decision.args ?? {}).includes('"name":"W"') ? [main[at + 1]?.trailingResults[0] ?? ""] : []));
			check("the writer's placement beside the running shell lane is refused for write order and names the lane", refused[0]?.includes("[storm:lane-write]") === true && refused[0].includes("'S'"), (refused[0] ?? "").slice(0, 500));
			check("after the shell lane has ended the same placement is accepted and the writer ran", refused[1] !== undefined && !refused[1].includes("[storm:lane-write]") && existsSync(join(env.project, "w.txt")), (refused[1] ?? "").slice(0, 300));
			check("the explorer's answer was accepted", run.results?.some(row => row.id === "s-answer" && row.state === "accepted") === true, JSON.stringify(run.results?.map(row => [row.id, row.state])));
			check("the writer's change was accepted", run.results?.some(row => row.id === "w-change" && row.state === "accepted") === true, JSON.stringify(run.results?.map(row => [row.id, row.state])));
		});
	}, 360_000);

	await suite.step("shell: its path write and a named service are refused, the command is not", async () => {
		const service = join(env.work, "read-shell-service");
		// One lane name per native session: this scenario places its own shell lane.
		const secondLane = { ...shellLane, name: "S2" };
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				contractPlan([secondLane], { contract: true, workers: { explorer: 1 } }),
				{ tasks: [{ name: "S2", agent: "storm-explorer", task: "Read", say: `E2E-CHILD-SERVICE ${base64(`printf started > ${JSON.stringify(service)}; echo ready; sleep 20`)} E2E-CHILD-SH ${base64("true")} E2E-CHILD-WRITE s-own.txt ${CITED}` }] },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 150_000);
			await files.finishedRun(before, 120_000);
			const kids = llm.of("child");
			const toolAnswers = kids.map(entry => entry.lastTool).filter(Boolean);
			check("the named service was refused (lane-service) and never started", toolAnswers.some(text => text.includes("[storm:lane-service]")) && !existsSync(service), JSON.stringify(toolAnswers.map(text => text.slice(0, 80))));
			// The host offers this lane no `write` tool at all (its definition lists none), so the call is answered "not found" before Storm's
			// guard is reached; the guard's own refusal for a tool the host does offer is held by the hook tests. Either way the file is not made.
			check("a path write by the shell lane did not happen: the host has no such tool for it, and the file does not exist", toolAnswers.some(text => text.includes("Tool write not found") || text.includes("[storm:lane-capability]")) && !existsSync(join(env.project, "s-own.txt")), JSON.stringify(toolAnswers.map(text => text.slice(0, 80))));
			check("the plain command passed (no refusal for it)", kids.some(entry => entry.decision.tool === "bash" && !JSON.stringify(entry.decision.args ?? {}).includes("e2e-service")), JSON.stringify(kids.map(entry => entry.decision.tool)));
		});
	}, 300_000);

	await suite.step("bundled: two bundled architect lanes (no shell) run together", async () => {
		// The team approves one architect; two lanes need two, so the maximum is raised and approved again through the real dialog.
		await sessions.open(choose(APPROVE), async (rpc, files) => {
			files.editConfig(config => {
				(config.roles.architect as unknown as Record<string, unknown>).workers = { min: 1, max: 2 };
			});
			await rpc.prompt("/storm");
			rpc.answer = cancelAll;
			const steps: Step[] = [
				contractPlan([designLane("P"), designLane("Q")], { contract: true, workers: { architect: 2 } }),
				{ tasks: [{ name: "P", agent: "storm-architect", task: "Read", say: `E2E-CHILD-DELAY 5000 ${CITED}` }] },
				{ tasks: [{ name: "Q", agent: "storm-architect", task: "Read", say: `E2E-CHILD-DELAY 1000 ${CITED}` }] },
				{ wait: true },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 150_000);
			const run = await files.finishedRun(before, 120_000);
			const second = resultFor(llm.of("main"), '"name":"Q"');
			check("the second architect is placed while the first runs: no write-order refusal for a reader without a shell", !second.includes("[storm:lane-write]") && run.spawns.filter(spawn => spawn.outcome === "routed").length === 2, `${second.slice(0, 200)} spawns=${JSON.stringify(run.spawns.map(spawn => [spawn.lane, spawn.outcome, spawn.code]))}`);
			check("both answers were accepted", ["p-answer", "q-answer"].every(id => run.results?.some(row => row.id === id && row.state === "accepted")), JSON.stringify(run.results?.map(row => [row.id, row.state])));
		});
	}, 300_000);

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
