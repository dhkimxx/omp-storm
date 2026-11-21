/**
 * Follow-ups to subagents that cannot take more: past their context ceiling, or with their omp records removed by the
 * run-end janitor. The director starts a fresh agent that reads the old one's result (`agent://<id>`) and continues.
 */
import { tokens } from "../report/agents.ts";
import { contextCapFor, ROLE_AGENT_PREFIX } from "../roles.ts";
import type { AgentEntry, StormConfig } from "../types.ts";

const AGENT_URL = "agent://";

/** The agent id a `write` path addresses (`agent://<id>`, cut at `?` or `/`), if any. */
function targetId(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null || !("path" in input)) return undefined;
	const path = input.path;
	if (typeof path !== "string" || !path.startsWith(AGENT_URL)) return undefined;
	const id = path.slice(AGENT_URL.length).split(/[?/]/, 1)[0];
	return id || undefined;
}

/**
 * The reason to refuse a `write agent://<id>` to an agent at or past its context cap, or one whose omp records were
 * cleaned; undefined lets it through. `agents`: every agent of the ledger, so cleaned ones of earlier runs are known.
 */
export function followUpBlock(
	toolName: string,
	input: unknown,
	agents: readonly AgentEntry[],
	config: StormConfig,
): string | undefined {
	if (toolName !== "write") return undefined;
	const id = targetId(input);
	if (id === undefined) return undefined;
	const agent = agents.find(a => a.id === id);
	if (!agent) return undefined;
	const fresh = agent.role === undefined ? agent.name : `${ROLE_AGENT_PREFIX}${agent.role}`;
	const handoff = `이 에이전트에 더 보내지 말고, 새 ${fresh} 를 띄워 "agent://${id} 의 결과를 읽고 이어서 진행하라"는 지시를 주세요. 결과를 따로 요약해 넘길 필요는 없습니다.`;
	if (agent.cleanedAt !== undefined) {
		return `${id}(${agent.role ?? agent.name})는 실행 정리로 omp 기록이 지워져 후속 지시를 받을 수 없어 막았습니다. ${handoff}`;
	}
	const cap = contextCapFor(config, agent.role, agent.contextWindow);
	if (agent.contextTokens < cap) return undefined;
	const window = agent.contextWindow ? `(창의 ${Math.round((agent.contextTokens / agent.contextWindow) * 100)}%)` : "";
	return `${id}(${agent.role ?? agent.name})의 컨텍스트가 ${tokens(agent.contextTokens)} 토큰${window}으로 상한 ${tokens(cap)} 토큰에 닿아 후속 지시를 막았습니다. ${handoff}`;
}
