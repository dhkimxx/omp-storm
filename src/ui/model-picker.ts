/**
 * Picks an available tool-capable chat model and its supported effort for one Storm role slot, without changing the
 * omp session or its settings. `current` is the slot's canonical selector and known effort; a pick without `effort`
 * means the model default (a bare selector). TUI only; cancelling resolves undefined.
 *
 * Owner: slice D. Keep {@link pickStormModel}.
 *
 * omp 19.2 no longer hands extensions its model picker component, so Storm owns what that component gave it: the
 * search, the provider scopes, the list and the effort level. It sits on the host's data-first `picker` node: Storm's
 * program owns the query, the filter, the selection and the items; the node carries them (`items`, `order`, `scopes`,
 * `level`, ...) and reports `select`, `activate` and `action`. A native (Tern) host draws those props itself.
 *
 * In a terminal the host's default picker sheet draws the title, the list rows and a hint row, but not `scopes` or
 * `level` (omp's own picker has a private look for them, built on an internal browser object an extension cannot
 * use). So the same state also goes out as `term` facts the default sheet does draw: head rows (status, the effort
 * steps, the provider chips, the search field with its caret), one text per list row, and the hint row.
 *
 * Keys: the program sees them first (`onKey`); the node's own widget then does ↑/↓, paging, Home/End and Enter.
 * Storm takes typing and caret keys for the query, Tab and Shift+Tab for the provider scope, ←/→ for the effort
 * level and Esc to cancel.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toModelInfo } from "../discovery/models.ts";
import { batch, computed, h, type KeyEvent, signal, singleLine, span, type Span, truncate, visibleWidth } from "../tui/kit.ts";
import { EFFORTS, type Effort, type ModelInfo, type StormModelPick } from "../types.ts";

/** The effort level that means the model's own default: stored as a bare selector. */
export const AUTO_STEP = "auto";
/** The level no Storm effort stands for. */
export const OFF_STEP = "off";

/** What the sheet says about a pick, next to the current level. */
const STATUS_TEXT = "이 역할에만 · 세션 유지 · Auto=기본값";
const SEARCH_PLACEHOLDER = "모델 검색…";
/** Shown over an empty list: no model at all, or none matching the query. */
export const EMPTY_CATALOG_TEXT = "사용 가능한 모델이 없습니다";
export const NO_MATCH_TEXT = "일치하는 모델이 없습니다";
const HINT_TEXT = "↑/↓ 이동 · ⏎ 선택 · ⇥ 공급자 · ←/→ effort · ⎋ 취소";
const HINT_SEARCH = "입력으로 검색";
const ALL_LABEL = "전체";
/** Why a model without an effort ladder has a frozen level. */
const FROZEN_TEXT = "no thinking";

const ALL_SCOPE = "all";
const PROVIDER_SCOPE = "provider:";

/** Slider labels, as omp's own picker words them. */
const STEP_LABELS: Readonly<Record<string, string>> = {
	auto: "Auto",
	off: "Off",
	minimal: "Min",
	low: "Low",
	medium: "Med",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};
/** The steps a frozen slider draws (a model with no effort to pick). */
const FROZEN_STEPS: readonly string[] = [OFF_STEP, "minimal", "low", "medium", "high"];

const isStormEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);

