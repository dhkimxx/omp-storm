/** The persisted parent-to-child admission bridge, exercised without any in-process authority map. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildId, STORM_BUILD } from "../src/build.ts";
import { ADMISSION_CLOSING_ROOM, MAX_ADMISSION_BYTES, MAX_APPROVED_BYTES } from "../src/config/schema.ts";
import * as fsutil from "../src/fsutil.ts";
import { lanePolicy } from "../src/policy/capability.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import { sharedMap } from "../src/runtime/thread-state.ts";
import type { PlanLane } from "../src/types.ts";
import * as admissionModule from "../src/worker-admission.ts";
import {
	admissionMayUseNonReadTools,
	closeWorkerSpend,
	endWorkerAdmission,
	MAX_ADMISSION_RECORDS,
	persistWorkerAdmission,
	readChildBinding,
	readWorkerAdmission,
	readWorkerSpendClose,
	readWorkerStops,
	recordWorkerStop,
	resolveWorkerAdmission,
	revokeWorkerAdmissions,
	workerAdmissionKey,
} from "../src/worker-admission.ts";

let tmp: string;
let agentDir: string;
let project: string;
let artifacts: string;
let sessionDir: string;
const parentId = "Main";
const childId = "Impl";
const runId = "run-test";

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(join(tmpdir(), "storm-admission-")));
	agentDir = join(tmp, "agent");
	project = join(tmp, "project");
	// The host creates the artifact directory lazily: persist must work with only its ancestor present.
	artifacts = join(tmp, "artifacts");
	await mkdir(agentDir, { recursive: true });
	await mkdir(project, { recursive: true });
	sessionDir = sessionStoreDir(agentDir, "main-session");
	await mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

const admit = (over: {
	parentId?: string;
	directorId?: string;
	childId?: string;
	policy?: Parameters<typeof persistWorkerAdmission>[0]["policy"];
	lane?: string;
	hold?: string;
	runId?: string;
	targetRoot?: string;
	artifactRoot?: string;
	approved?: ReadonlyArray<{ selector: string; effort?: string }>;
	replaceEnded?: Parameters<typeof persistWorkerAdmission>[0]["replaceEnded"];
} = {}) =>
	persistWorkerAdmission({
		agentDir,
		artifactRoot: over.artifactRoot ?? artifacts,
		parentId: over.parentId ?? parentId,
		...(over.directorId === undefined ? {} : { directorId: over.directorId }),
		childId: over.childId ?? childId,
		runId: over.runId ?? runId,
		sessionId: "main-session",
		sessionDir,
		repoId: "repo-test",
		targetRoot: over.targetRoot ?? project,
		...(over.lane === undefined ? {} : { lane: over.lane }),
		...(over.hold === undefined ? {} : { hold: over.hold }),
		policy: over.policy ?? { kind: "paths", paths: ["allowed.txt"], reason: "test lane" },
		...(over.approved === undefined ? {} : { approved: over.approved }),
		...(over.replaceEnded === undefined ? {} : { replaceEnded: over.replaceEnded }),
	});

const resolve = (over: {
	childId?: string;
	childSessionId?: string;
	childCwd?: string;
	parentId?: string;
	artifactRoot?: string;
} = {}) =>
	resolveWorkerAdmission({
		agentDir,
		artifactRoot: over.artifactRoot ?? artifacts,
		parentId: over.parentId ?? parentId,
		childId: over.childId ?? childId,
		childSessionId: over.childSessionId ?? "child-session",
		childCwd: over.childCwd ?? project,
	});

/**
 * Writes `count` open records of this build as another session in the same profile would, so a test can put the store
 * at its cap without going through the cap check. They are records, not fixtures of the reading side: the housekeeping
 * under test reads them from disk like any other writer's.
 */
const fillRecords = async (count: number, options: { prefix?: string; expired?: boolean } = {}): Promise<void> => {
	const dir = join(agentDir, "storm", "admissions");
	await mkdir(dir, { recursive: true });
	const now = Date.now();
	const prefix = options.prefix ?? "filler";
	for (let index = 0; index < count; index++) {
		const filler = `${prefix}-${index}`;
		const key = workerAdmissionKey(artifacts, parentId, filler);
		const record = {
			schema: "storm.worker-admission/v2",
			build: buildId(),
			key,
			runId: `${prefix}-run`,
			sessionId: "main-session",
			sessionDir,
			repoId: "repo-test",
			targetRoot: project,
			artifactRoot: artifacts,
			parentId,
			childId: filler,
			attempt: randomUUID(),
			policy: { kind: "read", paths: [], reason: "another session's reader" },
			createdAt: now,
			// An expired record is free for housekeeping; an unexpired one of a run this tree's marker does not name
			// cannot be proved closed and is kept (the same rule a live run's closed records get).
			expiresAt: options.expired === true ? now - 1 : now + 7 * 24 * 3_600_000,
		};
		await writeFile(join(dir, `${key}.json`), JSON.stringify(record));
	}
};

