/**
 * Follow-ups (`write agent://<id>`) from a directing session. An agent at or past its context cap, or one whose omp
 * records the run-end janitor removed, takes no more: the director starts a fresh agent that reads the old one's
 * result (`agent://<id>`). The rule covers every agent of the process ledger, whichever run started it.
 */
import { agentRows, tokens } from "../report/agents.ts";
import { ROLE_AGENT_PREFIX, roleTitle } from "../roles.ts";
import type { AgentEntry, Block, StormConfig } from "../types.ts";
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
	config: StormConfig,
): Block<"followup-cap" | "followup-cleaned"> | undefined {
	const id = followUpTarget(toolName, input);
	const agent = id === undefined ? undefined : followUpAgent(agents, id);
	if (!agent) return undefined;
	const [row] = agentRows([agent], config);
	if (!row || row.followUp === "ok") return undefined;
	const who = `${agent.id}(${agent.role === undefined ? agent.name : roleTitle(agent.role)})`;
	const fresh = agent.role === undefined ? agent.name : `${ROLE_AGENT_PREFIX}${agent.role}`;
	const next = `새 ${fresh} 를 띄워 agent://${agent.id} 의 결과를 읽고 이어 가게 하세요. 요약을 따로 넘길 필요는 없습니다.`;
	if (row.followUp === "cleaned") {
		return { code: "followup-cleaned", reason: `${who}는 정리로 omp 기록이 지워져 후속 지시를 받을 수 없습니다. ${next}` };
	}
	return {
		code: "followup-cap",
		reason: `${who}의 컨텍스트가 ${tokens(agent.contextTokens)} 토큰으로 상한 ${tokens(row.cap)} 토큰에 닿아 후속 지시를 막았습니다. ${next}`,
	};
}

/**
 * The agent id a finished `write agent://<id>` reached, for the follow-up count: delivered (or queued for a starting
 * agent) means the tool did not fail. `?progress` notes are not follow-ups.
 */
export function deliveredFollowUp(toolName: string, input: unknown, isError: boolean): string | undefined {
	if (isError) return undefined;
	const path = pathOf(input);
	if (path !== undefined && /[?&]progress\b/.test(path)) return undefined;
	return followUpTarget(toolName, input);
}
