/**
 * Trial candidate vs the role's primary model, measured from subagent-seat usage since the trial
 * started. Pure: the caller reads the usage snapshot for the trial window.
 */
import type { TrialComparison, TrialConfig, TrialSide, UsageRow, UsageSnapshot } from "../types.ts";

/** Request-weighted mean over rows that have the metric; null when none do. */
function weighted(rows: readonly UsageRow[], pick: (r: UsageRow) => number | null): number | null {
	let sum = 0;
	let weight = 0;
	for (const r of rows) {
		const v = pick(r);
		if (v === null || r.requests <= 0) continue;
		sum += v * r.requests;
		weight += r.requests;
	}
	return weight > 0 ? sum / weight : null;
}

function side(selector: string, usage: UsageSnapshot): TrialSide {
	// A selector can map to several rows (same wire id seen under several stats keys); merge them.
	const rows = usage.rows.filter((r) => r.seat === "subagent" && `${r.provider}/${r.model}` === selector);
	let requests = 0;
	let errors = 0;
	let unpriced = 0;
	let cost = 0;
	for (const r of rows) {
		requests += r.requests;
		errors += r.errors;
		unpriced += r.unpricedRequests;
		cost += r.costTotal;
	}
	return {
		selector,
		requests,
		errorRate: requests > 0 ? errors / requests : null,
		ompTps: weighted(rows, (r) => r.ompTps),
		decodeTps: weighted(rows, (r) => r.decodeTps),
		ttftP50: weighted(rows, (r) => r.ttftP50),
		// Same convention as the analysis: list-price cost over all requests, null when nothing was priced.
		costPerRequest: requests > unpriced ? cost / requests : null,
	};
}

export function compareTrial(trial: TrialConfig, primary: string, usage: UsageSnapshot): TrialComparison {
	return { candidate: side(trial.model, usage), current: side(primary, usage), dataAsOf: usage.dataAsOf };
}
