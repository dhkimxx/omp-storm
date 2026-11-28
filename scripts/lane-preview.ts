/**
 * A plain terminal player for the lane view: the product renderer (`laneViewFrame`: the stage and the lane graph) fed
 * with scripted runs.
 *
 *   node_modules/.bin/bun scripts/lane-preview.ts [--scenario full|happy|crowd|octopus|bee|ant|orca|owl|tour|handoffs]
 *       [--width N] [--rows N] [--speed X] [--no-motion] [--light] [--colour auto|truecolor|256] [--tier t2|t3]
 *       [--still MS] [--svg FILE] [--png FILE]
 *
 * It redraws in place at the widget's 85 ms tick and restores the terminal on exit; under the picture it prints the
 * run clock, how lively the renderer says the picture is, the stage's tier and art, and its one-line phrase. The stage
 * shows from 89 columns. The colour mode follows the environment (`COLORTERM`,
 * `TERM`, `NO_COLOR`); `--colour` forces one, `--light` draws for a light terminal. `--tier` picks the stage's text
 * tier: `t3` braille (default) or `t2` half blocks. The art is the baked art when `assets/stage/index.json` exists
 * (sequences not baked yet fall back to the placeholder shapes), else the placeholder. `--still MS` prints the one frame
 * the scenario shows at MS milliseconds and exits: without colour codes unless `--colour` is given. `--svg FILE` (with
 * `--still`) writes the frame as an SVG picture instead: one glyph per cell in its colour, on the terminal background
 * colour (truecolor unless `--colour` says otherwise), and prints the two commands that turn it into a PNG. `--png FILE`
 * (with `--still`) writes the T1 stage picture at that moment as the indexed PNG the terminal would receive, and prints
 * its size against the 32 KiB frame budget.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { textWidth } from "../src/view/lane/canvas.ts";
import { lookOf } from "../src/view/lane/colour.ts";
import { type LaneFrameOptions, laneViewFrame, laneViewLiveliness, laneViewParts } from "../src/view/lane/frame.ts";
import { STAGE_ASSETS_DIR } from "../src/view/stage/baked.ts";
import { castLine } from "../src/view/stage/cast.ts";
import { stageLaneColours, stagePicture } from "../src/view/stage/render-pixels.ts";
import { stageAt } from "../src/view/stage/sequencer.ts";
import { encodeStageFrame, FRAME_BUDGET_BYTES } from "../src/view/stage/t1.ts";
import { type ScenarioName, SCENARIOS, scenarioMs, snapshotAt } from "./lane-preview-scenario.ts";

export const TICK_MS = 85;
type Colour = LaneFrameOptions["colour"];

interface Args {
	width: number | undefined;
	rows: number;
	motion: boolean;
	speed: number;
	still: number | undefined;
	scenario: ScenarioName;
	dark: boolean;
	colour: Colour | undefined;
	svg: string | undefined;
	png: string | undefined;
	tier: "t2" | "t3";
}

const USAGE = `usage: bun scripts/lane-preview.ts [--scenario ${SCENARIOS.join("|")}] [--width N] [--rows N] [--speed X] [--no-motion] [--light] [--colour auto|truecolor|256] [--tier t2|t3] [--still MS] [--svg FILE] [--png FILE]`;

function parseArgs(argv: readonly string[]): Args | string {
	const args: Args = { width: undefined, rows: 10, motion: true, speed: 1, still: undefined, scenario: "full", dark: true, colour: undefined, svg: undefined, png: undefined, tier: "t3" };
	const numbers = new Set(["--width", "--rows", "--speed", "--still"]);
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		const next = argv[i + 1];
		let value = 0;
		if (numbers.has(flag)) {
			value = Number(next);
			if (next === undefined || !Number.isFinite(value)) return `${flag} needs a number`;
			i++;
		}
		if (flag === "--scenario") {
			if (!(SCENARIOS as readonly (string | undefined)[]).includes(next)) return `--scenario needs ${SCENARIOS.join(", ")}`;
			args.scenario = next as ScenarioName;
			i++;
		} else if (flag === "--colour" || flag === "--color") {
			if (next !== "auto" && next !== "truecolor" && next !== "256") return "--colour needs auto, truecolor or 256";
			args.colour = next === "auto" ? undefined : next;
			i++;
		} else if (flag === "--svg" || flag === "--png") {
			if (next === undefined || next.startsWith("--")) return `${flag} needs a file name`;
			if (flag === "--svg") args.svg = next;
			else args.png = next;
			i++;
		} else if (flag === "--tier") {
			if (next !== "t2" && next !== "t3") return "--tier needs t2 or t3";
			args.tier = next;
			i++;
		} else if (flag === "--light") args.dark = false;
		else if (flag === "--no-motion") args.motion = false;
		else if (flag === "--width") args.width = Math.max(1, Math.floor(value));
		else if (flag === "--rows") args.rows = Math.max(1, Math.floor(value));
		else if (flag === "--speed") args.speed = value > 0 ? value : 1;
		else if (flag === "--still") args.still = value;
		else return `unknown argument ${flag}`;
	}
	if (args.svg !== undefined && args.still === undefined) return "--svg needs --still MS";
	if (args.png !== undefined && args.still === undefined) return "--png needs --still MS";
	return args;
}

/** The colour depth the environment supports, as the lane view wants it: true colour or 256 colours. */
function detectColour(env: NodeJS.ProcessEnv = process.env): Colour {
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
	if ((env.TERM ?? "").includes("256")) return "256";
	return "truecolor";
}

