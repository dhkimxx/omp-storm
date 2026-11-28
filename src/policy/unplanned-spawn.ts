/**
 * What a task item that matches no plan lane may do, and the plan-less batch check built on it (design-v3 R6, R9).
 *
 * This module is pure: it reads no table, registers no run and keeps no state. The placement and the spawn hook call
 * the same `classifyUnplannedItem`, so the authority a director's item gets is decided once, at its tool call, from
 * the approved definition's effective tools, its isolation placement and whether it carries eval-defined tools of its
 * own. An item that carries `tools` runs them in the director's eval kernel, outside any isolated checkout (HF-3), so
 * it is never `read` or `private`; an isolated item that carries them is refused. Everything else placed isolated is
 * `private`, whatever its tools, a shell included (owner decision D10).
 */
import { readOnlyWithShell, toolCapability, WHY_EXEC_WRITER, WHY_TOOLS_UNKNOWN, WHY_UNDECLARED_WRITER, type LanePolicy, type WriteAuthority } from "./capability.ts";

/** omp's effective task-isolation capability; an absent field is unknown, never false. */
export interface IsolationHost {
	/** `task.isolation.enabled`. */
	enabled?: boolean;
	/** `task.isolation.apply`; a placement that must stay out of the parent tree needs this to be false. */
	apply?: boolean;
}

/** Why an item that carries eval-defined tools is an unbounded shared writer; shown in a write-order refusal. */
export const WHY_ITEM_TOOLS = "항목이 정의한 도구가 있음";

/** The two task-call shape refusals the placement and the pre-open batch check share. */
export const TASK_ITEM_INVALID_REASON = "task 항목이 올바르지 않습니다.";
export const TASK_EMPTY_REASON = "task에 맡길 작업이 필요합니다.";

/** Native task trims the explicit name and uses the root session's default `task` for a blank name. */
export function taskAgentName(value: unknown): string {
	return (typeof value === "string" ? value.trim() : "") || "task";
}

/** What one unplanned item's classification depends on. */
export interface UnplannedItemFacts {
	agent: string;
	/** The director's own name for the item; absent when it gave none. Never a generated handle. */
	name?: string;
	/** Effective tools of the approved definition; undefined means the host default (every tool), never read-only. */
	tools: readonly string[] | undefined;
	/** The item carries a non-empty eval-defined `tools` list. */
	toolsCarried: boolean;
	/** The placement isolates this item: the item said `isolated: true`, or the team isolates every worker. */
	isolated: boolean;
}

/** One classified unplanned item: the policy the worker guard enforces and the authority the write table freezes. */
export interface UnplannedClassification {
	agent: string;
	policy: LanePolicy;
	authority: WriteAuthority;
}

export type UnplannedClassified = { ok: true; item: UnplannedClassification } | { ok: false; code: "isolation"; reason: string };

/** Whether an item's `tools` field carries anything. A malformed value counts as carrying: fail closed (D7). */
export function carriesEvalTools(item: Record<string, unknown>): boolean {
	const tools = item.tools;
	if (tools === undefined || tools === null) return false;
	if (Array.isArray(tools)) return tools.length > 0;
	return true;
}

/** Isolated placement with eval-defined tools of its own: the effect lands outside the checkout, with no reservation. */
export function isolatedToolsReason(agent: string): string {
	return `${agent}: 이 항목은 격리 실행을 요청했지만 eval로 정의한 도구를 함께 지정했습니다. 그 도구는 격리 체크아웃이 아니라 감독의 작업 폴더에서 실행되므로 공유 트리를 예약 없이 바꿀 수 있습니다. 격리를 빼거나 도구를 빼고 다시 보내세요.`;
}

