/**
 * Slice A red cases: exact candidate mapping, carrier-independent terminal/capture joins, owner-bound byte copies, the
 * exclusive native slot, and the cooperative child-entry claim.
 *
 * All host envelopes here are typed shapes copied from the probe report; no test parses model text. Fixtures are local
 * to this file so the frozen shared fixtures stay untouched.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CaptureJournalPort,
	CaptureUpdate,
	LateRecoveryObservation,
	RegistrySnapshotInput,
	SealedCaptureManifest,
} from "../src/runtime/integration-capture.ts";
import type {
	AdmissionKey,
	ChildEntryClaim,
	FrozenIntegrationAdmission,
	IntegrationTarget,
	ObservationIdentity,
	SpaceIdentity,
} from "../src/runtime/integration-admission.ts";
import {
	IntegrationAdmissionStore,
	IntegrationArtifactStore,
	INTEGRATION_ADMISSION_SCHEMA,
	INTEGRATION_POLICY_HOST,
	integrationCandidateId,
} from "../src/runtime/integration-artifacts.ts";
import type { IntegrationDeltaPort } from "../src/runtime/integration-delta.ts";
import {
	IsolationCapture,
	captureManifestDigest,
	type CaptureCopyPort,
	type IsolationCaptureOptions,
} from "../src/runtime/isolation-capture.ts";
import { missingAttemptReport } from "../src/runtime/attempt-report.ts";
import type { WorkerAdmissionRecord } from "../src/worker-admission.ts";

const cleanups: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

interface Fixture {
	readonly tmp: string;
	readonly agentDir: string;
	readonly artifactRoot: string;
	readonly repo: string;
	readonly gitDir: string;
	readonly objectsDir: string;
	readonly worktreesDir: string;
	readonly sessionDir: string;
	readonly childSessionFile: string;
	readonly store: IntegrationAdmissionStore;
	readonly clock: { now: number };
}

async function fixture(): Promise<Fixture> {
	const tmp = await mkdtemp(join(tmpdir(), "storm-a-capture-"));
	cleanups.push(tmp);
	const agentDir = join(tmp, "agent");
	const artifactRoot = join(tmp, "artifacts");
	const repo = join(tmp, "repo");
	const gitDir = join(repo, ".git");
	const objectsDir = join(gitDir, "objects");
	const worktreesDir = join(tmp, "wt");
	const sessionDir = join(tmp, "session");
	const childSessionFile = join(sessionDir, "child.jsonl");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(artifactRoot, { recursive: true }),
		mkdir(objectsDir, { recursive: true }),
		mkdir(worktreesDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	await writeFile(childSessionFile, "{}\n");
	await writeFile(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n");
	const clock = { now: 10_000 };
	const store = new IntegrationAdmissionStore({
		agentDir,
		worktreesDir,
		now: () => clock.now,
		hostOwner: async () => ({ pid: process.pid, processStart: "test-start" }),
	});
	return { tmp, agentDir, artifactRoot, repo, gitDir, objectsDir, worktreesDir, sessionDir, childSessionFile, store, clock };
}

async function identity(path: string): Promise<SpaceIdentity> {
	const canonical = await realpath(path);
	const statValue = await stat(canonical, { bigint: true });
	return { canonicalPath: canonical, device: statValue.dev.toString(), inode: statValue.ino.toString() };
}

async function targetOf(f: Fixture): Promise<IntegrationTarget> {
	return {
		leaseKey: `lease-${f.tmp}`,
		authorizedRoot: await identity(f.repo),
		gitRoot: await identity(f.repo),
		gitDir: await identity(f.gitDir),
		sourceOdb: {
			commonDir: await identity(f.gitDir),
			objects: await identity(f.objectsDir),
			objectFormat: "sha1",
		},
		targetPrefix: "",
	};
}

interface AdmissionOptions {
	readonly handle?: string;
	readonly runId?: string;
	readonly dispatch?: string;
	readonly toolCallId?: string;
	readonly itemIndex?: number;
	readonly startedAt?: number;
	readonly planned?: boolean;
}

function keyOf(options: Required<Pick<AdmissionOptions, "runId" | "dispatch">>): AdmissionKey {
	return { schema: INTEGRATION_ADMISSION_SCHEMA, runId: options.runId, dispatch: options.dispatch };
}

interface BuiltAdmission {
	readonly admission: FrozenIntegrationAdmission;
	readonly worker: WorkerAdmissionRecord;
}

async function admissionFor(f: Fixture, options: AdmissionOptions = {}): Promise<BuiltAdmission> {
	const handle = options.handle ?? "W1";
	const runId = options.runId ?? "run-1";
	const dispatch = options.dispatch ?? "attempt:W1:10000:1";
	const toolCallId = options.toolCallId ?? "call-1";
	const itemIndex = options.itemIndex ?? 0;
	const key = keyOf({ runId, dispatch });
	const target = await targetOf(f);
	const item = { toolCallId, itemIndex, handle };
	const nativeSlotPath = join(f.worktreesDir, `t${sha(handle).slice(0, 9)}`);
	const slot = await f.store.reserveSlot({ key, target, item, profile: "test", nativeSlotPath });
	if (slot.kind === "unknown") throw new Error(`slot refused: ${slot.problem.code}`);
	const workerKey = sha(`${f.tmp}\0${handle}\0${dispatch}`);
	const attempt = randomUUID();
	const policy = {
		id: `proof-${dispatch}`,
		host: INTEGRATION_POLICY_HOST,
		settingsInstance: "settings-1",
		relevantEpoch: 3,
		directorInstance: "main:test",
		toolCallId,
		enabled: true,
		backendProofId: "backend-1",
		apply: false,
		merge: "patch",
		captureContract: "native-git-synthetic-tree",
		backendSetting: "native",
		profile: "test",
		guardBuild: "guard-1",
	} as const;
	const admission: FrozenIntegrationAdmission = {
		key,
		candidateId: integrationCandidateId(key),
		director: {
			sessionId: "session-1",
			sessionInstance: "main:test",
			sessionDir: f.sessionDir,
			parentId: "Main",
		},
		target,
		artifactRoot: await identity(f.artifactRoot),
		item,
		placementOrdinal: itemIndex,
		approvedDefinitionDigest: "definition-1",
		approvalDigest: "approval-1",
		workerAdmission: { key: workerKey, attempt, approved: [] },
		scope: { kind: "unbounded" },
		subject: options.planned === true
			? { kind: "planned", lane: "L1", epoch: 1, contractDigest: "contract-1", results: [], consumed: [] }
			: { kind: "unplanned" },
		policy,
		slot: slot.value,
		startedAt: options.startedAt ?? f.clock.now,
	};
	const worker: WorkerAdmissionRecord = {
		schema: "storm.worker-admission/v2",
		build: "test-build",
		key: workerKey,
		runId,
		sessionId: "session-1",
		sessionDir: f.sessionDir,
		repoId: "repo-1",
		targetRoot: f.repo,
		artifactRoot: f.artifactRoot,
		parentId: "Main",
		childId: handle,
		attempt,
		policy: { kind: "private", paths: [], reason: "test", shell: true },
		createdAt: f.clock.now,
		expiresAt: f.clock.now + 60_000,
		approved: [],
	};
	return { admission, worker };
}

class FakeJournal implements CaptureJournalPort {
	readonly manifests: SealedCaptureManifest[] = [];
	readonly recoveries: LateRecoveryObservation[] = [];
	sequence = 0;
	fail = false;

	#waiters: Array<{ count: number; resolve: () => void }> = [];

	async appendManifest(manifest: SealedCaptureManifest): Promise<{ kind: "known"; value: number } | { kind: "unknown"; problem: { code: string; reason: string } }> {
		if (this.fail) return { kind: "unknown", problem: { code: "disk-full", reason: "test refusal" } };
		this.manifests.push(manifest);
		this.sequence += 1;
		this.#resolveWaiters();
		return { kind: "known", value: this.sequence };
	}

	async waitFor(count: number): Promise<void> {
		if (this.manifests.length >= count) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push({ count, resolve });
		await promise;
	}

	#resolveWaiters(): void {
		for (const waiter of this.#waiters.splice(0)) {
			if (this.manifests.length >= waiter.count) waiter.resolve();
			else this.#waiters.push(waiter);
		}
	}

	async appendRecovery(observation: LateRecoveryObservation): Promise<{ kind: "known"; value: number } | { kind: "unknown"; problem: { code: string; reason: string } }> {
		if (this.fail) return { kind: "unknown", problem: { code: "disk-full", reason: "test refusal" } };
		this.recoveries.push(observation);
		this.sequence += 1;
		return { kind: "known", value: this.sequence };
	}
}

interface CaptureRig {
	readonly capture: IsolationCapture;
	readonly journal: FakeJournal;
	readonly updates: CaptureUpdate[];
	readonly artifacts: CaptureCopyPort;
	readonly store: IntegrationArtifactStore;
	readonly f: Fixture;
}

function captureRig(f: Fixture, options: Partial<IsolationCaptureOptions> & { artifacts?: CaptureCopyPort } = {}): CaptureRig {
	const journal = new FakeJournal();
	const updates: CaptureUpdate[] = [];
	const store = new IntegrationArtifactStore({ agentDir: f.agentDir, now: () => f.clock.now, maxObjectBytes: 1024 * 1024 });
	const artifacts = options.artifacts ?? store;
	const capture = new IsolationCapture({
		artifacts,
		journal,
		publish: update => {
			updates.push(update);
		},
		now: () => f.clock.now,
		missingEvidenceMs: 20,
		copyTimeoutMs: 1_000,
		...options,
	});
	return { capture, journal, updates, artifacts, store, f };
}

function entryFor(f: Fixture): ObservationIdentity {
	return {
		registryInstance: "main:child-1",
		generation: 2,
		childSessionFile: {
			canonicalPath: f.childSessionFile,
			device: "1",
			inode: "1",
		},
	};
}

function claimFor(f: Fixture, admission: FrozenIntegrationAdmission): ChildEntryClaim {
	return {
		key: admission.key,
		candidateId: admission.candidateId,
		entry: entryFor(f),
		childHandle: admission.item.handle,
		policyProofId: admission.policy.id,
		workerAttempt: admission.workerAdmission.attempt,
		slotOwnerToken: admission.slot.ownerToken,
		hostOwner: { pid: process.pid, processStart: 0, host: INTEGRATION_POLICY_HOST },
		checkout: { canonicalPath: join(admission.slot.slotPath, "m"), device: "10", inode: "11" },
		checkoutGitDir: { canonicalPath: join(admission.slot.slotPath, "m", ".git"), device: "12", inode: "13" },
		checkoutIndexPath: join(admission.slot.slotPath, "m", ".git", "index"),
		checkoutTargetPrefix: "",
		sourceOdb: admission.target.sourceOdb,
		guardBuild: admission.policy.guardBuild,
		preWorkHead: null,
		checkedAt: f.clock.now,
	};
}

async function patch(f: Fixture, handle: string, content: string): Promise<string> {
	const path = join(await realpath(f.artifactRoot), `${handle}.patch`);
	await writeFile(path, content);
	return path;
}

/** The exact child-entry claim every positive capture now requires; a sync result without one is recovery only. */
function claimCapture(rig: CaptureRig, f: Fixture, built: BuiltAdmission): void {
	rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
}

