/**
 * Agent ledger: every subagent session of this process as Storm saw it from inside the child. Module-level on purpose:
 * subagent sessions on this thread load the same module, so their events land in the one map the parent reads. omp may
 * home a concurrent child on a worker thread whose module state is separate, so `listAgents` also mirrors children the
 * process-global agent registry reports into this ledger (real session usage only, never a bare launch).
 */
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent";
import { ROLE_AGENT_PREFIX } from "../roles.ts";
import type { AgentEntry } from "../types.ts";
import { anyLedgerRun, ledgerRunForChildId } from "./ledger.ts";
import { reviewPart, tallyFromYield, type ReviewEvidenceEntry } from "./review.ts";

/** Parked entries older than this are dropped when a new agent is added. */
const PARKED_KEEP_MS = 24 * 3_600_000;

/** Reviews kept per agent. A run is bounded by its rounds; the cap only keeps a pathological reviewer finite. */
const REVIEW_LOG_MAX = 64;

const agents = new Map<string, AgentEntry>();
/** Entries this thread created from the host registry because no child-session event reached it. */
const registryEntries = new Set<string>();

function prune(now: number): void {
	for (const [id, e] of agents) {
		if (e.state === "parked" && now - e.lastActivityAt > PARKED_KEEP_MS) {
			agents.delete(id);
			registryEntries.delete(id);
		}
	}
}

/**
 * Makes an entry one of `runId`'s agents. A turn during a later run (a follow-up or a revive) counts there: its spend
 * and reads belong to that run, and the change, verdict and review evidence start over. Already there: a no-op.
 */
