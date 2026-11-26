/** Small numeric helpers shared by the effects. Everything here is pure except `accumulate`, which keeps phases. */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
/** Smoothstep of `u` clamped to 0..1. */
export const smooth = (u: number): number => {
	const c = clamp(u);
	return c * c * (3 - 2 * c);
};
export const mod = (a: number, n: number): number => ((a % n) + n) % n;
export const hueMod = (h: number): number => mod(h, 360);

/** A repeatable pseudo-random number in 0..1 for an integer-ish seed. */
export function hash(n: number): number {
	let h = Math.imul(Math.floor(n) + 0x9e3779b9, 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Period of the verification scan; the trunk and the reviewing lanes share it, so they sweep in one rhythm. */
export const SCAN_PERIOD_MS = 2900;

/** 0..1..0 over one scan period. */
export function pingPong(t: number): number {
	const u = mod(t, SCAN_PERIOD_MS) / SCAN_PERIOD_MS;
	return u < 0.5 ? u * 2 : 2 - u * 2;
}

/**
 * A phase that grows by `speed` dots per second, kept per `key` so a speed that changes does not make the pattern jump
 * (a stateless `t * speed` would). A step of 500 ms or more, or one backwards, adds nothing: the phase just carries on
 * from where it was. The table is module state and is emptied when it grows past `LIMIT` keys.
 */
const accumulators = new Map<string, { ph: number; at: number }>();
const LIMIT = 512;
export function accumulate(key: string, t: number, speed: number): number {
	const found = accumulators.get(key);
	if (found === undefined) {
		if (accumulators.size >= LIMIT) accumulators.clear();
		const fresh = { ph: (t * speed) / 1000, at: t };
		accumulators.set(key, fresh);
		return fresh.ph;
	}
	const dt = t - found.at;
	if (dt > 0 && dt < 500) found.ph += (speed * dt) / 1000;
	found.at = t;
	return found.ph;
}
