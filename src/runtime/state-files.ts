import * as path from "node:path";
import { readJson, serialized, writeJsonAtomic } from "../fsutil.ts";
import type { QuotaMark, TrialState } from "../types.ts";
import { stateDir } from "./run.ts";

const quotaFile = (root: string): string => path.join(stateDir(root), "quota-marks.json");
const trialsFile = (root: string): string => path.join(stateDir(root), "trials.json");

/** Parallel spawns bump trial counters at once; one chain per state dir turns each read-modify-write into one step. */
function update<T>(root: string, step: () => Promise<T>): Promise<T> {
	return serialized(path.resolve(stateDir(root)), step);
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

async function readAllMarks(root: string): Promise<QuotaMark[]> {
	const value = await readJson(quotaFile(root));
	const marks = typeof value === "object" && value !== null ? (value as Record<string, unknown>).marks : undefined;
	return Array.isArray(marks) ? marks.filter(isQuotaMark) : [];
}

export async function readQuotaMarks(root: string, now: number): Promise<QuotaMark[]> {
	return (await readAllMarks(root)).filter(m => Date.parse(m.until) > now);
}

/** Replaces the provider's previous mark and drops marks that expired by the new mark's time. */
export function addQuotaMark(root: string, mark: QuotaMark): Promise<void> {
	return update(root, async () => {
		const at = Date.parse(mark.markedAt);
		const now = Number.isFinite(at) ? at : Date.now();
		const kept = (await readAllMarks(root)).filter(m => m.provider !== mark.provider && Date.parse(m.until) > now);
		await writeJsonAtomic(quotaFile(root), { schema: "storm.quota-marks/v1", marks: [...kept, mark] });
	});
}

export async function readTrialStates(root: string): Promise<Record<string, TrialState>> {
	const value = await readJson(trialsFile(root));
	const trials = typeof value === "object" && value !== null ? (value as Record<string, unknown>).trials : undefined;
	const out: Record<string, TrialState> = {};
	if (typeof trials !== "object" || trials === null || Array.isArray(trials)) return out;
	for (const [id, state] of Object.entries(trials)) if (isTrialState(state) && state.id === id) out[id] = state;
	return out;
}

export function updateTrialState(root: string, id: string, change: (current: TrialState) => TrialState): Promise<TrialState> {
	return update(root, async () => {
		const all = await readTrialStates(root);
		const next = change(all[id] ?? { id, seen: 0, routed: 0, costUsd: 0 });
		all[id] = next;
		await writeJsonAtomic(trialsFile(root), { schema: "storm.trials/v1", trials: all });
		return next;
	});
}

/** Storm limits: drops counters of trials no longer in the config. Returns how many it dropped. */
export function pruneTrialStates(root: string, keepIds: readonly string[]): Promise<number> {
	return update(root, async () => {
		const all = await readTrialStates(root);
		const stale = Object.keys(all).filter(id => !keepIds.includes(id));
		if (stale.length === 0) return 0;
		for (const id of stale) delete all[id];
		await writeJsonAtomic(trialsFile(root), { schema: "storm.trials/v1", trials: all });
		return stale.length;
	});
}
