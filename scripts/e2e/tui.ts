#!/usr/bin/env bun
/**
 * OMP Storm end-to-end check in omp's interactive TUI, on a pty: what only that host has. Setup through Storm's
 * dialog and its two forms, and runs in each mode: a plain request, a loop, a goal (omp's goal and loop modes exist
 * only in the TUI). Same isolated profile and fake LLM as run.ts; Storm is installed as a plugin.
 *
 * Usage: npm run e2e:tui   (env: see harness.ts)
 *
 * The driver is closed-loop: every key is followed by a wait for the repaint it must cause, and every check by a
 * wait for the state it asserts, so a slow machine only makes the run longer. Storm's files and the model request
 * log are what is asserted; the screen is read to know what has the focus. Directive payloads are typed as base64,
 * so no key of them means anything to the composer.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import { GOAL_NUDGE } from "../../src/runtime/modes.ts";
import type { RunRecord, StormConfig } from "../../src/types.ts";
import { focused, KEY, LlmCursor, type LlmEntry, linkPlugin, modelId, modelsYml, PROFILE_CONFIG, prepare, type Step, StormFiles, Suite, startFakeLlm, TEAM_PROVIDERS, Tui, until } from "./harness.ts";

/** Option labels Storm does not export: the one that opens the setup forms, and the one that opens a cut context. */
const PICK_BY_ROLE = "역할별로 고르기";
const FULL_VIEW = "전체 내용 보기";
/** Key hints of Storm's report overlay, which Enter closes. */
const OVERLAY_HINT = "PgDn";
/** The head of omp's form panel (answered and total fields) and the label of its last stop. */
const FORM_HEAD = /Ask · (\d+) of (\d+) answered/g;
const FORM_SUBMIT = "Submit";
/** omp continues a goal or a loop 0.8 s after a turn: this long after a run's end, a turn too many would have started. */
const AFTER_END_MS = 2_500;

const env = prepare("storm-e2e-tui", 18559);
const suite = new Suite("E2E (tui)", env);
const files = new StormFiles(env);
const check = suite.check.bind(suite);

