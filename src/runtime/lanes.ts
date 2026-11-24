import { createHash } from "node:crypto";
import { BUILTIN_AGENT_ROLES, ROLES, roleTitle, workerRange } from "../roles.ts";
import { scopesOverlap, type LanePolicy } from "../policy/capability.ts";
import { activeAgents, releaseWorkerSlot, reservedWorkers, reserveWorkerSlot } from "../policy/spawn.ts";
import type {
	AgentEntry,
	LaneNeed,
	LaneResultKind,
	PlanLane,
	RunPlan,
	RunResult,
	SpawnRecord,
	StormConfig,
} from "../types.ts";
import { requirementConflictFromPlan } from "./requirements.ts";

interface Assignment {
	lane: string;
	key: string;
	agent: string;
}

export type LaneBlockCode = "lane-dependency" | "lane-write" | "lane-capability" | "lane-job" | "lane-capacity";

type TaskBinding =
	| { ok: true; input: Record<string, unknown> }
	| { ok: false; reason: string; code?: LaneBlockCode; retry?: boolean };

/**
 * omp's effective task-isolation capability. An absent field is unknown, never false: a host that cannot prove
 * `task.isolation.enabled` must not be used for a spawn that needs isolation.
 */
export interface TaskIsolationHost {
	/** `task.isolation.enabled`. */
	enabled?: boolean;
	/** `task.isolation.apply`; a reason-marked lane needs this to be false so its result stays outside the parent. */
	apply?: boolean;
}

export interface TaskPlacementOptions {
	/** Automatic delegation reserves and rewrites task names; manual direction keeps the director's handles. */
	rewriteNames?: boolean;
	/** Live host capability; omitted means unknown. */
	host?: TaskIsolationHost;
	/** Approved write authority per plan lane; when present it replaces role-name guesses. */
	policies?: ReadonlyMap<string, LanePolicy>;
	/** Canonical workspace-relative scopes for a lane's declared files; absent keeps its declared paths. */
	canonicalFiles?: ReadonlyMap<string, readonly string[]>;
	/** Current facts of every prerequisite lane a plan may wait on; a dependency without an entry fails closed. */
	readiness?: LaneReadinessView;
	/** Live agents of this run, used only to expire reservations whose worker has already settled. */
	agents?: readonly AgentEntry[];
	now?: number;
}

/** One required result of a prerequisite lane, as the run's own result ledger currently knows it. */
export interface LaneResultReadiness {
	id: string;
	/** The declared result kind; absent only for a legacy fixture/hand-built view, never from the controller. */
	kind?: LaneResultKind;
	state: RunResult["state"];
	/** The integrated tree verifiably carries this accepted result (never inferred from a director's claim). */
	integrated: boolean;
	/** Full content version from the ledger; propagation shortens it. */
	version?: string;
	/** Declared workspace-relative path, for a short consumer reference. */
	path?: string;
	/** Attested source location of an accepted answer; never the answer's prose. */
	citation?: { path: string; line?: number };
	/** Verified retained isolated artifact: the exact source a consumer may read, never a guessed path. */
	retained?: { ref: string; path: string; digest?: string; kind: "patch" | "file" | "directory" | "parent-file" | "parent-files" };
	/** Why an otherwise observed result is not currently usable (for example a vanished retained artifact). */
	reason?: string;
}

/** What a consumer lane may use from one prerequisite lane. */
export interface LaneReadiness {
	/** Declared results in plan order; empty for a legacy lane that declared none. */
	results: readonly LaneResultReadiness[];
	/** An admitted worker of this lane actually settled and was not failed. */
	settled: boolean;
	/** The integrated tree verifiably holds this lane's accepted results. */
	integrated: boolean;
	/** A worker or attempt of this lane is still running: its current result is not final for a consumer. */
	running: boolean;
	/** The lane's admitted native agent id, so a consumer can read `agent://<id>` without a path guess. */
	handle?: string;
}

export type LaneReadinessView = ReadonlyMap<string, LaneReadiness>;

/**
 * How long a placed writer blocks another spawn before the host has shown its worker. It mirrors `PENDING_SPAWN_MS`:
 * a spawn that never starts or whose ledger binding never arrives frees its lane instead of blocking the run forever.
 */
export const PENDING_WRITE_MS = 30_000;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Write scope compares as a set of paths, matching the validator's duplicate-tolerant collision check. */
function normalizeFiles(lane: PlanLane): string[] {
	return [...new Set(lane.files ?? [])].sort();
}

/**
 * An old worker can still complete an unchanged lane, but not one whose goal, file scope or isolation placement
 * changed. `progress` is status text, never identity: it neither grants proof nor drops the proof already earned.
 * A shared lane keeps the exact key written before placement existed, so past evidence is not invalidated; only a
 * newly isolated lane adds the trailing marker, and changing the reason's wording does not alter it.
 */
function key(lane: PlanLane): string {
	const parts: unknown[] = [lane.name, lane.kind, lane.role, (lane.goal ?? "").trim(), normalizeFiles(lane)];
	if (lane.job !== undefined) parts.push(["job", lane.job]);
	if (lane.isolationReason !== undefined) parts.push(true);
	// A result contract is evidence identity, not status: a changed obligation must not inherit the old proof.
	if (lane.results !== undefined) parts.push(lane.results);
	return JSON.stringify(parts);
}

/**
 * Route identity for the exhausted-retry guard. Unlike `key`, the lane name is not an input: renaming a lane with the
 * same role, goal, file scope and isolation placement is the same route and earns no fresh planning allowance. A
 * different role, goal, file scope or placement is a genuinely different route the director may reassign to.
 */
export function laneRouteFingerprint(lane: PlanLane): string {
	const identity: unknown[] = [lane.kind, lane.role, (lane.goal ?? "").trim(), normalizeFiles(lane), lane.isolationReason !== undefined];
	// A job and an AI worker are different routes even with the same kind, goal and file scope. Added only when set so
	// existing worker-lane fingerprints keep their stored identity.
	if (lane.job !== undefined) identity.push(["job", lane.job]);
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 12);
}

/**
 * Why a replan is not the same plan, if a lane keeps its name but changes the identity its evidence is bound to.
 * A status update belongs in `progress`; an actual change needs a new lane name. Removing lanes is allowed, and a
 * new name starts with no evidence.
 */
