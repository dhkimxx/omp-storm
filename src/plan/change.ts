/** The config change a run plan past the team's bounds needs: raised worker maxima and added roles. */
import { validateConfig } from "../config/schema.ts";
import { recommendedConfig } from "../view/setup.ts";
import { roleTitle, workerRange } from "../roles.ts";
import type { RoleRecommendation, StormConfig } from "../types.ts";
import type { PlanGap } from "./validate.ts";

/** Storm's recommendations, needed only when a role must be added. */
export interface PlanRecommend {
	recs: RoleRecommendation[];
}

export type PlanChange = { config: StormConfig; summary: string } | { error: string };

/**
 * Adds disabled/missing roles the way setup builds them (the recommendation's pick and fallback, default worker
 * range), then raises worker maxima to what the plan asks.
 */
export function planChange(current: StormConfig, gaps: readonly PlanGap[], recommend?: PlanRecommend): PlanChange {
	const next = structuredClone(current);
	const parts: string[] = [];
	const added = gaps.filter((g) => g.kind === "role").map((g) => g.role);
	if (added.length) {
		if (!recommend) return { error: "역할을 추가하려면 추천이 필요합니다" };
		// Only the added roles are taken from this team, so its priority field does not matter.
		const team = recommendedConfig(recommend.recs, "balanced");
		for (const id of added) {
			const role = team.roles[id];
			if (!role) return { error: `${roleTitle(id)} 역할: 추천할 모델이 없어 추가할 수 없습니다` };
			next.roles[id] = role;
			parts.push(`${roleTitle(id)} 역할 추가`);
		}
		const disabled = next.disabledRoles?.filter((id) => !added.includes(id));
		if (disabled?.length) next.disabledRoles = disabled;
		else delete next.disabledRoles;
	}
	for (const g of gaps) {
		if (g.kind !== "workers") continue;
		const role = next.roles[g.role];
		if (!role) return { error: `${roleTitle(g.role)} 역할: 설정에 없는 역할입니다` };
		const range = workerRange(g.role, role);
		role.workers = { min: range.min, max: Math.max(range.max, g.want) };
		parts.push(`${roleTitle(g.role)} 워커 최대 ${range.max}→${role.workers.max}`);
	}
	const checked = validateConfig(next);
	if (!checked.config) return { error: `바뀐 설정이 올바르지 않습니다: ${checked.errors.join("; ")}` };
	return { config: checked.config, summary: `실행 계획에 맞춰 팀을 넓힙니다: ${parts.join(", ")}` };
}
