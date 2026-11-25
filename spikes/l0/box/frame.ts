/**
 * Variant "box": the lane view drawn with box-drawing glyphs, one terminal cell per time step, like a git graph.
 *
 * Layout of every row:  label (LW) + " " + graph (G cells) + " " + state word (RW).
 *
 * Time to column: the open end of the trunk and of every running lane (now) is always the same column, `head`.
 *   - While the run is young (now <= head * 1 s) one column is one second and the graph grows to the right.
 *   - Once it no longer fits, the newest 60 % of the columns keep 1 s per column, so recent events stay readable,
 *     and the whole older history is squeezed linearly into the remaining 40 % so the run always starts at column 0.
 * Spans are painted in order, so a span shorter than one column still shows (the next span repaints only its own
 * first column).
 *
 * Motion is recolouring only: every cell is a glyph plus a tone, and the effects pass changes tones per frame.
 */
import type { Frame, Lane, LaneSpan, LaneState, Phase, Role, Tone } from "../model.ts";

// ---------------------------------------------------------------------------------------------------------------
// Cells and glyphs

const NONE = 0;
const LIGHT = 1;
const HEAVY = 2;
const DOUBLE = 3;
const DOT = 4;
const THIN = 5;
type Stroke = 0 | 1 | 2 | 3 | 4 | 5;

interface Cell {
	u: Stroke;
	d: Stroke;
	l: Stroke;
	r: Stroke;
	/** An explicit glyph (node, head, tick); empty means "derive from the strokes". */
	glyph: string;
	tone: Tone;
	bold: boolean;
	/** 9 = a node whose tone effects must not touch. */
	prio: number;
}

function newRow(n: number): Cell[] {
	return Array.from({ length: n }, () => ({ u: NONE, d: NONE, l: NONE, r: NONE, glyph: "", tone: "fg" as Tone, bold: false, prio: 0 }));
}

// key = u d l r; [light, heavy, double]
const SHAPES: Record<string, readonly [string, string, string]> = {
	"0001": ["╶", "╺", "═"], "0010": ["╴", "╸", "═"], "0011": ["─", "━", "═"],
	"1000": ["╵", "╵", "╵"], "0100": ["╷", "╷", "╷"], "1100": ["│", "│", "│"],
	"1001": ["╰", "┕", "╘"], "1010": ["╯", "┙", "╛"], "0101": ["╭", "┍", "╒"], "0110": ["╮", "┑", "╕"],
	"1011": ["┴", "┷", "╧"], "0111": ["┬", "┯", "╤"], "1101": ["├", "┝", "╞"], "1110": ["┤", "┥", "╡"],
	"1111": ["┼", "┿", "╪"],
};
const ASCII_SHAPES: Record<string, string> = {
	"1000": "|", "0100": "|", "1100": "|", "1001": "\\", "1010": "/", "0101": "/", "0110": "\\",
	"1011": "+", "0111": "+", "1101": "+", "1110": "+", "1111": "+",
};
const ASCII_H: Record<number, string> = { [LIGHT]: "-", [HEAVY]: "#", [DOUBLE]: "=", [DOT]: ".", [THIN]: "_" };

function horizontalStyle(c: Cell): Stroke {
	const a = c.l;
	const b = c.r;
	if (a === DOUBLE || b === DOUBLE) return DOUBLE;
	if (a === HEAVY || b === HEAVY) return HEAVY;
	return Math.max(a, b) as Stroke;
}

function glyphOf(c: Cell, ascii: boolean): string {
	if (c.glyph !== "") return c.glyph;
	const hasU = c.u !== NONE;
	const hasD = c.d !== NONE;
	const hasL = c.l !== NONE;
	const hasR = c.r !== NONE;
	if (!hasU && !hasD && !hasL && !hasR) return " ";
	const key = `${+hasU}${+hasD}${+hasL}${+hasR}`;
	const vertical = hasU || hasD;
	const horizontal = hasL || hasR;
	const style = horizontalStyle(c);
	if (!vertical) {
		if (ascii) return ASCII_H[style] ?? "-";
		const shape = SHAPES[key]!;
		if (style === DOT) return hasL && hasR ? "┈" : shape[0];
		if (style === THIN) return hasL && hasR ? "╌" : shape[0];
		return shape[style === HEAVY ? 1 : style === DOUBLE ? 2 : 0];
	}
	if (!horizontal) {
		const dotted = c.u === DOT || c.d === DOT;
		const thin = c.u === THIN || c.d === THIN;
		if (ascii) return dotted ? ":" : thin ? "'" : key === "1000" || key === "0100" || key === "1100" ? "|" : "|";
		if (key === "1100") return dotted ? "┊" : thin ? "╎" : "│";
		return SHAPES[key]![0];
	}
	if (ascii) return ASCII_SHAPES[key] ?? "+";
	return SHAPES[key]![style === HEAVY ? 1 : style === DOUBLE ? 2 : 0];
}

