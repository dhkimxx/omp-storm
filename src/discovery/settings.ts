import type { Exec, ExplicitSettings } from "../types.ts";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses `omp config list --json`: a flat map of dotted keys to `{ value?, type, description }`.
 * Only model preferences, magic-keyword toggles, the subagent idle TTL and cache retention are read; other keys (auth.* included) are ignored.
 */
export function parseConfigList(text: string): ExplicitSettings {
	const settings: ExplicitSettings = { modelRoles: {}, agentModelOverrides: {} };
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

	const overrides = valueOf("task.agentModelOverrides");
	if (isRec(overrides)) {
		for (const [agent, model] of Object.entries(overrides)) {
			if (typeof model === "string" && model) settings.agentModelOverrides[agent] = model;
			else if (Array.isArray(model)) {
				const list = model.filter((m): m is string => typeof m === "string" && m.length > 0);
				if (list.length > 0) settings.agentModelOverrides[agent] = list;
			}
		}
	}

	// omp names the workflowz keyword's setting `magicKeywords.workflow`.
	const enabled = valueOf("magicKeywords.enabled");
	const workflowz = valueOf("magicKeywords.workflow");
	const orchestrate = valueOf("magicKeywords.orchestrate");
	if (typeof enabled === "boolean" && typeof workflowz === "boolean" && typeof orchestrate === "boolean") {
		settings.magicKeywords = { enabled, workflowz, orchestrate };
	}
	const idleTtl = valueOf("task.agentIdleTtlMs");
	if (typeof idleTtl === "number" && Number.isFinite(idleTtl) && idleTtl >= 0) settings.agentIdleTtlMs = idleTtl;
	const retention = valueOf("providers.cacheRetention");
	if (typeof retention === "string" && retention) settings.cacheRetention = retention;
	return settings;
}

export async function readExplicitSettings(exec: Exec, ompBin: string): Promise<ExplicitSettings> {
	try {
		const result = await exec(ompBin, ["config", "list", "--json"], { timeout: 30_000 });
		if (result.code !== 0 || result.killed) return { modelRoles: {}, agentModelOverrides: {} };
		return parseConfigList(result.stdout);
	} catch {
		return { modelRoles: {}, agentModelOverrides: {} };
	}
}
