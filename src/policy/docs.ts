/**
 * Storm's doc-code consistency rules for the project a Storm run works on (team setting `docs`, default on).
 * Code and observed behavior are the facts; docs hold decisions, rationale, usage and results and point to code
 * instead of copying its state. Each role gets only what it can act on, as a system-prompt section: writers the
 * writing rules, the reviewer the review variant, read-only roles one line. The director's line is in the handoff.
 */
import type { RoleId, StormConfig } from "../types.ts";

/** Whether the team keeps the doc rules and the reviewer's doc check: absent means on. */
export function docsEnabled(config: Pick<StormConfig, "docs">): boolean {
	return config.docs !== false;
}

const HEADING = "## Storm doc rules";
const FACTS =
	"Code and observed behavior (tests, runs) are the facts. Docs hold decisions, rationale, usage and results, and point to code locations (`path:line`, symbol names) instead of copying code state: constants, file or function lists, fields, step sequences, progress status.";

const WRITER = [
	HEADING,
	`- ${FACTS}`,
	"- When you change code, fix the docs that mention it in the same lane.",
	"- When a doc and the code disagree, check the facts and fix the wrong side: a wrong doc gets fixed; code that contradicts a current decision gets fixed, or returned to the director when the fix is outside your assignment.",
	"- Progress lives in the Storm run record and `local://` notes, never in repo docs.",
].join("\n");

const REVIEWER = [
	HEADING,
	`- ${FACTS}`,
	"- Also review the docs: report docs that contradict the reviewed change as findings with `kind: \"doc_conflict\"`, and doc passages that copy code state as findings with `kind: \"doc_copy\"`. Give code findings `kind: \"code\"`. Cite the doc's `file_path` and lines like any finding.",
].join("\n");

const READ_ONLY = [
	HEADING,
	"- Code and observed behavior are the facts: when a doc and the code disagree, report which side is wrong with both locations.",
].join("\n");

const SECTIONS: Record<RoleId, string> = {
	implementer: WRITER,
	quick: WRITER,
	reviewer: REVIEWER,
	explorer: READ_ONLY,
	architect: READ_ONLY,
};

/**
 * The system-prompt section a Storm role agent gets when docs are on; `undefined` when they are off or `role` is no
 * Storm role. `role` is a Storm role id (`reviewer`) or its agent name (`storm-reviewer`).
 */
export function docPromptFor(role: string | undefined, config: Pick<StormConfig, "docs">): string | undefined {
	if (role === undefined || !docsEnabled(config)) return undefined;
	const id = role.replace(/^storm-/, "");
	return Object.hasOwn(SECTIONS, id) ? SECTIONS[id as RoleId] : undefined;
}
