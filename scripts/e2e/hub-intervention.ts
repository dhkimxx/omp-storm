#!/usr/bin/env bun
/**
 * Direct user intervention through omp's Agent Hub (0.32 I2, I3, I4), on the real host on a pty: the hub (`alt+a`) and a
 * worker focused from it (Enter) exist only in the TUI. A disposable git checkout, an isolated HOME/profile, the pinned
 * omp and the local fake LLM; no paid calls.
 *
 *   1. I2 admitted: a writer that finished its turn is focused in the hub and told what to do. Its new turn runs under this
 *      run's approval and write place (it really changes a file), the ledger counts a user turn, and the director's next
 *      request carries the one line `사용자가 <lane>의 워커에게 직접 지시함`, never the prompt itself.
 *   2. I3: in the same focused view the user switches the worker to a model its role does not approve and
 *      prompts again. The request is stopped before it reaches the provider, the director is told both causes
 *      (`MODEL_CHANGE_CAUSES`), and `/storm` offers `역할 <R>에 <model> 승인`.
 *   3. I2 read-only: another lane's shell-capable writer is running and holds the write place. The same prompt to the
 *      idle writer goes on read-only: its first write is refused with `[storm:user-turn]`, naming the lane that holds it.
 *   4. I4: that running writer is stopped from the hub with `x`. The ledger counts a user stop, the result is not
 *      accepted (it ended before judgment) and the director is told `사용자가 허브에서 <lane>의 워커를 멈춤`.
 *
 * Host facts used (omp 19.2.1): `alt+a` opens the hub (`app.agents.hub`), `j` moves the selection (`❯`), Enter focuses
 * the agent and `x` kills it with the label "Interrupted by user" (ui/overlays/pickers/agent-hub.tsx); a focused submit
 * goes to the worker's own `prompt()` (input-controller.ts `#submitToFocusedSession`), and `←←` on an empty composer
 * returns to the main session.
 *
 * Usage:
 *   E2E_PORT=18815 E2E_WORK=/tmp/storm-e2e-hub-intervention ./node_modules/.bin/bun scripts/e2e/hub-intervention.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_CHANGE_CAUSES } from "../../src/policy/model-check.ts";
import { modelStopLabel } from "../../src/report/model-stop.ts";
import { parseModelEntry } from "../../src/selector.ts";
import { USER_TURN_TAG, userStopDirectorNotice, userTurnDirectorNotice } from "../../src/runtime/user-turn.ts";
import type { RunRecord } from "../../src/types.ts";
import { KEY, laneSpawnKey, type LlmEntry, LlmCursor, prepare, startFakeLlm, type Step, StormFiles, Suite, TEAM_PROVIDERS, Tui, until } from "./harness.ts";
import { installProfile, MAIN, Sessions } from "./phase1-kit.ts";

const env = prepare("storm-e2e-hub-intervention", 18815);
const suite = new Suite("E2E (hub intervention)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const b64 = (value: unknown): string => `b64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
/** Lets a worker held by `E2E-CHILD-UNTIL <name>` answer. */
const release = (name: string): void => writeFileSync(join(dirname(env.llmLog), name), "go\n");
const fileText = (name: string): string | undefined => (existsSync(join(env.project, name)) ? readFileSync(join(env.project, name), "utf8") : undefined);
/** A director request carries `text` anywhere in what reached the provider. */
const directorHeard = (llm: LlmCursor, text: string): LlmEntry | undefined => llm.of("main").find(entry => JSON.stringify(entry).includes(text));

async function openHub(tui: Tui): Promise<void> {
	tui.send("\x1ba");
	await until(() => (tui.screen().viewport.some(row => row.includes("Agent Hub")) ? true : undefined), 30_000, "the Agent Hub to open");
}