function syncResult(input: {
	handle: string;
	index?: number;
	patchPath?: string;
	hasRootChanges?: boolean;
	nestedPatchPaths?: readonly string[];
	nestedPatches?: readonly { relativePath: string; patch: string }[];
	isolated?: boolean;
	exitCode?: number | null;
	aborted?: boolean;
	branchName?: string;
	branchBaseSha?: string;
}) {
	return {
		id: input.handle,
		index: input.index ?? 0,
		isolated: input.isolated ?? true,
		...(input.exitCode === null ? {} : { exitCode: input.exitCode ?? 0 }),
		aborted: input.aborted ?? false,
		...(input.patchPath === undefined ? {} : { patchPath: input.patchPath }),
		...(input.hasRootChanges === undefined ? {} : { hasRootChanges: input.hasRootChanges }),
		...(input.nestedPatchPaths === undefined ? {} : { nestedPatchPaths: [...input.nestedPatchPaths] }),
		...(input.nestedPatches === undefined ? {} : { nestedPatches: [...input.nestedPatches] }),
		...(input.branchName === undefined ? {} : { branchName: input.branchName }),
		...(input.branchBaseSha === undefined ? {} : { branchBaseSha: input.branchBaseSha }),
	};
}

/** One host task acknowledgement; the additive `executions` array is the only positive authority. */
function asyncAck(input: { jobId: string; handle?: string; index?: number; executions?: readonly unknown[] }) {
	return {
		results: [],
		progress: [{ index: input.index ?? 0, id: input.handle ?? "W1", status: "running" }],
		async: {
			state: "running",
			jobId: input.jobId,
			...(input.executions === undefined ? {} : { executions: input.executions }),
		},
	};
}

/** The exact additive per-item proof the host emits on ack, wait and push. */
interface ExecutionFixture {
	readonly revision: 1;
	readonly jobId: string;
	readonly type: "task";
	readonly executionToken: string;
	readonly itemIndex: number;
	readonly agentId: string;
	readonly ownerSessionId: string;
}

function nativeExecution(input: { jobId: string; handle?: string; index?: number; owner?: string; token?: string }): ExecutionFixture {
	return {
		revision: 1,
		jobId: input.jobId,
		type: "task",
		executionToken: input.token ?? randomUUID(),
		itemIndex: input.index ?? 0,
		agentId: input.handle ?? "W1",
		ownerSessionId: input.owner ?? "Main",
	};
}

/** One native wait row: `settledAtMs - durationMs` recovers the job's registration stamp. */
function waitJob(input: {
	jobId: string;
	handle?: string;
	status?: "completed" | "failed" | "cancelled";
	settledAtMs: number;
	durationMs: number;
	structured?: Record<string, unknown>;
	execution?: ExecutionFixture;
}) {
	return {
		id: input.jobId,
		type: "task",
		status: input.status ?? "completed",
		agentUrlId: input.handle ?? "W1",
		settledAtMs: input.settledAtMs,
		durationMs: input.durationMs,
		...(input.structured === undefined ? {} : { structured: input.structured }),
		...(input.execution === undefined ? {} : { agentId: input.execution.agentId, execution: input.execution }),
	};
}

/** One pushed delivery row: it carries `schema` and the additive execution object. */
function pushJob(input: {
	jobId: string;
	handle?: string | null;
	status?: "completed" | "failed" | "cancelled";
	durationMs?: number;
	schema?: Record<string, unknown>;
	label?: string;
	execution?: ExecutionFixture;
}) {
	const handle = input.handle === undefined ? "W1" : input.handle;
	return {
		jobId: input.jobId,
		type: "task",
		status: input.status ?? "completed",
		...(handle === null ? {} : { agentId: handle }),
		...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
		...(input.schema === undefined ? {} : { schema: input.schema }),
		...(input.label === undefined ? {} : { label: input.label }),
		...(input.execution === undefined ? {} : { execution: input.execution }),
	};
}

function observeAck(rig: CaptureRig, built: BuiltAdmission, details: unknown, observedAt = built.admission.startedAt): void {
	rig.capture.observeAsync({
		director: built.admission.director,
		carrier: "ack",
		toolCallId: built.admission.item.toolCallId,
		details,
		observedAt,
	});
}

/** Ack one exact additive execution proof for its owning admission. */
function observeExecutionAck(rig: CaptureRig, built: BuiltAdmission, execution: ExecutionFixture): void {
	observeAck(
		rig,
		built,
		asyncAck({
			jobId: execution.jobId,
			handle: execution.agentId,
			index: execution.itemIndex,
			executions: [execution],
		}),
	);
}

