import { BUILTIN_AGENT_ROLES, ROLES } from "../roles.ts";
import type { AgentEntry, PlanLane, RunPlan, SpawnRecord, StormConfig } from "../types.ts";

interface Assignment {
	lane: string;
	key: string;
	agent: string;
}

type TaskBinding = { ok: true; input: Record<string, unknown> } | { ok: false; reason: string };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** An old worker can still complete an unchanged lane, but not one whose goal or file scope changed. */
function key(lane: PlanLane): string {
	return JSON.stringify([lane.name, lane.kind, lane.role, lane.goal ?? "", [...(lane.files ?? [])].sort()]);
}

function workerRole(config: StormConfig, agent: string): string | undefined {
	return Object.entries(config.roles).find(([, role]) => role.agent === agent)?.[0] ?? ROLES.find(role => role.agent === agent)?.id ??
		(Object.hasOwn(BUILTIN_AGENT_ROLES, agent) ? BUILTIN_AGENT_ROLES[agent] : undefined);
}

/**
 * Correlates director task items to the actual ids OMP allocates. The host emits the allocated id, not the
 * planned lane name, in before_subagent_spawn. Reserve distinct valid names for each task even across replans.
 * Only the next matching spawn may consume a reservation. Nested children do not complete the director's lane.
 */
export class RunLanes {
	readonly #assigned = new Map<string, Assignment>();
	readonly #admitted = new Map<string, Assignment>();
	#serial = 0;

	constructor(private readonly runId: string) {}

	assign(input: unknown, plan: RunPlan, config: StormConfig): TaskBinding {
		if (!object(input)) return { ok: false, reason: "작업 계획의 레인 이름과 역할로 task를 호출하세요." };
		const batch = Array.isArray(input.tasks);
		const items: unknown[] = batch ? input.tasks as unknown[] : [input];
		const next: Array<{ item: Record<string, unknown>; lane: PlanLane; agent: string }> = [];
		const used = new Set<string>();
		for (const item of items) {
			if (!object(item)) return { ok: false, reason: "task 항목이 올바르지 않습니다." };
			const agent = typeof item.agent === "string" ? item.agent : "task";
			const role = workerRole(config, agent);
			const named = typeof item.name === "string" ? plan.lanes.find(lane => lane.name === item.name) : undefined;
			const eligible = plan.lanes.filter(lane => lane.role === role && !used.has(lane.name));
			const lane = named ?? (eligible.length === 1 ? eligible[0] : undefined);
			if (!lane || lane.role !== role || used.has(lane.name)) {
				return { ok: false, reason: `${agent}: 승인된 계획의 담당 역할과 같은 레인 이름을 task의 name에 지정하세요. 예: ${eligible.map(item => item.name).join(", ") || "맞는 레인 없음"}` };
			}
			used.add(lane.name);
			next.push({ item, lane, agent });
		}
		if (!next.length) return { ok: false, reason: "task에 맡길 레인이 필요합니다." };
		const mapped = next.map(({ item, lane, agent }) => {
			const name = `${this.runId}-lane-${++this.#serial}`;
			this.#assigned.set(name, { key: key(lane), lane: lane.name, agent });
			return { ...item, name };
		});
		return { ok: true, input: batch ? { ...input, tasks: mapped } : mapped[0]! };
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
