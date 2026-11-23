import { BUILTIN_AGENT_ROLES, ROLES } from "../roles.ts";
import type { AgentEntry, PlanLane, RunPlan, SpawnRecord, StormConfig } from "../types.ts";

interface Assignment {
	lane: string;
	key: string;
	agent: string;
}

type TaskBinding = { ok: true; input: Record<string, unknown> } | { ok: false; reason: string };

/**
 * omp's effective task-isolation capability. An absent field is unknown, never false: a host that cannot prove
 * `task.isolation.enabled` must not be used for a spawn that needs isolation.
 */
export interface TaskIsolationHost {
	/** `task.isolation.enabled`. */
	enabled?: boolean;
	/** `task.isolation.apply`; a reason-marked lane needs this to be false so its result stays outside the parent. */
	apply?: boolean;
}

export interface TaskPlacementOptions {
	/** Automatic delegation reserves and rewrites task names; manual direction keeps the director's handles. */
	rewriteNames?: boolean;
	/** Live host capability; omitted means unknown. */
	host?: TaskIsolationHost;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Write scope compares as a set of paths, matching the validator's duplicate-tolerant collision check. */
function normalizeFiles(lane: PlanLane): string[] {
	return [...new Set(lane.files ?? [])].sort();
}

/**
 * An old worker can still complete an unchanged lane, but not one whose goal, file scope or isolation placement
 * changed. `progress` is status text, never identity: it neither grants proof nor drops the proof already earned.
 * A shared lane keeps the exact key written before placement existed, so past evidence is not invalidated; only a
 * newly isolated lane adds the trailing marker, and changing the reason's wording does not alter it.
 */
function key(lane: PlanLane): string {
	const parts: unknown[] = [lane.name, lane.kind, lane.role, (lane.goal ?? "").trim(), normalizeFiles(lane)];
	if (lane.isolationReason !== undefined) parts.push(true);
	return JSON.stringify(parts);
}

/**
 * Why a replan is not the same plan, if a lane keeps its name but changes the identity its evidence is bound to.
 * A status update belongs in `progress`; an actual change needs a new lane name. Removing lanes is allowed, and a
 * new name starts with no evidence.
 */
export function replanConflict(previous: RunPlan | undefined, next: RunPlan): string | undefined {
	if (!previous) return undefined;
	const before = new Map(previous.lanes.map(lane => [lane.name, lane]));
	for (const lane of next.lanes) {
		const old = before.get(lane.name);
		if (!old) continue;
		const changed: string[] = [];
		if ((old.goal ?? "").trim() !== (lane.goal ?? "").trim()) changed.push("goal");
		if (old.kind !== lane.kind) changed.push("kind");
		if (old.role !== lane.role) changed.push("role");
		if (JSON.stringify(normalizeFiles(old)) !== JSON.stringify(normalizeFiles(lane))) changed.push("files");
		if ((old.isolationReason !== undefined) !== (lane.isolationReason !== undefined)) changed.push("isolationReason");
		if (changed.length === 0) continue;
		return `계획 레인 '${lane.name}'의 ${changed.join(", ")} 항목이 바뀌었습니다. 진행 상태는 progress에 적고, 실제 변경은 새 레인 이름으로 내세요. 같은 이름으로 기존 증거를 조용히 덮어쓰거나 완화할 수 없습니다.`;
	}
	return undefined;
}

function workerRole(config: StormConfig, agent: string): string | undefined {
	return Object.entries(config.roles).find(([, role]) => role.agent === agent)?.[0] ?? ROLES.find(role => role.agent === agent)?.id ??
		(Object.hasOwn(BUILTIN_AGENT_ROLES, agent) ? BUILTIN_AGENT_ROLES[agent] : undefined);
}

/** Adds, removes or keeps a task's `isolated` flag; an absent flag is the host's shared default. */
function withIsolation(item: Record<string, unknown>, desired: boolean | undefined): Record<string, unknown> {
	if (desired === undefined) {
		if (!Object.hasOwn(item, "isolated")) return item;
		const next = { ...item };
		delete next.isolated;
		return next;
	}
	return item.isolated === desired ? item : { ...item, isolated: desired };
}

function isolationCapabilityReason(agent: string, enabled: boolean | undefined): string {
	const state = enabled === false ? "꺼져 있습니다(task.isolation.enabled=false)" : "상태를 확인하지 못했습니다";
	return `${agent}: 이 작업은 부모 트리와 분리된 격리 실행이 필요한데 omp 격리가 ${state}. ` +
		"`omp config set task.isolation.enabled true`로 켜고 `omp config list --json`으로 확인한 뒤 다시 스폰하세요. " +
		"격리가 필요 없다면 계획의 isolationReason을 빼고 공유 레인으로 다시 계획하거나, 호스트가 격리를 지원하지 않으면 파일 범위를 나눈 순차 공유 레인으로 실행하세요.";
}

function isolationApplyReason(agent: string, lane: string, apply: boolean | undefined): string {
	const state = apply === true ? "켜져 있어(task.isolation.apply=true)" : "켜짐을 배제하지 못해";
	return `${agent}: '${lane}' 레인은 부모 트리 밖에 남는 독립 결과가 필요한데 omp가 격리 결과를 부모 작업 트리에 자동 적용합니다(${state}). ` +
		"`omp config set task.isolation.apply false`로 적용을 끄고 다시 스폰하세요. " +
		"결과를 부모 트리에 합쳐도 되면 그 레인의 isolationReason을 빼고 공유 레인으로 계획하고, 별도 결과가 필요하면 격리 레인을 분리해 patch/branch 산출물 경로를 결과로 받으세요.";
}

/**
 * Correlates director task items to the actual ids OMP allocates. The host emits the allocated id, not the
 * planned lane name, in before_subagent_spawn. Reserve distinct valid names for each task even across replans.
 * Only the next matching spawn may consume a reservation. Nested children do not complete the director's lane.
 * Placement is also the one isolation authority: shared teams reserve the parent tree for every ordinary item,
 * a lane's isolationReason asks for a separate result, and legacy `isolation: isolated` teams isolate every spawn,
 * the final reviewer included. The extension certifies a reviewer only against the checkout it actually read.
 */
export class RunLanes {
	readonly #assigned = new Map<string, Assignment>();
	readonly #admitted = new Map<string, Assignment>();
	#serial = 0;

