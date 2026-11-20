import type { BudgetConfig } from "../types.ts";

/** Spend of the Storm run active for one project in this process. */
export interface LedgerRun {
	runId: string;
	repoId: string;
	configHash: string;
	budget?: BudgetConfig;
	costUsd: number;
	costByModel: Record<string, number>;
	warned: boolean;
	exceeded: boolean;
	/** Called once when spend first reaches budget.warnAtUsd and once when it first reaches budget.perRunUsd, by whichever session recorded the cost. */
	onThreshold?: (kind: "warn" | "limit", run: LedgerRun) => void;
}

// Module-level on purpose: subagent sessions in the same process reuse this module, so their costs land in the parent's run.
const runs = new Map<string, LedgerRun>();

export function startLedgerRun(init: {
	runId: string;
	repoId: string;
	configHash: string;
	budget?: BudgetConfig;
	onThreshold?: LedgerRun["onThreshold"];
}): LedgerRun {
	const current = runs.get(init.repoId);
	if (current) throw new Error(`Storm 실행이 이미 진행 중입니다(${current.runId}).`);
	const run: LedgerRun = {
		runId: init.runId,
		repoId: init.repoId,
		configHash: init.configHash,
		costUsd: 0,
		costByModel: {},
		warned: false,
		exceeded: false,
	};
	if (init.budget) run.budget = init.budget;
	if (init.onThreshold) run.onThreshold = init.onThreshold;
	runs.set(init.repoId, run);
	return run;
}

export function activeLedgerRun(repoId: string): LedgerRun | undefined {
	return runs.get(repoId);
}

export function endLedgerRun(runId: string): LedgerRun | undefined {
	for (const [repoId, run] of runs) {
		if (run.runId !== runId) continue;
		runs.delete(repoId);
		return run;
	}
	return undefined;
}

function notify(run: LedgerRun, kind: "warn" | "limit"): void {
	try {
		run.onThreshold?.(kind, run);
	} catch {
		// A failing listener must not lose the cost that was just recorded.
	}
}

export function recordCost(repoId: string, selector: string, usd: number): LedgerRun | undefined {
	const run = runs.get(repoId);
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
}
