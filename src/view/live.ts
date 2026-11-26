/**
 * Storm's live instrument below the editor. On a roomy ANSI terminal it is the lane view: a status row, then the
 * director's trunk and one line per plan lane, at a height fixed for the run. Everywhere else it is the single status
 * line with its radar (compact terminals get a static row). Tern clocks its own sheen, and still pictures or OMP motion
 * settings stop the only local repaint timer immediately.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Component,
	type DescribeContext,
	Ellipsis,
	type NativeNode,
	type ShimmerPalette,
	col,
	describeShimmer,
	getThemeEpoch,
	isNativeRendering,
	motionEffectsEnabled,
	onMotionEffectsChange,
	onNativeRenderingChange,
	row,
	shimmerEnabled,
	span,
	text,
	truncateToWidth,
	type Theme,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { RunRecord } from "../types.ts";
import { RUN_APPEARANCE, STORM_MARK, type RunPhase } from "./appearance.ts";
import { LANE_MIN_COLUMNS, laneFrame, laneLiveliness } from "./lane/frame.ts";
import type { LaneSnapshot } from "./lane/model.ts";
import { LaneTimeline } from "./lane/timeline.ts";
import {
	type LiveMetricChip,
	type LiveMetricFacts,
	type LiveMetricForm,
	LIVE_STATE_LABEL,
	liveMetricFacts,
} from "./live-metrics.ts";

/** The widget's key in the host; unique to Storm's run and cleared when the run ends. */
export const LIVE_WIDGET_KEY = "storm-live";
const RADAR_TICK_MS = 85;
const RADAR_COLUMNS = 52;
/** The lane view needs this many terminal rows; below it the single line stays. */
export const LANE_MIN_ROWS = 18;
/** Lane frames repaint at the radar's pace, a little slower over SSH where the view's ~70 KB/s is felt. */
const LANE_TICK_MS = 85;
const LANE_SSH_TICK_MS = 120;
/** About four frames a second: the picture only breathes (waiting for the user). */
const LANE_SLOW_TICK_MS = 250;
/** One animation step never exceeds this, so a stalled event loop does not make the picture leap. */
const LANE_MAX_STEP_MS = 500;
const LANE_MIN_HEIGHT = 6;
const LANE_MAX_HEIGHT = 12;

/** The lane view's fixed height for a terminal of `terminalRows` rows: a third of it, between 6 and 12 rows. */
export function laneHeight(terminalRows: number): number {
	return Math.min(LANE_MAX_HEIGHT, Math.max(LANE_MIN_HEIGHT, Math.floor(terminalRows / 3)));
}

function laneTickMs(): number {
	const env = process.env;
	return (env.SSH_CONNECTION ?? "") !== "" || (env.SSH_TTY ?? "") !== "" ? LANE_SSH_TICK_MS : LANE_TICK_MS;
}
/** The ASCII preset keeps Storm's identity without a glyph the terminal cannot render. */
const ASCII_MARK = "~ STORM";
const RADAR_PALETTES = {
	working: { low: "dim", mid: "accent", high: "mdLink", bold: true },
	workers: { low: "dim", mid: "borderAccent", high: "mdLink", bold: true },
	verifying: { low: "dim", mid: "borderAccent", high: "success", bold: true },
} as const satisfies Record<"working" | "workers" | "verifying", ShimmerPalette>;

// Single-cell braille gives the instrument a direction and texture without emoji presentation or ambiguous-width blocks.
const RADAR = {
	working: "⠁⠈⠐⡀⣀⠤⠒⠉⠐⡀⣀⠤⠒⠉⠈⠂⠄⡀",
	workers: "⠠⠠⠤⠤⠤⠶⠶⠤⠤⠈⠈⠉⠉⠛⠛⠉⠉⠈",
	verifying: "⠈⠐⠠⢀⡀⠄⠂⠁⠁⠂⠄⡀⢀⠠⠐⠈⠈⠁",
	"waiting-user": "⠂⠂⠂⠂⠂⠂⠂⠂⣶⣶⠂⠂⠂⠂⠂⠂⠂⠂",
	"between-rounds": "⠂⠂⠂⠂⠂⠂⠂⠂⠤⠤⠂⠂⠂⠂⠂⠂⠂⠂",
	stopping: "⠤⠤⠤⠒⠒⠂⠂⠂⠂⠂⠂⠂⠂⠂⠂⠂⠂⠂",
} as const satisfies Record<RunPhase, string>;

