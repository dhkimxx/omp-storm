import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptReport } from "../src/runtime/attempt-report.ts";
import type { AttemptSettlement } from "../src/runtime/attempt-bridge.ts";
import type {
	FrozenIntegrationAdmission, IntegrationCandidateId, SpaceIdentity,
} from "../src/runtime/integration-admission.ts";
import type { SealedCaptureManifest } from "../src/runtime/integration-capture.ts";
import type { ExactDeltaProof, Presence } from "../src/runtime/integration-delta.ts";
import type {
	CandidateRevision, IntegrationLiveGrant, IntegrationWriterPort, SegmentHolder, WriteReceipt,
} from "../src/runtime/integration-record.ts";
import type { IntegrationPorts } from "../src/runtime/controller.ts";
import type { PathImage } from "../src/runtime/integration-admission.ts";
import type { RunPlan } from "../src/types.ts";
import { fakeSession, type FakeSession } from "./fake-session.ts";

const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

let temp: string | undefined;

afterEach(async () => {
	if (temp !== undefined) await rm(temp, { recursive: true, force: true });
	temp = undefined;
});

async function tempRoot(): Promise<string> {
	temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "storm-integration-controller-")));
	return temp;
}

async function space(root: string): Promise<SpaceIdentity> {
	const info = await stat(root, { bigint: true });
	return { canonicalPath: root, device: info.dev.toString(), inode: info.ino.toString() };
}

interface LaneSpec {
	name: string;
	files: readonly string[];
	resultId?: string;
	path?: string;
	contains?: string;
}

function planFor(lanes: readonly LaneSpec[]): RunPlan {
	return {
		lanes: lanes.map(lane => ({
			name: lane.name,
			kind: "code",
			role: "implementer",
			isolationReason: "integration test",
			files: [...lane.files],
			...(lane.resultId === undefined ? {} : {
				results: [{
					id: lane.resultId,
					kind: "change" as const,
					criterion: `${lane.path ?? lane.files[0] ?? "file"} contains the requested text`,
					path: lane.path ?? lane.files[0] ?? "file",
					...(lane.contains === undefined ? {} : { contains: lane.contains }),
				}],
			}),
		})),
		workers: { implementer: Math.max(1, lanes.length) },
		submittedAt: "2026-11-28T09:00:00.000Z",
	};
}

interface Harness {
	h: FakeSession;
	ports: IntegrationPorts;
	applied: CandidateRevision[];
	contents: Map<string, string | undefined>;
	frozen: FrozenIntegrationAdmission[];
	settlements: Map<string, AttemptSettlement>;
}

