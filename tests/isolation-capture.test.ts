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
	const slot = await f.store.reserveSlot({ key, target, item, profile: "test" });
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

function syncResult(input: {
	handle: string;
	patchPath?: string;
	hasRootChanges?: boolean;
	nestedPatchPaths?: readonly string[];
	nestedPatches?: readonly { relativePath: string; patch: string }[];
	isolated?: boolean;
	exitCode?: number;
	aborted?: boolean;
	branchName?: string;
	branchBaseSha?: string;
}) {
	return {
		id: input.handle,
		isolated: input.isolated ?? true,
		exitCode: input.exitCode ?? 0,
		aborted: input.aborted ?? false,
		...(input.patchPath === undefined ? {} : { patchPath: input.patchPath }),
		...(input.hasRootChanges === undefined ? {} : { hasRootChanges: input.hasRootChanges }),
		...(input.nestedPatchPaths === undefined ? {} : { nestedPatchPaths: [...input.nestedPatchPaths] }),
		...(input.nestedPatches === undefined ? {} : { nestedPatches: [...input.nestedPatches] }),
		...(input.branchName === undefined ? {} : { branchName: input.branchName }),
		...(input.branchBaseSha === undefined ? {} : { branchBaseSha: input.branchBaseSha }),
	};
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
		rig.capture.observeSync({
			director: built.admission.director,
			toolCallId: "call-1",
			results: [syncResult({ handle: "W1", patchPath: path, hasRootChanges: false })],
			observedAt: f.clock.now,
		});
		const [manifest] = await sealed(rig);
		expect(manifest?.bundle.kind).toBe("unknown");
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
	test("wait and push are one terminal identity; a push then empty wait mints once", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		const entry = entryFor(f);
		rig.capture.observeClaim(entry, claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			history: { patchPath: path, nestedPatchPaths: [] },
		}));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: { results: [], progress: [{ index: 0, id: "W1", status: "running" }], async: { state: "running", jobId: "W1" } },
			observedAt: f.clock.now,
		});
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: {
				customType: "async-result",
				details: { jobs: [{ jobId: "W1", type: "task", status: "completed", agentId: "W1" }] },
			},
			observedAt: f.clock.now + 1,
		});
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [] },
			observedAt: f.clock.now + 2,
		});
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
		expect(manifests[0]?.terminal.kind).toBe("known");
		if (manifests[0]?.terminal.kind === "known") expect(manifests[0].terminal.value.carrier).toBe("push");
	});

	test("ack after terminal and a suffixed actual job id still join the same first execution", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: {
				op: "wait",
				jobs: [{ id: "W1-7", type: "task", status: "completed", agentUrlId: "W1", settledAtMs: f.clock.now + 5, durationMs: 2 }],
			},
			observedAt: f.clock.now + 5,
		});
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: { results: [], progress: [{ index: 0, id: "W1", status: "running" }], async: { state: "running", jobId: "W1" } },
			observedAt: f.clock.now + 6,
		});
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.bundle.kind).toBe("root-only");
		if (manifests[0]?.terminal.kind === "known") {
			expect(manifests[0].terminal.value.carrier).toBe("wait");
			if (manifests[0].terminal.value.carrier !== "sync") expect(manifests[0].terminal.value.job.jobId).toBe("W1-7");
		}
	});

	test("a registry list missing nestedPatchPaths is unknown, never empty", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const rig = captureRig(f);
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "");
		rig.capture.track(built.admission);
		rig.capture.observeClaim(entryFor(f), claimFor(f, built.admission));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: { results: [], progress: [{ index: 0, id: "W1", status: "running" }], async: { state: "running", jobId: "W1" } },
			observedAt: f.clock.now,
		});
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path } }));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [{ jobId: "W1", type: "task", status: "completed", agentId: "W1" }] } },
			observedAt: f.clock.now + 1,
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
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: { results: [], progress: [{ index: 0, id: "W1", status: "running" }], async: { state: "running", jobId: "W1" } },
			observedAt: f.clock.now,
		});
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [{ id: "W1", type: "task", status: "completed", agentUrlId: "W1", settledAtMs: f.clock.now + 5, durationMs: 2 }] },
			observedAt: f.clock.now + 5,
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
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: { results: [], progress: [{ index: 0, id: "W1", status: "running" }], async: { state: "running", jobId: "W1" } },
			observedAt: f.clock.now,
		});
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			registryInstance: "other:instance",
			history: { patchPath: path, nestedPatchPaths: [] },
		}));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "wait",
			details: { op: "wait", jobs: [{ id: "W1", type: "task", status: "completed", agentUrlId: "W1", settledAtMs: f.clock.now + 5, durationMs: 2 }] },
			observedAt: f.clock.now + 5,
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
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: { results: [], progress: [{ index: 0, id: "W1", status: "running" }], async: { state: "running", jobId: "W1" } },
			observedAt: f.clock.now,
		});
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, {
			event: "removed",
			registryInstance: "",
			generation: null,
			childSessionFile: null,
			history: {},
		}));
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "push",
			details: { details: { jobs: [{ jobId: "W1", type: "task", status: "completed", agentId: "W1" }] } },
			observedAt: f.clock.now + 1,
		});
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
		rig.capture.observeAsync({
			director: built.admission.director,
			carrier: "ack",
			details: { results: [], progress: [{ index: 0, id: "W1", status: "running" }], async: { state: "running", jobId: "W1" } },
			observedAt: f.clock.now,
		});
		rig.capture.observeRegistry(registrySnapshot(f, built.admission, { history: { patchPath: path, nestedPatchPaths: [] } }));
		vi.advanceTimersByTime(30);
		const manifests = await sealed(rig);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.terminal.kind).toBe("unknown");
		expect(manifests[0]?.bundle.kind).toBe("unknown");
	});

	test("a journal refusal is an unavailable diagnostic, never a durable capture", async () => {
		const f = await fixture();
		const rig = captureRig(f);
		rig.journal.fail = true;
		const built = await admissionFor(f);
		const path = await patch(f, "W1", "diff --git a/a b/a\n+A\n");
		rig.capture.track(built.admission);
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
		const first = await f.store.reserveSlot({ key: firstKey, target, item, profile: "test" });
		expect(first.kind).toBe("known");
		const contended = await f.store.reserveSlot({ key: secondKey, target, item, profile: "test" });
		expect(contended.kind).toBe("unknown");
		if (first.kind !== "known") return;
		expect(await f.store.releaseSlot(first.value, "not-dispatched")).toEqual({ ok: true });
		const second = await f.store.reserveSlot({ key: secondKey, target, item, profile: "test" });
		expect(second.kind).toBe("known");
		expect(await f.store.releaseSlot(first.value, "not-dispatched")).toMatchObject({ ok: false });
		if (second.kind !== "known") return;
		const again = await f.store.reserveSlot({ key: secondKey, target, item, profile: "test" });
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
		});
		expect(first.kind).toBe("known");
		const reused = await f.store.reserveSlot({
			key,
			target,
			item: { toolCallId: "call-1", itemIndex: 0, handle: "W2" },
			profile: "test",
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
