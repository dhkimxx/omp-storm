/**
 * One choice list with a description per row, and the labels other hosts get for the same rows.
 *
 * The TUI list is an overlay: a card titled with the question, an optional context panel above the same list (cut to
 * what the list leaves, with a row that opens the whole context when it was cut), the rows with their descriptions and
 * a hint. Esc cancels and Enter chooses. Where Storm's terminal looks cannot be registered the list is the plain path.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { h, type JSXNode, type KeyEvent, nativeRendering, signal, span, wrap } from "../tui/kit.ts";
import type { UiChoiceRow, UiContext } from "../types.ts";
import { FULL_VIEW, rowText, type Transcript } from "./common.ts";
import { estimateRows, panelNode, PANEL_MIN_ROWS } from "./context-panel.ts";
import { OVERLAY_SHARE, openReport } from "./report-view.ts";
import { ROWS_ROLE, type WindowTerm, type WindowView, windowingAvailable } from "./window.ts";

/** The labels other hosts get: unique, human, and carrying the detail the TUI draws beside the label. */
export function offeredRowLabels(rows: readonly UiChoiceRow[]): { labels: string[]; values: Map<string, string> } {
	const labels: string[] = [];
	const values = new Map<string, string>();
	for (const row of rows) {
		const label = rowText(row.label) || rowText(row.value) || "항목";
		const detail = row.description === undefined ? "" : rowText(row.description);
		const base = detail.length > 0 ? `${label} — ${detail}` : label;
		let offered = base;
		for (let n = 2; values.has(offered); n++) offered = `${base} (${n})`;
		labels.push(offered);
		values.set(offered, row.value);
	}
	return { labels, values };
}

/** One plain select: labels carry the detail because other hosts draw no row descriptions. Resolves to the row's value. */
export async function selectRowsPlain(
	ctx: ExtensionContext,
	title: string,
	rows: readonly UiChoiceRow[],
	context: Omit<UiContext, "consent"> | undefined,
	transcript: Transcript,
): Promise<string | undefined> {
	const offered = offeredRowLabels(rows);
	if (context) transcript(context.title, context.markdown);
	const answer = await ctx.ui.select(title, offered.labels);
	return answer === undefined ? undefined : offered.values.get(answer);
}

const FULL_VIEW_KEY = "storm-full-view";
const FULL_VIEW_ESCAPE = Symbol("storm-full-view");
type RowAnswer = string | typeof FULL_VIEW_ESCAPE | undefined;
/** Rows around the list: the card's two edges and the hint. */
const CHROME_ROWS = 3;
const HINT = "↑↓ 이동 · Enter 선택 · Esc 취소";

interface Entry {
	readonly value: string;
	readonly label: string;
	readonly detail: string;
}

/** The overlay's node tree. `done` closes it with the answer. */
function rowsView(
	ui: { size(): { readonly columns: number; readonly rows: number } },
	title: string,
	rows: readonly UiChoiceRow[],
	context: Omit<UiContext, "consent"> | undefined,
	done: (answer: RowAnswer) => void,
): JSXNode {
	const items: Entry[] = rows.map(row => ({
		value: row.value,
		label: rowText(row.label) || rowText(row.value) || "항목",
		detail: row.description === undefined ? "" : rowText(row.description),
	}));
	const overlayRows = (): number => Math.max(8, Math.floor(ui.size().rows * OVERLAY_SHARE));
	// The focused row may wrap its detail onto more rows; reserve that room so the window cannot clip it.
	const widest = (): number =>
		items.reduce((most, item) => Math.max(most, item.detail.length === 0 ? 1 : wrap(item.detail, Math.max(1, ui.size().columns - 8)).length), 1);
	const wanted = (): number => items.length + widest() + (context === undefined ? 0 : 1);
	const listRows = (): number =>
		Math.max(1, Math.min(wanted(), overlayRows() - CHROME_ROWS - (context === undefined ? 0 : PANEL_MIN_ROWS)));
	const panelRows = (): number => Math.max(PANEL_MIN_ROWS, overlayRows() - listRows() - CHROME_ROWS);

	// Whether the context was cut: only then the list offers the row that opens it whole.
	const cut = signal(
		context !== undefined && nativeRendering() ? estimateRows(context.markdown, ui.size().columns) > panelRows() : false,
	);
	const entries = (): Entry[] => (cut() ? [...items, { value: FULL_VIEW_KEY, label: FULL_VIEW, detail: "" }] : items);
	const selected = signal(items[0]!.value);
	const choose = (value: string): void => done(value === FULL_VIEW_KEY ? FULL_VIEW_ESCAPE : value);

	let shown: WindowView = { total: 0, viewport: 1, start: 0 };
	const move = (to: (at: number, count: number) => number): void => {
		const all = entries();
		const at = Math.max(0, all.findIndex(entry => entry.value === selected.peek()));
		selected.set(all[Math.max(0, Math.min(all.length - 1, to(at, all.length)))]!.value);
	};
	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		switch (key.id) {
			case "escape":
				done(undefined);
				return true;
			case "enter":
				choose(selected.peek());
				return true;
			case "up":
				move((at, count) => (at - 1 + count) % count);
				return true;
			case "down":
				move((at, count) => (at + 1) % count);
				return true;
			case "home":
				move(() => 0);
				return true;
			case "end":
				move((_at, count) => count - 1);
				return true;
			case "pageUp":
				move(at => at - Math.max(1, shown.viewport - 1));
				return true;
			case "pageDown":
				move(at => at + Math.max(1, shown.viewport - 1));
				return true;
			default:
				return false;
		}
	};

	const term = (): WindowTerm => ({
		role: ROWS_ROLE,
		rows: listRows(),
		follow: selected(),
		report: view => {
			shown = view;
		},
	});
	const list = h(
		"list",
		{
			selected: () => selected(),
			term,
			onSelect: (item: string) => selected.set(item),
			onActivate: (item: string) => choose(item),
		},
		() =>
			entries().map(entry =>
				h("item", { key: entry.value, label: entry.label, ...(entry.detail.length > 0 && { detail: entry.detail }) }),
			),
	);
	const panel =
		context === undefined
			? undefined
			: panelNode(context, panelRows, view => {
					// The painter reports from inside a paint: the list reacts on the next turn, not in this one.
					const next = view.total > view.viewport;
					if (next !== cut.peek()) queueMicrotask(() => cut.set(next));
				});
	const hint = h("text", { spans: [span(HINT, "dim")], wrap: "none", truncate: "end" });
	return h("col", { onKey }, h("card", { head: title }, ...(panel === undefined ? [] : [panel]), list, hint));
}

/**
 * The TUI list: an overlay with each row's description, an optional context panel above the same list, and a full-view
 * row when the context is cut. Resolves to the chosen row's `value`, or undefined on cancel.
 */
export async function selectRowsView(
	ctx: ExtensionContext,
	title: string,
	rows: readonly UiChoiceRow[],
	context: Omit<UiContext, "consent"> | undefined,
	transcript: Transcript,
): Promise<string | undefined> {
	if (!windowingAvailable()) return selectRowsPlain(ctx, title, rows, context, transcript);
	for (;;) {
		const answer = await ctx.ui.custom<RowAnswer>((ui, _theme, _keys, done) => rowsView(ui, title, rows, context, done), { overlay: true });
		if (answer !== FULL_VIEW_ESCAPE) return answer;
		// Only a cut context offers this row; the whole content stays one linear report, then the list returns.
		if (context === undefined) return undefined;
		await openReport(ctx, { title: context.title, markdown: context.markdown, info: context.info, sectional: false }, transcript);
	}
}
