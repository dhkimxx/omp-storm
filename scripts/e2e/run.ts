#!/usr/bin/env bun
/**
 * OMP Storm end-to-end check, RPC and print hosts: the real plugin, installed in an isolated profile, inside the
 * pinned omp against the scripted fake LLM. No paid model calls. The TUI scenarios (setup forms and a run) are in
 * tui.ts.
 *
 * Usage: npm run e2e   (env: see harness.ts)
 *
 * Checks compare block codes (`[storm:<code>]`), outcomes, files and numbers. The only Korean in here are dialog
 * option labels, which are what a client answers with.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { docPromptFor } from "../../src/policy/docs.ts";
import { NEEDS_APPROVAL } from "../../src/proposals/decide.ts";
import { APPROVE, CANCEL } from "../../src/proposals/present.ts";
import { FALLBACK, QUOTA_CHOICE } from "../../src/request/route.ts";
import { continuationTask } from "../../src/runtime/resume.ts";
import type { PlanLaneResult, RunRecord } from "../../src/types.ts";
import { GOAL_LABEL, goalText } from "../../src/view/closeout.ts";
import {
	type Answer,
	approveTeam,
	cancelAll,
	COMMIT_FILE,
	customMessage,
	CLOSEOUT_DETAIL,
	CLOSEOUT_HEADING,
	closeoutBody,
	hubLabel,
	closeoutOf,
	offeredDirections,
	pendingLanesOf,
	runNext,
	stormRecords,
	userNext,
	choose,
	type Frame,
	LlmCursor,
	type LlmEntry,
	linkPlugin,
	modelId,
	modelsYml,
	PROFILE_CONFIG,
	prepare,
	price,
	readJsonl,
	REVIEW_FILE,
	REVIEW_TEXT,
	Rpc,
	type SessionOptions,
	type Step,
	StormFiles,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	TRACKED_FILE,
	TRACKED_TEXT,
	until,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

/** Option labels Storm does not export. */
const LABEL = {
	resume: "끝나지 않은 실행 이어 가기",
	reset: "초기화",
	rollback: "이전 승인으로 되돌리기",
	keepModel: "지금 모델 유지",
	autoOff: "자동 위임 끄기",
} as const;

/** A settled run's own active time, from its record's two ends; what a resume carries for it. */
function ownMs(run: RunRecord): number {
	return Date.parse(run.endedAt ?? "") - Date.parse(run.startedAt);
}

/** A goal's totals summed here from the runs' own records, independently of the carry Storm wrote. */
function summed(runs: readonly RunRecord[]): { runs: number; usd: number; ms: number; turns: number } {
	return runs.reduce((sum, run) => ({ runs: sum.runs + 1, usd: sum.usd + run.costUsd, ms: sum.ms + ownMs(run), turns: sum.turns + (run.turns ?? 0) }), { runs: 0, usd: 0, ms: 0, turns: 0 });
}

/** The disclosure the first team approval panel must carry. */
const AUTO_DISCLOSURE = "승인하면 이 세션의 자동 위임이 켜집니다";

const env = prepare("storm-e2e", 18556);
seedFact(env.project);
const suite = new Suite("E2E (rpc)", env);
const check = suite.check.bind(suite);

const PROVIDERS = {
	fake: [
		...TEAM_PROVIDERS.fake,
		// Below every role's minimum context, so no team ever approves it: the model outside the team.
		{ id: "outsider-z", cost: price(5, 25), context: 60_000 },
		// Reports a 35k prompt on a 60k window (fake-llm.ts): a heavy main session for the run-start check. Never in a team.
		{ id: "heavy-main", cost: price(1, 4), context: 60_000 },
		// Reports a 75k prompt on a 100k window: a director past 70% of its window mid-run. Below every role minimum.
		{ id: "tight-main", cost: price(1, 4), context: 100_000 },
	],
	fake2: TEAM_PROVIDERS.fake2,
};
/** A provider whose only model always answers 429 (fake-llm.ts); added only for the fallback step, so it never enters the team. */
const QUOTA_OUT = { fake3: [{ id: "quota-out", cost: price(1, 4) }] };
/** No same-model retries, so omp walks the chain at once. */
const FALLBACK_CONFIG = `${PROFILE_CONFIG}retry:\n  maxRetries: 0\n  modelFallback: true\n  fallbackOn: any\n  fallbackChains:\n    fake3/quota-out:\n      - fake/general-b\n`;
const MAIN = "fake/general-b";
/** A main model outside the approved team: non-Storm agents ask for it unless Storm swaps it. */
const OUTSIDER = "fake/outsider-z";
const MODELS_FILE = join(env.agentDir, "models.yml");
const PROFILE_FILE = join(env.agentDir, "config.yml");
/**
 * 1M-window models that report a large prompt (fake-llm.ts): `wide-main` 150k, the old fixed run-start number;
 * `wide-worker` 250k, past the retired 200k follow-up cap. Listed only for the steps that use them: with a 1M window
 * they would otherwise enter every recommended team.
 */
const WIDE_PROVIDERS = {
	...PROVIDERS,
	fake: [...PROVIDERS.fake, { id: "wide-main", cost: price(1, 4), context: 1_000_000 }, { id: "wide-worker", cost: price(1, 4), context: 1_000_000 }],
};

const exitCodes: number[] = [];

/**
 * One omp RPC process: started, used and closed; its exit code is checked at the end. Unless `setup: "off"`, the
 * native session is approved through `/storm` before the body, so a scenario never relies on another session's
 * config, approvals or runs. The body's `files` reads only this session's store.
 */
async function session<T>(answer: Answer, body: (rpc: Rpc, files: StormFiles) => Promise<T>, options: Partial<SessionOptions> & { setup?: "approved" | "off" } = {}): Promise<T> {
	const { setup = "approved", ...rest } = options;
	const rpc = new Rpc(env, answer, { model: MAIN, ...rest });
	try {
		await rpc.ready();
		if (setup === "approved") await approveTeam(rpc, "off");
		return await body(rpc, new StormFiles(env, rpc.sessionId));
	} finally {
		exitCodes.push(await rpc.close());
	}
}

const route = (reply: Record<string, unknown>, rest = "please"): string => `/storm E2E-ROUTE ${JSON.stringify(reply)} ${rest}`;
/** A run requested through the classifier, as work reaches a run: the task carries the scripted steps. */
const runRequest = (reply: Record<string, unknown>, steps: Step[]): string => route(reply, `E2E-STEPS ${JSON.stringify(steps)}`);
const startRun = (steps: Step[]): string => runRequest({ action: "run" }, steps);
/** One plan lane; every non-review lane carries the observable result its worker actually delivers. */
type LaneSpec = { name: string; kind: string; role?: string; files?: string[]; results?: PlanLaneResult[] };
const plan = (lanes: LaneSpec[], workers?: Record<string, number>): Extract<Step, { storm: unknown }> => ({
	storm: { action: "plan", plan: { lanes, ...(workers ? { workers } : {}) } },
});
/**
 * The one typed fixture line the read-only lanes report (see typed-fixture.ts). The claim restates the line's signed
 * typed value and cites its real location, so the official answer evidence accepts it mechanically; a prose claim
 * about an untyped line is a reviewable submission and belongs to the scoped-review scenarios, not these.
 */