export function noteAgentRun(id: string, runId: string): void {
	const e = agents.get(id);
	if (!e || e.runId === runId) return;
	registryEntries.delete(id);
	delete e.changes;
	delete e.lastChangeAt;
	delete e.lastVerdict;
	delete e.lastWorkFailed;
	// A review belongs to the run it was given in: its tally and structured evidence are proof for that run only.
	delete e.review;
	delete (e as ReviewEvidenceEntry).reviewLog;
	delete (e as ReviewEvidenceEntry).reviewLogOverflow;
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
		registryEntries.delete(input.id);
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
	registryEntries.delete(input.id);
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

export function noteAgentEnd(input: { id: string; now: number; settled: boolean; failed?: boolean | undefined }): void {
	const e = agents.get(input.id);
	if (!e) return;
	registryEntries.delete(input.id);
	if (input.settled) {
		e.state = "idle";
		if (input.failed === true) e.lastWorkFailed = true;
		else delete e.lastWorkFailed;
	}
	e.lastActivityAt = input.now;
}

/** Fired from the child's `session_shutdown`: park, kill and teardown alike. `lastActivityAt` stays: it dates the cache. */
export function noteAgentParked(id: string): void {
	const e = agents.get(id);
	if (e) {
		registryEntries.delete(id);
		e.state = "parked";
	}
}

/**
 * Folds a `yield` call's args into the agent's review tally (one review per verdict) and keeps its latest verdict and
 * structured review evidence; input that is no review leaves it alone.
 */
export function noteAgentReview(id: string, input: unknown, now: number): void {
	const e = agents.get(id);
	if (!e) return;
	registryEntries.delete(id);
	const review = tallyFromYield(e.review, input);
	if (review) e.review = review;
	const part = reviewPart(input);
	if (!part) return;
	const entry = e as ReviewEvidenceEntry;
	const log = entry.reviewLog ?? [];
	if (part.kind === "findings") {
		// Provisional until a verdict: an unfinished review's P0 must still be able to block a pass. Consecutive
		// findings belong to the same cycle, so keep one record and its first time.
		const provisional = log.at(-1);
		if (provisional && provisional.correct === undefined) provisional.findings.push(...part.findings);
		else log.push({ at: now, findings: part.findings });
	} else {
		// Findings yielded before this verdict are this review's; the verdict's tree then binds them.
		const carried = log.filter(record => record.correct === undefined).flatMap(record => record.findings);
		const kept = log.filter(record => record.correct !== undefined);
		kept.push({ at: now, correct: part.correct, findings: [...carried, ...part.findings] });
		log.length = 0;
		log.push(...kept);
		e.lastVerdict = { at: now, correct: part.correct };
	}
	while (log.length > REVIEW_LOG_MAX) {
		const dropped = log.shift();
		// A dropped P0 is evidence the proof can no longer rule out: fail closed instead of forgetting it.
		if (dropped?.findings.some(finding => finding.priority === 0)) entry.reviewLogOverflow = true;
	}
	entry.reviewLog = log;
}

/** Ties the tree a verdict was given against to that verdict; a later verdict keeps its own tree. */
export function noteVerdictTree(id: string, at: number, tree: string): void {
	const e = agents.get(id);
	if (!e || e.lastVerdict?.at !== at) return;
	registryEntries.delete(id);
	e.lastVerdict.tree = tree;
	const record = (e as ReviewEvidenceEntry).reviewLog?.findLast(entry => entry.correct !== undefined && entry.at === at);
	if (record) record.tree = tree;
}

/** One more successful file-changing tool result inside the agent; unknown ids are ignored. */
export function noteAgentChange(id: string, now: number): void {
	const e = agents.get(id);
	if (!e) return;
	registryEntries.delete(id);
	e.changes = (e.changes ?? 0) + 1;
	e.lastChangeAt = now;
	e.lastActivityAt = now;
}

/** One child as the host's process-global registry reports it from another thread. */
export interface RegistryAgentFacts {
	id: string;
	runId: string;
	name: string;
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	startedAt: number;
	lastActivityAt: number;
	/** Assistant requests the child actually made; 0 is a launch, not work. */
	requests: number;
	costUsd: number;
	contextTokens?: number;
	model?: string;
	lastWorkFailed?: boolean;
}

const REGISTRY_STATE: Record<RegistryAgentFacts["status"], AgentEntry["state"]> = {
	running: "running",
	idle: "idle",
	parked: "parked",
	aborted: "parked",
};

/**
 * Mirrors one worker-homed child into this thread's ledger. Child-session events are authoritative whenever they
 * reached this thread; only entries first created here are updated from the registry. Usage comes from the host's
 * session counters, so a registered but never-requesting child stays at zero and cannot finish a lane.
 */
export function noteRegistryAgent(facts: RegistryAgentFacts): void {
	const existing = agents.get(facts.id);
	if (existing !== undefined && !registryEntries.has(facts.id)) return;
	const requests = Number.isFinite(facts.requests) ? Math.max(0, Math.trunc(facts.requests)) : 0;
	const costUsd = Number.isFinite(facts.costUsd) ? Math.max(0, facts.costUsd) : 0;
	const state = REGISTRY_STATE[facts.status];
	const role = facts.name.startsWith(ROLE_AGENT_PREFIX) ? facts.name.slice(ROLE_AGENT_PREFIX.length) : undefined;
	if (existing === undefined) {
		prune(facts.lastActivityAt);
		const entry: AgentEntry = {
			id: facts.id,
			name: facts.name,
			runId: facts.runId,
			state,
			startedAt: facts.startedAt,
			lastActivityAt: facts.lastActivityAt,
			contextTokens: facts.contextTokens ?? 0,
			requests,
			costUsd,
			followUps: 0,
		};
		if (facts.parentId !== undefined) entry.parentId = facts.parentId;
		if (role !== undefined) entry.role = role;
		if (facts.model !== undefined) entry.model = facts.model;
		if (facts.status === "aborted" || facts.lastWorkFailed === true) entry.lastWorkFailed = true;
		agents.set(facts.id, entry);
		registryEntries.add(facts.id);
		return;
	}
	// A synthetic entry has no run-scoped evidence to carry into another run; only its usage is cumulative.
	if (existing.runId !== facts.runId) {
		existing.runId = facts.runId;
		existing.startedAt = facts.startedAt;
		delete existing.lastWorkFailed;
	}
	existing.name = facts.name;
	existing.state = state;
	existing.lastActivityAt = facts.lastActivityAt;
	existing.requests = Math.max(existing.requests, requests);
	existing.costUsd = Math.max(existing.costUsd, costUsd);
	if (facts.contextTokens !== undefined) existing.contextTokens = facts.contextTokens;
	if (facts.model !== undefined) existing.model = facts.model;
	if (facts.parentId !== undefined) existing.parentId = facts.parentId;
	if (role !== undefined) existing.role = role;
	if (facts.status === "aborted" || facts.lastWorkFailed === true) existing.lastWorkFailed = true;
}

/**
 * Mirrors registry children that belong to a run this thread admitted. The registry is process-global and its worker
 * bridge exposes the live session's counters; a run with no own ledger here (a worker thread, no run) pays nothing.
 */
function syncRegistryAgents(): void {
	if (!anyLedgerRun()) return;
	let refs: AgentRef[];
	try {
		refs = AgentRegistry.global().list();
	} catch {
		return;
	}
	for (const ref of refs) {
		if (ref.kind !== "sub") continue;
		const run = ledgerRunForChildId(ref.id, ref.parentId);
		if (run === undefined) continue;
		const existing = agents.get(ref.id);
		// A child on this thread already reported itself: its events are richer and authoritative.
		if (existing !== undefined && !registryEntries.has(ref.id)) continue;
		let stats: { assistantMessages?: number; cost?: number; contextUsage?: { tokens?: number } } | undefined;
		try {
			stats = ref.session?.getSessionStats();
		} catch {
			stats = undefined;
		}
		const history = ref.history;
		const metrics = history?.metrics;
		const contextTokens = stats?.contextUsage?.tokens ?? metrics?.contextTokens;
		noteRegistryAgent({
			id: ref.id,
			runId: run.runId,
			name: history?.agent ?? ref.displayName,
			...(ref.parentId !== undefined ? { parentId: ref.parentId } : {}),
			status: ref.status,
			startedAt: ref.createdAt || Date.now(),
			lastActivityAt: ref.lastActivity || Date.now(),
			requests: stats?.assistantMessages ?? metrics?.requests ?? 0,
			costUsd: stats?.cost ?? metrics?.cost ?? history?.directCost ?? 0,
			...(contextTokens !== undefined ? { contextTokens } : {}),
			...(history?.resolvedModel !== undefined ? { model: history.resolvedModel } : {}),
			...(ref.status === "aborted" ? { lastWorkFailed: true } : {}),
		});
	}
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
	syncRegistryAgents();
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
	registryEntries.clear();
}
