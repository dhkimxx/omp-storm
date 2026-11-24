#!/usr/bin/env bun
/** One real OMP restart: attached evidence skips successful jobs, not the one that failed. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVE } from "../../src/proposals/present.ts";
import {
	choose, linkPlugin, LlmCursor, modelsYml, prepare, PROFILE_CONFIG, Rpc, StormFiles, Suite, startFakeLlm, TEAM_PROVIDERS,
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
				return { resume: original.sessionId, sessionDir: original.sessionDir, first };
			} finally {
				await original.close();
			}
		})();
		const cursor = new LlmCursor(env);
		const resumed = new Rpc(env, choose("끝나지 않은 실행 이어 가기"), { model, resume: identity.resume, sessionDir: identity.sessionDir });
		try {
			await resumed.ready();
			const files = new StormFiles(env, resumed.sessionId);
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
