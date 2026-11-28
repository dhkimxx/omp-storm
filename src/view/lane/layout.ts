/**
 * Layout of the lane view: a lane snapshot in, geometry out (strands, marks, labels). No colour, no drawing and no
 * animation time live here.
 *
 * Time axis: the picture covers the smallest step of LADDER_S that is at least 8% longer than the run so far, mapped
 * linearly onto the graph area, so the head ("now") sits between about 65% and 92% of its width.
 *
 * Rows: the trunk, then the shown lanes ordered by start time, then a summary row when lanes are folded. The height is
 * `maxRows` at most. When the lanes do not fit, `FOLD_RANK` and `foldsBefore` decide which ones go into the summary:
 * finished lanes first, then lanes that have not started, then (only when that is still not enough) lanes that wait for
 * a decision. Lanes that are working stay visible. Every lane keeps its index, so its hue and its marks do not move
 * when others fold.
 *
 * Routing (the "rake"):
 * - Lanes whose starts lie within GROUP_DOTS dots of the first start of a group share one stem: a vertical line that
 *   drops from the trunk at the group's first start. Every lane peels off to the right on its own row with a small
 *   quarter arc; the stem keeps going down past it to the next lane of the group. Peeling always goes right, so a
 *   group never crosses itself.
 * - A lane that starts later, outside every group window, gets its own stem at its own start. That stem passes the rows
 *   of lanes above it that are still running. Where it crosses one, the crossed lane is cut by a one-dot gap on each
 *   side of the stem: the stem passes over, the lane stays readable. Finished lanes have left the row by then.
 * - An accepted lane joins the trunk by the mirror of the peel: a small arc up at the end of its row, then one vertical
 *   straight to the trunk at the accept time. Crossed lanes above get the same gap. Joins that would land less than
 *   JOIN_GAP dots apart are pushed left so two verticals never merge into one smear.
 * - A dependency link is a vertical dotted strand at the moment the wait ended (or now, while it still lasts), from the
 *   prerequisite's row to the waiting lane's row. It is faint, so it crosses without gaps.
 */
import type { RunPhase } from "../appearance.ts";
import type { LaneSnapshot, LaneState, LaneTrack } from "./model.ts";
import { textWidth } from "./canvas.ts";
import type { Label, Mark, PathPoint, Scene, Strand } from "./scene.ts";

const LADDER_S = [30, 45, 60, 90, 120, 180, 300, 480, 720, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400, 21600, 28800, 43200, 86400];
/** Dot y of the trunk inside its row, and of a lane inside its row (rows are 4 dots tall). */
const TRUNK_Y = 1;
const LANE_Y_OFFSET = 1;
/** Size of the peel and join arcs in dots. */
const ARC = 3;
/** Lanes starting within this many dots of a group's first start share its stem. */
const GROUP_DOTS = 6;
/** Join columns closer than this are pushed apart. */
const JOIN_GAP = 2;
/** Spacing of the nodes on a job lane, in dots. */
const JOB_STEP = 10;

/** What the trunk row is called. */
export const TRUNK_LABEL = "감독";
/** The word a lane row ends with for each state. A retained acceptance says so rather than reading as applied work. */
export const STATE_WORD: Record<LaneState, string> = {
	reserved: "예약", waiting: "선행 대기", running: "작업 중", quiet: "조용", submitted: "제출", reviewing: "검토 중",
	accepted: "승인", unmet: "미충족", blocked: "막힘", excluded: "제외", idle: "유휴", refused: "거부",
};
/**
 * The accepted state's word when every accepted result was kept outside the parent (B7, §5). It says where the judged
 * source is; `부모 밖 보존` without the space is the longest form that still fits the narrow right column.
 */
export const RETAINED_STATE_WORD = "부모밖 보존";
const PHASE_WORDS: Record<RunPhase, readonly string[]> = {
	working: ["진행 중"],
	workers: ["워커 작업 중", "워커 작업"],
	"waiting-user": ["응답 대기"],
	verifying: ["검증 중"],
	"between-rounds": ["다음 라운드 대기", "다음 라운드", "다음 대기"],
	stopping: ["종료 정리 중", "종료 중"],
};
/**
 * How early a lane in this state folds into the summary row when the lanes do not fit: higher folds first.
 * Finished lanes (6), then lanes that have not started (5 reserved, 4 waiting), then lanes whose worker is idle or whose
 * result waits for a verdict (2), then lanes that need a person's eye (1), and last the lanes that are working (0).
 */
