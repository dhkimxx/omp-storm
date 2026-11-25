/**
 * Variant "braille": the whole lane view on a Braille dot canvas (every terminal cell is 2 by 4 dots).
 *
 * Time axis: the span of the picture is the smallest step of LADDER that is at least 8% longer than the run so far,
 * mapped linearly onto the canvas (so the head sits between roughly 65% and 92% of the width). The picture only
 * re-scales when the run crosses a step: 30s, 45s, 1m, 1.5m, 2m, 3m, 5m, ... up to a day. Nothing moves
 * between steps except what is working. The span is printed at the right end of the trunk; the part of the
 * trunk right of the head is a faint dotted ruler of the time still to come.
 *
 * Colour: a Braille cell has one colour, so every dot carries a rank (dim < muted < role < bright) and a cell takes
 * the colour of its highest-ranked dot. Light is therefore "the brighter dots of a cell win" and a pulse is both a
 * thicker bulge of dots and a brighter colour, moving by one dot (half a cell) at a time.
 */
import type { Frame, FrameOptions, Lane, LaneSpan, LaneState, Phase, Role, RunSnapshot, Tone } from "../model.ts";

interface Cell {
	ch: string;
	tone: Tone;
	bold: boolean;
}

interface Pt {
	x: number;
	y: number;
}

const BLANK: Cell = { ch: " ", tone: "dim", bold: false };
const LADDER_S = [30, 45, 60, 90, 120, 180, 300, 480, 720, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400, 21600, 28800, 43200, 86400];
const SCAN_PERIOD_MS = 2900;
const FLASH_MS = 1300;
const BLOCK_FLASH_MS = 700;
const STOP_FADE_MS = 4200;
const STOP_LANE_MS = 650;

