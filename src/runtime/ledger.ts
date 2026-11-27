import { withJosa } from "../josa.ts";
import type { BudgetConfig, RunPlan, RunSpendNote } from "../types.ts";

/** Spend and dispatch authority of one run, shared with its children inside this process. */
export interface LedgerRun {
	runId: string;
	/** The native main session id captured at admission; never re-read from ambient state. */
	sessionId: string;
	/** The profile's session store directory for that session; includes the profile and is the owner key. */
	sessionDir: string;
	repoId: string;
	/** The run's main work tree: subagent sessions of the run fingerprint it, whichever tree they work in. */
	root: string;
	/** The commit the run's start tree was read against; later reads of the run compare with it. */
	base?: string;
	budget?: BudgetConfig;
	/** The main session's artifacts directory: the session tree every agent of this run lives in. */
	artifactsDir?: string;
	/** When the run began (host clock, ms): an agent the host created earlier is never this run's. */
	startedAt: number;
	costUsd: number;
	costByModel: Record<string, number>;
	/** Part of `costUsd` that came from agents bound by the session tree and not by their parent chain (see `recordTreeCost`). */
	treeCostUsd: number;
	/** Part of `costUsd` read back from the session files for eval `completion()` and `judge()` calls. */
	evalCostUsd: number;
	/** Per session file: the eval cost already counted from it, so a second reading adds only the difference. */
	evalCostBySource: Record<string, number>;
	/** Sessions in which an eval cell used `completion()` or `judge()` and the cost was not yet read back. */
	evalUnread: Set<string>;
	warned: boolean;
	exceeded: boolean;
	/** A cancelling run keeps its ledger until owned work stops, but must not admit new spawns. */
	closing: boolean;
	/** The run plan in force; spawn decisions in any session of the process read it from here. */
	plan?: RunPlan;
	/** Called once when spend first reaches budget.warnAtUsd and once when it first reaches budget.perRunUsd, by whichever session recorded the cost. */
	onThreshold?: (kind: "warn" | "limit", run: LedgerRun) => void;
}

// The owner key is the profile's session directory, not a worktree or a bare native id: one profile/session owns one run.
const sessions = new Map<string, LedgerRun>();
const runs = new Map<string, LedgerRun>();
// OMP agent ids are unique within an artifact tree, not within the entire process.
const children = new Map<string, string>();
const childKeysByRun = new Map<string, Set<string>>();

function childKey(id: string, parentId: string | undefined, artifactsDir: string | undefined): string {
	return `${artifactsDir ?? ""}\0${parentId ?? ""}\0${id}`;
}

function requireIdentity(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
		throw new Error(`Storm 실행의 ${withJosa(field, "이/가")} 올바르지 않습니다.`);
	}
	return value;
}

export function startLedgerRun(init: {
	runId: string;
	sessionId: string;
	sessionDir: string;
	repoId: string;
	root: string;
	base?: string;
	artifactsDir?: string;
	startedAt?: number;
	budget?: BudgetConfig;
	onThreshold?: LedgerRun["onThreshold"];
}): LedgerRun {
	const sessionId = requireIdentity(init.sessionId, "세션 id");
	const sessionDir = requireIdentity(init.sessionDir, "세션 디렉터리");
	const current = sessions.get(sessionDir);
	if (current) throw new Error(`이 세션에서 Storm 실행이 이미 진행 중입니다(${current.runId}).`);
	if (runs.has(init.runId)) throw new Error(`Storm 실행 ID가 중복됐습니다(${init.runId}).`);
	const run: LedgerRun = {
		runId: init.runId,
		sessionId,
		sessionDir,
		repoId: init.repoId,
		root: init.root,
		startedAt: init.startedAt ?? Date.now(),
		costUsd: 0,
		costByModel: {},
		treeCostUsd: 0,
		evalCostUsd: 0,
		evalCostBySource: {},
		evalUnread: new Set(),
		warned: false,
		exceeded: false,
		closing: false,
	};
	if (init.budget) run.budget = init.budget;
	if (init.base !== undefined) run.base = init.base;
	if (init.artifactsDir !== undefined && init.artifactsDir !== "") run.artifactsDir = init.artifactsDir;
	if (init.onThreshold) run.onThreshold = init.onThreshold;
	sessions.set(run.sessionDir, run);
	runs.set(run.runId, run);
	return run;
}

/**
 * A run as a child on another host thread knows it: named by the child's persisted admission, in no map. It carries what the
 * child's own hooks read (ids, work tree, session store), never the director's spend or plan: nothing a hook writes into it is
 * seen by any other thread, which is why such a child reports through `writeChildReport` instead.
 */
