import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { FramedMessageComponent } from "@oh-my-pi/pi-tui/chrome";
import type { UiPort } from "./types.ts";

const REPORT_TYPE = "storm-report";
/**
 * Storm's mark on its report frames. 🌀 is emoji-presentation and two cells everywhere; 🌪 defaults to text
 * presentation, so terminals that ignore VS16 (tmux among them) draw it one cell wide and break the frame border.
 */
const REPORT_ICON = "🌀";

/** Draws Storm's reports in omp's own frame, headed by Storm's mark and name instead of a package glyph and the raw type. */
export function registerReportRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(
		REPORT_TYPE,
		message => new FramedMessageComponent({ message: { ...message, customType: "Storm" }, icon: REPORT_ICON, role: "omp.custom" }),
	);
}

/** Adapts omp's ctx.ui; reports go to the transcript but never to the model (P0 Q4). */
export function createUiPort(pi: ExtensionAPI, ctx: ExtensionContext): UiPort {
	return {
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		notify: (message, level = "info") => ctx.ui.notify(message, level),
		report: (title, markdown) =>
			pi.sendMessage(
				{ customType: REPORT_TYPE, content: `### ${title}\n\n${markdown}`, display: true, excludeFromContext: true },
				{ triggerTurn: false },
			),
	};
}
