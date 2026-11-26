/**
 * The Braille canvas: every row is exactly as wide as the terminal, dots outside the canvas vanish, wide characters are
 * never split, and the two colour modes write what their name says.
 */
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { Canvas, charWidth, textWidth } from "../src/view/lane/canvas.ts";
import { lookOf, oklch } from "../src/view/lane/colour.ts";

const DARK = lookOf(true);
const LIGHT = lookOf(false);
const BLUE = oklch(0.76, 0.2, 250);
const GREEN = oklch(0.8, 0.2, 152);
/** Our own SGR sequences. */
const SGR = /\x1b\[[0-9;]*m/g;

function plain(row: string): string {
	return row.replace(SGR, "");
}

/** Luminance of the first truecolor foreground in a row. */
function firstLuma(row: string): number {
	const m = /38;2;(\d+);(\d+);(\d+)m/.exec(row);
	if (m === null) throw new Error(`no truecolor in ${JSON.stringify(row)}`);
	return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
}

/** A small deterministic generator, so a failure can be replayed. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

describe("canvas rows", () => {
	test("an empty canvas is one blank, escape-free row per line, exactly as wide as asked", () => {
		for (const colour of ["truecolor", "256"] as const) {
			const rows = new Canvas(37, 5, DARK).rows(colour);
			expect(rows).toHaveLength(5);
			for (const row of rows) {
				expect(row).toBe(" ".repeat(37));
				expect(visibleWidth(row)).toBe(37);
			}
		}
	});

	test("a canvas with no cells gives no rows or empty ones", () => {
		expect(new Canvas(10, 0, DARK).rows("truecolor")).toEqual([]);
		expect(new Canvas(0, 2, DARK).rows("256")).toEqual(["", ""]);
		expect(new Canvas(-3.7, 2.9, DARK).cw).toBe(0);
	});

	test("a dot lights the matching Braille bit of its cell and nothing else", () => {
		const canvas = new Canvas(3, 2, DARK);
		canvas.dot(0, 0, BLUE, 1); // cell (0,0), bit 0x01
		canvas.dot(3, 3, BLUE, 1); // cell (1,0), column 1, row 3: bit 0x80
		canvas.dot(4, 4, BLUE, 1); // cell (2,1), column 0, row 0
		const [top, bottom] = canvas.rows("truecolor").map(plain);
		expect(top).toBe("⠁⢀ ");
		expect(bottom).toBe("  ⠁");
	});

	test("dots in one cell merge into one glyph", () => {
		const canvas = new Canvas(1, 1, DARK);
		canvas.dot(0, 0, BLUE, 1);
		canvas.dot(1, 0, BLUE, 1);
		canvas.dot(0, 3, BLUE, 1);
		expect(plain(canvas.rows("truecolor")[0]!)).toBe(String.fromCharCode(0x2800 + 0x01 + 0x08 + 0x40));
	});

	test("a dot outside the canvas, or too faint to see, draws nothing and throws nothing", () => {
		const canvas = new Canvas(4, 2, DARK);
		for (const [x, y] of [[-1, 0], [0, -1], [8, 0], [0, 8], [1e9, 1e9], [-1e9, 3], [Number.NaN, 0], [0, Number.NaN], [Infinity, 0]] as const) {
			canvas.dot(x, y, BLUE, 1);
		}
		canvas.dot(1, 1, BLUE, 0);
		canvas.dot(1, 1, BLUE, 0.01);
		canvas.dot(1, 1, BLUE, Number.NaN);
		canvas.dot(1, 1, BLUE, -4);
		for (const row of canvas.rows("truecolor")) expect(row).toBe("    ");
	});

	test("the dot at the last cell is kept and one dot beyond is dropped", () => {
		const canvas = new Canvas(4, 2, DARK);
		canvas.dot(7, 7, BLUE, 1);
		canvas.dot(8, 7, BLUE, 1);
		canvas.dot(7, 8, BLUE, 1);
		const [top, bottom] = canvas.rows("truecolor").map(plain);
		expect(top).toBe("    ");
		expect(bottom).toBe("   ⢀");
	});

	test("every row ends with a reset when it drew something, and has no other escape than colour codes", () => {
		const canvas = new Canvas(6, 2, DARK);
		canvas.dot(0, 0, BLUE, 1);
		canvas.text(1, 0, "ab", GREEN, 1, true);
		const [row, blank] = canvas.rows("truecolor");
		expect(row!.endsWith("\x1b[0m")).toBe(true);
		expect(blank).toBe("      ");
		expect(row!.replace(SGR, "")).not.toContain("\x1b");
	});
});

describe("canvas text", () => {
	test("a Korean syllable takes two cells and a row stays as wide as the canvas", () => {
		const canvas = new Canvas(10, 1, DARK);
		const used = canvas.text(0, 0, "감독ab", GREEN);
		expect(used).toBe(6);
		const [row] = canvas.rows("truecolor");
		expect(plain(row!)).toBe("감독ab    ");
		expect(visibleWidth(row!)).toBe(10);
	});

	test("text is measured in display cells, not in characters", () => {
		expect(textWidth("abc")).toBe(3);
		expect(textWidth("감독")).toBe(4);
		expect(textWidth("a감b")).toBe(4);
		expect(textWidth("")).toBe(0);
		expect(charWidth("가".codePointAt(0)!)).toBe(2);
		expect(charWidth("a".codePointAt(0)!)).toBe(1);
		expect(charWidth(0x301)).toBe(0);
	});

	test("a wide character that does not fit before the right edge is not drawn, not split", () => {
		const canvas = new Canvas(5, 1, DARK);
		const used = canvas.text(3, 0, "한글", GREEN);
		expect(used).toBe(2);
		const [row] = canvas.rows("truecolor");
		expect(plain(row!)).toBe("   한");
		expect(visibleWidth(row!)).toBe(5);

		const edge = new Canvas(5, 1, DARK);
		expect(edge.text(4, 0, "한", GREEN)).toBe(0);
		expect(plain(edge.rows("truecolor")[0]!)).toBe("     ");
	});

	test("text that starts left of the canvas shows only what lies inside, and a half-visible wide character is skipped", () => {
		const canvas = new Canvas(6, 1, DARK);
		canvas.text(-1, 0, "한ab", GREEN);
		const [row] = canvas.rows("truecolor");
		expect(visibleWidth(row!)).toBe(6);
		expect(plain(row!)).toBe(" ab   ");
	});

	test("text above or below the canvas is ignored", () => {
		const canvas = new Canvas(6, 2, DARK);
		expect(canvas.text(0, -1, "x", GREEN)).toBe(0);
		expect(canvas.text(0, 2, "x", GREEN)).toBe(0);
		for (const row of canvas.rows("256")) expect(row).toBe("      ");
	});

	test("text at a coordinate that is not a number is ignored", () => {
		const canvas = new Canvas(6, 2, DARK);
		expect(canvas.text(Number.NaN, 0, "x", GREEN)).toBe(0);
		expect(canvas.text(0, Number.NaN, "x", GREEN)).toBe(0);
		expect(canvas.text(Infinity, 0, "x", GREEN)).toBe(0);
		for (const row of canvas.rows("256")) expect(row).toBe("      ");
	});

	test("text replaces dots, and dots do not draw over text", () => {
		const canvas = new Canvas(4, 1, DARK);
		canvas.dot(0, 0, BLUE, 1);
		canvas.text(0, 0, "x", GREEN);
		canvas.dot(0, 1, BLUE, 1);
		canvas.dot(2, 0, BLUE, 1);
		expect(plain(canvas.rows("truecolor")[0]!)).toBe("x⠁  ");
	});

	test("overwriting one half of a wide character clears the other half too", () => {
		const left = new Canvas(6, 1, DARK);
		left.text(0, 0, "한글", GREEN);
		left.text(1, 0, "x", GREEN); // lands on the right half of the first syllable
		expect(plain(left.rows("truecolor")[0]!)).toBe(" x글  ");

		const right = new Canvas(6, 1, DARK);
		right.text(0, 0, "한글", GREEN);
		right.text(3, 0, "y", GREEN); // lands on the right half of the second syllable
		const row = plain(right.rows("truecolor")[0]!);
		expect(row).toBe("한 y  ");
		expect(visibleWidth(row)).toBe(6);

		const wideOverWide = new Canvas(6, 1, DARK);
		wideOverWide.text(0, 0, "한글", GREEN);
		wideOverWide.text(1, 0, "가", GREEN);
		const over = plain(wideOverWide.rows("truecolor")[0]!);
		expect(over).toBe(" 가   ");
		expect(visibleWidth(over)).toBe(6);
	});

	test("control characters never reach the output: a name cannot inject an escape sequence", () => {
		const canvas = new Canvas(20, 1, DARK);
		canvas.text(0, 0, "a\x1b[31mb\nc\x07d\t", GREEN);
		const [row] = canvas.rows("truecolor");
		const body = row!.replace(SGR, "");
		expect(body).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(visibleWidth(row!)).toBe(20);
	});

	test("text with zero-width and combining marks keeps the column count honest", () => {
		const canvas = new Canvas(8, 1, DARK);
		const used = canvas.text(0, 0, "éx", GREEN);
		expect(used).toBe(2);
		expect(visibleWidth(canvas.rows("truecolor")[0]!)).toBe(8);
	});
});

describe("colour modes", () => {
	function sample(colour: "truecolor" | "256", look = DARK): string[] {
		const canvas = new Canvas(8, 2, look);
		canvas.dot(0, 0, BLUE, 1);
		canvas.dot(2, 0, GREEN, 1);
		canvas.text(0, 1, "감독", GREEN);
		return canvas.rows(colour);
	}

	test("truecolor writes 24-bit codes only", () => {
		const joined = sample("truecolor").join("");
		expect(joined).toMatch(/38;2;\d+;\d+;\d+m/);
		expect(joined).not.toContain("38;5;");
	});

	test("256 writes palette indexes in range and no 24-bit codes", () => {
		const rows = sample("256");
		const joined = rows.join("");
		expect(joined).not.toContain("38;2;");
		const indexes = [...joined.matchAll(/38;5;(\d+)m/g)].map((m) => Number(m[1]));
		expect(indexes.length).toBeGreaterThan(0);
		for (const index of indexes) {
			expect(index).toBeGreaterThanOrEqual(16);
			expect(index).toBeLessThanOrEqual(255);
		}
		for (const row of rows) expect(visibleWidth(row)).toBe(8);
	});

	test("a run of one colour is written once", () => {
		const canvas = new Canvas(10, 1, DARK);
		for (let x = 0; x < 20; x += 2) canvas.dot(x, 0, BLUE, 1);
		for (const colour of ["truecolor", "256"] as const) {
			const [row] = canvas.rows(colour);
			expect(row!.match(/38;/g)).toHaveLength(1);
		}
	});

	test("energy is brightness against the background, on both backgrounds", () => {
		const row = (look: typeof DARK, energy: number): string => {
			const canvas = new Canvas(1, 1, look);
			canvas.dot(0, 0, BLUE, energy);
			return canvas.rows("truecolor")[0]!;
		};
		expect(firstLuma(row(DARK, 1))).toBeGreaterThan(firstLuma(row(DARK, 0.3)));
		expect(firstLuma(row(DARK, 1.8))).toBeGreaterThan(firstLuma(row(DARK, 1)));
		expect(firstLuma(row(LIGHT, 1))).toBeLessThan(firstLuma(row(LIGHT, 0.3)));
	});

	test("draining pulls colour toward grey and leaves empty cells alone", () => {
		const canvas = new Canvas(3, 1, DARK);
		canvas.dot(0, 0, BLUE, 1);
		canvas.drain(1);
		const [row] = canvas.rows("truecolor");
		const m = /38;2;(\d+);(\d+);(\d+)m/.exec(row!)!;
		expect(Math.abs(Number(m[1]) - Number(m[2]))).toBeLessThanOrEqual(1);
		expect(Math.abs(Number(m[2]) - Number(m[3]))).toBeLessThanOrEqual(1);
		expect(plain(row!)).toBe("⠁  ");
		canvas.drain(Number.NaN);
		canvas.drain(-1);
	});
});

describe("clear", () => {
	test("a cleared canvas draws exactly what a new canvas draws", () => {
		const draw = (canvas: Canvas): string[] => {
			canvas.dot(3, 2, BLUE, 1);
			canvas.text(2, 1, "한글x", GREEN, 1, true);
			canvas.dot(9, 5, GREEN, 0.7);
			return canvas.rows("truecolor");
		};
		const reused = new Canvas(8, 3, DARK);
		reused.text(0, 0, "가나다라", BLUE, 2, true);
		reused.dot(12, 7, GREEN, 2);
		reused.clear();
		expect(reused.rows("truecolor")).toEqual(new Canvas(8, 3, DARK).rows("truecolor"));
		expect(draw(reused)).toEqual(draw(new Canvas(8, 3, DARK)));
	});
});

describe("canvas widths under random drawing", () => {
	test("whatever is drawn, every row is exactly as wide as the canvas and there are exactly `ch` rows", () => {
		const random = rng(7);
		const words = ["감독", "implementer", "구현 작업", "a", "한", "설계·검토", "emoji🙂x", "…", "é", "탐색 2/5"];
		for (let round = 0; round < 60; round++) {
			const cw = 1 + Math.floor(random() * 90);
			const ch = 1 + Math.floor(random() * 8);
			const canvas = new Canvas(cw, ch, random() < 0.5 ? DARK : LIGHT);
			for (let i = 0; i < 80; i++) {
				const colour = oklch(0.7, 0.2, random() * 360);
				if (random() < 0.6) canvas.dot(random() * cw * 2.4 - 4, random() * ch * 4.8 - 4, colour, random() * 2.4);
				else canvas.text(Math.floor(random() * (cw + 6)) - 3, Math.floor(random() * (ch + 2)) - 1, words[Math.floor(random() * words.length)]!, colour, random() * 2, random() < 0.5);
			}
			if (random() < 0.3) canvas.drain(random());
			for (const colour of ["truecolor", "256"] as const) {
				const rows = canvas.rows(colour);
				expect(rows).toHaveLength(ch);
				for (const row of rows) {
					expect(visibleWidth(row)).toBe(cw);
					expect(row).not.toContain("\n");
				}
			}
		}
	});
});
