#!/usr/bin/env bun
/**
 * The director changes project files itself during a run (0.28.0), real host: a disposable git checkout, an isolated
 * HOME/profile, the pinned omp 19.2.1 and the local fake LLM. No paid model calls.
 *
 * The director's `edit` and `write` are one more writer in the table that orders every writer. A path edit is bounded
 * (it names its files and ends with its message), so it may run beside a worker that holds other files by path; it never
 * runs beside a writer that cannot be bounded (a worker with a shell, a job, a required check), and such a writer never
 * starts beside it. What the real host has to show, each in its own scenario:
 *
 *   free      no writer: `edit` and `write` pass and the tree has both changes.
 *   shell     a shell worker placed (waiting for a permit) and running: the edit is refused naming the lane, and passes after it.
 *   order     both orders inside ONE assistant message: the edit first wins, the task is refused; the task first wins, the edit is.
 *   path      a worker that holds files by path only (an approved shadow with `write, edit`): other files pass, its own file and
 *             its directory are refused naming the lane.
 *   job       both orders with a job: a job asked for beside the edit is refused, an edit beside the job's process is refused.
 *   outside   a file outside the tree, one under `.git`, an address, a hashline payload naming `.git`, and two tools that are not
 *             tools of this host (`multi_edit`, `notebook_edit`): refused with their causes, nothing written.
 *   hold      an unclean turn (an edit of the message was refused) keeps its hold until the director's next COMPLETED answer: a
 *             request that is aborted does not release it, a completed one does; a clean turn is released at its own end.
 *   switch    a conversation switch while the director's own call runs (a write that takes a while), and while its hook is still
 *             pending: the run ends with the switch (the host waits for a running call; a call never started is released).
 *
 * Not here: the refusal of `edit` in `magic` mode is gone for good (the spend is counted from the journal), and the director's
 * shell is another rule (see `hardening-writers.ts`).
 *
 * Usage:
 *   E2E_PORT=18830 E2E_WORK=/tmp/storm-e2e-director-edit ./node_modules/.bin/bun scripts/e2e/director-edit.ts
 *   E2E_ONLY=order runs one scenario (the team is approved first either way).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import { DIRECTOR_EDIT_CAUSES, DIRECTOR_EDIT_LEAD } from "../../src/policy/director.ts";
import { DIRECTOR_DRAIN_WARNING, DIRECTOR_EDITING, DIRECTOR_WRITE_LEAD } from "../../src/runtime/arbiter.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import type { StormConfig } from "../../src/types.ts";
import { cancelAll, choose, LlmCursor, type LlmEntry, prepare, type Rpc, startFakeLlm, type Step, type StormFiles, Suite, TRACKED_FILE, until } from "./harness.ts";
import { installProfile, runRequest, Sessions, setOmpSettings } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-director-edit", 18830);
seedFact(env.project);
const suite = new Suite("E2E (the director changes files itself)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

const changeFor = (id: string, path: string) => requiredResult(id, "change", `${path} is the worker's change`, { path, contains: "storm child change" });
const lane = (name: string, role: "implementer" | "quick", file: string) => ({ name, kind: "code" as const, role, files: [file], goal: `write ${file}`, results: [changeFor(`${name.toLowerCase()}-change`, file)] });
const planOf = (names: Array<[string, "implementer" | "quick", string]>): Step =>
	contractPlan(names.map(([name, role, file]) => lane(name, role, file)), { contract: true, workers: { implementer: 2, quick: 2 } });
const implementer = (name: string, file: string, say = ""): Step => ({ tasks: [{ name, agent: "storm-implementer", task: "Write", say: `${say} E2E-CHILD-WRITE ${file}`.trim() }] });
const quick = (name: string, file: string, say = ""): Step => ({ tasks: [{ name, agent: "storm-quick", task: "Write", say: `${say} E2E-CHILD-WRITE ${file}`.trim() }] });
const write = (path: string, content = "director write\n"): Step => ({ call: "write", args: { path, content } });
const replace = (path: string, from: string, to: string): Step => ({ call: "edit", args: { path, old_string: from, new_string: to } });
const at = (name: string): string => join(env.project, name);
const exists = (name: string): boolean => existsSync(at(name));
const read = (name: string): string => (exists(name) ? readFileSync(at(name), "utf8") : "");

/** The call a director request made (by a word in its arguments) and the answers its next request carried, one per call of that message. */
function answersTo(main: readonly LlmEntry[], needle: string): { calls: string[]; answers: string[] } | undefined {
	const index = main.findIndex(entry => entry.decision.tool !== undefined && JSON.stringify(entry.decision.all ?? [entry.decision]).includes(needle));
	const entry = main[index];
	if (entry === undefined) return undefined;
	return { calls: (entry.decision.all ?? [{ tool: entry.decision.tool ?? "" }]).map(call => call.tool), answers: main[index + 1]?.trailingResults ?? [] };
}
const answerOf = (main: readonly LlmEntry[], needle: string, nth = 0): string => answersTo(main, needle)?.answers[nth] ?? "";
const refused = (answer: string, code: string): boolean => answer.includes(`[storm:${code}]`);

