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
import type { AnalysisContext, Candidate, InfoLine, InfoSpan, StormConfig } from "../types.ts";

/** Higher-ranked candidates listed per role. */
const ABOVE_SHOWN = 5;

/** A candidate's name and facts; the name leads in accent when it is the one to compare against first. */
function candidateSpans(c: Candidate, lead: boolean): InfoSpan[] {
	const spans: InfoSpan[] = [
		lead ? { text: `${c.label} (${c.selector})`, tone: "accent" } : { text: `${c.label} (${c.selector})` },
		{ text: ` · 지능 ${scoreText(c.int)} · ${speedText(c.speed)} · 참조 비용 ${usd(c.referenceUsd)}`, tone: "muted" },
	];
	if (c.quota === "exhausted") {
		spans.push({ text: ` · ${c.quotaResetsAt === undefined ? "지금 쿼터 소진" : `지금 쿼터 소진, ${time(c.quotaResetsAt)} 재설정`}`, tone: "warning" });
	}
	return spans;
}

const text = (spans: readonly InfoSpan[]): string => spans.map((span) => span.text).join("");

/**
 * Plain Markdown is the report and the fallback on every host; passing `info` adds the semantic annotations a rich
 * frame draws instead of those lines (role heading toned by standing, the standing line, the first candidate to
 * compare against) without changing a character of the Markdown.
 */
export function renderModelCheck(ctx: AnalysisContext, config: StormConfig | undefined, info?: InfoLine[]): string {
	const out: string[] = [];
	/** One line whose Markdown is `prefix` + its spans, so the plain text and the annotation cannot drift apart. */
	const styled = (spans: readonly InfoSpan[], extra: Pick<InfoLine, "icon" | "emphasis"> = {}, prefix = ""): void => {
		info?.push({ index: out.length, spans, ...extra });
		out.push(`${prefix}${text(spans)}`);
	};
	if (!config) styled([{ text: "팀 설정이 없어 점검할 역할이 없습니다. /storm 으로 먼저 팀을 설정하세요.", tone: "warning" }], { icon: "status.warning" });
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
		// The heading's model name carries the role's standing: top-ranked, outranked, or no longer a candidate.
		const standing = current.excluded !== undefined ? "error" : current.above.length === 0 ? "success" : "warning";
		const icon = standing === "error" ? "status.error" : standing === "success" ? "status.success" : "status.warning";
		styled(
			[
				{ text: `${roleTitle(roleId)} · ` },
				{ text: ctx.catalog.find((m) => m.selector === selector)?.name ?? selector, tone: standing },
				{ text: ` (${selector})`, tone: "muted" },
			],
			{ icon, emphasis: "title" },
			"### ",
		);
		if (current.excluded !== undefined) {
			styled([{ text: "- 지금은 이 역할의 후보가 아닙니다", tone: "error" }, { text: `: ${current.excluded}` }], { icon });
			if (rec.candidates.length) {
				out.push("- 추천 후보");
				for (const [i, c] of rec.candidates.slice(0, ABOVE_SHOWN).entries()) {
					const spans = [{ text: "  - " }, ...candidateSpans(c, i === 0)];
					if (i === 0) styled(spans);
					else out.push(text(spans));
				}
			}
		} else if (current.above.length === 0) {
			styled([{ text: "- 추천 순위 1위", tone: "success" }, { text: ": 지금 조건에서 더 높은 순위의 후보가 없습니다.", tone: "muted" }], { icon });
		} else {
			const more = current.above.length > ABOVE_SHOWN ? ` (위에서 ${ABOVE_SHOWN}개만 표시)` : "";
			styled([{ text: `- 추천 순위 ${current.above.length + 1}위`, tone: "warning" }, { text: `. 더 높은 순위 후보 ${current.above.length}개${more}` }], { icon });
			for (const [i, a] of current.above.slice(0, ABOVE_SHOWN).entries()) {
				const spans = [{ text: "  - " }, ...candidateSpans(a.candidate, i === 0), ...(a.reason ? [{ text: ` — 지금 모델: ${a.reason}` }] : [])];
				// Only the top comparison is annotated; the rest stay plain Markdown to keep the frame quiet.
				if (i === 0) styled(spans);
				else out.push(text(spans));
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
	styled([{ text: "카탈로그에 없는 모델은 요청하면 웹에서 찾아볼 수 있습니다. 출처를 함께 적고 신뢰도는 낮음으로 표시합니다.", tone: "muted" }]);
	return out.join("\n");
}