/** Moves the hub's selection (`❯`) down to the row of agent `id`. */
async function selectHubRow(tui: Tui, id: string): Promise<void> {
	for (let step = 0; step < 12; step++) {
		if (tui.screen().viewport.some(row => /│ ❯ /u.test(row) && row.includes(id))) return;
		tui.send("j");
		await Bun.sleep(400);
	}
	throw new Error(`the hub never selected ${id}:\n${tui.screenText()}`);
}

/** Opens the hub, focuses agent `id` with Enter and waits until the hub has given the screen to the worker's view. */
async function focusWorker(tui: Tui, id: string): Promise<void> {
	await openHub(tui);
	await selectHubRow(tui, id);
	tui.send(KEY.enter);
	await until(() => (!tui.screen().viewport.some(row => row.includes("Agent Hub")) ? true : undefined), 30_000, "the hub to close on the focused worker");
	await Bun.sleep(1_500);
}

/** `←←` on an empty composer: back to the main session. */
async function unfocus(tui: Tui): Promise<void> {
	tui.send("\x1b[D");
	await Bun.sleep(80);
	tui.send("\x1b[D");
	await Bun.sleep(1_500);
}

/** The worker's write in the turn the user started, and what the host answered it. */
async function userWrite(llm: LlmCursor, path: string): Promise<{ answered: string }> {
	await until(() => llm.of("child").find(entry => entry.decision.tool === "write" && JSON.stringify(entry.decision.args ?? {}).includes(path)), 90_000, `the worker to write ${path}`);
	const done = await until(() => llm.of("child").find(entry => entry.decision.text === "E2E-USER-DONE" && entry.lastTool !== ""), 90_000, "the worker to answer after its write");
	return { answered: done.lastTool };
}

