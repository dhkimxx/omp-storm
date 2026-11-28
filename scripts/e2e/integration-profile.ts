/**
 * The one omp profile shape the 0.30.0 integration scenarios use. Test support only; no product code imports it.
 *
 * The host's `task` tool passes only `{ requested }`; `task.isolation.apply`/`merge` are read by the host from Settings
 * before the spawn hook, and `isolation.backend` is read after it. The release profile therefore fixes an explicit
 * native backend (never `auto`), auto-apply off and patch merge. The main-thread control is `task.workerThreads: 0`;
 * the pooled profile leaves it at omp's default so a scenario can prove the actual stop instead of claiming parity.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type E2eEnv, PROFILE_CONFIG } from "./harness.ts";

export type IsolationMerge = "patch" | "branch";

export interface IsolationProfile {
	enabled: boolean;
	apply: boolean;
	merge: IsolationMerge;
	/** Explicit native backend, or `auto` only for a negative control. */
	backend: string;
	async: boolean;
	/** `0` is the main-thread control; `undefined` leaves omp's pooled default (4 on 19.2.1). */
	workerThreads?: number;
	/**
	 * Private-profile concurrency only; never used to claim a worker's thread or actual overlap. The patched host's
	 * native schema is a plain number with no maximum, so a guarded run writes exactly N and reads the effective value
	 * back instead of assuming a ceiling.
	 */
	maxConcurrency?: number;
	/** For the failed-yield/cancelled structured scenarios. */
	structured?: boolean;
}

/** The platform's explicit native backend. `auto` is deliberately not a fallback here. */
export function nativeBackend(): string {
	const requested = process.env.E2E_NATIVE_BACKEND?.trim();
	if (requested !== undefined && requested !== "" && requested !== "auto") return requested;
	switch (process.platform) {
		case "darwin":
			return "apfs";
		case "linux":
			return "reflink";
		default:
			return "rcopy";
	}
}

/** YAML after `setupVersion`, as `omp config set` would leave it. */
export function isolationProfileYaml(profile: IsolationProfile): string {
	const lines = [
		"task:",
		"  isolation:",
		`    enabled: ${profile.enabled}`,
		`    apply: ${profile.apply}`,
		`    merge: ${profile.merge}`,
	];
	if (profile.workerThreads !== undefined) lines.push(`  workerThreads: ${profile.workerThreads}`);
	if (profile.maxConcurrency !== undefined) lines.push(`  maxConcurrency: ${profile.maxConcurrency}`);
	if (profile.structured !== undefined) lines.push(`  structured: ${profile.structured}`);
	lines.push("isolation:", `  backend: ${profile.backend}`, "async:", `  enabled: ${profile.async}`);
	return `${lines.join("\n")}\n`;
}

/** Write the profile's settings file for the next omp process, without touching a real profile. */
export function writeIsolationProfile(env: E2eEnv, profile: IsolationProfile, name = env.profile): string {
	const dir = join(env.home, ".omp", "profiles", name, "agent");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "config.yml");
	writeFileSync(file, `${PROFILE_CONFIG}${isolationProfileYaml(profile)}`);
	return file;
}

export interface EffectiveSetting {
	value?: unknown;
	type?: string;
	description?: string;
}

/** Read the effective settings through the host's public CLI, not from the YAML just written. */
export function effectiveSettings(env: E2eEnv, name = env.profile): Record<string, EffectiveSetting> {
	const step = Bun.spawnSync([env.omp, "--profile", name, "config", "list", "--json"], {
		cwd: env.project,
		env: env.childEnv,
	});
	if (step.exitCode !== 0) throw new Error(`omp config list --json failed (${step.exitCode}): ${step.stderr.toString()}`);
	return JSON.parse(step.stdout.toString()) as Record<string, EffectiveSetting>;
}
