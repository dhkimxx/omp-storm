#!/usr/bin/env bun
/**
 * OMP Storm end-to-end check in omp's interactive TUI, on a pty: what only that host has. Setup through Storm's
 * approval, role interviews, a plain request, a run Storm sends back until its changes are reviewed, a native ask
 * that holds and then resumes the same run, shutdown while it waits, and narrow motion-off runs in dark and light.
 * Settled runs: a short clean run leaves one factual line and no menu; an incomplete run keeps the whole closeout
 * card at 60 columns, its first numbered direction starts one related follow-up, a restart draws the card again but
 * restores no choice, and an interrupted run's only numbered action is the recorded resume.
 * Same isolated profile and fake LLM as run.ts; Storm is installed as a plugin.
 *
 * Usage: npm run e2e:tui   (env: see harness.ts)
 *
 * omp 19.2 paints by diff, so what is "on the screen" is read from the harness's emulated screen (`tui.screen()`,
 * `tui.history()`, `selector()`, `statusLine(tui)`), and "what was painted since this key" from `tui.text(from)`.
 * `E2E_ONLY=<part of a scenario name>` runs one scenario alone: scenarios after the setup ones approve the team over
 * RPC first (`ensureApprovedTeam`), so each can be tried and judged on its own.
 *
 * Which scenario judges which Storm surface (the surface slices of the 19.2 port), so a failure points at its owner:
 *   setup (3 scenarios) ........ selection dialogs and context panel (C), model picker (D), omp's own forms
 *   a plain request ............ live widget and footer (A)
 *   a short clean run .......... the one-fact record (B)
 *   an incomplete run, numbered resume ... the closeout card (B), its numbered choices
 *   a native ask ............... omp's own ask form, live widget (A)
 *   a run sent back ............ live widget (A), `/storm status` overlay (C)
 *   three lane view scenarios ... the lane view (A): its own height, no blank row under it, folding past the cap
 *   narrow motion off, under 60, ASCII ... live widget single line (A), `/storm` hub and status overlay (C)
 *   Escape flow, shutdown ...... omp's ask form, footer (A), closeout card (B)
 *
 * The driver is closed-loop: every key is followed by a wait for the repaint it must cause, and every check by a
 * wait for the state it asserts, so a slow machine only makes the run longer. Storm's files and the model request
 * log are what is asserted; the screen is read to know what has the focus. Directive payloads are typed as base64,
 * so no key of them means anything to the composer.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { ROLES, STORM_VERSION } from "../../src/roles.ts";
import { parseModelEntry } from "../../src/selector.ts";
import type { RunRecord, StormConfig } from "../../src/types.ts";
import { idleAppearance, RUN_APPEARANCE, type RunPhase, STORM_MARK } from "../../src/view/appearance.ts";
import { LANE_MIN_COLUMNS } from "../../src/view/lane/frame.ts";
import { STATE_WORD, TRUNK_LABEL } from "../../src/view/lane/layout.ts";
import type { LaneState } from "../../src/view/lane/model.ts";
import { LANE_MIN_ROWS, laneHeight } from "../../src/view/live.ts";
import { priorityLabel } from "../../src/view/render.ts";
import { CLOSEOUT_NEXT_MAX } from "../../src/runtime/closeout.ts";
import { CLOSEOUT_CHOICE_HINT, GOAL_LABEL, goalText } from "../../src/view/closeout.ts";
import { continuationTask } from "../../src/runtime/resume.ts";
import { STATUS_LABEL } from "../../src/runtime/rounds.ts";
import {
	approveTeam, CLOSEOUT_DETAIL, CLOSEOUT_HEADING, closeoutBody, focused, isOneLineCloseout, KEY, LlmCursor, type LlmEntry, linkPlugin, modelId, modelsYml, numberedOffers, offeredDirections, persistedStormRecords,
	price, PROFILE_CONFIG, prepare, Rpc, RESUME_NEXT, runNext, sessionFileIn, type Step, type StormRecord, statusLine, StormFiles, Suite, startFakeLlm, TEAM_PROVIDERS, Tui,
	until, userNext, cancelAll,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

/** Option labels Storm does not export: the one that opens the setup forms, and the one that opens a cut context. */
const PICK_BY_ROLE = "역할별로 고르기";
const DIRECT_MODEL = "모델·effort 수정";
const CONTINUE_EDITING = "계속 수정";
const FULL_VIEW = "전체 내용 보기";
/** Key hints of Storm's report overlay, which Enter closes. */
const OVERLAY_HINT = "PgDn";
/** The disclosure a first team approval carries, and the setup-time question this change removed. */
const TURNS_AUTO_ON = "승인하면 이 세션의 자동 위임이 켜집니다";
const OLD_PROMPT = "자동 위임을 켤까요?";
/** The head of omp's form panel (answered and total fields) and the label of its last stop. */
const FORM_HEAD = /Ask · (\d+) of (\d+) answered/g;
const FORM_SUBMIT = "Submit";
/** Exact user text materialized in the seed transcript before every interactive launch. */
const SESSION_SEED = "Storm TUI fixture transcript.";

const env = prepare("storm-e2e-tui", 18559);
seedFact(env.project);
const suite = new Suite("E2E (tui)", env);
const check = suite.check.bind(suite);

/**
 * The native TUI session every scenario opens: created once through the public RPC host (so its id and transcript are
 * real and materialized), then resumed with `--resume <id>` for each interactive scenario. Storm's per-session store
 * is therefore the one this suite builds up; a different session would start with no team.
 */
let ownedSession: { id: string; dir: string } | undefined;

const b64 = (value: unknown): string => `b64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
const mains = (entries: LlmEntry[]): LlmEntry[] => entries.filter(entry => entry.who === "main");
/**
 * The read-only probes in this TUI file deliver one sourced observation: the child reads the typed fixture file and
 * cites its exact line, restating its signed typed value, so every probing lane has a real result that the official
 * answer evidence accepts mechanically. The fixture file name is as wide as the old tracked file's (15 columns), so
 * the result label and every width/wrap measurement below render exactly as before.
 */
const TRACKED_CLAIM = FACT_CLAIM;
const trackedAnswer = (id: string): Record<string, unknown> => ({ id, kind: "answer", criterion: `report what ${FACT_FILE} line 1 says`, path: FACT_FILE, contains: FACT_LINE });
const readProbe = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${TRACKED_CLAIM}`;
const plan = (name: string, kind: string): Step => ({ storm: { action: "plan", plan: { lanes: [{ name, kind, results: [trackedAnswer(`${name}-answer`)] }] } } });
const primary = (config: StormConfig | undefined, role: string): string | undefined => modelId(config?.roles[role]?.models[0]);
const OUTSIDE = "interview-outside";
/** The calm footer an approved team with automatic delegation shows when no run is live. */
const IDLE = idleAppearance({ team: "approved", auto: "on", resume: false });
/** The same footer while a stopped run can be continued. */
const RESUME = idleAppearance({ team: "approved", auto: "on", resume: true });
/** A native ask form with a named text control: its label becomes the question, its placeholder is visible. It carries
 * the managed-decision marker a Storm director must use for a genuine user choice. */
const ASK_FORM = '<form data-storm-decision="e2e-tui-ask-v1" data-storm-reason="user-choice"><fieldset><legend>E2E 확인</legend><label>E2E-QUESTION <input name="e2e-answer" placeholder="E2E-ANSWER"></label></fieldset></form>';
const ASK_ANSWER = "resume-ok";
/** The file the 60-column card scenario's implementer writes and no reviewer ever judges. */
const CARD_FILE = "e2e-card.txt";
/** The file the goal step's implementer appends to, once per run of the goal. */
const GOAL_FILE = "e2e-goal.txt";
/** The official label of a done run, as the settled record and the status view print it. */
const STATUS_DONE = STATUS_LABEL.done;
/** The incomplete run whose card offered a related follow-up; later unrelated handoffs must not carry its facts. */
let cardRunId: string | undefined;

/** The widget's static header text: the shared mark, then the shared phase label. */
const phaseHeader = (phase: RunPhase): string => `${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`;

const RADAR_FIELD = /\[[\u2801-\u28ff]{18}\]/;
const metricsRow = (text: string, preset: "unicode" | "ascii" = "unicode"): string | undefined => {
	// The round chip carries a maximum only for a capped run; the worker chip always shows running over total.
	const chips = preset === "unicode" ? /↻\s*\d+(?:\/\d+)?.*👥\s*\d+\/\d+/u : /\bloop\s*\d+(?:\/\d+)?.*\bAG\s*\d+\/\d+/;
	return text.split("\n").map(line => line.trim()).findLast(line => chips.test(line));
};

function radarFrames(text: string, phase: RunPhase): Set<string> {
	const head = phaseHeader(phase);
	return new Set(text.split("\n").flatMap(line => {
		const field = line.includes(head) ? line.match(RADAR_FIELD)?.[0] : undefined;
		return field ? [field] : [];
	}));
}
// The lane view (the default live view where the terminal is big enough): a status row, the director's trunk row,
// one row per lane. Its rows are found by the trunk label and Braille, never by colour.
const BRAILLE = /[\u2800-\u28ff]/u;
/** Whether `row` is the director's trunk row of the lane view. */
const isTrunkRow = (row: string): boolean => row.trimStart().startsWith(TRUNK_LABEL) && BRAILLE.test(row);
/** The distinct trunk rows painted in `text`: the picture moves, so a live run shows more than one. */
function trunkFrames(text: string): Set<string> {
	return new Set(text.split("\n").map(row => row.trimEnd()).filter(isTrunkRow));
}
/** The states a lane's row showed, in order of appearance, without consecutive repeats. */
function laneSequence(text: string, lane: string): LaneState[] {
	const sequence: LaneState[] = [];
	for (const row of text.split("\n")) {
		const line = row.trim();
		if (!line.startsWith(`${lane} `) || !BRAILLE.test(line)) continue;
		const state = (Object.entries(STATE_WORD) as Array<[LaneState, string]>).find(([, word]) => line.endsWith(word) || new RegExp(`${word} \\d+/\\d+$`, "u").test(line))?.[0];
		if (state !== undefined && sequence.at(-1) !== state) sequence.push(state);
	}
	return sequence;
}
/** Whether `wanted` appears in `sequence` in that order, other states allowed in between. */
const inOrder = (sequence: readonly LaneState[], wanted: readonly LaneState[]): boolean => {
	let at = 0;
	for (const state of sequence) if (state === wanted[at]) at++;
	return at === wanted.length;
};

/** The state word a lane's row ends with on the screen a person sees now, if the row is there. */
function shownState(tui: Tui, lane: string): LaneState | undefined {
	const row = liveScreen(tui)?.viewport.find(line => line.trim().startsWith(`${lane} `) && BRAILLE.test(line));
	if (row === undefined) return undefined;
	return (Object.entries(STATE_WORD) as Array<[LaneState, string]>).find(([, word]) => row.trimEnd().endsWith(word) || new RegExp(`${word} \\d+/\\d+$`, "u").test(row.trimEnd()))?.[0];
}

/**
 * A session of its own with a team approved over RPC (as result-direction.ts does): its workers are addressable by
 * lane name, which a follow-up to a lane's worker needs. The transcript carries `seedText`.
 */
async function seedOwnSession(seedText: string): Promise<{ id: string; dir: string }> {
	const seed = new Rpc(env, cancelAll, { model: "fake/general-b" });
	try {
		await seed.ready();
		await seed.turn(seedText);
		await approveTeam(seed, "off");
		await seed.identify();
		return { id: seed.sessionId, dir: seed.sessionDir };
	} finally {
		await seed.close();
	}
}

