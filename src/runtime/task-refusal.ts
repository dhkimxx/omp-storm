/**
 * How Storm refuses a `task` call without leaving a transcript block that omp's own view cannot draw.
 *
 * A `tool_call` handler that answers `{ block: true }` ends the call in the host's agent loop before the tool wrapper
 * runs: the result is `{ content: [reason], details: {}, isError: true }`, and no `tool_result` event is emitted for it.
 * omp 19.2's `task` view (`ui/tools/task.tsx`) reads any truthy `details` as a full task record and spreads
 * `details.results`, which `{}` lacks: the view throws while the result is painted, is recomputed on the next
 * expansion, and the same `{}` in the session file makes `--resume` fail on load. Every other built-in tool's view draws
 * that result (checked against all registered presenters), so only `task` needs this.
 *
 * What does draw: a result whose `details` is omp's own empty task record. The one way for an extension to produce a
 * result of its own is to let the call run: `tool_result` is emitted for a call that executed, and the wrapper returns the
 * handler's `content`/`details`/`isError` instead of the tool's. So a refusal is a call whose input omp's `task` tool
 * rejects before it does anything (its stale `schema` field, `validateShapeParams` in `task/index.ts`), and Storm swaps
 * the rejection text for its own reason in `tool_result`. The call can never start a worker: the rejection comes before
 * any spawn, and the input keeps every field the director sent, so the transcript still shows what was refused.
 *
 * That rejection is the first layer and it rests on omp. The second layer is Storm's own: while a refused call is
 * unsettled, `before_subagent_spawn` refuses every spawn of the main session (the event carries no call id, and without
 * a reservation a manual-direction spawn would be admitted as the lane its name or role matches, past every reason the
 * call was refused for), so a host that ran the call anyway starts no worker. Behind that, a child that starts without
 * an admission record is denied every non-read tool (`[storm:authority]`) once its parent has admitted any worker of the run.
 */

/** The field omp's `task` tool rejects ("use `outputSchema`") before any validation of the work or any spawn. */
export const REFUSAL_FIELD = "schema";
/** The value that marks a refused call's input; the code of the refusal follows the colon. */
export const REFUSAL_MARK = "storm-refused";

/** Remembered refusals are bounded: a call the host never ran (an abort) must not keep its entry forever. */
const MAX_REMEMBERED = 256;
/** How long a refused call that never settled still holds back spawns; a settled one ends the hold at once. */
export const REFUSAL_WINDOW_MS = 60_000;

/** omp's empty task record: what its own task errors carry as `details`, and what its view draws as "no agents". */
export interface TaskRecordShell {
	projectAgentsDir: null;
	results: [];
	totalDurationMs: 0;
}
export const emptyTaskRecord = (): TaskRecordShell => ({ projectAgentsDir: null, results: [], totalDurationMs: 0 });

/** The result a refused call ends with: the reason as text, an error, and a record omp's view can draw. */
export interface RefusedTaskResult {
	content: Array<{ type: "text"; text: string }>;
	details: TaskRecordShell;
	isError: true;
}

/** The `[storm:<code>]` tag a refusal reason starts with, or `refused` for a reason without one. */
export function refusalCode(reason: string): string {
	return /^\[storm:([a-z0-9-]+)\]/.exec(reason)?.[1] ?? "refused";
}

/** The input a refused call runs with: what the director sent, plus the field omp's `task` tool rejects. */
export function refusedTaskInput(input: unknown, reason: string): Record<string, unknown> {
	const sent = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	return { ...sent, [REFUSAL_FIELD]: `${REFUSAL_MARK}:${refusalCode(reason)}` };
}

/** Whether an input is one `refusedTaskInput` made, and the code it carries. */
export function refusedCodeOf(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const mark = (input as Record<string, unknown>)[REFUSAL_FIELD];
	return typeof mark === "string" && mark.startsWith(`${REFUSAL_MARK}:`) ? mark.slice(REFUSAL_MARK.length + 1) : undefined;
}

/** The result of a refused call. */
export const refusedTaskResult = (reason: string): RefusedTaskResult => ({
	content: [{ type: "text", text: reason }],
	details: emptyTaskRecord(),
	isError: true,
});

/**
 * The reasons of the calls Storm turned into refusals, by the host's call id, until their result arrives. A call the
 * host never settles (an abort that skips the result) stops counting as unsettled after `REFUSAL_WINDOW_MS`.
 */
export class RefusedCalls {
	readonly #reasons = new Map<string, { reason: string; at: number }>();

	remember(callId: string, reason: string, now: number = Date.now()): void {
		this.#reasons.delete(callId);
		this.#reasons.set(callId, { reason, at: now });
		while (this.#reasons.size > MAX_REMEMBERED) {
			const oldest = this.#reasons.keys().next().value;
			if (oldest === undefined) break;
			this.#reasons.delete(oldest);
		}
	}

	/** The reason of this call, once: its result is being settled. */
	take(callId: string): string | undefined {
		const entry = this.#reasons.get(callId);
		this.#reasons.delete(callId);
		return entry?.reason;
	}

	/** Forgets every call: the conversation they belonged to is gone. */
	clear(): void {
		this.#reasons.clear();
	}

	/** Forgets a call that ended without a result (cancelled, aborted). */
	forget(callId: string): void {
		this.#reasons.delete(callId);
	}

	/** The reason of a refused call that is still unsettled, or undefined: while one is, no spawn may start. */
	unsettled(now: number = Date.now()): string | undefined {
		for (const entry of this.#reasons.values()) if (now - entry.at < REFUSAL_WINDOW_MS) return entry.reason;
		return undefined;
	}

	get size(): number {
		return this.#reasons.size;
	}
}