/** [unicode, ascii] */
const NODE = {
	accept: ["●", "@"], acceptJob: ["■", "@"], unmet: ["○", "o"], unmetJob: ["□", "o"], blocked: ["✕", "X"], excluded: ["⊘", "/"],
	diamond: ["◆", "*"], runHead: ["▸", ">"], quietHead: ["•", "~"], jobFill: ["■", "%"], jobHollow: ["□", "+"],
	tick: ["◉", "|"], block: ["█", "!"],
} as const;
type NodeName = keyof typeof NODE;

// ---------------------------------------------------------------------------------------------------------------
// Text

function charWidth(cp: number): number {
	if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
	) return 2;
	return 1;
}

function width(text: string): number {
	let w = 0;
	for (const ch of text) w += charWidth(ch.codePointAt(0)!);
	return w;
}

/** Cuts to a display width, ending in an ellipsis when it had to cut. No padding. */
function clip(text: string, max: number, ascii: boolean): string {
	if (max <= 0) return "";
	if (width(text) <= max) return text;
	const mark = ascii ? "~" : "…";
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = charWidth(ch.codePointAt(0)!);
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return out + mark;
}

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary

const ROLE_TONE: Record<Role, Tone> = { explorer: "role1", implementer: "role2", reviewer: "role3", quick: "role4", architect: "role5" };
const ROLE_WORD: Record<Role, string> = { explorer: "탐색", implementer: "구현", reviewer: "리뷰", quick: "신속", architect: "설계" };

const PHASE_WORD: Record<Phase, string> = {
	working: "진행 중", workers: "워커 작업 중", verifying: "검증 중", "waiting-user": "응답 대기",
	"between-rounds": "다음 라운드 대기", stopping: "종료 정리 중",
};
const PHASE_WORD_SHORT: Partial<Record<Phase, string>> = { "between-rounds": "다음 라운드" };
const PHASE_TONE: Record<Phase, Tone> = {
	working: "accent", workers: "accent", verifying: "success", "waiting-user": "warning", "between-rounds": "muted", stopping: "muted",
};
const STATE_WORD: Record<LaneState, string> = {
	reserved: "예약", waiting: "선행 대기", running: "작업 중", quiet: "조용", submitted: "제출", reviewing: "검토 중",
	accepted: "승인", unmet: "미충족", blocked: "막힘", excluded: "제외", idle: "유휴",
};
const STATE_TONE: Record<LaneState, Tone> = {
	reserved: "dim", waiting: "dim", running: "accent", quiet: "muted", submitted: "fg", reviewing: "success",
	accepted: "success", unmet: "warning", blocked: "error", excluded: "dim", idle: "dim",
};

/** The three radar tracks, kept as brightness fields: popcount of each braille cell. */
const RADAR_WORKING = "⠁⠈⠐⡀⣀⠤⠒⠉⠐⡀⣀⠤⠒⠉⠈⠂⠄⡀";
const RADAR_WORKERS = "⠠⠠⠤⠤⠤⠶⠶⠤⠤⠈⠈⠉⠉⠛⠛⠉⠉⠈";
const RADAR_TICK_MS = 85;

function dots(track: string, i: number): number {
	const n = track.length;
	let bits = track.codePointAt(((i % n) + n) % n)! - 0x2800;
	let count = 0;
	while (bits) {
		count += bits & 1;
		bits >>= 1;
	}
	return count;
}

function dimmer(tone: Tone): Tone {
	if (tone === "bright" || tone === "fg" || tone === "accent" || tone.startsWith("role")) return "muted";
	if (tone === "muted") return "dim";
	return tone;
}

function hashOf(text: string): number {
	let h = 0;
	for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) % 997;
	return h;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry

