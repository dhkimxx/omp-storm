/**
 * The stage's timeline: which species stood when, how one handed over to the next, and which acts played. Everything
 * is computed from the lane view's input alone (lane spans, phases, rounds, milestones, the budget warning), so the
 * same snapshot and time always give the same stage; nothing is stored and nothing here decides anything.
 *
 * Species: the cast (`cast.ts`) is evaluated at every moment the input changes. A species that stood longer than
 * `HANDOFF_AFTER_MS` hands over in a full handoff; a shorter one crossfades away, which is also what stops a flicker.
 * A transition never starts while a handoff is still playing: it waits for its end.
 *
 * Acts come only from ledger events (`docs/stage.md` "사건 연기"): a lane starting, submitting, being accepted,
 * unmet, blocked or refused; the user turning to a lane's worker directly (I2) or stopping it (I4); the run waiting for
 * the user; the run stopping complete or incomplete; a new round; the spend reaching the warning line. Rules:
 * - Events of one kind within `MERGE_MS` of the first one play as one act (its lanes grow as they arrive).
 * - Big accents (blocked, accept, finale) play one per `BIG_GAP_MS`; while several wait, the higher priority plays
 *   first and the waiting ones of the same kind join it.
 * - An act that arrives during a species transition plays after it.
 * - Waiting for the user cuts in at once: it ignores transitions and the accent budget, stops what plays and drops what
 *   was recorded before it but still waited to play.
 */
import type { LaneSnapshot, LaneState } from "../lane/model.ts";
import { type Cast, castAt, GATHER_MS, intentOf, type Species, stillCastAt } from "./cast.ts";

/** A species that stood this long gets a full handoff; a shorter one crossfades. */
export const HANDOFF_AFTER_MS = 3000;
export const HANDOFF_MS = 1200;
export const CROSSFADE_MS = 250;
/** One big accent per this window. */
export const BIG_GAP_MS = 1500;
/** Same-kind events within this window play as one. */
export const MERGE_MS = 500;

export type ActKind =
	| "waiting" | "blocked" | "accept" | "unmet" | "submit" | "start" | "budget" | "round" | "finale" | "lights-out" | "user-steer" | "user-stop";

/** Priority (lower plays first), whether it spends the accent budget, and how long it plays. */
export const ACTS: Readonly<Record<ActKind, { priority: number; big: boolean; ms: number }>> = {
	waiting: { priority: 1, big: false, ms: 2400 },
	blocked: { priority: 2, big: true, ms: 600 },
	accept: { priority: 3, big: true, ms: 1300 },
	finale: { priority: 3, big: true, ms: 2200 },
	"lights-out": { priority: 3, big: false, ms: 4000 },
	unmet: { priority: 4, big: false, ms: 600 },
	submit: { priority: 5, big: false, ms: 900 },
	start: { priority: 6, big: false, ms: 600 },
	budget: { priority: 6, big: false, ms: 1000 },
	round: { priority: 8, big: false, ms: 800 },
	// The user turned to a worker directly: it faces front, nods, and goes back to work (I2).
	"user-steer": { priority: 5, big: false, ms: 900 },
	// The user stopped a worker: it puts its piece down and leaves the stage (I4).
	"user-stop": { priority: 4, big: false, ms: 1000 },
};

export interface SpeciesSegment { from: number; cast: Cast }
export interface SpeciesTransition { at: number; ms: number; from: Species; to: Species; kind: "handoff" | "crossfade" }
/**
 * One played act. `lanes` are indices into `snapshot.lanes`; `arrivals` when each lane's event was recorded; `cause`
 * when the first event of the act was recorded (an act may play later than that).
 */
export interface StageAct { kind: ActKind; at: number; ms: number; cause: number; lanes: readonly number[]; arrivals: readonly number[] }
export interface StagePlan { segments: readonly SpeciesSegment[]; transitions: readonly SpeciesTransition[]; acts: readonly StageAct[] }

