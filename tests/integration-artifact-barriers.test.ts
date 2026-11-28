/**
 * Slice A barrier cases: the admitted artifact root must still be the same directory at the actual native open/read,
 * and a child-entry claim must be re-authorized after async input verification. Fixtures are local so the frozen
 * shared fixtures and isolation-capture.test.ts stay untouched; the realpath hook is a one-shot controlled barrier,
 * not a source-shape check.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdmissionKey,
	FrozenIntegrationAdmission,
	IntegrationTarget,
	ObservationIdentity,
	SpaceIdentity,
} from "../src/runtime/integration-admission.ts";
import type { WorkerAdmissionRecord } from "../src/worker-admission.ts";

const realFs = require("node:fs/promises");
/** Fired once after the canonical spelling of a realpath result is known; models an ancestor swap mid-copy. */
let afterRealpath: ((canonicalPath: string) => Promise<void>) | undefined;

mock.module("node:fs/promises", () => ({
	...realFs,
	realpath: async (path: string) => {
		const canonical = await realFs.realpath(path);
		await afterRealpath?.(canonical);
		return canonical;
	},
}));

// Static import cannot work: the fs mock must be registered before this module binds node:fs/promises.
const {
	IntegrationAdmissionStore,
	IntegrationArtifactStore,
	INTEGRATION_ADMISSION_SCHEMA,
	INTEGRATION_POLICY_HOST,
	integrationCandidateId,
} = await import("../src/runtime/integration-artifacts.ts");