/** Writes the path-only definition of the quick role before the team is approved: its tools are `read, write, edit`, no shell. */
function installPathOnlyQuick(): void {
	const dir = join(env.project, ".omp", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "storm-quick.md"), "---\nname: storm-quick\ndescription: path-only quick worker\ntools: read, write, edit\n---\nPath-only worker.\n");
}

async function noWriter(): Promise<void> {
	await suite.step("free: with no writer the director's edit and write pass, and the tree has both", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				planOf([["A", "implementer", "a.txt"]]),
				replace(TRACKED_FILE, "storm e2e tracked file", "storm e2e director edit"),
				write("free-b.txt", "director b\n"),
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 120_000);
			const run = await files.finishedRun(before, 90_000);
			const main = llm.of("main");
			const edit = answerOf(main, TRACKED_FILE);
			const made = answerOf(main, "free-b.txt");
			check("the edit of a tracked file was not refused and changed the file", !edit.includes("[storm:") && read(TRACKED_FILE).includes("storm e2e director edit"), `${edit.slice(0, 300)} | ${read(TRACKED_FILE)}`);
			check("the write of a new file was not refused and made the file", !made.includes("[storm:") && read("free-b.txt") === "director b\n", `${made.slice(0, 300)} | ${read("free-b.txt")}`);
			check("nothing was counted as a refused edit", (run.blockedEdits ?? 0) === 0, `blockedEdits=${run.blockedEdits}`);
		});
	}, 240_000);
}

async function outsideTheTree(): Promise<void> {
	await suite.step("outside: a file outside the tree, under .git, an address and an unnameable tool are refused with their causes", async () => {
		// The host has no `multi_edit` or `notebook_edit`; the probe stands in for a plugin tool of those names (it writes the file its path names).
		env.childEnv.EDIT_PROBE_TOOLS = "1";
		await sessions.open(cancelAll, async (rpc, files) => {
			const outsideFile = join(env.work, "outside-the-tree.txt");
			const hashline = { input: "[.git/config#ABCD]\n1:x=1\n" };
			const steps: Step[] = [
				planOf([["A", "implementer", "a.txt"]]),
				write(outsideFile, "outside\n"),
				write(".git/config.storm", "inside git\n"),
				{ call: "edit", args: hashline },
				write("vault://note", "address\n"),
				{ call: "multi_edit", args: { path: "multi.txt" } },
				{ call: "notebook_edit", args: { path: "nb.ipynb" } },
				write("after-refusals.txt", "still fine\n"),
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 120_000);
			const run = await files.finishedRun(before, 90_000);
			const main = llm.of("main");
			const out = answerOf(main, outsideFile);
			check("a write outside the work tree is refused as director-edit with the cause, and no file exists", refused(out, "director-edit") && out.includes(DIRECTOR_EDIT_LEAD) && out.includes(DIRECTOR_EDIT_CAUSES.outside("").slice(0, 8)) && !existsSync(outsideFile), out.slice(0, 400));
			const git = answerOf(main, ".git/config.storm");
			check("a write under .git is refused with the internal cause", refused(git, "director-edit") && git.includes(DIRECTOR_EDIT_CAUSES.internal) && !exists(".git/config.storm"), git.slice(0, 400));
			const section = answerOf(main, "ABCD");
			check("a hashline payload that names .git/config is read by the host's parser and refused with the internal cause", refused(section, "director-edit") && section.includes(DIRECTOR_EDIT_CAUSES.internal), section.slice(0, 400));
			const address = answerOf(main, "vault://note");
			check("an address write is refused with the address cause", refused(address, "director-edit") && address.includes(DIRECTOR_EDIT_CAUSES.address), address.slice(0, 400));
			for (const [needle, tool] of [["multi.txt", "multi_edit"], ["nb.ipynb", "notebook_edit"]] as const) {
				const answer = answerOf(main, needle);
				check(`a plugin tool named ${tool} is refused by Storm: it writes files Storm cannot name, and the file was not written`, refused(answer, "director-edit") && !exists(needle), answer.slice(0, 300));
			}
			const fine = answerOf(main, "after-refusals.txt");
			check("a plain write after the refusals passes: a refusal holds nothing", !fine.includes("[storm:") && read("after-refusals.txt") === "still fine\n", fine.slice(0, 300));
			check("the refusals were counted", (run.blockedEdits ?? 0) >= 4, `blockedEdits=${run.blockedEdits}`);
		}, ["-e", PROBE]);
		delete env.childEnv.EDIT_PROBE_TOOLS;
	}, 240_000);
}