export function detachedLedgerRun(init: { runId: string; sessionId: string; sessionDir: string; repoId: string; root: string; artifactsDir?: string; startedAt: number }): LedgerRun {
	return {
		runId: init.runId,
		sessionId: init.sessionId,
		sessionDir: init.sessionDir,
		repoId: init.repoId,
		root: init.root,
		startedAt: init.startedAt,
		...(init.artifactsDir === undefined ? {} : { artifactsDir: init.artifactsDir }),
		costUsd: 0,
		costByModel: {},
		treeCostUsd: 0,
		evalCostUsd: 0,
		evalCostBySource: {},
		evalUnread: new Set(),
		warned: false,
		exceeded: false,
		closing: false,
	};
}

/** The run owned by this profile/session directory; a different session in the same worktree is a different run. */
export function activeLedgerRun(sessionDir: string): LedgerRun | undefined {
	return sessions.get(sessionDir);
}

/** Whether this exact session directory owns a live run; the admission authority, never a process-wide flag. */
export function hasLedgerRun(sessionDir: string): boolean {
	return sessions.has(sessionDir);
}

export function getLedgerRun(runId: string | undefined): LedgerRun | undefined {
	return runId === undefined ? undefined : runs.get(runId);
}

/** Records the host id only after this run's spawn was admitted, not by guessing from the child's cwd. */
export function bindLedgerChild(runId: string, id: string, parentId: string, artifactsDir?: string): boolean {
	const run = getLedgerRun(runId);
	if (!run || run.closing) return false;
	const key = childKey(id, parentId, artifactsDir);
	const owner = children.get(key);
	if (owner !== undefined && owner !== runId) return false;
	children.set(key, runId);
	let keys = childKeysByRun.get(runId);
	if (!keys) childKeysByRun.set(runId, (keys = new Set()));
	keys.add(key);
	return true;
}

export function ledgerRunForChild(id: string, parentId: string | undefined, artifactsDir?: string): LedgerRun | undefined {
	return getLedgerRun(children.get(childKey(id, parentId, artifactsDir)));
}

/**
 * The run that admitted a child id, whichever artifact root that thread reported. Child ids are unique only inside
 * one artifact tree, so a known parent narrows the match; no match, or more than one run, is no binding.
 */
export function ledgerRunForChildId(id: string, parentId?: string): LedgerRun | undefined {
	let found: LedgerRun | undefined;
	for (const [key, runId] of children) {
		const [, boundParent, boundId] = key.split("\0");
		if (boundId !== id || (parentId !== undefined && boundParent !== parentId)) continue;
		const run = runs.get(runId);
		if (run === undefined) continue;
		if (found !== undefined && found !== run) return undefined;
		found = run;
	}
	return found;
}

/** The host facts `ledgerRunForLineage` walks the parent chain with; the ledger itself keeps no registry. */
export interface LineageHost {
	/** The agent's parent id as the host registry has it. */
	parentOf(id: string): string | undefined;
	/** Whether this id is a main (director) session. */
	isMain(id: string): boolean;
	/** When the host created this agent (ms); unknown is `undefined`. */
	createdAt(id: string): number | undefined;
}

/** The longest parent chain walked: a chain that never ends is not a lineage. */
const LINEAGE_MAX_HOPS = 16;

/**
 * The run an agent belongs to through its chain of parents. A child bound at spawn answers at once. Otherwise the chain
 * is walked up and the first ancestor bound to this run decides, then every agent on the way is bound to it so later
 * cost lookups are direct. A child of a child, or one an eval cell started, therefore counts toward the run that its
 * first bound ancestor belongs to.
 *
 * The walk reads a bound ancestor under the one key that bound it (artifact tree, its own parent, its id), never by id
 * alone: ids repeat across sessions. A chain that ends at a main session counts only when that run lives in the same
 * artifact tree and every agent on the chain was created after the run began, so an agent left from an earlier run, or
 * one of another session, is never counted. A chain that ends elsewhere binds nothing.
 */
export function ledgerRunForLineage(
	id: string,
	parentId: string | undefined,
	artifactsDir: string | undefined,
	host: LineageHost,
	mainRun: (mainId: string) => LedgerRun | undefined,
): LedgerRun | undefined {
	const direct = ledgerRunForChild(id, parentId, artifactsDir);
	if (direct !== undefined) return direct;
	const chain: { id: string; parentId: string }[] = [];
	let cursor = id;
	let parent = parentId;
	for (let hop = 0; hop < LINEAGE_MAX_HOPS && parent !== undefined; hop++) {
		chain.push({ id: cursor, parentId: parent });
		let known = ledgerRunForChild(parent, host.parentOf(parent), artifactsDir);
		if (known === undefined && host.isMain(parent)) {
			const run = mainRun(parent);
			const sameTree = run !== undefined && run.artifactsDir !== undefined && run.artifactsDir === artifactsDir && !run.closing;
			if (run !== undefined && sameTree && chain.every(link => (host.createdAt(link.id) ?? -1) >= run.startedAt)) known = run;
		}
		if (known !== undefined) {
			for (const link of chain) bindLedgerChild(known.runId, link.id, link.parentId, artifactsDir);
			return known;
		}
		cursor = parent;
		parent = host.parentOf(parent);
	}
	return undefined;
}