	constructor(private readonly runId: string) {}

	/** Automatic delegation: bind every item to a lane, reserve a unique spawn name, and set its isolation placement. */
	assign(
		input: unknown,
		plan: RunPlan,
		config: StormConfig,
		options: Omit<TaskPlacementOptions, "rewriteNames"> = {},
	): TaskBinding {
		return this.place(input, plan, config, { ...options, rewriteNames: true });
	}

	/**
	 * Applies one plan's isolation placement to a native task call before omp allocates spawn ids. Manual direction
	 * keeps the caller's names and ordinary unplanned items; ambiguity only matters when a caller claims isolation.
	 * Nothing is reserved until the whole call and host capability are accepted, so a rejected batch leaves no partial
	 * lane reservations behind.
	 */
	place(input: unknown, plan: RunPlan | undefined, config: StormConfig, options: TaskPlacementOptions = {}): TaskBinding {
		if (!object(input)) return { ok: false, reason: "작업 계획의 레인 이름과 역할로 task를 호출하세요." };
		const batch = Array.isArray(input.tasks);
		const items: unknown[] = batch ? input.tasks as unknown[] : [input];
		if (!items.length) return { ok: false, reason: "task에 맡길 레인이 필요합니다." };
		const rewrite = options.rewriteNames === true;
		const teamIsolated = config.isolation === "isolated";
		const used = new Set<string>();
		const placed: Array<{
			item: Record<string, unknown>;
			lane: PlanLane | undefined;
			agent: string;
			desired: boolean | undefined;
			requiresIsolation: boolean;
			selective: boolean;
		}> = [];
		for (const item of items) {
			if (!object(item)) return { ok: false, reason: "task 항목이 올바르지 않습니다." };
			const agent = typeof item.agent === "string" ? item.agent : "task";
			const role = workerRole(config, agent);
			const named = plan !== undefined && typeof item.name === "string" ? plan.lanes.find(lane => lane.name === item.name) : undefined;
			const eligible = plan === undefined || role === undefined ? [] : plan.lanes.filter(lane => lane.role === role && !used.has(lane.name));
			let lane = named ?? (eligible.length === 1 ? eligible[0] : undefined);
			const unambiguous = lane !== undefined && lane.role === role && !used.has(lane.name);
			if (rewrite && !unambiguous) {
				return { ok: false, reason: `${agent}: 승인된 계획의 담당 역할과 같은 레인 이름을 task의 name에 지정하세요. 예: ${eligible.map(item => item.name).join(", ") || "맞는 레인 없음"}` };
			}
			if (!unambiguous) lane = undefined;
			const reason = lane?.isolationReason;
			if (reason !== undefined && lane !== undefined && (lane.role === "reviewer" || lane.kind === "review")) {
				return { ok: false, reason: `${agent}: 최종 리뷰는 통합 트리를 봐야 하므로 격리 레인이 될 수 없습니다. isolationReason을 빼거나 독립 실험을 별도 code/run 레인으로 분리하세요.` };
			}
			let desired: boolean | undefined;
			let requiresIsolation = false;
			let selective = false;
			if (teamIsolated) {
				desired = true;
				requiresIsolation = true;
			} else if (reason !== undefined) {
				desired = true;
				requiresIsolation = true;
				selective = true;
			} else if (lane === undefined && item.isolated === true) {
				return { ok: false, reason: `${agent}: 계획에 없는 직접 task는 isolated: true로 독립 결과를 주장할 수 없습니다. 독립 실험이 필요하면 storm plan에 isolationReason이 있는 레인을 만들고 task name을 그 레인에 맞추세요. 공유 작업이면 isolated를 빼세요.` };
			}
			if (lane !== undefined) used.add(lane.name);
			placed.push({ item, lane, agent, desired, requiresIsolation, selective });
		}
		const needing = placed.find(entry => entry.requiresIsolation);
		if (needing !== undefined && options.host?.enabled !== true) {
			return { ok: false, reason: isolationCapabilityReason(needing.agent, options.host?.enabled) };
		}
		const selective = placed.find(entry => entry.selective);
		if (selective !== undefined && options.host?.apply !== false) {
			return { ok: false, reason: isolationApplyReason(selective.agent, selective.lane!.name, options.host?.apply) };
		}
		const mapped = placed.map(entry => {
			let next = withIsolation(entry.item, entry.desired);
			if (rewrite) {
				// Every auto item was accepted only after matching a lane above.
				const lane = entry.lane as PlanLane;
				const name = `${this.runId}-lane-${++this.#serial}`;
				this.#assigned.set(name, { key: key(lane), lane: lane.name, agent: entry.agent });
				next = { ...next, name };
			}
			return next;
		});
		if (!batch) return { ok: true, input: mapped[0]! };
		// omp falls back to a top-level `isolated` for every batch item that omitted its own flag. Placement is
		// per-item here, so the stale top-level shorthand must not isolate a shared item behind our back.
		const next: Record<string, unknown> = { ...input, tasks: mapped };
		delete next.isolated;
		return { ok: true, input: next };
	}

