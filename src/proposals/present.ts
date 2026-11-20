/**
 * Shows a proposal and asks for approval. Only the exact label "승인" approves; a dialog that
 * cannot answer (print mode, --no-ui, form-less ACP) defers instead of applying.
 */
import { int, renderConfigDiff, roleTitle, usd } from "../interview/render.ts";
import type { Proposal, StormConfig, UiPort } from "../types.ts";

export const APPROVE = "승인";
const LATER = "나중에";
const CANCEL = "취소";
/** Candidates shown per changed role; the rest stay in the stored evidence. */
const EVIDENCE_SHOWN = 3;

export function renderProposal(proposal: Proposal, current: StormConfig): string {
	const out = [`**${proposal.summary}**`, "", "### 변경", renderConfigDiff(current, proposal.config)];
	const ev = proposal.evidence;
	if (ev) {
		const changed = Object.keys(ev.roles).filter(
			(id) => current.roles[id]?.models.join("\n") !== proposal.config.roles[id]?.models.join("\n"),
		);
		if (changed.length) out.push("", "### 근거");
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

export async function presentProposal(
	ui: UiPort,
	proposal: Proposal,
	current: StormConfig,
): Promise<"approved" | "deferred" | "cancelled"> {
	ui.report("Storm 변경 제안", renderProposal(proposal, current));
	const answer = await ui.select("이 변경을 승인할까요?", [APPROVE, LATER, CANCEL]);
	if (answer === APPROVE) return "approved";
	if (answer === CANCEL) return "cancelled";
	return "deferred";
}
