/**
 * Reads everything a recommendation needs once: catalog, quota, explicit settings and usage
 * (refreshing omp's stats DB when it lags), then analyzes. Setup and the storm tool share it.
 */
import { join } from "node:path";
import { analyze } from "./analysis/analyze.ts";
import { collectModels } from "./discovery/models.ts";
import { readQuota } from "./discovery/quota.ts";
import { readExplicitSettings } from "./discovery/settings.ts";
import { archiveDays, readUsageWithArchive } from "./history/archive.ts";
import { statsDbPath } from "./history/stats.ts";
import { createLineage, displayLabel } from "./lineage/key.ts";
import { fillInt, fillTps } from "./lineage/metrics.ts";
import { loadPriors } from "./lineage/priors.ts";
import { assignTiers } from "./lineage/price.ts";
import { recommend } from "./recommend/recommend.ts";
import { ROLES } from "./roles.ts";
import { stormDir } from "./state.ts";
import type {
	AnalysisContext,
	DetectionSummary,
	Exec,
	ExplicitSettings,
	ModelInfo,
	QuotaStatus,
	UiPort,
	UsageSnapshot,
} from "./types.ts";

export interface ContextEnv {
	agentDir: string;
	exec: Exec;
	ompBin: string;
	registry: { getAll(kind?: string): unknown[]; getAvailable(kind?: string): unknown[] };
	now: () => number;
}

export const WINDOW_DAYS = 30;
export const STALE_MS = 6 * 3_600_000;
const STATS_REFRESH_TIMEOUT_MS = 120_000;

/** Usage over the window; refreshes omp's stats DB first when it lags (it only syncs when `omp stats` runs). */
export async function loadUsage(env: ContextEnv, ui: UiPort): Promise<UsageSnapshot> {
	const dbPath = statsDbPath();
	const dir = join(stormDir(env.agentDir), "usage");
	const read = () => readUsageWithArchive({ dbPath, dir, windowDays: WINDOW_DAYS, now: env.now() });
	let usage = read();
	if (usage.status === "ok" && usage.dataAsOf !== null && env.now() - usage.dataAsOf > STALE_MS) {
		ui.notify("사용 기록이 오래돼 omp stats로 갱신합니다…");
		const result = await env.exec(env.ompBin, ["stats", "--summary"], { timeout: STATS_REFRESH_TIMEOUT_MS });
		if (result.code === 0) usage = read();
		else ui.notify("사용 기록 갱신에 실패해 기존 기록으로 분석합니다.", "warning");
	}
	if (usage.status === "ok") archiveDays({ dbPath, dir, now: env.now() });
	return usage;
}

function detectionSummary(input: {
	available: ModelInfo[];
	quota: QuotaStatus[];
	activeTools: string[];
	explicit: ExplicitSettings;
	usage: UsageSnapshot;
	now: number;
	warnings: string[];
}): DetectionSummary {
	const counts = new Map<string, number>();
	for (const model of input.available) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	const task = input.activeTools.includes("task");
	const evalTool = input.activeTools.includes("eval");
	// omp enables both keywords by default; unreadable settings keep that default.
	const keywords = input.explicit.magicKeywords ?? { enabled: true, workflowz: true, orchestrate: true };
	const stale = input.usage.dataAsOf !== null && input.now - input.usage.dataAsOf > STALE_MS;
	return {
		providers: [...counts]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, models]) => ({
				provider,
				models,
				quota: input.quota.find(entry => entry.provider === provider)?.state ?? "unknown",
			})),
		tools: { task, eval: evalTool },
		keywords: {
			workflowz: task && evalTool && keywords.enabled && keywords.workflowz,
			orchestrate: task && keywords.enabled && keywords.orchestrate,
		},
		explicit: input.explicit,
		dataAsOf: input.usage.dataAsOf,
		stale,
		warnings: input.warnings,
	};
}

export async function prepareAnalysis(env: ContextEnv, ui: UiPort): Promise<AnalysisContext> {
	const now = env.now();
	const { catalog, available } = collectModels(env.registry);
	const [quota, explicit, usage] = await Promise.all([
		readQuota(env.exec, env.ompBin, now),
		readExplicitSettings(env.exec, env.ompBin),
		loadUsage(env, ui),
	]);
	const { priors, warnings } = loadPriors({ userPath: join(stormDir(env.agentDir), "priors.yml"), now });
	const lineage = createLineage(catalog, priors);
	const tiers = assignTiers(catalog, lineage, priors);
	const variantOf = (model: ModelInfo) => lineage(model.provider, model.id, model.identity).variant;
	const deps = {
		lineage,
		tiers,
		fillInt: (route: ModelInfo, siblings: ModelInfo[], key: string) => fillInt(route, siblings, priors, key),
		fillTps: (
			route: ModelInfo,
			measured: { decodeTps: number | null; samples: number } | undefined,
			siblings: ModelInfo[],
		) => fillTps(route, measured, siblings, variantOf(route), new Map(siblings.map(s => [s.selector, variantOf(s)]))),
		label: displayLabel,
	};
	const analysis = analyze({ usage, catalog, ...deps, now });
	return {
		now,
		catalog,
		available,
		quota,
		explicit,
		usage,
		analysis,
		lineage,
		tiers,
		warnings,
		recommend: priority => recommend({ analysis, catalog, quota, usage, ...deps, priority, roles: ROLES }),
		checkModel: selector => {
			const model = available.find(entry => entry.selector === selector.trim());
			if (!model) return { ok: false, reason: `${selector.trim()}: 지금 쓸 수 있는 모델이 아닙니다` };
			if (!model.supportsTools) return { ok: false, reason: `${model.selector}: 도구 호출을 지원하지 않습니다` };
			return { ok: true, label: model.name, efforts: model.efforts };
		},
		detection: (activeTools, extraWarnings = []) =>
			detectionSummary({ available, quota, activeTools, explicit, usage, now, warnings: [...warnings, ...extraWarnings] }),
	};
}
