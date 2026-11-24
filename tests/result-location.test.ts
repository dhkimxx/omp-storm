import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { captureSharedBaseline, evaluateSettledResults, resultContractIdentity } from "../src/runtime/result-evidence.ts";
import {
	type AcceptedResultProjection,
	locateResult,
	projectAcceptedResult,
	type ResultLocation,
	type ResultLocationCode,
	type ResultLocationResult,
} from "../src/runtime/result-location.ts";
import type { PlanLaneResult } from "../src/types.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempRoot(label: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `storm-location-${label}-`));
	dirs.push(dir);
	return fs.realpath(dir);
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function requireLocation(result: ResultLocationResult): ResultLocation {
	if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
	return result.location;
}

function expectFailure(result: ResultLocationResult, ...codes: ResultLocationCode[]): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(codes).toContain(result.code);
}

interface Repo {
	root: string;
	run: (...args: string[]) => Buffer;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(root, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	}
}

async function newRepo(label: string, files: Record<string, string> = {}): Promise<Repo> {
	const root = await tempRoot(label);
	const run = (...args: string[]): Buffer => {
		const proc = Bun.spawnSync(["git", "-C", root, ...args], {
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: root },
		});
		if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
		return Buffer.from(proc.stdout);
	};
	run("init", "-q", "-b", "main");
	run("config", "user.name", "Storm Test");
	run("config", "user.email", "storm@example.invalid");
	run("config", "commit.gpgsign", "false");
	await writeFiles(root, files);
	if (Object.keys(files).length > 0) {
		run("add", "-A");
		run("commit", "-q", "-m", "base");
	}
	return { root, run };
}

interface Patch {
	path: string;
	digest: string;
	bytes: Buffer;
}

/** A real working-tree patch produced by git, stored outside the parent checkout. */
async function makePatch(repo: Repo, label: string): Promise<Patch> {
	const file = path.join(await tempRoot(label), "change.patch");
	const bytes = repo.run("diff", "--binary", "--no-color", "--no-ext-diff");
	await fs.writeFile(file, bytes);
	return { path: file, digest: sha256(bytes), bytes };
}

async function resetWorktree(repo: Repo): Promise<void> {
	repo.run("reset", "-q", "--hard", "HEAD");
	repo.run("clean", "-q", "-fd");
}

function acceptedOf(result: PlanLaneResult, extra: Partial<AcceptedResultProjection> = {}): AcceptedResultProjection {
	return {
		state: "accepted",
		attemptId: "job:test:1",
		contentVersion: sha256(`storm-result-location:${result.id}:${extra.digest ?? ""}`),
		identity: resultContractIdentity(result),
		result,
		...extra,
	};
}

function patchFacts(result: PlanLaneResult, patch: Patch, attemptId = "job:E0:E0"): AcceptedResultProjection {
	return acceptedOf(result, {
		attemptId,
		digest: patch.digest,
		artifact: { attemptId, path: patch.path, form: "patch", expectedDigest: patch.digest },
	});
}

const artifactResult = (id: string, file: string, contains: string): PlanLaneResult => ({
	id,
	kind: "artifact",
	criterion: `${file} carries the required content`,
	path: file,
	contains,
});

const changeResult = (id: string, file?: string): PlanLaneResult => ({
	id,
	kind: "change",
	criterion: "the required change is in the parent",
	...(file === undefined ? {} : { path: file }),
});

