#!/usr/bin/env bun
/**
 * Result-first user steering in a real interactive OMP session: one manual Storm run declares three independent
 * answer results, its director waits on a held child, and the user types two ordinary composer messages while the
 * run is active. The first excludes the unstarted UI leaf by user scope; the second asks for the genuinely unmet API
 * result alone to be retried. The fixture proves one run, one extra normal attempt on that lane, no UI spawn, an
 * untouched accepted investigation, the same declared criterion labels at the bound plan, status report and final
 * brief, and the focused declared label plus separate counts on the live chip.
 *
 * Usage: bun scripts/e2e/result-direction.ts   (env: see harness.ts; E2E_PORT/E2E_WORK apply)
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, RunResult } from "../../src/types.ts";
import { RUN_APPEARANCE, STORM_MARK } from "../../src/view/appearance.ts";
import {
	approveTeam,
	cancelAll,
	KEY,
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
	Tui,
	until,
	CLOSEOUT_DETAIL,
	CLOSEOUT_HEADING,
} from "./harness.ts";
import { FACT_CLAIM, FACT_FILE, FACT_LINE, seedFact } from "./typed-fixture.ts";

const env = prepare("storm-e2e-result-direction", 18562);
seedFact(env.project);
const suite = new Suite("E2E (result-direction)", env);
const check = suite.check.bind(suite);

const MAIN = "fake/general-b";
const SEED = "Storm result-direction fixture transcript.";
const FIRST_INPUT = "UI는 빼고 API만 계속해";
const RETRY_INPUT = "실패한 API 검증만 다시 해";
const ORIGIN_LABEL = "원본 행 수";
const API_LABEL = "API 검증";
const UI_LABEL = "UI 미리보기";
const LABELS = [ORIGIN_LABEL, API_LABEL, UI_LABEL] as const;
/** Key hints of Storm's report overlay, which Enter closes. */
const OVERLAY_HINT = "PgDn";

/** The typed fixture line and a claim that restates its signed typed value: accepted mechanically, no reviewer needed. */
const READ_AND_CLAIM = `E2E-CHILD-READ ${FACT_FILE} E2E-CHILD-CLAIM ${FACT_CLAIM}`;
/** No source citation: the answer evaluator records this attempt as genuinely unmet, not as a host failure. */
const API_UNMET = "E2E-CHILD-DELAY 15000 E2E-CHILD-CLAIM API 검증 결과는 아직 확인하지 못했습니다";
const API_RETRY = `Retry the failed API verification against source. ${READ_AND_CLAIM}`;
const RELEASE_RETRY_ROUND = "release-retry-round";

const b64 = (value: unknown): string => `b64:${Buffer.from(JSON.stringify(value)).toString("base64")}`;
const results = (run: RunRecord | undefined): RunResult[] => run?.results ?? [];
const row = (run: RunRecord | undefined, id: string): RunResult | undefined => results(run).find(candidate => candidate.id === id);
const allLabels = (text: string): boolean => LABELS.every(label => text.includes(label));

interface NormalizedRow {
	id: string;
	state: RunResult["state"];
	scope?: string;
	criterion?: string;
	attempt?: string;
	version?: string;
	remedy?: string;
	retryRoute?: string;
	proof: boolean;
}

/** The bounded facts this fixture reads from one ledger row: no raw record, no incidental reason text. */
function normalize(value: RunResult | undefined): NormalizedRow | undefined {
	if (value === undefined) return undefined;
	const criterion = value.contract?.criterion;
	return {
		id: value.id,
		state: value.state,
		...(value.scope === undefined ? {} : { scope: value.scope }),
		...(typeof criterion === "string" ? { criterion } : {}),
		...(value.attemptId === undefined ? {} : { attempt: value.attemptId }),
		...(value.contentVersion === undefined ? {} : { version: value.contentVersion }),
		...(value.remedy === undefined ? {} : { remedy: value.remedy }),
		...(value.retryRoute === undefined ? {} : { retryRoute: value.retryRoute }),
		proof: value.proof !== undefined,
	};
}

const answer = (id: string, criterion: string): Record<string, unknown> => ({
	id,
	kind: "answer",
	criterion,
	path: FACT_FILE,
	contains: FACT_LINE,
});