/** Where the live widget sits on the screen a person sees. */
interface LiveScreen {
	/** Viewport row of the status row (`≋ STORM · <phase> …`). */
	status: number;
	/** Whether the row under it is the trunk (the lane view) rather than the single line's second row or blank. */
	lanes: boolean;
	/** The viewport rows from the status row down, without trailing blank rows. */
	rows: string[];
	viewport: string[];
	/** Blank screen rows under the widget's last drawn row; the dock sits at the bottom, so any is a padded widget. */
	blankUnder: number;
}
function liveScreen(tui: Tui): LiveScreen | undefined {
	const { viewport } = tui.screen();
	const labels = Object.values(RUN_APPEARANCE).map(appearance => appearance.label);
	const status = viewport.findLastIndex(row => row.startsWith(`${STORM_MARK} · `) && labels.some(label => row.includes(label)));
	if (status < 0) return undefined;
	const rows = viewport.slice(status);
	while (rows.length > 1 && rows.at(-1) === "") rows.pop();
	return { status, lanes: isTrunkRow(viewport[status + 1] ?? ""), rows, viewport, blankUnder: viewport.length - status - rows.length };
}
/** The last rendered row carrying a live phase header, without surrounding box edges or padding. */
function phaseRow(text: string, phase: RunPhase): string | undefined {
	const header = phaseHeader(phase);
	return text
		.split("\n")
		.map(row => row.trim())
		.filter(row => row.includes(header))
		.at(-1);
}

/** Screen rows without frame edges or padding, empty rows dropped: what a person reads of a framed record. */
function screenRows(text: string): string[] {
	return text
		.split("\n")
		.map(row => row.replace(/^[\s│|]+|[\s│|]+$/g, ""))
		.filter(row => row !== "" && !/^[╭╮╰╯─+\-]+$/.test(row));
}

/** The raw painted rows of a closeout from its first row through its status pointer, frame edges kept, for width checks. */
function cardRows(text: string): string[] {
	const rows = text.split("\n");
	const end = rows.findIndex(row => row.includes(CLOSEOUT_DETAIL));
	return rows.slice(0, end < 0 ? rows.length : end + 1).filter(row => row.trim() !== "");
}

/**
 * Whether the footer names the approved team's idle state, calm or resumable. The head must be exact: a live
 * widget's `≋ STORM · 다음 라운드 대기 …` also contains "대기" and must not pass for a restored idle footer.
 */
function idleFooter(line: string | undefined): boolean {
	if (line === undefined) return false;
	return [IDLE.label, RESUME.label].some(label => {
		const head = `${STORM_MARK} · ${label}`;
		return line === head || line.startsWith(`${head} · `);
	});
}

async function readyForSubmission(tui: Tui): Promise<void> {
	await tui.ready();
	// OMP can already paint the composer and accept typing while startup still disables Enter. Replay starts
	// after the submit gate is lifted and the prior draft has been restored, so wait for the resumed transcript.
	await tui.shows(SESSION_SEED);
}

async function session<T>(
	body: (tui: Tui, files: StormFiles) => Promise<T>,
	model = "fake/general-b",
	flags: string[] = [],
	view: { columns: number; rows: number } | undefined = undefined,
): Promise<T> {
	if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
	const tui = new Tui(env, { model, flags: ["--motion", "full", ...flags], resume: ownedSession.id, sessionDir: ownedSession.dir, ...view });
	try {
		await readyForSubmission(tui);
		return await body(tui, new StormFiles(env, tui.sessionId));
	} finally {
		await tui.close();
	}
}

