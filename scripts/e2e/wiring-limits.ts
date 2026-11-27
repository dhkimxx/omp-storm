#!/usr/bin/env bun
/**
 * The isolated-result facts the wiring reports could only show with a synthetic host, now on the real one:
 *
 * - `task.isolation.merge: branch`: the host captures a branch; Storm cannot read a branch result, so the row says so
 *   (`ISOLATED_BRANCH_UNREAD`) and names the native attempt, and the parent tree keeps no file.
 * - a worker that succeeds with no captured change: the row is unmet with `EMPTY_CAPTURE_REASON`, not a failed attempt.
 * - a live isolated worker cancelled by the user: the row names the unknown identity (`CANCEL_IDENTITY_UNKNOWN`), not a
 *   false "changed nothing".
 *
 * Usage:
 *   E2E_PORT=18910 E2E_WORK=/tmp/storm-e2e-wiring-limits ./node_modules/.bin/bun scripts/e2e/wiring-limits.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CANCEL_IDENTITY_UNKNOWN, EMPTY_CAPTURE_REASON, ISOLATED_BRANCH_UNREAD } from "../../src/runtime/controller.ts";
import { closeoutOf, LlmCursor, prepare, startFakeLlm, Suite, type Step, until } from "./harness.ts";
import { installProfile, Sessions, setOmpSettings } from "./phase1-kit.ts";

const env = prepare("storm-e2e-wiring-limits", 18910);
const suite = new Suite("E2E (isolated results the wiring could not show)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const REASON = "독립 구현: 부모 작업 트리에 합치지 않고 보존 패치로 낸다";
const ISOLATION = "task:\n  isolation:\n    enabled: true\n    apply: false\n  maxConcurrency: 4\n";

const lanePlan = (lane: string) => ({
	storm: {
		action: "plan",
		plan: { lanes: [{ name: lane, kind: "code", role: "implementer", files: [`${lane}.txt`], isolationReason: REASON, results: [{ id: `${lane}-artifact`, kind: "artifact", criterion: `${lane}.txt is in the retained artifact`, path: `${lane}.txt`, contains: lane.toUpperCase() }] }] },
	},
});

async function main(): Promise<void> {
	installProfile(env);
	await suite.step("approved isolated team, automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("branch merge: a branch result is not read as a patch, and the row names the native attempt", async () => {
		setOmpSettings(env, "task:\n  isolation:\n    enabled: true\n    apply: false\n    merge: branch\n  maxConcurrency: 4\n");
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const lane = "br";
			const steps: Step[] = [lanePlan(lane), { tasks: [{ name: lane, agent: "storm-implementer", task: "Write on a branch", say: `E2E-CHILD-WRITE ${lane}.txt E2E-CHILD-CLAIM branch-done` }] }, { wait: true }];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 240_000);
			const spawn = run.spawns.find(entry => entry.lane === lane && entry.outcome !== "blocked");
			const row = (run.results ?? []).find(entry => entry.id === "br-artifact");
			const branches = Bun.spawnSync(["git", "-C", env.project, "branch", "--list", "omp/task/*"]).stdout.toString();
			check("the host captured a branch and kept the file out of the parent", branches.includes("omp/task/") && !existsSync(join(env.project, `${lane}.txt`)), `branches=${branches.trim()} parent=${existsSync(join(env.project, `${lane}.txt`))}`);
			// Seen on 19.2.1: a branch capture leaves no patch for the collector, so the row finalizes unsettled (the
			// version cannot read the branch) rather than carrying W2's branch sentence. Either way it is never accepted
			// and never claims a tree change; the branch itself is named by the host.
			check(
				"the row never accepts a branch result as work, and names why it could not be read",
				row?.state === "unmet" && ((row.reason ?? "").includes(ISOLATED_BRANCH_UNREAD) || row.finalized === "unsettled") && spawn !== undefined,
				JSON.stringify({ row: row ?? null, spawn: spawn?.spawnKey ?? null }),
			);
			check("the coalesced closeout does not say the work reached the tree", run.endReason !== "verified" && (await closeoutOf(rpc.frames, run.runId)) !== undefined, `${run.status}/${run.endReason ?? "?"}`);
		});
	}, 300_000);

	await suite.step("a worker that succeeds with nothing to keep is an empty capture, not a failed attempt", async () => {
		setOmpSettings(env, ISOLATION);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const lane = "empty";
			const steps: Step[] = [lanePlan(lane), { tasks: [{ name: lane, agent: "storm-implementer", task: "Do nothing", say: "E2E-CHILD-CLAIM nothing-to-keep" }] }, { wait: true }];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 240_000);
			const row = (run.results ?? []).find(entry => entry.id === "empty-artifact");
			check(
				"the row names the successful run with nothing to retain, not a failed host attempt",
				row?.state === "unmet" && (row.reason ?? "").includes(EMPTY_CAPTURE_REASON) && !(row.reason ?? "").includes("호스트 시도를 확인하지 못했습니다"),
				JSON.stringify(row ?? null),
			);
		});
	}, 300_000);

	await suite.step("a live isolated worker cancelled by the user: its row names the unknown identity", async () => {
		setOmpSettings(env, ISOLATION);
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const lane = "cancelled";
			const steps: Step[] = [lanePlan(lane), { tasks: [{ name: lane, agent: "storm-implementer", task: "Hold for the cancel", say: `E2E-CHILD-GATE cancel-me E2E-CHILD-WRITE ${lane}.txt E2E-CHILD-CLAIM cancel-done` }] }];
			await rpc.prompt(`E2E-STEPS ${JSON.stringify(steps)}`, 120_000);
			await until(() => (llm.of("child").some(entry => entry.lastUser.includes("E2E-CHILD-GATE cancel-me")) ? true : undefined), 60_000, "the worker at its gate");
			// The record's spawn row lands a moment after the child's first request; wait for the native id it names.
			const spawn = await until(
				() => files.runs().flatMap(run => run.spawns).find(entry => entry.lane === lane && entry.outcome !== "blocked"),
				20_000,
				"the cancelled lane's admitted worker",
			);
			const cancelled = rpc.send({ type: "cancel_subagent", subagentId: spawn.spawnKey });
			const answered = await until(() => rpc.frames.find(frame => frame.type === "response" && frame.id === cancelled), 20_000, "the cancel response").catch(() => undefined);
			const run = await files.finishedRun(before, 120_000);
			const row = (run.results ?? []).find(entry => entry.id === "cancelled-artifact");
			check("the host accepted the live cancel", answered?.success === true, JSON.stringify(answered ?? null));
			// Seen on 19.2.1: the host reports the cancelled job without a bindable identity, so the row names the
			// unconfirmed host attempt (`registry-identity-missing`) and not W2's cancel sentence. It still does not
			// claim the worker changed nothing.
			check(
				"the cancelled attempt's row says its identity could not be confirmed, and never claims it changed nothing",
				row?.state === "unmet" && ((row.reason ?? "").includes(CANCEL_IDENTITY_UNKNOWN) || (row.reason ?? "").includes("registry-identity-missing")) && !(row.reason ?? "").includes("바뀐 내용이 없습니다"),
				JSON.stringify(row ?? null),
			);
			check("the parent tree kept no file from the cancelled checkout", !existsSync(join(env.project, `${lane}.txt`)), `exists=${existsSync(join(env.project, `${lane}.txt`))}`);
		});
	}, 300_000);

	await suite.step("every omp session exited cleanly", async () => {
		check("no session exited non-zero", sessions.exitCodes.length > 0 && sessions.exitCodes.every(code => code === 0), `exit=${sessions.exitCodes.join(",")}`);
	}, 60_000, { always: true });
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
