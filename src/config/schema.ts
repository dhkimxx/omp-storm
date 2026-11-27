import { MAX_WORKERS, REQUIRED_ROLES, ROLES } from "../roles.ts";
import { MAX_EXTRA_ROUNDS } from "../runtime/rounds.ts";
import { EFFORTS } from "../types.ts";
import type { Priority, StoredPriority, StormConfig } from "../types.ts";
import { escapeUnsafe } from "./canonical.ts";

export interface ConfigValidation {
	config?: StormConfig;
	errors: string[];
	warnings: string[];
}

/** Every priority a config file may carry; the last two are no longer offered. */
const STORED_PRIORITIES: readonly StoredPriority[] = ["balanced", "quality", "cost", "speed", "quota"];

/** The priority a config asks for: "speed" and "quota" changed nothing on real data and are read as "balanced". */
export function teamPriority(config: StormConfig): Priority {
	return config.priority === "speed" || config.priority === "quota" ? "balanced" : config.priority;
}

// `contract`, `runtime` and `contextCap` are retired: accepted without a warning and ignored.
const TOP_KEYS = [
	"version",
	"priority",
	"roles",
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
	"rounds",
	"requiredChecks",
	"jobs",
];
const ROLE_KEYS = ["agent", "models", "effort", "workers", "contextCap"];
const CHECK_KEYS = ["name", "argv", "timeoutMs"];
const JOB_KEYS = ["name", "argv", "resources", "timeoutMs"];
/** Bounds on `requiredChecks`: an approval row must stay readable and a run's obligations enumerable. */
export const MAX_REQUIRED_CHECKS = 8;
export const MAX_CHECK_NAME_LENGTH = 80;
export const MAX_CHECK_ARGS = 32;
export const MAX_CHECK_ARG_LENGTH = 1024;
export const MAX_CHECK_ARGV_LENGTH = 4096;
/** Bounds on `jobs`: the approval row stays readable and one run cannot queue an unbounded list. */
export const MAX_JOBS = 16;
export const MAX_JOB_RESOURCES = 8;
export const MAX_RESOURCE_KEY_LENGTH = 128;
/** A configured job may run a long experiment, but never without a real deadline. */
export const MAX_JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BUDGET_KEYS = ["perRunUsd", "warnAtUsd", "onExceed"];
const TRIAL_KEYS = ["id", "role", "model", "effort", "share", "maxSpawns", "startsAt", "endsAt", "budgetUsd"];
// Full timestamps with an explicit zone; date-only or zone-less strings parse differently across hosts.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
// "provider/id" with an optional ":<suffix>"; the id may contain more '/' (aggregator routes).
const MODEL_RE = /^[^\s/:]+\/[^\s]*[^\s/:]$/;
/** One configured or admitted `provider/id` selector: the same rule both paths use. */
export function validModelSelector(value: unknown): value is string {
	return typeof value === "string" && MODEL_RE.test(value);
}
/**
 * The largest admission record the store writes or reads, in encoded bytes. The user's approval is checked against the
 * same budget: a role's encoded model snapshot must leave room for the rest of the record, so a team is never approved
 * into a record the store would refuse. One bound, not a second count of models.
 */
export const MAX_ADMISSION_BYTES = 4 * 1024 * 1024;
/** Room the rest of an admission record (identity, lane policy paths, timestamps) may need inside that budget. */
const ADMISSION_RECORD_RESERVE = 512 * 1024;
export const MAX_APPROVED_BYTES = MAX_ADMISSION_BYTES - ADMISSION_RECORD_RESERVE;
// A portable resource key: ASCII only, no whitespace, no quoting; case-sensitive on purpose.
const RESOURCE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+=#-]*$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The one accepted resource-key form: bounded ASCII, no whitespace or quoting, case-sensitive. Keys are opaque to the
 * scheduler; they serialize work, never grant authority. A key that needs a path or model text is pre-hashed by the
 * caller instead of smuggled through this namespace.
 */
export function canonicalResourceKey(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_RESOURCE_KEY_LENGTH) return undefined;
	if (!RESOURCE_KEY_RE.test(value)) return undefined;
	return value.normalize("NFC");
}

function oneOf(v: unknown, allowed: readonly string[]): boolean {
	return typeof v === "string" && allowed.includes(v);
}

/** `path` extended by an object key; a key that is not a plain name is quoted, with unsafe characters escaped. */
function keyPath(path: string, key: string): string {
	if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return path ? `${path}.${key}` : key;
	return `${path}[${escapeUnsafe(JSON.stringify(key))}]`;
}

