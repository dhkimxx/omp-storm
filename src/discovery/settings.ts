import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgTaskIsolationApply, cfgTaskIsolationEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { Exec, ExplicitSettings } from "../types.ts";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses `omp config list --json`: a flat map of dotted keys to `{ value?, type, description }`.
 * Only model preferences, subagent concurrency and isolation, and retry fallback are read; other keys (auth.* included) are ignored.
 */
export function parseConfigList(text: string): ExplicitSettings {
	const settings: ExplicitSettings = { modelRoles: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return settings;
	}
	if (!isRec(parsed)) return settings;
	const valueOf = (key: string): unknown => {
		const entry = parsed[key];
		return isRec(entry) && "type" in entry ? entry.value : undefined;
	};

	const roles = valueOf("modelRoles");
	if (isRec(roles)) {
		for (const [role, model] of Object.entries(roles)) {
			if (typeof model === "string" && model) settings.modelRoles[role] = model;
		}
	}
	if (settings.modelRoles.default) settings.defaultModel = settings.modelRoles.default;
	const isolation = valueOf("task.isolation.enabled");
	if (typeof isolation === "boolean") settings.isolationEnabled = isolation;
	const apply = valueOf("task.isolation.apply");
	if (typeof apply === "boolean") settings.isolationApply = apply;
	const concurrency = valueOf("task.maxConcurrency");
	if (typeof concurrency === "number" && Number.isFinite(concurrency) && concurrency > 0) settings.maxConcurrency = concurrency;
	const modelFallback = valueOf("retry.modelFallback");
	if (typeof modelFallback === "boolean") settings.modelFallback = modelFallback;
	// An entry counts only when it is a list of non-empty selectors; others are dropped whole.
	const chains = valueOf("retry.fallbackChains");
	if (isRec(chains)) {
		settings.fallbackChains = {};
		for (const [key, chain] of Object.entries(chains)) {
			if (!Array.isArray(chain)) continue;
			const list = chain.filter((s): s is string => typeof s === "string" && s.length > 0);
			if (list.length === chain.length) settings.fallbackChains[key] = list;
		}
	}
	return settings;
}

/**
 * omp's effective task-isolation values from the live host settings, without a CLI subprocess. Undefined fields mean
 * this host cannot prove them (for example a test host with no initialized settings), never that they are off.
 */
export function liveIsolationSettings(): Pick<ExplicitSettings, "isolationEnabled" | "isolationApply"> {
	try {
		const settings = Settings.instance;
		return {
			isolationEnabled: cfgTaskIsolationEnabled.get(settings),
			isolationApply: cfgTaskIsolationApply.get(settings),
		};
	} catch {
		return {};
	}
}

export async function readExplicitSettings(exec: Exec, ompBin: string): Promise<ExplicitSettings> {
	try {
		const result = await exec(ompBin, ["config", "list", "--json"], { timeout: 30_000 });
		if (result.code !== 0 || result.killed) return { modelRoles: {} };
		return parseConfigList(result.stdout);
	} catch {
		return { modelRoles: {} };
	}
}
