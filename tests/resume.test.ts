import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../src/config/canonical.ts";
import { lastRun, pruneRuns, readRun, RUN_RECORD_MAX_BYTES, runsDir, writeRun } from "../src/runtime/run.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import {
	findResumeCandidate,
	noteResumePointer,
	protectedResumeRunIds,
	resumeCandidate,
	resumePointerFile,
	RESUME_POINTERS_MAX,
	type ResumeTarget,
	trustedResume,
} from "../src/runtime/resume.ts";
import type { RunRecord } from "../src/types.ts";
import { runRecord } from "./fixtures.ts";

let tmp: string;
let sessionDir: string;
let target: ResumeTarget;

const REPO_ID = "dir-test-000000000000000000000000";

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-resume-")));
	sessionDir = sessionStoreDir(path.join(tmp, "profile"), "owner");
	target = { repoId: REPO_ID, root: path.join(tmp, "project") };
	await mkdir(target.root, { recursive: true });
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

const requestHash = (text: string): string => sha256Hex(text);
const run = (over: Partial<RunRecord> = {}): RunRecord =>
	runRecord({
		runId: "run-20261120-100000-edit",
		startedAt: "2026-11-20T10:00:00.000Z",
		status: "stopped",
		endReason: "interrupted",
		task: "edit the upload retry path",
		request: "edit the upload retry path",
		...over,
	});

async function plantEntries(schema: string, entries: Array<Record<string, unknown>>): Promise<void> {
	const file = resumePointerFile(sessionDir);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ schema, entries }));
}

describe("resume pointer scoping", () => {
	test("a pointer lives in its session's store and names the exact target", async () => {
		const interrupted = run();
		await writeRun(sessionDir, interrupted);
		await noteResumePointer(sessionDir, target, interrupted);

		const stored = JSON.parse(await readFile(resumePointerFile(sessionDir), "utf8")) as {
			schema: string;
			entries: Array<{ runId: string; repoId: string; root: string }>;
		};
		expect(stored.schema).toBe("storm.resume-pointers/v2");
		expect(stored.entries).toEqual([
			expect.objectContaining({ runId: interrupted.runId, repoId: REPO_ID, root: target.root }),
		]);
		expect((await findResumeCandidate(sessionDir, target))?.runId).toBe(interrupted.runId);
		expect(await trustedResume(sessionDir, target, interrupted)).toBe(true);
		expect((await resumeCandidate(sessionDir, target, interrupted))?.runId).toBe(interrupted.runId);

		// A different target and a different repo identity never see the same handoff.
		const otherRoot = { ...target, root: path.join(tmp, "other-worktree") };
		const otherRepo = { ...target, repoId: "git-other-000000000000000000000000" };
		expect(await findResumeCandidate(sessionDir, otherRoot)).toBeUndefined();
		expect(await findResumeCandidate(sessionDir, otherRepo)).toBeUndefined();
		expect(await trustedResume(sessionDir, otherRoot, interrupted)).toBe(false);
		expect(await resumeCandidate(sessionDir, otherRoot, interrupted)).toBeUndefined();

		// A second native session's store is independent even when it names the same target.
		const otherSession = sessionStoreDir(path.join(tmp, "profile"), "other-owner");
		await writeRun(otherSession, interrupted);
		expect(await findResumeCandidate(otherSession, target)).toBeUndefined();
	});

	test("a foreign pointer, an old shape, an edited request, or malicious extra fields are not trusted", async () => {
		const edit = run();
		await writeRun(sessionDir, edit);

		// No pointer for this session and target.
		expect(await findResumeCandidate(sessionDir, target)).toBeUndefined();

		// The retired single-entry shape and a foreign schema are ignored rather than imported.
		const file = resumePointerFile(sessionDir);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ runId: edit.runId, requestSha256: requestHash(edit.request!) }));
		expect(await findResumeCandidate(sessionDir, target)).toBeUndefined();
		await plantEntries("someone.else/resume/v9", [{ runId: edit.runId, requestSha256: requestHash(edit.request!) }]);
		expect(await findResumeCandidate(sessionDir, target)).toBeUndefined();

		// The pointer names the run but not the request it kept.
		await plantEntries("storm.resume-pointers/v2", [
			{ runId: edit.runId, requestSha256: requestHash("a different request"), repoId: REPO_ID, root: target.root },
		]);
		expect(await findResumeCandidate(sessionDir, target)).toBeUndefined();

		// Metadata cannot import plan, request text or a path-like resumeOf into the handoff.
		await plantEntries("storm.resume-pointers/v2", [
			{
				runId: edit.runId,
				requestSha256: requestHash(edit.request!),
				repoId: REPO_ID,
				root: target.root,
				request: "malicious request",
				plan: { lanes: [{ name: "evil", kind: "code", role: "implementer" }] },
			},
		]);
		const trusted = await findResumeCandidate(sessionDir, target);
		expect(trusted?.request).toBe(edit.request);
		expect(trusted?.plan).toBeUndefined();

		await plantEntries("storm.resume-pointers/v2", [
			{
				runId: edit.runId,
				requestSha256: requestHash(edit.request!),
				repoId: REPO_ID,
				root: target.root,
				resumeOf: "../../escape",
			},
		]);
		expect(await findResumeCandidate(sessionDir, target)).toBeUndefined();

		// A relative or missing target path is malformed, not a wildcard.
		await plantEntries("storm.resume-pointers/v2", [
			{ runId: edit.runId, requestSha256: requestHash(edit.request!), repoId: REPO_ID, root: "project" },
		]);
		expect(await findResumeCandidate(sessionDir, target)).toBeUndefined();
	});
});

