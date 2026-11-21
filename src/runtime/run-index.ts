/**
 * Run summary index: `<root>/.omp/storm/state/runs/index.jsonl`, one `storm.run-summary/v1` line per finished run.
 * It outlives the run records `pruneRuns` removes (that only touches `run-*.json`) and keeps its newest lines.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunRecord, RunSummary } from "../types.ts";
import { runsDir } from "./run.ts";

export const RUN_INDEX_MAX = 1000;

export function runIndexFile(root: string): string {
	return path.join(runsDir(root), "index.jsonl");
}

/** The comparable numbers of one run: cost, director share and context, reviews, blocks, reads, compactions, cleanup. */
export function summarizeForIndex(run: RunRecord): RunSummary {
	const agents = run.agents ?? [];
	const summary: RunSummary = {
		schema: "storm.run-summary/v1",
		runId: run.runId,
		startedAt: run.startedAt,
		status: run.status,
		task: run.task,
		costUsd: run.costUsd,
		agents: agents.length,
		spawns: { total: run.spawns.length, blocked: run.spawns.filter(s => s.outcome === "blocked").length },
	};
	if (run.endedAt !== undefined) summary.endedAt = run.endedAt;
	if (run.mainCostUsd !== undefined) summary.mainCostUsd = run.mainCostUsd;
	if (run.maxMainContext !== undefined) summary.maxMainContext = run.maxMainContext;
	if (agents.length) summary.maxAgentContext = Math.max(...agents.map(a => a.contextTokens));
	const tallies = agents.flatMap(a => (a.review ? [a.review] : []));
	if (tallies.length) {
		summary.reviews = { reviews: 0, passed: 0, failed: 0, docFindings: 0 };
		for (const t of tallies) {
			summary.reviews.reviews += t.reviews;
			summary.reviews.passed += t.passed;
			summary.reviews.failed += t.failed;
			summary.reviews.docFindings += t.docFindings ?? 0;
		}
	}
	if (run.blockedFollowUps !== undefined) summary.blockedFollowUps = run.blockedFollowUps;
	if (run.reads) summary.reads = { ...run.reads };
	if (run.checkpoints) summary.checkpoints = run.checkpoints.length;
	if (run.cleanup) summary.cleanup = { ...run.cleanup };
	return summary;
}

// Appends are read-modify-write; a per-root chain keeps two in one process from losing a line.
const chains = new Map<string, Promise<void>>();

/** Appends one summary and keeps the newest `max` lines; written through a temp file and rename. */
export function appendRunIndex(root: string, summary: RunSummary, max = RUN_INDEX_MAX): Promise<void> {
	const key = path.resolve(root);
	const run = (chains.get(key) ?? Promise.resolve()).then(async () => {
		const file = runIndexFile(root);
		let lines: string[] = [];
		try {
			lines = (await fs.readFile(file, "utf8")).split("\n").filter(line => line.trim() !== "");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		lines.push(JSON.stringify(summary));
		const kept = lines.slice(Math.max(0, lines.length - Math.max(1, max)));
		await fs.mkdir(path.dirname(file), { recursive: true });
		const tmp = path.join(path.dirname(file), `.index.jsonl.${process.pid}.${crypto.randomUUID()}.tmp`);
		try {
			await fs.writeFile(tmp, `${kept.join("\n")}\n`);
			await fs.rename(tmp, file);
		} catch (error) {
			await fs.rm(tmp, { force: true });
			throw error;
		}
	});
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	chains.set(key, tail);
	void tail.then(() => {
		if (chains.get(key) === tail) chains.delete(key);
	});
	return run;
}

function isSummary(value: unknown): value is RunSummary {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return v.schema === "storm.run-summary/v1" && typeof v.runId === "string" && typeof v.startedAt === "string";
}

/** Summaries oldest first; a missing index is empty and torn or foreign lines are skipped. */
export async function readRunIndex(root: string): Promise<RunSummary[]> {
	let text: string;
	try {
		text = await fs.readFile(runIndexFile(root), "utf8");
	} catch {
		return [];
	}
	const out: RunSummary[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSummary(value)) out.push(value);
		} catch {
			// torn line
		}
	}
	return out;
}
