import type { Lineage, LineageFn, LineageVariant, ModelIdentityInfo, ModelInfo } from "../types.ts";
import type { Priors } from "./priors.ts";

/** Effort words that never name a model: as an id tail (`-high`) or suffix (`:high`) they are a variant of the same lineage. */
const EFFORT_ONLY = new Set(["minimal", "low", "high", "xhigh", "none"]);
/** Effort words that also name models ("mistral-medium", "codex-max"): an id tail counts as an effort only with proof. */
const EFFORT_OR_NAME = new Set(["medium", "max"]);
const DATE_TOKEN = /^(\d{4}|\d{6}|\d{8})$/;
const HEAD = /^([a-z]*)(\d{1,2})$/;

interface Norm {
	toks: string[];
	variant: LineageVariant;
}

/**
 * What the catalog proves about `-medium` / `-max` tails. Such a tail is an effort when
 * - the stem is `proven`: listed with two or more tails that can only be efforts ("kimi-k3-high", "kimi-k3-low"), or
 * - it is `-medium` and the catalog lists the `bare` stem itself ("gpt-oss-120b" next to "gpt-oss-120b-medium"),
 * and never when the id with the tail is `named`: itself listed with an effort tail ("gpt-5.1-codex-max-high"
 * makes "gpt-5.1-codex-max" a model).
 */
interface EffortProof {
	proven: ReadonlySet<string>;
	named: ReadonlySet<string>;
	bare: ReadonlySet<string>;
}

/** Tokens joined without leading vendor words: the form stems are compared in. */
function stemKey(toks: readonly string[], vendor: Set<string>): string {
	let start = 0;
	while (toks.length - start >= 2 && vendor.has(toks[start] ?? "")) start++;
	return toks.slice(start).join("-");
}

/** The id's name tokens before any tail is removed; `:suffix` and `@route` parts are already sorted out. */
function nameTokens(wireId: string, route: Set<string>, vendor: Set<string>): Norm {
	const variant: LineageVariant = {};
	let s = wireId.replace(/\[[^\]]*\]/g, "").toLowerCase();
	s = s.slice(s.lastIndexOf("/") + 1);
	const at = s.indexOf("@");
	if (at > 0) {
		variant.route = s.slice(at + 1);
		s = s.slice(0, at);
	}
	const parts = s.split(":");
	s = parts[0] ?? "";
	const extra: string[] = [];
	for (const suf of parts.slice(1)) {
		if (route.has(suf)) variant.route ??= suf;
		// Thinking toggles, efforts, snapshots and counters are the same model.
		else if (suf === "thinking" || EFFORT_ONLY.has(suf) || EFFORT_OR_NAME.has(suf) || /^\d*$/.test(suf) || suf === "peft") continue;
		else extra.push(suf);
	}
	for (let m = /^([a-z]+)\.(.+)$/.exec(s); m && vendor.has(m[1] ?? ""); m = /^([a-z]+)\.(.+)$/.exec(s)) {
		s = m[2] ?? "";
	}
	return { toks: s.split(/[-._ ]+/).filter(Boolean).concat(extra), variant };
}

/** `proof` undefined leaves every effort tail in place (used to collect the proof itself). */
function normalize(wireId: string, route: Set<string>, vendor: Set<string>, proof: EffortProof | undefined): Norm {
	const { toks, variant } = nameTokens(wireId, route, vendor);
	// Tail: route words, dates and efforts are variants, not identity.
	while (toks.length > 1) {
		const n = toks.length;
		const last = toks[n - 1] ?? "";
		if (route.has(last)) {
			variant.route ??= last;
			toks.pop();
		} else if (n >= 4 && /^\d{4}$/.test(toks[n - 3] ?? "") && /^\d{2}$/.test(toks[n - 2] ?? "") && /^\d{2}$/.test(last)) {
			toks.splice(n - 3, 3);
		} else if (DATE_TOKEN.test(last)) {
			toks.pop();
		} else if (proof !== undefined && isEffortTail(toks, vendor, proof)) {
			toks.pop();
		} else break;
	}
	for (let i = toks.length - 1; i >= 1; i--) {
		const t = toks[i] ?? "";
		if (route.has(t)) variant.route ??= t;
		else if (!DATE_TOKEN.test(t)) continue;
		toks.splice(i, 1);
	}
	while (toks.length >= 2 && vendor.has(toks[0] ?? "")) toks.shift();
	return { toks, variant };
}