describe("retained results", () => {
	test("a native patch is usable only while its host path and captured digest still agree", async () => {
		const repo = await newRepo("retained", { "tracked.txt": "base\n" });
		await fs.writeFile(path.join(repo.root, "tracked.txt"), "base\nplus\n");
		const patch = await makePatch(repo, "retained-patch");
		await resetWorktree(repo);

		const facts = patchFacts(artifactResult("experiment-patch", "tracked.txt", "plus"), patch);
		const located = requireLocation(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: facts }));
		expect(located.mode).toBe("retained");
		expect(located.kind).toBe("patch");
		expect(located.path).toBe(await fs.realpath(patch.path));
		expect(located.digest).toBe(patch.digest);
		expect(located.ref).toBe(`experiment-patch@${facts.contentVersion}`);
		expect(located.attemptId).toBe("job:E0:E0");
		// Reading the retained patch does not touch or adopt anything in the parent.
		expect(await fs.readFile(path.join(repo.root, "tracked.txt"), "utf8")).toBe("base\n");
		expectFailure(
			await locateResult({ mode: "retained", parentRoot: repo.root, accepted: facts, limits: { fileBytes: 16 } }),
			"unverifiable",
		);

		await fs.appendFile(patch.path, "tampered\n");
		expectFailure(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: facts }), "artifact-changed");
	});

	test("inside-parent, symlinked, retried and digest-less sources are refused", async () => {
		const repo = await newRepo("retained-refusals", { "tracked.txt": "base\n" });
		await fs.writeFile(path.join(repo.root, "tracked.txt"), "base\nplus\n");
		const patch = await makePatch(repo, "retained-refusal-patch");
		await resetWorktree(repo);
		const result = artifactResult("experiment-patch", "tracked.txt", "plus");
		const goodFacts = patchFacts(result, patch);

		const inside = path.join(repo.root, "inside.patch");
		await fs.writeFile(inside, patch.bytes);
		const insideFacts = acceptedOf(result, {
			attemptId: "job:E0:E0",
			digest: patch.digest,
			artifact: { attemptId: "job:E0:E0", path: inside, form: "patch" },
		});
		expectFailure(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: insideFacts }), "artifact-unsafe");

		const staleAttempt = acceptedOf(result, {
			attemptId: "job:E0:E0",
			digest: patch.digest,
			artifact: { attemptId: "job:E0:E1", path: patch.path, form: "patch" },
		});
		expectFailure(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: staleAttempt }), "attempt-mismatch");
		expectFailure(
			await locateResult({
				mode: "retained",
				parentRoot: repo.root,
				accepted: goodFacts,
				expectedAttemptId: "job:E0:E1",
			}),
			"attempt-mismatch",
		);

		const link = path.join(await tempRoot("retained-link"), "link.patch");
		await fs.symlink(patch.path, link);
		const linkedFacts = acceptedOf(result, {
			attemptId: "job:E0:E0",
			digest: patch.digest,
			artifact: { attemptId: "job:E0:E0", path: link, form: "patch" },
		});
		expectFailure(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: linkedFacts }), "artifact-unsafe");

		const wrongHostDigest = acceptedOf(result, {
			attemptId: "job:E0:E0",
			digest: patch.digest,
			artifact: { attemptId: "job:E0:E0", path: patch.path, form: "patch", expectedDigest: "f".repeat(64) },
		});
		expectFailure(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: wrongHostDigest }), "artifact-changed");

		const noDigest = acceptedOf(result, {
			attemptId: "job:E0:E0",
			artifact: { attemptId: "job:E0:E0", path: patch.path, form: "patch" },
		});
		expectFailure(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: noDigest }), "invalid-evidence");
	});
});

