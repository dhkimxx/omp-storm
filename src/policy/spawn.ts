import { ROLE_AGENT_PREFIX } from "../roles.ts";
import type { SpawnDecision, SpawnEvent, SpawnState } from "../types.ts";

/** Decides how a spawn of a `storm-*` agent runs; other agents are left alone. */
export function decideSpawn(event: SpawnEvent, state: SpawnState): SpawnDecision {
	if (!event.agent.startsWith(ROLE_AGENT_PREFIX)) return undefined;
	const load = state.config;
	if (load.status === "missing") {
		return { block: true, reason: "Storm 설정이 없습니다. /storm 으로 팀을 설정하세요." };
	}
	if (load.status === "invalid") {
		return { block: true, reason: `Storm 설정 오류: ${load.errors[0] ?? "알 수 없는 오류"}` };
	}
	const approval = state.approval;
	// An approval for another hash must never authorize the current file.
	if (!approval || approval.status !== "active" || approval.configHash !== load.hash) {
		const short = load.hash.replace(/^jcs-sha256:/, "").slice(0, 12);
		return { block: true, reason: `승인되지 않은 Storm 설정입니다(${short}). /storm review 로 승인하세요.` };
	}
	const role = Object.values(load.config.roles).find(r => r.agent === event.agent);
	if (!role) return { block: true, reason: `Storm 설정에 ${event.agent} 역할이 없습니다.` };

	const approved = approval.scope.shadowedAgents;
	for (const shadow of state.shadows) {
		if (shadow.agent !== event.agent) continue;
		if (approved.some(a => a.agent === shadow.agent && a.sha256 === shadow.sha256)) continue;
		return {
			block: true,
			reason: `승인되지 않은 역할 정의가 있습니다: ${shadow.path}. /storm review 로 확인하세요.`,
		};
	}

	if (role.models.length === 0) return { block: true, reason: `Storm 설정의 ${event.agent} 역할에 모델이 없습니다.` };
	const effort = role.effort;
	// omp model patterns take thinking effort as a ":<level>" suffix on the id part.
	const models = effort
		? role.models.map(m => (m.slice(m.lastIndexOf("/") + 1).includes(":") ? m : `${m}:${effort}`))
		: [...role.models];
	return { model: models, note: `storm: ${event.agent} → ${models[0]}` };
}
