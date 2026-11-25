import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	type SelectItem,
	SelectList,
	type SelectListRenderItemContext,
	getSelectListTheme,
	getThemeEpoch,
	matchesKey,
	parseKey,
	ScrollView,
	type SgrMouseEvent,
	TabBar,
	type TUI,
	theme,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { editorKeys, FramedMessageComponent, getTabBarTheme, OverlayPanel, row, topBorder } from "@oh-my-pi/pi-tui/chrome";
import { card, col, keyed, md, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { estimateRows } from "@oh-my-pi/pi-tui/native/measure";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { SelectListSheet } from "@oh-my-pi/pi-tui/native/picker";
import type { ModelBrowserSource } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { type ModelPickerRegistry, ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { toModelInfo } from "./discovery/models.ts";
import {
	EFFORTS,
	type Effort,
	type InfoLine,
	type ModelInfo,
	type StormModelPick,
	type UiChoiceRow,
	type UiContext,
	type UiPort,
} from "./types.ts";
import { closeoutDetails, readCloseoutRecord } from "./view/closeout.ts";
import { describeInfoLine, infoSymbol, infoSections, renderInfoLine, RichFrame } from "./view/info.ts";
import { visible } from "./view/render.ts";

const REPORT_TYPE = "storm-report";
/**
 * Storm's mark on its frames. 🌀 is emoji-presentation and two cells everywhere; 🌪 defaults to text
 * presentation, so terminals that ignore VS16 (tmux among them) draw it one cell wide and break the frame border.
 */
const REPORT_ICON = "🌀";
/** Storm's frame heading; a title that already names Storm does not repeat it. */
const frameTag = (title: string): string => (title.startsWith("Storm") ? title : `Storm · ${title}`);
const PANEL_KEY = "storm-panel";
/** Rows a selector takes besides its options (frame, padding, key hints), plus the status line and one spare option. */
const SELECTOR_ROWS = 11;
/** Offered when a choice's context does not fit above the selector, so nothing is decided unseen. */
const FULL_VIEW = "전체 내용 보기";
/** Share of the terminal a report or selector overlay may take. */
const OVERLAY_SHARE = 0.85;
const NOTICE_TITLE = { info: "알림", warning: "경고", error: "오류" } as const;
const SCROLL_HINT = "↑↓ PgUp PgDn 스크롤 · Esc·Enter·q 닫기";
const TAB_HINT = `←→·Tab 탭 · ${SCROLL_HINT}`;
const FAST_SCROLL_LINES = 5;
const REPORT_TABS = [
	{ key: "1", id: "overview", label: "1 개요", icon: "status.info" },
	{ key: "2", id: "team", label: "2 팀", icon: "status.enabled" },
	{ key: "3", id: "runtime", label: "3 런타임", icon: "status.running" },
	{ key: "4", id: "storage", label: "4 저장 공간", icon: "context.content" },
] as const;
/** Rows of native card chrome the row estimator does not count. */
const NATIVE_SLACK = 3;
/** A stable context for describing rich nodes; none of them consult it. */
const NATIVE_CX: DescribeContext = { cols: 80, dark: true, reduceMotion: true, supports: () => true, feature: () => false };

/**
 * Draws Storm's transcript records in omp's own frame, headed by Storm's mark and name instead of a package glyph and the
 * raw type. The validated closeout is either one inline fact or a structured frame with its title once. Old
 * and malformed records keep the plain frame; all structured records use semantic spans on both hosts.
 */
export function registerReportRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(REPORT_TYPE, message => {
		const closeout = readCloseoutRecord(message.content, message.details);
		if (closeout !== undefined) {
			const [only] = closeout.info;
			if (only !== undefined && closeout.info.length === 1) {
				const line: InfoLine = { ...only, spans: [{ text: "Storm · ", tone: "muted" }, ...only.spans] };
				return {
					// One fact is one row. The mark yields first: where the line with it would wrap and the bare fact still
					// fits, the fact stands alone rather than breaking its last word onto a second row.
					render: width => {
						const named = renderInfoLine(line, width);
						if (named.length <= 1) return named;
						const bare = renderInfoLine(only, width);
						return bare.length < named.length ? bare : named;
					},
					describe: () => describeInfoLine(line),
					invalidate() {},
				};
			}
			return new RichFrame(frameTag(rowText(closeout.title)), closeout.markdown, closeout.info, REPORT_ICON);
		}
		return new FramedMessageComponent({ message: { ...message, customType: "Storm" }, icon: REPORT_ICON, role: "omp.custom" });
	});
}

function frame(title: string, markdown: string, info?: readonly InfoLine[]): Component {
	const tag = frameTag(title);
	if (info !== undefined && info.length > 0) return new RichFrame(tag, markdown, info, REPORT_ICON);
	return new FramedMessageComponent({
		message: { customType: tag, content: markdown },
		icon: REPORT_ICON,
		role: "omp.custom",
	});
}

interface PanelLayout {
	readonly rows: readonly string[];
	readonly cut: boolean;
	readonly native: NativeNode | undefined;
}

/** A choice's context above the selector, cut to the rows the selector leaves free. */
class PanelView implements Component {
	#cache: { width: number; budget: number; native: boolean; epoch: number; layout: PanelLayout } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly title: string,
		private readonly markdown: string,
		/** Rows to leave for the selector below. */
		private readonly reserve: number,
		private readonly info?: readonly InfoLine[],
	) {}

	/** Whether the context is cut at the terminal's current size. */
	cut(): boolean {
		return this.#layout(this.tui.terminal.columns).cut;
	}

	render(width: number): readonly string[] {
		return this.#layout(width).rows;
	}

	/** The native panel: the same cut head, styled spans and meters, capped to the layout budget. */
	describe(cx: DescribeContext): NativeNode | null {
		if (this.info === undefined || this.info.length === 0) return null;
		return this.#layout(Math.max(1, cx.cols)).native ?? null;
	}

	#layout(width: number): PanelLayout {
		const budget = Math.max(6, this.tui.terminal.rows - this.reserve);
		const nativeRendering = this.tui.nativeRendering;
		const epoch = getThemeEpoch();
		if (this.#cache?.width === width && this.#cache.budget === budget && this.#cache.native === nativeRendering && this.#cache.epoch === epoch) return this.#cache.layout;
		const lines = this.markdown.split("\n");
		const rich = this.info !== undefined && this.info.length > 0;
		const tag = frameTag(this.title);
		/** ANSI rows, plus on Tern a conservative native row count (terminal chrome included). */
		const evaluate = (markdown: string, info: readonly InfoLine[] | undefined) => {
			const component = rich ? new RichFrame(tag, markdown, info, REPORT_ICON) : frame(this.title, markdown);
			const rows = component.render(width);
			if (!rich) return { rows, native: undefined, fits: rows.length <= budget };
			const described = (component as RichFrame).describe(NATIVE_CX);
			// Estimate before capping: the cap makes the terminal scroll rather than shrink its content.
			const estimated = estimateRows(described, Math.max(1, width - 6), budget + 1, () => undefined) + NATIVE_SLACK;
			return {
				rows,
				native: col([described], { max: { h: `${budget}lines` } }),
				// On ANSI the rows above are the real budget; only Tern pays for the native estimate.
				fits: rows.length <= budget && (!nativeRendering || estimated <= budget),
			};
		};
		const full = evaluate(this.markdown, this.info);
		let rows = full.rows;
		let native = full.native;
		const cut = !full.fits;
		if (cut) {
			// Keep the longest head of the source whose frame still fits, and say how much is left out.
			const head = (keep: number) => ({
				markdown: `${lines.slice(0, keep).join("\n")}\n\n… ${lines.length - keep}줄 생략 · 아래 「${FULL_VIEW}」`,
				info: this.info?.filter(line => line.index < keep),
			});
			let lo = 0;
			let hi = lines.length - 1;
			const first = head(0);
			let best = evaluate(first.markdown, first.info);
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				const candidate = head(mid);
				const tried = evaluate(candidate.markdown, candidate.info);
				if (tried.fits) {
					lo = mid;
					best = tried;
				} else hi = mid - 1;
			}
			rows = best.rows;
			native = best.native;
		}
		const layout: PanelLayout = { rows, cut, native };
		this.#cache = { width, budget, native: nativeRendering, epoch, layout };
		return layout;
	}

	invalidate(): void {
		this.#cache = undefined;
	}
}