// The ASCII preset keeps the same phase distinction without braille or other non-ASCII chrome.
const RADAR_ASCII = {
	working: "~-~-~-~-~-~-~-~-~-",
	workers: "->->->->->->->->->",
	verifying: "<===>-----<===>---",
	"waiting-user": "= = = = = = = = = ",
	"between-rounds": ".-.-.-.-.-.-.-.-.-",
	stopping: "|/|/|/|/|/|/|/|/|/",
} as const satisfies Record<RunPhase, string>;

function radarFrame(phase: RunPhase, frame: number, theme: Theme, track: string): string {
	if (!(phase in RADAR_PALETTES)) return theme.fg(RUN_APPEARANCE[phase].tone, track);
	const motion = phase as keyof typeof RADAR_PALETTES;
	const { low, mid, high } = RADAR_PALETTES[motion];
	const length = track.length;
	// The wind rolls, workers move in one direction, and verification sweeps back and forth.
	const half = length / 2;
	const shift = frame % half;
	let field = track as string;
	if (shift !== 0 && motion === "working") field = track.slice(shift * 2) + track.slice(0, shift * 2);
	if (shift !== 0 && motion === "workers") field = track.slice(shift, half) + track.slice(0, shift) + track.slice(half + shift) + track.slice(half, half + shift);
	const sweep = frame % (motion === "verifying" ? 2 * (length - 1) : length);
	const head = motion === "verifying" && sweep >= length ? 2 * (length - 1) - sweep : sweep;
	const left = Math.max(0, head - 3);
	const right = Math.min(length, head + (motion === "verifying" ? 3 : 2));
	return (left ? theme.fg(low, field.slice(0, left)) : "") +
		theme.fg(mid, field.slice(left, head)) + theme.bold(theme.fg(high, field[head]!)) +
		theme.fg(mid, field.slice(head + 1, right)) +
		(right < length ? theme.fg(low, field.slice(right)) : "");
}

interface RadarLayout {
	columns: number;
	theme: Theme;
	epoch: number;
	preset: "unicode" | "nerd" | "ascii";
	prefix: string;
	metrics: string;
	track: string;
	still: readonly string[];
	frames: Array<readonly string[] | undefined>;
}

interface FittedChip {
	chip: LiveMetricChip;
	form: LiveMetricForm;
	formIndex: number;
}

/** The text-span shape native `text` nodes take; kept concrete here instead of publishing an opaque helper type. */
interface Span {
	t: string;
	s?: string;
}

/** The wind marker's ASCII form exists only in this widget; the footer keeps its own branding. */
function markFor(theme: Theme): string {
	return theme.getSymbolPreset() === "ascii" ? ASCII_MARK : STORM_MARK;
}

/** A true interactive TUI session: RPC, print and subagent sessions keep the plain status line. */
export function isLiveTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main";
}

/** The visible icon prefix; ASCII's cost glyph is itself "$", so the value's own dollar is the whole mark. */
function chipIcon(chip: LiveMetricChip, theme: Theme): string {
	const icon = theme.symbol(chip.icon);
	return chip.key === "cost" && icon === "$" ? "" : icon;
}

/** The plain width of a chip's visible text, so emoji and preset glyphs are measured where the terminal will draw them. */
function chipWidth(chip: LiveMetricChip, form: LiveMetricForm, theme: Theme): number {
	const icon = chipIcon(chip, theme);
	const lead = icon === "" ? "" : `${icon} `;
	const state = chip.state === undefined ? "" : ` ${LIVE_STATE_LABEL[chip.state]}`;
	return visibleWidth(`${lead}${form.value}${form.suffix ?? ""}${state}`);
}

interface ChipFitQuality {
	resultForm: number;
	primary: number;
	value: number;
	richness: number;
}

