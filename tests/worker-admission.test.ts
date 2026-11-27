/** The persisted parent-to-child admission bridge, exercised without any in-process authority map. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lanePolicy } from "../src/policy/capability.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import type { PlanLane } from "../src/types.ts";
import {
	admissionMayUseNonReadTools,
	closeWorkerSpend,
	endWorkerAdmission,
	persistWorkerAdmission,
	readChildBinding,
	readWorkerAdmission,
	readWorkerSpendClose,
	resolveWorkerAdmission,
	revokeWorkerAdmissions,
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
	childId?: string;
	policy?: Parameters<typeof persistWorkerAdmission>[0]["policy"];
	lane?: string;
	hold?: string;
	runId?: string;
	targetRoot?: string;
	artifactRoot?: string;
	approved?: ReadonlyArray<{ selector: string; effort?: string }>;
} = {}) =>
	persistWorkerAdmission({
		agentDir,
		artifactRoot: over.artifactRoot ?? artifacts,
		parentId: over.parentId ?? parentId,
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

	test("RF10: the approved snapshot is kept whole and validated; a bad selector or effort is refused, never truncated", async () => {
		const entries = Array.from({ length: 65 }, (_, index) => ({ selector: `models/model-${index}`, effort: "low" }));
		await admit({ approved: entries });
		const binding = await readChildBinding({ agentDir, artifactRoot: artifacts, parentId, childId });
		expect(binding.kind === "bound" && binding.approved?.length).toBe(65);
		expect(binding.kind === "bound" && binding.approved?.at(-1)?.selector).toBe("models/model-64");
		await expect(admit({ childId: "BadEffort", approved: [{ selector: "models/x", effort: "not-an-effort" }] })).rejects.toThrow();
		await expect(admit({ childId: "BadSelector", approved: [{ selector: "no-provider" }] })).rejects.toThrow();
		await expect(admit({ childId: "TooMany", approved: Array.from({ length: 257 }, (_, index) => ({ selector: `models/m-${index}` })) })).rejects.toThrow();
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
		// Another session cannot close it, and a stale attempt closes nothing of a newer one.
		await admit({ lane: "L1" });
		expect(await resolve()).toMatchObject({ kind: "authorized" });
		expect(await endWorkerAdmission(agentDir, read.key, read.record.attempt, "child-session")).toBe(true);
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
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "open" });
		await admit({ childId: "A" });
		// The read above cached an answer before the marker existed; the marker it now names is still open.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "open" });
		const at = 1_800_000_000_000;
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "stop", now: at })).toEqual({ ok: true });
		// The reader had just cached the open marker: a changed file is read again rather than served from the cache.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		// A spawn admitted after the close does not erase it.
		await admit({ childId: "B" });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({ kind: "closed", close: { at, onExceed: "stop" } });
		expect(await closeWorkerSpend({ agentDir, artifactRoot: artifacts, parentId, runId, onExceed: "block-spawns", now: at + 1 })).toEqual({ ok: true });
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId })).toEqual({
			kind: "closed",
			close: { at: at + 1, onExceed: "block-spawns" },
		});
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
		// The identity of the worker's parent is required: without it no marker can be named.
		expect(await readWorkerSpendClose({ agentDir, artifactRoot: artifacts, parentId: undefined })).toMatchObject({ kind: "unknown" });
	});
});
