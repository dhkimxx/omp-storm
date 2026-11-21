/**
 * The approval dialog: everything the config hash covers, then exactly "승인" or "취소" (plus options the caller adds).
 * Only the exact label "승인" approves; a host that cannot answer (print mode, --no-ui, form-less ACP) gets a cancel.
 */
import { renderConfigDiff, shadowLines, visible } from "../view/render.ts";
import type { Proposal, ShadowInfo, StormConfig, UiPort } from "../types.ts";

export const APPROVE = "승인";
export const CANCEL = "취소";

export interface ApprovalView {
	/** Shadowing definitions: part of what "승인" approves. */
	shadows?: readonly ShadowInfo[];
	/** Validation warnings and model availability warnings of the config being approved. */
	warnings?: readonly string[];
	/** Shown first (a run plan, what a setup switches on). */
	context?: string;
	/** Background shown after the diff (why these models): the first thing a small terminal cuts. */
	notes?: string;
}

/**
 * What "승인" covers, most consequential first, because a small terminal cuts the panel from the end: the caller's
 * context, the shadowing definitions (files that replace an agent's prompt and tools), the warnings, then the summary
 * with the diff against `current` (the whole team when there is none), then background notes.
 */
export function renderApproval(summary: string | undefined, current: StormConfig | undefined, next: StormConfig, view: ApprovalView = {}): string {
	const out: string[] = [];
	if (view.context) out.push(view.context, "");
	const shadows = shadowLines(view.shadows ?? []);
	if (shadows.length) out.push(...shadows, "");
	// Warnings quote the config (unknown field names, model ids), so they are shown as single lines too.
	if (view.warnings?.length) out.push("### 경고", ...view.warnings.map((w) => `- ${visible(w)}`), "");
	if (summary) out.push(`**${summary}**`, "");
	out.push(current ? "### 변경" : "### 팀 설정", renderConfigDiff(current, next));
	if (view.notes) out.push("", view.notes);
	return out.join("\n");
}

const TITLE: Partial<Record<Proposal["kind"], string>> = { setup: "Storm 팀 제안", plan: "Storm 실행 계획" };

/** Asks about one proposal. `extraOptions` are offered between "승인" and "취소" and come back as `{ extra }`. */
export async function presentProposal(
	ui: UiPort,
	proposal: Proposal,
	current: StormConfig | undefined,
	opts: ApprovalView & { extraOptions?: readonly string[] } = {},
): Promise<"approved" | "cancelled" | { extra: string }> {
	const extras = opts.extraOptions ?? [];
	const answer = await ui.select("이 변경을 승인할까요?", [APPROVE, ...extras, CANCEL], {
		title: TITLE[proposal.kind] ?? "Storm 변경 제안",
		consent: [APPROVE],
		markdown: renderApproval(proposal.summary, current, proposal.config, opts),
	});
	if (answer === APPROVE) return "approved";
	return answer !== undefined && extras.includes(answer) ? { extra: answer } : "cancelled";
}
