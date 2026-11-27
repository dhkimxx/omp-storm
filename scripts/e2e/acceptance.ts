#!/usr/bin/env bun
/**
 * Baseline T01 and later T06 acceptance over the real OMP + scripted provider.
 *
 * Baseline (default): the pre-S1 plan shape for the original binary (the current fresh-plan boundary refuses a
 * deliverable lane without results), the profile's approved team, and a real run. T01's first half is the
 * reproduction: an existing uncommitted `report.json` plus a worker that ends without writing. Its expected
 * official result is that the lane is incomplete, so the run must not close as done/verified. The second half is the
 * control: a read-only query that reads the same file needs no diff and no reviewer. A designed failure is printed
 * with the exact run id, status/end reason and bytes; it is not weakened to make the suite green.
 *
 * Contract (`E2E_CONTRACT=1`, after S1): the same scenarios submit the optional `lane.results` wire through
 * `contract-fixture.ts`, and assert the official `RunRecord.results` obligations
 * (`id`, `lane`, `state`, `reason`, host-owned `attemptId`) and the unresolved ids/reasons in `/storm status`.
 * Use only after the product change; baseline itself must not require these fields to exist.
 *
 * T06 uses a qualitative prose criterion (no `path`/`contains`/`check`): submission alone stays `reviewable`, an
 * independent approved reviewer on the current tree plus a configured PASS check on the same digest accepts it, an
 * incorrect verdict leaves it `unmet`, a later change invalidates the latest verdict, and a failed latest check keeps
 * an accepted obligation from becoming a verified run. A missing latest check is not an intentional host condition
 * here: an approved configured check is started once the gate is otherwise passable. The deterministic regressions
 * are `tests/rounds.test.ts:550` ("a failed, skipped, missing or mismatched check blocks verified"), `:602`
 * ("a configured check with no report blocks a bound review") and `:583` ("a check older than the last file change
 * is stale even when its tree matches"); this file does not claim an E2E for those unreachable conditions.
 *
 * T01c (contract only) is the scoped answer review: a cited prose answer S1 cannot match mechanically stays
 * `reviewable`. A generic tree-only `correct` from the approved reviewer must not accept it; in a second run the
 * scripted director writes a plain review task once Storm's round says answers wait for review, Storm itself appends
 * the packet to the approved reviewer's task (the director never forwards an answer or a receipt), and the reviewer
 * copies id/receipt/citation from the packet it actually received into `results`. The receipt is never hardcoded: the
 * fixture recomputes it from the persisted row (run, result id, host attempt, content version) with the pure
 * `answerReviewReceipt` oracle and requires the reviewer's received packet, its yield and its stored review log to
 * name exactly that receipt, the cited anchor and the producer's exact answer text before the run may verify.
 *
 * T01d-T01f (contract only) remove size limits from that path: nine reviewable answers settle in one reviewer turn
 * under a stated 30-round limit, an answer omp delivers as a preview is judged on the whole output, and a prose
 * answer that states the required value beside other numbers goes to review instead of failing.
 *
 * Every wait is for a named native state; a timeout is a harness failure, never evidence that an admission was safe.
 *
 * Usage:
 *   E2E_PORT=18781 E2E_WORK=/tmp/storm-e2e-acceptance-18781 E2E_KEEP=1 \
 *     bun scripts/e2e/acceptance.ts
 *   E2E_CONTRACT=1 ...   (implementation pass only)
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAutoDelegationChoice } from "../../src/approval/auto.ts";
import { APPROVE } from "../../src/proposals/present.ts";
import { answerReviewReceipt } from "../../src/runtime/answer-review.ts";
import { reviewEvidenceOf } from "../../src/runtime/review.ts";
import type { AgentEntry, RunRecord, RunSummary } from "../../src/types.ts";
import { contractPlan, type ContractLane, type LaneResultKind, requiredResult } from "./contract-fixture.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";
import {
	type Answer,
	cancelAll,
	choose,
	customMessage,
	LlmCursor,
	type LlmEntry,
	linkPlugin,
	modelsYml,
	prepare,
	PROFILE_CONFIG,
	stormRecords,
	ROOT,
	Rpc,
	type Step,
	StormFiles,
	Suite,
	startFakeLlm,
	TEAM_PROVIDERS,
	until,
} from "./harness.ts";

/** The label Storm offers for turning automatic delegation off; not exported by the plugin. */
const AUTO_OFF = "자동 위임 끄기";
const MAIN = "fake/general-b";
const REPORT = "report.json";
const REPORT_CONTENT = '{\n  "total": 42,\n  "source": "user owning this file"\n}\n';
const CONTRACT = process.env.E2E_CONTRACT === "1";
/** The round instruction's words when reviewable answers wait for a reviewer turn (src/runtime/rounds.ts). */
const REVIEW_BATCH_CUE = "waiting for review";
const mode = CONTRACT ? "contract" : "baseline";

interface Observation {
	case: string;
	mode: typeof mode;
	runId: string;
	status: string;
	endReason: string | null;
	turns: number | null;
	detail: string;
}

const env = prepare("storm-e2e-acceptance", 18781);
// The tracked, typed answer fixture the 0.28.0 contract-delivery cases cite (committed, so the tree stays clean).
seedFact(env.project);
const suite = new Suite(`E2E acceptance (${mode})`, env);
const check = suite.check.bind(suite);
/** The one native session whose approved team every case resumes. */
let owned: { id: string; dir: string } | undefined;
const observations: Observation[] = [];
const exitCodes: number[] = [];

/** The owned session's reader for setup code outside a body. */
function ownedFiles(): StormFiles {
	if (owned === undefined) throw new Error("the acceptance fixture session was not created");
	return new StormFiles(env, owned.id);
}

const hash = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12);
const runRequest = (steps: Step[], rounds?: number): string =>
	`/storm E2E-ROUTE ${JSON.stringify({ action: "run", ...(rounds !== undefined ? { rounds } : {}) })} E2E-STEPS ${JSON.stringify(steps)}`;
/**
 * Every plan's lane names get a suite-unique suffix. omp keeps a name the native session has already seen as
 * `<name>-2`, and R4 refuses a deduped key, so a lane name is used once in this session; the checks below find a lane
 * by its base name, which is what the plan's author wrote.
 */
let planSerial = 0;
const planFor = (lanes: readonly ContractLane[], workers?: Record<string, number>): Step => {
	planSerial += 1;
	const renamed = lanes.map(lane => ({ ...lane, name: `${lane.name}-${planSerial}` }));
	return contractPlan(renamed, { contract: CONTRACT, ...(workers !== undefined ? { workers } : {}) });
};
/** Whether a persisted lane is the plan's lane written under its base name (see `planFor`). */
const laneIs = (actual: string | undefined, base: string): boolean => actual === base || (actual !== undefined && actual.startsWith(`${base}-`));

function observe(name: string, run: RunRecord, detail: string): void {
	const results = runResults(run).map(result => `${result.id}:${result.state}${result.attemptId === undefined ? "" : `@${result.attemptId}`}`).join(",");
	const full = results === "" ? detail : `${detail} results=${results}`;
	const item: Observation = { case: name, mode, runId: run.runId, status: run.status, endReason: run.endReason ?? null, turns: run.turns ?? null, detail: full };
	observations.push(item);
	console.log(`     OBSERVE ${name}: ${run.runId} ${run.status}/${run.endReason ?? "?"} turns=${run.turns ?? "?"} · ${full}`);
}

function summaryOf(files: StormFiles, runId: string): RunSummary | undefined {
	return files.index().find(line => line.runId === runId);
}

/** The plan lane as the run record holds it; contract fields are read without making them required by the baseline. */
function laneOf(run: RunRecord, name: string): Record<string, unknown> | undefined {
	const lanes = (run.plan?.lanes ?? []) as unknown as Array<Record<string, unknown>>;
	return lanes.find(lane => typeof lane.name === "string" && laneIs(lane.name, name));
}

/** The planned result wire as persisted; baseline does not store it. */
function plannedResult(run: RunRecord, laneName: string, id: string): Record<string, unknown> | undefined {
	const results = laneOf(run, laneName)?.results;
	if (!Array.isArray(results)) return undefined;
	return results.find((value): value is Record<string, unknown> => value !== null && typeof value === "object" && "id" in value && value.id === id);
}