const EDIT_MODE = "edit:\n  mode: replace\n";
const PROBE = join(import.meta.dir, "edit-probe-plugin.ts");
const CITED = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
const answerLane = { name: "R", kind: "explore" as const, role: "explorer", goal: "read", results: [requiredResult("r-answer", "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE })] };
const explorer = (say: string): Step => ({ tasks: [{ name: "R", agent: "storm-explorer", task: "Read", say }] });
const wait: Step = { wait: true };

async function placedAndRunning(): Promise<void> {
	await suite.step("shell: a placed and a running shell worker refuse the edit, naming the lane; it passes after the worker", async () => {
		setOmpSettings(env, `${EDIT_MODE}task:\n  maxConcurrency: 1\n`);
		await sessions.open(cancelAll, async (rpc, files) => {
			// R holds the only permit for about 9 s, so A is placed at once and starts only after R: the edit meets it first as
			// "placed (before its start)" and then, past 12 s, as a running worker.
			const steps: Step[] = [
				contractPlan([answerLane, lane("A", "implementer", "a.txt")], { contract: true, workers: { explorer: 1, implementer: 1 } }),
				explorer(`E2E-CHILD-DELAY 9000 ${CITED}`),
				implementer("A", "a.txt", "E2E-CHILD-DELAY 7000"),
				write("shell-d1.txt"),
				{ ...write("shell-d2.txt"), pauseMs: 12_000 },
				wait,
				wait,
				write("shell-d3.txt", "after the worker\n"),
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps, 2), 150_000);
			const run = await files.finishedRun(before, 150_000);
			const main = llm.of("main");
			const placed = answerOf(main, "shell-d1.txt");
			check("an edit beside the placed shell worker is refused as director-write and names the lane's placement", refused(placed, "director-write") && placed.includes(DIRECTOR_WRITE_LEAD) && placed.includes("'A' 레인 배치(시작 전)"), placed.slice(0, 400));
			const running = answerOf(main, "shell-d2.txt");
			check("an edit beside the running shell worker is refused as director-write and names the lane's worker", refused(running, "director-write") && running.includes("'A' 레인 워커"), running.slice(0, 400));
			check("neither refused edit left a file", !exists("shell-d1.txt") && !exists("shell-d2.txt"));
			const after = answerOf(main, "shell-d3.txt");
			check("after the worker has ended the same edit passes and the file exists", !after.includes("[storm:") && read("shell-d3.txt") === "after the worker\n", after.slice(0, 400));
			check("the worker ran to its end beside the refusals: its file exists and its change was accepted", exists("a.txt") && run.results?.some(row => row.id === "a-change" && row.state === "accepted") === true, JSON.stringify(run.results?.map(row => [row.id, row.state])));
		});
	}, 360_000);
}

async function bothOrders(): Promise<void> {
	await suite.step("order: one message with an edit and a task, in both orders, gives opposite winners", async () => {
		setOmpSettings(env, EDIT_MODE);
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				planOf([["OA", "implementer", "a-order.txt"], ["OB", "implementer", "b-order.txt"]]),
				{ calls: [write("order-o1.txt"), implementer("OA", "a-order.txt", "E2E-CHILD-DELAY 2000")] },
				// The next message: the hold of the first one is over, so the same task is placed.
				implementer("OA", "a-order.txt", "E2E-CHILD-DELAY 3000"),
				wait,
				{ calls: [implementer("OB", "b-order.txt", "E2E-CHILD-DELAY 3000"), write("order-o2.txt")] },
				wait,
				write("order-o3.txt", "after both\n"),
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps, 2), 150_000);
			const run = await files.finishedRun(before, 150_000);
			const main = llm.of("main");
			const first = answersTo(main, "order-o1.txt");
			check("[edit, task]: the edit passes and writes its file", first !== undefined && first.calls.join() === "write,task" && !first.answers[0]?.includes("[storm:") && exists("order-o1.txt"), JSON.stringify(first)?.slice(0, 500));
			check("[edit, task]: the task is refused for write order and names the director's own edit", refused(first?.answers[1] ?? "", "lane-write") && (first?.answers[1] ?? "").includes(DIRECTOR_EDITING), (first?.answers[1] ?? "").slice(0, 500));
			const second = answersTo(main, "order-o2.txt");
			check("[task, edit]: the task is placed", second !== undefined && second.calls.join() === "task,write" && !second.answers[0]?.includes("[storm:"), JSON.stringify(second)?.slice(0, 500));
			check("[task, edit]: the edit is refused as director-write naming the lane, and writes nothing", refused(second?.answers[1] ?? "", "director-write") && (second?.answers[1] ?? "").includes("'OB' 레인") && !exists("order-o2.txt"), (second?.answers[1] ?? "").slice(0, 500));
			check("the refused task of the first message was placed one message later and both workers ran", exists("a-order.txt") && exists("b-order.txt") && run.spawns.filter(spawn => spawn.outcome === "routed").length === 2, JSON.stringify(run.spawns.map(spawn => [spawn.lane, spawn.outcome, spawn.code])));
			check("after both workers the edit passes", read("order-o3.txt") === "after both\n");
		});
	}, 360_000);
}

