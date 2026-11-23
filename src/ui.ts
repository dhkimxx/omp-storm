import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, getThemeEpoch, matchesKey, parseKey, ScrollView, TabBar, type TUI, theme, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { editorKeys, FramedMessageComponent, getTabBarTheme, row, topBorder } from "@oh-my-pi/pi-tui/chrome";
import { col, keyed, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { estimateRows } from "@oh-my-pi/pi-tui/native/measure";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { ModelBrowserSource } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { type ModelPickerRegistry, ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { toModelInfo } from "./discovery/models.ts";
import type { InfoLine, ModelInfo, UiPort } from "./types.ts";
import { infoSymbol, infoSections, RichFrame } from "./view/info.ts";

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
/** Share of the terminal a report overlay may take. */
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

/** Draws Storm's transcript records in omp's own frame, headed by Storm's mark and name instead of a package glyph and the raw type. */
export function registerReportRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(
		REPORT_TYPE,
		message => new FramedMessageComponent({ message: { ...message, customType: "Storm" }, icon: REPORT_ICON, role: "omp.custom" }),
	);
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

const STORM_PICKER_STATUS = "이 Storm 역할에만 적용 · 현재 세션 모델은 변경하지 않음";
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

/** The host picker owns the search, provider scopes, list and preview; replace only the session-switch chrome. */
class StormModelPicker extends ModelPickerComponent {
	#description: { source: NativeNode; node: NativeNode } | undefined;
	readonly #catalogError: boolean;

	constructor(
		tui: TUI,
		private readonly title: string,
		registry: ModelPickerRegistry,
		private readonly cancel: () => void,
		pick: (model: ModelInfo | undefined) => void,
	) {
		super(tui, STORM_PICKER_SOURCE, registry, [], {
			onPick: raw => pick(toModelInfo(raw, true)),
			onCancel: cancel,
		});
		this.#catalogError = Boolean(registry.getError());
	}

	#hints(): string {
		const move = editorKeys("tui.select.up", "tui.select.down");
		return `${move} 이동 · ${formatKeyHint("enter")} 선택 · ${formatKeyHint("tab")} 공급자 · ${formatKeyHint("escape")} 취소`;
	}

	override handleInput(data: string): void {
		// Leave the interview step, rather than clearing the search on the first Esc as Alt+P does.
		if (matchesKey(data, "escape")) this.cancel();
		else super.handleInput(data);
	}

	override handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.key === "" && event.act === "close") this.cancel();
		else super.handleNativeEvent(event);
	}

	override render(width: number): string[] {
		const rows = super.render(width).slice();
		rows[0] = topBorder(width, this.title);
		if (!this.#catalogError) rows[1] = row(theme.fg("muted", STORM_PICKER_STATUS), width);
		rows[rows.length - 2] = row(theme.fg("dim", this.#hints()), width);
		return rows;
	}

	override describe(cx?: DescribeContext): NativeNode {
		const source = super.describe(cx);
		if (this.#description?.source === source) return this.#description.node;
		let node = source;
		if (source.k === "picker") {
			node = {
				...source,
				p: {
					...source.p,
					search: "head",
					title: this.title,
					subtitle: source.p?.subtitle ?? STORM_PICKER_STATUS,
					placeholder: "모델 검색…",
				},
			};
		} else if (source.k === "card" && source.c?.[0]) {
			node = {
				...source,
				p: { ...source.p, head: this.title },
				c: [
					this.#catalogError ? source.c[0] : text(STORM_PICKER_STATUS),
					...source.c.slice(1, -1),
					text(this.#hints()),
				],
			};
		}
		this.#description = { source, node };
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
	const transcript = (title: string, markdown: string): void => {
		pi.sendMessage(
			{ customType: REPORT_TYPE, content: `### ${title}\n\n${markdown}`, display: true, excludeFromContext: true },
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
		// Outside the TUI a notification may go nowhere (ACP only logs it), and it is the only word on how a flow ended.
		notify: (message, level = "info") => (drawsComponents ? ctx.ui.notify(message, level) : transcript(NOTICE_TITLE[level], message)),
		report,
		record: transcript,
		...(drawsComponents
			? {
					pickModel: (title: string) =>
						ctx.ui.custom<ModelInfo | undefined>(
							(tui, _theme, _keys, done) =>
								new StormModelPicker(
									tui,
									`Storm 모델 선택 · ${title}`,
									modelPickerRegistry(ctx.modelRegistry),
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
