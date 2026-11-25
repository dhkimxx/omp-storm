#!/usr/bin/env bun
/**
 * Focused real-host proof of the routine-work contract: an automatic plan past the approved worker bounds is refused
 * without a dialog or a config/approval delta, the same request then runs a bounded plan with real workers, an
 * already-requested host-check → device-verification flow continues without a between-stage question, and only a
 * genuine irreversible decision opens one native form. A denial leaves the proposed effect's sentinel in place; the
 * same key is not asked again in that request, and a later user request can ask it again. Explicit `/storm` config
 * approval and the closeout card still work.
 *
 * Real omp, isolated HOME/profile and disposable checkout; the provider is the local scripted fake. No paid request,
 * real device, deploy or production path is touched. The "device verification" is a benign local fixture command.
 *
 * Host limits: plain `--mode rpc` has no UI (and therefore no native ask), and omp task subagents are created with
 * `hasUI:false`, so they never receive the interactive `ask` tool. RPC covers the automatic bounds/no-dialog path and
 * the real assertion that managed workers get no interactive ask; the TUI host is the only real surface that draws
 * the HTML decision form. The managed worker-ask hook itself is covered by the extension unit test, not faked here.
 *
 * Usage:
 *   E2E_PORT=18564 E2E_WORK=/tmp/storm-e2e-decisions bun scripts/e2e/decisions.ts
 *   E2E_ONLY="decision" ...   # one scenario; the fixture always runs
 * Env from harness.ts (E2E_KEEP, OMP_BIN, ...) applies. A green run deletes its work dir; a failure keeps frames,
 * stderr, omp logs and llm.jsonl.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import type { RunRecord } from "../../src/types.ts";
import {
	approveTeam,
	cancelAll,
	choose,
	focused,
	type Frame,
	KEY,
	linkPlugin,
	LlmCursor,
	modelsYml,
	prepare,
	PROFILE_CONFIG,
	Rpc,
	type Step,
	StormFiles,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	Tui,
	until,
	CLOSEOUT_HEADING,
	closeoutBody,
	closeoutOf,
	isOneLineCloseout,
	offeredDirections,
	persistedStormRecords,
	runNext,
	sessionFileIn,
	userNext,
} from "./harness.ts";

const env = prepare("storm-e2e-decisions", 18564);
const suite = new Suite("E2E (routine decisions)", env);
const check = suite.check.bind(suite);
const MAIN = "fake/general-b";
const FIXTURES = "e2e-fixtures";
const HOST_FILE = `${FIXTURES}/host-check.txt`;
const DEVICE_FILE = `${FIXTURES}/device-verify.txt`;
const HOST_TOKEN = "E2E-HOST-CHECK-OK";
const DEVICE_TOKEN = "E2E-DEVICE-VERIFY-OK";
// The fixture line is a typed field (`key: "value"`), so a cited answer is fast-accepted only by exact typed agreement,
// never by prose that repeats the token.
const HOST_LINE = `host_check: "${HOST_TOKEN}"`;
const DEVICE_LINE = `device_verify: "${DEVICE_TOKEN}"`;
const SENTINEL = "e2e-decision-sentinel.txt";
const DECISION_KEY = "e2e-sentinel-decision-v1";
const PRESELECT_KEY = "e2e-preselect-v1";
const DECISION_HEADING = "E2E irreversible decision";
const ROUTINE_HEADING = "E2E routine progress";

const b64 = (value: unknown): string => `b64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
const encoded = (value: string): string => Buffer.from(value).toString("base64");
const scripted = (...steps: Step[]): string => `E2E-STEPS ${JSON.stringify(steps)}`;

/** The marked native decision form the host gate accepts: one main form, a stable key and an irreversible reason. */
const DECISION_FORM = `<form data-storm-decision="${DECISION_KEY}" data-storm-reason="irreversible-action"><fieldset><legend>${DECISION_HEADING}</legend><label>E2E-DECISION-VALUE <input name="choice" placeholder="apply or deny"></label></fieldset></form>`;
const ROUTINE_FORM = `<form><fieldset><legend>${ROUTINE_HEADING}</legend><label>E2E-ROUTINE-QUESTION <input name="routine-answer" placeholder="routine"></label></fieldset></form>`;
const PRESELECT_FORM = `<form data-storm-decision="${PRESELECT_KEY}" data-storm-reason="irreversible-action"><fieldset><legend>E2E preselected removal</legend><label><input type="radio" name="choice" value="apply" checked> Apply</label><label><input type="radio" name="choice" value="deny"> Deny</label></fieldset></form>`;
const OUTSIDE_FORM = `<form><fieldset><legend>E2E outside form</legend><label>E2E-OUTSIDE <input name="outside" placeholder="outside-ok"></label></fieldset></form>`;

