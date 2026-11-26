import { describe, expect, test } from "bun:test";
import {
	asyncAttemptId,
	asyncAttemptReport,
	ATTEMPT_ID_MAX_CHARS,
	ATTEMPT_OBSERVATION_MAX,
	ATTEMPT_REF,
	ATTEMPT_TEXT_MAX,
	attemptUsable,
	deliveredAttemptId,
	type AsyncJobFact,
	type AsyncResultCapture,
	type AttemptSubject,
	type HostArtifactCapture,
	missingAttemptReport,
	type RegistryCapture,
	syncAttemptId,
	syncAttemptReport,
	type SyncTaskCapture,
} from "../src/runtime/attempt-report.ts";

const DIGEST = "a".repeat(64);
const OLD_DIGEST = "b".repeat(64);
const version = "19.0.1";

const subject = (over: Partial<AttemptSubject> = {}): AttemptSubject => ({
	runId: "run-20261123-120000-aaaa",
	parentId: "Main",
	spawnKey: "SyncGood",
	startedAt: 1_000,
	...over,
});

const artifact = (over: Partial<HostArtifactCapture> = {}): HostArtifactCapture => ({
	id: "SyncGood",
	kind: "output",
	path: "/tmp/storm/SyncGood.md",
	exists: true,
	bytes: 128,
	capturedAt: 1_600,
	...over,
});

const sync = (over: Partial<SyncTaskCapture> = {}): SyncTaskCapture => ({
	channel: "task-result",
	toolCallId: "call_c24a42af",
	observedAt: 1_600,
	hostVersion: version,
	results: [{ id: "SyncGood", exitCode: 0, outputPath: "/tmp/storm/SyncGood.md", structuredOutput: { status: "valid" } }],
	artifacts: [artifact()],
	...over,
});

const job = (over: Partial<AsyncJobFact> = {}): AsyncJobFact => ({ jobId: "AsyncGood", agentId: "AsyncGood", status: "completed", schema: { status: "valid" }, ...over });

const asyncCapture = (over: Partial<AsyncResultCapture> = {}): AsyncResultCapture => ({
	channel: "async-result",
	observedAt: 1_600,
	hostVersion: version,
	job: job(),
	...over,
});

const patch = (over: Partial<HostArtifactCapture> = {}): HostArtifactCapture =>
	artifact({
		id: "WorkerIsolated",
		kind: "patch",
		path: "/tmp/storm/WorkerIsolated.patch",
		bytes: 173,
		digest: DIGEST,
		...over,
	});

const registry = (over: Partial<RegistryCapture> = {}): RegistryCapture => ({
	channel: "registry",
	observedAt: 1_700,
	event: "metadata_changed",
	id: "WorkerIsolated",
	parentId: "Main",
	home: "w1",
	history: { patchPath: "/tmp/storm/WorkerIsolated.patch" },
	artifacts: [patch({ capturedAt: 1_700 })],
	...over,
});

const isolatedSubject = (over: Partial<AttemptSubject> = {}): AttemptSubject =>
	subject({ spawnKey: "WorkerIsolated", startedAt: 1_000, ...over });

