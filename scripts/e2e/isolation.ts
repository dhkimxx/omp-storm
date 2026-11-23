#!/usr/bin/env bun
/**
 * Selective lane isolation E2E, real host: a disposable git checkout, an isolated HOME/profile, the pinned omp and the
 * local fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * What it proves:
 * - the host's native task isolation is available here and really places a child in another checkout (`task.isolation.apply false`);
 * - an ordinary lane shares the parent checkout and sees its dirty edit, while one plan's reason-marked lane runs in a
 *   different checkout and its file never lands in the parent before the user selects it;
 * - the isolated worker settles into the parent run ledger, the run ends successfully instead of no-progress, and the
 *   native result is a recoverable patch/directory artifact outside the parent at completion and afterwards;
 * - the same mixed placement and successful settlement hold when automatic delegation opens the plan from the prompt;
 * - with `task.isolation.enabled=false` or the host's default `task.isolation.apply=true`, a reason-marked lane is
 *   refused with an actionable Korean reason and no experiment child runs (never silently shared or auto-applied);
 * - a final review lane cannot be reason-marked (it must see the integrated tree).
 *
 * Usage:
 *   E2E_ONLY="dirty parent" ./node_modules/.bin/bun scripts/e2e/isolation.ts   # shared + experiment lane contract
 *   E2E_ONLY="selective isolation" ./node_modules/.bin/bun scripts/e2e/isolation.ts   # all three lane scenarios
 *   ./node_modules/.bin/bun scripts/e2e/isolation.ts                            # every scenario in this file
 *
 * The fixture step always runs: E2E_ONLY only chooses scenarios after it. Env from harness.ts (E2E_WORK, E2E_PORT,
 * E2E_KEEP) applies. A green run deletes its temp work dir; a failure keeps it with frames, stderr and llm.jsonl.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import type { RunRecord } from "../../src/types.ts";
import {
	type Answer,
	cancelAll,
	choose,
	customMessage,
	type Frame,
	LlmCursor,
	linkPlugin,
	modelsYml,
	prepare,
	PROFILE_CONFIG,
	Rpc,
	type Step,
	StormFiles,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	TRACKED_FILE,
	TRACKED_TEXT,
	until,
} from "./harness.ts";

const LABEL = { autoOn: "자동 위임 켜기", autoOff: "자동 위임 끄기" } as const;
/** A one-line, user-facing reason: the plan response and status must show it with the lane name. */
const REASON = "독립 실험은 부모 작업 트리에 합치지 않고 따로 보존";
const MAIN = "fake/general-b";

const env = prepare("storm-e2e-isolation", 18557);
const suite = new Suite("E2E (selective isolation)", env);
const files = new StormFiles(env);
const check = suite.check.bind(suite);
const profileFile = join(env.agentDir, "config.yml");
const modelsFile = join(env.agentDir, "models.yml");
const exitCodes: number[] = [];

/** The host settings file of the temp profile: what a user would set through `omp config set`. */
function hostSettings(settings: { enabled: boolean; apply?: boolean }): void {
	const lines = [PROFILE_CONFIG.trimEnd(), "task:", "  isolation:", `    enabled: ${settings.enabled}`];
	if (settings.apply !== undefined) lines.push(`    apply: ${settings.apply}`);
	writeFileSync(profileFile, `${lines.join("\n")}\n`);
}

/** One omp RPC process: started, used and closed; its exit code is checked at the end. */
async function session<T>(answer: Answer, body: (rpc: Rpc) => Promise<T>): Promise<T> {
	const rpc = new Rpc(env, answer, { model: MAIN });
	try {
		await rpc.ready();
		return await body(rpc);
	} finally {
		exitCodes.push(await rpc.close());
	}
}

const startRun = (sequence: Step[]): string => `/storm E2E-ROUTE ${JSON.stringify({ action: "run" })} E2E-STEPS ${JSON.stringify(sequence)}`;
const plan = (lanes: unknown[], workers?: Record<string, number>): Step => ({ storm: { action: "plan", plan: { lanes, ...(workers ? { workers } : {}) } } });

/** The run record, the frames of the turn that started it, and where that turn began. */
async function runOf(rpc: Rpc, message: string): Promise<{ run: RunRecord; frames: Frame[]; from: number }> {
	const before = files.runIds();
	const from = rpc.frames.length;
	await rpc.prompt(message, 90_000);
	const run = await files.finishedRun(before);
	return { run, frames: rpc.frames.slice(from), from };
}

