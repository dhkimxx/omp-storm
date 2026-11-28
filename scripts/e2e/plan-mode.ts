#!/usr/bin/env bun
/**
 * omp's plan mode and Storm, real host on a pty (plan mode is a TUI mode: an RPC session has no `ctx.sessionModes`, so
 * Storm cannot see it there). A disposable git checkout, an isolated HOME/profile, the pinned omp and the local fake
 * LLM. No paid model calls.
 *
 * What the user met: with plan mode on, an automatic-delegation director could not leave it, because the tool omp's
 * plan mode ends with (`propose`, the plan's title as its one argument) was refused as an unknown tool. A manual start
 * (`/storm <request>`) was not refused at all and opened a run in the middle of "plan only". Phase 1:
 *
 *   1. a manual start while plan mode is on is refused with the reason, before the vibe dialog, and nothing starts;
 *   2. under automatic delegation with plan mode on, the director writes its plan note (`local://*.md`, admitted) and
 *      submits it with `propose`; Storm does not refuse the call (omp's own plan review then opens). On the real host
 *      `propose` is not a tool of its own while `bash` is enabled: the model runs the command `propose <slug>` with
 *      `bash` (a direct `propose` call answers "Tool propose not found"), so that exact command is what Storm admits;
 *   3. the user approves the plan keeping the context; plan mode is off, and the same manual start now opens a run.
 *
 * Seen on the real host (omp 19.2.1, the first run of this scenario): `/plan` toggles plan mode with no further dialog.
 *
 * Usage:
 *   E2E_PORT=18809 E2E_WORK=/tmp/storm-e2e-plan-mode ./node_modules/.bin/bun scripts/e2e/plan-mode.ts
 */
