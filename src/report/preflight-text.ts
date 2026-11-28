/** How the preflight report reads in the approval dialog and in `/storm status`. Type-only imports keep views light. */
import type { PreflightItem, PreflightReport } from "./preflight.ts";

/** Said under every list of commands: the user runs them, Storm never does. */
export const PREFLIGHT_HANDS_OFF = "Storm 은 omp 설정을 바꾸지 않습니다. 필요하면 위 명령을 직접 실행하세요.";

/** "시작 전 점검: 통과 N · 막힘 M" (plus notices when there are any). */
export function preflightSummary(report: PreflightReport): string {
	const ok = report.items.filter(item => item.status === "ok").length;
	const notices = report.items.filter(item => item.status === "notice").length;
	return `시작 전 점검: 통과 ${ok} · 막힘 ${report.blocked}${notices > 0 ? ` · 알림 ${notices}` : ""}`;
}

/** One item as Markdown lines: the item, then its command on its own line. */
export function preflightItemLines(item: PreflightItem): string[] {
	const mark = item.status === "blocked" ? "막힘" : item.status === "notice" ? "알림" : "통과";
	return [`- ${mark} · ${item.label}${item.detail ? `: ${item.detail}` : ""}`, ...(item.command ? [`  - \`${item.command}\``] : [])];
}

/** The approval dialog's part: the summary and every blocked item with its command. */
export function preflightApprovalText(report: PreflightReport): string {
	const lines = [`### ${preflightSummary(report)}`];
	for (const item of report.items) if (item.status === "blocked") lines.push(...preflightItemLines(item));
	if (report.blocked > 0) lines.push(`- ${PREFLIGHT_HANDS_OFF}`);
	return lines.join("\n");
}