function registrySnapshot(f: Fixture, admission: FrozenIntegrationAdmission, overrides: Partial<RegistrySnapshotInput> = {}): RegistrySnapshotInput {
	return {
		director: admission.director,
		registryInstance: "main:child-1",
		event: "metadata_changed",
		handle: admission.item.handle,
		parentId: admission.director.parentId,
		parentSessionKey: "main:test",
		generation: 2,
		childSessionFile: f.childSessionFile,
		history: {},
		observedAt: f.clock.now,
		...overrides,
	};
}

async function sealed(rig: CaptureRig): Promise<SealedCaptureManifest[]> {
	await rig.capture.drain();
	return rig.journal.manifests;
}

describe("candidate identity", () => {
	test("is stable per versioned admission key and never derived from bytes or notification order", async () => {
		const key = { schema: INTEGRATION_ADMISSION_SCHEMA, runId: "run-1", dispatch: "attempt:W1:1" } as const;
		const first = integrationCandidateId(key);
		const second = integrationCandidateId(key);
		expect(first).toBe(second);
		expect(first).toMatch(/^c1_[0-9a-f]{64}$/u);
		expect(first as string).toBe(`c1_${createHash("sha256").update(JSON.stringify([key.schema, key.runId, key.dispatch])).digest("hex")}`);
		expect(integrationCandidateId({ ...key, dispatch: "attempt:W1:2" })).not.toBe(first);
	});
});

describe("sync typed capture", () => {
	test("a successful root-only patch seals one owned copy", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const content = "diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+A\n";
		const path = await patch(f, "W1", content);
		expect(rig.capture.track(built.admission)).toEqual({ ok: true });
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		if (manifest === undefined) throw new Error("expected a sealed manifest");
		expect(manifest.bundle.kind).toBe("root-only");
		if (manifest.bundle.kind !== "root-only") return;
		expect(manifest.bundle.basis).toBe("sync-explicit");
		expect(manifest.bundle.root.bytes).toBe(Buffer.byteLength(content));
		const read = await rig.store.readPatch(manifest.bundle.root, {
			maxBytes: 1024,
			deadline: f.clock.now + 1_000,
			signal: new AbortController().signal,
		});
		expect(read.kind).toBe("known");
		if (read.kind === "known") expect(Buffer.from(read.value).toString("utf8")).toBe(content);
		const { digest, ...payload } = manifest;
		expect(digest).toBe(captureManifestDigest(payload));
		expect(rig.journal.manifests).toHaveLength(1);
		expect(rig.updates.filter(update => update.kind === "sealed")).toHaveLength(1);
	});

	test("explicit empty arrays and a zero-byte root are confirmed-empty, not absent", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: false, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("confirmed-empty");
		expect(manifest?.recovery.root.kind).toBe("known");
	});

	test("a missing nested list is unknown even when the root is zero bytes", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: false })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("unknown");
		expect(rig.journal.manifests).toHaveLength(1);
	});

	test("nested-only and root-plus-nested stay recovery-only with copied bytes", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const root = await patch(f, "W1", "");
		const nestedPath = join(await realpath(f.artifactRoot), "W1.nested-0-nested-repo.patch");
		const nestedBytes = "diff --git a/x b/x\nnew file mode 100644\n";
		await writeFile(nestedPath, nestedBytes);
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [
				syncResult({
					handle: "W1",
					patchPath: root,
					hasRootChanges: false,
					nestedPatchPaths: [nestedPath],
					nestedPatches: [{ relativePath: "nested-repo", patch: nestedBytes }],
				}),
			],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("kept-only");
		expect(manifest?.recovery.nested.kind).toBe("known");
		if (manifest?.recovery.nested.kind !== "known") return;
		expect(manifest.recovery.nested.value).toHaveLength(1);
		const part = manifest.recovery.nested.value[0];
		expect(part?.relativeRepo.kind).toBe("known");
		expect(part?.copy.kind).toBe("known");
	});

	test("hasRootChanges contradicting copied bytes never becomes a root-only candidate", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: false })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("unknown");
	});

	test("a sync success without the exact child claim is recovery-only after the bounded wait", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const content = "diff --git a/a b/a\n+A\n";
		const path = await patch(f, "W1", content);
		rig.capture.track(built.admission);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		await rig.capture.drain();
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		if (manifests[0]?.bundle.kind === "unknown") expect(manifests[0].bundle.problem.code).toBe("child-claim-missing");
		expect(manifests[0]?.childClaim.kind).toBe("unknown");
		expect(manifests[0]?.recovery.root.kind).toBe("known");
		if (manifests[0]?.recovery.root.kind === "known" && manifests[0].recovery.root.value.copy.kind === "known") {
			const read = await rig.store.readPatch(manifests[0].recovery.root.value.copy.value, {
				maxBytes: 1024,
				deadline: f.clock.now + 1_000,
				signal: new AbortController().signal,
			});
			expect(read.kind).toBe("known");
			if (read.kind === "known") expect(Buffer.from(read.value).toString("utf8")).toBe(content);
		}
		claimCapture(rig, f, built);
		await rig.capture.drain();
		expect(rig.journal.manifests).toHaveLength(1);
		expect(rig.journal.recoveries).toHaveLength(1);
		expect(rig.journal.recoveries[0]?.facts.checkout.kind).toBe("present");
		expect(rig.journal.recoveries[0]?.contradiction.kind).toBe("unknown");
	});

	test("a contradicting child claim fails closed while the copied bytes stay recovery", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), { ...claimFor(f, built.admission), slotOwnerToken: "other-owner" });
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("unknown");
		if (manifest?.bundle.kind === "unknown") expect(manifest.bundle.problem.code).toBe("claim-admission-mismatch");
		expect(manifest?.recovery.root.kind).toBe("known");
	});

	test("a sparse sync envelope binds by the host's original index, not its array position", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f, { itemIndex: 1 });
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [
				syncResult({ handle: "OTHER", index: 0, patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] }),
				syncResult({ handle: "W1", index: 1, patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] }),
			],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("root-only");
		expect(manifest?.admission.item.itemIndex).toBe(1);
	});

	test("a registry part contradiction fails closed for a sync success", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		const other = await patch(f, "W1-other", "diff --git a/b b/b\n+B\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: other, nestedPatchPaths: [] } }));
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("unknown");
		if (manifest?.bundle.kind === "unknown") expect(manifest.bundle.problem.code).toBe("registry-parts-changed");
		expect(manifest?.recovery.root.kind).toBe("known");
	});

	test("an admission without the runtime apply-off proof is refused before capture", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const invalid = {
			...built.admission,
			policy: { ...built.admission.policy, apply: true },
		} as unknown as FrozenIntegrationAdmission;
		const tracked = rig.capture.track(invalid);
		expect(tracked.ok).toBe(false);
		expect(rig.capture.stats().tracked).toBe(0);
	});

	test("a branch capture is retained recovery, never root-only", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({
				handle: "W1",
				hasRootChanges: false,
				branchName: "omp/task/W1",
				branchBaseSha: "a".repeat(40),
				nestedPatchPaths: [],
				nestedPatches: [],
			})],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("kept-only");
		expect(manifest?.recovery.branch.kind).toBe("known");
	});
});