describe("sync task result report", () => {
	test("a host-valid child binds the tool call, result id and an exact declared-path artifact", () => {
		const report = syncAttemptReport(subject(), sync());
		expect(report.attemptId).toBe(syncAttemptId("call_c24a42af", "SyncGood"));
		expect(report.attemptId).toBe("task:call_c24a42af:SyncGood");
		expect(report.outcome).toBe("success");
		expect(report.capture).toBe("observed");
		expect(attemptUsable(report)).toBe(true);
		expect(report.artifacts).toEqual([
			{ kind: "output", path: "/tmp/storm/SyncGood.md", bytes: 128, capturedAt: 1_600, source: "task-result" },
		]);
		expect(report.observations.every(row => row.source.version === version)).toBe(true);
	});

	test("a claiming child is a failure from host exit/schema facts, not its text", () => {
		const report = syncAttemptReport(
			subject({ spawnKey: "SyncBad" }),
			sync({
				results: [
					{
						id: "SyncBad",
						exitCode: 1,
						error: "schema_violation: missing required fields: ok",
						structuredOutput: { status: "invalid", error: "schema_violation: missing required fields: ok" },
					},
				],
				artifacts: [],
			}),
		);
		expect(report.outcome).toBe("failure");
		expect(report.error).toBe("schema_violation: missing required fields: ok");
		expect(report.schemaStatus).toBe("invalid");
		expect(report.artifacts).toEqual([]);
	});

	test("an aborted child is a cancel even when the host recorded an error", () => {
		const report = syncAttemptReport(subject(), sync({ results: [{ id: "SyncGood", aborted: true, error: "aborted by user" }], artifacts: [] }));
		expect(report.outcome).toBe("cancel");
		expect(report.error).toBe("aborted by user");
	});

	test("a batch without this spawn is missing, never a success", () => {
		const report = syncAttemptReport(subject(), sync({ results: [{ id: "Sync0", exitCode: 0 }], artifacts: [] }));
		expect(report.capture).toBe("missing");
		expect(report.captureError).toBe("native-result-missing");
		expect(report.attemptId).toBeUndefined();
		expect(attemptUsable(report)).toBe(false);
	});

	test("a missing exit status is missing authority, not success", () => {
		const report = syncAttemptReport(subject(), sync({ results: [{ id: "SyncGood" }], artifacts: [] }));
		expect(report.capture).toBe("invalid");
		expect(report.captureError).toBe("exit-code-missing");
		expect(report.outcome).toBe("failure");
	});

	test("a result claiming to precede admission is rejected", () => {
		const report = syncAttemptReport(subject({ startedAt: 2_000 }), sync());
		expect(report.capture).toBe("invalid");
		expect(report.captureError).toBe("attempt-clock");
	});

	test("an explicit schema-invalid result is never a successful outcome", () => {
		const report = syncAttemptReport(
			subject(),
			sync({ results: [{ id: "SyncGood", exitCode: 0, structuredOutput: { status: "invalid", error: "missing ok" } }], artifacts: [] }),
		);
		expect(report.outcome).toBe("failure");
		expect(report.schemaStatus).toBe("invalid");
	});

	test("a replay and a non-current first delivery are both stale", () => {
		const id = syncAttemptId("call_c24a42af", "SyncGood") as string;
		const replay = syncAttemptReport(subject({ priorAttemptIds: [id] }), sync());
		expect(replay.capture).toBe("stale");
		expect(replay.captureError).toBe("attempt-replayed");

		const other = syncAttemptId("call_other", "SyncGood") as string;
		const notCurrent = syncAttemptReport(subject({ expectedAttemptId: other }), sync());
		expect(notCurrent.capture).toBe("stale");
		expect(notCurrent.captureError).toBe("attempt-not-current");

		// A replacement after history needs the exact new native attempt; an unnamed first delivery cannot bind.
		const unproven = syncAttemptReport(subject({ priorAttemptIds: [id] }), sync({ toolCallId: "call_new" }));
		expect(unproven.capture).toBe("stale");
		expect(unproven.captureError).toBe("attempt-not-current");
	});

	test("a declared path is required for its kind and a bare path never becomes an artifact", () => {
		const report = syncAttemptReport(
			subject(),
			sync({ results: [{ id: "SyncGood", exitCode: 0, outputPath: "/tmp/storm/SyncGood.md" }], artifacts: [] }),
		);
		expect(report.artifacts).toEqual([]);
		expect(JSON.stringify(report)).not.toContain("/tmp/storm/SyncGood.md");

		const wrongKindPath = syncAttemptReport(
			subject(),
			sync({
				results: [{ id: "SyncGood", exitCode: 0, outputPath: "/tmp/storm/SyncGood.md" }],
				artifacts: [artifact({ path: "/tmp/storm/other-output.md" })],
			}),
		);
		expect(wrongKindPath.artifacts).toEqual([]);
	});

	test("a required patch must match the declared path with positive bytes and a digest", () => {
		const isolated = subject({ spawnKey: "SyncIsolated" });
		const result = { id: "SyncIsolated", exitCode: 0, patchPath: "/tmp/storm/SyncIsolated.patch" };
		const base = { channel: "task-result" as const, toolCallId: "call_c24a42af", observedAt: 1_600, hostVersion: version, results: [result] };
		const accepted = syncAttemptReport(
			isolated,
			{ ...base, artifacts: [patch({ id: "SyncIsolated", path: "/tmp/storm/SyncIsolated.patch", bytes: 167 }) ] },
			{ requirePatch: true },
		);
		expect(accepted.capture).toBe("observed");
		expect(accepted.artifacts).toEqual([
			{ kind: "patch", path: "/tmp/storm/SyncIsolated.patch", bytes: 167, digest: DIGEST, capturedAt: 1_600, source: "task-result" },
		]);

		const empty = syncAttemptReport(
			isolated,
			{ ...base, artifacts: [patch({ id: "SyncIsolated", path: "/tmp/storm/SyncIsolated.patch", bytes: 0 })] },
			{ requirePatch: true },
		);
		expect(empty.capture).toBe("invalid");
		expect(empty.captureError).toBe("patch-artifact-empty");
		expect(empty.artifacts).toEqual([]);

		const digestlessPatch = patch({ id: "SyncIsolated", path: "/tmp/storm/SyncIsolated.patch" });
		delete digestlessPatch.digest;
		const digestless = syncAttemptReport(isolated, { ...base, artifacts: [digestlessPatch] }, { requirePatch: true });
		expect(digestless.captureError).toBe("patch-artifact-unproven");

		const mismatched = syncAttemptReport(
			isolated,
			{ ...base, artifacts: [patch({ id: "SyncIsolated", path: "/tmp/storm/other.patch" })] },
			{ requirePatch: true },
		);
		expect(mismatched.captureError).toBe("artifact-path-mismatch");

		const staleCapture = syncAttemptReport(
			subject({ spawnKey: "SyncIsolated", startedAt: 2_000 }),
			{ ...base, observedAt: 2_100, artifacts: [patch({ id: "SyncIsolated", path: "/tmp/storm/SyncIsolated.patch", capturedAt: 1_500 })] },
			{ requirePatch: true },
		);
		expect(staleCapture.capture).toBe("stale");
		expect(staleCapture.captureError).toBe("artifact-capture-stale");
	});

	test("malformed native ids are rejected instead of rewritten or truncated", () => {
		const report = syncAttemptReport(subject(), sync({ toolCallId: "call with spaces" }));
		expect(report.capture).toBe("invalid");
		expect(report.captureError).toBe("identity-invalid");
		expect(report.attemptId).toBeUndefined();

		expect(syncAttemptId("call x", "SyncGood")).toBeUndefined();
		expect(syncAttemptId("c".repeat(129), "SyncGood")).toBeUndefined();

		const badSubject = syncAttemptReport(subject({ spawnKey: "bad spawn" }), sync());
		expect(badSubject.capture).toBe("invalid");
		expect(badSubject.captureError).toBe("identity-invalid");
		expect(badSubject.attemptId).toBeUndefined();

		const missing = missingAttemptReport(subject({ spawnKey: "bad spawn" }), { channel: "task-result", observedAt: 1_600 });
		expect(missing.capture).toBe("invalid");
		expect(missing.captureError).toBe("identity-invalid");
	});

	test("the host version defaults to unknown and observation text is bounded", () => {
		const input = sync({
			results: [
				{
					id: "SyncGood",
					exitCode: 1,
					error: `first line\nsecond line ${"x".repeat(5_000)}`,
					structuredOutput: { status: "invalid", error: "\u0000broken" },
				},
			],
			artifacts: [],
		});
		delete input.hostVersion;
		const report = syncAttemptReport(subject(), input);
		expect(report.version).toBe("unknown");
		expect(report.observations.every(row => row.source.version === "unknown")).toBe(true);
		expect(report.error?.length).toBeLessThanOrEqual(ATTEMPT_TEXT_MAX);
		expect(report.error).not.toContain("\n");
		expect(report.schemaError).toBe("broken");
		expect(report.observations.length).toBeLessThanOrEqual(ATTEMPT_OBSERVATION_MAX);
		expect(JSON.stringify(report).length).toBeLessThan(4_096);
	});
});

