/**
 * Shows a proposal and asks for approval. Only the exact label "승인" approves; a dialog that
 * cannot answer (print mode, --no-ui, form-less ACP) defers instead of applying. A setup proposal
 * has nothing to defer to: it is approved or dropped.
 */
import { int, renderConfigDiff, renderShadows, roleTitle, usd } from "../interview/render.ts";
import type { Proposal, ShadowInfo, StormConfig, UiPort } from "../types.ts";

export const APPROVE = "승인";
const LATER = "나중에";
const CANCEL = "취소";
/** Candidates shown per changed role; the rest stay in the stored evidence. */
const EVIDENCE_SHOWN = 3;

/** Summary, diff against `current` (the whole team when there is none) and the evidence of changed roles. */
export function renderProposal(proposal: Proposal, current: StormConfig | undefined): string {
	const out = [`**${proposal.summary}**`, "", current ? "### 변경" : "### 팀 구성", renderConfigDiff(current, proposal.config)];
	const ev = proposal.evidence;
	if (ev) {
		const changed = Object.keys(ev.roles).filter(
			(id) => current?.roles[id]?.models.join("\n") !== proposal.config.roles[id]?.models.join("\n"),
		);
		if (changed.length || ev.rationale) out.push("", "### 근거");
		if (ev.rationale) out.push(ev.rationale);
		for (const id of changed) {
			const r = ev.roles[id]!;
			out.push(`- ${roleTitle(id)}: 선택 ${r.chosen ?? "—"}`);
			for (const c of r.candidates.slice(0, EVIDENCE_SHOWN)) {
				out.push(`  - ${c.label} (${c.selector}) · 지능 ${int(c.int)} · ${int(c.speed)} tok/s · ${usd(c.referenceUsd)}`);
				for (const w of c.why) out.push(`    - 근거: ${w}`);
				for (const w of c.whyNot) out.push(`    - 제외 이유: ${w}`);
			}
		}
	}
	return out.join("\n");
}

/** Shadowing definitions are part of what "승인" approves, so they share the dialog's context. */
export async function presentProposal(
	ui: UiPort,
	proposal: Proposal,
	current: StormConfig | undefined,
	extra: { shadows?: ShadowInfo[]; warnings?: string[]; context?: string } = {},
): Promise<"approved" | "deferred" | "cancelled"> {
	// A setup has nothing to defer to; a run plan waits on the answer now.
	const final = proposal.kind === "setup" || proposal.kind === "plan";
	let markdown = renderProposal(proposal, current);
	if (extra.context) markdown = `${extra.context}\n\n${markdown}`;
	if (extra.warnings?.length) markdown += `\n\n### 경고\n${extra.warnings.map((w) => `- ${w}`).join("\n")}`;
	markdown += renderShadows(extra.shadows ?? []);
	const title = proposal.kind === "setup" ? "Storm 팀 제안" : proposal.kind === "plan" ? "Storm 실행 계획" : "Storm 변경 제안";
	const answer = await ui.select("이 변경을 승인할까요?", final ? [APPROVE, CANCEL] : [APPROVE, LATER, CANCEL], { title, markdown });
	if (answer === APPROVE) return "approved";
	if (final || answer === CANCEL) return "cancelled";
	return "deferred";
}
