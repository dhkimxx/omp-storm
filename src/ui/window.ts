/**
 * The terminal looks Storm's overlays and panels need and the host's generic painters do not give: a window onto
 * content taller than its slot (scrollbar included), a frame cut to a slot with a note about what is left out, and a
 * choice list whose focused row wraps its whole detail.
 *
 * Why this exists: omp 19.2's terminal backend ignores `max.h` and `scroll` on a `col` (only the native Tern backend
 * honours them), a widget taller than the dock loses its top rows, and an overlay taller than the screen loses its
 * bottom. Measured in a real pty against omp 19.2.1. omp's own report panel scrolls through a host role painter; Storm
 * registers its own, under `storm.*` roles that cannot collide with a host role. The native backend never sees a role:
 * these are set through the terminal-only `term.role` prop, and native hosts keep `max.h` and `scroll`.
 *
 * Loading: the painters are registered through `registerRolePainters` in `kit.ts`, which imports the host's internal
 * paint module dynamically; its failure only turns the windowing off ({@link windowingAvailable}), and every surface
 * then falls back to the transcript or omp's own `select`.
 */
import {
	type Block,
	type Hit,
	type PaintContext,
	presetOf,
	registerRolePainters,
	type Theme,
	truncate,
	type UiNode,
	visibleWidth,
	wrap,
} from "../tui/kit.ts";

/** A col: shows `term.rows` rows of its children from `term.offset`, with a scrollbar column while it overflows. */
export const WINDOW_ROLE = "storm.window";
/** A col: shows its children cut to `term.rows`, keeping the last row (a frame's bottom edge) and a note. */
export const CUT_ROLE = "storm.cut";
/** A list: items drawn one per row, the focused one wrapping its detail, windowed around the focus. */
export const ROWS_ROLE = "storm.rows";

/** What a painter learns about its view each time it paints. Callers must not write a signal from inside the callback. */
export interface WindowView {
	/** Rows the content takes at the width it was painted at. */
	readonly total: number;
	/** Rows the view shows at most. */
	readonly viewport: number;
	/** First content row shown. */
	readonly start: number;
}

/** The `term` prop of a node carrying one of the roles above; set it with `role` for the terminal only. */
export type WindowTerm = {
	readonly role: typeof WINDOW_ROLE | typeof CUT_ROLE | typeof ROWS_ROLE;
	/** Most rows to show; absent: all of them. */
	readonly rows?: number;
	/** First row to show (window role); clamped to the content. */
	readonly offset?: number;
	/** Key of the child that must stay in view (window and rows roles). */
	readonly follow?: string | undefined;
	/** Reserve the last column for a scrollbar while the content overflows. */
	readonly bar?: boolean;
	/** The cut role's note: gets the number of rows left out. */
	readonly note?: (omitted: number) => string;
	readonly report?: (view: WindowView) => void;
};

const termOf = (node: UiNode): Partial<WindowTerm> => {
	const term = (node.props() as { term?: unknown }).term;
	return typeof term === "object" && term !== null ? (term as Partial<WindowTerm>) : {};
};

const empty: Block = { rows: [] };

/** Painted children with the rows each starts at. */
interface Stacked {
	readonly rows: string[];
	readonly hits: Hit[];
	/** Start row and height per child key. */
	readonly spans: Map<string, { top: number; height: number }>;
}

function stack(parts: ReadonlyArray<{ key: string | undefined; block: Block }>): Stacked {
	const rows: string[] = [];
	const hits: Hit[] = [];
	const spans = new Map<string, { top: number; height: number }>();
	for (const { key, block } of parts) {
		const top = rows.length;
		rows.push(...block.rows);
		for (const hit of block.hits ?? []) hits.push({ ...hit, row: hit.row + top });
		if (key !== undefined) spans.set(key, { top, height: block.rows.length });
	}
	return { rows, hits, spans };
}