describe("async result report", () => {
	test("a completed valid job binds the exact job and agent ids", () => {
		const report = asyncAttemptReport(subject({ spawnKey: "AsyncGood" }), asyncCapture());
		expect(report.attemptId).toBe(asyncAttemptId("AsyncGood", "AsyncGood"));
		expect(report.attemptId).toBe("job:AsyncGood:AsyncGood");
		expect(report.outcome).toBe("success");
		expect(report.schemaStatus).toBe("valid");
		expect(attemptUsable(report)).toBe(true);
	});

	test("a wait-delivered job keeps the wait channel as its native source", () => {
		const report = asyncAttemptReport(subject({ spawnKey: "AsyncGood" }), asyncCapture({ channel: "wait-result" }));
		expect(report.attemptId).toBe("job:AsyncGood:AsyncGood");
		expect(report.capture).toBe("observed");
		expect(report.observations.every(row => row.source.channel === "wait-result")).toBe(true);
	});

	test("completed with an explicitly invalid schema is a failure", () => {
		const report = asyncAttemptReport(
			subject({ spawnKey: "AsyncBad" }),
			asyncCapture({ job: job({ jobId: "AsyncBad", agentId: "AsyncBad", status: "completed", schema: { status: "invalid", error: "missing ok" } }) }),
		);
		expect(report.outcome).toBe("failure");
		expect(report.schemaStatus).toBe("invalid");
	});

	test("failed and cancelled jobs keep their host outcome", () => {
		const failed = asyncAttemptReport(subject({ spawnKey: "AsyncBad" }), asyncCapture({ job: job({ jobId: "AsyncBad", agentId: "AsyncBad", status: "failed" }) }));
		expect(failed.outcome).toBe("failure");

		const cancelled = asyncAttemptReport(subject({ spawnKey: "AsyncGood" }), asyncCapture({ job: job({ status: "cancelled" }) }));
		expect(cancelled.outcome).toBe("cancel");
	});

	test("a running or unknown job is not settled", () => {
		const report = asyncAttemptReport(subject({ spawnKey: "AsyncGood" }), asyncCapture({ job: job({ status: "running" }) }));
		expect(report.capture).toBe("invalid");
		expect(report.captureError).toBe("job-not-settled");
	});

	test("a job naming another child is rejected", () => {
		const report = asyncAttemptReport(subject({ spawnKey: "Follow" }), asyncCapture({ job: job({ jobId: "Other", agentId: "Other" }) }));
		expect(report.capture).toBe("invalid");
		expect(report.captureError).toBe("spawn-mismatch");
	});

	test("two successive jobs for the same child stay distinct per explicit job argument", () => {
		const first = asyncAttemptReport(subject({ spawnKey: "Follow" }), asyncCapture({ job: job({ jobId: "Follow", agentId: "Follow" }) }));
		const second = asyncAttemptReport(
			subject({
				spawnKey: "Follow",
				startedAt: 2_000,
				priorAttemptIds: [first.attemptId as string],
				expectedAttemptId: asyncAttemptId("Follow-2", "Follow") as string,
			}),
			asyncCapture({ observedAt: 2_500, job: job({ jobId: "Follow-2", agentId: "Follow" }) }),
		);
		expect(first.attemptId).toBe("job:Follow:Follow");
		expect(second.attemptId).toBe("job:Follow-2:Follow");
		expect(attemptUsable(second)).toBe(true);

		const unnamed = asyncAttemptReport(
			subject({ spawnKey: "Follow", startedAt: 2_000, priorAttemptIds: [first.attemptId as string] }),
			asyncCapture({ observedAt: 2_500, job: job({ jobId: "Follow-3", agentId: "Follow" }) }),
		);
		expect(unnamed.captureError).toBe("attempt-not-current");
	});

	test("an earlier first delivery is rejected by the current native binding", () => {
		const current = asyncAttemptId("Follow-2", "Follow") as string;
		const report = asyncAttemptReport(
			subject({ spawnKey: "Follow", startedAt: 2_000, expectedAttemptId: current }),
			asyncCapture({ observedAt: 2_500, job: job({ jobId: "Follow", agentId: "Follow" }) }),
		);
		expect(report.capture).toBe("stale");
		expect(report.captureError).toBe("attempt-not-current");
		expect(attemptUsable(report)).toBe(false);
	});

	test("malformed native job ids are rejected", () => {
		const spaced = asyncAttemptReport(subject({ spawnKey: "Follow" }), asyncCapture({ job: job({ jobId: "bad id", agentId: "Follow" }) }));
		expect(spaced.capture).toBe("invalid");
		expect(spaced.captureError).toBe("identity-invalid");

		const long = asyncAttemptReport(subject({ spawnKey: "Follow" }), asyncCapture({ job: job({ jobId: "j".repeat(200), agentId: "Follow" }) }));
		expect(long.capture).toBe("invalid");
		expect(long.captureError).toBe("identity-invalid");
		expect(asyncAttemptId("bad id", "Follow")).toBeUndefined();
	});
});

