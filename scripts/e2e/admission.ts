#!/usr/bin/env bun
/**
 * Task admission E2E, real host: a disposable git checkout, an isolated HOME/profile, the pinned omp and the local
 * fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * This file is the T02/T03 baseline and the contract the implementation pass must satisfy with the same script:
 *
 * - T02: an independent experiment's retained patch is the only result a comparison lane may consume; a build that
 *   needs the integrated tree waits until it is integrated. A later authorized shared worker applies the retained
 *   patch in the disposable parent, and the integrated consumer must then read its exact content. A producer that
 *   settled without its required result, or whose attempt failed, starts no consumer. Eight read-only fillers (seven
 *   explorers, an architect) force the experiment onto an omp subagent worker thread; the observation
 *   is the host's own worker-tagged log record, not a logical child label.
 * - T03: a native batch whose item overlaps an in-flight shared write is refused before any item is reserved or
 *   started; after the writer settles the valid independent item is submitted again and must start. A work-bearing
 *   `write agent://<id>` follow-up waits. A native `?progress` note does not: it wakes the idle holder into a turn whose
 *   write authority ended with its last turn (it can read and report only), so it meets no write order.
 *   Independent isolated experiments and independent read lanes run in parallel; a plan lane's progress note neither
 *   reserves a write nor starts work.
 *
 * `E2E_CONTRACT=1` submits the shared planned `results`/`dependsOn` wire from contract-fixture.ts and asserts it is
 * kept. The default baseline mode drops only those planned fields for the original pre-contract binary; the current
 * fresh-plan boundary refuses a deliverable lane without results, so use contract mode for candidate acceptance.
 * Every assertion observes native task admission, lifecycle or physical output, never the model's text. A baseline run
 * is expected to fail the gating checks; the failures are the T02/T03 reproduction. A passing baseline would mean the
 * expectations are not the new contract.
 *
 * Usage:
 *   E2E_PORT=18782 E2E_WORK=/tmp/storm-e2e-admission ./node_modules/.bin/bun scripts/e2e/admission.ts
 *   E2E_ONLY="T02" ...   # one scenario group; the fixture always runs
 *
 * Env from harness.ts (E2E_WORK, E2E_PORT, E2E_KEEP) applies. A green run deletes its temp work dir; a failure keeps
 * it with frames, stderr, omp logs and llm.jsonl.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import type { RunRecord } from "../../src/types.ts";
import { contractPlan, type ContractLane, requiredResult } from "./contract-fixture.ts";
import {
	type Answer,
	cancelAll,
	choose,
	type Frame,
	type LlmEntry,
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
	closeoutOf,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const LABEL = { autoOn: "자동 위임 켜기", autoOff: "자동 위임 끄기" } as const;
const MAIN = "fake/general-b";
const REASON = "독립 실험 결과는 부모 작업 트리 밖 패치로 보존";
/** `E2E_CONTRACT=1` submits the shared planned wire and asserts the post-S1/S2 contract, as in acceptance.ts. */
const CONTRACT = process.env.E2E_CONTRACT === "1";
const MODE = CONTRACT ? "contract" : "baseline";

const env = prepare("storm-e2e-admission", 18782);
seedFact(env.project);
const suite = new Suite(`E2E (task admission, ${MODE})`, env);
const check = suite.check.bind(suite);
/** The one native session this file drives; every case resumes its approved team. */
let owned: { id: string; dir: string } | undefined;
const profileFile = join(env.agentDir, "config.yml");
const modelsFile = join(env.agentDir, "models.yml");
const exitCodes: number[] = [];
/** `task.agentIdleTtlMs` of the temp profile; see `hostSettings`. */
const IDLE_TTL_MS = 1_000;
/** The host's task-isolation sandboxes of the temp profile; each one an owned isolated run left. */
const isolationRoot = join(dirname(env.agentDir), "wt");

/** The host settings file of the temp profile: what a user would set through `omp config set`. */
function hostSettings(isolation: { enabled: boolean; apply?: boolean } = { enabled: true, apply: false }): void {
	const lines = [
		PROFILE_CONFIG.trimEnd(),
		"task:",
		"  workerThreads: 4",
		// The native subagent ceiling this fixture needs: eight independent reads plus the experiment.
		"  maxConcurrency: 12",
		// The host parks an idle subagent after this TTL (default 7 min). A kept-alive subagent still homed on a
		// worker thread when stdin closes is released through a cross-thread dispose the host does not keep its
		// event loop alive for (seen on OMP 19.0.1 and 19.1.1; this suite is green on 19.2.1 with the park in place, the
		// failure itself was not measured there): the loop drains, `omp launch` exits 1 and the isolated
		// worktree it owns is never released. Parked while the client is still connected, its EOF release only
		// runs the main-thread isolation capture and cleanup. `closeSession` waits for that park.
		`  agentIdleTtlMs: ${IDLE_TTL_MS}`,
		"  isolation:",
		`    enabled: ${isolation.enabled}`,
	];
	if (isolation.apply !== undefined) lines.push(`    apply: ${isolation.apply}`);
	writeFileSync(profileFile, `${lines.join("\n")}\n`);
}

/** One omp RPC process: started, used and closed; its exit code is checked at the end. */
async function session<T>(answer: Answer, body: (rpc: Rpc, files: StormFiles) => Promise<T>): Promise<T> {
	const rpc = new Rpc(env, answer, { model: MAIN, ...(owned === undefined ? {} : { resume: owned.id, sessionDir: owned.dir }) });
	try {
		await rpc.ready();
		return await body(rpc, new StormFiles(env, rpc.sessionId));
	} finally {
		exitCodes.push(await closeSession(rpc));
		if (owned === undefined) owned = { id: rpc.sessionId, dir: rpc.sessionDir };
	}
}

/**
 * Closes the client once the host has parked every subagent session it homed on a worker thread (see
 * `hostSettings`). A park that never comes only skips the wait: the exit code and the sandbox check still judge it.
 */
async function closeSession(rpc: Rpc): Promise<number> {
	const open = (): string[] => {
		const records = logRecords().filter(record => record.pid === rpc.pid);
		const exited = new Set(records.filter(record => record.message === "Session exit recorded").map(record => record.sessionId));
		const homed = records.filter(record => typeof record.thread === "string" && /^w\d+$/.test(record.thread) && typeof record.sessionId === "string");
		return [...new Set(homed.map(record => String(record.sessionId)))].filter(id => !exited.has(id));
	};
	await until(() => (open().length === 0 ? true : undefined), IDLE_TTL_MS + 15_000, "the host to park its worker-homed subagents").catch(() => {
		console.log(`worker-homed subagent sessions still open at close: ${open().join(",")}`);
	});
	return rpc.close();
}

const startRun = (sequence: Step[]): string => `/storm E2E-ROUTE ${JSON.stringify({ action: "run" })} E2E-STEPS ${JSON.stringify(sequence)}`;
const planFor = (lanes: readonly ContractLane[], workers?: Record<string, number>): Step =>
	contractPlan(lanes, { contract: CONTRACT, ...(workers !== undefined ? { workers } : {}) });

/**
 * A real read-only answer obligation: the child reads this typed line and cites it, so the result is not a fake pass.
 * The claim restates the line's signed typed value, which the official answer evidence accepts without a reviewer.
 */
