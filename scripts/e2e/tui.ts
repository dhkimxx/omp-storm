#!/usr/bin/env bun
/**
 * OMP Storm end-to-end check in omp's interactive TUI, on a pty: what only that host has. Setup through Storm's
 * approval, role interviews, a plain request, a run Storm sends back until its changes are reviewed, a native ask
 * that holds and then resumes the same run, shutdown while it waits, and narrow motion-off runs in dark and light.
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
import { focused, KEY, LlmCursor, type LlmEntry, linkPlugin, modelId, modelsYml, price, PROFILE_CONFIG, prepare, Rpc, type Step, statusLine, StormFiles, Suite, startFakeLlm, TEAM_PROVIDERS, TRACKED_FILE, TRACKED_TEXT, Tui, until, cancelAll } from "./harness.ts";

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
 * The read-only probes in this TUI file deliver one sourced observation: the child reads the tracked file and cites
 * its exact line, so every probing lane has a real, observable result instead of merely ending.
 */
const TRACKED_LINE = TRACKED_TEXT.trim();
const TRACKED_CLAIM = `${TRACKED_LINE} is line 1 of ${TRACKED_FILE} (${TRACKED_FILE}:1)`;
const trackedAnswer = (id: string): Record<string, unknown> => ({ id, kind: "answer", criterion: `report what ${TRACKED_FILE} line 1 says`, path: TRACKED_FILE, contains: TRACKED_LINE });
const readProbe = `E2E-CHILD-READ ${TRACKED_FILE} E2E-CHILD-CLAIM ${TRACKED_CLAIM}`;
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

async function session<T>(body: (tui: Tui, files: StormFiles) => Promise<T>, model = "fake/general-b", flags: string[] = []): Promise<T> {
	if (ownedSession === undefined) throw new Error("the TUI fixture session was not created");
	const tui = new Tui(env, { model, flags: ["--motion", "full", ...flags], resume: ownedSession.id, sessionDir: ownedSession.dir });
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
	const resultPrefix = `> report what ${TRACKED_FILE} line 1 says `;

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

	await suite.step("a substantial automatic run hands back three choices without starting another run", async () => {
		const llm = new LlmCursor(env);
		await session(async (tui, files) => {
			const scope = { name: "scope", kind: "explore", goal: "Locate the first input boundary", results: [trackedAnswer("scope-answer")] };
			const compare = { name: "compare", kind: "code", goal: "Compare the current evidence without changing files", results: [trackedAnswer("compare-answer")] };
			const setPlan = (...lanes: Array<typeof scope & { progress?: string }>): Step => ({ storm: { action: "plan", plan: { lanes } } });
			// The next direction must fit the brief's 240-character limit; a pure review gate is the compact authorized
			// run that still proves the one-shot choice opens a real plan and spawns its worker.
			const chosen = `E2E-NEXT E2E-STEPS ${b64([{ storm: { action: "plan", plan: { lanes: [{ name: "gate", kind: "review" }] } } }, { task: ["storm-reviewer"], as: "gate", say: "E2E-CHILD-VERDICT correct" }])}`;
			const brief = {
				result: "E2E-BRIEF-RESULT: the current comparison has one unresolved boundary.",
				verification: "E2E-BRIEF-EVIDENCE: two local records were compared.",
				remaining: "E2E-BRIEF-REMAINING: device latency was not measured.",
				next: [chosen, "Compare the missing boundary offline", "Document the limits and stop"],
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
			await tui.seen(started, text =>
				text.includes("E2E-BRIEF-RESULT") && text.includes("E2E-BRIEF-REMAINING") && text.includes("Document the limits and stop")
					? true : undefined,
				"the settled closeout with all three next directions", 20_000);
			const shown = tui.text(started);
			check("automatic investigation reports the outcome once with option 1 recommended", shown.match(/E2E-BRIEF-RESULT/g)?.length === 1 && /추천[^\n]*E2E-NEXT/u.test(shown));
			check(
				"updating progress preserves real completed coverage even though a changed goal was refused",
				run.endReason === "verified" && run.turns === 1 && run.spawns.filter(spawn => spawn.outcome === "routed").length === 2 &&
					run.plan?.lanes[0]?.goal === scope.goal && run.plan?.lanes[0]?.progress?.includes("(완료)") === true,
				`${run.status}/${run.endReason} in ${run.turns} turns`,
			);
			check("the director was told to leave an assigned goal alone", mains(llm.all()).some(entry => entry.lastTool.includes("계획 레인 'scope'") && entry.lastTool.includes("progress")));
			check("briefing itself neither starts a run nor uses a classifier", files.runIds().size === before.size + 1 && llm.of("route").length === 0);
			const withCompleted = files.runIds();
			const selected = await tui.submit("1");
			const next = await files.finishedRun(withCompleted, 60_000);
			check("the chosen direction starts one new authorized Storm run", next.runId !== run.runId && next.task.startsWith("E2E-NEXT") && next.spawns.some(spawn => spawn.outcome === "routed"));
			// The chosen run gets its own settled card; any ordinary text consumes it, and a later number is model input.
			await tui.shows("다음으로 무엇을 할까요?", selected, 20_000);
			const ordinary = new LlmCursor(env);
			await tui.submit("a routine follow-up after the chosen run");
			await until(() => mains(ordinary.all()).find(entry => entry.lastUser.includes("a routine follow-up after the chosen run")), 15_000, "ordinary text after the chosen run");
			const after = files.runIds().size;
			await tui.submit("1");
			await until(() => mains(ordinary.all()).find(entry => /(?:^|\n)1\s*$/.test(entry.lastUser)), 15_000, "an ordinary number after the one-shot card");
			check("a number after the one-shot card is ordinary model input and starts no run", files.runIds().size === after);
		});
	}, 180_000);

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
					await tui.shows(currentCheck, started, 20_000);
					const completed = tui.text(started).split("### Storm 실행 결과").at(-1) ?? "";
					check("the fallback brief names the actual verified result and check", completed.includes("상태(공식): 완료") && completed.includes("e2e-verify-hold passed(0)"));
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
			const steps: Step[] = [plan("scan", "explore"), { ask: ASK_FORM }, { awaitChild: true }];
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
		});
	}, 90_000);

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