/** Fields Storm does not know, as "path" plus value: they do nothing, yet they are part of the hash the user approves. */
export function unknownFields(value: unknown): Array<{ path: string; value: unknown }> {
	const out: Array<{ path: string; value: unknown }> = [];
	const scan = (obj: unknown, known: readonly string[], path: string): void => {
		if (!isRecord(obj)) return;
		for (const [key, v] of Object.entries(obj)) if (!known.includes(key)) out.push({ path: keyPath(path, key), value: v });
	};
	if (!isRecord(value)) return out;
	scan(value, TOP_KEYS, "");
	if (isRecord(value.roles)) for (const [id, role] of Object.entries(value.roles)) scan(role, ROLE_KEYS, keyPath("roles", id));
	scan(value.budget, BUDGET_KEYS, "budget");
	if (Array.isArray(value.trials)) value.trials.forEach((t: unknown, i) => scan(t, TRIAL_KEYS, `trials[${i}]`));
	if (Array.isArray(value.requiredChecks)) {
		value.requiredChecks.forEach((check: unknown, i) => scan(check, CHECK_KEYS, `requiredChecks[${i}]`));
	}
	if (Array.isArray(value.jobs)) value.jobs.forEach((job: unknown, i) => scan(job, JOB_KEYS, `jobs[${i}]`));
	return out;
}

/**
 * Every string and every key of the config, unknown fields included, must be free of characters that can forge or
 * hide rows where the config is shown: the approval dialog guards a file that may come from a cloned repo.
 */
function unsafeText(value: unknown, path: string, errors: string[]): void {
	if (typeof value === "string") {
		if (escapeUnsafe(value) !== value) errors.push(`${path}: 제어 문자나 방향 제어 문자는 쓸 수 없습니다`);
	} else if (Array.isArray(value)) {
		value.forEach((item: unknown, i) => unsafeText(item, `${path}[${i}]`, errors));
	} else if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			const at = keyPath(path, key);
			if (escapeUnsafe(key) !== key) errors.push(`${at}: 필드 이름에 제어 문자나 방향 제어 문자는 쓸 수 없습니다`);
			unsafeText(item, at, errors);
		}
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

