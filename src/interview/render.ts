import type {
	Analysis,
	BudgetConfig,
	Candidate,
	DetectionSummary,
	MetricValue,
	QuotaState,
	RoleRecommendation,
	Seat,
	StatusView,
	StormConfig,
	Tier,
} from "../types.ts";

const DASH = "—";

export function pct(v: number | null | undefined): string {
	return v == null || !Number.isFinite(v) ? DASH : `${Math.round(v * 100)}%`;
}
export function int(v: number | null | undefined): string {
	return v == null || !Number.isFinite(v) ? DASH : String(Math.round(v));
}
export function usd(v: number | null | undefined): string {
	return v == null || !Number.isFinite(v) ? DASH : `$${v.toFixed(4)}`;
}
function ms(v: number | null | undefined): string {
	return v == null || !Number.isFinite(v) ? DASH : `${Math.round(v)}ms`;
}
/** Anything not measured from the user's own runs is marked as an estimate. */
function speedText(m: MetricValue): string {
	return m.value === null ? `${DASH} tok/s` : `${m.source === "measured" ? "" : "≈"}${int(m.value)} tok/s`;
}
const REASON: Record<string, string> = {
	"route-unavailable": "경로 사용 불가",
	"quota-exhausted": "쿼터 소진",
	"error-rate-up": "오류율 증가",
};
function reasonText(code: string): string {
	const i = code.indexOf(":");
	const text = REASON[i < 0 ? code : code.slice(0, i)] ?? code;
	return i < 0 ? text : `${text}(${code.slice(i + 1)})`;
}
/** Lineages below this share in both windows are summarized instead of listed. */
const MIN_SHARE = 0.005;
const EXCLUDED_SHOWN = 3;
export function tierLabel(t: Tier | null | undefined): string {
	return t === "cheap" ? "저가" : t === "general" ? "일반" : t === "premium" ? "고가" : DASH;
}
const QUOTA: Record<QuotaState, string> = {
	available: "여유",
	limited: "제한",
	exhausted: "소진",
	unknown: "알 수 없음",
	unavailable: "조회 불가",
};
const PRIORITY_LABEL: Record<StormConfig["priority"], string> = {
	balanced: "균형",
	quality: "품질 우선",
	cost: "비용 우선",
	speed: "속도 우선",
	quota: "쿼터 우선",
};
export function priorityLabel(p: StormConfig["priority"]): string {
	return PRIORITY_LABEL[p];
}
function time(ms: number | null | undefined): string {
	if (ms == null) return DASH;
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function age(ms: number | null, now: number): string {
	if (ms == null) return "데이터 없음";
	const h = Math.max(0, Math.round((now - ms) / 3_600_000));
	return h < 48 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}
function yes(b: boolean): string {
	return b ? "사용 가능" : "없음";
}
function warnings(ws: string[]): string {
	return ws.length ? `\n### 경고\n${ws.map((w) => `- ${w}`).join("\n")}\n` : "";
}
function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderDetection(d: DetectionSummary, now: number): string {
	const out: string[] = ["### Provider", "| Provider | 모델 수 | 쿼터 |", "|---|---|---|"];
	for (const p of d.providers) out.push(`| ${cell(p.provider)} | ${p.models} | ${QUOTA[p.quota]} |`);
	if (!d.providers.length) out.push(`| ${DASH} | 0 | ${DASH} |`);
	out.push(
		"",
		"### 도구",
		`- task: ${yes(d.tools.task)} · eval: ${yes(d.tools.eval)}`,
		`- 키워드 workflowz: ${yes(d.keywords.workflowz)} · orchestrate: ${yes(d.keywords.orchestrate)}`,
	);
	const e = d.explicit;
	if (e) {
		out.push("", "### 설정에 적힌 선호", `- 기본 모델: ${e.defaultModel ?? DASH}`);
		const roles = Object.entries(e.modelRoles);
		out.push(`- modelRoles: ${roles.length ? roles.map(([k, v]) => `${k}=${v}`).join(", ") : DASH}`);
		const ov = Object.entries(e.agentModelOverrides);
		out.push(
			`- agentModelOverrides: ${ov.length ? ov.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(", ") : DASH}`,
		);
	}
	out.push(
		"",
		`### 사용 데이터\n- 기준 시각: ${time(d.dataAsOf)} (${age(d.dataAsOf, now)})${d.stale ? " · 오래됨" : ""}`,
	);
	return out.join("\n") + warnings(d.warnings);
}

const SEAT_LABEL: Record<Seat, string> = { main: "메인 세션", subagent: "서브에이전트" };

export function renderAnalysis(a: Analysis, now: number): string {
	const out: string[] = [
		`### 사용 분석 (${a.windowDays}일, 상태 ${a.status}, 기준 ${time(a.dataAsOf)} · ${age(a.dataAsOf, now)})`,
	];
	for (const seat of ["main", "subagent"] as Seat[]) {
		out.push("", `#### ${SEAT_LABEL[seat]}`);
		const byTier = a.preferences[seat];
		let any = false;
		let hidden = 0;
		for (const t of ["premium", "general", "cheap", "unknown"] as const) {
			const list = byTier?.[t] ?? [];
			const shown = list.filter((l) => l.share >= MIN_SHARE || l.shareRecent >= MIN_SHARE).slice(0, 3);
			hidden += list.length - shown.length;
			if (!shown.length) continue;
			any = true;
			out.push(`- ${t === "unknown" ? "계층 미상" : tierLabel(t)}`);
			for (const l of shown) {
				out.push(
					`  - ${l.label}: 30일 ${pct(l.share)} · 최근 ${pct(l.shareRecent)} · 경로 ${l.routes.length}개`,
				);
				for (const r of l.routes) {
					const measured = r.ompTps !== null || r.decodeTps !== null || r.ttftP50 !== null;
					out.push(
						measured
							? `    - ${r.selector}: omp ${int(r.ompTps)} tok/s · 생성 ${int(r.decodeTps)} tok/s · TTFT p50 ${ms(r.ttftP50)}`
							: `    - ${r.selector}: 속도 미측정 (${r.requests.toLocaleString("en-US")}건)`,
					);
				}
			}
		}
		if (!any) out.push(`- ${DASH}`);
		if (hidden) out.push(`- 그 밖의 계열 ${hidden}개는 생략(비중 1% 미만이거나 계층별 상위 3개 밖)`);
	}
	if (a.stopped.length) {
		out.push("", "### 쓰다 멈춘 계열");
		const groups = new Map<string, { label: string; seats: Seat[]; reasons: Set<string>; current: Set<string> }>();
		for (const s of a.stopped) {
			const g = groups.get(s.modelKey) ?? { label: s.label, seats: [], reasons: new Set<string>(), current: new Set<string>() };
			g.seats.push(s.seat);
			for (const r of s.reasons) g.reasons.add(reasonText(r));
			for (const c of s.currentRoutes) g.current.add(c);
			groups.set(s.modelKey, g);
		}
		for (const g of groups.values()) {
			out.push(
				`- ${g.label} (${g.seats.map((s) => SEAT_LABEL[s]).join("·")}): ${g.reasons.size ? [...g.reasons].join(", ") : "확인된 사유 없음"} · 지금 쓸 수 있는 경로 ${g.current.size ? [...g.current].join(", ") : DASH}`,
			);
		}
	}
	if (a.newer.length) {
		out.push("", "### 새 버전");
		for (const n of a.newer) {
			out.push(
				`- ${n.from} → ${n.to}${n.needsCheck ? " (확인 필요)" : ""} · 지능 ${int(n.int.value)} · ${n.selectors.join(", ") || DASH}`,
			);
		}
	}
	const alts = Object.entries(a.alternatives).filter(([, v]) => v.length);
	if (alts.length) {
		out.push("", "### 대안");
		for (const [base, list] of alts) {
			out.push(
				`- ${base}: ${list
					.slice(0, 3)
					.map(
						(x) =>
							`${x.label} (${x.kind}, 지능 ${int(x.int.value)}, ${speedText(x.speed)}, 비용 ${x.costRatio == null ? DASH : `×${x.costRatio.toFixed(2)}`})`,
					)
					.join("; ")}`,
			);
		}
	}
	return out.join("\n") + warnings(a.warnings);
}

export function pickedCandidate(rec: RoleRecommendation, pick: number | string | undefined): Candidate | undefined {
	return typeof pick === "number" ? rec.candidates[pick] : undefined;
}

export function renderTeam(
	recs: RoleRecommendation[],
	picks: Record<string, number | string>,
	extra: { parallelism: number; isolation: string; contract: string; budget?: BudgetConfig },
): string {
	const out = ["| 역할 | 모델 | effort | 계층 | 근거 | 폴백 |", "|---|---|---|---|---|---|"];
	for (const rec of recs) {
		const pick = picks[rec.role.id];
		const c = pickedCandidate(rec, pick);
		const fb = fallbackOf(rec, typeof pick === "string" ? pick : c?.selector);
		if (typeof pick === "string") {
			out.push(`| ${rec.role.title} | ${cell(pick)} (직접 입력) | ${DASH} | ${DASH} | 사용자 지정 | ${fb?.selector ?? DASH} |`);
		} else if (c) {
			out.push(
				`| ${rec.role.title} | ${cell(c.label)} (${cell(c.selector)}) | ${c.effort ?? DASH} | ${tierLabel(c.tier)} | ${cell(c.why[0] ?? DASH)} | ${fb?.selector ?? DASH} |`,
			);
		} else {
			out.push(`| ${rec.role.title} | 후보 없음 | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`);
		}
	}
	out.push(
		"",
		`- 병렬도: ${extra.parallelism}`,
		`- 격리: ${extra.isolation}`,
		`- 실행 계약: ${extra.contract}`,
		`- 예산: ${extra.budget ? budgetText(extra.budget) : "없음"}`,
	);
	return out.join("\n");
}

function budgetText(b: BudgetConfig): string {
	return `실행당 $${b.perRunUsd}${b.warnAtUsd != null ? ` (경고 $${b.warnAtUsd})` : ""}, 초과 시 ${b.onExceed}`;
}

function providerOf(selector: string): string {
	const i = selector.indexOf("/");
	return i < 0 ? selector : selector.slice(0, i);
}

/** Highest-ranked remaining candidate on another provider, so one outage does not stall the role. */
export function fallbackOf(rec: RoleRecommendation, selected: string | undefined): Candidate | undefined {
	if (!selected) return undefined;
	const prov = providerOf(selected);
	return rec.candidates.find((c) => c.selector !== selected && providerOf(c.selector) !== prov);
}

export function renderEvidence(recs: RoleRecommendation[]): string {
	const out: string[] = [];
	for (const rec of recs) {
		out.push(`### ${rec.role.title} (${rec.role.agent})`);
		if (!rec.candidates.length) out.push("- 후보 없음");
		rec.candidates.forEach((c, i) => {
			out.push(
				`- ${i === rec.chosenIndex ? "★ " : ""}${c.label} (${c.selector}) · 지능 ${int(c.int.value)} · ${speedText(c.speed)} · ${usd(c.referenceUsd)}`,
			);
			for (const w of c.why) out.push(`  - 근거: ${w}`);
			for (const w of c.whyNot) out.push(`  - 제외 이유: ${w}`);
		});
		if (rec.excluded.length) {
			out.push("- 제외된 모델:");
			const byReason = new Map<string, string[]>();
			for (const x of rec.excluded) byReason.set(x.reason, [...(byReason.get(x.reason) ?? []), x.selector]);
			for (const [reason, selectors] of byReason) {
				const more = selectors.length > EXCLUDED_SHOWN ? ` 외 ${selectors.length - EXCLUDED_SHOWN}개` : "";
				out.push(`  - ${reason}: ${selectors.slice(0, EXCLUDED_SHOWN).join(", ")}${more}`);
			}
		}
		out.push("");
	}
	return out.join("\n").trimEnd();
}

export function renderConfigDiff(prev: StormConfig | undefined, next: StormConfig): string {
	const rows: string[] = [];
	const line = (field: string, a: string | undefined, b: string) => {
		if (prev === undefined) rows.push(`- ${field}: ${b}`);
		else if (a !== b) rows.push(`- ${field}: ${a ?? DASH} → ${b}`);
	};
	line("우선순위", prev && priorityLabel(prev.priority), priorityLabel(next.priority));
	const ids = new Set([...Object.keys(prev?.roles ?? {}), ...Object.keys(next.roles)]);
	for (const id of ids) {
		const a = prev?.roles[id];
		const b = next.roles[id];
		line(`${id} 모델`, a && a.models.join(" → "), b ? b.models.join(" → ") : "(삭제)");
		line(`${id} effort`, a ? (a.effort ?? DASH) : undefined, b?.effort ?? DASH);
	}
	line("병렬도", prev && String(prev.parallelism), String(next.parallelism));
	line("격리", prev?.isolation, next.isolation);
	line("실행 계약", prev?.contract, next.contract);
	line("예산", prev && (prev.budget ? budgetText(prev.budget) : "없음"), next.budget ? budgetText(next.budget) : "없음");
	if (!rows.length) return "변경 없음";
	return (prev === undefined ? "새 설정\n" : "") + rows.join("\n");
}

export function renderShadows(shadows: StatusView["shadows"]): string {
	if (!shadows.length) return "";
	return `\n\n### 경고: 가림 정의\n플러그인 에이전트 정의를 가리는 파일이 있습니다. 승인하면 이 파일들도 함께 승인됩니다.\n${shadows
		.map((s) => `- ${s.agent} (${s.scope}): ${s.path}`)
		.join("\n")}`;
}

export function renderStatus(view: StatusView, now: number): string {
	const out = ["### 저장소", `- repoId: ${view.repo.repoId}`, `- 루트: ${view.repo.root}`, "", "### 설정"];
	const c = view.config;
	if (c.status === "missing") out.push(`- 없음 (${c.path}) — /storm setup으로 만드세요`);
	else if (c.status === "invalid") out.push(`- 오류 (${c.path})`, ...c.errors.map((e) => `  - ${e}`));
	else out.push(`- 정상 · ${c.hash.replace(/^jcs-sha256:/, "").slice(0, 12)}`);
	out.push("", "### 승인");
	if (view.approval) out.push(`- 승인됨 · ${view.approval.approvalId} · ${view.approval.approvedAt}`);
	else if (c.status === "ok") out.push("- 미승인 — /storm review로 승인하세요");
	else out.push("- 미승인");
	if (c.status === "ok") {
		out.push("", "### 역할별 모델");
		for (const [id, r] of Object.entries(c.config.roles)) {
			out.push(`- ${id}: ${r.models.join(" → ") || DASH}${r.effort ? ` · ${r.effort}` : ""}`);
		}
	}
	out.push("", "### 쿼터");
	if (!view.quota.length) out.push(`- ${DASH}`);
	for (const q of view.quota) {
		out.push(
			`- ${q.provider}: ${QUOTA[q.state]} · 사용 ${pct(q.usedFraction)}${q.resetsAt != null ? ` · 재설정 ${time(q.resetsAt)}` : ""}`,
		);
	}
	out.push("", `### 사용 데이터\n- 기준 시각: ${time(view.dataAsOf)} (${age(view.dataAsOf, now)})`);
	const b = c.status === "ok" ? c.config.budget : undefined;
	out.push(
		"",
		"### 하드 예산 상한",
		b
			? `- Storm 예산은 생성만 막습니다. 하드 상한은 \`omp --max-cost ${b.perRunUsd}\` 또는 \`session.maxCost\`로 거세요.`
			: "- 하드 상한은 `omp --max-cost <USD>` 또는 `session.maxCost`로 거세요.",
	);
	return out.join("\n") + renderShadows(view.shadows);
}