describe("integrated patch results", () => {
	test("adoption must match every file's postimage, not a path or a status", async () => {
		const repo = await newRepo("integrated", { "a.txt": "one\n", "b.txt": "one\n" });
		await fs.writeFile(path.join(repo.root, "a.txt"), "one\na\n");
		await fs.writeFile(path.join(repo.root, "b.txt"), "one\nb\n");
		const patch = await makePatch(repo, "integrated-patch");
		await resetWorktree(repo);
		const facts = patchFacts(artifactResult("experiment-patch", "a.txt", "a"), patch);

		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");

		repo.run("apply", patch.path);
		const located = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }));
		expect(located.kind).toBe("patch");
		expect(located.files?.map(file => file.path)).toEqual(["a.txt", "b.txt"]);
		expect(located.files?.[0]?.digest).toBe(sha256(await fs.readFile(path.join(repo.root, "a.txt"))));
		expect(located.files?.[1]?.digest).toBe(sha256(await fs.readFile(path.join(repo.root, "b.txt"))));

		// Partial adoption: one file is still the preimage.
		await fs.writeFile(path.join(repo.root, "b.txt"), "one\n");
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");

		// Full revert: every hunk's old side is back at its original position.
		await fs.writeFile(path.join(repo.root, "a.txt"), "one\n");
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");
	});

	test("another patch with the same path is not adoption", async () => {
		const repo = await newRepo("other-patch", { "a.txt": "one\n" });
		await fs.writeFile(path.join(repo.root, "a.txt"), "one\nA\n");
		const patchA = await makePatch(repo, "other-patch-a");
		await resetWorktree(repo);
		await fs.writeFile(path.join(repo.root, "a.txt"), "one\nB\n");
		const patchB = await makePatch(repo, "other-patch-b");
		await resetWorktree(repo);
		repo.run("apply", patchB.path);

		const facts = patchFacts(artifactResult("experiment-a", "a.txt", "A"), patchA);
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");
	});

	test("a created file is verified exactly, including a missing final newline", async () => {
		const repo = await newRepo("created", { "base.txt": "base\n" });
		await fs.writeFile(path.join(repo.root, "new.txt"), "created\n");
		repo.run("add", "-N", "new.txt");
		const patch = await makePatch(repo, "created-patch");
		await resetWorktree(repo);
		const facts = patchFacts(artifactResult("experiment-patch", "new.txt", "created"), patch);

		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");
		repo.run("apply", patch.path);
		const located = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }));
		expect(located.files).toEqual([{ path: "new.txt", digest: sha256("created\n") }]);

		// An extra byte is not the patch postimage.
		await fs.writeFile(path.join(repo.root, "new.txt"), "created\n\n");
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");

		const noNewlineRepo = await newRepo("created-no-newline", { "base.txt": "base\n" });
		await fs.writeFile(path.join(noNewlineRepo.root, "new.txt"), "created");
		noNewlineRepo.run("add", "-N", "new.txt");
		const noNewlinePatch = await makePatch(noNewlineRepo, "created-no-newline-patch");
		await resetWorktree(noNewlineRepo);
		const noNewlineFacts = patchFacts(artifactResult("experiment-patch", "new.txt", "created"), noNewlinePatch);
		noNewlineRepo.run("apply", noNewlinePatch.path);
		const noNewlineLocated = requireLocation(
			await locateResult({ mode: "integrated", parentRoot: noNewlineRepo.root, accepted: noNewlineFacts }),
		);
		expect(noNewlineLocated.files).toEqual([{ path: "new.txt", digest: sha256("created") }]);
	});

	test("pre-existing hunk text with extra content is not whole-postimage adoption", async () => {
		const repo = await newRepo("partial-text", { "a.txt": "one\n" });
		await fs.writeFile(path.join(repo.root, "a.txt"), "one\na\n");
		const patch = await makePatch(repo, "partial-text-patch");
		await resetWorktree(repo);
		// The hunk's added line is present at the right place, but the file is not the captured postimage.
		await fs.writeFile(path.join(repo.root, "a.txt"), "one\na\nextra\n");
		const facts = patchFacts(artifactResult("experiment-a", "a.txt", "a"), patch);
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");
	});

	test("a patch without a postimage blob id needs an authenticated whole-file digest", async () => {
		const repo = await newRepo("no-index", { "a.txt": "one\n" });
		await fs.writeFile(path.join(repo.root, "a.txt"), "one\na\n");
		const patch = await makePatch(repo, "no-index-patch");
		await resetWorktree(repo);
		repo.run("apply", patch.path);

		const strippedText = (await fs.readFile(patch.path, "utf8"))
			.split("\n")
			.filter(line => !line.startsWith("index "))
			.join("\n");
		const stripped = path.join(await tempRoot("no-index-stripped"), "stripped.patch");
		await fs.writeFile(stripped, strippedText);
		const result = artifactResult("experiment-a", "a.txt", "a");
		const facts = acceptedOf(result, {
			attemptId: "job:E0:E0",
			digest: sha256(strippedText),
			artifact: { attemptId: "job:E0:E0", path: stripped, form: "patch" },
		});
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "unverifiable");

		const whole = "one\na\n";
		const withWholeFile = acceptedOf(result, {
			attemptId: "job:E0:E0",
			digest: sha256(strippedText),
			files: [{ path: "a.txt", digest: sha256(whole), previousDigest: sha256("one\n") }],
			artifact: { attemptId: "job:E0:E0", path: stripped, form: "patch" },
		});
		const located = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: withWholeFile }));
		expect(located.files).toEqual([{ path: "a.txt", digest: sha256(whole) }]);
	});

	test("a plan check name, a path and a status string are not read as adoption", async () => {
		const repo = await newRepo("claimed", { "tracked.txt": "base\n" });
		await fs.writeFile(path.join(repo.root, "tracked.txt"), "base\nplus\n");
		const patch = await makePatch(repo, "claimed-patch");
		await resetWorktree(repo);
		// The old content is untouched; the only "evidence" is a claimed patch path and success.
		const result = artifactResult("experiment-patch", "tracked.txt", "plus");
		const facts = patchFacts(result, patch);
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");
	});
});