function validateTrials(trials: unknown, roleKeys: string[] | undefined, errors: string[]): void {
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

/**
 * `requiredChecks`: bounded ordered commands with unique names and unique argv, and an optional per-check time limit
 * bounded like a job's. Each argv is run directly, so no element may carry a control character (the whole config's
 * strings are already checked by `unsafeText`).
 */
function validateRequiredChecks(checks: unknown, errors: string[]): void {
	if (!Array.isArray(checks)) {
		errors.push("requiredChecks: 배열이어야 합니다");
		return;
	}
	if (checks.length > MAX_REQUIRED_CHECKS) {
		errors.push(`requiredChecks: 최대 ${MAX_REQUIRED_CHECKS}개까지 둘 수 있습니다`);
	}
	const names = new Set<string>();
	const commands = new Set<string>();
	checks.forEach((check: unknown, i) => {
		const path = `requiredChecks[${i}]`;
		if (!isRecord(check)) {
			errors.push(`${path}: 객체여야 합니다`);
			return;
		}
		const name = check.name;
		if (typeof name !== "string" || name.trim() === "") {
			errors.push(`${path}.name: 비어 있지 않은 문자열이어야 합니다`);
		} else if (name !== name.trim() || name.length > MAX_CHECK_NAME_LENGTH) {
			errors.push(`${path}.name: 앞뒤 공백 없이 ${MAX_CHECK_NAME_LENGTH}자 이하여야 합니다`);
		} else if (names.has(name)) {
			errors.push(`${path}.name: 중복된 이름입니다 (${name})`);
		} else {
			names.add(name);
		}
		const argv = check.argv;
		if (!Array.isArray(argv) || argv.length === 0) {
			errors.push(`${path}.argv: 실행 파일과 인자를 담은 배열이어야 합니다`);
			return;
		}
		if (argv.length > MAX_CHECK_ARGS) {
			errors.push(`${path}.argv: 실행 파일과 인자를 합쳐 최대 ${MAX_CHECK_ARGS}개까지 둘 수 있습니다`);
		}
		let valid = true;
		let total = 0;
		argv.forEach((arg: unknown, j) => {
			if (typeof arg !== "string") {
				errors.push(`${path}.argv[${j}]: 문자열이어야 합니다`);
				valid = false;
				return;
			}
			if (j === 0 && arg.trim() === "") {
				errors.push(`${path}.argv[0]: 실행 파일이 비어 있습니다`);
				valid = false;
			}
			if (arg.length > MAX_CHECK_ARG_LENGTH) {
				errors.push(`${path}.argv[${j}]: ${MAX_CHECK_ARG_LENGTH}자 이하여야 합니다`);
				valid = false;
			}
			total += arg.length;
		});
		if (total > MAX_CHECK_ARGV_LENGTH) {
			errors.push(`${path}.argv: 실행 파일과 인자를 합쳐 ${MAX_CHECK_ARGV_LENGTH}자 이하여야 합니다`);
			valid = false;
		}
		if (check.timeoutMs !== undefined && !isIntIn(check.timeoutMs, 1, MAX_JOB_TIMEOUT_MS)) {
			errors.push(`${path}.timeoutMs: 1~${MAX_JOB_TIMEOUT_MS} 사이 정수여야 합니다`);
		}
		if (!valid) return;
		const command = JSON.stringify(argv);
		if (commands.has(command)) errors.push(`${path}.argv: 중복된 명령입니다`);
		else commands.add(command);
	});
}

/**
 * `jobs`: bounded named commands with unique names, the same argv bounds as required checks, canonical resource keys
 * and a finite timeout. Unknown job fields only warn; `unsafeText` already rejects control and bidi characters.
 */
function validateJobs(jobs: unknown, errors: string[]): void {
	if (!Array.isArray(jobs)) {
		errors.push("jobs: 배열이어야 합니다");
		return;
	}
	if (jobs.length > MAX_JOBS) errors.push(`jobs: 최대 ${MAX_JOBS}개까지 둘 수 있습니다`);
	const names = new Set<string>();
	jobs.forEach((job: unknown, i) => {
		const path = `jobs[${i}]`;
		if (!isRecord(job)) {
			errors.push(`${path}: 객체여야 합니다`);
			return;
		}
		const name = job.name;
		if (typeof name !== "string" || name.trim() === "") {
			errors.push(`${path}.name: 비어 있지 않은 문자열이어야 합니다`);
		} else if (name !== name.trim() || name.length > MAX_CHECK_NAME_LENGTH) {
			errors.push(`${path}.name: 앞뒤 공백 없이 ${MAX_CHECK_NAME_LENGTH}자 이하여야 합니다`);
		} else if (names.has(name)) {
			errors.push(`${path}.name: 중복된 이름입니다 (${name})`);
		} else {
			names.add(name);
		}
		const argv = job.argv;
		if (!Array.isArray(argv) || argv.length === 0) {
			errors.push(`${path}.argv: 실행 파일과 인자를 담은 배열이어야 합니다`);
		} else {
			if (argv.length > MAX_CHECK_ARGS) {
				errors.push(`${path}.argv: 실행 파일과 인자를 합쳐 최대 ${MAX_CHECK_ARGS}개까지 둘 수 있습니다`);
			}
			let total = 0;
			argv.forEach((arg: unknown, j) => {
				if (typeof arg !== "string") {
					errors.push(`${path}.argv[${j}]: 문자열이어야 합니다`);
					return;
				}
				if (j === 0 && arg.trim() === "") errors.push(`${path}.argv[0]: 실행 파일이 비어 있습니다`);
				if (arg.length > MAX_CHECK_ARG_LENGTH) {
					errors.push(`${path}.argv[${j}]: ${MAX_CHECK_ARG_LENGTH}자 이하여야 합니다`);
				}
				total += arg.length;
			});
			if (total > MAX_CHECK_ARGV_LENGTH) {
				errors.push(`${path}.argv: 실행 파일과 인자를 합쳐 ${MAX_CHECK_ARGV_LENGTH}자 이하여야 합니다`);
			}
		}
		if (job.resources !== undefined) {
			if (!Array.isArray(job.resources)) {
				errors.push(`${path}.resources: 배열이어야 합니다`);
			} else {
				if (job.resources.length > MAX_JOB_RESOURCES) {
					errors.push(`${path}.resources: 최대 ${MAX_JOB_RESOURCES}개까지 둘 수 있습니다`);
				}
				const seen = new Set<string>();
				job.resources.forEach((resource: unknown, j) => {
					const key = canonicalResourceKey(resource);
					if (key === undefined) {
						errors.push(`${path}.resources[${j}]: ${MAX_RESOURCE_KEY_LENGTH}자 이하의 영문·숫자·. _ : / @ + = # - 자원 키여야 합니다`);
					} else if (seen.has(key)) {
						errors.push(`${path}.resources[${j}]: 중복된 자원 키입니다 (${key})`);
					} else {
						seen.add(key);
					}
				});
			}
		}
		if (job.timeoutMs !== undefined && !isIntIn(job.timeoutMs, 1, MAX_JOB_TIMEOUT_MS)) {
			errors.push(`${path}.timeoutMs: 1~${MAX_JOB_TIMEOUT_MS} 사이 정수여야 합니다`);
		}
	});
}

/**
 * Checks a parsed config against schema version 1. Unknown fields only warn; they still count toward the hash.
 * Fields earlier versions wrote (`contract`, `runtime`, `contextCap`, the priorities "speed" and "quota",
 * `workers: n`) stay valid.
 * No message carries a raw unsafe character: what a message quotes from the config is escaped.
 */
export function validateConfig(value: unknown): ConfigValidation {
	const errors: string[] = [];
	if (!isRecord(value)) return { errors: ["설정은 JSON 객체여야 합니다"], warnings: [] };
	const warnings = unknownFields(value).map((f) => `${f.path}: 알 수 없는 필드입니다`);
	unsafeText(value, "", errors);

	if (value.version !== 1) errors.push("version: 1이어야 합니다");
	if (!oneOf(value.priority, STORED_PRIORITIES)) errors.push("priority: balanced|quality|cost 중 하나여야 합니다");

	const roles = value.roles;
	if (!isRecord(roles) || Object.keys(roles).length === 0) {
		errors.push("roles: 역할이 하나 이상 있는 객체여야 합니다");
	} else {
		for (const id of REQUIRED_ROLES) if (!Object.hasOwn(roles, id)) errors.push(`roles.${id}: 꼭 있어야 하는 역할입니다`);
		for (const [id, role] of Object.entries(roles)) {
			const path = keyPath("roles", id);
			const spec = ROLES.find((r) => r.id === id);
			if (!spec) {
				errors.push(`${path}: Storm 역할(${ROLES.map((r) => r.id).join("|")})이 아닙니다`);
				continue;
			}
			if (!isRecord(role)) {
				errors.push(`${path}: 객체여야 합니다`);
				continue;
			}
			if (role.agent !== spec.agent) errors.push(`${path}.agent: ${spec.agent}여야 합니다`);
			if (!Array.isArray(role.models) || role.models.length === 0) {
				errors.push(`${path}.models: 모델이 하나 이상 있어야 합니다`);
			} else {
				role.models.forEach((m, i) => {
					if (!validModelSelector(m)) {
						errors.push(`${path}.models[${i}]: provider/id 형식이 아닙니다`);
					}
				});
				// The bytes that will be stored, including the role's effort on every entry: the record read and write
				// paths apply the same budget to the same encoding.
				const encoded = Buffer.byteLength(
					JSON.stringify(role.models.map(selector => (typeof role.effort === "string" ? { selector, effort: role.effort } : { selector }))),
				);
				if (encoded > MAX_APPROVED_BYTES) errors.push(`${path}.models: 승인 기록이 ${MAX_APPROVED_BYTES}바이트를 넘습니다`);
			}
			if (role.effort !== undefined && !oneOf(role.effort, EFFORTS)) {
				errors.push(`${path}.effort: ${EFFORTS.join("|")} 중 하나여야 합니다`);
			}
			if (role.workers !== undefined) validateWorkers(role.workers, `${path}.workers`, errors);
		}
	}

	if (value.rounds !== undefined && !isIntIn(value.rounds, 0, MAX_EXTRA_ROUNDS)) {
		errors.push(`rounds: 0~${MAX_EXTRA_ROUNDS} 사이 정수여야 합니다`);
	}
	if (value.cleanup !== undefined && typeof value.cleanup !== "boolean") errors.push("cleanup: true|false여야 합니다");
	if (value.docs !== undefined && typeof value.docs !== "boolean") errors.push("docs: true|false여야 합니다");
	if (!oneOf(value.isolation, ["isolated", "shared"])) errors.push("isolation: isolated|shared 중 하나여야 합니다");
	// Ignored, but covered by the hash and shown in the approval dialog: it must at least be printable text.
	if (value.contract !== undefined && typeof value.contract !== "string") errors.push("contract: 문자열이어야 합니다");
	if (value.runtime !== undefined && value.runtime !== "omp") errors.push("runtime: omp여야 합니다");

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
		}
	}

	// Role references are checked only when roles itself is valid enough to name keys.
	const roleKeys = isRecord(roles) ? Object.keys(roles) : undefined;
	if (value.fallbackRole !== undefined) {
		if (typeof value.fallbackRole !== "string" || (roleKeys !== undefined && !roleKeys.includes(value.fallbackRole))) {
			errors.push("fallbackRole: roles에 있는 역할이어야 합니다");
		}
	}
	if (value.trials !== undefined) validateTrials(value.trials, roleKeys, errors);
	if (value.disabledRoles !== undefined) validateDisabled(value.disabledRoles, roleKeys, errors);
	if (value.requiredChecks !== undefined) validateRequiredChecks(value.requiredChecks, errors);
	if (value.jobs !== undefined) validateJobs(value.jobs, errors);

	if (errors.length > 0) return { errors: errors.map(escapeUnsafe), warnings };
	return { config: value as unknown as StormConfig, errors, warnings };
}