async function harness(lanes: readonly LaneSpec[]): Promise<Harness> {
	const root = await tempRoot();
	for (const lane of lanes) {
		for (const file of lane.files) {
			await writeFile(path.join(root, file), "before\n");
		}
	}
	const h = fakeSession({ root });
	const applied: CandidateRevision[] = [];
	const contents = new Map<string, string | undefined>();
	const frozen: FrozenIntegrationAdmission[] = [];
	const settlements = new Map<string, AttemptSettlement>();
	let lastRequest: { lease: Parameters<IntegrationWriterPort["reserveSegment"]>[0]["lease"]; live: IntegrationLiveGrant } | undefined;
	let sequence = 0;
	const ports: IntegrationPorts = {
		journal: {
			appendManifest: async () => ({ kind: "unknown", problem: { code: "test", reason: "unused" } }),
			appendRecovery: async () => ({ kind: "unknown", problem: { code: "test", reason: "unused" } }),
			readCandidate: async () => ({ kind: "known", value: null }),
			replay: async () => ({ kind: "known", value: null }),
			beginSelection: async selection => {
				const ordered = new Set(selection.ordered);
				const valid = selection.chosen.length > 0 && selection.chosen.length === selection.ordered.length &&
					new Set(selection.chosen).size === selection.chosen.length &&
					selection.chosen.every(candidate => ordered.has(candidate));
				return valid ? { ok: true } : { ok: false, problem: { code: "test-selection", reason: "invalid selection shape" } };
			},
			recordStep: async () => ({ ok: true }),
			findFence: async () => ({ kind: "clear" }),
			inspectFence: async () => ({ kind: "unknown", problem: { code: "test", reason: "unused" } }),
			resolveFence: async () => ({ kind: "kept", problem: { code: "test", reason: "unused" } }),
		},
		delta: {
			proveRoot: async () => ({ kind: "unknown", problem: { code: "test", reason: "unused" } }),
			verifyCheckoutInputs: async () => ({ ok: true }),
			observePresence: async (_target, paths): Promise<Presence> => {
				for (const located of paths) {
					const file = path.join(root, located.path);
					if (located.image.kind === "absent") {
						try {
							await stat(file);
						} catch {
							continue;
						}
						return { kind: "changed", observedAt: Date.now(), firstPath: located.path };
					}
					let read: Buffer;
					try {
						read = await readFile(file);
					} catch {
						return { kind: "changed", observedAt: Date.now(), firstPath: located.path };
					}
					if (read.length !== located.image.bytes || sha(read) !== located.image.sha256) {
						return { kind: "changed", observedAt: Date.now(), firstPath: located.path };
					}
				}
				return { kind: "present", observedAt: Date.now() };
			},
			observeDirtyPaths: async () => ({ kind: "known", value: { total: 0, examples: [], dirtyDeletes: [] } }),
		},
		writer: {
			reserveSegment: async request => {
				lastRequest = request;
				return { kind: "known", value: {} as SegmentHolder };
			},
			applyCandidate: async ({ candidate, proof }) => {
				sequence += 1;
				for (const entry of proof.entries) {
					const file = path.join(root, entry.targetPath);
					const content = contents.get(entry.targetPath) ?? "after\n";
					if (entry.after.state.kind === "absent") await unlink(file).catch(() => undefined);
					else await writeFile(file, content);
				}
				if (lastRequest === undefined) throw new Error("reserveSegment was not called");
				const receipt: WriteReceipt = {
					schema: "storm.integration-receipt/v1",
					ref: {
						key: candidate.key,
						candidateId: candidate.candidateId,
						manifestDigest: candidate.manifestDigest,
						intentSequence: sequence,
						receiptSequence: sequence,
					},
					intent: {
						schema: "storm.integration-intent/v1",
						sequence,
						candidate,
						deltaDigest: proof.digest,
						target: proof.target,
						index: { path: proof.entries[0]?.targetPath ?? "", file: null, sha256: null },
						head: { ref: null, oid: null },
						paths: proof.entries.map(entry => ({ path: entry.targetPath, before: entry.before.state, after: entry.after.state })),
						audit: lastRequest.live.audit,
						owner: lastRequest.lease.owner,
						holderKey: "holder",
						effectToken: `effect-${sequence}`,
					},
					end: { token: `effect-${sequence}`, basis: "installer-exit-proved", observedAt: Date.now() },
					readBackAt: Date.now(),
				};
				applied.push(candidate);
				return { kind: "written", receipt };
			},
			finishSegment: async () => ({ ok: true }),
		},
	};
	h.controller.attachIntegration(ports);
	const started = await h.controller.startWithPlan(h.ctx, { task: "integrate exact work" }, planFor(lanes));
	if (!started.ok) throw new Error(started.reason);
	return { h, ports, applied, contents, frozen, settlements };
}

function targetOf(h: FakeSession, identity: SpaceIdentity) {
	return {
		leaseKey: h.leases.held[0]!.record.key,
		authorizedRoot: identity,
		gitRoot: identity,
		gitDir: identity,
		sourceOdb: { commonDir: identity, objects: identity, objectFormat: "sha1" as const },
		targetPrefix: "",
	};
}

