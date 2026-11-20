/**
 * /storm flows: setup (detect → analyze → recommend → interview → approve → save), status, review, rollback.
 * Nothing is written unless an interview step returned an explicit approval.
 */
import { join, relative } from "node:path";
import { analyze } from "./analysis/analyze.ts";
import { configHash, sha256Hex } from "./config/canonical.ts";
import { serializeConfig, writeConfig } from "./config/store.ts";
import { collectModels } from "./discovery/models.ts";
import { readQuota } from "./discovery/quota.ts";
import { readExplicitSettings } from "./discovery/settings.ts";
import { archiveDays, readUsageWithArchive } from "./history/archive.ts";
import { readUsage, statsDbPath } from "./history/stats.ts";
import { renderStatus } from "./interview/render.ts";
import { runReview, runRollback } from "./interview/review.ts";
import { deriveScope, runSetupInterview } from "./interview/setup.ts";
import { createLineage, displayLabel } from "./lineage/key.ts";
import { fillInt, fillTps } from "./lineage/metrics.ts";
import { loadPriors } from "./lineage/priors.ts";
import { assignTiers } from "./lineage/price.ts";
import { recommend } from "./recommend/recommend.ts";
import { ROLES } from "./roles.ts";
import { loadProjectState, type ProjectEnv, type ProjectState, stormDir } from "./state.ts";
import type {
	DetectionSummary,
	ExplicitSettings,
	InterviewInput,
	ModelInfo,
	Priority,
	QuotaStatus,
	RollbackOption,
	StormConfig,
	UiPort,
	UsageSnapshot,
} from "./types.ts";

export interface FlowEnv extends ProjectEnv {
	ompBin: string;
	ompVersion: string;
	/** omp host mode ("tui", "rpc", ...), recorded with approvals. */
	mode: string;
	registry: { getAll(kind?: string): unknown[]; getAvailable(kind?: string): unknown[] };
	activeTools: string[];
	now: () => number;
}

const WINDOW_DAYS = 30;
const STALE_MS = 6 * 3_600_000;
const STATS_REFRESH_TIMEOUT_MS = 120_000;
const DEFAULTS: InterviewInput["defaults"] = { parallelism: 4, isolation: "shared", contract: "workflowz" };

function shortHash(hash: string): string {
	return hash.replace(/^jcs-sha256:/, "").slice(0, 12);
}

/** Usage over the window; refreshes omp's stats DB first when it lags (it only syncs when `omp stats` runs). */
async function loadUsage(env: FlowEnv, ui: UiPort): Promise<UsageSnapshot> {
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

/** Writes the approval first, then the file, so the config never exists unapproved after a successful setup. */
async function approveAndSave(
	env: FlowEnv,
	state: ProjectState,
	config: StormConfig,
	scope: Parameters<ProjectState["store"]["approve"]>[0]["scope"],
): Promise<string> {
	const hash = configHash(config);
	await state.store.approve({
		configHash: hash,
		rawSha256: sha256Hex(serializeConfig(config)),
		config,
		scope,
		via: env.mode,
		ompVersion: env.ompVersion,
		supersedes: state.approval?.approvalId ?? null,
	});
	const written = await writeConfig(state.repo.root, config);
	if (written.hash !== hash) throw new Error(`저장한 설정의 해시가 승인한 해시와 다릅니다(${shortHash(written.hash)})`);
	return hash;
}

export async function setupFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
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
	const analysis = analyze({ usage, catalog, quota, ...deps, now });
	const current =
		state.config.status === "ok"
			? { config: state.config.config, hash: state.config.hash, approved: state.approval !== undefined }
			: undefined;
	const priority: Priority = current?.config.priority ?? "balanced";
	const rerecommend = (next: Priority) =>
		recommend({ analysis, catalog, quota, usage, ...deps, priority: next, roles: ROLES });
	const detectionWarnings = [...warnings];
	if (state.config.status === "invalid") detectionWarnings.push(`지금 설정 파일에 오류가 있어 새로 만듭니다: ${state.config.errors[0] ?? ""}`);
	const result = await runSetupInterview(ui, {
		detection: detectionSummary({ available, quota, activeTools: env.activeTools, explicit, usage, now, warnings: detectionWarnings }),
		analysis,
		recommendations: rerecommend(priority),
		...(current ? { current } : {}),
		shadows: state.shadows,
		rerecommend,
		checkModel: selector => {
			const model = available.find(entry => entry.selector === selector.trim());
			if (!model) return { ok: false, reason: `${selector.trim()}: 지금 쓸 수 있는 모델이 아닙니다` };
			if (!model.supportsTools) return { ok: false, reason: `${model.selector}: 도구 호출을 지원하지 않습니다` };
			return { ok: true, label: model.name, efforts: model.efforts };
		},
		defaults: current
			? { parallelism: current.config.parallelism, isolation: current.config.isolation, contract: current.config.contract }
			: DEFAULTS,
		priority,
	});
	if (result.status !== "approved") {
		ui.notify("저장하지 않았습니다. 바뀐 것은 없습니다.");
		return;
	}
	const hash = await approveAndSave(env, state, result.config, result.scope);
	ui.notify(`Storm 팀을 승인하고 저장했습니다(${shortHash(hash)}).`);
	await statusFlow(env, ui);
}

