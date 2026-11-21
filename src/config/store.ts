import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextAtomic } from "../fsutil.ts";
import type { ConfigLoad, StormConfig } from "../types.ts";
import { configHash, formatJson, parseStrictJson, sha256Hex } from "./canonical.ts";
import { validateConfig } from "./schema.ts";

export function configPath(root: string): string {
	return path.join(root, ".omp", "storm", "config.json");
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function loadConfig(root: string): Promise<ConfigLoad> {
	const file = configPath(root);
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

/** Saves a team Storm built. Never used to migrate a file the user wrote: that one is only ever read. */
export async function writeConfig(root: string, config: StormConfig): Promise<{ path: string; hash: string }> {
	const file = configPath(root);
	await writeTextAtomic(file, serializeConfig(config));
	try {
		await fs.writeFile(path.join(path.dirname(file), ".gitignore"), "/state/\n", { flag: "wx" });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	return { path: file, hash: configHash(config) };
}