export function replanConflict(previous: RunPlan | undefined, next: RunPlan): string | undefined {
	if (!previous) return undefined;
	const before = new Map(previous.lanes.map(lane => [lane.name, lane]));
	for (const lane of next.lanes) {
		const old = before.get(lane.name);
		if (!old) continue;
		const changed: string[] = [];
		if ((old.goal ?? "").trim() !== (lane.goal ?? "").trim()) changed.push("goal");
		if (old.kind !== lane.kind) changed.push("kind");
		if (old.role !== lane.role) changed.push("role");
		if (old.job !== lane.job) changed.push("job");
		if (JSON.stringify(normalizeFiles(old)) !== JSON.stringify(normalizeFiles(lane))) changed.push("files");
		if ((old.isolationReason !== undefined) !== (lane.isolationReason !== undefined)) changed.push("isolationReason");
		// A lane that declared nothing may gain its contract (the repair path). Once a lane has results, changing or
		// dropping them would silently rewrite or weaken the obligation, so that needs a new lane name.
		if (old.results !== undefined && JSON.stringify(old.results) !== JSON.stringify(lane.results ?? null)) changed.push("results");
		if (changed.length === 0) continue;
		return `계획 레인 '${lane.name}'의 ${changed.join(", ")} 항목이 바뀌었습니다. 진행 상태는 progress에 적고, 실제 변경은 새 레인 이름으로 내세요. 같은 이름으로 기존 증거를 조용히 덮어쓰거나 완화할 수 없습니다.`;
	}
	// The lane name is not the requirement: the same id may move to a new lane with the exact same contract, but a
	// renamed lane may not quietly rewrite the obligation the id already means.
	return requirementConflictFromPlan(previous, next);
}

function workerRole(config: StormConfig, agent: string): string | undefined {
	return Object.entries(config.roles).find(([, role]) => role.agent === agent)?.[0] ?? ROLES.find(role => role.agent === agent)?.id ??
		(Object.hasOwn(BUILTIN_AGENT_ROLES, agent) ? BUILTIN_AGENT_ROLES[agent] : undefined);
}

/**
 * One concrete lane per native task item for an active plan, or the first actionable refusal. This is the single
 * authority shared by the extension's pre-effect gate and `LaneMatcher.place`: an explicit isolation claim never
 * exempts an item from naming a lane, and every assigned lane is consumed once so duplicate items fail as a batch.
 */
export type PlannedTaskLanes =
	| { ok: true; lanes: PlanLane[] }
	| { ok: false; code: "lane" | "isolation"; reason: string };

export function plannedTaskLanes(input: unknown, plan: RunPlan, config: StormConfig): PlannedTaskLanes {
	if (!object(input)) return { ok: false, code: "lane", reason: "task 항목이 올바르지 않습니다." };
	const record = input as { tasks?: unknown };
	const items = Array.isArray(record.tasks) ? (record.tasks as unknown[]) : [input];
	if (items.length === 0) return { ok: false, code: "lane", reason: "task에 맡길 레인이 필요합니다." };
	const used = new Set<string>();
	const lanes: PlanLane[] = [];
	for (const item of items) {
		if (!object(item)) return { ok: false, code: "lane", reason: "task 항목이 올바르지 않습니다." };
		const agent = typeof item.agent === "string" ? item.agent : "task";
		const role = workerRole(config, agent);
		const name = typeof item.name === "string" ? item.name : undefined;
		const named = name === undefined ? undefined : plan.lanes.find(lane => lane.name === name);
		if (named !== undefined) {
			if (named.job !== undefined) {
				return {
					ok: false,
					code: "lane",
					reason: `${name}: 정형 작업(job: ${named.job}) 레인은 호스트 러너가 실행하며 AI 서브에이전트에 배정할 수 없습니다. task에는 job이 없는 워커 레인을 쓰세요.`,
				};
			}
			if (role === undefined || named.role !== role) {
				return {
					ok: false,
					code: "lane",
					reason: `${name}: 레인 역할 '${named.role}'과 task 역할 '${role ?? "알 수 없음"}(${agent})'이 다릅니다.`,
				};
			}
			if (used.has(named.name)) return { ok: false, code: "lane", reason: `${name}: 같은 배치에서 이미 사용한 레인입니다.` };
			used.add(named.name);
			lanes.push(named);
			continue;
		}
		// Manual direction keeps the caller's handle even when it is not a lane name; it still has to map by the one
		// authorized lane of that agent's role. An isolated claim without such a lane keeps its own refusal.
		const eligible = role === undefined
			? []
			: plan.lanes.filter(candidate => candidate.job === undefined && candidate.role === role && !used.has(candidate.name));
		if (eligible.length === 1) {
			used.add(eligible[0]!.name);
			lanes.push(eligible[0]!);
			continue;
		}
		if (item.isolated === true) {
			return {
				ok: false,
				code: "isolation",
				reason:
					"계획에 없는 직접 task는 isolated: true로 독립 결과를 주장할 수 없습니다. 독립 실험이 필요하면 storm plan에 isolationReason이 있는 레인을 만들고 task name을 그 레인에 맞추세요. 공유 작업이면 isolated를 빼세요.",
			};
		}
		if (role === undefined) {
			return { ok: false, code: "lane", reason: `${agent}: 승인된 팀 역할이나 계획 레인에 없는 에이전트입니다. 설정된 역할 에이전트나 계획의 레인을 쓰세요.` };
		}
		if (eligible.length === 0) {
			return { ok: false, code: "lane", reason: `${agent}: 역할 '${role}'에 이 배치가 쓸 수 있는 계획 레인이 없습니다.` };
		}
		return {
			ok: false,
			code: "lane",
			reason: `${agent}: 역할 '${role}'의 레인이 여러 개입니다. task name을 다음 중 하나로 지정하세요: ${eligible.map(lane => lane.name).join(", ")}`,
		};
	}
	return { ok: true, lanes };
}

/** The extension's pre-effect view of the same invariant; undefined means the plan is absent (no-plan behavior). */
export function taskLaneProblem(input: unknown, plan: RunPlan | undefined, config: StormConfig): { code: "lane" | "isolation"; reason: string } | undefined {
	if (plan === undefined) return undefined;
	const resolved = plannedTaskLanes(input, plan, config);
	return resolved.ok ? undefined : { code: resolved.code, reason: resolved.reason };
}