const ROLE_TONE: Record<Role, Tone> = { explorer: "role1", implementer: "role2", reviewer: "role3", quick: "role4", architect: "role5" };
const ROLE_WORD: Record<Role, string> = { explorer: "탐색", implementer: "구현", reviewer: "검토", quick: "빠른", architect: "설계" };
const STATE_WORD: Record<LaneState, string> = {
	reserved: "예약", waiting: "선행 대기", running: "작업 중", quiet: "조용", submitted: "제출", reviewing: "검토 중",
	accepted: "승인", unmet: "미충족", blocked: "막힘", excluded: "제외", idle: "유휴",
};
const PHASE_WORDS: Record<Phase, readonly string[]> = {
	working: ["진행 중"],
	workers: ["워커 작업 중", "워커 작업"],
	verifying: ["검증 중"],
	"waiting-user": ["응답 대기"],
	"between-rounds": ["다음 라운드 대기", "다음 라운드", "다음 대기"],
	stopping: ["종료 정리 중", "종료 중"],
};
const PHASE_TONE: Record<Phase, Tone> = {
	working: "accent", workers: "accent", verifying: "success", "waiting-user": "warning", "between-rounds": "muted", stopping: "dim",
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

function mod(a: number, n: number): number {
	return ((a % n) + n) % n;
}

function hash(n: number): number {
	let h = Math.imul(n + 0x9e3779b9, 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function pingPong(t: number): number {
	const u = mod(t, SCAN_PERIOD_MS) / SCAN_PERIOD_MS;
	return u < 0.5 ? u * 2 : 2 - u * 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Braille canvas
// ---------------------------------------------------------------------------------------------------------------

// Dot bit by [column][row] inside a cell.
const DOT_BIT = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]] as const;
const EMPTY = -2;
const FAINT = -1;
/** Dot ranks, low to high. A cell takes the tone of its highest rank. */
const R_DIM = 0;
const R_MUTED = 1;
const R_ROLE = 2;
const R_BRIGHT = 3;
const R_NODE = 4;

class Canvas {
	readonly bits: Uint8Array;
	readonly rank: Int8Array;
	readonly tone: Tone[];
	readonly bold: boolean[];

	constructor(readonly cw: number, readonly h: number) {
		this.bits = new Uint8Array(cw * h);
		this.rank = new Int8Array(cw * h).fill(EMPTY);
		this.tone = new Array<Tone>(cw * h).fill("dim");
		this.bold = new Array<boolean>(cw * h).fill(false);
	}

	dot(x: number, y: number, tone: Tone, rank: number, bold = false): void {
		x = Math.round(x);
		y = Math.round(y);
		if (x < 0 || y < 0 || x >= this.cw * 2 || y >= this.h * 4) return;
		const c = (y >> 2) * this.cw + (x >> 1);
		this.bits[c]! |= DOT_BIT[x & 1]![y & 3]!;
		if (rank >= this.rank[c]!) {
			this.rank[c] = rank;
			this.tone[c] = tone;
			this.bold[c] = bold;
		}
	}

	clear(x: number, y: number, w: number, h: number): void {
		for (let yy = y; yy < y + h; yy++) {
			for (let xx = x; xx < x + w; xx++) {
				if (xx < 0 || yy < 0 || xx >= this.cw * 2 || yy >= this.h * 4) continue;
				this.bits[(yy >> 2) * this.cw + (xx >> 1)]! &= ~DOT_BIT[xx & 1]![yy & 3]!;
			}
		}
	}

	/** Stamps a pattern of "#" and "." with its top-left dot at (x, y), clearing the area under it first. */
	shape(x: number, y: number, rows: readonly string[], tone: Tone, rank: number, bold: boolean): void {
		this.clear(x, y, rows[0]!.length, rows.length);
		rows.forEach((row, dy) => {
			for (let dx = 0; dx < row.length; dx++) if (row[dx] === "#") this.dot(x + dx, y + dy, tone, rank, bold);
		});
	}

	empty(c: number): boolean {
		return this.bits[c] === 0;
	}
}

const SHAPE = {
	disc: [".##.", "####", "####", ".##."],
	ring: [".##.", "#..#", "#..#", ".##."],
	cross: ["#..#", ".##.", ".##.", "#..#"],
	slashed: [".##.", "#.##", "##.#", ".##."],
	squareFull: ["####", "####", "####", "####"],
	squareHollow: ["####", "#..#", "#..#", "####"],
	block: ["####", "####", "####", "####"],
} as const;

/** Anchors a 4-dot-wide shape on cell boundaries around dot column x. */
function anchor(x: number): number {
	return Math.round(x / 2) * 2 - 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry shared by both renderers
// ---------------------------------------------------------------------------------------------------------------

interface Geometry {
	lw: number;
	rw: number;
	cw: number;
	shown: readonly number[];
	folded: readonly number[];
	/** Canvas rows: trunk, shown lanes, optional summary row. */
	rows: number;
}

interface Scene {
	snapshot: RunSnapshot;
	geo: Geometry;
	options: FrameOptions;
	t: number;
	phase: Phase;
	phaseAge: number;
	span: number;
	/** Animated parameters; fixed at 0 when motion is off. */
	anim: number;
	motion: boolean;
	/** Phases in which nothing flows. */
	still: boolean;
	rowOf: ReadonlyMap<number, number>;
}

function currentPhase(snapshot: RunSnapshot): { phase: Phase; age: number } {
	const last = snapshot.phases[snapshot.phases.length - 1];
	return last === undefined ? { phase: "working", age: 0 } : { phase: last.phase, age: Math.max(0, snapshot.now - last.from) };
}

function niceSpan(now: number): number {
	for (const s of LADDER_S) if (s * 1000 >= now * 1.08) return s * 1000;
	return Math.ceil((now * 1.08) / 86_400_000) * 86_400_000;
}

function foldRank(lane: Lane): number {
	const state = lane.spans[lane.spans.length - 1]?.state;
	return state === "accepted" || state === "excluded" ? 3 : state === "blocked" ? 2 : 0;
}

function layout(snapshot: RunSnapshot, cols: number, maxRows: number): Geometry {
	const rw = cols >= 100 ? 16 : cols >= 80 ? 12 : 9;
	const lw = Math.max(16, Math.min(22, Math.round(cols * 0.22)));
	const cw = Math.max(8, cols - lw - rw - 2);
	const room = Math.max(0, maxRows - 1);
	const lanes = snapshot.lanes;
	let shown = lanes.map((_, i) => i);
	let folded: number[] = [];
	if (lanes.length > room) {
		const keep = Math.max(0, room - 1);
		const order = lanes.map((lane, i) => ({ i, rank: foldRank(lane) })).sort((a, b) => b.rank - a.rank || a.i - b.i);
		folded = order.slice(0, lanes.length - keep).map((o) => o.i);
		shown = shown.filter((i) => !folded.includes(i));
	}
	if (room === 0) shown = [];
	// With a single row there is no room for a summary: the trunk alone carries the accept nodes.
	if (room === 0) folded = [];
	return { lw, rw, cw, shown, folded, rows: 1 + shown.length + (folded.length > 0 ? 1 : 0) };
}

function spanAt(lane: Lane, ms: number): LaneSpan {
	let found = lane.spans[0]!;
	for (const span of lane.spans) if (span.from <= ms) found = span;
	return found;
}

function lastOf(lane: Lane): LaneSpan {
	return lane.spans[lane.spans.length - 1]!;
}

// ---------------------------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------------------------

export const frame: Frame = (snapshot, cols, t, options) => {
	const geo = layout(snapshot, cols, Math.max(1, options.maxRows));
	const { phase, age } = currentPhase(snapshot);
	const motion = options.motion;
	const rowOf = new Map<number, number>();
	geo.shown.forEach((laneIndex, r) => rowOf.set(laneIndex, r + 1));
	const scene: Scene = {
		snapshot, geo, options, t, phase, phaseAge: age, span: niceSpan(snapshot.now), anim: motion ? t : 0, motion,
		still: phase === "waiting-user" || phase === "between-rounds" || phase === "stopping", rowOf,
	};
	const grid = options.ascii ? drawAscii(scene) : drawBraille(scene);
	return compose(scene, grid);
};

// ---------------------------------------------------------------------------------------------------------------
// Labels and assembly
// ---------------------------------------------------------------------------------------------------------------

type Piece = { text: string; tone: Tone; bold: boolean };

function emit(pieces: Piece[], text: string, tone: Tone, bold = false): void {
	if (text === "") return;
	const last = pieces[pieces.length - 1];
	if (last !== undefined && last.tone === tone && last.bold === bold) last.text += text;
	else pieces.push({ text, tone, bold });
}

function stateTone(lane: Lane, state: LaneState): Tone {
	switch (state) {
		case "running": return ROLE_TONE[lane.role];
		case "quiet": return "muted";
		case "submitted": return "fg";
		case "reviewing": case "accepted": return "success";
		case "unmet": return "warning";
		case "blocked": return "error";
		default: return "dim";
	}
}

function phaseWord(phase: Phase, width: number): string {
	return PHASE_WORDS[phase].find((w) => cells(w) <= width) ?? clip(PHASE_WORDS[phase][PHASE_WORDS[phase].length - 1]!, width);
}

function compose(scene: Scene, grid: Cell[][]): string[] {
	const { geo, snapshot, options } = scene;
	const out: string[] = [];
	const nameW = geo.lw - 5;
	for (let r = 0; r < geo.rows; r++) {
		const pieces: Piece[] = [];
		const summary = r === geo.rows - 1 && geo.folded.length > 0;
		if (r === 0) {
			const round = `R${snapshot.rounds.length}${snapshot.maxRounds !== undefined ? `/${snapshot.maxRounds}` : ""}`;
			emit(pieces, "디렉터", "accent", true);
			emit(pieces, padEnd(` ${round}`, geo.lw - 6), "muted");
		} else if (summary) {
			emit(pieces, padEnd(`+${geo.folded.length} 레인`, geo.lw), "muted");
		} else {
			const lane = snapshot.lanes[geo.shown[r - 1]!]!;
			const done = lastOf(lane).state === "accepted" || lastOf(lane).state === "excluded";
			emit(pieces, padEnd(clip(lane.name, nameW), nameW), done ? "muted" : "fg");
			emit(pieces, ` ${ROLE_WORD[lane.role]}`, done ? "dim" : ROLE_TONE[lane.role]);
		}
		emit(pieces, " ", "dim");
		for (const cell of grid[r]!) emit(pieces, cell.ch, cell.tone, cell.bold);
		emit(pieces, " ", "dim");
		if (r === 0) {
			const word = phaseWord(scene.phase, geo.rw);
			emit(pieces, word, PHASE_TONE[scene.phase], true);
			emit(pieces, " ".repeat(geo.rw - cells(word)), "dim");
		} else if (summary) {
			emit(pieces, padEnd("접힘", geo.rw), "dim");
		} else {
			const lane = snapshot.lanes[geo.shown[r - 1]!]!;
			const state = lastOf(lane).state;
			const word = clip(STATE_WORD[state], geo.rw);
			emit(pieces, word, stateTone(lane, state), state === "blocked" || state === "reviewing");
			emit(pieces, " ".repeat(geo.rw - cells(word)), "dim");
		}
		out.push(pieces.map((p) => options.paint(p.tone, p.text, p.bold)).join(""));
	}
	return out;
}

/** Puts text on a grid row at a cell column; a wide character takes two cells. */
function putText(row: Cell[], x: number, text: string, tone: Tone, bold = false): void {
	let cx = x;
	for (const char of text) {
		const w = charWidth(char.codePointAt(0)!);
		if (cx < 0 || cx + w > row.length) break;
		row[cx] = { ch: char, tone, bold };
		if (w === 2) row[cx + 1] = { ch: "", tone, bold };
		cx += w;
	}
}

function blankGrid(scene: Scene): Cell[][] {
	return Array.from({ length: scene.geo.rows }, () => Array.from({ length: scene.geo.cw }, () => BLANK));
}

function summaryText(scene: Scene): string {
	const counts = new Map<LaneState, number>();
	for (const i of scene.geo.folded) {
		const state = lastOf(scene.snapshot.lanes[i]!).state;
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${STATE_WORD[s]} ${n}`).join(" · ");
}

// ---------------------------------------------------------------------------------------------------------------
// Braille drawing
// ---------------------------------------------------------------------------------------------------------------

function drawBraille(scene: Scene): Cell[][] {
	const { snapshot, geo, anim, motion, phase } = scene;
	const wd = geo.cw * 2;
	const cv = new Canvas(geo.cw, geo.rows);
	const X = (ms: number): number => Math.max(0, Math.min(wd - 1, Math.round((ms / scene.span) * (wd - 1))));
	const msAt = (x: number): number => (x / (wd - 1)) * scene.span;
	const xNow = X(snapshot.now);
	const stopping = phase === "stopping" && motion;
	const fadeFront = stopping ? (scene.phaseAge / STOP_FADE_MS) * (wd + 12) : -1;
	const flowing = motion && !scene.still;

	/** Draws one dot unless the stop fade has put its place in the dark. */
	const lit = (x: number, y: number, tone: Tone, rank: number, bold = false, darkNow = false): void => {
		if (darkNow || x < fadeFront) cv.dot(x, y, "dim", R_DIM);
		else cv.dot(x, y, tone, rank, bold);
	};

	// --- Trunk ---------------------------------------------------------------------------------------------------
	const trunk = (): void => {
		const head = motion ? mod((anim / 1000) * 26, xNow + 10) : xNow;
		let prev = -1;
		for (let x = 0; x <= xNow; x++) {
			if (phase === "working") {
				// The radar's rolling wind: a sine that rolls to the right, with a bright head sweeping left to right.
				const y = Math.round(1.5 + 1.5 * Math.sin((x * 2 * Math.PI) / 18 - (anim / 1000) * 2 * Math.PI * 0.9));
				const behind = head - x;
				let tone: Tone = "muted";
				let rank = R_MUTED;
				let bold = false;
				if (behind >= 0 && behind < 2) { tone = "bright"; rank = R_BRIGHT; bold = true; }
				else if ((behind >= 0 && behind < 16) || (behind < 0 && behind > -5)) { tone = "accent"; rank = R_ROLE; bold = true; }
				for (let yy = prev < 0 ? y : Math.min(y, prev); yy <= (prev < 0 ? y : Math.max(y, prev)); yy++) lit(x, yy, tone, rank, bold);
				if (motion && x % 3 === 0) {
					const y2 = Math.round(1.5 + 1.5 * Math.sin((x * 2 * Math.PI) / 11 + (anim / 1000) * 2 * Math.PI * 0.55 + 1.3));
					if (y2 !== y) lit(x, y2, "dim", R_DIM);
				}
				prev = y;
			} else if (phase === "workers") {
				// Calm: a slow breath in thickness and tone.
				const breath = 0.5 + 0.5 * Math.sin((anim / 4200) * 2 * Math.PI);
				const strong = !motion || breath > 0.5;
				lit(x, 1, strong ? "accent" : "muted", strong ? R_ROLE : R_MUTED);
				lit(x, 2, strong ? "accent" : "muted", strong ? R_ROLE : R_MUTED);
				if (motion && breath > 0.85) lit(x, 0, "muted", R_MUTED);
			} else if (phase === "verifying") {
				// The radar's ping-pong sweep, in the success colour.
				const pos = (motion ? pingPong(anim) : 0.5) * xNow;
				const d = Math.abs(x - pos);
				lit(x, 1, d < 7 ? "success" : "muted", d < 7 ? R_BRIGHT : R_MUTED, d < 2);
				lit(x, 2, d < 7 ? "success" : "muted", d < 7 ? R_BRIGHT : R_MUTED, d < 2);
				if (d < 3) { lit(x, 0, "success", R_BRIGHT, true); lit(x, 3, "success", R_BRIGHT, true); }
			} else if (phase === "waiting-user") {
				lit(x, 1, "muted", R_MUTED);
				lit(x, 2, "muted", R_MUTED);
			} else if (phase === "between-rounds") {
				lit(x, 1, "dim", R_DIM);
				lit(x, 2, "dim", R_DIM);
			} else {
				lit(x, 1, "muted", R_MUTED);
				lit(x, 2, "muted", R_MUTED);
			}
		}
		// Time still to come: a faint dotted ruler.
		for (let x = xNow + 1; x < wd; x += 4) cv.dot(x, 1, "dim", R_DIM);
		if (phase === "waiting-user") cv.shape(anchor(xNow) - 2, 0, SHAPE.block, "warning", R_NODE, true);
	};
	trunk();

	// --- Lanes ---------------------------------------------------------------------------------------------------
	const nodes: Array<() => void> = [];
	geo.shown.forEach((laneIndex, r0) => {
		const lane = snapshot.lanes[laneIndex]!;
		drawLane(lane, r0 + 1, r0);
	});

	function drawLane(lane: Lane, row: number, order: number): void {
		const last = lastOf(lane);
		const yk = 4 * row + 1;
		const roleTone = ROLE_TONE[lane.role];
		const closed = last.state === "accepted" || last.state === "blocked" || last.state === "excluded";
		const x0 = X(lane.spans[0]!.from);
		const xEnd = Math.max(x0 + 2, closed ? X(last.from) : xNow);
		const settled = last.state === "accepted" || last.state === "excluded";
		const darkLane = stopping && scene.phaseAge > order * STOP_LANE_MS;
		const allowFlow = flowing && !darkLane;

		let dxD = 4 + 2 * row;
		let dxU = last.state === "accepted" ? dxD : 0;
		if (xEnd - x0 < dxD + dxU) {
			const f = (xEnd - x0) / (dxD + dxU || 1);
			dxD = Math.max(2, Math.floor(dxD * f));
			dxU = dxU > 0 ? Math.max(2, Math.floor(dxU * f)) : 0;
		}
		const path = lanePath(x0, 1, yk, dxD, dxU, xEnd);
		const length = path.length;
		const speed = 10 + 30 * (lane.activity ?? 0.5);
		const flow = (anim / 1000) * speed;
		const scanPos = (motion ? pingPong(anim) : 0.5) * (length - 1);

		path.forEach((p, i) => {
			const prevP = path[Math.max(0, i - 2)]!;
			const nextP = path[Math.min(length - 1, i + 2)]!;
			const steep = Math.abs(nextP.y - prevP.y) > Math.abs(nextP.x - prevP.x);
			const ms = closed ? Math.min(msAt(p.x), last.from - 1) : msAt(p.x);
			const span = spanAt(lane, ms);
			let state = span.state;
			if (settled && state === "accepted") state = "running";
			let offs: readonly number[] = [0, 1];
			let tone: Tone = roleTone;
			let rank = R_ROLE;
			let bold = false;
			let visible = true;
			switch (state) {
				case "reserved": offs = [0]; tone = "muted"; rank = R_MUTED; visible = i % 3 === 0; break;
				case "waiting": offs = [0]; tone = "dim"; rank = R_DIM; visible = i % 4 === 0; break;
				case "running": {
					const delta = mod(flow - i, 16);
					if (allowFlow) {
						if (delta < 2) { offs = [-1, 0, 1, 2]; tone = "bright"; rank = R_BRIGHT; bold = true; }
						else if (delta < 6) { offs = [0, 1, 2]; bold = true; }
					} else if (!motion && mod(i, 16) < 3) { offs = [0, 1, 2]; bold = true; }
					break;
				}
				case "quiet": {
					if (i >= length - 8 && motion && !scene.still) {
						const breath = 0.5 + 0.5 * Math.sin((anim / 3400) * 2 * Math.PI);
						if (breath > 0.7) { offs = [-1, 0, 1, 2]; tone = "bright"; rank = R_BRIGHT; bold = true; }
						else if (breath > 0.35) { offs = [0, 1, 2]; bold = true; }
					}
					break;
				}
				case "submitted": offs = [-1, 2]; tone = "fg"; rank = R_ROLE; break;
				case "reviewing":
					offs = [-1, 2];
					if (allowFlow && Math.abs(i - scanPos) < 6) { tone = "success"; rank = R_BRIGHT; bold = true; offs = [-1, 0, 1, 2]; }
					else if (!motion || scene.still) { tone = "success"; rank = R_ROLE; }
					break;
				case "unmet": offs = [0]; tone = "warning"; rank = R_ROLE; break;
				case "idle": offs = [0]; tone = "dim"; rank = R_DIM; break;
				default: break;
			}
			if (last.state === "excluded") { offs = [0]; tone = "dim"; rank = R_DIM; visible = i % 3 === 0; }
			if (lane.job === true && state !== "reserved" && state !== "waiting") offs = [0]; // squares carry a job lane
			if (settled) { tone = "dim"; rank = R_DIM; bold = false; if (offs.length > 2) offs = [0, 1]; }
			if (!visible) return;
			for (const o of offs) lit(steep ? p.x + o : p.x, steep ? p.y : p.y + o, tone, rank, bold, darkLane);
		});

		// Job lane: squares that fill in turn while the lane runs.
		if (lane.job === true) {
			const first = x0 + dxD + 2;
			const squares: number[] = [];
			for (let x = first; x <= xEnd - dxU - 4; x += 10) squares.push(x);
			const running = last.state === "running";
			const filledCount = running && allowFlow ? Math.floor(anim / 420) % (squares.length + 1) : last.state === "accepted" ? squares.length : 0;
			nodes.push(() => squares.forEach((x, i) => {
				const full = i < filledCount;
				const tone: Tone = settled ? "dim" : last.state === "reserved" || last.state === "waiting" ? "muted" : roleTone;
				cv.shape(anchor(x), yk - 1, full ? SHAPE.squareFull : SHAPE.squareHollow, darkLane ? "dim" : tone, darkLane ? R_DIM : R_NODE, full && running);
			}));
		}

		// Dependency links: a dotted curve from the lane it waits for.
		for (const span of lane.spans) {
			if (span.state !== "waiting") continue;
			const xs = X(span.to ?? snapshot.now);
			for (const dep of lane.dependsOn) {
				const depIndex = snapshot.lanes.findIndex((l) => l.name === dep);
				const depRow = scene.rowOf.get(depIndex);
				if (depRow === undefined) continue;
				const link = curve(Math.max(0, xs - 5), 4 * depRow + 1, xs, yk);
				link.forEach((p, i) => { if (i % 3 === 0) lit(p.x, p.y, "dim", R_DIM, false, darkLane); });
			}
		}

		// Unmet circles, the blocked cross, the excluded slashed circle, the review diamond.
		for (const span of lane.spans) {
			if (span.state === "unmet") nodes.push(() => cv.shape(anchor(X(span.from)), yk - 1, SHAPE.ring, "warning", R_NODE, true));
		}
		if (last.state === "blocked") {
			const flash = motion && snapshot.now - last.from < BLOCK_FLASH_MS;
			nodes.push(() => {
				cv.shape(anchor(xEnd), yk - 1, SHAPE.cross, "error", R_NODE, true);
				if (flash) {
					for (let dx = -8; dx <= 8; dx++) cv.dot(xEnd + dx, yk - 2, "error", R_NODE, true);
				}
			});
		}
		if (last.state === "excluded") nodes.push(() => cv.shape(anchor(xEnd), yk - 1, SHAPE.slashed, "dim", R_NODE, false));
	}

	// --- Nodes drawn over the lines ------------------------------------------------------------------------------
	snapshot.rounds.forEach((offset, i) => {
		const x = X(offset);
		const latest = i === snapshot.rounds.length - 1;
		const tone: Tone = latest ? "bright" : "muted";
		for (let y = 0; y < 4; y++) cv.dot(x, y, tone, R_NODE, latest);
	});
	for (const fn of nodes) fn();
	snapshot.lanes.forEach((lane) => {
		const last = lastOf(lane);
		if (last.state !== "accepted") return;
		const xa = X(last.from);
		const age = snapshot.now - last.from;
		cv.shape(anchor(xa), 0, SHAPE.disc, "success", R_NODE, true);
		if (motion && age >= 0 && age < FLASH_MS) {
			// One flash that spreads along the trunk from the joining point.
			const radius = (age / FLASH_MS) * 42 + 3;
			for (const side of [-1, 1]) {
				for (let w = 0; w < 10; w++) {
					const x = xa + side * (radius - w);
					if (x < 0 || x > xNow + 1 || radius - w < 2) continue;
					const strength = 1 - age / FLASH_MS;
					cv.dot(x, 1, w < 3 ? "bright" : "success", R_NODE, strength > 0.3);
					cv.dot(x, 2, w < 3 ? "bright" : "success", R_NODE, strength > 0.3);
					if (w < 4) { cv.dot(x, 0, "success", R_NODE); cv.dot(x, 3, "success", R_NODE); }
				}
			}
		}
	});

	// --- Particles: faint currents between the lanes while several lanes run ----------------------------------------
	const running = snapshot.lanes.filter((l) => lastOf(l).state === "running").length;
	if (flowing && running >= 2 && geo.shown.length > 0) {
		const rowsH = geo.shown.length * 4;
		const count = Math.ceil((geo.cw * geo.shown.length) / 9);
		for (let j = 0; j < count; j++) {
			const x = mod(hash(j) * xNow + (anim / 1000) * (5 + 11 * hash(j + 99)), Math.max(8, xNow));
			const y = 4 + hash(j + 500) * (rowsH - 1) + 1.3 * Math.sin(anim / 700 + j * 1.7);
			const c = (Math.round(y) >> 2) * geo.cw + (Math.round(x) >> 1);
			if (Math.round(y) >= 4 && Math.round(y) < geo.shown.length * 4 + 4 && (cv.rank[c] === EMPTY || cv.rank[c] === FAINT)) {
				cv.dot(x, y, "dim", FAINT);
			}
		}
	}

	// --- To cells ------------------------------------------------------------------------------------------------
	const grid = blankGrid(scene);
	for (let r = 0; r < geo.rows; r++) {
		for (let c = 0; c < geo.cw; c++) {
			const i = r * geo.cw + c;
			if (cv.bits[i] === 0) continue;
			grid[r]![c] = { ch: String.fromCodePoint(0x2800 + cv.bits[i]!), tone: cv.tone[i]!, bold: cv.bold[i]! };
		}
	}
	// Ordinary glyphs on top: round numbers, the span label, review diamonds, the folded summary.
	snapshot.rounds.forEach((offset, i) => {
		putText(grid[0]!, (X(offset) >> 1) + 1, String(i + 1), i === snapshot.rounds.length - 1 ? "bright" : "muted", i === snapshot.rounds.length - 1);
	});
	const label = ` ${fmtSpan(scene.span)}`;
	if ((xNow >> 1) + 3 < geo.cw - label.length) putText(grid[0]!, geo.cw - label.length, label, "dim");
	geo.shown.forEach((laneIndex, r0) => {
		const lane = snapshot.lanes[laneIndex]!;
		if (lastOf(lane).state !== "reviewing") return;
		putText(grid[r0 + 1]!, Math.min(geo.cw - 1, xNow >> 1), "◆", "success", true);
	});
	if (geo.folded.length > 0) putText(grid[geo.rows - 1]!, 1, clip(summaryText(scene), geo.cw - 2), "muted");
	return grid;
}

/** An S curve from (x0, y0) to (x1, y1), sampled densely enough that consecutive dots touch. */
function curve(x0: number, y0: number, x1: number, y1: number): Pt[] {
	const n = 2 * (Math.abs(x1 - x0) + Math.abs(y1 - y0)) + 1;
	const out: Pt[] = [];
	for (let i = 0; i <= n; i++) {
		const u = i / n;
		const e = u * u * (3 - 2 * u);
		const p = { x: Math.round(x0 + (x1 - x0) * u), y: Math.round(y0 + (y1 - y0) * e) };
		const last = out[out.length - 1];
		if (last === undefined || last.x !== p.x || last.y !== p.y) out.push(p);
	}
	return out;
}

/** The lane's whole route: the curve down from the trunk, the run along its row, the curve back up when accepted. */
function lanePath(x0: number, yTrunk: number, yLane: number, dxD: number, dxU: number, xEnd: number): Pt[] {
	const out: Pt[] = curve(x0, yTrunk, x0 + dxD, yLane).filter((p) => p.x <= xEnd);
	const flatEnd = xEnd - dxU;
	for (let x = x0 + dxD + 1; x <= flatEnd; x++) out.push({ x, y: yLane });
	if (dxU > 0) out.push(...curve(flatEnd, yLane, xEnd, yTrunk).slice(1));
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ASCII fallback: one cell per step, the same graph with distinct characters per state
// ---------------------------------------------------------------------------------------------------------------

function drawAscii(scene: Scene): Cell[][] {
	const { snapshot, geo, anim, motion, phase } = scene;
	const grid = blankGrid(scene);
	const wd = geo.cw;
	const X = (ms: number): number => Math.max(0, Math.min(wd - 1, Math.round((ms / scene.span) * (wd - 1))));
	const msAt = (x: number): number => (x / (wd - 1)) * scene.span;
	const xNow = X(snapshot.now);
	const stopping = phase === "stopping" && motion;
	const fadeFront = stopping ? (scene.phaseAge / STOP_FADE_MS) * (wd + 6) : -1;
	const flowing = motion && !scene.still;
	const put = (r: number, x: number, ch: string, tone: Tone, bold = false): void => {
		if (x < 0 || x >= wd) return;
		grid[r]![x] = x < fadeFront ? { ch: ch === " " ? " " : ".", tone: "dim", bold: false } : { ch, tone, bold };
	};
	const tick = Math.floor(anim / 85);

	// Trunk.
	const headPos = motion ? mod(tick, xNow + 4) : xNow;
	const scan = Math.round((motion ? pingPong(anim) : 0.5) * xNow);
	for (let x = 0; x <= xNow; x++) {
		switch (phase) {
			case "working": {
				const d = headPos - x;
				const ch = d === 0 ? "@" : mod(x + tick, 4) < 2 ? "~" : "-";
				put(0, x, ch, d === 0 ? "bright" : d > 0 && d < 8 ? "accent" : "muted", d >= 0 && d < 8);
				break;
			}
			case "workers": {
				const breath = !motion || Math.sin((anim / 4200) * 2 * Math.PI) > 0;
				put(0, x, breath ? "=" : "-", breath ? "accent" : "muted");
				break;
			}
			case "verifying": {
				const d = Math.abs(x - scan);
				put(0, x, d === 0 ? "#" : d < 3 ? "=" : "-", d < 3 ? "success" : "muted", d < 2);
				break;
			}
			case "waiting-user": put(0, x, x >= xNow - 2 ? "#" : "-", x >= xNow - 2 ? "warning" : "muted", x >= xNow - 2); break;
			case "between-rounds": put(0, x, mod(x, 2) === 0 ? "." : "-", "dim"); break;
			default: put(0, x, "-", "muted");
		}
	}
	for (let x = xNow + 1; x < wd; x += 2) put(0, x, ".", "dim");

	geo.shown.forEach((laneIndex, r0) => {
		const lane = snapshot.lanes[laneIndex]!;
		const row = r0 + 1;
		const last = lastOf(lane);
		const closed = last.state === "accepted" || last.state === "blocked" || last.state === "excluded";
		const settled = last.state === "accepted" || last.state === "excluded";
		const x0 = X(lane.spans[0]!.from);
		const xEnd = Math.max(x0 + 1, closed ? X(last.from) : xNow);
		const darkLane = stopping && scene.phaseAge > r0 * STOP_LANE_MS;
		const allowFlow = flowing && !darkLane;
		const roleTone = ROLE_TONE[lane.role];
		const joinGap = last.state === "accepted" ? row : 0;
		const lineStart = x0 + row + 1;
		const lineEnd = xEnd - joinGap - 1;
		const speed = 6 + 18 * (lane.activity ?? 0.5);
		const flow = (anim / 1000) * speed;
		const scanPos = lineStart + (motion ? pingPong(anim) : 0.5) * Math.max(0, lineEnd - lineStart);

		const at = (x: number, ch: string, tone: Tone, bold = false): void => put(row, x, ch, darkLane ? "dim" : tone, !darkLane && bold);
		// The curve down: one diagonal step per row.
		for (let r = 1; r <= row; r++) {
			const x = x0 + r;
			if (x <= xEnd && x - 0 <= (closed ? xEnd : xNow)) put(r, x, "\\", settled || darkLane ? "dim" : roleTone);
		}
		const draw = (x: number): void => {
			const state = spanAt(lane, closed ? Math.min(msAt(x), last.from - 1) : msAt(x)).state;
			const i = x - lineStart;
			let ch = "-";
			let tone: Tone = roleTone;
			let bold = false;
			switch (state) {
				case "reserved": ch = i % 2 === 0 ? "." : " "; tone = "muted"; break;
				case "waiting": ch = i % 2 === 0 ? ":" : " "; tone = "dim"; break;
				case "running": {
					const delta = mod(flow - i, 9);
					if (allowFlow && delta < 1) { ch = ">"; tone = "bright"; bold = true; }
					else if (allowFlow && delta < 3) { ch = "="; bold = true; }
					else if (!motion && mod(i, 9) < 2) ch = ">";
					break;
				}
				case "quiet": {
					const breath = Math.sin((anim / 3400) * 2 * Math.PI);
					if (x === lineEnd && motion && !scene.still) { ch = breath > 0.3 ? "O" : "o"; tone = breath > 0.3 ? "bright" : roleTone; bold = breath > 0.3; }
					break;
				}
				case "submitted": ch = "="; tone = "fg"; break;
				case "reviewing": {
					ch = "=";
					tone = "success";
					if (allowFlow && Math.abs(x - scanPos) < 2) { ch = "#"; bold = true; }
					break;
				}
				case "unmet": ch = "~"; tone = "warning"; break;
				case "idle": ch = "_"; tone = "dim"; break;
				default: break;
			}
			if (last.state === "excluded") { ch = i % 2 === 0 ? "." : " "; tone = "dim"; bold = false; }
			if (settled) { tone = "dim"; bold = false; }
			at(x, ch, tone, bold);
		};
		for (let x = lineStart; x <= lineEnd; x++) draw(x);
		// A lane too young to have left its diagonal: show the diagonal only.
		if (last.state === "accepted") {
			for (let r = row; r >= 1; r--) put(r, xEnd - r, "/", "dim");
			put(0, xEnd, "O", "success", true);
			const age = snapshot.now - last.from;
			if (motion && age >= 0 && age < FLASH_MS) {
				const radius = Math.round((age / FLASH_MS) * 14) + 1;
				for (const side of [-1, 1]) put(0, xEnd + side * radius, "*", "bright", true);
			}
		}
		for (const span of lane.spans) {
			if (span.state === "unmet") put(row, X(span.from), "o", "warning", true);
			if (span.state === "waiting") {
				const xs = X(span.to ?? snapshot.now);
				for (const dep of lane.dependsOn) {
					const depRow = scene.rowOf.get(snapshot.lanes.findIndex((l) => l.name === dep));
					if (depRow === undefined) continue;
					for (let r = Math.min(depRow, row) + 1; r < Math.max(depRow, row); r++) put(r, xs, ":", "dim");
				}
			}
		}
		if (lane.job === true) {
			const full = last.state === "running" && allowFlow ? Math.floor(anim / 420) % 4 : last.state === "accepted" ? 3 : 0;
			let n = 0;
			for (let x = lineStart + 1; x < lineEnd - 3; x += 6, n++) {
				const filled = n < full;
				const tone: Tone = settled ? "dim" : roleTone;
				put(row, x, "[", tone);
				put(row, x + 1, filled ? "#" : " ", tone, filled);
				put(row, x + 2, "]", tone);
			}
		}
		if (last.state === "blocked") {
			put(row, xEnd, "X", "error", true);
			if (motion && snapshot.now - last.from < BLOCK_FLASH_MS) { put(row, xEnd - 1, "*", "error", true); put(row, xEnd + 1, "*", "error", true); }
		}
		if (last.state === "excluded") { put(row, xEnd - 1, "(", "dim"); put(row, xEnd, "/", "dim"); put(row, xEnd + 1, ")", "dim"); }
		if (last.state === "reviewing") { put(row, xEnd - 1, "<", "success", true); put(row, xEnd, ">", "success", true); }
	});

	// Accepted lanes folded away still join the trunk.
	snapshot.lanes.forEach((lane, i) => {
		const last = lastOf(lane);
		if (!geo.shown.includes(i) && last.state === "accepted") put(0, X(last.from), "O", "success", true);
	});
	snapshot.rounds.forEach((offset, i) => {
		const latest = i === snapshot.rounds.length - 1;
		put(0, X(offset), "|", latest ? "bright" : "muted", latest);
		put(0, X(offset) + 1, String(i + 1), latest ? "bright" : "muted", latest);
	});
	const label = ` ${fmtSpan(scene.span)}`;
	if (xNow + 3 < wd - label.length) putText(grid[0]!, wd - label.length, label, "dim");
	if (geo.folded.length > 0) putText(grid[geo.rows - 1]!, 1, clip(summaryText(scene), wd - 2), "muted");
	return grid;
}