describe("integrated shared results", () => {
	test("the T02 adoption shape: the shared change exact post-digest is in the parent", async () => {
		const repo = await newRepo("adopt", { "base.txt": "base\n" });
		await fs.writeFile(path.join(repo.root, "experiment.txt"), "experiment change\n");
		repo.run("add", "-N", "experiment.txt");
		const patch = await makePatch(repo, "adopt-patch");
		await resetWorktree(repo);

		const result: PlanLaneResult = {
			id: "adopt-change",
			kind: "change",
			criterion: "the parent holds the adopted experiment",
			path: "experiment.txt",
			contains: "experiment change",
		};
		const facts = acceptedOf(result, {
			attemptId: "job:AD0:AD0",
			digest: sha256("experiment change\n"),
		});
		// `previousDigest` is omitted: the S1 baseline saw the path absent, never "unknown".
		const artifact = patchFacts(artifactResult("experiment-patch", "experiment.txt", "experiment change"), patch);
		const retained = requireLocation(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: artifact }));
		expect(retained.kind).toBe("patch");
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: artifact }), "not-integrated");
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");

		repo.run("apply", patch.path);
		const located = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }));
		expect(located.mode).toBe("integrated");
		expect(located.kind).toBe("parent-file");
		expect(located.path).toBe("experiment.txt");
		expect(located.digest).toBe(sha256("experiment change\n"));
		expect(located.files).toEqual([{ path: "experiment.txt", digest: sha256("experiment change\n") }]);

		// The same worker application also makes the independent experiment's retained patch integrated.
		const integratedPatch = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: artifact }));
		expect(integratedPatch.kind).toBe("patch");
		expect(integratedPatch.files).toEqual([{ path: "experiment.txt", digest: sha256("experiment change\n") }]);
	});

	test("an unchanged pre-existing file is never a changed result", async () => {
		const repo = await newRepo("unchanged", { "report.json": "{\"value\":42}\n" });
		const contents = "{\"value\":42}\n";
		const result = changeResult("report-change", "report.json");
		const unchanged = acceptedOf(result, { digest: sha256(contents), previousDigest: sha256(contents) });
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: unchanged }), "reverted");

		const changedThenReverted = acceptedOf(result, { digest: sha256("{\"value\":43}\n"), previousDigest: sha256(contents) });
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: changedThenReverted }), "reverted");

		const noFingerprint = acceptedOf(result, {});
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: noFingerprint }), "invalid-evidence");
	});

	test("a pathless change verifies every observed file and preserves independent results", async () => {
		const repo = await newRepo("pathless", { "first.txt": "one\n", "second.txt": "two\n" });
		await fs.writeFile(path.join(repo.root, "first.txt"), "one changed\n");
		await fs.writeFile(path.join(repo.root, "second.txt"), "two changed\n");
		const result = changeResult("both");
		const facts = acceptedOf(result, {
			files: [
				{ path: "first.txt", digest: sha256("one changed\n"), previousDigest: sha256("one\n") },
				{ path: "second.txt", digest: sha256("two changed\n"), previousDigest: sha256("two\n") },
			],
		});
		const located = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }));
		expect(located.kind).toBe("parent-files");
		expect(located.files?.map(file => file.path)).toEqual(["first.txt", "second.txt"]);

		// The second result is reverted; the first stays valid, but the aggregate result is not integrated.
		await fs.writeFile(path.join(repo.root, "second.txt"), "two\n");
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated", "reverted");
	});
});

