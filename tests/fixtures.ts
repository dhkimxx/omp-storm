/** Shared test data: one builder per shape the tests need (team config, ledger agent, run and spawn records, approved state). */
import * as path from "node:path";
import { ApprovalStore } from "../src/approval/store.ts";
import { configHash } from "../src/config/canonical.ts";
import { configPath } from "../src/config/store.ts";
import type { TreeState } from "../src/runtime/tree.ts";
import { sessionStoreDir } from "../src/session-scope.ts";
import type { ProjectState } from "../src/state.ts";
import type { AgentEntry, ApprovalRecord, RepoIdentity, RoleConfig, RunRecord, ShadowInfo, SpawnRecord, StormConfig } from "../src/types.ts";

/**
 * A `processKey()` of a process that cannot exist: its pid is above Linux's largest `pid_max` (4194304) and macOS's
 * (99998), so a signal-0 probe always answers "no such process".
 */
export const DEAD_PROCESS = "99999999:1";

/**
 * A team config. Each role is its models (one selector or a list) or the role's fields without `agent`, which is
 * always `storm-<id>`. Defaults: balanced, shared work tree.
 */
export function teamOf(roles: Record<string, string | string[] | Omit<RoleConfig, "agent">>, over: Partial<StormConfig> = {}): StormConfig {
	const role = (id: string, spec: string | string[] | Omit<RoleConfig, "agent">): RoleConfig => ({
		agent: `storm-${id}`,
		...(typeof spec === "string" ? { models: [spec] } : Array.isArray(spec) ? { models: spec } : spec),
	});
	return {
		version: 1,
		priority: "balanced",
		roles: Object.fromEntries(Object.entries(roles).map(([id, spec]) => [id, role(id, spec)])),
		isolation: "shared",
		...over,
	};
}

/** A ledger entry: an idle implementer named "Impl" with nothing counted yet. */
export function agentEntry(over: Partial<AgentEntry> = {}): AgentEntry {
	return {
		id: "Impl",
		name: "storm-implementer",
		role: "implementer",
		state: "idle",
		startedAt: 0,
		lastActivityAt: 0,
		contextTokens: 1_000,
		requests: 1,
		costUsd: 0,
		followUps: 0,
		...over,
	};
}

/** A work tree as `treeState` reports it: hashes only, so tests can move it without a repository. */
export function treeOf(diff = "diff-0", files = "files-0"): TreeState {
	return { diff, files };
}

/** A finished run record without spend or spawns. */
export function runRecord(over: Partial<RunRecord> = {}): RunRecord {
	return {
		schema: "storm.run/v1",
		runId: "run-1",
		configHash: "h",
		startedAt: "2026-11-20T09:00:00.000Z",
		status: "done",
		task: "task",
		costUsd: 0,
		costByModel: {},
		spawns: [],
		...over,
	};
}

/** A spawn Storm routed to the implementer's approved models. */
export function spawnRecord(over: Partial<SpawnRecord> = {}): SpawnRecord {
	return {
		ts: "2026-11-20T09:00:00.000Z",
		agent: "storm-implementer",
		invocationKind: "task",
		requested: [],
		outcome: "routed",
		spawnKey: "Impl",
		...over,
	};
}

/** A syntactically valid target binding no store owns; callers reading a store pass its exact targetKey instead. */
export const FIXTURE_TARGET = "0".repeat(64);

/** An approval record as 0.10 writes it, plus whatever older fields a test adds. */
export function approvalRecord(hash: string, over: Partial<ApprovalRecord> = {}, shadowedAgents: ShadowInfo[] = []): ApprovalRecord {
	return {
		schema: "storm.approval/v1",
		status: "active",
		target: FIXTURE_TARGET,
		configHash: hash,
		approvedAt: "2026-11-20T00:00:00.000Z",
		scope: { shadowedAgents },
		...over,
	};
}

/** The named session a bare `approvedState(root, config)` fixture belongs to. Only fixtures that do not care use it. */
export const FIXTURE_SESSION_ID = "fixture-session";

/**
 * A fixture profile outside `root` and the store of one named native session in it. The profile name includes the
 * work-tree directory's own name so unrelated temp projects never share a store; the session id itself is a caller
 * choice, never derived from the target path.
 */
export function fixtureSession(
	root: string,
	over: { agentDir?: string; sessionId?: string } = {},
): { agentDir: string; sessionId: string; sessionDir: string } {
	const agentDir = over.agentDir ?? path.join(path.dirname(root), `agent-${path.basename(root)}`);
	const sessionId = over.sessionId ?? FIXTURE_SESSION_ID;
	return { agentDir, sessionId, sessionDir: sessionStoreDir(agentDir, sessionId) };
}

export interface ApprovedStateOptions {
	/** A named native session, for a test that must reopen the same owner. */
	sessionId?: string;
	/** A profile agent dir outside the work tree; a fixture sibling of `root` when absent. */
	agentDir?: string;
	/** The canonical repository identity's stable id; the work tree root is always the real `root`. */
	repoId?: string;
}

/**
 * The project state of `config` approved as it is in a repo at `root`, for one native session in a profile outside
 * that work tree. Its config and approvals live under `sessionDir`; `repo.root` is only the approval target.
 */
export function approvedState(root: string, config: StormConfig, opts: ApprovedStateOptions = {}): ProjectState {
	const repo: RepoIdentity = { repoId: opts.repoId ?? "git-test-000000000000000000000000", kind: "git-common-dir", root };
	const sessionDir = fixtureSession(root, { ...(opts.agentDir !== undefined ? { agentDir: opts.agentDir } : {}), ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}) }).sessionDir;
	const store = new ApprovalStore(sessionDir, repo);
	const hash = configHash(config);
	return {
		repo,
		sessionDir,
		config: { status: "ok", path: configPath(sessionDir), config, hash, warnings: [] },
		// The in-memory approval carries the store's exact target binding, like one written to disk.
		approval: approvalRecord(hash, { target: store.targetKey }),
		shadows: [],
		store,
	};
}
