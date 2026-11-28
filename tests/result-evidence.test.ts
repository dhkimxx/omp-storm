import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configHash } from "../src/config/canonical.ts";
import { parseLaneResults } from "../src/plan/validate.ts";
import type { CheckReport, CheckStatus } from "../src/runtime/checks.ts";
import {
	type ApprovedCheckEvidence,
	captureSharedBaseline,
	evaluateSettledResults,
	resultBaselineDigest,
	resultContractIdentity,
	resultEvidenceDigest,
} from "../src/runtime/result-evidence.ts";
import type { ApprovalRecord, ConfigLoad, PlanLaneResult, StormConfig } from "../src/types.ts";
import { approvalRecord } from "./fixtures.ts";
import { TEAM } from "./support.ts";

const dirs: string[] = [];
async function tempRoot(label: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `storm-evidence-${label}-`));
	dirs.push(dir);
	return fs.realpath(dir);
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function put(root: string, relative: string, content: string): Promise<void> {
	const file = path.join(root, relative);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
}

const change = (id: string, file: string, extra: Partial<PlanLaneResult> = {}): PlanLaneResult => ({
	id,
	kind: "change",
	criterion: `${file} is updated`,
	path: file,
	...extra,
});

interface BaselineOptions {
	config?: StormConfig;
	laneFiles?: string[];
	artifactMode?: "shared" | "isolated";
}

async function baselineOf(root: string, results: PlanLaneResult[], lane = "api", options: BaselineOptions = {}) {
	const captured = await captureSharedBaseline({
		lane,
		root,
		results,
		...(options.config === undefined ? {} : { config: options.config }),
		...(options.laneFiles === undefined ? {} : { laneFiles: options.laneFiles }),
		...(options.artifactMode === undefined ? {} : { artifactMode: options.artifactMode }),
	});
	if (!captured.ok) throw new Error(captured.reason);
	return captured.baseline;
}

function reportFor(hash: string, checks: Array<{ name: string; status: CheckStatus; argv?: string[] }>, fingerprint = "tree-1"): CheckReport {
	const at = "2026-01-01T00:00:00.000Z";
	return {
		status: checks.every(check => check.status === "passed") ? "passed" : "failed",
		configHash: hash,
		fingerprint,
		complete: true,
		aborted: false,
		startedAt: at,
		finishedAt: at,
		durationMs: 1,
		checks: checks.map(check => ({
			name: check.name,
			argv: check.argv ?? ["true"],
			status: check.status,
			exitCode: check.status === "passed" ? 0 : 1,
			signal: null,
			startedAt: at,
			finishedAt: at,
			durationMs: 1,
			stdout: { tail: "", totalBytes: 0, truncated: false },
			stderr: { tail: "", totalBytes: 0, truncated: false },
		})),
	};
}