describe("a job id that omp reused for a later turn of the same child", () => {
	const AGENT = "run-20261126-051651-7850-lane-3";
	const first = asyncAttemptId(AGENT, AGENT) as string;
	const later = (over: Partial<AttemptSubject> = {}): AttemptSubject => subject({ spawnKey: AGENT, startedAt: 2_000, priorAttemptIds: [first], ...over });

	test("a real id is 67 characters; a reused job's id carries its start and still fits the limit", () => {
		expect(first).toHaveLength(67);
		expect(asyncAttemptId(AGENT, AGENT, 1_795_688_212_331)).toBe(`job:${AGENT}.t1795688212331:${AGENT}`);
		expect(asyncAttemptId(AGENT, AGENT, 1_795_688_212_331)).toHaveLength(67 + ".t1795688212331".length);
		expect(ATTEMPT_REF.test(first)).toBe(true);
		expect(ATTEMPT_REF.test(asyncAttemptId(AGENT, AGENT, 1_795_688_212_331) as string)).toBe(true);
	});

	test("the limit holds the widest id the host ids allow, stamped or not; a start that is not a time names no attempt", () => {
		const widestJob = "j".repeat(120);
		const widestAgent = "a".repeat(120);
		const stamped = asyncAttemptId(widestJob, widestAgent, 1_795_688_212_331);
		expect(stamped).toHaveLength(4 + 120 + ".t1795688212331".length + 1 + 120);
		expect(ATTEMPT_REF.test(stamped as string)).toBe(true);
		expect(asyncAttemptId(widestJob, widestAgent)).toHaveLength(4 + 120 + 1 + 120);
		// A start of the largest safe integer is the longest stamp there can be.
		const longest = asyncAttemptId(widestJob, widestAgent, Number.MAX_SAFE_INTEGER);
		expect(longest).toBeDefined();
		expect(ATTEMPT_ID_MAX_CHARS).toBeGreaterThanOrEqual((longest as string).length);
		expect(ATTEMPT_REF.test(longest as string)).toBe(true);
		for (const start of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(asyncAttemptId(AGENT, AGENT, start)).toBeUndefined();
	});

	test("a real new turn whose stamped id is long keeps its own id and is not mistaken for a replay", () => {
		const job = "j".repeat(120);
		const agent = "a".repeat(120);
		const plain = asyncAttemptId(job, agent) as string;
		const at = 1_795_688_212_331;
		const turn = subject({ spawnKey: agent, startedAt: at - 400, priorAttemptIds: [plain] });
		expect(deliveredAttemptId(turn, job, agent, at)).toBe(asyncAttemptId(job, agent, at));
		expect(deliveredAttemptId(turn, job, agent, at)).not.toBe(plain);
	});

	test("an id this child never settled is the plain id, whatever its start", () => {
		expect(deliveredAttemptId(later(), `${AGENT}-2`, AGENT, 2_500)).toBe(`job:${AGENT}-2:${AGENT}`);
		expect(deliveredAttemptId(later(), `${AGENT}-2`, AGENT, undefined)).toBe(`job:${AGENT}-2:${AGENT}`);
	});

	test("a settled id is a new turn only when it provably started after the dispatch was admitted", () => {
		expect(deliveredAttemptId(later(), AGENT, AGENT, 2_000)).toBe(`job:${AGENT}.t2000:${AGENT}`);
		expect(deliveredAttemptId(later(), AGENT, AGENT, 2_500)).toBe(`job:${AGENT}.t2500:${AGENT}`);
		// The earlier turn's replay, a delivery with no start, or a start that is not a number stays the plain id.
		expect(deliveredAttemptId(later(), AGENT, AGENT, 1_100)).toBe(first);
		expect(deliveredAttemptId(later(), AGENT, AGENT, undefined)).toBe(first);
		expect(deliveredAttemptId(later(), AGENT, AGENT, "2500")).toBe(first);
	});

	test("the very job the dispatch was bound to is accepted even though it started before the admission (a joined turn)", () => {
		const bound = asyncAttemptId(AGENT, AGENT, 1_500) as string;
		expect(deliveredAttemptId(later({ expectedAttemptId: bound }), AGENT, AGENT, 1_500)).toBe(bound);
		expect(deliveredAttemptId(later({ expectedAttemptId: bound }), AGENT, AGENT, 1_100)).toBe(first);
	});

	test("the report of a reused job's turn is usable, and the same job again is a replay, the first one is stale", () => {
		const stamped = asyncAttemptId(AGENT, AGENT, 2_100) as string;
		const subj = later({ expectedAttemptId: stamped });
		const report = asyncAttemptReport(subj, asyncCapture({ observedAt: 2_500, job: job({ jobId: AGENT, agentId: AGENT, startTime: 2_100 }) }));
		expect(report.attemptId).toBe(stamped);
		expect(attemptUsable(report)).toBe(true);

		const replay = asyncAttemptReport({ ...subj, priorAttemptIds: [first, stamped] }, asyncCapture({ observedAt: 2_600, job: job({ jobId: AGENT, agentId: AGENT, startTime: 2_100 }) }));
		expect(replay.captureError).toBe("attempt-replayed");

		const stale = asyncAttemptReport(subj, asyncCapture({ observedAt: 2_500, job: job({ jobId: AGENT, agentId: AGENT, startTime: 1_100 }) }));
		expect(stale.captureError).toBe("attempt-replayed");
		expect(attemptUsable(stale)).toBe(false);
	});
});

describe("the attempt reference pattern", () => {
	test("it holds every id Storm builds and refuses what is not a bounded token", () => {
		expect(ATTEMPT_REF.test("job:run-20261126-051651-7850-lane-3:run-20261126-051651-7850-lane-3")).toBe(true);
		expect(ATTEMPT_REF.test(`task:${"c".repeat(120)}:${"a".repeat(120)}`)).toBe(true);
		expect(ATTEMPT_REF.test("a".repeat(ATTEMPT_ID_MAX_CHARS + 1))).toBe(false);
		for (const unsafe of ["", "job:a b:c", "job:a/b:c", "job:a\nb:c", "job:\u00e9:c"]) expect(ATTEMPT_REF.test(unsafe)).toBe(false);
	});
});

describe("async isolated patch from the registry", () => {
	const jobFor = (jobId = "WorkerIsolated") => asyncCapture({ job: job({ jobId, agentId: "WorkerIsolated", schema: { status: "valid" } }) });

	test("a first patch is accepted with a declared admission baseline of null", () => {
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry(),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(report.capture).toBe("observed");
		expect(report.artifacts).toEqual([
			{ kind: "patch", path: "/tmp/storm/WorkerIsolated.patch", bytes: 173, digest: DIGEST, capturedAt: 1_700, source: "registry" },
		]);
		expect(report.observations.find(row => row.facet === "artifact")?.source.channel).toBe("registry");
	});

	test("the same unchanged path and digest on a fresh event is not new authority", () => {
		const baseline = patch({ capturedAt: 900 });
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry(),
			admissionPatch: baseline,
			requirePatch: true,
		});
		expect(report.capture).toBe("missing");
		expect(report.captureError).toBe("patch-artifact-unchanged");
		expect(report.artifacts).toEqual([]);
	});

	test("a changed digest or path after admission is a real transition", () => {
		const changed = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry(),
			admissionPatch: patch({ capturedAt: 900, digest: OLD_DIGEST }),
			requirePatch: true,
		});
		expect(changed.capture).toBe("observed");

		const newPath = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ history: { patchPath: "/tmp/storm/new.patch" }, artifacts: [patch({ path: "/tmp/storm/new.patch" })] }),
			admissionPatch: patch({ capturedAt: 900 }),
			requirePatch: true,
		});
		expect(newPath.capture).toBe("observed");
	});

	test("attempt-versioned host metadata can bind an unchanged patch", () => {
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ jobId: "WorkerIsolated" }),
			admissionPatch: patch({ capturedAt: 900 }),
			requirePatch: true,
		});
		expect(report.capture).toBe("observed");
	});

	test("a different versioned job id cannot bind the patch", () => {
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ jobId: "OtherJob" }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(report.captureError).toBe("patch-artifact-unproven");
		expect(report.artifacts).toEqual([]);
	});

	test("without versioned metadata or an admission baseline no first patch is proven", () => {
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), { registry: registry(), requirePatch: true });
		expect(report.captureError).toBe("patch-artifact-unproven");
		expect(report.artifacts).toEqual([]);
	});

	test("a patch captured before admission is stale", () => {
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ artifacts: [patch({ capturedAt: 900 })] }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(report.capture).toBe("stale");
		expect(report.captureError).toBe("artifact-capture-stale");
	});

	test("parent, home and child identity are checked before a patch is trusted", () => {
		const wrongParent = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ parentId: "OtherMain" }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(wrongParent.captureError).toBe("parent-mismatch");

		const noHome = registry();
		delete noHome.home;
		const missingHome = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: noHome,
			admissionPatch: null,
			requirePatch: true,
		});
		expect(missingHome.captureError).toBe("registry-identity-missing");

		const wrongChild = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ id: "OtherChild" }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(wrongChild.captureError).toBe("registry-mismatch");
		expect(wrongChild.artifacts).toEqual([]);
	});

	test("the capture path must equal the declared history path for its kind", () => {
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ artifacts: [patch({ path: "/tmp/storm/other.patch" })] }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(report.captureError).toBe("artifact-path-mismatch");
		expect(report.artifacts).toEqual([]);
	});

	test("zero bytes, no digest and no capture do not satisfy a required patch", () => {
		const zero = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ artifacts: [patch({ bytes: 0 })] }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(zero.capture).toBe("invalid");
		expect(zero.captureError).toBe("patch-artifact-empty");
		expect(zero.artifacts).toEqual([]);

		const digestlessPatch = patch();
		delete digestlessPatch.digest;
		const digestless = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ artifacts: [digestlessPatch] }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(digestless.captureError).toBe("patch-artifact-unproven");

		const nocapture = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({ artifacts: [] }),
			admissionPatch: null,
			requirePatch: true,
		});
		expect(nocapture.captureError).toBe("patch-artifact-missing");
	});

	test("an output artifact is accepted only at the declared history path", () => {
		const output = registry({
			history: { outputPath: "/tmp/storm/WorkerIsolated.md" },
			artifacts: [artifact({ id: "WorkerIsolated", path: "/tmp/storm/WorkerIsolated.md", bytes: 64, capturedAt: 1_700 })],
		});
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), { registry: output });
		expect(report.artifacts).toEqual([
			{ kind: "output", path: "/tmp/storm/WorkerIsolated.md", bytes: 64, capturedAt: 1_700, source: "registry" },
		]);

		const wrong = asyncAttemptReport(isolatedSubject(), jobFor(), {
			registry: registry({
				history: { outputPath: "/tmp/storm/WorkerIsolated.md" },
				artifacts: [artifact({ id: "WorkerIsolated", path: "/tmp/storm/other.md", capturedAt: 1_700 })],
			}),
		});
		expect(wrong.artifacts).toEqual([]);
	});

	test("an async job alone cannot supply a patch, even if the caller passes an artifact list", () => {
		const report = asyncAttemptReport(isolatedSubject(), jobFor(), { requirePatch: true });
		expect(report.capture).toBe("missing");
		expect(report.captureError).toBe("patch-artifact-missing");
		expect(report.artifacts).toEqual([]);

		const injected = asyncAttemptReport(
			isolatedSubject(),
			{ ...jobFor(), artifacts: [patch()] } as unknown as AsyncResultCapture,
			{ requirePatch: true },
		);
		expect(injected.captureError).toBe("patch-artifact-missing");
		expect(injected.artifacts).toEqual([]);
	});
});