function chipFitQuality(chips: readonly FittedChip[]): ChipFitQuality {
	let resultForm = Number.MAX_SAFE_INTEGER;
	let primary = 0;
	let value = 0;
	let richness = 0;
	for (const entry of chips) {
		if (entry.chip.key === "results") resultForm = entry.formIndex;
		if (entry.chip.key === "round" || entry.chip.key === "workers") primary++;
		if (entry.chip.key !== "time") {
			value++;
			richness += entry.formIndex;
		}
	}
	return { resultForm, primary, value, richness };
}

/** Preserve the fullest result form possible before trading it for telemetry. */
function comparePrimary(a: ChipFitQuality, b: ChipFitQuality): number {
	return b.resultForm - a.resultForm || a.primary - b.primary;
}

function compareDetail(a: ChipFitQuality, b: ChipFitQuality): number {
	return a.value - b.value || b.richness - a.richness;
}

/**
 * Pick one whole form per chip for a prefix of the priority order. Result progress wins first, then the phase
 * counters and optional spend; elapsed only breaks an otherwise exact tie. The longer form wins only within the same
 * chip set, so no chip is ever clipped to make room.
 */
function fitChips(chips: readonly LiveMetricChip[], available: number, theme: Theme): FittedChip[] {
	const sepWidth = visibleWidth(theme.symbol("sep.dot"));
	let best: FittedChip[] = [];
	let bestQuality = chipFitQuality([]);
	const visit = (index: number, used: number, chosen: FittedChip[]): void => {
		const quality = chipFitQuality(chosen);
		const order = comparePrimary(quality, bestQuality) || compareDetail(quality, bestQuality);
		const wins = order > 0 || (order === 0 && chosen.length > best.length);
		if (wins) {
			best = [...chosen];
			bestQuality = quality;
		}
		if (index >= chips.length) return;
		const chip = chips[index]!;
		const gap = chosen.length === 0 ? 0 : sepWidth;
		for (let formIndex = 0; formIndex < chip.forms.length; formIndex++) {
			const form = chip.forms[formIndex]!;
			const width = chipWidth(chip, form, theme);
			if (used + gap + width > available) continue;
			chosen.push({ chip, form, formIndex });
			visit(index + 1, used + gap + width, chosen);
			chosen.pop();
		}
	};
	visit(0, 0, []);
	return best;
}

interface LiveLine {
	fullHeader: boolean;
	chips: FittedChip[];
}

/**
 * The single-row choice: keep the full mark while it does not cost a result or counter, otherwise trade the mark for
 * `phase word + more chips`, and finally truncate the phase word itself. Phase is never dropped for a chip.
 */
function chooseLine(facts: LiveMetricFacts, columns: number, theme: Theme): LiveLine | undefined {
	const sepWidth = visibleWidth(theme.symbol("sep.dot"));
	const phaseWidth = visibleWidth(facts.phase.label);
	const fullWidth = visibleWidth(markFor(theme)) + sepWidth + phaseWidth;
	const candidates: LiveLine[] = [];
	if (columns >= fullWidth) {
		candidates.push({ fullHeader: true, chips: fitChips(facts.chips, columns - fullWidth - sepWidth, theme) });
	}
	if (columns >= phaseWidth) {
		candidates.push({ fullHeader: false, chips: fitChips(facts.chips, columns - phaseWidth - sepWidth, theme) });
	}
	let best: LiveLine | undefined;
	let bestQuality = chipFitQuality([]);
	for (const candidate of candidates) {
		const quality = chipFitQuality(candidate.chips);
		const order = comparePrimary(quality, bestQuality);
		const detail = compareDetail(quality, bestQuality);
		const wins = best === undefined || order > 0 || (order === 0 &&
			(candidate.fullHeader !== best.fullHeader
				? candidate.fullHeader
				: detail > 0 || (detail === 0 && candidate.chips.length > best.chips.length)));
		if (wins) {
			best = candidate;
			bestQuality = quality;
		}
	}
	return best;
}

