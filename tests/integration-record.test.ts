import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
	AdmissionKey, FrozenIntegrationAdmission, GitObjectSource, IntegrationCandidateId, IntegrationCheck,
	IntegrationRead, IntegrationTarget, SpaceIdentity,
} from "../src/runtime/integration-admission.ts";
import type { ByteWindow, ExactDeltaProof, IntegrationBytePort, StoredPatchRef } from "../src/runtime/integration-delta.ts";
import type { SealedCaptureManifest } from "../src/runtime/integration-capture.ts";
import type {
	IntegrationLiveGrant, ProvenEffectEnd, SelectionSnapshot, WriteIntent, WriteReceipt,
} from "../src/runtime/integration-record.ts";
import type { Installer } from "../src/runtime/integration-git.ts";
import {
	IntegrationJournal, IntegrationWriter, integrationCandidateId, type IntegrationJournalStore,
} from "../src/runtime/integration-record.ts";
import { GitDelta, spawnGit } from "../src/runtime/integration-git.ts";
import { acquireRunLease, canonicalWorktree } from "../src/runtime/lease.ts";
import { RunLanes, forgetRunLanes } from "../src/runtime/lanes.ts";

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function window(maxBytes = 64 * 1024 * 1024): ByteWindow {
	return { maxBytes, deadline: Date.now() + 120_000, signal: new AbortController().signal };
}

async function space(dir: string): Promise<SpaceIdentity> {
	const real = await realpath(dir);
	const st = await stat(real, { bigint: true });
	return { canonicalPath: real, device: st.dev.toString(), inode: st.ino.toString() };
}

function problem(code: string): { code: string; reason: string } {
	return { code, reason: code };
}

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
	const run = await spawnGit(args, { cwd });
	if (!run.started || run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
	return new TextDecoder().decode(run.stdout);
}

interface Repo {
	readonly tmp: string;
	readonly root: string;
	readonly sessionDir: string;
	readonly leaseDir: string;
	readonly key: AdmissionKey;
	readonly candidateId: ReturnType<typeof integrationCandidateId>;
	readonly patch: Uint8Array;
	readonly patchRef: StoredPatchRef;
	readonly target: IntegrationTarget;
	readonly proof: ExactDeltaProof;
	remove(): Promise<void>;
}

