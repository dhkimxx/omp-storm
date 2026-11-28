/** Real disk-only integration store + temporary checkout for the managed first-turn proof. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
	bindManagedWorkerWake,
	createManagedWorkerAdmissionPort,
	endManagedWorkerTurn,
	managedWorkerAdmissionReference,
	parseManagedWorkerEntry,
	parseManagedWorkerWakeEntry,
	readManagedWorkerTurn,
	type BoundManagedWorkerSource,
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

/** A fresh durable follow-up grant for the same worker identity, as the owner writes before a warm wake. */
async function followUpRecord(over: {
	policy?: { kind: "private"; reason: string };
	lane?: string;
	hold?: string;
} = {}): Promise<WorkerAdmissionRecord> {
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
		policy: over.policy ?? { kind: "private", reason: "managed test worker" },
		...(over.lane === undefined ? {} : { lane: over.lane }),
		...(over.hold === undefined ? {} : { hold: over.hold }),
		approved: [],
	});
	return record;
}

function wakeScopeFor(p: Prepared, record: WorkerAdmissionRecord, over: Partial<ManagedWorkerTurnScope> = {}): ManagedWorkerTurnScope {
	return scopeFor(p, {
		token: randomUUID(),
		admissionAttempt: record.attempt,
		dispatchId: `wake-${randomUUID()}`,
		kind: "wake",
		...over,
	});
}

async function wakeTuple(p: Prepared, scope: ManagedWorkerTurnScope, over: {
	actorSessionId?: string;
	actorSessionFile?: string;
	cwd?: string;
	sessionFile?: string;
	sessionDevice?: string;
	sessionInode?: string;
	checkoutDevice?: string;
	checkoutInode?: string;
	ctxWorkerTurn?: unknown;
} = {}): Promise<{ ctx: unknown; event: unknown }> {
	const actor = over.actorSessionId ?? actorSessionId;
	const cwd = over.cwd ?? p.checkout;
	const contextSessionFile = over.actorSessionFile ?? childSessionFile;
	const sessionFile = over.sessionFile ?? contextSessionFile;
	const sessionIdentity = await identity(contextSessionFile);
	const checkoutIdentity = await identity(cwd);
	const event = {
		type: "managed_worker_wake_entry",
		workerTurn: scope,
		capture: {
			sessionFile,
			sessionFileIdentity: {
				device: over.sessionDevice ?? sessionIdentity.device,
				inode: over.sessionInode ?? sessionIdentity.inode,
			},
			checkout: {
				cwd,
				device: over.checkoutDevice ?? checkoutIdentity.device,
				inode: over.checkoutInode ?? checkoutIdentity.inode,
			},
		},
	};
	const ctx = {
		agent: { kind: "sub", id: childId, name: "task", parentId, depth: 1 },
		cwd,
		sessionManager: {
			getSessionId: () => actor,
			getSessionFile: () => contextSessionFile,
		},
		...(over.ctxWorkerTurn === undefined ? {} : { workerTurn: over.ctxWorkerTurn }),
	};
	return { ctx, event };
}

async function wakeBind(prior: BoundManagedWorkerSource, tuple: { ctx: unknown; event: unknown }, over: {
	delta?: ManagedWorkerCheckoutProof;
	live?: () => { ok: true } | { ok: false; reason: string };
} = {}) {
	return bindManagedWorkerWake({
		agentDir,
		guard,
		ctx: tuple.ctx,
		event: tuple.event,
		prior,
		store,
		delta: over.delta ?? delta,
		window,
		live: over.live ?? (() => ({ ok: true } as const)),
	});
}

const wakeRead = (p: Prepared, scope: ManagedWorkerTurnScope, over: {
	turnToken?: string;
	expect?: ManagedWorkerTurnExpectation;
	live?: () => { ok: true } | { ok: false; reason: string };
	delta?: ManagedWorkerCheckoutProof;
} = {}) =>
	readManagedWorkerTurn({
		agentDir,
		guard,
		key: p.record.key,
		attempt: scope.admissionAttempt,
		turnToken: over.turnToken ?? scope.token,
		store,
		delta: over.delta ?? delta,
		window,
		live: over.live ?? (() => ({ ok: true } as const)),
		...(over.expect === undefined ? {} : { expect: over.expect }),
	});