describe("worker admission records", () => {
	test("persist works before the host creates the artifact directory, and read binds the exact identity", async () => {
		const persisted = await admit();
		expect(persisted.record.artifactRoot).toBe(artifacts);
		expect(persisted.record.lane).toBeUndefined();
		const read = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		expect(read).toMatchObject({ kind: "record", record: { runId, childId, policy: { kind: "paths", paths: ["allowed.txt"] } } });
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "Other" })).toEqual({ kind: "missing" });
	});

	test("a shared lane authorizes exactly its target and one child session claim", async () => {
		await admit({ lane: "L1" });
		const first = await resolve();
		expect(first).toMatchObject({ kind: "authorized", checkout: project });
		// The same attempt bound to another native child session is not interchangeable.
		expect(await resolve({ childSessionId: "child-other" })).toMatchObject({ kind: "denied" });
		const other = join(tmp, "other-target");
		await mkdir(other);
		expect(await resolve({ childCwd: other })).toMatchObject({ kind: "denied" });
	});

	test("a shell reader's admission carries the shell on a non-review read lane and reads back; a plain reader does not", async () => {
		const explore: PlanLane = { name: "scout", kind: "explore", role: "explorer" };
		const tools = ["read", "grep", "bash"];
		const shellPolicy = lanePolicy({ lane: explore, tools, isolated: false, auto: false });
		expect(shellPolicy).toMatchObject({ kind: "read", shell: true });
		await admit({ lane: "scout", policy: shellPolicy });
		const read = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		expect(read).toMatchObject({ kind: "record", record: { lane: "scout", policy: { kind: "read", shell: true } } });
		// The record is persisted as a file: a fresh read of it, after the process-local objects are gone, still has the shell.
		const authorized = await resolve();
		expect(authorized).toMatchObject({ kind: "authorized", record: { policy: { kind: "read", shell: true } } });

		// A plain reader never gains the shell from a missing field.
		const plainPolicy = lanePolicy({ lane: explore, tools: ["read", "grep"], isolated: false, auto: false });
		await admit({ childId: "Plain", lane: "scout", policy: plainPolicy });
		const plain = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "Plain" });
		expect(plain).toMatchObject({ kind: "record", record: { policy: { kind: "read" } } });
		if (plain.kind === "record") expect(plain.record.policy.shell).toBeUndefined();
	});

	test("RF3-5/RF3-9: the approved snapshot is kept whole and validated; a bad selector or effort is refused, never truncated", async () => {
		const entries = Array.from({ length: 257 }, (_, index) => ({ selector: `models/model-${index}`, effort: "low" }));
		await admit({ approved: entries });
		const binding = await readChildBinding({ agentDir, artifactRoot: artifacts, parentId, childId });
		expect(binding.kind === "bound" && binding.approved?.length).toBe(257);
		expect(binding.kind === "bound" && binding.approved?.at(-1)?.selector).toBe("models/model-256");
		await expect(admit({ childId: "BadEffort", approved: [{ selector: "models/x", effort: "not-an-effort" }] })).rejects.toThrow();
		await expect(admit({ childId: "BadSelector", approved: [{ selector: "no-provider" }] })).rejects.toThrow();
		await expect(admit({ childId: "BadSpaces", approved: [{ selector: "bad provider/   " }] })).rejects.toThrow();
	});

	test("RF3-1: a record of another build or an older schema is fail-closed, never read as this build's admission", async () => {
		await admit();
		const read = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (read.kind !== "record") throw new Error(JSON.stringify(read));
		expect(read.record.build).toBe(buildId());
		expect(read.record.build).toBe(STORM_BUILD);
		const file = join(agentDir, "storm", "admissions", `${workerAdmissionKey(artifacts, parentId, childId)}.json`);
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		await writeFile(file, JSON.stringify({ ...raw, build: "another-build" }));
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).toMatchObject({ kind: "invalid" });
		expect(await readChildBinding({ agentDir, artifactRoot: artifacts, parentId, childId })).toMatchObject({ kind: "unknown" });
		// An older build's v1 record has no build field at all and is rejected by the same shape check.
		await writeFile(file, JSON.stringify({ ...raw, schema: "storm.worker-admission/v1", build: undefined }));
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).toMatchObject({ kind: "invalid" });
	});

	test("RF3-1/RF3-7: shared maps are namespaced by this build, so another build's state is not visible", async () => {
		const name = `tests.build.${randomUUID()}`;
		sharedMap<string, string>(name).set("k", "v");
		const root = globalThis as { __stormSharedMaps?: Map<string, Map<unknown, unknown>> };
		const keys = [...(root.__stormSharedMaps?.keys() ?? [])];
		expect(keys).toContain(`${STORM_BUILD}\u0000${name}`);
		expect(keys.filter(key => key.includes(name))).toHaveLength(1);
	});

	test("RF3-6/RF3-11: a stop is a closed reason on the record of its own attempt, read twice without a second effect", async () => {
		await admit({ approved: [{ selector: "models/x", effort: "low" }] });
		const read = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (read.kind !== "record") throw new Error(JSON.stringify(read));
		expect(await recordWorkerStop(agentDir, { key: read.key, runId, childId, attempt: read.record.attempt, reason: "pooled-thread" })).toBe(true);
		const first = await readWorkerStops(agentDir, { runId, artifactRoot: artifacts, parentId, childIds: [childId] });
		expect(first).toEqual([{ childId, attempt: read.record.attempt, reason: "pooled-thread", at: expect.any(Number) }]);
		// The record is not deleted: a second read returns the same attempt, and the director's seen set is what makes it once.
		expect(await readWorkerStops(agentDir, { runId, artifactRoot: artifacts, parentId, childIds: [childId] })).toEqual(first);
		// Another attempt, another run or another child never adopts this record's stop.
		expect(await recordWorkerStop(agentDir, { key: read.key, runId, childId, attempt: "00000000-0000-4000-8000-000000000000", reason: "pooled-thread" })).toBe(false);
		expect(await readWorkerStops(agentDir, { runId: "another-run", artifactRoot: artifacts, parentId, childIds: [childId] })).toEqual([]);
		// The stop carries no free text or cost; a crafted reason outside the closed set makes the record invalid.
		const file = join(agentDir, "storm", "admissions", `${read.key}.json`);
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		await writeFile(file, JSON.stringify({ ...raw, stop: { reason: "free text", at: Date.now() } }));
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).toMatchObject({ kind: "invalid" });
	});

	test("a stopped record withdraws its authority and stays a tombstone the same attempt can read", async () => {
		await admit({ lane: "L1" });
		expect(await resolve()).toMatchObject({ kind: "authorized" });
		const read = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (read.kind !== "record") throw new Error(JSON.stringify(read));
		expect(await recordWorkerStop(agentDir, { key: read.key, runId, childId, attempt: read.record.attempt, reason: "state-not-shared" })).toBe(true);
		expect(await resolve()).toMatchObject({ kind: "denied" });
		expect(await readChildBinding({ agentDir, artifactRoot: artifacts, parentId, childId })).toMatchObject({ kind: "bound", attempt: read.record.attempt });
	});

	test("an unrecorded child of the active managed run is denied, and a revoked run leaves unrelated work alone", async () => {
		await admit();
		expect(await resolve({ childId: "Stray", childSessionId: "stray-session" })).toMatchObject({ kind: "denied" });
		await revokeWorkerAdmissions(agentDir, { runId });
		expect(await resolve()).toMatchObject({ kind: "denied" });
		expect(await resolve({ childId: "Stray", childSessionId: "stray-session" })).toEqual({ kind: "unmanaged" });
	});

	test("reset by session revokes its records, and a fresh record opens a new claimable attempt", async () => {
		await admit();
		await revokeWorkerAdmissions(agentDir, { sessionId: "main-session" });
		expect(await resolve()).toMatchObject({ kind: "denied" });
		await admit();
		expect(await resolve({ childSessionId: "new-child-session" })).toMatchObject({ kind: "authorized" });
	});

	test("a private lane is bound to its exact checkout and never the integrated target", async () => {
		await admit({ policy: { kind: "private", reason: "isolated experiment" } });
		expect(await resolve()).toMatchObject({ kind: "denied" });
		const privateDir = join(tmp, "private-checkout");
		await mkdir(privateDir);
		const claimed = await resolve({ childCwd: privateDir });
		expect(claimed).toMatchObject({ kind: "authorized", checkout: await realpath(privateDir) });
		const moved = join(tmp, "moved-checkout");
		await mkdir(moved);
		expect(await resolve({ childCwd: moved })).toMatchObject({ kind: "denied" });
	});

	test("the child's settled turn closes the attempt it claimed, so the same session cannot write again until a follow-up reopens it", async () => {
		await admit({ lane: "L1" });
		expect(await resolve()).toMatchObject({ kind: "authorized" });
		const read = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (read.kind !== "record") throw new Error("no record");
		// A claim now exists for this attempt: closing must still find the session that made it.
		expect(await endWorkerAdmission(agentDir, read.key, read.record.attempt, "child-session")).toBe(true);
		expect(await resolve()).toMatchObject({ kind: "denied" });
		// Another session cannot close it, and a stale attempt closes nothing of a newer one: the write is conditional on
		// the attempt it was read for, so it reports no change rather than rewriting the newer record.
		await admit({ lane: "L1" });
		expect(await resolve()).toMatchObject({ kind: "authorized" });
		expect(await endWorkerAdmission(agentDir, read.key, read.record.attempt, "child-session")).toBe(false);
		expect(await resolve()).toMatchObject({ kind: "authorized" });
		const fresh = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (fresh.kind !== "record") throw new Error("no record");
		expect(await endWorkerAdmission(agentDir, fresh.key, fresh.record.attempt, "other-session")).toBe(false);
		expect(await resolve()).toMatchObject({ kind: "authorized" });
	});

	test("a reservation that ended revokes exactly that child's authority from before the moment it ended", async () => {
		await admit({ childId: "A" });
		await admit({ childId: "B" });
		expect(await resolve({ childId: "A", childSessionId: "sa" })).toMatchObject({ kind: "authorized" });
		const ended = Date.now() + 1;
		expect(await revokeWorkerAdmissions(agentDir, { runId, childId: "A", createdBefore: ended })).toBe(1);
		expect(await resolve({ childId: "A", childSessionId: "sa" })).toMatchObject({ kind: "denied" });
		// Another child of the same run is untouched.
		expect(await resolve({ childId: "B", childSessionId: "sb" })).toMatchObject({ kind: "authorized" });
		// A newer attempt of A, written after that moment, is not revoked by the late event.
		const stale = Date.now() - 10_000;
		await admit({ childId: "A" });
		expect(await revokeWorkerAdmissions(agentDir, { runId, childId: "A", createdBefore: stale })).toBe(0);
		expect(await resolve({ childId: "A", childSessionId: "sa2" })).toMatchObject({ kind: "authorized" });
	});

	test("a path that becomes a symlink escape during the run no longer matches its canonical scope", async () => {
		await admit({ policy: { kind: "paths", paths: ["allowed.txt"], reason: "test lane" } });
		const outside = join(tmp, "outside.txt");
		await writeFile(outside, "outside\n");
		await symlink(outside, join(project, "allowed.txt"));
		expect(await resolve()).toMatchObject({ kind: "denied" });
	});

	test("an admission without hold keeps its read-only meaning, and a hold is accepted only as a non-empty string", async () => {
		const plain = await admit();
		expect(plain.record.hold).toBeUndefined();
		expect(admissionMayUseNonReadTools(plain.record)).toBe(false);
		// A record from before this field reads exactly like one written without it.
		const old = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (old.kind !== "record") throw new Error("expected the persisted record");
		expect(old.record.hold).toBeUndefined();
		expect(admissionMayUseNonReadTools(old.record)).toBe(false);

		const held = await admit({ childId: "Held", hold: "spawn:Held" });
		expect(held.record.hold).toBe("spawn:Held");
		expect(admissionMayUseNonReadTools(held.record)).toBe(true);
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "Held" })).toMatchObject({
			kind: "record",
			record: { hold: "spawn:Held" },
		});

		// Only a non-empty key names a reservation: an empty one is refused where it is written, and a blank one on
		// disk makes the record malformed instead of granting a writer's tools.
		await expect(admit({ childId: "Empty", hold: "" })).rejects.toThrow();
		const file = join(agentDir, "storm", "admissions", `${held.key}.json`);
		const value = JSON.parse(await readFile(file, "utf8"));
		await writeFile(file, JSON.stringify({ ...value, hold: "   " }));
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "Held" })).toMatchObject({ kind: "invalid" });
		await writeFile(file, JSON.stringify({ ...value, hold: "" }));
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "Held" })).toMatchObject({ kind: "invalid" });
	});

	test("a hold on a revoked or ended admission grants nothing", async () => {
		const held = await admit({ hold: "spawn:Impl" });
		expect(admissionMayUseNonReadTools(held.record)).toBe(true);
		expect(admissionMayUseNonReadTools({ ...held.record, revokedAt: 1 })).toBe(false);
		expect(admissionMayUseNonReadTools({ ...held.record, endedAt: 1 })).toBe(false);
		await revokeWorkerAdmissions(agentDir, { runId });
		expect(await resolve()).toMatchObject({ kind: "denied" });
		const read = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (read.kind !== "record") throw new Error("expected the revoked record");
		expect(read.record.hold).toBe("spawn:Impl");
		expect(admissionMayUseNonReadTools(read.record)).toBe(false);
	});

	test("a marker without a close reads as open, and a written close is seen, cached and kept across later admissions", async () => {
		// No admission record and no run: an ordinary native child is not fenced by a fact that never existed.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId, childId: "native" })).toEqual({ kind: "open" });
		await admit({ childId: "A" });
		// A read that cached an answer before the marker existed still sees the new marker as open.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "open" });
		const at = 1_800_000_000_000;
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "stop", now: at })).toEqual({ ok: true });
		// The reader had just cached the open marker: a changed file is read again rather than served from the cache.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		// A spawn admitted after the close does not erase it.
		await admit({ childId: "B" });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		// The first close stands: a later observation, even with the user's other option, never restates it.
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "block-spawns", now: at + 1 })).toEqual({ ok: true });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({
			kind: "closed",
			close: { at, onExceed: "stop" },
		});
	});

	test("B4: a descendant finds the close through the run named in its own admission, and a missing marker is unknown", async () => {
		await admit({ childId: "Impl" });
		// The unplanned worker's own eval child: the same run, a marker named by the worker rather than the director.
		await admit({ parentId: "Impl", directorId: parentId, childId: "Inner", runId });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: "Impl" })).toEqual({ kind: "open" });
		const at = 1_800_000_000_000;
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "stop", now: at })).toEqual({ ok: true });
		// The grandchild's immediate-parent marker never carried the close; the run-keyed receipt is what it reads.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: "Impl" })).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: "Impl", runId })).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		// The worker's own admission names a run the marker cannot answer for: never read as open.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: "Impl", runId: "run-other" })).toMatchObject({ kind: "unknown" });
		// The same run ID on a different director is not authority to read this close.
		await admit({ parentId: "Other", childId: "Unrelated", runId });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: "Other", runId })).toEqual({ kind: "open" });
		// A marker that is gone is a fact the managed worker cannot establish, not an open run.
		const runs = join(agentDir, "storm", "admissions", "runs");
		for (const name of await readdir(runs)) {
			if (name.endsWith(".json")) await rm(join(runs, name), { force: true });
		}
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId, childId: "Impl" })).toMatchObject({ kind: "unknown" });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: "Impl", childId: "Inner" })).toMatchObject({ kind: "unknown" });
		// An ordinary native child of the same tree has no record and no run: it keeps the open answer.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId, childId: "native" })).toEqual({ kind: "open" });
	});

	test("B4: a stale admission marker cannot erase a published close, and a replaced receipt is read again", async () => {
		await admit();
		const at = 1_800_000_000_000;
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "stop", now: at })).toEqual({ ok: true });
		// An admission that read the marker before the close can rewrite it afterwards; the close is not in that file.
		const runs = join(agentDir, "storm", "admissions", "runs");
		const [name] = (await readdir(runs)).filter(entry => entry.endsWith(".json"));
		const file = join(runs, name!);
		const marker = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		await writeFile(file, JSON.stringify({ ...marker, createdAt: Number(marker.createdAt) + 1 }));
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		// A receipt replaced atomically with the same size and modification time is still a different file: read again.
		const closedDir = join(agentDir, "storm", "admissions", "closes");
		const [closeName] = await readdir(closedDir);
		const closeFile = join(closedDir, closeName!);
		const fixed = new Date("2026-11-21T00:00:00Z");
		const cached = await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId });
		expect(cached).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		await utimes(closeFile, fixed, fixed);
		const later = { ...JSON.parse(await readFile(closeFile, "utf8")) as Record<string, unknown>, close: { at: at + 1, onExceed: "stop" } };
		await writeFile(`${closeFile}.new`, JSON.stringify(later));
		await utimes(`${closeFile}.new`, fixed, fixed);
		await rename(`${closeFile}.new`, closeFile);
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "closed", close: { at: at + 1, onExceed: "stop" } });
	});

	test("a warm reopen only replaces the exact ended record, never a revocation or successor", async () => {
		const first = await admit();
		expect(await endWorkerAdmission(agentDir, first.key, first.record.attempt, "worker")).toBe(true);
		const old = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (old.kind !== "record") throw new Error("the ended record is missing");
		const next = await admit({ replaceEnded: old.record });
		expect(next.record.attempt).not.toBe(first.record.attempt);
		await expect(admit({ replaceEnded: old.record })).rejects.toThrow("이전 자식 권한이 바뀌어");
		expect(await endWorkerAdmission(agentDir, next.key, next.record.attempt, "worker")).toBe(true);
		const ended = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		if (ended.kind !== "record") throw new Error("the ended successor is missing");
		expect(await revokeWorkerAdmissions(agentDir, { key: next.key, attempt: next.record.attempt })).toBe(1);
		await expect(admit({ replaceEnded: ended.record })).rejects.toThrow("이전 자식 권한이 바뀌어");
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).toMatchObject({
			kind: "record", record: { attempt: next.record.attempt, revokedAt: expect.any(Number) },
		});
	});

	test("an expired admission from an older schema makes room for a current attempt", async () => {
		const dir = join(agentDir, "storm", "admissions");
		await mkdir(dir, { recursive: true });
		const key = "a".repeat(64);
		const target = join(dir, `${key}.json`);
		await writeFile(target, JSON.stringify({ schema: "storm.worker-admission/v1", runId: "old" }));
		const stale = new Date(Date.now() - 9 * 24 * 3_600_000);
		await utimes(target, stale, stale);
		// The store is at its cap, so this admission is the one that scans and cleans.
		await fillRecords(MAX_ADMISSION_RECORDS - 1);
		const current = await admit({ childId: "AfterCleanup" });
		expect(await lstat(target).catch(() => undefined)).toBeUndefined();
		expect(await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "AfterCleanup" }))
			.toMatchObject({ kind: "record", record: { attempt: current.record.attempt } });
	});

	test("obsolete expired run markers do not survive a new run admission", async () => {
		const dir = join(agentDir, "storm", "admissions", "runs");
		await mkdir(dir, { recursive: true });
		const key = "b".repeat(64);
		const target = join(dir, `${key}.json`);
		await writeFile(target, JSON.stringify({ schema: "storm.worker-run/v1", runId: "old" }));
		const stale = new Date(Date.now() - 9 * 24 * 3_600_000);
		await utimes(target, stale, stale);
		await admit({ childId: "AfterMarkerCleanup" });
		expect(await lstat(target).catch(() => undefined)).toBeUndefined();
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "open" });
	});

	test("a new run in the same tree and parent starts open, and a close names exactly its own run", async () => {
		await admit({ childId: "A" });
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId: "run-other", onExceed: "stop" })).toMatchObject({ ok: false });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "open" });
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "stop" })).toEqual({ ok: true });
		await admit({ childId: "B", runId: "run-next" });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "open" });
		// No marker at all is a close no worker could read: it is reported as a failure, never treated as done.
		const bare = await mkdtemp(join(tmpdir(), "storm-admission-bare-"));
		await mkdir(join(bare, "agent"), { recursive: true });
		expect(await closeWorkerSpend({ agentDir: join(bare, "agent"), artifactRoot: join(bare, "artifacts"), parentId, runId, onExceed: "stop" })).toMatchObject({
			ok: false,
		});
		await rm(bare, { recursive: true, force: true });
	});

	test("a marker Storm cannot read is unknown, and a readable close is not remembered over it", async () => {
		await admit();
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "stop" })).toEqual({ ok: true });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toMatchObject({ kind: "closed" });
		const runs = join(agentDir, "storm", "admissions", "runs");
		const names = (await readdir(runs)).filter(name => name.endsWith(".json"));
		expect(names).toHaveLength(1);
		await writeFile(join(runs, names[0] ?? ""), "{ not a marker");
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toMatchObject({ kind: "unknown" });
		// Missing storage identity is not evidence of a spend fence for a native worker.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: undefined })).toEqual({ kind: "open" });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: undefined, stormRole: true })).toMatchObject({ kind: "unknown" });
	});

	test("RF4-1: an aged closed record of a live run is kept until that run closes, and the scan at the cap then removes it", async () => {
		await admit();
		// Close the record only (the run marker stays open): the run is still live.
		expect(await revokeWorkerAdmissions(agentDir, { runId, childId })).toBe(1);
		const file = join(agentDir, "storm", "admissions", `${workerAdmissionKey(artifacts, parentId, childId)}.json`);
		const stale = new Date(Date.now() - 25 * 3_600_000);
		await utimes(file, stale, stale);
		// Another session's records bring the store to its cap, and one of them has expired: the admission below runs
		// the one housekeeping scan. The aged record's run is still live, so it survives although it is closed and old,
		// while the expired record frees the place the admission needs.
		await fillRecords(MAX_ADMISSION_RECORDS - 2);
		await fillRecords(1, { prefix: "expired", expired: true });
		await admit({ childId: "Other" });
		const kept = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		expect(kept.kind === "record" && kept.record.revokedAt).toEqual(expect.any(Number));
		// The same aged record is housekeeping's to remove once the run itself has closed; the next writer at the cap
		// scans, frees it, and takes its place.
		await revokeWorkerAdmissions(agentDir, { runId });
		await admit({ childId: "Another" });
		expect((await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).kind).toBe("missing");
	});

	test("RF4-2: a stop that read an earlier attempt writes nothing once a newer attempt exists", async () => {
		const first = await admit();
		// A separately loaded copy of this build: its memory is not the parent's, only the record is shared.
		const late = (await import(`../src/worker-admission.ts?late=${randomUUID()}`)) as typeof admissionModule;
		const real = fsutil.writeJsonAtomic;
		let interleaved = false;
		const gate = spyOn(fsutil, "writeJsonAtomic").mockImplementation(async (file, value) => {
			// The old writer is publishing its stop; open the next attempt after its read, before its write.
			if (!interleaved && typeof value === "object" && value !== null && "stop" in value) {
				interleaved = true;
				await admit();
			}
			await real(file, value);
		});
		try {
			expect(await late.recordWorkerStop(agentDir, { key: first.key, runId, childId, attempt: first.record.attempt, reason: "pooled-thread" })).toBe(false);
		} finally {
			gate.mockRestore();
		}
		const got = await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId });
		expect(got.kind === "record" && got.record.attempt).not.toBe(first.record.attempt);
		expect(got.kind === "record" && got.record.stop).toBeUndefined();
	});

	test("RF4-3: neither revocation nor a new acknowledgement replaces a record or marker of another build", async () => {
		await admit();
		const file = join(agentDir, "storm", "admissions", `${workerAdmissionKey(artifacts, parentId, childId)}.json`);
		const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		await writeFile(file, JSON.stringify({ ...raw, build: "another-build" }));
		const runs = join(agentDir, "storm", "admissions", "runs");
		const [markerName] = (await readdir(runs)).filter(name => name.endsWith(".json"));
		const markerFile = join(runs, markerName!);
		const markerRaw = JSON.parse(await readFile(markerFile, "utf8")) as Record<string, unknown>;
		await writeFile(markerFile, JSON.stringify({ ...markerRaw, build: "another-build" }));
		expect(await revokeWorkerAdmissions(agentDir, { runId })).toBe(0);
		expect((JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>).build).toBe("another-build");
		expect((JSON.parse(await readFile(markerFile, "utf8")) as Record<string, unknown>).build).toBe("another-build");
		// A new acknowledgement refuses the foreign marker, and then the foreign record.
		await expect(admit()).rejects.toThrow(/다른 빌드/);
		await writeFile(markerFile, JSON.stringify(markerRaw));
		await expect(admit()).rejects.toThrow(/다른 빌드/);
		expect((await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).kind).toBe("invalid");
	});

	test("RF4-9: an approved snapshot the store cannot hold is refused before anything is written", async () => {
		const wide = Array.from({ length: 4096 }, (_, index) => `a/${"m".repeat(1050)}-${index}`);
		expect(Buffer.byteLength(JSON.stringify(wide.map(selector => ({ selector, effort: "low" }))))).toBeGreaterThan(MAX_APPROVED_BYTES);
		await expect(admit({ approved: wide.map(selector => ({ selector, effort: "low" })) })).rejects.toThrow(/바이트/);
		expect((await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).kind).toBe("missing");
		// The run marker is written only after the record is known to fit; a live marker for an unstorable admission
		// would make every other unrecorded child of the run read as unknown (RF6o case 6).
		expect(await readdir(join(agentDir, "storm", "admissions", "runs")).catch(() => [] as string[])).toEqual([]);
	});

	test("RF6o case 7: a record near the size bound leaves room to be closed, or is refused", async () => {
		const id = "m".repeat(900);
		const near = Array.from({ length: 4351 }, (_, index) => ({ selector: `a/${id}-${index}`, effort: "low" as const }));
		await expect(admit({ approved: near })).rejects.toThrow(new RegExp(`${MAX_ADMISSION_BYTES - ADMISSION_CLOSING_ROOM}`));
		expect((await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId })).kind).toBe("missing");
		expect(await readdir(join(agentDir, "storm", "admissions", "runs")).catch(() => [] as string[])).toEqual([]);
	});

	test("RF4-11: housekeeping removes an aged record of an older schema and leaves a fresh one", async () => {
		const dir = join(agentDir, "storm", "admissions");
		await mkdir(dir, { recursive: true });
		const aged = join(dir, `${"a".repeat(64)}.json`);
		const fresh = join(dir, `${"b".repeat(64)}.json`);
		await writeFile(aged, JSON.stringify({ schema: "storm.worker-admission/v1", runId: "old" }));
		await writeFile(fresh, JSON.stringify({ schema: "storm.worker-admission/v1", runId: "old" }));
		const stale = new Date(Date.now() - 9 * 24 * 3_600_000);
		await utimes(aged, stale, stale);
		// At the cap: the admission's own housekeeping scan is what may remove the aged tombstone.
		await fillRecords(MAX_ADMISSION_RECORDS - 2);
		await admit({ childId: "AfterTombstone" });
		expect(await lstat(aged).catch(() => undefined)).toBeUndefined();
		expect((await lstat(fresh)).isFile()).toBe(true);
	});

	test("the cap is enforced by the writer that would cross it, and another session's expired record is what makes room", async () => {
		const dir = join(agentDir, "storm", "admissions");
		const recordCount = async (): Promise<number> => (await readdir(dir)).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length;
		// Another writer of the same profile fills the store to its cap, with one expired record among them. The next
		// writer scans only because it is at the crossing; the expired record frees its place, and the count was read
		// from the directory, never from this process's memory.
		await fillRecords(MAX_ADMISSION_RECORDS - 1);
		await fillRecords(1, { prefix: "expired-other", expired: true });
		expect(await recordCount()).toBe(MAX_ADMISSION_RECORDS);
		await admit({ childId: "AtCap" });
		expect(await recordCount()).toBe(MAX_ADMISSION_RECORDS);
		expect(await lstat(join(dir, `${workerAdmissionKey(artifacts, parentId, "expired-other-0")}.json`)).catch(() => undefined)).toBeUndefined();
		// A full store of records this build may not remove refuses the writer that would cross the cap, with the cause.
		await expect(admit({ childId: "Over" })).rejects.toThrow(/보관 중인 자식 권한 기록이 너무 많습니다/);
		expect(await recordCount()).toBe(MAX_ADMISSION_RECORDS);
		expect((await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "Over" })).kind).toBe("missing");
	});

	test("two writers that both see one free place cannot both cross the cap", async () => {
		await fillRecords(MAX_ADMISSION_RECORDS - 1);
		const results = await Promise.allSettled([admit({ childId: "RaceA" }), admit({ childId: "RaceB" })]);
		expect(results.filter(result => result.status === "rejected")).not.toHaveLength(0);
		const dir = join(agentDir, "storm", "admissions");
		const count = (await readdir(dir)).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length;
		expect(count).toBeLessThanOrEqual(MAX_ADMISSION_RECORDS);
	});

	test("the run marker is written when missing, repaired when another writer replaced it, and not rewritten for its own run", async () => {
		await admit();
		const runs = join(agentDir, "storm", "admissions", "runs");
		const [name] = (await readdir(runs)).filter(entry => entry.endsWith(".json"));
		const file = join(runs, name!);
		const marker = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		// A second admission of the same run reads the marker and does not rewrite it: a spawn's share of the marker is
		// one read, so no spawn queues behind another for it.
		const fixed = new Date("2026-11-20T00:00:00Z");
		await utimes(file, fixed, fixed);
		await admit({ childId: "Second" });
		expect((await lstat(file)).mtimeMs).toBe(fixed.getTime());
		expect((JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>).runId).toBe(runId);
		// Another run of this tree replaced it: the next admission names its own run again before its record is written.
		await writeFile(file, JSON.stringify({ ...marker, runId: "run-other", createdAt: Number(marker.createdAt) + 1 }));
		await admit({ childId: "Third" });
		expect((JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>).runId).toBe(runId);
		// Another writer removed it: the next admission writes it again, before its record can be read by the child.
		await rm(file, { force: true });
		const record = join(agentDir, "storm", "admissions", `${workerAdmissionKey(artifacts, parentId, "Fourth")}.json`);
		const realRename = fsp.rename;
		let observed: Record<string, unknown> | undefined;
		const spy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
			if (to === record && observed === undefined) {
				const raw = await readFile(file, "utf8").catch(() => "null");
				observed = JSON.parse(raw) as Record<string, unknown>;
			}
			await realRename(from, to);
		});
		try {
			await admit({ childId: "Fourth" });
		} finally {
			spy.mockRestore();
		}
		expect(observed).toMatchObject({ runId, key: name!.replace(/\.json$/, "") });
		// A marker of another build fails the admission closed before its record is written (RF4-3 holds for the
		// per-spawn repair too, not only for a marker that was already there when the run started).
		await writeFile(file, JSON.stringify({ ...marker, build: "another-build" }));
		await expect(admit({ childId: "Fifth" })).rejects.toThrow(/다른 빌드/);
		expect((await readWorkerAdmission({ agentDir, artifactRoot: artifacts, parentId, childId: "Fifth" })).kind).toBe("missing");
	});
});