/** ANSI chip chrome is muted; numbers carry the tone, and only spend can carry warning/error. */
function ansiChip(entry: FittedChip, theme: Theme): string {
	const { chip, form } = entry;
	const icon = chipIcon(chip, theme);
	const prefix = icon === "" ? "" : theme.fg("dim", `${icon} `);
	if (chip.key === "time") return `${prefix}${theme.fg("dim", form.value)}`;
	const state = chip.state === undefined ? "" : ` ${theme.fg(chip.tone, LIVE_STATE_LABEL[chip.state])}`;
	return `${prefix}${theme.bold(theme.fg(chip.tone, form.value))}${form.suffix === undefined ? "" : theme.fg("dim", form.suffix)}${state}`;
}

/** One whole ANSI row of chips; separators exist only between included chips. */
function ansiMetrics(chips: readonly LiveMetricChip[], columns: number, theme: Theme): string {
	const lead = theme.getSymbolPreset() === "ascii" ? "> " : "› ";
	const fitted = fitChips(chips, columns - visibleWidth(lead), theme);
	if (fitted.length === 0) return "";
	const sep = theme.fg("dim", theme.symbol("sep.dot"));
	return `${theme.fg("dim", lead)}${fitted.map(entry => ansiChip(entry, theme)).join(sep)}`;
}

function singleRow(facts: LiveMetricFacts, columns: number, theme: Theme): readonly string[] {
	const chosen = chooseLine(facts, columns, theme);
	if (chosen === undefined) {
		const ellipsis = theme.getSymbolPreset() === "ascii" ? Ellipsis.Ascii : Ellipsis.Unicode;
		return [truncateToWidth(theme.fg(facts.phase.tone, facts.phase.label), columns, ellipsis)];
	}
	const header = chosen.fullHeader
		? `${theme.bold(theme.fg("accent", markFor(theme)))}${theme.fg("dim", theme.symbol("sep.dot"))}${theme.fg(facts.phase.tone, facts.phase.label)}`
		: theme.fg(facts.phase.tone, facts.phase.label);
	if (chosen.chips.length === 0) return [header];
	const sep = theme.fg("dim", theme.symbol("sep.dot"));
	return [`${header}${sep}${chosen.chips.map(entry => ansiChip(entry, theme)).join(sep)}`];
}

/** The same chip chrome as ANSI, as spans: dim icon/word, toned number, state word only when spend has one. */
function chipSpans(entry: FittedChip, theme: Theme): Span[] {
	const { chip, form } = entry;
	const icon = chipIcon(chip, theme);
	const spans: Span[] = icon === "" ? [] : [span(icon, "dim"), span(" ", "dim")];
	if (chip.key === "time") {
		spans.push(span(form.value, "dim"));
		return spans;
	}
	spans.push(span(form.value, `${chip.tone} strong`));
	if (form.suffix !== undefined) spans.push(span(form.suffix, "dim"));
	if (chip.state !== undefined) spans.push(span(" ", "dim"), span(LIVE_STATE_LABEL[chip.state], chip.tone));
	return spans;
}

/** A whole chip text node with its full accessible sentence; the layout only includes forms that fit. */
function nativeChip(entry: FittedChip, theme: Theme): NativeNode {
	return text(chipSpans(entry, theme), {
		wrap: "none",
		truncate: "end",
		shrink: 0,
		role: `omp.storm.live.${entry.chip.key}`,
		aria: entry.chip.aria,
	});
}

function nativeMetricsRow(chips: readonly LiveMetricChip[], columns: number, theme: Theme): NativeNode {
	const lead = theme.getSymbolPreset() === "ascii" ? "> " : "› ";
	const fitted = fitChips(chips, columns - visibleWidth(lead), theme);
	const children: NativeNode[] = [text([span(lead, "dim")], { wrap: "none", shrink: 0 })];
	for (const entry of fitted) {
		if (children.length > 1) children.push(text([span(theme.symbol("sep.dot"), "dim")], { wrap: "none", shrink: 0 }));
		children.push(nativeChip(entry, theme));
	}
	return row(children, { align: "baseline", gap: "none", role: "omp.storm.live.metrics" });
}

