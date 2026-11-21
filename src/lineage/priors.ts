import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PriorAlias {
	match: { provider: string; id: string };
	key: string;
	expires?: string;
}

export interface QualityPrior {
	key: string;
	metric: string;
	value: number;
	source: string;
}

export interface Priors {
	lineage: {
		routeTokens: string[];
		vendorPrefixes: string[];
		genericBrand: Record<string, string[]>;
		aliases: PriorAlias[];
	};
	priceTier: {
		referenceMix: { input: number; output: number; cacheRead: number; cacheWrite: number };
		cacheReadFallbackRatio: number;
		boundsUsdPerRequest: { cheapBelow: number; premiumFrom: number };
	};
	qualityPriors: QualityPrior[];
}

const DEFAULT_PATH = fileURLToPath(new URL("../../priors/priors.yml", import.meta.url));

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: unknown, over: unknown): unknown {
	if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
	const out: Raw = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
	return out;
}

function dateStr(v: unknown): string {
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
	throw new Error("updated");
}

function strArr(v: unknown, what: string): string[] {
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(what);
	return v.map((x) => x.toLowerCase());
}

function num(v: unknown, what: string): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(what);
	return v;
}

function obj(v: unknown, what: string): Raw {
	if (!isObj(v)) throw new Error(what);
	return v;
}

/** Throws on any shape error so the caller can fall back. */
function toPriors(raw: unknown): Priors {
	const r = obj(raw, "root");
	if (r.schema !== 1) throw new Error("schema");
	const lin = obj(r.lineage, "lineage");
	const gb = obj(lin.generic_brand, "generic_brand");
	const genericBrand: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(gb)) genericBrand[k] = strArr(v, `generic_brand.${k}`);
	const aliasesRaw = lin.aliases ?? [];
	if (!Array.isArray(aliasesRaw)) throw new Error("aliases");
	const aliases: PriorAlias[] = aliasesRaw.map((a) => {
		const o = obj(a, "alias");
		const m = obj(o.match, "alias.match");
		if (typeof m.id !== "string" || typeof o.key !== "string" || !/^[^/]+\/[^@]+@.+$/.test(o.key)) {
			throw new Error("alias");
		}
		const alias: PriorAlias = {
			match: { provider: typeof m.provider === "string" ? m.provider : "*", id: m.id.toLowerCase() },
			key: o.key,
		};
		if (o.expires !== undefined) alias.expires = dateStr(o.expires);
		return alias;
	});
	const pt = obj(r.price_tier, "price_tier");
	const mix = obj(pt.reference_mix, "reference_mix");
	const bounds = obj(pt.bounds_usd_per_request, "bounds_usd_per_request");
	const cheapBelow = num(bounds.cheap_below, "cheap_below");
	const premiumFrom = num(bounds.premium_from, "premium_from");
	if (cheapBelow > premiumFrom) throw new Error("bounds");
	const qp = r.quality_priors ?? [];
	if (!Array.isArray(qp)) throw new Error("quality_priors");
	const qualityPriors = qp.map((q) => {
		const o = obj(q, "quality_prior");
		if (typeof o.key !== "string" || typeof o.metric !== "string" || typeof o.source !== "string") {
			throw new Error("quality_prior");
		}
		return { key: o.key, metric: o.metric, value: num(o.value, "value"), source: o.source };
	});
	return {
		lineage: {
			routeTokens: strArr(lin.route_tokens, "route_tokens"),
			vendorPrefixes: strArr(lin.vendor_prefixes, "vendor_prefixes"),
			genericBrand,
			aliases,
		},
		priceTier: {
			referenceMix: {
				input: num(mix.input, "input"),
				output: num(mix.output, "output"),
				cacheRead: num(mix.cache_read, "cache_read"),
				cacheWrite: num(mix.cache_write, "cache_write"),
			},
			cacheReadFallbackRatio: num(pt.cache_read_fallback_ratio, "cache_read_fallback_ratio"),
			boundsUsdPerRequest: { cheapBelow, premiumFrom },
		},
		qualityPriors,
	};
}

/** Plugin defaults deep-merged with an optional user file (arrays replace). */
export function loadPriors(opts: { userPath?: string; now?: number } = {}): { priors: Priors; warnings: string[] } {
	const warnings: string[] = [];
	const baseRaw = Bun.YAML.parse(readFileSync(DEFAULT_PATH, "utf8"));
	let priors = toPriors(baseRaw);
	if (opts.userPath && existsSync(opts.userPath)) {
		try {
			const userRaw = Bun.YAML.parse(readFileSync(opts.userPath, "utf8"));
			if (userRaw !== null && userRaw !== undefined) priors = toPriors(deepMerge(baseRaw, userRaw));
		} catch {
			warnings.push(`사전값 파일 형식 오류로 기본값을 씁니다(${opts.userPath})`);
		}
	}
	const today = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
	const live = priors.lineage.aliases.filter((a) => !a.expires || a.expires >= today);
	if (live.length < priors.lineage.aliases.length) {
		warnings.push(`만료된 별칭 ${priors.lineage.aliases.length - live.length}개를 무시합니다`);
		priors.lineage.aliases = live;
	}
	return { priors, warnings };
}