/** Adds, removes or keeps a task's `isolated` flag; an absent flag is the host's shared default. */
function withIsolation(item: Record<string, unknown>, desired: boolean | undefined): Record<string, unknown> {
	if (desired === undefined) {
		if (!Object.hasOwn(item, "isolated")) return item;
		const next = { ...item };
		delete next.isolated;
		return next;
	}
	return item.isolated === desired ? item : { ...item, isolated: desired };
}

function isolationCapabilityReason(agent: string, enabled: boolean | undefined): string {
	const state = enabled === false ? "꺼져 있습니다(task.isolation.enabled=false)" : "상태를 확인하지 못했습니다";
	return `${agent}: 이 작업은 부모 트리와 분리된 격리 실행이 필요한데 omp 격리가 ${state}. ` +
		"`omp config set task.isolation.enabled true`로 켜고 `omp config list --json`으로 확인한 뒤 다시 스폰하세요. " +
		"격리가 필요 없다면 계획의 isolationReason을 빼고 공유 레인으로 다시 계획하거나, 호스트가 격리를 지원하지 않으면 파일 범위를 나눈 순차 공유 레인으로 실행하세요.";
}

function isolationApplyReason(agent: string, lane: string, apply: boolean | undefined): string {
	const state = apply === true ? "켜져 있어(task.isolation.apply=true)" : "켜짐을 배제하지 못해";
	return `${agent}: '${lane}' 레인은 부모 트리 밖에 남는 독립 결과가 필요한데 omp가 격리 결과를 부모 작업 트리에 자동 적용합니다(${state}). ` +
		"`omp config set task.isolation.apply false`로 적용을 끄고 다시 스폰하세요. " +
		"결과를 부모 트리에 합쳐도 되면 그 레인의 isolationReason을 빼고 공유 레인으로 계획하고, 별도 결과가 필요하면 격리 레인을 분리해 patch/branch 산출물 경로를 결과로 받으세요.";
}

/** What a plan's prerequisite edge needs, in the shortest wording the director can act on. */
const NEED_LABEL: Readonly<Record<LaneNeed, string>> = {
	result: "필수 결과",
	integrated: "통합 반영",
	reviewable: "검토 가능 제출",
};

const STATE_LABEL: Readonly<Record<RunResult["state"], string>> = {
	pending: "대기",
	unmet: "미충족",
	reviewable: "검토 가능",
	accepted: "수용",
};

/** Whether an accepted result is usable for this edge from its current, verified location. */
function located(need: LaneNeed, result: LaneResultReadiness): boolean {
	if (need === "reviewable") return true;
	// A hand-built/legacy view carries no contract kind; only the state was ever known, so keep that old check. The
	// controller always supplies the kind, and these rules apply to real plans.
	if (result.kind === undefined) return true;
	// An answer's proof is the cited source it recorded; it has no patch to lose. It still cannot satisfy `integrated`.
	if (result.kind === "answer") return need !== "integrated";
	if (need === "integrated") return result.integrated;
	// A `result` edge needs the content a consumer would read now: the current parent, or the verified retained source
	// of an isolated artifact. Acceptance on an older version is not current input.
	return result.integrated || result.retained !== undefined;
}

/** Whether one prerequisite lane's current ledger facts satisfy the edge; a missing row is never satisfied. */
function dependencyShortfall(need: LaneNeed, state: LaneReadiness): string | undefined {
	// A lane that is still working may change the result the consumer would read. Its prior row is not final input.
	if (state.running) return "해당 레인의 워커가 아직 실행 중이라 현재 결과가 확정되지 않았습니다";
	const open = state.results.filter(result =>
		need === "reviewable"
			? result.state !== "reviewable" && result.state !== "accepted"
			: result.state !== "accepted" || !located(need, result),
	);
	if (state.results.length === 0) {
		// A legacy lane declared no results: only an admitted, settled worker is evidence. An `integrated` edge on a
		// shared lane additionally needs the parent tree to carry it; an empty answer cannot be integrated.
		if (need === "integrated") return state.integrated ? undefined : "부모 통합 트리에서 확인된 결과가 없습니다";
		return state.settled ? undefined : "아직 실행을 마친 워커가 없습니다";
	}
	if (open.length > 0) {
		return open
			.slice(0, 3)
			.map(result => {
				const why = result.reason === undefined ? "" : `: ${result.reason}`;
				const marker = result.state !== "accepted"
					? ""
					: need === "integrated"
						? ", 통합 미확인"
						: ", 현재 위치 미확인";
				return `${result.id}(${STATE_LABEL[result.state]}${marker}${why})`;
			})
			.join(", ") + (open.length > 3 ? ` 외 ${open.length - 3}건` : "");
	}
	if (need === "integrated") {
		// Rows with a contract kind are handled by `located`; this keeps a kindless legacy view fail-closed too.
		const unintegrated = state.results.filter(result => !result.integrated);
		if (unintegrated.length > 0) {
			return `${unintegrated.map(result => result.id).slice(0, 3).join(", ")} 결과가 부모 통합 트리에서 확인되지 않았습니다`;
		}
	}
	return undefined;
}

/** Why a lane may not start yet, or undefined when every declared prerequisite currently holds. */
export function dependencyBlock(lane: PlanLane, readiness: LaneReadinessView | undefined): string | undefined {
	for (const dependency of lane.dependsOn ?? []) {
		const state = readiness?.get(dependency.lane);
		if (state === undefined) {
			return `레인 '${lane.name}'의 선행 '${dependency.lane}'(${NEED_LABEL[dependency.need]}) 현재 상태를 확인하지 못해 시작하지 않았습니다. 계획과 실행 결과를 확인한 뒤 다시 스폰하세요.`;
		}
		const shortfall = dependencyShortfall(dependency.need, state);
		if (shortfall === undefined) continue;
		return `레인 '${lane.name}'은 선행 '${dependency.lane}'의 ${NEED_LABEL[dependency.need]}을 기다립니다: ${shortfall}. 해당 선행 레인이 끝난 뒤 다시 스폰하세요. 선행을 대신 실행하거나 같은 이름으로 결과를 주장하지 마세요.`;
	}
	return undefined;
}

