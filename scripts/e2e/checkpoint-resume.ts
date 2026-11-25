#!/usr/bin/env bun
/**
 * One real OMP restart: attached evidence skips successful jobs, not the one that failed. The stopped run's closeout
 * is checked as saved facts: its plain text and validated presentation metadata are in the native session file, so a
 * restarted host can draw it again (or show the readable plain text), and the status view read after the restart
 * carries the receipts the compact card no longer lists.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import {
	choose, CLOSEOUT_DETAIL, CLOSEOUT_HEADING, closeoutOf, linkPlugin, LlmCursor, modelsYml, persistedStormRecords, prepare, PROFILE_CONFIG, Rpc, StormFiles, stormRecords,
	Suite, startFakeLlm, TEAM_PROVIDERS, until,
} from "./harness.ts";

const env = prepare("storm-e2e-checkpoint", 18569);
const suite = new Suite("E2E (checkpoint restart)", env);
const provider = await startFakeLlm(env);
const model = "fake/general-b";
try {
	linkPlugin(env);
	writeFileSync(join(env.agentDir, "models.yml"), modelsYml(env.port, TEAM_PROVIDERS));
	writeFileSync(join(env.agentDir, "config.yml"), PROFILE_CONFIG);
	await suite.step("restart reuses the successful receipt and retries only the failed lane", async () => {
		const events = join(env.work, "job-events.log");
		const eventsArg = JSON.stringify(events);
		const starts = () => existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : [];
		const lanes = [
			{ name: "first", kind: "run", job: "first", results: [{ id: "first-receipt", kind: "answer", criterion: "observed first process exit", contains: "FIRST_READY" }] },
			{ name: "retry", kind: "run", job: "retry", dependsOn: [{ lane: "first", need: "result" }], results: [{ id: "retry-receipt", kind: "answer", criterion: "observed second process exit", contains: "RETRY_READY" }] },
		];
		const request = `E2E-ROUTE {"action":"run"} E2E-STEPS ${JSON.stringify([
			{ storm: { action: "plan", plan: { lanes } } },
			{ storm: { action: "status" } },
			{ storm: { action: "execute", lanes: ["first", "retry"] } },
		])}`;
		const original = new Rpc(env, choose(APPROVE), { model });
		const identity = await (async () => {
			try {
				await original.ready();
				await original.prompt("/storm");
				const files = new StormFiles(env, original.sessionId);
				files.editConfig(config => {
					config.rounds = 0;
					config.jobs = [
						{ name: "first", argv: [process.execPath, "-e", `require("node:fs").appendFileSync(${eventsArg},"first\\n"); console.log("FIRST_READY");`] },
						{ name: "retry", argv: [process.execPath, "-e", `const f=require("node:fs"), p=${eventsArg}; const prior=f.readFileSync(p,"utf8").includes("retry\\n"); f.appendFileSync(p,"retry\\n"); if(!prior)process.exit(7); console.log("RETRY_READY");`] },
					];
				});
				const approval = original.dialogs.length;
				await original.prompt("/storm");
				if (!original.dialogs.slice(approval).some(dialog => dialog.answer === APPROVE)) throw new Error("job definitions were not approved");
				const before = files.runIds();
				await original.turn(request);
				const first = await files.finishedRun(before, 20_000);
				suite.check("the original run observed one success and one real failure", first.status === "stopped" &&
					first.jobs?.some(job => job.name === "first" && job.status === "passed") === true &&
					first.jobs.some(job => job.name === "retry" && job.status === "failed" && job.exitCode === 7) &&
					starts().join(",") === "first,retry", JSON.stringify(first.jobs));
				// The team config's `rounds: 0` is an explicit limit: one round, recorded and reported as the round limit.
				suite.check("the config's rounds limit ends the run at its round limit", first.endReason === "round-limit" && first.maxRounds === 1 && first.turns === 1,
					`${first.status}/${first.endReason} turns=${first.turns} maxRounds=${first.maxRounds}`);
				// The index line that ends `finishedRun` is written before the settled-run message reaches the host; wait for it.
				const card = await until(() => closeoutOf(original.frames, first.runId), 30_000, "the stopped run's closeout").catch(() => undefined);
				suite.check("the stopped run leaves one whole closeout card with its status pointer", card !== undefined &&
					card.details?.kind === "closeout" && card.details.runId === first.runId && card.text.includes(CLOSEOUT_DETAIL) &&
					stormRecords(original.frames).filter(record => record.text.includes(CLOSEOUT_HEADING)).length === 1,
					JSON.stringify(card ?? null).slice(0, 800));
				// The host may write its transcript lazily: ask again now that the run has ended.
				const sessionFile = (await original.identify()).sessionFile;
				return { resume: original.sessionId, sessionDir: original.sessionDir, first, sessionFile, cardText: card?.text ?? "" };
			} finally {
				await original.close();
			}
		})();
		const cursor = new LlmCursor(env);
		const resumed = new Rpc(env, choose("끝나지 않은 실행 이어 가기"), { model, resume: identity.resume, sessionDir: identity.sessionDir });
		try {
			await resumed.ready();
			const savedRecords = identity.sessionFile === undefined ? [] : persistedStormRecords(identity.sessionFile).filter(record => record.details?.runId === identity.first.runId);
			const saved = savedRecords.length === 1 ? savedRecords[0] : undefined;
			suite.check("the closeout survives the restart as saved plain text with its validated metadata", saved !== undefined &&
				saved.text.trimStart().startsWith(`### ${CLOSEOUT_HEADING}`) && saved.text.includes(CLOSEOUT_DETAIL) &&
				saved.details?.kind === "closeout" && Array.isArray(saved.details.info) && identity.cardText.includes(saved.text.trim().slice(-40)),
				JSON.stringify(saved ?? { sessionFile: identity.sessionFile ?? "unknown", records: savedRecords.length }).slice(0, 800));
			const files = new StormFiles(env, resumed.sessionId);
			const statusFrom = resumed.frames.length;
			await resumed.prompt("/storm status");
			const status = stormRecords(resumed.frames, statusFrom).at(-1)?.text ?? "";
			suite.check("after the restart the status view still names the stopped run and its retried lane; the card listed no receipts", status.includes(identity.first.runId) &&
				status.includes("retry") && !identity.cardText.includes("잡 영수증"), status.slice(0, 1200));
			const before = files.runIds();
			await resumed.prompt("/storm");
			const second = await files.finishedRun(before, 30_000);
			const reused = second.results?.find(row => row.id === "first-receipt");
			const old = identity.first.results?.find(row => row.id === "first-receipt");
			suite.check("the restored producer lets the consumer succeed without rerunning it", second.resumeOf === identity.first.runId &&
				second.endReason === "verified" && starts().join(",") === "first,retry,retry" &&
				reused?.restoredFrom === identity.first.runId && reused.attemptId === old?.attemptId &&
				second.results?.some(row => row.id === "retry-receipt" && row.state === "accepted") === true,
				`${second.status}/${second.endReason} starts=${starts().join(",")} ${JSON.stringify(second.results)}`);
			suite.check("resume did not ask for a new team setup or create AI workers", resumed.dialogs.length === 1 && cursor.of("child").length === 0);
			suite.check("the director can see accepted and reopened result IDs on demand", resumed.frames.some(frame =>
				frame.type === "tool_execution_end" && frame.toolName === "storm" &&
				["Storm 실행 계획·필수 결과:", "first-receipt", "retry-receipt"].every(part => JSON.stringify(frame.result).includes(part))));
		} finally {
			await resumed.close();
		}
	});
} finally {
	provider.kill();
	await provider.exited;
}
process.exitCode = suite.finish();
