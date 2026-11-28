/**
 * Where everyone stands on the stage at one moment: the director, one individual per lane (up to a cap, the rest as a
 * swarm with `+N`), one piece per result id, the starling flock and the weather. Positions are in dots of the stage
 * area (2 by 4 per cell), so every rasteriser (braille now, cells and pixels later) places the same scene.
 *
 * Input is the lane view's snapshot and the sequencer's moment only; the same input and loop time give the same scene.
 */
import type { LaneSnapshot, LaneState, LaneTrack } from "../lane/model.ts";
import type { RunResultState } from "../../types.ts";
import { busyState, castAt, GATHER_MS, intentOf, phaseAt, type Species, stateAt } from "./cast.ts";
import { sequenceId, type SequenceId, type SequenceMeta, type StageAssets, T1_CELL_PX } from "./assets.ts";
import { STAGE_ASSETS } from "./baked.ts";
import { HANDOFF_MS, type StageMoment } from "./sequencer.ts";
import { hash, lerp, smooth } from "../lane/effects/math.ts";

/** The loop time a still picture is drawn at. */
export const STAGE_STILL_T = 1700;

export interface StageIndividual {
	/** Index into `snapshot.lanes`; -1 for the director. */
	lane: number;
	seq: SequenceId;
	/** Time into the sequence. */
	t: number;
	x: number;
	y: number;
	/** 0..1: how much of it shows (transitions, the lights going out). */
	alpha: number;
	state?: LaneState;
	/** A frozen individual with a red edge: blocked or refused. */
	blocked?: true;
	/** A short flash: the lane's acceptance plays. */
	flash?: number;
	/** The director faces the user: the amber blink of waiting. */
	amber?: true;
	/** Mirrored left to right: the individual moves left and its art faces right. */
	flip?: true;
}
export interface StagePiece { id: string; lane: number; x: number; y: number; state: RunResultState; excluded: boolean; alpha: number }
export interface StageBolt { x: number; y: number; progress: number }
export interface StageBurst { x: number; y: number; progress: number; lane: number; kind: "accept" | "start" }
export interface StageArm { lane: number; from: { x: number; y: number }; control: { x: number; y: number }; to: { x: number; y: number }; alpha: number }
/** How far from the body's centre, in dots, an arm leaves it. */
const ARM_SOCKET = 4;

/**
 * How one species' world gives way to the next (`docs/stage.md` "종 전환"): water rising from below, the scene
 * sinking into a soil section, a sweep across, the owl's light spreading from its middle, a dim as the others leave,
 * or a plain fade (a short-lived species, the starlings).
 */
export type ChangeStyle = "rise" | "sink" | "sweep" | "radial" | "dim" | "fade";
export interface StageChange { from: Species; to: Species; progress: number; style: ChangeStyle }

/** The table's transitions; a pair it does not name sweeps. */
export function changeStyle(from: Species, to: Species): ChangeStyle {
	if (from === "starling" || to === "starling") return "fade";
	if (to === "owl") return "dim";
	if (from === "owl") return "radial";
	if ((from === "bee" && to === "octopus") || (from === "ant" && to === "orca")) return "rise";
	if (from === "octopus" && to === "ant") return "sink";
	return "sweep";
}
export interface StageScene {
	species: Species;
	/** Stage size in dots. */
	width: number;
	height: number;
	individuals: readonly StageIndividual[];
	pieces: readonly StagePiece[];
	/** Lanes beyond the cap. */
	swarm?: { x: number; y: number; count: number; lanes: readonly number[] };
	flock: readonly { x: number; y: number; lane: number }[];
	bolts: readonly StageBolt[];
	bursts: readonly StageBurst[];
	/**
	 * The octopus's arms: a glowing curve from a socket on the body to each arm tip (the lane's individual), drawn by
	 * the renderer like a lane's line. The key frames are the tip's and the body's poses; the arm between is code.
	 */
	arms: readonly StageArm[];
	/** The round wipe's dot x. */
	wipe?: number;
	/** 0..1 of the finale's rainbow. */
	rainbow?: number;
	/** 0..1: how many workers are busy, as rain. */
	rain: number;
	/** The light, 0..1: one step down past the budget's warning line. */
	light: number;
	/** Time into the background loop. */
	backgroundT: number;
	/** A species change in progress: the two backgrounds meet along the style's edge, `progress` of the way. */
	change?: StageChange;
}

