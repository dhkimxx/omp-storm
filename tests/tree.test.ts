import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { treeAgainst } from "../src/runtime/tree.ts";
import type { Exec } from "../src/types.ts";
import { exec, git, gitRepo, makeProject, type TestProject } from "./support.ts";

describe("treeAgainst", () => {
	let project: TestProject;
	let root: string;

	beforeEach(async () => {
		project = await makeProject();
		root = project.root;
	});

	afterEach(async () => {
		await project.remove();
	});

	const state = () => treeAgainst(exec, root);

	test("a clean work tree reads the same twice against the same commit", async () => {
		await gitRepo(root);
		const first = await state();
		expect(first).toBeDefined();
		expect(first!.base).toBe((await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim());
		expect(await state()).toEqual(first);
	});

	test("editing a tracked file changes diff only", async () => {
		await gitRepo(root);
		const clean = (await state())!;
		await writeFile(path.join(root, ".keep"), "changed\n");
		const edited = (await state())!;
		expect(edited.state.diff).not.toBe(clean.state.diff);
		expect(edited.state.files).toBe(clean.state.files);
	});

	test("a new untracked file changes files only", async () => {
		await gitRepo(root);
		const clean = (await state())!;
		await writeFile(path.join(root, "new.txt"), "new\n");
		const added = (await state())!;
		expect(added.state.diff).toBe(clean.state.diff);
		expect(added.state.files).not.toBe(clean.state.files);
	});

	test("staging a tracked change keeps diff different from the clean tree", async () => {
		await gitRepo(root);
		const clean = (await state())!;
		await writeFile(path.join(root, ".keep"), "staged\n");
		await git(root, "add", ".keep");
		expect((await state())!.state.diff).not.toBe(clean.state.diff);
	});

	test("a commit after the start keeps its changes visible against the start commit", async () => {
		await gitRepo(root);
		const start = (await state())!;
		await writeFile(path.join(root, ".keep"), "committed change\n");
		await git(root, "add", ".keep");
		await git(root, "commit", "-m", "later");
		// Against the new HEAD the tree is clean again, which is the trap; against the run's start commit it is not.
		const head = (await state())!;
		expect(head.base).not.toBe(start.base);
		expect(head.state.diff).toBe(start.state.diff);
		expect((await treeAgainst(exec, root, start.base))!.state.diff).not.toBe(start.state.diff);
	});

	test("a binary change moves diff", async () => {
		await gitRepo(root);
		const start = (await state())!;
		await writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));
		await git(root, "add", "blob.bin");
		await git(root, "commit", "-m", "binary");
		await writeFile(path.join(root, "blob.bin"), Buffer.from([0, 9, 8, 7, 0]));
		expect((await state())!.state.diff).not.toBe(start.state.diff);
	});

	test("a file under .omp changes nothing, at the top level and below a directory", async () => {
		await mkdir(path.join(root, ".omp", "state"), { recursive: true });
		await mkdir(path.join(root, "sub", ".omp", "state"), { recursive: true });
		await writeFile(path.join(root, ".omp", "state", "a.json"), "{}\n");
		await writeFile(path.join(root, "sub", ".omp", "state", "b.json"), "{}\n");
		await gitRepo(root);
		const clean = (await state())!;
		// Tracked changes and untracked additions under either .omp are tool state, not project code.
		await writeFile(path.join(root, ".omp", "state", "a.json"), '{"changed":true}\n');
		await writeFile(path.join(root, "sub", ".omp", "state", "b.json"), '{"changed":true}\n');
		await writeFile(path.join(root, "sub", ".omp", "new.txt"), "new\n");
		await writeFile(path.join(root, ".omp", "new.txt"), "new\n");
		expect(await state()).toEqual(clean);
	});

	test("committing a tracked edit leaves both hashes unchanged", async () => {
		await gitRepo(root);
		const start = (await state())!;
		await writeFile(path.join(root, ".keep"), "edited\n");
		const edited = (await treeAgainst(exec, root, start.base))!;
		expect(edited.state.diff).not.toBe(start.state.diff);
		await git(root, "add", ".keep");
		await git(root, "commit", "-m", "edit");
		expect(await treeAgainst(exec, root, start.base)).toEqual(edited);
	});

	test("committing a new file leaves both hashes unchanged", async () => {
		await gitRepo(root);
		const clean = (await state())!;
		await writeFile(path.join(root, "new.txt"), "new\n");
		const uncommitted = (await treeAgainst(exec, root, clean.base))!;
		expect(uncommitted.state.diff).toBe(clean.state.diff);
		expect(uncommitted.state.files).not.toBe(clean.state.files);
		await git(root, "add", "new.txt");
		await git(root, "commit", "-m", "add");
		expect(await treeAgainst(exec, root, clean.base)).toEqual(uncommitted);
	});

	test("editing an untracked file moves files only", async () => {
		await gitRepo(root);
		await writeFile(path.join(root, "notes.txt"), "one\n");
		const first = (await state())!;
		await writeFile(path.join(root, "notes.txt"), "two\n");
		const edited = (await state())!;
		expect(edited.state.diff).toBe(first.state.diff);
		expect(edited.state.files).not.toBe(first.state.files);
	});

	test("deleting a tracked file moves diff only", async () => {
		await gitRepo(root);
		const clean = (await state())!;
		await rm(path.join(root, ".keep"));
		const deleted = (await state())!;
		expect(deleted.state.diff).not.toBe(clean.state.diff);
		expect(deleted.state.files).toBe(clean.state.files);
	});

	test("a file over the size bound moves files when its size changes", async () => {
		await gitRepo(root);
		const big = path.join(root, "artifact.bin");
		await writeFile(big, Buffer.alloc(2 * 1024 * 1024 + 1));
		const first = (await state())!;
		await writeFile(big, Buffer.alloc(2 * 1024 * 1024 + 2));
		const grown = (await state())!;
		expect(grown.state.diff).toBe(first.state.diff);
		expect(grown.state.files).not.toBe(first.state.files);
	});

	test("a directory outside a git work tree has no tree", async () => {
		expect(await state()).toBeUndefined();
	});

	test("a repository without a commit has no tree", async () => {
		await git(root, "init");
		expect(await state()).toBeUndefined();
	});

	test("a killed or failed git gives no tree", async () => {
		const killed: Exec = async () => ({ stdout: "", stderr: "", code: -1, killed: true });
		const failed: Exec = async () => ({ stdout: "", stderr: "boom", code: 128 });
		expect(await treeAgainst(killed, root)).toBeUndefined();
		expect(await treeAgainst(failed, root)).toBeUndefined();
	});

	test("a read leaves .git/index unchanged when a tracked file was touched", async () => {
		await gitRepo(root);
		const index = path.join(root, ".git", "index");
		// Same content, a stat that cannot match the index: a plain `git diff` would refresh its cache and rewrite this file.
		const future = new Date(Date.now() + 3_600_000);
		await utimes(path.join(root, ".keep"), future, future);
		const before = await readFile(index);
		await state();
		expect(await readFile(index)).toEqual(before);
	});
});