function hasRequiredResult(run: RunRecord, laneName: string, id: string, kind: LaneResultKind): boolean {
	const results = laneOf(run, laneName)?.results;
	if (!Array.isArray(results)) return false;
	return results.some(value => {
		if (value === null || typeof value !== "object") return false;
		const result = value as Record<string, unknown>;
		return result.id === id && result.kind === kind;
	});
}

type ResultState = "pending" | "unmet" | "reviewable" | "accepted";

/** One named obligation as the run record exposes it; baseline has none. */
interface RunResultWire {
	id: string;
	state: ResultState;
	lane?: string;
	reason?: string;
	attemptId?: string;
}

const RESULT_STATES: Record<string, true> = { pending: true, unmet: true, reviewable: true, accepted: true };

function runResults(run: RunRecord): RunResultWire[] {
	const raw: unknown = run;
	if (typeof raw !== "object" || raw === null || !("results" in raw)) return [];
	const value = raw.results;
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (item === null || typeof item !== "object") return [];
		const row = item as Record<string, unknown>;
		if (typeof row.id !== "string" || row.id === "" || typeof row.state !== "string" || RESULT_STATES[row.state] !== true) return [];
		return [
			{
				id: row.id,
				state: row.state as ResultState,
				...(typeof row.lane === "string" && row.lane !== "" ? { lane: row.lane } : {}),
				...(typeof row.reason === "string" && row.reason !== "" ? { reason: row.reason } : {}),
				...(typeof row.attemptId === "string" && row.attemptId !== "" ? { attemptId: row.attemptId } : {}),
			},
		];
	});
}

function resultFor(run: RunRecord, id: string): RunResultWire | undefined {
	return runResults(run).find(result => result.id === id);
}

/** The persisted row's own submission identity, read without making the contract fields required by the baseline. */
function submissionOf(run: RunRecord, id: string): { attemptId?: string; contentVersion?: string } {
	const raw: unknown = run;
	const rows = typeof raw === "object" && raw !== null && "results" in raw && Array.isArray(raw.results) ? (raw.results as unknown[]) : [];
	const row = rows.find((value): value is Record<string, unknown> => value !== null && typeof value === "object" && (value as Record<string, unknown>).id === id);
	return {
		...(typeof row?.attemptId === "string" ? { attemptId: row.attemptId } : {}),
		...(typeof row?.contentVersion === "string" ? { contentVersion: row.contentVersion } : {}),
	};
}

/** A reviewer child's verdict yield as the provider sent it: the request that made it and its `data`. */
function reviewerYields(entries: readonly LlmEntry[]): Array<{ entry: LlmEntry; data: Record<string, unknown> }> {
	return entries.flatMap(entry => {
		const data = entry.decision.tool === "yield" ? entry.decision.args?.data : undefined;
		if (typeof data !== "object" || data === null || !("overall_correctness" in data)) return [];
		return [{ entry, data: data as Record<string, unknown> }];
	});
}

/** The scoped verdicts a reviewer's stored review log holds, as Storm parsed them. */
function storedScopes(agent: AgentEntry | undefined): { complete: boolean; scopes: Array<{ id: string; receipt: string; citation: string; correct: boolean }> } {
	if (agent === undefined) return { complete: false, scopes: [] };
	const ledger = reviewEvidenceOf(agent);
	return { complete: ledger.complete, scopes: ledger.records.flatMap(record => (record.correct === undefined ? [] : (record.results ?? []))) };
}

/**
 * The host-owned attempt reference must resolve to exactly this native child: `task:<toolCallId>:<childId>` or
 * `job:<jobId>:<childId>`, where the last segment is the admitted spawn key. Prefixes never collide (`Read1` cannot
 * satisfy a `Read10` attempt), and a role/name or a model-provided label is never an attempt reference.
 */
function attemptMatches(attemptId: string | undefined, spawnKey: string | undefined): boolean {
	if (attemptId === undefined || spawnKey === undefined || spawnKey === "") return false;
	const parts = attemptId.split(":");
	return (parts[0] === "task" || parts[0] === "job") && parts.length === 3 && parts[2] === spawnKey;
}

/**
 * The official per-result detail of the session's latest run: `/storm status`. The closeout card carries only the
 * official aggregate (state, counts by cause) and points here; result ids and their reasons are status detail.
 */
async function officialStatusText(rpc: Rpc): Promise<string> {
	const from = rpc.frames.length;
	await rpc.prompt("/storm status");
	return stormRecords(rpc.frames, from).map(record => record.text).join("\n");
}

function gitStatus(): string {
	return Bun.spawnSync(["git", "-C", env.project, "status", "--porcelain", "--untracked-files=all"]).stdout.toString().trim();
}

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

/** Starts a Storm run through the request router and waits for the record, index line and report. */
async function runOf(rpc: Rpc, files: StormFiles, message: string): Promise<RunRecord> {
	const before = files.runIds();
	await rpc.prompt(message);
	const run = await files.finishedRun(before);
	const reported = (): true | undefined => {
		const lastTurn = rpc.frames.findLastIndex(frame => frame.type === "agent_end");
		// A verified run's closeout menu does not repeat the run id; one run per session makes its final report unique.
		return rpc.frames.slice(lastTurn + 1).some(frame => customMessage(frame) === "storm-report") ? true : undefined;
	};
	await until(reported, 60_000, `the report of ${run.runId}`);
	return run;
}

