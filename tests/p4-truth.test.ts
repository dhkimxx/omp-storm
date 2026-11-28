/**
 * P4: what 0.29.0 says after the real-host probe (integration design §5).
 *
 * - a bare "no changes" names the parent-tree check that saw none, never the whole tree;
 * - a worker's change counter is not offered as a tree claim; only a positively placed parent-tree result may be called
 *   a shared-tree change, and anything the record cannot place says unknown and points at the native record;
 * - a zero-byte root patch is confirmed empty only with a complete, empty companion list; a nested-only capture is not
 *   empty and a missing list is unknown, never empty;
 * - a stopped or failed worker's unbound patch or branch says capture unknown and names its native delivery;
 * - an accepted retained artifact's judged source is outside the parent, in every form, and that proves neither absence
 *   there nor an unchanged tree;
 * - a known plan-less placement carries the placement and cleanup qualification;
 * - every added fact is a count or a fixed line, so a hundred workers change no shape (D11).
 */
import { describe, expect, test } from "bun:test";
import {
	attemptAgentId,
	syncAttemptReport,
	type AttemptSubject,
	type HostArtifactCapture,
	type SyncTaskCapture,
} from "../src/runtime/attempt-report.ts";
import {
	CAPTURE_UNKNOWN_HANDOFF,
	CAPTURE_UNKNOWN_LABEL,
	closeoutBrief,
	closeoutHandoff,
	CLOSEOUT_HANDOFF_MAX_BYTES,
	RETAINED_ABSENCE_HANDOFF,
	RETAINED_OUTSIDE_COUNT,
	RETAINED_OUTSIDE_HANDOFF,
	SHARED_CHANGE_RISK,
	UNKNOWN_CHANGE_RISK,
} from "../src/runtime/closeout.ts";
import {
	CHECKOUT_CLEANUP_NOTE,
	CHECKOUT_PLACEMENT_NOTE,
	ISOLATED_ARTIFACT_RULE,
	ISOLATED_CHANGE_RULE,
	laneContractText,
	PLANLESS_PLACEMENT_NOTE,
	RETAINED_SOURCE_NOTE,
} from "../src/runtime/contract-text.ts";
import {
	END_LABEL,
	NO_PARENT_CHANGE_HANDOFF,
	NO_PARENT_CHANGE_LABEL,
	endLabel,
} from "../src/runtime/rounds.ts";
import {
	TREE_CHANGE_LABEL,
	WORKER_CHANGE_LABEL,
	changeAttribution,
	resultFacts,
} from "../src/runtime/result-facts.ts";
import type { PlanLane, RunPlan, RunRecord, RunResult, StatusView } from "../src/types.ts";
import { renderCloseout } from "../src/view/closeout.ts";
import { RETAINED_STATE_WORD, layout } from "../src/view/lane/layout.ts";
import type { LaneSnapshot } from "../src/view/lane/model.ts";
import { liveMetricFacts } from "../src/view/live-metrics.ts";
import {
	captureUnknownLine,
	planlessPlacementNote,
	retainedSourceLine,
	renderStatus,
	renderStatusBrief,
	resumeRunLine,
	runStatusText,
} from "../src/view/render.ts";
import { RETAINED_ACCEPTED, RETAINED_LABEL } from "../src/view/results.ts";
import { agentEntry, runRecord, spawnRecord } from "./fixtures.ts";

const START = "2026-11-20T09:00:00.000Z";
const END = "2026-11-20T09:04:00.000Z";
const NOW = Date.parse("2026-11-20T09:30:00Z");
const DIGEST = "a".repeat(64);