/** At most this many lane individuals by stage width in cells; the rest gather as a swarm. */
export function individualCap(cols: number): number {
	return cols < 36 ? 6 : cols < 42 ? 7 : 8;
}

/** A slot; `flip` when the individual there moves left, so art drawn facing right is mirrored. */
interface Point { x: number; y: number; flip?: true }
interface Arrangement { director: Point; slots: Point[]; swarm: Point }

/** T1 pixels per dot: the art's measures below are in T1 pixels, the scene's in dots. */
const T1_PX_PER_DOT = T1_CELL_PX.w / 2;
/** The ant burrow's floor in the background art, above the stage's floor (the art's 90 px strip has it at y 77). */
export const ANT_FLOOR_PX = 13;
/** Below the anchor: an ant worker's feet (45x36 sprite, anchor 22,18) and the structure's base (72x63, anchor 36,57 on it). */
export const ANT_WORKER_FEET_PX = 12;
export const ANT_DIRECTOR_BASE_PX = 0;
/** The owl's branch top in its background art, above the stage's floor (y ≈ 68 of the 90 px strip under the owl). */
export const OWL_BRANCH_PX = 22;
/** Below the owl director's anchor (54x63 sprite, anchor 27,34): the top of its own branch under its feet. */
export const OWL_FEET_PX = 15.7;

/** The species' arrangement of a director and `n` individuals on a `w` by `h` dot stage. */
function arrange(species: Species, w: number, h: number, n: number, loopT: number): Arrangement {
	const slots: Point[] = [];
	const swarm = { x: w - 6, y: h - 4 };
	switch (species) {
		case "octopus": {
			// The body on the left, one arm tip per lane on an arc to the right.
			const director = { x: w * 0.24, y: h * 0.5 };
			for (let i = 0; i < n; i++) {
				const a = ((-70 + (140 * (i + 0.5)) / Math.max(1, n)) * Math.PI) / 180;
				slots.push({ x: director.x + w * 0.52 * Math.cos(a), y: director.y + h * 0.4 * Math.sin(a) });
			}
			return { director, slots, swarm };
		}
		case "bee": {
			// The hive on the left, bees over the flowers in two rows.
			const director = { x: w * 0.13, y: h * 0.5 };
			for (let i = 0; i < n; i++) {
				const x = w * 0.36 + ((w * 0.56) * (i + 0.5)) / Math.max(1, n);
				slots.push({ x, y: i % 2 === 0 ? h * 0.3 : h * 0.68 });
			}
			return { director, slots, swarm };
		}
		case "ant": {
			// The structure on the left, the column along the ground: busy ants lead, waiting ones queue behind. They
			// stand on the burrow floor of the background art, a fixed distance above the stage's floor at any height.
			const director = { x: w * 0.13, y: h - (ANT_FLOOR_PX + ANT_DIRECTOR_BASE_PX) / T1_PX_PER_DOT };
			const feet = h - (ANT_FLOOR_PX + ANT_WORKER_FEET_PX) / T1_PX_PER_DOT;
			for (let i = 0; i < n; i++) slots.push({ x: w * 0.32 + ((w * 0.62) * i) / Math.max(1, n), y: feet });
			return { director, slots, swarm };
		}
		case "orca": {
			// The target in the middle, the pod circling it; the lead changes about every six seconds.
			const director = { x: w * 0.5, y: h * 0.5 };
			const turn = (loopT / 12_000) * Math.PI * 2;
			for (let i = 0; i < n; i++) {
				const a = turn + (Math.PI * 2 * i) / Math.max(1, n);
				// The angle grows, so a slot on the lower half (sin > 0, y down) swims left.
				slots.push({ x: director.x + w * 0.36 * Math.cos(a), y: director.y + h * 0.34 * Math.sin(a), ...(Math.sin(a) > 0 ? { flip: true as const } : {}) });
			}
			return { director, slots, swarm };
		}
		case "owl":
			// The owl sits on the background's branch, a fixed distance above the floor like the ants.
			return { director: { x: w * 0.5, y: h - (OWL_BRANCH_PX + OWL_FEET_PX) / T1_PX_PER_DOT }, slots: [], swarm };
		case "starling":
			return { director: { x: w * 0.5, y: h * 0.5 }, slots: [], swarm };
	}
}