/** One manual run: an accepted investigation, a failing API verification, and an undispatched UI leaf. */
const steps: Step[] = [
	{
		storm: {
			action: "plan",
			plan: {
				lanes: [
					{ name: "origin", kind: "explore", role: "explorer", results: [answer("origin-count", ORIGIN_LABEL)] },
					{ name: "api-verify", kind: "explore", role: "explorer", results: [answer("api-check", API_LABEL)] },
					{ name: "ui-preview", kind: "explore", role: "explorer", results: [answer("ui-preview", UI_LABEL)] },
				],
			},
		},
	},
	{ tasks: [{ name: "origin", agent: "storm-explorer", task: "Report the original line from source", say: READ_AND_CLAIM }] },
	{ wait: true },
	{ tasks: [{ name: "api-verify", agent: "storm-explorer", task: "Verify the API criterion from source", say: API_UNMET }] },
	// Hold this child long enough to exclude the untouched UI leaf while the director is waiting.
	{ wait: true },
	// The host's retry nudge — not the raw input — admits this one normal retry on the existing lane and contract.
	{
		followUp: "agent://api-verify",
		content: API_RETRY,
		// OMP can deliver the child output in the wait tool receipt or in a later asynchronous user message.
		after: 'action="retry"',
		releaseFile: { name: RELEASE_RETRY_ROUND, receipt: "API 검증 결과는 아직 확인하지 못했습니다" },
	},
	{ wait: true },
];

