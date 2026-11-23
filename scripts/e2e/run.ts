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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { docPromptFor } from "../../src/policy/docs.ts";
import { NEEDS_APPROVAL } from "../../src/proposals/decide.ts";
import { APPROVE, CANCEL } from "../../src/proposals/present.ts";
import { FALLBACK, QUOTA_CHOICE } from "../../src/request/route.ts";
import type { RunRecord } from "../../src/types.ts";
import {
	type Answer,
	cancelAll,
	COMMIT_FILE,
	customMessage,
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

/** Option labels Storm does not export. */
const LABEL = {
	resume: "끝나지 않은 실행 이어 가기",
	reset: "초기화",
	rollback: "이전 승인으로 되돌리기",
	keepModel: "지금 모델 유지",
	autoOff: "자동 위임 끄기",
} as const;

/** The disclosure the first team approval panel must carry. */
const AUTO_DISCLOSURE = "승인하면 자동 위임이 켜집니다";

const env = prepare("storm-e2e", 18556);
const suite = new Suite("E2E (rpc)", env);
const files = new StormFiles(env);
const check = suite.check.bind(suite);

const PROVIDERS = {
	fake: [
		...TEAM_PROVIDERS.fake,
		// Below every role's minimum context, so no team ever approves it: the model outside the team.
		{ id: "outsider-z", cost: price(5, 25), context: 60_000 },
		// Reports a 35k prompt on a 60k window (fake-llm.ts): a heavy main session for the run-start check. Never in a team.
		{ id: "heavy-main", cost: price(1, 4), context: 60_000 },
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

const exitCodes: number[] = [];

/** One omp RPC process: started, used and closed; its exit code is checked at the end. */
async function session<T>(answer: Answer, body: (rpc: Rpc) => Promise<T>, options: Partial<SessionOptions> = {}): Promise<T> {
	const rpc = new Rpc(env, answer, { model: MAIN, ...options });
	try {
		await rpc.ready();
		return await body(rpc);
	} finally {
		exitCodes.push(await rpc.close());
	}
}

const route = (reply: Record<string, unknown>, rest = "please"): string => `/storm E2E-ROUTE ${JSON.stringify(reply)} ${rest}`;
/** A run requested through the classifier, as work reaches a run: the task carries the scripted steps. */
const runRequest = (reply: Record<string, unknown>, steps: Step[]): string => route(reply, `E2E-STEPS ${JSON.stringify(steps)}`);
const startRun = (steps: Step[]): string => runRequest({ action: "run" }, steps);
const plan = (lanes: Array<{ name: string; kind: string }>, workers?: Record<string, number>): Extract<Step, { storm: unknown }> => ({
	storm: { action: "plan", plan: { lanes, ...(workers ? { workers } : {}) } },
});
const CHEAP_RUN = startRun([plan([{ name: "impl", kind: "code" }])]);

/**
 * Sends a message that starts a Storm run and returns the run's final record, once everything the run's end writes
 * is on disk and its report, the last thing Storm does for a run, has come after the session's last turn.
 */
async function runOf(rpc: Rpc, message: string): Promise<RunRecord> {
	const before = files.runIds();
	await rpc.prompt(message);
	const run = await files.finishedRun(before);
	const reported = (): true | undefined => {
		const lastTurn = rpc.frames.findLastIndex(frame => frame.type === "agent_end");
		return rpc.frames.slice(lastTurn + 1).some(frame => customMessage(frame) === "storm-report" && text(frame).includes(run.runId)) ? true : undefined;
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

/** A config changed by hand, then approved through `/storm`'s dialog for an unapproved team. */
async function editAndApprove(change: Parameters<StormFiles["editConfig"]>[0]): Promise<Rpc["dialogs"]> {
	files.editConfig(change);
	return session(choose(APPROVE), async rpc => {
		await rpc.prompt("/storm");
		return rpc.dialogs;
	});
}

async function main(): Promise<void> {
	writeFileSync(MODELS_FILE, modelsYml(env.port, PROVIDERS));
	writeFileSync(PROFILE_FILE, PROFILE_CONFIG);
	linkPlugin(env);
	/** The run started through the request router in a session kept on disk: the janitor step looks it up. */
	let routedRunId: string | undefined;
	/** The hub's options when the last finished run is not resumable. */
	let hubWithoutResume: string[] = [];

	await suite.step("no config", async () => {
		const llm = new LlmCursor(env);
		const frames = await session(cancelAll, rpc => rpc.turn("E2E-TASK storm-implementer task"));
		check("storm role spawn is blocked with no-config", asyncResults(frames).includes("[storm:no-config]"));
		check("other agents are untouched", children(llm.all()).length === 1, `children=${children(llm.all()).length}`);
		check("no storm tool without a config", mains(llm.all()).length > 0 && mains(llm.all()).every(entry => entry.stormTool === null));
	});

	await suite.step("setup through Storm's dialog", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
			await rpc.prompt("/storm");
			check("the dialog offers exactly approve and cancel (no forms in RPC)", same(rpc.dialogs.at(-1)?.options, [APPROVE, CANCEL]), JSON.stringify(rpc.dialogs));
			check("cancel saves nothing", !existsSync(files.configFile) && files.approvals().length === 0);
			rpc.answer = choose(APPROVE);
			const frames = await rpc.prompt("/storm");
			check("approve saves the config", existsSync(files.configFile));
			check("approve writes one approval record", files.approvals().length === 1, `approvals=${files.approvals().length}`);
			const store = files.storeDir();
			check(
				"the single default approval persists automatic delegation on",
				store !== undefined && (await readAutoDelegationChoice(store)) === "on",
				store === undefined ? "no store" : await readAutoDelegationChoice(store),
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
			check("state stays out of git (.gitignore)", existsSync(join(env.project, ".omp", "storm", ".gitignore")));
			check("no model request during setup", llm.all().length === 0, `requests=${llm.all().length}`);
			const roles = Object.keys(existsSync(files.configFile) ? files.config().roles : {}).sort();
			check("the recommended team has all five roles", same(roles, ["architect", "explorer", "implementer", "quick", "reviewer"]), roles.join(","));
			// This file's later manual scenarios exercise the legacy direct-tool path, so opt out through the real command.
			rpc.answer = choose(LABEL.autoOff);
			await rpc.prompt("/storm auto");
			check("the explicit switch turns automatic delegation off", store !== undefined && (await readAutoDelegationChoice(store)) === "off", store === undefined ? "no store" : await readAutoDelegationChoice(store));
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
		});
	});

	await suite.step("spawn routing outside a run", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, rpc => rpc.turn("E2E-TASK storm-implementer storm-quick storm-architect"));
		const config = files.config();
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
		await session(cancelAll, async rpc => {
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
			await session(choose(FALLBACK.cancel), async rpc => {
				const request = route({ action: "answer", text: "E2E-ROUTE-OK" }, "who reviews?");
				const fresh = new LlmCursor(env);
				const frames = await rpc.prompt(request);
				check("the short request routes in a fresh session", fresh.of("route").length === 1 && reports(frames).some(report => report.includes("E2E-ROUTE-OK")));

				const id = rpc.send({ type: "switch_session", sessionPath: path });
				const response = await until(() => rpc.frames.find(frame => frame.type === "response" && frame.id === id), 20_000, "load the long session");
				if (response.success !== true || (response.data as { cancelled?: boolean }).cancelled !== false) {
					throw new Error(`could not load the long session: ${text(response)}`);
				}

				const llm = new LlmCursor(env);
				const runs = files.runIds().size;
				await rpc.prompt(request);
				const dialog = rpc.dialogs.at(-1);
				check("oversized routing offers run, menu or cancel", same(dialog?.options, [FALLBACK.run, FALLBACK.menu, FALLBACK.cancel]));
				const title = dialog?.title ?? "";
				check("the fallback suggests a new session instead of exposing a raw error", title.includes("/new") && !/byte limit|raw-http-request/i.test(title), title);
				const requests = llm.all();
				check("oversized routing makes no provider request", requests.length === 0, `requests=${requests.map(entry => entry.who).join(",")}`);
				check("cancelling oversized routing creates no run", files.runIds().size === runs);
			}, { persist: true });
		} finally {
			rmSync(path, { force: true });
		}
	});

	await suite.step("request routing: work becomes a run", async () => {
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan(
				[
					{ name: "impl", kind: "code" },
					{ name: "scope", kind: "explore" },
					{ name: "review", kind: "review" },
				],
				{ implementer: 2 },
			),
			{ task: ["storm-implementer", "task", "scout", "storm-reviewer"] },
		];
		const request = `E2E-ROUTE ${JSON.stringify({ action: "run" })} E2E-STEPS ${JSON.stringify(steps)}`;
		let frames: Frame[] = [];
		let dialogs = 0;
		const run = await session(
			cancelAll,
			async rpc => {
				const done = await runOf(rpc, `/storm ${request}`);
				dialogs = rpc.dialogs.length;
				frames = rpc.frames;
				return done;
			},
			{ model: OUTSIDER, flags: ["--smol", OUTSIDER], persist: true },
		);
		routedRunId = run.runId;
		const config = files.config();
		const director = mains(llm.all());
		// omp puts its date reminder in front of the first user message.
		const handoff = (director[0]?.lastUser ?? "").replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/, "");
		const sent = new Set(director.flatMap(entry => entry.users).filter(user => !user.startsWith("<system-notice>")));
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
			"the run record keeps the whole request and the round bound",
			run.request === request && run.task.length <= 200 && run.maxRounds === 4,
			`request=${run.request === request} task=${run.task.length} maxRounds=${run.maxRounds}`,
		);
		check("the run record: no changes, ended after one round", run.endReason === "no-changes" && run.status === "ended" && run.turns === 1, `${run.endReason} ${run.status} turns=${run.turns}`);
		const outcome = (agent: string) => run.spawns.find(spawn => spawn.agent === agent);
		check(
			"storm roles are routed, outside models are swapped for the role's",
			outcome("storm-implementer")?.outcome === "routed" &&
				outcome("storm-reviewer")?.outcome === "routed" &&
				outcome("task")?.outcome === "substituted" &&
				outcome("task")?.role === "implementer" &&
				outcome("scout")?.outcome === "substituted" &&
				outcome("scout")?.role === "explorer",
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
		check("the run summary index has its line", summary?.schema === "storm.run-summary/v1" && summary.endReason === "no-changes" && summary.turns === 1, JSON.stringify(summary));
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
		const seen = kids.filter(kid => kid.lastUser.includes("e2e child")).map(kid => kid.docRules?.hash ?? null);
		const count = (hash: string | undefined) => seen.filter(value => value === hash).length;
		check("doc rules: nothing in the director's prompt", director.every(entry => entry.docRules === null));
		check(
			"doc rules: the writing rules reach only the implementer, the review variant only the reviewer",
			variant("storm-implementer") !== variant("storm-reviewer") && count(variant("storm-implementer")) === 1 && count(variant("storm-reviewer")) === 1,
			JSON.stringify(seen),
		);
		check("doc rules: omp's own agents (task, scout) get none", seen.filter(value => value === null).length === 2, JSON.stringify(seen));

		const trusted = readJsonl<{ runId: string; artifactsDir: string; agents: string[] }>(files.trustedFile());
		const entry = trusted.find(line => line.runId === run.runId);
		check(
			"the run is on this machine's trusted list (runs.jsonl) with its agents",
			entry !== undefined && entry.artifactsDir === run.artifactsDir && entry.agents.length === 4,
			`trusted=${trusted.map(line => line.runId).join(",")} run=${run.runId} artifacts=${run.artifactsDir}`,
		);

		const stale = await session(cancelAll, async rpc => ({
			run: await runOf(rpc, runRequest({ action: "run", mode: "loop" }, [plan([{ name: "impl", kind: "code" }]), { task: ["storm-implementer"] }])),
			dialogs: rpc.dialogs.length,
		}));
		check(
			"a reply that still says mode loop is a plain run",
			stale.dialogs === 0 && stale.run.endReason === "no-changes" && stale.run.status === "ended" && stale.run.turns === 1 && stale.run.limits === undefined,
			`${stale.run.endReason} ${stale.run.status} turns=${stale.run.turns} limits=${JSON.stringify(stale.run.limits)} dialogs=${stale.dialogs}`,
		);
	});

	await suite.step("a run is sent back until its changes are reviewed", async () => {
		const changed = join(env.project, "e2e-rounded.txt");
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code" },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: "E2E-CHILD-WRITE e2e-rounded.txt" },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
		];
		try {
			await session(cancelAll, async rpc => {
				const run = await runOf(rpc, startRun(steps));
				const roundTag = `<storm-run id="${run.runId}" round="2/4">`;
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
					"the round message starts round 2 of 4",
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
				{ name: "impl", kind: "code" },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Bash", say: `E2E-CHILD-BASH ${TRACKED_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
		];
		try {
			await session(cancelAll, async rpc => {
				const run = await runOf(rpc, startRun(steps));
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
				const roundTag = `<storm-run id="${run.runId}" round="2/4">`;
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
		const steps: Step[] = [plan([{ name: "impl", kind: "run" }]), { task: ["storm-quick"], as: "Quick", say: "E2E-CHILD-WRITE e2e-quick.txt" }];
		try {
			await session(cancelAll, async rpc => {
				const run = await runOf(rpc, startRun(steps));
				const quick = run.agents?.find(agent => agent.role === "quick");
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				check("the quick worker's change is counted", quick?.changes === 1 && existsSync(changed), `changes=${quick?.changes} file=${existsSync(changed)}`);
				check("no round followed: the quick role needs no reviewer", stormMessages.length === 1 && !stormMessages.some(user => user.includes('round="2/4"')), `storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`);
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
				{ name: "impl", kind: "code" },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Commit", say: `E2E-CHILD-COMMIT ${COMMIT_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
		];
		await session(cancelAll, async rpc => {
			const run = await runOf(rpc, startRun(steps));
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
			const roundTag = `<storm-run id="${run.runId}" round="2/4">`;
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
				{ name: "impl", kind: "code" },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-BASH ${REVIEW_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
			// `task` returns when the spawn is queued: each director change waits for the reviewer's result so it lands
			// after the verdict, with no other agent active after it.
			{ bash: change, afterResult: "Rev0" },
			{ task: ["storm-reviewer"], as: "Again", say: "E2E-CHILD-VERDICT correct", after: 'round="3/4"' },
			{ bash: change, afterResult: "Again0" },
		];
		try {
			await session(cancelAll, async rpc => {
				const run = await runOf(rpc, startRun(steps));
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				const round = (n: number) => stormMessages.filter(user => user.startsWith(`<storm-run id="${run.runId}" round="${n}/4">`)).length;
				const reviewers = run.agents?.filter(agent => agent.role === "reviewer") ?? [];
				check(
					"the change after the verdict brings one re-review, and no fourth round",
					stormMessages.length === 3 && round(2) === 1 && round(3) === 1 && round(4) === 0,
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
					run.status === "stopped" && run.endReason === "no-progress" && run.turns === 3,
					`${run.status} ${run.endReason} turns=${run.turns}`,
				);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "stopped" && lines[0]?.endReason === "no-progress" && lines[0]?.turns === 3,
					JSON.stringify(lines),
				);
				check("the run left no git index lock and git status works", gitUsable(), "index.lock or git status failed");
			});
		} finally {
			writeFileSync(reviewed, REVIEW_TEXT);
		}
	});

	await suite.step("a team change after the re-review is sent back again", async () => {
		const reviewed = join(env.project, REVIEW_FILE);
		const llm = new LlmCursor(env);
		const change = `printf '%s\\n' storm-director-change >> ${REVIEW_FILE}`;
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code" },
				{ name: "review", kind: "review" },
			]),
			{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-BASH ${REVIEW_FILE}` },
			{ task: ["storm-reviewer"], as: "Rev", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
			{ bash: change, afterResult: "Rev0" },
			{ task: ["storm-reviewer"], as: "Again", say: "E2E-CHILD-VERDICT correct", after: 'round="3/4"' },
			// An agent changes the file after the re-review's verdict: a team change, so no one-shot excuse applies.
			{ task: ["storm-implementer"], as: "Fix", say: `E2E-CHILD-BASH ${REVIEW_FILE}`, afterResult: "Again0" },
			{ task: ["storm-reviewer"], as: "Final", say: "E2E-CHILD-VERDICT correct", after: 'round="4/4"' },
		];
		try {
			await session(cancelAll, async rpc => {
				const run = await runOf(rpc, startRun(steps));
				const stormMessages = [...new Set(mains(llm.all()).map(newestUser))].filter(user => user.startsWith("<storm-run"));
				const round = (n: number) => stormMessages.filter(user => user.startsWith(`<storm-run id="${run.runId}" round="${n}/4">`)).length;
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

	await suite.step("a run that makes no progress is stopped", async () => {
		const changed = join(env.project, "e2e-stalled.txt");
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			plan([
				{ name: "impl", kind: "code" },
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
			await session(cancelAll, async rpc => {
				const run = await runOf(rpc, startRun(steps));
				const users = [...new Set(mains(llm.all()).map(newestUser))];
				const stormMessages = users.filter(user => user.startsWith("<storm-run"));
				const third = users.filter(user => user.startsWith(`<storm-run id="${run.runId}" round="3/4">`));
				check(
					"round 2 was sent, and no third round followed",
					stormMessages.length === 2 && stormMessages.some(user => user.startsWith(`<storm-run id="${run.runId}" round="2/4">`)) && third.length === 0,
					`storm=${stormMessages.map(user => user.slice(0, 50)).join(" | ")}`,
				);
				const implementer = run.agents?.find(agent => agent.role === "implementer");
				check("round 1's change is counted", implementer?.changes === 1 && existsSync(changed), `changes=${implementer?.changes} file=${existsSync(changed)}`);
				check("the run stops with no progress", run.status === "stopped" && run.endReason === "no-progress" && run.turns === 2, `${run.status} ${run.endReason} turns=${run.turns}`);
				const lines = files.index().filter(line => line.runId === run.runId);
				check(
					"the index line agrees, once",
					lines.length === 1 && lines[0]?.status === "stopped" && lines[0]?.endReason === "no-progress" && lines[0]?.turns === 2,
					JSON.stringify(lines),
				);
			});
		} finally {
			rmSync(changed, { force: true });
		}
	});

	await suite.step("a run that stopped is resumed", async () => {
		const limited = join(env.project, "e2e-limited.txt");
		const steps: Step[] = [
			plan([{ name: "impl", kind: "code" }]),
			{ task: ["storm-implementer"], as: "Impl", say: "E2E-CHILD-WRITE e2e-limited.txt" },
		];
		try {
			// The old run stops at its own two-round limit, so its record keeps a limit for the resume to carry.
			const old = await session(cancelAll, rpc => runOf(rpc, runRequest({ action: "run", rounds: 2 }, steps)));
			check(
				"the old run stopped at its round limit",
				old.status === "stopped" && old.endReason === "round-limit" && old.limits?.rounds === 2 && old.maxRounds === 2,
				`${old.status} ${old.endReason} limits=${JSON.stringify(old.limits)} maxRounds=${old.maxRounds}`,
			);

			const first = new LlmCursor(env);
			const resumed = await session(cancelAll, async rpc => {
				await rpc.prompt("/storm");
				const menu = rpc.dialogs.at(-1)?.options ?? [];
				check(
					"the hub offers the stopped run first, as one more option",
					menu[0] === LABEL.resume && same(menu.slice(1), hubWithoutResume.filter(option => option !== LABEL.resume)),
					`menu=${JSON.stringify(menu)} without=${JSON.stringify(hubWithoutResume)}`,
				);
				const before = files.runIds();
				rpc.answer = choose(LABEL.resume);
				await rpc.prompt("/storm");
				return files.finishedRun(before, 150_000);
			});
			const handoff = mains(first.all()).map(newestUser).find(user => user.startsWith(`<storm-run id="${resumed.runId}"`)) ?? "";
			check(
				"the resumed run records what it continues and the same request",
				resumed.runId !== old.runId && resumed.resumeOf === old.runId && resumed.request !== undefined && resumed.request === old.request,
				`resumeOf=${resumed.resumeOf} old=${old.runId} request=${resumed.request === old.request}`,
			);
			check("the resumed run carries the old limits", resumed.limits?.rounds === 2 && resumed.maxRounds === 2, `limits=${JSON.stringify(resumed.limits)} maxRounds=${resumed.maxRounds}`);
			check("the handoff names the old run", handoff.includes(old.runId), handoff.slice(0, 240));

			const second = new LlmCursor(env);
			const again = await session(cancelAll, async rpc => {
				const dialogs = rpc.dialogs.length;
				const run = await runOf(rpc, route({ action: "resume" }, "continue the run that stopped"));
				check("a classified resume opens no dialog", rpc.dialogs.length === dialogs, JSON.stringify(rpc.dialogs));
				return run;
			});
			const nextHandoff = mains(second.all()).map(newestUser).find(user => user.startsWith(`<storm-run id="${again.runId}"`)) ?? "";
			check(
				"the classified resume continues the run that stopped",
				again.runId !== resumed.runId && again.resumeOf === resumed.runId && again.request === resumed.request && again.limits?.rounds === 2 && again.maxRounds === 2,
				`resumeOf=${again.resumeOf} old=${resumed.runId} request=${again.request === resumed.request} limits=${JSON.stringify(again.limits)}`,
			);
			check("its handoff names the run it continues", nextHandoff.includes(resumed.runId), nextHandoff.slice(0, 240));
		} finally {
			rmSync(limited, { force: true });
		}
	});

	await suite.step("a run record that only sits in the repository is not offered", async () => {
		const plantedId = "run-20990101-000000-e2e0";
		const plantedFile = join(files.stateDir, "runs", `${plantedId}.json`);
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
		writeFileSync(plantedFile, `${JSON.stringify(record, null, 2)}\n`);
		try {
			await session(cancelAll, async rpc => {
				await rpc.prompt("/storm");
				const menu = rpc.dialogs.at(-1)?.options ?? [];
				check(
					"a planted record does not displace a trusted earlier candidate",
					menu[0] === LABEL.resume && files.runs().at(-1)?.runId === plantedId,
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
			});
		} finally {
			rmSync(plantedFile, { force: true });
		}
	});

	await suite.step("a run whose process died is offered after the next session start", async () => {
		const llm = new LlmCursor(env);
		const request = startRun([
			plan([{ name: "impl", kind: "code" }]),
			{ task: ["storm-implementer"], as: "Die", say: "E2E-CHILD-HOLD-ONCE E2E-DIE-MARK" },
			{ awaitChild: true },
		]);
		const killed = new Rpc(env, cancelAll, { model: MAIN });
		await killed.ready();
		const before = files.runIds();
		await killed.prompt(request);
		const dead = await until(() => files.runs().find(run => !before.has(run.runId)), 30_000, "the run before the kill");
		await until(() => children(llm.all()).some(kid => kid.lastUser.includes("E2E-DIE-MARK")), 60_000, "the held child");
		check("the run is active when its process is killed", dead.status === "running" && dead.request !== undefined, `${dead.runId} ${dead.status}`);
		await killed.stop();
		await session(cancelAll, async rpc => {
			await suite.eventually(
				"the dead run is marked stopped at the next session start",
				() => files.run(dead.runId)?.status === "stopped",
				() => JSON.stringify(files.run(dead.runId)?.status),
				30_000,
			);
			await rpc.prompt("/storm");
			const menu = rpc.dialogs.at(-1)?.options ?? [];
			check("the dead run is offered first", menu[0] === LABEL.resume, JSON.stringify(menu));
			const started = files.runIds();
			rpc.answer = choose(LABEL.resume);
			await rpc.prompt("/storm");
			const resumed = await files.finishedRun(started, 120_000);
			check("resuming a dead run records what it continues", resumed.request === dead.request && resumed.resumeOf === dead.runId, `resumeOf=${resumed.resumeOf} old=${dead.runId} status=${resumed.status} ${resumed.endReason}`);
		});
	});

	await suite.step("the storm tool's four actions", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
			let frames = await rpc.turn('E2E-TOOL {"action":"status"}');
			const offered = mains(llm.all())[0]?.stormTool;
			check("the tool offers the staged brief as well as run, plan, status and agents", same(offered?.actions, ["run", "plan", "brief", "status", "agents"]), JSON.stringify(offered?.actions));
			check("its description stays within 900 chars", (offered?.descriptionChars ?? 0) > 0 && (offered?.descriptionChars ?? 0) <= 900, `chars=${offered?.descriptionChars}`);
			check("status: ok", same(toolOutcomes(frames), [{ action: "status", outcome: "ok", isError: false }]), JSON.stringify(toolOutcomes(frames)));
			frames = await rpc.turn('E2E-TOOL {"action":"agents"}');
			check("agents: ok", same(toolOutcomes(frames), [{ action: "agents", outcome: "ok", isError: false }]), JSON.stringify(toolOutcomes(frames)));
			frames = await rpc.turn(`E2E-TOOL ${JSON.stringify(plan([{ name: "impl", kind: "code" }]).storm)}`);
			check("plan outside a run: checked only", same(toolOutcomes(frames), [{ action: "plan", outcome: "ok", isError: false }]), JSON.stringify(toolOutcomes(frames)));
			frames = await rpc.turn('E2E-TOOL {"action":"priority","priority":"cost"}');
			const bytes = files.configBytes();
			check("a team change is no tool action", toolOutcomes(frames).every(result => result.isError) && rpc.dialogs.length === 0 && files.configBytes() === bytes, JSON.stringify(toolOutcomes(frames)));

			const before = files.runIds();
			const from = rpc.frames.length;
			await rpc.prompt(`E2E-TOOL ${JSON.stringify({ action: "run", task: `E2E-STEPS ${JSON.stringify([plan([{ name: "impl", kind: "code" }]), { task: ["storm-implementer"] }])}` })}`);
			const run = await files.finishedRun(before);
			check("run: queued, and started once the turn settled", toolOutcomes(rpc.frames.slice(from))[0]?.outcome === "queued", JSON.stringify(toolOutcomes(rpc.frames.slice(from))));
			check(
				"a run whose subagents changed no file ends after one round",
				run.status === "ended" && run.endReason === "no-changes" && run.turns === 1 && run.spawns.some(spawn => spawn.outcome === "routed"),
				`${run.status} ${run.endReason} turns=${run.turns} ${JSON.stringify(run.spawns.map(spawn => spawn.outcome))}`,
			);
		});
	});

	await suite.step("approval gate on an unapproved config", async () => {
		// A teammate's edit: fewer parallel agents, no architect.
		files.editConfig(config => {
			config.parallelism = 2;
			delete config.roles.architect;
			config.disabledRoles = ["architect"];
		});
		const bytes = files.configBytes();
		const approvals = files.approvals().length;
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
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
		await session(cancelAll, async rpc => {
			let from = rpc.frames.length;
			const run = await runOf(
				rpc,
				startRun([
					{ task: ["storm-explorer"], as: "Early" },
					// omp decides the spawn in the background after task returns: submit the plan only once it was refused.
					{
						...plan(
							[
								{ name: "scope", kind: "explore" },
								{ name: "impl", kind: "code" },
							],
							{ explorer: 3, implementer: 1 },
						),
						after: "[storm:no-plan]",
					},
					{ task: ["storm-implementer", "storm-implementer"], as: "Impl" },
					{ task: ["storm-explorer", "storm-explorer", "storm-explorer"], as: "Exp" },
					{ task: ["storm-architect"], as: "Arch" },
					{ task: ["storm-reviewer"], as: "Rev" },
				]),
			);
			const codes = blockCodes(run);
			const results = asyncResults(rpc.frames.slice(from));
			const detail = JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.outcome, spawn.code]));
			const blocked = (key: string) => run.spawns.find(spawn => spawn.spawnKey === key)?.code;
			check("no plan yet: no-plan", blocked("Early0") === "no-plan" && results.includes("[storm:no-plan]"), detail);
			check("past the plan's workers for the role: role-cap", blocked("Impl1") === "role-cap" && results.includes("[storm:role-cap]"), detail);
			check("past the team's parallelism (2): parallelism", codes.includes("parallelism") && results.includes("[storm:parallelism]"), detail);
			check("a role the team does not use: disabled-role", blocked("Arch0") === "disabled-role" && results.includes("[storm:disabled-role]"), detail);
			check("a role without a lane: role-not-in-plan", blocked("Rev0") === "role-not-in-plan" && results.includes("[storm:role-not-in-plan]"), detail);
			check("every blocked spawn has a code", run.spawns.filter(spawn => spawn.outcome === "blocked").every(spawn => spawn.code !== undefined), detail);
			check("the allowed ones ran", run.spawns.filter(spawn => spawn.outcome === "routed").length >= 2 && children(llm.all()).length >= 2, detail);

			rpc.answer = choose(APPROVE);
			await rpc.prompt(route({ action: "budget", budgetUsd: 0.0001 }, "cap each run"));
			check("a budget is set through the approval dialog", files.config().budget?.perRunUsd === 0.0001, JSON.stringify(files.config().budget));
			const kids = children(llm.all()).length;
			from = rpc.frames.length;
			const capped = await runOf(rpc, startRun([plan([{ name: "impl", kind: "code" }]), { task: ["storm-implementer"], as: "Late" }]));
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
		await session(cancelAll, async rpc => {
			const run = await runOf(
				rpc,
				startRun([
					plan([{ name: "scope", kind: "explore" }]),
					{ task: ["storm-explorer"], as: "Reader", say: "E2E-CHILD-READ notes/big.ts,notes/big.txt,notes/small.txt" },
					{ edit: "director-check.txt", afterResult: "Reader0" },
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
			check("the director's file write is blocked with director-edit", !existsSync(directed) && run.blockedEdits === 1 && results.some(result => result.includes("[storm:director-edit]")), `blockedEdits=${run.blockedEdits}`);
			check("a bare read of a large code file passes", resultOf("notes/big.ts") !== "" && !resultOf("notes/big.ts").includes("[storm:"), resultOf("notes/big.ts").slice(0, 80));
			check("a bare read of large prose passes too (omp pages it)", resultOf("notes/big.txt").includes("E2E-EVIDENCE-2") && !resultOf("notes/big.txt").includes("[storm:"), resultOf("notes/big.txt").slice(0, 120));
			const refused = resultOf("notes/big.txt:1-500");
			check("a 500-line range is refused with read-large, naming the agent that read it", refused.includes("[storm:read-large]") && refused.includes("agent://Reader0"), refused.slice(0, 120));
			check("a 10-line range passes", resultOf("notes/big.txt:1-10").includes("E2E-EVIDENCE-2") && !resultOf("notes/big.txt:1-10").includes("[storm:"));
			check("a small file passes whole", resultOf("notes/small.txt").includes("E2E-SMALL-5") && !resultOf("notes/small.txt").includes("[storm:"));
			const reads = run.reads;
			check(
				"the run record counts reads: 5 returned, 1 blocked, shared chars below the total",
				reads?.director === 5 && reads.blocked === 1 && reads.directorChars > 0 && reads.duplicateChars > 0 && reads.duplicateChars < reads.directorChars,
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
		mkdirSync(agents, { recursive: true });
		writeFileSync(join(agents, "storm-implementer.md"), "---\nname: storm-implementer\ndescription: shadow\n---\nSTORM-ROLE shadow. Reply with OK.\n");
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
			const frames = await rpc.turn("E2E-TASK storm-implementer");
			check("an unapproved definition blocks the role with shadow", asyncResults(frames).includes("[storm:shadow]") && children(llm.all()).length === 0);
			rpc.answer = choose(APPROVE);
			await rpc.prompt("/storm");
			check("/storm asks to approve it", rpc.dialogs.at(-1)?.options[0] === APPROVE, JSON.stringify(rpc.dialogs.at(-1)?.options));
			await rpc.turn("E2E-TASK storm-implementer");
			check("approved, the role runs the shadowing definition", children(llm.all()).some(kid => kid.roles.includes("shadow")));
		});
		rmSync(agents, { recursive: true, force: true });
	});

	await suite.step("quota marks", async () => {
		const marksFile = join(files.stateDir, "quota-marks.json");
		const marks = (): Array<{ provider: string; source: string }> => (existsSync(marksFile) ? (JSON.parse(readFileSync(marksFile, "utf8")) as { marks: Array<{ provider: string; source: string }> }).marks : []);
		const models = files.config().roles.implementer?.models ?? [];
		const provider = (entry: string | undefined) => entry?.split("/")[0];
		const fallback = models.find(model => provider(model) !== provider(models[0]));
		if (!fallback) return suite.skip("quota mark routes to the other provider", `the implementer has no fallback on another provider (${models.join(", ")})`);
		const bytes = files.configBytes();
		let llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
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
		rmSync(marksFile, { force: true });

		// omp itself leaves a model after provider errors: Storm marks that provider (source "fallback") and says so, with no approval.
		writeFileSync(MODELS_FILE, modelsYml(env.port, { ...PROVIDERS, ...QUOTA_OUT }));
		writeFileSync(PROFILE_FILE, FALLBACK_CONFIG);
		llm = new LlmCursor(env);
		try {
			await session(
				cancelAll,
				async rpc => {
					await rpc.turn("hello");
					// omp announces the fallback while the turn goes on; Storm's handler writes the mark and notifies.
					await suite.eventually("omp's own fallback marks the provider", () => marks().some(mark => mark.provider === "fake3" && mark.source === "fallback") && files.configBytes() === bytes, () => JSON.stringify(marks()));
					await suite.eventually("and the user is told", () => rpc.notices().some(([level, message]) => level === "warning" && message.includes("fake3")), () => JSON.stringify(rpc.notices().map(([level]) => level)));
				},
				{ model: "fake3/quota-out" },
			);
		} finally {
			writeFileSync(MODELS_FILE, modelsYml(env.port, PROVIDERS));
			writeFileSync(PROFILE_FILE, PROFILE_CONFIG);
		}
		rmSync(marksFile, { force: true });
	});

	await suite.step("trial routing", async () => {
		const primary = files.config().roles.implementer?.models[0];
		const candidate = "fake/premium-c";
		const llm = new LlmCursor(env);
		await session(choose(APPROVE), async rpc => {
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

	await suite.step("follow-up cap and the fresh-agent handoff", async () => {
		// A subagent at or past its context cap takes no follow-ups during a run: the director starts a fresh one.
		const dialogs = await editAndApprove(config => {
			config.contextCap = 50;
		});
		check("the tiny cap is approved through /storm", dialogs.at(-1)?.answer === APPROVE && files.config().contextCap === 50, JSON.stringify(dialogs.at(-1)));
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
			const run = await runOf(
				rpc,
				startRun([
					plan([{ name: "impl", kind: "code" }]),
					{ task: ["storm-implementer"], as: "Cap" },
					{ followUp: "agent://Cap0" },
					{ task: ["storm-implementer"], as: "Fresh", say: "E2E-CHILD-READ agent://Cap0" },
				]),
			);
			const reason = mains(llm.all()).find(entry => entry.lastTool.includes("[storm:followup-cap]"))?.lastTool ?? "";
			const capped = run.agents?.find(agent => agent.id === "Cap0");
			check("the follow-up is refused with followup-cap", reason !== "" && run.blockedFollowUps === 1 && capped?.followUps === 0, `blockedFollowUps=${run.blockedFollowUps} followUps=${capped?.followUps}`);
			check("the reason names the agent's result and the agent to start", reason.includes("agent://Cap0") && reason.includes("storm-implementer"), reason.slice(0, 200));
			const fresh = children(llm.all()).filter(kid => kid.lastUser.includes("E2E-CHILD-READ"));
			const readBack = fresh.find(kid => kid.lastTool !== "");
			check(
				"a fresh agent reads the capped agent's result and finishes",
				fresh.some(kid => kid.decision.tool === "read" && kid.decision.args?.path === "agent://Cap0") && readBack !== undefined && !readBack.lastTool.includes("[storm:") && run.agents?.some(agent => agent.id === "Fresh0") === true,
				`${readBack?.lastTool.slice(0, 120)} agents=${run.agents?.map(agent => agent.id).join(",")}`,
			);
		});
	});

	await suite.step("mid-run compaction keeps Storm's ledger", async () => {
		// Past its cap, the director is compacted while it waits on an async child. omp keeps the last 20k tokens
		// verbatim by default, so this tiny session would have nothing to summarize: the profile keeps almost nothing
		// for this one run.
		writeFileSync(PROFILE_FILE, `${PROFILE_CONFIG}compaction:\n  keepRecentTokens: 100\n`);
		const llm = new LlmCursor(env);
		try {
			// The fake LLM orders the two sessions: the director's last reply goes out once the child has made its first
			// request (Storm's ledger knows it by then), and the child's reply once the director was compacted.
			const steps: Step[] = [plan([{ name: "ckpt", kind: "code" }]), { task: ["storm-implementer"], as: "Ck", say: "E2E-CHILD-HOLD" }, { awaitChild: true }];
			const run = await session(cancelAll, rpc => runOf(rpc, startRun(steps)));
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

		const llm = new LlmCursor(env);
		await session(choose(APPROVE), async rpc => {
			await rpc.prompt(route({ action: "settings", cleanup: false, docs: false }, "keep records, no doc rules"));
			check("cleanup and doc rules are switched off through the approval dialog", files.config().cleanup !== true && files.config().docs === false, JSON.stringify([files.config().cleanup, files.config().docs]));
			await rpc.turn("E2E-TASK storm-implementer");
			const kid = children(llm.all()).at(-1);
			check("docs off: no doc rules in a role's prompt", kid !== undefined && kid.docRules === null, JSON.stringify(kid?.docRules));
			const kept = await runOf(rpc, CHEAP_RUN);
			check(
				"cleanup off: a run end deletes nothing",
				present(seedFiles) === seedFiles.length && !kept.cleanup?.agents && seeds.every(seed => files.run(seed.runId)?.agents?.[0]?.cleanedAt === undefined),
				`present=${present(seedFiles)}/${seedFiles.length} cleanup=${JSON.stringify(kept.cleanup)}`,
			);

			await rpc.prompt(route({ action: "settings", cleanup: true, docs: true }, "clean up again"));
			check("cleanup is switched on through the approval dialog", files.config().cleanup === true);
			const cleaned = await runOf(rpc, CHEAP_RUN);
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
		});
	});

	await suite.step("heavy main context at run start", async () => {
		const llm = new LlmCursor(env);
		await session(
			cancelAll,
			async rpc => {
				await rpc.turn("hello");
				const run = await runOf(rpc, startRun([plan([{ name: "impl", kind: "code" }]), { task: ["storm-implementer"], as: "Impl" }]));
				const compactions = llm.of("compaction").length;
				check("the run starts without a dialog, after compacting", rpc.dialogs.length === 0 && run.status === "ended" && run.endReason === "no-changes" && compactions > 0, `dialogs=${rpc.dialogs.length} status=${run.status} ${run.endReason} compactions=${compactions}`);
			},
			{ model: "fake/heavy-main" },
		);
	});

	await suite.step("hub, status, rollback", async () => {
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
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
		const bytes = files.configBytes();
		const approvals = files.approvals().length;
		const runs = files.runs().length;
		const autoStore = files.storeDir();
		const autoBefore = autoStore === undefined ? "unset" : await readAutoDelegationChoice(autoStore);
		const llm = new LlmCursor(env);
		const codes = ["/storm setup", "/storm reset", "/storm", "/storm status"].map(command => {
			const args = [env.omp, "-p", "--profile", env.profile, "--no-session", "--no-title", "--auto-approve", "--model", MAIN, command];
			return Bun.spawnSync(args, { cwd: env.project, env: env.childEnv, timeout: 60_000, stderr: Bun.file(join(env.logs, "print.stderr.log")) }).exitCode;
		});
		check("every command exits 0", codes.every(code => code === 0), `exit=${codes.join(",")}`);
		check("config, approvals and runs are untouched", files.configBytes() === bytes && files.approvals().length === approvals && files.runs().length === runs);
		const autoAfter = autoStore === undefined ? "unset" : await readAutoDelegationChoice(autoStore);
		check("the explicit off survives print-mode commands that cannot approve", autoBefore === "off" && autoAfter === "off", `${autoBefore} -> ${autoAfter}`);
		check("no model request", llm.all().length === 0, `requests=${llm.all().length}`);
	});

	await suite.step("reset", async () => {
		const approvals = files.approvals().length;
		const index = files.index().length;
		const trusted = readJsonl<{ runId: string }>(files.trustedFile()).length;
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
			await rpc.prompt("/storm reset");
			check("one confirmation; cancel keeps everything", rpc.dialogs.length === 1 && rpc.dialogs[0]?.options[0] === LABEL.reset && existsSync(files.configFile) && files.approvals().length === approvals, JSON.stringify(rpc.dialogs));
			rpc.answer = choose(LABEL.reset);
			await rpc.prompt("/storm reset");
			const storm = join(env.project, ".omp", "storm");
			const left = existsSync(storm)
				? readdirSync(storm, { recursive: true, withFileTypes: true })
						.filter(entry => entry.isFile())
						.map(entry => join(entry.parentPath, entry.name))
				: [];
			check(
				"the config and the approvals are gone",
				!existsSync(files.configFile) && approvals > 0 && files.approvals().length === 0 && left.every(file => file === files.indexFile || file === join(storm, ".gitignore")),
				`approvals=${files.approvals().length}/${approvals} left=${left.join(",")}`,
			);
			const git = Bun.spawnSync(["git", "-C", env.project, "status", "--porcelain", "--untracked-files=all"]).stdout.toString();
			check("the run summary index stays, out of git", index > 0 && files.index().length === index && !git.includes("index.jsonl"), `index=${files.index().length}/${index}`);
			const kept = readJsonl<{ runId: string }>(files.trustedFile());
			check("the trusted run list (runs.jsonl) stays", trusted > 0 && kept.length === trusted && kept.some(line => line.runId === routedRunId), `runs.jsonl=${kept.length}/${trusted}`);
			const frames = await rpc.turn("E2E-TASK storm-implementer task");
			check("afterwards storm roles are blocked with no-config", asyncResults(frames).includes("[storm:no-config]") && children(llm.all()).length === 1);
			check("and the storm tool is gone", mains(llm.all()).length > 0 && mains(llm.all()).every(entry => entry.stormTool === null));
		});
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
