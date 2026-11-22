/**
 * The live Storm run's one widget under the editor: a themed wind marker and the run's phase, followed by the
 * run's plain counters.
 *
 * Only the header moves: an ANSI repaint asks the host to render this component alone at the shimmer cadence,
 * and a Tern terminal clocks the described sheen itself. Waiting, between rounds, stopping, an off OMP motion
 * choice, a disabled shimmer setting, reduced motion and a native surface all snap the header still and stop
 * the timer at once. `dispose()` and `LiveStatus.clear()` stop it too; no per-run counter or timer lives here.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	type DescribeContext,
	Ellipsis,
	type NativeNode,
	type ShimmerPalette,
	describeShimmer,
	isNativeRendering,
	motionEffectsEnabled,
	node,
	onMotionEffectsChange,
	onNativeRenderingChange,
	row,
	shimmerEnabled,
	shimmerText,
	span,
	text,
	truncateToWidth,
	type Theme,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { RunRecord } from "../types.ts";
import { RUN_APPEARANCE, STORM_MARK, type RunPhase } from "./appearance.ts";
import { runStatusCounters } from "./render.ts";

/** The widget's key in the host; unique to Storm's run and cleared when the run ends. */
export const LIVE_WIDGET_KEY = "storm-live";
/** omp's splash/loader cadence for terminal-driven shimmer. */
const SHIMMER_TICK_MS = 33;

/**
 * The one animated span: a short, blue-ish sweep from theme tokens, so every theme keeps its own palette.
 * No raw ANSI or RGB: a Tern terminal receives the token names and applies its own theme.
 */
const STORM_PALETTE = {
	low: "dim",
	mid: "borderAccent",
	high: "mdLink",
	bold: true,
} satisfies ShimmerPalette;

/** The header text without styling: the wind marker, then the phase a reader can name. */
function liveHeader(phase: RunPhase): string {
	return `${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`;
}

/** A true interactive TUI session: RPC, print and subagent sessions keep the plain status line. */
export function isLiveTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main";
}

/**
 * The one row, clipped from the end: the phase header stays whole while the expendable counters give way first.
 * Below the header's own width there is nothing left to protect, so the header truncates last.
 */
function fitLine(header: string, counters: string, columns: number): string {
	const headerWidth = visibleWidth(header);
	if (columns <= headerWidth) return truncateToWidth(header, columns, Ellipsis.Unicode);
	return `${header}${truncateToWidth(` · ${counters}`, columns - headerWidth, Ellipsis.Unicode)}`;
}

/** `describeShimmer` takes no layout props; copy its node so a narrow native row gives the counters way first. */
function pinnedHeader(described: NativeNode): NativeNode {
	if (described.k !== "shimmer") return described;
	return node("shimmer", { ...described.p, shrink: 0 }, described.c, described.key);
}

/**
 * One session's live widget. `show` installs it once per active run and then updates the component in place;
 * `clear` removes it. `beginSession` invalidates an older session's asynchronous status refresh so a late
 * `syncSession` cannot install a widget for a run the user already switched away from.
 */
export class LiveStatus {
	readonly #now: () => number;
	#ui: ExtensionContext["ui"] | undefined;
	#widget: LiveRunWidget | undefined;
	#statusCleared = false;
	#epoch = 0;

	constructor(options: { now?: () => number } = {}) {
		this.#now = options.now ?? Date.now;
	}

	/** The current session generation; `syncSession` checks it again after every await. */
	epoch(): number {
		return this.#epoch;
	}

	isCurrent(epoch: number): boolean {
		return this.#epoch === epoch;
	}

	/** A switch, fork, new session or shutdown: nothing from before it may draw after it. */
	beginSession(): number {
		this.#epoch++;
		this.clear();
		return this.#epoch;
	}

