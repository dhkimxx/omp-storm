import { createHash } from "node:crypto";
import { withJosa } from "../josa.ts";
import { BUILTIN_AGENT_ROLES, ROLES } from "../roles.ts";
import { authorityCovers, scopesOverlap, shellReader, shellReaderWhy, type LanePolicy, type WriteAuthority, WHY_EXEC_WRITER, WHY_SHELL_READER, WHY_UNDECLARED_WRITER } from "../policy/capability.ts";
import { activeAgents, releaseWorkerSlot, reservedWorkers, reserveWorkerSlot } from "../policy/spawn.ts";
import {
	carriesEvalTools,
	classifyUnplannedItem,
	isolatedToolsReason,
	TASK_EMPTY_REASON,
	TASK_ITEM_INVALID_REASON,
	unplannedFacts,
	unplannedIsolationApplyReason,
	unplannedIsolationUnavailableReason,
	WHY_ITEM_TOOLS,
} from "../policy/unplanned-spawn.ts";
import type {
	AgentEntry,
	HolderKind,
	LaneNeed,
	LaneResultKind,
	LiveCheck,
	PlanLane,
	RunPlan,
	RunResult,
	SpawnRecord,
	StormConfig,
} from "../types.ts";
import {
	DIRECTOR_EDIT_RETRY,
	DIRECTOR_EDITING,
	DIRECTOR_WRITE_ENDING,
	DIRECTOR_WRITE_LATE,
	DIRECTOR_WRITE_NO_TARGET,
	directorEditWait,
	directorWriteConflict,
	type HolderView,
} from "./arbiter.ts";
import { requirementConflictFromPlan } from "./requirements.ts";
import { sharedMap } from "./thread-state.ts";

interface Assignment {
	/** The planned lane, or absent for an unplanned placement (R5). */
	lane?: string;
	/** Evidence identity of a planned lane; absent for an unplanned placement. */
	key?: string;
	agent: string;
	/** The host tool call that placed it, so that call's failure releases exactly its own placement. */
	callId?: string;
	/** Identity of the placed item: a late cancel of an older spawn never removes a newer placement of the same name. */
	placement?: number;
	/** The shared-tree scope the placement froze (R3, R6); absent only for a legacy caller that passed no policy. */
	scope?: WriteScope;
	/** The item carried its own eval-defined `tools` (D7/R6): the hook must persist the reserved shared-writer effect. */
	toolsCarried?: boolean;
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

/**
 * Who holds an entry of the write table besides a worker (an entry with no kind); the type is in `types.ts`. Every kind but
 * `director-path` can change the shared tree without naming a path, so it is an `unknown` scope and conflicts with every other
 * shared writer:
 * - `director-path`: the director's own path edit (`edit`, `write`, `ast_edit`). Its scope is the exact paths of the call, keyed by
 *   the host's tool call id; it is released only by the end of the assistant turn that made the call (`releaseDirectorCalls`).
 * - `director-exec`: the director's own command (shell, an editing `lsp` action, MCP and unknown tools), from its call's
 *   start to the end of that call.
 * - `director-bg`: a command of the director that omp moved to the background; the host's own job table says when it ends.
 * - `job`, `check`: a host process Storm runs, a configured job or a required check.
 * - `fence`: one of those whose process end is not proven.
 */
export type { HolderKind };

/** The tool call id the table keys a director path edit by. */
function directorKey(callId: string): string {
	return `director:${callId}`;
}

/** One director path edit asking for the table (see `RunLanes.commitWriter`). */
export interface CommitWriterRequest {
	kind: "director-path";
	/** The host's tool call id; it keys the entry and is the only thing that releases it. */
	callId: string;
	/** The exact workspace-relative paths the call writes. A directory scope is the directory's path. */
	paths: readonly string[];
	/** The caller's proof that the run it captured before its awaits is still the live one; evaluated inside the step. */
	live: () => LiveCheck;
	/** Absolute ms; the step refuses at or after it. */
	deadline?: number;
	now: number;
	/** The host's agent list, applied to the table in the same step (a worker already settled does not hold the tree). */
	agents?: readonly AgentEntry[] | undefined;
}

/** `lane-write`: another writer holds the tree. `run-ending`: `live` said no. `deadline`: the hook's time was up. `no-target`: nothing to bound. */
export type CommitWriterResult =
	| { ok: true }
	| { ok: false; code: "lane-write"; reason: string; holder: HolderView }
	| { ok: false; code: "run-ending" | "deadline" | "no-target"; reason: string };

/** One row of the host's async job snapshot, as far as the arbiter reads it. */
export interface HostJobRow {
	id: string;
	/** omp's job type: `bash`, `eval` or `task`. */
	type: string;
	status: string;
	/** The subagent a `task` job runs. */
	agentId?: string;
}

/**
 * What the run reads of the director session's own async jobs, synchronously. `undefined` means the host cannot show them
 * now: nothing is then assumed finished, and a director command is not admitted.
 */
export type HostJobSource = () => readonly HostJobRow[] | undefined;

/** Why a director command is an unbounded writer; the cause a refusal names. */
export const WHY_DIRECTOR_COMMAND = "감독 명령은 어디든 바꿀 수 있음";
/** Said when omp does not show the session's background jobs, so a director command's end cannot be known. */
export const DIRECTOR_BLIND_REASON =
	"omp가 이 세션의 백그라운드 작업 목록을 주지 않아 감독 명령이 백그라운드로 넘어갔는지 알 수 없어 막았습니다. 실행 중에는 명령을 task로 워커에 맡기세요.";
/** Why a job or a check is an unbounded writer. */
export const WHY_HOST_COMMAND = "정형 작업과 검사는 어디든 바꿀 수 있음";

type TaskBinding =
	/** `notes` are facts the director reads in the result of this very call (a lane started before its prerequisite held). */
	| { ok: true; input: Record<string, unknown>; notes?: string[] }
	| { ok: false; reason: string; code?: LaneBlockCode | "lane" | "isolation"; retry?: boolean };

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
	/**
	 * Whether the caller holds the target's write claim for this batch (A2-1). `true`: the claim was taken; `false`: the
	 * caller's own classification found no shared writer, so a shared writer here means the caller must not place it.
	 * Absent: a legacy caller that makes no claim decision (tests). Production callers always pass it.
	 */
	writeClaim?: boolean;
	/** Live host capability; omitted means unknown. */
	host?: TaskIsolationHost;
	/** Approved write authority per plan lane; when present it replaces role-name guesses. */
	policies?: ReadonlyMap<string, LanePolicy>;
	/**
	 * Effective tools of an approved definition, for the R6 classification of an unplanned item. Absent means unknown
	 * (the host default, every tool), which is an exclusive shared writer. Planned lanes keep their `policies`.
	 */
	agentTools?: (agent: string) => readonly string[] | undefined;
	/** Canonical workspace-relative scopes for a lane's declared files; absent keeps its declared paths. */
	canonicalFiles?: ReadonlyMap<string, readonly string[]>;
	/** Current facts of every prerequisite lane a plan may wait on; a dependency without an entry fails closed. */
	readiness?: LaneReadinessView;
	/** Live agents of this run, used only to expire reservations whose worker has already settled. */
	agents?: readonly AgentEntry[];
	/** The host's tool-call id: its failure releases exactly the placements this call made. */
	callId?: string;
	/**
	 * Text to append to one task item's assignment, decided per item from its lane (absent for an item that matches none) and
	 * whether placement runs it in an isolated checkout. It is appended after the dependency note, to the item's `task` or, when
	 * the item has `steps` (the host sends `steps` instead of `task`), to the first of them. It is called only for a batch that is
	 * accepted: a refused call leaves every item untouched. Nothing returned, or an empty text, appends nothing.
	 */
	decorate?: (entry: { lane: PlanLane | undefined; isolated: boolean }) => string | undefined;
	now?: number;
}

/**
 * Appends a note to what a worker is told to do: the item's `steps` when it has them (the host sends `steps` instead of `task`,
 * and its first element is the first prompt), else its `task`. An item with neither a usable `steps` nor a non-empty `task` is
 * returned as it was: omp refuses it and there is no assignment to add to.
 */
function appendedAssignment(item: Record<string, unknown>, text: string): Record<string, unknown> {
	const steps = item.steps;
	if (Array.isArray(steps) && typeof steps[0] === "string" && steps[0].trim() !== "") {
		return { ...item, steps: [`${steps[0].trimEnd()}\n\n${text}`, ...steps.slice(1)] };
	}
	if (typeof item.task === "string" && item.task.trim() !== "") return { ...item, task: `${item.task.trimEnd()}\n\n${text}` };
	return item;
}

