import type { InfoSpan } from "../types.ts";

/** One narrow, still-readable wind mark, shared by the status line and Storm panels. */
export const STORM_MARK = "≋ STORM";

/** View-only evidence from the live controller. These phases are never persisted or used to decide a run. */
export type RunPhase = "working" | "workers" | "verifying" | "waiting-user" | "between-rounds" | "stopping";

type Tone = NonNullable<InfoSpan["tone"]>;

export const RUN_APPEARANCE = {
	working: { label: "진행 중", tone: "accent", motion: true },
	workers: { label: "워커 작업 중", tone: "accent", motion: true },
	verifying: { label: "검증 중", tone: "accent", motion: true },
	"waiting-user": { label: "응답 대기", tone: "warning", motion: false },
	"between-rounds": { label: "다음 라운드 대기", tone: "muted", motion: false },
	stopping: { label: "종료 정리 중", tone: "muted", motion: false },
} as const satisfies Record<RunPhase, { label: string; tone: Tone; motion: boolean }>;

/** The footer and the panels describe the same idle team without claiming the last run passed. */
export function idleAppearance(input: {
	team: "missing" | "invalid" | "unapproved" | "approved";
	auto: "on" | "off" | "blocked";
	resume: boolean;
}): { label: string; tone: Tone; action?: string } {
	if (input.team === "invalid") return { label: "설정 오류", tone: "error", action: "`/storm`에서 오류 보기" };
	if (input.team === "missing") return { label: "설정 없음", tone: "muted", action: "`/storm`에서 팀 설정" };
	if (input.team === "unapproved") return { label: "승인 필요", tone: "warning", action: "`/storm`에서 팀 승인" };
	if (input.auto === "blocked") return { label: "자동 위임 막힘", tone: "warning", action: "`/storm status`에서 이유 확인" };
	if (input.resume) return { label: "이어가기 가능", tone: "warning", action: "`/storm`에서 이어가기" };
	return { label: "대기", tone: "muted" };
}