/** What the stage shows at one moment. */
export interface StageMoment {
	/** What the record says now: the phrase always follows it. */
	cast: Cast;
	/** The species on stage: the cast's, except while a queued transition has not reached it yet. */
	species: Species;
	/** The transition in progress, with how far it got (0..1). */
	transition?: { from: Species; to: Species; kind: SpeciesTransition["kind"]; progress: number };
	/** Acts in progress, with how far each got (0..1); only lanes whose event already happened. */
	acts: readonly { act: StageAct; lanes: readonly number[]; progress: number }[];
	/** The stage light is one step down: spend reached the warning line. */
	dim: boolean;
}

const LANE_EVENT: Partial<Record<LaneState, ActKind>> = {
	submitted: "submit", accepted: "accept", unmet: "unmet", blocked: "blocked", refused: "blocked",
};

interface Event { kind: ActKind; at: number; lane: number }

function events(snapshot: LaneSnapshot): Event[] {
	const out: Event[] = [];
	snapshot.lanes.forEach((lane, index) => {
		// A lane whose rows the timeline tracks takes its deliveries, verdicts and blocks from their judgments: a worker
		// that settles with an old verdict changes the lane's state, not the ledger. A job's receipt and an unplanned
		// refusal have no rows; their state changes are the record's own moments.
		const rows = lane.pieces !== undefined && intentOf(lane) !== "job";
		let started = false;
		let settled = false;
		lane.spans.forEach((span, k) => {
			const previous = k > 0 ? lane.spans[k - 1]!.state : undefined;
			if (span.state === previous) return;
			if (span.state === "running" || span.state === "quiet") {
				// Only a lane's first start is one; a lane seen settled before it ran again (a follow-up) started earlier.
				if (!started && !settled) out.push({ kind: "start", at: span.from, lane: index });
				started = true;
				return;
			}
			if (span.state !== "reserved" && span.state !== "waiting") settled = true;
			const kind = LANE_EVENT[span.state];
			// A lane first seen already submitted, accepted or unmet got there before the picture watched: only a refusal
			// or a block is played from the lane's first stretch, because the record shows it where it happened.
			if (kind === undefined || (k === 0 && kind !== "blocked") || (rows && span.state !== "refused")) return;
			out.push({ kind, at: span.from, lane: index });
		});
		if (rows) for (const judged of lane.judgedAt ?? []) out.push({ kind: judged.kind, at: judged.at, lane: index });
		// The timeline records a moment only for a turn or stop that came while it watched.
		for (const at of lane.steeredAt ?? []) out.push({ kind: "user-steer", at, lane: index });
		for (const at of lane.stoppedAt ?? []) out.push({ kind: "user-stop", at, lane: index });
	});
	snapshot.phases.forEach((span, k) => {
		if (k > 0 && snapshot.phases[k - 1]!.phase === span.phase) return;
		if (span.phase === "waiting-user") out.push({ kind: "waiting", at: span.from, lane: -1 });
		if (span.phase === "stopping") out.push({ kind: snapshot.complete ? "finale" : "lights-out", at: span.from, lane: -1 });
	});
	snapshot.rounds.forEach((offset, k) => { if (k > 0) out.push({ kind: "round", at: offset, lane: -1 }); });
	if (snapshot.budgetWarnAt !== undefined) out.push({ kind: "budget", at: snapshot.budgetWarnAt, lane: -1 });
	return out.sort((a, b) => a.at - b.at || ACTS[a.kind].priority - ACTS[b.kind].priority || a.lane - b.lane);
}

/** Every run time at which the cast may change. */
function changePoints(snapshot: LaneSnapshot): number[] {
	const points = new Set<number>([0]);
	for (const lane of snapshot.lanes) for (const span of lane.spans) points.add(span.from);
	for (const span of snapshot.phases) points.add(span.from);
	for (const milestone of snapshot.milestones ?? []) {
		points.add(milestone.at);
		points.add(milestone.at + GATHER_MS);
	}
	return [...points].filter(point => Number.isFinite(point) && point >= 0).sort((a, b) => a - b);
}