const stepLabel = (id: string): string => STEP_LABELS[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

/** One model the picker offers: Storm's description of it plus the effort ladder the catalog lists, verbatim. */
export interface Entry {
	readonly info: ModelInfo;
	/** Efforts as the catalog lists them, including ones Storm has no name for (which a pick refuses). */
	readonly ladder: readonly string[];
}

/** The slider for the highlighted model: its steps low to high, the step shown and why it is frozen. */
interface Slider {
	readonly steps: readonly string[];
	readonly value: string;
	readonly disabled?: string;
}

/** The text the picker shows when a pick is refused; the picker stays open. */
export function refusalText(effort: string, supported: readonly string[]): string {
	const list = supported.length > 0 ? supported.join(", ") : "없음";
	return effort === OFF_STEP
		? `Off는 Storm effort가 아닙니다 · 지원: ${list}`
		: `${effort} effort는 이 모델에서 지원되지 않습니다 · 지원: ${list}`;
}

/** Tool-capable chat models the registry offers, deduplicated by selector. */
function availableEntries(registry: ExtensionContext["modelRegistry"]): Entry[] {
	let raw: unknown[];
	try {
		raw = registry.getAvailable("chat");
	} catch {
		return [];
	}
	const seen = new Set<string>();
	const entries: Entry[] = [];
	for (const model of raw) {
		if (typeof model === "object" && model !== null && (model as { supportsTools?: unknown }).supportsTools === false) continue;
		const info = toModelInfo(model, true);
		if (info === undefined || seen.has(info.selector)) continue;
		seen.add(info.selector);
		entries.push({ info, ladder: ladderOf(model) });
	}
	return entries;
}

function ladderOf(model: unknown): string[] {
	const thinking = (model as { thinking?: { efforts?: unknown } } | null)?.thinking;
	const efforts = thinking?.efforts;
	return Array.isArray(efforts) ? efforts.filter((effort): effort is string => typeof effort === "string") : [];
}

/** The catalog's own error, if the registry reports one. */
function registryError(registry: ExtensionContext["modelRegistry"]): string | undefined {
	try {
		const error: unknown = registry.getError();
		if (error === undefined || error === null) return undefined;
		return singleLine(error instanceof Error ? error.message : String(error));
	} catch {
		return undefined;
	}
}

/** `level` as one of the model's own steps: an effort the ladder lacks lands on the nearest lower one, else the nearest higher. */
function clampStep(ladder: readonly string[], level: string): string {
	if (level === AUTO_STEP) return AUTO_STEP;
	if (level === OFF_STEP || ladder.includes(level)) return level;
	const rank = EFFORTS.indexOf(level as Effort);
	if (rank < 0) return OFF_STEP;
	const known = ladder.filter(isStormEffort);
	const lower = known.filter(effort => EFFORTS.indexOf(effort) < rank);
	if (lower.length > 0) return lower.reduce((best, effort) => (EFFORTS.indexOf(effort) > EFFORTS.indexOf(best) ? effort : best));
	const higher = known.filter(effort => EFFORTS.indexOf(effort) > rank);
	if (higher.length > 0) return higher.reduce((best, effort) => (EFFORTS.indexOf(effort) < EFFORTS.indexOf(best) ? effort : best));
	return OFF_STEP;
}

/** `200000` → `200K`, `1000000` → `1M`. */
function compactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
	return String(tokens);
}

const dollars = (usd: number): string => `$${+usd.toFixed(2)}`;

interface Match {
	readonly entry: Entry;
	/** [from, to) ranges in the selector that a query token matched. */
	readonly hits: ReadonlyArray<readonly [number, number]>;
}

/**
 * The entries matching `query`, best first. Each whitespace-separated token must occur in "selector name" (a plain,
 * case-insensitive substring) or, failing that, as a subsequence of the selector. A model matching on a segment start
 * (`opus` for `anthropic/claude-opus-5`) ranks above one matching in the middle, a substring above a subsequence; ties
 * keep the catalog order.
 */
export function filterEntries(entries: readonly Entry[], query: string): Match[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(token => token.length > 0);
	if (tokens.length === 0) return entries.map(entry => ({ entry, hits: [] }));
	const out: Array<Match & { score: number; at: number }> = [];
	entries.forEach((entry, at) => {
		const selector = entry.info.selector.toLowerCase();
		const haystack = `${selector} ${entry.info.name.toLowerCase()}`;
		const hits: Array<[number, number]> = [];
		let score = 0;
		for (const token of tokens) {
			const found = haystack.indexOf(token);
			if (found >= 0) {
				const segmentStart = found === 0 || /[/\-_. ]/.test(haystack.charAt(found - 1));
				score += (segmentStart ? 0 : 1) + found / 1000;
				if (found + token.length <= selector.length) hits.push([found, found + token.length]);
				continue;
			}
			const positions = subsequence(selector, token);
			if (positions === undefined) return;
			score += 5;
			for (const position of positions) hits.push([position, position + 1]);
		}
		out.push({ entry, hits: mergeRanges(hits), score, at });
	});
	out.sort((a, b) => a.score - b.score || a.at - b.at);
	return out.map(({ entry, hits }) => ({ entry, hits }));
}