const TRACKED_CLAIM = FACT_CLAIM;
const trackedAnswer = (id: string) =>
	requiredResult(id, "answer", `report what ${FACT_FILE} line 1 says`, { path: FACT_FILE, contains: FACT_LINE });

/** Waits for the durable automatic-delegation choice a slash command writes before it returns. */
async function waitAuto(files: StormFiles, expected: "on" | "off", timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const choice = await readAutoDelegationChoice(files.sessionDir);
		if (choice === expected) return;
		if (Date.now() > deadline) throw new Error(`automatic-delegation choice is ${choice}, expected ${expected}`);
		await Bun.sleep(50);
	}
}

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

/** A tool result's user-facing text, which is what a client shows (`result.content`). */
function resultText(frame: Frame): string {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
}
const childRequests = (llm: LlmCursor, marker: string): LlmEntry[] => llm.of("child").filter(entry => entry.lastUser.includes(marker));

/** omp delivers a finished background task as a custom `async-result` user message on the parent's `agent_end`. */
function asyncResults(frames: readonly Frame[]): string[] {
	const out: string[] = [];
	for (const frame of frames) {
		const messages = frame.messages;
		if (frame.type !== "agent_end" || !Array.isArray(messages)) continue;
		for (const message of messages) {
			if (message && typeof message === "object" && "customType" in message && message.customType === "async-result" && "content" in message) {
				out.push(String(message.content));
			}
		}
	}
	return out;
}

