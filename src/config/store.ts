import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextAtomic } from "../fsutil.ts";
import { assertSessionStoreSafe } from "../session-scope.ts";
import type { ConfigLoad, StormConfig } from "../types.ts";
import { configHash, formatJson, parseStrictJson, sha256Hex } from "./canonical.ts";
import { validateConfig } from "./schema.ts";

/**
 * This session's team config, inside its own Storm store. It is never written to the target worktree and never
 * read from `.omp/storm/` there: files an older Storm wrote stay byte-untouched, and a new or forked session starts
 * without a team.
 */
export function configPath(sessionDir: string): string {
	if (typeof sessionDir !== "string" || sessionDir.trim() === "") {
		throw new Error("세션 저장소 디렉터리가 없습니다");
	}
	return path.join(sessionDir, "config.json");
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function loadConfig(sessionDir: string, targetRoot?: string): Promise<ConfigLoad> {
	await assertSessionStoreSafe(sessionDir, targetRoot);
	const file = configPath(sessionDir);
	let raw: Uint8Array;
	try {
		raw = await fs.readFile(file);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { status: "missing", path: file };
		return { status: "invalid", path: file, errors: [`설정 파일을 읽지 못했습니다 (${errorCode(error) ?? "오류"})`] };
	}
	const rawSha256 = sha256Hex(raw);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
	} catch {
		return { status: "invalid", path: file, errors: ["UTF-8 파일이 아닙니다"], rawSha256 };
	}
	const parsed = parseStrictJson(text);
	if (!parsed.ok) return { status: "invalid", path: file, errors: [`JSON 오류: ${parsed.error}`], rawSha256 };
	const checked = validateConfig(parsed.value);
	if (!checked.config) return { status: "invalid", path: file, errors: checked.errors, rawSha256 };
	// Hash the whole parsed value so unknown fields are part of what gets approved.
	return {
		status: "ok",
		path: file,
		config: checked.config,
		hash: configHash(parsed.value),
		warnings: checked.warnings,
	};
}

/** Sorted keys (JCS order), 2-space indent, LF, trailing newline. */
export function serializeConfig(config: StormConfig): string {
	return `${formatJson(config, "  ")}\n`;
}

/**
 * Saves a team Storm built into this session's own store. It never migrates, edits or deletes a config the user wrote
 * in the target, and it writes no `.gitignore`: the session directory lives inside the profile, not the workspace.
 */
export async function writeConfig(
	sessionDir: string,
	config: StormConfig,
	targetRoot?: string,
): Promise<{ path: string; hash: string }> {
	await assertSessionStoreSafe(sessionDir, targetRoot);
	const file = configPath(sessionDir);
	await writeTextAtomic(file, serializeConfig(config));
	return { path: file, hash: configHash(config) };
}
