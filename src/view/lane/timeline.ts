/**
 * The history behind the lane picture. Storm keeps only the current state of a run (`RunRecord`); this class compares
 * each observation of it with the previous one and records every lane's change of state, every phase change and the
 * start of every round, each with the time it was seen. Memory only: nothing here is stored, and it never decides
 * anything about the run.
 *
 * Cost: `observe` is one pass over the plan, results, agents, spawns and jobs and only touches history when a
 * lane's state, a phase or the round counter actually changed. `snapshot` reuses the arrays built at the last change;
 * per frame it only advances `now`, promotes a worker that went quiet, and gives running lanes a fresh `activity`.
 * History grows with the number of changes, never with time.
 */
import { BUILTIN_AGENT_ROLES, ROLES, roleTitle } from "../../roles.ts";
import { readOnlyIntent } from "../../policy/capability.ts";
import type { AgentEntry, PlanLane, RunJob, RunRecord, RunResult, SpawnRecord } from "../../types.ts";
import { resultFacts, type IntegrationFacts } from "../../runtime/result-facts.ts";
import type { CandidateProjection } from "../../runtime/integration-controller-port.ts";
import type { RunPhase } from "../appearance.ts";
import type { ResultProgress } from "../results.ts";
import {
	UNPLANNED_LABEL,
	type LaneIntent,
	type LaneJudgment,
	type LaneMilestone,
	type LanePiece,
	type LaneSnapshot,
	type LaneSpan,
	type LaneState,
	type LaneTrack,
	type PhaseSpan,
} from "./model.ts";

/** A running worker with no activity for this long is `quiet` (a long tool call, a slow generation). */
export const QUIET_MS = 60_000;
/** Activity of a worker that just did something, and of one about to turn quiet. */
const ACTIVITY_MAX = 1;
const ACTIVITY_MIN = 0.2;
/** A quiet worker still has a pulse; a fixed job carries no activity signal, so it flows at a steady middle speed. */
const ACTIVITY_QUIET = 0.1;
const ACTIVITY_JOB = 0.5;
/** Storm's word for a lane that runs an approved project job instead of a worker (the same word `/storm` shows). */
const JOB_LABEL = "정형 작업";

function epoch(iso: string | null | undefined): number | undefined {
	if (typeof iso !== "string") return undefined;
	const value = Date.parse(iso);
	return Number.isFinite(value) ? value : undefined;
}

/** What one observation says about one lane, before it is compared with history. */
interface Derived {
	readonly name: string;
	readonly label: string;
	readonly job: boolean;
	readonly dependsOn: readonly string[];
	readonly state: LaneState;
	readonly progress: { met: number; total: number } | undefined;
	/** Wall-clock ms of the worker's last activity; set while the lane is running or quiet. */
	readonly activityAt: number | undefined;
	/** Wall-clock ms the lane's first worker or job started, when the record still knows it. */
	readonly startedAt: number | undefined;
	/** Every accepted result is kept outside the target: not applied work (B7). */
	readonly retained?: true;
	readonly intent: LaneIntent;
	readonly unscoped: boolean;
	/** Hub-visible name of the lane's running (else latest) worker. */
	readonly agent: string | undefined;
	readonly pieces: readonly LanePiece[];
	/** Turns the user sent to the lane's workers directly (I2), and stops the user made (I4), summed over its workers. */
	readonly userTurns: number;
	readonly userStops: number;
	/** Each row's latest judgment (see `piecesByLane`). */
	readonly judgments: readonly RowJudgment[];
}

interface Tally {
	rows: number;
	inScope: number;
	met: number;
	reviewable: number;
	unmet: number;
	blocked: boolean;
	/** Over every row, scope aside: what a dependent lane needs from this one (the controller's rule). */
	accepted: number;
	submitted: number;
	/** Accepted rows that are retained artifacts kept outside the target. */
	kept: number;
}

function tallyResults(run: RunRecord, progress: ResultProgress): ReadonlyMap<string, Tally> {
	const byLane = new Map<string, Tally>();
	// A row's lane is shortened for display; the raw record keeps the plan's lane name.
	const rawLane = new Map<string, string>();
	for (const result of Array.isArray(run.results) ? run.results : []) {
		if (typeof result?.id === "string" && typeof result.lane === "string") rawLane.set(result.id, result.lane);
	}
	for (const row of progress.rows) {
		const lane = rawLane.get(row.id) ?? row.lane;
		if (lane === undefined) continue;
		let tally = byLane.get(lane);
		if (tally === undefined) {
			tally = { rows: 0, inScope: 0, met: 0, reviewable: 0, unmet: 0, blocked: false, accepted: 0, submitted: 0, kept: 0 };
			byLane.set(lane, tally);
		}
		tally.rows++;
		if (row.state === "accepted") tally.accepted++;
		if (row.state === "accepted" && row.kept) tally.kept++;
		if (row.state === "accepted" || row.state === "reviewable") tally.submitted++;
		if (row.excluded) continue;
		tally.inScope++;
		if (row.state === "accepted") tally.met++;
		else if (row.state === "reviewable") tally.reviewable++;
		else if (row.state === "unmet") tally.unmet++;
		if (row.state !== "accepted" && row.remedy === "blocked") tally.blocked = true;
	}
	return byLane;
}