/** A narrow native host gets the same compact line as ANSI, with one overall accessible sentence. */
function nativeCompactLine(facts: LiveMetricFacts, columns: number, theme: Theme): NativeNode {
	const chosen = chooseLine(facts, columns, theme);
	if (chosen === undefined) {
		return text([span(facts.phase.label, facts.phase.tone)], {
			wrap: "none",
			truncate: "end",
			shrink: 0,
			role: "omp.storm.live",
			aria: facts.phase.label,
		});
	}
	const spans: Span[] = chosen.fullHeader
		? [span(markFor(theme), "accent"), span(theme.symbol("sep.dot"), "dim"), span(facts.phase.label, facts.phase.tone)]
		: [span(facts.phase.label, facts.phase.tone)];
	for (const entry of chosen.chips) {
		spans.push(span(theme.symbol("sep.dot"), "dim"), ...chipSpans(entry, theme));
	}
	const header = chosen.fullHeader ? `${markFor(theme)}${theme.symbol("sep.dot")}${facts.phase.label}` : facts.phase.label;
	const aria = chosen.chips.length === 0 ? header : `${header}: ${chosen.chips.map(entry => entry.chip.aria).join(" · ")}`;
	return text(spans, { wrap: "none", truncate: "end", shrink: 0, role: "omp.storm.live", aria });
}

/**
 * One session's live widget. `show` installs it once per active run and then updates the component in place;
 * `clear` removes it. `beginSession` invalidates an older session's asynchronous status refresh so a late
 * `syncSession` cannot install a widget for a run the user already switched away from.
 */
export class LiveStatus {
	readonly #now: () => number;
	readonly #laneView: (ctx: ExtensionContext) => boolean;
	#ui: ExtensionContext["ui"] | undefined;
	#widget: LiveRunWidget | undefined;
	#statusCleared = false;
	#epoch = 0;