const agentOf = (run: RunRecord, id: string | undefined) => run.agents?.find(agent => agent.id === id);

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team", async () => {
		const { teams } = await sessions.approve("off");
		check("one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("I2 admitted and I3: a hub prompt writes under the run's approval; a hub model change is stopped and offered for approval", async () => {
		const owned = sessions.owned;
		if (owned === undefined) throw new Error("the fixture session was not created");
		const files = new StormFiles(env, owned.id);
		const tui = new Tui(env, { model: MAIN, flags: ["--motion", "none"], resume: owned.id, sessionDir: owned.dir });
		try {
			await tui.ready();
			const llm = new LlmCursor(env);
			const fixResult = [{ id: "fix-change", kind: "change", criterion: "hub-fix.txt holds the user's change", path: "hub-fix.txt", contains: "storm user change" }];
			const holdResult = [{ id: "hold-answer", kind: "answer", criterion: "report when released" }];
			const steps: Step[] = [
				{ storm: { action: "plan", plan: { lanes: [
					{ name: "Fix", kind: "code", role: "implementer", files: ["hub-fix.txt"], goal: "edit hub-fix.txt", results: fixResult },
					{ name: "Hold", kind: "explore", role: "explorer", goal: "stay running", results: holdResult },
				] } } },
				{ tasks: [
					{ name: "Fix", agent: "storm-implementer", task: "Look at hub-fix.txt", say: "E2E-CHILD-CLAIM FIX-FIRST" },
					{ name: "Hold", agent: "storm-explorer", task: "Stay until released", say: "E2E-CHILD-UNTIL hold-one E2E-CHILD-CLAIM HOLD-DONE" },
				] },
				{ awaitChild: true },
			];
			// I3 below: a fake model the approved team does not give the implementer role.
			const approved = new Set((files.config().roles.implementer?.models ?? []).map(entry => parseModelEntry(entry).selector));
			const outside = Object.entries(TEAM_PROVIDERS).flatMap(([provider, models]) => models.map(model => `${provider}/${model.id}`)).find(selector => !approved.has(selector));
			if (outside === undefined) throw new Error(`every fake model is approved for the implementer: ${[...approved].join(", ")}`);
			const offer = modelStopLabel({ roleId: "implementer", model: outside }).replace(/ 승인$/u, "");
			const before = files.runIds();
			await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
			try {
				await until(() => llm.of("child").find(entry => entry.decision.text === "FIX-FIRST"), 90_000, "the Fix worker's first answer");
				// The director read Fix's delivery and is now paused on Hold: the run stays live.
				await until(() => llm.of("main").find(entry => entry.users.some(text => text.includes("FIX-FIRST"))), 60_000, "the director to read Fix's answer");
				await Bun.sleep(2_000);
				const live = await until(() => files.runs().find(run => !before.has(run.runId) && run.status === "running"), 20_000, "the run to be live");
				const fix = laneSpawnKey(live, "Fix");
				if (fix === undefined) throw new Error(`no Fix worker: ${JSON.stringify(live.spawns)}`);

				// 1. I2: focus the settled writer in the hub and tell it what to do.
				const admitted = new LlmCursor(env);
				await focusWorker(tui, fix);
				await tui.submit("please change it E2E-USER-WRITE hub-fix.txt");
				const { answered } = await userWrite(admitted, "hub-fix.txt");
				check("the user's turn writes under the run's approval: the write is not refused", !answered.includes("[storm:"), answered.slice(0, 300));
				check("the file holds the user's change", fileText("hub-fix.txt") === "storm user change\n", JSON.stringify(fileText("hub-fix.txt")));
				const told = await until(() => directorHeard(admitted, userTurnDirectorNotice("Fix", fix)), 90_000, "the director's line about the user's turn");
				check("the director's next request carries the one line about the user's turn", told !== undefined);
				check("and not the prompt itself", !admitted.of("main").some(entry => JSON.stringify(entry).includes("please change it")));

				// 2. I3: switch the focused worker to that model, then prompt it.
				const switched = new LlmCursor(env);
				// `/switch <model>` is the focused view's typed model change (`/model` alone only opens the picker; with an argument
				// the host refuses it there: slash-commands/builtin-modes.ts `model` has no `allowArgs`). Both set the viewed agent's model.
				const modelMark = await tui.submit(`/switch ${outside}`);
				await tui.shows(/model: \S*/u, modelMark, 20_000);
				await Bun.sleep(1_000);
				await tui.submit("again E2E-USER-WRITE hub-fix2.txt");
				await Bun.sleep(8_000);
				const sent = switched.of("child").filter(entry => entry.model === outside.split("/")[1] || entry.model === outside);
				check("the request on the unapproved model never reached the provider", sent.length === 0, JSON.stringify(sent.map(entry => entry.model)));
				check("and the worker changed nothing", fileText("hub-fix2.txt") === undefined);
				await unfocus(tui);
				const menuMark = await tui.submit("/storm");
				const label = await until(() => (tui.screenText().includes(offer) ? true : undefined), 60_000, "the /storm menu to offer approving the stopped model").catch(() => false);
				check("/storm offers 역할 <R>에 <model> 승인 after the stop", label, `${offer} | ${tui.text(menuMark).slice(-600)}`);
				tui.send("\x1b");
				await Bun.sleep(1_000);
			} finally {
				release("hold-one");
			}
			const heard = await until(() => directorHeard(llm, MODEL_CHANGE_CAUSES), 120_000, "the director to be told why the worker stopped").catch(() => undefined);
			check("the stop notice names both causes (hub /model or /effort, a later extension)", heard !== undefined);
			const run = await files.finishedRun(before, 180_000);
			const fix = laneSpawnKey(run, "Fix");
			check("the ledger counts the user's turns on that worker", (agentOf(run, fix)?.userTurns ?? 0) >= 1, JSON.stringify(agentOf(run, fix)));
			check("the stop is recorded as a model outside the approval", run.spawns.some(spawn => spawn.spawnKey === fix && spawn.ran?.verdict === "mismatch" && spawn.ran.model === outside), JSON.stringify(run.spawns.map(spawn => spawn.ran)));
		} finally {
			await tui.close();
		}
	}, 600_000);

	await suite.step("I2 read-only and I4: a held write place keeps the user's turn read-only; a hub stop is the user's", async () => {
		const owned = sessions.owned;
		if (owned === undefined) throw new Error("the fixture session was not created");
		const files = new StormFiles(env, owned.id);
		const tui = new Tui(env, { model: MAIN, flags: ["--motion", "none"], resume: owned.id, sessionDir: owned.dir });
		try {
			await tui.ready();
			await until(() => (files.runs().every(run => run.status !== "running") ? true : undefined), 120_000, "the earlier run to end");
			const llm = new LlmCursor(env);
			const change = (id: string, path: string) => [{ id, kind: "change", criterion: `${path} is changed`, path, contains: "storm" }];
			const steps: Step[] = [
				{ storm: { action: "plan", plan: { lanes: [
					{ name: "Two", kind: "code", role: "implementer", files: ["hub-two.txt"], goal: "edit hub-two.txt", results: change("two-change", "hub-two.txt") },
					{ name: "Busy", kind: "code", role: "implementer", files: ["hub-busy.txt"], goal: "hold the write place", results: change("busy-change", "hub-busy.txt") },
				] } } },
				{ tasks: [{ name: "Two", agent: "storm-implementer", task: "Look at hub-two.txt", say: "E2E-CHILD-CLAIM TWO-FIRST" }] },
				{ tasks: [{ name: "Busy", agent: "storm-implementer", task: "Hold the place", say: "E2E-CHILD-UNTIL busy-one E2E-CHILD-CLAIM BUSY-DONE" }], afterResult: "TWO-FIRST" },
				{ awaitChild: true },
			];
			const before = files.runIds();
			await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
			try {
				await until(() => llm.of("child").find(entry => entry.lastUser.includes("busy-one") || entry.users.some(text => text.includes("busy-one"))), 120_000, "the Busy writer to be running");
				await Bun.sleep(3_000);
				const live = await until(() => files.runs().find(run => !before.has(run.runId) && run.status === "running"), 20_000, "the run to be live");
				const two = laneSpawnKey(live, "Two");
				const busy = laneSpawnKey(live, "Busy");
				if (two === undefined || busy === undefined) throw new Error(`workers missing: ${JSON.stringify(live.spawns)}`);

				// 3. I2 read-only: Busy (bash: an unbounded writer) holds the place.
				const readOnly = new LlmCursor(env);
				await focusWorker(tui, two);
				await tui.submit("please change it E2E-USER-WRITE hub-two.txt");
				const { answered } = await userWrite(readOnly, "hub-two.txt");
				check("the first write of the user's turn is refused as read-only", answered.includes(USER_TURN_TAG) && answered.includes("읽기 전용"), answered.slice(0, 400));
				check("and the refusal names the lane holding the place", answered.includes("Busy"), answered.slice(0, 400));
				check("nothing was written", fileText("hub-two.txt") === undefined);
				await unfocus(tui);

				// 4. I4: stop the running writer from the hub.
				const stopped = new LlmCursor(env);
				await openHub(tui);
				await selectHubRow(tui, busy);
				tui.send("x");
				await Bun.sleep(2_000);
				tui.send("\x1b");
				const told = await until(() => directorHeard(stopped, userStopDirectorNotice("Busy", busy)), 120_000, "the director's line about the hub stop").catch(() => undefined);
				check("the director is told the user stopped that worker", told !== undefined);
			} finally {
				release("busy-one");
			}
			const run = await files.finishedRun(before, 180_000);
			const busy = laneSpawnKey(run, "Busy");
			check("the ledger counts the user's stop", agentOf(run, busy)?.userStops === 1, JSON.stringify(agentOf(run, busy)));
			check("the stopped attempt's result was not accepted", run.results?.find(row => row.id === "busy-change")?.state !== "accepted", JSON.stringify(run.results?.find(row => row.id === "busy-change")));
			const two = laneSpawnKey(run, "Two");
			check("a read-only user turn is not counted as a user-directed attempt", agentOf(run, two)?.userTurns === undefined, JSON.stringify(agentOf(run, two)));
		} finally {
			await tui.close();
		}
	}, 600_000);
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
