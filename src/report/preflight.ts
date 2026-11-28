/**
 * The preflight report: what would refuse a start now, item by item, before anything starts. Every item calls the very
 * predicate the start or the spawn gate refuses with (`teamGate`/`shadowBlock`, `roleCredentialBlock`, the placement's
 * isolation checks, the managed launch's isolation policy, `ompModeBlock`), so the report and the refusal cannot
 * disagree on the same inputs. Storm never changes an omp setting; an item shows the exact command instead.
 */
import type { SessionModeState } from "@oh-my-pi/pi-coding-agent";
import { shortHash } from "../config/canonical.ts";
import type { IsolationPolicySnapshot } from "../discovery/settings.ts";
import { isolationPolicyProblem } from "../discovery/settings.ts";
import type { CredentialProbe } from "../policy/model-check.ts";
import { teamSelectors } from "../policy/model-check.ts";
import { type OmpModeBlock, ompModeBlock } from "../policy/omp-mode.ts";
import { APPROVAL_CHECK, roleCredentialBlock, shadowBlock, stripEffort, teamGate, usableRole } from "../policy/spawn.ts";
import { roleTitle } from "../roles.ts";
import { isolationApplies, isolationOff } from "../runtime/lanes.ts";
import type { ExplicitSettings, SpawnState, StormConfig } from "../types.ts";
import { ompSettingsAdvice } from "./omp-settings.ts";

export interface PreflightItem {
	key: string;
	status: "ok" | "blocked" | "notice";
	label: string;
	detail?: string;
	command?: string;
	/** The mode item only: which omp mode blocks the start, so a plan-mode preview can leave its own mode out. */
	mode?: OmpModeBlock;
}

export interface PreflightReport {
	items: readonly PreflightItem[];
	blocked: number;
}

/** omp's isolation values as the host reads them; an absent field is unknown, never off. */
export type IsolationReading = Partial<Pick<IsolationPolicySnapshot, "enabled" | "apply" | "merge" | "backend" | "commits">>;

export interface PreflightInput {
	/** The session's team as the spawn gate reads it. */
	state: SpawnState;
	/**
	 * The config an open approval dialog would approve. The team item is then left out (the dialog is that approval) and
	 * every other item is decided for this config.
	 */
	proposed?: StormConfig;
	/** What the credential lookups said for the team's selectors; absent = not looked at. */
	credentials?: CredentialProbe;
	isolation: IsolationReading;
	/** The host admits managed private launches (guarded integration): the integration settings then apply. */
	integration: boolean;
	/** omp's session modes; absent = this host has none (print, RPC); "unreadable" = the read threw. */
	modes?: Pick<SessionModeState, "goal" | "loop" | "plan" | "vibe"> | "unreadable";
	/** Effective `task.maxConcurrency`: 0 unlimited, absent unknown. */
	maxConcurrency?: number;
	/** Effective `task.workerThreads`: 0 keeps every subagent on the main thread, absent unknown. */
	workerThreads?: number;
	/** `omp config list` values, for the fallback-chain advice; absent = not read. */
	explicit?: ExplicitSettings;
	/** `process.platform` by default; picks the backend the command names. */
	platform?: string;
}

/** Concurrent subagent runs omp 19.2.1 keeps on the main thread before, with `task.workerThreads` above 0, it may place more on pool threads. */
export const POOL_THREAD_LIMIT = 8;

export const PREFLIGHT_LABEL = {
	team: "팀 승인",
	auth: "역할별 인증",
	isolationEnabled: "격리 켜기 (task.isolation.enabled)",
	isolationApply: "격리 결과 자동 적용 끄기 (task.isolation.apply)",
	integration: "통합 격리 설정",
	mode: "omp 모드",
	pool: "풀 스레드 (task.workerThreads)",
	budget: "실행 예산",
} as const;

