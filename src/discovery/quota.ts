import type { Exec, QuotaState, QuotaStatus } from "../types.ts";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const LIMITED_FRACTION = 0.8;
const STATE_RANK: Record<QuotaState, number> = { available: 0, limited: 1, unknown: 2, exhausted: 3 };

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

type AccountQuota = Omit<QuotaStatus, "provider">;

/**
 * Provider-wide state comes from omp's account-wide windows (`scope.shared` without a subpool or model), or from every
 * limit that names no model when the provider marks none: the rule `omp usage` itself applies. An exhausted limit
 * outside that pool stops only its own models: the one `scope.modelId` names, or the model tier `scope.tier` names.
 */
function accountQuota(report: Rec): AccountQuota {
	// Only boolean flags are read from metadata; identity fields there are never touched.
	const meta = isRec(report.metadata) ? report.metadata : {};
	let exhausted = meta.limitReached === true || meta.allowed === false;
	const limits = (Array.isArray(report.limits) ? report.limits.filter(isRec) : []).map((limit) => {
		const scope = isRec(limit.scope) ? limit.scope : {};
		const amount = isRec(limit.amount) ? limit.amount : {};
		const used = num(amount.used);
		const cap = num(amount.limit);
		const model = typeof scope.modelId === "string" && scope.modelId ? scope.modelId : undefined;
		return {
			model,
			tier: typeof scope.tier === "string" && scope.tier ? scope.tier : undefined,
			accountWide: scope.shared === true && scope.sharedGroup === undefined && model === undefined,
			fraction: usedFraction(amount),
			exhausted: limit.status === "exhausted" || (used !== undefined && cap !== undefined && cap > 0 && used >= cap),
			reset: isRec(limit.window) ? num(limit.window.resetsAt) : undefined,
		};
	});
	const accountWide = limits.filter((limit) => limit.accountWide);
	const pool = accountWide.length > 0 ? accountWide : limits.filter((limit) => limit.model === undefined);
	let maxFraction: number | null = null;
	let resetsAt: number | null = null;
	for (const limit of pool) {
		if (limit.exhausted) exhausted = true;
		if (limit.fraction !== undefined) maxFraction = Math.max(maxFraction ?? 0, limit.fraction);
		const pressured = limit.exhausted || (limit.fraction !== undefined && limit.fraction >= LIMITED_FRACTION);
		if (pressured && limit.reset !== undefined) resetsAt = resetsAt === null ? limit.reset : Math.min(resetsAt, limit.reset);
	}
	let state: QuotaState;
	if (exhausted) state = "exhausted";
	else if (limits.length === 0) state = "unknown";
	else if (maxFraction !== null && maxFraction >= LIMITED_FRACTION) state = "limited";
	else state = "available";
	const quota: AccountQuota = { state, usedFraction: maxFraction === null ? null : Math.min(1, maxFraction), resetsAt };
	for (const limit of limits) {
		const name = limit.model ?? limit.tier;
		if (!limit.exhausted || name === undefined || pool.includes(limit)) continue;
		const scoped = limit.model === undefined ? (quota.exhaustedTiers ??= {}) : (quota.exhaustedModels ??= {});
		const key = name.toLowerCase();
		const prev = scoped[key];
		scoped[key] = limit.reset === undefined ? (prev ?? null) : prev == null ? limit.reset : Math.min(prev, limit.reset);
	}
	return quota;
}

/**
 * The exhausted limit that stops a model on this provider now: the provider-wide one, else one scoped to its id, else
 * one scoped to its lineage tier ("opus"). A scope tier is compared with the lineage tier only: plan names such as
 * "pro" or "max" also travel in that field and must not match a word of some model id. Undefined when the model can run.
 */
export function exhaustedLimit(
	quota: QuotaStatus | undefined,
	modelId: string,
	lineageTier: string,
): { resetsAt: number | null } | undefined {
	if (!quota) return undefined;
	if (quota.state === "exhausted") return { resetsAt: quota.resetsAt };
	const byModel = quota.exhaustedModels?.[modelId.toLowerCase()];
	if (byModel !== undefined) return { resetsAt: byModel };
	const byTier = quota.exhaustedTiers?.[lineageTier];
	return byTier === undefined ? undefined : { resetsAt: byTier };
}

/** Parses `omp usage --json`. With several accounts per provider, the account with the most headroom wins. */
export function parseUsageJson(text: string): QuotaStatus[] {
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
	return [...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([provider, q]) => ({ provider, ...q }));
}

export async function readQuota(exec: Exec, ompBin: string): Promise<QuotaStatus[]> {
	try {
		const result = await exec(ompBin, ["usage", "--json"], { timeout: 30_000 });
		if (result.code !== 0 || result.killed) return [];
		return parseUsageJson(result.stdout);
	} catch {
		return [];
	}
}
