/**
 * A plain terminal player for the lane view.
 *
 *   node_modules/.bin/bun spikes/l0/play.ts --variant box|braille|storm [--width N] [--rows N] [--ascii] [--no-motion]
 *       [--speed X] [--scenario full|happy|crowd] [--light] [--colour auto|truecolor|256|tones] [--still MS]
 *       [--bytes] [--svg FILE]
 *
 * It redraws in place at the radar's 85 ms tick and restores the terminal on exit. The colour mode follows the
 * environment (`COLORTERM`, `TERM`, `NO_COLOR`); `--colour` forces one, `--light` draws for a light terminal.
 * `--still MS` prints the one frame the scenario shows at MS milliseconds and exits: without colour codes unless
 * `--colour` is given. `--bytes` adds the size of that frame to stderr. `--svg FILE` (with `--still`) writes the frame
 * as an SVG picture instead: monospace text, one glyph per cell in its colour, on the terminal background colour
 * (truecolor unless `--colour` says otherwise). While a variant file does not exist the player draws a placeholder.
 */
import { writeFileSync } from "node:fs";
import type { Frame, FrameOptions, LaneState, Phase, RunSnapshot, Tone } from "./model.ts";
import { type ColorDepth, detectColorDepth, plainPaint } from "./palette.ts";
import { type ScenarioName, SCENARIOS, scenarioMs, snapshotAt } from "./scenario.ts";
import { lookOf } from "./storm/colour.ts";

export const TICK_MS = 85;
export const VARIANTS = ["box", "braille", "storm"] as const;
export type Variant = (typeof VARIANTS)[number];

const PHASE_LABEL: Record<Phase, string> = {
	working: "진행 중",
	workers: "워커 작업 중",
	verifying: "검증 중",
	"waiting-user": "응답 대기",
	"between-rounds": "다음 라운드 대기",
	stopping: "종료 정리 중",
};

const STATE_WORD: Record<LaneState, string> = {
	reserved: "예약",
	waiting: "선행 대기",
	running: "작업 중",
	quiet: "조용",
	submitted: "제출",
	reviewing: "검토 중",
	accepted: "승인",
	unmet: "미충족",
	blocked: "막힘",
	excluded: "제외",
	idle: "유휴",
};

const STATE_TONE: Record<LaneState, Tone> = {
	reserved: "dim", waiting: "dim", running: "accent", quiet: "muted", submitted: "fg", reviewing: "success",
	accepted: "success", unmet: "warning", blocked: "error", excluded: "dim", idle: "dim",
};

const ROLE_TONE = { explorer: "role1", implementer: "role2", reviewer: "role3", quick: "role4", architect: "role5" } as const;

/** Terminal cells of a string: Hangul and other wide characters take two. */
export function cells(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1;
	}
	return width;
}

/** Stands in for a variant that is not written yet: a trunk row with the phase, one plain row per lane, no motion. */
export const placeholderFrame: Frame = (snapshot, cols, _t, options) => {
	const { paint } = options;
	const phase = snapshot.phases[snapshot.phases.length - 1]?.phase ?? "working";
	const head = ` ${PHASE_LABEL[phase]} · 라운드 ${snapshot.rounds.length} `;
	const rows = [paint("accent", "━".repeat(2), true) + paint("fg", head, true) + paint("accent", "━".repeat(Math.max(0, cols - 2 - cells(head))))];
	const room = Math.max(0, options.maxRows - 1);
	const shown = snapshot.lanes.length > room ? room - 1 : snapshot.lanes.length;
	for (const lane of snapshot.lanes.slice(0, shown)) {
		const state = lane.spans[lane.spans.length - 1]!.state;
		const label = `${lane.name} ${lane.role}`;
		const word = STATE_WORD[state];
		const pad = Math.max(1, cols - cells(label) - cells(word) - 4);
		rows.push(`  ${paint(ROLE_TONE[lane.role], label)}${" ".repeat(pad)}${paint(STATE_TONE[state], word)}`);
	}
	if (shown < snapshot.lanes.length) rows.push(paint("muted", `  … 외 ${snapshot.lanes.length - shown}개`));
	return rows.map(row => (cells(row.replace(/\x1b\[[0-9;]*m/g, "")) > cols ? row.slice(0, cols) : row));
};

/** Loads `./<variant>/frame.ts` and returns its `frame`, or undefined while the file or its export is missing. */
export async function loadFrame(variant: Variant): Promise<Frame | undefined> {
	const path = `./${variant}/frame.ts`;
	try {
		const mod: unknown = await import(path);
		const frame = typeof mod === "object" && mod !== null ? (mod as { frame?: unknown }).frame : undefined;
		return typeof frame === "function" ? (frame as Frame) : undefined;
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /Cannot find module/.test(String(error))) return undefined;
		throw error;
	}
}