	/** Consume an approved spawn's reservation. Manual task handles are retained, binding only unambiguous lanes. */
	admit(
		spawn: Pick<SpawnRecord, "spawnKey" | "agent" | "outcome">,
		manual?: { plan: RunPlan; config: StormConfig },
	): string | undefined {
		if (!spawn.spawnKey) return undefined;
		let assignment = this.#assigned.get(spawn.spawnKey);
		if (assignment && assignment.agent !== spawn.agent) return undefined;
		this.#assigned.delete(spawn.spawnKey);
		if (spawn.outcome === "blocked") return undefined;
		if (!assignment && manual) {
			const role = workerRole(manual.config, spawn.agent);
			const eligible = manual.plan.lanes.filter(lane => lane.role === role);
			const name = spawn.spawnKey.split(".").at(-1);
			const lane = eligible.find(item => item.name === name) ?? (eligible.length === 1 ? eligible[0] : undefined);
			if (lane) assignment = { lane: lane.name, key: key(lane), agent: spawn.agent };
		}
		if (!assignment) return undefined;
		this.#admitted.set(spawn.spawnKey, assignment);
		return assignment.lane;
	}

	/** An admitted worker must actually run and settle before its lane can provide evidence. */
	remaining(plan: RunPlan, agents: readonly AgentEntry[], failed: ReadonlySet<string>): string[] {
		const covered = new Set<string>();
		for (const agent of agents) {
			if (agent.state === "running" || agent.requests === 0 || agent.lastWorkFailed || failed.has(agent.id)) continue;
			const assignment = this.#admitted.get(agent.id);
			if (assignment) covered.add(assignment.key);
		}
		return plan.lanes.filter(lane => !covered.has(key(lane))).map(lane => lane.name);
	}
}
