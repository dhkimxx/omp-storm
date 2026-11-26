/**
 * The scrollable report overlay, optionally divided into independently scrolling status tabs. It leaves nothing in
 * the transcript and resolves once closed.
 *
 * The overlay is docked to the bottom at full width without a frame, so the view caps its own height from the terminal
 * and each page carries Storm's frame. In the terminal a page scrolls through Storm's `storm.window` role (the host's
 * generic `col` ignores `max.h` and `scroll` there); native hosts keep `max.h` and a scroll request. Where the role
 * cannot be registered the report goes to the transcript instead.
 */
import type { ExtensionContext, ExtensionRender } from "@oh-my-pi/pi-coding-agent";
import { activeTheme, h, type JSXNode, type KeyEvent, type ScrollRequest, signal, span } from "../tui/kit.ts";
import type { InfoLine } from "../types.ts";
import { frameTag, REPORT_ICON, type Transcript } from "./common.ts";
import { infoFrame, infoSections, infoSymbol } from "./info-node.ts";
import { WINDOW_ROLE, type WindowTerm, type WindowView, windowingAvailable } from "./window.ts";

export interface ReportRequest {
	readonly title: string;
	readonly markdown: string;
	readonly info: readonly InfoLine[] | undefined;
	/** Whether annotated sections become tabs; an approval's full view is one linear page. */
	readonly sectional: boolean;
}

/** Share of the terminal a report overlay may take. */
export const OVERLAY_SHARE = 0.85;
const SCROLL_HINT = "↑↓ PgUp PgDn 스크롤 · Esc·Enter·q 닫기";
const TAB_HINT = `←→·Tab 탭 · ${SCROLL_HINT}`;
/** Rows a shift+arrow moves. */
const FAST_SCROLL_LINES = 5;
const REPORT_TABS = [
	{ key: "1", id: "overview", label: "1 개요", icon: "status.info" },
	{ key: "2", id: "team", label: "2 팀", icon: "status.enabled" },
	{ key: "3", id: "runtime", label: "3 런타임", icon: "status.running" },
	{ key: "4", id: "storage", label: "4 저장 공간", icon: "context.content" },
] as const;

type ScrollBy = ScrollRequest["by"];

/** The scroll a key asks for, or undefined when it is not one. `fast` is how many rows the step moves. */
function scrollOf(id: string): { by: ScrollBy; fast: boolean } | undefined {
	switch (id) {
		case "up":
			return { by: "line-up", fast: false };
		case "down":
			return { by: "line-down", fast: false };
		case "shift+up":
			return { by: "line-up", fast: true };
		case "shift+down":
			return { by: "line-down", fast: true };
		case "pageUp":
			return { by: "page-up", fast: false };
		case "pageDown":
			return { by: "page-down", fast: false };
		case "home":
			return { by: "start", fast: false };
		case "end":
			return { by: "end", fast: false };
		default:
			return undefined;
	}
}

interface Page {
	readonly id: string;
	readonly body: JSXNode;
	/** Wanted first row (terminal) and the host's own scroll request (native). */
	readonly offset: ReturnType<typeof signal<number>>;
	readonly request: ReturnType<typeof signal<ScrollRequest | undefined>>;
	/** What the last paint showed; plain fields, the painter must not write signals. */
	view: WindowView;
}

const asNode = (render: ExtensionRender): JSXNode => (typeof render === "object" && render !== null && "render" in render ? undefined : (render as JSXNode));

