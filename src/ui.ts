import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Component, matchesKey, ScrollView, type TUI, theme } from "@oh-my-pi/pi-tui";
import { FramedMessageComponent } from "@oh-my-pi/pi-tui/chrome";
import type { UiPort } from "./types.ts";

const REPORT_TYPE = "storm-report";
/**
 * Storm's mark on its frames. 🌀 is emoji-presentation and two cells everywhere; 🌪 defaults to text
 * presentation, so terminals that ignore VS16 (tmux among them) draw it one cell wide and break the frame border.
 */
const REPORT_ICON = "🌀";
const PANEL_KEY = "storm-panel";
/** Rows a selector takes besides its options (frame, padding, key hints), plus the status line and one spare option. */
const SELECTOR_ROWS = 11;
/** Offered when a choice's context does not fit above the selector, so nothing is decided unseen. */
const FULL_VIEW = "전체 내용 보기";
/** Share of the terminal a report overlay may take. */
const OVERLAY_SHARE = 0.85;

/** Draws Storm's transcript records in omp's own frame, headed by Storm's mark and name instead of a package glyph and the raw type. */
export function registerReportRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(
		REPORT_TYPE,
		message => new FramedMessageComponent({ message: { ...message, customType: "Storm" }, icon: REPORT_ICON, role: "omp.custom" }),
	);
}

function frame(title: string, markdown: string): Component {
	return new FramedMessageComponent({
		message: { customType: `Storm · ${title}`, content: markdown },
		icon: REPORT_ICON,
		role: "omp.custom",
	});
}

/** A choice's context above the selector, cut to the rows the selector leaves free. */
class PanelView implements Component {
	#cache: { width: number; budget: number; rows: readonly string[]; cut: boolean } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly title: string,
		private readonly markdown: string,
		/** Rows to leave for the selector below. */
		private readonly reserve: number,
	) {}

	/** Whether the context is cut at the terminal's current size. */
	cut(): boolean {
		return this.#layout(this.tui.terminal.columns).cut;
	}

	render(width: number): readonly string[] {
		return this.#layout(width).rows;
	}

	#layout(width: number): { rows: readonly string[]; cut: boolean } {
		const budget = Math.max(6, this.tui.terminal.rows - this.reserve);
		if (this.#cache?.width === width && this.#cache.budget === budget) return this.#cache;
		let rows = frame(this.title, this.markdown).render(width);
		const cut = rows.length > budget;
		if (cut) {
			// Keep the longest head of the source whose frame still fits, and say how much is left out.
			const lines = this.markdown.split("\n");
			const head = (keep: number) =>
				frame(this.title, `${lines.slice(0, keep).join("\n")}\n\n… ${lines.length - keep}줄 생략 · 아래 「${FULL_VIEW}」`).render(width);
			let lo = 0;
			let hi = lines.length - 1;
			rows = head(0);
			while (lo < hi) {
				const mid = Math.ceil((lo + hi) / 2);
				const tried = head(mid);
				if (tried.length <= budget) {
					lo = mid;
					rows = tried;
				} else hi = mid - 1;
			}
		}
		this.#cache = { width, budget, rows, cut };
		return this.#cache;
	}

	invalidate(): void {
		this.#cache = undefined;
	}
}

/** A report to read and close: scrolls with the arrow and page keys, closes with Esc, Enter or q. */
class ReportView implements Component {
	readonly #scroll: ScrollView;

	constructor(
		private readonly tui: TUI,
		title: string,
		markdown: string,
		private readonly close: () => void,
	) {
		this.#scroll = new ScrollView(frame(title, markdown), { height: this.#height() });
	}

	#height(): number {
		return Math.max(5, Math.floor(this.tui.terminal.rows * OVERLAY_SHARE) - 1);
	}

	render(width: number): readonly string[] {
		this.#scroll.setHeight(this.#height());
		return [...this.#scroll.render(width), theme.fg("dim", " ↑↓ PgUp PgDn 스크롤 · Esc·Enter·q 닫기")];
	}

	handleInput(data: string): void {
		if (this.#scroll.handleScrollKey(data)) {
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") this.close();
	}

	invalidate(): void {
		this.#scroll.invalidate();
	}
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
	const report = async (title: string, markdown: string): Promise<void> => {
		if (!drawsComponents) {
			transcript(title, markdown);
			return;
		}
		await ctx.ui.custom<void>((tui, _theme, _keys, done) => new ReportView(tui, title, markdown, () => done()), {
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
		});
	};
	return {
		select: async (title, options, context) => {
			if (!context) return ctx.ui.select(title, options);
			if (!drawsComponents) {
				transcript(context.title, context.markdown);
				return ctx.ui.select(title, options);
			}
			for (;;) {
				// omp builds the widget right away, so the panel can say whether it was cut before the selector opens.
				let panel: PanelView | undefined;
				ctx.ui.setWidget(PANEL_KEY, tui => {
					panel = new PanelView(tui, context.title, context.markdown, options.length + SELECTOR_ROWS);
					return panel;
				});
				let answer: string | undefined;
				try {
					answer = await ctx.ui.select(title, panel?.cut() ? [...options, FULL_VIEW] : options);
				} finally {
					ctx.ui.setWidget(PANEL_KEY, undefined);
				}
				if (answer !== FULL_VIEW) return answer;
				await report(context.title, context.markdown);
			}
		},
		confirm: (title, message) => ctx.ui.confirm(title, message),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		notify: (message, level = "info") => ctx.ui.notify(message, level),
		report,
		record: transcript,
	};
}
