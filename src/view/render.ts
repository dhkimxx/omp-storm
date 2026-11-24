import { shortHash } from "../config/canonical.ts";
import { unknownFields } from "../config/schema.ts";
import { formatUsd } from "../policy/spawn.ts";
import { agentRows, agentStatusSpans, renderAgentRows } from "../report/agents.ts";
import { DEFAULT_CONTEXT_CAP, ROLE_AGENT_PREFIX, roleTitle, STORM_VERSION, workerRange } from "../roles.ts";
import { reviewLine } from "../runtime/review.ts";
import { DEFAULT_EXTRA_ROUNDS, endLabel, STATUS_LABEL } from "../runtime/rounds.ts";
import { idleAppearance, RUN_APPEARANCE, STORM_MARK } from "./appearance.ts";
import { resultProgress, resultRowText, type ResultProgress } from "./results.ts";
import type {
	BudgetConfig,
	InfoLine,
	InfoSpan,
	InfoTone,
	MetricValue,
	QuotaState,
	RequiredCheck,
	RoleConfig,
	RunRecord,
	RunPlan,
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
/** Only an exhausted quota is an error; a limited one still routes, so it is a warning. */
const QUOTA_TONE: Record<QuotaState, InfoTone> = {
	available: "accent",
	limited: "warning",
	exhausted: "error",
	unknown: "muted",
};
/** A quota state's icon; only limited/exhausted claim a problem. */
const QUOTA_ICON: Record<QuotaState, NonNullable<InfoLine["icon"]>> = {
	available: "status.info",
	limited: "status.warning",
	exhausted: "status.error",
	unknown: "status.info",
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
const ISOLATION: Record<StormConfig["isolation"], string> = { shared: "공유 작업 트리", isolated: "팀 격리(리뷰 포함)" };
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
	/** The rich form of a model row; other rows stay Markdown. */
	info?: readonly InfoSpan[];
}

/** Old model values muted, the new primary accented, new fallbacks muted: all text stays exactly as the row's. */
function modelRowSpans(
	field: string,
	oldModels: readonly string[] | undefined,
	newModels: readonly string[] | undefined,
	whole: boolean,
): InfoSpan[] {
	const models = (list: readonly string[], toneOf: (index: number) => InfoTone): InfoSpan[] => {
		const out: InfoSpan[] = [];
		for (const [index, model] of list.entries()) {
			if (index > 0) out.push({ text: ", " });
			out.push({ text: visible(model), tone: toneOf(index) });
		}
		return out;
	};
	const next = newModels === undefined ? [{ text: "(삭제)" }] : models(newModels, (index) => (index === 0 ? "accent" : "muted"));
	const spans: InfoSpan[] = [{ text: `- ${visible(field)}: ` }];
	if (whole) {
		spans.push(...next);
		return spans;
	}
	spans.push(...(oldModels === undefined ? [{ text: DASH, tone: "muted" as const }] : models(oldModels, () => "muted")));
	spans.push({ text: " → " }, ...next);
	return spans;
}

/** Fields Storm does not know, with their values: they do nothing, but the hash covers them. */
function unknownText(config: StormConfig): string {
	return unknownFields(config)
		.map((f) => `${f.path}=${JSON.stringify(f.value)}`)
		.join(", ");
}

/** Every difference the config hash covers, one row each; with no `prev`, every set field of `next`. */
function diffRows(prev: StormConfig | undefined, next: StormConfig, rich = false): DiffRow[] {
	const rows: DiffRow[] = [];
	const line = (field: string, a: string | undefined, b: string, info?: () => readonly InfoSpan[]) => {
		if (prev === undefined) rows.push({ field, text: `- ${field}: ${b}`, ...(info ? { info: info() } : {}) });
		else if (a !== b) rows.push({ field, text: `- ${field}: ${a ?? DASH} → ${b}`, ...(info ? { info: info() } : {}) });
	};
	line("우선순위", prev && priorityLabel(prev.priority), priorityLabel(next.priority));
	// An obligation the run must meet: every exact executable and argument, as approved, one row per check. Early in
	// the diff so a small terminal cannot cut the added obligation off the end.
	if (prev?.requiredChecks !== undefined || next.requiredChecks !== undefined) {
		const before = prev?.requiredChecks ?? [];
		const after = next.requiredChecks ?? [];
		const beforeByName = new Map(before.map((check) => [check.name, check]));
		const afterByName = new Map(after.map((check) => [check.name, check]));
		const names = [...before.map((check) => check.name), ...after.map((check) => check.name).filter((name) => !beforeByName.has(name))];
		for (const name of names) {
			const a = beforeByName.get(name);
			const b = afterByName.get(name);
			const field = `필수 검사 ${name}`;
			const aText = a === undefined ? undefined : JSON.stringify(a.argv);
			const bText = b === undefined ? undefined : JSON.stringify(b.argv);
			if (prev === undefined) {
				if (b !== undefined) rows.push({ field, text: `- ${field}: ${bText}` });
			} else if (a === undefined) rows.push({ field, text: `- ${field} 추가: ${bText}` });
			else if (b === undefined) rows.push({ field, text: `- ${field} 삭제: ${aText}` });
			else if (aText !== bText) rows.push({ field, text: `- ${field}: ${aText} → ${bText}` });
		}
		const beforeOrder = before.map((check) => check.name);
		const afterOrder = after.map((check) => check.name);
		const sameNames =
			beforeOrder.length === afterOrder.length &&
			beforeOrder.every((name) => afterByName.has(name)) &&
			afterOrder.every((name) => beforeByName.has(name));
		if (sameNames && beforeOrder.some((name, i) => name !== afterOrder[i])) {
			line("필수 검사 순서", beforeOrder.join(" → "), afterOrder.join(" → "));
		}
		if (!before.length && !after.length) {
			line("필수 검사", prev?.requiredChecks !== undefined ? "없음" : undefined, next.requiredChecks !== undefined ? "없음" : DASH);
		}
	}
	const beforeJobs = new Map(prev?.jobs?.map(job => [job.name, job]));
	const afterJobs = new Map(next.jobs?.map(job => [job.name, job]));
	for (const name of new Set([...beforeJobs.keys(), ...afterJobs.keys()])) {
		const a = beforeJobs.get(name);
		const b = afterJobs.get(name);
		line(`정형 작업 ${name}`, a === undefined ? undefined : JSON.stringify(a), b === undefined ? "(삭제)" : JSON.stringify(b));
	}
	if (beforeJobs.size === 0 && afterJobs.size === 0 && (prev?.jobs !== undefined || next.jobs !== undefined)) {
		line("정형 작업", prev?.jobs === undefined ? undefined : "없음", next.jobs === undefined ? DASH : "없음");
	}
	const ids = new Set([...Object.keys(prev?.roles ?? {}), ...Object.keys(next.roles)]);
	for (const id of ids) {
		const a = prev?.roles[id];
		const b = next.roles[id];
		const title = roleTitle(id);
		// Comma-joined here: in a diff "→" already means old → new, so it cannot also mean attempt order.
		const modelField = `${title} 모델`;
		line(modelField, a && a.models.join(", "), b ? b.models.join(", ") : "(삭제)", rich ? () => modelRowSpans(modelField, a?.models, b?.models, prev === undefined) : undefined);
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
	return rows.map((row) => ({ field: visible(row.field), text: visible(row.text), ...(row.info ? { info: row.info } : {}) }));
}

/**
 * The diff as Markdown. `info` (TUI only) adds semantic spans for role-model rows, with indexes local to the returned
 * Markdown and the exact same visible text; the plain parameter keeps every existing caller's output.
 */
export function renderConfigDiff(prev: StormConfig | undefined, next: StormConfig, info?: InfoLine[]): string {
	const rows = diffRows(prev, next, info !== undefined);
	if (!rows.length) return "변경 없음";
	const out: string[] = [];
	if (prev === undefined) {
		const index = out.length;
		out.push("새 설정");
		if (info) info.push({ index, spans: [{ text: "새 설정", tone: "accent" }] });
	}
	for (const row of rows) {
		const index = out.length;
		out.push(row.text);
		if (info && row.info) info.push({ index, spans: row.info });
	}
	return out.join("\n");
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

/** A required check with its exact executable and arguments: the obligation the user approves, never a shell string. */
export function checkText(check: RequiredCheck): string {
	return visible(`${check.name}: ${JSON.stringify(check.argv)}`);
}

function versionLine(newer: string | undefined): string {
	return newer ? `- Storm ${STORM_VERSION} · 새 버전 ${visible(newer)} 설치됨 → /restart 로 적용` : `- Storm ${STORM_VERSION}`;
}

interface StatusState {
	label: string;
	tone: InfoTone;
	action?: string;
}

/** The team and consent state an idle status reports; a run's live phase takes precedence over both. */
function statusState(view: StatusView, resume: boolean, resumeAction = true): StatusState {
	if (view.run) {
		const phase = view.runPhase ? RUN_APPEARANCE[view.runPhase] : undefined;
		// Without a phase the record's status is all that is known; a phase name is never invented.
		return phase ? { label: phase.label, tone: phase.tone } : { label: "실행 중", tone: runTone(view.run) };
	}
	const team = view.config.status === "missing" ? "missing" : view.config.status === "invalid" ? "invalid" : view.approval ? "approved" : "unapproved";
	const auto = view.autoDelegation === "on" ? "on" : view.autoDelegation === "blocked" ? "blocked" : "off";
	const state = idleAppearance({ team, auto, resume });
	if (team === "approved" && auto === "blocked" && view.autoModeProblem !== undefined) return { ...state, action: visible(view.autoModeProblem) };
	// The hub already offers resume as an action row, so its head never points back at itself; another action stays.
	if (!resumeAction && resume && team === "approved" && auto !== "blocked") return { label: state.label, tone: state.tone };
	return state;
}

function autoStatusText(view: StatusView): string {
	if (view.autoDelegation === "on") return "켜짐";
	if (view.autoDelegation !== "blocked") return "꺼짐";
	return view.autoModeProblem === undefined ? "켜짐 · 팀 승인 대기" : "켜짐 · 실행 차단";
}

/** One icon per status section; tabs use the same keys so a section reads the same in both places. */
const SECTION_ICON: Record<NonNullable<InfoLine["section"]>, NonNullable<InfoLine["icon"]>> = {
	overview: "status.info",
	team: "status.enabled",
	runtime: "status.running",
	storage: "context.content",
};

/**
 * `≋ STORM · state · version` opens both the full status and the hub, so the present state and the version's
 * action are the first thing seen. The line's rich form uses the state's theme tone; nothing here animates.
 */
function pushStatusHead(out: string[], info: InfoLine[] | undefined, state: StatusState, newer: string | undefined): void {
	const version = newer ? `v${STORM_VERSION} · 새 버전 ${visible(newer)} → /restart` : `v${STORM_VERSION}`;
	const index = out.length;
	out.push(`${STORM_MARK} · ${state.label} · ${version}`);
	if (info) {
		info.push({
			index,
			emphasis: "title",
			spans: [
				{ text: STORM_MARK, tone: "accent" },
				{ text: ` · ${state.label}`, tone: state.tone },
				{ text: ` · ${version}`, tone: "muted" },
			],
		});
	}
	if (state.action !== undefined) {
		// Markdown keeps the command in code formatting; the rich line colors the same words without backticks.
		const actionIndex = out.length;
		out.push(`- 다음: ${state.action}`);
		if (info) {
			info.push({
				index: actionIndex,
				icon: "status.warning",
				emphasis: "action",
				spans: [
					{ text: "- 다음: ", tone: "warning" },
					{ text: state.action.replaceAll("`", ""), tone: "warning" },
				],
			});
		}
	}
}

function runRoundText(run: RunRecord): string {
	const turns = run.turns ?? 0;
	return run.maxRounds === undefined ? `${turns + 1}라운드` : `${Math.min(turns + 1, run.maxRounds)}/${run.maxRounds}라운드`;
}

function runAgentsText(run: RunRecord): string | undefined {
	const agents = run.agents ?? [];
	if (!agents.length) return undefined;
	const running = agents.filter(agent => agent.state === "running").length;
	return `서브에이전트 ${agents.length}${running ? `(실행 중 ${running})` : ""}`;
}

/** `runStatusText`'s counters in their established order: round, agents, spend, minutes. */
function runStatusParts(run: RunRecord, now: number): string[] {
	const parts = runProgressParts(run, now);
	const minutes = parts.pop()!;
	parts.push(run.budget ? `${formatUsd(run.costUsd)}/${formatUsd(run.budget.perRunUsd)}` : formatUsd(run.costUsd));
	parts.push(minutes);
	return parts;
}

/** Icons for the result projection's approved tones; a result state never invents an error class. */
const RESULT_ICON: Record<InfoTone, NonNullable<InfoLine["icon"]>> = {
	accent: "status.running",
	success: "status.success",
	warning: "status.warning",
	error: "status.error",
	muted: "status.info",
};

interface ResultLine {
	text: string;
	spans: InfoSpan[];
	icon: NonNullable<InfoLine["icon"]>;
}

/**
 * The one official-result line every report reader shares; absent for a legacy run with no usable ledger. Detailed
 * rows repeat every criterion and id, so above them only the aggregate counts add information. Where no row follows
 * (the compact brief, the plain widget and the model view), the focus name stays in this line.
 */
function resultLine(progress: ResultProgress, options: { prefix?: string; detailed?: boolean } = {}): ResultLine | undefined {
	if (!progress.present) return undefined;
	const prefix = options.prefix ?? "";
	const body = options.detailed === true && progress.rows.length > 0 ? progress.parts.join(" · ") : progress.headline;
	const label = `- ${prefix}결과(공식): `;
	return {
		text: `${label}${body}`,
		spans: [{ text: label }, { text: body, tone: progress.tone }],
		icon: RESULT_ICON[progress.tone],
	};
}

/** The round/agents/minutes part of the run details; spend has its own authoritative line and meter. */
function runProgressParts(run: RunRecord, now: number): string[] {
	const parts = [runRoundText(run)];
	const agents = runAgentsText(run);
	if (agents) parts.push(agents);
	const minutes = Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 60_000));
	parts.push(`${minutes}분`);
	return parts;
}

/**
 * The one target an approval covers, shown wherever a choice can approve or depend on it. The store is this session's
 * profile directory, so there is no workspace config file to edit: a different target needs a fresh approval here.
 */
export function targetScopeLine(root: string): string {
	return `이 세션의 팀 설정과 승인은 지금 작업 대상(${visible(root)})에만 적용됩니다. 대상을 바꾸면 팀 설정은 남지만 다시 승인해야 합니다.`;
}

/**
 * The whole status. For the user it leads with present state, version and a real next action, then the active and
 * last run, then everything else with the commands that fix what it points out. For the model (the storm tool) it is
 * the same facts without advice the director could act on (omp commands, /restart, cost flags) and without file
 * paths. `info` adds the dashboard's sections and styles without changing the Markdown.
 */
export function renderStatus(
	view: StatusView,
	now: number,
	audience: "user" | "model" = "user",
	info?: InfoLine[],
): string {
	const model = audience === "model";
	const out: string[] = [];
	// The user's panel leads with present state, version and a genuinely actionable next step. The model view keeps
	// its old version-first payload: no user advice or decorative head enters what the director reads.
	if (model) out.push(versionLine(undefined));
	else pushStatusHead(out, info, statusState(view, false), view.newerVersion);
	let section: NonNullable<InfoLine["section"]> = "overview";
	/** Mark only section boundaries: each tab may contain several consecutive headings. */
	const sectionStart = (next: InfoLine["section"]): InfoLine["section"] => {
		if (model || next === undefined || next === section) return undefined;
		section = next;
		return next;
	};
	/** A section title: the Markdown keeps `### …`; the rich line carries only the visible title. */
	const heading = (title: string, next?: InfoLine["section"], icon?: InfoLine["icon"]): void => {
		const index = out.length;
		out.push(`### ${title}`);
		if (info) {
			const start = sectionStart(next);
			info.push({
				index,
				spans: [{ text: visible(title) }],
				emphasis: "title",
				icon: icon ?? SECTION_ICON[next ?? section],
				...(start ? { section: start } : {}),
			});
		}
	};
	/** A list line built from `spans`, so its Markdown and rich text cannot drift apart. */
	const styled = (spans: readonly InfoSpan[], meter?: InfoLine["meter"], icon?: InfoLine["icon"]): void => {
		const safe = spans.map((span) => (span.tone ? { text: visible(span.text), tone: span.tone } : { text: visible(span.text) }));
		const index = out.length;
		out.push(safe.map((span) => span.text).join(""));
		if (info) info.push({ index, spans: safe, ...(meter ? { meter } : {}), ...(icon ? { icon } : {}) });
	};
	/** Present-state details for the active run: results first, then spend and worker telemetry. */
	const runSection = (): void => {
		const run = view.run;
		if (!run) return;
		out.push("");
		heading("실행 중", undefined, "status.running");
		const outcome = resultProgress(run);
		const outcomeLine = resultLine(outcome, { detailed: !model });
		if (outcomeLine !== undefined) {
			const index = out.length;
			out.push(outcomeLine.text);
			if (info) info.push({ index, icon: outcomeLine.icon, spans: outcomeLine.spans });
			if (!model) for (const row of outcome.rows) {
				const tone: InfoTone = row.excluded ? "muted" : row.state === "accepted" ? "success" : row.state === "unmet" && !row.running ? "warning" : "accent";
				styled([{ text: `- ${resultRowText(row, { includeScope: true })}`, tone }], undefined, RESULT_ICON[tone]);
			}
		}
		styled(runLineSpans(run), runMeter(run), "status.running");
		const progress = runProgressParts(run, now);
		const index = out.length;
		out.push(`- ${progress.join(" · ")}`);
		if (info) {
			info.push({
				index,
				spans: [
					{ text: "- " },
					{ text: progress[0]!, tone: "accent" },
					{ text: ` · ${progress.slice(1).join(" · ")}` },
				],
			});
		}
		if (run.plan) {
			for (const line of isolationLaneLines(run.plan, run)) styled([{ text: line }], undefined, "status.warning");
			const note = isolationNote(run.plan);
			if (note !== undefined) styled([{ text: note, tone: "muted" }]);
		}
		const agents = run.agents;
		if (agents !== undefined && agents.some(agent => (agent.review?.reviews ?? 0) > 0)) out.push(reviewLine(agents));
	};
	/** The last finished run is read after the active one and before the team setting. */
	const lastRunSection = (): void => {
		const run = view.lastRun;
		if (!run) return;
		out.push("");
		heading("마지막 실행", undefined, "status.info");
		const lines = lastRunLines(run, !model);
		const index = out.length;
		out.push(...lines);
		if (info) {
			const meter = runMeter(run);
			info.push({ index, spans: lastRunLineSpans(run), icon: RUN_ICON[runTone(run)], ...(meter ? { meter } : {}) });
		}
	};
	// The active run and the last result are present state, so they come before the team setting; the model keeps
	// its established section order.
	if (!model) {
		runSection();
		lastRunSection();
	}
	const c = view.config;
	out.push("");
	heading("팀 설정", "team");
	if (c.status === "missing") styled([{ text: "- 없음 — /storm 으로 만드세요", tone: "warning" }], undefined, "status.warning");
	else if (c.status === "invalid") {
		styled([{ text: "- 오류 (이 세션의 팀 설정)", tone: "error" }], undefined, "status.error");
		for (const e of c.errors) styled([{ text: `  - ${visible(e)}`, tone: "error" }]);
	} else {
		styled([
			{ text: "- 정상", tone: "accent" },
			{ text: ` · ${shortHash(c.hash)} · 우선순위 ${priorityLabel(c.config.priority)}` },
		]);
	}
	out.push("");
	const approvalIcon: InfoLine["icon"] = view.approval ? "status.success" : c.status === "invalid" ? "status.error" : "status.warning";
	heading("승인", undefined, approvalIcon);
	if (view.approval) styled([{ text: "- 승인됨", tone: "success" }, { text: ` · ${isoText(view.approval.approvedAt)}` }], undefined, approvalIcon);
	else if (c.status === "ok") styled([{ text: "- 미승인", tone: "warning" }, { text: " — /storm 으로 승인하세요" }], undefined, approvalIcon);
	else styled([{ text: "- 미승인", tone: "warning" }], undefined, approvalIcon);
	if (view.autoDelegation !== undefined) {
		const auto = view.autoDelegation;
		styled(
			[
				{ text: "- 자동 위임: " },
				{ text: autoStatusText(view), tone: auto === "on" ? "success" : auto === "blocked" ? "warning" : "muted" },
				{ text: " · /storm auto" },
			],
			undefined,
			auto === "on" ? "status.success" : auto === "blocked" ? "status.warning" : "status.info",
		);
	}
	if (c.status === "ok") {
		const team = c.config;
		out.push("");
		heading("역할별 모델");
		for (const [id, r] of Object.entries(team.roles)) out.push(roleLine(id, r));
		if (team.disabledRoles?.length) out.push(`- 사용 안 함: ${disabledTitles(team)}`);
		out.push("");
		heading("실행 설정");
		out.push(
			`- 격리: ${ISOLATION[team.isolation]}`,
			`- 추가 라운드: ${team.rounds ?? DEFAULT_EXTRA_ROUNDS}`,
			`- 컨텍스트 상한: ${int(team.contextCap ?? DEFAULT_CONTEXT_CAP)} 토큰`,
			`- 예산: ${team.budget ? budgetText(team.budget) : "없음"}`,
			`- 실행 중 다른 에이전트: ${visible(fallbackText(team.fallbackRole))}`,
			`- 실행이 끝나면 정리: ${team.cleanup === true ? "켬" : "끔"} · 문서 정합: ${team.docs === false ? "끔" : "켬"}`,
		);
		// The checks are an obligation only when they exist; "없음" is ordinary and stays quiet.
		const checks = team.requiredChecks ?? [];
		styled(
			checks.length
				? [
						{ text: "- 필수 검사: " },
						...checks.flatMap((check, index): InfoSpan[] => [
							...(index > 0 ? [{ text: " · " }] : []),
							{ text: checkText(check), tone: "accent" },
						]),
					]
				: [{ text: "- 필수 검사: " }, { text: "없음", tone: "muted" }],
			undefined,
			checks.length ? "status.info" : undefined,
		);
		if (team.jobs?.length) out.push(`- 정형 작업: ${team.jobs.map(job => job.name).join(" · ")}`);
	}
	if (model) {
		runSection();
		lastRunSection();
	}
	if (view.trials?.length) {
		out.push("");
		heading("시험 사용", "runtime", "status.pending");
		for (const t of view.trials) out.push(...trialViewLines(t));
	}
	if (view.quotaMarks?.length) {
		out.push("");
		heading("쿼터 소진 표시", "runtime", "status.warning");
		for (const m of view.quotaMarks) {
			styled(
				[
					{ text: "- ", tone: "muted" },
					{ text: visible(m.provider), tone: "warning" },
					{ text: `: ${isoText(m.until)}까지 다른 Provider 우선`, tone: "warning" },
				],
				undefined,
				"status.warning",
			);
		}
	}
	if (view.agents?.length) {
		out.push("");
		heading("서브에이전트", "runtime", "status.running");
		const agents = agentRows(view.agents, c.status === "ok" ? c.config : undefined);
		if (model) out.push(...renderAgentRows(agents, now).split("\n"));
		else for (const agent of agents) for (const spans of agentStatusSpans(agent, now)) styled(spans);
	}
	if (audience === "user" && view.ompAdvice?.length) {
		out.push("");
		heading("omp 설정 점검", "runtime", "status.warning");
		for (const a of view.ompAdvice) {
			const messageIndex = out.length;
			out.push(`- ${visible(a.message)}`, ...(a.command ? [`  - \`${visible(a.command)}\``] : []));
			if (info) info.push({ index: messageIndex, spans: [{ text: `- ${visible(a.message)}`, tone: "warning" }], icon: "status.warning" });
		}
		out.push("- Storm 은 omp 설정을 바꾸지 않습니다. 필요하면 위 명령을 직접 실행하세요.");
	}
	if (view.quota) {
		out.push("");
		heading("쿼터", "runtime", "status.info");
		if (!view.quota.length) out.push(`- ${DASH}`);
		for (const q of view.quota) {
			styled(
				[
					{ text: "- " },
					{ text: visible(q.provider) },
					{ text: ": " },
					{ text: QUOTA[q.state], tone: QUOTA_TONE[q.state] },
					{ text: ` · 사용 ${pct(q.usedFraction)}${q.resetsAt != null ? ` · 재설정 ${time(q.resetsAt)}` : ""}` },
				],
				undefined,
				QUOTA_ICON[q.state],
			);
		}
	}
	if (view.dataAsOf !== undefined) {
		out.push("");
		heading("사용 데이터", "runtime", "status.info");
		styled([{ text: `- 기준 시각: ${time(view.dataAsOf)} (${age(view.dataAsOf, now)})`, tone: "muted" }]);
	}
	if (view.storageDetail?.length) {
		out.push("");
		heading("저장 공간", "storage");
		for (const line of view.storageDetail) {
			styled([{ text: `- ${line.text}`, tone: line.warning === true ? "warning" : "muted" }], undefined, line.warning === true ? "status.warning" : undefined);
		}
	} else if (view.storage !== undefined) {
		out.push("");
		heading("저장 공간", "storage");
		styled([{ text: `- ${view.storage}`, tone: "muted" }]);
	}
	if (audience === "user") {
		const b = c.status === "ok" ? c.config.budget : undefined;
		out.push("");
		heading("하드 예산 상한", "runtime", "status.info");
		out.push(
			b
				? `- Storm 예산은 새 스폰만 막습니다. 하드 상한은 \`omp --max-cost ${b.perRunUsd}\` 또는 \`session.maxCost\`로 거세요.`
				: "- 하드 상한은 `omp --max-cost <USD>` 또는 `session.maxCost`로 거세요.",
		);
	}
	const shadows = shadowLines(view.shadows, audience === "user");
	if (shadows.length) {
		out.push("");
		const index = out.length;
		out.push(...shadows);
		if (info) {
			const start = sectionStart("runtime");
			info.push({
				index,
				spans: [{ text: shadows[0]!.replace(/^### /, ""), tone: "warning" }],
				emphasis: "title",
				icon: "status.warning",
				...(start ? { section: start } : {}),
			});
			for (let i = 1; i < shadows.length; i++) info.push({ index: index + i, spans: [{ text: shadows[i]!, tone: "warning" }] });
		}
	}
	return out.join("\n");
}

/**
 * The status in a few lines, for the panel above the /storm menu; `/storm status` shows the whole team setting and
 * every section. `info` indexes this same Markdown, and `resume` is the caller's trusted resume candidate.
 */
export function renderStatusBrief(view: StatusView, now: number, info?: InfoLine[], resume = false): string {
	const out: string[] = [];
	// The hub has the same first line as the full user report: present state, then the next action when there is one.
	pushStatusHead(out, info, statusState(view, resume, false), view.newerVersion);
	const c = view.config;
	out.push("");
	if (view.run) {
		const run = view.run;
		const spend = spendText(run.costUsd, run.budget);
		const index = out.length;
		out.push(`- 실행 중: ${run.runId} · ${spend}`);
		if (info) {
			const tone = spendTone(run);
			const meter = runMeter(run);
			info.push({
				index,
				icon: "status.running",
				spans: [
					{ text: "- 실행 중: " },
					{ text: visible(run.runId), tone: "accent" },
					{ text: ` · ${spend}`, ...(tone ? { tone } : {}) },
				],
				...(meter ? { meter } : {}),
			});
		}
		const outcome = resultProgress(run);
		const outcomeLine = resultLine(outcome);
		if (outcomeLine !== undefined) {
			const resultIndex = out.length;
			out.push(outcomeLine.text);
			if (info) info.push({ index: resultIndex, icon: outcomeLine.icon, spans: outcomeLine.spans });
		}
		const progress = runProgressParts(run, now);
		const progressIndex = out.length;
		out.push(`- ${progress.join(" · ")}`);
		if (info) {
			info.push({
				index: progressIndex,
				spans: [
					{ text: "- " },
					{ text: progress[0]!, tone: "accent" },
					{ text: ` · ${progress.slice(1).join(" · ")}` },
				],
			});
		}
		if (run.plan) {
			const isolated = isolationLaneLines(run.plan, run);
			if (isolated.length) out.push(...isolated);
			const note = isolationNote(run.plan);
			if (note !== undefined) out.push(note);
		}
		const agents = run.agents;
		if (agents !== undefined && agents.some(agent => (agent.review?.reviews ?? 0) > 0)) out.push(reviewLine(agents));
	}
	if (view.lastRun) {
		const run = view.lastRun;
		const index = out.length;
		out.push(`- 마지막 실행: ${visible(run.runId)} · ${STATUS_LABEL[run.status]} · ${spendText(run.costUsd, run.budget)}`);
		if (info) {
			const spend = spendTone(run);
			info.push({
				index,
				icon: RUN_ICON[runTone(run)],
				spans: [
					{ text: "- 마지막 실행: " },
					{ text: visible(run.runId), tone: "accent" },
					{ text: " · " },
					{ text: STATUS_LABEL[run.status], tone: runTone(run) },
					{ text: ` · ${spendText(run.costUsd, run.budget)}`, ...(spend ? { tone: spend } : {}) },
				],
			});
		}
		const outcome = resultProgress(run);
		const outcomeLine = resultLine(outcome, { prefix: "마지막 " });
		if (outcomeLine !== undefined) {
			const resultIndex = out.length;
			out.push(outcomeLine.text);
			if (info) info.push({ index: resultIndex, icon: outcomeLine.icon, spans: outcomeLine.spans });
		}
	}
	const team = c.status === "ok" ? `팀 설정 ${shortHash(c.hash)}` : c.status === "missing" ? "팀 설정 없음" : "팀 설정 오류";
	const approval = view.approval ? "승인됨" : "미승인";
	const teamIcon: InfoLine["icon"] = view.approval ? "status.success" : c.status === "invalid" ? "status.error" : "status.warning";
	const teamIndex = out.length;
	// The auto state is an independent action row in the menu; this line keeps only the team hash and its approval.
	out.push(`- ${team} · ${approval}`);
	if (info) {
		info.push({
			index: teamIndex,
			icon: teamIcon,
			spans: [
				{ text: `- ${team} · ` },
				{ text: approval, tone: view.approval ? "success" : c.status === "invalid" ? "error" : "warning" },
			],
		});
	}
	const notes: Array<{ text: string; tone?: InfoTone }> = [];
	if (view.trials?.length) notes.push({ text: `시험 사용 ${view.trials.length}건`, tone: "accent" });
	if (view.quotaMarks?.length) notes.push({ text: `쿼터 소진 표시 ${view.quotaMarks.map((m) => m.provider).join(", ")}`, tone: "warning" });
	if (view.ompAdvice?.length) notes.push({ text: `omp 설정 점검 ${view.ompAdvice.length}건`, tone: "warning" });
	if (notes.length) {
		const noteIndex = out.length;
		out.push(`- 확인할 것: ${notes.map((note) => note.text).join(" · ")}`);
		if (info) {
			const warning = notes.some((note) => note.tone === "warning");
			info.push({
				index: noteIndex,
				icon: warning ? "status.warning" : "status.info",
				spans: [
					{ text: "- 확인할 것: " },
					...notes.flatMap((note, index): InfoSpan[] => [
						...(index > 0 ? [{ text: " · " }] : []),
						{ text: note.text, ...(note.tone ? { tone: note.tone } : {}) },
					]),
				],
			});
		}
	}
	return out.join("\n");
}

/** One trial with its measured comparison, for the decision that follows it. */
export function renderTrial(view: TrialView): string {
	return trialViewLines(view).join("\n");
}

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

/** At or past the warning threshold, or over the hard run budget: only then is spend colored. */
function spendTone(run: RunRecord): InfoTone | undefined {
	const budget = run.budget;
	if (!budget || !Number.isFinite(run.costUsd) || !Number.isFinite(budget.perRunUsd) || budget.perRunUsd <= 0) return undefined;
	if (run.costUsd > budget.perRunUsd) return "error";
	const warnAt = budget.warnAtUsd;
	if (warnAt != null && Number.isFinite(warnAt) && warnAt > 0 && run.costUsd >= warnAt) return "warning";
	return undefined;
}

/** Spend over the recorded run budget; never a meter for no (or zero) budget, and never a fraction outside 0..1. */
function runMeter(run: RunRecord): InfoLine["meter"] {
	const budget = run.budget;
	if (!budget || !Number.isFinite(run.costUsd) || run.costUsd < 0) return undefined;
	if (!Number.isFinite(budget.perRunUsd) || budget.perRunUsd <= 0) return undefined;
	const fraction = Math.min(1, Math.max(0, run.costUsd / budget.perRunUsd));
	return { fraction, tone: spendTone(run) ?? "accent" };
}

/** Success only where a review verified the changes; an ended run (no changes, quick-only, no reviewer) is muted. */
function runTone(run: RunRecord): InfoTone {
	if (run.status === "done" && (run.endReason === undefined || run.endReason === "verified")) return "success";
	if (run.status === "budget-exceeded") return "error";
	if (run.status === "running") return "accent";
	return "muted";
}

/** A run's badge icon follows its established tone; unverified and settling runs stay neutral. */
const RUN_ICON: Record<InfoTone, NonNullable<InfoLine["icon"]>> = {
	accent: "status.running",
	success: "status.success",
	warning: "status.warning",
	error: "status.error",
	muted: "status.info",
};

/** The run line's Markdown, as spans: run id, start time, then spend colored by threshold/overage. */
function runLineSpans(run: RunRecord): InfoSpan[] {
	const tone = spendTone(run);
	return [
		{ text: "- " },
		{ text: visible(run.runId), tone: "accent" },
		{ text: ` · 시작 ${isoText(run.startedAt)} · ` },
		{ text: spendText(run.costUsd, run.budget), ...(tone ? { tone } : {}) },
	];
}

/** The first line of `lastRunLines`, with the result badge in its verified/unverified tone. */
function lastRunLineSpans(run: RunRecord): InfoSpan[] {
	const tone = spendTone(run);
	return [
		{ text: "- " },
		{ text: visible(run.runId), tone: "accent" },
		{ text: " · " },
		{ text: STATUS_LABEL[run.status], tone: runTone(run) },
		{ text: " · " },
		{ text: spendText(run.costUsd, run.budget), ...(tone ? { tone } : {}) },
	];
}

/** The live widget and panels share the plain counters; the status line adds only its own ASCII prefix. */
export function runStatusCounters(run: RunRecord, now: number): string {
	return runStatusParts(run, now).join(" · ");
}

/** Plain fallback shows the same grounded result focus before the counters. */
export function runStatusText(run: RunRecord, now: number): string {
	const results = resultProgress(run);
	const headline = results.present ? `결과 ${results.headline} · ` : "";
	return `storm ▶ ${headline}${runStatusCounters(run, now)}`;
}

/** The head of the stored request (what resuming will send), why it stopped, its rounds and when. */
export function resumeRunLine(run: RunRecord): string {
	const request = visible((run.request ?? "").split(/\r?\n/)[0] ?? "").trim();
	const head = request.length > 80 ? `${request.slice(0, 80)}…` : request;
	const turns = run.turns ?? 0;
	const rounds = run.maxRounds === undefined ? `${turns}라운드` : `${turns}/${run.maxRounds}라운드`;
	const end = run.endReason !== undefined ? endLabel(run.endReason) : STATUS_LABEL[run.status];
	return `- 이어 갈 실행: ${head} · ${end} · ${rounds} · ${isoText(run.endedAt ?? run.updatedAt ?? run.startedAt)}`;
}

function lastRunLines(run: RunRecord, details: boolean): string[] {
	const counts = new Map<SpawnRecord["outcome"], number>();
	for (const s of run.spawns) counts.set(s.outcome, (counts.get(s.outcome) ?? 0) + 1);
	const spawns = counts.size
		? (Object.keys(OUTCOME) as Array<SpawnRecord["outcome"]>)
				.filter((o) => counts.has(o))
				.map((o) => `${OUTCOME[o]} ${counts.get(o)}`)
				.join(", ")
		: "없음";
	const out = [`- ${visible(run.runId)} · ${STATUS_LABEL[run.status]} · ${spendText(run.costUsd, run.budget)}`];
	// The official result disposition leads a settled run; spawn receipts and plan shape follow it.
	const progress = resultProgress(run);
	const outcome = resultLine(progress, { detailed: details });
	if (outcome !== undefined) out.push(outcome.text);
	if (details) for (const row of progress.rows) out.push(`- ${resultRowText(row, { includeScope: true })}`);
	out.push(`- 스폰: ${spawns}`);
	// An exception lane row already names the refusal of that exact spawn; only another block adds a reason here.
	const isolated = isolationRowSpawns(run.plan, run);
	const blocked = run.spawns.find((s) => s.outcome === "blocked" && s.reason && !isolated.has(s));
	if (blocked?.reason) out.push(`- 첫 차단: ${visible(blocked.agent)} · ${visible(blocked.reason)}`);
	if (run.plan) {
		out.push(`- 계획: 레인 ${run.plan.lanes.length} (${planCounts(run.plan)})`);
		const isolatedLanes = isolationLaneLines(run.plan, run);
		const note = isolationNote(run.plan);
		if (isolatedLanes.length) out.push(...isolatedLanes);
		if (note !== undefined) out.push(note);
	}
	if (run.spawns.length > 0) out.push(reviewLine(run.agents ?? []));
	if (Array.isArray(run.checks) && run.checks.length) {
		const checks = run.checks
			.slice(0, 16)
			.filter(check => check && typeof check.name === "string" && typeof check.status === "string")
			.map(check => `${visible(check.name)}: ${check.status === "passed" ? "통과" : visible(check.status)}${typeof check.exitCode === "number" ? ` (exit ${check.exitCode})` : ""}`);
		if (checks.length) out.push(`- 검사 결과: ${checks.join(" · ")}`);
	}
	return out;
}

/** Lanes per role of a run plan: "구현 2, 리뷰 1". */
export function planCounts(plan: RunPlan): string {
	const counts = new Map<string, number>();
	for (const l of plan.lanes) counts.set(l.role, (counts.get(l.role) ?? 0) + 1);
	return [...counts].map(([role, n]) => `${roleTitle(role)} ${n}`).join(", ");
}

/** A lane's separate-checkout reason; a stored plan is repository data, so only a named lane with a non-empty string counts. */
function laneIsolationReason(lane: RunPlan["lanes"][number]): string | undefined {
	if (typeof lane?.name !== "string") return undefined;
	const reason = typeof lane.isolationReason === "string" ? lane.isolationReason.trim() : "";
	return reason === "" ? undefined : reason;
}

/** The latest spawn of each lane: the one an isolation row reports and the block dedup must match. */
function latestLaneSpawns(run: RunRecord): ReadonlyMap<string, SpawnRecord> {
	const latest = new Map<string, SpawnRecord>();
	for (const spawn of run.spawns) {
		if (spawn.lane !== undefined) latest.set(spawn.lane, spawn);
	}
	return latest;
}

/** The exact blocked spawns whose refusal an exception isolation row already shows; another spawn is not covered. */
function isolationRowSpawns(plan: RunPlan | undefined, run: RunRecord): ReadonlySet<SpawnRecord> {
	const shown = new Set<SpawnRecord>();
	if (plan === undefined) return shown;
	const latest = latestLaneSpawns(run);
	for (const lane of plan.lanes) {
		if (laneIsolationReason(lane) === undefined) continue;
		const spawn = latest.get(lane.name);
		if (spawn?.outcome === "blocked") shown.add(spawn);
	}
	return shown;
}

/**
 * The status lines for lanes whose plan keeps their work outside the parent tree. An ordinary plan adds none: sharing
 * the checkout is the default and is not worth a row. A lane is named with its reason and what actually happened,
 * because a plan alone never means a worker started; a refused isolated spawn is named as refused, not as shared.
 */
export function isolationLaneLines(plan: RunPlan, run?: RunRecord): string[] {
	const lanes = plan.lanes.flatMap(lane => {
		const reason = laneIsolationReason(lane);
		return reason === undefined ? [] : [{ lane, reason }];
	});
	const latest = run === undefined ? undefined : latestLaneSpawns(run);
	return lanes.map(({ lane, reason }) => {
		const spawn = latest?.get(lane.name);
		const refusal = spawn?.reason?.trim();
		const state =
			spawn === undefined
				? run === undefined || run.status === "running"
					? "아직 시작 전"
					: "시작하지 않음"
				: spawn.outcome === "blocked"
					? `시작하지 못함: ${visible(refusal ? refusal : "이유가 기록되지 않았습니다")}`
					: "분리 체크아웃에서 시작함";
		return `- 격리 레인: ${visible(lane.name)} — ${visible(reason)} · ${state}`;
	});
}

/** Keeps a reason-marked lane's separate result from being read as already in this tree or as a branch that merges itself. */
export function isolationNote(plan: RunPlan): string | undefined {
	return plan.lanes.some(lane => laneIsolationReason(lane) !== undefined)
		? "- 격리 레인은 git 브랜치와 별개의 분리 체크아웃이며, 성공해도 그 변경은 이 작업 트리로 자동 반영되지 않습니다."
		: undefined;
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
