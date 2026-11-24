/**
 * The approval dialog: everything the config hash covers, then exactly "승인" or "취소" (plus options the caller adds).
 * Only the exact label "승인" approves; a host that cannot answer (print mode, --no-ui, form-less ACP) gets a cancel.
 */
import { STORM_MARK } from "../view/appearance.ts";
import { renderConfigDiff, shadowLines, visible } from "../view/render.ts";
import type { InfoLine, InfoSpan, Proposal, ShadowInfo, StormConfig, UiPort } from "../types.ts";

export const APPROVE = "승인";
export const CANCEL = "취소";

export interface ApprovalView {
	/** Shadowing definitions: part of what "승인" approves. */
	shadows?: readonly ShadowInfo[];
	/** Validation warnings and model availability warnings of the config being approved. */
	warnings?: readonly string[];
	/** Shown first: what a setup switches on, or the target a change applies to. */
	context?: string;
	/** Background shown after the diff (why these models): the first thing a small terminal cuts. */
	notes?: string;
	/** `notes` line offsets, relative to `notes`; shifted onto the approval panel. */
	notesInfo?: readonly InfoLine[];
}

/**
 * What "승인" covers, most consequential first, because a small terminal cuts the panel from the end: the caller's
 * context, the shadowing definitions (files that replace an agent's prompt and tools), the warnings, then the mark
 * heading naming the summary with the diff against `current` (the whole team when there is none), then background
 * notes. The mark cannot precede the disclosures or warnings.
 *
 * `info` collects one semantic replacement per Markdown logical line the caller can style; its indexes are into
 * `markdown.split("\n")`. The Markdown itself is identical whether or not a collector is given.
 */
export function renderApproval(
	summary: string | undefined,
	current: StormConfig | undefined,
	next: StormConfig,
	view: ApprovalView = {},
	info?: InfoLine[],
): string {
	const out: string[] = [];
	/** Index of the next logical Markdown line; chunks may contain newlines. */
	let line = 0;
	const push = (chunk: string): void => {
		out.push(chunk);
		line += chunk.split("\n").length;
	};
	const annotate = (spans: readonly InfoSpan[]): void => {
		info?.push({ index: line, spans });
	};
	if (view.context) {
		push(view.context);
		push("");
	}
	const shadows = shadowLines(view.shadows ?? []);
	if (shadows.length) {
		shadows.forEach((text, at) => {
			// The section heading names what approval covers; each definition is a warning row.
			annotate([{ text: at === 0 ? text.replace(/^#{1,6} /, "") : text, tone: "warning" }]);
			push(text);
		});
		push("");
	}
	// Warnings quote the config (unknown field names, model ids), so they are shown as single lines too.
	if (view.warnings?.length) {
		annotate([{ text: "경고", tone: "warning" }]);
		push("### 경고");
		for (const warning of view.warnings) {
			const text = `- ${visible(warning)}`;
			annotate([{ text, tone: "warning" }]);
			push(text);
		}
		push("");
	}
	// The mark is the heading of what is being approved, so it follows every disclosure and warning above and adds
	// no row of its own: a small terminal cuts from the end, never from these disclosures.
	const title = summary ? `${STORM_MARK} · ${summary}` : STORM_MARK;
	annotate([{ text: title, tone: "accent" }]);
	push(`### ${title}`);
	push("");
	const diffInfo: InfoLine[] = [];
	const diff = renderConfigDiff(current, next, info ? diffInfo : undefined);
	annotate([{ text: current ? "변경" : "팀 설정", tone: "accent" }]);
	push(current ? "### 변경" : "### 팀 설정");
	const diffLine = line;
	push(diff);
	for (const item of diffInfo) info?.push({ ...item, index: diffLine + item.index });
	if (view.notes) {
		push("");
		const notesLine = line;
		push(view.notes);
		for (const item of view.notesInfo ?? []) info?.push({ ...item, index: notesLine + item.index });
	}
	return out.join("\n");
}

/** Asks about one proposal. `extraOptions` are offered between "승인" and "취소" and come back as `{ extra }`. */
export async function presentProposal(
	ui: UiPort,
	proposal: Proposal,
	current: StormConfig | undefined,
	opts: ApprovalView & { extraOptions?: readonly string[] } = {},
): Promise<"approved" | "cancelled" | { extra: string }> {
	const extras = opts.extraOptions ?? [];
	const info: InfoLine[] = [];
	const markdown = renderApproval(proposal.summary, current, proposal.config, opts, info);
	const title = proposal.kind === "setup" ? "Storm 팀 제안" : "Storm 변경 제안";
	const answer = await ui.select("이 변경을 승인할까요?", [APPROVE, ...extras, CANCEL], {
		title,
		consent: [APPROVE],
		markdown,
		...(info.length ? { info } : {}),
	});
	if (answer === APPROVE) return "approved";
	return answer !== undefined && extras.includes(answer) ? { extra: answer } : "cancelled";
}
