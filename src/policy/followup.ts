/**
 * Follow-ups (`write agent://<id>`) from a directing session. An agent whose omp records the run-end janitor removed
 * takes no more: the director starts a fresh agent that reads the old one's result (`agent://<id>`). Context size
 * never refuses a follow-up: omp compacts a subagent session itself. The rule covers every agent of the process
 * ledger, whichever run started it.
 */
import { withJosa } from "../josa.ts";
import { ROLE_AGENT_PREFIX, roleTitle } from "../roles.ts";
import type { AgentEntry, Block } from "../types.ts";
import { pathOf } from "./director.ts";

const AGENT_URL = "agent://";

/** The agent id a `write` call addresses (`agent://<id>`, cut at `?` or `/`), if any. */
export function followUpTarget(toolName: string, input: unknown): string | undefined {
	if (toolName !== "write") return undefined;
	const path = pathOf(input);
	if (path === undefined || !path.startsWith(AGENT_URL)) return undefined;
	const id = path.slice(AGENT_URL.length).split(/[?/]/, 1)[0];
	return id || undefined;
}

/**
 * Which control of an agent a `write` addresses: `agent://<id>/model` or `agent://<id>/effort` (any id, any case, with or
 * without a query or a trailing slash). omp lets an agent switch itself or a direct child through these paths; an
 * ordinary message (`agent://<id>`, `agent://parent`, `?progress`) is not one.
 */
export function agentControlTarget(toolName: string, input: unknown): "model" | "effort" | undefined {
	if (toolName !== "write") return undefined;
	const path = pathOf(input);
	if (path === undefined || !path.startsWith(AGENT_URL)) return undefined;
	const segments = path.slice(AGENT_URL.length).split("?", 1)[0]?.split("/") ?? [];
	const control = segments[1]?.toLowerCase();
	return control === "model" || control === "effort" ? control : undefined;
}

/** The ledger entry a follow-up target names; omp resolves recipient ids ignoring case when no exact one exists. */
export function followUpAgent(agents: readonly AgentEntry[], id: string): AgentEntry | undefined {
	const lower = id.toLowerCase();
	return agents.find(a => a.id === id) ?? agents.find(a => a.id.toLowerCase() === lower);
}

/** The refusal for a `write agent://<id>` to an agent that takes no follow-ups; undefined lets it through. */
export function followUpBlock(
	toolName: string,
	input: unknown,
	agents: readonly AgentEntry[],
): Block<"followup-cleaned"> | undefined {
	const id = followUpTarget(toolName, input);
	const agent = id === undefined ? undefined : followUpAgent(agents, id);
	if (!agent) return undefined;
	if (agent.cleanedAt === undefined) return undefined;
	const who = `${agent.id}(${agent.role === undefined ? agent.name : roleTitle(agent.role)}) 에이전트`;
	const fresh = agent.role === undefined ? agent.name : `${ROLE_AGENT_PREFIX}${agent.role}`;
	const next = `새 \`${fresh}\` 에이전트를 띄워 \`agent://${agent.id}\`의 결과를 읽고 이어 가게 하세요. 요약을 따로 넘길 필요는 없습니다.`;
	return { code: "followup-cleaned", reason: `${withJosa(who, "은/는")} 정리로 omp 기록이 지워져 후속 지시를 받을 수 없습니다. ${next}` };
}

/**
 * A native quiet `?progress` write. It can still wake an idle recipient, but it is not a requested result
 * and is not counted as a follow-up in the report.
 */
export function followUpProgress(toolName: string, input: unknown): boolean {
	if (toolName !== "write") return false;
	const path = pathOf(input);
	return path !== undefined && path.startsWith(AGENT_URL) && /[?&]progress\b/.test(path);
}

/**
 * The agent id a finished `write agent://<id>` reached, for the follow-up count: delivered (or queued for a starting
 * agent) means the tool did not fail. `?progress` notes are not follow-ups.
 */
export function deliveredFollowUp(toolName: string, input: unknown, isError: boolean): string | undefined {
	if (isError) return undefined;
	if (followUpProgress(toolName, input)) return undefined;
	return followUpTarget(toolName, input);
}
