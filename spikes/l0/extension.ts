/**
 * Demo extension for the lane view. Load it with `omp -e spikes/l0/extension.ts` (see README.md).
 *
 *   /laneview box|braille|storm|off [rows] [tickMs] [full|happy|crowd]
 *
 * It mounts the variant as a widget below the editor, the way Storm's own live widget is mounted (`LiveStatus` in
 * `src/view/live.ts`), and plays the scripted scenario with the active theme's colours. Motion follows omp's settings:
 * with reduced motion, the shimmer setting off, or `--motion none`, frames are drawn with `motion: false` and the
 * scenario's states still advance once a second. `rows` (default 8) is the view's height, held fixed by padding with blank
 * rows, because omp's below-editor container only grows (see README, finding 1); `tickMs` (default 85) the
 * redraw period, kept settable so the host's repaint cost can be measured; the last word picks the scripted scenario.
 * Colours: the storm variant draws its own colours, so the demo tells it the theme's colour mode (truecolor or 256) and
 * whether the theme is light or dark (`Theme.getColorMode`, `Theme.isLight`).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	getThemeEpoch,
	motionEffectsEnabled,
	onMotionEffectsChange,
	onNativeRenderingChange,
	shimmerEnabled,
	type Theme,
	type TUI,
} from "@oh-my-pi/pi-tui";
import type { Frame } from "./model.ts";
import { themePaint } from "./palette.ts";
import { loadFrame, placeholderFrame, TICK_MS, VARIANTS, type Variant } from "./play.ts";
import { type ScenarioName, SCENARIOS, snapshotAt } from "./scenario.ts";

const WIDGET_KEY = "laneview-demo";
const TONES = ["accent", "bright", "success", "role1", "role2", "role3", "role4", "role5"] as const;

/**
 * Measurement frame (not a design): exactly `maxRows` rows, every cell of every row changing at each 85 ms step, so it
 * is the worst case for the host's repaint. Used by `/laneview fill` to find the host's height and cost limits.
 */
const fillFrame: Frame = (_snapshot, cols, t, options) => {
	const glyphs = "⠁⠃⠇⡇⣇⣧⣷⣿";
	const step = Math.floor(t / TICK_MS);
	return Array.from({ length: options.maxRows }, (_, row) => {
		const head = `${String(row + 1).padStart(2)}/${options.maxRows} `;
		let body = "";
		for (let c = 0; c < Math.max(0, cols - head.length); c++) body += glyphs[(step + c + row * 3) % glyphs.length];
		return options.paint(TONES[(row + step) % TONES.length]!, head + body);
	});
};
const STILL_TICK_MS = 1000;

type ComponentTui = Omit<TUI, "requestComponentRender"> & { requestComponentRender?: (component: Component) => void };

class LaneWidget implements Component {
	readonly #tui: ComponentTui;
	readonly #theme: () => Theme;
	readonly #frame: Frame;
	readonly #maxRows: number;
	readonly #tickMs: number;
	readonly #scenario: ScenarioName;
	readonly #startedAt = Date.now();
	#timer: NodeJS.Timeout | undefined;
	#timerPeriod = 0;
	#disposed = false;
	#paint: { theme: Theme; epoch: number; paint: ReturnType<typeof themePaint> } | undefined;
	readonly #offMotion: () => void;
	readonly #offNative: () => void;

	constructor(tui: TUI, theme: () => Theme, frame: Frame, maxRows: number, tickMs: number, scenario: ScenarioName) {
		this.#tui = tui;
		this.#theme = theme;
		this.#frame = frame;
		this.#maxRows = maxRows;
		this.#tickMs = tickMs;
		this.#scenario = scenario;
		this.#offMotion = onMotionEffectsChange(() => this.#sync());
		this.#offNative = onNativeRenderingChange(() => this.#sync());
	}

