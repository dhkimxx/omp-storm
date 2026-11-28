/**
 * Checks a director's run plan against the approved team. Errors reject the plan; gaps (a role past its
 * worker max, a disabled or missing role) need an approved config change before the plan applies. A fresh plan must
 * declare at least one observable result on every deliverable lane; only a final review gate may omit them. Stored
 * plans are decoded by the tolerant readers instead and are never re-validated into synthetic obligations.
 */
import { isRecord } from "../config/schema.ts";
import { LANE_ROLES, ROLE_STAND_INS, ROLES, workerRange } from "../roles.ts";
import type {
	LaneKind,
	LaneNeed,
	LaneResultKind,
	PlanLane,
	PlanLaneDependency,
	PlanLaneResult,
	RoleId,
	RunPlan,
	StormConfig,
} from "../types.ts";

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

/**
 * Plan-size bounds: per-field sanity limits, not targets, plus one total-size limit. A real plan is a few tens of KiB
 * and any single field here is far beyond what one uses. Per-field limits alone cannot protect the record because
 * they multiply; MAX_PLAN_BYTES is the bound that does.
 */
export const MAX_LANES = 256;
/** Lane goal, progress, isolation reason and the plan note are prose, not reports; all trim and share this bound. */
export const MAX_LANE_TEXT = 4_000;
/** A lane name is a handle repeated by every dependency edge and message; long enough for any real one. */
export const MAX_LANE_NAME = 512;
/** A lane names required results; each is one observable claim, not a report. */
export const MAX_LANE_RESULTS = 48;
/** Stable ids are plan-wide identifiers, not prose: bounded and restricted so a typo cannot silently retarget one. */
export const MAX_RESULT_ID = 64;
export const MAX_RESULT_CRITERION = 4_000;
export const MAX_RESULT_CONTAINS = 4_000;
export const MAX_RESULT_PATH = 256;
/** A lane's write scope may name a large subsystem; the total plan bound, not this count, protects the record. */
export const MAX_LANE_FILES = 5_000;
/**
 * The plan's total charge in UTF-8 bytes: the serialized plan, its per-result contracts once more (the record keeps a
 * row per result with the contract), and a fixed row envelope (id, lane, state, 64-character identity, keys) per
 * result. At 2 MiB the largest plan and record this admits stay near 2.4 MB, about 29 % of RUN_RECORD_MAX_BYTES
 * (8 MiB); a real plan is a few tens of KiB.
 */
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;
/** The fixed part of one result row in the record, measured on `{id, lane, state, identity, contract}` at ~274 bytes. */
const RESULT_ROW_BYTES = 512;

/**
 * What the plan reply says beside any plan that places a lane in its own checkout (rows 7, 9, 11). Fixed size; the
 * plan reply is the first place the director reads it, the worker contract and closeout repeat the same facts.
 */
export const CHECKOUT_PLAN_NOTE = "분리 체크아웃은 작업 위치일 뿐 차단벽이 아니며, 만들어진 시점의 사본이라 사용자의 미커밋 변경도 들어갑니다. 정리는 호스트가 맡고 Storm은 확인하지 못합니다. 격리 후보는 정확한 ID를 선택하기 전까지 부모에 반영되지 않습니다.";
/** Row 5: an `integrated` prerequisite on an isolated producer waits for its explicit integration, never inferred. */
export const ISOLATED_INTEGRATED_WARNING = "격리 생산자를 선행으로 두고 need: integrated를 요구한 레인은 그 생산자의 후보를 이 실행에서 정확한 ID로 선택해 부모에 통합한 뒤 현재 수용 판정과 위치가 있어야 시작합니다. 선택 전에는 시작하지 않습니다.";
/** Row 6: two private lanes may implement together; their candidates can be selected one at a time and may conflict. */
export const PRIVATE_OVERLAP_WARNING = "두 레인 모두 격리 체크아웃에서 동시에 구현할 수 있지만, 후보를 부모 작업 트리에 함께 적용하면 충돌할 수 있습니다. 통합은 선택한 후보를 하나씩 적용하고, 겹치는 경로는 거부됩니다.";
export const RESULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RESULT_KINDS = ["change", "artifact", "answer"] as const satisfies readonly LaneResultKind[];
const RESULT_KEYS: Readonly<Record<string, true>> = {
	id: true,
	kind: true,
	criterion: true,
	path: true,
	contains: true,
	check: true,
};
/** A lane names a bounded set of prerequisites; one edge per prerequisite lane. */
export const MAX_LANE_DEPENDENCIES = 48;
/** The states a consumer may wait for. A prerequisite edge is plan input, never proof that its need holds. */
export const LANE_NEEDS = ["result", "integrated", "reviewable"] as const satisfies readonly LaneNeed[];
const DEPENDENCY_KEYS: Readonly<Record<string, true>> = { lane: true, need: true };
const LANE_KINDS = Object.keys(LANE_ROLES) as LaneKind[];
/** Lanes of these kinds change or occupy files; two of them on one file collide. */
const WRITING_KINDS: readonly LaneKind[] = ["code", "run"];
/**
 * Lanes that owe the user a deliverable: a tree change, an artifact, or a sourced answer. A `review` lane is a
 * gate over an already submitted integrated tree, not a deliverable, so it may omit results. Every other kind must
 * declare at least one observable contract on a fresh plan; stored plans written before this rule stay readable.
 */
