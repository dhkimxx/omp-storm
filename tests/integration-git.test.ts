import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AdmissionKey, GitObjectSource, IntegrationTarget, SpaceIdentity } from "../src/runtime/integration-admission.ts";
import type { ByteWindow, ExactDeltaProof, IntegrationBytePort, StoredPatchRef } from "../src/runtime/integration-delta.ts";
import {
	ByteBudget, GitDelta, GitInstaller, observePostimages, parseRootPatch, readFootprint, readPathImage, spawnGit,
	statusForPaths, verifyFootprint, type GitRun,
} from "../src/runtime/integration-git.ts";
import { integrationCandidateId } from "../src/runtime/integration-record.ts";
import { canonicalWorktree } from "../src/runtime/lease.ts";

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
	const run = await spawnGit(args, { cwd });
	if (!run.started || run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
	return new TextDecoder().decode(run.stdout);
}

async function space(file: string): Promise<SpaceIdentity> {
	const real = await realpath(file);
	const st = await stat(real, { bigint: true });
	if (!st.isDirectory()) throw new Error(`not a directory: ${real}`);
	return { canonicalPath: real, device: st.dev.toString(), inode: st.ino.toString() };
}

interface Fixture {
	readonly tmp: string;
	readonly root: string;
	readonly patch: Uint8Array;
	readonly key: AdmissionKey;
	readonly target: IntegrationTarget;
	readonly rootRef: StoredPatchRef;
	readonly baselineTree: string;
	readonly afterTree: string;
	remove(): Promise<void>;
}

/** Baseline = the parent's committed HEAD plus its staged/unstaged/untracked WIP; after = the child's changes. */
async function fixture(): Promise<Fixture> {
	const tmp = await mkdtemp(path.join(tmpdir(), "storm-delta-test-"));
	const root = path.join(tmp, "repo");
	await mkdir(root);
	await gitOut(root, "init", "-q");
	await gitOut(root, "config", "user.name", "t");
	await gitOut(root, "config", "user.email", "t@example.invalid");
	await gitOut(root, "config", "commit.gpgsign", "false");
	await writeFile(path.join(root, "edit.txt"), "base\n");
	await writeFile(path.join(root, "delete.txt"), "delete me\n");
	await writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
	await writeFile(path.join(root, "kept.txt"), "kept\n");
	await chmod(path.join(root, "bin.dat"), 0o644);
	await gitOut(root, "add", "-A");
	await gitOut(root, "commit", "-q", "-m", "base");

	// The user's live WIP in the parent: one unstaged edit, one staged add, one untracked file.
	await writeFile(path.join(root, "edit.txt"), "base\nWIP\n");
	await writeFile(path.join(root, "staged.txt"), "staged\n");
	await gitOut(root, "add", "staged.txt");
	await writeFile(path.join(root, "untracked.txt"), "untracked\n");

	const worktree = path.join(tmp, "child");
	await gitOut(root, "worktree", "add", "--detach", worktree, "HEAD");
	await cp(root, worktree, {
		recursive: true,
		filter: source => !source.startsWith(path.join(root, ".git")),
	});
	await gitOut(worktree, "add", "-A");
	const baselineTree = (await gitOut(worktree, "write-tree")).trim();

	await writeFile(path.join(worktree, "edit.txt"), "base\nWIP\nCHILD\n");
	await rm(path.join(worktree, "delete.txt"));
	await writeFile(path.join(worktree, "new.txt"), "new file\n");
	await writeFile(path.join(worktree, "bin.dat"), Buffer.from([0, 9, 8, 7, 0, 254, 253]));
	await chmod(path.join(worktree, "new.txt"), 0o755);
	await gitOut(worktree, "add", "-A");
	const afterTree = (await gitOut(worktree, "write-tree")).trim();
	const patchText = await gitOut(root, "diff-tree", "-r", "-p", "--binary", "--no-color", "--no-commit-id", baselineTree, afterTree);
	const patch = new TextEncoder().encode(patchText);
	const key: AdmissionKey = { schema: "storm.integration-admission/v1", runId: "run-test-0001", dispatch: "dispatch-1" };
	const rootRef: StoredPatchRef = {
		schema: "storm.integration-patch/v1",
		key,
		objectKey: "objects/test",
		bytes: patch.byteLength,
		sha256: sha256(patch),
	};
	const canonical = await canonicalWorktree(root);
	if (canonical === undefined) throw new Error("root lost");
	const gitDir = await space(path.join(root, ".git"));
	const sourceOdb: GitObjectSource = {
		commonDir: gitDir,
		objects: await space(path.join(root, ".git", "objects")),
		objectFormat: "sha1",
	};
	const target: IntegrationTarget = {
		leaseKey: canonical.key,
		authorizedRoot: await space(root),
		gitRoot: await space(root),
		gitDir,
		sourceOdb,
		targetPrefix: "",
	};
	return {
		tmp,
		root,
		patch,
		key,
		target,
		rootRef,
		baselineTree,
		afterTree,
		remove: () => rm(tmp, { recursive: true, force: true }),
	};
}