/** An isolated placement with omp's isolation off or unreadable. */
export function unplannedIsolationUnavailableReason(agent: string, enabled: boolean | undefined, teamIsolated = false): string {
	const state = enabled === false ? "꺼져 있습니다(task.isolation.enabled=false)" : "상태를 확인하지 못했습니다";
	return `${agent}: 이 작업은 부모 트리와 분리된 격리 실행을 요청했는데 omp 격리가 ${state}. ` +
		"격리를 켜는 것은 사용자의 omp 설정(`omp config set task.isolation.enabled true`, 확인은 `omp config list --json`)입니다. " +
		(teamIsolated ? "이 팀은 모든 작업을 격리하므로 항목에서 isolated를 빼도 실행할 수 없습니다." : "지금 쓸 수 없으면 isolated를 빼고 공유 작업으로 다시 보내세요. 공유 쓰기 작업은 한 번에 하나씩 시작합니다.");
}

/** An isolated placement whose result omp would merge into the parent tree after the worker ended. */
export function unplannedIsolationApplyReason(agent: string, apply: boolean | undefined, teamIsolated = false): string {
	const head =
		apply === true
			? `${agent}: 이 작업은 부모 트리 밖에 남는 격리 결과를 요청했는데 omp가 격리 결과를 부모 작업 트리에 자동 적용합니다(task.isolation.apply=true). `
			: `${agent}: 이 작업은 부모 트리 밖에 남는 격리 결과를 요청했는데 omp가 격리 결과를 부모 작업 트리에 자동 적용하는지 확인하지 못했습니다(task.isolation.apply 값을 읽지 못함). 적용이 켜져 있으면 워커가 끝난 뒤 예약 없이 부모 트리가 바뀝니다. `;
	return head +
		"`omp config set task.isolation.apply false`로 적용을 끄고, `omp config list --json`으로 값을 확인한 뒤 다시 스폰하세요. " +
		(teamIsolated ? "이 팀은 모든 작업을 격리하므로 항목에서 isolated를 빼도 자동 적용 조건은 그대로입니다." : "결과를 부모 트리에 합쳐도 되면 isolated를 빼고 공유 작업으로 다시 보내세요.");
}

/**
 * The one classification of an unplanned item (R6/D10). The order matters: eval-defined tools run outside any
 * checkout, so they decide before isolation; isolation decides before the tool list, because a private checkout is not
 * a shared write however the worker's tools look. An unplanned item never gets `paths`: it declares no files.
 */
export function classifyUnplannedItem(facts: UnplannedItemFacts): UnplannedClassified {
	if (facts.toolsCarried) {
		if (facts.isolated) return { ok: false, code: "isolation", reason: isolatedToolsReason(facts.agent) };
		return {
			ok: true,
			item: {
				agent: facts.agent,
				policy: { kind: "unknown", reason: WHY_ITEM_TOOLS },
				authority: { kind: "unknown" },
			},
		};
	}
	if (facts.isolated) {
		return {
			ok: true,
			item: {
				agent: facts.agent,
				policy: { kind: "private", reason: "격리 체크아웃의 사적 산출물" },
				authority: { kind: "private" },
			},
		};
	}
	const tools = facts.tools;
	if (tools === undefined) {
		return {
			ok: true,
			item: {
				agent: facts.agent,
				policy: { kind: "unknown", reason: WHY_TOOLS_UNKNOWN },
				authority: { kind: "unknown" },
			},
		};
	}
	const capability = toolCapability(tools);
	if (capability.readOnly) {
		return {
			ok: true,
			item: {
				agent: facts.agent,
				policy: { kind: "read", reason: "실제 도구가 읽기 전용인 항목" },
				authority: { kind: "read" },
			},
		};
	}
	if (readOnlyWithShell(tools)) {
		return {
			ok: true,
			item: {
				agent: facts.agent,
				// A shell can change the tree, so the item is ordered like an exclusive writer (R6).
				policy: { kind: "read", reason: "읽기와 셸 실행만 하는 항목", shell: true },
				authority: { kind: "unknown" },
			},
		};
	}
	return {
		ok: true,
		item: {
			agent: facts.agent,
			policy: { kind: "unknown", reason: capability.exec ? WHY_EXEC_WRITER : WHY_UNDECLARED_WRITER },
			authority: { kind: "unknown" },
		},
	};
}