/** UI requests that would have shown a dialog to the user: notification/widget/status frames are not dialogs. */
const UI_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true, form: true };

/** The run this prompt opened, after its final record and index line are on disk. */
async function runOf(rpc: Rpc, files: StormFiles, message: string, timeoutMs = 240_000): Promise<{ run: RunRecord; frames: Frame[] }> {
	const before = files.runIds();
	const frames = await rpc.turn(message, timeoutMs);
	const run = await files.finishedRun(before, 120_000);
	return { run, frames };
}

/** A form field typed into, then Submit: the same key choreography the interactive suite uses. */
async function submitTextForm(tui: Tui, from: number, heading: string, value: string): Promise<number> {
	await tui.seen(from, text => (text.includes(heading) ? focused(text) : undefined), `the form ${heading}`);
	await tui.press(
		value,
		text => text.split("\n").some(row => row.replace(/[│█\s]/g, "") === value),
		`the form field to show ${value}`,
	);
	if (focused(tui.text()) !== "Submit") {
		const tab = await tui.press(KEY.tab, text => focused(text) !== undefined, "the form focus to move on");
		const focusedLabel = focused(tui.text(tab));
		if (focusedLabel !== "Submit") throw new Error(`the form focus is ${focusedLabel ?? "nowhere"}, expected Submit`);
	}
	return tui.send(KEY.enter);
}

function hostTask(outputName = "host-check.out"): Step {
	const output = join(env.work, outputName);
	return {
		task: ["storm-quick"],
		as: "host-check",
		say: `E2E-CHILD-SH ${encoded(`cat ${HOST_FILE} > ${JSON.stringify(output)}`)} E2E-CHILD-READ ${HOST_FILE} E2E-CHILD-CLAIM ${HOST_LINE} (${HOST_FILE}:1)`,
	};
}

function deviceTask(outputName = "device-verify.out"): Step {
	const output = join(env.work, outputName);
	return {
		task: ["storm-quick"],
		as: "device-check",
		say: `E2E-CHILD-SH ${encoded(`cat ${DEVICE_FILE} > ${JSON.stringify(output)}`)} E2E-CHILD-READ ${DEVICE_FILE} E2E-CHILD-CLAIM ${DEVICE_LINE} (${DEVICE_FILE}:1)`,
	};
}

const checkBrief = {
	result: "E2E-BRIEF-RESULT: the host and local device fixture checks ran.",
	verification: "E2E-BRIEF-EVIDENCE: both commands wrote their exact fixture token; no real device was used.",
	remaining: "E2E-BRIEF-REMAINING: nothing beyond this disposable local fixture.",
	// Typed next actions: one bounded new-scope run (numbered, recommended) and one user-owned step (never numbered).
	next: [
		runNext("Inspect the recorded fixture output", "E2E-WHY: the receipts are the only evidence"),
		userNext("Connect the real device yourself before repeating the check"),
	],
};

const decisionBrief = {
	result: "E2E-BRIEF-DECISION: the irreversible removal was offered once and not applied.",
	verification: "E2E-BRIEF-DECISION-EVIDENCE: the sentinel still exists after the denial.",
	remaining: "E2E-BRIEF-DECISION-REMAINING: the user may choose the removal in a later request.",
	// Only a user-owned step: nothing to dispatch, so the record must not invent numbered defaults.
	next: [userNext("Request the removal later if it is still wanted")],
};

