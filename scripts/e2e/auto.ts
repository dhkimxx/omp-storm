#!/usr/bin/env bun
/** Real OMP, isolated RPC profile and scripted provider; no paid requests. */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE, CANCEL } from "../../src/proposals/present.ts";
import {
	approveTeam,
	cancelAll,
	choose,
	customMessage,
	type Frame,
	linkPlugin,
	LlmCursor,
	modelsYml,
	price,
	prepare,
	PROFILE_CONFIG,
	Rpc,
	type Answer,
	type Step,
	StormFiles,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	TRACKED_FILE,
	until,
	CLOSEOUT_DETAIL,
	closeoutBody,
	closeoutOf,
	isOneLineCloseout,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-auto", 18558);
seedFact(env.project);
const suite = new Suite("E2E (automatic delegation)", env);
const main = "fake/general-b";
/** The one native session this suite drives; every scenario resumes it, so its approvals and choice persist. */
let owned: { id: string; dir: string } | undefined;
/**
 * The typed fixture line and the exact citation a read-only probe reports. The claim restates the line's signed typed
 * value, so the official answer evidence accepts it mechanically rather than leaving it for a reviewer.
 */
const TRACKED_CLAIM = FACT_CLAIM;
const plan = {
	storm: {
		action: "plan",
		plan: { lanes: [{ name: "Probe0", kind: "explore", results: [{ id: "probe-answer", kind: "answer", criterion: "report the tracked fixture from source", path: FACT_FILE, contains: FACT_LINE }] }] },
	},
} as const;
const probe = { task: ["storm-explorer"], as: "Probe", say: `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${TRACKED_CLAIM}` };
const scripted = (...steps: Step[]) => `E2E-STEPS ${JSON.stringify(steps)}`;
/** The text of a tool result frame, joined from its content parts. */
const textOf = (frame: Frame): string => {
	const result = frame.result as { content?: unknown } | undefined;
	if (result?.content === undefined) return "";
	return Array.isArray(result.content) ? result.content.map(part => (part !== null && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : String(result.content);
};

/** Option labels Storm does not export. */
const AUTO = { on: "자동 위임 켜기", off: "자동 위임 끄기" } as const;
/** The legacy hub's two explicit choices; a missing choice file is not consent either way. */
const MIGRATE = { convert: "자동 위임으로 전환", direct: "직접 작업 유지" } as const;
/** What the approval panel says a first team approval now does. */
const TURNS_AUTO_ON = "승인하면 이 세션의 자동 위임이 켜집니다";
/** The removed setup-time question: it must not appear after the single team approval. */
const OLD_PROMPT = "자동 위임을 켤까요?";
/** The automatic-delegation choice file of Storm before this change; its absence is the legacy fixture. */
const CHOICE_FILE = "auto-delegation.json";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** RPC UI capable hosts can additionally offer the role interview in the same approval. */
const setupOptions = (options: readonly string[] | undefined): boolean =>
	same(options, [APPROVE, CANCEL]) || same(options, [APPROVE, "역할별로 고르기", CANCEL]);
const reports = (frames: readonly Frame[]): string[] => frames.filter(frame => customMessage(frame) === "storm-report").map(frame => JSON.stringify(frame));

async function session<T>(answer: Answer, exercise: (rpc: Rpc, files: StormFiles) => Promise<T>, options: { fresh?: boolean } = {}): Promise<T> {
	const resume = options.fresh ? undefined : owned;
	const rpc = new Rpc(env, answer, { model: main, ...(resume === undefined ? {} : { resume: resume.id, sessionDir: resume.dir }) });
	try {
		await rpc.ready();
		return await exercise(rpc, new StormFiles(env, rpc.sessionId));
	} finally {
		const code = await rpc.close();
		suite.check("OMP exits cleanly", code === 0, `exit=${code}`);
		if (owned === undefined && options.fresh !== true) owned = { id: rpc.sessionId, dir: rpc.sessionDir };
	}
}

/** The owned session's reader for code that runs outside a body (a direct Rpc, a step's setup). */
function ownedFiles(): StormFiles {
	if (owned === undefined) throw new Error("the auto fixture session was not created");
	return new StormFiles(env, owned.id);
}

/** The durable choice through the storage API, not through whether the guard happens to be on. */
async function choice(files: StormFiles): Promise<string> {
	return readAutoDelegationChoice(files.sessionDir);
}

/** Polls until the explicit choice is stored; the setup command writes its own state before it returns. */
async function waitChoice(files: StormFiles, expected: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await readAutoDelegationChoice(files.sessionDir)) === expected) return;
		if (Date.now() > deadline) throw new Error(`automatic-delegation choice is ${await readAutoDelegationChoice(files.sessionDir)}, expected ${expected}`);
		await Bun.sleep(50);
	}
}

