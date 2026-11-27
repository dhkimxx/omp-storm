/** The persisted parent-to-child admission bridge, exercised without any in-process authority map. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lanePolicy } from "../src/policy/capability.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import type { PlanLane } from "../src/types.ts";
import {
	endWorkerAdmission,
	persistWorkerAdmission,
	readWorkerAdmission,
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
	targetRoot?: string;
	artifactRoot?: string;
} = {}) =>
	persistWorkerAdmission({
		agentDir,
		artifactRoot: over.artifactRoot ?? artifacts,
		parentId: over.parentId ?? parentId,
		childId: over.childId ?? childId,
		runId,
		sessionId: "main-session",
		sessionDir,
		repoId: "repo-test",
		targetRoot: over.targetRoot ?? project,
		...(over.lane === undefined ? {} : { lane: over.lane }),
		policy: over.policy ?? { kind: "paths", paths: ["allowed.txt"], reason: "test lane" },
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
});
