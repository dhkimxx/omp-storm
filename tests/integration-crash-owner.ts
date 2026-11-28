/**
 * The process-owned fixture for `tests/integration-crash-fencing.test.ts`.
 *
 * It runs one real `IntegrationWriter` in its own OS process, with the real fixed `GitInstaller` and real `git`
 * children. In `crash-after-apply` mode the installer's second `git apply` really mutates the target, then the
 * process reports that fact on stdout and never returns from the awaited install: the test parent observes the
 * durable intent and fence, kills this process, and restarts as a second owner. No effect end or receipt can exist
 * because the writer never got an install outcome. In `complete` mode the same fixture runs to a real receipt.
 *
 * The fixture file is written by the parent test; this helper never invents target bytes, a manifest or a proof.
 */
import { readFile } from "node:fs/promises";
import type { AdmissionKey, IntegrationCandidateId, IntegrationTarget } from "../src/runtime/integration-admission.ts";
import type { ByteWindow, ExactDeltaProof } from "../src/runtime/integration-delta.ts";
import { GitDelta, GitInstaller, spawnGit, type GitRun } from "../src/runtime/integration-git.ts";
import {
	IntegrationJournal,
	IntegrationWriter,
	type CandidateRevision,
	type IntegrationLiveGrant,
	type SelectionSnapshot,
	type WriteAuthorityAudit,
} from "../src/runtime/integration-record.ts";
import { acquireRunLease } from "../src/runtime/lease.ts";
import { RunLanes } from "../src/runtime/lanes.ts";

interface OwnerFixture {
	readonly mode: "crash-after-apply" | "complete";
	readonly root: string;
	readonly sessionDir: string;
	readonly leaseDir: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly key: AdmissionKey;
	readonly candidateId: IntegrationCandidateId;
	readonly candidate: CandidateRevision;
	readonly patchPath: string;
	readonly target: IntegrationTarget;
	readonly proof: ExactDeltaProof;
	readonly selection: SelectionSnapshot;
	readonly audit: WriteAuthorityAudit;
}

async function say(value: Record<string, unknown>): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	process.stdout.write(`${JSON.stringify(value)}\n`, error => error === null || error === undefined ? resolve() : reject(error));
	await promise;
}

function window(): ByteWindow {
	return { maxBytes: 64 * 1024 * 1024, deadline: Date.now() + 120_000, signal: new AbortController().signal };
}

function liveGrant(fixture: OwnerFixture): IntegrationLiveGrant {
	return {
		audit: fixture.audit,
		signal: new AbortController().signal,
		check: () => ({ ok: true }),
		revalidateCandidate: async () => ({ ok: true }),
		checkCandidate: () => ({ ok: true }),
	};
}

/** Real git; once the mutating child has exited successfully, report and stay inside the install call. */
function crashAfterApply(): GitRun {
	return async (args, options) => {
		const result = await spawnGit(args, options);
		const mutating = args.includes("apply") && !args.includes("--check");
		if (!mutating) return result;
		if (!result.started || result.ended === false) {
			await say({ stage: "effect-unproved", started: result.started, ended: result.ended ?? null });
			process.exit(1);
		}
		if (result.code !== 0) {
			await say({ stage: "apply-failed", code: result.code, stderr: result.stderr.slice(0, 400) });
			process.exit(1);
		}
		await say({ stage: "applied", code: result.code });
		// An unresolved promise alone lets Bun exit with an empty event loop before the parent can kill this owner.
		setInterval(() => {}, 60_000);
		await Promise.withResolvers<never>().promise;
		throw new Error("unreachable: a hanging mutating apply returned");
	};
}

async function main(): Promise<void> {
	const file = process.argv[2];
	if (file === undefined) throw new Error("fixture path is required");
	const fixture = JSON.parse(await readFile(file, "utf8")) as OwnerFixture;
	const journal = new IntegrationJournal({ sessionDir: fixture.sessionDir, leaseDeps: { dir: fixture.leaseDir } });
	// The run table is process-local; the async frame below keeps this instance reachable until the effect is over.
	const lanes = new RunLanes(fixture.runId);
	const acquired = await acquireRunLease({
		sessionDir: fixture.sessionDir,
		sessionId: fixture.sessionId,
		root: fixture.root,
		runId: fixture.runId,
		mode: "write",
	}, { dir: fixture.leaseDir });
	if (!acquired.ok) {
		await say({ stage: "error", at: "lease", reason: acquired.reason });
		process.exit(1);
	}
	const patch = new Uint8Array(await readFile(fixture.patchPath));
	const bytes = { readPatch: async () => ({ kind: "known" as const, value: patch }) };
	const installer = new GitInstaller(fixture.mode === "crash-after-apply" ? crashAfterApply() : spawnGit);
	const writer = new IntegrationWriter({
		journal,
		bytes,
		delta: new GitDelta({ bytes, run: spawnGit }),
		run: spawnGit,
		installer,
	});
	const reserved = await writer.reserveSegment({
		lease: acquired.lease,
		target: fixture.target,
		selection: fixture.selection,
		live: liveGrant(fixture),
		window: window(),
	});
	if (reserved.kind === "unknown") {
		await say({ stage: "error", at: "reserve", problem: reserved.problem });
		process.exit(1);
	}
	const result = await writer.applyCandidate({
		holder: reserved.value,
		candidate: fixture.candidate,
		proof: fixture.proof,
		window: window(),
	});
	if (fixture.mode === "crash-after-apply") {
		await say({ stage: "unexpected-result", kind: result.kind, lanes: lanes.runId });
		process.exit(1);
	}
	await say({ stage: "written", kind: result.kind, lanes: lanes.runId });
	if (result.kind !== "written") process.exit(1);
	await writer.finishSegment(reserved.value);
	await acquired.lease.release();
	await say({ stage: "released" });
}

main().catch(async error => {
	try {
		await say({ stage: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
	} finally {
		process.exit(1);
	}
});