/** The bar glyphs of a theme: same width and silhouette for track and thumb, as the old overlay kept. */
function barGlyphs(theme: Theme): { track: string; thumb: string } {
	const ascii = presetOf(theme) === "ascii";
	return {
		track: theme.fg("dim", ascii ? "|" : "│"),
		thumb: theme.style("accent strong", ascii ? "|" : "┃"),
	};
}

/**
 * Shows `[start, start + viewport)` of `stacked`, moving `start` so the child `follow` is inside. Hits move with the
 * rows and the ones that left the view are dropped.
 */
function windowOf(
	stacked: Stacked,
	width: number,
	viewport: number,
	wanted: number,
	follow: string | undefined,
	bar: boolean,
	theme: Theme,
): { block: Block; start: number } {
	const total = stacked.rows.length;
	let start = Math.max(0, Math.min(Math.floor(wanted), total - viewport));
	const span = follow === undefined ? undefined : stacked.spans.get(follow);
	if (span !== undefined) {
		if (span.top < start) start = span.top;
		else if (span.top + span.height > start + viewport) start = Math.max(0, span.top + span.height - viewport);
		start = Math.max(0, Math.min(start, total - viewport));
	}
	const shown = stacked.rows.slice(start, start + viewport);
	let rows = shown;
	if (bar) {
		const { track, thumb } = barGlyphs(theme);
		const size = Math.max(1, Math.floor((viewport * viewport) / total));
		const at = total === viewport ? 0 : Math.round((start / (total - viewport)) * (viewport - size));
		rows = shown.map((row, i) => `${row}${" ".repeat(Math.max(0, width - 1 - visibleWidth(row)))}${i >= at && i < at + size ? thumb : track}`);
	}
	const hits = stacked.hits
		.filter(hit => hit.row + hit.height > start && hit.row < start + viewport)
		.map(hit => ({ ...hit, row: hit.row - start }));
	return { block: hits.length > 0 ? { rows, hits } : { rows }, start };
}

function paintWindow(node: UiNode, cx: PaintContext): Block {
	const term = termOf(node);
	const children = node.children();
	const paintAt = (width: number) => stack(children.map(child => ({ key: child.key(), block: cx.paint(child, width) })));
	let width = cx.width;
	let stacked = paintAt(width);
	const viewport = term.rows === undefined ? undefined : Math.max(1, Math.floor(term.rows));
	if (viewport === undefined || stacked.rows.length <= viewport) {
		term.report?.({ total: stacked.rows.length, viewport: viewport ?? stacked.rows.length, start: 0 });
		return stacked.rows.length === 0 ? empty : { rows: stacked.rows, ...(stacked.hits.length > 0 && { hits: stacked.hits }) };
	}
	const bar = term.bar === true && width > 2;
	if (bar) {
		width -= 1;
		stacked = paintAt(width);
	}
	// The bar's column may have been the only thing that made it overflow.
	if (stacked.rows.length <= viewport) {
		term.report?.({ total: stacked.rows.length, viewport, start: 0 });
		return { rows: stacked.rows, ...(stacked.hits.length > 0 && { hits: stacked.hits }) };
	}
	const { block, start } = windowOf(stacked, cx.width, viewport, term.offset ?? 0, term.follow, bar, cx.theme);
	term.report?.({ total: stacked.rows.length, viewport, start });
	return block;
}

function paintCut(node: UiNode, cx: PaintContext): Block {
	const term = termOf(node);
	const stacked = stack(node.children().map(child => ({ key: undefined, block: cx.paint(child, cx.width) })));
	const total = stacked.rows.length;
	const viewport = term.rows === undefined ? undefined : Math.max(3, Math.floor(term.rows));
	if (viewport === undefined || total <= viewport) {
		term.report?.({ total, viewport: viewport ?? total, start: 0 });
		return total === 0 ? empty : { rows: stacked.rows };
	}
	// The frame keeps its head and its closing edge; what is left out is said once, under it.
	const kept = stacked.rows.slice(0, viewport - 2);
	const omitted = total - kept.length - 1;
	const note = term.note?.(omitted) ?? `… ${omitted}`;
	term.report?.({ total, viewport, start: 0 });
	return { rows: [...kept, stacked.rows[total - 1]!, cx.theme.style("muted", truncate(note, cx.width))] };
}