async function admit(
	run: Harness,
	options: { dispatch: string; lane: string; handle: string; ordinal: number; path?: string; prepare?: boolean },
): Promise<FrozenIntegrationAdmission> {
	const { h } = run;
	const runId = h.controller.active()!.runId;
	const key = { schema: "storm.integration-admission/v1" as const, runId, dispatch: options.dispatch };
	const candidateId = `c1_${sha(JSON.stringify([key.schema, key.runId, key.dispatch]))}` as IntegrationCandidateId;
	if (options.prepare === true) {
		const prepared = await h.controller.prepareAttempt({
			runId,
			lane: options.lane,
			spawnKey: options.handle,
			parentId: "main",
			dispatch: options.dispatch,
			followUp: false,
			artifactMode: "isolated",
			startedAt: Date.now(),
		});
		if (!prepared.ok) throw new Error(prepared.reason);
	}
	const identity = await space(h.repo.root);
	const toolCallId = `call-${options.dispatch}`;
	const policy = {
		id: `proof-${options.dispatch}`,
		host: "19.2.1" as const,
		settingsInstance: "settings",
		relevantEpoch: 1,
		directorInstance: "director",
		toolCallId,
		enabled: true as const,
		backendProofId: "backend",
		apply: false as const,
		merge: "patch" as const,
		captureContract: "native-git-synthetic-tree" as const,
		backendSetting: "native",
		profile: "profile",
		guardBuild: "guard",
	};
	const prepared = await h.controller.prepareAdmission({
		admission: {
			key,
			candidateId,
			director: { sessionId: h.sessionId, sessionDir: h.sessionDir, parentId: "main", sessionInstance: "instance" },
			target: targetOf(h, identity),
			artifactRoot: identity,
			item: { toolCallId, itemIndex: options.ordinal, handle: options.handle },
			placementOrdinal: options.ordinal,
			approvedDefinitionDigest: "definition",
			approvalDigest: "approval",
			workerAdmission: { key: `worker-${options.dispatch}`, attempt: `attempt-${options.dispatch}` },
			scope: { kind: "paths", paths: [options.path ?? "a.txt"] },
			policy,
			slot: { key, profile: "profile", slotPath: "/tmp/slot", ownerToken: "owner" },
			startedAt: Date.now(),
		},
		placement: { kind: "planned", lane: options.lane },
	});
	if (prepared.kind !== "known") throw new Error(prepared.problem.reason);
	const committed = h.controller.commitAdmission(key);
	if (!committed.ok) throw new Error(committed.problem.reason);
	run.frozen.push(prepared.value);
	return prepared.value;
}

async function settle(run: Harness, admission: FrozenIntegrationAdmission, attemptId: string): Promise<void> {
	const { h } = run;
	const runId = h.controller.active()!.runId;
	const lane = admission.subject.kind === "planned" ? admission.subject.lane : "";
	const report: AttemptReport = {
		schema: "storm.attempt-report/v1",
		runId,
		parentId: "main",
		spawnKey: admission.item.handle,
		attemptId,
		outcome: "success",
		capture: "observed",
		schemaStatus: "valid",
		observedAt: Date.now(),
		version: "19.2.1",
		artifacts: [],
		observations: [],
	};
	const settlement: AttemptSettlement = {
		runId,
		lane,
		spawnKey: admission.item.handle,
		parentId: "main",
		dispatch: admission.key.dispatch,
		startedAt: Date.now(),
		observedAt: Date.now(),
		report,
		citations: [],
	};
	run.settlements.set(admission.key.dispatch, settlement);
	await h.controller.settleAttempt(settlement);
}

function image(content: string): Extract<PathImage, { kind: "file" }> {
	const bytes = Buffer.byteLength(content);
	return { kind: "file", mode: "100644", bytes, sha256: sha(content) };
}

