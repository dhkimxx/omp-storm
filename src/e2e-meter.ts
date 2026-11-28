/**
 * E2E measurement only: an opt-in, read-only observer of the omp process that loaded Storm.
 *
 * Active only when `STORM_E2E_METER` names a directory. Each thread (the host's main thread, each pooled subagent
 * worker) has its own module instance and writes its own files there:
 *   hooks-<pid>-<threadId>-<instance>.jsonl   one line per Storm hook call: event, milliseconds, agent, kind, time
 *   thread-<pid>-<threadId>-<instance>.json   cumulative counters: hook totals, RSS peak, event-loop lag histogram
 *   boot-<pid>-<threadId>-<instance>.json     one per loaded plugin copy: pid, thread, main flag, boot time
 *
 * The counters are what a scenario reads before and after one batch. Nothing here changes a decision: the wrapper
 * calls the same handler with the same arguments and returns its result; when the env var is absent it is inert.
 * `scripts/e2e/spawn-cost.ts` is the one scenario that turns it on.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "./config/schema.ts";

const ROOT = process.env.STORM_E2E_METER ?? "";
export const METER_ON = ROOT !== "";

if (METER_ON) mkdirSync(ROOT, { recursive: true });

const bootedAt = Date.now();
const pid = process.pid;
const main = Bun.isMainThread === true;
// omp loads the plugin again for a child session, sometimes more than once in the same thread. A shared file name
// would let the last instance's counters overwrite the others, so every module instance owns its own files.
const instance = crypto.randomUUID().slice(0, 8);

interface Stat {
	n: number;
	sum: number;
	max: number;
}
const stats = new Map<string, Stat>();
const pending: string[] = [];
const hooksFile = METER_ON ? join(ROOT, `hooks-${pid}-${threadId}-${instance}.jsonl`) : "";
const threadFile = METER_ON ? join(ROOT, `thread-${pid}-${threadId}-${instance}.json`) : "";

if (METER_ON) {
	try {
		writeFileSync(join(ROOT, `boot-${pid}-${threadId}-${instance}.json`), `${JSON.stringify({ pid, threadId, main, instance, bootedAt })}\n`);
	} catch {
		// A measurement file that cannot be written is not a reason to fail a run.
	}
}

function flushHooks(): void {
	if (pending.length === 0) return;
	appendFileSync(hooksFile, pending.join(""));
	pending.length = 0;
}

// ── event loop lag, RSS ─────────────────────────────────────────────────────────────────

const LAG_CAP = 20_000;
const lags: number[] = [];
let rssMax = 0;
let loopMax = 0;
let loopSum = 0;
let loopSamples = 0;
let late50 = 0;
let late200 = 0;
let late1000 = 0;
let lastAt = 0;
let expected = performance.now() + 100;

function percentile(values: readonly number[], share: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * share) - 1));
	return Math.round((sorted[at] ?? 0) * 10) / 10;
}

function publish(): void {
	if (!METER_ON) return;
	lastAt = Date.now();
	const hooks: Record<string, Stat> = {};
	for (const [key, value] of stats) hooks[key] = { ...value };
	const body = JSON.stringify({
		pid,
		threadId,
		main,
		instance,
		bootedAt,
		lastAt,
		rssMax,
		samples: loopSamples,
		loop: { max: Math.round(loopMax * 10) / 10, p95: percentile(lags, 0.95), mean: loopSamples === 0 ? 0 : Math.round((loopSum / loopSamples) * 10) / 10, lagSum: Math.round(loopSum * 10) / 10, late50, late200, late1000 },
		hooks,
	});
	try {
		writeFileSync(threadFile, `${body}\n`);
	} catch {
		// Observability must never fail a run.
	}
	flushHooks();
}

let ticks = 0;
if (METER_ON) {
	const timer = setInterval(() => {
		const now = performance.now();
		const lag = Math.max(0, now - expected);
		expected = now + 100;
		loopSamples++;
		loopSum += lag;
		if (lag > loopMax) loopMax = lag;
		if (lag >= 50) late50++;
		if (lag >= 200) late200++;
		if (lag >= 1000) late1000++;
		if (lags.length < LAG_CAP) lags.push(lag);
		rssMax = Math.max(rssMax, process.memoryUsage().rss);
		if (++ticks % 5 === 0) publish();
	}, 100);
	// A measurement timer must not keep a worker thread alive.
	timer.unref?.();
}

// ── hook wrapper ────────────────────────────────────────────────────────────────────────

function recordStat(key: string, ms: number): void {
	const stat = stats.get(key) ?? { n: 0, sum: 0, max: 0 };
	stat.n++;
	stat.sum += ms;
	if (ms > stat.max) stat.max = ms;
	stats.set(key, stat);
}

/** Wraps `pi.on` so every handler's wall time and caller are recorded; every other member passes through. */
export function instrument(pi: ExtensionAPI): ExtensionAPI {
	if (!METER_ON) return pi;
	return new Proxy(pi, {
		get(target, prop) {
			if (prop === "on") {
				return (event: string, handler: (...args: unknown[]) => unknown) => {
					const wrapped = (...args: unknown[]): unknown => {
						const started = performance.now();
						const at = Date.now();
						const first = isRecord(args[0]) ? args[0] : undefined;
						const agent = isRecord(args[1]) && isRecord(args[1].agent) ? args[1].agent : undefined;
						const kind = typeof agent?.kind === "string" ? agent.kind : "-";
						const key = `${event}#${kind}`;
						const done = (failed: boolean): void => {
							const ms = performance.now() - started;
							recordStat(key, ms);
							if (pending.length < 5_000) {
								pending.push(
									`${JSON.stringify({
										t: at,
										ms: Math.round(ms * 100) / 100,
										e: event,
										k: kind,
										a: typeof agent?.id === "string" ? agent.id : "",
										x: typeof first?.agent === "string" ? first.agent : "",
										s: typeof first?.spawnKey === "string" ? first.spawnKey : "",
										f: failed ? 1 : 0,
									})}\n`,
								);
							}
							if (ms >= 50) flushHooks();
						};
						let result: unknown;
						try {
							result = handler(...args);
						} catch (error) {
							done(true);
							throw error;
						}
						if (isRecord(result) && typeof result.then === "function") {
							// The handler's own promise: the `then` check above is the runtime proof.
							const thenable = result as unknown as Promise<unknown>;
							return thenable.then(
								value => {
									done(false);
									return value;
								},
								error => {
									done(true);
									throw error;
								},
							);
						}
						done(false);
						return result;
					};
					const register = target.on as unknown as (event: string, handler: (...args: unknown[]) => unknown) => unknown;
					return register(event, wrapped);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});
}
