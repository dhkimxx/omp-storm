import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PriorAlias {
	match: { provider: string; id: string };
	key: string;
	source: string;
	expires?: string;
}

export interface QualityPrior {
	key: string;
	metric: string;
	value: number;
	source: string;
	url?: string;
	date?: string;
	harness?: string;
}

export interface Priors {
	schema: number;
	updated: string;
	lineage: {
		routeTokens: string[];
		vendorPrefixes: string[];
		genericBrand: Record<string, string[]>;
		aliases: PriorAlias[];
	};
	tiers: {
		/** Tier order per class, low to high. */
		order: Record<string, string[]>;
		tierAliases: Record<string, string>;
	};
	priceTier: {
		referenceMix: { input: number; output: number; cacheRead: number; cacheWrite: number };
		cacheReadFallbackRatio: number;
		boundsUsdPerRequest: { cheapBelow: number; premiumFrom: number };
	};
	qualityPriors: QualityPrior[];
}

const DEFAULT_PATH = fileURLToPath(new URL("../../priors/priors.yml", import.meta.url));
const STALE_MS = 90 * 86_400_000;

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
			source: typeof o.source === "string" ? o.source : "",
		};
		if (o.expires !== undefined) alias.expires = dateStr(o.expires);
		return alias;
	});
	const t = obj(r.tiers ?? {}, "tiers");
	const order: Record<string, string[]> = {};
	let tierAliases: Record<string, string> = {};
	for (const [k, v] of Object.entries(t)) {
		if (k === "tier_aliases") {
			const ta = obj(v ?? {}, "tier_aliases");
			tierAliases = Object.fromEntries(Object.entries(ta).map(([a, b]) => [a, String(b)]));
		} else order[k] = strArr(v, `tiers.${k}`);
	}
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
		const p: QualityPrior = { key: o.key, metric: o.metric, value: num(o.value, "value"), source: o.source };
		if (typeof o.url === "string") p.url = o.url;
		if (o.date !== undefined) p.date = dateStr(o.date);
		if (typeof o.harness === "string") p.harness = o.harness;
		return p;
	});
	return {
		schema: num(r.schema, "schema"),
		updated: dateStr(r.updated),
		lineage: {
			routeTokens: strArr(lin.route_tokens, "route_tokens"),
			vendorPrefixes: strArr(lin.vendor_prefixes, "vendor_prefixes"),
			genericBrand,
			aliases,
		},
		tiers: { order, tierAliases },
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
	const now = opts.now ?? Date.now();
	if (now - Date.parse(`${priors.updated}T00:00:00Z`) > STALE_MS) {
		warnings.push(`사전값이 오래됐습니다(${priors.updated})`);
	}
	const today = new Date(now).toISOString().slice(0, 10);
	const live = priors.lineage.aliases.filter((a) => !a.expires || a.expires >= today);
	if (live.length < priors.lineage.aliases.length) {
		warnings.push(`만료된 별칭 ${priors.lineage.aliases.length - live.length}개를 무시합니다`);
		priors.lineage.aliases = live;
	}
	return { priors, warnings };
}