	/**
	 * Shows `run` in the editor widget when this host can draw one. The phase is view-only evidence from the
	 * controller and defaults to `working`, so existing callers keep the old behavior. Returns false for every
	 * other host, whose caller keeps the plain `setStatus` text. Updates reuse the installed component and
	 * request only its redraw.
	 */
	show(ctx: ExtensionContext, run: RunRecord, phase: RunPhase = "working"): boolean {
		if (!isLiveTui(ctx)) return false;
		const ui = ctx.ui;
		if (this.#ui !== undefined && this.#ui !== ui) {
			// The host was replaced: stop the old component without asking the new one to clear it.
			this.#widget?.stop();
			this.#widget = undefined;
			this.#statusCleared = false;
		}
		if (this.#widget?.disposed === true) {
			// The host removed or replaced the widget underneath us (its dispose ran): install again below.
			this.#widget = undefined;
			this.#statusCleared = false;
		}
		const now = this.#now();
		if (this.#widget === undefined) {
			if (!this.#install(ui, run, now, phase)) return false;
		} else {
			this.#widget.update(run, now, phase);
		}
		this.#ui = ui;
		// The run's label moved into the widget: the status line must not keep a second live copy.
		if (!this.#statusCleared) {
			ui.setStatus("storm", undefined);
			this.#statusCleared = true;
		}
		return true;
	}

	/** Removes the widget, stops its animation and forgets the session's host. Safe to call more than once. */
	clear(): void {
		const widget = this.#widget;
		const ui = this.#ui;
		this.#widget = undefined;
		this.#ui = undefined;
		this.#statusCleared = false;
		widget?.stop();
		if (ui === undefined) return;
		try {
			ui.setWidget(LIVE_WIDGET_KEY, undefined);
		} catch {
			// The host is going away or no longer accepts widgets; the component's timer is already stopped.
		}
	}

	#install(ui: ExtensionContext["ui"], run: RunRecord, now: number, phase: RunPhase): boolean {
		let created: LiveRunWidget | undefined;
		try {
			ui.setWidget(
				LIVE_WIDGET_KEY,
				(tui, hostTheme) => {
					const widget = new LiveRunWidget(tui, () => ui.theme ?? hostTheme, run, now, phase, {
						onDisposed: () => {
							if (this.#widget !== widget) return;
							this.#widget = undefined;
							this.#statusCleared = false;
						},
					});
					created = widget;
					return widget;
				},
				{ placement: "belowEditor" },
			);
		} catch {
			// Without a widget the caller falls back to the plain status line.
			return false;
		}
		this.#widget = created;
		return created !== undefined;
	}
}

/** `requestComponentRender` is the scoped request older and newer TUI hosts all answer; plain render is the fallback. */
type ComponentTui = Omit<TUI, "requestComponentRender"> & {
	requestComponentRender?: (component: Component) => void;
};

/**
 * The widget's actual component. `render(width)` handles plain terminal rows; `describe()` hands a Tern terminal a
 * shimmer node, which clocks the sheen itself. Both carry the counters as static text.
 */
class LiveRunWidget implements Component {
	#tui: ComponentTui;
	#theme: () => Theme;
	#phase: RunPhase;
	/** Formatted only when the controller supplies a new snapshot, not during animation ticks. */
	#counters: string;
	#onDisposed: (() => void) | undefined;
	#offMotion: () => void;
	#offNative: () => void;
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;
	#lastKey = "";
	#lastLines: readonly string[] | undefined;
	#lastTheme: Theme | undefined;
	#nativeKey = "";
	#nativeNode: NativeNode | null = null;

