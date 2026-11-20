import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { UiPort } from "./types.ts";

const REPORT_TYPE = "storm-report";

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
