import { agentProviders, lifecycleWarnings, renderAgents, teamProviders } from "../report/agents.ts";
import { DEFAULT_CONTEXT_CAP, ROLES, STORM_VERSION, workerRange } from "../roles.ts";
import { reviewLine } from "../runtime/review.ts";
import type {
	BudgetConfig,
	Candidate,
	Effort,
	MetricValue,
	QuotaState,
	RoleConfig,
	RoleRecommendation,
	RunRecord,
	RunPlan,
	RunStatus,
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
function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
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
		line(`${id} 워커`, a ? workerText(id, a) : undefined, b ? workerText(id, b) : DASH);
		if (a?.contextCap !== undefined || b?.contextCap !== undefined) {
			line(`${id} 컨텍스트 상한`, a ? capText(a.contextCap) : undefined, b ? capText(b.contextCap) : DASH);
		}
	}
	if (prev !== undefined || next.disabledRoles?.length) line("사용 안 함", prev && (disabledTitles(prev) || "없음"), disabledTitles(next) || "없음");
	line("병렬도", prev && String(prev.parallelism), String(next.parallelism));
	if (prev?.contextCap !== undefined || next.contextCap !== undefined) line("컨텍스트 상한", prev && capText(prev.contextCap), capText(next.contextCap));
	line("격리", prev?.isolation, next.isolation);
	line("실행 계약", prev?.contract, next.contract);
	line("예산", prev && (prev.budget ? budgetText(prev.budget) : "없음"), next.budget ? budgetText(next.budget) : "없음");
	line("실행 중 다른 에이전트", prev && fallbackText(prev.fallbackRole), fallbackText(next.fallbackRole));
	line("실행이 끝나면 정리", prev && (prev.cleanup === true ? "켬" : "끔"), next.cleanup === true ? "켬" : "끔");
	line("문서 정합", prev && (prev.docs === false ? "끔" : "켬"), next.docs === false ? "끔" : "켬");
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

/** Titles of the roles the user chose not to use, comma-joined; "" when every role is in use. */
function disabledTitles(config: StormConfig): string {
	return (config.disabledRoles ?? []).map(roleTitle).join(", ");
}

/** "2~4", or "2" when min equals max. */
export function workerText(id: string, role: RoleConfig | undefined): string {
	const w = workerRange(id, role);
	return w.min === w.max ? String(w.min) : `${w.min}~${w.max}`;
}

/** Tokens of a context cap; unset → the default it falls back to. */
function capText(cap: number | undefined): string {
	return cap === undefined ? `기본(${int(DEFAULT_CONTEXT_CAP)})` : int(cap);
}

/** One status line of a role: models, effort, worker range and its own context cap. */
function roleLine(id: string, r: RoleConfig): string {
	const cap = r.contextCap !== undefined ? ` · 컨텍스트 상한 ${int(r.contextCap)}` : "";
	return `- ${id}: ${r.models.join(" → ") || DASH}${r.effort ? ` · ${r.effort}` : ""} · 워커 ${workerText(id, r)}${cap}`;
}