function isEffortTail(toks: readonly string[], vendor: Set<string>, proof: EffortProof): boolean {
	const last = toks[toks.length - 1] ?? "";
	if (EFFORT_ONLY.has(last)) return true;
	if (!EFFORT_OR_NAME.has(last) || proof.named.has(stemKey(toks, vendor))) return false;
	const stem = stemKey(toks.slice(0, -1), vendor);
	return proof.proven.has(stem) || (last === "medium" && proof.bare.has(stem));
}

function effortProofOf(catalog: ModelInfo[], route: Set<string>, vendor: Set<string>): EffortProof {
	const tails = new Map<string, Set<string>>();
	const bare = new Set<string>();
	for (const m of catalog) {
		// A `:suffix` form ("devstral:24b") is not the bare model listed under its own name.
		if (!m.id.includes(":")) bare.add(stemKey(nameTokens(m.id, route, vendor).toks, vendor));
		const { toks } = normalize(m.id, route, vendor, undefined);
		const last = toks[toks.length - 1] ?? "";
		if (toks.length < 2 || !(EFFORT_ONLY.has(last) || EFFORT_OR_NAME.has(last))) continue;
		const stem = toks.slice(0, -1).join("-");
		let set = tails.get(stem);
		if (!set) tails.set(stem, (set = new Set()));
		set.add(last);
	}
	const proven = new Set<string>();
	for (const [stem, set] of tails) {
		let certain = 0;
		for (const tail of set) if (EFFORT_ONLY.has(tail)) certain++;
		if (certain >= 2) proven.add(stem);
	}
	return { proven, named: new Set(tails.keys()), bare };
}

function padRev(parts: string[]): string {
	const p = parts.slice(0, 3);
	while (p.length < 3) p.push("0");
	return p.map((x) => String(Number(x))).join(".");
}

function identityRev(rev: string | undefined): string | null {
	if (!rev || !/^\d+(\.\d+){0,2}$/.test(rev)) return null;
	return padRev(rev.split("."));
}

export function compareRevision(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = Number(pa[i] ?? 0);
		const y = Number(pb[i] ?? 0);
		if (Number.isNaN(x) || Number.isNaN(y)) {
			const c = (pa[i] ?? "").localeCompare(pb[i] ?? "");
			if (c !== 0) return c;
		} else if (x !== y) return x - y;
	}
	return 0;
}

function aliasLineage(key: string, variant: LineageVariant): Lineage {
	const [lineKey = "", rev = "?"] = key.split("@");
	const slash = lineKey.indexOf("/");
	const revision = rev === "?" ? null : rev;
	return {
		modelKey: key,
		lineKey,
		cls: lineKey.slice(0, slash),
		tier: lineKey.slice(slash + 1),
		revision,
		revisionSource: null,
		suspect: false,
		variant,
	};
}

