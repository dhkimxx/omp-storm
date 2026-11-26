import { createHash } from "node:crypto";
import { withJosa } from "../josa.ts";
import { BUILTIN_AGENT_ROLES, ROLES, roleTitle, workerRange } from "../roles.ts";
import { scopesOverlap, type LanePolicy, WHY_AUTO_WRITER, WHY_UNDECLARED_WRITER } from "../policy/capability.ts";
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
	/** The host tool call that placed it, so that call's failure releases exactly its own placement. */
	callId?: string;
	/** Identity of the placed item: a late cancel of an older spawn never removes a newer placement of the same name. */
	placement?: number;
}

/** A lane's logical reservation: a placed task awaiting spawn correlation, or a follow-up awaiting its turn's start. */
interface LaneHold {
	/** Identity: a stale release never removes a newer hold of the same lane. */
	id: number;
	at: number;
	/** Handle the placed task carries (a task hold only). */
	name?: string;
	callId?: string;
	/** Identity of the placed item that made this hold (a task hold only). */
	placement?: number;
	/** The idle agent a work-bearing follow-up reactivates (a follow hold only). */
	agentId?: string;
	/** The reactivated turn was seen starting; from then on the agent's own state is the reservation. */
	started?: boolean;
}

export type LaneBlockCode = "lane-dependency" | "lane-write" | "lane-capability" | "lane-job" | "lane-capacity" | "lane-busy";

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
	/** The host's tool-call id: its failure releases exactly the placements this call made. */
	callId?: string;
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
					reason: `${name}: 레인은 '${named.role}' 역할이고 task는 '${role ?? "알 수 없음"}(${agent})' 역할이라 서로 다릅니다.`,
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
		"격리를 켜는 것은 사용자의 omp 설정(`omp config set task.isolation.enabled true`, 확인은 `omp config list --json`)입니다. " +
		"지금 쓸 수 없으면 계획의 isolationReason을 빼고 공유 레인으로 다시 계획하세요. 공유 쓰기 레인은 한 번에 하나씩 시작합니다.";
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

/** The prerequisite's result rows this edge is still waiting for. */
function openResults(need: LaneNeed, state: LaneReadiness): LaneResultReadiness[] {
	return state.results.filter(result =>
		need === "reviewable"
			? result.state !== "reviewable" && result.state !== "accepted"
			: result.state !== "accepted" || !located(need, result),
	);
}

/** The citation form an answer is read by: said where an unmet answer is refused and where the director is told. */
const ANSWER_CITATION_FORM = "읽기 전용 답은 프로젝트 안 파일의 path:line 인용이 있어야 합니다(local://, #L은 읽지 않음).";

/** Tag of the line the director reads when a delivery changed the ledger. */
export const LEDGER_NOTICE_TAG = "[storm:결과]";

/** One result a delivery left short of acceptance, as the ledger holds it now. */
export interface LedgerNoticeRow {
	id: string;
	kind: LaneResultKind;
	state: RunResult["state"];
	reason?: string;
}

/** What the notice calls a waiting lane whose prerequisites all hold; it does not say the lane can start. */
export const LEDGER_READY_LEAD = "선행이 충족된 대기 레인";

const NOTICE_ROWS = 3;
const NOTICE_REASON_CHARS = 140;

/**
 * What the director needs to read when a worker's delivery was evaluated: what Storm decided if that was not
 * acceptance (each result, its state, the ledger's reason, and for an answer the citation form that is read) and which
 * waiting lanes now have every prerequisite met (the spawn guard still decides whether they start). Nothing when the delivery was accepted and nothing waits on it. Facts only:
 * starting anything stays the director's call and the spawn guard's.
 */
