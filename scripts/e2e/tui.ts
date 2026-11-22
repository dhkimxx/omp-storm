#!/usr/bin/env bun
/**
 * OMP Storm end-to-end check in omp's interactive TUI, on a pty: what only that host has. Setup through Storm's
 * approval, role interviews, a plain request, and a run Storm sends back until its changes are reviewed. Same
 * isolated profile and fake LLM as run.ts; Storm is installed as a plugin.
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
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { ROLES } from "../../src/roles.ts";
import { parseModelEntry } from "../../src/selector.ts";
import type { RunRecord, StormConfig } from "../../src/types.ts";
import { focused, KEY, LlmCursor, type LlmEntry, linkPlugin, modelId, modelsYml, price, PROFILE_CONFIG, prepare, type Step, statusLine, StormFiles, Suite, startFakeLlm, TEAM_PROVIDERS, Tui, until } from "./harness.ts";

/** Option labels Storm does not export: the one that opens the setup forms, and the one that opens a cut context. */
const PICK_BY_ROLE = "역할별로 고르기";
const FULL_VIEW = "전체 내용 보기";
/** Key hints of Storm's report overlay, which Enter closes. */
const OVERLAY_HINT = "PgDn";
/** The disclosure a first team approval carries, and the setup-time question this change removed. */
const TURNS_AUTO_ON = "승인하면 자동 위임이 켜집니다";
const OLD_PROMPT = "자동 위임을 켤까요?";
/** The head of omp's form panel (answered and total fields) and the label of its last stop. */
const FORM_HEAD = /Ask · (\d+) of (\d+) answered/g;
const FORM_SUBMIT = "Submit";

const env = prepare("storm-e2e-tui", 18559);
const suite = new Suite("E2E (tui)", env);
const files = new StormFiles(env);
const check = suite.check.bind(suite);

