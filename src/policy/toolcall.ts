/**
 * The one decision about a tool call of a session that directs a Storm run: a file change by the director. Pure; the
 * extension gathers the inputs, commits what the decision names to the run's write table and counts what was blocked.
 */
import type { Block, ToolBlockCode } from "../types.ts";
import { directorEditDecision } from "./director.ts";
import type { TargetEnv } from "./director-targets.ts";

/** A director tool call with what the targets of a path edit are judged against. */
export interface DirectorPathCall {
	toolName: string;
	input: unknown;
	/** The director session's working directory. */
	cwd: string;
	/** The run's work tree: every target must resolve inside it. */
	root: string;
	/** The id of the tool call that dispatched this one, when another tool did. */
	parentToolCallId?: string;
	/** omp's resolved edit mode for the call, when the caller knows it; every grammar is read otherwise. */
	editMode?: string;
	realpath?: TargetEnv["realpath"];
}

/**
 * What the extension does with a director tool call during a run: let it run (`allow`: not a file change), refuse it
 * with a cause (`block`), or commit `paths` to the run's write table as a `director-path` holder and let it run if the
 * table takes them (`director-path`). The paths are exactly the files the call writes, root-relative.
 *
 * A large read of a file a subagent read is the director's context size, which Storm protects by compacting, and a
 * follow-up to an agent whose records were cleaned is answered by omp itself and explained by `followUpFailureNote` after
 * the failure: neither is decided here.
 */
export type DirectorCallDecision =
	| { kind: "allow" }
	| { kind: "block"; block: Block<ToolBlockCode> }
	| { kind: "director-path"; paths: string[] };

export function decideDirectorCall(call: DirectorPathCall): DirectorCallDecision {
	const decision = directorEditDecision(call.toolName, call.input, {
		root: call.root,
		cwd: call.cwd,
		...(call.editMode === undefined ? {} : { editMode: call.editMode }),
		...(call.parentToolCallId === undefined ? {} : { parentToolCallId: call.parentToolCallId }),
		...(call.realpath === undefined ? {} : { realpath: call.realpath }),
	});
	if (decision.kind === "refuse") return { kind: "block", block: decision.block };
	return decision.kind === "path" ? { kind: "director-path", paths: decision.paths } : { kind: "allow" };
}
