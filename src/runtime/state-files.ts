import * as path from "node:path";
import { readJson, serialized, writeJsonAtomic } from "../fsutil.ts";
import type { QuotaMark, TrialState } from "../types.ts";
import { assertSessionPathSafe } from "../session-scope.ts";
import { stateDir } from "./run.ts";

/**
 * Per-session counters: `<sessionDir>/state/quota-marks.json` and `<sessionDir>/state/trials.json`. The directory is
 * the captured native session's own store, never the target work tree or another session's directory.
 */
const quotaFile = (sessionDir: string): string => path.join(stateDir(sessionDir), "quota-marks.json");
const trialsFile = (sessionDir: string): string => path.join(stateDir(sessionDir), "trials.json");

/** Parallel spawns bump trial counters at once; one chain per state dir turns each read-modify-write into one step. */
function update<T>(sessionDir: string, step: () => Promise<T>): Promise<T> {
	return serialized(path.resolve(stateDir(sessionDir)), step);
}

function isQuotaMark(value: unknown): value is QuotaMark {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.provider === "string" &&
		(v.source === "user" || v.source === "usage" || v.source === "fallback") &&
		typeof v.markedAt === "string" &&
		typeof v.until === "string" &&
		Number.isFinite(Date.parse(v.until))
	);
}

function isTrialState(value: unknown): value is TrialState {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && Number.isFinite(v.seen) && Number.isFinite(v.routed) && Number.isFinite(v.costUsd);
}

async function readAllMarks(sessionDir: string): Promise<QuotaMark[]> {
	const file = quotaFile(sessionDir);
	await assertSessionPathSafe(sessionDir, file);
	const value = await readJson(file);
	const marks = typeof value === "object" && value !== null ? (value as Record<string, unknown>).marks : undefined;
	return Array.isArray(marks) ? marks.filter(isQuotaMark) : [];
}

export async function readQuotaMarks(sessionDir: string, now: number): Promise<QuotaMark[]> {
	return (await readAllMarks(sessionDir)).filter(m => Date.parse(m.until) > now);
}

/** Replaces the provider's previous mark and drops marks that expired by the new mark's time. */
export function addQuotaMark(sessionDir: string, mark: QuotaMark): Promise<void> {
	return update(sessionDir, async () => {
		const at = Date.parse(mark.markedAt);
		const now = Number.isFinite(at) ? at : Date.now();
		const kept = (await readAllMarks(sessionDir)).filter(m => m.provider !== mark.provider && Date.parse(m.until) > now);
		const file = quotaFile(sessionDir);
		await assertSessionPathSafe(sessionDir, file);
		await writeJsonAtomic(file, { schema: "storm.quota-marks/v1", marks: [...kept, mark] });
	});
}

export async function readTrialStates(sessionDir: string): Promise<Record<string, TrialState>> {
	const file = trialsFile(sessionDir);
	await assertSessionPathSafe(sessionDir, file);
	const value = await readJson(file);
	const trials = typeof value === "object" && value !== null ? (value as Record<string, unknown>).trials : undefined;
	const out: Record<string, TrialState> = {};
	if (typeof trials !== "object" || trials === null || Array.isArray(trials)) return out;
	for (const [id, state] of Object.entries(trials)) if (isTrialState(state) && state.id === id) out[id] = state;
	return out;
}

export function updateTrialState(sessionDir: string, id: string, change: (current: TrialState) => TrialState): Promise<TrialState> {
	return update(sessionDir, async () => {
		const all = await readTrialStates(sessionDir);
		const next = change(all[id] ?? { id, seen: 0, routed: 0, costUsd: 0 });
		all[id] = next;
		const file = trialsFile(sessionDir);
		await assertSessionPathSafe(sessionDir, file);
		await writeJsonAtomic(file, { schema: "storm.trials/v1", trials: all });
		return next;
	});
}

/** Storm limits: drops counters of trials no longer in the config. Returns how many it dropped. */
export function pruneTrialStates(sessionDir: string, keepIds: readonly string[]): Promise<number> {
	return update(sessionDir, async () => {
		const all = await readTrialStates(sessionDir);
		const stale = Object.keys(all).filter(id => !keepIds.includes(id));
		if (stale.length === 0) return 0;
		for (const id of stale) delete all[id];
		const file = trialsFile(sessionDir);
		await assertSessionPathSafe(sessionDir, file);
		await writeJsonAtomic(file, { schema: "storm.trials/v1", trials: all });
		return stale.length;
	});
}