const b64 = (value: unknown): string => `b64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
const mains = (entries: LlmEntry[]): LlmEntry[] => entries.filter(entry => entry.who === "main");
const plan = (name: string, kind: string): Step => ({ storm: { action: "plan", plan: { lanes: [{ name, kind }] } } });
const primary = (config: StormConfig | undefined, role: string): string | undefined => modelId(config?.roles[role]?.models[0]);
const OUTSIDE = "interview-outside";

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

/** Uses omp's native type-ahead while the field is focused. */
const option = (key: string, label: string): Edit => ({ key, what: `select ${label}`, effect: text => text.includes(`‹ ${label} ›`) });
/** Empties a text or number field (the cursor starts at its front): the head then counts one answer less. */
const CLEAR: Edit = { key: KEY.killLine, what: "become empty", effect: text => heads(text).some(([answered, total]) => answered === total - 1) };
/** Types `value` into an empty field: its row then shows exactly that. */
const type = (value: string): Edit => ({ key: value, what: `show ${value}`, effect: text => text.split("\n").some(row => row.replace(/[│█\s]/g, "") === value) });

/**
 * Fills the form that draws `heading` after `from`. Adjacent pages can have the same field count. One Tab per
 * field moves the focus to Submit. Each key waits for its repaint before the next one is sent.
 */
async function submitForm(tui: Tui, from: number, heading: string, fields: number, edits: Readonly<Record<number, readonly Edit[]>> = {}): Promise<number> {
	let label = await tui.seen(from, text => text.includes(heading) ? focused(text) : undefined, `the form for ${heading}`);
	for (let field = 1; field <= fields; field++) {
		const where = `field ${field} of ${fields} («${label}»)`;
		for (const edit of edits[field - 1] ?? []) await tui.press(edit.key, edit.effect, `${where} to ${edit.what}`);
		const tab = await tui.press(KEY.tab, text => focused(text) !== undefined, `the focus to move on from ${where}`);
		label = focused(tui.text(tab)) ?? "";
		if ((label === FORM_SUBMIT) !== (field === fields)) throw new Error(`Tab ${field} of ${fields} put the focus on «${label}»`);
	}
	return tui.send(KEY.enter);
}

async function main(): Promise<void> {
	const outside = { id: OUTSIDE, cost: price(2, 8), context: 110_000, efforts: ["low", "high"] } as const;
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, { ...TEAM_PROVIDERS, fake: [...TEAM_PROVIDERS.fake, outside] }));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	for (const [name, content] of Object.entries({ "note.txt": "e2e note\n", "note2.txt": "e2e second note\n", "note3.txt": "e2e third note\n" })) writeFileSync(join(env.project, name), content);
	linkPlugin(env);

	await suite.step(
		"setup: the dialog, approve",
		async () => {
			const llm = new LlmCursor(env);
			await session(async tui => {
				const typed = await tui.submit("/storm");
				const offered = await tui.selector(typed);
				check("the dialog is up and nothing is saved yet", offered.includes(PICK_BY_ROLE) && !existsSync(files.configFile), JSON.stringify(offered));
				if (offered.includes(FULL_VIEW)) check("a clipped proposal withholds approval", !offered.includes(APPROVE));
				// `answer` opens the full view when the panel is cut, so the disclosure is on screen either way.
				const approved = await answer(tui, typed, APPROVE);
				check("the approval panel discloses that approval turns automatic delegation on", tui.text(typed).includes(TURNS_AUTO_ON), tui.text(typed).slice(-400));
				// Storm writes the approval and the config, then the personal choice the approval now implies.
				await suite.eventually("approve saves the config and one approval", () => existsSync(files.configFile) && files.approvals().length === 1, () => `approvals=${files.approvals().length}`);
				const store = files.storeDir();
				if (store === undefined) throw new Error("the approval store is missing");
				const deadline = Date.now() + 15_000;
				while (Date.now() < deadline && (await readAutoDelegationChoice(store)) !== "on") await Bun.sleep(50);
				check("the single team approval persisted automatic delegation on", (await readAutoDelegationChoice(store)) === "on", await readAutoDelegationChoice(store));
				check("no separate automatic-delegation prompt followed approval", !tui.text(approved).includes(OLD_PROMPT), tui.text(approved).slice(-400));
				// The composer answers rather than a hidden prompt taking the keys.
				const status = await tui.submit("/storm status");
				await tui.shows(OVERLAY_HINT, status);
				tui.send(KEY.enter);
				check("no model request during setup", llm.all().filter(entry => entry.who !== "side").length === 0, `requests=${llm.all().length}`);
			});
		},
		180_000,
	);

	await suite.step(
		"setup: role pages with the native model picker and effort",
		async () => {
			const before = files.config();
			const approvals = files.approvals().length;
			const llm = new LlmCursor(env);
			await session(async tui => {
				let mark = await answer(tui, await tui.submit("/storm setup"), PICK_BY_ROLE);
				const browse = option("O", "OMP에서 다른 모델 선택");
				for (const { id, agent } of ROLES) {
					const explorer = id === "explorer";
					mark = await submitForm(tui, mark, agent, 4, explorer ? { 0: [browse], 3: [CLEAR, type("3")] } : {});
					const models = before.roles[id]?.models.slice(0, 2).map(parseModelEntry) ?? [];
					if (explorer) {
						await tui.shows("Storm 모델 선택", mark);
						mark = await submitForm(tui, tui.send("\x1b"), agent, 4);
						await tui.shows("Storm 모델 선택", mark);
						await tui.press(OUTSIDE, text => text.includes(OUTSIDE), "the native picker to find the outside model");
						mark = await submitForm(tui, tui.send(KEY.enter), `fake/${OUTSIDE}`, 1, { 0: [option("l", "low")] });
					}
					for (const [index, model] of models.entries()) {
						if ((explorer && index === 0) || model.effort === undefined) continue;
						mark = await submitForm(tui, mark, model.selector, 1);
					}
				}
				const settings = await submitForm(tui, mark, "예산", 8);
				await tui.selector(settings);
				check("role and effort pages don't save without approval", files.approvals().length === approvals && JSON.stringify(files.config()) === JSON.stringify(before));
				await answer(tui, settings, APPROVE);
				await suite.eventually("the selected model, its effort and worker limit are saved", () => {
					const role = files.config().roles.explorer;
					return role?.models[0] === `fake/${OUTSIDE}:low` && typeof role.workers === "object" && role.workers.max === 3 && files.approvals().length === approvals + 1;
				});
				check("the other roles keep their models", primary(files.config(), "implementer") === primary(before, "implementer"));
				const choiceStore = files.storeDir();
				check(
					"re-setup neither asks the automatic-delegation question nor turns it off",
					choiceStore !== undefined && (await readAutoDelegationChoice(choiceStore)) === "on" && !tui.text(settings).includes(OLD_PROMPT),
					choiceStore === undefined ? "no store" : await readAutoDelegationChoice(choiceStore),
				);
				check("setup made no model request", llm.all().filter(entry => entry.who !== "side").length === 0);
				const ordinary = new LlmCursor(env);
				await tui.submit("hello after the model picker");
				await until(() => mains(ordinary.all())[0], 15_000, "the first main request after the interview");
				check("the native picker did not switch the session model", mains(ordinary.all())[0]?.model === "general-b");
			});
		},
		240_000,
	);

	await suite.step(
		"a plain request ends without changes",
		async () => {
			const llm = new LlmCursor(env);
			await session(async tui => {
				const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"] }];
				const run = await runOf(tui, `/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`, 150_000);
				check("one side turn routed it", llm.of("route").length === 1, `route=${llm.of("route").length}`);
				check("one turn, ended with no changes", run.turns === 1 && run.endReason === "no-changes" && run.status === "ended", `turns=${run.turns} ${run.endReason} ${run.status}`);
				check("its subagent ran on the approved model", run.spawns.length === 1 && run.spawns[0]?.outcome === "routed" && run.agents?.length === 1, JSON.stringify(run.spawns.map(spawn => spawn.outcome)));
				check("it ended once", files.index().filter(line => line.runId === run.runId).length === 1);
			});
		},
		240_000,
	);

	await suite.step(
		"a run is sent back until its changes are reviewed",
		async () => {
			const changed = join(env.project, "e2e-rounded.txt");
			const llm = new LlmCursor(env);
			files.editConfig(config => {
				config.budget = { perRunUsd: 0.01, onExceed: "block-spawns" };
			});
			try {
				await session(async tui => {
					await answer(tui, await tui.submit("/storm"), APPROVE);
					await tui.seen(0, () => statusLine(tui.raw)?.startsWith("storm ✓") ? true : undefined, "budget approval");
					const steps: Step[] = [
						{ storm: { action: "plan", plan: { lanes: [{ name: "impl", kind: "code" }, { name: "review", kind: "review" }] } } },
						{ task: ["storm-implementer"], as: "Impl", say: "E2E-CHILD-WRITE e2e-rounded.txt" },
						{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
					];
					const before = files.runIds();
					const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
					await suite.eventually(
						"the live widget shows the round and budget",
						() => /Storm 실행 중[^\r\n]*\/4라운드[^\r\n]*\$0\.01/.test(tui.text(started)),
						() => "",
						30_000,
					);
					const run = await files.finishedRun(before, 240_000);
					await suite.eventually(
						"the status line returns to idle after the run",
						() => statusLine(tui.raw)?.startsWith("storm ✓") ?? false,
						() => statusLine(tui.raw) ?? "no status line",
						60_000,
					);
					const roundTag = `<storm-run id="${run.runId}" round="2/4">`;
					const stormMessages = [...new Set(mains(llm.all()).map(entry => entry.lastUser.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, "")))].filter(user => user.startsWith("<storm-run"));
					check(
						"Storm sent round 2 by itself, exactly once",
						stormMessages.length === 2 && stormMessages.filter(user => user.startsWith(roundTag)).length === 1,
						`storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`,
					);
					const implementer = run.agents?.find(agent => agent.role === "implementer");
					const reviewer = run.agents?.find(agent => agent.role === "reviewer");
					check("round 1's file change is counted", implementer?.changes === 1 && existsSync(changed), `changes=${implementer?.changes} file=${existsSync(changed)}`);
					check("round 2's verdict passes", reviewer?.lastVerdict?.correct === true, JSON.stringify(reviewer?.lastVerdict));
					check("the run ends verified after two rounds", run.status === "done" && run.endReason === "verified" && run.turns === 2, `${run.status} ${run.endReason} turns=${run.turns}`);
					const lines = files.index().filter(line => line.runId === run.runId);
					check(
						"the index line agrees, once",
						lines.length === 1 && lines[0]?.status === "done" && lines[0]?.endReason === "verified" && lines[0]?.turns === 2,
						JSON.stringify(lines),
					);
					const status = await tui.submit("/storm status");
					await tui.shows(OVERLAY_HINT, status);
					await tui.shows(/완료|리뷰 통과/, status);
					const top = tui.text(status);
					check("the TUI renders the approved team's status", top.includes("승인됨") && top.includes("마지막 실행"));
					check("the budget amount and partially filled meter are visible together", top.includes("$0.01") && top.includes(run.runId) && /█+░+/.test(top));
					tui.send(KEY.enter);
				});
			} finally {
				rmSync(changed, { force: true });
			}
		},
		300_000,
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
