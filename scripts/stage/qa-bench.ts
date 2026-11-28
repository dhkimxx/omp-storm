/**
 * B4 performance: what one stage frame costs at every stage size the lane view can give it.
 *
 *   node_modules/.bin/bun scripts/stage/qa-bench.ts [--frames N] [--fake]
 *
 * For stage widths 28, 40 and 48 columns and lane views of 5, 8 and 12 rows (the stage's picture rows plus its phrase
 * row), with a full cast (ten lanes: the individual cap on stage, the rest in the swarm, two pieces each), the species'
 * background, rain and a species change in progress, it times per frame:
 *
 * - T1 compose + encode: scene, composite (`stagePicture`, 9x18 px per cell) and the 256-colour indexed PNG in base64
 *   (`encodeStageFrame`), which is what the host transmits; its size is checked against the 32 KiB frame budget.
 * - T2 render: the half-block rows with the phrase row (`stageCellsFrame`); its size is the bytes the terminal gets.
 *
 * Frames advance at the widget's 85 ms tick, a few warm-up frames first (palette lookup table, sheet decoding). The
 * art is the baked art (with `--fake`, the tests' procedural fake art).
 * A species whose background is not baked yet gets a stand-in background of the stage's full size, so the composite
 * always pays for one.
 */
import { performance } from "node:perf_hooks";
import type { LaneIntent, LaneSnapshot, LaneSpan, LaneState, LaneTrack } from "../../src/view/lane/model.ts";
import type { SequenceId, SequenceMeta, StageAssets, StageFrame, StageTier } from "../../src/view/stage/assets.ts";
import { T1_CELL_PX } from "../../src/view/stage/assets.ts";
import { FAKE_ART } from "../../tests/stage-fake-art.ts";
import { STAGE_ASSETS } from "../../src/view/stage/baked.ts";
import { stageCellsFrame, stageLaneColours, stagePicture } from "../../src/view/stage/render-pixels.ts";
import { encodeStageFrame, FRAME_BUDGET_BYTES } from "../../src/view/stage/t1.ts";

const CPU_BUDGET_MS = 2;
const TICK_MS = 85;
const WARMUP = 8;
const COLUMNS = [28, 40, 48] as const;
const ROWS = [5, 8, 12] as const;

/** A background loop of the largest stage, grey plus alpha, for species whose background is not baked. */
class WithBackgrounds implements StageAssets {
	readonly #frames = new Map<StageTier, StageFrame>();

	constructor(readonly base: StageAssets) {}

	meta(id: SequenceId): SequenceMeta | undefined {
		const kept = this.base.meta(id);
		if (kept !== undefined || !id.endsWith("/fx/background")) return kept;
		const w = 48 * T1_CELL_PX.w;
		const h = 12 * T1_CELL_PX.h;
		return { durationMs: 4_000, loop: true, size: { w, h }, anchor: { x: 0, y: 0 } };
	}

	frame(id: SequenceId, tMs: number, tier: StageTier): StageFrame | undefined {
		const kept = this.base.frame(id, tMs, tier);
		if (kept !== undefined || !id.endsWith("/fx/background")) return kept;
		let frame = this.#frames.get(tier);
		if (frame === undefined) {
			const w = tier === "t1" ? 48 * T1_CELL_PX.w : 48;
			const h = tier === "t1" ? 12 * T1_CELL_PX.h : 24;
			const rgba = new Uint8ClampedArray(w * h * 4);
			// Rolling hills of coverage with grain: most pixels drawn, as a painted backdrop would be.
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const ridge = h * (0.45 + 0.15 * Math.sin(x / (w / 9)));
					if (y < ridge) continue;
					const i = (y * w + x) * 4;
					const v = 120 + ((x * 31 + y * 17) % 60);
					rgba[i] = v;
					rgba[i + 1] = v;
					rgba[i + 2] = v;
					rgba[i + 3] = 200;
				}
			}
			frame = tier === "t1" ? { tier: "t1", w, h, rgba } : { tier: "t2", w, h, rgba };
			this.#frames.set(tier, frame);
		}
		return frame;
	}

	accent(id: SequenceId, tMs: number, tier: StageTier): StageFrame | undefined {
		return this.base.accent?.(id, tMs, tier);
	}
}

/** A full cast of ten lanes for each working species, and one moment mid-handoff (two backgrounds). */
type Case = "octopus" | "bee" | "ant" | "orca" | "handoff";
const CASES: readonly Case[] = ["octopus", "bee", "ant", "orca", "handoff"];

function track(i: number, intent: LaneIntent, steps: readonly (readonly [number, LaneState])[], extra: Partial<LaneTrack> = {}): LaneTrack {
	const spans: LaneSpan[] = steps.map(([from, state], k) => (k + 1 < steps.length ? { from, to: steps[k + 1]![0], state } : { from, state }));
	return {
		name: `lane-${i}`,
		label: "구현",
		dependsOn: [],
		spans,
		slot: i,
		intent,
		activity: 0.3 + (i % 3) * 0.3,
		pieces: [{ id: `r${i}a`, state: i % 4 === 0 ? "accepted" : "pending" }, { id: `r${i}b`, state: "pending" }],
		...extra,
	};
}

