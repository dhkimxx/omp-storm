/**
 * Live widget: the single status line with its radar (layout, metric chips, animation isolation, native and plain
 * terminal motion preferences) and the lane view above it (rows, height, timer, switch).
 *
 * The host is a plain `{ requestRender, size, suspend }` plus omp's real dark theme, as the dock hands them to a widget
 * factory; the widget's rows are read by calling `render` on what the factory returned. `mountWidget` (the real test
 * terminal) covers the last describe. Native (Tern) drawing is read off the node tree the factory returns.
 *
 * `describe("the live run widget")` tests the single line on purpose: its `LiveStatus` has the lane view switched
 * off, so a tall terminal in the test host cannot turn it into the lane view by accident. The lane view has its own
 * `describe` below.
 */
import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { ExtensionContext, ExtensionRender, ExtensionUiFactory } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isUiNode, setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { signal } from "../src/tui/kit.ts";
import { RUN_APPEARANCE, STORM_MARK, type RunPhase } from "../src/view/appearance.ts";
import * as frameModule from "../src/view/lane/frame.ts";
import { LANE_HUB_HINT, LANE_MIN_ROWS, laneHeight, LIVE_WIDGET_KEY, LiveStatus, liveWidgetRows } from "../src/view/live.ts";
import { liveMetricFacts } from "../src/view/live-metrics.ts";
import { NO_DECLARED_RESULTS } from "../src/runtime/result-facts.ts";
import type { RunRecord, RunResult } from "../src/types.ts";
import { agentEntry, runRecord, spawnRecord } from "./fixtures.ts";
import { extensionTheme, mountWidget } from "./tui-host.ts";

const NOW = Date.parse("2026-11-20T09:03:00Z");
const RUN: RunRecord = runRecord({
	runId: "run-live",
	status: "running",
	startedAt: "2026-11-20T09:00:00.000Z",
	turns: 0,
	maxRounds: 4,
	costUsd: 0.12,
	budget: { perRunUsd: 5, onExceed: "block-spawns" },
	agents: [agentEntry({ id: "Impl", state: "running" }), agentEntry({ id: "Rev", state: "idle" })],
});
const COUNTERS = "↻ 1/4라운드 · 👥 1/2 · 💲 $0.1200/$5.00 · ⏱ 3분";
const ASCII_MARK = "~ STORM";
const ASCII_COUNTERS = "loop 1/4라운드 - AG 1/2 - $0.1200/$5.00 - t: 3분";

/** What the factory returned: a rows object in a terminal host, a node tree in a native one. */
type Widget = { render(width: number): readonly string[]; dispose?(): void };

interface WidgetHost {
	ctx: ExtensionContext;
	/** The terminal the widget asks for its size; assign `rows` or `columns` to resize the window under a mounted widget. */
	terminal: { rows: number; columns: number };
	installs: Array<{ key: string; placement: string | undefined }>;
	statuses: Array<string | undefined>;
	/** The rows object each installed widget factory returned (a node tree in native hosts: see `nativeRoot`). */
	widgets: Map<string, Widget>;
	/** The node tree a native host got for the widget in the slot. */
	nodes: Map<string, UiNode>;
	/** How many times the widget asked the host to draw it again. */
	requestCount(): number;
}

/** The parts of a host the widget touches: status writes, one widget slot, render requests, terminal size. */
function widgetHost(rows = 40): WidgetHost {
	const statuses: Array<string | undefined> = [];
	const installs: Array<{ key: string; placement: string | undefined }> = [];
	const widgets = new Map<string, Widget>();
	const nodes = new Map<string, UiNode>();
	let requests = 0;
	const size = signal({ columns: 120, rows });
	const terminal = {
		get rows(): number {
			return size.peek().rows;
		},
		set rows(value: number) {
			size.set({ ...size.peek(), rows: value });
		},
		get columns(): number {
			return size.peek().columns;
		},
		set columns(value: number) {
			size.set({ ...size.peek(), columns: value });
		},
	};
	const uiHost = {
		requestRender() {
			requests++;
		},
		size: () => size(),
		suspend: <R>(run: () => Promise<R>): Promise<R> => run(),
	};
	const ui = {
		setStatus(_key: string, text: string | undefined) {
			statuses.push(text);
		},
		setWidget(key: string, content: unknown, options?: { placement?: string }) {
			if (content === undefined) {
				widgets.get(key)?.dispose?.();
				nodes.get(key)?.dispose();
				widgets.delete(key);
				nodes.delete(key);
				return;
			}
			if (Array.isArray(content)) return;
			const built: ExtensionRender = (content as ExtensionUiFactory)(uiHost, extensionTheme(currentTheme()));
			if (isUiNode(built)) nodes.set(key, built);
			else widgets.set(key, built as Widget);
			installs.push({ key, placement: options?.placement });
		},
	};
	return {
		ctx: { mode: "tui", hasUI: true, agent: { kind: "main", id: "main", name: "main" }, ui } as unknown as ExtensionContext,
		terminal,
		installs,
		statuses,
		widgets,
		nodes,
		requestCount: () => requests,
	};
}