const DELIVERABLE_KINDS: readonly LaneKind[] = ["explore", "code", "run", "design"];
/** A reason is one visible line: control characters, DEL and Unicode line separators would break that. */
const UNSAFE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Windows rejects these in file names, and a plan shared across hosts must not name a path one of them cannot open. */
const UNSAFE_PATH = /[<>:"|?*]/;

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

/**
 * Selective isolation is opt-in: absent means the lane shares the parent tree. A present value must be an actual
 * trimmed, non-empty, single safe line, bounded like the other lane labels; a boolean or a blank value is an error.
 */
function isolationText(value: unknown, path: string, errors: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		errors.push(`${path}: 격리 사유는 한 줄 문자열이어야 합니다`);
		return undefined;
	}
	if (UNSAFE_LINE.test(value)) {
		errors.push(`${path}: 제어 문자나 줄바꿈 없이 한 줄이어야 합니다`);
		return undefined;
	}
	const text = value.trim();
	if (!text) {
		errors.push(`${path}: 비어 있지 않은 격리 사유여야 합니다`);
		return undefined;
	}
	if (text.length > MAX_LANE_TEXT) {
		errors.push(`${path}: ${MAX_LANE_TEXT}자 이하여야 합니다`);
		return undefined;
	}
	return text;
}

/** A criterion: trimmed, non-empty, one visible line and bounded. */
function resultCriterion(value: unknown, path: string, errors: string[]): string | undefined {
	if (typeof value !== "string") {
		errors.push(`${path}: 문자열이어야 합니다`);
		return undefined;
	}
	if (UNSAFE_LINE.test(value)) {
		errors.push(`${path}: 제어 문자나 줄바꿈 없이 한 줄이어야 합니다`);
		return undefined;
	}
	const text = value.trim();
	if (!text) {
		errors.push(`${path}: 비어 있지 않은 문자열이어야 합니다`);
		return undefined;
	}
	if (text.length > MAX_RESULT_CRITERION) {
		errors.push(`${path}: ${MAX_RESULT_CRITERION}자 이하여야 합니다`);
		return undefined;
	}
	return text;
}

/**
 * `contains` is an exact literal: surrounding and internal whitespace is meaningful and kept as written, so the
 * observed text is compared with the declared bytes rather than a trimmed approximation. It must still be non-blank,
 * bounded, and free of NUL and non-printable controls (tab, newline and carriage return are allowed).
 */
function resultContains(value: unknown, path: string, errors: string[]): string | undefined {
	if (typeof value !== "string") {
		errors.push(`${path}: 문자열이어야 합니다`);
		return undefined;
	}
	if (value.trim() === "") {
		errors.push(`${path}: 공백만으로는 안 됩니다`);
		return undefined;
	}
	if (value.length > MAX_RESULT_CONTAINS) {
		errors.push(`${path}: ${MAX_RESULT_CONTAINS}자 이하여야 합니다`);
		return undefined;
	}
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
		errors.push(`${path}: NUL이나 출력할 수 없는 제어 문자 없이 적어야 합니다`);
		return undefined;
	}
	return value;
}