/** One row as the stage's acts see it: the identity of its latest judgment and what that judgment says. */
interface RowJudgment { id: string; key: string; kind: LaneJudgment["kind"] | undefined }

/**
 * Every lane's required results in ledger order, by the plan's raw lane name, and each row's judgment: its state, its
 * remedy and the attempt, content version and authority behind it. A worker settling changes none of these; a new
 * verdict, delivery or retry does.
 */
function piecesByLane(run: RunRecord, progress: ResultProgress): { pieces: ReadonlyMap<string, LanePiece[]>; judgments: ReadonlyMap<string, RowJudgment[]> } {
	const raw = new Map<string, RunResult>();
	for (const result of Array.isArray(run.results) ? run.results : []) if (typeof result?.id === "string") raw.set(result.id, result);
	const pieces = new Map<string, LanePiece[]>();
	const judgments = new Map<string, RowJudgment[]>();
	for (const row of progress.rows) {
		const result = raw.get(row.id);
		const lane = (typeof result?.lane === "string" ? result.lane : undefined) ?? row.lane;
		if (lane === undefined) continue;
		const piece: LanePiece = row.excluded ? { id: row.id, state: row.state, excluded: true } : { id: row.id, state: row.state };
		const key = [row.state, row.remedy ?? "", result?.attemptId ?? "", result?.contentVersion ?? "", result?.origin ?? "", result?.reviewTree ?? ""].join("|");
		const kind = row.excluded ? undefined
			: row.state === "accepted" ? "accept"
			: row.remedy === "blocked" ? "blocked"
			: row.state === "unmet" ? "unmet"
			: row.state === "reviewable" ? "submit"
			: undefined;
		(pieces.get(lane) ?? pieces.set(lane, []).get(lane)!).push(piece);
		(judgments.get(lane) ?? judgments.set(lane, []).get(lane)!).push({ id: row.id, key, kind });
	}
	return { pieces, judgments };
}

function samePieces(a: readonly LanePiece[], b: readonly LanePiece[]): boolean {
	return a.length === b.length && a.every((piece, i) => piece.id === b[i]!.id && piece.state === b[i]!.state && piece.excluded === b[i]!.excluded);
}

/** A planned lane's intent from its kind, job and declared results (the policy's own read-intent rule). */
function laneIntent(lane: PlanLane): LaneIntent {
	if (lane.job !== undefined) return "job";
	if (lane.kind === "review") return "review";
	return readOnlyIntent(lane) ? "read" : "write";
}

/** An unplanned worker's intent from its role: reviewers judge, explorers and architects only read. */
function roleIntent(role: string | undefined): LaneIntent {
	if (role === "reviewer") return "review";
	return role === "explorer" || role === "architect" ? "read" : "write";
}

/** The user's direct turns and stops summed over a lane's workers, from the agent ledger. */
function userCounts(workers: readonly AgentEntry[]): { userTurns: number; userStops: number } {
	let userTurns = 0;
	let userStops = 0;
	for (const agent of workers) {
		userTurns += agent.userTurns ?? 0;
		userStops += agent.userStops ?? 0;
	}
	return { userTurns, userStops };
}

/** The worker the hub shows for a lane: the running one started last, else the one started last. */
function hubAgent(workers: readonly AgentEntry[]): string | undefined {
	let best: AgentEntry | undefined;
	for (const agent of workers) {
		if (best === undefined) best = agent;
		else if ((agent.state === "running") !== (best.state === "running")) best = agent.state === "running" ? agent : best;
		else if (agent.startedAt >= best.startedAt) best = agent;
	}
	return best?.id;
}

/** At or past the approved warning line (or over the hard budget), the same reading as the live spend chip. */
function pastWarnLine(run: RunRecord): boolean {
	const budget = run.budget;
	if (!budget || !Number.isFinite(run.costUsd) || !Number.isFinite(budget.perRunUsd) || budget.perRunUsd <= 0) return false;
	if (run.costUsd > budget.perRunUsd) return true;
	const warnAt = budget.warnAtUsd;
	return warnAt != null && Number.isFinite(warnAt) && warnAt > 0 && run.costUsd >= warnAt;
}

/** The role a worker has, whether or not the ledger recorded it (a storm-* agent name or one of omp's reviewers). */
function roleOf(agent: AgentEntry): string | undefined {
	return agent.role ?? ROLES.find(role => role.agent === agent.name)?.id ?? BUILTIN_AGENT_ROLES[agent.name];
}

