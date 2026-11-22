/**
 * The live Storm run's one widget under the editor: a short shimmering label followed by the run's plain counters.
 *
 * The counters are `runStatusText` without its own `storm ▶` label, so the widget shows the same round, agents,
 * spend and minutes a status line would, from the controller's snapshots. Only the label moves: an ANSI repaint
 * asks the host to render this component alone at the shimmer cadence, and a Tern terminal clocks the described
 * sheen itself. `dispose()` and `LiveStatus.clear()` stop the timer; no per-run counter or timer lives here.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	type DescribeContext,
	Ellipsis,
	type NativeNode,
	describeShimmer,
	isNativeRendering,
	motionEffectsEnabled,
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
} from "@oh-my-pi/pi-tui";
import type { RunRecord } from "../types.ts";
import { runStatusText } from "./render.ts";

/** The widget's key in the host; unique to Storm's run and cleared when the run ends. */
export const LIVE_WIDGET_KEY = "storm-live";
/** The only animated text: one short label, not the counters. */
export const LIVE_LABEL = "Storm 실행 중";
/** `runStatusText`'s own label, split off so the widget can shimmer its label instead. */
const STATUS_LABEL = "storm ▶ ";
/** omp's splash/loader cadence for terminal-driven shimmer. */
const SHIMMER_TICK_MS = 33;

/**
 * `runStatusText`'s counters without its `storm ▶` label: the round in progress, its agents, authoritative spend
 * against the budget and whole minutes. Unchanged formatter, so the widget and the plain status line agree.
 */
export function liveCounters(run: RunRecord, now: number): string {
	const status = runStatusText(run, now);
	return status.startsWith(STATUS_LABEL) ? status.slice(STATUS_LABEL.length) : status;
}

/** The widget's one line without ANSI styling; this is what an E2E terminal sees after stripping colours. */
export function liveLine(run: RunRecord, now: number): string {
	return `${LIVE_LABEL} · ${liveCounters(run, now)}`;
}

/** A true interactive TUI session: RPC, print and subagent sessions keep the plain status line. */
export function isLiveTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main";
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
	 * Shows `run` in the editor widget when this host can draw one. Returns false for every other host, whose
	 * caller keeps the plain `setStatus` text. Updates reuse the installed component and request only its redraw.
	 */
	show(ctx: ExtensionContext, run: RunRecord): boolean {
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
			if (!this.#install(ui, run, now)) return false;
		} else {
			this.#widget.update(run, now);
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

	#install(ui: ExtensionContext["ui"], run: RunRecord, now: number): boolean {
		let created: LiveRunWidget | undefined;
		try {
			ui.setWidget(
				LIVE_WIDGET_KEY,
				(tui, hostTheme) => {
					const widget = new LiveRunWidget(tui, () => ui.theme ?? hostTheme, run, now, {
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
	/** `runStatusText`'s counters for this snapshot; recomputed only when the controller sends a new record. */
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
		options: { onDisposed?: () => void } = {},
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#counters = liveCounters(run, now);
		this.#onDisposed = options.onDisposed;
		this.#offMotion = onMotionEffectsChange(() => this.#settingsChanged());
		this.#offNative = onNativeRenderingChange(() => this.#settingsChanged());
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	/** The controller's live record changed: repaint, but keep the one installed component. */
	update(run: RunRecord, now: number): void {
		if (this.#disposed) return;
		this.#counters = liveCounters(run, now);
		this.#forget();
		this.#ensureTimer();
		this.#requestRender();
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return [];
		const columns = Math.max(0, Math.floor(width));
		if (columns === 0) return [];
		const animated = this.#animated() && !isNativeRendering();
		if (!isNativeRendering()) this.#ensureTimer();
		else this.#stopTimer();
		const counters = this.#counters;
		const activeTheme = this.#theme();
		const label = animated ? shimmerText(LIVE_LABEL, activeTheme) : activeTheme.fg("muted", LIVE_LABEL);
		const line = `${label} · ${counters}`;
		const key = `${counters}\u0000${animated}\u0000${columns}`;
		// A terminal-clocked label changes every frame; only a static line may reuse its rows by reference.
		if (!animated && this.#lastLines !== undefined && this.#lastKey === key && this.#lastTheme === activeTheme) return this.#lastLines;
		const lines = [truncateToWidth(line, columns, Ellipsis.Unicode)];
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
		const key = `${counters}\u0000${shimmer}`;
		if (this.#nativeNode !== null && this.#nativeKey === key) return this.#nativeNode;
		const label = shimmer
			? describeShimmer([{ text: LIVE_LABEL }], "label")
			: text([span(LIVE_LABEL, "muted")], { wrap: "none", truncate: "end" });
		const tail = text([span(" · ", "dim"), span(counters)], { wrap: "none", truncate: "end" });
		const described = row([label, tail], { align: "baseline", gap: "none" });
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
		return !this.#disposed && motionEffectsEnabled() && shimmerEnabled();
	}

	#ensureTimer(): void {
		if (this.#timer !== undefined || !this.#animated() || isNativeRendering()) return;
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
		if (this.#animated() && !isNativeRendering()) this.#ensureTimer();
		else this.#stopTimer();
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