async function seal(
	run: Harness,
	admission: FrozenIntegrationAdmission,
	options: {
		path: string;
		before: string;
		after: string;
		contract: string;
		claimKnown?: boolean;
	},
): Promise<SealedCaptureManifest> {
	const { h } = run;
	const before = image(options.before);
	const after = image(options.after);
	const rootRef = {
		schema: "storm.integration-patch/v1" as const,
		key: admission.key,
		objectKey: `object-${admission.candidateId}`,
		bytes: options.after.length,
		sha256: sha(options.contract),
	};
	const proof: ExactDeltaProof = {
		schema: "storm.integration-delta/v1",
		key: admission.key,
		candidateId: admission.candidateId,
		target: admission.target,
		scope: admission.scope,
		sourceOdb: admission.target.sourceOdb,
		root: rootRef,
		digest: sha(`delta-${admission.candidateId}`),
		entries: [{
			gitPath: options.path,
			targetPath: options.path,
			encoding: "text",
			before: { state: before, oid: "1".repeat(40) },
			after: { state: after, oid: "2".repeat(40) },
		}],
		expandedBytes: Buffer.byteLength(options.after),
	};
	const identity = await space(h.repo.root);
	const terminal = {
		observedAt: Date.now(),
		outcome: { kind: "known" as const, value: "success" as const },
		structured: "not-requested" as const,
		stopCause: { kind: "unknown" as const, problem: { code: "test", reason: "no stop" } },
		cancelRequested: false,
		nativeLink: "agent://integration",
		carrier: "sync" as const,
		item: admission.item,
		exitCode: 0,
		aborted: false,
	};
	const childClaim = {
		key: admission.key,
		candidateId: admission.candidateId,
		entry: { registryInstance: "registry", generation: 1, childSessionFile: identity },
		childHandle: admission.item.handle,
		policyProofId: admission.policy.id,
		workerAttempt: admission.workerAdmission.attempt,
		slotOwnerToken: admission.slot.ownerToken,
		hostOwner: { pid: 1, processStart: 1, host: "host" },
		checkout: identity,
		checkoutGitDir: identity,
		checkoutIndexPath: "/tmp/index",
		checkoutTargetPrefix: "",
		sourceOdb: admission.target.sourceOdb,
		guardBuild: "guard",
		preWorkHead: null,
		checkedAt: Date.now(),
	};
	const manifest: SealedCaptureManifest = {
		schema: "storm.integration-capture/v1" as const,
		digest: sha(`manifest-${admission.candidateId}-${options.contract}`),
		admission,
		childClaim: options.claimKnown === false
			? { kind: "unknown" as const, problem: { code: "child-claim-missing", reason: "delayed child claim" } }
			: { kind: "known" as const, value: childClaim },
		terminal: { kind: "known" as const, value: terminal },
		bundle: { kind: "root-only" as const, basis: "native-success-registry" as const, root: rootRef },
		delta: { kind: "known" as const, value: proof },
		recovery: {
			root: { kind: "known" as const, value: { nativePath: `/tmp/${admission.candidateId}.patch`, copy: { kind: "known" as const, value: rootRef } } },
			nested: { kind: "known" as const, value: [] },
			branch: { kind: "unknown" as const, problem: { code: "test", reason: "no branch" } },
			checkout: { kind: "present" as const, checkedAt: Date.now() },
			nativeLink: { kind: "known" as const, value: "agent://integration" },
		},
	};
	const settlement = run.settlements.get(admission.key.dispatch);
	await h.controller.observe({
		kind: "sealed",
		manifest,
		journalSequence: 1,
		...(settlement === undefined ? {} : { settlement }),
	});
	return manifest;
}

function grant(h: FakeSession, deadline = Date.now() + 60_000): Omit<IntegrationLiveGrant, "revalidateCandidate" | "checkCandidate"> {
	return {
		audit: {
			selection: { runId: h.controller.active()!.runId, callId: "call" },
			director: { sessionId: h.sessionId, sessionDir: h.sessionDir, parentId: "main", sessionInstance: "instance" },
			conversationId: "conversation",
			askId: "ask",
			deadline,
		},
		signal: new AbortController().signal,
		check: () => ({ ok: true }),
	};
}

function rows(h: FakeSession) {
	return h.controller.active()?.results ?? [];
}

