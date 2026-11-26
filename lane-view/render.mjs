// Draws the frames written by `scripts/lane-clip.ts` (rows of ANSI-coloured terminal cells) as pictures that look like
// a terminal, and turns them into an animated WebP.
//
//   node render.mjs --frames frames.json --out lane-view.webp [--work DIR] [--cell 16] [--lossless] [--quality 70]
//   node render.mjs --frames frames.json --still 9000 --out still.png [--width 850]   one frame as PNG (a look at it)
//
// Needs `@napi-rs/canvas` (installed in the folder you run from, not in the repository) and `img2webp` on the PATH.
// Nothing here knows what the lane view is: it only knows cells. Braille cells are drawn as dots (a 2 x 4 grid of
// circles, like a terminal font draws them, but a little larger so they read when the picture is scaled down); every
// other glyph is typeset in one monospace grid, two cells wide for Hangul and emoji.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Resolved from the folder you run in, so the package can live in a work folder instead of next to this file.
const { createCanvas } = createRequire(join(process.cwd(), "noop.js"))("@napi-rs/canvas");

const args = process.argv.slice(2);
const flag = name => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};
const has = name => args.includes(name);
const framesFile = flag("--frames");
const out = flag("--out");
if (framesFile === undefined || out === undefined) {
	console.error("usage: node render.mjs --frames frames.json --out FILE [--still MS] [--work DIR] [--cell PX] [--lossless] [--quality N]");
	process.exit(2);
}
const clip = JSON.parse(readFileSync(framesFile, "utf8"));
const CELL_W = Number(flag("--cell") ?? 16);
const CELL_H = Math.round(CELL_W * 1.9);
const FONT_PX = Math.round(CELL_W / 0.602);
const PAD_X = Math.round(CELL_W * 1.5);
const PAD_Y = Math.round(CELL_W * 0.9);
const BAR_H = Math.round(CELL_W * 2.3);
const BACKGROUND = clip.background;
const FOREGROUND = "#d4d4d8";
const MONO = "Menlo, Monaco, monospace";
const HANGUL = "'Apple SD Gothic Neo', 'AppleGothic'";
const EMOJI = "'Apple Color Emoji'";

const WIDTH = CELL_W * clip.columns + PAD_X * 2;
const HEIGHT = BAR_H + CELL_H * clip.height + PAD_Y * 2;

/** Cells of a glyph: 2 for Hangul, other wide scripts and emoji, 0 for joiners and variation selectors, else 1. */
function cellsOf(ch) {
	const c = ch.codePointAt(0);
	if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
	if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)) return 2;
	return 1;
}