/** Waits for the durable automatic-delegation choice a slash command writes before it returns. */
async function waitAuto(expected: "on" | "off", timeoutMs = 10_000): Promise<void> {
	const dir = files.storeDir();
	if (dir === undefined) throw new Error("Storm approval did not create a store");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await readAutoDelegationChoice(dir)) === expected) return;
		if (Date.now() > deadline) throw new Error(`automatic-delegation choice is ${await readAutoDelegationChoice(dir)}, expected ${expected}`);
		await Bun.sleep(50);
	}
}

/**
 * The run's end report, once Storm writes it. The start notice also carries the run id, so selecting by id can return
 * that notice instead of the result; wait for the result heading itself.
 */
async function reportOf(rpc: Rpc, runId: string, from: number, timeoutMs = 20_000): Promise<string> {
	const text = await until(
		() => {
			const reports = rpc.frames
				.slice(from)
				.filter(frame => customMessage(frame) === "storm-report")
				.map(frame => JSON.stringify(frame))
				.join("\n");
			return reports.includes("### Storm 실행 결과") ? reports : undefined;
		},
		timeoutMs,
		`the end report of ${runId}`,
	).catch(() => "");
	return text;
}

/** A tool result's user-facing text, which is what a client shows (`result.content`). */
function resultText(frame: Frame): string {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
		.join("\n");
}
/** Every user-facing sentence of a turn: tool replies, async results, notices and Storm's transcript records. */
function said(frames: readonly Frame[]): string {
	return [
		...frames.filter(frame => frame.type === "tool_execution_end").map(resultText),
		...frames.filter(frame => customMessage(frame) === "async-result").map(frame => JSON.stringify(frame)),
		...frames.filter(frame => customMessage(frame) === "storm-report").map(frame => JSON.stringify(frame)),
		...frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "notify").map(frame => String(frame.message)),
	].join("\n");
}
const children = (llm: LlmCursor): string[] => [...new Set(llm.of("child").map(entry => entry.lastUser))];

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
/** A path as a POSIX single-quoted shell word. */
const shq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
/** `pwd -P` gives the physical path; temp roots can be symlinks. */
function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
/** Outside the parent checkout entirely, not merely a different path within it. */
function outsideProject(path: string): boolean {
	const project = real(env.project);
	const resolved = real(path);
	return resolved !== project && !resolved.startsWith(`${project}${sep}`);
}
function markerDir(name: string): string {
	const dir = join(env.work, "markers", name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}
function readMarker(dir: string, name: string): string {
	const path = join(dir, name);
	return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}
interface MixedLaneDirs {
	shared: string;
	experiment: string;
}
interface MixedLaneCommands {
	shared: string;
	experiment: string;
}
/**
 * The native output must be recoverable when Storm finishes, not a path to a transient checkout: a patch file has to
 * carry the experiment, and a retained directory has to hold the file. A stale/missing path fails.
 */
function artifactProof(path: string): { ok: boolean; evidence: string } {
	if (path === "" || !existsSync(path)) return { ok: false, evidence: "missing at run completion" };
	const info = statSync(path);
	if (info.isDirectory()) {
		const file = join(path, "experiment.txt");
		const content = existsSync(file) ? readFileSync(file, "utf8") : "";
		return { ok: content.includes("experiment change"), evidence: `directory ${path} file=${existsSync(file)}` };
	}
	if (!info.isFile()) return { ok: false, evidence: `not a file or directory: ${path}` };
	const content = readFileSync(path, "utf8");
	return {
		ok: content.includes("experiment.txt") && content.includes("experiment change"),
		evidence: `file ${path} bytes=${content.length} namesExperiment=${content.includes("experiment.txt")}`,
	};
}
/**
 * The one lane contract both the manual and automatic paths must satisfy: both native placements happen, the isolated
 * worker settles into the parent run ledger, the run ends with no integrated changes instead of no-progress, and the
 * native result names a retained artifact outside the parent.
 */
function checkMixedLaneRun(
	prefix: string,
	run: RunRecord,
	frames: readonly Frame[],
	llm: LlmCursor,
	dirs: MixedLaneDirs,
	commands: MixedLaneCommands,
	report: string,
	dirty: string,
): string {
	const isolatedLane = run.plan?.lanes.find(lane => lane.name === "experiment");
	check(`${prefix}: the validated plan persisted the exceptional lane's reason`, isolatedLane?.isolationReason === REASON, JSON.stringify(run.plan));
	const users = children(llm);
	check(
		`${prefix}: both scripted workers reached the provider`,
		users.some(user => user.includes(b64(commands.shared))) && users.some(user => user.includes(b64(commands.experiment))),
		`children=${users.length}`,
	);
	const sharedCwd = readMarker(dirs.shared, "cwd");
	const seen = readMarker(dirs.shared, "seen");
	// The experiment proof carries its own cwd; the shared lane writes only the cwd marker.
	const isolatedCwd = readMarker(dirs.experiment, "proof").split("|")[0] ?? "";
	check(`${prefix}: the ordinary lane ran in the parent checkout`, sharedCwd !== "" && real(sharedCwd) === real(env.project), `cwd=${sharedCwd} parent=${env.project}`);
	check(`${prefix}: the ordinary lane saw the parent's dirty edit`, seen.includes(dirty), seen.slice(0, 120));
	check(
		`${prefix}: the exceptional lane ran in a different native checkout outside the parent`,
		isolatedCwd !== "" && outsideProject(isolatedCwd),
		`experiment=${isolatedCwd || "(missing)"} shared=${sharedCwd} parent=${env.project}`,
	);
	check(`${prefix}: the exceptional lane's file existed there`, readMarker(dirs.experiment, "proof").includes("experiment change"), readMarker(dirs.experiment, "proof"));
	check(`${prefix}: the parent did not receive the experiment before selection`, !existsSync(join(env.project, "experiment.txt")), `exists=${existsSync(join(env.project, "experiment.txt"))}`);
	const quick = (run.agents ?? []).find(agent => agent.role === "quick" || agent.name === "storm-quick");
	check(
		`${prefix}: the isolated worker settled into the parent run ledger`,
		quick !== undefined && quick.state !== "running" && quick.requests > 0 && quick.lastWorkFailed !== true,
		JSON.stringify(run.agents ?? []),
	);
	check(
		`${prefix}: the run ended successfully after both workers settled, not no-progress`,
		run.status === "ended" || run.status === "done",
		`status=${run.status} endReason=${run.endReason} turns=${run.turns ?? "?"}`,
	);
	check(`${prefix}: the run report leaves no lane unfinished`, report !== "" && !report.includes("미완료 레인"), report.slice(-1200));
	const outputPath = /Isolation: changes captured at `([^`]+)`/.exec(said(frames))?.[1] ?? "";
	const artifact = artifactProof(outputPath);
	check(
		`${prefix}: the native output is a recoverable artifact outside the parent at run completion`,
		outputPath !== "" && outsideProject(outputPath) && artifact.ok,
		`path=${outputPath || "(missing)"} ${artifact.evidence}`,
	);
	const laneSpawns = run.spawns.filter(spawn => spawn.outcome === "routed" && spawn.lane !== undefined);
	check(
		`${prefix}: both approved spawns were bound to their planned lanes`,
		laneSpawns.some(spawn => spawn.lane === "shared-read") && laneSpawns.some(spawn => spawn.lane === "experiment"),
		JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.outcome, spawn.lane])),
	);
	return outputPath;
}

/** A shell command that records the child's real cwd and what it can see there. */
function probeCommand(dir: string, options: { experiment?: boolean } = {}): string {
	const cwdFile = join(dir, "cwd");
	const seenFile = join(dir, "seen");
	const proofFile = join(dir, "proof");
	const parts = [`pwd -P > ${shq(cwdFile)}`];
	if (options.experiment) {
		parts.push(
			`printf 'experiment change\\n' > experiment.txt`,
			`{ printf '%s|' "$(pwd -P)"; cat experiment.txt; } > ${shq(proofFile)}`,
		);
	} else {
		parts.push(`cat ${shq(TRACKED_FILE)} > ${shq(seenFile)}`);
	}
	return parts.join("; ");
}

async function main(): Promise<void> {
	writeFileSync(modelsFile, modelsYml(env.port, { fake: TEAM_PROVIDERS.fake }));
	writeFileSync(profileFile, PROFILE_CONFIG);
	linkPlugin(env);

	// The fixture always runs, so E2E_ONLY can pick one lane scenario without repeating setup.
	await suite.step(
		"fixture: approved shared team and host isolation settings",
		async () => {
			hostSettings({ enabled: true, apply: false });
			await session(cancelAll, async rpc => {
				await rpc.prompt("/storm");
				rpc.answer = choose(APPROVE);
				await rpc.prompt("/storm");
				check("the recommended team was approved", files.approvals().length === 1 && existsSync(files.configFile));
				const roles = Object.keys(files.config().roles).sort();
				check("the team has the roles the lanes need", ["explorer", "implementer", "quick", "reviewer"].every(role => roles.includes(role)), roles.join(","));
				// A manual run proves the plan/task path; four slots keep the two lanes concurrent.
				files.editConfig(config => {
					config.isolation = "shared";
					config.parallelism = 4;
				});
				await rpc.prompt("/storm");
				check("the hand-edited shared team is approved again", files.config().isolation === "shared" && files.config().parallelism === 4, JSON.stringify({ isolation: files.config().isolation, parallelism: files.config().parallelism }));
				rpc.answer = choose(LABEL.autoOff);
				await rpc.prompt("/storm auto");
				await waitAuto("off");
				const store = files.storeDir();
				check("automatic delegation is off for the manual plan/task path", store !== undefined && (await readAutoDelegationChoice(store)) === "off", store === undefined ? "no store" : await readAutoDelegationChoice(store));
			});
		},
		120_000,
		{ always: true },
	);

	await suite.step("host native isolation places a plain task child outside the project", async () => {
		const dir = markerDir("host-baseline");
		const command = probeCommand(dir, { experiment: true });
		await session(cancelAll, async rpc => {
			const llm = new LlmCursor(env);
			await rpc.turn(`E2E-STEPS ${JSON.stringify([{ task: ["task"], as: "HostIso", isolated: [true], say: `E2E-CHILD-SH ${b64(command)}` }])}`, 90_000);
			// The turn can settle before its background child finishes; the marker is the physical proof.
			const appeared = await until(() => (readMarker(dir, "cwd") === "" ? undefined : true), 30_000, "the isolated child's cwd marker").catch(() => false);
			const cwd = readMarker(dir, "cwd");
			const proof = readMarker(dir, "proof");
			check(
				"the host ran the isolated child and it recorded its cwd",
				appeared && cwd !== "" && proof !== "",
				`cwd=${cwd} proof=${proof} said=${said(rpc.frames).slice(-1200)}`,
			);
			check("the host isolated checkout differs from the parent", cwd !== "" && real(cwd) !== real(env.project), `child=${cwd} parent=${env.project}`);
			check("the isolated file stayed out of the parent", !existsSync(join(env.project, "experiment.txt")), `tools=${children(llm).length} said=${said(rpc.frames).slice(-1200)}`);
		});
	});

	await suite.step("selective isolation: shared lane sees the dirty parent, experiment lane stays apart", async () => {
		// Each child records into its own directory: two concurrent children must not overwrite each other's cwd proof.
		const sharedDir = markerDir("selective-shared");
		const experimentDir = markerDir("selective-experiment");
		const sharedCommand = probeCommand(sharedDir);
		const experimentCommand = probeCommand(experimentDir, { experiment: true });
		const tracked = join(env.project, TRACKED_FILE);
		writeFileSync(tracked, `${TRACKED_TEXT}E2E-PARENT-DIRTY\n`);
		try {
			await session(cancelAll, async rpc => {
				const llm = new LlmCursor(env);
				const request = startRun([
					plan(
						[
							{ name: "shared-read", kind: "code", role: "implementer", goal: "Read the parent checkout" },
							{ name: "experiment", kind: "run", role: "quick", files: ["experiment.txt"], goal: "Keep an independent experiment", isolationReason: REASON },
						],
						{ implementer: 1, quick: 1 },
					),
					{ task: ["storm-implementer"], as: "Shared", say: `E2E-CHILD-SH ${b64(sharedCommand)}` },
					{ task: ["storm-quick"], as: "Experiment", say: `E2E-CHILD-SH ${b64(experimentCommand)}` },
				]);
				const { run, frames, from } = await runOf(rpc, request);
				const report = await reportOf(rpc, run.runId, from);
				const artifactPath = checkMixedLaneRun(
					"manual mixed lanes",
					run,
					frames,
					llm,
					{ shared: sharedDir, experiment: experimentDir },
					{ shared: sharedCommand, experiment: experimentCommand },
					report,
					"E2E-PARENT-DIRTY",
				);
				// Git may keep an empty .git/worktrees after host cleanup; count registered checkouts instead.
				const listing = Bun.spawnSync(["git", "-C", env.project, "worktree", "list", "--porcelain", "-z"]);
				const roots = listing.stdout.toString().split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice("worktree ".length));
				check(
					"manual mixed lanes: only the original checkout remains registered",
					listing.exitCode === 0 && roots.length === 1 && real(roots[0]!) === real(env.project),
					JSON.stringify({ roots, stderr: listing.stderr.toString() }),
				);
				const planText = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm").map(resultText).join("\n");
				check("manual mixed lanes: the plan response names the exceptional lane and its reason", planText.includes("experiment") && planText.includes(REASON), planText.slice(0, 600));
				const statusFrom = rpc.frames.length;
				await rpc.prompt("/storm status", 60_000);
				const status = rpc.frames
					.slice(statusFrom)
					.filter(frame => customMessage(frame) === "storm-report")
					.map(frame => JSON.stringify(frame))
					.join("\n");
				check("manual mixed lanes: the status surface names the exceptional lane and its reason", status.includes("experiment") && status.includes(REASON), status.slice(0, 1200));
				const laterArtifact = artifactProof(artifactPath);
				check("manual mixed lanes: the artifact is still recoverable after the status surface", laterArtifact.ok, laterArtifact.evidence);
			});
		} finally {
			writeFileSync(tracked, TRACKED_TEXT);
			rmSync(join(env.project, "experiment.txt"), { force: true });
		}
	});

	await suite.step("selective isolation: automatic delegation keeps mixed lane placement native", async () => {
		hostSettings({ enabled: true, apply: false });
		const sharedDir = markerDir("auto-shared");
		const experimentDir = markerDir("auto-experiment");
		const sharedCommand = probeCommand(sharedDir);
		const experimentCommand = probeCommand(experimentDir, { experiment: true });
		const tracked = join(env.project, TRACKED_FILE);
		writeFileSync(tracked, `${TRACKED_TEXT}E2E-AUTO-PARENT-DIRTY\n`);
		try {
			await session(cancelAll, async rpc => {
				rpc.answer = choose(LABEL.autoOn);
				await rpc.prompt("/storm auto");
				await waitAuto("on");
				const llm = new LlmCursor(env);
				const before = files.runIds();
				const from = rpc.frames.length;
				const prompt = `E2E-STEPS ${JSON.stringify([
					plan(
						[
							{ name: "shared-read", kind: "code", role: "implementer", goal: "Read the parent checkout" },
							{ name: "experiment", kind: "run", role: "quick", files: ["experiment.txt"], goal: "Keep an independent experiment", isolationReason: REASON },
						],
						{ implementer: 1, quick: 1 },
					),
					{ task: ["storm-implementer"], as: "AutoShared", say: `E2E-CHILD-SH ${b64(sharedCommand)}` },
					{ task: ["storm-quick"], as: "AutoExperiment", say: `E2E-CHILD-SH ${b64(experimentCommand)}` },
				])}`;
				await rpc.turn(prompt, 90_000);
				const run = await files.finishedRun(before);
				const frames = rpc.frames.slice(from);
				const report = await reportOf(rpc, run.runId, from);
				check(
					"auto mixed lanes: the user prompt itself opened the run without a router turn",
					run.request === prompt && llm.of("route").length === 0,
					`request=${(run.request ?? "").slice(0, 80)} route=${llm.of("route").length}`,
				);
				checkMixedLaneRun(
					"auto mixed lanes",
					run,
					frames,
					llm,
					{ shared: sharedDir, experiment: experimentDir },
					{ shared: sharedCommand, experiment: experimentCommand },
					report,
					"E2E-AUTO-PARENT-DIRTY",
				);
				const planText = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm").map(resultText).join("\n");
				check("auto mixed lanes: the plan response names the exceptional lane and its reason", planText.includes("experiment") && planText.includes(REASON), planText.slice(0, 600));
				rpc.answer = choose(LABEL.autoOff);
				await rpc.prompt("/storm auto");
				await waitAuto("off");
			});
		} finally {
			writeFileSync(tracked, TRACKED_TEXT);
			rmSync(join(env.project, "experiment.txt"), { force: true });
		}
	});

	await suite.step("selective isolation: disabled host isolation blocks instead of sharing", async () => {
		hostSettings({ enabled: false, apply: false });
		const dir = markerDir("disabled");
		const command = probeCommand(dir, { experiment: true });
		await session(cancelAll, async rpc => {
			const llm = new LlmCursor(env);
			const { run, frames } = await runOf(
				rpc,
				startRun([
					plan([{ name: "experiment", kind: "run", role: "quick", files: ["experiment.txt"], goal: "Keep an independent experiment", isolationReason: REASON }]),
					{ task: ["storm-quick"], as: "Experiment", say: `E2E-CHILD-SH ${b64(command)}` },
				]),
			);
			const text = said(frames);
			check("no experiment child ran while host isolation was disabled", children(llm).length === 0 && readMarker(dir, "cwd") === "", `children=${children(llm).length} cwd=${readMarker(dir, "cwd")}`);
			check("the parent did not receive the experiment", !existsSync(join(env.project, "experiment.txt")));
			check(
				"the refusal is truthful and names the host setting to enable",
				text.includes("task.isolation.enabled") && text.includes("omp config set task.isolation.enabled true"),
				text.slice(-2000),
			);
			check("the run still ended", run.endedAt !== undefined, JSON.stringify({ status: run.status, endReason: run.endReason }));
		});
	});

	await suite.step("selective isolation: host default auto-apply blocks instead of landing", async () => {
		// No `apply` key: the host default is true, so an isolated result would be applied to the parent.
		hostSettings({ enabled: true });
		const dir = markerDir("apply");
		const command = probeCommand(dir, { experiment: true });
		await session(cancelAll, async rpc => {
			const llm = new LlmCursor(env);
			const { run, frames } = await runOf(
				rpc,
				startRun([
					plan([{ name: "experiment", kind: "run", role: "quick", files: ["experiment.txt"], goal: "Keep an independent experiment", isolationReason: REASON }]),
					{ task: ["storm-quick"], as: "Experiment", say: `E2E-CHILD-SH ${b64(command)}` },
				]),
			);
			const text = said(frames);
			check("no experiment child ran with auto-apply on", children(llm).length === 0 && readMarker(dir, "cwd") === "", `children=${children(llm).length} cwd=${readMarker(dir, "cwd")}`);
			check("auto-apply did not land the experiment in the parent", !existsSync(join(env.project, "experiment.txt")));
			check(
				"the refusal is truthful and names the apply setting plus the command",
				text.includes("task.isolation.apply") && text.includes("omp config set task.isolation.apply false"),
				text.slice(-2000),
			);
			check("the run still ended", run.endedAt !== undefined, JSON.stringify({ status: run.status, endReason: run.endReason }));
		});
	});

	await suite.step("plan contract: a final review lane cannot be reason-marked", async () => {
		hostSettings({ enabled: true, apply: false });
		await session(cancelAll, async rpc => {
			const frames = await rpc.turn(
				`E2E-TOOL ${JSON.stringify({
					action: "plan",
					plan: { lanes: [{ name: "isolated-review", kind: "review", role: "reviewer", isolationReason: REASON }] },
				})}`,
			);
			const outcomes = frames
				.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm")
				.map(frame => frame.result?.details?.outcome);
			const text = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm").map(resultText).join("\n");
			check("the validator rejects an isolated final review", outcomes.includes("rejected") && text.includes("최종 리뷰"), JSON.stringify({ outcomes, text: text.slice(0, 800) }));
			check("no plan was left applied by the rejected review plan", files.runs().every(run => run.plan === undefined || !run.plan.lanes.some(lane => lane.name === "isolated-review")), JSON.stringify(files.runs().map(run => run.status)));
		});
	});

	await suite.step("omp exit codes", async () => {
		check("every omp session exited 0", exitCodes.length > 0 && exitCodes.every(code => code === 0), `exit=${exitCodes.join(",")}`);
	});
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
