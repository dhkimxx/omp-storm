#!/usr/bin/env bun
/**
 * The approved model and effort are what runs (0.27.0 hardening, guarantee G2), real host: a disposable git checkout, an
 * isolated HOME/profile, the pinned omp 19.2.1 and the local fake LLM. No paid model calls.
 *
 * Two holes of 0.26.0 that the investigation proved on this host (/tmp/storm-h/V1-report.md, claims 1a and 3a):
 *
 *   (a) With omp's `task.enableEffort` on, the `effort` the director put in its `task` call won over the effort Storm
 *       had approved: the fake provider received `max` for an explorer approved at `medium`. Storm now removes `effort`
 *       and `model` from the call when it places it and tells the director once, in that call's own result.
 *   (b) When none of a role's approved models could sign in any more (an expired login, a key command that fails),
 *       omp fell back to the model of the session that asked, which is outside the team. Storm now answers the spawn
 *       with a refusal when no approved model of the role can sign in, so no request reaches any model.
 *
 * Both scenarios open a manual run with a scripted director (`runRequest`), as the existing phase-1 scenarios do.
 *
 * Not runnable until the wiring pass has put the hardening into `src/extension.ts`: (a) needs `RunLanes.place` to strip the
 * fields (already in `src/runtime/lanes.ts`) and the extension to deliver `placed.notes` in the call's result; (b) needs the
 * spawn hook to probe the credentials of the team's models (`src/policy/model-check.ts`, wiring note A of the Hb report).
 *
 * Usage:
 *   E2E_PORT=18811 E2E_WORK=/tmp/storm-e2e-hardening-pins ./node_modules/.bin/bun scripts/e2e/hardening-pins.ts
 *   E2E_ONLY=credentials ... runs one scenario (it still approves its team first).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PINNED_NOTE_TAG } from "../../src/runtime/lanes.ts";
import type { StormConfig } from "../../src/types.ts";
import { contractPlan, requiredResult } from "./contract-fixture.ts";
import { cancelAll, LlmCursor, type LlmEntry, modelId, modelsYml, prepare, price, startFakeLlm, type Step, Suite, TEAM_PROVIDERS } from "./harness.ts";
import { installProfile, runRequest, Sessions, setOmpSettings } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-hardening-pins", 18811);
seedFact(env.project);
const suite = new Suite("E2E (the approved model and effort are what runs)", env);
const check = suite.check.bind(suite);

/** A model of a provider the team does not contain: the session that asks runs on it, so a fallback to it is visible. */
const OUTSIDER = "fake9/outsider-z";
const PROVIDERS_WITH_OUTSIDER = { ...TEAM_PROVIDERS, fake9: [{ id: "outsider-z", cost: price(5, 25), context: 60_000 }] };