async function pathOnlyWorker(): Promise<void> {
	await suite.step("path: a worker that holds files by path only lets other files through and refuses its own", async () => {
		setOmpSettings(env, EDIT_MODE);
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				planOf([["Q", "quick", "q-owned.txt"]]),
				quick("Q", "q-owned.txt", "E2E-CHILD-DELAY 9000"),
				{ ...write("path-other.txt", "other file\n"), pauseMs: 2_500 },
				write("q-owned.txt", "director over the worker\n"),
				wait,
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps, 2), 150_000);
			const run = await files.finishedRun(before, 150_000);
			const main = llm.of("main");
			const other = answerOf(main, "path-other.txt");
			check("an edit of a file the worker does not hold passes beside the running path-only worker", !other.includes("[storm:") && read("path-other.txt") === "other file\n", other.slice(0, 400));
			const same = answerOf(main, "director over the worker");
			check("an edit of the file the worker holds is refused as director-write and names the lane", refused(same, "director-write") && same.includes("'Q' 레인") && same.includes(DIRECTOR_WRITE_LEAD), same.slice(0, 400));
			check("the worker's file is the worker's: it wrote it and the director's text is not in it", read("q-owned.txt") === "storm child change\n", read("q-owned.txt"));
			check("the worker's change was accepted", run.results?.some(row => row.id === "q-change" && row.state === "accepted") === true, JSON.stringify(run.results?.map(row => [row.id, row.state])));
		});
	}, 300_000);
}

/** Opens a run in a fresh session with the job and the required check of these scenarios approved through the real dialog. */
async function withJobs(body: (rpc: Rpc, files: StormFiles) => Promise<void>, config: (stored: StormConfig) => void): Promise<void> {
	await sessions.open(choose(APPROVE), async (rpc, files) => {
		files.editConfig(config);
		const dialogs = rpc.dialogs.length;
		await rpc.prompt("/storm");
		check("the job and check definitions were approved through the real dialog", rpc.dialogs.slice(dialogs).some(dialog => dialog.answer === APPROVE), JSON.stringify(rpc.dialogs.slice(dialogs)));
		rpc.answer = cancelAll;
		await body(rpc, files);
	});
}

