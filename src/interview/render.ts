import { agentProviders, lifecycleWarnings, renderAgents, teamProviders } from "../report/agents.ts";
import { ROLES, STORM_VERSION } from "../roles.ts";
import type {
	Analysis,
	BudgetConfig,
	Candidate,
	DetectionSummary,
	Effort,
	MetricValue,
	QuotaState,
	RoleRecommendation,
	RunRecord,
	RunStatus,
	Seat,
	SpawnRecord,
	StatusView,
	StormConfig,
	Tier,
	TrialConfig,
	TrialSide,
	TrialView,
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
export function speedText(m: MetricValue): string {
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

/** A model the interview picked for a role, with its own effort (none when the model has no effort control). */
export interface PickedModel {
	selector: string;
	label: string;
	effort?: Effort;
}

export interface RolePick {
	primary: PickedModel;
	fallback?: PickedModel;
}

export function renderTeam(
	recs: RoleRecommendation[],
	picks: Record<string, RolePick>,
	extra: {
		parallelism: number;
		isolation: string;
		contract: string;
		budget?: BudgetConfig;
		/** Workers per role id; missing roles show the contract default of 1. */
		workers?: Record<string, number>;
		/** Role id whose models non-Storm agents get during a run; absent → blocked. */
		fallbackRole?: string;
		trials?: TrialConfig[];
	},
): string {
	const out = ["| 역할 | 모델 | effort | 계층 | 근거 | 폴백 | 폴백 effort | 워커 |", "|---|---|---|---|---|---|---|---|"];
	for (const rec of recs) {
		const pick = picks[rec.role.id];
		const workers = extra.workers?.[rec.role.id] ?? 1;
		if (!pick) {
			out.push(`| ${rec.role.title} | 후보 없음 | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${workers} |`);
			continue;
		}
		const c = rec.candidates.find((x) => x.selector === pick.primary.selector);
		const model = c ? `${cell(c.label)} (${cell(c.selector)})` : `${cell(pick.primary.selector)} (직접 입력)`;
		const basis = c ? `${tierLabel(c.tier)} | ${cell(c.why[0] ?? DASH)}` : `${DASH} | 사용자 지정`;
		const fb = pick.fallback;
		out.push(
			`| ${rec.role.title} | ${model} | ${pick.primary.effort ?? DASH} | ${basis} | ${fb ? cell(fb.selector) : DASH} | ${fb?.effort ?? DASH} | ${workers} |`,
		);
	}
	out.push(
		"",
		`- 병렬도: ${extra.parallelism}`,
		`- 격리: ${extra.isolation}`,
		`- 실행 계약: ${extra.contract}`,
		`- 예산: ${extra.budget ? budgetText(extra.budget) : "없음"}`,
		`- 실행 중 다른 에이전트: ${fallbackText(extra.fallbackRole)}`,
	);
	if (extra.trials?.length) {
		out.push("- 시험:");
		for (const t of extra.trials) out.push(`  - ${trialText(t)}`);
	}
	return out.join("\n");
}

export function roleTitle(id: string): string {
	return ROLES.find((r) => r.id === id)?.title ?? id;
}

export function fallbackText(role: string | undefined): string {
	return role === undefined ? "차단" : `${roleTitle(role)} 역할 모델로 대체`;
}

/** Local "YYYY-MM-DD HH:mm" for ISO strings; unparsable text is shown as is. */
function isoText(s: string): string {
	const t = Date.parse(s);
	return Number.isFinite(t) ? time(t) : s;
}

/** One line describing a trial: role, candidate, share, spawn cap, period and budget. */
export function trialText(t: TrialConfig): string {
	return `${roleTitle(t.role)} · ${t.model}${t.effort ? `:${t.effort}` : ""} · 비율 ${pct(t.share)} · 최대 ${t.maxSpawns}회 · ${isoText(t.startsAt)} ~ ${isoText(t.endsAt)} · 예산 $${t.budgetUsd}`;
}

export function budgetText(b: BudgetConfig): string {
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
		// Comma-joined here: in a diff "→" already means old → new, so it cannot also mean attempt order.
		line(`${id} 모델`, a && a.models.join(", "), b ? b.models.join(", ") : "(삭제)");
		// Role-level effort is only a default for entries without a suffix; the interview no longer writes it.
		if (a?.effort !== undefined || b?.effort !== undefined) line(`${id} effort`, a ? (a.effort ?? DASH) : undefined, b?.effort ?? DASH);
		line(`${id} 워커`, a ? String(a.workers ?? 1) : undefined, b ? String(b.workers ?? 1) : DASH);
	}
	line("병렬도", prev && String(prev.parallelism), String(next.parallelism));
	line("격리", prev?.isolation, next.isolation);
	line("실행 계약", prev?.contract, next.contract);
	line("예산", prev && (prev.budget ? budgetText(prev.budget) : "없음"), next.budget ? budgetText(next.budget) : "없음");
	line("실행 중 다른 에이전트", prev && fallbackText(prev.fallbackRole), fallbackText(next.fallbackRole));
	const prevTrials = new Map((prev?.trials ?? []).map((t) => [t.id, t]));
	const nextTrials = new Map((next.trials ?? []).map((t) => [t.id, t]));
	for (const id of new Set([...prevTrials.keys(), ...nextTrials.keys()])) {
		const a = prevTrials.get(id);
		const b = nextTrials.get(id);
		if (prev === undefined) {
			if (b) rows.push(`- 시험 ${id}: ${trialText(b)}`);
		} else if (!a && b) rows.push(`- 시험 ${id}: 추가 · ${trialText(b)}`);
		else if (a && !b) rows.push(`- 시험 ${id}: 삭제`);
		else if (a && b && trialText(a) !== trialText(b)) rows.push(`- 시험 ${id}: ${trialText(a)} → ${trialText(b)}`);
	}
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
	const out = [`- Storm ${STORM_VERSION}`, "", "### 저장소", `- repoId: ${view.repo.repoId}`, `- 루트: ${view.repo.root}`, "", "### 설정"];
	const c = view.config;
	if (c.status === "missing") out.push(`- 없음 (${c.path}) — /storm 으로 만드세요`);
	else if (c.status === "invalid") out.push(`- 오류 (${c.path})`, ...c.errors.map((e) => `  - ${e}`));
	else out.push(`- 정상 · ${c.hash.replace(/^jcs-sha256:/, "").slice(0, 12)}`);
	out.push("", "### 승인");
	if (view.approval) out.push(`- 승인됨 · ${view.approval.approvalId} · ${view.approval.approvedAt}`);
	else if (c.status === "ok") out.push("- 미승인 — /storm 으로 승인하세요");
	else out.push("- 미승인");
	if (c.status === "ok") {
		out.push("", "### 역할별 모델");
		for (const [id, r] of Object.entries(c.config.roles)) {
			const workers = r.workers !== undefined ? ` · 워커 ${r.workers}` : "";
			out.push(`- ${id}: ${r.models.join(" → ") || DASH}${r.effort ? ` · ${r.effort}` : ""}${workers}`);
		}
		if (c.config.fallbackRole !== undefined) {
			out.push(`- 실행 중 다른 에이전트: ${fallbackText(c.config.fallbackRole)}`);
		}
	}
	if (view.run) {
		const r = view.run;
		out.push("", "### 실행 중", `- ${r.runId} · 시작 ${isoText(r.startedAt)} · ${spendText(r.costUsd, r.budget)}`);
	}
	if (view.lastRun) out.push("", "### 마지막 실행", ...lastRunLines(view.lastRun));
	if (view.trials?.length) {
		out.push("", "### 시험");
		for (const t of view.trials) out.push(...trialViewLines(t));
	}
	if (view.quotaMarks?.length) {
		out.push("", "### 쿼터 소진 표시");
		for (const m of view.quotaMarks) out.push(`- ${m.provider}: ${isoText(m.until)}까지 다른 provider 우선`);
	}
	if (view.pending?.length) {
		out.push("", `### 승인 대기 제안 (${view.pending.length}건)`);
		for (const p of view.pending) out.push(`- ${p.summary}`);
		out.push("- /storm 메뉴에서 승인하세요");
	}
	if (view.agents) out.push("", "### 서브에이전트", renderAgents(view.agents, now));
	if (view.lifecycle) {
		const providers = c.status === "ok" ? teamProviders(c.config) : agentProviders((view.agents ?? []).map((a) => a.entry));
		const ws = lifecycleWarnings(view.lifecycle, providers);
		if (ws.length) out.push("", "### 수명 관리", ...ws.map((w) => `- ${w}`));
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

const RUN_STATUS: Record<RunStatus, string> = {
	running: "진행 중",
	done: "완료",
	"budget-exceeded": "예산 초과",
	stopped: "중단",
};
const OUTCOME: Record<SpawnRecord["outcome"], string> = {
	routed: "배정",
	trial: "시험",
	allowed: "허용",
	substituted: "대체",
	blocked: "차단",
};
const PHASE: Record<TrialView["phase"], string> = { pending: "시작 전", active: "진행 중", ended: "종료" };
const END_REASON: Record<NonNullable<NonNullable<TrialView["state"]>["endReason"]>, string> = {
	time: "기간 만료",
	spawns: "횟수 소진",
	budget: "예산 소진",
};

function spendText(cost: number, budget: BudgetConfig | undefined): string {
	return `지출 ${usd(cost)}${budget ? ` / 예산 $${budget.perRunUsd}` : ""}`;
}

function lastRunLines(run: RunRecord): string[] {
	const counts = new Map<SpawnRecord["outcome"], number>();
	for (const s of run.spawns) counts.set(s.outcome, (counts.get(s.outcome) ?? 0) + 1);
	const spawns = counts.size
		? (Object.keys(OUTCOME) as Array<SpawnRecord["outcome"]>)
				.filter((o) => counts.has(o))
				.map((o) => `${OUTCOME[o]} ${counts.get(o)}`)
				.join(", ")
		: "없음";
	const out = [`- ${run.runId} · ${RUN_STATUS[run.status]} · ${spendText(run.costUsd, run.budget)}`, `- 스폰: ${spawns}`];
	const blocked = run.spawns.find((s) => s.outcome === "blocked" && s.reason);
	if (blocked?.reason) out.push(`- 첫 차단: ${blocked.agent} · ${blocked.reason}`);
	return out;
}

function trialViewLines(v: TrialView): string[] {
	const t = v.trial;
	const s = v.state;
	const end = s?.endedAt
		? `종료 ${isoText(s.endedAt)}${s.endReason ? ` (${END_REASON[s.endReason]})` : ""}`
		: `종료 예정 ${isoText(t.endsAt)}`;
	const out = [
		`- ${t.id} (${roleTitle(t.role)} · ${t.model}): ${PHASE[v.phase]} · 배정 ${s?.routed ?? 0}/${t.maxSpawns} · 지출 ${usd(s?.costUsd ?? 0)} / $${t.budgetUsd} · ${end}`,
	];
	const cmp = v.comparison;
	if (cmp) {
		const row = (label: string, f: (x: TrialSide) => string) =>
			`| ${label} | ${cell(f(cmp.candidate))} | ${cell(f(cmp.current))} |`;
		out.push(
			"",
			"| 항목 | 후보 | 현재 |",
			"|---|---|---|",
			row("모델", (x) => x.selector),
			row("요청", (x) => String(x.requests)),
			row("오류율", (x) => pct(x.errorRate)),
			row("omp tok/s", (x) => int(x.ompTps)),
			row("생성 tok/s", (x) => int(x.decodeTps)),
			row("TTFT p50", (x) => ms(x.ttftP50)),
			row("요청당 비용", (x) => usd(x.costPerRequest)),
			`- 측정 기준: ${time(cmp.dataAsOf)}`,
			"",
		);
	}
	return out;
}