	/** `laneView` is the session's lane view switch, asked on every `show`; it defaults to on. */
	constructor(options: { now?: () => number; laneView?: (ctx: ExtensionContext) => boolean } = {}) {
		this.#now = options.now ?? Date.now;
		this.#laneView = options.laneView ?? (() => true);
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
		const laneView = this.#laneView(ctx);
		if (this.#widget === undefined) {
			if (!this.#install(ui, run, now, phase, laneView)) return false;
		} else {
			this.#widget.update(run, now, phase, laneView);
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

	#install(ui: ExtensionContext["ui"], run: RunRecord, now: number, phase: RunPhase, laneView: boolean): boolean {
		let created: LiveRunWidget | undefined;
		try {
			ui.setWidget(
				LIVE_WIDGET_KEY,
				(tui, hostTheme) => {
					const widget = new LiveRunWidget(tui, () => ui.theme ?? hostTheme, run, now, phase, {
						clock: this.#now,
						laneView,
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
type ComponentTui = Omit<TUI, "requestComponentRender" | "terminal"> & {
	requestComponentRender?: (component: Component) => void;
	/** Absent in hosts that cannot say how tall the terminal is; the lane view then stays off. */
	terminal?: Pick<TUI["terminal"], "rows">;
};

/** The ANSI row of the status line in lane mode, shaped for one width, theme and set of facts. */
interface StatusRow {
	columns: number;
	theme: Theme;
	epoch: number;
	preset: "unicode" | "nerd" | "ascii";
	row: string;
}

/**
 * The widget Storm mounts below the editor for one run. Two ANSI drawings share it: the lane view (status row, trunk
 * and lanes) and the single status line with its radar; native rendering describes the line and the host clocks its
 * sheen.
 *
 * The lane view's height is decided once, the first time its conditions hold, and never changes while the widget is
 * mounted: omp's below-editor area only grows, so a height that shrank would leave blank rows and one that grew
 * would push the editor up again. After that the widget always returns exactly that many rows. When the conditions
 * stop holding (the switch is turned off, the window gets narrow, short or ASCII) it draws the single line at the top
 * of those rows and leaves the rest blank.
 */
class LiveRunWidget implements Component {
	#tui: ComponentTui;
	#theme: () => Theme;
	#phase: RunPhase;
	/** Shaped only when the controller supplies a new snapshot, not during animation ticks. */
	#facts: LiveMetricFacts;
	#onDisposed: (() => void) | undefined;
	#offMotion: () => void;
	#offNative: () => void;
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;
	#columns = 0;
	#frame = 0;
	#layout: RadarLayout | undefined;
	#native: { theme: Theme; key: string; node: NativeNode } | undefined;
	readonly #clock: () => number;
	#laneView: boolean;
	#runId: string;
	#timeline = new LaneTimeline();
	/** Rows reserved for the lane view; undefined until its conditions first hold. */
	#height: number | undefined;
	#status: StatusRow | undefined;
	#timerPeriod = 0;
	/** Animation time: advances only while the timer runs, so a restart continues the motion instead of jumping. */
	#animTime = 0;
	#animAt: number | undefined;

	constructor(
		tui: TUI,
		theme: () => Theme,
		run: RunRecord,
		now: number,
		phase: RunPhase,
		options: { onDisposed?: () => void; clock?: () => number; laneView?: boolean } = {},
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#phase = phase;
		this.#facts = liveMetricFacts(run, phase, now);
		this.#onDisposed = options.onDisposed;
		this.#clock = options.clock ?? Date.now;
		this.#laneView = options.laneView ?? true;
		this.#runId = run.runId;
		this.#timeline.observe(run, phase, now);
		this.#offMotion = onMotionEffectsChange(() => this.#settingsChanged());
		this.#offNative = onNativeRenderingChange(() => this.#settingsChanged());
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	/**
	 * The controller's live record, phase or the lane view switch changed: repaint, but keep the one installed
	 * component. The timeline sees every update, even one that changes no chip, because lanes move without them.
	 */
	update(run: RunRecord, now: number, phase: RunPhase, laneView: boolean = this.#laneView): void {
		if (this.#disposed) return;
		if (run.runId !== this.#runId) {
			// One timeline belongs to one run.
			this.#runId = run.runId;
			this.#timeline = new LaneTimeline();
		}
		this.#timeline.observe(run, phase, now);
		const switched = laneView !== this.#laneView;
		this.#laneView = laneView;
		const facts = liveMetricFacts(run, phase, now);
		const unchanged = this.#phase === phase && this.#facts.key === facts.key;
		if (unchanged && !switched && !this.#laneShown()) return;
		if (this.#phase !== phase) this.#frame = 0;
		this.#facts = facts;
		this.#phase = phase;
		this.invalidate();
		this.#syncTimer();
		this.#requestRender();
	}

	/** Whether the lane view is what this widget draws at the width it was last given. */
	#laneShown(): boolean {
		return this.#columns > 0 && this.#laneEligible(this.#columns, this.#theme());
	}

	/** The lane view's conditions: ANSI rendering, room in both directions, a glyph preset with Braille, switch on. */
	#laneEligible(columns: number, theme: Theme): boolean {
		if (!this.#laneView || isNativeRendering()) return false;
		if (columns < LANE_MIN_COLUMNS || theme.getSymbolPreset() === "ascii") return false;
		const rows = this.#tui.terminal?.rows;
		return rows !== undefined && rows >= LANE_MIN_ROWS;
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return [];
		const columns = Math.max(0, Math.floor(width));
		this.#columns = columns;
		const theme = this.#theme();
		const lane = columns > 0 && this.#laneEligible(columns, theme);
		if (lane && this.#height === undefined) this.#height = laneHeight(this.#tui.terminal?.rows ?? LANE_MIN_ROWS);
		if (lane) return this.#laneRows(columns, theme);
		this.#syncTimer();
		if (columns === 0) return this.#padded([]);
		return this.#padded(this.#lineRows(columns, theme));
	}

	/** Once the lane view's height is decided every render returns exactly that many rows, blank where nothing is drawn. */
	#padded(rows: readonly string[]): readonly string[] {
		const height = this.#height;
		if (height === undefined) return rows;
		if (rows.length >= height) return rows.slice(0, height);
		return [...rows, ...Array.from({ length: height - rows.length }, () => "")];
	}

	/** The status row, then the trunk and the lanes, padded to the height fixed for the run. */
	#laneRows(columns: number, theme: Theme): readonly string[] {
		const height = this.#height!;
		const now = this.#clock();
		const snapshot = this.#timeline.snapshot(now);
		this.#syncTimer(snapshot);
		if (this.#timer !== undefined) {
			if (this.#animAt !== undefined) this.#animTime += Math.min(LANE_MAX_STEP_MS, Math.max(0, now - this.#animAt));
			this.#animAt = now;
		}
		const frame = laneFrame(snapshot, columns, this.#animTime, {
			motion: this.#motionOn(),
			maxRows: height - 1,
			colour: theme.getColorMode() === "truecolor" ? "truecolor" : "256",
			dark: !theme.isLight,
		});
		return this.#padded([this.#statusRow(columns, theme), ...frame]);
	}

	/** Row 0 of the lane view: mark, phase and chips, without the radar (the trunk carries the motion). */
	#statusRow(columns: number, theme: Theme): string {
		const epoch = getThemeEpoch();
		const preset = theme.getSymbolPreset();
		const cached = this.#status;
		if (cached?.columns === columns && cached.theme === theme && cached.epoch === epoch && cached.preset === preset) return cached.row;
		const row = singleRow(this.#facts, columns, theme)[0] ?? "";
		this.#status = { columns, theme, epoch, preset, row };
		return row;
	}

	/** The single status line with its radar, exactly as before the lane view existed. */
	#lineRows(columns: number, theme: Theme): readonly string[] {
		const epoch = getThemeEpoch();
		const preset = theme.getSymbolPreset();
		const layout = this.#layout?.columns === columns && this.#layout.theme === theme &&
			this.#layout.epoch === epoch && this.#layout.preset === preset
			? this.#layout : (this.#layout = this.#buildLayout(columns, theme, epoch, preset));
		if (!this.#ticking()) return layout.still;
		return (layout.frames[this.#frame] ??= [
			`${layout.prefix}${radarFrame(this.#phase, this.#frame, theme, layout.track)}${theme.fg("dim", "]")}`,
			layout.metrics,
		]);
	}

	#buildLayout(columns: number, theme: Theme, epoch: number, preset: "unicode" | "nerd" | "ascii"): RadarLayout {
		const ascii = preset === "ascii";
		const track = ascii ? RADAR_ASCII[this.#phase] : RADAR[this.#phase];
		const header = `${theme.bold(theme.fg("accent", markFor(theme)))}${theme.fg("dim", theme.symbol("sep.dot"))}${theme.fg(this.#facts.phase.tone, this.#facts.phase.label)}`;
		if (columns < RADAR_COLUMNS) {
			return { columns, theme, epoch, preset, prefix: "", metrics: "", track, still: singleRow(this.#facts, columns, theme), frames: [] };
		}
		const headerWidth = visibleWidth(markFor(theme)) + visibleWidth(theme.symbol("sep.dot")) + visibleWidth(this.#facts.phase.label);
		const prefix = `${header}${" ".repeat(Math.max(1, columns - headerWidth - visibleWidth(track) - 2))}${theme.fg("dim", "[")}`;
		const metrics = ansiMetrics(this.#facts.chips, columns, theme);
		const still = [`${prefix}${theme.fg(this.#facts.phase.tone, track)}${theme.fg("dim", "]")}`, metrics];
		return { columns, theme, epoch, preset, prefix, metrics, track, still, frames: [] };
	}

	describe(cx?: DescribeContext): NativeNode | null {
		if (this.#disposed) return null;
		this.#stopTimer(); // Tern paints its own sheen.
		const columns = Math.max(0, Math.floor(cx?.cols ?? RADAR_COLUMNS));
		const wide = columns >= RADAR_COLUMNS;
		const shimmer = wide && this.#animated() && cx?.reduceMotion !== true && (cx?.supports("shimmer") ?? true);
		const theme = this.#theme();
		const epoch = getThemeEpoch();
		const preset = theme.getSymbolPreset();
		const key = `${wide}|${shimmer}|${columns}|${epoch}|${preset}`;
		const cached = this.#native;
		if (cached !== undefined && cached.theme === theme && cached.key === key) return cached.node;
		const ascii = preset === "ascii";
		const track = ascii ? RADAR_ASCII[this.#phase] : RADAR[this.#phase];
		let described: NativeNode;
		if (wide) {
			const header = text([
				span(markFor(theme), "accent"),
				span(theme.symbol("sep.dot"), "dim"),
				span(this.#facts.phase.label, this.#facts.phase.tone),
			], { wrap: "none", truncate: "end", shrink: 0 });
			const field = shimmer
				? describeShimmer([{ text: track, palette: RADAR_PALETTES[this.#phase as keyof typeof RADAR_PALETTES] }], "storm-radar")
				: text([span(track, this.#facts.phase.tone)], { wrap: "none", shrink: 0 });
			described = col([
				row([
					header,
					text(" ", { grow: 1, min: { w: "0ch" } }),
					text([span("[", "dim")], { shrink: 0 }), field, text([span("]", "dim")], { shrink: 0 }),
				], { align: "baseline", gap: "none" }),
				nativeMetricsRow(this.#facts.chips, columns, theme),
			], { gap: "none" });
		} else {
			described = nativeCompactLine(this.#facts, columns, theme);
		}
		this.#native = { theme, key, node: described };
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
		this.invalidate();
		this.#onDisposed?.();
	}

	/** OMP's motion setting, the gate both drawings share. */
	#motionOn(): boolean {
		return !this.#disposed && motionEffectsEnabled() && shimmerEnabled();
	}

	#animated(): boolean {
		return this.#motionOn() && RUN_APPEARANCE[this.#phase].motion;
	}

	#ticking(): boolean {
		return this.#columns >= RADAR_COLUMNS && this.#animated() && !isNativeRendering();
	}

	/**
	 * The period of the one repaint timer, or undefined when nothing moves. The lane view follows its picture's
	 * liveliness: full pace, a slow pulse, or none; the radar follows its phase.
	 */
	#period(snapshot?: LaneSnapshot): number | undefined {
		if (this.#disposed || this.#columns === 0) return undefined;
		if (this.#laneShown()) {
			if (!this.#motionOn()) return undefined;
			const liveliness = laneLiveliness(snapshot ?? this.#timeline.snapshot(this.#clock()));
			return liveliness === "still" ? undefined : liveliness === "slow" ? LANE_SLOW_TICK_MS : laneTickMs();
		}
		return this.#ticking() ? RADAR_TICK_MS : undefined;
	}

	/** One scoped repaint timer, only while something on screen moves. */
	#syncTimer(snapshot?: LaneSnapshot): void {
		const period = this.#period(snapshot);
		if (period === undefined) {
			this.#stopTimer();
			return;
		}
		if (this.#timer !== undefined && this.#timerPeriod === period) return;
		if (this.#timer !== undefined) clearInterval(this.#timer);
		const timer = setInterval(() => {
			if (this.#timer !== timer) return;
			// In lane mode the render decides the pace (and whether to stop) from the frame's own snapshot.
			if (this.#laneShown()) {
				this.#requestRender();
				return;
			}
			if (this.#period() === undefined) {
				this.#stopTimer();
			} else {
				const length = RADAR[this.#phase].length;
				const cycle = this.#phase === "verifying" ? 2 * (length - 1) : length;
				this.#frame = (this.#frame + 1) % cycle;
			}
			this.#requestRender();
		}, period);
		timer.unref?.();
		this.#timer = timer;
		this.#timerPeriod = period;
	}

	#stopTimer(): void {
		if (this.#timer === undefined) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
		// The next restart continues from the animation time reached, not from the wall clock.
		this.#animAt = undefined;
	}

	#settingsChanged(): void {
		if (this.#disposed) return;
		this.invalidate();
		this.#syncTimer();
		this.#requestRender();
	}

	#requestRender(): void {
		if (this.#disposed) return;
		const request = this.#tui.requestComponentRender;
		if (request !== undefined) request.call(this.#tui, this);
		else this.#tui.requestRender();
	}

	invalidate(): void {
		this.#layout = undefined;
		this.#status = undefined;
		this.#native = undefined;
	}
}
