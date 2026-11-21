/**
 * Model check for the configured team, rendered from the recommender's own ranking: where each role's current
 * primary model stands, the candidates ranked above it with the reason, and newer versions of the model.
 * Read-only; switching goes through reselect.
 */
import { teamPriority } from "../config/schema.ts";
import { speedText, time, usd } from "../view/render.ts";
import { scoreText } from "../lineage/metrics.ts";
import { roleTitle } from "../roles.ts";
import { parseModelEntry } from "../selector.ts";
import type { AnalysisContext, Candidate, StormConfig } from "../types.ts";

/** Higher-ranked candidates listed per role. */
const ABOVE_SHOWN = 5;

function candidateText(c: Candidate): string {
	const parts = [`${c.label} (${c.selector})`, `지능 ${scoreText(c.int)}`, speedText(c.speed), `참조 비용 ${usd(c.referenceUsd)}`];
	if (c.quota === "exhausted") parts.push(c.quotaResetsAt === undefined ? "지금 쿼터 소진" : `지금 쿼터 소진, ${time(c.quotaResetsAt)} 재설정`);
	return parts.join(" · ");
}

export function renderModelCheck(ctx: AnalysisContext, config: StormConfig | undefined): string {
	const out: string[] = [];
	if (!config) out.push("팀 설정이 없어 점검할 역할이 없습니다. /storm 으로 먼저 팀을 설정하세요.");
	const primaries: Record<string, string> = {};
	for (const [roleId, role] of Object.entries(config?.roles ?? {})) {
		const entry = role.models[0];
		if (entry !== undefined) primaries[roleId] = parseModelEntry(entry).selector;
	}
	const recs = config ? ctx.recommend(teamPriority(config), primaries) : [];

	for (const [roleId, selector] of Object.entries(primaries)) {
		const rec = recs.find((r) => r.role.id === roleId);
		const current = rec?.current;
		if (!rec || !current) continue;
		out.push(`### ${roleTitle(roleId)} · ${ctx.catalog.find((m) => m.selector === selector)?.name ?? selector} (${selector})`);
		if (current.excluded !== undefined) {
			out.push(`- 지금은 이 역할의 후보가 아닙니다: ${current.excluded}`);
			if (rec.candidates.length) out.push("- 추천 후보", ...rec.candidates.slice(0, ABOVE_SHOWN).map((c) => `  - ${candidateText(c)}`));
		} else if (current.above.length === 0) {
			out.push("- 추천 순위 1위: 지금 조건에서 더 높은 순위의 후보가 없습니다.");
		} else {
			const more = current.above.length > ABOVE_SHOWN ? ` (위에서 ${ABOVE_SHOWN}개만 표시)` : "";
			out.push(`- 추천 순위 ${current.above.length + 1}위. 더 높은 순위 후보 ${current.above.length}개${more}`);
			for (const a of current.above.slice(0, ABOVE_SHOWN)) {
				out.push(`  - ${candidateText(a.candidate)}${a.reason ? ` — 지금 모델: ${a.reason}` : ""}`);
			}
		}
		const usable = current.newer.filter((n) => n.selectors.length > 0);
		if (usable.length) {
			out.push("- 새 버전");
			for (const n of usable) {
				out.push(`  - ${n.label}${n.needsCheck ? " (확인 필요)" : ""} · 지능 ${scoreText(n.int)} · ${n.selectors.join(", ")}`);
			}
		}
		const login = current.newer.filter((n) => n.selectors.length === 0);
		if (login.length) {
			out.push("- 다른 Provider 로그인 후 쓸 수 있는 새 버전");
			for (const n of login) {
				out.push(`  - ${n.label}${n.needsCheck ? " (확인 필요)" : ""} · 지능 ${scoreText(n.int)} · 로그인 필요: ${n.loginProviders.join(", ")}`);
			}
		}
		out.push("");
	}
	out.push("카탈로그에 없는 모델은 요청하면 웹에서 찾아볼 수 있습니다. 출처를 함께 적고 신뢰도는 낮음으로 표시합니다.");
	return out.join("\n");
}
