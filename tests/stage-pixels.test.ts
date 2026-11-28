/**
 * The pixel tiers of the stage (B2): the T1 palette and its PNG, the image channel's budget, key and clearing frame,
 * the rows a painter puts beside the lane graph, the T2 half-block cells, the tier choice, and the baked-asset loader.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { LanePiece, LaneSnapshot, LaneTrack } from "../src/view/lane/model.ts";
import type { Species } from "../src/view/stage/cast.ts";
import { sequenceId, type StageAssets } from "../src/view/stage/assets.ts";
import { BakedAssets, STAGE_ASSETS, STAGE_ASSETS_SCHEMA } from "../src/view/stage/baked.ts";
import { stagePalette } from "../src/view/stage/palette.ts";
import { decodePng, indexedPng } from "../src/view/stage/png.ts";
import { halfBlockRows, stageCellsFrame } from "../src/view/stage/render-pixels.ts";
import { ARM_ROOT_RATIO, ARM_TIP_WIDTH_PX, armRadius, changeMask, pixelsPerDot, rasterStage } from "../src/view/stage/raster.ts";
import { ANT_DIRECTOR_BASE_PX, ANT_FLOOR_PX, ANT_WORKER_FEET_PX, changeStyle, requestableSequences, stageScene } from "../src/view/stage/scene.ts";
import { stageAt } from "../src/view/stage/sequencer.ts";
import {
	encodeStageFrame,
	FRAME_BUDGET_BYTES,
	joinStageRows,
	MAX_STRETCH,
	PLACEMENT_TOGGLE,
	selectStageTier,
	type StageDrawTier,
	StageImageChannel,
	type StageImagePixels,
	type StageTerminal,
} from "../src/view/stage/t1.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

function snapshot(states: LaneTrack["spans"][number]["state"][], intents: ("read" | "write")[] = []): LaneSnapshot {
	return {
		now: 60_000,
		phases: [{ from: 0, phase: "workers" }],
		rounds: [0],
		complete: false,
		milestones: [],
		lanes: states.map((state, i) => ({ name: `lane${i}`, label: "구현", dependsOn: [], spans: [{ from: 0, state }], slot: i, intent: intents[i] ?? "write" })),
	};
}

/** A picture with a gradient and one bright square, so the palette and the dither both matter. */
function picture(w: number, h: number): StageImagePixels {
	const rgb = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			rgb[i] = 16 + Math.round((x / w) * 80);
			rgb[i + 1] = 18;
			rgb[i + 2] = 22 + Math.round((y / h) * 120);
			if (x > w / 3 && x < w / 2 && y > h / 3 && y < h / 2) rgb.set([250, 250, 250], i);
		}
	}
	return { w, h, rgb, dark: true, laneColours: [0x66aaff, 0xffaa66] };
}

describe("the T1 palette and frame", () => {
	test("the same picture and lanes give the same bytes; the palette is cached and keyed by lanes and look", () => {
		const a = encodeStageFrame(picture(90, 36));
		const b = encodeStageFrame(picture(90, 36));
		expect(a).toBe(b);
		const palette = stagePalette(true, [0x66aaff, 0xffaa66]);
		expect(stagePalette(true, [0x66aaff, 0xffaa66])).toBe(palette);
		expect(palette.plte.length).toBe(768);
		expect(stagePalette(true, [0x66aaff]).plte).not.toEqual(palette.plte);
		expect(stagePalette(false, [0x66aaff, 0xffaa66]).plte).not.toEqual(palette.plte);
	});

	test("an indexed PNG decodes back to its size, and a palette colour comes back as itself", () => {
		const palette = stagePalette(true, [0x66aaff]);
		const bg = [palette.plte[0]!, palette.plte[1]!, palette.plte[2]!];
		const rgb = new Uint8Array(8 * 4 * 3);
		for (let i = 0; i < 32; i++) rgb.set(bg, i * 3);
		const decoded = decodePng(indexedPng(rgb, 8, 4, palette.plte, palette.lut));
		expect([decoded.w, decoded.h]).toEqual([8, 4]);
		// The background is entry 0; a flat area in it stays it under the ordered dither.
		const centre = (1 * 8 + 1) * 4;
		expect(Math.abs(decoded.rgba[centre]! - bg[0]!) + Math.abs(decoded.rgba[centre + 2]! - bg[2]!)).toBeLessThanOrEqual(12);
		expect(decoded.rgba[centre + 3]).toBe(255);
	});
});