export function ledgerNotice(input: { lane: string; open: readonly LedgerNoticeRow[]; startable: readonly string[] }): string | undefined {
	const parts: string[] = [];
	if (input.open.length > 0) {
		const shown = input.open.slice(0, NOTICE_ROWS).map(row => {
			const why = row.reason === undefined || row.reason.trim() === ""
				? ""
				: `: ${row.reason.replace(/\s+/gu, " ").trim().replace(/[.。]+$/u, "").slice(0, NOTICE_REASON_CHARS)}`;
			return `${row.id}(${STATE_LABEL[row.state]}${why})`;
		});
		const more = input.open.length > NOTICE_ROWS ? ` 외 ${input.open.length - NOTICE_ROWS}건` : "";
		parts.push(`'${input.lane}' 레인의 결과를 수용하지 않았습니다: ${shown.join(", ")}${more}.`);
		if (input.open.some(row => row.kind === "answer" && row.state === "unmet")) parts.push(ANSWER_CITATION_FORM);
	}
	if (input.startable.length > 0) {
		const names = input.startable.slice(0, 6).join(", ") + (input.startable.length > 6 ? ` 외 ${input.startable.length - 6}개` : "");
		// Prerequisites are one of the spawn guard's checks: role caps, parallelism, budget, writer order and isolation can
		// still refuse, so this names lanes that wait on nothing more, not lanes that will start.
		parts.push(`${LEDGER_READY_LEAD}: ${names}. 시작 여부는 스폰 검사가 정합니다.`);
	}
	return parts.length === 0 ? undefined : `${LEDGER_NOTICE_TAG} ${parts.join(" ")}`;
}

/**
 * What the director can do next for the state a prerequisite is in, one short sentence per distinct state. Waiting
 * only helps a worker that is still running or a result not yet judged; a finished, judged-unmet or reviewable result
 * does not change by itself, so it says what would change it. Pure advice: the guard still decides at the spawn.
 */
function shortfallAdvice(need: LaneNeed, state: LaneReadiness): string {
	if (state.running) return "그 워커가 끝난 뒤 같은 호출을 다시 보내세요.";
	const open = openResults(need, state);
	if (state.results.length === 0) {
		return need === "integrated" ? "그 결과가 부모 트리에 반영된 뒤 다시 보내세요." : "그 워커의 결과를 받은 뒤 다시 보내세요.";
	}
	const follow = state.handle === undefined ? "후속 지시" : `\`write agent://${state.handle}\` 명령`;
	const notes = new Set<string>();
	for (const result of open) {
		if (result.state === "pending") notes.add("아직 판정되지 않았으니 결과가 반영된 뒤 다시 보내세요.");
		else if (result.state === "unmet") {
			notes.add(
				result.kind === "answer"
					? `${ANSWER_CITATION_FORM} 그 워커에게 ${withJosa(follow, "으로/로")} 인용을 요청하세요.`
					: `미충족은 기다려도 바뀌지 않습니다. 사유를 보고 그 워커에게 ${withJosa(follow, "으로/로")} 보완을 요청하세요.`,
			);
		} else if (result.state === "reviewable") {
			notes.add(
				need === "result"
					? "검토 가능은 아직 수용이 아니며 승인된 리뷰어의 판정이 있어야 합니다. 제출만 필요하면 이 선행의 need를 reviewable로 바꿔 다시 계획하세요."
					: "검토 가능은 아직 수용이 아니며 승인된 리뷰어의 판정이 있어야 합니다.",
			);
		} else notes.add("수용된 결과가 현재 트리에서 확인된 뒤 다시 보내세요.");
	}
	return notes.size === 0 ? "그 결과가 충족된 뒤 다시 보내세요." : [...notes].slice(0, 2).join(" ");
}

/** Whether one prerequisite lane's current ledger facts satisfy the edge; a missing row is never satisfied. */
function dependencyShortfall(need: LaneNeed, state: LaneReadiness): string | undefined {
	// A lane that is still working may change the result the consumer would read. Its prior row is not final input.
	if (state.running) return "해당 레인의 워커가 아직 실행 중이라 현재 결과가 확정되지 않았습니다";
	const open = openResults(need, state);
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
				const why = result.reason === undefined ? "" : `: ${result.reason.replace(/[.。]+$/u, "")}`;
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
		// A fixed noun sits between each inserted value and its particle, so the sentence is grammatical whatever is inserted.
		return `'${lane.name}' 레인은 선행 '${dependency.lane}' 레인의 ${NEED_LABEL[dependency.need]} 조건이 충족되지 않았습니다: ${shortfall}. ${shortfallAdvice(dependency.need, state)} 선행을 대신 실행하거나 같은 이름으로 결과를 주장하지 마세요.`;
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
	/** `why` is the short cause of an exclusive writer, shown in the refusal; absent when nothing narrowed it. */
	| { kind: "unknown"; why?: string };

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
		if (policy.kind === "unknown") return { kind: "unknown", why: policy.reason };
		if (policy.kind === "blocked" || auto) return { kind: "unknown", why: WHY_AUTO_WRITER };
		return { kind: "paths", paths: [...new Set(canonicalFiles ?? policy.paths ?? lane?.files ?? [])].sort() };
	}
	if (lane !== undefined && (lane.files?.length ?? 0) > 0) {
		return auto ? { kind: "unknown", why: WHY_AUTO_WRITER } : { kind: "paths", paths: normalizeFiles(lane) };
	}
	const laneRole = lane?.role ?? role;
	const changes = lane !== undefined && ((lane.results ?? []).some(result => result.kind !== "answer") || WRITING_KINDS[lane.kind] === true);
	if (changes || (laneRole !== undefined && WRITING_ROLES[laneRole] === true)) return { kind: "unknown", why: WHY_UNDECLARED_WRITER };
	if (laneRole !== undefined && READ_ONLY_ROLES[laneRole] === true) return { kind: "read" };
	return { kind: "unknown", why: WHY_UNDECLARED_WRITER };
}

