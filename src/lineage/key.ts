import type { Lineage, LineageFn, LineageVariant, ModelIdentityInfo, ModelInfo } from "../types.ts";
import type { Priors } from "./priors.ts";

const EFFORT_SUFFIX = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "none"]);
const DATE_TOKEN = /^(\d{4}|\d{6}|\d{8})$/;
const HEAD = /^([a-z]*)(\d{1,2})$/;

interface Norm {
	toks: string[];
	variant: LineageVariant;
}

function normalize(wireId: string, route: Set<string>, vendor: Set<string>): Norm {
	const variant: LineageVariant = {};
	const setRoute = (r: string) => {
		variant.route ??= r;
	};
	let s = wireId.replace(/\[[^\]]*\]/g, "").toLowerCase();
	s = s.slice(s.lastIndexOf("/") + 1).replace(/^~+/, "");
	const at = s.indexOf("@");
	if (at > 0) {
		setRoute(s.slice(at + 1));
		s = s.slice(0, at);
	}
	const parts = s.split(":");
	s = parts[0] ?? "";
	const extra: string[] = [];
	for (const suf of parts.slice(1)) {
		if (suf === "thinking") variant.think = true;
		else if (route.has(suf)) setRoute(suf);
		else if (EFFORT_SUFFIX.has(suf)) variant.effort = suf;
		else if (DATE_TOKEN.test(suf)) variant.snapshot = suf;
		else if (/^\d+$/.test(suf) || suf === "peft" || suf === "") continue;
		else extra.push(suf);
	}
	for (let m = /^([a-z]+)\.(.+)$/.exec(s); m && vendor.has(m[1] ?? ""); m = /^([a-z]+)\.(.+)$/.exec(s)) {
		s = m[2] ?? "";
	}
	const toks = s.split(/[-._ ]+/).filter(Boolean).concat(extra);
	// Tail: route words and dates are variants, not identity.
	while (toks.length > 1) {
		const n = toks.length;
		const last = toks[n - 1] ?? "";
		if (route.has(last)) {
			setRoute(last);
			toks.pop();
		} else if (n >= 4 && /^\d{4}$/.test(toks[n - 3] ?? "") && /^\d{2}$/.test(toks[n - 2] ?? "") && /^\d{2}$/.test(last)) {
			variant.snapshot ??= toks.splice(n - 3, 3).join("-");
		} else if (DATE_TOKEN.test(last)) {
			variant.snapshot ??= last;
			toks.pop();
		} else break;
	}
	for (let i = toks.length - 1; i >= 1; i--) {
		const t = toks[i] ?? "";
		if (DATE_TOKEN.test(t)) variant.snapshot ??= t;
		else if (route.has(t)) setRoute(t);
		else continue;
		toks.splice(i, 1);
	}
	while (toks.length >= 2 && vendor.has(toks[0] ?? "")) toks.shift();
	return { toks, variant };
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
		classSource: "identity",
		suspect: false,
		variant,
	};
}

/** Build the lineage function once per catalog snapshot (p0-q9 Q9-1). */
export function createLineage(catalog: ModelInfo[], priors: Priors): LineageFn {
	const route = new Set(priors.lineage.routeTokens);
	const vendor = new Set(priors.lineage.vendorPrefixes);

	// Stem → class, only when every classified row with that stem agrees.
	const stemClasses = new Map<string, Set<string>>();
	for (const m of catalog) {
		if (!m.identity.class || m.identity.class === "unknown") continue;
		const stem = normalize(m.id, route, vendor).toks.join("-");
		let set = stemClasses.get(stem);
		if (!set) stemClasses.set(stem, (set = new Set()));
		set.add(m.identity.class);
	}

	const compute = (provider: string, wireId: string, identity: ModelIdentityInfo | undefined, known: Map<string, Set<string>> | null): Lineage => {
		const { toks, variant } = normalize(wireId, route, vendor);
		const base = wireId.toLowerCase().slice(wireId.lastIndexOf("/") + 1);
		const alias = priors.lineage.aliases.find(
			(a) => (a.match.provider === "*" || a.match.provider === provider) && a.match.id === base,
		);
		if (alias) return aliasLineage(alias.key, variant);

		let cls = identity?.class ?? "unknown";
		let classSource: Lineage["classSource"] = "identity";
		if (cls === "unknown" || !cls) {
			const set = stemClasses.get(toks.join("-"));
			if (set && set.size === 1) {
				cls = [...set][0] ?? "unknown";
				classSource = "stem";
			} else cls = "unknown";
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
				classSource: "unknown",
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
			classSource,
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
