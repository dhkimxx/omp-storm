/** Follow-ups to subagents past their context ceiling: the director starts a fresh agent with a summary instead. */
import { tokens } from "../report/agents.ts";
import { contextCapFor } from "../roles.ts";
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

/** The reason to refuse a `write agent://<id>` to an agent at or past its context cap; undefined lets it through. */
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
	const cap = contextCapFor(config, agent.role, agent.contextWindow);
	if (agent.contextTokens < cap) return undefined;
	const window = agent.contextWindow ? `(창의 ${Math.round((agent.contextTokens / agent.contextWindow) * 100)}%)` : "";
	const fresh = agent.role === undefined ? agent.name : `storm-${agent.role}`;
	return `${id}(${agent.role ?? agent.name})의 컨텍스트가 ${tokens(agent.contextTokens)} 토큰${window}으로 상한 ${tokens(cap)} 토큰에 닿아 후속 지시를 막았습니다. 이 에이전트에 더 보내지 말고, 결과를 요약해 새 ${fresh} 에 넘겨 시작하세요. 이전 결과는 agent://${id} 에서 계속 읽을 수 있습니다.`;
}
