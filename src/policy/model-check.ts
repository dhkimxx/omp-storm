import { BUILTIN_AGENT_ROLES, ROLE_AGENT_PREFIX, ROLE_STAND_INS, ROLES, roleTitle } from "../roles.ts";
import { parseModelEntry } from "../selector.ts";
import { EFFORTS, type Effort, type RanModel, type SpawnRecord, type StormConfig } from "../types.ts";

/**
 * G2 in two pieces that live outside the hook's decision itself.
 *
 * 1. Credentials. omp swaps a role's models for the parent session's model when none of them can authenticate, so a
 *    spawn answer is only worth giving over entries that can. The extension probes the model registry (async, one
 *    lookup per selector) and hands `decideSpawn` the set that resolved a credential.
 * 2. The child's own first request. The hook's answer is what Storm asked for, not what ran: a credential that
 *    broke after the answer, a later extension replacing the answer, or omp's own retry fallback can all end on
 *    another model. `checkChildModel` is the comparison the child's session runs against the team.
 */

/** "provider/id" of a model as the registry names it; the selector every team entry is written in. */
export function selectorOf(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** Selectors compare without case: omp matches model patterns that way. */
function sameSelector(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** Every model the approved team may run on a role's behalf, without effort: role models and trial candidates. */
export function teamSelectors(config: StormConfig): string[] {
	const seen = new Map<string, string>();
	const add = (entry: string): void => {
		const selector = parseModelEntry(entry).selector;
		const key = selector.toLowerCase();
		if (!seen.has(key)) seen.set(key, selector);
	};
	for (const role of Object.values(config.roles)) for (const model of role.models) add(model);
	for (const trial of config.trials ?? []) add(trial.model);
	return [...seen.values()];
}

/** How long one credential lookup may take before the model counts as unauthenticated (a refresh can hang). */
export const CREDENTIAL_PROBE_MS = 5_000;

/** What the credential lookups said: the selectors that authenticate, and those whose lookup did not answer in time. */
export interface CredentialProbe {
	/** Lowercased selectors whose credential resolved. */
	ok: ReadonlySet<string>;
	/** Lowercased selectors whose lookup outlasted the limit (a token refresh can hang): unknown, not refused by the provider. */
	slow: ReadonlySet<string>;
}

/**
 * The selectors of `selectors` that can authenticate now. `probe` is the registry lookup (true = a credential resolved). A
 * probe that throws, answers false or outlasts `timeoutMs` leaves its selector out of `ok`: the answer can only ever shrink on
 * doubt, never gain a model. A lookup that only outlasted the limit is also named in `slow`, so a refusal can say the check
 * was late and not that the login is gone. Lookups run side by side.
 */
export async function probeCredentialsDetailed(
	selectors: readonly string[],
	probe: (selector: string) => Promise<boolean> | boolean,
	timeoutMs: number = CREDENTIAL_PROBE_MS,
): Promise<CredentialProbe> {
	const ok = new Set<string>();
	const slow = new Set<string>();
	await Promise.all(
		selectors.map(async selector => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const limit = new Promise<"slow">(resolve => {
					timer = setTimeout(() => resolve("slow"), timeoutMs);
				});
				const answer = await Promise.race([Promise.resolve().then(() => probe(selector)), limit]);
				if (answer === "slow") slow.add(selector.toLowerCase());
				else if (answer === true) ok.add(selector.toLowerCase());
			} catch {
				// A lookup that threw is no credential.
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}),
	);
	return { ok, slow };
}

/** `probeCredentialsDetailed`'s `ok` set alone. */
export async function probeCredentials(
	selectors: readonly string[],
	probe: (selector: string) => Promise<boolean> | boolean,
	timeoutMs: number = CREDENTIAL_PROBE_MS,
): Promise<ReadonlySet<string>> {
	return (await probeCredentialsDetailed(selectors, probe, timeoutMs)).ok;
}

/** Whether `selector` is in a set `probeCredentials` returned. */
export function hasCredentials(authenticated: ReadonlySet<string>, selector: string): boolean {
	return authenticated.has(selector.toLowerCase());
}

/** One entry the user approved for a role: the selector and the effort it runs at (absent = none was approved). */
export interface ApprovedEntry {
	selector: string;
	effort?: Effort;
}

/** The role an agent fills during a run, and how Storm came to that role. */
export interface AgentRole {
	key: string;
	kind: "own" | "stand-in" | "bundled" | "fallback";
}

function usable(config: StormConfig, id: string): StormConfig["roles"][string] | undefined {
	const role = config.roles[id];
	return role && role.models.length > 0 && !config.disabledRoles?.includes(id) ? role : undefined;
}

/**
 * The role whose approved models an agent may run on: a `storm-*` agent its own role (or the nearest stand-in for a
 * role the team lacks), an omp bundled agent the role it does the work of, any other agent the team's fallback role.
 * Undefined when the team has no usable role for it. `decideSpawn` and the child's check use this one resolution.
 */
export function roleOfAgent(config: StormConfig, agent: string): AgentRole | undefined {
	if (agent.startsWith(ROLE_AGENT_PREFIX)) {
		const own = Object.entries(config.roles).find(([, role]) => role.agent === agent);
		if (own) return usable(config, own[0]) ? { key: own[0], kind: "own" } : undefined;
		const spec = ROLES.find(r => r.agent === agent);
		const standIn = spec === undefined ? undefined : ROLE_STAND_INS[spec.id].find(id => usable(config, id));
		return standIn === undefined ? undefined : { key: standIn, kind: "stand-in" };
	}
	const bundled = BUILTIN_AGENT_ROLES[agent];
	if (bundled !== undefined && usable(config, bundled)) return { key: bundled, kind: "bundled" };
	const fallback = config.fallbackRole;
	return fallback !== undefined && usable(config, fallback) ? { key: fallback, kind: "fallback" } : undefined;
}

/** The entries approved for a role, in the team's order; an entry with no effort of its own takes the role's. */
export function roleEntries(config: StormConfig, roleKey: string): ApprovedEntry[] {
	const role = config.roles[roleKey];
	if (!role) return [];
	return role.models.map(model => {
		const parsed = parseModelEntry(model);
		const effort = parsed.effort ?? role.effort;
		return { selector: parsed.selector, ...(effort === undefined ? {} : { effort }) };
	});
}

/**
 * What an agent may run on during a run: its role's entries, plus the candidate of a trial running for that role
 * right now when `trialModel` names it. A trial candidate is approved for storm-* routing only; the extension passes it
 * when this child's spawn record says it was routed to that trial.
 */
export function approvedEntries(config: StormConfig, agent: string, trial?: { model: string; effort?: Effort }): ApprovedEntry[] {
	const role = roleOfAgent(config, agent);
	if (role === undefined) return [];
	const entries = roleEntries(config, role.key);
	if (trial !== undefined) {
		const parsed = parseModelEntry(trial.model);
		const effort = trial.effort ?? parsed.effort ?? config.roles[role.key]?.effort;
		entries.push({ selector: parsed.selector, ...(effort === undefined ? {} : { effort }) });
	}
	return entries;
}

/** One entry as an omp model pattern: the selector, then ":<effort>" when an effort was approved. */
export function entryPattern(entry: ApprovedEntry): string {
	return entry.effort === undefined ? entry.selector : `${entry.selector}:${entry.effort}`;
}

/** The patterns of `patterns` that are exactly an approved entry, in the order asked; undefined unless all are. */
export function exactEntries(patterns: readonly string[], approved: readonly ApprovedEntry[]): ApprovedEntry[] | undefined {
	if (patterns.length === 0) return undefined;
	const out: ApprovedEntry[] = [];
	for (const pattern of patterns) {
		const asked = parseModelEntry(pattern);
		const match = approved.find(entry => sameSelector(entry.selector, asked.selector) && entry.effort === asked.effort);
		if (!match) return undefined;
		if (!out.includes(match)) out.push(match);
	}
	return out;
}

// ── The child's own check ───────────────────────────────────────────────────────────────────

/** What a child session reports about itself: the model of its request and its reasoning level, when it has one. */
export interface ChildObservation {
	provider: string;
	id: string;
	/** `getThinkingLevel()` of the child's own session; absent when the host does not say. */
	effort?: string;
	/**
	 * What the host resolves a team selector to (`provider/id`, as its model registry names it): the answer given to omp and
	 * this check must agree on the model itself, not on its spelling (an alias, another case). Absent or undefined for a
	 * selector the host does not know: the team's text is then compared as it is.
	 */
	resolve?: (selector: string) => string | undefined;
}

export type ChildCheck =
	| { ok: true; entry: ApprovedEntry; /** The effort could not be read, so only the model is established. */ effortUnverified: boolean }
	| { ok: false; reason: "model" | "effort" | "effort-unread" | "no-role" | "unchecked"; observed: string; approved: string[] };

function effortRank(effort: string): number {
	return EFFORTS.findIndex(level => level === effort);
}

/**
 * Whether what a child runs on is what the user approved for its role. The model must be one of the role's entries.
 * The effort may be at or below the entry's: omp lowers it itself to what a model supports and to `task.maxEffort`,
 * which never runs more than was approved. An effort above the entry's, or a level Storm does not know against an
 * entry that has one, is a mismatch. An entry with no approved effort constrains the model only.
 */
export function checkChildModel(config: StormConfig, agent: string, observed: ChildObservation, trial?: { model: string; effort?: Effort }): ChildCheck {
	return checkChildModelAgainst(approvedEntries(config, agent, trial), observed);
}

/**
 * The same check against entries already decided: a worker on another thread reads them from its persisted admission, where the
 * parent wrote what the child's role (and its trial, when it is one) approves, because the team's config is not enough there to
 * tell which trial a spawn belongs to.
 */
export function checkChildModelAgainst(approved: readonly ApprovedEntry[], observed: ChildObservation): ChildCheck {
	const label = observed.effort === undefined ? selectorOf(observed) : `${selectorOf(observed)}:${observed.effort}`;
	if (approved.length === 0) return { ok: false, reason: "no-role", observed: label, approved: [] };
	const ranSelector = selectorOf(observed);
	const sameModel = approved.filter(entry => {
		if (sameSelector(entry.selector, ranSelector)) return true;
		const resolved = observed.resolve?.(entry.selector);
		return resolved !== undefined && sameSelector(resolved, ranSelector);
	});
	const patterns = approved.map(entryPattern);
	if (sameModel.length === 0) return { ok: false, reason: "model", observed: label, approved: patterns };
	// Several entries may name one model at different efforts; the highest approved one bounds what may run.
	const ceiling = (entry: ApprovedEntry): number => (entry.effort === undefined ? Number.POSITIVE_INFINITY : effortRank(entry.effort));
	const best = sameModel.reduce((a, b) => (ceiling(b) > ceiling(a) ? b : a));
	if (best.effort === undefined) return { ok: true, entry: best, effortUnverified: observed.effort === undefined };
	// The role has an approved effort and the host did not report the level the child runs at: that it is at or below the approved
	// one is not established (a fact the promise depends on), so the worker is stopped rather than recorded as verified.
	if (observed.effort === undefined) return { ok: false, reason: "effort-unread", observed: label, approved: patterns };
	const ran = effortRank(observed.effort);
	if (ran < 0 || ran > effortRank(best.effort)) return { ok: false, reason: "effort", observed: label, approved: patterns };
	return { ok: true, entry: best, effortUnverified: false };
}

/**
 * Sentence for the director when a worker was stopped because it ran on something the user did not approve. It names
 * the cause and what can be done: the team is the user's, so the same spawn is not retried.
 */
export function modelMismatchNotice(agent: string, check: Extract<ChildCheck, { ok: false }>, roleId?: string): string {
	const role = roleId === undefined ? "" : ` ${roleTitle(roleId)} 역할의`;
	if (check.reason === "no-role") {
		return `${agent} 워커를 멈췄습니다. 승인된 팀에 이 워커가 쓸 역할이 없어 실제 모델(${check.observed})이 승인된 것인지 확인할 수 없습니다. 사용자에게 알리고 같은 스폰을 다시 보내지 마세요.`;
	}
	// The check itself could not be made: the admission's approved snapshot was not read in time, could not be read, or
	// holds nothing. That is no statement about the worker's role, so it is not told as one; the stop is still the safe
	// answer (G2).
	if (check.reason === "unchecked") {
		return `${agent} 워커를 멈췄습니다. 스폰 때 저장한 승인 기록을 시간 안에 읽지 못했거나 읽을 수 없어 실제 모델(${check.observed})이 승인된 것인지 확인하지 못했습니다. 사용자에게 팀 설정(/storm)을 확인해 달라고 알리고, 새 워커를 스폰하세요.`;
	}
	if (check.reason === "effort-unread") {
		return `${agent} 워커를 멈췄습니다. 호스트가 이 워커의 추론 강도를 알려 주지 않아${role} 승인된 강도(${check.approved.join(", ")}) 이하로 도는지 확인할 수 없습니다. 사용자에게 알리고, 확인되기 전에는 같은 스폰을 다시 보내지 마세요.`;
	}
	const what = check.reason === "effort" ? "추론 강도" : "모델";
	return `${agent} 워커를 멈췄습니다. 실제로 쓰인 ${what}: ${check.observed}. 이 값이${role} 승인 목록(${check.approved.join(", ")})에 없습니다. 보통 승인된 모델의 인증이 끊겼을 때 호스트가 상위 세션의 모델로 바꿉니다. 사용자에게 모델 로그인과 팀 설정을 확인해 달라고 알리고, 확인되기 전에는 같은 스폰을 다시 보내지 마세요.`;
}

export type { RanModel };

/** A spawn record plus what the child's check found; `ran` is absent until a check has read the child. */
export type CheckedSpawnRecord = SpawnRecord;

/** The record after the child's check read it. A record that never was checked is returned as it is. */
export function withRan(record: SpawnRecord, ran: RanModel | undefined): CheckedSpawnRecord {
	return ran === undefined ? record : { ...record, ran };
}

/**
 * The record's models as a reader may state them: what Storm answered to omp, and, when a child's check read it, what
 * ran. The answer alone never reads as the model that ran.
 */
export function describeSpawnModels(record: CheckedSpawnRecord): string {
	const answered = (record.models ?? []).join(" → ") || "없음";
	if (record.ran === undefined) return `답한 모델 ${answered} (실제 실행 모델은 확인 전)`;
	const ran = record.ran.effort === undefined ? record.ran.model : `${record.ran.model}:${record.ran.effort}`;
	return record.ran.verdict === "verified" ? `답한 모델 ${answered} · 실행 확인 ${ran}` : `답한 모델 ${answered} · 실제 실행 ${ran}(승인 밖, 멈춤)`;
}

/**
 * `work`'s value, or undefined when it has not settled within `ms` or rejects. The check of a worker's request must answer
 * before omp's own handler budget runs out (omp then sends the request as it is); an answer that never came is a check that
 * could not be made, and the caller stops the worker on it.
 */
export async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.catch(() => undefined),
			new Promise<undefined>(resolve => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
