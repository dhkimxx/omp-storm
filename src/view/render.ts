import { shortHash } from "../config/canonical.ts";
import { unknownFields } from "../config/schema.ts";
import { formatUsd } from "../policy/spawn.ts";
import { agentRows, renderAgentRows } from "../report/agents.ts";
import { DEFAULT_CONTEXT_CAP, ROLE_AGENT_PREFIX, roleTitle, STORM_VERSION, workerRange } from "../roles.ts";
import { reviewLine } from "../runtime/review.ts";
import { DEFAULT_EXTRA_ROUNDS, endLabel, STATUS_LABEL } from "../runtime/rounds.ts";
import { idleAppearance, RUN_APPEARANCE, STORM_MARK } from "./appearance.ts";
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
function statusState(view: StatusView, resume: boolean): StatusState {
	if (view.run) {
		const phase = view.runPhase ? RUN_APPEARANCE[view.runPhase] : undefined;
		// Without a phase the record's status is all that is known; a phase name is never invented.
		return phase ? { label: phase.label, tone: phase.tone } : { label: "실행 중", tone: runTone(view.run) };
	}
	const team = view.config.status === "missing" ? "missing" : view.config.status === "invalid" ? "invalid" : view.approval ? "approved" : "unapproved";
	const auto = view.autoDelegation === "on" ? "on" : view.autoDelegation === "blocked" ? "blocked" : "off";
	const state = idleAppearance({ team, auto, resume });
	return team === "approved" && auto === "blocked" && view.autoModeProblem !== undefined
		? { ...state, action: visible(view.autoModeProblem) }
		: state;
}

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
				spans: [
					{ text: "- 다음: " },
					{ text: state.action.replaceAll("`", ""), tone: "accent" },
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

/** The round/agents/minutes part of the run details; spend has its own authoritative line and meter. */
function runProgressParts(run: RunRecord, now: number): string[] {
	const parts = [runRoundText(run)];
	const agents = runAgentsText(run);
	if (agents) parts.push(agents);
	const minutes = Math.max(0, Math.floor((now - Date.parse(run.startedAt)) / 60_000));
	parts.push(`${minutes}분`);
	return parts;
}

/** The config file as the user finds it from the project root; the status never shows where that root is. */
const CONFIG_FILE = ".omp/storm/config.json";

/**
 * The whole status. For the user it leads with present state, version and a real next action, then the active and
 * last run, then everything else with the commands that fix what it points out. For the model (the storm tool) it is
 * the same facts without advice the director could act on (omp commands, /restart, cost flags) and without file
 * paths. `info` only adds the TUI's semantic spans for the same Markdown lines; every plain caller ignores it and
 * gets byte-for-byte the same text.
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
	/** A section title: the Markdown keeps `### …`; the rich line carries only the visible title. */
	const heading = (title: string): void => {
		const index = out.length;
		out.push(`### ${title}`);
		if (info) info.push({ index, spans: [{ text: visible(title), tone: "accent" }] });
	};
	/** A list line built from `spans`, so its Markdown and rich text cannot drift apart. */
	const styled = (spans: readonly InfoSpan[], meter?: InfoLine["meter"]): void => {
		const safe = spans.map((span) => (span.tone ? { text: visible(span.text), tone: span.tone } : { text: visible(span.text) }));
		const index = out.length;
		out.push(safe.map((span) => span.text).join(""));
		if (info) info.push({ index, spans: safe, ...(meter ? { meter } : {}) });
	};
	/** Present-state details for the active run: the authoritative spend line, progress, then review totals. */
	const runSection = (): void => {
		const run = view.run;
		if (!run) return;
		out.push("");
		heading("실행 중");
		styled(runLineSpans(run), runMeter(run));
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
		const agents = run.agents;
		if (agents !== undefined && agents.some(agent => (agent.review?.reviews ?? 0) > 0)) out.push(reviewLine(agents));
	};
	/** The last finished run is read after the active one and before the team setting. */
	const lastRunSection = (): void => {
		const run = view.lastRun;
		if (!run) return;
		out.push("");
		heading("마지막 실행");
		const lines = lastRunLines(run);
		const index = out.length;
		out.push(...lines);
		if (info) {
			const meter = runMeter(run);
			info.push({ index, spans: lastRunLineSpans(run), ...(meter ? { meter } : {}) });
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
	heading("팀 설정");
	if (c.status === "missing") styled([{ text: "- 없음 — /storm 으로 만드세요", tone: "warning" }]);
	else if (c.status === "invalid") {
		styled([{ text: `- 오류 (\`${CONFIG_FILE}\`)`, tone: "error" }]);
		for (const e of c.errors) styled([{ text: `  - ${visible(e)}`, tone: "error" }]);
	} else {
		styled([
			{ text: "- 정상", tone: "accent" },
			{ text: ` · ${shortHash(c.hash)} · 우선순위 ${priorityLabel(c.config.priority)}` },
		]);
	}
	out.push("");
	heading("승인");
	if (view.approval) styled([{ text: "- 승인됨", tone: "success" }, { text: ` · ${isoText(view.approval.approvedAt)}` }]);
	else if (c.status === "ok") styled([{ text: "- 미승인", tone: "warning" }, { text: " — /storm 으로 승인하세요" }]);
	else styled([{ text: "- 미승인", tone: "warning" }]);
	if (view.autoDelegation !== undefined) {
		const auto = view.autoDelegation;
		styled([
			{ text: "- 자동 위임: " },
			{ text: auto === "on" ? "켜짐" : auto === "blocked" ? (view.autoModeProblem === undefined ? "켜짐 · 팀 승인 대기" : "켜짐 · 실행 차단") : "꺼짐", tone: auto === "on" ? "success" : auto === "blocked" ? "warning" : "muted" },
			{ text: " · /storm auto" },
		]);
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
			`- 병렬도: ${team.parallelism} · ${ISOLATION[team.isolation]}`,
			`- 추가 라운드: ${team.rounds ?? DEFAULT_EXTRA_ROUNDS}`,
			`- 컨텍스트 상한: ${int(team.contextCap ?? DEFAULT_CONTEXT_CAP)} 토큰`,
			`- 예산: ${team.budget ? budgetText(team.budget) : "없음"}`,
			`- 실행 중 다른 에이전트: ${visible(fallbackText(team.fallbackRole))}`,
			`- 실행이 끝나면 정리: ${team.cleanup === true ? "켬" : "끔"} · 문서 정합: ${team.docs === false ? "끔" : "켬"}`,
			`- 필수 검사: ${team.requiredChecks?.length ? team.requiredChecks.map(checkText).join(" · ") : "없음"}`,
		);
	}
	if (model) {
		runSection();
		lastRunSection();
	}
	if (view.trials?.length) {
		out.push("");
		heading("시험 사용");
		for (const t of view.trials) out.push(...trialViewLines(t));
	}
	if (view.quotaMarks?.length) {
		out.push("");
		heading("쿼터 소진 표시");
		for (const m of view.quotaMarks) {
			styled([
				{ text: "- ", tone: "muted" },
				{ text: visible(m.provider), tone: "warning" },
				{ text: `: ${isoText(m.until)}까지 다른 Provider 우선`, tone: "warning" },
			]);
		}
	}
	if (view.agents?.length) {
		out.push("");
		heading("서브에이전트");
		out.push(...renderAgentRows(agentRows(view.agents, c.status === "ok" ? c.config : undefined), now).split("\n"));
	}
	if (audience === "user" && view.ompAdvice?.length) {
		out.push("");
		heading("omp 설정 점검");
		for (const a of view.ompAdvice) out.push(`- ${visible(a.message)}`, ...(a.command ? [`  - \`${visible(a.command)}\``] : []));
		out.push("- Storm 은 omp 설정을 바꾸지 않습니다. 필요하면 위 명령을 직접 실행하세요.");
	}
	if (view.quota) {
		out.push("");
		heading("쿼터");
		if (!view.quota.length) out.push(`- ${DASH}`);
		for (const q of view.quota) {
			styled([
				{ text: "- " },
				{ text: visible(q.provider) },
				{ text: ": " },
				{ text: QUOTA[q.state], tone: QUOTA_TONE[q.state] },
				{ text: ` · 사용 ${pct(q.usedFraction)}${q.resetsAt != null ? ` · 재설정 ${time(q.resetsAt)}` : ""}` },
			]);
		}
	}
	if (view.dataAsOf !== undefined) {
		out.push("");
		heading("사용 데이터");
		styled([{ text: `- 기준 시각: ${time(view.dataAsOf)} (${age(view.dataAsOf, now)})`, tone: "muted" }]);
	}
	if (view.storageDetail?.length) {
		out.push("");
		heading("저장 공간");
		for (const line of view.storageDetail) styled([{ text: `- ${line}`, tone: "muted" }]);
	} else if (view.storage !== undefined) {
		out.push("");
		heading("저장 공간");
		styled([{ text: `- ${view.storage}`, tone: "muted" }]);
	}
	if (audience === "user") {
		const b = c.status === "ok" ? c.config.budget : undefined;
		out.push("");
		heading("하드 예산 상한");
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
			info.push({ index, spans: [{ text: shadows[0]!.replace(/^### /, ""), tone: "warning" }] });
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
	pushStatusHead(out, info, statusState(view, resume), view.newerVersion);
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
				spans: [
					{ text: "- 실행 중: " },
					{ text: visible(run.runId), tone: "accent" },
					{ text: ` · ${spend}`, ...(tone ? { tone } : {}) },
				],
				...(meter ? { meter } : {}),
			});
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
		const agents = run.agents;
		if (agents !== undefined && agents.some(agent => (agent.review?.reviews ?? 0) > 0)) out.push(reviewLine(agents));
	} else if (view.lastRun) {
		out.push(`- 마지막 실행: ${view.lastRun.runId} · ${STATUS_LABEL[view.lastRun.status]} · ${spendText(view.lastRun.costUsd, view.lastRun.budget)}`);
	}
	if (c.status === "ok") {
		if (view.run) out.push("");
		out.push(`- 팀 설정 ${shortHash(c.hash)} · ${view.approval ? "승인됨" : "미승인"} · 우선순위 ${priorityLabel(c.config.priority)}`);
		for (const [id, r] of Object.entries(c.config.roles)) out.push(roleLine(id, r));
		out.push(`- 컨텍스트 상한 ${int(c.config.contextCap ?? DEFAULT_CONTEXT_CAP)} 토큰`);
		if (c.config.disabledRoles?.length) out.push(`- 사용 안 함: ${disabledTitles(c.config)}`);
	} else out.push(c.status === "missing" ? "- 팀 설정 없음" : "- 팀 설정 오류");
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

/** The status line while a run is on: the round in progress, its agents, spend against the budget, and whole minutes. */
export function runStatusText(run: RunRecord, now: number): string {
	return `storm ▶ ${runStatusCounters(run, now)}`;
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

function lastRunLines(run: RunRecord): string[] {
	const counts = new Map<SpawnRecord["outcome"], number>();
	for (const s of run.spawns) counts.set(s.outcome, (counts.get(s.outcome) ?? 0) + 1);
	const spawns = counts.size
		? (Object.keys(OUTCOME) as Array<SpawnRecord["outcome"]>)
				.filter((o) => counts.has(o))
				.map((o) => `${OUTCOME[o]} ${counts.get(o)}`)
				.join(", ")
		: "없음";
	const out = [`- ${visible(run.runId)} · ${STATUS_LABEL[run.status]} · ${spendText(run.costUsd, run.budget)}`, `- 스폰: ${spawns}`];
	const blocked = run.spawns.find((s) => s.outcome === "blocked" && s.reason);
	if (blocked?.reason) out.push(`- 첫 차단: ${visible(blocked.agent)} · ${visible(blocked.reason)}`);
	if (run.plan) out.push(`- 계획: 레인 ${run.plan.lanes.length} (${planCounts(run.plan)})`);
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
