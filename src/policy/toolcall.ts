/**
 * The one decision about a tool call of a session that directs a Storm run: a file change by the director. Pure; the
 * extension gathers the inputs and counts what was blocked.
 */
import type { AgentEntry, Block, StormConfig, ToolBlockCode } from "../types.ts";
import { directorEditBlock } from "./director.ts";

export interface DirectorToolCall {
	toolName: string;
	input: unknown;
	/** Not read here since a read is no longer judged; the extension still passes the rest of the call. */
	cwd?: string;
	runId?: string;
	config?: StormConfig;
	agents?: readonly AgentEntry[];
}

/**
 * Refuses a file change by the director (`director-edit`) and nothing else. A large read of a file a subagent read
 * is the director's context size, which Storm protects by compacting; a follow-up to an agent whose records were
 * cleaned is answered by omp itself and explained by `followUpFailureNote` after the failure. Undefined lets the call
 * run.
 */
export function decideToolCall(call: DirectorToolCall): Block<ToolBlockCode> | undefined {
	return directorEditBlock(call.toolName, call.input);
}