describe("async carrier join", () => {
	test("push then wait are one terminal identity; the wait proves first-generation registration", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			history: { patchPath: path, nestedPatchPaths: [] },
		}));
		const execution = nativeExecution({ jobId: "W1" });
		observeExecutionAck(rig, built, execution);
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { customType: "async-result", details: { jobs: [pushJob({ jobId: "W1", durationMs: 5, execution })] } },
			observedAt: f.clock.now + 1,
		});
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution })] },
			observedAt: f.clock.now + 4,
		});
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
		expect(manifests[0]?.terminal.kind).toBe("known");
		if (manifests[0]?.terminal.kind === "known" && manifests[0].terminal.value.carrier !== "sync") {
			expect(manifests[0].terminal.value.job.jobId).toBe("W1");
		}
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W1", durationMs: 5, execution })] } },
			observedAt: f.clock.now + 5,
		});
		await rig.capture.drain();
		expect(rig.journal.manifests).toHaveLength(1);
		expect(rig.journal.recoveries).toHaveLength(1);
		expect(rig.journal.recoveries[0]?.contradiction.kind).toBe("unknown");
	});

	test("a push followed only by an empty wait stays typed recovery", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			history: { patchPath: path, nestedPatchPaths: [] },
		}));
		observeAck(rig, built, asyncAck({ jobId: "W1" }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W1", durationMs: 5 })] } },
			observedAt: f.clock.now + 1,
		});
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [] },
			observedAt: f.clock.now + 2,
		});
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.terminal.kind).toBe("unknown");
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		expect(manifests[0]?.recovery.root.kind).toBe("known");
	});

	test("a terminal that arrives first joins the real suffixed acknowledgement by exact job id", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		const execution = nativeExecution({ jobId: "W1-7" });
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [waitJob({ jobId: "W1-7", settledAtMs: f.clock.now + 4, durationMs: 5, execution })],
			},
			observedAt: f.clock.now + 5,
		});
		observeExecutionAck(rig, built, execution);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
		if (manifests[0]?.terminal.kind === "known" && manifests[0].terminal.value.carrier !== "sync") {
			expect(manifests[0].terminal.value.job.jobId).toBe("W1-7");
		}
	});

	test("prefix, label-only and same-id terminals never replace the ack's resolved job", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		const execution = nativeExecution({ jobId: "W1-7" });
		observeExecutionAck(rig, built, execution);
		for (const row of [
			waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution: nativeExecution({ jobId: "W1" }) }),
			waitJob({ jobId: "W1-9", settledAtMs: f.clock.now + 4, durationMs: 5, execution: nativeExecution({ jobId: "W1-9" }) }),
		]) {
			rig.capture.observeAsync({
				director: built.admission.director,
				carrier: "wait",
				details: { op: "wait", jobs: [row] },
				observedAt: f.clock.now + 4,
			});
		}
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W1", handle: null, label: "W1" })] } },
			observedAt: f.clock.now + 5,
		});
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.terminal.kind).toBe("unknown");
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		expect(manifests[0]?.recovery.root.kind).toBe("known");
		expect(rig.capture.stats().unmatched["async-late-other-execution"]).toBeGreaterThan(0);
	});

	test("a registry list missing nestedPatchPaths is unknown, never empty", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		const execution = nativeExecution({ jobId: "W1" });
		observeExecutionAck(rig, built, execution);
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path } }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution })] },
			observedAt: f.clock.now + 4,
		});
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		expect(manifests[0]?.recovery.nested.kind).toBe("unknown");
	});

	test("a mutable registry snapshot cannot change the sealed part list", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		const history = { patchPath: path, nestedPatchPaths: [] as string[] };
		const snapshot = registrySnapshot(f, built.admission, { history });
		rig.capture.observeRegistry(snapshot);
		history.nestedPatchPaths.push("/tmp/late.patch");
		const execution = nativeExecution({ jobId: "W1" });
		observeExecutionAck(rig, built, execution);
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution })] },
			observedAt: f.clock.now + 4,
		});
		const manifests = await sealed(rig);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
	});

	test("late bound evidence is a recovery observation and a new contradiction, never a seal rewrite", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		if (manifest === undefined) throw new Error("expected a sealed manifest");
		const before = manifest.digest;
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			history: { patchPath: path, nestedPatchPaths: [], branchName: "omp/task/W1" },
		}));
		await rig.capture.drain();
		expect(rig.journal.recoveries).toHaveLength(1);
		expect(rig.journal.recoveries[0]?.contradiction.kind).toBe("known");
		expect(rig.journal.manifests).toHaveLength(1);
		expect(rig.journal.manifests[0]?.digest).toBe(before);
		expect(rig.updates.some(update => update.kind === "recovery")).toBe(true);
	});

	test("a late sync failure is a recovery contradiction, not a second seal", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		await sealed(rig);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", aborted: true })],
			observedAt: f.clock.now + 5,
		});
		await rig.capture.drain();
		expect(rig.journal.manifests).toHaveLength(1);
		expect(rig.journal.recoveries.at(-1)?.contradiction.kind).toBe("known");
	});

	test("settlement is attached to the exact dispatch without a second journal record", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		await sealed(rig);
		const settlement = {
			runId: built.admission.key.runId,
			lane: "L1",
			spawnKey: "W1",
			parentId: "Main",
			dispatch: built.admission.key.dispatch,
			startedAt: built.admission.startedAt,
			observedAt: f.clock.now,
			report: missingAttemptReport(
				{ runId: built.admission.key.runId, parentId: "Main", spawnKey: "W1", startedAt: built.admission.startedAt },
				{ channel: "task-result", observedAt: f.clock.now },
			),
			citations: [],
		};
		rig.capture.noteSettlement(settlement);
		await rig.capture.drain();
		expect(rig.journal.manifests).toHaveLength(1);
		const sealedUpdates = rig.updates.filter(update => update.kind === "sealed");
		expect(sealedUpdates).toHaveLength(2);
		expect(sealedUpdates.at(-1)).toMatchObject({ settlement: { runId: "run-1", dispatch: "attempt:W1:10000:1" } });
	});

	test("a mismatched registry instance never becomes a selectable async candidate", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		const execution = nativeExecution({ jobId: "W1" });
		observeExecutionAck(rig, built, execution);
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			registryInstance: "other:instance",
			history: { patchPath: path, nestedPatchPaths: [] },
		}));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution })] },
			observedAt: f.clock.now + 4,
		});
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		if (manifests[0]?.bundle.kind === "unknown") expect(manifests[0].bundle.problem.code).toBe("registry-bundle-missing");
		expect(rig.capture.stats().unmatched["registry-other-execution"]).toBeGreaterThan(0);
	});

	test("a removed lifecycle event without an instance keeps the prior positive capture", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		const execution = nativeExecution({ jobId: "W1" });
		observeExecutionAck(rig, built, execution);
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution })] },
			observedAt: f.clock.now + 4,
		});
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			event: "removed",
			registryInstance: "",
			generation: null,
			childSessionFile: null,
			history: {},
		}));
		const manifests = await sealed(rig);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
	});

	test("a positive capture without a terminal seals an unknown terminal at the bounded deadline", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		const execution = nativeExecution({ jobId: "W1" });
		observeExecutionAck(rig, built, execution);
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.terminal.kind).toBe("unknown");
		expect(manifests[0]?.bundle.kind).toBe("unknown");
	});

	test("one native wait batch binds each admission by its exact resolved job", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const first = await admissionFor(f, { handle: "W1", dispatch: "attempt:A", toolCallId: "call-a" });
		const second = await admissionFor(f, { handle: "W2", dispatch: "attempt:B", toolCallId: "call-b" });
		const firstPath = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		const secondPath = await patch(f, "W2", "diff --git a/b b/b\n+B\n");
		const firstExecution = nativeExecution({ jobId: "W1-7", handle: "W1" });
		const secondExecution = nativeExecution({ jobId: "W2", handle: "W2" });
		for (const [built, path, execution] of [[first, firstPath, firstExecution], [second, secondPath, secondExecution]] as const) {
			rig.capture.track(built.admission);
			rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
			rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
			observeExecutionAck(rig, built, execution);
		}
		rig.capture.observeAsync({
			director: first.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [
					waitJob({ jobId: "W1-7", handle: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution: firstExecution }),
					waitJob({ jobId: "W2", handle: "W2", settledAtMs: f.clock.now + 4, durationMs: 5, execution: secondExecution }),
				],
			},
			observedAt: f.clock.now + 4,
		});
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(2);
		for (const manifest of manifests) expect(manifest.bundle.kind).toBe("root-only");
		const firstManifest = manifests.find(manifest => manifest.admission.item.handle === "W1");
		if (firstManifest?.terminal.kind === "known" && firstManifest.terminal.value.carrier !== "sync") {
			expect(firstManifest.terminal.value.job.jobId).toBe("W1-7");
		}
	});

	test("completed jobs with an invalid schema stay recovery-only on wait and push", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const waitBuilt = await admissionFor(f, { handle: "W1", dispatch: "attempt:A", toolCallId: "call-a" });
		const pushBuilt = await admissionFor(f, { handle: "W2", dispatch: "attempt:B", toolCallId: "call-b" });
		const waitPath = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		const pushPath = await patch(f, "W2", "diff --git a/b b/b\n+B\n");
		const waitExecution = nativeExecution({ jobId: "W1", handle: "W1" });
		const pushExecution = nativeExecution({ jobId: "W2", handle: "W2" });
		for (const [built, path, execution] of [[waitBuilt, waitPath, waitExecution], [pushBuilt, pushPath, pushExecution]] as const) {
			rig.capture.track(built.admission);
			rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
			rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
			observeExecutionAck(rig, built, execution);
		}
		rig.capture.observeAsync({
			director: waitBuilt.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [waitJob({ jobId: "W1", handle: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, structured: { status: "invalid" }, execution: waitExecution })],
			},
			observedAt: f.clock.now + 4,
		});
		rig.capture.observeAsync({
			director: pushBuilt.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W2", handle: "W2", durationMs: 5, schema: { status: "invalid" }, execution: pushExecution })] } },
			observedAt: f.clock.now + 4,
		});
		rig.capture.observeAsync({
			director: pushBuilt.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [waitJob({ jobId: "W2", handle: "W2", settledAtMs: f.clock.now + 4, durationMs: 5, structured: { status: "invalid" }, execution: pushExecution })],
			},
			observedAt: f.clock.now + 5,
		});
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(2);
		for (const manifest of manifests) {
			expect(manifest.bundle.kind).toBe("kept-only");
			expect(manifest.terminal.kind).toBe("known");
			if (manifest.terminal.kind === "known") expect(manifest.terminal.value.structured).toBe("invalid");
		}
	});

	test("a reused job id registered after the ack is a different execution", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		const execution = nativeExecution({ jobId: "W1-7" });
		observeExecutionAck(rig, built, execution);
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [waitJob({ jobId: "W1-7", settledAtMs: f.clock.now + 20, durationMs: 2, execution: nativeExecution({ jobId: "W1-7" }) })],
			},
			observedAt: f.clock.now + 20,
		});
		expect(rig.capture.stats().unmatched["async-late-other-execution"]).toBeGreaterThan(0);
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [waitJob({ jobId: "W1-7", settledAtMs: f.clock.now + 4, durationMs: 5, execution })],
			},
			observedAt: f.clock.now + 21,
		});
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
	});

	test("a timeout then a late typed patch and ref are copied into recovery only", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const content = "diff --git a/a b/a\n+LATE\n";
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		observeAck(rig, built, asyncAck({ jobId: "W1" }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W1", durationMs: 5 })] } },
			observedAt: f.clock.now + 1,
		});
		vi.advanceTimersByTime(30);
		expect(await sealed(rig)).toHaveLength(1);
		const latePath = await patch(f, "W1-late", content);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({
				handle: "W1",
				patchPath: latePath,
				hasRootChanges: true,
				nestedPatchPaths: [],
				nestedPatches: [],
				branchName: "omp/task/W1",
				branchBaseSha: "a".repeat(40),
			})],
			observedAt: f.clock.now + 40,
		});
		await rig.capture.drain();
		expect(rig.journal.manifests).toHaveLength(1);
		expect(rig.updates.filter(update => update.kind === "sealed")).toHaveLength(1);
		const recovery = rig.journal.recoveries.at(-1);
		expect(recovery?.facts.root.kind).toBe("known");
		expect(recovery?.facts.branch.kind).toBe("known");
		if (recovery?.facts.root.kind !== "known" || recovery.facts.root.value.copy.kind !== "known") return;
		await rm(latePath);
		const read = await rig.store.readPatch(recovery.facts.root.value.copy.value, {
			maxBytes: 1024,
			deadline: f.clock.now + 1_000,
			signal: new AbortController().signal,
		});
		expect(read.kind).toBe("known");
		if (read.kind === "known") expect(Buffer.from(read.value).toString("utf8")).toBe(content);
	});

	test("a benign late replay cannot suppress a later changed-part contradiction", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const root = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		const nestedPath = join(await realpath(f.artifactRoot), "W1.nested-late.patch");
		const nestedBytes = "diff --git a/x b/x\nnew file mode 100644\n";
		await writeFile(nestedPath, nestedBytes);
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: root, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		await sealed(rig);
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: root, nestedPatchPaths: [] } }));
		await rig.capture.drain();
		expect(rig.journal.recoveries).toHaveLength(1);
		expect(rig.journal.recoveries[0]?.contradiction.kind).toBe("unknown");
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({
				handle: "W1",
				patchPath: root,
				hasRootChanges: true,
				nestedPatchPaths: [nestedPath],
				nestedPatches: [{ relativePath: "nested-repo", patch: nestedBytes }],
			})],
			observedAt: f.clock.now + 5,
		});
		await rig.capture.drain();
		expect(rig.journal.recoveries).toHaveLength(2);
		const conflict = rig.journal.recoveries.at(-1)?.contradiction;
		expect(conflict?.kind).toBe("known");
		if (conflict?.kind === "known") expect(conflict.value.code).toBe("readiness-contradicted");
		const nested = rig.journal.recoveries.at(-1)?.facts.nested;
		expect(nested?.kind).toBe("known");
		if (nested?.kind === "known") expect(nested.value).toHaveLength(1);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({
				handle: "W1",
				patchPath: root,
				hasRootChanges: true,
				nestedPatchPaths: [nestedPath],
				nestedPatches: [{ relativePath: "nested-repo", patch: nestedBytes }],
			})],
			observedAt: f.clock.now + 6,
		});
		await rig.capture.drain();
		expect(rig.journal.recoveries).toHaveLength(2);
	});

	test("a claim or terminal contradiction during root proof never publishes stale readiness", async () => {
		const f = await fixture();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let proofs = 0;
		const delta: IntegrationDeltaPort = {
			async proveRoot(request) {
				proofs += 1;
				entered.resolve();
				await gate.promise;
				return {
					kind: "known",
					value: {
						...request,
						schema: "storm.integration-delta/v1",
						digest: "d".repeat(64),
						entries: [],
						expandedBytes: 0,
					},
				};
			},
			async verifyCheckoutInputs() {
				return { ok: true };
			},
			async observePresence() {
				return { kind: "unknown", problem: { code: "test", reason: "test" } };
			},
			async observeDirtyPaths() {
				return { kind: "unknown", problem: { code: "test", reason: "test" } };
			},
		};
		const rig = captureRig(f, { delta });
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		await entered.promise;
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", aborted: true })],
			observedAt: f.clock.now + 1,
		});
		gate.resolve();
		const manifests = await sealed(rig);
		expect(proofs).toBe(1);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		if (manifests[0]?.bundle.kind === "unknown") expect(manifests[0].bundle.problem.code).toBe("terminal-contradicted");
		expect(manifests[0]?.recovery.root.kind).toBe("known");
	});

	test("a mixed task envelope feeds both the sync row and the async acknowledgement", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const syncBuilt = await admissionFor(f, { handle: "W1", dispatch: "attempt:A", toolCallId: "call-1", itemIndex: 0 });
		const asyncBuilt = await admissionFor(f, { handle: "W2", dispatch: "attempt:B", toolCallId: "call-1", itemIndex: 1 });
		const syncPath = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		const asyncPath = await patch(f, "W2", "diff --git a/b b/b\n+B\n");
		const asyncExecution = nativeExecution({ jobId: "W2", handle: "W2", index: 1 });
		for (const built of [syncBuilt, asyncBuilt]) {
			rig.capture.track(built.admission);
			rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		}
		rig.capture.observeSync({
			director: syncBuilt.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", index: 0, patchPath: syncPath, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		rig.capture.observeAsync({
			director: asyncBuilt.admission.director,
			carrier: "ack",
			toolCallId: "call-1",
			details: {
				results: [],
				progress: [
					{ index: 0, id: "W1", status: "completed" },
					{ index: 1, id: "W2", status: "running" },
				],
				async: { state: "running", jobId: "W2", executions: [asyncExecution] },
			},
			observedAt: f.clock.now,
		});
		rig.capture.observeRegistry(registrySnapshot(f, asyncBuilt.admission, { history: { patchPath: asyncPath, nestedPatchPaths: [] } }));
		rig.capture.observeAsync({
			director: asyncBuilt.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [waitJob({ jobId: "W2", handle: "W2", settledAtMs: f.clock.now + 4, durationMs: 5, execution: asyncExecution })],
			},
			observedAt: f.clock.now + 4,
		});
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(2);
		const syncManifest = manifests.find(manifest => manifest.admission.item.handle === "W1");
		const asyncManifest = manifests.find(manifest => manifest.admission.item.handle === "W2");
		expect(syncManifest?.bundle.kind).toBe("root-only");
		expect(asyncManifest?.bundle.kind).toBe("root-only");
	});

	test("an acknowledgement without the owning call id cannot bind a job", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: asyncAck({ jobId: "W1", executions: [nativeExecution({ jobId: "W1" })] }),
			observedAt: f.clock.now,
		});
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		if (manifests[0]?.bundle.kind === "unknown") expect(manifests[0].bundle.problem.code).toBe("async-ack-unbound");
		expect(rig.capture.stats().unmatched["async-ack-unbound"]).toBeGreaterThan(0);
	});

	test("stock async rows are recovery only even when wait and push agree", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		observeAck(rig, built, asyncAck({ jobId: "W1" }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5 })] },
			observedAt: f.clock.now + 4,
		});
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W1", durationMs: 5 })] } },
			observedAt: f.clock.now + 5,
		});
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		expect(manifests[0]?.terminal.kind).toBe("unknown");
		expect(manifests[0]?.recovery.root.kind).toBe("known");
		expect(rig.capture.stats().unmatched["async-ack-stock"]).toBeGreaterThan(0);
		expect(rig.capture.stats().unmatched["async-stock-unproven"]).toBeGreaterThan(0);
	});

	test("an execution proof naming another owner is refused", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		const execution = nativeExecution({ jobId: "W1", owner: "Other" });
		observeExecutionAck(rig, built, execution);
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("unknown");
		if (manifests[0]?.bundle.kind === "unknown") expect(manifests[0].bundle.problem.code).toBe("async-ack-unproven");
	});

	test("a journal refusal is an unavailable diagnostic, never a durable capture", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		rig.journal.fail = true;
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		await rig.capture.drain();
		expect(rig.journal.manifests).toHaveLength(0);
		expect(rig.updates).toHaveLength(1);
		expect(rig.updates[0]?.kind).toBe("unavailable");
	});

	test("two byte-identical admissions are two candidates", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const first = await admissionFor(f, { handle: "W1", dispatch: "attempt:A:1" });
		const second = await admissionFor(f, { handle: "W2", dispatch: "attempt:B:1" });
		await patch(f, "W1", "same\n");
		await patch(f, "W2", "same\n");
		rig.capture.track(first.admission);
		rig.capture.track(second.admission);
		for (const [built, handle] of [[first, "W1"], [second, "W2"]] as const) {
			rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
			rig.capture.observeSync({
				director: built.admission.director,
				toolCallId: "call-1",
				results: [syncResult({ handle, patchPath: join(await realpath(f.artifactRoot), `${handle}.patch`), hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
				observedAt: f.clock.now,
			});
		}
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(2);
		expect(new Set(manifests.map(manifest => manifest.admission.candidateId)).size).toBe(2);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
		expect(manifests[1]?.bundle.kind).toBe("root-only");
	});
});

