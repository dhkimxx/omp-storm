/**
 * The subagent table of status and the storm tool: each agent's state, context against its follow-up cap, and whether
 * a follow-up would pass. The cap rule here is the one Storm enforces (`src/policy/followup.ts` reads these rows).
 */
import { followUpCap, roleTitle } from "../roles.ts";
import type { AgentEntry, AgentLiveState, InfoLine, InfoSpan, StormConfig } from "../types.ts";

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

const NO_AGENTS = "- 이 세션에서 아직 실행된 서브에이전트가 없습니다.";

/** A compact markdown table, one row per agent. */
export function renderAgentRows(rows: readonly AgentRow[], now: number): string {
	if (!rows.length) return NO_AGENTS;
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

/** Stacked rows for the interactive status report; long IDs and model names wrap independently. */
export function agentStatusSpans({ entry, cap, followUp }: AgentRow, now: number): readonly (readonly InfoSpan[])[] {
	const role = entry.role === undefined ? entry.name : roleTitle(entry.role);
	const state = entry.state === "running" ? STATE_LABEL[entry.state]
		: entry.state === "idle" ? `유휴 ${duration(now - entry.lastActivityAt)}`
		: `보관 · 유휴 ${duration(now - entry.lastActivityAt)}`;
	return [
		[
			{ text: `- ${entry.id}`, tone: "accent" },
			{ text: ` · ${role} · ${state}`, tone: entry.state === "running" ? "success" : "muted" },
		],
		[{ text: `  ${entry.model ?? "—"} · 컨텍스트 ${tokens(entry.contextTokens)}/${tokens(cap)}`, tone: "muted" }],
		[{ text: `  후속 지시 ${entry.followUps}회 · ${FOLLOW_UP_LABEL[followUp]}`, tone: followUp === "cap" ? "warning" : "muted" }],
	];
}

/** Control characters, bidi marks and line separators: the same class `visible()` in `view/render.ts` escapes. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

function oneLine(text: string): string {
	return text.replace(UNSAFE, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** What the agent left behind beyond its status: changed files, review verdicts, a failed last turn. Empty when nothing. */
function agentEvidenceSpans(entry: AgentEntry): readonly InfoSpan[] {
	const parts: InfoSpan[][] = [];
	if ((entry.changes ?? 0) > 0) parts.push([{ text: `파일 변경 ${entry.changes}건`, tone: "muted" }]);
	const review = entry.review;
	if (review !== undefined && review.reviews > 0) {
		parts.push([
			{ text: `리뷰 ${review.reviews}회: 통과 ${review.passed}`, tone: "muted" },
			{ text: ` · 수정 필요 ${review.failed}`, tone: review.failed > 0 ? "warning" : "muted" },
		]);
	}
	if (entry.lastWorkFailed === true) parts.push([{ text: "마지막 작업 실패", tone: "warning" }]);
	if (!parts.length) return [];
	return [{ text: "  " }, ...parts.flatMap((part, i): InfoSpan[] => (i > 0 ? [{ text: " · ", tone: "muted" }, ...part] : part))];
}

/**
 * The human report of `/storm agents`: each agent as the status view's stacked rows (identity and state, model and
 * context, follow-ups) plus one evidence row when there is any, so a 60-column terminal never wraps a wide table.
 * Every line is built from its spans and annotated in `info`; the Markdown alone is the plain fallback.
 * The model-facing table stays {@link renderAgentRows}.
 */
export function renderAgentReport(rows: readonly AgentRow[], now: number, info: InfoLine[]): string {
	const out: string[] = [];
	const styled = (spans: readonly InfoSpan[]): void => {
		const safe = spans.map(span => (span.tone ? { text: oneLine(span.text), tone: span.tone } : { text: oneLine(span.text) }));
		info.push({ index: out.length, spans: safe });
		out.push(safe.map(span => span.text).join(""));
	};
	if (!rows.length) {
		styled([{ text: NO_AGENTS, tone: "muted" }]);
		return out.join("\n");
	}
	for (const row of rows) {
		for (const spans of agentStatusSpans(row, now)) styled(spans);
		const evidence = agentEvidenceSpans(row.entry);
		if (evidence.length) styled(evidence);
	}
	return out.join("\n");
}