const wakeFinish = (p: Prepared, scope: ManagedWorkerTurnScope, over: {
	turnToken?: string;
	session?: string;
	delta?: ManagedWorkerCheckoutProof;
} = {}) =>
	endManagedWorkerTurn({
		agentDir,
		guard,
		key: p.record.key,
		attempt: scope.admissionAttempt,
		turnToken: over.turnToken ?? scope.token,
		childSessionId: over.session ?? actorSessionId,
		store,
		delta: over.delta ?? delta,
		window,
		live: () => ({ ok: true }),
	});

function recordFile(record: Pick<WorkerAdmissionRecord, "key">): string {
	return join(agentDir, "storm", "admissions", `${record.key}.json`);
}

function turnFile(record: Pick<WorkerAdmissionRecord, "key" | "attempt">): string {
	return join(agentDir, "storm", "admissions", `${record.key}.${record.attempt}.turn`);
}

async function writeRecord(record: WorkerAdmissionRecord): Promise<void> {
	await mkdir(join(agentDir, "storm", "admissions"), { recursive: true });
	await writeFile(recordFile(record), `${JSON.stringify(record, null, 2)}\n`);
}

async function firstBound(p: Prepared): Promise<{ scope: ManagedWorkerTurnScope; bound: BoundManagedWorkerSource }> {
	const scope = scopeFor(p);
	const bound = await bind(await nativeTuple(p, scope));
	if (bound.kind !== "known") throw new Error(bound.problem.reason);
	return { scope, bound: bound.value };
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

describe("warm wake child proof", () => {
	test("a retained private worker wakes on its first admitted claim and keeps the original custody", async () => {
		const p = await prepared();
		const { scope: firstScope, bound } = await firstBound(p);
		await writeFile(join(p.checkout, "first-edit.txt"), "legitimate first-turn edit\n");
		expect(await finish(p, firstScope)).toMatchObject({ kind: "ended" });
		const firstTurnFile = turnFile(p.record);
		const firstTurnBefore = await readFile(firstTurnFile, "utf8");
		const admissionBefore = await store.readPrepared({ key: p.record.key, attempt: p.record.attempt });
		const claimBefore = await store.readClaim(p.key);
		if (admissionBefore.kind !== "known" || claimBefore.kind !== "known") throw new Error("first custody is unreadable");
		const slotMarker = join(p.admission.slot.slotPath, ".omp-isolation-owner.json");
		const nativeMarker = await readFile(slotMarker);
		expect(await store.releaseSlot(p.admission.slot, "native-ended")).toEqual({ ok: true });
		expect(await store.readPrepared({ key: p.record.key, attempt: p.record.attempt }))
			.toMatchObject({ kind: "unknown", problem: { code: "slot-not-held" } });

		const record = await followUpRecord();
		const scope = wakeScopeFor(p, record);
		const hostPath = join(tmp, "warm-native-cwd");
		await symlink(p.checkout, hostPath);
		const tuple = await wakeTuple(p, scope, { cwd: hostPath });
		expect(parseManagedWorkerWakeEntry({ ctx: tuple.ctx, event: tuple.event, guard })).toMatchObject({
			kind: "known",
			value: {
				scope: { kind: "wake", admissionAttempt: record.attempt },
				acknowledgement: { workerTurnToken: scope.token, dispatchId: scope.dispatchId },
			},
		});
		const boundWake = await wakeBind(bound, tuple);
		if (boundWake.kind !== "known") throw new Error(boundWake.problem.reason);
		expect(boundWake.value.record.attempt).toBe(record.attempt);
		expect(boundWake.value.binding).toMatchObject({
			attempt: record.attempt,
			turn: { kind: "wake", token: scope.token, dispatchId: scope.dispatchId },
			wake: { sourceAttempt: p.record.attempt },
		});
		expect(boundWake.value.source).toEqual({ attempt: p.record.attempt });
		expect(boundWake.value.acknowledgement).toEqual({ workerTurnToken: scope.token, dispatchId: scope.dispatchId });
		expect(boundWake.value.admission).toEqual(admissionBefore.value);
		expect(boundWake.value.claim).toEqual(claimBefore.value);
		expect(await wakeRead(p, scope, { expect: {
			runId, actorSessionId, actorInstanceKey: actorInstance, generation, dispatchId: scope.dispatchId, kind: "wake",
		} })).toMatchObject({
			kind: "known",
			value: { record: { attempt: record.attempt }, binding: { wake: { sourceAttempt: p.record.attempt } } },
		});
		// A warm wake reads the original bytes as history; it must not reacquire their released slot.
		expect(await store.readRetainedPrepared({ key: p.record.key, attempt: p.record.attempt })).toEqual(admissionBefore);
		expect(await store.readClaim(p.key)).toEqual(claimBefore);
		expect(await readFile(firstTurnFile, "utf8")).toBe(firstTurnBefore);
		expect(await readFile(slotMarker)).toEqual(nativeMarker);
		expect((await stat(join(p.checkout, "first-edit.txt"))).isFile()).toBe(true);

		expect(await wakeFinish(p, scope)).toMatchObject({ kind: "ended" });
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "ended" } });
		expect(await wakeFinish(p, scope)).toMatchObject({ kind: "already-ended" });
	});

	test("wake parsing refuses a different context turn, event type or physical capture", async () => {
		const p = await prepared();
		const { bound } = await firstBound(p);
		const record = await followUpRecord();
		const scope = wakeScopeFor(p, record);
		const tuple = await wakeTuple(p, scope);
		const ctx = tuple.ctx as Record<string, unknown>;
		const event = tuple.event as Record<string, unknown>;
		expect(parseManagedWorkerWakeEntry({
			ctx: { ...ctx, workerTurn: { ...scope, token: randomUUID() } }, event, guard,
		})).toMatchObject({ kind: "unknown", problem: { code: "wake-context-scope" } });
		expect(parseManagedWorkerWakeEntry({
			ctx, event: { ...event, type: "subagent_entry" }, guard,
		})).toMatchObject({ kind: "unknown", problem: { code: "wake-event-invalid" } });
		const capture = event.capture as Record<string, unknown>;
		expect(parseManagedWorkerWakeEntry({
			ctx, event: { ...event, capture: { ...capture, sessionFileIdentity: { device: "x", inode: "1" } } }, guard,
		})).toMatchObject({ kind: "unknown", problem: { code: "wake-event-invalid" } });
		const changed = await wakeTuple(p, scope, { sessionInode: "999999" });
		expect(await wakeBind(bound, changed)).toMatchObject({
			kind: "unknown", problem: { code: "wake-session-file" },
		});
	});

	test("actor, session, generation and a reused token or delivery refuse before any wake binding", async () => {
		const p = await prepared();
		const { bound } = await firstBound(p);
		const record = await followUpRecord();
		const scope = wakeScopeFor(p, record);
		const otherSession = wakeScopeFor(p, record, { actorSessionId: "other-session" });
		expect(await wakeBind(bound, await wakeTuple(
			p, otherSession, { actorSessionId: "other-session" },
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-actor-session" } });
		expect(await wakeBind(bound, await wakeTuple(
			p, wakeScopeFor(p, record, { generation: generation + 1 }),
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-actor-identity" } });
		expect(await wakeBind(bound, await wakeTuple(
			p, wakeScopeFor(p, record, { actorInstanceKey: "other:1" }),
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-actor-identity" } });
		expect(await wakeBind(bound, await wakeTuple(
			p, wakeScopeFor(p, record, { token: bound.binding.turn.token }),
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-token-reused" } });
		expect(await wakeBind(bound, await wakeTuple(
			p, wakeScopeFor(p, record, { dispatchId: bound.binding.turn.dispatchId }),
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-dispatch-reused" } });
		expect(await wakeBind(bound, await wakeTuple(
			p, scope, { checkoutInode: "999999" },
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-checkout" } });
		expect(await wakeBind(bound, await wakeTuple(p, scope, {
			cwd: p.admission.target.gitRoot.canonicalPath,
			checkoutDevice: bound.claim.checkout.device,
			checkoutInode: bound.claim.checkout.inode,
		}))).toMatchObject({ kind: "unknown", problem: { code: "wake-checkout" } });
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "turn-missing" } });
	});

	test("a changed private policy, role or hold refuses the wake grant", async () => {
		const p = await prepared();
		const { bound } = await firstBound(p);
		const changedPolicy = await followUpRecord({ policy: { kind: "private", reason: "different policy" } });
		expect(await wakeBind(bound, await wakeTuple(
			p, wakeScopeFor(p, changedPolicy),
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-grant" } });
		const changedLane = await followUpRecord({ lane: "other-lane" });
		expect(await wakeBind(bound, await wakeTuple(
			p, wakeScopeFor(p, changedLane),
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-grant" } });
		const changedHold = await followUpRecord({ hold: "other-hold" });
		expect(await wakeBind(bound, await wakeTuple(
			p, wakeScopeFor(p, changedHold),
		))).toMatchObject({ kind: "unknown", problem: { code: "wake-grant" } });
	});

	test("missing, foreign, expired, revoked and rotated wake records fail closed before a binding is written", async () => {
		const p = await prepared();
		const { bound } = await firstBound(p);
		const missing = await followUpRecord();
		const missingScope = wakeScopeFor(p, missing);
		await rm(recordFile(missing));
		expect(await wakeBind(bound, await wakeTuple(p, missingScope))).toMatchObject({
			kind: "unknown", problem: { code: "record-missing" },
		});

		const foreign = await followUpRecord();
		const foreignScope = wakeScopeFor(p, foreign);
		await writeRecord({ ...foreign, childId: "ForeignChild" });
		expect(await wakeBind(bound, await wakeTuple(p, foreignScope))).toMatchObject({
			kind: "unknown", problem: { code: "wake-record-identity" },
		});

		const expired = await followUpRecord();
		const expiredScope = wakeScopeFor(p, expired);
		await writeRecord({ ...expired, expiresAt: 1 });
		expect(await wakeBind(bound, await wakeTuple(p, expiredScope))).toMatchObject({
			kind: "unknown", problem: { code: "expired" },
		});

		const revoked = await followUpRecord();
		const revokedScope = wakeScopeFor(p, revoked);
		expect(await revokeWorkerAdmissions(agentDir, { key: revoked.key, attempt: revoked.attempt })).toBe(1);
		expect(await wakeBind(bound, await wakeTuple(p, revokedScope))).toMatchObject({
			kind: "unknown", problem: { code: "revoked" },
		});

		const rotated = await followUpRecord();
		const rotatedScope = wakeScopeFor(p, rotated);
		const newer = await followUpRecord();
		expect(await wakeBind(bound, await wakeTuple(p, rotatedScope))).toMatchObject({
			kind: "unknown", problem: { code: "wake-attempt" },
		});
		expect(await wakeRead(p, rotatedScope)).toMatchObject({
			kind: "unknown", problem: { code: "attempt-replaced" },
		});
		const newerScope = wakeScopeFor(p, newer);
		expect(await wakeBind(bound, await wakeTuple(p, newerScope))).toMatchObject({ kind: "known" });
	});

	test("a record revoked during the awaited checkout proof is rechecked and refuses", async () => {
		const p = await prepared();
		const { bound } = await firstBound(p);
		const record = await followUpRecord();
		const scope = wakeScopeFor(p, record);
		const checkoutProof = {
			verifyCheckoutInputs: async (claim: ChildEntryClaim, inputs: readonly ConsumedInput[], byteWindow: ByteWindow) => {
				const verified = await delta.verifyCheckoutInputs(claim, inputs, byteWindow);
				await revokeWorkerAdmissions(agentDir, { key: record.key, attempt: record.attempt });
				return verified;
			},
		};
		expect(await wakeBind(bound, await wakeTuple(p, scope), { delta: checkoutProof })).toMatchObject({
			kind: "unknown", problem: { code: "revoked" },
		});
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "revoked" } });
	});

	test("repeated wakes keep the invariant first claim, a newer attempt replaces the old, and exact end closes the newest", async () => {
		const p = await prepared();
		const { scope: firstScope, bound: first } = await firstBound(p);
		expect(await finish(p, firstScope)).toMatchObject({ kind: "ended" });
		const admissionBefore = await store.readPrepared({ key: p.record.key, attempt: p.record.attempt });
		const claimBefore = await store.readClaim(p.key);
		if (admissionBefore.kind !== "known" || claimBefore.kind !== "known") throw new Error("first custody is unreadable");
		const firstTurnFile = turnFile(p.record);
		const firstTurnBefore = await readFile(firstTurnFile, "utf8");

		const secondRecord = await followUpRecord();
		const secondScope = wakeScopeFor(p, secondRecord);
		const second = await wakeBind(first, await wakeTuple(p, secondScope));
		if (second.kind !== "known") throw new Error(second.problem.reason);
		const thirdRecord = await followUpRecord();
		const thirdScope = wakeScopeFor(p, thirdRecord);
		const third = await wakeBind(second.value, await wakeTuple(p, thirdScope));
		if (third.kind !== "known") throw new Error(third.problem.reason);
		expect(third.value.source).toEqual({ attempt: p.record.attempt });
		expect(third.value.binding.wake).toMatchObject({ sourceAttempt: p.record.attempt });
		expect(third.value.admission).toEqual(admissionBefore.value);
		expect(third.value.claim).toEqual(claimBefore.value);
		expect(await wakeRead(p, secondScope)).toMatchObject({ kind: "unknown", problem: { code: "attempt-replaced" } });
		expect(await wakeRead(p, thirdScope)).toMatchObject({
			kind: "known",
			value: { admission: admissionBefore.value },
		});
		expect(await readFile(firstTurnFile, "utf8")).toBe(firstTurnBefore);

		expect(await wakeFinish(p, thirdScope)).toMatchObject({ kind: "ended" });
		expect(await wakeFinish(p, thirdScope, { turnToken: randomUUID() })).toMatchObject({
			kind: "unknown", problem: { code: "turn-file-invalid" },
		});
		expect(await wakeFinish(p, secondScope)).toMatchObject({ kind: "unknown", problem: { code: "attempt-replaced" } });
		expect(await wakeRead(p, thirdScope)).toMatchObject({ kind: "unknown", problem: { code: "ended" } });
	});

	test("read and end recheck the fresh wake record after a bound grant", async () => {
		const p = await prepared();
		const { bound } = await firstBound(p);
		const record = await followUpRecord();
		const scope = wakeScopeFor(p, record);
		const boundWake = await wakeBind(bound, await wakeTuple(p, scope));
		if (boundWake.kind !== "known") throw new Error(boundWake.problem.reason);
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "known" });

		await writeRecord({ ...record, hold: "other-hold" });
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "wake-grant" } });
		expect(await wakeFinish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "wake-grant" } });

		await writeRecord({ ...record, childId: "ForeignChild" });
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "actor-agent" } });

		await writeRecord(record);
		expect(await revokeWorkerAdmissions(agentDir, { key: record.key, attempt: record.attempt })).toBe(1);
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "revoked" } });
		expect(await wakeFinish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "revoked" } });

		await writeRecord({ ...record, expiresAt: 1 });
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "expired" } });
		expect(await wakeFinish(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "expired" } });

		const newer = await followUpRecord();
		expect(newer.attempt).not.toBe(record.attempt);
		expect(await wakeRead(p, scope)).toMatchObject({ kind: "unknown", problem: { code: "attempt-replaced" } });
	});

	test("the curried port exposes bindWake with the same acknowledgement and exact end", async () => {
		const p = await prepared();
		const { bound } = await firstBound(p);
		const record = await followUpRecord();
		const scope = wakeScopeFor(p, record);
		const tuple = await wakeTuple(p, scope);
		const port = createManagedWorkerAdmissionPort({ agentDir, guard, store, delta });
		const boundWake = await port.bindWake({
			ctx: tuple.ctx, event: tuple.event, prior: bound, window, live: () => ({ ok: true }),
		});
		if (boundWake.kind !== "known") throw new Error(boundWake.problem.reason);
		expect(boundWake.value.acknowledgement).toEqual({ workerTurnToken: scope.token, dispatchId: scope.dispatchId });
		expect(await port.read({
			key: p.record.key, attempt: record.attempt, turnToken: scope.token, window, live: () => ({ ok: true }),
		})).toMatchObject({ kind: "known", value: { binding: { wake: { sourceAttempt: p.record.attempt } } } });
		expect(await port.end({
			key: p.record.key, attempt: record.attempt, turnToken: scope.token, childSessionId: actorSessionId,
			window, live: () => ({ ok: true }),
		})).toMatchObject({ kind: "ended" });
	});
});