describe("resume candidate selection", () => {
	const edit = (over: Partial<RunRecord> = {}): RunRecord =>
		run({
			plan: {
				lanes: [{ name: "upload retry", kind: "code", role: "implementer", goal: "only the upload path" }],
				workers: { implementer: 1 },
				submittedAt: "2026-11-20T10:05:00.000Z",
			},
			...over,
		});

	test("an interrupted edit survives a later short lookup and a stopped read-only probe", async () => {
		const interrupted = edit();
		await writeRun(sessionDir, interrupted);
		await noteResumePointer(sessionDir, target, interrupted);

		// A later look, finished without changes: the newest run record is no longer the resume candidate.
		const lookup = run({
			runId: "run-20261120-110000-look",
			startedAt: "2026-11-20T11:00:00.000Z",
			status: "ended",
			endReason: "no-changes",
			task: "what does the upload retry path do?",
			request: "what does the upload retry path do?",
		});
		await writeRun(sessionDir, lookup);
		await noteResumePointer(sessionDir, target, lookup);
		expect((await lastRun(sessionDir))?.runId).toBe(lookup.runId);
		expect(await resumeCandidate(sessionDir, target, lookup)).toBeUndefined();
		expect((await findResumeCandidate(sessionDir, target))?.runId).toBe(interrupted.runId);

		// A stopped probe with one turn still does not displace the substantive interrupted run.
		const probe = run({
			runId: "run-20261120-120000-probe",
			startedAt: "2026-11-20T12:00:00.000Z",
			status: "stopped",
			endReason: "round-limit",
			turns: 1,
			task: "look around",
			request: "look around",
			plan: { lanes: [{ name: "lookup", kind: "explore", role: "explorer" }], workers: { explorer: 1 }, submittedAt: "2026-11-20T12:00:01Z" },
			spawns: [{ ts: "2026-11-20T12:00:02Z", agent: "storm-explorer", invocationKind: "task", requested: [], outcome: "routed" }],
		});
		await writeRun(sessionDir, probe);
		await noteResumePointer(sessionDir, target, probe);
		expect((await findResumeCandidate(sessionDir, target))?.runId).toBe(interrupted.runId);
	});

	test("an unreadable request shape in a newer record does not hide trusted earlier work", async () => {
		const interrupted = edit();
		const corrupt = run({ runId: "run-20261120-130000-corrupt", startedAt: "2026-11-20T13:00:00.000Z" });
		await writeRun(sessionDir, interrupted);
		await noteResumePointer(sessionDir, target, interrupted);
		await writeRun(sessionDir, corrupt);
		await noteResumePointer(sessionDir, target, corrupt);
		await writeFile(path.join(runsDir(sessionDir), `${corrupt.runId}.json`), JSON.stringify({ ...corrupt, request: { corrupt: true } }));
		expect((await findResumeCandidate(sessionDir, target))?.runId).toBe(interrupted.runId);
	});

	test("a new crashed manual run can resume even if its plan had not been flushed yet", async () => {
		const earlier = edit();
		const crash = run({ runId: "run-20261120-140000-crash", startedAt: "2026-11-20T14:00:00.000Z" });
		delete crash.endReason;
		for (const candidate of [earlier, crash]) {
			await writeRun(sessionDir, candidate);
			await noteResumePointer(sessionDir, target, candidate);
		}
		expect((await findResumeCandidate(sessionDir, target))?.runId).toBe(crash.runId);
	});

	test("a later durable retry wins, and a finished retry stops its parent being offered", async () => {
		const interrupted = edit();
		await writeRun(sessionDir, interrupted);
		await noteResumePointer(sessionDir, target, interrupted);

		const retry = run({
			runId: "run-20261120-130000-retry",
			startedAt: "2026-11-20T13:00:00.000Z",
			resumeOf: interrupted.runId,
			request: interrupted.request ?? interrupted.task,
			task: interrupted.task,
		});
		await writeRun(sessionDir, retry);
		await noteResumePointer(sessionDir, target, retry);
		expect((await findResumeCandidate(sessionDir, target))?.runId).toBe(retry.runId);

		// The retry completed the work: its parent is no longer offered.
		const done = { ...retry, status: "done" as const, endReason: "verified" as const };
		await writeRun(sessionDir, done);
		expect(await findResumeCandidate(sessionDir, target)).toBeUndefined();
	});

	test("the bounded collection keeps the unresolved candidate while newer quick runs start", async () => {
		const interrupted = edit();
		await writeRun(sessionDir, interrupted);
		await noteResumePointer(sessionDir, target, interrupted);
		for (let i = 0; i < RESUME_POINTERS_MAX + 2; i++) {
			const quick = run({
				runId: `run-20261121-${String(i).padStart(6, "0")}-quick`,
				startedAt: new Date(Date.UTC(2026, 10, 21, 0, 0, i)).toISOString(),
				status: "ended",
				endReason: "no-changes",
				task: `look ${i}`,
				request: `look ${i}`,
			});
			await writeRun(sessionDir, quick);
			await noteResumePointer(sessionDir, target, quick);
		}
		const stored = JSON.parse(await readFile(resumePointerFile(sessionDir), "utf8")) as {
			entries: Array<{ runId: string }>;
		};
		expect(stored.entries.length).toBe(RESUME_POINTERS_MAX);
		expect(stored.entries.some(entry => entry.runId === interrupted.runId)).toBe(true);
		expect((await findResumeCandidate(sessionDir, target))?.runId).toBe(interrupted.runId);
	});
});

