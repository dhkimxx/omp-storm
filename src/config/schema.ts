import { MAX_WORKERS, REQUIRED_ROLES, ROLES } from "../roles.ts";
import { EFFORTS, PRIORITIES } from "../types.ts";
import type { StormConfig } from "../types.ts";

export interface ConfigValidation {
	config?: StormConfig;
	errors: string[];
	warnings: string[];
}

const TOP_KEYS = [
	"version",
	"priority",
	"roles",
	"parallelism",
	"isolation",
	"contract",
	"runtime",
	"budget",
	"fallbackRole",
	"trials",
	"disabledRoles",
	"contextCap",
	"cleanup",
	"docs",
];
const ROLE_KEYS = ["agent", "models", "effort", "workers", "contextCap"];
const MAX_CONTEXT_CAP = 10_000_000;
const BUDGET_KEYS = ["perRunUsd", "warnAtUsd", "onExceed"];
const TRIAL_KEYS = ["id", "role", "model", "effort", "share", "maxSpawns", "startsAt", "endsAt", "budgetUsd"];
// Full timestamps with an explicit zone; date-only or zone-less strings parse differently across hosts.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const AGENT_RE = /^storm-[a-z0-9-]+$/;
// "provider/id" with an optional ":<suffix>"; the id may contain more '/' (aggregator routes).
const MODEL_RE = /^[^\s/:]+\/[^\s]*[^\s/:]$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneOf(v: unknown, allowed: readonly string[]): boolean {
	return typeof v === "string" && allowed.includes(v);
}

function warnUnknown(obj: Record<string, unknown>, known: readonly string[], path: string, warnings: string[]): void {
	for (const key of Object.keys(obj)) {
		if (!known.includes(key)) warnings.push(`${path ? `${path}.` : ""}${key}: 알 수 없는 필드입니다`);
	}
}

function isPositiveNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isIntIn(v: unknown, min: number, max: number): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** A worker count 1..MAX_WORKERS, or a { min, max } range of them with min ≤ max. */
function validateWorkers(w: unknown, path: string, errors: string[]): void {
	if (isRecord(w)) {
		if (!isIntIn(w.min, 1, MAX_WORKERS) || !isIntIn(w.max, 1, MAX_WORKERS) || w.min > w.max || Object.keys(w).length !== 2) {
			errors.push(`${path}: {min, max}는 1 ≤ min ≤ max ≤ ${MAX_WORKERS} 정수여야 합니다`);
		}
	} else if (!isIntIn(w, 1, MAX_WORKERS)) errors.push(`${path}: 1~${MAX_WORKERS} 사이 정수 또는 {min, max}여야 합니다`);
}

/** Epoch ms of a zoned ISO 8601 timestamp, or undefined. */
function isoTime(v: unknown): number | undefined {
	if (typeof v !== "string" || !ISO_RE.test(v)) return undefined;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : undefined;
}

function validateTrials(trials: unknown, roleKeys: string[] | undefined, errors: string[], warnings: string[]): void {
	if (!Array.isArray(trials)) {
		errors.push("trials: 배열이어야 합니다");
		return;
	}
	const seen = new Set<string>();
	trials.forEach((t: unknown, i) => {
		const path = `trials[${i}]`;
		if (!isRecord(t)) {
			errors.push(`${path}: 객체여야 합니다`);
			return;
		}
		if (typeof t.id !== "string" || t.id.trim() === "") errors.push(`${path}.id: 비어 있지 않은 문자열이어야 합니다`);
		else if (seen.has(t.id)) errors.push(`${path}.id: 중복된 id입니다 (${t.id})`);
		else seen.add(t.id);
		if (typeof t.role !== "string" || (roleKeys !== undefined && !roleKeys.includes(t.role))) {
			errors.push(`${path}.role: roles에 있는 역할이어야 합니다`);
		}
		if (typeof t.model !== "string" || !MODEL_RE.test(t.model)) errors.push(`${path}.model: provider/id 형식이 아닙니다`);
		if (t.effort !== undefined && !oneOf(t.effort, EFFORTS)) {
			errors.push(`${path}.effort: ${EFFORTS.join("|")} 중 하나여야 합니다`);
		}
		if (!isPositiveNumber(t.share) || t.share > 1) errors.push(`${path}.share: 0보다 크고 1 이하인 숫자여야 합니다`);
		if (!isIntIn(t.maxSpawns, 1, 1000)) errors.push(`${path}.maxSpawns: 1~1000 사이 정수여야 합니다`);
		const start = isoTime(t.startsAt);
		const end = isoTime(t.endsAt);
		if (start === undefined) errors.push(`${path}.startsAt: 시간대가 있는 ISO 8601 시각이어야 합니다`);
		if (end === undefined) errors.push(`${path}.endsAt: 시간대가 있는 ISO 8601 시각이어야 합니다`);
		else if (start !== undefined && end <= start) errors.push(`${path}.endsAt: startsAt보다 뒤여야 합니다`);
		if (!isPositiveNumber(t.budgetUsd)) errors.push(`${path}.budgetUsd: 0보다 큰 숫자여야 합니다`);
		warnUnknown(t, TRIAL_KEYS, path, warnings);
	});
}