const LANE_POSE: Readonly<Record<LaneState, string>> = {
	reserved: "ready", waiting: "ready", running: "work", quiet: "quiet", submitted: "submit", reviewing: "review",
	accepted: "accepted", unmet: "unmet", blocked: "blocked", refused: "blocked", excluded: "excluded", idle: "rest",
};
/** A worker's poses beyond its lane state's: the settled phases, a handoff's leaving and arriving, the user's acts. */
const WORKER_EXTRA_POSES = ["waiting-user", "finale", "lights-out", "excluded", "gather", "user-steer", "user-stop"] as const;
/** Every pose a director can be asked for (the owl also `edit`; the starlings only gather). */
const DIRECTOR_POSES = ["work", "rest", "waiting-user", "finale", "lights-out", "excluded", "gather"] as const;

/**
 * Every sequence the scene can ask for of a species: what the art for it must hold. The owl has no workers (it stands
 * alone); the starlings are a lead bird and a flock of `fly` birds. Every species has a background.
 */
export function requestableSequences(species: Species): SequenceId[] {
	const ids: SequenceId[] = [sequenceId(species, "fx", "background")];
	if (species === "starling") return [...ids, sequenceId(species, "director", "gather"), sequenceId(species, "worker", "fly")];
	for (const pose of DIRECTOR_POSES) ids.push(sequenceId(species, "director", pose));
	if (species === "owl") return [...ids, sequenceId(species, "director", "edit")];
	for (const pose of new Set<string>([...Object.values(LANE_POSE), ...WORKER_EXTRA_POSES])) ids.push(sequenceId(species, "worker", pose));
	return ids;
}
/** Which lanes stand on stage first: busy ones, then those that need an eye, then the rest; finished ones last. */
const SHOW_RANK: Readonly<Record<LaneState, number>> = {
	running: 0, quiet: 0, reviewing: 0, blocked: 1, unmet: 1, submitted: 1, refused: 1, reserved: 2, waiting: 2, idle: 2, accepted: 3, excluded: 3,
};

/** The pieces of a lane: its result ids, or (scripted tracks) its progress counted out. */
function piecesOf(lane: LaneTrack): { id: string; state: RunResultState; excluded: boolean }[] {
	if (lane.pieces !== undefined) return lane.pieces.map(piece => ({ id: piece.id, state: piece.state, excluded: piece.excluded === true }));
	if (lane.progress === undefined) return [];
	const state = lane.spans[lane.spans.length - 1]?.state;
	return Array.from({ length: lane.progress.total }, (_, i) => ({
		id: `${lane.name}#${i + 1}`,
		state: i < lane.progress!.met ? "accepted" : state === "submitted" || state === "reviewing" ? "reviewable" : state === "unmet" ? "unmet" : "pending",
		excluded: false,
	}));
}

interface Layout {
	species: Species;
	arrangement: Arrangement;
	shown: number[];
	slotOf: Map<number, number>;
	hidden: number[];
}

/**
 * Moves a place so the sprite drawn there (its box around its anchor) stays inside the `w` by `h` picture. A sprite
 * taller or wider than the picture keeps its top or left edge in. Sequences that leap out on purpose (an orca's breach)
 * do so inside their own frames; this only fits the place they leap from.
 */
function fit(point: Point, meta: SequenceMeta | undefined, w: number, h: number): Point {
	if (meta === undefined) return point;
	const above = meta.anchor.y / T1_PX_PER_DOT;
	const below = (meta.size.h - meta.anchor.y) / T1_PX_PER_DOT;
	// A sprite may be mirrored, so either side of the anchor can be its wide side.
	const side = Math.max(meta.anchor.x, meta.size.w - meta.anchor.x) / T1_PX_PER_DOT;
	const y = above + below >= h ? above : Math.min(h - below, Math.max(above, point.y));
	const x = 2 * side >= w ? side : Math.min(w - side, Math.max(side, point.x));
	return { ...point, x, y };
}

