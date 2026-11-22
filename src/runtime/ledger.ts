import type { BudgetConfig, RunPlan } from "../types.ts";

/** Spend and dispatch authority of one run, shared with its children inside this process. */
export interface LedgerRun {
	runId: string;
	repoId: string;
	/** The run's main work tree: subagent sessions of the run fingerprint it, whichever tree they work in. */
	root: string;
	/** The commit the run's start tree was read against; later reads of the run compare with it. */
	base?: string;
	budget?: BudgetConfig;
	costUsd: number;
	costByModel: Record<string, number>;
	warned: boolean;
	exceeded: boolean;
	/** A cancelling run keeps its ledger until owned work stops, but must not admit new spawns. */
	closing: boolean;
	/** The run plan in force; spawn decisions in any session of the process read it from here. */
	plan?: RunPlan;
	/** Called once when spend first reaches budget.warnAtUsd and once when it first reaches budget.perRunUsd, by whichever session recorded the cost. */
	onThreshold?: (kind: "warn" | "limit", run: LedgerRun) => void;
}

// Root lookup is for ownership checks. Cost and child events must use the actual run id, never just cwd.
const worktrees = new Map<string, LedgerRun>();
const runs = new Map<string, LedgerRun>();
// OMP agent ids are unique within an artifact tree, not within the entire process.
const children = new Map<string, string>();
const childKeysByRun = new Map<string, Set<string>>();

function childKey(id: string, parentId: string | undefined, artifactsDir: string | undefined): string {
	return `${artifactsDir ?? ""}\0${parentId ?? ""}\0${id}`;
}

export function startLedgerRun(init: {
	runId: string;
	repoId: string;
	root: string;
	base?: string;
	budget?: BudgetConfig;
	onThreshold?: LedgerRun["onThreshold"];
}): LedgerRun {
	const current = worktrees.get(init.root);
	if (current) throw new Error(`Storm 실행이 이미 진행 중입니다(${current.runId}).`);
	if (runs.has(init.runId)) throw new Error(`Storm 실행 ID가 중복됐습니다(${init.runId}).`);
	const run: LedgerRun = {
		runId: init.runId,
		repoId: init.repoId,
		root: init.root,
		costUsd: 0,
		costByModel: {},
		warned: false,
		exceeded: false,
		closing: false,
	};
	if (init.budget) run.budget = init.budget;
	if (init.base !== undefined) run.base = init.base;
	if (init.onThreshold) run.onThreshold = init.onThreshold;
	worktrees.set(run.root, run);
	runs.set(run.runId, run);
	return run;
}

export function activeLedgerRun(worktreeRoot: string): LedgerRun | undefined {
	return worktrees.get(worktreeRoot);
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
		worktrees.delete(run.root);
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

export function resetLedger(): void {
	runs.clear();
	worktrees.clear();
	children.clear();
	childKeysByRun.clear();
}
