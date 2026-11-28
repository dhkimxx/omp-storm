/**
 * B0 probe: the exact bytes the pinned host writes to the terminal when a stage image animates beside lane text. It
 * runs the host's real process terminal driver (probes, image store, frame writer) on in-memory streams with the
 * environment of each terminal, paints a `canvas` node through a role painter that asks `cx.images.rows` for the
 * stage frame and puts lane text to its right, and prints what each frame wrote.
 *
 *   node_modules/.bin/bun scripts/stage/terminal-bytes.ts [--verbose]
 *
 * Strategies compared per terminal:
 * - fresh key: every frame is a new image (a new key, as a content-addressed blob would be);
 * - same key: one key whose pixels change (the store frees the old image and sends the new one under the same id);
 * - lane only: the stage frame is unchanged and only lane text on one row changes.
 */
import { crc32, deflateSync } from "node:zlib";
import { createSurface, jsx, signal } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { driverImages, TermBackend } from "@oh-my-pi/pi-tui/term/backend";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { startProcessDriver } from "@oh-my-pi/pi-tui/testing/process-driver";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { bakeStage, compose, indexedPng, lutOf, paletteOf } from "./frame-cost.ts";

const W = 360;
const H = 144;
const COLS = 40;
const ROWS = 8;
const LABEL = "문어 · 일을 나눠 맡기는 중";

interface Shown {
	/** "" draws no stage at all (the widget went away). */
	readonly key: string;
	readonly data: string;
	readonly lane: readonly string[];
	/** Append a no-op SGR to placement rows, so a new frame under the same key rewrites (re-places) them. */
	readonly mark: boolean;
}

const shown = signal<Shown>({ key: "", data: "", lane: [], mark: false });

/**
 * The stage beside the lane graph in one block: rows of the image (placements, placeholder cells or an anchored
 * sequence), then the lane text. Rows that measure 0 cells (kitty placements, reserved and anchored rows) skip the
 * stage with a cursor move instead of spaces: spaces would erase SIXEL/iTerm2 pixels under them.
 */
function stagePainter(_node: unknown, cx: PaintContext): Block {
	const now = shown();
	if (now.key === "") return { rows: now.lane };
	const got = cx.images?.rows(
		{ key: now.key, data: now.data, mime: "image/png", widthPx: W, heightPx: H },
		{ maxColumns: COLS, maxRows: ROWS, fallback: LABEL },
	);
	const stage = got?.rows ?? [LABEL];
	const rows: string[] = [];
	for (let row = 0; row < Math.max(stage.length, now.lane.length); row++) {
		const cell = stage[row] ?? "";
		const width = visibleWidth(cell);
		const mark = now.mark && cell.includes("\x1b_G") ? "\x1b[22m" : "";
		rows.push(`${cell}${mark}${width === 0 ? `\x1b[${COLS + 1}C` : " ".repeat(Math.max(0, COLS + 1 - width))}${now.lane[row] ?? ""}`);
	}
	return { rows };
}

/** A fully transparent RGBA PNG of the stage's size: the frame that leaves nothing behind. */
function clearPng(): string {
	const chunk = (type: string, data: Uint8Array): Buffer => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const out = Buffer.alloc(12 + data.length);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
		return out;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const idat = deflateSync(new Uint8Array((W * 4 + 1) * H));
	return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]).toString("base64");
}

interface TerminalCase {
	readonly name: string;
	readonly env: Record<string, string>;
	readonly tmuxPassthrough?: "on" | "off";
}