export async function statusFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const now = env.now();
	const quota = await readQuota(env.exec, env.ompBin, now);
	const usage = readUsage({ dbPath: statsDbPath(), windowDays: 1, now });
	ui.report(
		"Storm 현황",
		renderStatus(
			{ repo: state.repo, config: state.config, approval: state.approval, shadows: state.shadows, quota, dataAsOf: usage.dataAsOf },
			now,
		),
	);
}

function unapprovedShadows(state: ProjectState): boolean {
	const approved = state.approval?.scope.shadowedAgents ?? [];
	return state.shadows.some(shadow => !approved.some(seen => seen.agent === shadow.agent && seen.sha256 === shadow.sha256));
}

export async function reviewFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	if (state.config.status === "missing") {
		ui.notify("Storm 설정이 없습니다. /storm 으로 팀을 설정하세요.");
		return;
	}
	if (state.config.status === "invalid") {
		ui.report("Storm 설정 오류", state.config.errors.map(error => `- ${error}`).join("\n"));
		ui.notify("설정 파일을 고치거나 /storm setup 으로 다시 만드세요.", "warning");
		return;
	}
	if (state.approval && !unapprovedShadows(state)) {
		ui.notify("이미 승인된 설정입니다.");
		return;
	}
	const latest = (await state.store.list())[0];
	const previous = latest ? await state.store.snapshot(latest.configHash) : undefined;
	const { config, hash, rawSha256 } = state.config;
	const decision = await runReview(ui, { config, hash, ...(previous ? { previous } : {}), shadows: state.shadows });
	if (decision !== "approved") {
		ui.notify("승인하지 않았습니다. Storm 역할 스폰은 계속 막힙니다.");
		return;
	}
	await state.store.approve({
		configHash: hash,
		rawSha256,
		config,
		scope: deriveScope(config, state.shadows),
		via: env.mode,
		ompVersion: env.ompVersion,
		supersedes: latest?.approvalId ?? null,
	});
	ui.notify(`승인했습니다(${shortHash(hash)}).`);
}

export async function rollbackFlow(env: FlowEnv, ui: UiPort): Promise<void> {
	const state = await loadProjectState(env);
	const currentHash = state.config.status === "ok" ? state.config.hash : null;
	const options: RollbackOption[] = [];
	for (const record of await state.store.list()) {
		if (record.configHash === currentHash) continue;
		const config = await state.store.snapshot(record.configHash);
		if (config) options.push({ hash: record.configHash, approvedAt: record.approvedAt, config });
	}
	if (options.length === 0) {
		ui.notify("되돌릴 이전 승인 기록이 없습니다.");
		return;
	}
	const current = state.config.status === "ok" ? state.config.config : undefined;
	const result = await runRollback(ui, { options, ...(current ? { current } : {}) });
	if (result.status !== "approved") {
		ui.notify("되돌리지 않았습니다.");
		return;
	}
	const written = await writeConfig(state.repo.root, result.option.config);
	if (written.hash !== result.option.hash) throw new Error("되돌린 설정의 해시가 승인 기록과 다릅니다");
	await state.store.recordRollback(result.option.hash, currentHash);
	ui.notify(`${relative(state.repo.root, written.path)}를 ${shortHash(result.option.hash)}로 되돌렸습니다.`);
}