const MAX_DEPENDENCY_NOTE = 600;

/**
 * The compact, trusted reference a consumer receives: stable result ids, states, short content versions, declared
 * relative paths, and — only for a retained isolated artifact — the host-bound ref and artifact path of the attempt
 * that produced it. That path is host-declared (never model prose) and is needed to read the artifact; it is not proof
 * of integration, and a changed or vanished source is rejected when the consumer's admission re-checks the digest. The
 * note never claims integration happened and never carries a command or file contents.
 */
export function dependencyRefs(lane: PlanLane, readiness: LaneReadinessView | undefined): string | undefined {
	if ((lane.dependsOn ?? []).length === 0) return undefined;
	const parts = (lane.dependsOn ?? []).map(dependency => {
		const state = readiness?.get(dependency.lane);
		const results = state?.results ?? [];
		const refs = results.length > 0
			? results
					.map(result => {
						const version = result.version === undefined ? "" : `@${result.version.slice(0, 8)}`;
						const integrated = dependency.need === "integrated" && result.integrated ? "·통합" : "";
						const path = result.path === undefined ? "" : ` ${result.path}`;
						const source = result.citation === undefined ? path : ` ${result.citation.path}:${result.citation.line ?? 1}`;
						const retained = result.retained === undefined ? "" : ` ref=${result.retained.ref} ${result.retained.path}`;
						return `${result.id}=${result.state}${integrated}${version}${source}${retained}`;
					})
					.join(",")
			: state?.settled === true
				? "settled"
				: "no-result";
		const handle = state?.handle === undefined ? "" : ` @agent://${state.handle}`;
		return `${dependency.lane}(${dependency.need}): ${refs}${handle}`;
	});
	const note = `[storm:dep] 선행 결과를 다시 만들지 말고 이 참조로 이어가세요. ${parts.join("; ")}`;
	return note.length > MAX_DEPENDENCY_NOTE ? `${note.slice(0, MAX_DEPENDENCY_NOTE - 1)}…` : note;
}

/** What one spawn may write in the shared tree; private isolated outputs never collide with the parent. */
type WriteScope =
	| { kind: "read" }
	| { kind: "private" }
	| { kind: "paths"; paths: string[] }
	| { kind: "unknown" };

/** Roles that do not change files: the lane may only read, whatever tools the host happens to offer. */
const READ_ONLY_ROLES: Readonly<Record<string, true>> = { explorer: true, reviewer: true, architect: true };
/** Roles whose lanes may change files even when the lane declared no file scope. */
const WRITING_ROLES: Readonly<Record<string, true>> = { implementer: true, quick: true };
const WRITING_KINDS: Readonly<Record<string, true>> = { code: true, run: true };

/**
 * A lane's shared write scope. An approved capability policy wins over role names: a read-only policy reserves nothing,
 * a private checkout is private, canonical paths may run beside disjoint paths, and an unknown policy is exclusive.
 * Without a policy (legacy/manual callers) declared files narrow a shared write, a write-capable role or a
 * change/artifact obligation without files is unknown, and only a genuinely read-only role is parallel with writers.
 */
function writeScope(
	lane: PlanLane | undefined,
	role: string | undefined,
	isolated: boolean,
	policy?: LanePolicy,
	canonicalFiles?: readonly string[],
	auto = false,
): WriteScope {
	if (isolated) return { kind: "private" };
	if (policy !== undefined) {
		if (policy.kind === "read") return { kind: "read" };
		if (policy.kind === "private") return { kind: "private" };
		if (policy.kind === "unknown" || policy.kind === "blocked" || auto) return { kind: "unknown" };
		return { kind: "paths", paths: [...new Set(canonicalFiles ?? policy.paths ?? lane?.files ?? [])].sort() };
	}
	if (lane !== undefined && (lane.files?.length ?? 0) > 0) {
		return auto ? { kind: "unknown" } : { kind: "paths", paths: normalizeFiles(lane) };
	}
	const laneRole = lane?.role ?? role;
	const changes = lane !== undefined && ((lane.results ?? []).some(result => result.kind !== "answer") || WRITING_KINDS[lane.kind] === true);
	if (changes || (laneRole !== undefined && WRITING_ROLES[laneRole] === true)) return { kind: "unknown" };
	if (laneRole !== undefined && READ_ONLY_ROLES[laneRole] === true) return { kind: "read" };
	return { kind: "unknown" };
}

/** Two shared writes collide when their path scopes overlap by directory prefix; an unknown scope can touch anything. */
function scopesConflict(a: WriteScope, b: WriteScope): boolean {
	if (a.kind === "unknown") return b.kind === "paths" || b.kind === "unknown";
	if (b.kind === "unknown") return a.kind === "paths";
	if (a.kind !== "paths" || b.kind !== "paths") return false;
	return scopesOverlap(a.paths, b.paths);
}

function scopeText(scope: WriteScope): string {
	if (scope.kind === "paths") return `파일 ${scope.paths.join(", ")}`;
	if (scope.kind === "unknown") return "쓰기 범위가 선언되지 않은 공유 작업";
	return "읽기 전용 작업";
}

function conflictText(lane: PlanLane | undefined, agent: string, scope: WriteScope, other: string, otherScope: WriteScope): string {
	const who = lane === undefined ? `${agent} 직접 작업` : `레인 '${lane.name}'`;
	return `${who}의 ${scopeText(scope)}이(가) ${other}의 ${scopeText(otherScope)}와 겹칩니다. 한 번에 시작하지 않았습니다. 겹치는 작업을 순서대로 나눠 제출하거나 쓰기 범위를 분리하세요.`;
}

interface WriteReservation {
	scope: WriteScope;
	lane?: string;
	agentId?: string;
	/** The handle reserved for this spawn before the host allocates its id; used only for release matching. */
	name?: string;
	at: number;
}

interface PlacedEntry {
	item: Record<string, unknown>;
	lane: PlanLane | undefined;
	agent: string;
	desired: boolean | undefined;
	requiresIsolation: boolean;
	selective: boolean;
	/** The approved write scope decided once for this whole call; later phases reuse it. */
	scope: WriteScope;
}