/** A sprite's box in dots around its anchor at `at`; undefined without art. */
interface Box { x0: number; y0: number; x1: number; y1: number }
function boxAround(at: Point, meta: SequenceMeta | undefined): Box | undefined {
	if (meta === undefined) return undefined;
	const x0 = at.x - meta.anchor.x / T1_PX_PER_DOT;
	const y0 = at.y - meta.anchor.y / T1_PX_PER_DOT;
	return { x0, y0, x1: x0 + meta.size.w / T1_PX_PER_DOT, y1: y0 + meta.size.h / T1_PX_PER_DOT };
}

/** How far, in dots, a piece keeps from the director's box (a piece is drawn about a dot and a half wide). */
const PIECE_CLEARANCE = 1;

/**
 * A piece's place moved just outside `box` when it falls on it: to the nearer side, else above or below, whichever is
 * inside the `w` by `h` picture. A place clear of the box is only kept inside the picture.
 */
function clearOf(p: Point, box: Box | undefined, w: number, h: number): Point {
	const inside = (q: Point): Point => ({ x: Math.min(w - 1.5, Math.max(0.5, q.x)), y: Math.min(h - 0.5, Math.max(0.5, q.y)) });
	const q = inside(p);
	if (box === undefined) return q;
	const m = PIECE_CLEARANCE;
	const hit = (r: Point): boolean => r.x + 1.5 > box.x0 - m && r.x < box.x1 + m && r.y + 0.5 > box.y0 - m && r.y - 0.5 < box.y1 + m;
	if (!hit(q)) return q;
	const options = [
		{ x: box.x0 - m - 1.5, y: q.y },
		{ x: box.x1 + m, y: q.y },
		{ x: q.x, y: box.y1 + m + 0.5 },
		{ x: q.x, y: box.y0 - m - 0.5 },
	]
		.filter(r => r.x >= 0.5 && r.x <= w - 1.5 && r.y >= 0.5 && r.y <= h - 0.5)
		.sort((a, b) => Math.hypot(a.x - q.x, a.y - q.y) - Math.hypot(b.x - q.x, b.y - q.y));
	return options[0] ?? q;
}

/** The owl's `j`-th piece left to look at: a row under its box, or alternately left and right of it on the branch. */
function owlRow(j: number, box: Box | undefined, at: Point, h: number): Point {
	if (box === undefined) return { x: at.x - 10 + ((j * 3) % 20), y: h - 3 };
	if (box.y1 + PIECE_CLEARANCE + 1 <= h - 0.5) return { x: (box.x0 + box.x1) / 2 - 6 + ((j * 3) % 12), y: box.y1 + PIECE_CLEARANCE + 0.5 };
	const side = j % 2 === 0 ? -1 : 1;
	const step = 2 + 2.5 * Math.floor(j / 2);
	return { x: side < 0 ? box.x0 - PIECE_CLEARANCE - step : box.x1 + PIECE_CLEARANCE + step - 1.5, y: box.y1 - 2 };
}

function layoutOf(snapshot: LaneSnapshot, species: Species, w: number, h: number, cols: number, now: number, loopT: number, assets: StageAssets): Layout {
	const present: number[] = [];
	snapshot.lanes.forEach((lane, i) => { if (stateAt(lane, now) !== undefined) present.push(i); });
	let shown: number[] = [];
	let hidden: number[] = [];
	if (species !== "owl" && species !== "starling") {
		const cap = individualCap(cols);
		const ranked = [...present].sort((a, b) => SHOW_RANK[stateAt(snapshot.lanes[a]!, now)!] - SHOW_RANK[stateAt(snapshot.lanes[b]!, now)!] || a - b);
		shown = ranked.slice(0, cap);
		hidden = ranked.slice(cap);
		// The ant column puts busy ants first; every other species keeps lanes in plan order so a lane keeps its place.
		if (species === "ant") shown.sort((a, b) => Number(!busyState(stateAt(snapshot.lanes[a]!, now))) - Number(!busyState(stateAt(snapshot.lanes[b]!, now))) || a - b);
		else shown.sort((a, b) => a - b);
	}
	const placed = arrange(species, w, h, shown.length, loopT);
	// The starlings' flock is dots; every other species' director and individuals keep their sprites inside the picture.
	const arrangement: Arrangement = species === "starling"
		? placed
		: {
			director: fit(placed.director, assets.meta(sequenceId(species, "director", "work")), w, h),
			slots: placed.slots.map(slot => fit(slot, assets.meta(sequenceId(species, "worker", "work")), w, h)),
			swarm: placed.swarm,
		};
	const slotOf = new Map<number, number>();
	shown.forEach((lane, slot) => slotOf.set(lane, slot));
	return { species, arrangement, shown, slotOf, hidden };
}