/** A row's label and detail are config-derived text, so both cross this boundary on one safe line. */
const rowText = (text: string): string => visible(text.replace(/[\r\n\t]+/g, " ")).trim();
const FULL_VIEW_KEY = "storm-full-view";
const FULL_VIEW_ESCAPE = Symbol("storm-full-view");
type RowAnswer = string | typeof FULL_VIEW_ESCAPE | undefined;
/** Rows a rows selector takes besides its options: the panel's top and bottom border. */
const ROWS_CHROME = 2;
/** Smallest context panel worth stacking above the list; below it the selector keeps the terminal. */
const PANEL_MIN_ROWS = 6;

/** The labels other hosts get: unique, human, and carrying the detail the TUI draws beside the label. */
function offeredRowLabels(rows: readonly UiChoiceRow[]): { labels: string[]; values: Map<string, string> } {
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

/**
 * One choice list for the TUI, built from omp's own selector primitives. It is one surface: the optional compact
 * context panel sits above the same list, never beside a second list. Descriptions are inline when the whole
 * label+detail fits; on a narrow terminal the focused row wraps its complete detail underneath, while the native
 * sheet always receives the same detail. Esc cancels, Enter chooses, and the native sheet adds its explicit Close.
 */
class RowSelectView extends OverlayPanel {
	readonly #rows: readonly UiChoiceRow[];
	readonly #context: Omit<UiContext, "consent"> | undefined;
	readonly #panel: PanelView | undefined;
	readonly #panelBudget: number;
	readonly #list: SelectList;
	readonly #sheet: SelectListSheet;
	readonly #done: (answer: RowAnswer) => void;
	#escape: boolean;
	#fullView: SelectItem | undefined;
	#panelRows = 0;

	constructor(
		tui: TUI,
		title: string,
		rows: readonly UiChoiceRow[],
		context: Omit<UiContext, "consent"> | undefined,
		done: (answer: RowAnswer) => void,
	) {
		super(title, "omp.overlay.storm-rows");
		this.#rows = rows;
		this.#context = context;
		this.#done = done;
		const overlayRows = Math.max(8, Math.floor(tui.terminal.rows * OVERLAY_SHARE));
		// The focused row may wrap its detail onto more rows; reserve that room here so the list budget cannot clip it.
		const widestDetail = rows.reduce((widest, row) => {
			const detail = row.description === undefined ? "" : rowText(row.description);
			const detailRows =
				detail.length === 0 ? 1 : wrapTextWithAnsi(detail, Math.max(1, tui.terminal.columns - 6)).length;
			return Math.max(widest, detailRows);
		}, 1);
		const wanted = rows.length + widestDetail + (context === undefined ? 0 : 1);
		let listRows: number;
		if (context === undefined) {
			this.#panelBudget = 0;
			listRows = Math.max(1, Math.min(wanted, overlayRows - ROWS_CHROME));
		} else {
			listRows = Math.max(1, Math.min(wanted, overlayRows - ROWS_CHROME - PANEL_MIN_ROWS));
			this.#panelBudget = Math.max(PANEL_MIN_ROWS, overlayRows - listRows - ROWS_CHROME);
			this.#panel = new PanelView(
				tui,
				context.title,
				context.markdown,
				tui.terminal.rows - this.#panelBudget,
				context.info,
			);
			this.addChild(this.#panel);
		}
		this.#escape = this.#panel?.cut() ?? false;
		this.#list = new SelectList(this.#items(), listRows, getSelectListTheme(), {
			search: "never",
			renderItem: (item) => this.#renderRow(item),
		});
		this.#list.onSelect = (item) => this.#choose(item);
		this.#list.onCancel = () => this.#done(undefined);
		this.addChild(this.#list);
		this.#sheet = new SelectListSheet(this.#list, {
			title,
			icon: "list",
			noun: "항목",
			confirm: "선택",
		});
	}

	#items(): SelectItem[] {
		this.#fullView = undefined;
		const items: SelectItem[] = this.#rows.map((row) => {
			const description = row.description === undefined ? "" : rowText(row.description);
			return {
				value: row.value,
				label: rowText(row.label) || rowText(row.value) || "항목",
				...(description.length > 0 ? { description } : {}),
			};
		});
		if (this.#escape) {
			const fullView: SelectItem = { value: FULL_VIEW_KEY, label: FULL_VIEW };
			this.#fullView = fullView;
			items.push(fullView);
		}
		return items;
	}

	#choose(item: SelectItem): void {
		if (item === this.#fullView) this.#done(FULL_VIEW_ESCAPE);
		else this.#done(item.value);
	}

	/** A cut context gets one row in the same list, never a second list of prose. */
	#syncEscape(): void {
		if (this.#panel === undefined) return;
		const cut = this.#panel.cut();
		if (cut === this.#escape) return;
		this.#escape = cut;
		this.#list.setItems(this.#items());
	}

	#renderRow({ item, selected, hovered, width, theme: listTheme }: SelectListRenderItemContext): readonly string[] {
		const cursor = listTheme.symbols?.cursor ?? ">";
		const prefix = selected ? `${cursor} ` : " ".repeat(visibleWidth(cursor) + 1);
		const room = Math.max(1, width - visibleWidth(prefix));
		const label = item.label;
		const detail = item.description ?? "";
		if (detail.length > 0 && visibleWidth(`${label}  ${detail}`) <= room) {
			if (selected) return [listTheme.selectedText(`${prefix}${label}  ${detail}`)];
			const line = `${prefix}${label}${listTheme.description(`  ${detail}`)}`;
			return [hovered ? (listTheme.hovered?.(line) ?? line) : line];
		}
		const head = `${prefix}${truncateToWidth(label, room)}`;
		const lines = [selected ? listTheme.selectedText(head) : hovered ? (listTheme.hovered?.(head) ?? head) : head];
		if (selected && detail.length > 0) {
			const indent = " ".repeat(visibleWidth(prefix));
			const wrapped = wrapTextWithAnsi(detail, Math.max(1, width - visibleWidth(indent)));
			for (const part of wrapped) lines.push(listTheme.selectedText(`${indent}${part}`));
		}
		return lines;
	}

	override render(width: number): readonly string[] {
		this.#syncEscape();
		this.#panelRows = this.#panel?.render(width).length ?? 0;
		return super.render(width);
	}

	override describe(cx: DescribeContext): NativeNode | null {
		this.#syncEscape();
		if (this.#context === undefined) {
			return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
		}
		const context =
			this.#panel?.describe(cx) ??
			col([md(this.#context.markdown)], { max: { h: `${this.#panelBudget}lines` } });
		return card({ role: this.nativeRole, head: this.title }, [context, this.#list.describe(cx)]);
	}

	handleInput(data: string): void {
		this.#list.handleInput(data);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#context === undefined) this.#sheet.handle(event);
		else this.#list.handleNativeEvent(event);
	}

	/** Overlay-local rows start below the top border and any context panel above them. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#list.routeMouse(event, line - 1 - this.#panelRows, col);
	}
}

interface ReportPage {
	readonly key: string;
	readonly scroll: ScrollView;
	readonly rich: RichFrame | undefined;
	nativeScroll?: NativeScroll;
}

/** A scrollable report, optionally divided into independently scrolling status tabs. */
class ReportView implements Component {
	readonly #pages: readonly ReportPage[];
	readonly #tabs: TabBar | undefined;
	readonly #tabDefs: readonly (typeof REPORT_TABS)[number][];
	readonly #hint: string;
	#tabEpoch: number;
	#native: { height: number; epoch: number; node: NativeNode } | undefined;

	constructor(
		private readonly tui: TUI,
		title: string,
		markdown: string,
		info: readonly InfoLine[] | undefined,
		sectional: boolean,
		private readonly close: () => void,
	) {
		const sections = sectional ? infoSections(markdown, info) : undefined;
		const tabs = REPORT_TABS.filter(tab => sections?.has(tab.id));
		this.#tabDefs = tabs;
		this.#tabEpoch = getThemeEpoch();
		if (tabs.length > 0) {
			this.#tabs = new TabBar("", this.#tabItems(), getTabBarTheme());
			this.#tabs.showHint = false;
			this.#tabs.onTabChange = () => {
				this.#native = undefined;
				this.tui.requestRender();
			};
		}
		this.#hint = tabs.length > 1 ? TAB_HINT : SCROLL_HINT;
		const height = this.#height(this.#tabs === undefined ? 1 : 2);
		const page = (key: string, source: string, annotations: readonly InfoLine[] | undefined): ReportPage => {
			const rich =
				this.#tabs !== undefined || annotations?.length
					? new RichFrame(frameTag(title), source, annotations, REPORT_ICON)
					: undefined;
			const scroll = new ScrollView(rich ?? frame(title, source), {
				height,
				fastScrollLines: FAST_SCROLL_LINES,
				// Same ASCII stroke for track and thumb; neither width nor silhouette changes.
				trackChar: "|",
				thumbChar: "|",
				theme: {
					track: rail => theme.fg("dim", rail),
					thumb: rail => theme.bold(theme.fg("accent", rail)),
				},
			});
			return { key, scroll, rich };
		};
		this.#pages =
			sections === undefined || this.#tabs === undefined
				? [page("body", markdown, info)]
				: tabs.map(tab => {
						const { lines, info } = sections.get(tab.id)!;
						return page(`body-${tab.id}`, lines.join("\n"), info);
					});
	}

	/** Icon-led labels from the active preset; an empty symbol never leaves a leading space. */
	#tabItems(): { id: string; label: string }[] {
		return this.#tabDefs.map(tab => ({ id: tab.id, label: `${infoSymbol(tab.icon) ?? ""}${tab.label}` }));
	}

	#syncTabs(): void {
		const epoch = getThemeEpoch();
		if (epoch === this.#tabEpoch) return;
		this.#tabEpoch = epoch;
		if (this.#tabs !== undefined) this.#tabs.setTabs(this.#tabItems(), this.#tabs.getActiveTab()?.id);
		this.#native = undefined;
		for (const page of this.#pages) {
			page.rich?.invalidate();
			page.scroll.invalidate();
		}
	}

	#height(chromeRows: number): number {
		const budget = Math.max(6, Math.floor(this.tui.terminal.rows * OVERLAY_SHARE));
		return Math.max(1, budget - chromeRows);
	}

	get #page(): ReportPage {
		return this.#pages[this.#tabs?.getActiveIndex() ?? 0]!;
	}

	render(width: number): readonly string[] {
		this.#syncTabs();
		const tabs = this.#tabs?.render(width) ?? [];
		const { scroll } = this.#page;
		scroll.setHeight(this.#height(tabs.length + 1));
		const hint = theme.fg("dim", truncateToWidth(` ${this.#hint}`, width));
		const body = scroll.render(width);
		if (this.#tabs === undefined) return [...body, hint];
		const chrome = (line: string) => theme.bg("customMessageBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
		return [...tabs.map(chrome), ...body, chrome(hint)];
	}

	/** One capped native scroller per section. Hiding, rather than removing, preserves the terminal's offset. */
	describe(cx: DescribeContext): NativeNode | null {
		this.#syncTabs();
		const active = this.#page;
		if (active.rich === undefined) return null;
		const height = this.#height(this.#tabs === undefined ? 1 : 2);
		const epoch = getThemeEpoch();
		if (this.#native?.height === height && this.#native.epoch === epoch) return this.#native.node;
		const children: NativeNode[] = [];
		if (this.#tabs !== undefined) children.push(keyed(this.#tabs.describe(cx), "tabs"));
		for (const page of this.#pages) {
			children.push({
				k: "col",
				p: { role: "omp.report.body", max: { h: `${height}lines` }, ...(page !== active && { hidden: true }) },
				c: [page.rich!.describe(cx)],
				key: page.key,
				...(page.nativeScroll && { scroll: page.nativeScroll }),
			});
		}
		children.push(text([span(this.#hint, "dim")], { wrap: "none", truncate: "end" }));
		const view = node("col", undefined, children, "view");
		this.#native = { height, epoch, node: view };
		return view;
	}

	handleInput(data: string): void {
		// A focused native custom overlay still receives ordinary keys here. Native events are pointer actions.
		if (this.#tabs !== undefined) {
			if (this.#tabs.handleInput(data)) return;
			const key = parseKey(data);
			const tab = REPORT_TABS.find(tab => tab.key === key);
			if (tab !== undefined && this.#tabs.selectTab(tab.id)) return;
		}
		const page = this.#page;
		if (page.scroll.handleScrollKey(data)) {
			const fastUp = matchesKey(data, "shift+up");
			const fastDown = matchesKey(data, "shift+down");
			const by: NativeScroll["by"] | undefined =
				fastUp || matchesKey(data, "up")
					? "line-up"
					: fastDown || matchesKey(data, "down")
						? "line-down"
						: matchesKey(data, "pageUp")
							? "page-up"
							: matchesKey(data, "pageDown")
								? "page-down"
								: matchesKey(data, "home")
									? "start"
									: matchesKey(data, "end")
										? "end"
										: undefined;
			if (by !== undefined) {
				// Tern's reconciler repeats a step by the nonce delta (jumps still happen once).
				page.nativeScroll = { by, n: (page.nativeScroll?.n ?? 0) + (fastUp || fastDown ? FAST_SCROLL_LINES : 1) };
				this.#native = undefined;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) this.close();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.key === "tabs") this.#tabs?.handleNativeEvent(event);
		else if (event.key === "" && event.type === "action" && event.act === "close") this.close();
	}

	invalidate(): void {
		for (const page of this.#pages) page.scroll.invalidate();
		this.#native = undefined;
	}

	dispose(): void {
		for (const page of this.#pages) page.scroll.dispose();
		this.#native = undefined;
	}
}

const STORM_PICKER_STATUS = "이 역할에만 · 세션 유지 · Auto=기본값";
const STORM_PICKER_SOURCE: ModelBrowserSource = {
	revision: 0,
	defaultThinkingLevel: "off",
	modelProviderOrder: [],
	knownRoleIds: [],
	mruOrder: [],
	modelPerf: new Map(),
	getModelRole: () => undefined,
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => false }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
};

const isStormEffort = (value: string): value is Effort => (EFFORTS as readonly string[]).includes(value);

/** The picker slider's structured state: the step it shows, or why it is frozen. */
interface PickerLevel {
	value: string;
	label: string;
	disabled?: string | true;
}

/** Read the active slider step from the picker's structured description, not from ANSI rows. */
function activeLevel(node: NativeNode | undefined): PickerLevel | undefined {
	if (node?.k !== "picker") return undefined;
	const level = node.p?.level;
	if (!level) return undefined;
	const label = level.steps.find(step => step.id === level.value)?.label ?? level.value;
	return level.disabled ? { value: level.value, label, disabled: level.disabled } : { value: level.value, label };
}

/** The host picker owns the search, provider scopes, list and preview; replace only the session-switch chrome. */
class StormModelPicker extends ModelPickerComponent {
	#description: { source: NativeNode; refusal: string | undefined; level: string | undefined; node: NativeNode } | undefined;
	#refusal: string | undefined;
	readonly #catalogError: boolean;

	constructor(
		private readonly tui: TUI,
		private readonly title: string,
		registry: ModelPickerRegistry,
		current: { selector: string; effort?: Effort } | undefined,
		private readonly cancel: () => void,
		pick: (pick: StormModelPick | undefined) => void,
	) {
		super(
			tui,
			STORM_PICKER_SOURCE,
			registry,
			[],
			{
				onPick: (raw, _selector, meta) => {
					const info = toModelInfo(raw, true);
					if (info === undefined) return;
					const effort = meta.thinkingLevel;
					if (effort === undefined) {
						// Untouched: carry the slot's effort only when the same model still supports it; a new model is bare.
						const kept =
							current !== undefined &&
							current.selector === info.selector &&
							current.effort !== undefined &&
							info.efforts.includes(current.effort)
								? current.effort
								: undefined;
						pick(kept === undefined ? { model: info } : { model: info, effort: kept });
						return;
					}
					// Auto is the model's own default in Storm, stored as a bare selector; the status line says so.
					if (effort === "auto") {
						pick({ model: info });
						return;
					}
					// Off is not a Storm effort, and neither is a ladder entry Storm does not know: keep the picker open.
					if (!isStormEffort(effort) || !info.efforts.includes(effort)) {
						this.#refuse(effort, info);
						return;
					}
					pick({ model: info, effort });
				},
				onCancel: cancel,
			},
			{
				...(current === undefined ? {} : { currentSelector: current.selector }),
				// The slot's own known effort shows as itself; every other model (and a bare slot) shows Auto, which
				// the status line defines as this model's own default: an untouched pick then stays a bare selector.
				thinkingLevelFor: model => {
					if (current === undefined) return "auto";
					const info = toModelInfo(model, true);
					if (info?.selector !== current.selector) return "auto";
					return current.effort !== undefined && info.efforts.includes(current.effort)
						? (current.effort as ConfiguredThinkingLevel)
						: "auto";
				},
			},
		);
		this.#catalogError = Boolean(registry.getError());
	}

	#refuse(effort: string, info: ModelInfo): void {
		const supported = info.efforts.length > 0 ? info.efforts.join(", ") : "없음";
		// Reason and alternatives first: at 60 columns the row has no room for the Auto definition too.
		this.#refusal =
			effort === "off"
				? `Off는 Storm effort가 아닙니다 · 지원: ${supported}`
				: `${effort}는 이 모델에서 지원되지 않습니다 · 지원: ${supported}`;
		this.tui.requestRender();
	}

	/** The slider the picker is showing now; the picker is always described as a picker, whatever the host draws. */
	#level(): PickerLevel | undefined {
		return activeLevel(super.describe(NATIVE_CX));
	}

	/** The selected level leads when normal; a refusal leads when it must stay readable at 60 columns. */
	#status(level: PickerLevel | undefined): string {
		const status = theme.fg(this.#refusal === undefined ? "muted" : "warning", this.#refusal ?? STORM_PICKER_STATUS);
		if (level === undefined) return status;
		const shown = level.disabled
			? theme.fg("dim", "no thinking")
			: `${theme.fg("muted", "thinking ")}${theme.getThinkingBorderColor(level.value)(level.label)}`;
		return this.#refusal === undefined ? `${shown} · ${status}` : `${status} · ${shown}`;
	}

	/** The card fallback draws native text, so its status stays plain instead of carrying terminal escapes. */
	#plainStatus(level: PickerLevel | undefined): string {
		const status = this.#refusal ?? STORM_PICKER_STATUS;
		const shown = level === undefined ? undefined : level.disabled ? "no thinking" : `thinking ${level.label}`;
		if (shown === undefined) return status;
		return this.#refusal === undefined ? `${shown} · ${status}` : `${status} · ${shown}`;
	}

	#hints(): string {
		const move = editorKeys("tui.select.up", "tui.select.down");
		// The native picker binds plain ←/→ to its slider; Alt+←/→ stay with the search for word jumps.
		const effort = `${formatKeyHint("left")}/${formatKeyHint("right")} effort`;
		return `${move} 이동 · ${formatKeyHint("enter")} 선택 · ${formatKeyHint("tab")} 공급자 · ${effort} · ${formatKeyHint("escape")} 취소`;
	}

	override handleInput(data: string): void {
		// Leave the interview step, rather than clearing the search on the first Esc as Alt+P does.
		if (matchesKey(data, "escape")) {
			this.cancel();
			return;
		}
		// A changed highlight or slider step may make the previous refusal moot.
		this.#refusal = undefined;
		super.handleInput(data);
	}

	override handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.key === "" && event.act === "close") {
			this.cancel();
			return;
		}
		this.#refusal = undefined;
		super.handleNativeEvent(event);
	}

	override render(width: number): string[] {
		const rows = super.render(width).slice();
		rows[0] = topBorder(width, this.title);
		if (!this.#catalogError) {
			// The stock picker carries the selected level only in its status row; read it structurally and keep it.
			rows[1] = row(this.#status(this.#level()), width);
		}
		rows[rows.length - 2] = row(theme.fg("dim", this.#hints()), width);
		return rows;
	}

	override describe(cx?: DescribeContext): NativeNode {
		const source = super.describe(cx);
		// The card fallback has no level widget of its own, so its status carries the same structured step.
		const cardLevel = source.k === "card" ? this.#level() : undefined;
		const cardKey =
			cardLevel === undefined ? undefined : `${cardLevel.value}\0${cardLevel.label}\0${String(cardLevel.disabled ?? "")}`;
		if (this.#description?.source === source && this.#description.refusal === this.#refusal && this.#description.level === cardKey) {
			return this.#description.node;
		}
		let node = source;
		if (source.k === "picker") {
			node = {
				...source,
				p: {
					...source.p,
					search: "head",
					title: this.title,
					subtitle: this.#refusal ?? source.p?.subtitle ?? STORM_PICKER_STATUS,
					placeholder: "모델 검색…",
				},
			};
		} else if (source.k === "card" && source.c?.[0]) {
			node = {
				...source,
				p: { ...source.p, head: this.title },
				c: [
					this.#catalogError ? source.c[0] : text(this.#plainStatus(cardLevel)),
					...source.c.slice(1, -1),
					text(this.#hints()),
				],
			};
		}
		this.#description = { source, refusal: this.#refusal, level: cardKey, node };
		return node;
	}
}

function modelPickerRegistry(registry: ExtensionContext["modelRegistry"]): ModelPickerRegistry {
	let error: unknown = registry.getError();
	let models: Model[] = [];
	try {
		models = registry.getAvailable("chat").filter(model => model.supportsTools !== false);
	} catch (cause) {
		error = cause;
	}
	return {
		getError: () => error,
		getAvailable: () => models,
		getAll: () => models,
		// The picker gets a read-only snapshot, not OMP's live registry.
		refreshIfStale: async () => false,
	};
}

/**
 * Adapts omp's ctx.ui. In the TUI, views and contexts are overlays and panels that leave nothing in the transcript;
 * other hosts cannot draw components, so they get transcript messages (never sent to the model).
 */
export function createUiPort(pi: ExtensionAPI, ctx: ExtensionContext): UiPort {
	const transcript = (title: string, markdown: string, details?: unknown): void => {
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
	const openReport = async (title: string, markdown: string, info: readonly InfoLine[] | undefined, sectional: boolean): Promise<void> => {
		const tabbed = sectional && info?.some(line => line.section !== undefined) === true;
		await ctx.ui.custom<void>((tui, _theme, _keys, done) => new ReportView(tui, title, markdown, info, tabbed, () => done()), {
			overlay: true,
			overlayOptions: tabbed
				? { width: "90%", maxHeight: "90%", anchor: "top-center", margin: { top: 1 } }
				: { width: "90%", maxHeight: "90%", anchor: "center" },
		});
	};
	const report = async (title: string, markdown: string, info?: readonly InfoLine[]): Promise<void> => {
		if (!drawsComponents) {
			transcript(title, markdown);
			return;
		}
		await openReport(title, markdown, info, true);
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
			// Whether the whole context was put on screen (the overlay) during this dialog.
			let seen = false;
			for (;;) {
				// omp builds the widget right away, so the panel can say whether it was cut before the selector opens.
				let panel: PanelView | undefined;
				ctx.ui.setWidget(PANEL_KEY, tui => {
					panel = new PanelView(tui, context.title, context.markdown, options.length + SELECTOR_ROWS, context.info);
					return panel;
				});
				let offered = options;
				if (panel?.cut()) {
					// A cut panel hides the end of what an accepting option covers: until the whole of it was opened,
					// those options are held back and the full view comes first.
					const held = seen ? [] : (context.consent ?? []);
					offered = held.length ? [FULL_VIEW, ...options.filter(option => !held.includes(option))] : [...options, FULL_VIEW];
				}
				let answer: string | undefined;
				try {
					answer = await ctx.ui.select(title, offered);
				} finally {
					ctx.ui.setWidget(PANEL_KEY, undefined);
				}
				if (answer !== FULL_VIEW) return answer;
				// The whole approval stays in one linear view, regardless of the context's annotations.
				await openReport(context.title, context.markdown, context.info, false);
				seen = true;
			}
		},
		selectRows: async (title, rows, context) => {
			// An empty list has no answer; never open a surface that can only be cancelled.
			if (rows.length === 0) return undefined;
			if (!drawsComponents) {
				// One plain select: labels carry the detail because other hosts draw no row descriptions.
				const offered = offeredRowLabels(rows);
				if (context) transcript(context.title, context.markdown);
				const answer = await ctx.ui.select(title, offered.labels);
				return answer === undefined ? undefined : offered.values.get(answer);
			}
			for (;;) {
				const answer = await ctx.ui.custom<RowAnswer>(
					(tui, _theme, _keys, done) => new RowSelectView(tui, title, rows, context, done),
					{ overlay: true },
				);
				if (answer !== FULL_VIEW_ESCAPE) return answer;
				// Only a cut context offers this row; the whole content stays one linear report, then the list returns.
				if (context === undefined) return undefined;
				await openReport(context.title, context.markdown, context.info, false);
			}
		},
		// Outside the TUI a notification may go nowhere (ACP only logs it), and it is the only word on how a flow ended.
		notify: (message, level = "info") => (drawsComponents ? ctx.ui.notify(message, level) : transcript(NOTICE_TITLE[level], message)),
		report,
		// Always transcript-only. A closeout's styling is persisted only when it matches the text it styles; the plain
		// content stays the whole record for RPC, ACP and any renderer that cannot use the details.
		record: (title, markdown, style) => transcript(title, markdown, closeoutDetails(markdown, style)),
		...(drawsComponents
			? {
					pickModel: (title: string, current?: { selector: string; effort?: Effort }) =>
						ctx.ui.custom<StormModelPick | undefined>(
							(tui, _theme, _keys, done) =>
								new StormModelPicker(
									tui,
									`Storm 모델 선택 · ${title}`,
									modelPickerRegistry(ctx.modelRegistry),
									current,
									() => done(undefined),
									done,
								),
							{ overlay: true },
						),
				}
			: {}),
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
