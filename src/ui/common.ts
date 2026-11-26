/**
 * Constants and one helper shared by the surfaces in `src/ui/`. Imports nothing from the host. Frozen foundation file:
 * a slice that needs another shared name asks for it rather than editing this file while others read it.
 */
import { visible } from "../view/render.ts";

/** The `customType` of every Storm transcript message. */
export const REPORT_TYPE = "storm-report";
/**
 * Storm's mark on its frames. 🌀 is emoji-presentation and two cells everywhere; 🌪 defaults to text
 * presentation, so terminals that ignore VS16 (tmux among them) draw it one cell wide and break the frame border.
 */
export const REPORT_ICON = "🌀";
/** Storm's frame heading; a title that already names Storm does not repeat it. */
export const frameTag = (title: string): string => (title.startsWith("Storm") ? title : `Storm · ${title}`);
/** Offered when a choice's context does not fit above the selector, so nothing is decided unseen. */
export const FULL_VIEW = "전체 내용 보기";
/** A row's label and detail are config-derived text, so both cross this boundary on one safe line. */
export const rowText = (text: string): string => visible(text.replace(/[\r\n\t]+/g, " ")).trim();

/** Puts a record in the transcript, never sent to the model. The fallback every surface may use when it cannot draw. */
export type Transcript = (title: string, markdown: string, details?: unknown) => void;
