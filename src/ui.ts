/**
 * Adapts omp's ctx.ui to Storm's {@link UiPort}. In the TUI, views and contexts are overlays and panels that leave
 * nothing in the transcript; other hosts cannot draw nodes, so they get transcript messages (never sent to the model).
 *
 * This file is only the assembly. Each surface lives in `src/ui/`, owned by one slice (see the port contract):
 * `report-renderer.ts`, `info-node.ts`, `context-panel.ts`, `rows-select.ts`, `report-view.ts`, `model-picker.ts`.
 * Callers elsewhere import only from here.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Effort, InfoLine, UiPort } from "./types.ts";
import { closeoutDetails } from "./view/closeout.ts";
import { FULL_VIEW, REPORT_TYPE, type Transcript } from "./ui/common.ts";
import { SELECTOR_ROWS, showContextPanel } from "./ui/context-panel.ts";
import { pickStormModel } from "./ui/model-picker.ts";
import { openReport } from "./ui/report-view.ts";
import { selectRowsPlain, selectRowsView } from "./ui/rows-select.ts";

export { registerReportRenderer } from "./ui/report-renderer.ts";

const NOTICE_TITLE = { info: "알림", warning: "경고", error: "오류" } as const;

export function createUiPort(pi: ExtensionAPI, ctx: ExtensionContext): UiPort {
	const transcript: Transcript = (title, markdown, details) => {
		pi.sendMessage(
			{
				customType: REPORT_TYPE,
				content: `### ${title}\n\n${markdown}`,
				display: true,
				excludeFromContext: true,
				...(details !== undefined && { details }),
			},
			{ triggerTurn: false },
		);
	};
	const drawsComponents = ctx.mode === "tui" && ctx.hasUI;
	const showReport = (title: string, markdown: string, info: readonly InfoLine[] | undefined, sectional: boolean): Promise<void> => {
		const tabbed = sectional && info?.some(line => line.section !== undefined) === true;
		return openReport(ctx, { title, markdown, info, sectional: tabbed }, transcript);
	};
	const report = async (title: string, markdown: string, info?: readonly InfoLine[]): Promise<void> => {
		if (!drawsComponents) {
			transcript(title, markdown);
			return;
		}
		await showReport(title, markdown, info, true);
	};
	// RPC hosts have no form surface. An ACP client without form support does have the method (omp tells extensions
	// nothing about the client's capabilities), but there it answers undefined, as its selects do: every dialog is a cancel.
	const formDialog = ctx.hasUI ? ctx.ui.formDialog?.bind(ctx.ui) : undefined;
	return {
		select: async (title, options, context) => {
			if (!context) return ctx.ui.select(title, options);
			if (!drawsComponents) {
				transcript(context.title, context.markdown);
				return ctx.ui.select(title, options);
			}
			// Whether the whole context was put on screen (the full view) during this dialog.
			let seen = false;
			for (;;) {
				const panel = await showContextPanel(ctx, context, options.length + SELECTOR_ROWS);
				let offered = options;
				if (panel.cut) {
					// A cut panel hides the end of what an accepting option covers: until the whole of it was opened,
					// those options are held back and the full view comes first.
					const held = seen ? [] : (context.consent ?? []);
					offered = held.length ? [FULL_VIEW, ...options.filter(option => !held.includes(option))] : [...options, FULL_VIEW];
				}
				let answer: string | undefined;
				try {
					answer = await ctx.ui.select(title, offered);
				} finally {
					panel.clear();
				}
				if (answer !== FULL_VIEW) return answer;
				// The whole approval stays in one linear view, regardless of the context's annotations.
				await showReport(context.title, context.markdown, context.info, false);
				seen = true;
			}
		},
		selectRows: async (title, rows, context) => {
			// An empty list has no answer; never open a surface that can only be cancelled.
			if (rows.length === 0) return undefined;
			if (!drawsComponents) return selectRowsPlain(ctx, title, rows, context, transcript);
			return selectRowsView(ctx, title, rows, context, transcript);
		},
		// Outside the TUI a notification may go nowhere (ACP only logs it), and it is the only word on how a flow ended.
		notify: (message, level = "info") => (drawsComponents ? ctx.ui.notify(message, level) : transcript(NOTICE_TITLE[level], message)),
		report,
		// Always transcript-only. A closeout's styling is persisted only when it matches the text it styles; the plain
		// content stays the whole record for RPC, ACP and any renderer that cannot use the details.
		record: (title, markdown, style) => transcript(title, markdown, closeoutDetails(markdown, style)),
		...(drawsComponents ? { pickModel: (title: string, current?: { selector: string; effort?: Effort }) => pickStormModel(ctx, title, current) } : {}),
		...(formDialog
			? {
					form: async (html: string) => {
						const answer = await formDialog(html);
						// A timeout submits the form as it stands; nobody answered, so it is a cancel.
						return answer?.timedOut ? undefined : answer?.data;
					},
				}
			: {}),
	};
}
