/**
 * Semantic rich lines for Storm's transcript frames and overlays, as nodes.
 *
 * Producer-provided {@link InfoLine}s replace one standalone Markdown logical line each. This module is the one
 * phase conversion every surface uses: unannotated runs stay Markdown (an `md` node), annotated lines draw as theme
 * token spans with an optional meter (`progress` node). Nothing here parses Markdown. The data half (blocks, sections,
 * normalization) is pure; the node half builds through `kit.ts`.
 *
 * Owner: slice B. Callers elsewhere use only {@link infoFrame}, {@link infoLineNode}, {@link infoSections} and
 * {@link infoSymbol}; keep their signatures.
 */
import type { ExtensionRender } from "@oh-my-pi/pi-coding-agent";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { activeTheme, h, type JSXNode, singleLine, span, type Span, symbolOf, type Theme, type UiNode } from "../tui/kit.ts";
import type { InfoLine, InfoSpan, InfoTone } from "../types.ts";

/** Default text token of a custom message body. */
const BODY_TEXT = "customMessageText";
/**
 * Widest a native host draws a line's meter. The terminal's `progress` painter sizes its own bar (a third of the width,
 * at most 24 cells) and its `col` ignores size bounds, so there the bar is up to 24 cells where the old one was 8.
 */
const METER_CELLS = 24;

/** A run of unannotated Markdown. */
export interface InfoProseBlock {
	readonly kind: "prose";
	readonly text: string;
}

/** One or more consecutive annotated logical lines. */
export interface InfoRichBlock {
	readonly kind: "rich";
	readonly lines: readonly InfoLine[];
}

export type InfoBlock = InfoProseBlock | InfoRichBlock;

type Section = NonNullable<InfoLine["section"]>;

/** The theme symbols Storm's status hierarchy uses; anything else from a producer is not a trusted icon. */
const INFO_SYMBOLS: Readonly<Record<string, true>> = {
	"status.info": true,
	"status.success": true,
	"status.warning": true,
	"status.error": true,
	"status.pending": true,
	"status.enabled": true,
	"status.running": true,
	"status.shadowed": true,
	"context.content": true,
};

function knownSymbol(icon: unknown): string | undefined {
	return typeof icon === "string" && INFO_SYMBOLS[icon] === true ? icon : undefined;
}

/** Resolve a producer's icon through the theme's preset; unknown keys and empty glyphs render nothing. */
export function infoSymbol(theme: Theme, icon: unknown): string | undefined {
	const key = knownSymbol(icon);
	if (key === undefined) return undefined;
	const glyph = singleLine(sanitizeText(symbolOf(theme, key)));
	return glyph.length > 0 ? glyph : undefined;
}

/** The icon takes the line's emphasis or the first semantic tone, never an unrelated one. */
function iconTone(line: InfoLine): InfoTone | undefined {
	if (line.emphasis === "action") return "warning";
	const semantic = line.spans.find(run => run.tone !== undefined)?.tone;
	if (line.emphasis === "title") return semantic ?? "accent";
	return semantic;
}

/** Split a sectional report before rendering, keeping repeated slices of a section in source order. */
export function infoSections(markdown: string, info: readonly InfoLine[] | undefined) {
	if (!info?.some(line => line.section !== undefined)) return undefined;
	const source = markdown.split("\n");
	const annotations = new Map<number, InfoLine>();
	let marked = false;
	for (const line of info) {
		const { index } = line;
		if (!Number.isInteger(index) || index < 0 || index >= source.length || annotations.has(index)) continue;
		annotations.set(index, line);
		if (line.section !== undefined) marked = true;
	}
	if (!marked) return undefined;

	const sections = new Map<Section, { lines: string[]; info: InfoLine[] }>();
	let section: Section = "overview";
	let slice: { lines: string[]; info: InfoLine[] } | undefined;
	for (let index = 0; index < source.length; index++) {
		const line = annotations.get(index);
		if (slice === undefined || (line?.section !== undefined && line.section !== section)) {
			section = line?.section ?? section;
			slice = sections.get(section);
			if (slice === undefined) {
				slice = { lines: [], info: [] };
				sections.set(section, slice);
			}
		}
		if (line !== undefined) slice.info.push({ ...line, index: slice.lines.length });
		slice.lines.push(source[index]!);
	}
	return sections;
}

function isTone(value: unknown): value is InfoTone {
	return value === "accent" || value === "success" || value === "warning" || value === "error" || value === "muted";
}

/**
 * Validate and sanitize the producer's annotations: indexes outside the Markdown, duplicates, blank span sets and
 * non-finite meters are dropped, so a bad annotation falls back to the line's plain Markdown rather than hiding it.
 */