interface Args {
	variant: Variant;
	width: number | undefined;
	rows: number;
	ascii: boolean;
	motion: boolean;
	speed: number;
	still: number | undefined;
	scenario: ScenarioName;
	dark: boolean;
	colour: FrameOptions["colour"] | undefined;
	bytes: boolean;
	svg: string | undefined;
}

function parseArgs(argv: readonly string[]): Args | string {
	const args: Args = { variant: "box", width: undefined, rows: 10, ascii: false, motion: true, speed: 1, still: undefined, scenario: "full", dark: true, colour: undefined, bytes: false, svg: undefined };
	const number = (flag: string, value: string | undefined): number | string => {
		const parsed = Number(value);
		return value === undefined || !Number.isFinite(parsed) ? `${flag} needs a number` : parsed;
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		const next = argv[i + 1];
		const numeric = flag === "--width" || flag === "--rows" || flag === "--speed" || flag === "--still";
		const value = numeric ? number(flag, next) : 0;
		if (typeof value === "string") return value;
		if (numeric) i++;
		if (flag === "--variant") {
			if (!(VARIANTS as readonly (string | undefined)[]).includes(next)) return `--variant needs ${VARIANTS.join(", ")}`;
			args.variant = next as Variant;
			i++;
		} else if (flag === "--scenario") {
			if (!(SCENARIOS as readonly (string | undefined)[]).includes(next)) return `--scenario needs ${SCENARIOS.join(", ")}`;
			args.scenario = next as ScenarioName;
			i++;
		} else if (flag === "--colour" || flag === "--color") {
			if (next !== "auto" && next !== "truecolor" && next !== "256" && next !== "tones") return "--colour needs auto, truecolor, 256 or tones";
			args.colour = next === "auto" ? undefined : next;
			i++;
		} else if (flag === "--svg") {
			if (next === undefined || next.startsWith("--")) return "--svg needs a file name";
			args.svg = next;
			i++;
		} else if (flag === "--light") args.dark = false;
		else if (flag === "--bytes") args.bytes = true; else if (flag === "--width") args.width = Math.max(1, Math.floor(value));
		else if (flag === "--rows") args.rows = Math.max(1, Math.floor(value));
		else if (flag === "--speed") args.speed = value > 0 ? value : 1;
		else if (flag === "--still") args.still = value;
		else if (flag === "--ascii") args.ascii = true;
		else if (flag === "--no-motion") args.motion = false;
		else return `unknown argument ${flag}`;
	}
	if (args.svg !== undefined && args.still === undefined) return "--svg needs --still MS";
	return args;
}

/** What `FrameOptions.colour` a variant is told for a depth the terminal supports. */
function colourOf(depth: ColorDepth): NonNullable<FrameOptions["colour"]> {
	return depth === "truecolor" ? "truecolor" : depth === "256" ? "256" : "tones";
}

/**
 * The colour mode and the tone painter for a run. Live: the environment decides, `--colour` overrides. A still frame is
 * plain text unless `--colour` or `--svg` asks for colour; `--colour tones` there paints the tones in truecolor.
 */