function plain(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

/** A node's props, as the host paints them (text, spans, palette, role, aria…). */
interface NodeView {
	kind: string;
	text: string | undefined;
	spans: readonly { t: string; s?: string }[];
	aria: string | undefined;
	role: string | undefined;
	palette: Record<string, string> | undefined;
	kids: NodeView[];
}

function view(node: UiNode): NodeView {
	const props = node.props() as {
		text?: string;
		spans?: readonly { t: string; s?: string }[];
		aria?: string;
		role?: string;
		palette?: Record<string, string>;
	};
	return {
		kind: node.kind,
		text: props.text,
		spans: props.spans ?? [],
		aria: props.aria,
		role: props.role,
		palette: props.palette,
		kids: node.children().map(view),
	};
}

function nodeText(node: NodeView): string {
	return node.text ?? node.spans.map(part => part.t).join("");
}

function flatText(node: NodeView): string {
	const own = nodeText(node);
	if (own.length > 0) return own;
	return node.kids.map(flatText).join("");
}

function styles(node: NodeView): string[] {
	return node.spans.map(part => part.s ?? "");
}

function metricChips(row: NodeView): NodeView[] {
	return row.kids.filter(node => node.role?.startsWith("omp.storm.live.") === true);
}

/**
 * The widget a native host draws for `host`, at `columns`: the tree under the slot's root. A wide host has a header
 * row (label, spacer, "[", field, "]") and a metrics row; a narrow one a single compact text node.
 */
function nativeDrawn(host: WidgetHost, columns = 100): NodeView {
	host.terminal.columns = columns;
	const root = host.nodes.get(LIVE_WIDGET_KEY);
	if (root === undefined) throw new Error("no native widget installed");
	const drawn = view(root).kids[0];
	if (drawn === undefined) throw new Error("the native widget drew nothing");
	return drawn;
}

/** A native (Tern) host showing `run`, the way the factory is mounted there; `show` runs inside `scope` when given. */
function nativeShow(run: RunRecord, phase: RunPhase = "working", scope?: Settings): { host: WidgetHost; live: LiveStatus } {
	setNativeRenderingForTest(true);
	const host = widgetHost();
	const live = liveForTest();
	if (scope === undefined) live.show(host.ctx, run, phase);
	else withActiveSettings(scope, () => live.show(host.ctx, run, phase));
	return { host, live };
}

const liveHeader = (phase: RunPhase): string => `${STORM_MARK} · ${RUN_APPEARANCE[phase].label}`;
const radar = /\[[⠁-⣿]{18}\]$/;

const activeWidgets: LiveStatus[] = [];
const realLaneViewFrame = frameModule.laneViewFrame;
const SSH_VARIABLES = ["SSH_CONNECTION", "SSH_TTY"] as const;
const savedEnv = new Map<string, string | undefined>(SSH_VARIABLES.map(name => [name, process.env[name]]));
const defaultTheme = currentTheme();

function restoreEnv(): void {
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

/** Makes the ASCII symbol preset the active theme, as `/settings` does; the mounted widget must follow it. */
function useAscii(): void {
	setCurrentTheme(loadThemeSync("dark", { symbolPreset: "ascii" }));
}

function useDefaultTheme(): void {
	setCurrentTheme(defaultTheme as ReturnType<typeof loadThemeSync>);
}

/** The single status line: the lane view is switched off, whatever the terminal's size. */
function liveForTest(): LiveStatus {
	const live = new LiveStatus({ now: () => NOW, laneView: () => false });
	activeWidgets.push(live);
	return live;
}

/** One microtask turn after omp's settings listener fired (it coalesces a burst into one). */
const settled = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

/** The session's settings with `tui.motion` / `display.shimmer`; `run` shows the run inside their scope, as a handler does. */
function inMotion<T>(overrides: Record<string, unknown>, run: (settings: Settings) => T): T {
	const settings = Settings.isolated(overrides);
	return withActiveSettings(settings, () => run(settings));
}

const setSetting = (settings: Settings, id: string, value: string): void => lookup(id)!.override(settings, value);

afterEach(() => {
	for (const live of activeWidgets.splice(0)) live.clear();
	restoreEnv();
	vi.useRealTimers();
	setNativeRenderingForTest(false);
	useDefaultTheme();
});

describe("the live run widget", () => {
	test("whole metric chips fit at 60, while narrow hosts keep the phase and then phase counters", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		expect(live.show(host.ctx, RUN)).toBe(true);
		expect(host.statuses).toEqual([undefined]);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const header = liveHeader("working");
		for (const width of [120, 80, 60, 52]) {
			const rows = component.render(width);
			const [title, metrics] = plain(rows);
			expect(rows).toHaveLength(2);
			expect(rows.every(line => visibleWidth(line) <= width)).toBe(true);
			expect(title).toStartWith(header);
			expect(title).toMatch(radar);
			expect(metrics).toBe(`› ${COUNTERS}`);
		}
		// 49 cells of whole chips, including emoji widths, fit inside the 60-cell acceptance width.
		expect(visibleWidth(component.render(60)[1]!)).toBe(49);

		const narrow: Array<[number, string]> = [
			// Elapsed is dropped before the Storm mark or a counter; at 51 the mark keeps the compact cost.
			[51, `${header} · ↻ 1/4라운드 · 👥 1/2 · 💲 $0.12`],
			[45, `${header} · ↻ 1/4 · 👥 1/2 · 💲 $0.12`],
			[40, `${header} · ↻ 1/4라운드 · 👥 1/2`],
			[39, `${header} · ↻ 1/4 · 👥 1/2`],
			[30, "진행 중 · ↻ 1/4라운드 · 👥 1/2"],
			[25, "진행 중 · ↻ 1/4 · 👥 1/2"],
			[24, "진행 중 · ↻ 1/4 · 👥 1/2"],
			[21, "진행 중 · ↻ 1/4라운드"],
			[20, "진행 중 · ↻ 1/4"],
			[17, "진행 중 · ↻ 1/4"],
			[14, "진행 중"],
			[8, "진행 중"],
		];
		for (const [width, expected] of narrow) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(plain(rows)[0]).toBe(expected);
			expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
			expect(plain(rows)[0]).not.toMatch(radar);
			expect(vi.getTimerCount()).toBe(0);
		}
		// Below the phase word itself only the phase may truncate; no chip or separator is ever clipped.
		const clipped = component.render(6);
		expect(clipped).toHaveLength(1);
		expect(plain(clipped)[0]).toBe("진행 …");
		expect(visibleWidth(clipped[0]!)).toBeLessThanOrEqual(6);
		expect(component.render(0)).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);

		// Waiting and stopping are not displaced by counters when the width cannot hold both.
		for (const phase of ["waiting-user", "stopping"] as const) {
			live.show(host.ctx, RUN, phase);
			expect(plain(component.render(12))[0]).toBe(RUN_APPEARANCE[phase].label);
			expect(plain(component.render(8))[0]).toEndWith("…");
			expect(plain(component.render(6))[0]).toEndWith("…");
		}

		const radarOf = (phase: RunPhase): string => {
			live.show(host.ctx, RUN, phase);
			return plain(component.render(120))[0]!.match(radar)![0];
		};
		expect(new Set([radarOf("working"), radarOf("waiting-user"), radarOf("stopping")]).size).toBe(3);

		// The running/total pair is explicit even when the ledger has no agents left.
		live.show(host.ctx, { ...RUN, agents: [] });
		expect(plain(component.render(60))[1]).toBe("› ↻ 1/4라운드 · 👥 0/0 · 💲 $0.1200/$5.00 · ⏱ 3분");
		live.clear();
	});

	test("an uncapped run shows the round without a maximum, at 60 cells and in the native chips", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const { maxRounds: _capped, ...open } = RUN;
		live.show(host.ctx, { ...open, turns: 2 });
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const rows = component.render(60);
		expect(rows.every(line => visibleWidth(line) <= 60)).toBe(true);
		expect(plain(rows)[1]).toBe("› ↻ 3라운드 · 👥 1/2 · 💲 $0.1200/$5.00 · ⏱ 3분");
		live.clear();
		const native = nativeShow({ ...open, turns: 2 });
		const metrics = nativeDrawn(native.host).kids[1]!;
		expect(metricChips(metrics).map(chip => chip.aria)[0]).toBe("라운드 3");
	});

	test("a still phase stops the one timer immediately and snaps to still; resuming and ending leave no extra", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(vi.getTimerCount()).toBe(0);
		const first = component.render(120);
		expect(vi.getTimerCount()).toBe(1);
		const ticking = host.requestCount();
		vi.advanceTimersByTime(100);
		const next = component.render(120);
		expect(host.requestCount()).toBeGreaterThan(ticking);
		expect(plain(next)[0]).toStartWith(liveHeader("working"));
		expect(plain(next)[0]!.match(radar)?.[0]).not.toBe(plain(first)[0]!.match(radar)?.[0]);
		expect(next[1]).toBe(first[1]);

		for (const phase of ["waiting-user", "between-rounds", "stopping"] as const) {
			live.show(host.ctx, RUN, phase);
			expect(vi.getTimerCount()).toBe(0);
			const requests = host.requestCount();
			vi.advanceTimersByTime(1_000);
			expect(host.requestCount()).toBe(requests);
			const [title, metrics] = plain(component.render(120));
			expect(title).toStartWith(liveHeader(phase));
			expect(title).toMatch(radar);
			expect(metrics).toBe(`› ${COUNTERS}`);
			expect(vi.getTimerCount()).toBe(0);
		}

		// Resume an active phase: one interval, not one more per pause.
		live.show(host.ctx, RUN, "verifying");
		expect(vi.getTimerCount()).toBe(1);
		live.show(host.ctx, RUN, "verifying");
		expect(vi.getTimerCount()).toBe(1);
		const resumed = host.requestCount();
		vi.advanceTimersByTime(100);
		expect(host.requestCount()).toBeGreaterThan(resumed);

		live.clear();
		expect(vi.getTimerCount()).toBe(0);
		const ended = host.requestCount();
		vi.advanceTimersByTime(1_000);
		expect(host.requestCount()).toBe(ended);
		expect(host.statuses).toEqual([undefined]);
	});

	test("native metrics carry whole labels and aria; a narrow host gets one compact line", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		live.clear();
		const native = nativeShow(RUN);
		const metrics = nativeDrawn(native.host).kids[1]!;
		const chips = metricChips(metrics);
		expect(chips.map(nodeText)).toEqual(["↻ 1/4라운드", "👥 1/2", "💲 $0.1200/$5.00", "⏱ 3분"]);
		expect(chips.map(chip => chip.aria)).toEqual([
			"라운드 1/4",
			"워커 실행 중 1/2",
			"비용 $0.1200 / 예산 $5.00",
			"경과 3분",
		]);
		expect(flatText(metrics)).toBe(`› ${COUNTERS}`);

		const narrow = nativeDrawn(native.host, 38);
		expect(flatText(narrow)).toBe("≋ STORM · 진행 중 · ↻ 1/4 · 👥 1/2");
		expect(narrow.aria).toBe("≋ STORM · 진행 중: 라운드 1/4 · 워커 실행 중 1/2");
		native.live.clear();
	});

	test("only the approved budget thresholds tint spend; the state word carries it too", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const budget = { perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" as const };
		const unbudgeted: RunRecord = { ...RUN, costUsd: 99 };
		delete unbudgeted.budget;
		live.show(host.ctx, { ...RUN, costUsd: 3.5, budget });
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $3.50/$5.00 · ⏱ 3분");
		live.show(host.ctx, { ...RUN, costUsd: 4, budget });
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $4.00/$5.00 경고 · ⏱ 3분");
		live.show(host.ctx, { ...RUN, costUsd: 5.5, budget });
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $5.50/$5.00 초과 · ⏱ 3분");
		// No approved budget means no warning/overage policy to apply, even at a large spend.
		live.show(host.ctx, unbudgeted);
		expect(plain(component.render(120))[1]).toBe("› ↻ 1/4라운드 · 👥 1/2 · 💲 $99.00 · ⏱ 3분");
		live.clear();

		// The same thresholds in the native chips, drawn by a native host.
		const native = nativeShow({ ...RUN, costUsd: 3.5, budget });
		const costChip = () =>
			metricChips(nativeDrawn(native.host).kids[1]!).find(chip => chip.role === "omp.storm.live.cost")!;
		expect(styles(costChip()).some(style => style.includes("warning") || style.includes("error"))).toBe(false);

		native.live.show(native.host.ctx, { ...RUN, costUsd: 4, budget });
		const warned = styles(costChip());
		expect(warned).toContain("warning strong");
		expect(warned).toContain("warning");
		expect(costChip().aria).toBe("비용 $4.00 / 예산 $5.00, 예산 경고");

		native.live.show(native.host.ctx, { ...RUN, costUsd: 5.5, budget });
		const over = styles(costChip());
		expect(over).toContain("error strong");
		expect(over).toContain("error");

		native.live.show(native.host.ctx, unbudgeted);
		expect(styles(costChip()).some(style => style.includes("warning") || style.includes("error"))).toBe(false);
	});

	test("a terminal radar follows omp's motion setting at once and runs one timer; a still setting leaves none", async () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		await inMotion({}, async settings => {
			live.show(host.ctx, RUN);
			const component = host.widgets.get(LIVE_WIDGET_KEY)!;
			component.render(120);
			expect(vi.getTimerCount()).toBe(1);

			setSetting(settings, "display.shimmer", "disabled");
			await settled();
			expect(vi.getTimerCount()).toBe(0);
			const disabled = component.render(120);
			vi.advanceTimersByTime(500);
			expect(component.render(120)).toEqual(disabled);
			expect(vi.getTimerCount()).toBe(0);

			setSetting(settings, "display.shimmer", "classic");
			await settled();
			expect(vi.getTimerCount()).toBe(1);
			setSetting(settings, "tui.motion", "reduced");
			await settled();
			expect(vi.getTimerCount()).toBe(0);
			component.render(120);
			expect(vi.getTimerCount()).toBe(0);
			setSetting(settings, "tui.motion", "none");
			await settled();
			expect(vi.getTimerCount()).toBe(0);

			setSetting(settings, "tui.motion", "full");
			await settled();
			expect(vi.getTimerCount()).toBe(1);
			live.clear();
			expect(vi.getTimerCount()).toBe(0);
			// The listener went with the widget: a later change starts nothing.
			setSetting(settings, "tui.motion", "none");
			setSetting(settings, "tui.motion", "full");
			await settled();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	test("a run that starts under reduced motion draws its radar still and starts no timer", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		inMotion({ "tui.motion": "reduced" }, () => live.show(host.ctx, RUN));
		const rows = host.widgets.get(LIVE_WIDGET_KEY)!.render(120);
		expect(plain(rows)[0]).toMatch(radar);
		expect(vi.getTimerCount()).toBe(0);
		live.clear();
	});

	test("Tern draws the radar as a shimmer the host clocks, and keeps it still in compact mode, under reduced motion or in a still phase", () => {
		vi.useFakeTimers();
		const parts = (drawn: NodeView) => {
			const [header, metrics] = drawn.kids;
			const [label, , , field] = header!.kids;
			return { label: label!, field: field!, metrics: metrics! };
		};
		const native = nativeShow(RUN);
		const { label, field, metrics } = parts(nativeDrawn(native.host, 100));
		expect(nodeText(label)).toBe(liveHeader("working"));
		expect(field.kind).toBe("shimmer");
		expect(`[${field.text}]`).toMatch(radar);
		expect(flatText(metrics)).toBe(`› ${COUNTERS}`);
		// The palette names theme colours the host knows.
		expect(Object.values(field.palette ?? {}).every(key => currentTheme().has(key))).toBe(true);
		// The host owns this animation: no Storm timer, and the widget asks for no repaint on a clock.
		expect(vi.getTimerCount()).toBe(0);
		const requests = native.host.requestCount();
		vi.advanceTimersByTime(500);
		expect(native.host.requestCount()).toBe(requests);

		expect(flatText(nativeDrawn(native.host, 38))).toBe("≋ STORM · 진행 중 · ↻ 1/4 · 👥 1/2");
		expect(nativeDrawn(native.host, 38).kind).toBe("text");

		// A still phase keeps the track as plain toned text.
		native.live.show(native.host.ctx, RUN, "waiting-user");
		const waiting = parts(nativeDrawn(native.host, 100));
		expect(waiting.field.kind).toBe("text");
		expect(waiting.label.spans.map(part => part.s)).toEqual(["accent", "dim", "warning"]);
		native.live.show(native.host.ctx, RUN, "working");
		expect(parts(nativeDrawn(native.host, 100)).field.kind).toBe("shimmer");
		native.live.clear();
		expect(native.host.nodes.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("Tern keeps the radar still when omp's motion is reduced, off or its shimmer disabled, and follows a change", async () => {
		for (const overrides of [{ "tui.motion": "reduced" }, { "tui.motion": "none" }, { "display.shimmer": "disabled" }]) {
			const settings = Settings.isolated(overrides);
			const native = nativeShow(RUN, "working", settings);
			expect(nativeDrawn(native.host, 100).kids[0]!.kids[3]!.kind).toBe("text");
			native.live.clear();
		}
		const settings = Settings.isolated({ "tui.motion": "none" });
		const native = nativeShow(RUN, "working", settings);
		expect(nativeDrawn(native.host, 100).kids[0]!.kids[3]!.kind).toBe("text");
		setSetting(settings, "tui.motion", "full");
		await settled();
		expect(nativeDrawn(native.host, 100).kids[0]!.kids[3]!.kind).toBe("shimmer");
		setSetting(settings, "tui.motion", "reduced");
		await settled();
		expect(nativeDrawn(native.host, 100).kids[0]!.kids[3]!.kind).toBe("text");
	});

	test("a native drawing follows the terminal width and a theme switch; a host that flips to native gets nodes, and back", () => {
		vi.useFakeTimers();
		setNativeRenderingForTest(false);
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		host.widgets.get(LIVE_WIDGET_KEY)!.render(120);
		expect(vi.getTimerCount()).toBe(1);
		expect(host.nodes.size).toBe(0);

		// The process turns native: the next show installs the node tree and no Storm timer remains.
		setNativeRenderingForTest(true);
		live.show(host.ctx, RUN);
		expect(host.installs).toHaveLength(2);
		expect(host.nodes.size).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(nativeDrawn(host, 100).kids).toHaveLength(2);
		expect(nativeDrawn(host, 40).kind).toBe("text");
		expect(nativeDrawn(host, 100).kind).toBe("col");
		expect(flatText(nativeDrawn(host, 100))).toContain("≋ STORM");
		useAscii();
		expect(flatText(nativeDrawn(host, 100))).toContain(ASCII_MARK);
		expect(vi.getTimerCount()).toBe(0);

		// And back to the terminal: rows again, the timer returns with the first render.
		setNativeRenderingForTest(false);
		live.show(host.ctx, RUN);
		expect(host.installs).toHaveLength(3);
		host.widgets.get(LIVE_WIDGET_KEY)!.render(120);
		expect(vi.getTimerCount()).toBe(1);
		live.clear();
	});

	test("the ASCII preset rebuilds the mark, radar and chips without braille; phases stay distinct", () => {
		useAscii();
		expect(currentTheme().symbols.preset).toBe("ascii");
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const rows = component.render(60);
		expect(rows).toHaveLength(2);
		expect(plain(rows)[0]).toStartWith(`${ASCII_MARK} - 진행 중`);
		expect(plain(rows)[1]).toBe(`> ${ASCII_COUNTERS}`);
		expect(plain(rows)[1]).not.toContain("$ $");
		expect(visibleWidth(rows[1]!)).toBe(50);
		expect(rows.every(row => visibleWidth(row) <= 60)).toBe(true);
		expect(plain(rows).join("\n")).not.toMatch(/[\u2801-\u28ff≋↻👥💲⏱›·…]/);

		const fieldOf = (phase: RunPhase): string => {
			live.show(host.ctx, RUN, phase);
			const title = plain(component.render(60))[0]!;
			return title.slice(title.lastIndexOf("[") + 1, -1);
		};
		const working = fieldOf("working");
		const waiting = fieldOf("waiting-user");
		const stopping = fieldOf("stopping");
		expect(working).toBe("~-~-~-~-~-~-~-~-~-");
		expect(waiting).toBe("= = = = = = = = = ");
		expect(stopping).toBe("|/|/|/|/|/|/|/|/|/");
		expect(new Set([working, waiting, stopping]).size).toBe(3);

		live.clear();
		const nativeAscii = nativeShow(RUN);
		const drawn = nativeDrawn(nativeAscii.host, 100);
		const [headerRow, metrics] = drawn.kids;
		expect(nodeText(headerRow!.kids[0]!)).toStartWith(`${ASCII_MARK} - `);
		expect(`[${headerRow!.kids[3]!.text}]`).toMatch(/^\[[ -~]{18}\]$/);
		expect(flatText(metrics!)).toBe(`> ${ASCII_COUNTERS}`);
		const asciiCost = metricChips(metrics!).find(chip => chip.role === "omp.storm.live.cost")!;
		expect(nodeText(asciiCost)).toBe("$0.1200/$5.00");
		expect(asciiCost.aria).toBe("비용 $0.1200 / 예산 $5.00");
		expect(flatText(nativeDrawn(nativeAscii.host, 38))).toBe(`${ASCII_MARK} - 진행 중 - loop 1/4 - AG 1/2`);
	});

	test("ASCII width pressure keeps cost plus limit intact and drops elapsed first", () => {
		useAscii();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, { ...RUN, costUsd: 4, budget: { perRunUsd: 5, warnAtUsd: 4, onExceed: "block-spawns" } });
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const rows = component.render(52);
		expect(plain(rows)[1]).toBe("> loop 1/4라운드 - AG 1/2 - $4.00/$5.00 경고");
		expect(plain(rows)[1]).not.toContain("t:");
		expect(plain(rows)[1]).not.toContain("$ $");
		expect(visibleWidth(rows[1]!)).toBeLessThanOrEqual(52);
		live.clear();
	});

	test("a runtime theme change invalidates the cached rows: the widget draws the theme active now, not the one it was built with", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(plain(component.render(60))[1]).toBe(`› ${COUNTERS}`);

		useAscii();
		expect(plain(component.render(60))[1]).toBe(`> ${ASCII_COUNTERS}`);
		expect(plain(component.render(60))[0]).toStartWith(`${ASCII_MARK} - 진행 중`);
		useDefaultTheme();
		expect(plain(component.render(60))[1]).toBe(`› ${COUNTERS}`);
		live.clear();
	});

	test("a live update reuses the component and redraws the new phase, round and spend", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		component.render(120);
		const installs = host.installs.length;
		expect(vi.getTimerCount()).toBe(1);

		const next = { ...RUN, turns: 1, costUsd: 0.2 };
		expect(live.show(host.ctx, next, "verifying")).toBe(true);
		expect(host.installs).toHaveLength(installs);
		expect(vi.getTimerCount()).toBe(1);
		const [heading, metrics] = plain(component.render(220));
		expect(heading).toStartWith(liveHeader("verifying"));
		expect(metrics).toContain("2/4라운드");
		expect(metrics).toContain("$0.2000/$5.00");
		expect(host.statuses).toEqual([undefined]);

		live.clear();
	});

	test("result progress leads worker chips and repaints when only the ledger changes", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const run: RunRecord = {
			...RUN,
			plan: {
				lanes: [
					{
						name: "api",
						kind: "code",
						role: "implementer",
						results: [{ id: "api", kind: "change", criterion: "API 검증" }],
					},
				],
				workers: { implementer: 1 },
				submittedAt: "2026-11-20T09:00:00.000Z",
			},
			results: [
				{ id: "api", lane: "api", state: "unmet", reason: "응답 계약이 다릅니다." },
				{ id: "docs", lane: "api", state: "accepted", reason: "문서 갱신을 확인했습니다." },
			],
		};
		live.show(host.ctx, run);
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		for (const width of [200, 120]) {
			const row = plain(component.render(width))[1]!;
			expect(row).toContain("API 검증");
			expect(row).toContain("미충족");
			expect(row.indexOf("API 검증")).toBeLessThan(row.indexOf("↻"));
			expect(visibleWidth(component.render(width)[1]!)).toBeLessThanOrEqual(width);
		}
		const compact = plain(component.render(60))[1]!;
		expect(compact).toContain("미충족");
		if (compact.includes("↻")) expect(compact.indexOf("미충족")).toBeLessThan(compact.indexOf("↻"));
		expect(visibleWidth(component.render(60)[1]!)).toBeLessThanOrEqual(60);
		const metrics = plain(component.render(200))[1]!;
		expect(metrics).toStartWith("› 🎯 API 검증 미충족 · 이행 1/2");
		const narrow = plain(component.render(30))[0]!;
		expect(narrow).toContain("미충족");
		expect(visibleWidth(component.render(30)[0]!)).toBeLessThanOrEqual(30);


		// The counters stay identical; only the ledger settles. The key must still repaint the widget.
		const requests = host.requestCount();
		live.show(host.ctx, {
			...run,
			results: [
				{ id: "api", lane: "api", state: "accepted", reason: "응답 계약을 확인했습니다." },
				{ id: "docs", lane: "api", state: "accepted", reason: "문서 갱신을 확인했습니다." },
			],
		});
		expect(host.requestCount()).toBeGreaterThan(requests);
		expect(plain(component.render(200))[1]).toContain("API 검증 이행 2/2");
		expect(plain(component.render(200))[1]).not.toContain("미충족");
		live.clear();

		const native = nativeShow(run);
		const nativeChips = metricChips(nativeDrawn(native.host).kids[1]!);
		expect(nativeChips[0]!.role).toBe("omp.storm.live.results");
		expect(nativeChips[0]!.aria).toBe("결과 API 검증 (api) · 이행 1/2 · 미충족 1");
		native.live.clear();
		setNativeRenderingForTest(false);

	});

	test("a long result criterion leads at 60 and leaves whole lower-priority chips to roomier rows", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		// The real acceptance criterion is long enough that its full result form owns a 60-column metrics row.
		const criterion = "report what e2e-tracked.txt line 1 says";
		const run: RunRecord = {
			...RUN,
			agents: [agentEntry({ id: "Impl", state: "running" })],
			plan: {
				lanes: [
					{
						name: "impl",
						kind: "code",
						role: "implementer",
						results: [{ id: "impl-answer", kind: "answer", criterion }],
					},
				],
				workers: { implementer: 1 },
				submittedAt: "2026-11-20T09:00:00.000Z",
			},
			results: [{ id: "impl-answer", lane: "impl", state: "pending" }],
		};
		live.show(host.ctx, run, "workers");
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;

		// Result-first is the whole row here: a shorter result form would fit more chips, but the criterion wins.
		const compact = plain(component.render(60));
		expect(compact).toHaveLength(2);
		expect(compact[0]).toStartWith(`${STORM_MARK} · ${RUN_APPEARANCE.workers.label}`);
		expect(compact[1]).toBe(`› 🎯 ${criterion} 대기 · 이행 0/1`);
		expect(visibleWidth(component.render(60)[1]!)).toBeLessThanOrEqual(60);

		// With room, the same result still leads; the round, active worker, spend and elapsed chips follow whole.
		const wide = plain(component.render(120))[1]!;
		expect(wide).toBe(`› 🎯 ${criterion} 대기 · 이행 0/1 · ↻ 1/4라운드 · 👥 1/1 · 💲 $0.1200/$5.00 · ⏱ 3분`);
		expect(visibleWidth(component.render(120)[1]!)).toBeLessThanOrEqual(120);

		// The ASCII preset keeps the same result-first row and readable ASCII cost; no Unicode fallback returns.
		useAscii();
		expect(plain(component.render(60))[1]).toBe(`> ${criterion} 대기 · 이행 0/1`);
		const asciiWide = plain(component.render(120))[1]!;
		expect(asciiWide).toBe(`> ${criterion} 대기 · 이행 0/1 - loop 1/4라운드 - AG 1/1 - $0.1200/$5.00 - t: 3분`);
		expect(asciiWide).not.toMatch(/[\u2801-\u28ff≋↻👥💲⏱›]/u);
		expect(asciiWide).not.toContain("$ $");
		live.clear();
		useDefaultTheme();

		// The same row as native chips, whole and in the same order.
		const native = nativeShow(run, "workers");
		const compactChips = metricChips(nativeDrawn(native.host, 60).kids[1]!);
		expect(compactChips.map(chip => chip.role)).toEqual(["omp.storm.live.results"]);
		expect(compactChips[0]!.aria).toBe(`결과 ${criterion} (impl-answer) · 이행 0/1 · 대기 1`);
		const wideChips = metricChips(nativeDrawn(native.host, 120).kids[1]!);
		expect(wideChips.map(chip => chip.role)).toEqual([
			"omp.storm.live.results",
			"omp.storm.live.round",
			"omp.storm.live.workers",
			"omp.storm.live.cost",
			"omp.storm.live.time",
		]);
	});

	test("an operator-excluded result is visibly listed but never counted in scope", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		const excluded = { id: "skip", state: "accepted", scope: "excluded-by-user" } as unknown as RunResult;
		live.show(host.ctx, {
			...RUN,
			results: [{ id: "blocked", lane: "api", state: "unmet", reason: "검증이 막혔습니다." }, excluded],
		});
		const component = host.widgets.get(LIVE_WIDGET_KEY)!;
		const metrics = plain(component.render(200))[1]!;
		expect(metrics).toContain("이행 0/1");
		expect(metrics).toContain("제외 1");
		expect(metrics).not.toContain("0/2");
		live.clear();
		const native = nativeShow({
			...RUN,
			results: [{ id: "blocked", lane: "api", state: "unmet", reason: "검증이 막혔습니다." }, excluded],
		});
		const nativeChips = metricChips(nativeDrawn(native.host, 200).kids[1]!);
		expect(nativeChips[0]!.aria).toBe("결과 blocked · 이행 0/1 · 미충족 1 · 사용자 제외 1");
	});

	test("dispose or a replaced host stops the old component; the next show installs a fresh one", () => {
		vi.useFakeTimers();
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const first = host.widgets.get(LIVE_WIDGET_KEY)!;
		first.render(120);
		expect(vi.getTimerCount()).toBe(1);

		first.dispose?.();
		expect(vi.getTimerCount()).toBe(0);
		expect(first.render(120)).toEqual([]);

		live.show(host.ctx, { ...RUN, turns: 1 });
		expect(host.installs).toHaveLength(2);
		const second = host.widgets.get(LIVE_WIDGET_KEY)!;
		expect(second).not.toBe(first);
		second.render(120);
		expect(vi.getTimerCount()).toBe(1);

		// A new host object replaces the widget in place of the old session's component.
		const replacement = widgetHost();
		live.show(replacement.ctx, RUN, "waiting-user");
		expect(vi.getTimerCount()).toBe(0);
		const third = replacement.widgets.get(LIVE_WIDGET_KEY)!;
		expect(third).not.toBe(second);
		expect(plain(third.render(120))[0]).toStartWith(liveHeader("waiting-user"));

		live.clear();
		expect(vi.getTimerCount()).toBe(0);
		expect(replacement.widgets.size).toBe(0);
	});

	test("only the main TUI gets a widget; RPC keeps the plain path and a switch invalidates old work", () => {
		const host = widgetHost();
		const live = liveForTest();
		expect(live.show({ ...host.ctx, mode: "rpc" } as ExtensionContext, RUN, "working")).toBe(false);
		expect(host.installs).toHaveLength(0);
		expect(host.statuses).toEqual([]);
		expect(live.show({ ...host.ctx, agent: { kind: "sub" } } as ExtensionContext, RUN)).toBe(false);

		expect(live.show(host.ctx, RUN, "waiting-user")).toBe(true);
		const epoch = live.epoch();
		const next = live.beginSession();
		expect(next).not.toBe(epoch);
		expect(live.isCurrent(epoch)).toBe(false);
		expect(live.isCurrent(next)).toBe(true);
		expect(host.widgets.size).toBe(0);
	});
});