describe("shared change evidence", () => {
	test("a pre-existing dirty file is not a change; a real edit after the baseline is", async () => {
		const root = await tempRoot("dirty");
		const original = '{\n  "total": 42,\n  "source": "user owning this file"\n}\n';
		await put(root, "report.json", original);
		const results = [change("report", "report.json", { contains: '"total": 42' })];
		const baseline = await baselineOf(root, results);
		const t01aDigest = "f9006a330a274b5ef04418c0a4cfdc289a16d76ed45de3746f729125e69cd54e";
		expect(baseline.entries[0]).toMatchObject({ bytes: 55, digest: t01aDigest });

		const unchanged = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(unchanged.ok).toBe(true);
		if (!unchanged.ok) return;
		expect(unchanged.report.complete).toBe(false);
		expect(unchanged.report.results[0]).toMatchObject({ id: "report", state: "unmet", digest: t01aDigest });
		expect(unchanged.report.results[0]?.reason).toContain("바뀐 내용이 없습니다");
		expect(unchanged.report.results[0]?.digest).toBe(unchanged.report.results[0]?.previousDigest);
		expect(await fs.readFile(path.join(root, "report.json"), "utf8")).toBe(original);

		await put(root, "report.json", '{\n  "total": 42,\n  "source": "worker wrote this"\n}\n');
		const changed = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(changed.ok).toBe(true);
		if (!changed.ok) return;
		expect(changed.report.complete).toBe(true);
		expect(changed.report.results[0]).toMatchObject({ id: "report", state: "accepted", path: "report.json" });
		expect(changed.report.results[0]?.previousDigest).toBe(unchanged.report.results[0]?.digest as string);
		expect(changed.report.results[0]?.digest).not.toBe(changed.report.results[0]?.previousDigest);
		expect(changed.report.results[0]?.contentVersion).toBeDefined();
		expect(changed.report.results[0]?.contentVersion).not.toBe(unchanged.report.results[0]?.contentVersion);
	});

	test("a change without contains or check is reviewable, never accepted", async () => {
		const root = await tempRoot("reviewable");
		const results = [change("write", "notes.md")];
		const baseline = await baselineOf(root, results);
		await put(root, "notes.md", "worker wrote some prose");
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		expect(evaluated.report.results[0]).toMatchObject({ state: "reviewable" });
		expect(evaluated.report.complete).toBe(false);
		expect(evaluated.report.reviewable).toBe(1);
	});

	test("a pathless change uses declared lane.files for per-file before/after facts", async () => {
		const root = await tempRoot("pathless-change");
		const results: PlanLaneResult[] = [{ id: "prose", kind: "change", criterion: "the prose response is improved" }];
		await put(root, "a.md", "before");
		const baseline = await baselineOf(root, results, "api", { laneFiles: ["a.md"] });
		expect(baseline.entries.map(entry => entry.path)).toEqual(["a.md"]);
		const withoutFiles = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root } });
		expect(withoutFiles.ok).toBe(true);
		if (withoutFiles.ok) expect(withoutFiles.report.results[0]?.state).toBe("unmet");

		await put(root, "a.md", "after");
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline }, laneFiles: ["a.md"] });
		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		expect(evaluated.report.results[0]?.state).toBe("reviewable");
		expect(evaluated.report.results[0]?.observations).toEqual([expect.objectContaining({ path: "a.md", changed: true })]);
		expect(evaluated.report.results[0]?.reason).toContain("자연어 판단");

		const mismatch = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline }, laneFiles: ["other.md"] });
		expect(mismatch.ok).toBe(true);
		if (mismatch.ok) expect(mismatch.report.results[0]?.reason).toContain("파일 범위");
	});

	test("a pathless change with no lane.files is unmet, never accepted or reviewable", async () => {
		const root = await tempRoot("pathless-none");
		const results: PlanLaneResult[] = [{ id: "prose", kind: "change", criterion: "the prose response is improved" }];
		const baseline = await baselineOf(root, results);
		expect(baseline.entries).toEqual([]);
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		expect(evaluated.report.results[0]?.state).toBe("unmet");
		expect(evaluated.report.results[0]?.reason).toContain("레인 files");
	});

	test("a deleted declared path is absence evidence, not an empty file", async () => {
		const root = await tempRoot("deleted-change");
		await put(root, "gone.md", "before deletion\n");
		const results = [change("gone", "gone.md")];
		const baseline = await baselineOf(root, results);
		await fs.rm(path.join(root, "gone.md"));
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		const item = evaluated.report.results[0]!;
		expect(item).toMatchObject({ id: "gone", state: "reviewable", path: "gone.md", absent: true });
		expect(item.digest).toBeUndefined();
		expect(item.previousDigest).toBe(baseline.entries[0]?.digest);
		expect(item.contentVersion).toBeDefined();
	});

	test("a pathless deletion is recorded as an absent observation", async () => {
		const root = await tempRoot("pathless-delete");
		await put(root, "one.md", "before\n");
		await put(root, "two.md", "keep\n");
		const results: PlanLaneResult[] = [{ id: "prose", kind: "change", criterion: "the prose response is improved" }];
		const baseline = await baselineOf(root, results, "api", { laneFiles: ["one.md", "two.md"] });
		await fs.rm(path.join(root, "one.md"));
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline }, laneFiles: ["one.md", "two.md"] });
		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		expect(evaluated.report.results[0]?.observations).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "one.md", changed: true, absent: true })]),
		);
		expect(evaluated.report.results[0]?.contentVersion).toBeDefined();
	});
});