/** Two shared writes collide when their path scopes overlap by directory prefix; an unknown scope can touch anything. */
function scopesConflict(a: WriteScope, b: WriteScope): boolean {
	if (a.kind === "unknown") return b.kind === "paths" || b.kind === "unknown";
	if (b.kind === "unknown") return a.kind === "paths";
	if (a.kind !== "paths" || b.kind !== "paths") return false;
	return scopesOverlap(a.paths, b.paths);
}

/**
 * Why two shared writes may not start together, and the one next step that works for this refusal. A lane that declared
 * files is told so: for an exclusive writer (a `bash`/`eval` tool, automatic delegation) the files do not narrow what it
 * can touch, so splitting them changes nothing and the text must not ask for it. Isolation is never recommended here:
 * it exists only where omp has it on, and the plan reply says when it does not. `other` is a noun phrase that ends in a
 * fixed Korean noun (레인, 작업), so the particles after it hold whatever name is inserted before it.
 */
function conflictText(
	lane: PlanLane | undefined,
	agent: string,
	scope: WriteScope,
	other: string,
	otherScope: WriteScope,
	sameCall = false,
): string {
	const who = lane === undefined ? `${agent} 직접 작업` : `'${lane.name}' 레인`;
	const declared = (lane?.files?.length ?? 0) > 0;
	// Both phrases end in a fixed Korean noun, but the particle is still picked from the text so a reworded phrase stays right.
	const topic = withJosa(who, "은/는");
	const withOther = withJosa(other, "과/와");
	let head: string;
	if (scope.kind === "unknown") {
		const why = scope.why ?? WHY_UNDECLARED_WRITER;
		head = declared
			? `${topic} 파일 목록을 선언했지만 쓰기 범위를 좁힐 수 없는 공유 작업입니다(${why}). ${withOther} 함께 시작하지 않았습니다. 파일 목록을 나눠도 같습니다.`
			: `${topic} 쓰기 범위를 좁힐 수 없는 공유 작업입니다(${why}). ${withOther} 함께 시작하지 않았습니다.${otherScope.kind === "paths" && why === WHY_UNDECLARED_WRITER ? " 파일 목록을 선언하면 겹치지 않는 한 함께 시작합니다." : ""}`;
	} else if (otherScope.kind === "unknown") {
		head = `${topic} 파일 ${scope.kind === "paths" ? scope.paths.join(", ") : ""}만 쓰지만 ${withJosa(other, "은/는")} 쓰기 범위를 좁힐 수 없는 공유 작업이라(${otherScope.why ?? WHY_UNDECLARED_WRITER}) 함께 시작하지 않았습니다.`;
	} else {
		const mine = scope.kind === "paths" ? scope.paths.join(", ") : "";
		const theirs = otherScope.kind === "paths" ? otherScope.paths.join(", ") : "";
		head = `${topic} ${withOther} 쓰는 파일이 겹쳐 함께 시작하지 않았습니다(${mine} / ${theirs}).`;
	}
	const next = sameCall
		? "이 호출에는 쓰기 작업을 하나만 담고 나머지는 끝난 뒤 보내세요. 읽기 전용 레인은 함께 보내도 됩니다."
		: `${withJosa(other, "이/가")} 끝난 뒤 같은 호출을 다시 보내세요.`;
	return `${head} ${next}`;
}