/** One record per glyph of an ANSI-coloured row: its colour and weight. Understands reset, bold, 22, 39 and 38;2. */
function parseRow(row) {
	const cells = [];
	let colour = FOREGROUND;
	let bold = false;
	for (let at = 0; at < row.length;) {
		if (row.charCodeAt(at) === 0x1b) {
			const match = /^\x1b\[([0-9;]*)m/.exec(row.slice(at, at + 40));
			if (match === null) { at++; continue; }
			const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
			for (let k = 0; k < codes.length; k++) {
				const code = codes[k];
				if (code === 0) { colour = FOREGROUND; bold = false; }
				else if (code === 39) colour = FOREGROUND;
				else if (code === 1) bold = true;
				else if (code === 22) bold = false;
				else if (code === 38 && codes[k + 1] === 2) {
					colour = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
					k += 4;
				} else if (code === 38 || code === 48) throw new Error(`unsupported colour code ${code} (the widget only uses truecolor foregrounds)`);
			}
			at += match[0].length;
			continue;
		}
		const ch = String.fromCodePoint(row.codePointAt(at));
		at += ch.length;
		cells.push({ ch, colour, bold });
	}
	return cells;
}

// Braille bit -> [column, row] of its dot.
const DOTS = [[0x01, 0, 0], [0x02, 0, 1], [0x04, 0, 2], [0x08, 1, 0], [0x10, 1, 1], [0x20, 1, 2], [0x40, 0, 3], [0x80, 1, 3]];
const DOT_X = [0.29, 0.71];
const DOT_Y = [0.14, 0.38, 0.62, 0.86];
const DOT_R = CELL_W * 0.145;

function drawFrame(ctx, rows) {
	ctx.fillStyle = BACKGROUND;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);
	// Window: a title bar with three dots and a quiet title, so the picture reads as a terminal.
	ctx.fillStyle = "#171a20";
	ctx.fillRect(0, 0, WIDTH, BAR_H);
	ctx.fillStyle = "#23262e";
	ctx.fillRect(0, BAR_H - 1, WIDTH, 1);
	[["#ff5f57", 0], ["#febc2e", 1], ["#28c840", 2]].forEach(([colour, i]) => {
		ctx.fillStyle = colour;
		ctx.beginPath();
		ctx.arc(PAD_X + CELL_W * 0.55 + i * CELL_W * 1.45, BAR_H / 2, CELL_W * 0.42, 0, Math.PI * 2);
		ctx.fill();
	});
	ctx.fillStyle = "#6b7280";
	ctx.font = `${Math.round(FONT_PX * 0.72)}px ${MONO}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "alphabetic";
	ctx.fillText("omp · storm", WIDTH / 2, BAR_H / 2 + FONT_PX * 0.25);

	const top = BAR_H + PAD_Y;
	rows.forEach((row, r) => {
		let column = 0;
		for (const cell of parseRow(row)) {
			const w = cellsOf(cell.ch);
			if (w === 0) continue;
			const x = PAD_X + column * CELL_W;
			const y = top + r * CELL_H;
			const code = cell.ch.codePointAt(0);
			if (code >= 0x2800 && code <= 0x28ff) {
				const bits = code - 0x2800;
				if (bits !== 0) {
					ctx.fillStyle = cell.colour;
					for (const [bit, dx, dy] of DOTS) {
						if ((bits & bit) === 0) continue;
						ctx.beginPath();
						ctx.arc(x + DOT_X[dx] * CELL_W, y + DOT_Y[dy] * CELL_H, DOT_R, 0, Math.PI * 2);
						ctx.fill();
					}
				}
			} else if (cell.ch !== " ") {
				// U+23F1 is one cell wide in a terminal that draws it as text; the emoji font draws it too big, so it is shrunk.
				const emoji = code >= 0x1f300 || code === 0x23f1;
				const family = emoji ? EMOJI : code >= 0x1100 && w === 2 ? HANGUL : `${MONO}, ${HANGUL}`;
				const size = emoji ? FONT_PX * (w === 1 ? 0.6 : 0.8) : w === 2 ? FONT_PX * 1.1 : FONT_PX;
				ctx.font = `${cell.bold ? "bold " : ""}${Math.round(size)}px ${family}`;
				ctx.fillStyle = cell.colour;
				ctx.textAlign = "center";
				ctx.fillText(cell.ch, x + (w * CELL_W) / 2, y + CELL_H * 0.72);
			}
			column += w;
		}
	});
}

const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext("2d");

if (has("--still")) {
	const at = Number(flag("--still"));
	const frame = clip.frames.reduce((best, f) => (Math.abs(f.t - at) < Math.abs(best.t - at) ? f : best));
	drawFrame(ctx, frame.rows);
	const target = Number(flag("--width") ?? WIDTH);
	if (target === WIDTH) writeFileSync(out, canvas.toBuffer("image/png"));
	else {
		const small = createCanvas(target, Math.round((HEIGHT * target) / WIDTH));
		const sctx = small.getContext("2d");
		sctx.imageSmoothingQuality = "high";
		sctx.drawImage(canvas, 0, 0, small.width, small.height);
		writeFileSync(out, small.toBuffer("image/png"));
	}
	console.log(`still at ${frame.t} ms -> ${out} (${WIDTH}x${HEIGHT} drawn)`);
	process.exit(0);
}

// The whole clip: PNG per frame. The loop seam dips instead of cutting: the content fades into the background over the
// last frames and fades back in over the first ones (a cross-dissolve would lay the last status row over the first).
const work = flag("--work") ?? "frames-png";
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const FADE_OUT = Number(flag("--fade") ?? 6);
const FADE_IN = Math.ceil(FADE_OUT / 2);
const files = [];
clip.frames.forEach((frame, i) => {
	drawFrame(ctx, frame.rows);
	const left = clip.frames.length - 1 - i;
	const veil = left < FADE_OUT ? (FADE_OUT - left) / (FADE_OUT + 1) : i < FADE_IN ? (FADE_IN - i) / (FADE_IN + 1) : 0;
	if (veil > 0) {
		ctx.globalAlpha = veil;
		ctx.fillStyle = BACKGROUND;
		ctx.fillRect(0, BAR_H, WIDTH, HEIGHT - BAR_H);
		ctx.globalAlpha = 1;
	}
	const file = join(work, `f${String(i).padStart(4, "0")}.png`);
	writeFileSync(file, canvas.toBuffer("image/png"));
	files.push(file);
});
const lossless = has("--lossless");
const quality = flag("--quality") ?? "70";
const encode = lossless ? ["-lossless", "-m", "6", "-q", "100"] : ["-lossy", "-q", quality, "-m", "6", "-sharp_yuv"];
const run = spawnSync("img2webp", ["-loop", "0", "-d", String(clip.tickMs), ...encode, ...files, "-o", out], { stdio: "inherit" });
if (run.status !== 0) {
	console.error("img2webp failed");
	process.exit(1);
}
console.log(`${files.length} frames, ${WIDTH}x${HEIGHT}, ${clip.tickMs} ms each -> ${out}`);