/** Who works for whom: the lane each worker was admitted to, from the spawn that carried the lane name. */
interface Crew {
	/** Workers bound to a lane, by lane name. */
	readonly byLane: ReadonlyMap<string, readonly AgentEntry[]>;
	/** Earliest start of a worker or admitted spawn, by lane name. */
	readonly startedAt: ReadonlyMap<string, number>;
	/** Lanes whose worker is a reviewer that runs now. */
	readonly reviewerLanes: ReadonlySet<string>;
	/** A reviewer runs now that no lane claims (the director's own review task). */
	readonly looseReviewer: boolean;
}

function crewOf(run: RunRecord): Crew {
	const live = run.status === "running";
	const agents = new Map<string, AgentEntry>();
	for (const agent of Array.isArray(run.agents) ? run.agents : []) agents.set(agent.id, agent);
	const byLane = new Map<string, AgentEntry[]>();
	const startedAt = new Map<string, number>();
	const bound = new Set<string>();
	for (const spawn of Array.isArray(run.spawns) ? run.spawns : []) {
		if (spawn.lane === undefined || spawn.spawnKey === undefined || spawn.outcome === "blocked") continue;
		const agent = agents.get(spawn.spawnKey);
		if (agent === undefined) continue;
		bound.add(agent.id);
		const list = byLane.get(spawn.lane);
		if (list === undefined) byLane.set(spawn.lane, [agent]);
		else if (!list.includes(agent)) list.push(agent);
		const at = Math.min(agent.startedAt, epoch(spawn.ts) ?? Number.POSITIVE_INFINITY);
		if (Number.isFinite(at)) startedAt.set(spawn.lane, Math.min(startedAt.get(spawn.lane) ?? at, at));
	}
	const reviewerLanes = new Set<string>();
	let looseReviewer = false;
	if (live) {
		for (const agent of agents.values()) {
			if (agent.state !== "running" || roleOf(agent) !== "reviewer") continue;
			let owned = false;
			for (const [lane, list] of byLane) {
				if (!list.includes(agent)) continue;
				reviewerLanes.add(lane);
				owned = true;
			}
			if (!owned) looseReviewer = true;
		}
	}
	return { byLane, startedAt, reviewerLanes, looseReviewer };
}

function runningWorkers(run: RunRecord, crew: Crew, lane: string): AgentEntry[] {
	if (run.status !== "running") return [];
	return (crew.byLane.get(lane) ?? []).filter(agent => agent.state === "running");
}

/** Whether a prerequisite lane currently satisfies the edge, read from the same record the controller reads. */
function dependencyMet(
	run: RunRecord,
	crew: Crew,
	tallies: ReadonlyMap<string, Tally>,
	lane: PlanLane,
	need: "result" | "integrated" | "reviewable",
): boolean {
	if (runningWorkers(run, crew, lane.name).length > 0) return false;
	const tally = tallies.get(lane.name);
	if (tally !== undefined && tally.rows > 0) return (need === "reviewable" ? tally.submitted : tally.accepted) === tally.rows;
	// A lane that declared no results: a passed job, or a worker that settled without failing, is the only evidence.
	if (lane.job !== undefined) return jobOf(run, lane)?.status === "passed";
	const workers = crew.byLane.get(lane.name) ?? [];
	return workers.length > 0 && workers.every(agent => agent.state !== "running" && agent.lastWorkFailed !== true);
}

function jobOf(run: RunRecord, lane: PlanLane): RunJob | undefined {
	return Array.isArray(run.jobs) ? run.jobs.find(job => job?.lane === lane.name) : undefined;
}

