/**
 * Who is on the stage: the species, its pose and its phrase, read from the lane view's input at one moment. Pure: the
 * same snapshot and moment give the same cast, and nothing here is stored or decides anything about the run.
 *
 * The first matching row of `docs/stage.md` "종 고르기" wins:
 *   1 waiting-user   keep the species, the waiting pose          응답을 기다리는 중
 *   2 stopping       keep the species, the finale or lights-out  마무리 중
 *   3 gather         a start, resume or replan just happened      팀을 모으는 중      (starling, once)
 *   4 review         a busy lane is being reviewed, or a review lane's worker runs           (orca)
 *   5 serial         a job runs, or one unscoped writer runs while another write lane waits  (ant)
 *   6 survey         every busy lane only reads                                               (bee)
 *   7 split          reads and writes mixed, or several writers                               (octopus)
 *   8 solo           no worker is busy: the director's turn alone                             (owl)
 * A single busy writer with nobody waiting matches neither 5 nor 7 by the letter; it is still a worker doing the work
 * the director handed out, so it gets row 7's octopus (with one arm).
 */
import type { RunPhase } from "../appearance.ts";
import type { LaneIntent, LaneSnapshot, LaneState, LaneTrack } from "../lane/model.ts";

export type Species = "octopus" | "bee" | "ant" | "orca" | "owl" | "starling";
export type CastRule = "waiting-user" | "stopping" | "gather" | "review" | "serial" | "survey" | "split" | "solo";
/** The director's pose: at work, waiting for the user, the finale of a complete run, the lights-out of one with work left. */
export type StagePose = "work" | "gather" | "waiting-user" | "finale" | "lights-out";
export interface Cast { rule: CastRule; species: Species; pose: StagePose; phrase: string }

/** The species' Korean names, as the one-line phrase says them. */
export const SPECIES_NAME: Readonly<Record<Species, string>> = {
	octopus: "문어", bee: "꿀벌", ant: "개미", orca: "범고래", owl: "올빼미", starling: "찌르레기",
};
/** What each row of the table says; only what the record proves. */
export const CAST_PHRASE: Readonly<Record<CastRule, string>> = {
	"waiting-user": "응답을 기다리는 중",
	stopping: "마무리 중",
	gather: "팀을 모으는 중",
	review: "검토하는 중",
	serial: "하나씩 처리하는 중",
	survey: "여러 갈래 조사 중",
	split: "일을 나눠 맡기는 중",
	solo: "직접 들여다보는 중",
};
/** How long the starlings gather after a start, resume or replan. */
export const GATHER_MS = 2400;

/** A lane's state at run time `at`; undefined before the lane appeared. */
export function stateAt(lane: LaneTrack, at: number): LaneState | undefined {
	const spans = lane.spans;
	if (spans.length === 0 || spans[0]!.from > at) return undefined;
	for (let i = spans.length - 1; i >= 0; i--) if (spans[i]!.from <= at) return spans[i]!.state;
	return undefined;
}

/** The phase at run time `at`. */
export function phaseAt(snapshot: LaneSnapshot, at: number): RunPhase {
	const phases = snapshot.phases;
	for (let i = phases.length - 1; i >= 0; i--) if (phases[i]!.from <= at) return phases[i]!.phase;
	return phases[0]?.phase ?? "working";
}

export function intentOf(lane: LaneTrack): LaneIntent {
	return lane.intent ?? (lane.job === true ? "job" : "write");
}

/** A lane whose worker (or job) is busy, or whose submission is being reviewed: "도는 레인". */
export function busyState(state: LaneState | undefined): boolean {
	return state === "running" || state === "quiet" || state === "reviewing";
}

/** The rows 4 to 8: who works at `at`, without the phase and the gathering. */
function workCast(snapshot: LaneSnapshot, at: number): { rule: CastRule; species: Species } {
	let busy = 0;
	let reads = 0;
	let writers = 0;
	let unscopedWriters = 0;
	let writeWaiting = false;
	let review = false;
	let job = false;
	for (const lane of snapshot.lanes) {
		const state = stateAt(lane, at);
		const intent = intentOf(lane);
		if ((state === "reserved" || state === "waiting") && intent === "write") writeWaiting = true;
		if (!busyState(state)) continue;
		busy++;
		if (state === "reviewing" || intent === "review") review = true;
		else if (intent === "job") job = true;
		else if (intent === "read") reads++;
		else {
			writers++;
			if (lane.unscoped === true) unscopedWriters++;
		}
	}
	if (busy === 0) return { rule: "solo", species: "owl" };
	if (review) return { rule: "review", species: "orca" };
	if (job || (writers === 1 && unscopedWriters === 1 && writeWaiting)) return { rule: "serial", species: "ant" };
	if (reads === busy) return { rule: "survey", species: "bee" };
	return { rule: "split", species: "octopus" };
}

/** The latest gathering that has begun by `at`, when it still plays. */
export function gatheringAt(snapshot: LaneSnapshot, at: number): number | undefined {
	const milestones = snapshot.milestones ?? [];
	for (let i = milestones.length - 1; i >= 0; i--) {
		const from = milestones[i]!.at;
		if (from <= at) return at < from + GATHER_MS ? from : undefined;
	}
	return undefined;
}

/**
 * The cast at run time `at`. `held` is the species on stage before a waiting or stopping phase began (rows 1 and 2
 * keep it); without one those rows keep what the workers would show. `team` is the last species that had workers on
 * stage: when the last lane settles the owl takes over (row 8), but the run's finale or lights-out belongs to the
 * team that did the work, so stopping plays it with `team` when there is one.
 */
export function castAt(snapshot: LaneSnapshot, at: number, held?: Species, team?: Species): Cast {
	const phase = phaseAt(snapshot, at);
	if (phase === "waiting-user" || phase === "stopping") {
		const rule: CastRule = phase;
		const species = (phase === "stopping" ? team ?? held : held) ?? workCast(snapshot, at).species;
		const pose: StagePose = phase === "waiting-user" ? "waiting-user" : snapshot.complete ? "finale" : "lights-out";
		return { rule, species, pose, phrase: CAST_PHRASE[rule] };
	}
	if (gatheringAt(snapshot, at) !== undefined) return { rule: "gather", species: "starling", pose: "gather", phrase: CAST_PHRASE.gather };
	const work = workCast(snapshot, at);
	return { ...work, pose: "work", phrase: CAST_PHRASE[work.rule] };
}

/**
 * The cast a still picture shows: `castAt` without the gathering. The gathering is a moment, not a state, and a still
 * frame (motion off) is redrawn only when the record changes, so a gathering drawn into it would stay on screen long
 * after it ended.
 */
export function stillCastAt(snapshot: LaneSnapshot, at: number, cast: Cast = castAt(snapshot, at)): Cast {
	if (cast.rule !== "gather") return cast;
	const work = workCast(snapshot, at);
	return { ...work, pose: "work", phrase: CAST_PHRASE[work.rule] };
}

/** The one-line form (T4): `문어 · 일을 나눠 맡기는 중`. */
export function castLine(cast: Pick<Cast, "species" | "phrase">): string {
	return `${SPECIES_NAME[cast.species]} · ${cast.phrase}`;
}
