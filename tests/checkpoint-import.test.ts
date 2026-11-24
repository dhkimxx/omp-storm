/**
 * Checkpoint import: a resumed run keeps only what the current tree, session artifact root or cited source still
 * proves. Each refusal has a passing control so a module that refuses everything cannot pass.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureCheckpointProof,
	normalizeCheckpointPlan,
	type ResultProof,
	revalidateCheckpointProof,
} from "../src/runtime/checkpoint-import.ts";
import {
	type ArtifactEvidenceSource,
	captureSharedBaseline,
	evaluateSettledResults,
	type ResultEvidenceItem,
	resultContractIdentity,
} from "../src/runtime/result-evidence.ts";
import type { PlanLaneResult, RunPlan, RunResult, StormConfig } from "../src/types.ts";
import { teamOf } from "./fixtures.ts";

const ATTEMPT = "job:v1:Spawn0";
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

let root: string;
let artifacts: string;
const dirs: string[] = [];

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-import-root-")));
	artifacts = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-import-artifacts-")));
	dirs.push(root, artifacts);
});

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function write(relative: string, content: string, base = root): Promise<string> {
	const file = path.join(base, relative);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, content);
	return file;
}

/** One accepted item from the real S1 evaluator: the same shape the controller settles with. */
async function acceptedItem(
	result: PlanLaneResult,
	opts: { artifact?: ArtifactEvidenceSource; answer?: { text: string; line: number }; change?: string } = {},
	expected: "accepted" | "reviewable" = "accepted",
): Promise<ResultEvidenceItem> {
	const baseline = await captureSharedBaseline({
		lane: "work",
		results: [result],
		root,
		...(result.kind === "artifact" ? { artifactMode: "isolated" as const } : {}),
	});
	if (!baseline.ok) throw new Error(baseline.reason);
	if (opts.change !== undefined && result.path !== undefined) await write(result.path, opts.change);
	const evaluation = await evaluateSettledResults({
		lane: "work",
		attemptId: ATTEMPT,
		results: [result],
		shared: { root, baseline: baseline.baseline },
		...(result.kind === "artifact" ? { artifactMode: "isolated" as const } : {}),
		...(opts.artifact === undefined ? {} : { artifact: opts.artifact }),
		...(opts.answer === undefined
			? {}
			: { answer: { text: opts.answer.text, citations: [{ path: result.path ?? "", line: opts.answer.line }] } }),
	});
	if (!evaluation.ok) throw new Error(evaluation.reason);
	const item = evaluation.report.results[0];
	if (item === undefined || item.state !== expected) throw new Error(`expected ${expected}: ${item?.reason ?? "missing item"}`);
	return item;
}

/** The row the controller would persist with a captured proof, or a forced shape for a hostile-record test. */
function storedRow(result: PlanLaneResult, item: ResultEvidenceItem, artifact?: ArtifactEvidenceSource): RunResult {
	const proof = captureCheckpointProof(item, artifact);
	if (proof === undefined) throw new Error("the item has no capturable proof");
	return {
		id: result.id,
		state: "accepted",
		attemptId: item.attemptId,
		identity: item.identity,
		contract: result,
		...(item.contentVersion === undefined ? {} : { contentVersion: item.contentVersion }),
		proof,
		origin: "attempt",
	};
}

/** A row whose identity matches the contract but whose proof is written by hand (an untrusted store). */
function forgedRow(result: PlanLaneResult, proof: ResultProof, over: Partial<RunResult> = {}): RunResult {
	return {
		id: result.id,
		state: "accepted",
		attemptId: proof.item.attemptId,
		identity: proof.item.identity,
		contract: result,
		...(proof.item.contentVersion === undefined ? {} : { contentVersion: proof.item.contentVersion }),
		proof,
		origin: "attempt",
		...over,
	};
}

function forgedItem(result: PlanLaneResult, over: Partial<ResultEvidenceItem> = {}): ResultEvidenceItem {
	return {
		id: result.id,
		identity: resultContractIdentity(result),
		kind: result.kind,
		criterion: result.criterion,
		attemptId: ATTEMPT,
		state: "accepted",
		...(result.path === undefined ? {} : { path: result.path }),
		digest: sha256("answer text"),
		contentVersion: sha256("content version"),
		...(result.kind === "answer" ? { citation: { path: result.path ?? "notes.md", line: 1, digest: sha256("cited\n") } } : {}),
		...over,
	};
}