function deriveLane(
	run: RunRecord,
	byName: ReadonlyMap<string, PlanLane>,
	lane: PlanLane,
	crew: Crew,
	tallies: ReadonlyMap<string, Tally>,
	results: { pieces: ReadonlyMap<string, readonly LanePiece[]>; judgments: ReadonlyMap<string, readonly RowJudgment[]> },
	now: number,
): Derived {
	const tally = tallies.get(lane.name);
	const dependsOn = (lane.dependsOn ?? []).map(edge => edge.lane).filter(name => name !== lane.name && byName.has(name));
	const isJob = lane.job !== undefined;
	const intent = laneIntent(lane);
	const base = {
		name: lane.name,
		label: isJob ? JOB_LABEL : roleTitle(lane.role),
		job: isJob,
		dependsOn,
		progress: tally !== undefined && tally.inScope > 0 ? { met: tally.met, total: tally.inScope } : undefined,
		intent,
		unscoped: intent === "write" && !(Array.isArray(lane.files) && lane.files.length > 0) && lane.isolationReason === undefined,
		agent: isJob ? undefined : hubAgent(crew.byLane.get(lane.name) ?? []),
		pieces: results.pieces.get(lane.name) ?? [],
		judgments: results.judgments.get(lane.name) ?? [],
		...userCounts(isJob ? [] : crew.byLane.get(lane.name) ?? []),
	};
	const done = (state: LaneState, activityAt?: number, startedAt?: number): Derived => ({ ...base, state, activityAt, startedAt });
	const allMet = tally !== undefined && tally.inScope > 0 && tally.met === tally.inScope;
	const allExcluded = tally !== undefined && tally.rows > 0 && tally.inScope === 0;
	const receipt = isJob ? jobOf(run, lane) : undefined;
	const workers = isJob ? [] : crew.byLane.get(lane.name) ?? [];
	const startedAt = isJob ? epoch(receipt?.startedAt) : crew.startedAt.get(lane.name);
	const started = isJob ? receipt !== undefined && receipt.status !== "unrun" : workers.length > 0;
	const waiting = (): LaneState =>
		(lane.dependsOn ?? []).every(edge => {
			const need = byName.get(edge.lane);
			return need === undefined || dependencyMet(run, crew, tallies, need, edge.need);
		})
			? "reserved"
			: "waiting";

	// The user's scope decision is final for the picture, whatever the lane's worker is doing.
	if (allExcluded) return done("excluded", undefined, startedAt);
	if (allMet) {
		const acceptedRetained = tally !== undefined && tally.met > 0 && tally.kept === tally.met;
		return { ...done("accepted", undefined, startedAt), ...(acceptedRetained ? { retained: true as const } : {}) };
	}

	if (isJob) {
		if (receipt === undefined || receipt.status === "unrun") return done(waiting());
		if (receipt.status === "started") {
			// A receipt left "started" by a process that is gone is not a job still running.
			return run.status === "running" ? done("running", undefined, startedAt) : done("idle", undefined, startedAt);
		}
		if (receipt.status === "passed") {
			return done(tally === undefined || tally.rows === 0 ? "idle" : tally.blocked ? "blocked" : tally.reviewable > 0 ? "submitted" : "idle", undefined, startedAt);
		}
		if (receipt.status === "spawn-error") return done("blocked", undefined, startedAt);
		if (receipt.status === "unknown") return done("idle", undefined, startedAt);
		return done("unmet", undefined, startedAt);
	}

	const active = runningWorkers(run, crew, lane.name);
	if (active.length > 0) {
		const last = Math.max(...active.map(agent => agent.lastActivityAt));
		const quiet = !(last > 0) || now - last >= QUIET_MS;
		return done(quiet ? "quiet" : "running", Number.isFinite(last) ? last : 0, startedAt);
	}
	if (tally?.blocked === true) return done("blocked", undefined, startedAt);
	if (tally !== undefined && tally.reviewable > 0) {
		// A reviewer's lane names what it judges by its dependencies; a review lane that declares none (or no lane at all)
		// is the director's batch review, which judges every reviewable answer, so all of them show the scan.
		const reviewed =
			crew.looseReviewer ||
			[...crew.reviewerLanes].some(name => {
				const edges = byName.get(name)?.dependsOn ?? [];
				return edges.length === 0 || edges.some(edge => edge.lane === lane.name);
			});
		if (reviewed) return done("reviewing", undefined, startedAt);
	}
	if (tally !== undefined && tally.unmet > 0) return done("unmet", undefined, startedAt);
	if (tally !== undefined && tally.reviewable > 0) return done("submitted", undefined, startedAt);
	return started ? done("idle", undefined, startedAt) : done(waiting());
}

/**
 * One row for a worker the run placed without a lane. Its state is what the record can prove: refused at its hook,
 * placed but not started, running or quiet by the same allowance as a lane, and idle once its turn is over. It is never
 * accepted and never joins the trunk; a planned lane that declares no results is idle too.
 */
function deriveUnplanned(spawn: SpawnRecord, name: string, now: number, agents: ReadonlyMap<string, AgentEntry>): Derived {
	const agent = spawn.spawnKey === undefined ? undefined : agents.get(spawn.spawnKey);
	// A worker outside the plan declares no file list: as a writer it is one G1 cannot narrow.
	const intent = roleIntent(spawn.role ?? (agent === undefined ? undefined : roleOf(agent)));
	const base = {
		name,
		label: UNPLANNED_LABEL,
		job: false,
		dependsOn: [],
		progress: undefined,
		startedAt: agent?.startedAt ?? epoch(spawn.ts),
		intent,
		unscoped: intent === "write",
		agent: agent?.id,
		pieces: [],
		judgments: [],
		...userCounts(agent === undefined ? [] : [agent]),
	};
	if (spawn.outcome === "blocked") return { ...base, state: "refused", activityAt: undefined, startedAt: epoch(spawn.ts) };
	if (agent === undefined) return { ...base, state: "reserved", activityAt: undefined };
	if (agent.state === "running") {
		const last = agent.lastActivityAt;
		const quiet = !(last > 0) || now - last >= QUIET_MS;
		return { ...base, state: quiet ? "quiet" : "running", activityAt: Number.isFinite(last) ? last : 0 };
	}
	return { ...base, state: "idle", activityAt: undefined };
}