async function jobAndEdit(): Promise<void> {
	const started = join(env.work, "job-started");
	const resource = `e2e-director-edit:${new Bun.CryptoHasher("sha256").update(env.work).digest("hex").slice(0, 12)}`;
	const script = `require("node:fs").appendFileSync(${JSON.stringify(started)},"start\\n");setTimeout(()=>{console.log("JOB-EDIT-DONE");},2500);`;
	await suite.step("job: a job asked for beside the edit is refused and runs one message later", async () => {
		setOmpSettings(env, EDIT_MODE);
		await withJobs(
			async (rpc, files) => {
				const lanes = [{ name: "J", kind: "run", job: "edit-job", results: [{ id: "j-receipt", kind: "answer", criterion: "the job's own output", contains: "JOB-EDIT-DONE" }] }];
				const execute = (): Step => ({ storm: { action: "execute", lanes: ["J"] } });
				const steps: Step[] = [
					{ storm: { action: "plan", plan: { lanes } } },
					{ calls: [write("job-edit-1.txt"), execute()] },
					execute(),
				];
				const llm = new LlmCursor(env);
				const before = files.runIds();
				await rpc.prompt(runRequest(steps), 120_000);
				const run = await files.finishedRun(before, 90_000);
				const first = answersTo(llm.of("main"), "job-edit-1.txt");
				check("[edit, execute]: the edit passes", !first?.answers[0]?.includes("[storm:") && exists("job-edit-1.txt"), JSON.stringify(first)?.slice(0, 400));
				// The host's order is: both hooks, then the message's own message_end, then the calls run. A hold that the message's own
				// message_end freed would let this job start while the edit's turn is open (found on this host in the integration pass).
				check("[edit, execute]: the job is refused with job-wait, naming the director's edit, although the message's own message_end came before it ran", refused(first?.answers[1] ?? "", "job-wait") && (first?.answers[1] ?? "").includes("감독이 파일을 직접 고치는 중"), (first?.answers[1] ?? "").slice(0, 500));
				const job = run.jobs?.find(row => row.name === "edit-job");
				check("one message later the same job runs and passes, and its result is accepted", job?.status === "passed" && run.results?.some(row => row.id === "j-receipt" && row.state === "accepted") === true, JSON.stringify({ job, results: run.results?.map(row => [row.id, row.state]) }));
				check("the process ran once: the refused call started nothing", existsSync(started) && readFileSync(started, "utf8").split("\n").filter(Boolean).length === 1, existsSync(started) ? readFileSync(started, "utf8") : "never");
			},
			stored => {
				stored.jobs = [{ name: "edit-job", argv: [process.execPath, "-e", script], resources: [resource] }];
			},
		);
	}, 300_000);
}