function normalizedInfo(markdown: string, info: readonly InfoLine[] | undefined): Map<number, InfoLine> {
	const count = markdown.split("\n").length;
	const byIndex = new Map<number, InfoLine>();
	for (const line of info ?? []) {
		const index = line.index;
		if (!Number.isInteger(index) || index < 0 || index >= count || byIndex.has(index)) continue;
		const spans: InfoSpan[] = [];
		for (const run of line.spans) {
			// Escape-free, single-line producer text: sanitize again at the render boundary.
			const spanText = singleLine(sanitizeText(run.text));
			if (spanText.length === 0) continue;
			const tone = run.tone;
			spans.push(isTone(tone) ? { text: spanText, tone } : { text: spanText });
		}
		if (spans.length === 0) continue;
		const meter =
			line.meter && Number.isFinite(line.meter.fraction)
				? {
						fraction: Math.min(1, Math.max(0, line.meter.fraction)),
						tone: isTone(line.meter.tone) ? line.meter.tone : "muted",
					}
				: undefined;
		const emphasis = line.emphasis === "title" || line.emphasis === "action" ? line.emphasis : undefined;
		const icon = knownSymbol(line.icon);
		byIndex.set(index, { index, spans, ...(meter && { meter }), ...(icon && { icon }), ...(emphasis && { emphasis }) });
	}
	return byIndex;
}

/**
 * The pure phase conversion: split the source at annotated logical lines. Consecutive annotated lines become one
 * rich block; everything else stays exact Markdown source. Whitespace-only runs are dropped.
 */
export function infoBlocks(markdown: string, info: readonly InfoLine[] | undefined): readonly InfoBlock[] {
	const byIndex = normalizedInfo(markdown, info);
	if (byIndex.size === 0) return markdown.length === 0 ? [] : [{ kind: "prose", text: markdown }];
	const lines = markdown.split("\n");
	const blocks: Array<InfoProseBlock | { kind: "rich"; lines: InfoLine[] }> = [];
	let prose: string[] = [];
	const flush = (): void => {
		if (prose.length === 0) return;
		const source = prose.join("\n");
		prose = [];
		if (source.trim().length > 0) blocks.push({ kind: "prose", text: source });
	};
	for (let index = 0; index < lines.length; index++) {
		const line = byIndex.get(index);
		if (line === undefined) {
			prose.push(lines[index]!);
			continue;
		}
		flush();
		const last = blocks.at(-1);
		if (last?.kind === "rich") last.lines.push(line);
		else blocks.push({ kind: "rich", lines: [line] });
	}
	flush();
	return blocks;
}

/**
 * The spans of one annotated line, with the icon resolved through `theme`. An untoned run takes the body colour of
 * a custom message (as Markdown does), an emphasised line is bold throughout, and an action line defaults to warning.
 */
function lineSpans(line: InfoLine, theme: Theme, lead: readonly InfoSpan[]): Span[] {
	const defaultTone = line.emphasis === "action" ? "warning" : BODY_TEXT;
	const icon = infoSymbol(theme, line.icon);
	return [
		...(icon === undefined ? [] : [span(icon, iconTone(line) ?? BODY_TEXT), span(" ")]),
		...[...lead, ...line.spans].map(run => {
			const tone = run.tone ?? defaultTone;
			return span(run.text, line.emphasis === undefined ? tone : `${tone} strong`);
		}),
	];
}

/**
 * One annotated line: semantic spans with a determinate progress bar directly beneath. The icon follows theme switches.
 * The bar sits on its own row rather than beside the text: the host wraps text itself, and a bar placed beside text it
 * cannot measure would squeeze or clip the words on a narrow terminal.
 *
 * A separate function from {@link infoLineNode} so `lines.map(infoLineNode)` keeps working (`map` passes an index).
 * `lead` is drawn after the icon and before the line's own spans (the one-fact row's "Storm · "); it takes the line's
 * emphasis but never decides the icon's tone, which stays the line's own.
 */
export function infoLeadNode(line: InfoLine, lead: readonly InfoSpan[]): UiNode {
	const body = h("text", { spans: () => lineSpans(line, activeTheme(), lead), wrap: "word" });
	if (!line.meter) return body;
	const percent = `${Math.round(line.meter.fraction * 100)}%`;
	const meter = h("progress", { value: line.meter.fraction, tone: line.meter.tone, aria: percent, max: { w: `${METER_CELLS}ch` } });
	return h("col", {}, body, meter);
}

/** One annotated line, as {@link infoLeadNode} with nothing leading it. */
export function infoLineNode(line: InfoLine): UiNode {
	return infoLeadNode(line, []);
}

/** The body children of a frame: `md` for prose runs, one `col` of lines per rich run. */
export function infoBody(blocks: readonly InfoBlock[]): JSXNode[] {
	const out: JSXNode[] = [];
	for (const block of blocks) {
		if (block.kind === "prose") {
			if (block.text.length > 0) out.push(h("md", { text: block.text }));
		} else out.push(h("col", {}, ...block.lines.map(infoLineNode)));
	}
	return out;
}

/**
 * Storm's frame: omp's custom-message card headed by Storm's mark and `tag`, with the rich body. Used by the report
 * renderer, the context panel and the overlays. The fallback draws the annotations as spans and the rest as Markdown.
 */
export function infoFrame(tag: string, markdown: string, info: readonly InfoLine[] | undefined, icon?: string): ExtensionRender {
	const head = [span(icon === undefined ? tag : `${icon} ${tag}`, "customMessageLabel strong")];
	// No `role="omp.custom"` on this card: omp paints that role as the old message frame, which draws only the head and the
	// first `md` child. The transcript already wraps extension output in a `col role="omp.custom"` (one cell in, no frame).
	return h("card", { head }, ...infoBody(infoBlocks(markdown, info)));
}