function speciesTimeline(snapshot: LaneSnapshot): { segments: SpeciesSegment[]; transitions: SpeciesTransition[] } {
	const segments: SpeciesSegment[] = [];
	const transitions: SpeciesTransition[] = [];
	let held: Species | undefined;
	/** The last species with workers on stage (not the owl, not the starlings): who plays the finale. */
	let team: Species | undefined;
	// The species really on stage once every transition so far has played, and since when it stood there.
	let shown: Species | undefined;
	let shownSince = 0;
	let busyUntil = Number.NEGATIVE_INFINITY;
	for (const at of changePoints(snapshot)) {
		const previous = segments[segments.length - 1];
		const cast = castAt(snapshot, at, held, team);
		if (cast.pose === "work") held = cast.species;
		if (cast.pose === "work" && cast.species !== "owl" && cast.species !== "starling") team = cast.species;
		if (previous !== undefined && previous.cast.rule === cast.rule && previous.cast.species === cast.species && previous.cast.pose === cast.pose) continue;
		segments.push({ from: at, cast });
		if (shown === undefined) {
			shown = cast.species;
			shownSince = at;
			continue;
		}
		if (cast.species === shown) continue;
		// A transition never starts while a handoff plays; the species it leaves is the one really on stage.
		const start = Math.max(at, busyUntil);
		const kind = start - shownSince > HANDOFF_AFTER_MS ? "handoff" : "crossfade";
		const ms = kind === "handoff" ? HANDOFF_MS : CROSSFADE_MS;
		transitions.push({ at: start, ms, from: shown, to: cast.species, kind });
		busyUntil = start + ms;
		shown = cast.species;
		shownSince = busyUntil;
	}
	return { segments, transitions };
}

/** The earliest moment at or after `at` that no transition covers. */
function clearOf(transitions: readonly SpeciesTransition[], at: number): number {
	let t = at;
	for (const transition of transitions) if (t >= transition.at && t < transition.at + transition.ms) t = transition.at + transition.ms;
	return t;
}

interface Group { kind: ActKind; at: number; lanes: number[]; arrivals: number[] }

function schedule(snapshot: LaneSnapshot, transitions: readonly SpeciesTransition[]): StageAct[] {
	// Same-kind events within the merge window become one group.
	const groups: Group[] = [];
	const open = new Map<ActKind, Group>();
	for (const event of events(snapshot)) {
		const current = open.get(event.kind);
		if (current !== undefined && event.at - current.at <= MERGE_MS) {
			if (event.lane >= 0 && !current.lanes.includes(event.lane)) {
				current.lanes.push(event.lane);
				current.arrivals.push(event.at);
			}
			continue;
		}
		const group: Group = { kind: event.kind, at: event.at, lanes: event.lane >= 0 ? [event.lane] : [], arrivals: event.lane >= 0 ? [event.at] : [] };
		groups.push(group);
		open.set(event.kind, group);
	}

	const acts: StageAct[] = [];
	const big: Group[] = [];
	for (const group of groups) {
		const spec = ACTS[group.kind];
		if (group.kind === "waiting") acts.push({ kind: group.kind, at: group.at, ms: spec.ms, cause: group.at, lanes: [], arrivals: [] });
		else if (spec.big) big.push(group);
		else acts.push({ ...group, at: clearOf(transitions, group.at), ms: spec.ms, cause: group.at });
	}

	// Big accents share one slot: one per BIG_GAP_MS, highest priority first among those already waiting.
	let free = Number.NEGATIVE_INFINITY;
	const pending = big.map(group => ({ ...group, ready: clearOf(transitions, group.at) }));
	while (pending.length > 0) {
		const earliest = Math.min(...pending.map(group => group.ready));
		const slot = Math.max(free, earliest);
		const ready = pending.filter(group => group.ready <= slot);
		ready.sort((a, b) => ACTS[a.kind].priority - ACTS[b.kind].priority || a.ready - b.ready);
		const chosen = ready[0]!;
		const at = clearOf(transitions, slot);
		const lanes = [...chosen.lanes];
		const arrivals = [...chosen.arrivals];
		// Waiting accents of the same kind join the one that plays.
		for (const group of ready) {
			if (group === chosen || group.kind !== chosen.kind) continue;
			group.lanes.forEach((lane, i) => {
				if (lanes.includes(lane)) return;
				lanes.push(lane);
				arrivals.push(group.arrivals[i]!);
			});
		}
		acts.push({ kind: chosen.kind, at, ms: ACTS[chosen.kind].ms, cause: chosen.at, lanes, arrivals });
		for (const group of ready) if (group === chosen || group.kind === chosen.kind) pending.splice(pending.indexOf(group), 1);
		free = at + BIG_GAP_MS;
	}
	// The cut: a wait stops whatever plays when it begins, and what was recorded before it but not played yet is dropped.
	const waits = acts.filter(act => act.kind === "waiting").map(act => act.at);
	const kept = acts.filter(act => act.kind === "waiting" || !waits.some(wait => act.cause < wait && act.at >= wait));
	for (const wait of waits) for (const act of kept) if (act.kind !== "waiting" && act.at < wait && act.at + act.ms > wait) act.ms = wait - act.at;
	return kept.sort((a, b) => a.at - b.at || ACTS[a.kind].priority - ACTS[b.kind].priority);
}