async function repo(): Promise<Repo> {
	const tmp = await realpath(await mkdtemp(path.join(tmpdir(), "storm-record-test-")));
	const root = path.join(tmp, "repo");
	const sessionDir = path.join(tmp, "agent", "storm", "sessions", "a".repeat(64));
	const leaseDir = path.join(tmp, "leases");
	await mkdir(root, { recursive: true });
	await mkdir(sessionDir, { recursive: true });
	await gitOut(root, "init", "-q");
	await gitOut(root, "config", "user.name", "t");
	await gitOut(root, "config", "user.email", "t@example.invalid");
	await gitOut(root, "config", "commit.gpgsign", "false");
	await writeFile(path.join(root, "edit.txt"), "base\n");
	await writeFile(path.join(root, "delete.txt"), "delete\n");
	await writeFile(path.join(root, "kept.txt"), "kept\n");
	await gitOut(root, "add", "-A");
	await gitOut(root, "commit", "-q", "-m", "base");
	await writeFile(path.join(root, "edit.txt"), "base\nWIP\n");
	await writeFile(path.join(root, "staged.txt"), "staged\n");
	await gitOut(root, "add", "staged.txt");
	await writeFile(path.join(root, "untracked.txt"), "untracked\n");

	const worktree = path.join(tmp, "child");
	await gitOut(root, "worktree", "add", "--detach", worktree, "HEAD");
	for (const name of ["edit.txt", "delete.txt", "kept.txt", "staged.txt", "untracked.txt"]) {
		await writeFile(path.join(worktree, name), await readFile(path.join(root, name)));
	}
	await gitOut(worktree, "add", "-A");
	const baseline = (await gitOut(worktree, "write-tree")).trim();
	await writeFile(path.join(worktree, "edit.txt"), "base\nWIP\nCHILD\n");
	await rm(path.join(worktree, "delete.txt"));
	await writeFile(path.join(worktree, "new.txt"), "new\n");
	await gitOut(worktree, "add", "-A");
	const after = (await gitOut(worktree, "write-tree")).trim();
	const patch = new TextEncoder().encode(
		await gitOut(root, "diff-tree", "-r", "-p", "--binary", "--no-color", "--no-commit-id", baseline, after),
	);
	const key: AdmissionKey = { schema: "storm.integration-admission/v1", runId: "run-record-0001", dispatch: "dispatch-1" };
	const candidateId = integrationCandidateId(key);
	const patchRef: StoredPatchRef = {
		schema: "storm.integration-patch/v1", key, objectKey: "objects/1", bytes: patch.byteLength, sha256: sha256(patch),
	};
	const canonical = await canonicalWorktree(root);
	if (canonical === undefined) throw new Error("root lost");
	const gitDir = await space(path.join(root, ".git"));
	const sourceOdb: GitObjectSource = { commonDir: gitDir, objects: await space(path.join(root, ".git", "objects")), objectFormat: "sha1" };
	const target: IntegrationTarget = {
		leaseKey: canonical.key,
		authorizedRoot: await space(root),
		gitRoot: await space(root),
		gitDir,
		sourceOdb,
		targetPrefix: "",
	};
	const bytes: IntegrationBytePort = { readPatch: async () => ({ kind: "known", value: patch }) };
	const proof = await new GitDelta({ bytes, run: spawnGit }).proveRoot({
		key,
		candidateId,
		target,
		scope: { kind: "unbounded" },
		sourceOdb,
		root: patchRef,
	}, window());
	if (proof.kind === "unknown") throw new Error(proof.problem.reason);
	return {
		tmp,
		root,
		sessionDir,
		leaseDir,
		key,
		candidateId,
		patch,
		patchRef,
		target,
		proof: proof.value,
		remove: () => rm(tmp, { recursive: true, force: true }),
	};
}

function admissionOf(item: Repo): FrozenIntegrationAdmission {
	return {
		key: item.key,
		candidateId: item.candidateId,
		director: { sessionId: "session-1", sessionInstance: "instance-1", sessionDir: item.sessionDir, parentId: "parent-1" },
		target: item.target,
		artifactRoot: item.target.authorizedRoot,
		item: { toolCallId: "call-1", itemIndex: 0, handle: "handle-1" },
		placementOrdinal: 1,
		approvedDefinitionDigest: "a".repeat(64),
		approvalDigest: "b".repeat(64),
		workerAdmission: { key: "worker-key", attempt: "attempt-1", approved: [{ selector: "provider/model", effort: "high" }] },
		scope: { kind: "unbounded" },
		subject: { kind: "unplanned" },
		policy: {
			id: "policy-1", host: "19.2.1", settingsInstance: "settings-1", relevantEpoch: 1, directorInstance: "instance-1",
			toolCallId: "call-1", enabled: true, backendProofId: "backend-1", apply: false, merge: "patch",
			captureContract: "native-git-synthetic-tree", backendSetting: "native", profile: "p", guardBuild: "guard-1",
		},
		slot: { key: item.key, profile: "p", slotPath: "/tmp/slot-1", ownerToken: "owner-1" },
		startedAt: Date.now(),
	};
}

function manifestOf(item: Repo, digest = "c".repeat(64)): SealedCaptureManifest {
	const unknown = { kind: "unknown" as const, problem: problem("test") };
	return {
		schema: "storm.integration-capture/v1",
		digest,
		admission: admissionOf(item),
		childClaim: unknown,
		terminal: unknown,
		bundle: { kind: "root-only", basis: "sync-explicit", root: item.patchRef },
		delta: { kind: "known", value: item.proof },
		recovery: {
			root: { kind: "unknown", problem: problem("test") },
			nested: { kind: "unknown", problem: problem("test") },
			branch: { kind: "unknown", problem: problem("test") },
			checkout: { kind: "unknown", problem: problem("test") },
			nativeLink: { kind: "unknown", problem: problem("test") },
		},
	};
}

