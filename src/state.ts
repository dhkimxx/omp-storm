import { join } from "node:path";
import { resolveRepo } from "./approval/repo.ts";
import { findShadows } from "./approval/shadow.ts";
import { ApprovalStore } from "./approval/store.ts";
import { loadConfig } from "./config/store.ts";
import type { ApprovalRecord, ConfigLoad, Exec, RepoIdentity, ShadowInfo } from "./types.ts";

export interface ProjectEnv {
	cwd: string;
	exec: Exec;
	/** omp agent directory, profile-aware (`pi.pi.getAgentDir()`). */
	agentDir: string;
	/** This plugin's agents/ directory; its definitions never count as shadows. */
	pluginAgentsDir: string;
}

export interface ProjectState {
	repo: RepoIdentity;
	config: ConfigLoad;
	/** Active approval for the current config hash. */
	approval: ApprovalRecord | undefined;
	shadows: ShadowInfo[];
	store: ApprovalStore;
}

export function stormDir(agentDir: string): string {
	return join(agentDir, "storm");
}

export async function loadProjectState(env: ProjectEnv): Promise<ProjectState> {
	const repo = await resolveRepo(env.cwd, env.exec);
	const store = new ApprovalStore(stormDir(env.agentDir), repo);
	const [config, shadows] = await Promise.all([
		loadConfig(repo.root),
		findShadows({ cwd: env.cwd, userAgentsDir: join(env.agentDir, "agents"), pluginAgentsDir: env.pluginAgentsDir }),
	]);
	const approval = config.status === "ok" ? await store.active(config.hash) : undefined;
	return { repo, config, approval, shadows, store };
}

/** A batch of parallel spawns asks for the same state; a short cache keeps it to one git round trip. */
export function createStateCache(ttlMs = 2_000) {
	const entries = new Map<string, { at: number; state: Promise<ProjectState> }>();
	return {
		get(env: ProjectEnv): Promise<ProjectState> {
			const now = Date.now();
			const hit = entries.get(env.cwd);
			if (hit && now - hit.at < ttlMs) return hit.state;
			const state = loadProjectState(env);
			entries.set(env.cwd, { at: now, state });
			state.catch(() => entries.delete(env.cwd));
			return state;
		},
		clear(): void {
			entries.clear();
		},
	};
}