	constructor(
		tui: TUI,
		theme: () => Theme,
		run: RunRecord,
		now: number,
		phase: RunPhase,
		options: { onDisposed?: () => void } = {},
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#phase = phase;
		this.#counters = runStatusCounters(run, now);
		this.#onDisposed = options.onDisposed;
		this.#offMotion = onMotionEffectsChange(() => this.#settingsChanged());
		this.#offNative = onNativeRenderingChange(() => this.#settingsChanged());
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	/** The controller's live record or phase changed: repaint, but keep the one installed component. */
	update(run: RunRecord, now: number, phase: RunPhase): void {
		if (this.#disposed) return;
		this.#counters = runStatusCounters(run, now);
		this.#phase = phase;
		// A still phase must stop at once and drop the old frame; the request below repaints the snap-to-still row.
		this.#forget();
		this.#syncTimer();
		this.#requestRender();
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return [];
		const columns = Math.max(0, Math.floor(width));
		if (columns === 0) return [];
		const animated = this.#animated() && !isNativeRendering();
		this.#syncTimer();
		const counters = this.#counters;
		const activeTheme = this.#theme();
		const look = RUN_APPEARANCE[this.#phase];
		const header = animated
			? shimmerText(liveHeader(this.#phase), activeTheme, STORM_PALETTE)
			: `${activeTheme.fg("accent", STORM_MARK)} · ${activeTheme.fg(look.tone, look.label)}`;
		const key = `${this.#phase}\u0000${counters}\u0000${animated}\u0000${columns}`;
		// A terminal-clocked header changes every frame; only a still line may reuse its rows by reference.
		if (!animated && this.#lastLines !== undefined && this.#lastKey === key && this.#lastTheme === activeTheme) return this.#lastLines;
		const lines = [fitLine(header, counters, columns)];
		this.#lastKey = key;
		this.#lastLines = lines;
		this.#lastTheme = activeTheme;
		return lines;
	}

	describe(cx?: DescribeContext): NativeNode | null {
		if (this.#disposed) return null;
		// Tern repaints the described sheen from its own clock, so no ANSI repaint timer may run here.
		this.#stopTimer();
		const counters = this.#counters;
		const shimmer = this.#animated() && cx?.reduceMotion !== true && (cx?.supports("shimmer") ?? true);
		const key = `${this.#phase}\u0000${counters}\u0000${shimmer}`;
		if (this.#nativeNode !== null && this.#nativeKey === key) return this.#nativeNode;
		const look = RUN_APPEARANCE[this.#phase];
		const header = shimmer
			? pinnedHeader(describeShimmer([{ text: liveHeader(this.#phase), palette: STORM_PALETTE }], "header"))
			: text([span(STORM_MARK, "accent"), span(` · ${look.label}`, look.tone)], { wrap: "none", truncate: "end", shrink: 0 });
		const tail = text([span(" · ", "dim"), span(counters)], { wrap: "none", truncate: "end", grow: 1, min: { w: "0ch" } });
		const described = row([header, tail], { align: "baseline", gap: "none" });
		this.#nativeKey = key;
		this.#nativeNode = described;
		return described;
	}

	dispose(): void {
		this.stop();
	}

	/** Idempotent: the host may dispose the component, and `LiveStatus.clear()` may have stopped it already. */
	stop(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopTimer();
		this.#offMotion();
		this.#offNative();
		this.#forget();
		this.#onDisposed?.();
	}

	#animated(): boolean {
		return !this.#disposed && RUN_APPEARANCE[this.#phase].motion && motionEffectsEnabled() && shimmerEnabled();
	}

	/** The only timer path: one interval while an active phase may shimmer here, none otherwise. */
	#syncTimer(): void {
		if (this.#disposed || !this.#animated() || isNativeRendering()) this.#stopTimer();
		else this.#ensureTimer();
	}

	#ensureTimer(): void {
		if (this.#timer !== undefined || this.#disposed || isNativeRendering() || !this.#animated()) return;
		const timer = setInterval(() => {
			if (this.#timer !== timer) return;
			if (this.#disposed || isNativeRendering() || !this.#animated()) {
				this.#stopTimer();
				this.#forget();
				this.#requestRender();
				return;
			}
			this.#requestRender();
		}, SHIMMER_TICK_MS);
		timer.unref?.();
		this.#timer = timer;
	}

	#stopTimer(): void {
		if (this.#timer === undefined) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#settingsChanged(): void {
		if (this.#disposed) return;
		this.#forget();
		this.#syncTimer();
		this.#requestRender();
	}

	#requestRender(): void {
		if (this.#disposed) return;
		const request = this.#tui.requestComponentRender;
		if (request !== undefined) request.call(this.#tui, this);
		else this.#tui.requestRender();
	}

	#forget(): void {
		this.#lastKey = "";
		this.#lastLines = undefined;
		this.#lastTheme = undefined;
		this.#nativeKey = "";
		this.#nativeNode = null;
	}
}
