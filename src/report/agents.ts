/**
 * Subagent lifecycle advice: reuse a finished agent (warm cache, context already loaded), hand new
 * work to a fresh one with a summary, or leave it to omp's idle park. Pure; Storm never changes omp
 * settings. Past an agent's context cap Storm blocks follow-ups during a run, and the advice says so.
 */
import { contextCapFor } from "../roles.ts";
import type { AgentAdvice, AgentEntry, AgentLiveState, LifecycleSettings, ModelCost, StormConfig } from "../types.ts";

/** omp's `task.agentIdleTtlMs` default. */
export const DEFAULT_IDLE_TTL_MS = 420_000;
/** Reuse only while at least this much cache time is left: the follow-up still has to be written and sent. */
export const REUSE_MARGIN_MS = 60_000;
/** Reuse only while the context is at most this share of the window. */
export const REUSE_MAX_CONTEXT_SHARE = 0.4;
/** Above this share of the window compaction is close: always start fresh. */
export const COMPACTION_SHARE = 0.7;
/** With an expired cache, contexts at least this big are worth replacing with a summary. */
export const FRESH_MIN_TOKENS = 20_000;
/** A cache window this many times the idle TTL is worth a longer TTL. */
export const LONG_CACHE_FACTOR = 3;

const MIN = 60_000;
const HOUR = 3_600_000;

export function cacheWindow(provider: string, settings: LifecycleSettings): { ms: number; estimated: boolean; source: string } {
	const unread = settings.cacheRetention === undefined;
	const retention = settings.cacheRetention ?? "auto";
	const assumed = unread ? " · 설정을 읽지 못해 auto로 가정" : "";
	if (retention === "none") return { ms: 0, estimated: false, source: "cacheRetention=none: 캐시 꺼짐" };
	const long = retention === "long";
	if (provider === "anthropic") {
		return long
			? { ms: HOUR, estimated: false, source: `Anthropic long: 1시간${assumed}` }
			: { ms: 5 * MIN, estimated: true, source: `Anthropic 기본: API 키 5분(추정, OAuth면 1시간일 수 있음)${assumed}` };
	}
	if (provider === "openai") {
		return long
			? { ms: 12 * HOUR, estimated: false, source: `OpenAI Responses long: 12시간${assumed}` }
			: { ms: 30 * MIN, estimated: false, source: `OpenAI Responses 기본: 30분${assumed}` };
	}
	return { ms: 5 * MIN, estimated: true, source: `${provider || "모델 미상"}: 알려지지 않음, 5분으로 추정${assumed}` };
}

/** "provider" of a "provider/model" (the part before the first "/"); "" when unknown. */
function providerOf(model: string | undefined): string {
	if (!model) return "";
	const i = model.indexOf("/");
	return i < 0 ? "" : model.slice(0, i);
}

export function tokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export function duration(ms: number): string {
	if (ms < MIN) return `${Math.max(0, Math.round(ms / 1000))}초`;
	if (ms < HOUR) return `${Math.round(ms / MIN)}분`;
	const h = ms / HOUR;
	return `${Number.isInteger(h) ? h : h.toFixed(1)}시간`;
}

function share(e: AgentEntry): number | undefined {
	return e.contextWindow && e.contextWindow > 0 ? e.contextTokens / e.contextWindow : undefined;
}

function contextText(e: AgentEntry): string {
	const s = share(e);
	return s === undefined ? `${tokens(e.contextTokens)} 토큰` : `${tokens(e.contextTokens)} 토큰(창의 ${Math.round(s * 100)}%)`;
}

const LEAVE_IT =
	"그대로 두어도 잃을 것이 없습니다. omp 가 유휴 TTL 뒤 자동으로 보관(park)하고, 보관된 에이전트는 기록만 들고 있습니다.";

export interface AdviceInput {
	now: number;
	settings: LifecycleSettings;
	cost?: (model: string) => ModelCost | undefined;
	/** The approved team: agents at or past their context cap (`contextCapFor`) are always fresh. */
	config?: StormConfig;
}