describe("source-citing answers", () => {
	const answer = (extra: Partial<PlanLaneResult> = {}): PlanLaneResult => ({
		id: "read-total",
		kind: "answer",
		criterion: "what total does report.json hold?",
		path: "report.json",
		contains: '"total": 42',
		...extra,
	});

	async function rootWithReport(): Promise<string> {
		const root = await tempRoot("answer");
		await put(root, "report.json", '{\n  "total": 42,\n  "source": "user"\n}\n');
		return root;
	}

	test("a cited line anchors the answer; a wrong or missing source does not", async () => {
		const root = await rootWithReport();
		const results = [answer()];
		const cited = await evaluateSettledResults({
			lane: "read",
			attemptId: "attempt-1",
			results,
			shared: { root },
			answer: { text: "42", citations: [{ path: "report.json", line: 2, quote: '"total": 42' }] },
		});
		expect(cited.ok).toBe(true);
		if (!cited.ok) return;
		expect(cited.report.results[0]).toMatchObject({ state: "accepted", citation: { path: "report.json", line: 2 } });
		expect(cited.report.results[0]?.digest).toBeDefined();

		const wrongQuote = await evaluateSettledResults({
			lane: "read",
			attemptId: "attempt-1",
			results,
			shared: { root },
			answer: { text: "42", citations: [{ path: "report.json", line: 2, quote: '"total": 7' }] },
		});
		expect(wrongQuote.ok).toBe(true);
		if (wrongQuote.ok) expect(wrongQuote.report.results[0]?.state).toBe("unmet");

		const noSource = await evaluateSettledResults({ lane: "read", attemptId: "attempt-1", results, shared: { root }, answer: { text: "42", citations: [] } });
		expect(noSource.ok).toBe(true);
		if (noSource.ok) expect(noSource.report.results[0]?.state).toBe("unmet");

		const escape = await evaluateSettledResults({
			lane: "read",
			attemptId: "attempt-1",
			results,
			shared: { root },
			answer: { text: "42", citations: [{ path: "../report.json", line: 2 }] },
		});
		expect(escape.ok).toBe(true);
		if (escape.ok) expect(escape.report.results[0]?.state).toBe("unmet");
	});

	test("a declared contains must be on the cited line and match the reported numbers", async () => {
		const root = await rootWithReport();
		await put(root, "other.json", '{\n  "total": 42\n}\n');
		const results = [answer()];
		const evaluate = (text: string, citations: Array<{ path: string; line?: number; quote?: string }>) =>
			evaluateSettledResults({ lane: "read", attemptId: "attempt-1", results, shared: { root }, answer: { text, citations } });

		const correct = await evaluate("total=42", [{ path: "report.json", line: 2, quote: '"total": 42' }]);
		expect(correct.ok).toBe(true);
		if (!correct.ok) return;
		expect(correct.report.results[0]?.state).toBe("accepted");

		// The cited line number is a reference, not content: a typed answer with a trailing reference still decides on 42.
		const citationNumberIgnored = await evaluate("total=42 (report.json:2)", [{ path: "report.json", line: 2, quote: '"total": 42' }]);
		expect(citationNumberIgnored.ok).toBe(true);
		if (citationNumberIgnored.ok) expect(citationNumberIgnored.report.results[0]?.state).toBe("accepted");

		// Free prose that merely mentions the value and the line is no longer fast-accepted; it needs scoped review.
		const prose = await evaluate("report.json:2 shows total=42", [{ path: "report.json", line: 2, quote: '"total": 42' }]);
		expect(prose.ok).toBe(true);
		if (prose.ok) expect(prose.report.results[0]?.state).toBe("reviewable");

		for (const wrong of ["7", "142", "14", "-42", "total=7"]) {
			const contradictory = await evaluate(wrong, [{ path: "report.json", line: 2, quote: '"total": 42' }]);
			expect(contradictory.ok).toBe(true);
			if (contradictory.ok) expect(contradictory.report.results[0]?.state).toBe("unmet");
		}
		// Prose with other numbers is neither contradicted nor accepted: it goes to review.
		for (const text of ["7 and 42", "42, measured over 3 runs in 120 ms"]) {
			const prose = await evaluate(text, [{ path: "report.json", line: 2, quote: '"total": 42' }]);
			expect(prose.ok).toBe(true);
			if (prose.ok) expect(prose.report.results[0]?.state).toBe("reviewable");
		}

		const otherLine = await evaluate("42", [{ path: "report.json", line: 3 }]);
		expect(otherLine.ok).toBe(true);
		if (otherLine.ok) {
			expect(otherLine.report.results[0]?.state).toBe("unmet");
			expect(otherLine.report.results[0]?.reason).toContain("인용한 위치");
		}

		const wrongPath = await evaluate("42", [{ path: "other.json", line: 2, quote: '"total": 42' }]);
		expect(wrongPath.ok).toBe(true);
		if (wrongPath.ok) expect(wrongPath.report.results[0]?.state).toBe("unmet");
	});

	test("a value that differs only by case is never support", async () => {
		const root = await tempRoot("answer-case");
		await put(root, "model.md", "model: qwen3-32b\n");
		const model = (extra: Partial<PlanLaneResult> = {}): PlanLaneResult => ({ id: "model", kind: "answer", criterion: "states the model id", path: "model.md", ...extra });
		const evaluate = (candidate: PlanLaneResult, text: string) =>
			evaluateSettledResults({ lane: "read", attemptId: "attempt-1", results: [candidate], shared: { root }, answer: { text, citations: [{ path: "model.md", line: 1 }] } });

		for (const text of ["Qwen3-32B", "model: Qwen3-32B", "the model is Qwen3-32B"]) {
			for (const candidate of [model({ contains: undefined }), model({ contains: "qwen3-32b" })]) {
				const out = await evaluate(candidate, text);
				expect(out.ok).toBe(true);
				if (out.ok) expect(out.report.results[0]?.state).toBe("reviewable");
			}
		}

		// The exact cited text is intact: same case, or whitespace alone.
		for (const text of ["model: qwen3-32b", "model:\t  qwen3-32b", "model: qwen3-32b."]) {
			for (const candidate of [model({ contains: undefined }), model({ contains: "qwen3-32b" })]) {
				const out = await evaluate(candidate, text);
				expect(out.ok).toBe(true);
				if (out.ok) expect(out.report.results[0]?.state).toBe("accepted");
			}
		}

		await put(root, "model.md", "qwen3-32b\n");
		const exact = await evaluate(model({ contains: undefined }), "qwen3-32b");
		expect(exact.ok).toBe(true);
		if (exact.ok) expect(exact.report.results[0]?.state).toBe("accepted");
		const cased = await evaluate(model({ contains: undefined }), "Qwen3-32B");
		expect(cased.ok).toBe(true);
		if (cased.ok) expect(cased.report.results[0]?.state).toBe("reviewable");
		const declared = await evaluate(model({ contains: "qwen3-32b" }), "Qwen3-32B");
		expect(declared.ok).toBe(true);
		if (declared.ok) expect(declared.report.results[0]?.state).toBe("reviewable");
	});

	test("a factual answer aligned with its cited line is accepted without contains; ambiguity and false sources stay reviewable", async () => {
		const root = await rootWithReport();
		const results = [answer({ contains: undefined })];
		const evaluate = (text: string, citations: Array<{ path: string; line?: number; quote?: string }>) =>
			evaluateSettledResults({ lane: "read", attemptId: "attempt-1", results, shared: { root }, answer: { text, citations } });

		const aligned = await evaluate("42", [{ path: "report.json", line: 2 }]);
		expect(aligned.ok).toBe(true);
		if (!aligned.ok) return;
		expect(aligned.report.results[0]).toMatchObject({ state: "accepted", citation: { path: "report.json", line: 2 } });
		expect(aligned.report.results[0]?.citation?.digest).toBeDefined();
		expect(aligned.report.results[0]?.contentVersion).toBeDefined();

		const ambiguous = await evaluate("I am not sure", [{ path: "report.json", line: 2 }]);
		expect(ambiguous.ok).toBe(true);
		if (ambiguous.ok) expect(ambiguous.report.results[0]?.state).toBe("reviewable");

		const falseSource = await evaluate("7", [{ path: "report.json", line: 2 }]);
		expect(falseSource.ok).toBe(true);
		if (falseSource.ok) expect(falseSource.report.results[0]?.state).toBe("reviewable");

		const pathOnly = await evaluate("42", [{ path: "report.json" }]);
		expect(pathOnly.ok).toBe(true);
		if (pathOnly.ok) expect(pathOnly.report.results[0]?.state).toBe("reviewable");
	});
});