function validateDisabled(disabled: unknown, roleKeys: string[] | undefined, errors: string[]): void {
	if (!Array.isArray(disabled)) {
		errors.push("disabledRoles: 배열이어야 합니다");
		return;
	}
	const seen = new Set<string>();
	disabled.forEach((id: unknown, i) => {
		const path = `disabledRoles[${i}]`;
		if (typeof id !== "string" || !ROLES.some((r) => r.id === id)) errors.push(`${path}: Storm 역할 id여야 합니다`);
		else if (seen.has(id)) errors.push(`${path}: 중복된 역할입니다 (${id})`);
		else if ((REQUIRED_ROLES as readonly string[]).includes(id)) errors.push(`${path}: ${id} 역할은 끌 수 없습니다`);
		else if (roleKeys?.includes(id)) errors.push(`${path}: roles에 있는 역할은 끌 수 없습니다 (${id})`);
		if (typeof id === "string") seen.add(id);
	});
}

/** Checks a parsed config against schema version 1. Unknown fields only warn; they still count toward the hash. */
export function validateConfig(value: unknown): ConfigValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!isRecord(value)) return { errors: ["설정은 JSON 객체여야 합니다"], warnings };

	if (value.version !== 1) errors.push("version: 1이어야 합니다");
	if (!oneOf(value.priority, PRIORITIES)) errors.push(`priority: ${PRIORITIES.join("|")} 중 하나여야 합니다`);

	const roles = value.roles;
	if (!isRecord(roles) || Object.keys(roles).length === 0) {
		errors.push("roles: 역할이 하나 이상 있는 객체여야 합니다");
	} else {
		for (const [id, role] of Object.entries(roles)) {
			const path = `roles.${id}`;
			if (!isRecord(role)) {
				errors.push(`${path}: 객체여야 합니다`);
				continue;
			}
			if (typeof role.agent !== "string" || !AGENT_RE.test(role.agent)) {
				errors.push(`${path}.agent: storm-<이름> 형식이어야 합니다`);
			}
			if (!Array.isArray(role.models) || role.models.length === 0) {
				errors.push(`${path}.models: 모델이 하나 이상 있어야 합니다`);
			} else {
				role.models.forEach((m, i) => {
					if (typeof m !== "string" || !MODEL_RE.test(m)) {
						errors.push(`${path}.models[${i}]: provider/id 형식이 아닙니다`);
					}
				});
			}
			if (role.effort !== undefined && !oneOf(role.effort, EFFORTS)) {
				errors.push(`${path}.effort: ${EFFORTS.join("|")} 중 하나여야 합니다`);
			}
			if (role.workers !== undefined) validateWorkers(role.workers, `${path}.workers`, errors);
			if (role.contextCap !== undefined && !isIntIn(role.contextCap, 1, MAX_CONTEXT_CAP)) {
				errors.push(`${path}.contextCap: 1~${MAX_CONTEXT_CAP} 사이 정수여야 합니다`);
			}
			warnUnknown(role, ROLE_KEYS, path, warnings);
		}
	}

	const p = value.parallelism;
	if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 16) {
		errors.push("parallelism: 1~16 사이 정수여야 합니다");
	}
	if (value.contextCap !== undefined && !isIntIn(value.contextCap, 1, MAX_CONTEXT_CAP)) {
		errors.push(`contextCap: 1~${MAX_CONTEXT_CAP} 사이 정수여야 합니다`);
	}
	if (value.cleanup !== undefined && typeof value.cleanup !== "boolean") errors.push("cleanup: true|false여야 합니다");
	if (value.docs !== undefined && typeof value.docs !== "boolean") errors.push("docs: true|false여야 합니다");
	if (!oneOf(value.isolation, ["isolated", "shared"])) errors.push("isolation: isolated|shared 중 하나여야 합니다");
	if (!oneOf(value.contract, ["workflowz", "orchestrate"])) {
		errors.push("contract: workflowz|orchestrate 중 하나여야 합니다");
	}
	if (value.runtime !== "omp") errors.push("runtime: omp여야 합니다");

	const budget = value.budget;
	if (budget !== undefined) {
		if (!isRecord(budget)) {
			errors.push("budget: 객체여야 합니다");
		} else {
			if (!isPositiveNumber(budget.perRunUsd)) errors.push("budget.perRunUsd: 0보다 큰 숫자여야 합니다");
			if (budget.warnAtUsd !== undefined) {
				const limit = isPositiveNumber(budget.perRunUsd) ? budget.perRunUsd : Number.POSITIVE_INFINITY;
				if (!isPositiveNumber(budget.warnAtUsd) || budget.warnAtUsd > limit) {
					errors.push("budget.warnAtUsd: 0보다 크고 perRunUsd 이하여야 합니다");
				}
			}
			if (!oneOf(budget.onExceed, ["block-spawns", "stop"])) {
				errors.push("budget.onExceed: block-spawns|stop 중 하나여야 합니다");
			}
			warnUnknown(budget, BUDGET_KEYS, "budget", warnings);
		}
	}

	// Role references are checked only when roles itself is valid enough to name keys.
	const roleKeys = isRecord(roles) ? Object.keys(roles) : undefined;
	if (value.fallbackRole !== undefined) {
		if (typeof value.fallbackRole !== "string" || (roleKeys !== undefined && !roleKeys.includes(value.fallbackRole))) {
			errors.push("fallbackRole: roles에 있는 역할이어야 합니다");
		}
	}
	if (value.trials !== undefined) validateTrials(value.trials, roleKeys, errors, warnings);
	if (value.disabledRoles !== undefined) validateDisabled(value.disabledRoles, roleKeys, errors);

	warnUnknown(value, TOP_KEYS, "", warnings);

	if (errors.length > 0) return { errors, warnings };
	return { config: value as unknown as StormConfig, errors, warnings };
}