const planOf = (...lanes: PlanLane[]): RunPlan => ({ lanes, workers: {}, submittedAt: START });
const lane = (name: string, extra: Partial<PlanLane> = {}): PlanLane => ({ name, kind: "code", role: "implementer", ...extra });
const changeResult = (id: string): NonNullable<PlanLane["results"]>[number] => ({ id, kind: "change", criterion: id, path: "a.ts" });
const artifactResult = (id: string): NonNullable<PlanLane["results"]>[number] => ({ id, kind: "artifact", criterion: id, path: "out.txt" });
const acceptedChange = (id: string, laneName: string, agent: string): RunResult => ({
	id,
	lane: laneName,
	state: "accepted",
	attemptId: `job:J:${agent}`,
	contract: changeResult(id),
});
const stopped = (over: Partial<RunRecord> = {}): RunRecord =>
	runRecord({ status: "stopped", endReason: "interrupted", endedAt: END, ...over });

describe("a no-change end names the check, not the tree (§5)", () => {
	test("the label and every history line carry Storm's parent-tree before/after read", () => {
		expect(END_LABEL["no-changes"]).toBe(NO_PARENT_CHANGE_LABEL);
		expect(NO_PARENT_CHANGE_LABEL).toContain("부모");
		expect(NO_PARENT_CHANGE_LABEL).toContain("전후");
		expect(NO_PARENT_CHANGE_LABEL).not.toBe("변경 없음");
		expect(NO_PARENT_CHANGE_HANDOFF).not.toBe("no-changes");
		const run = runRecord({ status: "ended", endReason: "no-changes", endedAt: END });
		expect(closeoutBrief(run).official.label).toContain(NO_PARENT_CHANGE_LABEL);
		expect(resumeRunLine(run)).toContain(NO_PARENT_CHANGE_LABEL);
		const handoff = closeoutHandoff(run);
		expect(handoff).toContain(NO_PARENT_CHANGE_HANDOFF);
		// The stored code is not repeated as if it described the whole tree.
		expect(handoff).not.toContain("(no-changes)");
		expect(endLabel("no-changes")).toBe(NO_PARENT_CHANGE_LABEL);
	});
});

describe("worker changes are not a tree claim (§5)", () => {
	test("a plan-less worker is unclassified, and the chip says it recorded changes rather than a tree change", () => {
		const run = runRecord({
			status: "running",
			spawns: [spawnRecord({ spawnKey: "w1" })],
			agents: [agentEntry({ id: "w1", changes: 2 })],
		});
		expect(changeAttribution(run)).toEqual({ shared: 0, outside: 0, unknown: 1 });
		expect(resultFacts(run).changes).toEqual({ shared: 0, outside: 0, unknown: 1 });
		const chip = liveMetricFacts(run, "working", NOW).chips.find(item => item.key === "results");
		const shown = chip?.forms.map(form => `${form.value}${form.suffix ?? ""}`).join("\n") ?? "";
		expect(shown).toContain(`${WORKER_CHANGE_LABEL} 1`);
		expect(shown).not.toContain(TREE_CHANGE_LABEL);
		// A tree count is only the caller's own read of the tree.
		const read = liveMetricFacts(run, "working", NOW, { changedPaths: 3 }).chips.find(item => item.key === "results");
		const readText = read?.forms.map(form => `${form.value}${form.suffix ?? ""}`).join("\n") ?? "";
		expect(readText).toContain(`${TREE_CHANGE_LABEL} 3`);
		expect(readText).not.toContain(WORKER_CHANGE_LABEL);
	});

	test("an isolated lane is outside; only an accepted parent-tree result places the exact worker in the shared tree", () => {
		const outside = runRecord({
			status: "running",
			plan: planOf(lane("iso", { isolationReason: "candidate experiment", results: [artifactResult("r1")] })),
			spawns: [spawnRecord({ spawnKey: "I0", lane: "iso" })],
			agents: [agentEntry({ id: "I0", changes: 1 })],
		});
		expect(changeAttribution(outside)).toEqual({ shared: 0, outside: 1, unknown: 0 });
		const shared = runRecord({
			plan: planOf(lane("work", { results: [changeResult("r1")] })),
			spawns: [spawnRecord({ spawnKey: "w1", lane: "work" })],
			agents: [agentEntry({ id: "w1", changes: 1 })],
			results: [acceptedChange("r1", "work", "w1")],
		});
		expect(changeAttribution(shared)).toEqual({ shared: 1, outside: 0, unknown: 0 });
		// The same accepted row names another worker, so this one is not credited with it.
		const other = { ...shared, agents: [agentEntry({ id: "w2", changes: 1 })] };
		expect(changeAttribution(other)).toEqual({ shared: 0, outside: 0, unknown: 1 });
	});

	test("the closeout residual states a shared-tree risk only for a positively placed write", () => {
		const unknown = closeoutBrief(stopped({ spawns: [spawnRecord({ spawnKey: "w1" })], agents: [agentEntry({ id: "w1", changes: 1 })] })).residual.join("\n");
		expect(unknown).toContain(UNKNOWN_CHANGE_RISK);
		expect(unknown).not.toContain(SHARED_CHANGE_RISK);
		const shared = closeoutBrief(
			stopped({
				plan: planOf(lane("work", { results: [changeResult("r1")] })),
				spawns: [spawnRecord({ spawnKey: "w1", lane: "work" })],
				results: [acceptedChange("r1", "work", "w1")],
				agents: [agentEntry({ id: "w1", changes: 1 })],
			}),
		).residual.join("\n");
		expect(shared).toContain(SHARED_CHANGE_RISK);
		const outside = closeoutBrief(
			stopped({
				plan: planOf(lane("iso", { isolationReason: "candidate experiment" })),
				spawns: [spawnRecord({ spawnKey: "I0", lane: "iso" })],
				agents: [agentEntry({ id: "I0", changes: 1 })],
			}),
		).residual.join("\n");
		expect(outside).not.toContain(SHARED_CHANGE_RISK);
		expect(outside).not.toContain(UNKNOWN_CHANGE_RISK);
	});
});