// ---- The lane view ----------------------------------------------------------------------------------------------

const LONG_LANE = "아주긴한글레인이름아주긴한글레인이름아주긴한글레인이름";
const iso = (ms: number): string => new Date(ms).toISOString();
/** The cap on the view's rows for a terminal of this many rows, written out again so a drifting constant is caught. */
const heightFor = (rows: number): number => Math.min(12, Math.max(6, Math.floor(rows / 3)));
/** What `laneRun()` draws: the status row, the trunk and one row for each of its four lanes. */
const LANE_RUN_ROWS = 6;
/** A plan of `count` lanes that have not started, so every one has a row to draw (or to fold). */
const manyLanes = (count: number): RunRecord => {
	const run = laneRun();
	return {
		...run,
		plan: { ...run.plan!, lanes: Array.from({ length: count }, (_, at) => ({ name: `Lane${at}`, kind: "code" as const, role: "implementer" })) },
		agents: [],
		spawns: [],
	};
};

/** A run with a plan: two workers running, a reviewer lane that waits for one of them, and a lane with a very long name. */
function laneRun(over: Partial<RunRecord> = {}, now = NOW): RunRecord {
	const worker = (id: string) => agentEntry({ id, state: "running", startedAt: now - 120_000, lastActivityAt: now - 1_000 });
	return runRecord({
		runId: "run-lane",
		status: "running",
		startedAt: iso(now - 180_000),
		turns: 1,
		maxRounds: 4,
		plan: {
			submittedAt: iso(now - 170_000),
			workers: { implementer: 3, reviewer: 1 },
			lanes: [
				{ name: "Api", kind: "code", role: "implementer" },
				{ name: "Ui", kind: "code", role: "implementer" },
				{ name: LONG_LANE, kind: "code", role: "implementer" },
				{ name: "Check", kind: "review", role: "reviewer", dependsOn: [{ lane: "Api", need: "reviewable" }] },
			],
		},
		agents: [worker("Api"), worker("Ui"), worker("Long")],
		spawns: [
			spawnRecord({ spawnKey: "Api", lane: "Api" }),
			spawnRecord({ spawnKey: "Ui", lane: "Ui" }),
			spawnRecord({ spawnKey: "Long", lane: LONG_LANE }),
		],
		...over,
	});
}

