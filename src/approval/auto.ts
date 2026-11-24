/**
 * Automatic-delegation consent: one native session's private opt-in, stored directly in that session's Storm store
 * but never derived from an approval. Team approval says this session may run its approved team in the current
 * target; it says nothing about whether the main session should be supervised automatically. Losing team approval
 * therefore leaves this choice alone: the caller makes automatic delegation unavailable, it does not fall back to
 * direct mode. The caller always passes `ProjectState.sessionDir`, never a target path, approval dir or cwd.
 *
 * The file is explicit and versioned. Missing files and unsupported content are off; other filesystem errors
 * remain errors so a running supervisor can retain its last known policy.
 * Disabling writes `enabled: false` rather than falling back to absence.
 *
 * First local approval may establish the default with `initializeAutoDelegation`, which publishes a complete record
 * exactly once: it writes a same-directory temp file and hard-links it into place. `link(2)` fails with `EEXIST`
 * instead of replacing, so an explicit off, a concurrent initializer, and an existing malformed or differently
 * versioned file are all retained. Hard links are required (macOS and Linux); a filesystem that rejects them fails
 * closed.
 */
import { randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { writeTextAtomic } from "../fsutil.ts";
import { assertSessionStoreSafe } from "../session-scope.ts";

const FILE = "auto-delegation.json";
const SCHEMA = "storm.auto-delegation/v1";

export type AutoDelegationChoice = "on" | "off" | "unset" | "invalid";

interface AutoDelegationState {
	schema: typeof SCHEMA;
	enabled: boolean;
}

function isState(value: unknown): value is AutoDelegationState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	return state.schema === SCHEMA && typeof state.enabled === "boolean";
}

function assertInputs(sessionDir: string, enabled: boolean): void {
	if (typeof sessionDir !== "string" || sessionDir.trim() === "") throw new Error("자동 위임 상태를 저장할 세션 저장소 경로가 없습니다");
	if (typeof enabled !== "boolean") throw new Error("자동 위임 상태는 true 또는 false 여야 합니다");
}

/**
 * The durable choice as stored: `unset` only when the state file is absent, `invalid` for a blank session path or
 * content that is not a v1 state. Any other I/O failure is reported so callers can distinguish absence from an
 * unreadable session store. This is the single reader behind `readAutoDelegation`.
 */
export async function readAutoDelegationChoice(sessionDir: string, targetRoot?: string): Promise<AutoDelegationChoice> {
	if (typeof sessionDir !== "string" || sessionDir.trim() === "") return "invalid";
	await assertSessionStoreSafe(sessionDir, targetRoot);
	let text: string;
	try {
		text = await readFile(path.join(sessionDir, FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unset";
		throw error;
	}
	try {
		const state: unknown = JSON.parse(text);
		if (!isState(state)) return "invalid";
		return state.enabled ? "on" : "off";
	} catch (error) {
		if (error instanceof SyntaxError) return "invalid";
		throw error;
	}
}

/**
 * Whether this native session explicitly opted in. Only `on` is true; unset, off and invalid content are false.
 * An I/O failure other than absence is reported to the caller. No team or host settings are consulted.
 */
export async function readAutoDelegation(sessionDir: string, targetRoot?: string): Promise<boolean> {
	return (await readAutoDelegationChoice(sessionDir, targetRoot)) === "on";
}

/**
 * Establishes the default once, when first local approval has no stored choice. Returns true only for the call that
 * published the record; false means the path already existed and was left untouched. Publication is a same-directory
 * temp write, sync, and hard link, so a competing initializer or an explicit off written at any point still wins:
 * `link(2)` never replaces. A failed attempt removes its temp and publishes nothing.
 */
export async function initializeAutoDelegation(sessionDir: string, enabled: boolean, targetRoot?: string): Promise<boolean> {
	assertInputs(sessionDir, enabled);
	await assertSessionStoreSafe(sessionDir, targetRoot);
	const file = path.join(sessionDir, FILE);
	try {
		await lstat(file);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(sessionDir, { recursive: true });
	const tmp = path.join(sessionDir, `.${FILE}.${process.pid}.${randomUUID()}.tmp`);
	const state: AutoDelegationState = { schema: SCHEMA, enabled };
	try {
		const handle = await open(tmp, "wx");
		try {
			await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
			// The link publishes the record; sync first so a host crash cannot publish an empty/partial choice.
			await handle.sync();
		} finally {
			await handle.close().catch(() => undefined);
		}
		try {
			await link(tmp, file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		return true;
	} finally {
		// The published file has its own directory entry; the temp name is ours even when another writer won the link.
		await rm(tmp, { force: true }).catch(() => undefined);
	}
}

/**
 * Persists the explicit choice with one atomic replace. `false` is durable state, not a deletion: the file keeps
 * saying no until the user says yes again. Other files under `sessionDir` are untouched, and no omp setting is read
 * or written. A missing session directory is created by the atomic writer.
 */
export async function writeAutoDelegation(sessionDir: string, enabled: boolean, targetRoot?: string): Promise<void> {
	assertInputs(sessionDir, enabled);
	await assertSessionStoreSafe(sessionDir, targetRoot);
	const state: AutoDelegationState = { schema: SCHEMA, enabled };
	await writeTextAtomic(path.join(sessionDir, FILE), `${JSON.stringify(state, null, 2)}\n`);
}