const LANE = "probe-1";
const CITED = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
const explorerLane = { name: LANE, kind: "explore" as const, role: "explorer", goal: "read one file", results: [requiredResult("probe-answer", "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE })] };

/** The effort an approved entry runs at: its own suffix, else the role's default. */
function approvedEffort(config: StormConfig, role: string): string | undefined {
	const entry = config.roles[role]?.models[0];
	return entry?.match(/:(minimal|low|medium|high|xhigh|max)$/)?.[1] ?? config.roles[role]?.effort;
}

/** The same fake models with the credentials of every provider but `keep` replaced by a key command that fails. */
function withBrokenKeys(yml: string, keep: string): string {
	let provider = "";
	return yml
		.split("\n")
		.map(line => {
			const head = /^ {2}(\w+):$/.exec(line);
			if (head !== null) provider = head[1] ?? "";
			return provider !== keep && line.trim().startsWith("apiKey:") ? line.replace("storm-e2e-dummy", '"!exit 1"') : line;
		})
		.join("\n");
}

async function effortIsPinned(): Promise<void> {
	const sessions = new Sessions(env);
	installProfile(env);
	await suite.step("effort: approved team, automatic delegation off", async () => {
		const { teams } = await sessions.approve("off");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("effort: the director passes a high effort; the worker's request carries the approved one and the director reads why once", async () => {
		// omp's switch that lets a `task` call carry an effort (`lo`, `med`, `hi`); off by default, and on in 0.26.0 it won.
		setOmpSettings(env, "task:\n  enableEffort: true\n");
		await sessions.open(cancelAll, async (rpc, files) => {
			const config = files.config();
			const effort = approvedEffort(config, "explorer");
			const approvedIds = (config.roles.explorer?.models ?? []).map(entry => modelId(entry));
			check("the approved explorer has an effort lower than the highest one the fake models offer", effort !== undefined && effort !== "max", `explorer=${JSON.stringify(config.roles.explorer?.models)} effort=${effort}`);
			const steps: Step[] = [
				contractPlan([explorerLane], { contract: true, workers: { explorer: 1 } }),
				{ tasks: [{ name: LANE, agent: "storm-explorer", task: "Report from source", say: CITED, effort: "hi" }] },
				{ wait: true },
			];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before);
			const main = llm.of("main");
			const kids = llm.of("child");

			const called = main.map(entry => entry.decision).filter(decision => decision.tool === "task").map(decision => JSON.stringify(decision.args ?? {}));
			check("the director's call really carried effort hi (the field this scenario is about)", called.length === 1 && called[0]!.includes('"effort":"hi"'), called.join("\n"));
			check("the worker ran: at least one request reached the fake provider for it", kids.length > 0, `children=${kids.length}`);
			check(
				"every request of the worker carries the approved effort and an approved model, never the effort the director passed",
				kids.every(entry => entry.effort === effort && approvedIds.includes(entry.model)),
				JSON.stringify(kids.map(entry => [entry.model, entry.effort])),
			);
			check("the spawn was routed to the approved models and not refused", run.spawns.some(spawn => spawn.agent === "storm-explorer" && spawn.outcome === "routed"), JSON.stringify(run.spawns.map(spawn => [spawn.agent, spawn.outcome, spawn.code])));
			check("the answer was accepted: the worker went on and the run was not disturbed", run.results?.some(row => row.id === "probe-answer" && row.state === "accepted") === true, JSON.stringify(run.results));

			// What omp 19.2.1 does with a hook's `additionalContext` (seen here): it is a user message after the call's tool result,
			// not text inside it, and it stays in the history. So the note is read in the first request after the call, and
			// "once" means that no request holds it twice.
			const noteIn = (entry: LlmEntry): string[] => entry.notes.filter(text => text.includes(PINNED_NOTE_TAG));
			const callAt = main.findIndex(entry => entry.decision.tool === "task");
			const noteAt = main.findIndex(entry => noteIn(entry).length > 0);
			const note = noteIn(main[noteAt] ?? main[0]!)[0];
			check("the first request after the task call carries the line that says its effort was not used", callAt >= 0 && noteAt === callAt + 1, `call=${callAt} note=${noteAt}`);
			check("and names the field it removed", note?.includes("`effort`") === true && note.includes("`model`") === false, note?.slice(0, 400) ?? "no note");
			check("it is told once: no request of the director holds the line twice", main.every(entry => noteIn(entry).length <= 1), JSON.stringify(main.map(entry => noteIn(entry).length)));
		});
	}, 300_000);

	await suite.step("effort: every OMP session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	});
}

async function credentialsAreRequired(): Promise<void> {
	// The session runs on a model outside the team: omp falls back to it when no approved model can sign in.
	const sessions = new Sessions(env, OUTSIDER);
	const healthy = modelsYml(env.port, PROVIDERS_WITH_OUTSIDER);
	await suite.step("credentials: a team approved while its models could sign in", async () => {
		setOmpSettings(env, "");
		writeFileSync(join(env.agentDir, "models.yml"), healthy);
		const { teams } = await sessions.approve("off");
		check("the profile has one approved team in this session", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("credentials: every approved model of the role loses its login; the spawn is refused and no request reaches any model", async () => {
		// After approval, before the process that runs the work starts (omp reads its model files then): the team's providers keep
		// their key entry but the command that produces the key now fails; the session's own provider still signs in.
		writeFileSync(join(env.agentDir, "models.yml"), withBrokenKeys(healthy, "fake9"));
		await sessions.open(cancelAll, async (rpc, files) => {
			const approved = files.config().roles.explorer?.models ?? [];
			check("none of the explorer's approved models is the session's own model", approved.length > 0 && approved.every(entry => !entry.startsWith("fake9/")), JSON.stringify(approved));
			const steps: Step[] = [contractPlan([explorerLane], { contract: true, workers: { explorer: 1 } }), { tasks: [{ name: LANE, agent: "storm-explorer", task: "Report from source", say: CITED }] }, { wait: true }];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before);
			const main = llm.of("main");
			const kids = llm.of("child");

			const blocked = run.spawns.filter(spawn => spawn.agent === "storm-explorer");
			check("the spawn was refused as unapproved, and no spawn of the role was routed", blocked.length >= 1 && blocked.every(spawn => spawn.outcome === "blocked" && spawn.code === "unapproved"), JSON.stringify(blocked.map(spawn => [spawn.outcome, spawn.code, spawn.models])));
			check("no request reached any model for the worker: not an approved one, not the session's own", kids.length === 0, JSON.stringify(kids.map(entry => [entry.model, entry.effort])));
			check("in particular nothing was asked of the model outside the team on the worker's behalf", llm.all().every(entry => entry.who === "main" || entry.who === "side" || entry.who === "route" || entry.model !== "outsider-z"), JSON.stringify(llm.all().map(entry => [entry.who, entry.model])));
			// The refusal reaches the director as the failure of the spawned job, in the result of its `wait` (a tool result of
			// the session, as omp hands it to the model).
			const told = rpc.frames.some(frame => frame.type === "message_end" && JSON.stringify(frame.message ?? {}).includes("[storm:unapproved]") && (frame.message as { role?: string } | undefined)?.role === "toolResult");
			check("the director read the refusal with its code", told, JSON.stringify(main.map(entry => entry.lastToolResult.slice(0, 120))));
			check("the answer was not accepted: nothing ran to produce it", run.results?.some(row => row.id === "probe-answer" && row.state === "accepted") !== true, JSON.stringify(run.results));
		});
	}, 300_000);

	await suite.step("credentials: every OMP session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	});
}

/**
 * A later extension replaces the model Storm's spawn hook answered with (V1 form 3b: the host runs extensions in load order and
 * uses the last `model` answer, so Storm cannot stop it in its own hook). The only thing that can is the check of the worker's
 * own request, in `before_provider_request`, which aborts it. This asks the real host two things the code only assumed: that the
 * handler fires in the worker's session with that worker's model and thinking level, and that aborting there keeps the request
 * from the provider (the fake provider's log shows whether one arrived).
 */
async function aSwappedAnswerNeverReachesTheProvider(): Promise<void> {
	const sessions = new Sessions(env, OUTSIDER);
	const swap = join(import.meta.dir, "swap-plugin.ts");
	await suite.step("swap: a team approved while its models could sign in", async () => {
		setOmpSettings(env, "");
		writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, PROVIDERS_WITH_OUTSIDER));
		const { teams } = await sessions.approve("off");
		check("the profile has one approved team in this session", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("swap: a later extension answers the spawn with a model outside the team; the worker is stopped and no request reaches the provider", async () => {
		await sessions.open(cancelAll, async (rpc, files) => {
			const steps: Step[] = [contractPlan([explorerLane], { contract: true, workers: { explorer: 1 } }), { tasks: [{ name: LANE, agent: "storm-explorer", task: "Report from source", say: CITED }] }, { wait: true }];
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(runRequest(steps), 180_000);
			const run = await files.finishedRun(before);
			const kids = llm.of("child");
			const spawn = run.spawns.find(row => row.spawnKey === LANE && row.outcome !== "blocked");
			console.log(`HOST-FACT swap: ${JSON.stringify({ answered: spawn?.models, ran: spawn?.ran, childRequests: kids.map(entry => [entry.model, entry.effort]) })}`);
			check("Storm answered the spawn with approved models (the swap is a later extension's, not Storm's)", spawn !== undefined && (spawn.models ?? []).every(entry => !entry.startsWith("fake9/")), JSON.stringify(spawn));
			check(
				"the check fired in the worker's own session with that worker's model and thinking level: the record names the outside model and its level as a mismatch",
				spawn?.ran?.verdict === "mismatch" && spawn.ran.model === OUTSIDER && spawn.ran.effort !== undefined,
				JSON.stringify(spawn?.ran),
			);
			check("no request of the worker reached the provider, on the outside model or any other: aborting in the hook stops it before it is sent", kids.length === 0, JSON.stringify(kids.map(entry => [entry.model, entry.effort])));
			const told = rpc.frames.some(frame => frame.type === "message_end" && JSON.stringify(frame.message ?? {}).includes("워커를 멈췄습니다"));
			check("the director was told the worker was stopped, and why", told, "no message");
			check("the answer was not accepted: nothing ran to produce it", run.results?.some(row => row.id === "probe-answer" && row.state === "accepted") !== true, JSON.stringify(run.results));
		}, ["-e", swap]);
	}, 300_000);

	await suite.step("swap: every OMP session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	});
}

let code = 1;
const server = await startFakeLlm(env);
try {
	await effortIsPinned();
	await credentialsAreRequired();
	await aSwappedAnswerNeverReachesTheProvider();
} catch (error) {
	suite.check("harness", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	server.kill();
	await server.exited;
	code = suite.finish();
}
process.exit(code);
