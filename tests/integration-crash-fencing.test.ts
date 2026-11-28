/**
 * Process-level regression for the Git installer fence: a real writer process observes its durable intent and fence,
 * then dies after the real mutating `git apply` but before any verified end or receipt. A second owner in this process
 * must not be able to start an effect, and neither elapsed time nor a byte-perfect all-post target may release the
 * fence.
 *
 * The fixture is private per test: a canonical temp repository, its own session journal, its own lease directory, and
 * real `git` children. No live OMP session, model, credential or fault-injected native effect is involved. The
 * positive control runs the same fixture to a real `installer-exit-proved` end and receipt, so a clean end demonstrably
 * takes the other path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
	AdmissionKey, FrozenIntegrationAdmission, GitObjectSource, IntegrationCandidateId,
	IntegrationTarget, SpaceIdentity,
} from "../src/runtime/integration-admission.ts";
import type { ByteWindow, ExactDeltaProof, IntegrationBytePort, StoredPatchRef } from "../src/runtime/integration-delta.ts";
import type { SealedCaptureManifest } from "../src/runtime/integration-capture.ts";
import type { WriteAuthorityAudit } from "../src/runtime/integration-record.ts";
import { IntegrationJournal } from "../src/runtime/integration-record.ts";
import { GitDelta, spawnGit } from "../src/runtime/integration-git.ts";
import { acquireRunLease, canonicalWorktree } from "../src/runtime/lease.ts";

const OWNER_SCRIPT = path.join(import.meta.dir, "integration-crash-owner.ts");

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function window(): ByteWindow {
	return { maxBytes: 64 * 1024 * 1024, deadline: Date.now() + 120_000, signal: new AbortController().signal };
}

function problem(code: string): { code: string; reason: string } {
	return { code, reason: code };
}

async function space(dir: string): Promise<SpaceIdentity> {
	const real = await realpath(dir);
	const st = await stat(real, { bigint: true });
	return { canonicalPath: real, device: st.dev.toString(), inode: st.ino.toString() };
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
	readonly candidateId: IntegrationCandidateId;
	readonly patch: Uint8Array;
	readonly patchRef: StoredPatchRef;
	readonly target: IntegrationTarget;
	readonly proof: ExactDeltaProof;
	remove(): Promise<void>;
}

/** One canonical repository, one child worktree, one exact delta proof; never shared between tests. */
async function repo(): Promise<Repo> {
	const tmp = await realpath(await mkdtemp(path.join(tmpdir(), "storm-crash-fence-")));
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
	const key: AdmissionKey = { schema: "storm.integration-admission/v1", runId: "run-crash-0001", dispatch: "dispatch-1" };
	const candidateId = `c1_${sha256(JSON.stringify([key.schema, key.runId, key.dispatch]))}` as IntegrationCandidateId;
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

function manifestOf(item: Repo): SealedCaptureManifest {
	const unknown = { kind: "unknown" as const, problem: problem("test") };
	return {
		schema: "storm.integration-capture/v1",
		digest: "c".repeat(64),
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

function journalFor(item: Repo): IntegrationJournal {
	return new IntegrationJournal({ sessionDir: item.sessionDir, leaseDeps: { dir: item.leaseDir } });
}

function journalPath(item: Repo): string {
	return path.join(item.sessionDir, "state", "integration", "runs", item.key.runId, "journal.jsonl");
}

interface JournalRow {
	readonly kind: string;
	readonly payload: unknown;
}

async function journalRows(item: Repo): Promise<JournalRow[]> {
	const text = await readFile(journalPath(item), "utf8");
	return text.split("\n").filter(line => line !== "").map(line => JSON.parse(line) as JournalRow);
}

function payloadObject(row: JournalRow): Record<string, unknown> {
	if (typeof row.payload !== "object" || row.payload === null || Array.isArray(row.payload)) throw new Error(`bad ${row.kind} payload`);
	return row.payload as Record<string, unknown>;
}

/** The exact fixture the child needs to reconstruct the writer; the manifest is already durable in the journal. */
async function writeOwnerFixture(item: Repo, mode: "crash-after-apply" | "complete"): Promise<string> {
	const patchPath = path.join(item.tmp, "patch.bin");
	await writeFile(patchPath, item.patch);
	const audit: WriteAuthorityAudit = {
		selection: { runId: item.key.runId, callId: "call-1" },
		director: admissionOf(item).director,
		conversationId: "conversation-1",
		askId: "ask-1",
		deadline: Date.now() + 120_000,
	};
	const fixture = {
		mode,
		root: item.root,
		sessionDir: item.sessionDir,
		leaseDir: item.leaseDir,
		sessionId: "session-1",
		runId: item.key.runId,
		key: item.key,
		candidateId: item.candidateId,
		candidate: { key: item.key, candidateId: item.candidateId, manifestDigest: "c".repeat(64) },
		patchPath,
		target: item.target,
		proof: item.proof,
		selection: { key: { runId: item.key.runId, callId: "call-1" }, chosen: [item.candidateId], ordered: [item.candidateId] },
		audit,
	};
	const file = path.join(item.tmp, "owner.json");
	await writeFile(file, `${JSON.stringify(fixture)}\n`);
	return file;
}

async function spawnOwner(item: Repo, fixturePath: string) {
	const home = path.join(item.tmp, "child-home");
	const scratch = path.join(item.tmp, "child-tmp");
	await Promise.all([mkdir(home, { recursive: true }), mkdir(scratch, { recursive: true })]);
	return Bun.spawn([process.execPath, OWNER_SCRIPT, fixturePath], {
		cwd: item.tmp,
		env: {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: home,
			TMPDIR: scratch,
			LANG: "C",
			LC_ALL: "C",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

/** Line-oriented stdout reader with its own deadline, so a child stuck before its report cannot hang the test. */
function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<Record<string, unknown>> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return async (timeoutMs = 20_000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line !== "") return JSON.parse(line) as Record<string, unknown>;
				continue;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("owner produced no line before the deadline");
			// This only bounds a stalled real child before it reports; fake timers cannot advance another process, so the
			// watchdog is the one place real time is used and it adds no delay on the success path.
			const timer = Promise.withResolvers<"timeout">();
			const handle = setTimeout(() => timer.resolve("timeout"), remaining);
			const outcome = await Promise.race([
				reader.read().then(value => ({ kind: "read" as const, value })),
				timer.promise.then(() => ({ kind: "timeout" as const })),
			]);
			clearTimeout(handle);
			if (outcome.kind === "timeout") throw new Error("owner produced no line before the deadline");
			if (outcome.value.done) throw new Error("owner closed stdout before its report");
			buffer += decoder.decode(outcome.value.value, { stream: true });
		}
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A dead owner's record must be reclaimed, then the unresolved fence must be the reason the write lease is refused. */
async function writeRefusal(item: Repo): Promise<string> {
	let last = "";
	for (let attempt = 0; attempt < 200; attempt++) {
		const result = await acquireRunLease({
			sessionDir: item.sessionDir, sessionId: "session-1", root: item.root, runId: item.key.runId, mode: "write",
		}, { dir: item.leaseDir });
		if (result.ok) {
			await result.lease.release();
			throw new Error("the unresolved fence did not block a second write owner");
		}
		last = result.reason;
		if (last.includes("통합 펜스")) return last;
		const yielded = Promise.withResolvers<void>();
		setImmediate(() => yielded.resolve());
		await yielded.promise;
	}
	throw new Error(`second write owner was not blocked by the integration fence: ${last}`);
}

interface FileImage {
	readonly kind: "absent" | "file";
	readonly mode?: "100644" | "100755";
	readonly bytes?: number;
	readonly sha256?: string;
}

async function imageAt(file: string): Promise<FileImage> {
	try {
		const st = await stat(file);
		const bytes = await readFile(file);
		return { kind: "file", mode: (st.mode & 0o111) === 0 ? "100644" : "100755", bytes: bytes.byteLength, sha256: sha256(bytes) };
	} catch {
		return { kind: "absent" };
	}
}

describe("process death after the real Git effect", () => {
	test("a killed installer leaves a durable intent whose missing end blocks a second owner", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = journalFor(item);
		expect(await journal.appendManifest(manifestOf(item))).toEqual({ kind: "known", value: 1 });
		const beforeIndex = await readFile(path.join(item.target.gitDir.canonicalPath, "index"));
		const beforeHead = (await gitOut(item.root, "rev-parse", "HEAD")).trim();
		const fixturePath = await writeOwnerFixture(item, "crash-after-apply");
		const owner = await spawnOwner(item, fixturePath);
		const nextLine = lineReader(owner.stdout);
		const stderr = new Response(owner.stderr).text();
		let dead = false;
		try {
			expect(await nextLine()).toMatchObject({ stage: "applied", code: 0 });
			expect(owner.exitCode).toBeNull();

			// The intent and the pointer are already durable while the owner is still alive, and the real Git effect is
			// visible as the exact postimage. Only the verified end and receipt are missing.
			const observer = journalFor(item);
			const lookup = await observer.findFence({ canonicalRoot: item.root });
			expect(lookup.kind).toBe("fenced");
			if (lookup.kind !== "fenced") throw new Error("the child's fence was not observable before death");
			const fence = lookup.fence;
			const pointer = await observer.fencePointer(fence);
			expect(pointer.kind).toBe("known");
			if (pointer.kind === "known") expect(pointer.value.journalPath).toBe(journalPath(item));
			const inspected = await observer.inspectFence(fence, window());
			expect(inspected.kind).toBe("known");
			if (inspected.kind === "known") {
				expect(inspected.value.images).toEqual({ kind: "known", value: "all-post" });
				expect(inspected.value.effectEnd.kind).toBe("unknown");
				expect(inspected.value.receipt).toEqual({ kind: "known", value: null });
			}
			const rowsBeforeKill = await journalRows(item);
			expect(rowsBeforeKill.filter(row => row.kind === "intent")).toHaveLength(1);
			expect(rowsBeforeKill.filter(row => row.kind === "effect-end")).toHaveLength(0);
			expect(rowsBeforeKill.filter(row => row.kind === "receipt")).toHaveLength(0);
			expect(rowsBeforeKill.filter(row => row.kind === "fence-clear")).toHaveLength(0);
			const rawBeforeKill = await readFile(journalPath(item), "utf8");
			for (const entry of item.proof.entries) {
				const actual = await imageAt(path.join(item.root, entry.targetPath));
				const expected: FileImage = entry.after.state.kind === "absent"
					? { kind: "absent" }
					: { kind: "file", mode: entry.after.state.mode, bytes: entry.after.state.bytes, sha256: entry.after.state.sha256 };
				expect(actual).toEqual(expected);
			}
			expect(await readFile(path.join(item.target.gitDir.canonicalPath, "index"))).toEqual(beforeIndex);
			expect((await gitOut(item.root, "rev-parse", "HEAD")).trim()).toBe(beforeHead);

			owner.kill("SIGKILL");
			dead = true;
			await owner.exited;
			expect(owner.exitCode).toBeNull();
			expect(owner.signalCode === "SIGKILL" || owner.signalCode === 9).toBe(true);

			// A different writer object reopens the same durable journal as the second owner.
			const restarted = journalFor(item);
			expect(await restarted.findFence({ canonicalRoot: item.root })).toEqual({ kind: "fenced", fence });
			const afterDeath = await restarted.inspectFence(fence, window());
			expect(afterDeath.kind).toBe("known");
			if (afterDeath.kind === "known") {
				expect(afterDeath.value.images).toEqual({ kind: "known", value: "all-post" });
				expect(afterDeath.value.effectEnd.kind).toBe("unknown");
				expect(afterDeath.value.receipt).toEqual({ kind: "known", value: null });
			}
			expect(await restarted.receiptFor(item.key.runId, item.candidateId)).toEqual({ kind: "known", value: null });
			expect(await readFile(journalPath(item), "utf8")).toBe(rawBeforeKill);

			// Matching postimage bytes and a live operator confirmation are not a durable end: the fence stays.
			const resolution = await restarted.resolveFence({
				fence,
				audit: { sessionId: "session-1", userActionId: "user-1", acknowledgedAt: Date.now() },
				checkOperator: () => ({ ok: true }),
			}, window());
			expect(resolution).toMatchObject({ kind: "kept", problem: { code: "integration-fence" } });
			expect(await readFile(journalPath(item), "utf8")).toBe(rawBeforeKill);
			expect(await restarted.findFence({ canonicalRoot: item.root })).toEqual({ kind: "fenced", fence });

			// An elapsed window is also not a release, not even for a byte-perfect all-post target.
			const expired = await restarted.resolveFence({
				fence,
				audit: { sessionId: "session-1", userActionId: "user-1", acknowledgedAt: Date.now() },
				checkOperator: () => ({ ok: true }),
			}, { maxBytes: 64 * 1024 * 1024, deadline: Date.now() - 1, signal: new AbortController().signal });
			expect(expired).toMatchObject({ kind: "kept", problem: { code: "integration-fence" } });
			expect(await readFile(journalPath(item), "utf8")).toBe(rawBeforeKill);
			expect(await restarted.findFence({ canonicalRoot: item.root })).toEqual({ kind: "fenced", fence });

			// The second owner's write path is blocked before any reserved segment or intent can exist.
			expect(await writeRefusal(item)).toContain("통합 펜스");
			const read = await acquireRunLease({
				sessionDir: item.sessionDir, sessionId: "session-1", root: item.root, runId: item.key.runId, mode: "read",
			}, { dir: item.leaseDir });
			expect(read.ok).toBe(true);
			if (read.ok) {
				const upgraded = await read.lease.upgrade();
				expect(upgraded).toMatchObject({ ok: false, reason: expect.stringContaining("통합 펜스") });
				await read.lease.release();
			}
			expect(await readFile(journalPath(item), "utf8")).toBe(rawBeforeKill);
			expect(await restarted.findFence({ canonicalRoot: item.root })).toEqual({ kind: "fenced", fence });
		} finally {
			if (!dead && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
			await owner.exited.catch(() => undefined);
			await stderr.catch(() => "");
		}
	}, 30_000);

	test("a process-owned complete install records a known end and the exact pre/post checkpoint", async () => {
		const item = await repo();
		cleanups.push(item.remove);
		const journal = journalFor(item);
		expect(await journal.appendManifest(manifestOf(item))).toEqual({ kind: "known", value: 1 });
		const beforeIndex = await readFile(path.join(item.target.gitDir.canonicalPath, "index"));
		const beforeHead = (await gitOut(item.root, "rev-parse", "HEAD")).trim();
		const keep = new Map<string, string>();
		for (const name of ["kept.txt", "staged.txt", "untracked.txt"]) keep.set(name, sha256(await readFile(path.join(item.root, name))));
		const pre = new Map<string, FileImage>();
		for (const entry of item.proof.entries) pre.set(entry.targetPath, await imageAt(path.join(item.root, entry.targetPath)));
		const fixturePath = await writeOwnerFixture(item, "complete");
		const owner = await spawnOwner(item, fixturePath);
		const [stdout, stderr, code] = await Promise.all([
			new Response(owner.stdout).text(),
			new Response(owner.stderr).text(),
			owner.exited,
		]);
		if (code !== 0) throw new Error(`owner failed (${code}): ${stderr}`);
		const lines = stdout.split("\n").filter(line => line !== "").map(line => JSON.parse(line) as Record<string, unknown>);
		expect(lines).toContainEqual(expect.objectContaining({ stage: "written", kind: "written" }));
		expect(lines).toContainEqual(expect.objectContaining({ stage: "released" }));

		const restarted = journalFor(item);
		expect(await restarted.findFence({ canonicalRoot: item.root })).toEqual({ kind: "clear" });
		const rows = await journalRows(item);
		const intentRow = rows.find(row => row.kind === "intent");
		const endRow = rows.find(row => row.kind === "effect-end");
		const receiptRow = rows.find(row => row.kind === "receipt");
		expect(intentRow).toBeDefined();
		expect(endRow).toBeDefined();
		expect(receiptRow).toBeDefined();
		if (intentRow === undefined || endRow === undefined || receiptRow === undefined) throw new Error("known-end records missing");
		const intentPayload = payloadObject(intentRow).intent as {
			readonly sequence: number;
			readonly paths: readonly { readonly path: string; readonly before: FileImage; readonly after: FileImage }[];
		};
		const end = payloadObject(endRow).end as { readonly basis: string };
		const receipt = payloadObject(receiptRow).receipt as { readonly ref: { readonly intentSequence: number }; readonly end: { readonly basis: string } };
		expect(end.basis).toBe("installer-exit-proved");
		expect(receipt.end.basis).toBe("installer-exit-proved");
		expect(receipt.ref.intentSequence).toBe(intentPayload.sequence);

		for (const entry of item.proof.entries) {
			const fromIntent = intentPayload.paths.find(path => path.path === entry.targetPath);
			expect(fromIntent).toBeDefined();
			if (fromIntent === undefined) throw new Error(`intent path missing: ${entry.targetPath}`);
			const before = entry.before.state.kind === "absent"
				? { kind: "absent" as const }
				: { kind: "file" as const, mode: entry.before.state.mode, bytes: entry.before.state.bytes, sha256: entry.before.state.sha256 };
			const after = entry.after.state.kind === "absent"
				? { kind: "absent" as const }
				: { kind: "file" as const, mode: entry.after.state.mode, bytes: entry.after.state.bytes, sha256: entry.after.state.sha256 };
			const preImage = pre.get(entry.targetPath);
			if (preImage === undefined) throw new Error(`preimage missing: ${entry.targetPath}`);
			expect(fromIntent.before).toEqual(before);
			expect(fromIntent.before).toEqual(preImage);
			expect(fromIntent.after).toEqual(after);
			expect(await imageAt(path.join(item.root, entry.targetPath))).toEqual(after);
		}
		expect(await readFile(path.join(item.target.gitDir.canonicalPath, "index"))).toEqual(beforeIndex);
		expect((await gitOut(item.root, "rev-parse", "HEAD")).trim()).toBe(beforeHead);
		for (const [name, digest] of keep) expect(sha256(await readFile(path.join(item.root, name)))).toBe(digest);
		expect(await restarted.receiptFor(item.key.runId, item.candidateId)).toMatchObject({
			kind: "known", value: { ref: { intentSequence: intentPayload.sequence } },
		});
	}, 30_000);
});
