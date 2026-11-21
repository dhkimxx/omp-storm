/**
 * The one decision about a tool call of a session that directs a Storm run. Pure apart from the read index and file
 * sizes `directorRead` looks up; the extension gathers the inputs and counts what was blocked.
 */
import type { AgentEntry, Block, StormConfig, ToolBlockCode } from "../types.ts";
import { directorEditBlock } from "./director.ts";
import { followUpBlock } from "./followup.ts";
import { directorRead } from "./reads.ts";

export interface DirectorToolCall {
	toolName: string;
	input: unknown;
	cwd: string;
	runId: string;
	/** The approved config the run started under. */
	config: StormConfig;
	/** Every subagent in the process ledger, earlier runs' included. */
	agents: readonly AgentEntry[];
}

/**
 * Checks in order: a file change by the director (`director-edit`), a large read of a file a subagent of the run read
 * (`read-large`), a follow-up to an agent that takes none (`followup-cap`, `followup-cleaned`). Undefined lets the
 * call run.
 */
export function decideToolCall(call: DirectorToolCall): Block<ToolBlockCode> | undefined {
	const edit = directorEditBlock(call.toolName, call.input);
	if (edit) return edit;
	if (call.toolName === "read") {
		const path = typeof call.input === "object" && call.input !== null && "path" in call.input ? call.input.path : undefined;
		return directorRead({ runId: call.runId, path, cwd: call.cwd, isolated: call.config.isolation === "isolated" })?.block;
	}
	return followUpBlock(call.toolName, call.input, call.agents, call.config);
}