async function main(): Promise<void> {
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	linkPlugin(env);

	// One real native session, approved through RPC, then resumed by the interactive host so the fixture has a live
	// transcript and Storm store before the run starts.
	const seed = new Rpc(env, cancelAll, { model: MAIN });
	let owned: { id: string; dir: string };
	try {
		await seed.ready();
		await seed.turn(SEED);
		await approveTeam(seed, "off");
		await seed.identify();
		owned = { id: seed.sessionId, dir: seed.sessionDir };
	} finally {
		await seed.close();
	}
	const files = new StormFiles(env, owned.id);
	if (!existsSync(files.configFile) || files.approvals().length === 0) throw new Error("the fixture team was not approved");

	await suite.step(
		"result-first steering excludes one leaf and retries only the failed API result",
		async () => {
			const before = files.runIds();
			const llm = new LlmCursor(env);
			const tui = new Tui(env, { model: MAIN, flags: ["--motion", "full"], resume: owned.id, sessionDir: owned.dir });
			try {
				await tui.ready();
				await tui.shows(SEED);
				const started = await tui.submit(`/storm E2E-ROUTE ${b64({ action: "run" })} E2E-STEPS ${b64(steps)}`);

				const bound = await until(
					() => {
						const run = files.runs().find(candidate => !before.has(candidate.runId) && candidate.plan?.lanes.length === 3);
						return run !== undefined && run.status === "running" ? run : undefined;
					},
					60_000,
					"the one run to bind the three-result plan",
				);
				const runId = bound.runId;
				const startText = await tui.seen(
					started,
					text => (allLabels(text) ? text : undefined),
					"the first bound plan to list all three declared result labels",
					30_000,
				);
				check("the bound plan lists every declared result label", LABELS.filter(label => startText.includes(label)).length === 3, startText.slice(-500));

				// The independent investigation settles first; the API child is already running and delayed, so the run
				// stays active while the composer accepts the two human messages.
				const prepared = await until(
					() => {
						const run = files.run(runId);
						const origin = row(run, "origin-count");
						const api = row(run, "api-check");
						return run?.status === "running" && origin?.state === "accepted" && api?.state === "pending" ? run : undefined;
					},
					60_000,
					"the accepted investigation and the running API attempt",
				);
				const originBefore = normalize(row(prepared, "origin-count"));
				await until(
					() => {
						const main = llm.of("main");
						const apiTask = main.find(entry => entry.decision.tool === "task" && JSON.stringify(entry.decision.args ?? {}).includes("Verify the API criterion"));
						return apiTask !== undefined && main.some(entry => entry.ts >= apiTask.ts && entry.decision.tool === "wait") ? true : undefined;
					},
					30_000,
					"the director's held native wait after the API task",
				);

				const runAtFirst = files.run(runId);
				check("the first steering input arrives while its run is active", runAtFirst?.status === "running", `${runAtFirst?.status}`);
				const firstMark = await tui.submit(FIRST_INPUT);
				/* The run remains active here; the excluded row is a persisted scope change, never a new run. */
				const excluded = await until(
					() => {
						const run = files.run(runId);
						return row(run, "ui-preview")?.scope === "excluded-by-user" ? run : undefined;
					},
					30_000,
					"the UI result to be excluded by the user",
				);
				const uiAtExclusion = normalize(row(excluded, "ui-preview"));
				const originAtExclusion = normalize(row(excluded, "origin-count"));
				check(
					"the first native input excludes the unstarted UI leaf without accepting it",
					uiAtExclusion?.scope === "excluded-by-user" && uiAtExclusion.state !== "accepted" && uiAtExclusion.attempt === undefined && uiAtExclusion.version === undefined && uiAtExclusion.proof === false,
					JSON.stringify(uiAtExclusion),
				);
				check("the excluded leaf keeps its declared contract", uiAtExclusion?.criterion === UI_LABEL, JSON.stringify(uiAtExclusion));
				check("the accepted independent investigation is untouched by the exclusion", JSON.stringify(originAtExclusion) === JSON.stringify(originBefore), `${JSON.stringify(originBefore)} → ${JSON.stringify(originAtExclusion)}`);
				check(
					"no UI worker was spawned by either input",
					(files.run(runId)?.spawns ?? []).every(spawn => spawn.lane !== "ui-preview" && (spawn.spawnKey ?? "").includes("ui-preview") === false),
					JSON.stringify((files.run(runId)?.spawns ?? []).map(spawn => [spawn.lane, spawn.spawnKey, spawn.agent])),
				);

				// The active-run status is the full result surface: every row, including the operator exclusion.
				const statusAt = await tui.submit("/storm status");
				await tui.shows(OVERLAY_HINT, statusAt, 30_000);
				const statusText = await tui.seen(
					statusAt,
					text => (allLabels(text) ? text : undefined),
					"the active status report with all three result labels",
					30_000,
				);
				check("the status report keeps the same three declared result labels", allLabels(statusText), statusText.slice(-800));
				check("the status report counts accepted in-scope results apart from the exclusion", /이행\s*1\/2/u.test(statusText) && /제외\s*1/u.test(statusText), statusText.slice(-800));
				tui.send(KEY.enter);

				// The retry is requested only after the delayed first attempt has settled as a genuinely unmet row.
				const unmet = await until(
					() => {
						const run = files.run(runId);
						const apiSpawns = (run?.spawns ?? []).filter(spawn => spawn.lane === "api-verify" && spawn.outcome !== "blocked");
						const explorers = (run?.agents ?? []).filter(agent => agent.role === "explorer");
						const api = row(run, "api-check");
						return run?.status === "running" && apiSpawns.length === 1 && explorers.length >= 2 && explorers.every(agent => agent.state === "idle") && api?.state === "unmet" && api.attemptId !== undefined ? { run, api } : undefined;
					},
					60_000,
					"the first API attempt to settle unmet",
				);
				const apiFirst = normalize(unmet.api);
				check(
					"the first API attempt is genuinely unmet without host retry exhaustion",
					apiFirst?.state === "unmet" && apiFirst.attempt !== undefined && apiFirst.remedy !== "retry" && apiFirst.retryRoute === undefined,
					JSON.stringify(apiFirst),
				);
				const runAtSecond = files.run(runId);
				check("the retry steering input arrives while the same run is still active", runAtSecond?.status === "running", `${runAtSecond?.status}`);
				const retryInputAt = Date.now();
				await tui.submit(RETRY_INPUT);
				await until(
					() => files.run(runId)?.adjustments?.some(entry => entry.kind === "retry" && entry.id === "api-check") || undefined,
					20_000,
					"the retry request to bind to the host-settled attempt",
				);
				writeFileSync(join(env.work, RELEASE_RETRY_ROUND), "");

				// The live chip names the first declared criterion it is focused on and keeps the official counts apart:
				// one accepted in-scope result, one pending, one operator exclusion. It is not the final card.
				const liveText = await tui.seen(
					firstMark,
					text => {
						const phaseLabels = Object.values(RUN_APPEARANCE).map(appearance => appearance.label);
						const live = text.split("\n").some(line => line.includes(STORM_MARK) && phaseLabels.some(label => line.includes(label)));
						return live && text.includes(API_LABEL) && /이행\s*1\/2/u.test(text) && /제외\s*1/u.test(text) ? text : undefined;
					},
					"the live result chip with a declared label and separate counts",
					30_000,
				);
				check("the live result chip keeps a declared label and counts exclusions separately", liveText.includes(API_LABEL) && /이행\s*1\/2/u.test(liveText) && /제외\s*1/u.test(liveText), liveText.slice(-500));

				await until(
					() => files.run(runId)?.adjustments?.some(entry => entry.kind === "retry" && entry.takenAt !== undefined) || undefined,
					30_000,
					"the same-lane follow-up to consume the requested retry",
				);
				const final = await files.finishedRun(before, 120_000);
				const finalOrigin = normalize(row(final, "origin-count"));
				const finalApi = normalize(row(final, "api-check"));
				const finalUi = normalize(row(final, "ui-preview"));
				check("the two inputs left exactly one Storm run", files.runs().filter(candidate => !before.has(candidate.runId)).length === 1 && final.runId === runId, final.runId);
				check("the ledger keeps all three declared requirements", results(final).length === 3 && new Set(results(final).map(value => value.id)).size === 3, JSON.stringify(results(final).map(value => value.id)));
				const finalLabels = results(final).flatMap(value => {
					const criterion = value.contract?.criterion;
					return typeof criterion === "string" ? [criterion] : [];
				});
				check("the final ledger compares the same declared labels", finalLabels.length === 3 && new Set(finalLabels).size === 3 && finalLabels.every(label => LABELS.includes(label as (typeof LABELS)[number])), JSON.stringify(finalLabels));
				check(
					"the excluded UI row keeps its id and contract but stays unstarted",
					finalUi?.scope === "excluded-by-user" && finalUi.criterion === UI_LABEL && finalUi.state !== "accepted" && finalUi.attempt === undefined && finalUi.version === undefined && finalUi.proof === false,
					JSON.stringify(finalUi),
				);
				check(
					"the exclusion spawned no UI worker",
					(final.spawns ?? []).every(spawn => spawn.lane !== "ui-preview" && (spawn.spawnKey ?? "").includes("ui-preview") === false),
					JSON.stringify((final.spawns ?? []).map(spawn => [spawn.lane, spawn.spawnKey, spawn.agent])),
				);
				const adjustments = final.adjustments ?? [];
				const excludeAdjustment = adjustments.find(entry => entry.kind === "exclude" && entry.id === "ui-preview");
				const retryAdjustment = adjustments.find(entry => entry.kind === "retry" && entry.id === "api-check");
				check(
					"the ledger acknowledges exactly the user's exclusion and one retry",
					adjustments.length === 2 && excludeAdjustment !== undefined && excludeAdjustment.lane === "ui-preview" && retryAdjustment !== undefined && retryAdjustment.lane === "api-verify" && Date.parse(excludeAdjustment.at) <= Date.parse(retryAdjustment.at),
					JSON.stringify(adjustments),
				);
				check(
					"the retry acknowledgement was consumed by exactly one prepared attempt",
					retryAdjustment !== undefined && retryAdjustment.takenAt !== undefined && Date.parse(retryAdjustment.takenAt) >= Date.parse(retryAdjustment.at),
					JSON.stringify(retryAdjustment),
				);
				check(
					"the independent accepted investigation keeps its attempt and content version",
					originBefore !== undefined && finalOrigin !== undefined && finalOrigin.state === "accepted" && finalOrigin.attempt === originBefore.attempt && finalOrigin.attempt !== undefined && finalOrigin.version === originBefore.version && finalOrigin.version !== undefined,
					`${JSON.stringify(originBefore)} → ${JSON.stringify(finalOrigin)}`,
				);
				check("the retry accepts only after the source-citing attempt", finalApi?.state === "accepted" && finalApi.proof === true && finalApi.attempt !== undefined && finalApi.attempt !== apiFirst?.attempt, `${JSON.stringify(apiFirst)} → ${JSON.stringify(finalApi)}`);
				check(
					"the retry's final proof cites the declared source",
					row(final, "api-check")?.proof?.item.criterion === API_LABEL && row(final, "api-check")?.proof?.item.citation?.path === FACT_FILE,
					JSON.stringify(row(final, "api-check")?.proof),
				);
				check("the retry did not start a separate run", files.index().filter(line => line.runId === runId).length === 1, JSON.stringify(files.index().filter(line => line.runId === runId)));
				const apiNative = final.spawns?.find(spawn => spawn.lane === "api-verify" && spawn.outcome !== "blocked")?.spawnKey;
				check("the existing API worker received exactly one follow-up", apiNative !== undefined && final.agents?.find(agent => agent.id === apiNative)?.followUps === 1, JSON.stringify({ apiNative, agents: final.agents?.map(agent => [agent.id, agent.followUps]) }));
				check(
					"only the two declared lanes started workers; retry reused the API worker",
					(final.spawns ?? []).filter(spawn => spawn.outcome !== "blocked").length === 2 &&
						(final.spawns ?? []).filter(spawn => spawn.lane === "origin" || spawn.lane === "api-verify").length === 2 &&
						(final.spawns ?? []).filter(spawn => spawn.lane === "ui-preview").length === 0,
					JSON.stringify((final.spawns ?? []).map(spawn => [spawn.lane, spawn.spawnKey, spawn.outcome])),
				);
				check("the final run carries no remaining open requirement", results(final).every(value => value.state === "accepted" || value.scope === "excluded-by-user"), JSON.stringify(results(final).map(value => [value.id, value.state, value.scope])));

				// Per-result labels are ledger and status detail now (checked on the final record above). The compact card
				// keeps the official aggregate, where an operator exclusion stays a separate count, never an accepted one.
				const finalText = await tui.seen(
					started,
					text => {
						const at = text.lastIndexOf(CLOSEOUT_HEADING);
						return at >= 0 && /제외\s*1/u.test(text.slice(at)) ? text : undefined;
					},
					"the final closeout with the exclusion counted separately",
					60_000,
				);
				const report = finalText.slice(finalText.lastIndexOf(CLOSEOUT_HEADING));
				check(
					"the final closeout counts the exclusion apart and points to the status view for the rows",
					/제외\s*1/u.test(report) && report.includes(CLOSEOUT_DETAIL),
					report.slice(0, 900),
				);

				const mainEntries = llm.of("main");
				const retryNudge = mainEntries.find(entry => entry.users.some(value => value.includes("<storm-adjust") && value.includes('action="retry"')) || (entry.lastUser.includes("<storm-adjust") && entry.lastUser.includes('action="retry"')));
				const retryTasks = mainEntries.filter(entry => entry.decision.tool === "write" && JSON.stringify(entry.decision.args ?? {}).includes(API_RETRY));
				const retryTask = retryTasks[0];
				check(
					"the director saw the retry nudge only after the failed attempt and the retry input",
					retryNudge !== undefined && retryNudge.ts >= retryInputAt,
					`nudge=${retryNudge?.ts ?? "missing"} input=${retryInputAt}`,
				);
				check(
					"the retry task is dispatched only with the host's retry nudge in context",
					retryTask !== undefined && retryNudge !== undefined && retryTask.ts >= retryNudge.ts,
					`task=${retryTask?.ts ?? "missing"} nudge=${retryNudge?.ts ?? "missing"}`,
				);
				check("the native follow-up was sent once and only after user input", retryTasks.length === 1 && retryTask !== undefined && retryTask.ts >= retryInputAt, `count=${retryTasks.length} input=${retryInputAt}`);
				check(
					"no child was asked to work the excluded UI leaf",
					llm.of("child").every(entry => !entry.lastUser.includes(UI_LABEL) && !entry.lastUser.includes("ui-preview")),
					llm.of("child").filter(entry => entry.lastUser.includes(UI_LABEL) || entry.lastUser.includes("ui-preview")).map(entry => entry.lastUser.slice(0, 120)).join(" | "),
				);

			} finally {
				await tui.close();
			}
		},
		300_000,
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