/** One text of a list item (a string or styled spans) as plain text. */
const plain = (text: unknown): string => {
	if (typeof text === "string") return text;
	if (Array.isArray(text)) return text.map(part => (typeof part === "object" && part !== null && "t" in part ? String(part.t) : "")).join("");
	return "";
};

/** One item as rows: `❯ label  detail` when it fits, else the label, and under the focused one its wrapped detail. */
function itemRows(props: { label?: unknown; detail?: unknown; disabled?: boolean }, selected: boolean, width: number, theme: Theme): string[] {
	const ascii = presetOf(theme) === "ascii";
	const marker = selected ? `${ascii ? ">" : "❯"} ` : "  ";
	const room = Math.max(1, width - 2);
	const label = plain(props.label);
	const detail = plain(props.detail);
	const fill = (row: string): string => `${row}${" ".repeat(Math.max(0, width - visibleWidth(row)))}`;
	const paint = (text: string): string => {
		if (!selected) return props.disabled === true ? theme.style("dim", text) : text;
		return theme.has("selectedBg") ? theme.bg("selectedBg", theme.fg("text", fill(text))) : theme.style("accent strong", text);
	};
	const both = detail.length > 0 ? `${label}  ${detail}` : label;
	if (visibleWidth(both) <= room) {
		if (selected || detail.length === 0) return [paint(`${marker}${both}`)];
		return [`${marker}${label}${theme.style("muted", `  ${detail}`)}`];
	}
	const rows = [paint(`${marker}${truncate(label, room)}`)];
	if (selected && detail.length > 0) for (const part of wrap(detail, room)) rows.push(paint(`  ${part}`));
	return rows;
}

function paintRows(node: UiNode, cx: PaintContext): Block {
	const term = termOf(node);
	const props = node.props() as { selected?: string | null; empty?: unknown };
	const items = node.children();
	if (items.length === 0) {
		const text = plain(props.empty);
		return text.length === 0 ? empty : { rows: [cx.theme.style("muted", truncate(text, cx.width))] };
	}
	const paintAt = (width: number) =>
		stack(
			items.map(item => {
				const key = item.key();
				const rows = itemRows(item.props() as Parameters<typeof itemRows>[0], key !== undefined && key === props.selected, width, cx.theme);
				const hit: Hit = { row: 0, col: 0, width, height: rows.length, node, ...(key !== undefined && { item: key }) };
				return { key, block: { rows, hits: [hit] } };
			}),
		);
	const viewport = term.rows === undefined ? undefined : Math.max(1, Math.floor(term.rows));
	let width = cx.width;
	let stacked = paintAt(width);
	if (viewport === undefined || stacked.rows.length <= viewport) {
		term.report?.({ total: stacked.rows.length, viewport: viewport ?? stacked.rows.length, start: 0 });
		return { rows: stacked.rows, hits: stacked.hits };
	}
	width -= 1;
	stacked = paintAt(width);
	const follow = typeof props.selected === "string" ? props.selected : term.follow;
	const { block, start } = windowOf(stacked, cx.width, viewport, term.offset ?? 0, follow, true, cx.theme);
	term.report?.({ total: stacked.rows.length, viewport, start });
	return block;
}

/** Whether the roles above are registered with the host: when not, every surface keeps to the transcript and `select`. */
const available = await registerRolePainters([
	["col", WINDOW_ROLE, paintWindow],
	["col", CUT_ROLE, paintCut],
	["list", ROWS_ROLE, paintRows],
]);

/** A test's switch for the host that could not load the looks; `undefined` gives the real answer back. */
let forced: boolean | undefined;
export const forceWindowing = (value: boolean | undefined): void => {
	forced = value;
};

/** Whether the terminal looks are registered; false when a later omp moved the module they need. */
export const windowingAvailable = (): boolean => forced ?? available;