/** The earlier writer a refusal names, as a noun phrase: a reservation may be placed but not yet running. */
function earlierWriter(lane: string | undefined): string {
	return lane === undefined ? "먼저 시작한 공유 작업" : `먼저 시작한 '${lane}' 레인`;
}

interface WriteReservation {
	scope: WriteScope;
	/** Placed by this tool call (task) or follow-up delivery. */
	callId?: string;
	/** A work follow-up admitted but whose reactivated turn has not started: settled state must not release it yet. */
	awaiting?: boolean;
	lane?: string;
	agentId?: string;
	/** The handle reserved for this spawn before the host allocates its id; used only for release matching. */
	name?: string;
	/** Identity of the placed item that reserved it; it survives the spawn's admission binding an agent id. */
	placement?: number;
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
	/**
	 * A quiet `?progress` note. It passes the same capability, job, dependency, and (for an idle recipient) capacity and
	 * write-conflict gates, but it carries no work: it takes no lane hold, write reservation or worker slot of its own.
	 */
	progress?: boolean;
	/** The host's tool-call id of this write, so its failure releases exactly this admission. */
	callId?: string;
	/** Automatic delegation: every shared writer is one global serial scope, exactly as for a fresh task placement. */
	auto?: boolean;
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

const liveLanes = new Map<string, WeakRef<RunLanes>>();

/**
 * A child session loads the extension on its own and holds no run, yet its turn start is the fact that ends a follow-up's
 * admission window in the run's lanes. The newest lanes of the run id receive it; an unknown agent changes nothing.
 */
export function noteLaneAgentStart(runId: string, agentId: string): void {
	liveLanes.get(runId)?.deref()?.agentStarted(agentId);
}

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
	/** When each lane's latest agent was admitted: an agent the host list does not show yet only counts as live briefly. */
	readonly #agentAt = new Map<string, number>();
	/** Shared write scopes placed but not yet released; private/read-only work never appears here. */
	readonly #writes = new Map<string, WriteReservation>();
	/**
	 * Logical lanes placed by a task call whose spawn has not been correlated yet. Read-only and private lanes reserve
	 * no write scope, so this is what makes a second independent dispatch of the same lane visible before the host
	 * allocates the first one's id. Cleared by the matching admission, cancel or release; expires like a pending write.
	 */
	readonly #held = new Map<string, LaneHold>();
	/** Follow-up admission tokens; only a failed preflight releases the write/capacity reservations it created. */
	readonly #followTokens = new Map<
		string,
		{ key?: string; created: boolean; capacityKey?: string; lane?: string; reservation?: WriteReservation; holdLane?: string; holdId?: number }
	>();
	#serial = 0;
	#holdSerial = 0;
	#writeSerial = 0;
	#placementSerial = 0;
	#tokenSerial = 0;