/** The facts of one task item; `teamIsolated` is `config.isolation === "isolated"`. */
export function unplannedFacts(
	item: Record<string, unknown>,
	agent: string,
	teamIsolated: boolean,
	tools: readonly string[] | undefined,
): UnplannedItemFacts {
	return {
		agent,
		...(typeof item.name === "string" ? { name: item.name } : {}),
		tools,
		toolsCarried: carriesEvalTools(item),
		isolated: teamIsolated || item.isolated === true,
	};
}

/** Whatever a classed batch tells its caller: the classifications and how many need the shared write order. */
export interface UnplannedBatch {
	items: readonly UnplannedClassification[];
	/** Items whose authority is a shared write (`paths`/`unknown`); the run needs the write lease when this is not 0. */
	writers: number;
}

export type UnplannedBatchResult = ({ ok: true } & UnplannedBatch) | { ok: false; code: "isolation" | "lane-write"; reason: string };

/** The refusal of a batch that would start two shared writers at once (G1). */
export function unplannedWriterConflictReason(first: string, second: string): string {
	return `같은 task 호출에 공유 작업 트리를 쓰는 작업이 둘 이상 있습니다(${first}, ${second}). 한 번에 하나만 보내고, 나머지는 그 작업이 끝난 뒤 보내세요. 읽기 전용과 격리 작업은 함께 보내도 됩니다.`;
}

/**
 * R9's pre-open gate: classifies a whole plan-less batch and refuses what the table would refuse against an empty
 * table. It has no side effects and needs no `RunLanes`, so the `task` handler can call it before a run exists.
 * Against an empty table the only shared-write conflict is inside the batch: every unplanned writer has an unknown
 * scope, so two of them always collide. O(items) time and no per-worker state.
 */
export function unplannedBatchGate(facts: readonly UnplannedItemFacts[], host?: IsolationHost, teamIsolated = false): UnplannedBatchResult {
	const items: UnplannedClassification[] = [];
	let isolated = false;
	for (const fact of facts) {
		const classified = classifyUnplannedItem(fact);
		if (!classified.ok) return { ok: false, code: classified.code, reason: classified.reason };
		items.push(classified.item);
		if (classified.item.authority.kind === "private") isolated = true;
	}
	if (isolated && host?.enabled !== true) {
		const first = items.find(item => item.authority.kind === "private")!;
		return { ok: false, code: "isolation", reason: unplannedIsolationUnavailableReason(first.agent, host?.enabled, teamIsolated) };
	}
	if (isolated && host?.apply !== false) {
		const first = items.find(item => item.authority.kind === "private")!;
		return { ok: false, code: "isolation", reason: unplannedIsolationApplyReason(first.agent, host?.apply, teamIsolated) };
	}
	const writers = items.filter(item => item.authority.kind !== "read" && item.authority.kind !== "private");
	if (writers.length > 1) {
		return {
			ok: false,
			code: "lane-write",
			reason: unplannedWriterConflictReason(writers[0]!.agent, writers[1]!.agent),
		};
	}
	return { ok: true, items, writers: writers.length };
}

export type UnplannedFactsResult =
	| { ok: true; items: readonly UnplannedItemFacts[] }
	| { ok: false; reason: string };

/**
 * The facts of one whole `task` call, for the pre-open gate. It reads only the call and the effective tools; nothing
 * is placed, named or reserved, so a refused batch leaves no trace.
 */
export function unplannedBatchFacts(
	input: unknown,
	teamIsolated: boolean,
	agentTools: (agent: string) => readonly string[] | undefined,
): UnplannedFactsResult {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: TASK_ITEM_INVALID_REASON };
	// Narrowed above to a plain object; `tasks` is re-checked before use.
	const call = input as { tasks?: unknown };
	const items: unknown[] = Array.isArray(call.tasks) ? call.tasks : [input];
	if (items.length === 0) return { ok: false, reason: TASK_EMPTY_REASON };
	const facts: UnplannedItemFacts[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return { ok: false, reason: TASK_ITEM_INVALID_REASON };
		// Narrowed above to a plain object; every read below re-checks its own type.
		const record = item as Record<string, unknown>;
		const agent = taskAgentName(record.agent);
		facts.push(unplannedFacts(record, agent, teamIsolated, agentTools(agent)));
	}
	return { ok: true, items: facts };
}