const changeResult = (id: string, file: string): PlanLaneResult => ({
	id,
	kind: "change",
	criterion: "the accepted line is present",
	path: file,
	contains: "accepted line",
});

describe("accepted change", () => {
	test("imports while the current tree has the accepted content and reopens when it changes", async () => {
		const result = changeResult("change-1", "src/app.ts");
		await write("src/app.ts", "base\n");
		const item = await acceptedItem(result, { change: "base\naccepted line\n" });
		const row = storedRow(result, item);
		expect(await revalidateCheckpointProof({ row, result, root })).toEqual({ ok: true });

		await write("src/app.ts", "base changed again\n");
		const changed = await revalidateCheckpointProof({ row, result, root });
		expect(changed.ok).toBe(false);
		if (!changed.ok) expect(changed.reason).toContain("현재 트리에서 수용된 결과를 확인하지 못했습니다");

		// The exact accepted content makes the same row usable again: the refusal was the content, not a latch.
		await write("src/app.ts", "base\naccepted line\n");
		expect(await revalidateCheckpointProof({ row, result, root })).toEqual({ ok: true });
	});

	test("a proof whose contract identity or content version differs from the row is refused", async () => {
		const result = changeResult("change-1", "src/app.ts");
		await write("src/app.ts", "base\n");
		const item = await acceptedItem(result, { change: "base\naccepted line\n" });
		const row = storedRow(result, item);
		expect((await revalidateCheckpointProof({ row: { ...row, contentVersion: sha256("other") }, result, root })).ok).toBe(false);
		expect((await revalidateCheckpointProof({ row: { ...row, attemptId: "job:v1:Other" }, result, root })).ok).toBe(false);
		const withoutContract = { ...row };
		delete withoutContract.contract;
		expect((await revalidateCheckpointProof({ row: withoutContract, result, root })).ok).toBe(false);
	});

	test("a check-backed or review-accepted row needs a current judgement, never old proof", async () => {
		const result = changeResult("change-1", "src/app.ts");
		await write("src/app.ts", "base\n");
		const item = await acceptedItem(result, { change: "base\naccepted line\n" });
		const row = storedRow(result, item);
		const checked: PlanLaneResult = { ...result, check: "unit-check" };
		const checkedItem: ResultEvidenceItem = { ...item, identity: resultContractIdentity(checked) };
		const rejected = await revalidateCheckpointProof({ row: forgedRow(checked, { item: checkedItem }), result: checked, root });
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.reason).toContain("필수 검사");
		const review = await revalidateCheckpointProof({ row: { ...row, origin: "review" }, result, root });
		expect(review.ok).toBe(false);
		if (!review.ok) expect(review.reason).toContain("리뷰");
	});

	test("a reviewable submission must still match its exact file before a fresh reviewer can use it", async () => {
		const result: PlanLaneResult = { id: "new-review", kind: "change", criterion: "show the new behaviour", path: "src/app.ts" };
		await write(result.path!, "base\n");
		const item = await acceptedItem(result, { change: "base\nnew behaviour\n" }, "reviewable");
		const row = { ...storedRow(result, item), state: "reviewable" as const };
		expect((await revalidateCheckpointProof({ row, result, root })).ok).toBe(false);
		expect(await revalidateCheckpointProof({ row, result, root, forReview: true })).toEqual({ ok: true });
		await write(result.path!, "base\nsomething different\n");
		expect((await revalidateCheckpointProof({ row, result, root, forReview: true })).ok).toBe(false);
	});
});