/**
 * A plan result path is workspace-relative and stays inside the tree: no absolute, drive, home, backslash or
 * traversal forms, and no character either a POSIX or Windows host would read as something other than a plain name.
 * Storm's own `.git`/`.omp` segments are protected. The value is returned unchanged, never normalized: two spellings
 * never silently become the same requirement.
 */
function resultPath(value: unknown, path: string, errors: string[]): string | undefined {
	if (typeof value !== "string") {
		errors.push(`${path}: 문자열이어야 합니다`);
		return undefined;
	}
	if (value.length > MAX_RESULT_PATH) {
		errors.push(`${path}: ${MAX_RESULT_PATH}자 이하여야 합니다`);
		return undefined;
	}
	if (!value || value.trim() !== value) {
		errors.push(`${path}: 앞뒤 공백 없는 작업 트리 기준 상대 경로여야 합니다`);
		return undefined;
	}
	if (UNSAFE_LINE.test(value) || UNSAFE_PATH.test(value) || value.includes("\\")) {
		errors.push(`${path}: 제어 문자, 역슬래시, < > : " | ? * 없이 한 줄이어야 합니다`);
		return undefined;
	}
	if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) {
		errors.push(`${path}: 작업 트리 기준 상대 경로여야 합니다`);
		return undefined;
	}
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		errors.push(`${path}: 빈 세그먼트나 . 또는 .. 없이 정규화된 상대 경로여야 합니다`);
		return undefined;
	}
	if (segments.some((segment) => segment === ".git" || segment === ".omp")) {
		errors.push(`${path}: .git 또는 .omp 내부 경로는 결과로 지정할 수 없습니다`);
		return undefined;
	}
	return value;
}

/** A result's check names one check already in the config that `validatePlan` was given; never a command line. */
function resultCheck(config: StormConfig | undefined, value: unknown, path: string, errors: string[]): string | undefined {
	if (typeof value !== "string") {
		errors.push(`${path}: 문자열이어야 합니다`);
		return undefined;
	}
	if (config === undefined) {
		errors.push(`${path}: 검사 이름을 확인할 승인 설정이 없습니다`);
		return undefined;
	}
	const checks = config.requiredChecks ?? [];
	if (checks.length === 0) {
		errors.push(`${path}: 이 설정에는 승인된 requiredChecks가 없습니다. 검사 이름을 빼거나 설정에서 검사를 승인하세요`);
		return undefined;
	}
	const matches = checks.filter((check) => check.name === value).length;
	if (matches !== 1) {
		errors.push(`${path}: 승인된 requiredChecks 이름이어야 합니다 (사용 가능: ${checks.map((check) => check.name).join(", ")})`);
		return undefined;
	}
	return value;
}

/**
 * Reads one lane's result wire into normalized `PlanLaneResult`s and collects every error. `ids` carries plan-wide
 * uniqueness: a requirement's id is its identity, so a second lane may not reuse one. Absent results stay absent.
 */