export interface FollowUpGateInput {
	/** The run whose spawn decisions and reactivations share one concurrency accounting. */
	runId?: string;
	/** The reused agent's id; its own in-flight reservation never blocks its continuation. */
	agentId: string;
	agent: string;
	role?: string;
	lane?: PlanLane;
	/** Approved write authority of the lane, when the extension resolved it. */
	policy?: LanePolicy;
	/** Canonical workspace-relative files for that policy. */
	canonicalFiles?: readonly string[];
	/** The plan in force when the lane was resolved; absent means no planned lane. */
	plan?: RunPlan;
	/** The approved team, for the plan's role caps. */
	config?: StormConfig;
	/**
	 * Live OMP `task.maxConcurrency` of the main session that owns this run: 0 is unlimited, absent is unknown.
	 * A genuine reactivation checks it with the same reservation count as a fresh spawn.
	 */
	maxConcurrency?: number;
	/** Running native workers outside this plan, proven to belong to the same scheduler. */
	otherActive?: number;
	/** `config.isolation === "isolated"`: every worker output stays private, so no shared write is reserved. */
	isolated: boolean;
	readiness?: LaneReadinessView;
	agents?: readonly AgentEntry[];
	now?: number;
}

export type FollowUpGate =
	| { ok: true; token: string; reserved?: boolean }
	| { ok: false; reason: string; code: LaneBlockCode; retry?: boolean };

/** One spawn's admission result: a lane when bound, or the reason a late reservation conflict refused it. */
export type LaneAdmission = { ok: true; lane?: string } | { ok: false; code: LaneBlockCode; reason: string };

/**
 * Correlates director task items to the actual ids OMP allocates. The host emits the allocated id, not the
 * planned lane name, in before_subagent_spawn. Reserve distinct valid names for each task even across replans.
 * Only the next matching spawn may consume a reservation. Nested children do not complete the director's lane.
 * Placement is also the one isolation authority: shared teams reserve the parent tree for every ordinary item,
 * a lane's isolationReason asks for a separate result, and legacy `isolation: isolated` teams isolate every spawn,
 * the final reviewer included. The extension certifies a reviewer only against the checkout it actually read.
 */
export class RunLanes {
	readonly #assigned = new Map<string, Assignment>();
	readonly #admitted = new Map<string, Assignment>();
	/** Latest admitted agent of a lane: a read-only handle a consumer may inspect (`agent://<id>`). */
	readonly #agents = new Map<string, string>();
	/** Shared write scopes placed but not yet released; private/read-only work never appears here. */
	readonly #writes = new Map<string, WriteReservation>();
	/** Follow-up admission tokens; only a failed preflight releases the write/capacity reservations it created. */
	readonly #followTokens = new Map<string, { key?: string; created: boolean; capacityKey?: string; lane?: string }>();
	#serial = 0;
	#writeSerial = 0;
	#tokenSerial = 0;

	constructor(private readonly runId: string) {}

	/** Automatic delegation: bind every item to a lane, reserve a unique spawn name, and set its isolation placement. */
	assign(
		input: unknown,
		plan: RunPlan,
		config: StormConfig,
		options: Omit<TaskPlacementOptions, "rewriteNames"> = {},
	): TaskBinding {
		return this.place(input, plan, config, { ...options, rewriteNames: true });
	}

	/**
	 * Applies one plan's lane and isolation placement to a native task call before omp allocates spawn ids. With an
	 * active plan every item must resolve to one concrete authorized lane first; manual direction keeps the caller's
	 * handle but no longer admits an ambiguous item. A plan-less call keeps ordinary unplanned behavior. Nothing is
	 * reserved until the whole call, lane gate and host capability are accepted, so a rejection leaves no reservations.
	 */
	place(input: unknown, plan: RunPlan | undefined, config: StormConfig, options: TaskPlacementOptions = {}): TaskBinding {
		if (!object(input)) return { ok: false, reason: "작업 계획의 레인 이름과 역할로 task를 호출하세요." };
		const batch = Array.isArray(input.tasks);
		const items: unknown[] = batch ? input.tasks as unknown[] : [input];
		if (!items.length) return { ok: false, reason: "task에 맡길 레인이 필요합니다." };
		const planned = plan === undefined ? undefined : plannedTaskLanes(input, plan, config);
		if (planned !== undefined && !planned.ok) return { ok: false, reason: planned.reason };
		const rewrite = options.rewriteNames === true;
		const teamIsolated = config.isolation === "isolated";
		const used = new Set<string>();
		const placed: PlacedEntry[] = [];
		for (const [index, item] of items.entries()) {
			if (!object(item)) return { ok: false, reason: "task 항목이 올바르지 않습니다." };
			const agent = typeof item.agent === "string" ? item.agent : "task";
			const role = workerRole(config, agent);
			let lane: PlanLane | undefined;
			if (planned !== undefined && planned.ok) {
				lane = planned.lanes[index];
			} else {
				const named = typeof item.name === "string" ? plan?.lanes.find(candidate => candidate.name === item.name) : undefined;
				const eligible = plan === undefined || role === undefined
					? []
					: plan.lanes.filter(candidate => candidate.job === undefined && candidate.role === role && !used.has(candidate.name));
				lane = named ?? (eligible.length === 1 ? eligible[0] : undefined);
				const unambiguous = lane !== undefined && lane.role === role && !used.has(lane.name);
				if (rewrite && !unambiguous) {
					return { ok: false, reason: `${agent}: 승인된 계획의 담당 역할과 같은 레인 이름을 task의 name에 지정하세요. 예: ${eligible.map(candidate => candidate.name).join(", ") || "맞는 레인 없음"}` };
				}
				if (!unambiguous) lane = undefined;
			}
			const policy = lane === undefined ? undefined : options.policies?.get(lane.name);
			if (policy?.kind === "blocked") return { ok: false, code: "lane-capability", reason: policy.reason };
			const reason = lane?.isolationReason;
			if (reason !== undefined && lane !== undefined && (lane.role === "reviewer" || lane.kind === "review")) {
				return { ok: false, reason: `${agent}: 최종 리뷰는 통합 트리를 봐야 하므로 격리 레인이 될 수 없습니다. isolationReason을 빼거나 독립 실험을 별도 code/run 레인으로 분리하세요.` };
			}
			let desired: boolean | undefined;
			let requiresIsolation = false;
			let selective = false;
			if (teamIsolated) {
				desired = true;
				requiresIsolation = true;
			} else if (reason !== undefined) {
				desired = true;
				requiresIsolation = true;
				selective = true;
			} else if (lane === undefined && item.isolated === true) {
				return { ok: false, reason: `${agent}: 계획에 없는 직접 task는 isolated: true로 독립 결과를 주장할 수 없습니다. 독립 실험이 필요하면 storm plan에 isolationReason이 있는 레인을 만들고 task name을 그 레인에 맞추세요. 공유 작업이면 isolated를 빼세요.` };
			}
			if (lane !== undefined) used.add(lane.name);
			const scope = writeScope(
				lane,
				role,
				requiresIsolation,
				policy,
				lane === undefined ? undefined : options.canonicalFiles?.get(lane.name),
				rewrite,
			);
			placed.push({ item, lane, agent, desired, requiresIsolation, selective, scope });
		}
		const needing = placed.find(entry => entry.requiresIsolation);
		if (needing !== undefined && options.host?.enabled !== true) {
			return { ok: false, reason: isolationCapabilityReason(needing.agent, options.host?.enabled) };
		}
		const selective = placed.find(entry => entry.selective);
		if (selective !== undefined && options.host?.apply !== false) {
			return { ok: false, reason: isolationApplyReason(selective.agent, selective.lane!.name, options.host?.apply) };
		}
		// Dependencies and shared writes are decided for the whole call before any name or lane is reserved: a refused
		// batch leaves no partial spawn, reservation or assignment behind.
		const gate = this.#gate(placed, options);
		if (!gate.ok) return gate;
		const now = options.now ?? Date.now();
		const mapped = placed.map(entry => {
			let next = withIsolation(entry.item, entry.desired);
			if (rewrite) {
				// Every auto item was accepted only after matching a lane above.
				const lane = entry.lane as PlanLane;
				const name = `${this.runId}-lane-${++this.#serial}`;
				this.#assigned.set(name, { key: key(lane), lane: lane.name, agent: entry.agent });
				next = { ...next, name };
			}
			// Only a consumer with declared prerequisites receives a reference: no extra text on a legacy plan.
			const refs = entry.lane === undefined ? undefined : dependencyRefs(entry.lane, options.readiness);
			if (refs !== undefined && typeof next.task === "string" && next.task.trim() !== "") {
				next = { ...next, task: `${next.task.trimEnd()}\n\n${refs}` };
			}
			this.#reserveWrite(entry, now);
			return next;
		});
		if (!batch) return { ok: true, input: mapped[0]! };
		// omp falls back to a top-level `isolated` for every batch item that omitted its own flag. Placement is
		// per-item here, so the stale top-level shorthand must not isolate a shared item behind our back.
		const next: Record<string, unknown> = { ...input, tasks: mapped };
		delete next.isolated;
		return { ok: true, input: next };
	}