describe("native retry exhaustion", () => {
	test("a sync result's retryFailure count is kept as a failure fact, never from its message", () => {
		const report = syncAttemptReport(subject(), sync({
			results: [{
				id: "SyncGood",
				exitCode: 0,
				structuredOutput: { status: "valid" },
				retryFailure: { attempt: 2, errorMessage: "429 quota; do not diagnose this text" },
			}],
		}));
		expect(report.outcome).toBe("failure");
		expect(report.retry).toEqual({ attempt: 2 });
		expect(report.error).toBeUndefined();
	});

	test("a malformed retry count is absent; the host's exit/schema still decides", () => {
		for (const attempt of [0, -1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
			const report = syncAttemptReport(subject(), sync({
				results: [{ id: "SyncGood", exitCode: 0, structuredOutput: { status: "valid" }, retryFailure: { attempt } }],
			}));
			expect(report.outcome).toBe("success");
			expect(report.retry).toBeUndefined();
		}
	});

	test("an async failure keeps the bound retry count; a success after a retry stays success", () => {
		const asyncSubject = subject({ spawnKey: "AsyncGood" });
		const failed = asyncAttemptReport(asyncSubject, asyncCapture({ job: job({ status: "failed" }) }), { retryAttempt: 3 });
		expect(failed.outcome).toBe("failure");
		expect(failed.retry).toEqual({ attempt: 3 });

		const succeeded = asyncAttemptReport(asyncSubject, asyncCapture(), { retryAttempt: 3 });
		expect(succeeded.outcome).toBe("success");
		expect(succeeded.retry).toBeUndefined();

		const cancelled = asyncAttemptReport(asyncSubject, asyncCapture({ job: job({ status: "cancelled" }) }), { retryAttempt: 3 });
		expect(cancelled.outcome).toBe("cancel");
		expect(cancelled.retry).toBeUndefined();

		const malformed = asyncAttemptReport(asyncSubject, asyncCapture({ job: job({ status: "failed" }) }), { retryAttempt: 1.5 });
		expect(malformed.outcome).toBe("failure");
		expect(malformed.retry).toBeUndefined();
	});
});

describe("missing delivery report", () => {
	test("no native envelope never claims an attempt or a success", () => {
		const report = missingAttemptReport(subject(), { channel: "task-result", observedAt: 1_600, hostVersion: version });
		expect(report.outcome).toBe("failure");
		expect(report.capture).toBe("missing");
		expect(report.captureError).toBe("native-result-missing");
		expect(report.attemptId).toBeUndefined();
		expect(report.artifacts).toEqual([]);
		expect(attemptUsable(report)).toBe(false);
		expect(report.observations[0]?.source.version).toBe(version);
	});

	test("an async delivery gap uses its own stable code", () => {
		const report = missingAttemptReport(subject(), { channel: "async-result", observedAt: 1_600 });
		expect(report.captureError).toBe("native-delivery-missing");
		expect(report.version).toBe("unknown");
	});
});