function intentOf(item: Repo, sequence: number, token: string): WriteIntent {
	return {
		schema: "storm.integration-intent/v1",
		sequence,
		candidate: { key: item.key, candidateId: item.candidateId, manifestDigest: "c".repeat(64) },
		deltaDigest: item.proof.digest,
		target: item.target,
		index: { path: path.join(item.target.gitDir.canonicalPath, "index"), file: null, sha256: null },
		head: { ref: null, oid: null },
		paths: item.proof.entries.map(entry => ({
			path: entry.targetPath,
			before: entry.before.state.kind === "absent" ? { kind: "absent" } : entry.before.state,
			after: entry.after.state.kind === "absent" ? { kind: "absent" } : entry.after.state,
		})),
		audit: { selection: { runId: item.key.runId, callId: "call-1" }, director: admissionOf(item).director, conversationId: "conversation-1", askId: "ask-1", deadline: Date.now() + 60_000 },
		owner: { token: "owner-1234", pid: process.pid, host: "host", processStart: 1 },
		holderKey: "segment-1",
		effectToken: token,
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("integration journal", () => {
	test("manifests append once, replay in order and refuse a second seal for one admission", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		const manifest = manifestOf(item);
		expect(await journal.appendManifest(manifest)).toEqual({ kind: "known", value: 1 });
		expect(await journal.appendManifest(manifest)).toEqual({ kind: "known", value: 1 });
		expect(await journal.appendManifest(manifestOf(item, "d".repeat(64)))).toMatchObject({
			kind: "unknown", problem: { code: "integration-seal-conflict" },
		});
		const read = await journal.readCandidate(item.key.runId, item.candidateId);
		expect(read.kind).toBe("known");
		if (read.kind === "known") expect(read.value?.manifest.digest).toBe(manifest.digest);
		const seen: string[] = [];
		const replay = await journal.replay(item.key.runId, entry => seen.push(entry.manifest.digest));
		expect(replay).toEqual({ kind: "known", value: { lastSequence: 1 } });
		expect(seen).toEqual([manifest.digest]);
	});

	test("a torn or foreign tail is unknown, not an empty record", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		await journal.appendManifest(manifestOf(item));
		const file = path.join(item.sessionDir, "state", "integration", "runs", item.key.runId, "journal.jsonl");
		await writeFile(file, `${await readFile(file, "utf8")}{"schema":`, "utf8");
		const restarted = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		expect(await restarted.readCandidate(item.key.runId, item.candidateId)).toMatchObject({
			kind: "unknown", problem: { code: "integration-journal-torn" },
		});
		expect(await restarted.appendManifest(manifestOf(item))).toMatchObject({
			kind: "unknown", problem: { code: "integration-journal-torn" },
		});
	});

	test("selections and steps are idempotent and keyed by the exact call", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		const selection: SelectionSnapshot = { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] };
		await journal.appendManifest(manifestOf(item));
		expect(await journal.beginSelection(selection)).toEqual({ ok: true });
		expect(await journal.beginSelection(selection)).toEqual({ ok: true });
		expect(await journal.beginSelection({ ...selection, chosen: [], ordered: [] })).toMatchObject({ ok: false });
		expect(await journal.recordStep({ runId: item.key.runId, callId: "other" }, { candidateId: item.candidateId, state: "written" })).toMatchObject({ ok: false });
		const step = { candidateId: item.candidateId, state: "conflict" as const, problem: { code: "test-conflict", reason: "test" } };
		expect(await journal.recordStep(selection.key, step)).toEqual({ ok: true });
		expect(await journal.recordStep(selection.key, step)).toEqual({ ok: true });
		const read = await journal.readCandidate(item.key.runId, item.candidateId);
		expect(read.kind === "known" && read.value?.lastWrite?.kind).toBe("conflict");
	});

	test("a fence is discoverable from another session and only exact coherent states release it", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		const otherSession = path.join(item.tmp, "other-session");
		await mkdir(otherSession, { recursive: true });
		const other = new IntegrationJournal({ sessionDir: otherSession, leaseDeps: { dir: item.leaseDir } });
		expect(await journal.findFence({ canonicalRoot: item.root })).toEqual({ kind: "clear" });
		await journal.appendManifest(manifestOf(item));
		const intentRead = await journal.appendIntent({ runId: item.key.runId, build: sequence => intentOf(item, sequence, "effect-token-1") });
		if (intentRead.kind === "unknown") throw new Error(intentRead.problem.reason);
		const fenceRead = await journal.writeFence(intentRead.value);
		if (fenceRead.kind === "unknown") throw new Error(fenceRead.problem.reason);
		const fence = fenceRead.value;
		expect(await other.findFence({ canonicalRoot: item.root })).toEqual({ kind: "fenced", fence });
		await journal.appendEffectEnd(item.key.runId, { token: fence.effectToken, basis: "never-dispatched", observedAt: Date.now() });
		const released = await other.resolveFence({
			fence,
			audit: { sessionId: "session-1", userActionId: "user-1", acknowledgedAt: Date.now() },
			checkOperator: () => ({ ok: true }),
		}, window());
		expect(released).toEqual({ kind: "released", disposition: "proved-no-effect" });
		expect(await other.findFence({ canonicalRoot: item.root })).toEqual({ kind: "clear" });
	});

	test("all-post without a receipt is present-unattributed, mixed stays fenced, garbage is unknown", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		await journal.appendManifest(manifestOf(item));
		const intentRead = await journal.appendIntent({ runId: item.key.runId, build: sequence => intentOf(item, sequence, "effect-token-2") });
		if (intentRead.kind === "unknown") throw new Error(intentRead.problem.reason);
		const fenceRead = await journal.writeFence(intentRead.value);
		if (fenceRead.kind === "unknown") throw new Error(fenceRead.problem.reason);
		const fence = fenceRead.value;
		await journal.appendEffectEnd(item.key.runId, { token: fence.effectToken, basis: "installer-exit-proved", observedAt: Date.now() });
		for (const entry of item.proof.entries) {
			if (entry.after.state.kind === "absent") await rm(path.join(item.root, entry.targetPath), { force: true });
			else await writeFile(path.join(item.root, entry.targetPath), await blobBytes(item, entry.after.state.sha256));
		}
		expect(await journal.resolveFence({
			fence,
			audit: { sessionId: "session-1", userActionId: "user-1", acknowledgedAt: Date.now() },
			checkOperator: () => ({ ok: true }),
		}, window())).toEqual({ kind: "released", disposition: "present-unattributed" });
		expect(await journal.findFence({ canonicalRoot: item.root })).toEqual({ kind: "clear" });

		// Mixed images and an unreadable fence file keep the target fenced.
		const second = await journal.appendIntent({ runId: item.key.runId, build: sequence => intentOf(item, sequence, "effect-token-3") });
		if (second.kind === "unknown") throw new Error(second.problem.reason);
		const secondFence = await journal.writeFence(second.value);
		if (secondFence.kind === "unknown") throw new Error(secondFence.problem.reason);
		await writeFile(path.join(item.root, "edit.txt"), "base\nWIP\nMIXED\n");
		const mixed = await journal.resolveFence({
			fence: secondFence.value,
			audit: { sessionId: "session-1", userActionId: "user-1", acknowledgedAt: Date.now() },
			checkOperator: () => ({ ok: true }),
		}, window());
		expect(mixed.kind).toBe("kept");
		const dir = path.join(item.leaseDir, "worktrees", item.target.leaseKey, "integration", "fences");
		const names = await readdir(dir);
		await writeFile(path.join(dir, names[0]!), "not json", "utf8");
		expect(await journal.findFence({ canonicalRoot: item.root })).toMatchObject({ kind: "unknown" });
	});
});