	constructor(readonly runId: string) {
		liveLanes.set(runId, new WeakRef(this));
	}

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
			const placement = ++this.#placementSerial;
			if (rewrite) {
				// Every auto item was accepted only after matching a lane above.
				const lane = entry.lane as PlanLane;
				const name = `${this.runId}-lane-${++this.#serial}`;
				this.#assigned.set(name, { key: key(lane), lane: lane.name, agent: entry.agent, placement, ...(options.callId === undefined ? {} : { callId: options.callId }) });
				next = { ...next, name };
			}
			// Only a consumer with declared prerequisites receives a reference: no extra text on a legacy plan.
			const refs = entry.lane === undefined ? undefined : dependencyRefs(entry.lane, options.readiness);
			if (refs !== undefined && typeof next.task === "string" && next.task.trim() !== "") {
				next = { ...next, task: `${next.task.trimEnd()}\n\n${refs}` };
			}
			this.#reserveWrite(entry, now, placement, options.callId);
			if (entry.lane !== undefined) {
				const handle = typeof next.name === "string" ? next.name : undefined;
				this.#held.set(entry.lane.name, {
					id: ++this.#holdSerial,
					at: now,
					placement,
					...(handle === undefined ? {} : { name: handle }),
					...(options.callId === undefined ? {} : { callId: options.callId }),
				});
			}
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
		// The spawn is correlated: from here the admitted agent's own state, not the placement hold, says the lane is busy.
		if (assignment !== undefined && this.#held.get(assignment.lane)?.agentId === undefined) this.#held.delete(assignment.lane);
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
					const other = earlierWriter(reservation.lane);
					const reason = conflictText(lane, spawn.agent, scope, other, reservation.scope);
					this.#releaseSpawn(spawn.spawnKey, assignment.lane);
					return { ok: false, code: "lane-write", reason };
				}
			}
		}
		this.#admitted.set(spawn.spawnKey, assignment);
		this.#agents.set(assignment.lane, spawn.spawnKey);
		this.#agentAt.set(assignment.lane, Date.now());
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
		// One logical lane has one live attempt: an independent dispatch of a reserved or running lane would displace it,
		// whether or not the lane writes. Continuing it is a follow-up to its own agent, never a second task.
		for (const entry of scopes) {
			if (entry.lane === undefined || !this.#laneLive(entry.lane.name, options.agents, now)) continue;
			const handle = this.#agents.get(entry.lane.name);
			return {
				ok: false,
				code: "lane-busy",
				retry: false,
				reason: `레인 '${entry.lane.name}'에 이미 예약됐거나 진행 중인 작업이 있어 같은 레인에 독립 작업을 또 시작하지 않았습니다. 아무것도 시작하지 않았습니다. 그 작업이 끝난 뒤 다시 보내거나, 이어 가려면 ${handle === undefined ? "그 워커에게" : `\`write agent://${handle}\` 명령으로`} 후속 지시를 보내세요. 다른 관점의 병렬 작업이 필요하면 계획에 그 작업을 위한 별도 레인을 두세요.`,
			};
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
					reason: conflictText(a.lane, a.agent, a.scope, b.lane === undefined ? `같은 호출의 ${b.agent} 직접 작업` : `같은 호출의 '${b.lane.name}' 레인`, b.scope, true),
				};
			}
		}
		for (const entry of scopes) {
			const scope = entry.scope;
			if (scope.kind !== "paths" && scope.kind !== "unknown") continue;
			for (const reservation of this.#writes.values()) {
				if (!scopesConflict(scope, reservation.scope)) continue;
				const other = earlierWriter(reservation.lane);
				return { ok: false, code: "lane-write", retry: true, reason: conflictText(entry.lane, entry.agent, scope, other, reservation.scope) };
			}
		}
		return { ok: true };
	}

	/** Hold one placed item's shared write scope until its worker settles, fails, or the pending window expires. */
	#reserveWrite(entry: PlacedEntry, now: number, placement: number, callId?: string): void {
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
			...(callId === undefined ? {} : { callId }),
			placement,
			at: now,
		});
	}

	/**
	 * Expire a reservation whose worker is known to have settled, or whose host start never arrived. A follow-up admission
	 * is different: until its reactivated turn starts, the worker still looks settled, so only its start (or the pending
	 * window) decides, never the stale idle state.
	 */
	#pruneWrites(agents: readonly AgentEntry[] | undefined, now: number): void {
		const byId = new Map((agents ?? []).map(agent => [agent.id, agent]));
		for (const [lane, hold] of this.#held) {
			const age = now - hold.at;
			if (hold.agentId === undefined) {
				if (age >= PENDING_WRITE_MS) this.#held.delete(lane);
				continue;
			}
			const agent = byId.get(hold.agentId);
			if (agent?.state === "running") hold.started = true;
			if (hold.started) {
				if (agents !== undefined && agent?.state !== "running") this.#held.delete(lane);
			} else if (age >= PENDING_WRITE_MS) {
				this.#held.delete(lane);
			}
		}
		if (this.#writes.size === 0) return;
		for (const [key, reservation] of this.#writes) {
			const age = now - reservation.at;
			if (reservation.agentId === undefined) {
				if (age >= PENDING_WRITE_MS) this.#writes.delete(key);
				continue;
			}
			const agent = byId.get(reservation.agentId);
			if (agent === undefined) {
				if (age >= PENDING_WRITE_MS) this.#writes.delete(key);
			} else if (agent.state === "running") {
				delete reservation.awaiting;
			} else if (reservation.awaiting !== true || age >= PENDING_WRITE_MS) {
				this.#writes.delete(key);
			}
		}
	}

	/** The reactivated turn of a follow-up began: the agent's own running state is now the lane's reservation. */
	agentStarted(agentId: string): void {
		for (const hold of this.#held.values()) if (hold.agentId === agentId) hold.started = true;
		for (const reservation of this.#writes.values()) if (reservation.agentId === agentId) delete reservation.awaiting;
	}

	/**
	 * A host tool call failed or was cancelled: release exactly what that call placed and nothing a newer call owns.
	 * Placements already admitted to a worker are the worker's, and a follow-up whose turn started is running work.
	 * Returns the spawn handles it released, so the caller can free any slot those handles took.
	 */
	releaseCall(callId: string): string[] {
		const names: string[] = [];
		for (const [lane, hold] of this.#held) {
			if (hold.callId !== callId || hold.started === true) continue;
			this.#held.delete(lane);
			if (hold.name !== undefined) names.push(hold.name);
		}
		for (const [key, reservation] of this.#writes) {
			if (reservation.callId !== callId || (reservation.agentId !== undefined && reservation.awaiting !== true)) continue;
			this.#writes.delete(key);
			if (reservation.name !== undefined) names.push(reservation.name);
		}
		for (const [name, assignment] of this.#assigned) {
			if (assignment.callId !== callId) continue;
			this.#assigned.delete(name);
			names.push(name);
		}
		return [...new Set(names)];
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
	#releaseSpawn(spawnKey: string, lane: string | undefined, settledTurn = false): void {
		if (lane !== undefined) {
			if (this.#writes.get(`lane:${lane}`)?.awaiting !== true) this.#writes.delete(`lane:${lane}`);
			// A follow-up's hold belongs to its agent and ends with that agent's started turn, not with a spawn's cleanup.
			if (this.#held.get(lane)?.agentId === undefined) this.#held.delete(lane);
		}
		for (const [name, hold] of this.#held) if (hold.agentId === undefined && hold.name === spawnKey) this.#held.delete(name);
		for (const [key, reservation] of this.#writes) {
			// A settled-turn event is the previous turn's: it never ends a follow-up admitted after it and not yet started.
			if (settledTurn && reservation.awaiting === true) continue;
			if (reservation.agentId === spawnKey || reservation.name === spawnKey || key === `spawn:${spawnKey}`) {
				this.#writes.delete(key);
			}
		}
		// The same event is the only release of its concurrency slot: a failed spawn, a settled turn, or a park.
		// ...nor frees the slot that reactivation took.
		if (settledTurn && this.#awaitingStart(spawnKey)) return;
		releaseWorkerSlot(this.runId, spawnKey);
	}

	/** A work follow-up to this agent was admitted and its turn has not started yet. */
	#awaitingStart(agentId: string): boolean {
		for (const hold of this.#held.values()) if (hold.agentId === agentId && hold.started !== true) return true;
		for (const reservation of this.#writes.values()) if (reservation.agentId === agentId && reservation.awaiting === true) return true;
		return false;
	}

	/**
	 * The identity of the placement a spawn key correlates to right now, read before the decision awaits anything.
	 * A later cancel passes it back, so a refusal that lands after a newer call placed the same name removes nothing
	 * of that newer call.
	 */
	placementOf(spawnKey: string): number | undefined {
		const assigned = this.#assigned.get(spawnKey)?.placement;
		if (assigned !== undefined) return assigned;
		for (const hold of this.#held.values()) {
			if (hold.agentId === undefined && hold.name === spawnKey && hold.placement !== undefined) return hold.placement;
		}
		for (const [key, reservation] of this.#writes) {
			if (reservation.placement !== undefined && (reservation.name === spawnKey || key === `lane:${spawnKey}`)) return reservation.placement;
		}
		return undefined;
	}

	/**
	 * A spawn placement that never became a worker (host refused it, the ledger closed, a baseline failed) must not
	 * keep blocking another writer for the pending window. It releases only what that placement made, plus the write
	 * reservation its own admission bound to the spawn: a placement of a newer call is never touched. The worker slot
	 * belongs to the decision that reserved it, not to the placement.
	 */
	cancel(spawnKey: string, placement: number | undefined): void {
		const assignment = this.#assigned.get(spawnKey);
		if (placement !== undefined && assignment?.placement === placement) this.#assigned.delete(spawnKey);
		if (placement !== undefined) {
			for (const [lane, hold] of this.#held) if (hold.agentId === undefined && hold.placement === placement) this.#held.delete(lane);
		}
		for (const [key, reservation] of this.#writes) {
			// A follow-up's reservation belongs to its agent and ends with that agent's started turn.
			if (reservation.awaiting === true) continue;
			// With a stamp the placement identity decides, even after admission bound this spawn's id to it; without one
			// only a reservation bound to this very spawn is its own.
			const own = placement === undefined ? reservation.agentId === spawnKey : reservation.placement === placement;
			if (own) this.#writes.delete(key);
		}
	}

	/** The worker's turn settled: its lane is free for the next planned writer. */
	releaseAgent(agentId: string): void {
		this.#releaseSpawn(agentId, undefined, true);
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
		return this.#laneLive(laneName, agents, now);
	}

	/**
	 * A lane's live attempt apart from the auto-assignment table: a placement hold, a follow-up in flight, the lane's
	 * own write reservation, or a running admitted worker of the lane (the latest one, or an earlier one a follow-up
	 * reactivated). A settled idle worker is not live.
	 */
	#laneLive(laneName: string, agents: readonly AgentEntry[] | undefined, now: number): boolean {
		this.#pruneWrites(agents, now);
		if (this.#held.has(laneName)) return true;
		for (const entry of this.#followTokens.values()) if (entry.lane === laneName) return true;
		const known = agents ?? [];
		for (const reservation of this.#writes.values()) {
			if (reservation.lane !== laneName) continue;
			if (reservation.agentId === undefined) return true;
			const agent = known.find(candidate => candidate.id === reservation.agentId);
			if (agent === undefined || agent.state === "running") return true;
		}
		const latest = this.#agents.get(laneName);
		if (latest !== undefined) {
			const agent = known.find(candidate => candidate.id === latest);
			if (agent?.state === "running") return true;
			// With a host list in hand, an admitted agent it does not show yet is still starting; without one, say nothing.
			if (agent === undefined && agents !== undefined && now - (this.#agentAt.get(laneName) ?? 0) < PENDING_WRITE_MS) return true;
		}
		return known.some(agent => agent.state === "running" && this.#admitted.get(agent.id)?.lane === laneName);
	}

	/**
	 * Any message that can start a turn (including native quiet writes) passes the same admission rules:
	 * the target lane's prerequisites must hold, and a shared write reserves its scope before omp delivers the turn.
	 * Its own in-flight reservation never blocks the continuation. A progress-only note to an idle recipient still meets
	 * the capacity and write-conflict gates, because it starts a turn, but it carries no work: it holds no lane, reserves
	 * no write scope and takes no worker slot of its own.
	 */
	checkFollowUp(input: FollowUpGateInput): FollowUpGate {
		const lane = input.lane;
		if (input.policy?.kind === "blocked") return { ok: false, reason: input.policy.reason, code: "lane-capability" };
		if (lane?.job !== undefined) {
			return {
				ok: false,
				code: "lane-job",
				reason: `'${lane.name}' 레인은 정형 작업이라 호스트 러너가 실행합니다(job: ${lane.job}). AI 서브에이전트에 후속 작업을 보내지 말고 job 실행 결과나 별도 워커 레인을 쓰세요.`,
			};
		}
		if (lane !== undefined) {
			const reason = dependencyBlock(lane, input.readiness);
			if (reason !== undefined) return { ok: false, reason, code: "lane-dependency" };
		}
		const now = input.now ?? Date.now();
		const role = input.role ?? lane?.role;
		const target = input.agents?.find(agent => agent.id === input.agentId);
		const running = target?.state === "running";
		const reserved = input.runId === undefined ? [] : reservedWorkers(input.runId);
		const hasSlot = reserved.some(slot => slot.key === input.agentId);
		// A worker already running, or one that already holds a slot, is not a second worker: a follow-up to it charges no
		// new slot. A genuine reactivation, including the native wake turn of a progress note, checks the ceiling first.
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
		this.#pruneWrites(input.agents, now);
		const scope = writeScope(
			lane,
			input.role,
			input.isolated || lane?.isolationReason !== undefined,
			input.policy,
			input.canonicalFiles,
			input.auto === true,
		);
		// A progress-only note holds no lane and takes no write lease or worker slot of its own. It still wakes an idle
		// recipient into a turn that may write, so that turn must not start inside another writer's scope; a running
		// recipient already owns its reservation.
		if (input.progress === true) {
			if (!running) {
				for (const reservation of this.#writes.values()) {
					if (reservation.agentId === input.agentId || !scopesConflict(scope, reservation.scope)) continue;
					const other = earlierWriter(reservation.lane);
					return {
						ok: false,
						code: "lane-write",
						reason: `${conflictText(lane, input.agent, scope, other, reservation.scope)} 이 진행 메모는 대기 중인 워커의 새 턴을 시작시키므로 보내지 않았습니다.`,
					};
				}
			}
			return { ok: true, token: `follow:${++this.#tokenSerial}` };
		}
		// A work-bearing note to a settled worker reserves its lane from this admission until the reactivated turn starts;
		// a note to an already running worker reserves nothing beyond the gate itself.
		const awaits = !running;
		if (awaits && lane !== undefined) {
			const current = this.#held.get(lane.name);
			if (current !== undefined && current.agentId !== input.agentId && !(current.agentId !== undefined && current.started === true)) {
				return {
					ok: false,
					code: "lane-busy",
					reason: `레인 '${lane.name}'에 이미 예약된 ${withJosa(current.agentId === undefined ? "독립 작업" : "후속 작업", "이/가")} 있어 ${input.agent} 후속 작업을 보내지 않았습니다. 그 작업이 시작·종료된 뒤 같은 write를 다시 보내세요. 다른 관점의 병렬 작업이 필요하면 계획에 그 작업을 위한 별도 레인을 두세요.`,
				};
			}
		}
		const token = `follow:${++this.#tokenSerial}`;
		const capacityKey = needsCapacity ? input.agentId : undefined;
		const holdFollow = (): { holdLane?: string; holdId?: number } => {
			if (!awaits || lane === undefined) return {};
			const current = this.#held.get(lane.name);
			if (current !== undefined && current.agentId === input.agentId) return {};
			const hold: LaneHold = { id: ++this.#holdSerial, at: now, agentId: input.agentId, ...(input.callId === undefined ? {} : { callId: input.callId }) };
			this.#held.set(lane.name, hold);
			return { holdLane: lane.name, holdId: hold.id };
		};
		const slot = input.runId !== undefined && !hasSlot
			? { runId: input.runId, key: input.agentId, ...(role === undefined ? {} : { role }), ...(lane === undefined ? {} : { lane: lane.name }), now }
			: undefined;
		if (scope.kind === "read" || scope.kind === "private") {
			if (slot !== undefined) reserveWorkerSlot(slot);
			this.#followTokens.set(token, { created: false, ...holdFollow(), ...(capacityKey === undefined ? {} : { capacityKey }), ...(lane === undefined ? {} : { lane: lane.name }) });
			return { ok: true, token, ...(capacityKey === undefined ? {} : { reserved: true }) };
		}
		for (const reservation of this.#writes.values()) {
			if (reservation.agentId === input.agentId) continue;
			if (!scopesConflict(scope, reservation.scope)) continue;
			const other = earlierWriter(reservation.lane);
			return { ok: false, reason: conflictText(lane, input.agent, scope, other, reservation.scope), code: "lane-write" };
		}
		const key = lane !== undefined ? `lane:${lane.name}` : `spawn:${input.agentId}`;
		const existing = this.#writes.get(key);
		const reservation: WriteReservation = {
			scope,
			...(lane === undefined ? {} : { lane: lane.name }),
			agentId: input.agentId,
			...(input.callId === undefined ? {} : { callId: input.callId }),
			...(awaits ? { awaiting: true } : {}),
			at: now,
		};
		this.#writes.set(key, reservation);
		if (slot !== undefined) reserveWorkerSlot(slot);
		this.#followTokens.set(token, { key, reservation, created: existing === undefined, ...holdFollow(), ...(capacityKey === undefined ? {} : { capacityKey }), ...(lane === undefined ? {} : { lane: lane.name }) });
		return { ok: true, token, ...(capacityKey === undefined ? {} : { reserved: true }) };
	}

	/** Keep the reservation on a delivered follow-up; release one made by a preflight that then refused the turn. */
	finishFollowUp(token: string, keep: boolean): void {
		const entry = this.#followTokens.get(token);
		if (entry === undefined) return;
		this.#followTokens.delete(token);
		if (keep) return;
		// Identity-checked: only what this admission created, never a newer admission's reservation or hold.
		if (entry.created && entry.key !== undefined && this.#writes.get(entry.key) === entry.reservation) this.#writes.delete(entry.key);
		if (entry.holdLane !== undefined && this.#held.get(entry.holdLane)?.id === entry.holdId) this.#held.delete(entry.holdLane);
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
