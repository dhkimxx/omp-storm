/** Real disk-only integration store + temporary checkout for the managed first-turn proof. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/config/canonical.ts";
import {
	INTEGRATION_ADMISSION_SCHEMA,
	INTEGRATION_POLICY_HOST,
	IntegrationAdmissionStore,
	integrationCandidateId,
} from "../src/runtime/integration-artifacts.ts";
import { GitDelta } from "../src/runtime/integration-git.ts";
import type {
	AdmissionKey,
	ChildEntryClaim,
	ConsumedInput,
	FrozenIntegrationAdmission,
	IntegrationTarget,
	SpaceIdentity,
} from "../src/runtime/integration-admission.ts";
import type { ByteWindow } from "../src/runtime/integration-delta.ts";
import { managedWorkerTurnCapability, supportsManagedWorkerAdmission } from "../src/discovery/integration-host.ts";
import {
	bindManagedWorkerEntry,
	createManagedWorkerAdmissionPort,
	endManagedWorkerTurn,
	managedWorkerAdmissionReference,
	parseManagedWorkerEntry,
	readManagedWorkerTurn,
	type ManagedWorkerCheckoutProof,
	type ManagedWorkerTurnExpectation,
} from "../src/runtime/managed-worker-admission.ts";
import {
	persistWorkerAdmission,
	readWorkerAdmissionByKey,
	revokeWorkerAdmissions,
	type ManagedWorkerTurnScope,
	type WorkerAdmissionRecord,
} from "../src/worker-admission.ts";
import { sessionStoreDir } from "../src/session-scope.ts";

const parentId = "Main";
const childId = "Impl";
const runId = "run-managed-test";
const parentInstance = "main:1";
const actorSessionId = "child-session";
const actorInstance = "child:1";
const generation = 2;
const guard = "guard-managed-1";
const dispatchId = "iso_native_1";
const definitionDigest = `sha256:${sha256Hex("definition")}`;

let tmp: string;
let agentDir: string;
let artifacts: string;
let repo: string;
let gitDir: string;
let objectsDir: string;
let worktreesDir: string;
let sessionDir: string;
let childSessionFile: string;
let store: InstanceType<typeof IntegrationAdmissionStore>;
let delta: GitDelta;
let window: ByteWindow;
let clock: { now: number };

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(join(tmpdir(), "storm-managed-")));
	agentDir = join(tmp, "agent");
	artifacts = join(tmp, "artifacts");
	repo = join(tmp, "repo");
	gitDir = join(repo, ".git");
	objectsDir = join(gitDir, "objects");
	worktreesDir = join(tmp, "wt");
	sessionDir = sessionStoreDir(agentDir, "main-session");
	childSessionFile = join(sessionDir, "child.jsonl");
	await Promise.all([
		mkdir(agentDir, { recursive: true }),
		mkdir(artifacts, { recursive: true }),
		mkdir(objectsDir, { recursive: true }),
		mkdir(worktreesDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	await writeFile(childSessionFile, "{}\n");
	await writeFile(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n");
	clock = { now: 10_000 };
	store = new IntegrationAdmissionStore({
		agentDir,
		worktreesDir,
		now: () => clock.now,
		hostOwner: async () => ({ pid: process.pid, processStart: "test-start" }),
	});
	delta = new GitDelta({ bytes: store.artifacts, now: () => clock.now });
	window = { maxBytes: 64 * 1024 * 1024, deadline: clock.now + 60_000, signal: new AbortController().signal };
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

async function identity(path: string): Promise<SpaceIdentity> {
	const canonical = await realpath(path);
	const info = await stat(canonical, { bigint: true });
	return { canonicalPath: canonical, device: info.dev.toString(), inode: info.ino.toString() };
}

async function targetOf(): Promise<IntegrationTarget> {
	return {
		leaseKey: `lease-${tmp}`,
		authorizedRoot: await identity(repo),
		gitRoot: await identity(repo),
		gitDir: await identity(gitDir),
		sourceOdb: {
			commonDir: await identity(gitDir),
			objects: await identity(objectsDir),
			objectFormat: "sha1",
		},
		targetPrefix: "",
	};
}

interface Prepared {
	readonly record: WorkerAdmissionRecord;
	readonly admission: FrozenIntegrationAdmission;
	readonly key: AdmissionKey;
	readonly checkout: string;
}

async function prepared(subject: FrozenIntegrationAdmission["subject"] = { kind: "unplanned" }): Promise<Prepared> {
	const { record } = await persistWorkerAdmission({
		agentDir,
		artifactRoot: artifacts,
		parentId,
		childId,
		runId,
		sessionId: "main-session",
		sessionDir,
		repoId: "repo-1",
		targetRoot: repo,
		policy: { kind: "private", reason: "managed test worker" },
		approved: [],
	});
	const target = await targetOf();
	const key: AdmissionKey = { schema: INTEGRATION_ADMISSION_SCHEMA, runId, dispatch: dispatchId };
	const item = { toolCallId: "call-1", itemIndex: 0, handle: childId };
	const reserved = await store.reserveSlot({
		key, target, item, profile: "test", nativeSlotPath: join(worktreesDir, "t000000001"),
	});
	if (reserved.kind === "unknown") throw new Error(`slot refused: ${reserved.problem.code}`);
	const checkout = join(reserved.value.slotPath, "m");
	await mkdir(join(checkout, ".git", "objects", "info"), { recursive: true });
	await writeFile(join(checkout, ".git", "config"), "[extensions]\n\tobjectformat = sha1\n");
	await writeFile(join(checkout, ".git", "objects", "info", "alternates"), `${objectsDir}\n`);
	await writeFile(join(checkout, ".git", "index"), "index\n");
	await writeFile(
		join(reserved.value.slotPath, ".omp-isolation-owner.json"),
		JSON.stringify({ pid: process.pid, id: childId, startToken: "test-start" }),
	);
	const admission: FrozenIntegrationAdmission = {
		key,
		candidateId: integrationCandidateId(key),
		director: { sessionId: "main-session", sessionInstance: parentInstance, sessionDir, parentId },
		target,
		artifactRoot: await identity(artifacts),
		item,
		placementOrdinal: 0,
		approvedDefinitionDigest: definitionDigest,
		approvalDigest: `sha256:${sha256Hex("approval")}`,
		workerAdmission: { key: record.key, attempt: record.attempt, approved: [] },
		scope: { kind: "unbounded" },
		subject,
		policy: {
			id: `policy-${dispatchId}`,
			host: INTEGRATION_POLICY_HOST,
			settingsInstance: "settings:1",
			relevantEpoch: 1,
			directorInstance: parentInstance,
			toolCallId: item.toolCallId,
			enabled: true,
			backendProofId: dispatchId,
			apply: false,
			merge: "patch",
			captureContract: "native-git-synthetic-tree",
			backendSetting: "apfs",
			profile: "test",
			guardBuild: guard,
		},
		slot: reserved.value,
		startedAt: clock.now,
	};
	expect(await store.persistPrepared(admission)).toEqual({ ok: true });
	return { record, admission, key, checkout };
}

function scopeFor(p: Prepared, over: Partial<ManagedWorkerTurnScope> = {}): ManagedWorkerTurnScope {
	return Object.freeze({
		revision: 1,
		token: randomUUID(),
		guard,
		runId,
		admissionKey: p.record.key,
		admissionAttempt: p.record.attempt,
		ownerSessionId: "main-session",
		ownerInstanceKey: parentInstance,
		parentAgentId: parentId,
		agentId: childId,
		actorSessionId,
		actorInstanceKey: actorInstance,
		generation,
		dispatchId,
		kind: "first",
		...over,
	});
}

async function nativeTuple(
	p: Prepared, scope: ManagedWorkerTurnScope, sourceRoot = p.admission.target.gitRoot.canonicalPath,
): Promise<{ ctx: unknown; event: unknown }> {
	const sessionFileIdentity = await identity(childSessionFile);
	const checkoutIdentity = await identity(p.checkout);
	const workspace = Object.freeze({
		kind: "native", backend: "apfs", sourceRoot, slotPath: p.admission.slot.slotPath,
	});
	const isolation = Object.freeze({
		requested: true, enabled: true, merge: "patch", apply: false, commits: "generic", workspace,
	});
	const definition = Object.freeze({ source: "user", digest: definitionDigest });
	const event = {
		type: "subagent_entry",
		dispatchId: scope.dispatchId,
		guard,
		isolation,
		agentDefinition: definition,
		workerTurn: scope,
		parent: { agentId: parentId, sessionKey: parentInstance, cwd: repo },
		agent: { id: childId, name: "task", generation: scope.generation, sessionKey: actorInstance },
		sessionFile: childSessionFile,
		sessionFileIdentity: { device: sessionFileIdentity.device, inode: sessionFileIdentity.inode },
		checkout: {
			cwd: p.checkout,
			isolated: true,
			device: checkoutIdentity.device,
			inode: checkoutIdentity.inode,
		},
	};
	const ctx = {
		agent: { kind: "sub", id: childId, name: "task", parentId, depth: 1 },
		cwd: p.checkout,
		sessionManager: {
			getSessionId: () => actorSessionId,
			getSessionFile: () => childSessionFile,
		},
		workerTurn: scope,
	};
	return { ctx, event };
}

async function bind(tuple: { ctx: unknown; event: unknown }, live = () => ({ ok: true } as const)) {
	return bindManagedWorkerEntry({
		agentDir,
		guard,
		ctx: tuple.ctx,
		event: tuple.event,
		store,
		delta,
		window,
		live,
	});
}


const read = (p: Prepared, scope: ManagedWorkerTurnScope, over: {
	turnToken?: string;
	expect?: ManagedWorkerTurnExpectation;
	live?: () => { ok: true } | { ok: false; reason: string };
	delta?: ManagedWorkerCheckoutProof;
} = {}) =>
	readManagedWorkerTurn({
		agentDir,
		guard,
		key: p.record.key,
		attempt: p.record.attempt,
		turnToken: over.turnToken ?? scope.token,
		store,
		delta: over.delta ?? delta,
		window,
		live: over.live ?? (() => ({ ok: true } as const)),
		...(over.expect === undefined ? {} : { expect: over.expect }),
	});

const finish = (p: Prepared, scope: ManagedWorkerTurnScope, over: {
	turnToken?: string;
	session?: string;
	delta?: ManagedWorkerCheckoutProof;
} = {}) =>
	endManagedWorkerTurn({
		agentDir,
		guard,
		key: p.record.key,
		attempt: p.record.attempt,
		turnToken: over.turnToken ?? scope.token,
		childSessionId: over.session ?? actorSessionId,
		store,
		delta: over.delta ?? delta,
		window,
		live: () => ({ ok: true }),
	});

async function openRecord(key: string): Promise<WorkerAdmissionRecord> {
	const read = await readWorkerAdmissionByKey(agentDir, key);
	if (read.kind !== "record") throw new Error(`expected a record, received ${read.kind}`);
	expect(read.record.endedAt).toBeUndefined();
	return read.record;
}

const capability = (managed: Record<string, unknown> = {}, isolationMut = {}) => ({
	capabilities: Object.freeze({
		version: 1,
		subagentIsolation: Object.freeze({
			version: 1, spawnPolicy: true, childEntryGuard: true, entryGuard: true, agentDefinitionIdentity: true, ...isolationMut,
		}),
		managedWorkerTurn: Object.freeze({
			version: 1, admission: true, ownerValidated: true, childScope: true, typedEnd: true, wake: false, pooled: false, ...managed,
		}),
	}),
});

describe("managed worker capability", () => {
	test("requires the frozen, fully advertised first-turn block on top of guarded isolation", () => {
		expect(supportsManagedWorkerAdmission({ version: "19.2.1" })).toBe(false);
		expect(supportsManagedWorkerAdmission({ capabilities: Object.freeze({ version: 1 }) })).toBe(false);
		expect(supportsManagedWorkerAdmission(capability())).toBe(true);
		expect(managedWorkerTurnCapability(capability())).toMatchObject({ version: 1, admission: true, wake: false, pooled: false });
		expect(supportsManagedWorkerAdmission(capability({ wake: true }))).toBe(false);
		expect(supportsManagedWorkerAdmission(capability({ pooled: true }))).toBe(false);
		expect(supportsManagedWorkerAdmission(capability({ ownerValidated: false }))).toBe(false);
		const mutable = { capabilities: { ...(capability().capabilities as object) } };
		expect(supportsManagedWorkerAdmission(mutable)).toBe(false);
	});
});

describe("native tuple parsing", () => {
	test("accepts the exact ctx/event tuple and returns the acknowledgement token", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		const parsed = parseManagedWorkerEntry({ ctx: tuple.ctx, event: tuple.event, guard });
		if (parsed.kind !== "known") throw new Error(parsed.problem.reason);
		expect(parsed.value).toMatchObject({
			dispatchId, guard,
			acknowledgement: { dispatchId, guard, workerTurnToken: scope.token },
			actor: { agentId: childId, sessionId: actorSessionId, instanceKey: actorInstance, generation },
		});
		// The immediate parent instance is not the owning root instance of a nested worker; the scope names the owner.
		const event = tuple.event as Record<string, unknown>;
		const parent = event.parent as Record<string, unknown>;
		expect(parseManagedWorkerEntry({
			ctx: tuple.ctx, event: { ...event, parent: { ...parent, sessionKey: "parent:2" } }, guard,
		})).toMatchObject({ kind: "known", value: { parent: { instanceKey: "parent:2" } } });
	});

	test("refuses a wrong actor, parent, generation, dispatch, guard, kind or missing scope", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		const event = tuple.event as Record<string, unknown>;
		const ctx = tuple.ctx as Record<string, unknown>;
		const bad = (mutate: (value: Record<string, unknown>) => void) => {
			const copy = structuredClone(event) as Record<string, unknown>;
			mutate(copy);
			const parsed = parseManagedWorkerEntry({ ctx, event: copy, guard });
			return parsed.kind === "unknown" ? parsed.problem.code : "known";
		};
		expect(bad(value => { (value.agent as Record<string, unknown>).id = "Other"; })).toBe("entry-agent-mismatch");
		expect(bad(value => { (value.parent as Record<string, unknown>).agentId = "Other"; })).toBe("entry-parent-mismatch");
		expect(bad(value => { (value.agent as Record<string, unknown>).generation = generation + 1; })).toBe("entry-generation-mismatch");
		expect(bad(value => { value.dispatchId = "iso_other"; })).toBe("entry-dispatch-mismatch");
		expect(bad(value => { value.guard = "other-guard"; })).toBe("entry-guard-mismatch");
		expect(bad(value => { delete value.workerTurn; })).toBe("entry-scope-missing");
		const wake = scopeFor(p, { kind: "wake" });
		const wakeTuple = await nativeTuple(p, wake);
		expect(parseManagedWorkerEntry({ ctx: wakeTuple.ctx, event: wakeTuple.event, guard })).toMatchObject({
			kind: "unknown", problem: { code: "entry-wake-unsupported" },
		});
		expect(parseManagedWorkerEntry({ ctx: { ...ctx, agent: { ...(ctx.agent as object), kind: "main" } }, event, guard })).toMatchObject({
			kind: "unknown", problem: { code: "entry-context-invalid" },
		});
		expect(parseManagedWorkerEntry({ ctx: { ...ctx, cwd: repo }, event, guard })).toMatchObject({
			kind: "unknown", problem: { code: "entry-checkout-cwd" },
		});
	});
});

describe("real disk-only bind/read/end", () => {
	test("binds, reads and ends one exact attempt and returns the spawn reference", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		const bound = await bind(tuple);
		if (bound.kind !== "known") throw new Error(bound.problem.reason);
		expect(bound.value.reference).toEqual({ runId, admissionKey: p.record.key, admissionAttempt: p.record.attempt });
		expect(managedWorkerAdmissionReference(bound.value.admission, p.record)).toMatchObject({ kind: "known", value: bound.value.reference });
		expect(managedWorkerAdmissionReference(bound.value.admission, { key: "0".repeat(64), attempt: p.record.attempt })).toMatchObject({
			kind: "unknown", problem: { code: "reference-worker" },
		});
		expect(await read(p, scope, { expect: { runId, actorSessionId, actorInstanceKey: actorInstance, generation, dispatchId } })).toMatchObject({
			kind: "known",
			value: { record: { key: p.record.key, attempt: p.record.attempt }, binding: { key: p.record.key, attempt: p.record.attempt } },
		});
		expect(await finish(p, scope)).toMatchObject({ kind: "ended" });
		expect(await readWorkerAdmissionByKey(agentDir, p.record.key)).toMatchObject({ kind: "record", record: { endedAt: expect.any(Number) } });
		expect(await finish(p, scope)).toMatchObject({ kind: "already-ended" });
	});

	test("accepts only a source alias naming the approved physical Git tree", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		expect(await bind(await nativeTuple(p, scope, tmp))).toMatchObject({
			kind: "unknown", problem: { code: "integration-source" },
		});
		const alias = join(tmp, "native-source-alias");
		await symlink(p.admission.target.gitRoot.canonicalPath, alias);
		expect(await bind(await nativeTuple(p, scope, alias))).toMatchObject({ kind: "known" });
	});

	test("wrong token, run, actor, instance, generation and dispatch refuse a bound turn", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		expect(await bind(tuple)).toMatchObject({ kind: "known" });
		expect(await read(p, scope, { turnToken: randomUUID() })).toMatchObject({ kind: "unknown", problem: { code: "turn-file-invalid" } });
		expect(await read(p, scope, { expect: { runId: "other-run" } })).toMatchObject({ kind: "unknown", problem: { code: "expect-run" } });
		expect(await read(p, scope, { expect: { actorSessionId: "other-session" } })).toMatchObject({ kind: "unknown", problem: { code: "expect-actor-session" } });
		expect(await read(p, scope, { expect: { actorInstanceKey: "other:1" } })).toMatchObject({ kind: "unknown", problem: { code: "expect-actor-instance" } });
		expect(await read(p, scope, { expect: { generation: generation + 1 } })).toMatchObject({ kind: "unknown", problem: { code: "expect-generation" } });
		expect(await read(p, scope, { expect: { dispatchId: "iso_other" } })).toMatchObject({ kind: "unknown", problem: { code: "expect-dispatch" } });
		expect(await read(p, scope, { live: () => ({ ok: false, reason: "owner closed" }) })).toMatchObject({
			kind: "unknown", problem: { code: "live-refused" },
		});
		expect(await finish(p, scope, { session: "other-session" })).toMatchObject({ kind: "unknown", problem: { code: "session-mismatch" } });
	});

	test("entry proves consumed inputs while work/end only re-prove the physical checkout", async () => {
		const subject: FrozenIntegrationAdmission["subject"] = {
			kind: "planned",
			lane: "L1",
			epoch: 1,
			contractDigest: "digest-1",
			results: [],
			consumed: [{
				producerLane: "L1", need: "result", subject: { kind: "result", id: "r1" }, state: "missing",
			}],
		};
		const p = await prepared(subject);
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		const seen: number[] = [];
		const checkoutProof = {
			verifyCheckoutInputs: async (claim: ChildEntryClaim, inputs: readonly ConsumedInput[], byteWindow: ByteWindow) => {
				seen.push(inputs.length);
				return delta.verifyCheckoutInputs(claim, inputs, byteWindow);
			},
		};
		expect(await bindManagedWorkerEntry({
			agentDir, guard, ctx: tuple.ctx, event: tuple.event, store, delta: checkoutProof, window, live: () => ({ ok: true }),
		})).toMatchObject({ kind: "known" });
		expect(seen).toEqual([1]);
		expect(await readManagedWorkerTurn({
			agentDir, guard, key: p.record.key, attempt: p.record.attempt, turnToken: scope.token,
			store, delta: checkoutProof, window, live: () => ({ ok: true }),
		})).toMatchObject({ kind: "known" });
		expect(seen).toEqual([1, 0]);
		expect(await endManagedWorkerTurn({
			agentDir, guard, key: p.record.key, attempt: p.record.attempt, turnToken: scope.token,
			childSessionId: actorSessionId, store, delta: checkoutProof, window, live: () => ({ ok: true }),
		})).toMatchObject({ kind: "ended" });
		expect(seen).toEqual([1, 0, 0]);
	});

	test("a record revoked during the awaited checkout proof is rechecked and refused", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		expect(await bind(tuple)).toMatchObject({ kind: "known" });
		const checkoutProof = {
			verifyCheckoutInputs: async (claim: ChildEntryClaim, inputs: readonly ConsumedInput[], byteWindow: ByteWindow) => {
				const verified = await delta.verifyCheckoutInputs(claim, inputs, byteWindow);
				await revokeWorkerAdmissions(agentDir, { key: p.record.key, attempt: p.record.attempt });
				return verified;
			},
		};
		expect(await read(p, scope, { delta: checkoutProof })).toMatchObject({
			kind: "unknown", problem: { code: "revoked" },
		});
	});

	test("a record revoked during the awaited end proof is rechecked before the end CAS", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		expect(await bind(await nativeTuple(p, scope))).toMatchObject({ kind: "known" });
		const checkoutProof = {
			verifyCheckoutInputs: async (claim: ChildEntryClaim, inputs: readonly ConsumedInput[], byteWindow: ByteWindow) => {
				const verified = await delta.verifyCheckoutInputs(claim, inputs, byteWindow);
				await revokeWorkerAdmissions(agentDir, { key: p.record.key, attempt: p.record.attempt });
				return verified;
			},
		};
		expect(await finish(p, scope, { delta: checkoutProof })).toMatchObject({
			kind: "unknown", problem: { code: "revoked" },
		});
	});

	test("wrong run, attempt or root owner instance at bind is refused without touching a newer record", async () => {
		const p = await prepared();
		const wrongRun = scopeFor(p, { runId: "other-run" });
		const wrongRunTuple = await nativeTuple(p, wrongRun);
		expect(await bind(wrongRunTuple)).toMatchObject({ kind: "unknown", problem: { code: "record-turn" } });
		const wrongAttempt = scopeFor(p, { admissionAttempt: randomUUID() });
		const wrongAttemptTuple = await nativeTuple(p, wrongAttempt);
		expect(await bind(wrongAttemptTuple)).toMatchObject({ kind: "unknown", problem: { code: "record-turn" } });
		const wrongOwner = scopeFor(p, { ownerInstanceKey: "other-root:1" });
		const wrongOwnerTuple = await nativeTuple(p, wrongOwner);
		expect(await bind(wrongOwnerTuple)).toMatchObject({ kind: "unknown", problem: { code: "integration-director" } });
		expect(await openRecord(p.record.key)).toMatchObject({ attempt: p.record.attempt });
	});

	test("a revoked record and a rotated attempt refuse without ending the newer attempt", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		expect(await bind(tuple)).toMatchObject({ kind: "known" });
		expect(await revokeWorkerAdmissions(agentDir, { key: p.record.key, attempt: p.record.attempt })).toBe(1);
		expect(await read(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "revoked" } });
		expect(await finish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "revoked" } });

		const rotated = await prepared();
		expect(await read(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "attempt-replaced" } });
		expect(await finish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "attempt-replaced" } });
		expect(await openRecord(rotated.record.key)).toMatchObject({ attempt: rotated.record.attempt });
	});

	test("a changed physical checkout or session identity refuses bind/read/end and leaves the record open", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		const event = tuple.event as Record<string, unknown>;
		const checkout = event.checkout as Record<string, unknown>;
		const changed = { ...event, checkout: { ...checkout, inode: "999999" } };
		expect(await bind({ ctx: tuple.ctx, event: changed })).toMatchObject({
			kind: "unknown", problem: { code: "claim-checkout" },
		});
		expect(await read(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "turn-missing" } });
		expect(await finish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "turn-missing" } });
		await openRecord(p.record.key);

		const good = await bind(tuple);
		expect(good.kind).toBe("known");
		await rename(p.checkout, `${p.checkout}.away-${randomUUID()}`);
		await mkdir(p.checkout, { recursive: true });
		expect(await read(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "checkout-changed" } });
		expect(await finish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "checkout-changed" } });
		await openRecord(p.record.key);
	});

	test("a missing binding refuses read/end before any claim is created", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		expect(await read(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "turn-missing" } });
		expect(await finish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "turn-missing" } });
		await openRecord(p.record.key);
	});

	test("the port exposes only the narrow parse/reference/bind/read/end surface", async () => {
		const p = await prepared();
		const scope = scopeFor(p);
		const tuple = await nativeTuple(p, scope);
		const port = createManagedWorkerAdmissionPort({ agentDir, guard, store, delta });
		expect(port.guard).toBe(guard);
		expect(port.parse({ ctx: tuple.ctx, event: tuple.event })).toMatchObject({ kind: "known" });
		expect(await port.bind({ ctx: tuple.ctx, event: tuple.event, window, live: () => ({ ok: true }) })).toMatchObject({ kind: "known" });
		expect(await port.read({
			key: p.record.key, attempt: p.record.attempt, turnToken: scope.token, window, live: () => ({ ok: true }),
		})).toMatchObject({ kind: "known" });
		expect(await port.end({
			key: p.record.key, attempt: p.record.attempt, turnToken: scope.token, childSessionId: actorSessionId, window, live: () => ({ ok: true }),
		})).toMatchObject({ kind: "ended" });
	});
});
