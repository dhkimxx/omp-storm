/**
 * Two small profile-level records beside the session stores (`<agentDir>/storm/`), neither of them consent:
 *
 * - The last approved team per target (`last-team/<targetKey>.json`): the approved `StormConfig` and when it was saved,
 *   nothing else (no approval record, no hash, no run data, no shadowing definitions). A new session for the same target
 *   offers it as a suggestion; approving it still goes through the approval dialog and is recorded in that session.
 * - The onboarding marker (`onboarded.json`): the one-time "Storm 설치됨" notice was shown in this profile.
 *
 * The target key is `ApprovalStore.targetKey` (the full hash of the target's kind and canonical root), so linked worktrees
 * of one repository keep separate suggestions. A damaged or invalid file is no suggestion.
 */
import { lstat, rm } from "node:fs/promises";
import * as path from "node:path";
import { validateConfig } from "../config/schema.ts";
import { readJson, writeJsonAtomic } from "../fsutil.ts";
import type { StormConfig } from "../types.ts";

const LAST_TEAM_SCHEMA = "storm.last-team/v1";
const ONBOARDED_SCHEMA = "storm.onboarded/v1";
const TARGET_KEY_RE = /^[0-9a-f]{64}$/;

export interface LastTeam {
	config: StormConfig;
	/** ISO 8601 of the approval that saved it. */
	savedAt: string;
}

function profileStorm(agentDir: string): string {
	if (typeof agentDir !== "string" || !path.isAbsolute(agentDir)) throw new Error("에이전트 디렉터리는 절대 경로여야 합니다");
	return path.join(agentDir, "storm");
}

export function lastTeamPath(agentDir: string, targetKey: string): string {
	if (!TARGET_KEY_RE.test(targetKey)) throw new Error("작업 대상 키가 올바르지 않습니다");
	return path.join(profileStorm(agentDir), "last-team", `${targetKey}.json`);
}

/** Saves the team just approved for this target, replacing the earlier one. */
export async function saveLastTeam(agentDir: string, targetKey: string, config: StormConfig, now: Date = new Date()): Promise<void> {
	await writeJsonAtomic(lastTeamPath(agentDir, targetKey), { schema: LAST_TEAM_SCHEMA, savedAt: now.toISOString(), config });
}

/** The saved team of this target when the file is intact and the config validates today; otherwise undefined. */
export async function loadLastTeam(agentDir: string, targetKey: string): Promise<LastTeam | undefined> {
	const value = await readJson(lastTeamPath(agentDir, targetKey));
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { schema?: unknown; savedAt?: unknown; config?: unknown };
	if (record.schema !== LAST_TEAM_SCHEMA || typeof record.savedAt !== "string" || !Number.isFinite(Date.parse(record.savedAt))) return undefined;
	const checked = validateConfig(record.config);
	return checked.config ? { config: checked.config, savedAt: record.savedAt } : undefined;
}

/** `/storm reset`: removes this target's suggestion; true when there was a file. */
export async function clearLastTeam(agentDir: string, targetKey: string): Promise<boolean> {
	const file = lastTeamPath(agentDir, targetKey);
	const existed = await exists(file);
	await rm(file, { force: true });
	return existed;
}

function onboardedPath(agentDir: string): string {
	return path.join(profileStorm(agentDir), "onboarded.json");
}

async function exists(file: string): Promise<boolean> {
	try {
		await lstat(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Whether this profile already showed the one-time install notice. A file that cannot be read counts as shown. */
export async function onboarded(agentDir: string): Promise<boolean> {
	return exists(onboardedPath(agentDir)).catch(() => true);
}

export async function markOnboarded(agentDir: string, now: Date = new Date()): Promise<void> {
	await writeJsonAtomic(onboardedPath(agentDir), { schema: ONBOARDED_SCHEMA, at: now.toISOString() });
}

/** The one-time line a new profile sees at session start. */
export const ONBOARDING_NOTICE = "Storm 설치됨 — /storm 으로 팀을 승인하면 작업이 팀에 위임됩니다";

/**
 * At session start: when this session has no team config and the profile never showed the notice, records that it
 * was shown and then shows it. The record comes first, so a profile that cannot take it shows nothing rather than the
 * same line in every session. True when the notice was shown.
 */
export async function onboardOnce(agentDir: string, hasTeamConfig: boolean, notify: (text: string) => void): Promise<boolean> {
	if (hasTeamConfig || (await onboarded(agentDir))) return false;
	await markOnboarded(agentDir);
	notify(ONBOARDING_NOTICE);
	return true;
}
