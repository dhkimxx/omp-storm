import { join } from "node:path";
import { resolveRepo } from "./approval/repo.ts";
import { findShadows, unapprovedShadows } from "./approval/shadow.ts";
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
 * One git call (the target's top level and common dir), this session's config, the approval of its hash for that
 * target and the agent dirs. Nothing is created: an ordinary query only reads.
 */
export async function loadProjectState(env: ProjectEnv): Promise<ProjectState> {
	// Snapshot the identity once: a later mutation of the caller's env cannot redirect an in-flight load.
	const { cwd, exec, agentDir, pluginAgentsDir, sessionId } = env;
	const sessionDir = sessionStoreDir(agentDir, sessionId);
	const repo = await resolveRepo(cwd, exec);
	await assertSessionStoreSafe(sessionDir, repo.root);
	const store = new ApprovalStore(sessionDir, repo);
	const [config, shadows] = await Promise.all([
		loadConfig(sessionDir, repo.root),
		findShadows({ cwd, userAgentsDir: join(agentDir, "agents"), pluginAgentsDir }),
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
 * by the profile, the native session, the requested target and the plugin dir, so a cache hit can never hand one
 * session's or worktree's approval to another. A failed load is dropped at once.
 */
export function createStateCache(ttlMs = 2_000) {
	const entries = new Map<string, { at: number; state: Promise<ProjectState> }>();
	return {
		get(env: ProjectEnv): Promise<ProjectState> {
			let key: string;
			try {
				key = `${env.agentDir}\0${env.sessionId}\0${env.cwd}\0${env.pluginAgentsDir}`;
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