describe("integration controller", () => {
	test("an isolated change waits for its seal and explicit selection, and only the exact receipt accepts it", async () => {
		const run = await harness([{ name: "iso", files: ["a.txt"], resultId: "r1", path: "a.txt", contains: "after" }]);
		const admission = await admit(run, { dispatch: "d1", lane: "iso", handle: "iso", ordinal: 0, path: "a.txt", prepare: true });
		await settle(run, admission, "task:call-d1:iso");
		expect(rows(run.h)[0]).toMatchObject({ id: "r1", state: "pending" });
		expect(rows(run.h)[0]?.reason).toContain("캡처");

		await seal(run, admission, { path: "a.txt", before: "before\n", after: "after\n", contract: "one" });
		expect(rows(run.h)[0]).toMatchObject({ id: "r1", state: "pending" });
		expect(rows(run.h)[0]?.reason).toContain(admission.candidateId);
		expect(run.applied).toHaveLength(0);

		const reply = await run.h.controller.select({ candidateIds: [admission.candidateId], live: grant(run.h) });
		expect(reply.kind).toBe("selection");
		if (reply.kind !== "selection") throw new Error(reply.problem.reason);
		expect(reply).toMatchObject({ started: 1, written: 1, skipped: 0, notStarted: 0, firstNotStarted: null, stop: null });
		expect(run.applied.map(candidate => candidate.candidateId)).toEqual([admission.candidateId]);
		expect(rows(run.h)[0]).toMatchObject({ id: "r1", state: "accepted" });

		const readiness = await run.h.controller.laneReadiness(planFor([{ name: "iso", files: ["a.txt"], resultId: "r1", path: "a.txt", contains: "after" }]), new Set(["iso"]));
		expect(readiness.get("iso")?.results[0]).toMatchObject({ id: "r1", state: "accepted", integrated: true });

		const producer = run.h.controller.readIntegratedProducer({ runId: run.h.controller.active()!.runId, lane: "iso" });
		expect(producer.kind).toBe("known");
		if (producer.kind === "known") {
			expect(producer.value[0]).toMatchObject({ state: "integrated", subject: { kind: "result", id: "r1" } });
		}

		await writeFile(path.join(run.h.repo.root, "a.txt"), "drifted\n");
		const drifted = await run.h.controller.laneReadiness(planFor([{ name: "iso", files: ["a.txt"], resultId: "r1", path: "a.txt", contains: "after" }]), new Set(["iso"]));
		expect(drifted.get("iso")?.results[0]).toMatchObject({ id: "r1", state: "unmet", integrated: false });
		expect(drifted.get("iso")?.results[0]?.reason).toContain("presence-changed");
		const final = await run.h.controller.finish("verified");
		expect(final?.results?.[0]).toMatchObject({ id: "r1", state: "unmet", finalized: "revoked" });
	});

	test("a replan rechecks the exact receipt and reopens drifted integration", async () => {
		const lanes = [{ name: "iso", files: ["a.txt"], resultId: "r1", path: "a.txt", contains: "after" }] as const;
		const run = await harness(lanes);
		const admission = await admit(run, { dispatch: "d1", lane: "iso", handle: "iso", ordinal: 0, path: "a.txt", prepare: true });
		await settle(run, admission, "task:call-d1:iso");
		await seal(run, admission, { path: "a.txt", before: "before\n", after: "after\n", contract: "replan" });
		const reply = await run.h.controller.select({ candidateIds: [admission.candidateId], live: grant(run.h) });
		if (reply.kind !== "selection") throw new Error(reply.problem.reason);
		expect(reply.written).toBe(1);
		await writeFile(path.join(run.h.repo.root, "a.txt"), "drifted\n");
		const replanned = await run.h.controller.setPlan(run.h.ctx, planFor(lanes));
		expect(replanned.ok).toBe(true);
		expect(rows(run.h)[0]).toMatchObject({ id: "r1", state: "unmet" });
		expect(rows(run.h)[0]?.reason).toContain("presence-changed");
		expect(run.h.controller.readIntegratedProducer({ runId: run.h.controller.active()!.runId, lane: "iso" }).kind).toBe("unknown");
		await run.h.controller.finish("shutdown");
	});

	test("a sync seal without a bound child claim is never selectable, and a late observation does not promote it", async () => {
		const run = await harness([{ name: "iso", files: ["a.txt"], resultId: "r1", path: "a.txt", contains: "after" }]);
		const admission = await admit(run, { dispatch: "d1", lane: "iso", handle: "iso", ordinal: 0, path: "a.txt", prepare: true });
		await settle(run, admission, "task:call-d1:iso");
		const manifest = await seal(run, admission, {
			path: "a.txt", before: "before\n", after: "after\n", contract: "sync-claim", claimKnown: false,
		});
		// The terminal identity is not child placement: without the bound claim the candidate is recovery/awaiting proof.
		expect(rows(run.h)[0]?.state).toBe("unmet");
		expect(rows(run.h)[0]?.reason).toContain("delayed child claim");
		const detail = await run.h.controller.project(
			{ kind: "detail", candidateId: admission.candidateId },
			{ maxBytes: 1_000_000, deadline: Date.now() + 10_000, signal: new AbortController().signal },
		);
		if (detail.kind !== "detail") throw new Error("expected detail");
		expect(detail.value.line.readiness.kind).toBe("unknown");
		expect(detail.value.provenance.checkoutClaim.kind).toBe("unknown");

		const skipped = await run.h.controller.select({ candidateIds: [admission.candidateId], live: grant(run.h) });
		if (skipped.kind !== "selection") throw new Error(skipped.problem.reason);
		expect(skipped).toMatchObject({ started: 0, written: 0, skipped: 1, notStarted: 0 });
		expect(skipped.examples[0]).toMatchObject({ candidateId: admission.candidateId, state: "not-ready" });
		expect(run.applied).toHaveLength(0);

		// A late recovery observation may show the checkout; it cannot rewrite the immutable seal into readiness.
		await run.h.controller.observe({
			kind: "recovery",
			journalSequence: 2,
			observation: {
				schema: "storm.integration-recovery/v1",
				key: admission.key,
				candidateId: admission.candidateId,
				observationKey: "late-claim",
				observedAt: Date.now(),
				facts: { ...manifest.recovery, checkout: { kind: "present", checkedAt: Date.now() } },
				contradiction: { kind: "unknown", problem: { code: "test", reason: "no contradiction" } },
			},
		});
		const after = await run.h.controller.project(
			{ kind: "detail", candidateId: admission.candidateId },
			{ maxBytes: 1_000_000, deadline: Date.now() + 10_000, signal: new AbortController().signal },
		);
		if (after.kind !== "detail") throw new Error("expected detail");
		expect(after.value.line.readiness.kind).toBe("unknown");
		expect(after.value.recovery.checkout.kind).toBe("present");
		const stillRefused = await run.h.controller.select({ candidateIds: [admission.candidateId], live: grant(run.h) });
		if (stillRefused.kind !== "selection") throw new Error(stillRefused.problem.reason);
		expect(stillRefused.written).toBe(0);
		expect(run.applied).toHaveLength(0);
	});

	test("the whole ID list is validated before writes; stale candidates are skipped and ready ones apply in placement order", async () => {
		const run = await harness([
			{ name: "one", files: ["a.txt"], resultId: "r1", path: "a.txt", contains: "after" },
			{ name: "two", files: ["b.txt"], resultId: "r2", path: "b.txt", contains: "after" },
		]);
		const first = await admit(run, { dispatch: "d1", lane: "one", handle: "one", ordinal: 0, path: "a.txt", prepare: true });
		const second = await admit(run, { dispatch: "d2", lane: "two", handle: "two", ordinal: 1, path: "b.txt", prepare: true });
		await settle(run, first, "task:call-d1:one");
		await settle(run, second, "task:call-d2:two");
		await seal(run, first, { path: "a.txt", before: "before\n", after: "after\n", contract: "one" });
		await seal(run, second, { path: "b.txt", before: "before\n", after: "after\n", contract: "two" });

		const duplicate = await run.h.controller.select({ candidateIds: [first.candidateId, first.candidateId], live: grant(run.h) });
		expect(duplicate.kind).toBe("refused");
		const foreign = await run.h.controller.select({ candidateIds: [`c1_${"a".repeat(64)}`], live: grant(run.h) });
		expect(foreign.kind).toBe("refused");
		expect(run.applied).toHaveLength(0);

		// A newer attempt on lane two supersedes the sealed candidate without replacing it in the queue.
		await admit(run, { dispatch: "d2b", lane: "two", handle: "two", ordinal: 1, path: "b.txt", prepare: true });
		const skipped = await run.h.controller.select({ candidateIds: [second.candidateId, first.candidateId], live: grant(run.h) });
		expect(skipped.kind).toBe("selection");
		if (skipped.kind !== "selection") throw new Error(skipped.problem.reason);
		expect(skipped).toMatchObject({ started: 1, written: 1, skipped: 1, notStarted: 0 });
		expect(skipped.selection.chosen).toEqual([first.candidateId]);
		expect(skipped.selection.ordered).toEqual([first.candidateId]);
		expect(skipped.examples[0]).toMatchObject({ candidateId: second.candidateId, state: "not-ready" });
		expect(run.applied.map(candidate => candidate.candidateId)).toEqual([first.candidateId]);

		const fresh2 = run.frozen.find(frozen => frozen.key.dispatch === "d2b")!;
		await settle(run, fresh2, "task:call-d2b:two");
		await seal(run, fresh2, { path: "b.txt", before: "before\n", after: "after\n", contract: "two-b" });
		const ordered = await run.h.controller.select({ candidateIds: [fresh2.candidateId, first.candidateId], live: grant(run.h) });
		expect(ordered.kind).toBe("selection");
		if (ordered.kind !== "selection") throw new Error(ordered.problem.reason);
		expect(ordered.started).toBe(2);
		expect(ordered.selection.chosen).toEqual([fresh2.candidateId, first.candidateId]);
		expect(ordered.selection.ordered).toEqual([first.candidateId, fresh2.candidateId]);
		expect(run.applied.slice(1).map(candidate => candidate.candidateId)).toEqual([first.candidateId, fresh2.candidateId]);
	});

	test("a receipt whose changed path is outside the result scope never credits the change", async () => {
		const run = await harness([{ name: "iso", files: ["a.txt"], resultId: "r1", path: "a.txt", contains: "after" }]);
		const admission = await admit(run, { dispatch: "d1", lane: "iso", handle: "iso", ordinal: 0, path: "a.txt", prepare: true });
		await settle(run, admission, "task:call-d1:iso");
		await seal(run, admission, { path: "b.txt", before: "before\n", after: "after\n", contract: "outside" });
		run.contents.set("b.txt", "after\n");
		const reply = await run.h.controller.select({ candidateIds: [admission.candidateId], live: grant(run.h) });
		expect(reply.kind).toBe("selection");
		if (reply.kind !== "selection") throw new Error(reply.problem.reason);
		expect(reply.written).toBe(1);
		expect(rows(run.h)[0]).toMatchObject({ id: "r1", state: "pending" });
		expect(rows(run.h)[0]?.state).not.toBe("accepted");
		const producer = run.h.controller.readIntegratedProducer({ runId: run.h.controller.active()!.runId, lane: "iso" });
		expect(producer.kind).toBe("unknown");
	});

	test("a hundred exact candidates paginate twenty at a time with an exclusive cursor", async () => {
		const run = await harness([{ name: "bulk", files: ["a.txt"] }]);
		// A resultless lane keeps admission cheap: the same lane admits many exact candidates without result rows.
		const frozen = await admit(run, { dispatch: "bulk-0", lane: "bulk", handle: "bulk", ordinal: 0 });
		const admissions: FrozenIntegrationAdmission[] = [frozen];
		for (let index = 1; index < 100; index += 1) {
			admissions.push(await admit(run, {
				dispatch: `bulk-${index}`,
				lane: "bulk",
				handle: `bulk-${index}`,
				ordinal: index,
			}));
		}
		for (const admission of admissions) {
			await seal(run, admission, {
				path: `f-${admission.placementOrdinal}.txt`,
				before: "before\n",
				after: "after\n",
				contract: `bulk-${admission.placementOrdinal}`,
			});
		}
		const first = await run.h.controller.project({ kind: "overview" }, { maxBytes: 1_000_000, deadline: Date.now() + 10_000, signal: new AbortController().signal });
		if (first.kind !== "overview") throw new Error("expected overview");
		expect(first.value.page).toHaveLength(20);
		expect(first.value.examples).toHaveLength(3);
		expect(first.value.nextAfter).not.toBeNull();
		const second = await run.h.controller.project(
			{ kind: "overview", after: first.value.nextAfter! },
			{ maxBytes: 1_000_000, deadline: Date.now() + 10_000, signal: new AbortController().signal },
		);
		if (second.kind !== "overview") throw new Error("expected second overview");
		expect(second.value.page).toHaveLength(20);
		expect(second.value.page[0]).not.toBe(first.value.page[0]);
		expect(new Set([...first.value.page, ...second.value.page]).size).toBe(40);
		const unknown = await run.h.controller.project(
			{ kind: "overview", after: `c1_${"f".repeat(64)}` as IntegrationCandidateId },
			{ maxBytes: 1_000_000, deadline: Date.now() + 10_000, signal: new AbortController().signal },
		);
		expect(unknown.kind).toBe("unknown");
	});

	test("a resultless producer exposes a whole-footprint receipt, never a fake result", async () => {
		const run = await harness([{ name: "free", files: ["a.txt"] }]);
		const admission = await admit(run, { dispatch: "free-1", lane: "free", handle: "free", ordinal: 0 });
		await seal(run, admission, { path: "a.txt", before: "before\n", after: "after\n", contract: "free" });
		run.contents.set("a.txt", "after\n");
		const reply = await run.h.controller.select({ candidateIds: [admission.candidateId], live: grant(run.h) });
		expect(reply.kind).toBe("selection");
		if (reply.kind !== "selection") throw new Error(reply.problem.reason);
		expect(reply.written).toBe(1);
		const footprint = run.h.controller.readIntegratedProducer({ runId: run.h.controller.active()!.runId, lane: "free" });
		expect(footprint.kind).toBe("known");
		if (footprint.kind === "known") {
			expect(footprint.value).toHaveLength(1);
			expect(footprint.value[0]?.subject).toEqual({ kind: "resultless-footprint", lane: "free" });
		}
	});
});