async function blobBytes(item: Repo, digest: string): Promise<Uint8Array> {
	// The proof carries digests, not retained bytes; the original child worktree still has the after file bytes.
	const child = path.join(item.tmp, "child");
	for (const entry of item.proof.entries) {
		if (entry.after.state.kind !== "file") continue;
		try {
			const bytes = await readFile(path.join(child, entry.targetPath));
			if (sha256(bytes) === digest) return bytes;
		} catch {
			// not this file
		}
	}
	throw new Error(`no bytes for ${digest}`);
}

describe("integration writer", () => {
	test("writes one selected candidate, keeps the index, and reports the receipt twice", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		await journal.appendManifest(manifestOf(item));
		const lanes = new RunLanes(item.key.runId);
		cleanups.push(async () => forgetRunLanes(item.key.runId));
		const acquired = await acquireRunLease({
			sessionDir: item.sessionDir,
			sessionId: "session-1",
			root: item.root,
			runId: item.key.runId,
			mode: "write",
		}, { dir: item.leaseDir });
		if (!acquired.ok) throw new Error(acquired.reason);
		const lease = acquired.lease;
		cleanups.push(() => lease.release());
		const writer = new IntegrationWriter({
			journal,
			bytes: { readPatch: async () => ({ kind: "known", value: item.patch }) },
			delta: new GitDelta({ bytes: { readPatch: async () => ({ kind: "known", value: item.patch }) }, run: spawnGit }),
			run: spawnGit,
		});
		const live = liveGrant(item);
		const selection: SelectionSnapshot = { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] };
		const reserve = await writer.reserveSegment({
			lease,
			target: item.target,
			selection,
			live,
			window: window(),
		});
		if (reserve.kind === "unknown") throw new Error(reserve.problem.reason);
		const beforeIndex = await readFile(path.join(item.root, ".git", "index"));
		const candidate = { key: item.key, candidateId: item.candidateId, manifestDigest: "c".repeat(64) };
		const first = await writer.applyCandidate({ holder: reserve.value, candidate, proof: item.proof, window: window() });
		expect(first.kind).toBe("written");
		expect(await readFile(path.join(item.root, "edit.txt"), "utf8")).toBe("base\nWIP\nCHILD\n");
		expect(await readFile(path.join(item.root, "kept.txt"), "utf8")).toBe("kept\n");
		expect(await readFile(path.join(item.root, ".git", "index"))).toEqual(beforeIndex);
		const second = await writer.applyCandidate({ holder: reserve.value, candidate, proof: item.proof, window: window() });
		expect(second.kind).toBe("already-written");
		if (second.kind === "already-written") expect(second.presence.kind).toBe("present");
		expect(await journal.findFence({ canonicalRoot: item.root })).toEqual({ kind: "clear" });
		expect(await writer.finishSegment(reserve.value)).toEqual({ ok: true });
		expect(lanes.commitHolder({ kind: "job", key: "job-1", now: Date.now() })).toEqual({ ok: true });
		lanes.releaseHolder("job", "job-1");
	});

	test("a job holding the tree refuses the segment before any intent", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		await journal.appendManifest(manifestOf(item));
		const lanes = new RunLanes(item.key.runId);
		cleanups.push(async () => forgetRunLanes(item.key.runId));
		const acquired = await acquireRunLease({
			sessionDir: item.sessionDir, sessionId: "session-1", root: item.root, runId: item.key.runId, mode: "write",
		}, { dir: item.leaseDir });
		if (!acquired.ok) throw new Error(acquired.reason);
		cleanups.push(() => acquired.lease.release());
		lanes.commitHolder({ kind: "job", key: "job-1", now: Date.now() });
		const writer = writerFor(item, journal);
		const reserved = await writer.reserveSegment({
			lease: acquired.lease,
			target: item.target,
			selection: { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] },
			live: liveGrant(item),
			window: window(),
		});
		expect(reserved).toMatchObject({ kind: "unknown", problem: { code: "integration-table" } });
	});

	test("a never-dispatched installer writes no effect and clears its fence", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		await journal.appendManifest(manifestOf(item));
		const lanes = new RunLanes(item.key.runId);
		cleanups.push(async () => forgetRunLanes(item.key.runId));
		const acquired = await acquireRunLease({
			sessionDir: item.sessionDir, sessionId: "session-1", root: item.root, runId: item.key.runId, mode: "write",
		}, { dir: item.leaseDir });
		if (!acquired.ok) throw new Error(acquired.reason);
		cleanups.push(() => acquired.lease.release());
		const writer = writerFor(item, journal, { install: async () => ({ kind: "never-dispatched", reason: "scripted" }) });
		const reserved = await writer.reserveSegment({
			lease: acquired.lease, target: item.target,
			selection: { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] },
			live: liveGrant(item), window: window(),
		});
		if (reserved.kind === "unknown") throw new Error(reserved.problem.reason);
		expect(lanes.integrationHeld(reserved.value.key)).toBe(true);
		const result = await writer.applyCandidate({
			holder: reserved.value,
			candidate: { key: item.key, candidateId: item.candidateId, manifestDigest: "c".repeat(64) },
			proof: item.proof,
			window: window(),
		});
		expect(result.kind).toBe("no-effect");
		expect(await readFile(path.join(item.root, "edit.txt"), "utf8")).toBe("base\nWIP\n");
		expect(await journal.findFence({ canonicalRoot: item.root })).toEqual({ kind: "clear" });
	});

	test("a lost receipt keeps the fence and reports recovery-required", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new FaultJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } }, "receipt");
		await journal.appendManifest(manifestOf(item));
		const lanes = new RunLanes(item.key.runId);
		cleanups.push(async () => forgetRunLanes(item.key.runId));
		const acquired = await acquireRunLease({
			sessionDir: item.sessionDir, sessionId: "session-1", root: item.root, runId: item.key.runId, mode: "write",
		}, { dir: item.leaseDir });
		if (!acquired.ok) throw new Error(acquired.reason);
		cleanups.push(() => acquired.lease.release());
		const writer = writerFor(item, journal);
		const reserved = await writer.reserveSegment({
			lease: acquired.lease, target: item.target,
			selection: { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] },
			live: liveGrant(item), window: window(),
		});
		if (reserved.kind === "unknown") throw new Error(reserved.problem.reason);
		expect(lanes.integrationHeld(reserved.value.key)).toBe(true);
		const result = await writer.applyCandidate({
			holder: reserved.value,
			candidate: { key: item.key, candidateId: item.candidateId, manifestDigest: "c".repeat(64) },
			proof: item.proof,
			window: window(),
		});
		expect(result.kind).toBe("recovery-required");
		expect(await journal.findFence({ canonicalRoot: item.root })).toMatchObject({ kind: "fenced" });
		const fenceLookup = await journal.findFence({ canonicalRoot: item.root });
		expect(fenceLookup.kind).toBe("fenced");
		if (fenceLookup.kind === "fenced") {
			const inspected = await journal.inspectFence(fenceLookup.fence, window());
			expect(inspected.kind).toBe("known");
			if (inspected.kind === "known") expect(inspected.value.images).toEqual({ kind: "known", value: "all-post" });
		}
	});

	test("a lease epoch change after the reservation refuses before dispatch", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		await journal.appendManifest(manifestOf(item));
		const lanes = new RunLanes(item.key.runId);
		cleanups.push(async () => forgetRunLanes(item.key.runId));
		const acquired = await acquireRunLease({
			sessionDir: item.sessionDir, sessionId: "session-1", root: item.root, runId: item.key.runId, mode: "write",
		}, { dir: item.leaseDir });
		if (!acquired.ok) throw new Error(acquired.reason);
		cleanups.push(() => acquired.lease.release());
		const writer = writerFor(item, journal);
		const reserved = await writer.reserveSegment({
			lease: acquired.lease, target: item.target,
			selection: { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] },
			live: liveGrant(item), window: window(),
		});
		if (reserved.kind === "unknown") throw new Error(reserved.problem.reason);
		const upgraded = await acquired.lease.upgrade({ scope: { kind: "paths", paths: ["edit.txt"] } });
		expect(upgraded.ok).toBe(true);
		const result = await writer.applyCandidate({
			holder: reserved.value,
			candidate: { key: item.key, candidateId: item.candidateId, manifestDigest: "c".repeat(64) },
			proof: item.proof,
			window: window(),
		});
		expect(result).toMatchObject({ kind: "refused", problem: { code: "integration-lease" } });
		expect(await readFile(path.join(item.root, "edit.txt"), "utf8")).toBe("base\nWIP\n");
		expect(lanes.integrationHeld(reserved.value.key)).toBe(true);
	});

	test("a manually matching postimage is present-unattributed, never a receipt", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
		await journal.appendManifest(manifestOf(item));
		const lanes = new RunLanes(item.key.runId);
		cleanups.push(async () => forgetRunLanes(item.key.runId));
		const acquired = await acquireRunLease({
			sessionDir: item.sessionDir, sessionId: "session-1", root: item.root, runId: item.key.runId, mode: "write",
		}, { dir: item.leaseDir });
		if (!acquired.ok) throw new Error(acquired.reason);
		cleanups.push(() => acquired.lease.release());
		for (const entry of item.proof.entries) {
			if (entry.after.state.kind === "absent") await rm(path.join(item.root, entry.targetPath), { force: true });
			else await writeFile(path.join(item.root, entry.targetPath), await blobBytes(item, entry.after.state.sha256));
		}
		const writer = writerFor(item, journal);
		const reserved = await writer.reserveSegment({
			lease: acquired.lease, target: item.target,
			selection: { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] },
			live: liveGrant(item), window: window(),
		});
		if (reserved.kind === "unknown") throw new Error(reserved.problem.reason);
		expect(lanes.integrationHeld(reserved.value.key)).toBe(true);
		const result = await writer.applyCandidate({
			holder: reserved.value,
			candidate: { key: item.key, candidateId: item.candidateId, manifestDigest: "c".repeat(64) },
			proof: item.proof,
			window: window(),
		});
		expect(result.kind).toBe("present-unattributed");
		expect(await journal.receiptFor(item.key.runId, item.candidateId)).toEqual({ kind: "known", value: null });
	});
});