describe("retained artifact evidence", () => {
	test("only a host-bound source outside the parent can satisfy an artifact result", async () => {
		const root = await tempRoot("artifact-parent");
		await put(root, "experiment.txt", "experiment change");
		const results: PlanLaneResult[] = [{ id: "experiment", kind: "artifact", criterion: "retained patch carries the experiment", path: "experiment.txt", contains: "experiment change" }];

		const missing = await evaluateSettledResults({ lane: "compare", attemptId: "attempt-1", results, shared: { root }, artifactMode: "isolated" });
		expect(missing.ok).toBe(true);
		if (missing.ok) {
			expect(missing.report.results[0]?.state).toBe("unmet");
			expect(missing.report.results[0]?.reason).toContain("결속된 보존 산출물");
		}

		await put(root, "inside-artifact/experiment.txt", "experiment change");
		const inside = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-1",
			results,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: path.join(root, "inside-artifact"), form: "directory" },
		});
		expect(inside.ok).toBe(false);
		if (!inside.ok) expect(inside.reason).toContain("부모 작업 트리");

		const artifact = await tempRoot("artifact-retained");
		await put(artifact, "experiment.txt", "experiment change");
		const accepted = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-1",
			results,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: artifact, form: "directory" },
		});
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.report.results[0]).toMatchObject({ state: "accepted", artifact: "directory" });
		expect(accepted.report.results[0]?.digest).toBeDefined();

		const prose: PlanLaneResult[] = [{ id: "prose", kind: "artifact", criterion: "the artifact reads well" }];
		const proseEval = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-1",
			results: prose,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: artifact, form: "directory" },
		});
		expect(proseEval.ok).toBe(true);
		if (proseEval.ok) expect(proseEval.report.results[0]?.state).toBe("reviewable");

		await put(artifact, "experiment.txt", "a different experiment");
		const different = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-1",
			results,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: artifact, form: "directory" },
		});
		expect(different.ok).toBe(true);
		if (different.ok) expect(different.report.results[0]?.state).toBe("unmet");

		const wrongAttempt = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-2",
			results,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: artifact, form: "directory" },
		});
		expect(wrongAttempt.ok).toBe(false);
	});

	test("a unified patch is evidence only through added content for the declared path", async () => {
		const root = await tempRoot("artifact-patch");
		const patchDir = await tempRoot("artifact-patch-file");
		const patch = path.join(patchDir, "result.patch");
		const results: PlanLaneResult[] = [{ id: "experiment", kind: "artifact", criterion: "patch adds the experiment", path: "experiment.txt", contains: "experiment change" }];
		const patchOf = (added: string, removed = "old") =>
			`diff --git a/experiment.txt b/experiment.txt\nindex 1111111..2222222 100644\n--- a/experiment.txt\n+++ b/experiment.txt\n@@ -1 +1 @@\n-${removed}\n+${added}\n`;
		const evaluate = (source: { path: string; expectedDigest?: string }, declared = results) =>
			evaluateSettledResults({
				lane: "compare",
				attemptId: "attempt-1",
				results: declared,
				shared: { root },
				artifactMode: "isolated",
				artifact: { attemptId: "attempt-1", path: source.path, form: "patch", ...(source.expectedDigest === undefined ? {} : { expectedDigest: source.expectedDigest }) },
			});

		await fs.writeFile(patch, patchOf("experiment change"));
		const accepted = await evaluate({ path: patch });
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.report.results[0]).toMatchObject({ state: "accepted", artifact: "patch" });

		await fs.writeFile(patch, patchOf("other", "experiment change"));
		const removedOnly = await evaluate({ path: patch });
		expect(removedOnly.ok).toBe(true);
		if (removedOnly.ok) {
			expect(removedOnly.report.results[0]?.state).toBe("unmet");
			expect(removedOnly.report.results[0]?.reason).toContain("추가 내용");
		}

		await fs.writeFile(patch, patchOf("experiment change"));
		const wrongPath = await evaluate({ path: patch }, [{ ...results[0]!, path: "other.txt" }]);
		expect(wrongPath.ok).toBe(true);
		if (wrongPath.ok) expect(wrongPath.report.results[0]?.state).toBe("unmet");

		const wrongDigest = await evaluate({ path: patch, expectedDigest: "0".repeat(64) });
		expect(wrongDigest.ok).toBe(true);
		if (wrongDigest.ok) {
			expect(wrongDigest.report.results[0]?.state).toBe("unmet");
			expect(wrongDigest.report.results[0]?.reason).toContain("다이제스트");
		}
	});

	test("a shared artifact uses its own pre/post baseline and never a retained fallback", async () => {
		const root = await tempRoot("artifact-shared");
		await put(root, "report.md", "before");
		const results: PlanLaneResult[] = [{ id: "report", kind: "artifact", criterion: "report names the accepted result", path: "report.md", contains: "result: accepted" }];
		const withoutMode = await captureSharedBaseline({ lane: "compare", root, results });
		expect(withoutMode.ok).toBe(false);
		if (!withoutMode.ok) expect(withoutMode.reason).toContain("산출물 모드");
		const baseline = await baselineOf(root, results, "compare", { artifactMode: "shared" });
		expect(baseline.entries.map(entry => entry.path)).toEqual(["report.md"]);

		const noBaseline = await evaluateSettledResults({ lane: "compare", attemptId: "attempt-1", results, shared: { root }, artifactMode: "shared" });
		expect(noBaseline.ok).toBe(true);
		if (noBaseline.ok) expect(noBaseline.report.results[0]?.state).toBe("unmet");

		await put(root, "report.md", "result: accepted");
		const accepted = await evaluateSettledResults({ lane: "compare", attemptId: "attempt-1", results, shared: { root, baseline }, artifactMode: "shared" });
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.report.results[0]).toMatchObject({ kind: "artifact", state: "accepted", path: "report.md" });
		expect(accepted.report.results[0]?.artifact).toBeUndefined();

		const missingMode = await evaluateSettledResults({ lane: "compare", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(missingMode.ok).toBe(false);
		if (!missingMode.ok) expect(missingMode.reason).toContain("산출물 모드");
	});
});