function subsequence(text: string, token: string): number[] | undefined {
	const positions: number[] = [];
	let from = 0;
	for (const char of token) {
		const at = text.indexOf(char, from);
		if (at < 0) return undefined;
		positions.push(at);
		from = at + 1;
	}
	return positions;
}

function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: Array<[number, number]> = [];
	for (const [from, to] of sorted) {
		const last = merged.at(-1);
		if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
		else merged.push([from, to]);
	}
	return merged;
}

/** The previous word boundary before `at` (what Alt+← and Ctrl+← jump to). */
function wordBefore(text: string, at: number): number {
	let i = at;
	while (i > 0 && /\s/.test(text.charAt(i - 1))) i--;
	while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--;
	return i;
}

/** The next word boundary after `at` (what Alt+→ and Ctrl+→ jump to). */
function wordAfter(text: string, at: number): number {
	let i = at;
	while (i < text.length && /\s/.test(text.charAt(i))) i++;
	while (i < text.length && !/\s/.test(text.charAt(i))) i++;
	return i;
}

/** The UTF-16 offset of the code point before `at` (a surrogate pair is one character). */
function previousPoint(text: string, at: number): number {
	if (at <= 0) return 0;
	const low = text.charCodeAt(at - 1);
	const high = at >= 2 ? text.charCodeAt(at - 2) : 0;
	return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? at - 2 : at - 1;
}

function nextPoint(text: string, at: number): number {
	if (at >= text.length) return text.length;
	const high = text.charCodeAt(at);
	return high >= 0xd800 && high <= 0xdbff && at + 1 < text.length ? at + 2 : at + 1;
}

/** Text a key types into the search: a printable character without ctrl, alt or super. */
function typedText(key: KeyEvent): string | undefined {
	if (key.text === undefined || key.text.length === 0) return undefined;
	if (/(^|\+)(ctrl|alt|super)\+/.test(key.id)) return undefined;
	if (/[\u0000-\u001f\u007f]/.test(key.text)) return undefined;
	return key.text;
}

export async function pickStormModel(
	ctx: ExtensionContext,
	title: string,
	current?: { selector: string; effort?: Effort },
): Promise<StormModelPick | undefined> {
	const entries = availableEntries(ctx.modelRegistry);
	const catalogError = registryError(ctx.modelRegistry);
	// An empty catalog still opens: the sheet says there is nothing to choose, and Esc closes it.
	return ctx.ui.custom<StormModelPick | undefined>((ui, _theme, _keys, done) => build(ui, entries, catalogError, title, current, done), {
		overlay: true,
	});
}

type Ui = Parameters<Parameters<ExtensionContext["ui"]["custom"]>[0]>[0];

