/** The exact durable `{key, attempt, turn}` claim: bind, work-read and end without a newest-row fallback. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/config/canonical.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import {
	bindWorkerAdmissionTurn,
	endWorkerAdmissionTurn,
	parseWorkerTurnScope,
	persistWorkerAdmission,
	readWorkerAdmissionByKey,
	readWorkerAdmissionTurn,
	revokeWorkerAdmissions,
	type ManagedWorkerTurnScope,
	type WorkerAdmissionRecord,
	type WorkerTurnChildIdentity,
} from "../src/worker-admission.ts";

const parentId = "Main";
const childId = "Impl";
const runId = "run-turn-test";
const guard = "guard-turn-1";
const actorSessionId = "child-session";
const actorInstance = "child:1";
const generation = 3;

let tmp: string;
let agentDir: string;
let project: string;
let artifacts: string;
let sessionDir: string;

beforeEach(async () => {
	tmp = await realpath(await mkdtemp(join(tmpdir(), "storm-turn-")));
	agentDir = join(tmp, "agent");
	project = join(tmp, "project");
	artifacts = join(tmp, "artifacts");
	await mkdir(agentDir, { recursive: true });
	await mkdir(project, { recursive: true });
	sessionDir = sessionStoreDir(agentDir, "main-session");
	await mkdir(sessionDir, { recursive: true });
	await writeFile(join(tmp, "child.jsonl"), "{}\n");
	await mkdir(join(tmp, "checkout"), { recursive: true });
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

const admit = () =>
	persistWorkerAdmission({
		agentDir,
		artifactRoot: artifacts,
		parentId,
		childId,
		runId,
		sessionId: "main-session",
		sessionDir,
		repoId: "repo-test",
		targetRoot: project,
		policy: { kind: "private", reason: "test private worker" },
		approved: [],
	});

function scopeFor(record: WorkerAdmissionRecord, over: Partial<ManagedWorkerTurnScope> = {}): ManagedWorkerTurnScope {
	return Object.freeze({
		revision: 1,
		token: randomUUID(),
		guard,
		runId: record.runId,
		admissionKey: record.key,
		admissionAttempt: record.attempt,
		ownerSessionId: record.sessionId,
		ownerInstanceKey: "main:1",
		parentAgentId: parentId,
		agentId: childId,
		actorSessionId,
		actorInstanceKey: actorInstance,
		generation,
		dispatchId: "iso_turn_1",
		kind: "first",
		...over,
	});
}

function childFor(over: Partial<WorkerTurnChildIdentity> = {}): WorkerTurnChildIdentity {
	return {
		sessionIdSha256: sha256Hex(actorSessionId),
		sessionFile: { canonicalPath: join(tmp, "child.jsonl"), device: "111", inode: "222" },
		checkout: { canonicalPath: join(tmp, "checkout"), device: "333", inode: "444" },
		registryInstance: actorInstance,
		generation,
		...over,
	};
}

const host = Object.freeze({ pid: process.pid, processStart: 12, host: "19.2.1" });

const integration = (record: WorkerAdmissionRecord) => Object.freeze({
	runId: record.runId,
	dispatch: "attempt:Impl:1:1",
	candidateId: `c1_${"a".repeat(64)}`,
	policyProofId: "policy-1",
	slotOwnerToken: "slot-owner-1",
	guardBuild: guard,
});

const bind = (record: WorkerAdmissionRecord, scope: ManagedWorkerTurnScope, child = childFor(), now?: number) =>
	bindWorkerAdmissionTurn({
		agentDir,
		key: record.key,
		attempt: record.attempt,
		turn: scope,
		child,
		integration: integration(record),
		host,
		...(now === undefined ? {} : { now }),
	});

const read = (record: WorkerAdmissionRecord, scope: ManagedWorkerTurnScope, over: { now?: number; expect?: Parameters<typeof readWorkerAdmissionTurn>[0]["expect"] } = {}) =>
	readWorkerAdmissionTurn({
		agentDir,
		key: record.key,
		attempt: scope.admissionAttempt,
		turnToken: scope.token,
		...(over.now === undefined ? {} : { now: over.now }),
		...(over.expect === undefined ? {} : { expect: over.expect }),
	});

const finish = (record: WorkerAdmissionRecord, scope: ManagedWorkerTurnScope, over: { session?: string; now?: number } = {}) =>
	endWorkerAdmissionTurn({
		agentDir,
		key: record.key,
		attempt: scope.admissionAttempt,
		turnToken: scope.token,
		childSessionId: over.session ?? actorSessionId,
		...(over.now === undefined ? {} : { now: over.now }),
	});

async function openRecord(key: string): Promise<WorkerAdmissionRecord> {
	const read = await readWorkerAdmissionByKey(agentDir, key);
	if (read.kind !== "record") throw new Error(`expected a record, received ${read.kind}`);
	expect(read.record.endedAt).toBeUndefined();
	return read.record;
}

describe("worker-turn durable claim", () => {
	test("binds one exact tuple, is idempotent, and ends only that attempt", async () => {
		const { record } = await admit();
		const scope = scopeFor(record);
		const first = await bind(record, scope);
		expect(first).toMatchObject({ kind: "bound", binding: { schema: "storm.worker-turn/v1", key: record.key, attempt: record.attempt } });
		expect(await bind(record, scope)).toMatchObject({ kind: "already-bound" });
		expect(await read(record, scope)).toMatchObject({ kind: "proved", record: { key: record.key, attempt: record.attempt } });
		expect(await finish(record, scope, { session: "other-session" })).toMatchObject({ kind: "refused", code: "session-mismatch" });
		await openRecord(record.key);
		expect(await finish(record, scope)).toMatchObject({ kind: "ended" });
		expect(await finish(record, scope)).toMatchObject({ kind: "already-ended" });
	});

	test("refuses a different token for the same attempt and never overwrites the first binding", async () => {
		const { record } = await admit();
		const scope = scopeFor(record);
		expect(await bind(record, scope)).toMatchObject({ kind: "bound" });
		const replacement = scopeFor(record);
		expect(await bind(record, replacement)).toMatchObject({ kind: "refused", code: "turn-conflict" });
		expect(await read(record, scope)).toMatchObject({ kind: "proved" });
		expect(await read(record, replacement)).toMatchObject({ kind: "refused", code: "turn-file-invalid" });
	});

	test("wrong run, attempt, actor, instance and generation are refused at bind", async () => {
		for (const [code, over] of [
			["integration-mismatch", { runId: "other-run" }],
			["turn-admission", { admissionAttempt: randomUUID() }],
			["child-mismatch", { actorSessionId: "other-session" }],
			["child-mismatch", { actorInstanceKey: "child:2" }],
			["child-mismatch", { generation: generation + 1 }],
		] as const) {
			const { record } = await admit();
			expect(await bind(record, scopeFor(record, over))).toMatchObject({ kind: "refused", code });
			await openRecord(record.key);
		}
	});

	test("a rotated attempt never lets the old turn read or end the newer record", async () => {
		const firstAdmit = await admit();
		const oldScope = scopeFor(firstAdmit.record);
		expect(await bind(firstAdmit.record, oldScope)).toMatchObject({ kind: "bound" });
		const secondAdmit = await admit();
		expect(await read(firstAdmit.record, oldScope)).toMatchObject({ kind: "refused", code: "attempt-replaced" });
		expect(await finish(firstAdmit.record, oldScope)).toMatchObject({ kind: "refused", code: "attempt-replaced" });
		expect(await openRecord(firstAdmit.record.key)).toMatchObject({ attempt: secondAdmit.record.attempt });
		const newScope = scopeFor(secondAdmit.record);
		expect(await bind(secondAdmit.record, newScope)).toMatchObject({ kind: "bound" });
		expect(await finish(secondAdmit.record, newScope)).toMatchObject({ kind: "ended" });
	});

	test("revoked and expired attempts refuse both work and end", async () => {
		const { record } = await admit();
		const scope = scopeFor(record);
		expect(await bind(record, scope)).toMatchObject({ kind: "bound" });
		expect(await revokeWorkerAdmissions(agentDir, { key: record.key, attempt: record.attempt })).toBe(1);
		expect(await read(record, scope)).toMatchObject({ kind: "refused", code: "revoked" });
		expect(await finish(record, scope)).toMatchObject({ kind: "refused", code: "revoked" });

		const next = await admit();
		const nextScope = scopeFor(next.record);
		expect(await bind(next.record, nextScope)).toMatchObject({ kind: "bound" });
		const afterExpiry = next.record.expiresAt + 1;
		expect(await read(next.record, nextScope, { now: afterExpiry })).toMatchObject({ kind: "refused", code: "expired" });
		expect(await finish(next.record, nextScope, { now: afterExpiry })).toMatchObject({ kind: "refused", code: "expired" });
	});

	test("a missing turn refuses read and end without creating or ending anything", async () => {
		const { record } = await admit();
		const scope = scopeFor(record);
		expect(await read(record, scope)).toMatchObject({ kind: "refused", code: "turn-missing" });
		expect(await finish(record, scope)).toMatchObject({ kind: "refused", code: "turn-missing" });
		await openRecord(record.key);
		expect(await bind(record, scope)).toMatchObject({ kind: "bound" });
		await rm(join(agentDir, "storm", "admissions", `${record.key}.${record.attempt}.turn`), { force: true });
		expect(await read(record, scope)).toMatchObject({ kind: "refused", code: "turn-missing" });
		expect(await finish(record, scope)).toMatchObject({ kind: "refused", code: "turn-missing" });
		await openRecord(record.key);
	});

	test("expectations compare the current native run, actor, instance, generation, dispatch and kind", async () => {
		const { record } = await admit();
		const scope = scopeFor(record);
		expect(await bind(record, scope)).toMatchObject({ kind: "bound" });
		expect(await read(record, scope, {
			expect: { runId: record.runId, actorSessionId, actorInstanceKey: actorInstance, generation, dispatchId: scope.dispatchId },
		})).toMatchObject({ kind: "proved" });
		expect(await read(record, scope, { expect: { runId: "other-run" } })).toMatchObject({ kind: "refused", code: "expect-run" });
		expect(await read(record, scope, { expect: { actorSessionId: "other-session" } })).toMatchObject({ kind: "refused", code: "expect-actor-session" });
		expect(await read(record, scope, { expect: { actorInstanceKey: "other:1" } })).toMatchObject({ kind: "refused", code: "expect-actor-instance" });
		expect(await read(record, scope, { expect: { generation: generation + 1 } })).toMatchObject({ kind: "refused", code: "expect-generation" });
		expect(await read(record, scope, { expect: { dispatchId: "iso_other" } })).toMatchObject({ kind: "refused", code: "expect-dispatch" });
		expect(await read(record, scope, { expect: { kind: "wake" } })).toMatchObject({ kind: "refused", code: "expect-kind" });
	});

	test("scope parsing is bounded and exact", async () => {
		const { record } = await admit();
		const scope = scopeFor(record);
		expect(parseWorkerTurnScope(scope)).toEqual(scope);
		expect(parseWorkerTurnScope({ ...scope, token: "" })).toBeUndefined();
		expect(parseWorkerTurnScope({ ...scope, token: "x".repeat(129) })).toBeUndefined();
		expect(parseWorkerTurnScope({ ...scope, runId: "x".repeat(513) })).toBeUndefined();
		expect(parseWorkerTurnScope({ ...scope, generation: -1 })).toBeUndefined();
		expect(parseWorkerTurnScope({ ...scope, generation: 1.5 })).toBeUndefined();
		expect(parseWorkerTurnScope({ ...scope, kind: "other" })).toBeUndefined();
		expect(parseWorkerTurnScope({ ...scope, revision: 2 })).toBeUndefined();
	});
});
