/**
 * Trial candidate vs the role's primary model, measured from subagent-seat usage. Pure: the caller reads the
 * usage snapshot for the trial's own period.
 */
import type { TrialComparison, TrialConfig, TrialSide, UsageSnapshot } from "../types.ts";

function side(selector: string, usage: UsageSnapshot): TrialSide {
	const row = usage.rows.find((r) => r.seat === "subagent" && `${r.provider}/${r.model}` === selector);
	if (!row || row.requests <= 0) {
		return { selector, requests: 0, errorRate: null, ompTps: null, decodeTps: null, ttftP50: null, costPerRequest: null };
	}
	return {
		selector,
		requests: row.requests,
		errorRate: row.errors / row.requests,
		ompTps: row.ompTps,
		decodeTps: row.decodeTps,
		ttftP50: row.ttftP50,
		// List-price cost over all requests, null when nothing was priced.
		costPerRequest: row.requests > row.unpricedRequests ? row.costTotal / row.requests : null,
	};
}

export function compareTrial(trial: TrialConfig, primary: string, usage: UsageSnapshot): TrialComparison {
	return { candidate: side(trial.model, usage), current: side(primary, usage), dataAsOf: usage.dataAsOf };
}
