/** Shared test data: one builder per shape the tests need (team config, ledger agent, run and spawn records, approved state). */
import * as path from "node:path";
import { ApprovalStore } from "../src/approval/store.ts";
import { configHash } from "../src/config/canonical.ts";
import { configPath } from "../src/config/store.ts";
import type { ProjectState } from "../src/state.ts";
import type { AgentEntry, ApprovalRecord, RepoIdentity, RoleConfig, RunRecord, ShadowInfo, SpawnRecord, StormConfig } from "../src/types.ts";

/**
 * A `processKey()` of a process that cannot exist: its pid is above Linux's largest `pid_max` (4194304) and macOS's
 * (99998), so a signal-0 probe always answers "no such process".
 */
export const DEAD_PROCESS = "99999999:1";

/**
 * A team config. Each role is its models (one selector or a list) or the role's fields without `agent`, which is
 * always `storm-<id>`. Defaults: balanced, parallelism 4, shared work tree.
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
		parallelism: 4,
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

/** An approval record as 0.10 writes it, plus whatever older fields a test adds. */
export function approvalRecord(hash: string, over: Partial<ApprovalRecord> = {}, shadowedAgents: ShadowInfo[] = []): ApprovalRecord {
	return { schema: "storm.approval/v1", status: "active", configHash: hash, approvedAt: "2026-11-20T00:00:00.000Z", scope: { shadowedAgents }, ...over };
}

/** The project state of `config` approved as it is, in a repo at `root` whose approval store lives under `<root>/agent`. */
export function approvedState(root: string, config: StormConfig, repoId = "git-test-000000000000000000000000"): ProjectState {
	const repo: RepoIdentity = { repoId, kind: "git-common-dir", root };
	const hash = configHash(config);
	return {
		repo,
		config: { status: "ok", path: configPath(root), config, hash, warnings: [] },
		approval: approvalRecord(hash),
		shadows: [],
		store: new ApprovalStore(path.join(root, "agent"), repo),
	};
}
