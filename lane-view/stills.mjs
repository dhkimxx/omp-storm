// Cuts stills out of the finished animated WebP, composing its frames the way a browser does, so what you look at is
// what the file shows (not the PNGs it was made from).
//
//   node stills.mjs lane-view.webp OUT_DIR 1000 4000 8000 ...     [--width 850]
//
// Needs `@napi-rs/canvas` in the folder you run from, and `webpmux` on the PATH.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { createCanvas, loadImage } = createRequire(join(process.cwd(), "noop.js"))("@napi-rs/canvas");
const argv = process.argv.slice(2);
const widthAt = argv.indexOf("--width");
const target = widthAt < 0 ? 850 : Number(argv[widthAt + 1]);
const rest = widthAt < 0 ? argv : argv.filter((_, i) => i !== widthAt && i !== widthAt + 1);
const [file, dir, ...times] = rest;
if (file === undefined || dir === undefined || times.length === 0) {
	console.error("usage: node stills.mjs FILE.webp OUT_DIR MS [MS ...] [--width 850]");
	process.exit(2);
}
mkdirSync(dir, { recursive: true });

const info = spawnSync("webpmux", ["-info", file], { encoding: "utf8" }).stdout;
const size = /Canvas size: (\d+) x (\d+)/.exec(info);
const [width, height] = [Number(size[1]), Number(size[2])];
const frames = [];
for (const line of info.split("\n")) {
	const m = /^\s*(\d+):\s+(\d+)\s+(\d+)\s+(yes|no)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(yes|no)/.exec(line);
	if (m !== null) frames.push({ n: Number(m[1]), x: Number(m[5]), y: Number(m[6]), ms: Number(m[7]), dispose: m[8], blend: m[9] === "yes" });
}

const wanted = times.map(Number).sort((a, b) => a - b);
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");
let clock = 0;
let next = 0;
for (const frame of frames) {
	const part = join(dir, `.part-${frame.n}.webp`);
	spawnSync("webpmux", ["-get", "frame", String(frame.n), "-o", part, file]);
	const image = await loadImage(readFileSync(part));
	if (!frame.blend) ctx.clearRect(frame.x, frame.y, image.width, image.height);
	ctx.drawImage(image, frame.x, frame.y);
	while (next < wanted.length && wanted[next] < clock + frame.ms) {
		const out = createCanvas(target, Math.round((height * target) / width));
		const octx = out.getContext("2d");
		octx.imageSmoothingQuality = "high";
		octx.drawImage(canvas, 0, 0, out.width, out.height);
		const name = join(dir, `still-${String(wanted[next]).padStart(6, "0")}.png`);
		writeFileSync(name, out.toBuffer("image/png"));
		console.log(`${wanted[next]} ms (frame ${frame.n}) -> ${name}`);
		next++;
	}
	if (frame.dispose === "background") ctx.clearRect(frame.x, frame.y, image.width, image.height);
	clock += frame.ms;
}
console.log(`${frames.length} frames, ${clock} ms, ${width}x${height}`);
