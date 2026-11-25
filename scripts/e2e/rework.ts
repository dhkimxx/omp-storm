#!/usr/bin/env bun
/**
 * S3 rework E2E (T05, T04), real host: a disposable git project, an isolated HOME/profile, the pinned omp and the
 * local fake LLM. No paid model calls and nothing under the real user profile is read or written.
 *
 * Two modes, deliberately separate:
 *   E2E_REWORK_MODE=baseline (default)
 *     Record what v0.21.0 (`1965f71`) actually does. Native task admission, worker output, run records and the
 *     unfinished lanes are checked (the final ledger's `closeoutFacts`, or that binary's own card line). The S3 product expectations are still evaluated and reported as
 *     failures when unmet: a discrepancy is a reproduction, never a product PASS.
 *   E2E_REWORK_MODE=accept
 *     Assert the intended T05/T04 behavior. This is the pass/fail test for the implementation.
 *
 * Plans come from scripts/e2e/contract-fixture.ts:
 *   results:     [{ id, kind, criterion, path?, contains?, check? }]
 *   dependsOn:   [{ lane, need: "result" | "integrated" | "reviewable" }]
 * Baseline submits only the pre-S1 lane fields (`contract: false`) for the original binary; the current fresh-plan
 * boundary refuses a deliverable lane without results, so baseline is historical evidence and accept is the candidate
 * pass/fail mode. Baseline's lack of result ids is a technical limit recorded separately from observed behavior, not
 * an unexecuted reproduction. Every worker attempt below really runs under omp and leaves files or official
 * run-record entries; the fake model's text alone is never evidence.
 *
 * Usage:
 *   E2E_PORT=18783 E2E_WORK=/tmp/storm-e2e-rework-<unique> ./node_modules/.bin/bun scripts/e2e/rework.ts
 *   E2E_ONLY=T05 ...    # fixture + T05 main/retry/control
 *   E2E_ONLY=T04 ...    # fixture + T04 only
 *   E2E_REWORK_MODE=accept ...  # implementation acceptance pass
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { resultContractIdentity } from "../../src/runtime/result-evidence.ts";
import type { AgentEntry, RunRecord, SpawnRecord } from "../../src/types.ts";
import { contractPlan, requiredResult, type ContractLane } from "./contract-fixture.ts";
import {
	type Answer,
	cancelAll,
	choose,
	type Frame,
	LlmCursor,
	linkPlugin,
	modelsYml,
	prepare,
	price,
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
	closeoutBody,
	closeoutOf,
	pendingLanesOf,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, seedFact } from "./typed-fixture.ts";

const MODE = (process.env.E2E_REWORK_MODE ?? "baseline").trim().toLowerCase();
const ACCEPT = MODE === "accept";
const LABEL = { autoOff: "자동 위임 끄기" } as const;
const MAIN = "fake/general-b";
const env = prepare("storm-e2e-rework", 18783);
seedFact(env.project);
const suite = new Suite(`E2E (rework, ${MODE})`, env);
const check = suite.check.bind(suite);
/** The one native session this file drives; every case resumes its approved team. */
let owned: { id: string; dir: string } | undefined;
const profileFile = join(env.agentDir, "config.yml");
const modelsFile = join(env.agentDir, "models.yml");
const exitCodes: number[] = [];
const observations: string[] = [];

/** The owned session's reader for setup code outside a body. */
function ownedFiles(): StormFiles {
	if (owned === undefined) throw new Error("the rework fixture session was not created");
	return new StormFiles(env, owned.id);
}

/** The product expectation; a baseline failure here is the reproduction, not a weakened test. */
function expectation(name: string, ok: boolean, detail = ""): void {
	check(`${ACCEPT ? "accept" : "baseline expected failure"}: ${name}`, ok, detail);
}

/** A baseline-only observation. It says what happened; it does not call the missing behavior a feature pass. */
function reproduction(name: string, ok: boolean, detail = ""): void {
	if (!ACCEPT) check(`baseline observation: ${name}`, ok, detail);
}

function note(text: string): void {
	observations.push(text);
	console.log(`NOTE ${text}`);
}

/** One omp RPC process: started, used and closed; its exit code is checked at the end. */
async function session<T>(answer: Answer, body: (rpc: Rpc, files: StormFiles) => Promise<T>): Promise<T> {
	const rpc = new Rpc(env, answer, { model: MAIN, ...(owned === undefined ? {} : { resume: owned.id, sessionDir: owned.dir }) });
	try {
		await rpc.ready();
		return await body(rpc, new StormFiles(env, rpc.sessionId));
	} finally {
		exitCodes.push(await rpc.close());
		if (owned === undefined) owned = { id: rpc.sessionId, dir: rpc.sessionDir };
	}
}

const startRun = (sequence: Step[], rounds = 3): string =>
	`/storm E2E-ROUTE ${JSON.stringify({ action: "run", rounds })} E2E-STEPS ${JSON.stringify(sequence)}`;
/** The run record, the frames of the turn that started it, and where that turn began. */
async function runOf(rpc: Rpc, files: StormFiles, message: string): Promise<{ run: RunRecord; frames: Frame[]; from: number }> {
	const before = files.runIds();
	const from = rpc.frames.length;
	await rpc.prompt(message, 90_000);
	const run = await files.finishedRun(before);
	return { run, frames: rpc.frames.slice(from), from };
}

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

/** The run's settled-run record (its closeout), once Storm writes it. */
async function reportOf(rpc: Rpc, runId: string, from: number, timeoutMs = 20_000): Promise<string> {
	const record = await until(() => closeoutOf(rpc.frames, runId, from), timeoutMs, `the end report of ${runId}`).catch(() => undefined);
	return record?.text ?? "";
}