interface Geo {
	head: number;
	xf: (t: number) => number;
	col: (t: number) => number;
}

const MS_PER_COL = 1000;

function makeGeo(now: number, G: number): Geo {
	const last = G - 1;
	const fits = now <= last * MS_PER_COL;
	const recent = Math.floor(G * 0.6);
	const xf = (t: number): number => {
		const tt = Math.min(Math.max(t, 0), now);
		if (fits) return tt / MS_PER_COL;
		const age = now - tt;
		const recentMs = recent * MS_PER_COL;
		if (age <= recentMs) return last - age / MS_PER_COL;
		return (last - recent) * (1 - (age - recentMs) / (now - recentMs));
	};
	const col = (t: number): number => Math.min(last, Math.max(0, Math.floor(xf(t))));
	return { head: col(now), xf, col };
}

// ---------------------------------------------------------------------------------------------------------------
// Frame

interface Seg {
	state: LaneState;
	a: number;
	b: number;
	open: boolean;
	from: number;
}

interface LaneDraw {
	lane: Lane;
	row: number;
	cb: number;
	end: number;
	state: LaneState;
	stateFrom: number;
	segs: Seg[];
	terminal: "accepted" | "blocked" | "excluded" | undefined;
	connectorRows: number;
}

const FLASH_MS = 900;
const PINGPONG_MS = 2800;