/** Edits the one required check and goes through Storm's explicit approval for the new config hash. */
async function approveRequiredCheck(name: string, argv: string[]): Promise<void> {
	const active = ownedFiles();
	active.editConfig(config => {
		config.requiredChecks = [{ name, argv }];
	});
	const approvals = active.approvals().length;
	await session(choose(APPROVE), async (rpc, files) => {
		await rpc.prompt("/storm");
		check(`the ${name} requirement got its explicit approval`, files.approvals().length === approvals + 1, `approvals=${files.approvals().length}/${approvals}`);
	});
}

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	linkPlugin(env);

	await suite.step(
		"isolated profile and approved team",
		async () => {
			await session(choose(APPROVE), async (rpc, files) => {
				await rpc.prompt("/storm");
				check("the isolated profile has one approved team", existsSync(files.configFile) && files.approvals().length === 1, `config=${existsSync(files.configFile)} approvals=${files.approvals().length}`);
				rpc.answer = choose(AUTO_OFF);
				await rpc.prompt("/storm auto");
				const choice = await readAutoDelegationChoice(files.sessionDir);
				check("automatic delegation is explicitly off for the scripted director", choice === "off", choice);
				// A real turn materializes the native transcript so later cases can resume this exact session.
				await rpc.turn("hello");
			});
		},
		120_000,
		{ always: true },
	);

	// T01 · half 1: an existing user file and a worker that ends without writing.
	const reportPath = join(env.project, REPORT);
	writeFileSync(reportPath, REPORT_CONTENT);
	const reportHash = hash(REPORT_CONTENT);
	const reportBytes = REPORT_CONTENT.length;

	await suite.step("T01 baseline: a pre-existing user report.json is not the requested change", async () => {
		const before = readFileSync(reportPath);
		await session(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				planFor([
					{
						name: "report",
						kind: "code",
						files: [REPORT],
						goal: "Create or update report.json for this request",
						results: [requiredResult("report-change", "change", "report.json is the worker's change, not the user's existing file", { path: REPORT, contains: '"total": 42' })],
					},
				]),
				// No E2E-CHILD-WRITE / E2E-CHILD-BASH: the worker only ends.
				{ task: ["storm-implementer"], as: "Reporter" },
			];
			const run = await runOf(rpc, files, runRequest(steps));
			const after = readFileSync(reportPath);
			const afterHash = hash(after);
			const implementer = run.agents?.find(agent => agent.role === "implementer");
			const spawn = run.spawns.find(entry => entry.agent === "storm-implementer");
			const summary = summaryOf(files, run.runId);
			const lane = laneOf(run, "report");
			const progress = await officialStatusText(rpc);
			const detail = `bytes=${before.length}->${after.length} sha=${hash(before)}->${afterHash} planFiles=${JSON.stringify(lane?.files ?? null)} spawn=${spawn?.outcome ?? "none"} workerRequests=${implementer?.requests ?? "none"} workerChanges=${implementer?.changes ?? 0} git=${JSON.stringify(gitStatus())}`;
			observe("T01a existing-dirty/no-op-worker", run, detail);
			check(
				"T01a: native plan admission kept the lane and its file scope",
				lane !== undefined && lane.kind === "code" && Array.isArray(lane.files) && (lane.files as unknown[]).includes(REPORT),
				`lane=${JSON.stringify(lane ?? null)} run=${run.runId}`,
			);
			check(
				"T01a: the worker was admitted, ran, and made no file change",
				spawn !== undefined && spawn.outcome !== "blocked" && implementer !== undefined && (implementer.requests ?? 0) > 0 && (implementer.changes ?? 0) === 0,
				`spawn=${spawn?.outcome} requests=${implementer?.requests} changes=${implementer?.changes} run=${run.runId}`,
			);
			check(
				"T01a: the user's existing report.json bytes are preserved",
				before.equals(after) && hash(after) === hash(before) && afterHash === reportHash,
				`before=${hash(before)} after=${afterHash} expected=${reportHash}`,
			);
			check(
				"T01a: a pre-existing user file does not satisfy the lane (no normal close)",
				run.endReason !== "no-changes" &&
					run.endReason !== "unreviewed" &&
					run.endReason !== "no-reviewer" &&
					run.endReason !== "verified" &&
					run.status !== "done",
				`observed ${run.status}/${run.endReason} for ${run.runId}; expected the named obligation to stay unresolved, not an ordinary no-change/unreviewed/no-reviewer close`,
			);
			check(
				"T01a: the run summary index agrees with the record",
				summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
				summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
			);
			if (CONTRACT) {
				const obligation = resultFor(run, "report-change");
				check(
					"T01a contract: the plan preserved the required change result",
					hasRequiredResult(run, "report", "report-change", "change"),
					JSON.stringify(lane?.results ?? null),
				);
				check(
					"T01a contract: the named obligation is unmet on the attempted job",
					obligation !== undefined &&
						obligation.state === "unmet" &&
						laneIs(obligation.lane, "report") &&
						obligation.reason !== undefined &&
						obligation.reason.trim() !== "" &&
						attemptMatches(obligation.attemptId, spawn?.spawnKey) &&
						obligation.attemptId !== implementer?.name &&
						obligation.attemptId !== implementer?.role,
					JSON.stringify({ obligation: obligation ?? null, spawnKey: spawn?.spawnKey ?? null, worker: implementer?.name ?? null }),
				);
				check(
					"T01a contract: official status names the unresolved id and its reason",
					obligation?.reason !== undefined && progress.includes("report-change") && progress.includes(obligation.reason),
					`progress=${progress.slice(0, 500)}`,
				);
			}
		});
		const finalBytes = readFileSync(reportPath);
		check(
			"T01a: report.json is still byte-identical after the session closed",
			hash(finalBytes) === reportHash && finalBytes.length === reportBytes,
			`len=${finalBytes.length} sha=${hash(finalBytes)}`,
		);
	});

	// T01 · half 2: the control, a read-only query whose source is the file the user already owns.
	await suite.step("T01 baseline: a read-only query reads its source and needs no diff or reviewer", async () => {
		const before = readFileSync(reportPath);
		const llm = new LlmCursor(env);
		await session(cancelAll, async (rpc, files) => {
			const steps: Step[] = [
				planFor([
					{
						name: "read-report",
						kind: "explore",
						goal: "Answer what report.json already says, citing the file",
						results: [requiredResult("report-answer", "answer", "the answer states report.json's total and cites report.json", { path: REPORT, contains: '"total": 42' })],
					},
				]),
				{ task: ["storm-explorer"], as: "Reader", say: `E2E-CHILD-READ ${REPORT} E2E-CHILD-CLAIM The total is 42 (report.json:2)` },
			];
			const run = await runOf(rpc, files, runRequest(steps));
			const after = readFileSync(reportPath);
			const child = run.agents?.find(agent => agent.role === "explorer");
			const spawn = run.spawns.find(entry => entry.agent === "storm-explorer");
			const reviewer = run.agents?.some(agent => agent.role === "reviewer") === true;
			const summary = summaryOf(files, run.runId);
			const lane = laneOf(run, "read-report");
			const detail = `bytes=${before.length}->${after.length} sha=${hash(before)}->${hash(after)} spawn=${spawn?.outcome ?? "none"} childRequests=${child?.requests ?? "none"} childChanges=${child?.changes ?? 0} reviewer=${reviewer} git=${JSON.stringify(gitStatus())}`;
			observe("T01b read-only/source", run, detail);
			check(
				"T01b: native plan admission kept the explore lane",
				lane !== undefined && lane.kind === "explore",
				`lane=${JSON.stringify(lane ?? null)} run=${run.runId}`,
			);
			check(
				"T01b: the explorer was admitted and ran",
				spawn !== undefined && spawn.outcome !== "blocked" && child !== undefined && (child.requests ?? 0) > 0 && (child.changes ?? 0) === 0,
				`spawn=${spawn?.outcome} requests=${child?.requests} changes=${child?.changes} run=${run.runId}`,
			);
			check(
				"T01b: the read-only query left the user's bytes unchanged",
				before.equals(after) && hash(after) === hash(before),
				`before=${hash(before)} after=${hash(after)}`,
			);
			const kids = llm.of("child");
			const readRequested = kids.some(entry => entry.decision.tool === "read" && JSON.stringify(entry.decision.args ?? {}).includes(REPORT));
			const resultCarriesSource = kids.some(entry => entry.lastTool.includes('"total": 42'));
			check(
				"T01b: the worker's native read returned the requested source",
				readRequested && resultCarriesSource,
				`read=${readRequested} sourceResult=${resultCarriesSource} children=${kids.length}`,
			);
			const delivered = rpc.frames.filter(frame => customMessage(frame) === "async-result").map(frame => JSON.stringify(frame)).join("\n");
			check(
				"T01b: the parent received the worker's source-citing answer",
				delivered.includes("The total is 42") && delivered.includes("report.json:2"),
				`asyncResults=${delivered.slice(0, 400)}`,
			);
			check(
				"T01b: the read-only query did not force a review or a diff",
				reviewer === false && (CONTRACT ? run.status === "done" && run.endReason === "verified" : run.status === "ended" && run.endReason === "no-changes"),
				`reviewer=${reviewer} observed=${run.status}/${run.endReason} run=${run.runId}`,
			);
			check(
				"T01b: the run summary index agrees with the record",
				summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
				summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
			);
			if (CONTRACT) {
				const obligation = resultFor(run, "report-answer");
				check(
					"T01b contract: the plan preserved the required answer result",
					hasRequiredResult(run, "read-report", "report-answer", "answer"),
					JSON.stringify(lane?.results ?? null),
				);
				check(
					"T01b contract: the accepted answer binds to the native attempt, not a role or a plan entry",
					obligation !== undefined &&
						obligation.state === "accepted" &&
						laneIs(obligation.lane, "read-report") &&
						attemptMatches(obligation.attemptId, spawn?.spawnKey) &&
						obligation.attemptId !== child?.name &&
						obligation.attemptId !== child?.role,
					JSON.stringify({ obligation: obligation ?? null, spawnKey: spawn?.spawnKey ?? null, worker: child?.name ?? null }),
				);
				check(
					"T01b contract: accepted source evidence completes the no-write run without a code review",
					obligation?.state === "accepted" && reviewer === false && run.endReason === "verified" && run.status === "done",
					`state=${obligation?.state ?? "none"} observed=${run.status}/${run.endReason} reviewer=${reviewer}`,
				);
			}
		});
		check(
			"T01b: report.json is still byte-identical after the session closed",
			hash(readFileSync(reportPath)) === reportHash,
			`sha=${hash(readFileSync(reportPath))}`,
		);
	});

	// T01c · a cited prose answer needs the approved reviewer's verdict scoped to that exact submission (contract only:
	// the baseline plan has no results). Both runs come before the T06 required-check approvals, so no check is configured.
	if (CONTRACT) {
		const answerId = "report-explained";
		const answerLane = "explain-report";
		// The anchor S1 judges is the producer's own citation; no number is stated, so S1 cannot match it mechanically.
		const answerCitation = `${REPORT}:3`;
		const answerText = `The report.json source field says a user owns this file, so Storm must leave its figures untouched (${answerCitation})`;
		const answerPlan = (): Step =>
			planFor([
				{
					name: answerLane,
					kind: "explore",
					goal: "Explain who owns report.json and why its figures stay untouched, citing the file",
					results: [
						requiredResult(
							answerId,
							"answer",
							"The answer explains, from report.json itself, who owns the file and why its figures must stay untouched; an independent reviewer judges the prose.",
							{ path: REPORT },
						),
					],
				},
				{ name: "review", kind: "review", goal: "Judge the cited answer against its current source" },
			]);
		const explainer: Step = { task: ["storm-explorer"], as: "Explainer", say: `E2E-CHILD-READ ${REPORT} E2E-CHILD-CLAIM ${answerText}` };

		await suite.step("T01c: a generic tree-only reviewer verdict does not accept a cited prose answer", async () => {
			const before = readFileSync(reportPath);
			const llm = new LlmCursor(env);
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					answerPlan(),
					explainer,
					{ task: ["storm-reviewer"], as: "Generic", say: "E2E-CHILD-VERDICT correct", afterResult: 'agent="storm-explorer" status="completed"' },
				];
				const run = await runOf(rpc, files, runRequest(steps, 1));
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				const producer = run.spawns.find(entry => entry.agent === "storm-explorer");
				const obligation = resultFor(run, answerId);
				const summary = summaryOf(files, run.runId);
				const progress = await officialStatusText(rpc);
				const yields = reviewerYields(llm.of("child"));
				const stored = storedScopes(reviewer);
				const after = readFileSync(reportPath);
				observe(
					"T01c generic-only/answer",
					run,
					`verdict=${JSON.stringify(reviewer?.lastVerdict ?? null)} reviewerChanges=${reviewer?.changes ?? 0} storedScopes=${stored.scopes.length} yields=${yields.length}`,
				);
				check(
					"T01c generic: the plan preserved the cited answer result without a machine literal",
					hasRequiredResult(run, answerLane, answerId, "answer") && plannedResult(run, answerLane, answerId)?.contains === undefined,
					JSON.stringify(plannedResult(run, answerLane, answerId) ?? null),
				);
				check(
					"T01c generic: the approved reviewer gave a correct current-tree verdict without changing files",
					reviewer !== undefined && (reviewer.changes ?? 0) === 0 && reviewer.lastVerdict?.correct === true && reviewer.lastVerdict.tree !== undefined,
					`reviewer=${JSON.stringify(reviewer?.lastVerdict ?? null)} changes=${reviewer?.changes}`,
				);
				check(
					"T01c generic: the verdict scoped no answer (no results in the yield or the stored review log)",
					yields.length > 0 && yields.every(item => item.data.results === undefined) && stored.complete && stored.scopes.length === 0,
					JSON.stringify({ yields: yields.map(item => item.data.results ?? null), stored }),
				);
				check(
					"T01c generic: the answer stays reviewable on the producer's native attempt",
					obligation !== undefined &&
						obligation.state === "reviewable" &&
						laneIs(obligation.lane, answerLane) &&
						attemptMatches(obligation.attemptId, producer?.spawnKey),
					JSON.stringify({ obligation: obligation ?? null, spawnKey: producer?.spawnKey ?? null }),
				);
				check(
					"T01c generic: a tree-only verdict cannot close the answer run done/verified",
					run.status !== "done" && run.endReason !== "verified",
					`observed ${run.status}/${run.endReason} run=${run.runId}`,
				);
				check("T01c generic: official status names the open answer", progress.includes(answerId), `progress=${progress.slice(0, 500)}`);
				check(
					"T01c generic: the run summary index agrees with the record",
					summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
					summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
				);
				check("T01c generic: the user's report.json bytes are unchanged", before.equals(after), `before=${hash(before)} after=${hash(after)}`);
			});
		});

		await suite.step("T01c: the approved reviewer's verdict scoped to the exact answer and receipt verifies it", async () => {
			const before = readFileSync(reportPath);
			const llm = new LlmCursor(env);
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					answerPlan(),
					explainer,
					// A plain review task, held until Storm's round says an answer waits; Storm appends the packet itself.
					{ task: ["storm-reviewer"], as: "Scoped", say: "E2E-CHILD-ANSWER-VERDICT correct", after: REVIEW_BATCH_CUE },
				];
				const run = await runOf(rpc, files, runRequest(steps));
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				const producer = run.spawns.find(entry => entry.agent === "storm-explorer");
				const reviewSpawn = run.spawns.find(entry => entry.agent === "storm-reviewer");
				const obligation = resultFor(run, answerId);
				const submission = submissionOf(run, answerId);
				const summary = summaryOf(files, run.runId);
				const after = readFileSync(reportPath);
				// The oracle: the receipt for this exact persisted submission, never a value the fixture wrote down.
				const expected =
					submission.attemptId === undefined || submission.contentVersion === undefined
						? undefined
						: answerReviewReceipt({ runId: run.runId, resultId: answerId, attemptId: submission.attemptId, contentVersion: submission.contentVersion });
				const directed = llm
					.of("main")
					.filter(entry => entry.decision.tool === "task" && JSON.stringify(entry.decision.args ?? {}).includes("storm-reviewer"))
					.map(entry => JSON.stringify(entry.decision.args));
				const packets = llm.of("child").flatMap(entry => (entry.reviewPacket === undefined ? [] : [entry.reviewPacket]));
				const packet = packets.at(-1);
				const yields = reviewerYields(llm.of("child"));
				const yielded = yields.at(-1)?.data.results;
				const stored = storedScopes(reviewer);
				observe(
					"T01c scoped/answer",
					run,
					`expected=${expected ?? "none"} packet=${JSON.stringify(packet === undefined ? null : { ...packet, answer: packet.answer.slice(0, 80) })} yielded=${JSON.stringify(yielded ?? null)} stored=${JSON.stringify(stored)} verdict=${JSON.stringify(reviewer?.lastVerdict ?? null)}`,
				);
				check(
					"T01c scoped: the persisted row identifies the exact submission (host attempt and content version)",
					expected !== undefined && attemptMatches(submission.attemptId, producer?.spawnKey),
					JSON.stringify({ submission, spawnKey: producer?.spawnKey ?? null }),
				);
				check(
					"T01c scoped: the director sent a plain review task and Storm, not the director, supplied the receipt",
					expected !== undefined && reviewSpawn !== undefined && reviewSpawn.outcome !== "blocked" && directed.length > 0 && directed.every(args => !args.includes(expected)),
					JSON.stringify({ expected: expected ?? null, spawn: reviewSpawn?.outcome ?? null, directed: directed.map(args => args.slice(0, 400)) }),
				);
				check(
					"T01c scoped: the approved reviewer received Storm's packet with the exact answer, receipt and current citation",
					packet !== undefined &&
						packet.id === answerId &&
						packet.receipt === expected &&
						packet.citation === answerCitation &&
						packet.answer === answerText,
					JSON.stringify({ packet: packet ?? null, expected: expected ?? null, answer: answerText }),
				);
				check(
					"T01c scoped: the reviewer's final yield scoped exactly that id, receipt and citation as correct",
					Array.isArray(yielded) &&
						yielded.length === 1 &&
						JSON.stringify(yielded[0]) === JSON.stringify({ id: answerId, receipt: expected, citation: answerCitation, verdict: "correct" }),
					JSON.stringify(yielded ?? null),
				);
				check(
					"T01c scoped: the approved reviewer's stored review log holds the scoped correct verdict and changed no file",
					reviewer !== undefined &&
						(reviewer.changes ?? 0) === 0 &&
						stored.complete &&
						stored.scopes.some(scope => scope.id === answerId && scope.receipt === expected && scope.citation === answerCitation && scope.correct),
					JSON.stringify({ stored, changes: reviewer?.changes ?? null }),
				);
				check(
					"T01c scoped: the answer is accepted on the producer's native attempt",
					obligation !== undefined &&
						obligation.state === "accepted" &&
						laneIs(obligation.lane, answerLane) &&
						attemptMatches(obligation.attemptId, producer?.spawnKey),
					JSON.stringify({ obligation: obligation ?? null, spawnKey: producer?.spawnKey ?? null }),
				);
				check(
					"T01c scoped: the exact reviewed submission closes the no-write run done/verified",
					run.status === "done" && run.endReason === "verified",
					`observed ${run.status}/${run.endReason} run=${run.runId}`,
				);
				check(
					"T01c scoped: the run summary index agrees with the record",
					summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
					summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
				);
				check("T01c scoped: the user's report.json bytes are unchanged", before.equals(after), `before=${hash(before)} after=${hash(after)}`);
			});
		});
	}

	if (CONTRACT) {
		const reviewLane = { name: "review", kind: "review", goal: "Judge every cited answer against its current source" } as const;

		await suite.step("T01d: nine reviewable answers settle in one reviewer turn under a stated 30-round limit", async () => {
			const ids = Array.from({ length: 9 }, (_, index) => `report-angle-${index + 1}`);
			const text = `The report.json source field says a user owns this file, so its figures stay untouched (${REPORT}:3)`;
			const llm = new LlmCursor(env);
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "nine-angles",
							kind: "explore",
							goal: "Explain who owns report.json from nine angles, citing the file",
							results: ids.map((id, index) =>
								requiredResult(id, "answer", `Angle ${index + 1}: the answer explains from report.json who owns it and why its figures stay untouched; an independent reviewer judges the prose.`, { path: REPORT }),
							),
						},
						reviewLane,
					]),
					{ task: ["storm-explorer"], as: "Nine", say: `E2E-CHILD-READ ${REPORT} E2E-CHILD-CLAIM ${text}` },
					{ task: ["storm-reviewer"], as: "Batch", say: "E2E-CHILD-ANSWER-VERDICT-ALL correct", after: REVIEW_BATCH_CUE },
				];
				const run = await runOf(rpc, files, runRequest(steps, 30));
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				const reviewSpawns = run.spawns.filter(entry => entry.agent === "storm-reviewer" && entry.outcome !== "blocked");
				const yields = reviewerYields(llm.of("child"));
				const yielded = yields.at(-1)?.data.results;
				const stored = storedScopes(reviewer);
				const states = ids.map(id => resultFor(run, id)?.state ?? "none");
				observe("T01d nine answers", run, `limits=${JSON.stringify(run.limits ?? null)} maxRounds=${run.maxRounds} reviewSpawns=${reviewSpawns.length} yielded=${Array.isArray(yielded) ? yielded.length : "none"} stored=${stored.scopes.length}`);
				check("T01d: the stated 30-round limit is accepted and becomes the run's round limit", run.limits?.rounds === 30 && run.maxRounds === 30, `limits=${JSON.stringify(run.limits ?? null)} maxRounds=${run.maxRounds}`);
				check("T01d: the plan kept all nine answer results on one lane", ids.every(id => hasRequiredResult(run, "nine-angles", id, "answer")), JSON.stringify(laneOf(run, "nine-angles") ?? null).slice(0, 400));
				check(
					"T01d: one approved reviewer turn received and judged all nine answers",
					reviewSpawns.length === 1 && Array.isArray(yielded) && yielded.length === ids.length && stored.scopes.filter(scope => scope.correct && ids.includes(scope.id)).length === ids.length,
					JSON.stringify({ spawns: reviewSpawns.length, yielded: Array.isArray(yielded) ? yielded.length : null, stored: stored.scopes.map(scope => scope.id) }),
				);
				check("T01d: all nine answers are accepted", states.every(state => state === "accepted"), JSON.stringify(states));
				check("T01d: the run closes done/verified", run.status === "done" && run.endReason === "verified", `observed ${run.status}/${run.endReason} turns=${run.turns}`);
			});
		});

		await suite.step("T01e: an answer omp delivers as a preview is judged on the whole output", async () => {
			const answerId = "long-answer";
			const claim = `The total is 42 (${REPORT}:2)`;
			const llm = new LlmCursor(env);
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "long-read",
							kind: "explore",
							goal: "Answer what report.json says after a long preamble, citing the file",
							results: [requiredResult(answerId, "answer", "the answer states report.json's total and cites report.json", { path: REPORT, contains: '"total": 42' })],
						},
						reviewLane,
					]),
					// 14,000 characters of digit-free preamble put the claim and its only citation past omp's async preview.
					{ task: ["storm-explorer"], as: "Long", say: `E2E-CHILD-READ ${REPORT} E2E-CHILD-PAD 14000 E2E-CHILD-CLAIM ${claim}` },
					{ task: ["storm-reviewer"], as: "Whole", say: "E2E-CHILD-ANSWER-VERDICT correct", after: REVIEW_BATCH_CUE },
				];
				const run = await runOf(rpc, files, runRequest(steps));
				const delivered = rpc.frames.filter(frame => customMessage(frame) === "async-result").map(frame => JSON.stringify(frame)).join("\n");
				// A packet for a partial answer says so instead of "Answer as submitted", so the parser finds none for it.
				const packet = llm.of("child").flatMap(entry => (entry.reviewPacket === undefined ? [] : [entry.reviewPacket])).at(-1);
				const raw = (run.results ?? []).find(row => row.id === answerId);
				observe("T01e preview answer", run, `previewed=${delivered.includes("<preview full-output=")} deliveredChars=${delivered.length} packetChars=${packet?.answer.length ?? 0}`);
				check("T01e: omp delivered the long answer as a preview with a full-output handle", delivered.includes("<preview full-output=") && delivered.includes("agent://"), delivered.slice(0, 300));
				check(
					"T01e: the reviewer received the whole answer, with the claim and citation past the preview",
					packet?.id === answerId && packet.answer.length >= 14_000 && packet.answer.endsWith(claim) && packet.citation === `${REPORT}:2`,
					JSON.stringify(packet === undefined ? null : { ...packet, answer: `${packet.answer.length} chars, ends ${JSON.stringify(packet.answer.slice(-60))}` }),
				);
				check("T01e: the scoped correct verdict accepts the whole answer", raw?.state === "accepted" && raw.origin === "review", JSON.stringify(raw ?? null));
				check("T01e: the run closes done/verified", run.status === "done" && run.endReason === "verified", `observed ${run.status}/${run.endReason}`);
			});
		});

		await suite.step("T01f: a prose answer stating the value beside other numbers is reviewed, and a scoped verdict accepts it", async () => {
			const answerId = "total-with-context";
			const text = `The total is 42 but the retry budget is 7 (${REPORT}:2)`;
			const llm = new LlmCursor(env);
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "total-read",
							kind: "explore",
							goal: "Answer report.json's total with context, citing the file",
							results: [requiredResult(answerId, "answer", "the answer states report.json's total and cites report.json", { path: REPORT, contains: '"total": 42' })],
						},
						reviewLane,
					]),
					{ task: ["storm-explorer"], as: "Prose", say: `E2E-CHILD-READ ${REPORT} E2E-CHILD-CLAIM ${text}` },
					{ task: ["storm-reviewer"], as: "Judge", say: "E2E-CHILD-ANSWER-VERDICT correct", after: REVIEW_BATCH_CUE },
				];
				const run = await runOf(rpc, files, runRequest(steps));
				const packet = llm.of("child").flatMap(entry => (entry.reviewPacket === undefined ? [] : [entry.reviewPacket])).at(-1);
				const stored = storedScopes(run.agents?.find(agent => agent.role === "reviewer"));
				const raw = (run.results ?? []).find(row => row.id === answerId);
				observe("T01f prose with numbers", run, `packet=${packet?.id ?? "none"} stored=${stored.scopes.length} origin=${raw?.origin ?? "none"}`);
				check("T01f: the answer went to review with its exact text, not to unmet", packet?.id === answerId && packet.answer === text, JSON.stringify(packet ?? null));
				check("T01f: the scoped correct verdict accepted it", raw?.state === "accepted" && raw.origin === "review" && stored.scopes.some(scope => scope.id === answerId && scope.correct), JSON.stringify({ row: raw ?? null, stored }));
				check("T01f: the run closes done/verified", run.status === "done" && run.endReason === "verified", `observed ${run.status}/${run.endReason}`);
			});
		});
	}

	// T06 · the result criterion is qualitative prose, not a machine `contains`; the first case stops before a verdict.
	const qualitativeTarget = "acceptance-qualitative.md";
	const qualitativeText = "The user report already records total 42; nothing needs rewriting, and this submission explains why.";
	const qualitativeWrite = Buffer.from(`printf '%s\\n' '${qualitativeText}' > ${qualitativeTarget}`, "utf8").toString("base64");

	if (CONTRACT) {
		// 0.28.0: each worker is sent its lane's result contract. The child's own first message is what the fake provider logged.
		const CITED_ANSWER = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
		const contractLane = (name: string, id: string) => ({
			name,
			kind: "explore" as const,
			goal: "Report the first line of the tracked answer file from source",
			results: [requiredResult(id, "answer", `report what ${FACT_FILE} line 1 says, from source`, { path: FACT_FILE, contains: FACT_LINE })],
		});
		const stepsRoute = (steps: Step[]): string => runRequest(steps, 1);
		/** The first message a child of this run received from its parent: the assignment as it reached the model. */
		const firstMessageOf = (llm: LlmCursor, marker: string): string => llm.of("child").find(entry => entry.lastUser.includes(marker))?.lastUser ?? "";
		const delivered = (text: string, id: string): boolean => text.includes("[storm:계약]") && text.includes(id) && !text.includes(FACT_LINE);

		await suite.step("T07: the lane's result contract reaches the child on a task item: its id is in the assignment, the literal the answer must match is not, and the cited answer is accepted", async () => {
			const llm = new LlmCursor(env);
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([contractLane("Cx", "cx-answer")], { explorer: 1 }),
					{ tasks: [{ name: "Cx", agent: "storm-explorer", task: "Report from source (T07-TASK)", say: CITED_ANSWER }] },
					{ wait: true },
				];
				const run = await runOf(rpc, files, stepsRoute(steps));
				const text = firstMessageOf(llm, "T07-TASK");
				observe("T07 task item", run, `contract=${text.includes("[storm:계약]")} id=${text.includes("cx-answer")} literalHidden=${!text.includes(FACT_LINE)}`);
				check("T07: the child's assignment carries the [storm:계약] block with the result id", text.includes("[storm:계약]") && text.includes("cx-answer"), text.slice(0, 600));
				check("T07: and never the literal the answer is matched against (it would let a worker copy it)", !text.includes(FACT_LINE), text.slice(0, 600));
				check("T07: the block comes after the director's own text", text.indexOf("T07-TASK") >= 0 && text.indexOf("T07-TASK") < text.indexOf("[storm:계약]"), text.slice(0, 300));
				check("T07: the child answered in the advertised form (path:line) and the unchanged evaluator accepted it", resultFor(run, "cx-answer")?.state === "accepted", JSON.stringify(runResults(run)));
			});
		});

		await suite.step("T07: the contract reaches the child on an item with steps (omp's task.steps on): in the first step, with one step and with two", async () => {
			// omp offers `steps` in place of `task` only when the user turned it on; the profile's settings are rewritten for this step and restored after.
			writeFileSync(join(env.agentDir, "config.yml"), `${PROFILE_CONFIG}task:\n  steps: true\n`);
			try {
				for (const shape of [{ lane: "Cs1", id: "cs1-answer", steps: ["Report from source (T07-ONE)"] }, { lane: "Cs2", id: "cs2-answer", steps: ["Report from source (T07-TWO)", "Then summarize in one sentence."] }]) {
					const llm = new LlmCursor(env);
					await session(cancelAll, async (rpc, files) => {
						const steps: Step[] = [
							planFor([contractLane(shape.lane, shape.id)], { explorer: 1 }),
							{ tasks: [{ name: shape.lane, agent: "storm-explorer", steps: shape.steps, say: CITED_ANSWER }] },
							{ wait: true },
						];
						const run = await runOf(rpc, files, stepsRoute(steps));
						const text = firstMessageOf(llm, shape.steps[0]?.includes("ONE") ? "T07-ONE" : "T07-TWO");
						observe(`T07 ${shape.steps.length} step(s)`, run, `contract=${delivered(text, shape.id)}`);
						check(`T07 (${shape.steps.length} step${shape.steps.length === 1 ? "" : "s"}): the first message the child got holds the contract block and the result id, and not the literal`, delivered(text, shape.id), text.slice(0, 700));
						check(`T07 (${shape.steps.length} step${shape.steps.length === 1 ? "" : "s"}): the second step, when there is one, is not where it went`, shape.steps.length === 1 || !(llm.of("child").map(entry => entry.lastUser).find(user => user.includes("Then summarize")) ?? "").includes("[storm:계약]"), "");
						check(`T07 (${shape.steps.length} step${shape.steps.length === 1 ? "" : "s"}): the cited answer was accepted`, resultFor(run, shape.id)?.state === "accepted", JSON.stringify(runResults(run)));
					});
				}
			} finally {
				writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
			}
		});
	}

	await suite.step("T06: a qualitative submission stays reviewable without an independent verdict", async () => {
		const targetPath = join(env.project, qualitativeTarget);
		rmSync(targetPath, { force: true });
		try {
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "submit",
							kind: "code",
							files: [qualitativeTarget],
							goal: "Submit a prose explanation for qualitative review",
							results: [
								requiredResult(
									"qualitative-submission",
									"change",
									"The submitted prose explains why the existing report total needs no rewrite, clearly enough for an independent reviewer to judge.",
								),
							],
						},
						{ name: "review", kind: "review", goal: "Give the independent qualitative verdict" },
					]),
					{ task: ["storm-implementer"], as: "Submitter", say: `E2E-CHILD-SH ${qualitativeWrite}` },
				];
				const run = await runOf(rpc, files, runRequest(steps, 1));
				const writerKey = run.spawns.find(entry => laneIs(entry.lane, "submit") && entry.outcome !== "blocked")?.spawnKey;
				const writer = run.agents?.find(agent => agent.id === writerKey);
				const spawn = run.spawns.find(entry => laneIs(entry.lane, "submit"));
				const reviewer = run.agents?.some(agent => agent.role === "reviewer") === true;
				const summary = summaryOf(files, run.runId);
				const planned = plannedResult(run, "submit", "qualitative-submission");
				const content = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
				const progress = await officialStatusText(rpc);
				const detail = `writerRequests=${writer?.requests ?? "none"} spawn=${spawn?.outcome ?? "none"} reviewer=${reviewer} artifactBytes=${content.length} git=${JSON.stringify(gitStatus())}`;
				observe("T06 qualitative-reviewable", run, detail);
				check(
					"T06: the qualitative prose artifact is really in the tree",
					content.includes("nothing needs rewriting") && content.includes("total 42"),
					`content=${JSON.stringify(content.slice(0, 200))}`,
				);
				check(
					"T06: no reviewer ran, so the submission is still pending review",
					reviewer === false && writer !== undefined && (writer.requests ?? 0) > 0,
					`reviewer=${reviewer} writerRequests=${writer?.requests}`,
				);
				check(
					"T06: a submitted qualitative obligation alone is not verified",
					run.status !== "done" && run.endReason !== "verified" && run.endReason !== "no-changes",
					`observed ${run.status}/${run.endReason} run=${run.runId}`,
				);
				check(
					"T06: the run summary index agrees with the record",
					summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
					summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
				);
				if (CONTRACT) {
					const obligation = resultFor(run, "qualitative-submission");
					check(
						"T06 contract: the plan preserved a qualitative result without path/contains/check",
						hasRequiredResult(run, "submit", "qualitative-submission", "change") &&
							planned !== undefined &&
							typeof planned.criterion === "string" &&
							planned.path === undefined &&
							planned.contains === undefined &&
							planned.check === undefined,
						JSON.stringify(planned ?? null),
					);
					check(
						"T06 contract: the obligation is reviewable on the submitter's native attempt",
						obligation !== undefined &&
							obligation.state === "reviewable" &&
							laneIs(obligation.lane, "submit") &&
							attemptMatches(obligation.attemptId, spawn?.spawnKey) &&
							obligation.attemptId !== writer?.name &&
							obligation.attemptId !== writer?.role,
						JSON.stringify({ obligation: obligation ?? null, spawnKey: spawn?.spawnKey ?? null }),
					);
					check(
						"T06 contract: official status names the pending obligation",
						progress.includes("qualitative-submission"),
						`progress=${progress.slice(0, 500)}`,
					);
				}
			});
		} finally {
			rmSync(targetPath, { force: true });
		}
	});

	await suite.step("T06: an incorrect independent verdict leaves the named obligation unmet", async () => {
		const target = "acceptance-incorrect.txt";
		const targetPath = join(env.project, target);
		rmSync(targetPath, { force: true });
		try {
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "write",
							kind: "code",
							files: [target],
							goal: "Submit a change for an independent qualitative verdict",
							results: [requiredResult("incorrect-change", "change", "The submitted change is ready for the independent reviewer's qualitative verdict.")],
						},
						{ name: "review", kind: "review", goal: "Give an independent verdict" },
					]),
					{ task: ["storm-implementer"], as: "Writer", say: `E2E-CHILD-WRITE ${target}` },
					{ task: ["storm-reviewer"], as: "Reviewer", afterResult: 'agent="storm-implementer" status="completed"' },
				];
				const run = await runOf(rpc, files, runRequest(steps, 1));
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				const spawn = run.spawns.find(entry => laneIs(entry.lane, "write"));
				const summary = summaryOf(files, run.runId);
				const planned = plannedResult(run, "write", "incorrect-change");
				const progress = await officialStatusText(rpc);
				const detail = `verdict=${JSON.stringify(reviewer?.lastVerdict ?? null)} reviewerChanges=${reviewer?.changes ?? 0} git=${JSON.stringify(gitStatus())}`;
				observe("T06 incorrect-verdict", run, detail);
				check(
					"T06: an independent reviewer returned an incorrect verdict on the current change",
					reviewer !== undefined && (reviewer.changes ?? 0) === 0 && reviewer.lastVerdict?.correct === false,
					`reviewer=${JSON.stringify(reviewer?.lastVerdict ?? null)} changes=${reviewer?.changes}`,
				);
				check(
					"T06: an incorrect verdict cannot close done/verified",
					run.status !== "done" && run.endReason !== "verified" && run.endReason !== "no-changes",
					`observed ${run.status}/${run.endReason} run=${run.runId}`,
				);
				check(
					"T06: the run summary index agrees with the record",
					summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
					summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
				);
				if (CONTRACT) {
					const obligation = resultFor(run, "incorrect-change");
					check(
						"T06 contract: the plan preserved the qualitative result",
						hasRequiredResult(run, "write", "incorrect-change", "change") && planned !== undefined && planned.path === undefined && planned.contains === undefined && planned.check === undefined,
						JSON.stringify(planned ?? null),
					);
					check(
						"T06 contract: an incorrect verdict leaves the obligation unmet with a reason",
						obligation !== undefined &&
							obligation.state === "unmet" &&
							laneIs(obligation.lane, "write") &&
							obligation.reason !== undefined &&
							obligation.reason.trim() !== "" &&
							attemptMatches(obligation.attemptId, spawn?.spawnKey),
						JSON.stringify({ obligation: obligation ?? null, spawnKey: spawn?.spawnKey ?? null }),
					);
					check(
						"T06 contract: official status names the unresolved id and reason",
						obligation?.reason !== undefined && progress.includes("incorrect-change") && progress.includes(obligation.reason),
						`progress=${progress.slice(0, 500)}`,
					);
				}
			});
		} finally {
			rmSync(targetPath, { force: true });
		}
	});

	// T06 · a correct verdict on an earlier tree does not verify a later change.
	await suite.step("T06: a later change after the latest verdict stops unverified", async () => {
		const target = "acceptance-stale.txt";
		const targetPath = join(env.project, target);
		rmSync(targetPath, { force: true });
		try {
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "write",
							kind: "code",
							files: [target],
							goal: "Submit a change for review on the current tree",
							results: [requiredResult("stale-change", "change", "The submitted change is reviewed on the current tree before acceptance.")],
						},
						{ name: "review", kind: "review", goal: "Review the latest tree" },
					]),
					{ task: ["storm-implementer"], as: "Writer", say: `E2E-CHILD-BASH ${target}` },
					{ task: ["storm-reviewer"], as: "Reviewer", say: "E2E-CHILD-VERDICT correct", afterResult: 'agent="storm-implementer" status="completed"' },
					// The second write lands after the verdict; maxRounds 1 leaves no review round to rescue it.
					{ task: ["storm-implementer"], as: "Late", say: `E2E-CHILD-BASH ${target}`, afterResult: 'agent="storm-reviewer" status="completed"' },
				];
				const run = await runOf(rpc, files, runRequest(steps, 1));
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				// The lane's current attempt is the last one the host admitted for it; the row must still belong to that
				// exact job (never to a role or to the first writer after a later attempt replaced its evidence).
				const laneAttempts = run.spawns.filter(entry => laneIs(entry.lane, "write")).sort((a, b) => a.ts.localeCompare(b.ts));
				const currentAttempt = laneAttempts.at(-1)?.spawnKey;
				const late = run.agents?.find(agent => agent.id === currentAttempt);
				const summary = summaryOf(files, run.runId);
				const planned = plannedResult(run, "write", "stale-change");
				const progress = await officialStatusText(rpc);
				const content = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
				const mtime = existsSync(targetPath) ? statSync(targetPath).mtimeMs : "none";
				const detail = `markers=${content.split("storm-child-bash").length - 1} verdict=${JSON.stringify(reviewer?.lastVerdict ?? null)} mtime=${mtime} git=${JSON.stringify(gitStatus())}`;
				observe("T06 latest-verdict/stale-tree", run, detail);
				check(
					"T06: both writes landed, the second after the verdict",
					content.split("storm-child-bash").length - 1 === 2,
					`markers=${content.split("storm-child-bash").length - 1}`,
				);
				check(
					"T06: the reviewer's latest verdict is correct but bound before the later change",
					reviewer !== undefined && reviewer.lastVerdict?.correct === true && late !== undefined && existsSync(targetPath) && statSync(targetPath).mtimeMs > (reviewer.lastVerdict?.at ?? 0),
					`verdict=${JSON.stringify(reviewer?.lastVerdict ?? null)} mtime=${existsSync(targetPath) ? statSync(targetPath).mtimeMs : "none"} late=${late?.id ?? "none"}`,
				);
				check(
					"T06: a correct verdict on an earlier tree does not close done/verified",
					run.endReason !== "no-changes" && run.status !== "done" && run.endReason !== "verified",
					`observed ${run.status}/${run.endReason} for ${run.runId}; expected the latest-tree gate to reject the stale verdict`,
				);
				check(
					"T06: the run summary index agrees with the record",
					summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
					summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
				);
				if (CONTRACT) {
					const obligation = resultFor(run, "stale-change");
					check(
						"T06 contract: the plan preserved the qualitative result",
						hasRequiredResult(run, "write", "stale-change", "change") && planned !== undefined && planned.path === undefined && planned.contains === undefined && planned.check === undefined,
						JSON.stringify(planned ?? null),
					);
					check(
						"T06 contract: the stale verdict leaves the obligation unaccepted on the lane's current native attempt",
						obligation !== undefined &&
							obligation.state !== "accepted" &&
							laneIs(obligation.lane, "write") &&
							laneAttempts.length >= 2 &&
							attemptMatches(obligation.attemptId, currentAttempt) &&
							obligation.attemptId !== late?.name &&
							obligation.attemptId !== late?.role &&
							(obligation.state !== "unmet" || (obligation.reason !== undefined && obligation.reason.trim() !== "")),
						JSON.stringify({ obligation: obligation ?? null, laneAttempts: laneAttempts.map(entry => entry.spawnKey) }),
					);
					check(
						"T06 contract: official status names the unresolved obligation",
						progress.includes("stale-change"),
						`progress=${progress.slice(0, 500)}`,
					);
				}
			});
		} finally {
			rmSync(targetPath, { force: true });
		}
	});

	// T06 · the qualitative submission is accepted only after an independent current-tree verdict and a passing check
	// bound to the same tree fingerprint.
	await suite.step("T06: an independent current-tree verdict and a passing check accept the qualitative result", async () => {
		const checkName = "acceptance-qualitative-pass";
		const targetPath = join(env.project, qualitativeTarget);
		rmSync(targetPath, { force: true });
		await approveRequiredCheck(checkName, [
			process.execPath,
			"-e",
			`const fs=require("node:fs");const p=${JSON.stringify(qualitativeTarget)};const text=fs.existsSync(p)?fs.readFileSync(p,"utf8"):"";process.exit(text.includes("nothing needs rewriting")?0:9)`,
		]);
		try {
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "submit",
							kind: "code",
							files: [qualitativeTarget],
							goal: "Submit the prose explanation for qualitative approval",
							results: [
								requiredResult(
									"qualitative-submission",
									"change",
									"The submitted prose explains why the existing report total needs no rewrite, clearly enough for an independent reviewer to judge.",
								),
							],
						},
						{ name: "review", kind: "review", goal: "Give an independent current-tree verdict" },
					]),
					{ task: ["storm-implementer"], as: "Submitter", say: `E2E-CHILD-SH ${qualitativeWrite}` },
					{ task: ["storm-reviewer"], as: "Reviewer", say: "E2E-CHILD-VERDICT correct", after: '<storm-run id="' },
				];
				const run = await runOf(rpc, files, runRequest(steps));
				const writerKey = run.spawns.find(entry => laneIs(entry.lane, "submit") && entry.outcome !== "blocked")?.spawnKey;
				const writer = run.agents?.find(agent => agent.id === writerKey);
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				const spawn = run.spawns.find(entry => laneIs(entry.lane, "submit"));
				const summary = summaryOf(files, run.runId);
				const planned = plannedResult(run, "submit", "qualitative-submission");
				const evidence = run.checks?.find(item => item.name === checkName);
				const content = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
				const detail = `verdict=${JSON.stringify(reviewer?.lastVerdict ?? null)} check=${JSON.stringify(evidence ?? null)} content=${JSON.stringify(content.slice(0, 160))}`;
				observe("T06 qualitative-accepted", run, detail);
				check(
					"T06: the qualitative prose submission is in the tree",
					content.includes("nothing needs rewriting") && content.includes("total 42"),
					JSON.stringify(content.slice(0, 200)),
				);
				check(
					"T06: an independent approved reviewer passed the current tree",
					reviewer !== undefined && (reviewer.changes ?? 0) === 0 && reviewer.lastVerdict?.correct === true && reviewer.lastVerdict.tree !== undefined,
					`reviewer=${JSON.stringify(reviewer?.lastVerdict ?? null)} changes=${reviewer?.changes}`,
				);
				check(
					"T06: the configured check passed on the reviewer's same tree digest",
					evidence !== undefined &&
						evidence.status === "passed" &&
						reviewer?.lastVerdict?.tree !== undefined &&
						evidence.tree === reviewer.lastVerdict.tree,
					JSON.stringify({ check: evidence ?? null, reviewerTree: reviewer?.lastVerdict?.tree ?? null }),
				);
				check(
					"T06: the qualitative result is done/verified after both proofs",
					run.status === "done" && run.endReason === "verified",
					`observed ${run.status}/${run.endReason} run=${run.runId}`,
				);
				check(
					"T06: the run summary index agrees with the record",
					summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
					summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
				);
				if (CONTRACT) {
					const obligation = resultFor(run, "qualitative-submission");
					check(
						"T06 contract: the accepted obligation keeps the qualitative criterion",
						hasRequiredResult(run, "submit", "qualitative-submission", "change") && planned !== undefined && planned.path === undefined && planned.contains === undefined && planned.check === undefined,
						JSON.stringify(planned ?? null),
					);
					check(
						"T06 contract: the reviewer's verdict accepts the submitter's native attempt",
						obligation !== undefined &&
							obligation.state === "accepted" &&
							laneIs(obligation.lane, "submit") &&
							attemptMatches(obligation.attemptId, spawn?.spawnKey) &&
							obligation.attemptId !== writer?.name &&
							obligation.attemptId !== writer?.role,
						JSON.stringify({ obligation: obligation ?? null, spawnKey: spawn?.spawnKey ?? null }),
					);
				}
			});
		} finally {
			rmSync(targetPath, { force: true });
		}
	});

	// T06 · a failing approved check stops verified even with a correct latest verdict.
	await suite.step("T06: a failing latest required check blocks verified", async () => {
		const checkName = "acceptance-must-fail";
		const target = "acceptance-checked.txt";
		const targetPath = join(env.project, target);
		rmSync(targetPath, { force: true });
		await approveRequiredCheck(checkName, [process.execPath, "-e", "process.exit(7)"]);
		try {
			await session(cancelAll, async (rpc, files) => {
				const steps: Step[] = [
					planFor([
						{
							name: "write",
							kind: "code",
							files: [target],
							goal: "Submit the checked change for an independent verdict",
							results: [requiredResult("checked-change", "change", "The submitted change is ready for the independent reviewer's qualitative verdict.")],
						},
						{ name: "review", kind: "review", goal: "Review the checked change" },
					]),
					{ task: ["storm-implementer"], as: "Writer", say: `E2E-CHILD-WRITE ${target}` },
					{ task: ["storm-reviewer"], as: "Reviewer", say: "E2E-CHILD-VERDICT correct", afterResult: 'agent="storm-implementer" status="completed"' },
				];
				const run = await runOf(rpc, files, runRequest(steps, 1));
				const reviewer = run.agents?.find(agent => agent.role === "reviewer");
				const spawn = run.spawns.find(entry => laneIs(entry.lane, "write"));
				const summary = summaryOf(files, run.runId);
				const planned = plannedResult(run, "write", "checked-change");
				const evidence = run.checks?.find(item => item.name === checkName);
				const detail = `check=${JSON.stringify(evidence ?? null)} verdict=${JSON.stringify(reviewer?.lastVerdict ?? null)} allChecks=${JSON.stringify(run.checks ?? [])}`;
				observe("T06 latest-check/failed", run, detail);
				check(
					"T06: the approved check really ran and failed",
					evidence !== undefined && evidence.status === "failed",
					JSON.stringify(evidence ?? null),
				);
				check(
					"T06: the latest verdict is still correct, so only the check can block",
					reviewer !== undefined && reviewer.lastVerdict?.correct === true,
					JSON.stringify(reviewer?.lastVerdict ?? null),
				);
				check(
					"T06: a failing required check does not close done/verified",
					run.endReason !== "no-changes" && run.status !== "done" && run.endReason !== "verified",
					`observed ${run.status}/${run.endReason} for ${run.runId}; expected the check failure to block verified`,
				);
				check(
					"T06: the run summary index agrees with the record",
					summary !== undefined && summary.status === run.status && summary.endReason === run.endReason,
					summary === undefined ? "no index line" : `${summary.status}/${summary.endReason}`,
				);
				if (CONTRACT) {
					const obligation = resultFor(run, "checked-change");
					check(
						"T06 contract: the plan preserved the qualitative result",
						hasRequiredResult(run, "write", "checked-change", "change") && planned !== undefined && planned.path === undefined && planned.contains === undefined && planned.check === undefined,
						JSON.stringify(planned ?? null),
					);
					check(
						"T06 contract: the reviewer accepts the obligation while the failed check keeps the run unverified",
						obligation !== undefined &&
							obligation.state === "accepted" &&
							laneIs(obligation.lane, "write") &&
							attemptMatches(obligation.attemptId, spawn?.spawnKey) &&
							run.status !== "done" &&
							run.endReason !== "verified",
						JSON.stringify({ obligation: obligation ?? null, spawnKey: spawn?.spawnKey ?? null, run: `${run.status}/${run.endReason}` }),
					);
				}
			});
		} finally {
			rmSync(targetPath, { force: true });
		}
	});

	await suite.step("T01/T06: product state stayed out of the user's files", async () => {
		const final = readFileSync(reportPath);
		check("T01: report.json survived every run byte-identically", hash(final) === reportHash, `sha=${hash(final)} expected=${reportHash}`);
		check("T01: no worker wrote the user's report path", !final.toString().includes("storm child change") && !final.toString().includes("storm-child-bash"), JSON.stringify(final.toString().slice(0, 120)));
		const status = gitStatus();
		check("the project still answers git status", status !== undefined && !existsSync(join(env.project, ".git", "index.lock")), `index.lock=${existsSync(join(env.project, ".git", "index.lock"))} status=${JSON.stringify(status)}`);
		check("every OMP session exited cleanly", exitCodes.length > 0 && exitCodes.every(code => code === 0), `exit=${exitCodes.join(",")}`);
	});

	const commit = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short=7", "HEAD"]).stdout.toString().trim();
	const logFile = join(env.logs, `acceptance-${mode}.json`);
	console.log("     T06 note: missing/stale check evidence is unit-covered at tests/rounds.test.ts:550,602,583; this E2E does not claim those host conditions.");
	writeFileSync(logFile, `${JSON.stringify({ mode, contract: CONTRACT, commit, port: env.port, work: env.work, runs: observations }, null, 2)}\n`);
	console.log(`     observations: ${logFile}`);
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