/** The host's retained artifact paths for isolated children, from the native task results. */
function patchPaths(frames: readonly Frame[]): string[] {
	const out: string[] = [];
	for (const text of asyncResults(frames)) {
		for (const match of text.matchAll(/Isolation: changes captured at `([^`]+)`/g)) if (match[1] !== undefined) out.push(match[1]);
	}
	return out;
}

/**
 * `args` of every `task` tool call, as the model sent it (manual names are not rewritten). Both the assistant message
 * and the execution-start frame count: an admission refusal can end the call before a start frame exists.
 */
function taskCalls(frames: readonly Frame[]): object[] {
	const out: object[] = [];
	for (const frame of frames) {
		if (frame.type === "tool_execution_start" && frame.toolName === "task" && frame.args !== null && typeof frame.args === "object") {
			out.push(frame.args);
			continue;
		}
		const message = frame.type === "message_end" ? frame.message : undefined;
		if (message === null || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (
				part !== null &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "toolCall" &&
				"name" in part &&
				part.name === "task" &&
				"arguments" in part &&
				part.arguments !== null &&
				typeof part.arguments === "object"
			) {
				out.push(part.arguments);
			}
		}
	}
	return out;
}
function taskNames(args: object): string[] {
	if ("tasks" in args && Array.isArray(args.tasks)) {
		return args.tasks.flatMap(item => (item && typeof item === "object" && "name" in item ? [String(item.name)] : []));
	}
	return "name" in args && typeof args.name === "string" ? [args.name] : [];
}
const attempted = (frames: readonly Frame[], name: string): boolean => taskCalls(frames).some(args => taskNames(args).includes(name));

/** One lane field the baseline type does not name yet; only contract mode asserts these planned fields. */
function planField(run: RunRecord, laneName: string, field: string): unknown {
	const lane = run.plan?.lanes.find(candidate => candidate.name === laneName);
	return lane === undefined ? undefined : Reflect.get(lane, field);
}

/**
 * The run's settled-run record, once Storm writes it. The compact card no longer repeats the run id in its text; its
 * presentation metadata names the run, and the start of this prompt anchors a record that has none.
 */
async function reportOf(rpc: Rpc, runId: string, from: number, timeoutMs = 20_000): Promise<string> {
	const record = await until(() => closeoutOf(rpc.frames, runId, from), timeoutMs, `the end report of ${runId}`).catch(() => undefined);
	return record?.text ?? "";
}

/** The omp log files of this profile (one per session), where a worker thread's forwarded records land. */
function logRecords(): Array<Record<string, unknown>> {
	const dir = join(dirname(env.agentDir), "logs");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(file => file.startsWith("omp.") && file.endsWith(".log"))
		.flatMap(file =>
			readFileSync(join(dir, file), "utf8")
				.split("\n")
				.filter(Boolean)
				.flatMap(line => {
					try {
						const value: unknown = JSON.parse(line);
						return value !== null && typeof value === "object" ? [value as Record<string, unknown>] : [];
					} catch {
						return [];
					}
				}),
		);
}

/**
 * The worker thread that hosted `agentId`, from the host's own records: a worker forwards its log records tagged
 * `thread: "wN"`. `subagent launch timing` names the child id and is emitted while the run is live; a worker's
 * `Session exit recorded` names the child's session file and arrives when the session closes. A logical child label
 * without a worker tag is not evidence.
 */
function workerSession(agentId: string): { thread: string; evidence: string } | undefined {
	const records = logRecords();
	const launched = records.find(record => typeof record.thread === "string" && /^w\d+$/.test(record.thread) && record.id === agentId);
	if (launched !== undefined) return { thread: String(launched.thread), evidence: "subagent launch timing" };
	const sessionId = records.find(record => typeof record.sessionFile === "string" && basename(record.sessionFile) === `${agentId}.jsonl`)?.sessionId;
	for (const record of records) {
		if (typeof record.thread !== "string" || !/^w\d+$/.test(record.thread)) continue;
		if (sessionId !== undefined && record.sessionId === sessionId) return { thread: record.thread, evidence: "session id" };
		if (typeof record.sessionFile === "string" && basename(record.sessionFile) === `${agentId}.jsonl`) {
			return { thread: record.thread, evidence: "session file" };
		}
	}
	return undefined;
}

/** A valid `git apply --check` proves the retained patch is the experiment, not a path to a vanished checkout. */
function applies(patch: string): { ok: boolean; detail: string } {
	if (patch === "" || !existsSync(patch)) return { ok: false, detail: "missing" };
	const checked = Bun.spawnSync(["git", "-C", env.project, "apply", "--check", patch]);
	return { ok: checked.exitCode === 0, detail: `exit=${checked.exitCode} stderr=${checked.stderr.toString().slice(0, 200)}` };
}

async function main(): Promise<void> {
	writeFileSync(modelsFile, modelsYml(env.port, { fake: TEAM_PROVIDERS.fake }));
	writeFileSync(profileFile, PROFILE_CONFIG);
	linkPlugin(env);

	await suite.step(
		"fixture: approved shared team, native limit, host isolation and worker threads",
		async () => {
			hostSettings();
			await session(cancelAll, async (rpc, files) => {
				await rpc.prompt("/storm");
				rpc.answer = choose(APPROVE);
				await rpc.prompt("/storm");
				check("the recommended team was approved", files.approvals().length === 1 && existsSync(files.configFile));
				const roles = Object.keys(files.config().roles).sort();
				check(
					"the team has the roles the lanes need",
					["architect", "explorer", "implementer", "quick", "reviewer"].every(role => roles.includes(role)),
					roles.join(","),
				);
				files.editConfig(config => {
					config.isolation = "shared";
					config.roles.explorer = { ...config.roles.explorer!, workers: { min: 4, max: 8 } };
				});
				await rpc.prompt("/storm");
				const explorerWorkers = files.config().roles.explorer?.workers;
				const explorerMax = typeof explorerWorkers === "object" && explorerWorkers !== null ? explorerWorkers.max : explorerWorkers;
				check(
					"the hand-edited shared team is approved again",
					files.config().isolation === "shared" && explorerMax === 8,
					JSON.stringify({ isolation: files.config().isolation, explorerWorkers }),
				);
				rpc.answer = choose(LABEL.autoOff);
				await rpc.prompt("/storm auto");
				await waitAuto(files, "off");
				check("automatic delegation is off for the manual admission paths", (await readAutoDelegationChoice(files.sessionDir)) === "off", await readAutoDelegationChoice(files.sessionDir));
				// A real turn materializes the native transcript so later cases can resume this exact session.
				await rpc.turn("hello");
			});
		},
		120_000,
		{ always: true },
	);

	await suite.step("T02 retained isolated patch gates the comparison and integration-required consumers", async () => {
		const dirs = {
			filler: markerDir("t02-filler"),
			experiment: markerDir("t02-experiment"),
			compareEarly: markerDir("t02-compare-early"),
			buildEarly: markerDir("t02-build-early"),
		};
		const experimentCommand = [
			`pwd -P > ${shq(join(dirs.experiment, "cwd"))}`,
			`printf 'experiment change\\n' > experiment.txt`,
			`{ printf '%s|' "$(pwd -P)"; cat experiment.txt; } > ${shq(join(dirs.experiment, "proof"))}`,
		].join("; ");
		const buildCommand = `pwd -P > ${shq(join(dirs.buildEarly, "cwd"))}`;
		const fillerTasks = [
			...Array.from({ length: 5 }, (_, index) => ({
				name: `F${index}`,
				agent: "storm-explorer",
				task: `Read ${FACT_FILE} independently`,
				say: `E2E-CHILD-DELAY 7000 E2E-CHILD-READ ${FACT_FILE} E2E-FILLER-READ-${index} E2E-CHILD-CLAIM ${TRACKED_CLAIM}`,
			})),
			{
				name: "F5",
				agent: "storm-architect",
				task: `Read ${FACT_FILE} independently`,
				say: `E2E-CHILD-DELAY 7000 E2E-CHILD-READ ${FACT_FILE} E2E-FILLER-READ-5 E2E-CHILD-CLAIM ${TRACKED_CLAIM}`,
			},
			// Not reviewers: a reviewer has a shell and is ordered like a writer since 0.27.0 (P1-c), so two of them in
			// one call are refused (`lane-write`) and no filler would start. Two more explorers fill the same places.
			...[6, 7].map(index => ({
				name: `F${index}`,
				agent: "storm-explorer",
				task: `Read ${FACT_FILE} independently`,
				say: `E2E-CHILD-DELAY 7000 E2E-CHILD-READ ${FACT_FILE} E2E-FILLER-READ-${index} E2E-CHILD-CLAIM ${TRACKED_CLAIM}`,
			})),
		];
		const lanes: ContractLane[] = [
			{ name: "F0", kind: "explore", role: "explorer", goal: "Read the parent tree", results: [trackedAnswer("f0-answer")] },
			{ name: "F1", kind: "explore", role: "explorer", goal: "Read the parent tree", results: [trackedAnswer("f1-answer")] },
			{ name: "F2", kind: "explore", role: "explorer", goal: "Read the parent tree", results: [trackedAnswer("f2-answer")] },
			{ name: "F3", kind: "explore", role: "explorer", goal: "Read the parent tree", results: [trackedAnswer("f3-answer")] },
			{ name: "F4", kind: "explore", role: "explorer", goal: "Read the parent tree", results: [trackedAnswer("f4-answer")] },
			{ name: "F5", kind: "design", role: "architect", goal: "Inspect the unchanged tree", results: [trackedAnswer("f5-answer")] },
			{ name: "F6", kind: "explore", role: "explorer", goal: "Read the parent tree", results: [trackedAnswer("f6-answer")] },
			{ name: "F7", kind: "explore", role: "explorer", goal: "Read the parent tree", results: [trackedAnswer("f7-answer")] },
			{
				name: "E0",
				kind: "run",
				role: "implementer",
				files: ["experiment.txt"],
				goal: "Keep an independent experiment",
				isolationReason: REASON,
				results: [requiredResult("experiment-patch", "artifact", "the retained patch carries experiment.txt", { path: "experiment.txt", contains: "experiment change" })],
			},
			{
				name: "C0",
				kind: "explore",
				role: "explorer",
				goal: "Compare the experiment's result",
				dependsOn: [{ lane: "E0", need: "result" }],
				results: [requiredResult("comparison", "answer", "the comparison names the retained experiment result")],
			},
			{
				name: "B0",
				kind: "code",
				role: "implementer",
				files: ["build.txt"],
				goal: "Build the integrated tree",
				dependsOn: [{ lane: "E0", need: "integrated" }],
				results: [requiredResult("build", "change", "the build ran on the integrated tree", { path: "build.txt", contains: "build change" })],
			},
		];
		const steps: Step[] = [
			planFor(lanes, { explorer: 8, architect: 1, implementer: 2 }),
			// Seven read-only explorers (and the comparison's), one architect: genuine independent reads, not ambiguous
			// writable quick lanes, keep eight subagent runs in flight so the ninth (E0) is homed on a worker thread.
			{ tasks: fillerTasks },
			{ task: ["storm-implementer"], as: "E", say: `E2E-CHILD-DELAY 3000 E2E-EXPERIMENT E2E-CHILD-SH ${b64(experimentCommand)}` },
			{ task: ["storm-explorer"], as: "C", say: "E2E-CHILD-DELAY 8000 E2E-COMPARE-EARLY" },
			{ task: ["storm-implementer"], as: "B", say: `E2E-CHILD-DELAY 8000 E2E-BUILD-EARLY E2E-CHILD-BASH ${buildCommand}` },
			// 0.27.0 (P1-c): the early consumers above start with a note and their results are not accepted on a missing input.
			// What the note asks for is the way on: a follow-up to the comparison's worker once the experiment's result exists.
			// The build needs the integrated tree: after its first worker ended, a second start is still refused.
			{ followUp: "agent://C0", content: "E2E-COMPARE-LATE", afterResult: 'id="C0"' },
			{ task: ["storm-implementer"], as: "B", say: "E2E-BUILD-LATE", afterResult: 'id="B0"' },
		];
		let retainedPatch = "";
		await session(cancelAll, async (rpc, files) => {
			const llm = new LlmCursor(env);
			const before = files.runIds();
			const from = rpc.frames.length;
			await rpc.prompt(startRun(steps), 120_000);
			const run = await files.finishedRun(before, 180_000);
			const frames = rpc.frames.slice(from);
			const report = await reportOf(rpc, run.runId, from);
			const patch = patchPaths(frames)[0] ?? "";
			retainedPatch = patch;
			const artifact = applies(patch);
			const proof = readMarker(dirs.experiment, "proof");
			const isolatedCwd = proof.split("|")[0] ?? "";
			const earlyCompare = childRequests(llm, "E2E-COMPARE-EARLY");
			const earlyBuild = childRequests(llm, "E2E-BUILD-EARLY");
			const lateCompare = childRequests(llm, "E2E-COMPARE-LATE");
			const lateBuild = childRequests(llm, "E2E-BUILD-LATE");
			const compareAttempted = attempted(frames, "C0");
			const buildAttempted = attempted(frames, "B0");
			const patchAt = patch !== "" && existsSync(patch) ? statSync(patch).mtimeMs : undefined;
			// The promised stable result id is the compact reference a consumer may receive; the host's absolute
			// temporary patch path is not part of the product contract.
			const compareWithRef = [...earlyCompare, ...lateCompare].filter(entry => entry.lastUser.includes("experiment-patch"));
			const worker = await until(() => workerSession("E0"), 15_000, "the E0 worker-thread log record").catch(() => undefined);
			const quick = run.agents?.find(agent => agent.id === "E0");
			const fillerReads = llm.of("child").filter(entry => entry.lastUser.includes("E2E-FILLER-READ") && entry.lastTool.includes(FACT_LINE));

			check(
				"T02: the result/dependency plan is admitted natively without an unknown-schema refusal",
				run.plan?.lanes.length === 11 && run.plan.lanes.some(lane => lane.name === "E0"),
				`run=${run.runId} status=${run.status} endReason=${run.endReason} lanes=${run.plan?.lanes.map(lane => lane.name).join(",")}`,
			);
			if (CONTRACT) {
				const results = planField(run, "E0", "results");
				const dependsOn = planField(run, "C0", "dependsOn");
				check(
					"T02 contract: the plan keeps the required result id and the consumer dependency",
					Array.isArray(results) && results.some(entry => entry !== null && typeof entry === "object" && Reflect.get(entry, "id") === "experiment-patch") && Array.isArray(dependsOn) && dependsOn.some(entry => entry !== null && typeof entry === "object" && Reflect.get(entry, "lane") === "E0"),
					`results=${JSON.stringify(results)} dependsOn=${JSON.stringify(dependsOn)} run=${run.runId}`,
				);
			}
			check(
				"T02: the filler runs were independent reads of the actual parent file",
				fillerReads.length > 0,
				`fillerReads=${fillerReads.length} run=${run.runId}`,
			);
			check(
				"T02: the host ran E0 on an observed subagent worker thread",
				worker !== undefined,
				worker === undefined ? "no worker-tagged log record for E0" : `thread=${worker.thread} evidence=${worker.evidence}`,
			);
			check(
				"T02: the independent experiment ran in a different checkout and its file stayed out of the parent",
				isolatedCwd !== "" && outsideProject(isolatedCwd) && proof.includes("experiment change") && !existsSync(join(env.project, "experiment.txt")),
				`cwd=${isolatedCwd || "(missing)"} proof=${proof.slice(0, 120)} parentExists=${existsSync(join(env.project, "experiment.txt"))}`,
			);
			check(
				"T02: the retained experiment patch is a valid artifact outside the parent",
				patch !== "" && outsideProject(patch) && artifact.ok,
				`path=${patch || "(missing)"} ${artifact.detail}`,
			);
			// A consumer may start before the experiment's result exists (0.27.0, P1-c): it is told so in the call's own note, its
			// result is never accepted on the input it started from (the record remembers it was `missing`), and the way on is a
			// follow-up once the result exists.
			// A start note (`'C0' 레인은 선행 ... 시작했습니다`) is a user message after the call's result, with no `[storm` tag in front.
			const directorNotes = llm.of("main").flatMap(entry => [...entry.notes, ...entry.users]);
			const comparison = run.results?.find(row => row.id === "comparison");
			check(
				"T02: a comparison consumer started before the experiment's result exists is told so and not accepted on that input",
				compareAttempted && earlyCompare.length > 0 && directorNotes.some(note => note.includes("'C0'") && note.includes("수용되지 않")) && directorNotes.some(note => note.includes("'C0' 레인의 결과를 수용하지 않았습니다")),
				`attempt=${compareAttempted} early=${earlyCompare.map(entry => entry.ts).join(",") || "none"} notes=${JSON.stringify(directorNotes.filter(note => note.includes("'C0'")).map(note => note.slice(0, 160)))}`,
			);
			check(
				"T02: after the result exists the comparison runs again through a follow-up",
				lateCompare.length > 0 && (patchAt === undefined || lateCompare.every(entry => entry.ts >= patchAt)) && comparison !== undefined,
				`late=${lateCompare.map(entry => entry.ts).join(",") || "none"} patchAt=${patchAt ?? "missing"} comparison=${JSON.stringify(comparison)}`,
			);
			check(
				"T02: the compact trusted reference reached the comparison",
				compareWithRef.length > 0,
				`withRef=${JSON.stringify(compareWithRef.map(entry => entry.ts))} patch=${patch || "(missing)"}`,
			);
			const build = run.results?.find(row => row.id === "build");
			check(
				"T02: the integration-required build is never accepted while only the unintegrated patch exists, and a start after the patch is refused",
				buildAttempted && lateBuild.length === 0 && build?.state !== "accepted" && !existsSync(join(env.project, "build.txt")),
				`earlyB=${earlyBuild.map(entry => entry.ts).join(",") || "none"} lateB=${lateBuild.map(entry => entry.ts).join(",") || "none"} attempted=${buildAttempted} build=${JSON.stringify(build)} buildExists=${existsSync(join(env.project, "build.txt"))} report=${report.slice(-500)}`,
			);
			check(
				"T02: E0 settled with host usage and the run ended with a recorded reason",
				quick !== undefined && quick.state !== "running" && quick.requests > 0 && run.endedAt !== undefined,
				`run=${run.runId} status=${run.status} endReason=${run.endReason} turns=${run.turns ?? "?"} E0=${JSON.stringify(quick)}`,
			);
			console.log(`T02 observed run ${run.runId}: status=${run.status} endReason=${run.endReason} patch=${patch || "(missing)"}`);
		});

		if (retainedPatch === "") {
			check("T02 adoption: the retained patch exists for an authorized worker to apply", false, "run 1 produced no patch path");
			return;
		}
		const adoptDir = markerDir("t02-adopt");
		const adoptCommand = [
			`git apply ${shq(retainedPatch)}`,
			`pwd -P > ${shq(join(adoptDir, "adopt-cwd"))}`,
			`cat experiment.txt > ${shq(join(adoptDir, "adopted-content"))}`,
		].join("; ");
		const earlyReadCommand = `cat experiment.txt > ${shq(join(adoptDir, "build-early-content"))}`;
		const lateReadCommand = `pwd -P > ${shq(join(adoptDir, "build-cwd"))}; cat experiment.txt > ${shq(join(adoptDir, "build-late-content"))}`;
		// Named BA0, not B0: the first scenario now starts a B0 worker, and omp numbers a second agent of one name `B0-2`, which is no lane.
		const adoptionLanes: ContractLane[] = [
			{
				name: "AD0",
				kind: "code",
				role: "implementer",
				files: ["experiment.txt"],
				goal: "Adopt the retained experiment patch into the parent",
				results: [requiredResult("adopt-change", "change", "the parent holds the adopted experiment", { path: "experiment.txt", contains: "experiment change" })],
			},
			{
				name: "BA0",
				kind: "code",
				role: "implementer",
				files: ["build.txt"],
				goal: "Read the integrated tree",
				dependsOn: [{ lane: "AD0", need: "integrated" }],
				results: [requiredResult("build-read", "answer", "the consumer read the integrated experiment")],
			},
		];
		const adoptionSteps: Step[] = [
			planFor(adoptionLanes, { implementer: 2 }),
			{ task: ["storm-implementer"], as: "AD", say: `E2E-CHILD-DELAY 1500 E2E-ADOPT E2E-CHILD-SH ${b64(adoptCommand)}` },
			{ task: ["storm-implementer"], as: "BA", say: `E2E-BUILD-ADOPT-EARLY E2E-CHILD-SH ${b64(earlyReadCommand)}` },
			{ task: ["storm-implementer"], as: "BA", say: `E2E-BUILD-ADOPT-LATE E2E-CHILD-SH ${b64(lateReadCommand)}`, afterResult: 'id="AD0"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const llm = new LlmCursor(env);
				const before = files.runIds();
				const from = rpc.frames.length;
				await rpc.prompt(startRun(adoptionSteps), 120_000);
				const run = await files.finishedRun(before, 180_000);
				const frames = rpc.frames.slice(from);
				const adoptCwd = readMarker(adoptDir, "adopt-cwd");
				const adopted = readMarker(adoptDir, "adopted-content");
				const earlyRead = childRequests(llm, "E2E-BUILD-ADOPT-EARLY");
				const lateRead = childRequests(llm, "E2E-BUILD-ADOPT-LATE");
				const earlyAttempted = taskCalls(frames).some(args => JSON.stringify(args).includes("E2E-BUILD-ADOPT-EARLY"));
				const buildCwd = readMarker(adoptDir, "build-cwd");
				const lateContent = existsSync(join(adoptDir, "build-late-content")) ? readFileSync(join(adoptDir, "build-late-content"), "utf8") : "";
				const adoptedContent = existsSync(join(env.project, "experiment.txt")) ? readFileSync(join(env.project, "experiment.txt"), "utf8") : "";
				const adoptSpawn = (run.spawns ?? []).find(spawn => spawn.lane === "AD0" && spawn.outcome !== "blocked");
				check(
					"T02 adoption: an authorized shared worker applied the retained patch in the parent",
					adoptSpawn !== undefined && real(adoptCwd) === real(env.project) && adopted === "experiment change" && adoptedContent === "experiment change\n",
					`spawn=${JSON.stringify(adoptSpawn)} cwd=${adoptCwd || "(missing)"} adopted=${JSON.stringify(adopted)} parent=${JSON.stringify(adoptedContent)} run=${run.runId}`,
				);
				check(
					"T02 adoption: the integration-required build was attempted before adoption and started nothing",
					earlyAttempted && earlyRead.length === 0,
					`attempted=${earlyAttempted} earlyChildren=${earlyRead.map(entry => entry.ts).join(",") || "none"} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
				);
				check(
					"T02 adoption: after integration the consumer starts in the parent and reads the exact content",
					lateRead.length > 0 && real(buildCwd) === real(env.project) && lateContent === "experiment change\n",
					`lateChildren=${lateRead.map(entry => entry.ts).join(",") || "none"} cwd=${buildCwd || "(missing)"} content=${JSON.stringify(lateContent)} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
				);
				console.log(`T02 adoption observed run ${run.runId}: status=${run.status} endReason=${run.endReason} cwd=${adoptCwd || "(missing)"}`);
			});
		} finally {
			rmSync(join(env.project, "experiment.txt"), { force: true });
		}
	});

	await suite.step("T02 a producer that settled without its required result starts no consumer", async () => {
		const lanes: ContractLane[] = [
			{
				name: "P0",
				kind: "code",
				role: "implementer",
				files: ["generated-report.txt"],
				goal: "Produce the required report",
				results: [requiredResult("report", "change", "the report is in the shared tree", { path: "generated-report.txt", contains: "missing-report" })],
			},
			{ name: "Q0", kind: "run", role: "quick", goal: "Keep the run live", results: [trackedAnswer("q0-answer")] },
			{
				name: "C0",
				kind: "explore",
				role: "explorer",
				goal: "Consume the report",
				results: [requiredResult("c0-answer", "answer", "the comparison reports the producer's required result")],
				dependsOn: [{ lane: "P0", need: "result" }],
			},
		];
		const steps: Step[] = [
			planFor(lanes, { implementer: 1, quick: 1, explorer: 1 }),
			{ task: ["storm-implementer"], as: "P", say: "E2E-CHILD-DELAY 1500 E2E-PRODUCER-NO-REPORT" },
			{ task: ["storm-quick"], as: "Q", say: `E2E-CHILD-DELAY 7000 E2E-CHILD-READ ${FACT_FILE} E2E-MISSING-FILLER E2E-CHILD-CLAIM ${TRACKED_CLAIM}` },
			{ task: ["storm-explorer"], as: "C", say: "E2E-MISSING-CONSUMER", afterResult: 'id="P0"' },
		];
		await session(cancelAll, async (rpc, files) => {
			const llm = new LlmCursor(env);
			const before = files.runIds();
			const from = rpc.frames.length;
			await rpc.prompt(startRun(steps), 120_000);
			const run = await files.finishedRun(before, 180_000);
			const frames = rpc.frames.slice(from);
			const producer = run.agents?.find(agent => agent.id === "P0");
			const consumer = childRequests(llm, "E2E-MISSING-CONSUMER");
			const attemptedConsumer = attempted(frames, "C0");
			const reportMissing = !existsSync(join(env.project, "generated-report.txt"));
			check(
				"T02 missing result: the producer settled but the declared result artifact is absent",
				producer !== undefined && producer.state !== "running" && producer.requests > 0 && reportMissing,
				`P0=${JSON.stringify(producer)} artifactExists=${!reportMissing}`,
			);
			check(
				"T02 missing result: the consumer may start (0.27.0, P1-c) but its answer is not accepted on a result that never existed, and the run is not verified",
				attemptedConsumer && run.results?.find(row => row.id === "c0-answer")?.state !== "accepted" && run.endReason !== "verified",
				`attempted=${attemptedConsumer} children=${consumer.length} at=${consumer.map(entry => entry.ts).join(",") || "none"} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
			);
			console.log(`T02 missing-result observed run ${run.runId}: status=${run.status} endReason=${run.endReason}`);
		});
	});

	await suite.step("T02 a failed producer attempt starts no consumer", async () => {
		const lanes: ContractLane[] = [
			{
				name: "P0",
				kind: "code",
				role: "implementer",
				files: ["failed.txt"],
				goal: "Produce the required result",
				results: [requiredResult("failed-result", "change", "failed.txt is in the shared tree", { path: "failed.txt", contains: "failed" })],
			},
			{
				name: "C0",
				kind: "explore",
				role: "explorer",
				goal: "Consume the failed result",
				results: [requiredResult("c0-answer", "answer", "the comparison reports the failed producer's required result")],
				dependsOn: [{ lane: "P0", need: "result" }],
			},
		];
		const steps: Step[] = [
			planFor(lanes, { implementer: 1, explorer: 1 }),
			// A producer attempt that the host/Storm refuses: no child session, so no report can arrive.
			{ task: ["storm-admission-missing"], as: "P", say: "E2E-FAILED-PRODUCER" },
			{ task: ["storm-explorer"], as: "C", say: "E2E-FAILED-CONSUMER" },
		];
		await session(cancelAll, async (rpc, files) => {
			const llm = new LlmCursor(env);
			const before = files.runIds();
			const from = rpc.frames.length;
			await rpc.prompt(startRun(steps), 120_000);
			const run = await files.finishedRun(before, 180_000);
			const frames = rpc.frames.slice(from);
			const taskErrors = frames
				.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task" && frame.isError === true)
				.map(resultText);
			const producerChildren = childRequests(llm, "E2E-FAILED-PRODUCER");
			const consumer = childRequests(llm, "E2E-FAILED-CONSUMER");
			const attemptedConsumer = attempted(frames, "C0");
			const blockedProducer = (run.spawns ?? []).some(spawn => spawn.outcome === "blocked" && spawn.spawnKey === "P0");
			check(
				"T02 failed attempt: the producer spawn was refused and no producer child ran",
				(blockedProducer || taskErrors.length > 0) && producerChildren.length === 0,
				`blockedSpawn=${blockedProducer} taskErrors=${taskErrors.length} children=${producerChildren.length} text=${taskErrors.join(" | ").slice(0, 300)}`,
			);
			check(
				"T02 failed attempt: the consumer may start (0.27.0, P1-c) but its answer is not accepted on a producer that never ran, and the run is not verified",
				attemptedConsumer && run.results?.find(row => row.id === "c0-answer")?.state !== "accepted" && run.endReason !== "verified",
				`attempted=${attemptedConsumer} children=${consumer.length} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
			);
			console.log(`T02 failed-producer observed run ${run.runId}: status=${run.status} endReason=${run.endReason}`);
		});
	});

	await suite.step("T03 an overlapping shared-write batch and follow-up are refused without partial spawns", async () => {
		const dir = markerDir("t03-shared");
		const tracked = join(env.project, TRACKED_FILE);
		const w0Command = [
			`printf '%s\\n' E2E-T03-W0 >> ${shq(TRACKED_FILE)}`,
			`pwd -P > ${shq(join(dir, "w0-cwd"))}`,
			`sleep 8`,
			`git restore -- ${shq(TRACKED_FILE)}`,
			`pwd -P > ${shq(join(dir, "w0-done"))}`,
		].join("; ");
		const batchCommand = `printf '%s\\n' E2E-T03-BATCH-X0 >> ${shq(TRACKED_FILE)}; pwd -P > ${shq(join(dir, "batch-cwd"))}; sleep 4`;
		const independentEarlyCommand = `printf 'independent t03\\n' > other-t03.txt; pwd -P > ${shq(join(dir, "independent-early-cwd"))}; sleep 4`;
		const independentCommand = `printf 'independent t03\\n' > other-t03.txt; pwd -P > ${shq(join(dir, "independent-cwd"))}`;
		const progress = "e2e-tracked.txt를 쓰는 중";
		const lanes: ContractLane[] = [
			{
				name: "H0",
				kind: "code",
				role: "implementer",
				files: [TRACKED_FILE],
				goal: "Stay idle and accept the follow-up",
				results: [requiredResult("h0-followup", "change", "the holder's follow-up writes only after the writer releases the file", { path: TRACKED_FILE, contains: "storm-child-bash" })],
			},
			{
				name: "W0",
				kind: "run",
				role: "quick",
				files: [TRACKED_FILE],
				goal: "Write the shared file",
				results: [requiredResult("w0-write", "change", "the writer appended its own line to the shared file", { path: TRACKED_FILE, contains: "E2E-T03-W0" })],
			},
			{
				name: "X0",
				kind: "code",
				role: "quick",
				files: [TRACKED_FILE],
				goal: "Conflict with the writer",
				results: [requiredResult("x0-write", "change", "the refused overlapping item never wrote", { path: TRACKED_FILE, contains: "E2E-T03-BATCH-X0" })],
			},
			{
				name: "X1",
				kind: "code",
				role: "quick",
				files: ["other-t03.txt"],
				goal: "Independent batch item",
				results: [requiredResult("x1-write", "change", "the independent item wrote its own file", { path: "other-t03.txt", contains: "independent t03" })],
			},
		];
		const workers = { implementer: 1, quick: 3 };
		const steps: Step[] = [
			planFor(lanes, workers),
			{ task: ["storm-implementer"], as: "H", say: "E2E-CHILD-DELAY 1000 E2E-T03-HOLDER" },
			{ task: ["storm-quick"], as: "W", say: `E2E-T03-WRITER E2E-CHILD-SH ${b64(w0Command)}` },
			{
				tasks: [
					{ name: "X0", agent: "storm-quick", task: "Write the shared file", say: `E2E-T03-BATCH E2E-CHILD-SH ${b64(batchCommand)}` },
					{ name: "X1", agent: "storm-quick", task: "Write the independent file", say: `E2E-T03-BATCH E2E-CHILD-SH ${b64(independentEarlyCommand)}` },
				],
			},
			planFor(lanes.map(lane => (lane.name === "W0" ? { ...lane, progress } : lane)), workers),
			// A work-bearing follow-up to the idle holder: its lane owns the file W0 is writing.
			{ followUp: "agent://H0", content: `E2E-T03-WORK-FOLLOW E2E-CHILD-BASH ${TRACKED_FILE}` },
			// Native progress note: same agent handle with `?progress`. It wakes the idle holder into a read-only turn: let through.
			{ edit: "agent://H0?progress" },
			{
				tasks: [{ name: "X1", agent: "storm-quick", task: "Write the independent file", say: `E2E-T03-INDEPENDENT-LATE E2E-CHILD-SH ${b64(independentCommand)}` }],
				afterResult: 'id="W0"',
			},
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const llm = new LlmCursor(env);
				const before = files.runIds();
				const from = rpc.frames.length;
				await rpc.prompt(startRun(steps), 120_000);
				await until(() => (existsSync(join(dir, "w0-cwd")) ? true : undefined), 20_000, "the writer to start").catch(() => false);
				const run = await files.finishedRun(before, 180_000);
				const frames = rpc.frames.slice(from);
				const holder = run.agents?.find(agent => agent.id === "H0");
				const batchChildren = childRequests(llm, "E2E-T03-BATCH");
				const independentLate = childRequests(llm, "E2E-T03-INDEPENDENT-LATE");
				const routed = (run.spawns ?? []).filter(spawn => spawn.outcome !== "blocked");
				const blockedBatchRouted = routed.filter(spawn => (spawn.lane === "X0" || spawn.lane === "X1") && spawn.spawnKey !== "X1");
				check(
					"T03 conflict: the fresh batch is attempted while W0 owns the shared file",
					attempted(frames, "X0") && attempted(frames, "X1") && existsSync(join(dir, "w0-cwd")),
					`attempted=${attempted(frames, "X0")}/${attempted(frames, "X1")} writer=${existsSync(join(dir, "w0-cwd"))} run=${run.runId}`,
				);
				check(
					"T03 conflict: the overlapping batch starts nothing and reserves nothing",
					batchChildren.length === 0 && !existsSync(join(dir, "batch-cwd")) && blockedBatchRouted.length === 0,
					`children=${batchChildren.length} marker=${existsSync(join(dir, "batch-cwd"))} routed=${JSON.stringify(blockedBatchRouted.map(spawn => [spawn.spawnKey, spawn.lane]))} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
				);
				const workFollows = llm.of("child").filter(entry => entry.lastUser.includes("E2E-T03-WORK-FOLLOW"));
				const progressNotes = llm.of("child").filter(entry => entry.lastUser.includes("storm director check"));
				const w0DoneAt = existsSync(join(dir, "w0-done")) ? statSync(join(dir, "w0-done")).mtimeMs : undefined;
				check(
					"T03 conflict: the work-bearing follow-up to the idle holder is not delivered while W0 writes",
					holder !== undefined && (holder.followUps === 0 || (workFollows.length > 0 && workFollows.every(entry => w0DoneAt !== undefined && entry.ts >= w0DoneAt))),
					`H0=${JSON.stringify(holder)} workFollows=${JSON.stringify(workFollows.map(entry => entry.ts))} w0DoneAt=${w0DoneAt ?? "missing"} run=${run.runId}`,
				);
				const mainEntries = llm.of("main");
				const noteAt = mainEntries.findIndex(entry => entry.decision.tool === "write" && entry.decision.args?.path === "agent://H0?progress");
				const noteResult = noteAt < 0 ? undefined : mainEntries.slice(noteAt + 1).find(entry => entry.lastTool !== "")?.lastTool;
				check(
					"T03 progress: the native ?progress note to the idle holder is not refused with lane-write while W0 writes, and is no follow-up",
					noteAt >= 0 && noteResult?.includes("[storm:lane-write]") !== true && (!CONTRACT || holder?.followUps === 0),
					`noteResult=${JSON.stringify(noteResult?.slice(0, 300))} progressNotes=${JSON.stringify(progressNotes.map(entry => entry.ts))} followUps=${holder?.followUps} run=${run.runId}`,
				);
				check(
					"T03 conflict: after W0 settles the valid independent item starts and completes",
					independentLate.length > 0 &&
						existsSync(join(dir, "independent-cwd")) &&
						existsSync(join(env.project, "other-t03.txt")) &&
						readFileSync(join(env.project, "other-t03.txt"), "utf8") === "independent t03\n" &&
						routed.some(spawn => spawn.lane === "X1" && spawn.spawnKey === "X1"),
					`lateChildren=${independentLate.map(entry => entry.ts).join(",") || "none"} marker=${existsSync(join(dir, "independent-cwd"))} content=${JSON.stringify(existsSync(join(env.project, "other-t03.txt")) ? readFileSync(join(env.project, "other-t03.txt"), "utf8") : "")} spawns=${JSON.stringify(routed.map(spawn => [spawn.spawnKey, spawn.lane]))}`,
				);
				check(
					"T03 plan progress: the note is accepted without starting, reserving or blocking another lane",
					run.plan?.lanes.find(lane => lane.name === "W0")?.progress === progress && existsSync(join(dir, "w0-done")) && readFileSync(tracked, "utf8") === TRACKED_TEXT,
					`progress=${String(run.plan?.lanes.find(lane => lane.name === "W0")?.progress)} done=${existsSync(join(dir, "w0-done"))} tracked=${JSON.stringify(readFileSync(tracked, "utf8"))}`,
				);
				console.log(`T03 conflict observed run ${run.runId}: status=${run.status} endReason=${run.endReason}`);
			});
		} finally {
			writeFileSync(tracked, TRACKED_TEXT);
			rmSync(join(env.project, "other-t03.txt"), { force: true });
		}
	});

	await suite.step("T03 independent isolated experiments run in parallel and a progress note reserves no write", async () => {
		const dir = markerDir("t03-parallel");
		const startFile = join(dir, "start");
		const doneFile = join(dir, "done");
		const command = [
			`printf 'start %s\\n' "$(pwd -P)" >> ${shq(startFile)}`,
			`printf 'parallel change\\n' > parallel.txt`,
			`sleep 6`,
			`printf 'done %s\\n' "$(pwd -P)" >> ${shq(doneFile)}`,
		].join("; ");
		const lanes: ContractLane[] = [
			{
				name: "AB0",
				kind: "run",
				role: "quick",
				files: ["parallel-a.txt"],
				goal: "Run independent experiment A",
				isolationReason: REASON,
				results: [requiredResult("ab0-patch", "artifact", "the retained patch carries experiment A's parallel.txt", { path: "parallel.txt", contains: "parallel change" })],
			},
			{
				name: "AB1",
				kind: "run",
				role: "quick",
				files: ["parallel-b.txt"],
				goal: "Run independent experiment B",
				isolationReason: REASON,
				results: [requiredResult("ab1-patch", "artifact", "the retained patch carries experiment B's parallel.txt", { path: "parallel.txt", contains: "parallel change" })],
			},
		];
		const steps: Step[] = [
			planFor(lanes, { quick: 2 }),
			{ task: ["storm-quick", "storm-quick"], as: "AB", say: `E2E-T03-PARALLEL E2E-CHILD-SH ${b64(command)}` },
			planFor([{ ...lanes[0]!, progress: "A is running" }, lanes[1]!], { quick: 2 }),
		];
		await session(cancelAll, async (rpc, files) => {
			const llm = new LlmCursor(env);
			const before = files.runIds();
			const from = rpc.frames.length;
			await rpc.prompt(startRun(steps), 120_000);
			const started = await until(
				() => {
					if (!existsSync(startFile)) return undefined;
					const lines = readFileSync(startFile, "utf8").split("\n").filter(Boolean);
					return lines.length >= 2 ? lines : undefined;
				},
				30_000,
				"both isolated experiments to start",
			).catch(() => []);
			const doneAtStart = existsSync(doneFile) ? readFileSync(doneFile, "utf8").split("\n").filter(Boolean) : [];
			const run = await files.finishedRun(before, 180_000);
			const frames = rpc.frames.slice(from);
			const cwds = started.map(line => line.replace(/^start /, ""));
			const patches = patchPaths(frames);
			const parallelChildren = childRequests(llm, "E2E-T03-PARALLEL");
			check(
				"T03 parallel: both isolated experiments were live at the same time in different checkouts",
				started.length >= 2 && doneAtStart.length === 0 && new Set(cwds).size === 2 && cwds.every(outsideProject),
				`starts=${JSON.stringify(cwds)} doneAtStart=${doneAtStart.length} run=${run.runId}`,
			);
			check(
				"T03 parallel: each isolated result is a retained patch carrying its own experiment",
				patches.length >= 2 && patches.every(patch => outsideProject(patch) && existsSync(patch) && readFileSync(patch, "utf8").includes("parallel.txt")),
				`patches=${JSON.stringify(patches)} run=${run.runId}`,
			);
			check(
				"T03 progress: the note is accepted without starting or reserving a write",
				run.plan?.lanes.find(lane => lane.name === "AB0")?.progress === "A is running" && parallelChildren.length >= 2,
				`progress=${String(run.plan?.lanes.find(lane => lane.name === "AB0")?.progress)} children=${parallelChildren.length} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
			);
		});
	});

	await suite.step("T03 independent read lanes run in parallel and read the exact parent content", async () => {
		const lanes: ContractLane[] = [
			{ name: "R0", kind: "explore", role: "explorer", goal: "Read the parent file", results: [trackedAnswer("r0-answer")] },
			{ name: "R1", kind: "explore", role: "explorer", goal: "Read the parent file", results: [trackedAnswer("r1-answer")] },
		];
		const steps: Step[] = [
			planFor(lanes, { explorer: 2 }),
			{
				tasks: [
					{ name: "R0", agent: "storm-explorer", task: `Read ${FACT_FILE}`, say: `E2E-READ-A E2E-CHILD-DELAY 2500 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${TRACKED_CLAIM}` },
					{ name: "R1", agent: "storm-explorer", task: `Read ${FACT_FILE}`, say: `E2E-READ-B E2E-CHILD-DELAY 2500 E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${TRACKED_CLAIM}` },
				],
			},
		];
		await session(cancelAll, async (rpc, files) => {
			const llm = new LlmCursor(env);
			const before = files.runIds();
			await rpc.prompt(startRun(steps), 120_000);
			const run = await files.finishedRun(before, 180_000);
			const readsA = childRequests(llm, "E2E-READ-A");
			const readsB = childRequests(llm, "E2E-READ-B");
			const contentA = readsA.some(entry => entry.lastTool.includes(FACT_LINE));
			const contentB = readsB.some(entry => entry.lastTool.includes(FACT_LINE));
			const agentA = run.agents?.find(agent => agent.id === "R0");
			const agentB = run.agents?.find(agent => agent.id === "R1");
			const overlapped = agentA !== undefined && agentB !== undefined && agentA.lastActivityAt > agentB.startedAt && agentB.lastActivityAt > agentA.startedAt;
			const routed = (run.spawns ?? []).filter(spawn => spawn.outcome !== "blocked").map(spawn => spawn.lane);
			check(
				"T03 parallel reads: both independent read lanes were admitted and read the exact parent content",
				readsA.length > 0 && readsB.length > 0 && contentA && contentB && overlapped && routed.includes("R0") && routed.includes("R1"),
				`A=${readsA.length} B=${readsB.length} content=${contentA}/${contentB} overlapped=${overlapped} lanes=${JSON.stringify(routed)} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
			);
			console.log(`T03 read observed run ${run.runId}: status=${run.status} endReason=${run.endReason}`);
		});
	});

	await suite.step("T03 automatic delegation refuses an overlapping native batch before any spawn", async () => {
		const dir = markerDir("t03-auto");
		const tracked = join(env.project, TRACKED_FILE);
		const writerCommand = [
			`printf '%s\\n' E2E-T03-AUTO-W >> ${shq(TRACKED_FILE)}`,
			`pwd -P > ${shq(join(dir, "writer-cwd"))}`,
			`sleep 8`,
			`git restore -- ${shq(TRACKED_FILE)}`,
			`pwd -P > ${shq(join(dir, "writer-done"))}`,
		].join("; ");
		const batchCommand = `pwd -P > ${shq(join(dir, "auto-batch-cwd"))}; sleep 4`;
		const lanes: ContractLane[] = [
			{
				name: "W0",
				kind: "run",
				role: "quick",
				files: [TRACKED_FILE],
				goal: "Write the shared file",
				results: [requiredResult("w0-write", "change", "the writer appended its own line to the shared file", { path: TRACKED_FILE, contains: "E2E-T03-AUTO-W" })],
			},
			{
				name: "X0",
				kind: "code",
				role: "quick",
				files: [TRACKED_FILE],
				goal: "Conflict with the writer",
				results: [requiredResult("x0-write", "change", "the refused overlapping item never wrote", { path: TRACKED_FILE, contains: "E2E-T03-BATCH-X0" })],
			},
			{
				name: "X1",
				kind: "code",
				role: "quick",
				files: ["other-auto-t03.txt"],
				goal: "Independent batch item",
				results: [requiredResult("x1-write", "change", "the independent item wrote its own file", { path: "other-auto-t03.txt", contains: "independent t03" })],
			},
		];
		const steps: Step[] = [
			planFor(lanes, { quick: 3 }),
			{ task: ["storm-quick"], as: "W", say: `E2E-T03-AUTO-WRITER E2E-CHILD-SH ${b64(writerCommand)}` },
			{ task: ["storm-quick", "storm-quick"], as: "X", say: `E2E-T03-AUTO-BATCH E2E-CHILD-SH ${b64(batchCommand)}` },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				rpc.answer = choose(LABEL.autoOn);
				await rpc.prompt("/storm auto");
				await waitAuto(files, "on");
				const llm = new LlmCursor(env);
				const before = files.runIds();
				const from = rpc.frames.length;
				const prompt = `E2E-STEPS ${JSON.stringify(steps)}`;
				await rpc.turn(prompt, 120_000);
				const run = await files.finishedRun(before, 180_000);
				const frames = rpc.frames.slice(from);
				const batchChildren = childRequests(llm, "E2E-T03-AUTO-BATCH");
				const routed = (run.spawns ?? []).filter(spawn => spawn.outcome !== "blocked");
				const batchAttempted = taskCalls(frames).some(args => JSON.stringify(args).includes("E2E-T03-AUTO-BATCH"));
				check(
					"T03 auto conflict: the writer is in flight and the batch is attempted",
					batchAttempted && routed.some(spawn => spawn.lane === "W0"),
					`attempted=${batchAttempted} spawns=${JSON.stringify(routed.map(spawn => [spawn.spawnKey, spawn.lane]))} run=${run.runId}`,
				);
				check(
					"T03 auto conflict: no batch item starts and no independent sibling is spawned",
					batchChildren.length === 0 && !existsSync(join(dir, "auto-batch-cwd")) && !routed.some(spawn => spawn.lane === "X0" || spawn.lane === "X1"),
					`children=${batchChildren.length} marker=${existsSync(join(dir, "auto-batch-cwd"))} lanes=${JSON.stringify(routed.map(spawn => spawn.lane))} run=${run.runId} status=${run.status} endReason=${run.endReason}`,
				);
				rpc.answer = choose(LABEL.autoOff);
				await rpc.prompt("/storm auto");
				await waitAuto(files, "off");
			});
		} finally {
			writeFileSync(tracked, TRACKED_TEXT);
			rmSync(join(env.project, "other-auto-t03.txt"), { force: true });
		}
	});

	// Always runs: a focused scenario's sessions must exit cleanly too.
	await suite.step(
		"omp exit codes",
		async () => {
			check("every omp session exited 0", exitCodes.length > 0 && exitCodes.every(code => code === 0), `exit=${exitCodes.join(",")}`);
			const sandboxes = existsSync(isolationRoot) ? readdirSync(isolationRoot) : [];
			check("the host released every isolation sandbox", sandboxes.length === 0, `${isolationRoot}: ${sandboxes.join(",") || "empty"}`);
		},
		120_000,
		{ always: true },
	);
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