describe("native effect end", () => {
	test("an exact sync terminal releases once even when the capture is recovery-only", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const ended: FrozenIntegrationAdmission[] = [];
		const rig = captureRig(f, { onNativeEnded: admission => { ended.push(admission); } });
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.journal.fail = true;
		rig.capture.track(built.admission);
		const result = syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] });
		rig.capture.observeSync({ director: built.admission.director, toolCallId: "call-1", results: [result], observedAt: f.clock.now });
		expect(ended).toHaveLength(1);
		expect(ended[0]?.candidateId).toBe(built.admission.candidateId);
		rig.capture.observeSync({ director: built.admission.director, toolCallId: "call-1", results: [result], observedAt: f.clock.now + 1 });
		expect(ended).toHaveLength(1);
		await rig.capture.drain();
		vi.advanceTimersByTime(30);
		await rig.capture.drain();
		expect(ended).toHaveLength(1);
		expect(rig.journal.manifests).toHaveLength(0);
		expect(rig.updates.some(update => update.kind === "unavailable")).toBe(true);
		rig.capture.stop();
	});

	test("a sync result without an exit code keeps the slot held until an exact terminal arrives", async () => {
		const f = await fixture();
		const ended: FrozenIntegrationAdmission[] = [];
		const rig = captureRig(f, { onNativeEnded: admission => { ended.push(admission); } });
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", exitCode: null, patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		expect(ended).toHaveLength(0);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now + 1,
		});
		expect(ended).toHaveLength(1);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now + 2,
		});
		expect(ended).toHaveLength(1);
		rig.capture.stop();
	});

	test("an ack-linked exact terminal releases once; replays do not release again", async () => {
		const f = await fixture();
		const ended: FrozenIntegrationAdmission[] = [];
		const rig = captureRig(f, { onNativeEnded: admission => { ended.push(admission); } });
		const built = await admissionFor(f);
		rig.capture.track(built.admission);
		const execution = nativeExecution({ jobId: "W1" });
		observeExecutionAck(rig, built, execution);
		expect(ended).toHaveLength(0);
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution })] },
			observedAt: f.clock.now + 4,
		});
		expect(ended).toHaveLength(1);
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W1", durationMs: 5, execution })] } },
			observedAt: f.clock.now + 5,
		});
		expect(ended).toHaveLength(1);
		rig.capture.stop();
	});

	test("a terminal buffered before the ack releases only when the ack exact-binds it", async () => {
		const f = await fixture();
		const ended: FrozenIntegrationAdmission[] = [];
		const rig = captureRig(f, { onNativeEnded: admission => { ended.push(admission); } });
		const built = await admissionFor(f);
		rig.capture.track(built.admission);
		const execution = nativeExecution({ jobId: "W1" });
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5, execution })] },
			observedAt: f.clock.now + 4,
		});
		expect(ended).toHaveLength(0);
		observeExecutionAck(rig, built, execution);
		expect(ended).toHaveLength(1);
		rig.capture.stop();
	});

	test("stock rows and an ack without a terminal never release the slot", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const ended: FrozenIntegrationAdmission[] = [];
		const rig = captureRig(f, { onNativeEnded: admission => { ended.push(admission); } });
		const stockBuilt = await admissionFor(f, { handle: "W1", dispatch: "attempt:A", toolCallId: "call-a" });
		const ackOnlyBuilt = await admissionFor(f, { handle: "W2", dispatch: "attempt:B", toolCallId: "call-b" });
		const stockPath = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		const ackOnlyPath = await patch(f, "W2", "diff --git a/b b/b\n+B\n");
		for (const built of [stockBuilt, ackOnlyBuilt]) {
			rig.capture.track(built.admission);
			rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		}
		rig.capture.observeRegistry(registrySnapshot(f, stockBuilt.admission, { history: { patchPath: stockPath, nestedPatchPaths: [] } }));
		observeAck(rig, stockBuilt, asyncAck({ jobId: "W1" }));
		rig.capture.observeAsync({
			director: stockBuilt.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [waitJob({ jobId: "W1", settledAtMs: f.clock.now + 4, durationMs: 5 })] },
			observedAt: f.clock.now + 4,
		});
		rig.capture.observeAsync({
			director: stockBuilt.admission.director,
			carrier: "push",
			details: { details: { jobs: [pushJob({ jobId: "W1", durationMs: 5 })] } },
			observedAt: f.clock.now + 5,
		});
		rig.capture.observeRegistry(registrySnapshot(f, ackOnlyBuilt.admission, { history: { patchPath: ackOnlyPath, nestedPatchPaths: [] } }));
		observeExecutionAck(rig, ackOnlyBuilt, nativeExecution({ jobId: "W2", handle: "W2" }));
		expect(ended).toHaveLength(0);
		await rig.capture.drain();
		vi.advanceTimersByTime(30);
		await rig.capture.drain();
		expect(ended).toHaveLength(0);
		rig.capture.stop();
	});

	test("an exact sync result with the wrong call/index/handle never releases the slot", async () => {
		const f = await fixture();
		const ended: FrozenIntegrationAdmission[] = [];
		const rig = captureRig(f, { onNativeEnded: admission => { ended.push(admission); } });
		const built = await admissionFor(f, { itemIndex: 1 });
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", index: 0, patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		expect(ended).toHaveLength(0);
		rig.capture.stop();
	});

	test("a throwing release callback is counted, not retried or allowed to break capture", async () => {
		const f = await fixture();
		let calls = 0;
		const rig = captureRig(f, {
			onNativeEnded: () => {
				calls += 1;
				throw new Error("release failed");
			},
		});
		const built = await admissionFor(f);
		rig.capture.track(built.admission);
		const result = syncResult({ handle: "W1", exitCode: 0, nestedPatchPaths: [], nestedPatches: [] });
		rig.capture.observeSync({ director: built.admission.director, toolCallId: "call-1", results: [result], observedAt: f.clock.now });
		rig.capture.observeSync({ director: built.admission.director, toolCallId: "call-1", results: [result], observedAt: f.clock.now + 1 });
		expect(calls).toBe(1);
		expect(rig.capture.stats().unmatched["native-ended-callback-failed"]).toBe(1);
		rig.capture.stop();
	});
});

