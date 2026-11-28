/**
 * B0 probe extension: loaded into the real omp binary by `scripts/stage/pty-probe.ts`. It registers a role painter
 * through the host-bundled `@oh-my-pi/pi-tui/term/paint` (the route `src/tui/kit.ts` already uses), shows a widget below
 * the editor whose painter draws an animated stage image beside lane text through `cx.images.rows`, and advances the
 * frame every `STORM_PTY_PROBE_MS` (default 85) ms. What the painter saw (image protocol, cell size, row state) goes to
 * `STORM_PTY_PROBE_LOG`.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { bakeStage, compose, indexedPng, lutOf, paletteOf } from "./frame-cost.ts";

const W = 360;
const H = 144;
const COLS = 40;
const ROWS = 8;

export default async function stagePtyProbe(pi: ExtensionAPI): Promise<void> {
	const log = (line: string): void => {
		const path = process.env.STORM_PTY_PROBE_LOG;
		if (path) appendFileSync(path, `${line}\n`);
	};
	const stage = bakeStage(W, H);
	const pixels = new Uint8Array(W * H * 3);
	const samples: Uint8Array[] = [];
	for (let t = 0; t < 8; t++) {
		compose(stage, pixels, t * 2550);
		samples.push(pixels.slice());
	}
	const plte = await paletteOf(samples, W, H);
	const lut = lutOf(plte);
	const scratch = new Uint8Array((W * 3 + 1) * H);
	const tick = signal(0);
	let logged = 0;
	defineRolePainter("canvas", "storm.pty-probe", (_node, cx) => {
		const t = tick();
		compose(stage, pixels, t * 85);
		const data = Buffer.from(indexedPng(pixels, W, H, plte, lut, 3, scratch)).toString("base64");
		const got = cx.images?.rows(
			{ key: "storm-stage", data, mime: "image/png", widthPx: W, heightPx: H },
			{ maxColumns: COLS, maxRows: ROWS, fallback: "문어 · 일을 나눠 맡기는 중" },
		);
		if (logged++ < 3 || t % 50 === 0) {
			log(`t=${t} width=${cx.width} images=${cx.images ? "yes" : "no"} cell=${JSON.stringify(cx.images?.cell())} state=${got?.state ?? "none"} columns=${got?.columns ?? 0} rows=${got?.rows.length ?? 0}`);
		}
		const rows = (got?.rows ?? ["문어 · 일을 나눠 맡기는 중"]).map((cell, row) => {
			const measured = visibleWidth(cell);
			const mark = t % 2 === 1 && cell.includes("\x1b_G") ? "\x1b[22m" : "";
			const skip = measured === 0 ? `\x1b[${COLS + 1}C` : " ".repeat(Math.max(0, COLS + 1 - measured));
			return `${cell}${mark}${skip}lane ${row + 1} ${"⣀⣤⣶⣿"[(t + row) % 4]}`;
		});
		return { rows };
	});
	pi.on("session_start", (_event, ctx) => {
		log(`session_start hasUI=${ctx.hasUI}`);
		ctx.ui.setWidget("storm-pty-probe", () => jsx("canvas", { paint: () => [], term: { role: "storm.pty-probe" } }), {
			placement: "belowEditor",
		});
		const timer = setInterval(() => tick.set(tick.peek() + 1), Number(process.env.STORM_PTY_PROBE_MS) || 85);
		timer.unref?.();
	});
}