/** Opens the report as an overlay (TUI only). `transcript` is the fallback when it cannot draw. */
export async function openReport(ctx: ExtensionContext, request: ReportRequest, transcript: Transcript): Promise<void> {
	if (!windowingAvailable()) {
		transcript(request.title, request.markdown);
		return;
	}
	await ctx.ui.custom<void>(
		(ui, _theme, _keys, done) => {
			const sections = request.sectional ? infoSections(request.markdown, request.info) : undefined;
			const tabs = REPORT_TABS.filter(tab => sections?.has(tab.id));
			const tag = frameTag(request.title);
			const newPage = (id: string, source: string, info: readonly InfoLine[] | undefined): Page => ({
				id,
				body: asNode(infoFrame(tag, source, info, REPORT_ICON)),
				offset: signal(0),
				request: signal<ScrollRequest | undefined>(undefined),
				view: { total: 0, viewport: 1, start: 0 },
			});
			const pages =
				sections === undefined || tabs.length === 0
					? [newPage("body", request.markdown, request.info)]
					: tabs.map(tab => {
							const slice = sections.get(tab.id)!;
							return newPage(tab.id, slice.lines.join("\n"), slice.info);
						});
			const active = signal(pages[0]!.id);
			const chrome = tabs.length > 0 ? 2 : 1;
			const viewport = (): number => Math.max(1, Math.floor(ui.size().rows * OVERLAY_SHARE) - chrome);
			const current = (): Page => pages.find(page => page.id === active.peek()) ?? pages[0]!;

			const select = (id: string): boolean => {
				if (!pages.some(page => page.id === id) || id === active.peek()) return id === active.peek();
				active.set(id);
				return true;
			};
			const step = (delta: number): boolean => {
				const at = pages.findIndex(page => page.id === active.peek());
				return select(pages[(at + delta + pages.length) % pages.length]!.id);
			};
			const scroll = (by: ScrollBy, fast: boolean): void => {
				const page = current();
				const { total, viewport: rows, start } = page.view;
				const reach = Math.max(0, total - rows);
				const moves: Record<ScrollBy, number> = {
					"line-up": start - (fast ? FAST_SCROLL_LINES : 1),
					"line-down": start + (fast ? FAST_SCROLL_LINES : 1),
					"page-up": start - Math.max(1, rows - 1),
					"page-down": start + Math.max(1, rows - 1),
					start: 0,
					end: reach,
				};
				page.offset.set(Math.max(0, Math.min(moves[by], reach)));
				// The native scroller counts steps; a fast step repeats the line move.
				const n = (page.request.peek()?.n ?? 0) + (fast ? FAST_SCROLL_LINES : 1);
				page.request.set({ by, n });
			};

			const onKey = (key: KeyEvent): boolean => {
				if (key.kind === "release") return false;
				if (key.id === "escape" || key.id === "enter" || key.id === "q") {
					done();
					return true;
				}
				if (tabs.length > 0) {
					if (key.id === "right" || key.id === "tab") return step(1);
					if (key.id === "left" || key.id === "shift+tab") return step(-1);
					const tab = tabs.find(candidate => candidate.key === key.id);
					if (tab !== undefined) return select(tab.id);
				}
				const wanted = scrollOf(key.id);
				if (wanted === undefined) return false;
				scroll(wanted.by, wanted.fast);
				return true;
			};

			const strip =
				tabs.length === 0
					? undefined
					: h("tabs", {
							key: "tabs",
							items: () => tabs.map(tab => ({ id: tab.id, label: `${infoSymbol(activeTheme(), tab.icon) ?? ""}${tab.label}` })),
							active: () => active(),
							onSelect: (id: string) => {
								select(id);
							},
						});
			const bodies = pages.map(page => {
				const term = (): WindowTerm => ({
					role: WINDOW_ROLE,
					rows: viewport(),
					offset: page.offset(),
					bar: true,
					report: view => {
						page.view = view;
					},
				});
				return h(
					"col",
					{
						key: `body-${page.id}`,
						hidden: () => active() !== page.id,
						max: () => ({ h: `${viewport()}lines` as const }),
						scroll: page.request,
						term,
					},
					page.body,
				);
			});
			const hint = h("text", { spans: [span(tabs.length > 1 ? TAB_HINT : SCROLL_HINT, "dim")], wrap: "none", truncate: "end" });
			return h("col", { key: "view", onKey }, ...(strip === undefined ? [] : [strip]), ...bodies, hint);
		},
		{ overlay: true },
	);
}