async function checkAndEdit(): Promise<void> {
	const marker = join(env.work, "check-running");
	const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(marker)},String(Date.now()));setTimeout(()=>process.exit(0),9000);`;
	await suite.step("check: an edit made while a required check's process runs is refused naming the check", async () => {
		setOmpSettings(env, EDIT_MODE);
		await withJobs(
			async (rpc, files) => {
				// The check starts at the look after the director's turn, so the director is idle while it runs: the user's next message
				// (here a scripted prompt) is what makes the director edit meanwhile.
				const steps: Step[] = [
					contractPlan(
						[lane("CA", "implementer", "chk-a.txt"), { name: "CV", kind: "review" as const }],
						{ contract: true, workers: { implementer: 1, reviewer: 1 } },
					),
					implementer("CA", "chk-a.txt"),
					wait,
					{ tasks: [{ name: "CV", agent: "storm-reviewer", task: "Review", say: "E2E-CHILD-VERDICT correct" }] },
					wait,
				];
				const llm = new LlmCursor(env);
				const before = files.runIds();
				await rpc.prompt(runRequest(steps), 150_000);
				await until(() => (existsSync(marker) ? true : undefined), 90_000, "the required check's process to start");
				const during = `E2E-STEPS ${JSON.stringify([write("chk-during.txt")])}`;
				await rpc.turn(during, 60_000);
				const run = await files.finishedRun(before, 120_000);
				const answer = answerOf(llm.of("main"), "chk-during.txt");
				check("the edit made while the check's process ran is refused as director-write naming the required check, and wrote nothing", refused(answer, "director-write") && answer.includes("필수 검사") && !exists("chk-during.txt"), answer.slice(0, 500));
				// The user's extra prompt is a second director turn inside the run; the run's own end then cancels what is still running.
				check("the check's process had started (the run record names it) when the edit was refused", run.checks?.some(entry => entry.name === "slow-check") === true && existsSync(marker), JSON.stringify(run.checks));
			},
			stored => {
				stored.requiredChecks = [{ name: "slow-check", argv: [process.execPath, "-e", script] }];
			},
		);
	}, 360_000);
}

/** The director's request for a step has reached the provider (the fake logs it before it answers, and a held step answers late). */
const requested = (llm: LlmCursor, needle: string): boolean => llm.of("main").some(entry => JSON.stringify(entry.decision.all ?? [entry.decision]).includes(needle));

async function holdsToTheNextCompletedAnswer(): Promise<void> {
	await suite.step("hold: a clean turn is released at its own end; an unclean one (a refused or aborted edit in it) is kept until the director's next COMPLETED answer", async () => {
		setOmpSettings(env, EDIT_MODE);
		const cases: Array<{ name: string; steps: Step[]; abortAfter: string; clean: boolean; flags?: string[] }> = [
			{ name: "clean", clean: true, abortAfter: "hold-pause-1", steps: [planOf([["A", "implementer", "a-hold.txt"]]), write("hold-c1.txt"), { read: FACT_FILE, pauseMs: 8_000 }] },
			{ name: "refused", clean: false, abortAfter: "hold-pause-2", steps: [planOf([["A", "implementer", "a-hold.txt"]]), { calls: [write("hold-u1.txt"), write(join(env.work, "hold-outside.txt"))] }, { read: FACT_FILE, pauseMs: 8_000 }] },
			{ name: "aborted", clean: false, abortAfter: "hook-delay-a2", flags: ["-e", PROBE], steps: [planOf([["A", "implementer", "a-hold.txt"]]), { calls: [write("hold-a1.txt"), write("hook-delay-a2.txt")] }] },
		];
		for (const one of cases) {
			await sessions.open(cancelAll, async (rpc, files) => {
				const llm = new LlmCursor(env);
				const before = files.runIds();
				rpc.send({ type: "prompt", message: runRequest(one.steps) });
				// The step after the edit is held by the fake provider for 8 s (or, for the aborted case, the probe holds the second
				// call's hook for 8 s): the user's abort lands while it is.
				await until(() => (requested(llm, one.name === "clean" ? FACT_FILE : one.name === "refused" ? FACT_FILE : "hook-delay-a2") ? true : undefined), 60_000, `the request after the ${one.name} edit`);
				await Bun.sleep(one.name === "aborted" ? 2_000 : 500);
				const abortedAt = Date.now();
				rpc.send({ type: "abort" });
				if (one.clean) {
					const run = await files.finishedRun(before, 30_000);
					check(`${one.name}: the turn's own end released the edit, so the run ended soon after the user's abort`, run.endedAt !== undefined && exists("hold-c1.txt"), `${run.status}/${run.endReason} after ${Date.now() - abortedAt} ms`);
					return;
				}
				// Not clean: the hold waits for a completed answer, and an aborted request is not one.
				await Bun.sleep(10_000);
				const live = files.runs().find(candidate => !before.has(candidate.runId));
				check(`${one.name}: ten seconds after the abort the run has not ended: the hold is kept (no completed answer came)`, live !== undefined && live.endedAt === undefined, JSON.stringify({ status: live?.status, endReason: live?.endReason }));
				check(`${one.name}: nothing was committed by a refused or never-run call`, !exists("hold-outside.txt") && !exists("hook-delay-a2.txt"), "");
				// The director's next completed answer: the user's next message gets a normal reply, and that releases the hold.
				await rpc.turn("hello", 90_000);
				const run = await files.finishedRun(before, 60_000);
				check(`${one.name}: the next completed answer ended the wait: the run ended`, run.endedAt !== undefined, `${run.status}/${run.endReason}`);
			}, one.flags ?? []);
		}
	}, 420_000);
}

async function switchWhileACallRuns(): Promise<void> {
	await suite.step("switch: a conversation switch while the director's own call is pending or running ends the run as decision D2 says", async () => {
		setOmpSettings(env, EDIT_MODE);
		env.childEnv.EDIT_PROBE_SLOW = "1";
		try {
			// (a) The call is RUNNING (the probe's write takes 6 s and ignores the abort). What the host does on 19.2.1: `new_session` awaits the
			// old loop's abort, which waits for the call, so `tool_result` comes and then `session_switch`, six seconds after the switch was
			// asked for. Storm sees the call's result before the switch and releases its hold there: the run ends at the switch, with the
			// write complete. The residual D2 states (a commit still in flight when the host reports the old loop aborted) needs a tool
			// that returns early on abort; the host's `write` could in principle (read in source), and no tool of this host was seen to.
			await sessions.open(cancelAll, async (rpc, files) => {
				const before = files.runIds();
				const steps: Step[] = [planOf([["A", "implementer", "a-switch.txt"]]), write("slow-switch.txt", "slow director write\n"), { read: FACT_FILE }];
				rpc.send({ type: "prompt", message: runRequest(steps) });
				await until(() => rpc.frames.find(frame => frame.type === "tool_execution_start" && frame.toolName === "write" && JSON.stringify(frame.args ?? {}).includes("slow-switch")), 60_000, "the director's slow write to start");
				const switchedAt = Date.now();
				rpc.send({ type: "new_session" });
				const run = await files.finishedRun(before, 30_000);
				const endedAfter = Date.now() - switchedAt;
				console.log(`HOST-FACT switch-running: ${JSON.stringify({ status: run.status, endReason: run.endReason, endedAfterMs: endedAfter, fileAtEnd: exists("slow-switch.txt") })}`);
				check("a call that was running when the conversation switched: the run ended with the switch (stopped, shutdown)", run.status === "stopped" && run.endReason === "shutdown", `${run.status}/${run.endReason} after ${endedAfter} ms`);
				check("and not before the call was over: the host waited for it, so the write is complete when the run ended", exists("slow-switch.txt") && read("slow-switch.txt") === "slow director write\n", `after ${endedAfter} ms file=${exists("slow-switch.txt")}`);
			}, ["-e", PROBE]);
		} finally {
			delete env.childEnv.EDIT_PROBE_SLOW;
		}
		// (b) The call's hook is still PENDING at the switch: it never executes, its hold is released, the run ends, and nothing is written.
		await sessions.open(cancelAll, async (rpc, files) => {
			const llm = new LlmCursor(env);
			const before = files.runIds();
			const steps: Step[] = [planOf([["A", "implementer", "a-switch.txt"]]), write("hook-delay-switch.txt", "never\n")];
			rpc.send({ type: "prompt", message: runRequest(steps) });
			await until(() => (requested(llm, "hook-delay-switch") ? true : undefined), 60_000, "the director's call with the pending hook");
			await Bun.sleep(2_000);
			rpc.send({ type: "new_session" });
			const run = await files.finishedRun(before, 30_000);
			check("a call whose hook was pending at the switch: the run ended at the switch with the hold released", run.endReason === "shutdown", `${run.status}/${run.endReason}`);
			await Bun.sleep(8_000);
			check("and the call never ran: its file does not exist after the hook's delay is over", !exists("hook-delay-switch.txt"), "");
		}, ["-e", PROBE]);
	}, 420_000);
}

async function main(): Promise<void> {
	installPathOnlyQuick();
	installProfile(env, EDIT_MODE);
	await suite.step("approved team, automatic delegation off", async () => {
		const { teams } = await sessions.approve("off");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await noWriter();
	await outsideTheTree();
	await placedAndRunning();
	await bothOrders();
	await pathOnlyWorker();
	await jobAndEdit();
	await checkAndEdit();
	await holdsToTheNextCompletedAnswer();
	await switchWhileACallRuns();

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
void [APPROVE, choose, until, DIRECTOR_DRAIN_WARNING, DIRECTOR_EDITING, DIRECTOR_WRITE_LEAD, implementer, quick];
