/**
 * A run whose omp process died is found at the next start. It used to be marked stopped with no reason, which neither
 * the user nor the director could tell from the user pressing Esc (the run of 2026-11-26, 15:03). It now says the host
 * ended while it was going, and it stays exactly as resumable as before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stopDeadRuns } from "../src/runtime/janitor.ts";
import { closeoutHandoff } from "../src/runtime/closeout.ts";
import { CONTINUATION_HEAD, EARLIER_REQUEST_MARKER, findResumeCandidate, noteResumePointer } from "../src/runtime/resume.ts";
import { endLabel, END_STATUS } from "../src/runtime/rounds.ts";
import { readRun, resumableRun, writeRun } from "../src/runtime/run.ts";
import { loadProjectState } from "../src/state.ts";
import type { RunRecord } from "../src/types.ts";
import { resumeRunLine } from "../src/view/render.ts";
import { runRecord } from "./fixtures.ts";
import { makeProject, type TestProject } from "./support.ts";

let project: TestProject;
let sessionDir: string;

beforeEach(async () => {
	project = await makeProject(() => Date.parse("2026-11-26T09:00:00Z"));
	sessionDir = (await loadProjectState(project.env)).sessionDir;
});
afterEach(async () => {
	await project.remove();
});

const crashed = (over: Partial<RunRecord> = {}): RunRecord =>
	runRecord({
		runId: "run-20261126-051651-7850",
		startedAt: "2026-11-26T05:16:51.000Z",
		updatedAt: "2026-11-26T06:03:21.000Z",
		status: "running",
		process: "424242:1700000000000",
		task: "Gemma resume",
		request: "Gemma resume",
		...over,
	});

describe("a run found dead at the next start", () => {
	test("it is stopped, ended at its last write, and says the host ended while it was going", async () => {
		await writeRun(sessionDir, crashed());
		await stopDeadRuns({ sessionDir, alive: () => false });
		const found = await readRun(sessionDir, "run-20261126-051651-7850");
		expect(found).toMatchObject({ status: "stopped", endReason: "host-ended", endedAt: "2026-11-26T06:03:21.000Z" });
		// Not the user's doing: it is not the reason Esc records.
		expect(found?.endReason).not.toBe("interrupted");
		expect(endLabel("host-ended")).not.toBe(endLabel("interrupted"));
		expect(END_STATUS["host-ended"]).toBe("stopped");
	});

	test("it stays resumable exactly as before: the same candidate the menu and the director's continue use", async () => {
		const run = crashed();
		await writeRun(sessionDir, run);
		const state = await loadProjectState(project.env);
		const where = { repoId: state.repo.repoId, root: state.repo.root };
		await noteResumePointer(sessionDir, where, run);
		await stopDeadRuns({ sessionDir, alive: () => false });
		const found = await readRun(sessionDir, run.runId);
		expect(resumableRun(found)).toBe(true);
		expect((await findResumeCandidate(sessionDir, where))?.runId).toBe(run.runId);
	});

	test("the result views say so: the resume line, and the handoff the director reads", async () => {
		await writeRun(sessionDir, crashed());
		await stopDeadRuns({ sessionDir, alive: () => false });
		const found = (await readRun(sessionDir, "run-20261126-051651-7850"))!;
		expect(resumeRunLine(found)).toContain(endLabel("host-ended"));
		expect(closeoutHandoff(found)).toContain("host-ended");
		const esc = { ...found, endReason: "interrupted" as const };
		expect(resumeRunLine(esc)).not.toContain(endLabel("host-ended"));
		expect(closeoutHandoff(esc)).not.toContain("host-ended");
	});

	test("a run whose process is still alive is left alone", async () => {
		await writeRun(sessionDir, crashed());
		await stopDeadRuns({ sessionDir, alive: () => true });
		expect(await readRun(sessionDir, "run-20261126-051651-7850")).toMatchObject({ status: "running" });
		expect((await readRun(sessionDir, "run-20261126-051651-7850"))?.endReason).toBeUndefined();
	});

	test("a record that names no process, found dead at session start, says the host ended as well", async () => {
		const { process: _named, ...unnamed } = crashed();
		await writeRun(sessionDir, unnamed);
		// Session start names no process either: the two missing values are not the same process.
		await stopDeadRuns({ sessionDir, alive: () => false });
		expect(await readRun(sessionDir, "run-20261126-051651-7850")).toMatchObject({ status: "stopped", endReason: "host-ended" });
		// A run end names its process; a record without one is not that process's stale record either.
		await writeRun(sessionDir, unnamed);
		await stopDeadRuns({ sessionDir, process: "7:7", alive: () => false });
		expect(await readRun(sessionDir, "run-20261126-051651-7850")).toMatchObject({ status: "stopped", endReason: "host-ended" });
	});

	test("a stale record of the very process that is ending runs gives no host reason: the host did not die", async () => {
		await writeRun(sessionDir, crashed({ process: "7:7" }));
		await stopDeadRuns({ sessionDir, process: "7:7", alive: () => false });
		const found = await readRun(sessionDir, "run-20261126-051651-7850");
		expect(found?.status).toBe("stopped");
		expect(found?.endReason).toBeUndefined();
	});
});

describe("the menu row of a continued run", () => {
	test("names the lanes the run is for, not the generated heading", () => {
		const request = `${CONTINUATION_HEAD}\n- Pin: pin the total\n- Build: build it\n\n${EARLIER_REQUEST_MARKER}\n작업현황`;
		const line = resumeRunLine(crashed({ status: "stopped", request }));
		expect(line).toContain("Pin: pin the total · Build: build it");
		expect(line).not.toContain(CONTINUATION_HEAD);
	});
});

describe("records written before the reason existed", () => {
	test("a stopped run with no reason is still read, still resumable and still labelled by its status", async () => {
		const old = crashed({ status: "stopped", endedAt: "2026-11-26T06:03:21.000Z" });
		await writeRun(sessionDir, old);
		const found = (await readRun(sessionDir, old.runId))!;
		expect(found.endReason).toBeUndefined();
		expect(resumableRun(found)).toBe(true);
		expect(resumeRunLine(found)).not.toContain(endLabel("host-ended"));
		const state = await loadProjectState(project.env);
		const where = { repoId: state.repo.repoId, root: state.repo.root };
		await noteResumePointer(sessionDir, where, found);
		expect((await findResumeCandidate(sessionDir, where))?.runId).toBe(old.runId);
	});

	test("an unknown reason from a newer version does not make a run resumable", () => {
		const odd = { ...crashed({ status: "stopped" }), endReason: "from-the-future" } as unknown as RunRecord;
		expect(resumableRun(odd)).toBe(false);
	});
});
