import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { noteEvalModelCalls, recordEvalCost } from "./ledger.ts";

/**
 * Model calls that run outside a session's main loop reach no extension hook and no `message_end`: an eval cell's
 * `completion()` and `judge()`, `find`'s judge, `web_search`, `edit`'s auto repair, `judge_batch()`, auto thinking, a
 * compaction, a job caption. omp journals every one of them as a `model_usage` entry in the session file of the session
 * that made it, with the price it measured. This reads those entries back, by file and incrementally, so the run's
 * total counts them. It prices nothing itself, and it does not choose among them: every purpose counts (the models they
 * run on are the user's own omp roles, not the team's, see `docs/design.md`; their spend is the user's all the same).
 */

/** A session file larger than this is not read: the figure is then unknown and the total stays a floor. */
export const SIDE_SPEND_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** Tools whose call may make a side model call whose journal entry has not been written yet when the call's result arrives. */
const SIDE_CALL_TOOLS: ReadonlySet<string> = new Set(["find", "web_search"]);

/** Whether eval code asks a model through the helpers. A match in a comment or a string only widens the lower bound. */
export function usesModelHelpers(code: unknown): boolean {
	return typeof code === "string" && /(?<![\w.$])(?:completion|judge|judge_batch|judgeBatch)\s*\(/.test(code);
}

/**
 * The `model_usage` purpose omp gives the usage of an assistant turn it removed from the session (`discardEntryDurably`,
 * `session-manager.ts`, `DISCARDED_TURN_USAGE_PURPOSE`): it re-journals what the turn billed so that omp's own totals keep
 * counting it. That turn's usage already reached Storm at its `message_end`, so reading it again would count it twice.
 */
export const DISCARDED_TURN_PURPOSE = "discarded-turn";

/**
 * Whether a finished tool call may have made a side model call: the reading must then find an entry, or the total stays a
 * floor. A call that failed made none worth waiting for: the entry of one that did is counted when it is read, and the
 * reading at the turn's end lifts the mark.
 */
export function mayMakeSideCalls(toolName: string, input: unknown, isError = false): boolean {
	if (isError) return false;
	if (SIDE_CALL_TOOLS.has(toolName)) return true;
	return toolName === "eval" && usesModelHelpers((input as { code?: unknown } | undefined)?.code);
}

export interface SideSpendReading {
	/** Sum of the journaled side calls' cost written at or after `sinceMs`. */
	usd: number;
	calls: number;
}

/** How many of the last bytes read are kept to tell whether the file still continues what was read. */
const TAIL_BYTES = 64;

/**
 * Where the previous reading of one file ended, so a later reading parses only what was appended, and what it counted, so
 * that no entry is counted twice and none is skipped when omp rewrites the file (several of its maintenance steps rewrite
 * the whole session file, the same size or larger: `session-manager.ts` `rewriteEntries`, compaction commits).
 */
interface Cursor {
	/** Bytes consumed so far (whole lines only). */
	offset: number;
	/** The file's identity when it was read: an atomic rewrite replaces it. */
	ino: number;
	/** The last bytes consumed: when they are no longer where the offset says, the file was rewritten. */
	tail: Buffer;
	/** Entries with an id of their own (omp's always have one), counted once for ever. */
	ids: Set<string>;
	/** Entries without one, by their line, and how often each was counted: a read from the start adds only what exceeds it. */
	lines: Map<string, number>;
	usd: number;
	calls: number;
}
const cursors = new Map<string, Cursor>();

/** Forgets every cursor (tests). */
export function resetSideSpendCursors(): void {
	cursors.clear();
}

/**
 * Counts one journal line. `replay`: the file is read again from its start after a rewrite; `seen` then counts the entries
 * without an id of this pass, so a line that was counted before is not counted again.
 */
function add(cursor: Cursor, line: string, sinceMs: number, seen: Map<string, number> | undefined): void {
	// A cheap pre-filter: only a model_usage entry can matter, and most lines are not one.
	if (!line.includes('"model_usage"')) return;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (entry === null || typeof entry !== "object") return;
	const row = entry as { type?: unknown; id?: unknown; purpose?: unknown; timestamp?: unknown; usage?: { cost?: { total?: unknown } } };
	if (row.type !== "model_usage") return;
	// The usage of a turn omp dropped already reached Storm when the turn ended.
	if (row.purpose === DISCARDED_TURN_PURPOSE) return;
	const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
	if (Number.isFinite(at) && at < sinceMs) return;
	const total = row.usage?.cost?.total;
	if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return;
	if (typeof row.id === "string" && row.id !== "") {
		if (cursor.ids.has(row.id)) return;
		cursor.ids.add(row.id);
	} else {
		const times = (seen?.get(line) ?? 0) + 1;
		seen?.set(line, times);
		const counted = cursor.lines.get(line) ?? 0;
		if (seen !== undefined && times <= counted) return;
		cursor.lines.set(line, seen === undefined ? counted + 1 : times);
	}
	cursor.usd += total;
	cursor.calls += 1;
}

/** Whether the bytes just before the cursor's offset are still the ones that were read there. */
async function continuesWhatWasRead(handle: FileHandle,cursor: Cursor): Promise<boolean> {
	if (cursor.offset === 0 || cursor.tail.length === 0) return true;
	const check = Buffer.alloc(cursor.tail.length);
	const { bytesRead } = await handle.read(check, 0, check.length, cursor.offset - check.length);
	return bytesRead === check.length && check.equals(cursor.tail);
}

/**
 * The cost of side model calls journaled in one session file since `sinceMs` (the run's start), cumulative over the readings
 * of this process: each reading parses only the bytes appended since the last one. `undefined` when the file cannot be read
 * whole: the caller then keeps the total a floor rather than guess.
 */
export async function readSideSpend(sessionFile: string, sinceMs: number): Promise<SideSpendReading | undefined> {
	const key = `${sessionFile}\0${sinceMs}`;
	try {
		const handle = await fs.open(sessionFile, "r");
		try {
			// The handle's own stat: the size and the identity belong to the file that is read, not to a name that may move.
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > SIDE_SPEND_FILE_MAX_BYTES) return undefined;
			let cursor = cursors.get(key);
			if (cursor === undefined) {
				cursor = { offset: 0, ino: stat.ino, tail: Buffer.alloc(0), ids: new Set(), lines: new Map(), usd: 0, calls: 0 };
				cursors.set(key, cursor);
			}
			// A file omp rewrote (a new identity, a smaller size, or other bytes before the offset than were read there) is read
			// again from its start. What was counted stays counted, by entry, so the second pass adds only what is new.
			const rewritten = stat.ino !== cursor.ino || stat.size < cursor.offset || !(await continuesWhatWasRead(handle, cursor));
			if (rewritten) {
				cursor.offset = 0;
				cursor.ino = stat.ino;
				cursor.tail = Buffer.alloc(0);
			}
			if (stat.size > cursor.offset) {
				const length = stat.size - cursor.offset;
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
				const text = buffer.subarray(0, bytesRead);
				// Whole lines only: the last one may still be being written, and is read with the next reading.
				const end = text.lastIndexOf(0x0a);
				if (end >= 0) {
					const seen = rewritten ? new Map<string, number>() : undefined;
					for (const line of text.subarray(0, end).toString("utf8").split("\n")) add(cursor, line, sinceMs, seen);
					cursor.tail = Buffer.concat([cursor.tail, text.subarray(0, end + 1)]).subarray(-TAIL_BYTES);
					cursor.offset += end + 1;
				}
			}
			return { usd: cursor.usd, calls: cursor.calls };
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * A point where a managed session's journal is read back into the run (a finished tool call of a child, its turn's end, its
 * session's shutdown; the director's own calls during a run). `mayHaveCalled`: the call that just ended may have made a side
 * model call, so the total is a floor until an entry is found. A known file that cannot be read marks the total a floor too,
 * and so does an unknown file when `mayHaveCalled`. `closing`: the reading at a turn's end or a session's shutdown, when
 * omp has written what the turn made; a file read whole then has no call left to wait for, so it lifts the mark a call
 * that left no entry (a cached judgment, a provider that asks no model) had set. Never throws.
 */
export async function settleSideSpend(
	runId: string,
	sessionFile: string | undefined,
	sinceMs: number,
	mayHaveCalled = false,
	closing = false,
): Promise<void> {
	if (sessionFile === undefined || sessionFile === "") {
		if (mayHaveCalled) noteEvalModelCalls(runId, "unknown-session");
		return;
	}
	if (mayHaveCalled) noteEvalModelCalls(runId, sessionFile);
	const reading = await readSideSpend(sessionFile, sinceMs).catch(() => undefined);
	if (reading === undefined) {
		noteEvalModelCalls(runId, sessionFile);
		return;
	}
	// A call that may have been made and found nothing yet (omp has not flushed it): the floor stays until a later reading.
	if (mayHaveCalled && reading.calls === 0 && !closing) return;
	recordEvalCost(runId, sessionFile, reading.usd, mayHaveCalled || reading.calls > 0 || closing);
}