describe("containment and input rejection", () => {
	test("symlinked shared or artifact files are never followed", async () => {
		const root = await tempRoot("symlink-root");
		const outside = await tempRoot("symlink-outside");
		await put(outside, "secret.txt", "secret marker");
		await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
		const results = [change("link", "link.txt", { contains: "secret marker" })];
		const baseline = await baselineOf(root, results);
		expect(baseline.entries[0]).toMatchObject({ state: "unsafe", detail: "symbolic-link" });
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(evaluated.ok).toBe(true);
		if (evaluated.ok) {
			expect(evaluated.report.results[0]?.state).toBe("unmet");
			expect(evaluated.report.results[0]?.reason).toContain("symbolic-link");
		}

		const artifact = await tempRoot("symlink-artifact");
		await fs.symlink(path.join(outside, "secret.txt"), path.join(artifact, "experiment.txt"));
		const artifactResults: PlanLaneResult[] = [{ id: "experiment", kind: "artifact", criterion: "artifact", path: "experiment.txt", contains: "secret marker" }];
		const artifactEval = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-1",
			results: artifactResults,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: artifact, form: "directory" },
		});
		expect(artifactEval.ok).toBe(true);
		if (artifactEval.ok) expect(artifactEval.report.results[0]?.state).toBe("unmet");
	});

	test("the result wire rejects escapes, state paths, commands and unknown fields", () => {
		const base = { id: "x", kind: "change" as const, criterion: "c" };
		for (const bad of ["../x", "/etc/passwd", "a/.git/config", "a/.omp/state", "a\\b", "a//b", ""]) {
			expect(parseLaneResults([{ ...base, path: bad }]).ok).toBe(false);
		}
		expect(parseLaneResults([{ ...base, path: "a.txt", command: "rm -rf /" }]).ok).toBe(false);
		expect(parseLaneResults([base, base]).ok).toBe(false);
		expect(parseLaneResults([{ id: "a", kind: "artifact", criterion: "c", path: "a", check: "unit" }]).ok).toBe(false);
		expect(parseLaneResults([{ id: "a", kind: "answer", criterion: "c", check: "unit" }]).ok).toBe(false);
		expect(parseLaneResults([{ id: "a", kind: "answer", criterion: "c", path: "../x" }]).ok).toBe(false);
		expect(parseLaneResults(undefined).ok).toBe(true);
	});
});