const ANSI = /\x1b\[[0-9;]*m/g;

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
		out.push({ glyph: char, width: textWidth(char), colour, bold });
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

// ---------------------------------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------------------------------

/** Which art the stage draws with: the baked index's sequence count, or the placeholder shapes. */
function artName(): string {
	const index = new URL("index.json", STAGE_ASSETS_DIR);
	if (!existsSync(index)) return "placeholder art";
	try {
		const parsed: unknown = JSON.parse(readFileSync(index, "utf8"));
		const sequences = typeof parsed === "object" && parsed !== null && "sequences" in parsed && typeof parsed.sequences === "object" && parsed.sequences !== null
			? Object.keys(parsed.sequences).length
			: 0;
		return `baked art (${sequences} sequences, the rest placeholder)`;
	} catch {
		return "placeholder art (unreadable index)";
	}
}

function main(): void {
	const parsed = parseArgs(process.argv.slice(2));
	if (typeof parsed === "string") {
		process.stderr.write(`${parsed}\n${USAGE}\n`);
		process.exit(2);
	}
	const args = parsed;
	const columns = (): number => args.width ?? Math.max(20, process.stdout.columns ?? 100);
	const options = (colour: Colour): LaneFrameOptions => ({ motion: args.motion, maxRows: args.rows, colour, dark: args.dark });

	if (args.still !== undefined) {
		const t = args.still;
		const width = columns();
		const colour: Colour = args.colour ?? "truecolor";
		const snapshot = snapshotAt(t, args.scenario);
		if (args.png !== undefined) {
			const parts = laneViewParts(snapshot, width, t, options(colour));
			if (parts === undefined) {
				process.stderr.write(`no stage at ${width} columns and ${args.rows} rows\n`);
				process.exit(2);
			}
			const picture = stagePicture(snapshot, parts.stageCols, parts.rows - 1, t, { motion: args.motion, dark: args.dark }, "t1");
			const data = encodeStageFrame({ w: picture.w, h: picture.h, rgb: picture.rgb, dark: args.dark, laneColours: stageLaneColours(snapshot, args.dark) });
			writeFileSync(args.png, Buffer.from(data, "base64"));
			const kib = (data.length / 1024).toFixed(1);
			process.stderr.write(`wrote ${args.png} (${picture.w}x${picture.h} px, stage ${parts.stageCols}x${parts.rows - 1} cells + phrase row, ${kib} KiB base64 of the ${FRAME_BUDGET_BYTES / 1024} KiB frame budget, ${artName()}): ${picture.phrase}\n`);
			return;
		}
		const lines = laneViewFrame(snapshot, width, t, options(colour), args.tier);
		if (args.svg !== undefined) {
			writeFileSync(args.svg, svgOf(lines, width, args.dark));
			process.stderr.write(`wrote ${args.svg} (${width} columns, ${lines.length} rows)\n${svgHint(args.svg, width, lines.length)}\n`);
		} else {
			const plain = args.colour === undefined;
			process.stdout.write(`${(plain ? lines.map((line) => line.replace(ANSI, "")) : lines).join("\n")}\n`);
		}
		return;
	}

	const colour = args.colour ?? detectColour();
	const length = scenarioMs(args.scenario);
	const art = artName();
	const startedAt = Date.now();
	let drawn = 0;
	let stopped = false;
	const draw = (): void => {
		const t = (Date.now() - startedAt) * args.speed;
		const snapshot = snapshotAt(t, args.scenario);
		const lines = [...laneViewFrame(snapshot, columns(), t, options(colour), args.tier)];
		const phrase = castLine(stageAt(snapshot).cast);
		lines.push(`\x1b[2m${(snapshot.now / 1000).toFixed(1).padStart(4)}s / ${length / 1000}s  ×${args.speed}  ${args.scenario}  ${laneViewLiveliness(snapshot, columns(), args.rows)}  ${args.tier} ${art}  ${phrase}  (Ctrl+C: 종료)\x1b[0m`);
		let out = drawn > 0 ? `\x1b[${drawn}A\r` : "";
		out += lines.map((line) => `${line}\x1b[K`).join("\n") + "\n";
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

if (import.meta.main) main();