/** Build the lineage function once per catalog snapshot (p0-q9 Q9-1). */
export function createLineage(catalog: ModelInfo[], priors: Priors): LineageFn {
	const route = new Set(priors.lineage.routeTokens);
	const vendor = new Set(priors.lineage.vendorPrefixes);
	const efforts = effortProofOf(catalog, route, vendor);

	// Stem → class, only when every classified row with that stem agrees.
	const stemClasses = new Map<string, Set<string>>();
	for (const m of catalog) {
		if (!m.identity.class || m.identity.class === "unknown") continue;
		const stem = normalize(m.id, route, vendor, efforts).toks.join("-");
		let set = stemClasses.get(stem);
		if (!set) stemClasses.set(stem, (set = new Set()));
		set.add(m.identity.class);
	}

	const compute = (provider: string, wireId: string, identity: ModelIdentityInfo | undefined, known: Map<string, Set<string>> | null): Lineage => {
		const { toks, variant } = normalize(wireId, route, vendor, efforts);
		const base = wireId.toLowerCase().slice(wireId.lastIndexOf("/") + 1);
		const alias = priors.lineage.aliases.find(
			(a) => (a.match.provider === "*" || a.match.provider === provider) && a.match.id === base,
		);
		if (alias) return aliasLineage(alias.key, variant);

		let cls = identity?.class ?? "unknown";
		if (cls === "unknown" || !cls) {
			const set = stemClasses.get(toks.join("-"));
			cls = set && set.size === 1 ? ([...set][0] ?? "unknown") : "unknown";
		}
		if (cls === "unknown") {
			const tier = toks.join("-") || "-";
			return {
				modelKey: `unknown/${tier}`,
				lineKey: `unknown/${tier}`,
				cls: "unknown",
				tier,
				revision: null,
				revisionSource: null,
				suspect: false,
				variant,
			};
		}
		const gen = new Set([cls, ...(priors.lineage.genericBrand[cls] ?? [])]);
		const rest: string[] = [];
		const nrev: string[] = [];
		let head = false;
		for (const t of toks) {
			if (gen.has(t)) continue;
			const m = HEAD.exec(t);
			if (!head && m) {
				const prefix = m[1] ?? "";
				if (prefix === "" || gen.has(prefix) || prefix.length === 1) {
					if (prefix !== "" && !gen.has(prefix) && prefix !== "v") rest.push(prefix);
					nrev.push(m[2] ?? "");
					head = true;
					continue;
				}
			}
			if (head && /^\d{1,2}$/.test(t) && nrev.length < 3) {
				nrev.push(t);
				continue;
			}
			rest.push(t);
		}
		const tier = rest.join("-") || "-";
		const lineKey = `${cls}/${tier}`;
		let revision = identityRev(identity?.revision);
		let revisionSource: Lineage["revisionSource"] = revision ? "identity" : null;
		if (!revision && nrev.length > 0) {
			revision = padRev(nrev);
			revisionSource = "name";
		}
		let suspect = false;
		const major = revision ? Number(revision.split(".")[0]) : 0;
		if (revision && major >= 10 && known) {
			const digits = String(major);
			const cand = `${digits[0]}.${digits.slice(1)}.0`;
			if (digits.length === 2 && known.get(lineKey)?.has(cand)) revision = cand;
			else suspect = true;
		}
		return {
			modelKey: `${lineKey}@${revision ?? "?"}`,
			lineKey,
			cls,
			tier,
			revision,
			revisionSource,
			suspect,
			variant,
		};
	};

	// Revisions that look normal, to resolve compressed ones like "56" → 5.6.
	const known = new Map<string, Set<string>>();
	for (const m of catalog) {
		const l = compute(m.provider, m.id, m.identity, null);
		if (!l.revision || Number(l.revision.split(".")[0]) >= 10) continue;
		let set = known.get(l.lineKey);
		if (!set) known.set(l.lineKey, (set = new Set()));
		set.add(l.revision);
	}
	return (provider, wireId, identity) => compute(provider, wireId, identity, known);
}

/** Human-readable name without route words and dates, e.g. "DeepSeek V4.1 Flash". */
export function displayLabel(model: ModelInfo | undefined, lineage: Lineage): string {
	const ROUTE_WORDS = /^(fast|ultrafast|highspeed|economy|flex|speed|latest|preview|original|free|contributor|discounted|tee|nitro|exacto|thinking-mode)$/i;
	if (model?.name.trim()) {
		const words = model.name
			.split(/\s+/)
			.filter((w) => {
				const bare = w.replace(/^[(\[]+|[)\]]+$/g, "");
				return bare && !ROUTE_WORDS.test(bare) && !DATE_TOKEN.test(bare) && !/^\d{4}-\d{2}-\d{2}$/.test(bare);
			});
		if (words.length > 0) return words.join(" ");
	}
	const words = [lineage.cls, ...(lineage.tier === "-" ? [] : lineage.tier.split("-"))].map(
		(w) => w.charAt(0).toUpperCase() + w.slice(1),
	);
	if (lineage.revision) words.push(lineage.revision.replace(/(\.0)+$/, ""));
	return words.join(" ");
}