function window(maxBytes = 64 * 1024 * 1024): ByteWindow {
	return { maxBytes, deadline: Date.now() + 120_000, signal: new AbortController().signal };
}

function bytesPort(patch: Uint8Array): IntegrationBytePort {
	return { readPatch: async () => ({ kind: "known", value: patch }) };
}

async function prove(item: Fixture, overrides: Partial<IntegrationTarget> & { scope?: ExactDeltaProof["scope"] } = {}) {
	const delta = new GitDelta({ bytes: bytesPort(item.patch), run: spawnGit });
	const request = {
		key: item.key,
		candidateId: integrationCandidateId(item.key),
		target: { ...item.target, ...overrides },
		scope: overrides.scope ?? ({ kind: "unbounded" } as const),
		sourceOdb: item.target.sourceOdb,
		root: item.rootRef,
	};
	const result = await delta.proveRoot(request, window());
	return { delta, request, result };
}

async function writeBlob(item: Fixture, content: string): Promise<string> {
	const run = await spawnGit(["hash-object", "-w", "--stdin"], { cwd: item.root, stdin: content });
	if (!run.started || run.code !== 0) throw new Error(run.stderr);
	return new TextDecoder().decode(run.stdout).trim();
}

async function provePatch(item: Fixture, patch: Uint8Array) {
	const rootRef: StoredPatchRef = { ...item.rootRef, bytes: patch.byteLength, sha256: sha256(patch) };
	return new GitDelta({ bytes: bytesPort(patch), run: spawnGit }).proveRoot({
		key: item.key,
		candidateId: integrationCandidateId(item.key),
		target: item.target,
		scope: { kind: "unbounded" },
		sourceOdb: item.target.sourceOdb,
		root: rootRef,
	}, window());
}