/** One required result of a prerequisite lane, as the run's own result ledger currently knows it. */
export interface LaneResultReadiness {
	id: string;
	/** The declared result kind; absent only for a legacy fixture/hand-built view, never from the controller. */
	kind?: LaneResultKind;
	state: RunResult["state"];
	/** The integrated tree verifiably carries this accepted result (never inferred from a director's claim). */
	integrated: boolean;
	/** Full content version from the ledger; propagation shortens it. Any state may carry one (an answer judged unmet does). */
	version?: string;
	/**
	 * The ledger row still stands accepted or reviewable, so a consumer would bind its real version, although the
	 * controller found its location unusable now (`state` is then `unmet`). Absent for a row that never stood: one judged
	 * unmet carries a version too, and the record binds it as `missing`.
	 */
	standingVersion?: true;
	/** Declared workspace-relative path, for a short consumer reference. */
	path?: string;
	/** Attested source location of an accepted answer; never the answer's prose. */
	citation?: { path: string; line?: number };
	/** Verified retained isolated artifact: the exact source a consumer may read, never a guessed path. */
	retained?: { ref: string; path: string; digest?: string; kind: "patch" | "file" | "directory" | "parent-file" | "parent-files" };
	/** Why an otherwise observed result is not currently usable (for example a vanished retained artifact). */
	reason?: string;
	/** The producing lane runs in its own checkout; its changes never reach the parent in this version. */
	isolated?: boolean;
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
 * How long a placed writer that was never admitted blocks another spawn. It mirrors `PENDING_SPAWN_MS`: a placement whose
 * spawn never starts frees its lane instead of blocking the run forever. It never applies to a worker that was admitted
 * or to a follow-up awaiting its turn: their reservations end only with the events listed at `ReservationEndReason`, and
 * a late start of a lapsed placement has to pass the conflict check and reserve again.
 */
export const PENDING_WRITE_MS = 30_000;

/** How many lapsed placements are remembered for a late start to find; the oldest is forgotten first. */
const LAPSED_MAX = 256;

/**
 * Session-wide counters behind the generated handles of unplanned items (R4). One Storm instance is one session, and
 * the counters never restart, so a handle is never a name omp has already seen (it would dedupe it to `-2`, which no
 * placement matches). A reload starts a new instance: a reused name is then refused, never guessed.
 */
let sessionHandleSerial = 0;

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
 * The old one-concrete-lane-per-item resolver, kept for the extension's pre-effect gate until the wiring pass removes
 * it. New placement uses `resolveTaskLanes`, which places what this refuses as the unplanned record state (R5); the
 * two differ for a job lane, another role's lane, and an ambiguous or absent name.
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

/** Tag of the one-line note the call's result adds when a name that named a lane was placed unplanned (R5). */
export const UNPLANNED_NOTE_TAG = "[storm:무계획]";

/** Why an item that named a lane was placed unplanned (R5); the call's result counts these by cause (B9/D11). */
export type PlacementNoteCause = "job-lane" | "role-mismatch";

/** One note about an item that did not match a lane, with its cause so the call's result can bound the text. */
export interface PlacementNote {
	cause: PlacementNoteCause;
	text: string;
}

function jobLaneNote(agent: string, name: string, job: string): PlacementNote {
	return { cause: "job-lane", text: `${UNPLANNED_NOTE_TAG} ${agent}: '${name}' 레인은 정형 작업 레인(job: ${job})이라 AI 워커에 배정할 수 없어 계획 밖 워커로 배치했습니다.` };
}

function roleMismatchNote(agent: string, name: string, laneRole: string): PlacementNote {
	return { cause: "role-mismatch", text: `${UNPLANNED_NOTE_TAG} ${agent}: '${name}' 레인은 '${laneRole}' 역할의 레인이라 이 항목의 역할과 맞지 않아 계획 밖 워커로 배치했습니다.` };
}

/** How many examples of one mismatch cause the call's result shows before it counts the rest (B9/D11). */
export const PLACEMENT_NOTE_EXAMPLES = 2;

const NOTE_CAUSE_LABEL: Readonly<Record<PlacementNoteCause, string>> = {
	"job-lane": "정형 작업 레인",
	"role-mismatch": "역할이 다른 레인",
};

/**
 * The call's result carries a bounded explanation, never one line per item: a batch of many names that all mismatched
 * costs the director's context a constant amount (B9/D11). The count and the cause stay, and the per-item detail is
 * the item's own placement in the run, not the context path.
 */
export function boundedPlacementNotes(notes: readonly PlacementNote[]): string[] {
	const groups = new Map<PlacementNoteCause, string[]>();
	for (const note of notes) {
		const list = groups.get(note.cause);
		if (list === undefined) groups.set(note.cause, [note.text]);
		else list.push(note.text);
	}
	const out: string[] = [];
	for (const [cause, texts] of groups) {
		out.push(...texts.slice(0, PLACEMENT_NOTE_EXAMPLES));
		if (texts.length > PLACEMENT_NOTE_EXAMPLES) {
			out.push(`${UNPLANNED_NOTE_TAG} 같은 이유(${NOTE_CAUSE_LABEL[cause]})로 계획 밖에 둔 항목이 ${texts.length - PLACEMENT_NOTE_EXAMPLES}개 더 있습니다.`);
		}
	}
	return out;
}

/** One task item's placement: a planned lane, or unplanned (no lane) with the note the call's result carries. */
export interface TaskItemPlacement {
	lane?: PlanLane;
	note?: PlacementNote;
}

export type TaskPlacements =
	| { ok: true; items: TaskItemPlacement[] }
	| { ok: false; code: "lane"; reason: string };

/**
 * R5: every item of one call resolved to a lane or to the unplanned record state. A name that matches a lane of
 * another role or a job lane is unplanned with one note for the call's result. The same lane twice in one batch is
 * still refused. An item whose name matches no lane at all takes its role's only usable lane, as manual direction
 * always did: the director's own handle names no lane, so there is nothing to match or mismatch. That lane is
 * unambiguous only when the role has exactly one left in this batch; with none or several the item is unplanned, with
 * no refusal. With no plan every item is unplanned. This is the lane resolution every new placement uses;
 * `plannedTaskLanes` stays for callers the wiring pass still has to replace.
 */
export function resolveTaskLanes(input: unknown, plan: RunPlan | undefined, config: StormConfig): TaskPlacements {
	if (!object(input)) return { ok: false, code: "lane", reason: TASK_ITEM_INVALID_REASON };
	const items: unknown[] = Array.isArray(input.tasks) ? input.tasks : [input];
	if (items.length === 0) return { ok: false, code: "lane", reason: TASK_EMPTY_REASON };
	// One index of the plan, not a scan per item (D11): a large plan with many workers stays O(items).
	const byName = new Map<string, PlanLane>();
	const byRole = new Map<string, PlanLane[]>();
	for (const candidate of plan?.lanes ?? []) {
		if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
		if (candidate.job !== undefined) continue;
		const list = byRole.get(candidate.role);
		if (list === undefined) byRole.set(candidate.role, [candidate]);
		else list.push(candidate);
	}
	const used = new Set<string>();
	const placed: TaskItemPlacement[] = [];
	for (const item of items) {
		if (!object(item)) return { ok: false, code: "lane", reason: TASK_ITEM_INVALID_REASON };
		const agent = typeof item.agent === "string" ? item.agent : "task";
		const role = workerRole(config, agent);
		const name = typeof item.name === "string" ? item.name : undefined;
		const named = name === undefined ? undefined : byName.get(name);
		if (named !== undefined && name !== undefined) {
			if (named.job !== undefined) {
				placed.push({ note: jobLaneNote(agent, name, named.job) });
				continue;
			}
			if (role === undefined || named.role !== role) {
				placed.push({ note: roleMismatchNote(agent, name, named.role) });
				continue;
			}
			if (used.has(named.name)) return { ok: false, code: "lane", reason: `${name}: 같은 배치에서 이미 사용한 레인입니다.` };
			used.add(named.name);
			placed.push({ lane: named });
			continue;
		}
		if (plan !== undefined) {
			// The director's own name that matches no lane: the one lane of this agent's role is unambiguous, and manual
			// direction has always kept the caller's handle and bound it there. A wrong-role or job-lane name was decided
			// above (unplanned, R5); with no lane or several, the item is unplanned below.
			const eligible = role === undefined ? [] : (byRole.get(role) ?? []).filter(candidate => !used.has(candidate.name));
			if (eligible.length === 1) {
				used.add(eligible[0]!.name);
				placed.push({ lane: eligible[0]! });
				continue;
			}
		}
		// A name that matches nothing with no unambiguous role lane, or any item with no plan, is the unplanned record
		// state (R5).
		placed.push({});
	}
	return { ok: true, items: placed };
}

/**
 * The extension's old pre-effect view of `plannedTaskLanes`; undefined when the plan is absent. It still refuses the
 * job/wrong-role/ambiguous names that R5 now places unplanned, so the wiring pass must stop calling it before `place`
 * (which uses `resolveTaskLanes`); kept until then so the extension compiles and behaves as it did.
 */
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

/**
 * The task fields with which a caller can change a worker's reasoning. omp gives a caller's `effort` precedence over the
 * model and effort the spawn hook answers with, and a caller's `model` over a native agent's own list, so a worker would
 * run above what the team approved while Storm's record says otherwise. Placement removes both from every form of the call.
 */
export const TASK_PINNED_FIELDS = ["effort", "model"] as const;

/** Tag of the line that tells the director why the value it passed in its `task` call was not used. */
export const PINNED_NOTE_TAG = "[storm:승인값]";

/** What the director reads, once per call, when its call carried an `effort` or `model`. A fixed noun stands after the inserted names. */
export function pinnedFieldsNote(fields: readonly string[]): string {
	const shown = fields.map(field => `\`${field}\``).join(", ");
	return `${PINNED_NOTE_TAG} 이 호출의 ${shown} 값은 쓰지 않았습니다. 워커의 모델과 추론 강도는 사용자가 승인한 팀 설정이 정하므로 task 호출로 바꿀 수 없고, 승인된 값으로 시작했습니다. 다른 값이 필요하면 사용자가 팀 설정을 바꾸어 다시 승인해야 합니다.`;
}

/** The call's own copy without `effort` and `model`; the fields found are added to `found`. Untouched when it has neither. */
function withoutPinnedFields(item: Record<string, unknown>, found: Set<string>): Record<string, unknown> {
	let next = item;
	for (const field of TASK_PINNED_FIELDS) {
		if (!Object.hasOwn(next, field)) continue;
		found.add(field);
		if (next === item) next = { ...item };
		delete next[field];
	}
	return next;
}

function isolationCapabilityReason(agent: string, enabled: boolean | undefined): string {
	const state = enabled === false ? "꺼져 있습니다(task.isolation.enabled=false)" : "상태를 확인하지 못했습니다";
	return `${agent}: 이 작업은 부모 트리와 분리된 격리 실행이 필요한데 omp 격리가 ${state}. ` +
		"격리를 켜는 것은 사용자의 omp 설정(`omp config set task.isolation.enabled true`, 확인은 `omp config list --json`)입니다. " +
		"지금 쓸 수 없으면 계획의 isolationReason을 빼고 공유 레인으로 다시 계획하세요. 공유 쓰기 레인은 한 번에 하나씩 시작합니다.";
}

function isolationApplyReason(agent: string, lane: string, apply: boolean | undefined): string {
	const head =
		apply === true
			? `${agent}: '${lane}' 레인은 부모 트리 밖에 남는 독립 결과가 필요한데 omp가 격리 결과를 부모 작업 트리에 자동 적용합니다(task.isolation.apply=true). `
			: `${agent}: '${lane}' 레인은 부모 트리 밖에 남는 독립 결과가 필요한데 omp가 격리 결과를 부모 작업 트리에 자동 적용하는지 확인하지 못했습니다(task.isolation.apply 값을 읽지 못함). 적용이 켜져 있으면 워커가 끝난 뒤 예약 없이 부모 트리가 바뀝니다. `;
	return head +
		"`omp config set task.isolation.apply false`로 적용을 끄고, `omp config list --json`으로 값을 확인한 뒤 다시 스폰하세요. " +
		"결과를 부모 트리에 합쳐도 되면 그 레인의 isolationReason을 빼고 공유 레인으로 계획하고, 별도 결과가 필요하면 격리 레인을 분리해 patch/branch 산출물 경로를 결과로 받으세요.";
}

/**
 * The team says `isolation: isolated`, so every worker's output is meant to stay out of the parent tree, yet omp merges an
 * isolated worker's changes into it after the worker ended, when no reservation holds the tree. The user's own omp setting
 * decides that, so the refusal names it; the other way out is a shared team, whose writers go one at a time.
 */
function teamIsolationApplyReason(agent: string, apply: boolean | undefined): string {
	const head =
		apply === true
			? `${agent}: 팀 설정이 isolation: isolated인데 omp가 격리 워커의 변경을 워커가 끝난 뒤 부모 작업 트리에 자동으로 합칩니다(task.isolation.apply=true). `
			: `${agent}: 팀 설정이 isolation: isolated인데 omp가 격리 워커의 변경을 부모 작업 트리에 자동으로 합치는지 확인하지 못했습니다(task.isolation.apply 값을 읽지 못함). 합치기가 켜져 있으면 그때 이 트리를 지키는 예약이 없습니다. `;
	return head +
		"`omp config set task.isolation.apply false`로 적용을 끄고, `omp config list --json`으로 값을 확인한 뒤 다시 스폰하세요. " +
		"결과를 부모 트리에 합쳐도 되면 사용자가 팀의 isolation을 shared로 바꾸어 다시 승인하세요. 공유 팀의 쓰기 레인은 한 번에 하나씩 시작합니다.";
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

/**
 * The citation form an answer is read by: said where an unmet answer is refused and where the director is told. This
 * is P3-cite's wording; it lists the aliases `answerCitations` normalises and no longer says `#L` is unread (R13).
 * It is long enough that `tests/dependency-words.test.ts`'s `< 300` refusal budget must be raised by the citation
 * slice (the unmet refusal is 364 characters with it; see the report).
 */
export const ANSWER_CITATION_FORM =
	"읽기 전용 답은 프로젝트 안 파일의 path:line 인용이 있어야 합니다(path#L12, path#L12-L20, [텍스트](path#L12)도 같은 위치로 읽습니다. local://, agent://, URL은 읽지 않음).";

/**
 * The same rule in one short line, for a refusal that already carries the ledger's reason. The full alias list lives in
 * the worker contract (`CITATION_ALIAS_FORMS`) and in `ANSWER_CITATION_FORM`; a refusal stays under the existing
 * readability budget (`tests/dependency-words.test.ts`) while still saying which forms are read and which are not.
 */
export const ANSWER_CITATION_HINT =
	"path:line 인용 필요(path#L12도 읽음; local://, agent://, URL 제외)";

/** Tag of the line the director reads when a delivery changed the ledger. */
export const LEDGER_NOTICE_TAG = "[storm:결과]";

/**
 * Row 5: an isolated producer's result will not change by waiting and a finished checkout must not be messaged. The one
 * sentence is exported so the refusal and its test quote the same advice.
 */
export const ISOLATED_STALE_ADVICE = "새 격리 시도를 계획하고 끝난 체크아웃에 후속 지시를 보내지 마세요";

/** One result a delivery left short of acceptance, as the ledger holds it now. */
export interface LedgerNoticeRow {
	id: string;
	kind: LaneResultKind;
	state: RunResult["state"];
	reason?: string;
}

/** What the notice calls a waiting lane whose prerequisites all hold; it does not say the lane can start. */
export const LEDGER_READY_LEAD = "선행이 충족된 대기 레인";

/**
 * The one line the director reads when the worker that held the shared write order ended: which unstarted writing
 * lanes the placement gate would now let start. Facts only; nothing is started and the spawn guard still decides.
 */
export const WRITER_FREED_LEAD = "쓰기 순서가 풀려 지금 시작할 수 있는 레인";

export function writerFreedNotice(names: readonly string[]): string | undefined {
	if (names.length === 0) return undefined;
	const shown = names.slice(0, 6).join(", ") + (names.length > 6 ? ` 외 ${names.length - 6}개` : "");
	return `${LEDGER_NOTICE_TAG} ${WRITER_FREED_LEAD}: ${shown}. 예산과 동시 실행 상한은 스폰 검사가 정합니다.`;
}

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
				result.isolated === true
					? `미충족은 기다려도 바뀌지 않습니다. 이 버전은 격리 작업을 부모 트리로 가져오지 않으므로 ${ISOLATED_STALE_ADVICE}.`
					: result.kind === "answer"
						? `${ANSWER_CITATION_HINT}. 그 워커에게 ${withJosa(follow, "으로/로")} 인용을 요청하세요.`
						: `미충족은 기다려도 바뀌지 않습니다. 사유를 보고 그 워커에게 ${withJosa(follow, "으로/로")} 보완을 요청하세요.`,
			);
		} else if (result.state === "reviewable") {
			notes.add(
				need === "result"
					? "검토 가능은 아직 수용이 아니며 승인된 리뷰어의 판정이 있어야 합니다. 제출만 필요하면 이 선행의 need를 reviewable로 바꿔 다시 계획하세요."
					: "검토 가능은 아직 수용이 아니며 승인된 리뷰어의 판정이 있어야 합니다.",
			);
		} else if (result.isolated === true && need === "integrated") {
			// Row 5: no version of this run can produce the integrated proof the edge asks for.
			notes.add("이 버전은 격리 작업을 부모 트리에 통합하지 않으므로 이 조건은 기다려도 충족되지 않습니다. need를 result로 바꾸거나 통합 버전을 기다리세요.");
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

/**
 * Whether the producer row this result stands on would hand a consumer a real version if the consumer started now: it
 * is accepted, or it still stands accepted or reviewable in the ledger though its location no longer holds
 * (`standingVersion`). The presence of a version is not the test: a row that answered and was judged unmet carries one
 * too, and a consumer started on it records `missing` (see `inputSnapshot`), so its result is never accepted on that
 * input. A merely reviewable row is not accepted, so `staleRequirementIdsForPlan` reopens any consumer of it on a
 * `result`/`integrated` edge the moment that consumer settles.
 */
function bindsAcceptedVersion(result: LaneResultReadiness): boolean {
	return result.state === "accepted" || result.standingVersion === true;
}

/** The outcome of the start check for a lane's prerequisites: refused, or started with what the director must read. */
export type DependencyStart = { ok: true; notes: string[] } | { ok: false; reason: string };

/**
 * A lane whose prerequisite is not accepted yet may start. What makes that safe is the run record, not this check:
 * a consumer attempt records the producer version it started from (`inputSnapshot`, bound by `prepareAttempt`), a
 * prerequisite that had no usable submission is recorded as `missing`, and the record never accepts a result on a
 * `missing` input, nor on one whose producer version changed afterwards (`staleRequirementIds`, `#staleInputs`,
 * `#invalidateConsumers` in controller.ts). So the start loses nothing the count could show falsely, and the director is
 * told in the result of the call what state the prerequisite is in and what that means for the work it just started.
 *
 * Three cases keep the refusal, because the record does not tie the consumer to what the edge asks for:
 * - no readiness view of the prerequisite (nothing is known);
 * - a prerequisite lane with no declared results (no row, so no version to bind or reopen);
 * - an open result whose row is accepted, or still carries a version, while the edge is not met from its current
 *   location: an `integrated` edge on an accepted result the tree does not carry, a vanished retained artifact. The
 *   consumer would bind that real version, and nothing reopens it when the result is integrated or located later.
 */
export function dependencyStart(lane: PlanLane, readiness: LaneReadinessView | undefined): DependencyStart {
	const notes: string[] = [];
	for (const dependency of lane.dependsOn ?? []) {
		const state = readiness?.get(dependency.lane);
		if (state === undefined) return { ok: false, reason: dependencyBlock(lane, readiness) ?? "" };
		const shortfall = dependencyShortfall(dependency.need, state);
		if (shortfall === undefined) continue;
		const open = openResults(dependency.need, state);
		// Nothing open and the worker not running means the shortfall is something else (a kindless view's integration):
		// the record ties none of it, so it is refused like the cases above.
		if (state.results.length === 0 || open.some(bindsAcceptedVersion) || (open.length === 0 && !state.running)) {
			return { ok: false, reason: dependencyBlock(lane, readiness) ?? "" };
		}
		// A fixed noun stands between each inserted value and its particle.
		if (open.length === 0) {
			// Only a running worker is open: the accepted result it stands on is what this lane starts from.
			notes.push(
				`'${lane.name}' 레인은 선행 '${dependency.lane}' 레인의 ${NEED_LABEL[dependency.need]} 조건이 확정되기 전에 시작했습니다(${shortfall}). 지금 수용된 선행 결과를 입력으로 시작했으므로, 그 워커가 결과를 바꾸면 이 레인의 결과는 수용되지 않고 다시 열립니다.`,
			);
			continue;
		}
		notes.push(
			open.some(result => result.isolated === true)
				? `'${lane.name}' 레인은 선행 '${dependency.lane}' 레인의 ${NEED_LABEL[dependency.need]} 조건이 충족되기 전에 시작했습니다(${shortfall}). 이 버전은 격리 작업을 부모 트리로 가져오지 않으므로 선행이 저절로 충족되지 않습니다. ${ISOLATED_STALE_ADVICE}.`
				: `'${lane.name}' 레인은 선행 '${dependency.lane}' 레인의 ${NEED_LABEL[dependency.need]} 조건이 충족되기 전에 시작했습니다(${shortfall}). 선행 결과가 수용되지 않은 입력으로 만든 결과라 이 레인의 결과는 수용되지 않습니다. 선행이 수용된 뒤 이 워커에게 후속 지시(write agent://<id>)를 보내 다시 하게 하세요.`,
		);
	}
	return { ok: true, notes };
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
 * A read lane that may run commands (a review lane or any other) is ordered like an unknown writer (a command can change the tree). Automatic
 * delegation does not change any of this: the scope follows the agent's tools and the lane's declared files.
 */
function writeScope(
	lane: PlanLane | undefined,
	role: string | undefined,
	isolated: boolean,
	policy?: LanePolicy,
	canonicalFiles?: readonly string[],
): WriteScope {
	if (isolated) return { kind: "private" };
	if (policy !== undefined) {
		// A read lane that may run commands is ordered like an unknown writer; its reason names a review lane or any other read lane.
		if (policy.kind === "read") return shellReader(policy) ? { kind: "unknown", why: shellReaderWhy(lane) } : { kind: "read" };
		if (policy.kind === "private") return { kind: "private" };
		if (policy.kind === "unknown") return { kind: "unknown", why: policy.reason };
		// A blocked lane is refused before any placement; if one ever gets here it is treated as an unbounded writer.
		if (policy.kind === "blocked") return { kind: "unknown", why: WHY_EXEC_WRITER };
		return { kind: "paths", paths: [...new Set(canonicalFiles ?? policy.paths ?? lane?.files ?? [])].sort() };
	}
	if (lane !== undefined && (lane.files?.length ?? 0) > 0) return { kind: "paths", paths: normalizeFiles(lane) };
	const laneRole = lane?.role ?? role;
	const changes = lane !== undefined && ((lane.results ?? []).some(result => result.kind !== "answer") || WRITING_KINDS[lane.kind] === true);
	if (changes || (laneRole !== undefined && WRITING_ROLES[laneRole] === true)) return { kind: "unknown", why: WHY_UNDECLARED_WRITER };
	if (laneRole !== undefined && READ_ONLY_ROLES[laneRole] === true) return { kind: "read" };
	return { kind: "unknown", why: WHY_UNDECLARED_WRITER };
}

/**
 * The write table's scope for an unplanned item's classified authority (R6). The classification owns the mapping from
 * tools and isolation to the authority; this only adds the short cause a write-order refusal shows.
 */
function scopeOfAuthority(authority: WriteAuthority, policy: LanePolicy): WriteScope {
	switch (authority.kind) {
		case "read":
			return { kind: "read" };
		case "private":
			return { kind: "private" };
		case "paths":
			return { kind: "paths", paths: [...new Set(authority.paths ?? [])].sort() };
		case "unknown":
			return { kind: "unknown", why: policy.kind === "read" ? WHY_SHELL_READER : policy.reason };
	}
}

/** The public form of a frozen scope, for the admission result (R3). */
function publicAuthority(scope: WriteScope): WriteAuthority {
	return scope.kind === "paths" ? { kind: "paths", paths: [...scope.paths] } : { kind: scope.kind };
}

/** What a refused write order tells the director to check before it sends the same call again. */
export const WRITE_ORDER_CHECK = "끝났는지는 wait 도구나 완료 알림으로 먼저 확인하고, 그 전에 같은 호출을 되풀이하지 마세요.";

/** Two shared writes collide when their path scopes overlap by directory prefix; an unknown scope can touch anything. */
function scopesConflict(a: WriteScope, b: WriteScope): boolean {
	if (a.kind === "unknown") return b.kind === "paths" || b.kind === "unknown";
	if (b.kind === "unknown") return a.kind === "paths";
	if (a.kind !== "paths" || b.kind !== "paths") return false;
	return scopesOverlap(a.paths, b.paths);
}

/**
 * Why two shared writes may not start together, and the one next step that works for this refusal. A lane that declared
 * files is told so: for an exclusive writer (a `bash`/`eval` tool, a reviewer with a shell) the files do not narrow what it
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
	/** The other writer is the director's own path edit: it ends with the message that made it, not with a worker's end. */
	directorEdit = false,
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
		: directorEdit
			? DIRECTOR_EDIT_RETRY
			: `${withJosa(other, "이/가")} 끝난 뒤 같은 호출을 다시 보내세요. ${WRITE_ORDER_CHECK}`;
	return `${head} ${next}`;
}

/** The earlier writer a refusal names, as a noun phrase: a reservation may be placed but not yet running. */
function earlierWriter(lane: string | undefined): string {
	return lane === undefined ? "먼저 시작한 공유 작업" : `먼저 시작한 '${lane}' 레인`;
}

/** What one entry of the write table is, as a noun phrase a refusal names. */
function heldBy(entry: { kind?: HolderKind; lane?: string }): string {
	switch (entry.kind) {
		case "director-path":
			return DIRECTOR_EDITING;
		case "director-exec":
			return "감독이 실행 중인 명령";
		case "director-bg":
			return "감독이 백그라운드로 돌린 명령";
		case "job":
			return "실행 중인 정형 작업";
		case "check":
			return "실행 중인 필수 검사";
		case "fence":
			return "끝났는지 확인되지 않은 정형 작업이나 검사";
		default:
			return earlierWriter(entry.lane);
	}
}

/** The scope every non-worker holder has: it can change the shared tree anywhere. */
function holderScope(kind: Exclude<HolderKind, "director-path">): WriteScope {
	return { kind: "unknown", why: kind === "director-exec" || kind === "director-bg" ? WHY_DIRECTOR_COMMAND : WHY_HOST_COMMAND };
}

interface WriteReservation {
	scope: WriteScope;
	/** Placed by this tool call (task) or follow-up delivery. */
	callId?: string;
	/** A work follow-up admitted but whose reactivated turn has not started: settled state must not release it yet. */
	awaiting?: boolean;
	/**
	 * A note was sent to this worker while the agent list showed it running. That list can lag the worker's own turn: the turn
	 * may have ended and the note woken a new one the director side has not seen (R-final N4). Until the write's receipt says the
	 * note joined an open turn (`noteDelivered`), the reservation is not ended by the list. `idle`: the list has shown the worker not
	 * running since the note, so the next running row is a start and not the turn that was open when the note went out.
	 */
	note?: { idle: boolean; callId?: string };
	/** Whether the reservation was already awaiting a woken turn when the note went out (it is again if the note is taken back). */
	noteAwaitedBefore?: boolean;
	lane?: string;
	agentId?: string;
	/** The handle reserved for this spawn before the host allocates its id; used only for release matching. */
	name?: string;
	/** Identity of the placed item that reserved it; it survives the spawn's admission binding an agent id. */
	placement?: number;
	/**
	 * The bound worker was seen running, or its start event arrived. From then on its own settled state ends the
	 * reservation; before that an idle row with no request is a fresh start, not a finished turn.
	 */
	seen?: true;
	/** Set on an entry that is not a worker's (see `HolderKind`). */
	kind?: HolderKind;
	/** The host job a `director-bg` entry stands for. */
	jobId?: string;
	/**
	 * The worker's turn ended but the host has not finished what it still does for it (its parent's call is open, or its task
	 * job still runs: omp cancels and reaps the worker's jobs and merges before either ends). Only that end frees the place.
	 */
	settled?: true;
	at: number;
}

/**
 * Why a bound reservation ended. Each is an event that ends the worker's authority to write; none is a timer.
 * - `settled`: the worker's turn settled, it was parked or killed, or the host reported it failed (the director side reads
 *   the agent list; the child's own `agent_end` reports it where the module is shared).
 * - `cancelled`: a later guard refused the spawn after the late admission had reserved it.
 * - `refused`: the late admission found a conflicting writer.
 * - `call-failed`: the director's call failed before its worker was admitted, or a follow-up's call failed or was cancelled.
 * - `follow-up-failed`: a follow-up's preflight failed after it reopened the worker's authority.
 */
export type ReservationEndReason = "settled" | "cancelled" | "refused" | "call-failed" | "follow-up-failed";

/** A bound write reservation ended: the worker that held it no longer has an order to write behind it. */
export interface ReservationEnd {
	runId: string;
	/** The host id of the worker (its spawn key); the persisted write authority is keyed by it. */
	agentId: string;
	lane?: string;
	reason: ReservationEndReason;
	/** When the end was noticed; a persisted authority written later belongs to a newer attempt and is not this end's. */
	at: number;
}

const endListeners = new Set<(end: ReservationEnd) => void>();

/**
 * Subscribes to every bound reservation that ends, in any run of this process. The persisted write authority of the worker
 * must end with its reservation (revoke it with `revokeWorkerAdmissions({ runId, childId: agentId, createdBefore: at })`),
 * so that no worker holds authority that no reservation stands behind. Returns the unsubscribe.
 */
export function onLaneReservationEnd(listener: (end: ReservationEnd) => void): () => void {
	endListeners.add(listener);
	return () => {
		endListeners.delete(listener);
	};
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
	/** The item carried its own eval-defined `tools` (D7/R6); the fact travels to its spawn hook. */
	toolsCarried: boolean;
	/** The bounded note this item adds to the call's result when its name named a lane it cannot use (R5/B9). */
	note?: PlacementNote;
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
	 * A quiet `?progress` note. It carries no work: it takes no lane hold, write reservation or worker slot of its own.
	 * With `wakeReadOnly` it passes no prerequisite, capacity or write-order gate; without it, an idle recipient's turn
	 * may write, so it meets the capacity and write-conflict gates. A blocked policy and a job lane refuse it either way.
	 */
	progress?: boolean;
	/**
	 * The caller proves the turn a progress note wakes can only read and report: it did not re-open the worker's write
	 * admission for the note. Only then is the note exempt from the prerequisite, capacity and write-order gates. Absent,
	 * the note meets them as a message that may start a writer.
	 */
	wakeReadOnly?: boolean;
	/** The host's tool-call id of this write, so its failure releases exactly this admission. */
	callId?: string;
	/** Ignored: automatic delegation does not change a lane's write scope. Callers may still pass it. */
	auto?: boolean;
	/** The plan in force when the lane was resolved; absent means no planned lane. */
	plan?: RunPlan;
	/** Ignored: the plan's worker count per role is no longer a limit. Callers may still pass it. */
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
	| {
			ok: true;
			token: string;
			reserved?: boolean;
			notes?: string[];
			/** The write reservation now bound to the woken turn (R7): a fresh `hold` for the new attempt. */
			hold?: string;
	  }
	| { ok: false; reason: string; code: LaneBlockCode; retry?: boolean };

/**
 * `write agent://all` wakes every parked worker at once, and omp does not count those wakes against its ceiling. The
 * ceiling (`task.maxConcurrency`, the user's own setting) is the one limit a broadcast meets: this refuses it only when
 * the workers that would be running after the wake exceed that ceiling. It never looks at roles, lanes or plan counts,
 * and a worker woken this way has no write authority (its admission ended with its last turn), so no write order applies.
 * Returns the refusal text, or undefined when the broadcast may go.
 */
export function broadcastBlock(input: {
	runId?: string;
	agents: readonly AgentEntry[];
	maxConcurrency?: number;
	otherActive?: number;
	now?: number;
}): string | undefined {
	const limit = input.maxConcurrency;
	if (limit === undefined || limit <= 0) return undefined;
	const reserved = input.runId === undefined ? [] : reservedWorkers(input.runId);
	const active = activeAgents([], input.agents, input.now ?? Date.now(), reserved);
	const waking = input.agents.filter(agent => agent.state !== "running" && !reserved.some(slot => slot.key === agent.id)).length;
	const after = active.total + waking + (input.otherActive ?? 0);
	if (after <= limit) return undefined;
	return `agent://all 은 쉬는 워커 ${waking}명을 한꺼번에 깨워 OMP 동시 상한(task.maxConcurrency ${limit})을 넘기므로 보내지 않았습니다. agent://<id>로 필요한 워커에게만 보내거나, 진행 중인 워커가 끝난 뒤 다시 보내세요.`;
}

/** What the hook is told about the placement whose authority it must turn into the policy it persists (R3). */
export interface FrozenPlacement {
	/** The authority the placement froze for this child. */
	authority: WriteAuthority;
	/** The planned lane's name; absent for an unplanned placement. */
	lane?: string;
	/** The item carried its own eval-defined `tools` (D7/R6): what was reserved is what the hook must permit (A1-7). */
	toolsCarried: boolean;
}

/** What the director session's own spawn hook must tell the admission step (R3, R4, R7). */
export interface AdmitOptions {
	/**
	 * This is the director session's own `task` child (R1). Its spawn key must equal a pending placement of this run
	 * exactly (R4), and the policy the hook will persist must be no wider than the authority the placement froze (R3).
	 * The hook derives that policy from the frozen authority, because only the placement knows whether the item is
	 * isolated and whether it carried tools of its own. Without it, older callers keep the permissive reading: an
	 * unmatched spawn is admitted with no lane and reserves nothing.
	 */
	directorTask?: {
		/** The policy the hook will persist for the child, derived from the frozen placement. */
		policy: (frozen: FrozenPlacement) => LanePolicy;
	};
}

/**
 * One spawn's admission result. `lane` is the planned lane; `hold` is the write reservation bound to this child, which
 * the main-session hook stores on the worker admission so the guard can tell an authorised writer from a reader (R7).
 * An unplanned isolated child holds no shared reservation; its `hold` is a `private:` mark that ends with the
 * admission's revoke and lets it write inside its own checkout (D10). `authority` is the placement's frozen scope; the
 * hook derives the policy it will persist from it (R3), and `policy` is that proven value.
 */
export type LaneAdmission =
	| { ok: true; lane?: string; placed?: boolean; hold?: string; authority?: WriteAuthority; policy?: LanePolicy }
	| { ok: false; code: LaneBlockCode | "internal"; reason: string };

/** Said when a director task spawn's key is not exactly a pending placement of this run (R4). */
export function spawnKeyMismatchReason(spawnKey: string): string {
	return `스폰 키(${spawnKey})가 이 실행의 대기 중인 배치와 정확히 같지 않아 자식 스폰을 허용하지 않았습니다. 같은 task 호출을 다시 보내 새 배치를 만드세요.`;
}

/** Said when the hook's policy is wider than what the placement reserved (R3). */
export const PLACEMENT_CHANGED_REASON =
	"설정이 배치 뒤에 바뀌었습니다. 이 자식의 승인된 권한이 배치 때 예약한 쓰기 범위보다 넓어 스폰을 허용하지 않았습니다. 같은 task 호출을 다시 보내 새 배치를 만드세요.";

const liveLanes = sharedMap<string, WeakRef<RunLanes>>("storm.lanes.liveLanes");

/** A finished run's key leaves the shared registry; the object itself goes with the controller that owned it. */
export function forgetRunLanes(runId: string): void {
	liveLanes.delete(runId);
}

/**
 * A child session loads the extension on its own and holds no run, yet its turn start is the fact that ends a follow-up's
 * admission window in the run's lanes. The newest lanes of the run id receive it; an unknown agent changes nothing.
 */
export function noteLaneAgentStart(runId: string, agentId: string): void {
	liveLanes.get(runId)?.deref()?.agentStarted(agentId);
}

/**
 * A child session's settled turn, park or shutdown, told to the run's lanes on the same thread. A child holds no
 * RunController, so its own `agent_end` cannot reach the run's lanes any other way; on another host thread this finds
 * nothing and the director side's reading of the agent list ends the reservation instead.
 */
export function noteLaneAgentEnd(runId: string, agentId: string): void {
	liveLanes.get(runId)?.deref()?.releaseAgent(agentId);
}

/** One call's items, resolved to lanes and classified, after every isolation capability check but before any name or reservation. */
type DescribedPlacement =
	| { ok: true; batch: boolean; items: unknown[]; placed: PlacedEntry[] }
	| { ok: false; code?: LaneBlockCode | "lane" | "isolation"; reason: string };

/**
 * Resolves and classifies one `task` call without side effects. The placement and the caller's pre-open/pre-lease check
 * both use it, so what the caller proved is what the placement decides: a batch that needs the target's write claim
 * here is exactly a batch that will reserve a shared writer below (A2-1, D11: one pass over the items).
 */
function describePlacement(
	input: unknown,
	plan: RunPlan | undefined,
	config: StormConfig,
	options: TaskPlacementOptions,
): DescribedPlacement {
	if (!object(input)) return { ok: false, code: "lane", reason: TASK_ITEM_INVALID_REASON };
	const batch = Array.isArray(input.tasks);
	const items: unknown[] = Array.isArray(input.tasks) ? input.tasks : [input];
	if (!items.length) return { ok: false, code: "lane", reason: TASK_EMPTY_REASON };
	const resolved = resolveTaskLanes(input, plan, config);
	if (!resolved.ok) return { ok: false, code: resolved.code, reason: resolved.reason };
	const teamIsolated = config.isolation === "isolated";
	const placed: PlacedEntry[] = [];
	for (const [index, item] of items.entries()) {
		if (!object(item)) return { ok: false, code: "lane", reason: TASK_ITEM_INVALID_REASON };
		const agent = typeof item.agent === "string" ? item.agent : "task";
		const role = workerRole(config, agent);
		const lane = resolved.items[index]?.lane;
		const note = resolved.items[index]?.note;
		const policy = lane === undefined ? undefined : options.policies?.get(lane.name);
		if (policy?.kind === "blocked") return { ok: false, code: "lane-capability", reason: policy.reason };
		const reason = lane?.isolationReason;
		if (reason !== undefined && lane !== undefined && (lane.role === "reviewer" || lane.kind === "review")) {
			return { ok: false, code: "isolation", reason: `${agent}: 최종 리뷰는 통합 트리를 봐야 하므로 격리 레인이 될 수 없습니다. isolationReason을 빼거나 독립 실험을 별도 code/run 레인으로 분리하세요.` };
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
			// An unplanned item may ask for its own checkout (D10): it is private, and runs beside other writers.
			desired = true;
			requiresIsolation = true;
		}
		const toolsCarried = carriesEvalTools(item);
		// eval-defined tools run in the director's kernel, outside any checkout (D7/HF-3): an isolated item that
		// carries them would write beside other workers with no reservation, so it is refused on every lane.
		if (requiresIsolation && toolsCarried) {
			return { ok: false, code: "isolation", reason: isolatedToolsReason(agent) };
		}
		let scope: WriteScope;
		if (lane !== undefined) {
			// An item that carries its own tools is an exclusive shared writer on a planned lane too (D7/R6); the fact
			// travels to the hook, which persists a policy that permits the reserved effect (A1-7).
			scope = toolsCarried ? { kind: "unknown", why: WHY_ITEM_TOOLS } : writeScope(lane, role, requiresIsolation, policy, options.canonicalFiles?.get(lane.name));
		} else {
			const classified = classifyUnplannedItem(unplannedFacts(item, agent, teamIsolated, options.agentTools?.(agent)));
			if (!classified.ok) return { ok: false, code: classified.code, reason: classified.reason };
			scope = scopeOfAuthority(classified.item.authority, classified.item.policy);
		}
		placed.push({ item, lane, agent, desired, requiresIsolation, selective, scope, toolsCarried, ...(note === undefined ? {} : { note }) });
	}
	const needing = placed.find(entry => entry.requiresIsolation);
	if (needing !== undefined && options.host?.enabled !== true) {
		return {
			ok: false,
			reason: needing.lane === undefined
				? unplannedIsolationUnavailableReason(needing.agent, options.host?.enabled)
				: isolationCapabilityReason(needing.agent, options.host?.enabled),
		};
	}
	// Every isolated placement, a lane with an isolation reason and a team that says isolated alike, needs omp's merge of
	// an isolated worker's changes into the parent tree off: it happens after the worker ended, with nothing reserved.
	const merged = placed.find(entry => entry.requiresIsolation);
	if (merged !== undefined && options.host?.apply !== false) {
		return {
			ok: false,
			reason: merged.lane === undefined
				? unplannedIsolationApplyReason(merged.agent, options.host?.apply)
				: merged.selective
					? isolationApplyReason(merged.agent, merged.lane.name, options.host?.apply)
					: teamIsolationApplyReason(merged.agent, options.host?.apply),
		};
	}
	return { ok: true, batch, items, placed };
}

/**
 * What one call needs before it may be placed: the agents whose shared write the table will reserve. A pure read of the
 * same classification the placement uses; the caller takes the target's write claim when this names anyone (A2-1/R9).
 */
export type BatchWriteNeed =
	| { ok: true; writers: readonly string[] }
	| { ok: false; code?: LaneBlockCode | "lane" | "isolation"; reason: string };

export function batchWriteNeed(
	input: unknown,
	plan: RunPlan | undefined,
	config: StormConfig,
	options: TaskPlacementOptions = {},
): BatchWriteNeed {
	const described = describePlacement(input, plan, config, options);
	if (!described.ok) return described;
	return {
		ok: true,
		writers: described.placed.filter(entry => entry.scope.kind === "paths" || entry.scope.kind === "unknown").map(entry => entry.agent),
	};
}

/** Said when a placement would reserve a shared writer but the caller did not take (or prove) the target's write claim. */
export const WRITE_CLAIM_REQUIRED =
	"이 실행이 대상 작업 트리의 쓰기 권한을 가지고 있지 않아 공유 쓰기 작업을 배치하지 않았습니다. 읽기 작업만 보내거나 잠시 뒤 같은 호출을 다시 보내세요.";

/**
 * Correlates director task items to the actual ids OMP allocates. The host emits the allocated id, not the planned lane
 * name, so every placement gives the host a handle it has never seen (the lane's name stays the table and ledger key).
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
	 * The write scope each lane was last placed or reactivated with. The late recheck of an admission reads it when the
	 * lane's own reservation was pruned (its pending window ran out before the host allocated the spawn key): the scope
	 * decided from the approved policy, never one recomputed from the lane's declared files alone, which would let an
	 * exec-capable writer pass as a path-only one.
	 */
	readonly #laneScopes = new Map<string, WriteScope>();
	/**
	 * Placements that were never admitted and whose pending window ran out. Only such a placement may lapse by time, and
	 * only because a late start has to pass the conflict check again: the admission finds the placement here, checks its
	 * scope against the live reservations and reserves in the same synchronous step. Dropped when the call that made it
	 * fails, when its spawn is cancelled, or when a newer placement takes its key. Bounded: the oldest is forgotten.
	 */
	readonly #lapsed = new Map<string, WriteReservation>();
	/** A worker that held a shared write order settled since the flag was last taken (see `takeWriterFreed`). */
	#writerFreed = false;
	/**
	 * Logical lanes placed by a task call whose spawn has not been correlated yet. Read-only and private lanes reserve
	 * no write scope, so this is what makes a second independent dispatch of the same lane visible before the host
	 * allocates the first one's id. Cleared by the matching admission, cancel or release; expires like a pending write.
	 */
	readonly #held = new Map<string, LaneHold>();
	/** Follow-up admission tokens; only a failed preflight releases the write/capacity reservations it created. */
	readonly #followTokens = new Map<
		string,
		{ key?: string; created: boolean; capacityKey?: string; lane?: string; reservation?: WriteReservation; holdLane?: string; holdId?: number; noted?: true }
	>();
	/**
	 * The director's tool calls whose placement made a reservation and whose end Storm has not seen. A worker of such a call
	 * that settles is not free yet: the host is still cancelling and reaping what the worker left, inside that call.
	 */
	readonly #openCalls = new Set<string>();
	#serial = 0;
	#holdSerial = 0;
	#placementSerial = 0;
	#tokenSerial = 0;
	/** This run's place in the session-wide handle counter (R4); fixed for the run's life. */

	/**
	 * `hostJobs` is the one synchronous view of the director session's own async jobs. It is what makes a command the
	 * director sent to the background a holder in this table, and what tells that a worker's task job is over.
	 */
	constructor(readonly runId: string, private readonly hostJobs?: HostJobSource) {
		liveLanes.set(runId, new WeakRef(this));
	}

	/**
	 * Brings the table in line with the host's job rows, in the same synchronous step as the conflict check that follows:
	 * every running `bash` or `eval` job of the director is a holder (so a command started before this run, or sent to the
	 * background by omp on its own, is seen), and a holder whose job is no longer running is gone. A host that cannot show its
	 * jobs changes nothing.
	 */
	#syncHost(): void {
		const rows = this.hostJobs?.();
		if (rows === undefined) return;
		const running = new Set<string>();
		for (const row of rows) if (row.status === "running" && row.type !== "task") running.add(row.id);
		for (const [key, reservation] of this.#writes) {
			if (reservation.kind !== "director-bg" || reservation.jobId === undefined || running.has(reservation.jobId)) continue;
			this.#writes.delete(key);
			this.#writerFreed = true;
		}
		for (const id of running) {
			const key = `director-bg:${id}`;
			if (!this.#writes.has(key)) this.#writes.set(key, { scope: holderScope("director-bg"), kind: "director-bg", jobId: id, at: Date.now() });
		}
	}

	/** Whether the host has finished what it does for a worker after the worker's turn: its parent's call and its task job. */
	#reaped(reservation: WriteReservation): boolean {
		if (reservation.callId !== undefined && this.#openCalls.has(reservation.callId)) return false;
		// A host that has a job view but cannot show it now cannot show that the worker's task job is over: the place stays held
		// until the rows can be read (or the run ends), as a director command is refused for the same answer.
		const rows = this.hostJobs?.();
		if (this.hostJobs !== undefined && rows === undefined) return false;
		if (rows !== undefined && reservation.agentId !== undefined) {
			if (rows.some(row => row.type === "task" && row.status === "running" && row.agentId === reservation.agentId)) return false;
		}
		return true;
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
	 * Applies one plan's lane and isolation placement to a native task call before omp allocates spawn ids. Every item
	 * resolves either to a lane (R5) or to the unplanned record state, which gets a handle no other spawn can share (R4).
	 * A plan-less call is all unplanned. Nothing is reserved until the whole call, lane gate and host capability are
	 * accepted, so a rejection leaves no reservations.
	 */
	place(input: unknown, plan: RunPlan | undefined, config: StormConfig, options: TaskPlacementOptions = {}): TaskBinding {
		const described = describePlacement(input, plan, config, options);
		if (!described.ok) return described;
		const { batch, placed } = described;
		// `describePlacement` proved the call is a plain object; the batch rewrite below needs that narrowing here.
		const call = input as Record<string, unknown>;
		// A2-1: a shared writer is never reserved unless the caller's classification took the target's write claim. A
		// caller that proved "no writer" and then reaches one here is refused; nothing is placed or reserved.
		if (options.writeClaim === false && placed.some(entry => entry.scope.kind === "paths" || entry.scope.kind === "unknown")) {
			return { ok: false, code: "lane-write", reason: WRITE_CLAIM_REQUIRED };
		}
		// Dependencies and shared writes are decided for the whole call before any name or lane is reserved: a refused
		// batch leaves no partial spawn, reservation or assignment behind.
		const gate = this.#gate(placed, options);
		if (!gate.ok) return gate;
		// The caller's per-item text is asked for only now, for a call that is accepted, and before anything is reserved: a
		// hook that fails costs the item its note, never a half-placed call.
		const extras = placed.map(entry => {
			try {
				return options.decorate?.({ lane: entry.lane, isolated: entry.desired === true })?.trim();
			} catch {
				return undefined;
			}
		});
		// A worker of this call that settles is free only when the call itself has ended (see `callEnded`).
		if (options.callId !== undefined) this.#openCalls.add(options.callId);
		const notes = [...gate.notes, ...boundedPlacementNotes(placed.flatMap(entry => (entry.note === undefined ? [] : [entry.note])))];
		const now = options.now ?? Date.now();
		const pinned = new Set<string>();
		const mapped = placed.map((entry, index) => {
			// A caller's effort or model would outrank what the spawn hook answers with: the approved values stand.
			let next = withoutPinnedFields(withIsolation(entry.item, entry.desired), pinned);
			const placement = ++this.#placementSerial;
			const call = options.callId === undefined ? {} : { callId: options.callId };
			let handle: string;
			if (entry.lane === undefined) {
				// R4/D6: every unplanned item, auto or manual, gets a handle omp keeps as the spawn key. It carries the run
				// id: omp dedupes any name the native session has seen, including one an earlier process of the same
				// session used, so an in-memory counter alone would hand a resumed session a `-2` key R4 must refuse.
				handle = `${entry.agent}-${this.runId}-${++sessionHandleSerial}`;
				this.#assigned.set(handle, {
					agent: entry.agent,
					placement,
					scope: entry.scope,
					toolsCarried: entry.toolsCarried,
					...call,
				});
				next = { ...next, name: handle };
			} else {
				// A1-5/R4: every planned placement, manual or automatic, gives the host a handle it has never issued. The
				// run id makes it unique across processes; the lane's name stays the table, ledger and director's key.
				handle = `${this.runId}-lane-${++this.#serial}`;
				this.#assigned.set(handle, {
					key: key(entry.lane),
					lane: entry.lane.name,
					agent: entry.agent,
					placement,
					scope: entry.scope,
					toolsCarried: entry.toolsCarried,
					...call,
				});
				next = { ...next, name: handle };
			}
			// Only a consumer with declared prerequisites receives a reference: no extra text on a legacy plan.
			const refs = entry.lane === undefined ? undefined : dependencyRefs(entry.lane, options.readiness);
			if (refs !== undefined) next = appendedAssignment(next, refs);
			// The caller's own text for this item (the lane's result contract); it goes where the dependency note goes.
			const extra = extras[index];
			if (extra !== undefined && extra !== "") next = appendedAssignment(next, extra);
			this.#reserveWrite(entry, handle, now, placement, options.callId);
			if (entry.lane !== undefined) {
				this.#held.set(entry.lane.name, {
					id: ++this.#holdSerial,
					at: now,
					placement,
					name: handle,
					...(options.callId === undefined ? {} : { callId: options.callId }),
				});
			}
			return next;
		});
		if (!batch) {
			const all = pinned.size === 0 ? notes : [...notes, pinnedFieldsNote(TASK_PINNED_FIELDS.filter(field => pinned.has(field)))];
			return { ok: true, input: mapped[0]!, ...(all.length === 0 ? {} : { notes: all }) };
		}
		// omp falls back to a top-level `isolated` for every batch item that omitted its own flag. Placement is
		// per-item here, so the stale top-level shorthand must not isolate a shared item behind our back.
		const next = withoutPinnedFields({ ...call, tasks: mapped }, pinned);
		delete next.isolated;
		const all = pinned.size === 0 ? notes : [...notes, pinnedFieldsNote(TASK_PINNED_FIELDS.filter(field => pinned.has(field)))];
		return { ok: true, input: next, ...(all.length === 0 ? {} : { notes: all }) };
	}


	/** Consume an approved spawn's reservation; the lane comes back when the placement matched one (R4/R5). */
	admit(
		spawn: Pick<SpawnRecord, "spawnKey" | "agent" | "outcome">,
		manual?: { plan: RunPlan; config: StormConfig },
	): string | undefined {
		const admission = this.#admit(spawn, manual, false, undefined);
		return admission.ok ? admission.lane : undefined;
	}

	/**
	 * The same admission with the late-writer fence: after the host allocates the spawn key, a reservation whose pending
	 * window expired must not slip past a writer that now overlaps. Callers that can act on the refusal use this one.
	 * The main-session hook also passes `directorTask`, which makes correlation exact (R4), proves the frozen scope
	 * against the policy it will persist (R3), and returns the reservation key the worker's admission stores (R7).
	 */
	admitChecked(
		spawn: Pick<SpawnRecord, "spawnKey" | "agent" | "outcome">,
		manual?: { plan: RunPlan; config: StormConfig },
		options?: AdmitOptions,
	): LaneAdmission {
		return this.#admit(spawn, manual, true, options);
	}

	#admit(
		spawn: Pick<SpawnRecord, "spawnKey" | "agent" | "outcome">,
		manual: { plan: RunPlan; config: StormConfig } | undefined,
		recheck: boolean,
		options: AdmitOptions | undefined,
	): LaneAdmission {
		const directorTask = options?.directorTask !== undefined;
		if (!spawn.spawnKey) return { ok: true };
		let assignment = this.#assigned.get(spawn.spawnKey);
		if (assignment !== undefined && assignment.agent !== spawn.agent) assignment = undefined;
		// R4/A1-5: a planned or unplanned item is matched by the exact handle its placement gave the host. There is no
		// lane-name or suffix guess left: the lane's name is the table key, never the child's name.
		const matched = assignment !== undefined;
		if (spawn.outcome === "blocked") {
			// A blocked spawn never runs: the placement it would have used is consumed, and anything reserved for it ends.
			if (matched) this.#assigned.delete(spawn.spawnKey);
			this.#releaseSpawn(spawn.spawnKey, assignment?.lane, "cancelled");
			return directorTask ? { ok: true, placed: matched } : { ok: true };
		}
		if (directorTask && !matched) {
			return { ok: false, code: "internal", reason: spawnKeyMismatchReason(spawn.spawnKey) };
		}
		if (matched) this.#assigned.delete(spawn.spawnKey);
		// The spawn is correlated: from here the admitted agent's own state, not the placement hold, says the lane is busy.
		if (assignment?.lane !== undefined && this.#held.get(assignment.lane)?.agentId === undefined) this.#held.delete(assignment.lane);
		// Check, reserve and publish in this one synchronous step. No await may ever come between them: two hooks that
		// reach here one after the other each see the other's reservation, so overlapping writers cannot both pass.
		const reserved = this.#reserveAdmitted(spawn.spawnKey, spawn.agent, assignment, manual, recheck);
		if (!reserved.ok) return reserved;
		// R3: the policy the hook will persist may not be wider than the authority this placement reserved. A narrower
		// one is safe (the guard enforces it); a wider one has nothing behind it and the spawn is refused. The hook
		// derives the policy from the frozen authority, because the spawn event does not carry the item's isolation or
		// eval-defined tools; a hook that cannot do so refuses its own spawn before this point.
		let proven: LanePolicy | undefined;
		if (options?.directorTask !== undefined) {
			if (reserved.authority === undefined) {
				this.#releaseSpawn(spawn.spawnKey, assignment?.lane, "refused");
				return { ok: false, code: "internal", reason: PLACEMENT_CHANGED_REASON };
			}
			try {
				proven = options.directorTask.policy({
					authority: reserved.authority,
					...(assignment?.lane === undefined ? {} : { lane: assignment.lane }),
					toolsCarried: assignment?.toolsCarried === true,
				});
			} catch {
				this.#releaseSpawn(spawn.spawnKey, assignment?.lane, "refused");
				return { ok: false, code: "internal", reason: PLACEMENT_CHANGED_REASON };
			}
			if (!authorityCovers(reserved.authority, proven)) {
				this.#releaseSpawn(spawn.spawnKey, assignment?.lane, "refused");
				return { ok: false, code: "internal", reason: PLACEMENT_CHANGED_REASON };
			}
		}
		if (assignment === undefined) return { ok: true };
		this.#admitted.set(spawn.spawnKey, assignment);
		if (assignment.lane !== undefined) {
			this.#agents.set(assignment.lane, spawn.spawnKey);
			this.#agentAt.set(assignment.lane, Date.now());
		}
		if (!directorTask) return { ok: true, ...(assignment.lane === undefined ? {} : { lane: assignment.lane }) };
		return {
			ok: true,
			placed: true,
			...(assignment.lane === undefined ? {} : { lane: assignment.lane }),
			...(reserved.hold === undefined ? {} : { hold: reserved.hold }),
			...(reserved.authority === undefined ? {} : { authority: reserved.authority }),
			...(proven === undefined ? {} : { policy: proven }),
		};
	}

	/**
	 * What makes an admitted worker a covered writer. The placement's reservation is bound to the worker; one that lapsed
	 * while the host waited to start the worker (a permit, a slow hook) is found again, its scope is checked against
	 * every live reservation, and it is reserved again for the worker. A conflict refuses the admission and leaves nothing
	 * behind. Without a placement or a scope Storm knows of nothing to reserve and nothing is made up. Returns the key of
	 * the reservation now bound to the child (the worker's `hold`, R7) and the frozen authority (R3).
	 */
	#reserveAdmitted(
		spawnKey: string,
		agent: string,
		assignment: Assignment | undefined,
		manual: { plan: RunPlan; config: StormConfig } | undefined,
		recheck: boolean,
	): { ok: true; hold?: string; authority?: WriteAuthority } | { ok: false; code: LaneBlockCode; reason: string } {
		this.#syncHost();
		const laneName = assignment?.lane;
		const lane = laneName === undefined ? undefined : manual?.plan.lanes.find(candidate => candidate.name === laneName);
		const bound = this.#bindWrite(spawnKey, laneName, assignment?.placement);
		const ownKey = laneName === undefined ? undefined : `lane:${laneName}`;
		if (bound === undefined && ownKey !== undefined && this.#writes.has(ownKey)) {
			// The lane's reservation belongs to another live worker: a second attempt of one lane is not admitted beside it.
			this.#releaseSpawn(spawnKey, laneName, "refused");
			return {
				ok: false,
				code: "lane-busy",
				reason: `레인 '${laneName}'에 이미 다른 워커의 쓰기 예약이 있어 같은 레인의 두 번째 작업을 시작하지 않았습니다. 그 작업이 끝난 뒤 다시 보내거나, 이어 가려면 그 워커에게 후속 지시를 보내세요.`,
			};
		}
		const lapsedKey = bound !== undefined ? undefined : this.#lapsedKeyFor(spawnKey, laneName);
		const lapsed = lapsedKey === undefined ? undefined : this.#lapsed.get(lapsedKey);
		const scope: WriteScope | undefined = bound?.reservation.scope ?? lapsed?.scope ?? assignment?.scope ??
			(laneName === undefined
				? undefined
				: this.#laneScopes.get(laneName) ??
					(manual !== undefined && lane !== undefined ? writeScope(lane, workerRole(manual.config, agent), false) : { kind: "unknown", why: WHY_UNDECLARED_WRITER }));
		if (lapsedKey !== undefined) this.#lapsed.delete(lapsedKey);
		if (scope === undefined) return { ok: true };
		const authority = publicAuthority(scope);
		if (scope.kind === "read") return { ok: true, authority };
		if (scope.kind === "private") {
			// D10: an unplanned isolated worker writes inside its own checkout, beside shared writers. It holds no
			// shared reservation, but the worker admission needs a live mark to allow more than reads (R7); the mark
			// is the placement's handle and ends with the admission's revoke. A planned private lane is bounded by its
			// lane, so it needs none.
			return laneName === undefined ? { ok: true, hold: `private:${spawnKey}`, authority } : { ok: true, authority };
		}
		// A1-2: at admission every shared writer is checked again against everything that holds the tree now, its own
		// reservation excepted. A host job or another call's writer can become visible between placement and this hook,
		// and a timer lapse is never the only way into the check.
		if (recheck) {
			for (const [key, reservation] of this.#writes) {
				if (key === bound?.key || key === ownKey || reservation.agentId === spawnKey) continue;
				if (!scopesConflict(scope, reservation.scope)) continue;
				const other = heldBy(reservation);
				const reason = conflictText(lane, agent, scope, other, reservation.scope, false, reservation.kind === "director-path");
				this.#releaseSpawn(spawnKey, laneName, "refused");
				return { ok: false, code: "lane-write", reason };
			}
		}
		if (bound !== undefined) return { ok: true, hold: bound.key, authority };
		const placement = assignment?.placement ?? lapsed?.placement;
		const name = lapsed?.name ?? spawnKey;
		const hold = ownKey ?? lapsedKey ?? `spawn:${spawnKey}`;
		this.#writes.set(hold, {
			scope,
			...(laneName === undefined ? {} : { lane: laneName }),
			agentId: spawnKey,
			name,
			...(placement === undefined ? {} : { placement }),
			...(lapsed?.callId === undefined ? {} : { callId: lapsed.callId }),
			at: Date.now(),
		});
		return { ok: true, hold, authority };
	}

	/** The lapsed reservation of exactly this key: the lane's own for a planned lane, the handle's for an unplanned one. */
	#lapsedKeyFor(spawnKey: string, lane: string | undefined): string | undefined {
		const candidate = lane !== undefined ? `lane:${lane}` : `spawn:${spawnKey}`;
		return this.#lapsed.has(candidate) ? candidate : undefined;
	}

	/** A placement whose pending window ran out is remembered, so the late start of its worker is checked again. */
	#lapse(key: string, reservation: WriteReservation): void {
		this.#lapsed.delete(key);
		this.#lapsed.set(key, reservation);
		if (this.#lapsed.size > LAPSED_MAX) {
			const oldest = this.#lapsed.keys().next().value;
			if (oldest !== undefined) this.#lapsed.delete(oldest);
		}
	}

	/** Tells the subscribers that a bound reservation ended: the worker it covered has no order to write behind it any more. */
	#ended(agentId: string | undefined, lane: string | undefined, reason: ReservationEndReason): void {
		if (agentId === undefined) return;
		const end: ReservationEnd = { runId: this.runId, agentId, ...(lane === undefined ? {} : { lane }), reason, at: Date.now() };
		for (const listener of [...endListeners]) {
			try {
				listener(end);
			} catch {
				// A subscriber's failure never changes what the book holds.
			}
		}
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
	): { ok: true; notes: string[] } | { ok: false; reason: string; code: LaneBlockCode; retry: boolean } {
		const now = options.now ?? Date.now();
		this.#pruneWrites(options.agents, now);
		const scopes = placed;
		const notes: string[] = [];
		for (const entry of scopes) {
			if (entry.lane === undefined) continue;
			const start = dependencyStart(entry.lane, options.readiness);
			if (!start.ok) return { ok: false, reason: start.reason, code: "lane-dependency", retry: false };
			notes.push(...start.notes);
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
		// D11: only shared writers are paired. A batch of readers or isolated workers costs no pair work, whatever the
		// number of workers.
		const shared = scopes.filter(entry => entry.scope.kind === "paths" || entry.scope.kind === "unknown");
		for (let i = 0; i < shared.length; i++) {
			const a = shared[i]!;
			for (let j = i + 1; j < shared.length; j++) {
				const b = shared[j]!;
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
				const other = heldBy(reservation);
				return { ok: false, code: "lane-write", retry: true, reason: conflictText(entry.lane, entry.agent, scope, other, reservation.scope, false, reservation.kind === "director-path") };
			}
		}
		return { ok: true, notes };
	}

	/**
	 * Hold one placed item's shared write scope until its worker settles, fails, or the pending window expires. The key
	 * is the exact one an admission matches (R4): the lane's own key for a planned lane, the item's handle otherwise.
	 */
	#reserveWrite(entry: PlacedEntry, handle: string, now: number, placement: number, callId?: string): void {
		const scope = entry.scope;
		if (entry.lane !== undefined) this.#laneScopes.set(entry.lane.name, scope);
		if (scope.kind === "read" || scope.kind === "private") return;
		const key = entry.lane !== undefined ? `lane:${entry.lane.name}` : `spawn:${handle}`;
		// A newer placement of this key replaces a lapsed one: the older attempt is not revived beside it.
		this.#lapsed.delete(key);
		this.#writes.set(key, {
			scope,
			...(entry.lane === undefined ? {} : { lane: entry.lane.name }),
			name: handle,
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
		this.#syncHost();
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
			// A holder that is not a worker has its own end (the call's end, the host job's end, the process group's end).
			if (reservation.kind !== undefined) continue;
			if (reservation.agentId === undefined) {
				// Placed and never admitted: nobody is writing behind it, so it may lapse. A late start of its worker finds it
				// again in `#lapsed` and must pass the conflict check and reserve anew.
				if (now - reservation.at >= PENDING_WRITE_MS) {
					this.#writes.delete(key);
					this.#lapse(key, reservation);
				}
				continue;
			}
			// A bound reservation is an admitted worker's, or a follow-up's awaiting its woken turn. No age ends it: the
			// host may take longer than any window to start the worker (a permit, a slow hook, session creation, an
			// isolation checkout), and the worker's persisted authority stays open meanwhile. A worker the list does not
			// show yet therefore keeps its place, and only an event ends it.
			const agent = byId.get(reservation.agentId);
			if (agent === undefined) continue;
			if (reservation.note !== undefined) {
				// A note whose receipt is not in yet, or that woke a turn: a running row is the turn that was open when it went out
				// until a row showed the worker not running; only a start seen after that is the woken turn.
				if (agent.state !== "running") reservation.note.idle = true;
				else if (reservation.note.idle) {
					delete reservation.note;
					delete reservation.awaiting;
					reservation.seen = true;
				}
				continue;
			}
			if (agent.state === "running") {
				reservation.seen = true;
				delete reservation.awaiting;
				continue;
			}
			// A woken turn that has not started still looks settled: only its start, or the failure of its call, decides.
			if (reservation.awaiting === true) continue;
			// A row that is idle with no request and was never seen running is a fresh start, not a finished turn.
			if (reservation.seen !== true && agent.state !== "parked" && agent.requests === 0 && agent.lastWorkFailed !== true) continue;
			// The turn is over, but omp may still be cancelling and reaping what the worker left, inside its parent's call.
			if (!this.#reaped(reservation)) {
				reservation.settled = true;
				continue;
			}
			this.#writes.delete(key);
			// The host list says the worker that held this order is no longer running: its place is free.
			this.#writerFreed = true;
			this.#ended(reservation.agentId, reservation.lane, "settled");
		}
	}

	/** The reactivated turn of a follow-up began: the agent's own running state is now the lane's reservation. */
	agentStarted(agentId: string): void {
		for (const hold of this.#held.values()) if (hold.agentId === agentId) hold.started = true;
		for (const reservation of this.#writes.values()) {
			if (reservation.agentId !== agentId) continue;
			delete reservation.awaiting;
			delete reservation.settled;
			reservation.seen = true;
		}
	}

	/**
	 * A director tool call ended (any tool, any result). It is the receipt for a worker that settled inside that call, and the
	 * end of a command the director ran in it. A command omp moved to the background is in the host's job rows by now, so it
	 * stays a holder through `director-bg`; a host that cannot show its jobs keeps the command's hold.
	 */
	callEnded(callId: string): void {
		this.#openCalls.delete(callId);
		const rows = this.hostJobs?.();
		this.#syncHost();
		for (const [key, reservation] of this.#writes) {
			if (reservation.callId !== callId && !(reservation.settled === true && reservation.kind === undefined)) continue;
			if (reservation.kind === "director-exec") {
				if (rows !== undefined) this.#writes.delete(key);
				continue;
			}
			if (reservation.kind !== undefined || reservation.settled !== true || reservation.agentId === undefined || !this.#reaped(reservation)) continue;
			this.#writes.delete(key);
			this.#writerFreed = true;
			this.#ended(reservation.agentId, reservation.lane, "settled");
		}
	}

	/**
	 * A host tool call failed or was cancelled: release exactly what that call placed and nothing a newer call owns.
	 * Placements already admitted to a worker are the worker's, and a follow-up whose turn started is running work.
	 * Returns the spawn handles it released, so the caller can free any slot those handles took.
	 */
	releaseCall(callId: string, running?: ReadonlySet<string>): string[] {
		const names: string[] = [];
		for (const [lane, hold] of this.#held) {
			if (hold.callId !== callId || hold.started === true) continue;
			this.#held.delete(lane);
			if (hold.name !== undefined) names.push(hold.name);
		}
		// The call failed or was cancelled: its failure is no receipt for a worker that settled inside it, and a command of the
		// director keeps its hold (a timeout or an abort is a teardown asked for, not an empty tree); `callEnded` decides those.
		// A note that failed was not delivered: the worker's reservation is what it was before.
		for (const reservation of this.#writes.values()) if (reservation.note?.callId === callId) this.#takeBackNote(reservation);
		for (const [key, reservation] of this.#writes) {
			if (reservation.kind !== undefined) continue;
			if (reservation.callId !== callId || (reservation.agentId !== undefined && reservation.awaiting !== true)) continue;
			// A follow-up whose call ended in an error after omp had delivered it: if the woken turn is already running (the
			// agent list says so before this table heard of its start) it is a live writer and keeps its place (R-G1 question 5).
			if (reservation.agentId !== undefined && running?.has(reservation.agentId) === true) {
				delete reservation.awaiting;
				reservation.seen = true;
				continue;
			}
			this.#writes.delete(key);
			if (reservation.name !== undefined) names.push(reservation.name);
			// An awaiting follow-up reopened the worker's authority; its call failed, so that authority ends with it.
			this.#ended(reservation.agentId, reservation.lane, "call-failed");
		}
		// A placement of this call that had lapsed must not come back when its worker starts late: the call failed.
		for (const [key, reservation] of this.#lapsed) {
			if (reservation.callId !== callId) continue;
			this.#lapsed.delete(key);
			if (reservation.name !== undefined) names.push(reservation.name);
		}
		for (const [name, assignment] of this.#assigned) {
			if (assignment.callId !== callId) continue;
			this.#assigned.delete(name);
			names.push(name);
		}
		return [...new Set(names)];
	}

	/**
	 * Bind the reservation placed under this child's exact key (R4): the lane's own key for a planned lane, the item's
	 * handle for an unplanned one. Nothing is adopted, matched by suffix or guessed. Returns the reservation now bound
	 * to the child, or nothing when there is none live or the one found belongs to another worker.
	 */
	#bindWrite(agentId: string, lane: string | undefined, placement?: number): { key: string; reservation: WriteReservation } | undefined {
		const key = lane !== undefined ? `lane:${lane}` : `spawn:${agentId}`;
		const reservation = this.#writes.get(key);
		if (reservation === undefined || reservation.kind !== undefined) return undefined;
		if (reservation.agentId !== undefined && reservation.agentId !== agentId) return undefined;
		// A newer placement of the same lane is not this older spawn's reservation.
		if (placement !== undefined && reservation.placement !== undefined && reservation.placement !== placement) return undefined;
		reservation.agentId = agentId;
		return { key, reservation };
	}

	/** Drop every reservation a refused or finished spawn still holds; the lane assignment is not evidence. */
	#releaseSpawn(spawnKey: string, lane: string | undefined, reason: ReservationEndReason, settledTurn = false): void {
		if (lane !== undefined) {
			const own = this.#writes.get(`lane:${lane}`);
			// A lane's reservation that another live worker is bound to is that worker's, not this spawn's.
			if (own !== undefined && own.awaiting !== true && (own.agentId === undefined || own.agentId === spawnKey)) {
				this.#writes.delete(`lane:${lane}`);
				this.#ended(own.agentId, own.lane, reason);
			}
			this.#lapsed.delete(`lane:${lane}`);
			// A follow-up's hold belongs to its agent and ends with that agent's started turn, not with a spawn's cleanup.
			if (this.#held.get(lane)?.agentId === undefined) this.#held.delete(lane);
		}
		for (const [name, hold] of this.#held) if (hold.agentId === undefined && hold.name === spawnKey) this.#held.delete(name);
		for (const [key, reservation] of this.#lapsed) {
			if (reservation.name === spawnKey || key === `spawn:${spawnKey}`) this.#lapsed.delete(key);
		}
		for (const [key, reservation] of this.#writes) {
			// A settled-turn event is the previous turn's: it never ends a follow-up admitted after it and not yet started.
			if (settledTurn && reservation.awaiting === true) continue;
			if (reservation.agentId === spawnKey || reservation.name === spawnKey || key === `spawn:${spawnKey}`) {
				// A settled turn does not free the place while omp still reaps for the worker inside its parent's call.
				if (settledTurn && reservation.kind === undefined && reservation.agentId === spawnKey && !this.#reaped(reservation)) {
					reservation.settled = true;
					continue;
				}
				this.#writes.delete(key);
				// A settled turn is a worker that held a write order ending; a refused or cancelled spawn is not.
				if (settledTurn) this.#writerFreed = true;
				this.#ended(reservation.agentId, reservation.lane, reason);
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
	 * The agent an unplanned placement's handle was placed for, or undefined when the key is no placement of this run.
	 * The spawn hook uses it before reserving anything: a spawn of another agent under this key is refused without
	 * disturbing the placement it names (R4), so a reader cannot consume a writer's pending place.
	 */
	placementAgent(spawnKey: string): string | undefined {
		return this.#assigned.get(spawnKey)?.agent;
	}

	/**
	 * Whether this run already admitted a worker under this exact key (A1-6). A second hook for the same key is refused
	 * before anything else is decided and cleans up nothing: the key's admitted identity is the first hook's, not a time
	 * stamp or a string guess.
	 */
	isAdmitted(spawnKey: string): boolean {
		return this.#admitted.has(spawnKey);
	}

	/**
	 * The host handle of this lane's pending placement, or of its lapsed one. The lane's name stays the table key; this
	 * is the only name the host was given, so a caller that knows the lane can still name the placement it made.
	 */
	pendingHandle(laneName: string): string | undefined {
		const hold = this.#held.get(laneName);
		if (hold !== undefined && hold.agentId === undefined && hold.name !== undefined) return hold.name;
		return this.#lapsed.get(`lane:${laneName}`)?.name;
	}

	/**
	 * The identity of the placement a spawn key correlates to right now, read before the decision awaits anything.
	 * A later cancel passes it back, so a refusal that lands after a newer call placed the same name removes nothing
	 * of that newer call.
	 */
	placementOf(spawnKey: string): number | undefined {
		const assigned = this.#assigned.get(spawnKey)?.placement;
		if (assigned !== undefined) return assigned;
		// A planned lane's placement can also be named by the lane's own name: the table key, never the host's handle.
		const lanePending = this.#held.get(spawnKey)?.placement;
		if (lanePending !== undefined) return lanePending;
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
		let reported = false;
		// The placement identity is what the caller holds: a cancelled placement is removed whichever handle named it.
		if (placement !== undefined) {
			for (const [key, entry] of this.#assigned) {
				if (entry.placement === placement) {
					this.#assigned.delete(key);
					break;
				}
			}
		}
		if (placement !== undefined) {
			for (const [lane, hold] of this.#held) if (hold.agentId === undefined && hold.placement === placement) this.#held.delete(lane);
		}
		for (const [key, reservation] of this.#writes) {
			// A follow-up's reservation belongs to its agent and ends with that agent's started turn.
			if (reservation.awaiting === true) continue;
			// With a stamp the placement identity decides, even after admission bound this spawn's id to it; without one
			// only a reservation bound to this very spawn is its own.
			const own = placement === undefined ? reservation.agentId === spawnKey : reservation.placement === placement;
			if (own) {
				this.#writes.delete(key);
				if (reservation.agentId === spawnKey) reported = true;
				this.#ended(reservation.agentId, reservation.lane, "cancelled");
			}
		}
		for (const [key, reservation] of this.#lapsed) {
			const own = placement === undefined ? reservation.name === spawnKey : reservation.placement === placement;
			if (own) this.#lapsed.delete(key);
		}
		// The spawn was refused after its authority may already have been written (the hook persists it before its last
		// guards): that authority ends with the refusal, whether or not a reservation stood behind it.
		if (!reported) this.#ended(spawnKey, assignment?.lane, "cancelled");
	}

	/** The worker's turn settled: its lane is free for the next planned writer. */
	releaseAgent(agentId: string): void {
		this.#releaseSpawn(agentId, undefined, "settled", true);
	}

	/**
	 * Whether a worker that held a shared write order settled since the last call. The host's agent list is applied first,
	 * so a worker whose settling this run has not been told of yet still counts. Reading clears it: one freed place is
	 * announced once.
	 */
	takeWriterFreed(agents: readonly AgentEntry[], now: number): boolean {
		this.#pruneWrites(agents, now);
		const freed = this.#writerFreed;
		this.#writerFreed = false;
		return freed;
	}

	/**
	 * The director's own call that can write without naming a path (a shell command, an `lsp` action that edits, omp's
	 * checkpoint or rewind tool, an MCP or unknown tool) asks for the shared tree. It is admitted only when nothing else
	 * holds the tree: no worker reservation, no job, no required check, no fence. Admission and the entry are one synchronous
	 * step, so a worker placed in the same message sees the command and the command sees the worker, in either order. The
	 * entry stays until the call ends (`callEnded`); a command omp moved to the background is then a `director-bg` holder for
	 * as long as the host's job rows show it running. A host that cannot show those rows cannot show that the command ended:
	 * the call is not admitted.
	 */
	commitDirectorExec(input: { callId: string; agents?: readonly AgentEntry[]; now: number }): { ok: true } | { ok: false; reason: string } {
		if (this.hostJobs?.() === undefined) return { ok: false, reason: DIRECTOR_BLIND_REASON };
		this.#pruneWrites(input.agents, input.now);
		for (const reservation of this.#writes.values()) {
			if (reservation.kind === "director-exec" || reservation.kind === "director-bg") continue;
			// The director's own path edit holds until its message's calls are over; say so rather than "wait for it".
			if (reservation.kind === "director-path") return { ok: false, reason: directorEditWait("감독의 명령") };
			const other = heldBy(reservation);
			return {
				ok: false,
				reason: `감독의 이 호출은 어디를 바꿀지 알 수 없어(셸 명령·lsp 수정·MCP 같은 도구) ${withJosa(other, "과/와")} 같은 작업 트리에서 함께 돌릴 수 없어 막았습니다. ${withJosa(other, "이/가")} 끝난 뒤 다시 호출하세요. ${WRITE_ORDER_CHECK}`,
			};
		}
		this.#writes.set(`director-exec:${input.callId}`, { scope: holderScope("director-exec"), kind: "director-exec", callId: input.callId, at: input.now });
		return { ok: true };
	}

	/**
	 * A job batch or a required check asks for the shared tree. It is admitted only when nothing else holds it: no command of
	 * the director, no other job, check or fence, and no worker whose place the table still keeps (a worker that settled
	 * inside its parent's call, or whose task job runs, is held until the host reaped it, and a job's child could write beside
	 * it). The table is brought in line with the agent list and the host's job rows first, in the same synchronous step as
	 * the check, and the entry is made in that step. `key` names the entry; release it with the proven end of its process
	 * group, or turn it into a fence when that end is not proven.
	 */
	commitHolder(input: { kind: "job" | "check"; key: string; now: number; agents?: readonly AgentEntry[] | undefined }): { ok: true } | { ok: false; reason: string } {
		this.#pruneWrites(input.agents, input.now);
		for (const [key, reservation] of this.#writes) {
			if (key === `${input.kind}:${input.key}`) continue;
			if (reservation.kind === "director-path") return { ok: false, reason: directorEditWait(input.kind === "job" ? "정형 작업" : "필수 검사") };
			const other = heldBy(reservation);
			return {
				ok: false,
				reason: `${withJosa(other, "이/가")} 같은 작업 트리에서 돌고 있어 ${withJosa(input.kind === "job" ? "정형 작업" : "필수 검사", "을/를")} 시작하지 않았습니다. 끝난 뒤 다시 시도하세요.`,
			};
		}
		this.#writes.set(`${input.kind}:${input.key}`, { scope: holderScope(input.kind), kind: input.kind, at: input.now });
		return { ok: true };
	}

	/** The end of a job or check holder whose process group is proven empty. */
	releaseHolder(kind: "job" | "check" | "fence", key: string): void {
		if (this.#writes.delete(`${kind}:${key}`)) this.#writerFreed = true;
	}

	/** A job or check whose process end is not proven keeps the tree: its entry becomes a fence, which only `releaseHolder` ends. */
	fenceHolder(kind: "job" | "check", key: string): void {
		this.#writes.delete(`${kind}:${key}`);
		this.#writes.set(`fence:${key}`, { scope: holderScope("fence"), kind: "fence", at: Date.now() });
	}

	/** What a refusal reads of one entry: its kind and, for a worker, its lane and how far it got. */
	#view(reservation: WriteReservation): HolderView {
		return {
			...(reservation.kind === undefined ? {} : { kind: reservation.kind }),
			...(reservation.lane === undefined ? {} : { lane: reservation.lane }),
			...(reservation.agentId === undefined ? {} : { agentId: reservation.agentId }),
			...(reservation.awaiting === true ? { awaiting: true } : {}),
		};
	}

	/**
	 * The one commit step of a director path edit, to be called after the caller's last `await` and with nothing that yields
	 * between this call and the tool running. In this order, in one synchronous run: the caller's own proof that the run is still
	 * the live one (`live`: the run object it captured is still the controller's, nothing is ending, the signal is not aborted, the
	 * session and generation are unchanged); the hook's deadline, if it gave one; the table brought in line with the agent list and
	 * the host's job rows; every live entry against the call's exact paths; and then the entry.
	 *
	 * An entry conflicts when it cannot be bounded (a worker with a shell or an unknown scope in any of its states, a placement or
	 * a follow-up not yet started, a job, a check, a fence, the director's own command or its background command) or when it is a
	 * worker whose files overlap these paths. A worker on other files does not, and neither does another path edit of the
	 * director: it is the same actor, and omp runs its path tools one at a time.
	 *
	 * The entry is keyed by the tool call id and ends only with `releaseDirectorCalls`: never by a timer, a prune, the end of the
	 * run or a switch of session. A refusal creates nothing; its `reason` is the sentence the director reads (the block code is
	 * `director-write`, see `directorWriteBlock`). A caller that commits the same call twice keeps one entry holding both path lists.
	 */
	commitWriter(input: CommitWriterRequest): CommitWriterResult {
		let proof: LiveCheck;
		try {
			proof = input.live();
		} catch {
			proof = { ok: false, reason: DIRECTOR_WRITE_ENDING };
		}
		if (!proof.ok) return { ok: false, code: "run-ending", reason: proof.reason };
		if (input.deadline !== undefined && !(input.now < input.deadline)) return { ok: false, code: "deadline", reason: DIRECTOR_WRITE_LATE };
		const paths = [...new Set(input.paths.filter(path => path !== ""))].sort();
		if (paths.length === 0) return { ok: false, code: "no-target", reason: DIRECTOR_WRITE_NO_TARGET };
		this.#pruneWrites(input.agents, input.now);
		const scope: WriteScope = { kind: "paths", paths };
		const own = directorKey(input.callId);
		for (const [key, reservation] of this.#writes) {
			if (key === own || reservation.kind === "director-path") continue;
			if (!scopesConflict(scope, reservation.scope)) continue;
			const holder = this.#view(reservation);
			return { ok: false, code: "lane-write", reason: directorWriteConflict(holder), holder };
		}
		const existing = this.#writes.get(own);
		const merged = existing?.scope.kind === "paths" ? [...new Set([...existing.scope.paths, ...paths])].sort() : paths;
		this.#writes.set(own, { scope: { kind: "paths", paths: merged }, kind: "director-path", callId: input.callId, at: input.now });
		return { ok: true };
	}

	/**
	 * A director call that is already running turned out to write more than Storm was shown when it entered the table (an extension
	 * loaded after Storm rewrote its arguments). It cannot be refused any more, so the files it really writes are held with it from now
	 * on, whatever else holds them: a hold without the conflict loop, for a call that has started. `["."]` holds the whole tree.
	 * Nothing happens for a call the table does not hold. Returns whether the entry was widened.
	 */
	widenDirectorCall(callId: string, paths: readonly string[]): boolean {
		const key = directorKey(callId);
		const existing = this.#writes.get(key);
		if (existing === undefined || existing.kind !== "director-path" || existing.scope.kind !== "paths") return false;
		existing.scope = { kind: "paths", paths: [...new Set([...existing.scope.paths, ...paths.filter(path => path !== "")])].sort() };
		return true;
	}

	/**
	 * Holds the files a director call really writes when Storm first saw it as no file change at all and another extension rewrote
	 * its arguments before it started: the call already runs, so no refusal is possible and the entry is made without the conflict
	 * loop (a writer that already held one of those files is not stopped). An entry this call already has is widened instead.
	 * Nothing happens for an empty path list. Returns whether an entry now holds the call.
	 */
	holdDirectorCall(callId: string, paths: readonly string[]): boolean {
		const clean = [...new Set(paths.filter(path => path !== ""))].sort();
		if (clean.length === 0) return false;
		const key = directorKey(callId);
		const existing = this.#writes.get(key);
		if (existing !== undefined) {
			if (existing.kind !== "director-path" || existing.scope.kind !== "paths") return false;
			existing.scope = { kind: "paths", paths: [...new Set([...existing.scope.paths, ...clean])].sort() };
			return true;
		}
		this.#writes.set(key, { scope: { kind: "paths", paths: clean }, kind: "director-path", callId, at: Date.now() });
		return true;
	}

	/** The paths an entry of the director's call holds now, or undefined when the table does not hold that call. */
	directorCallPaths(callId: string): readonly string[] | undefined {
		const held = this.#writes.get(directorKey(callId));
		return held?.kind === "director-path" && held.scope.kind === "paths" ? held.scope.paths : undefined;
	}

	/**
	 * The end of the assistant turn (or of the agent's run) that made these director tool calls: the one event that releases a
	 * director path edit. The caller passes the ids contained in the payload of that very event (`directorCallIds`), so an old
	 * loop's late end cannot release the hold of a newer turn; an id nobody holds changes nothing. Returns how many entries ended.
	 */
	releaseDirectorCalls(callIds: Iterable<string>): number {
		let released = 0;
		for (const callId of callIds) {
			const key = directorKey(callId);
			if (this.#writes.get(key)?.kind !== "director-path") continue;
			this.#writes.delete(key);
			released++;
		}
		return released;
	}

	/** The tool call ids of every director path edit the table holds now. */
	directorCalls(): string[] {
		const ids: string[] = [];
		for (const reservation of this.#writes.values()) {
			if (reservation.kind === "director-path" && reservation.callId !== undefined) ids.push(reservation.callId);
		}
		return ids;
	}

	/** Entries of the given kinds that are live now (after the host's job rows were applied). */
	liveHolders(kinds: readonly HolderKind[]): number {
		this.#syncHost();
		let count = 0;
		for (const reservation of this.#writes.values()) if (reservation.kind !== undefined && kinds.includes(reservation.kind)) count++;
		return count;
	}

	/**
	 * Which of the unstarted lanes that would write the shared tree could start now: the same placement gate a `task`
	 * call meets (prerequisites, one live attempt per lane, write order), asked for each lane alone and then against the
	 * lanes already named, so the names can be sent one call each or together without a write-order refusal. Lanes that
	 * do not write the shared tree (read-only, isolated) never wait on the write order and are not named; a lane whose
	 * capability is unknown is not named. Reserves and starts nothing. What this does not decide: the spawn guard's
	 * budget, parallelism and capacity, which still apply at the spawn.
	 */
	startableWriters(candidates: readonly PlanLane[], config: StormConfig, options: TaskPlacementOptions): string[] {
		const named: { lane: PlanLane; scope: WriteScope }[] = [];
		for (const lane of candidates) {
			const policy = options.policies?.get(lane.name);
			if (policy === undefined || policy.kind === "blocked") continue;
			const isolated = config.isolation === "isolated" || lane.isolationReason !== undefined;
			const scope = writeScope(lane, lane.role, isolated, policy, options.canonicalFiles?.get(lane.name));
			if (scope.kind !== "paths" && scope.kind !== "unknown") continue;
			// A lane that would start ahead of a prerequisite is allowed to, but it is not what "can start now" offers.
			if (dependencyBlock(lane, options.readiness) !== undefined) continue;
			const entry: PlacedEntry = {
				item: {},
				lane,
				agent: lane.role,
				desired: undefined,
				requiresIsolation: isolated,
				selective: false,
				scope,
				toolsCarried: false,
			};
			if (!this.#gate([entry], options).ok) continue;
			if (named.some(earlier => scopesConflict(scope, earlier.scope))) continue;
			named.push({ lane, scope });
		}
		return named.map(entry => entry.lane.name);
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
	 * A message that starts work passes the admission rules: a prerequisite that does not hold yet does not refuse it
	 * (the result says what state it is in, `dependencyStart`), omp's ceiling counts the reactivated worker, and a shared
	 * write reserves its scope before omp delivers the turn. Its own in-flight reservation never blocks the continuation.
	 * A progress-only note whose wake is proven read-only (`wakeReadOnly`) starts no work, so it meets none of this.
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
		// A quiet `?progress` note starts no work when the turn it wakes can only read and report: a worker's authority
		// ends with its last turn, so such a wake is neither a writer nor a worker that needs a slot. The call site proves
		// that with `wakeReadOnly` (it must not re-open the worker's admission for the note). Then the note meets none of
		// the gates that order or count work: no prerequisite, capacity or write-order check, and it takes no lane hold,
		// reservation or slot. Without that proof the wake may write, so the note keeps today's gates (below).
		if (input.progress === true && input.wakeReadOnly === true) return { ok: true, token: `follow:${++this.#tokenSerial}` };
		const notes: string[] = [];
		if (lane !== undefined) {
			const start = dependencyStart(lane, input.readiness);
			if (!start.ok) return { ok: false, reason: start.reason, code: "lane-dependency" };
			notes.push(...start.notes);
		}
		const now = input.now ?? Date.now();
		const role = input.role ?? lane?.role;
		const target = input.agents?.find(agent => agent.id === input.agentId);
		const running = target?.state === "running";
		const reserved = input.runId === undefined ? [] : reservedWorkers(input.runId);
		const hasSlot = reserved.some(slot => slot.key === input.agentId);
		// A worker already running, or one that already holds a slot, is not a second worker: a follow-up to it charges no
		// new slot. A genuine reactivation checks omp's own ceiling (`task.maxConcurrency`), the one limit on workers; the
		// plan's worker count per role is a planning figure and never refuses a follow-up.
		const needsCapacity = input.runId !== undefined && !running && !hasSlot;
		if (needsCapacity) {
			const active = activeAgents([], input.agents ?? [], now, reserved);
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
		);
		if (lane !== undefined) this.#laneScopes.set(lane.name, scope);
		// A progress note whose wake is not proven read-only (`wakeReadOnly`) is a message that may start a writer, and meets exactly
		// what a work message meets below (a reservation, a lane hold, a slot): without that a second writer could be placed
		// beside the turn it wakes (R-G1 finding 1). Two cases start no new writing turn and need none of it: a recipient that
		// is running (the note joins the open turn, which already owns its reservation) and a recipient whose authority cannot
		// write the shared tree at all (a read or private scope). The note keeps only the sentence that says what it was.
		if (input.progress === true && (running || scope.kind === "read" || scope.kind === "private")) {
			const quietToken = `follow:${++this.#tokenSerial}`;
			// "Running" is what the agent list says, and it can lag: the turn may have just ended and the note then wakes a new one
			// that no row shows yet. So the worker's own reservation stays until the write's receipt says the note joined an open
			// turn (`noteDelivered`); a recipient with no reservation, or one that cannot write, has nothing to keep.
			if (running && scope.kind !== "read" && scope.kind !== "private") {
				const own = [...this.#writes.values()].find(candidate => candidate.kind === undefined && candidate.agentId === input.agentId);
				if (own !== undefined && own.note === undefined) {
					own.note = { idle: false, ...(input.callId === undefined ? {} : { callId: input.callId }) };
					own.noteAwaitedBefore = own.awaiting === true;
					own.awaiting = true;
					this.#followTokens.set(quietToken, { created: false, reservation: own, noted: true });
				}
			}
			return { ok: true, token: quietToken };
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
		if (input.callId !== undefined) this.#openCalls.add(input.callId);
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
			// An unplanned private worker holds no shared reservation; the `private:` mark lets its new turn write
			// inside its checkout, as the fresh spawn's does (D10/R7).
			const hold = scope.kind === "private" && lane === undefined ? `private:${input.agentId}` : undefined;
			return { ok: true, token, ...(hold === undefined ? {} : { hold }), ...(capacityKey === undefined ? {} : { reserved: true }), ...(notes.length === 0 ? {} : { notes }) };
		}
		for (const reservation of this.#writes.values()) {
			if (reservation.agentId === input.agentId) continue;
			if (!scopesConflict(scope, reservation.scope)) continue;
			const other = heldBy(reservation);
			const wake = input.progress === true ? " 이 진행 메모는 대기 중인 워커의 새 턴을 시작시킬 수 있어 보내지 않았습니다." : "";
			return { ok: false, reason: `${conflictText(lane, input.agent, scope, other, reservation.scope, false, reservation.kind === "director-path")}${wake}`, code: "lane-write" };
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
		return { ok: true, token, hold: key, ...(capacityKey === undefined ? {} : { reserved: true }), ...(notes.length === 0 ? {} : { notes }) };
	}

	/** Keep the reservation on a delivered follow-up; release one made by a preflight that then refused the turn. */
	finishFollowUp(token: string, keep: boolean): void {
		const entry = this.#followTokens.get(token);
		if (entry === undefined) return;
		this.#followTokens.delete(token);
		if (keep) return;
		// A note that was taken back before it went out leaves the reservation as it was.
		if (entry.noted === true && entry.reservation !== undefined) this.#takeBackNote(entry.reservation);
		// Identity-checked: only what this admission created, never a newer admission's reservation or hold.
		if (entry.created && entry.key !== undefined && this.#writes.get(entry.key) === entry.reservation) {
			this.#writes.delete(entry.key);
			// A woken turn that will not come: the authority its preflight reopened ends with the reservation.
			if (entry.reservation?.awaiting === true) this.#ended(entry.reservation.agentId, entry.reservation.lane, "follow-up-failed");
		}
		if (entry.holdLane !== undefined && this.#held.get(entry.holdLane)?.id === entry.holdId) this.#held.delete(entry.holdLane);
		if (entry.capacityKey !== undefined) releaseWorkerSlot(this.runId, entry.capacityKey);
	}

	/** The worker's reservation goes back to what it was before a note was sent to it. */
	#takeBackNote(reservation: WriteReservation): void {
		if (reservation.note === undefined) return;
		delete reservation.note;
		if (reservation.noteAwaitedBefore !== true) delete reservation.awaiting;
		delete reservation.noteAwaitedBefore;
	}

	/**
	 * The receipt of a `?progress` note that was sent to a worker the agent list showed running: `joinedOpenTurn` says omp
	 * folded it into the turn that was open (receipt `injected`), so no turn was woken and the reservation is the worker's
	 * own again. A note that woke a turn keeps the reservation until that turn's start is seen, like a work message.
	 */
	noteDelivered(callId: string, joinedOpenTurn: boolean): void {
		if (!joinedOpenTurn) return;
		for (const reservation of this.#writes.values()) if (reservation.note?.callId === callId) this.#takeBackNote(reservation);
	}

	/** An admitted worker must actually run and settle before its lane can provide evidence. */
	remaining(plan: RunPlan, agents: readonly AgentEntry[], failed: ReadonlySet<string>): string[] {
		const covered = new Set<string>();
		for (const agent of agents) {
			if (agent.state === "running" || agent.requests === 0 || agent.lastWorkFailed || failed.has(agent.id)) continue;
			const assignment = this.#admitted.get(agent.id);
			if (assignment?.key !== undefined) covered.add(assignment.key);
		}
		return plan.lanes.filter(lane => !covered.has(key(lane))).map(lane => lane.name);
	}
}
