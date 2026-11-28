#!/usr/bin/env bun
/**
 * A team of isolated implementers, real host, the way the owner uses it. Four implementers with a shell on planned
 * isolated lanes, then four without a plan (D10), each in its own checkout, really overlapping; a shared writer beside
 * them is not refused for writer order. Every surface tells the truth afterwards: what is kept and where, that nothing
 * reached the main tree, that a `change` declared on an isolated lane is not accepted and why, that a prerequisite that
 * needs integration cannot be met in this version, and that a checkout is a placement, not a wall.
 *
 * Host settings: `task.isolation.enabled: true`, `task.isolation.apply: false` (the two settings isolation needs).
 *
 * Usage:
 *   E2E_PORT=18909 E2E_WORK=/tmp/storm-e2e-implementer-team ./node_modules/.bin/bun scripts/e2e/implementer-team.ts
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { ISOLATED_CHANGE_REASON } from "../../src/runtime/result-evidence.ts";
import { CHECKOUT_CLEANUP_NOTE, CHECKOUT_PLACEMENT_NOTE } from "../../src/runtime/contract-text.ts";
import { NO_DECLARED_RESULTS } from "../../src/runtime/result-facts.ts";
import { END_LABEL, NO_DECLARED_END_LABEL, NO_DECLARED_END_REASON } from "../../src/runtime/rounds.ts";
import { HANDOFF_RESUME_LABEL } from "../../src/runtime/resume.ts";
import { RETAINED_ONLY_VERDICT } from "../../src/runtime/closeout.ts";
import { RETAINED_ACCEPTED, RETAINED_LABEL } from "../../src/view/results.ts";
import { CHECKOUT_PLAN_NOTE, ISOLATED_INTEGRATED_WARNING } from "../../src/plan/validate.ts";
import { closeoutOf, customMessage, LlmCursor, prepare, startFakeLlm, Suite, type Frame, type Step, until } from "./harness.ts";
import { installProfile, Sessions } from "./phase1-kit.ts";

const env = prepare("storm-e2e-implementer-team", 18909);
const suite = new Suite("E2E (a team of isolated implementers)", env);
const check = suite.check.bind(suite);
const sessions = new Sessions(env);
const REASON = "독립 구현: 부모 작업 트리에 합치지 않고 보존 패치로 낸다";
const WORKERS = 4;

const text = (frame: Frame): string => {
	const result = frame.result;
	if (!result || typeof result !== "object" || !("content" in result)) return "";
	const content = result.content;
	return Array.isArray(content) ? content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n") : "";
};
const taskText = (frames: readonly Frame[]): string => frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task").map(text).join("\n");
const stormText = (frames: readonly Frame[]): string => frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "storm").map(text).join("\n");
const real = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};
const outsideProject = (path: string): boolean => {
	const project = real(env.project);
	const resolved = real(path);
	return resolved !== project && !resolved.startsWith(`${project}${sep}`);
};
const markerDir = (name: string): string => {
	const dir = join(env.work, "markers", name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
};
const readMarker = (dir: string, name: string): string => {
	const path = join(dir, name);
	return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
};
const shq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** A shell probe: physical cwd, the second it starts, the file it writes there, a 4 s hold, the second it ends. */
function probe(dir: string, name: string, file: string, literal: string): string {
	return [
		`pwd -P > ${shq(join(dir, `cwd-${name}`))}`,
		`date +%s > ${shq(join(dir, `start-${name}`))}`,
		`printf '%s\\n' ${shq(literal)} > ${file}`,
		"sleep 4",
		`date +%s > ${shq(join(dir, `end-${name}`))}`,
	].join("; ");
}
const seconds = (dir: string, name: string): number[] => [readMarker(dir, `start-${name}`), readMarker(dir, `end-${name}`)].map(Number).filter(value => Number.isFinite(value) && value > 0);
/** The patch paths the host reported for retained isolated changes. */
function patches(frames: readonly Frame[]): string[] {
	const said = [
		...frames.filter(frame => customMessage(frame) === "async-result").map(frame => JSON.stringify(frame)),
		...frames.filter(frame => frame.type === "tool_execution_end" && frame.toolName === "task").map(text),
	].join("\n");
	return [...said.matchAll(/Isolation: changes captured at `([^`]+)`/g)].map(match => match[1] ?? "").filter(Boolean);
}

async function main(): Promise<void> {
	installProfile(env, "task:\n  isolation:\n    enabled: true\n    apply: false\n  maxConcurrency: 8\n");
	await suite.step("approved isolated team, automatic delegation on", async () => {
		const { teams } = await sessions.approve("on");
		check("the recommended team is approved with automatic delegation on", teams === 1, `approvals=${teams}`);
	}, 120_000, { always: true });

	await suite.step("four planned isolated implementers run at once, each in its own checkout, and the card says what was kept", async () => {
		const dir = markerDir("planned-four");
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const names = Array.from({ length: WORKERS }, (_, index) => `team-${index}`);
			const lanes = names.map((name, index) => ({
				name,
				kind: "code" as const,
				role: "implementer" as const,
				files: [`${name}.txt`],
				goal: "Independent implementation",
				isolationReason: REASON,
				results: [{ id: `${name}-artifact`, kind: "artifact" as const, criterion: `${name}.txt is in the retained patch`, path: `${name}.txt`, contains: `LANE-${index}` }],
			}));
			const steps: Step[] = [
				{ storm: { action: "plan", plan: { lanes } } },
				{
					tasks: names.map((name, index) => ({
						name,
						agent: "storm-implementer",
						task: "Implement independently",
						say: `E2E-CHILD-DELAY 6000 E2E-CHILD-SH ${b64(probe(dir, name, `${name}.txt`, `LANE-${index}`))}`,
					})),
				},
				{ wait: true },
			];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 240_000);
			const frames = rpc.frames;
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			const cwds = names.map(name => readMarker(dir, `cwd-${name}`));
			const starts = names.map(name => seconds(dir, name)[0] ?? 0);
			const ends = names.map(name => seconds(dir, name)[1] ?? 0);
			const overlapped = starts.every(value => value > 0) && ends.every(value => value > 0) && Math.max(...starts) < Math.min(...ends);
			// The first request of each child: the same assignment repeats for its second request.
			const firstByAssignment = new Map<string, number>();
			for (const entry of llm.of("child")) if (!firstByAssignment.has(entry.lastUser)) firstByAssignment.set(entry.lastUser, entry.ts);
			const first = [...firstByAssignment.values()].sort((a, b) => a - b);
			const closeout = await until(() => closeoutOf(rpc.frames, run.runId), 10_000, "the retained closeout").catch(() => undefined);
			check("the plan reply names the checkout as a placement and carries the qualified plan", stormText(frames).includes(CHECKOUT_PLAN_NOTE), stormText(frames).slice(0, 400));
			check(
				"all four spawned and none was refused for writer order",
				routed.length === WORKERS && run.spawns.every(spawn => spawn.outcome !== "blocked") && !taskText(frames).includes("[storm:lane-write]"),
				JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.code])),
			);
			check(
				"each ran in its own checkout outside the parent",
				cwds.every(cwd => cwd !== "" && outsideProject(cwd)) && new Set(cwds.map(cwd => real(cwd))).size === WORKERS,
				JSON.stringify(cwds),
			);
			check("the four really overlapped: first requests close together and four 4 s shell windows at once", first.length === WORKERS && first.at(-1)! - first[0]! < 3_000 && overlapped, `first=${JSON.stringify(first.map(ts => ts - first[0]!))} starts=${JSON.stringify(starts)} ends=${JSON.stringify(ends)}`);
			check("the parent tree received none of their files", names.every(name => !existsSync(join(env.project, `${name}.txt`))), names.map(name => existsSync(join(env.project, `${name}.txt`))).join(","));
			const kept = patches(frames);
			check("each native result names a retained patch outside the parent", kept.length >= WORKERS && kept.every(path => outsideProject(path)), JSON.stringify(kept));
			check(
				"all four artifact results were accepted as kept, not as tree changes",
				(run.results ?? []).filter(row => row.state === "accepted").length === WORKERS && (run.results ?? []).every(row => row.state === "accepted"),
				JSON.stringify((run.results ?? []).map(row => [row.id, row.state, row.reason ?? ""])),
			);
			check(
				"the card says retained 4/4, where the bytes are kept, and that Storm applied nothing",
				closeout !== undefined &&
					closeout.text.includes(`${RETAINED_ACCEPTED} 4/4`) &&
					closeout.text.includes(`${RETAINED_LABEL}:`) &&
					closeout.text.includes(RETAINED_ONLY_VERDICT) &&
					closeout.text.includes(CHECKOUT_PLACEMENT_NOTE) &&
					closeout.text.includes(CHECKOUT_CLEANUP_NOTE),
				closeout?.text.slice(-900) ?? "no closeout",
			);
			check("the record's own isolated lanes were kept", (run.results ?? []).every(row => row.proof !== undefined), JSON.stringify((run.results ?? []).map(row => [row.id, row.proof?.item?.artifact ?? null])));
		});
	}, 400_000);

	await suite.step("a change is not accepted on an isolated lane, an integration prerequisite cannot be met, and a shell can leave the checkout", async () => {
		const dir = markerDir("planned-limits");
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const steps: Step[] = [
				{
					storm: {
						action: "plan",
						plan: {
							lanes: [
								{ name: "chg", kind: "code", role: "implementer", files: ["chg.txt"], isolationReason: REASON, results: [{ id: "chg-change", kind: "change", criterion: "chg.txt carries the change in the parent", path: "chg.txt", contains: "CHG" }] },
								{ name: "dep", kind: "code", role: "implementer", files: ["dep.txt"], goal: "Consume the integrated change", dependsOn: [{ lane: "chg", need: "integrated" }], results: [{ id: "dep-answer", kind: "answer", criterion: "the change is in the parent" }] },
								{ name: "esc", kind: "code", role: "implementer", files: ["esc.txt"], isolationReason: REASON, results: [{ id: "esc-artifact", kind: "artifact", criterion: "esc.txt is in the retained patch", path: "esc.txt", contains: "ESC" }] },
							],
						},
					},
				},
				{ tasks: [{ name: "chg", agent: "storm-implementer", task: "Change the file", say: `E2E-CHILD-DELAY 4000 E2E-CHILD-WRITE chg.txt E2E-CHILD-CLAIM change-done` }] },
				{ tasks: [{ name: "dep", agent: "storm-implementer", task: "Consume the integrated change", say: "E2E-CHILD-CLAIM dep-done" }] },
				{ tasks: [{ name: "esc", agent: "storm-implementer", task: "Leave the checkout", say: `E2E-CHILD-DELAY 4000 E2E-CHILD-SH ${b64(`pwd -P > ${shq(join(dir, "esc-cwd"))}; printf 'ESCAPED\\n' > ${shq(join(env.project, "escaped-outside.txt"))}; printf 'ESC\\n' > esc.txt`)} E2E-CHILD-CLAIM esc-done` }] },
				{ wait: true },
			];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 300_000);
			const run = await files.finishedRun(before, 240_000);
			const frames = rpc.frames;
			const closeout = await until(() => closeoutOf(rpc.frames, run.runId), 10_000, "the limits closeout").catch(() => undefined);
			const chg = (run.results ?? []).find(row => row.id === "chg-change");
			const esc = (run.results ?? []).find(row => row.id === "esc-artifact");
			const planReply = stormText(frames);
			check("the plan reply warns that an integrated prerequisite cannot be met", planReply.includes(ISOLATED_INTEGRATED_WARNING), planReply.slice(0, 600));
			check(
				"the isolated change is unmet with the version's reason and never accepted",
				chg?.state === "unmet" && (chg.reason ?? "").includes(ISOLATED_CHANGE_REASON) && !existsSync(join(env.project, "chg.txt")),
				JSON.stringify({ row: chg ?? null, parent: existsSync(join(env.project, "chg.txt")) }),
			);
			const framesText = frames.map(frame => JSON.stringify(frame)).join("\n");
			const dep = (run.results ?? []).find(row => row.id === "dep-answer");
			check(
				"the integration-required consumer starts with the version's shortfall note and is not accepted on it",
				framesText.includes("통합 반영 조건이 충족되기 전에 시작했습니다") && framesText.includes("이 버전은 격리 작업을 부모 트리로 가져오지 않으므로") && dep?.state !== "accepted" && run.endReason !== "verified",
				`dep=${JSON.stringify(dep ?? null)} end=${run.status}/${run.endReason ?? "?"} note=${framesText.includes("통합 반영 조건이 충족되기 전에 시작했습니다")}`,
			);
			const escCwd = readMarker(dir, "esc-cwd");
			check(
				"a checkout is a placement, not a wall: its shell wrote the parent from outside the checkout",
				escCwd !== "" && outsideProject(escCwd) && existsSync(join(env.project, "escaped-outside.txt")),
				`cwd=${escCwd || "(missing)"} parent=${existsSync(join(env.project, "escaped-outside.txt"))}`,
			);
			check(
				"its own declared artifact is still kept and accepted, and the closeout says the same limits",
				esc?.state === "accepted" && closeout !== undefined && closeout.text.includes(CHECKOUT_PLACEMENT_NOTE),
				JSON.stringify({ esc: esc ?? null, closeout: closeout?.text.slice(-600) ?? null }),
			);
		});
	}, 500_000);

	await suite.step("four isolated implementers with no plan run beside a shared writer, and every surface says what was kept", async () => {
		const dir = markerDir("planless-four");
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const names = Array.from({ length: WORKERS }, (_, index) => `u${index}`);
			const steps: Step[] = [
				{
					tasks: names.map((name, index) => ({
						agent: "storm-implementer",
						task: `Implement ${name} independently`,
						isolated: true,
						say: `E2E-CHILD-DELAY 5000 E2E-CHILD-SH ${b64(probe(dir, name, `${name}.txt`, `U-${index}`))}`,
					})),
				},
				// A shared writer is placed beside the four private ones: none of them reserves the shared tree.
				{ tasks: [{ agent: "storm-implementer", task: "Write in the shared tree", say: "E2E-CHILD-WRITE shared-beside.txt E2E-CHILD-CLAIM shared-beside-done" }] },
				{ wait: true },
			];
			const from = rpc.frames.length;
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 300_000);
			const run = await files.finishedRun(before, 300_000);
			const frames = rpc.frames.slice(from);
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			const cwds = names.map(name => readMarker(dir, `cwd-${name}`));
			const starts = names.map(name => seconds(dir, name)[0] ?? 0);
			const ends = names.map(name => seconds(dir, name)[1] ?? 0);
			const overlapped = starts.every(value => value > 0) && ends.every(value => value > 0) && Math.max(...starts) < Math.min(...ends);
			const closeout = await until(() => closeoutOf(rpc.frames, run.runId), 10_000, "the plan-less closeout").catch(() => undefined);
			const kept = patches(frames);
			check("the run opened with no plan and placed all five", run.plan === undefined && routed.length === WORKERS + 1, JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.code])));
			check("none was refused for the order of writers", !taskText(frames).includes("[storm:lane-write]") && run.spawns.every(spawn => spawn.outcome !== "blocked"), taskText(frames).slice(-400));
			check(
				"the four isolated workers ran in four distinct checkouts outside the parent",
				cwds.every(cwd => cwd !== "" && outsideProject(cwd)) && new Set(cwds.map(cwd => real(cwd))).size === WORKERS,
				JSON.stringify(cwds),
			);
			check("their shell windows overlapped", overlapped, `starts=${JSON.stringify(starts)} ends=${JSON.stringify(ends)}`);
			check("nothing they wrote reached the parent tree", names.every(name => !existsSync(join(env.project, `${name}.txt`))), "");
			const sharedFile = join(env.project, "shared-beside.txt");
			check("the shared writer beside them wrote in the parent tree", existsSync(sharedFile) && readFileSync(sharedFile, "utf8").includes("storm child change"), `exists=${existsSync(sharedFile)}`);
			check("each isolated worker's native result names a retained patch outside the parent", kept.length >= WORKERS && kept.every(path => outsideProject(path)), JSON.stringify(kept));
			check(
				"the closeout says no declared results, counts the workers, and does not claim their work reached the tree",
				closeout !== undefined &&
					closeout.text.includes(NO_DECLARED_RESULTS) &&
					closeout.text.includes("워커 5") &&
					!closeout.text.includes(RETAINED_ONLY_VERDICT) &&
					!closeout.text.includes("보존할 변경이 없었습니다"),
				closeout?.text.slice(-800) ?? "no closeout",
			);
			const noticed = llm.of("main").some(entry => entry.notes.some(note => note.includes("결과와 무관한 도착"))) || frames.some(frame => customMessage(frame) === "async-result" && JSON.stringify(frame).includes("결과와 무관한 도착"));
			check("no placed worker's delivery is told as 결과와 무관한 도착", !noticed, "");
		});
	}, 500_000);

	await suite.step("eight isolated implementers with no plan finish; the run ends as no declared results, not a stall", async () => {
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const names = Array.from({ length: 8 }, (_, index) => `p${index}`);
			const steps: Step[] = [
				{
					tasks: names.map(name => ({
						agent: "storm-implementer",
						task: `Implement ${name} planless-eight`,
						isolated: true,
						// The write tool, not a shell: the agent ledger counts this worker's change, which is the state the
						// measurement found (a worker that changed files in its own checkout and no parent-tree change).
						say: `E2E-CHILD-DELAY 3000 E2E-CHILD-WRITE ${name}.txt E2E-CHILD-CLAIM ${name}-done`,
					})),
				},
				{ wait: true },
			];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 300_000);
			const run = await files.finishedRun(before, 300_000);
			const closeout = await until(() => closeoutOf(rpc.frames, run.runId), 10_000, "the plan-less eight closeout").catch(() => undefined);
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			check("the run has no plan and placed all eight", run.plan === undefined && routed.length === 8, JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.code])));
			check(
				"every child's own request reached the offline model",
				names.every(name => llm.of("child").some(entry => entry.lastUser.includes(`Implement ${name} planless-eight`))),
				`children=${llm.of("child").length}`,
			);
			check(
				"the run ended as no declared results in its first round, never as a stall",
				run.endReason === NO_DECLARED_END_REASON && run.status === "ended" && run.turns === 1,
				`${run.status}/${run.endReason ?? "?"} turns=${run.turns ?? "?"}`,
			);
			check(
				"the closeout says no declared results, names the end and offers no handoff",
				closeout !== undefined &&
					closeout.text.includes(NO_DECLARED_RESULTS) &&
					closeout.text.includes(NO_DECLARED_END_LABEL) &&
					closeout.text.includes("워커 8") &&
					!closeout.text.includes(END_LABEL["no-progress"]) &&
					!closeout.text.includes(HANDOFF_RESUME_LABEL),
				closeout?.text.slice(-800) ?? "no closeout",
			);
			check("nothing the eight wrote reached the parent tree", names.every(name => !existsSync(join(env.project, `${name}.txt`))), "");
		});
	}, 500_000);

	await suite.step("an isolated worker cannot start a named service (A1-4)", async () => {
		const dir = markerDir("planless-service");
		const service = join(dir, "service-started");
		const llm = new LlmCursor(env);
		await sessions.open(() => undefined, async (rpc, files) => {
			const before = files.runIds();
			const steps: Step[] = [
				{
					tasks: [{
						agent: "storm-implementer",
						task: "Start a service, then write",
						isolated: true,
						say: `E2E-CHILD-SERVICE ${b64(`printf svc > ${JSON.stringify(service)}; echo ready; sleep 20`)} E2E-CHILD-WRITE svc-own.txt E2E-CHILD-CLAIM svc-done`,
					}],
				},
				{ wait: true },
			];
			await rpc.turn(`E2E-STEPS ${JSON.stringify(steps)}`, 240_000);
			const run = await files.finishedRun(before, 240_000);
			const routed = run.spawns.filter(spawn => spawn.outcome !== "blocked");
			check(
				"the isolated item ran as a private worker",
				run.plan === undefined && routed.length === 1 && routed[0]?.lane === undefined,
				JSON.stringify(run.spawns.map(spawn => [spawn.spawnKey, spawn.lane, spawn.outcome, spawn.code])),
			);
			const childRefusals = llm.of("child").map(entry => entry.lastTool).join("\n");
			check(
				"its named service was refused with the lane-service cause",
				childRefusals.includes("[storm:lane-service]"),
				childRefusals.slice(-600) || "no child refusal",
			);
			check("the service command never started", !existsSync(service), `marker=${existsSync(service)}`);
			await Bun.sleep(1_000);
			check("nothing of the service outlived the worker", !existsSync(join(env.project, "svc-own.txt")), "");
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