export const PREFLIGHT_COMMAND = {
	storm: "/storm",
	isolationEnabled: "omp config set task.isolation.enabled true",
	isolationApply: "omp config set task.isolation.apply false",
	isolationMerge: "omp config set task.isolation.merge patch",
	isolationCommits: "omp config set task.isolation.commits generic",
	pool: "omp config set task.workerThreads 0",
} as const;

/** What a mode item says and the command that leaves the mode. */
const MODE_TEXT: Readonly<Record<"goal" | "loop" | "plan" | "vibe", { detail: string; command: string }>> = {
	goal: { detail: "목표 모드가 켜져 있어 시작하지 않습니다. 목표를 끝내거나 일시 정지하세요.", command: "/goal" },
	loop: { detail: "반복 모드가 켜져 있어 시작하지 않습니다. 반복을 끄세요.", command: "/loop" },
	plan: { detail: "계획 모드가 켜져 있어 실행을 시작하지 않습니다. 계획 모드를 끝내세요.", command: "/plan" },
	vibe: { detail: "vibe 모드가 켜져 있습니다. /storm 으로 시작하면 vibe 모드를 끌지 묻고, 자동 위임은 시작하지 않습니다.", command: "/vibe" },
};

/** The explicit backend a command names: APFS on macOS, a plain copy elsewhere (works on every filesystem). */
function backendCommand(platform: string): string {
	return `omp config set isolation.backend ${platform === "darwin" ? "apfs" : "rcopy"}`;
}

function teamItem(state: SpawnState): PreflightItem {
	const gate = teamGate(state);
	const block = gate.ok ? shadowBlock(state) : gate.block;
	if (block === undefined && gate.ok) return { key: "team", status: "ok", label: PREFLIGHT_LABEL.team, detail: `승인됨(${shortHash(gate.hash)})` };
	const reason = (block?.reason ?? "").replace(` ${APPROVAL_CHECK}`, "");
	return { key: "team", status: "blocked", label: PREFLIGHT_LABEL.team, detail: reason, command: PREFLIGHT_COMMAND.storm };
}

/** The providers of selectors, in first-seen order. */
function providers(selectors: readonly string[]): string[] {
	return [...new Set(selectors.map(selector => selector.split("/")[0] ?? selector))];
}

function authItem(config: StormConfig, credentials: CredentialProbe | undefined): PreflightItem {
	if (credentials === undefined) return { key: "auth", status: "notice", label: PREFLIGHT_LABEL.auth, detail: "로그인 상태를 확인하지 않았습니다." };
	const blocked: string[] = [];
	const missing: string[] = [];
	for (const [key, role] of Object.entries(config.roles)) {
		if (!usableRole(config, key)) continue;
		const block = roleCredentialBlock(role.agent, key, role.models, { authenticated: credentials.ok, slow: credentials.slow });
		if (block) blocked.push(`${roleTitle(key)} 역할(${role.models.map(stripEffort).join(", ")})`);
	}
	for (const selector of teamSelectors(config)) if (!credentials.ok.has(selector.toLowerCase())) missing.push(selector);
	const login = missing.length > 0 ? `/login ${providers(missing).join(" · /login ")}` : undefined;
	if (blocked.length > 0) {
		return {
			key: "auth",
			status: "blocked",
			label: PREFLIGHT_LABEL.auth,
			detail: `승인된 모델이 모두 인증되지 않은 역할: ${blocked.join(", ")}. 이 역할의 워커는 시작하지 않습니다. omp에서 Provider에 로그인하거나 API 키를 설정하세요.`,
			...(login ? { command: login } : {}),
		};
	}
	if (missing.length > 0) {
		return {
			key: "auth",
			status: "notice",
			label: PREFLIGHT_LABEL.auth,
			detail: `인증되지 않은 모델은 빼고 시작합니다: ${missing.join(", ")}`,
			...(login ? { command: login } : {}),
		};
	}
	return { key: "auth", status: "ok", label: PREFLIGHT_LABEL.auth, detail: "모든 역할의 모델이 인증됨" };
}