describe("answer anchor", () => {
	test("re-reads exactly the saved citation and reopens when that source changes", async () => {
		const result: PlanLaneResult = { id: "answer-1", kind: "answer", criterion: "report the value", path: "notes.md", contains: "42" };
		await write("notes.md", "value: 42\nother: 7\n");
		const item = await acceptedItem(result, { answer: { text: "the value is 42", line: 1 } });
		const row = storedRow(result, item);
		expect(row.proof?.item.citation).toMatchObject({ path: "notes.md", line: 1 });
		expect(await revalidateCheckpointProof({ row, result, root })).toEqual({ ok: true });

		await write("notes.md", "value: 43\nother: 7\n");
		const changed = await revalidateCheckpointProof({ row, result, root });
		expect(changed.ok).toBe(false);
		if (!changed.ok) expect(changed.reason).toContain("수용 당시와 다릅니다");
	});

	test("never searches for another citation with the same content", async () => {
		const result: PlanLaneResult = { id: "answer-1", kind: "answer", criterion: "report the value", path: "notes.md", contains: "42" };
		await write("notes.md", "value: 42\n");
		await write("other.md", "value: 42\n");
		const item = await acceptedItem(result, { answer: { text: "the value is 42", line: 1 } });
		const row = storedRow(result, item);
		// Same bytes, same digest, but a different source: the recorded anchor is the requirement's path.
		const forged = forgedRow(result, { item: { ...item, citation: { path: "other.md", line: 1, digest: sha256("value: 42\n") } } });
		const checked = await revalidateCheckpointProof({ row: forged, result, root });
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain("요구 경로와 다릅니다");
		expect(await revalidateCheckpointProof({ row, result, root })).toEqual({ ok: true });
	});

	test("an escaping citation path is refused before any read", async () => {
		const result: PlanLaneResult = { id: "answer-1", kind: "answer", criterion: "report the value", path: "../escape.md", contains: "cited" };
		const item = forgedItem(result, { citation: { path: "../escape.md", line: 1, digest: sha256("cited source\n") } });
		const checked = await revalidateCheckpointProof({ row: forgedRow(result, { item }), result, root });
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain("올바르지 않습니다");
	});

	test("a cited symlink is never read, even when its target has the saved digest", async () => {
		const target = await write("real.md", "cited source\n");
		await symlink(target, path.join(root, "link.md"));
		const result: PlanLaneResult = { id: "answer-1", kind: "answer", criterion: "report the value", path: "link.md", contains: "cited" };
		const identity = resultContractIdentity(result);
		const item: ResultEvidenceItem = {
			id: result.id,
			identity,
			kind: "answer",
			criterion: result.criterion,
			attemptId: ATTEMPT,
			state: "accepted",
			path: "link.md",
			digest: sha256("answer text"),
			contentVersion: sha256("content version"),
			citation: { path: "link.md", line: 1, digest: sha256("cited source\n") },
		};
		const checked = await revalidateCheckpointProof({ row: forgedRow(result, { item }), result, root });
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain("symbolic-link");
	});
});

describe("retained artifact", () => {
	const artifactResult: PlanLaneResult = {
		id: "artifact-1",
		kind: "artifact",
		criterion: "the retained output carries the line",
		path: "out.txt",
		contains: "artifact content",
	};

	async function artifactFixture(): Promise<{ item: ResultEvidenceItem; source: ArtifactEvidenceSource; file: string }> {
		const file = await write(path.join("spawn", "out.txt"), "artifact content\n", artifacts);
		const source: ArtifactEvidenceSource = { attemptId: ATTEMPT, path: file, form: "file" };
		const item = await acceptedItem(artifactResult, { artifact: source });
		return { item, source, file };
	}

	test("imports only from this session's artifacts dir and reopens when the source changes", async () => {
		const { item, source } = await artifactFixture();
		const row = storedRow(artifactResult, item, source);
		expect(await revalidateCheckpointProof({ row, result: artifactResult, root, artifactsDir: artifacts, isolated: true })).toEqual({ ok: true });

		const otherDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-import-empty-")));
		dirs.push(otherDir);
		const outside = await revalidateCheckpointProof({ row, result: artifactResult, root, artifactsDir: otherDir, isolated: true });
		expect(outside.ok).toBe(false);
		if (!outside.ok) expect(outside.reason).toContain("밖");
		expect((await revalidateCheckpointProof({ row, result: artifactResult, root, isolated: true })).ok).toBe(false);

		await writeFile(source.path, "artifact content changed\n");
		expect((await revalidateCheckpointProof({ row, result: artifactResult, root, artifactsDir: artifacts, isolated: true })).ok).toBe(false);

		await unlink(source.path);
		const gone = await revalidateCheckpointProof({ row, result: artifactResult, root, artifactsDir: artifacts, isolated: true });
		expect(gone.ok).toBe(false);
		if (!gone.ok) expect(gone.reason).toContain("찾을 수 없습니다");
	});

	test("a symlinked retained source is refused even inside the artifacts dir", async () => {
		const { item, file } = await artifactFixture();
		const link = path.join(path.dirname(file), "link.txt");
		await symlink(file, link);
		const source: ArtifactEvidenceSource = { attemptId: ATTEMPT, path: link, form: "file" };
		const row = storedRow(artifactResult, item, source);
		const checked = await revalidateCheckpointProof({ row, result: artifactResult, root, artifactsDir: artifacts, isolated: true });
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain("심볼릭 링크");
	});

	test("an isolated artifact without a retained source is never imported", async () => {
		const { item } = await artifactFixture();
		const row = storedRow(artifactResult, item);
		const checked = await revalidateCheckpointProof({ row, result: artifactResult, root, artifactsDir: artifacts, isolated: true });
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain("보존된 호스트 산출물 근거");
	});
});

