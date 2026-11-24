import { unapprovedShadows } from "../approval/shadow.ts";
import { shortHash } from "../config/canonical.ts";
import { BUILTIN_AGENT_ROLES, ROLE_AGENT_PREFIX, ROLE_STAND_INS, ROLES, roleTitle, workerRange } from "../roles.ts";
import { activeTrialFor, shouldRouteToTrial } from "../runtime/trials.ts";
import { formatModelEntry, parseModelEntry } from "../selector.ts";
import type {
	AgentEntry,
	ApprovalRecord,
	Block,
	Effort,
	QuotaMark,
	SpawnBlockCode,
	SpawnDecision,
	SpawnEvent,
	SpawnOutcome,
	SpawnRecord,
	SpawnRuntime,
	SpawnState,
	StormConfig,
	ToolBlockCode,
} from "../types.ts";

type SpawnBlock = Block<SpawnBlockCode>;

/** "$12.34" at ≥ $1, "$0.0123" below. */
export function formatUsd(usd: number): string {
	return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

/** What the model sees for a block: the reason behind its stable code. */
export function blockText(block: Block<SpawnBlockCode | ToolBlockCode>): string {
	return `[storm:${block.code}] ${block.reason}`;
}

/** Drops a trailing ":<effort>" only when it is a known effort, so ids like "x:thinking" stay intact. */
export function stripEffort(pattern: string): string {
	return parseModelEntry(pattern).selector;
}

/** omp model patterns take thinking effort as a ":<level>" suffix on the id part; any existing suffix wins. */
export function withEffort(selector: string, effort: Effort | undefined): string {
	if (!effort || selector.slice(selector.lastIndexOf("/") + 1).includes(":")) return selector;
	return formatModelEntry({ selector, effort });
}

/** Every model the approved config may run: all role models and all trial candidates, without effort. */
export function approvedSelectors(config: StormConfig): Set<string> {
	const out = new Set<string>();
	for (const role of Object.values(config.roles)) for (const m of role.models) out.add(stripEffort(m));
	for (const trial of config.trials ?? []) out.add(stripEffort(trial.model));
	return out;
}

/** The provider of a "provider/id" entry, lowercased: marks and models are matched without case. */
function providerKey(selector: string): string {
	const slash = selector.indexOf("/");
	return (slash < 0 ? selector : selector.slice(0, slash)).toLowerCase();
}

/** Models on providers marked out of quota go last; the order is kept when all or none are marked. */
export function orderByQuota(models: readonly string[], marks: readonly QuotaMark[]): string[] {
	const marked = new Set(marks.map(m => m.provider.toLowerCase()));
	const fresh = models.filter(m => !marked.has(providerKey(m)));
	if (fresh.length === 0 || fresh.length === models.length) return [...models];
	return [...fresh, ...models.filter(m => marked.has(providerKey(m)))];
}

export type TeamGate =
	| { ok: false; block: SpawnBlock }
	| { ok: true; config: StormConfig; hash: string; approval: ApprovalRecord };

/** Config present, valid, and approved for this exact hash: what a spawn and a run start both need. */
export function teamGate(state: Pick<SpawnState, "config" | "approval">): TeamGate {
	const load = state.config;
	if (load.status === "missing") {
		return { ok: false, block: { code: "no-config", reason: "팀 설정이 없습니다. /storm 으로 팀을 설정하세요." } };
	}
	if (load.status === "invalid") {
		return { ok: false, block: { code: "no-config", reason: `팀 설정 오류: ${load.errors[0] ?? "알 수 없는 오류"}. /storm 으로 확인하세요.` } };
	}
	const approval = state.approval;
	// An approval for another hash must never authorize the current file.
	if (!approval || approval.configHash !== load.hash) {
		return {
			ok: false,
			block: { code: "unapproved", reason: `승인되지 않은 팀 설정입니다(${shortHash(load.hash)}). /storm 으로 승인하세요.` },
		};
	}
	return { ok: true, config: load.config, hash: load.hash, approval };
}

/** A shadowing role definition the approval does not cover; `agent` narrows the check to that agent's definition. */
export function shadowBlock(state: Pick<SpawnState, "approval" | "shadows">, agent?: string): SpawnBlock | undefined {
	const shadow = unapprovedShadows(state.approval, state.shadows).find(s => agent === undefined || s.agent === agent);
	return shadow && { code: "shadow", reason: `승인되지 않은 역할 정의가 있습니다: ${shadow.path}. /storm 으로 확인하세요.` };
}

function budgetBlock(runtime: SpawnRuntime): SpawnBlock | undefined {
	const run = runtime.run;
	if (!run?.budget || run.costUsd < run.budget.perRunUsd) return undefined;
	return {
		code: "budget",
		reason: `실행 예산 ${formatUsd(run.budget.perRunUsd)}을 넘어(누계 ${formatUsd(run.costUsd)}) 새 스폰을 막았습니다. 이미 도는 서브에이전트의 결과로 마무리하세요.`,
	};
}

function dedupeBySelector(models: readonly string[]): string[] {
	const seen = new Set<string>();
	return models.filter(m => {
		const key = stripEffort(m);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** A configured, enabled role with at least one model. */
export function usableRole(config: StormConfig, id: string): StormConfig["roles"][string] | undefined {
	const role = config.roles[id];
	return role && role.models.length > 0 && !config.disabledRoles?.includes(id) ? role : undefined;
}

/**
 * Legacy fallback for callers that pass no authoritative reservations: a spawn decided this recently whose agent has
 * not reported still counts as starting. A managed run passes `reservedWorkers` and releases on an observed failure or
 * settled turn instead, so this timer never decides its concurrency.
 */
export const PENDING_SPAWN_MS = 30_000;

/** The role a live spawn counts against: a stand-in spawn counts against the role it asked for, not the borrowed one. */
export function countedRole(record: SpawnRecord): string | undefined {
	if (record.outcome === "substituted" && record.agent.startsWith(ROLE_AGENT_PREFIX)) {
		return ROLES.find(r => r.agent === record.agent)?.id ?? record.role;
	}
	return record.role;
}

/** One live worker reservation: a fresh spawn the host has not shown yet, or a reused worker's new work turn. */
export interface WorkerSlot {
	/** Host spawn key or agent id; one worker has one slot however many work-bearing notes it receives. */
	key: string;
	role?: string;
	lane?: string;
	at: number;
}

/**
 * The one authoritative concurrency accounting of a run. A spawn decision reserves before the host has a running
 * agent row; a genuine reactivation (work delivered to an idle/parked worker) reserves the same way. A work-bearing
 * note to an already running worker reuses its slot and a `?progress` note never reaches admission. Release happens
 * only on an observed failure, a settled turn (or park), or a closed run — never because a pending timer expired.
 */
const workerSlots = new Map<string, Map<string, WorkerSlot>>();

function slotsOf(runId: string): Map<string, WorkerSlot> {
	let slots = workerSlots.get(runId);
	if (!slots) workerSlots.set(runId, (slots = new Map()));
	return slots;
}

/** Reserve one worker slot. Re-reserving the same key only refreshes its role/lane: it is never a second slot. */
export function reserveWorkerSlot(input: { runId: string; key: string; role?: string; lane?: string; now?: number }): void {
	if (!input.runId || !input.key) return;
	const slots = slotsOf(input.runId);
	const current = slots.get(input.key);
	if (current !== undefined) {
		if (input.role !== undefined) current.role = input.role;
		if (input.lane !== undefined) current.lane = input.lane;
		return;
	}
	slots.set(input.key, {
		key: input.key,
		...(input.role === undefined ? {} : { role: input.role }),
		...(input.lane === undefined ? {} : { lane: input.lane }),
		at: input.now ?? Date.now(),
	});
}

export function workerSlot(runId: string, key: string): WorkerSlot | undefined {
	return workerSlots.get(runId)?.get(key);
}

/** Every live reservation of a run, for admission counts and the extension's follow-up gate. */
export function reservedWorkers(runId: string): readonly WorkerSlot[] {
	return [...(workerSlots.get(runId)?.values() ?? [])];
}

/** Drop one worker's slot after a failure, a settled turn, a park, or a closed run. */
export function releaseWorkerSlot(runId: string, key: string): boolean {
	const slots = workerSlots.get(runId);
	if (!slots || !slots.delete(key)) return false;
	if (slots.size === 0) workerSlots.delete(runId);
	return true;
}

export function clearWorkerSlots(runId: string): void {
	workerSlots.delete(runId);
}

/** Tests only: no slot may leak from one fixture's run into another. */
export function resetWorkerSlots(): void {
	workerSlots.clear();
}

/**
 * Live workers of a run. Identities are deduplicated so one worker is one slot: an authoritative reservation (a
 * fresh start before the host row, or a safely bound reactivation), a spawn record whose host agent is running, or a
 * running ledger agent without a spawn record. With `reserved` supplied, a spawn record with no reservation is not
 * live on a timer: only an actual running agent or an explicit reservation counts. Without it (legacy callers and
 * tests) the pending window remains a fallback.
 */
export function activeAgents(
	spawns: readonly SpawnRecord[],
	agents: readonly AgentEntry[],
	now: number,
	reserved?: readonly Pick<WorkerSlot, "key" | "role">[],
): { total: number; byRole: Record<string, number> } {
	const byId = new Map(agents.map(a => [a.id, a]));
	const slots = new Map((reserved ?? []).map(slot => [slot.key, slot]));
	const counted = new Set<string>();
	const byRole: Record<string, number> = {};
	const count = (key: string, role: string | undefined): void => {
		if (counted.has(key)) return;
		counted.add(key);
		if (role !== undefined) byRole[role] = (byRole[role] ?? 0) + 1;
	};
	for (const record of spawns) {
		if (record.outcome === "blocked" || record.spawnKey === undefined) continue;
		const agent = byId.get(record.spawnKey);
		const live = agent
			? agent.state === "running"
			: slots.has(record.spawnKey) || (reserved === undefined && now - Date.parse(record.ts) < PENDING_SPAWN_MS);
		if (live) count(record.spawnKey, countedRole(record) ?? slots.get(record.spawnKey)?.role);
	}
	// A reused worker has no current spawn record. Its reservation is one worker whether it is waiting, idle, or the
	// host has already started the new turn. A running row can supply the role if the reservation omitted it.
	for (const slot of slots.values()) {
		const agent = byId.get(slot.key);
		count(slot.key, slot.role ?? (agent?.state === "running" ? agent.role : undefined));
	}
	// A running agent without a spawn row or reservation still occupies a slot: never let it run uncounted.
	for (const agent of agents) {
		if (agent.state === "running") count(agent.id, agent.role);
	}
	return { total: counted.size, byRole };
}

/** During a run every Storm-decided spawn waits for the director's run plan. */
function planBlock(runtime: SpawnRuntime): SpawnBlock | undefined {
	if (!runtime.run || runtime.run.plan) return undefined;
	return {
		code: "no-plan",
		reason: "실행 계획이 없어 스폰을 막았습니다. 먼저 storm 도구의 plan 동작으로 레인(name·kind)을 내세요. 작은 작업은 레인 하나면 됩니다.",
	};
}

/** Live agents of the run against the team's parallelism. */
function totalBlock(config: StormConfig, runtime: SpawnRuntime): SpawnBlock | undefined {
	const total = runtime.run?.active?.total ?? 0;
	if (!runtime.run || total < config.parallelism) return undefined;
	return {
		code: "parallelism",
		reason: `서브에이전트 ${total}개가 실행 중이라 팀 동시 상한 ${config.parallelism}개에 닿아 스폰을 막았습니다. 사용자에게 묻지 말고 native wait나 완료 알림으로 하나가 끝난 뒤 다시 스폰하세요.`,
	};
}

/** Live agents of one role against the run plan's workers for it. */
function roleCapBlock(config: StormConfig, runtime: SpawnRuntime, roleId: string, agent: string): SpawnBlock | undefined {
	const run = runtime.run;
	const plan = run?.plan;
	if (!run || !plan) return undefined;
	const cap = plan.workers[roleId] ?? 0;
	if (cap <= 0) {
		return {
			code: "role-not-in-plan",
			reason: `실행 계획에 ${roleTitle(roleId)} 역할 레인이 없어 ${agent} 스폰을 막았습니다. 이 역할이 필요하면 plan 동작으로 그 레인을 넣어 계획을 다시 내세요.`,
		};
	}
	const running = run.active?.byRole[roleId] ?? 0;
	if (running < cap) return undefined;
	const max = workerRange(roleId, config.roles[roleId]).max;
	return {
		code: "role-cap",
		reason: `${roleTitle(roleId)} 역할 서브에이전트 ${running}개가 실행 중이라 계획의 워커 ${cap}개에 닿아 ${agent} 스폰을 막았습니다. 사용자에게 묻지 말고 native wait나 완료 알림으로 하나가 끝난 뒤 다시 스폰하거나, plan 동작으로 워커를 늘려 계획을 다시 내세요(이 역할 최대 ${max}개).`,
	};
}

/**
 * A role spawn needs a concrete plan lane and a host spawn key so its lane capability and result owner can be bound.
 * The exact lane name may be rewritten by automatic placement before the host allocates the key; the extension's lane
 * admission resolves that assignment, so this guard only refuses a plan with no lane for the role or a keyless spawn.
 */
function laneBindingBlock(runtime: SpawnRuntime, roleId: string, agent: string, spawnKey: string | undefined): SpawnBlock | undefined {
	const plan = runtime.run?.plan;
	if (!plan) return undefined;
	// A job lane uses a role only to name its lane kind; its work is run by the host, never by an AI worker.
	const eligible = plan.lanes.filter(lane => lane.job === undefined && lane.role === roleId);
	if (eligible.length === 0) {
		return {
			code: "unassigned-lane",
			reason: `실행 계획에 ${roleTitle(roleId)} 역할 레인이 없어 ${agent} 스폰을 배정할 수 없습니다. plan으로 그 역할의 레인을 만들거나 맞는 역할의 에이전트를 쓰세요.`,
		};
	}
	if (spawnKey === undefined) {
		return {
			code: "unassigned-lane",
			reason: `호스트가 스폰 키를 주지 않아 ${agent} 을(를) 계획 레인에 배정할 수 없습니다. task 항목마다 계획 레인 이름을 붙여 다시 스폰하세요.`,
		};
	}
	return undefined;
}

/** The record of a refused spawn: what was asked for, the block's code and what the model was told. */
export function blockedSpawn(event: SpawnEvent, refusal: SpawnBlock, now: number): SpawnRecord {
	return {
		ts: new Date(now).toISOString(),
		agent: event.agent,
		invocationKind: event.invocationKind,
		requested: [...event.patterns],
		outcome: "blocked",
		...(event.spawnKey ? { spawnKey: event.spawnKey } : {}),
		code: refusal.code,
		reason: refusal.reason,
	};
}

/** Decides how a spawn runs: `storm-*` agents always, other agents only while a Storm run is active. */
export function decideSpawn(event: SpawnEvent, state: SpawnState, runtime: SpawnRuntime): SpawnOutcome {
	const base: SpawnRecord = {
		ts: new Date(runtime.now).toISOString(),
		agent: event.agent,
		invocationKind: event.invocationKind,
		requested: [...event.patterns],
		outcome: "blocked",
		...(event.spawnKey ? { spawnKey: event.spawnKey } : {}),
	};
	const block = (refusal: SpawnBlock, extra: Partial<SpawnRecord> = {}): SpawnOutcome => ({
		decision: { block: true, reason: blockText(refusal) },
		record: { ...blockedSpawn(event, refusal, runtime.now), ...extra },
	});
	const route = (models: string[], extra: Partial<SpawnRecord> & Pick<SpawnRecord, "outcome">): SpawnOutcome => ({
		decision: { model: models, note: `storm: ${event.agent} → ${models[0]}` },
		record: { ...base, ...extra, models },
	});
	const missingRole = (): SpawnBlock => ({ code: "no-config", reason: `팀 설정에 ${event.agent} 역할이 없습니다. 팀에 있는 storm-* 에이전트를 쓰세요.` });

	if (!event.agent.startsWith(ROLE_AGENT_PREFIX)) {
		if (!runtime.run) return { decision: undefined };
		const checked = teamGate(state);
		if (!checked.ok) return block(checked.block);
		const overBudget = budgetBlock(runtime);
		if (overBudget) return block(overBudget);
		// omp's bundled agents do a role's work, so they take that role's slots like its storm-* agent does. The role id
		// counts even when the team has no usable definition for it: without a lane for that role, nothing may spawn.
		const builtinKey = BUILTIN_AGENT_ROLES[event.agent];
		const builtin = builtinKey === undefined ? undefined : usableRole(checked.config, builtinKey);
		const counted: Partial<SpawnRecord> = builtinKey === undefined ? {} : { role: builtinKey };
		// A native agent outside omp's known role substitutes has no lane, role cap or capability decision. During a
		// run that is an unattributed writer, not an ordinary spawn: refuse it rather than guess from its model or name.
		const unmapped: SpawnBlock | undefined =
			builtinKey === undefined
				? {
						code: "unmapped-agent",
						reason: `실행 중에는 계획 레인에 매핑된 에이전트만 스폰할 수 있습니다. ${event.agent} 은(는) 팀 역할에 매핑되지 않아 쓰기 권한과 결과 소유자를 정할 수 없습니다. 팀의 storm-* 에이전트를 쓰거나 plan으로 역할이 있는 레인을 지정하세요.`,
					}
				: undefined;
		const runBlock =
			planBlock(runtime) ??
			unmapped ??
			(counted.role === undefined
				? undefined
				: (roleCapBlock(checked.config, runtime, counted.role, event.agent) ??
					totalBlock(checked.config, runtime) ??
					laneBindingBlock(runtime, counted.role, event.agent, event.spawnKey)));
		if (runBlock) return block(runBlock, counted);
		const requested = stripEffort(event.patterns[0] ?? "");
		if (approvedSelectors(checked.config).has(requested)) {
			return { decision: undefined, record: { ...base, ...counted, outcome: "allowed" } };
		}
		if (builtinKey !== undefined && builtin) {
			const models = orderByQuota(builtin.models, runtime.quotaMarks).map(m => withEffort(m, builtin.effort));
			return route(models, {
				outcome: "substituted",
				role: builtinKey,
				reason: `승인 밖 모델 ${requested || "없음"} → ${roleTitle(builtinKey)} 역할 모델`,
			});
		}
		const fallbackKey = checked.config.fallbackRole;
		const fallback = fallbackKey === undefined ? undefined : checked.config.roles[fallbackKey];
		if (fallbackKey !== undefined && fallback && fallback.models.length > 0) {
			const models = orderByQuota(fallback.models, runtime.quotaMarks).map(m => withEffort(m, fallback.effort));
			return route(models, {
				outcome: "substituted",
				role: fallbackKey,
				reason: `승인 밖 모델 ${requested || "없음"} → ${roleTitle(fallbackKey)} 역할 모델`,
			});
		}
		return block({
			code: "unapproved",
			reason: `실행 중에는 승인된 모델만 쓸 수 있어 ${event.agent} 스폰을 막았습니다(요청: ${requested || "없음"}). 팀의 storm-* 에이전트를 쓰세요.`,
		});
	}

	const checked = teamGate(state);
	if (!checked.ok) return block(checked.block);
	const config = checked.config;
	const entry = Object.entries(config.roles).find(([, r]) => r.agent === event.agent);
	let roleKey: string;
	/** The role id this spawn asked for: a stand-in borrows `roleKey`'s models but counts against this one. */
	let requestedRole: string;
	let role: StormConfig["roles"][string];
	let standIn = false;
	if (entry) {
		[roleKey, role] = entry;
		requestedRole = roleKey;
	} else {
		const spec = ROLES.find(r => r.agent === event.agent);
		if (!spec) return block(missingRole());
		const usable = ROLE_STAND_INS[spec.id].find(id => usableRole(config, id));
		if (config.disabledRoles?.includes(spec.id)) {
			const suggest = (usable === undefined ? undefined : config.roles[usable]?.agent) ?? "storm-implementer";
			return block(
				{ code: "disabled-role", reason: `${spec.title} 역할(${event.agent})은 이 팀에서 쓰지 않습니다. 대신 ${suggest} 를 쓰세요.` },
				{ role: spec.id },
			);
		}
		const borrowed = usable === undefined ? undefined : usableRole(config, usable);
		if (usable === undefined || !borrowed) return block(missingRole());
		roleKey = usable;
		role = borrowed;
		standIn = true;
		requestedRole = spec.id;
	}

	const shadow = shadowBlock(state, event.agent);
	if (shadow) return block(shadow, { role: roleKey });

	if (role.models.length === 0) {
		return block({ code: "no-config", reason: `팀 설정의 ${roleTitle(roleKey)} 역할에 모델이 없습니다. /storm 으로 확인하세요.` }, { role: roleKey });
	}
	const overBudget = budgetBlock(runtime);
	if (overBudget) return block(overBudget, { role: roleKey });
	const runBlock =
		planBlock(runtime) ??
		roleCapBlock(config, runtime, requestedRole, event.agent) ??
		totalBlock(config, runtime) ??
		laneBindingBlock(runtime, requestedRole, event.agent, event.spawnKey);
	if (runBlock) return block(runBlock, { role: roleKey });

	const ordered = orderByQuota(role.models, runtime.quotaMarks).map(m => withEffort(m, role.effort));
	if (standIn) {
		return route(ordered, { outcome: "substituted", role: roleKey, reason: `설정에 없는 역할 → ${roleTitle(roleKey)} 역할 모델` });
	}
	const trial = activeTrialFor(config, roleKey, runtime.trials, runtime.now);
	const trialTag: Partial<SpawnRecord> = trial ? { trialId: trial.id } : {};
	if (trial && shouldRouteToTrial(trial, runtime.trials[trial.id])) {
		const models = dedupeBySelector([withEffort(trial.model, trial.effort ?? role.effort), ...ordered]);
		return route(models, { outcome: "trial", role: roleKey, ...trialTag });
	}
	return route(ordered, { outcome: "routed", role: roleKey, ...trialTag });
}

/** How long a spawn decision may take: under omp's 30 s handler budget, past which omp runs the spawn unseen. */
export const SPAWN_DECISION_MS = 25_000;

/** A promise that rejects after `ms`, for racing a decision against; `cancel` once the decision is in. */
export function deadline(ms: number): { expired: Promise<never>; cancel(): void } {
	const { promise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${Math.round(ms / 1000)}초 안에 판단하지 못함`)), ms);
	return { expired: promise, cancel: () => clearTimeout(timer) };
}

/**
 * Runs a spawn decision so that a failure while deciding never lets the spawn through unseen: omp treats a hook
 * that throws or outlasts its handler budget as "no opinion" and would run the agent on its own model. `expired`
 * (see `deadline`) is raced against the decision. `storm-*` agents and any agent during a run are blocked with code
 * `internal`, reported to `onBlock` so the run can record it; other agents outside a run stay omp's business.
 */
export async function failClosed(
	agent: string,
	runActive: () => boolean,
	decide: () => Promise<SpawnDecision>,
	opts: { expired?: Promise<never>; onBlock?: (block: Block<"internal">) => void } = {},
): Promise<SpawnDecision> {
	try {
		return await (opts.expired ? Promise.race([decide(), opts.expired]) : decide());
	} catch (error) {
		let inRun = true;
		try {
			inRun = runActive();
		} catch {
			// Unknown counts as a run.
		}
		if (!agent.startsWith(ROLE_AGENT_PREFIX) && !inRun) return undefined;
		const detail = error instanceof Error ? error.message : String(error);
		const block: Block<"internal"> = {
			code: "internal",
			reason: `Storm 이 스폰을 판단하지 못해 막았습니다(${detail}). 다시 시도하고, 계속되면 사용자에게 알리세요.`,
		};
		try {
			opts.onBlock?.(block);
		} catch {
			// The block stands whether or not it could be recorded.
		}
		return { block: true, reason: blockText(block) };
	}
}