describe("bounded reads", () => {
	test("a marker beyond the byte bound is reviewable, never accepted; a marker inside it is accepted", async () => {
		const root = await tempRoot("bounded");
		const results = [change("big", "big.txt", { contains: "needle" })];
		const baseline = await baselineOf(root, results);
		await put(root, "big.txt", `${"x".repeat(20)}needle`);
		const beyond = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline }, limits: { fileBytes: 8 } });
		expect(beyond.ok).toBe(true);
		if (beyond.ok) {
			expect(beyond.report.results[0]?.state).toBe("reviewable");
			expect(beyond.report.results[0]?.reason).toContain("읽기 한도");
		}

		const root2 = await tempRoot("bounded-prefix");
		const baseline2 = await baselineOf(root2, results);
		await put(root2, "big.txt", `needle${"x".repeat(20)}`);
		const prefix = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root: root2, baseline: baseline2 }, limits: { fileBytes: 8 } });
		expect(prefix.ok).toBe(true);
		if (prefix.ok) expect(prefix.report.results[0]?.state).toBe("accepted");
	});

	test("capture fails rather than certifying a partial baseline past the total byte bound", async () => {
		const root = await tempRoot("bounded-capture");
		await put(root, "a.txt", "abcdefgh");
		await put(root, "b.txt", "ijklmnop");
		const captured = await captureSharedBaseline({
			lane: "api",
			root,
			results: [change("a", "a.txt"), change("b", "b.txt")],
			limits: { totalBytes: 4 },
		});
		expect(captured.ok).toBe(false);
		if (!captured.ok) expect(captured.reason).toContain("바이트 한도");
	});
});