import { PLAN_MODE_START_REFUSAL } from "../../src/runtime/controller.ts";
import { PLAN_PREVIEW_HEAD } from "../../src/tool/storm-tool.ts";
import { SUPERVISOR_REASONS } from "../../src/policy/supervisor.ts";
import { focused, KEY, LlmCursor, prepare, startFakeLlm, type Step, StormFiles, Suite, Tui, until } from "./harness.ts";
import { installProfile, MAIN, Sessions } from "./phase1-kit.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-plan-mode", 18809);
seedFact(env.project);
const suite = new Suite("E2E (plan mode)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);

/** The text the seed turn leaves in the transcript: the TUI waits for it after a resume. */
const SEED = "hello";
const b64 = (value: unknown): string => `b64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
/** The plan note omp's plan mode accepts: `local://<slug>-plan.md`, and `propose` names the slug. */
const PLAN_NOTE = "local://e2e-plan.md";
const PLAN_SLUG = "e2e";
const trackedAnswer = { id: "probe-answer", kind: "answer", criterion: `report what ${FACT_FILE} line 1 says`, path: FACT_FILE, contains: FACT_LINE };
const START_STEPS: Step[] = [
	{ storm: { action: "plan", plan: { lanes: [{ name: "Probe0", kind: "explore", results: [trackedAnswer] }] } } },
	{ task: ["storm-explorer"], as: "Probe", say: `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}` },
];
const manualStart = `/storm E2E-ROUTE ${b64({ action: "run", rounds: 1 })} E2E-STEPS ${b64(START_STEPS)}`;

/** Box edges and spaces removed, so a sentence the terminal wrapped across rows still matches. */
const flat = (text: string): string => text.replace(/[│╭╮╰╯─█\s]/g, "");
const screenHas = (tui: Tui, text: string): boolean => flat(tui.history().join("\n")).includes(flat(text));

/** The plan review's row for approving with the context kept: move the focus to it and press Enter. */
async function approveKeepingContext(tui: Tui, from: number): Promise<void> {
	await tui.shows("Approve and keep context", from, 60_000);
	for (let step = 0; step < 6 && !(focused(tui.text(from)) ?? "").includes("keep context"); step++) {
		tui.send(KEY.down);
		await Bun.sleep(300);
	}
	tui.send(KEY.enter);
}

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved team, automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the isolated profile has one approved team", teams === 1, `approvals=${teams}`);
	}, 120_000);

	await suite.step("plan mode on: a manual start is refused with the reason; the director leaves plan mode; then the start works", async () => {
		const owned = sessions.owned;
		if (owned === undefined) throw new Error("the fixture session was not created");
		const files = new StormFiles(env, owned.id);
		const tui = new Tui(env, { model: MAIN, flags: ["--motion", "full"], resume: owned.id, sessionDir: owned.dir });
		try {
			await tui.ready();
			await tui.shows(SEED);

			// 1. Plan mode on: the manual start says why it did not start, and nothing is sent or opened.
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await tui.submit("/plan");
			await Bun.sleep(1_500);
			await tui.submit(manualStart);
			await until(() => (screenHas(tui, PLAN_MODE_START_REFUSAL) ? true : undefined), 30_000, "the refusal to start in plan mode");
			check("a manual start while plan mode is on is refused, and the screen says why", screenHas(tui, PLAN_MODE_START_REFUSAL));
			check("no run was opened and the director got no request", files.runIds().size === before.size && llm.of("main").length === 0, JSON.stringify({ runs: files.runIds().size, main: llm.of("main").length }));

			// 1b. O4: the director previews its plan with `storm plan`; the tool is offered in plan mode, answers the preview, and
			// opens no run and spawns nothing.
			const previewing = new LlmCursor(env);
			const previewRuns = files.runIds();
			await tui.submit(`preview the plan E2E-STEPS ${b64([START_STEPS[0]])}`);
			const preview = await until(() => {
				const main = previewing.of("main");
				const at = main.findIndex(entry => entry.decision.tool === "storm");
				return at < 0 ? undefined : main[at + 1]?.lastTool;
			}, 90_000, "the answer to storm plan in plan mode");
			check("storm plan in plan mode answers the preview", preview.includes(PLAN_PREVIEW_HEAD) && preview.includes("Probe0") && preview.includes("probe-answer"), preview);
			check(
				"the preview opened no run and spawned no worker",
				files.runIds().size === previewRuns.size && !previewing.of("main").some(entry => entry.decision.tool === "task"),
				JSON.stringify({ runs: files.runIds().size }),
			);

			// 2. The director, under automatic delegation with plan mode on, writes its plan note and submits it.
			const directed = new LlmCursor(env);
			const steps: Step[] = [{ edit: PLAN_NOTE, content: "# e2e plan\n- read the fixture\n" }, { bash: `propose ${PLAN_SLUG}` }];
			const mark = await tui.submit(`plan the work, then submit it E2E-STEPS ${b64(steps)}`);
			// Either omp's plan review opens (the call went through Storm's gate) or the call is answered at once (refused).
			const reached = await until(() => {
				const main = directed.of("main");
				const proposeAt = main.findIndex(entry => entry.decision.tool === "bash");
				const answer = proposeAt < 0 ? undefined : main[proposeAt + 1]?.lastTool;
				if (answer !== undefined) return { answer };
				return screenHas(tui, "Approve and keep context") ? { answer: undefined } : undefined;
			}, 90_000, "the plan review or an answer to propose");
			const main = directed.of("main");
			const noteAt = main.findIndex(entry => entry.decision.tool === "write");
			const note = noteAt < 0 ? undefined : main[noteAt + 1]?.lastTool;
			check("the plan note is admitted: a local:// note is not refused", note !== undefined && !note.includes("[storm:auto]"), note ?? "no result");
			check(
				"propose is not refused by Storm: no automatic-delegation refusal, no refusal of the command, and omp did not answer that the tool is missing",
				(reached.answer === undefined || !reached.answer.includes("[storm:auto]")) && !(reached.answer ?? "").includes(SUPERVISOR_REASONS.toolUnknown) && !(reached.answer ?? "").includes(SUPERVISOR_REASONS.toolRuns) && !(reached.answer ?? "").includes("not found"),
				reached.answer ?? "(no answer: the plan review opened)",
			);

			// 3. The user approves with the context kept; plan mode is off and the same manual start now opens a run.
			if (reached.answer === undefined) await approveKeepingContext(tui, mark);
			await Bun.sleep(2_000);
			const startedAfter = files.runIds();
			await tui.submit(manualStart);
			const run = await files.finishedRun(startedAfter, 150_000);
			check("after leaving plan mode the same manual start opens a run, and it finishes", run.results?.some(row => row.id === "probe-answer" && row.state === "accepted") === true, JSON.stringify(run.results));
			const shown = flat(tui.history().join("\n")).split(flat(PLAN_MODE_START_REFUSAL)).length - 1;
			// The painted history keeps a limited scrollback: by now the first refusal may have scrolled off (0). What must not happen is
			// a second refusal after plan mode was left.
			check("it was refused only while plan mode was on: the reason was never shown a second time", shown <= 1, `shown ${shown} times`);
		} finally {
			await tui.close();
		}
	}, 420_000);
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
