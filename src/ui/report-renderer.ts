/**
 * Draws Storm's transcript records. The validated closeout is either one inline fact or a structured frame with its
 * title once; old and malformed records keep a plain frame. Nothing here persists anything: the renderer is called
 * again whenever the host redraws the message.
 *
 * Owner: slice B. Keep `registerReportRenderer(pi)`.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { activeTheme, h, span, visibleWidth } from "../tui/kit.ts";
import { readCloseoutRecord } from "../view/closeout.ts";
import { frameTag, REPORT_ICON, REPORT_TYPE, rowText } from "./common.ts";
import { infoFrame, infoLeadNode, infoSymbol } from "./info-node.ts";

/** The lead that names a one-fact row as Storm's. */
const FACT_LEAD = "Storm · ";
/**
 * Columns a one-fact row may take with its lead: Storm's narrowest supported terminal (60) less the transcript's one
 * cell of indent. A renderer is not told the width, so the rule needs none: a fact whose named line is wider than this
 * loses the lead (the icon still marks the row as Storm's), and keeps one row at 60 columns. On a wider terminal a fact
 * that would still have fit loses its name too; that is accepted.
 */
export const FACT_ROOM = 59;

/** The text of a message's content, which is a string or a list of content blocks. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
}

/** Splits the `### title` line `transcript()` puts first from the rest; text that does not start so keeps its all. */
function splitTitle(text: string): { title: string | undefined; body: string } {
	const match = /^### ([^\n]+)\n*/.exec(text);
	if (match === null) return { title: undefined, body: text };
	const title = rowText(match[1]!);
	return title === "" ? { title: undefined, body: text } : { title, body: text.slice(match[0].length) };
}

export function registerReportRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(REPORT_TYPE, message => {
		const closeout = readCloseoutRecord(message.content, message.details);
		if (closeout !== undefined) {
			const [only] = closeout.info;
			if (only !== undefined && closeout.info.length === 1) {
				// One fact is one row, led by Storm's name while the named row fits the narrowest terminal Storm supports.
				const icon = infoSymbol(activeTheme(), only.icon);
				const named = (icon === undefined ? 0 : visibleWidth(icon) + 1) + visibleWidth(FACT_LEAD) + visibleWidth(only.spans.map(run => run.text).join(""));
				return infoLeadNode(only, named <= FACT_ROOM ? [{ text: FACT_LEAD, tone: "muted" }] : []);
			}
			return infoFrame(frameTag(rowText(closeout.title)), closeout.markdown, closeout.info, REPORT_ICON);
		}
		// Old and malformed records: the message's own text in Storm's frame. `transcript()` writes `### title` first; the
		// host's Markdown draws the hashes literally, so the title goes into the frame's head and the rest is the body.
		const { title, body } = splitTitle(contentText(message.content));
		return h(
			"card",
			{ head: [span(`${REPORT_ICON} ${title === undefined ? "Storm" : frameTag(title)}`, "customMessageLabel strong")] },
			h("md", { text: body }),
		);
	});
}