const hostLanes = [
	{
		name: "host-check0",
		kind: "run",
		files: [HOST_FILE],
		goal: "Run the host fixture check and report its exact token",
		results: [{ id: "host-check-ok", kind: "answer", criterion: `report ${HOST_FILE} from source`, path: HOST_FILE, contains: HOST_LINE }],
	},
	{
		name: "device-check0",
		kind: "run",
		files: [DEVICE_FILE],
		goal: "Run the benign local device fixture verification",
		results: [{ id: "device-verify-ok", kind: "answer", criterion: `report ${DEVICE_FILE} from source`, path: DEVICE_FILE, contains: DEVICE_LINE }],
	},
];

const decisionLane = {
	name: "decision0",
	kind: "run",
	goal: "Read the fixture before asking the one irreversible decision",
	results: [{ id: "decision-check-ok", kind: "answer", criterion: `report ${HOST_FILE} from source`, path: HOST_FILE, contains: HOST_LINE }],
};

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	mkdirSync(join(env.project, FIXTURES), { recursive: true });
	writeFileSync(join(env.project, HOST_FILE), `${HOST_LINE}\n`);
	writeFileSync(join(env.project, DEVICE_FILE), `${DEVICE_LINE}\n`);
	// The disposable quick definition declares `ask`, so the child tool-list assertion proves the real host still does
	// not expose the interactive tool to a managed task subagent. No worker-ask call is faked.
	const agents = join(env.project, ".omp", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(
		join(agents, "storm-quick.md"),
		"---\nname: storm-quick\ndescription: E2E quick worker with the native ask tool\ntools: read, bash, ask\n---\nE2E quick worker.\n",
	);
	linkPlugin(env);

	let rpc: Rpc | undefined;
	try {
		rpc = new Rpc(env, cancelAll, { model: MAIN });
		await rpc.ready();
		const files = new StormFiles(env, rpc.sessionId);
		await approveTeam(rpc, "on");
		check("the disposable team is approved and automatic delegation is on", existsSync(files.configFile) && files.approvals().length === 1);
		files.editConfig(config => {
			if (config.roles.quick) config.roles.quick.workers = { min: 1, max: 2 };
		});
		const approvals = files.approvals().length;
		rpc.answer = choose(APPROVE);
		await rpc.prompt("/storm");
		check("an explicit user config approval still opens and saves exactly once", files.approvals().length === approvals + 1, `approvals=${files.approvals().length}/${approvals + 1}`);

		await suite.step("an automatic plan past the bounds is refused without a dialog, then bounded workers run", async () => {
			const llm = new LlmCursor(env);
			const bytes = files.configBytes();
			const approvalsAfterSetup = files.approvals().length;
			const runs = files.runIds();
			rpc!.answer = cancelAll;
			const over = { storm: { action: "plan", plan: { lanes: hostLanes, workers: { quick: 5 } } } } satisfies Step;
			const bounded = { storm: { action: "plan", plan: { lanes: hostLanes, workers: { quick: 2 } } } } satisfies Step;
			const steps: Step[] = [over, bounded, hostTask(), deviceTask(), { storm: { action: "brief", brief: checkBrief } }];
			const frameStart = rpc!.frames.length;
			const { run, frames } = await runOf(rpc!, files, scripted(...steps));
			const closeout = await until(() => closeoutOf(rpc!.frames, run.runId, frameStart), 30_000, "the automatic closeout record");
			const dialogs = frames.filter(frame => frame.type === "extension_ui_request" && UI_METHODS[String(frame.method)] === true);
			check("no approval dialog, form, select or input opened during the automatic turn", dialogs.length === 0, JSON.stringify(dialogs.map(frame => [frame.method, frame.title ?? frame.message ?? ""])));
			check(
				"the over-bounds plan changed neither config nor approvals",
				files.configBytes() === bytes && files.approvals().length === approvalsAfterSetup,
				`config=${files.configBytes() === bytes} approvals=${files.approvals().length}/${approvalsAfterSetup}`,
			);
			const refused = llm.of("main").find(entry => entry.lastTool.includes("승인된 팀 범위를 넘어"));
			check(
				"the director was told the exact role, requested count and approved maximum, and to replan within bounds",
				refused !== undefined && refused.lastTool.includes("워커 5개 사용") && refused.lastTool.includes("승인된 최대 2개") && refused.lastTool.includes("순차 실행"),
				refused?.lastTool.slice(0, 700) ?? "no refusal reached the director",
			);
			check("the refused plan opened no run and the follow-on bounded plan opened exactly one", files.runIds().size === runs.size + 1, `runs=${files.runIds().size}/${runs.size}`);
			check(
				"the plan in force is the bounded one",
				run.plan !== undefined && run.plan.workers.quick === 2 && run.plan.lanes.map(lane => lane.name).join(",") === "host-check0,device-check0",
				JSON.stringify(run.plan?.workers ?? null),
			);
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			check(
				"real workers ran both lanes",
				["host-check0", "device-check0"].every(name => routed.some(spawn => spawn.lane === name)) && routed.every(spawn => spawn.outcome === "routed"),
				JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome])),
			);
			check("the host-check command actually ran", existsSync(join(env.work, "host-check.out")) && readFileSync(join(env.work, "host-check.out"), "utf8").trim() === HOST_LINE);
			check("the local device verification actually ran", existsSync(join(env.work, "device-verify.out")) && readFileSync(join(env.work, "device-verify.out"), "utf8").trim() === DEVICE_LINE);
			const resultStates = new Map((run.results ?? []).map(result => [result.id, result.state]));
			check("both required worker outcomes are visible on the run record", resultStates.get("host-check-ok") !== undefined && resultStates.get("device-verify-ok") !== undefined, JSON.stringify(run.results ?? null));
			const childTools = llm.of("child").map(entry => entry.tools);
			check(
				"OMP exposes no native ask to a managed task worker, so no worker dialog can open",
				childTools.length > 0 && childTools.every(tools => !tools.includes("ask")),
				JSON.stringify([...new Set(childTools.map(tools => tools.join(",")))]),
			);
			check(
				"the typed closeout brief survived the run",
				run.closeout !== undefined && run.closeout.result === checkBrief.result && JSON.stringify(run.closeout.next) === JSON.stringify(checkBrief.next),
				JSON.stringify(run.closeout ?? null),
			);
			// Numbers go only to dispatchable actions: at most the one run plus a code-added resume, never the user step.
			const offers = offeredDirections(closeoutBody(closeout.text));
			check(
				"the record numbers no user-owned step and fabricates no default offers",
				offers.length <= 2 && !offers.some(offer => offer.includes("real device yourself")),
				closeout.text.slice(-600),
			);
			check("no decision form rendered on the RPC surface", !JSON.stringify(frames).includes(DECISION_HEADING));
		}, 300_000);

		const active = rpc;
		if (active === undefined) throw new Error("the RPC session is missing");
		// The run record and card are already on disk; shutdown is not part of the decision contract.
		await active.stop();
		rpc = undefined;
	} finally {
		if (rpc !== undefined) await rpc.close();
	}

	// The form surface: TUI with a real HTML form. This is the only surface that can answer an actual ask form.
	const seed = new Rpc(env, cancelAll, { model: MAIN });
	let owned: { id: string; dir: string } | undefined;
	try {
		await seed.ready();
		await approveTeam(seed, "off");
		await seed.turn("hello");
		owned = { id: seed.sessionId, dir: seed.sessionDir };
	} finally {
		await seed.close();
	}
	if (owned === undefined) throw new Error("the TUI seed session was not created");
	if (seed.sessionFile === undefined || !existsSync(seed.sessionFile)) throw new Error("the TUI seed session wrote no transcript");
	writeFileSync(join(env.project, SENTINEL), "keep this unless the user applies the irreversible change\n");
	const tuiSentinel = readFileSync(join(env.project, SENTINEL));

	await suite.step("the TUI shows one marked form, a denial keeps the sentinel, and the routine ask never renders", async () => {
		const llm = new LlmCursor(env);
		const tui = new Tui(env, { model: MAIN, resume: owned!.id, sessionDir: owned!.dir });
		let started = 0;
		try {
			await tui.ready();
			const before = new StormFiles(env, tui.sessionId);
			const runs = before.runIds();
			const steps: Step[] = [
				{ storm: { action: "plan", plan: { lanes: hostLanes, workers: { quick: 2 } } } },
				hostTask("tui-host-check.out"),
				{ ask: ROUTINE_FORM },
				deviceTask("tui-device-verify.out"),
				{ ask: PRESELECT_FORM },
				{ ask: DECISION_FORM },
				{ ifAskApproved: `rm -f ${SENTINEL}` },
				{ ask: DECISION_FORM },
				{ storm: { action: "brief", brief: decisionBrief } },
			];
			started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
			await submitTextForm(tui, started, DECISION_HEADING, "deny");
			const run = await before.finishedRun(runs, 180_000);
			// The tier is the code's: a short clean verified run is one saved fact line (no title, no directions on screen);
			// anything else is a card under its title. A denied decision is not a caution, so either tier can follow it.
			const kept = await until(() => {
				const file = sessionFileIn(owned!.dir, owned!.id);
				return (file === undefined ? [] : persistedStormRecords(file)).filter(entry => entry.details?.runId === run.runId).at(-1);
			}, 30_000, "the saved closeout record");
			const oneLine = isOneLineCloseout(kept);
			const fact = closeoutBody(kept.text)[0]?.replace(/^[-*]\s+/, "") ?? "";
			await tui.shows(oneLine ? fact.slice(0, 24) : CLOSEOUT_HEADING, started, 60_000);
			check("the marked decision really rendered as one native HTML form", tui.text(started).includes(DECISION_HEADING) && tui.text(started).includes("E2E-DECISION-VALUE"));
			check("the unmarked routine ask never rendered a form", !tui.text(started).includes(ROUTINE_HEADING));
			check("a high-risk preselected form never rendered", !tui.text(started).includes("E2E preselected removal"));
			check("both local fixture checks ran on the TUI path", readFileSync(join(env.work, "tui-host-check.out"), "utf8").trim() === HOST_LINE && readFileSync(join(env.work, "tui-device-verify.out"), "utf8").trim() === DEVICE_LINE);
			const childTools = llm.of("child").map(entry => entry.tools);
			check(
				"OMP exposes no native ask to a managed task worker, so no worker dialog can open",
				childTools.length > 0 && childTools.every(tools => !tools.includes("ask")),
				JSON.stringify([...new Set(childTools.map(tools => tools.join(",")))]),
			);
			check("the denial kept the sentinel on the form surface", readFileSync(join(env.project, SENTINEL)).equals(tuiSentinel));
			const main = llm.of("main");
			const routineAt = main.findIndex(entry => entry.decision.tool === "ask" && JSON.stringify(entry.decision.args ?? {}).includes("E2E-ROUTINE-QUESTION"));
			const routineAfter = routineAt < 0 ? undefined : main[routineAt + 1];
			check(
				"the routine ask was refused before a form on the TUI surface",
				routineAfter?.lastTool.includes("[storm:ask-contract]") === true,
				routineAfter?.lastTool.slice(0, 500) ?? "no main request followed the routine ask",
			);
			const preselectAsk = main.find(entry => entry.decision.tool === "ask" && JSON.stringify(entry.decision.args ?? {}).includes(PRESELECT_KEY));
			const preselectAfter = preselectAsk === undefined ? undefined : main.find(entry => entry.ts > preselectAsk.ts && entry.lastTool.includes("[storm:"));
			check(
				"a high-risk form with a default selection was refused before it could open",
				preselectAsk !== undefined && preselectAfter?.lastTool.includes("[storm:ask-default]") === true,
				preselectAfter?.lastTool.slice(0, 500) ?? "the preselected form was not refused",
			);
			const asks = main.filter(entry => entry.decision.tool === "ask" && JSON.stringify(entry.decision.args ?? {}).includes(DECISION_KEY));
			check("the marked decision was attempted twice in the same request", asks.length === 2, `asks=${asks.length}`);
			const effect = main.find(entry => entry.ts > (asks[0]?.ts ?? 0) && entry.decision.tool === "storm");
			check("the denial was read as no approval, so the effect command was not run", effect?.decision.tool === "storm" && (effect.decision.args as { action?: string } | undefined)?.action === "status", JSON.stringify(effect?.decision ?? null));
			const afterRepeat = asks[1] === undefined ? undefined : main.find(entry => entry.ts > asks[1]!.ts && entry.lastTool.includes("[storm:"));
			check("the repeat did not open a second form", afterRepeat !== undefined && /이미|already|한 번|once|ask|결정|decision/i.test(afterRepeat.lastTool), afterRepeat?.lastTool.slice(0, 500) ?? "the repeat waited for a second form");
			const shownRecord = oneLine ? kept.text : tui.text(started).split(CLOSEOUT_HEADING).at(-1) ?? "";
			check(
				"the closeout still follows the decision, with the user-owned step left unnumbered",
				run.closeout?.result === decisionBrief.result && fact !== "" &&
					!offeredDirections((oneLine ? closeoutBody(kept.text) : shownRecord.split("\n")).map(line => line.replace(/[│|]/g, "").trim())).some(offer => offer.includes("removal later")),
				`tier=${oneLine ? "line" : "card"} ${JSON.stringify(run.closeout ?? null)} shown=${shownRecord.slice(0, 600)}`,
			);

			// A new user request resets only the asked-key memory: the same stable key must be offered again.
			const secondRuns = before.runIds();
			const secondSteps: Step[] = [
				{ storm: { action: "plan", plan: { lanes: [decisionLane], workers: { quick: 1 } } } },
				{ task: ["storm-quick"], as: "decision", say: `E2E-CHILD-READ ${HOST_FILE} E2E-CHILD-CLAIM ${HOST_LINE} (${HOST_FILE}:1)` },
				{ ask: DECISION_FORM },
				{ ifAskApproved: `rm -f ${SENTINEL}` },
				{ storm: { action: "brief", brief: decisionBrief } },
			];
			const secondStarted = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(secondSteps)}`);
			await submitTextForm(tui, secondStarted, DECISION_HEADING, "deny");
			const secondRun = await before.finishedRun(secondRuns, 120_000);
			check("a new user request can ask the same stable decision again", tui.text(secondStarted).includes(DECISION_HEADING));
			check("the new request's denial still keeps the sentinel", readFileSync(join(env.project, SENTINEL)).equals(tuiSentinel));
			check("the new request's closeout remains intact", secondRun.closeout?.result === decisionBrief.result);
		} finally {
			await tui.close();
		}
	}, 240_000);

	await suite.step("outside a Storm run the native form is unchanged", async () => {
		const llm = new LlmCursor(env);
		// A separate real session with no team and no Storm run: the plugin is loaded, but the ask must be untouched.
		const outsideSeed = new Rpc(env, cancelAll, { model: MAIN });
		let outside: { id: string; dir: string } | undefined;
		try {
			await outsideSeed.ready();
			await outsideSeed.turn("hello");
			outside = { id: outsideSeed.sessionId, dir: outsideSeed.sessionDir };
		} finally {
			await outsideSeed.close();
		}
		if (outside === undefined) throw new Error("the outside TUI seed session was not created");
		const tui = new Tui(env, { model: MAIN, resume: outside.id, sessionDir: outside.dir });
		try {
			await tui.ready();
			const started = await tui.submit(scripted({ ask: OUTSIDE_FORM }));
			await submitTextForm(tui, started, "E2E outside form", "outside-ok-value");
			await until(() => (llm.of("main").some(entry => entry.lastTool.includes("outside-ok-value")) ? true : undefined), 20_000, "the outside form answer to reach the model");
			check("an ordinary OMP session still renders and submits its native form", tui.text(started).includes("E2E outside form"));
		} finally {
			await tui.close();
		}
	}, 120_000);
}

const server = await startFakeLlm(env);
let code = 1;
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