/** The same plan with every worker settled: the lanes idle and the picture has nothing running. */
function settledRun(over: Partial<RunRecord> = {}): RunRecord {
	const run = laneRun(over);
	return { ...run, agents: (run.agents ?? []).map(agent => ({ ...agent, state: "idle" })) };
}

interface LaneSetup {
	live: LiveStatus;
	clock: { now: number };
	host: WidgetHost;
	component: () => Widget;
	/** Shows the run through the status and returns nothing; the host's widget is `component()`. */
	show: (run: RunRecord, phase?: RunPhase) => void;
}

/** A status with the lane view on (or following `switch`), on a host with a `rows` tall terminal and a movable clock. */
function laneSetup(options: { rows?: number; switch?: () => boolean; settings?: Settings } = {}): LaneSetup {
	const clock = { now: NOW };
	const live = new LiveStatus({ now: () => clock.now, laneView: options.switch ?? (() => true) });
	activeWidgets.push(live);
	const host = widgetHost(options.rows ?? 40);
	return {
		live,
		clock,
		host,
		component: () => host.widgets.get(LIVE_WIDGET_KEY)!,
		show: (run, phase = "working") => {
			if (options.settings === undefined) live.show(host.ctx, run, phase);
			else withActiveSettings(options.settings, () => live.show(host.ctx, run, phase));
		},
	};
}