const FOLD_RANK: Record<LaneState, number> = {
	accepted: 6, excluded: 6, reserved: 5, waiting: 4, submitted: 2, idle: 2, blocked: 1, unmet: 1, running: 0, quiet: 0, reviewing: 0, refused: 7,
};
const FINISHED_RANK = 6;

// ---------------------------------------------------------------------------------------------------------------
// Text helpers (display width, not string length)
// ---------------------------------------------------------------------------------------------------------------

/** Cuts `text` to `width` display cells, ending in an ellipsis when something was cut. */
function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (textWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const char of text) {
		const w = textWidth(char);
		if (used + w > width - 1) break;
		out += char;
		used += w;
	}
	return `${out}…`;
}

/** Pads with spaces to `width` display cells (and never cuts). */
function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - textWidth(text)));
}

function fmtSpan(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	if (s < 5400) return `${Math.round(s / 60)}m`;
	return `${Math.round(s / 3600)}h`;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------------------------------------------

function niceSpan(now: number): number {
	for (const s of LADDER_S) if (s * 1000 >= now * 1.08) return s * 1000;
	return Math.ceil((now * 1.08) / 86_400_000) * 86_400_000;
}

function lastState(lane: LaneTrack): LaneState {
	return lane.spans[lane.spans.length - 1]!.state;
}

function isTerminal(state: LaneState): boolean {
	return state === "accepted" || state === "blocked" || state === "excluded" || state === "refused";
}

function phaseWord(phase: RunPhase, width: number): string {
	const words = PHASE_WORDS[phase];
	return words.find((w) => textWidth(w) <= width) ?? clip(words[words.length - 1]!, width);
}

/**
 * The lanes to fold, given the lanes that could be shown and the rows there are for them. `keep` lanes stay; the rest
 * go into the summary row. Finished lanes fold in the order they finished, every other kind folds latest-planned first,
 * so the lanes that stay are the ones that matter now and, among equals, the ones that come first in the plan.
 */
function chooseFolded(lanes: readonly LaneTrack[], candidates: readonly number[], keep: number): Set<number> {
	const rank = new Map<number, number>();
	const key = new Map<number, number>();
	for (const i of candidates) {
		const lane = lanes[i]!;
		const last = lane.spans[lane.spans.length - 1]!;
		const r = FOLD_RANK[last.state];
		rank.set(i, r);
		key.set(i, r === FINISHED_RANK ? last.from : -i);
	}
	const order = [...candidates].sort((a, b) => rank.get(b)! - rank.get(a)! || key.get(a)! - key.get(b)! || a - b);
	return new Set(order.slice(0, candidates.length - keep));
}

// ---------------------------------------------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------------------------------------------

interface Pt { x: number; y: number }

/** Rounds a parametric curve into dots, dropping repeats so consecutive points touch. */
function sample(n: number, at: (u: number) => Pt): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i <= n; i++) {
		const p = at(i / n);
		const q = { x: Math.round(p.x), y: Math.round(p.y) };
		const last = out[out.length - 1];
		if (last === undefined || last.x !== q.x || last.y !== q.y) out.push(q);
	}
	return out;
}

/** From (sx, yTop) heading down, turning to head right, ending at (sx + rx, yTop + ry). */
function peelArc(sx: number, yTop: number, rx: number, ry: number): Pt[] {
	return sample(4 * (rx + ry) + 2, (u) => {
		const a = (Math.PI / 2) * u;
		return { x: sx + rx * (1 - Math.cos(a)), y: yTop + ry * Math.sin(a) };
	});
}

/** From (xl, y) heading right, turning to head up, ending at (xl + rx, y - ry). */
function joinArc(xl: number, y: number, rx: number, ry: number): Pt[] {
	return sample(4 * (rx + ry) + 2, (u) => {
		const a = (Math.PI / 2) * u;
		return { x: xl + rx * Math.sin(a), y: y - ry * (1 - Math.cos(a)) };
	});
}

