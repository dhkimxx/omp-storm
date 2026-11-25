/**
 * Layout of the "storm" variant: a run snapshot in, geometry out (strands, marks, labels). No colour, no drawing and no
 * animation time live here.
 *
 * Time axis: the picture covers the smallest step of LADDER_S that is at least 8% longer than the run so far, mapped
 * linearly onto the graph area, so the head ("now") sits between about 65% and 92% of its width.
 *
 * Routing (the "rake"):
 * - Rows are the trunk, then the shown lanes ordered by start time, then a summary row when lanes are folded.
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
import type { Lane, LaneState, Phase, Role, RunSnapshot } from "../model.ts";
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

const ROLE_WORD: Record<Role, string> = { explorer: "탐색", implementer: "구현", reviewer: "검토", quick: "빠른", architect: "설계" };
const STATE_WORD: Record<LaneState, string> = {
	reserved: "예약", waiting: "선행 대기", running: "작업 중", quiet: "조용", submitted: "제출", reviewing: "검토 중",
	accepted: "승인", unmet: "미충족", blocked: "막힘", excluded: "제외", idle: "유휴",
};
const PHASE_WORDS: Record<Phase, readonly string[]> = {
	working: ["진행 중"],
	workers: ["워커 작업 중", "워커 작업"],
	"waiting-user": ["응답 대기"],
	verifying: ["검증 중"],
	"between-rounds": ["다음 라운드 대기", "다음 라운드", "다음 대기"],
	stopping: ["종료 정리 중", "종료 중"],
};

// ---------------------------------------------------------------------------------------------------------------
// Text helpers (display width, not string length)
// ---------------------------------------------------------------------------------------------------------------

function charWidth(code: number): number {
	if (code === 0 || (code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
	return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)
		? 2 : 1;
}

function cells(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char.codePointAt(0)!);
	return width;
}

/** Cuts `text` to `width` display columns, ending in an ellipsis when something was cut. */
function clip(text: string, width: number): string {
	if (cells(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const char of text) {
		const w = charWidth(char.codePointAt(0)!);
		if (used + w > width - 1) break;
		out += char;
		used += w;
	}
	return `${out}…`;
}

function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - cells(text)));
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

function lastState(lane: Lane): LaneState {
	return lane.spans[lane.spans.length - 1]!.state;
}

function isTerminal(state: LaneState): boolean {
	return state === "accepted" || state === "blocked" || state === "excluded";
}

function foldRank(lane: Lane): number {
	const state = lastState(lane);
	return state === "accepted" || state === "excluded" ? 3 : state === "blocked" ? 2 : 0;
}

