/**
 * A small PNG encoder for the stage bake: 8-bit greyscale+alpha (the baked sheets) and RGBA (contact sheets). Each row
 * takes whichever of the five PNG filters gives the smallest sum of absolute residuals, and the image data is deflated at
 * level 9, so the same pixels always give the same bytes.
 */
import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** PNG colour type by channels per pixel. */
const COLOUR_TYPE: Readonly<Record<number, number>> = { 1: 0, 2: 4, 3: 2, 4: 6 };

function chunk(type: string, data: Uint8Array): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
	return out;
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encodes `px` (`w` by `h`, `channels` bytes per pixel, rows top to bottom) as a PNG. */
export function encodePng(px: Uint8Array, w: number, h: number, channels: 1 | 2 | 3 | 4): Buffer {
	const stride = w * channels;
	if (px.length !== stride * h) throw new Error(`png: ${px.length} bytes for ${w}x${h}x${channels}`);
	const raw = new Uint8Array((stride + 1) * h);
	const trial = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const row = y * stride;
		const prev = y > 0 ? row - stride : -1;
		let best = Infinity;
		for (let filter = 0; filter < 5; filter++) {
			let cost = 0;
			for (let x = 0; x < stride; x++) {
				const v = px[row + x]!;
				const a = x >= channels ? px[row + x - channels]! : 0;
				const b = prev >= 0 ? px[prev + x]! : 0;
				const c = prev >= 0 && x >= channels ? px[prev + x - channels]! : 0;
				const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
				const residual = (v - predicted) & 0xff;
				trial[x] = residual;
				cost += residual < 128 ? residual : 256 - residual;
			}
			if (cost < best) {
				best = cost;
				raw[y * (stride + 1)] = filter;
				raw.set(trial, y * (stride + 1) + 1);
			}
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = COLOUR_TYPE[channels]!;
	return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0))]);
}
