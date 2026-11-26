/**
 * A choice's context shown above the selector while an `ctx.ui.select` is open, cut to the rows the selector leaves
 * free. The select flow in `ui.ts` mounts it, asks whether it was cut, opens the select, then clears it.
 *
 * omp builds a widget lazily, when the dock mounts it, so the panel measures itself while it is painted: Storm's
 * `storm.cut` role reports the content's rows at the real width, and {@link showContextPanel} resolves on that first
 * report. A panel that never reports (no windowing, a host that did not mount it in time) counts as cut, so the flow
 * holds back the options that accept what it would have shown and offers 「전체 내용 보기」 first: nothing is ever
 * decided unseen. Rows are cut, not source lines; the frame keeps its head and closing edge and a note says how many
 * rows are left out.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { h, type JSXNode, nativeRendering, visibleWidth } from "../tui/kit.ts";
import type { UiContext } from "../types.ts";
import { liveWidgetRows } from "../view/live.ts";
import { FULL_VIEW, frameTag, REPORT_ICON } from "./common.ts";
import { infoFrame } from "./info-node.ts";
import { CUT_ROLE, type WindowTerm, type WindowView, windowingAvailable } from "./window.ts";

/** The widget key of the panel; the host replaces a widget set under the same key. */
export const PANEL_KEY = "storm-panel";
/** Rows a selector takes besides its options (frame, padding, key hints), plus the status line and one spare option. */
export const SELECTOR_ROWS = 11;
/** Rows below which a panel is not worth drawing. */
export const PANEL_MIN_ROWS = 6;
/** How long to wait for the dock to mount and paint the panel before treating it as cut. */
const MEASURE_TIMEOUT_MS = 1500;

/** A mounted panel. */
export interface PanelHandle {
	/** Whether the context was cut at the terminal's size: the whole of it is then only in the full view. */
	readonly cut: boolean;
	/** Removes the panel; safe to call more than once. */
	clear(): void;
}

/** The note under a cut frame: how many rows are left out and where the rest is. */
export const cutNote = (omitted: number): string => `… ${omitted}줄 생략 · 아래 「${FULL_VIEW}」`;

/**
 * A native host lays the panel out itself and never reports rows, so its height is estimated from the Markdown: every
 * line takes its wrapped rows at the frame's inner width, plus the frame. Deliberately generous: a wrong guess only
 * opens the full view once more.
 */
export function estimateRows(markdown: string, columns: number): number {
	const inner = Math.max(1, columns - 6);
	let rows = 2;
	for (const line of markdown.split("\n")) rows += Math.max(1, Math.ceil(visibleWidth(line) / inner));
	return rows;
}

/** The panel's node tree: the context's frame inside a view cut to `budget` rows. */
export function panelNode(
	context: Omit<UiContext, "consent">,
	budget: () => number,
	report: (view: WindowView) => void,
): JSXNode {
	const frame = infoFrame(frameTag(context.title), context.markdown, context.info, REPORT_ICON) as JSXNode;
	const term = (): WindowTerm => ({ role: CUT_ROLE, rows: budget(), note: cutNote, report });
	return h("col", { term, max: () => ({ h: `${budget()}lines` as const }) }, frame);
}

/**
 * Mounts `context` above the selector. `reserve` is how many rows the selector below needs, so the panel keeps the
 * rest of the terminal. Async because the panel's size is only known once the dock has painted it.
 */
export async function showContextPanel(ctx: ExtensionContext, context: Omit<UiContext, "consent">, reserve: number): Promise<PanelHandle> {
	if (!windowingAvailable()) return { cut: true, clear() {} };
	let cut = true;
	let live = true;
	const first = Promise.withResolvers<void>();
	const settle = (): void => first.resolve();
	ctx.ui.setWidget(
		PANEL_KEY,
		ui => {
			// The lane view stays below the editor while a choice is open, and the dock cuts the top of an overflow: the panel
			// is what gives way (cut to what the selector and the live widget leave), and a cut panel withholds consent.
			const budget = (): number => Math.max(PANEL_MIN_ROWS, ui.size().rows - reserve - liveWidgetRows());
			if (nativeRendering()) {
				cut = estimateRows(context.markdown, ui.size().columns) > budget();
				queueMicrotask(settle);
			}
			return panelNode(context, budget, view => {
				if (!live) return;
				cut = view.total > view.viewport;
				settle();
			});
		},
		{ placement: "aboveEditor" },
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		first.promise,
		new Promise<void>(resolve => {
			timer = setTimeout(resolve, MEASURE_TIMEOUT_MS);
		}),
	]);
	if (timer !== undefined) clearTimeout(timer);
	return {
		get cut() {
			return cut;
		},
		clear() {
			if (!live) return;
			live = false;
			ctx.ui.setWidget(PANEL_KEY, undefined);
		},
	};
}