const CASES: readonly TerminalCase[] = [
	{ name: "kitty (U=1 placeholders)", env: { KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" } },
	{ name: "WezTerm (kitty direct placements)", env: { TERM_PROGRAM: "WezTerm", TERM: "xterm-256color" } },
	{ name: "iTerm2 (OSC 1337)", env: { TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" } },
	{ name: "SIXEL (forced)", env: { PI_FORCE_IMAGE_PROTOCOL: "sixel", TERM: "xterm-256color" } },
	{ name: "tmux + WezTerm, allow-passthrough on", env: { TMUX: "/tmp/tmux-1/default,1,0", TERM_PROGRAM: "WezTerm", TERM: "tmux-256color" }, tmuxPassthrough: "on" },
	{ name: "tmux + WezTerm, allow-passthrough off", env: { TMUX: "/tmp/tmux-1/default,1,0", TERM_PROGRAM: "WezTerm", TERM: "tmux-256color" }, tmuxPassthrough: "off" },
	{ name: "tmux, client kitty (placeholders)", env: { TMUX: "/tmp/tmux-1/default,1,0", TERM_PROGRAM: "tmux", TERM: "tmux-256color" }, tmuxPassthrough: "on" },
	{ name: "no image protocol (Terminal.app)", env: { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" } },
];

/** What one write carried. */
function summarize(write: string): string {
	const count = (re: RegExp): number => write.match(re)?.length ?? 0;
	const parts = [`${(Buffer.byteLength(write) / 1024).toFixed(1)}K`];
	const kitty = count(/\x1b_G/g);
	if (kitty > 0) {
		parts.push(
			`kitty cmds ${kitty} (transmit ${count(/\x1b_Ga=t/g)}, place ${count(/a=p,q=2,C=1/g)}, virtual ${count(/a=p,U=1/g)}, delete ${count(/a=d,/g)})`,
		);
	}
	const placeholderCells = count(/\u{10EEEE}/gu);
	if (placeholderCells > 0) parts.push(`placeholder cells ${placeholderCells}`);
	const iterm = count(/\x1b\]1337;File=/g);
	if (iterm > 0) parts.push(`iTerm2 images ${iterm}`);
	const sixel = count(/\x1bP[0-9;]*q/g);
	if (sixel > 0) parts.push(`SIXEL images ${sixel}`);
	const tmux = count(/\x1bPtmux;/g);
	if (tmux > 0) parts.push(`tmux envelopes ${tmux}`);
	const reserved = count(/\x1b\[0m\x1b\[41C/g);
	if (reserved > 0) parts.push(`rows skipping the stage ${reserved}`);
	return parts.join(", ");
}

/** A readable shape of a write: escapes as ⎋, long payloads folded. */
function shape(write: string): string {
	return write
		.replace(/[A-Za-z0-9+/=]{48,}/g, run => `<${run.length} b64>`)
		.replace(/(\u{10EEEE}[\u0300-\u036f\u0483-\u0487\u0591-\u05bd\u05bf-\u05c7\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0711\u0730-\u074a\u07a6-\u07b0\u07eb-\u07f3\u0816-\u082d\u0951-\u0954\u0f82-\u0f87\u135d-\u135f\u17dd\u193a\u1a17\u1a75-\u1a7c\u1b6b-\u1b73\u1cd0-\u1cd2\u1cda\u1cdb\u1ce0\u1df0-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2de0-\u2dff\ua66f-\ua67d\ua6f0\ua6f1\ua8e0-\ua8f1\uaab0-\uaab8\uaabe\uaac1\ufe20-\ufe2f]*)+/gu, run => `<${[...run.matchAll(/\u{10EEEE}/gu)].length} cells>`)
		.replace(/\x1b/g, "⎋")
		.slice(0, 900);
}

async function frames(): Promise<string[]> {
	const stage = bakeStage(W, H);
	const pixels = new Uint8Array(W * H * 3);
	const samples: Uint8Array[] = [];
	for (let t = 0; t < 8; t++) {
		compose(stage, pixels, t * 85 * 30);
		samples.push(pixels.slice());
	}
	const plte = await paletteOf(samples, W, H);
	const lut = lutOf(plte);
	const scratch = new Uint8Array((W * 3 + 1) * H);
	const out: string[] = [];
	for (let f = 0; f < 12; f++) {
		compose(stage, pixels, f * 85);
		out.push(Buffer.from(indexedPng(pixels, W, H, plte, lut, 3, scratch)).toString("base64"));
	}
	return out;
}

const lane = (tick: number, changedRow = -1): string[] =>
	Array.from({ length: ROWS }, (_, row) => `lane ${row + 1} ${row === changedRow ? "⣿⣶⣤⣀".slice(tick % 4, tick % 4 + 1) : "⣀"} working`);

async function run(terminal: TerminalCase, pngs: readonly string[], verbose: boolean): Promise<void> {
	const tmux = (args: readonly string[]): string | null => {
		if (args.includes("allow-passthrough")) return terminal.tmuxPassthrough ?? null;
		if (args.includes("#{client_termtype}\t#{client_termname}")) return "xterm-kitty\txterm-kitty";
		return null;
	};
	const term = await startProcessDriver({ env: { ...terminal.env }, tmux });
	const driver = term.driver;
	console.log(`\n### ${terminal.name}: images=${driver.capabilities.images} multiplexer=${driver.capabilities.multiplexer}`);
	shown.set({ key: "f0", data: pngs[0]!, lane: lane(0), mark: false });
	const node = jsx("canvas", { paint: () => [], term: { role: "storm.stage-probe" } });
	const surface = createSurface(() => ({ dock: node }));
	const backend = new TermBackend({
		surface,
		driver,
		theme: () => PLAIN_THEME,
		images: driverImages(driver.images, () => driver.capabilities),
		frameInterval: 0,
		clock: signal(0),
	});
	const step = async (label: string, next: Shown): Promise<void> => {
		term.output.length = 0;
		shown.set(next);
		backend.renderNow();
		await driver.images.whenEncoded();
		const first = term.output.join("");
		term.output.length = 0;
		backend.renderNow();
		const second = term.output.join("");
		console.log(`${label}: ${summarize(first)}${second ? ` | after encode: ${summarize(second)}` : ""}`);
		if (verbose) console.log(`  ${shape(first + second)}`);
	};
	backend.start();
	await driver.images.whenEncoded();
	backend.renderNow();
	term.output.length = 0;
	for (let f = 1; f <= 10; f++) await step(`fresh key f${f}`, { key: `f${f}`, data: pngs[f]!, lane: lane(f), mark: false });
	await step("stage removed after fresh keys", { key: "", data: "", lane: lane(0), mark: false });
	for (let f = 0; f < 3; f++) await step(`same key #${f}`, { key: "stage", data: pngs[f]!, lane: lane(f), mark: false });
	for (let f = 3; f < 6; f++) await step(`same key + row mark #${f}`, { key: "stage", data: pngs[f]!, lane: lane(f), mark: f % 2 === 1 });
	for (let f = 1; f <= 2; f++) await step(`lane only #${f}`, { key: "stage", data: pngs[5]!, lane: lane(f, 3), mark: true });
	await step("same key, transparent clear frame", { key: "stage", data: clearPng(), lane: lane(0), mark: false });
	await step("stage removed after clear frame", { key: "", data: "", lane: lane(0), mark: false });
	backend.stop();
	surface.dispose();
	await driver.stop();
}

async function main(): Promise<void> {
	const verbose = process.argv.includes("--verbose");
	defineRolePainter("canvas", "storm.stage-probe", stagePainter);
	const pngs = await frames();
	console.log(`frame: ${W}x${H} indexed PNG, base64 ${(pngs[1]!.length / 1024).toFixed(1)}K; stage ${COLS}x${ROWS} cells at the default 9x18 cell`);
	for (const terminal of CASES) await run(terminal, pngs, verbose);
	// The public node route, for contrast: an `image` node beside a `canvas` in a `row`, and stacked in a `col`.
	const blob = registerBlob(Buffer.from(pngs[0]!, "base64"), "image/png");
	for (const env of [{ TERM_PROGRAM: "iTerm.app" }, { TERM_PROGRAM: "WezTerm" }]) {
		for (const layout of ["row", "col"] as const) {
			const term = await startProcessDriver({ env: { ...env, TERM: "xterm-256color" }, tmux: () => null });
			term.output.length = 0;
			const node = jsx(layout, {
				children: [jsx("image", { blob, w: W, h: H, alt: LABEL }), jsx("canvas", { paint: () => lane(0) })],
			});
			const surface = createSurface(() => ({ dock: node }));
			const backend = new TermBackend({
				surface,
				driver: term.driver,
				theme: () => PLAIN_THEME,
				images: driverImages(term.driver.images, () => term.driver.capabilities),
				frameInterval: 0,
				clock: signal(0),
			});
			backend.start();
			backend.renderNow();
			console.log(`\n### ${layout}(image, canvas) on ${env.TERM_PROGRAM}: ${summarize(term.output.join(""))}`);
			backend.stop();
			surface.dispose();
			await term.driver.stop();
		}
	}
}

await main();
