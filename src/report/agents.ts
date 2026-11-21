/**
 * The subagent table of status and the storm tool: each agent's state, context against its follow-up cap, and whether
 * a follow-up would pass. The cap rule here is the one Storm enforces (`src/policy/followup.ts` reads these rows).
 */
import { followUpCap, roleTitle } from "../roles.ts";
import type { AgentEntry, AgentLiveState, StormConfig } from "../types.ts";

const MIN = 60_000;
const HOUR = 3_600_000;

export interface AgentRow {
	entry: AgentEntry;
	/** Context tokens from which the agent takes no follow-ups. */
	cap: number;
	/** ok: a follow-up passes · cap: at or past its cap · cleaned: its omp records were removed. */
	followUp: "ok" | "cap" | "cleaned";
}

/** Each entry with its cap and follow-up state, in the same order. */
export function agentRows(entries: readonly AgentEntry[], config: StormConfig | undefined): AgentRow[] {
	return entries.map(entry => {
		const cap = followUpCap(config, entry.role);
		return { entry, cap, followUp: entry.cleanedAt !== undefined ? "cleaned" : entry.contextTokens >= cap ? "cap" : "ok" };
	});
}

export function tokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export function duration(ms: number): string {
	if (ms < MIN) return `${Math.max(0, Math.round(ms / 1000))}초`;
	if (ms < HOUR) return `${Math.round(ms / MIN)}분`;
	const h = ms / HOUR;
	return `${Number.isInteger(h) ? h : h.toFixed(1)}시간`;
}

const STATE_LABEL: Record<AgentLiveState, string> = { running: "실행 중", idle: "유휴", parked: "보관" };
const FOLLOW_UP_LABEL: Record<AgentRow["followUp"], string> = { ok: "가능", cap: "상한 도달", cleaned: "정리됨" };

function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** A compact markdown table, one row per agent. */
export function renderAgentRows(rows: readonly AgentRow[], now: number): string {
	if (!rows.length) return "- 이 세션에서 아직 실행된 서브에이전트가 없습니다.";
	const out = ["| 서브에이전트 | 역할 | 모델 | 상태 | 유휴 | 컨텍스트/상한 | 후속 지시 | 후속 가능 |", "|---|---|---|---|---|---|---|---|"];
	for (const { entry: e, cap, followUp } of rows) {
		const idle = e.state === "running" ? "—" : duration(now - e.lastActivityAt);
		const role = e.role === undefined ? e.name : roleTitle(e.role);
		out.push(
			`| ${cell(e.id)} | ${cell(role)} | ${cell(e.model ?? "—")} | ${STATE_LABEL[e.state]} | ${idle} | ${tokens(e.contextTokens)}/${tokens(cap)} | ${e.followUps} | ${FOLLOW_UP_LABEL[followUp]} |`,
		);
	}
	return out.join("\n");
}