/** Where a lane stands in a layout: its slot, the swarm, or (owl, starling) beside the director. */
function laneSpot(layout: Layout, lane: number): Point {
	const slot = layout.slotOf.get(lane);
	if (slot !== undefined) return layout.arrangement.slots[slot]!;
	if (layout.species === "owl" || layout.species === "starling") return { x: layout.arrangement.director.x + 8, y: layout.arrangement.director.y + 4 };
	return layout.arrangement.swarm;
}

export interface StageSceneInput {
	snapshot: LaneSnapshot;
	moment: StageMoment;
	/** Stage size in cells (the picture's rows only). */
	cols: number;
	rows: number;
	/** Loop time in ms (animation time); ignored without motion. */
	t: number;
	motion: boolean;
	/** The art the sprites come from: their boxes keep the individuals inside the picture. */
	assets?: StageAssets;
}

export function stageScene(input: StageSceneInput): StageScene {
	const { snapshot, moment, cols, rows, motion } = input;
	const now = snapshot.now;
	const w = cols * 2;
	const h = rows * 4;
	const cast = moment.cast;
	const species = moment.species;
	// Loops play only while the team works; waiting, stopping and a still picture hold one fixed moment.
	const loopT = motion && (cast.pose === "work" || cast.pose === "gather") ? input.t : STAGE_STILL_T;
	const assets = input.assets ?? STAGE_ASSETS;
	const layout = layoutOf(snapshot, species, w, h, cols, now, loopT, assets);
	// A handoff moves everyone from the old arrangement to the new one; a crossfade only fades.
	const transition = moment.transition;
	const from = transition === undefined ? undefined : layoutOf(snapshot, transition.from, w, h, cols, now, loopT, assets);
	const blend = transition === undefined ? 1 : smooth(transition.progress);
	const moving = transition?.kind === "handoff" ? blend : 1;
	// During a handoff the leaving species retreats and the arriving one gathers, each with its own sequence; the
	// starlings keep their flock.
	const handoffT = transition?.kind === "handoff" ? transition.progress * HANDOFF_MS : undefined;
	const leaving = handoffT === undefined || transition?.from === "starling" ? undefined : { pose: "excluded", t: handoffT };
	const arriving = handoffT === undefined || species === "starling" ? undefined : { pose: "gather", t: handoffT };
	const spot = (lane: number): Point => {
		const to = laneSpot(layout, lane);
		if (from === undefined) return to;
		const was = laneSpot(from, lane);
		return { x: lerp(was.x, to.x, moving), y: lerp(was.y, to.y, moving) };
	};
	const directorAt = (l: Layout | undefined): Point => {
		const to = (l ?? layout).arrangement.director;
		if (l !== undefined || from === undefined) return to;
		const was = from.arrangement.director;
		return { x: lerp(was.x, to.x, moving), y: lerp(was.y, to.y, moving) };
	};

	const accepting = new Map<number, number>();
	const unmetting = new Map<number, number>();
	const bolts: StageBolt[] = [];
	const bursts: StageBurst[] = [];
	let wipe: number | undefined;
	let rainbow: number | undefined;
	let flinch = 0;
	/** Lanes whose worker plays the user's turn or stop right now, with the time into it. */
	const userActs = new Map<number, { pose: string; t: number }>();
	for (const { act, lanes, progress } of moment.acts) {
		if (act.kind === "accept") for (const lane of lanes) accepting.set(lane, progress);
		if (act.kind === "unmet") for (const lane of lanes) unmetting.set(lane, progress);
		if (act.kind === "blocked") {
			flinch = Math.max(flinch, 1 - progress);
			for (const lane of lanes) {
				const at = spot(lane);
				bolts.push({ x: at.x, y: at.y, progress });
			}
		}
		if (act.kind === "start") for (const lane of lanes) bursts.push({ ...spot(lane), progress, lane, kind: "start" });
		if (act.kind === "accept") bursts.push({ ...directorAt(undefined), progress, lane: lanes[0] ?? -1, kind: "accept" });
		if (act.kind === "round") wipe = progress * w;
		if (act.kind === "finale") rainbow = progress;
		if (act.kind === "user-steer" || act.kind === "user-stop") for (const lane of lanes) userActs.set(lane, { pose: act.kind, t: progress * act.ms });
	}
	// A still picture of a complete run shows its rainbow; a moving one draws it while the finale plays and keeps it.
	if (cast.pose === "finale" && (rainbow === undefined || !motion)) rainbow = 1;

	const individuals: StageIndividual[] = [];
	// While the director edits a file itself the owl re-grips its piece; between rounds the director rests (the owl
	// half-closes its eyes); otherwise it holds the cast's pose. Other species' directors do not show the edit.
	const directorPoseOf = (sp: Species): string => {
		if (cast.pose === "gather") return "work";
		if (cast.pose !== "work") return cast.pose;
		if (sp === "owl" && snapshot.directorEditing === true) return "edit";
		return phaseAt(snapshot, now) === "between-rounds" ? "rest" : "work";
	};
	const addDirector = (l: Layout, alpha: number, override?: { pose: string; t: number }): void => {
		if (alpha <= 0) return;
		const at = l.arrangement.director;
		const pose = override?.pose ?? (l.species === "starling" ? "gather" : directorPoseOf(l.species));
		individuals.push({
			lane: -1,
			seq: sequenceId(l.species, "director", pose),
			t: override?.t ?? (pose === "work" ? loopT : motion ? Math.max(0, now - phaseStart(snapshot)) : 1e9),
			x: at.x + (motion ? flinch * 1.5 * Math.sin(loopT / 30) : 0),
			y: at.y,
			alpha,
			...(cast.pose === "waiting-user" ? { amber: true as const } : {}),
		});
	};
	const addWorkers = (l: Layout, alpha: number, move: boolean, override?: { pose: string; t: number }): void => {
		if (alpha <= 0) return;
		for (const lane of l.shown) {
			const track = snapshot.lanes[lane]!;
			const state = stateAt(track, now)!;
			const span = track.spans[track.spans.length - 1]!;
			const settled = cast.pose === "waiting-user" ? "waiting-user" : cast.pose === "finale" ? "finale" : cast.pose === "lights-out" ? "lights-out" : undefined;
			const pose = override?.pose ?? userActs.get(lane)?.pose ?? settled ?? LANE_POSE[state];
			const loops = pose === "work" || pose === "quiet" || pose === "ready" || pose === "review" || pose === "rest";
			const speed = pose === "work" ? ((track.activity ?? 0.5) > 0.66 ? 1.25 : (track.activity ?? 0.5) > 0.33 ? 1 : 0.83) : 1;
			const local = override?.t ?? userActs.get(lane)?.t ?? (loops ? loopT * speed + (track.slot ?? lane) * 397 : motion ? Math.max(0, now - (settled === undefined ? span.from : phaseStart(snapshot))) : 1e9);
			const at = move ? spot(lane) : laneSpot(l, lane);
			const flash = accepting.get(lane);
			individuals.push({
				lane,
				seq: sequenceId(l.species, "worker", pose),
				t: local,
				x: at.x,
				y: at.y,
				alpha,
				state,
				...(state === "blocked" || state === "refused" ? { blocked: true as const } : {}),
				...(flash === undefined ? {} : { flash: 1 - flash }),
				...(laneSpot(l, lane).flip === true ? { flip: true as const } : {}),
			});
		}
	};
	const arms: StageArm[] = [];
	const addArms = (l: Layout, alpha: number, move: boolean): void => {
		if (alpha <= 0 || l.species !== "octopus") return;
		const body = directorAt(move ? undefined : l);
		l.shown.forEach((lane, i) => {
			const tip = move ? spot(lane) : laneSpot(l, lane);
			// Sockets spread along the lower right of the body, in the order of their tips (upper tips, upper sockets),
			// so several thick roots do not pile into one lump.
			const angle = ((-15 + (95 * (i + 0.5)) / l.shown.length) * Math.PI) / 180;
			const socket = { x: body.x + Math.cos(angle) * ARM_SOCKET, y: body.y + 2 + Math.sin(angle) * ARM_SOCKET * 0.7 };
			// The tip sprite takes the arm at its left edge heading right (slightly up), so the curve's last stretch runs
			// in from the left at the tip's height; the loop sways its middle a little.
			const sway = Math.sin(loopT / 900 + lane) * 0.6;
			const reach = Math.max(4, Math.abs(tip.x - socket.x) * 0.55);
			const control = { x: tip.x - reach, y: tip.y + 0.6 + sway };
			arms.push({ lane, from: socket, control, to: tip, alpha });
		});
	};
	if (from !== undefined) {
		addArms(from, 1 - blend, false);
		addDirector(from, 1 - blend, leaving);
		addWorkers(from, 1 - blend, false, leaving);
	}
	addArms(layout, blend, true);
	addDirector(layout, blend, arriving);
	addWorkers(layout, blend, true, arriving);

	// Pieces: accepted ones ring the director's result, the others stay with their lane. None covers the director: a
	// piece that would land on its sprite box is moved just outside it.
	const pieces: StagePiece[] = [];
	const ringCenter = directorAt(undefined);
	const box = boxAround(ringCenter, species === "starling" ? undefined : assets.meta(sequenceId(species, "director", "work")));
	const clear = (p: Point): Point => clearOf(p, box, w, h);
	let ringIndex = 0;
	let rowIndex = 0;
	const ringTotal = snapshot.lanes.reduce((sum, lane) => sum + piecesOf(lane).filter(piece => piece.state === "accepted" && !piece.excluded).length, 0);
	snapshot.lanes.forEach((lane, index) => {
		if (stateAt(lane, now) === undefined) return;
		const home = spot(index);
		piecesOf(lane).forEach((piece, k) => {
			let x: number;
			let y: number;
			if (piece.state === "accepted" && !piece.excluded) {
				const a = (Math.PI * 2 * ringIndex++) / Math.max(1, ringTotal) - Math.PI / 2;
				// The ring goes round the director's box (or a small ring when it has none).
				const rx = box === undefined ? Math.min(10, w * 0.12) : (box.x1 - box.x0) / 2 + 1.5;
				const ry = box === undefined ? Math.min(6, h * 0.3) : (box.y1 - box.y0) / 2 + 1;
				const cx = box === undefined ? ringCenter.x : (box.x0 + box.x1) / 2;
				const cy = box === undefined ? ringCenter.y : (box.y0 + box.y1) / 2;
				const target = clear({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
				const tx = target.x;
				const ty = target.y;
				// While its acceptance plays, the piece travels from the lane to the director.
				const travel = accepting.get(index);
				const p = travel === undefined ? 1 : smooth(travel * 1.6);
				x = lerp(home.x, tx, p);
				y = lerp(home.y, ty, p);
			} else {
				// Pieces carry their place over a species change: from where the leaving species held them to where the
				// arriving one does.
				const place = (sp: Species, at: Point): Point => {
					// The owl looks down at the pieces left: a row under it, or beside it on the branch when there is no room.
					if (sp === "owl") return owlRow(rowIndex, box, ringCenter, h);
					const lift = piece.state === "reviewable" ? -5 : 0;
					const bounce = unmetting.get(index);
					const kick = piece.state === "unmet" && bounce !== undefined ? 6 * Math.sin(bounce * Math.PI) : piece.state === "unmet" ? 3 : 0;
					return { x: at.x + 4 + k * 2 + kick, y: at.y + 3 + lift };
				};
				const to = clear(place(species, laneSpot(layout, index)));
				const was = from === undefined ? to : place(from.species, laneSpot(from, index));
				x = lerp(was.x, to.x, moving);
				y = lerp(was.y, to.y, moving);
				if (species === "owl") rowIndex++;
			}
			pieces.push({ id: piece.id, lane: index, x, y, state: piece.state, excluded: piece.excluded, alpha: piece.excluded ? 0.35 : 1 });
		});
	});

	const change: StageChange | undefined = transition === undefined
		? undefined
		: { from: transition.from, to: transition.to, progress: blend, style: transition.kind === "crossfade" ? "fade" : changeStyle(transition.from, transition.to) };
	const flock = species === "starling" || transition?.from === "starling" ? flockOf(snapshot, w, h, cols, now, motion, loopT, assets) : [];
	let busy = 0;
	for (const lane of snapshot.lanes) if (busyState(stateAt(lane, now)) && intentOf(lane) !== "job") busy++;
	const working = cast.pose === "work" || cast.pose === "gather";
	return {
		species,
		width: w,
		height: h,
		individuals,
		pieces,
		...(layout.hidden.length > 0 ? { swarm: { ...layout.arrangement.swarm, count: layout.hidden.length, lanes: layout.hidden } } : {}),
		flock,
		bolts,
		bursts,
		arms,
		...(wipe === undefined ? {} : { wipe }),
		...(rainbow === undefined ? {} : { rainbow }),
		rain: motion && working ? Math.min(1, busy / 6) : 0,
		light: (moment.dim ? 0.78 : 1) * (cast.pose === "lights-out" ? 0.7 : 1) * (change?.style === "dim" ? 1 - 0.3 * Math.sin(Math.PI * change.progress) : 1),
		backgroundT: loopT,
		...(change === undefined ? {} : { change }),
	};
}

function phaseStart(snapshot: LaneSnapshot): number {
	return snapshot.phases[snapshot.phases.length - 1]?.from ?? 0;
}

/**
 * The starlings: 60 to 120 dots. They start scattered and gather into one flock per lane plus the director's, where the
 * species that follows will stand; a replan first loosens the flocks into dots and then gathers them again.
 */
function flockOf(snapshot: LaneSnapshot, w: number, h: number, cols: number, now: number, motion: boolean, loopT: number, assets: StageAssets): { x: number; y: number; lane: number }[] {
	const milestones = snapshot.milestones ?? [];
	let milestone = milestones[0];
	for (const item of milestones) if (item.at <= now) milestone = item;
	const progress = !motion || milestone === undefined ? 1 : Math.min(1, Math.max(0, (now - milestone.at) / GATHER_MS));
	const next = castAt({ ...snapshot, milestones: [] }, now).species;
	const target = layoutOf(snapshot, next === "starling" ? "octopus" : next, w, h, cols, now, loopT, assets);
	const centres: { point: Point; lane: number }[] = [{ point: target.arrangement.director, lane: -1 }];
	target.shown.forEach(lane => centres.push({ point: laneSpot(target, lane), lane }));
	if (target.hidden.length > 0) centres.push({ point: target.arrangement.swarm, lane: target.hidden[0]! });
	const count = Math.round(Math.min(120, Math.max(60, (w * h) / 10)));
	const dots: { x: number; y: number; lane: number }[] = [];
	for (let k = 0; k < count; k++) {
		const centre = centres[k % centres.length]!;
		const home = { x: centre.point.x + (hash(k * 3 + 1) - 0.5) * 7, y: centre.point.y + (hash(k * 3 + 2) - 0.5) * 5 };
		const loose = { x: hash(k * 7 + 5) * w, y: hash(k * 7 + 6) * h };
		const p = milestone?.kind === "replan" ? (progress < 0.4 ? 1 - smooth(progress / 0.4) : smooth((progress - 0.4) / 0.6)) : smooth(progress);
		const swirl = motion ? Math.sin(loopT / 300 + k) * (1 - p) * 2 : 0;
		dots.push({ x: lerp(loose.x, home.x, p) + swirl, y: lerp(loose.y, home.y, p), lane: centre.lane });
	}
	return dots;
}