describe("a plan-less placement carries the placement and cleanup qualification (§5)", () => {
	const run = stopped({ spawns: [spawnRecord({ spawnKey: "w1" })] });

	test("the card keeps it, and the fact is one fixed line", () => {
		const brief = closeoutBrief(run);
		const card = renderCloseout(brief, false).markdown;
		expect(card).toContain(CHECKOUT_PLACEMENT_NOTE);
		expect(card).toContain(CHECKOUT_CLEANUP_NOTE);
		expect(card).toContain(PLANLESS_PLACEMENT_NOTE);
		expect(planlessPlacementNote(resultFacts(run))).toContain(CHECKOUT_CLEANUP_NOTE);
	});

	test("the status carries it, and a run with no plan-less placement carries none", () => {
		const view = (lastRun: RunRecord): StatusView => ({ config: { status: "missing", path: "/repo/.omp/storm/config.json" }, approval: undefined, shadows: [], lastRun });
		const status = renderStatus(view(run), NOW);
		expect(status).toContain(CHECKOUT_CLEANUP_NOTE);
		expect(status).toContain(PLANLESS_PLACEMENT_NOTE);
		const planned = stopped({ plan: planOf(lane("work")), spawns: [spawnRecord({ spawnKey: "w1", lane: "work" })] });
		expect(renderStatus(view(planned), NOW)).not.toContain(PLANLESS_PLACEMENT_NOTE);
		expect(planlessPlacementNote(resultFacts(planned))).toBeUndefined();
	});
});