function readLaneResults(
	config: StormConfig | undefined,
	value: unknown,
	path: string,
	ids: Set<string>,
	errors: string[],
): PlanLaneResult[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LANE_RESULTS) {
		errors.push(`${path}: 결과 1~${MAX_LANE_RESULTS}개 배열이어야 합니다`);
		return undefined;
	}
	const results: PlanLaneResult[] = [];
	value.forEach((raw: unknown, i) => {
		const at = `${path}[${i}]`;
		if (!isRecord(raw)) {
			errors.push(`${at}: 객체여야 합니다`);
			return;
		}
		const unknown = Object.keys(raw).filter((field) => RESULT_KEYS[field] !== true);
		if (unknown.length > 0) {
			errors.push(`${at}: 알 수 없는 필드입니다 (${unknown.join(", ")})`);
			return;
		}
		const id = typeof raw.id === "string" ? raw.id : "";
		if (!RESULT_ID_RE.test(id)) {
			errors.push(`${at}.id: 영문·숫자로 시작하고 영문·숫자·. _ -만 쓰는 ${MAX_RESULT_ID}자 이하 id여야 합니다`);
		} else if (ids.has(id)) {
			errors.push(`${at}.id: 계획 안에서 중복된 결과 id입니다 (${id})`);
		} else {
			ids.add(id);
		}
		const kind = raw.kind;
		if (typeof kind !== "string" || !(RESULT_KINDS as readonly string[]).includes(kind)) {
			errors.push(`${at}.kind: ${RESULT_KINDS.join("|")} 중 하나여야 합니다`);
			return;
		}
		const resultKind = kind as LaneResultKind;
		if (raw.criterion === undefined) errors.push(`${at}.criterion: 필수입니다`);
		const criterion = raw.criterion === undefined ? undefined : resultCriterion(raw.criterion, `${at}.criterion`, errors);
		const result: PlanLaneResult = { id, kind: resultKind, criterion: criterion ?? "" };
		if (raw.path !== undefined) {
			const file = resultPath(raw.path, `${at}.path`, errors);
			if (file !== undefined) result.path = file;
		}
		if (raw.contains !== undefined) {
			const contains = resultContains(raw.contains, `${at}.contains`, errors);
			if (contains !== undefined) result.contains = contains;
		}
		if (raw.check !== undefined) {
			if (resultKind === "answer") {
				errors.push(`${at}.check: answer 결과에는 검사를 붙일 수 없습니다`);
			} else {
				const check = resultCheck(config, raw.check, `${at}.check`, errors);
				if (check !== undefined) result.check = check;
			}
		}
		results.push(result);
	});
	return results;
}

export type LaneResultParse = { ok: true; results: PlanLaneResult[] } | { ok: false; errors: string[] };

export interface ParseLaneResultsOptions {
	/** The config whose `requiredChecks` a `check` may name; absent means a check reference cannot be validated. */
	config?: StormConfig | undefined;
	/** Prefix of every error; the plan validator passes the lane field path. */
	path?: string | undefined;
	/** Ids already used in the plan; valid ids are added to it. Callers parsing a single lane may omit it. */
	ids?: Set<string> | undefined;
}

/**
 * The single parser of the `lane.results` wire. Plan validation and runtime evidence share it: normalization, bounds,
 * id rules, path containment and approved check names have one implementation. Absent results parse as no results:
 * stored legacy plans stay readable and gain no obligation or proof. The fresh-plan boundary is separate: it refuses
 * an omitted contract on every deliverable lane, so a newly authored plan cannot fall back to the legacy path.
 */
export function parseLaneResults(value: unknown, options: ParseLaneResultsOptions = {}): LaneResultParse {
	const errors: string[] = [];
	const results = readLaneResults(options.config, value, options.path ?? "results", options.ids ?? new Set<string>(), errors);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, results: results ?? [] };
}

/**
 * Reads one lane's `dependsOn` wire, collecting every entry-level error. Plan-wide checks (an unknown name, a self
 * reference, a cycle, `result` against a lane with no declared results) need every lane and run in `validatePlan`.
 * Absent dependencies stay absent: a legacy plan gains no edge and no obligation.
 */
function readLaneDependencies(value: unknown, path: string, errors: string[]): PlanLaneDependency[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LANE_DEPENDENCIES) {
		errors.push(`${path}: 선행 1~${MAX_LANE_DEPENDENCIES}개 배열이어야 합니다`);
		return undefined;
	}
	const dependencies: PlanLaneDependency[] = [];
	const seen = new Set<string>();
	value.forEach((raw: unknown, i) => {
		const at = `${path}[${i}]`;
		if (!isRecord(raw)) {
			errors.push(`${at}: 객체여야 합니다`);
			return;
		}
		const unknown = Object.keys(raw).filter((field) => DEPENDENCY_KEYS[field] !== true);
		if (unknown.length > 0) {
			errors.push(`${at}: 알 수 없는 필드입니다 (${unknown.join(", ")})`);
			return;
		}
		const lane = typeof raw.lane === "string" ? raw.lane.trim() : "";
		let validLane = false;
		if (!lane) {
			errors.push(`${at}.lane: 비어 있지 않은 레인 이름이어야 합니다`);
		} else if (UNSAFE_LINE.test(lane)) {
			errors.push(`${at}.lane: 제어 문자나 줄바꿈 없이 한 줄이어야 합니다`);
		} else if (lane.length > MAX_LANE_NAME) {
			errors.push(`${at}.lane: ${MAX_LANE_NAME}자 이하여야 합니다`);
		} else if (seen.has(lane)) {
			errors.push(`${at}.lane: 같은 선행 레인을 중복 참조했습니다 (${lane})`);
		} else {
			seen.add(lane);
			validLane = true;
		}
		const need = raw.need;
		if (typeof need !== "string" || !(LANE_NEEDS as readonly string[]).includes(need)) {
			errors.push(`${at}.need: ${LANE_NEEDS.join("|")} 중 하나여야 합니다`);
			return;
		}
		if (validLane) dependencies.push({ lane, need: need as LaneNeed });
	});
	return dependencies;
}

