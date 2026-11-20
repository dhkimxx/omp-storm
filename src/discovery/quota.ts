import type { Exec, QuotaState, QuotaStatus } from "../types.ts";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const LIMITED_FRACTION = 0.8;
const STATE_RANK: Record<QuotaState, number> = { available: 0, limited: 1, unknown: 2, unavailable: 3, exhausted: 4 };

/** Same precedence as omp's `resolveUsedFraction` (pi-ai/src/usage.ts). */
function usedFraction(amount: Rec): number | undefined {
	const fraction = num(amount.usedFraction);
	if (fraction !== undefined) return fraction;
	const used = num(amount.used);
	const limit = num(amount.limit);
	if (used !== undefined && limit !== undefined && limit > 0) return used / limit;
	if (amount.unit === "percent" && used !== undefined) return used / 100;
	const remaining = num(amount.remainingFraction);
	if (remaining !== undefined) return Math.max(0, 1 - remaining);
	return undefined;
}

interface AccountQuota {
	state: QuotaState;
	usedFraction: number | null;
	resetsAt: number | null;
}

function accountQuota(report: Rec): AccountQuota {
	// Only boolean flags are read from metadata; identity fields there are never touched.
	const meta = isRec(report.metadata) ? report.metadata : {};
	let exhausted = meta.limitReached === true || meta.allowed === false;
	const limits = Array.isArray(report.limits) ? report.limits.filter(isRec) : [];
	let maxFraction: number | null = null;
	let resetsAt: number | null = null;
	for (const limit of limits) {
		const amount = isRec(limit.amount) ? limit.amount : {};
		const fraction = usedFraction(amount);
		const used = num(amount.used);
		const cap = num(amount.limit);
		const limitExhausted = limit.status === "exhausted" || (used !== undefined && cap !== undefined && cap > 0 && used >= cap);
		if (limitExhausted) exhausted = true;
		if (fraction !== undefined) maxFraction = Math.max(maxFraction ?? 0, fraction);
		const pressured = limitExhausted || (fraction !== undefined && fraction >= LIMITED_FRACTION);
		const reset = isRec(limit.window) ? num(limit.window.resetsAt) : undefined;
		if (pressured && reset !== undefined) resetsAt = resetsAt === null ? reset : Math.min(resetsAt, reset);
	}
	let state: QuotaState;
	if (exhausted) state = "exhausted";
	else if (limits.length === 0) state = "unknown";
	else if (maxFraction !== null && maxFraction >= LIMITED_FRACTION) state = "limited";
	else state = "available";
	return { state, usedFraction: maxFraction === null ? null : Math.min(1, maxFraction), resetsAt };
}

/** Parses `omp usage --json`. With several accounts per provider, the account with the most headroom wins. */
export function parseUsageJson(text: string, now: number): QuotaStatus[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!isRec(parsed)) return [];
	const best = new Map<string, AccountQuota>();
	const reports = Array.isArray(parsed.reports) ? parsed.reports.filter(isRec) : [];
	for (const report of reports) {
		if (typeof report.provider !== "string" || !report.provider) continue;
		const quota = accountQuota(report);
		const prev = best.get(report.provider);
		if (
			!prev ||
			STATE_RANK[quota.state] < STATE_RANK[prev.state] ||
			(quota.state === prev.state && (quota.usedFraction ?? 1) < (prev.usedFraction ?? 1))
		) {
			best.set(report.provider, quota);
		}
	}
	// Logged-in accounts whose provider has no usage endpoint: quota is unknown, not unlimited.
	const without = Array.isArray(parsed.accountsWithoutUsage) ? parsed.accountsWithoutUsage.filter(isRec) : [];
	for (const account of without) {
		if (typeof account.provider === "string" && account.provider && !best.has(account.provider)) {
			best.set(account.provider, { state: "unknown", usedFraction: null, resetsAt: null });
		}
	}
	return [...best.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([provider, q]) => ({ provider, state: q.state, usedFraction: q.usedFraction, resetsAt: q.resetsAt, observedAt: now }));
}

export async function readQuota(exec: Exec, ompBin: string, now: number = Date.now()): Promise<QuotaStatus[]> {
	try {
		const result = await exec(ompBin, ["usage", "--json"], { timeout: 30_000 });
		if (result.code !== 0 || result.killed) return [];
		return parseUsageJson(result.stdout, now);
	} catch {
		return [];
	}
}