	/** Consume an approved spawn's reservation. Manual task handles are retained, binding only unambiguous lanes. */
	admit(
		spawn: Pick<SpawnRecord, "spawnKey" | "agent" | "outcome">,
		manual?: { plan: RunPlan; config: StormConfig },
	): string | undefined {
		const admission = this.#admit(spawn, manual, false);
		return admission.ok ? admission.lane : undefined;
	}

	/**
	 * The same admission with the late-writer fence: after the host allocates the spawn key, a reservation whose pending
	 * window expired must not slip past a writer that now overlaps. Callers that can act on the refusal use this one.
	 */
	admitChecked(
		spawn: Pick<SpawnRecord, "spawnKey" | "agent" | "outcome">,
		manual?: { plan: RunPlan; config: StormConfig },
	): LaneAdmission {
		return this.#admit(spawn, manual, true);
	}

	#admit(
		spawn: Pick<SpawnRecord, "spawnKey" | "agent" | "outcome">,
		manual: { plan: RunPlan; config: StormConfig } | undefined,
		recheck: boolean,
	): LaneAdmission {
		if (!spawn.spawnKey) return { ok: true };
		let assignment = this.#assigned.get(spawn.spawnKey);
		if (assignment && assignment.agent !== spawn.agent) return { ok: true };
		this.#assigned.delete(spawn.spawnKey);
		// Resolve a manual lane before a refusal: a blocked spawn must still release the lane it would have used.
		if (!assignment && manual) {
			const role = workerRole(manual.config, spawn.agent);
			const eligible = manual.plan.lanes.filter(lane => lane.job === undefined && lane.role === role);
			const name = spawn.spawnKey.split(".").at(-1);
			const lane = eligible.find(item => item.name === name) ?? (eligible.length === 1 ? eligible[0] : undefined);
			if (lane) assignment = { lane: lane.name, key: key(lane), agent: spawn.agent };
		}
		if (spawn.outcome === "blocked") {
			this.#releaseSpawn(spawn.spawnKey, assignment?.lane);
			return { ok: true };
		}
		// A manual unplanned child still holds the unknown shared scope reserved at placement; bind it to this id.
		this.#bindWrite(spawn.spawnKey, assignment?.lane);
		if (!assignment) return { ok: true };
		if (recheck) {
			const ownKey = `lane:${assignment.lane}`;
			const lane = manual?.plan.lanes.find(candidate => candidate.name === assignment!.lane);
			const scope = this.#writes.get(ownKey)?.scope ??
				(manual !== undefined && lane !== undefined ? writeScope(lane, workerRole(manual.config, spawn.agent), false) : undefined);
			if (scope !== undefined && (scope.kind === "paths" || scope.kind === "unknown")) {
				for (const [key, reservation] of this.#writes) {
					if (key === ownKey || reservation.agentId === spawn.spawnKey) continue;
					if (!scopesConflict(scope, reservation.scope)) continue;
					const other = reservation.lane === undefined ? "진행 중인 공유 작업" : `레인 '${reservation.lane}'`;
					const reason = conflictText(lane, spawn.agent, scope, other, reservation.scope);
					this.#releaseSpawn(spawn.spawnKey, assignment.lane);
					return { ok: false, code: "lane-write", reason };
				}
			}
		}
		this.#admitted.set(spawn.spawnKey, assignment);
		this.#agents.set(assignment.lane, spawn.spawnKey);
		return { ok: true, lane: assignment.lane };
	}

	/** The latest agent admitted for a lane, as the host id a consumer can read; never a guessed handle. */
	agentForLane(lane: string): string | undefined {
		return this.#agents.get(lane);
	}

	/**
	 * Decides one whole native task call before anything is reserved: every declared prerequisite must currently hold,
	 * and shared writers in this batch (or against an active reservation) must not overlap. A refusal is batch-wide.
	 */
	#gate(
		placed: readonly PlacedEntry[],
		options: TaskPlacementOptions,
	): { ok: true } | { ok: false; reason: string; code: LaneBlockCode; retry: boolean } {
		const now = options.now ?? Date.now();
		this.#pruneWrites(options.agents, now);
		const scopes = placed;
		for (const entry of scopes) {
			if (entry.lane === undefined) continue;
			const reason = dependencyBlock(entry.lane, options.readiness);
			if (reason !== undefined) return { ok: false, reason, code: "lane-dependency", retry: false };
		}
		for (let i = 0; i < scopes.length; i++) {
			const a = scopes[i]!;
			for (let j = i + 1; j < scopes.length; j++) {
				const b = scopes[j]!;
				if ((a.scope.kind !== "paths" && a.scope.kind !== "unknown") || (b.scope.kind !== "paths" && b.scope.kind !== "unknown")) continue;
				if (!scopesConflict(a.scope, b.scope)) continue;
				return {
					ok: false,
					code: "lane-write",
					retry: false,
					reason: conflictText(a.lane, a.agent, a.scope, `같은 배치의 다른 항목(${b.lane?.name ?? b.agent})`, b.scope),
				};
			}
		}
		for (const entry of scopes) {
			const scope = entry.scope;
			if (scope.kind !== "paths" && scope.kind !== "unknown") continue;
			for (const reservation of this.#writes.values()) {
				if (!scopesConflict(scope, reservation.scope)) continue;
				const other = reservation.lane === undefined ? "진행 중인 공유 작업" : `레인 '${reservation.lane}'`;
				return { ok: false, code: "lane-write", retry: true, reason: conflictText(entry.lane, entry.agent, scope, other, reservation.scope) };
			}
		}
		return { ok: true };
	}

	/** Hold one placed item's shared write scope until its worker settles, fails, or the pending window expires. */
	#reserveWrite(entry: PlacedEntry, now: number): void {
		const scope = entry.scope;
		if (scope.kind === "read" || scope.kind === "private") return;
		const name = typeof entry.item.name === "string" ? entry.item.name : undefined;
		const key = entry.lane !== undefined
			? `lane:${entry.lane.name}`
			: name !== undefined
				? `spawn:${name}`
				: `pending:${++this.#writeSerial}`;
		this.#writes.set(key, {
			scope,
			...(entry.lane === undefined ? {} : { lane: entry.lane.name }),
			...(name === undefined ? {} : { name }),
			at: now,
		});
	}

	/** Expire a reservation whose worker is known to have settled, or whose host start never arrived. */
	#pruneWrites(agents: readonly AgentEntry[] | undefined, now: number): void {
		if (this.#writes.size === 0) return;
		const byId = new Map((agents ?? []).map(agent => [agent.id, agent]));
		for (const [key, reservation] of this.#writes) {
			const age = now - reservation.at;
			if (reservation.agentId === undefined) {
				if (age >= PENDING_WRITE_MS) this.#writes.delete(key);
				continue;
			}
			const agent = byId.get(reservation.agentId);
			if (agent === undefined) {
				if (age >= PENDING_WRITE_MS) this.#writes.delete(key);
			} else if (agent.state !== "running") {
				this.#writes.delete(key);
			}
		}
	}

	/** Bind a placed write reservation to the child id the host admitted. */
	#bindWrite(agentId: string, lane: string | undefined): void {
		let key = lane !== undefined ? `lane:${lane}` : `spawn:${agentId}`;
		let reservation = this.#writes.get(key);
		if (reservation === undefined && lane === undefined) {
			// Manual direction keeps the caller's handle: a planned lane name is normally the admitted spawn key too.
			key = `lane:${agentId}`;
			reservation = this.#writes.get(key);
		}
		// Only an unplanned manual child may adopt the single unbound reservation. A planned lane whose own
		// reservation was pruned must stay unbound, so the late-admission recheck compares its scope against the
		// writer that now owns the path instead of silently adopting that writer's reservation.
		if (reservation === undefined && lane === undefined) {
			const unbound = [...this.#writes].filter(([, item]) => item.agentId === undefined);
			if (unbound.length === 1) {
				key = unbound[0]![0];
				reservation = unbound[0]![1];
			}
		}
		if (reservation !== undefined) reservation.agentId = agentId;
	}

	/** Drop every reservation a refused or finished spawn still holds; the lane assignment is not evidence. */
	#releaseSpawn(spawnKey: string, lane: string | undefined): void {
		if (lane !== undefined) this.#writes.delete(`lane:${lane}`);
		for (const [key, reservation] of this.#writes) {
			if (reservation.agentId === spawnKey || reservation.name === spawnKey || key === `spawn:${spawnKey}`) {
				this.#writes.delete(key);
			}
		}
		// The same event is the only release of its concurrency slot: a failed spawn, a settled turn, or a park.
		releaseWorkerSlot(this.runId, spawnKey);
	}

	/**
	 * A spawn placement that never became a worker (host refused it, the ledger closed, a baseline failed) must not
	 * keep blocking another writer for the pending window.
	 */
	cancel(spawnKey: string): void {
		const assignment = this.#assigned.get(spawnKey);
		this.#assigned.delete(spawnKey);
		const lane = assignment?.lane ?? (this.#writes.has(`lane:${spawnKey}`) ? spawnKey : undefined);
		this.#releaseSpawn(spawnKey, lane);
	}

	/** The worker's turn settled: its lane is free for the next planned writer. */
	releaseAgent(agentId: string): void {
		this.#releaseSpawn(agentId, undefined);
	}

	/**
	 * Whether a lane already has a pending placement, a delivery reservation, a follow-up in flight, or a running
	 * admitted worker. A settled idle worker is not busy: only live work refuses a user exclusion or retry. Read-only
	 * work never holds a write reservation, so the admitted-agent state and the follow-up token are checked as well.
	 */
	laneBusy(laneName: string, agents: readonly AgentEntry[] = [], now = Date.now()): boolean {
		this.#pruneWrites(agents, now);
		for (const assignment of this.#assigned.values()) if (assignment.lane === laneName) return true;
		for (const entry of this.#followTokens.values()) if (entry.lane === laneName) return true;
		for (const reservation of this.#writes.values()) {
			if (reservation.lane !== laneName) continue;
			if (reservation.agentId === undefined) return true;
			const agent = agents.find(candidate => candidate.id === reservation.agentId);
			if (agent === undefined || agent.state === "running") return true;
		}
		const latest = this.#agents.get(laneName);
		if (latest === undefined) return false;
		const agent = agents.find(candidate => candidate.id === latest);
		return agent === undefined || agent.state === "running";
	}

	/**
	 * Any message that can start a turn (including native quiet writes) passes the same admission rules:
	 * the target lane's prerequisites must hold, and a shared write reserves its scope before omp delivers the turn.
	 * Its own in-flight reservation never blocks the continuation.
	 */
	checkFollowUp(input: FollowUpGateInput): FollowUpGate {
		const lane = input.lane;
		if (input.policy?.kind === "blocked") return { ok: false, reason: input.policy.reason, code: "lane-capability" };
		if (lane?.job !== undefined) {
			return {
				ok: false,
				code: "lane-job",
				reason: `'${lane.name}' 레인은 정형 작업(job: ${lane.job})이라 호스트 러너가 실행합니다. AI 서브에이전트에 후속 작업을 보내지 말고 job 실행 결과나 별도 워커 레인을 쓰세요.`,
			};
		}
		if (lane !== undefined) {
			const reason = dependencyBlock(lane, input.readiness);
			if (reason !== undefined) return { ok: false, reason, code: "lane-dependency" };
		}
		const now = input.now ?? Date.now();
		this.#pruneWrites(input.agents, now);
		const role = input.role ?? lane?.role;
		const target = input.agents?.find(agent => agent.id === input.agentId);
		const running = target?.state === "running";
		const reserved = input.runId === undefined ? [] : reservedWorkers(input.runId);
		const hasSlot = reserved.some(slot => slot.key === input.agentId);
		// A worker already running, or one that already holds a slot, is not a second worker: a work-bearing note to it
		// charges no new slot. A genuine reactivation of an idle/parked worker checks and takes a slot like a fresh start.
		const needsCapacity = input.runId !== undefined && !running && !hasSlot;
		if (needsCapacity) {
			const active = activeAgents([], input.agents ?? [], now, reserved);
			const cap = role === undefined ? undefined : input.plan?.workers[role];
			if (role !== undefined && cap !== undefined && (active.byRole[role] ?? 0) >= cap) {
				const max = workerRange(role, input.config?.roles[role]).max;
				return {
					ok: false,
					code: "lane-capacity",
					retry: true,
					reason: `${roleTitle(role)} 역할 워커가 이미 계획의 ${cap}개(역할 최대 ${max}개)만큼 살아 있어 ${input.agent} 후속 작업을 보내지 않았습니다. 사용자에게 묻지 말고 wait 도구나 완료 알림으로 하나가 끝난 뒤 같은 write를 다시 보내세요.`,
				};
			}
			const limit = input.maxConcurrency;
			const total = active.total + (input.otherActive ?? 0);
			if (limit !== undefined && limit > 0 && total >= limit) {
				return {
					ok: false,
					code: "lane-capacity",
					retry: true,
					reason: `OMP 동시 상한(task.maxConcurrency ${limit})에 닿아 ${input.agent} 후속 작업을 보내지 않았습니다. 사용자에게 묻지 말고 진행 중인 워커가 끝난 뒤 같은 write를 다시 보내세요.`,
				};
			}
		}
		const scope = writeScope(
			lane,
			input.role,
			input.isolated || lane?.isolationReason !== undefined,
			input.policy,
			input.canonicalFiles,
		);
		const token = `follow:${++this.#tokenSerial}`;
		const capacityKey = needsCapacity ? input.agentId : undefined;
		const slot = input.runId !== undefined && !hasSlot
			? { runId: input.runId, key: input.agentId, ...(role === undefined ? {} : { role }), ...(lane === undefined ? {} : { lane: lane.name }), now }
			: undefined;
		if (scope.kind === "read" || scope.kind === "private") {
			if (slot !== undefined) reserveWorkerSlot(slot);
			this.#followTokens.set(token, { created: false, ...(capacityKey === undefined ? {} : { capacityKey }), ...(lane === undefined ? {} : { lane: lane.name }) });
			return { ok: true, token, ...(capacityKey === undefined ? {} : { reserved: true }) };
		}
		for (const reservation of this.#writes.values()) {
			if (reservation.agentId === input.agentId) continue;
			if (!scopesConflict(scope, reservation.scope)) continue;
			const other = reservation.lane === undefined ? "진행 중인 공유 작업" : `레인 '${reservation.lane}'`;
			return { ok: false, reason: conflictText(lane, input.agent, scope, other, reservation.scope), code: "lane-write" };
		}
		const key = lane !== undefined ? `lane:${lane.name}` : `spawn:${input.agentId}`;
		const existing = this.#writes.get(key);
		this.#writes.set(key, { scope, ...(lane === undefined ? {} : { lane: lane.name }), agentId: input.agentId, at: now });
		if (slot !== undefined) reserveWorkerSlot(slot);
		this.#followTokens.set(token, { key, created: existing === undefined, ...(capacityKey === undefined ? {} : { capacityKey }), ...(lane === undefined ? {} : { lane: lane.name }) });
		return { ok: true, token, ...(capacityKey === undefined ? {} : { reserved: true }) };
	}

	/** Keep the reservation on a delivered follow-up; release one made by a preflight that then refused the turn. */
	finishFollowUp(token: string, keep: boolean): void {
		const entry = this.#followTokens.get(token);
		if (entry === undefined) return;
		this.#followTokens.delete(token);
		if (keep) return;
		if (entry.created && entry.key !== undefined) this.#writes.delete(entry.key);
		if (entry.capacityKey !== undefined) releaseWorkerSlot(this.runId, entry.capacityKey);
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