export function adviseAgents(entries: AgentEntry[], input: AdviceInput): AgentAdvice[] {
	return entries.map((e) => {
		const id = e.id;
		if (e.state === "running") return { id, action: "busy", reason: "작업 중" };
		const cap = input.config ? contextCapFor(input.config, e.role, e.contextWindow) : undefined;
		if (cap !== undefined && e.contextTokens >= cap) {
			return {
				id,
				action: "fresh",
				reason: `컨텍스트 ${contextText(e)}이 상한 ${tokens(cap)} 토큰에 닿아 Storm 실행 중에는 후속 지시가 막힙니다. 새 에이전트에 이전 결과 요약을 넘기세요.`,
			};
		}
		const s = share(e);
		if (s !== undefined && s > COMPACTION_SHARE) {
			return {
				id,
				action: "fresh",
				reason: `컨텍스트가 창의 ${Math.round(s * 100)}%로 압축(compaction)이 가깝습니다. 새 에이전트에 이전 결과 요약을 넘기세요.`,
			};
		}
		const window = cacheWindow(providerOf(e.model), input.settings);
		const left = window.ms - (input.now - e.lastActivityAt);
		const est = window.estimated ? "(추정)" : "";
		if (left > REUSE_MARGIN_MS) {
			if (s === undefined || s <= REUSE_MAX_CONTEXT_SHARE) {
				return {
					id,
					action: "reuse",
					reason: `캐시 약 ${duration(left)} 남음${est} · 컨텍스트 ${contextText(e)}. 같은 영역의 후속 작업은 이 에이전트에 보내세요.`,
					handle: `agent://${id}`,
				};
			}
			return {
				id,
				action: "fresh",
				reason: `컨텍스트가 창의 ${Math.round(s * 100)}%로 큽니다. 새 에이전트에 이전 결과 요약을 넘기는 편이 가볍습니다.`,
			};
		}
		const expired = window.ms === 0 ? "캐시 꺼짐(cacheRetention=none)" : `캐시 만료${est}`;
		if (e.state === "parked") return { id, action: "cleanup", reason: `보관됨, ${expired}. ${LEAVE_IT}` };
		if (e.contextTokens >= FRESH_MIN_TOKENS) {
			const price = e.model ? input.cost?.(e.model) : undefined;
			// Without a cache the follow-up pays the input price instead of the cache-write price.
			const perM = price ? (window.ms === 0 ? price.input : price.cacheWrite) : undefined;
			const usd = perM !== undefined ? `(약 $${((e.contextTokens * perM) / 1e6).toFixed(4)})` : "";
			const verb = window.ms === 0 ? "다시 읽습니다" : "캐시에 다시 씁니다";
			return {
				id,
				action: "fresh",
				reason: `${expired}: 후속 메시지는 컨텍스트 ${tokens(e.contextTokens)} 토큰을 ${verb}${usd}. 새 에이전트에 이전 결과 요약을 넘기세요.`,
			};
		}
		return { id, action: "cleanup", reason: `${expired}, 컨텍스트 작음(${tokens(e.contextTokens)} 토큰). ${LEAVE_IT}` };
	});
}

/** Each entry with its advice, in the same order (status and the storm tool's agents action). */
export function adviseRows(entries: AgentEntry[], input: AdviceInput): Array<{ entry: AgentEntry; advice: AgentAdvice }> {
	const advice = adviseAgents(entries, input);
	return entries.flatMap((entry, i) => {
		const a = advice[i];
		return a ? [{ entry, advice: a }] : [];
	});
}

const STATE_LABEL: Record<AgentLiveState, string> = { running: "실행 중", idle: "유휴", parked: "보관됨" };
const ACTION_LABEL: Record<AgentAdvice["action"], string> = {
	reuse: "재사용",
	fresh: "새 에이전트",
	cleanup: "정리",
	busy: "작업 중",
};

