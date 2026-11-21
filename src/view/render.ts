import { shortHash } from "../config/canonical.ts";
import { unknownFields } from "../config/schema.ts";
import { agentRows, renderAgentRows } from "../report/agents.ts";
import { DEFAULT_CONTEXT_CAP, ROLE_AGENT_PREFIX, roleTitle, STORM_VERSION, workerRange } from "../roles.ts";
import { reviewLine } from "../runtime/review.ts";
import { DEFAULT_EXTRA_ROUNDS } from "../runtime/rounds.ts";
import type {
	BudgetConfig,
	MetricValue,
	QuotaState,
	RoleConfig,
	RunRecord,
	RunPlan,
	RunStatus,
	ShadowInfo,
	SpawnRecord,
	StatusView,
	StoredPriority,
	StormConfig,
	Tier,
	TrialConfig,
	TrialSide,
	TrialView,
} from "../types.ts";

const DASH = "—";
/** Control characters (ESC and line breaks among them), bidi marks and Unicode line separators. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * A string that came from a config file or a file name, made safe to show on one line: every unsafe character
 * becomes a visible \u escape, so the string cannot start a line of its own, hide what follows or move the cursor.
 */
export function visible(text: string): string {
	return text.replace(UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function pct(v: number | null | undefined): string {
	return v == null || !Number.isFinite(v) ? DASH : `${Math.round(v * 100)}%`;
}
export function int(v: number | null | undefined): string {
	return v == null || !Number.isFinite(v) ? DASH : Math.round(v).toLocaleString("en-US");
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
};
/** A candidate's quota state, with the reset time of an exhausted one when it is known. */
export function quotaText(state: QuotaState, resetsAt?: number): string {
	return state === "exhausted" && resetsAt !== undefined ? `${QUOTA[state]} · ${time(resetsAt)} 재설정` : QUOTA[state];
}
const PRIORITY_LABEL: Record<StoredPriority, string> = {
	balanced: "균형",
	quality: "품질 우선",
	cost: "비용 우선",
	// No longer choices; a config that still has one behaves as balanced.
	speed: "균형(이전 값 speed)",
	quota: "균형(이전 값 quota)",
};
export function priorityLabel(p: StoredPriority): string {
	return PRIORITY_LABEL[p];
}
const ISOLATION: Record<StormConfig["isolation"], string> = { shared: "공유 작업 트리", isolated: "격리" };
export const ON_EXCEED: Record<BudgetConfig["onExceed"], string> = { "block-spawns": "새 스폰 차단", stop: "실행 중단" };

/** Local "YYYY-MM-DD HH:mm". */
export function time(ms: number | null | undefined): string {
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
	return visible(s).replace(/\|/g, "\\|");
}

export function fallbackText(role: string | undefined): string {
	return role === undefined ? "차단" : `${roleTitle(role)} 역할 모델로 대체`;
}

/** Local "YYYY-MM-DD HH:mm" for ISO strings; unparsable text is shown as is. */
export function isoText(s: string): string {
	const t = Date.parse(s);
	return Number.isFinite(t) ? time(t) : s;
}

/** One line describing a trial: role, candidate, share, spawn cap, period and budget. */
export function trialText(t: TrialConfig): string {
	return visible(
		`${roleTitle(t.role)} · ${t.model}${t.effort ? `:${t.effort}` : ""} · 비율 ${pct(t.share)} · 최대 ${t.maxSpawns}회 · ${isoText(t.startsAt)} ~ ${isoText(t.endsAt)} · 예산 $${t.budgetUsd}`,
	);
}

export function budgetText(b: BudgetConfig): string {
	return `실행당 $${b.perRunUsd}${b.warnAtUsd != null ? ` (경고 $${b.warnAtUsd})` : ""}, 초과 시 ${ON_EXCEED[b.onExceed]}`;
}

interface DiffRow {
	/** What changed, e.g. "구현 모델"; rollback labels list these. */
	field: string;
	text: string;
}

/** Fields Storm does not know, with their values: they do nothing, but the hash covers them. */
function unknownText(config: StormConfig): string {
	return unknownFields(config)
		.map((f) => `${f.path}=${JSON.stringify(f.value)}`)
		.join(", ");
}

/** Every difference the config hash covers, one row each; with no `prev`, every set field of `next`. */
function diffRows(prev: StormConfig | undefined, next: StormConfig): DiffRow[] {
	const rows: DiffRow[] = [];
	const line = (field: string, a: string | undefined, b: string) => {
		if (prev === undefined) rows.push({ field, text: `- ${field}: ${b}` });
		else if (a !== b) rows.push({ field, text: `- ${field}: ${a ?? DASH} → ${b}` });
	};
	line("우선순위", prev && priorityLabel(prev.priority), priorityLabel(next.priority));
	const ids = new Set([...Object.keys(prev?.roles ?? {}), ...Object.keys(next.roles)]);
	for (const id of ids) {
		const a = prev?.roles[id];
		const b = next.roles[id];
		const title = roleTitle(id);
		// Comma-joined here: in a diff "→" already means old → new, so it cannot also mean attempt order.
		line(`${title} 모델`, a && a.models.join(", "), b ? b.models.join(", ") : "(삭제)");
		// The agent definition decides the role's prompt and tools; only a non-standard one is worth a line.
		const standard = `${ROLE_AGENT_PREFIX}${id}`;
		if ((a && a.agent !== standard) || (b && b.agent !== standard)) line(`${title} 에이전트 정의`, a?.agent, b?.agent ?? DASH);
		// Role-level effort is only a default for entries without a suffix; Storm no longer writes it.
		if (a?.effort !== undefined || b?.effort !== undefined) line(`${title} effort`, a ? (a.effort ?? DASH) : undefined, b?.effort ?? DASH);
		line(`${title} 워커`, a ? workerText(id, a) : undefined, b ? workerText(id, b) : DASH);
		if (a?.contextCap !== undefined || b?.contextCap !== undefined) {
			line(`${title} 컨텍스트 상한`, a ? capText(a.contextCap) : undefined, b ? capText(b.contextCap) : DASH);
		}
	}
	if (prev !== undefined || next.disabledRoles?.length) line("사용 안 함", prev && (disabledTitles(prev) || "없음"), disabledTitles(next) || "없음");
	line("병렬도", prev && String(prev.parallelism), String(next.parallelism));
	line("추가 라운드", prev && roundsText(prev.rounds), roundsText(next.rounds));
	if (prev?.contextCap !== undefined || next.contextCap !== undefined) line("컨텍스트 상한", prev && capText(prev.contextCap), capText(next.contextCap));
	line("격리", prev && ISOLATION[prev.isolation], ISOLATION[next.isolation]);
	line("예산", prev && (prev.budget ? budgetText(prev.budget) : "없음"), next.budget ? budgetText(next.budget) : "없음");
	line("실행 중 다른 에이전트", prev && fallbackText(prev.fallbackRole), fallbackText(next.fallbackRole));
	line("실행이 끝나면 정리", prev && (prev.cleanup === true ? "켬" : "끔"), next.cleanup === true ? "켬" : "끔");
	line("문서 정합", prev && (prev.docs === false ? "끔" : "켬"), next.docs === false ? "끔" : "켬");
	const prevTrials = new Map((prev?.trials ?? []).map((t) => [t.id, t]));
	const nextTrials = new Map((next.trials ?? []).map((t) => [t.id, t]));
	for (const id of new Set([...prevTrials.keys(), ...nextTrials.keys()])) {
		const a = prevTrials.get(id);
		const b = nextTrials.get(id);
		const field = `${roleTitle((a ?? b)!.role)} 시험 사용`;
		if (prev === undefined) {
			if (b) rows.push({ field, text: `- 시험 사용: ${trialText(b)}` });
		} else if (!a && b) rows.push({ field, text: `- 시험 사용 추가: ${trialText(b)}` });
		else if (a && !b) rows.push({ field, text: `- 시험 사용 삭제: ${trialText(a)}` });
		else if (a && b && trialText(a) !== trialText(b)) rows.push({ field, text: `- 시험 사용: ${trialText(a)} → ${trialText(b)}` });
	}
	if (prev !== undefined) {
		// Ignored since 0.10, but still hashed: a change here is why an otherwise equal config needs approval.
		for (const key of ["contract", "runtime"] as const) {
			line(`${key}(더는 쓰지 않는 필드)`, String(prev[key] ?? "없음"), String(next[key] ?? "없음"));
		}
	}
	const unknownPrev = prev && unknownText(prev);
	const unknownNext = unknownText(next);
	if (unknownPrev || unknownNext) line("알 수 없는 필드", unknownPrev || "없음", unknownNext || "없음");
	// Every row is one line whatever the config holds: its strings (models, agent names, old and unknown fields) are a teammate's.
	return rows.map((row) => ({ field: visible(row.field), text: visible(row.text) }));
}

export function renderConfigDiff(prev: StormConfig | undefined, next: StormConfig): string {
	const rows = diffRows(prev, next);
	if (!rows.length) return "변경 없음";
	return (prev === undefined ? "새 설정\n" : "") + rows.map((row) => row.text).join("\n");
}

/** Names of what differs between two configs ("구현 모델", "예산", ...), in diff order without repeats. */
export function changedFields(prev: StormConfig, next: StormConfig): string[] {
	return [...new Set(diffRows(prev, next).map((row) => row.field))];
}

/** The shadowing definitions as a warning section; none → no lines. `paths: false` names only the agent and where it is defined. */
export function shadowLines(shadows: readonly ShadowInfo[], paths = true): string[] {
	if (!shadows.length) return [];
	return [
		// One short line: in the approval dialog every row above the diff is a row a small terminal can still show.
		"### 경고: 가림 정의 (플러그인 에이전트 정의를 가리는 파일, 승인에 포함됩니다)",
		...shadows.map((s) => visible(`- ${s.agent} (${s.scope === "project" ? "프로젝트" : "사용자"})${paths ? `: ${s.path}` : ""}`)),
	];
}

/** Titles of the roles the user chose not to use, comma-joined; "" when every role is in use. */
function disabledTitles(config: StormConfig): string {
	return (config.disabledRoles ?? []).map((id) => visible(roleTitle(id))).join(", ");
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

/** The extra-rounds setting: the number in force, an absent one marked as the default like the context cap. */
function roundsText(rounds: number | undefined): string {
	return rounds === undefined ? `기본(${DEFAULT_EXTRA_ROUNDS})` : String(rounds);
}

/** One status line of a role: models, effort, worker range and its own context cap. */
function roleLine(id: string, r: RoleConfig): string {
	const cap = r.contextCap !== undefined ? ` · 컨텍스트 상한 ${int(r.contextCap)}` : "";
	return visible(`- ${roleTitle(id)}: ${r.models.join(" → ") || DASH}${r.effort ? ` · ${r.effort}` : ""} · 워커 ${workerText(id, r)}${cap}`);
}

function versionLine(newer: string | undefined): string {
	return newer ? `- Storm ${STORM_VERSION} · 새 버전 ${newer} 설치됨 → /restart 로 적용` : `- Storm ${STORM_VERSION}`;
}

/** The config file as the user finds it from the project root; the status never shows where that root is. */
const CONFIG_FILE = ".omp/storm/config.json";

/**
 * The whole status. For the user it is everything, with the commands that fix what it points out. For the model
 * (the storm tool) it is the same facts without advice the director could act on (omp commands, /restart, cost
 * flags) and without file paths.
 */
export function renderStatus(view: StatusView, now: number, audience: "user" | "model" = "user"): string {
	const out = [versionLine(audience === "user" ? view.newerVersion : undefined), "", "### 팀 설정"];
	const c = view.config;
	if (c.status === "missing") out.push("- 없음 — /storm 으로 만드세요");
	else if (c.status === "invalid") out.push(`- 오류 (\`${CONFIG_FILE}\`)`, ...c.errors.map((e) => `  - ${visible(e)}`));
	else out.push(`- 정상 · ${shortHash(c.hash)} · 우선순위 ${priorityLabel(c.config.priority)}`);
	out.push("", "### 승인");
	if (view.approval) out.push(`- 승인됨 · ${isoText(view.approval.approvedAt)}`);
	else if (c.status === "ok") out.push("- 미승인 — /storm 으로 승인하세요");
	else out.push("- 미승인");
	if (c.status === "ok") {
		const team = c.config;
		out.push("", "### 역할별 모델");
		for (const [id, r] of Object.entries(team.roles)) out.push(roleLine(id, r));
		if (team.disabledRoles?.length) out.push(`- 사용 안 함: ${disabledTitles(team)}`);
		out.push(
			"",
			"### 실행 설정",
			`- 병렬도: ${team.parallelism} · ${ISOLATION[team.isolation]}`,
			`- 추가 라운드: ${team.rounds ?? DEFAULT_EXTRA_ROUNDS}`,
			`- 컨텍스트 상한: ${int(team.contextCap ?? DEFAULT_CONTEXT_CAP)} 토큰`,
			`- 예산: ${team.budget ? budgetText(team.budget) : "없음"}`,
			`- 실행 중 다른 에이전트: ${visible(fallbackText(team.fallbackRole))}`,
			`- 실행이 끝나면 정리: ${team.cleanup === true ? "켬" : "끔"} · 문서 정합: ${team.docs === false ? "끔" : "켬"}`,
		);
	}
	if (view.run) {
		const r = view.run;
		out.push("", "### 실행 중", `- ${r.runId} · 시작 ${isoText(r.startedAt)} · ${spendText(r.costUsd, r.budget)}`);
	}
	if (view.lastRun) out.push("", "### 마지막 실행", ...lastRunLines(view.lastRun));
	if (view.trials?.length) {
		out.push("", "### 시험 사용");
		for (const t of view.trials) out.push(...trialViewLines(t));
	}
	if (view.quotaMarks?.length) {
		out.push("", "### 쿼터 소진 표시");
		for (const m of view.quotaMarks) out.push(`- ${m.provider}: ${isoText(m.until)}까지 다른 Provider 우선`);
	}
	if (view.agents?.length) {
		out.push("", "### 서브에이전트", renderAgentRows(agentRows(view.agents, c.status === "ok" ? c.config : undefined), now));
	}
	if (audience === "user" && view.ompAdvice?.length) {
		out.push("", "### omp 설정 점검");
		for (const a of view.ompAdvice) out.push(`- ${a.message}`, ...(a.command ? [`  - \`${a.command}\``] : []));
		out.push("- Storm 은 omp 설정을 바꾸지 않습니다. 필요하면 위 명령을 직접 실행하세요.");
	}
	if (view.quota) {
		out.push("", "### 쿼터");
		if (!view.quota.length) out.push(`- ${DASH}`);
		for (const q of view.quota) {
			out.push(
				`- ${q.provider}: ${QUOTA[q.state]} · 사용 ${pct(q.usedFraction)}${q.resetsAt != null ? ` · 재설정 ${time(q.resetsAt)}` : ""}`,
			);
		}
	}
	if (view.dataAsOf !== undefined) out.push("", `### 사용 데이터\n- 기준 시각: ${time(view.dataAsOf)} (${age(view.dataAsOf, now)})`);
	if (view.storage !== undefined) out.push("", "### 저장 공간", `- ${view.storage}`);
	if (audience === "user") {
		const b = c.status === "ok" ? c.config.budget : undefined;
		out.push(
			"",
			"### 하드 예산 상한",
			b
				? `- Storm 예산은 새 스폰만 막습니다. 하드 상한은 \`omp --max-cost ${b.perRunUsd}\` 또는 \`session.maxCost\`로 거세요.`
				: "- 하드 상한은 `omp --max-cost <USD>` 또는 `session.maxCost`로 거세요.",
		);
	}
	const shadows = shadowLines(view.shadows, audience === "user");
	if (shadows.length) out.push("", ...shadows);
	return out.join("\n");
}

/** The status in a few lines, for the panel above the /storm menu; `/storm status` shows the whole team setting and every section. */
export function renderStatusBrief(view: StatusView, now: number): string {
	const out = [versionLine(view.newerVersion)];
	const c = view.config;
	if (c.status === "ok") {
		out.push(`- 팀 설정 ${shortHash(c.hash)} · ${view.approval ? "승인됨" : "미승인"} · 우선순위 ${priorityLabel(c.config.priority)}`);
		for (const [id, r] of Object.entries(c.config.roles)) out.push(roleLine(id, r));
		out.push(`- 컨텍스트 상한 ${int(c.config.contextCap ?? DEFAULT_CONTEXT_CAP)} 토큰`);
		if (c.config.disabledRoles?.length) out.push(`- 사용 안 함: ${disabledTitles(c.config)}`);
	} else out.push(c.status === "missing" ? "- 팀 설정 없음" : "- 팀 설정 오류");
	if (view.run) out.push(`- 실행 중: ${view.run.runId} · ${spendText(view.run.costUsd, view.run.budget)}`);
	else if (view.lastRun) {
		out.push(`- 마지막 실행: ${view.lastRun.runId} · ${RUN_STATUS[view.lastRun.status]} · ${spendText(view.lastRun.costUsd, view.lastRun.budget)}`);
	}
	const notes: string[] = [];
	if (view.trials?.length) notes.push(`시험 사용 ${view.trials.length}건`);
	if (view.quotaMarks?.length) notes.push(`쿼터 소진 표시 ${view.quotaMarks.map((m) => m.provider).join(", ")}`);
	if (view.ompAdvice?.length) notes.push(`omp 설정 점검 ${view.ompAdvice.length}건`);
	if (notes.length) out.push(`- 확인할 것: ${notes.join(" · ")}`);
	const data = view.dataAsOf !== undefined ? `사용 데이터 기준: ${time(view.dataAsOf)} (${age(view.dataAsOf, now)}) · ` : "";
	out.push(`- ${data}전체 현황은 /storm status`);
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
	trial: "시험 사용",
	allowed: "허용",
	substituted: "대체",
	blocked: "차단",
};
const PHASE: Record<TrialView["phase"], string> = { pending: "시작 전", active: "진행 중", ended: "종료" };
const END_REASON: Record<NonNullable<TrialView["endReason"]>, string> = {
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
	const end = v.phase === "ended" ? (v.endReason ? `(${END_REASON[v.endReason]})` : "") : ` · 종료 예정 ${isoText(t.endsAt)}`;
	const out = [
		visible(`- ${roleTitle(t.role)} · ${t.model}: ${PHASE[v.phase]}${end} · 배정 ${s?.routed ?? 0}/${t.maxSpawns} · 지출 ${usd(s?.costUsd ?? 0)} / $${t.budgetUsd}`),
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
