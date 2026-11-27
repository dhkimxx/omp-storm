/**
 * Agent ledger: every subagent session of this process as Storm saw it from inside the child. Module-level on purpose:
 * subagent sessions on this thread load the same module, so their events land in the one map the parent reads. omp may
 * home a concurrent child on a worker thread whose module state is separate, so `listAgents` also mirrors children the
 * process-global agent registry reports into this ledger (real session usage only, never a bare launch).
 *
 * A native session id alone is not an owner: two profiles can share one id, and omp agent ids are unique only inside
 * one artifact tree. Every entry is therefore qualified by the attested owner session directory. Writes without a
 * valid scope are refused without mutation; there is no global or cwd fallback. `listAgents()` with no scope is the
 * intentionally global janitor inventory and must never authorize an action; session views pass `scope`.
 */
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent";
import { ROLE_AGENT_PREFIX } from "../roles.ts";
import type { AgentEntry } from "../types.ts";
import { anyLedgerRun, ledgerRunForChildId } from "./ledger.ts";
import { reviewPart, tallyFromYield, type ReviewEvidenceEntry } from "./review.ts";
import { sharedMap } from "./thread-state.ts";

/** Parked entries older than this are dropped when a new agent is added. */
const PARKED_KEEP_MS = 24 * 3_600_000;

/** Reviews kept per agent. A run is bounded by its rounds; the cap only keeps a pathological reviewer finite. */
const REVIEW_LOG_MAX = 64;

interface AgentRecord {
	entry: AgentEntry;
	/** Attested owner session directory. Always present: no unowned entries exist. */
	scope: string;
}

const agents = sharedMap<string, AgentRecord>("storm.agents.byKey");
/** Entries this thread created from the host registry because no child-session event reached it. */
const registryEntries = sharedMap<string, true>("storm.agents.registryEntries");

function validScope(scope: unknown): scope is string {
	return typeof scope === "string" && scope.length > 0 && !scope.includes("\u0000");
}

function agentKey(id: string, scope: string): string {
	return `${scope}\u0000${id}`;
}

function recordOf(id: string, scope: string): AgentRecord | undefined {
	return agents.get(agentKey(id, scope));
}

function prune(now: number): void {
	for (const [key, record] of agents) {
		if (record.entry.state === "parked" && now - record.entry.lastActivityAt > PARKED_KEEP_MS) {
			agents.delete(key);
			registryEntries.delete(key);
		}
	}
}

/**
 * Makes an entry one of `runId`'s agents. A turn during a later run (a follow-up or a revive) counts there: its spend
 * and reads belong to that run, and the change, verdict and review evidence start over. Already there: a no-op.
 */