describe("empty, missing and failed are not the same fact (§5)", () => {
	const subject = (over: Partial<AttemptSubject> = {}): AttemptSubject => ({
		runId: "run-20261128-120000-aaaa",
		parentId: "Main",
		spawnKey: "K0",
		startedAt: 1_000,
		...over,
	});
	const patch = (over: Partial<HostArtifactCapture> = {}): HostArtifactCapture => ({
		id: "K0",
		kind: "patch",
		path: "/tmp/storm/K0.patch",
		exists: true,
		bytes: 0,
		capturedAt: 1_600,
		...over,
	});

	test("a cancelled worker's positive patch stays bound recovery, and its outcome stays a cancel", () => {
		const capture: SyncTaskCapture = {
			channel: "task-result",
			toolCallId: "call_k0",
			observedAt: 1_600,
			results: [{ id: "K0", aborted: true, patchPath: "/tmp/storm/K0.patch" }],
			artifacts: [patch({ bytes: 118, digest: DIGEST })],
		};
		const report = syncAttemptReport(subject(), capture, { requirePatch: true });
		expect(report.outcome).toBe("cancel");
		expect(report.capture).toBe("observed");
		expect(report.artifacts).toEqual([
			{ kind: "patch", path: "/tmp/storm/K0.patch", bytes: 118, digest: DIGEST, capturedAt: 1_600, source: "task-result" },
		]);
		expect(attemptAgentId(report.attemptId)).toBe("K0");
		expect(attemptAgentId("task:call:K0")).toBe("K0");
		expect(attemptAgentId("job:J")).toBeUndefined();
		expect(attemptAgentId("other:J:K0")).toBeUndefined();
		expect(attemptAgentId("job:J:K 0")).toBeUndefined();
	});

	test("a zero-byte root without a companion list is unknown, never empty", () => {
		const capture: SyncTaskCapture = {
			channel: "task-result",
			toolCallId: "call_k0",
			observedAt: 1_600,
			results: [{ id: "K0", exitCode: 0, patchPath: "/tmp/storm/K0.patch" }],
			artifacts: [patch()],
		};
		const report = syncAttemptReport(subject(), capture, { requirePatch: true });
		expect(report.outcome).toBe("success");
		expect(report.captureError).toBe("patch-artifact-empty-unknown");
		expect(report.captureError).not.toBe("patch-artifact-empty");
	});

	test("a nested-only capture is not empty, and a complete empty list is the only confirmed empty", () => {
		const base = {
			channel: "task-result" as const,
			toolCallId: "call_k0",
			observedAt: 1_600,
			artifacts: [patch()],
		};
		const nested = syncAttemptReport(
			subject(),
			{
				...base,
				results: [{ id: "K0", exitCode: 0, patchPath: "/tmp/storm/K0.patch", hasRootChanges: false, nestedPatches: [{ relativePath: "nested-repo" }], nestedPatchPaths: ["/tmp/storm/K0.nested-0.patch"] }],
			},
			{ requirePatch: true },
		);
		expect(nested.captureError).toBe("patch-artifact-nested-only");
		expect(nested.captureError).not.toBe("patch-artifact-empty");
		const empty = syncAttemptReport(
			subject(),
			{
				...base,
				results: [{ id: "K0", exitCode: 0, patchPath: "/tmp/storm/K0.patch", hasRootChanges: false, nestedPatches: [], nestedPatchPaths: [] }],
			},
			{ requirePatch: true },
		);
		expect(empty.captureError).toBe("patch-artifact-empty");
		// The host claiming root changes beside an empty root patch and no companion contradicts itself.
		const contradictory = syncAttemptReport(
			subject(),
			{
				...base,
				results: [{ id: "K0", exitCode: 0, patchPath: "/tmp/storm/K0.patch", hasRootChanges: true, nestedPatches: [], nestedPatchPaths: [] }],
			},
			{ requirePatch: true },
		);
		expect(contradictory.captureError).toBe("patch-artifact-unproven");
	});

	test("a stopped or failed worker with no bound capture says so and names the native delivery", () => {
		const run = stopped({
			plan: planOf(lane("iso", { isolationReason: "candidate experiment", results: [artifactResult("r1")] })),
			spawns: [spawnRecord({ spawnKey: "K0", lane: "iso" })],
			agents: [agentEntry({ id: "K0", changes: 1, lastWorkFailed: true })],
			results: [{ id: "r1", lane: "iso", state: "unmet", attemptId: "job:J:K0", contract: artifactResult("r1") }],
		});
		const facts = resultFacts(run);
		expect(facts.captureUnknown).toEqual({ count: 1, native: "agent://K0" });
		expect(captureUnknownLine(facts)).toContain("agent://K0");
		const brief = closeoutBrief(run);
		expect(brief.captureUnknown).toEqual({ count: 1, native: "agent://K0" });
		const card = renderCloseout(brief, false).markdown;
		expect(card).toContain(CAPTURE_UNKNOWN_LABEL);
		expect(card).toContain("agent://K0");
		expect(card).not.toContain("보존할 변경이 없었습니다");
		const handoff = closeoutHandoff(run);
		expect(handoff).toContain(CAPTURE_UNKNOWN_HANDOFF);
		expect(handoff).toContain("agent://K0");
		expect(Buffer.byteLength(handoff, "utf8")).toBeLessThanOrEqual(CLOSEOUT_HANDOFF_MAX_BYTES);
		const view: StatusView = { config: { status: "missing", path: "/repo/.omp/storm/config.json" }, approval: undefined, shadows: [], lastRun: run };
		expect(renderStatus(view, NOW)).toContain(CAPTURE_UNKNOWN_LABEL);
		// A bound retained source covers only its own worker; another failed worker's capture is still unknown.
		const contract = artifactResult("r1");
		const proof: NonNullable<RunResult["proof"]> = {
			item: { id: "r1", kind: "artifact", identity: "id-r1", criterion: "candidate", attemptId: "job:J:I0", state: "accepted", path: "out.txt", artifact: "file", digest: DIGEST },
			artifact: { attemptId: "job:J:I0", path: "/tmp/storm/I0.patch", form: "patch", expectedDigest: DIGEST },
		};
		const retainedFor = (id: string) =>
			runRecord({
				status: "stopped",
				endReason: "interrupted",
				endedAt: END,
				plan: planOf(lane("iso", { isolationReason: "candidate experiment", results: [contract] })),
				spawns: [spawnRecord({ spawnKey: id, lane: "iso" })],
				agents: [agentEntry({ id, changes: 1, lastWorkFailed: true })],
				results: [{ id: "r1", lane: "iso", state: "accepted", attemptId: "job:J:I0", contract, proof }],
			});
		// The failed worker is the one whose attempt produced the retained source: recovery, not unknown.
		expect(resultFacts(retainedFor("I0")).captureUnknown).toBeUndefined();
		// Another failed worker has no bound source in this record.
		expect(resultFacts(retainedFor("K1")).captureUnknown).toEqual({ count: 1, native: "agent://K1" });
	});
});