const cleanups: string[] = [];
afterEach(async () => {
	afterRealpath = undefined;
	await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
afterAll(() => {
	mock.restore();
});

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
	readonly store: InstanceType<typeof IntegrationAdmissionStore>;
	readonly clock: { now: number };
}

async function fixture(): Promise<Fixture> {
	const tmp = await mkdtemp(join(tmpdir(), "storm-a-barriers-"));
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

interface BuiltAdmission {
	readonly admission: FrozenIntegrationAdmission;
	readonly worker: WorkerAdmissionRecord;
}

async function admissionFor(f: Fixture): Promise<BuiltAdmission> {
	const handle = "W1";
	const runId = "run-1";
	const dispatch = "attempt:W1:10000:1";
	const toolCallId = "call-1";
	const itemIndex = 0;
	const key: AdmissionKey = { schema: INTEGRATION_ADMISSION_SCHEMA, runId, dispatch };
	const target = await targetOf(f);
	const item = { toolCallId, itemIndex, handle };
	const slot = await f.store.reserveSlot({ key, target, item, profile: "test", nativeSlotPath: join(f.worktreesDir, "t000000001") });
	if (slot.kind === "unknown") throw new Error(`slot refused: ${slot.problem.code}`);
	const workerKey = createHash("sha256").update(`${f.tmp}\0${handle}\0${dispatch}`).digest("hex");
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
		subject: { kind: "unplanned" },
		policy,
		slot: slot.value,
		startedAt: f.clock.now,
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

/** Materialize the child checkout the host would expose, including the shared source ODB. */
async function childReady(f: Fixture, built: BuiltAdmission): Promise<{ checkout: string; entry: ObservationIdentity }> {
	const handle = built.admission.item.handle;
	const slotPath = built.admission.slot.slotPath;
	const checkout = join(slotPath, "m");
	const checkoutGit = join(checkout, ".git");
	await mkdir(join(checkoutGit, "objects", "info"), { recursive: true });
	await writeFile(join(slotPath, ".omp-isolation-owner.json"), JSON.stringify({ pid: process.pid, id: handle, startToken: "test-start" }));
	await writeFile(join(checkoutGit, "config"), "[extensions]\n\tobjectformat = sha1\n");
	await writeFile(join(checkoutGit, "objects", "info", "alternates"), `${f.objectsDir}\n`);
	await writeFile(join(checkoutGit, "index"), "index\n");
	return {
		checkout,
		entry: { registryInstance: "main:test", generation: 2, childSessionFile: await identity(f.childSessionFile) },
	};
}

describe("artifact root replacement", () => {
	test("a same-spelling root replacement after admission verification publishes no replacement bytes", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		const admissionRoot = built.admission.artifactRoot.canonicalPath;
		const nativePath = join(f.artifactRoot, "W1.patch");
		const admittedBytes = "admitted-bytes\n";
		const replacementBytes = "replacement-bytes\n";
		await writeFile(nativePath, admittedBytes);
		let fired = false;
		afterRealpath = async canonical => {
			if (fired || canonical !== admissionRoot) return;
			fired = true;
			// Replace the whole admitted directory at the exact same spelling while the copy is between its root
			// preflight and the native file open. The replacement child has the expected name and a valid regular-file
			// shape; only the admitted directory identity distinguishes it.
			await rename(admissionRoot, `${admissionRoot}.aside-${randomUUID()}`);
			await mkdir(admissionRoot);
			await writeFile(join(admissionRoot, "W1.patch"), replacementBytes);
		};
		const store = new IntegrationArtifactStore({ agentDir: f.agentDir, now: () => f.clock.now });
		const copied = await store.copyPatch({ admission: built.admission, kind: "root", nativePath });
		expect(fired).toBe(true);
		expect(copied.kind).toBe("unknown");
		if (copied.kind === "unknown") expect(copied.problem.code).toBe("artifact-root-replaced");
		// Fail-closed: neither the replacement nor the admitted bytes may become a selectable owned object.
		expect(await readdir(store.objectsDir).catch(() => [])).toEqual([]);
		await expect(stat(join(store.objectsDir, createHash("sha256").update(replacementBytes).digest("hex")))).rejects.toThrow();
	});
});

describe("child entry after async verification", () => {
	test("an independent native clone does not borrow objects, but shared Git administration is refused", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const { checkout, entry } = await childReady(f, built);
		const gitDir = join(checkout, ".git");
		await rm(join(gitDir, "objects", "info", "alternates"));
		const input = {
			admission: built.admission, worker: built.worker, entry, childCwd: checkout,
			guardBuild: "guard-1", live: () => ({ ok: true } as const), verifyInputs: async () => ({ ok: true } as const),
		};
		await writeFile(join(gitDir, "commondir"), `${f.gitDir}\n`);
		expect(await f.store.claimAtEntry(input)).toMatchObject({ kind: "unknown", problem: { code: "entry-admin-shared" } });
		await rm(join(gitDir, "commondir"));
		expect(await f.store.claimAtEntry(input)).toMatchObject({
			kind: "known", value: { sourceOdb: built.admission.target.sourceOdb },
		});
	});

	test("a stale admission object with the same candidate id cannot seed a claim", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const { checkout, entry } = await childReady(f, built);
		const stale: FrozenIntegrationAdmission = {
			...built.admission,
			policy: { ...built.admission.policy, id: "proof-stale" },
		};
		const refused = await f.store.claimAtEntry({
			admission: stale,
			worker: built.worker,
			entry,
			childCwd: checkout,
			guardBuild: "guard-1",
			live: () => ({ ok: true }),
			verifyInputs: async () => ({ ok: true }),
		});
		expect(refused.kind).toBe("unknown");
		if (refused.kind === "unknown") expect(refused.problem.code).toBe("entry-admission-mismatch");
		expect(await f.store.readClaim(built.admission.key)).toMatchObject({ kind: "unknown" });
	});

	test("a live/spend close during input verification refuses the durable claim", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const { checkout, entry } = await childReady(f, built);
		let liveOpen = true;
		let liveChecks = 0;
		const refused = await f.store.claimAtEntry({
			admission: built.admission,
			worker: built.worker,
			entry,
			childCwd: checkout,
			guardBuild: "guard-1",
			live: () => {
				liveChecks += 1;
				return liveOpen ? { ok: true } : { ok: false, reason: "spend closed" };
			},
			verifyInputs: async () => {
				liveOpen = false;
				return { ok: true };
			},
		});
		expect(liveChecks).toBe(2);
		expect(refused.kind).toBe("unknown");
		if (refused.kind === "unknown") {
			expect(refused.problem.code).toBe("entry-live-refused");
			expect(refused.problem.reason).toBe("spend closed");
		}
		expect(await f.store.readClaim(built.admission.key)).toMatchObject({ kind: "unknown" });
	});

	test("a slot release during input verification refuses the durable claim", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const { checkout, entry } = await childReady(f, built);
		const refused = await f.store.claimAtEntry({
			admission: built.admission,
			worker: built.worker,
			entry,
			childCwd: checkout,
			guardBuild: "guard-1",
			live: () => ({ ok: true }),
			verifyInputs: async () => {
				expect(await f.store.releaseSlot(built.admission.slot, "native-ended")).toEqual({ ok: true });
				return { ok: true };
			},
		});
		expect(refused.kind).toBe("unknown");
		if (refused.kind === "unknown") expect(refused.problem.code).toBe("slot-not-held");
		expect(await f.store.readClaim(built.admission.key)).toMatchObject({ kind: "unknown" });
	});

	test("an abandoned prepared admission during input verification refuses the durable claim", async () => {
		const f = await fixture();
		const built = await admissionFor(f);
		expect(await f.store.persistPrepared(built.admission)).toEqual({ ok: true });
		const { checkout, entry } = await childReady(f, built);
		const refused = await f.store.claimAtEntry({
			admission: built.admission,
			worker: built.worker,
			entry,
			childCwd: checkout,
			guardBuild: "guard-1",
			live: () => ({ ok: true }),
			verifyInputs: async () => {
				expect(await f.store.abandonPrepared(built.admission)).toEqual({ ok: true });
				return { ok: true };
			},
		});
		expect(refused.kind).toBe("unknown");
		if (refused.kind === "unknown") expect(refused.problem.code).toBe("admission-abandoned");
		expect(await f.store.readClaim(built.admission.key)).toMatchObject({ kind: "unknown" });
	});
});
