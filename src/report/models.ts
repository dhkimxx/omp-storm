/**
 * Model check for the configured team: newer revisions, better/cheaper/faster alternatives, and
 * upgrades that need a login to another provider. Read-only; switching goes through reselect.
 */
import { int, roleTitle } from "../interview/render.ts";
import { compareRevision } from "../lineage/key.ts";
import { parseModelEntry } from "../selector.ts";
import type { AnalysisContext, Alternative, StormConfig } from "../types.ts";

const KIND: Record<Alternative["kind"], string> = {
	better: "더 좋음",
	cheaper: "더 쌈",
	faster: "더 빠름",
	validated: "사용 검증",
	upgrade: "상위 계층",
};

export function renderModelCheck(ctx: AnalysisContext, config: StormConfig | undefined): string {
	const out: string[] = [];
	if (!config) out.push("Storm 설정이 없어 점검할 역할이 없습니다. /storm 으로 먼저 팀을 설정하세요.");
	const availableSel = new Set(ctx.available.map((m) => m.selector));

	for (const [roleId, role] of Object.entries(config?.roles ?? {})) {
		const entry = role.models[0];
		if (entry === undefined) continue;
		const sel = parseModelEntry(entry).selector;
		const model = ctx.catalog.find((m) => m.selector === sel);
		const slash = sel.indexOf("/");
		const lin = model
			? ctx.lineage(model.provider, model.id, model.identity)
			: ctx.lineage(sel.slice(0, slash), sel.slice(slash + 1), undefined);
		out.push(`### ${roleTitle(roleId)} · ${model?.name ?? sel} (${sel})`);
		let found = false;

		// Newer revisions on the same line: the analysis covers lineages with usage; the catalog covers the rest.
		const newer = ctx.analysis.newer
			.filter((n) => n.from === lin.modelKey)
			.map((n) => `${n.to}${n.needsCheck ? " (확인 필요)" : ""} · 지능 ${int(n.int.value)} · ${n.selectors.join(", ") || "—"}`);
		const listed = new Set(ctx.analysis.newer.filter((n) => n.from === lin.modelKey).map((n) => n.to));
		const login = new Map<string, { label: string; int: number | null; providers: Set<string> }>();
		if (lin.revision !== null) {
			const avail = new Map<string, { int: number | null; selectors: string[] }>();
			for (const m of ctx.catalog) {
				const l = ctx.lineage(m.provider, m.id, m.identity);
				if (l.lineKey !== lin.lineKey || l.suspect || l.revision === null) continue;
				if (compareRevision(l.revision, lin.revision) <= 0) continue;
				if (availableSel.has(m.selector)) {
					const e = avail.get(l.modelKey) ?? { int: m.int, selectors: [] };
					e.selectors.push(m.selector);
					e.int ??= m.int;
					avail.set(l.modelKey, e);
				} else {
					const e = login.get(l.modelKey) ?? { label: m.name, int: m.int, providers: new Set<string>() };
					e.providers.add(m.provider);
					e.int ??= m.int;
					login.set(l.modelKey, e);
				}
			}
			for (const [key, e] of avail) {
				login.delete(key);
				if (!listed.has(key)) newer.push(`${key} · 지능 ${int(e.int)} · ${e.selectors.join(", ")}`);
			}
		}
		if (newer.length) {
			found = true;
			out.push("- 새 버전", ...newer.map((n) => `  - ${n}`));
		}

		const alts = ctx.analysis.alternatives[lin.modelKey] ?? [];
		if (alts.length) {
			found = true;
			out.push("- 대안");
			for (const a of alts) {
				const cost = a.costRatio == null ? "—" : `×${a.costRatio.toFixed(2)}`;
				// Speeds not measured from the user's own runs are estimates.
				const speed = a.speed.value === null ? "— tok/s" : `${a.speed.source === "measured" ? "" : "≈"}${int(a.speed.value)} tok/s`;
				out.push(`  - ${a.label} (${a.selector}) · ${KIND[a.kind]} · 지능 ${int(a.int.value)} · ${speed} · 비용 ${cost}`);
			}
		}

		if (login.size) {
			found = true;
			out.push("- 다른 Provider 로그인 후 쓸 수 있는 새 버전");
			for (const e of login.values()) {
				out.push(`  - ${e.label} · 지능 ${int(e.int)} · 로그인 필요: ${[...e.providers].sort().join(", ")}`);
			}
		}
		if (!found) out.push("- 지금 모델보다 나은 선택지를 찾지 못했습니다.");
		out.push("");
	}
	out.push("카탈로그에 없는 모델은 요청하면 웹에서 찾아볼 수 있습니다. 출처를 함께 적고 신뢰도는 낮음으로 표시합니다.");
	return out.join("\n");
}