/** The live run whose session tree this directory is: where an agent that no parent chain reaches still ran. */
export function ledgerRunForTree(artifactsDir: string | undefined): LedgerRun | undefined {
	if (artifactsDir === undefined || artifactsDir === "") return undefined;
	for (const run of runs.values()) if (run.artifactsDir === artifactsDir && !run.closing) return run;
	return undefined;
}

/** Whether any Storm run is active in this process, whichever project it belongs to. */
export function anyLedgerRun(): boolean {
	return runs.size > 0;
}

/** Stores the plan on the active run with this id; false when no such run is active. */
export function setLedgerPlan(runId: string, plan: RunPlan): boolean {
	const run = runs.get(runId);
	if (!run || run.closing) return false;
	run.plan = plan;
	return true;
}

export function endLedgerRun(runId: string): LedgerRun | undefined {
	const run = runs.get(runId);
	if (run) {
		runs.delete(runId);
		if (sessions.get(run.sessionDir) === run) sessions.delete(run.sessionDir);
		const keys = childKeysByRun.get(runId);
		if (keys) for (const key of keys) children.delete(key);
		childKeysByRun.delete(runId);
	}
	return run;
}

function notify(run: LedgerRun, kind: "warn" | "limit"): void {
	try {
		run.onThreshold?.(kind, run);
	} catch {
		// A failing listener must not lose the cost that was just recorded.
	}
}

export function recordCost(runId: string, selector: string, usd: number): LedgerRun | undefined {
	const run = runs.get(runId);
	if (!run) return undefined;
	if (!Number.isFinite(usd) || usd < 0) return run;
	run.costUsd += usd;
	run.costByModel[selector] = (run.costByModel[selector] ?? 0) + usd;
	const budget = run.budget;
	if (!budget) return run;
	if (!run.warned && budget.warnAtUsd !== undefined && run.costUsd >= budget.warnAtUsd) {
		run.warned = true;
		notify(run, "warn");
	}
	if (!run.exceeded && run.costUsd >= budget.perRunUsd) {
		run.exceeded = true;
		notify(run, "limit");
	}
	return run;
}

/**
 * Spend of an agent that ran in the run's session tree with no chain of parents reaching the run. It counts toward the
 * run total and the budget like any other, and is kept apart so the record can say how much of the total it is.
 */
export function recordTreeCost(runId: string, selector: string, usd: number): LedgerRun | undefined {
	const run = recordCost(runId, selector, usd);
	if (run !== undefined && Number.isFinite(usd) && usd > 0) run.treeCostUsd += usd;
	return run;
}

/** Source label eval helper spend is filed under in `costByModel`'s sibling field; never a model name. */
export const EVAL_COST_SELECTOR = "eval/completion";

/**
 * A managed session (`sessionKey`) made, or may have made, a model call that reaches no hook (an eval helper, `find`'s judge,
 * a search, a repair, a compaction). Until `recordEvalCost` reads it back from the session file the run's total is a floor.
 */
export function noteEvalModelCalls(runId: string, sessionKey: string): void {
	const run = runs.get(runId);
	if (run !== undefined && sessionKey !== "") run.evalUnread.add(sessionKey);
}

/**
 * Sets the side model call cost read back from one session file (every purpose omp journals, not only eval's). Only the
 * growth since the last reading is added to the run, so reading the same file again never counts a call twice. A reading
 * that found less than before (a rewritten file) adds nothing and keeps the earlier figure. `lift`: the reading also
 * lifts the floor `noteEvalModelCalls` set for this file.
 */
export function recordEvalCost(runId: string, sessionKey: string, totalUsd: number, lift = true): LedgerRun | undefined {
	const run = runs.get(runId);
	if (!run) return undefined;
	if (lift) run.evalUnread.delete(sessionKey);
	if (!Number.isFinite(totalUsd) || totalUsd < 0) return run;
	const before = run.evalCostBySource[sessionKey] ?? 0;
	if (totalUsd <= before) return run;
	run.evalCostBySource[sessionKey] = totalUsd;
	run.evalCostUsd += totalUsd - before;
	return recordCost(runId, EVAL_COST_SELECTOR, totalUsd - before);
}

/** What the run's total leaves out or took from outside the plan; undefined when there is nothing to say. */
export function spendNote(run: LedgerRun | undefined): RunSpendNote | undefined {
	if (run === undefined) return undefined;
	const note: RunSpendNote = {};
	if (run.evalUnread.size > 0) {
		note.lowerBound = true;
		note.evalUnread = run.evalUnread.size;
	}
	if (run.evalCostUsd > 0) note.evalUsd = run.evalCostUsd;
	if (run.treeCostUsd > 0) note.treeUsd = run.treeCostUsd;
	return Object.keys(note).length === 0 ? undefined : note;
}

export function resetLedger(): void {
	runs.clear();
	sessions.clear();
	children.clear();
	childKeysByRun.clear();
}