describe("fail-closed evidence", () => {
	test("root escape, symlink escape, missing evidence and truncation are refused", async () => {
		const repo = await newRepo("containment", { "tracked.txt": "base\n" });

		const escapedResult: PlanLaneResult = {
			id: "escaped-change",
			kind: "change",
			criterion: "outside the tree",
			path: "../outside.txt",
		};
		expectFailure(
			await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: acceptedOf(escapedResult, { digest: sha256("x") }) }),
			"invalid-evidence",
		);

		const outsideDir = await tempRoot("containment-outside");
		const secret = path.join(outsideDir, "secret.txt");
		await fs.writeFile(secret, "secret\n");
		await fs.symlink(secret, path.join(repo.root, "linked.txt"));
		const linked = acceptedOf(changeResult("linked-change", "linked.txt"), { digest: sha256("secret\n") });
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: linked }), "unverifiable");

		const patchText = [
			"diff --git a/../escape.txt b/../escape.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/../escape.txt",
			"@@ -0,0 +1 @@",
			"+escape",
			"",
		].join("\n");
		const patchFile = path.join(await tempRoot("containment-patch"), "escape.patch");
		await fs.writeFile(patchFile, patchText);
		const escapeFacts = acceptedOf(artifactResult("escape", "escape.txt", "escape"), {
			attemptId: "job:E0:E0",
			digest: sha256(patchText),
			artifact: { attemptId: "job:E0:E0", path: patchFile, form: "patch" },
		});
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: escapeFacts }), "unverifiable");

		await fs.writeFile(path.join(repo.root, "large.txt"), "x".repeat(512));
		const large = acceptedOf(changeResult("large-change", "large.txt"), { digest: sha256("x".repeat(512)) });
		expectFailure(
			await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: large, limits: { fileBytes: 32 } }),
			"unverifiable",
		);

		const answer: PlanLaneResult = { id: "lookup", kind: "answer", criterion: "the answer cites its source" };
		expectFailure(
			await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: acceptedOf(answer, { digest: sha256("answer") }) }),
			"not-locatable",
		);

		const reviewable = { ...acceptedOf(changeResult("pending", "tracked.txt"), { digest: sha256("base\n") }), state: "reviewable" as const };
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: reviewable }), "not-accepted");
	});

	test("failure codes stay fail-closed for bad identity and unsupported retained changes", async () => {
		const repo = await newRepo("identity", { "tracked.txt": "base\n" });
		const result = changeResult("identity-change", "tracked.txt");
		const badIdentity = { ...acceptedOf(result, { digest: sha256("base\n") }), identity: "f".repeat(64) };
		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: badIdentity }), "invalid-evidence");
		expectFailure(
			await locateResult({ mode: "retained", parentRoot: repo.root, accepted: acceptedOf(result, { digest: sha256("base\n") }) }),
			"not-locatable",
		);
	});
});