function snapshotOf(kind: Case, now: number): LaneSnapshot {
	const lanes: LaneTrack[] = [];
	for (let i = 0; i < 10; i++) {
		const intent: LaneIntent = kind === "bee" ? "read" : kind === "orca" && i === 0 ? "review" : kind === "ant" && i === 0 ? "job" : i % 2 === 0 ? "read" : "write";
		// The handoff case: the octopus until 59.4 s, then a job starts (ant), so at 60 s the handoff is half way.
		const steps: [number, LaneState][] = kind === "handoff" && i === 0
			? [[0, "reserved"], [59_400, "running"]]
			: [[0, "reserved"], [1_000, kind === "orca" && i > 0 && i < 4 ? "reviewing" : i === 9 ? "blocked" : "running"]];
		lanes.push(track(i, kind === "handoff" && i === 0 ? "job" : intent, steps, kind === "ant" && i === 0 ? { job: true } : {}));
	}
	return { now, phases: [{ from: 0, phase: "workers" }], rounds: [0], lanes, complete: false, milestones: [{ at: 0, kind: "start" }] };
}

interface Stats { median: number; p95: number; max: number }
function stats(values: number[]): Stats {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	return { median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
}

interface Bench { t1: Stats; t1Bytes: Stats; t2: Stats; t2Bytes: Stats }

function bench(kind: Case, cols: number, rows: number, frames: number, assets: StageAssets): Bench {
	const t1: number[] = [];
	const t1Bytes: number[] = [];
	const t2: number[] = [];
	const t2Bytes: number[] = [];
	const options = { motion: true, dark: true };
	for (let k = 0; k < frames + WARMUP; k++) {
		const t = 60_000 + k * TICK_MS;
		// The handoff case stays at the middle of its change; the others advance in run time too.
		const snapshot = snapshotOf(kind, kind === "handoff" ? 60_000 : t);
		let start = performance.now();
		const picture = stagePicture(snapshot, cols, rows - 1, t, options, "t1", assets);
		const data = encodeStageFrame({ w: picture.w, h: picture.h, rgb: picture.rgb, dark: true, laneColours: stageLaneColours(snapshot, true) });
		const t1Ms = performance.now() - start;
		start = performance.now();
		const lines = stageCellsFrame(snapshot, cols, rows, t, options, assets);
		const t2Ms = performance.now() - start;
		if (k < WARMUP) continue;
		t1.push(t1Ms);
		t1Bytes.push(data.length);
		t2.push(t2Ms);
		t2Bytes.push(Buffer.byteLength(lines.join("\n")));
	}
	return { t1: stats(t1), t1Bytes: stats(t1Bytes), t2: stats(t2), t2Bytes: stats(t2Bytes) };
}

function main(): void {
	const argv = process.argv.slice(2);
	const framesAt = argv.indexOf("--frames");
	const frames = framesAt >= 0 ? Math.max(20, Number(argv[framesAt + 1]) || 200) : 200;
	const fake = argv.includes("--fake");
	const assets = new WithBackgrounds(fake ? FAKE_ART : STAGE_ASSETS);
	const ms = (n: number): string => n.toFixed(2);
	const kib = (n: number): string => (n / 1024).toFixed(1);
	const table: Record<string, string>[] = [];
	let over = 0;
	for (const cols of COLUMNS) {
		for (const rows of ROWS) {
			// The worst case over the casts, by p95 time.
			let worst: { kind: Case; result: Bench } | undefined;
			let worstT2: { kind: Case; result: Bench } | undefined;
			let maxBytes = 0;
			for (const kind of CASES) {
				const result = bench(kind, cols, rows, frames, assets);
				if (worst === undefined || result.t1.p95 > worst.result.t1.p95) worst = { kind, result };
				if (worstT2 === undefined || result.t2.p95 > worstT2.result.t2.p95) worstT2 = { kind, result };
				maxBytes = Math.max(maxBytes, result.t1Bytes.max);
			}
			const t1 = worst!.result;
			const t2 = worstT2!.result;
			const ok = t1.t1.p95 <= CPU_BUDGET_MS && t2.t2.p95 <= CPU_BUDGET_MS && maxBytes <= FRAME_BUDGET_BYTES;
			if (!ok) over++;
			table.push({
				stage: `${cols}x${rows}`,
				"T1 px": `${cols * T1_CELL_PX.w}x${(rows - 1) * T1_CELL_PX.h}`,
				"T1 median ms": ms(t1.t1.median),
				"T1 p95 ms": `${ms(t1.t1.p95)} (${worst!.kind})`,
				"T1 KiB median/max": `${kib(t1.t1Bytes.median)}/${kib(maxBytes)}`,
				"T2 median ms": ms(t2.t2.median),
				"T2 p95 ms": `${ms(t2.t2.p95)} (${worstT2!.kind})`,
				"T2 KiB median": kib(t2.t2Bytes.median),
				budget: ok ? "ok" : "OVER",
			});
		}
	}
	console.log(`stage frame cost, ${frames} frames per cast after ${WARMUP} warm-up, worst of ${CASES.join("/")}; art: ${fake ? "fake" : "baked"} + stand-in backgrounds`);
	console.log(`budget: ${CPU_BUDGET_MS} ms CPU per frame (p95), ${FRAME_BUDGET_BYTES / 1024} KiB per T1 frame (base64)`);
	console.table(table);
	if (over > 0) process.exitCode = 1;
}

if (import.meta.main) main();