function isolationItems(config: StormConfig, input: PreflightInput): PreflightItem[] {
	const team = config.isolation === "isolated";
	// A team that says isolated places every worker isolated; a shared team only its reason-marked lanes and isolated items.
	const failing = team ? "blocked" : "notice";
	const scope = team ? "팀 설정이 격리라 워커를 시작하지 않습니다." : "격리 레인과 isolated 항목은 시작하지 않습니다(공유 레인은 그대로 돕니다).";
	const host = input.isolation;
	if (isolationOff(host)) {
		const state = host.enabled === false ? "꺼져 있습니다" : "켜져 있는지 확인하지 못했습니다";
		return [{ key: "task.isolation.enabled", status: failing, label: PREFLIGHT_LABEL.isolationEnabled, detail: `omp 격리가 ${state}. ${scope}`, command: PREFLIGHT_COMMAND.isolationEnabled }];
	}
	const items: PreflightItem[] = [{ key: "task.isolation.enabled", status: "ok", label: PREFLIGHT_LABEL.isolationEnabled, detail: "켜짐" }];
	if (isolationApplies(host)) {
		const state = host.apply === true ? "켜져 있습니다" : "꺼져 있는지 확인하지 못했습니다";
		items.push({
			key: "task.isolation.apply",
			status: failing,
			label: PREFLIGHT_LABEL.isolationApply,
			detail: `격리 결과를 부모 작업 트리에 자동 적용하는 설정이 ${state}. ${scope}`,
			command: PREFLIGHT_COMMAND.isolationApply,
		});
		return items;
	}
	items.push({ key: "task.isolation.apply", status: "ok", label: PREFLIGHT_LABEL.isolationApply, detail: "꺼짐" });
	if (!input.integration) return items;
	const problem = isolationPolicyProblem(host);
	if (problem === undefined) {
		items.push({ key: "integration", status: "ok", label: PREFLIGHT_LABEL.integration, detail: `merge patch · backend ${String(host.backend)}` });
		return items;
	}
	const command =
		problem.code === "isolation-merge-not-patch"
			? PREFLIGHT_COMMAND.isolationMerge
			: problem.code === "isolation-ai-commit-helper"
				? PREFLIGHT_COMMAND.isolationCommits
				: backendCommand(input.platform ?? process.platform);
	items.push({ key: "integration", status: failing, label: PREFLIGHT_LABEL.integration, detail: `${problem.reason} 통합할 격리 실행을 시작하지 않습니다.`, command });
	return items;
}

function modeItem(modes: PreflightInput["modes"]): PreflightItem | undefined {
	if (modes === undefined) return undefined;
	if (modes === "unreadable") return { key: "mode", status: "blocked", label: PREFLIGHT_LABEL.mode, detail: "omp 세션 모드를 확인하지 못했습니다." };
	const on = ompModeBlock(modes);
	if (on === undefined) return { key: "mode", status: "ok", label: PREFLIGHT_LABEL.mode, detail: "plan·goal·loop·vibe 모두 꺼짐" };
	const text = MODE_TEXT[on];
	return { key: "mode", status: on === "vibe" ? "notice" : "blocked", label: PREFLIGHT_LABEL.mode, detail: text.detail, command: text.command, mode: on };
}

/**
 * Whether omp may put a worker on a pool thread, where Storm stops it before its first request (docs/design.md, 0.28.0):
 * only with `task.workerThreads` above 0 and more than `POOL_THREAD_LIMIT` concurrent runs allowed. The remedy is the
 * thread setting; lowering the ceiling also works but caps the team.
 */