describe("approved check evidence", () => {
	test("a configured check is accepted only from the approved config, the same tree and a pass, and is never executed here", async () => {
		const root = await tempRoot("checks");
		const marker = path.join(root, "check-ran");
		const config: StormConfig = {
			...TEAM,
			requiredChecks: [
				{ name: "unit", argv: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] },
			],
		};
		const hash = configHash(config);
		const loaded: ConfigLoad = { status: "ok", path: path.join(root, "config.json"), config, hash, warnings: [] };
		const approval: ApprovalRecord = approvalRecord(hash, { approvedAt: "2026-01-01T00:00:00.000Z" });
		const unitArgv = config.requiredChecks?.[0]?.argv ?? [];
		const results: PlanLaneResult[] = [{ id: "fix", kind: "change", criterion: "app is fixed", path: "app.txt", contains: "fixed", check: "unit" }];
		const deployResults: PlanLaneResult[] = [{ ...results[0]!, check: "deploy" }];
		const deployConfig: StormConfig = { ...config, requiredChecks: [{ name: "deploy", argv: ["true"] }] };
		const baseline = await baselineOf(root, results, "api", { config });
		const deployBaseline = await baselineOf(root, deployResults, "api", { config: deployConfig });
		await put(root, "app.txt", "fixed");
		const unitReport = (status: CheckStatus, fingerprint = "tree-1") => reportFor(hash, [{ name: "unit", status, argv: unitArgv }], fingerprint);
		const evaluate = (checks: ApprovedCheckEvidence) =>
			evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline }, checks });

		const accepted = await evaluate({ config: loaded, approval, report: unitReport("passed"), treeFingerprint: "tree-1" });
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(accepted.report.results[0]).toMatchObject({ state: "accepted", check: { name: "unit", status: "passed", configHash: hash, tree: "tree-1" } });
		expect(await fs.stat(marker).catch(() => undefined)).toBeUndefined();

		const unapproved = await evaluate({ config: loaded, approval: undefined, report: unitReport("passed"), treeFingerprint: "tree-1" });
		expect(unapproved.ok).toBe(true);
		if (unapproved.ok) expect(unapproved.report.results[0]?.reason).toContain("승인되지");

		const otherTree = await evaluate({ config: loaded, approval, report: unitReport("passed", "tree-2"), treeFingerprint: "tree-1" });
		expect(otherTree.ok).toBe(true);
		if (otherTree.ok) expect(otherTree.report.results[0]?.reason).toContain("다른 트리");

		const notConfigured = await evaluateSettledResults({
			lane: "api",
			attemptId: "attempt-1",
			results: deployResults,
			shared: { root, baseline: deployBaseline },
			config: deployConfig,
			checks: { config: loaded, approval, report: reportFor(hash, [{ name: "deploy", status: "passed" }]), treeFingerprint: "tree-1" },
		});
		expect(notConfigured.ok).toBe(true);
		if (notConfigured.ok) expect(notConfigured.report.results[0]?.reason).toContain("없습니다");

		const failed = await evaluate({ config: loaded, approval, report: unitReport("failed"), treeFingerprint: "tree-1" });
		expect(failed.ok).toBe(true);
		if (failed.ok) expect(failed.report.results[0]?.reason).toContain("통과하지");

		const otherHash = await evaluate({ config: loaded, approval, report: reportFor(`jcs-sha256:${"0".repeat(64)}`, [{ name: "unit", status: "passed", argv: unitArgv }]), treeFingerprint: "tree-1" });
		expect(otherHash.ok).toBe(true);
		if (otherHash.ok) expect(otherHash.report.results[0]?.reason).toContain("다른 설정");

		const noReport = await evaluate({ config: loaded, approval, report: undefined, treeFingerprint: "tree-1" });
		expect(noReport.ok).toBe(true);
		if (noReport.ok) expect(noReport.report.results[0]?.reason).toContain("실행 근거");

		const wrongArgv = await evaluate({ config: loaded, approval, report: reportFor(hash, [{ name: "unit", status: "passed", argv: ["different"] }]), treeFingerprint: "tree-1" });
		expect(wrongArgv.ok).toBe(true);
		if (wrongArgv.ok) expect(wrongArgv.report.results[0]?.reason).toContain("argv");

		const artifact = await tempRoot("checks-artifact");
		await put(artifact, "experiment.txt", "experiment change");
		const artifactResults: PlanLaneResult[] = [
			{ id: "experiment", kind: "artifact", criterion: "artifact carries the experiment", path: "experiment.txt", contains: "experiment change", check: "unit" },
		];
		const artifactEval = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-1",
			results: artifactResults,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: artifact, form: "directory" },
			checks: { config: loaded, approval, report: unitReport("passed"), treeFingerprint: "tree-1" },
		});
		expect(artifactEval.ok).toBe(true);
		if (!artifactEval.ok) return;
		expect(artifactEval.report.results[0]).toMatchObject({ state: "accepted", check: { name: "unit", status: "passed" } });

		const artifactFailed = await evaluateSettledResults({
			lane: "compare",
			attemptId: "attempt-1",
			results: artifactResults,
			shared: { root },
			artifactMode: "isolated",
			artifact: { attemptId: "attempt-1", path: artifact, form: "directory" },
			checks: { config: loaded, approval, report: unitReport("failed"), treeFingerprint: "tree-1" },
		});
		expect(artifactFailed.ok).toBe(true);
		if (artifactFailed.ok) expect(artifactFailed.report.results[0]?.reason).toContain("통과하지");
	});
});