function colourSetup(args: Args): { colour: NonNullable<FrameOptions["colour"]>; paint: FrameOptions["paint"] } {
	const detected = detectColorDepth();
	const live = args.still === undefined;
	const wanted = args.colour ?? (args.svg !== undefined ? "truecolor" : live ? colourOf(detected) : undefined);
	if (wanted === undefined) return { colour: "tones", paint: plainPaint("none") };
	if (wanted === "tones") return { colour: "tones", paint: plainPaint(live ? detected : "truecolor", args.dark) };
	return { colour: wanted, paint: plainPaint(wanted === "256" ? "256" : "truecolor", args.dark) };
}

// ---------------------------------------------------------------------------------------------------------------
// SVG still
// ---------------------------------------------------------------------------------------------------------------

const ANSI16 = [
	0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5,
	0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

function xtermRgb(index: number): number {
	if (index < 16) return ANSI16[index]!;
	if (index >= 232) {
		const v = 8 + (index - 232) * 10;
		return (v << 16) | (v << 8) | v;
	}
	const level = (n: number): number => (n === 0 ? 0 : 55 + 40 * n);
	const n = index - 16;
	return (level(Math.floor(n / 36)) << 16) | (level(Math.floor(n / 6) % 6) << 8) | level(n % 6);
}

interface StyledCell { glyph: string; width: number; colour: number; bold: boolean }

/** Splits an ANSI-coloured line into one record per glyph; understands reset, bold, default, 38;2 and 38;5. */
function parseAnsi(line: string, fallback: number): StyledCell[] {
	const out: StyledCell[] = [];
	let colour = fallback;
	let bold = false;
	let at = 0;
	const sgr = /\x1b\[([0-9;]*)m/y;
	while (at < line.length) {
		if (line.charCodeAt(at) === 0x1b) {
			sgr.lastIndex = at;
			const match = sgr.exec(line);
			if (match === null) {
				at++;
				continue;
			}
			const codes = match[1]!.split(";").map(Number);
			for (let k = 0; k < codes.length; k++) {
				const code = codes[k]!;
				if (code === 0 || code === 39) {
					colour = fallback;
					if (code === 0) bold = false;
				} else if (code === 1) bold = true;
				else if (code === 22) bold = false;
				else if (code === 38 && codes[k + 1] === 2) {
					colour = ((codes[k + 2] ?? 0) << 16) | ((codes[k + 3] ?? 0) << 8) | (codes[k + 4] ?? 0);
					k += 4;
				} else if (code === 38 && codes[k + 1] === 5) {
					colour = xtermRgb(codes[k + 2] ?? 0);
					k += 2;
				}
			}
			at += match[0].length;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(at)!);
		at += char.length;
		out.push({ glyph: char, width: cells(char), colour, bold });
	}
	return out;
}

const SVG_FONT_SIZE = 18;
const SVG_CELL_W = 10.8;
const SVG_CELL_H = 22;
const PNG_PX = 2400;

/** The two commands that turn the SVG into a PNG of exactly the picture (macOS: `qlmanage`, then `sips`). */
function svgHint(file: string, cols: number, rows: number): string {
	const width = cols * SVG_CELL_W + 20;
	const height = rows * SVG_CELL_H + 20;
	const side = Math.max(width, height);
	const crop = (n: number): number => Math.ceil((n / side) * PNG_PX);
	return `png: qlmanage -t -s ${PNG_PX} -o DIR ${file} && sips -c ${crop(height)} ${crop(width)} DIR/${file.split("/").pop()}.png`;
}

export function svgOf(lines: readonly string[], cols: number, dark: boolean): string {
	const background = lookOf(dark).background;
	const fallback = dark ? 0xd4d4d4 : 0x2b2f36;
	const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, "0")}`;
	const width = Math.ceil(cols * SVG_CELL_W + 20);
	const height = Math.ceil(lines.length * SVG_CELL_H + 20);
	const body: string[] = [];
	lines.forEach((line, row) => {
		let column = 0;
		for (const cell of parseAnsi(line, fallback)) {
			if (cell.glyph !== " ") {
				const x = 10 + (column + cell.width / 2) * SVG_CELL_W;
				const y = 10 + row * SVG_CELL_H + SVG_CELL_H * 0.78;
				const glyph = cell.glyph === "&" ? "&amp;" : cell.glyph === "<" ? "&lt;" : cell.glyph === ">" ? "&gt;" : cell.glyph;
				body.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${hex(cell.colour)}"${cell.bold ? ' font-weight="bold"' : ""}>${glyph}</text>`);
			}
			column += cell.width;
		}
	});
	// qlmanage scales a non-square SVG wrongly, so the picture sits in the middle of a square of the background colour;
	// `sips -c` crops around the centre, which cuts the square back to the picture (see `svgHint`).
	const side = Math.max(width, height);
	const shift = `translate(${((side - width) / 2).toFixed(1)} ${((side - height) / 2).toFixed(1)})`;
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">`,
		`<rect width="100%" height="100%" fill="${hex(background)}"/>`,
		`<g transform="${shift}" font-family="Menlo, 'Apple Braille', 'Apple SD Gothic Neo', monospace" font-size="${SVG_FONT_SIZE}" text-anchor="middle">`,
		...body,
		"</g>",
		"</svg>",
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	if (typeof parsed === "string") {
		process.stderr.write(`${parsed}\nusage: bun spikes/l0/play.ts --variant box|braille|storm [--width N] [--rows N] [--ascii] [--no-motion] [--speed X] [--scenario full|happy|crowd] [--light] [--colour auto|truecolor|256|tones] [--still MS] [--bytes] [--svg FILE]\n`);
		process.exit(2);
	}
	const args = parsed;
	const loaded = await loadFrame(args.variant);
	const frame = loaded ?? placeholderFrame;
	const note = loaded === undefined ? `variant "${args.variant}" does not exist yet (spikes/l0/${args.variant}/frame.ts): showing a placeholder frame` : undefined;
	const columns = (): number => args.width ?? Math.max(20, process.stdout.columns ?? 100);
	const { colour, paint } = colourSetup(args);
	const optionsFor = (): FrameOptions => ({ ascii: args.ascii, motion: args.motion, maxRows: args.rows, paint, colour, dark: args.dark });

	if (args.still !== undefined) {
		const t = args.still;
		const width = columns();
		const out = frame(snapshotAt(t, args.scenario), width, t, optionsFor());
		if (note !== undefined) process.stderr.write(`${note}\n`);
		if (args.svg !== undefined) {
			writeFileSync(args.svg, svgOf(out, width, args.dark));
			process.stderr.write(`wrote ${args.svg} (${width} columns, ${out.length} rows)\n${svgHint(args.svg, width, out.length)}\n`);
		} else process.stdout.write(`${out.join("\n")}\n`);
		if (args.bytes) process.stderr.write(`frame bytes: ${Buffer.byteLength(`${out.join("\n")}\n`)} (${colour})\n`);
		return;
	}

	if (note !== undefined) process.stdout.write(`${note}\n`);
	const length = scenarioMs(args.scenario);
	const startedAt = Date.now();
	let drawn = 0;
	let stopped = false;
	const draw = (): void => {
		const t = (Date.now() - startedAt) * args.speed;
		const snapshot: RunSnapshot = snapshotAt(t, args.scenario);
		const lines = [...frame(snapshot, columns(), t, optionsFor())];
		const clock = `${(snapshot.now / 1000).toFixed(1).padStart(4)}s / ${length / 1000}s  ×${args.speed}  ${args.variant}  ${args.scenario}  (Ctrl+C: 종료)`;
		lines.push(paint("dim", clock));
		let out = drawn > 0 ? `\x1b[${drawn}A\r` : "";
		out += lines.map(line => `${line}\x1b[K`).join("\n") + "\n";
		if (lines.length < drawn) out += "\x1b[J";
		drawn = lines.length;
		process.stdout.write(out);
	};
	const restore = (): void => {
		if (stopped) return;
		stopped = true;
		process.stdout.write("\x1b[0m\x1b[?25h");
	};
	process.stdout.write("\x1b[?25l");
	process.on("exit", restore);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
	draw();
	setInterval(draw, TICK_MS);
}

if (import.meta.main) await main();
