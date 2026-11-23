/**
 * Checks a director's run plan against the approved team. Errors reject the plan; gaps (a role past its
 * worker max, a disabled or missing role) need an approved config change before the plan applies.
 */
import { isRecord } from "../config/schema.ts";
import { LANE_ROLES, ROLE_STAND_INS, ROLES, workerRange } from "../roles.ts";
import type { LaneKind, PlanLane, RoleId, RunPlan, StormConfig } from "../types.ts";

export type PlanGap =
	| { kind: "workers"; role: string; want: number; max: number }
	| { kind: "role"; role: string; state: "disabled" | "missing" };

export interface PlanCheck {
	/** Present when there are no errors, gaps or not. */
	plan?: RunPlan;
	errors: string[];
	outOfBounds: PlanGap[];
	warnings: string[];
}

export const MAX_LANES = 50;
/** Lane goal and progress are one-line labels, not reports; both trim and share this bound. */
export const MAX_LANE_TEXT = 200;
const LANE_KINDS = Object.keys(LANE_ROLES) as LaneKind[];
/** Lanes of these kinds change or occupy files; two of them on one file collide. */
const WRITING_KINDS: readonly LaneKind[] = ["code", "run"];

/** Goal and progress take the same shape: optional, trimmed, non-empty and bounded. */
function laneText(value: unknown, path: string, errors: string[]): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text) return undefined;
	if (text.length > MAX_LANE_TEXT) {
		errors.push(`${path}: ${MAX_LANE_TEXT}자 이하여야 합니다`);
		return undefined;
	}
	return text;
}

export function validatePlan(config: StormConfig, input: unknown, now: number): PlanCheck {
	const errors: string[] = [];
	const outOfBounds: PlanGap[] = [];
	const warnings: string[] = [];
	if (!isRecord(input)) return { errors: ["plan: 객체여야 합니다"], outOfBounds, warnings };
	const raw = input.lanes;
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LANES) {
		return { errors: [`plan.lanes: 레인 1~${MAX_LANES}개 배열이어야 합니다`], outOfBounds, warnings };
	}

	const lanes: PlanLane[] = [];
	const names = new Set<string>();
	const gapRoles = new Set<string>();
	raw.forEach((l: unknown, i) => {
		const path = `plan.lanes[${i}]`;
		if (!isRecord(l)) {
			errors.push(`${path}: 객체여야 합니다`);
			return;
		}
		const name = typeof l.name === "string" ? l.name.trim() : "";
		if (!name) errors.push(`${path}.name: 비어 있지 않은 문자열이어야 합니다`);
		else if (names.has(name)) errors.push(`${path}.name: 중복된 이름입니다 (${name})`);
		names.add(name);
		const kind = l.kind;
		if (typeof kind !== "string" || !(LANE_KINDS as string[]).includes(kind)) {
			errors.push(`${path}.kind: ${LANE_KINDS.join("|")} 중 하나여야 합니다`);
			return;
		}
		const files = l.files;
		if (files !== undefined && !(Array.isArray(files) && files.every((f) => typeof f === "string"))) {
			errors.push(`${path}.files: 문자열 배열이어야 합니다`);
			return;
		}
		let role: string | undefined;
		if (l.role !== undefined) {
			if (typeof l.role !== "string" || !ROLES.some((r) => r.id === l.role)) {
				errors.push(`${path}.role: Storm 역할 id여야 합니다 (${ROLES.map((r) => r.id).join("|")})`);
				return;
			}
			role = l.role;
			if (!Object.hasOwn(config.roles, role) && !gapRoles.has(role)) {
				gapRoles.add(role);
				outOfBounds.push({ kind: "role", role, state: config.disabledRoles?.includes(role) ? "disabled" : "missing" });
			}
		} else {
			const base = LANE_ROLES[kind as LaneKind];
			role = [base, ...ROLE_STAND_INS[base]].find((id: RoleId) => Object.hasOwn(config.roles, id));
			if (role === undefined) {
				errors.push(`${path}: ${kind} 레인을 맡을 역할이 설정에 없습니다. role을 지정하세요`);
				return;
			}
		}
		const lane: PlanLane = { name, kind: kind as LaneKind, role };
		if (files !== undefined) lane.files = [...(files as string[])];
		const goal = laneText(l.goal, `${path}.goal`, errors);
		if (goal !== undefined) lane.goal = goal;
		const progress = laneText(l.progress, `${path}.progress`, errors);
		if (progress !== undefined) lane.progress = progress;
		lanes.push(lane);
	});

	const used = [...new Set(lanes.map((l) => l.role))];
	const asked = input.workers;
	if (asked !== undefined && !isRecord(asked)) errors.push("plan.workers: 역할별 숫자 객체여야 합니다");
	const workers: Record<string, number> = {};
	if (isRecord(asked)) {
		for (const [role, n] of Object.entries(asked)) {
			// A worker count for a role without lanes changes nothing: the role cannot spawn in this run either way.
			if (!used.includes(role)) warnings.push(`plan.workers.${role}: 레인이 없는 역할이라 무시했습니다`);
			else if (typeof n !== "number" || !Number.isInteger(n) || n < 1) errors.push(`plan.workers.${role}: 1 이상 정수여야 합니다`);
		}
	}
	for (const role of used) {
		const range = workerRange(role, config.roles[role]);
		// Without a count the role gets one worker per lane, inside its approved range.
		const laneCount = lanes.filter((l) => l.role === role).length;
		const n = isRecord(asked) && typeof asked[role] === "number" ? asked[role] : Math.min(range.max, Math.max(range.min, laneCount));
		workers[role] = n;
		// A role being added gets its default range (workerRange of an absent role), so its max is checked too.
		if (n > range.max) outOfBounds.push({ kind: "workers", role, want: n, max: range.max });
	}

	const owner = new Map<string, string>();
	for (const l of lanes) {
		if (!WRITING_KINDS.includes(l.kind)) continue;
		for (const f of new Set(l.files ?? [])) {
			const other = owner.get(f);
			if (other !== undefined) warnings.push(`${f}: ${other}, ${l.name} 레인이 같은 파일을 맡습니다. 동시에 돌리면 충돌합니다`);
			else owner.set(f, l.name);
		}
	}

	if (errors.length) return { errors, outOfBounds, warnings };
	const plan: RunPlan = { lanes, workers, submittedAt: new Date(now).toISOString() };
	if (typeof input.note === "string" && input.note.trim()) plan.note = input.note.trim();
	return { plan, errors, outOfBounds, warnings };
}