describe("immutable identity and digests", () => {
	test("identity and manifest/report digests are stable and contract-bound", async () => {
		const root = await tempRoot("digest");
		await put(root, "report.json", '{"total": 42}\n');
		const results: PlanLaneResult[] = [change("report", "report.json", { contains: '"total": 42' })];
		const first = await baselineOf(root, results);
		const second = await baselineOf(root, results);
		expect(first.digest).toBe(second.digest);
		expect(first.digest).toBe(resultBaselineDigest(first));

		const identity = resultContractIdentity(results[0]!);
		expect(identity).toBe(resultContractIdentity({ ...results[0]! }));
		expect(identity).not.toBe(resultContractIdentity({ ...results[0]!, id: "other" }));
		expect(identity).not.toBe(resultContractIdentity({ ...results[0]!, contains: "other" }));

		const one = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline: first } });
		const two = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline: second } });
		expect(one.ok && two.ok).toBe(true);
		if (!one.ok || !two.ok) return;
		expect(one.report.digest).toBe(two.report.digest);
		expect(one.report.digest).toBe(resultEvidenceDigest(one.report));
		expect(one.report.results[0]?.identity).toBe(identity);

		const tampered = {
			...first,
			entries: first.entries.map(entry => ({ ...entry, digest: "0".repeat(64) })),
		};
		const rejected = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results, shared: { root, baseline: tampered } });
		expect(rejected.ok).toBe(false);
	});

	test("a changed contract invalidates the old baseline instead of silently reusing it", async () => {
		const root = await tempRoot("contract-change");
		await put(root, "report.json", '{"total": 42, "note": "changed"}\n');
		const before: PlanLaneResult[] = [change("report", "report.json", { contains: '"total": 42' })];
		const baseline = await baselineOf(root, before);
		const after: PlanLaneResult[] = [change("report", "report.json", { contains: '"note": "changed"' })];
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-1", results: after, shared: { root, baseline } });
		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		expect(evaluated.report.results[0]?.state).toBe("unmet");
		expect(evaluated.report.results[0]?.reason).toContain("사전 기준선과 달라졌습니다");
	});

	test("an exact contract reassigned to another lane keeps the obligation and its baseline", async () => {
		const root = await tempRoot("reassigned");
		const results: PlanLaneResult[] = [change("report", "report.json", { contains: '"total": 42' })];
		const baseline = await baselineOf(root, results, "api");
		await put(root, "report.json", '{"total": 42, "worker": true}\n');
		const evaluated = await evaluateSettledResults({ lane: "view", attemptId: "attempt-1", results, shared: { root, baseline } });
		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		expect(evaluated.report.lane).toBe("view");
		expect(evaluated.report.results[0]).toMatchObject({ state: "accepted", identity: resultContractIdentity(results[0]!) });
		const laterAttempt = await evaluateSettledResults({ lane: "view", attemptId: "attempt-2", results, shared: { root, baseline } });
		expect(laterAttempt.ok).toBe(true);
		if (!laterAttempt.ok) return;
		expect(laterAttempt.report.results[0]?.contentVersion).toBe(evaluated.report.results[0]?.contentVersion);
		expect(laterAttempt.report.digest).not.toBe(evaluated.report.digest);
		expect(await captureSharedBaseline({ lane: "api", root, results }).then(captured => captured.ok && captured.baseline.digest)).toBe(
			await captureSharedBaseline({ lane: "view", root, results }).then(captured => captured.ok && captured.baseline.digest),
		);
	});

	test("a baseline bound to another attempt is rejected outright", async () => {
		const root = await tempRoot("attempt-binding");
		const results: PlanLaneResult[] = [change("write", "file.txt")];
		const captured = await captureSharedBaseline({ lane: "api", root, results, attemptId: "attempt-1" });
		expect(captured.ok).toBe(true);
		if (!captured.ok) return;
		const evaluated = await evaluateSettledResults({ lane: "api", attemptId: "attempt-2", results, shared: { root, baseline: captured.baseline } });
		expect(evaluated.ok).toBe(false);
		if (!evaluated.ok) expect(evaluated.reason).toContain("다른 시도");
	});
});
