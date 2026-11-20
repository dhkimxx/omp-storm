import { EFFORTS, PRIORITIES } from "../types.ts";
import type { StormConfig } from "../types.ts";

export interface ConfigValidation {
	config?: StormConfig;
	errors: string[];
	warnings: string[];
}

const TOP_KEYS = ["version", "priority", "roles", "parallelism", "isolation", "contract", "runtime", "budget"];
const ROLE_KEYS = ["agent", "models", "effort"];
const BUDGET_KEYS = ["perRunUsd", "warnAtUsd", "onExceed"];
const AGENT_RE = /^storm-[a-z0-9-]+$/;
// "provider/id" with an optional ":<suffix>"; the id may contain more '/' (aggregator routes).
const MODEL_RE = /^[^\s/:]+\/[^\s]*[^\s/:]$/;

function isRecord(v: unknown): v is Record<string, unknown> {
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
			warnUnknown(role, ROLE_KEYS, path, warnings);
		}
	}

	const p = value.parallelism;
	if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 16) {
		errors.push("parallelism: 1~16 사이 정수여야 합니다");
	}
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

	warnUnknown(value, TOP_KEYS, "", warnings);

	if (errors.length > 0) return { errors, warnings };
	return { config: value as unknown as StormConfig, errors, warnings };
}
