/**
 * Two facts of the status the director reads (the run of 2026-11-26, 17:35:53): a row that was closed before any
 * judgment is not counted as a judged unmet, and an interrupted run of this session is named as the user's to continue,
 * with what a new plan does not carry. The second is a fact, not an instruction: the model status carries no advice.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { approveAndSave, type FlowEnv, statusText } from "../src/flows.ts";
import { endLabel, NO_END_REASON } from "../src/runtime/rounds.ts";
import { noteResumePointer } from "../src/runtime/resume.ts";
import { writeRun } from "../src/runtime/run.ts";
import { loadProjectState } from "../src/state.ts";
import type { RunRecord, RunResult, RunSpec } from "../src/types.ts";
import { resumeFactLine } from "../src/view/render.ts";
import { resultProgress } from "../src/view/results.ts";
import { runRecord } from "./fixtures.ts";
import { makeProject, TEAM, type TestProject } from "./support.ts";

const row = (id: string, state: RunResult["state"], over: Partial<RunResult> = {}): RunResult => ({ id, state, lane: "L", ...over }) as RunResult;
const parts = (results: RunResult[]) => resultProgress({ results }).parts;

describe("the compact result count", () => {
	test("17:35:53: rows closed before judgment are named so, not counted as judged unmet", () => {
		const rows = [
			row("a", "accepted"),
			row("b", "accepted"),
			...["c", "d", "e", "f"].map(id => row(id, "unmet", { finalized: "unsettled", reason: "결과가 확정되기 전에 실행이 종료되었습니다." })),
		];
		const progress = resultProgress({ results: rows });
		expect(progress.parts).toContain("이행 2/6");
		expect(progress.parts.some(part => part.startsWith("판정 전 종료 4"))).toBe(true);
		expect(progress.parts.some(part => part.startsWith("미충족"))).toBe(false);
		expect(progress.counts.unmet).toBe(0);
		expect(progress.counts.unjudged).toBe(4);
		// Still an open row: the run is not clean.
		expect(progress.tone).toBe("warning");
	});

	test("a judged unmet row keeps its word beside the unjudged ones", () => {
		const out = parts([row("a", "unmet"), row("b", "unmet", { finalized: "unsettled" }), row("c", "accepted")]);
		expect(out).toContain("미충족 1");
		expect(out.some(part => part.startsWith("판정 전 종료 1"))).toBe(true);
	});

	test("a revoked row, a pending row and an excluded unsettled row are not unjudged", () => {
		const progress = resultProgress({
			results: [row("a", "unmet", { finalized: "revoked" }), row("b", "pending"), row("c", "unmet", { finalized: "unsettled", scope: "excluded-by-user" })],
		});
		expect(progress.counts.unjudged).toBe(0);
		expect(progress.counts.unmet).toBe(1);
		expect(progress.counts.pending).toBe(1);
		expect(progress.counts.excluded).toBe(1);
	});

	test("the in-scope counts still add up to the in-scope rows", () => {
		const { counts } = resultProgress({
			results: [row("a", "accepted"), row("b", "unmet"), row("c", "unmet", { finalized: "unsettled" }), row("d", "reviewable"), row("e", "pending")],
		});
		expect(counts.accepted + counts.reviewable + counts.unmet + counts.unjudged + counts.running + counts.pending).toBe(counts.inScope);
	});
});

describe("the fact about continuing an interrupted run", () => {
	let project: TestProject;
	let env: FlowEnv;
	const started: RunSpec[] = [];
	const startRun = async (spec: RunSpec) => {
		started.push(spec);
		return { ok: true as const, runId: "run-new" };
	};
	const interrupted = (over: Partial<RunRecord> = {}): RunRecord =>
		runRecord({
			runId: "run-20261126-073428-48cc",
			startedAt: "2026-11-26T07:34:28.000Z",
			endedAt: "2026-11-26T08:30:00.000Z",
			status: "stopped",
			endReason: "interrupted",
			turns: 2,
			maxRounds: 4,
			task: "Gemma resume",
			request: "Gemma resume",
			...over,
		});
	const plant = async (run: RunRecord) => {
		const state = await loadProjectState(env);
		await writeRun(state.sessionDir, run);
		await noteResumePointer(state.sessionDir, { repoId: state.repo.repoId, root: state.repo.root }, run);
	};

	beforeEach(async () => {
		project = await makeProject(() => Date.parse("2026-11-26T09:00:00Z"));
		env = project.env;
		await approveAndSave(await loadProjectState(env), TEAM, { shadowedAgents: [] });
	});
	afterEach(async () => {
		await project.remove();
	});

	test("under automatic delegation the director's status says it can continue the run, and what a plan does not carry", async () => {
		const run = interrupted();
		await plant(run);
		// The director's host (the tool) has no menu start of its own: only the opt-in tells it may continue.
		const text = await statusText({ ...env, autoEnabled: () => true }, { quota: false });
		const line = resumeFactLine(run.runId, true, endLabel("interrupted"));
		expect(text).toContain(line);
		expect(line).toContain("storm continue");
		expect(line).toContain("storm plan");
		expect(line).toContain("새 실행");
		expect(line).not.toContain("/storm");
		// The inserted id sits between a fixed noun and its particle: 실행(id)이.
		expect(line).toContain(`실행(${run.runId}, 멈춘 이유: ${endLabel("interrupted")})이`);
		// A fact, not a command: no imperative ending in the sentence.
		expect(line).not.toMatch(/하세요|마세요|해야/u);
		expect(line.length).toBeLessThan(220);
		// Starting nothing: asking for the status never resumes.
		expect(started).toEqual([]);
	});

	test("with manual delegation the status says the user continues it, and that continue is not available", async () => {
		const run = interrupted();
		await plant(run);
		const text = await statusText({ ...env, autoEnabled: () => false }, { quota: false });
		const line = resumeFactLine(run.runId, false, endLabel("interrupted"));
		expect(text).toContain(line);
		expect(line).toContain("/storm");
		expect(line).not.toContain("storm continue");
		expect(line).toContain(`실행(${run.runId}, 멈춘 이유: ${endLabel("interrupted")})은`);
		expect(line.length).toBeLessThan(220);
		// The menu's own start (flows) keeps the same fact without an opt-in reader.
		expect(await statusText({ ...env, startRun }, { quota: false })).toContain(line);
	});

	test("a run the host cut off is said so in the status and stays the candidate", async () => {
		const run = interrupted({ endReason: "host-ended", turns: 0 });
		await plant(run);
		const text = await statusText({ ...env, autoEnabled: () => true }, { quota: false });
		expect(text).toContain(endLabel("host-ended"));
		expect(text).toContain(resumeFactLine(run.runId, true, endLabel("host-ended")));
	});

	test("the status says why the run stopped, in the words /storm status uses, so a deliberate stop or a limit is not taken for a crash", async () => {
		for (const endReason of ["interrupted", "budget", "time-limit", "round-limit", "no-progress", "shutdown", "host-ended"] as const) {
			const run = interrupted({ endReason });
			await plant(run);
			for (const auto of [true, false]) {
				const text = await statusText({ ...env, autoEnabled: () => auto }, { quota: false });
				const line = resumeFactLine(run.runId, auto, endLabel(endReason));
				expect(text, `${endReason} ${auto}`).toContain(line);
				expect(line).toContain(endLabel(endReason));
			}
		}
		// The reasons differ in words, so the director can tell them apart.
		expect(new Set(["interrupted", "budget", "time-limit", "round-limit", "host-ended"].map(reason => resumeFactLine("run-x", true, endLabel(reason)))).size).toBe(5);
		// A record written before reasons were kept says so rather than naming nothing.
		const legacy = interrupted({ runId: "run-20261126-100000-aaaa", startedAt: "2026-11-26T10:00:00.000Z", endedAt: "2026-11-26T10:30:00.000Z" });
		delete legacy.endReason;
		await plant(legacy);
		expect(await statusText({ ...env, autoEnabled: () => true }, { quota: false })).toContain(resumeFactLine(legacy.runId, true, NO_END_REASON));
	});

	test("no line without a candidate, without a start, with an active run, or in the user's full status", async () => {
		const run = interrupted();
		const none = await statusText({ ...env, startRun }, { quota: false });
		expect(none).not.toContain("이어 가기");
		await plant(run);
		expect(await statusText(env, { quota: false })).not.toContain("이어 가기");
		const active = runRecord({ runId: "run-20261126-093000-bcde", status: "running" });
		expect(await statusText({ ...env, startRun, activeRun: () => active }, { quota: false })).not.toContain("이어 가기");
		expect(await statusText({ ...env, startRun }, { quota: true })).not.toContain("이어 가기:");
	});

	test("a finished run is nothing to continue", async () => {
		await plant(interrupted({ status: "done", endReason: "verified", runId: "run-20261126-060000-aaaa" }));
		expect(await statusText({ ...env, startRun }, { quota: false })).not.toContain("이어 가기");
	});
});
