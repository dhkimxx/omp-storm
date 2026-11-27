/**
 * The plan in force as the director submitted it, with the state Storm holds for each required result. It answers the
 * director's own question "what did I plan and where does it stand" without a worker re-reading its transcript. Facts
 * only: the lanes' fields as validated at submission (nothing is summarized, so a replan can keep them exactly) and the
 * result rows' states as the run record has them now.
 */
import { roleTitle } from "../roles.ts";
import type { PlanLane, PlanLaneResult, RunPlan, RunResult, RunResultState } from "../types.ts";

/** What the host hands over for the run this session directs: its plan in force and its result rows. */
export interface PlanView {
	runId: string;
	plan?: RunPlan | undefined;
	results?: readonly RunResult[] | undefined;
}

/** Most characters of one plan view; lanes past it are counted, not shown. The plan itself is never cut. */
export const MAX_PLAN_VIEW_CHARS = 30_000;
/** Row 5: a plan view marks an `integrated` edge on an isolated producer as unsatisfiable in this version. */
export const INTEGRATED_UNAVAILABLE = "이 버전에서 충족 불가: 격리 생산자";

const STATE_LABEL: Readonly<Record<RunResultState, string>> = {
	pending: "대기",
	unmet: "미충족",
	reviewable: "검토 가능",
	accepted: "수용",
};

const quote = (text: string): string => JSON.stringify(text);

function resultLine(spec: PlanLaneResult, row: RunResult | undefined): string {
	const parts = [`${spec.id} (${spec.kind}) 기준 ${quote(spec.criterion)}`];
	if (spec.path !== undefined) parts.push(`경로 ${spec.path}`);
	if (spec.contains !== undefined) parts.push(`포함 ${quote(spec.contains)}`);
	if (spec.check !== undefined) parts.push(`검사 ${spec.check}`);
	const state = row === undefined ? "아직 기록 없음" : STATE_LABEL[row.state];
	const excluded = row?.scope === "excluded-by-user" ? ", 사용자가 범위에서 뺌" : "";
	const reason = row?.reason === undefined ? "" : ` — ${row.reason}`;
	return `  · ${parts.join(" · ")} → ${state}${excluded}${reason}`;
}

function laneLines(lane: PlanLane, rows: ReadonlyMap<string, RunResult>, isolatedProducers: ReadonlySet<string>): string[] {
	const head = [`- ${lane.name} (${lane.kind}, ${roleTitle(lane.role)})`];
	if (lane.goal !== undefined) head.push(`목표: ${lane.goal}`);
	if (lane.job !== undefined) head.push(`정형 작업: ${lane.job}`);
	if (lane.files !== undefined && lane.files.length > 0) head.push(`파일: ${lane.files.join(", ")}`);
	if (lane.isolationReason !== undefined) head.push(`격리: ${lane.isolationReason}`);
	if (lane.progress !== undefined) head.push(`진행: ${lane.progress}`);
	if (lane.dependsOn !== undefined && lane.dependsOn.length > 0) {
		const edges = lane.dependsOn.map(dependency => {
			const unmet = dependency.need === "integrated" && isolatedProducers.has(dependency.lane) ? ` · ${INTEGRATED_UNAVAILABLE}` : "";
			return `${dependency.lane}(${dependency.need})${unmet}`;
		});
		head.push(`선행: ${edges.join(", ")}`);
	}
	return [head.join(" · "), ...(lane.results ?? []).map(spec => resultLine(spec, rows.get(spec.id)))];
}

/**
 * The plan view as lines, or undefined when the run has no plan yet. Result rows the plan's lanes do not name (carried
 * over from an earlier plan) follow the lanes with their state, so nothing the run owes is left out.
 */
export function renderPlanView(view: PlanView): string | undefined {
	const plan = view.plan;
	if (plan === undefined || plan.lanes.length === 0) return undefined;
	const rows = new Map((view.results ?? []).map(row => [row.id, row] as const));
	const isolatedProducers = new Set(plan.lanes.filter(lane => lane.isolationReason !== undefined).map(lane => lane.name));
	const named = new Set(plan.lanes.flatMap(lane => (lane.results ?? []).map(spec => spec.id)));
	const out = [`이 실행(${view.runId})의 계획(제출 ${plan.submittedAt}), 레인 ${plan.lanes.length}개:`];
	if (plan.note !== undefined) out.push(`메모: ${plan.note}`);
	const workers = Object.entries(plan.workers).map(([role, count]) => `${roleTitle(role)} ${count}`);
	if (workers.length > 0) out.push(`워커: ${workers.join(", ")}`);
	let size = out.join("\n").length;
	let shown = 0;
	for (const lane of plan.lanes) {
		const lines = laneLines(lane, rows, isolatedProducers);
		size += lines.join("\n").length + 1;
		if (size > MAX_PLAN_VIEW_CHARS && shown > 0) break;
		out.push(...lines);
		shown += 1;
	}
	if (shown < plan.lanes.length) out.push(`- 외 ${plan.lanes.length - shown}개 레인은 길이 때문에 표시하지 않았습니다.`);
	const carried = (view.results ?? []).filter(row => !named.has(row.id));
	if (carried.length > 0) {
		out.push("이전 계획에서 이어진 결과:");
		for (const row of carried.slice(0, 50)) {
			out.push(`  · ${row.id} → ${STATE_LABEL[row.state]}${row.lane === undefined ? "" : ` · 레인 ${row.lane}`}`);
		}
		if (carried.length > 50) out.push(`  · 외 ${carried.length - 50}개`);
	}
	return out.join("\n");
}