/** Spreads `at` linearly over a point list, from `from` to `to`. */
function ramp(points: readonly Pt[], from: number, to: number): PathPoint[] {
	const n = points.length;
	return points.map((p, i) => ({ x: p.x, y: p.y, at: n <= 1 ? to : Math.round(from + ((to - from) * i) / (n - 1)) }));
}

/** Cuts a lane's flat run where a vertical passes over it; a point at `keepX` is never cut (the head stays whole). */
function splitAtGaps(points: readonly PathPoint[], gapXs: readonly number[], keepX: number): PathPoint[][] {
	const pieces: PathPoint[][] = [];
	let piece: PathPoint[] = [];
	for (const p of points) {
		const cut = p.x !== keepX && gapXs.some((gx) => Math.abs(p.x - gx) <= 1);
		if (cut) {
			if (piece.length > 0) pieces.push(piece);
			piece = [];
		} else {
			piece.push(p);
		}
	}
	if (piece.length > 0) pieces.push(piece);
	return pieces;
}

// ---------------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------------

/** A vertical line that other lanes' rows are cut for. `members` are the lanes it belongs to and never cuts. */
interface Vertical { x: number; bottom: number; members: ReadonlySet<number> }

interface Placed {
	index: number;
	row: number;
	y: number;
	start: number;
	/** Peel point: the dot where the lane's own line begins. */
	xs: number;
	group: number;
}