/** A pre-upgrade approved team: the real approval and config, with no personal choice file at all. */
async function withoutChoiceFile(files: StormFiles): Promise<void> {
	rmSync(join(files.sessionDir, CHOICE_FILE), { force: true });
	await waitChoice(files, "unset");
}

/** Removes a file the scripted main session may or may not have written, so the next assertion starts clean. */
function resetFile(name: string): void {
	rmSync(join(env.project, name), { force: true });
}

/**
 * `tight-main` reports a 75k prompt on a 100k window (fake-llm.ts): a director past 70% of its window, for the
 * mid-run checkpoint. Its window is below every role minimum, so no recommended team contains it.
 */
const TIGHT_MAIN = "fake/tight-main";
writeFileSync(
	join(env.agentDir, "models.yml"),
	modelsYml(env.port, { ...TEAM_PROVIDERS, fake: [...TEAM_PROVIDERS.fake, { id: "tight-main", cost: price(1, 4), context: 100_000 }] }),
);
writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
const server = await startFakeLlm(env);
try {
	linkPlugin(env);

	await suite.step("a new setup leaves stock tools alone until the team is approved", async () => {
		const direct = "direct-before-team.txt";
		await session(cancelAll, async (rpc, files) => {
			const frames = await rpc.turn(scripted({ read: TRACKED_FILE }, { edit: direct }));
			suite.check(
				"without a team, a read runs as stock omp",
				frames.some(frame => frame.type === "tool_execution_end" && frame.toolName === "read" && frame.isError !== true),
				JSON.stringify(frames.filter(frame => frame.type === "tool_execution_end")),
			);
			suite.check("without a team, a write runs as stock omp", existsSync(join(env.project, direct)));
			suite.check("no run was opened", files.runIds().size === 0);

			const dialogs = rpc.dialogs.length;
			await rpc.prompt("/storm setup");
			suite.check(
				"the new setup asks for the team, with nothing else",
				rpc.dialogs.length === dialogs + 1 && setupOptions(rpc.dialogs.at(-1)?.options),
				JSON.stringify(rpc.dialogs.slice(dialogs)),
			);
			suite.check("declining saves no config and no approval", !existsSync(files.configFile) && files.approvals().length === 0);
			suite.check("declining stores no automatic-delegation choice", (await choice(files)) === "unset");

			resetFile(direct);
			await rpc.turn(scripted({ edit: "direct-declined-team.txt" }));
			suite.check("declining leaves stock edits available", existsSync(join(env.project, "direct-declined-team.txt")));
			resetFile("direct-declined-team.txt");
		});
	});

	await suite.step("the single default team approval turns automatic delegation on and fences ordinary prompts", async () => {
		const direct = "direct-after-team.txt";
		const llm = new LlmCursor(env);
		await session(choose(APPROVE), async (rpc, files) => {
			const frames = await rpc.prompt("/storm setup");
			suite.check(
				"one approval is the only dialog: no separate automatic-delegation prompt",
				rpc.dialogs.length === 1 &&
					setupOptions(rpc.dialogs.at(-1)?.options) &&
					rpc.dialogs.every(dialog => !dialog.title.includes(OLD_PROMPT) && !dialog.options.includes(AUTO.on)),
				JSON.stringify(rpc.dialogs),
			);
			suite.check(
				"the approval panel discloses that approval turns automatic delegation on",
				reports(frames).some(report => report.includes(TURNS_AUTO_ON)),
				reports(frames).map(report => report.slice(0, 400)).join(" | "),
			);
			suite.check("approve saves one config and one approval", existsSync(files.configFile) && files.approvals().length === 1);
			await waitChoice(files, "on");

			await rpc.turn(scripted({ edit: direct }, { bash: "printf nope > direct-shell-after-team.txt" }));
			suite.check(
				"an ordinary repo prompt cannot write through the file tool or shell",
				!existsSync(join(env.project, direct)) && !existsSync(join(env.project, "direct-shell-after-team.txt")),
			);
			suite.check("the refusal names automatic delegation as what owns repository work", llm.of("main").some(entry => entry.lastTool.includes("자동 위임")));
			suite.check("refused ordinary work opens no run", files.runIds().size === 0);
			resetFile(direct);
			resetFile("direct-shell-after-team.txt");
		});
	});

	await suite.step("a chosen off is durable, survives setup, and the explicit switch turns it back on", async () => {
		await session(cancelAll, async (rpc, files) => {
			rpc.answer = choose(AUTO.off);
			await rpc.prompt("/storm auto");
			suite.check("the explicit switch offers turning it off", same(rpc.dialogs.at(-1)?.options, [AUTO.off, CANCEL]), JSON.stringify(rpc.dialogs.at(-1)));
			await waitChoice(files, "off");
			const off = new LlmCursor(env);
			await rpc.turn(scripted({ edit: "direct-after-off.txt" }));
			suite.check(
				"auto off leaves zero Storm bytes in the system prompt",
				off.of("main").length > 0 && off.of("main").every(entry => entry.stormBlockBytes === 0),
				JSON.stringify(off.of("main").map(entry => ({ stormBlockBytes: entry.stormBlockBytes, systemBytes: entry.systemBytes }))),
			);
			suite.check("turning it off restores stock edits in the same session", existsSync(join(env.project, "direct-after-off.txt")));
			suite.check("no run was opened", files.runIds().size === 0);
			resetFile("direct-after-off.txt");
		});
		await session(cancelAll, async rpc => {
			await rpc.turn(scripted({ edit: "direct-off-next-session.txt" }));
			suite.check("off is durable when the same native session is opened again", existsSync(join(env.project, "direct-off-next-session.txt")));
			resetFile("direct-off-next-session.txt");
		});

		// A never-approved value: the recommendation carries it, the file is unapproved, and the hash cannot match an
		// earlier approval. Toggling a field can coincide with an old approval and make /storm setup report "unchanged".
		const active = ownedFiles();
		active.editConfig(config => {
			config.rounds = 8;
		});
		const approvals = active.approvals().length;
		await session(choose(APPROVE), async (rpc, files) => {
			await rpc.prompt("/storm setup");
			suite.check(
				"re-setup approves once without asking the automatic-delegation question",
				files.approvals().length === approvals + 1 &&
					rpc.dialogs.length === 1 &&
					rpc.dialogs.every(dialog => !dialog.title.includes(OLD_PROMPT) && !dialog.options.includes(AUTO.on)),
				JSON.stringify(rpc.dialogs),
			);
			await waitChoice(files, "off");
			await rpc.turn(scripted({ edit: "direct-after-resetup.txt" }));
			suite.check("a chosen off survives /storm setup and leaves stock edits available", existsSync(join(env.project, "direct-after-resetup.txt")));
			resetFile("direct-after-resetup.txt");
		});

		await session(cancelAll, async (rpc, files) => {
			rpc.answer = choose(AUTO.on);
			await rpc.prompt("/storm auto");
			suite.check("the explicit switch offers turning it on", same(rpc.dialogs.at(-1)?.options, [AUTO.on, CANCEL]), JSON.stringify(rpc.dialogs.at(-1)));
			await waitChoice(files, "on");
			await rpc.turn(scripted({ edit: "direct-after-reenable.txt" }));
			suite.check("turning it on fences ordinary prompts again", !existsSync(join(env.project, "direct-after-reenable.txt")));
			resetFile("direct-after-reenable.txt");
		});
	});

	await suite.step("auto consent permits conversation but fences direct work before and after a run", async () => {
		await session(cancelAll, async (rpc, files) => {
			const before = files.runIds();
			const chat = new LlmCursor(env);
			await rpc.turn("Hello. No repository task.");
			suite.check("conversation has one main request and no run, classifier or worker", chat.of("main").length === 1 && chat.of("route").length === 0 && chat.of("child").length === 0 && files.runIds().size === before.size);
			const greeting = chat.of("main")[0];
			suite.check(
				"plain chat carries the fixed Storm bootstrap under 1,300 B, not a classifier",
				greeting !== undefined && greeting.stormBlockBytes > 0 && greeting.stormBlockBytes <= 1_300,
				`block=${greeting?.stormBlockBytes} B (review baseline 4,209, budget 1,300)`,
			);
			suite.check(
				"the offered storm tool serializes under the 4,904 B review baseline",
				greeting !== undefined && greeting.stormToolBytes > 0 && greeting.stormToolBytes <= 4_904,
				`tool=${greeting?.stormToolBytes} B (review baseline 4,904)`,
			);
			const repeat = new LlmCursor(env);
			await rpc.turn("Thanks. Still just conversation.");
			const again = repeat.of("main")[0];
			suite.check(
				"the bootstrap and the whole system prompt stay byte-identical across plain chat turns",
				repeat.of("main").length === 1 && greeting !== undefined && again !== undefined &&
					greeting.stormBlockBytes === again.stormBlockBytes && greeting.systemSha256 === again.systemSha256,
				`block=${greeting?.stormBlockBytes}→${again?.stormBlockBytes} system=${greeting?.systemSha256}→${again?.systemSha256}`,
			);
			suite.check("plain chat still opens no run", files.runIds().size === before.size);

			await rpc.turn(scripted({ edit: "direct-before.txt" }, { bash: "printf nope > direct-shell.txt" }));
			suite.check("the director cannot write through either the file tool or shell", !existsSync(join(env.project, "direct-before.txt")) && !existsSync(join(env.project, "direct-shell.txt")));
			suite.check("refused direct work does not open a run", files.runIds().size === before.size);

			const dispatch = new LlmCursor(env);
			const prompt = scripted(plan, probe);
			const receivedAt = Date.now();
			await rpc.turn(prompt);
			const run = await files.finishedRun(before, 20_000);
			suite.check("first plan opens one run and dispatches one approved worker", run.request === prompt && run.plan?.lanes[0]?.name === "Probe0" && run.spawns.filter(spawn => spawn.outcome !== "blocked").length === 1 && dispatch.of("child").length > 0);
			suite.check("routing used the original user turn, not a classifier or a duplicated handoff", dispatch.of("route").length === 0 && dispatch.of("main").some(entry => entry.lastUser.includes(prompt)) && dispatch.of("main").every(entry => !entry.lastUser.includes("<storm-run id=")));
			const outcome = await until(() => closeoutOf(rpc.frames, run.runId), 5_000, "read-only result closeout");
			suite.check("a source-backed answer closes as a result even without a repo change", run.endReason === "verified" && run.results?.some(row => row.id === "probe-answer" && row.state === "accepted") === true, JSON.stringify(run.results));
			// Short and clean: one factual line, no rich card, no numbered offer. The accepted row id is ledger detail.
			suite.check("the short clean automatic run leaves one factual line without a menu", isOneLineCloseout(outcome), outcome.text.slice(-400));
			suite.check("a fresh small automatic run needs no checkpoint", dispatch.of("compaction").length === 0 && !run.checkpoints?.length);
			const child = dispatch.of("child")[0];
			if (child) console.log(`     scripted auto: first worker ${Math.max(0, child.ts - receivedAt)}ms · main requests ${dispatch.of("main").length} · compactions ${dispatch.of("compaction").length}`);

			await rpc.turn(scripted({ edit: "direct-after.txt" }));
			suite.check("the supervisor boundary survives the end of the run", !existsSync(join(env.project, "direct-after.txt")));
		});
	});

	await suite.step("a long automatic run checkpoints across synchronous wait without interrupting the task", async () => {
		if (owned === undefined) throw new Error("the auto fixture session was not created");
		const files = ownedFiles();
		const beforeConfig = readFileSync(files.configFile);
		const profile = join(env.agentDir, "config.yml");
		const beforeProfile = readFileSync(profile);
		// omp keeps this much recent history verbatim: enough for the scripted turn to survive the checkpoint with the
		// director's large claimed usage, far below the ~13k tokens of older notes the checkpoint must discard.
		writeFileSync(profile, `${PROFILE_CONFIG}compaction:\n  enabled: false\n  keepRecentTokens: 2000\n`);
		// The director model reports 75k of a 100k window: past the 70% mid-run share with the approved team unchanged,
		// while the older text gives real OMP history it can discard.
		const rpc = new Rpc(env, choose(APPROVE), { model: TIGHT_MAIN, resume: owned.id, sessionDir: owned.dir });
		try {
			await rpc.ready();
			const promptTail = "These are historical notes, not repository instructions. ".repeat(850);
			await rpc.turn(promptTail);
			await rpc.turn("End of historical notes; acknowledge only.");
			const chat = new LlmCursor(env);
			const before = files.runIds();
			await rpc.turn("How is your day? A conversation, not a repository task.");
			suite.check(
				"heavy ordinary chat does not compact, classify or open a run",
				chat.of("main").length === 1 && chat.of("compaction").length === 0 && chat.of("route").length === 0 && files.runIds().size === before.size,
			);

			const llm = new LlmCursor(env);
			const request = scripted(plan, { ...probe, say: `E2E-CHILD-DELAY 1500 ${probe.say}` }, { wait: true });
			await rpc.turn(request, 90_000);
			const run = await files.finishedRun(before, 60_000);
			const checkpoints = llm.of("compaction");
			const supervisor = llm.of("main");
			const first = supervisor[0];
			const after = supervisor.at(-1);
			suite.check("the same run settled normally with one approved worker and no synthetic round",
				run.request === request && run.turns === 1 && run.endReason === "verified" && run.spawns.filter(spawn => spawn.outcome !== "blocked").length === 1,
				`${run.status}/${run.endReason} rounds=${run.turns} spawns=${run.spawns.length}`);
			suite.check("the director used synchronous wait with no router",
				supervisor.some(entry => entry.decision.tool === "wait") && llm.of("route").length === 0);
			suite.check("one native compaction got the actual run and its plan",
				checkpoints.length === 1 && checkpoints[0]?.compactionContext.includes(run.runId) && checkpoints[0].compactionContext.includes("Probe0"),
				`compaction calls=${checkpoints.length}`);
			suite.check("omp applied the checkpoint and sent less history during the same task",
				run.checkpoints?.length === 1 && first !== undefined && after !== undefined && first.historyChars > 30_000 && after.historyChars < first.historyChars / 2,
				`checkpoints=${JSON.stringify(run.checkpoints)} chars=${first?.historyChars}→${after?.historyChars}`);
		} finally {
			await rpc.close();
			writeFileSync(profile, beforeProfile);
			writeFileSync(files.configFile, beforeConfig);
		}
	});

	await suite.step("read-only runs are independent, while a second writer cannot share the tree", async () => {
		const owner = new Rpc(env, cancelAll, { model: main });
		const blocked = new Rpc(env, cancelAll, { model: main });
		const successor = new Rpc(env, cancelAll, { model: main });
		let stopped = false;
		let blockedOpen = true;
		const ownerFile = "e2e-lease-owner.txt";
		const writePlan = (file: string): Step => ({
			storm: {
				action: "plan",
				plan: {
					lanes: [{ name: "write", kind: "code", results: [{ id: "lease-write", kind: "change", criterion: `the writer writes ${file}`, path: file, contains: "storm child change" }] }],
				},
			},
		});
		try {
			await Promise.all([owner.ready(), blocked.ready()]);
			await Promise.all([approveTeam(owner, "on"), approveTeam(blocked, "on")]);
			const ownerFiles = new StormFiles(env, owner.sessionId);
			const blockedFiles = new StormFiles(env, blocked.sessionId);

			// Two read-only runs at once, in the same checkout, must both finish and stay in their own history.
			const ownerReads = ownerFiles.runIds();
			const blockedReads = blockedFiles.runIds();
			const readProbe = { ...probe, say: `E2E-CHILD-DELAY 1200 ${probe.say}` };
			await Promise.all([owner.prompt(scripted(plan, readProbe)), blocked.prompt(scripted(plan, readProbe))]);
			const [firstRead, secondRead] = await Promise.all([ownerFiles.finishedRun(ownerReads, 30_000), blockedFiles.finishedRun(blockedReads, 30_000)]);
			suite.check("two concurrent read-only runs finish independently", firstRead.runId !== secondRead.runId && firstRead.status !== "running" && secondRead.status !== "running", `${firstRead.runId} ${secondRead.runId}`);
			suite.check(
				"each read-only run appears only in its own session history",
				blockedFiles.run(secondRead.runId) !== undefined && blockedFiles.run(firstRead.runId) === undefined && ownerFiles.run(firstRead.runId) !== undefined && ownerFiles.run(secondRead.runId) === undefined,
			);

			// A writer holds the target; a second session's write run must not start while it lives.
			const ownerWrites = ownerFiles.runIds();
			await owner.prompt(scripted(writePlan(ownerFile), { task: ["storm-implementer"], as: "Lease", say: `E2E-CHILD-WRITE ${ownerFile} E2E-CHILD-DELAY 4000` }));
			const live = await until(() => ownerFiles.runs().find(run => !ownerWrites.has(run.runId) && run.status === "running"), 10_000, "first process owns the write run");
			const contenderRuns = blockedFiles.runIds();
			const start = new LlmCursor(env);
			const contender = await blocked.turn(scripted(writePlan("e2e-lease-contender.txt"), { task: ["storm-implementer"], as: "Lease", say: "E2E-CHILD-WRITE e2e-lease-contender.txt" }));
			const contenderChildren = start.of("child").filter(entry => entry.lastUser.includes("e2e-lease-contender.txt")).length;
			const contenderText = contender.flatMap(frame => {
				if (frame.type === "tool_execution_end" && frame.toolName === "task") return [textOf(frame)];
				const message = frame.message;
				if (message !== undefined && typeof message === "object" && message.content !== undefined) return [JSON.stringify(message.content)];
				return typeof message === "string" ? [message] : [];
			}).join("\n");
			suite.check(
				"the contender did not start a second write run or dispatch another child",
				blockedFiles.runIds().size === contenderRuns.size && contenderChildren === 0 && ownerFiles.run(live.runId)?.status === "running",
				`runs=${blockedFiles.runIds().size}/${contenderRuns.size} contenderChildren=${contenderChildren} owner=${ownerFiles.run(live.runId)?.status}`,
			);
			suite.check(
				"the contender was refused with the cause: the other session's run holds the tree",
				contenderText.includes("다른 Storm 실행") && contenderText.includes("쓰고 있습니다") && contenderText.includes(live.runId),
				contenderText.slice(-500) || "no refusal text",
			);
			await owner.stop();
			stopped = true;
			await blocked.close();
			blockedOpen = false;

			await successor.ready();
			await approveTeam(successor, "on");
			const successorFiles = new StormFiles(env, successor.sessionId);
			const surviving = successorFiles.runIds();
			await successor.turn(scripted(writePlan("e2e-lease-successor.txt"), { task: ["storm-implementer"], as: "Lease", say: "E2E-CHILD-WRITE e2e-lease-successor.txt" }));
			const next = await successorFiles.finishedRun(surviving, 45_000);
			suite.check("after confirmed owner death another process can write", next.spawns.some(spawn => spawn.outcome !== "blocked") && next.runId !== live.runId);
		} finally {
			if (!stopped) await owner.stop();
			await Promise.all([blockedOpen ? blocked.close() : Promise.resolve(undefined), successor.close()]);
			for (const file of [ownerFile, "e2e-lease-contender.txt", "e2e-lease-successor.txt"]) rmSync(join(env.project, file), { force: true });
		}
	});

	await suite.step("a reviewer cannot replace a configured real check", async () => {
		const files = ownedFiles();
		for (const shouldPass of [true, false]) {
			const output = shouldPass ? "approved-check-pass.txt" : "approved-check-fail.txt";
			const exit = shouldPass ? "0" : "7";
			files.editConfig(config => {
				config.requiredChecks = [{
					name: "assert-worker-produced-change",
					argv: [process.execPath, "-e", `process.exit(require('node:fs').existsSync(process.argv[1]) ? ${exit} : 8)`, output],
				}];
			});
			try {
				await session(choose(APPROVE), async (rpc, files) => {
					await rpc.prompt("/storm");
					const before = files.runIds();
					const steps: Step[] = [
						{ storm: { action: "plan", plan: { lanes: [{ name: "Impl0", kind: "code", results: [{ id: "impl-change", kind: "change", criterion: `the implementer writes ${output}`, path: output, contains: "storm child change" }] }, { name: "Review0", kind: "review" }] } } },
						{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-WRITE ${output}` },
						{ task: ["storm-reviewer"], as: "Review", say: "E2E-CHILD-VERDICT correct", afterResult: 'agent="storm-implementer" status="completed"' },
					];
					await rpc.prompt(scripted(...steps));
					const run = await files.finishedRun(before, 30_000);
					const reviewed = run.agents?.some(agent => agent.role === "reviewer" && agent.lastVerdict?.correct);
					suite.check("the implementer changed the tree and an independent reviewer approved it", existsSync(join(env.project, output)) && reviewed === true);
					suite.check(`a real check exiting ${exit} ${shouldPass ? "allows" : "blocks"} verified`, shouldPass ? run.status === "done" && run.endReason === "verified" : run.status !== "done", `${run.status}/${run.endReason}`);
				});
			} finally {
				rmSync(join(env.project, output), { force: true });
			}
		}
	});

	await suite.step("a required check's own timeoutMs cuts it, while the same check without one passes", async () => {
		// The same 4 s check twice: cut with its own 1.5 s limit, passed under the default without one, so only the
		// per-check value differs between the two runs.
		const files = ownedFiles();
		const sleeper = [process.execPath, "-e", "setTimeout(() => process.exit(0), 4000)"];
		for (const timeoutMs of [1_500, undefined]) {
			const output = timeoutMs === undefined ? "timed-check-free.txt" : "timed-check-cut.txt";
			files.editConfig(config => {
				config.requiredChecks = [{ name: "slow-check", argv: sleeper, ...(timeoutMs === undefined ? {} : { timeoutMs }) }];
			});
			try {
				await session(choose(APPROVE), async (rpc, files) => {
					await rpc.prompt("/storm");
					if (!rpc.dialogs.some(dialog => dialog.answer === APPROVE)) throw new Error("the timed check team was not approved");
					const before = files.runIds();
					const steps: Step[] = [
						{ storm: { action: "plan", plan: { lanes: [{ name: "Impl0", kind: "code", results: [{ id: "timed-change", kind: "change", criterion: `the implementer writes ${output}`, path: output, contains: "storm child change" }] }, { name: "Review0", kind: "review" }] } } },
						{ task: ["storm-implementer"], as: "Impl", say: `E2E-CHILD-WRITE ${output}` },
						{ task: ["storm-reviewer"], as: "Review", say: "E2E-CHILD-VERDICT correct", afterResult: 'agent="storm-implementer" status="completed"' },
					];
					await rpc.prompt(scripted(...steps));
					const run = await files.finishedRun(before, 60_000);
					const evidence = run.checks?.filter(entry => entry.name === "slow-check") ?? [];
					const detail = `${run.status}/${run.endReason} checks=${JSON.stringify(evidence)}`;
					if (timeoutMs !== undefined) {
						suite.check("the check with its own 1.5 s limit is timed out and blocks verified", evidence.length > 0 && evidence.every(entry => entry.status === "timed-out") && run.status !== "done", detail);
					} else {
						suite.check("the same check without a limit runs its 4 s and the run is verified", evidence.some(entry => entry.status === "passed") && run.status === "done" && run.endReason === "verified", detail);
					}
				});
			} finally {
				rmSync(join(env.project, output), { force: true });
			}
		}
	});

	await suite.step("a batch overlaps independent resource lanes and reports real failures without AI workers", async () => {
		const rendezvous = join(env.work, "job-rendezvous");
		const resource = `test-device:${new Bun.CryptoHasher("sha256").update(env.work).digest("hex").slice(0, 12)}`;
		const argv = (id: string, other: string, exit: number) => [
			process.execPath, "-e",
			[
				'const fs=require("node:fs"), path=require("node:path");',
				"const [root,id,other,exit]=process.argv.slice(-4);",
				'fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(path.join(root,id),"started");',
				'fs.appendFileSync(path.join(root,"events"), id+"\\n");',
				"const limit=Date.now()+3000;",
				"while(other && !fs.existsSync(path.join(root,other)) && Date.now()<limit) await new Promise(r=>setTimeout(r,10));",
				"if(other && !fs.existsSync(path.join(root,other))) process.exit(9);",
				'console.log("JOB-RECEIPT:"+id); process.exit(Number(exit));',
			].join(" "),
			rendezvous, id, other, String(exit),
		];
		ownedFiles().editConfig(config => {
			delete config.requiredChecks;
			config.jobs = [
				{ name: "case-a", argv: argv("a", "b", 0), resources: [`${resource}:a`] },
				{ name: "case-b", argv: argv("b", "a", 0), resources: [`${resource}:b`] },
				{ name: "case-c", argv: argv("c", "", 7), resources: [`${resource}:a`] },
			];
		});
		try {
			await session(choose(APPROVE), async (rpc, files) => {
				await rpc.prompt("/storm");
				if (!rpc.dialogs.some(dialog => dialog.answer === APPROVE)) throw new Error("the named job fixture team was not approved");
				const start = files.runIds();
				const dialogs = rpc.dialogs.length;
				const llm = new LlmCursor(env);
				const lanes = ["a", "b", "c"].map(id => ({
					name: `case-${id}`, kind: "run", job: `case-${id}`,
					results: [{ id: `result-${id}`, kind: "answer", criterion: `real case-${id} receipt marker`, contains: `JOB-RECEIPT:${id}` }],
				}));
				await rpc.turn(scripted(
					{ storm: { action: "plan", plan: { lanes } } },
					{ storm: { action: "execute", lanes: ["unplanned"] } },
					{ storm: { action: "execute", lanes: lanes.map(lane => lane.name) } },
					{ storm: { action: "execute", lanes: ["case-a", "case-b"] } },
				));
				const run = await files.finishedRun(start, 30_000);
				const jobs = new Map(run.jobs?.map(job => [job.name, job]));
				const a = jobs.get("case-a"), b = jobs.get("case-b"), c = jobs.get("case-c");
				suite.check("two resources rendezvous, while the third case waits for resource A",
					a?.status === "passed" && b?.status === "passed" && c?.status === "failed" &&
						c.exitCode === 7 && c.startedAt !== null && a.finishedAt !== null && c.startedAt >= a.finishedAt,
					JSON.stringify(run.jobs));
				suite.check("no worker/config dialog and only the failed case remains open",
					llm.of("child").length === 0 && rpc.dialogs.length === dialogs &&
						run.results?.filter(row => row.state === "accepted").length === 2 &&
						run.results?.find(row => row.id === "result-c")?.state === "unmet" && run.endReason !== "verified",
					JSON.stringify(run.results));
				suite.check("only planned jobs run once; retrying accepted lanes has no side effect",
					existsSync(join(rendezvous, "events")) && same(readFileSync(join(rendezvous, "events"), "utf8").trim().split("\n").sort(), ["a", "b", "c"]));
				const card = await until(() => closeoutOf(rpc.frames, run.runId), 5_000, "partial-result closeout");
				// The failed row stays named in the final ledger (checked above); the card keeps the whole official
				// aggregate and points to the status view instead of listing result ids or job receipts.
				const body = closeoutBody(card.text);
				suite.check(
					"an incomplete run keeps the whole card: official state, open count and the status pointer",
					!isOneLineCloseout(card) && body.length > 1 && card.text.includes(CLOSEOUT_DETAIL) && /2\s*\/\s*3/.test(card.text),
					card.text.slice(-600),
				);
				suite.check("the compact card no longer repeats job receipts", !card.text.includes("잡 영수증"), card.text.slice(-600));
			});
		} finally {
			rmSync(rendezvous, { recursive: true, force: true });
		}
	});

	await suite.step("stale approval blocks new work, not the supervisor boundary", async () => {
		// Never approved before: the team is stale even though older approval records still exist.
		ownedFiles().editConfig(config => { config.rounds = 9; });
		await session(cancelAll, async (rpc, files) => {
			const start = files.runIds();
			const dispatch = new LlmCursor(env);
			await rpc.turn(scripted({ storm: plan.storm }, probe, { edit: "direct-when-blocked.txt" }));
			suite.check("unapproved work cannot start a worker or bypass delegation", files.runIds().size === start.size && dispatch.of("child").length === 0 && !existsSync(join(env.project, "direct-when-blocked.txt")));
		});
	});

	await suite.step("a missing automatic choice is plain off, and old migration offers are gone", async () => {
		const active = ownedFiles();
		const approvals = active.approvals().length;
		await session(choose(APPROVE), async (rpc, files) => {
			await rpc.prompt("/storm");
			suite.check("the team left unapproved is approved again", files.approvals().length === approvals + 1);
			await withoutChoiceFile(files);
		});

		await session(cancelAll, async (rpc, files) => {
			const dialogs = rpc.dialogs.length;
			await rpc.turn(scripted({ edit: "legacy-load-direct.txt" }));
			suite.check("a missing choice file leaves stock edits alone", existsSync(join(env.project, "legacy-load-direct.txt")));
			resetFile("legacy-load-direct.txt");
			suite.check("plugin load asks nothing about an old consent", rpc.dialogs.length === dialogs, JSON.stringify(rpc.dialogs.slice(dialogs)));

			const frames = await rpc.prompt("/storm status");
			suite.check("/storm status reports without a dialog", rpc.dialogs.length === dialogs && reports(frames).length === 1, `dialogs=${rpc.dialogs.length - dialogs} reports=${reports(frames).length}`);
			const afterStatus = await rpc.turn(scripted({ read: TRACKED_FILE }, { edit: "legacy-after-status.txt" }));
			suite.check(
				"/storm status leaves stock reads and writes unfenced",
				afterStatus.some(frame => frame.type === "tool_execution_end" && frame.toolName === "read" && frame.isError !== true) && existsSync(join(env.project, "legacy-after-status.txt")),
			);
			resetFile("legacy-after-status.txt");

			await rpc.prompt("/storm");
			const options = rpc.dialogs.at(-1)?.options ?? [];
			suite.check(
				"the hub offers no conversion of a pre-session consent",
				!options.includes(MIGRATE.convert) && !options.includes(MIGRATE.direct),
				JSON.stringify(options),
			);
			suite.check("reading the hub writes no choice", (await choice(files)) === "unset");

			rpc.answer = choose(AUTO.on);
			await rpc.prompt("/storm auto");
			await waitChoice(files, "on");
			await rpc.turn(scripted({ edit: "legacy-fenced.txt" }));
			suite.check("the explicit on fences ordinary repository writes", !existsSync(join(env.project, "legacy-fenced.txt")));
			resetFile("legacy-fenced.txt");
		});

		await session(cancelAll, async (rpc, files) => {
			await rpc.turn(scripted({ edit: "legacy-fenced-next.txt" }));
			suite.check("on stays on when the same native session is opened again", !existsSync(join(env.project, "legacy-fenced-next.txt")));
			resetFile("legacy-fenced-next.txt");

			// A value approved nowhere in this fixture, so the changed file is unapproved and /storm setup must really
			// re-approve it; a previously approved value would be reported as "unchanged" and test nothing.
			files.editConfig(config => {
				config.rounds = 10;
			});
			const later = files.approvals().length;
			rpc.answer = choose(APPROVE);
			await rpc.prompt("/storm setup");
			suite.check(
				"re-setup approves the changed team without asking about automatic delegation",
				files.approvals().length === later + 1 &&
					rpc.dialogs.length === 1 &&
					rpc.dialogs.every(dialog => !dialog.title.includes(OLD_PROMPT) && !dialog.options.includes(AUTO.on)),
				JSON.stringify(rpc.dialogs),
			);
			suite.check("the explicit on survives /storm setup", (await choice(files)) === "on");
		});
	});
} finally {
	server.kill();
	await server.exited;
}
process.exitCode = suite.finish();