function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderAgents(rows: Array<{ entry: AgentEntry; advice: AgentAdvice }>, now: number): string {
	if (!rows.length) return "- 이 세션에서 아직 실행된 서브에이전트가 없습니다.";
	const out = ["| 에이전트 | 모델 | 상태 | 유휴 | 컨텍스트 | 후속 | 권장 | 이유 |", "|---|---|---|---|---|---|---|---|"];
	for (const { entry: e, advice: a } of rows) {
		const idle = e.state === "running" ? "—" : duration(now - e.lastActivityAt);
		const s = share(e);
		const ctx = `${tokens(e.contextTokens)}${s === undefined ? "" : ` (${Math.round(s * 100)}%)`}`;
		out.push(
			`| ${cell(`${e.id} (${e.role ?? e.name})`)} | ${cell(e.model ?? "—")} | ${STATE_LABEL[e.state]} | ${idle} | ${ctx} | ${e.followUps} | ${ACTION_LABEL[a.action]} | ${cell(a.reason)} |`,
		);
	}
	out.push("", "- 재사용: `write agent://<id>` 로 후속 지시를 보내거나, eval 에서 받은 핸들의 `.send()` 를 쓰세요.");
	return out.join("\n");
}

/** Distinct providers of a config's role models, in role order. */
export function teamProviders(config: StormConfig): string[] {
	return [...new Set(Object.values(config.roles).flatMap((r) => r.models.map(providerOf)))].filter((p) => p !== "");
}

/** Distinct providers of the agents' last models. */
export function agentProviders(entries: readonly AgentEntry[]): string[] {
	return [...new Set(entries.map((e) => providerOf(e.model)).filter((p) => p !== ""))];
}

export function lifecycleWarnings(settings: LifecycleSettings, providers: readonly string[]): string[] {
	const out: string[] = [];
	const unread: string[] = [];
	if (settings.agentIdleTtlMs === undefined) unread.push("task.agentIdleTtlMs 7분");
	if (settings.cacheRetention === undefined) unread.push("providers.cacheRetention auto");
	if (unread.length) out.push(`omp 설정을 읽지 못해 기본값(${unread.join(", ")})으로 가정합니다.`);
	if (settings.cacheRetention === "none") {
		out.push("providers.cacheRetention=none: 캐시가 꺼져 있어 서브에이전트를 재사용해도 캐시 절감은 없습니다(이미 읽은 맥락만 이어집니다).");
		return out;
	}
	const ttl = settings.agentIdleTtlMs ?? DEFAULT_IDLE_TTL_MS;
	// 0 means omp never parks idle agents.
	const ttlMs = ttl > 0 ? ttl : Number.POSITIVE_INFINITY;
	const ttlText = ttl > 0 ? duration(ttl) : "무제한(0, 보관 안 함)";
	// Providers with the same cache window share one line.
	const groups = new Map<string, { w: ReturnType<typeof cacheWindow>; names: string[] }>();
	for (const provider of new Set(providers)) {
		const w = cacheWindow(provider, settings);
		const key = `${w.ms}:${w.estimated}`;
		const group = groups.get(key);
		if (group) group.names.push(provider);
		else groups.set(key, { w, names: [provider] });
	}
	for (const { w, names } of groups.values()) {
		const who = names.join("·");
		const win = `${duration(w.ms)}${w.estimated ? "(추정)" : ""}`;
		if (ttlMs > w.ms) {
			out.push(`${who}: 유휴 TTL ${ttlText}이 캐시 유지 ${win}보다 깁니다. 그 사이에 재사용하면 컨텍스트 전체를 캐시에 다시 씁니다.`);
		} else if (w.ms >= ttl * LONG_CACHE_FACTOR) {
			out.push(
				`${who}: 캐시 유지 ${win}이 유휴 TTL ${ttlText}보다 훨씬 깁니다. omp 설정 task.agentIdleTtlMs 를 캐시 유지 시간 가까이(${w.ms}) 올리면 보관 전까지 따뜻한 캐시로 재사용할 수 있습니다. Storm 은 omp 설정을 바꾸지 않습니다.`,
			);
		}
	}
	return out;
}

/** The advice table (or a note that none ran yet) plus lifecycle warnings for the team's providers (the agents' without a team). */
export function agentsReport(entries: AgentEntry[], input: AdviceInput): string {
	const body = entries.length ? renderAgents(adviseRows(entries, input), input.now) : "이 세션에서 아직 실행된 서브에이전트가 없습니다.";
	const warnings = lifecycleWarnings(input.settings, input.config ? teamProviders(input.config) : agentProviders(entries));
	return warnings.length ? `${body}\n\n### 수명 관리\n${warnings.map((w) => `- ${w}`).join("\n")}` : body;
}
