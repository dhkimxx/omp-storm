/**
 * Semantic rich lines for Storm's TUI surfaces.
 *
 * Producer-provided {@link InfoLine}s replace one standalone Markdown logical line each. This module is the one
 * phase conversion both renderers use: unannotated runs stay Markdown (the existing ANSI renderer, or a native
 * `md` node), while annotated lines draw as theme-token spans with an optional static meter. Nothing here parses
 * Markdown, and nothing carries ANSI into the native path.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	Box,
	type Component,
	Container,
	getMarkdownTheme,
	getThemeEpoch,
	Markdown,
	Spacer,
	type SymbolKey,
	Text,
	singleLine,
	theme,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { card, col, md, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { InfoLine, InfoSpan, InfoTone } from "../types.ts";

/** Cells in the ANSI meter's track (excluding its brackets). */
const METER_CELLS = 8;
/** Default text token of a custom message body, matching FramedMessageComponent's Markdown. */
const BODY_TEXT = "customMessageText";

/** A run of unannotated Markdown, rendered by the existing Markdown renderer in both paths. */
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
const INFO_SYMBOLS: Partial<Record<SymbolKey, true>> = {
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

function knownSymbol(icon: unknown): SymbolKey | undefined {
	return typeof icon === "string" && INFO_SYMBOLS[icon as SymbolKey] === true ? (icon as SymbolKey) : undefined;
}

/** Resolve a producer's icon through the active preset; unknown keys and empty glyphs render nothing. */
export function infoSymbol(icon: unknown): string | undefined {
	const key = knownSymbol(icon);
	if (key === undefined) return undefined;
	const glyph = singleLine(sanitizeText(theme.symbol(key)));
	return glyph.length > 0 ? glyph : undefined;
}

/** The icon takes the line's emphasis or the first semantic tone, never an unrelated one. */
function iconTone(line: InfoLine): InfoTone | undefined {
	if (line.emphasis === "action") return "warning";
	const semantic = line.spans.find(span => span.tone !== undefined)?.tone;
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
 * rich block; everything else stays exact Markdown source. Whitespace-only runs are dropped (they carry no visible
 * content and would otherwise become stray native nodes).
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

/** The static ANSI meter: filled cells in the line's tone, empty cells muted, no shimmer or label. */
export function renderMeterAnsi(meter: NonNullable<InfoLine["meter"]>, width = METER_CELLS + 2): string {
	const cells = Math.max(1, Math.min(METER_CELLS, Math.floor(Math.max(1, width - 2))));
	const filled = Math.round(Math.min(1, Math.max(0, meter.fraction)) * cells);
	return `${theme.fg("muted", "[")}${theme.fg(meter.tone, "█".repeat(filled))}${theme.fg("muted", "░".repeat(cells - filled))}${theme.fg("muted", "]")}`;
}

/** ANSI rows for one annotated logical line: themed spans, then a meter that fits beside them or on its own row. */
export function renderInfoLine(line: InfoLine, width: number): readonly string[] {
	const safe = Math.max(1, width);
	const defaultTone = line.emphasis === "action" ? "warning" : BODY_TEXT;
	const icon = infoSymbol(line.icon);
	let source = icon === undefined ? "" : `${theme.fg(iconTone(line) ?? BODY_TEXT, icon)} `;
	for (const run of line.spans) {
		const styled = line.emphasis === undefined ? run.text : theme.bold(run.text);
		source += theme.fg(run.tone ?? defaultTone, styled);
	}
	const rows = [...wrapTextWithAnsi(source, safe)];
	if (!line.meter) return rows.length === 0 ? [""] : rows;
	const meter = renderMeterAnsi(line.meter, safe);
	const last = rows.length - 1;
	if (last >= 0 && visibleWidth(rows[last]!) + 2 + visibleWidth(meter) <= safe) rows[last] = `${rows[last]}  ${meter}`;
	else rows.push(meter);
	return rows;
}

/** One native annotated line: semantic spans with a determinate progress bar directly beneath. */
export function describeInfoLine(line: InfoLine): NativeNode {
	const defaultTone = line.emphasis === "action" ? "warning" : BODY_TEXT;
	const icon = infoSymbol(line.icon);
	const body = text(
		[
			...(icon === undefined ? [] : [span(icon, iconTone(line) ?? BODY_TEXT), span(" ")]),
			...line.spans.map(run => span(run.text, line.emphasis === undefined ? run.tone : `${run.tone ?? defaultTone} strong`)),
		],
		{ wrap: "word" },
	);
	if (!line.meter) return body;
	const percent = `${Math.round(line.meter.fraction * 100)}%`;
	const meter = node("progress", { value: line.meter.fraction, tone: line.meter.tone, aria: percent });
	return col([body, meter]);
}

/** Native children for the same phase-converted body. */
export function describeInfoBlocks(blocks: readonly InfoBlock[]): NativeNode[] {
	const out: NativeNode[] = [];
	for (const block of blocks) {
		if (block.kind === "prose") {
			if (block.text.length > 0) out.push(md(block.text));
		} else out.push(col(block.lines.map(describeInfoLine)));
	}
	return out;
}

/** ANSI body: Markdown for unannotated runs, wrapped theme spans for annotated lines. */
class InfoBody extends Container {
	constructor(blocks: readonly InfoBlock[]) {
		super();
		for (const block of blocks) {
			if (block.kind === "prose") {
				if (block.text.length === 0) continue;
				this.addChild(new Markdown(block.text, 0, 0, getMarkdownTheme(), { color: value => theme.fg(BODY_TEXT, value) }));
			} else this.addChild(new RichLines(block.lines));
		}
	}
}

class RichLines implements Component {
	#cache: { width: number; epoch: number; rows: readonly string[] } | undefined;

	constructor(private readonly lines: readonly InfoLine[]) {}

	render(width: number): readonly string[] {
		const safe = Math.max(1, width);
		const epoch = getThemeEpoch();
		if (this.#cache?.width === safe && this.#cache.epoch === epoch) return this.#cache.rows;
		const rows: string[] = [];
		for (const line of this.lines) rows.push(...renderInfoLine(line, safe));
		this.#cache = { width: safe, epoch, rows };
		return rows;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	releaseRenderCaches(): void {
		this.#cache = undefined;
	}
}

/**
 * Storm's report/panel frame with a rich body. ANSI keeps the existing custom-message frame (border, background,
 * icon and heading); Tern gets the matching native card, semantic spans and progress nodes.
 */
export class RichFrame extends Container {
	readonly #box: Box;
	readonly #native: NativeNode;

	constructor(tag: string, markdown: string, info?: readonly InfoLine[], icon?: string) {
		super();
		const blocks = infoBlocks(markdown, info);
		this.#native = card({ role: "omp.custom", head: [span(tag, "customMessageLabel strong")] }, describeInfoBlocks(blocks));
		this.#box = new Box(1, 1, value => theme.bg("customMessageBg", value));
		this.#box.setIgnoreTight(true);
		this.#applyTheme();
		const header = new Text(icon === undefined ? tag : `${icon} ${tag}`, 0, 0);
		header.setStyleFn(value => theme.fg("customMessageLabel", theme.bold(value)));
		this.#box.addChild(header);
		this.#box.addChild(new Spacer(1));
		this.#box.addChild(new InfoBody(blocks));
		this.addChild(this.#box);
	}

	#applyTheme(): void {
		this.#box.setBgFn(value => theme.bg("customMessageBg", value));
		this.#box.setBorder({ chars: theme.boxRound, color: value => theme.fg("borderMuted", value) });
	}

	override describe(_cx: DescribeContext): NativeNode {
		return this.#native;
	}

	override invalidate(): void {
		this.#applyTheme();
		super.invalidate();
	}
}