describe("owned bytes", () => {
	test("a symlink, hard link or over-cap patch produces no owned copy", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		const small = new IntegrationArtifactStore({ agentDir: f.agentDir, now: () => f.clock.now, maxObjectBytes: 8 });
		const outside = join(f.tmp, "outside.patch");
		await writeFile(outside, "0123456789");
		const symlinkPath = join(f.artifactRoot, "W1.patch");
		await symlink(outside, symlinkPath);
		const linked = await small.copyPatch({ admission: built.admission, kind: "root", nativePath: symlinkPath });
		expect(linked.kind).toBe("unknown");
		await rm(symlinkPath);
		await link(outside, symlinkPath);
		const hard = await small.copyPatch({ admission: built.admission, kind: "root", nativePath: symlinkPath });
		expect(hard.kind).toBe("unknown");
		await rm(symlinkPath);
		await writeFile(symlinkPath, "0123456789");
		const large = await small.copyPatch({ admission: built.admission, kind: "root", nativePath: symlinkPath });
		expect(large.kind).toBe("unknown");
	});

	test("a host path through an artifact-root alias still binds the canonical root", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		const realRoot = await realpath(f.artifactRoot);
		const alias = join(f.tmp, "artifact-alias");
		await symlink(realRoot, alias);
		const path = join(alias, "W1.patch");
		await writeFile(path, "alias\n");
		const store = new IntegrationArtifactStore({ agentDir: f.agentDir, now: () => f.clock.now });
		const copied = await store.copyPatch({ admission: built.admission, kind: "root", nativePath: path });
		expect(copied.kind).toBe("known");
	});

	test("an owner-profile byte cap refuses without evicting existing objects", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		const small = new IntegrationArtifactStore({ agentDir: f.agentDir, now: () => f.clock.now, maxStoreBytes: 4 });
		const path = await patch(f, "W1", "12345");
		const refused = await small.copyPatch({ admission: built.admission, kind: "root", nativePath: path });
		expect(refused.kind).toBe("unknown");
		if (refused.kind === "unknown") expect(refused.problem.code).toBe("store-capacity");
	});

	test("deleting the native file after a frozen copy leaves the owned bytes readable", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		const rig = captureRig(f);
		const path = await patch(f, "W1", "owned\n");
		rig.capture.track(built.admission);
		claimCapture(rig, f, built);
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("root-only");
		await rm(path);
		if (manifest?.bundle.kind !== "root-only") return;
		const read = await rig.store.readPatch(manifest.bundle.root, {
			maxBytes: 64,
			deadline: f.clock.now + 1_000,
			signal: new AbortController().signal,
		});
		expect(read.kind).toBe("known");
		if (read.kind === "known") expect(Buffer.from(read.value).toString("utf8")).toBe("owned\n");
	});
});