/** A waiting or between-rounds picture first lets its last events play out; this is the clock step that ends that. */
const SETTLE_MS = 3_000;
const RADAR_ROW = /\[[⠁-⣿]{18}\]$/;

describe("the result chip with many workers", () => {
	test("a hundred workers remain one bounded count, not a list", () => {
		const spawns = Array.from({ length: 120 }, (_, index) => spawnRecord({ spawnKey: `w${index}`, agent: `storm-explorer-${index}` }));
		const agents = spawns.map((spawn, index) =>
			agentEntry({ id: spawn.spawnKey!, state: index % 2 === 0 ? "running" : "idle", changes: index % 4 === 0 ? 1 : 0 }),
		);
		const run = runRecord({ status: "running", startedAt: new Date(NOW - 180_000).toISOString(), spawns, agents });
		const facts = liveMetricFacts(run, "workers", NOW);
		const chip = facts.chips.find(item => item.key === "results")!;
		expect(chip.forms.length).toBeLessThanOrEqual(3);
		for (const form of chip.forms) expect(`${form.value}${form.suffix ?? ""}`.length).toBeLessThan(40);
		expect(chip.aria).toContain(NO_DECLARED_RESULTS);
		expect(chip.aria).not.toContain("storm-explorer");
	});
});

describe("the live run widget in lane mode", () => {
	test("draws the status row without the radar, then only the rows the picture needs, never past the cap", () => {
		vi.useFakeTimers();
		for (const rows of [18, 21, 30, 40, 90]) {
			for (const columns of [60, 61, 100, 200]) {
				const lane = laneSetup({ rows });
				lane.show(laneRun());
				const drawn = lane.component().render(columns);
				const text = plain(drawn);
				// Four lanes need six rows; the cap of the smallest lane terminal is six, so the cap never cuts this plan.
				expect(drawn).toHaveLength(Math.min(LANE_RUN_ROWS, heightFor(rows)));
				expect(drawn.every(row => visibleWidth(row) <= columns)).toBe(true);
				// No blank row anywhere, least of all under the last lane.
				expect(text.every(row => row.trim() !== "")).toBe(true);
				// A run with workers and no declared results says so in its status row; the radar stays off it.
				expect(text[0]).toContain(NO_DECLARED_RESULTS);
				expect(text[0]).not.toMatch(RADAR_ROW);
				expect(text[0]!.includes("[")).toBe(false);
				// The trunk and at least one lane have something on them; nothing below the picture is invented.
				expect(text[1]!.trim()).not.toBe("");
				expect(text[2]!.trim()).not.toBe("");
				lane.live.clear();
			}
		}
	});

	test("more lanes than the cap allows fold into one summary row and the view stays at the cap", () => {
		for (const rows of [18, 24, 36, 50, 90]) {
			const lane = laneSetup({ rows });
			lane.show(manyLanes(30));
			const drawn = plain(lane.component().render(120));
			expect(drawn).toHaveLength(heightFor(rows));
			expect(drawn).toHaveLength(laneHeight(rows));
			expect(drawn.every(row => row.trim() !== "")).toBe(true);
			expect(drawn[0]).toStartWith(STORM_MARK);
			lane.live.clear();
		}
		// A plan that just fits is not folded: the cap is reached by the rows it needs, not by padding.
		const fits = laneSetup({ rows: 36 });
		fits.show(manyLanes(laneHeight(36) - 2));
		expect(plain(fits.component().render(120))).toHaveLength(laneHeight(36));
		fits.live.clear();
	});

	test("the view is as tall as its plan (at least the stage's five rows): a lane more or fewer is a row more or fewer, with nothing blank under it", () => {
		const lane = laneSetup({ rows: 50 });
		const heights: number[] = [];
		for (const count of [1, 3, 8, 2, 5]) {
			lane.show(manyLanes(count));
			const drawn = plain(lane.component().render(120));
			heights.push(drawn.length);
			expect(drawn.at(-1)!.trim()).not.toBe("");
			expect(drawn.every(row => row.trim() !== "")).toBe(true);
			// What the context panel subtracts from its budget is what the host really gives this widget.
			expect(liveWidgetRows()).toBe(drawn.length);
		}
		// At 120 columns the stage stands left of the graph: the picture is never shorter than its five rows.
		expect(heights).toEqual([6, 6, 10, 6, 7]);
		lane.live.clear();
		expect(liveWidgetRows()).toBe(0);
	});

	test("row 0 is today's status line: mark, phase and the same chips", () => {
		const lane = laneSetup();
		lane.show(RUN);
		expect(plain(lane.component().render(120))[0]).toBe(`${liveHeader("working")} · ${COUNTERS}`);
		// At the contract's smallest width the chips shrink exactly as they do in the single line.
		const narrow = plain(lane.component().render(60))[0]!;
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(60);
		expect(narrow).toStartWith(STORM_MARK);
	});

	test("I1 and T4: the status row offers the agent hub when a lane has a worker, and the stage's phrase reaches both drawings", () => {
		const lane = laneSetup();
		lane.show(laneRun());
		const wide = plain(lane.component().render(120));
		expect(wide[0]).toStartWith(STORM_MARK);
		expect(wide[0]).toEndWith(LANE_HUB_HINT);
		expect(visibleWidth(wide[0]!)).toBe(120);
		// Three writers at work: the stage's last row says so.
		expect(wide.at(-1)).toStartWith("문어 · 일을 나눠 맡기는 중");
		// No room: the chips keep the row, the offer goes.
		expect(plain(lane.component().render(60))[0]).not.toContain(LANE_HUB_HINT);
		lane.live.clear();
		// A run without lane workers offers nothing to talk to.
		const idle = laneSetup();
		idle.show(RUN);
		expect(plain(idle.component().render(120))[0]).not.toContain(LANE_HUB_HINT);
		idle.live.clear();

		// The single line carries the phrase between the phase and the radar when it fits.
		const host = widgetHost();
		const live = liveForTest();
		live.show(host.ctx, RUN);
		const [title] = plain(host.widgets.get(LIVE_WIDGET_KEY)!.render(120));
		expect(title).toStartWith(`${liveHeader("working")} · 올빼미 · 직접 들여다보는 중`);
		expect(title).toMatch(RADAR_ROW);
		live.clear();
	});

	test("the boundary values: 18 rows and 60 columns are lane mode, one less is the single line", () => {
		const check = (rows: number, columns: number): readonly string[] => {
			const lane = laneSetup({ rows });
			lane.show(laneRun());
			const drawn = lane.component().render(columns);
			lane.live.clear();
			return drawn;
		};
		expect(check(18, 60)).toHaveLength(6);
		expect(check(17, 60).length).toBeLessThanOrEqual(2);
		expect(check(18, 59).length).toBeLessThanOrEqual(2);
		// The constants the widget exports are the same numbers.
		expect([LANE_MIN_ROWS, frameModule.LANE_MIN_COLUMNS]).toEqual([18, 60]);
	});

	test("a short or narrow terminal, the ASCII preset or an unknown height keeps the single line with its radar, exactly", () => {
		const lineOf = (host: WidgetHost, columns: number, phase: RunPhase = "working"): readonly string[] => {
			const live = liveForTest();
			live.show(host.ctx, RUN, phase);
			return host.widgets.get(LIVE_WIDGET_KEY)!.render(columns);
		};
		const laneOf = (host: WidgetHost, columns: number): readonly string[] => {
			const live = new LiveStatus({ now: () => NOW });
			activeWidgets.push(live);
			live.show(host.ctx, RUN, "working");
			return host.widgets.get(LIVE_WIDGET_KEY)!.render(columns);
		};
		const sameAsLine = (rows: number, columns: number): void => {
			const lineHost = widgetHost(rows);
			const laneHost = widgetHost(rows);
			const expected = lineOf(lineHost, columns);
			const actual = laneOf(laneHost, columns);
			expect(actual).toEqual(expected);
			expect(actual.length).toBeLessThanOrEqual(2);
		};
		sameAsLine(17, 120);
		sameAsLine(10, 120);
		sameAsLine(40, 59);
		sameAsLine(40, 52);
		sameAsLine(40, 30);
		// A host that cannot say how tall the terminal is gets the line too.
		const unknown = widgetHost();
		unknown.terminal.rows = Number.NaN;
		expect(laneOf(unknown, 120).length).toBeLessThanOrEqual(2);
		expect(plain(laneOf(unknown, 120))[0]).toMatch(RADAR_ROW);

		useAscii();
		sameAsLine(40, 120);
		expect(plain(laneOf(widgetHost(40), 120))[0]).toStartWith(ASCII_MARK);
	});

	test("native rendering draws the line as nodes, no lane view and no timer, whatever the switch and terminal height", () => {
		vi.useFakeTimers();
		setNativeRenderingForTest(true);
		const lane = laneSetup();
		lane.show(laneRun());
		// The factory returned a node tree, not rows, so there is nothing for a lane picture to be drawn into.
		expect(lane.host.widgets.size).toBe(0);
		expect(lane.host.nodes.size).toBe(1);
		expect(flatText(nativeDrawn(lane.host, 120))).toContain(RUN_APPEARANCE.working.label);
		expect(vi.getTimerCount()).toBe(0);
		lane.show(laneRun({ turns: 2 }), "verifying");
		expect(flatText(nativeDrawn(lane.host, 120))).toContain(RUN_APPEARANCE.verifying.label);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("the row count follows the drawing: resizing, narrowing, the preset or the switch change it, and it is never padded", () => {
		vi.useFakeTimers();
		let on = true;
		const lane = laneSetup({ rows: 40, switch: () => on });
		lane.show(laneRun());
		const draw = (columns: number): readonly string[] => {
			const rows = lane.component().render(columns);
			expect(rows.every(row => visibleWidth(row) <= columns)).toBe(true);
			// Whatever the drawing, no row is blank, and the widget reports exactly the rows it returned.
			expect(rows.every(row => row !== "")).toBe(true);
			expect(liveWidgetRows()).toBe(rows.length);
			return rows;
		};
		expect(draw(120)).toHaveLength(LANE_RUN_ROWS);
		// Shorter window, still tall enough: the picture, the same rows.
		lane.host.terminal.rows = 24;
		expect(plain(draw(120))[1]!.trim()).not.toBe("");
		expect(draw(120)).toHaveLength(LANE_RUN_ROWS);
		// Too short for lane mode: the two rows of the single line, nothing under them.
		lane.host.terminal.rows = 12;
		const short = draw(120);
		expect(short).toHaveLength(2);
		expect(plain(short)[0]).toMatch(RADAR_ROW);
		expect(plain(short)[1]).toStartWith("›");
		lane.host.terminal.rows = 40;
		expect(draw(120)).toHaveLength(LANE_RUN_ROWS);
		// Narrow: the compact line alone, which still names the missing declared results.
		const narrow = draw(50);
		expect(narrow).toHaveLength(1);
		expect(plain(narrow)[0]).toContain(NO_DECLARED_RESULTS);
		expect(draw(0)).toEqual([]);
		expect(liveWidgetRows()).toBe(0);
		// The switch off mid-run, then on again.
		on = false;
		lane.show(laneRun());
		const off = draw(120);
		expect(off).toHaveLength(2);
		expect(plain(off)[0]).toMatch(RADAR_ROW);
		on = true;
		lane.show(laneRun());
		expect(plain(draw(120))[0]).not.toMatch(RADAR_ROW);
		expect(draw(120)).toHaveLength(LANE_RUN_ROWS);
		// The ASCII preset mid-run: the line without braille, two rows.
		useAscii();
		const ascii = draw(120);
		expect(ascii).toHaveLength(2);
		expect(plain(ascii)[0]).toStartWith(ASCII_MARK);
		expect(plain(ascii).join("\n")).not.toMatch(/[⠁-⣿]/);
		setCurrentTheme(defaultTheme as ReturnType<typeof loadThemeSync>);
		expect(draw(100)).toHaveLength(LANE_RUN_ROWS);
	});

	test("the count does not move while the picture animates, only when the plan, the cap or the drawing does", () => {
		vi.useFakeTimers();
		const lane = laneSetup({ rows: 40 });
		lane.show(laneRun());
		const counts = new Set<number>();
		for (let step = 0; step < 40; step++) {
			lane.clock.now += 400;
			counts.add(lane.component().render(120).length);
		}
		expect([...counts]).toEqual([LANE_RUN_ROWS]);
	});

	test("a run that starts in the single line grows into the view when it fits, and shrinks back when it does not", () => {
		const lane = laneSetup({ rows: 40 });
		lane.show(laneRun());
		const narrow = lane.component().render(50);
		expect(narrow.length).toBeLessThanOrEqual(2);
		expect(lane.component().render(120)).toHaveLength(LANE_RUN_ROWS);
		expect(lane.component().render(50).length).toBeLessThanOrEqual(2);
		lane.host.terminal.rows = 90;
		expect(lane.component().render(120)).toHaveLength(LANE_RUN_ROWS);
	});

	test("one row of the picture is never wider than the terminal, with wide characters, in both colour modes", () => {
		for (const columns of [60, 63, 80, 117]) {
			const lane = laneSetup({ rows: 60 });
			lane.show(laneRun());
			const rows = lane.component().render(columns);
			expect(rows).toHaveLength(LANE_RUN_ROWS);
			expect(rows.every(row => visibleWidth(row) <= columns)).toBe(true);
			lane.live.clear();
		}
	});

	test("the animation ticks at 85 ms, 120 ms over SSH, and about four frames a second while it only breathes", () => {
		vi.useFakeTimers();
		delete process.env.SSH_CONNECTION;
		delete process.env.SSH_TTY;
		const ticks = (phase: RunPhase, ms: number, env?: string): number => {
			if (env !== undefined) process.env[env] = "1";
			const lane = laneSetup();
			lane.show(laneRun(), phase);
			if (phase === "waiting-user") lane.clock.now += SETTLE_MS;
			lane.component().render(120);
			expect(vi.getTimerCount()).toBe(1);
			const before = lane.host.requestCount();
			vi.advanceTimersByTime(ms);
			const seen = lane.host.requestCount() - before;
			lane.live.clear();
			expect(vi.getTimerCount()).toBe(0);
			if (env !== undefined) delete process.env[env];
			return seen;
		};
		expect(ticks("working", 1_020)).toBe(12);
		expect(ticks("working", 1_020, "SSH_CONNECTION")).toBe(8);
		expect(ticks("working", 1_020, "SSH_TTY")).toBe(8);
		const slow = ticks("waiting-user", 1_000);
		expect(slow).toBeGreaterThanOrEqual(3);
		expect(slow).toBeLessThanOrEqual(5);
	});

	test("a picture that does not move has no timer; an update that makes it lively starts one, and never a second", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		lane.show(settledRun(), "between-rounds");
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(0);
		const quiet = lane.host.requestCount();
		vi.advanceTimersByTime(5_000);
		expect(lane.host.requestCount()).toBe(quiet);

		lane.show(laneRun(), "working");
		expect(vi.getTimerCount()).toBe(1);
		lane.component().render(120);
		lane.show(laneRun({ turns: 2 }), "working");
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(1);

		// Waiting for the user slows it down but keeps the one timer.
		lane.show(laneRun(), "waiting-user");
		// The events of the moment before the wait play out at full pace first.
		expect(vi.getTimerCount()).toBe(1);
		lane.clock.now += SETTLE_MS;
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(1);
		const slowFrom = lane.host.requestCount();
		vi.advanceTimersByTime(1_000);
		expect(lane.host.requestCount() - slowFrom).toBeLessThanOrEqual(6);

		// And back to the full pace.
		lane.show(laneRun(), "working");
		lane.component().render(120);
		const fullFrom = lane.host.requestCount();
		vi.advanceTimersByTime(1_000);
		expect(lane.host.requestCount() - fullFrom).toBeGreaterThanOrEqual(10);

		lane.show(settledRun(), "between-rounds");
		expect(vi.getTimerCount()).toBe(1);
		lane.clock.now += SETTLE_MS;
		lane.component().render(120);
		expect(vi.getTimerCount()).toBe(0);
		const stopped = lane.host.requestCount();
		vi.advanceTimersByTime(5_000);
		expect(lane.host.requestCount()).toBe(stopped);
	});

	test("with motion off there is no timer and the picture is still, with its colours; turning it on starts the timer", async () => {
		vi.useFakeTimers();
		const settings = Settings.isolated({ "tui.motion": "none" });
		const lane = laneSetup({ settings });
		lane.show(laneRun());
		const first = lane.component().render(120);
		expect(vi.getTimerCount()).toBe(0);
		const requests = lane.host.requestCount();
		vi.advanceTimersByTime(5_000);
		expect(lane.host.requestCount()).toBe(requests);
		expect(lane.component().render(120)).toEqual(first);
		expect(first.some(row => row.includes("\x1b["))).toBe(true);
		expect(vi.getTimerCount()).toBe(0);

		// Motion back on: the timer comes back without another update, and the widget asks for a repaint.
		setSetting(settings, "tui.motion", "full");
		await settled();
		expect(vi.getTimerCount()).toBe(1);
		expect(lane.host.requestCount()).toBeGreaterThan(requests);
		setSetting(settings, "tui.motion", "reduced");
		await settled();
		expect(vi.getTimerCount()).toBe(0);
		// A disabled shimmer is the same switch for the lane view.
		setSetting(settings, "tui.motion", "full");
		setSetting(settings, "display.shimmer", "disabled");
		await settled();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("no timer survives dispose, a replaced host, the end of the run or a switch to the single line's still phases", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		lane.show(laneRun());
		const first = lane.component();
		first.render(120);
		expect(vi.getTimerCount()).toBe(1);
		first.dispose?.();
		expect(vi.getTimerCount()).toBe(0);
		expect(first.render(120)).toEqual([]);
		const requests = lane.host.requestCount();
		vi.advanceTimersByTime(2_000);
		expect(lane.host.requestCount()).toBe(requests);

		// The host removed the widget: the next show installs a fresh one, with one timer.
		lane.show(laneRun());
		const second = lane.component();
		expect(second).not.toBe(first);
		second.render(120);
		expect(vi.getTimerCount()).toBe(1);

		const replacement = widgetHost();
		lane.live.show(replacement.ctx, laneRun(), "working");
		expect(vi.getTimerCount()).toBe(0);
		const third = replacement.widgets.get(LIVE_WIDGET_KEY)!;
		third.render(120);
		expect(vi.getTimerCount()).toBe(1);
		const before = lane.host.requestCount() + replacement.requestCount();
		lane.live.clear();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2_000);
		expect(lane.host.requestCount() + replacement.requestCount()).toBe(before);
		expect(replacement.widgets.size).toBe(0);
	});

	test("animation time continues where it stopped when the timer restarts; it never jumps by the idle gap", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		const times: number[] = [];
		const spy = spyOn(frameModule, "laneViewFrame").mockImplementation((snapshot, cols, t, options) => {
			times.push(t);
			return realLaneViewFrame(snapshot, cols, t, options);
		});
		try {
			lane.show(laneRun());
			const component = lane.component();
			component.render(120);
			for (const step of [85, 85, 85]) {
				lane.clock.now += step;
				vi.advanceTimersByTime(step);
				component.render(120);
			}
			const reached = times.at(-1)!;
			expect(times[0]).toBe(0);
			expect(reached).toBe(255);

			// Everything settles: a still picture, no timer, the clock runs on for ten minutes.
			lane.show(settledRun(), "between-rounds");
			lane.clock.now += SETTLE_MS;
			component.render(120);
			expect(vi.getTimerCount()).toBe(0);
			expect(times.at(-1)).toBe(reached);
			lane.clock.now += 600_000;
			component.render(120);
			lane.show(laneRun({}, lane.clock.now), "working");
			expect(vi.getTimerCount()).toBe(1);
			times.length = 0;
			component.render(120);
			expect(times.at(-1)).toBe(reached);
			lane.clock.now += 85;
			vi.advanceTimersByTime(85);
			component.render(120);
			expect(times.at(-1)).toBe(reached + 85);
		} finally {
			spy.mockRestore();
		}
	});

	test("a stalled event loop moves the animation by a bounded step, not by the whole stall", () => {
		vi.useFakeTimers();
		const lane = laneSetup();
		const times: number[] = [];
		const spy = spyOn(frameModule, "laneViewFrame").mockImplementation((snapshot, cols, t, options) => {
			times.push(t);
			return realLaneViewFrame(snapshot, cols, t, options);
		});
		try {
			lane.show(laneRun());
			lane.component().render(120);
			lane.clock.now += 30_000;
			lane.component().render(120);
			expect(times.at(-1)!).toBeLessThanOrEqual(1_000);
		} finally {
			spy.mockRestore();
		}
	});

	test("the switch changes the drawing at once, in both directions, and repaints", () => {
		vi.useFakeTimers();
		let on = true;
		const lane = laneSetup({ switch: () => on });
		lane.show(laneRun());
		expect(plain(lane.component().render(120))[0]).not.toMatch(RADAR_ROW);
		const requests = lane.host.requestCount();

		on = false;
		lane.show(laneRun());
		expect(lane.host.requestCount()).toBeGreaterThan(requests);
		const line = lane.component().render(120);
		expect(plain(line)[0]).toStartWith(liveHeader("working"));
		expect(plain(line)[0]).toMatch(RADAR_ROW);
		expect(line).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(1);

		on = true;
		lane.show(laneRun());
		const again = lane.component().render(120);
		expect(plain(again)[0]).not.toMatch(RADAR_ROW);
		expect(plain(again)[1]!.trim()).not.toBe("");
		expect(vi.getTimerCount()).toBe(1);
	});

	test("turning the view on mid-run draws the lanes from what the timeline recorded, as if it had been on all along", () => {
		const settings = Settings.isolated({ "tui.motion": "none" });
		/** The record at a moment: both workers run, then `Api` settles and `Ui` keeps going. */
		const recordAt = (moment: number): RunRecord => {
			const run = laneRun({}, moment);
			if (moment === NOW) return run;
			return { ...run, agents: (run.agents ?? []).map(agent => (agent.id === "Api" ? { ...agent, state: "idle" } : agent)) };
		};
		const play = (on: () => boolean, turnOn: () => void): readonly string[] => {
			const lane = laneSetup({ switch: on, settings });
			lane.show(recordAt(NOW));
			lane.component().render(120);
			lane.clock.now = NOW + 40_000;
			lane.show(recordAt(lane.clock.now));
			lane.clock.now = NOW + 80_000;
			turnOn();
			lane.show(recordAt(lane.clock.now));
			return lane.component().render(120);
		};
		let late = false;
		const mid = play(() => late, () => {
			late = true;
		});
		const always = play(() => true, () => undefined);
		expect(mid).toHaveLength(LANE_RUN_ROWS);
		expect(plain(mid).join("\n")).toContain("Api");
		expect(mid).toEqual(always);
	});

	test("a new run gets a new timeline: nothing of the earlier run's history reaches its picture", () => {
		const settings = Settings.isolated({ "tui.motion": "none" });
		const second = (): RunRecord =>
			laneRun({
				runId: "run-second",
				startedAt: iso(NOW - 10_000),
				plan: { submittedAt: iso(NOW - 9_000), workers: { implementer: 1 }, lanes: [{ name: "Zed", kind: "code", role: "implementer" }] },
				agents: [agentEntry({ id: "Zed", state: "running", startedAt: NOW - 5_000, lastActivityAt: NOW - 500 })],
				spawns: [spawnRecord({ spawnKey: "Zed", lane: "Zed" })],
			});
		const reused = laneSetup({ settings });
		reused.show(laneRun());
		reused.component().render(120);
		reused.clock.now += 20_000;
		reused.show(second());
		const fresh = laneSetup({ settings });
		fresh.clock.now = reused.clock.now;
		fresh.show(second());
		const rows = reused.component().render(120);
		expect(plain(rows).join("\n")).toContain("Zed");
		expect(plain(rows).join("\n")).not.toContain("Api");
		expect(rows).toEqual(fresh.component().render(120));
	});
});

