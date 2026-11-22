#!/usr/bin/env bun
/** Real OMP, isolated RPC profile and scripted provider; no paid requests. */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE, CANCEL } from "../../src/proposals/present.ts";
import {
	cancelAll,
	choose,
	customMessage,
	type Frame,
	linkPlugin,
	LlmCursor,
	modelsYml,
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
} from "./harness.ts";

const env = prepare("storm-e2e-auto", 18558);
const suite = new Suite("E2E (automatic delegation)", env);
const files = new StormFiles(env);
const main = "fake/general-b";
const plan = { storm: { action: "plan", plan: { lanes: [{ name: "Probe0", kind: "explore" }] } } } as const;
const probe = { task: ["storm-explorer"], as: "Probe", say: `E2E-CHILD-READ ${TRACKED_FILE}` };
const scripted = (...steps: Step[]) => `E2E-STEPS ${JSON.stringify(steps)}`;

/** Option labels Storm does not export. */
const AUTO = { on: "자동 위임 켜기", off: "자동 위임 끄기" } as const;
/** The legacy hub's two explicit choices; a missing choice file is not consent either way. */
const MIGRATE = { convert: "자동 위임으로 전환", direct: "직접 작업 유지" } as const;
/** What the approval panel says a first team approval now does. */
const TURNS_AUTO_ON = "승인하면 자동 위임이 켜집니다";
/** The removed setup-time question: it must not appear after the single team approval. */
const OLD_PROMPT = "자동 위임을 켤까요?";
/** The automatic-delegation choice file of Storm before this change; its absence is the legacy fixture. */
const CHOICE_FILE = "auto-delegation.json";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** RPC UI capable hosts can additionally offer the role interview in the same approval. */
const setupOptions = (options: readonly string[] | undefined): boolean =>
	same(options, [APPROVE, CANCEL]) || same(options, [APPROVE, "역할별로 고르기", CANCEL]);
const reports = (frames: readonly Frame[]): string[] => frames.filter(frame => customMessage(frame) === "storm-report").map(frame => JSON.stringify(frame));

async function session(answer: Answer, exercise: (rpc: Rpc) => Promise<void>): Promise<void> {
	const rpc = new Rpc(env, answer, { model: main });
	try {
		await rpc.ready();
		await exercise(rpc);
	} finally {
		const code = await rpc.close();
		suite.check("OMP exits cleanly", code === 0, `exit=${code}`);
	}
}

/** This repo's approval store; every scenario after the first approval has one. */
function store(): string {
	const dir = files.storeDir();
	if (dir === undefined) throw new Error("Storm approval did not create a store");
	return dir;
}

/** The durable choice through the storage API, not through whether the guard happens to be on. */
async function choice(): Promise<string> {
	const dir = files.storeDir();
	return dir === undefined ? "unset" : readAutoDelegationChoice(dir);
}

/** Polls until the explicit choice is stored; the setup command writes its own state before it returns. */
async function waitChoice(expected: string, timeoutMs = 10_000): Promise<void> {
	const dir = store();
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await readAutoDelegationChoice(dir)) === expected) return;
		if (Date.now() > deadline) throw new Error(`automatic-delegation choice is ${await readAutoDelegationChoice(dir)}, expected ${expected}`);
		await Bun.sleep(50);
	}
}

/** A pre-upgrade approved team: the real approval and config, with no personal choice file at all. */
async function withoutChoiceFile(): Promise<void> {
	rmSync(join(store(), CHOICE_FILE), { force: true });
	await waitChoice("unset");
}

/** Removes a file the scripted main session may or may not have written, so the next assertion starts clean. */
function resetFile(name: string): void {
	rmSync(join(env.project, name), { force: true });
}

writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
const server = await startFakeLlm(env);
try {
	linkPlugin(env);

	await suite.step("a new setup leaves stock tools alone until the team is approved", async () => {
		const direct = "direct-before-team.txt";
		await session(cancelAll, async rpc => {
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
			suite.check("declining stores no automatic-delegation choice", (await choice()) === "unset");

			resetFile(direct);
			await rpc.turn(scripted({ edit: "direct-declined-team.txt" }));
			suite.check("declining leaves stock edits available", existsSync(join(env.project, "direct-declined-team.txt")));
			resetFile("direct-declined-team.txt");
		});
	});

	await suite.step("the single default team approval turns automatic delegation on and fences ordinary prompts", async () => {
		const direct = "direct-after-team.txt";
		const llm = new LlmCursor(env);
		await session(choose(APPROVE), async rpc => {
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
			await waitChoice("on");

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
		await session(cancelAll, async rpc => {
			rpc.answer = choose(AUTO.off);
			await rpc.prompt("/storm auto");
			suite.check("the explicit switch offers turning it off", same(rpc.dialogs.at(-1)?.options, [AUTO.off, CANCEL]), JSON.stringify(rpc.dialogs.at(-1)));
			await waitChoice("off");
			await rpc.turn(scripted({ edit: "direct-after-off.txt" }));
			suite.check("turning it off restores stock edits in the same session", existsSync(join(env.project, "direct-after-off.txt")));
			suite.check("no run was opened", files.runIds().size === 0);
			resetFile("direct-after-off.txt");
		});
		await session(cancelAll, async rpc => {
			await rpc.turn(scripted({ edit: "direct-off-next-session.txt" }));
			suite.check("off is durable across OMP processes", existsSync(join(env.project, "direct-off-next-session.txt")));
			resetFile("direct-off-next-session.txt");
		});

		// A never-approved value: the recommendation carries it, the file is unapproved, and the hash cannot match an
		// earlier approval. Toggling a field can coincide with an old approval and make /storm setup report "unchanged".
		files.editConfig(config => {
			config.parallelism = 3;
		});
		const approvals = files.approvals().length;
		await session(choose(APPROVE), async rpc => {
			await rpc.prompt("/storm setup");
			suite.check(
				"re-setup approves once without asking the automatic-delegation question",
				files.approvals().length === approvals + 1 &&
					rpc.dialogs.length === 1 &&
					rpc.dialogs.every(dialog => !dialog.title.includes(OLD_PROMPT) && !dialog.options.includes(AUTO.on)),
				JSON.stringify(rpc.dialogs),
			);
			await waitChoice("off");
			await rpc.turn(scripted({ edit: "direct-after-resetup.txt" }));
			suite.check("a chosen off survives /storm setup and leaves stock edits available", existsSync(join(env.project, "direct-after-resetup.txt")));
			resetFile("direct-after-resetup.txt");
		});

		await session(cancelAll, async rpc => {
			rpc.answer = choose(AUTO.on);
			await rpc.prompt("/storm auto");
			suite.check("the explicit switch offers turning it on", same(rpc.dialogs.at(-1)?.options, [AUTO.on, CANCEL]), JSON.stringify(rpc.dialogs.at(-1)));
			await waitChoice("on");
			await rpc.turn(scripted({ edit: "direct-after-reenable.txt" }));
			suite.check("turning it on fences ordinary prompts again", !existsSync(join(env.project, "direct-after-reenable.txt")));
			resetFile("direct-after-reenable.txt");
		});
	});

	await suite.step("auto consent permits conversation but fences direct work before and after a run", async () => {
		await session(cancelAll, async rpc => {
			const before = files.runIds();
			const chat = new LlmCursor(env);
			await rpc.turn("Hello. No repository task.");
			suite.check("conversation has one main request and no run, classifier or worker", chat.of("main").length === 1 && chat.of("route").length === 0 && chat.of("child").length === 0 && files.runIds().size === before.size);

			await rpc.turn(scripted({ edit: "direct-before.txt" }, { bash: "printf nope > direct-shell.txt" }));
			suite.check("the director cannot write through either the file tool or shell", !existsSync(join(env.project, "direct-before.txt")) && !existsSync(join(env.project, "direct-shell.txt")));
			suite.check("refused direct work does not open a run", files.runIds().size === before.size);

			const dispatch = new LlmCursor(env);
			const prompt = scripted(plan, probe);
			const receivedAt = Date.now();
			const frames = await rpc.turn(prompt);
			const run = await files.finishedRun(before, 20_000);
			suite.check("first plan opens one run and dispatches one approved worker", run.request === prompt && run.plan?.lanes[0]?.name === "Probe0" && run.spawns.filter(spawn => spawn.outcome !== "blocked").length === 1 && dispatch.of("child").length > 0);
			suite.check("routing used the original user turn, not a classifier or a duplicated handoff", dispatch.of("route").length === 0 && dispatch.of("main").some(entry => entry.lastUser.includes(prompt)) && dispatch.of("main").every(entry => !entry.lastUser.includes("<storm-run id=")));
			suite.check("ordinary read run has no verbose transcript report", frames.every(frame => customMessage(frame) !== "storm-report"));
			const child = dispatch.of("child")[0];
			if (child) console.log(`     scripted auto: first worker ${Math.max(0, child.ts - receivedAt)}ms · main requests ${dispatch.of("main").length} · compactions ${dispatch.of("compaction").length}`);

			await rpc.turn(scripted({ edit: "direct-after.txt" }));
			suite.check("the supervisor boundary survives the end of the run", !existsSync(join(env.project, "direct-after.txt")));
		});
	});

	await suite.step("two OMP processes cannot own the same working tree", async () => {
		const owner = new Rpc(env, cancelAll, { model: main });
		const before = files.runIds();
		let stopped = false;
		try {
			await owner.ready();
			await owner.prompt(scripted(plan, { ...probe, say: "E2E-CHILD-HOLD" }));
			const live = await until(() => files.runs().find(run => !before.has(run.runId) && run.status === "running"), 10_000, "first process owns the run");
			await session(cancelAll, async contender => {
				const start = new LlmCursor(env);
				await contender.turn(scripted(plan, probe));
				suite.check("the contender did not start a second run or dispatch another child", files.runIds().size === before.size + 1 && start.of("child").length === 0 && files.run(live.runId)?.status === "running");
			});
			await owner.stop();
			stopped = true;
			const surviving = files.runIds();
			await session(cancelAll, async contender => {
				await contender.turn(scripted(plan, probe));
				const next = await files.finishedRun(surviving, 20_000);
				suite.check("after confirmed owner death another process can start", next.runId !== live.runId && next.spawns.some(spawn => spawn.outcome !== "blocked"));
			});
		} finally {
			if (!stopped) await owner.stop();
		}
	});

	await suite.step("a reviewer cannot replace a configured real check", async () => {
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
				await session(choose(APPROVE), async rpc => {
					await rpc.prompt("/storm");
					const before = files.runIds();
					const steps: Step[] = [
						{ storm: { action: "plan", plan: { lanes: [{ name: "Impl0", kind: "code" }, { name: "Review0", kind: "review" }] } } },
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

	await suite.step("stale approval blocks new work, not the supervisor boundary", async () => {
		// Never approved before: the team is stale even though older approval records still exist.
		files.editConfig(config => { config.parallelism = 7; });
		await session(cancelAll, async rpc => {
			const start = files.runIds();
			const dispatch = new LlmCursor(env);
			await rpc.turn(scripted({ storm: plan.storm }, probe, { edit: "direct-when-blocked.txt" }));
			suite.check("unapproved work cannot start a worker or bypass delegation", files.runIds().size === start.size && dispatch.of("child").length === 0 && !existsSync(join(env.project, "direct-when-blocked.txt")));
		});
	});

	await suite.step("a pre-upgrade approved team stays unfenced until the user keeps direct work", async () => {
		const approvals = files.approvals().length;
		await session(choose(APPROVE), async rpc => {
			await rpc.prompt("/storm");
			suite.check("the team left unapproved is approved again", files.approvals().length === approvals + 1);
		});
		await withoutChoiceFile();

		await session(cancelAll, async rpc => {
			suite.check("plugin load asks nothing about the legacy consent", rpc.dialogs.length === 0, JSON.stringify(rpc.dialogs));
			await rpc.turn(scripted({ edit: "legacy-load-direct.txt" }));
			suite.check("plugin load leaves stock edits alone", existsSync(join(env.project, "legacy-load-direct.txt")));
			resetFile("legacy-load-direct.txt");

			const frames = await rpc.prompt("/storm status");
			suite.check("/storm status reports without a dialog", rpc.dialogs.length === 0 && reports(frames).length === 1, `dialogs=${rpc.dialogs.length} reports=${reports(frames).length}`);
			suite.check("the status report keeps the Storm state in plain text", reports(frames).some(report => report.includes("≋ STORM · 대기") && !report.includes("\\u001b")));
			const afterStatus = await rpc.turn(scripted({ read: TRACKED_FILE }, { edit: "legacy-after-status.txt" }));
			suite.check(
				"/storm status leaves stock reads and writes unfenced",
				afterStatus.some(frame => frame.type === "tool_execution_end" && frame.toolName === "read" && frame.isError !== true) && existsSync(join(env.project, "legacy-after-status.txt")),
			);
			resetFile("legacy-after-status.txt");

			await rpc.prompt("/storm");
			const first = rpc.dialogs.at(-1)?.options ?? [];
			suite.check("the hub offers converting to automatic delegation or keeping direct work", first.includes(MIGRATE.convert) && first.includes(MIGRATE.direct), JSON.stringify(first));
			suite.check("a cancelled hub leaves the choice unset", (await choice()) === "unset");

			await rpc.prompt("/storm");
			const second = rpc.dialogs.at(-1)?.options ?? [];
			suite.check("the two choices stay offered until the user explicitly chooses", second.includes(MIGRATE.convert) && second.includes(MIGRATE.direct), JSON.stringify(second));
			suite.check("a second cancelled hub still leaves the choice unset", (await choice()) === "unset");

			rpc.answer = choose(MIGRATE.direct);
			await rpc.prompt("/storm");
			await waitChoice("off");
			await rpc.prompt("/storm");
			const settled = rpc.dialogs.at(-1)?.options ?? [];
			suite.check("the stored off removes the one-time migration offer", !settled.includes(MIGRATE.convert) && !settled.includes(MIGRATE.direct), JSON.stringify(settled));
			await rpc.turn(scripted({ edit: "legacy-keep-direct.txt" }));
			suite.check("keeping direct work is stored as an explicit off and leaves stock edits alone", existsSync(join(env.project, "legacy-keep-direct.txt")));
			resetFile("legacy-keep-direct.txt");
		});

		await session(cancelAll, async rpc => {
			await rpc.turn(scripted({ edit: "legacy-keep-direct-next.txt" }));
			suite.check("keeping direct work stays off in another OMP process", existsSync(join(env.project, "legacy-keep-direct-next.txt")));
			resetFile("legacy-keep-direct-next.txt");
		});

		// A value approved nowhere in this fixture, so the changed file is unapproved and /storm setup must really
		// re-approve it; a previously approved value would be reported as "unchanged" and test nothing.
		files.editConfig(config => {
			config.parallelism = 5;
		});
		const later = files.approvals().length;
		await session(choose(APPROVE), async rpc => {
			await rpc.prompt("/storm setup");
			suite.check(
				"re-setup approves the changed team without asking about automatic delegation",
				files.approvals().length === later + 1 &&
					rpc.dialogs.length === 1 &&
					rpc.dialogs.every(dialog => !dialog.title.includes(OLD_PROMPT) && !dialog.options.includes(AUTO.on)),
				JSON.stringify(rpc.dialogs),
			);
			suite.check("the explicit off survives /storm setup", (await choice()) === "off");
			await rpc.turn(scripted({ edit: "legacy-after-setup.txt" }));
			suite.check("stock edits stay available after that setup", existsSync(join(env.project, "legacy-after-setup.txt")));
			resetFile("legacy-after-setup.txt");
		});
	});

	await suite.step("a separate legacy fixture converts to automatic delegation through the hub", async () => {
		await withoutChoiceFile();
		const llm = new LlmCursor(env);
		await session(cancelAll, async rpc => {
			await rpc.turn(scripted({ edit: "legacy-convert-load.txt" }));
			suite.check("the second legacy fixture is unfenced on load", existsSync(join(env.project, "legacy-convert-load.txt")));
			resetFile("legacy-convert-load.txt");

			rpc.answer = choose(MIGRATE.convert);
			await rpc.prompt("/storm");
			suite.check("the hub offers conversion to automatic delegation", (rpc.dialogs.at(-1)?.options ?? []).includes(MIGRATE.convert), JSON.stringify(rpc.dialogs.at(-1)));
			await waitChoice("on");
			await rpc.turn(scripted({ edit: "legacy-converted.txt" }));
			suite.check("converting fences ordinary repository writes", !existsSync(join(env.project, "legacy-converted.txt")));
			suite.check("the refused call says automatic delegation owns repository work", llm.of("main").some(entry => entry.lastTool.includes("자동 위임")));
			resetFile("legacy-converted.txt");
		});

		await session(cancelAll, async rpc => {
			await rpc.turn(scripted({ edit: "legacy-converted-next.txt" }));
			suite.check("the migrated on choice persists across OMP processes", !existsSync(join(env.project, "legacy-converted-next.txt")));
			resetFile("legacy-converted-next.txt");
		});
	});
} finally {
	server.kill();
	await server.exited;
}
process.exitCode = suite.finish();