describe("native slot and child entry", () => {
	test("slot reservation is exclusive and an old release never clears a newer owner", async () => {
		const f = await fixture();
		const target = await targetOf(f);
		const item = { toolCallId: "call-1", itemIndex: 0, handle: "W1" };
		const firstKey = keyOf({ runId: "run-1", dispatch: "attempt:1" });
		const secondKey = keyOf({ runId: "run-1", dispatch: "attempt:2" });
		const nativeSlotPath = join(f.worktreesDir, "t000000001");
		expect(await f.store.reserveSlot({ key: firstKey, target, item, profile: "test", nativeSlotPath: join(f.repo, "t000000001") }))
			.toMatchObject({ kind: "unknown", problem: { code: "slot-path-unproved" } });
		const first = await f.store.reserveSlot({ key: firstKey, target, item, profile: "test", nativeSlotPath });
		expect(first.kind).toBe("known");
		const contended = await f.store.reserveSlot({ key: secondKey, target, item, profile: "test", nativeSlotPath });
		expect(contended.kind).toBe("unknown");
		if (first.kind !== "known") return;
		expect(await f.store.releaseSlot(first.value, "not-dispatched")).toEqual({ ok: true });
		const second = await f.store.reserveSlot({ key: secondKey, target, item, profile: "test", nativeSlotPath });
		expect(second.kind).toBe("known");
		expect(await f.store.releaseSlot(first.value, "not-dispatched")).toMatchObject({ ok: false });
		if (second.kind !== "known") return;
		const again = await f.store.reserveSlot({ key: secondKey, target, item, profile: "test", nativeSlotPath });
		expect(again.kind).toBe("known");
		if (again.kind === "known") expect(again.value.ownerToken).toBe(second.value.ownerToken);
	});

	test("the same slot key cannot be reused for a different handle", async () => {
		const f = await fixture();
		const target = await targetOf(f);
		const key = keyOf({ runId: "run-1", dispatch: "attempt:1" });
		const first = await f.store.reserveSlot({
			key,
			target,
			item: { toolCallId: "call-1", itemIndex: 0, handle: "W1" },
			profile: "test",
			nativeSlotPath: join(f.worktreesDir, "t000000001"),
		});
		expect(first.kind).toBe("known");
		const reused = await f.store.reserveSlot({
			key,
			target,
			item: { toolCallId: "call-1", itemIndex: 0, handle: "W2" },
			profile: "test",
			nativeSlotPath: join(f.worktreesDir, "t000000002"),
		});
		expect(reused.kind).toBe("unknown");
	});

	test("prepared admission is bound to the exact worker attempt and abandon revokes it", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const read = await f.store.readPrepared({ key: built.worker.key, attempt: built.worker.attempt });
		expect(read.kind).toBe("known");
		const wrongAttempt = await f.store.readPrepared({ key: built.worker.key, attempt: randomUUID() });
		expect(wrongAttempt.kind).toBe("unknown");
		expect(await f.store.abandonPrepared(built.admission)).toEqual({ ok: true });
		const after = await f.store.readPrepared({ key: built.worker.key, attempt: built.worker.attempt });
		expect(after.kind).toBe("unknown");
	});

	test("child entry proves canonical cwd, marker, admin and consumed inputs before publishing a claim", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const slotPath = built.admission.slot.slotPath;
		const checkout = join(slotPath, "m");
		const checkoutGit = join(checkout, ".git");
		await mkdir(join(checkoutGit, "objects", "info"), { recursive: true });
		await writeFile(join(slotPath, ".omp-isolation-owner.json"), JSON.stringify({ pid: process.pid, id: "W1", startToken: "test-start" }));
		await writeFile(join(checkoutGit, "config"), "[extensions]\n\tobjectformat = sha1\n");
		await writeFile(join(checkoutGit, "objects", "info", "alternates"), `${f.objectsDir}\n`);
		await writeFile(join(checkoutGit, "index"), "index\n");
		const sessionIdentity = await identity(f.childSessionFile);
		const entry: ObservationIdentity = {
			registryInstance: "main:test",
			generation: 2,
			childSessionFile: sessionIdentity,
		};
		const wrongCwd = join(f.tmp, "other-checkout");
		await mkdir(wrongCwd, { recursive: true });
		const refused = await f.store.claimAtEntry({
			admission: built.admission,
			worker: built.worker,
			entry,
			childCwd: wrongCwd,
			guardBuild: "guard-1",
			live: () => ({ ok: true }),
			verifyInputs: async () => ({ ok: true }),
		});
		expect(refused.kind).toBe("unknown");
		const claim = await f.store.claimAtEntry({
			admission: built.admission,
			worker: built.worker,
			entry,
			childCwd: checkout,
			guardBuild: "guard-1",
			live: () => ({ ok: true }),
			verifyInputs: async () => ({ ok: true }),
		});
		expect(claim.kind).toBe("known");
		if (claim.kind !== "known") return;
		expect(claim.value.checkout.canonicalPath).toBe(await realpath(checkout));
		expect(claim.value.checkoutGitDir.canonicalPath).toBe(await realpath(checkoutGit));
		const durable = await f.store.readClaim(built.admission.key);
		expect(durable.kind).toBe("known");
	});

	test("a slot marker naming another handle refuses the claim", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const slotPath = built.admission.slot.slotPath;
		const checkout = join(slotPath, "m");
		const checkoutGit = join(checkout, ".git");
		await mkdir(join(checkoutGit, "objects", "info"), { recursive: true });
		await writeFile(join(slotPath, ".omp-isolation-owner.json"), JSON.stringify({ pid: process.pid, id: "OTHER", startToken: "test-start" }));
		await writeFile(join(checkoutGit, "config"), "[extensions]\n\tobjectformat = sha1\n");
		await writeFile(join(checkoutGit, "objects", "info", "alternates"), `${f.objectsDir}\n`);
		const sessionIdentity = await identity(f.childSessionFile);
		const refused = await f.store.claimAtEntry({
			admission: built.admission,
			worker: built.worker,
			entry: { registryInstance: "main:test", generation: 2, childSessionFile: sessionIdentity },
			childCwd: checkout,
			guardBuild: "guard-1",
			live: () => ({ ok: true }),
			verifyInputs: async () => ({ ok: true }),
		});
		expect(refused.kind).toBe("unknown");
	});

	test("a consumed-input drift refuses the claim before it is durable", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const slotPath = built.admission.slot.slotPath;
		const checkout = join(slotPath, "m");
		const checkoutGit = join(checkout, ".git");
		await mkdir(join(checkoutGit, "objects", "info"), { recursive: true });
		await writeFile(join(slotPath, ".omp-isolation-owner.json"), JSON.stringify({ pid: process.pid, id: "W1", startToken: "test-start" }));
		await writeFile(join(checkoutGit, "config"), "[extensions]\n\tobjectformat = sha1\n");
		await writeFile(join(checkoutGit, "objects", "info", "alternates"), `${f.objectsDir}\n`);
		const sessionIdentity = await identity(f.childSessionFile);
		const refused = await f.store.claimAtEntry({
			admission: built.admission,
			worker: built.worker,
			entry: { registryInstance: "main:test", generation: 2, childSessionFile: sessionIdentity },
			childCwd: checkout,
			guardBuild: "guard-1",
			live: () => ({ ok: true }),
			verifyInputs: async () => ({ ok: false, problem: { code: "input-drift", reason: "consumed image changed" } }),
		});
		expect(refused.kind).toBe("unknown");
		expect(await f.store.readClaim(built.admission.key)).toMatchObject({ kind: "unknown" });
	});
});

