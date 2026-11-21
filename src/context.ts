/**
 * Reads everything a recommendation needs once: catalog, quota, explicit settings and usage
 * (syncing omp's stats DB when it lags), then analyzes. Setup, the model check and the storm tool share it.
 */
import { join } from "node:path";
import { analyze } from "./analysis/analyze.ts";
import { collectModels, type ModelRegistryPort } from "./discovery/models.ts";
import { readQuota } from "./discovery/quota.ts";
import { readExplicitSettings } from "./discovery/settings.ts";
import { DAY_MS, readUsage, statsDbPath } from "./history/stats.ts";
import { createLineage, displayLabel } from "./lineage/key.ts";
import { fillInt, fillTps } from "./lineage/metrics.ts";
import { loadPriors } from "./lineage/priors.ts";
import { assignTiers } from "./lineage/price.ts";
import { recommend } from "./recommend/recommend.ts";
import { ROLES } from "./roles.ts";
import { stormDir } from "./state.ts";
import type { AnalysisContext, Exec, ModelInfo, UiPort, UsageSnapshot } from "./types.ts";

/** What reading usage needs. */
export interface StatsEnv {
	exec: Exec;
	ompBin: string;
	now: () => number;
	/** Stats DB to read; omp's own when absent. */
	statsDb?: string;
}

export interface ContextEnv extends StatsEnv {
	cwd: string;
	agentDir: string;
	registry: ModelRegistryPort;
}

const WINDOW_DAYS = 30;
/** A newest row older than this suggests the DB was not synced lately. */
const STALE_MS = 6 * 3_600_000;
/** One `omp stats --summary` serves the 30-day analysis for this long: an idle DB stays "old" however often it is synced. */
const STATS_REFRESH_MS = 10 * 60_000;
/** A failed sync is not repeated for this long, so a broken omp is not run on every read; after that the next read tries again. */
const STATS_FAILURE_MS = 30_000;
const STATS_REFRESH_TIMEOUT_MS = 120_000;
const CONTEXT_TTL_MS = 2 * 60_000;

/** This process's last `omp stats --summary` per DB path; `ok` is unset while it runs. */
const statsSyncs = new Map<string, { at: number; done: Promise<boolean>; ok?: boolean }>();
const contexts = new Map<string, { at: number; context: Promise<AnalysisContext> }>();

/**
 * Usage over the `windowDays` ending at `to`. omp syncs its stats DB only when `omp stats` runs, so when the newest
 * row is `stale` it is run first, unless this process's last sync still `covers` the read.
 */
async function syncedUsage(
	env: StatsEnv,
	window: { windowDays: number; to: number },
	need: { stale: (dataAsOf: number) => boolean; covers: (syncedAt: number) => boolean },
	ui?: UiPort,
): Promise<UsageSnapshot> {
	const dbPath = env.statsDb ?? statsDbPath();
	const read = () => readUsage({ dbPath, windowDays: window.windowDays, now: window.to });
	const usage = read();
	if (usage.status !== "ok" || usage.dataAsOf === null || !need.stale(usage.dataAsOf)) return usage;
	const now = env.now();
	const last = statsSyncs.get(dbPath);
	if (last?.ok === false) {
		if (now - last.at < STATS_FAILURE_MS) return usage;
	} else if (last && need.covers(last.at)) {
		if (last.ok) return usage;
		return (await last.done) ? read() : usage;
	}
	ui?.notify("사용 기록이 오래돼 omp stats로 갱신합니다…");
	const sync: { at: number; done: Promise<boolean>; ok?: boolean } = {
		at: now,
		done: env.exec(env.ompBin, ["stats", "--summary"], { timeout: STATS_REFRESH_TIMEOUT_MS }).then(
			result => result.code === 0,
			() => false,
		),
	};
	statsSyncs.set(dbPath, sync);
	sync.ok = await sync.done;
	if (sync.ok) return read();
	ui?.notify("사용 기록 갱신에 실패해 기존 기록으로 분석합니다.", "warning");
	return usage;
}

