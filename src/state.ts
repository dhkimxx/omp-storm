import { join } from "node:path";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { resolveRepo } from "./approval/repo.ts";
import { findShadows, unattestedShadows, unapprovedShadows, type LiveDiscovery } from "./approval/shadow.ts";
import { ApprovalStore } from "./approval/store.ts";
import { loadConfig } from "./config/store.ts";
import { assertSessionStoreSafe, sessionStoreDir } from "./session-scope.ts";
import type { ApprovalRecord, ConfigLoad, Exec, RepoIdentity, ShadowInfo } from "./types.ts";

export interface ProjectEnv {
	cwd: string;
	exec: Exec;
	/** omp agent directory, profile-aware (`pi.pi.getAgentDir()`). */
	agentDir: string;
	/** This plugin's agents/ directory; its definitions never count as shadows. */
	pluginAgentsDir: string;
	/**
	 * Stable identity of the native main session this call acts for. Session state is keyed by it alone (with the
	 * profile), never by cwd: a different session or fork starts clean, while a resume of the exact same native id
	 * opens its own data again. A mutable "current session" global is never consulted.
	 */
	sessionId: string;
	/**
	 * The live session's native discovery inputs, read from its own registry handle. Absent means the handle is
	 * missing or does not own this session: that is unknown, never the same as a handle with empty roots, and every
	 * routed name is then unattested rather than resolved by a narrower scan.
	 */
	discovery?: LiveDiscovery | undefined;
}

export interface ProjectState {
	repo: RepoIdentity;
	/** This session's Storm store in the profile; every durable write outside approvals is below it. */
	sessionDir: string;
	config: ConfigLoad;
	/** The approval of the current config hash for this session and this canonical target. */
	approval: ApprovalRecord | undefined;
	shadows: ShadowInfo[];
	store: ApprovalStore;
}

/** Profile-level personal inputs (priors) that are not project or session state. */
export function stormDir(agentDir: string): string {
	return join(agentDir, "storm");
}

/**
 * The native discovery inputs of exactly `agentId`'s live handle, when that handle is the one owning `sessionId`.
 * The registry is process-global and ids can be reused across sessions, so a ref alone is not identity: the live
 * handle's own session id must match, and a blank id is unknown rather than an empty session. Any missing piece,
 * malformed roots, or throwing handle is undefined, which the caller must refuse rather than approximate.
 */
export function liveDiscovery(
	agentId: string,
	sessionId: string,
	registry: Pick<AgentRegistryApi, "get"> = AgentRegistry.global(),
): LiveDiscovery | undefined {
	if (typeof agentId !== "string" || agentId.length === 0) return undefined;
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	try {
		const live = registry.get(agentId)?.session;
		if (live === undefined || live === null) return undefined;
		if (live.sessionManager.getSessionId() !== sessionId) return undefined;
		const roots = live.effectiveExtensionRoots;
		if (
			roots === undefined ||
			(roots.mode !== "merge" && roots.mode !== "explicit-only") ||
			!Array.isArray(roots.explicit) ||
			!Array.isArray(roots.configured) ||
			(roots.configuredLevel !== "user" && roots.configuredLevel !== "project")
		) {
			return undefined;
		}
		const sessionAgents = live.getSessionAgents();
		if (!Array.isArray(sessionAgents)) return undefined;
		return { extensionRoots: roots, sessionAgents };
	} catch {
		return undefined;
	}
}

/** Stable identity of one discovery input set; `unknown` is distinct from every live set, empty roots included. */
function discoveryKey(discovery: LiveDiscovery | undefined): string {
	if (discovery === undefined) return "unknown";
	const roots = discovery.extensionRoots;
	const sessionAgents = discovery.sessionAgents.map(agent => `${agent.name}\u0001${agent.filePath ?? ""}`).join("\u0000");
	return JSON.stringify([roots.mode, roots.explicit, roots.configured, roots.configuredLevel, sessionAgents]);
}

/**
 * One git call (the target's top level and common dir), this session's config, the approval of its hash for that
 * target and the agent dirs. Nothing is created: an ordinary query only reads.
 */
export async function loadProjectState(env: ProjectEnv): Promise<ProjectState> {
	// Snapshot the identity once: a later mutation of the caller's env cannot redirect an in-flight load.
	const { cwd, exec, agentDir, pluginAgentsDir, sessionId, discovery } = env;
	const sessionDir = sessionStoreDir(agentDir, sessionId);
	const repo = await resolveRepo(cwd, exec);
	await assertSessionStoreSafe(sessionDir, repo.root);
	const store = new ApprovalStore(sessionDir, repo);
	const [config, shadows] = await Promise.all([
		loadConfig(sessionDir, repo.root),
		discovery === undefined
			? Promise.resolve(unattestedShadows())
			: findShadows({ cwd, pluginAgentsDir, discovery }),
	]);
	const approval = config.status === "ok" ? await store.active(config.hash) : undefined;
	return { repo, sessionDir, config, approval, shadows, store };
}

/** The user approved exactly what is on disk now: this config hash, for this target, and every shadowing definition. */
export function isApproved(state: ProjectState): boolean {
	const approval = state.approval;
	// The store only returns a record bound to its target; a missing or copied binding is never approval.
	return (
		approval !== undefined &&
		approval.target === state.store.targetKey &&
		unapprovedShadows(approval, state.shadows).length === 0
	);
}

/**
 * A batch of parallel spawns asks for the same state; a short cache keeps it to one git round trip. Entries are keyed
 * by the profile, the native session, the requested target, the plugin dir and the exact native-discovery identity, so
 * a cache hit can never hand one session's, worktree's or extension-root set's approval to another, and an unknown
 * handle never reuses a known-empty one. A failed load is dropped at once.
 */
export function createStateCache(ttlMs = 2_000) {
	const entries = new Map<string, { at: number; state: Promise<ProjectState> }>();
	return {
		get(env: ProjectEnv): Promise<ProjectState> {
			let key: string;
			try {
				key = `${env.agentDir}\0${env.sessionId}\0${env.cwd}\0${env.pluginAgentsDir}\0${discoveryKey(env.discovery)}`;
			} catch (error) {
				// A getter that cannot name the session must reject the read, not throw past the caller's promise handling.
				return Promise.reject(error);
			}
			const now = Date.now();
			const hit = entries.get(key);
			if (hit && now - hit.at < ttlMs) return hit.state;
			const state = loadProjectState(env);
			entries.set(key, { at: now, state });
			state.catch(() => entries.delete(key));
			return state;
		},
		clear(): void {
			entries.clear();
		},
	};
}