describe("S1 evidence projection", () => {
	test("accepted S1 evidence locates content and unchanged evidence never projects", async () => {
		const root = await tempRoot("s1-projection");
		await writeFiles(root, { "report.json": "{\"user\":true}\n" });
		const result: PlanLaneResult = {
			id: "report-change",
			kind: "change",
			criterion: "the report is generated",
			path: "report.json",
			contains: "generated",
		};
		const captured = await captureSharedBaseline({ lane: "writer", root, results: [result] });
		if (!captured.ok) throw new Error(captured.reason);

		// T01's shape: the file pre-exists, the worker changed nothing, S1 records unmet, so no location is projected.
		const unchanged = await evaluateSettledResults({
			lane: "writer",
			attemptId: "job:W:W",
			results: [result],
			shared: { root, baseline: captured.baseline },
		});
		if (!unchanged.ok) throw new Error(unchanged.reason);
		const unchangedItem = unchanged.report.results[0]!;
		expect(unchangedItem.state).toBe("unmet");
		expect(
			projectAcceptedResult({
				row: {
					id: result.id,
					state: unchangedItem.state,
					attemptId: "job:W:W",
					identity: unchangedItem.identity,
					...(unchangedItem.contentVersion === undefined ? {} : { contentVersion: unchangedItem.contentVersion }),
				},
				result,
				item: unchangedItem,
			}).ok,
		).toBe(false);

		await fs.writeFile(path.join(root, "report.json"), "{\"generated\":true}\n");
		const evaluated = await evaluateSettledResults({
			lane: "writer",
			attemptId: "job:W:W",
			results: [result],
			shared: { root, baseline: captured.baseline },
		});
		if (!evaluated.ok) throw new Error(evaluated.reason);
		const item = evaluated.report.results[0]!;
		expect(item.state).toBe("accepted");
		const row = {
			id: result.id,
			state: "accepted" as const,
			attemptId: "job:W:W",
			identity: item.identity,
			contentVersion: item.contentVersion!,
		};
		const projected = projectAcceptedResult({ row, result, item });
		if (!projected.ok) throw new Error(projected.reason);
		const located = requireLocation(await locateResult({ mode: "integrated", parentRoot: root, accepted: projected.accepted }));
		expect(located.kind).toBe("parent-file");
		expect(located.files).toEqual([{ path: "report.json", digest: sha256("{\"generated\":true}\n") }]);

		// A row from a newer attempt cannot reuse this item's evidence.
		expect(projectAcceptedResult({ row: { ...row, attemptId: "job:W:W2" }, result, item }).ok).toBe(false);
	});
});

describe("file and directory artifacts", () => {
	test("a retained plain file is addressable only while it stays outside the parent", async () => {
		const repo = await newRepo("file-artifact", { "base.txt": "base\n" });
		const outside = path.join(await tempRoot("file-artifact-outside"), "out.txt");
		await fs.writeFile(outside, "artifact content\n");
		const result = artifactResult("artifact-file", "out.txt", "artifact content");
		const facts = acceptedOf(result, {
			attemptId: "job:F0:F0",
			digest: sha256("artifact content\n"),
			artifact: { attemptId: "job:F0:F0", path: outside, form: "file" },
		});
		const retained = requireLocation(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: facts }));
		expect(retained.kind).toBe("file");
		expect(retained.path).toBe(await fs.realpath(outside));

		expectFailure(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }), "not-integrated");
		await fs.writeFile(path.join(repo.root, "out.txt"), "artifact content\n");
		const integrated = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }));
		expect(integrated.kind).toBe("parent-file");
		expect(integrated.digest).toBe(sha256("artifact content\n"));
	});

	test("a directory artifact verifies its declared member and its adopted parent copy", async () => {
		const repo = await newRepo("dir-artifact", { "base.txt": "base\n" });
		const artifactDir = await tempRoot("dir-artifact-source");
		await fs.writeFile(path.join(artifactDir, "out.txt"), "directory content\n");
		const result = artifactResult("artifact-dir", "out.txt", "directory content");
		const facts = acceptedOf(result, {
			attemptId: "job:F1:F1",
			digest: sha256("directory content\n"),
			artifact: { attemptId: "job:F1:F1", path: artifactDir, form: "directory" },
		});
		const retained = requireLocation(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: facts }));
		expect(retained.kind).toBe("directory");
		expect(retained.files).toEqual([{ path: "out.txt", digest: sha256("directory content\n") }]);

		await fs.writeFile(path.join(repo.root, "out.txt"), "directory content\n");
		const integrated = requireLocation(await locateResult({ mode: "integrated", parentRoot: repo.root, accepted: facts }));
		expect(integrated.kind).toBe("parent-file");
		expect(integrated.digest).toBe(sha256("directory content\n"));

		await fs.writeFile(path.join(artifactDir, "out.txt"), "tampered\n");
		expectFailure(await locateResult({ mode: "retained", parentRoot: repo.root, accepted: facts }), "artifact-changed");
	});
});