describe("scale and bounded refusal", () => {
	test("a copy held at a barrier does not block another candidate's seal", async () => {
		const f = await fixture();
		const base = new IntegrationArtifactStore({ agentDir: f.agentDir, now: () => f.clock.now });
		const gate = Promise.withResolvers<void>();
		let held = false;
		const gated: CaptureCopyPort = {
			async copyPatch(input) {
				if (input.kind === "root" && input.admission.item.handle === "W1" && !held) {
					held = true;
					await gate.promise;
				}
				return base.copyPatch(input);
			},
		};
		const rig = captureRig(f, { artifacts: gated });
		const first = await admissionFor(f, { handle: "W1", dispatch: "attempt:A", toolCallId: "call-a" });
		const second = await admissionFor(f, { handle: "W2", dispatch: "attempt:B", toolCallId: "call-b" });
		rig.capture.track(first.admission);
		rig.capture.track(second.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, first.admission));
		rig.capture.observeClaim(entryFor(f), claimFor(f, second.admission));
		rig.capture.observeSync({
			director: first.admission.director,
			toolCallId: "call-a",
			results: [syncResult({ handle: "W1", patchPath: await patch(f, "W1", "one\n"), hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		rig.capture.observeSync({
			director: second.admission.director,
			toolCallId: "call-b",
			results: [syncResult({ handle: "W2", patchPath: await patch(f, "W2", "two\n"), hasRootChanges: true, nestedPatchPaths: [], nestedPatches: [] })],
			observedAt: f.clock.now,
		});
		await rig.journal.waitFor(1);
		expect(rig.journal.manifests).toHaveLength(1);
		expect(rig.journal.manifests[0]?.admission.item.handle).toBe("W2");
		gate.resolve();
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(2);
	});

	test("sixteen independent dispatches seal independently; one broken copy does not block the rest", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built: Array<{ handle: string; admission: FrozenIntegrationAdmission }> = [];
		for (let index = 0; index < 16; index += 1) {
			const value = await admissionFor(f, { handle: `W${index}`, dispatch: `attempt:${index}`, toolCallId: `call-${index}` });
			built.push({ handle: `W${index}`, admission: value.admission });
			rig.capture.track(value.admission);
			rig.capture.observeClaim(entryFor(f), claimFor(f, value.admission));
			if (index === 3) continue;
			const path = await patch(f, `W${index}`, `patch-${index}\n`);
			rig.capture.observeSync({
				director: value.admission.director,
				toolCallId: `call-${index}`,
				results: [syncResult({ handle: `W${index}`, patchPath: path, hasRootChanges: true })],
				observedAt: f.clock.now,
			});
		}
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(15);
		expect(rig.capture.stats().unmatched).toBeDefined();
	});

	test("one hundred small admissions keep one stable candidate and one manifest each", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		for (let index = 0; index < 100; index += 1) {
			const handle = `N${index}`;
			const built = await admissionFor(f, { handle, dispatch: `attempt:${index}`, toolCallId: `call-${index}` });
			rig.capture.track(built.admission);
			rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
			const path = await patch(f, handle, `small-${index}\n`);
			rig.capture.observeSync({
				director: built.admission.director,
				toolCallId: `call-${index}`,
				results: [syncResult({ handle, patchPath: path, hasRootChanges: true })],
				observedAt: f.clock.now,
			});
			// Duplicate metadata is not evidence and must not mint another candidate or manifest.
			rig.capture.observeSync({
				director: built.admission.director,
				toolCallId: `call-${index}`,
				results: [syncResult({ handle, patchPath: path, hasRootChanges: true })],
				observedAt: f.clock.now,
			});
		}
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(100);
		expect(new Set(manifests.map(manifest => manifest.admission.candidateId)).size).toBe(100);
	});
});