// ---- Mounted in the real test terminal --------------------------------------------------------------------------

describe("the live run widget mounted in the host's terminal", () => {
	/** A context whose widget slot mounts the factory on pi-tui's test terminal, as the dock does. */
	function mounted(options: { rows?: number; columns?: number; native?: boolean } = {}) {
		const views: Array<ReturnType<typeof mountWidget>> = [];
		const ui = {
			setStatus: () => undefined,
			setWidget(_key: string, content: unknown) {
				if (content === undefined) return void views.splice(0).forEach(view => view.dispose());
				views.push(mountWidget(content as ExtensionUiFactory, { columns: 100, rows: 40, ...options }));
			},
		};
		const ctx = { mode: "tui", hasUI: true, agent: { kind: "main", id: "main", name: "main" }, ui } as unknown as ExtensionContext;
		return { ctx, view: () => views.at(-1)! };
	}

	test("the lane view paints at the host's size and a requested render repaints it with the new record", () => {
		vi.useFakeTimers();
		const host = mounted({ rows: 40, columns: 100 });
		const live = liveForTest();
		const lane = new LiveStatus({ now: () => NOW });
		activeWidgets.push(lane);
		lane.show(host.ctx, laneRun());
		const screen = host.view().screen();
		expect(screen[0]).toStartWith(STORM_MARK);
		expect(screen.filter(row => row.trim() !== "").length).toBeGreaterThan(2);
		expect(screen.some(row => row.includes("Api"))).toBe(true);
		expect(host.view().renderRequests()).toBe(0);

		// The picture asks for its own repaints while it moves; nothing but the widget's timer drives it.
		vi.advanceTimersByTime(300);
		expect(host.view().renderRequests()).toBeGreaterThan(0);
		lane.show(host.ctx, laneRun({ turns: 2 }));
		host.view().tick(0);
		expect(host.view().text()).toContain("3/4");
		live.clear();
		lane.clear();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("the single line paints at the host's width, under the 60 columns and 18 rows of the lane view", () => {
		vi.useFakeTimers();
		for (const [rows, columns] of [[40, 50], [16, 120]] as const) {
			const host = mounted({ rows, columns });
			const live = new LiveStatus({ now: () => NOW });
			activeWidgets.push(live);
			live.show(host.ctx, RUN);
			const screen = host.view().screen();
			expect(screen[0]).toStartWith(STORM_MARK);
			expect(screen.length).toBeLessThanOrEqual(2);
			live.clear();
		}
	});

	test("a window resize under the mounted widget changes the drawing without a request from Storm", () => {
		vi.useFakeTimers();
		const host = mounted({ rows: 40, columns: 100 });
		const live = new LiveStatus({ now: () => NOW });
		activeWidgets.push(live);
		live.show(host.ctx, laneRun());
		const tall = host.view().screen();
		expect(tall.filter(row => row.trim() !== "").length).toBeGreaterThan(2);
		host.view().resize(100, 12);
		// Too short for the lane view now: the single line alone, nothing blank under it.
		const short = host.view().screen();
		expect(short[0]).toMatch(RADAR_ROW);
		expect(short.length).toBeLessThanOrEqual(2);
		expect(short.every(row => row.trim() !== "")).toBe(true);
		host.view().resize(100, 40);
		expect(host.view().screen()[0]).not.toMatch(RADAR_ROW);
	});

	test("a theme switch repaints the mounted widget by itself, and the mark follows the symbol preset", () => {
		vi.useFakeTimers();
		const host = mounted({ rows: 40, columns: 100 });
		const live = new LiveStatus({ now: () => NOW, laneView: () => false });
		activeWidgets.push(live);
		live.show(host.ctx, RUN);
		expect(host.view().screen()[0]).toStartWith(STORM_MARK);
		useAscii();
		host.view().tick(0);
		expect(host.view().screen()[0]).toStartWith(ASCII_MARK);
		useDefaultTheme();
		host.view().tick(0);
		expect(host.view().screen()[0]).toStartWith(STORM_MARK);
	});

	test("a native host draws the line from nodes: the header, the shimmer track and the chips", () => {
		const host = mounted({ rows: 40, columns: 100, native: true });
		setNativeRenderingForTest(true);
		const live = new LiveStatus({ now: () => NOW });
		activeWidgets.push(live);
		live.show(host.ctx, RUN);
		const text = host.view().text();
		expect(text).toContain(STORM_MARK);
		expect(text).toContain("1/4");
		live.show(host.ctx, { ...RUN, turns: 2 });
		host.view().tick(0);
		expect(host.view().text()).toContain("3/4");
	});
});