let memo: { key: readonly unknown[]; plan: StagePlan } | undefined;

/** The input a plan depends on; compared by identity so a live snapshot that only advanced `now` reuses the plan. */
function keyOf(snapshot: LaneSnapshot): unknown[] {
	const key: unknown[] = [snapshot.phases, snapshot.rounds, snapshot.milestones, snapshot.complete, snapshot.budgetWarnAt, snapshot.lanes.length];
	for (const lane of snapshot.lanes) key.push(lane.spans, lane.intent, lane.unscoped, lane.steeredAt, lane.stoppedAt, lane.judgedAt, lane.pieces === undefined);
	return key;
}

/** The whole stage timeline of a snapshot; independent of `now`, so it is computed once per change of the record. */
export function stagePlan(snapshot: LaneSnapshot): StagePlan {
	const key = keyOf(snapshot);
	if (memo !== undefined && memo.key.length === key.length && memo.key.every((value, i) => value === key[i])) return memo.plan;
	const { segments, transitions } = speciesTimeline(snapshot);
	const plan: StagePlan = { segments, transitions, acts: schedule(snapshot, transitions) };
	memo = { key, plan };
	return plan;
}

/**
 * The stage at run time `now`. With `motion` false the moment is a still one: no transition, no act and no gathering,
 * only the cast of who works and the light, so the species and the state read from one frame that stays true until the
 * record changes.
 */
export function stageAt(snapshot: LaneSnapshot, now: number = snapshot.now, motion = true): StageMoment {
	const plan = stagePlan(snapshot);
	let cast = plan.segments[0]?.cast ?? castAt(snapshot, now);
	for (const segment of plan.segments) {
		if (segment.from > now) break;
		cast = segment.cast;
	}
	const dim = snapshot.budgetWarnAt !== undefined && snapshot.budgetWarnAt <= now;
	if (!motion) {
		const still = stillCastAt(snapshot, now, cast);
		return { cast: still, species: still.species, acts: [], dim };
	}
	let species = plan.segments[0]?.cast.species ?? cast.species;
	let transition: StageMoment["transition"];
	for (const item of plan.transitions) {
		if (item.at > now) break;
		species = item.to;
		transition = now < item.at + item.ms ? { from: item.from, to: item.to, kind: item.kind, progress: (now - item.at) / item.ms } : undefined;
	}
	const acts: StageMoment["acts"][number][] = [];
	for (const act of plan.acts) {
		if (act.at > now) break;
		if (now >= act.at + act.ms) continue;
		const lanes = act.lanes.filter((_, i) => act.arrivals[i]! <= now);
		acts.push({ act, lanes, progress: (now - act.at) / act.ms });
	}
	return { cast, species, ...(transition === undefined ? {} : { transition }), acts, dim };
}

/** Whether anything on the stage still plays at `now`: a transition, an act or a gathering. */
export function stageBusy(snapshot: LaneSnapshot, now: number = snapshot.now): boolean {
	const moment = stageAt(snapshot, now, true);
	return moment.transition !== undefined || moment.acts.some(item => item.act.kind !== "waiting") || moment.cast.rule === "gather";
}
