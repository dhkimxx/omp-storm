import type { Effort, ModelCost, ModelIdentityInfo, ModelInfo } from "../types.ts";
import { EFFORTS } from "../types.ts";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rate(value: unknown): number {
	const n = finite(value);
	return n !== null && n > 0 ? n : 0;
}

function toIdentity(value: unknown): ModelIdentityInfo {
	if (!isRec(value)) return { class: "unknown" };
	const identity: ModelIdentityInfo = { class: typeof value.class === "string" ? value.class : "unknown" };
	if (typeof value.revision === "string") identity.revision = value.revision;
	return identity;
}

/** Normalizes an omp catalog `Model`; undefined for non-chat kinds or malformed rows. */
export function toModelInfo(model: unknown, available: boolean): ModelInfo | undefined {
	if (!isRec(model)) return undefined;
	if (model.kind !== undefined && model.kind !== "chat") return undefined;
	const { provider, id } = model;
	if (typeof provider !== "string" || typeof id !== "string" || !provider || !id) return undefined;
	const rawCost = isRec(model.cost) ? model.cost : {};
	const cost: ModelCost = {
		input: rate(rawCost.input),
		output: rate(rawCost.output),
		cacheRead: rate(rawCost.cacheRead),
		cacheWrite: rate(rawCost.cacheWrite),
	};
	const rawEfforts = isRec(model.thinking) && Array.isArray(model.thinking.efforts) ? model.thinking.efforts : [];
	const efforts = EFFORTS.filter(e => rawEfforts.includes(e)) as Effort[];
	const contextWindow = finite(model.contextWindow);
	return {
		provider,
		id,
		selector: `${provider}/${id}`,
		name: typeof model.name === "string" && model.name ? model.name : id,
		identity: toIdentity(model.identity),
		cost,
		pricingKnown: cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0,
		contextWindow: contextWindow !== null && contextWindow > 0 ? contextWindow : null,
		efforts,
		supportsTools: model.supportsTools !== false,
		int: finite(model.int),
		tps: finite(model.tps),
		available,
	};
}

export interface ModelRegistryPort {
	getAll(kind?: string): unknown[];
	getAvailable(kind?: string): unknown[];
}

/** Catalog = every chat model (flagged when usable now); available = usable chat models. Deduplicated by selector. */
export function collectModels(registry: ModelRegistryPort): { catalog: ModelInfo[]; available: ModelInfo[] } {
	const available: ModelInfo[] = [];
	const availableSet = new Set<string>();
	for (const raw of registry.getAvailable("chat")) {
		const info = toModelInfo(raw, true);
		if (!info || availableSet.has(info.selector)) continue;
		availableSet.add(info.selector);
		available.push(info);
	}
	const catalog: ModelInfo[] = [];
	const seen = new Set<string>();
	for (const raw of registry.getAll("chat")) {
		const info = toModelInfo(raw, false);
		if (!info || seen.has(info.selector)) continue;
		seen.add(info.selector);
		info.available = availableSet.has(info.selector);
		catalog.push(info);
	}
	// Available rows missing from getAll (runtime registrations) still belong to the catalog.
	for (const info of available) {
		if (!seen.has(info.selector)) {
			seen.add(info.selector);
			catalog.push({ ...info });
		}
	}
	return { catalog, available };
}
