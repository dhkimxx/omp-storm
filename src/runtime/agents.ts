/**
 * Agent ledger: every subagent session of this process as Storm saw it from inside the child.
 * Module-level on purpose: subagent sessions load this same module, so each child's events land
 * in the one map the parent reads.
 */
import type { AgentEntry } from "../types.ts";
import { tallyFromYield, verdictOf } from "./review.ts";

/** Parked entries older than this are dropped when a new agent is added. */
const PARKED_KEEP_MS = 24 * 3_600_000;

const agents = new Map<string, AgentEntry>();

function prune(now: number): void {
	for (const [id, e] of agents) {
		if (e.state === "parked" && now - e.lastActivityAt > PARKED_KEEP_MS) agents.delete(id);
	}
}

/**
 * Makes an entry one of `runId`'s agents. A turn during a later run (a follow-up or a revive) counts there: its spend
 * and reads belong to that run, and the change and verdict fields start over. Already there: a no-op.
 */
export function noteAgentRun(id: string, runId: string): void {
	const e = agents.get(id);
	if (!e || e.runId === runId) return;
	delete e.changes;
	delete e.lastChangeAt;
	delete e.lastVerdict;
	e.runId = runId;
}

export function noteAgentStart(input: {
	id: string;
	name: string;
	parentId?: string;
	role?: string;
	runId?: string;
	now: number;
}): void {
	const e = agents.get(input.id);
	if (e) {
		e.state = "running";
		e.lastActivityAt = input.now;
		if (input.parentId !== undefined) e.parentId = input.parentId;
		if (input.role !== undefined) e.role = input.role;
		if (input.runId !== undefined) noteAgentRun(input.id, input.runId);
		return;
	}
	prune(input.now);
	const entry: AgentEntry = {
		id: input.id,
		name: input.name,
		state: "running",
		startedAt: input.now,
		lastActivityAt: input.now,
		contextTokens: 0,
		requests: 0,
		costUsd: 0,
		followUps: 0,
	};
	if (input.parentId !== undefined) entry.parentId = input.parentId;
	if (input.role !== undefined) entry.role = input.role;
	if (input.runId !== undefined) entry.runId = input.runId;
	agents.set(input.id, entry);
}

export function noteAgentUsage(input: { id: string; model: string; promptTokens: number; costUsd: number; now: number }): void {
	const e = agents.get(input.id);
	if (!e) return;
	e.model = input.model;
	e.contextTokens = input.promptTokens;
	e.requests++;
	e.costUsd += input.costUsd;
	e.lastActivityAt = input.now;
}

/** A `write agent://<id>` the director sent was delivered: one more follow-up for that agent. */
export function noteAgentFollowUp(id: string): void {
	const e = agents.get(id);
	if (e) e.followUps++;
}

export function noteAgentEnd(input: { id: string; now: number; settled: boolean }): void {
	const e = agents.get(input.id);
	if (!e) return;
	if (input.settled) e.state = "idle";
	e.lastActivityAt = input.now;
}

/** Fired from the child's `session_shutdown`: park, kill and teardown alike. `lastActivityAt` stays: it dates the cache. */
export function noteAgentParked(id: string): void {
	const e = agents.get(id);
	if (e) e.state = "parked";
}

/** Folds a `yield` call's args into the agent's review tally (one review per verdict) and keeps its latest verdict; input that is no review leaves it alone. */
export function noteAgentReview(id: string, input: unknown, now: number): void {
	const e = agents.get(id);
	if (!e) return;
	const review = tallyFromYield(e.review, input);
	if (review) e.review = review;
	const correct = verdictOf(input);
	if (correct !== undefined) e.lastVerdict = { at: now, correct };
}

/** One more successful file-changing tool result inside the agent; unknown ids are ignored. */
export function noteAgentChange(id: string, now: number): void {
	const e = agents.get(id);
	if (!e) return;
	e.changes = (e.changes ?? 0) + 1;
	e.lastChangeAt = now;
	e.lastActivityAt = now;
}

function descends(e: AgentEntry, ancestorId: string): boolean {
	const seen = new Set<string>();
	let parent = e.parentId;
	while (parent !== undefined && !seen.has(parent)) {
		if (parent === ancestorId) return true;
		seen.add(parent);
		parent = agents.get(parent)?.parentId;
	}
	return false;
}

/** Copies, oldest first. `ancestorId` keeps descendants at any depth. */
export function listAgents(filter?: { runId?: string; ancestorId?: string }): AgentEntry[] {
	const out: AgentEntry[] = [];
	for (const e of agents.values()) {
		if (filter?.runId !== undefined && e.runId !== filter.runId) continue;
		if (filter?.ancestorId !== undefined && !descends(e, filter.ancestorId)) continue;
		out.push({ ...e });
	}
	return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** The run-end janitor removed these agents' omp records; their ledger entries say so from now on. */
export function markAgentsCleaned(ids: readonly string[], now: number): void {
	for (const id of ids) {
		const e = agents.get(id);
		if (e) e.cleanedAt = now;
	}
}

/** Tests only. */
export function resetAgents(): void {
	agents.clear();
}