function poolItem(limit: number | undefined, threads: number | undefined): PreflightItem {
	const label = PREFLIGHT_LABEL.pool;
	const stops = `omp 19.2.1은 task.workerThreads가 0보다 크면 동시 워커 ${POOL_THREAD_LIMIT}개 이후를 풀 스레드에 둘 수 있고, Storm은 풀 스레드에 놓인 워커를 첫 요청 전에 멈춥니다.`;
	if (threads === 0) return { key: "task.workerThreads", status: "ok", label, detail: "0: 모든 워커가 주 스레드에서 돕니다." };
	if (threads === undefined) return { key: "task.workerThreads", status: "notice", label, detail: `값을 확인하지 못했습니다. ${stops}`, command: PREFLIGHT_COMMAND.pool };
	if (limit !== undefined && limit > 0 && limit <= POOL_THREAD_LIMIT) {
		return { key: "task.workerThreads", status: "ok", label, detail: `${threads}, 동시 워커 상한 ${limit}개로 ${POOL_THREAD_LIMIT}개 이하라 풀 스레드에 놓이지 않습니다.` };
	}
	const ceiling = limit === undefined ? "확인하지 못함" : limit === 0 ? "제한 없음" : String(limit);
	return { key: "task.workerThreads", status: "notice", label, detail: `${threads}, 동시 워커 상한 ${ceiling}. ${stops}`, command: PREFLIGHT_COMMAND.pool };
}

function budgetItem(config: StormConfig): PreflightItem {
	const budget = config.budget;
	if (budget === undefined) {
		return { key: "budget", status: "notice", label: PREFLIGHT_LABEL.budget, detail: "예산이 없어 실행 비용에 상한이 없습니다. 필요하면 /storm <요청> 으로 예산을 정하세요.", command: PREFLIGHT_COMMAND.storm };
	}
	return { key: "budget", status: "ok", label: PREFLIGHT_LABEL.budget, detail: `실행당 $${budget.perRunUsd}` };
}

/** The report for one set of inputs. Pure: it reads nothing and changes nothing. */
export function preflightReport(input: PreflightInput): PreflightReport {
	const items: PreflightItem[] = [];
	if (input.proposed === undefined) items.push(teamItem(input.state));
	const config = input.proposed ?? (input.state.config.status === "ok" ? input.state.config.config : undefined);
	if (config !== undefined) {
		items.push(authItem(config, input.credentials));
		items.push(...isolationItems(config, input));
	}
	const mode = modeItem(input.modes);
	if (mode) items.push(mode);
	items.push(poolItem(input.maxConcurrency, input.workerThreads));
	if (config !== undefined) {
		items.push(budgetItem(config));
		if (input.explicit !== undefined) {
			for (const advice of ompSettingsAdvice(config, input.explicit)) {
				items.push({ key: advice.key, status: "notice", label: advice.key, detail: advice.message, ...(advice.command ? { command: advice.command } : {}) });
			}
		}
	}
	return { items, blocked: items.filter(item => item.status === "blocked").length };
}

/** What the host can tell about itself; each read is made when the report is gathered. */
export interface PreflightHost {
	modes(): PreflightInput["modes"];
	isolation(): Promise<IsolationReading>;
	maxConcurrency(): number | undefined;
	workerThreads(): number | undefined;
	credentials(selectors: readonly string[]): Promise<CredentialProbe>;
	integration: boolean;
}

/** Reads the host now and returns the report for `state` (or for `proposed`, inside an approval dialog). */
export async function gatherPreflight(
	state: SpawnState,
	host: PreflightHost,
	opts: { proposed?: StormConfig; explicit?: ExplicitSettings } = {},
): Promise<PreflightReport> {
	const config = opts.proposed ?? (state.config.status === "ok" ? state.config.config : undefined);
	const [isolation, credentials] = await Promise.all([
		host.isolation(),
		config === undefined ? undefined : host.credentials(teamSelectors(config)),
	]);
	const modes = host.modes();
	const maxConcurrency = host.maxConcurrency();
	const workerThreads = host.workerThreads();
	return preflightReport({
		state,
		...(opts.proposed ? { proposed: opts.proposed } : {}),
		...(credentials ? { credentials } : {}),
		isolation,
		integration: host.integration,
		...(modes !== undefined ? { modes } : {}),
		...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
		...(workerThreads !== undefined ? { workerThreads } : {}),
		...(opts.explicit ? { explicit: opts.explicit } : {}),
	});
}