describe("the image channel", () => {
	const pixels = (): StageImagePixels => picture(4, 4);
	const sized = (bytes: number) => (): string => "A".repeat(bytes);

	test("one key for every frame and for the clearing frame; between due frames the last source is drawn again", () => {
		const channel = new StageImageChannel("storm-stage:run-1");
		const first = channel.frame(0, 85, pixels)!;
		expect(first.key).toBe("storm-stage:run-1");
		expect(channel.frame(40, 85, pixels)).toBe(first);
		const second = channel.frame(90, 85, pixels)!;
		expect(second.key).toBe(first.key);
		expect(channel.frames).toBe(2);
		expect(channel.showing).toBe(true);
		const clear = channel.clear();
		expect(clear.key).toBe(first.key);
		expect([clear.widthPx, clear.heightPx]).toEqual([4, 4]);
		const transparent = decodePng(Buffer.from(clear.data, "base64"));
		expect(transparent.rgba.every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
		expect(channel.showing).toBe(false);
	});

	test("a still picture is encoded again only when its record changes", () => {
		let encoded = 0;
		const channel = new StageImageChannel("k", () => `${++encoded}`);
		channel.frame(0, 85, pixels, "a");
		channel.frame(5_000, 85, pixels, "a");
		expect(encoded).toBe(1);
		channel.frame(5_100, 85, pixels, "b");
		expect(encoded).toBe(2);
	});

	test("frames over 32 KiB stretch the interval to 2x, then 4x, and no further", () => {
		const channel = new StageImageChannel("k", sized(40 * 1024));
		expect(channel.stretch).toBe(1);
		channel.frame(0, 85, pixels);
		expect(channel.stretch).toBe(2);
		// Not due before twice the interval.
		expect(channel.frames).toBe(1);
		channel.frame(100, 85, pixels);
		expect(channel.frames).toBe(1);
		channel.frame(170, 85, pixels);
		expect(channel.stretch).toBe(MAX_STRETCH);
		for (let t = 170; t < 3_000; t += 85) channel.frame(t, 85, pixels);
		expect(channel.stretch).toBe(MAX_STRETCH);
		expect(channel.demoted).toBe(false);
	});

	test("over 400 KiB a second even at 4x, the stage drops to T2 and the channel draws nothing more", () => {
		const channel = new StageImageChannel("k", sized(30 * 1024));
		let last: unknown = null;
		for (let t = 0; t < 3_000 && !channel.demoted; t += 10) last = channel.frame(t, 10, pixels);
		expect(channel.demoted).toBe(true);
		expect(last).toBeUndefined();
		expect(channel.frame(5_000, 10, pixels)).toBeUndefined();
	});

	test("a frame no interval can save drops to T2 at once", () => {
		const channel = new StageImageChannel("k", sized(FRAME_BUDGET_BYTES * 2 + 1));
		expect(channel.frame(0, 85, pixels)).toBeUndefined();
		expect(channel.demoted).toBe(true);
	});

	test("under half the budget for a while, the interval comes back down", () => {
		let size = 40 * 1024;
		const channel = new StageImageChannel("k", () => "A".repeat(size));
		channel.frame(0, 85, pixels);
		expect(channel.stretch).toBe(2);
		size = 1024;
		for (let t = 200; t < 4_000; t += 85) channel.frame(t, 85, pixels);
		expect(channel.stretch).toBe(1);
	});
});

describe("the painter's rows", () => {
	test("placement rows step over the stage and toggle on odd frames; text rows are padded; the phrase row closes the stage", () => {
		const placement = "\x1b_Ga=p,i=1\x1b\\";
		const rows = joinStageRows({ rows: [placement, "abc"], columns: 10 }, 10, 3, "phrase....", ["g0", "g1", "g2", "g3"], 2, row => (row.includes("\x1b_G") ? 0 : visibleWidth(row)), true);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toBe(`${placement}${PLACEMENT_TOGGLE}\x1b[11Cg0`);
		expect(rows[1]).toBe(`abc${" ".repeat(8)}g1`);
		// The picture did not reach this row: blank cells, then the graph.
		expect(rows[2]).toBe(`${" ".repeat(11)}g2`);
		expect(rows[3]).toBe("phrase.... g3");
		const even = joinStageRows({ rows: [placement], columns: 10 }, 10, 1, "p", [], 2, () => 0, false);
		expect(even[0]).toBe(`${placement}\x1b[11C  `);
	});
});

describe("T2 half blocks", () => {
	test("the top pixel is the foreground and the bottom one the background, one cell per column", () => {
		const rgb = new Uint8Array([
			255, 0, 0, 0, 255, 0,
			0, 0, 255, 255, 255, 255,
		]);
		const [row] = halfBlockRows(rgb, 2, 2);
		expect(row).toBe("\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀\x1b[38;2;0;255;0m\x1b[48;2;255;255;255m▀\x1b[0m");
	});

	test("the T2 stage is exactly its width on every row and ends with the phrase", () => {
		const snap = snapshot(["running", "running"], ["read", "write"]);
		for (const cols of [28, 36, 48]) {
			const rows = stageCellsFrame(snap, cols, 5, 1_000, { motion: true, dark: true });
			expect(rows).toHaveLength(5);
			for (const row of rows) expect(visibleWidth(row)).toBe(cols);
			expect(rows.slice(0, 4).every(row => row.replace(ANSI, "") === "▀".repeat(cols))).toBe(true);
			expect(rows[4]!.replace(ANSI, "")).toStartWith("문어 · 일을 나눠 맡기는 중");
		}
		const still = stageCellsFrame(snap, 36, 5, 0, { motion: false, dark: false });
		expect(stageCellsFrame(snap, 36, 5, 9_999, { motion: false, dark: false })).toEqual(still);
	});
});

describe("choosing the tier", () => {
	const terminal = (over: Partial<StageTerminal>): StageTerminal => ({ images: "kitty", multiplexer: null, placeholders: true, truecolor: true, ssh: false, ...over });
	const rows: Array<[string, StageTerminal, boolean, StageDrawTier]> = [
		["kitty", terminal({}), true, "t1"],
		["iTerm2", terminal({ images: "iterm", placeholders: false }), true, "t1"],
		["SIXEL moving", terminal({ images: "sixel", placeholders: false }), true, "t2"],
		["SIXEL still", terminal({ images: "sixel", placeholders: false }), false, "t1"],
		["no images", terminal({ images: null }), true, "t2"],
		["SSH", terminal({ ssh: true }), true, "t2"],
		["tmux with kitty placeholders", terminal({ multiplexer: "tmux" }), true, "t1"],
		["tmux with direct placement", terminal({ multiplexer: "tmux", placeholders: false }), true, "t2"],
		["256 colours", terminal({ truecolor: false }), true, "t3"],
	];
	for (const [name, term, motion, tier] of rows) test(name, () => expect(selectStageTier(term, motion)).toBe(tier));
});

describe("the baked assets (format v1)", () => {
	const dir = mkdtempSync(join(tmpdir(), "storm-stage-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	/** A grey+alpha (colour type 4) PNG whose pixel at column x has grey = x and alpha 255. */
	function greyAlpha(w: number, h: number): Uint8Array {
		const chunk = (type: string, data: Uint8Array): Buffer => {
			const head = Buffer.alloc(8);
			head.writeUInt32BE(data.length, 0);
			head.write(type, 4, "latin1");
			const crc = Buffer.alloc(4);
			crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
			return Buffer.concat([head, data, crc]);
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(w, 0);
		ihdr.writeUInt32BE(h, 4);
		ihdr[8] = 8;
		ihdr[9] = 4;
		const raw = Buffer.alloc((w * 2 + 1) * h);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([x, 255], y * (w * 2 + 1) + 1 + x * 2);
		return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
	}

	// Three 18x18 frames side by side; T2 frames are 2x2 (one pixel per half cell).
	writeFileSync(join(dir, "work-t1.png"), greyAlpha(54, 18));
	writeFileSync(join(dir, "work-t2.png"), greyAlpha(6, 2));
	writeFileSync(join(dir, "work-accent.png"), greyAlpha(54, 18));
	writeFileSync(join(dir, "index.json"), JSON.stringify({
		schema: STAGE_ASSETS_SCHEMA,
		cell: { w: 9, h: 18 },
		sequences: {
			"octopus/worker/work": { w: 18, h: 18, anchor: { x: 9, y: 9 }, frameMs: 100, frames: 3, loop: true, t1: "work-t1.png", t2: "work-t2.png", accent: { t1: "work-accent.png", t2: "work-t2.png" } },
			"octopus/worker/broken": { w: 18 },
		},
	}));
	const assets = new BakedAssets(pathToFileURL(`${dir}/`));
	const work = sequenceId("octopus", "worker", "work");

	test("a baked sequence reads its meta and cuts the frame for the time, looping", () => {
		expect(assets.baked(work)).toBe(true);
		expect(assets.meta(work)).toEqual({ durationMs: 300, loop: true, size: { w: 18, h: 18 }, anchor: { x: 9, y: 9 } });
		const frameAt = (t: number): number => assets.frame(work, t, "t1")!.rgba[0]!;
		// Grey at the frame's first column is its x on the sheet: frame k starts at 18 * k.
		expect([frameAt(0), frameAt(150), frameAt(250), frameAt(350)]).toEqual([0, 18, 36, 0]);
		const t2 = assets.frame(work, 150, "t2")!;
		expect([t2.tier, t2.w, t2.h, t2.rgba[0]]).toEqual(["t2", 2, 2, 2]);
		expect(assets.accent(work, 0, "t1")?.w).toBe(18);
	});

	test("an unbaked or malformed sequence draws nothing", () => {
		const bee = sequenceId("bee", "worker", "work");
		expect(assets.baked(bee)).toBe(false);
		expect(assets.meta(bee)).toBeUndefined();
		expect(assets.frame(bee, 0, "t1")).toBeUndefined();
		expect(assets.accent(bee, 0, "t1")).toBeUndefined();
		expect(assets.baked(sequenceId("octopus", "worker", "broken"))).toBe(false);
		// No index at all: nothing is baked and nothing is drawn.
		const none = new BakedAssets(pathToFileURL(`${tmpdir()}/storm-no-such-dir/`));
		expect(none.baked(work)).toBe(false);
		expect(none.frame(work, 0, "t1")).toBeUndefined();
	});
});

test("the octopus's arms run from its body to every arm tip on stage", () => {
	const snap = snapshot(["running", "running", "running"], ["read", "write", "write"]);
	const scene = stageScene({ snapshot: snap, moment: stageAt(snap, snap.now, false), cols: 36, rows: 4, t: 0, motion: false });
	expect(scene.species).toBe("octopus");
	const tips = scene.individuals.filter(item => item.lane >= 0);
	expect(scene.arms.map(arm => arm.lane)).toEqual(tips.map(item => item.lane));
	for (const arm of scene.arms) {
		const tip = tips.find(item => item.lane === arm.lane)!;
		expect([arm.to.x, arm.to.y]).toEqual([tip.x, tip.y]);
	}
	const bee = snapshot(["running", "running"], ["read", "read"]);
	expect(stageScene({ snapshot: bee, moment: stageAt(bee, bee.now, false), cols: 36, rows: 4, t: 0, motion: false }).arms).toEqual([]);
});

describe("backgrounds and species changes (B3)", () => {
	const bgFrame = (tier: "t1" | "t2") => {
		const [w, h] = tier === "t1" ? [432, 90] : [48, 10];
		const rgba = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < w * h; i++) rgba.set([255, 255, 255, 255], i * 4);
		return { tier, w, h, rgba } as const;
	};
	/** Art with only a background for the owl. */
	const onlyBackground: StageAssets = {
		meta: id => (id === "owl/fx/background" ? { durationMs: 1000, loop: true, size: { w: 432, h: 90 }, anchor: { x: 0, y: 0 } } : undefined),
		frame: (id, _t, tier) => (id === "owl/fx/background" ? bgFrame(tier) : undefined),
	};

	test("the background sits on the stage's floor, cut at its width; above it the stage stays empty; without the sequence nothing is drawn", () => {
		const snap = snapshot([]);
		const moment = stageAt(snap, snap.now, false);
		const scene = stageScene({ snapshot: snap, moment, cols: 20, rows: 6, t: 0, motion: false });
		expect(scene.species).toBe("owl");
		const pixel = (rgb: Uint8Array, w: number, x: number, y: number): number[] => [...rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
		const drawn = rasterStage({ scene, snapshot: snap, tier: "t1", cols: 20, rows: 6, dark: true, liveT: 0, motion: false, assets: onlyBackground });
		expect([drawn.w, drawn.h]).toEqual([180, 108]);
		const bg = pixel(drawn.rgb, drawn.w, 5, 5);
		// 108 - 90 = 18 empty rows on top, then the background.
		expect(pixel(drawn.rgb, drawn.w, 5, 17)).toEqual(bg);
		expect(pixel(drawn.rgb, drawn.w, 5, 40)).not.toEqual(bg);
		const bare = rasterStage({ scene, snapshot: snap, tier: "t1", cols: 20, rows: 6, dark: true, liveT: 0, motion: false, assets: { meta: () => undefined, frame: () => undefined } });
		expect(pixel(bare.rgb, bare.w, 5, 40)).toEqual(bg);
	});

	test("each change of the plan's table has its edge; a pair it does not name sweeps", () => {
		expect(changeStyle("bee", "octopus")).toBe("rise");
		expect(changeStyle("octopus", "ant")).toBe("sink");
		expect(changeStyle("ant", "orca")).toBe("rise");
		expect(changeStyle("orca", "octopus")).toBe("sweep");
		expect(changeStyle("bee", "owl")).toBe("dim");
		expect(changeStyle("owl", "ant")).toBe("radial");
		expect(changeStyle("octopus", "starling")).toBe("fade");
		const rise = { from: "bee", to: "octopus", progress: 0.5, style: "rise" } as const;
		// The water has risen halfway: the bottom is the new world, the top still the old.
		expect(changeMask(rise, 10, 99, 100, 100, 1)).toBe(1);
		expect(changeMask(rise, 10, 1, 100, 100, 1)).toBe(0);
		const sink = { ...rise, style: "sink" } as const;
		expect(changeMask(sink, 10, 1, 100, 100, 1)).toBe(1);
		expect(changeMask(sink, 10, 99, 100, 100, 1)).toBe(0);
	});

	test("during a handoff the leaving species retreats, the arriving one gathers, and a piece keeps its place", () => {
		// Bee for 5 s, then a writer joins: the octopus takes over in a handoff at 5 s.
		const lanes: LaneTrack[] = [
			{ name: "a", label: "", dependsOn: [], slot: 0, intent: "read", spans: [{ from: 0, state: "running" }], pieces: [{ id: "r", state: "pending" }] },
			{ name: "b", label: "", dependsOn: [], slot: 1, intent: "write", spans: [{ from: 0, to: 5_000, state: "reserved" }, { from: 5_000, state: "running" }] },
		];
		const at = (now: number): LaneSnapshot => ({ now, phases: [{ from: 0, phase: "workers" }], rounds: [0], complete: false, milestones: [], lanes });
		const scene = (now: number) => {
			const snap = at(now);
			return stageScene({ snapshot: snap, moment: stageAt(snap, now), cols: 36, rows: 4, t: now, motion: true });
		};
		const before = scene(4_990);
		const start = scene(5_001);
		const mid = scene(5_600);
		expect(before.species).toBe("bee");
		expect(mid.change).toMatchObject({ from: "bee", to: "octopus", style: "rise" });
		const seqs = mid.individuals.map(item => item.seq);
		expect(seqs.filter(seq => seq.startsWith("bee/")).every(seq => seq.endsWith("/excluded"))).toBe(true);
		expect(seqs.filter(seq => seq.startsWith("octopus/")).every(seq => seq.endsWith("/gather"))).toBe(true);
		expect(seqs.some(seq => seq.startsWith("bee/"))).toBe(true);
		const piece = (s: ReturnType<typeof scene>) => s.pieces.find(p => p.id === "r")!;
		expect(Math.abs(piece(start).x - piece(before).x)).toBeLessThan(1);
		expect(Math.abs(piece(start).y - piece(before).y)).toBeLessThan(1);
		// After the handoff the octopus works in its own poses and no change is left.
		const after = scene(7_000);
		expect(after.change).toBeUndefined();
		expect(after.individuals.every(item => item.seq.startsWith("octopus/") && !item.seq.endsWith("/gather"))).toBe(true);
	});

	test("orcas swimming left along the bottom of their orbit are mirrored", () => {
		const snap = snapshot(["reviewing", "reviewing", "reviewing", "reviewing"]);
		const scene = stageScene({ snapshot: snap, moment: stageAt(snap, snap.now, false), cols: 40, rows: 4, t: 0, motion: false });
		expect(scene.species).toBe("orca");
		const workers = scene.individuals.filter(item => item.lane >= 0);
		const centre = scene.individuals.find(item => item.lane < 0)!.y;
		for (const item of workers) expect(item.flip === true).toBe(item.y > centre + 0.01);
	});

	test("between rounds every species' director rests; at work it does not", () => {
		for (const [states, intents] of [[["running", "running"], ["read", "write"]], [[], []], [["reviewing"], ["write"]]] as const) {
			const base = snapshot([...states], [...intents]);
			const resting: LaneSnapshot = { ...base, phases: [{ from: 0, to: 30_000, phase: "workers" }, { from: 30_000, phase: "between-rounds" }] };
			const director = (snap: LaneSnapshot) => stageScene({ snapshot: snap, moment: stageAt(snap, snap.now, false), cols: 36, rows: 4, t: 0, motion: false }).individuals.find(item => item.lane < 0)!.seq;
			expect(director(resting)).toMatch(/\/director\/rest$/);
			expect(director(base)).toMatch(/\/director\/work$/);
		}
	});

	test("at T2 the flock is bright dots even when the bird sprite is baked; at T1 the sprite is drawn", () => {
		const snap: LaneSnapshot = { ...snapshot(["running"], ["read"]), now: 500, milestones: [{ at: 0, kind: "start" }] };
		const scene = stageScene({ snapshot: snap, moment: stageAt(snap, 500, true), cols: 30, rows: 4, t: 500, motion: true });
		expect(scene.species).toBe("starling");
		expect(scene.flock.length).toBeGreaterThan(0);
		/** A dim bird: grey 64, fully opaque, 18x18 at T1 and 2x2 at T2. */
		const dimBird = (tier: "t1" | "t2") => {
			const side = tier === "t1" ? 18 : 2;
			const rgba = new Uint8ClampedArray(side * side * 4);
			for (let i = 0; i < side * side; i++) rgba.set([64, 64, 64, 255], i * 4);
			return { tier, w: side, h: side, rgba } as const;
		};
		const withBird: StageAssets = {
			meta: id => (id === "starling/worker/fly" ? { durationMs: 166, loop: true, size: { w: 18, h: 18 }, anchor: { x: 9, y: 9 } } : undefined),
			frame: (id, _t, tier) => (id === "starling/worker/fly" ? dimBird(tier) : undefined),
		};
		const none: StageAssets = { meta: () => undefined, frame: () => undefined };
		const draw = (tier: "t1" | "t2", assets: StageAssets) => rasterStage({ scene, snapshot: snap, tier, cols: 30, rows: 4, dark: true, liveT: 500, motion: true, assets }).rgb;
		expect(draw("t2", withBird)).toEqual(draw("t2", none));
		expect(draw("t1", withBird)).not.toEqual(draw("t1", none));
	});

	test("the octopus's arm meets the tip sprite at its width: 5.2 px at T1, the same share of a cell at T2, never under a pixel", () => {
		expect(armRadius(1, pixelsPerDot("t1")) * 2).toBeCloseTo(ARM_TIP_WIDTH_PX, 5);
		// Thick at the body, thin at the tip: the root is 1.8 times the tip's width.
		expect(armRadius(0, pixelsPerDot("t1")) / armRadius(1, pixelsPerDot("t1"))).toBeCloseTo(ARM_ROOT_RATIO, 5);
		expect(armRadius(1, pixelsPerDot("t2"))).toBe(Math.max(0.5, (ARM_TIP_WIDTH_PX / 2 / 9) * 1));
	});

	test("ants stand on the burrow floor whatever the stage's height: 5 and 12 rows", () => {
		const snap = snapshot(["running", "reserved"], ["write", "write"]);
		snap.lanes.forEach(lane => Object.assign(lane, { unscoped: true }));
		// The ant art's own boxes: a worker 45x36 anchored at (22,18), the structure 72x63 anchored on its base (36,57).
		const antArt: StageAssets = {
			meta: id => (id.startsWith("ant/worker/") ? { durationMs: 1000, loop: true, size: { w: 45, h: 36 }, anchor: { x: 22, y: 18 } }
				: id.startsWith("ant/director/") ? { durationMs: 1000, loop: true, size: { w: 72, h: 63 }, anchor: { x: 36, y: 57 } }
				: undefined),
			frame: () => undefined,
		};
		for (const rows of [4, 11]) {
			const scene = stageScene({ snapshot: snap, moment: stageAt(snap, snap.now, false), cols: 36, rows, t: 0, motion: false, assets: antArt });
			expect(scene.species).toBe("ant");
			const k = pixelsPerDot("t1");
			const floor = rows * 18 - ANT_FLOOR_PX;
			const director = scene.individuals.find(item => item.lane < 0)!;
			expect(director.y * k + ANT_DIRECTOR_BASE_PX).toBeCloseTo(floor, 5);
			for (const ant of scene.individuals.filter(item => item.lane >= 0)) expect(ant.y * k + ANT_WORKER_FEET_PX).toBeCloseTo(floor, 5);
		}
	});

	test("every individual's sprite box stays inside the picture, the octopus's upper arm tips on a four-row picture too", () => {
		const snap = snapshot(["running", "running", "running", "running", "running", "running"], ["read", "write", "read", "write", "read", "write"]);
		for (const rows of [4, 7, 11]) {
			const scene = stageScene({ snapshot: snap, moment: stageAt(snap, snap.now, false), cols: 36, rows, t: 0, motion: false });
			expect(scene.species).toBe("octopus");
			const k = pixelsPerDot("t1");
			for (const item of scene.individuals) {
				const box = STAGE_ASSETS.meta(item.seq)!;
				expect(item.y * k - box.anchor.y).toBeGreaterThanOrEqual(-1e-6);
				expect(item.y * k - box.anchor.y + box.size.h).toBeLessThanOrEqual(rows * 18 + 1e-6);
			}
		}
	});
});

describe("the director's own edit and the finale's species", () => {
	const director = (snap: LaneSnapshot) =>
		stageScene({ snapshot: snap, moment: stageAt(snap, snap.now, false), cols: 36, rows: 4, t: 0, motion: false }).individuals.find(item => item.lane < 0)!.seq;

	test("while the director edits a file itself, the owl re-grips its piece; other species' directors do not change", () => {
		const alone = snapshot(["idle"]);
		expect(director(alone)).toBe("owl/director/work");
		expect(director({ ...alone, directorEditing: true })).toBe("owl/director/edit");
		const busy = snapshot(["running", "running"], ["read", "write"]);
		expect(director({ ...busy, directorEditing: true })).toBe("octopus/director/work");
	});

	test("the finale belongs to the team that did the work, though the owl stood in when the last lane settled", () => {
		const done: LaneSnapshot = {
			now: 20_000,
			phases: [{ from: 0, to: 15_000, phase: "workers" }, { from: 15_000, phase: "stopping" }],
			rounds: [0],
			complete: true,
			milestones: [],
			lanes: [
				{ name: "a", label: "", dependsOn: [], slot: 0, intent: "read", spans: [{ from: 0, to: 10_000, state: "running" }, { from: 10_000, state: "accepted" }] },
				{ name: "b", label: "", dependsOn: [], slot: 1, intent: "write", spans: [{ from: 0, to: 11_000, state: "running" }, { from: 11_000, state: "accepted" }] },
			],
		};
		expect(stageAt(done, 12_000).cast.species).toBe("owl");
		expect(stageAt(done, 20_000).cast).toMatchObject({ species: "octopus", pose: "finale" });
	});
});

describe("pieces never cover the director", () => {
	const pieces: LanePiece[] = [{ id: "p1", state: "accepted" }, { id: "p2", state: "accepted" }, { id: "p3", state: "pending" }, { id: "p4", state: "reviewable" }];
	const casts: Array<[Species, LaneSnapshot]> = [
		["octopus", snapshot(["running", "running"], ["read", "write"])],
		["bee", snapshot(["running", "running"], ["read", "read"])],
		["ant", (() => {
			const s = snapshot(["running", "reserved"], ["write", "write"]);
			s.lanes.forEach(lane => Object.assign(lane, { unscoped: true }));
			return s;
		})()],
		["orca", snapshot(["reviewing", "reviewing"])],
		["owl", snapshot(["idle", "submitted"])],
	];
	for (const [species, base] of casts) {
		for (const rows of [4, 7, 11]) {
			test(`${species}, ${rows + 1} rows: every piece is clear of the director's sprite box`, () => {
				const snap: LaneSnapshot = { ...base, lanes: base.lanes.map(lane => ({ ...lane, pieces })) };
				const scene = stageScene({ snapshot: snap, moment: stageAt(snap, snap.now, false), cols: 36, rows, t: 0, motion: false });
				expect(scene.species).toBe(species);
				const director = scene.individuals.find(item => item.lane < 0)!;
				const meta = STAGE_ASSETS.meta(director.seq)!;
				const k = pixelsPerDot("t1");
				const box = { x0: director.x * k - meta.anchor.x, y0: director.y * k - meta.anchor.y };
				expect(scene.pieces.length).toBeGreaterThan(0);
				for (const piece of scene.pieces) {
					// The piece as drawn: a disc of 0.7 dot around (x + 0.5, y).
					const [px, py, r] = [(piece.x + 0.5) * k, piece.y * k, 0.7 * k];
					const overlaps = px + r > box.x0 && px - r < box.x0 + meta.size.w && py + r > box.y0 && py - r < box.y0 + meta.size.h;
					expect(overlaps, `${piece.id} at ${piece.x.toFixed(1)},${piece.y.toFixed(1)}`).toBe(false);
				}
			});
		}
	}
});

describe("the art holds every sequence the scene can ask for", () => {
	const index = (() => {
		try {
			return JSON.parse(readFileSync(new URL("../assets/stage/index.json", import.meta.url), "utf8")) as { sequences: Record<string, unknown> };
		} catch {
			return undefined;
		}
	})();
	for (const species of ["octopus", "bee", "ant", "orca", "owl", "starling"] as const) {
		// With baked art in the package, every species must be complete; only a checkout without the art skips.
		test.skipIf(index === undefined)(`${species}: every requestable sequence is baked`, () => {
			const missing = requestableSequences(species).filter(id => index!.sequences[id] === undefined);
			expect(missing).toEqual([]);
		});
	}
	test("the list is the scene's: a species' ids all name it, and the owl and starlings have no lane workers' poses", () => {
		for (const species of ["octopus", "bee", "ant", "orca", "owl", "starling"] as const) {
			expect(requestableSequences(species).every(id => id.startsWith(`${species}/`))).toBe(true);
		}
		expect(requestableSequences("owl").some(id => id.startsWith("owl/worker/"))).toBe(false);
		expect(requestableSequences("owl")).toContain("owl/director/edit");
		expect(requestableSequences("starling")).toEqual(["starling/fx/background", "starling/director/gather", "starling/worker/fly"]);
	});
});