export type LaneDependencyParse = { ok: true; dependsOn: PlanLaneDependency[] } | { ok: false; errors: string[] };

export interface ParseLaneDependenciesOptions {
	/** Prefix of every error; the plan validator passes the lane field path. */
	path?: string | undefined;
}

/**
 * The single parser of the `lane.dependsOn` wire, for callers reading a plan without `validatePlan`. It checks entry
 * shape, bounds, duplicate prerequisite names and `need`; name resolution, self references and cycles need every lane
 * and stay in `validatePlan`. Absent input parses as no dependencies, so legacy records stay readable.
 */
export function parseLaneDependencies(value: unknown, options: ParseLaneDependenciesOptions = {}): LaneDependencyParse {
	const errors: string[] = [];
	const dependsOn = readLaneDependencies(value, options.path ?? "dependsOn", errors);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, dependsOn: dependsOn ?? [] };
}

/**
 * Plan-wide checks of the dependency graph: every edge names another lane of this plan, no lane waits on itself, no
 * prerequisite is repeated, and no cycle makes a start condition unreachable. A `result` edge must name a lane that
 * declares results, or the consumer would wait for a result the plan never promises. Nothing here reads evidence.
 */
function dependencyGraphErrors(lanes: readonly PlanLane[]): string[] {
	const errors: string[] = [];
	const byName = new Map(lanes.map((lane) => [lane.name, lane]));
	lanes.forEach((lane, i) => {
		(lane.dependsOn ?? []).forEach((dependency, j) => {
			const at = `plan.lanes[${i}].dependsOn[${j}]`;
			if (dependency.lane === lane.name) {
				errors.push(`${at}.lane: 자기 자신을 선행으로 참조할 수 없습니다 (${lane.name})`);
				return;
			}
			const producer = byName.get(dependency.lane);
			if (producer === undefined) {
				errors.push(`${at}.lane: 계획에 없는 레인입니다 (${dependency.lane})`);
				return;
			}
			if (dependency.need === "result" && producer.results === undefined) {
				errors.push(`${at}.lane: '${dependency.lane}' 레인이 필수 결과(results)를 선언하지 않아 result 선행을 제공할 수 없습니다`);
			}
		});
	});
	// A cycle is reported once with its path: without this the lanes on it would wait forever for one another.
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const visit = (name: string): string[] | undefined => {
		if (state.get(name) === "done") return undefined;
		if (state.get(name) === "visiting") return [...stack.slice(stack.indexOf(name)), name];
		state.set(name, "visiting");
		stack.push(name);
		for (const dependency of byName.get(name)?.dependsOn ?? []) {
			const producer = byName.get(dependency.lane);
			if (producer === undefined || producer.name === name) continue;
			const cycle = visit(producer.name);
			if (cycle !== undefined) return cycle;
		}
		stack.pop();
		state.set(name, "done");
		return undefined;
	};
	for (const lane of lanes) {
		const cycle = visit(lane.name);
		if (cycle !== undefined) {
			errors.push(`plan.lanes: 선행 관계에 순환이 있습니다 (${cycle.join(" → ")})`);
			break;
		}
	}
	return errors;
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
	const jobNames = new Set<string>();
	/** Result ids identify requirements across the whole plan, not just within their lane. */
	const resultIds = new Set<string>();
	const gapRoles = new Set<string>();
	raw.forEach((l: unknown, i) => {
		const path = `plan.lanes[${i}]`;
		if (!isRecord(l)) {
			errors.push(`${path}: 객체여야 합니다`);
			return;
		}
		const name = typeof l.name === "string" ? l.name.trim() : "";
		if (!name) errors.push(`${path}.name: 비어 있지 않은 문자열이어야 합니다`);
		else if (name.length > MAX_LANE_NAME) errors.push(`${path}.name: ${MAX_LANE_NAME}자 이하여야 합니다`);
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
		if (files !== undefined) {
			const list = files as string[];
			if (list.length > MAX_LANE_FILES) {
				errors.push(`${path}.files: 파일 ${MAX_LANE_FILES}개 이하여야 합니다`);
				return;
			}
		}
		const job = l.job;
		if (job !== undefined && (kind !== "run" || typeof job !== "string" || !config.jobs?.some(candidate => candidate.name === job))) {
			errors.push(`${path}.job: run 레인에는 팀 설정에 등록된 정형 작업 이름만 지정할 수 있습니다`);
			return;
		}
		if (job !== undefined && (l.role !== undefined || files !== undefined || l.isolationReason !== undefined)) {
			errors.push(`${path}.job: 실행 권한과 자원은 승인된 작업 정의에서 가져오므로 role·files·isolationReason을 같이 지정할 수 없습니다`);
			return;
		}
		let role: string | undefined;
		if (typeof job === "string") {
			if (jobNames.has(job)) {
				errors.push(`${path}.job: 같은 정형 작업을 한 계획의 여러 레인에 중복 지정할 수 없습니다 (${job})`);
				return;
			}
			jobNames.add(job);
			role = LANE_ROLES.run; // internal lane kind mapping only; no AI worker is allocated
		} else if (l.role !== undefined) {
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
		if (typeof job === "string") lane.job = job;
		if (files !== undefined) lane.files = [...(files as string[])];
		const goal = laneText(l.goal, `${path}.goal`, errors);
		if (goal !== undefined) lane.goal = goal;
		const reason = isolationText(l.isolationReason, `${path}.isolationReason`, errors);
		if (reason !== undefined) {
			if (role === "reviewer" || kind === "review") {
				errors.push(
					`${path}.isolationReason: 최종 리뷰 레인은 통합 트리를 봐야 하므로 격리할 수 없습니다. 독립 실험은 code/run 레인으로 분리해 따로 리뷰하세요`,
				);
			} else {
				lane.isolationReason = reason;
			}
		}
		const progress = laneText(l.progress, `${path}.progress`, errors);
		if (progress !== undefined) lane.progress = progress;
		const results = readLaneResults(config, l.results, `${path}.results`, resultIds, errors);
		if (results !== undefined) lane.results = results;
		if (lane.job !== undefined && results?.some(result =>
			result.kind !== "answer" || result.path !== undefined || result.contains === undefined || result.check !== undefined,
		)) {
			errors.push(`${path}.results: 정형 작업은 contains로 stdout의 실행 근거를 지정한 경로 없는 answer를 요구합니다. 의미 검증은 별도 레인으로 선언하세요`);
		}
		// A fresh plan owes an observable contract for every lane that delivers something. Only an omitted field is
		// this error: a present but malformed list already failed above and keeps its own precise message.
		if (l.results === undefined && DELIVERABLE_KINDS.includes(kind as LaneKind)) {
			const laneId = name ? `'${name}' ` : `${i}번째 `;
			errors.push(
				`${path}.results: ${laneId}레인(${kind})은 필수 결과(results: id, kind, criterion)를 하나 이상 선언해야 합니다. ` +
					"결과 없는 레인은 완료 근거가 없습니다. 검토 전용 review 레인만 생략할 수 있습니다",
			);
		}
		const dependsOn = readLaneDependencies(l.dependsOn, `${path}.dependsOn`, errors);
		if (dependsOn !== undefined) lane.dependsOn = dependsOn;
		lanes.push(lane);
	});

	// The graph needs every lane: an unknown name, a self reference, a repeated edge, a cycle or a `result` edge
	// against a lane without declared results rejects the plan before it can apply. Entry-level errors come first.
	if (errors.length === 0) errors.push(...dependencyGraphErrors(lanes));

	const workerLanes = lanes.filter(lane => lane.job === undefined);
	const used = [...new Set(workerLanes.map(lane => lane.role))];
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
		// Without an explicit count the role gets exactly its actual worker lanes, up to the approved maximum. A job
		// lane has no AI worker and never raises this count; its role is only an internal lane-kind mapping.
		const laneCount = workerLanes.filter(lane => lane.role === role).length;
		const n = isRecord(asked) && typeof asked[role] === "number" ? asked[role] : Math.min(range.max, Math.max(1, laneCount));
		workers[role] = n;
		// A role being added gets its default range (workerRange of an absent role), so its max is checked too.
		if (n > range.max) outOfBounds.push({ kind: "workers", role, want: n, max: range.max });
	}

	const owner = new Map<string, { name: string; isolated: boolean }>();
	for (const l of lanes) {
		if (!WRITING_KINDS.includes(l.kind)) continue;
		const privateLane = l.isolationReason !== undefined || config.isolation === "isolated";
		for (const f of new Set(l.files ?? [])) {
			const other = owner.get(f);
			if (other !== undefined) {
				// Row 6: two private lanes are allowed to implement at the same time; their candidates may still collide
				// on landing, and this version does not manage that landing. A shared writer keeps the old warning.
				warnings.push(
					other.isolated && privateLane
						? `${f}: ${other.name}, ${l.name} 레인이 같은 파일을 맡습니다. ${PRIVATE_OVERLAP_WARNING}`
						: `${f}: ${other.name}, ${l.name} 레인이 같은 파일을 맡습니다. 동시에 돌리면 충돌하니 순서를 나누세요`,
				);
			} else owner.set(f, { name: l.name, isolated: privateLane });
		}
	}
	// Rows 7, 9 and 11: one fixed-size qualification for any plan that uses a checkout, whatever the team size.
	if (config.isolation === "isolated" || lanes.some(lane => lane.isolationReason !== undefined)) warnings.push(CHECKOUT_PLAN_NOTE);
	// Row 5: an `integrated` edge on an isolated producer waits for that candidate's explicit integration; the plan
	// reply says so once, with the first affected consumer and how many there are.
	const isolatedProducers = new Set(
		lanes.filter(lane => lane.isolationReason !== undefined || config.isolation === "isolated").map(lane => lane.name),
	);
	const blocked: string[] = [];
	for (const lane of lanes) {
		for (const dependency of lane.dependsOn ?? []) {
			if (dependency.need === "integrated" && isolatedProducers.has(dependency.lane)) blocked.push(lane.name);
		}
	}
	if (blocked.length > 0) warnings.push(`${ISOLATED_INTEGRATED_WARNING} 대상 레인: ${blocked.slice(0, 3).join(", ")}${blocked.length > 3 ? ` 외 ${blocked.length - 3}개` : ""}`);

	const note = typeof input.note === "string" ? input.note.trim() : "";
	if (note.length > MAX_LANE_TEXT) errors.push(`plan.note: ${MAX_LANE_TEXT}자 이하여야 합니다`);
	if (errors.length) return { errors, outOfBounds, warnings };
	const plan: RunPlan = { lanes, workers, submittedAt: new Date(now).toISOString() };
	if (note) plan.note = note;
	// Every field may be legal on its own and the record still be unreadable: the record keeps the plan, a row per
	// result with that contract again, and a fixed row envelope. Charge all three, in the UTF-8 bytes actually written
	// (a character count would miss CJK text), so one number bounds the record whatever the mix.
	const results = lanes.flatMap(lane => lane.results ?? []);
	const bytes =
		Buffer.byteLength(JSON.stringify(plan), "utf8") +
		Buffer.byteLength(JSON.stringify(results), "utf8") +
		results.length * RESULT_ROW_BYTES;
	if (bytes > MAX_PLAN_BYTES) {
		return {
			errors: [
				`plan: 계획 전체 크기(결과 계약 사본 포함)가 ${bytes}바이트로 한도 ${MAX_PLAN_BYTES}바이트를 ${bytes - MAX_PLAN_BYTES}바이트 초과했습니다. 레인·필수 결과·텍스트·파일 목록을 줄여 다시 제출하세요`,
			],
			outOfBounds,
			warnings,
		};
	}
	return { plan, errors, outOfBounds, warnings };
}
