/**
 * Run summary index: `<sessionDir>/state/runs/index.jsonl`, one `storm.run-summary/v1` line per finished run. It
 * belongs to one native session's own store, outlives the run records `pruneRuns` removes (that only touches
 * `run-*.json`) and keeps its newest lines.
 */
import * as path from "node:path";
import { readJsonl, serialized, writeTextAtomic } from "../fsutil.ts";
import type { RunRecord, RunSummary } from "../types.ts";
import { assertSessionPathSafe } from "../session-scope.ts";
import { reviewTotals } from "./review.ts";
import { runsDir } from "./run.ts";

export const RUN_INDEX_MAX = 1000;

export function runIndexFile(sessionDir: string): string {
	return path.join(runsDir(sessionDir), "index.jsonl");
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
	if (agents.some(a => a.review)) {
		const { reviews, passed, failed, docFindings } = reviewTotals(agents);
		summary.reviews = { reviews, passed, failed, docFindings };
	}
	if (run.blockedFollowUps !== undefined) summary.blockedFollowUps = run.blockedFollowUps;
	if (run.reads) summary.reads = { ...run.reads };
	if (run.checkpoints) summary.checkpoints = run.checkpoints.length;
	if (run.turns !== undefined) summary.turns = run.turns;
	if (run.endReason !== undefined) summary.endReason = run.endReason;
	if (run.cleanup) summary.cleanup = { ...run.cleanup };
	return summary;
}

function isSummary(value: unknown): value is RunSummary {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return v.schema === "storm.run-summary/v1" && typeof v.runId === "string" && typeof v.startedAt === "string";
}

/** Summaries oldest first; a missing index is empty and torn or foreign lines are skipped. */
export async function readRunIndex(sessionDir: string): Promise<RunSummary[]> {
	const file = runIndexFile(sessionDir);
	await assertSessionPathSafe(sessionDir, file);
	return readJsonl(file, isSummary);
}

/** Appends one summary and keeps the newest `max` lines. */
export function appendRunIndex(sessionDir: string, summary: RunSummary, max = RUN_INDEX_MAX): Promise<void> {
	const file = path.resolve(runIndexFile(sessionDir));
	return serialized(file, async () => {
		const kept = [...(await readRunIndex(sessionDir)), summary].slice(-Math.max(1, max));
		await assertSessionPathSafe(sessionDir, file);
		await writeTextAtomic(file, kept.map(line => `${JSON.stringify(line)}\n`).join(""));
	});
}