export function noteAgentRun(id: string, runId: string, scope: string): void {
	if (!validScope(scope)) return;
	const record = recordOf(id, scope);
	if (!record || record.entry.runId === runId) return;
	const e = record.entry;
	registryEntries.delete(agentKey(id, scope));
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
	scope: string;
	now: number;
}): void {
	if (!validScope(input.scope)) return;
	const key = agentKey(input.id, input.scope);
	const existing = agents.get(key);
	if (existing) {
		const e = existing.entry;
		registryEntries.delete(key);
		e.state = "running";
		e.lastActivityAt = input.now;
		if (input.parentId !== undefined) e.parentId = input.parentId;
		if (input.role !== undefined) e.role = input.role;
		if (input.runId !== undefined) noteAgentRun(input.id, input.runId, input.scope);
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
	agents.set(key, { entry, scope: input.scope });
}

export function noteAgentUsage(input: {
	id: string;
	model: string;
	promptTokens: number;
	costUsd: number;
	scope: string;
	now: number;
}): void {
	if (!validScope(input.scope)) return;
	const key = agentKey(input.id, input.scope);
	const record = agents.get(key);
	if (!record) return;
	registryEntries.delete(key);
	const e = record.entry;
	e.model = input.model;
	e.contextTokens = input.promptTokens;
	e.requests++;
	e.costUsd += input.costUsd;
	e.lastActivityAt = input.now;
}

/** A `write agent://<id>` the director sent was delivered: one more follow-up for that agent. */
export function noteAgentFollowUp(id: string, scope: string): void {
	if (!validScope(scope)) return;
	const record = recordOf(id, scope);
	if (record) record.entry.followUps++;
}

export function noteAgentEnd(input: {
	id: string;
	scope: string;
	now: number;
	settled: boolean;
	failed?: boolean | undefined;
}): void {
	if (!validScope(input.scope)) return;
	const key = agentKey(input.id, input.scope);
	const record = agents.get(key);
	if (!record) return;
	registryEntries.delete(key);
	const e = record.entry;
	if (input.settled) {
		e.state = "idle";
		if (input.failed === true) e.lastWorkFailed = true;
		else delete e.lastWorkFailed;
	}
	e.lastActivityAt = input.now;
}

/** Fired from the child's `session_shutdown`: park, kill and teardown alike. `lastActivityAt` stays: it dates the cache. */
export function noteAgentParked(id: string, scope: string): void {
	if (!validScope(scope)) return;
	const key = agentKey(id, scope);
	const record = agents.get(key);
	if (record) {
		registryEntries.delete(key);
		record.entry.state = "parked";
	}
}

/**
 * Folds a `yield` call's args into the agent's review tally (one review per verdict) and keeps its latest verdict and
 * structured review evidence; input that is no review leaves it alone.
 */
export function noteAgentReview(id: string, input: unknown, now: number, scope: string): void {
	if (!validScope(scope)) return;
	const key = agentKey(id, scope);
	const record = agents.get(key);
	if (!record) return;
	registryEntries.delete(key);
	const e = record.entry;
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
		const carried = log.filter(candidate => candidate.correct === undefined).flatMap(candidate => candidate.findings);
		const kept = log.filter(candidate => candidate.correct !== undefined);
		// Scoped result verdicts stay on this verdict's record only; a later plain verdict never inherits them.
		kept.push({
			at: now,
			correct: part.correct,
			findings: [...carried, ...part.findings],
			...(part.results === undefined ? {} : { results: part.results.map(result => ({ ...result })) }),
		});
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
export function noteVerdictTree(id: string, at: number, tree: string, scope: string): void {
	if (!validScope(scope)) return;
	const key = agentKey(id, scope);
	const record = agents.get(key);
	if (!record || record.entry.lastVerdict?.at !== at) return;
	registryEntries.delete(key);
	const e = record.entry;
	const verdict = e.lastVerdict;
	if (verdict === undefined) return;
	verdict.tree = tree;
	const log = (e as ReviewEvidenceEntry).reviewLog?.findLast(entry => entry.correct !== undefined && entry.at === at);
	if (log) log.tree = tree;
}

/** One more successful file-changing tool result inside the agent; unknown ids are ignored. */
export function noteAgentChange(id: string, now: number, scope: string): void {
	if (!validScope(scope)) return;
	const key = agentKey(id, scope);
	const record = agents.get(key);
	if (!record) return;
	registryEntries.delete(key);
	const e = record.entry;
	e.changes = (e.changes ?? 0) + 1;
	e.lastChangeAt = now;
	e.lastActivityAt = now;
}

/** One child as the host's process-global registry reports it from another thread. */
export interface RegistryAgentFacts {
	id: string;
	runId: string;
	/** Attested owner session directory of the run that admitted this child. */
	scope: string;
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
	if (!validScope(facts.scope)) return;
	const key = agentKey(facts.id, facts.scope);
	const existingRecord = agents.get(key);
	if (existingRecord !== undefined && !registryEntries.has(key)) return;
	const requests = Number.isFinite(facts.requests) ? Math.max(0, Math.trunc(facts.requests)) : 0;
	const costUsd = Number.isFinite(facts.costUsd) ? Math.max(0, facts.costUsd) : 0;
	const state = REGISTRY_STATE[facts.status];
	const role = facts.name.startsWith(ROLE_AGENT_PREFIX) ? facts.name.slice(ROLE_AGENT_PREFIX.length) : undefined;
	if (existingRecord === undefined) {
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
		agents.set(key, { entry, scope: facts.scope });
		registryEntries.set(key, true);
		return;
	}
	const e = existingRecord.entry;
	// A synthetic entry has no run-scoped evidence to carry into another run; only its usage is cumulative.
	if (e.runId !== facts.runId) {
		e.runId = facts.runId;
		e.startedAt = facts.startedAt;
		delete e.lastWorkFailed;
	}
	e.name = facts.name;
	e.state = state;
	e.lastActivityAt = facts.lastActivityAt;
	e.requests = Math.max(e.requests, requests);
	e.costUsd = Math.max(e.costUsd, costUsd);
	if (facts.contextTokens !== undefined) e.contextTokens = facts.contextTokens;
	if (facts.model !== undefined) e.model = facts.model;
	if (facts.parentId !== undefined) e.parentId = facts.parentId;
	if (role !== undefined) e.role = role;
	if (facts.status === "aborted" || facts.lastWorkFailed === true) e.lastWorkFailed = true;
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
		const key = agentKey(ref.id, run.sessionDir);
		const existing = agents.get(key);
		// A child on this thread already reported itself: its events are richer and authoritative.
		if (existing !== undefined && !registryEntries.has(key)) continue;
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
			scope: run.sessionDir,
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

function descends(record: AgentRecord, ancestorId: string): boolean {
	const seen = new Set<string>();
	let parent = record.entry.parentId;
	while (parent !== undefined && !seen.has(parent)) {
		if (parent === ancestorId) return true;
		seen.add(parent);
		parent = recordOf(parent, record.scope)?.entry.parentId;
	}
	return false;
}

/**
 * The ids of every agent the process-global registry lists, whatever session or run started it. Not the ledger: a
 * session never started the agents it cannot see here, and this answers only "is some agent called X" (omp resolves
 * `history://current` to that agent instead of the caller's own branch when one is). Unreadable registry: undefined.
 */
export function registryAgentIds(): string[] | undefined {
	try {
		return AgentRegistry.global()
			.list()
			.map(ref => ref.id);
	} catch {
		return undefined;
	}
}

/**
 * Copies, oldest first. `ancestorId` follows parent links only inside the entry's own attested scope. Without `scope`
 * this is the intentionally global janitor inventory; it must not authorize an action.
 */
export function listAgents(filter?: { runId?: string; ancestorId?: string; scope?: string }): AgentEntry[] {
	syncRegistryAgents();
	const out: AgentEntry[] = [];
	for (const record of agents.values()) {
		const e = record.entry;
		if (filter?.scope !== undefined && record.scope !== filter.scope) continue;
		if (filter?.runId !== undefined && e.runId !== filter.runId) continue;
		if (filter?.ancestorId !== undefined && !descends(record, filter.ancestorId)) continue;
		out.push({ ...e });
	}
	return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** The run-end janitor removed these agents' omp records; their ledger entries say so from now on. */
export function markAgentsCleaned(ids: readonly string[], now: number, scope: string): void {
	if (!validScope(scope)) return;
	for (const id of ids) {
		const record = recordOf(id, scope);
		if (record) record.entry.cleanedAt = now;
	}
}

/** Tests only. */
export function resetAgents(): void {
	agents.clear();
	registryEntries.clear();
}