const b64 = (value: unknown): string => `b64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
const mains = (entries: LlmEntry[]): LlmEntry[] => entries.filter(entry => entry.who === "main");
const plan = (name: string, kind: string): Step => ({ storm: { action: "plan", plan: { lanes: [{ name, kind }] } } });
const primary = (config: StormConfig | undefined, role: string): string | undefined => modelId(config?.roles[role]?.models[0]);

async function session<T>(body: (tui: Tui) => Promise<T>): Promise<T> {
	const tui = new Tui(env, { model: "fake/general-b" });
	try {
		await tui.ready();
		return await body(tui);
	} finally {
		await tui.close();
	}
}

/** Types a command that starts a Storm run and waits until the run has ended and everything about it is written. */
async function runOf(tui: Tui, command: string, timeoutMs: number): Promise<RunRecord> {
	const before = files.runIds();
	await tui.submit(command);
	return files.finishedRun(before, timeoutMs);
}

/**
 * Answers Storm's dialog drawn after raw offset `from` with `label`; returns the offset at the answer. A context too
 * long for the screen holds the accepting options back until its full view was opened: open it, close it, answer.
 */
async function answer(tui: Tui, from: number, label: string): Promise<number> {
	let mark = from;
	for (let round = 0; round < 3; round++) {
		const offered = await tui.selector(mark);
		if (offered.includes(label)) return tui.pick(offered, label);
		if (!offered.includes(FULL_VIEW)) throw new Error(`the dialog offers neither ${label} nor its full view: ${offered.join(", ")}`);
		const opened = await tui.pick(offered, FULL_VIEW);
		await tui.shows(OVERLAY_HINT, opened);
		// Closing the overlay brings the dialog back: the next round waits for it.
		mark = tui.send(KEY.enter);
	}
	throw new Error(`the dialog never offered ${label}`);
}

/** A key typed into the focused field of a form, and the repaint that shows omp took it. */
interface Edit {
	key: string;
	what: string;
	effect(text: string): boolean;
}

/** `[answered, total]` of every form head in `text`. */
const heads = (text: string): Array<[number, number]> => [...text.matchAll(FORM_HEAD)].map(head => [Number(head[1]), Number(head[2])]);

/** Steps a dropdown to its next option: the row then shows the second position. */
const NEXT_OPTION: Edit = { key: KEY.right, what: "step to its next option", effect: text => /›\s+2\/\d+/.test(text) };
/** Empties a text or number field (the cursor starts at its front): the head then counts one answer less. */
const CLEAR: Edit = { key: KEY.killLine, what: "become empty", effect: text => heads(text).some(([answered, total]) => answered === total - 1) };
/** Types `value` into an empty field: its row then shows exactly that. */
const type = (value: string): Edit => ({ key: value, what: `show ${value}`, effect: text => text.split("\n").some(row => row.replace(/[│█\s]/g, "") === value) });

/**
 * Fills and submits the form omp opens after raw offset `from` (one with another number of fields than `previous`,
 * the form before it). One Tab per field moves the focus to Submit and Enter sends it; `edits` are typed while the
 * field of that index (in Tab order) has the focus. Each key waits for its repaint: the row that got the focus for
 * a Tab, the changed value for an edit. Returns the raw offset at the Enter: the caller waits for what the form
 * leads to.
 */
async function submitForm(tui: Tui, from: number, previous: number | undefined, edits: Readonly<Record<number, readonly Edit[]>> = {}): Promise<{ fields: number; mark: number }> {
	// The form is up once its head and, below it, its first field with the focus are drawn.
	const { fields, first } = await tui.seen(
		from,
		text => {
			const head = [...text.matchAll(FORM_HEAD)].findLast(match => Number(match[2]) !== previous);
			const label = head && focused(text.slice(head.index));
			return head && label !== undefined ? { fields: Number(head[2]), first: label } : undefined;
		},
		"a form with its first field focused",
		90_000,
	);
	let label = first;
	for (let field = 1; field <= fields; field++) {
		const where = `field ${field} of ${fields} («${label}»)`;
		for (const edit of edits[field - 1] ?? []) await tui.press(edit.key, edit.effect, `${where} to ${edit.what}`);
		const tab = await tui.press(KEY.tab, text => focused(text) !== undefined, `the focus to move on from ${where}`);
		label = focused(tui.text(tab)) ?? "";
		if ((label === FORM_SUBMIT) !== (field === fields)) throw new Error(`Tab ${field} of ${fields} put the focus on «${label}»`);
	}
	return { fields, mark: tui.send(KEY.enter) };
}

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	for (const [name, content] of Object.entries({ "note.txt": "e2e note\n", "note2.txt": "e2e second note\n", "note3.txt": "e2e third note\n" })) writeFileSync(join(env.project, name), content);
	linkPlugin(env);
	/** The recommended team as approved in the first step. */
	let recommended: StormConfig | undefined;

	await suite.step(
		"setup: the dialog, approve",
		async () => {
			const llm = new LlmCursor(env);
			await session(async tui => {
				const typed = await tui.submit("/storm");
				const offered = await tui.selector(typed);
				check("the dialog is up and nothing is saved yet", offered.includes(PICK_BY_ROLE) && !existsSync(files.configFile), JSON.stringify(offered));
				await answer(tui, typed, APPROVE);
				// Storm writes the approval, then the config.
				await suite.eventually("approve saves the config and one approval", () => existsSync(files.configFile) && files.approvals().length === 1, () => `approvals=${files.approvals().length}`);
				check("no model request during setup", llm.all().filter(entry => entry.who !== "side").length === 0, `requests=${llm.all().length}`);
			});
			recommended = existsSync(files.configFile) ? files.config() : undefined;
		},
		180_000,
	);

	await suite.step(
		"setup: pick by role in the two forms",
		async () => {
			// A project without a team again: the forms start from the recommendation and their result needs approval.
			rmSync(join(env.project, ".omp"), { recursive: true, force: true });
			rmSync(join(env.agentDir, "storm"), { recursive: true, force: true });
			const llm = new LlmCursor(env);
			await session(async tui => {
				const opened = await answer(tui, await tui.submit("/storm"), PICK_BY_ROLE);
				const models = await submitForm(tui, opened, undefined);
				const settings = await submitForm(tui, models.mark, models.fields);
				check("two forms: models, then settings", models.fields > 0 && settings.fields > 0, `fields=${models.fields},${settings.fields}`);
				// The approval dialog is what the settings form leads to; nothing is written before its answer.
				const asked = await tui.selector(settings.mark);
				check("nothing is saved before the approval", asked.length > 0 && !existsSync(files.configFile) && files.approvals().length === 0, JSON.stringify(asked));
				await answer(tui, settings.mark, APPROVE);
				await suite.eventually("the forms' team is saved and approved", () => existsSync(files.configFile) && files.approvals().length === 1, () => `approvals=${files.approvals().length}`);
				const picked = existsSync(files.configFile) ? files.config() : undefined;
				const primaries = (config: StormConfig | undefined) => Object.keys(config?.roles ?? {}).map(id => `${id}=${primary(config, id)}`).sort().join(" ");
				check("left as prefilled, the forms give the recommended models", primaries(picked) === primaries(recommended) && primaries(picked) !== "", primaries(picked));
				check("no model request", llm.all().filter(entry => entry.who !== "side").length === 0);
			});
		},
		240_000,
	);

	await suite.step(
		"setup: change a model and a number in the forms",
		async () => {
			const before = files.config();
			const approvals = files.approvals().length;
			const most = (config: StormConfig) => (typeof config.roles.explorer?.workers === "object" ? config.roles.explorer.workers.max : undefined);
			await session(async tui => {
				// The recommendation equals the approved team, so the only way on is the forms.
				const opened = await answer(tui, await tui.submit("/storm setup"), PICK_BY_ROLE);
				// Models form, field 1: the explorer's primary, a dropdown on its first candidate. Settings form, field
				// 3: the explorer's most workers, a number.
				const models = await submitForm(tui, opened, undefined, { 0: [NEXT_OPTION] });
				const settings = await submitForm(tui, models.mark, models.fields, { 2: [CLEAR, type("3")] });
				await answer(tui, settings.mark, APPROVE);
				// The approval is written first, the config after it.
				await until(() => (files.approvals().length === approvals + 1 && primary(files.config(), "explorer") !== primary(before, "explorer") ? true : undefined), 60_000, "the changed team to be approved and saved");
				const after = files.config();
				check("the picked model is saved", primary(after, "explorer") !== undefined && primary(after, "explorer") !== primary(before, "explorer"), `${primary(before, "explorer")} → ${primary(after, "explorer")}`);
				check("the typed number is saved", most(after) === 3 && most(before) !== 3, `${most(before)} → ${most(after)}`);
				check("the other roles keep their models", primary(after, "implementer") === primary(before, "implementer"));
			});
		},
		240_000,
	);

	await suite.step(
		"a plain request ends at settle",
		async () => {
			const llm = new LlmCursor(env);
			await session(async tui => {
				const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"] }];
				const run = await runOf(tui, `/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`, 150_000);
				check("one side turn routed it", llm.of("route").length === 1, `route=${llm.of("route").length}`);
				check("a vibe run: one settled turn, ended by the settle", run.mode === "vibe" && run.turns === 1 && run.endReason === "settled" && run.status === "done", `${run.mode} turns=${run.turns} ${run.endReason} ${run.status}`);
				check("its subagent ran on the approved model", run.spawns.length === 1 && run.spawns[0]?.outcome === "routed" && run.agents?.length === 1, JSON.stringify(run.spawns.map(spawn => spawn.outcome)));
				check("it ended once", files.index().filter(line => line.runId === run.runId).length === 1);
			});
		},
		240_000,
	);

	await suite.step(
		"loop 3 runs three turns",
		async () => {
			const llm = new LlmCursor(env);
			await session(async tui => {
				const run = await runOf(tui, `/storm loop 3 E2E-STEPS ${b64([{ read: "note.txt" }])}`, 150_000);
				check("a loop run of exactly 3 turns", run.mode === "loop" && run.turns === 3, `${run.mode} turns=${run.turns}`);
				check("ended by omp's loop limit", run.endReason === "loop-ended" && run.status === "done", `${run.endReason} ${run.status}`);
				check("the record keeps the limit in turns", run.loop?.limit?.kind === "turns" && run.loop.limit.turns === 3, JSON.stringify(run.loop));
				const reads = mains(llm.all()).filter(entry => entry.decision.tool === "read").length;
				check("the prompt ran three times", reads === 3, `reads=${reads}`);
				await Bun.sleep(AFTER_END_MS);
				check("nothing runs after the end", mains(llm.all()).filter(entry => entry.decision.tool === "read").length === 3 && files.index().filter(line => line.runId === run.runId).length === 1);
				const summary = files.index().find(line => line.runId === run.runId);
				check("the index line has mode, turns and end reason", summary?.mode === "loop" && summary.turns === 3 && summary.endReason === "loop-ended", JSON.stringify(summary));
			});
		},
		240_000,
	);

	await suite.step(
		"goal runs across turns and ends once",
		async () => {
			const llm = new LlmCursor(env);
			await session(async tui => {
				// Turns 1 and 2 use a tool, so omp continues by itself. Turn 3 does not: omp stops continuing without a
				// word, and Storm's nudge starts turn 4, which completes the goal.
				const turns: Step[][] = [[{ read: "note.txt" }], [{ read: "note2.txt" }], [], [{ read: "note3.txt" }, { goal: "complete" }]];
				const runs = files.runs().length;
				const run = await runOf(tui, `/storm goal E2E-TURNS ${b64(turns)}`, 240_000);
				check("a goal run across several turns", run.mode === "goal" && (run.turns ?? 0) > 1, `${run.mode} turns=${run.turns}`);
				check("ended by the goal tool's complete", run.endReason === "goal-complete" && run.status === "done", `${run.endReason} ${run.status}`);
				check("the record keeps the objective", run.goal?.objective.startsWith("E2E-TURNS") === true, JSON.stringify(run.goal));
				const director = mains(llm.all());
				const completes = director.filter(entry => entry.decision.tool === "goal").length;
				check("the model completed the goal once", completes === 1, `goal calls=${completes}`);
				const nudges = director.at(-1)?.users.filter(user => user.includes(GOAL_NUDGE)).length ?? 0;
				check("the turn without tool activity got Storm's nudge", nudges === 1, `nudges=${nudges}`);
				await Bun.sleep(AFTER_END_MS);
				check("it ended exactly once", files.runs().length === runs + 1 && files.index().filter(line => line.runId === run.runId).length === 1 && files.run(run.runId)?.endReason === "goal-complete", `runs=${files.runs().length - runs}`);
				check("nothing runs after the end", mains(llm.all()).length === director.length, `requests=${mains(llm.all()).length}/${director.length}`);
			});
		},
		360_000,
	);
}

let code = 1;
const server = await startFakeLlm(env);
try {
	await main();
} catch (error) {
	// Outside any step (the profile could not be prepared): still a failure in the summary.
	suite.check("harness", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
	server.kill();
	await server.exited;
	code = suite.finish();
}
process.exit(code);