describe("proof capture", () => {
	test("clones only bounded fields and never attaches a mixed lane's artifact to a change row", async () => {
		const result = changeResult("change-1", "src/app.ts");
		await write("src/app.ts", "base\n");
		const item = await acceptedItem(result, { change: "base\naccepted line\n" });
		const source: ArtifactEvidenceSource = { attemptId: ATTEMPT, path: path.join(artifacts, "unused.patch"), form: "patch" };
		const proof = captureCheckpointProof(
			{ ...item, reason: "raw model wording", checkDeferred: true, check: { name: "x", status: "passed", configHash: "h", tree: "t" } },
			source,
		);
		expect(proof?.artifact).toBeUndefined();
		expect(proof?.item.reason).toBeUndefined();
		expect(proof?.item.check).toBeUndefined();
		expect(proof?.item.checkDeferred).toBeUndefined();
		expect(captureCheckpointProof({ ...item, state: "unmet" })).toBeUndefined();
		expect(captureCheckpointProof({ ...item, identity: "not-a-digest" })).toBeUndefined();
		const withoutVersion = { ...item };
		delete withoutVersion.contentVersion;
		expect(captureCheckpointProof(withoutVersion)).toBeUndefined();
	});
});

describe("plan normalization", () => {
	const config: StormConfig = teamOf(
		{ explorer: "a/x", implementer: "a/i", reviewer: "a/r" },
		{ jobs: [{ name: "unit", argv: ["/bin/sh", "-c", "true"] }] },
	);
	function plan(over: Partial<RunPlan> = {}): RunPlan {
		return {
			lanes: [
				{
					name: "job",
					kind: "run",
					role: "quick",
					job: "unit",
					results: [{ id: "job-output", kind: "answer", criterion: "stdout shows the pass line", contains: "pass" }],
				},
				{
					name: "write",
					kind: "code",
					role: "implementer",
					progress: "half done",
					files: ["src/app.ts"],
					results: [{ id: "change-1", kind: "change", criterion: "the line is present", path: "src/app.ts", contains: "line" }],
				},
			],
			workers: { implementer: 3 },
			submittedAt: "2026-11-20T09:00:00.000Z",
			note: "the remaining decision",
			...over,
		};
	}

	test("a job lane's internal role is omitted, so the deterministic run lane parses again", () => {
		const normalized = normalizeCheckpointPlan(config, plan());
		expect(normalized).toBeDefined();
		if (normalized === undefined) return;
		expect(normalized.lanes.map(lane => lane.name)).toEqual(["job", "write"]);
		expect(normalized.lanes[0]).toMatchObject({ job: "unit", role: "quick" });
		expect(normalized.lanes[1]?.progress).toBeUndefined();
		// The run's live-worker allowance is re-derived, never imported from the old record.
		expect(normalized.workers).toEqual({ implementer: 1 });
		expect(normalized.note).toBe("the remaining decision");
		expect(normalized.submittedAt).toBe("2026-11-20T09:00:00.000Z");
	});

	test("the stored plan still has to pass the plan validator against the current team", () => {
		expect(normalizeCheckpointPlan(config, plan({ lanes: [{ name: "x", kind: "code", role: "implementer" }] }))).toBeUndefined();
		expect(
			normalizeCheckpointPlan(config, {
				...plan(),
				lanes: [
					{
						name: "x",
						kind: "code",
						role: "ghost",
						results: [{ id: "r", kind: "change", criterion: "c", path: "src/app.ts", contains: "x" }],
					},
				],
			}),
		).toBeUndefined();
		expect(normalizeCheckpointPlan({ ...config, disabledRoles: ["implementer"] }, plan())).toBeUndefined();
		expect(normalizeCheckpointPlan({ ...config, jobs: [] }, plan())).toBeUndefined();
		expect(normalizeCheckpointPlan(config, { lanes: "x" })).toBeUndefined();
		expect(
			normalizeCheckpointPlan(config, {
				...plan(),
				lanes: [
					{
						name: "w",
						kind: "code",
						role: "implementer",
						files: ["../escape"],
						results: [{ id: "r", kind: "change", criterion: "c", path: "a", contains: "x" }],
					},
				],
			}),
		).toBeUndefined();
	});
});