function phaseWord(phase: Phase, width: number): string {
	const words = PHASE_WORDS[phase];
	return words.find((w) => cells(w) <= width) ?? clip(words[words.length - 1]!, width);
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

export function layout(snapshot: RunSnapshot, cols: number, maxRows: number): Scene {
	// --- Areas --------------------------------------------------------------------------------------------------
	let rw = cols >= 100 ? 16 : cols >= 80 ? 12 : 9;
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
	const now = snapshot.now;
	const span = niceSpan(now);
	const X = (ms: number): number => x0 + clamp(Math.round((ms / span) * (wd - 1)), 0, wd - 1);
	const msAt = (x: number): number => ((x - x0) / (wd - 1)) * span;
	const headX = X(now);

	const lastPhase = snapshot.phases[snapshot.phases.length - 1];
	const phase: Phase = lastPhase?.phase ?? "working";
	const phaseAge = lastPhase === undefined ? 0 : Math.max(0, now - lastPhase.from);

	// --- Rows: shown lanes in start order, finished lanes fold first ----------------------------------------------
	const room = Math.max(0, maxRows - 1);
	let shown = lanes.map((_, i) => i);
	let folded: number[] = [];
	if (lanes.length > room) {
		const keep = Math.max(0, room - 1);
		const order = lanes.map((lane, i) => ({ i, rank: foldRank(lane) })).sort((a, b) => b.rank - a.rank || a.i - b.i);
		const foldSet = new Set(order.slice(0, lanes.length - keep).map((o) => o.i));
		shown = shown.filter((i) => !foldSet.has(i));
		folded = lanes.map((_, i) => i).filter((i) => foldSet.has(i));
	}
	if (room === 0) {
		shown = [];
		folded = [];
	}
	const startOf = (i: number): number => lanes[i]!.spans[0]!.from;
	shown.sort((a, b) => startOf(a) - startOf(b) || a - b);
	const rowOf: number[] = lanes.map(() => -1);
	shown.forEach((laneIndex, r) => { rowOf[laneIndex] = r + 1; });
	const rows = 1 + shown.length + (folded.length > 0 ? 1 : 0);
	const yOf = (row: number): number => 4 * row + LANE_Y_OFFSET;

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
	const accepted = shown.filter((i) => lastState(lanes[i]!) === "accepted")
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
		const real = terminal ? lane.spans.slice(0, -1) : lane.spans;
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
				const depIndex = lanes.findIndex((l) => l.name === dep);
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
		const last = lane.spans[lane.spans.length - 1]!;
		if (rowOf[i]! < 0 && last.state === "accepted") marks.push({ kind: "accept", lane: i, cx: X(last.from) >> 1, cy: 0, at: last.from });
	});
	marks.push({ kind: "trunk-head", lane: -1, cx: headX >> 1, cy: 0, at: now });

	// --- Labels ---------------------------------------------------------------------------------------------------
	const nameW = Math.max(1, lw - 5);
	const round = `R${snapshot.rounds.length}${snapshot.maxRounds !== undefined ? `/${snapshot.maxRounds}` : ""}`;
	const trunkLeft = clip(`감독 ${round} ${snapshot.counts.accepted}/${snapshot.counts.inScope}`, lw);
	labels.push({ side: "left", lane: -1, cx: 0, cy: 0, width: cells(trunkLeft), text: trunkLeft });
	const word = phaseWord(phase, rw);
	labels.push({ side: "right", lane: -1, cx: cols - rw, cy: 0, width: cells(word), text: word });

	for (const laneIndex of shown) {
		const lane = lanes[laneIndex]!;
		const row = rowOf[laneIndex]!;
		const left = clip(`${padEnd(clip(lane.name, nameW), nameW)} ${ROLE_WORD[lane.role]}`, lw);
		labels.push({ side: "left", lane: laneIndex, cx: 0, cy: row, width: cells(left), text: left });
		const state = clip(STATE_WORD[lastState(lane)], rw);
		labels.push({ side: "right", lane: laneIndex, cx: cols - rw, cy: row, width: cells(state), text: state });
	}
	if (folded.length > 0) {
		const counts = new Map<LaneState, number>();
		for (const i of folded) counts.set(lastState(lanes[i]!), (counts.get(lastState(lanes[i]!)) ?? 0) + 1);
		const text = clip([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s, n]) => `${STATE_WORD[s]} ${n}`).join(" · "), rw);
		const left = clip(`+${folded.length} 레인`, lw);
		labels.push({ side: "left", lane: -1, cx: 0, cy: rows - 1, width: cells(left), text: left });
		labels.push({ side: "right", lane: -1, cx: cols - rw, cy: rows - 1, width: cells(text), text });
	}
	// The scale stays at the right end of the trunk when it does not run into the head.
	const scale = fmtSpan(span);
	const scaleW = cells(scale);
	if ((headX >> 1) + 3 < cx1 - scaleW) labels.push({ side: "scale", lane: -1, cx: cx1 - scaleW, cy: 0, width: scaleW, text: scale });

	return {
		snapshot, cols, rows, phase, phaseAge, span, graph: { cx0, cx1 }, headX, rowOf, strands, marks, labels,
	};
}
