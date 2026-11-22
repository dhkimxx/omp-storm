import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../src/config/canonical.ts";
import { lastRun, pruneRuns, readRun, runsDir, writeRun } from "../src/runtime/run.ts";
import {
	findResumeCandidate,
	noteResumePointer,
	protectedResumeRunIds,
	resumeCandidate,
	resumePointerFile,
	RESUME_POINTERS_MAX,
	trustedResume,
} from "../src/runtime/resume.ts";
import type { RunRecord } from "../src/types.ts";
import { runRecord } from "./fixtures.ts";

let tmp: string;
let root: string;
let storeDir: string;

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-resume-")));
	root = path.join(tmp, "project");
	storeDir = path.join(tmp, "store");
	await mkdir(root, { recursive: true });
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

async function plantLegacy(entry: { runId: string; requestSha256: string }): Promise<void> {
	const file = resumePointerFile(storeDir, root);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(entry));
}

describe("resume pointer compatibility", () => {
	test("the 0.14 single-entry pointer is read and kept when a new start upgrades it", async () => {
		const old = run();
		await writeRun(root, old);
		await plantLegacy({ runId: old.runId, requestSha256: requestHash(old.request!) });

		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(old.runId);
		expect(await trustedResume(storeDir, root, old)).toBe(true);
		expect((await resumeCandidate(storeDir, root, old))?.runId).toBe(old.runId);

		const next = run({
			runId: "run-20261120-110000-next",
			startedAt: "2026-11-20T11:00:00.000Z",
			status: "done",
			endReason: "verified",
			task: "a later quick question",
			request: "a later quick question",
		});
		await writeRun(root, next);
		await noteResumePointer(storeDir, root, next);

		const stored = JSON.parse(await readFile(resumePointerFile(storeDir, root), "utf8")) as {
			schema: string;
			entries: Array<{ runId: string }>;
		};
		expect(stored.schema).toBe("storm.resume-pointers/v1");
		expect(stored.entries.map(entry => entry.runId)).toEqual([old.runId, next.runId]);
		// The later completed run does not hide the older unfinished one.
		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(old.runId);
	});

	test("a foreign pointer, an edited request, or malicious extra fields are not trusted", async () => {
		const edit = run();
		await writeRun(root, edit);

		// No pointer for this work tree.
		expect(await findResumeCandidate(storeDir, root)).toBeUndefined();
		expect(await findResumeCandidate(storeDir, path.join(tmp, "other-worktree"))).toBeUndefined();

		// The pointer names the run but not the request it kept.
		await plantLegacy({ runId: edit.runId, requestSha256: requestHash("a different request") });
		expect(await findResumeCandidate(storeDir, root)).toBeUndefined();

		// A collection under another schema is foreign data, even when its entry names a real run.
		const file = resumePointerFile(storeDir, root);
		await writeFile(
			file,
			JSON.stringify({
				schema: "someone.else/resume/v9",
				entries: [{ runId: edit.runId, requestSha256: requestHash(edit.request!) }],
			}),
		);
		expect(await findResumeCandidate(storeDir, root)).toBeUndefined();

		// New-shape metadata cannot import plan, request text or a path-like resumeOf into the handoff.
		await writeFile(
			file,
			JSON.stringify({
				schema: "storm.resume-pointers/v1",
				entries: [
					{
						runId: edit.runId,
						requestSha256: requestHash(edit.request!),
						request: "malicious request",
						plan: { lanes: [{ name: "evil", kind: "code", role: "implementer" }] },
					},
				],
			}),
		);
		const trusted = await findResumeCandidate(storeDir, root);
		expect(trusted?.request).toBe(edit.request);
		expect(trusted?.plan).toBeUndefined();

		await writeFile(
			file,
			JSON.stringify({
				schema: "storm.resume-pointers/v1",
				entries: [{ runId: edit.runId, requestSha256: requestHash(edit.request!), resumeOf: "../../escape" }],
			}),
		);
		expect(await findResumeCandidate(storeDir, root)).toBeUndefined();
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
		await writeRun(root, interrupted);
		await noteResumePointer(storeDir, root, interrupted);

		// A later look, finished without changes: the newest run record is no longer the resume candidate.
		const lookup = run({
			runId: "run-20261120-110000-look",
			startedAt: "2026-11-20T11:00:00.000Z",
			status: "ended",
			endReason: "no-changes",
			task: "what does the upload retry path do?",
			request: "what does the upload retry path do?",
		});
		await writeRun(root, lookup);
		await noteResumePointer(storeDir, root, lookup);
		expect((await lastRun(root))?.runId).toBe(lookup.runId);
		expect((await resumeCandidate(storeDir, root, lookup))).toBeUndefined();
		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(interrupted.runId);

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
		await writeRun(root, probe);
		await noteResumePointer(storeDir, root, probe);
		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(interrupted.runId);
	});

	test("an unreadable request shape in a newer repo record does not hide trusted earlier work", async () => {
		const interrupted = edit();
		const corrupt = run({ runId: "run-20261120-130000-corrupt", startedAt: "2026-11-20T13:00:00.000Z" });
		await writeRun(root, interrupted);
		await noteResumePointer(storeDir, root, interrupted);
		await writeRun(root, corrupt);
		await noteResumePointer(storeDir, root, corrupt);
		await writeFile(path.join(runsDir(root), `${corrupt.runId}.json`), JSON.stringify({ ...corrupt, request: { corrupt: true } }));
		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(interrupted.runId);
	});

	test("a new crashed manual run can resume even if its plan had not been flushed yet", async () => {
		const earlier = edit();
		const crash = run({ runId: "run-20261120-140000-crash", startedAt: "2026-11-20T14:00:00.000Z" });
		delete crash.endReason;
		for (const candidate of [earlier, crash]) {
			await writeRun(root, candidate);
			await noteResumePointer(storeDir, root, candidate);
		}
		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(crash.runId);
	});

	test("a later durable retry wins, and a finished retry stops its parent being offered", async () => {
		const interrupted = edit();
		await writeRun(root, interrupted);
		await noteResumePointer(storeDir, root, interrupted);

		const retry = run({
			runId: "run-20261120-130000-retry",
			startedAt: "2026-11-20T13:00:00.000Z",
			resumeOf: interrupted.runId,
			request: interrupted.request ?? interrupted.task,
			task: interrupted.task,
		});
		await writeRun(root, retry);
		await noteResumePointer(storeDir, root, retry);
		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(retry.runId);

		// The retry completed the work: its parent is no longer offered.
		const done = { ...retry, status: "done" as const, endReason: "verified" as const };
		await writeRun(root, done);
		expect(await findResumeCandidate(storeDir, root)).toBeUndefined();
	});

	test("the bounded collection keeps the unresolved candidate while newer quick runs start", async () => {
		const interrupted = edit();
		await writeRun(root, interrupted);
		await noteResumePointer(storeDir, root, interrupted);
		for (let i = 0; i < RESUME_POINTERS_MAX + 2; i++) {
			const quick = run({
				runId: `run-20261121-${String(i).padStart(6, "0")}-quick`,
				startedAt: new Date(Date.UTC(2026, 10, 21, 0, 0, i)).toISOString(),
				status: "ended",
				endReason: "no-changes",
				task: `look ${i}`,
				request: `look ${i}`,
			});
			await writeRun(root, quick);
			await noteResumePointer(storeDir, root, quick);
		}
		const stored = JSON.parse(await readFile(resumePointerFile(storeDir, root), "utf8")) as {
			entries: Array<{ runId: string }>;
		};
		expect(stored.entries.length).toBe(RESUME_POINTERS_MAX);
		expect(stored.entries.some(entry => entry.runId === interrupted.runId)).toBe(true);
		expect((await findResumeCandidate(storeDir, root))?.runId).toBe(interrupted.runId);
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
		for (const record of [old, interrupted, retry, live, newest]) await writeRun(root, record);
		await writeFile(path.join(runsDir(root), "notes.txt"), "keep me");
		await noteResumePointer(storeDir, root, interrupted);
		await noteResumePointer(storeDir, root, retry);
		await noteResumePointer(storeDir, root, live);

		// The completed retry is kept too: its record is what keeps its parent from being offered again.
		expect((await protectedResumeRunIds(storeDir, root)).sort()).toEqual([interrupted.runId, retry.runId, live.runId].sort());
		await pruneRuns(root, 1, await protectedResumeRunIds(storeDir, root));

		expect(await readRun(root, old.runId)).toBeUndefined();
		expect(await readRun(root, interrupted.runId)).toBeDefined();
		expect(await readRun(root, retry.runId)).toBeDefined();
		expect(await readRun(root, live.runId)).toBeDefined();
		expect(await readRun(root, newest.runId)).toBeDefined();
		expect(await readFile(path.join(runsDir(root), "notes.txt"), "utf8")).toBe("keep me");
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
		await writeRun(root, live);
		await writeRun(root, newest);
		await pruneRuns(root, 1);
		expect(await readRun(root, live.runId)).toBeDefined();
		expect(await readRun(root, newest.runId)).toBeDefined();
	});
});
