/**
 * The few PNG operations the stage needs, with no dependency beyond `node:zlib`: an indexed (colour type 3) encoder
 * for T1 frames (4x4 ordered dither through an RGB565 lookup table, B0), an RGBA encoder for the one transparent frame
 * that clears a stage, and a decoder for the baked sheets (8-bit, not interlaced; grey, grey+alpha, RGB, RGBA or
 * indexed). The encoders are deterministic: the same pixels and palette give the same bytes.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
	return out;
}

function header(w: number, h: number, colourType: number): Uint8Array {
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, w);
	view.setUint32(4, h);
	ihdr[8] = 8;
	ihdr[9] = colourType;
	return ihdr;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** RGB565 key -> nearest palette index, weighted like the eye (64 KiB; built once per palette). */
export function paletteLut(plte: Uint8Array): Uint8Array {
	const lut = new Uint8Array(65536);
	const n = plte.length / 3;
	for (let key = 0; key < 65536; key++) {
		const r = ((key >> 11) << 3) | 4;
		const g = (((key >> 5) & 63) << 2) | 2;
		const b = ((key & 31) << 3) | 4;
		let best = 0;
		let bestD = Number.POSITIVE_INFINITY;
		for (let i = 0; i < n; i++) {
			const dr = plte[i * 3]! - r;
			const dg = plte[i * 3 + 1]! - g;
			const db = plte[i * 3 + 2]! - b;
			const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		lut[key] = best;
	}
	return lut;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const byte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** An indexed PNG of an opaque RGB frame (`w*h*3` bytes): ordered dither, palette lookup, no filter. */
export function indexedPng(rgb: Uint8Array, w: number, h: number, plte: Uint8Array, lut: Uint8Array): Uint8Array {
	const raw = new Uint8Array((w + 1) * h);
	for (let y = 0; y < h; y++) {
		const at = y * (w + 1);
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			const d = BAYER4[(y & 3) * 4 + (x & 3)]! - 7.5;
			const r = byte(rgb[i]! + d);
			const g = byte(rgb[i + 1]! + d * 0.5);
			const b = byte(rgb[i + 2]! + d);
			raw[at + 1 + x] = lut[((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)]!;
		}
	}
	return concat([SIGNATURE, chunk("IHDR", header(w, h, 3)), chunk("PLTE", plte), chunk("IDAT", deflateSync(raw, { level: 3 })), chunk("IEND", new Uint8Array(0))]);
}

/** An RGBA PNG (`w*h*4` bytes), no filter. */
export function rgbaPng(rgba: Uint8Array, w: number, h: number): Uint8Array {
	const raw = new Uint8Array((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
	return concat([SIGNATURE, chunk("IHDR", header(w, h, 6)), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))]);
}

export interface DecodedPng { w: number; h: number; rgba: Uint8Array }

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes an 8-bit, non-interlaced PNG to RGBA; throws on anything else. */
export function decodePng(bytes: Uint8Array): DecodedPng {
	for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let w = 0;
	let h = 0;
	let type = -1;
	let plte: Uint8Array | undefined;
	let trns: Uint8Array | undefined;
	const idat: Uint8Array[] = [];
	for (let at = 8; at + 8 <= bytes.length; ) {
		const length = view.getUint32(at);
		const name = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
		const data = bytes.subarray(at + 8, at + 8 + length);
		if (name === "IHDR") {
			w = view.getUint32(at + 8);
			h = view.getUint32(at + 12);
			if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit, non-interlaced PNG");
			type = data[9]!;
		} else if (name === "PLTE") plte = data;
		else if (name === "tRNS") trns = data;
		else if (name === "IDAT") idat.push(data);
		else if (name === "IEND") break;
		at += 12 + length;
	}
	const channels = CHANNELS[type];
	if (channels === undefined || w === 0 || h === 0) throw new Error(`unsupported PNG colour type ${type}`);
	const raw = inflateSync(concat(idat));
	const stride = w * channels;
	const pixels = new Uint8Array(stride * h);
	for (let y = 0; y < h; y++) {
		const filter = raw[y * (stride + 1)]!;
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const v = raw[src + x]!;
			const a = x >= channels ? pixels[row + x - channels]! : 0;
			const b = y > 0 ? pixels[row - stride + x]! : 0;
			const c = x >= channels && y > 0 ? pixels[row - stride + x - channels]! : 0;
			let p: number;
			if (filter === 0) p = 0;
			else if (filter === 1) p = a;
			else if (filter === 2) p = b;
			else if (filter === 3) p = (a + b) >> 1;
			else {
				const q = a + b - c;
				const pa = Math.abs(q - a);
				const pb = Math.abs(q - b);
				const pc = Math.abs(q - c);
				p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			pixels[row + x] = (v + p) & 0xff;
		}
	}
	const rgba = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const o = i * 4;
		const s = i * channels;
		if (type === 0 || type === 4) {
			rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[s]!;
			rgba[o + 3] = type === 4 ? pixels[s + 1]! : 255;
		} else if (type === 2 || type === 6) {
			rgba[o] = pixels[s]!;
			rgba[o + 1] = pixels[s + 1]!;
			rgba[o + 2] = pixels[s + 2]!;
			rgba[o + 3] = type === 6 ? pixels[s + 3]! : 255;
		} else {
			const k = pixels[s]!;
			rgba[o] = plte?.[k * 3] ?? 0;
			rgba[o + 1] = plte?.[k * 3 + 1] ?? 0;
			rgba[o + 2] = plte?.[k * 3 + 2] ?? 0;
			rgba[o + 3] = trns?.[k] ?? 255;
		}
	}
	return { w, h, rgba };
}