export function renderStatus(view: StatusView, now: number): string {
	const version = view.newerVersion
		? `- Storm ${STORM_VERSION} · 새 버전 ${view.newerVersion} 설치됨 → /restart 로 적용`
		: `- Storm ${STORM_VERSION}`;
	const out = [version, "", "### 저장소", `- repoId: ${view.repo.repoId}`, `- 루트: ${view.repo.root}`, "", "### 설정"];
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
		for (const [id, r] of Object.entries(c.config.roles)) out.push(roleLine(id, r));
		out.push(`- 컨텍스트 상한: ${int(c.config.contextCap ?? DEFAULT_CONTEXT_CAP)} 토큰`);
		if (c.config.fallbackRole !== undefined) {
			out.push(`- 실행 중 다른 에이전트: ${fallbackText(c.config.fallbackRole)}`);
		}
		if (c.config.disabledRoles?.length) out.push(`- 사용 안 함: ${disabledTitles(c.config)}`);
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
	if (view.ompAdvice?.length) {
		out.push("", "### omp 설정 점검");
		for (const a of view.ompAdvice) out.push(`- ${a.message}`, ...(a.command ? [`  - \`${a.command}\``] : []));
		out.push("- Storm 은 omp 설정을 바꾸지 않습니다. 필요하면 위 명령을 직접 실행하세요.");
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

/** The status in a few lines, for the panel above the /storm menu; `/storm status` shows all of it. */
export function renderStatusBrief(view: StatusView, now: number): string {
	const out = [
		view.newerVersion ? `- Storm ${STORM_VERSION} · 새 버전 ${view.newerVersion} 설치됨 → /restart 로 적용` : `- Storm ${STORM_VERSION}`,
	];
	const c = view.config;
	if (c.status === "ok") {
		const hash = c.hash.replace(/^jcs-sha256:/, "").slice(0, 12);
		out.push(`- 설정 ${hash} · ${view.approval ? "승인됨" : "미승인"} · 우선순위 ${priorityLabel(c.config.priority)}`);
		for (const [id, r] of Object.entries(c.config.roles)) out.push(roleLine(id, r));
		out.push(`- 컨텍스트 상한 ${int(c.config.contextCap ?? DEFAULT_CONTEXT_CAP)} 토큰`);
		if (c.config.disabledRoles?.length) out.push(`- 사용 안 함: ${disabledTitles(c.config)}`);
	} else out.push(c.status === "missing" ? "- 설정 없음" : "- 설정 오류");
	if (view.run) out.push(`- 실행 중: ${view.run.runId} · ${spendText(view.run.costUsd, view.run.budget)}`);
	else if (view.lastRun) {
		out.push(`- 마지막 실행: ${view.lastRun.runId} · ${RUN_STATUS[view.lastRun.status]} · ${spendText(view.lastRun.costUsd, view.lastRun.budget)}`);
	}
	const notes: string[] = [];
	if (view.trials?.length) notes.push(`시험 ${view.trials.length}건`);
	if (view.quotaMarks?.length) notes.push(`쿼터 소진 표시 ${view.quotaMarks.map((m) => m.provider).join(", ")}`);
	if (view.pending?.length) notes.push(`승인 대기 제안 ${view.pending.length}건`);
	if (view.lifecycle) {
		const providers = c.status === "ok" ? teamProviders(c.config) : agentProviders((view.agents ?? []).map((a) => a.entry));
		const n = lifecycleWarnings(view.lifecycle, providers).length;
		if (n) notes.push(`수명 관리 경고 ${n}건`);
	}
	if (view.ompAdvice?.length) notes.push(`omp 설정 점검 ${view.ompAdvice.length}건`);
	if (notes.length) out.push(`- 확인할 것: ${notes.join(" · ")}`);
	out.push(`- 사용 데이터 기준: ${time(view.dataAsOf)} (${age(view.dataAsOf, now)}) · 전체 현황은 /storm status`);
	return out.join("\n");
}

/** One trial with its measured comparison, for the decision that follows it. */
export function renderTrial(view: TrialView): string {
	return trialViewLines(view).join("\n");
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
	if (run.plan) out.push(`- 계획: 레인 ${run.plan.lanes.length} (${planCounts(run.plan)})`);
	if (run.spawns.length > 0) out.push(reviewLine(run.agents ?? []));
	return out;
}

/** Lanes per role of a run plan: "구현 2, 리뷰 1". */
export function planCounts(plan: RunPlan): string {
	const counts = new Map<string, number>();
	for (const l of plan.lanes) counts.set(l.role, (counts.get(l.role) ?? 0) + 1);
	return [...counts].map(([role, n]) => `${roleTitle(role)} ${n}`).join(", ");
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