const children = (llm: LlmCursor): string[] => [...new Set(llm.of("child").map(entry => entry.lastUser))];

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
/** A path as a POSIX single-quoted shell word. */
const shq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
function markerDir(name: string): string {
	const dir = join(env.work, "markers", name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}
function marker(dir: string, name: string): string {
	return join(dir, name);
}
function markerExists(dir: string, name: string): boolean {
	return existsSync(marker(dir, name));
}
function readProject(name: string): string {
	const path = join(env.project, name);
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}
function cleanupProject(...names: string[]): void {
	for (const name of names) rmSync(join(env.project, name), { force: true });
}

/**
 * The lanes a settled run left unfinished. The current card no longer lists them: they are read from the final
 * on-disk ledger (`closeoutFacts`). A baseline binary predates those facts and still printed its official
 * `- 미완료 레인:` card line, which stays the evidence for that historical mode only.
 */
function pendingLanes(run: RunRecord, report: string): string[] {
	const recorded = pendingLanesOf(run);
	if (recorded !== undefined) return recorded;
	const found = /- 미완료 레인: ([^\n]+)/.exec(report)?.[1];
	return found === undefined ? [] : found.split(",").map(name => name.trim()).filter(Boolean);
}

/**
 * Whether a settled run reports `row` as still open: the final ledger keeps the row unaccepted, and the run's record
 * is a whole card rather than the one-line clean tier. Row ids and their reasons are ledger and `/storm status`
 * detail; the compact card carries only the official aggregate.
 */
function closeoutKeepsOpen(row: ResultRow | undefined, report: string): boolean {
	return row !== undefined && row.state !== "accepted" && closeoutBody(report).length > 1;
}

/** Lanes whose plan is bound to a non-blocked native spawn. */
function lanesWithSpawn(run: RunRecord): string[] {
	return [...new Set(run.spawns.filter((spawn: SpawnRecord) => spawn.outcome !== "blocked" && spawn.lane !== undefined).map(spawn => spawn.lane!))];
}

function agentRows(run: RunRecord, role: string): AgentEntry[] {
	return (run.agents ?? []).filter(agent => agent.role === role);
}

/** A persisted lane as unknown: baseline PlanLane cannot carry the new wire, so read it through `in` guards. */
function persistedLane(run: RunRecord, laneName: string): unknown {
	return run.plan?.lanes.find(candidate => candidate.name === laneName);
}

/** The planned result ids as persisted; empty on baseline, which is a technical limit rather than behavior. */
function resultIds(run: RunRecord, laneName: string): string[] {
	const lane = persistedLane(run, laneName);
	if (typeof lane !== "object" || lane === null || !("results" in lane) || !Array.isArray(lane.results)) return [];
	return lane.results.flatMap(result => {
		if (typeof result !== "object" || result === null || !("id" in result)) return [];
		return typeof result.id === "string" && result.id !== "" ? [result.id] : [];
	});
}

function depsOf(run: RunRecord, laneName: string): Array<{ lane: string; need: string }> {
	const lane = persistedLane(run, laneName);
	if (typeof lane !== "object" || lane === null || !("dependsOn" in lane) || !Array.isArray(lane.dependsOn)) return [];
	return lane.dependsOn.flatMap(dep => {
		if (typeof dep !== "object" || dep === null || !("lane" in dep) || !("need" in dep)) return [];
		return typeof dep.lane === "string" && typeof dep.need === "string" && dep.lane !== "" && dep.need !== ""
			? [{ lane: dep.lane, need: dep.need }]
			: [];
	});
}

type ResultRow = NonNullable<RunRecord["results"]>[number];

/** One official requirement row by exact id. Lane wording, plan text and the director's prose are never evidence. */
function resultOf(run: RunRecord, id: string): ResultRow | undefined {
	return run.results?.find(row => row.id === id);
}

/** Bounded row facts for failure detail: host attempt, content version and the producer versions it consumed. */
function resultRowText(row: ResultRow | undefined): string {
	if (row === undefined) return "missing";
	const consumed = (row.consumed ?? []).map(input => `${input.id}@${input.version.slice(0, 8)}`).join(",");
	return `${row.id} lane=${row.lane ?? "-"} state=${row.state} attempt=${row.attemptId ?? "-"} version=${row.contentVersion?.slice(0, 12) ?? "-"} consumed=[${consumed}] reason=${JSON.stringify(row.reason ?? "")}`;
}

/**
 * The one read-only answer claim: the typed fixture line's signed value, cited at its actual location. A prose
 * claim about untyped prose would be `reviewable`; this one agrees mechanically with the cited source, so the rework
 * rows under test see a genuinely accepted `c-answer` / `a-answer`.
 */
const TRACKED_CLAIM = FACT_CLAIM;

function observationOf(prefix: string, run: RunRecord, report: string): void {
	const pending = pendingLanes(run, report);
	const line = `${prefix} run=${run.runId} status=${run.status} endReason=${run.endReason ?? "?"} turns=${run.turns ?? "?"}/${run.maxRounds ?? "?"} pending=[${pending.join(",")}]`;
	note(line);
	console.log(`OBSERVATION ${line}`);
}

/** Worker directives: real files and markers, never the model's text alone. */
function bWriteV1(root: string): string {
	return `printf 'version: v1\\ncontent: alpha\\n' > ${shq(join(env.project, "b-output.txt"))}; printf 'v1\\n' > ${shq(marker(root, "b-v1"))}`;
}
/** B v2 as a plain replacement; the caller schedules it only after the earlier consumer has settled. */
function bWriteV2Direct(root: string): string {
	return `printf 'version: v2\\ncontent: beta\\n' > ${shq(join(env.project, "b-output.txt"))}; printf 'v2\\n' > ${shq(marker(root, "b-v2"))}`;
}
/** A retry after B v2: it really reads v2, then fails its own required `result: accepted` criterion. */
function aRetryRejected(root: string): string {
	return (
		`for i in $(seq 1 400); do grep -q '^version: v2$' ${shq(join(env.project, "b-output.txt"))} 2>/dev/null && break; sleep 0.05; done; ` +
		`printf 'result: rejected\\nb-version: v2\\ninput: %s\\nreason: current result rejected\\n' "$(tr '\\n' ';' < ${shq(join(env.project, "b-output.txt"))})" > ${shq(join(env.project, "a-report.txt"))}; ` +
		`printf 'retry-rejected\\n' > ${shq(marker(root, "a-retry-rejected"))}`
	);
}
function aConsumeV1(root: string): string {
	return (
		`for i in $(seq 1 400); do grep -q '^version: v1$' ${shq(join(env.project, "b-output.txt"))} 2>/dev/null && break; sleep 0.05; done; ` +
		`cp ${shq(join(env.project, "b-output.txt"))} ${shq(join(env.project, "a-input-snapshot.txt"))}; ` +
		`printf 'result: accepted\\nb-version: v1\\ninput: %s\\n' "$(tr '\\n' ';' < ${shq(join(env.project, "a-input-snapshot.txt"))})" > ${shq(join(env.project, "a-report.txt"))}; ` +
		`printf 'done\\n' > ${shq(marker(root, "a-v1"))}`
	);
}
function waitFor(root: string, names: string[], then: string): string {
	const tests = names.map(name => `[ -f ${shq(marker(root, name))} ]`).join(" && ");
	return `for i in $(seq 1 600); do ${tests} && break; sleep 0.05; done; ${then}`;
}
function controlB(root: string): string {
	return `printf 'version: control\\ncontent: unchanged\\n' > ${shq(join(env.project, "control-b.txt"))}; printf 'ready\\n' > ${shq(marker(root, "control-b"))}`;
}
function controlA(root: string): string {
	return (
		`for i in $(seq 1 400); do grep -q '^version: control$' ${shq(join(env.project, "control-b.txt"))} 2>/dev/null && break; sleep 0.05; done; ` +
		`printf 'result: accepted\\ninput: %s\\n' "$(tr '\\n' ';' < ${shq(join(env.project, "control-b.txt"))})" > ${shq(join(env.project, "control-a.txt"))}; ` +
		`printf 'control-a\\n' > ${shq(marker(root, "control-a"))}`
	);
}

/** The result wire T05 sends: ids survive replans, B is a prerequisite of A, C is independent. */
function t05Lanes(bResultContains: string, control = false): ContractLane[] {
	const b = control ? "control-b-result" : "b-result";
	const a = control ? "control-a-result" : "a-result";
	const c = control ? "control-c-answer" : "c-answer";
	const bPath = control ? "control-b.txt" : "b-output.txt";
	const aPath = control ? "control-a.txt" : "a-report.txt";
	return [
		{
			name: "b-produce",
			kind: "code",
			role: "implementer",
			files: [bPath],
			goal: control ? "Publish a result that must not change" : "Publish B v1, then replace it with B v2",
			results: [requiredResult(b, "change", `current ${bPath} content`, { path: bPath, contains: bResultContains })],
		},
		{
			name: "a-consume",
			kind: "run",
			role: "quick",
			files: [aPath],
			goal: "Consume the current B result",
			results: [requiredResult(a, "artifact", `${aPath} names the B result version it consumed`, { path: aPath, contains: "result: accepted" })],
			dependsOn: [{ lane: "b-produce", need: "result" }],
		},
		{
			name: "c-independent",
			kind: "explore",
			role: "explorer",
			goal: "Read the tracked file independently of B",
			results: [requiredResult(c, "answer", "report what the tracked file contains")],
		},
		{
			name: "review",
			kind: "review",
			role: "reviewer",
			goal: "Verify the current integration",
			dependsOn: [
				{ lane: "b-produce", need: "integrated" },
				{ lane: "a-consume", need: "reviewable" },
				{ lane: "c-independent", need: "reviewable" },
			],
		},
	];
}
const t05Workers = { implementer: 1, quick: 1, explorer: 1, reviewer: 1 };

/** T04's first plan: an independent read succeeds, the implementer lane must produce B and fails, review waits. */
function t04InitialLanes(): ContractLane[] {
	return [
		{
			name: "a-read",
			kind: "explore",
			role: "explorer",
			goal: "Read the tracked file independently of B",
			results: [requiredResult("a-answer", "answer", "report what the tracked file contains")],
		},
		{
			name: "b-write",
			kind: "code",
			role: "implementer",
			files: ["b-output.txt"],
			goal: "Produce the required B result",
			results: [requiredResult("b-result", "change", "b-output.txt holds the accepted B result", { path: "b-output.txt", contains: "b-status: ok" })],
		},
		{
			name: "review",
			kind: "review",
			role: "reviewer",
			goal: "Verify the current integration",
			dependsOn: [
				{ lane: "a-read", need: "reviewable" },
				{ lane: "b-write", need: "result" },
			],
		},
	];
}

/**
 * After B fails: either move the same `b-result` requirement to a quick recovery lane, or submit a review lane
 * without the removed `b-write` edge. The removal branch is otherwise valid S2 input, so a rejection can only be
 * about the still-missing b-result obligation, never a dangling dependency on a lane that no longer exists.
 */
function t04Replan(repair: boolean): ContractLane[] {
	const [aRead, , review] = t04InitialLanes() as [ContractLane, ContractLane, ContractLane];
	if (repair) {
		return [
			aRead,
			{
				name: "b-repair",
				kind: "run",
				role: "quick",
				files: ["b-output.txt"],
				goal: "Recover the required B result under the same contract",
				results: [requiredResult("b-result", "change", "b-output.txt holds the accepted B result", { path: "b-output.txt", contains: "b-status: ok" })],
				dependsOn: [{ lane: "a-read", need: "reviewable" }],
			},
			{ ...review, dependsOn: [{ lane: "a-read", need: "reviewable" }, { lane: "b-repair", need: "result" }] },
		];
	}
	return [aRead, { ...review, dependsOn: [{ lane: "a-read", need: "reviewable" }] }];
}

function quickRepair(root: string): string {
	return `printf 'b-status: ok\\ncontent: recovered\\n' > ${shq(join(env.project, "b-output.txt"))}; printf 'repaired\\n' > ${shq(marker(root, "b-repair"))}`;
}


async function main(): Promise<void> {
	writeFileSync(modelsFile, modelsYml(env.port, { fake: TEAM_PROVIDERS.fake }));
	writeFileSync(profileFile, PROFILE_CONFIG);
	linkPlugin(env);

	await suite.step(
		"fixture: approved shared team and automatic delegation off",
		async () => {
			await session(cancelAll, async (rpc, files) => {
				await rpc.prompt("/storm");
				rpc.answer = choose(APPROVE);
				await rpc.prompt("/storm");
				check("the recommended team was approved", files.approvals().length === 1 && existsSync(files.configFile));
				const roles = Object.keys(files.config().roles).sort();
				check(
					"the team has every role the lanes use",
					["explorer", "implementer", "quick", "reviewer"].every(role => roles.includes(role)),
					roles.join(","),
				);
				files.editConfig(config => {
					config.isolation = "shared";
				});
				await rpc.prompt("/storm");
				check(
					"the hand-edited shared team is approved again",
					files.config().isolation === "shared",
					JSON.stringify({ isolation: files.config().isolation }),
				);
				rpc.answer = choose(LABEL.autoOff);
				await rpc.prompt("/storm auto");
				await waitAuto(files, "off");
				// A real turn materializes the native transcript so later cases can resume this exact session.
				await rpc.turn("hello");
			});
		},
		120_000,
		{ always: true },
	);

	await suite.step("T05: B v1 is consumed by A, C is independent, B v2 reopens A", async () => {
		const root = markerDir("t05");
		const llm = new LlmCursor(env);
		const b1 = bWriteV1(root);
		const a1 = aConsumeV1(root);
		const b2 = bWriteV2Direct(root);
		const reviewWaits = waitFor(root, ["b-v2"], "printf 'ready\\n' > " + shq(marker(root, "review-ready")));
		const steps: Step[] = [
			contractPlan(t05Lanes("version:"), { contract: ACCEPT, workers: t05Workers }),
			{ task: ["storm-implementer"], as: "T5B1", say: `E2E-CHILD-SH ${b64(b1)}` },
			{ task: ["storm-quick"], as: "T5A1", say: `E2E-CHILD-SH ${b64(a1)}`, after: 'round="2/4"' },
			{ task: ["storm-explorer"], as: "T5C", say: `E2E-CHILD-READ ${FACT_FILE}\nE2E-CHILD-CLAIM ${TRACKED_CLAIM}`, after: 'round="2/4"' },
			// No verdict directive: the fake reviewer's default is `incorrect`, which opens round 3.
			{ task: ["storm-reviewer"], as: "T5Rev1", after: 'round="2/4"' },
			// A's accepted result is already bound to B v1. B v2 starts only after A settled: the approved capability
			// makes two exec-capable shared writers exclusive, so a concurrent late A attempt would be an unlawful
			// schedule, not a race the run should admit. B v2 replaces the accepted input and must reopen A.
			{ task: ["storm-implementer"], as: "T5B2", say: `E2E-CHILD-SH ${b64(b2)}`, after: 'round="3/4"' },
			// A downstream review is attempted, not required: a valid S2 implementation may refuse or wait for it
			// because a-consume's evidence is invalid. Baseline admits it and can still verify.
			{ task: ["storm-reviewer"], as: "T5Rev2", say: `E2E-CHILD-VERDICT correct E2E-CHILD-SH ${b64(reviewWaits)}`, after: 'round="4/4"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const { run, from } = await runOf(rpc, files, startRun(steps, 4));
				const report = await reportOf(rpc, run.runId, from);
				const pending = pendingLanes(run, report);
				const bOutput = readProject("b-output.txt");
				const aReport = readProject("a-report.txt");
				const snapshot = readProject("a-input-snapshot.txt");
				const quickAgents = agentRows(run, "quick");
				const explorerAgents = agentRows(run, "explorer");
				const implementers = agentRows(run, "implementer");
				const laneNames = lanesWithSpawn(run);
				const aSpawns = run.spawns.filter(spawn => spawn.lane === "a-consume" && spawn.outcome !== "blocked");
				const b1Seen = children(llm).some(user => user.includes(b64(b1)));
				const a1Seen = children(llm).some(user => user.includes(b64(a1)));
				const reviewAttempts = children(llm).filter(user => user.includes(b64(reviewWaits))).length;
				const wire = { b: resultIds(run, "b-produce"), a: resultIds(run, "a-consume"), aDeps: depsOf(run, "a-consume") };
				const bRow = resultOf(run, "b-result");
				const aRow = resultOf(run, "a-result");
				const cRow = resultOf(run, "c-answer");
				const claimSeen = children(llm).some(user => user.includes(TRACKED_CLAIM));
				const tracked = readProject(TRACKED_FILE);
				const rows = `b=${resultRowText(bRow)} a=${resultRowText(aRow)} c=${resultRowText(cRow)}`;
				const aNeeds = aRow?.consumed?.find(input => input.id === "b-result");
				const official =
					bRow?.state === "accepted" && bRow.lane === "b-produce" && typeof bRow.contentVersion === "string" &&
					aRow?.state === "unmet" && aRow.lane === "a-consume" && typeof aRow.attemptId === "string" && aRow.attemptId.includes("T5A10") &&
					aNeeds !== undefined && aNeeds.version !== bRow.contentVersion && typeof aNeeds.version === "string" && aNeeds.version !== "" &&
					cRow?.state === "accepted" && cRow.lane === "c-independent" && typeof cRow.contentVersion === "string" &&
					explorerAgents.length === 1 && aSpawns.length === 1;
				const closeoutOpen = closeoutKeepsOpen(aRow, report);
				observationOf("T05", run, report);
				check("T05: the plan persisted all four native lanes", run.plan?.lanes.length === 4, JSON.stringify(run.plan?.lanes.map(lane => lane.name)));
				// The downstream review is only attempted: a valid S2 implementation may block it while A is invalid.
				check(
					"T05: the producing, consuming and independent lanes were bound to real native spawns",
					["b-produce", "a-consume", "c-independent"].every(name => laneNames.includes(name)),
					JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.outcome, spawn.lane])),
				);
				check(
					"T05: B produced v1 then v2 and A consumed v1",
					markerExists(root, "b-v1") && markerExists(root, "b-v2") && markerExists(root, "a-v1") && bOutput.includes("version: v2") && snapshot.includes("version: v1"),
					JSON.stringify({ bOutput, snapshot: snapshot.trim(), markers: ["b-v1", "b-v2", "a-v1"].map(name => [name, markerExists(root, name)]) }),
				);
				check(
					"T05: A's accepted result was bound to B v1, then B v2 replaced the input",
					markerExists(root, "a-v1") && markerExists(root, "b-v1") && markerExists(root, "b-v2") &&
						aReport.includes("b-version: v1") && snapshot.includes("version: v1") && bOutput.includes("version: v2") &&
						quickAgents.length === 1 && aSpawns.length === 1,
					JSON.stringify({ aReport: aReport.trim(), snapshot: snapshot.trim(), bOutput: bOutput.trim(), quick: quickAgents.map(agent => [agent.id, agent.state, agent.requests]), aSpawns: aSpawns.map(spawn => [spawn.spawnKey, spawn.outcome]) }),
				);
				check(
					"T05: B, A and C reached real child requests",
					b1Seen && a1Seen && implementers.length === 2 && explorerAgents.length === 1 && quickAgents.length === 1,
					JSON.stringify({ children: children(llm).length, quick: quickAgents.map(agent => [agent.state, agent.requests]), implementers: implementers.length, explorer: explorerAgents.map(agent => [agent.state, agent.requests, agent.lastWorkFailed]), reviewAttempts }),
				);
				check(
					"T05: C settled as an independent lane",
					(bRow === undefined ? !pending.includes("c-independent") : cRow?.state === "accepted") &&
						explorerAgents.some(agent => agent.state !== "running" && agent.requests > 0 && agent.lastWorkFailed !== true),
					JSON.stringify({ pending, rows, explorer: explorerAgents }),
				);
				if (!wire.b.length && !wire.a.length) {
					note(
						"T05 baseline technical limit: the validated run plan dropped lane.results/dependsOn entirely " +
							`(b-produce results=${JSON.stringify(wire.b)}, a-consume results=${JSON.stringify(wire.a)}, dependsOn=${JSON.stringify(wire.aDeps)}); only native lanes/workers were admitted. ` +
							"Native behavior was still exercised; result-version invalidation had no persisted contract to evaluate.",
					);
				}
				reproduction(
					"the run ended done/verified while A's accepted report names replaced B v1",
					run.status === "done" && run.endReason === "verified" && !pending.includes("a-consume") && aReport.includes("b-version: v1") && bOutput.includes("version: v2"),
					`run=${run.runId} status=${run.status} endReason=${run.endReason} pending=[${pending.join(",")}] rows=${rows} aReport=${JSON.stringify(aReport.trim())} bOutput=${JSON.stringify(bOutput.trim())}`,
				);
				expectation(
					"A is unfinished after B v2 replaced the input its accepted result consumed; C stays accepted from its cited source; no downstream child is required",
					official && claimSeen && tracked.trim() === TRACKED_TEXT.trim() && run.status !== "done" && run.endReason !== "verified" && closeoutOpen,
					`run=${run.runId} status=${run.status} endReason=${run.endReason} turns=${run.turns}/${run.maxRounds} pending=[${pending.join(",")}] reviewAttempts=${reviewAttempts} claimSeen=${claimSeen} tracked=${JSON.stringify(tracked.trim())} closeoutOpen=${closeoutOpen} rows=${rows}`,
				);
				if (ACCEPT) {
					check(
						"T05 accept: official rows keep B current, leave A unmet on its older consumed version, and accept independent C",
						official,
						rows,
					);
					check(
						"T05 accept: the final ledger keeps a-result open and the closeout is a whole card",
						closeoutOpen,
						`reason=${JSON.stringify(aRow?.reason ?? "")} reportTail=${JSON.stringify(report.slice(-500))}`,
					);
					check(
						"T05 accept: the explorer received and cited the tracked line",
						claimSeen && tracked.trim() === TRACKED_TEXT.trim(),
						JSON.stringify({ claimSeen, tracked: tracked.trim() }),
					);
					check(
						"T05 accept: the plan persists the result ids and A's dependency on B",
						wire.b.includes("b-result") && wire.a.includes("a-result") && wire.aDeps.some(dep => dep.lane === "b-produce" && dep.need === "result"),
						JSON.stringify(wire),
					);
				}
			});
		} finally {
			cleanupProject("b-output.txt", "a-report.txt", "a-input-snapshot.txt");
		}
	});

	await suite.step("T05 retry: A fails its own result check against B v2; the old success stays unusable", async () => {
		const root = markerDir("t05-retry");
		const llm = new LlmCursor(env);
		const b1 = bWriteV1(root);
		const a1 = aConsumeV1(root);
		const b2 = bWriteV2Direct(root);
		const retry = aRetryRejected(root);
		const reviewWaits = waitFor(root, ["b-v2", "a-retry-rejected"], "printf 'ready\\n' > " + shq(marker(root, "retry-review-ready")));
		const steps: Step[] = [
			contractPlan(t05Lanes("version:"), { contract: ACCEPT, workers: t05Workers }),
			{ task: ["storm-implementer"], as: "T5RB1", say: `E2E-CHILD-SH ${b64(b1)}` },
			{ task: ["storm-quick"], as: "T5RA1", say: `E2E-CHILD-SH ${b64(a1)}`, after: 'round="2/5"' },
			{ task: ["storm-explorer"], as: "T5RC", say: `E2E-CHILD-READ ${FACT_FILE}\nE2E-CHILD-CLAIM ${TRACKED_CLAIM}`, after: 'round="2/5"' },
			{ task: ["storm-reviewer"], as: "T5RRev1", after: 'round="2/5"' },
			{ task: ["storm-implementer"], as: "T5RB2", say: `E2E-CHILD-SH ${b64(b2)}`, after: 'round="3/5"' },
			// B v2 is current now; this retry is admissible and really runs against v2, but its own result is rejected.
			{ task: ["storm-quick"], as: "T5RA2", say: `E2E-CHILD-SH ${b64(retry)}`, after: 'round="4/5"' },
			{ task: ["storm-reviewer"], as: "T5RRev2", say: `E2E-CHILD-VERDICT correct E2E-CHILD-SH ${b64(reviewWaits)}`, after: 'round="5/5"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const { run, from } = await runOf(rpc, files, startRun(steps, 5));
				const report = await reportOf(rpc, run.runId, from);
				const pending = pendingLanes(run, report);
				const aReport = readProject("a-report.txt");
				const bOutput = readProject("b-output.txt");
				const quickAgents = agentRows(run, "quick");
				const explorerAgents = agentRows(run, "explorer");
				const aSpawns = run.spawns.filter(spawn => spawn.lane === "a-consume" && spawn.outcome !== "blocked");
				const retrySeen = children(llm).some(user => user.includes(b64(retry)));
				const reviewAttempts = children(llm).filter(user => user.includes(b64(reviewWaits))).length;
				const wire = { b: resultIds(run, "b-produce"), a: resultIds(run, "a-consume") };
				const bRow = resultOf(run, "b-result");
				const aRow = resultOf(run, "a-result");
				const cRow = resultOf(run, "c-answer");
				const claimSeen = children(llm).some(user => user.includes(TRACKED_CLAIM));
				const tracked = readProject(TRACKED_FILE);
				const rows = `b=${resultRowText(bRow)} a=${resultRowText(aRow)} c=${resultRowText(cRow)}`;
				const aNeeds = aRow?.consumed?.find(input => input.id === "b-result");
				const official =
					bRow?.state === "accepted" && bRow.lane === "b-produce" && typeof bRow.contentVersion === "string" &&
					aRow?.state === "unmet" && aRow.lane === "a-consume" && typeof aRow.attemptId === "string" && aRow.attemptId.includes("T5RA2") &&
					aNeeds !== undefined && aNeeds.version === bRow.contentVersion &&
					cRow?.state === "accepted" && cRow.lane === "c-independent" &&
					explorerAgents.length === 1 && aSpawns.length === 2;
				const closeoutOpen = closeoutKeepsOpen(aRow, report);
				observationOf("T05-retry", run, report);
				check(
					"T05 retry: A's first success and its retry both ran; the retry consumed B v2",
					markerExists(root, "a-v1") && retrySeen && markerExists(root, "a-retry-rejected") && aReport.includes("b-version: v2") && aReport.includes("result: rejected") && bOutput.includes("version: v2") && quickAgents.length === 2 && aSpawns.length === 2,
					JSON.stringify({ aReport: aReport.trim(), quick: quickAgents.map(agent => [agent.id, agent.state, agent.requests]), aSpawns: aSpawns.map(spawn => [spawn.spawnKey, spawn.outcome]), retrySeen }),
				);
				check(
					"T05 retry: C stayed independent and settled",
					(bRow === undefined ? !pending.includes("c-independent") : cRow?.state === "accepted") &&
						explorerAgents.some(agent => agent.state !== "running" && agent.requests > 0 && agent.lastWorkFailed !== true),
					JSON.stringify({ pending, rows, explorer: explorerAgents }),
				);
				if (!wire.b.length && !wire.a.length) {
					note(
						"T05 retry baseline technical limit: the run plan persisted no result ids " +
							`(b-produce results=${JSON.stringify(wire.b)}, a-consume results=${JSON.stringify(wire.a)}); native retries ran, but the result check itself could not be evaluated.`,
					);
				}
				reproduction(
					"the failed A retry and the old A success still produced a verified run",
					run.status === "done" && run.endReason === "verified" && !pending.includes("a-consume") && aReport.includes("result: rejected"),
					`run=${run.runId} status=${run.status} endReason=${run.endReason} pending=[${pending.join(",")}] rows=${rows} aReport=${JSON.stringify(aReport.trim())}`,
				);
				expectation(
					"A's retry failed against B v2 and the stale A success did not complete A; C stays accepted",
					official && claimSeen && tracked.trim() === TRACKED_TEXT.trim() && run.status !== "done" && run.endReason !== "verified" && closeoutOpen,
					`run=${run.runId} status=${run.status} endReason=${run.endReason} turns=${run.turns}/${run.maxRounds} pending=[${pending.join(",")}] reviewAttempts=${reviewAttempts} claimSeen=${claimSeen} tracked=${JSON.stringify(tracked.trim())} closeoutOpen=${closeoutOpen} rows=${rows}`,
				);
				if (ACCEPT) {
					check(
						"T05 retry accept: A's retry row consumed the current B v2 but stayed unmet; C is accepted",
						official,
						rows,
					);
					check(
						"T05 retry accept: the final ledger keeps a-result open and the closeout is a whole card",
						closeoutOpen,
						`reason=${JSON.stringify(aRow?.reason ?? "")} reportTail=${JSON.stringify(report.slice(-500))}`,
					);
					check(
						"T05 retry accept: the explorer received and cited the tracked line",
						claimSeen && tracked.trim() === TRACKED_TEXT.trim(),
						JSON.stringify({ claimSeen, tracked: tracked.trim() }),
					);
				}
			});
		} finally {
			cleanupProject("b-output.txt", "a-report.txt", "a-input-snapshot.txt");
		}
	});

	await suite.step("T05 control: progress edited only after A settles does not reopen A", async () => {
		const root = markerDir("t05-control");
		const llm = new LlmCursor(env);
		const b = controlB(root);
		const a = controlA(root);
		const reviewWaits = waitFor(root, ["control-a"], "printf 'ready\\n' > " + shq(marker(root, "control-review-ready")));
		const lanes = t05Lanes("version: control", true);
		const progressLanes: ContractLane[] = lanes.map(lane => (lane.name === "b-produce" ? { ...lane, progress: "B result unchanged; status only" } : lane));
		const steps: Step[] = [
			contractPlan(lanes, { contract: ACCEPT, workers: t05Workers }),
			{ task: ["storm-implementer"], as: "T5CB", say: `E2E-CHILD-SH ${b64(b)}` },
			// A and C run first; the run only reaches round 3 after they settle and the review lane is still pending.
			{ task: ["storm-quick"], as: "T5CA", say: `E2E-CHILD-SH ${b64(a)}`, after: 'round="2/3"' },
			{ task: ["storm-explorer"], as: "T5CC", say: `E2E-CHILD-READ ${FACT_FILE}\nE2E-CHILD-CLAIM ${TRACKED_CLAIM}`, after: 'round="2/3"' },
			// The progress edit is submitted only now, after A's settled result is already in the run.
			{ ...contractPlan(progressLanes, { contract: ACCEPT, workers: t05Workers }), after: 'round="3/3"' },
			{ task: ["storm-reviewer"], as: "T5CRev", say: `E2E-CHILD-VERDICT correct E2E-CHILD-SH ${b64(reviewWaits)}`, after: 'round="3/3"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const { run, from } = await runOf(rpc, files, startRun(steps, 3));
				const report = await reportOf(rpc, run.runId, from);
				const pending = pendingLanes(run, report);
				const quick = agentRows(run, "quick");
				const aSpawns = run.spawns.filter(spawn => spawn.lane === "a-consume" && spawn.outcome !== "blocked");
				const progress = run.plan?.lanes.find(lane => lane.name === "b-produce")?.progress;
				const log = llm.all();
				const aAt = log.findIndex(entry => entry.who === "child" && entry.lastUser.includes(b64(a)));
				const progressAt = log.findIndex(entry => entry.who === "main" && JSON.stringify(entry.decision.args ?? null).includes("B result unchanged"));
				const progressAfterA = aAt >= 0 && progressAt > aAt && log[progressAt]?.lastUser.includes('round="3/3"') === true;
				const wire = { b: resultIds(run, "b-produce"), a: resultIds(run, "a-consume") };
				const bRow = resultOf(run, "control-b-result");
				const aRow = resultOf(run, "control-a-result");
				const cRow = resultOf(run, "control-c-answer");
				const claimSeen = children(llm).some(user => user.includes(TRACKED_CLAIM));
				const tracked = readProject(TRACKED_FILE);
				const rows = `b=${resultRowText(bRow)} a=${resultRowText(aRow)} c=${resultRowText(cRow)}`;
				const aNeeds = aRow?.consumed?.find(input => input.id === "control-b-result");
				const official =
					bRow?.state === "accepted" && bRow.lane === "b-produce" &&
					aRow?.state === "accepted" && aRow.lane === "a-consume" &&
					aNeeds !== undefined && aNeeds.version === bRow.contentVersion &&
					cRow?.state === "accepted" && cRow.lane === "c-independent";
				observationOf("T05-control", run, report);
				check(
					"T05 control: B stayed unchanged and A wrote its accepted report before the progress edit",
					readProject("control-b.txt").includes("version: control") && readProject("control-a.txt").includes("result: accepted") && markerExists(root, "control-a") && progress === "B result unchanged; status only",
					JSON.stringify({ progress, b: readProject("control-b.txt").trim(), a: readProject("control-a.txt").trim() }),
				);
				check(
					"T05 control: A remained complete and was invoked once after the progress edit",
					progressAfterA && quick.length === 1 && quick[0]?.requests !== undefined && quick[0].requests > 0 && aSpawns.length === 1 &&
						aRow?.state === "accepted" && aNeeds?.version === bRow?.contentVersion,
					JSON.stringify({ progressAfterA, aAt, progressAt, quick: quick.map(agent => [agent.id, agent.state, agent.requests]), aSpawns: aSpawns.map(spawn => spawn.spawnKey), pending, rows }),
				);
				check(
					"T05 control: the run verified with no unfinished lane",
					run.status === "done" && run.endReason === "verified" && official && pending.length === 0 && claimSeen && tracked.trim() === TRACKED_TEXT.trim(),
					`run=${run.runId} status=${run.status} endReason=${run.endReason} pending=[${pending.join(",")}] claimSeen=${claimSeen} tracked=${JSON.stringify(tracked.trim())} rows=${rows}`,
				);
				if (ACCEPT) {
					check(
						"T05 control accept: the unchanged B version left A accepted and C accepted",
						official,
						rows,
					);
					check(
						"T05 control accept: the explorer received and cited the tracked line",
						claimSeen && tracked.trim() === TRACKED_TEXT.trim(),
						JSON.stringify({ claimSeen, tracked: tracked.trim() }),
					);
				}
				if (!wire.b.length && !wire.a.length) {
					note("T05 control baseline technical limit: the progress-only replan persisted no result ids; the native control still shows one A invocation.");
				}
			});
		} finally {
			cleanupProject("control-b.txt", "control-a.txt");
		}
	});

	await suite.step("T04 fixture: an approved, really failing implementer model", async () => {
		writeFileSync(modelsFile, modelsYml(env.port, { fake: TEAM_PROVIDERS.fake, fake2: TEAM_PROVIDERS.fake2, fake3: [{ id: "quota-out", cost: price(50, 50) }] }));
		const active = ownedFiles();
		active.editConfig(config => {
			config.roles.implementer = { ...config.roles.implementer!, models: ["fake3/quota-out"] };
		});
		await session(choose(APPROVE), async (rpc, files) => {
			await rpc.prompt("/storm");
			const models = files.config().roles.implementer?.models ?? [];
			check("T04 fixture: the failing implementer model is approved", models.length === 1 && models[0] === "fake3/quota-out", JSON.stringify(models));
			rpc.answer = choose(LABEL.autoOff);
			await rpc.prompt("/storm auto");
			await waitAuto(files, "off");
		});
	});

	await suite.step("T04: A survives B's failure; dropping B's lane must not become a normal completion", async () => {
		const llm = new LlmCursor(env);
		const steps: Step[] = [
			contractPlan(t04InitialLanes(), { contract: ACCEPT, workers: { implementer: 1, explorer: 1, reviewer: 1 } }),
			{ task: ["storm-explorer"], as: "T4DA", say: `E2E-CHILD-READ ${FACT_FILE}\nE2E-CHILD-CLAIM ${TRACKED_CLAIM}` },
			// No directive: the child's first request hits the approved 429 model and the native job fails.
			{ task: ["storm-implementer"], as: "T4DB" },
			{ ...contractPlan(t04Replan(false), { contract: ACCEPT, workers: { explorer: 1, reviewer: 1 } }), after: 'round="2/4"' },
			// The replan and the last required lane settle in round 2, so the run can reach its natural end.
			{ task: ["storm-reviewer"], as: "T4DRev", say: "E2E-CHILD-VERDICT correct", after: 'round="2/4"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const { run, frames, from } = await runOf(rpc, files, startRun(steps, 4));
				const report = await reportOf(rpc, run.runId, from);
				const pending = pendingLanes(run, report);
				const replanFrame = frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm").at(-1);
				const replanReply = replanFrame === undefined ? "" : resultText(replanFrame);
				const replanOutcome = replanFrame?.result?.details?.outcome;
				const replanApplied = replanOutcome === "ok" || replanOutcome === "approved";
				const explorer = agentRows(run, "explorer");
				const implementers = agentRows(run, "implementer");
				const bAttempts = llm.of("child").filter(entry => entry.model === "quota-out");
				const bLaneSpawns = run.spawns.filter(spawn => spawn.lane === "b-write" && spawn.outcome !== "blocked");
				const aLaneSpawns = run.spawns.filter(spawn => spawn.lane === "a-read" && spawn.outcome !== "blocked");
				const finalPlan = run.plan?.lanes.map(lane => lane.name) ?? [];
				const removed = !finalPlan.includes("b-write");
				const reviewDeps = depsOf(run, "review");
				const noDangling = !reviewDeps.some(dep => dep.lane === "b-write");
				const bRow = resultOf(run, "b-result");
				const aRow = resultOf(run, "a-answer");
				const claimSeen = children(llm).some(user => user.includes(TRACKED_CLAIM));
				const tracked = readProject(TRACKED_FILE);
				const rows = `b=${resultRowText(bRow)} a=${resultRowText(aRow)}`;
				const closeoutOpen = closeoutKeepsOpen(bRow, report);
				observationOf("T04-drop", run, report);
				check(
					"T04 drop: A ran once and stayed intact while B failed",
					explorer.length === 1 && explorer[0]?.requests !== undefined && explorer[0].requests > 0 && explorer[0].lastWorkFailed !== true && aLaneSpawns.length === 1,
					JSON.stringify({ explorer: explorer.map(agent => [agent.id, agent.state, agent.requests]), aLaneSpawns: aLaneSpawns.map(spawn => spawn.spawnKey) }),
				);
				check(
					"T04 drop: B's real child attempt hit the approved failing model",
					bAttempts.length >= 1 && implementers.length === 1 && implementers[0]?.lastWorkFailed === true && bLaneSpawns.length === 1,
					JSON.stringify({ who: bAttempts.map(entry => entry.who), implementers: implementers.map(agent => [agent.id, agent.state, agent.requests, agent.lastWorkFailed]), bLaneSpawns: bLaneSpawns.map(spawn => [spawn.spawnKey, spawn.outcome]) }),
				);
				check(
					"T04 drop: the replan really removed b-write and did not write B's file",
					!finalPlan.includes("b-write") && finalPlan.includes("a-read") && finalPlan.includes("review") && !existsSync(join(env.project, "b-output.txt")),
					JSON.stringify({ finalPlan, bOutput: existsSync(join(env.project, "b-output.txt")) }),
				);
				reproduction(
					"an otherwise valid removal ended normally with B's worker failed and no b-result identity",
					removed && noDangling && bRow === undefined && run.endReason === "no-changes" && pending.length === 0 && implementers[0]?.lastWorkFailed === true && !existsSync(join(env.project, "b-output.txt")),
					`run=${run.runId} status=${run.status} endReason=${run.endReason} pending=[${pending.join(",")}] finalPlan=${finalPlan.join(",")} rows=${rows} replan=${JSON.stringify(replanReply.slice(-400))}`,
				);
				// A valid implementation may reject the removal explicitly because b-result is still required, accept it
				// while preserving the obligation, or accept the plan while keeping the old lane. A generic rejection,
				// timeout, or normal end is not acceptance. The submitted replan has no dangling edge.
				const keptObligation = !removed && replanApplied && bRow !== undefined && bRow.state === "unmet";
				const rejectedForRequirement =
					!removed &&
					!replanApplied &&
					bRow !== undefined &&
					(replanReply.includes("b-result") || /필수\s*결과|required\s+(?:result|requirement)|unmet\s+(?:result|requirement)|missing\s+(?:result|requirement)|요구\s*결과/i.test(replanReply));
				const orphanKept = removed && replanApplied && bRow !== undefined && bRow.state === "unmet" && bRow.lane === undefined && noDangling;
				expectation(
					"the replan never drops b-result silently: it is rejected for the unmet requirement or its official identity survives with A intact",
					!["verified", "no-changes", "unreviewed", "no-reviewer"].includes(run.endReason ?? "") &&
						explorer.length === 1 && aLaneSpawns.length === 1 &&
						aRow?.state === "accepted" && closeoutOpen && claimSeen && tracked.trim() === TRACKED_TEXT.trim() &&
						(removed ? orphanKept : keptObligation || rejectedForRequirement),
					`run=${run.runId} status=${run.status} endReason=${run.endReason} turns=${run.turns}/${run.maxRounds} pending=[${pending.join(",")}] removed=${removed} replanOutcome=${replanOutcome ?? "?"} rows=${rows} closeoutOpen=${closeoutOpen} claimSeen=${claimSeen} tracked=${JSON.stringify(tracked.trim())} reviewDeps=${JSON.stringify(reviewDeps)} replan=${JSON.stringify(replanReply.slice(-500))}`,
				);
				if (ACCEPT) {
					check(
						"T04 drop accept: the removed lane kept b-result as an unmet orphan while A stayed accepted",
						orphanKept && aRow?.state === "accepted" && typeof aRow.attemptId === "string",
						rows,
					);
					check(
						"T04 drop accept: the final ledger keeps the orphaned b-result open and the closeout is a whole card",
						closeoutOpen,
						`reason=${JSON.stringify(bRow?.reason ?? "")} reportTail=${JSON.stringify(report.slice(-500))}`,
					);
					check(
						"T04 drop accept: the failed B row records the exhausted native retry and no replacement spawn",
						bRow?.remedy === "retry" && (bRow?.reason ?? "").includes("재시도") &&
							implementers.length === 1 && bLaneSpawns.length === 1,
						`${rows} implementers=${implementers.length} bSpawns=${bLaneSpawns.length}`,
					);
				}
			});
		} finally {
			cleanupProject("b-output.txt");
		}
	});

	await suite.step("T04: B's requirement transfers under the same result id and only repairs B", async () => {
		const root = markerDir("t04-repair");
		const llm = new LlmCursor(env);
		const repair = quickRepair(root);
		const steps: Step[] = [
			contractPlan(t04InitialLanes(), { contract: ACCEPT, workers: { implementer: 1, explorer: 1, quick: 1, reviewer: 1 } }),
			{ task: ["storm-explorer"], as: "T4TA", say: `E2E-CHILD-READ ${FACT_FILE}\nE2E-CHILD-CLAIM ${TRACKED_CLAIM}` },
			{ task: ["storm-implementer"], as: "T4TB" },
			{ ...contractPlan(t04Replan(true), { contract: ACCEPT, workers: { explorer: 1, quick: 1, reviewer: 1 } }), after: 'round="2/4"' },
			{ task: ["storm-quick"], as: "T4TRepair", say: `E2E-CHILD-SH ${b64(repair)}`, after: 'round="2/4"' },
			{ task: ["storm-reviewer"], as: "T4TRev", say: "E2E-CHILD-VERDICT correct", after: 'round="3/4"' },
		];
		try {
			await session(cancelAll, async (rpc, files) => {
				const { run, from } = await runOf(rpc, files, startRun(steps, 4));
				const report = await reportOf(rpc, run.runId, from);
				const pending = pendingLanes(run, report);
				const explorer = agentRows(run, "explorer");
				const quick = agentRows(run, "quick");
				const implementers = agentRows(run, "implementer");
				const bAttempts = llm.of("child").filter(entry => entry.model === "quota-out");
				const finalPlan = run.plan?.lanes.map(lane => lane.name) ?? [];
				const ids = resultIds(run, "b-repair");
				const repairDeps = depsOf(run, "review");
				const bRow = resultOf(run, "b-result");
				const aRow = resultOf(run, "a-answer");
				const claimSeen = children(llm).some(user => user.includes(TRACKED_CLAIM));
				const tracked = readProject(TRACKED_FILE);
				const rows = `b=${resultRowText(bRow)} a=${resultRowText(aRow)}`;
				const expectedIdentity = resultContractIdentity(
					requiredResult("b-result", "change", "b-output.txt holds the accepted B result", { path: "b-output.txt", contains: "b-status: ok" }),
				);
				const official =
					bRow?.state === "accepted" && bRow.lane === "b-repair" && bRow.identity === expectedIdentity &&
					typeof bRow.attemptId === "string" && bRow.attemptId.includes("T4TRepair") && typeof bRow.contentVersion === "string" &&
					aRow?.state === "accepted" && aRow.lane === "a-read" && typeof aRow.attemptId === "string" &&
					explorer.length === 1 && quick.length === 1 && implementers.length === 1 && implementers[0]?.lastWorkFailed === true;
				observationOf("T04-repair", run, report);
				check(
					"T04 repair: B failed for real, then the independent quick lane repaired B",
					bAttempts.length >= 1 && implementers.length === 1 && implementers[0]?.lastWorkFailed === true && quick.length === 1 && quick[0]?.requests !== undefined && quick[0].requests > 0 && readProject("b-output.txt").includes("b-status: ok"),
					JSON.stringify({ bAttempts: bAttempts.length, implementers: implementers.map(agent => [agent.id, agent.lastWorkFailed]), quick: quick.map(agent => [agent.id, agent.state, agent.requests]), bOutput: readProject("b-output.txt").trim() }),
				);
				check(
					"T04 repair: only b-write was replaced; A stayed intact and was not rerun",
					!finalPlan.includes("b-write") && finalPlan.includes("a-read") && finalPlan.includes("b-repair") && finalPlan.includes("review") &&
						explorer.length === 1 && explorer[0]?.requests !== undefined && explorer[0].requests > 0 &&
						aRow?.state === "accepted" && quick.length === 1,
					JSON.stringify({ finalPlan, explorer: explorer.map(agent => [agent.id, agent.state, agent.requests]), quick: quick.map(agent => [agent.id, agent.state, agent.requests]), ids, rows }),
				);
				check(
					"T04 repair: the run verified with no unfinished lane",
					run.status === "done" && run.endReason === "verified" && official && pending.length === 0 && claimSeen && tracked.trim() === TRACKED_TEXT.trim(),
					`run=${run.runId} status=${run.status} endReason=${run.endReason} pending=[${pending.join(",")}] claimSeen=${claimSeen} tracked=${JSON.stringify(tracked.trim())} rows=${rows} report=${report.slice(-500)}`,
				);
				if (!ids.length) {
					note(
						"T04 baseline technical limit: the initial and repaired plans persisted no b-result id " +
							`(b-repair results=${JSON.stringify(ids)}, final lanes=${JSON.stringify(finalPlan)}); the native lane-level transfer ran and verified, but same-contract transfer could not be expressed or observed.`,
					);
				}
				if (ACCEPT) {
					check(
						"T04 accept: the repair keeps B's exact requirement id, identity, new lane and review dependency",
						ids.includes("b-result") && repairDeps.some(dep => dep.lane === "b-repair" && dep.need === "result") &&
							bRow?.identity === expectedIdentity && bRow.lane === "b-repair" && bRow.state === "accepted",
						JSON.stringify({ ids, repairDeps, expectedIdentity, rows }),
					);
					check(
						"T04 accept: only B was rerun and its repair attempt produced the accepted content",
						official,
						rows,
					);
					check(
						"T04 accept: the explorer received and cited the tracked line",
						claimSeen && tracked.trim() === TRACKED_TEXT.trim(),
						JSON.stringify({ claimSeen, tracked: tracked.trim() }),
					);
				}
			});
		} finally {
			cleanupProject("b-output.txt");
		}
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
	if (observations.length) console.log(`OBSERVATIONS\n${observations.map(line => `- ${line}`).join("\n")}`);
	code = suite.finish();
}
process.exit(code);