/** One lane's history: spans are ordered and gapless, the last one is open. */
interface History {
	name: string;
	label: string;
	job: boolean;
	dependsOn: readonly string[];
	progress: { met: number; total: number } | undefined;
	/** The lane's accepted results are all retained: drawn as kept, never as an integrated acceptance. */
	retained: boolean;
	intent: LaneIntent;
	unscoped: boolean;
	agent: string | undefined;
	pieces: readonly LanePiece[];
	/** The user counters last seen, and the offsets at which each one grew (never the counts first seen). */
	userTurns: number;
	userStops: number;
	steeredAt: number[];
	stoppedAt: number[];
	/** Each row's judgment key last seen, and the moments a row got a new judgment while the view watched. */
	judgmentKeys: Map<string, string>;
	judgedAt: LaneJudgment[];
	spans: LaneSpan[];
	/** Wall-clock ms of the worker's last activity while the lane is running; its quiet moment follows from it. */
	activityAt: number | undefined;
	/** Colour slot for the life of the run; never reused when a replan drops the lane. */
	slot: number;
	/** Immutable view handed to the picture; rebuilt only when this lane changed. */
	track: LaneTrack;
}

function sameProgress(a: History["progress"], b: History["progress"]): boolean {
	return a === b || (a !== undefined && b !== undefined && a.met === b.met && a.total === b.total);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class LaneTimeline {
	#start: number | undefined;
	/** The latest offset any record carries: time never runs backwards in the picture. */
	#latest = 0;
	#phases: PhaseSpan[] = [];
	#rounds: number[] = [0];
	#turns: number | undefined;
	#lanes = new Map<string, History>();
	#order: string[] = [];
	/** Next colour slot; slots are handed out once per lane and never reused. */
	#slots = 0;
	#complete = false;
	/** Wall-clock ms at which the earliest running lane turns quiet; infinity when none will. */
	#quietAt = Number.POSITIVE_INFINITY;
	#integration: IntegrationFacts | undefined;
	#base:
		| {
				phases: readonly PhaseSpan[];
				rounds: readonly number[];
				lanes: readonly LaneTrack[];
				milestones: readonly LaneMilestone[];
				live: boolean;
		  }
		| undefined;
	#milestones: LaneMilestone[] = [];
	/** The plan this timeline saw last: its submission time and lane names, so a replan is a change of both. */
	#plan: { submittedAt: string | undefined; names: string } | undefined;
	#budgetWarnAt: number | undefined;
	/** View-only evidence from the live controller: the director's own path edit holds the tree now (never stored). */
	#directorEditing = false;

	/**
	 * Folds one observation of the run into the history. Called on every live update; cheap when nothing changed.
	 * `directorEditing` is view-only evidence like `phase`: the director's own path edit holds the write table now.
	 */
	observe(run: RunRecord, phase: RunPhase, now: number, integration?: CandidateProjection, directorEditing = false): void {
		const first = this.#start === undefined;
		const start = (this.#start ??= epoch(run.startedAt) ?? now);
		const at = this.#at(now);
		this.#latest = at;
		let changed = first;
		if (first) this.#milestones.push({ at: 0, kind: typeof run.resumeOf === "string" ? "resume" : "start" });

		if (this.#phases.length === 0) this.#phases.push({ from: 0, phase });
		else {
			const open = this.#phases[this.#phases.length - 1]!;
			if (open.phase !== phase) {
				// The record only says the earlier life existed, so a phase change at the very start replaces the span.
				const from = Math.max(open.from, at);
				if (from === open.from) {
					const previous = this.#phases[this.#phases.length - 2];
					if (previous?.phase === phase) {
						delete previous.to;
						this.#phases.pop();
					} else open.phase = phase;
				} else {
					this.#phases[this.#phases.length - 1] = { from: open.from, to: from, phase: open.phase };
					this.#phases.push({ from, phase });
				}
				changed = true;
			}
		}

		// The round counter is the only round fact the record keeps; earlier round starts are not persisted.
		const turns = Math.max(0, Math.floor(run.turns ?? 0));
		if (this.#turns !== undefined && turns > this.#turns) {
			for (let round = this.#turns; round < turns; round++) this.#rounds.push(at);
			changed = true;
		}
		this.#turns = turns;

		if (directorEditing !== this.#directorEditing) {
			this.#directorEditing = directorEditing;
			changed = true;
		}
		if (this.#budgetWarnAt === undefined && pastWarnLine(run)) {
			// A line already crossed when the view first looks was crossed before it: the light is down from the start,
			// with no moment to play.
			this.#budgetWarnAt = first ? 0 : at;
			changed = true;
		}

		const facts = resultFacts(run, integration === undefined ? {} : { integration });
		const nextIntegration = facts.integration;
		if (JSON.stringify(this.#integration ?? null) !== JSON.stringify(nextIntegration ?? null)) {
			this.#integration = nextIntegration;
			changed = true;
		}
		const progress = facts.progress;
		const plan = run.plan?.lanes;
		const crew = crewOf(run);
		const tallies = tallyResults(run, progress);
		const results = piecesByLane(run, progress);
		// The team is assembled again when the director submits a plan whose lane set differs. The first plan of a run is
		// part of its start: when it lands after the start, the start's gathering plays then.
		const names = (plan ?? []).map(lane => (typeof lane?.name === "string" ? lane.name : "")).sort().join("\n");
		const submittedAt = run.plan?.submittedAt;
		const before = this.#plan;
		if (!first && before !== undefined && before.submittedAt !== submittedAt && before.names !== names && names !== "") {
			this.#milestones.push({ at, kind: before.names === "" ? this.#milestones[0]!.kind : "replan" });
			changed = true;
		}
		this.#plan = { submittedAt, names };
		const byName = new Map<string, PlanLane>();
		for (const lane of plan ?? []) if (typeof lane?.name === "string" && !byName.has(lane.name)) byName.set(lane.name, lane);
		const planned = epoch(run.plan?.submittedAt);
		const seen = new Set<string>();
		const order: string[] = [];
		for (const lane of plan ?? []) {
			if (typeof lane?.name !== "string" || seen.has(lane.name)) continue;
			seen.add(lane.name);
			order.push(lane.name);
			const derived = deriveLane(run, byName, lane, crew, tallies, results, now);
			if (this.#apply(derived, first, start, at, planned)) changed = true;
		}
		// One row per unplanned placement, after the plan's rows. The name is the handle the director used; a name the
		// plan already has (or a second worker with the same one) gets a stable ordinal. The row is never accepted.
		const agentById = new Map<string, AgentEntry>();
		for (const agent of Array.isArray(run.agents) ? run.agents : []) agentById.set(agent.id, agent);
		const nameCounts = new Map<string, number>();
		for (const spawn of Array.isArray(run.spawns) ? run.spawns : []) {
			if (spawn.lane !== undefined) continue;
			const base = spawn.spawnKey ?? spawn.agent;
			let ordinal = (nameCounts.get(base) ?? 0) + 1;
			let name = ordinal === 1 ? base : `${base} ${ordinal}`;
			while (seen.has(name)) {
				ordinal += 1;
				name = `${base} ${ordinal}`;
			}
			nameCounts.set(base, ordinal);
			seen.add(name);
			order.push(name);
			const derived = deriveUnplanned(spawn, name, now, agentById);
			if (this.#apply(derived, first, start, at, epoch(spawn.ts))) changed = true;
		}
		// Excluding a lane takes it out of the plan but not out of the run: its results stay, all out of scope. Such a
		// lane stays in the picture as excluded, in its previous order. Any other row the plan or the run dropped leaves
		// with its history. One pass over the previous order keeps this linear in the number of workers.
		const excluded: string[] = [];
		for (const name of this.#order) {
			if (seen.has(name)) continue;
			const tally = tallies.get(name);
			const history = this.#lanes.get(name);
			if (history === undefined) continue;
			if (tally === undefined || tally.rows === 0 || tally.inScope > 0) {
				this.#lanes.delete(name);
				changed = true;
				continue;
			}
			if (history.spans[history.spans.length - 1]!.state !== "excluded") {
				this.#move(history, "excluded", at);
				history.activityAt = undefined;
				history.progress = undefined;
				history.track = trackOf(history);
				changed = true;
			}
			excluded.push(name);
		}
		order.push(...excluded);
		if (!sameList(order, this.#order)) changed = true;
		this.#order = order;

		// A run whose every acceptance is a retained artifact applied nothing to the target: it has no finale to play.
		const complete = facts.complete && !(facts.retained.count > 0 && facts.retained.count === facts.progress.counts.accepted);
		if (complete !== this.#complete) {
			this.#complete = complete;
			changed = true;
		}
		if (changed) this.#rebuild();
		this.#schedule();
	}

	/** The picture's input at wall-clock `now`. Called for every frame: no work beyond advancing `now`. */
	snapshot(now: number): LaneSnapshot {
		if (this.#start === undefined) {
			return { now: 0, phases: [], rounds: [0], lanes: [], complete: false, ...(this.#integration === undefined ? {} : { integration: this.#integration }) };
		}
		if (now >= this.#quietAt) this.#promoteQuiet(now);
		const base = this.#base!;
		const at = this.#at(now);
		const extra = {
			...(this.#integration === undefined ? {} : { integration: this.#integration }),
			milestones: base.milestones,
			...(this.#budgetWarnAt === undefined ? {} : { budgetWarnAt: this.#budgetWarnAt }),
			...(this.#directorEditing ? { directorEditing: true as const } : {}),
		};
		if (!base.live) return { now: at, phases: base.phases, rounds: base.rounds, lanes: base.lanes, complete: this.#complete, ...extra };
		const lanes = base.lanes.map(track => {
			const history = this.#lanes.get(track.name)!;
			return isBusy(history) ? { ...track, activity: activityOf(history, now) } : track;
		});
		return { now: at, phases: base.phases, rounds: base.rounds, lanes, complete: this.#complete, ...extra };
	}

	/** Milliseconds from run start, never earlier than anything already recorded. */
	#at(now: number): number {
		return Math.max(this.#latest, now - this.#start!);
	}

	/** Brings one lane's history up to its derived state; true when anything about the lane changed. */
	#apply(derived: Derived, first: boolean, start: number, at: number, planned: number | undefined): boolean {
		let history = this.#lanes.get(derived.name);
		if (history === undefined) {
			history = this.#create(derived, first, start, at, planned);
			this.#lanes.set(derived.name, history);
			return true;
		}
		let changed = false;
		const open = history.spans[history.spans.length - 1]!;
		if (open.state !== derived.state) {
			this.#move(history, derived.state, this.#transitionAt(open, derived, start, at));
			changed = true;
		}
		// The quiet moment follows the worker's latest activity; `schedule` reads it after every observation.
		history.activityAt = derived.state === "running" || derived.state === "quiet" ? derived.activityAt : undefined;
		// Every turn or stop the user added since the last observation is one moment on the lane; a count that fell
		// (a worker left the lane) only lowers the baseline.
		for (let n = history.userTurns; n < derived.userTurns; n++) history.steeredAt.push(at);
		for (let n = history.userStops; n < derived.userStops; n++) history.stoppedAt.push(at);
		if (history.userTurns < derived.userTurns || history.userStops < derived.userStops) changed = true;
		history.userTurns = derived.userTurns;
		history.userStops = derived.userStops;
		// A row whose judgment changed is one moment; a row first seen, or one whose worker merely settled, is none. An
		// acceptance plays when it completes the lane (every row in scope accepted), as the lane's acceptance.
		for (const row of derived.judgments) {
			const previous = history.judgmentKeys.get(row.id);
			const counts = row.kind !== undefined && (row.kind !== "accept" || derived.state === "accepted");
			if (previous !== undefined && previous !== row.key && counts) {
				history.judgedAt.push({ at, kind: row.kind! });
				changed = true;
			}
			history.judgmentKeys.set(row.id, row.key);
		}
		if (
			history.label !== derived.label ||
			history.job !== derived.job ||
			history.retained !== (derived.retained === true) ||
			history.intent !== derived.intent ||
			history.unscoped !== derived.unscoped ||
			history.agent !== derived.agent ||
			!samePieces(history.pieces, derived.pieces) ||
			!sameList(history.dependsOn, derived.dependsOn) ||
			!sameProgress(history.progress, derived.progress)
		) {
			history.label = derived.label;
			history.job = derived.job;
			history.retained = derived.retained === true;
			history.intent = derived.intent;
			history.unscoped = derived.unscoped;
			history.agent = derived.agent;
			history.pieces = derived.pieces;
			history.dependsOn = derived.dependsOn;
			history.progress = derived.progress;
			changed = true;
		}
		if (changed) history.track = trackOf(history);
		return changed;
	}

	/**
	 * When a transition is placed. A change is placed where it was seen, except the two the worker's own activity
	 * time dates: running turning quiet (its last activity plus the quiet allowance) and quiet turning running (that
	 * activity itself), so a sparse observation does not shift them.
	 */
	#transitionAt(open: LaneSpan, derived: Derived, start: number, at: number): number {
		const activity = derived.activityAt;
		if (activity === undefined) return at;
		if (open.state === "running" && derived.state === "quiet") return Math.min(at, Math.max(open.from, activity + QUIET_MS - start));
		if (open.state === "quiet" && derived.state === "running") return Math.min(at, Math.max(open.from, activity - start));
		return at;
	}

	#create(derived: Derived, first: boolean, start: number, at: number, planned: number | undefined): History {
		const spans: LaneSpan[] = [];
		// A lane that appears later is seen when it appears. On the first observation the record's own start times
		// date the lane: reserved from the plan to its first worker, then one stretch in the state it is in now.
		if (!first) spans.push({ from: at, state: derived.state });
		else {
			const offset = (value: number | undefined): number | undefined => (value === undefined ? undefined : Math.min(at, Math.max(0, value - start)));
			const began = offset(derived.startedAt);
			// A refused placement never ran: its row starts at the refusal, with no reserved stretch before it.
			if (derived.state === "refused") {
				spans.push({ from: began ?? at, state: "refused" });
			} else {
				const appears = Math.min(offset(planned) ?? 0, began ?? Number.POSITIVE_INFINITY);
				const quietBefore = derived.state === "reserved" || derived.state === "waiting" || derived.state === "excluded";
				if (began !== undefined && began > appears && !quietBefore) {
					spans.push({ from: appears, to: began, state: "reserved" }, { from: began, state: derived.state });
				} else spans.push({ from: appears, state: derived.state });
			}
		}
		const activityAt = derived.state === "running" || derived.state === "quiet" ? derived.activityAt : undefined;
		const history: History = {
			name: derived.name,
			label: derived.label,
			job: derived.job,
			dependsOn: derived.dependsOn,
			intent: derived.intent,
			unscoped: derived.unscoped,
			agent: derived.agent,
			pieces: derived.pieces,
			userTurns: derived.userTurns,
			userStops: derived.userStops,
			steeredAt: [],
			stoppedAt: [],
			judgmentKeys: new Map(derived.judgments.map(row => [row.id, row.key])),
			judgedAt: [],
			progress: derived.progress,
			retained: derived.retained === true,
			spans,
			activityAt,
			slot: this.#slots++,
			track: undefined as unknown as LaneTrack,
		};
		history.track = trackOf(history);
		return history;
	}

	/** Closes the open span at `at` and opens a new one; a change in the same instant replaces the open span. */
	#move(history: History, state: LaneState, at: number): void {
		const spans = history.spans;
		const open = spans[spans.length - 1]!;
		const from = Math.max(open.from, at);
		if (from === open.from) {
			const before = spans[spans.length - 2];
			if (before?.state === state) {
				delete before.to;
				spans.pop();
			} else spans[spans.length - 1] = { from: open.from, state };
		} else {
			spans[spans.length - 1] = { from: open.from, to: from, state: open.state };
			spans.push({ from, state });
		}
		if (from > this.#latest) this.#latest = from;
	}

	/** Records, at the moment it came true, every running lane whose worker has been silent for the quiet allowance. */
	#promoteQuiet(now: number): void {
		const start = this.#start!;
		for (const history of this.#lanes.values()) {
			const open = history.spans[history.spans.length - 1]!;
			if (open.state !== "running" || history.activityAt === undefined) continue;
			const quietAt = history.activityAt + QUIET_MS;
			if (now < quietAt) continue;
			this.#move(history, "quiet", Math.min(this.#at(now), Math.max(open.from, quietAt - start)));
			history.track = trackOf(history);
		}
		this.#rebuild();
		this.#schedule();
	}

	/** The next moment a running lane turns quiet; cheap enough to redo after every observation. */
	#schedule(): void {
		let quietAt = Number.POSITIVE_INFINITY;
		for (const history of this.#lanes.values()) {
			if (history.activityAt === undefined || history.spans[history.spans.length - 1]!.state !== "running") continue;
			quietAt = Math.min(quietAt, history.activityAt + QUIET_MS);
		}
		this.#quietAt = quietAt;
	}

	/** Rebuilds what snapshots share; only after something changed. */
	#rebuild(): void {
		let live = false;
		const lanes: LaneTrack[] = [];
		for (const name of this.#order) {
			const history = this.#lanes.get(name);
			if (history === undefined) continue;
			lanes.push(history.track);
			if (isBusy(history)) live = true;
		}
		this.#base = {
			phases: this.#phases.map(span => ({ ...span })),
			rounds: this.#rounds.slice(),
			lanes,
			milestones: this.#milestones.slice(),
			live,
		};
	}
}

/** A lane whose picture needs an `activity`: a worker that is running or quiet, or a job that runs. */
function isBusy(history: History): boolean {
	const state = history.spans[history.spans.length - 1]!.state;
	return state === "running" || state === "quiet";
}

function trackOf(history: History): LaneTrack {
	return {
		name: history.name,
		label: history.label,
		slot: history.slot,
		...(history.job ? { job: true as const } : {}),
		dependsOn: history.dependsOn,
		spans: history.spans.map(span => ({ ...span })),
		...(history.progress === undefined ? {} : { progress: { ...history.progress } }),
		...(history.retained ? { retained: true as const } : {}),
		intent: history.intent,
		...(history.unscoped ? { unscoped: true as const } : {}),
		...(history.agent === undefined ? {} : { agent: history.agent }),
		...(history.pieces.length === 0 ? {} : { pieces: history.pieces }),
		...(history.steeredAt.length === 0 ? {} : { steeredAt: history.steeredAt.slice() }),
		...(history.stoppedAt.length === 0 ? {} : { stoppedAt: history.stoppedAt.slice() }),
		...(history.judgedAt.length === 0 ? {} : { judgedAt: history.judgedAt.slice() }),
	};
}

/** How busy a busy lane is: full right after activity, easing to a low flow as the quiet moment nears. */
function activityOf(history: History, now: number): number {
	if (history.job) return ACTIVITY_JOB;
	const open = history.spans[history.spans.length - 1]!;
	if (open.state === "quiet") return ACTIVITY_QUIET;
	const age = Math.max(0, now - (history.activityAt ?? now));
	return ACTIVITY_MAX - (ACTIVITY_MAX - ACTIVITY_MIN) * Math.min(1, age / QUIET_MS);
}