	/** The same gate Storm's radar uses: omp's motion effects setting and its shimmer setting. */
	#animated(): boolean {
		return motionEffectsEnabled() && shimmerEnabled();
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return [];
		this.#sync();
		const columns = Math.max(0, Math.floor(width));
		if (columns === 0) return [];
		const theme = this.#theme();
		const epoch = getThemeEpoch();
		if (this.#paint?.theme !== theme || this.#paint.epoch !== epoch) this.#paint = { theme, epoch, paint: themePaint(theme) };
		const t = Date.now() - this.#startedAt;
		const rows = this.#frame(snapshotAt(t, this.#scenario), columns, t, {
			ascii: theme.getSymbolPreset() === "ascii",
			motion: this.#animated(),
			maxRows: this.#maxRows,
			paint: this.#paint.paint,
			colour: theme.getColorMode() === "truecolor" ? "truecolor" : "256",
			dark: !theme.isLight,
		});
		// The below-editor container only grows: a view that is shorter for a moment (a run's first second has no
		// lanes) would leave blank rows under it and move the editor later. Always return exactly `maxRows` rows.
		return rows.length >= this.#maxRows ? rows.slice(0, this.#maxRows) : [...rows, ...Array.from({ length: this.#maxRows - rows.length }, () => "")];
	}

	/** One repaint timer: the radar's period while animating, one second otherwise (states advance, glyphs do not). */
	#sync(): void {
		if (this.#disposed) return;
		const period = this.#animated() ? this.#tickMs : STILL_TICK_MS;
		if (this.#timer !== undefined && this.#timerPeriod === period) return;
		this.#stopTimer();
		this.#timerPeriod = period;
		const timer = setInterval(() => {
			if (this.#timer === timer) this.#requestRender();
		}, period);
		timer.unref?.();
		this.#timer = timer;
	}

	#stopTimer(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#requestRender(): void {
		if (this.#disposed) return;
		const request = this.#tui.requestComponentRender;
		if (request !== undefined) request.call(this.#tui, this);
		else this.#tui.requestRender();
	}

	invalidate(): void {
		this.#paint = undefined;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopTimer();
		this.#offMotion();
		this.#offNative();
	}
}

function parsePositive(text: string | undefined, fallback: number, min: number, max: number): number {
	const value = Number(text);
	return Number.isFinite(value) && text !== undefined && text !== "" ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

export default function laneviewDemo(pi: ExtensionAPI): void {
	pi.registerCommand("laneview", {
		description: "레인 뷰 데모 (/laneview box|braille|storm|off [행 수] [틱 ms] [full|happy|crowd])",
		getArgumentCompletions: prefix => {
			const matches = [...VARIANTS, "off"].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const [choice, ...rest] = args.trim().split(/\s+/);
			const scenario = SCENARIOS.find(name => rest.includes(name)) ?? "full";
			const [rowsText, tickText] = rest.filter(word => !(SCENARIOS as readonly string[]).includes(word));
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("laneview needs the interactive TUI", "warning");
				return;
			}
			if (choice === "off") {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify("laneview: off", "info");
				return;
			}
			if (choice !== "box" && choice !== "braille" && choice !== "storm" && choice !== "fill") {
				ctx.ui.notify("usage: /laneview box|braille|storm|off [rows] [tickMs] [full|happy|crowd]", "warning");
				return;
			}
			const variant: Variant | "fill" = choice;
			const loaded = variant === "fill" ? fillFrame : await loadFrame(variant);
			const rows = parsePositive(rowsText, 8, 1, 60);
			const tickMs = parsePositive(tickText, TICK_MS, 16, 5000);
			const ui = ctx.ui;
			ui.setWidget(
				WIDGET_KEY,
				(tui, hostTheme) => new LaneWidget(tui, () => ui.theme ?? hostTheme, loaded ?? placeholderFrame, rows, tickMs, scenario),
				{ placement: "belowEditor" },
			);
			ui.notify(
				loaded === undefined
					? `laneview: ${variant} does not exist yet, showing the placeholder (${rows} rows)`
					: `laneview: ${variant}, ${rows} rows, ${tickMs} ms, ${scenario}`,
				"info",
			);
		},
	});
}