/**
 * Usage over [from, to], synced first when the DB ends before `to` (a trial that just ended would show no requests).
 * Only a sync that ran at or after `to` covers the window; an earlier one cannot hold its last requests.
 */
export function loadUsageBetween(env: StatsEnv, from: number, to: number): Promise<UsageSnapshot> {
	return syncedUsage(env, { windowDays: (to - from) / DAY_MS, to }, { stale: dataAsOf => dataAsOf < to, covers: syncedAt => syncedAt >= to });
}

async function buildContext(env: ContextEnv, ui: UiPort, now: number): Promise<AnalysisContext> {
	const { catalog, available } = collectModels(env.registry);
	const [quota, explicit, usage] = await Promise.all([
		readQuota(env.exec, env.ompBin),
		readExplicitSettings(env.exec, env.ompBin),
		syncedUsage(
			env,
			{ windowDays: WINDOW_DAYS, to: now },
			{ stale: dataAsOf => now - dataAsOf > STALE_MS, covers: syncedAt => now - syncedAt < STATS_REFRESH_MS },
			ui,
		),
	]);
	const { priors, warnings } = loadPriors({ userPath: join(stormDir(env.agentDir), "priors.yml"), now });
	const lineage = createLineage(catalog, priors);
	const tiers = assignTiers(catalog, lineage, priors);
	const variantOf = (model: ModelInfo) => lineage(model.provider, model.id, model.identity).variant;
	const analysis = analyze({ usage, catalog, lineage, now });
	return {
		now,
		catalog,
		available,
		explicit,
		usage,
		analysis,
		recommend: (priority, current) =>
			recommend({
				analysis,
				catalog,
				quota,
				usage,
				lineage,
				tiers,
				fillInt: (route, siblings, key) => fillInt(route, siblings, priors, key),
				fillTps: (route, measured, siblings) =>
					fillTps(route, measured, siblings, variantOf(route), new Map(siblings.map(s => [s.selector, variantOf(s)]))),
				label: displayLabel,
				priority,
				roles: ROLES,
				...(current ? { current } : {}),
			}),
		checkModel: selector => {
			const model = available.find(entry => entry.selector === selector.trim());
			if (!model) return { ok: false, reason: `${selector.trim()}: 지금 쓸 수 있는 모델이 아닙니다` };
			if (!model.supportsTools) return { ok: false, reason: `${model.selector}: 도구 호출을 지원하지 않습니다` };
			return { ok: true, label: model.name, efforts: model.efforts };
		},
		detection: (activeTools, extraWarnings = []) => {
			const counts = new Map<string, number>();
			for (const model of available) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
			return {
				providers: [...counts]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([provider, models]) => ({
						provider,
						models,
						quota: quota.find(entry => entry.provider === provider)?.state ?? "unknown",
					})),
				tools: { task: activeTools.includes("task"), eval: activeTools.includes("eval") },
				warnings: [...warnings, ...extraWarnings],
			};
		},
	};
}

/**
 * The analysis context for `env.cwd`; a context built less than CONTEXT_TTL_MS ago is reused (setup asks twice in a row).
 * Within that time it does not see a new provider login, a quota change or changed omp settings, so every `/storm`
 * command the user types starts with `invalidateAnalysis`: the flows inside one command and the model's tool calls
 * share a context, a command never starts on a stale one.
 */
export function prepareAnalysis(env: ContextEnv, ui: UiPort): Promise<AnalysisContext> {
	const now = env.now();
	const cached = contexts.get(env.cwd);
	if (cached && now - cached.at < CONTEXT_TTL_MS) return cached.context;
	const context = buildContext(env, ui, now);
	contexts.set(env.cwd, { at: now, context });
	context.catch(() => {
		if (contexts.get(env.cwd)?.context === context) contexts.delete(env.cwd);
	});
	return context;
}

/** Drops the cached context of `cwd`, or of every project when omitted, so the next `prepareAnalysis` reads again. */
export function invalidateAnalysis(cwd?: string): void {
	if (cwd === undefined) contexts.clear();
	else contexts.delete(cwd);
}