const TRACKED_CLAIM = FACT_CLAIM;
/** A real answer obligation: the child reads this line and cites it, so the result is not a fake pass. */
const trackedAnswer = (id: string, criterion = `report what ${FACT_FILE} line 1 says`): PlanLaneResult => ({
	id,
	kind: "answer",
	criterion,
	path: FACT_FILE,
	contains: FACT_LINE,
});
/** A child instruction that first reads the tracked fixture and then claims its exact cited line. */
const READ_AND_CLAIM = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${TRACKED_CLAIM}`;
/** A change the scripted child really writes or appends, with the content the result must exhibit. */
const changeResult = (id: string, path: string, contains: string, criterion: string): PlanLaneResult => ({
	id,
	kind: "change",
	criterion,
	path,
	contains,
});
const CHEAP_RUN = startRun([
	plan([{ name: "read", kind: "explore", results: [trackedAnswer("cheap-report")] }]),
	{ task: ["storm-explorer"], as: "Cheap", say: READ_AND_CLAIM },
]);

/**
 * Sends a message that starts a Storm run and returns the run's final record, once everything the run's end writes
 * is on disk and its final report, the last thing Storm does for a run, has come after the message that started it.
 */
async function runOf(rpc: Rpc, files: StormFiles, message: string): Promise<RunRecord> {
	const before = files.runIds();
	const start = rpc.frames.length;
	await rpc.prompt(message);
	const run = await files.finishedRun(before);
	const reported = (): true | undefined => {
		// A final report can arrive before the last agent_end, and the compact record's text does not repeat the run
		// id. Anchor to this prompt's start and look for the settled-run title, not at the last turn.
		return closeoutOf(rpc.frames, run.runId, start) !== undefined ? true : undefined;
	};
	await until(reported, 60_000, `the report of ${run.runId}`);
	return run;
}

const text = (frame: Frame): string => JSON.stringify(frame);
/** Async results delivered to the main session (a blocked spawn's reason arrives as one). */
const asyncResults = (frames: Frame[]): string =>
	frames
		.filter(frame => customMessage(frame) === "async-result")
		.map(text)
		.join("\n");
/** Storm's transcript records (`storm-report` messages, never sent to the model). */
const reports = (frames: Frame[]): string[] => frames.filter(frame => customMessage(frame) === "storm-report").map(text);
/** `details` of the storm tool's results, in call order. */
const toolOutcomes = (frames: Frame[]): Array<{ action?: string; outcome?: string; isError: boolean }> =>
	frames
		.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm")
		.map(frame => ({ ...frame.result?.details, isError: frame.isError === true }));
const blockCodes = (run: RunRecord | undefined): string[] => (run?.spawns ?? []).flatMap(spawn => (spawn.outcome === "blocked" ? [spawn.code ?? "none"] : []));
const children = (entries: LlmEntry[]): LlmEntry[] => entries.filter(entry => entry.who === "child");
const mains = (entries: LlmEntry[]): LlmEntry[] => entries.filter(entry => entry.who === "main");
/** A main request's newest user message without the date reminder omp puts in front of the first one. */
const newestUser = (entry: LlmEntry): string => entry.lastUser.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, "");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** No run left git's index lock behind and the repository still answers `git status`. */
const gitUsable = (): boolean => !existsSync(join(env.project, ".git", "index.lock")) && Bun.spawnSync(["git", "-C", env.project, "status", "--porcelain"]).exitCode === 0;

/** A config changed by hand in this session, then approved through `/storm`'s dialog for the unapproved team. */
async function editAndApprove(rpc: Rpc, files: StormFiles, change: Parameters<StormFiles["editConfig"]>[0]): Promise<Rpc["dialogs"]> {
	files.editConfig(change);
	rpc.answer = choose(APPROVE);
	await rpc.prompt("/storm");
	return rpc.dialogs;
}

async function main(): Promise<void> {
	writeFileSync(MODELS_FILE, modelsYml(env.port, PROVIDERS));
	writeFileSync(PROFILE_FILE, PROFILE_CONFIG);
	linkPlugin(env);
	/** The run started through the request router in a session kept on disk: the janitor step looks it up. */
	let routedRunId: string | undefined;
	/** That exact native session, so the janitor and reset steps resume it instead of opening a new one. */
	let routedSession: { id: string; dir: string } | undefined;
	/** The native session whose stopped run carries a resumable record for the later hub steps. */
	let stoppedSession: { id: string; dir: string } | undefined;
	/** The hub's options when the last finished run is not resumable. */
	let hubWithoutResume: string[] = [];

	await suite.step("no config", async () => {
		const llm = new LlmCursor(env);
		const frames = await session(cancelAll, rpc => rpc.turn("E2E-TASK storm-implementer task"), { setup: "off" });
		check("storm role spawn is blocked with no-config", asyncResults(frames).includes("[storm:no-config]"));
		check("other agents are untouched", children(llm.all()).length === 1, `children=${children(llm.all()).length}`);
		check("no storm tool without a config", mains(llm.all()).length > 0 && mains(llm.all()).every(entry => entry.stormTool === null));
	}, 120_000, { always: true });

	await suite.step("setup through Storm's dialog", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			await rpc.prompt("/storm");
			const offered = rpc.dialogs.at(-1)?.options ?? [];
			check("the setup dialog offers approve and cancel", offered.includes(APPROVE) && offered.includes(CANCEL), JSON.stringify(offered));
			check("cancel saves nothing", !existsSync(files.configFile) && files.approvals().length === 0);
			rpc.answer = choose(APPROVE);
			const frames = await rpc.prompt("/storm");
			check("approve saves the config inside this session's profile store", existsSync(files.configFile) && files.configFile.startsWith(join(env.agentDir, "storm", "sessions")));
			check("approve writes one approval record", files.approvals().length === 1, `approvals=${files.approvals().length}`);
			const store = files.storeDir();
			check(
				"the single default approval persists automatic delegation on",
				store !== undefined && (await readAutoDelegationChoice(files.sessionDir)) === "on",
				store === undefined ? "no store" : await readAutoDelegationChoice(files.sessionDir),
			);
			check(
				"automatic delegation is stored beside the config, not inside a target",
				existsSync(files.autoFile) && !existsSync(join(store ?? "missing", "auto-delegation.json")),
				`auto=${existsSync(files.autoFile)} store=${store === undefined ? "none" : existsSync(join(store, "auto-delegation.json"))}`,
			);
			check(
				"the approval asked once, with no separate automatic-delegation prompt",
				rpc.dialogs.length === 2 && rpc.dialogs.every(dialog => !dialog.options.includes("자동 위임 켜기")),
				JSON.stringify(rpc.dialogs),
			);
			check(
				"the approval panel discloses that approval turns automatic delegation on",
				reports(frames).some(report => report.includes(AUTO_DISCLOSURE)),
				reports(frames).map(report => report.slice(0, 300)).join(" | "),
			);
			check("nothing is written to the target's .omp directory or a .gitignore", !existsSync(join(env.project, ".omp")) && !existsSync(join(env.project, ".gitignore")));
			check("no model request during setup", llm.all().length === 0, `requests=${llm.all().length}`);
			const roles = Object.keys(existsSync(files.configFile) ? files.config().roles : {}).sort();
			check("the recommended team has all five roles", same(roles, ["architect", "explorer", "implementer", "quick", "reviewer"]), roles.join(","));
			// This file's later manual scenarios exercise the legacy direct-tool path, so opt out through the real command.
			rpc.answer = choose(LABEL.autoOff);
			await rpc.prompt("/storm auto");
			check("the explicit switch turns automatic delegation off", store !== undefined && (await readAutoDelegationChoice(files.sessionDir)) === "off", store === undefined ? "no store" : await readAutoDelegationChoice(files.sessionDir));
			await rpc.turn("hello");
			const [first] = mains(llm.all());
			check(
				"setup added nothing to the main session",
				first?.messageCount === 1 && first.lastUser.trimEnd().endsWith("hello") && !first.lastUser.includes("<storm"),
				`messages=${first?.messageCount} user=${first?.lastUser.slice(-80)}`,
			);
			check("the main session has the storm tool now", first?.stormTool !== null);
			await rpc.turn(`E2E-STEPS ${JSON.stringify([{ edit: "e2e-auto-off-direct.txt" }])}`);
			check("with automatic delegation off the main session writes directly", existsSync(join(env.project, "e2e-auto-off-direct.txt")));
			rmSync(join(env.project, "e2e-auto-off-direct.txt"), { force: true });
		}, { setup: "off" });
	}, 120_000, { always: true });

	await suite.step("spawn routing outside a run", async () => {
		const llm = new LlmCursor(env);
		const config = await session(cancelAll, async (rpc, files) => {
			await rpc.turn("E2E-TASK storm-implementer storm-quick storm-architect");
			return files.config();
		});
		const kids = children(llm.all());
		const primary = config.roles.implementer?.models[0];
		const effort = /:(\w+)$/.exec(primary ?? "")?.[1];
		const implementer = kids.find(kid => kid.model === modelId(primary) && kid.effort === effort);
		check("the implementer runs on its approved model", implementer !== undefined, `children=${kids.map(kid => `${kid.model}:${kid.effort}`).join(",")} expected=${primary}`);
		check("the approved effort is sent", effort !== undefined && implementer?.effort === effort, `effort=${implementer?.effort} expected=${effort}`);
		const expected = ["implementer", "quick", "architect"].map(id => modelId(config.roles[id]?.models[0]));
		check(
			"each role runs on its own approved model",
			kids.length === 3 && expected.every(model => kids.some(kid => kid.model === model)),
			`children=${kids.map(kid => kid.model).join(",")} expected=${expected.join(",")}`,
		);
		check("only the main session has the storm tool", mains(llm.all()).every(entry => entry.stormTool !== null) && kids.every(kid => kid.stormTool === null));
	});

	await suite.step("request routing: query, change, invalid reply", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			let frames = await rpc.prompt(route({ action: "answer", text: "E2E-ANSWER-42" }, "who reviews?"));
			check("a question costs one side turn", llm.all().filter(entry => entry.who !== "side").length === 1 && llm.of("route").length === 1, `route=${llm.of("route").length}`);
			check("the answer is shown, off the model's context", reports(frames).some(report => report.includes("E2E-ANSWER-42") && report.includes('"excludeFromContext":true')));
			frames = await rpc.prompt(route({ action: "status" }, "how is the team?"));
			check("a status query opens the report", reports(frames).length === 1 && rpc.dialogs.length === 0, `reports=${reports(frames).length}`);

			const change = route({ action: "workers", role: "reviewer", min: 1, max: 3 }, "let three reviewers run");
			const bytes = files.configBytes();
			const approvals = files.approvals().length;
			await rpc.prompt(change);
			check("a change opens the approval dialog", same(rpc.dialogs.at(-1)?.options, [APPROVE, CANCEL]), JSON.stringify(rpc.dialogs.at(-1)));
			check("cancel changes nothing", files.configBytes() === bytes && files.approvals().length === approvals);
			rpc.answer = choose(APPROVE);
			await rpc.prompt(change);
			const workers = files.config().roles.reviewer?.workers;
			check("approve applies the change", typeof workers === "object" && workers.min === 1 && workers.max === 3, JSON.stringify(workers));
			check("approve adds an approval record", files.approvals().length === approvals + 1, `approvals=${files.approvals().length}`);

			rpc.answer = cancelAll;
			const runs = files.runs().length;
			await rpc.prompt("/storm E2E-ROUTE-BAD do something");
			check("an unreadable reply offers run, menu or cancel", same(rpc.dialogs.at(-1)?.options, [FALLBACK.run, FALLBACK.menu, FALLBACK.cancel]), JSON.stringify(rpc.dialogs.at(-1)));
			check("cancel starts nothing", files.runs().length === runs);
			check("every request was classified in one side turn", llm.of("route").length === 5 && mains(llm.all()).length === 0, `route=${llm.of("route").length} main=${mains(llm.all()).length}`);

			await rpc.turn("hello");
			const hello = mains(llm.all()).at(-1);
			check("none of the requests entered the main session", hello?.messageCount === 1 && hello.lastUser.trimEnd().endsWith("hello"), `messages=${hello?.messageCount}`);
		});
	});

	await suite.step("request routing: oversized session history", async () => {
		const path = join(env.work, "oversized-route.jsonl");
		const timestamp = new Date().toISOString();
		// Load a long transcript without making main model calls that could compact the test input.
		const header = { type: "session", version: 3, id: crypto.randomUUID(), timestamp, cwd: env.project };
		const entry = {
			type: "message", id: "afe10000", parentId: null, timestamp,
			message: { role: "user", content: [{ type: "text", text: "historical output\n".repeat(300_000) }], timestamp: Date.now() },
		};
		writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
		try {
			await session(choose(FALLBACK.cancel), async (rpc, files) => {
				const request = route({ action: "answer", text: "E2E-ROUTE-OK" }, "who reviews?");
				const fresh = new LlmCursor(env);
				const frames = await rpc.prompt(request);
				check("the short request routes in a fresh session", fresh.of("route").length === 1 && reports(frames).some(report => report.includes("E2E-ROUTE-OK")));

				const id = rpc.send({ type: "switch_session", sessionPath: path });
				const response = await until(() => rpc.frames.find(frame => frame.type === "response" && frame.id === id), 20_000, "load the long session");
				if (response.success !== true || response.data?.cancelled !== false) {
					throw new Error(`could not load the long session: ${text(response)}`);
				}
				await rpc.identify();
				check("the switch changed the native session id", rpc.sessionId === header.id, `id=${rpc.sessionId} expected=${header.id}`);
				const switched = new StormFiles(env, rpc.sessionId);
				check("a switched native session owns no earlier config", switched.configBytes() === null && files.configBytes() !== null);
				// The switched session needs its own authority; approving it must not read the first session's store.
				await approveTeam(rpc, "on");
				check("the switched session approved its own team", switched.approvals().length === 1 && switched.sessionDir !== files.sessionDir);
				rpc.answer = choose(FALLBACK.cancel);

				const llm = new LlmCursor(env);
				const runs = switched.runIds().size;
				await rpc.prompt(request);
				const dialog = rpc.dialogs.at(-1);
				check("oversized routing offers run, menu or cancel", same(dialog?.options, [FALLBACK.run, FALLBACK.menu, FALLBACK.cancel]));
				const title = dialog?.title ?? "";
				check("the fallback suggests a new session instead of exposing a raw error", title.includes("/new") && !/byte limit|raw-http-request/i.test(title), title);
				const requests = llm.all();
				check("oversized routing makes no provider request", requests.length === 0, `requests=${requests.map(entry => entry.who).join(",")}`);
				check("cancelling oversized routing creates no run", switched.runIds().size === runs);
			});
		} finally {
			rmSync(path, { force: true });
		}
	});

	await suite.step("request routing: work becomes a run", async () => {
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan(
				[
					{ name: "impl", kind: "code", results: [trackedAnswer("routing-impl-answer", "the implementer reports the tracked fixture from source")] },
					{ name: "scope", kind: "explore", results: [trackedAnswer("routing-scope-answer", "the explorer reports the tracked fixture from source")] },
					{ name: "review", kind: "review" },
				],
				{ implementer: 2 },
			),
			// The implementer is the only writer; the explorer runs beside it. The reviewer has a shell, so it is ordered
			// like a writer (0.27.0, P1-c: a call carries one writing lane, and no writer starts beside a running one):
			// it follows the implementer's end, and the second implementer follows the reviewer's. Each wait is
			// repeated because omp's wait may return on the first of two children; a second one with nothing left to
			// wait for returns at once.
			{ task: ["storm-implementer", "storm-explorer"], as: "W", say: READ_AND_CLAIM },
			{ wait: true },
			{ wait: true },
			{ task: ["storm-reviewer"], as: "Rev", say: READ_AND_CLAIM },
			{ wait: true },
			{ wait: true },
			{ task: ["task"], as: "Task", say: READ_AND_CLAIM },
		];
		const request = `E2E-ROUTE ${JSON.stringify({ action: "run" })} E2E-STEPS ${JSON.stringify(steps)}`;
		let frames: Frame[] = [];
		let dialogs = 0;
		const fixture = await session(
			cancelAll,
			async (rpc, files) => {
				const done = await runOf(rpc, files, `/storm ${request}`);
				dialogs = rpc.dialogs.length;
				frames = rpc.frames;
				// The janitor and reset steps reopen this exact native session, not a new one in the same checkout.
				routedSession = { id: rpc.sessionId, dir: rpc.sessionDir };
				return { run: done, files };
			},
			// The janitor trusts artifacts below the profile's host session root, so this fixture uses that root and
			// the later steps reopen it there.
			{ model: OUTSIDER, flags: ["--smol", OUTSIDER], sessionDir: join(env.agentDir, "sessions") },
		);
		const run = fixture.run;
		const files = fixture.files;
		routedRunId = run.runId;
		const config = files.config();
		const director = mains(llm.all());
		// omp puts its date reminder in front of the first user message.
		const handoff = (director[0]?.lastUser ?? "").replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, "");
		// A hook's `additionalContext` reaches the model as a user message too (omp 19.2.1): those are Storm's notes about the
		// director's own calls, they start no turn, and each begins with the `[storm` tag.
		const sent = new Set(director.flatMap(entry => entry.users).filter(user => !user.startsWith("<system-notice>") && !user.startsWith("[storm")));
		check("one side turn classified it", llm.of("route").length === 1, `route=${llm.of("route").length}`);
		check("the handoff is the only user message Storm sends", sent.size === 1 && director[0]?.messageCount === 1, `user messages=${sent.size}`);
		const firstLine = handoff.split("\n", 1)[0] ?? "";
		check("the handoff opens with the run tag, no keyword", /^<storm-run id="run-\d{8}-\d{6}-[0-9a-f]{4}" config="[0-9a-f]{12}">$/.test(firstLine), firstLine);
		check("no omp keyword notice rides along", director.length > 0 && director.every(entry => !entry.keywordNotice));
		check("the task is passed on verbatim", handoff.includes(request));
		const frame = handoff.length - request.length;
		check("the handoff stays within 1,400 chars besides the task", frame > 200 && frame <= 1_400, `chars=${frame}`);

		check("a classified run opens no dialog", dialogs === 0, `dialogs=${dialogs}`);
		check(
			"the run record keeps the whole request and, for a team without a rounds limit, no round cap",
			run.request === request && run.task.length <= 200 && run.maxRounds === undefined,
			`request=${run.request === request} task=${run.task.length} maxRounds=${run.maxRounds}`,
		);
		check("the accepted answers close the run after one round", run.endReason === "verified" && run.status === "done" && run.turns === 1 && run.results?.every(row => row.state === "accepted") === true, `${run.endReason} ${run.status} turns=${run.turns}`);
		const outcome = (agent: string) => run.spawns.find(spawn => spawn.agent === agent);
		check(
			"storm roles are routed, outside models are swapped for the role's",
			outcome("storm-implementer")?.outcome === "routed" &&
				outcome("storm-explorer")?.outcome === "routed" &&
				outcome("storm-explorer")?.role === "explorer" &&
				outcome("storm-reviewer")?.outcome === "routed" &&
				outcome("task")?.outcome === "substituted" &&
				outcome("task")?.role === "implementer",
			JSON.stringify(run.spawns.map(spawn => [spawn.agent, spawn.outcome, spawn.role])),
		);
		const approved = new Set(Object.values(config.roles).flatMap(role => role.models.map(modelId)));
		const kids = children(llm.all());
		check("every subagent ran on an approved model", kids.length >= 4 && kids.every(kid => approved.has(kid.model)), kids.map(kid => kid.model).join(","));
		const ledger = run.agents ?? [];
		check(
			"the agent ledger has role, model and context",
			ledger.length === 4 && ledger.every(agent => agent.contextTokens > 0 && agent.model !== undefined) && ledger.some(agent => agent.role === "reviewer"),
			JSON.stringify(ledger.map(agent => [agent.id, agent.role, agent.model, agent.contextTokens])),
		);
		check("spawn records link to ledger agents", run.spawns.length === 4 && run.spawns.every(spawn => ledger.some(agent => agent.id === spawn.spawnKey)));
		check("the plan is in the record", run.plan?.lanes.length === 3 && run.plan.workers.implementer === 2, JSON.stringify(run.plan?.workers));
		const summary = files.index().find(line => line.runId === run.runId);
		check("the run summary index has its actual outcome", summary?.schema === "storm.run-summary/v1" && summary.endReason === run.endReason && summary.turns === 1, JSON.stringify(summary));
		check("the run's report is in the transcript, off the model's context", reports(frames).some(report => report.includes(run.runId) && report.includes('"excludeFromContext":true')));

		const verdict = ledger.find(agent => agent.role === "reviewer")?.review;
		check(
			"review tally: one failed review, one P1 finding, one doc finding",
			verdict?.reviews === 1 && verdict.failed === 1 && verdict.findings[1] === 1 && verdict.docFindings === 1,
			JSON.stringify(verdict),
		);
		check("the index counts the doc finding", summary?.reviews?.docFindings === 1 && summary.reviews.failed === 1, JSON.stringify(summary?.reviews));

		// The fake LLM logs a hash of the doc rules section each system prompt carries; the sections come from Storm.
		const variant = (agent: string): string | undefined => {
			const section = docPromptFor(agent, config);
			return section === undefined ? undefined : new Bun.CryptoHasher("sha256").update(section).digest("hex").slice(0, 12);
		};
		// One entry per variant, not per request: a child with a read and a claim makes two requests with the same rules.
		const seen = [...new Set(kids.filter(kid => kid.lastUser.includes("e2e child")).map(kid => kid.docRules?.hash ?? null))];
		const count = (hash: string | undefined) => seen.filter(value => value === hash).length;
		check("doc rules: nothing in the director's prompt", director.every(entry => entry.docRules === null));
		check(
			"doc rules: the writing rules reach only the implementer, the review variant only the reviewer",
			variant("storm-implementer") !== variant("storm-reviewer") &&
				variant("storm-explorer") !== variant("storm-implementer") &&
				count(variant("storm-implementer")) === 1 &&
				count(variant("storm-reviewer")) === 1 &&
				count(variant("storm-explorer")) === 1,
			JSON.stringify(seen),
		);
		check("doc rules: omp's own agent (task) gets none", seen.filter(value => value === null).length === 1, JSON.stringify(seen));

		const trusted = readJsonl<{ runId: string; artifactsDir: string; agents: string[] }>(files.trustedFile());
		const entry = trusted.find(line => line.runId === run.runId);
		check(
			"the run is on this machine's trusted list (runs.jsonl) with its agents",
			entry !== undefined && entry.artifactsDir === run.artifactsDir && entry.agents.length === 4,
			`trusted=${trusted.map(line => line.runId).join(",")} run=${run.runId} artifacts=${run.artifactsDir}`,
		);

		const stale = await session(cancelAll, async (rpc, files) => ({
			run: await runOf(rpc, files, runRequest({ action: "run", mode: "loop" }, [plan([{ name: "impl", kind: "code", results: [trackedAnswer("stale-report")] }]), { task: ["storm-implementer"], as: "Impl", say: READ_AND_CLAIM }])),
			dialogs: rpc.dialogs.length,
		}));
		check(
			"a reply that still says mode loop is a plain run",
			stale.dialogs === 0 && stale.run.endReason === "verified" && stale.run.status === "done" && stale.run.turns === 1 && stale.run.limits === undefined,
			`${stale.run.endReason} ${stale.run.status} turns=${stale.run.turns} limits=${JSON.stringify(stale.run.limits)} dialogs=${stale.dialogs}`,
		);
	});

	await suite.step("a run is sent back until its changes are reviewed", async () => {
		const changed = join(env.project, "e2e-rounded.txt");
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code", results: [changeResult("round-change", "e2e-rounded.txt", "storm child change", "the implementer writes e2e-rounded.txt")] },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: "E2E-CHILD-WRITE e2e-rounded.txt" },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const run = await runOf(rpc, files, startRun(steps));
				const roundTag = `<storm-run id="${run.runId}" round="2">`;
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				const director = mains(llm.all());
				const roundAt = director.findIndex(entry => newestUser(entry).startsWith(roundTag));
				check(
					"Storm sent round 2 by itself, exactly once",
					stormMessages.filter(user => user.startsWith(roundTag)).length === 1 && stormMessages.length === 2,
					`rounds=${stormMessages.filter(user => user.startsWith(roundTag)).length} storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`,
				);
				const roundCall = String(JSON.stringify(director[roundAt]?.decision.args));
				check(
					"the round message starts round 2, with no maximum",
					stormMessages.some(user => user.startsWith(roundTag)) && roundAt >= 0 && director[roundAt]?.decision.tool === "task" && roundCall.includes("storm-reviewer"),
					`${director[roundAt]?.decision.tool} ${roundCall.slice(0, 120)}`,
				);
				const implementer = run.agents?.find(agent => agent.role === "implementer");
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				check("round 1's file change is counted", implementer?.changes === 1 && existsSync(changed), `changes=${implementer?.changes} file=${existsSync(changed)}`);
				check("round 2's verdict passes", reviewer?.lastVerdict?.correct === true && (reviewer?.lastVerdict?.at ?? 0) > (implementer?.lastChangeAt ?? 0), JSON.stringify(reviewer?.lastVerdict));
				check("the run ends verified after two rounds", run.status === "done" && run.endReason === "verified" && run.turns === 2, `${run.status} ${run.endReason} turns=${run.turns}`);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "done" && lines[0]?.endReason === "verified" && lines[0]?.turns === 2,
					JSON.stringify(lines),
				);
				check("no dialog before either round", rpc.dialogs.length === 0, JSON.stringify(rpc.dialogs));
			});
		} finally {
			rmSync(changed, { force: true });
		}
	});

	await suite.step("a change made through bash is seen", async () => {
		const tracked = join(env.project, TRACKED_FILE);
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code", results: [changeResult("bash-change", TRACKED_FILE, "storm-child-bash", "the implementer appends its change to the tracked file")] },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Bash", say: `E2E-CHILD-BASH ${TRACKED_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const run = await runOf(rpc, files, startRun(steps));
				const implementer = run.agents?.find(agent => agent.role === "implementer");
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				const childCalls = children(llm.all()).map(kid => kid.decision.tool);
				check(
					"the implementer changed a tracked file with bash, through no edit tool",
					childCalls.includes("bash") && !childCalls.some(tool => tool === "write" || tool === "edit") && readFileSync(tracked, "utf8").includes("storm-child-bash"),
					`tools=${childCalls.join(",")} file=${readFileSync(tracked, "utf8").trim().slice(-40)}`,
				);
				check("the bash change is not a tool change", (implementer?.changes ?? 0) === 0, `changes=${implementer?.changes}`);
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				const roundTag = `<storm-run id="${run.runId}" round="2">`;
				check("the changed tree brings a second round", stormMessages.filter(user => user.startsWith(roundTag)).length === 1 && stormMessages.length === 2, `storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`);
				check("round 2's verdict passes on the changed tree", reviewer?.lastVerdict?.correct === true && reviewer?.lastVerdict?.tree !== undefined, JSON.stringify(reviewer?.lastVerdict));
				check("the run ends verified after two rounds", run.status === "done" && run.endReason === "verified" && run.turns === 2, `${run.status} ${run.endReason} turns=${run.turns}`);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "done" && lines[0]?.endReason === "verified" && lines[0]?.turns === 2,
					JSON.stringify(lines),
				);
			});
		} finally {
			writeFileSync(tracked, TRACKED_TEXT);
		}
	});

	await suite.step("the quick role's changes need no review", async () => {
		const changed = join(env.project, "e2e-quick.txt");
		const llm = new LlmCursor(env);
		const steps: Step[] = [plan([{ name: "impl", kind: "run", results: [changeResult("quick-change", "e2e-quick.txt", "storm child change", "the quick worker writes e2e-quick.txt")] }]), { task: ["storm-quick"], as: "Quick", say: "E2E-CHILD-WRITE e2e-quick.txt" }];
		try {
			await session(cancelAll, async (rpc, files) => {
				const run = await runOf(rpc, files, startRun(steps));
				const quick = run.agents?.find(agent => agent.role === "quick");
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				check("the quick worker's change is counted", quick?.changes === 1 && existsSync(changed), `changes=${quick?.changes} file=${existsSync(changed)}`);
				check("no round followed: the quick role needs no reviewer", stormMessages.length === 1 && !stormMessages.some(user => user.includes('round="2"')), `storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`);
				check("the run ends unreviewed after one round", run.status === "ended" && run.endReason === "unreviewed" && run.turns === 1, `${run.status} ${run.endReason} turns=${run.turns}`);
				const lines = files.index().filter(line => line.runId === run.runId);
				check("the index line agrees, once", lines.length === 1 && lines[0]?.status === "ended" && lines[0]?.endReason === "unreviewed" && lines[0]?.turns === 1, JSON.stringify(lines));
				check("no dialog", rpc.dialogs.length === 0, JSON.stringify(rpc.dialogs));
			});
		} finally {
			rmSync(changed, { force: true });
		}
	});

	await suite.step("a change that was committed is still seen", async () => {
		const committed = join(env.project, COMMIT_FILE);
		const before = Bun.spawnSync(["git", "-C", env.project, "rev-parse", "HEAD"]).stdout.toString().trim();
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code", results: [changeResult("commit-change", COMMIT_FILE, "storm-child-bash", "the implementer commits its change to the tracked file")] },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Commit", say: `E2E-CHILD-COMMIT ${COMMIT_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
		];
		await session(cancelAll, async (rpc, files) => {
			const run = await runOf(rpc, files, startRun(steps));
			const implementer = run.agents?.find(agent => agent.role === "implementer");
			const reviewer = run.agents?.find(agent => agent.role === "reviewer");
			const childCalls = children(llm.all()).map(kid => kid.decision.tool);
			const dirty = Bun.spawnSync(["git", "-C", env.project, "status", "--porcelain", "--", COMMIT_FILE]).stdout.toString().trim();
			const head = Bun.spawnSync(["git", "-C", env.project, "rev-parse", "HEAD"]).stdout.toString().trim();
			check(
				"the implementer changed and committed a tracked file with bash",
				childCalls.includes("bash") && !childCalls.includes("write") && !childCalls.includes("edit") && head !== before && dirty === "" && readFileSync(committed, "utf8").includes("storm-child-bash"),
				`tools=${childCalls.join(",")} head=${head.slice(0, 8)} before=${before.slice(0, 8)} dirty=${JSON.stringify(dirty)}`,
			);
			const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
			const roundTag = `<storm-run id="${run.runId}" round="2">`;
			check(
				"the commit hides neither the change nor the round",
				(implementer?.changes ?? 0) === 0 && stormMessages.filter(user => user.startsWith(roundTag)).length === 1 && stormMessages.length === 2,
				`changes=${implementer?.changes} storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`,
			);
			check("round 2's verdict passes on the committed change", reviewer?.lastVerdict?.correct === true && reviewer?.lastVerdict?.tree !== undefined, JSON.stringify(reviewer?.lastVerdict));
			check("the run ends verified after two rounds", run.status === "done" && run.endReason === "verified" && run.turns === 2, `${run.status} ${run.endReason} turns=${run.turns}`);
			const lines = files.index().filter(line => line.runId === run.runId);
			check(
				"the index line agrees, once",
				lines.length === 1 && lines[0]?.status === "done" && lines[0]?.endReason === "verified" && lines[0]?.turns === 2,
				JSON.stringify(lines),
			);
			check("the run left no git index lock and git status works", gitUsable(), "index.lock or git status failed");
		});
	});

	await suite.step("a second outside change stops unverified instead of sending rounds forever", async () => {
		const reviewed = join(env.project, REVIEW_FILE);
		const llm = new LlmCursor(env);
		const change = `printf '%s\\n' storm-director-change >> ${REVIEW_FILE}`;
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code", results: [changeResult("outside-change", REVIEW_FILE, "storm-child-bash", "the implementer appends its change to the reviewed file")] },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-BASH ${REVIEW_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
			// `task` returns when the spawn is queued: each director change waits for the reviewer's result so it lands
			// after the verdict, with no other agent active after it.
			{ bash: change, afterResult: "Rev0" },
			{ task: ["storm-reviewer"], as: "Again", say: "E2E-CHILD-VERDICT correct", after: 'round="3"' },
			{ bash: change, afterResult: "Again0" },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const run = await runOf(rpc, files, startRun(steps));
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				const round = (n: number) => stormMessages.filter(user => user.startsWith(`<storm-run id="${run.runId}" round="${n}">`)).length;
				const reviewers = run.agents?.filter(agent => agent.role === "reviewer") ?? [];
				check(
					// Round 3 only re-reviews a tree the outside writer moved: quiet, so round 4 is the one more chance it gets.
					"re-reviewing an outside writer's tree is a quiet round: one more round, then no fifth",
					stormMessages.length === 4 && round(2) === 1 && round(3) === 1 && round(4) === 1 && round(5) === 0,
					`storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")} agents=${JSON.stringify(run.agents?.map(agent => [agent.id, agent.lastActivityAt, agent.lastVerdict?.at]))}`,
				);
				check("both reviews pass", reviewers.length === 2 && reviewers.every(agent => agent.lastVerdict?.correct === true), JSON.stringify(reviewers.map(agent => agent.lastVerdict)));
				const content = readFileSync(reviewed, "utf8");
				check(
					"the changes after both verdicts are in the tree",
					content.split("storm-child-bash").length - 1 === 1 && content.split("storm-director-change").length - 1 === 2,
					`content=${JSON.stringify(content)}`,
				);
				check(
					"the second verdict cannot verify a later change",
					run.status === "stopped" && run.endReason === "no-progress" && run.turns === 4,
					`${run.status} ${run.endReason} turns=${run.turns}`,
				);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "stopped" && lines[0]?.endReason === "no-progress" && lines[0]?.turns === 4,
					JSON.stringify(lines),
				);
				check("the run left no git index lock and git status works", gitUsable(), "index.lock or git status failed");
			});
		} finally {
			writeFileSync(reviewed, REVIEW_TEXT);
		}
	});

	await suite.step("a team change after a re-review of an outside change is sent back again", async () => {
		const reviewed = join(env.project, REVIEW_FILE);
		const llm = new LlmCursor(env);
		const change = `printf '%s\\n' storm-director-change >> ${REVIEW_FILE}`;
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code", results: [changeResult("team-change", REVIEW_FILE, "storm-child-bash", "each implementer appends its change to the reviewed file")] },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-BASH ${REVIEW_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
			{ bash: change, afterResult: "Rev0" },
			{ task: ["storm-reviewer"], as: "Again", say: "E2E-CHILD-VERDICT correct", after: 'round="3"' },
			// An agent changes the file after the re-review's verdict: a team change, not an outside writer's tree.
			{ task: ["storm-implementer"], as: "Fix", say: `E2E-CHILD-BASH ${REVIEW_FILE}`, afterResult: "Again0" },
			{ task: ["storm-reviewer"], as: "Final", say: "E2E-CHILD-VERDICT correct", after: 'round="4"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const run = await runOf(rpc, files, startRun(steps));
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				const round = (n: number) => stormMessages.filter(user => user.startsWith(`<storm-run id="${run.runId}" round="${n}">`)).length;
				const reviewers = run.agents?.filter(agent => agent.role === "reviewer") ?? [];
				const fix = run.agents?.find(agent => agent.id === "Fix0");
				const last = reviewers.find(agent => agent.id === "Final0");
				check(
					"the team change after the re-review is sent back again",
					stormMessages.length === 4 && round(2) === 1 && round(3) === 1 && round(4) === 1 && round(5) === 0,
					`storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`,
				);
				check(
					"the last verdict follows the agent's change",
					reviewers.length === 3 && reviewers.every(agent => agent.lastVerdict?.correct === true) && last !== undefined && fix !== undefined && (last.lastVerdict?.at ?? 0) > (fix.lastActivityAt ?? 0),
					`reviewers=${JSON.stringify(reviewers.map(agent => [agent.id, agent.lastVerdict]))} fix=${fix?.lastActivityAt}`,
				);
				const content = readFileSync(reviewed, "utf8");
				check(
					"the team change is in the tree",
					content.split("storm-child-bash").length - 1 === 2 && content.split("storm-director-change").length - 1 === 1,
					`content=${JSON.stringify(content)}`,
				);
				check("the run ends verified after four rounds", run.status === "done" && run.endReason === "verified" && run.turns === 4, `${run.status} ${run.endReason} turns=${run.turns}`);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "done" && lines[0]?.endReason === "verified" && lines[0]?.turns === 4,
					JSON.stringify(lines),
				);
				check("the run left no git index lock and git status works", gitUsable(), "index.lock or git status failed");
			});
		} finally {
			writeFileSync(reviewed, REVIEW_TEXT);
		}
	});

	await suite.step("a team without a rounds limit keeps sending rounds past four while each one moves", async () => {
		const reviewed = join(env.project, REVIEW_FILE);
		const llm = new LlmCursor(env);
		// Each review is followed by a team change, so every round moves and the run needs a fifth round to verify.
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code", results: [changeResult("long-change", REVIEW_FILE, "storm-child-bash", "each implementer appends its change to the reviewed file")] },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-BASH ${REVIEW_FILE}` },
			{ task: ["storm-reviewer"], as: "RevA", say: "E2E-CHILD-VERDICT correct", after: 'round="2"' },
			{ task: ["storm-implementer"], as: "FixA", say: `E2E-CHILD-BASH ${REVIEW_FILE}`, afterResult: "RevA0" },
			{ task: ["storm-reviewer"], as: "RevB", say: "E2E-CHILD-VERDICT correct", after: 'round="3"' },
			{ task: ["storm-implementer"], as: "FixB", say: `E2E-CHILD-BASH ${REVIEW_FILE}`, afterResult: "RevB0" },
			{ task: ["storm-reviewer"], as: "RevC", say: "E2E-CHILD-VERDICT correct", after: 'round="4"' },
			{ task: ["storm-implementer"], as: "FixC", say: `E2E-CHILD-BASH ${REVIEW_FILE}`, afterResult: "RevC0" },
			{ task: ["storm-reviewer"], as: "Final", say: "E2E-CHILD-VERDICT correct", after: 'round="5"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const run = await runOf(rpc, files, startRun(steps));
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				const round = (n: number) => stormMessages.filter(user => user.startsWith(`<storm-run id="${run.runId}" round="${n}">`)).length;
				check(
					"rounds 2 to 5 were each sent once, with no maximum in the tag",
					stormMessages.length === 5 && [2, 3, 4, 5].every(n => round(n) === 1) && round(6) === 0 && !stormMessages.some(user => /round="\d+\/\d+"/.test(user)),
					`storm=${stormMessages.map(user => user.slice(0, 60)).join(" | ")}`,
				);
				const reviewers = run.agents?.filter(agent => agent.role === "reviewer") ?? [];
				const lastFix = run.agents?.find(agent => agent.id === "FixC0");
				const last = reviewers.find(agent => agent.id === "Final0");
				check(
					"the last verdict follows the last team change",
					reviewers.length === 4 && reviewers.every(agent => agent.lastVerdict?.correct === true) && last !== undefined && lastFix !== undefined && (last.lastVerdict?.at ?? 0) > (lastFix.lastActivityAt ?? 0),
					`reviewers=${JSON.stringify(reviewers.map(agent => [agent.id, agent.lastVerdict]))} fix=${lastFix?.lastActivityAt}`,
				);
				const content = readFileSync(reviewed, "utf8");
				check("all four team changes are in the tree", content.split("storm-child-bash").length - 1 === 4, `content=${JSON.stringify(content)}`);
				check(
					"the run ends verified after five rounds with no round cap recorded",
					run.status === "done" && run.endReason === "verified" && run.turns === 5 && run.maxRounds === undefined,
					`${run.status} ${run.endReason} turns=${run.turns} maxRounds=${run.maxRounds}`,
				);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "done" && lines[0]?.endReason === "verified" && lines[0]?.turns === 5,
					JSON.stringify(lines),
				);
				check("the run left no git index lock and git status works", gitUsable(), "index.lock or git status failed");
			});
		} finally {
			writeFileSync(reviewed, REVIEW_TEXT);
		}
	});

	await suite.step("a run that makes no progress is stopped", async () => {
		const changed = join(env.project, "e2e-stalled.txt");
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code", results: [changeResult("stalled-change", "e2e-stalled.txt", "storm child change", "the implementer writes e2e-stalled.txt")] },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: "E2E-CHILD-WRITE e2e-stalled.txt" },
		];
		// The hub while the finished run before this one is the last: its options without a resumable run.
		hubWithoutResume = await session(cancelAll, async rpc => {
			await rpc.prompt("/storm");
			return rpc.dialogs.at(-1)?.options ?? [];
		});
		try {
			await session(cancelAll, async (rpc, files) => {
				const run = await runOf(rpc, files, startRun(steps));
				const users = [...new Set(mains(llm.all()).map(newestUser))];
				const stormMessages = users.filter(user => user.startsWith("<storm-run"));
				const round = (n: number) => users.filter(user => user.startsWith(`<storm-run id="${run.runId}" round="${n}">`)).length;
				// One quiet round may be a slow repair and gets another round; the second quiet round in a row ends the run.
				check(
					"the first quiet round brings round 3, and no fourth round followed",
					stormMessages.length === 3 && round(2) === 1 && round(3) === 1 && round(4) === 0,
					`storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`,
				);
				const implementer = run.agents?.find(agent => agent.role === "implementer");
				check("round 1's change is counted", implementer?.changes === 1 && existsSync(changed), `changes=${implementer?.changes} file=${existsSync(changed)}`);
				check("the run stops with no progress after two quiet rounds", run.status === "stopped" && run.endReason === "no-progress" && run.turns === 3, `${run.status} ${run.endReason} turns=${run.turns}`);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "stopped" && lines[0]?.endReason === "no-progress" && lines[0]?.turns === 3,
					JSON.stringify(lines),
				);
			});
		} finally {
			rmSync(changed, { force: true });
		}
	});

	await suite.step("a run that stopped is resumed", async () => {
		const limited = join(env.project, "e2e-limited.txt");
		// The director's typed brief: one numbered new-scope run and one user-owned step. The change is never reviewed,
		// so the run ends at its round limit with a measurable open state: the whole card, never the one-line tier.
		const limitBrief = {
			result: "E2E-LIMIT-RESULT: the change was written but no reviewer judged it.",
			verification: "E2E-LIMIT-EVIDENCE: only the child's own write was observed.",
			remaining: "E2E-LIMIT-REMAINING: the change still needs a review.",
			next: [runNext("E2E-LIMIT-NEXT review the limited change only", "E2E-LIMIT-WHY: the change is unreviewed"), userNext("E2E-LIMIT-USER decide whether the change should stay")],
		};
		const steps: Step[] = [
			plan([{ name: "impl", kind: "code", results: [changeResult("limited-change", "e2e-limited.txt", "storm-child-bash", "the implementer appends its change to e2e-limited.txt")] }]),
			{ task: ["storm-implementer"], as: "Impl", say: "E2E-CHILD-BASH e2e-limited.txt" },
			{ storm: { action: "brief", brief: limitBrief } },
		];
		try {
			// The old run stops at its own two-round limit, so its record keeps a limit for the resume to carry.
			let origin: { id: string; dir: string } | undefined;
			const old = await session(cancelAll, async (rpc, files) => {
				origin = { id: rpc.sessionId, dir: rpc.sessionDir };
				const from = rpc.frames.length;
				const run = await runOf(rpc, files, runRequest({ action: "run", rounds: 2 }, steps));
				const card = closeoutOf(rpc.frames, run.runId, from);
				const body = closeoutBody(card?.text ?? "");
				const offers = offeredDirections(body);
				check(
					"the stopped run's closeout is a whole card whose plain text is the readable fallback",
					card !== undefined && card.text.trimStart().startsWith(`### ${CLOSEOUT_HEADING}`) && card.details?.kind === "closeout" && card.details.runId === run.runId && body.length > 1,
					JSON.stringify(card ?? null).slice(0, 800),
				);
				const directorAt = card?.text.indexOf("E2E-LIMIT-RESULT") ?? -1;
				check(
					"the official state leads, the director's bounded text follows, and detail is one status pointer",
					directorAt > 0 && !(body[0] ?? "").includes("E2E-LIMIT-RESULT") && card?.text.includes(CLOSEOUT_DETAIL) === true && card.text.includes("E2E-LIMIT-REMAINING"),
					card?.text.slice(0, 900) ?? "no card",
				);
				check(
					"verification prose, unfinished lanes and receipts moved off the card",
					card !== undefined && !card.text.includes("E2E-LIMIT-EVIDENCE") && !card.text.includes("미완료 레인") && !card.text.includes("잡 영수증"),
					card?.text.slice(0, 900) ?? "no card",
				);
				check(
					"the closed-out run leaves exactly one settled-run message",
					stormRecords(rpc.frames, from).filter(record => record.text.includes(CLOSEOUT_HEADING)).length === 1,
					JSON.stringify(stormRecords(rpc.frames, from).map(record => record.text.slice(0, 80))),
				);
				check(
					"only dispatchable actions are offered: the proposed run first, the user-owned step as prose",
					offers.length >= 1 && offers.length <= 3 && offers[0]?.includes("E2E-LIMIT-NEXT") === true &&
						!offers.some(offer => offer.includes("E2E-LIMIT-USER")) && card?.text.includes("E2E-LIMIT-USER") === true,
					JSON.stringify(offers),
				);
				check("the record left the round-limit facts on disk", pendingLanesOf(run) !== undefined, JSON.stringify(run.closeoutFacts ?? null));
				// Settling makes no model call of its own, and the status view is read from disk without one either.
				const quiet = new LlmCursor(env);
				await Bun.sleep(1_500);
				const statusFrom = rpc.frames.length;
				await rpc.prompt("/storm status");
				const status = stormRecords(rpc.frames, statusFrom).at(-1)?.text ?? "";
				check(
					"the status view carries what left the card: the director's verification and the open result",
					status.includes("E2E-LIMIT-EVIDENCE") && status.includes("limited-change"),
					status.slice(0, 1200),
				);
				check("neither settling nor the status view asked the model anything", quiet.all().length === 0, JSON.stringify(quiet.all().map(entry => [entry.who, entry.lastUser.slice(0, 80)])));
				check(
					"a fresh run carries no goal and draws no goal line on its card or in the status view",
					run.goal === undefined && card !== undefined && !card.text.includes(GOAL_LABEL) && status !== "" && !status.includes(GOAL_LABEL),
					`goal=${JSON.stringify(run.goal ?? null)} status=${status.slice(0, 600)}`,
				);
				return run;
			});
			if (origin === undefined) throw new Error("the old run's session was not captured");
			const stopped = origin;
			stoppedSession = stopped;
			check(
				"the old run stopped at its round limit",
				old.status === "stopped" && old.endReason === "round-limit" && old.limits?.rounds === 2 && old.maxRounds === 2,
				`${old.status} ${old.endReason} limits=${JSON.stringify(old.limits)} maxRounds=${old.maxRounds}`,
			);

			/** The settled run's card and the user's status view read right after it, from this session's frames. */
			const settledViews = async (rpc: Rpc, run: RunRecord, from: number): Promise<{ card: string; status: string }> => {
				const card = closeoutOf(rpc.frames, run.runId, from)?.text ?? "";
				const statusFrom = rpc.frames.length;
				await rpc.prompt("/storm status");
				return { card, status: stormRecords(rpc.frames, statusFrom).at(-1)?.text ?? "" };
			};
			const first = new LlmCursor(env);
			const { run: resumed, views: resumedViews } = await session(cancelAll, async (rpc, files) => {
				await rpc.prompt("/storm");
				const menu = rpc.dialogs.at(-1)?.options ?? [];
				check(
					"the hub offers the stopped run first, as one more option",
					hubLabel(menu[0], LABEL.resume) && same(menu.slice(1), hubWithoutResume.filter(option => !hubLabel(option, LABEL.resume))),
					`menu=${JSON.stringify(menu)} without=${JSON.stringify(hubWithoutResume)}`,
				);
				const before = files.runIds();
				const from = rpc.frames.length;
				rpc.answer = choose(LABEL.resume);
				await rpc.prompt("/storm");
				const run = await files.finishedRun(before, 150_000);
				return { run, views: await settledViews(rpc, run, from) };
			}, { resume: stopped.id, sessionDir: stopped.dir, setup: "off" });
			const handoff = mains(first.all()).map(newestUser).find(user => user.startsWith(`<storm-run id="${resumed.runId}"`)) ?? "";
			check(
				"the resumed run records what it continues and the task the continuation derives from the old run (its plan, then the earlier request)",
				resumed.runId !== old.runId && resumed.resumeOf === old.runId && resumed.request !== undefined && old.request !== undefined &&
					resumed.request === continuationTask({ ...old, request: old.request }) && resumed.request.includes(old.request),
				`resumeOf=${resumed.resumeOf} old=${old.runId} request=${resumed.request?.slice(0, 120)}`,
			);
			check("the resumed run carries the old limits", resumed.limits?.rounds === 2 && resumed.maxRounds === 2, `limits=${JSON.stringify(resumed.limits)} maxRounds=${resumed.maxRounds}`);
			check("the handoff names the old run", handoff.includes(old.runId), handoff.slice(0, 240));
			const oldUse = summed([old]);
			check(
				"the resumed run carries the stopped run's cost, time and rounds as its goal",
				resumed.goal?.firstRunId === old.runId && resumed.goal.runs === 1 && resumed.goal.usd === oldUse.usd && resumed.goal.ms === oldUse.ms &&
					resumed.goal.turns === oldUse.turns && oldUse.ms > 0 && oldUse.turns === 2,
				`goal=${JSON.stringify(resumed.goal ?? null)} expected=${JSON.stringify(oldUse)}`,
			);
			check("the resume handoff tells the director what the goal used before", handoff.includes("Goal so far (earlier runs): 1 run,"), handoff.slice(0, 600));
			const resumedGoal = goalText(summed([old, resumed]));
			check(
				"the resumed run's card and the status view show the goal totals, both runs counted",
				resumedGoal !== undefined && resumedViews.card.includes(`${GOAL_LABEL}: ${resumedGoal}`) && resumedViews.status.includes(`- ${GOAL_LABEL}: ${resumedGoal}`),
				`expected=${resumedGoal} card=${resumedViews.card.slice(0, 900)} status=${resumedViews.status.slice(0, 900)}`,
			);

			const second = new LlmCursor(env);
			const { run: again, views: againViews } = await session(cancelAll, async (rpc, files) => {
				const dialogs = rpc.dialogs.length;
				const from = rpc.frames.length;
				const run = await runOf(rpc, files, route({ action: "resume" }, "continue the run that stopped"));
				check("a classified resume opens no dialog", rpc.dialogs.length === dialogs, JSON.stringify(rpc.dialogs));
				return { run, views: await settledViews(rpc, run, from) };
			}, { resume: stopped.id, sessionDir: stopped.dir, setup: "off" });
			const nextHandoff = mains(second.all()).map(newestUser).find(user => user.startsWith(`<storm-run id="${again.runId}"`)) ?? "";
			check(
				"the classified resume continues the run that stopped",
				again.runId !== resumed.runId && again.resumeOf === resumed.runId && again.request === resumed.request && again.limits?.rounds === 2 && again.maxRounds === 2,
				`resumeOf=${again.resumeOf} old=${resumed.runId} request=${again.request === resumed.request} limits=${JSON.stringify(again.limits)}`,
			);
			check("its handoff names the run it continues", nextHandoff.includes(resumed.runId), nextHandoff.slice(0, 240));
			const bothUse = summed([old, resumed]);
			check(
				"a resume of the resume sums both earlier runs and keeps the goal's first run",
				again.goal?.firstRunId === old.runId && again.goal.runs === 2 && again.goal.usd === bothUse.usd && again.goal.ms === bothUse.ms && again.goal.turns === bothUse.turns,
				`goal=${JSON.stringify(again.goal ?? null)} expected=${JSON.stringify(bothUse)}`,
			);
			check("its handoff counts both earlier runs", nextHandoff.includes("Goal so far (earlier runs): 2 runs,"), nextHandoff.slice(0, 600));
			const againGoal = goalText(summed([old, resumed, again]));
			check(
				"its card and the status view show all three runs' totals",
				againGoal !== undefined && againViews.card.includes(`${GOAL_LABEL}: ${againGoal}`) && againViews.status.includes(`- ${GOAL_LABEL}: ${againGoal}`),
				`expected=${againGoal} card=${againViews.card.slice(0, 900)} status=${againViews.status.slice(0, 900)}`,
			);
		} finally {
			rmSync(limited, { force: true });
		}
	});

	await suite.step("a run record that only sits in the repository is not offered", async () => {
		if (stoppedSession === undefined) throw new Error("the stopped-run session from the previous scenario is missing");
		const plantedId = "run-20990101-000000-e2e0";
		const record: RunRecord = {
			schema: "storm.run/v1",
			runId: plantedId,
			configHash: "jcs-sha256:e2e-planted",
			startedAt: "2099-01-01T00:00:00.000Z",
			endedAt: "2099-01-01T00:00:01.000Z",
			status: "stopped",
			endReason: "no-progress",
			task: "E2E planted run",
			request: "E2E planted request",
			costUsd: 0,
			costByModel: {},
			spawns: [],
			process: "99999999:1",
			turns: 1,
			maxRounds: 4,
		};
		await session(cancelAll, async (rpc, files) => {
			const plantedFile = join(files.stateDir, "runs", `${plantedId}.json`);
			writeFileSync(plantedFile, `${JSON.stringify(record, null, 2)}\n`);
			try {
				await rpc.prompt("/storm");
				const menu = rpc.dialogs.at(-1)?.options ?? [];
				check(
					"a planted record does not displace a trusted earlier candidate",
					hubLabel(menu[0], LABEL.resume) && files.runs().at(-1)?.runId === plantedId,
					`menu=${JSON.stringify(menu)} last=${files.runs().at(-1)?.runId}`,
				);
				const before = files.runIds();
				const dialogs = rpc.dialogs.length;
				await rpc.prompt(route({ action: "resume" }, "continue the run that stopped"));
				const resumed = await files.finishedRun(before);
				check(
					"classified resume replays the trusted candidate, not the planted request",
					resumed.resumeOf !== undefined && resumed.resumeOf !== plantedId && resumed.request !== record.request && rpc.dialogs.length === dialogs,
					`resumed=${resumed.resumeOf} dialogs=${rpc.dialogs.length}/${dialogs}`,
				);
			} finally {
				rmSync(plantedFile, { force: true });
			}
		}, { resume: stoppedSession.id, sessionDir: stoppedSession.dir, setup: "off" });
	});

	await suite.step("a run whose process died is offered after the next session start", async () => {
		const llm = new LlmCursor(env);
		const request = startRun([
			plan([{ name: "impl", kind: "code", results: [trackedAnswer("dead-report")] }]),
			{ task: ["storm-implementer"], as: "Die", say: `E2E-CHILD-HOLD-ONCE E2E-DIE-MARK ${READ_AND_CLAIM}` },
			{ awaitChild: true },
		]);
		const killed = new Rpc(env, cancelAll, { model: MAIN });
		await killed.ready();
		await approveTeam(killed, "off");
		const killedFiles = new StormFiles(env, killed.sessionId);
		const killedSession = { id: killed.sessionId, dir: killed.sessionDir };
		const before = killedFiles.runIds();
		await killed.prompt(request);
		const dead = await until(() => killedFiles.runs().find(run => !before.has(run.runId)), 30_000, "the run before the kill");
		await until(() => children(llm.all()).some(kid => kid.lastUser.includes("E2E-DIE-MARK")), 60_000, "the held child");
		check("the run is active when its process is killed", dead.status === "running" && dead.request !== undefined, `${dead.runId} ${dead.status}`);
		await killed.stop();
		await session(cancelAll, async (rpc, files) => {
			await suite.eventually(
				"the dead run is marked stopped at the next session start",
				() => files.run(dead.runId)?.status === "stopped",
				() => JSON.stringify(files.run(dead.runId)?.status),
				30_000,
			);
			await rpc.prompt("/storm");
			const menu = rpc.dialogs.at(-1)?.options ?? [];
			check("the dead run is offered first", hubLabel(menu[0], LABEL.resume), JSON.stringify(menu));
			const started = files.runIds();
			rpc.answer = choose(LABEL.resume);
			await rpc.prompt("/storm");
			const resumed = await files.finishedRun(started, 120_000);
			check("resuming a dead run records what it continues", resumed.request === dead.request && resumed.resumeOf === dead.runId, `resumeOf=${resumed.resumeOf} old=${dead.runId} status=${resumed.status} ${resumed.endReason}`);
		}, { resume: killedSession.id, sessionDir: killedSession.dir, setup: "off" });
	});

	await suite.step("Storm tool actions stay within run scope", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			let frames = await rpc.turn('E2E-TOOL {"action":"status"}');
			const offered = mains(llm.all())[0]?.stormTool;
			check("run tool offers execute and brief but no team mutations", same(offered?.actions, ["run", "plan", "execute", "brief", "status", "agents", "continue"]), JSON.stringify(offered?.actions));
			check("its description stays within 900 chars", (offered?.descriptionChars ?? 0) > 0 && (offered?.descriptionChars ?? 0) <= 900, `chars=${offered?.descriptionChars}`);
			check("status: ok", same(toolOutcomes(frames), [{ action: "status", outcome: "ok", isError: false }]), JSON.stringify(toolOutcomes(frames)));
			frames = await rpc.turn('E2E-TOOL {"action":"agents"}');
			check("agents: ok", same(toolOutcomes(frames), [{ action: "agents", outcome: "ok", isError: false }]), JSON.stringify(toolOutcomes(frames)));
			frames = await rpc.turn(`E2E-TOOL ${JSON.stringify(plan([{ name: "impl", kind: "code", results: [changeResult("tool-plan-change", "e2e-tool-plan.txt", "storm child change", "the planned lane writes e2e-tool-plan.txt when it runs")] }]).storm)}`);
			check("plan outside a run: checked only", same(toolOutcomes(frames), [{ action: "plan", outcome: "ok", isError: false }]), JSON.stringify(toolOutcomes(frames)));
			frames = await rpc.turn('E2E-TOOL {"action":"priority","priority":"cost"}');
			const bytes = files.configBytes();
			check("a team change is no tool action", toolOutcomes(frames).every(result => result.isError) && rpc.dialogs.length === 0 && files.configBytes() === bytes, JSON.stringify(toolOutcomes(frames)));

			const before = files.runIds();
			const from = rpc.frames.length;
			await rpc.prompt(`E2E-TOOL ${JSON.stringify({ action: "run", task: `E2E-STEPS ${JSON.stringify([plan([{ name: "impl", kind: "code", results: [trackedAnswer("tool-run-report")] }]), { task: ["storm-implementer"], as: "Impl", say: READ_AND_CLAIM }])}` })}`);
			const run = await files.finishedRun(before);
			check("run: queued, and started once the turn settled", toolOutcomes(rpc.frames.slice(from))[0]?.outcome === "queued", JSON.stringify(toolOutcomes(rpc.frames.slice(from))));
			check(
				"a run whose workers deliver an accepted answer without editing ends after one round",
				run.status === "done" && run.endReason === "verified" && run.turns === 1 && run.results?.some(row => row.id === "tool-run-report" && row.state === "accepted") === true,
				`${run.status} ${run.endReason} turns=${run.turns} ${JSON.stringify(run.spawns.map(spawn => spawn.outcome))}`,
			);
		});
	});

	await suite.step("approval gate on an unapproved config", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			// A teammate's edit in this session: no architect.
			files.editConfig(config => {
				delete config.roles.architect;
				config.disabledRoles = ["architect"];
			});
			const bytes = files.configBytes();
			const approvals = files.approvals().length;
			let frames = await rpc.turn("E2E-TASK storm-implementer");
			check("spawns are blocked with unapproved", asyncResults(frames).includes("[storm:unapproved]") && children(llm.all()).length === 0);
			const from = rpc.frames.length;
			await rpc.prompt(route({ action: "budget", budgetUsd: 5 }, "cap runs at five dollars"));
			const said = reports(rpc.frames.slice(from));
			check(
				"a change through /storm is rejected without a dialog",
				rpc.dialogs.length === 0 && said.some(report => report.includes(NEEDS_APPROVAL)) && files.configBytes() === bytes && files.approvals().length === approvals,
				`dialogs=${rpc.dialogs.length} reports=${said.length}`,
			);
			frames = await rpc.turn(`E2E-TOOL ${JSON.stringify(plan([{ name: "check", kind: "review" }], { reviewer: 9 }).storm)}`);
			check("a plan past the bounds is rejected by the tool", same(toolOutcomes(frames), [{ action: "plan", outcome: "rejected", isError: false }]) && rpc.dialogs.length === 0, JSON.stringify(toolOutcomes(frames)));
			const runs = files.runs().length;
			await rpc.prompt(route({ action: "run" }, "do the work"));
			check("a run does not start", files.runs().length === runs && rpc.dialogs.length === 0, `runs=${files.runs().length}/${runs} dialogs=${rpc.dialogs.length}`);

			rpc.answer = choose(APPROVE);
			await rpc.prompt("/storm");
			const dialog = rpc.dialogs.at(-1);
			check(
				"/storm asks: approve, go back to an earlier approval, set up again, cancel",
				dialog?.options[0] === APPROVE && dialog.options.includes(LABEL.rollback) && dialog.options.at(-1) === CANCEL && dialog.options.length === 4,
				JSON.stringify(dialog?.options),
			);
			check("approve records the file as it is", files.configBytes() === bytes && files.approvals().length === approvals + 1, `approvals=${files.approvals().length}`);
			await rpc.turn("E2E-TASK storm-implementer");
			check("spawns run again", children(llm.all()).length === 1, `children=${children(llm.all()).length}`);
		});
	});

	await suite.step("spawn enforcement codes", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			// The disabled-role check needs a team without an architect; approve that config in this same session.
			await editAndApprove(rpc, files, config => {
				delete config.roles.architect;
				config.disabledRoles = ["architect"];
			});
			let from = rpc.frames.length;
			const mixedFile = "e2e-mixed-batch.txt";
			const lanes: LaneSpec[] = [
				{ name: "read-a", kind: "explore", role: "explorer", results: [trackedAnswer("read-a-report", "the explorer reports the tracked fixture from source")] },
				{ name: "read-b", kind: "explore", role: "explorer", results: [trackedAnswer("read-b-report", "the explorer reports the tracked fixture from source")] },
				{ name: "read-c", kind: "explore", role: "explorer", results: [trackedAnswer("read-c-report", "the explorer reports the tracked fixture from source")] },
			];
			const gateKey = (lane: string): string => `spawn-cap-${lane}`;
			const holdLane = (lane: string): string => `E2E-CHILD-GATE ${gateKey(lane)} ${READ_AND_CLAIM}`;
			const roleBoundary = ["read-a", "read-b"].map(gateKey);
			const run = await runOf(
				rpc,
				files,
				startRun([
					// Before any plan: a spawn is refused, and the next valid plan still takes effect.
					{ task: ["storm-explorer"], as: "Early" },
					{ ...plan(lanes, { explorer: 2 }), after: "[storm:no-plan]" },
					// One unknown lane rejects the whole native batch before its earlier valid item starts.
					{
						tasks: [
							{ name: "read-a", agent: "storm-explorer", say: `E2E-CHILD-WRITE ${mixedFile}` },
							{ name: "read-missing", agent: "storm-explorer" },
						],
					},
					// Boundary request: both explorer lanes fit the plan's two workers.
					{
						tasks: [
							{ name: "read-a", agent: "storm-explorer", say: holdLane("read-a") },
							{ name: "read-b", agent: "storm-explorer", say: holdLane("read-b") },
						],
					},
					// Reach the provider with both first replies held before making the overflow request. The native
					// default ceiling is above this plan's role cap, so the request reaches Storm's spawn hook.
					{ tasks: [{ name: "read-c", agent: "storm-explorer", say: READ_AND_CLAIM }], awaitChildren: roleBoundary },
					// Keep both alive through the asynchronous spawn decision, then let native wait drain them.
					{ wait: true, afterResult: "Background job read-c has completed.", releaseChildren: roleBoundary },
					{ task: ["storm-architect"], as: "Arch" },
					{ task: ["storm-quick"], as: "Quick" },
					{ wait: true },
				]),
			);
			const results = asyncResults(rpc.frames.slice(from));
			const reasons = rpc.frames.slice(from).map(text).join("\n");
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			const routedLanes = routed.map(spawn => spawn.lane);
			const detail = JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.code]));
			const modelRequests = llm.all();
			const taskRequestIndex = (lane: string): number => modelRequests.findIndex(entry => {
				const tasks = entry.decision.args?.tasks;
				return entry.who === "main" && entry.decision.tool === "task" && Array.isArray(tasks) && tasks.some(task => task.name === lane);
			});
			const probeSawLivePair = (lane: string, keys: string[]): boolean => {
				const probe = taskRequestIndex(lane);
				return probe >= 0 && keys.every(key => {
					const isChild = (entry: LlmEntry): boolean => entry.who === "child" && entry.lastUser.includes(`E2E-CHILD-GATE ${key} `);
					const first = modelRequests.findIndex(isChild);
					const next = modelRequests.findIndex((entry, index) => index > first && isChild(entry));
					return first >= 0 && first < probe && next > probe;
				});
			};
			check("no plan yet: the spawn starts no child and says no-plan", blockCodes(run).includes("no-plan") && results.includes("[storm:no-plan]") && !routed.some(spawn => spawn.spawnKey === "Early0"), detail);
			check(
				"a batch naming an unknown lane starts nothing, not even its valid first item",
				reasons.includes("[storm:lane]") && reasons.includes("read-missing") && !existsSync(join(env.project, mixedFile)) && !children(llm.all()).some(kid => kid.lastUser.includes(mixedFile)),
				`file=${existsSync(join(env.project, mixedFile))} ${detail}`,
			);
			check(
				"the boundary request at the role's planned workers starts both concrete explorer lanes",
				routedLanes.includes("read-a") && routedLanes.includes("read-b") && probeSawLivePair("read-c", roleBoundary),
				detail,
			);
			check(
				"one more live explorer than the plan's workers is not refused for the plan's worker count (the role cap is gone; only omp's ceiling limits it)",
				!reasons.includes("[storm:role-cap]") && run.spawns.find(spawn => spawn.spawnKey === "read-c")?.code !== "role-cap" && routedLanes.includes("read-c"),
				`${detail} reasons=${reasons.slice(0, 300)}`,
			);
			check(
				"a disabled role and a role without a lane are denied without starting a child",
				reasons.includes("storm-architect") && reasons.includes("storm-quick") && !run.spawns.some(spawn => spawn.outcome !== "blocked" && (spawn.agent === "storm-architect" || spawn.role === "architect" || spawn.agent === "storm-quick" || spawn.role === "quick")),
				`${detail} reasons=${reasons.slice(0, 300)}`,
			);
			check("every blocked spawn has a code", run.spawns.filter(spawn => spawn.outcome === "blocked").every(spawn => spawn.code !== undefined), detail);
			check("the role boundary and post-refusal requests ran", routed.length >= 2 && children(llm.all()).length >= 2, detail);

			rpc.answer = choose(APPROVE);
			await rpc.prompt(route({ action: "budget", budgetUsd: 0.0001 }, "cap each run"));
			check("a budget is set through the approval dialog", files.config().budget?.perRunUsd === 0.0001, JSON.stringify(files.config().budget));
			const kids = children(llm.all()).length;
			from = rpc.frames.length;
			const capped = await runOf(rpc, files, startRun([plan([{ name: "impl", kind: "code", results: [trackedAnswer("budget-report")] }]), { tasks: [{ name: "impl", agent: "storm-implementer" }] }]));
			check(
				"past the run budget: budget",
				same(blockCodes(capped), ["budget"]) && asyncResults(rpc.frames.slice(from)).includes("[storm:budget]") && children(llm.all()).length === kids,
				JSON.stringify(capped.spawns.map(spawn => [spawn.outcome, spawn.code])),
			);
			check("the run ends as budget-exceeded", capped.status === "budget-exceeded" && capped.costUsd >= 0.0001, `${capped.status} cost=${capped.costUsd}`);
			await rpc.prompt(route({ action: "budget", budgetUsd: 0 }, "drop the cap"));
			check("budget 0 removes it", files.config().budget === undefined, JSON.stringify(files.config().budget));
		});
	});

	await suite.step("native concurrency: queued starts, managed block at two, and status notes", async () => {
		const profileBefore = readFileSync(PROFILE_FILE);
		// The isolated profile is the only place this limit lives; the real user settings are never touched.
		writeFileSync(PROFILE_FILE, `${PROFILE_CONFIG}task:\n  maxConcurrency: 2\n`);
		const llm = new LlmCursor(env);
		const implFile = "e2e-native-cap.txt";
		try {
			await session(cancelAll, async (rpc, files) => {
				const explorerLane = (name: string): LaneSpec => ({ name, kind: "explore", role: "explorer", results: [trackedAnswer(`${name}-report`, "the explorer reports the tracked fixture from source")] });
				// Run A: two fresh starts hold the native ceiling. A third fresh start queues in the host before Storm's
				// spawn hook, so it makes no provider request until a permit is released. An idle wake is refused by
				// Storm at the same ceiling.
				const queuedLanes: LaneSpec[] = [
					explorerLane("read-a"),
					explorerLane("read-d"),
					{ name: "impl", kind: "code", role: "implementer", results: [trackedAnswer("impl-report", "the implementer reports the tracked fixture from source")] },
					// A reader: a reviewer has a shell and would be refused as a second writer beside `impl` (0.27.0).
					explorerLane("read-e"),
				];
				let from = rpc.frames.length;
				const queued = await runOf(
					rpc,
					files,
					startRun([
						plan(queuedLanes, { explorer: 3, implementer: 1 }),
						// An ordinary child settles and becomes a parked worker, ready for a genuine reactivation.
						{ tasks: [{ name: "read-a", agent: "storm-explorer", say: READ_AND_CLAIM }] },
						{ wait: true, afterResult: "Background job read-a has completed." },
						{
							tasks: [
								{ name: "read-d", agent: "storm-explorer", say: `E2E-CHILD-GATE cap-q-d ${READ_AND_CLAIM}` },
								{ name: "impl", agent: "storm-implementer", say: `E2E-CHILD-GATE cap-q-impl ${READ_AND_CLAIM}` },
							],
						},
						// Both native permits are taken. This third fresh start has a valid planned lane, so only the
						// native semaphore delays it: its spawn hook does not run until a permit is released.
						{ tasks: [{ name: "read-e", agent: "storm-explorer", say: `E2E-CAP-QUEUE-THIRD ${READ_AND_CLAIM}` }], awaitChildren: ["cap-q-d", "cap-q-impl"] },
						// A genuine reactivation of the parked explorer is refused by Storm at the same ceiling.
						{ followUp: "agent://read-a", content: "E2E-CAP-QUEUE-REFUSED" },
						// Freeing the permits lets the queued start reach the hook; the wait reports ordinary task
						// completions as before. Its async result proves the job settled.
						{ wait: true, releaseChildren: ["cap-q-d", "cap-q-impl"], after: "[storm:lane-capacity]" },
						{ wait: true },
						// A freed slot admits the same parked-worker wake on retry.
						{ followUp: "agent://read-a", content: "E2E-CAP-QUEUE-WAKE-LATE" },
						{ wait: true },
					]),
				);
				const queuedReasons = rpc.frames.slice(from).map(text).join("\n");
				const queuedRequests = llm.all();
				const wakeAt = queuedRequests.findIndex(entry => entry.who === "main" && entry.decision.tool === "write" && entry.decision.args?.path === "agent://read-a");
				const releaseAt = queuedRequests.findIndex((entry, index) => index > wakeAt && entry.who === "main" && entry.decision.tool === "wait");
				const queuedProbeAt = queuedRequests.findIndex(entry => {
					const tasks = entry.decision.args?.tasks;
					const items = Array.isArray(tasks) ? tasks : [entry.decision.args];
					return entry.who === "main" && entry.decision.tool === "task" && items.some(item => typeof item?.task === "string" && item.task.includes("E2E-CAP-QUEUE-THIRD"));
				});
				const progressed = rpc.frames.slice(from).filter(frame => frame.type === "tool_execution_end" && frame.toolName === "wait").map(text).join("\n");
				const releasedAt = queuedRequests[releaseAt]?.ts ?? 0;
				const queuedSpawns = queued.spawns.filter(spawn => spawn.spawnKey === "read-e");
				const queuedAfter = queuedSpawns.find(spawn => Date.parse(spawn.ts) >= releasedAt);
				const lateWakeAt = queuedRequests.findIndex(entry => entry.who === "child" && entry.lastUser.includes("E2E-CAP-QUEUE-WAKE-LATE"));
				check(
					"two fresh starts hold the native ceiling and a third fresh start waits without a provider request",
					queuedProbeAt >= 0 && queuedProbeAt < releaseAt && queuedAfter !== undefined && !queuedSpawns.some(spawn => Date.parse(spawn.ts) < releasedAt) && !queuedRequests.some((entry, index) => index < releaseAt && entry.who === "child" && entry.lastUser.includes("E2E-CAP-QUEUE-THIRD")),
					`probe=${queuedProbeAt} release=${releaseAt} after=${JSON.stringify(queuedAfter)} spawns=${JSON.stringify(queued.spawns.map(spawn => [spawn.spawnKey, spawn.outcome, spawn.code, spawn.ts]))}`,
				);
				check(
					"the queued fresh start is unseen by the spawn hook while the native permits are held",
					!queued.spawns.some(spawn => spawn.spawnKey === "read-e" && Date.parse(spawn.ts) < releasedAt),
					`releaseAt=${releasedAt} spawns=${JSON.stringify(queued.spawns.map(spawn => [spawn.agent, spawn.ts, spawn.code]))}`,
				);
				check(
					"an idle worker is refused at two and accepts a later wake after the permits release",
					queuedReasons.includes("[storm:lane-capacity]") &&
						!queuedRequests.some(entry => entry.who === "child" && entry.lastUser.includes("E2E-CAP-QUEUE-REFUSED")) &&
						lateWakeAt > releaseAt && queued.agents?.find(agent => agent.id === "read-a")?.followUps === 1,
					`lateWake=${lateWakeAt} release=${releaseAt} read-a=${JSON.stringify(queued.agents?.find(agent => agent.id === "read-a"))}`,
				);
				check(
					"the wait still reports ordinary task completions",
					progressed.includes("### read-d [task] — completed") && progressed.includes("### impl [task] — completed"),
					progressed.slice(0, 700),
				);

				// Run B: one fresh start holds one native permit while a genuinely resumed parked worker holds the other
				// Storm slot. The host sees one free permit, so a second fresh start reaches Storm's hook and is refused
				// with parallelism. A status note stays a note, and a released slot starts the retry.
				const managedLanes: LaneSpec[] = [
					explorerLane("m-read-a"),
					explorerLane("m-read-b"),
					explorerLane("m-read-d"),
					{ name: "m-impl", kind: "code", role: "implementer", results: [changeResult("managed-impl", implFile, "storm child change", `the implementer writes ${implFile}`)] },
				];
				from = rpc.frames.length;
				const managedStart = llm.all().length;
				const managed = await runOf(
					rpc,
					files,
					startRun([
						plan(managedLanes, { explorer: 3, implementer: 1 }),
						// Both become parked workers before the ceiling is filled; each single-item job has its own result.
						{ tasks: [{ name: "m-read-a", agent: "storm-explorer", say: READ_AND_CLAIM }] },
						{ wait: true, afterResult: "Background job m-read-a has completed." },
						{ tasks: [{ name: "m-read-b", agent: "storm-explorer", say: READ_AND_CLAIM }] },
						{ wait: true, afterResult: "Background job m-read-b has completed." },
						{ tasks: [{ name: "m-read-d", agent: "storm-explorer", say: `E2E-CHILD-GATE cap-m-d ${READ_AND_CLAIM}` }] },
						// Hold both the fresh worker and the woken worker at the provider, rather than relying on timing.
						{ followUp: "agent://m-read-a", content: `E2E-CAP-MANAGED-RESUME E2E-WAKE-GATE cap-m-wake ${READ_AND_CLAIM}` },
						{ tasks: [{ name: "m-impl", agent: "storm-implementer", say: `E2E-CAP-MANAGED-BLOCKED E2E-CHILD-WRITE ${implFile}` }], awaitChildren: ["cap-m-d", "cap-m-wake"] },
						{ edit: "agent://m-read-b?progress", afterResult: "[storm:parallelism]" },
						{ read: "agent://m-read-b", after: "[storm:parallelism]" },
						{ wait: true, releaseChildren: ["cap-m-d", "cap-m-wake"] },
						// The free slot admits the same start on retry; its change result proves it ran.
						{ wait: true },
						{ tasks: [{ name: "m-impl", agent: "storm-implementer", say: `E2E-CAP-MANAGED-LATE E2E-CHILD-WRITE ${implFile}` }] },
						{ wait: true },
					]),
				);
				const managedReasons = rpc.frames.slice(from).map(text).join("\n");
				const managedRequests = llm.all().slice(managedStart);
				const resumeAt = managedRequests.findIndex(entry => entry.who === "child" && entry.lastUser.includes("E2E-CAP-MANAGED-RESUME"));
				const managedWakeAt = managedRequests.findIndex(entry => entry.who === "main" && entry.decision.tool === "write" && entry.decision.args?.path === "agent://m-read-a");
				const blockedProbeAt = managedRequests.findIndex(entry => {
					const tasks = entry.decision.args?.tasks;
					const items = Array.isArray(tasks) ? tasks : [entry.decision.args];
					return entry.who === "main" && entry.decision.tool === "task" && items.some(item => typeof item?.task === "string" && item.task.includes("E2E-CAP-MANAGED-BLOCKED"));
				});
				const managedReleaseAt = managedRequests.findIndex((entry, index) => index > blockedProbeAt && entry.who === "main" && entry.decision.tool === "wait");
				const statusReadAt = managedRequests.findIndex(entry => entry.who === "main" && entry.decision.tool === "read" && entry.decision.args?.path === "agent://m-read-b");
				const lateAt = managedRequests.findIndex(entry => entry.who === "child" && entry.lastUser.includes("E2E-CAP-MANAGED-LATE"));
				const blockedImpl = managed.spawns.find(spawn => spawn.agent === "storm-implementer" && spawn.outcome === "blocked");
				check(
					"one fresh start plus a resumed worker fills native two: the next fresh start is refused with parallelism",
					managedWakeAt >= 0 && managedWakeAt < blockedProbeAt && blockedImpl?.code === "parallelism" && !managedRequests.some(entry => entry.who === "child" && entry.lastUser.includes("E2E-CAP-MANAGED-BLOCKED")),
					`wake=${managedWakeAt} probe=${blockedProbeAt} resume=${resumeAt} blocked=${JSON.stringify(managed.spawns.map(spawn => [spawn.spawnKey, spawn.outcome, spawn.code]))} reasons=${managedReasons.slice(0, 300)}`,
				);
				check(
					"the resumed worker was admitted and took the second slot",
					managed.agents?.find(agent => agent.id === "m-read-a")?.followUps === 1 && resumeAt >= 0 && resumeAt < blockedProbeAt,
					`blockedFollowUps=${managed.blockedFollowUps} read-a=${JSON.stringify(managed.agents?.find(agent => agent.id === "m-read-a"))} resume=${resumeAt}`,
				);
				check(
					"an idle progress note meets no capacity gate (it wakes a worker that can only read and report; a progress note is not a follow-up)",
					statusReadAt >= 0 && statusReadAt < managedReleaseAt && !managedReasons.includes("[storm:lane-capacity]") &&
						managed.agents?.find(agent => agent.id === "m-read-b")?.followUps === 0,
					`read=${statusReadAt} release=${managedReleaseAt} read-b=${JSON.stringify(managed.agents?.find(agent => agent.id === "m-read-b"))}`,
				);
				check(
					"the released slot admits the rejected fresh start on retry",
					lateAt > managedReleaseAt && existsSync(join(env.project, implFile)) && readFileSync(join(env.project, implFile), "utf8") === "storm child change\n" && managed.results?.some(row => row.id === "managed-impl" && row.state === "accepted") === true,
					`late=${lateAt} release=${managedReleaseAt} file=${existsSync(join(env.project, implFile))} results=${JSON.stringify(managed.results)}`,
				);
			});
		} finally {
			writeFileSync(PROFILE_FILE, profileBefore);
			rmSync(join(env.project, implFile), { force: true });
		}
	});

	await suite.step("native above four admits six independently scoped lanes", async () => {
		const profileBefore = readFileSync(PROFILE_FILE);
		writeFileSync(PROFILE_FILE, `${PROFILE_CONFIG}task:\n  maxConcurrency: 6\n`);
		const llm = new LlmCursor(env);
		const filesOut = Array.from({ length: 4 }, (_, index) => `e2e-native6-${index}.txt`);
		const scopeDir = join(env.project, ".omp", "agents");
		const scopeFile = join(scopeDir, "storm-implementer.md");
		mkdirSync(scopeDir, { recursive: true });
		// Shell-capable shared implementers must run sequentially. Approve a path-only worker in this fixture.
		writeFileSync(scopeFile, "---\nname: storm-implementer\ndescription: Scoped writer\ntools: read, write, edit\n---\nWrite only the assigned file.\n");
		try {
			await session(cancelAll, async (rpc, files) => {
				const workers = files.config().roles.implementer?.workers;
				const min = typeof workers === "number" ? workers : workers?.min;
				const max = typeof workers === "number" ? workers : workers?.max;
				check("the recommended team offers one to four implementers", min === 1 && max === 4, JSON.stringify(workers));
				const lanes: LaneSpec[] = [
					...filesOut.map((file, index) => ({ name: `impl-${index}`, kind: "code", role: "implementer", files: [file], results: [changeResult(`native6-${index}`, file, "storm child change", `the implementer writes ${file}`)] })),
					...Array.from({ length: 2 }, (_, index) => ({ name: `read-${index}`, kind: "explore", role: "explorer", results: [trackedAnswer(`native6-read-${index}`, "the explorer reports the tracked fixture from source")] })),
				];
				const barrierLane: LaneSpec = { name: "barrier", kind: "review", role: "reviewer" };
				const gates = lanes.map(lane => `native6-${lane.name}`);
				const tasks = lanes.map((lane, index) => ({
					name: lane.name,
					agent: lane.role === "implementer" ? "storm-implementer" : "storm-explorer",
					say: lane.role === "implementer" ? `E2E-CHILD-GATE ${gates[index]} E2E-CHILD-WRITE ${filesOut[index]}` : `E2E-CHILD-GATE ${gates[index]} ${READ_AND_CLAIM}`,
				}));
				const run = await runOf(
					rpc,
					files,
					startRun([
						plan([...lanes, barrierLane], { implementer: 4, explorer: 2, reviewer: 1 }),
						{ tasks },
						// The barrier is sent only after all six children hold their first reply at the provider; with
						// six native permits taken, it queues and its hook runs only after a release.
						{ tasks: [{ name: "barrier", agent: "storm-reviewer", say: "E2E-NATIVE6-BARRIER E2E-CHILD-VERDICT correct" }], awaitChildren: gates },
						{ wait: true, releaseChildren: gates },
						{ wait: true, afterResult: "Background job barrier has completed." },
					]),
				);
				const requests = llm.all();
				const releaseAt = requests.findIndex(entry => entry.who === "main" && entry.decision.tool === "wait");
				const held = gates.map(gate => requests.findIndex(entry => entry.who === "child" && entry.lastUser.includes(`E2E-CHILD-GATE ${gate} `)));
				const routed = run.spawns.filter(spawn => spawn.spawnKey !== "barrier" && spawn.outcome !== "blocked");
				check(
					"native six admits six genuinely independent lanes at once",
					releaseAt >= 0 && held.every(index => index >= 0 && index < releaseAt) && routed.length === 6 && routed.filter(spawn => spawn.role === "implementer").length === 4 && routed.filter(spawn => spawn.role === "explorer").length === 2,
					`release=${releaseAt} held=${JSON.stringify(held)} spawns=${JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.role, spawn.outcome, spawn.code]))}`,
				);
				check(
					"all six independent lanes settled with accepted results",
					run.results?.filter(row => row.state === "accepted").length === 6 && filesOut.every(file => existsSync(join(env.project, file)) && readFileSync(join(env.project, file), "utf8") === "storm child change\n"),
					`${run.status}/${run.endReason} results=${JSON.stringify(run.results)} files=${filesOut.map(file => existsSync(join(env.project, file))).join(",")}`,
				);
			});
		} finally {
			rmSync(scopeFile, { force: true });
			writeFileSync(PROFILE_FILE, profileBefore);
			for (const file of filesOut) rmSync(join(env.project, file), { force: true });
		}
	});

	await suite.step("director: edit block, read policy, follow-ups", async () => {
		const notes = join(env.project, "notes");
		mkdirSync(notes, { recursive: true });
		const lines = (count: number, line: (n: number) => string) => `${Array.from({ length: count }, (_, n) => line(n + 1)).join("\n")}\n`;
		// Past 16 KiB each: a code file omp folds, and prose it returns verbatim.
		writeFileSync(join(notes, "big.ts"), lines(700, n => `export const value${n} = "e2e evidence line ${n}";`));
		writeFileSync(join(notes, "big.txt"), lines(700, n => `E2E-EVIDENCE-${n} ${"x".repeat(24)}`));
		writeFileSync(join(notes, "small.txt"), lines(5, n => `E2E-SMALL-${n}`));
		writeFileSync(join(notes, "other.txt"), lines(5, n => `E2E-OTHER-${n}`));
		const directed = join(env.project, "director-check.txt");
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			const run = await runOf(
				rpc,
				files,
				startRun([
					plan([{ name: "scope", kind: "explore", results: [{ id: "scope-small", kind: "answer", criterion: "report notes/small.txt line 5 from source", path: "notes/small.txt", contains: "E2E-SMALL-5" }] }]),
					{ task: ["storm-explorer"], as: "Reader", say: "E2E-CHILD-READ notes/big.ts,notes/big.txt,notes/small.txt E2E-CHILD-CLAIM E2E-SMALL-5 is line 5 of notes/small.txt (notes/small.txt:5)" },
					{ edit: "director-check.txt", afterResult: "Reader0" },
					// An address is still not a project file the table can name: refused with its cause (0.28.0 opens plain project paths only).
					{ edit: "vault://director-check.md" },
					{ read: "notes/big.ts" },
					{ read: "notes/big.txt" },
					{ read: "notes/big.txt:1-500" },
					{ read: "notes/big.txt:1-10" },
					{ read: "notes/small.txt" },
					{ read: "notes/other.txt" },
					{ followUp: "agent://Reader0" },
					{ followUp: "agent://Reader0" },
				]),
			);
			const results = mains(llm.all()).map(entry => entry.lastTool);
			const answerTo = (index: number) => results[index + 1] ?? "";
			const director = mains(llm.all());
			const resultOf = (path: string) => answerTo(director.findIndex(entry => entry.decision.tool === "read" && entry.decision.args?.path === path));
			// 0.28.0 (decision: the director's own edits during a run): a plain project file is written once no writer holds the tree; an address stays refused.
			check("the director's own write of a project file passes (the run is open and the worker has ended), and a write to an address is blocked with director-edit", existsSync(directed) && run.blockedEdits === 1 && results.some(result => result.includes("[storm:director-edit]")), `file=${existsSync(directed)} blockedEdits=${run.blockedEdits}`);
			check("a bare read of a large code file passes", resultOf("notes/big.ts") !== "" && !resultOf("notes/big.ts").includes("[storm:"), resultOf("notes/big.ts").slice(0, 80));
			check("a bare read of large prose passes too (omp pages it)", resultOf("notes/big.txt").includes("E2E-EVIDENCE-2") && !resultOf("notes/big.txt").includes("[storm:"), resultOf("notes/big.txt").slice(0, 120));
			const refused = resultOf("notes/big.txt:1-500");
			check("a 500-line range is not refused for its size (the director's reads are only counted)", !refused.includes("[storm:read-large]") && refused.includes("E2E-EVIDENCE-2"), refused.slice(0, 120));
			check("a 10-line range passes", resultOf("notes/big.txt:1-10").includes("E2E-EVIDENCE-2") && !resultOf("notes/big.txt:1-10").includes("[storm:"));
			check("a small file passes whole", resultOf("notes/small.txt").includes("E2E-SMALL-5") && !resultOf("notes/small.txt").includes("[storm:"));
			const reads = run.reads;
			check(
				"the run record counts reads: 6 returned, none blocked (a read is never refused for its size), shared chars below the total",
				reads?.director === 6 && (reads.blocked ?? 0) === 0 && reads.directorChars > 0 && reads.duplicateChars > 0 && reads.duplicateChars < reads.directorChars,
				JSON.stringify(reads),
			);
			check("the index carries the same numbers", same(files.index().find(line => line.runId === run.runId)?.reads, reads), JSON.stringify(files.index().find(line => line.runId === run.runId)?.reads));

			const writes = rpc.frames.filter(frame => frame.type === "tool_execution_start" && frame.toolName === "write" && frame.args?.path === "agent://Reader0");
			const ok = writes.filter(start => rpc.frames.some(end => end.type === "tool_execution_end" && end.toolCallId === start.toolCallId && end.isError !== true)).length;
			const reader = run.agents?.find(agent => agent.id === "Reader0");
			check("follow-ups counted equal the writes delivered", ok === 2 && reader?.followUps === ok && (run.blockedFollowUps ?? 0) === 0, `delivered=${ok} followUps=${reader?.followUps}`);
		});
		rmSync(notes, { recursive: true, force: true });
	});

	await suite.step("shadowing role definition", async () => {
		const agents = join(env.project, ".omp", "agents");
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			// A clean approval first; the shadow must be written after it, so the change itself is what needs approval.
			await approveTeam(rpc, "off");
			mkdirSync(agents, { recursive: true });
			writeFileSync(join(agents, "storm-implementer.md"), "---\nname: storm-implementer\ndescription: shadow\n---\nSTORM-ROLE shadow. Reply with OK.\n");
			const frames = await rpc.turn("E2E-TASK storm-implementer");
			check("an unapproved definition blocks the role with shadow", asyncResults(frames).includes("[storm:shadow]") && children(llm.all()).length === 0);
			rpc.answer = choose(APPROVE);
			await rpc.prompt("/storm");
			check("/storm asks to approve it", rpc.dialogs.at(-1)?.options[0] === APPROVE, JSON.stringify(rpc.dialogs.at(-1)?.options));
			await rpc.turn("E2E-TASK storm-implementer");
			check("approved, the role runs the shadowing definition", children(llm.all()).some(kid => kid.roles.includes("shadow")));
			check("the shadow approval updated this session's record for the same config hash", files.approvals().length === 1, `approvals=${files.approvals().length}`);
		}, { setup: "off" });
		rmSync(join(env.project, ".omp"), { recursive: true, force: true });
	});

	await suite.step("quota marks", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			const marksFile = join(files.stateDir, "quota-marks.json");
			const marks = (): Array<{ provider: string; source: string }> => (existsSync(marksFile) ? (JSON.parse(readFileSync(marksFile, "utf8")) as { marks: Array<{ provider: string; source: string }> }).marks : []);
			const models = files.config().roles.implementer?.models ?? [];
			const provider = (entry: string | undefined) => entry?.split("/")[0];
			const fallback = models.find(model => provider(model) !== provider(models[0]));
			if (!fallback) return suite.skip("quota mark routes to the other provider", `the implementer has no fallback on another provider (${models.join(", ")})`);
			const bytes = files.configBytes();
			// Typed in another case than the team's models spell it.
			const request = route({ action: "quota", provider: provider(models[0])?.toUpperCase() }, "that provider ran out");
			await rpc.prompt(request);
			check("a classified quota mark asks first; cancel marks nothing", same(rpc.dialogs.at(-1)?.options, [QUOTA_CHOICE.mark, QUOTA_CHOICE.cancel]) && marks().length === 0, JSON.stringify(rpc.dialogs.at(-1)));
			rpc.answer = choose(QUOTA_CHOICE.mark);
			await rpc.prompt(request);
			check(
				"a quota mark needs no approval",
				rpc.dialogs.every(dialog => !dialog.options.includes(APPROVE)) && files.configBytes() === bytes && marks().some(mark => mark.provider === provider(models[0]) && mark.source === "user"),
				JSON.stringify(marks()),
			);
			await rpc.turn("E2E-TASK storm-implementer");
			check("the role runs on its fallback on another provider", children(llm.all())[0]?.model === modelId(fallback), `child=${children(llm.all())[0]?.model} expected=${modelId(fallback)}`);
		});

		// omp itself leaves a model after provider errors: Storm marks that provider (source "fallback") and says so, with no approval.
		writeFileSync(MODELS_FILE, modelsYml(env.port, { ...PROVIDERS, ...QUOTA_OUT }));
		writeFileSync(PROFILE_FILE, FALLBACK_CONFIG);
		const fallbackLlm = new LlmCursor(env);
		try {
			await session(
				cancelAll,
				async (rpc, files) => {
					const marksFile = join(files.stateDir, "quota-marks.json");
					const marks = (): Array<{ provider: string; source: string }> => (existsSync(marksFile) ? (JSON.parse(readFileSync(marksFile, "utf8")) as { marks: Array<{ provider: string; source: string }> }).marks : []);
					const bytes = files.configBytes();
					await rpc.turn("hello");
					// omp announces the fallback while the turn goes on; Storm's handler writes the mark and notifies.
					await suite.eventually("omp's own fallback marks the provider", () => marks().some(mark => mark.provider === "fake3" && mark.source === "fallback") && files.configBytes() === bytes, () => JSON.stringify(marks()));
					await suite.eventually("and the user is told", () => rpc.notices().some(([level, message]) => level === "warning" && message.includes("fake3")), () => JSON.stringify(rpc.notices().map(([level]) => level)));
					check("the fallback session made its own model request", fallbackLlm.all().length > 0, `requests=${fallbackLlm.all().length}`);
				},
				{ model: "fake3/quota-out" },
			);
		} finally {
			writeFileSync(MODELS_FILE, modelsYml(env.port, PROVIDERS));
			writeFileSync(PROFILE_FILE, PROFILE_CONFIG);
		}
	});

	await suite.step("trial routing", async () => {
		const candidate = "fake/premium-c";
		const llm = new LlmCursor(env);
		await session(choose(APPROVE), async (rpc, files) => {
			const primary = files.config().roles.implementer?.models[0];
			await rpc.prompt(route({ action: "trial", role: "implementer", model: candidate, share: 0.5, maxSpawns: 1, days: 1, budgetUsd: 1 }, "try the premium model"));
			check("a trial is added through the approval dialog", files.config().trials?.length === 1, JSON.stringify(files.config().trials));
			for (let i = 0; i < 3; i++) await rpc.turn("E2E-TASK storm-implementer");
			const routed = children(llm.all()).map(kid => kid.model);
			check("spawns follow the share and the spawn limit", same(routed, [modelId(primary), modelId(candidate), modelId(primary)]), `${routed.join(",")} expected=${modelId(primary)},${modelId(candidate)},${modelId(primary)}`);
			rpc.answer = choose(LABEL.keepModel);
			await rpc.prompt("/storm");
			const asked = rpc.dialogs.find(dialog => dialog.options.includes(LABEL.keepModel));
			check("the ended trial is decided in one dialog with three options", asked?.options.length === 3, JSON.stringify(asked?.options));
			check("keeping the current model removes the trial without a second dialog", !files.config().trials?.length && rpc.dialogs.filter(dialog => dialog.options.includes(APPROVE)).length === 1, JSON.stringify(files.config().trials));
		});
	});

	await suite.step("a follow-up to a worker far past the retired 200k cap is delivered", async () => {
		// omp compacts a subagent itself, follow-up turns included, so Storm refuses no follow-up for its size.
		const llm = new LlmCursor(env);
		writeFileSync(MODELS_FILE, modelsYml(env.port, WIDE_PROVIDERS));
		try {
			await session(cancelAll, async (rpc, files) => {
				const dialogs = await editAndApprove(rpc, files, config => {
					config.roles.explorer!.models = ["fake/wide-worker"];
				});
				check("the 1M-window explorer is approved through /storm", dialogs.at(-1)?.answer === APPROVE && files.config().roles.explorer?.models[0] === "fake/wide-worker", JSON.stringify(dialogs.at(-1)));
				const marker = "E2E-FOLLOW-WIDE";
				const run = await runOf(
					rpc,
					files,
					startRun([
						plan([{ name: "read", kind: "explore", results: [trackedAnswer("wide-report", "the wide explorer reports the tracked fixture from source")] }]),
						{ task: ["storm-explorer"], as: "Wide", say: READ_AND_CLAIM },
						{ followUp: "agent://Wide0", content: `${marker} ${READ_AND_CLAIM}` },
					]),
				);
				const wide = run.agents?.find(agent => agent.id === "Wide0");
				const refused = mains(llm.all()).filter(entry => entry.lastTool.includes("[storm:followup"));
				const delivered = children(llm.all()).filter(kid => kid.model === "wide-worker" && kid.lastUser.includes(marker));
				check("the worker's recorded context is past the retired 200k cap", (wide?.contextTokens ?? 0) > 200_000, `contextTokens=${wide?.contextTokens}`);
				check("the follow-up is not refused and nothing is counted as blocked", refused.length === 0 && (run.blockedFollowUps ?? 0) === 0, `refused=${refused.length} blockedFollowUps=${run.blockedFollowUps}`);
				check("the worker received the follow-up and took another turn", delivered.length > 0 && (wide?.followUps ?? 0) >= 1, `delivered=${delivered.length} followUps=${wide?.followUps}`);
				check("the run still settles verified", run.status === "done" && run.endReason === "verified", `${run.status}/${run.endReason}`);
			});
		} finally {
			writeFileSync(MODELS_FILE, modelsYml(env.port, PROVIDERS));
		}
	});

	await suite.step("mid-run compaction keeps Storm's ledger", async () => {
		// Past 70% of its window, the director is compacted while it waits on an async child. omp keeps the last 20k
		// tokens verbatim by default, so this tiny session would have nothing to summarize: the profile keeps almost
		// nothing for this one run, and omp's own threshold compaction is off so the only compaction is Storm's.
		writeFileSync(PROFILE_FILE, `${PROFILE_CONFIG}compaction:\n  enabled: false\n  keepRecentTokens: 100\n`);
		const llm = new LlmCursor(env);
		try {
			// The fake LLM orders the two sessions: the director's last reply goes out once the child has made its first
			// request (Storm's ledger knows it by then), and the child's reply once the director was compacted.
			const steps: Step[] = [
				plan([{ name: "ckpt", kind: "code", results: [trackedAnswer("ckpt-report", "the held implementer reports the tracked fixture from source")] }]),
				{ task: ["storm-implementer"], as: "Ck", say: `E2E-CHILD-HOLD ${READ_AND_CLAIM}` },
				{ awaitChild: true },
			];
			// `tight-main` reports 75k of a 100k window: past the 70% mid-run share, with no team or cap change.
			const { run, files } = await session(cancelAll, async (rpc, files) => ({ run: await runOf(rpc, files, startRun(steps)), files }), { model: "fake/tight-main" });
			const compactions = llm.of("compaction");
			const ledger = compactions.find(entry => entry.compactionContext.includes(run.runId) && entry.compactionContext.includes("ckpt") && entry.compactionContext.includes("agent://Ck0"));
			check("the compaction request carries the run, its lanes and agent:// handles", ledger !== undefined, `compactions=${compactions.length} context=${(compactions[0]?.compactionContext ?? "").slice(0, 300).replace(/\s+/g, " ")}`);
			check("the run record has one checkpoint with its size before", run.checkpoints?.length === 1 && (run.checkpoints[0]?.before ?? 0) > 0, JSON.stringify(run.checkpoints));
			check("the index counts it", files.index().find(line => line.runId === run.runId)?.checkpoints === 1);
		} finally {
			writeFileSync(PROFILE_FILE, PROFILE_CONFIG);
		}
	});

	await suite.step("janitor and doc rules off", async () => {
		if (routedSession === undefined) throw new Error("the routed-run session from the earlier scenario is missing");
		const files = new StormFiles(env, routedSession.id);
		// Older runs whose omp process is gone. Their agents' records go only when the team approved cleanup, and only
		// for runs on this machine's trusted list whose artifacts dir sits under the profile's sessions dir beside its
		// `<dir>.jsonl`. Run records seeded only in the repo are never trusted.
		const trustedFile = files.trustedFile();
		type Trusted = { runId: string; cleaned?: string[] };
		const real = readJsonl<Trusted>(trustedFile);
		check("a real run is on the trusted list before any seeding", routedRunId !== undefined && real.some(line => line.runId === routedRunId), `trusted=${real.map(line => line.runId).join(",")}`);

		const sessions = join(env.agentDir, "sessions");
		/** A pid above every pid_max: never alive (pid 1 is, and EPERM counts as alive). */
		const DEAD_PROCESS = "99999999:1";
		type Seed = { runId: string; agent: string; at: number; dir: string };
		const seedOf = (group: string, runId: string, agent: string, at: number): Seed => ({ runId, agent, at, dir: join(sessions, group, runId) });
		const seeds = [1, 2, 3, 4].map(n => seedOf("e2e-seed", `run-20000101-00000${n}-e2e0`, `Seed${n}`, Date.UTC(2000, 0, 1, 0, 0, n)));
		const rogues = [1, 2].map(n => seedOf("e2e-rogue", `run-19990101-00000${n}-e2e0`, `Rogue${n}`, Date.UTC(1999, 0, 1, 0, 0, n)));
		const records = (seed: Seed): string[] => [`${seed.agent}.jsonl`, `${seed.agent}.json`, join(seed.agent, `${seed.agent}.Sub.jsonl`)].map(file => join(seed.dir, file));
		const outputs = (seed: Seed): string[] => [`${seed.agent}.md`, join(seed.agent, `${seed.agent}.Sub.md`)].map(file => join(seed.dir, file));
		mkdirSync(join(files.stateDir, "runs"), { recursive: true });
		for (const seed of [...seeds, ...rogues]) {
			mkdirSync(join(seed.dir, seed.agent), { recursive: true });
			writeFileSync(`${seed.dir}.jsonl`, "{}\n");
			for (const file of [...records(seed), ...outputs(seed)]) writeFileSync(file, "seed\n");
			const iso = new Date(seed.at).toISOString();
			const record: RunRecord = {
				schema: "storm.run/v1",
				runId: seed.runId,
				configHash: "jcs-sha256:e2e-seed",
				startedAt: iso,
				endedAt: iso,
				status: "done",
				task: "E2E seed",
				costUsd: 0,
				costByModel: {},
				spawns: [],
				artifactsDir: seed.dir,
				process: DEAD_PROCESS,
				agents: [
					{ id: seed.agent, name: "storm-implementer", role: "implementer", runId: seed.runId, model: "fake/general-b", state: "parked", startedAt: seed.at, lastActivityAt: seed.at, contextTokens: 100, requests: 1, costUsd: 0, followUps: 0 },
				],
			};
			writeFileSync(join(files.stateDir, "runs", `${seed.runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
		}
		// Trusted list: oldest first, so the seeds go before whatever the earlier runs recorded.
		const trustedSeeds = seeds.map(seed => JSON.stringify({ runId: seed.runId, artifactsDir: seed.dir, process: DEAD_PROCESS, agents: [seed.agent], endedAt: new Date(seed.at).toISOString() }));
		writeFileSync(trustedFile, `${[...trustedSeeds, ...real.map(line => JSON.stringify(line))].join("\n")}\n`);
		const present = (paths: string[]): number => paths.filter(path => existsSync(path)).length;
		const seedFiles = [...seeds, ...rogues].flatMap(seed => [...records(seed), ...outputs(seed)]);
		const rogueFiles = rogues.flatMap(seed => [...records(seed), ...outputs(seed)]);
		const [oldest] = seeds;
		if (!oldest) throw new Error("no seed");

		await session(cancelAll, async (rpc, files) => {
			const llm = new LlmCursor(env);
			rpc.answer = choose(APPROVE);
			await rpc.prompt(route({ action: "settings", cleanup: false, docs: false }, "keep records, no doc rules"));
			check("cleanup and doc rules are switched off through the approval dialog", files.config().cleanup !== true && files.config().docs === false, JSON.stringify([files.config().cleanup, files.config().docs]));
			await rpc.turn(`E2E-STEPS ${JSON.stringify([{ task: ["storm-implementer"], as: "DocProbe" }])}`);
			const kid = children(llm.all()).at(-1);
			check("docs off: no doc rules in a role's prompt", kid !== undefined && kid.docRules === null, JSON.stringify(kid?.docRules));
			const kept = await runOf(rpc, files, CHEAP_RUN);
			check(
				"cleanup off: a run end deletes nothing",
				present(seedFiles) === seedFiles.length && !kept.cleanup?.agents && seeds.every(seed => files.run(seed.runId)?.agents?.[0]?.cleanedAt === undefined),
				`present=${present(seedFiles)}/${seedFiles.length} cleanup=${JSON.stringify(kept.cleanup)}`,
			);

			await rpc.prompt(route({ action: "settings", cleanup: true, docs: true }, "clean up again"));
			check("cleanup is switched on through the approval dialog", files.config().cleanup === true);
			const cleaned = await runOf(rpc, files, CHEAP_RUN);
			check(
				"cleanup on: a trusted older run's agent records are deleted, its outputs kept",
				present(records(oldest)) === 0 && present(outputs(oldest)) === outputs(oldest).length,
				`records=${present(records(oldest))} outputs=${present(outputs(oldest))}`,
			);
			check("runs known only from the repo lose nothing", present(rogueFiles) === rogueFiles.length && rogues.every(seed => files.run(seed.runId)?.agents?.[0]?.cleanedAt === undefined), `present=${present(rogueFiles)}/${rogueFiles.length}`);
			const entry = readJsonl<Trusted>(trustedFile).find(line => line.runId === oldest.runId);
			check(
				"the trusted list, the old run record and this run's record say what was cleaned",
				entry?.cleaned?.includes(oldest.agent) === true && files.run(oldest.runId)?.agents?.[0]?.cleanedAt !== undefined && (cleaned.cleanup?.agents ?? 0) >= 1,
				`trusted=${JSON.stringify(entry?.cleaned)} cleanup=${JSON.stringify(cleaned.cleanup)}`,
			);
			check("the index carries the cleanup numbers", same(files.index().find(line => line.runId === cleaned.runId)?.cleanup, cleaned.cleanup));
		}, { resume: routedSession.id, sessionDir: routedSession.dir, setup: "off" });
	});

	await suite.step("heavy main context at run start", async () => {
		const llm = new LlmCursor(env);
		await session(
			cancelAll,
			async (rpc, files) => {
				await rpc.turn("hello");
				const run = await runOf(rpc, files, startRun([plan([{ name: "impl", kind: "code", results: [trackedAnswer("heavy-report")] }]), { task: ["storm-implementer"], as: "Impl", say: READ_AND_CLAIM }]));
				const compactions = llm.of("compaction").length;
				check("the run starts without a dialog, after compacting", rpc.dialogs.length === 0 && run.status === "done" && run.endReason === "verified" && compactions > 0, `dialogs=${rpc.dialogs.length} status=${run.status} ${run.endReason} compactions=${compactions}`);
			},
			{ model: "fake/heavy-main" },
		);
	});

	await suite.step("a 150k context on a 1M-window model is not compacted at run start", async () => {
		// The run-start compaction is a share of the model's window, not a fixed token number.
		const llm = new LlmCursor(env);
		writeFileSync(MODELS_FILE, modelsYml(env.port, WIDE_PROVIDERS));
		try {
			await session(
				cancelAll,
				async (rpc, files) => {
					await rpc.turn("hello");
					const run = await runOf(rpc, files, startRun([plan([{ name: "impl", kind: "code", results: [trackedAnswer("wide-main-report")] }]), { task: ["storm-implementer"], as: "Impl", say: READ_AND_CLAIM }]));
					const compactions = llm.of("compaction").length;
					const director = mains(llm.all()).filter(entry => entry.model === "wide-main");
					check("the director really ran on the 1M-window model", director.length > 0, `mainRequests=${director.length}`);
					check("the run starts and settles without any compaction", run.status === "done" && run.endReason === "verified" && compactions === 0 && !run.checkpoints?.length, `status=${run.status}/${run.endReason} compactions=${compactions}`);
				},
				{ model: "fake/wide-main" },
			);
		} finally {
			writeFileSync(MODELS_FILE, modelsYml(env.port, PROVIDERS));
		}
	});

	await suite.step("hub, status, rollback", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			// A second approval in this session, so rollback has an earlier config to restore.
			await editAndApprove(rpc, files, config => {
				config.rounds = 7;
			});
			rpc.dialogs.length = 0;
			rpc.answer = cancelAll;
			let frames = await rpc.prompt("/storm status");
			check("/storm status reports and asks nothing", reports(frames).length === 1 && rpc.dialogs.length === 0);
			frames = await rpc.prompt("/storm");
			const menu = rpc.dialogs.at(-1)?.options ?? [];
			check("/storm opens the menu with the status in view", reports(frames).length === 1 && menu.includes(LABEL.rollback) && menu.includes(LABEL.reset) && menu.length >= 5, JSON.stringify(menu));
			const bytes = files.configBytes();
			const approvals = files.approvals().length;
			// The menu, then the list of earlier approvals: the first one offered.
			rpc.answer = dialog => (dialog.options.includes(LABEL.rollback) ? LABEL.rollback : dialog.options.find(option => option !== CANCEL));
			await rpc.prompt("/storm");
			check("rollback puts an earlier approved config back without a new approval", files.configBytes() !== bytes && files.approvals().length === approvals, `approvals=${files.approvals().length}/${approvals}`);
			check("none of it called a model", llm.all().length === 0, `requests=${llm.all().length}`);
			await rpc.turn("E2E-TASK storm-implementer");
			check("the restored config counts as approved", children(llm.all()).length === 1);
		});
	});

	await suite.step("print mode changes nothing", async () => {
		if (routedSession === undefined) throw new Error("the routed-run session from the earlier scenario is missing");
		const baseline = new StormFiles(env, routedSession.id);
		const bytes = baseline.configBytes();
		const approvals = baseline.approvals().length;
		const runs = baseline.runs().length;
		const autoBefore = await readAutoDelegationChoice(baseline.sessionDir);
		const llm = new LlmCursor(env);
		const codes = ["/storm setup", "/storm reset", "/storm", "/storm status"].map((command, index) => {
			const args = [env.omp, "-p", "--profile", env.profile, "--session-dir", join(env.sessionRoot, `print-${index}`), "--no-title", "--auto-approve", "--model", MAIN, command];
			return Bun.spawnSync(args, { cwd: env.project, env: env.childEnv, timeout: 60_000, stderr: Bun.file(join(env.logs, "print.stderr.log")) }).exitCode;
		});
		check("every command exits 0", codes.every(code => code === 0), `exit=${codes.join(",")}`);
		check("the earlier session's config, approvals and runs are untouched", baseline.configBytes() === bytes && baseline.approvals().length === approvals && baseline.runs().length === runs);
		const autoAfter = await readAutoDelegationChoice(baseline.sessionDir);
		check("the explicit off survives print-mode commands that cannot approve", autoBefore === "off" && autoAfter === "off", `${autoBefore} -> ${autoAfter}`);
		check("print-mode processes write into their own session stores, not the target", !existsSync(join(env.project, ".omp")) && !existsSync(join(env.project, ".gitignore")));
		check("no model request", llm.all().length === 0, `requests=${llm.all().length}`);
	});

	await suite.step("reset", async () => {
		if (routedSession === undefined) throw new Error("the routed-run session from the earlier scenario is missing");
		const other = stoppedSession === undefined ? undefined : new StormFiles(env, stoppedSession.id);
		const otherBytes = other?.configBytes() ?? null;
		const otherApprovals = other?.approvals().length ?? 0;
		const sentinel = join(env.project, ".omp", "storm", "config.json");
		mkdirSync(join(env.project, ".omp", "storm"), { recursive: true });
		writeFileSync(sentinel, '{"team":"old storm, never imported"}\n');
		const sentinelHash = new Bun.CryptoHasher("sha256").update(readFileSync(sentinel)).digest("hex");
		const llm = new LlmCursor(env);
		try {
			await session(cancelAll, async (rpc, files) => {
				const approvals = files.approvals().length;
				await rpc.prompt("/storm reset");
				check("one confirmation; cancel keeps everything", rpc.dialogs.length === 1 && rpc.dialogs[0]?.options[0] === LABEL.reset && existsSync(files.configFile) && files.approvals().length === approvals, JSON.stringify(rpc.dialogs));
				rpc.answer = choose(LABEL.reset);
				await rpc.prompt("/storm reset");
				check("the config, approvals and run history of this session are gone together", approvals > 0 && !existsSync(files.sessionDir) && files.configBytes() === null && files.approvals().length === 0, `approvals=${files.approvals().length}/${approvals}`);
				check(
					"reset deletes no other session's data",
					other === undefined || (other.configBytes() === otherBytes && other.approvals().length === otherApprovals),
					other === undefined ? "no second session" : `config=${other.configBytes() === otherBytes} approvals=${other.approvals().length}/${otherApprovals}`,
				);
				check("reset leaves the old .omp/storm bytes untouched", new Bun.CryptoHasher("sha256").update(readFileSync(sentinel)).digest("hex") === sentinelHash);
				// A fresh scripted step: the resumed transcript carries older E2E-STEPS scripts the fake model would replay.
				const frames = await rpc.turn(`E2E-STEPS ${JSON.stringify([{ task: ["storm-implementer"], as: "AfterReset" }])}`);
				check("afterwards storm roles are blocked with no-config", asyncResults(frames).includes("[storm:no-config]"), asyncResults(frames).slice(0, 300));
				check("and the storm tool is gone", mains(llm.all()).length > 0 && mains(llm.all()).every(entry => entry.stormTool === null));
			}, { resume: routedSession.id, sessionDir: routedSession.dir, setup: "off" });
		} finally {
			rmSync(join(env.project, ".omp"), { recursive: true, force: true });
		}
	});

	await suite.step("omp exit codes", async () => {
		check("every omp session exited 0", exitCodes.length > 0 && exitCodes.every(code => code === 0), `exit=${exitCodes.join(",")}`);
		check("no run left git's index lock and git status works", gitUsable(), "index.lock or git status failed");
	});
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