function build(
	ui: Ui,
	entries: readonly Entry[],
	catalogError: string | undefined,
	title: string,
	current: { selector: string; effort?: Effort } | undefined,
	done: (pick: StormModelPick | undefined) => void,
) {
	const byId = new Map(entries.map(entry => [entry.info.selector, entry] as const));
	const providers = [...new Set(entries.map(entry => entry.info.provider))].sort((a, b) => a.localeCompare(b));
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.info.provider, (counts.get(entry.info.provider) ?? 0) + 1);

	const query = signal("");
	const cursor = signal(0);
	const scope = signal(ALL_SCOPE);
	/** The level the user stepped to; undefined while untouched (each model then shows its own starting level). */
	const pending = signal<string | undefined>(undefined);
	const refusal = signal<string | undefined>(undefined);
	const selected = signal<string | null>(null);

	const scoped = (): Entry[] => {
		const provider = scope().startsWith(PROVIDER_SCOPE) ? scope().slice(PROVIDER_SCOPE.length) : undefined;
		return provider === undefined ? [...entries] : entries.filter(entry => entry.info.provider === provider);
	};
	const matches = computed(() => filterEntries(scoped(), query()));
	const listedIds = (): string[] => matches().map(match => match.entry.info.selector);
	const isListed = (id: string | null): id is string => id !== null && matches().some(match => match.entry.info.selector === id);

	/** Where the highlight goes after the list changed: stay when possible, else the current model, else the best match. */
	const retarget = (reset: boolean): void => {
		const ids = matches().map(match => match.entry.info.selector);
		const before = selected.peek();
		if (!reset && before !== null && ids.includes(before)) return;
		const target = query.peek().trim() === "" && current !== undefined && ids.includes(current.selector) ? current.selector : ids[0];
		selected.set(target ?? null);
	};
	retarget(true);

	/** The level a model shows before the user stepped anywhere: the slot's own effort, else Auto. */
	const startingLevel = (entry: Entry): string =>
		current !== undefined && current.selector === entry.info.selector && current.effort !== undefined && entry.info.efforts.includes(current.effort)
			? current.effort
			: AUTO_STEP;

	const sliderOf = (entry: Entry | undefined): Slider | undefined => {
		if (entry === undefined) return undefined;
		if (entry.ladder.length === 0) return { steps: FROZEN_STEPS, value: OFF_STEP, disabled: FROZEN_TEXT };
		return { steps: [AUTO_STEP, OFF_STEP, ...entry.ladder], value: clampStep(entry.ladder, pending() ?? startingLevel(entry)) };
	};
	const highlighted = (): Entry | undefined => {
		const id = selected();
		return id === null ? undefined : byId.get(id);
	};
	const slider = (): Slider | undefined => sliderOf(highlighted());

	// ── Actions ──

	const setQuery = (text: string, at: number): void => {
		batch(() => {
			query.set(text);
			cursor.set(Math.max(0, Math.min(text.length, at)));
			retarget(text.trim() !== "");
		});
	};
	const insert = (text: string): void => {
		const q = query.peek();
		const at = cursor.peek();
		setQuery(`${q.slice(0, at)}${text}${q.slice(at)}`, at + text.length);
	};
	const backspace = (): void => {
		const q = query.peek();
		const at = cursor.peek();
		if (at === 0) return;
		const from = previousPoint(q, at);
		setQuery(`${q.slice(0, from)}${q.slice(at)}`, from);
	};
	const deleteForward = (): void => {
		const q = query.peek();
		const at = cursor.peek();
		if (at >= q.length) return;
		setQuery(`${q.slice(0, at)}${q.slice(nextPoint(q, at))}`, at);
	};
	const deleteWord = (): void => {
		const q = query.peek();
		const at = cursor.peek();
		const from = wordBefore(q, at);
		if (from < at) setQuery(`${q.slice(0, from)}${q.slice(at)}`, from);
	};

	const setScope = (picked: string): void => {
		const id = picked === scope.peek() ? ALL_SCOPE : picked;
		if (id === scope.peek()) return;
		if (id !== ALL_SCOPE && !providers.some(provider => `${PROVIDER_SCOPE}${provider}` === id)) return;
		batch(() => {
			scope.set(id);
			retarget(false);
		});
	};
	const cycleScope = (delta: 1 | -1): void => {
		const ids = [ALL_SCOPE, ...providers.map(provider => `${PROVIDER_SCOPE}${provider}`)];
		if (providers.length < 2) return;
		const next = ids[(ids.indexOf(scope.peek()) + delta + ids.length) % ids.length];
		if (next === undefined) return;
		batch(() => {
			scope.set(next);
			retarget(false);
		});
	};

	const stepEffort = (delta: 1 | -1): void => {
		const shown = slider();
		if (shown === undefined || shown.disabled !== undefined) return;
		const at = shown.steps.indexOf(shown.value);
		const next = shown.steps[Math.max(0, Math.min(shown.steps.length - 1, at + delta))];
		if (next !== undefined && next !== shown.value) pending.set(next);
	};
	const setEffort = (value: string | undefined): void => {
		const shown = slider();
		if (shown === undefined || shown.disabled !== undefined) return;
		const step = shown.steps.find(candidate => candidate === value);
		if (step !== undefined) pending.set(step);
	};

	const highlight = (id: string): void => {
		if (isListed(id)) selected.set(id);
	};

	/** Enter on a model. A refused effort keeps the picker open with the reason on screen. */
	const choose = (id: string): void => {
		const entry = byId.get(id);
		if (entry === undefined || !isListed(id)) return;
		const info = entry.info;
		const shown = sliderOf(entry);
		const level = pending.peek() === undefined || shown === undefined || shown.disabled !== undefined ? undefined : shown.value;
		if (level === undefined) {
			// Untouched: carry the slot's effort only when the same model still supports it; a new model is bare.
			const kept = current?.selector === info.selector && current.effort !== undefined && info.efforts.includes(current.effort) ? current.effort : undefined;
			done(kept === undefined ? { model: info } : { model: info, effort: kept });
			return;
		}
		// Auto is the model's own default in Storm, stored as a bare selector; the status row says so.
		if (level === AUTO_STEP) {
			done({ model: info });
			return;
		}
		// Off is not a Storm effort, and neither is a ladder entry Storm has no name for.
		if (!isStormEffort(level) || !info.efforts.includes(level)) {
			refusal.set(refusalText(level, info.efforts));
			ui.requestRender();
			return;
		}
		done({ model: info, effort: level });
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		// A changed highlight, scope, query or step may make the previous refusal moot. Enter runs after this and may refuse again.
		if (refusal.peek() !== undefined) refusal.set(undefined);
		switch (key.id) {
			case "escape":
			case "ctrl+c":
				done(undefined);
				return true;
			case "tab":
				cycleScope(1);
				return true;
			case "shift+tab":
				cycleScope(-1);
				return true;
			case "left":
				stepEffort(-1);
				return true;
			case "right":
				stepEffort(1);
				return true;
			case "alt+left":
			case "ctrl+left":
				cursor.set(wordBefore(query.peek(), cursor.peek()));
				return true;
			case "alt+right":
			case "ctrl+right":
				cursor.set(wordAfter(query.peek(), cursor.peek()));
				return true;
			case "ctrl+a":
				cursor.set(0);
				return true;
			case "ctrl+e":
				cursor.set(query.peek().length);
				return true;
			case "backspace":
				backspace();
				return true;
			case "delete":
				deleteForward();
				return true;
			case "ctrl+u":
				setQuery("", 0);
				return true;
			case "ctrl+w":
			case "alt+backspace":
				deleteWord();
				return true;
			default:
				break;
		}
		const text = typedText(key);
		if (text === undefined) return false;
		insert(text);
		return true;
	};

	// ── What the host draws ──

	const items = entries.map(entry => {
		const { info } = entry;
		return {
			id: info.selector,
			label: info.selector,
			mono: true,
			...(info.name !== info.id ? { detail: info.name } : {}),
			mark: { text: info.provider, icon: `provider:${info.provider}` },
			facts: {
				...(info.contextWindow !== null ? { ctx: compactTokens(info.contextWindow) } : {}),
				...(info.pricingKnown ? { price: `${dollars(info.cost.input)} / ${dollars(info.cost.output)}` } : {}),
			},
		};
	});
	const columns = [
		{ id: "ctx", head: "ctx", format: "dim" as const, priority: 2 },
		{ id: "price", head: "$/M", format: "dim" as const, priority: 1 },
	];
	const hitsById = computed(() => {
		const out: Record<string, ReadonlyArray<readonly [number, number]>> = {};
		for (const match of matches()) if (match.hits.length > 0) out[match.entry.info.selector] = match.hits;
		return out;
	});
	const scopes = providers.map(provider => ({
		id: `${PROVIDER_SCOPE}${provider}`,
		label: provider,
		mark: { text: provider, icon: `provider:${provider}` },
		count: counts.get(provider) ?? 0,
	}));

	const statusLine = (): string => (catalogError !== undefined ? catalogError : refusal() ?? STATUS_TEXT);
	const levelTone = (id: string): string | undefined => (id === AUTO_STEP ? undefined : `thinking${id.charAt(0).toUpperCase()}${id.slice(1)}`);
	const levelSpan = (id: string, label: string): Span => {
		const tone = levelTone(id);
		return tone === undefined ? span(label, "accent") : span(label, tone);
	};

	const statusRow = (): Span[] => {
		const shown = slider();
		const note = span(statusLine(), catalogError !== undefined ? "error" : refusal() !== undefined ? "warning" : "muted");
		if (shown === undefined) return [note];
		const level: Span[] =
			shown.disabled !== undefined ? [span(shown.disabled, "dim")] : [span("thinking ", "muted"), levelSpan(shown.value, stepLabel(shown.value))];
		// A refusal leads: at 60 columns the row has no room for the level and the Auto note both.
		return refusal() !== undefined ? [note, span(" · ", "dim"), ...level] : [...level, span(" · ", "dim"), note];
	};

	const stepsRow = (): Span[] | undefined => {
		const shown = slider();
		if (shown === undefined || catalogError !== undefined) return undefined;
		const out: Span[] = [span("effort ", "muted")];
		shown.steps.forEach((id, at) => {
			if (at > 0) out.push(span("  ", "dim"));
			const label = stepLabel(id);
			if (shown.disabled !== undefined) out.push(span(label, "dim"));
			else if (id === shown.value) out.push(span(`[${label}]`, `strong ${levelTone(id) ?? "accent"}`));
			else out.push(span(label, "muted"));
		});
		return out;
	};

	/** The provider chips, a window of them that keeps the active one in view within `room` cells. */
	const scopeRow = (room: number): Span[] | undefined => {
		if (providers.length < 2) return undefined;
		const chips = [{ id: ALL_SCOPE, label: ALL_LABEL }, ...providers.map(provider => ({ id: `${PROVIDER_SCOPE}${provider}`, label: provider }))];
		const active = Math.max(0, chips.findIndex(chip => chip.id === scope()));
		const widthOf = (from: number, to: number): number =>
			chips.slice(from, to).reduce((sum, chip, at) => sum + visibleWidth(chip.label) + 2 + (at > 0 ? 3 : 0), 0);
		let start = 0;
		while (start < active && widthOf(start, active + 1) + 2 > room) start++;
		let end = active + 1;
		while (end < chips.length && widthOf(start, end + 1) + (end + 1 < chips.length ? 2 : 0) <= room) end++;
		const out: Span[] = [];
		if (start > 0) out.push(span("‹ ", "dim"));
		chips.slice(start, end).forEach((chip, at) => {
			if (at > 0) out.push(span(" · ", "dim"));
			out.push(chip.id === scope() ? span(` ${chip.label} `, "strong accent inverse") : span(` ${chip.label} `, "muted"));
		});
		if (end < chips.length) out.push(span(" ›", "dim"));
		return out;
	};

	const searchRow = (): Span[] => {
		const q = query();
		const at = Math.min(cursor(), q.length);
		const out: Span[] = [span("> ", "accent")];
		if (q.length === 0) {
			out.push(span(" ", "inverse"), span(SEARCH_PLACEHOLDER, "muted"));
			return out;
		}
		const next = nextPoint(q, at);
		out.push(span(q.slice(0, at)));
		out.push(span(at < q.length ? q.slice(at, next) : " ", "inverse"));
		if (at < q.length) out.push(span(q.slice(next)));
		return out;
	};

	const rowTexts = computed(() => {
		const out: Record<string, Span[]> = {};
		for (const { entry, hits } of matches()) {
			const { info } = entry;
			const text: Span[] = [];
			let from = 0;
			for (const [start, end] of hits) {
				if (start > from) text.push(span(info.selector.slice(from, start)));
				text.push(span(info.selector.slice(start, end), "strong underline"));
				from = end;
			}
			if (from < info.selector.length) text.push(span(info.selector.slice(from)));
			if (info.selector === current?.selector) text.push(span(" (현재)", "muted"));
			const facts = [info.name !== info.id ? info.name : undefined, info.contextWindow !== null ? compactTokens(info.contextWindow) : undefined, info.pricingKnown ? `${dollars(info.cost.input)}/${dollars(info.cost.output)}` : undefined].filter(
				(part): part is string => part !== undefined,
			);
			if (facts.length > 0) text.push(span(`  ${facts.join(" · ")}`, "dim"));
			out[info.selector] = text;
		}
		return out;
	});

	const listRows = (): number => Math.max(4, Math.min(14, Math.floor(ui.size().rows * 0.45) - 8));

	const term = () => {
		const room = Math.max(10, ui.size().columns - 4);
		const heads: Array<Span[] | undefined> = [statusRow(), stepsRow(), scopeRow(room), searchRow()];
		const hint = `${HINT_TEXT} · ${HINT_SEARCH}`;
		return {
			head: heads.filter((row): row is Span[] => row !== undefined),
			// The search row above carries the caret; the sheet's own `> query` row would repeat it.
			search: false,
			rows: rowTexts(),
			maxRows: listRows(),
			hint: truncate(hint, room, "…"),
			empty: entries.length === 0 ? EMPTY_CATALOG_TEXT : NO_MATCH_TEXT,
		};
	};

	const level = () => {
		const shown = slider();
		if (shown === undefined) return null;
		const provider = highlighted()?.info.provider;
		return {
			label: "Thinking",
			steps: shown.steps.map(id => ({ id, label: stepLabel(id) })),
			value: shown.value,
			...(provider !== undefined ? { detail: provider } : {}),
			icon: "brain",
			keys: ["left", "right"],
			...(shown.disabled !== undefined ? { disabled: shown.disabled } : {}),
		};
	};

	return h("picker", {
		title: `Storm 모델 선택 · ${title}`,
		subtitle: () => {
			const line = statusLine();
			return [span(line, catalogError !== undefined ? "error" : refusal() !== undefined ? "warning" : "muted")];
		},
		icon: "cpu",
		noun: "models",
		size: "md",
		search: "head",
		layout: "rows",
		preview: "none",
		placeholder: SEARCH_PLACEHOLDER,
		...(providers.length > 1 ? { scopes } : {}),
		scope: () => scope(),
		scopeStyle: "rail",
		query: () => query(),
		cursor: () => cursor(),
		columns,
		items,
		order: listedIds,
		hits: () => hitsById(),
		selected: () => selected(),
		...(current !== undefined && byId.has(current.selector) ? { current: [current.selector] } : {}),
		total: entries.length,
		level,
		empty: entries.length === 0 ? EMPTY_CATALOG_TEXT : NO_MATCH_TEXT,
		actions: [
			{ id: "confirm", label: "선택", keys: ["enter"], primary: true },
			{ id: "close", label: "취소", keys: ["esc"], end: true },
		],
		term,
		onKey,
		onPaste: paste => {
			const text = singleLine(paste.text);
			if (text.length > 0) insert(text);
			return true;
		},
		onSelect: id => highlight(id),
		onActivate: id => choose(id),
		onAction: (act, event) => {
			switch (act) {
				case "close":
					done(undefined);
					return;
				case "confirm": {
					const id = selected.peek();
					if (id !== null) choose(id);
					return;
				}
				case "scope":
					if (event.value !== undefined) setScope(event.value);
					return;
				case "level":
					setEffort(event.value);
					return;
			}
		},
	});
}