export const frame: Frame = (snap, cols, t, opts) => {
	const { ascii, motion, paint } = opts;
	if (cols < 24) return [clip("Storm", cols, ascii)];
	const LW = cols >= 120 ? 24 : cols >= 100 ? 20 : cols >= 80 ? 18 : cols >= 60 ? 14 : 8;
	const RW = cols >= 100 ? 17 : cols >= 80 ? 13 : cols >= 60 ? 12 : 6;
	const G = Math.max(4, cols - LW - RW - 2);
	const geo = makeGeo(snap.now, G);
	const head = geo.head;
	const node = (name: NodeName): string => NODE[name][ascii ? 1 : 0];

	// Phase now.
	let phase: Phase = "working";
	let phaseFrom = 0;
	for (const p of snap.phases) {
		if (p.from <= snap.now) {
			phase = p.phase;
			phaseFrom = p.from;
		}
	}
	const live = motion && phase !== "waiting-user" && phase !== "between-rounds";
	const stopAge = phase === "stopping" ? snap.now - phaseFrom : 0;

	// Which lanes get a row.
	const maxLaneRows = Math.max(0, opts.maxRows - 1);
	const all = snap.lanes.filter((l) => l.spans.some((s) => s.from <= snap.now));
	const stateOf = (lane: Lane): LaneState => lastSpan(lane, snap.now).state;
	let shownLanes: Lane[] = all;
	let hidden: Lane[] = [];
	if (all.length > maxLaneRows) {
		const room = Math.max(0, maxLaneRows - 1);
		const priority = (s: LaneState): number => (s === "accepted" || s === "excluded" ? 2 : s === "waiting" || s === "reserved" || s === "idle" ? 1 : 0);
		const ranked = all.map((lane, i) => ({ lane, i })).sort((x, y) => priority(stateOf(x.lane)) - priority(stateOf(y.lane)) || x.i - y.i);
		const keep = new Set(ranked.slice(0, room).map((r) => r.lane));
		shownLanes = all.filter((l) => keep.has(l));
		hidden = all.filter((l) => !keep.has(l));
	}
	const rowCount = 1 + shownLanes.length + (hidden.length > 0 && maxLaneRows > 0 ? 1 : 0);
	const rows: Cell[][] = Array.from({ length: rowCount }, () => newRow(G));
	const rowOf = new Map<string, number>();
	shownLanes.forEach((l, i) => rowOf.set(l.name, i + 1));

	// --- Trunk static paint -------------------------------------------------------------------------------------
	const trunk = rows[0]!;
	for (let c = 0; c <= head; c++) {
		const cell = trunk[c]!;
		cell.r = c < head ? HEAVY : NONE;
		cell.l = c > 0 ? HEAVY : NONE;
		cell.tone = "accent";
		cell.bold = true;
	}
	const trunkNode = new Set<number>();

	const setNode = (cell: Cell, name: NodeName, tone: Tone, bold = false): void => {
		cell.glyph = node(name);
		cell.tone = tone;
		cell.bold = bold;
		cell.prio = 9;
	};

	// --- Lanes static paint -------------------------------------------------------------------------------------
	const draws: LaneDraw[] = [];
	for (const lane of shownLanes) {
		const row = rowOf.get(lane.name)!;
		const cells = rows[row]!;
		const spans = lane.spans.filter((s) => s.from <= snap.now);
		const first = spans[0]!;
		const lastS = spans[spans.length - 1]!;
		const roleTone = ROLE_TONE[lane.role];
		const cb = Math.min(geo.col(first.from), Math.max(0, head - 0));
		const terminal = lastS.state === "accepted" || lastS.state === "blocked" || lastS.state === "excluded" ? lastS.state : undefined;
		let end = head;
		if (terminal !== undefined) end = Math.min(head, Math.max(cb + 1, geo.col(lastS.from)));
		if (terminal === "accepted" && end <= cb) end = cb;
		const segs: Seg[] = [];
		const painted = terminal !== undefined ? spans.slice(0, -1) : spans;
		const strokeTone = (s: LaneState): { stroke: Stroke; tone: Tone; bold: boolean } => {
			switch (s) {
				case "reserved": return { stroke: DOT, tone: "muted", bold: false };
				case "waiting": return { stroke: DOT, tone: "dim", bold: false };
				case "running": return { stroke: LIGHT, tone: roleTone, bold: false };
				case "quiet": return { stroke: LIGHT, tone: roleTone, bold: false };
				case "submitted": return { stroke: DOUBLE, tone: roleTone, bold: false };
				case "reviewing": return { stroke: DOUBLE, tone: roleTone, bold: false };
				case "unmet": return { stroke: LIGHT, tone: "muted", bold: false };
				case "idle": return { stroke: THIN, tone: "dim", bold: false };
				default: return { stroke: LIGHT, tone: "muted", bold: false };
			}
		};
		for (const s of painted) {
			const open = s.to === undefined || s.to > snap.now;
			const a = Math.min(end, Math.max(cb, geo.col(s.from)));
			const b = open ? end : Math.min(end, Math.max(a, geo.col(s.to!)));
			const { stroke, tone, bold } = strokeTone(s.state);
			for (let c = a; c < b; c++) {
				cells[c]!.r = stroke;
				cells[c + 1]!.l = stroke;
			}
			for (let c = a; c <= b; c++) {
				cells[c]!.tone = tone;
				cells[c]!.bold = bold || (motion === false && open && s.state === "running");
				cells[c]!.prio = 2;
			}
			if (lane.job === true && s.state === "running") {
				for (let c = a + 1; c <= b; c++) {
					const cell = cells[c]!;
					if ((c - cb) % 2 === 1 && cell.u === NONE && cell.d === NONE && !(terminal === "accepted" && c === end)) cell.glyph = node("jobFill");
				}
			}
			if (s.state === "unmet") {
				const c = Math.min(end, Math.max(a, cb + 1));
				setNode(cells[c]!, lane.job === true ? "unmetJob" : "unmet", "warning", true);
			}
			segs.push({ state: s.state, a, b, open, from: s.from });
		}

		// Terminal ends.
		if (terminal === "blocked") setNode(cells[end]!, "blocked", "error", true);
		if (terminal === "excluded") {
			for (let c = cb; c <= end; c++) {
				const cell = cells[c]!;
				if (cell.r !== NONE) cell.r = DOT;
				if (cell.l !== NONE) cell.l = DOT;
				if (cell.glyph === node("jobFill")) cell.glyph = "";
				if (cell.prio < 9) {
					cell.tone = "dim";
					cell.bold = false;
				}
			}
			setNode(cells[end]!, "excluded", "dim");
		}
		if (terminal === "accepted") {
			cells[end]!.u = LIGHT;
			cells[end]!.prio = Math.max(cells[end]!.prio, 2);
			if (cells[end]!.tone === "fg") cells[end]!.tone = "muted";
			// A finished lane is history: its line goes quiet and the node on the trunk carries the result.
			for (let c = cb; c <= end; c++) {
				const cell = cells[c]!;
				if (cell.prio < 9) {
					cell.tone = dimmer(cell.tone);
					cell.bold = false;
				}
			}
			for (let r = 1; r < row; r++) {
				rows[r]![end]!.u = LIGHT;
				rows[r]![end]!.d = LIGHT;
				if (rows[r]![end]!.prio < 1) {
					rows[r]![end]!.tone = "muted";
					rows[r]![end]!.prio = 1;
				}
			}
			trunk[end]!.d = LIGHT;
			setNode(trunk[end]!, lane.job === true ? "acceptJob" : "accept", "success", true);
			trunkNode.add(end);
		}

		// Branch connector from the trunk down to this row.
		const firstStroke: Stroke = first.state === "reserved" || first.state === "waiting" ? DOT : LIGHT;
		const connTone = first.state === "waiting" ? "dim" : first.state === "reserved" ? "muted" : roleTone;
		trunk[cb]!.d = firstStroke;
		for (let r = 1; r < row; r++) {
			const cell = rows[r]![cb]!;
			cell.u = firstStroke;
			cell.d = firstStroke;
			if (cell.prio < 1) {
				cell.tone = connTone;
				cell.prio = 1;
			}
		}
		cells[cb]!.u = firstStroke;
		draws.push({ lane, row, cb, end, state: lastS.state, stateFrom: lastS.from, segs, terminal, connectorRows: row - 1 });

		// Head glyph at the open end.
		if (terminal === undefined && head > cb) {
			const hc = cells[head]!;
			if (lastS.state === "running") hc.glyph = node("runHead");
			else if (lastS.state === "quiet") hc.glyph = node("quietHead");
			else if (lastS.state === "reviewing") hc.glyph = node("diamond");
			if (hc.glyph !== "") {
				hc.bold = lastS.state !== "quiet";
			}
		}
	}

	// A folded lane still leaves its result on the trunk.
	for (const lane of hidden) {
		const acc = lastSpan(lane, snap.now);
		if (acc.state !== "accepted") continue;
		const c = Math.min(head, geo.col(acc.from));
		if (trunkNode.has(c)) continue;
		trunk[c]!.glyph = node(lane.job === true ? "acceptJob" : "accept");
		trunk[c]!.tone = "success";
		trunk[c]!.bold = true;
		trunk[c]!.prio = 9;
		trunkNode.add(c);
	}

	// Dotted links from the lane a waiting lane waits for.
	for (const d of draws) {
		for (const seg of d.segs) {
			if (seg.state !== "waiting") continue;
			const depDraw = d.lane.dependsOn.map((n) => draws.find((x) => x.lane.name === n)).find((x) => x !== undefined);
			if (depDraw === undefined) continue;
			// An open wait is tethered one column behind now so the heads at the open end stay visible.
			const c = seg.open ? Math.max(d.cb + 1, head - 1) : Math.min(head, Math.max(d.cb + 1, seg.b));
			const lo = Math.min(depDraw.row, d.row);
			const hi = Math.max(depDraw.row, d.row);
			for (let r = lo; r <= hi; r++) {
				const cell = rows[r]![c]!;
				if (r > lo) cell.u = DOT;
				if (r < hi) cell.d = DOT;
				if (cell.prio < 1) {
					cell.tone = "dim";
					cell.prio = 1;
				}
			}
		}
	}

	// Round ticks.
	snap.rounds.forEach((offset, i) => {
		const c = geo.col(offset);
		if (trunkNode.has(c)) return;
		const text = String(i + 1);
		const cell = trunk[c]!;
		cell.glyph = node("tick");
		cell.prio = 9;
		cell.bold = true;
		cell.tone = "fg";
		for (let k = 0; k < text.length; k++) {
			const nx = trunk[c + 1 + k];
			if (nx === undefined || c + 1 + k >= head || nx.prio >= 9 || nx.d !== NONE) break;
			nx.glyph = text[k]!;
			nx.prio = 9;
			nx.tone = "fg";
			nx.bold = false;
		}
	});

	// --- Effects: recolouring only ------------------------------------------------------------------------------
	const tickFrame = Math.floor(t / RADAR_TICK_MS);
	const pingPong = (period: number): number => {
		const ph = ((t % period) / period) * 2;
		return ph < 1 ? ph : 2 - ph;
	};
	const fx = (cell: Cell, tone: Tone, bold: boolean): void => {
		if (cell.prio >= 9) return;
		cell.tone = tone;
		cell.bold = bold;
	};
	const trunkFx = (c: number, tone: Tone, bold: boolean): void => {
		if (trunkNode.has(c)) return;
		const cell = trunk[c]!;
		if (cell.prio >= 9 && cell.glyph !== "") return;
		cell.tone = tone;
		cell.bold = bold;
	};

	// Trunk by phase.
	const len = head + 1;
	if (phase === "stopping") {
		const front = motion ? (stopAge / 3200) * len : 0;
		for (let c = 0; c <= head; c++) {
			if (!motion) trunkFx(c, "muted", false);
			else if (c < front - 1) trunkFx(c, "dim", false);
			else if (c < front + 1) trunkFx(c, "fg", true);
			else trunkFx(c, "muted", false);
		}
	} else if (phase === "between-rounds") {
		for (let c = 0; c <= head; c++) trunkFx(c, "dim", false);
	} else if (phase === "waiting-user") {
		for (let c = 0; c <= head; c++) trunkFx(c, "muted", false);
	} else if (!motion) {
		for (let c = 0; c <= head; c++) trunkFx(c, phase === "verifying" ? "muted" : "accent", phase !== "verifying");
	} else if (phase === "working") {
		const roll = tickFrame * 2;
		for (let c = 0; c <= head; c++) trunkFx(c, dots(RADAR_WORKING, c - roll) >= 2 ? "accent" : "muted", false);
		const hp = Math.floor(((t % 2400) / 2400) * (len + 5)) - 2;
		for (let c = Math.max(0, hp - 3); c <= Math.min(head, hp + 2); c++) {
			if (c === hp) trunkFx(c, "bright", true);
			else trunkFx(c, "bright", false);
		}
	} else if (phase === "workers") {
		const breath = 0.5 + 0.5 * Math.sin((t / 3200) * Math.PI * 2);
		const drift = Math.floor(t / 340);
		for (let c = 0; c <= head; c++) {
			const v = 0.55 * breath + 0.45 * (dots(RADAR_WORKERS, c - drift) / 4);
			if (v < 0.35) trunkFx(c, "dim", false);
			else if (v < 0.6) trunkFx(c, "muted", false);
			else if (v < 0.82) trunkFx(c, "accent", false);
			else trunkFx(c, "bright", true);
		}
	} else if (phase === "verifying") {
		const hp = Math.round(pingPong(PINGPONG_MS) * head);
		for (let c = 0; c <= head; c++) {
			const dist = Math.abs(c - hp);
			if (dist === 0) trunkFx(c, "success", true);
			else if (dist <= 3) trunkFx(c, "success", false);
			else trunkFx(c, "muted", false);
		}
	}

	// Trunk head glyph, a still cue for the phase.
	{
		const hc = trunk[head]!;
		if (!trunkNode.has(head) && hc.prio < 9) {
			if (phase === "waiting-user") {
				hc.glyph = node("block");
				hc.tone = "warning";
				hc.bold = true;
			} else if (phase === "working") hc.glyph = node("runHead");
			else if (phase === "verifying") hc.glyph = node("diamond");
			else if (phase === "workers") hc.glyph = ascii ? "#" : "━";
			else if (phase === "stopping") hc.glyph = ascii ? ":" : "╸";
			else if (phase === "between-rounds") hc.glyph = ascii ? "." : "╸";
		}
	}

	// Lane effects.
	for (const d of draws) {
		const cells = rows[d.row]!;
		const roleTone = ROLE_TONE[d.lane.role];
		const darkAt = 450 * (d.row - 1);
		const dark = phase === "stopping" && stopAge > darkAt;
		const calm = phase === "between-rounds";
		if (dark) {
			for (let c = d.cb; c <= d.end; c++) fx(cells[c]!, "dim", false);
			for (let r = 1; r < d.row; r++) {
				const cell = rows[r]![d.cb]!;
				if (cell.prio < 2 && cell.u !== NONE) fx(cell, "dim", false);
			}
			if (cells[d.end]!.glyph === node("runHead") || cells[d.end]!.glyph === node("quietHead")) cells[d.end]!.glyph = ascii ? "." : "·";
			continue;
		}
		if (calm) {
			for (let c = d.cb; c <= d.end; c++) {
				const cell = cells[c]!;
				if (cell.prio < 9) {
					cell.tone = dimmer(cell.tone);
					cell.bold = false;
				}
			}
			continue;
		}
		const animate = live || (motion && phase === "stopping");
		if (!animate) continue;
		const open = d.segs.find((s) => s.open);
		if (d.terminal === undefined && open !== undefined) {
			if (open.state === "running") {
				const act = d.lane.activity ?? 0.5;
				const level = act < 0.34 ? 0 : act < 0.67 ? 1 : 2;
				const speed = [8, 13, 20][level]!;
				const period = [12, 9, 7][level]!;
				const seed = hashOf(d.lane.name) % period;
				const pulse = (dist: number): { tone: Tone; bold: boolean } => {
					const pos = (((speed * t) / 1000 - dist + seed) % period + period) % period;
					if (pos < 1) return { tone: "bright", bold: true };
					if (pos < 3) return { tone: roleTone, bold: true };
					return { tone: roleTone, bold: false };
				};
				for (let r = 1; r < d.row; r++) {
					const cell = rows[r]![d.cb]!;
					if (cell.u === DOT || cell.prio >= 9 || cell.glyph !== "") continue;
					const p = pulse(r - 1);
					fx(cell, p.tone, p.bold);
				}
				for (let c = d.cb; c <= open.b; c++) {
					const p = pulse(d.connectorRows + (c - d.cb));
					fx(cells[c]!, p.tone, p.bold);
				}
				if (d.lane.job === true) {
					const nodes: number[] = [];
					for (let c = open.a + 1; c <= open.b; c++) if ((c - d.cb) % 2 === 1 && cells[c]!.glyph !== "" && cells[c]!.prio < 9) nodes.push(c);
					const pos = Math.floor(t / 260) % (nodes.length + 1);
					nodes.forEach((c, i) => {
						if (c === head) return;
						cells[c]!.glyph = i < pos ? node("jobFill") : node("jobHollow");
					});
				}
			} else if (open.state === "quiet") {
				const breath = 0.5 + 0.5 * Math.sin((t / 3000) * Math.PI * 2);
				fx(cells[head]!, breath < 0.33 ? "dim" : breath < 0.66 ? "muted" : roleTone, breath > 0.66);
			} else if (open.state === "reviewing") {
				const span = Math.max(1, open.b - open.a);
				const pos = open.a + Math.round(pingPong(PINGPONG_MS) * span);
				for (let c = open.a; c <= open.b; c++) {
					const dist = Math.abs(c - pos);
					if (dist === 0) fx(cells[c]!, "success", true);
					else if (dist <= 2) fx(cells[c]!, "success", false);
				}
			}
		}
		// Flash at the moment a lane blocks.
		if (d.terminal === "blocked" && motion) {
			const age = snap.now - d.stateFrom;
			if (age >= 0 && age < FLASH_MS) {
				const cell = cells[d.end]!;
				cell.tone = Math.floor(age / 150) % 2 === 0 ? "bright" : "error";
				cell.bold = true;
			}
		}
	}

	// Flash along the trunk when a lane joins, and new round ticks.
	if (motion && live) {
		for (const d of draws) {
			if (d.terminal !== "accepted") continue;
			const age = snap.now - d.stateFrom;
			if (age < 0 || age >= FLASH_MS) continue;
			const radius = age / 28;
			for (let c = 0; c <= head; c++) {
				const dist = Math.abs(c - d.end);
				if (dist <= radius && dist >= radius - 4) trunkFx(c, "success", true);
			}
		}
	}
	if (motion) {
		snap.rounds.forEach((offset, i) => {
			if (i === 0) return;
			const age = snap.now - offset;
			if (age >= 0 && age < FLASH_MS) {
				const c = geo.col(offset);
				const cell = trunk[c]!;
				if (cell.prio >= 9 && !trunkNode.has(c)) {
					cell.tone = "bright";
					cell.bold = true;
				}
			}
		});
	}

	// Folded summary row.
	if (hidden.length > 0 && maxLaneRows > 0) {
		const cells = rows[rowCount - 1]!;
		hidden.slice(0, Math.floor(G / 2)).forEach((lane, i) => {
			const cell = cells[i * 2]!;
			const s = stateOf(lane);
			cell.prio = 9;
			cell.bold = false;
			switch (s) {
				case "accepted": cell.glyph = node("accept"); cell.tone = "success"; break;
				case "excluded": cell.glyph = node("excluded"); cell.tone = "dim"; break;
				case "blocked": cell.glyph = node("blocked"); cell.tone = "error"; break;
				case "unmet": cell.glyph = node("unmet"); cell.tone = "warning"; break;
				case "running":
					cell.glyph = node("runHead");
					cell.tone = live && Math.floor(t / 300 + i) % 2 === 0 ? "bright" : ROLE_TONE[lane.role];
					cell.bold = true;
					break;
				case "quiet": cell.glyph = node("quietHead"); cell.tone = "muted"; break;
				case "reviewing": cell.glyph = node("diamond"); cell.tone = "success"; break;
				case "submitted": cell.glyph = ascii ? "=" : "═"; cell.tone = "fg"; break;
				default: cell.glyph = ascii ? "." : "┈"; cell.tone = "dim";
			}
		});
	}

	// --- Assemble -----------------------------------------------------------------------------------------------
	const graph = (cells: readonly Cell[]): string => {
		let out = "";
		let run = "";
		let key = "";
		let tone: Tone = "fg";
		let bold = false;
		const flush = (): void => {
			if (run !== "") out += paint(tone, run, bold);
			run = "";
		};
		for (const cell of cells) {
			const g = glyphOf(cell, ascii);
			if (g === " ") {
				run += g;
				continue;
			}
			const k = `${cell.tone}|${cell.bold}`;
			if (k !== key) {
				flush();
				key = k;
				tone = cell.tone;
				bold = cell.bold;
			}
			run += g;
		}
		flush();
		return out;
	};
	const pad = (text: string, w: number): string => text + " ".repeat(Math.max(0, w - width(text)));
	const lines: string[] = [];

	// Trunk row.
	{
		const costText = `$${snap.costUsd.toFixed(2)}`;
		let label = `디렉터 ${snap.counts.accepted}/${snap.counts.inScope}`;
		if (width(label) + 1 + width(costText) <= LW) label += ` ${costText}`;
		label = clip(label, LW, ascii);
		const word = RW < 16 ? PHASE_WORD_SHORT[phase] ?? PHASE_WORD[phase] : PHASE_WORD[phase];
		lines.push(paint("bright", pad(label, LW), true) + " " + graph(trunk) + " " + paint(PHASE_TONE[phase], clip(word, RW, ascii), true));
	}
	shownLanes.forEach((lane) => {
		const row = rowOf.get(lane.name)!;
		const s = stateOf(lane);
		const roleWord = ROLE_WORD[lane.role];
		const nameRoom = LW - width(roleWord) - 1;
		const name = clip(lane.name, nameRoom, ascii);
		const gap = " ".repeat(Math.max(1, LW - width(name) - width(roleWord)));
		const finished = s === "accepted" || s === "excluded";
		const d = draws.find((x) => x.lane === lane)!;
		const darkName = phase === "stopping" && stopAge > 450 * (d.row - 1);
		const nameTone: Tone = darkName ? "dim" : finished || phase === "between-rounds" ? "muted" : "fg";
		const word = clip(STATE_WORD[s], RW, ascii);
		const wordTone: Tone = darkName ? "dim" : phase === "between-rounds" ? dimmer(STATE_TONE[s]) : STATE_TONE[s];
		lines.push(
			paint(nameTone, name) + gap + paint(darkName ? "dim" : ROLE_TONE[lane.role], roleWord) + " " + graph(rows[row]!) + " " +
			paint(wordTone, word, s === "blocked" || s === "unmet"),
		);
	});
	if (hidden.length > 0 && maxLaneRows > 0) {
		const cells = rows[rowCount - 1]!;
		const count = (s: LaneState): number => hidden.filter((l) => stateOf(l) === s).length;
		const parts: string[] = [];
		const running = hidden.filter((l) => ["running", "quiet", "reviewing", "submitted", "unmet"].includes(stateOf(l))).length;
		if (running > 0) parts.push(`진행 ${running}`);
		if (count("accepted") > 0) parts.push(`승인 ${count("accepted")}`);
		const rest = hidden.length - running - count("accepted");
		if (rest > 0) parts.push(`기타 ${rest}`);
		const label = clip(`+${hidden.length} 레인 접힘`, LW, ascii);
		lines.push(paint("muted", pad(label, LW)) + " " + graph(cells) + " " + paint("muted", clip(parts.join(" "), RW, ascii)));
	}
	return lines;
};

function lastSpan(lane: Lane, now: number): LaneSpan {
	let found = lane.spans[0]!;
	for (const s of lane.spans) if (s.from <= now) found = s;
	return found;
}