describe("the judged source of a retained acceptance is outside the parent (§5)", () => {
	const contract = artifactResult("r1");
	const proof: NonNullable<RunResult["proof"]> = {
		item: { id: "r1", kind: "artifact", identity: "id-r1", criterion: "candidate", attemptId: "job:J:I0", state: "accepted", path: "out.txt", artifact: "file", digest: DIGEST },
		artifact: { attemptId: "job:J:I0", path: "/tmp/storm/I0.patch", form: "patch", expectedDigest: DIGEST },
	};
	const run = runRecord({
		status: "done",
		endReason: "verified",
		endedAt: END,
		plan: planOf(lane("iso", { isolationReason: "candidate experiment", results: [contract] })),
		results: [{ id: "r1", lane: "iso", state: "accepted", attemptId: "job:J:I0", contract, proof }],
		agents: [agentEntry({ id: "I0", changes: 1 })],
	});

	test("every chip form, the card and the status say it; the handoff says what it does not prove", () => {
		const chip = liveMetricFacts(run, "verifying", NOW).chips.find(item => item.key === "results");
		expect(chip).toBeDefined();
		for (const form of chip?.forms ?? []) expect(`${form.value}${form.suffix ?? ""}`).toContain(RETAINED_LABEL);
		const brief = closeoutBrief(run);
		const card = renderCloseout(brief, false).markdown;
		expect(card).toContain(RETAINED_LABEL);
		expect(card).toContain(RETAINED_SOURCE_NOTE);
		expect(card).toContain("Storm은 적용하지 않았습니다");
		expect(retainedSourceLine(resultFacts(run))).toContain(RETAINED_SOURCE_NOTE);
		expect(runStatusText(run, NOW)).toContain(RETAINED_ACCEPTED);
		expect(renderStatus({ config: { status: "missing", path: "/repo/.omp/storm/config.json" }, approval: undefined, shadows: [], lastRun: run }, NOW)).toContain(RETAINED_SOURCE_NOTE);
		expect(renderStatusBrief({ config: { status: "missing", path: "/repo/.omp/storm/config.json" }, approval: undefined, shadows: [], lastRun: run }, NOW)).toContain(RETAINED_ACCEPTED);
		const handoff = closeoutHandoff(run);
		expect(handoff).toContain(RETAINED_OUTSIDE_COUNT);
		expect(handoff).toContain(RETAINED_OUTSIDE_HANDOFF);
		expect(handoff).toContain(RETAINED_ABSENCE_HANDOFF);
		expect(Buffer.byteLength(handoff, "utf8")).toBeLessThanOrEqual(CLOSEOUT_HANDOFF_MAX_BYTES);
		// A bound retained source is recovery evidence: the record does not also call its capture unknown.
		expect(resultFacts(run).captureUnknown).toBeUndefined();
	});

	test("the lane and timeline word says the source is outside the parent", () => {
		const snapshot: LaneSnapshot = {
			now: 60_000,
			phases: [{ from: 0, phase: "verifying" }],
			rounds: [0],
			lanes: [{ name: "iso", label: "구현", dependsOn: [], spans: [{ from: 0, to: 30_000, state: "running" }, { from: 30_000, state: "accepted" }], retained: true }],
			complete: false,
		};
		const scene = layout(snapshot, 100, 12);
		const label = scene.labels.find(item => item.side === "right" && item.lane === 0);
		expect(label?.text).toBe(RETAINED_STATE_WORD);
		expect(RETAINED_STATE_WORD).toContain("부모");
	});

	test("the contract names the shared-lane route and never the artifact workaround for a target change", () => {
		const isolatedChange = laneContractText(lane("L", { results: [{ id: "r", kind: "change", criterion: "c", path: "a.ts" }] }), { isolated: true }) as string;
		expect(isolatedChange).toContain(ISOLATED_CHANGE_RULE);
		expect(ISOLATED_CHANGE_RULE).toContain("공유 레인");
		expect(ISOLATED_CHANGE_RULE).not.toContain("결과는 artifact로 선언하세요");
		const isolatedArtifact = laneContractText(lane("L", { results: [artifactResult("a")] }), { isolated: true }) as string;
		expect(isolatedArtifact).toContain(ISOLATED_ARTIFACT_RULE);
		expect(isolatedArtifact).toContain(RETAINED_SOURCE_NOTE);
	});
});