export function layout(snapshot: LaneSnapshot, cols: number, maxRows: number): Scene {
	cols = Math.max(0, Math.floor(cols));
	// --- Areas --------------------------------------------------------------------------------------------------
	let rw = cols >= 100 ? 18 : cols >= 80 ? 14 : 11;
	let lw = clamp(Math.round(cols * 0.22), 16, 22);
	if (cols - lw - rw - 2 < 8) {
		lw = Math.max(4, Math.min(lw, cols - rw - 10));
		rw = Math.max(4, Math.min(rw, cols - lw - 10));
	}
	const cx0 = Math.min(lw + 1, Math.max(0, cols - 4));
	const cx1 = Math.min(cols, Math.max(cx0 + 4, cols - rw - 1));
	const x0 = cx0 * 2;
	const x1 = cx1 * 2 - 1;
	const wd = x1 - x0 + 1;

	const lanes = snapshot.lanes;
	const now = Number.isFinite(snapshot.now) ? Math.max(0, snapshot.now) : 0;
	const span = niceSpan(now);
	const X = (ms: number): number => x0 + clamp(Math.round((ms / span) * (wd - 1)), 0, wd - 1);
	const msAt = (x: number): number => ((x - x0) / (wd - 1)) * span;
	const headX = X(now);

	const lastPhase = snapshot.phases[snapshot.phases.length - 1];
	const phase: RunPhase = lastPhase?.phase ?? "working";
	const phaseAge = lastPhase === undefined ? 0 : Math.max(0, now - lastPhase.from);

	// --- Rows: shown lanes in start order, the rest folded ----------------------------------------------------------
	// A lane without spans has no history to draw: it is neither shown nor folded.
	const startOf = (i: number): number => Math.min(lanes[i]!.spans[0]!.from, now);
	const candidates: number[] = [];
	lanes.forEach((lane, i) => { if (lane.spans.length > 0) candidates.push(i); });
	const room = Math.max(0, maxRows - 1);
	let shown = candidates;
	let folded: number[] = [];
	if (room === 0) {
		shown = [];
	} else if (candidates.length > room) {
		const foldSet = chooseFolded(lanes, candidates, room - 1);
		shown = candidates.filter((i) => !foldSet.has(i));
		folded = candidates.filter((i) => foldSet.has(i));
	}
	shown = [...shown].sort((a, b) => startOf(a) - startOf(b) || a - b);
	const rowOf: number[] = lanes.map(() => -1);
	shown.forEach((laneIndex, r) => { rowOf[laneIndex] = r + 1; });
	const rows = maxRows < 1 ? 0 : 1 + shown.length + (folded.length > 0 ? 1 : 0);
	const yOf = (row: number): number => 4 * row + LANE_Y_OFFSET;
	const indexOfName = new Map<string, number>();
	lanes.forEach((lane, i) => { if (!indexOfName.has(lane.name)) indexOfName.set(lane.name, i); });

	const strands: Strand[] = [];
	const marks: Mark[] = [];
	const labels: Label[] = [];

	// --- Trunk and the width still to come ---------------------------------------------------------------------
	const trunkPoints: PathPoint[] = [];
	for (let x = x0; x <= headX; x++) trunkPoints.push({ x, y: TRUNK_Y, at: Math.min(Math.round(msAt(x)), now) });
	strands.push({ kind: "trunk", lane: -1, state: null, from: 0, to: now, open: true, points: trunkPoints });
	const futurePoints: PathPoint[] = [];
	for (let x = headX + 1; x <= x1; x++) futurePoints.push({ x, y: TRUNK_Y, at: Math.round(msAt(x)) });
	if (futurePoints.length > 0) strands.push({ kind: "future", lane: -1, state: null, from: now, to: span, open: false, points: futurePoints });

	// --- Groups, stems and peel points -----------------------------------------------------------------------------
	const placed = new Map<number, Placed>();
	const verticals: Vertical[] = [];
	let groupId = -1;
	let groupX = 0;
	let groupMembers: number[] = [];
	let prev: Placed | undefined;
	const closeGroup = (): void => {
		if (groupMembers.length === 0) return;
		const last = placed.get(groupMembers[groupMembers.length - 1]!)!;
		verticals.push({ x: groupX, bottom: last.y - ARC, members: new Set(groupMembers) });
	};
	for (const laneIndex of shown) {
		const row = rowOf[laneIndex]!;
		const y = yOf(row);
		const start = startOf(laneIndex);
		const first = groupId < 0 || X(start) - groupX > GROUP_DOTS;
		if (first) {
			closeGroup();
			groupId++;
			groupX = X(start);
			groupMembers = [];
			prev = undefined;
		}
		const rx = Math.max(0, Math.min(ARC, headX - groupX));
		const xs = groupX + rx;
		const here: Placed = { index: laneIndex, row, y, start, xs, group: groupId };
		placed.set(laneIndex, here);
		groupMembers.push(laneIndex);

		// The stem for this lane: down from the trunk (or from where the previous lane peeled), then the arc to the right.
		const yStart = prev === undefined ? TRUNK_Y : prev.y - ARC;
		const stem: Pt[] = [];
		for (let yy = yStart; yy <= y - ARC - 1; yy++) stem.push({ x: groupX, y: yy });
		stem.push(...peelArc(groupX, y - ARC, rx, ARC));
		const tFrom = prev === undefined ? start : prev.start;
		strands.push({
			kind: "stem", lane: laneIndex, state: lanes[laneIndex]!.spans[0]!.state, from: tFrom, to: start, open: false,
			points: ramp(stem, tFrom, start),
		});
		marks.push({ kind: "start", lane: laneIndex, cx: xs >> 1, cy: row, at: start });
		prev = here;
	}
	closeGroup();

	// --- Joins: accepted lanes climb to the trunk at their accept time ------------------------------------------------
	interface Join { xj: number; rx: number; xl: number }
	const joins = new Map<number, Join>();
	// A retained acceptance stays on its own lane: it was kept outside the target, never applied to the trunk (B7).
	const accepted = shown.filter((i) => lastState(lanes[i]!) === "accepted" && lanes[i]!.retained !== true)
		.sort((a, b) => lanes[b]!.spans[lanes[b]!.spans.length - 1]!.from - lanes[a]!.spans[lanes[a]!.spans.length - 1]!.from || b - a);
	const columns: number[] = [];
	for (const laneIndex of accepted) {
		const lane = lanes[laneIndex]!;
		const at = lane.spans[lane.spans.length - 1]!.from;
		const here = placed.get(laneIndex)!;
		let xj = Math.max(here.xs, X(at));
		while (columns.some((c) => Math.abs(c - xj) < JOIN_GAP) && xj - 1 > here.xs) xj--;
		columns.push(xj);
		const rx = Math.min(ARC, xj - here.xs);
		joins.set(laneIndex, { xj, rx, xl: xj - rx });
		verticals.push({ x: xj, bottom: here.y - ARC, members: new Set([laneIndex]) });
	}

	// --- Lanes: one strand per state span, plus joins, links and the marks of their events ------------------------
	for (const laneIndex of shown) {
		const lane = lanes[laneIndex]!;
		const here = placed.get(laneIndex)!;
		const { row, y, xs, start } = here;
		const lastSpan = lane.spans[lane.spans.length - 1]!;
		const terminal = isTerminal(lastSpan.state);
		const earlier = terminal ? lane.spans.slice(0, -1) : lane.spans;
		// A lane that was first seen already finished has no earlier span: its own end state stands for the stretch.
		const real = earlier.length > 0 ? earlier : [{ from: start, to: lastSpan.from, state: lastSpan.state }];
		const join = joins.get(laneIndex);
		const xEnd = join !== undefined ? join.xl : terminal ? clamp(X(lastSpan.from), xs, headX) : headX;
		const cap = terminal ? lastSpan.from : now;
		const atOf = (x: number): number => Math.round(clamp(msAt(x), start, Math.max(start, cap)));
		const gapXs = verticals.filter((v) => !v.members.has(laneIndex) && y > TRUNK_Y && y < v.bottom).map((v) => v.x);

		// Boundaries between the spans, in dots.
		let begin = xs;
		real.forEach((s, i) => {
			const isLast = i === real.length - 1;
			const end = isLast ? xEnd : clamp(X(s.to ?? cap), begin, xEnd);
			let a = i === 0 ? xs : begin + 1;
			if (a > end) {
				if (!isLast) return;
				a = end;
			}
			const points: PathPoint[] = [];
			for (let x = a; x <= end; x++) points.push({ x, y, at: atOf(x) });
			const pieces = splitAtGaps(points, gapXs, headX);
			pieces.forEach((piece, k) => {
				strands.push({
					kind: "lane", lane: laneIndex, state: s.state, from: s.from, to: s.to ?? cap,
					open: !terminal && isLast && k === pieces.length - 1, points: piece,
				});
			});
			if (a <= end) begin = end;
		});

		// The join: arc up, then straight to the trunk.
		if (join !== undefined) {
			const arcPts = joinArc(join.xl, y, join.rx, ARC);
			const climb: Pt[] = [];
			for (let yy = y - ARC - 1; yy >= TRUNK_Y; yy--) climb.push({ x: join.xj, y: yy });
			const from = atOf(join.xl);
			strands.push({
				kind: "join", lane: laneIndex, state: "accepted", from, to: lastSpan.from, open: false,
				points: ramp([...arcPts, ...climb], from, lastSpan.from),
			});
			marks.push({ kind: "accept", lane: laneIndex, cx: join.xj >> 1, cy: 0, at: lastSpan.from });
		}

		// Events along the row.
		for (const s of real) {
			if (s.state === "unmet") marks.push({ kind: "unmet", lane: laneIndex, cx: clamp(X(s.from), xs, xEnd) >> 1, cy: row, at: s.from });
		}
		if (lastSpan.state === "blocked") marks.push({ kind: "blocked", lane: laneIndex, cx: xEnd >> 1, cy: row, at: lastSpan.from });
		if (lastSpan.state === "excluded") marks.push({ kind: "excluded", lane: laneIndex, cx: xEnd >> 1, cy: row, at: lastSpan.from });
		if (!terminal) {
			marks.push({ kind: "head", lane: laneIndex, cx: headX >> 1, cy: row, at: now });
			if (lastSpan.state === "reviewing") marks.push({ kind: "review", lane: laneIndex, cx: headX >> 1, cy: row, at: lastSpan.from });
		}
		if (lane.job === true) {
			const done = lastSpan.state === "accepted";
			for (let x = xs + 2; x <= xEnd - 4; x += JOB_STEP) {
				marks.push({ kind: "job", lane: laneIndex, cx: x >> 1, cy: row, at: atOf(x), done });
			}
		}

		// Dependency links: dotted verticals from the prerequisite's row at the moment the wait ended (or now).
		for (const s of lane.spans) {
			if (s.state !== "waiting") continue;
			const stillWaiting = s.to === undefined;
			const when = s.to ?? now;
			const lx = clamp(X(when), xs, headX);
			for (const dep of lane.dependsOn) {
				const depIndex = indexOfName.get(dep) ?? -1;
				const depRow = depIndex < 0 ? -1 : rowOf[depIndex]!;
				if (depRow < 0 || depIndex === laneIndex) continue;
				const yDep = yOf(depRow);
				const step = y > yDep ? 1 : -1;
				const line: Pt[] = [];
				for (let yy = yDep; yy !== y + step; yy += step) line.push({ x: lx, y: yy });
				strands.push({ kind: "link", lane: laneIndex, state: "waiting", from: s.from, to: when, open: stillWaiting, points: ramp(line, when, when) });
			}
		}
	}

	// --- Marks on the trunk --------------------------------------------------------------------------------------
	snapshot.rounds.forEach((offset, i) => marks.push({ kind: "round", lane: -1, cx: X(offset) >> 1, cy: 0, at: offset, round: i + 1 }));
	// Accepted lanes without a row still join the trunk, at their accept time.
	lanes.forEach((lane, i) => {
		const last = lane.spans[lane.spans.length - 1];
		if (last !== undefined && rowOf[i]! < 0 && last.state === "accepted") marks.push({ kind: "accept", lane: i, cx: X(last.from) >> 1, cy: 0, at: last.from });
	});
	marks.push({ kind: "trunk-head", lane: -1, cx: headX >> 1, cy: 0, at: now });


	// --- Labels ---------------------------------------------------------------------------------------------------
	labels.push({ side: "left", lane: -1, cx: 0, cy: 0, width: textWidth(TRUNK_LABEL), text: TRUNK_LABEL });
	const word = phaseWord(phase, rw);
	labels.push({ side: "right", lane: -1, cx: cols - rw, cy: 0, width: textWidth(word), text: word });

	// The role word sits in a column of its own, so every lane's word starts at the same cell.
	const roleW = clamp(Math.ceil(lw * 0.3), 4, 7);
	for (const laneIndex of shown) {
		const lane = lanes[laneIndex]!;
		const row = rowOf[laneIndex]!;
		const note = lane.label === "" ? "" : ` ${clip(lane.label, roleW)}`;
		const primary = padEnd(clip(lane.name, note === "" ? lw : lw - 1 - roleW), note === "" ? 0 : lw - 1 - roleW);
		const left = clip(primary + note, lw);
		labels.push({ side: "left", lane: laneIndex, cx: 0, cy: row, width: textWidth(left), text: left, split: primary.length });
		// State word, then the progress when the lane has several results; the word gives way before the progress does.
		const progress = lane.progress !== undefined && lane.progress.total > 1 ? ` ${lane.progress.met}/${lane.progress.total}` : "";
		const state = clip(lane.retained === true && lastState(lane) === "accepted" ? RETAINED_STATE_WORD : STATE_WORD[lastState(lane)], rw - progress.length);
		const right = clip(state + progress, rw);
		labels.push({ side: "right", lane: laneIndex, cx: cols - rw, cy: row, width: textWidth(right), text: right, split: state.length });
	}
	if (folded.length > 0) {
		const counts = new Map<LaneState, number>();
		for (const i of folded) counts.set(lastState(lanes[i]!), (counts.get(lastState(lanes[i]!)) ?? 0) + 1);
		const text = clip([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s, n]) => `${STATE_WORD[s]} ${n}`).join(" · "), rw);
		const left = clip(`+${folded.length} 레인`, lw);
		labels.push({ side: "left", lane: -1, cx: 0, cy: rows - 1, width: textWidth(left), text: left });
		labels.push({ side: "right", lane: -1, cx: cols - rw, cy: rows - 1, width: textWidth(text), text });
	}
	// The scale stays at the right end of the trunk when it does not run into the head.
	const scale = fmtSpan(span);
	const scaleW = textWidth(scale);
	if ((headX >> 1) + 3 < cx1 - scaleW) labels.push({ side: "scale", lane: -1, cx: cx1 - scaleW, cy: 0, width: scaleW, text: scale });

	return {
		snapshot, cols, rows, phase, phaseAge, span, graph: { cx0, cx1 }, headX, rowOf, strands, marks, labels,
	};
}