function writerFor(item: Repo, journal: IntegrationJournalStore, installer?: Installer): IntegrationWriter {
	return new IntegrationWriter({
		journal,
		bytes: { readPatch: async () => ({ kind: "known", value: item.patch }) },
		delta: new GitDelta({ bytes: { readPatch: async () => ({ kind: "known", value: item.patch }) }, run: spawnGit }),
		run: spawnGit,
		...(installer === undefined ? {} : { installer }),
	});
}

function liveGrant(item: Repo): IntegrationLiveGrant {
	return {
		audit: {
			selection: { runId: item.key.runId, callId: "call-1" },
			director: { sessionId: "session-1", sessionInstance: "instance-1", sessionDir: item.sessionDir, parentId: "parent-1" },
			conversationId: "conversation-1",
			askId: "ask-1",
			deadline: Date.now() + 60_000,
		},
		signal: new AbortController().signal,
		check: () => ({ ok: true }),
		revalidateCandidate: async () => ({ ok: true }),
		checkCandidate: () => ({ ok: true }),
	};
}

class FaultJournal extends IntegrationJournal {
	constructor(
		options: { readonly sessionDir: string; readonly leaseDeps?: { readonly dir?: string } },
		private readonly fault: "receipt" | "effect-end",
	) {
		super(options);
	}

	override appendReceipt(
		runId: AdmissionKey["runId"],
		candidateId: IntegrationCandidateId,
		build: (sequence: number) => WriteReceipt,
	): Promise<IntegrationRead<WriteReceipt>> {
		if (this.fault === "receipt") return Promise.resolve({ kind: "unknown", problem: problem("fault-receipt") });
		return super.appendReceipt(runId, candidateId, build);
	}

	override appendEffectEnd(runId: AdmissionKey["runId"], end: ProvenEffectEnd): Promise<IntegrationCheck> {
		if (this.fault === "effect-end") return Promise.resolve({ ok: false, problem: problem("fault-effect-end") });
		return super.appendEffectEnd(runId, end);
	}
}