describe("a hundred workers change no shape (D11)", () => {
	test("a hundred unclassified changed workers stay one count and one line", () => {
		const spawns = Array.from({ length: 100 }, (_, index) => spawnRecord({ spawnKey: `w${index}` }));
		const agents = spawns.map(spawn => agentEntry({ id: spawn.spawnKey!, changes: 1 }));
		const run = stopped({ spawns, agents });
		const facts = resultFacts(run);
		expect(facts.changes).toEqual({ shared: 0, outside: 0, unknown: 100 });
		expect(facts.captureUnknown).toBeUndefined();
		const brief = closeoutBrief(run);
		expect(brief.residual).toHaveLength(2);
		const unknownLine = brief.residual.find(line => line.includes(UNKNOWN_CHANGE_RISK));
		expect(unknownLine).toContain("100");
		expect(unknownLine).not.toContain("w0");
		const planlessLine = brief.residual.find(line => line.includes(PLANLESS_PLACEMENT_NOTE));
		expect(planlessLine).toContain(CHECKOUT_CLEANUP_NOTE);
		expect(renderCloseout(brief, false).markdown.split("\n").length).toBeLessThan(20);
		expect(Buffer.byteLength(closeoutHandoff(run), "utf8")).toBeLessThanOrEqual(CLOSEOUT_HANDOFF_MAX_BYTES);
	});
});