describe("resume retention protection", () => {
	test("pruneRuns keeps running records and trusted unfinished candidates, and deletes only run files", async () => {
		const old = run({
			runId: "run-20261120-090000-old0",
			startedAt: "2026-11-20T09:00:00.000Z",
			status: "done",
			endReason: "verified",
		});
		const interrupted = run();
		const retry = run({
			runId: "run-20261120-110500-retry",
			startedAt: "2026-11-20T11:05:00.000Z",
			status: "done",
			endReason: "verified",
			resumeOf: interrupted.runId,
			request: interrupted.request ?? interrupted.task,
		});
		const live = run({
			runId: "run-20261120-110000-live",
			startedAt: "2026-11-20T11:00:00.000Z",
			status: "running",
		});
		const newest = run({
			runId: "run-20261120-120000-new0",
			startedAt: "2026-11-20T12:00:00.000Z",
			status: "done",
			endReason: "verified",
		});
		for (const record of [old, interrupted, retry, live, newest]) await writeRun(sessionDir, record);
		await writeFile(path.join(runsDir(sessionDir), "notes.txt"), "keep me");
		await noteResumePointer(sessionDir, target, interrupted);
		await noteResumePointer(sessionDir, target, retry);
		await noteResumePointer(sessionDir, target, live);

		// The completed retry is kept too: its record is what keeps its parent from being offered again.
		expect((await protectedResumeRunIds(sessionDir)).sort()).toEqual([interrupted.runId, retry.runId, live.runId].sort());
		await pruneRuns(sessionDir, 1, await protectedResumeRunIds(sessionDir));

		expect(await readRun(sessionDir, old.runId)).toBeUndefined();
		expect(await readRun(sessionDir, interrupted.runId)).toBeDefined();
		expect(await readRun(sessionDir, retry.runId)).toBeDefined();
		expect(await readRun(sessionDir, live.runId)).toBeDefined();
		expect(await readRun(sessionDir, newest.runId)).toBeDefined();
		expect(await readFile(path.join(runsDir(sessionDir), "notes.txt"), "utf8")).toBe("keep me");
	});

	test("a running record is kept even without a pointer or a protect list", async () => {
		const live = run({
			runId: "run-20261120-090000-live",
			startedAt: "2026-11-20T09:00:00.000Z",
			status: "running",
		});
		const newest = run({
			runId: "run-20261120-120000-new0",
			startedAt: "2026-11-20T12:00:00.000Z",
			status: "done",
			endReason: "verified",
		});
		await writeRun(sessionDir, live);
		await writeRun(sessionDir, newest);
		await pruneRuns(sessionDir, 1);
		expect(await readRun(sessionDir, live.runId)).toBeDefined();
		expect(await readRun(sessionDir, newest.runId)).toBeDefined();
	});
});

describe("run record reads", () => {
	test("a read is bounded to a regular file and refuses a symlink, a directory or an oversized record", async () => {
		const record = run();
		await writeRun(sessionDir, record);
		expect((await readRun(sessionDir, record.runId))?.task).toBe(record.task);

		const dir = runsDir(sessionDir);
		const hugeId = "run-20261120-100001-huge";
		await writeFile(path.join(dir, `${hugeId}.json`), JSON.stringify({ ...record, runId: hugeId, task: "x".repeat(RUN_RECORD_MAX_BYTES) }));
		expect(await readRun(sessionDir, hugeId)).toBeUndefined();

		const realId = "run-20261120-100002-real";
		await writeRun(sessionDir, { ...record, runId: realId });
		const linkId = "run-20261120-100003-link";
		await symlink(path.join(dir, `${realId}.json`), path.join(dir, `${linkId}.json`));
		expect(await readRun(sessionDir, realId)).toBeDefined();
		expect(await readRun(sessionDir, linkId)).toBeUndefined();

		const dirId = "run-20261120-100004-dir";
		await mkdir(path.join(dir, `${dirId}.json`), { recursive: true });
		expect(await readRun(sessionDir, dirId)).toBeUndefined();
	});
});