/** Types a command that starts a Storm run and waits until the run has ended and everything about it is written. */
async function runOf(tui: Tui, files: StormFiles, command: string, timeoutMs: number): Promise<RunRecord> {
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

/**
 * The effort the picker has selected, from its status row (`thinking Off · 이 역할에만 …`). The steps row under it
 * (`effort Auto  [Off]  Low  High`) lists every step and would match first-to-last, so only `thinking` counts.
 */
const pickerLevel = (text: string): string | undefined =>
	[...text.matchAll(/\bthinking\s+(Auto|Off|Min|Low|Med|High|XHigh|Max)\b/gi)].at(-1)?.[1]?.toLowerCase();

async function stepEffort(tui: Tui, level: string): Promise<void> {
	await tui.press(KEY.right, painted => pickerLevel(painted) === level, `the picker to show effort ${level}`, 10_000);
}

/** Native rich menus can put the row description next to the label or below the focused row. */
async function pickMenuRow(tui: Tui, from: number, title: string, label: string): Promise<number> {
	let current = await tui.seen(from, text => text.includes(title) ? focused(text) : undefined, `the ${title} menu`, 15_000);
	for (let move = 0; !current.startsWith(label); move++) {
		if (move === 20) throw new Error(`${title} did not offer ${label}`);
		const previous = current;
		const mark = await tui.press(KEY.down, text => {
			const next = focused(text);
			return next !== undefined && next !== previous;
		}, `the next row in ${title}`, 8_000);
		current = focused(tui.text(mark))!;
	}
	return tui.send(KEY.enter);
}

async function openExplorerPrimary(tui: Tui, from: number): Promise<number> {
	return pickMenuRow(tui, from, "바꿀 모델 슬롯을 고르세요", "탐색 · 주 모델");
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

/**
 * The setup cases build the approved team this session's later screens read. `E2E_ONLY` selects one case, so a
 * stateful screen selected on its own would open the fixture's correctly blank session and fail far from the cause.
 * Name the missing prerequisite before launching the TUI rather than weakening the screen assertion.
 */
function requireApprovedTeam(files: StormFiles, name: string): void {
	if (!existsSync(files.configFile) || files.approvals().length === 0) {
		throw new Error(`${name} needs the approved team built by the setup cases; run the suite without E2E_ONLY (a single E2E_ONLY selector skips that setup)`);
	}
}

/**
 * Whether this session's team carries a required check. The sent-back scenario sets one, and a run with a code lane
 * that never ran it ends `no-changes` instead of `verified`: the narrow and ASCII runs prove their end state against
 * the team they actually have, so each also stands on its own (`E2E_ONLY`) and in the full order.
 */
const certifies = (files: StormFiles): boolean => (files.config().requiredChecks?.length ?? 0) === 0;
const endsAsExpected = (run: RunRecord, files: StormFiles): boolean =>
	certifies(files) ? run.status === "done" && run.endReason === "verified" : run.endReason === "no-changes";

/**
 * The narrow, motion-off run in one terminal appearance; the light variant proves no theme assumption. At 60 columns
 * and 18 rows or more the lane view is drawn (still, with motion off); below either the old single line with its radar
 * is, so `columns` and `rows` choose which of the two is proven.
 */
async function narrowMotionOff(background: "dark" | "light", columns = LANE_MIN_COLUMNS, rows = 30): Promise<void> {
	if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
	const files = new StormFiles(env, ownedSession.id);
	requireApprovedTeam(files, `${background}: narrow motion-off`);
	const lanes = columns >= LANE_MIN_COLUMNS && rows >= LANE_MIN_ROWS;
	const tui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], columns, rows, background, resume: ownedSession.id, sessionDir: ownedSession.dir });
	const named = (name: string): string => `${background}, ${columns}x${rows}: ${name}`;
	try {
		await readyForSubmission(tui);
		await tui.seen(0, () => (idleFooter(statusLine(tui)) ? true : undefined), named("narrow idle footer"), 30_000);
		const idle = statusLine(tui);
		check(named("the narrow footer uses the shared mark and an idle state"), idleFooter(idle), idle ?? "no status line");
		check(named("the narrow footer fits the terminal"), Bun.stringWidth(idle ?? "") <= columns, `${Bun.stringWidth(idle ?? "")} > ${columns}: ${idle}`);
		const before = files.runIds();
		const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-DELAY 6000 ${readProbe}` }, { awaitChild: true }];
		const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
		await tui.seen(started, text => (phaseRow(text, "workers") !== undefined ? true : undefined), named("workers phase"), 30_000);
		const active = await tui.seen(started, text => {
			const metrics = metricsRow(text);
			return metrics && /👥\s*1\/1\b/u.test(metrics) ? metrics : undefined;
		}, named("the live chip to report one active worker out of one"), 20_000);
		// Let the child's request land and its spend repaint once; then the still row is what motion off should hold.
		let first = phaseRow(tui.text(started), "workers");
		let stableSince = Date.now();
		while (Date.now() - stableSince < 700) {
			await Bun.sleep(50);
			const row = phaseRow(tui.text(started), "workers");
			if (row !== first) {
				first = row;
				stableSince = Date.now();
			}
		}
		if (lanes) {
			// The status row loses its radar (the trunk carries the motion); every row of the view fits the terminal.
			const live = liveScreen(tui);
			check(
				named("the status row and the lane view fit the terminal width"),
				first !== undefined && !RADAR_FIELD.test(first) && live?.lanes === true && [first, active, ...(live?.rows ?? [])].every(line => Bun.stringWidth(line) <= columns),
				`${first} / ${active} / ${live?.rows.join(" | ")}`,
			);
			// Motion off: the picture is repainted only when the run changes (the time axis moves with it), never on a
			// timer. At the 85 ms tick, 800 ms would paint about nine different trunk rows.
			const mark = tui.raw.length;
			await Bun.sleep(800);
			const second = phaseRow(tui.text(started), "workers");
			const painted = trunkFrames(tui.text(mark));
			const again = liveScreen(tui);
			check(
				named("motion off leaves the picture still: no timer repaints it"),
				first !== undefined && second === first && painted.size <= 2 && live !== undefined && again?.status === live.status,
				`${first === second}, ${painted.size} trunk rows in 800 ms, status row ${live?.status} → ${again?.status}`,
			);
		} else {
			check(
				named("the single line keeps its phase, radar and active worker count within the terminal"),
				first !== undefined && RADAR_FIELD.test(first) && [first, active].every(line => Bun.stringWidth(line) <= columns) && trunkFrames(tui.text(started)).size === 0,
				`${first} / ${active}`,
			);
			await Bun.sleep(800);
			const second = phaseRow(tui.text(started), "workers");
			check(named("motion off leaves the radar still"), first !== undefined && second === first && radarFrames(tui.text(started), "workers").size === 1, `${first} → ${second}`);
		}
		const run = await files.finishedRun(before, 120_000);
		check(named(`the narrow run accepts its answer and ${certifies(files) ? "verifies it" : "does not certify the unrun code check"}`),
			run.results?.some(row => row.id === "impl-answer" && row.state === "accepted") === true && endsAsExpected(run, files), `${run.status} ${run.endReason}`);
		await suite.eventually(named("the narrow footer returns to idle"), () => idleFooter(statusLine(tui)), () => statusLine(tui) ?? "no status line", 30_000);
		if (background === "dark" && columns === LANE_MIN_COLUMNS && rows === 30) {
			const hub = await tui.submit("/storm");
			const full = await pickMenuRow(tui, hub, "Storm 메뉴", "전체 현황");
			check("the narrow hub reaches the dashboard without a second link above the menu", !tui.text(hub).includes("전체 현황은 /storm status"));
			await tui.shows(OVERLAY_HINT, full);
			const storage = await tui.press("4", text => text.includes("Storm 세션 데이터") || text.includes("저장 공간"), "the storage tab to show its actual inventory");
			const storageReport = tui.text(storage);
			check("a storage coverage gap has the OMP warning icon and a readable reason", /⚠[^\n]*(측정 불가|집계 누락|일부 누락)/u.test(storageReport));
			const runtime = await tui.press("\x1b[D", text => text.includes("서브에이전트") && text.includes("컨텍스트") && text.includes("후속 지시"), "Left to show readable worker details on the runtime tab");
			check("the narrow runtime view keeps worker metrics out of a wrapped table", !tui.text(runtime).includes("┌──"));
			check("the storage tab is reachable directly at 60 columns", tui.text(storage).includes("Storm 세션 데이터") || tui.text(storage).includes("저장 공간"));
			tui.send(KEY.enter);
		}
	} finally {
		await tui.close();
	}
}

/** OMP's ASCII setting, not a separate Storm switch. Change only the isolated fixture for this session. */
async function asciiDashboard(): Promise<void> {
	if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
	const files = new StormFiles(env, ownedSession.id);
	requireApprovedTeam(files, "the ASCII dashboard");
	const profile = join(env.agentDir, "config.yml");
	const original = readFileSync(profile, "utf8");
	writeFileSync(profile, `${original.trimEnd()}\nsymbolPreset: ascii\n`);
	const columns = 60;
	const resume = ownedSession;
	const resultPrefix = `> report what ${FACT_FILE} line 1 says `;

	/**
	 * At 60 columns the result form intentionally owns the metrics row; the same run at 120 proves the ASCII round,
	 * worker and spend chips while a worker is genuinely active. Both rows are measured at their real terminal width.
	 */
	async function asciiWideWorkerChips(): Promise<void> {
		const wideColumns = 120;
		// A per-run budget (the sent-back scenario sets one) shows spend over the budget; without one, the spend alone.
		const spend = files.config().budget === undefined ? /\$0\.\d+/ : /\$0\.\d+\/\$0\.\d+/;
		const wide = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], columns: wideColumns, rows: 30, resume: resume.id, sessionDir: resume.dir });
		try {
			await readyForSubmission(wide);
			const before = files.runIds();
			const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"], as: "AsciiWide", say: `E2E-CHILD-DELAY 2500 ${readProbe}` }, { awaitChild: true }];
			const started = await wide.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
			const chips = await wide.seen(started, text => {
				const row = metricsRow(text, "ascii");
				return row && /\bAG\s*1\/1\b/.test(row) && spend.test(row) ? row : undefined;
			}, "the 120-column ASCII row with an active worker and spend", 20_000);
			const parts = chips.split(" - ");
			const result = parts[0]!;
			const loop = parts[1];
			const workers = parts[2];
			const cost = parts[3];
			const elapsed = parts[4];
			check(
				"the wider ASCII row leads with the result and keeps round, active workers and spend whole",
				result.startsWith(resultPrefix) &&
					/(?:(?:대기|진행 중|미충족|검토 가능) · )?이행 \d\/1$/.test(result.slice(resultPrefix.length)) &&
					loop === "loop 1라운드" &&
					workers === "AG 1/1" &&
					cost !== undefined && new RegExp(`^${spend.source}$`).test(cost) &&
					elapsed !== undefined && /^t: \d+분$/.test(elapsed),
				chips,
			);
			check(
				"the wider ASCII chips fit without Braille, emoji or a duplicated currency sign",
				Bun.stringWidth(chips) <= wideColumns && !/[\u2800-\u28ff≋↻👥💲⏱›]/u.test(chips) && !/\$\s+\$/.test(chips),
				chips,
			);
			await files.finishedRun(before, 30_000);
		} finally {
			await wide.close();
		}
	}

	const tui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], columns, rows: 30, resume: resume.id, sessionDir: resume.dir });
	let closed = false;
	try {
		await readyForSubmission(tui);
		const before = files.runIds();
		const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"], as: "Ascii", say: `E2E-CHILD-DELAY 2500 ${readProbe}` }, { awaitChild: true }];
		const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
		const displayed = await tui.seen(started, text => {
			const state = text.split("\n").findLast(line => line.includes("STORM") && line.includes(RUN_APPEARANCE.workers.label));
			const chips = text
				.split("\n")
				.map(line => line.trim())
				.findLast(line => line.startsWith(resultPrefix) && /(?:(?:대기|진행 중) · 이행 0\/1|이행 1\/1)$/.test(line));
			return state && chips ? { state: state.trim(), chips } : undefined;
		}, "the 60-column Storm phase and result-first ASCII status", 20_000);
		check(
			"the 60-column ASCII row proves the result focus and official state without clipping a lower-priority chip",
			displayed.chips.startsWith(resultPrefix) &&
				/(?:(?:대기|진행 중) · 이행 0\/1|이행 1\/1)$/.test(displayed.chips.slice(resultPrefix.length)),
			displayed.chips,
		);
		check(
			"the ASCII preset uses its own mark, phase and radar without Braille",
			displayed.state.startsWith(`~ STORM - ${RUN_APPEARANCE.workers.label}`) &&
				!/[\u2800-\u28ff]/u.test(displayed.state) &&
				/\[[ -~]{18}\]$/.test(displayed.state),
			`${displayed.state} / ${displayed.chips}`,
		);
		check("the measured ASCII rows fit the actual terminal", [displayed.state, displayed.chips].every(line => Bun.stringWidth(line) <= columns), displayed.chips);
		const run = await files.finishedRun(before, 30_000);
		check("the ASCII view run retains its answer and does not claim an unrun code check",
			run.results?.some(row => row.id === "impl-answer" && row.state === "accepted") === true && endsAsExpected(run, files), `${run.status} ${run.endReason}`);
		const status = await tui.submit("/storm status");
		await tui.shows(OVERLAY_HINT, status);
		const storage = await tui.press("4", text => text.includes("Storm 세션 데이터") || text.includes("저장 공간"), "the ASCII status storage tab");
		check("the ASCII tab uses the host's warning symbol, not a Unicode glyph", /\[!\][^\n]*(측정 불가|집계 누락|일부 누락)/.test(tui.text(storage)));
		tui.send(KEY.enter);
		await tui.close();
		closed = true;
		// The live chips do not fit behind this 60-column result; prove their ASCII values at a width that holds them.
		await asciiWideWorkerChips();
	} finally {
		if (!closed) await tui.close();
		writeFileSync(profile, original);
	}
}

/**
 * A scenario that needs the approved team the setup scenarios build. Run whole, the team is already there. Run alone
 * (`E2E_ONLY`) or after a failed setup, the team is approved through RPC on the same native session first, so one
 * scenario can be tried, and one failed screen does not take every later scenario down with it. The two setup
 * scenarios that edit models through the picker are not covered: they are the only ones that need each other.
 */
async function ensureApprovedTeam(): Promise<void> {
	if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
	const files = new StormFiles(env, ownedSession.id);
	if (existsSync(files.configFile) && files.approvals().length > 0) return;
	const rpc = new Rpc(env, cancelAll, { model: "fake/general-b", resume: ownedSession.id, sessionDir: ownedSession.dir });
	try {
		await rpc.ready();
		await approveTeam(rpc, "on");
	} finally {
		await rpc.close();
	}
}

const scenario = (name: string, body: () => Promise<void>, timeoutMs?: number): Promise<void> =>
	suite.step(name, async () => {
		await ensureApprovedTeam();
		await body();
	}, timeoutMs);

async function main(): Promise<void> {
	const outside = { id: OUTSIDE, cost: price(2, 8), context: 110_000, efforts: ["low", "high"] } as const;
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, { ...TEAM_PROVIDERS, fake: [...TEAM_PROVIDERS.fake, outside] }));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	for (const [name, content] of Object.entries({ "note.txt": "e2e note\n", "note2.txt": "e2e second note\n", "note3.txt": "e2e third note\n" })) writeFileSync(join(env.project, name), content);
	linkPlugin(env);

	// One real native session for the whole interactive suite: created through RPC so its id is public and its
	// transcript materialized, then resumed by every TUI scenario below. Storm's store for it starts empty.
	const seed = new Rpc(env, cancelAll, { model: "fake/general-b" });
	try {
		await seed.ready();
		await seed.turn(SESSION_SEED);
		await seed.identify();
		if (seed.sessionFile === undefined || !existsSync(seed.sessionFile)) throw new Error("the TUI fixture session wrote no transcript");
		ownedSession = { id: seed.sessionId, dir: seed.sessionDir };
	} finally {
		await seed.close();
	}

	await suite.step(
		"setup: edit the first recommendation, then approve",
		async () => {
			const llm = new LlmCursor(env);
			await session(async (tui, files) => {
				const typed = await tui.submit("/storm");
				const offered = await tui.selector(typed);
				check("the first team offers direct model editing before anything is saved", offered.includes(PICK_BY_ROLE) && offered.includes(DIRECT_MODEL) && !existsSync(files.configFile), JSON.stringify(offered));
				if (offered.includes(FULL_VIEW)) check("a clipped proposal withholds approval", !offered.includes(APPROVE));
				const slots = await tui.pick(offered, DIRECT_MODEL);
				const opened = await openExplorerPrimary(tui, slots);
				await tui.shows("Storm 모델 선택", opened, 15_000);
				const review = tui.send(KEY.enter);
				await tui.selector(review);
				check("picking a slot in setup still requires approval", !existsSync(files.configFile));
				// `answer` opens the full view when the panel is cut, so the disclosure is on screen either way.
				const approved = await answer(tui, review, APPROVE);
				check("the edited proposal still discloses that approval turns automatic delegation on", tui.text(review).includes(TURNS_AUTO_ON), tui.text(review).slice(-400));
				// Storm writes the approval and the config, then the personal choice the approval now implies.
				await suite.eventually("approve saves the config and one approval", () => existsSync(files.configFile) && files.approvals().length === 1, () => `approvals=${files.approvals().length}`);
				if (files.storeDir() === undefined) throw new Error("the approval store is missing");
				const deadline = Date.now() + 15_000;
				while (Date.now() < deadline && (await readAutoDelegationChoice(files.sessionDir)) !== "on") await Bun.sleep(50);
				check("the single team approval persisted automatic delegation on", (await readAutoDelegationChoice(files.sessionDir)) === "on", await readAutoDelegationChoice(files.sessionDir));
				check("no separate automatic-delegation prompt followed approval", !tui.text(approved).includes(OLD_PROMPT), tui.text(approved).slice(-400));
				// The composer answers rather than a hidden prompt taking the keys.
				const status = await tui.submit("/storm status");
				await tui.shows(OVERLAY_HINT, status);
				const report = tui.text(status);
				const heading = `${STORM_MARK} · ${IDLE.label} · v${STORM_VERSION}`;
				const head = report.indexOf(heading);
				check("the overview leads with the shared mark and idle state without listing role models", head >= 0 && !report.includes("역할별 모델"), report.slice(Math.max(0, head), Math.max(0, head) + 300));
				const team = await tui.press("2", text => text.includes("팀 설정") && text.includes("승인됨"), "the team tab after setup");
				check("the team tab shows the approved priority", tui.text(team).includes(`우선순위 ${priorityLabel(files.config().priority)}`), `priority=${files.config().priority}`);
				const workers = files.config().roles.implementer?.workers;
				check("the fresh team shows the implementer range without a duplicate team limit",
					typeof workers === "object" && workers.min === 1 && workers.max === 4 &&
					!Object.hasOwn(files.config(), "parallelism") && !tui.text(team).includes("병렬도"),
					tui.text(team).slice(-400));
				tui.send(KEY.enter);
				await suite.eventually("the calm idle footer names the approved team", () => idleFooter(statusLine(tui)), () => statusLine(tui) ?? "no status line");
				const calm = statusLine(tui);
				await Bun.sleep(500);
				check("the idle footer stays still", statusLine(tui) === calm, `${calm} → ${statusLine(tui)}`);
				check("no model request during setup", llm.all().filter(entry => entry.who !== "side").length === 0, `requests=${llm.all().length}`);
			});
		},
		180_000,
	);

	await suite.step(
		"setup: role pages with the native model picker and effort",
		async () => {
			if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
			const files = new StormFiles(env, ownedSession.id);
			const before = files.config();
			const approvals = files.approvals().length;
			const llm = new LlmCursor(env);
			await session(async (tui, files) => {
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
						await tui.press(OUTSIDE, text => text.includes(OUTSIDE) && pickerLevel(text) === "auto", "the native picker to find the outside model at its default");
						await stepEffort(tui, "off");
						await tui.press(KEY.enter, text => text.includes("Off는 Storm effort가 아닙니다"), "Off to be refused without leaving the native picker");
						await stepEffort(tui, "low");
						mark = tui.send(KEY.enter);
					}
					for (const [index, model] of models.entries()) {
						if ((explorer && index === 0) || model.effort === undefined) continue;
						mark = await submitForm(tui, mark, model.selector, 1);
					}
				}
				const settings = await submitForm(tui, mark, "예산", 6);
				await tui.selector(settings);
				check("role and effort pages don't save without approval", files.approvals().length === approvals && JSON.stringify(files.config()) === JSON.stringify(before));
				await answer(tui, settings, APPROVE);
				await suite.eventually("the selected model, its effort and worker limit are saved", () => {
					const role = files.config().roles.explorer;
					return role?.models[0] === `fake/${OUTSIDE}:low` && typeof role.workers === "object" && role.workers.max === 3 && files.approvals().length === approvals + 1;
				});
				check("the other roles keep their models", primary(files.config(), "implementer") === primary(before, "implementer"));
				check(
					"re-setup neither asks the automatic-delegation question nor turns it off",
					(await readAutoDelegationChoice(files.sessionDir)) === "on" && !tui.text(settings).includes(OLD_PROMPT),
					await readAutoDelegationChoice(files.sessionDir),
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

	await suite.step("setup: one approved Storm slot can change effort without walking the interview", async () => {
		await session(async (tui, files) => {
			const before = files.config();
			const approvals = files.approvals().length;
			const bytes = files.configBytes();
			const llm = new LlmCursor(env);
			const hub = await tui.submit("/storm");
			const chooseDirect = await pickMenuRow(tui, hub, "Storm 메뉴", DIRECT_MODEL);
			const openSlot = async (from: number, level: string): Promise<void> => {
				const opened = await openExplorerPrimary(tui, from);
				const slot = tui.text(from).split("\n").find(line => line.includes("탐색 · 주 모델") && line.includes(OUTSIDE));
				check("the model slot row carries its model and effective draft effort without a second list", slot !== undefined && slot.includes(level) && !tui.text(from).includes("지금 슬롯"), slot ?? tui.text(from).slice(-400));
				await tui.seen(
					opened,
					text => (text.includes("Storm 모델 선택") && text.includes(OUTSIDE) && pickerLevel(text) === level ? true : undefined),
					`the same model to be initially selected at ${level}`,
					15_000,
				);
			};
			await openSlot(chooseDirect, "low");
			await stepEffort(tui, "high");
			const cancelled = tui.send("\x1b");
			await openSlot(cancelled, "low");
			check("Escape returns to slot selection without writing the pending effort", files.configBytes() === bytes && files.approvals().length === approvals);
			await stepEffort(tui, "high");
			const firstDiff = tui.send(KEY.enter);
			const continued = await answer(tui, firstDiff, CONTINUE_EDITING);
			const diff = tui.text(firstDiff);
			check("the approval shows the old and new effort even though the model name did not change", diff.includes(`${OUTSIDE}:low`) && diff.includes(`${OUTSIDE}:high`));
			await openSlot(continued, "high");
			check("the in-memory draft keeps high while the approved file still has low", files.configBytes() === bytes);
			await answer(tui, tui.send(KEY.enter), APPROVE);
			await suite.eventually(
				"the one-slot effort is saved only after approval",
				() => files.config().roles.explorer?.models[0] === `fake/${OUTSIDE}:high` && files.approvals().length === approvals + 1,
			);
			const expected = structuredClone(before);
			expected.roles.explorer!.models[0] = `fake/${OUTSIDE}:high`;
			check("the other slots, roles and policies stay unchanged", JSON.stringify(files.config()) === JSON.stringify(expected));
			check("partial editing makes no model call", mains(llm.all()).length === 0);
			await tui.submit("Hello. No repository task.");
			const main = await until(() => mains(llm.all())[0], 15_000, "the next main provider request");
			check("the native picker never changed the main OMP model or effort", main.model === OUTSIDE && main.effort === "low", JSON.stringify(main));
		}, `fake/${OUTSIDE}`, ["--thinking", "low"]);
	}, 180_000);

	await scenario(
		"a plain request delivers a verified answer without file changes",
		async () => {
			const llm = new LlmCursor(env);
			await session(async (tui, files) => {
				const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"], as: "Impl", say: readProbe }];
				const run = await runOf(tui, files, `/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`, 150_000);
				check("one side turn routed it", llm.of("route").length === 1, `route=${llm.of("route").length}`);
				check("one turn, ended with accepted evidence", run.turns === 1 && run.endReason === "verified" && run.status === "done", `turns=${run.turns} ${run.endReason} ${run.status}`);
				check("its subagent ran on the approved model", run.spawns.length === 1 && run.spawns[0]?.outcome === "routed" && run.agents?.length === 1, JSON.stringify(run.spawns.map(spawn => spawn.outcome)));
				check("it ended once", files.index().filter(line => line.runId === run.runId).length === 1);
				await suite.eventually("the footer returns to its idle state after the run", () => idleFooter(statusLine(tui)), () => statusLine(tui) ?? "no status line", 30_000);
			});
		},
		240_000,
	);

	await scenario("a short clean automatic run leaves one factual line and registers no numbered choice", async () => {
		const llm = new LlmCursor(env);
		const columns = 60;
		const viewRows = 40;
		await session(async (tui, files) => {
			const scope = { name: "scope", kind: "explore", goal: "Locate the first input boundary", results: [trackedAnswer("scope-answer")] };
			const compare = { name: "compare", kind: "code", goal: "Compare the current evidence without changing files", results: [trackedAnswer("compare-answer")] };
			const setPlan = (...lanes: Array<typeof scope & { progress?: string }>): Step => ({ storm: { action: "plan", plan: { lanes } } });
			// A typed brief on a clean run under ten minutes: the draft is kept on disk, but the record is one factual
			// line. Neither the director's prose nor its directions become a card or a numbered offer.
			const brief = {
				result: "E2E-BRIEF-RESULT: the current comparison has one unresolved boundary.",
				verification: "E2E-BRIEF-EVIDENCE: two local records were compared.",
				remaining: "E2E-BRIEF-REMAINING: device latency was not measured.",
				next: [runNext("E2E-NEXT compare the missing boundary offline"), userNext("Measure the device latency yourself")],
			};
			const steps: Step[] = [
				setPlan(scope),
				{ task: ["storm-explorer"], as: "scope", say: readProbe },
				setPlan({ ...scope, goal: "Located the first input boundary (완료)" }, compare),
				setPlan({ ...scope, progress: "Located the first input boundary (완료)" }, compare),
				{ task: ["storm-implementer"], as: "compare", say: readProbe },
				{ storm: { action: "brief", brief } },
			];
			const before = files.runIds();
			await tui.submit(`E2E-STEPS ${b64(steps)}`);
			const run = await files.finishedRun(before, 60_000);
			// The saved record is the source of the proof line: the resumed session also repaints earlier runs' records,
			// and an earlier short clean run has its own one-line fact, so this run's row is found by this run's saved fact.
			const sessionFile = sessionFileIn(ownedSession!.dir, ownedSession!.id);
			const kept = await until(
				() => (sessionFile === undefined ? [] : persistedStormRecords(sessionFile)).filter(entry => entry.details?.runId === run.runId).at(-1),
				20_000,
				"this run's saved settled record",
			);
			const fact = closeoutBody(kept.text)[0]?.replace(/^[-*]\s+/, "") ?? "";
			// What a person sees, not the byte stream: the painted rows of the 60-column pty, replayed. The proof line is
			// found by its own saved text, once the idle footer is back so nothing else is still being drawn.
			// At 60 columns the fact fills the row and Storm's mark yields; wider, the row begins `Storm · `. Either is the same one row.
			const PROOF = /(?:^|\s)완료 · 필수 결과 이행 · /u;
			const ours = (row: string): boolean => fact !== "" && PROOF.test(row) && row.includes(fact);
			const view = (): string[] => tui.history();
			await until(() => (view().some(ours) && idleFooter(view().findLast(row => row.includes(STORM_MARK) && row.includes("대기"))?.trim()) ? true : undefined), 20_000, "the settled record and the idle footer on the screen");
			const screen = view();
			const at = screen.findIndex(ours);
			const record = screen[at] ?? "";
			const around = [screen[at - 1], screen[at + 1]];
			check(
				"the proof line is exactly one painted row at 60 columns: it fits, once, with nothing wrapped or stacked around it",
				screen.filter(ours).length === 1 && Bun.stringWidth(record) <= columns && /수용\s*2\/2/u.test(record) && around.every(row => row !== undefined && row.trim() === ""),
				`width=${Bun.stringWidth(record)} fact=${fact} rows=${JSON.stringify(screen.slice(Math.max(0, at - 1), at + 3))}`,
			);
			check(
				"the proof line has no frame, title bar or menu: no border character on its row or any row around it, and no card or director text anywhere on the screen",
				!/[│╭╮╰╯─┃┌┐└┘|]/u.test(`${screen[at - 1] ?? ""}${record}${screen[at + 1] ?? ""}`) &&
					screen.every(row => !(/[│╭╮╰╯┃|]/u.test(row) && /수용\s*\d|완료 ·|Storm 실행 결과/u.test(row))) &&
					screen.every(row => !/E2E-BRIEF-(?:RESULT|EVIDENCE|REMAINING)/.test(row) && !row.includes("추천") && !row.includes(CLOSEOUT_CHOICE_HINT) && !row.includes(CLOSEOUT_DETAIL) && !row.includes("직접:")) &&
					offeredDirections(screen.map(row => row.trim())).length === 0,
				JSON.stringify(screen.slice(Math.max(0, at - 2), at + 3)),
			);
			// The saved fact is the proof line's body; the fake model never said it, so it cannot be an echo of model text.
			check(
				"the painted row is the saved record itself, drawn by Storm, not text the model said",
				kept !== undefined && isOneLineCloseout(kept) && fact !== "" && record.includes(fact) &&
					!mains(llm.all()).some(entry => entry.lastTool.includes(fact) || entry.lastUser.includes(fact)),
				`row=${record} saved=${kept?.text ?? "no saved record"}`,
			);
			check("the typed draft is still kept on disk", JSON.stringify(run.closeout?.next ?? null) === JSON.stringify(brief.next), JSON.stringify(run.closeout ?? null));
			check(
				"updating progress preserves real completed coverage even though a changed goal was refused",
				run.endReason === "verified" && run.turns === 1 && run.spawns.filter(spawn => spawn.outcome === "routed").length === 2 &&
					run.plan?.lanes[0]?.goal === scope.goal && run.plan?.lanes[0]?.progress?.includes("(완료)") === true,
				`${run.status}/${run.endReason} in ${run.turns} turns`,
			);
			check("the director was told to leave an assigned goal alone", mains(llm.all()).some(entry => entry.lastTool.includes("계획 레인 'scope'") && entry.lastTool.includes("progress")));
			check("briefing itself neither starts a run nor uses a classifier", files.runIds().size === before.size + 1 && llm.of("route").length === 0);
			// No menu was registered, so a bare number is ordinary model input and dispatches nothing.
			const ordinary = new LlmCursor(env);
			const after = files.runIds().size;
			await tui.submit("1");
			await until(() => mains(ordinary.all()).find(entry => /(?:^|\n)1\s*$/.test(entry.lastUser)), 15_000, "a number after a one-line record");
			check("a number after the one-line record is ordinary model input and starts no run", files.runIds().size === after && ordinary.of("route").length === 0);
		}, "fake/general-b", [], { columns, rows: viewRows });
	}, 180_000);

	await scenario("an incomplete run keeps the whole card at 60 columns, and its first direction starts one related follow-up", async () => {
		if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
		const resume = ownedSession;
		const files = new StormFiles(env, resume.id);
		requireApprovedTeam(files, "the 60-column closeout card");
		const columns = 60;
		const changed = join(env.project, CARD_FILE);
		// The chosen direction is a typed `run` within the brief's task bound; inline JSON keeps it short. A review gate
		// is the compact authorized run that still proves the choice opens a real plan and spawns its worker.
		const chosen = `E2E-NEXT E2E-STEPS ${JSON.stringify([{ storm: { action: "plan", plan: { lanes: [{ name: "g", kind: "review" }] } } }, { task: ["storm-reviewer"], say: "E2E-CHILD-VERDICT correct" }])}`;
		if (chosen.length > CLOSEOUT_NEXT_MAX) throw new Error(`the chosen direction exceeds the brief bound: ${chosen.length} > ${CLOSEOUT_NEXT_MAX}`);
		const brief = {
			result: "E2E-CARD-RESULT: the change was written; no reviewer judged it.",
			verification: "E2E-CARD-EVIDENCE: only the child's own write was observed.",
			remaining: "E2E-CARD-REMAINING: the change still needs one review.",
			next: [runNext(chosen), userNext("E2E-CARD-USER keep or drop the change yourself")],
		};
		// The declared file change is accepted, but the run is still incomplete: no independent review was performed.
		const steps: Step[] = [
			{ storm: { action: "plan", plan: { lanes: [{ name: "impl", kind: "code", results: [{ id: "card-change", kind: "change", criterion: `the implementer wrote ${CARD_FILE}`, path: CARD_FILE, contains: "storm child change" }] }] } } },
			{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-WRITE ${CARD_FILE}` },
			{ storm: { action: "brief", brief } },
		];
		let card: RunRecord | undefined;
		const tui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], columns, rows: 40, resume: resume.id, sessionDir: resume.dir });
		try {
			await readyForSubmission(tui);
			const before = files.runIds();
			const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run", rounds: 2 })} E2E-STEPS ${b64(steps)}`);
			card = await files.finishedRun(before, 150_000);
			check("the accepted result does not certify an unreviewed run", card.status === "stopped" && card.endReason === "round-limit" && card.results?.some(row => row.id === "card-change" && row.state === "accepted") === true, `${card.status}/${card.endReason}`);
			const shown = await tui.seen(started, text => {
				const at = text.lastIndexOf(CLOSEOUT_HEADING);
				const tail = at < 0 ? "" : text.slice(at);
				return tail.includes(CLOSEOUT_DETAIL) && tail.includes("E2E-CARD-USER") ? tail : undefined;
			}, "the whole closeout card at 60 columns", 30_000);
			const rows = screenRows(shown);
			const region = rows.slice(0, rows.findIndex(row => row.includes(CLOSEOUT_DETAIL)) + 1);
			check("every card row fits 60 columns", region.length > 2 && cardRows(shown).every(row => Bun.stringWidth(row) <= columns), cardRows(shown).find(row => Bun.stringWidth(row) > columns) ?? `rows=${region.length}`);
			check(
				"the card distinguishes the accepted result from the unfinished run and the residual risk",
				// The header row may wrap at 60 columns (it names the spend), so the painted rows are read, not the byte stream.
				/수용\s*1\/1/u.test(region.join(" ")) && region.some(row => row.includes("주의") && row.includes("검증되지 않은")),
				region.join("\n"),
			);
			const sessionFile = sessionFileIn(resume.dir, resume.id);
			const savedOf = (): StormRecord[] => (sessionFile === undefined ? [] : persistedStormRecords(sessionFile).filter(record => record.details?.runId === card!.runId));
			const saved = await until(() => (savedOf().length > 0 ? savedOf() : undefined), 10_000, "the closeout in the session file").catch(() => savedOf());
			check(
				"the closed-out run is one saved message that carries the director's bounded text",
				saved.length === 1 && saved[0]!.text.includes("E2E-CARD-RESULT") && saved[0]!.text.includes("E2E-CARD-REMAINING") && shown.includes("E2E-CARD-RESULT"),
				`file=${sessionFile ?? "missing"} saved=${saved.length} ${saved.map(record => record.text.slice(0, 120)).join(" | ")}`,
			);
			check("verification prose moved to the status view", !shown.includes("E2E-CARD-EVIDENCE"), region.join("\n"));
			const offers = numberedOffers(region);
			check(
				"the proposed run is offered first as the recommendation; the user-owned step is never numbered",
				offers.length >= 1 && offers.length <= 3 && /^1\.\s*추천/u.test(offers[0] ?? "") && !offers.some(offer => offer.includes("E2E-CARD-USER")) && region.some(row => row.includes("직접:")),
				region.join("\n"),
			);
			// Settling makes no model call of its own: nothing reaches the provider until the user types.
			const quiet = new LlmCursor(env);
			await Bun.sleep(1_500);
			check("settling the run asked the model nothing more", quiet.all().length === 0, JSON.stringify(quiet.all().map(entry => [entry.who, entry.lastUser.slice(0, 80)])));

			const picked = new LlmCursor(env);
			const withCard = files.runIds();
			await tui.submit("1");
			const followUp = await files.finishedRun(withCard, 120_000);
			check(
				"the first direction starts one new authorized run that names its source and is not a resume",
				followUp.task.startsWith("E2E-NEXT") && followUp.followUpOf === card.runId && followUp.resumeOf === undefined && followUp.spawns.some(spawn => spawn.outcome === "routed"),
				`task=${followUp.task.slice(0, 40)} followUpOf=${followUp.followUpOf} resumeOf=${followUp.resumeOf}`,
			);
			check("the choice used no classifier side turn", picked.of("route").length === 0);
			const handoff = mains(picked.all()).map(entry => entry.lastUser).find(user => user.includes(`<storm-run id="${followUp.runId}"`)) ?? "";
			check(
				"only that related handoff carries the earlier run's bounded final facts, without its verification prose",
				handoff.split(card.runId).length === 2 && handoff.includes("E2E-CARD-RESULT") && !handoff.includes("E2E-CARD-EVIDENCE"),
				handoff.slice(0, 1600),
			);
			cardRunId = card.runId;
		} finally {
			await tui.close();
			rmSync(changed, { force: true });
		}

		// A restart draws the persisted record again (rich, or as its readable plain text) but restores no choice.
		const again = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], columns, rows: 40, resume: resume.id, sessionDir: resume.dir });
		try {
			await readyForSubmission(again);
			const replay = await again.seen(0, text => text.split(CLOSEOUT_HEADING).findLast(part => {
				const body = cardRows(part).join("\n");
				return body.includes("감독 설명: E2E-CARD-RESULT") && body.includes(CLOSEOUT_DETAIL);
			}), "the structured closeout card drawn again after a restart", 30_000);
			check(
				"after a restart the card is readable again within 60 columns",
				cardRows(replay).some(row => row.includes("E2E-CARD-USER")) && cardRows(replay).every(row => Bun.stringWidth(row) <= columns),
				screenRows(replay).slice(0, 16).join("\n"),
			);
			const runs = files.runIds().size;
			const ordinary = new LlmCursor(env);
			await again.submit("1");
			await until(() => mains(ordinary.all()).find(entry => /(?:^|\n)1\s*$/.test(entry.lastUser)), 20_000, "a number after the restart");
			check("a restart restores no numbered choice: the number is model input and starts no run", files.runIds().size === runs && ordinary.of("route").length === 0);
		} finally {
			await again.close();
		}
	}, 360_000);

	await scenario("a numbered resume carries the goal's totals onto its card, and a direction picked after it starts a new goal", async () => {
		if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
		const resume = ownedSession;
		const files = new StormFiles(env, resume.id);
		requireApprovedTeam(files, "the goal totals across a numbered resume");
		const changed = join(env.project, GOAL_FILE);
		const marker = "E2E-GNXT";
		const chosen = `${marker} E2E-STEPS ${JSON.stringify([{ storm: { action: "plan", plan: { lanes: [{ name: "g", kind: "review" }] } } }, { task: ["storm-reviewer"], say: "E2E-CHILD-VERDICT correct" }])}`;
		if (chosen.length > CLOSEOUT_NEXT_MAX) throw new Error(`the chosen direction exceeds the brief bound: ${chosen.length} > ${CLOSEOUT_NEXT_MAX}`);
		// The change is never reviewed, so each run of the goal stops at its round limit with a whole card that offers the
		// recorded resume and the director's new direction. A resume replays the same request, so its card offers both again.
		const brief = {
			result: "E2E-GOAL-RESULT: the change was written; no reviewer judged it.",
			verification: "E2E-GOAL-EVIDENCE: only the child's own write was observed.",
			remaining: "E2E-GOAL-REMAINING: the change still needs one review.",
			next: [RESUME_NEXT, runNext(chosen)],
		};
		const steps: Step[] = [
			{ storm: { action: "plan", plan: { lanes: [{ name: "impl", kind: "code", results: [{ id: "goal-change", kind: "change", criterion: `the implementer wrote ${GOAL_FILE}`, path: GOAL_FILE, contains: "storm child change" }] }] } } },
			{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-WRITE ${GOAL_FILE}` },
			{ storm: { action: "brief", brief } },
		];
		/** The newest whole card painted since `from`, once `ready` holds for it. */
		const cardSince = (tui: Tui, from: number, ready: (tail: string) => boolean, what: string): Promise<string> =>
			tui.seen(from, text => {
				const at = text.lastIndexOf(CLOSEOUT_HEADING);
				const tail = at < 0 ? "" : text.slice(at);
				return tail.includes(CLOSEOUT_DETAIL) && ready(tail) ? tail : undefined;
			}, what, 60_000);
		/** The number of the first offer on `card` that `pick` accepts. */
		const numberOf = (card: string, pick: (offer: string) => boolean): string | undefined => {
			const rows = screenRows(card);
			const offers = numberedOffers(rows.slice(0, rows.findIndex(row => row.includes(CLOSEOUT_DETAIL)) + 1));
			return offers.find(pick)?.match(/[1-9]/)?.[0];
		};
		const savedText = (runId: string): string => {
			const sessionFile = sessionFileIn(resume.dir, resume.id);
			return (sessionFile === undefined ? [] : persistedStormRecords(sessionFile)).filter(record => record.details?.runId === runId).map(record => record.text).join("\n");
		};
		const span = (run: RunRecord): number => Date.parse(run.endedAt ?? "") - Date.parse(run.startedAt);
		const tui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], resume: resume.id, sessionDir: resume.dir });
		try {
			await readyForSubmission(tui);
			const before = files.runIds();
			const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run", rounds: 2 })} E2E-STEPS ${b64(steps)}`);
			const fresh = await files.finishedRun(before, 150_000);
			const freshCard = await cardSince(tui, started, tail => tail.includes("E2E-GOAL-RESULT"), "the fresh run's whole card");
			check(
				"a fresh run has no goal and its card draws no goal line",
				fresh.status === "stopped" && fresh.endReason === "round-limit" && fresh.goal === undefined && !freshCard.includes(GOAL_LABEL),
				`${fresh.status}/${fresh.endReason} goal=${JSON.stringify(fresh.goal ?? null)} ${screenRows(freshCard).join("\n")}`,
			);
			const resumeNumber = numberOf(freshCard, offer => !offer.includes(marker));
			if (resumeNumber === undefined) throw new Error(`the fresh card offers no resume: ${screenRows(freshCard).join(" | ")}`);
			const withFresh = files.runIds();
			const picked = await tui.submit(resumeNumber);
			const resumed = await files.finishedRun(withFresh, 150_000);
			const expected = goalText({ runs: 2, usd: fresh.costUsd + resumed.costUsd, ms: span(fresh) + span(resumed), turns: (fresh.turns ?? 0) + (resumed.turns ?? 0) });
			check(
				"the numbered resume carries the fresh run's cost, time and rounds",
				resumed.resumeOf === fresh.runId && resumed.followUpOf === undefined && resumed.goal?.firstRunId === fresh.runId && resumed.goal.runs === 1 &&
					resumed.goal.usd === fresh.costUsd && resumed.goal.ms === span(fresh) && resumed.goal.turns === fresh.turns,
				`resumeOf=${resumed.resumeOf} goal=${JSON.stringify(resumed.goal ?? null)} fresh=${fresh.costUsd}/${span(fresh)}/${fresh.turns}`,
			);
			const resumedCard = await cardSince(tui, picked, tail => tail.includes("E2E-GOAL-RESULT") && tail.includes(GOAL_LABEL), "the resumed run's card with its goal line");
			check(
				"the resumed run's painted card and its saved record show both runs' totals",
				expected !== undefined && resumedCard.includes(`${GOAL_LABEL}: ${expected}`) && savedText(resumed.runId).includes(`${GOAL_LABEL}: ${expected}`),
				`expected=${expected} ${screenRows(resumedCard).join("\n")}`,
			);
			const directionNumber = numberOf(resumedCard, offer => offer.includes(marker));
			if (directionNumber === undefined) throw new Error(`the resumed card offers no direction: ${screenRows(resumedCard).join(" | ")}`);
			const withResumed = files.runIds();
			await tui.submit(directionNumber);
			const followUp = await files.finishedRun(withResumed, 120_000);
			const saved = await until(() => savedText(followUp.runId) || undefined, 20_000, "the follow-up's settled record").catch(() => "");
			check(
				"a direction picked after the resume is a new goal: no carry, no goal line",
				followUp.followUpOf === resumed.runId && followUp.resumeOf === undefined && followUp.goal === undefined && saved !== "" && !saved.includes(GOAL_LABEL),
				`followUpOf=${followUp.followUpOf} resumeOf=${followUp.resumeOf} goal=${JSON.stringify(followUp.goal ?? null)} saved=${saved.slice(0, 400)}`,
			);
		} finally {
			await tui.close();
			rmSync(changed, { force: true });
		}
	}, 420_000);

	await scenario(
		"a native ask pauses the run and its answer resumes it",
		async () => {
			const llm = new LlmCursor(env);
			await session(async (tui, files) => {
				const steps: Step[] = [plan("scan", "explore"), { ask: ASK_FORM }, { task: ["storm-explorer"], as: "Scan", say: `E2E-CHILD-DELAY 1200 ${readProbe}` }, { awaitChild: true }];
				const before = files.runIds();
				const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
				await tui.seen(
					started,
					text =>
						text.includes(phaseHeader("waiting-user")) &&
						text.includes("E2E-QUESTION") &&
						text.includes("E2E-ANSWER") &&
						text.includes("Submit")
							? true
							: undefined,
					"the native ask while the run waits",
					60_000,
				);
				const shown = tui.text(started);
				const askAt = shown.lastIndexOf("E2E 확인");
				const askPanel = askAt >= 0 ? shown.slice(askAt) : shown;
				check("the live widget shows the waiting phase", shown.includes(phaseHeader("waiting-user")), shown.slice(-500));
				check(
					"the ask is omp's native form with a named control",
					shown.includes("Ask") && askPanel.includes("E2E-QUESTION") && askPanel.includes("E2E-ANSWER"),
					askPanel.slice(-600),
				);
				check("the native ask offers Submit", askPanel.includes("Submit"), askPanel.slice(-600));
				check(
					"waiting for the user shows the lane view under a status row that has no radar field",
					trunkFrames(shown).size >= 1 && radarFrames(shown, "waiting-user").size === 0,
					`trunk=${trunkFrames(shown).size} radar=${radarFrames(shown, "waiting-user").size}`,
				);
				const live = await until(() => files.runs().find(run => !before.has(run.runId) && run.status === "running"), 20_000, "the asked run to be active");
				await tui.press(ASK_ANSWER, text => text.includes(ASK_ANSWER), "the ask control to show the answer");
				/** The exact answer as the fake provider saw it, not merely text left in the form. */
				const answerArrived = (): boolean =>
					mains(llm.all()).some(entry => entry.lastTool.includes("e2e-answer") && entry.lastTool.includes(ASK_ANSWER));
				/** The Ask result card the host adds once the answer was submitted (check glyph differs by version). */
				const answerResult = (text: string): boolean => text.includes(`✔ ${ASK_ANSWER}`) || text.includes(`✓ ${ASK_ANSWER}`);
				// One host focuses Submit on the first Enter; another submits on it. Wait for whichever actually happened,
				// then send the second Enter only when the form still shows Submit focused.
				const first = tui.send(KEY.enter);
				const outcome = await until(
					() => {
						const text = tui.text(first);
						if (answerArrived() || answerResult(text)) return "submitted" as const;
						if (focused(text) === "Submit") return "focus" as const;
						return undefined;
					},
					60_000,
					"the ask to focus Submit or submit",
				);
				if (outcome === "focus") {
					// Give the submit-on-first-Enter path one local provider round before pressing again.
					const grace = Date.now() + 1_500;
					let submitted = false;
					while (!submitted && Date.now() < grace) {
						await Bun.sleep(50);
						submitted = answerArrived() || answerResult(tui.text(first));
					}
					if (!submitted) tui.send(KEY.enter);
				}
				const frames = await tui.seen(
					first,
					text => {
						const rows = trunkFrames(text);
						return rows.size >= 2 && phaseRow(text, "workers") !== undefined ? rows : undefined;
					},
					"the answered run to resume with at least two distinct frames of the lane view's trunk",
					15_000,
				);
				console.log(`     real trunk frames: ${frames.size}`);
				await until(answerArrived, 30_000, "the named answer to reach the director");
				const run = await files.finishedRun(before, 150_000);
				check("the answer resumed the same run", run.runId === live.runId && run.status !== "running", `${run.runId} vs ${live.runId} ${run.status}`);
				const unrelated = mains(llm.all()).map(entry => entry.lastUser).find(user => user.includes(`<storm-run id="${run.runId}"`)) ?? "";
				check(
					"an unrelated new run's handoff carries no earlier run's final facts",
					run.followUpOf === undefined && run.resumeOf === undefined && unrelated !== "" && !unrelated.includes("E2E-CARD-RESULT") && (cardRunId === undefined || !unrelated.includes(cardRunId)),
					unrelated.slice(0, 800),
				);
				check("the answered run verifies its result after one round", run.endReason === "verified" && run.turns === 1, `${run.status} ${run.endReason} turns=${run.turns}`);
				await suite.eventually("the footer returns after the answered run", () => idleFooter(statusLine(tui)), () => statusLine(tui) ?? "no status line", 30_000);
			});
		},
		180_000,
	);

	await scenario(
		"a run is sent back until its changes are reviewed",
		async () => {
			if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
			const changed = join(env.project, "e2e-rounded.txt");
			const llm = new LlmCursor(env);
			const files = new StormFiles(env, ownedSession.id);
			const approvals = files.approvals().length;
			files.editConfig(config => {
				config.budget = { perRunUsd: 0.01, onExceed: "block-spawns" };
				// A real required check, not a test hook: it holds the verifying phase long enough to see it.
				config.requiredChecks = [{ name: "e2e-verify-hold", argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 4000)"] }];
			});
			try {
				await session(async (tui, files) => {
					await answer(tui, await tui.submit("/storm"), APPROVE);
					await suite.eventually(
						"the budget and the required check are approved",
						() => files.approvals().length === approvals + 1,
						() => `approvals=${files.approvals().length}`,
						30_000,
					);
					const steps: Step[] = [
						{
							storm: {
								action: "plan",
								plan: {
									lanes: [
										{
											name: "impl",
											kind: "code",
											results: [{ id: "impl-change", kind: "change", criterion: "the implementer wrote the change under review", path: "e2e-rounded.txt", contains: "storm child change" }],
										},
										// A final review gate judges the integrated tree and owes no separate result of its own.
										{ name: "review", kind: "review" },
									],
								},
							},
						},
						{ task: ["storm-implementer"], as: "Impl", say: "E2E-CHILD-WRITE e2e-rounded.txt" },
						{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
					];
					const before = files.runIds();
					const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
					await suite.eventually(
						"the live widget shows the lane view and a fixed row with the round and budget",
						() => {
							const painted = tui.text(started);
							const numbers = metricsRow(painted);
							return numbers !== undefined && numbers.includes("💲") && numbers.includes("0.01") && trunkFrames(painted).size !== 0;
						},
						() => "",
						30_000,
					);
					const verifying = await tui.seen(
						started,
						text => (phaseRow(text, "verifying") !== undefined ? text : undefined),
						"the verifying phase while the real required check runs",
						120_000,
					);
					const currentCheck = "e2e-verify-hold passed(0)";
					check("verification in flight does not display this run's final evidence", !verifying.includes(currentCheck));
					const run = await files.finishedRun(before, 240_000);
					const completed = await tui.seen(started, text => text.split("\n").findLast(row => row.includes("Storm ·") && /수용\s*1\/1/u.test(row)),
						"the settled record of the verified run", 20_000);
					// Short and verified: one factual line. The check evidence is status detail (asserted on the overview below).
					check(
						"the verified run's record is one factual line without check receipts or a menu",
						completed.includes(STATUS_DONE) && !completed.includes(currentCheck) && !completed.includes(CLOSEOUT_DETAIL) && offeredDirections(screenRows(completed)).length === 0,
						completed.slice(0, 500),
					);
					await suite.eventually(
						"the status line returns to idle after the run",
						() => idleFooter(statusLine(tui)),
						() => statusLine(tui) ?? "no status line",
						60_000,
					);
					const roundTag = `<storm-run id="${run.runId}" round="2">`;
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
					check(
						"the real required check ran and passed under the verifying phase",
						run.checks?.some(evidence => evidence.name === "e2e-verify-hold" && evidence.status === "passed") === true,
						JSON.stringify(run.checks),
					);
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
					const heading = `${STORM_MARK} · ${IDLE.label} · v${STORM_VERSION}`;
					const head = top.indexOf(heading);
					check("the overview leads with the shared state and last run, without the team detail", head >= 0 && top.includes("마지막 실행") && !top.includes("역할별 모델"), top.slice(0, 300));
					check("the budget amount and partially filled meter are visible together", top.includes("$0.01") && top.includes(run.runId) && /█+░+/.test(top));
					check("the required check's evidence lives on the status overview", /e2e-verify-hold[^\n]*통과/u.test(top), top.slice(0, 1200));
					const team = await tui.press("2", text => text.includes("팀 설정") && text.includes("승인됨"), "team tab with the approved configuration");
					check("the team tab keeps the approved priority and roles", tui.text(team).includes(`우선순위 ${priorityLabel(files.config().priority)}`));
					const overview = await tui.press("\x1b[D", text => text.includes("마지막 실행"), "Left to return to the overview");
					check("overview takes no focus away from the report", tui.text(overview).includes(run.runId));
					tui.send(KEY.enter);
					await suite.eventually("the footer returns to idle after the status report", () => idleFooter(statusLine(tui)), () => statusLine(tui) ?? "no status line", 30_000);
				});
			} finally {
				rmSync(changed, { force: true });
			}
		},
		300_000,
	);

	await scenario(
		"the lane view follows a real run with several lanes: as tall as it draws, a usable editor, lane states, the switch",
		async () => {
			const [origin, api, ui] = ["origin", "api-verify", "ui-preview"] as const;
			const view = { columns: 120, rows: 36 };
			// The status row, the trunk and one row per lane: three lanes, well under the cap.
			const drawn = 2 + 3;
			const answerResult = (id: string, criterion: string): Record<string, unknown> => ({ id, kind: "answer", criterion, path: FACT_FILE, contains: FACT_LINE });
			const retryRelease = "release-lane-view-retry";
			const steps: Step[] = [
				{
					storm: {
						action: "plan",
						plan: {
							lanes: [
								{ name: origin, kind: "explore", role: "explorer", results: [answerResult("origin-count", "원본 행 수")] },
								{ name: api, kind: "explore", role: "explorer", results: [answerResult("api-check", "API 검증")] },
								{ name: ui, kind: "explore", role: "explorer", results: [answerResult("ui-preview", "UI 미리보기")] },
							],
						},
					},
				},
				{ tasks: [{ name: origin, agent: "storm-explorer", task: "Report the original line from source", say: readProbe }] },
				{ wait: true },
				// No source citation and a long delay: the lane runs for a while, then settles genuinely unmet.
				{ tasks: [{ name: api, agent: "storm-explorer", task: "Verify the API criterion from source", say: "E2E-CHILD-DELAY 15000 E2E-CHILD-CLAIM not verified yet" }] },
				{ wait: true },
				{
					followUp: `agent://@${api}`,
					content: `Retry the failed API verification against source. ${readProbe}`,
					after: 'action="retry"',
					releaseFile: { name: retryRelease, receipt: "not verified yet" },
				},
				{ wait: true },
			];
			const owned = await seedOwnSession("Storm lane view fixture transcript.");
			const laneTui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "full"], resume: owned.id, sessionDir: owned.dir, ...view });
			try {
				await laneTui.ready();
				await laneTui.shows("Storm lane view fixture transcript.");
				await (async (tui: Tui, files: StormFiles): Promise<void> => {
					const before = files.runIds();
					const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
					const run = await until(
						() => files.runs().find(candidate => !before.has(candidate.runId) && candidate.status === "running" && candidate.plan?.lanes.length === 3),
						60_000,
						"the run with three lanes to be bound",
					);
					await tui.seen(started, text => ([origin, api, ui].every(lane => laneSequence(text, lane).length > 0) ? true : undefined), "a lane view row for each of the three lanes", 30_000);
					// Every sample of the lane view: where its status row sits, how many rows it draws, how many blanks are under it.
					const seen: Array<{ status: number; rows: number; blankUnder: number }> = [];
					const sample = (): LiveScreen | undefined => {
						const screen = liveScreen(tui);
						if (screen?.lanes) seen.push({ status: screen.status, rows: screen.rows.length, blankUnder: screen.blankUnder });
						return screen;
					};
					const first = await until(() => sample(), 20_000, "the live widget on the screen");
					check("the lane view sits under the editor: status row, trunk, then one row per lane", first.lanes && [origin, api, ui].every(lane => first.rows.some(row => row.trim().startsWith(`${lane} `))), first.rows.join("\n"));
					check(
						"the view is as tall as what it draws, within the cap, and every row fits the terminal",
						first.rows.length === drawn && first.rows.length <= laneHeight(view.rows) && first.viewport.every(row => Bun.stringWidth(row) <= view.columns),
						`rows=${first.rows.length} drawn=${drawn} cap=${laneHeight(view.rows)} status=${first.status} screen=${first.viewport.length}`,
					);
					check(
						"no blank row under the last lane: the last lane is the bottom row of the screen",
						first.blankUnder === 0 && (first.viewport.at(-1) ?? "").trim() !== "",
						`blank rows under the view: ${first.blankUnder}\n${first.viewport.slice(first.status).join("\n")}`,
					);
					const lead = trunkFrames(tui.text(started));
					await suite.eventually("the trunk moves: two distinct frames", () => trunkFrames(tui.text(started)).size >= Math.max(2, lead.size), () => `frames=${trunkFrames(tui.text(started)).size}`, 15_000);

					// The editor stays usable while the view animates: typed text appears above the status row, and goes again.
					const typed = "lane-view-typing";
					tui.send(typed);
					const above = await until(() => {
						const screen = sample();
						return screen !== undefined && screen.viewport.slice(0, screen.status).some(row => row.includes(typed)) ? screen : undefined;
					}, 15_000, "the typed text in the editor above the live widget");
					check("typing in the editor works and the widget did not move", above.status === first.status, `${above.status} vs ${first.status}`);
					tui.send("\x7f".repeat(typed.length));
					await until(() => {
						const screen = sample();
						return screen !== undefined && !screen.viewport.some(row => row.includes(typed)) ? true : undefined;
					}, 15_000, "the typed text to be erased");

					// The independent lane settles first; the API lane is the one running a long time.
					await until(() => {
						const current = files.run(run.runId);
						return current?.results?.find(row => row.id === "origin-count")?.state === "accepted" ? true : undefined;
					}, 60_000, "the origin result to be accepted");
					// How late the picture shows what the record already says: what is painted after the record changed.
					const acceptedAt = Date.now();
					await until(() => (shownState(tui, origin) === "accepted" ? true : undefined), 20_000, "the origin lane to show accepted");
					const acceptedLag = Date.now() - acceptedAt;
					await tui.seen(started, text => (laneSequence(text, api).includes("running") ? true : undefined), "the api lane to show running", 20_000);

					// `/storm view` turns the picture into the single line, in the same place, and back.
					await tui.submit("/storm view");
					const single = await until(() => {
						const screen = sample();
						return screen !== undefined && !screen.lanes && RADAR_FIELD.test(screen.rows[0] ?? "") ? screen : undefined;
					}, 20_000, "the single line with its radar after /storm view");
					check(
						"the switch leaves the single line as tall as it is, at the bottom, with nothing blank under it",
						single.rows.length === 2 && single.blankUnder === 0 && single.status === single.viewport.length - 2,
						`${single.status} of ${single.viewport.length}, ${single.blankUnder} blank under: ${single.rows.join(" | ")}`,
					);
					await tui.submit("/storm view");
					const back = await until(() => {
						const screen = sample();
						return screen?.lanes === true ? screen : undefined;
					}, 20_000, "the lane view back after the second /storm view");
					check("switching it on again restores the picture at its own size", back.status === first.status && back.blankUnder === 0 && [origin, api, ui].every(lane => back.rows.some(row => row.trim().startsWith(`${lane} `))), `${back.status} vs ${first.status}`);

					// The user's two inputs: the unstarted lane leaves the plan, the unmet one is retried.
					await tui.submit("UI는 빼고 API만 계속해");
					await tui.seen(started, text => (laneSequence(text, ui).includes("excluded") ? true : undefined), "the ui lane to show excluded", 30_000);
					await until(() => (files.run(run.runId)?.results?.find(row => row.id === "api-check")?.state === "unmet" ? true : undefined), 60_000, "the api result to settle unmet");
					const unmetAt = Date.now();
					await until(() => (shownState(tui, api) === "unmet" ? true : undefined), 20_000, "the api lane to show unmet");
					const unmetLag = Date.now() - unmetAt;
					console.log(`     the view followed the record: accepted after ${acceptedLag} ms, unmet after ${unmetLag} ms`);
					check("a change in the record reaches the view within the controller's 2 s refresh and a repaint", acceptedLag <= 4_000 && unmetLag <= 4_000, `${acceptedLag} ms, ${unmetLag} ms`);
					sample();
					await tui.submit("실패한 API 검증만 다시 해");
					await until(() => (files.run(run.runId)?.adjustments?.some(entry => entry.kind === "retry" && entry.id === "api-check") ? true : undefined), 20_000, "the retry request");
					writeFileSync(join(env.work, retryRelease), "");
					await tui.seen(started, text => (inOrder(laneSequence(text, api), ["running", "unmet", "running", "accepted"]) ? true : undefined), "the api lane to run, fail, retry and be accepted on the view", 90_000);
					sample();
					const finished = await files.finishedRun(before, 120_000);
					const painted = tui.text(started);
					check("the independent lane went to accepted and the excluded lane ended excluded", laneSequence(painted, origin).at(-1) === "accepted" && laneSequence(painted, ui).at(-1) === "excluded", `${laneSequence(painted, origin)} / ${laneSequence(painted, ui)}`);
					check("the retry reads on the view as unmet then running again", inOrder(laneSequence(painted, api), ["running", "unmet", "running", "accepted"]), laneSequence(painted, api).join(" > "));
					// The excluded lane leaves the plan, so the picture loses a row then: its status row moves by exactly that and no
					// other time (typing, the switch and the retry never moved it), and nothing blank is ever under it.
					const sizes = new Map<number, Set<number>>();
					for (const entry of seen) sizes.set(entry.rows, (sizes.get(entry.rows) ?? new Set<number>()).add(entry.status));
					check(
						"the picture moves only when its row count does, and never has a blank row under it",
						seen.length > 0 && seen.every(entry => entry.blankUnder === 0) && [...sizes.values()].every(statuses => statuses.size === 1),
						JSON.stringify([...sizes].map(([rows, statuses]) => [rows, [...statuses]])),
					);
					check("the run ended accepted for every in-scope result", finished.results?.every(row => row.state === "accepted" || row.scope === "excluded-by-user") === true, JSON.stringify(finished.results?.map(row => [row.id, row.state])));
					await suite.eventually("the footer returns to idle after the run", () => idleFooter(statusLine(tui)), () => statusLine(tui) ?? "no status line", 60_000);
					check("the lane view is gone after the run", liveScreen(tui) === undefined || !liveScreen(tui)!.lanes);
				})(laneTui, new StormFiles(env, owned.id));
			} finally {
				await laneTui.close();
			}
		},
		420_000,
	);

	await scenario(
		"the lane view shows the review of submitted answers: submitted, then reviewing on the lanes judged",
		async () => {
			const seedText = "Storm lane view review fixture transcript.";
			const owned = await seedOwnSession(seedText);
			const source = "report.json";
			writeFileSync(join(env.project, source), '{\n  "total": 42,\n  "source": "user owning this file"\n}\n');
			const claim = `The ${source} source field says a user owns this file, so Storm must leave its figures untouched (${source}:3)`;
			const answerResult = (id: string): Record<string, unknown> => ({ id, kind: "answer", criterion: `The answer explains ${id} from ${source}; an independent reviewer judges the prose.`, path: source });
			const steps: Step[] = [
				{
					storm: {
						action: "plan",
						plan: {
							lanes: [
								{ name: "explain-a", kind: "explore", role: "explorer", goal: "Explain a", results: [answerResult("a-answer")] },
								{ name: "explain-b", kind: "explore", role: "explorer", goal: "Explain b", results: [answerResult("b-answer")] },
								// A review gate that declares no dependency is the director's batch review of every submitted answer.
								{ name: "review", kind: "review", goal: "Judge the answers" },
							],
						},
					},
				},
				{
					tasks: [
						{ name: "explain-a", agent: "storm-explorer", task: "Explain a", say: `E2E-CHILD-READ ${source} E2E-CHILD-CLAIM ${claim}` },
						{ name: "explain-b", agent: "storm-explorer", task: "Explain b", say: `E2E-CHILD-READ ${source} E2E-CHILD-CLAIM ${claim}` },
					],
				},
				// Held until Storm says answers wait for review; the delay keeps the review on the screen long enough to see.
				{ task: ["storm-reviewer"], as: "Judge", say: "E2E-CHILD-DELAY 6000 E2E-CHILD-ANSWER-VERDICT-ALL correct", after: "waiting for review" },
			];
			const tui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "full"], resume: owned.id, sessionDir: owned.dir, columns: 120, rows: 36 });
			try {
				await tui.ready();
				await tui.shows(seedText);
				const files = new StormFiles(env, owned.id);
				const before = files.runIds();
				const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
				const run = await files.finishedRun(before, 120_000);
				const painted = tui.text(started);
				// The widget goes with the run, so the verdict that ends it may never be painted: the record says accepted, below.
				const expected: LaneState[] = ["submitted", "reviewing"];
				for (const lane of ["explain-a", "explain-b"]) {
					check(`${lane} reads submitted, then reviewing on the view`, inOrder(laneSequence(painted, lane), expected), laneSequence(painted, lane).join(" > "));
				}
				check("the review gate's own lane runs while it judges", laneSequence(painted, "review").includes("running"), laneSequence(painted, "review").join(" > "));
				check("the run verified both answers", run.endReason === "verified" && run.results?.every(row => row.state === "accepted") === true, `${run.status} ${run.endReason}`);
			} finally {
				await tui.close();
			}
		},
		240_000,
	);

	await scenario(
		"the lane view is as tall as its lanes and no taller: nothing blank under it at 120x50 and 80x24, past the cap it folds",
		async () => {
			const owned = await seedOwnSession("Storm lane view fit fixture transcript.");
			const answerResult = (id: string): Record<string, unknown> => ({ id, kind: "answer", criterion: `report ${id}`, path: FACT_FILE, contains: FACT_LINE });
			// `started` lanes get a worker that is held for a while; the rest stay planned, so the view has every lane to draw.
			const fit = async (columns: number, rows: number, laneCount: number): Promise<void> => {
				const named = (name: string): string => `${columns}x${rows}, ${laneCount} lanes: ${name}`;
				// Lane names are unique per call: a worker name from an earlier run of this session may not be reused.
				const names = Array.from({ length: laneCount }, (_, at) => `fit${columns}-${at + 1}`);
				const steps: Step[] = [
					{ storm: { action: "plan", plan: { lanes: names.map(name => ({ name, kind: "explore", role: "explorer", results: [answerResult(`${name}-r`)] })) } } },
					{ tasks: names.slice(0, 2).map(name => ({ name, agent: "storm-explorer", task: `Report ${name} from source`, say: `E2E-CHILD-DELAY 8000 ${readProbe}` })) },
					{ wait: true },
				];
				const tui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "full"], resume: owned.id, sessionDir: owned.dir, columns, rows });
				try {
					await tui.ready();
					await tui.shows("Storm lane view fit fixture transcript.");
					const files = new StormFiles(env, owned.id);
					const before = files.runIds();
					const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
					await until(() => files.runs().find(candidate => !before.has(candidate.runId) && candidate.status === "running" && candidate.plan?.lanes.length === laneCount), 60_000, named("the run to be bound"));
					await tui.seen(started, text => (laneSequence(text, names[0]!).length > 0 ? true : undefined), named("the first lane's row"), 30_000);
					await Bun.sleep(1_000);
					const screen = await until(() => liveScreen(tui), 20_000, named("the live widget on the screen"));
					const cap = laneHeight(rows);
					const expected = Math.min(cap, 2 + laneCount);
					check(named(`the view is ${expected} rows: its own size, never past the cap of ${cap}`), screen.lanes && screen.rows.length === expected, `${screen.rows.length} rows\n${screen.rows.join("\n")}`);
					check(named("no blank row under the view: its last row is the bottom row of the screen"), screen.blankUnder === 0 && (screen.viewport.at(-1) ?? "").trim() !== "", `${screen.blankUnder} blank rows under\n${screen.viewport.slice(-expected - 2).join("\n")}`);
					check(named("the status row and the director's trunk are on the screen and every row fits the width"), screen.rows[0]!.startsWith(STORM_MARK) && isTrunkRow(screen.rows[1] ?? "") && screen.rows.every(row => Bun.stringWidth(row) <= columns), screen.rows.join("\n"));
					if (2 + laneCount <= cap) {
						check(named("every lane has its row"), names.every(name => screen.rows.some(row => row.trim().startsWith(`${name} `))), screen.rows.join("\n"));
					} else {
						check(named("lanes past the cap are folded into one summary row"), (screen.rows.at(-1) ?? "").trim().startsWith("+") && screen.rows.slice(2, -1).every(row => names.some(name => row.trim().startsWith(`${name} `))), screen.rows.join("\n"));
					}
					// The editor is usable with the view that size: typed text shows above the status row, and the view stays put.
					const typed = "fit-typing";
					tui.send(typed);
					const above = await until(() => {
						const live = liveScreen(tui);
						return live !== undefined && live.viewport.slice(0, live.status).some(row => row.includes(typed)) ? live : undefined;
					}, 15_000, named("the typed text in the editor above the view"));
					check(named("typing did not move the view"), above.status === screen.status && above.blankUnder === 0, `${above.status} vs ${screen.status}`);
					tui.send("\x7f".repeat(typed.length));
					await until(() => (liveScreen(tui)?.viewport.some(row => row.includes(typed)) ? undefined : true), 15_000, named("the typed text to be erased"));
					await files.finishedRun(before, 120_000);
				} finally {
					await tui.close();
				}
			};
			await fit(120, 50, 2);
			await fit(80, 24, 15);
		},
		300_000,
	);

	await scenario(
		"a narrow terminal with motion off keeps the live status still in both backgrounds",
		async () => {
			await narrowMotionOff("dark");
			await narrowMotionOff("light");
		},
		300_000,
	);

	await scenario(
		"a terminal under 60 columns or 18 rows keeps the single line with its radar",
		async () => {
			await narrowMotionOff("dark", LANE_MIN_COLUMNS - 1, 30);
			await narrowMotionOff("light", 100, LANE_MIN_ROWS - 1);
		},
		300_000,
	);

	await scenario("the OMP ASCII preset keeps the live chips and status usable", asciiDashboard, 90_000);

	await scenario("the host's Escape flow cancels a waiting ask and restores the resumable footer", async () => {
		await session(async (tui, files) => {
			const before = files.runIds();
			// The fresh card is for substantive work; it must not pick a different older unfinished run.
			const steps: Step[] = [plan("scan", "design"), { ask: ASK_FORM }, { awaitChild: true }];
			const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
			await tui.seen(
				started,
				text => (text.includes(phaseHeader("waiting-user")) && text.includes("E2E-QUESTION") && text.includes("Submit") ? true : undefined),
				"the cancellable native ask",
				30_000,
			);
			// In a terminal form, the first Escape releases focus back to the composer; the second interrupts the turn.
			await tui.press("\x1b", text => text.includes("answer the questions above, or type here to skip them"), "Escape to return focus to the composer", 10_000);
			const cancelled = tui.send("\x1b");
			const run = await files.finishedRun(before, 30_000);
			check("Escape interrupts the waiting run", run.status === "stopped" && run.endReason === "interrupted", `${run.status} ${run.endReason}`);
			await tui.seen(
				cancelled,
				() => (statusLine(tui)?.startsWith(`${STORM_MARK} · ${RESUME.label}`) ? true : undefined),
				"the resumable footer after cancelling",
				30_000,
			);
			// An interrupted run with no draft keeps the whole card, and its only numbered action is the code-written
			// resume: nothing is invented to fill three slots.
			const shown = await tui.seen(cancelled, text => {
				const at = text.lastIndexOf(CLOSEOUT_HEADING);
				const tail = at < 0 ? "" : text.slice(at);
				return tail.includes(CLOSEOUT_DETAIL) ? tail : undefined;
			}, "the interrupted run's closeout card", 30_000);
			const rows = screenRows(shown);
			const region = rows.slice(0, rows.findIndex(row => row.includes(CLOSEOUT_DETAIL)) + 1);
			const offers = numberedOffers(region);
			check(
				"the interrupted card offers exactly one numbered action, the recorded resume",
				offers.length === 1 && /^1\.\s*추천/u.test(offers[0] ?? "") && offers[0]!.includes("이어 가기") && !region.some(row => row.includes("감독 설명")),
				region.join("\n"),
			);
			// Choosing it goes through the existing resume path: the recorded same-target candidate, revalidated at start.
			const resumeLlm = new LlmCursor(env);
			const withStopped = files.runIds();
			await tui.submit("1");
			const resumed = await until(() => files.runs().find(candidate => !withStopped.has(candidate.runId)), 20_000, "the chosen run to be recorded");
			const handoff = await until(
				() => mains(resumeLlm.all()).map(entry => entry.lastUser).find(user => user.includes(`<storm-run id="${resumed.runId}"`)),
				20_000,
				"the trusted resume handoff to reach the director",
			);
			check(
				"the numbered resume continues the interrupted run's own request through the resume path",
				resumed.resumeOf === run.runId && resumed.followUpOf === undefined && resumed.request === continuationTask(run as RunRecord & { request: string }) && (run.request === undefined || resumed.request?.includes(run.request) === true) && handoff.includes(run.runId) && resumeLlm.of("route").length === 0,
				`resumeOf=${resumed.resumeOf} followUpOf=${resumed.followUpOf} request=${resumed.request === run.request} handoff=${handoff.slice(0, 400)}`,
			);
		});
	}, 210_000);

	await scenario(
		"shutdown while an ask waits ends the run and leaves it resumable",
		async () => {
			if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
			const files = new StormFiles(env, ownedSession.id);
			const before = files.runIds();
			const tui = new Tui(env, { model: "fake/general-b", resume: ownedSession.id, sessionDir: ownedSession.dir });
			let runId: string | undefined;
			try {
				await readyForSubmission(tui);
				const steps: Step[] = [plan("scan", "explore"), { ask: ASK_FORM }, { awaitChild: true }];
				const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
				await tui.seen(
					started,
					text => (text.includes(phaseHeader("waiting-user")) && text.includes("E2E-QUESTION") ? true : undefined),
					"the ask waiting at shutdown",
					60_000,
				);
				const live = await until(() => files.runs().find(run => !before.has(run.runId) && run.status === "running"), 20_000, "the waiting run to be active");
				runId = live.runId;
			} finally {
				await tui.close();
			}
			if (runId === undefined) throw new Error("the waiting run never appeared on disk");
			const ended = await until(
				() => {
					const run = files.run(runId!);
					return run !== undefined && run.status !== "running" && run.endedAt !== undefined ? run : undefined;
				},
				30_000,
				"the waiting run to end at shutdown",
			);
			check("shutdown ends the waiting run", ended.endReason === "shutdown", `${ended.status} ${ended.endReason}`);
			check("the ended run is indexed once", files.index().filter(line => line.runId === runId).length === 1);
			await session(async next => {
				await suite.eventually(
					"the shutdown run is offered as resumable in the shared footer",
					() => {
						const line = statusLine(next);
						return line !== undefined && line.includes(STORM_MARK) && line.includes(RESUME.label);
					},
					() => statusLine(next) ?? "no status line",
					30_000,
				);
			});
		},
		180_000,
	);
	// A refused `task` call is the one tool result omp 19.2's own view cannot draw when it is a plain block (`details: {}`):
	// the block's first paint threw inside a listener (a logged warning), and the next thing that read the block outside
	// a listener (expanding the output, another refusal, resuming the session file) killed omp. The lane-write refusal
	// below waits its 1.5 s first, so the block is painted pending before the refusal arrives: the state a real model leaves.
	await scenario(
		"a refused task call leaves a transcript omp can keep drawing: expanding it, a second refusal and a resume do not kill omp",
		async () => {
			if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
			const llm = new LlmCursor(env);
			const logDir = join(env.agentDir, "..", "logs");
			/** What omp's own log holds that a healthy session never writes: a rejected listener or an uncaught exception. */
			const hostFaults = (): string[] =>
				(existsSync(logDir) ? readdirSync(logDir) : []).flatMap(name =>
					readFileSync(join(logDir, name), "utf8").split("\n").filter(line => /AgentSession listener rejected|Uncaught exception|"reason":"uncaught_exception"/.test(line)),
				);
			const faultsBefore = hostFaults().length;
			const died = (tui: Tui): boolean => /\[(Uncaught Exception|Fatal Error)\]/.test(tui.screenText());
			/** Presses Ctrl+O and waits for omp to say the expansion changed, or for its crash screen. */
			const expand = async (tui: Tui, label: string): Promise<boolean> => {
				const from = tui.send("\x0f");
				const answered = await until(() => (/Tool output expansion: (enabled|disabled)/.test(tui.text(from)) ? true : died(tui) ? false : undefined), 15_000, `omp to answer Ctrl+O (${label})`).catch(() => false);
				return answered && !died(tui);
			};
			const file = FACT_FILE;
			const result = (id: string) => [{ id, kind: "change", criterion: `${id} is written`, path: file, contains: id }];
			const holder = { name: "W0", kind: "run", role: "quick", files: [file], goal: "hold the shared file", results: result("w-write") };
			const overlap = { name: "X0", kind: "code", role: "quick", files: [file], goal: "overlap the holder", results: result("x-write") };
			const steps: Step[] = [
				{ storm: { action: "plan", plan: { lanes: [holder, overlap], workers: { quick: 3 } } } },
				{ task: ["storm-quick"], as: "W", say: "E2E-CHILD-DELAY 50000" },
				{ task: ["storm-quick"], as: "X", say: "E2E-REFUSED-CHILD" },
				{ task: ["storm-quick"], as: "Y", say: "E2E-REFUSED-CHILD" },
			];
			// The second call names no planned lane, so Storm refuses it with a different code: both count.
			const refusalsTold = (): number => mains(llm.all()).filter(entry => entry.lastTool.startsWith("[storm:lane")).length;
			await session(async (tui, files) => {
				const before = files.runIds();
				await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
				const told = await until(() => mains(llm.all()).find(entry => entry.lastTool.includes("[storm:lane-write]")), 60_000, "the refusal to reach the director");
				check("the director is still told why the call was refused, in the refusal's own words", told.lastTool.includes("[storm:lane-write]"), told.lastTool.slice(0, 200));
				await Bun.sleep(3_000);
				check("the refused call's first paint did not make omp reject a listener", hostFaults().length === faultsBefore && !died(tui), hostFaults().slice(faultsBefore).join("\n").slice(0, 400));
				const live = await until(() => files.runs().find(run => !before.has(run.runId) && run.status === "running"), 20_000, "the run to be active");
				check("the refused item started no worker, and the run kept the one it had admitted", llm.of("child").every(entry => !entry.lastUser.includes("E2E-REFUSED-CHILD")) && live.status === "running");

				check("expanding the transcript output after a refused call leaves omp running", await expand(tui, "first"), tui.screenText().slice(-300));
				check("the user can read why the call was refused", tui.history().some(row => row.includes("[storm:lane-write]")), tui.history().slice(-12).join("\n"));
				// The second refused call is the next task call after a block that was painted pending: it follows the first at once.
				await until(() => (refusalsTold() >= 2 ? true : undefined), 60_000, "the second refusal to reach the director");
				await Bun.sleep(2_000);
				check("a second refused call leaves omp running, and so does collapsing the output again", !died(tui) && (await expand(tui, "second")), tui.screenText().slice(-300));
				check("omp's log holds no rejected listener or uncaught exception after both refusals", hostFaults().length === faultsBefore, hostFaults().slice(faultsBefore).join("\n").slice(0, 600));
			});
			// The refusal is in the session file now: resuming it draws every block again, outside any listener.
			const reopened = new Tui(env, { model: "fake/general-b", flags: ["--motion", "full"], resume: ownedSession.id, sessionDir: ownedSession.dir });
			try {
				const opened = await readyForSubmission(reopened).then(() => true, () => false);
				check("the session file with refused calls opens again", opened && !died(reopened), reopened.screenText().slice(-300));
				check("expanding the resumed transcript leaves omp running", opened && (await expand(reopened, "after resume")), reopened.screenText().slice(-300));
				check("the resumed session's log holds no rejected listener or uncaught exception", hostFaults().length === faultsBefore, hostFaults().slice(faultsBefore).join("\n").slice(0, 600));
			} finally {
				await reopened.close();
			}
		},
		240_000,
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