describe("exact root delta", () => {
	let item: Fixture;
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	test("proves text add/edit/clean delete and a binary modification against the bound ODB", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const { result } = await prove(item);
		expect(result.kind).toBe("known");
		if (result.kind !== "known") throw new Error(result.problem.reason);
		const proof = result.value;
		expect(proof.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(proof.entries.map(entry => entry.targetPath).sort()).toEqual(["bin.dat", "delete.txt", "edit.txt", "new.txt"]);
		const edit = proof.entries.find(entry => entry.targetPath === "edit.txt")!;
		expect(edit.encoding).toBe("text");
		expect(edit.before.state.kind).toBe("file");
		expect(edit.before.state.kind === "file" && edit.before.state.sha256).toBe(sha256("base\nWIP\n"));
		expect(edit.after.state.kind === "file" && edit.after.state.sha256).toBe(sha256("base\nWIP\nCHILD\n"));
		const added = proof.entries.find(entry => entry.targetPath === "new.txt")!;
		expect(added.before.state.kind).toBe("absent");
		expect(added.after.state.kind === "file" && added.after.state.mode).toBe("100755");
		const removed = proof.entries.find(entry => entry.targetPath === "delete.txt")!;
		expect(removed.after.state.kind).toBe("absent");
		const binary = proof.entries.find(entry => entry.targetPath === "bin.dat")!;
		expect(binary.encoding).toBe("binary");
		expect(binary.after.state.kind === "file" && binary.after.state.bytes).toBe(7);
	});

	test("installs only the touched footprint, preserves the index and unrelated WIP", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const { result, request } = await prove(item);
		if (result.kind !== "known") throw new Error(result.problem.reason);
		const proof = result.value;
		const budget = new ByteBudget(window(), Date.now, 64 * 1024 * 1024);
		const footprint = await readFootprint(proof, request.target, spawnGit, budget);
		if (footprint.kind === "unknown") throw new Error(footprint.problem.reason);
		const beforeIndex = await readFile(path.join(item.root, ".git", "index"));
		const pre = await verifyFootprint(footprint.value, request.target, spawnGit, budget, "pre");
		expect(pre.ok).toBe(true);
		const installed = await new GitInstaller(spawnGit).install({ target: request.target, patch: item.patch, window: window(), beforeDispatch: () => ({ ok: true }) });
		expect(installed.kind).toBe("exited");
		const post = await verifyFootprint(footprint.value, request.target, spawnGit, budget, "post");
		expect(post.ok).toBe(true);
		expect(await readFile(path.join(item.root, "edit.txt"), "utf8")).toBe("base\nWIP\nCHILD\n");
		expect(await readFile(path.join(item.root, "untracked.txt"), "utf8")).toBe("untracked\n");
		expect(await readFile(path.join(item.root, "staged.txt"), "utf8")).toBe("staged\n");
		expect(await readFile(path.join(item.root, "kept.txt"), "utf8")).toBe("kept\n");
		await expect(readFile(path.join(item.root, "delete.txt"))).rejects.toThrow();
		expect(await readFile(path.join(item.root, "new.txt"), "utf8")).toBe("new file\n");
		expect((await stat(path.join(item.root, "new.txt"))).mode & 0o111).not.toBe(0);
		expect(await readFile(path.join(item.root, ".git", "index"))).toEqual(beforeIndex);
		const staged = (await gitOut(item.root, "diff", "--cached", "--name-only")).trim();
		expect(staged).toBe("staged.txt");
		const presence = await observePostimages(footprint.value, request.target);
		expect(presence).toEqual({ kind: "known", value: "all-post" });
	});

	test("an unrelated HEAD move before the holder is not a conflict", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const { result, request } = await prove(item);
		if (result.kind !== "known") throw new Error(result.problem.reason);
		await writeFile(path.join(item.root, "unrelated.txt"), "other\n");
		await gitOut(item.root, "add", "unrelated.txt");
		await gitOut(item.root, "commit", "-q", "-m", "unrelated", "--", "unrelated.txt");
		const budget = new ByteBudget(window(), Date.now, 64 * 1024 * 1024);
		const footprint = await readFootprint(result.value, request.target, spawnGit, budget);
		if (footprint.kind === "unknown") throw new Error(footprint.problem.reason);
		expect(await verifyFootprint(footprint.value, request.target, spawnGit, budget, "pre")).toEqual({ ok: true });
		const installed = await new GitInstaller(spawnGit).install({ target: request.target, patch: item.patch, window: window(), beforeDispatch: () => ({ ok: true }) });
		expect(installed.kind).toBe("exited");
		expect(await verifyFootprint(footprint.value, request.target, spawnGit, budget, "post")).toEqual({ ok: true });
		expect(await readFile(path.join(item.root, "unrelated.txt"), "utf8")).toBe("other\n");
	});

	test("same-file drift and a dirty delete refuse before any prefix is installed", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const { result, request } = await prove(item);
		if (result.kind !== "known") throw new Error(result.problem.reason);
		const proof = result.value;
		const budget = new ByteBudget(window(), Date.now, 64 * 1024 * 1024);
		const footprint = await readFootprint(proof, request.target, spawnGit, budget);
		if (footprint.kind === "unknown") throw new Error(footprint.problem.reason);
		await writeFile(path.join(item.root, "edit.txt"), "base\nWIP\nDRIFT\n");
		const drift = await verifyFootprint(footprint.value, request.target, spawnGit, budget, "pre");
		expect(drift).toMatchObject({ ok: false, problem: { code: "delta-preimage-conflict" } });
	});

	test("refuses a dirty or untracked delete", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const { result, request } = await prove(item);
		if (result.kind !== "known") throw new Error(result.problem.reason);
		const budget = new ByteBudget(window(), Date.now, 64 * 1024 * 1024);
		const footprint = await readFootprint(result.value, request.target, spawnGit, budget);
		if (footprint.kind === "unknown") throw new Error(footprint.problem.reason);
		await writeFile(path.join(item.root, "delete.txt"), "delete me\nDIRTY\n");
		const dirty = await verifyFootprint(footprint.value, request.target, spawnGit, budget, "pre");
		// Touched bytes that no longer match the proved preimage are refused whatever the index says.
		expect(dirty).toMatchObject({ ok: false, problem: { code: "delta-preimage-conflict", path: "delete.txt" } });
		await writeFile(path.join(item.root, "delete.txt"), "delete me\n");
		const untracked = await prove(item);
		if (untracked.result.kind !== "known") throw new Error(untracked.result.problem.reason);
		await gitOut(item.root, "rm", "--cached", "delete.txt");
		const missing = await readFootprint(untracked.result.value, request.target, spawnGit, budget);
		if (missing.kind === "unknown") throw new Error(missing.problem.reason);
		const refused = await verifyFootprint(missing.value, request.target, spawnGit, budget, "pre");
		expect(refused).toMatchObject({ ok: false, problem: { code: "delta-untracked-delete" } });
	});

	test("an ambiguous or missing object prefix refuses the whole proof", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		// Find two blobs in the bound ODB with the same four-hex prefix. Four hex digits make the birthday collision
		// cheap, and the prefix is still a legal Git abbreviation.
		const seen = new Map<string, string>();
		let collision: { prefix: string; content: string } | undefined;
		for (let index = 0; index < 4_000 && collision === undefined; index++) {
			const content = `collision-${index}\n`;
			const oid = await spawnGit(["hash-object", "-w", "--stdin"], { cwd: item.root, stdin: content });
			if (!oid.started || oid.code !== 0) throw new Error(oid.stderr);
			const full = new TextDecoder().decode(oid.stdout).trim();
			const prefix = full.slice(0, 4);
			const previous = seen.get(prefix);
			if (previous !== undefined && previous !== content) collision = { prefix, content };
			else seen.set(prefix, content);
		}
		expect(collision).toBeDefined();
		const { prefix, content } = collision!;
		const patch = new TextEncoder().encode(
			`diff --git a/collide.txt b/collide.txt\nnew file mode 100644\nindex 0000000..${prefix}\n--- /dev/null\n+++ b/collide.txt\n@@ -0,0 +1 @@\n+${content.replace(/\n$/u, "")}\n`,
		);
		const rootRef = { ...item.rootRef, bytes: patch.byteLength, sha256: sha256(patch) };
		const delta = new GitDelta({ bytes: bytesPort(patch), run: spawnGit });
		const ambiguous = await delta.proveRoot({
			key: item.key,
			candidateId: integrationCandidateId(item.key),
			target: item.target,
			scope: { kind: "unbounded" },
			sourceOdb: item.target.sourceOdb,
			root: rootRef,
		}, window());
		expect(ambiguous).toMatchObject({ kind: "unknown", problem: { code: "delta-object-ambiguous" } });
		const missingPatch = new TextEncoder().encode(
			"diff --git a/missing.txt b/missing.txt\nnew file mode 100644\nindex 0000000..ffffff\n--- /dev/null\n+++ b/missing.txt\n@@ -0,0 +1 @@\n+x\n",
		);
		const missingRef = { ...item.rootRef, bytes: missingPatch.byteLength, sha256: sha256(missingPatch) };
		const missing = await new GitDelta({ bytes: bytesPort(missingPatch), run: spawnGit }).proveRoot({
			key: item.key,
			candidateId: integrationCandidateId(item.key),
			target: item.target,
			scope: { kind: "unbounded" },
			sourceOdb: item.target.sourceOdb,
			root: missingRef,
		}, window());
		expect(missing).toMatchObject({ kind: "unknown", problem: { code: "delta-object-missing" } });
		// A digest that does not match the reopened copy is refused before parsing or ODB access.
		const stale = await new GitDelta({ bytes: bytesPort(item.patch), run: spawnGit }).proveRoot({
			key: item.key,
			candidateId: integrationCandidateId(item.key),
			target: item.target,
			scope: { kind: "unbounded" },
			sourceOdb: item.target.sourceOdb,
			root: { ...item.rootRef, sha256: "0".repeat(64) },
		}, window());
		expect(stale).toMatchObject({ kind: "unknown", problem: { code: "delta-patch" } });
	});

	test("parser refuses rename, mode-only, traversal and authority paths", () => {
		const rename = `diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n`;
		expect(() => parseRootPatch(rename)).toThrow();
		const mode = `diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n`;
		expect(() => parseRootPatch(mode)).toThrow();
		const escape = `diff --git a/../x b/../x\nindex 0000000..1234567\n--- /dev/null\n+++ b/../x\n@@ -0,0 +1 @@\n+x\n`;
		expect(() => parseRootPatch(escape)).toThrow();
		const authority = `diff --git a/.git/config b/.git/config\nindex 0000000..1234567\n--- /dev/null\n+++ b/.git/config\n@@ -0,0 +1 @@\n+x\n`;
		expect(() => parseRootPatch(authority)).toThrow();
	});

	test("target prefix maps only inside the authorized root", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const { result } = await prove(item, { targetPrefix: "sub" });
		expect(result).toMatchObject({ kind: "unknown", problem: { code: "delta-outside-target" } });
	});

	test("readPathImage reports absence and refuses an unsafe ancestor", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const absent = await readPathImage(item.root, "missing.txt");
		expect(absent.kind).toBe("absent");
		const file = await readPathImage(item.root, "edit.txt");
		expect(file.kind).toBe("file");
		await mkdir(path.join(item.root, "dir"));
		await writeFile(path.join(item.root, "dir", "real.txt"), "x\n");
		await symlink(path.join(item.root, "dir"), path.join(item.root, "alias"));
		const unsafe = await readPathImage(item.root, "alias/real.txt");
		expect(unsafe.kind).toBe("unknown");
	});

	test("dirty observations name touched WIP and a refused delete", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const { result, delta } = await prove(item);
		if (result.kind !== "known") throw new Error(result.problem.reason);
		const dirty = await delta.observeDirtyPaths(result.value, window());
		expect(dirty.kind).toBe("known");
		if (dirty.kind === "known") {
			expect(dirty.value.total).toBeGreaterThan(0);
			expect(dirty.value.examples).toContain("edit.txt");
			expect(dirty.value.dirtyDeletes).toEqual([]);
		}
		await writeFile(path.join(item.root, "delete.txt"), "delete me\nDIRTY\n");
		const after = await delta.observeDirtyPaths(result.value, window());
		expect(after.kind === "known" && after.value.dirtyDeletes).toContain("delete.txt");
	});

	test("refuses a delete whose exact old bytes are dirty but hidden by assume-unchanged", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const dirty = "delete me\nWIP\n";
		await writeFile(path.join(item.root, "delete.txt"), dirty);
		await gitOut(item.root, "update-index", "--assume-unchanged", "delete.txt");
		const oid = await writeBlob(item, dirty);
		const patch = new TextEncoder().encode(
			`diff --git a/delete.txt b/delete.txt\ndeleted file mode 100644\nindex ${oid}..0000000\n--- a/delete.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-delete me\n-WIP\n`,
		);
		const proved = await provePatch(item, patch);
		if (proved.kind !== "known") throw new Error(proved.problem.reason);
		const budget = new ByteBudget(window(), Date.now, 64 * 1024 * 1024);
		const status = await statusForPaths(item.root, ["delete.txt"], spawnGit, budget);
		expect(status.kind).toBe("known");
		if (status.kind === "known") expect(status.paths.size).toBe(0);
		const footprint = await readFootprint(proved.value, item.target, spawnGit, budget);
		if (footprint.kind === "unknown") throw new Error(footprint.problem.reason);
		const pre = await verifyFootprint(footprint.value, item.target, spawnGit, budget, "pre");
		expect(pre).toMatchObject({ ok: false, problem: { code: "delta-dirty-delete", path: "delete.txt" } });
	});

	test("refuses a tracked ancestor or descendant of an absent-name add before effect", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const budget = new ByteBudget(window(), Date.now, 64 * 1024 * 1024);

		const childOid = await writeBlob(item, "child\n");
		const childPatch = new TextEncoder().encode(
			`diff --git a/blocker/child.txt b/blocker/child.txt\nnew file mode 100644\nindex 0000000..${childOid}\n--- /dev/null\n+++ b/blocker/child.txt\n@@ -0,0 +1 @@\n+child\n`,
		);
		const childProof = await provePatch(item, childPatch);
		if (childProof.kind !== "known") throw new Error(childProof.problem.reason);
		const childFootprint = await readFootprint(childProof.value, item.target, spawnGit, budget);
		if (childFootprint.kind === "unknown") throw new Error(childFootprint.problem.reason);
		// The ancestor becomes a tracked file only after the footprint read; the live child path stays absent.
		await writeFile(path.join(item.root, "blocker"), "blocker\n");
		await gitOut(item.root, "add", "blocker");
		await gitOut(item.root, "commit", "-q", "-m", "tracked blocker");
		await rm(path.join(item.root, "blocker"));
		await mkdir(path.join(item.root, "blocker"));
		const ancestorPre = await verifyFootprint(childFootprint.value, item.target, spawnGit, budget, "pre");
		expect(ancestorPre).toMatchObject({ ok: false, problem: { code: "delta-absent-add-conflict", path: "blocker/child.txt" } });
		const ancestorReread = await readFootprint(childProof.value, item.target, spawnGit, budget);
		expect(ancestorReread).toMatchObject({ kind: "unknown", problem: { code: "delta-absent-add-conflict" } });

		const nestOid = await writeBlob(item, "nest\n");
		const nestPatch = new TextEncoder().encode(
			`diff --git a/nest b/nest\nnew file mode 100644\nindex 0000000..${nestOid}\n--- /dev/null\n+++ b/nest\n@@ -0,0 +1 @@\n+nest\n`,
		);
		const nestProof = await provePatch(item, nestPatch);
		if (nestProof.kind !== "known") throw new Error(nestProof.problem.reason);
		const nestFootprint = await readFootprint(nestProof.value, item.target, spawnGit, budget);
		if (nestFootprint.kind === "unknown") throw new Error(nestFootprint.problem.reason);
		await mkdir(path.join(item.root, "nest"));
		await writeFile(path.join(item.root, "nest", "leaf.txt"), "leaf\n");
		await gitOut(item.root, "add", "nest/leaf.txt");
		await gitOut(item.root, "commit", "-q", "-m", "tracked descendant");
		await rm(path.join(item.root, "nest"), { recursive: true, force: true });
		const descendantPre = await verifyFootprint(nestFootprint.value, item.target, spawnGit, budget, "pre");
		expect(descendantPre).toMatchObject({ ok: false, problem: { code: "delta-absent-add-conflict", path: "nest" } });
		const descendantReread = await readFootprint(nestProof.value, item.target, spawnGit, budget);
		expect(descendantReread).toMatchObject({ kind: "unknown", problem: { code: "delta-absent-add-conflict" } });
	});

	test("withholds the mutating apply when the synchronous gate refuses", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const calls: string[][] = [];
		let gated = 0;
		const run: GitRun = async args => {
			calls.push([...args]);
			return { stdout: new Uint8Array(), stderr: "", code: 0, started: true, ended: true };
		};
		const outcome = await new GitInstaller(run).install({
			target: item.target,
			patch: item.patch,
			window: window(),
			beforeDispatch: () => {
				gated++;
				const last = calls[calls.length - 1] ?? [];
				expect(last).toContain("apply");
				expect(last).toContain("--check");
				return { ok: false, problem: { code: "integration-live", reason: "withheld" } };
			},
		});
		expect(gated).toBe(1);
		expect(outcome).toEqual({ kind: "never-dispatched", reason: "withheld" });
		const applyCalls = calls.filter(args => args.includes("apply"));
		expect(applyCalls).toHaveLength(1);
		expect(applyCalls[0]).toContain("--check");
	});

	test("never reports exited when a started mutating apply's end is unproved", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const calls: string[][] = [];
		const run: GitRun = async args => {
			calls.push([...args]);
			if (args.includes("apply") && !args.includes("--check")) {
				return { stdout: new Uint8Array(), stderr: "late", code: -2, started: true, ended: false };
			}
			return { stdout: new Uint8Array(), stderr: "", code: 0, started: true, ended: true };
		};
		const outcome = await new GitInstaller(run).install({
			target: item.target,
			patch: item.patch,
			window: window(),
			beforeDispatch: () => ({ ok: true }),
		});
		expect(outcome.kind).toBe("effect-unknown");
		if (outcome.kind === "effect-unknown") expect(outcome.reason).toContain("종료를 확인하지 못했습니다");
		expect(calls.filter(args => args.includes("apply") && !args.includes("--check"))).toHaveLength(1);
	});

	test("spawnGit waits for the real child end after a timeout kill", async () => {
		item = await fixture();
		cleanups.push(item.remove);
		const started = Date.now();
		const killed = await spawnGit(["-c", "alias.slow=!exec sleep 1 >/dev/null 2>&1", "slow"], { cwd: item.tmp, timeoutMs: 100 });
		expect(killed.started).toBe(true);
		expect(killed.ended).toBe(true);
		expect(killed.code).not.toBe(-2);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
