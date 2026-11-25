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
 * The driver is closed-loop: every key is followed by a wait for the repaint it must cause, and every check by a
 * wait for the state it asserts, so a slow machine only makes the run longer. Storm's files and the model request
 * log are what is asserted; the screen is read to know what has the focus. Directive payloads are typed as base64,
 * so no key of them means anything to the composer.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { ROLES, STORM_VERSION } from "../../src/roles.ts";
import { parseModelEntry } from "../../src/selector.ts";
import type { RunRecord, StormConfig } from "../../src/types.ts";
import { idleAppearance, RUN_APPEARANCE, type RunPhase, STORM_MARK } from "../../src/view/appearance.ts";
import { priorityLabel } from "../../src/view/render.ts";
import { CLOSEOUT_NEXT_MAX } from "../../src/runtime/closeout.ts";
import { CLOSEOUT_CHOICE_HINT } from "../../src/view/closeout.ts";
import { STATUS_LABEL } from "../../src/runtime/rounds.ts";
import {
	CLOSEOUT_DETAIL, CLOSEOUT_HEADING, closeoutBody, focused, isOneLineCloseout, KEY, LlmCursor, type LlmEntry, linkPlugin, modelId, modelsYml, numberedOffers, offeredDirections, persistedStormRecords,
	price, PROFILE_CONFIG, prepare, Rpc, runNext, sessionFileIn, type Step, type StormRecord, statusLine, StormFiles, Suite, startFakeLlm, TEAM_PROVIDERS, Tui,
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
/** The official label of a done run, as the settled record and the status view print it. */
const STATUS_DONE = STATUS_LABEL.done;
/** The incomplete run whose card offered a related follow-up; later unrelated handoffs must not carry its facts. */
let cardRunId: string | undefined;

/** The widget's static header text: the shared mark, then the shared phase label. */
const phaseHeader = (phase: RunPhase): string => `${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`;

const RADAR_FIELD = /\[[\u2801-\u28ff]{18}\]/;
const metricsRow = (text: string, preset: "unicode" | "ascii" = "unicode"): string | undefined => {
	const chips = preset === "unicode" ? /↻\s*\d+\/\d+.*👥\s*\d+\/\d+/u : /\bloop\s*\d+\/\d+.*\bAG\s*\d+\/\d+/;
	return text.split("\n").map(line => line.trim()).findLast(line => chips.test(line));
};

function radarFrames(text: string, phase: RunPhase): Set<string> {
	const head = phaseHeader(phase);
	return new Set(text.split("\n").flatMap(line => {
		const field = line.includes(head) ? line.match(RADAR_FIELD)?.[0] : undefined;
		return field ? [field] : [];
	}));
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
 * The terminal screen a pty log paints, as rows of text: `scrollback` (rows scrolled off the top) then `viewport`.
 * `Tui.text` is only the byte stream with escapes removed, where one painted row can appear many times, wrapped
 * rows look like separate rows and cursor moves are lost; a visual claim (one row, no frame, nothing around it)
 * needs the rows a person actually sees. This replays the cursor moves, line edits and scrolling omp's renderer
 * uses (CUP/CUU/CUD/CUF/CUB/CHA, EL, ED, IL, DL, SU, DECSC/DECRC, CR/LF, auto-wrap) and ignores colours and modes.
 */
function replayScreen(raw: string, cols: number, rows: number): { scrollback: string[]; viewport: string[] } {
	const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const blank = (): string[] => Array.from({ length: cols }, () => " ");
	const grid: string[][] = Array.from({ length: rows }, blank);
	const scrollback: string[][] = [];
	let row = 0;
	let col = 0;
	let saved: [number, number] = [0, 0];
	const scrollUp = (): void => {
		scrollback.push(grid.shift() ?? blank());
		grid.push(blank());
	};
	const lineFeed = (): void => {
		if (row === rows - 1) scrollUp();
		else row++;
	};
	const put = (grapheme: string): void => {
		const width = Bun.stringWidth(grapheme);
		if (width === 0) return;
		if (col + width > cols) {
			col = 0;
			lineFeed();
		}
		grid[row]![col] = grapheme;
		for (let at = 1; at < width; at++) grid[row]![col + at] = "";
		col += width;
	};
	const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value));
	let at = 0;
	while (at < raw.length) {
		const char = raw[at]!;
		if (char === "\x1b") {
			const kind = raw[at + 1];
			if (kind === "[") {
				const csi = /^\x1b\[([0-9;?<>=:]*)([ -/]*[@-~])/.exec(raw.slice(at, at + 64));
				if (csi === null) {
					at++;
					continue;
				}
				at += csi[0].length;
				const args = csi[1]!.replace(/^[?<>=]/, "").split(";").map(part => (part === "" ? 0 : Number(part)));
				const count = Math.max(1, args[0] ?? 0);
				switch (csi[2]) {
					case "H":
					case "f":
						row = clamp((args[0] || 1) - 1, rows - 1);
						col = clamp((args[1] || 1) - 1, cols - 1);
						break;
					case "A": row = clamp(row - count, rows - 1); break;
					case "B": row = clamp(row + count, rows - 1); break;
					case "C": col = clamp(col + count, cols - 1); break;
					case "D": col = clamp(col - count, cols - 1); break;
					case "G": col = clamp((args[0] || 1) - 1, cols - 1); break;
					case "K": {
						const mode = args[0] ?? 0;
						for (let cell = mode === 0 ? col : 0; cell < (mode === 1 ? col + 1 : cols); cell++) grid[row]![cell] = " ";
						break;
					}
					case "J": {
						const mode = args[0] ?? 0;
						for (let line = 0; line < rows; line++) {
							if (mode >= 2 || (mode === 0 && line > row) || (mode === 1 && line < row)) grid[line] = blank();
						}
						if (mode === 0) for (let cell = col; cell < cols; cell++) grid[row]![cell] = " ";
						if (mode === 1) for (let cell = 0; cell <= col; cell++) grid[row]![cell] = " ";
						break;
					}
					case "L":
						for (let n = 0; n < count; n++) {
							grid.splice(rows - 1, 1);
							grid.splice(row, 0, blank());
						}
						break;
					case "M":
						for (let n = 0; n < count; n++) {
							grid.splice(row, 1);
							grid.push(blank());
						}
						break;
					case "S":
						for (let n = 0; n < count; n++) scrollUp();
						break;
					default:
						break;
				}
				continue;
			}
			if (kind === "]" || kind === "_" || kind === "P") {
				const bell = raw.indexOf("\x07", at);
				const terminator = raw.indexOf("\x1b\\", at + 2);
				const ends = [bell < 0 ? Number.POSITIVE_INFINITY : bell + 1, terminator < 0 ? Number.POSITIVE_INFINITY : terminator + 2];
				const end = Math.min(...ends);
				at = Number.isFinite(end) ? end : raw.length;
				continue;
			}
			if (kind === "7") saved = [row, col];
			if (kind === "8") [row, col] = saved;
			at += 2;
			continue;
		}
		if (char === "\r") col = 0;
		else if (char === "\n") lineFeed();
		if (char < " ") {
			at++;
			continue;
		}
		const stop = raw.slice(at).search(/[\x00-\x1f]/);
		const text = stop < 0 ? raw.slice(at) : raw.slice(at, at + stop);
		for (const { segment } of graphemes.segment(text)) put(segment);
		at += text.length;
	}
	const rowText = (cells: string[]): string => cells.join("").replace(/\s+$/, "");
	return { scrollback: scrollback.map(rowText), viewport: grid.map(rowText) };
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

/** The selected native effort is in the picker header, not in a later Ask form. */
const pickerLevel = (text: string): string | undefined =>
	[...text.matchAll(/\b(?:thinking|effort)[: ]+\s*(Auto|Off|Min|Low|Med|High|XHigh|Max)\b/gi)].at(-1)?.[1]?.toLowerCase();

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

/** The narrow, motion-off run in one terminal appearance; the light variant proves no theme assumption. */
async function narrowMotionOff(background: "dark" | "light"): Promise<void> {
	if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
	const files = new StormFiles(env, ownedSession.id);
	requireApprovedTeam(files, `${background}: narrow motion-off`);
	const columns = 60;
	const tui = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], columns, rows: 30, background, resume: ownedSession.id, sessionDir: ownedSession.dir });
	const named = (name: string): string => `${background}: ${name}`;
	try {
		await readyForSubmission(tui);
		await tui.seen(0, () => (idleFooter(statusLine(tui.raw)) ? true : undefined), named("narrow idle footer"), 30_000);
		const idle = statusLine(tui.raw);
		check(named("the narrow footer uses the shared mark and an idle state"), idleFooter(idle), idle ?? "no status line");
		check(named("the narrow footer fits the terminal"), Bun.stringWidth(idle ?? "") <= columns, `${Bun.stringWidth(idle ?? "")} > ${columns}: ${idle}`);
		const before = files.runIds();
		const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-DELAY 3000 ${readProbe}` }, { awaitChild: true }];
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
		check(
			named("the phase, radar and active worker count fit at 60 columns"),
			first !== undefined && RADAR_FIELD.test(first) && [first, active].every(line => Bun.stringWidth(line) <= columns),
			`${first} / ${active}`,
		);
		await Bun.sleep(800);
		const second = phaseRow(tui.text(started), "workers");
		check(named("motion off leaves the radar still"), first !== undefined && second === first && radarFrames(tui.text(started), "workers").size === 1, `${first} → ${second}`);
		const run = await files.finishedRun(before, 120_000);
		check(named("the narrow run accepts its answer but does not certify the unrun code check"),
			run.results?.some(row => row.id === "impl-answer" && row.state === "accepted") === true && run.endReason === "no-changes", `${run.status} ${run.endReason}`);
		await suite.eventually(named("the narrow footer returns to idle"), () => idleFooter(statusLine(tui.raw)), () => statusLine(tui.raw) ?? "no status line", 30_000);
		if (background === "dark") {
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
		const wide = new Tui(env, { model: "fake/general-b", flags: ["--motion", "none"], columns: wideColumns, rows: 30, resume: resume.id, sessionDir: resume.dir });
		try {
			await readyForSubmission(wide);
			const before = files.runIds();
			const steps: Step[] = [plan("impl", "code"), { task: ["storm-implementer"], as: "AsciiWide", say: `E2E-CHILD-DELAY 2500 ${readProbe}` }, { awaitChild: true }];
			const started = await wide.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);
			const chips = await wide.seen(started, text => {
				const row = metricsRow(text, "ascii");
				return row && /\bAG\s*1\/1\b/.test(row) && /\$0\.\d+\/\$0\.\d+\b/.test(row) ? row : undefined;
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
					loop === "loop 1/4라운드" &&
					workers === "AG 1/1" &&
					cost !== undefined && /^\$0\.\d+\/\$0\.\d+$/.test(cost) &&
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
		check("the ASCII view run retains its answer without claiming the code check",
			run.results?.some(row => row.id === "impl-answer" && row.state === "accepted") === true && run.endReason === "no-changes");
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
				await suite.eventually("the calm idle footer names the approved team", () => idleFooter(statusLine(tui.raw)), () => statusLine(tui.raw) ?? "no status line");
				const calm = statusLine(tui.raw);
				await Bun.sleep(500);
				check("the idle footer stays still", statusLine(tui.raw) === calm, `${calm} → ${statusLine(tui.raw)}`);
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
				const settings = await submitForm(tui, mark, "예산", 7);
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

	await suite.step(
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
				await suite.eventually("the footer returns to its idle state after the run", () => idleFooter(statusLine(tui.raw)), () => statusLine(tui.raw) ?? "no status line", 30_000);
			});
		},
		240_000,
	);

	await suite.step("a short clean automatic run leaves one factual line and registers no numbered choice", async () => {
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
			const started = await tui.submit(`E2E-STEPS ${b64(steps)}`);
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
			const view = (): string[] => {
				const painted = replayScreen(tui.raw.slice(started), columns, viewRows);
				return [...painted.scrollback, ...painted.viewport];
			};
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

	await suite.step("an incomplete run keeps the whole card at 60 columns, and its first direction starts one related follow-up", async () => {
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
				/수용\s*1\/1/u.test(shown) && region.some(row => row.includes("주의") && row.includes("검증되지 않은")),
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

	await suite.step(
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
				check("waiting for the user shows the radar without a moving field", radarFrames(shown, "waiting-user").size === 1);
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
						const fields = radarFrames(text, "workers");
						return fields.size >= 2 ? fields : undefined;
					},
					"the answered run to resume with at least two distinct worker radar frames",
					15_000,
				);
				console.log(`     real worker radar: ${[...frames].slice(0, 2).join(" → ")}`);
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
				await suite.eventually("the footer returns after the answered run", () => idleFooter(statusLine(tui.raw)), () => statusLine(tui.raw) ?? "no status line", 30_000);
			});
		},
		180_000,
	);

	await suite.step(
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
						"the live widget shows a radar and a fixed row with the round and budget",
						() => {
							const painted = tui.text(started);
							const numbers = metricsRow(painted);
							return numbers !== undefined && numbers.includes("💲") && numbers.includes("0.01") &&
								(["working", "workers", "verifying"] as const).some(phase => radarFrames(painted, phase).size !== 0);
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
						() => idleFooter(statusLine(tui.raw)),
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
					await suite.eventually("the footer returns to idle after the status report", () => idleFooter(statusLine(tui.raw)), () => statusLine(tui.raw) ?? "no status line", 30_000);
				});
			} finally {
				rmSync(changed, { force: true });
			}
		},
		300_000,
	);

	await suite.step(
		"a narrow terminal with motion off keeps the live status still in both backgrounds",
		async () => {
			await narrowMotionOff("dark");
			await narrowMotionOff("light");
		},
		300_000,
	);

	await suite.step("the OMP ASCII preset keeps the live chips and status usable", asciiDashboard, 90_000);

	await suite.step("the host's Escape flow cancels a waiting ask and restores the resumable footer", async () => {
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
				() => (statusLine(tui.raw.slice(cancelled))?.startsWith(`${STORM_MARK} · ${RESUME.label}`) ? true : undefined),
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
				resumed.resumeOf === run.runId && resumed.followUpOf === undefined && resumed.request === run.request && handoff.includes(run.runId) && resumeLlm.of("route").length === 0,
				`resumeOf=${resumed.resumeOf} followUpOf=${resumed.followUpOf} request=${resumed.request === run.request} handoff=${handoff.slice(0, 400)}`,
			);
		});
	}, 210_000);

	await suite.step(
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
						const line = statusLine(next.raw);
						return line !== undefined && line.includes(STORM_MARK) && line.includes(RESUME.label);
					},
					() => statusLine(next.raw) ?? "no status line",
					30_000,
				);
			});
		},
		180_000,
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
